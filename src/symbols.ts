// Semantic symbols and types: registers classes/functions, maps AS3 source
// types to C types, flattens inheritance, and answers visibility queries.

import type { Program, ASType, Param, Expr, Visibility, Metadata } from './ast.ts';

// Semantic type representation used during code generation.
export type CType =
  | { kind: 'int' }
  | { kind: 'uint' }
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'null' }
  | { kind: 'object'; className: string }
  | { kind: 'interface'; name: string }
  | { kind: 'array' }
  | { kind: 'vector'; elem: CType }
  | { kind: 'record' }
  | { kind: 'any' }
  | { kind: 'function' }
  | { kind: 'class' }
  | { kind: 'dict' }
  | { kind: 'regexp' }
  | { kind: 'void' };

export interface FieldInfo { type: CType; init: Expr | null; visibility: Visibility; owner: string; isStatic: boolean; isConst: boolean; }
export interface MethodInfo { returnType: CType; params: Param[]; owner: string; visibility: Visibility; isStatic: boolean; isFinal: boolean; isGetter: boolean; isSetter: boolean; metadata?: Metadata[]; }
export interface FuncInfo { returnType: CType; params: Param[]; metadata?: Metadata[]; }

// A function/method marked [WasmExport] that must be exposed in the .wasm export
// table. `symbol` is the generated C symbol name; `alias` is the optional
// [WasmExport("alias")] override for the JS-facing export name (a C wrapper with
// that name is emitted and exported). `returnType`/`params` carry the resolved C
// signature so the emitter can generate the alias wrapper and index.ts can write
// the export manifest.
export interface ExportedSymbol {
  symbol: string;
  alias: string | null;
  returnType: CType;
  params: { name: string; type: CType }[];
}
export interface ConstructorInfo { params: Param[]; }
export interface InterfaceInfo { methods: Map<string, MethodInfo>; }
export interface ClassInfo {
  fields: Map<string, FieldInfo>;
  methods: Map<string, MethodInfo>;
  staticFields: Map<string, FieldInfo>;
  staticMethods: Map<string, MethodInfo>;
  getters: Map<string, MethodInfo>;
  setters: Map<string, MethodInfo>;
  constructor: ConstructorInfo;
  superClass: string | null;
  isFinal: boolean;
  implements: string[];
  packageName: string | null;
}

export class CodegenError extends Error {}

// AS3 source type -> C semantic type. `null` (untyped) defaults to `int`.
// Interface names resolve to `interface` (a reference = object pointer + vt).
// Namespaced types carry a package prefix: `foo.bar.Baz` -> C identifier `foo_bar_Baz`.
const interfaceNames = new Set<string>();
// short class/interface name -> sanitized fully-qualified name (C identifier).
const typeAlias = new Map<string, string>();

export function sanitizePkg(pkg: string): string {
  return pkg.replace(/\./g, '_');
}

// Fully-qualified C identifier for a namespaced type: `foo.bar.Baz` -> `foo_bar_Baz`.
export function qualifiedName(name: string, pkg: string | null): string {
  return pkg ? `${sanitizePkg(pkg)}_${name}` : name;
}

// Human-readable name for a resolved C type, used in the export manifest so the
// JS-facing contract of an exported function is documented (AS3-flavoured names
// where a direct analogue exists; C struct identifiers otherwise).
export function ctypeToString(t: CType): string {
  switch (t.kind) {
    case 'int': return 'int';
    case 'uint': return 'uint';
    case 'number': return 'Number';
    case 'bool': return 'Boolean';
    case 'string': return 'String';
    case 'null': return 'void*';
    case 'object': return t.className;
    case 'interface': return t.name;
    case 'array': return 'Array';
    case 'vector': return `Vector.<${ctypeToString(t.elem)}>`;
    case 'record': return 'Object';
    case 'any': return '*';
    case 'function': return 'Function';
    case 'class': return 'Class';
    case 'dict': return 'Dictionary';
    case 'regexp': return 'RegExp';
    case 'void': return 'void';
  }
}

export function resolveType(t: ASType | null): CType {
  if (t === null) return { kind: 'int' };
  // Vector.<T> — type-safe generic array (encoded as the string "Vector.<T>").
  if (t.startsWith('Vector.<')) {
    const inner = t.slice('Vector.<'.length, -1);
    return { kind: 'vector', elem: resolveType(inner as ASType) };
  }
  switch (t) {
    case 'int': return { kind: 'int' };
    case 'uint': return { kind: 'uint' };
    case 'Number': return { kind: 'number' };
    case 'Boolean': return { kind: 'bool' };
    case 'String': return { kind: 'string' };
    case 'void': return { kind: 'void' };
    case 'Array': return { kind: 'array' };
    case 'Function': return { kind: 'function' };
    case 'Class': return { kind: 'class' };
    case 'Dictionary': return { kind: 'dict' };
    case 'any': return { kind: 'any' };
    default: {
      const fqn = typeAlias.get(t) ?? t;
      if (interfaceNames.has(fqn)) return { kind: 'interface', name: fqn };
      return { kind: 'object', className: fqn };
    }
  }
}

// Pass 1 of the generator: collect all class/function symbols so forward
// references resolve, then flatten inheritance for layout-compatible structs.
export class SymbolTable {
  private classMap = new Map<string, ClassInfo>();
  private funcMap = new Map<string, FuncInfo>();
  private interfaceMap = new Map<string, InterfaceInfo>();
  private exportList: ExportedSymbol[] = [];

  get classes(): ReadonlyMap<string, ClassInfo> { return this.classMap; }
  get funcs(): ReadonlyMap<string, FuncInfo> { return this.funcMap; }
  get interfaces(): ReadonlyMap<string, InterfaceInfo> { return this.interfaceMap; }
  get exports(): ReadonlyArray<ExportedSymbol> { return this.exportList; }

  collect(program: Program): void {
    // pass -1: build the short-name -> FQN alias table so type references can
    // resolve across namespaces, and reset module-level resolution state.
    const fqn = (name: string, pkg: string | null) => qualifiedName(name, pkg);
    interfaceNames.clear();
    typeAlias.clear();
    for (const stmt of program.body) {
      if (stmt.kind === 'InterfaceDecl' || stmt.kind === 'ClassDecl') {
        typeAlias.set(stmt.name, fqn(stmt.name, stmt.packageName));
      }
    }
    // pass 0: register interfaces.
    for (const stmt of program.body) {
      if (stmt.kind === 'InterfaceDecl') {
        const iname = fqn(stmt.name, stmt.packageName);
        interfaceNames.add(iname);
        const methods = new Map<string, MethodInfo>();
        for (const m of stmt.methods) {
          methods.set(m.name, { returnType: resolveType(m.returnType), params: m.params, owner: iname, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
        }
        this.interfaceMap.set(iname, { methods });
      }
    }
    // pass 0.5: inject the built-in Object root class (every class's implicit base).
    this.classMap.set('Object', {
      fields: new Map(),
      methods: new Map([['toString', { returnType: { kind: 'string' }, params: [], owner: 'Object', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }]]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: null,
      isFinal: false,
      implements: [],
    });
    // inject the built-in Error class (used by throw/catch).
    this.classMap.set('Error', {
      fields: new Map([['message', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Error', isStatic: false, isConst: false }]]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [{ name: 'message', type: 'String', defaultValue: { kind: 'Str', value: 'Error' }, isRest: false }] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in Error subclasses: share Error's { vtable; message } layout, but
    // each has its own vtable so `catch (e:TypeError)` can match precisely.
    for (const sub of ['TypeError', 'RangeError', 'ArgumentError', 'SyntaxError']) {
      this.classMap.set(sub, {
        fields: new Map(),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [{ name: 'message', type: 'String', defaultValue: { kind: 'Str', value: sub }, isRest: false }] },
        superClass: 'Error',
        isFinal: false,
        implements: [],
      });
    }
    // built-in Date class: wraps a millisecond timestamp and exposes calendar accessors.
    const dm = (ret: CType): MethodInfo => ({
      returnType: ret, params: [], owner: 'Date', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false,
    });
    this.classMap.set('Date', {
      fields: new Map([['time', { type: { kind: 'number' }, init: null, visibility: 'public', owner: 'Date', isStatic: false, isConst: false }]]),
      methods: new Map([
        ['getTime', dm({ kind: 'number' })],
        ['getFullYear', dm({ kind: 'int' })],
        ['getMonth', dm({ kind: 'int' })],
        ['getDate', dm({ kind: 'int' })],
        ['getDay', dm({ kind: 'int' })],
        ['getHours', dm({ kind: 'int' })],
        ['getMinutes', dm({ kind: 'int' })],
        ['getSeconds', dm({ kind: 'int' })],
        ['toDateString', dm({ kind: 'string' })],
        ['toUTCString', dm({ kind: 'string' })],
      ]),
      staticFields: new Map(),
      staticMethods: new Map([
        ['parse', { returnType: { kind: 'number' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'Date', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in RegExp class: wraps a compiled regex program plus source/flags
    // metadata. `exec` returns an Array (or null) and `test` a Boolean; both take
    // the subject string. `lastIndex` is writable and drives `g` matching.
    const rf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'RegExp', isStatic: false, isConst: false });
    this.classMap.set('RegExp', {
      fields: new Map([
        ['compiled', rf({ kind: 'regexp' })],
        ['source', rf({ kind: 'string' })],
        ['flags', rf({ kind: 'string' })],
        ['lastIndex', rf({ kind: 'int' })],
        ['global', rf({ kind: 'bool' })],
        ['ignoreCase', rf({ kind: 'bool' })],
        ['multiline', rf({ kind: 'bool' })],
        ['dotall', rf({ kind: 'bool' })],
        ['extended', rf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['exec', { returnType: { kind: 'array' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'RegExp', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['test', { returnType: { kind: 'bool' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'RegExp', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'pattern', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
        { name: 'flags', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in Event class (flash.events.Event): the base event object. The AS3
    // read-only properties (type/bubbles/cancelable/target/currentTarget/eventPhase)
    // are modeled as fields; three extra internal flags (cancelled/propStopped/
    // immStopped) drive preventDefault/stopPropagation/stopImmediatePropagation.
    // target/currentTarget are Object* (any dispatcher or display object).
    const evf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Event', isStatic: false, isConst: false });
    const evm = (ret: CType, params: Param[] = []): MethodInfo => ({ returnType: ret, params, owner: 'Event', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const evc = (value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner: 'Event', isStatic: true, isConst: true });
    this.classMap.set('Event', {
      fields: new Map([
        ['type', evf({ kind: 'string' })],
        ['bubbles', evf({ kind: 'bool' })],
        ['cancelable', evf({ kind: 'bool' })],
        ['target', evf({ kind: 'object', className: 'Object' })],
        ['currentTarget', evf({ kind: 'object', className: 'Object' })],
        ['eventPhase', evf({ kind: 'int' })],
        ['cancelled', evf({ kind: 'bool' })],
        ['propStopped', evf({ kind: 'bool' })],
        ['immStopped', evf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['toString', evm({ kind: 'string' })],
        ['clone', evm({ kind: 'object', className: 'Event' })],
        ['preventDefault', evm({ kind: 'void' })],
        ['stopPropagation', evm({ kind: 'void' })],
        ['stopImmediatePropagation', evm({ kind: 'void' })],
      ]),
      staticFields: new Map([
        ['ACTIVATE', evc('activate')],
        ['ADDED', evc('added')],
        ['ADDED_TO_STAGE', evc('addedToStage')],
        ['REMOVED', evc('removed')],
        ['REMOVED_FROM_STAGE', evc('removedFromStage')],
        ['ENTER_FRAME', evc('enterFrame')],
        ['EXIT_FRAME', evc('exitFrame')],
        ['COMPLETE', evc('complete')],
        ['CHANGE', evc('change')],
        ['RESIZE', evc('resize')],
        ['CANCEL', evc('cancel')],
        ['CLEAR', evc('clear')],
        ['CLOSE', evc('close')],
        ['CONNECT', evc('connect')],
        ['COPY', evc('copy')],
        ['CUT', evc('cut')],
        ['DEACTIVATE', evc('deactivate')],
        ['FRAME_CONSTRUCTED', evc('frameConstructed')],
        ['FULLSCREEN', evc('fullScreen')],
        ['ID3', evc('id3')],
        ['INIT', evc('init')],
        ['MOUSE_LEAVE', evc('mouseLeave')],
        ['OPEN', evc('open')],
        ['PASTE', evc('paste')],
        ['RENDER', evc('render')],
        ['SCROLL', evc('scroll')],
        ['SELECT', evc('select')],
        ['SOUND_COMPLETE', evc('soundComplete')],
        ['TAB_CHILDREN_CHANGE', evc('tabChildrenChange')],
        ['TAB_ENABLED_CHANGE', evc('tabEnabledChange')],
        ['TAB_INDEX_CHANGE', evc('tabIndexChange')],
        ['UNLOAD', evc('unload')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        { name: 'bubbles', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'cancelable', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in EventDispatcher (flash.events.EventDispatcher): holds a listener
    // table (as_object: "type#cap"/"type#bub" -> as_array of as_fn) plus a parent
    // pointer (used by the display list in later stages to walk the ancestor chain).
    const dpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'EventDispatcher', isStatic: false, isConst: false });
    const dpm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'EventDispatcher', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('EventDispatcher', {
      fields: new Map([
        ['listeners', dpf({ kind: 'record' })],
        ['parent', dpf({ kind: 'object', className: 'Object' })],
      ]),
      methods: new Map([
        ['addEventListener', dpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
          { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'priority', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'useWeakReference', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['removeEventListener', dpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
          { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['hasEventListener', dpm({ kind: 'bool' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['willTrigger', dpm({ kind: 'bool' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['dispatchEvent', dpm({ kind: 'bool' }, [
          { name: 'event', type: 'Event', defaultValue: null, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in display list (flash.display). DisplayObject extends EventDispatcher,
    // so the parent link and listener table are inherited; it adds the transform
    // properties (name/x/y/width/height/visible/alpha/rotation/scaleX/scaleY).
    const dof = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'DisplayObject', isStatic: false, isConst: false });
    const dog = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'DisplayObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const dos = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'DisplayObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('DisplayObject', {
      fields: new Map([
        ['name', dof({ kind: 'string' })],
        ['x', dof({ kind: 'number' })],
        ['y', dof({ kind: 'number' })],
        ['width', dof({ kind: 'number' })],
        ['height', dof({ kind: 'number' })],
        ['visible', dof({ kind: 'bool' })],
        ['alpha', dof({ kind: 'number' })],
        ['rotation', dof({ kind: 'number' })],
        ['scaleX', dof({ kind: 'number' })],
        ['scaleY', dof({ kind: 'number' })],
        ['filters', dof({ kind: 'array' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['root', dog({ kind: 'object', className: 'DisplayObject' })],
        ['stage', dog({ kind: 'object', className: 'Stage' })],
        ['filters', dog({ kind: 'array' })],
      ]),
      setters: new Map([
        ['filters', dos('Array')],
      ]),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // InteractiveObject adds mouse/focus interaction flags (mouseEnabled/mouseChildren
    // drive the hit-test three-state machine, mouseChildren=false makes a parent
    // absorb its children's clicks).
    const iof = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'InteractiveObject', isStatic: false, isConst: false });
    this.classMap.set('InteractiveObject', {
      fields: new Map([
        ['mouseEnabled', iof({ kind: 'bool' })],
        ['mouseChildren', iof({ kind: 'bool' })],
        ['doubleClickEnabled', iof({ kind: 'bool' })],
        ['tabEnabled', iof({ kind: 'bool' })],
        ['tabIndex', iof({ kind: 'int' })],
        ['focusRect', iof({ kind: 'bool' })],
        ['hasFocus', iof({ kind: 'bool' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    // DisplayObjectContainer holds the child list (render order = depth order).
    const dcf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'DisplayObjectContainer', isStatic: false, isConst: false });
    const dcm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'DisplayObjectContainer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const dcChild = (name: string): Param => ({ name, type: 'DisplayObject', defaultValue: null, isRest: false });
    this.classMap.set('DisplayObjectContainer', {
      fields: new Map([
        ['children', dcf({ kind: 'array' })],
      ]),
      methods: new Map([
        ['addChild', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child')])],
        ['addChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child'), { name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['removeChild', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child')])],
        ['removeChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['getChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['getChildByName', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'name', type: 'String', defaultValue: null, isRest: false }])],
        ['contains', dcm({ kind: 'bool' }, [dcChild('child')])],
        ['setChildIndex', dcm({ kind: 'void' }, [dcChild('child'), { name: 'index', type: 'int', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['numChildren', { returnType: { kind: 'int' }, params: [], owner: 'DisplayObjectContainer', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // Stage is the outermost container (root of the display tree). It also
    // exposes a non-standard dispatchMouse(x, y, type) test hook that runs the
    // inside-out hit test + dispatch (no window system in this subset). Stage 41
    // adds the desktop AIR stage properties (size/fullscreen/quality/color/align/
    // scaleMode/frameRate) as plain fields with getter/setter accessors.
    const stgf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Stage', isStatic: false, isConst: false });
    const stgg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const stgs = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('Stage', {
      fields: new Map([
        ['stage_w', stgf({ kind: 'int' })],
        ['stage_h', stgf({ kind: 'int' })],
        ['stage_color', stgf({ kind: 'uint' })],
        ['quality', stgf({ kind: 'string' })],
        ['align', stgf({ kind: 'string' })],
        ['scale_mode', stgf({ kind: 'string' })],
        ['frame_rate', stgf({ kind: 'number' })],
        ['stage_scale', stgf({ kind: 'number' })],
        ['display_state', stgf({ kind: 'string' })],
        ['stage_focus_rect', stgf({ kind: 'bool' })],
        ['show_default_context_menu', stgf({ kind: 'bool' })],
        ['tab_children', stgf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['dispatchMouse', { returnType: { kind: 'void' }, params: [
          { name: 'x', type: 'Number', defaultValue: null, isRest: false },
          { name: 'y', type: 'Number', defaultValue: null, isRest: false },
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: feeds a wheel notch into the TextField under (x,y)
        // and dispatches a bubbling MouseEvent.MOUSE_WHEEL. Not part of AIR's Stage
        // API (there the player does this internally); exposed so tests and the SDL2
        // event loop can drive scrolling the same way dispatchMouse drives clicks.
        ['dispatchWheel', { returnType: { kind: 'void' }, params: [
          { name: 'x', type: 'Number', defaultValue: null, isRest: false },
          { name: 'y', type: 'Number', defaultValue: null, isRest: false },
          { name: 'delta', type: 'Number', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: broadcasts the ENTER_FRAME event to every display
        // object once per rendered frame. Not part of AIR's Stage API (there the
        // player drives the frame loop internally); exposed so the SDL2 event loop
        // can advance the frame clock the same way dispatchMouse drives clicks.
        ['dispatchFrame', { returnType: { kind: 'void' }, params: [
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['render', { returnType: { kind: 'void' }, params: [
          { name: 'width', type: 'Number', defaultValue: null, isRest: false },
          { name: 'height', type: 'Number', defaultValue: null, isRest: false },
          { name: 'path', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['showWindow', { returnType: { kind: 'void' }, params: [
          { name: 'width', type: 'Number', defaultValue: null, isRest: false },
          { name: 'height', type: 'Number', defaultValue: null, isRest: false },
          { name: 'title', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['stageWidth', stgg({ kind: 'int' })],
        ['stageHeight', stgg({ kind: 'int' })],
        ['fullScreenWidth', stgg({ kind: 'uint' })],
        ['fullScreenHeight', stgg({ kind: 'uint' })],
        ['displayState', stgg({ kind: 'string' })],
        ['quality', stgg({ kind: 'string' })],
        ['color', stgg({ kind: 'uint' })],
        ['align', stgg({ kind: 'string' })],
        ['scaleMode', stgg({ kind: 'string' })],
        ['frameRate', stgg({ kind: 'number' })],
        ['stageFocusRect', stgg({ kind: 'bool' })],
        ['showDefaultContextMenu', stgg({ kind: 'bool' })],
        ['tabChildren', stgg({ kind: 'bool' })],
        ['allowsFullScreen', stgg({ kind: 'bool' })],
        ['allowsFullScreenInteractive', stgg({ kind: 'bool' })],
        ['contentsScaleFactor', stgg({ kind: 'number' })],
      ]),
      setters: new Map([
        ['stageWidth', stgs('int')],
        ['stageHeight', stgs('int')],
        ['displayState', stgs('String')],
        ['quality', stgs('String')],
        ['color', stgs('uint')],
        ['align', stgs('String')],
        ['scaleMode', stgs('String')],
        ['frameRate', stgs('Number')],
        ['stageFocusRect', stgs('Boolean')],
        ['showDefaultContextMenu', stgs('Boolean')],
        ['tabChildren', stgs('Boolean')],
      ]),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // Sprite is a drawable container (Graphics lands in stage 37; for now it is
    // an empty DisplayObjectContainer subclass so hit-testing has a target type).
    this.classMap.set('Sprite', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // flash.display additions (stage 62): MovieClip / SimpleButton / Loader / LoaderInfo.
    //
    // MovieClip: a frame timeline. currentFrame/totalFrames are the timeline
    // position/length; play/stop/gotoAndPlay/gotoAndStop drive an internal
    // `playing` flag. Playing clips are advanced one frame per frame tick by the
    // runtime's as_mc_* pool (see runtime.ts), wrapping currentFrame back to 1
    // when it passes totalFrames. There is no symbol-timeline system in this
    // subset, so `totalFrames` is writable (default 1) to let examples model a
    // multi-frame clip — a documented deviation from AIR's read-only totalFrames.
    const mcf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'MovieClip', isStatic: false, isConst: false });
    const mcm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const mcg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const mcs = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('MovieClip', {
      fields: new Map([
        ['currentFrame', mcf({ kind: 'int' })],
        ['totalFrames', mcf({ kind: 'int' })],
        ['playing', mcf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['play', mcm({ kind: 'void' }, [])],
        ['stop', mcm({ kind: 'void' }, [])],
        ['gotoAndPlay', mcm({ kind: 'void' }, [{ name: 'frame', type: 'int', defaultValue: null, isRest: false }])],
        ['gotoAndStop', mcm({ kind: 'void' }, [{ name: 'frame', type: 'int', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['currentFrame', mcg({ kind: 'int' })],
        ['totalFrames', mcg({ kind: 'int' })],
      ]),
      setters: new Map([
        ['totalFrames', mcs('int')],
      ]),
      constructor: { params: [] },
      superClass: 'Sprite',
      isFinal: false,
      implements: [],
    });
    // SimpleButton: an InteractiveObject whose visual is four DisplayObject state
    // references (upState/overState/downState/hitTestState). Visual state switching
    // on mouse events is deferred; the class models the state bundle and is
    // hit-tested via its own bounds (as_pick_hit treats non-containers as leaves).
    const sbf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'SimpleButton', isStatic: false, isConst: false });
    this.classMap.set('SimpleButton', {
      fields: new Map([
        ['upState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['overState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['downState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['hitTestState', sbf({ kind: 'object', className: 'DisplayObject' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'upState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'overState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'downState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'hitTestState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // LoaderInfo: load metadata + event constants. bytesLoaded/bytesTotal/url are
    // plain fields; COMPLETE/INIT/OPEN/UNLOAD mirror Event, PROGRESS/IO_ERROR mirror
    // ProgressEvent/IOErrorEvent (same string values).
    const lif = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'LoaderInfo', isStatic: false, isConst: false });
    const lic = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    this.classMap.set('LoaderInfo', {
      fields: new Map([
        ['bytesLoaded', lif({ kind: 'uint' })],
        ['bytesTotal', lif({ kind: 'uint' })],
        ['url', lif({ kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['COMPLETE', lic('LoaderInfo', 'complete')],
        ['INIT', lic('LoaderInfo', 'init')],
        ['OPEN', lic('LoaderInfo', 'open')],
        ['UNLOAD', lic('LoaderInfo', 'unload')],
        ['PROGRESS', lic('LoaderInfo', 'progress')],
        ['IO_ERROR', lic('LoaderInfo', 'ioError')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // Loader: a DisplayObjectContainer that holds loaded content. load(url) is a
    // synchronous simulation: it builds a LoaderInfo, records the URL, and dispatches
    // INIT then COMPLETE. Real asynchronous loading (URLRequest/URLLoader) is stage 63.
    const ldf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Loader', isStatic: false, isConst: false });
    const ldg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    this.classMap.set('Loader', {
      fields: new Map([
        ['content', ldf({ kind: 'object', className: 'DisplayObject' })],
        ['contentLoaderInfo', ldf({ kind: 'object', className: 'LoaderInfo' })],
      ]),
      methods: new Map([
        ['load', { returnType: { kind: 'void' }, params: [{ name: 'url', type: 'String', defaultValue: null, isRest: false }], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['content', ldg({ kind: 'object', className: 'DisplayObject' })],
        ['contentLoaderInfo', ldg({ kind: 'object', className: 'LoaderInfo' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // flash.net / flash.ui (stage 63): URLRequest / URLLoader / Keyboard / Mouse.
    // Socket / Sound / SoundChannel / Video / ContextMenu / URLVariables are
    // deferred — they need network/audio/video backends or dynamic property
    // modeling outside this subset (documented in README/todo).
    //
    // URLRequest: a load-request value bundle. method defaults to "GET"; data/
    // contentType default to null (data is `any`, boxed as as_value).
    const rqf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLRequest', isStatic: false, isConst: false });
    this.classMap.set('URLRequest', {
      fields: new Map([
        ['url', rqf({ kind: 'string' })],
        ['method', rqf({ kind: 'string' })],
        ['data', rqf({ kind: 'any' })],
        ['contentType', rqf({ kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'url', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // URLLoader: an EventDispatcher that synchronously reads a local file (the URL
    // treated as a filesystem path) and dispatches COMPLETE (or IO_ERROR on
    // failure). data is the file text; dataFormat defaults to "text". Real async
    // HTTP/Socket loading is deferred.
    const ulf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLLoader', isStatic: false, isConst: false });
    const ulm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'URLLoader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('URLLoader', {
      fields: new Map([
        ['data', ulf({ kind: 'string' })],
        ['dataFormat', ulf({ kind: 'string' })],
      ]),
      methods: new Map([
        ['load', ulm({ kind: 'void' }, [{ name: 'request', type: 'URLRequest', defaultValue: null, isRest: false }])],
        ['close', ulm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // Keyboard: a class of static key-code constants (uint, matching AIR's Keyboard
    // constants) plus a read-only isAccessible flag. Only a representative subset of
    // the full AIR key-code table is mapped.
    const kbd = (owner: string, value: number): FieldInfo => ({ type: { kind: 'uint' }, init: { kind: 'Num', value, isInt: true }, visibility: 'public', owner, isStatic: true, isConst: true });
    const kbdStatic: [string, number][] = [
      ['A', 65], ['B', 66], ['C', 67], ['D', 68], ['E', 69], ['F', 70], ['G', 71], ['H', 72],
      ['I', 73], ['J', 74], ['K', 75], ['L', 76], ['M', 77], ['N', 78], ['O', 79], ['P', 80],
      ['Q', 81], ['R', 82], ['S', 83], ['T', 84], ['U', 85], ['V', 86], ['W', 87], ['X', 88],
      ['Y', 89], ['Z', 90],
      ['NUMBER_0', 48], ['NUMBER_1', 49], ['NUMBER_2', 50], ['NUMBER_3', 51], ['NUMBER_4', 52],
      ['NUMBER_5', 53], ['NUMBER_6', 54], ['NUMBER_7', 55], ['NUMBER_8', 56], ['NUMBER_9', 57],
      ['SPACE', 32], ['ENTER', 13], ['TAB', 9], ['ESCAPE', 27], ['BACKSPACE', 8], ['DELETE', 46],
      ['SHIFT', 16], ['CONTROL', 17], ['LEFT', 37], ['RIGHT', 39], ['UP', 38], ['DOWN', 40],
    ];
    const kbdFields = new Map<string, FieldInfo>();
    kbdFields.set('isAccessible', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Keyboard', isStatic: true, isConst: true });
    for (const [k, v] of kbdStatic) kbdFields.set(k, kbd('Keyboard', v));
    this.classMap.set('Keyboard', {
      fields: new Map(),
      methods: new Map(),
      staticFields: kbdFields,
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Mouse: static hide()/show() toggle a runtime visibility flag; cursor is a
    // read-only string ("auto" — the real AIR default) in this subset (SDL cursor API
    // is not wired).
    this.classMap.set('Mouse', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['cursor', { type: { kind: 'string' }, init: { kind: 'Str', value: 'auto' }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: true }],
        ['supportsCursor', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: true }],
        ['supportsNativeCursor', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map([
        ['hide', { returnType: { kind: 'void' }, params: [], owner: 'Mouse', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ['show', { returnType: { kind: 'void' }, params: [], owner: 'Mouse', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.filesystem (stage 64): File / FileStream / FileMode. NativeWindow and
    // SQLConnection/SQLStatement are deferred (native multi-window management and
    // SQLite linking, respectively).
    //
    // File: a filesystem path object. nativePath holds the raw path; url is the
    // "file://" form. exists/isDirectory are read-only *properties* (real AIR:
    // getter access f.exists, not f.exists()) probing via stat(); createDirectory
    // runs mkdir; deleteFile/deleteDirectory run remove(); resolvePath joins a
    // child. applicationStorageDirectory is a static read-only File for the
    // writable app-storage location (mapped to the CWD in this subset).
    const filefld = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'File', isStatic: false, isConst: false });
    const filegetr = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'File', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const filemeth = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'File', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('File', {
      fields: new Map([
        ['nativePath', filefld({ kind: 'string' })],
      ]),
      methods: new Map([
        ['resolvePath', filemeth({ kind: 'object', className: 'File' }, [{ name: 'path', type: 'String', defaultValue: null, isRest: false }])],
        ['createDirectory', filemeth({ kind: 'void' }, [])],
        ['deleteFile', filemeth({ kind: 'void' }, [])],
        ['deleteDirectory', filemeth({ kind: 'void' }, [])],
      ]),
      staticFields: new Map([
        ['applicationStorageDirectory', { type: { kind: 'object', className: 'File' }, init: { kind: 'New', className: 'File', args: [{ kind: 'Str', value: '.' }] }, visibility: 'public', owner: 'File', isStatic: true, isConst: false }],
      ]),
      staticMethods: new Map(),
      getters: new Map([
        ['url', filegetr({ kind: 'string' })],
        ['exists', filegetr({ kind: 'bool' })],
        ['isDirectory', filegetr({ kind: 'bool' })],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'path', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // FileStream: a POSIX FILE* wrapper. open() maps an AIR FileMode string
    // ("read"/"write"/"append"/"update") to a C fopen mode and keeps the handle
    // (opaque void*, not GC-tracked). readUTFBytes/writeUTFBytes transfer UTF-8.
    const fsfld = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'FileStream', isStatic: false, isConst: false });
    const fsgetr = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'FileStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const fsmeth = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'FileStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('FileStream', {
      fields: new Map([
        ['_handle', fsfld({ kind: 'null' })],
      ]),
      methods: new Map([
        ['open', fsmeth({ kind: 'void' }, [
          { name: 'file', type: 'File', defaultValue: null, isRest: false },
          { name: 'fileMode', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['close', fsmeth({ kind: 'void' }, [])],
        ['readUTFBytes', fsmeth({ kind: 'string' }, [{ name: 'length', type: 'uint', defaultValue: null, isRest: false }])],
        ['writeUTFBytes', fsmeth({ kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bytesAvailable', fsgetr({ kind: 'uint' })],
        ['position', fsgetr({ kind: 'uint' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // FileMode: constant strings passed to FileStream.open.
    const fmodec = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    this.classMap.set('FileMode', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['READ', fmodec('FileMode', 'read')],
        ['WRITE', fmodec('FileMode', 'write')],
        ['APPEND', fmodec('FileMode', 'append')],
        ['UPDATE', fmodec('FileMode', 'update')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Stage 41 constant classes: pure static String constants (zero runtime
    // dependency), mirroring the AIR SDK values verbatim.
    const stgc = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    const constClass = (name: string, consts: Record<string, string>): void => {
      const sf = new Map<string, FieldInfo>();
      for (const [k, v] of Object.entries(consts)) sf.set(k, stgc(name, v));
      this.classMap.set(name, {
        fields: new Map(), methods: new Map(), staticFields: sf, staticMethods: new Map(),
        getters: new Map(), setters: new Map(), constructor: { params: [] },
        superClass: 'Object', isFinal: false, implements: [],
      });
    };
    constClass('StageAlign', { TOP: 'T', BOTTOM: 'B', LEFT: 'L', RIGHT: 'R', TOP_LEFT: 'TL', TOP_RIGHT: 'TR', BOTTOM_LEFT: 'BL', BOTTOM_RIGHT: 'BR' });
    constClass('StageScaleMode', { EXACT_FIT: 'exactFit', SHOW_ALL: 'showAll', NO_BORDER: 'noBorder', NO_SCALE: 'noScale' });
    constClass('StageQuality', { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', BEST: 'best' });
    constClass('StageDisplayState', { NORMAL: 'normal', FULL_SCREEN: 'fullScreen', FULL_SCREEN_INTERACTIVE: 'fullScreenInteractive' });
    // built-in mouse/keyboard/focus event types (flash.events). Each extends Event,
    // so the base fields (type/bubbles/cancelable/target/...) are inherited.
    const mef = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const mec = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    const meBool = (name: string, def: boolean): Param => ({ name, type: 'Boolean', defaultValue: { kind: 'Bool', value: def }, isRest: false });
    this.classMap.set('MouseEvent', {
      fields: new Map([
        ['localX', mef({ kind: 'number' }, 'MouseEvent')],
        ['localY', mef({ kind: 'number' }, 'MouseEvent')],
        ['relatedObject', mef({ kind: 'object', className: 'Object' }, 'MouseEvent')],
        ['ctrlKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['altKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['shiftKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['buttonDown', mef({ kind: 'bool' }, 'MouseEvent')],
        ['delta', mef({ kind: 'number' }, 'MouseEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['MOUSE_DOWN', mec('MouseEvent', 'mouseDown')],
        ['MOUSE_UP', mec('MouseEvent', 'mouseUp')],
        ['CLICK', mec('MouseEvent', 'click')],
        ['MOUSE_MOVE', mec('MouseEvent', 'mouseMove')],
        ['MOUSE_OVER', mec('MouseEvent', 'mouseOver')],
        ['MOUSE_OUT', mec('MouseEvent', 'mouseOut')],
        ['ROLL_OVER', mec('MouseEvent', 'rollOver')],
        ['ROLL_OUT', mec('MouseEvent', 'rollOut')],
        ['DOUBLE_CLICK', mec('MouseEvent', 'doubleClick')],
        ['MOUSE_WHEEL', mec('MouseEvent', 'mouseWheel')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'localX', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
        { name: 'localY', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
        { name: 'relatedObject', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('ctrlKey', false),
        meBool('altKey', false),
        meBool('shiftKey', false),
        meBool('buttonDown', false),
        { name: 'delta', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('KeyboardEvent', {
      fields: new Map([
        ['keyCode', mef({ kind: 'int' }, 'KeyboardEvent')],
        ['charCode', mef({ kind: 'int' }, 'KeyboardEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['KEY_DOWN', mec('KeyboardEvent', 'keyDown')],
        ['KEY_UP', mec('KeyboardEvent', 'keyUp')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'charCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'keyCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('FocusEvent', {
      fields: new Map([
        ['keyCode', mef({ kind: 'int' }, 'FocusEvent')],
        ['relatedObject', mef({ kind: 'object', className: 'Object' }, 'FocusEvent')],
        ['shiftKey', mef({ kind: 'bool' }, 'FocusEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['FOCUS_IN', mec('FocusEvent', 'focusIn')],
        ['FOCUS_OUT', mec('FocusEvent', 'focusOut')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'relatedObject', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('shiftKey', false),
        { name: 'keyCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events event subclasses (stage 59): TimerEvent / ProgressEvent /
    // ErrorEvent / IOErrorEvent / DataEvent. Pure constant classes + a few fields;
    // bubbles/cancelable defaults differ per class (TimerEvent both false), so each
    // has its own constructor. clone()/toString() follow the existing MouseEvent
    // simplification (not overridden; Event.clone() returns a base Event).
    this.classMap.set('TimerEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['TIMER', mec('TimerEvent', 'timer')],
        ['TIMER_COMPLETE', mec('TimerEvent', 'timerComplete')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ProgressEvent', {
      fields: new Map([
        ['bytesLoaded', mef({ kind: 'uint' }, 'ProgressEvent')],
        ['bytesTotal', mef({ kind: 'uint' }, 'ProgressEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['PROGRESS', mec('ProgressEvent', 'progress')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'bytesLoaded', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'bytesTotal', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ErrorEvent', {
      fields: new Map([
        ['text', mef({ kind: 'string' }, 'ErrorEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['ERROR', mec('ErrorEvent', 'error')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('IOErrorEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['IO_ERROR', mec('IOErrorEvent', 'ioError')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'ErrorEvent',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('DataEvent', {
      fields: new Map([
        ['data', mef({ kind: 'string' }, 'DataEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['DATA', mec('DataEvent', 'data')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'data', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.utils.Timer (stage 60): repeating timer extending EventDispatcher.
    // delay/repeatCount are getter/setter pairs (setter validates range); the
    // backing fields store the values. currentCount/running are read-only. The
    // repeating-timer pool and tick live in runtime.ts (as_rep_timer_*), driven by
    // as_timer_tick() from the frame loop; Timer_start registers, Timer__on_tick
    // fires/dispatches/re-arms.
    const tmr = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const tmg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const tms = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('Timer', {
      fields: new Map([
        ['delay', mef({ kind: 'number' }, 'Timer')],
        ['repeatCount', mef({ kind: 'int' }, 'Timer')],
        ['currentCount', mef({ kind: 'int' }, 'Timer')],
        ['running', mef({ kind: 'bool' }, 'Timer')],
      ]),
      methods: new Map([
        ['start', tmr({ kind: 'void' }, [])],
        ['stop', tmr({ kind: 'void' }, [])],
        ['reset', tmr({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['delay', tmg({ kind: 'number' })],
        ['repeatCount', tmg({ kind: 'int' })],
        ['currentCount', tmg({ kind: 'int' })],
        ['running', tmg({ kind: 'bool' })],
      ]),
      setters: new Map([
        ['delay', tms('Number')],
        ['repeatCount', tms('int')],
      ]),
      constructor: { params: [
        { name: 'delay', type: 'Number', defaultValue: null, isRest: false },
        { name: 'repeatCount', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // built-in drawing API (flash.display) — stage 37.
    // Graphics accumulates a single SkPath plus current fill/stroke paints; the
    // render() replay (emit.ts as_graphics_render) draws the accumulated path
    // with whichever paint(s) are set. The opaque Skia pointers cross the C
    // boundary as `void*` (`kind: 'null'`), so AS3 never sees their layout.
    const gpf = (): FieldInfo => ({ type: { kind: 'null' }, init: null, visibility: 'public', owner: 'Graphics', isStatic: false, isConst: false });
    const gpm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Graphics', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const gnum = (name: string, def: number): Param => ({ name, type: 'Number', defaultValue: { kind: 'Num', value: def, isInt: false }, isRest: false });
    const guint = (name: string, def: number): Param => ({ name, type: 'uint', defaultValue: { kind: 'Num', value: def, isInt: true }, isRest: false });
    this.classMap.set('Graphics', {
      fields: new Map([
        ['path', gpf()],
        ['fill', gpf()],
        ['stroke', gpf()],
      ]),
      methods: new Map([
        ['moveTo', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0)])],
        ['lineTo', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0)])],
        ['curveTo', gpm({ kind: 'void' }, [gnum('controlX', 0), gnum('controlY', 0), gnum('anchorX', 0), gnum('anchorY', 0)])],
        ['beginFill', gpm({ kind: 'void' }, [guint('color', 0), gnum('alpha', 1)])],
        ['endFill', gpm({ kind: 'void' }, [])],
        ['lineStyle', gpm({ kind: 'void' }, [gnum('thickness', 0), guint('color', 0), gnum('alpha', 1)])],
        ['beginGradientFill', gpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'colors', type: 'Array', defaultValue: null, isRest: false },
          { name: 'alphas', type: 'Array', defaultValue: null, isRest: false },
          { name: 'ratios', type: 'Array', defaultValue: null, isRest: false },
          { name: 'matrix', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
        ['drawRect', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0), gnum('width', 0), gnum('height', 0)])],
        ['drawCircle', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0), gnum('radius', 0)])],
        ['clear', gpm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Shape is a leaf drawable (not a container): one Graphics instance.
    const shpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Shape', isStatic: false, isConst: false });
    this.classMap.set('Shape', {
      fields: new Map([['graphics', shpf({ kind: 'object', className: 'Graphics' })]]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    // Bitmap draws a BitmapData; BitmapData holds raw RGBA pixels (getPixel/
    // setPixel) plus an optional decoded SkImage (loaded via the non-standard
    // loadFile hook) used by render().
    const bmpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Bitmap', isStatic: false, isConst: false });
    this.classMap.set('Bitmap', {
      fields: new Map([['bitmapData', bmpf({ kind: 'object', className: 'BitmapData' })]]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [{ name: 'bitmapData', type: 'BitmapData', defaultValue: { kind: 'Null' }, isRest: false }] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    const bdf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'BitmapData', isStatic: false, isConst: false });
    const bdm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'BitmapData', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('BitmapData', {
      fields: new Map([
        ['width', bdf({ kind: 'int' })],
        ['height', bdf({ kind: 'int' })],
        ['transparent', bdf({ kind: 'bool' })],
        ['pixels', bdf({ kind: 'null' })],
        ['image', bdf({ kind: 'null' })],
      ]),
      methods: new Map([
        ['getPixel', bdm({ kind: 'uint' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['setPixel', bdm({ kind: 'void' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
          { name: 'color', type: 'uint', defaultValue: null, isRest: false },
        ])],
        ['loadFile', bdm({ kind: 'void' }, [{ name: 'path', type: 'String', defaultValue: null, isRest: false }])],
        ['applyFilter', bdm({ kind: 'void' }, [
          { name: 'sourceBitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'sourceRect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'destPoint', type: 'Point', defaultValue: null, isRest: false },
          { name: 'filter', type: 'BitmapFilter', defaultValue: null, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['rect', { returnType: { kind: 'object', className: 'Rectangle' }, params: [], owner: 'BitmapData', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'width', type: 'int', defaultValue: null, isRest: false },
        { name: 'height', type: 'int', defaultValue: null, isRest: false },
        { name: 'transparent', type: 'Boolean', defaultValue: { kind: 'Bool', value: true }, isRest: false },
        { name: 'fillColor', type: 'uint', defaultValue: { kind: 'Num', value: 4294967295, isInt: true }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.filters (stage 61): BitmapFilter abstract base + concrete filters.
    // These are value bundles (numeric fields); rasterization happens in
    // BitmapData_applyFilter via a separable repeated box blur (BlurFilter).
    const flf = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const flm = (ret: CType, params: Param[], owner: string): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('BitmapFilter', {
      fields: new Map(),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'BitmapFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('BlurFilter', {
      fields: new Map([
        ['blurX', flf({ kind: 'number' }, 'BlurFilter')],
        ['blurY', flf({ kind: 'number' }, 'BlurFilter')],
        ['quality', flf({ kind: 'int' }, 'BlurFilter')],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'BlurFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('DropShadowFilter', {
      fields: new Map([
        ['distance', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['angle', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['color', flf({ kind: 'uint' }, 'DropShadowFilter')],
        ['alpha', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['blurX', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['blurY', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['strength', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['quality', flf({ kind: 'int' }, 'DropShadowFilter')],
        ['inner', flf({ kind: 'bool' }, 'DropShadowFilter')],
        ['knockout', flf({ kind: 'bool' }, 'DropShadowFilter')],
        ['hideObject', flf({ kind: 'bool' }, 'DropShadowFilter')],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'DropShadowFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'distance', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'angle', type: 'Number', defaultValue: { kind: 'Num', value: 45, isInt: true }, isRest: false },
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'strength', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'inner', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'knockout', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'hideObject', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('GlowFilter', {
      fields: new Map([
        ['color', flf({ kind: 'uint' }, 'GlowFilter')],
        ['alpha', flf({ kind: 'number' }, 'GlowFilter')],
        ['blurX', flf({ kind: 'number' }, 'GlowFilter')],
        ['blurY', flf({ kind: 'number' }, 'GlowFilter')],
        ['strength', flf({ kind: 'number' }, 'GlowFilter')],
        ['quality', flf({ kind: 'int' }, 'GlowFilter')],
        ['inner', flf({ kind: 'bool' }, 'GlowFilter')],
        ['knockout', flf({ kind: 'bool' }, 'GlowFilter')],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'GlowFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 16711680, isInt: true }, isRest: false },
        { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 6, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 6, isInt: true }, isRest: false },
        { name: 'strength', type: 'Number', defaultValue: { kind: 'Num', value: 2, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'inner', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'knockout', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('BitmapFilterQuality', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['LOW', { type: { kind: 'int' }, init: { kind: 'Num', value: 1, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
        ['MEDIUM', { type: { kind: 'int' }, init: { kind: 'Num', value: 2, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
        ['HIGH', { type: { kind: 'int' }, init: { kind: 'Num', value: 3, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.utils.ByteArray — growable big-endian byte buffer with read/write
    // primitives and zlib compress/uncompress (stage 36 runtime support). `data`
    // is the raw byte buffer; `length`/`position` are AS3-visible; `capacity` is
    // internal. `bytesAvailable` is a read-only getter (length - position).
    const bayf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'ByteArray', isStatic: false, isConst: false });
    const bayg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'ByteArray', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const baym = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'ByteArray', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('ByteArray', {
      fields: new Map([
        ['data', bayf({ kind: 'null' })],
        ['length', bayf({ kind: 'int' })],
        ['capacity', bayf({ kind: 'int' })],
        ['position', bayf({ kind: 'int' })],
      ]),
      methods: new Map([
        ['writeByte', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeShort', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeInt', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeFloat', baym({ kind: 'void' }, [{ name: 'v', type: 'Number', defaultValue: null, isRest: false }])],
        ['writeUTFBytes', baym({ kind: 'void' }, [{ name: 's', type: 'String', defaultValue: null, isRest: false }])],
        ['readByte', baym({ kind: 'int' }, [])],
        ['readShort', baym({ kind: 'int' }, [])],
        ['readInt', baym({ kind: 'int' }, [])],
        ['readFloat', baym({ kind: 'number' }, [])],
        ['readUTFBytes', baym({ kind: 'string' }, [{ name: 'n', type: 'int', defaultValue: null, isRest: false }])],
        ['compress', baym({ kind: 'void' }, [])],
        ['uncompress', baym({ kind: 'void' }, [])],
        ['clear', baym({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bytesAvailable', bayg({ kind: 'int' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.text — stage 38.
    const tff = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    this.classMap.set('TextFormat', {
      fields: new Map([
        ['font', tff({ kind: 'string' }, 'TextFormat')],
        ['size', tff({ kind: 'number' }, 'TextFormat')],
        ['color', tff({ kind: 'uint' }, 'TextFormat')],
        ['bold', tff({ kind: 'bool' }, 'TextFormat')],
        ['italic', tff({ kind: 'bool' }, 'TextFormat')],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'font', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'size', type: 'Number', defaultValue: { kind: 'Num', value: 12, isInt: false }, isRest: false },
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'bold', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'italic', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    const txf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'TextField', isStatic: false, isConst: false });
    const txg = (ret: CType, name: string): MethodInfo => ({ returnType: ret, params: [], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const txm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('TextField', {
      fields: new Map([
        ['text', txf({ kind: 'string' })],
        ['defaultTextFormat', txf({ kind: 'object', className: 'TextFormat' })],
        ['multiline', txf({ kind: 'bool' })],
        ['wordWrap', txf({ kind: 'bool' })],
        ['background', txf({ kind: 'bool' })],
        ['backgroundColor', txf({ kind: 'uint' })],
        ['scrollV', txf({ kind: 'int' })],
      ]),
      methods: new Map([
        ['appendText', txm({ kind: 'void' }, [{ name: 's', type: 'String', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['textWidth', txg({ kind: 'number' }, 'textWidth')],
        ['textHeight', txg({ kind: 'number' }, 'textHeight')],
        ['maxScrollV', txg({ kind: 'int' }, 'maxScrollV')],
        ['numLines', txg({ kind: 'int' }, 'numLines')],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // flash.geom (stage 58): pure 2D value/reference types. Point/Rectangle/
    // Matrix/ColorTransform hold only Number fields (no GC pointers), so their
    // structs are plain `double` bundles. Transform holds Matrix/ColorTransform
    // object references and participates in GC marking via its prop table.
    const gegnum = (name: string, def: number): Param => ({ name, type: 'Number', defaultValue: { kind: 'Num', value: def, isInt: false }, isRest: false });
    const gefield = (owner: string) => (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const gemethod = (owner: string) => (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const gegetter = (owner: string) => (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const gestatic = (owner: string) => (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false });
    const geptParam = (name: string): Param => ({ name, type: 'Point', defaultValue: null, isRest: false });
    // Point: x/y Number, `length` read-only, static distance/interpolate/polar.
    // add/subtract/clone return NEW points; offset/normalize/setTo/copyFrom mutate.
    {
      const pf = gefield('Point');
      const pm = gemethod('Point');
      const pg = gegetter('Point');
      const ps = gestatic('Point');
      this.classMap.set('Point', {
        fields: new Map([['x', pf({ kind: 'number' })], ['y', pf({ kind: 'number' })]]),
        methods: new Map([
          ['add', pm({ kind: 'object', className: 'Point' }, [geptParam('v')])],
          ['subtract', pm({ kind: 'object', className: 'Point' }, [geptParam('v')])],
          ['offset', pm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['normalize', pm({ kind: 'void' }, [gegnum('thickness', 0)])],
          ['setTo', pm({ kind: 'void' }, [gegnum('xa', 0), gegnum('ya', 0)])],
          ['copyFrom', pm({ kind: 'void' }, [geptParam('sourcePoint')])],
          ['clone', pm({ kind: 'object', className: 'Point' }, [])],
          ['equals', pm({ kind: 'bool' }, [geptParam('toCompare')])],
          ['toString', pm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map([
          ['distance', ps({ kind: 'number' }, [geptParam('pt1'), geptParam('pt2')])],
          ['interpolate', ps({ kind: 'object', className: 'Point' }, [geptParam('pt1'), geptParam('pt2'), gegnum('f', 0)])],
          ['polar', ps({ kind: 'object', className: 'Point' }, [gegnum('len', 0), gegnum('angle', 0)])],
        ]),
        getters: new Map([['length', pg({ kind: 'number' })]]),
        setters: new Map(),
        constructor: { params: [gegnum('x', 0), gegnum('y', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Rectangle: x/y/width/height; top/bottom/left/right are read-only getters.
    // intersection/union/clone return NEW rectangles; inflate/offset mutate.
    {
      const rf = gefield('Rectangle');
      const rm = gemethod('Rectangle');
      const rg = gegetter('Rectangle');
      const rp = (name: string): Param => ({ name, type: 'Rectangle', defaultValue: null, isRest: false });
      this.classMap.set('Rectangle', {
        fields: new Map([['x', rf({ kind: 'number' })], ['y', rf({ kind: 'number' })], ['width', rf({ kind: 'number' })], ['height', rf({ kind: 'number' })]]),
        methods: new Map([
          ['intersection', rm({ kind: 'object', className: 'Rectangle' }, [rp('toIntersect')])],
          ['union', rm({ kind: 'object', className: 'Rectangle' }, [rp('toUnion')])],
          ['contains', rm({ kind: 'bool' }, [gegnum('x', 0), gegnum('y', 0)])],
          ['containsPoint', rm({ kind: 'bool' }, [geptParam('point')])],
          ['containsRect', rm({ kind: 'bool' }, [rp('rect')])],
          ['intersects', rm({ kind: 'bool' }, [rp('toIntersect')])],
          ['equals', rm({ kind: 'bool' }, [rp('toCompare')])],
          ['inflate', rm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['offset', rm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['clone', rm({ kind: 'object', className: 'Rectangle' }, [])],
          ['setEmpty', rm({ kind: 'void' }, [])],
          ['isEmpty', rm({ kind: 'bool' }, [])],
          ['toString', rm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map([
          ['top', rg({ kind: 'number' })],
          ['bottom', rg({ kind: 'number' })],
          ['left', rg({ kind: 'number' })],
          ['right', rg({ kind: 'number' })],
        ]),
        setters: new Map(),
        constructor: { params: [gegnum('x', 0), gegnum('y', 0), gegnum('width', 0), gegnum('height', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Matrix: a/b/c/d/tx/ty 2D affine transform; concat/invert/identity/translate/
    // scale/rotate mutate `this`; transformPoint returns a new Point.
    {
      const mf = gefield('Matrix');
      const mm = gemethod('Matrix');
      const mp = (name: string): Param => ({ name, type: 'Matrix', defaultValue: null, isRest: false });
      this.classMap.set('Matrix', {
        fields: new Map([['a', mf({ kind: 'number' })], ['b', mf({ kind: 'number' })], ['c', mf({ kind: 'number' })], ['d', mf({ kind: 'number' })], ['tx', mf({ kind: 'number' })], ['ty', mf({ kind: 'number' })]]),
        methods: new Map([
          ['identity', mm({ kind: 'void' }, [])],
          ['translate', mm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['scale', mm({ kind: 'void' }, [gegnum('sx', 0), gegnum('sy', 0)])],
          ['rotate', mm({ kind: 'void' }, [gegnum('angle', 0)])],
          ['concat', mm({ kind: 'void' }, [mp('m')])],
          ['invert', mm({ kind: 'void' }, [])],
          ['transformPoint', mm({ kind: 'object', className: 'Point' }, [geptParam('point')])],
          ['deltaTransformPoint', mm({ kind: 'object', className: 'Point' }, [geptParam('point')])],
          ['createBox', mm({ kind: 'void' }, [gegnum('scaleX', 0), gegnum('scaleY', 0), gegnum('rotation', 0), gegnum('tx', 0), gegnum('ty', 0)])],
          ['createGradientBox', mm({ kind: 'void' }, [gegnum('width', 0), gegnum('height', 0), gegnum('rotation', 0), gegnum('tx', 0), gegnum('ty', 0)])],
          ['clone', mm({ kind: 'object', className: 'Matrix' }, [])],
          ['toString', mm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [gegnum('a', 1), gegnum('b', 0), gegnum('c', 0), gegnum('d', 1), gegnum('tx', 0), gegnum('ty', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // ColorTransform: 8 Number channels (4 multipliers default 1, 4 offsets
    // default 0); concat composes `this = this * second`.
    {
      const cf = gefield('ColorTransform');
      const cm = gemethod('ColorTransform');
      const cp = (name: string): Param => ({ name, type: 'ColorTransform', defaultValue: null, isRest: false });
      this.classMap.set('ColorTransform', {
        fields: new Map([
          ['redMultiplier', cf({ kind: 'number' })], ['greenMultiplier', cf({ kind: 'number' })], ['blueMultiplier', cf({ kind: 'number' })], ['alphaMultiplier', cf({ kind: 'number' })],
          ['redOffset', cf({ kind: 'number' })], ['greenOffset', cf({ kind: 'number' })], ['blueOffset', cf({ kind: 'number' })], ['alphaOffset', cf({ kind: 'number' })],
        ]),
        methods: new Map([
          ['concat', cm({ kind: 'void' }, [cp('second')])],
          ['toString', cm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [gegnum('redMultiplier', 1), gegnum('greenMultiplier', 1), gegnum('blueMultiplier', 1), gegnum('alphaMultiplier', 1), gegnum('redOffset', 0), gegnum('greenOffset', 0), gegnum('blueOffset', 0), gegnum('alphaOffset', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Transform: holds a Matrix and ColorTransform (identity by default). Wiring
    // to DisplayObject.transform (applying Matrix to the Skia canvas) is deferred
    // to a later stage; this provides the value/reference accessor surface.
    {
      const tf = gefield('Transform');
      this.classMap.set('Transform', {
        fields: new Map([
          ['matrix', tf({ kind: 'object', className: 'Matrix' })],
          ['colorTransform', tf({ kind: 'object', className: 'ColorTransform' })],
        ]),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // pass 1: register class shells with their superclass link.
    for (const stmt of program.body) {
      if (stmt.kind === 'ClassDecl') {
        const cname = fqn(stmt.name, stmt.packageName);
        const info: ClassInfo = {
          fields: new Map(),
          methods: new Map(),
          staticFields: new Map(),
          staticMethods: new Map(),
          getters: new Map(),
          setters: new Map(),
          constructor: { params: [] },
          superClass: stmt.superClass ? (typeAlias.get(stmt.superClass) ?? stmt.superClass) : 'Object',
          isFinal: stmt.isFinal,
          implements: stmt.implements.map((i) => typeAlias.get(i) ?? i),
          packageName: stmt.packageName,
        };
        this.classMap.set(cname, info);
      }
    }
    // pass 2: direct fields / constructor / methods.
    for (const stmt of program.body) {
      if (stmt.kind === 'ClassDecl') {
        const cname = fqn(stmt.name, stmt.packageName);
        const info = this.classMap.get(cname)!;
        for (const m of stmt.members) {
          if (m.kind === 'Field') {
            const f: FieldInfo = { type: resolveType(m.type), init: m.init, visibility: m.visibility, owner: cname, isStatic: m.isStatic, isConst: m.isConst };
            // const fields are implicitly class-level (static) in AS3.
            if (m.isStatic || m.isConst) info.staticFields.set(m.name, f);
            else info.fields.set(m.name, f);
          } else if (m.kind === 'Constructor') {
            info.constructor = { params: m.params };
          }
        }
        for (const m of stmt.members) {
          if (m.kind === 'Method') {
            const mi: MethodInfo = { returnType: resolveType(m.returnType), params: m.params, owner: cname, visibility: m.visibility, isStatic: m.isStatic, isFinal: m.isFinal, isGetter: m.isGetter, isSetter: m.isSetter, metadata: m.metadata };
            // [WasmExport] on a method: only static methods lower to a `this`-free
            // C function callable from JS. Instance methods carry a leading
            // `void* _this` (plus GC-heap construction JS cannot perform) and
            // getters/setters have distinct signatures — all rejected at compile
            // time rather than silently mis-exported.
            const we = m.metadata.find((md) => md.name === 'WasmExport');
            if (we) {
              if (!m.isStatic) throw new CodegenError(`[WasmExport] cannot be applied to instance method '${cname}.${m.name}': only static methods (and top-level functions) are callable from JS`);
              if (m.isGetter || m.isSetter) throw new CodegenError(`[WasmExport] cannot be applied to getter/setter '${cname}.${m.name}'`);
              this.exportList.push({
                symbol: `${cname}_${m.name}`,
                alias: we.args[0] ?? null,
                returnType: resolveType(m.returnType),
                params: m.params.map((p) => ({ name: p.name, type: resolveType(p.type) })),
              });
            }
            if (m.isGetter) info.getters.set(m.name, mi);
            else if (m.isSetter) info.setters.set(m.name, mi);
            else if (m.isStatic) info.staticMethods.set(m.name, mi);
            else info.methods.set(m.name, mi);
          }
        }
      } else if (stmt.kind === 'FuncDecl') {
        this.funcMap.set(stmt.name, { returnType: resolveType(stmt.returnType), params: stmt.params, metadata: stmt.metadata });
        // [WasmExport] on a top-level function: it lowers to a same-named, `this`-free
        // C global, directly callable from JS.
        const we = stmt.metadata.find((md) => md.name === 'WasmExport');
        if (we) {
          this.exportList.push({
            symbol: stmt.name,
            alias: we.args[0] ?? null,
            returnType: resolveType(stmt.returnType),
            params: stmt.params.map((p) => ({ name: p.name, type: resolveType(p.type) })),
          });
        }
      }
    }
    // pass 3: flatten inherited members into each subclass.
    for (const name of this.classMap.keys()) {
      this.expandInheritance(name);
    }
    // pass 4: verify each class implements every method of its interfaces.
    for (const [name, info] of this.classMap) {
      for (const iname of info.implements) {
        const intf = this.interfaceMap.get(iname);
        if (!intf) throw new CodegenError(`unknown interface '${iname}'`);
        for (const mname of intf.methods.keys()) {
          if (!info.methods.has(mname)) {
            throw new CodegenError(`class '${name}' does not implement method '${mname}' of interface '${iname}'`);
          }
        }
      }
    }
  }

  getClass(name: string): ClassInfo | undefined { return this.classMap.get(name); }
  getFunc(name: string): FuncInfo | undefined { return this.funcMap.get(name); }
  hasClass(name: string): boolean { return this.classMap.has(name); }
  hasInterface(name: string): boolean { return this.interfaceMap.has(name); }

  isSubclassOf(cls: string, base: string): boolean {
    let cur: string | null = cls;
    while (cur !== null) {
      if (cur === base) return true;
      cur = this.classMap.get(cur)?.superClass ?? null;
    }
    return false;
  }

  isAccessible(visibility: Visibility, owner: string, from: string | null): boolean {
    if (visibility === 'public') return true;
    if (from === null) return false; // top-level code has no class context
    if (visibility === 'private') return owner === from;
    if (visibility === 'internal') {
      // visible within the same package (both top-level => null package).
      const ownerPkg = this.classMap.get(owner)?.packageName ?? null;
      const fromPkg = this.classMap.get(from)?.packageName ?? null;
      return ownerPkg === fromPkg;
    }
    // protected: accessible within the declaring class or a subclass
    return this.isSubclassOf(from, owner);
  }

  private expandInheritance(name: string, visiting: Set<string> = new Set()): void {
    const info = this.classMap.get(name)!;
    if (info.superClass === null) return;
    if (visiting.has(name)) throw new CodegenError(`circular inheritance involving '${name}'`);
    const superInfo = this.classMap.get(info.superClass);
    if (!superInfo) throw new CodegenError(`unknown superclass '${info.superClass}' of '${name}'`);
    if (superInfo.isFinal) throw new CodegenError(`cannot inherit from final class '${info.superClass}'`);
    visiting.add(name);
    this.expandInheritance(info.superClass, visiting);
    visiting.delete(name);

    const fields = new Map<string, FieldInfo>();
    for (const [f, v] of superInfo.fields) fields.set(f, v);
    for (const [f, v] of info.fields) fields.set(f, v);
    info.fields = fields;

    const methods = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo.methods) methods.set(m, v);
    for (const [m, v] of info.methods) {
      const overridden = methods.get(m);
      if (overridden && overridden.isFinal) {
        throw new CodegenError(`cannot override final method '${m}' of '${overridden.owner}'`);
      }
      methods.set(m, v);
    }
    info.methods = methods;

    const staticFields = new Map<string, FieldInfo>();
    for (const [f, v] of superInfo.staticFields) staticFields.set(f, v);
    for (const [f, v] of info.staticFields) staticFields.set(f, v);
    info.staticFields = staticFields;

    const staticMethods = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo.staticMethods) staticMethods.set(m, v);
    for (const [m, v] of info.staticMethods) staticMethods.set(m, v);
    info.staticMethods = staticMethods;

    const getters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo.getters) getters.set(m, v);
    for (const [m, v] of info.getters) getters.set(m, v);
    info.getters = getters;

    const setters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo.setters) setters.set(m, v);
    for (const [m, v] of info.setters) setters.set(m, v);
    info.setters = setters;

    // interfaces are inherited: a subclass implements its superclass's interfaces too.
    info.implements = [...new Set([...superInfo.implements, ...info.implements])];
  }
}
