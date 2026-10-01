// C emitter: pass 2 of the generator. Walks the AST and emits readable C for
// declarations, statements, and expressions using the symbols gathered in pass 1.

import type { Program, Stmt, Expr, ASType, Param, ClassMember, Block } from './ast.ts';
import { RUNTIME_PREAMBLE } from './runtime.ts';
import { resolveType, ctypeToString, CodegenError, qualifiedName, sanitizeCIdent } from './symbols.ts';
import type { CType, MethodInfo, SymbolTable } from './symbols.ts';

// Declarations owned by the module (top-level script) scope: AS3 hoists every
// `var`/`const` written anywhere in the top-level statement tree — including one
// inside a block, an `if`, a `switch` case, a `try`, or a `for` init — into the
// single script scope, so they all share one slot (`for (var i…) {}` then
// `trace(i)` must see the loop's last value, not an undeclared name). Returns them
// in source order, first declaration of a name winning (a script-scope name has
// exactly one C global). Used by `emitModuleVars` to declare the C globals and by
// the closure walk (`scriptVarNames`) so a free variable that is a module global is
// read/written directly instead of being captured by value — the two must agree,
// or a closure would silently read a stale snapshot.
//
// for-in / for-each-in loop vars ARE hoisted too, but their C type is not written
// in the source: it follows from the iterable (an Array yields `int` indices, a
// dynamic object yields `char*` keys, a Dictionary/`Object` yields boxed values).
// The decl therefore carries the loop descriptor instead of a type, and
// `emitModuleVars` resolves it with the same rule the emit sites use
// (`loopVarType`) — the two must agree, exactly like `scriptVarNames` must agree
// with `emitModuleVars`. Function-scope loop vars stay block-local (the
// convention `collectHoistedVarsStmt` uses). Nested functions/classes own their
// scopes and are not descended into.
export type ScriptDecl = {
  name: string;
  type: ASType | null;
  init: Expr | null;
  isConst: boolean;
  loop?: { kind: 'in' | 'each'; iterable: Expr; declared: ASType | null };
};

function collectScriptDecls(body: Stmt[]): ScriptDecl[] {
  const decls: ScriptDecl[] = [];
  const seen = new Set<string>();
  const push = (name: string, type: ASType | null, init: Expr | null, isConst: boolean, loop?: ScriptDecl['loop']): void => {
    if (seen.has(name)) return;
    seen.add(name);
    decls.push(loop ? { name, type, init, isConst, loop } : { name, type, init, isConst });
  };
  const walk = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case 'VarDecl': push(s.name, s.type, s.init, false); break;
        case 'VarDecls': for (const d of s.decls) push(d.name, d.type, d.init, false); break;
        case 'ConstDecl': push(s.name, s.type, s.init, true); break;
        case 'ConstDecls': for (const d of s.decls) push(d.name, d.type, d.init, true); break;
        case 'Block': walk(s.body); break;
        case 'If': walk([s.then]); if (s.else) walk([s.else]); break;
        case 'While': case 'DoWhile': walk([s.body]); break;
        case 'For':
          if (s.init && s.init.kind === 'VarDecl') push(s.init.name, s.init.type, s.init.init, false);
          walk([s.body]);
          break;
        case 'ForIn':
          if (s.declares) push(s.varName, null, null, false, { kind: 'in', iterable: s.iterable, declared: null });
          walk([s.body]);
          break;
        case 'ForEachIn':
          if (s.declares) push(s.varName, null, null, false, { kind: 'each', iterable: s.iterable, declared: s.varType });
          walk([s.body]);
          break;
        case 'Switch': for (const c of s.cases) walk(c.body); break;
        case 'Try':
          walk(s.tryBody.body);
          if (s.catchBody) walk(s.catchBody.body);
          if (s.finallyBody) walk(s.finallyBody.body);
          break;
        case 'Label': walk([s.body]); break;
        default: break; // FuncDecl/ClassDecl/InterfaceDecl/leaf statements
      }
    }
  };
  walk(body);
  return decls;
}

function collectScriptVars(body: Stmt[]): Set<string> {
  return new Set(collectScriptDecls(body).map((d) => d.name));
}

// Compound assignment operator -> underlying binary operator.
const COMPOUND_BASE: Record<string, string> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%',
  '<<=': '<<', '>>=': '>>', '>>>=': '>>>', '&=': '&', '|=': '|', '^=': '^',
};

export class Emitter {
  private out: string[] = [];
  private indent = 0;
  private scopes: Map<string, CType>[] = [];
  // Function-scoped locals (AS3 `var` is hoisted to the enclosing function, not
  // the enclosing block). While emitting a function body this points at the scope
  // frame created for that function, so `var` declarations land there and stay
  // visible to sibling blocks (`if (x) { var k:int = 1; } for (k = 0; ...)`).
  private functionScope: Map<string, CType> | null = null;
  // Names already hoisted to the function top for the current function; their
  // in-body `var` sites emit a plain assignment instead of a re-declaration.
  private hoistedLocals: Set<string> = new Set();
  private currentClass: string | null = null;
  private currentMethod: string | null = null;
  private suppressBreak = 0;
  private labels: { asName: string; cName: string; tryDepth: number }[] = [];
  // try/finally exception-stack hygiene (stage 76 follow-up): each open try
  // block is tracked so that control flow leaving it early (return/break/
  // continue) pops the jmp stack and runs any pending finally body before
  // jumping out. `active` marks frames whose `as_jmp_depth++` is still on the
  // stack (i.e. while emitting the try body); `finallyBody` is the not-yet-run
  // finally block, nulled once the inline finally starts emitting.
  private tryFrames: { active: boolean; finallyBody: Block | null }[] = [];
  // Entry try-depth of the nearest breakable (loop/switch) and continuable
  // (loop) context, used to unwind try frames when break/continue jumps out.
  private breakTargets: number[] = [];
  // A continuable loop records its entry try-depth, plus — when the loop was
  // rewritten around a sequenced condition/update (see `emitWhile`) — the C label
  // that an unlabelled `continue` must `goto` instead of jumping to the C loop's
  // back edge (the update prelude/statements sit behind it). `used` lets the label
  // be emitted only when some `continue` actually targets it.
  private continueTargets: { depth: number; label: string | null; used: boolean }[] = [];
  private tmpCounter = 0;
  private currentReturnType: CType | null = null;
  // module-level (file-scope) variables: AS3 top-level `var`/`const` are hoisted
  // to C file-scope globals so free functions and main() both see them.
  private moduleScope = new Map<string, CType>();
  private moduleConsts = new Set<string>();
  // C-identifier sanitization (stage 76): maps an AS3 method/field/local/param
  // name to its mangled C name (cached so declaration and every reference agree),
  // and tracks every emitted name so distinct AS3 names stay distinct (P2).
  private cNameCache = new Map<string, string>();
  private usedCIdentifiers = new Set<string>();

  private program: Program;
  private symbols: SymbolTable;
  private anonFuncs: { name: string; asName: string | null; params: Param[]; returnType: ASType; body: Block; captures: { name: string; type: CType }[]; cname: string | null; isStatic: boolean; depth: number; methodName: string | null }[] = [];
  private anonIndex = new Map<object, string>();
  private anonSeq = 0;
  private vectorSpecs = new Map<string, CType>();
  // closure analysis state (pass 1 pre-scan)
  private funcVars: Map<string, CType>[] = [];
  private anonCaptures = new Map<object, { name: string; type: CType }[]>();
  private currentAnonLocal: Map<string, CType> | null = null;
  private currentAnonRefs: { name: string; type: CType }[] | null = null;
  // Whether the anonymous function currently being walked references the enclosing
  // class's instance state (a bare `this` or an unqualified instance-method call),
  // and therefore must capture `this` in its environment.
  private currentAnonNeedsThis = false;
  // closure emit state (pass 2): non-null while emitting a capturing anon body
  private currentClosureCaptures: Map<string, CType> | null = null;
  // The nested function currently being emitted (its unique C name and arity),
  // so a recursive self-reference inside its own body resolves to a closure over
  // the current `env` rather than recursively rebuilding the env.
  private currentFuncCName: string | null = null;
  // AS3 name of the function expression whose body is being emitted (null for
  // anonymous ones). A reference to this name inside its own body denotes the
  // function itself (`as_fn_make(currentFuncCName__call, env, arity)`), which is
  // how a named function expression recurses.
  private currentFuncAsName: string | null = null;
  // Walk-time counterpart of currentFuncAsName: the name of the named function
  // expression currently being scanned. References to it are the function itself,
  // so they must not be recorded as free variables or class-member references.
  private walkSelfName: string | null = null;
  private currentFuncArity = 0;
  // Closures currently being built (to break mutual recursion between sibling
  // nested functions, e.g. onLoadComplete <-> cleanup). A self/mutual reference
  // encountered while building yields NULL rather than recursing forever.
  private buildingClosures = new Set<string>();
  // Mutually-recursive sibling closure groups (a shared cell breaks the cycle).
  // Keyed by each member's unique C name -> the group's shared cell info. The
  // cell holds one `as_fn` slot per member plus the merged free-variable captures,
  // so every sibling reads vars and sibling function values from the SAME cell
  // (function identity is shared, satisfying removeEventListener's === match).
  private closureGroups = new Map<string, { cellName: string; cellLocal: string; members: string[]; varCaps: { name: string; type: CType }[] }>();
  // Groups keyed by the defining method (`class:method`), so the enclosing body
  // emission can declare the cell locals it must lazily initialize.
  private closureGroupsByMethod = new Map<string, { cellName: string; cellLocal: string; members: string[]; varCaps: { name: string; type: CType }[] }[]>();
  // While emitting the ENCLOSING function body (not a closure body), maps each
  // boxed (heap-shared) captured local variable name to its cell storage location.
  // AS3 closures capture variables by reference; a closure that mutates `numComplete`
  // or reads a `queue` assigned after closure creation must see the SAME storage as
  // the enclosing body, so these captured locals live in the shared closure cell
  // rather than as plain C locals (which the old snapshot model captured by value).
  private enclosingCaptured = new Map<string, { type: CType; cell: string; field: string }>();
  // ---------- closure activation cells (capture by reference) ----------
  // AS3 closes over variables, not values: a `var` local (or parameter) of a
  // function is a single slot shared by that activation and every nested closure.
  // The env-snapshot model copied the value at closure-creation time, so a local
  // assigned AFTER the closure was created (Starling's AtfTextureFactory does
  // `texture = Texture.fromData(...)` after installing the onReady closure) was
  // still seen as null by the closure (`onComplete(name, null)` -> the asset was
  // never registered). To match AVM2 each function body whose `var` locals are
  // captured by a directly nested closure gets a heap-allocated *activation cell*:
  // the enclosing body accesses those locals as `cellN->x` and every closure that
  // needs them captures the cell POINTER (`env->cellN->x`), so both sides share one
  // storage regardless of when the assignment happens.
  //
  // Keyed by the function's body statement array (stable AST identity, identical
  // between the walk and emit passes). A frame is pushed only for real functions
  // (methods, free functions, nested functions/expressions) — never for the
  // top-level script, whose vars are module globals with their own storage.
  private walkFnBodyStack: Stmt[][] = [];
  private walkFnBody: Stmt[] | null = null;
  private fnBodyParent = new Map<Stmt[], Stmt[] | null>();
  private fnBodyVars = new Map<Stmt[], Map<string, CType>>();
  private fnBodyKids = new Map<Stmt[], string[]>();
  private fnBodyClass = new Map<Stmt[], string | null>();
  // Post-walk result: per function body that owns a cell, the cell's C names and
  // the captured locals it stores.
  private fnBodyCells = new Map<Stmt[], { cellName: string; cellLocal: string; members: string[]; varCaps: { name: string; type: CType }[] }>();
  // Per closure: which of its captures resolve through a cell (`name -> cellLocal`)
  // and which cell pointers its env must carry (its own needs plus every
  // descendant's, so the pointer can be threaded down at each creation site).
  private closureCellEnv = new Map<string, { resolve: Map<string, string>; ptrs: { cellLocal: string; cellName: string }[] }>();
  // Emission state: the body currently being emitted (set by hoistFunctionLocals)
  // and, while emitting a closure body, the name -> cellLocal resolution map.
  private currentEmitFnBody: Stmt[] | null = null;
  private currentClosureCells: Map<string, string> | null = null;
  // bound-method state: an unqualified identifier inside an instance method that
  // names one of the class's methods is `this.method` used as a value (e.g. passed
  // to addEventListener). Each such reference needs a thunk that captures `this`
  // and dispatches through the vtable.
  private boundMethods = new Map<string, { cname: string; mname: string; m: MethodInfo }>();
  // `super.method` used as a Function value (`super.addVertices.apply(this, args)`).
  // Unlike `this.method` (which must dispatch virtually, so an override still runs),
  // `super.method` is statically resolved to the SUPERCLASS implementation. The bound
  // thunk therefore calls `Owner_method` directly instead of going through the vtable;
  // a vtable call here would re-enter the overriding method and recurse forever.
  private superBoundMethods = new Map<string, { owner: string; mname: string; m: MethodInfo }>();
  // Nested function declarations (a `function foo()` statement inside a method or
  // function body): AS3 treats these as named closures, so each is recorded with
  // its captured free variables during pass 1 and resolved to a closure value
  // when referenced by bare name in emitVar. Keyed by a globally-unique C name
  // (AS3 function-scoped names collide across classes/methods, so a bare-name
  // key would overwrite earlier records); `nestedFuncByAsName` maps the
  // source-level name (qualified by the defining class) back to that unique key.
  private nestedFuncs = new Map<string, { captures: { name: string; type: CType }[]; params: Param[]; asName: string; methodName: string | null }>();
  private nestedFuncByAsName = new Map<string, string>();
  // static-method-as-value state: `ClassName.method` referenced as a Function value
  // (e.g. `var f:Function = TweenLite.killTweensOf`) needs a non-capturing thunk.
  private staticMethodRefs = new Map<string, { cname: string; mname: string; m: MethodInfo }>();
  private currentWalkClass: string | null = null;
  private currentWalkIsStatic = false;
  private currentWalkMethod: string | null = null;
  private currentIsStatic = false;
  // AS3 `arguments` object: the enclosing function's formal parameters, non-null
  // while emitting a method/free-function body (so `arguments` resolves).
  private currentArgs: Param[] | null = null;
  // Self-modifying assignments (`x op= y`, `x = y`, `++x`/`x++`/`--x`/`x--`) that
  // were hoisted into sequenced prelude statements so AS3's left-to-right
  // evaluation order is preserved. Maps the AST node to its value temp.
  private hoistedAssigns = new Map<Expr, { tmp: string; type: CType }>();
  // Non-const static fields whose initializer must run at runtime (in main).
  private staticFieldInits: { cname: string; fname: string; f: FieldInfo }[] = [];
  // Classes that own at least one runtime-initialized static field. A read or
  // write of one of their static fields must first run `C_cinit()` (AS3 lazy
  // class initialization), so eager-initialization order can never read NULL.
  private cinitClasses = new Set<string>();

  // C names of classes declared in the compiled source (as opposed to built-ins
  // registered directly in the symbol table). Only these get a generated
  // `_new_default` definition, so emitClassRegistry may only reference it for
  // them; a built-in with all-optional params keeps the NULL factory.
  private userClasses = new Set<string>();

  constructor(program: Program, symbols: SymbolTable) {
    this.program = program;
    this.symbols = symbols;
  }

  // ---------- top level ----------

  run(): string {
    this.line(RUNTIME_PREAMBLE.trimEnd());
    this.line('');
    for (const s of this.program.body) {
      if (s.kind === 'ClassDecl') this.userClasses.add(qualifiedName(s.name, s.packageName));
    }
    this.collectFunctionValues(); // also gathers Vector.<T> specializations
    this.noteBuiltinVectorSpecs();
    this.emitTypedefs();
    this.emitStructs();
    this.emitPrototypes();
    this.emitSealedPropErrors();
    this.emitForwardDecls();
    this.emitModuleVars();
    this.emitFunctionValues();
    this.emitPropTables();
    this.emitMethodThunks();
    this.emitGetterThunks();
    this.emitMethodTables();
    this.emitGetterTables();
    this.emitSetterThunks();
    this.emitSetterTables();
    this.emitInterfaceVtables();
    this.emitVtables();
    this.emitClassRegistry();
    this.emitStaticFields();
    this.emitStaticInits();
    this.emitDefinitions();
    this.emitExportWrappers();
    this.emitGCRoots();
    this.emitMain();
    this.staticizeTopLevelFunctions();
    return this.out.join('\n') + '\n';
  }

  // Mark every top-level (file-scope) function that is not reachable from main
  // or exported as `static`, so clang -O2 can dead-strip it. This is the whole
  // of the size optimization: built-in class method bodies (Date_ctor,
  // ByteArray_compress, ...) are emitted as global symbols; a global symbol can
  // never be dead-code-eliminated because clang must assume another translation
  // unit might reference it. Making them `static` lets -O2 build a complete
  // call graph from `main` and drop every builtin a program never touches
  // (hello.as: 165 KB -> ~34 KB). vtable / reflection tables are already
  // `static`, so once their referencing method bodies vanish they vanish too —
  // no manual dependency graph or per-class tree-shaking needed. Only `main`
  // and [WasmExport] symbols stay global (wasm export table / cross-TU glue).
  private staticizeTopLevelFunctions(): void {
    const exported = new Set<string>(['main']);
    for (const e of this.symbols.exports) {
      exported.add(e.symbol);
      if (e.alias) exported.add(e.alias);
    }
    const lines = this.out.join('\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart() !== line) continue; // indented: inside a function body
      const s = line.trim();
      if (
        s === '' ||
        s.startsWith('static ') || s.startsWith('typedef ') || s.startsWith('extern ') ||
        s.startsWith('struct ') || s.startsWith('#') || s.startsWith('//') ||
        s.startsWith('/*') || s.startsWith('*')
      ) continue;
      // File-scope function definition/declaration: `return-type name(`.
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_ *]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      if (exported.has(m[2])) continue;
      lines[i] = 'static ' + line;
    }
    this.out = lines;
  }

  // ---------- helpers ----------

  private line(s = ''): void {
    if (s === '') { this.out.push(''); return; }
    this.out.push('  '.repeat(this.indent) + s);
  }

  private cTypeName(t: CType): string {
    switch (t.kind) {
      case 'int': return 'int';
      case 'uint': return 'unsigned int';
      case 'number': return 'double';
      case 'bool': return 'bool';
      case 'string': return 'char*';
      case 'null': return 'void*';
      case 'object': return `${t.className}*`;
      case 'interface': return `${t.name}`;
      case 'array': return 'as_array*';
      case 'vector': return `as_vector_${this.vectorCName(t.elem)}*`;
      case 'record': return 'as_object*';
      case 'any': return 'as_value';
      case 'function': return 'as_fn';
      case 'class': return 'as_class*';
      case 'dict': return 'as_dict*';
      case 'regexp': return 'as_regex*';
      case 'xml': return 'as_xml_node*';
      case 'xmllist': return 'as_xml_list*';
      case 'void': return 'void';
    }
  }

  // const-declared type. AS3's `const X` means the *reference* is immutable, not
  // the object it points to (for reference types) or its character buffer (for
  // strings). C's `const X*` (pointee-qualified) would wrongly freeze the target
  // object's members (`const Node* n; n->next = ...` fails) and, for strings,
  // force a discarded-qualifier warning at `char*` call sites. `X* const`
  // (pointer-qualified) matches AS3: the pointer itself can't be reassigned, but
  // the pointee stays writable.
  private constTypeName(t: CType): string {
    switch (t.kind) {
      case 'string': return 'char* const';
      case 'object': return `${t.className}* const`;
      case 'array': return 'as_array* const';
      case 'vector': return `as_vector_${this.vectorCName(t.elem)}* const`;
      case 'record': return 'as_object* const';
      case 'class': return 'as_class* const';
      case 'dict': return 'as_dict* const';
      case 'regexp': return 'as_regex* const';
      case 'xml': return 'as_xml_node* const';
      case 'xmllist': return 'as_xml_list* const';
      case 'function': return 'as_fn const';
      case 'interface': return `const ${this.cTypeName(t)}`; // struct value: freeze the {obj, vt} pair, not the pointee
      default: return `const ${this.cTypeName(t)}`; // int/uint/number/bool/any/null/void
    }
  }

  private defaultInit(t: CType): string {
    switch (t.kind) {
      case 'int': return '0';
      case 'uint': return '0';
      case 'number': return 'NAN';
      case 'bool': return 'false';
      case 'string': return 'NULL';
      case 'null': return 'NULL';
      case 'object': return 'NULL';
      case 'interface': return `(${t.name}){ NULL, NULL }`;
      case 'array': return 'NULL';
      case 'vector': return 'NULL';
      case 'record': return 'NULL';
      case 'any': return '(as_value){0, 0.0, NULL}';
      case 'function': return 'NULL';
      case 'class': return 'NULL';
      case 'dict': return 'NULL';
      case 'regexp': return 'NULL';
      case 'xml': return 'NULL';
      case 'xmllist': return 'NULL';
      case 'void': return '';
    }
  }

  // Whether a constructor body (recursively) contains a `super(...)` call. AS3
  // permits `super()` inside a conditional/loop as long as every non-throwing path
  // calls it; the top-level `findIndex` alone misses those, so this walks nested
  // statements too (but not nested function/class bodies, whose `super` is unrelated).
  private containsSuperCall(stmts: Stmt[]): boolean {
    for (const s of stmts) {
      if (s.kind === 'SuperCall') return true;
      switch (s.kind) {
        case 'Block': if (this.containsSuperCall(s.body)) return true; break;
        case 'If': if (this.containsSuperCallStmt(s.then)) return true; if (s.else && this.containsSuperCallStmt(s.else)) return true; break;
        case 'While': case 'DoWhile': case 'For': case 'ForIn': case 'ForEachIn': if (this.containsSuperCallStmt(s.body)) return true; break;
        case 'Switch': for (const c of s.cases) if (this.containsSuperCall(c.body)) return true; break;
        case 'Label': if (this.containsSuperCallStmt(s.body)) return true; break;
        case 'Try': if (this.containsSuperCall(s.tryBody.body)) return true; if (s.catchBody && this.containsSuperCall(s.catchBody.body)) return true; if (s.finallyBody && this.containsSuperCall(s.finallyBody.body)) return true; break;
        default: break;
      }
    }
    return false;
  }

  private containsSuperCallStmt(s: Stmt): boolean {
    return this.containsSuperCall([s]);
  }

  // Stable C name fragment for a Vector element type (used to build the
  // monomorphized `as_vector_<key>` struct and its helpers).
  private vectorCName(elem: CType): string {
    switch (elem.kind) {
      case 'int': return 'int';
      case 'uint': return 'uint';
      case 'number': return 'number';
      case 'bool': return 'bool';
      case 'string': return 'string';
      case 'object': return elem.className;
      case 'interface': return elem.name;
      case 'array': return 'array';
      case 'function': return 'function';
      case 'xml': return 'xml';
      case 'xmllist': return 'xmllist';
      case 'vector': return 'vector_' + this.vectorCName(elem.elem);
      default: throw new CodegenError('unsupported Vector element type: ' + elem.kind);
    }
  }

  // Whether a Vector element type is a GC-managed reference (string/object/interface)
  // vs. a scalar value (int/uint/number/bool). Reference elements need their data
  // array GC-traced; scalar elements' data is a plain (non-GC) value buffer.
  private vectorElemIsPtr(elem: CType): boolean {
    // Interface values are stored BY VALUE as `{ obj, vt }` structs, not as raw
    // pointers (their obj member is a pointer, but the element itself is not).
    return elem.kind === 'string' || elem.kind === 'object' ||
           elem.kind === 'array' || elem.kind === 'function' || elem.kind === 'vector' ||
           elem.kind === 'xml' || elem.kind === 'xmllist';
  }

  // How a captured CType must be traced from a closure environment: 'ptr' for a
  // raw object/string/function pointer (gc_mark_ptr), 'value' for a boxed
  // as_value (gc_mark_value), or null for a scalar needing no tracing.
  private captureMarkKind(t: CType): 'ptr' | 'value' | null {
    switch (t.kind) {
      case 'string': case 'object': case 'interface': case 'array':
      case 'vector': case 'record': case 'dict': case 'function':
      case 'regexp': case 'class': case 'xml': case 'xmllist': return 'ptr';
      case 'any': return 'value';
      default: return null;
    }
  }

  // Hoist the collection expression of a for-in / for-each loop into a temporary.
  // AS3 evaluates that expression exactly once, but the generated loop inlines it
  // into the condition, so a call with side effects would run on every iteration:
  // Starling's `for each (var name:String in getTextureNames(prefix, sNames))`
  // re-appends to the very vector it iterates, so the bound grew forever (an
  // infinite loop inside AssetManager.getTextures -> MovieScene never opened).
  // The temp captures the collection object once, while `->length` on it stays
  // live, matching AVM2 (elements pushed by the body are still visited).
  private hoistCollection(e: { code: string; type: CType }): string {
    const tmp = this.tmpName('coll');
    this.line(`${this.cTypeName(e.type)} ${tmp} = ${e.code};`);
    return tmp;
  }

  // C expression turning a Vector element value into its string form (for join).
  private vectorElemToStr(elem: CType, expr: string): string {
    switch (elem.kind) {
      case 'int': return `as_str_from_int(${expr})`;
      case 'uint': return `as_str_from_uint(${expr})`;
      case 'number': return `as_str_from_double(${expr})`;
      case 'bool': return `as_str_from_bool(${expr})`;
      case 'string': return `(${expr} ? ${expr} : "null")`;
      case 'object': return `as_obj_to_str((void*)(${expr}))`;
      case 'interface': return `as_obj_to_str(${expr}.obj)`;
      case 'xml': return `as_xml_to_string(${expr})`;
      case 'xmllist': return `as_xml_list_to_string(${expr})`;
      case 'function': return '"function Function() {}"';
      case 'vector': return '"[object Vector]"';
      case 'array': return `as_array_join(${expr}, ",")`;
      case 'dict': return '"[object Dictionary]"';
      case 'regexp': return '"[object RegExp]"';
      case 'class': return '"[class]"';
      case 'record': return '"[object Object]"';
      default: throw new CodegenError('unsupported Vector element type for join: ' + elem.kind);
    }
  }

  // C expression testing whether two Vector element values are equal (for indexOf).
  private vectorElemEq(elem: CType, a: string, b: string): string {
    if (elem.kind === 'string') return `strcmp(${a}, ${b}) == 0`;
    if (elem.kind === 'interface') return `(${a}.obj == ${b}.obj && ${a}.vt == ${b}.vt)`;
    return `${a} == ${b}`;
  }

  // Record a Vector.<T> specialization so its struct and helpers can be emitted
  // once, monomorphized to the element type.
  private noteType(t: ASType | null): void {
    if (t && t.startsWith('Vector.<')) {
      const ct = this.rt(t);
      if (ct.kind === 'vector') this.vectorSpecs.set(this.vectorCName(ct.elem), ct.elem);
    }
  }

  // Register a Vector.<T> specialization referenced by a resolved CType.
  private noteCType(t: CType): void {
    if (t.kind === 'vector') this.vectorSpecs.set(this.vectorCName(t.elem), t.elem);
  }

  // Built-in class method/field signatures can reference Vector.<T> that no user
  // code mentions directly (e.g. Matrix3D.rawData -> Vector.<Number>, decompose ->
  // Vector.<Vector3D>). Register those specializations so their struct + helpers
  // are emitted (the per-specialization helpers are `static`, so -O2 still dead-
  // strips the ones a program never reaches).
  private noteBuiltinVectorSpecs(): void {
    for (const [, info] of this.symbols.classes) {
      for (const f of info.fields.values()) this.noteCType(f.type);
      for (const m of info.methods.values()) { this.noteCType(m.returnType); for (const p of m.params) this.noteCType(resolveType(p.type, info.importAlias)); }
      for (const m of info.getters.values()) this.noteCType(m.returnType);
      for (const m of info.setters.values()) for (const p of m.params) this.noteCType(resolveType(p.type, info.importAlias));
      for (const m of info.staticGetters?.values() ?? []) this.noteCType(m.returnType);
      for (const m of info.staticSetters?.values() ?? []) for (const p of m.params) this.noteCType(resolveType(p.type, info.importAlias));
      for (const m of info.staticMethods.values()) { this.noteCType(m.returnType); for (const p of m.params) this.noteCType(resolveType(p.type, info.importAlias)); }
    }
  }

  private escapeCString(s: string): string {
    let r = '';
    for (const ch of s) {
      switch (ch) {
        case '\\': r += '\\\\'; break;
        case '"': r += '\\"'; break;
        case '\n': r += '\\n'; break;
        case '\t': r += '\\t'; break;
        case '\r': r += '\\r'; break;
        case '\0': r += '\\0'; break;
        default: r += ch;
      }
    }
    return r;
  }

  private formatDouble(v: number): string {
    // A C double literal must be visually distinct from an int (append .0), but
    // scientific notation already carries 'e' and must NOT get '.0' appended
    // (C rejects "1e+21.0" as an invalid floating constant).
    const s = String(v);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }

  // ---------- scoping ----------

  private pushScope(): void { this.scopes.push(new Map()); }
  private popScope(): void { this.scopes.pop(); }
  private declareVar(name: string, t: CType): void {
    this.scopes[this.scopes.length - 1].set(name, t);
  }

  // ---------- function-scoped `var` hoisting ----------

  // Emit hoisted C declarations for every typed `var`/`for(var ...)` in `body`
  // (not descending into nested functions/classes). AS3 declares these at the
  // enclosing *function*, so a `var` inside an `if` block must be visible in a
  // sibling `for` loop. C locals are block-scoped, so we hoist the declaration
  // to the function top and leave the initializer (if any) as a plain assignment
  // at the original site via emitVarDecl.
  private hoistFunctionLocals(body: Stmt[]): void {
    this.hoistedLocals = new Set();
    // Identify the body currently being emitted so its activation cell (if any)
    // can be introduced and referenced by name inside it.
    this.currentEmitFnBody = body;
    this.collectHoistedVars(body);
    // Populate the boxed captured-local set after the hoisted vars are known, so
    // only `var`-locals (not params / untyped block locals) get reference cells.
    this.buildEnclosingCaptured();
    // The activation cell holds the captured locals of this body; allocate it up
    // front (before any closure in the body can be created) so the enclosing body
    // and every closure share one storage, whichever side assigns first.
    this.emitActivationCell();
    if (this.hoistedLocals.size === 0) return;
    // Emit declarations in first-seen order (function scope is a Map, insertion-
    // ordered), so `int a`/`int b` read top-down exactly as the source declares.
    for (const name of this.hoistedLocals) {
      // Captured locals live in the shared closure cell (reference semantics),
      // not as plain C locals — skip the local declaration so the enclosing body
      // and its closures read/write the same heap storage.
      if (this.enclosingCaptured.has(name)) continue;
      const t = this.functionScope!.get(name)!;
      this.line(`${this.cTypeName(t)} ${this.cIdent(name)} = ${this.defaultInit(t)};`);
    }
  }

  // Populate `enclosingCaptured` with the boxed (heap-shared) captured locals of
  // the function currently being emitted. AS3 closures capture by reference, so a
  // captured `var` local assigned after closure creation (or mutated inside a
  // closure) must share storage with the enclosing body; it therefore lives in the
  // shared closure cell. Only typed `var` locals are boxed — `this` and function
  // parameters are never reassigned (a parameter reassignment is legal but rare;
  // it falls back to snapshot) and keep a by-value seed.
  private buildEnclosingCaptured(): void {
    this.enclosingCaptured = new Map();
    // A closure body resolves its captures via `env->name` (currentClosureCaptures),
    // not the enclosing cell — do not box here.
    if (this.currentClosureCaptures === null) {
      const key = `${this.currentClass ?? ''}:${this.currentMethod ?? ''}`;
      const groups = this.closureGroupsByMethod.get(key);
      if (groups) {
        for (const g of groups) {
          for (const c of g.varCaps) {
            if (c.name === 'this') continue;
            if (!this.hoistedLocals.has(c.name)) continue;
            this.enclosingCaptured.set(c.name, { type: c.type, cell: g.cellLocal, field: this.cIdent(c.name) });
          }
        }
      }
    }
    // This body's own activation cell (captured var-locals shared with closures).
    // Applies inside closure bodies too: a nested function's own captured local
    // must be shared with the closures defined in it (Starling's
    // AtfTextureFactory.createTexture assigns `texture` after installing the
    // onReady closure, and that closure must observe the assignment).
    const cell = this.currentEmitFnBody !== null ? this.fnBodyCells.get(this.currentEmitFnBody) : undefined;
    if (cell) {
      for (const f of cell.varCaps) {
        if (!this.hoistedLocals.has(f.name)) continue;
        this.enclosingCaptured.set(f.name, { type: f.type, cell: cell.cellLocal, field: this.cIdent(f.name) });
      }
    }
  }

  // Emit (declare + allocate) the activation cell of the body being emitted. The
  // allocator zero-fills the struct and sets Number fields to NaN, matching AS3's
  // default value for an unassigned local.
  private emitActivationCell(): void {
    const body = this.currentEmitFnBody;
    if (body === null) return;
    const cell = this.fnBodyCells.get(body);
    if (!cell) return;
    this.declareVar(cell.cellLocal, { kind: 'object', className: cell.cellName });
    this.line(`${cell.cellName}* ${this.cIdent(cell.cellLocal)} = ${cell.cellName}_alloc();`);
  }

  // Eagerly allocate each mutually-recursive closure group's shared cell and seed
  // its non-boxed captures (`this`, function params) from the enclosing scope. The
  // boxed captured locals are default-initialized by the allocator and written by
  // the enclosing body via `cell->field` (reference semantics).
  private emitClosureCellLocals(): void {
    const key = `${this.currentClass ?? ''}:${this.currentMethod ?? ''}`;
    const groups = this.closureGroupsByMethod.get(key);
    if (!groups) return;
    for (const g of groups) {
      this.line(`${g.cellName}* ${g.cellLocal} = ${g.cellName}_alloc();`);
      // Seed non-boxed captures (this + function params) from the current scope.
      for (const c of g.varCaps) {
        if (this.enclosingCaptured.has(c.name)) continue;
        const v = this.emitVar(c.name);
        this.line(`${g.cellLocal}->${this.cIdent(c.name)} = ${v.code};`);
      }
    }
  }

  // The environment struct name for a nested function: a group member's impl
  // takes the shared cell as its environment; a plain capturing closure takes
  // its own `_nfXX_env` struct.
  private closureEnvType(fn: { name: string }): string {
    const g = this.closureGroups.get(fn.name);
    return g ? g.cellName : `${fn.name}_env`;
  }

  private collectHoistedVars(stmts: Stmt[]): void {
    for (const s of stmts) this.collectHoistedVarsStmt(s);
  }

  private hoistVar(name: string, type: ASType | null): void {
    // Untyped `var x = expr` needs the expression's type, which only emitExpr
    // can infer; those stay block-scoped in place (they never appear in the
    // cross-block patterns AS3 hoisting exists for). Typed vars are hoisted.
    if (type === null) return;
    if (!this.hoistedLocals.has(name)) {
      this.hoistedLocals.add(name);
      this.functionScope!.set(name, this.rt(type));
    }
  }

  private collectHoistedVarsStmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': this.hoistVar(s.name, s.type); break;
      case 'VarDecls': for (const d of s.decls) this.hoistVar(d.name, d.type); break;
      case 'Block': this.collectHoistedVars(s.body); break;
      case 'If': this.collectHoistedVarsStmt(s.then); if (s.else) this.collectHoistedVarsStmt(s.else); break;
      case 'While': this.collectHoistedVarsStmt(s.body); break;
      case 'DoWhile': this.collectHoistedVarsStmt(s.body); break;
      case 'For':
        if (s.init && s.init.kind === 'VarDecl') this.hoistVar(s.init.name, s.init.type);
        this.collectHoistedVarsStmt(s.body);
        break;
      // for-in / for-each-in declare their loop var in a block-local scope (the
      // var's type depends on the iterable, resolved at emit time), but any `var`
      // *inside* their bodies is still function-scoped and must be hoisted.
      case 'ForIn': this.collectHoistedVarsStmt(s.body); break;
      case 'ForEachIn': this.collectHoistedVarsStmt(s.body); break;
      case 'Switch': for (const c of s.cases) this.collectHoistedVars(c.body); break;
      case 'Try':
        this.collectHoistedVars(s.tryBody.body);
        if (s.catchBody) this.collectHoistedVars(s.catchBody.body);
        if (s.finallyBody) this.collectHoistedVars(s.finallyBody.body);
        break;
      case 'Label': this.collectHoistedVarsStmt(s.body); break;
      // Do not descend into nested functions/classes (their vars are their own).
      default: break;
    }
  }

  // Sanitize a method/field/local/param name to a collision-free C identifier.
  // Cached so the same AS3 name always maps to the same C name (declaration and
  // every reference agree); `usedCIdentifiers` keeps distinct names distinct (P2).
  private cIdent(name: string): string {
    const cached = this.cNameCache.get(name);
    if (cached !== undefined) return cached;
    const c = sanitizeCIdent(name, this.usedCIdentifiers);
    this.cNameCache.set(name, c);
    return c;
  }

  private tmpName(prefix: string): string {
    return `_${prefix}${this.tmpCounter++}`;
  }

  // Resolve a source type name in the CURRENT class's import context (so short
  // names like `Sprite`/`Rectangle` pick the class imported by this file, not the
  // global alias table). Falls back to the global table when not inside a class.
  private rt(t: ASType | null): CType {
    const alias = this.currentClass ? this.symbols.getClass(this.currentClass)?.importAlias : null;
    return resolveType(t, alias);
  }

  // Resolve a short class name written in source (e.g. `Log` in package `demo`)
  // to its fully-qualified C identifier (`demo.Log`) via the same alias table
  // resolveType uses. Built-ins and package-less classes map to themselves.
  private resolveClassName(name: string): string {
    const t = this.rt(name);
    if (t.kind === 'object') return t.className;
    if (t.kind === 'interface') return t.name;
    return name;
  }

  // Flatten a dot-separated member chain (`a.b.c.d`) into [a, b, c, d] when it is
  // rooted at a Var (the package's first segment in a fully-qualified reference
  // like `starling.events.Event.ROOT_CREATED`). Returns null for anything else.
  private flattenDotChain(expr: Expr): string[] | null {
    const names: string[] = [];
    let cur: Expr = expr;
    while (cur.kind === 'Member') {
      names.unshift(cur.property);
      cur = cur.object;
    }
    if (cur.kind === 'Var') {
      names.unshift(cur.name);
      return names;
    }
    return null;
  }

  // ---------- declarations ----------

  private emitTypedefs(): void {
    for (const name of this.symbols.classes.keys()) {
      this.line(`typedef struct ${name}_vtable ${name}_vtable;`);
      this.line(`typedef struct ${name} ${name};`);
    }
    for (const name of this.symbols.interfaces.keys()) {
      this.line(`typedef struct ${name}_vtable ${name}_vtable;`);
      this.line(`typedef struct ${name} ${name};`);
    }
    if (this.symbols.classes.size > 0 || this.symbols.interfaces.size > 0) this.line('');
  }

  private emitStructs(): void {
    // Vector.<T> monomorphized structs: a GCT_CUSTOM mark callback (so the GC
    // can trace element pointers for reference element types), then the
    // contiguous element array + length/capacity. Emitted FIRST so vtable slots
    // (e.g. Matrix3D.transformVectors -> as_vector_number*) can reference them.
    // Iterate in sorted order so a nested vector's element type (which itself is
    // a vector typedef) is defined before the vector whose data points at it.
    for (const [key, elem] of [...this.vectorSpecs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.line(`typedef struct { void (*mark)(void*); ${this.cTypeName(elem)}* data; int length; int capacity; } as_vector_${key};`);
    }
    if (this.vectorSpecs.size > 0) this.line('');
    // Interface reference structs must be complete before any class struct whose
    // field holds an interface value (AS3 fields typed as an interface are stored
    // by value as the `{ obj, vt }` pair). The class struct loop below can
    // therefore embed `ITextCompositor _compositor;` — without this the field is
    // an incomplete type (forward-declared typedef only).
    for (const [name] of this.symbols.interfaces) {
      this.line(`struct ${name} {`);
      this.indent++;
      this.line('void* obj;');
      this.line(`${name}_vtable* vt;`);
      this.indent--;
      this.line('};');
    }
    if (this.symbols.interfaces.size > 0) this.line('');
    for (const [name, info] of this.symbols.classes) {
      this.line(`// class ${name}`);
      // vtable struct: `super` chain for runtime type checks (`is`/`as`), then
      // one function-pointer slot per (inherited or own) method.
      this.line(`struct ${name}_vtable {`);
      this.indent++;
      this.line('const char* name;');
      this.line('void* super;');
      this.line('void** ifaces;');
      this.line('void* props;');
      this.line('void* methods;');
      this.line('void* getters;');
      // Reflection table of OWN setters (`setters` mirrors the runtime
      // as_vtable_header field of the same name). Without it a dynamic write
      // (`obj[name] = v`, e.g. the Juggler tweening an accessor-backed property
      // like `alpha`/`rotationX`) cannot reach the setter implementation.
      this.line('void* setters;');
      // Byte offset of the `_dyn` slot table (dynamic classes only), -1 otherwise.
      // Mirrors as_vtable_header.dyn_offset so a class vtable can be cast to it.
      this.line('int dyn_offset;');
      // AS3 fully-qualified class name ("包::类"), mirrors as_vtable_header.fqn so
      // getQualifiedClassName can return the human-readable name rather than the
      // sanitized C identifier in `name`.
      this.line('const char* fqn;');
      for (const slot of info.vtableSlots ?? []) {
        if (slot.kind === 'method') this.line(`${this.methodPtrField(slot.info, slot.name)};`);
        else if (slot.kind === 'getter') this.line(`${this.getterPtrField(slot.info, slot.name)};`);
        else this.line(`${this.setterPtrField(slot.info, slot.name)};`);
      }
      this.indent--;
      this.line('};');
      // object struct: vtable pointer first (so a subclass pointer is layout-
      // compatible with its superclass pointer), then fields.
      this.line(`struct ${name} {`);
      this.indent++;
      this.line(`${name}_vtable* vtable;`);
      for (const [fname, f] of info.fields) {
        this.line(`${this.cTypeName(f.type)} ${this.cIdent(fname)};`);
        // cacheAsBitmap backing store: when the AS3-visible cacheAsBitmap flag is
        // set, as_render_cached bakes the subtree into an offscreen surface and
        // caches the SkImage here. Emitted immediately after cacheAsBitmap in
        // every DisplayObject subclass (the field is inheritance-flattened), so
        // the offset stays layout-identical when a subclass pointer is cast to
        // DisplayObject* for rendering. C-runtime only (not AS3-visible).
        if (fname === 'cacheAsBitmap') {
          this.line('void* _cache_image;');
          this.line('double _cache_w;');
          this.line('double _cache_h;');
          this.line('int _cache_valid;');
          // Incremental-redraw state (auto cacheAsBitmap): _auto_fp is the
          // subtree content fingerprint from the last frame (see
          // as_render_fingerprint), _auto_still counts consecutive frames with an
          // unchanged fingerprint, and _auto_baked marks the subtree as currently
          // baked into _cache_image. A static subtree that stays unchanged for
          // ASC_AUTO_BAKE_FRAMES frames is baked automatically — no manual
          // cacheAsBitmap toggle — and re-baked the instant the fingerprint moves.
          this.line('uint32_t _auto_fp;');
          this.line('int _auto_still;');
          this.line('int _auto_baked;');
        }
        // TextField caches its laid-out SkParagraph so repaints and property
        // reads (textWidth/textHeight/numLines/maxScrollV) reuse one layout
        // instead of re-measuring every frame. These fields are C-runtime only
        // (not AS3-visible). `textColor` is TextField's LAST declared field, so
        // emitting the cache right after it keeps the same offset in every
        // TextField subclass (GameGUI extends TextField): the TextField_* bodies
        // read these slots through a `TextField*` cast, and a subclass's own
        // fields must not shift them.
        if (fname === 'textColor' && this.symbols.isSubclassOf(name, 'TextField')) {
          this.line('void* _para;');
          this.line('const char* _para_text;');
          this.line('double _para_w;');
          this.line('double _para_size;');
          this.line('int _para_bold;');
          this.line('int _para_italic;');
          this.line('unsigned _para_color;');
          this.line('int _para_collapse;');
          this.line('double _para_leading;');
          this.line('int _para_align;');
          this.line('int _sel_begin;');
          this.line('int _sel_end;');
          this.line('int _sel_caret;');
          this.line('as_array* _runs;');
          this.line('int _html_dirty;');
          this.line('int _scroll_h;');
        }
      }
      // Dynamic classes (AS3 `dynamic class`) carry a runtime slot table for
      // arbitrary undeclared string-keyed properties. Its byte offset is emitted
      // into the vtable so as_dyn_get/set can reach it.
      if (info.isDynamic) this.line('as_object* _dyn;');
      // Matrix3D keeps its 16 column-major doubles in a C-runtime-only array (the
      // class declares no AS3-visible fields; rawData is a getter/setter). Emitted
      // here so the layout is stable and all Matrix3D_* bodies can read `o->_m`.
      if (this.symbols.isSubclassOf(name, 'Matrix3D')) {
        this.line('double _m[16];');
      }
      // SharedObject keeps its persisted attribute table (a GC object, so the
      // props reflection table marks it — see emitPropTables), the storage file
      // path, and the client callback target in C-runtime-only slots. data / size
      // / client / objectEncoding are AS3 accessors, so no AS3-visible field is
      // declared (AIR's data is read-only and mxmlc rejects `so.data = x`).
      if (this.symbols.isSubclassOf(name, 'SharedObject')) {
        this.line('char* name;');
        this.line('char* path;');
        this.line('as_object* _data;');
        this.line('void* _client;');
        this.line('unsigned int _objectEncoding;');
        this.line('double _fps;');
      }
      // URLStream owns its transfer: `_job` is the live streaming job (a plain
      // malloc structure, NOT traced by the GC), and `_buf`/`_buf_pos` are the
      // remainder copied out of it when the load completes, so reads keep working
      // after the job retires. `_buf` is a GC ByteArray and is marked through the
      // props table (see emitPropTables); `_job` must never be — pointer-tagging
      // a malloc block would send gc_scan into non-heap memory.
      if (name === 'URLStream') {
        this.line('void* _job;');
        this.line('void* _buf;');
        this.line('int _buf_pos;');
      }
      // flash.net sockets: `_sock` is a BORROWED handle to the transport owned by
      // RUNTIME_PREAMBLE's socket registry (see the socket seam). Not AS3-visible
      // — the AS3 surface is the getters, and close() drops the handle. It must
      // never be a GC pointer: the registry owns the as_sock's lifetime.
      if (this.symbols.isSubclassOf(name, 'Socket') || name === 'XMLSocket' || name === 'ServerSocket') {
        this.line('void* _sock;');
        // A closed ServerSocket cannot be reopened (the reference says to create a
        // new instance), but the object still has to answer a later bind() with the
        // documented error instead of quietly rebinding to a new port.
        if (name === 'ServerSocket') this.line('int _closed;');
      }
      this.indent--;
      this.line('};');
      this.line('');
    }
    // interface vtables (method function pointers only). The reference struct
    // (`struct X { void* obj; X_vtable* vt; }`) is emitted BEFORE the class
    // structs above so class fields can embed interface values by value.
    for (const [name, info] of this.symbols.interfaces) {
      this.line(`struct ${name}_vtable {`);
      this.indent++;
      this.line('const char* name;');
      this.line('void* super;');
      this.line('void** ifaces;');
      this.line('void* props;');
      this.line('void* methods;');
      for (const [mname, m] of info.methods) {
        this.line(`${this.methodPtrField(m, mname, info.importAlias)};`);
      }
      this.indent--;
      this.line('};');
      this.line('');
    }
  }

  // Runtime errors for property access on a SEALED (non-dynamic) class instance.
  // AS3 raises ReferenceError #1056 on `obj.newProp = v` and #1069 on reading a
  // missing property. These are emitted right after the prototypes (rather than
  // living in RUNTIME_PREAMBLE) because they construct Error objects, and the
  // Error class hierarchy is defined after the preamble; the preamble's
  // as_dyn_get / as_dyn_set reach them through the prototypes declared there.
  private emitSealedPropErrors(): void {
    this.line('// Rewrite a "pkg::Name" fully-qualified class name to the dotted "pkg.Name"');
    this.line('// form AIR uses in its error messages. Error path only, and the single static');
    this.line('// buffer makes it non-reentrant (it is consumed within one call).');
    this.line('static char* as_fqn_dotted(const char* fqn) {');
    this.indent++;
    this.line('if (fqn == NULL) return (char*)"Object";');
    this.line('const char* sep = strstr(fqn, "::");');
    this.line('if (sep == NULL) return (char*)fqn;');
    this.line('static char buf[512];');
    this.line('size_t n = (size_t)(sep - fqn); if (n > 500) n = 500;');
    this.line('memcpy(buf, fqn, n);');
    this.line("buf[n] = '.';");
    this.line('size_t rest = strlen(sep + 2); if (rest > 510 - n) rest = 510 - n;');
    this.line('memcpy(buf + n + 1, sep + 2, rest);');
    this.line('buf[n + 1 + rest] = 0;');
    this.line('return buf;');
    this.indent--;
    this.line('}');
    this.line('static void as_throw_sealed_set(const char* key, const char* fqn) {');
    this.indent++;
    this.line('const char* parts[5];');
    this.line('parts[0] = "Error #1056: Cannot create property ";');
    this.line('parts[1] = key;');
    this.line('parts[2] = " on ";');
    this.line('parts[3] = as_fqn_dotted(fqn);');
    this.line('parts[4] = ".";');
    this.line('as_throw(ReferenceError_new(as_str_concat_n(5, parts), 1056));');
    this.indent--;
    this.line('}');
    this.line('static as_value as_throw_sealed_get(const char* key, const char* fqn) {');
    this.indent++;
    this.line('const char* parts[5];');
    this.line('parts[0] = "Error #1069: Property ";');
    this.line('parts[1] = key;');
    this.line('parts[2] = " not found on ";');
    this.line('parts[3] = as_fqn_dotted(fqn);');
    this.line('parts[4] = " and there is no default value.";');
    this.line('as_throw(ReferenceError_new(as_str_concat_n(5, parts), 1069));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('');
  }

  private emitPrototypes(): void {
    // constructors (init + new)
    for (const [name, info] of this.symbols.classes) {
      const params = this.paramDecls(info.constructor.params, info.importAlias);
      this.line(`void ${name}_ctor(${name}* o${params ? ', ' + params : ''});`);
      this.line(`${name}* ${name}_new(${params || 'void'});`);
      // Classes that are constructible with no arguments (every parameter has a
      // default) but whose constructor still takes parameters need a genuine
      // no-argument entry point for the reflection factory.
      const cparams = info.constructor.params;
      if (cparams.length > 0 && cparams.every((p) => p.defaultValue !== null || p.isRest) && this.userClasses.has(name)) {
        this.line(`${name}* ${name}_new_default(void);`);
      }
    }
    // Dynamic class instantiation (`new (classRef)()`). Declared here because its
    // definition lives in emitClassRegistry, which runs AFTER emitFunctionValues
    // (closure bodies may already contain `new (expr as Class)()`).
    this.line('static as_value as_dyn_new(as_class* c);');
    // methods
    for (const [cname, info] of this.symbols.classes) {
      for (const [mname, m] of info.methods) {
        if (m.owner !== cname) continue; // inherited methods are declared under their owner
        const p = this.paramDecls(m.params, info.importAlias);
        this.line(`${this.cTypeName(m.returnType)} ${cname}_${mname}(void* _this${p ? ', ' + p : ''});`);
      }
      // static methods (no receiver)
      for (const [mname, m] of info.staticMethods) {
        if (m.owner !== cname) continue;
        this.line(`${this.cTypeName(m.returnType)} ${cname}_${mname}_static(${this.paramDecls(m.params, info.importAlias)});`);
      }
      // getters / setters
      for (const [mname, m] of info.getters) {
        if (m.owner !== cname) continue;
        this.line(`${this.cTypeName(m.returnType)} ${cname}_get_${mname}(void* _this);`);
      }
      for (const [mname, m] of info.setters) {
        if (m.owner !== cname) continue;
        const p = this.paramDecls(m.params, info.importAlias);
        this.line(`void ${cname}_set_${mname}(void* _this${p ? ', ' + p : ''});`);
      }
      // static getters / setters use a `_static` suffix so they cannot collide
      // with an instance getter/setter of the same name.
      for (const [mname, m] of info.staticGetters ?? []) {
        if (m.owner !== cname) continue;
        this.line(`${this.cTypeName(m.returnType)} ${cname}_get_${mname}_static(void* _this);`);
      }
      for (const [mname, m] of info.staticSetters ?? []) {
        if (m.owner !== cname) continue;
        const p = this.paramDecls(m.params, info.importAlias);
        this.line(`void ${cname}_set_${mname}_static(void* _this${p ? ', ' + p : ''});`);
      }
    }
    // free functions
    for (const [fname, f] of this.symbols.funcs) {
      this.line(`${this.cTypeName(f.returnType)} ${fname}(${this.paramDecls(f.params)});`);
    }
    // Vector.<T> monomorphized helpers.
    for (const [, elem] of this.vectorSpecs) {
      const key = this.vectorCName(elem);
      const ec = this.cTypeName(elem);
      this.line(`as_vector_${key}* as_vector_${key}_new(void);`);
      this.line(`as_vector_${key}* as_vector_${key}_new_sized(int n);`);
      this.line(`as_vector_${key}* as_vector_${key}_make(int n, ${ec}* items);`);
      this.line(`int as_vector_${key}_push(as_vector_${key}* v, ${ec} e);`);
      this.line(`int as_vector_${key}_push_all(as_vector_${key}* v, as_array* a);`);
      this.line(`${ec} as_vector_${key}_pop(as_vector_${key}* v);`);
      this.line(`${ec} as_vector_${key}_shift(as_vector_${key}* v);`);
      this.line(`int as_vector_${key}_unshift(as_vector_${key}* v, ${ec} e);`);
      this.line(`${ec} as_vector_${key}_get(as_vector_${key}* v, int i);`);
      this.line(`void as_vector_${key}_set(as_vector_${key}* v, int i, ${ec} e);`);
      this.line(`int as_vector_${key}_indexOf(as_vector_${key}* v, ${ec} e);`);
      this.line(`char* as_vector_${key}_join(as_vector_${key}* v, const char* sep);`);
      this.line(`void as_vector_${key}_setLength(as_vector_${key}* v, int n);`);
      this.line(`as_vector_${key}* as_vector_${key}_slice(as_vector_${key}* v, int from, int to);`);
      this.line(`as_vector_${key}* as_vector_${key}_concat(as_vector_${key}* a, as_vector_${key}* b);`);
      this.line(`as_vector_${key}* as_vector_${key}_splice(as_vector_${key}* v, int start, int deleteCount, ${ec}* items, int itemCount);`);
      this.line(`${ec} as_vector_${key}_removeAt(as_vector_${key}* v, int index);`);
      this.line(`void as_vector_${key}_insertAt(as_vector_${key}* v, int index, ${ec} e);`);
      this.line(`void as_vector_${key}_forEach(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_map(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_filter(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_sort(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_reverse(as_vector_${key}* v);`);
    }
    if (this.symbols.classes.size > 0 || this.symbols.funcs.size > 0 || this.vectorSpecs.size > 0) this.line('');
  }

  private paramDecls(params: Param[], importAlias?: Map<string, string> | null): string {
    const resolve = (t: ASType | null): CType => importAlias !== undefined ? resolveType(t, importAlias) : this.rt(t);
    return params.map((p) => `${this.cTypeName(resolve(p.type))} ${this.cIdent(p.name)}`).join(', ');
  }

  // Forward-declare every class vtable and static field so bodies emitted before
  // their definitions (anonymous-function thunks in emitFunctionValues, which run
  // before emitVtables/emitStaticFields) can reference them. Anonymous closures
  // capture `env->this` and may do `is`/`as` against `&Bitmap_vt`, compare a Touch
  // against `TouchPhase_BEGAN`, or read a static const — all of which need a
  // declaration to precede the closure body.
  private emitForwardDecls(): void {
    for (const [name] of this.symbols.classes) {
      this.line(`static ${name}_vtable ${name}_vt;`);
    }
    for (const [cname, info] of this.symbols.classes) {
      for (const [fname, f] of info.staticFields) {
        if (f.owner !== cname) continue;
        const t = f.isConst && this.isConstExpr(f.init) ? this.constTypeName(f.type) : this.cTypeName(f.type);
        this.line(`static ${t} ${cname}_${fname};`);
      }
    }
    // Interface vtables (per class implementing the interface) are also referenced
    // before their definitions by anonymous-function bodies and interface value
    // construction, so forward-declare them too.
    for (const [cname, cinfo] of this.symbols.classes) {
      for (const iname of cinfo.implements) {
        this.line(`static ${iname}_vtable ${cname}_${iname}_vt;`);
      }
    }
    if (this.symbols.classes.size > 0) this.line('');
  }

  // Function-pointer field declaration for a vtable slot. The receiver is a
  // `void*` so an overriding method keeps the same signature as the overridden one.
  private methodPtrField(m: MethodInfo, name: string, importAlias?: Map<string, string> | null): string {
    const alias = importAlias ?? this.symbols.getClass(m.owner)?.importAlias;
    const params = m.params.map((p) => this.cTypeName(resolveType(p.type, alias))).join(', ');
    const args = params ? `void*, ${params}` : 'void*';
    return `${this.cTypeName(m.returnType)} (*${this.cIdent(name)})(${args})`;
  }

  // Function-pointer field for a vtable GETTER slot. Getter signature is receiver
  // only (`RetType (*get_name)(void* _this)`); the `get_` prefix keeps the field
  // name distinct from the method slot of the same AS name (and a `set_` slot).
  private getterPtrField(g: MethodInfo, name: string): string {
    return `${this.cTypeName(g.returnType)} (*get_${this.cIdent(name)})(void* _this)`;
  }

  // Function-pointer field for a vtable SETTER slot. Setter signature is receiver
  // plus one value parameter (`void (*set_name)(void* _this, ParamType value)`).
  private setterPtrField(s: MethodInfo, name: string, importAlias?: Map<string, string> | null): string {
    const alias = importAlias ?? this.symbols.getClass(s.owner)?.importAlias;
    const params = s.params.map((p) => this.cTypeName(resolveType(p.type, alias))).join(', ');
    const args = params ? `void* _this, ${params}` : 'void* _this';
    return `void (*set_${this.cIdent(name)})(${args})`;
  }

  // Emit a setter CALL for an instance or static setter. Instance setters are
  // VIRTUAL: dispatch through the runtime object's vtable so a base-typed
  // reference reaches an overriding subclass setter. Static setters call the
  // `_static` implementation directly (objCode is `NULL`). `super.property = v`
  // bypasses this helper (it must call the resolved superclass setter statically).
  private setterCallCode(owner: string, property: string, isStatic: boolean, objCode: string, valueCode: string): string {
    if (isStatic) return `${owner}_set_${property}_static(${objCode}, ${valueCode})`;
    return `(${objCode}->vtable->set_${this.cIdent(property)}(${objCode}, ${valueCode}))`;
  }

  // Static vtable instance per class, filled with the implementing function for
  // each method slot (inherited methods point at their owner's implementation).
  private emitVtables(): void {
    for (const [name, info] of this.symbols.classes) {
      const superVt = info.superClass ? `&${info.superClass}_vt` : 'NULL';
      const ifaceArr = info.implements.length > 0 ? `${name}_ifaces` : 'NULL';
      const props = this.hasOwnProps(name) ? `${name}_props` : 'NULL';
      const methods = this.hasOwnMethods(name) ? `${name}_methods` : 'NULL';
      const getters = this.hasOwnGetters(name) ? `${name}_getters` : 'NULL';
      const setters = this.hasOwnSetters(name) ? `${name}_setters` : 'NULL';
      // Dynamic classes record the byte offset of their `_dyn` slot table here
      // (struct has the field only when isDynamic); non-dynamic classes use -1.
      const dynOffset = info.isDynamic ? `(int)offsetof(${name}, _dyn)` : '-1';
      // AS3 fully-qualified name: user classes carry `fqn` ("包::类"); built-ins
      // (no package) fall back to the sanitized C name, which equals the short name
      // since built-in class names are not C reserved words.
      const fqn = info.fqn ?? name;
      const entries: string[] = [`"${name}"`, superVt, ifaceArr, props, methods, getters, setters, dynOffset, `"${this.escapeCString(fqn)}"`];
      for (const slot of info.vtableSlots ?? []) {
        if (slot.kind === 'method') entries.push(`${slot.info.owner}_${slot.name}`);
        else if (slot.kind === 'getter') entries.push(`${slot.info.owner}_get_${slot.name}`);
        else entries.push(`${slot.info.owner}_set_${slot.name}`);
      }
      this.line(`static ${name}_vtable ${name}_vt = { ${entries.join(', ')} };`);
    }
    if (this.symbols.classes.size > 0) this.line('');
  }

  // flash.utils.getDefinitionByName registry: a NULL-terminated table of user
  // classes (those with an AS3 fqn) mapped to their vtable + no-arg factory. The
  // dynamic `new (classRef)()` path only supports no-arg constructors, so classes
  // with REQUIRED constructor args register a NULL factory (their name can still
  // round-trip getQualifiedClassName -> getDefinitionByName, just not be `new`ed).
  // A class whose parameters are all optional is constructible with no arguments
  // and registers the generated `Foo_new_default` wrapper instead.
  // Built-ins (no packageName -> fqn undefined) are deliberately excluded, so
  // getDefinitionByName("flash.display.Sprite") throws ReferenceError — matching
  // the subset's lack of an AIR built-in definition table.
  // The no-argument factory expression registered for `name` in
  // as_class_registry, or 'NULL' when the class cannot be constructed with no
  // arguments. AS3 permits `new Foo()` iff every constructor parameter has a
  // default, so this MUST be keyed on the count of REQUIRED parameters, not the
  // total (a bug that made `new (Object(x).constructor as Class)()` dereference
  // a NULL pointer for all-optional-parameter classes).
  private ctorFactoryExpr(name: string): string {
    const info = this.symbols.classes.get(name);
    const params = info ? info.constructor.params : [];
    const required = params.filter((p) => p.defaultValue === null && !p.isRest).length;
    if (required !== 0) return 'NULL';
    if (params.length === 0) return `(void*(*)(void))${name}_new`;
    return this.userClasses.has(name) ? `(void*(*)(void))${name}_new_default` : 'NULL';
  }

  private emitClassRegistry(): void {
    // Dynamic class instantiation (`new (classRef)()`). Only the argument-less
    // form is representable in this subset: a class whose constructor has
    // REQUIRED parameters registers a NULL factory, which AS3 reports as
    // ArgumentError #1063 ("Argument count mismatch") — never a null call.
    this.line('static as_value as_dyn_new(as_class* c) {');
    this.indent++;
    this.line('if (c == NULL || c->factory == NULL) {');
    this.indent++;
    this.line('as_throw(ArgumentError_new((char*)"Error #1063: Argument count mismatch", 0));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('return as_v_obj(c->factory());');
    this.indent--;
    this.line('}');
    this.line('');
    const entries: string[] = [];
    const clsDecls: string[] = [];
    for (const [name, info] of this.symbols.classes) {
      if (info.fqn === undefined) continue;
      const factory = this.ctorFactoryExpr(name);
      entries.push(`{ "${this.escapeCString(info.fqn)}", { &${name}_vt, ${factory} } }`);
      // A named class object so a bare class name used as a Class value
      // (e.g. `new Starling(Game, ...)`) can be referenced directly.
      clsDecls.push(`static as_class ${name}_cls = { &${name}_vt, ${factory} };`);
    }
    if (entries.length === 0) return;
    this.line('// ---------- flash.utils.getDefinitionByName registry ----------');
    this.line('typedef struct { const char* fqn; as_class cls; } as_class_reg;');
    for (const d of clsDecls) this.line(d);
    this.line('static as_class_reg as_class_registry[] = {');
    this.indent++;
    for (const e of entries) this.line(e + ',');
    this.line('{ NULL, { NULL, NULL } }'); // sentinel
    this.indent--;
    this.line('};');
    this.line('');
    // Compare a lookup name against a registry FQN, normalizing '::' to '.' so
    // both "flash.display::Sprite" and "flash.display.Sprite" match (AS3 accepts
    // either separator in getDefinitionByName; getQualifiedClassName emits '::').
    this.line('static int as_fqn_match(const char* lookup, const char* fqn) {');
    this.indent++;
    this.line('while (*lookup && *fqn) {');
    this.indent++;
    this.line('char a = *lookup, b = *fqn;');
    this.line('if (a == \':\' && lookup[1] == \':\') { a = \'.\'; lookup += 2; } else { lookup++; }');
    this.line('if (b == \':\' && fqn[1] == \':\') { b = \'.\'; fqn += 2; } else { fqn++; }');
    this.line('if (a != b) return 0;');
    this.indent--;
    this.line('}');
    this.line('return *lookup == *fqn;');
    this.indent--;
    this.line('}');
    this.line('static as_value as_get_definition_by_name(const char* name) {');
    this.indent++;
    this.line('if (name == NULL) { as_throw(ReferenceError_new((char*)"No definition found", 0)); return as_v_null(); }');
    this.line('for (int i = 0; as_class_registry[i].fqn != NULL; i++) {');
    this.indent++;
    this.line('if (as_fqn_match(name, as_class_registry[i].fqn)) return as_v_obj((void*)&as_class_registry[i].cls);');
    this.indent--;
    this.line('}');
    this.line('as_throw(ReferenceError_new((char*)"No definition found", 0));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    // Object.constructor: the Class reference of an object instance. Reads the
    // vtable's fqn and matches it against as_class_registry.
    this.line('static as_value as_v_class_of(as_value v) {');
    this.indent++;
    this.line('if (v.tag != 4 || v.ptr == NULL) return as_v_null();');
    this.line('void* vt = ((as_object_header*)v.ptr)->vtable;');
    this.line('if (vt == NULL) return as_v_null();');
    this.line('const char* fqn = ((as_vtable_header*)vt)->fqn;');
    this.line('for (int i = 0; as_class_registry[i].fqn != NULL; i++) {');
    this.indent++;
    this.line('if (fqn != NULL && strcmp(fqn, as_class_registry[i].fqn) == 0) return as_v_obj((void*)&as_class_registry[i].cls);');
    this.indent--;
    this.line('}');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    // `x is Class`: a Class reference boxed as an object points into the static
    // as_class_registry (never the GC heap), so pointer identity over the registry
    // distinguishes it from a real instance.
    this.line('static bool as_v_is_class(as_value v) {');
    this.indent++;
    this.line('if (v.tag != 4 || v.ptr == NULL) return false;');
    this.line('for (int i = 0; as_class_registry[i].fqn != NULL; i++) {');
    this.indent++;
    this.line('if ((void*)&as_class_registry[i].cls == v.ptr) return true;');
    this.indent--;
    this.line('}');
    this.line('return false;');
    this.indent--;
    this.line('}');
    this.line('');
  }

  // Whether a class declares any of its own (non-inherited) instance fields that
  // are reflectable via dynamic obj[key] access.
  private hasOwnProps(name: string): boolean {
    const info = this.symbols.classes.get(name);
    if (!info) return false;
    // SharedObject declares no AS3-visible fields (data/size/client are
    // accessors), yet its persisted attribute table is a GC object held in a
    // C-runtime-only slot that the GC must trace (emitPropTables adds it).
    if (name === 'SharedObject') return true;
    // URLStream likewise: its live job handle and its post-completion remainder
    // buffer are C-runtime-only slots (the AS3 surface is bytesAvailable /
    // connected / read*), and `_buf` must be traced by the GC.
    if (name === 'URLStream') return true;
    for (const [fname, f] of info.fields) if (f.owner === name) return true;
    return false;
  }

  // Whether a class declares any of its own (non-inherited) instance methods that
  // are reflectable via dynamic obj.method(...) dispatch.
  private hasOwnMethods(name: string): boolean {
    const info = this.symbols.classes.get(name);
    if (!info) return false;
    for (const [mname, m] of info.methods) if (m.owner === name) return true;
    return false;
  }

  // Whether a class declares any of its own (non-inherited) instance getters that
  // are reflectable via dynamic obj["prop"] reads.
  private hasOwnGetters(name: string): boolean {
    const info = this.symbols.classes.get(name);
    if (!info) return false;
    for (const [gname, g] of info.getters) if (g.owner === name) return true;
    return false;
  }

  private hasOwnSetters(name: string): boolean {
    const info = this.symbols.classes.get(name);
    if (!info) return false;
    for (const [sname, s] of info.setters) if (s.owner === name) return true;
    return false;
  }

  // Map a field's CType to the as_prop storage-kind tag understood by as_dyn_get
  // / as_dyn_set (see runtime.ts): 1 number, 2 bool, 3 string, 4 int, 5 uint,
  // 6 reference pointer, 7 boxed as_value.
  private propTypeTag(t: CType): number {
    switch (t.kind) {
      case 'number': return 1;
      case 'bool': return 2;
      case 'string': return 3;
      case 'int': return 4;
      case 'uint': return 5;
      case 'any': return 7;
      default: return 6; // object/interface/array/vector/record/function/class/dict/regexp
    }
  }

  // Per-class field reflection tables: a NULL-terminated as_prop[] describing the
  // class's OWN instance fields (inherited fields are found by walking the vtable
  // super chain, where each class contributes its own table). Offsets are byte
  // offsets within the flattened struct, computed with offsetof.
  private emitPropTables(): void {
    let any = false;
    for (const [name, info] of this.symbols.classes) {
      if (!this.hasOwnProps(name)) continue;
      this.line(`static as_prop ${name}_props[] = {`);
      this.indent++;
      for (const [fname, f] of info.fields) {
        if (f.owner !== name) continue;
        this.line(`{ "${this.escapeCString(f.name ?? fname)}", ${this.propTypeTag(f.type)}, offsetof(${name}, ${this.cIdent(fname)}) },`);
      }
      // TextField holds GC-managed rich-text runs (an as_array of TextFormat
      // object refs) that is not an AS3-visible member, so it is marked here
      // explicitly rather than via a declared field.
      if (name === 'TextField') {
        this.line(`{ "_runs", 6, offsetof(TextField, _runs) },`);
      }
      // SharedObject's persisted table (a GC object) and its client callback
      // target live in C-runtime-only slots; type 6 makes gc_scan follow them.
      if (name === 'SharedObject') {
        this.line(`{ "_data", 6, offsetof(SharedObject, _data) },`);
        this.line(`{ "_client", 6, offsetof(SharedObject, _client) },`);
      }
      // URLStream's remainder buffer is a GC ByteArray held in a C-runtime-only
      // slot, so it is marked here. `_job` is deliberately absent: it is a
      // malloc'd structure, not a GC object (gc_in_heap would reject it, but
      // listing it would also expose it to dynamic obj[key] access).
      if (name === 'URLStream') {
        this.line(`{ "_buf", 6, offsetof(URLStream, _buf) },`);
      }
      this.line('{ NULL, 0, 0 }');
      this.indent--;
      this.line('};');
      any = true;
    }
    if (any) this.line('');
  }

  // Per-class method reflection tables: a NULL-terminated as_method[] mapping each
  // OWN method name to a boxed calling thunk. Inherited methods are reached by
  // walking the vtable super chain. The thunk unboxes each argument from the
  // as_value[] list, calls the typed implementation, and boxes the result.
  private emitMethodThunks(): void {
    let any = false;
    for (const [cname, info] of this.symbols.classes) {
      for (const [mname, m] of info.methods) {
        if (m.owner !== cname) continue;
        const argCodes = m.params.map((p, i) =>
          this.unboxAny({ code: `args[${i}]`, type: { kind: 'any' } as CType }, resolveType(p.type, info.importAlias)),
        );
        const callArgs = argCodes.join(', ');
        const receiver = `(${cname}*)_this`;
        const call = `${cname}_${mname}(${receiver}${callArgs ? ', ' + callArgs : ''})`;
        this.line(`as_value ${cname}_${mname}__dyn(void* _this, as_value* args, int argc) {`);
        this.indent++;
        this.line('(void)argc;');
        if (m.params.length === 0) this.line('(void)args;');
        if (m.returnType.kind === 'void') {
          this.line(`${call};`);
          this.line('return as_v_null();');
        } else {
          this.line(`return ${this.boxExpr({ code: call, type: m.returnType })};`);
        }
        this.indent--;
        this.line('}');
        this.line('');
        any = true;
      }
    }
    if (any) this.line('');
  }

  private emitMethodTables(): void {
    let any = false;
    for (const [name, info] of this.symbols.classes) {
      if (!this.hasOwnMethods(name)) continue;
      this.line(`static as_method ${name}_methods[] = {`);
      this.indent++;
      for (const [mname, m] of info.methods) {
        if (m.owner !== name) continue;
        this.line(`{ "${this.escapeCString(mname)}", ${name}_${mname}__dyn },`);
      }
      this.line('{ NULL, NULL }');
      this.indent--;
      this.line('};');
      any = true;
    }
    if (any) this.line('');
  }

  // Per-class getter reflection thunks: a boxed calling thunk per OWN getter.
  // The thunk shares the as_method signature (void* _this, as_value* args, argc)
  // so the getter table reuses the as_method type; it ignores args/argc, calls
  // the typed getter implementation, and boxes its return value. Inherited
  // getters are reached by walking the vtable super chain in as_dyn_get.
  private emitGetterThunks(): void {
    let any = false;
    for (const [cname, info] of this.symbols.classes) {
      for (const [gname, g] of info.getters) {
        if (g.owner !== cname) continue;
        this.line(`as_value ${cname}_get_${gname}__dyn(void* _this, as_value* args, int argc) {`);
        this.indent++;
        this.line('(void)args; (void)argc;');
        this.line(`return ${this.boxExpr({ code: `${cname}_get_${gname}(_this)`, type: g.returnType })};`);
        this.indent--;
        this.line('}');
        this.line('');
        any = true;
      }
    }
    if (any) this.line('');
  }

  // Per-class setter reflection thunks: a boxed calling thunk per OWN setter, with
  // the same as_method signature as the getter thunks. as_dyn_set uses these to
  // forward a dynamic write (`obj[key] = v`) to the setter implementation;
  // inherited setters are reached by walking the vtable super chain.
  private emitSetterThunks(): void {
    let any = false;
    for (const [cname, info] of this.symbols.classes) {
      for (const [sname, s] of info.setters) {
        if (s.owner !== cname) continue;
        const paramType = resolveType(s.params[0].type, info.importAlias);
        this.line(`as_value ${cname}_set_${sname}__dyn(void* _this, as_value* args, int argc) {`);
        this.indent++;
        this.line('(void)argc;');
        this.line(`${cname}_set_${sname}(_this, ${this.unboxAny({ code: 'args[0]', type: { kind: 'any' } as CType }, paramType)});`);
        this.line('return as_v_null();');
        this.indent--;
        this.line('}');
        this.line('');
        any = true;
      }
    }
    if (any) this.line('');
  }

  // Per-class setter reflection tables: a NULL-terminated as_method[] mapping each
  // OWN setter name to its thunk.
  private emitSetterTables(): void {
    let any = false;
    for (const [name, info] of this.symbols.classes) {
      if (!this.hasOwnSetters(name)) continue;
      this.line(`static as_method ${name}_setters[] = {`);
      this.indent++;
      for (const [sname, s] of info.setters) {
        if (s.owner !== name) continue;
        this.line(`{ "${this.escapeCString(sname)}", ${name}_set_${sname}__dyn },`);
      }
      this.line('{ NULL, NULL }');
      this.indent--;
      this.line('};');
      any = true;
    }
    if (any) this.line('');
  }

  // Per-class getter reflection tables: a NULL-terminated as_method[] (getter
  // thunks reuse the as_method type) mapping each OWN getter name to its thunk.
  private emitGetterTables(): void {
    let any = false;
    for (const [name, info] of this.symbols.classes) {
      if (!this.hasOwnGetters(name)) continue;
      this.line(`static as_method ${name}_getters[] = {`);
      this.indent++;
      for (const [gname, g] of info.getters) {
        if (g.owner !== name) continue;
        this.line(`{ "${this.escapeCString(gname)}", ${name}_get_${gname}__dyn },`);
      }
      this.line('{ NULL, NULL }');
      this.indent--;
      this.line('};');
      any = true;
    }
    if (any) this.line('');
  }

  // Per-class, per-interface vtable instance wiring each interface method to
  // the class's implementation, plus the class's interface-vtable pointer array
  // (used by as_iface_lookup for runtime `any -> interface` recovery).
  private emitInterfaceVtables(): void {
    let any = false;
    for (const [cname, cinfo] of this.symbols.classes) {
      if (cinfo.implements.length === 0) continue;
      const ifaceEntries: string[] = [];
      for (const iname of cinfo.implements) {
        const intf = this.symbols.interfaces.get(iname)!;
        const entries: string[] = [`"${iname}"`, 'NULL', 'NULL', 'NULL', 'NULL'];
        for (const mname of intf.methods.keys()) {
          const im = intf.methods.get(mname)!;
          if (im.isGetter) {
            const g = cinfo.getters.get(mname)!;
            entries.push(`${g.owner}_get_${mname}`);
          } else if (im.isSetter) {
            const s = cinfo.setters.get(mname)!;
            entries.push(`${s.owner}_set_${mname}`);
          } else {
            const m = cinfo.methods.get(mname)!;
            entries.push(`${m.owner}_${mname}`);
          }
        }
        this.line(`static ${iname}_vtable ${cname}_${iname}_vt = { ${entries.join(', ')} };`);
        ifaceEntries.push(`(void*)&${cname}_${iname}_vt`);
      }
      ifaceEntries.push('NULL');
      this.line(`static void* ${cname}_ifaces[] = { ${ifaceEntries.join(', ')} };`);
      any = true;
    }
    if (any) this.line('');
  }

  // Static/const fields live at class scope as file-scope globals named
  // Class_field. Const fields are emitted as C `const` (compile-time constants).
  // Non-const static fields with a runtime initializer (object/array/function
  // literals, `new X()`, ...) are declared with a default and initialized in
  // main() in class-declaration order — C forbids non-constant static init.
  private emitStaticFields(): void {
    this.staticFieldInits = [];
    for (const [cname, info] of this.symbols.classes) {
      for (const [fname, f] of info.staticFields) {
        if (f.owner !== cname) continue;
        this.currentClass = cname;
        if (f.isConst && this.isConstExpr(f.init)) {
          const init = f.init ? this.convert(this.emitExpr(f.init), f.type) : this.defaultInit(f.type);
          this.line(`static ${this.constTypeName(f.type)} ${cname}_${fname} = ${init};`);
        } else {
          // Mutable static slot with a default; the initializer (when present)
          // runs in main(). This covers both non-const fields and AS3 `const`
          // fields whose initializer needs runtime evaluation (e.g.
          // `static const Dictionary = new Dictionary()` or a RegExp literal) —
          // C's `static const` demands a compile-time constant, so such a slot is
          // declared non-const and written once before any use.
          this.line(`static ${this.cTypeName(f.type)} ${cname}_${fname} = ${this.defaultInit(f.type)};`);
          if (f.init) {
            this.staticFieldInits.push({ cname, fname, f });
            this.cinitClasses.add(cname);
          }
        }
        this.currentClass = null;
      }
    }
    if (this.symbols.classes.size > 0) this.line('');
  }

  // True when `e` is a C compile-time constant expression (safe as a `static
  // const` initializer). Only literal leaves qualify: object/array/dict/regexp/
  // function literals, `new X()`, calls and string concatenation all compile to
  // runtime calls and therefore need main()-time initialization.
  private isConstExpr(e: Expr | null): boolean {
    if (e === null) return false;
    switch (e.kind) {
      case 'Num': case 'Str': case 'Bool': case 'Null': return true;
      default: return false;
    }
  }

  // GC permanent user roots (stage 57): emit gc_mark_user_roots(), which marks
  // every global/static slot that can hold a GC pointer — the window stage, the
  // ENTER_FRAME registry, and all non-const static fields / module variables.
  // gc_mark_roots() calls this from both gc_step() (incremental) and gc_collect().
  // Emit a C wrapper for each [WasmExport("alias")] export whose JS-facing name
  // differs from its C symbol (e.g. `foo_Calc_twice` exported as `twice`). The
  // wrapper keeps the exact resolved signature so the exported alias is a plain
  // callable function. Exports without an alias need no wrapper — the symbol is
  // exported directly under its own name.
  private emitExportWrappers(): void {
    for (const e of this.symbols.exports) {
      if (!e.alias) continue;
      const params = e.params.map((p) => `${this.cTypeName(p.type)} ${p.name}`).join(', ');
      const argNames = e.params.map((p) => p.name).join(', ');
      const ret = this.cTypeName(e.returnType);
      this.line(`// [WasmExport("${e.alias}")] alias for ${e.symbol}.`);
      if (ret === 'void') {
        this.line(`void ${e.alias}(${params}) { ${e.symbol}(${argNames}); }`);
      } else {
        this.line(`${ret} ${e.alias}(${params}) { return ${e.symbol}(${argNames}); }`);
      }
      this.line('');
    }
  }

  private emitGCRoots(): void {
    this.line('// GC permanent user roots: window stage, ENTER_FRAME registry, and all');
    this.line('// pointer/boxed static fields and module variables. Called by gc_collect.');
    this.line('static void gc_mark_user_roots(void) {');
    this.indent++;
    this.line('gc_mark_ptr((void*)ASC_win_stage);');
    this.line('gc_mark_ptr((void*)ASC_native_app);');
    // flash.net.URLRequestDefaults.userAgent is a settable static String, so it can
    // hold a GC string after `URLRequestDefaults.userAgent = ...`. (The other six
    // URLRequestDefaults members are bool/Number and cannot hold a pointer.)
    this.line('gc_mark_ptr((void*)as_urld_user_agent);');
    this.line('for (int i = 0; i < as_ef_count; i++) gc_mark_ptr(as_ef_objs[i]);');
    for (const [cname, info] of this.symbols.classes) {
      for (const [fname, f] of info.staticFields) {
        if (f.owner !== cname) continue;
        if (f.isConst && this.isConstExpr(f.init)) continue; // compile-time literal const, never a GC object
        const m = this.gcMarkExpr(`${cname}_${fname}`, f.type);
        if (m) this.line(m);
      }
    }
    for (const [name, ctype] of this.moduleScope) {
      const m = this.gcMarkExpr(this.moduleCName(name), ctype);
      if (m) this.line(m);
    }
    this.indent--;
    this.line('}');
    this.line('');
  }

  // Emit the gc_mark_* call for a C identifier of the given type, or null when
  // the slot cannot hold a GC pointer. 'any' boxes to as_value; interfaces are
  // reference structs whose .obj field is the live object pointer; the remaining
  // pointer kinds (string/object/array/vector/record/function/class/dict/regexp)
  // are followed directly.
  private gcMarkExpr(name: string, t: CType): string | null {
    if (t.kind === 'any') return `gc_mark_value(${name});`;
    if (t.kind === 'interface') return `gc_mark_ptr((void*)${name}.obj);`;
    return this.gcPtrKind(t) ? `gc_mark_ptr((void*)${name});` : null;
  }

  // Whether a CType is a raw pointer kind that gc_mark_ptr can follow directly
  // (string / object / array / vector / record / function / class / dict /
  // regexp). Interfaces are value structs and 'any' boxes to as_value, so both
  // are handled separately. Value kinds are no-ops.
  private gcPtrKind(t: CType): boolean {
    switch (t.kind) {
      case 'string':
      case 'object':
      case 'array':
      case 'vector':
      case 'record':
      case 'function':
      case 'class':
      case 'dict':
      case 'regexp':
      case 'xml':
      case 'xmllist':
        return true;
      default:
        return false;
    }
  }

  // Emit a write-barrier assignment (GC-4) for a C lvalue of the given type, or
  // null when the slot cannot hold a GC pointer. The returned comma expression
  // assigns the value, runs the insertion barrier, and re-reads the slot so
  // `x = (o.f = v)` keeps its AS3 value semantics. Statement-position emission
  // wraps the result in (void) to silence -Wunused-value (see the ExprStmt case).
  private gcWriteAssign(lvalue: string, t: CType, value: string): string | null {
    if (t.kind === 'any') return `(${lvalue} = ${value}, gc_write_barrier_value(${lvalue}), ${lvalue})`;
    if (t.kind === 'interface') return `(${lvalue} = ${value}, gc_write_barrier((void*)${lvalue}.obj), ${lvalue})`;
    return this.gcPtrKind(t) ? `(${lvalue} = ${value}, gc_write_barrier((void*)${lvalue}), ${lvalue})` : null;
  }

  // ---------- function values ----------

  // Pre-scan the AST for anonymous function expressions so their typed bodies
  // and calling thunks can be emitted at file scope before any function/method
  // body that references them. Names are stable via object identity.
  private collectFunctionValues(): void {
    this.anonFuncs = [];
    this.anonIndex.clear();
    this.anonSeq = 0;
    this.anonCaptures.clear();
    this.funcVars = [new Map()];
    this.scriptVarNames = collectScriptVars(this.program.body);
    this.currentAnonLocal = null;
    this.currentAnonRefs = null;
    this.walkFnBodyStack = [];
    this.walkFnBody = null;
    this.fnBodyParent.clear();
    this.fnBodyVars.clear();
    this.fnBodyKids.clear();
    this.fnBodyClass.clear();
    this.fnBodyCells.clear();
    this.closureCellEnv.clear();
    this.walkStmts(this.program.body);
    this.funcVars = [];
    // Decide the activation cells once every closure's captures are known.
    this.buildVarCells();
  }

  private walkStmts(stmts: Stmt[]): void {
    for (const s of stmts) this.walkStmt(s);
  }

  private walkParams(params: Param[]): void {
    for (const p of params) {
      this.noteType(p.type);
      if (p.defaultValue) this.walkExpr(p.defaultValue);
    }
  }

  private lookupFuncVar(name: string): CType | undefined {
    for (let i = this.funcVars.length - 1; i >= 0; i--) {
      const t = this.funcVars[i].get(name);
      if (t) return t;
    }
    return undefined;
  }

  // Free-variable capture lookup: like `lookupFuncVar`, but a name that the
  // module (top-level script) scope owns resolves to its C global instead of being
  // captured. `scriptVarNames` mirrors exactly the declarations `emitModuleVars`
  // hoists into `moduleScope`, so a name is either a global or a captured local —
  // never both. A top-level `var` captured by value froze at closure-creation time
  // (a closure assigning it wrote its own env copy; see
  // examples/reg-closure-ref.as case 1). Names that stay outside `moduleScope`
  // (e.g. a top-level `for (var i…)`) keep the legacy by-value capture.
  private lookupCaptureVar(name: string): CType | undefined {
    for (let i = this.funcVars.length - 1; i >= 1; i--) {
      const t = this.funcVars[i].get(name);
      if (t) return t;
    }
    if (this.scriptVarNames.has(name)) return undefined;
    return this.funcVars[0].get(name);
  }

  // Best-effort static type of an expression during the walk (pass 1). Used only
  // to record bound-method thunks for `obj.member.method` shapes (e.g.
  // `painter.context.drawToBitmapData`), where the receiver is a getter result
  // rather than a simple local. Returns null when the type cannot be pinned down
  // statically; the emit pass still handles the full resolution.
  private walkInferType(e: Expr): CType | null {
    switch (e.kind) {
      case 'Var': {
        const t = this.lookupFuncVar(e.name);
        if (t) return t;
        if (e.name === 'this' && this.currentWalkClass) {
          return { kind: 'object', className: this.currentWalkClass };
        }
        if (this.currentWalkClass) {
          const cinfo = this.symbols.getClass(this.currentWalkClass);
          const f = this.symbols.fieldSlot(this.currentWalkClass, e.name);
          if (f) return f.type;
          const g = cinfo?.getters.get(e.name);
          if (g) return g.returnType;
          const sg = cinfo?.staticGetters?.get(e.name);
          if (sg) return sg.returnType;
          const sf = cinfo?.staticFields.get(e.name);
          if (sf) return sf.type;
        }
        return null;
      }
      case 'Member': {
        const ot = this.walkInferType(e.object);
        if (ot?.kind === 'object') {
          const cinfo = this.symbols.getClass(ot.className);
          const f = this.symbols.fieldSlot(ot.className, e.property);
          if (f) return f.type;
          const g = cinfo?.getters.get(e.property);
          if (g) return g.returnType;
        } else if (ot?.kind === 'interface') {
          const iinfo = this.symbols.interfaces.get(ot.name);
          const im = iinfo?.methods.get(e.property);
          if (im) return im.returnType;
        }
        return null;
      }
      default:
        return null;
    }
  }

  // Look up a name in every frame strictly below `local` (the enclosing scopes of
  // the function currently being analyzed). Used for free-variable capture: a
  // closure may reference variables any number of lexical levels up (not just the
  // immediately enclosing function), so the analysis must walk the whole chain.
  // Module-scope names are resolved as C globals, not captured (see
  // `lookupCaptureVar`).
  private lookupEnclosingVar(name: string, local: Map<string, CType>): CType | undefined {
    const idx = this.funcVars.lastIndexOf(local);
    for (let i = idx - 1; i >= 1; i--) {
      const t = this.funcVars[i].get(name);
      if (t) return t;
    }
    if (this.scriptVarNames.has(name)) return undefined;
    return this.funcVars[0].get(name);
  }

  // A closure nested inside the one currently being analyzed may itself capture a
  // variable that lives several scopes up (e.g. `texture` referenced by the
  // innermost closure of a 3-deep nest). The inner closure's environment is built
  // at the point where it is *created* (inside the outer closure's body), so the
  // outer closure must transitively capture that variable into its own env too —
  // otherwise emit-time `emitVar('texture')` for the inner env finds nothing.
  private propagateNestedCaptures(local: Map<string, CType>, seen: Map<string, CType>, nestedStart: number): void {
    const nested = [...this.anonCaptures.values()].slice(nestedStart);
    for (const caps of nested) {
      for (const c of caps) {
        // `this` is not a lexical variable, so a nested closure that captured it
        // must cause THIS closure to capture it too — its body constructs the
        // nested closure's env (`_fn41_env_make(..., this)`) and therefore needs
        // the receiver in scope.
        if (c.name === 'this') {
          if (this.currentWalkClass && !this.currentWalkIsStatic) this.currentAnonNeedsThis = true;
          continue;
        }
        if (!local.has(c.name) && !seen.has(c.name) && this.lookupEnclosingVar(c.name, local)) {
          seen.set(c.name, c.type);
        }
      }
    }
  }

  // Sibling nested functions declared in the SAME method share one lexical scope
  // in AS3. When one references another (`onIoError` calls `cleanup`, which reads
  // `loaderInfo`), the referenced function's captured variables must also be
  // visible while building the referencing function's env — otherwise emitVar
  // throws `undefined variable`. Merge every sibling's captures into one shared
  // set and assign it uniformly (redundant fields are harmless; correctness
  // requires that no referenced variable is missing).
  private mergeNestedGroup(groupStart: number): void {
    const group = this.anonFuncs.slice(groupStart);
    if (group.length === 0) return;
    // Merge only the OUTERMOST sibling functions in this method (same minimum
    // depth). A nested function and its inner anonymous function are NOT merged —
    // the inner closure's free variables are locals of the outer function, which
    // must resolve through the outer function's own scope, not its env.
    const minDepth = Math.min(...group.map((f) => f.depth));
    const siblings = group.filter((f) => f.depth === minDepth);
    if (siblings.length <= 1) return;
    // AS3 names of the outermost siblings. A function-typed capture is a
    // *sibling reference* only when its name matches one of these (e.g.
    // `onLoadError` inside `onLoadComplete`). A function-typed capture of a
    // parameter/local (`onComplete:Function`) is a plain value capture, NOT a
    // sibling reference — it must stay in the env as a normal `as_fn` field.
    const siblingAsNames = new Set<string>();
    for (const fn of siblings) {
      const nf = this.nestedFuncs.get(fn.name);
      if (nf) siblingAsNames.add(nf.asName);
    }
    const isSiblingRef = (c: { name: string; type: CType }) => c.type.kind === 'function' && siblingAsNames.has(c.name);
    const hasSiblingRef = siblings.some((fn) => fn.captures.some((c) => isSiblingRef(c)));

    if (hasSiblingRef) {
      // Mutually-recursive sibling group: share a single cell holding one `as_fn`
      // slot per sibling plus the merged plain captures (variables / objects /
      // `this` AND function-typed params). Each sibling's impl takes the cell as
      // its environment, so a reference to a sibling function reads `env->member`
      // (shared identity — required for removeEventListener's `listener === handler`
      // match) and every variable read hits the same captured value. Inlining each
      // sibling's `as_fn_make(...)` at its use site (the old model) exploded into an
      // N-deep cross-product and, for cycles, fell back to NULL via buildingClosures,
      // causing a listener->fn NULL deref.
      const plainCaps: { name: string; type: CType }[] = [];
      const seen = new Set<string>();
      for (const fn of siblings) for (const c of fn.captures) {
        if (isSiblingRef(c)) continue;
        if (!seen.has(c.name)) { seen.add(c.name); plainCaps.push(c); }
      }
      const idx = this.anonSeq++;
      const cellName = `_cell${idx}`;
      const cellLocal = `cell${idx}`;
      const members = siblings.map((f) => f.name);
      const memberSlots = members.map((m) => ({ name: m, type: { kind: 'function' } as CType }));
      const captures = [...memberSlots, ...plainCaps];
      for (const fn of siblings) fn.captures = captures;
      const info = { cellName, cellLocal, members, varCaps: plainCaps };
      for (const fn of siblings) this.closureGroups.set(fn.name, info);
      const methodKey = `${this.currentWalkClass ?? ''}:${this.currentWalkMethod ?? ''}`;
      const list = this.closureGroupsByMethod.get(methodKey) ?? [];
      list.push(info);
      this.closureGroupsByMethod.set(methodKey, list);
    } else {
      // No sibling references another sibling as a function value. Keep the old
      // model: each fn keeps its own function-typed captures (params/locals like
      // `onComplete:Function`) and shares only the non-function captures. (This
      // avoids forcing every sibling to capture a param only one of them uses.)
      const mergedVars = new Map<string, CType>();
      for (const fn of siblings) for (const c of fn.captures) {
        if (c.type.kind !== 'function' && !mergedVars.has(c.name)) mergedVars.set(c.name, c.type);
      }
      const mergedVarCaps = [...mergedVars.entries()].map(([name, type]) => ({ name, type }));
      for (const fn of siblings) {
        const ownFuncs = fn.captures.filter((c) => c.type.kind === 'function');
        fn.captures = [...ownFuncs, ...mergedVarCaps];
      }
    }
    for (const fn of siblings) {
      const nf = this.nestedFuncs.get(fn.name);
      if (nf) nf.captures = fn.captures;
    }
    // Sync the merged captures back into `anonCaptures` (keyed by the FunctionExpr
    // AST node). `emitFunctionValues` builds the env struct / make signature from
    // `fn.captures`, but the make CALL SITE in `emitExpr` reads `anonCaptures.get(expr)`;
    // without this sync the env struct gains merged fields while the call passes only
    // the original ones (`_fn1_env_make(this)` vs `_fn1_env_make(scaleFactor, this)`).
    for (const fn of siblings) {
      for (const [expr, name] of this.anonIndex) {
        if (name === fn.name) this.anonCaptures.set(expr, fn.captures);
      }
    }
  }

  // Pre-scan a function body for every `var`/`const`/loop-variable declaration and
  // register it in the current funcVars frame BEFORE walking the body. AS3's `var`
  // is function-scoped (hoisted), so a `var texture` declared *after* a closure
  // that references `texture` must still be captured by that closure — a plain
  // sequential walk would miss it.
  private collectWalkFuncVars(stmts: Stmt[]): void {
    for (const s of stmts) this.collectWalkFuncVarsStmt(s);
  }
  private collectWalkFuncVarsStmt(s: Stmt): void {
    const frame = this.funcVars[this.funcVars.length - 1];
    switch (s.kind) {
      case 'VarDecl': frame.set(s.name, this.rt(s.type)); break;
      case 'VarDecls': for (const d of s.decls) frame.set(d.name, this.rt(d.type)); break;
      case 'ConstDecl': frame.set(s.name, this.rt(s.type)); break;
      case 'ConstDecls': for (const d of s.decls) frame.set(d.name, this.rt(d.type)); break;
      case 'Block': this.collectWalkFuncVars(s.body); break;
      case 'If': this.collectWalkFuncVarsStmt(s.then); if (s.else) this.collectWalkFuncVarsStmt(s.else); break;
      case 'While': this.collectWalkFuncVarsStmt(s.body); break;
      case 'DoWhile': this.collectWalkFuncVarsStmt(s.body); break;
      case 'For': if (s.init) this.collectWalkFuncVarsStmt(s.init); this.collectWalkFuncVarsStmt(s.body); break;
      case 'ForIn': if (s.declares) frame.set(s.varName, { kind: 'string' }); this.collectWalkFuncVarsStmt(s.body); break;
      case 'ForEachIn': if (s.declares) frame.set(s.varName, s.varType === null ? { kind: 'any' } : this.rt(s.varType)); this.collectWalkFuncVarsStmt(s.body); break;
      case 'Switch': for (const c of s.cases) this.collectWalkFuncVars(c.body); break;
      case 'Try':
        this.collectWalkFuncVars(s.tryBody.body);
        if (s.catchBody) this.collectWalkFuncVars(s.catchBody.body);
        if (s.finallyBody) this.collectWalkFuncVars(s.finallyBody.body);
        break;
      case 'Label': this.collectWalkFuncVarsStmt(s.body); break;
      // A nested function declaration's name is hoisted into the enclosing
      // function scope (usable as a value), but its body has its own scope.
      case 'FuncDecl': frame.set(s.name, { kind: 'function' }); break;
      // Nested class declarations have their own scope: do not descend.
      default: break;
    }
  }

  // ---------- closure activation cells (capture by reference) ----------

  private noteFnBodyVar(name: string, type: CType): void {
    const b = this.walkFnBody;
    if (b === null) return;
    let m = this.fnBodyVars.get(b);
    if (!m) {
      m = new Map();
      this.fnBodyVars.set(b, m);
    }
    m.set(name, type);
  }

  // Push a real function body (method / free function / nested function or
  // anonymous function). The top-level script body is deliberately NOT pushed:
  // its vars are module globals, which already have stable shared storage.
  private pushWalkFnBody(body: Stmt[]): void {
    this.fnBodyParent.set(body, this.walkFnBody);
    this.fnBodyClass.set(body, this.currentWalkClass);
    this.walkFnBody = body;
    this.walkFnBodyStack.push(body);
  }

  private popWalkFnBody(): void {
    this.walkFnBodyStack.pop();
    this.walkFnBody = this.walkFnBodyStack[this.walkFnBodyStack.length - 1] ?? null;
  }

  private addFnBodyKid(parentBody: Stmt[] | null, closureName: string): void {
    if (parentBody === null) return;
    const kids = this.fnBodyKids.get(parentBody) ?? [];
    kids.push(closureName);
    this.fnBodyKids.set(parentBody, kids);
  }

  // Post-walk analysis: decide which function bodies need an activation cell and
  // how every closure reaches the cells it uses.
  private buildVarCells(): void {
    // A name already owned by a sibling group's cell keeps that storage; boxing it
    // twice would split the two views (the group cell is the env of its members).
    // The check must be per *function body*: the same source-level name (`texture`)
    // belongs to different functions at different scopes, so a group elsewhere in
    // the program must not veto this body's own cell.
    const byName = new Map(this.anonFuncs.map((f) => [f.name, f]));
    const bodyGroupOwned = (body: Stmt[]): Set<string> => {
      const owned = new Set<string>();
      for (const kid of this.fnBodyKids.get(body) ?? []) {
        const g = this.closureGroups.get(kid);
        if (g) for (const c of g.varCaps) owned.add(c.name);
      }
      return owned;
    };
    const ownerCell = (from: Stmt[] | null, name: string): Stmt[] | null => {
      for (let b = from; b !== null; b = this.fnBodyParent.get(b) ?? null) {
        const c = this.fnBodyCells.get(b);
        if (c && c.varCaps.some((f) => f.name === name)) return b;
      }
      return null;
    };

    // Pass A — create a cell per function body whose typed locals are captured by a
    // closure created directly in that body. Locals captured only by a deeper
    // closure are reached by threading the cell pointer through the levels between.
    for (const body of [...this.fnBodyVars.keys()]) {
      const vars = this.fnBodyVars.get(body)!;
      const groupOwned = bodyGroupOwned(body);
      const fields: { name: string; type: CType }[] = [];
      const seen = new Set<string>();
      for (const kid of this.fnBodyKids.get(body) ?? []) {
        if (this.closureGroups.has(kid)) continue;
        const fn = byName.get(kid);
        if (!fn) continue;
        for (const c of fn.captures) {
          if (c.name === 'this' || seen.has(c.name)) continue;
          if (groupOwned.has(c.name)) continue;
          if (!vars.has(c.name)) continue;
          seen.add(c.name);
          fields.push({ name: c.name, type: vars.get(c.name)! });
        }
      }
      if (fields.length === 0) continue;
      const idx = this.anonSeq++;
      this.fnBodyCells.set(body, { cellName: `_cell${idx}`, cellLocal: `cell${idx}`, members: [], varCaps: fields });
    }

    // Pass B — per closure, map the captures that resolve through a cell and collect
    // the cell pointers its env must carry (its own needs plus every descendant's,
    // so the pointer can be threaded down at each nested creation site).
    // `anonFuncs` is in post-order, so descendants are always handled first.
    const neededByFn = new Map<string, Set<Stmt[]>>();
    for (const fn of this.anonFuncs) {
      const info: { resolve: Map<string, string>; ptrs: { cellLocal: string; cellName: string }[] } = { resolve: new Map(), ptrs: [] };
      this.closureCellEnv.set(fn.name, info);
      // A sibling-group member's env IS the group cell (it already holds those
      // captures as fields), so it must not be re-routed through another cell.
      if (this.closureGroups.has(fn.name)) continue;
      const createdIn = this.fnBodyParent.get(fn.body.body) ?? null;
      const needed = new Set<Stmt[]>();
      for (const c of fn.captures) {
        const cellBody = ownerCell(createdIn, c.name);
        if (cellBody === null) continue;
        info.resolve.set(c.name, this.fnBodyCells.get(cellBody)!.cellLocal);
        needed.add(cellBody);
      }
      for (const kid of this.fnBodyKids.get(fn.body.body) ?? []) {
        for (const b of neededByFn.get(kid) ?? []) needed.add(b);
      }
      neededByFn.set(fn.name, needed);
      const own = this.fnBodyCells.get(fn.body.body);
      for (const b of needed) {
        const cell = this.fnBodyCells.get(b)!;
        if (own && own.cellName === cell.cellName) continue;
        info.ptrs.push({ cellLocal: cell.cellLocal, cellName: cell.cellName });
      }
    }

    // Pass C — inject the cell-pointer captures into each closure's capture list.
    // The env struct / make signature / creation site are all driven by that list,
    // so the pointer is then produced by the ordinary `emitVar(cellLocal)` path
    // (the enclosing body's cell local, or `env->cellLocal` one level in).
    for (const fn of this.anonFuncs) {
      if (this.closureGroups.has(fn.name)) continue;
      const info = this.closureCellEnv.get(fn.name)!;
      if (info.ptrs.length === 0) continue;
      const extra = info.ptrs.map((p) => ({ name: p.cellLocal, type: { kind: 'object', className: p.cellName } as CType }));
      fn.captures = fn.captures.concat(extra);
      const nf = this.nestedFuncs.get(fn.name);
      if (nf) nf.captures = nf.captures.concat(extra);
      for (const [expr, name] of this.anonIndex) {
        if (name === fn.name) this.anonCaptures.set(expr, fn.captures);
      }
    }
  }

  private walkStmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': {
        const vt = this.rt(s.type);
        this.funcVars[this.funcVars.length - 1].set(s.name, vt);
        if (this.currentAnonLocal) this.currentAnonLocal.set(s.name, vt);
        // Typed locals are the ones `hoistFunctionLocals` hoists, so they are the
        // only candidates for activation-cell storage (see fnBodyVars).
        if (s.type !== null) this.noteFnBodyVar(s.name, vt);
        this.noteType(s.type);
        if (s.init) this.walkExpr(s.init);
        break;
      }
      case 'VarDecls': {
        for (const d of s.decls) {
          const vt = this.rt(d.type);
          this.funcVars[this.funcVars.length - 1].set(d.name, vt);
          if (this.currentAnonLocal) this.currentAnonLocal.set(d.name, vt);
          if (d.type !== null) this.noteFnBodyVar(d.name, vt);
          this.noteType(d.type);
          if (d.init) this.walkExpr(d.init);
        }
        break;
      }
      // `const` locals are deliberately NOT registered as activation-cell
      // candidates (no `noteFnBodyVar`): AS3 `const` is an immutable binding, so
      // capturing it *by value* is semantically identical to capturing it by
      // reference -- and it must not become a cell field. Cell fields are written
      // by the declaring body through `cell->field`, but `const` is block-scoped
      // and never hoisted (see `collectHoistedVarsStmt`), so the declaring body has
      // no such write to make. Registering it only in `fnBodyVars` therefore made
      // `buildVarCells` allocate a cell field that stayed NULL (gc_alloc zeroes the
      // struct) while every closure in the body read `env->cellN->name` -> SIGSEGV
      // on the first dereference (Demo's CustomHitTestScene `const texts`).
      case 'ConstDecl': {
        const vt = this.rt(s.type);
        this.funcVars[this.funcVars.length - 1].set(s.name, vt);
        if (this.currentAnonLocal) this.currentAnonLocal.set(s.name, vt);
        this.noteType(s.type);
        this.walkExpr(s.init!);
        break;
      }
      case 'ConstDecls': {
        for (const d of s.decls) {
          const vt = this.rt(d.type);
          this.funcVars[this.funcVars.length - 1].set(d.name, vt);
          if (this.currentAnonLocal) this.currentAnonLocal.set(d.name, vt);
          this.noteType(d.type);
          if (d.init) this.walkExpr(d.init);
        }
        break;
      }
      case 'ExprStmt': this.walkExpr(s.expr); break;
      case 'Block': this.walkStmts(s.body); break;
      case 'If': this.walkExpr(s.cond); this.walkStmt(s.then); if (s.else) this.walkStmt(s.else); break;
      case 'While': this.walkExpr(s.cond); this.walkStmt(s.body); break;
      case 'DoWhile': this.walkStmt(s.body); this.walkExpr(s.cond); break;
      case 'For': if (s.init) this.walkStmt(s.init); if (s.cond) this.walkExpr(s.cond); if (s.update) this.walkExpr(s.update); this.walkStmt(s.body); break;
      case 'ForIn': this.walkExpr(s.iterable); this.walkStmt(s.body); break;
      case 'ForEachIn': this.noteType(s.varType); this.walkExpr(s.iterable); this.walkStmt(s.body); break;
      case 'Switch': this.walkExpr(s.disc); for (const c of s.cases) { if (c.test) this.walkExpr(c.test); this.walkStmts(c.body); } break;
      case 'Return': if (s.value) this.walkExpr(s.value); break;
      case 'SuperCall': for (const a of s.args) this.walkExpr(a); break;
      case 'Throw': this.walkExpr(s.value); break;
      case 'Try': this.noteType(s.catchType); this.walkStmts(s.tryBody.body); if (s.catchBody) this.walkStmts(s.catchBody.body); if (s.finallyBody) this.walkStmts(s.finallyBody.body); break;
      case 'FuncDecl': {
        this.noteType(s.returnType);
        if (this.funcVars.length === 1) {
          // Top-level free function: no enclosing lexical scope to capture.
          this.funcVars.push(new Map(s.params.map((p) => [p.name, this.rt(p.type)])));
          this.walkParams(s.params);
          this.collectWalkFuncVars(s.body.body);
          this.pushWalkFnBody(s.body.body);
          const groupStart = this.anonFuncs.length;
          this.walkStmts(s.body.body);
          this.mergeNestedGroup(groupStart);
          this.popWalkFnBody();
          this.funcVars.pop();
        } else {
          // Nested function declaration: a named closure. Register its name in the
          // enclosing scope (AS3 hoists it), then run the same free-variable
          // analysis as an anonymous FunctionExpr so it captures enclosing vars.
          const name = s.name;
          const depth = this.funcVars.length;
          this.funcVars[this.funcVars.length - 1].set(name, { kind: 'function' });
          this.funcVars.push(new Map(s.params.map((p) => [p.name, this.rt(p.type)])));
          const local = this.funcVars[this.funcVars.length - 1];
          const savedLocal = this.currentAnonLocal;
          const savedRefs = this.currentAnonRefs;
          const savedNeedsThis = this.currentAnonNeedsThis;
          this.currentAnonLocal = local;
          this.currentAnonRefs = [];
          this.currentAnonNeedsThis = false;
          this.walkParams(s.params);
          this.collectWalkFuncVars(s.body.body);
          const nestedStart = this.anonCaptures.size;
          const parentBody = this.walkFnBody;
          this.pushWalkFnBody(s.body.body);
          this.walkStmts(s.body.body);
          this.popWalkFnBody();
          const seen = new Map<string, CType>();
          for (const r of this.currentAnonRefs) {
            // A recursive nested function references its own name (`setTimeout(fn, 1)`);
            // that is NOT a capture — the name is the function itself, resolved at emit
            // time to a self-referential closure, not stored in its own env.
            if (r.name === name) continue;
            if (!local.has(r.name) && this.lookupEnclosingVar(r.name, local)) seen.set(r.name, r.type);
          }
          this.propagateNestedCaptures(local, seen, nestedStart);
          if (this.currentAnonNeedsThis && this.currentWalkClass && !this.currentWalkIsStatic) {
            seen.set('this', { kind: 'object', className: this.currentWalkClass } as CType);
          }
          const captures = [...seen.entries()].map(([n, t]) => ({ name: n, type: t }));
          this.currentAnonLocal = savedLocal;
          this.currentAnonRefs = savedRefs;
          this.currentAnonNeedsThis = savedNeedsThis;
          // Globally-unique C name: a bare function name is function-scoped in AS3,
          // so two different classes (or two methods in one class) may each declare
          // a `function onLoadComplete()`. Keying nestedFuncs / anonFuncs by the bare
          // name would overwrite the earlier record and collide in C. The unique name
          // is what emitVar resolves through nestedFuncByAsName.
          const uniqueName = `_nf${this.anonSeq++}`;
          const methodName = this.currentWalkMethod;
          this.nestedFuncs.set(uniqueName, { captures, params: s.params, asName: name, methodName });
          this.nestedFuncByAsName.set(`${this.currentWalkClass ?? ''}:${methodName ?? ''}:${name}`, uniqueName);
          this.anonFuncs.push({ name: uniqueName, asName: null, params: s.params, returnType: s.returnType, body: s.body, captures, cname: this.currentWalkClass, isStatic: this.currentWalkIsStatic, depth, methodName });
          this.addFnBodyKid(parentBody, uniqueName);
          this.funcVars.pop();
        }
        break;
      }
      case 'ClassDecl': {
        const cname = qualifiedName(s.name, s.packageName);
        for (const m of s.members) {
          if (m.kind === 'Field') {
            this.noteType(m.type);
            if (m.init) this.walkExpr(m.init);
          } else {
            if (m.kind === 'Method') this.noteType(m.returnType);
            // `this` is not available in static methods (or static getters/setters),
            // so those bodies must not register implicit `this.method` references.
            const isStatic = m.kind === 'Method' ? m.isStatic : false;
            const saved = this.currentWalkClass;
            const savedStatic = this.currentWalkIsStatic;
            const savedMethod = this.currentWalkMethod;
            this.currentWalkClass = cname;
            this.currentWalkIsStatic = isStatic;
            this.currentWalkMethod = m.name;
            this.funcVars.push(new Map(m.params.map((p) => [p.name, this.rt(p.type)])));
            this.walkParams(m.params);
            this.collectWalkFuncVars(m.body.body);
            this.pushWalkFnBody(m.body.body);
            const groupStart = this.anonFuncs.length;
            this.walkStmts(m.body.body);
            this.mergeNestedGroup(groupStart);
            this.popWalkFnBody();
            this.funcVars.pop();
            this.currentWalkClass = saved;
            this.currentWalkIsStatic = savedStatic;
            this.currentWalkMethod = savedMethod;
          }
        }
        break;
      }
      case 'InterfaceDecl':
        for (const m of s.methods) { this.noteType(m.returnType); this.walkParams(m.params); }
        break;
      case 'Label': this.walkStmt(s.body); break;
      case 'Break': case 'Continue': break;
    }
  }

  private walkExpr(e: Expr): void {
    switch (e.kind) {
      case 'Num': case 'Str': case 'Bool': case 'Null': break;
      case 'Var': {
        // The name of the enclosing named function expression, referenced inside its
        // own body, is the function itself — not a free variable and not a class
        // member/method reference. Resolved at emit time (see currentFuncAsName).
        if (e.name === this.walkSelfName) break;
        if (this.currentAnonRefs) {
          const t = this.lookupCaptureVar(e.name);
          if (t) this.currentAnonRefs.push({ name: e.name, type: t });
          // A bare `this` reference inside an anon body captures the receiver.
          if (e.name === 'this' && this.currentWalkClass && !this.currentWalkIsStatic) {
            this.currentAnonNeedsThis = true;
          }
        }
        // Bound-method / static-method reference: an unqualified identifier inside
        // a method that names one of the class's methods (and is not shadowed by a
        // local) denotes `this.method` or `Class.method` used as a value. Record it
        // so the thunk is emitted in emitFunctionValues before any body uses it.
        if (this.currentWalkClass && !this.lookupFuncVar(e.name)) {
          const cinfo = this.symbols.getClass(this.currentWalkClass);
          if (!this.currentWalkIsStatic) {
            const m = cinfo?.methods.get(e.name);
            if (m) {
              // An unqualified instance-method name inside an anon body (either as
              // a call target `loadAssets(...)` or a value) reaches `this.method`,
              // so the closure must capture `this`.
              if (this.currentAnonRefs) this.currentAnonNeedsThis = true;
              const key = `${this.currentWalkClass}:${e.name}`;
              if (!this.boundMethods.has(key)) {
                this.boundMethods.set(key, { cname: this.currentWalkClass, mname: e.name, m });
              }
            }
            // An unqualified field/getter reference (`_starling`) inside an anon
            // body also reaches `this.field` / `this.getter`, so the closure must
            // capture `this` just like a bare method name does.
            if (!this.currentAnonNeedsThis && (cinfo?.fields.has(e.name) || cinfo?.getters.has(e.name))) {
              if (this.currentAnonRefs) this.currentAnonNeedsThis = true;
            }
          }
          // A bare identifier naming a static method is `Class.method` used as a
          // value in ANY context (static methods carry no receiver).
          const sm = cinfo?.staticMethods.get(e.name);
          if (sm) {
            const key = `${sm.owner}:${e.name}`;
            if (!this.staticMethodRefs.has(key)) {
              this.staticMethodRefs.set(key, { cname: sm.owner, mname: e.name, m: sm });
            }
          }
        }
        break;
      }
      case 'Binary': this.walkExpr(e.left); this.walkExpr(e.right); break;
      case 'Unary': this.walkExpr(e.operand); break;
      case 'Typeof': this.walkExpr(e.operand); break;
      case 'Delete': this.walkExpr(e.target); break;
      case 'Conditional': this.walkExpr(e.cond); this.walkExpr(e.then); this.walkExpr(e.else); break;
      case 'Update': this.walkExpr(e.target); break;
      case 'Assign': this.walkExpr(e.target); this.walkExpr(e.value); break;
      case 'Call': this.walkExpr(e.callee); for (const a of e.args) this.walkExpr(a); break;
      case 'Member': {
        // Static-method-as-value: `ClassName.method` referenced as a Function
        // value (not called). Record it so a non-capturing thunk is emitted.
        if (e.object.kind === 'Var') {
          const cname = this.resolveClassName(e.object.name);
          if (this.symbols.hasClass(cname)) {
            const cinfo = this.symbols.getClass(cname)!;
            const sm = cinfo.staticMethods.get(e.property);
            if (sm) {
              const key = `${sm.owner}:${e.property}`;
              if (!this.staticMethodRefs.has(key)) {
                this.staticMethodRefs.set(key, { cname: sm.owner, mname: e.property, m: sm });
              }
            }
          } else if (e.object.name === 'this' && this.currentWalkClass && !this.currentWalkIsStatic) {
            // `this.method` referenced as a Function value (e.g. a callback passed
            // to setTimeout / TweenLite.onComplete). Record it so the bound-method
            // thunk is emitted before any body uses it.
            if (this.currentAnonRefs) this.currentAnonNeedsThis = true;
            const cinfo = this.symbols.getClass(this.currentWalkClass);
            const m = cinfo?.methods.get(e.property);
            if (m) {
              const key = `${this.currentWalkClass}:${e.property}`;
              if (!this.boundMethods.has(key)) {
                this.boundMethods.set(key, { cname: this.currentWalkClass, mname: e.property, m });
              }
            }
          } else {
            // `localVar.method` / `getter.method` referenced as a Function value
            // where the receiver is an object-typed local/parameter/getter (e.g.
            // RenderUtil's `executeFunc(stage3D.requestContext3D, ...)` or
            // `setTimeout(base.dispatchEvent, ...)`). Bind the receiver and emit a
            // thunk just like `this.method`; walkInferType resolves the receiver's
            // static type (locals, fields, getters, statics).
            const t = this.walkInferType(e.object);
            if (t?.kind === 'object') {
              const cinfo = this.symbols.getClass(t.className);
              const m = cinfo?.methods.get(e.property);
              if (m) {
                const key = `${t.className}:${e.property}`;
                if (!this.boundMethods.has(key)) {
                  this.boundMethods.set(key, { cname: t.className, mname: e.property, m });
                }
              }
            }
          }
        }
        // `obj.member.method` referenced as a Function value (e.g.
        // `painter.context.drawToBitmapData`). Infer the receiver type and record a
        // bound-method thunk; the emit pass already resolves the getter chain.
        if (e.object.kind === 'Member') {
          const t = this.walkInferType(e.object);
          if (t?.kind === 'object') {
            const cinfo = this.symbols.getClass(t.className);
            const m = cinfo?.methods.get(e.property);
            if (m) {
              const key = `${t.className}:${e.property}`;
              if (!this.boundMethods.has(key)) {
                this.boundMethods.set(key, { cname: t.className, mname: e.property, m });
              }
            }
          }
        }
        this.walkExpr(e.object);
        break;
      }
      case 'AttrAccess': this.walkExpr(e.object); break;
      case 'Filter': this.walkExpr(e.object); this.walkExpr(e.value); break;
      case 'SuperMethod': for (const a of e.args) this.walkExpr(a); break;
      case 'SuperProperty': {
        // `super.method` used as a value: record the static (superclass) target so
        // the direct-call thunk is emitted in emitFunctionValues before any body
        // references it.
        if (this.currentWalkClass) {
          const cinfo = this.symbols.getClass(this.currentWalkClass);
          const sinfo = cinfo?.superClass ? this.symbols.getClass(cinfo.superClass) : undefined;
          const sm = sinfo?.methods.get(e.property);
          if (sm) {
            const key = `${sm.owner}:${e.property}`;
            if (!this.superBoundMethods.has(key)) {
              this.superBoundMethods.set(key, { owner: sm.owner, mname: e.property, m: sm });
            }
          }
        }
        break;
      }
      case 'Is': this.walkExpr(e.obj); break;
      case 'As': this.walkExpr(e.obj); break;
      case 'In': this.walkExpr(e.key); this.walkExpr(e.object); break;
      case 'New': {
        // `new assetClass()`: if the identifier is not a known class but names a
        // Class-typed variable in the enclosing scope, it is dynamic instantiation
        // and the variable must be captured like any other free variable.
        if (this.currentAnonRefs) {
          const vt = this.rt(e.className);
          if (vt.kind !== 'object' || !this.symbols.hasClass(vt.className)) {
            const t = this.lookupFuncVar(e.className);
            if (t && t.kind === 'class') this.currentAnonRefs.push({ name: e.className, type: t });
          }
        }
        this.noteType(e.className);
        for (const a of e.args) this.walkExpr(a);
        break;
      }
      case 'NewDynamic': this.walkExpr(e.classExpr); for (const a of e.args) this.walkExpr(a); break;
      case 'ArrayLit': for (const el of e.elements) this.walkExpr(el); break;
      case 'VectorLit': this.noteType(`Vector.<${e.elem}>`); for (const el of e.elements) this.walkExpr(el); break;
      case 'Index': this.walkExpr(e.object); this.walkExpr(e.index); break;
      case 'ObjectLit': for (const f of e.fields) this.walkExpr(f.value); break;
      case 'FunctionExpr': {
        const name = `_fn${this.anonSeq++}`;
        const depth = this.funcVars.length;
        this.anonIndex.set(e, name);
        // Free-variable analysis: push this anonymous function's own scope, walk
        // its body collecting Var references, then keep those that resolve to the
        // enclosing function scope (captured variables).
        this.funcVars.push(new Map(e.params.map((p) => [p.name, this.rt(p.type)])));
        const local = this.funcVars[this.funcVars.length - 1];
        // A NAMED function expression binds its own name into its own scope only
        // (recursive self-reference). Declaring it here, in the function's own
        // frame, makes references resolve as locals — so they are not captured as
        // free variables and, because the frame is popped below, the name never
        // leaks into the enclosing scope (per AS3/ES3).
        if (e.name !== null) local.set(e.name, { kind: 'function' });
        const savedLocal = this.currentAnonLocal;
        const savedRefs = this.currentAnonRefs;
        const savedNeedsThis = this.currentAnonNeedsThis;
        const savedWalkSelfName = this.walkSelfName;
        this.walkSelfName = e.name;
        this.currentAnonLocal = local;
        this.currentAnonRefs = [];
        this.currentAnonNeedsThis = false;
        this.noteType(e.returnType);
        this.walkParams(e.params);
        const nestedStart = this.anonCaptures.size;
        const parentBody = this.walkFnBody;
        this.pushWalkFnBody(e.body.body);
        this.walkStmts(e.body.body);
        this.popWalkFnBody();
        const seen = new Map<string, CType>();
        for (const r of this.currentAnonRefs) {
          if (!local.has(r.name) && this.lookupEnclosingVar(r.name, local)) seen.set(r.name, r.type);
        }
        this.propagateNestedCaptures(local, seen, nestedStart);
        // A closure defined in an instance method that reaches the receiver (bare
        // `this`, `this.method`, or an unqualified instance-method call) captures
        // `this` into its environment, so emit-time `this`/bare-method dispatch
        // resolves through env->this.
        if (this.currentAnonNeedsThis && this.currentWalkClass && !this.currentWalkIsStatic) {
          seen.set('this', { kind: 'object', className: this.currentWalkClass } as CType);
        }
        const captures = [...seen.entries()].map(([n, t]) => ({ name: n, type: t }));
        this.anonCaptures.set(e, captures);
        this.currentAnonLocal = savedLocal;
        this.currentAnonRefs = savedRefs;
        this.currentAnonNeedsThis = savedNeedsThis;
        this.walkSelfName = savedWalkSelfName;
        this.anonFuncs.push({ name, asName: e.name, params: e.params, returnType: e.returnType, body: e.body, captures, cname: this.currentWalkClass, isStatic: this.currentWalkIsStatic, depth, methodName: this.currentWalkMethod });
        this.addFnBodyKid(parentBody, name);
        this.funcVars.pop();
        break;
      }
    }
  }

  // Emit calling thunks for free functions (so they can be used as values) and
  // for anonymous function expressions (typed body + thunk). Capturing closures
  // additionally get an environment struct, a heap-allocating constructor, and
  // an impl that takes the environment as its first argument.
  private emitFunctionValues(): void {
    for (const [fname, f] of this.symbols.funcs) {
      this.emitThunk(`${fname}__call`, fname, f.params, f.returnType, null);
    }
    // Bound-method thunks for implicit `this.method` references. The receiver is
    // the captured `this`; dispatch goes through the vtable so overridden methods
    // still resolve on the actual runtime class.
    for (const b of this.boundMethods.values()) {
      this.emitThunk(
        `${b.cname}_${b.mname}__bound`,
        `(((${b.cname}*)env)->vtable->${this.cIdent(b.mname)})`,
        b.m.params,
        b.m.returnType,
        `((${b.cname}*)env)`,
      );
    }
    // `super.method` bound thunks: the superclass implementation is called directly
    // (no vtable), matching AS3's statically-resolved `super` semantics.
    for (const s of this.superBoundMethods.values()) {
      this.emitThunk(
        `${s.owner}_${s.mname}__superbound`,
        `${s.owner}_${s.mname}`,
        s.m.params,
        s.m.returnType,
        `((${s.owner}*)env)`,
      );
    }
    // Static-method-as-value thunks: `ClassName.method` used as a Function value.
    // No receiver; the static method is called directly.
    for (const s of this.staticMethodRefs.values()) {
      this.emitThunk(
        `${s.cname}_${s.mname}__call`,
        `${s.cname}_${s.mname}_static`,
        s.m.params,
        s.m.returnType,
        null,
      );
    }
    // closure environment structs and heap-allocating constructors
    // Shared cells for mutually-recursive sibling groups come first: one struct
    // holding an `as_fn` slot per member plus the merged variable captures, so a
    // sibling reference reads the same (identity-stable) function value.
    const cellGroups = [...new Map([...this.closureGroupsByMethod.values()].flat().map((g) => [g.cellName, g])).values()];
    // Activation cells for captured var-locals (members: none, varCaps: the locals)
    // are structurally identical to a group cell, so they ride the same emission.
    for (const c of this.fnBodyCells.values()) cellGroups.push(c);
    for (const g of cellGroups) {
      const fields = g.members
        .map((m) => `as_fn ${m};`)
        .concat(g.varCaps.map((c) => `${this.cTypeName(c.type)} ${this.cIdent(c.name)};`))
        .join(' ');
      this.line(`typedef struct { void (*mark)(void*); ${fields} } ${g.cellName};`);
    }
    for (const g of cellGroups) {
      this.line(`static void ${g.cellName}_mark(void* self) {`);
      this.indent++;
      this.line(`${g.cellName}* e = (${g.cellName}*)self;`);
      for (const m of g.members) this.line(`gc_mark_ptr((void*)e->${m});`);
      for (const c of g.varCaps) {
        const k = this.captureMarkKind(c.type);
        if (k === 'ptr') this.line(`gc_mark_ptr((void*)e->${this.cIdent(c.name)});`);
        else if (k === 'value') this.line(`gc_mark_value(e->${this.cIdent(c.name)});`);
      }
      this.indent--;
      this.line('}');
    }
    for (const fn of this.anonFuncs) {
      if (fn.captures.length === 0 || this.closureGroups.has(fn.name)) continue;
      const fields = fn.captures.map((c) => `${this.cTypeName(c.type)} ${this.cIdent(c.name)};`).join(' ');
      this.line(`typedef struct { void (*mark)(void*); ${fields} } ${fn.name}_env;`);
    }
    for (const fn of this.anonFuncs) {
      if (fn.captures.length === 0 || this.closureGroups.has(fn.name)) continue;
      const params = fn.captures.map((c) => `${this.cTypeName(c.type)} ${this.cIdent(c.name)}`).join(', ');
      // GC mark callback for the captured environment: trace each captured field
      // that carries a GC pointer (raw object/string) or a boxed as_value. The
      // env is a GCT_CUSTOM object so gc_scan dispatches to this callback, which
      // keeps any object/string the closure captured alive.
      this.line(`static void ${fn.name}_env_mark(void* self) {`);
      this.indent++;
      this.line(`${fn.name}_env* e = (${fn.name}_env*)self;`);
      for (const c of fn.captures) {
        const k = this.captureMarkKind(c.type);
        if (k === 'ptr') this.line(`gc_mark_ptr((void*)e->${this.cIdent(c.name)});`);
        else if (k === 'value') this.line(`gc_mark_value(e->${this.cIdent(c.name)});`);
      }
      this.indent--;
      this.line('}');
      this.line(`static ${fn.name}_env* ${fn.name}_env_make(${params}) {`);
      this.indent++;
      this.line(`${fn.name}_env* e = (${fn.name}_env*)gc_alloc(GCT_CUSTOM, sizeof(${fn.name}_env));`);
      this.line(`e->mark = ${fn.name}_env_mark;`);
      for (const c of fn.captures) this.line(`e->${this.cIdent(c.name)} = ${this.cIdent(c.name)};`);
      this.line('return e;');
      this.indent--;
      this.line('}');
    }
    if (this.anonFuncs.length > 0) this.line('');
    // prototypes first so a nested anonymous function's thunk resolves before
    // its enclosing body references it.
    for (const fn of this.anonFuncs) {
      const rt = this.rt(fn.returnType);
      if (fn.captures.length === 0) {
        this.line(`${this.cTypeName(rt)} ${fn.name}(${this.paramDecls(fn.params)});`);
      } else {
        const p = this.paramDecls(fn.params);
        this.line(`${this.cTypeName(rt)} ${fn.name}__impl(${this.closureEnvType(fn)}* env${p ? ', ' + p : ''});`);
      }
      this.line(`as_value ${fn.name}__call(void* env, as_value* args, int argc);`);
    }
    // Eager cell allocators: allocate the shared cell, fill each member's `as_fn`
    // slot, and default-initialize the captured variables. Boxed captured locals
    // are written later by the enclosing body via `cell->field` (reference
    // semantics), so they start at their AS3 defaults here (gc_alloc zeroes them;
    // Number defaults to NaN).
    for (const g of cellGroups) {
      this.line(`static ${g.cellName}* ${g.cellName}_alloc(void) {`);
      this.indent++;
      this.line(`${g.cellName}* e = (${g.cellName}*)gc_alloc(GCT_CUSTOM, sizeof(${g.cellName}));`);
      this.line(`e->mark = ${g.cellName}_mark;`);
      for (const m of g.members) {
        const nf = this.nestedFuncs.get(m);
        if (nf) this.line(`e->${m} = as_fn_make(${m}__call, (void*)e, ${this.requiredArity(nf.params)});`);
      }
      for (const c of g.varCaps) {
        if (c.type.kind === 'number') this.line(`e->${this.cIdent(c.name)} = NAN;`);
      }
      this.line('return e;');
      this.indent--;
      this.line('}');
    }
    if (this.anonFuncs.length > 0) this.line('');
    for (const fn of this.anonFuncs) {
      const rt = this.rt(fn.returnType);
      this.pushScope();
      this.functionScope = this.scopes[this.scopes.length - 1];
      for (const p of fn.params) this.declareVar(p.name, this.rt(p.type));
      this.currentReturnType = rt;
      if (fn.captures.length === 0) {
        this.line(`${this.cTypeName(rt)} ${fn.name}(${this.paramDecls(fn.params)}) {`);
      } else {
        const p = this.paramDecls(fn.params);
        this.line(`${this.cTypeName(rt)} ${fn.name}__impl(${this.closureEnvType(fn)}* env${p ? ', ' + p : ''}) {`);
        this.currentClosureCaptures = new Map(fn.captures.map((c) => [c.name, c.type]));
        this.currentClosureCells = this.closureCellEnv.get(fn.name)?.resolve ?? null;
      }
      this.indent++;
      // Restore the enclosing class context so a bare instance-method call or
      // `this` inside the closure resolves against the defining class (with
      // env->this as the receiver; see emitVar / emitCall).
      const savedClass = this.currentClass;
      const savedIsStatic = this.currentIsStatic;
      const savedMethod = this.currentMethod;
      this.currentClass = fn.cname;
      this.currentIsStatic = fn.isStatic;
      this.currentMethod = fn.methodName;
      this.hoistFunctionLocals(fn.body.body);
      this.currentFuncCName = fn.name;
      this.currentFuncAsName = fn.asName;
      this.currentFuncArity = this.requiredArity(fn.params);
      this.emitBlockBody(fn.body);
      this.currentFuncCName = null;
      this.currentFuncAsName = null;
      this.currentFuncArity = 0;
      this.currentClass = savedClass;
      this.currentIsStatic = savedIsStatic;
      this.currentMethod = savedMethod;
      this.indent--;
      this.line('}');
      this.line('');
      this.currentClosureCaptures = null;
      this.currentClosureCells = null;
      this.functionScope = null;
      this.hoistedLocals = new Set();
      this.popScope();
      this.currentReturnType = null;
      if (fn.captures.length === 0) {
        this.emitThunk(`${fn.name}__call`, fn.name, fn.params, rt, null);
      } else {
        this.emitThunk(`${fn.name}__call`, `${fn.name}__impl`, fn.params, rt, `((${this.closureEnvType(fn)}*)env)`);
      }
    }
    if (this.symbols.funcs.size > 0 || this.anonFuncs.length > 0) this.line('');
  }

  // AS3 Function.length: the number of REQUIRED parameters (all parameters
  // before the first optional/rest one). Starling's execute() reads func.length
  // to decide how many arguments to pass and pads the rest with null, so the
  // emitted closure arity must be this count — not the total declared parameter
  // count — or a thunk with default-valued String params will receive a padded
  // as_v_null() and unbox it to the literal "null" (see emitThunk's argc>i guard).
  private requiredArity(params: Param[]): number {
    let n = 0;
    for (const p of params) {
      if (p.defaultValue !== null || p.isRest) break;
      n++;
    }
    return n;
  }

  // A calling thunk: unbox each argument from the as_value[] list, call the
  // typed implementation, and box the result back into as_value. `envArg` is the
  // environment expression passed first for capturing closures (null otherwise).
  private emitThunk(name: string, callTarget: string, params: Param[], returnType: CType, envArg: string | null): void {
    const argCodes: string[] = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.isRest) {
        // A rest parameter (`...args`) is the callee's Array of all trailing boxed
        // arguments. In the uniform thunk signature those trailing values are the
        // tail of the caller's contiguous as_value[] list, so as_array_make copies
        // args[i..argc-1] directly (no per-arg unbox).
        argCodes.push(`as_array_make((argc > ${i} ? argc - ${i} : 0), (argc > ${i} ? &args[${i}] : NULL))`);
        break;
      }
      const unboxArg = this.unboxAny({ code: `args[${i}]`, type: { kind: 'any' } as CType }, this.rt(p.type));
      if (p.defaultValue !== null) {
        // An optional argument the caller may omit: fall back to its default value
        // when argc <= i. Otherwise the thunk reads args[i] out of bounds (args may
        // be NULL, e.g. `onAssetLoaded()` with `name:String=null`).
        const defCode = this.convert(this.emitExpr(p.defaultValue), this.rt(p.type));
        argCodes.push(`(argc > ${i} ? ${unboxArg} : ${defCode})`);
      } else {
        argCodes.push(unboxArg);
      }
    }
    this.line(`as_value ${name}(void* env, as_value* args, int argc) {`);
    this.indent++;
    if (envArg === null) this.line('(void)env;');
    this.line('(void)argc;');
    if (params.length === 0) this.line('(void)args;');
    const parts: string[] = [];
    if (envArg !== null) parts.push(envArg);
    parts.push(...argCodes);
    const callArgs = parts.join(', ');
    if (returnType.kind === 'void') {
      this.line(`${callTarget}(${callArgs});`);
      this.line('return as_v_null();');
    } else {
      const call = `${callTarget}(${callArgs})`;
      this.line(`return ${this.boxExpr({ code: call, type: returnType })};`);
    }
    this.indent--;
    this.line('}');
    this.line('');
  }

  // Emit a call's argument list, applying default values and packing trailing
  // arguments into a rest parameter's Array.
  private emitArgs(params: Param[], args: Expr[]): string {
    const codes: string[] = [];
    let i = 0;
    for (; i < params.length; i++) {
      const p = params[i];
      if (p.isRest) {
        const extras = args.slice(i);
        const items = extras.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = extras.length;
        codes.push(n > 0 ? `as_array_make(${n}, (as_value[${n}]){ ${items.join(', ')} })` : 'as_array_new()');
        return codes.join(', ');
      }
      if (i < args.length) {
        codes.push(this.convert(this.emitExpr(args[i]), this.rt(p.type)));
      } else if (p.defaultValue !== null) {
        codes.push(this.convert(this.emitExpr(p.defaultValue), this.rt(p.type)));
      } else {
        throw new CodegenError(`missing argument for parameter '${p.name}'`);
      }
    }
    if (args.length > params.length) {
      throw new CodegenError(`too many arguments (expected ${params.length}, got ${args.length}) for ${params.map((p) => p.name).join(',')}`);
    }
    return codes.join(', ');
  }

  // Call a value of type Function: box all arguments, invoke the thunk with a
  // uniform `(as_value*, argc)` signature, and return the boxed result as `any`.
  private emitFunctionCall(fn: { code: string; type: CType }, args: Expr[]): { code: string; type: CType } {
    const items = args.map((a) => this.boxExpr(this.emitExpr(a)));
    const n = args.length;
    const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
    return { code: `${fn.code}->fn(${fn.code}->env, ${arr}, ${n})`, type: { kind: 'any' } };
  }

  private emitDefinitions(): void {
    // built-in Object.toString(): the default string form of any object is its runtime class name.
    this.line('char* Object_toString(void* _this) { return as_obj_to_str(_this); }');
    // Object.hasOwnProperty(name): AS3 semantics (verified against AIR's adl on a
    // base class with a field, a getter, a writer and a method, plus a derived
    // class): 'hasOwnProperty' is TRUE for every *trait declared on the instance's
    // class or any superclass* — fields, accessors (getter OR setter) and methods
    // alike — because AS3 instance traits are inherited into the instance's own
    // trait set. It is only false for names with no trait at all (or, for a
    // dynamic object, no dynamic slot). Delegates to the runtime trait walk shared
    // with the `in` operator so the two can never disagree; Starling's
    // Juggler.tween validates tweenable properties through this method, which is
    // how accessor-backed names like Sprite3D.rotationX become tweenable.
    this.line('bool Object_hasOwnProperty(void* _this, char* name) {');
    this.indent++;
    this.line('if (_this == NULL || name == NULL) return false;');
    this.line('return as_dyn_has(_this, name);');
    this.indent--;
    this.line('}');
    this.line('');
    // Stage3D on-screen compositing (stage 82 P2): Context3D.present() exposes the
    // offscreen render target for ASC_window_render to composite behind the 2D
    // display list (AIR puts Stage3D behind the display list). On both GPU paths
    // this is a direct GPU→GPU blit (ASC_stage3d_tex: an MTLTexture natively, a GL
    // texture wrapped as a GrBackendTexture on the web); on the CPU raster path the
    // target is read back into ASC_stage3d_pixels and drawn as BGRA. Declared up
    // here (before the Context3D_* method definitions below) so Context3D_present
    // can reference them. Static storage duration zero-initializes them to NULL/0,
    // matching the "no Stage3D content yet" state.
    this.line('static uint8_t* ASC_stage3d_pixels;');
    this.line('static void* ASC_stage3d_tex;');
    this.line('static int ASC_stage3d_w;');
    this.line('static int ASC_stage3d_h;');
    this.line('static int ASC_stage3d_ready;');
    // The Stage3D back buffer's size in *stage* units (what Context3D was asked to
    // configure). Under HiDPI these are smaller than the actual render target
    // (ASC_stage3d_w/h), which AIR allocates at device resolution — the compositor
    // draws the target into this logical rect (analogous to stage3D.x/y +
    // configureBackBuffer's width/height in AIR).
    this.line('static int ASC_stage3d_lw;');
    this.line('static int ASC_stage3d_lh;');
    // Forward declaration: the window backend owns the definition (with the rest
    // of the ASC_win_* state further down). Context3D_configureBackBuffer needs the
    // device pixel ratio to honour wantsBestResolution, so it must be visible here.
    this.line('static double ASC_win_scale;');
    this.line('');
    // built-in Object: no fields to initialize, but every subclass's implicit
    // super() lands here, so it needs a real (empty) constructor definition.
    this.line('void Object_ctor(Object* o) { (void)o; }');
    this.line('Object* Object_new(void) { Object* o = (Object*)gc_alloc(GCT_CLASS, sizeof(Object)); o->vtable = &Object_vt; Object_ctor(o); return o; }');
    this.line('');
    // Stage 41 constant classes are pure static-String holders and are never
    // instantiated, but they still need concrete (empty) ctor/new definitions
    // so any reference links cleanly.
    for (const cc of ['StageAlign', 'StageScaleMode', 'StageQuality', 'StageDisplayState',
      'Context3DBlendFactor', 'Context3DBufferUsage', 'Context3DClearMask', 'Context3DCompareMode',
      'Context3DFillMode', 'Context3DMipFilter', 'Context3DProfile', 'Context3DProgramType',
      'Context3DRenderMode', 'Context3DStencilAction', 'Context3DTextureFilter', 'Context3DTextureFormat',
      'Context3DTriangleFace', 'Context3DVertexBufferFormat', 'Context3DWrapMode']) {
      this.line(`void ${cc}_ctor(${cc}* o) { Object_ctor((Object*)o); }`);
      this.line(`${cc}* ${cc}_new(void) { ${cc}* o = (${cc}*)gc_alloc(GCT_CLASS, sizeof(${cc})); o->vtable = &${cc}_vt; ${cc}_ctor(o); return o; }`);
    }
    this.line('');
    // built-in Error: constructor copies the message into the message field. The
    // second `id` parameter (AS3 Error(message, id)) is accepted and discarded —
    // Starling's Error subclasses call `super(message, id)`.
    this.line('void Error_ctor(Error* o, char* message, int id) { o->message = message; o->errorID = id; gc_write_barrier((void*)message); }');
    this.line('Error* Error_new(char* message, int id) {');
    this.indent++;
    this.line('Error* o = (Error*)gc_alloc(GCT_CLASS, sizeof(Error));');
    this.line('o->vtable = &Error_vt;');
    this.line('Error_ctor(o, message, id);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('');
    // built-in Error subclasses: identical { vtable; message } layout, but each
    // has its own vtable instance so `catch (e:TypeError)` can match precisely.
    for (const sub of ['TypeError', 'RangeError', 'ArgumentError', 'SyntaxError', 'ReferenceError', 'IllegalOperationError', 'IllegalArgumentError', 'SecurityError', 'EOFError', 'IOError']) {
      // The id is STORED, not discarded: AIR's errorID is how code tells a
      // parameter error (#2007) from an EOF (#2030) without parsing the message,
      // and these subclasses share Error's layout (see emitStructs).
      this.line(`void ${sub}_ctor(${sub}* o, char* message, int id) { o->message = message; o->errorID = id; gc_write_barrier((void*)message); }`);
      this.line(`${sub}* ${sub}_new(char* message, int id) {`);
      this.indent++;
      this.line(`${sub}* o = (${sub}*)gc_alloc(GCT_CLASS, sizeof(${sub}));`);
      this.line(`o->vtable = &${sub}_vt;`);
      this.line(`${sub}_ctor(o, message, id);`);
      this.line('return o;');
      this.indent--;
      this.line('}');
      this.line('');
    }
    // XML parse wrapper: as_xml_parse returns NULL on malformed input; the AS3
    // `new XML(bytes)` constructor must throw an Error instead of silently
    // degrading. Emitted here (not in RUNTIME_PREAMBLE) because it calls the
    // generated Error_new.
    this.line('static as_xml_node* as_xml_parse_checked(const char* src, int len) {');
    this.indent++;
    this.line('as_xml_node* n = as_xml_parse(src, len);');
    this.line('if (n == NULL) as_throw(Error_new((char*)"XML parse error", 0));');
    this.line('return n;');
    this.indent--;
    this.line('}');
    // Single-evaluation entry points: `new XML(expr)` must evaluate `expr` exactly
    // once (AS3 evaluates the argument once). Passing the value through one helper
    // argument avoids re-emitting a side-effecting expression such as
    // `new XML(bytes.readUTF())` — readUTF advances `position`, so a second read
    // yields the empty tail instead of the payload.
    this.line('static as_xml_node* as_xml_parse_str_checked(const char* src) {');
    this.indent++;
    this.line('return as_xml_parse_checked(src, src == NULL ? 0 : (int)strlen(src));');
    this.indent--;
    this.line('}');
    this.line('static as_xml_node* as_xml_parse_bytes_checked(ByteArray* bytes) {');
    this.indent++;
    this.line('if (bytes == NULL) return as_xml_parse_checked("", 0);');
    this.line('return as_xml_parse_checked(bytes->data == NULL ? "" : (const char*)bytes->data, (int)bytes->length);');
    this.indent--;
    this.line('}');
    this.line('');
    // built-in Date: stores milliseconds since the epoch; calendar accessors
    // convert through C's localtime() (AS3 getMonth/getDay are 0-based, matching
    // tm_mon/tm_wday). Constructors: () = now, (ms) = epoch ms, (string) = parsed,
    // (year, month, day, ...) = local calendar components.
    // `time` is a libc symbol (time.h), so the emitted struct field is sanitized
    // to `_time`; these hand-written accessors must use the same mangled name.
    this.line('void Date_ctor(Date* o) { o->_time = as_now_ms(); }');
    this.line('Date* Date_new(void) {');
    this.indent++;
    this.line('Date* o = (Date*)gc_alloc(GCT_CLASS, sizeof(Date));');
    this.line('o->vtable = &Date_vt;');
    this.line('Date_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('Date* Date_new_ms(double ms) {');
    this.indent++;
    this.line('Date* o = (Date*)gc_alloc(GCT_CLASS, sizeof(Date));');
    this.line('o->vtable = &Date_vt;');
    this.line('o->_time = ms;');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // Build a local-time epoch-ms timestamp from calendar components. AS3 maps
    // year 0..99 onto 1900..1999; mktime interprets the struct tm as local time.
    this.line('static double Date_mkms(int year, int mon, int day, int hour, int min, int sec, int ms) {');
    this.indent++;
    this.line('struct tm t;');
    this.line('memset(&t, 0, sizeof(t));');
    this.line('t.tm_year = (year >= 100) ? (year - 1900) : year;');
    this.line('t.tm_mon = mon;');
    this.line('t.tm_mday = day;');
    this.line('t.tm_hour = hour;');
    this.line('t.tm_min = min;');
    this.line('t.tm_sec = sec;');
    this.line('t.tm_isdst = -1;');
    this.line('time_t tt = mktime(&t);');
    this.line('return (double)tt * 1000.0 + (double)ms;');
    this.indent--;
    this.line('}');
    this.line('Date* Date_new_ymd(int year, int mon, int day, int hour, int min, int sec, int ms) {');
    this.indent++;
    this.line('Date* o = (Date*)gc_alloc(GCT_CLASS, sizeof(Date));');
    this.line('o->vtable = &Date_vt;');
    this.line('o->_time = Date_mkms(year, mon, day, hour, min, sec, ms);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // Font.enumerateFonts: the demo does not enumerate device fonts, so return
    // an empty array (SystemUtil.isEmbeddedFont consequently always answers false).
    this.line('as_array* Font_enumerateFonts_static(bool enumerateDeviceFonts) { (void)enumerateDeviceFonts; return as_array_new(); }');
    // Date.parse: accept "YYYY/MM/DD" / "YYYY-MM-DD" with an optional time part.
    this.line('double Date_parse_static(char* s) {');
    this.indent++;
    this.line('int year = 0, mon = 0, day = 1, hour = 0, min = 0, sec = 0;');
    this.line('int n = sscanf(s, "%d/%d/%d %d:%d:%d", &year, &mon, &day, &hour, &min, &sec);');
    this.line('if (n < 3) n = sscanf(s, "%d/%d/%d", &year, &mon, &day);');
    this.line('if (n < 3) n = sscanf(s, "%d-%d-%dT%d:%d:%d", &year, &mon, &day, &hour, &min, &sec);');
    this.line('if (n < 3) n = sscanf(s, "%d-%d-%d", &year, &mon, &day);');
    this.line('if (n < 3) return NAN;');
    this.line('return Date_mkms(year, mon - 1, day, hour, min, sec, 0);');
    this.indent--;
    this.line('}');
    this.line('static struct tm* Date_tm(Date* o) { time_t t = (time_t)(o->_time / 1000.0); return localtime(&t); }');
    this.line('double Date_getTime(void* _this) { return ((Date*)_this)->_time; }');
    this.line('int Date_getFullYear(void* _this) { return Date_tm((Date*)_this)->tm_year + 1900; }');
    this.line('int Date_getMonth(void* _this) { return Date_tm((Date*)_this)->tm_mon; }');
    this.line('int Date_getDate(void* _this) { return Date_tm((Date*)_this)->tm_mday; }');
    this.line('int Date_getDay(void* _this) { return Date_tm((Date*)_this)->tm_wday; }');
    this.line('int Date_getHours(void* _this) { return Date_tm((Date*)_this)->tm_hour; }');
    this.line('int Date_getMinutes(void* _this) { return Date_tm((Date*)_this)->tm_min; }');
    this.line('int Date_getSeconds(void* _this) { return Date_tm((Date*)_this)->tm_sec; }');
    this.line('char* Date_toDateString(void* _this) {');
    this.indent++;
    this.line('struct tm* t = Date_tm((Date*)_this);');
    this.line('static const char* days[] = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};');
    this.line('static const char* months[] = {"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"};');
    this.line('char* r = as_str_alloc(32);');
    this.line('snprintf(r, 32, "%s %s %02d %04d", days[t->tm_wday], months[t->tm_mon], t->tm_mday, t->tm_year + 1900);');
    this.line('return r;');
    this.indent--;
    this.line('}');
    this.line('char* Date_toUTCString(void* _this) {');
    this.indent++;
    this.line('time_t t = (time_t)(((Date*)_this)->_time / 1000.0);');
    this.line('struct tm* g = gmtime(&t);');
    this.line('static const char* days[] = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};');
    this.line('static const char* months[] = {"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"};');
    this.line('char* r = as_str_alloc(40);');
    this.line('snprintf(r, 40, "%s, %02d %s %04d %02d:%02d:%02d GMT", days[g->tm_wday], g->tm_mday, months[g->tm_mon], g->tm_year + 1900, g->tm_hour, g->tm_min, g->tm_sec);');
    this.line('return r;');
    this.indent--;
    this.line('}');
    this.line('');
    // built-in RegExp: compiles the pattern at construction (runtime), exposes
    // source/flags/lastIndex and the boolean flags, and provides exec/test. A
    // compile error throws SyntaxError (an Error subclass).
    this.line('void RegExp_ctor(RegExp* o, char* pattern, char* flags) {');
    this.indent++;
    this.line('o->source = pattern;');
    this.line('o->flags = flags;');
    this.line('gc_write_barrier((void*)pattern);');
    this.line('gc_write_barrier((void*)flags);');
    this.line('o->lastIndex = 0;');
    this.line('o->global = (flags != NULL && strchr(flags, \'g\') != NULL);');
    this.line('o->ignoreCase = (flags != NULL && strchr(flags, \'i\') != NULL);');
    this.line('o->multiline = (flags != NULL && strchr(flags, \'m\') != NULL);');
    this.line('o->dotall = (flags != NULL && strchr(flags, \'s\') != NULL);');
    this.line('o->extended = (flags != NULL && strchr(flags, \'x\') != NULL);');
    this.line('o->compiled = as_regex_compile(pattern, flags);');
    this.line('if (o->compiled->err) as_throw(SyntaxError_new((char*)o->compiled->errmsg, 0));');
    this.indent--;
    this.line('}');
    this.line('RegExp* RegExp_new(char* pattern, char* flags) {');
    this.indent++;
    this.line('RegExp* o = (RegExp*)gc_alloc(GCT_CLASS, sizeof(RegExp));');
    this.line('o->vtable = &RegExp_vt;');
    this.line('RegExp_ctor(o, pattern, flags);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('as_array* RegExp_exec(void* _this, char* s) {');
    this.indent++;
    this.line('RegExp* re = (RegExp*)_this;');
    this.line('if (re->compiled == NULL || re->compiled->err) return NULL;');
    this.line('int len = (int)strlen(s);');
    this.line('int cap[2 * (AS_RE_MAX_GROUPS + 1)];');
    this.line('for (int i = 0; i < 2 * (re->compiled->ngroups + 1); i++) cap[i] = -1;');
    this.line('int start = re->global ? re->lastIndex : 0;');
    this.line('int end = -1;');
    this.line('int m = as_regex_search(re->compiled, s, len, start, cap, &end);');
    this.line('if (m < 0) { if (re->global) re->lastIndex = 0; return NULL; }');
    this.line('if (re->global) re->lastIndex = end;');
    this.line('return as_regex_make_result(s, m, end, re->compiled, cap);');
    this.indent--;
    this.line('}');
    this.line('bool RegExp_test(void* _this, char* s) {');
    this.indent++;
    this.line('RegExp* re = (RegExp*)_this;');
    this.line('if (re->compiled == NULL || re->compiled->err) return false;');
    this.line('int len = (int)strlen(s);');
    this.line('int cap[2 * (AS_RE_MAX_GROUPS + 1)];');
    this.line('for (int i = 0; i < 2 * (re->compiled->ngroups + 1); i++) cap[i] = -1;');
    this.line('int start = re->global ? re->lastIndex : 0;');
    this.line('int end = -1;');
    this.line('int m = as_regex_search(re->compiled, s, len, start, cap, &end);');
    this.line('if (m < 0) { if (re->global) re->lastIndex = 0; return false; }');
    this.line('if (re->global) re->lastIndex = end;');
    this.line('return true;');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- dynamic string method dispatch ----
    // A method invoked on a dynamically-typed (`*`) value that happens to be a
    // string at runtime. Strings are raw char* (no vtable), so as_dyn_call would
    // dereference the string data as an object header and crash. as_any_call
    // routes tag-3 receivers here; every method reuses the static string helpers.
    // match/search/replace accept either a RegExp object (tag 4) or a String
    // pattern (tag 3) per AS3 semantics.
    this.line('static as_value as_str_dyn_call(char* s, const char* name, as_value* args, int argc) {');
    this.indent++;
    this.line('if (strcmp(name, "match") == 0) {');
    this.indent++;
    this.line('as_regex* re = args[0].tag == 4 ? ((RegExp*)args[0].ptr)->compiled : as_regex_compile(as_v_str_val(args[0]), "");');
    this.line('int global = args[0].tag == 4 ? ((RegExp*)args[0].ptr)->global : 0;');
    this.line('return as_v_arr((void*)as_str_match_regex(s, re, global));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "search") == 0) {');
    this.indent++;
    this.line('as_regex* re = args[0].tag == 4 ? ((RegExp*)args[0].ptr)->compiled : as_regex_compile(as_v_str_val(args[0]), "");');
    this.line('return as_v_num((double)as_str_search_regex(s, re));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "replace") == 0) {');
    this.indent++;
    this.line('if (args[0].tag == 4) {');
    this.indent++;
    this.line('RegExp* re = (RegExp*)args[0].ptr;');
    this.line('return as_v_str(as_str_replace_regex(s, re->compiled, argc >= 2 ? as_v_str_val(args[1]) : "", re->global));');
    this.indent--;
    this.line('}');
    this.line('return as_v_str(as_str_replace(s, as_v_str_val(args[0]), argc >= 2 ? as_v_str_val(args[1]) : ""));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "charAt") == 0) return as_v_str(as_str_charAt(s, as_v_int_val(args[0])));');
    this.line('if (strcmp(name, "charCodeAt") == 0) return as_v_num((double)as_str_charCodeAt(s, as_v_int_val(args[0])));');
    this.line('if (strcmp(name, "indexOf") == 0) return as_v_num((double)as_str_indexOf_from(s, as_v_str_val(args[0]), argc >= 2 ? as_v_int_val(args[1]) : 0));');
    this.line('if (strcmp(name, "lastIndexOf") == 0) return as_v_num((double)as_str_lastIndexOf_from(s, as_v_str_val(args[0]), argc >= 2 ? as_v_int_val(args[1]) : 0x7FFFFFFF));');
    this.line('if (strcmp(name, "substring") == 0) {');
    this.indent++;
    this.line('int from = as_v_int_val(args[0]);');
    this.line('int to = argc >= 2 ? as_v_int_val(args[1]) : (int)strlen(s);');
    this.line('return as_v_str(as_str_substring(s, from, to));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "substr") == 0) {');
    this.indent++;
    this.line('int from = as_v_int_val(args[0]);');
    this.line('int len = argc >= 2 ? as_v_int_val(args[1]) : (int)strlen(s);');
    this.line('return as_v_str(as_str_substr(s, from, len));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "slice") == 0) {');
    this.indent++;
    this.line('int from = as_v_int_val(args[0]);');
    this.line('int to = argc >= 2 ? as_v_int_val(args[1]) : (int)strlen(s);');
    this.line('return as_v_str(as_str_slice(s, from, to));');
    this.indent--;
    this.line('}');
    this.line('if (strcmp(name, "split") == 0) return as_v_arr((void*)as_str_split(s, as_v_str_val(args[0])));');
    this.line('if (strcmp(name, "toUpperCase") == 0) return as_v_str(as_str_toUpper(s));');
    this.line('if (strcmp(name, "toLowerCase") == 0) return as_v_str(as_str_toLower(s));');
    this.line('if (strcmp(name, "toString") == 0 || strcmp(name, "valueOf") == 0) return as_v_str(s);');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('');
    this.line('static as_value as_any_call(as_value v, const char* name, as_value* args, int argc) {');
    this.indent++;
    this.line('if (v.tag == 3) return as_str_dyn_call((char*)v.ptr, name, args, argc);');
    this.line('return as_dyn_call(v.ptr, name, args, argc);');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.events core engine (stage 33) ----
    // Listener-table keys are "<type>#cap" / "<type>#bub"; as_object stores them
    // to an as_array of boxed as_fn closures. The key lives in the arena (program
    // lifetime), so as_object's pointer-keyed storage is safe.
    this.line('static char* as_disp_key(const char* type, bool capture) {');
    this.indent++;
    this.line('size_t n = strlen(type) + 5;');
    this.line('char* k = as_str_alloc(n);');
    this.line('snprintf(k, n, "%s#%s", type, capture ? "cap" : "bub");');
    this.line('return k;');
    this.indent--;
    this.line('}');
    // Lookup-only variant: build the same key in a caller-provided stack buffer
    // so the per-frame event dispatch path (as_disp_phase/as_disp_target) does
    // not leak an arena allocation for every listener probe. as_disp_key above
    // is kept only for addEventListener, which stores the key persistently.
    this.line('static as_value as_listeners_get(as_object* listeners, const char* type, bool capture) {');
    this.indent++;
    this.line('if (listeners == NULL) return as_v_null();');
    this.line('char k[64];');
    this.line('snprintf(k, sizeof(k), "%s#%s", type, capture ? "cap" : "bub");');
    this.line('return as_object_get(listeners, k);');
    this.indent--;
    this.line('}');
    // ENTER_FRAME is a broadcast event: it must reach every object that
    // registered an "enterFrame" listener, including objects NOT on the display
    // list (GreenSock drives its tweens from a private static Shape).
    // as_ef_objs holds one slot per such object (deduplicated by pointer).
    this.line('static void** as_ef_objs = NULL;');
    this.line('static int as_ef_count = 0;');
    this.line('static int as_ef_cap = 0;');
    this.line('static void as_ef_register(void* obj) {');
    this.indent++;
    this.line('for (int i = 0; i < as_ef_count; i++) if (as_ef_objs[i] == obj) return;');
    this.line('if (as_ef_count == as_ef_cap) {');
    this.indent++;
    this.line('as_ef_cap = as_ef_cap == 0 ? 8 : as_ef_cap * 2;');
    this.line('as_ef_objs = (void**)realloc(as_ef_objs, (size_t)as_ef_cap * sizeof(void*));');
    this.indent--;
    this.line('}');
    this.line('as_ef_objs[as_ef_count++] = obj;');
    this.indent--;
    this.line('}');
    this.line('static void as_ef_unregister(void* obj) {');
    this.indent++;
    this.line('EventDispatcher* d = (EventDispatcher*)obj;');
    this.line('if (d->listeners != NULL) {');
    this.indent++;
    this.line('as_value vc = as_listeners_get(d->listeners, "enterFrame", true);');
    this.line('as_value vb = as_listeners_get(d->listeners, "enterFrame", false);');
    this.line('if ((vc.tag == 6 && ((as_array*)vc.ptr)->length > 0) || (vb.tag == 6 && ((as_array*)vb.ptr)->length > 0)) return;');
    this.indent--;
    this.line('}');
    this.line('for (int i = 0; i < as_ef_count; i++) {');
    this.indent++;
    this.line('if (as_ef_objs[i] == obj) { as_ef_objs[i] = as_ef_objs[--as_ef_count]; return; }');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // Invoke each listener in an array with the single Event argument. An as_fn
    // closure takes (env, as_value*, argc); immStopped stops the remaining ones.
    this.line('static void as_disp_arr(as_array* arr, Event* evt) {');
    this.indent++;
    this.line('for (int i = 0; i < arr->length; i++) {');
    this.indent++;
    this.line('if (evt->immStopped) break;');
    this.line('as_fn fn = (as_fn)as_v_obj_val(arr->data[i]);');
    this.line('as_value arg[1];');
    this.line('arg[0] = as_v_obj((void*)evt);');
    this.line('fn->fn(fn->env, arg, 1);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // Walk up the parent chain (display list in later stages; NULL for now).
    this.line('static void* as_disp_parent(void* obj) { return (void*)((EventDispatcher*)obj)->parent; }');
    // One phase at one target: set currentTarget, then run the listeners for the
    // capture or bubble key of the event type.
    this.line('static void as_disp_phase(Event* evt, void* current, bool capture) {');
    this.indent++;
    this.line('EventDispatcher* d = (EventDispatcher*)current;');
    this.line('evt->currentTarget = (Object*)current;');
    this.line('if (d->listeners == NULL) return;');
    this.line('as_value v = as_listeners_get(d->listeners, evt->type, capture);');
    this.line('if (v.tag == 6) as_disp_arr((as_array*)v.ptr, evt);');
    this.indent--;
    this.line('}');
    // Target phase: the target runs BOTH capture and bubble listeners.
    this.line('static void as_disp_target(Event* evt, void* target) {');
    this.indent++;
    this.line('evt->eventPhase = 2;');
    this.line('evt->currentTarget = (Object*)target;');
    this.line('EventDispatcher* d = (EventDispatcher*)target;');
    this.line('if (d->listeners == NULL) return;');
    this.line('as_value vc = as_listeners_get(d->listeners, evt->type, true);');
    this.line('if (vc.tag == 6) as_disp_arr((as_array*)vc.ptr, evt);');
    this.line('as_value vb = as_listeners_get(d->listeners, evt->type, false);');
    this.line('if (vb.tag == 6) as_disp_arr((as_array*)vb.ptr, evt);');
    this.indent--;
    this.line('}');
    this.line('');
    // built-in Event: constructor copies type/bubbles/cancelable and zeroes the
    // target/currentTarget/phase plus the three propagation flags.
    this.line('void Event_ctor(Event* o, char* type, bool bubbles, bool cancelable) {');
    this.indent++;
    this.line('o->type = type;');
    this.line('gc_write_barrier((void*)type);');
    this.line('o->bubbles = bubbles;');
    this.line('o->cancelable = cancelable;');
    this.line('o->target = NULL;');
    this.line('o->currentTarget = NULL;');
    this.line('o->eventPhase = 0;');
    this.line('o->cancelled = false;');
    this.line('o->propStopped = false;');
    this.line('o->immStopped = false;');
    this.indent--;
    this.line('}');
    this.line('Event* Event_new(char* type, bool bubbles, bool cancelable) {');
    this.indent++;
    this.line('Event* o = (Event*)gc_alloc(GCT_CLASS, sizeof(Event));');
    this.line('o->vtable = &Event_vt;');
    this.line('Event_ctor(o, type, bubbles, cancelable);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('char* Event_toString(void* _this) {');
    this.indent++;
    this.line('Event* e = (Event*)_this;');
    this.line('char* r = as_str_alloc(128);');
    this.line('snprintf(r, 128, "[Event type=\\"%s\\" bubbles=%s cancelable=%s]",');
    this.line('  e->type ? e->type : "", e->bubbles ? "true" : "false", e->cancelable ? "true" : "false");');
    this.line('return r;');
    this.indent--;
    this.line('}');
    this.line('Event* Event_clone(void* _this) {');
    this.indent++;
    this.line('Event* e = (Event*)_this;');
    this.line('Event* c = Event_new(e->type, e->bubbles, e->cancelable);');
    this.line('c->target = e->target;');
    this.line('return c;');
    this.indent--;
    this.line('}');
    this.line('void Event_preventDefault(void* _this) { Event* e = (Event*)_this; if (e->cancelable) e->cancelled = true; }');
    this.line('void Event_stopPropagation(void* _this) { ((Event*)_this)->propStopped = true; }');
    this.line('void Event_stopImmediatePropagation(void* _this) { Event* e = (Event*)_this; e->propStopped = true; e->immStopped = true; }');
    this.line('');
    // built-in EventDispatcher: listeners table (lazily allocated) + parent link.
    this.line('void EventDispatcher_ctor(EventDispatcher* o) { o->listeners = NULL; o->parent = NULL; }');
    this.line('EventDispatcher* EventDispatcher_new(void) {');
    this.indent++;
    this.line('EventDispatcher* o = (EventDispatcher*)gc_alloc(GCT_CLASS, sizeof(EventDispatcher));');
    this.line('o->vtable = &EventDispatcher_vt;');
    this.line('EventDispatcher_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void EventDispatcher_addEventListener(void* _this, char* type, as_fn listener, bool useCapture, int priority, bool useWeakReference) {');
    this.indent++;
    this.line('(void)priority; (void)useWeakReference; // priority/weak-ref are accepted but not reordered in this subset');
    this.line('EventDispatcher* d = (EventDispatcher*)_this;');
    this.line('if (d->listeners == NULL) d->listeners = as_object_new();');
    this.line('char* key = as_disp_key(type, useCapture);');
    this.line('as_value v = as_object_get(d->listeners, key);');
    this.line('as_array* arr;');
    this.line('if (v.tag == 6) { arr = (as_array*)v.ptr; }');
    this.line('else { arr = as_array_new(); as_object_set(d->listeners, key, as_v_arr((void*)arr)); }');
    this.line('as_array_push(arr, as_v_obj((void*)listener));');
    this.line('if (strcmp(type, "enterFrame") == 0) as_ef_register(_this);');
    this.indent--;
    this.line('}');
    this.line('void EventDispatcher_removeEventListener(void* _this, char* type, as_fn listener, bool useCapture) {');
    this.indent++;
    this.line('EventDispatcher* d = (EventDispatcher*)_this;');
    this.line('if (d->listeners == NULL) return;');
    this.line('as_value v = as_listeners_get(d->listeners, type, useCapture);');
    this.line('if (v.tag != 6) return;');
    this.line('as_array* arr = (as_array*)v.ptr;');
    this.line('for (int i = 0; i < arr->length; i++) {');
    this.indent++;
    // AS3 removes by *function identity* (same implementation + same bound
    // receiver), not closure-pointer identity. Each `this.method` reference
    // allocates a fresh closure, so comparing the closure pointer would make
    // removeEventListener a no-op for bound methods.
    this.line('as_fn a = (as_fn)as_v_obj_val(arr->data[i]);');
    this.line('if (a->fn == listener->fn && a->env == listener->env) {');
    this.indent++;
    this.line('for (int j = i; j < arr->length - 1; j++) arr->data[j] = arr->data[j + 1];');
    this.line('arr->length--;');
    this.line('if (strcmp(type, "enterFrame") == 0) as_ef_unregister(_this);');
    this.line('return;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('bool EventDispatcher_hasEventListener(void* _this, char* type) {');
    this.indent++;
    this.line('EventDispatcher* d = (EventDispatcher*)_this;');
    this.line('if (d->listeners == NULL) return false;');
    this.line('as_value vc = as_listeners_get(d->listeners, type, true);');
    this.line('as_value vb = as_listeners_get(d->listeners, type, false);');
    this.line('return (vc.tag == 6 && ((as_array*)vc.ptr)->length > 0) || (vb.tag == 6 && ((as_array*)vb.ptr)->length > 0);');
    this.indent--;
    this.line('}');
    this.line('bool EventDispatcher_willTrigger(void* _this, char* type) { return EventDispatcher_hasEventListener(_this, type); }');
    this.line('bool EventDispatcher_dispatchEvent(void* _this, Event* event) {');
    this.indent++;
    this.line('void* target = event->target != NULL ? (void*)event->target : _this;');
    this.line('event->target = (Object*)target;');
    // Build the ancestor chain in a fixed stack buffer instead of an arena array:
    // dispatchEvent runs every frame for ENTER_FRAME, and a per-call as_array_new()
    // + as_array_push() leaked an arena slot (never reclaimed) on every dispatch.
    this.line('void* ancestors[64];');
    this.line('int anc_count = 0;');
    this.line('for (void* p = as_disp_parent(target); p != NULL && anc_count < 64; p = as_disp_parent(p)) ancestors[anc_count++] = p;');
    this.line('event->eventPhase = 1; // CAPTURING (outermost -> target parent)');
    this.line('for (int i = anc_count - 1; i >= 0; i--) { if (event->propStopped) break; as_disp_phase(event, ancestors[i], true); }');
    this.line('if (!event->propStopped) as_disp_target(event, target);');
    this.line('event->eventPhase = 3; // BUBBLING (target parent -> outermost)');
    this.line('if (event->bubbles) { for (int i = 0; i < anc_count; i++) { if (event->propStopped) break; as_disp_phase(event, ancestors[i], false); } }');
    this.line('return event->target != NULL;');
    this.indent--;
    this.line('}');
    this.line('');
    // flash.desktop.NativeApplication: a single global EventDispatcher-backed
    // singleton (window activate/deactivate events). Lazily constructed and
    // registered as a GC permanent root.
    this.line('void NativeApplication_ctor(NativeApplication* o) { EventDispatcher_ctor((EventDispatcher*)o); }');
    this.line('NativeApplication* NativeApplication_new(void) {');
    this.indent++;
    this.line('NativeApplication* o = (NativeApplication*)gc_alloc(GCT_CLASS, sizeof(NativeApplication));');
    this.line('o->vtable = &NativeApplication_vt;');
    this.line('NativeApplication_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('static NativeApplication* ASC_native_app = NULL;');
    this.line('NativeApplication* NativeApplication_get_nativeApplication_static(void* _this) {');
    this.indent++;
    this.line('(void)_this;');
    this.line('if (ASC_native_app == NULL) ASC_native_app = NativeApplication_new();');
    this.line('return ASC_native_app;');
    this.indent--;
    this.line('}');
    this.line('');
    // flash.ui.Multitouch: inputMode is a global string (default "none").
    this.line('static char* ASC_multitouch_input_mode = (char*)"none";');
    this.line('char* Multitouch_get_inputMode_static(void* _this) { (void)_this; return ASC_multitouch_input_mode; }');
    this.line('void Multitouch_set_inputMode_static(void* _this, char* value) { (void)_this; ASC_multitouch_input_mode = value; }');
    this.line('');
    // ---- flash.display display list (stage 34) ----
    // DisplayObject: EventDispatcher + transform properties. Fields are laid out
    // { vtable; listeners; parent; name; x; y; width; height; visible; alpha;
    // rotation; scaleX; scaleY } via inherited-field flattening.
    this.line('void DisplayObject_ctor(DisplayObject* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->name = NULL;');
    this.line('o->x = 0.0; o->y = 0.0;');
    this.line('o->width = 0.0; o->height = 0.0;');
    this.line('o->visible = true;');
    this.line('o->alpha = 1.0;');
    this.line('o->rotation = 0.0;');
    this.line('o->scaleX = 1.0; o->scaleY = 1.0;');
    this.line('o->filters = NULL;');
    this.line('o->transform = Transform_new();');
    this.line('gc_write_barrier((void*)o->transform);');
    this.line('o->cacheAsBitmap = false;');
    this.line('o->_cache_image = NULL;');
    this.line('o->_cache_w = 0.0; o->_cache_h = 0.0;');
    this.line('o->_cache_valid = 0;');
    this.line('o->_auto_fp = 0;');
    this.line('o->_auto_still = 0;');
    this.line('o->_auto_baked = 0;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObject_new(void) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)gc_alloc(GCT_CLASS, sizeof(DisplayObject));');
    this.line('o->vtable = &DisplayObject_vt;');
    this.line('DisplayObject_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // root: walk parent links to the topmost object; stage: same object (the
    // outermost container is the Stage in this subset).
    this.line('DisplayObject* DisplayObject_get_root(void* _this) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)_this;');
    this.line('while (o->parent != NULL) o = (DisplayObject*)o->parent;');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // The single window's Stage, set when the Stage is constructed (before the
    // document class runs). DisplayObject_get_stage falls back to it for a
    // not-yet-attached root object, so the main class's `stage` is non-null inside
    // its constructor — matching Flash, where the document class's `stage` is set
    // before its constructor runs.
    this.line('static Stage* ASC_root_stage = NULL;');
    this.line('Stage* DisplayObject_get_stage(void* _this) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)_this;');
    this.line('while (o->parent != NULL) o = (DisplayObject*)o->parent;');
    this.line("if (o->vtable != NULL && strcmp(o->vtable->name, \"Stage\") == 0) return (Stage*)o;");
    this.line('return ASC_root_stage;');
    this.indent--;
    this.line('}');
    this.line('');
    // filters: getter returns the stored array (NULL = empty); setter stores it
    // (assigning an empty array clears filters). The render() backend applies
    // these filters to the object's subtree (see as_render_filtered below).
    this.line('as_array* DisplayObject_get_filters(void* _this) { return ((DisplayObject*)_this)->filters; }');
    this.line('void DisplayObject_set_filters(void* _this, as_array* value) { DisplayObject* o = (DisplayObject*)_this; o->filters = value; if (value != NULL) gc_write_barrier((void*)value); }');
    // cacheAsBitmap: toggling invalidates the baked subtree so the next frame
    // re-bakes (AIR lets apps force a refresh by clearing + re-setting the flag).
    this.line('bool DisplayObject_get_cacheAsBitmap(void* _this) { return ((DisplayObject*)_this)->cacheAsBitmap; }');
    this.line('void DisplayObject_set_cacheAsBitmap(void* _this, bool value) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)_this;');
    this.line('if (o->cacheAsBitmap == value) return;');
    this.line('o->cacheAsBitmap = value;');
    this.line('if (o->_cache_image != NULL) { as_skia_image_delete(o->_cache_image); o->_cache_image = NULL; }');
    this.line('o->_cache_valid = 0;');
    this.indent--;
    this.line('}');
    this.line('');
    // InteractiveObject: DisplayObject + mouse/focus interaction flags.
    this.line('void InteractiveObject_ctor(InteractiveObject* o) {');
    this.indent++;
    this.line('DisplayObject_ctor((DisplayObject*)o);');
    this.line('o->mouseEnabled = true;');
    this.line('o->mouseChildren = true;');
    this.line('o->doubleClickEnabled = false;');
    this.line('o->tabEnabled = false;');
    this.line('o->tabIndex = -1;');
    this.line('o->focusRect = false;');
    this.line('o->hasFocus = false;');
    this.indent--;
    this.line('}');
    this.line('InteractiveObject* InteractiveObject_new(void) {');
    this.indent++;
    this.line('InteractiveObject* o = (InteractiveObject*)gc_alloc(GCT_CLASS, sizeof(InteractiveObject));');
    this.line('o->vtable = &InteractiveObject_vt;');
    this.line('InteractiveObject_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('');
    // DisplayObjectContainer: child list as an as_array of boxed DisplayObject*.
    // addChild/removeChild keep each child's `parent` link in sync.
    this.line('void DisplayObjectContainer_ctor(DisplayObjectContainer* o) {');
    this.indent++;
    this.line('InteractiveObject_ctor((InteractiveObject*)o);');
    this.line('o->children = NULL;');
    this.indent--;
    this.line('}');
    this.line('DisplayObjectContainer* DisplayObjectContainer_new(void) {');
    this.indent++;
    this.line('DisplayObjectContainer* o = (DisplayObjectContainer*)gc_alloc(GCT_CLASS, sizeof(DisplayObjectContainer));');
    this.line('o->vtable = &DisplayObjectContainer_vt;');
    this.line('DisplayObjectContainer_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_addChild(void* _this, DisplayObject* child) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) c->children = as_array_new();');
    this.line('as_array_push(c->children, as_v_obj((void*)child));');
    this.line('child->parent = (Object*)_this;');
    this.line('if (DisplayObject_get_stage(_this) != NULL) EventDispatcher_dispatchEvent(child, Event_new((char*)"addedToStage", false, false));');
    this.line('return child;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_addChildAt(void* _this, DisplayObject* child, int index) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) c->children = as_array_new();');
    this.line('if (index < 0) index = 0;');
    this.line('if (index > c->children->length) index = c->children->length;');
    this.line('as_array_ensure(c->children, c->children->length + 1);');
    this.line('for (int i = c->children->length; i > index; i--) c->children->data[i] = c->children->data[i - 1];');
    this.line('c->children->data[index] = as_v_obj((void*)child);');
    this.line('c->children->length++;');
    this.line('child->parent = (Object*)_this;');
    this.line('if (DisplayObject_get_stage(_this) != NULL) EventDispatcher_dispatchEvent(child, Event_new((char*)"addedToStage", false, false));');
    this.line('return child;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_removeChild(void* _this, DisplayObject* child) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) return NULL;');
    this.line('for (int i = 0; i < c->children->length; i++) {');
    this.indent++;
    this.line('if ((DisplayObject*)as_v_obj_val(c->children->data[i]) == child) {');
    this.indent++;
    this.line('for (int j = i; j < c->children->length - 1; j++) c->children->data[j] = c->children->data[j + 1];');
    this.line('c->children->length--;');
    this.line('child->parent = NULL;');
    this.line('return child;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('return NULL;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_removeChildAt(void* _this, int index) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL || index < 0 || index >= c->children->length) return NULL;');
    this.line('DisplayObject* child = (DisplayObject*)as_v_obj_val(c->children->data[index]);');
    this.line('for (int j = index; j < c->children->length - 1; j++) c->children->data[j] = c->children->data[j + 1];');
    this.line('c->children->length--;');
    this.line('child->parent = NULL;');
    this.line('return child;');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_getChildAt(void* _this, int index) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL || index < 0 || index >= c->children->length) return NULL;');
    this.line('return (DisplayObject*)as_v_obj_val(c->children->data[index]);');
    this.indent--;
    this.line('}');
    this.line('DisplayObject* DisplayObjectContainer_getChildByName(void* _this, char* name) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) return NULL;');
    this.line('for (int i = 0; i < c->children->length; i++) {');
    this.indent++;
    this.line('DisplayObject* child = (DisplayObject*)as_v_obj_val(c->children->data[i]);');
    this.line('if (child->name != NULL && strcmp(child->name, name) == 0) return child;');
    this.indent--;
    this.line('}');
    this.line('return NULL;');
    this.indent--;
    this.line('}');
    this.line('bool DisplayObjectContainer_contains(void* _this, DisplayObject* child) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) return false;');
    this.line('for (int i = 0; i < c->children->length; i++) if ((DisplayObject*)as_v_obj_val(c->children->data[i]) == child) return true;');
    this.line('return false;');
    this.indent--;
    this.line('}');
    this.line('void DisplayObjectContainer_setChildIndex(void* _this, DisplayObject* child, int index) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('if (c->children == NULL) return;');
    this.line('int cur = -1;');
    this.line('for (int i = 0; i < c->children->length; i++) if ((DisplayObject*)as_v_obj_val(c->children->data[i]) == child) { cur = i; break; }');
    this.line('if (cur < 0) return;');
    this.line('if (index < 0) index = 0;');
    this.line('if (index >= c->children->length) index = c->children->length - 1;');
    this.line('if (cur == index) return;');
    this.line('as_value v = c->children->data[cur];');
    this.line('if (cur < index) { for (int i = cur; i < index; i++) c->children->data[i] = c->children->data[i + 1]; }');
    this.line('else { for (int i = cur; i > index; i--) c->children->data[i] = c->children->data[i - 1]; }');
    this.line('c->children->data[index] = v;');
    this.indent--;
    this.line('}');
    this.line('int DisplayObjectContainer_get_numChildren(void* _this) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)_this;');
    this.line('return c->children == NULL ? 0 : c->children->length;');
    this.indent--;
    this.line('}');
    this.line('');
    // Stage 41: Stage now carries the desktop AIR stage properties as fields.
    // Defaults match AIR: white background, HIGH quality, TOP_LEFT align,
    // SHOW_ALL scale mode, normal (windowed) display state.
    this.line('void Stage_ctor(Stage* o) {');
    this.indent++;
    this.line('DisplayObjectContainer_ctor((DisplayObjectContainer*)o);');
    this.line('ASC_root_stage = o;');
    this.line('o->stage_w = 0;');
    this.line('o->stage_h = 0;');
    this.line('o->stage_color = 0xFFFFFFu;');
    this.line('o->quality = (char*)"high";');
    this.line('o->align = (char*)"TL";');
    this.line('o->scale_mode = (char*)"showAll";');
    this.line('o->frame_rate = 0.0;'); // 0 = unset -> event loop follows the display refresh rate
    this.line('o->stage_scale = 1.0;');
    this.line('o->display_state = (char*)"normal";');
    this.line('o->stage_focus_rect = false;');
    this.line('o->show_default_context_menu = true;');
    this.line('o->tab_children = true;');
    this.line('o->stage3ds = NULL;');
    this.indent--;
    this.line('}');
    this.line('Stage* Stage_new(void) { Stage* o = (Stage*)gc_alloc(GCT_CLASS, sizeof(Stage)); o->vtable = &Stage_vt; Stage_ctor(o); return o; }');
    this.line('');
    // Stage 41 getters/setters: field-backed accessors (stageWidth/Height/
    // displayState/quality/color/align/scaleMode/frameRate + boolean switches).
    // fullScreenWidth/Height query the display; allowsFullScreen* and
    // contentsScaleFactor are fixed for the desktop AIR profile.
    const stageFieldAccessors: [string, string, string][] = [
      ['stageWidth', 'stage_w', 'int'],
      ['stageHeight', 'stage_h', 'int'],
      ['displayState', 'display_state', 'char*'],
      ['quality', 'quality', 'char*'],
      ['color', 'stage_color', 'unsigned int'],
      ['align', 'align', 'char*'],
      ['scaleMode', 'scale_mode', 'char*'],
      ['frameRate', 'frame_rate', 'double'],
      ['stageFocusRect', 'stage_focus_rect', 'bool'],
      ['showDefaultContextMenu', 'show_default_context_menu', 'bool'],
      ['tabChildren', 'tab_children', 'bool'],
    ];
    for (const [an, cf, ct] of stageFieldAccessors) {
      this.line(`${ct} Stage_get_${an}(void* _this) { return ((Stage*)_this)->${cf}; }`);
    }
    for (const [an, cf, ct] of stageFieldAccessors) {
      this.line(`void Stage_set_${an}(void* _this, ${ct} value) { ((Stage*)_this)->${cf} = value; }`);
    }
    this.line('unsigned int Stage_get_fullScreenWidth(void* _this) { (void)_this; int w = 0, h = 0; as_window_get_display_size(&w, &h); return (unsigned int)w; }');
    this.line('unsigned int Stage_get_fullScreenHeight(void* _this) { (void)_this; int w = 0, h = 0; as_window_get_display_size(&w, &h); return (unsigned int)h; }');
    this.line('bool Stage_get_allowsFullScreen(void* _this) { (void)_this; return true; }');
    this.line('bool Stage_get_allowsFullScreenInteractive(void* _this) { (void)_this; return true; }');
    this.line('double Stage_get_contentsScaleFactor(void* _this) { return ((Stage*)_this)->stage_scale; }');
    this.line('double Stage_get_browserZoomFactor(void* _this) { (void)_this; return 1.0; }');
    this.line('');
    this.line('void Sprite_ctor(Sprite* o) { DisplayObjectContainer_ctor((DisplayObjectContainer*)o); }');
    this.line('Sprite* Sprite_new(void) { Sprite* o = (Sprite*)gc_alloc(GCT_CLASS, sizeof(Sprite)); o->vtable = &Sprite_vt; Sprite_ctor(o); return o; }');
    this.line('');
    // ---- flash.events mouse/keyboard/focus events + hit test (stage 35) ----
    this.line('void MouseEvent_ctor(MouseEvent* o, char* type, bool bubbles, bool cancelable, double localX, double localY, Object* relatedObject, bool ctrlKey, bool altKey, bool shiftKey, bool buttonDown, double delta) {');
    this.indent++;
    this.line('Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('o->localX = localX; o->localY = localY;');
    this.line('o->stageX = 0.0; o->stageY = 0.0;');
    this.line('o->relatedObject = relatedObject;');
    this.line('gc_write_barrier((void*)relatedObject);');
    this.line('o->ctrlKey = ctrlKey; o->altKey = altKey; o->shiftKey = shiftKey;');
    this.line('o->buttonDown = buttonDown; o->delta = delta;');
    this.indent--;
    this.line('}');
    this.line('MouseEvent* MouseEvent_new(char* type, bool bubbles, bool cancelable, double localX, double localY, Object* relatedObject, bool ctrlKey, bool altKey, bool shiftKey, bool buttonDown, double delta) {');
    this.indent++;
    this.line('MouseEvent* o = (MouseEvent*)gc_alloc(GCT_CLASS, sizeof(MouseEvent));');
    this.line('o->vtable = &MouseEvent_vt;');
    this.line('MouseEvent_ctor(o, type, bubbles, cancelable, localX, localY, relatedObject, ctrlKey, altKey, shiftKey, buttonDown, delta);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void KeyboardEvent_ctor(KeyboardEvent* o, char* type, bool bubbles, bool cancelable, int charCode, int keyCode) {');
    this.indent++;
    this.line('Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('o->keyCode = keyCode; o->charCode = charCode;');
    this.indent--;
    this.line('}');
    this.line('KeyboardEvent* KeyboardEvent_new(char* type, bool bubbles, bool cancelable, int charCode, int keyCode) {');
    this.indent++;
    this.line('KeyboardEvent* o = (KeyboardEvent*)gc_alloc(GCT_CLASS, sizeof(KeyboardEvent));');
    this.line('o->vtable = &KeyboardEvent_vt;');
    this.line('KeyboardEvent_ctor(o, type, bubbles, cancelable, charCode, keyCode);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void FocusEvent_ctor(FocusEvent* o, char* type, bool bubbles, bool cancelable, Object* relatedObject, bool shiftKey, int keyCode) {');
    this.indent++;
    this.line('Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('o->keyCode = keyCode; o->relatedObject = relatedObject; o->shiftKey = shiftKey;');
    this.line('gc_write_barrier((void*)relatedObject);');
    this.indent--;
    this.line('}');
    this.line('FocusEvent* FocusEvent_new(char* type, bool bubbles, bool cancelable, Object* relatedObject, bool shiftKey, int keyCode) {');
    this.indent++;
    this.line('FocusEvent* o = (FocusEvent*)gc_alloc(GCT_CLASS, sizeof(FocusEvent));');
    this.line('o->vtable = &FocusEvent_vt;');
    this.line('FocusEvent_ctor(o, type, bubbles, cancelable, relatedObject, shiftKey, keyCode);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('');
    // flash.events event subclasses (stage 59): TimerEvent/ProgressEvent/ErrorEvent/
    // IOErrorEvent/DataEvent. Pure constant classes + a few fields; each reuses
    // Event_ctor for the base fields and adds its own.
    this.line('void TimerEvent_ctor(TimerEvent* o, char* type, bool bubbles, bool cancelable) { Event_ctor((Event*)o, type, bubbles, cancelable); }');
    this.line('TimerEvent* TimerEvent_new(char* type, bool bubbles, bool cancelable) { TimerEvent* o = (TimerEvent*)gc_alloc(GCT_CLASS, sizeof(TimerEvent)); o->vtable = &TimerEvent_vt; TimerEvent_ctor(o, type, bubbles, cancelable); return o; }');
    this.line('void ProgressEvent_ctor(ProgressEvent* o, char* type, bool bubbles, bool cancelable, unsigned int bytesLoaded, unsigned int bytesTotal) { Event_ctor((Event*)o, type, bubbles, cancelable); o->bytesLoaded = bytesLoaded; o->bytesTotal = bytesTotal; }');
    this.line('ProgressEvent* ProgressEvent_new(char* type, bool bubbles, bool cancelable, unsigned int bytesLoaded, unsigned int bytesTotal) { ProgressEvent* o = (ProgressEvent*)gc_alloc(GCT_CLASS, sizeof(ProgressEvent)); o->vtable = &ProgressEvent_vt; ProgressEvent_ctor(o, type, bubbles, cancelable, bytesLoaded, bytesTotal); return o; }');
    this.line('void ErrorEvent_ctor(ErrorEvent* o, char* type, bool bubbles, bool cancelable, char* text) { Event_ctor((Event*)o, type, bubbles, cancelable); o->text = text; gc_write_barrier((void*)text); }');
    this.line('ErrorEvent* ErrorEvent_new(char* type, bool bubbles, bool cancelable, char* text) { ErrorEvent* o = (ErrorEvent*)gc_alloc(GCT_CLASS, sizeof(ErrorEvent)); o->vtable = &ErrorEvent_vt; ErrorEvent_ctor(o, type, bubbles, cancelable, text); return o; }');
    this.line('void IOErrorEvent_ctor(IOErrorEvent* o, char* type, bool bubbles, bool cancelable, char* text) { ErrorEvent_ctor((ErrorEvent*)o, type, bubbles, cancelable, text); o->errorID = 0; }');
    this.line('IOErrorEvent* IOErrorEvent_new(char* type, bool bubbles, bool cancelable, char* text) { IOErrorEvent* o = (IOErrorEvent*)gc_alloc(GCT_CLASS, sizeof(IOErrorEvent)); o->vtable = &IOErrorEvent_vt; IOErrorEvent_ctor(o, type, bubbles, cancelable, text); return o; }');
    this.line('void DataEvent_ctor(DataEvent* o, char* type, bool bubbles, bool cancelable, char* data) { Event_ctor((Event*)o, type, bubbles, cancelable); o->data = data; gc_write_barrier((void*)data); }');
    this.line('DataEvent* DataEvent_new(char* type, bool bubbles, bool cancelable, char* data) { DataEvent* o = (DataEvent*)gc_alloc(GCT_CLASS, sizeof(DataEvent)); o->vtable = &DataEvent_vt; DataEvent_ctor(o, type, bubbles, cancelable, data); return o; }');
    // HTTPStatusEvent (flash.events, AIR): a response that carries a status line
    // reports it before PROGRESS/COMPLETE. `status` is set here; responseURL /
    // responseHeaders / redirected are filled by the URLLoader thunk through
    // URLLoader__statusEvent once the response header block has been parsed.
    this.line('void HTTPStatusEvent_ctor(HTTPStatusEvent* o, char* type, bool bubbles, bool cancelable, int status) {');
    this.indent++;
    this.line('Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('o->status = status;');
    this.line('o->responseURL = (char*)"";');
    this.line('o->responseHeaders = as_array_new(); gc_write_barrier((void*)o->responseHeaders);');
    this.line('o->redirected = false;');
    this.indent--;
    this.line('}');
    this.line('HTTPStatusEvent* HTTPStatusEvent_new(char* type, bool bubbles, bool cancelable, int status) { HTTPStatusEvent* o = (HTTPStatusEvent*)gc_alloc(GCT_CLASS, sizeof(HTTPStatusEvent)); o->vtable = &HTTPStatusEvent_vt; HTTPStatusEvent_ctor(o, type, bubbles, cancelable, status); return o; }');
    this.line('');
    // ---- flash.utils.Timer (stage 60) ----
    // Repeating timer. start() registers into the runtime's as_rep_timers pool;
    // the frame tick calls Timer__on_tick, which dispatches TimerEvent.TIMER, bumps
    // currentCount, and either stops (TIMER_COMPLETE on exhaustion) or re-arms.
    this.line('void Timer_ctor(Timer* o, double delay, int repeatCount) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->delay = 0; o->repeatCount = 0; o->currentCount = 0; o->running = false;');
    // Constructing through the setters validates delay (negative/non-finite)
    // exactly as AIR's Timer constructor does. repeatCount is NOT validated:
    // real AIR only int-truncates the value and keeps negatives as-is.
    this.line('Timer_set_delay((void*)o, delay);');
    this.line('Timer_set_repeatCount((void*)o, repeatCount);');
    this.indent--;
    this.line('}');
    this.line('Timer* Timer_new(double delay, int repeatCount) { Timer* o = (Timer*)gc_alloc(GCT_CLASS, sizeof(Timer)); o->vtable = &Timer_vt; Timer_ctor(o, delay, repeatCount); return o; }');
    this.line('double Timer_get_delay(void* _this) { return ((Timer*)_this)->delay; }');
    this.line('void Timer_set_delay(void* _this, double value) { if (isnan(value) || isinf(value) || value < 0) { as_throw(RangeError_new((char*)"The delay specified is negative or not a finite number", 0)); return; } ((Timer*)_this)->delay = value; }');
    this.line('int Timer_get_repeatCount(void* _this) { return ((Timer*)_this)->repeatCount; }');
    this.line('void Timer_set_repeatCount(void* _this, int value) { ((Timer*)_this)->repeatCount = value; }');
    this.line('int Timer_get_currentCount(void* _this) { return ((Timer*)_this)->currentCount; }');
    this.line('bool Timer_get_running(void* _this) { return ((Timer*)_this)->running; }');
    // Fire callback: re-arm before dispatching so a stop() inside the TIMER handler
    // cancels only the *next* arm, not the current slot. Dispatched events carry the
    // Timer as target via EventDispatcher_dispatchEvent.
    this.line('void Timer__on_tick(void* obj) {');
    this.indent++;
    this.line('Timer* o = (Timer*)obj;');
    this.line('if (!o->running) return;');
    this.line('o->currentCount++;');
    this.line('if (o->repeatCount > 0 && o->currentCount >= o->repeatCount) o->running = false;');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)TimerEvent_new((char*)"timer", false, false));');
    this.line('if (o->repeatCount > 0 && o->currentCount >= o->repeatCount) { EventDispatcher_dispatchEvent((void*)o, (Event*)TimerEvent_new((char*)"timerComplete", false, false)); return; }');
    this.line('if (o->running) as_rep_timer_add(o, o->delay, Timer__on_tick);');
    this.indent--;
    this.line('}');
    this.line('void Timer_start(void* _this) { Timer* o = (Timer*)_this; if (o->running) return; o->running = true; as_rep_timer_add(o, o->delay, Timer__on_tick); }');
    this.line('void Timer_stop(void* _this) { Timer* o = (Timer*)_this; o->running = false; as_rep_timer_cancel(o); }');
    this.line('void Timer_reset(void* _this) { Timer* o = (Timer*)_this; o->running = false; as_rep_timer_cancel(o); o->currentCount = 0; }');
    this.line('');
    // ---- flash.display additions (stage 62): MovieClip / SimpleButton / Loader / LoaderInfo ----
    //
    // MovieClip: a frame timeline. play()/gotoAndPlay() register the clip into the
    // runtime as_mc_* pool; the frame tick calls MovieClip__on_frame, which bumps
    // currentFrame and wraps to 1 past totalFrames (a looping timeline). stop()/
    // gotoAndStop() cancel the pool slot.
    // Real AIR: a freshly constructed (frameless) MovieClip has currentFrame == 0
    // (the playhead sits on no frame yet) and totalFrames == 1 (the minimum).
    this.line('void MovieClip_ctor(MovieClip* o) {');
    this.indent++;
    this.line('Sprite_ctor((Sprite*)o);');
    // MovieClip is a DYNAMIC class in AS3 (adl-verified: `mc.foo = 1` succeeds and
    // `mc.foo` reads back, whereas the same on a Sprite is ReferenceError #1056).
    // Arbitrary keys therefore need the `_dyn` slot table allocated up front.
    this.line('o->_dyn = as_object_new();');
    this.line('gc_write_barrier((void*)o->_dyn);');
    this.line('o->currentFrame = 0; o->totalFrames = 1; o->playing = false;');
    this.indent--;
    this.line('}');
    this.line('MovieClip* MovieClip_new(void) { MovieClip* o = (MovieClip*)gc_alloc(GCT_CLASS, sizeof(MovieClip)); o->vtable = &MovieClip_vt; MovieClip_ctor(o); return o; }');
    this.line('int MovieClip_get_currentFrame(void* _this) { return ((MovieClip*)_this)->currentFrame; }');
    this.line('int MovieClip_get_totalFrames(void* _this) { return ((MovieClip*)_this)->totalFrames; }');
    // totalFrames is writable in this subset (no symbol timeline); a value < 1 is
    // rejected like AIR rejects an empty timeline.
    this.line('void MovieClip_set_totalFrames(void* _this, int value) { if (value < 1) { as_throw(RangeError_new((char*)"The totalFrames specified is less than 1", 0)); return; } ((MovieClip*)_this)->totalFrames = value; }');
    this.line('void MovieClip__on_frame(void* obj) { MovieClip* o = (MovieClip*)obj; if (!o->playing) return; o->currentFrame++; if (o->currentFrame > o->totalFrames) o->currentFrame = 1; }');
    this.line('void MovieClip_play(void* _this) { MovieClip* o = (MovieClip*)_this; o->playing = true; as_mc_add(o, MovieClip__on_frame); }');
    this.line('void MovieClip_stop(void* _this) { MovieClip* o = (MovieClip*)_this; o->playing = false; as_mc_cancel(o); }');
    this.line('void MovieClip_gotoAndPlay(void* _this, int frame) { MovieClip* o = (MovieClip*)_this; if (frame < 1) frame = 1; if (frame > o->totalFrames) frame = o->totalFrames; o->currentFrame = frame; o->playing = true; as_mc_add(o, MovieClip__on_frame); }');
    this.line('void MovieClip_gotoAndStop(void* _this, int frame) { MovieClip* o = (MovieClip*)_this; if (frame < 1) frame = 1; if (frame > o->totalFrames) frame = o->totalFrames; o->currentFrame = frame; o->playing = false; as_mc_cancel(o); }');
    this.line('');
    // SimpleButton: a four-state InteractiveObject. The states are DisplayObject
    // references (GC-managed, write-barriered). Visual state switching on mouse
    // events is deferred; hit-test treats it as a leaf via its own bounds.
    this.line('void SimpleButton_ctor(SimpleButton* o, DisplayObject* upState, DisplayObject* overState, DisplayObject* downState, DisplayObject* hitTestState) {');
    this.indent++;
    this.line('InteractiveObject_ctor((InteractiveObject*)o);');
    this.line('o->upState = upState; o->overState = overState; o->downState = downState; o->hitTestState = hitTestState;');
    this.line('gc_write_barrier((void*)upState); gc_write_barrier((void*)overState); gc_write_barrier((void*)downState); gc_write_barrier((void*)hitTestState);');
    this.indent--;
    this.line('}');
    this.line('SimpleButton* SimpleButton_new(DisplayObject* upState, DisplayObject* overState, DisplayObject* downState, DisplayObject* hitTestState) { SimpleButton* o = (SimpleButton*)gc_alloc(GCT_CLASS, sizeof(SimpleButton)); o->vtable = &SimpleButton_vt; SimpleButton_ctor(o, upState, overState, downState, hitTestState); return o; }');
    this.line('');
    // LoaderInfo: load metadata. url is a GC-managed string (write-barriered on
    // assignment); bytesLoaded/bytesTotal are plain unsigned scalars.
    this.line('void LoaderInfo_ctor(LoaderInfo* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->bytesLoaded = 0; o->bytesTotal = 0; o->url = NULL; o->loader = NULL;');
    this.indent--;
    this.line('}');
    this.line('LoaderInfo* LoaderInfo_new(void) { LoaderInfo* o = (LoaderInfo*)gc_alloc(GCT_CLASS, sizeof(LoaderInfo)); o->vtable = &LoaderInfo_vt; LoaderInfo_ctor(o); return o; }');
    // AS3 LoaderInfo.content: the loaded content (a Bitmap for image loads),
    // reached through the back-referenced owning Loader. Returns NULL when the
    // LoaderInfo is standalone or no content has been loaded yet.
    this.line('DisplayObject* LoaderInfo_get_content(void* _this) { LoaderInfo* o = (LoaderInfo*)_this; return (o->loader != NULL) ? o->loader->content : NULL; }');
    this.line('');
    // Loader: a DisplayObjectContainer holding loaded content. contentLoaderInfo is
    // created at construction (never null, matching AIR) and its `loader` field
    // back-references this Loader (AS3 LoaderInfo.loader), write-barriered so the
    // cycle Loader <-> LoaderInfo is correctly traced by the GC.
    this.line('void Loader_ctor(Loader* o) {');
    this.indent++;
    this.line('DisplayObjectContainer_ctor((DisplayObjectContainer*)o);');
    this.line('o->content = NULL; o->contentLoaderInfo = LoaderInfo_new();');
    this.line('gc_write_barrier((void*)o->contentLoaderInfo);');
    this.line('o->contentLoaderInfo->loader = o;');
    this.line('gc_write_barrier((void*)o);');
    this.indent--;
    this.line('}');
    this.line('Loader* Loader_new(void) { Loader* o = (Loader*)gc_alloc(GCT_CLASS, sizeof(Loader)); o->vtable = &Loader_vt; Loader_ctor(o); return o; }');
    this.line('DisplayObject* Loader_get_content(void* _this) { return ((Loader*)_this)->content; }');
    this.line('LoaderInfo* Loader_get_contentLoaderInfo(void* _this) { return ((Loader*)_this)->contentLoaderInfo; }');
    // Completion thunk, run on the AS3 thread inside a frame boundary: adopt the
    // staged decode result as `content`, publish the byte counts on the
    // LoaderInfo and only then dispatch COMPLETE. Shared by load() (decode a URL)
    // and loadBytes() (decode an in-memory ByteArray) — both produce a Bitmap.
    // Before, the decode ran inside load()/loadBytes() and `content` was already
    // set when those returned; AIR leaves it null until COMPLETE.
    this.line('static void Loader__imageFinish(void* job) {');
    this.indent++;
    this.line('Loader* o = (Loader*)as_job_obj(job);');
    this.line('LoaderInfo* li = o->contentLoaderInfo;');
    this.line('int err = as_job_error(job);');
    this.line('li->bytesLoaded = as_job_total(job);');
    this.line('li->bytesTotal = as_job_total(job);');
    this.line('if (err != 0) {');
    this.indent++;
    this.line('const char* msg = as_job_error_text(job, (char*)"Loader: network URLs are not supported in this build (no HTTP backend linked; see docs/zh-cn/flash-net.md)", (char*)"Loader load failed");');
    // AIR reports a URL that cannot be read as IOErrorEvent.IO_ERROR on the
    // LoaderInfo, never as COMPLETE, and it reports an undecodable payload
    // (Loader.loadBytes with a non-image) as an IO_ERROR too. Neither may fall
    // through to a Bitmap: publishing a 0x0 content would be a silently wrong
    // result.
    //
    // The event carries AIR's NUMBER as well as its sentence (2035 local file
    // not found / 2036 transport or HTTP >= 400 / 2124 undecodable payload):
    // code branches on e.errorID, and a bare id=0 with a hand-written sentence
    // told the caller nothing it could test against.
    this.line('int eid = as_job_loader_ioerror_id(job);');
    this.line('if (eid != 0) msg = as_ioerror_text(li->url, eid, as_job_err_detail(job));');
    this.line('IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, (char*)msg);');
    this.line('ev->errorID = eid;');
    this.line('EventDispatcher_dispatchEvent((void*)li, (Event*)ev);');
    this.line('return;');
    this.indent--;
    this.line('}');
    this.line('BitmapData* bd = BitmapData_new(0, 0, true, 0);');
    this.line('int w = as_job_width(job), h = as_job_height(job);');
    this.line('void* px = as_job_pixels(job);');
    // The glue returns a malloc'd ARGB buffer (it cannot call into the GC heap);
    // move it into a GC-owned buffer so `pixels` has exactly one owner and is
    // reclaimed with the BitmapData instead of leaking per decoded image. A
    // decode failure (err == AS_JOB_ERR_DECODE) leaves the blank buffer in
    // place, which keeps this subset's pre-existing decode-failure behaviour.
    // Ownership: the staged buffer is NOT freed here - the job still owns it and
    // as_job_retire() releases it when the frame boundary retires the job. The
    // BitmapData's OWN previous buffer is likewise never free()d (it is a GC
    // buffer); this bitmap is built 0x0 so there is nothing to drop, but the
    // rule is why no free(bd->pixels) appears here -- see BitmapData_loadFile.
    this.line('if (px != NULL && w > 0 && h > 0) { unsigned* gcpx = (unsigned*)gc_alloc(GCT_BYTES, sizeof(unsigned) * (size_t)(w * h)); memcpy(gcpx, px, sizeof(unsigned) * (size_t)(w * h)); bd->pixels = (void*)gcpx; gc_write_barrier(bd->pixels); bd->width = w; bd->height = h; }');
    // BitmapData_loadFile also keeps an SkImage view for the display-list Bitmap
    // render path; reproduce that here. The SkImage is a deferred (lazy) wrapper,
    // so this is a cheap wrap, not a second decode.
    // The display-list Bitmap draws from an SkImage view (as_render_object_content),
    // not from the CPU pixel buffer. A local load re-opens the file by name; a
    // fetched http(s):// URL has no file to name, so its view is built from the
    // encoded bytes the job still holds (AS_JOB_IMAGE_URL keeps them for exactly
    // this reason). Payload first, file second: an in-memory payload is the more
    // specific answer whenever there is one.
    this.line('const void* enc = as_job_bytes(job);');
    this.line('unsigned enc_len = as_job_len(job);');
    this.line('if (enc != NULL && enc_len > 0) bd->image = as_skia_image_from_bytes(enc, enc_len);');
    this.line('else if (li->url != NULL) bd->image = as_skia_image_from_file(li->url);');
    this.line('Bitmap* bmp = Bitmap_new(bd);');
    this.line('o->content = (DisplayObject*)bmp;');
    this.line('gc_write_barrier((void*)bmp);');
    // AIR adds the loaded content as the Loader's OWN child (loader.numChildren
    // == 1, and the content's parent is the Loader). That is not a cosmetic
    // detail: a Loader is a DisplayObjectContainer and the renderer walks
    // containers' children, so content that is only reachable through
    // loader.content draws nothing at all. It also makes the content dispatch
    // addedToStage when the Loader is already on the stage, like AIR.
    this.line('DisplayObjectContainer_addChildAt((void*)o, (DisplayObject*)bmp, 0);');
    this.line('EventDispatcher_dispatchEvent((void*)li, (Event*)Event_new((char*)"complete", false, false));');
    this.indent--;
    this.line('}');
    this.line('void Loader_load(void* _this, URLRequest* request) {');
    this.indent++;
    this.line('Loader* o = (Loader*)_this;');
    this.line('LoaderInfo* li = o->contentLoaderInfo;');
    this.line('char* url = (request != NULL) ? request->url : NULL;');
    this.line('li->url = url; gc_write_barrier((void*)url);');
    this.line('li->bytesLoaded = 0; li->bytesTotal = 0;');
    // AIR nulls `content` for the duration of the load and dispatches Event.INIT
    // synchronously; the decode + COMPLETE arrive via the job's finish thunk.
    this.line('o->content = NULL; gc_write_barrier((void*)o->content);');
    // The transport is chosen from the URL inside the runtime (a local path is a
    // file read, http(s):// is the HTTP job), so this line stays one call.
    this.line('if (url != NULL) as_async_submit_image((void*)o, Loader__imageFinish, url);');
    this.line('EventDispatcher_dispatchEvent((void*)li, (Event*)Event_new((char*)"init", false, false));');
    this.indent--;
    this.line('}');
    // unload() detaches the content the way AIR does: the loaded child leaves the
    // Loader's child list (and so stops rendering) and content goes back to null.
    this.line('void Loader_unload(void* _this) { Loader* o = (Loader*)_this; if (o->content != NULL) DisplayObjectContainer_removeChild((void*)o, o->content); o->content = NULL; }');
    this.line('void Loader_loadBytes(void* _this, ByteArray* bytes, LoaderContext* context) {');
    this.indent++;
    this.line('Loader* o = (Loader*)_this;');
    this.line('(void)context;');
    this.line('LoaderInfo* li = o->contentLoaderInfo;');
    this.line('li->url = NULL; gc_write_barrier(NULL);');
    this.line('li->bytesLoaded = 0; li->bytesTotal = 0;');
    this.line('o->content = NULL; gc_write_barrier((void*)o->content);');
    // Decode the byte buffer into a Bitmap content, mirroring Loader_load(): AIR
    // also decodes loadBytes into a Bitmap, so the COMPLETE handler can read
    // loader.content as Bitmap without a NULL deref. The bytes are copied into
    // the job at submit time, so the caller may clear/dispose the ByteArray (as
    // Starling's AssetManager does) while the decode is still in flight.
    this.line('as_async_submit_bytes(AS_JOB_DECODE, (void*)o, Loader__imageFinish, (bytes != NULL) ? bytes->data : NULL, (bytes != NULL) ? (size_t)bytes->length : 0);');
    this.line('EventDispatcher_dispatchEvent((void*)li, (Event*)Event_new((char*)"init", false, false));');
    this.indent--;
    this.line('}');
    this.line('');
    // flash.system.LoaderContext: plain value bundle (stage 93). The constructor
    // takes a single optional checkPolicyFile; imageDecodingPolicy defaults to
    // "onDemand" (the AIR default). No policy engine — the demo only reads/writes
    // the fields.
    this.line('void LoaderContext_ctor(LoaderContext* o, bool checkPolicyFile) {');
    this.indent++;
    this.line('Object_ctor((Object*)o);');
    this.line('o->checkPolicyFile = checkPolicyFile;');
    this.line('o->imageDecodingPolicy = (char*)"onDemand";');
    this.indent--;
    this.line('}');
    this.line('LoaderContext* LoaderContext_new(bool checkPolicyFile) {');
    this.indent++;
    this.line('LoaderContext* o = (LoaderContext*)gc_alloc(GCT_CLASS, sizeof(LoaderContext));');
    this.line('o->vtable = &LoaderContext_vt;');
    this.line('LoaderContext_ctor(o, checkPolicyFile);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.media (stage 93): Sound / SoundChannel / SoundTransform ----
    // Audio playback is a no-op in this subset (no audio backend); the objects
    // exist so Starling's SoundFactory/AssetManager compile. `play` returns a
    // fresh SoundChannel, `loadCompressed...` / `stop` are no-ops.
    this.line('void SoundTransform_ctor(SoundTransform* o, double volume, double pan) { o->volume = volume; o->pan = pan; }');
    this.line('SoundTransform* SoundTransform_new(double volume, double pan) { SoundTransform* o = (SoundTransform*)gc_alloc(GCT_CLASS, sizeof(SoundTransform)); o->vtable = &SoundTransform_vt; SoundTransform_ctor(o, volume, pan); return o; }');
    this.line('void Sound_ctor(Sound* o) { EventDispatcher_ctor((EventDispatcher*)o); }');
    this.line('Sound* Sound_new(void) { Sound* o = (Sound*)gc_alloc(GCT_CLASS, sizeof(Sound)); o->vtable = &Sound_vt; Sound_ctor(o); return o; }');
    this.line('SoundChannel* Sound_play(void* _this, double startTime, int loops, SoundTransform* transform) { (void)_this; (void)startTime; (void)loops; (void)transform; return SoundChannel_new(); }');
    this.line('void Sound_loadCompressedDataFromByteArray(void* _this, ByteArray* bytes, unsigned int length) { (void)_this; (void)bytes; (void)length; }');
    this.line('void SoundChannel_ctor(SoundChannel* o) { EventDispatcher_ctor((EventDispatcher*)o); }');
    this.line('SoundChannel* SoundChannel_new(void) { SoundChannel* o = (SoundChannel*)gc_alloc(GCT_CLASS, sizeof(SoundChannel)); o->vtable = &SoundChannel_vt; SoundChannel_ctor(o); return o; }');
    this.line('void SoundChannel_stop(void* _this) { (void)_this; }');
    this.line('void Camera_ctor(Camera* o) { EventDispatcher_ctor((EventDispatcher*)o); }');
    this.line('Camera* Camera_new(void) { Camera* o = (Camera*)gc_alloc(GCT_CLASS, sizeof(Camera)); o->vtable = &Camera_vt; Camera_ctor(o); return o; }');
    this.line('Camera* Camera_getCamera_static(char* name) { (void)name; return NULL; }');
    this.line('');
    // ---- flash.net / flash.ui (stage 63): URLRequest / URLLoader / Keyboard / Mouse ----
    //
    // Note: the staged read buffer used to be produced here by as_read_file (a
    // GC-heap string buffer). It moved into the runtime job table
    // (as_job_read_file) because a worker thread must never allocate from the GC
    // heap; the finish thunk copies the payload into a GC string instead.
    this.line('');
    // URLRequest: the value bundle for one HTTP request. Stage 89·48 declares the
    // full AIR property surface, so method/data/requestHeaders are real state
    // instead of write-only decorations (the old deviation: requestHeaders/
    // authenticate/cacheResponse/... did not exist at all).
    // The six members URLRequestDefaults mirrors are "initialized from the
    // URLRequestDefaults.X property" (official docs), read here through that
    // class's static accessors so the AIR default is observable.
    this.line('void URLRequest_ctor(URLRequest* o, char* url) {');
    this.indent++;
    this.line('o->url = url; gc_write_barrier((void*)url);');
    this.line('o->method = (char*)"GET";');
    this.line('o->data = as_v_null();');
    // contentType stays NULL on a fresh URLRequest -- adl-measured. The MIME string
    // the AS3 reference prints as "the default value" is the WIRE default for a
    // request that carries a body (as_http_effective_ctype, runtime.ts), not the
    // property value; writing it here made req.contentType disagree with AIR.
    this.line('o->contentType = NULL;');
    // Adobe's own example calls `request.requestHeaders.push(new URLRequestHeader(...))`
    // on a freshly built request, so this must be a usable empty Array, not NULL.
    this.line('o->requestHeaders = as_array_new(); gc_write_barrier((void*)o->requestHeaders);');
    this.line('o->authenticate = URLRequestDefaults_get_authenticate_static(NULL);');
    this.line('o->cacheResponse = URLRequestDefaults_get_cacheResponse_static(NULL);');
    this.line('o->followRedirects = URLRequestDefaults_get_followRedirects_static(NULL);');
    this.line('o->idleTimeout = URLRequestDefaults_get_idleTimeout_static(NULL);');
    this.line('o->manageCookies = URLRequestDefaults_get_manageCookies_static(NULL);');
    this.line('o->useCache = URLRequestDefaults_get_useCache_static(NULL);');
    this.line('o->userAgent = URLRequestDefaults_get_userAgent_static(NULL); gc_write_barrier((void*)o->userAgent);');
    // SWZ digest: real state, but inert here (this subset has no signed-file
    // cache and does not implement SWZ loading, so nothing consumes it).
    this.line('o->digest = NULL;');
    this.indent--;
    this.line('}');
    this.line('URLRequest* URLRequest_new(char* url) { URLRequest* o = (URLRequest*)gc_alloc(GCT_CLASS, sizeof(URLRequest)); o->vtable = &URLRequest_vt; URLRequest_ctor(o, url); return o; }');
    this.line('URLRequestMethod* URLRequestMethod_new(void) { URLRequestMethod* o = (URLRequestMethod*)gc_alloc(GCT_CLASS, sizeof(URLRequestMethod)); o->vtable = &URLRequestMethod_vt; Object_ctor((Object*)o); return o; }');
    // URLRequestHeader: one name/value HTTP request header. AIR declares both
    // fields as public vars and defaults the constructor to ""/"".
    this.line('void URLRequestHeader_ctor(URLRequestHeader* o, char* name, char* value) {');
    this.indent++;
    this.line('Object_ctor((Object*)o);');
    this.line('o->name = name; gc_write_barrier((void*)name);');
    this.line('o->value = value; gc_write_barrier((void*)value);');
    this.indent--;
    this.line('}');
    this.line('URLRequestHeader* URLRequestHeader_new(char* name, char* value) { URLRequestHeader* o = (URLRequestHeader*)gc_alloc(GCT_CLASS, sizeof(URLRequestHeader)); o->vtable = &URLRequestHeader_vt; URLRequestHeader_ctor(o, name, value); return o; }');
    this.line('');
    // URLRequestDefaults: static defaults backing the six URLRequest properties
    // that AIR documents as "initialized from the URLRequestDefaults.X property".
    // Backed by file-scope C globals instead of AS3 static fields: a declared
    // static field is read through the lazy `<Class>_cinit()` guard, whereas
    // URLRequest_ctor must read these reliably and in any order. The globals are
    // GC roots (userAgent can hold a GC string after an assignment).
    this.line('static bool as_urld_authenticate = true;');
    this.line('static bool as_urld_cache_response = true;');
    this.line('static bool as_urld_follow_redirects = true;');
    this.line('static double as_urld_idle_timeout = 0.0;');
    this.line('static bool as_urld_manage_cookies = true;');
    this.line('static bool as_urld_use_cache = true;');
    // Lazily resolved: as_user_agent_default() is not a constant expression, so it
    // cannot initialize a file-scope pointer. Reading through the accessor keeps
    // the OS-derived default invisible until first use (matching AIR, where the
    // default is "the same user agent string that is used by Flash Player", which
    // differs per OS).
    this.line('static char* as_urld_user_agent = NULL;');
    this.line('bool URLRequestDefaults_get_authenticate_static(void* _this) { (void)_this; return as_urld_authenticate; }');
    this.line('void URLRequestDefaults_set_authenticate_static(void* _this, bool value) { (void)_this; as_urld_authenticate = value; }');
    this.line('bool URLRequestDefaults_get_cacheResponse_static(void* _this) { (void)_this; return as_urld_cache_response; }');
    this.line('void URLRequestDefaults_set_cacheResponse_static(void* _this, bool value) { (void)_this; as_urld_cache_response = value; }');
    this.line('bool URLRequestDefaults_get_followRedirects_static(void* _this) { (void)_this; return as_urld_follow_redirects; }');
    this.line('void URLRequestDefaults_set_followRedirects_static(void* _this, bool value) { (void)_this; as_urld_follow_redirects = value; }');
    this.line('double URLRequestDefaults_get_idleTimeout_static(void* _this) { (void)_this; return as_urld_idle_timeout; }');
    this.line('void URLRequestDefaults_set_idleTimeout_static(void* _this, double value) { (void)_this; as_urld_idle_timeout = value; }');
    this.line('bool URLRequestDefaults_get_manageCookies_static(void* _this) { (void)_this; return as_urld_manage_cookies; }');
    this.line('void URLRequestDefaults_set_manageCookies_static(void* _this, bool value) { (void)_this; as_urld_manage_cookies = value; }');
    this.line('bool URLRequestDefaults_get_useCache_static(void* _this) { (void)_this; return as_urld_use_cache; }');
    this.line('void URLRequestDefaults_set_useCache_static(void* _this, bool value) { (void)_this; as_urld_use_cache = value; }');
    this.line('char* URLRequestDefaults_get_userAgent_static(void* _this) { (void)_this; if (as_urld_user_agent == NULL) as_urld_user_agent = as_user_agent_default(); return as_urld_user_agent; }');
    this.line('void URLRequestDefaults_set_userAgent_static(void* _this, char* value) { (void)_this; as_urld_user_agent = value; gc_write_barrier((void*)value); }');
    this.line('void URLRequestDefaults_ctor(URLRequestDefaults* o) { Object_ctor((Object*)o); }');
    this.line('URLRequestDefaults* URLRequestDefaults_new(void) { URLRequestDefaults* o = (URLRequestDefaults*)gc_alloc(GCT_CLASS, sizeof(URLRequestDefaults)); o->vtable = &URLRequestDefaults_vt; URLRequestDefaults_ctor(o); return o; }');
    this.line('');
    // URL slicing for useRedirectedURL. Three independent cuts of a URL string:
    //   domain : [0, end of "scheme://host[:port]") — everything before the first
    //            '/' that follows the scheme, or the whole string when there is no
    //            path (the bare-directory shape LoaderInfo.url has, which is what
    //            AIR's own useRedirectedURL example passes in);
    //   dir    : [0, last '/'] inclusive — the "entire url, minus the filename";
    //   file   : the remainder after the last '/'.
    this.line('static size_t as_url_domain_end(const char* url) {');
    this.indent++;
    this.line('if (url == NULL) return 0;');
    this.line('const char* p = url;');
    this.line('const char* scheme = strstr(url, "://");');
    this.line('if (scheme != NULL) p = scheme + 3;');
    this.line('const char* slash = strchr(p, \'/\');');
    this.line('return (slash == NULL) ? strlen(url) : (size_t)(slash - url);');
    this.indent--;
    this.line('}');
    this.line('static size_t as_url_dir_end(const char* url) {');
    this.indent++;
    this.line('if (url == NULL) return 0;');
    this.line('const char* last = strrchr(url, \'/\');');
    this.line('return (last == NULL) ? 0 : (size_t)(last - url + 1);');
    this.indent--;
    this.line('}');
    // URLRequest.useRedirectedURL: point a follow-up request at the server a first
    // request was redirected to. AIR 3.8. Documented semantics, in order:
    //   1. substitute the source URL's DOMAIN into this URL (wholeURL=false), or the
    //      source URL's "entire url minus the filename" (wholeURL=true), keeping
    //      this URL's own path/filename;
    //   2. THEN search for `pattern` in the resulting URL and replace it with
    //      `replace` (a String pattern replaces the first occurrence; a RegExp
    //      pattern follows String.replace's own global/ignoreCase flags).
    // AIR additionally short-circuits when this URL's domain is already a prefix of
    // the source domain (an undocumented implementation detail); this subset always
    // applies the documented substitution, which is equivalent for the substantive
    // case and simpler to reason about (see docs/zh-cn/flash-net.md §3.1).
    this.line('void URLRequest_useRedirectedURL(void* _this, URLRequest* sourceRequest, bool wholeURL, as_value pattern, char* replace) {');
    this.indent++;
    this.line('URLRequest* o = (URLRequest*)_this;');
    this.line('if (o->url == NULL || sourceRequest == NULL || sourceRequest->url == NULL) return;');
    this.line('size_t keep = wholeURL ? as_url_dir_end(o->url) : as_url_domain_end(o->url);');
    this.line('size_t take = wholeURL ? as_url_dir_end(sourceRequest->url) : as_url_domain_end(sourceRequest->url);');
    this.line('char* head = as_str_alloc(take + 1);');
    this.line('memcpy(head, sourceRequest->url, take); head[take] = \'\\0\';');
    this.line('char* out = as_str_concat(head, o->url + keep);');
    // Step 2: pattern replacement, applied to the URL the substitution produced.
    this.line('if (pattern.tag == 3) { if (replace != NULL) out = as_str_replace(out, (char*)as_v_str_val(pattern), replace); }');
    this.line('else if (as_v_is_inst(pattern, (void*)&RegExp_vt)) {');
    this.indent++;
    this.line('RegExp* re = (RegExp*)pattern.ptr;');
    this.line('if (replace != NULL && re->compiled != NULL && !re->compiled->err) out = as_str_replace_regex(out, re->compiled, replace, re->global);');
    this.indent--;
    this.line('}');
    this.line('o->url = out; gc_write_barrier((void*)out);');
    this.indent--;
    this.line('}');
    this.line('');
    // URLLoader: asynchronous local-file load. The URL is treated as a filesystem
    // path; the file is read synchronously but OPEN/PROGRESS/COMPLETE/IO_ERROR are
    // deferred to a later frame tick via the async job table, so listeners
    // registered after load() still fire (AIR's async contract). `data` is boxed
    // `as_value`: a GC-managed String for the default text format, a ByteArray when
    // dataFormat == "binary" (Starling's DataLoader relies on this to hand raw
    // bytes to asset factories), or a URLVariables when dataFormat == "variables".
    this.line('void URLLoader_ctor(URLLoader* o, URLRequest* request) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->data = as_v_null(); o->dataFormat = (char*)"text";');
    // AIR: bytesLoaded/bytesTotal read 0 while a load is in progress and only carry
    // the byte count once it completes (the documented reason a caller should read
    // ProgressEvent.bytesLoaded/bytesTotal instead of these properties).
    this.line('o->bytesLoaded = 0; o->bytesTotal = 0;');
    // AIR: a request handed to the constructor starts the load immediately
    // ("If specified, the load operation begins immediately").
    this.line('if (request != NULL) URLLoader_load((void*)o, request);');
    this.indent--;
    this.line('}');
    this.line('URLLoader* URLLoader_new(URLRequest* request) { URLLoader* o = (URLLoader*)gc_alloc(GCT_CLASS, sizeof(URLLoader)); o->vtable = &URLLoader_vt; URLLoader_ctor(o, request); return o; }');
    // Job completion, run on the AS3 thread inside a frame boundary: publish the
    // staged payload into `data` and only then dispatch PROGRESS + COMPLETE. The
    // ordering is the point: `data` stays null until this thunk runs, matching
    // AIR, whereas it used to be filled inside load() (one frame early).
    // Header block -> Array of URLRequestHeader (AIR's HTTPStatusEvent shape). The
    // runtime carries the raw "Name: Value\r\n" block (it cannot construct a
    // generated class), so the split lives here where URLRequestHeader_new is in
    // scope. A line without a ':' is skipped.
    this.line('static as_array* URLLoader__parseHeaders(const char* block) {');
    this.indent++;
    this.line('as_array* arr = as_array_new();');
    this.line('if (block == NULL) return arr;');
    this.line('const char* p = block;');
    this.line('while (*p != \'\\0\') {');
    this.indent++;
    this.line('const char* nl = p; while (*nl != \'\\0\' && *nl != \'\\n\') nl++;');
    this.line('int n = (int)(nl - p); while (n > 0 && p[n - 1] == \'\\r\') n--;');
    this.line('if (n > 0) {');
    this.indent++;
    this.line('char* line = as_str_alloc((size_t)n + 1);');
    this.line('memcpy(line, p, (size_t)n); line[n] = \'\\0\';');
    this.line('char* colon = strchr(line, \':\');');
    this.line('if (colon != NULL) { *colon = \'\\0\'; char* val = colon + 1; while (*val == \' \' || *val == \'\\t\') val++; as_array_push(arr, as_v_obj((void*)URLRequestHeader_new(line, val))); }');
    this.indent--;
    this.line('}');
    this.line('p = (*nl == \'\\0\') ? nl : nl + 1;');
    this.indent--;
    this.line('}');
    this.line('return arr;');
    this.indent--;
    this.line('}');
    // Two status events, because AIR fills them differently (measured with adl):
    //   * httpStatus        - status ONLY: responseURL null, responseHeaders an
    //                         EMPTY array, redirected false. It is also the one
    //                         dispatched for non-HTTP loads, with status 0.
    //   * httpResponseStatus - the full payload (status + responseURL +
    //                         responseHeaders + redirected).
    // responseURL is copied into a GC string there: the job's effective-URL buffer
    // is malloc'd and freed when the job retires, so a raw pointer assigned to an
    // AS3 String would dangle the moment the thunk returns (that produced a
    // garbled responseURL on the first try).
    this.line('static HTTPStatusEvent* URLLoader__httpStatusEvent(char* type, int status) {');
    this.indent++;
    this.line('HTTPStatusEvent* e = HTTPStatusEvent_new(type, false, false, status);');
    this.line('e->responseURL = NULL;');
    this.line('e->responseHeaders = as_array_new(); gc_write_barrier((void*)e->responseHeaders);');
    this.line('e->redirected = false;');
    this.line('return e;');
    this.indent--;
    this.line('}');
    this.line('static HTTPStatusEvent* URLLoader__httpResponseEvent(char* type, int status, char* url, as_array* hdrs, bool redirected) {');
    this.indent++;
    this.line('HTTPStatusEvent* e = HTTPStatusEvent_new(type, false, false, status);');
    this.line('char* u = as_str_alloc(strlen(url) + 1); strcpy(u, url);');
    this.line('e->responseURL = u; gc_write_barrier((void*)u);');
    this.line('e->responseHeaders = hdrs; gc_write_barrier((void*)hdrs);');
    this.line('e->redirected = redirected;');
    this.line('return e;');
    this.indent--;
    this.line('}');
    // Serialize a URLRequest into the pieces the network seam takes, on the AS3
    // thread. Both loaders share it because the rule it enforces is easy to break
    // twice: a worker thread must never walk a GC Array or call anything that
    // allocates from the GC heap, so requestHeaders (an Array of
    // URLRequestHeader) and `data` (String | URLVariables | ByteArray) are turned
    // into plain byte/char buffers here, before the job is published. The two
    // pointers that may reference GC strings ('url', 'headers') stay valid because
    // the submit strdup's them immediately.
    this.line('typedef struct net_req { const char* method; const char* url; const char* headers; const void* body; size_t body_len; } net_req;');
    this.line('static void net__prepare_request(URLRequest* request, net_req* r) {');
    this.indent++;
    this.line('r->method = (request->method != NULL) ? request->method : "GET";');
    this.line('r->headers = (const char*)"";');
    this.line('if (request->requestHeaders != NULL) {');
    this.indent++;
    this.line('for (int i = 0; i < request->requestHeaders->length; i++) {');
    this.indent++;
    this.line('URLRequestHeader* h = (URLRequestHeader*)as_v_obj_val(request->requestHeaders->data[i]);');
    this.line('if (h == NULL || h->name == NULL) continue;');
    this.line('char* line = as_str_concat(as_str_concat(h->name, (char*)": "), (h->value != NULL) ? h->value : (char*)"");');
    this.line('r->headers = as_str_concat(as_str_concat((char*)r->headers, line), (char*)"\\r\\n");');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('char* payload = NULL;');
    this.line('const void* raw_body = NULL;');
    this.line('size_t raw_body_len = 0;');
    this.line('if (request->data.tag != 0 && request->data.tag != 5) {');
    this.indent++;
    this.line('if (as_v_is_inst(request->data, &URLVariables_vt)) payload = URLVariables_toString(as_v_obj_val(request->data));');
    this.line('else if (as_v_is_inst(request->data, &ByteArray_vt)) { ByteArray* b = (ByteArray*)as_v_obj_val(request->data); raw_body = (b != NULL) ? b->data : NULL; raw_body_len = (b != NULL) ? (size_t)b->length : 0; }');
    this.line('else payload = as_v_str_val(request->data);');
    this.indent--;
    this.line('}');
    // GET folds data into the query string (url?data or url&data); POST and every
    // other verb send it as the body. AIR behaves the same, and it is what makes
    // `method` observable at all.
    this.line('r->url = request->url;');
    this.line('r->body = NULL;');
    this.line('r->body_len = 0;');
    this.line('if (strcmp(r->method, "GET") == 0) {');
    this.indent++;
    this.line('if (payload != NULL) { const char* sep = (strchr(request->url, \'?\') != NULL) ? "&" : "?"; r->url = as_str_concat(as_str_concat(request->url, sep), payload); }');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('if (payload != NULL) { r->body = payload; r->body_len = strlen(payload); }');
    this.line('else if (raw_body != NULL) { r->body = raw_body; r->body_len = raw_body_len; }');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // flash.net.navigateToURL / sendToURL: hand the request's URL to the OS. Both
    // are fire-and-forget — the URL is opened outside this process, so there is no
    // response and no event to dispatch (which is precisely what sendToURL's
    // documentation makes its only difference). The `window` parameter only means
    // something to the browser plugin (target frame name); a desktop AIR app hands
    // the URL to the OS handler either way, so it is accepted and ignored.
    this.line('static void URLRequest__navigate(URLRequest* request, char* window) {');
    this.indent++;
    this.line('(void)window;');
    // AIR's parameter validation, verbatim from adl: a null request and a request
    // whose url is null are two DIFFERENT TypeErrors (#2007), not one generic
    // complaint and not a silent no-op.
    this.line('if (request == NULL) { as_throw(TypeError_new((char*)"Error #2007: Parameter request must be non-null.", 2007)); return; }');
    this.line('if (request->url == NULL) { as_throw(TypeError_new((char*)"Error #2007: Parameter url must be non-null.", 2007)); return; }');
    this.line('if (!as_open_external(request->url)) { as_throw(Error_new((char*)"Error #2032: The navigateToURL operation could not be completed.", 2032)); return; }');
    this.indent--;
    this.line('}');
    this.line('static void URLRequest__sendToURL(URLRequest* request) { URLRequest__navigate(request, NULL); }');
    // Publish the staged payload into `data`, honouring dataFormat. Shared by the
    // success path (payload bytes) and the failure path (no bytes): AIR does not
    // leave `data` null after a failed load — it becomes an EMPTY String or
    // ByteArray (adl: data=String len=0 / ByteArray len=0), which is what callers
    // that switch on dataFormat expect.
    this.line('static void URLLoader__publish(URLLoader* o, const unsigned char* src, unsigned n, int binary) {');
    this.indent++;
    this.line('if (binary) {');
    this.indent++;
    // BINARY: raw bytes into a ByteArray. The staged buffer is NOT NUL-terminated
    // and may hold embedded NULs (PNG/ATF/MP3), so it is copied by length rather
    // than as a string.
    this.line('ByteArray* ba = ByteArray_new();');
    this.line('ba->data = (void*)gc_alloc(GCT_BYTES, (size_t)(n > 0 ? n : 1));');
    this.line('ba->capacity = (int)n; ba->length = (int)n;');
    this.line('if (n > 0) memcpy(ba->data, src, (size_t)n);');
    this.line('gc_write_barrier((void*)ba->data);');
    this.line('o->data = as_v_obj((void*)ba);');
    this.indent--;
    this.line('} else if (o->dataFormat != NULL && strcmp(o->dataFormat, "variables") == 0) {');
    this.indent++;
    // VARIABLES: decode the payload into a URLVariables object (the read side of
    // URLVariables.toString) — the one dataFormat where data is neither String nor
    // ByteArray, matching AIR.
    this.line('char* vs = as_str_alloc((size_t)n + 1);');
    this.line('if (n > 0) memcpy(vs, src, (size_t)n);');
    this.line('vs[n] = \'\\0\';');
    this.line('o->data = as_v_obj((void*)URLVariables_new(vs));');
    this.indent--;
    this.line('} else {');
    this.indent++;
    // TEXT: copied into a GC-managed string buffer so the string owns its data
    // (the job buffer is freed when the job retires).
    this.line('char* s = as_str_alloc((size_t)n + 1);');
    this.line('if (n > 0) memcpy(s, src, (size_t)n);');
    this.line('s[n] = \'\\0\';');
    this.line('o->data = as_v_str(s);');
    this.indent--;
    this.line('}');
    this.line('gc_write_barrier_value(o->data);');
    this.indent--;
    this.line('}');
    this.line('static int URLLoader__isBinary(URLLoader* o) { return o->dataFormat != NULL && strcmp(o->dataFormat, "binary") == 0; }');
    // The events AIR raises WHILE a transfer is in flight, shared by URLLoader and
    // URLStream (adl measures the same sequence for both):
    //
    //   open                once the request reached the transport
    //   httpResponseStatus  once a response head arrived — the ONLY event carrying
    //                       responseHeaders / responseURL / redirected
    //   progress            per recorded watermark, with Content-Length as
    //                       bytesTotal (0 when the response did not state one)
    //
    // Driven from as_async_tick (see as_net_pre_events there) so a streaming caller
    // really does get PROGRESS while a slow body is still arriving, and called again
    // by the finish thunk: every step is guarded by a flag on the job, so a load
    // that completed before any tick still reports the same events, in the same
    // order, exactly once.
    this.line('static void as_net_pre_events(void* job) {');
    this.indent++;
    this.line('void* obj = as_job_obj(job);');
    this.line('if (obj == NULL) return;');
    this.line('if (!as_job_sent_open(job) && as_job_started(job)) {');
    this.indent++;
    this.line('as_job_set_sent_open(job);');
    this.line('EventDispatcher_dispatchEvent(obj, (Event*)Event_new((char*)"open", false, false));');
    this.indent--;
    this.line('}');
    this.line('if (!as_job_sent_status(job)) {');
    this.indent++;
    this.line('int st = as_job_status(job);');
    this.line('if (st > 0) {');
    this.indent++;
    this.line('as_job_set_sent_status(job);');
    this.line('as_array* hdrs = URLLoader__parseHeaders(as_job_headers(job));');
    this.line('EventDispatcher_dispatchEvent(obj, (Event*)URLLoader__httpResponseEvent((char*)"httpResponseStatus", st, (char*)as_job_eff_url(job), hdrs, as_job_redirected(job) != 0));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('unsigned expected = as_job_expected_total(job);');
    this.line('unsigned sent = as_job_marks_sent(job);');
    this.line('unsigned mc = (unsigned)as_job_mark_count(job);');
    this.line('while (sent < mc) {');
    this.indent++;
    this.line('unsigned loaded = as_job_mark(job, (int)sent);');
    this.line('sent++;');
    this.line('as_job_set_marks_sent(job, sent);');
    this.line('as_job_set_last_progress(job, loaded);');
    this.line('EventDispatcher_dispatchEvent(obj, (Event*)ProgressEvent_new((char*)"progress", false, false, loaded, expected));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // Job completion, run on the AS3 thread inside a frame boundary.
    //
    // The event order and payloads here follow what `adl` actually does (measured
    // with temp/air-probe, see docs/zh-cn/flash-net.md §6.7), not what the docs
    // suggest at a glance:
    //
    //   OPEN                      only when the request reached the transport (a
    //                             refused connection still opens; a missing LOCAL
    //                             file never opens, and an unlinked backend issues
    //                             no request at all)
    //   httpResponseStatus        if a response head arrived: the ONLY event that
    //                             carries responseHeaders / responseURL / redirected
    //   progress (replayed)       the watermarks the backend recorded
    //   [data published]          so a PROGRESS listener still sees data == null
    //   httpStatus                status only — and it fires even for a non-HTTP
    //                             load, with status 0
    //   complete | ioError(#2032) a non-2xx response (status >= 300) is an ERROR
    //                             response, and AIR's terminal for it depends on
    //                             the CALLER: if that object registered an
    //                             HTTP_RESPONSE_STATUS listener, the error body is
    //                             a successful load (COMPLETE); if not, AIR
    //                             reports ioError #2032. Everything BEFORE the
    //                             terminal — progress, the published body,
    //                             bytesLoaded/bytesTotal, httpStatus — is
    //                             IDENTICAL on both branches (the error body is
    //                             published either way). Not a transport failure
    //                             either way; ioError #2032 is not reserved for
    //                             refused connections/DNS/TLS.
    //                             Measured controlled (same URL, same server, only
    //                             the listener toggled) in temp/httpstatus-probe;
    //                             see docs/zh-cn/flash-net.md §6.2.
    this.line('static void URLLoader__finish(void* job) {');
    this.indent++;
    this.line('URLLoader* o = (URLLoader*)as_job_obj(job);');
    // Whatever is still owed from the in-flight sequence (OPEN, httpResponseStatus,
    // the PROGRESS watermarks): a fast local read gets all of it here, a slow body
    // already got it from as_async_tick. Same order either way.
    this.line('as_net_pre_events(job);');
    // A failure names its cause. "Unsupported" is what an http(s):// load reports
    // when no HTTP backend is linked (phase G of the design doc): it must NOT be
    // the same text a missing local file produces, or the caller cannot tell a
    // typo from an unimplemented transport.
    this.line('if (as_job_failed(job)) {');
    this.indent++;
    // A failure names its cause AND AIR's number (2032 "Stream Error" for both
    // URLLoader and URLStream - measured against adl; a bare id=0 is not
    // something a caller can branch on). "Unsupported" keeps the build-level
    // text instead: an http(s):// load with no HTTP backend linked (phase G of
    // the design doc) has no AIR counterpart, so it reports no number.
    this.line('char* msg = as_job_error_text(job, (char*)"URLLoader: network URLs are not supported in this build (no HTTP backend linked; see docs/zh-cn/flash-net.md)", (char*)"URLLoader load failed");');
    this.line('int eid = (as_job_error(job) == AS_JOB_ERR_UNSUPPORTED) ? 0 : 2032;');
    this.line('if (eid != 0) msg = as_ioerror_text(as_job_path(job), eid, as_job_err_detail(job));');
    // AIR dispatches a status-0 httpStatus before the ioError and leaves `data` an
    // EMPTY value rather than null (probe 8: data=String len=0 on a failed load).
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)URLLoader__httpStatusEvent((char*)"httpStatus", 0));');
    this.line('URLLoader__publish(o, NULL, 0, URLLoader__isBinary(o));');
    this.line('IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, msg);');
    this.line('ev->errorID = eid;');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ev);');
    this.line('return;');
    this.indent--;
    this.line('}');
    this.line('unsigned total = as_job_len(job);');
    this.line('unsigned btotal = as_job_expected_total(job);');
    // The final PROGRESS. It is skipped when the last watermark already reported
    // the full length (a chunked body's last mark IS the total, and AIR does not
    // repeat it), and emitted when there was no watermark at all (a local read) or
    // the last one fell short. bytesTotal is Content-Length — or a local file's
    // size — and 0 when the response did not state one: AIR reports 160000/0 for a
    // chunked body rather than inventing a total.
    // A zero-length body reports NO progress at all: AIR emits
    // open;httpStatus(200);complete for a 200 with an empty body (and
    // open;httpStatus(404);ioError for an empty 404) — measured with a fresh
    // server in temp/httpstatus-probe2. Hence the total > 0 guard.
    this.line('if (total > 0 && (as_job_marks_sent(job) == 0 || as_job_last_progress(job) != total)) {');
    this.indent++;
    this.line('as_job_set_last_progress(job, total);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ProgressEvent_new((char*)"progress", false, false, total, btotal));');
    this.indent--;
    this.line('}');
    this.line('o->bytesLoaded = total; o->bytesTotal = btotal;');
    this.line('URLLoader__publish(o, as_job_bytes(job), total, as_job_is_binary(job));');
    // Published after PROGRESS and before COMPLETE: the two counters are documented
    // as 0 for the whole duration of a load, so a PROGRESS listener reading
    // loader.bytesTotal still sees 0 and uses event.bytesLoaded/bytesTotal.
    this.line('int st = as_job_status(job);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)URLLoader__httpStatusEvent((char*)"httpStatus", st));');
    // AIR's terminal split for a non-2xx response (see the event-order note above
    // and docs/zh-cn/flash-net.md §6.2): with a HTTP_RESPONSE_STATUS listener the
    // error body completes; without one the very same transfer ends in
    // ioError #2032. `hasEventListener` is the same predicate AIR uses — it counts
    // a listener in either phase — and status 0 (a local read, a non-HTTP load)
    // must NOT take this branch, hence the >= 300 test rather than "!= 200".
    this.line('if (st >= 300 && !EventDispatcher_hasEventListener((void*)o, (char*)"httpResponseStatus")) {');
    this.indent++;
    this.line('IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, as_ioerror_text(as_job_path(job), 2032, NULL));');
    this.line('ev->errorID = 2032;');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ev);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"complete", false, false));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('void URLLoader_load(void* _this, URLRequest* request) {');
    this.indent++;
    this.line('URLLoader* o = (URLLoader*)_this;');
    this.line('o->data = as_v_null();');
    // A new load restarts the byte counters (AIR: 0 for as long as it is in flight).
    this.line('o->bytesLoaded = 0; o->bytesTotal = 0;');
    // AIR validates the parameters instead of quietly doing nothing: load(null) and
    // load(new URLRequest(null)) are two distinct TypeErrors (#2007, verified with
    // adl). Silently returning would leave the caller waiting for an event that can
    // never arrive.
    this.line('if (request == NULL) as_throw(TypeError_new((char*)"Error #2007: Parameter request must be non-null.", 2007));');
    this.line('if (request->url == NULL) as_throw(TypeError_new((char*)"Error #2007: Parameter url must be non-null.", 2007));');
    this.line('const char* url = request->url;');
    this.line('int binary = (o->dataFormat != NULL && strcmp(o->dataFormat, "binary") == 0);');
    // http(s):// is not a path: it goes to the network seam. The backend decides
    // whether the transfer can happen at all (native + ASC_HAVE_CURL) and reports
    // AS_JOB_ERR_UNSUPPORTED otherwise — the URL is never handed to fopen(), which
    // used to make a remote URL indistinguishable from a missing local file.
    this.line('if (strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0) {');
    this.indent++;
    this.line('net_req r; net__prepare_request(request, &r);');
    // Tagged as a flash.net target so the frame-boundary pre-pass dispatches this
    // load's OPEN / HTTP_RESPONSE_STATUS / PROGRESS while it is still in flight.
    this.line('void* j = as_async_submit_http((void*)o, URLLoader__finish, (char*)r.url, r.method, request->userAgent, request->contentType, (char*)r.headers, r.body, r.body_len, binary, request->followRedirects ? 1 : 0, request->idleTimeout, request->manageCookies ? 1 : 0);');
    this.line('if (j != NULL) as_job_set_net_events(j);');
    this.indent--;
    this.line('return;');
    this.line('}');
    // A file:// URL (File.url) is opened from the local filesystem: strip the
    // scheme so fopen sees a plain path (e.g. "file://./assets/x.png" ->
    // "./assets/x.png").
    this.line('const char* path = url;');
    this.line('if (strncmp(path, "file://", 7) == 0) path += 7;');
    // The read runs on a worker thread (native) or inline (web/WASI), but either
    // way the payload is staged and published only by URLLoader__finish at a
    // frame boundary, so several load() calls issued in one frame overlap.
    this.line('void* j = as_async_submit(binary ? AS_JOB_READ_BYTES : AS_JOB_READ_TEXT, (void*)o, URLLoader__finish, path, NULL, binary);');
    this.line('if (j != NULL) as_job_set_net_events(j);');
    this.indent--;
    this.line('}');
    // AIR: "Any load operation in progress is immediately terminated. If no URL is
    // currently being streamed, an invalid stream error is thrown." The cancel
    // marks the pending job dead, so its finish thunk never runs and no OPEN /
    // PROGRESS / COMPLETE / IO_ERROR reaches a listener after close() — which is
    // the entire point of the call (it used to be an empty function).
    this.line('void URLLoader_close(void* _this) {');
    this.indent++;
    this.line('URLLoader* o = (URLLoader*)_this;');
    // AIR's message for URLLoader.close() is word-for-word the URLStream one
    // (measured with adl: id 2029, "This URLStream object does not have a stream
    // opened.") — the two classes share that text.
    this.line('if (!as_async_cancel((void*)o)) as_throw(Error_new((char*)"Error #2029: This URLStream object does not have a stream opened.", 2029));');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.net.URLStream (stage 89·51, phase F) ----
    // The streaming counterpart of URLLoader: the same HTTP seam, but the body is
    // appended into the job as it arrives, so bytesAvailable/read* can see data
    // while a slow transfer is still running instead of after a full buffering.
    //
    // A URLStream owns its job (`_job`), which makes the object responsible for the
    // handle's whole lifetime: close() cancels AND drops it, and URLStream__finish
    // copies the unconsumed remainder onto the object (`_buf`/`_buf_pos`) before
    // dispatching, because the job (and with it the live buffer) is freed by the
    // async tick the moment the thunk returns (phase 3 of as_async_tick). Reading
    // through those two slots instead of the job is what keeps every read* method
    // working after COMPLETE and after the job has been retired.
    this.line('static int URLStream__little(URLStream* o) { return o->endian != NULL && strcmp(o->endian, "littleEndian") == 0; }');
    // IDataInput promises EOFError when there is not enough data to satisfy a
    // read; AIR's text is fixed at #2030.
    this.line('static void URLStream__eof(void) { as_throw(EOFError_new((char*)"Error #2030: End of file was encountered.", 2030)); }');
    // AIR's exact wording and id, taken from adl: every operation that needs a
    // stream (bytesAvailable, read*, close) throws this same Error #2029 when the
    // object was never loaded or was closed.
    this.line('static void URLStream__not_open(void) { as_throw(Error_new((char*)"Error #2029: This URLStream object does not have a stream opened.", 2029)); }');
    // bytesAvailable: the live job while one exists, else the copied-out remainder.
    this.line('int URLStream__avail(URLStream* o) {');
    this.indent++;
    this.line('if (o->_job != NULL) return (int)as_stream_available(o->_job);');
    this.line('if (o->_buf != NULL) { ByteArray* b = (ByteArray*)o->_buf; return b->length - o->_buf_pos; }');
    this.line('return 0;');
    this.indent--;
    this.line('}');
    // The two failure modes AIR distinguishes: "not open at all" (never loaded, or
    // after close()) is a plain Error, while "open but no more data right now" is
    // EOFError. `_buf != NULL` is what separates them: it is set as soon as the
    // stream has opened, even when nothing is left to read.
    this.line('static int URLStream__poll(URLStream* o) {');
    this.indent++;
    this.line('if (o->_job == NULL && o->_buf == NULL) { URLStream__not_open(); return 0; }');
    this.line('return URLStream__avail(o);');
    this.indent--;
    this.line('}');
    // One byte from whichever source is live, or -1 when none is buffered.
    this.line('static int URLStream__get(URLStream* o) {');
    this.indent++;
    this.line('if (o->_job != NULL) return as_stream_get_byte(o->_job);');
    this.line('if (o->_buf != NULL) { ByteArray* b = (ByteArray*)o->_buf; if (o->_buf_pos >= b->length) return -1; return (int)((unsigned char*)b->data)[o->_buf_pos++]; }');
    this.line('return -1;');
    this.indent--;
    this.line('}');
    this.line('static int URLStream__read(URLStream* o, void* dst, int n) {');
    this.indent++;
    this.line('if (o->_job != NULL) return as_stream_read(o->_job, dst, n);');
    this.line('if (o->_buf != NULL) {');
    this.indent++;
    this.line('ByteArray* b = (ByteArray*)o->_buf;');
    this.line('int avail = b->length - o->_buf_pos;');
    this.line('int k = (n < avail) ? n : avail;');
    this.line('if (k > 0) memcpy(dst, (unsigned char*)b->data + o->_buf_pos, (size_t)k);');
    this.line('o->_buf_pos += k;');
    this.line('return k;');
    this.indent--;
    this.line('}');
    this.line('return 0;');
    this.indent--;
    this.line('}');
    // A read of a fixed number of bytes either finds them all or throws: AIR's
    // read* are non-blocking and never wait for the rest of a chunk.
    this.line('static int URLStream__need(URLStream* o, int n) { return URLStream__poll(o) >= n; }');
    // Multi-byte integers honour `endian` exactly like ByteArray does.
    this.line('static unsigned long long URLStream__uint(URLStream* o, int nbytes) {');
    this.indent++;
    this.line('unsigned char buf[8];');
    this.line('if (!URLStream__need(o, nbytes)) { URLStream__eof(); return 0; }');
    this.line('URLStream__read(o, buf, nbytes);');
    this.line('unsigned long long v = 0;');
    this.line('if (URLStream__little(o)) { for (int i = nbytes - 1; i >= 0; i--) v = (v << 8) | buf[i]; }');
    this.line('else { for (int i = 0; i < nbytes; i++) v = (v << 8) | buf[i]; }');
    this.line('return v;');
    this.indent--;
    this.line('}');
    this.line('void URLStream_ctor(URLStream* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->endian = (char*)"bigEndian";');
    // ObjectEncoding.AMF3: URLStream.readObject is the only consumer and AMF is
    // not implemented in this subset, so this is only the documented default.
    this.line('o->objectEncoding = 3;');
    this.line('o->_job = NULL; o->_buf = NULL; o->_buf_pos = 0;');
    this.indent--;
    this.line('}');
    this.line('URLStream* URLStream_new(void) { URLStream* o = (URLStream*)gc_alloc(GCT_CLASS, sizeof(URLStream)); o->vtable = &URLStream_vt; URLStream_ctor(o); return o; }');
    // "Has a stream" is _job != NULL (a live transfer) OR _buf != NULL (the
    // buffered result of a finished one). adl's state machine, measured:
    //   never loaded / after close()  -> bytesAvailable THROWS #2029
    //   after ioError                 -> 0, reads give EOFError #2030 (the stream
    //                                    is still "opened", just empty)
    //   after COMPLETE                -> the unconsumed remainder, still readable
    //   (and `connected` stays true in all three of the last cases — AIR does not
    //   close the stream when a download ends, only close() does)
    this.line('static bool URLStream__open(URLStream* o) { return o->_job != NULL || o->_buf != NULL; }');
    this.line('unsigned URLStream_get_bytesAvailable(void* _this) { URLStream* o = (URLStream*)_this; if (!URLStream__open(o)) URLStream__not_open(); return (unsigned)URLStream__avail(o); }');
    this.line('bool URLStream_get_connected(void* _this) { return URLStream__open((URLStream*)_this); }');
    this.line('void URLStream_close(void* _this) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)_this;');
    // AIR: "No data can be read from the stream after close()". The handle is
    // dropped HERE and not merely cancelled: the cancelled job is retired by the
    // next tick (phase 3 of as_async_tick), so a surviving `_job` would dangle the
    // moment a listener on this thread touched it.
    this.line('if (!URLStream__open(o)) { URLStream__not_open(); return; }');
    this.line('if (o->_job != NULL) as_async_cancel((void*)o);');
    this.line('o->_job = NULL;');
    this.line('o->_buf = NULL; o->_buf_pos = 0;');
    this.indent--;
    this.line('}');
    // Completion thunk, on the AS3 thread inside a frame boundary. The remainder
    // is copied out BEFORE the terminal events so a listener (or code after the
    // load) can keep reading; the watermarks recorded by the worker's write
    // callback are replayed as PROGRESS, exactly as URLLoader does.
    this.line('static void URLStream__drain(URLStream* o) {');
    this.indent++;
    this.line('if (o->_job == NULL) return;');
    this.line('unsigned n = (unsigned)as_stream_available(o->_job);');
    this.line('ByteArray* b = ByteArray_new();');
    this.line('if (n > 0) {');
    this.indent++;
    this.line('b->data = (void*)gc_alloc(GCT_BYTES, (size_t)n);');
    this.line('as_stream_read(o->_job, b->data, (int)n);');
    this.line('b->capacity = (int)n; b->length = (int)n;');
    this.line('gc_write_barrier((void*)b->data);');
    this.indent--;
    this.line('}');
    this.line('o->_buf = (void*)b; o->_buf_pos = 0;');
    this.line('gc_write_barrier((void*)b);');
    this.line('o->_job = NULL;');
    this.indent--;
    this.line('}');
    this.line('static void URLStream__finish(void* job) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)as_job_obj(job);');
    this.line('as_net_pre_events(job);');
    this.line('unsigned total = as_job_len(job);');
    // bytesTotal is Content-Length (or a local file size) and stays 0 when the
    // response did not state one — AIR reports 768/0 for /drip (probe 9).
    this.line('unsigned btotal = as_job_expected_total(job);');
    this.line('if (as_job_failed(job)) {');
    this.indent++;
    this.line('char* msg = as_job_error_text(job, (char*)"URLStream: this transport is not supported in this build (only http(s):// streams have a backend; see docs/zh-cn/flash-net.md)", (char*)"URLStream load failed");');
    // Same AIR number as URLLoader puts on its ioError (2032 "Stream Error"),
    // measured against adl; the unsupported-transport state keeps its own text
    // and no number, like URLLoader's.
    this.line('int eid = (as_job_error(job) == AS_JOB_ERR_UNSUPPORTED) ? 0 : 2032;');
    this.line('if (eid != 0) msg = as_ioerror_text(as_job_path(job), eid, as_job_err_detail(job));');
    // The stream is drained first, which also leaves the "opened but empty" state
    // AIR is in after a failed load: disconnected-looking but connected==true and
    // reads reported as EOFError, not as the #2029 of a stream that never opened.
    // A status-0 httpStatus precedes the error here too (probe 9: a refused
    // connection gives open;httpStatus(0);ioError).
    this.line('URLStream__drain(o);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)URLLoader__httpStatusEvent((char*)"httpStatus", 0));');
    this.line('IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, msg);');
    this.line('ev->errorID = eid;');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ev);');
    this.line('return;');
    this.indent--;
    this.line('}');
    // Terminal for a non-2xx HTTP status: same AIR rule as URLLoader (the
    // caller's HTTP_RESPONSE_STATUS listener decides COMPLETE vs ioError #2032),
    // applied to the stream side. The body is drained into the stream on both
    // branches — a stream that ends in ioError still holds the error payload.
    this.line('URLStream__drain(o);');
    // Zero-length body: no progress event, same rule as URLLoader (and the same
    // measurement: temp/httpstatus-probe2 cases I/J).
    this.line('if (total > 0 && (as_job_marks_sent(job) == 0 || as_job_last_progress(job) != total)) {');
    this.indent++;
    this.line('as_job_set_last_progress(job, total);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ProgressEvent_new((char*)"progress", false, false, total, btotal));');
    this.indent--;
    this.line('}');
    this.line('int st = as_job_status(job);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)URLLoader__httpStatusEvent((char*)"httpStatus", st));');
    // AIR's terminal split for a non-2xx response (see the event-order note above
    // and docs/zh-cn/flash-net.md §6.2): with a HTTP_RESPONSE_STATUS listener the
    // error body completes; without one the very same transfer ends in
    // ioError #2032. `hasEventListener` is the same predicate AIR uses — it counts
    // a listener in either phase — and status 0 (a local read, a non-HTTP load)
    // must NOT take this branch, hence the >= 300 test rather than "!= 200".
    this.line('if (st >= 300 && !EventDispatcher_hasEventListener((void*)o, (char*)"httpResponseStatus")) {');
    this.indent++;
    this.line('IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, as_ioerror_text(as_job_path(job), 2032, NULL));');
    this.line('ev->errorID = 2032;');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ev);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"complete", false, false));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('void URLStream_load(void* _this, URLRequest* request) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)_this;');
    // AIR: a second load() restarts the stream; the previous transfer is dropped
    // (cancelled AND the handle forgotten, for the reason close() explains).
    this.line('if (o->_job != NULL) { as_async_cancel((void*)o); o->_job = NULL; }');
    this.line('o->_buf = NULL; o->_buf_pos = 0;');
    // AIR validates the parameters instead of quietly doing nothing: load(null) and
    // load(new URLRequest(null)) are two distinct TypeErrors (#2007, verified with
    // adl). Silently returning would leave the caller waiting for an event that can
    // never arrive.
    this.line('if (request == NULL) as_throw(TypeError_new((char*)"Error #2007: Parameter request must be non-null.", 2007));');
    this.line('if (request->url == NULL) as_throw(TypeError_new((char*)"Error #2007: Parameter url must be non-null.", 2007));');
    this.line('const char* url = request->url;');
    this.line('if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) { o->_job = as_async_submit_unsupported((void*)o, URLStream__finish, url); if (o->_job != NULL) as_job_set_net_events(o->_job); return; }');
    this.line('net_req r; net__prepare_request(request, &r);');
    this.line('o->_job = as_async_submit_http_stream((void*)o, URLStream__finish, r.url, r.method, request->userAgent, request->contentType, (char*)r.headers, r.body, r.body_len, request->followRedirects ? 1 : 0, request->idleTimeout, request->manageCookies ? 1 : 0);');
    this.line('if (o->_job != NULL) as_job_set_net_events(o->_job);');
    this.indent--;
    this.line('}');
    this.line('bool URLStream_readBoolean(void* _this) { URLStream* o = (URLStream*)_this; if (URLStream__poll(o) <= 0) { URLStream__eof(); return false; } return URLStream__get(o) != 0; }');
    this.line('int URLStream_readByte(void* _this) { URLStream* o = (URLStream*)_this; if (URLStream__poll(o) <= 0) { URLStream__eof(); return 0; } return (int)(signed char)URLStream__get(o); }');
    this.line('unsigned URLStream_readUnsignedByte(void* _this) { URLStream* o = (URLStream*)_this; if (URLStream__poll(o) <= 0) { URLStream__eof(); return 0; } return (unsigned)URLStream__get(o); }');
    this.line('int URLStream_readShort(void* _this) { return (int)(short)URLStream__uint((URLStream*)_this, 2); }');
    this.line('unsigned URLStream_readUnsignedShort(void* _this) { return (unsigned)URLStream__uint((URLStream*)_this, 2); }');
    this.line('int URLStream_readInt(void* _this) { return (int)URLStream__uint((URLStream*)_this, 4); }');
    this.line('unsigned URLStream_readUnsignedInt(void* _this) { return (unsigned)URLStream__uint((URLStream*)_this, 4); }');
    this.line('double URLStream_readFloat(void* _this) { unsigned long long v = URLStream__uint((URLStream*)_this, 4); unsigned bits = (unsigned)v; float f; memcpy(&f, &bits, 4); return (double)f; }');
    this.line('double URLStream_readDouble(void* _this) { unsigned long long v = URLStream__uint((URLStream*)_this, 8); double d; memcpy(&d, &v, 8); return d; }');
    // readUTF: a 16-bit byte length (honouring `endian`) followed by the bytes.
    this.line('char* URLStream_readUTF(void* _this) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)_this;');
    this.line('if (!URLStream__need(o, 2)) { URLStream__eof(); return (char*)""; }');
    this.line('unsigned n = (unsigned)URLStream__uint(o, 2);');
    this.line('if (!URLStream__need(o, (int)n)) { URLStream__eof(); return (char*)""; }');
    this.line('char* s = as_str_alloc((size_t)n + 1);');
    this.line('if (n > 0) URLStream__read(o, s, (int)n);');
    this.line('s[n] = 0; return s;');
    this.indent--;
    this.line('}');
    this.line('char* URLStream_readUTFBytes(void* _this, unsigned length) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)_this;');
    this.line('if (!URLStream__need(o, (int)length)) { URLStream__eof(); return (char*)""; }');
    this.line('char* s = as_str_alloc((size_t)length + 1);');
    this.line('if (length > 0) URLStream__read(o, s, (int)length);');
    this.line('s[length] = 0; return s;');
    this.indent--;
    this.line('}');
    // charSet is ignored exactly like ByteArray.readMultiByte in this subset: the
    // bytes are passed through as UTF-8 (see docs/zh-cn/flash-net.md).
    this.line('char* URLStream_readMultiByte(void* _this, unsigned length, char* charSet) { (void)charSet; return URLStream_readUTFBytes(_this, length); }');
    this.line('void URLStream_readBytes(void* _this, ByteArray* bytes, unsigned offset, unsigned length) {');
    this.indent++;
    this.line('URLStream* o = (URLStream*)_this;');
    this.line('if (bytes == NULL) return;');
    this.line('unsigned avail = (unsigned)URLStream__poll(o);');
    this.line('if (length == 0) length = avail;');
    // AIR: a shortfall is an error, not a partial read (length == 0 means "all
    // available" and can therefore never fall short).
    this.line('if (length > avail) { URLStream__eof(); return; }');
    this.line('unsigned need = offset + length;');
    this.line('if ((int)bytes->capacity < (int)need) {');
    this.indent++;
    // The destination ByteArray is grown by hand rather than through
    // as_ba_grow: that helper lives with the ByteArray block, which is emitted
    // later, and its exact slack policy is not part of this contract.
    this.line('unsigned char* nd = (unsigned char*)gc_alloc(GCT_BYTES, need > 0 ? need : 1);');
    this.line('if (bytes->data != NULL && bytes->length > 0) memcpy(nd, bytes->data, (size_t)bytes->length);');
    this.line('bytes->data = nd; bytes->capacity = (int)need;');
    this.line('gc_write_barrier((void*)nd);');
    this.indent--;
    this.line('}');
    this.line('if (length > 0) URLStream__read(o, (unsigned char*)bytes->data + offset, (int)length);');
    this.line('if ((int)need > bytes->length) bytes->length = (int)need;');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.net.Socket / ServerSocket / XMLSocket / SecureSocket (stage 89·54) ----
    //
    // Every AS3-visible behaviour below is measured from adl, not inferred from the
    // documentation: temp/air-probe/Probe11.as and air-probe11-result.txt. The
    // measurements that shape the code:
    //
    //   * EVERY operation on a socket that is not open throws IOError #2002
    //     "Operation attempted on invalid socket." — including bytesAvailable and
    //     bytesPending, which are getters, and close() itself. No exceptions.
    //   * a connect() that the transport refuses does NOT throw: it dispatches
    //     ioError errorID=2031 text="Error #2031: Socket Error. URL: <host>"
    //     (the URL is the host alone, with no port). An unresolvable host reports
    //     the same id with that host.
    //   * connect(null, port) throws TypeError #1009; a port outside 0..65535
    //     throws SecurityError #2003 "Invalid socket port number specified."
    //   * a read that cannot be satisfied throws EOFError #2030, never a partial
    //     read.
    //   * writes BUFFER: writeUTFBytes("hello") leaves bytesPending = 5 and only
    //     flush() (or this runtime's automatic flush at the frame boundary) hands
    //     them to the transport; OutputProgressEvent then reports what is left.
    //   * socketData carries bytesLoaded = the whole chunk, bytesTotal = 0.
    //   * close() dispatches nothing; the PEER's close is what raises Event.CLOSE.
    //   * a Socket object is reusable: connect() after close() connects again.
    //   * the transport lives in an as_sock owned by the runtime's registry (see
    //     the socket seam in RUNTIME_PREAMBLE). `_sock` is a borrowed pointer in a
    //     C-runtime-only slot; the AS3 object drops it the moment it closes, and
    //     the registry keeps the object alive as a GC root until then.
    this.line('static void Socket__invalid(void) { as_throw(IOError_new((char*)"Error #2002: Operation attempted on invalid socket.", 2002)); }');
    this.line('static void Socket__eof(void) { as_throw(EOFError_new((char*)"Error #2030: End of file was encountered.", 2030)); }');
    // "Open" is what #2002 is reported against: a socket that has been connect()ed
    // and not closed. A connect that is still in flight counts as open, because AIR
    // buffers a write issued before the handshake finishes (the write buffer is
    // independent of the transport); reads on it simply find nothing yet.
    this.line('static int Socket__live(void* o) { as_sock* s = (as_sock*)((Socket*)o)->_sock; if (s == NULL) return 0; int st = as_sock_state_of(s); return !as_sock_is_dead(s) && (st == AS_SOCK_CONNECTING || st == AS_SOCK_CONNECTED); }');
    this.line('static int Socket__connected(void* o) { as_sock* s = (as_sock*)((Socket*)o)->_sock; return s != NULL && !as_sock_is_dead(s) && as_sock_state_of(s) == AS_SOCK_CONNECTED; }');
    this.line('static int Socket__avail(void* o) { as_sock* s = (as_sock*)((Socket*)o)->_sock; return s == NULL ? 0 : as_sock_avail(s); }');
    this.line('static int Socket__read(void* o, void* dst, int n) { as_sock* s = (as_sock*)((Socket*)o)->_sock; return s == NULL ? 0 : as_sock_read(s, dst, n); }');
    // The liveness check lives in here rather than in each reader: a read on a
    // socket that was never opened must report IOError #2002, while a read that
    // merely has no data yet reports EOFError #2030. as_throw never returns, so
    // the caller's EOF fallback is unreachable on the #2002 path.
    this.line('static int Socket__need(void* o, int n) { if (!Socket__live(o)) { Socket__invalid(); return 0; } return Socket__avail(o) >= n; }');
    this.line('static int Socket__little(void* o) { char* e = ((Socket*)o)->endian; return e != NULL && strcmp(e, "littleEndian") == 0; }');
    // Writes go through the write buffer; the #2002 check happens here so every
    // write* method reports the same error the reference runtime does.
    this.line('static void Socket__write(void* o, const void* p, int n) {');
    this.indent++;
    this.line('if (!Socket__live(o)) { Socket__invalid(); return; }');
    this.line('as_sock_write((as_sock*)((Socket*)o)->_sock, p, n);');
    this.indent--;
    this.line('}');
    // Fixed-width integer reads, honouring `endian` the way ByteArray does.
    this.line('static unsigned long long Socket__uint(void* o, int nbytes, int little) {');
    this.indent++;
    this.line('unsigned char buf[8];');
    this.line('if (!Socket__need(o, nbytes)) { Socket__eof(); return 0; }');
    this.line('Socket__read(o, buf, nbytes);');
    this.line('unsigned long long v = 0;');
    this.line('if (little) { for (int i = nbytes - 1; i >= 0; i--) v = (v << 8) | (unsigned)buf[i]; }');
    this.line('else { for (int i = 0; i < nbytes; i++) v = (v << 8) | (unsigned)buf[i]; }');
    this.line('return v;');
    this.indent--;
    this.line('}');
    this.line('static void Socket__put(void* o, unsigned long long v, int nbytes, int little) {');
    this.indent++;
    this.line('unsigned char buf[8];');
    this.line('for (int i = 0; i < nbytes; i++) buf[little ? i : (nbytes - 1 - i)] = (unsigned char)((v >> (8 * i)) & 0xff);');
    this.line('Socket__write(o, buf, nbytes);');
    this.indent--;
    this.line('}');
    this.line('// Socket_connect() is defined below but the constructor calls it, so the');
    this.line('// signature is declared here (the ctor\'s host-connect path is the same code).');
    this.line('void Socket_connect(void* _this, char* host, int port);');
    this.line('// Socket: constructor. AIR connects when a host was supplied, and the documented');
    this.line('// advice to prefer the no-argument form then connect() is about listener setup');
    this.line('// order, not about the constructor being different.');
    this.line('void Socket_ctor(Socket* o, char* host, int port) {');
    this.line('    EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('    o->endian = (char*)"bigEndian";');
    this.line('    o->objectEncoding = 3;');
    this.line('    o->timeout = 20000;');
    this.line('    o->tcpNoDelay = false;');
    this.line('    o->_sock = NULL;');
    this.line('    gc_write_barrier((void*)o->endian);');
    this.line('    if (host != NULL) Socket_connect((void*)o, host, port);');
    this.line('}');
    this.line('Socket* Socket_new(char* host, int port) { Socket* o = (Socket*)gc_alloc(GCT_CLASS, sizeof(Socket)); o->vtable = &Socket_vt; Socket_ctor(o, host, port); return o; }');
    this.line('// connect(): synchronous validation, asynchronous result. The port check comes');
    this.line('// first — a bad port is rejected even when the host is fine.');
    this.line('void Socket_connect(void* _this, char* host, int port) {');
    this.line('    Socket* o = (Socket*)_this;');
    this.line('    if (host == NULL) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    if (port < 0 || port > 65535) { as_throw(SecurityError_new((char*)"Error #2003: Invalid socket port number specified.", 2003)); return; }');
    this.line('    if (o->_sock == NULL) {');
    this.line('        o->_sock = (void*)as_sock_new(0);');
    this.line('        if (o->_sock == NULL) return;');
    this.line('    }');
    this.line('    as_sock* s = (as_sock*)o->_sock;');
    this.line('    as_sock_set_timeout(s, o->timeout);');
    this.line('    as_sock_set_obj(s, (void*)o);');
    this.line('    as_sock_connect(s, host, port);');
    this.line('    as_sock_set_no_delay(s, o->tcpNoDelay ? 1 : 0);');
    this.line('}');
    this.line('void Socket_close(void* _this) {');
    this.line('    Socket* o = (Socket*)_this;');
    this.line('    if (o->_sock == NULL) { Socket__invalid(); return; }');
    this.line('    as_sock_close((as_sock*)o->_sock);');
    this.line('    o->_sock = NULL;');
    this.line('}');
    this.line('void Socket_flush(void* _this) {');
    this.line('    Socket* o = (Socket*)_this;');
    this.line('    if (!Socket__live(o)) { Socket__invalid(); return; }');
    this.line('    as_sock_try_flush((as_sock*)o->_sock);');
    this.line('}');
    this.line('unsigned Socket_get_bytesAvailable(void* _this) {');
    this.line('    if (!Socket__live(_this)) { Socket__invalid(); return 0; }');
    this.line('    return (unsigned)Socket__avail(_this);');
    this.line('}');
    this.line('unsigned Socket_get_bytesPending(void* _this) {');
    this.line('    if (!Socket__live(_this)) { Socket__invalid(); return 0; }');
    this.line('    return (unsigned)as_sock_pending((as_sock*)((Socket*)_this)->_sock);');
    this.line('}');
    this.line('bool Socket_get_connected(void* _this) { return Socket__connected(_this) != 0; }');
    this.line('char* Socket_get_localAddress(void* _this) { as_sock* s = (as_sock*)((Socket*)_this)->_sock; return s == NULL ? NULL : (char*)as_sock_local_addr(s); }');
    this.line('int Socket_get_localPort(void* _this) { as_sock* s = (as_sock*)((Socket*)_this)->_sock; return s == NULL ? 0 : as_sock_local_port(s); }');
    this.line('char* Socket_get_remoteAddress(void* _this) { as_sock* s = (as_sock*)((Socket*)_this)->_sock; return s == NULL ? NULL : (char*)as_sock_remote_addr(s); }');
    this.line('int Socket_get_remotePort(void* _this) { as_sock* s = (as_sock*)((Socket*)_this)->_sock; return s == NULL ? 0 : as_sock_remote_port(s); }');
    this.line('// ---- IDataInput read side -------------------------------------------------');
    this.line('bool Socket_readBoolean(void* _this) { return Socket__uint(_this, 1, 0) != 0; }');
    this.line('int Socket_readByte(void* _this) { return (int)(signed char)Socket__uint(_this, 1, 0); }');
    this.line('unsigned Socket_readUnsignedByte(void* _this) { return (unsigned)Socket__uint(_this, 1, 0); }');
    this.line('int Socket_readShort(void* _this) { return (int)(short)Socket__uint(_this, 2, Socket__little(_this)); }');
    this.line('unsigned Socket_readUnsignedShort(void* _this) { return (unsigned)Socket__uint(_this, 2, Socket__little(_this)); }');
    this.line('int Socket_readInt(void* _this) { return (int)(int32_t)Socket__uint(_this, 4, Socket__little(_this)); }');
    this.line('unsigned Socket_readUnsignedInt(void* _this) { return (unsigned)Socket__uint(_this, 4, Socket__little(_this)); }');
    this.line('double Socket_readFloat(void* _this) {');
    this.line('    unsigned char buf[4]; float f = 0.0f;');
    this.line('    if (!Socket__need(_this, 4)) { Socket__eof(); return 0.0; }');
    this.line('    Socket__read(_this, buf, 4);');
    this.line('    if (Socket__little(_this)) { unsigned char r[4]; for (int i = 0; i < 4; i++) r[i] = buf[3 - i]; memcpy(&f, r, 4); }');
    this.line('    else memcpy(&f, buf, 4);');
    this.line('    return (double)f;');
    this.line('}');
    this.line('double Socket_readDouble(void* _this) {');
    this.line('    unsigned char buf[8]; double d = 0.0;');
    this.line('    if (!Socket__need(_this, 8)) { Socket__eof(); return 0.0; }');
    this.line('    Socket__read(_this, buf, 8);');
    this.line('    if (Socket__little(_this)) { unsigned char r[8]; for (int i = 0; i < 8; i++) r[i] = buf[7 - i]; memcpy(&d, r, 8); }');
    this.line('    else memcpy(&d, buf, 8);');
    this.line('    return d;');
    this.line('}');
    this.line('// A read of n bytes into a fresh GC string. Bytes are copied verbatim: this');
    this.line('// subset\'s String is a UTF-8 byte sequence (same rule as ByteArray.readUTFBytes).');
    this.line('static char* Socket__str(Socket* o, int n) {');
    this.line('    if (!Socket__live((void*)o)) { Socket__invalid(); return as_str_alloc(1); }');
    this.line('    if (n < 0) n = 0;');
    this.line('    if (Socket__avail(o) < n) { Socket__eof(); return as_str_alloc(1); }');
    this.line('    char* s = as_str_alloc((size_t)n + 1);');
    this.line('    if (n > 0) Socket__read((void*)o, s, n);');
    this.line('    s[n] = \'\\0\';');
    this.line('    return s;');
    this.line('}');
    this.line('char* Socket_readUTFBytes(void* _this, unsigned length) { return Socket__str((Socket*)_this, (int)length); }');
    this.line('// readUTF: an unsigned 16-bit byte count, then that many bytes.');
    this.line('char* Socket_readUTF(void* _this) {');
    this.line('    Socket* o = (Socket*)_this;');
    this.line('    unsigned n = (unsigned)Socket__uint(o, 2, 0);');
    this.line('    return Socket__str(o, (int)n);');
    this.line('}');
    this.line('// readMultiByte ignores charSet exactly like ByteArray.readMultiByte does in this');
    this.line('// subset (docs/zh-cn/flash-net.md section 3.1).');
    this.line('char* Socket_readMultiByte(void* _this, unsigned length, char* charSet) { (void)charSet; return Socket__str((Socket*)_this, (int)length); }');
    this.line('void Socket_readBytes(void* _this, ByteArray* bytes, unsigned offset, unsigned length) {');
    this.line('    Socket* o = (Socket*)_this;');
    this.line('    if (!Socket__live(o)) { Socket__invalid(); return; }');
    this.line('    unsigned avail = (unsigned)Socket__avail(o);');
    this.line('    unsigned n = (length == 0 || length > avail) ? avail : length;');
    this.line('    if (offset + n > (unsigned)bytes->capacity) {');
    this.line('        int need = (int)(offset + n);');
    this.line('        void* nd = gc_alloc(GCT_BYTES, (size_t)(need > 0 ? need : 1));');
    this.line('        if (bytes->data != NULL && bytes->length > 0) memcpy(nd, bytes->data, (size_t)bytes->length);');
    this.line('        bytes->data = nd; bytes->capacity = need;');
    this.line('        gc_write_barrier((void*)nd);');
    this.line('    }');
    this.line('    if (n > 0) Socket__read(o, (unsigned char*)bytes->data + offset, (int)n);');
    this.line('    if ((int)(offset + n) > bytes->length) bytes->length = (int)(offset + n);');
    this.line('}');
    this.line('// ---- IDataOutput write side ----------------------------------------------');
    this.line('void Socket_writeBoolean(void* _this, bool value) { Socket__put(_this, value ? 1 : 0, 1, 0); }');
    this.line('void Socket_writeByte(void* _this, int value) { Socket__put(_this, (unsigned)(value & 0xff), 1, 0); }');
    this.line('void Socket_writeShort(void* _this, int value) { Socket__put(_this, (unsigned)(value & 0xffff), 2, Socket__little(_this)); }');
    this.line('void Socket_writeInt(void* _this, int value) { Socket__put(_this, (unsigned)value & 0xffffffffu, 4, Socket__little(_this)); }');
    this.line('void Socket_writeUnsignedInt(void* _this, unsigned value) { Socket__put(_this, (unsigned long long)value, 4, Socket__little(_this)); }');
    this.line('void Socket_writeFloat(void* _this, double value) {');
    this.line('    float f = (float)value; unsigned char buf[4];');
    this.line('    memcpy(buf, &f, 4);');
    this.line('    if (Socket__little(_this)) { unsigned char r[4]; for (int i = 0; i < 4; i++) r[i] = buf[3 - i]; Socket__write(_this, r, 4); }');
    this.line('    else Socket__write(_this, buf, 4);');
    this.line('}');
    this.line('void Socket_writeDouble(void* _this, double value) {');
    this.line('    unsigned char buf[8];');
    this.line('    memcpy(buf, &value, 8);');
    this.line('    if (Socket__little(_this)) { unsigned char r[8]; for (int i = 0; i < 8; i++) r[i] = buf[7 - i]; Socket__write(_this, r, 8); }');
    this.line('    else Socket__write(_this, buf, 8);');
    this.line('}');
    this.line('void Socket_writeUTFBytes(void* _this, char* value) {');
    this.line('    if (value == NULL) value = (char*)"";');
    this.line('    Socket__write(_this, value, (int)strlen(value));');
    this.line('}');
    this.line('// writeUTF prefixes the byte count. Like ByteArray.writeUTF in this subset, a');
    this.line('// string longer than 65535 bytes wraps the count rather than throwing the');
    this.line('// RangeError AIR documents (same documented leniency, see flash-net.md section 3.1).');
    this.line('void Socket_writeUTF(void* _this, char* value) {');
    this.line('    if (value == NULL) value = (char*)"";');
    this.line('    Socket__put(_this, (unsigned)strlen(value) & 0xffff, 2, 0);');
    this.line('    Socket__write(_this, value, (int)strlen(value));');
    this.line('}');
    this.line('void Socket_writeMultiByte(void* _this, char* value, char* charSet) { (void)charSet; Socket_writeUTFBytes(_this, value); }');
    this.line('void Socket_writeBytes(void* _this, ByteArray* bytes, unsigned offset, unsigned length) {');
    this.line('    if (!Socket__live(_this)) { Socket__invalid(); return; }');
    this.line('    if (bytes == NULL) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    unsigned total = (unsigned)bytes->length;');
    this.line('    if (offset > total) { as_throw(RangeError_new((char*)"Error #2006: The supplied index is out of bounds.", 2006)); return; }');
    this.line('    unsigned n = (length == 0 || offset + length > total) ? (total - offset) : length;');
    this.line('    if (n > 0) Socket__write(_this, (unsigned char*)bytes->data + offset, (int)n);');
    this.line('}');
    this.line('');
    // ---- flash.net.ServerSocket (stage 89·54) ----
    //
    // bind() is the only place a listening transport is created, so it is also
    // where a previously bound one is released — the reference lets bind() move
    // the socket to a different port, and the example code closes the object
    // instead because a CLOSED ServerSocket cannot be reopened. That last rule is
    // enforced here with `_closed`: after close() a later bind() reports the same
    // IOError #2002 the reference's listen()-on-closed measurement produced.
    this.line('void ServerSocket_ctor(ServerSocket* o) {');
    this.line('    EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('    o->_sock = NULL;');
    this.line('    o->_closed = 0;');
    this.line('}');
    this.line('ServerSocket* ServerSocket_new(void) { ServerSocket* o = (ServerSocket*)gc_alloc(GCT_CLASS, sizeof(ServerSocket)); o->vtable = &ServerSocket_vt; ServerSocket_ctor(o); return o; }');
    this.line('void ServerSocket_bind(void* _this, int localPort, char* localAddress) {');
    this.line('    ServerSocket* o = (ServerSocket*)_this;');
    this.line('    if (o->_closed) { Socket__invalid(); return; }');
    this.line('    if (o->_sock != NULL) { as_sock_close((as_sock*)o->_sock); o->_sock = NULL; }');
    this.line('    o->_sock = (void*)as_sock_new(1);');
    this.line('    if (o->_sock == NULL) return;');
    this.line('    as_sock* s = (as_sock*)o->_sock;');
    this.line('    as_sock_set_obj(s, (void*)o);');
    this.line('    // AIR\'s port 0 is "next available"; a bind that fails leaves `bound` false,');
    this.line('    // which is the documented way to detect it.');
    this.line('    as_sock_bind(s, localAddress, localPort);');
    this.line('}');
    this.line('void ServerSocket_listen(void* _this, int backlog) {');
    this.line('    ServerSocket* o = (ServerSocket*)_this;');
    this.line('    as_sock* s = (as_sock*)o->_sock;');
    this.line('    if (s == NULL || as_sock_is_dead(s) || !as_sock_is_bound(s)) { Socket__invalid(); return; }');
    this.line('    if (!as_sock_listen(s, backlog)) Socket__invalid();');
    this.line('}');
    this.line('void ServerSocket_close(void* _this) {');
    this.line('    ServerSocket* o = (ServerSocket*)_this;');
    this.line('    if (o->_sock == NULL) { Socket__invalid(); return; }');
    this.line('    as_sock_close((as_sock*)o->_sock);');
    this.line('    o->_sock = NULL;');
    this.line('    o->_closed = 1;');
    this.line('}');
    this.line('bool ServerSocket_get_bound(void* _this) { as_sock* s = (as_sock*)((ServerSocket*)_this)->_sock; return s != NULL && !as_sock_is_dead(s) && as_sock_local_port(s) > 0; }');
    this.line('bool ServerSocket_get_listening(void* _this) { as_sock* s = (as_sock*)((ServerSocket*)_this)->_sock; return s != NULL && !as_sock_is_dead(s) && as_sock_is_listening(s); }');
    this.line('char* ServerSocket_get_localAddress(void* _this) { as_sock* s = (as_sock*)((ServerSocket*)_this)->_sock; if (s == NULL || as_sock_local_port(s) <= 0) return NULL; return (char*)as_sock_local_addr(s); }');
    this.line('int ServerSocket_get_localPort(void* _this) { as_sock* s = (as_sock*)((ServerSocket*)_this)->_sock; return s == NULL ? 0 : as_sock_local_port(s); }');
    this.line('bool ServerSocket_get_isSupported_static(void* _this) { (void)_this; return true; }');
    this.line('');
    // ---- flash.net.XMLSocket (stage 89·54) ----
    //
    // XMLSocket is the NUL-terminated-message protocol over the same transport.
    // adl measured its framing exactly: send() appends the terminator itself
    // (a 5-byte string arrives as 6 bytes) and sends IMMEDIATELY, with no
    // flush(); an inbound message is delivered as DataEvent.DATA with a String
    // payload, one event per terminator; and a message split across frames is
    // assembled rather than reported early.
    this.line('void XMLSocket_ctor(XMLSocket* o, char* host, int port) {');
    this.line('    EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('    o->timeout = 20000;');
    this.line('    o->_sock = NULL;');
    this.line('    if (host != NULL) XMLSocket_connect((void*)o, host, port);');
    this.line('}');
    this.line('XMLSocket* XMLSocket_new(char* host, int port) { XMLSocket* o = (XMLSocket*)gc_alloc(GCT_CLASS, sizeof(XMLSocket)); o->vtable = &XMLSocket_vt; XMLSocket_ctor(o, host, port); return o; }');
    this.line('void XMLSocket_connect(void* _this, char* host, int port) {');
    this.line('    XMLSocket* o = (XMLSocket*)_this;');
    this.line('    if (host == NULL) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    if (port < 0 || port > 65535) { as_throw(SecurityError_new((char*)"Error #2003: Invalid socket port number specified.", 2003)); return; }');
    this.line('    if (o->_sock == NULL) {');
    this.line('        o->_sock = (void*)as_sock_new(0);');
    this.line('        if (o->_sock == NULL) return;');
    this.line('    }');
    this.line('    as_sock* s = (as_sock*)o->_sock;');
    this.line('    as_sock_set_timeout(s, o->timeout);');
    this.line('    as_sock_set_obj(s, (void*)o);');
    this.line('    as_sock_connect(s, host, port);');
    this.line('}');
    this.line('void XMLSocket_close(void* _this) {');
    this.line('    XMLSocket* o = (XMLSocket*)_this;');
    this.line('    if (o->_sock == NULL) { Socket__invalid(); return; }');
    this.line('    as_sock_close((as_sock*)o->_sock);');
    this.line('    o->_sock = NULL;');
    this.line('}');
    this.line('bool XMLSocket_get_connected(void* _this) {');
    this.line('    as_sock* s = (as_sock*)((XMLSocket*)_this)->_sock;');
    this.line('    return s != NULL && !as_sock_is_dead(s) && as_sock_state_of(s) == AS_SOCK_CONNECTED;');
    this.line('}');
    // send(): the terminator is part of the wire format, so this is where it is
    // appended. The reference types the parameter Object and AIR accepts an XML
    // value or a String (stringifying anything else, measured: 42 becomes "42"),
    // so the slot is dynamic and the coercion is the same one an implicit
    // String conversion uses. A null argument raises the #1009 a null connect()
    // host raises (measured) rather than sending the literal "null".
    this.line('void XMLSocket_send(void* _this, as_value object) {');
    this.line('    XMLSocket* o = (XMLSocket*)_this;');
    this.line('    if (!XMLSocket_get_connected(o)) { Socket__invalid(); return; }');
    this.line('    if (object.tag == 0 || object.tag == 5) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    char* text = as_coerce_str(object);');
    this.line('    if (text == NULL) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    as_sock* s = (as_sock*)o->_sock;');
    this.line('    int n = (int)strlen(text);');
    this.line('    if (n > 0) as_sock_write(s, text, n);');
    this.line('    as_sock_write(s, "", 1);');
    this.line('    as_sock_try_flush(s);');
    this.line('}');
    // Hand over every complete NUL-terminated message as a DataEvent. The scan
    // consumes nothing until a terminator is found, so a message that arrives
    // split across frames stays buffered until it is whole.
    this.line('static int XMLSocket__deliver(XMLSocket* o) {');
    this.line('    int sent = 0;');
    this.line('    for (;;) {');
    this.line('        as_sock* s = (as_sock*)o->_sock;');
    this.line('        if (s == NULL) break;');
    this.line('        int at = as_sock_index_of(s, 0);');
    this.line('        if (at < 0) break;');
    this.line('        char* msg = as_str_alloc((size_t)at + 1);');
    this.line('        if (at > 0) as_sock_read(s, msg, at);');
    this.line('        msg[at] = \'\\0\';');
    this.line('        unsigned char nul = 0;');
    this.line('        as_sock_read(s, &nul, 1);');
    this.line('        EventDispatcher_dispatchEvent((void*)o, (Event*)DataEvent_new((char*)"data", false, false, msg));');
    this.line('        sent++;');
    this.line('        if (as_sock_is_dead(s)) break;');
    this.line('    }');
    this.line('    return sent;');
    this.line('}');
    this.line('');
    // ---- flash.net.SecureSocket (stage 89·54) ----
    //
    // TLS is NOT implemented, and the class says so instead of silently handing
    // the app a plaintext connection: isSupported is false and connect()
    // dispatches the socket ioError. SecureSocket.isSupported is the documented
    // way to feature-detect TLS, so an app that checks it takes its own fallback,
    // and an app that does not still fails loudly. What is missing is the TLS
    // state machine over the non-blocking transport plus AIR's
    // serverCertificateValidate handshake (the app validates untrusted certs);
    // it is recorded in TODO.md's leftover table, not papered over here.
    this.line('static char* Socket__ioerror_text(const char* url);');
    this.line('static IOErrorEvent* Socket__ioerror_event(const char* url);');
    this.line('void SecureSocket_ctor(SecureSocket* o) {');
    this.line('    Socket_ctor((Socket*)o, NULL, 0);');
    this.line('}');
    this.line('SecureSocket* SecureSocket_new(void) { SecureSocket* o = (SecureSocket*)gc_alloc(GCT_CLASS, sizeof(SecureSocket)); o->vtable = &SecureSocket_vt; SecureSocket_ctor(o); return o; }');
    this.line('void SecureSocket_connect(void* _this, char* host, int port) {');
    this.line('    SecureSocket* o = (SecureSocket*)_this;');
    this.line('    if (host == NULL) { as_throw(TypeError_new((char*)"Error #1009: Cannot access a property or method of a null object reference.", 1009)); return; }');
    this.line('    if (port < 0 || port > 65535) { as_throw(SecurityError_new((char*)"Error #2003: Invalid socket port number specified.", 2003)); return; }');
    this.line('    EventDispatcher_dispatchEvent((void*)o, (Event*)Socket__ioerror_event(host));');
    this.line('}');
    this.line('bool SecureSocket_get_isSupported_static(void* _this) { (void)_this; return false; }');
    this.line('char* SecureSocket_get_serverCertificateStatus(void* _this) { (void)_this; return (char*)"unknown"; }');
    this.line('void SecureSocket_addBinaryChainBuildingCertificate(void* _this, ByteArray* certificate, bool trusted) { (void)_this; (void)certificate; (void)trusted; }');
    this.line('');
    // ---- the AS3 side of the socket seam ----
    //
    // as_sock_dispatch() is the second half of the frame-boundary pump (the first
    // half, as_sock_pump, lives in RUNTIME_PREAMBLE and knows nothing about AS3).
    // It walks the registry, turning raised flags into events, and is called from
    // as_async_tick — so socket events arrive on the same frame boundary as every
    // other asynchronous event in this runtime. It is also what keeps AIR's
    // "everything is dispatched between frames" model intact: nothing here runs
    // on a worker thread.
    //
    // Three rules keep a listener from breaking the walk:
    //   * a socket the pump marked dead is skipped, so close() from inside an
    //     earlier dispatch cannot deliver an event for a socket that is gone;
    //   * a flag is cleared BEFORE its event is dispatched, so a re-entrant tick
    //     (a listener calling tickTimers) cannot replay it;
    //   * nothing is freed here. close() only marks dead; as_sock_reap() at the
    //     tail — which refuses to run while as_sock_dispatching is set — frees.
    //
    // The order is fixed: CONNECT, then ACCEPT, then DATA, then OUTPUT, then
    // ERROR, then CLOSE. DATA before CLOSE is required — the last chunk of a
    // connection must be readable before the close event retires the socket.
    this.line('// flash.events.ServerSocketConnectEvent / OutputProgressEvent: the two event');
    this.line('// classes the socket layer introduces. Both extend Event (hand-written like the');
    this.line('// other flash.events subclasses in this file, stage 59).');
    this.line('void ServerSocketConnectEvent_ctor(ServerSocketConnectEvent* o, char* type, bool bubbles, bool cancelable, Socket* socket) {');
    this.line('    Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('    o->socket = socket;');
    this.line('    gc_write_barrier((void*)socket);');
    this.line('}');
    this.line('ServerSocketConnectEvent* ServerSocketConnectEvent_new(char* type, bool bubbles, bool cancelable, Socket* socket) {');
    this.line('    ServerSocketConnectEvent* o = (ServerSocketConnectEvent*)gc_alloc(GCT_CLASS, sizeof(ServerSocketConnectEvent));');
    this.line('    o->vtable = &ServerSocketConnectEvent_vt;');
    this.line('    ServerSocketConnectEvent_ctor(o, type, bubbles, cancelable, socket);');
    this.line('    return o;');
    this.line('}');
    this.line('void OutputProgressEvent_ctor(OutputProgressEvent* o, char* type, bool bubbles, bool cancelable, double bytesPending, double bytesTotal) {');
    this.line('    Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('    o->bytesPending = bytesPending;');
    this.line('    o->bytesTotal = bytesTotal;');
    this.line('}');
    this.line('OutputProgressEvent* OutputProgressEvent_new(char* type, bool bubbles, bool cancelable, double bytesPending, double bytesTotal) {');
    this.line('    OutputProgressEvent* o = (OutputProgressEvent*)gc_alloc(GCT_CLASS, sizeof(OutputProgressEvent));');
    this.line('    o->vtable = &OutputProgressEvent_vt;');
    this.line('    OutputProgressEvent_ctor(o, type, bubbles, cancelable, bytesPending, bytesTotal);');
    this.line('    return o;');
    this.line('}');
    this.line('');
    // AIR pairs the message with errorID 2031 (measured; the text alone is not
    // enough — code reads the number). `id` is fixed: every transport failure a
    // connect attempt produces reports 2031, and no other socket failure has a
    // measured id yet (see the leftover table in TODO.md).
    this.line('static IOErrorEvent* Socket__ioerror_event(const char* url) {');
    this.line('    IOErrorEvent* e = IOErrorEvent_new((char*)"ioError", false, false, Socket__ioerror_text(url));');
    this.line('    e->errorID = 2031;');
    this.line('    return e;');
    this.line('}');
    this.line('static char* Socket__ioerror_text(const char* url) {');
    this.line('    size_t n = strlen(url == NULL ? "" : url) + 48;');
    this.line('    char* t = as_str_alloc(n);');
    this.line('    snprintf(t, n, "Error #2031: Socket Error. URL: %s", url == NULL ? "" : url);');
    this.line('    return t;');
    this.line('}');
    this.line('int as_sock_dispatch(void) {');
    this.line('    int total = 0;');
    this.line('    as_sock_dispatching = 1;');
    this.line('    int n = as_sock_count_all();');
    this.line('    for (int i = 0; i < n; i++) {');
    this.line('        as_sock* s = as_sock_at(i);');
    this.line('        if (as_sock_is_dead(s)) continue;');
    this.line('        int ev = as_sock_events_of(s);');
    this.line('        void* obj = as_sock_obj_of(s);');
    this.line('        if (obj == NULL) continue;');
    this.line('        if (ev & AS_SOCK_EV_CONNECT) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_CONNECT);');
    this.line('            EventDispatcher_dispatchEvent(obj, (Event*)Event_new((char*)"connect", false, false));');
    this.line('            total++;');
    this.line('            if (as_sock_is_dead(s)) continue;');
    this.line('            ev = as_sock_events_of(s);');
    this.line('        }');
    this.line('        if (ev & AS_SOCK_EV_ACCEPT) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_ACCEPT);');
    this.line('            as_sock* c = as_sock_take_accepted(s);');
    this.line('            if (c != NULL) {');
    this.line('                Socket* peer = Socket_new(NULL, 0);');
    this.line('                peer->_sock = (void*)c;');
    this.line('                as_sock_set_obj(c, (void*)peer);');
    this.line('                // ONE event, a ServerSocketConnectEvent: its type is');
    this.line('                // ServerSocketConnectEvent.CONNECT === Event.CONNECT === "connect"');
    this.line('                // and it extends Event, so a single dispatch reaches listeners');
    this.line('                // registered for either constant (measured on adl).');
    this.line('                EventDispatcher_dispatchEvent(obj, (Event*)ServerSocketConnectEvent_new((char*)"connect", false, false, peer));');
    this.line('                total++;');
    this.line('            }');
    this.line('            if (as_sock_is_dead(s)) continue;');
    this.line('            ev = as_sock_events_of(s);');
    this.line('        }');
    this.line('        if (ev & AS_SOCK_EV_DATA) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_DATA);');
    this.line('            if (as_is(obj, &XMLSocket_vt)) {');
    this.line('                total += XMLSocket__deliver((XMLSocket*)obj);');
    this.line('            } else {');
    this.line('                // bytesTotal stays 0: a socket has no declared length (measured).');
    this.line('                EventDispatcher_dispatchEvent(obj, (Event*)ProgressEvent_new((char*)"socketData", false, false, (unsigned)as_sock_avail(s), 0));');
    this.line('                total++;');
    this.line('            }');
    this.line('            if (as_sock_is_dead(s)) continue;');
    this.line('            ev = as_sock_events_of(s);');
    this.line('        }');
    this.line('        if (ev & AS_SOCK_EV_OUTPUT) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_OUTPUT);');
    this.line('            if (!as_is(obj, &XMLSocket_vt)) {');
    this.line('                EventDispatcher_dispatchEvent(obj, (Event*)OutputProgressEvent_new((char*)"outputProgress", false, false, (double)as_sock_pending(s), 0.0));');
    this.line('                total++;');
    this.line('            }');
    this.line('            if (as_sock_is_dead(s)) continue;');
    this.line('            ev = as_sock_events_of(s);');
    this.line('        }');
    this.line('        if (ev & AS_SOCK_EV_ERROR) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_ERROR);');
    this.line('            EventDispatcher_dispatchEvent(obj, (Event*)Socket__ioerror_event(as_sock_url(s)));');
    this.line('            total++;');
    this.line('            if (as_sock_is_dead(s)) continue;');
    this.line('            ev = as_sock_events_of(s);');
    this.line('        }');
    this.line('        if (ev & AS_SOCK_EV_CLOSE) {');
    this.line('            as_sock_clear_events(s, AS_SOCK_EV_CLOSE);');
    this.line('            EventDispatcher_dispatchEvent(obj, (Event*)Event_new((char*)"close", false, false));');
    this.line('            total++;');
    this.line('        }');
    this.line('    }');
    this.line('    as_sock_dispatching = 0;');
    this.line('    as_sock_reap();');
    this.line('    return total;');
    this.line('}');
    this.line('');

    // URLVariables: dynamic class (AS3 `dynamic class`). Arbitrary string-keyed
    // properties live in the `_dyn` slot table (see the dynamic-class mechanism);
    // toString() serializes them as a URL-encoded query string (key=value&...),
    // insertion-ordered for deterministic output.
    this.line('void URLVariables_ctor(URLVariables* o, char* source) {');
    this.indent++;
    this.line('Object_ctor((Object*)o);');
    this.line('o->_dyn = as_object_new();');
    this.line('gc_write_barrier((void*)o->_dyn);');
    // AIR: the constructor decodes any non-null argument, so it is the same
    // operation as the public decode() and is delegated to it.
    this.line('URLVariables_decode((void*)o, source);');
    this.indent--;
    this.line('}');
    this.line('URLVariables* URLVariables_new(char* source) { URLVariables* o = (URLVariables*)gc_alloc(GCT_CLASS, sizeof(URLVariables)); o->vtable = &URLVariables_vt; URLVariables_ctor(o, source); return o; }');
    // URLVariables.decode(source): split "a=1&b=2" into dynamic properties. The
    // source is copied first because the scan writes NULs into the buffer as it
    // walks and the argument string may be caller-owned. Keys are NOT URL-decoded,
    // values are — that asymmetry is AIR's (the constructor always behaved so).
    // AIR throws Error for a pair that is not URL-encoded; this subset decodes
    // leniently instead (docs/zh-cn/flash-net.md §3.1).
    this.line('void URLVariables_decode(void* _this, char* source) {');
    this.indent++;
    this.line('URLVariables* o = (URLVariables*)_this;');
    this.line('if (source == NULL || *source == \'\\0\') return;');
    this.line('char* s = as_str_alloc(strlen(source) + 1);');
    this.line('strcpy(s, source);');
    this.line('char* p = s;');
    this.line('while (*p != \'\\0\') {');
    this.indent++;
    this.line('char* eq = strchr(p, \'=\');');
    this.line('char* amp = strchr(p, \'&\');');
    this.line('if (eq == NULL || (amp != NULL && amp < eq)) break;');
    this.line('*eq = \'\\0\';');
    this.line('char* val = eq + 1;');
    this.line('if (amp != NULL) { *amp = \'\\0\'; amp++; }');
    this.line('as_object_set(o->_dyn, p, as_v_str(as_url_decode(val)));');
    this.line('if (amp == NULL) break;');
    this.line('p = amp;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('char* URLVariables_toString(void* _this) {');
    this.indent++;
    this.line('URLVariables* o = (URLVariables*)_this;');
    this.line('as_object* d = o->_dyn;');
    this.line('if (d == NULL || d->length == 0) return (char*)"";');
    this.line('size_t total = 0;');
    this.line('for (int i = 0; i < d->length; i++) total += strlen(d->keys[i]) + strlen(as_v_str_val(d->vals[i])) + 2;');
    this.line('char* out = as_str_alloc(total + 1);');
    this.line('char* p = out;');
    this.line('for (int i = 0; i < d->length; i++) {');
    this.indent++;
    this.line('char* k = d->keys[i];');
    this.line('char* v = as_url_encode(as_v_str_val(d->vals[i]));');
    this.line('size_t kl = strlen(k), vl = strlen(v);');
    this.line('memcpy(p, k, kl); p += kl;');
    this.line('*p++ = \'=\';');
    this.line('memcpy(p, v, vl); p += vl;');
    this.line('if (i < d->length - 1) *p++ = \'&\';');
    this.indent--;
    this.line('}');
    this.line('*p = \'\\0\';');
    this.line('return out;');
    this.indent--;
    this.line('}');
    this.line('');
    // Keyboard / Mouse: static-only classes (never instantiated), but they still
    // need concrete ctor/new so any reference links cleanly (like the stage-41
    // constant classes). Mouse.hide/show toggle a file-scope visibility flag.
    this.line('void Keyboard_ctor(Keyboard* o) { Object_ctor((Object*)o); }');
    this.line('Keyboard* Keyboard_new(void) { Keyboard* o = (Keyboard*)gc_alloc(GCT_CLASS, sizeof(Keyboard)); o->vtable = &Keyboard_vt; Keyboard_ctor(o); return o; }');
    this.line('void Mouse_ctor(Mouse* o) { Object_ctor((Object*)o); }');
    this.line('Mouse* Mouse_new(void) { Mouse* o = (Mouse*)gc_alloc(GCT_CLASS, sizeof(Mouse)); o->vtable = &Mouse_vt; Mouse_ctor(o); return o; }');
    this.line('static bool as_mouse_visible = true;');
    this.line('void Mouse_hide_static(void) { as_mouse_visible = false; }');
    this.line('void Mouse_show_static(void) { as_mouse_visible = true; }');
    this.line('');
    // Forward declaration: FileStream_readBytes/writeBytes (below) call as_ba_grow,
    // which is defined in the ByteArray section further down. Since it is static,
    // it needs a prototype before the first call site.
    this.line('static void as_ba_grow(ByteArray* o, int extra);');
    // ---- flash.filesystem (stage 64): File / FileStream / FileMode ----
    // POSIX filesystem probes. stat() works for both files and directories and is
    // available on native POSIX and WASI alike.
    this.line('static bool as_path_exists(const char* p) { struct stat st; return p != NULL && stat(p, &st) == 0; }');
    this.line('static bool as_path_is_dir(const char* p) { struct stat st; return p != NULL && stat(p, &st) == 0 && S_ISDIR(st.st_mode); }');
    this.line('static char* as_path_join(const char* a, const char* b) {');
    this.indent++;
    this.line('if (a == NULL || *a == \'\\0\') return (char*)(b ? b : "");');
    this.line('if (b == NULL || *b == \'\\0\') return (char*)a;');
    this.line('char* tmp = as_str_concat(a, "/");');
    this.line('return as_str_concat(tmp, b);');
    this.indent--;
    this.line('}');
    // AIR File static directory shortcuts, resolved from the process environment.
    // applicationDirectory is the app's own directory (mapped to the CWD in this
    // subset); userDirectory/desktopDirectory/documentsDirectory read $HOME and
    // append the standard sub-path.
    this.line('static char* as_home_dir(void) { char* h = getenv("HOME"); return (h == NULL || *h == \'\\0\') ? (char*)"." : h; }');
    this.line('static char* as_app_dir(void) { return (char*)"."; }');
    this.line('static char* as_user_dir(void) { return as_home_dir(); }');
    this.line('static char* as_desktop_dir(void) { return as_path_join(as_home_dir(), "Desktop"); }');
    this.line('static char* as_documents_dir(void) { return as_path_join(as_home_dir(), "Documents"); }');
    this.line('static void as_mkdirs(const char* p) {');
    this.indent++;
    this.line('if (p == NULL || *p == \'\\0\') return;');
    this.line('char buf[1024];');
    this.line('size_t len = strlen(p);');
    this.line('if (len + 1 > sizeof(buf)) return;');
    this.line('memcpy(buf, p, len + 1);');
    this.line('for (char* s = buf + 1; *s != \'\\0\'; s++) if (*s == \'/\') { *s = \'\\0\'; mkdir(buf, 0755); *s = \'/\'; }');
    this.line('mkdir(buf, 0755);');
    this.indent--;
    this.line('}');
    this.line('');
    // Writable per-app storage (AIR applicationStorageDirectory). A bundled .app is
    // launched with a non-writable CWD (Xcode runs it with CWD="/"), so "." is not
    // a safe write target; resolve a stable directory under $HOME and create it.
    this.line('static char* as_app_storage_dir(void) {');
    this.indent++;
    this.line('char* home = as_home_dir();');
    this.line('char* base = NULL;');
    this.line('#ifdef __APPLE__');
    this.line('base = as_path_join(home, "Library/Application Support/as3aot/Local Store");');
    this.line('#else');
    this.line('base = as_path_join(home, ".as3aot");');
    this.line('#endif');
    this.line('as_mkdirs(base);');
    this.line('return base;');
    this.indent--;
    this.line('}');
    this.line('');
    // File: a filesystem path bundle. url is "file://" + nativePath.
    this.line('void File_ctor(File* o, char* path) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->nativePath = path; gc_write_barrier((void*)path);');
    this.indent--;
    this.line('}');
    this.line('File* File_new(char* path) { File* o = (File*)gc_alloc(GCT_CLASS, sizeof(File)); o->vtable = &File_vt; File_ctor(o, path); return o; }');
    this.line('char* File_get_url(void* _this) { File* o = (File*)_this; return (o->nativePath == NULL) ? (char*)"file://" : as_str_concat((char*)"file://", o->nativePath); }');
    this.line('bool File_get_exists(void* _this) { File* o = (File*)_this; return o->nativePath != NULL && as_path_exists(o->nativePath); }');
    this.line('bool File_get_isDirectory(void* _this) { File* o = (File*)_this; return o->nativePath != NULL && as_path_is_dir(o->nativePath); }');
    // isHidden: on POSIX a file is hidden when its basename starts with a dot
    // (matches the .DS_Store filtering the demo relies on).
    this.line('bool File_get_isHidden(void* _this) {');
    this.indent++;
    this.line('File* o = (File*)_this;');
    this.line('if (o->nativePath == NULL) return false;');
    this.line('const char* base = o->nativePath;');
    this.line('for (const char* p = o->nativePath; *p; p++) if (*p == \'/\') base = p + 1;');
    this.line('return base[0] == \'.\';');
    this.indent--;
    this.line('}');
    this.line('File* File_resolvePath(void* _this, char* path) { File* o = (File*)_this; return (o->nativePath == NULL) ? File_new(path) : File_new(as_path_join(o->nativePath, path)); }');
    this.line('void File_createDirectory(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) as_mkdirs(o->nativePath); }');
    this.line('void File_deleteFile(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) remove(o->nativePath); }');
    this.line('void File_deleteDirectory(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) remove(o->nativePath); }');
    // getDirectoryListing: list a directory's children as File objects (skipping
    // . and ..), used by AssetManager to recursively enqueue folder contents.
    this.line('as_array* File_getDirectoryListing(void* _this) {');
    this.indent++;
    this.line('File* o = (File*)_this;');
    this.line('as_array* result = as_array_new();');
    this.line('if (o->nativePath == NULL) return result;');
    this.line('DIR* d = opendir(o->nativePath);');
    this.line('if (d == NULL) return result;');
    this.line('struct dirent* e;');
    this.line('while ((e = readdir(d)) != NULL) {');
    this.indent++;
    this.line('if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;');
    this.line('as_array_push(result, as_v_obj((void*)File_new(as_path_join(o->nativePath, e->d_name))));');
    this.indent--;
    this.line('}');
    this.line('closedir(d);');
    this.line('return result;');
    this.indent--;
    this.line('}');
    this.line('');
    // FileStream: a FILE* handle + open/close/read/write. AIR FileMode strings are
    // mapped to C fopen modes.
    this.line('void FileStream_ctor(FileStream* o) { EventDispatcher_ctor((EventDispatcher*)o); o->_handle = NULL; }');
    this.line('FileStream* FileStream_new(void) { FileStream* o = (FileStream*)gc_alloc(GCT_CLASS, sizeof(FileStream)); o->vtable = &FileStream_vt; FileStream_ctor(o); return o; }');
    this.line('void FileStream_open(void* _this, File* file, char* fileMode) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('if (o->_handle != NULL) { fclose((FILE*)o->_handle); o->_handle = NULL; }');
    this.line('if (file == NULL || file->nativePath == NULL) return;');
    this.line('const char* mode = "rb";');
    this.line('if (fileMode != NULL) {');
    this.indent++;
    this.line('if (strcmp(fileMode, "write") == 0) mode = "wb";');
    this.line('else if (strcmp(fileMode, "append") == 0) mode = "ab";');
    this.line('else if (strcmp(fileMode, "update") == 0) mode = "r+b";');
    this.indent--;
    this.line('}');
    this.line('o->_handle = (void*)fopen(file->nativePath, mode);');
    this.indent--;
    this.line('}');
    // Completion thunk for openAsync, run on the AS3 thread inside a frame
    // boundary: adopt the opened handle, then report the byte count via a
    // ProgressEvent.PROGRESS followed by Event.COMPLETE (AIR reads the file into
    // an input buffer asynchronously and fires both before the data is consumed).
    // The handle is published here and not in openAsync(), so a read attempted
    // before COMPLETE sees no bytes available - which is what AIR's unbuffered
    // stream does too.
    this.line('static void FileStream__openFinish(void* job) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)as_job_obj(job);');
    this.line('if (as_job_failed(job)) { EventDispatcher_dispatchEvent((void*)o, (Event*)IOErrorEvent_new((char*)"ioError", false, false, (char*)"FileStream open failed")); return; }');
    this.line('unsigned total = as_job_total(job);');
    this.line('o->_handle = as_job_take_handle(job);');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ProgressEvent_new((char*)"progress", false, false, total, total));');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"complete", false, false));');
    this.indent--;
    this.line('}');
    this.line('void FileStream_openAsync(void* _this, File* file, char* fileMode) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    // AIR closes an already-open file before opening the new one, and delivers no
    // further events for it.
    this.line('if (o->_handle != NULL) { fclose((FILE*)o->_handle); o->_handle = NULL; }');
    this.line('as_async_submit(AS_JOB_FS_OPEN, (void*)o, FileStream__openFinish, (file != NULL) ? file->nativePath : NULL, fileMode, 0);');
    this.indent--;
    this.line('}');
    this.line('void FileStream_close(void* _this) { FileStream* o = (FileStream*)_this; if (o->_handle != NULL) { fclose((FILE*)o->_handle); o->_handle = NULL; } }');
    this.line('char* FileStream_readUTFBytes(void* _this, unsigned length) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f == NULL) return NULL;');
    this.line('char* buf = as_str_alloc((size_t)length + 1);');
    this.line('size_t n = fread(buf, 1, (size_t)length, f);');
    this.line('buf[n] = \'\\0\';');
    this.line('return buf;');
    this.indent--;
    this.line('}');
    this.line('void FileStream_writeUTFBytes(void* _this, char* value) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f != NULL && value != NULL) fwrite(value, 1, strlen(value), f);');
    this.indent--;
    this.line('}');
    this.line('unsigned FileStream_get_position(void* _this) { FileStream* o = (FileStream*)_this; FILE* f = (FILE*)o->_handle; return (f == NULL) ? 0u : (unsigned)ftell(f); }');
    this.line('unsigned FileStream_get_bytesAvailable(void* _this) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f == NULL) return 0u;');
    this.line('long cur = ftell(f);');
    this.line('fseek(f, 0, SEEK_END);');
    this.line('long end = ftell(f);');
    this.line('fseek(f, cur, SEEK_SET);');
    this.line('return (unsigned)(end - cur);');
    this.indent--;
    this.line('}');
    this.line('void FileStream_readBytes(void* _this, ByteArray* bytes, unsigned offset, unsigned length) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f == NULL || bytes == NULL) return;');
    this.line('if (length == 0) {');
    this.indent++;
    this.line('long cur = ftell(f); fseek(f, 0, SEEK_END); long end = ftell(f); fseek(f, cur, SEEK_SET);');
    this.line('length = (unsigned)(end - cur);');
    this.indent--;
    this.line('}');
    this.line('as_ba_grow(bytes, (int)(offset + length));');
    this.line('size_t n = fread((unsigned char*)bytes->data + offset, 1, (size_t)length, f);');
    this.line('if ((int)(offset + n) > bytes->length) bytes->length = (int)(offset + n);');
    this.indent--;
    this.line('}');
    this.line('void FileStream_writeBytes(void* _this, ByteArray* bytes, unsigned offset, unsigned length) {');
    this.indent++;
    this.line('FileStream* o = (FileStream*)_this;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f == NULL || bytes == NULL) return;');
    this.line('if (length == 0) length = (unsigned)(bytes->length - (int)offset);');
    this.line('if ((int)(offset + length) > bytes->length) length = (unsigned)(bytes->length - (int)offset);');
    this.line('if (length > 0) fwrite((unsigned char*)bytes->data + offset, 1, (size_t)length, f);');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.net.SharedObject (stage 89·40) ----
    // Local shared objects, persisted as JSON under applicationStorageDirectory:
    //   <storage>/[<localPath>/]<name>.json
    // AIR stores an AMF3 ".sol" container under the per-application Local Store;
    // this subset has a JSON codec but no AMF3 encoder, so the byte format (and
    // therefore the exact size values) differ while the observable semantics do
    // not. Only the local half is implemented — getRemote/connect/send need a
    // Flash Media Server, so they throw instead of silently doing nothing.
    this.line('static unsigned int ASC_so_default_encoding = 3u;');
    this.line('static bool ASC_so_prevent_backup = false;');
    // mkdir -p for the parent directory of a storage file. A shared-object name
    // may itself contain slashes (AIR example: getLocal("work/addresses")), and
    // a non-null localPath becomes a subdirectory.
    this.line('static void as_so_mkparent(const char* p) {');
    this.indent++;
    this.line('if (p == NULL) return;');
    this.line('const char* slash = NULL;');
    this.line('for (const char* s = p; *s != \'\\0\'; s++) if (*s == \'/\') slash = s;');
    this.line('if (slash == NULL || slash == p) return;');
    this.line('size_t n = (size_t)(slash - p);');
    this.line('char* dir = as_alloc(n + 1);');
    this.line('memcpy(dir, p, n); dir[n] = \'\\0\';');
    this.line('as_mkdirs(dir);');
    this.indent--;
    this.line('}');
    this.line('static char* as_so_path(const char* name, const char* localPath) {');
    this.indent++;
    this.line('char* base = as_app_storage_dir();');
    this.line('if (localPath != NULL && localPath[0] != \'\\0\') base = as_path_join(base, localPath);');
    this.line('return as_path_join(base, as_str_concat(name == NULL ? (char*)"" : name, (char*)".json"));');
    this.indent--;
    this.line('}');
    // Whole-file read into arena memory (NULL when the file does not exist).
    this.line('static char* as_so_load_text(const char* p) {');
    this.indent++;
    this.line('FILE* f = fopen(p, "rb");');
    this.line('if (f == NULL) return NULL;');
    this.line('size_t cap = 4096, len = 0, n = 0;');
    this.line('char* buf = as_alloc(cap);');
    this.line('while ((n = fread(buf + len, 1, cap - len - 1, f)) > 0) {');
    this.indent++;
    this.line('len += n;');
    this.line('if (len + 1 >= cap) { char* nb = as_alloc(cap * 2); memcpy(nb, buf, len); buf = nb; cap *= 2; }');
    this.indent--;
    this.line('}');
    this.line('fclose(f);');
    this.line('buf[len] = \'\\0\';');
    this.line('return buf;');
    this.indent--;
    this.line('}');
    this.line('void SharedObject_ctor(SharedObject* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->name = NULL;');
    this.line('o->path = NULL;');
    this.line('o->_data = as_object_new();');
    // AIR invokes callback methods on `client`; the default is the shared object
    // itself (adl-verified: so.client == so).
    this.line('o->_client = (void*)o;');
    this.line('o->_objectEncoding = ASC_so_default_encoding;');
    this.line('o->_fps = 0.0;');
    this.indent--;
    this.line('}');
    this.line('SharedObject* SharedObject_new(void) { SharedObject* o = (SharedObject*)gc_alloc(GCT_CLASS, sizeof(SharedObject)); o->vtable = &SharedObject_vt; SharedObject_ctor(o); return o; }');
    // Build an instance for a storage path, loading the persisted table when the
    // file exists. A file that parses to a non-object top level is treated as
    // empty (as_json_parse skips malformed input rather than reporting it).
    this.line('static SharedObject* as_so_make(char* name, char* path) {');
    this.indent++;
    this.line('SharedObject* o = (SharedObject*)gc_alloc(GCT_CLASS, sizeof(SharedObject));');
    this.line('o->vtable = &SharedObject_vt;');
    this.line('SharedObject_ctor(o);');
    this.line('o->name = name; gc_write_barrier((void*)name);');
    this.line('o->path = path; gc_write_barrier((void*)path);');
    this.line('char* text = as_so_load_text(path);');
    this.line('if (text != NULL && text[0] != \'\\0\') {');
    this.indent++;
    this.line('as_value v = as_json_parse(text);');
    this.line('if (v.tag == 4 && v.ptr != NULL) { o->_data = (as_object*)v.ptr; gc_write_barrier((void*)o->_data); }');
    this.indent--;
    this.line('}');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // flush-all for the exit hook: AIR writes every local shared object when the
    // application closes, so data set without an explicit flush() still persists
    // (adl-verified: a .sol appears after the app exits even when flush() was
    // never called). An object with an empty table is skipped, so clear() keeps
    // its observable effect of removing the backing file.
    this.line('static int as_so_flush(SharedObject* o);');
    this.line('static void as_so_flush_all(void) {');
    this.indent++;
    this.line('if (SharedObject__cache == NULL) return;');
    this.line('for (int i = 0; i < SharedObject__cache->length; i++) {');
    this.indent++;
    this.line('SharedObject* c = (SharedObject*)as_v_obj_val(SharedObject__cache->data[i]);');
    this.line('if (c == NULL || c->path == NULL || c->_data == NULL || c->_data->length == 0) continue;');
    this.line('as_so_flush(c);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // getLocal: one instance per resolved path per process (AIR returns the same
    // reference for the same name — adl-verified), so two handles to one name
    // cannot diverge. The cache is a declared static field, hence a GC root.
    this.line('SharedObject* SharedObject_getLocal_static(char* name, char* localPath, bool secure) {');
    this.indent++;
    this.line('(void)secure;  // this subset has no encrypted local store');
    this.line('if (name == NULL || name[0] == \'\\0\') { as_throw(Error_new((char*)"SharedObject.getLocal: the name parameter must be a non-empty String", 0)); return NULL; }');
    this.line('char* path = as_so_path(name, localPath);');
    this.line('if (SharedObject__cache == NULL) { SharedObject__cache = as_array_new(); atexit(as_so_flush_all); }');
    this.line('for (int i = 0; i < SharedObject__cache->length; i++) {');
    this.indent++;
    this.line('SharedObject* c = (SharedObject*)as_v_obj_val(SharedObject__cache->data[i]);');
    this.line('if (c != NULL && c->path != NULL && strcmp(c->path, path) == 0) return c;');
    this.indent--;
    this.line('}');
    this.line('SharedObject* so = as_so_make(name, path);');
    this.line('as_array_push(SharedObject__cache, as_v_obj((void*)so));');
    this.line('return so;');
    this.indent--;
    this.line('}');
    this.line('Object* SharedObject_get_data(void* _this) { SharedObject* o = (SharedObject*)_this; return (Object*)o->_data; }');
    // size: the byte count of the persisted representation, i.e. the size of the
    // file flush() writes (AIR: the AMF3 ".sol", which carries a 16-byte header
    // plus the object name — adl reports 48 bytes for {value:12345}, of which 15
    // are the AMF payload; ours is the JSON text, so the numbers are smaller but
    // follow the same rule). AIR reports the projected size even before the first
    // flush (adl: size=48 with no file on disk yet), so this measures the current
    // table instead of stat()ing the file.
    this.line('unsigned int SharedObject_get_size(void* _this) {');
    this.indent++;
    this.line('SharedObject* o = (SharedObject*)_this;');
    this.line('return (unsigned int)strlen(as_json_stringify(as_v_obj((void*)o->_data)));');
    this.indent--;
    this.line('}');
    this.line('Object* SharedObject_get_client(void* _this) { return (Object*)((SharedObject*)_this)->_client; }');
    this.line('void SharedObject_set_client(void* _this, Object* value) { SharedObject* o = (SharedObject*)_this; o->_client = (void*)value; gc_write_barrier((void*)value); }');
    this.line('unsigned int SharedObject_get_objectEncoding(void* _this) { return ((SharedObject*)_this)->_objectEncoding; }');
    this.line('void SharedObject_set_objectEncoding(void* _this, unsigned int value) { ((SharedObject*)_this)->_objectEncoding = value; }');
    // fps only throttles how often changes are uploaded to a server; a local
    // object has no server, so the value is stored and otherwise unused.
    this.line('void SharedObject_set_fps(void* _this, double value) { ((SharedObject*)_this)->_fps = value; }');
    this.line('unsigned int SharedObject_get_defaultObjectEncoding_static(void* _this) { (void)_this; return ASC_so_default_encoding; }');
    this.line('void SharedObject_set_defaultObjectEncoding_static(void* _this, unsigned int value) { (void)_this; ASC_so_default_encoding = value; }');
    this.line('bool SharedObject_get_preventBackup_static(void* _this) { (void)_this; return ASC_so_prevent_backup; }');
    this.line('void SharedObject_set_preventBackup_static(void* _this, bool value) { (void)_this; ASC_so_prevent_backup = value; }');
    // flush: synchronously write the table and report the AIR status string.
    // AIR can return "pending" when the request is queued; a local write either
    // succeeds or fails, and a failed write is reported as a thrown Error rather
    // than a silent "pending".
    this.line('static int as_so_flush(SharedObject* o) {');
    this.indent++;
    this.line('if (o->path == NULL) return 1;');
    this.line('as_so_mkparent(o->path);');
    this.line('char* json = as_json_stringify(as_v_obj((void*)o->_data));');
    this.line('FILE* f = fopen(o->path, "wb");');
    this.line('if (f == NULL) return 0;');
    this.line('fwrite(json, 1, strlen(json), f);');
    this.line('fclose(f);');
    this.line('return 1;');
    this.indent--;
    this.line('}');
    this.line('char* SharedObject_flush(void* _this, int minDiskSpace) {');
    this.indent++;
    this.line('(void)minDiskSpace;');
    this.line('if (!as_so_flush((SharedObject*)_this)) { as_throw(Error_new((char*)"SharedObject.flush: cannot write the storage file", 0)); return (char*)"pending"; }');
    this.line('return (char*)"flushed";');
    this.indent--;
    this.line('}');
    // clear: purge the table and delete the backing file (AIR does both), while
    // leaving the object usable — a later flush recreates the file.
    this.line('void SharedObject_clear(void* _this) {');
    this.indent++;
    this.line('SharedObject* o = (SharedObject*)_this;');
    this.line('o->_data = as_object_new();');
    this.line('gc_write_barrier((void*)o->_data);');
    this.line('if (o->path != NULL) remove(o->path);');
    this.indent--;
    this.line('}');
    // close: AIR documents it as affecting remote objects only (adl-verified: a
    // local object keeps its data, its file and stays usable), so this is a no-op.
    this.line('void SharedObject_close(void* _this) { (void)_this; }');
    // setDirty exists so the server can be told which property changed; a local
    // object tracks dirtiness itself and flush() writes the whole table.
    this.line('void SharedObject_setDirty(void* _this, char* propertyName) { (void)_this; (void)propertyName; }');
    this.line('void SharedObject_setProperty(void* _this, char* propertyName, as_value value) {');
    this.indent++;
    this.line('SharedObject* o = (SharedObject*)_this;');
    this.line('if (propertyName == NULL) return;');
    this.line('as_object_set(o->_data, propertyName, value);');
    this.indent--;
    this.line('}');
    // Remote half: no Flash Media Server exists in this runtime, so these fail
    // loudly (a message the caller can act on) instead of pretending to work.
    this.line('SharedObject* SharedObject_getRemote_static(char* name, char* remotePath, as_value persistence, bool secure) {');
    this.indent++;
    this.line('(void)name; (void)remotePath; (void)persistence; (void)secure;');
    this.line('as_throw(Error_new((char*)"SharedObject.getRemote requires a Flash Media Server connection, which this AOT runtime does not provide (only local shared objects are supported)", 0));');
    this.line('return NULL;');
    this.indent--;
    this.line('}');
    this.line('void SharedObject_connect(void* _this, as_value myConnection, as_value params) { (void)_this; (void)myConnection; (void)params; as_throw(Error_new((char*)"SharedObject.connect requires a Flash Media Server connection, which this AOT runtime does not provide", 0)); }');
    this.line('void SharedObject_send(void* _this, as_array* arguments) { (void)_this; (void)arguments; as_throw(Error_new((char*)"SharedObject.send requires a Flash Media Server connection, which this AOT runtime does not provide", 0)); }');
    this.line('');
    // Inside-out hit test (Ruffle interactive.rs Avm2MousePick). mouseChildren=true
    // means children are tested first (reverse depth = topmost first) and a hit
    // propagates to the deepest child; mouseChildren=false makes this parent
    // absorb the hit (its own bounds decide). mouseEnabled=false means the object
    // itself never reports a hit. Rotation/scale transforms are ignored here.
    this.line('static bool as_obj_hit(void* obj, double x, double y) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)obj;');
    this.line('return x >= o->x && x <= o->x + o->width && y >= o->y && y <= o->y + o->height;');
    this.indent--;
    this.line('}');
    // Sprite.hitTestPoint(x, y, shapeFlag): true when the point falls inside the
    // sprite's untransformed bounds (shapeFlag is accepted but ignored — this
    // subset has no vector-shape hit mask, matching the bounds-only as_obj_hit).
    this.line('bool Sprite_hitTestPoint(void* _this, double x, double y, bool shapeFlag) {');
    this.indent++;
    this.line('(void)shapeFlag;');
    this.line('return as_obj_hit(_this, x, y);');
    this.indent--;
    this.line('}');
    this.line('static void* as_pick_hit(void* obj, double x, double y) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)obj;');
    this.line('if (!o->visible) return NULL;');
    // Only InteractiveObject subclasses read mouseChildren/mouseEnabled below;
    // pure DisplayObject leaves (Shape/Bitmap) are hit-test transparent.
    this.line('if (as_is(obj, &DisplayObjectContainer_vt)) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)obj;');
    this.line('if (((InteractiveObject*)obj)->mouseChildren && c->children != NULL) {');
    this.indent++;
    this.line('for (int i = c->children->length - 1; i >= 0; i--) {');
    this.indent++;
    this.line('void* r = as_pick_hit(as_v_obj_val(c->children->data[i]), x, y);');
    this.line('if (r != NULL) return r;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('if (as_is(obj, &InteractiveObject_vt)) {');
    this.indent++;
    this.line('InteractiveObject* io = (InteractiveObject*)obj;');
    this.line('if (as_obj_hit(obj, x, y) && io->mouseEnabled) return obj;');
    this.indent--;
    this.line('}');
    this.line('return NULL;');
    this.indent--;
    this.line('}');
    // Stage.dispatchMouse(x, y, type): non-standard test hook that hit-tests the
    // tree and dispatches a bubbling MouseEvent from the deepest target, so
    // capture/target/bubble runs against the ancestor chain.
    // It also drives TextField text selection: mouseDown on a selectable field
    // starts a drag (caret placed at the hit index), mouseMove extends the
    // selection, mouseUp ends it. drag_tf is a C static, not a GC root — it only
    // lives between mouseDown and mouseUp, where no GC safe point runs.
    this.line('static int as_tf_index_at(TextField* tf, double x, double y);');
    this.line('void Stage_dispatchMouse(void* _this, double x, double y, char* type) {');
    this.indent++;
    this.line('void* target = as_pick_hit(_this, x, y);');
    this.line('static TextField* drag_tf = NULL;');
    this.line('if (strcmp(type, "mouseDown") == 0) {');
    this.indent++;
    this.line('drag_tf = NULL;');
    this.line('if (target != NULL && as_is(target, &TextField_vt) && ((TextField*)target)->selectable) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)target;');
    this.line('int idx = as_tf_index_at(tf, x, y);');
    this.line('tf->_sel_begin = idx; tf->_sel_end = idx; tf->_sel_caret = idx;');
    this.line('drag_tf = tf;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else if (strcmp(type, "mouseMove") == 0 && drag_tf != NULL) {');
    this.indent++;
    this.line('int idx = as_tf_index_at(drag_tf, x, y);');
    this.line('drag_tf->_sel_end = idx; drag_tf->_sel_caret = idx;');
    this.indent--;
    this.line('} else if (strcmp(type, "mouseUp") == 0) {');
    this.indent++;
    this.line('drag_tf = NULL;');
    this.indent--;
    this.line('}');
    // Starling listens for mouse events on the *native stage* (it then hit-tests
    // its own Stage3D display tree via TouchProcessor). AIR dispatches these stage
    // mouse events regardless of whether a native display-list object was hit, so
    // a miss must NOT drop the event — fall back to the stage itself so Starling's
    // onTouch still fires. localX/localY stay target-relative; stageX/stageY are
    // the global (stage-space) coordinates Starling reads.
    this.line('if (target == NULL) target = _this;');
    this.line('DisplayObject* o = (DisplayObject*)target;');
    this.line('MouseEvent* evt = MouseEvent_new(type, true, false, x - o->x, y - o->y, NULL, false, false, false, false, 0.0);');
    this.line('evt->stageX = x;');
    this.line('evt->stageY = y;');
    this.line('EventDispatcher_dispatchEvent(target, (Event*)evt);');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.display drawing + rendering (stage 37) ----
    // Graphics accumulates one SkPath plus a current fill/stroke paint pair; the
    // recursive render() below replays the path with whichever paints are set
    // (single-path subset — multiple beginFill/endFill groups are a later stage).
    this.line('void Graphics_ctor(Graphics* o) {');
    this.indent++;
    this.line('o->path = as_skia_path_new();');
    this.line('o->fill = NULL; o->stroke = NULL;');
    this.indent--;
    this.line('}');
    this.line('Graphics* Graphics_new(void) {');
    this.indent++;
    this.line('Graphics* o = (Graphics*)gc_alloc(GCT_CLASS, sizeof(Graphics));');
    this.line('o->vtable = &Graphics_vt;');
    this.line('Graphics_ctor(o);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void Graphics_moveTo(void* _this, double x, double y) { as_skia_path_move_to(((Graphics*)_this)->path, x, y); }');
    this.line('void Graphics_lineTo(void* _this, double x, double y) { as_skia_path_line_to(((Graphics*)_this)->path, x, y); }');
    this.line('void Graphics_curveTo(void* _this, double cx, double cy, double ax, double ay) { as_skia_path_quad_to(((Graphics*)_this)->path, cx, cy, ax, ay); }');
    this.line('void Graphics_beginFill(void* _this, unsigned color, double alpha) {');
    this.indent++;
    this.line('Graphics* g = (Graphics*)_this;');
    this.line('as_skia_paint_delete(g->fill);');
    this.line('g->fill = as_skia_paint_fill(color, alpha);');
    this.indent--;
    this.line('}');
    this.line('void Graphics_endFill(void* _this) { (void)_this; } // deferred: drawn at render()');
    this.line('void Graphics_lineStyle(void* _this, double thickness, unsigned color, double alpha) {');
    this.indent++;
    this.line('Graphics* g = (Graphics*)_this;');
    this.line('as_skia_paint_delete(g->stroke);');
    this.line('g->stroke = (thickness <= 0.0) ? NULL : as_skia_paint_stroke(color, alpha, thickness);');
    this.indent--;
    this.line('}');
    this.line('void Graphics_beginGradientFill(void* _this, char* type, as_array* colors, as_array* alphas, as_array* ratios, Object* matrix) {');
    this.indent++;
    this.line('Graphics* g = (Graphics*)_this;');
    this.line('(void)type; (void)ratios; (void)matrix; // minimal: linear two-stop only');
    this.line('unsigned c0 = (colors != NULL && colors->length > 0) ? as_v_uint_val(colors->data[0]) : 0u;');
    this.line('unsigned c1 = (colors != NULL && colors->length > 1) ? as_v_uint_val(colors->data[1]) : c0;');
    this.line('double a0 = (alphas != NULL && alphas->length > 0) ? as_v_num_val(alphas->data[0]) : 1.0;');
    this.line('double a1 = (alphas != NULL && alphas->length > 1) ? as_v_num_val(alphas->data[1]) : a0;');
    this.line('as_skia_paint_delete(g->fill);');
    this.line('g->fill = as_skia_paint_fill(c0, a0);');
    this.line('as_skia_paint_set_linear_gradient(g->fill, 0.0, 0.0, 100.0, 0.0, c0, a0, c1, a1);');
    this.indent--;
    this.line('}');
    this.line('void Graphics_drawRect(void* _this, double x, double y, double w, double h) { as_skia_path_add_rect(((Graphics*)_this)->path, x, y, w, h); }');
    this.line('void Graphics_drawRoundRect(void* _this, double x, double y, double w, double h, double ew, double eh) { (void)ew; (void)eh; as_skia_path_add_rect(((Graphics*)_this)->path, x, y, w, h); }');
    this.line('void Graphics_drawCircle(void* _this, double x, double y, double r) { as_skia_path_add_circle(((Graphics*)_this)->path, x, y, r); }');
    this.line('void Graphics_clear(void* _this) {');
    this.indent++;
    this.line('Graphics* g = (Graphics*)_this;');
    this.line('as_skia_path_delete(g->path);');
    this.line('g->path = as_skia_path_new();');
    this.line('as_skia_paint_delete(g->fill); g->fill = NULL;');
    this.line('as_skia_paint_delete(g->stroke); g->stroke = NULL;');
    this.indent--;
    this.line('}');
    this.line('void Shape_ctor(Shape* o) {');
    this.indent++;
    this.line('DisplayObject_ctor((DisplayObject*)o);');
    this.line('o->graphics = Graphics_new();');
    this.indent--;
    this.line('}');
    this.line('Shape* Shape_new(void) { Shape* o = (Shape*)gc_alloc(GCT_CLASS, sizeof(Shape)); o->vtable = &Shape_vt; Shape_ctor(o); return o; }');
    this.line('void BitmapData_ctor(BitmapData* o, int width, int height, bool transparent, unsigned fillColor) {');
    this.indent++;
    this.line('o->width = width; o->height = height; o->transparent = transparent;');
    this.line('o->image = NULL; o->pixels = NULL;');
    this.line('if (width > 0 && height > 0) {');
    this.indent++;
    // GC heap, not malloc: `pixels` is a GC-traced field (the props table tags it
    // type 6), so the buffer is reclaimed with its owner. Zeros come free from
    // gc_alloc; the fill loop below overwrites them anyway.
    this.line('o->pixels = (void*)gc_alloc(GCT_BYTES, sizeof(unsigned) * (size_t)(width * height));');
    this.line('unsigned a = transparent ? (fillColor >> 24) : 0xFFu;');
    this.line('unsigned argb = (a << 24) | (fillColor & 0xFFFFFFu);');
    this.line('gc_write_barrier(o->pixels);');
    this.line('unsigned* p = (unsigned*)o->pixels;');
    this.line('for (int i = 0; i < width * height; i++) p[i] = argb;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('BitmapData* BitmapData_new(int width, int height, bool transparent, unsigned fillColor) {');
    this.indent++;
    this.line('BitmapData* o = (BitmapData*)gc_alloc(GCT_CLASS, sizeof(BitmapData));');
    this.line('o->vtable = &BitmapData_vt;');
    this.line('BitmapData_ctor(o, width, height, transparent, fillColor);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('unsigned BitmapData_getPixel(void* _this, int x, int y) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (bd->pixels == NULL || x < 0 || y < 0 || x >= bd->width || y >= bd->height) return 0u;');
    this.line('return ((unsigned*)bd->pixels)[y * bd->width + x] & 0xFFFFFFu;');
    this.indent--;
    this.line('}');
    this.line('void BitmapData_setPixel(void* _this, int x, int y, unsigned color) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (bd->pixels == NULL || x < 0 || y < 0 || x >= bd->width || y >= bd->height) return;');
    this.line('((unsigned*)bd->pixels)[y * bd->width + x] = 0xFF000000u | (color & 0xFFFFFFu);');
    this.indent--;
    this.line('}');
    this.line('void BitmapData_loadFile(void* _this, char* path) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    // Decode the file into an ARGB pixel buffer and adopt the image's real
    // dimensions (AS3 loadFile adopts the source image size). On failure the
    // constructor's blank buffer and size are left untouched.
    this.line('int w = 0, h = 0;');
    this.line('void* px = as_skia_image_decode_argb(path, &w, &h);');
    // Same ownership move as Loader_loadBytes: glue malloc -> GC byte buffer.
    // The OLD buffer is only dropped, never free()d: `pixels` lives on the GC
    // heap (stage 89-42), and free() on a GC pointer corrupts the GC free list
    // (exactly the rule BitmapData_dispose documents). This used to read
    // `free(bd->pixels);`, which abort()ed on the very first successful loadFile
    // over a user-constructed BitmapData -- `new BitmapData(1,1)` gives pixels a
    // real GC block, and freeing it wedges the allocator. It stayed hidden
    // because no regression ever exercised a SUCCESSFUL loadFile (every probe fed
    // it an undecodable file, which leaves this branch untaken), and because
    // Loader__imageFinish's twin call is a no-op free(NULL) -- its BitmapData is
    // built with 0x0, where the constructor leaves pixels NULL.
    this.line('if (px != NULL) { unsigned* gcpx = (unsigned*)gc_alloc(GCT_BYTES, sizeof(unsigned) * (size_t)(w * h)); memcpy(gcpx, px, sizeof(unsigned) * (size_t)(w * h)); free(px); bd->pixels = (void*)gcpx; gc_write_barrier(bd->pixels); bd->width = w; bd->height = h; }');
    // Keep the SkImage view for the display-list Bitmap render path as well.
    this.line('bd->image = as_skia_image_from_file(path);');
    this.indent--;
    this.line('}');
    // fillRect: fill a rectangular region with an ARGB color. The color's alpha is
    // honored only when the bitmap is transparent (opaque bitmaps force 0xFF), mirroring
    // the BitmapData constructor's fillColor semantics.
    this.line('void BitmapData_fillRect(void* _this, Rectangle* rect, unsigned color) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (bd->pixels == NULL || rect == NULL) return;');
    this.line('int x0 = (int)rect->x, y0 = (int)rect->y;');
    this.line('int w = (int)rect->width, h = (int)rect->height;');
    this.line('if (x0 < 0) { w += x0; x0 = 0; } if (y0 < 0) { h += y0; y0 = 0; }');
    this.line('if (x0 + w > bd->width) w = bd->width - x0;');
    this.line('if (y0 + h > bd->height) h = bd->height - y0;');
    this.line('if (w <= 0 || h <= 0) return;');
    this.line('unsigned a = bd->transparent ? (color >> 24) : 0xFFu;');
    this.line('unsigned argb = (a << 24) | (color & 0xFFFFFFu);');
    this.line('unsigned* p = (unsigned*)bd->pixels;');
    this.line('for (int y = y0; y < y0 + h; y++) for (int x = x0; x < x0 + w; x++) p[y * bd->width + x] = argb;');
    this.indent--;
    this.line('}');
    // draw: composite `source` into this bitmap under an affine matrix. AS3 semantics:
    // the matrix maps source-space into destination-space, so each destination pixel
    // samples source via the INVERSE transform (pixel-center mapping). smoothing toggles
    // nearest-neighbor vs bilinear. colorTransform multiplies+offsets channels when given;
    // blendMode is only ever "normal" (null) in practice. Used by the shmup mipmap chain.
    // `source` is either a real BitmapData or, through the IBitmapDrawable signature, a
    // TextField (Starling's TrueTypeCompositor rasterizes native text via draw(TextField)).
    this.line('static void as_render_object_content(void* canvas, DisplayObject* o);');
    this.line('static void as_tf_apply_autosize(TextField* tf);');
    this.line('void BitmapData_draw(void* _this, BitmapData* source, Matrix* matrix, ColorTransform* ct, char* blendMode, Rectangle* clipRect, bool smoothing) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (source == NULL || bd->pixels == NULL) return;');
    this.line('if (blendMode != NULL && strcmp(blendMode, "normal") != 0) { as_throw(Error_new((char*)"BitmapData.draw: blendMode not implemented", 0)); return; }');
    this.line('int cx0 = 0, cy0 = 0, cx1 = bd->width, cy1 = bd->height;');
    this.line('if (clipRect != NULL) { cx0 = (int)clipRect->x; cy0 = (int)clipRect->y; cx1 = cx0 + (int)clipRect->width; cy1 = cy0 + (int)clipRect->height; if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > bd->width) cx1 = bd->width; if (cy1 > bd->height) cy1 = bd->height; }');
    this.line('double a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;');
    this.line('if (matrix != NULL) { a = matrix->a; b = matrix->b; c = matrix->c; d = matrix->d; tx = matrix->tx; ty = matrix->ty; }');
    this.line('double det = a * d - b * c;');
    this.line('double ia = 1, ib = 0, ic = 0, id = 1, itx = 0, ity = 0;');
    this.line('if (det != 0.0) { ia = d / det; ic = -c / det; itx = (c * ty - d * tx) / det; ib = -b / det; id = a / det; ity = (b * tx - a * ty) / det; }');
    // A TextField source has a completely different struct layout than BitmapData,
    // so it cannot be sampled as `source->pixels`. Rasterize it into a temporary
    // straight-ARGB buffer first (see below), then fall through to the same
    // inverse-mapping sampling loop as a plain BitmapData.
    this.line('const unsigned* sp;');
    this.line('int sw = 0, sh = 0;');
    this.line('unsigned* owned = NULL;');
    this.line('if (as_is(source, &TextField_vt)) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)source;');
    this.line('as_tf_apply_autosize(tf);');
    this.line('sw = (int)ceil(tf->width); if (sw < 1) sw = 1;');
    this.line('sh = (int)ceil(tf->height); if (sh < 1) sh = 1;');
    this.line('void* surface = as_skia_surface_bake_new(sw, sh);');
    this.line('if (surface == NULL) return;');
    this.line('void* canvas = as_skia_surface_canvas(surface);');
    this.line('as_skia_canvas_clear_transparent(canvas);');
    this.line('as_render_object_content(canvas, (DisplayObject*)tf);');
    this.line('owned = (unsigned*)malloc(sizeof(unsigned) * (size_t)(sw * sh));');
    this.line('if (owned == NULL) { as_skia_surface_delete(surface); return; }');
    // Read the baked TextField back into the runtime's straight-ARGB layout. The
    // channel order is settled inside skia_glue (which requests kBGRA_8888
    // explicitly, because Skia's own kN32 is BGRA on Windows but RGBA on macOS
    // and Linux); deciding it here instead swapped red and blue on macOS.
    this.line('if (!as_skia_surface_read_argb(surface, owned, sw, sh)) { free(owned); as_skia_surface_delete(surface); return; }');
    this.line('as_skia_surface_delete(surface);');
    this.line('sp = owned;');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('if (source->pixels == NULL) return;');
    this.line('sp = (const unsigned*)source->pixels;');
    this.line('sw = source->width; sh = source->height;');
    this.indent--;
    this.line('}');
    this.line('unsigned* dp = (unsigned*)bd->pixels;');
    this.line('double rm = 1, gm = 1, bm = 1, am = 1, ro = 0, go = 0, bo = 0, ao = 0;');
    this.line('if (ct != NULL) { rm = ct->redMultiplier; gm = ct->greenMultiplier; bm = ct->blueMultiplier; am = ct->alphaMultiplier; ro = ct->redOffset; go = ct->greenOffset; bo = ct->blueOffset; ao = ct->alphaOffset; }');
    this.line('for (int dy = cy0; dy < cy1; dy++) { for (int dx = cx0; dx < cx1; dx++) {');
    this.indent++;
    this.line('double scx = ia * (dx + 0.5) + ic * (dy + 0.5) + itx;');
    this.line('double scy = ib * (dx + 0.5) + id * (dy + 0.5) + ity;');
    this.line('unsigned sr = 0, sg = 0, sb = 0, sa = 0;');
    this.line('if (!smoothing) { int sx = (int)floor(scx), sy = (int)floor(scy); if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) { dp[dy * bd->width + dx] = 0u; continue; } unsigned c = sp[sy * sw + sx]; sr = (c >> 16) & 0xFF; sg = (c >> 8) & 0xFF; sb = c & 0xFF; sa = c >> 24; }');
    this.line('else { double u = scx - 0.5, v = scy - 0.5; int x0 = (int)floor(u), y0 = (int)floor(v); double fx = u - x0, fy = v - y0; unsigned c00 = 0, c10 = 0, c01 = 0, c11 = 0;');
    this.indent++;
    this.line('if (x0 >= 0 && y0 >= 0 && x0 < sw && y0 < sh) c00 = sp[y0 * sw + x0];');
    this.line('if (x0 + 1 >= 0 && y0 >= 0 && x0 + 1 < sw && y0 < sh) c10 = sp[y0 * sw + x0 + 1];');
    this.line('if (x0 >= 0 && y0 + 1 >= 0 && x0 < sw && y0 + 1 < sh) c01 = sp[(y0 + 1) * sw + x0];');
    this.line('if (x0 + 1 >= 0 && y0 + 1 >= 0 && x0 + 1 < sw && y0 + 1 < sh) c11 = sp[(y0 + 1) * sw + x0 + 1];');
    this.line('double w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;');
    this.line('sa = (unsigned)((c00 >> 24) * w00 + (c10 >> 24) * w10 + (c01 >> 24) * w01 + (c11 >> 24) * w11 + 0.5);');
    this.line('sr = (unsigned)(((c00 >> 16) & 0xFF) * w00 + ((c10 >> 16) & 0xFF) * w10 + ((c01 >> 16) & 0xFF) * w01 + ((c11 >> 16) & 0xFF) * w11 + 0.5);');
    this.line('sg = (unsigned)(((c00 >> 8) & 0xFF) * w00 + ((c10 >> 8) & 0xFF) * w10 + ((c01 >> 8) & 0xFF) * w01 + ((c11 >> 8) & 0xFF) * w11 + 0.5);');
    this.line('sb = (unsigned)((c00 & 0xFF) * w00 + (c10 & 0xFF) * w10 + (c01 & 0xFF) * w01 + (c11 & 0xFF) * w11 + 0.5);');
    this.indent--;
    this.line('}');
    this.line('if (ct != NULL) { double rr = (sr * rm + ro), gg = (sg * gm + go), bb = (sb * bm + bo), aa = (sa * am + ao); if (rr < 0) rr = 0; if (rr > 255) rr = 255; if (gg < 0) gg = 0; if (gg > 255) gg = 255; if (bb < 0) bb = 0; if (bb > 255) bb = 255; if (aa < 0) aa = 0; if (aa > 255) aa = 255; sr = (unsigned)rr; sg = (unsigned)gg; sb = (unsigned)bb; sa = (unsigned)aa; }');
    this.line('dp[dy * bd->width + dx] = (sa << 24) | (sr << 16) | (sg << 8) | sb;');
    this.indent--;
    this.line('} }');
    this.line('if (owned != NULL) free(owned);');
    this.indent--;
    this.line('}');
    this.line('void Bitmap_ctor(Bitmap* o, BitmapData* bitmapData) {');
    this.indent++;
    this.line('DisplayObject_ctor((DisplayObject*)o);');
    this.line('o->bitmapData = bitmapData;');
    this.line('gc_write_barrier((void*)bitmapData);');
    this.indent--;
    this.line('}');
    this.line('Bitmap* Bitmap_new(BitmapData* bitmapData) { Bitmap* o = (Bitmap*)gc_alloc(GCT_CLASS, sizeof(Bitmap)); o->vtable = &Bitmap_vt; Bitmap_ctor(o, bitmapData); return o; }');
    this.line('');
    // ---- flash.filters (stage 61) ----
    // Filter value bundles. BitmapFilter is an abstract base; concrete filters are
    // plain structs. clone() returns a new instance copying every field.
    this.line('void BitmapFilter_ctor(BitmapFilter* o) { (void)o; }');
    this.line('BitmapFilter* BitmapFilter_new(void) { BitmapFilter* o = (BitmapFilter*)gc_alloc(GCT_CLASS, sizeof(BitmapFilter)); o->vtable = &BitmapFilter_vt; BitmapFilter_ctor(o); return o; }');
    this.line('BitmapFilter* BitmapFilter_clone(void* _this) { BitmapFilter* o = (BitmapFilter*)gc_alloc(GCT_CLASS, sizeof(BitmapFilter)); o->vtable = &BitmapFilter_vt; BitmapFilter_ctor(o); return o; }');
    this.line('void BlurFilter_ctor(BlurFilter* o, double blurX, double blurY, int quality) { BitmapFilter_ctor((BitmapFilter*)o); o->blurX = blurX; o->blurY = blurY; o->quality = quality; }');
    this.line('BlurFilter* BlurFilter_new(double blurX, double blurY, int quality) { BlurFilter* o = (BlurFilter*)gc_alloc(GCT_CLASS, sizeof(BlurFilter)); o->vtable = &BlurFilter_vt; BlurFilter_ctor(o, blurX, blurY, quality); return o; }');
    this.line('BitmapFilter* BlurFilter_clone(void* _this) { BlurFilter* s = (BlurFilter*)_this; return (BitmapFilter*)BlurFilter_new(s->blurX, s->blurY, s->quality); }');
    this.line('void DropShadowFilter_ctor(DropShadowFilter* o, double distance, double angle, unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout, bool hideObject) { BitmapFilter_ctor((BitmapFilter*)o); o->distance = distance; o->angle = angle; o->color = color; o->alpha = floor(alpha * 255.0) / 255.0; o->blurX = blurX; o->blurY = blurY; o->strength = strength; o->quality = quality; o->inner = inner; o->knockout = knockout; o->hideObject = hideObject; }');
    this.line('DropShadowFilter* DropShadowFilter_new(double distance, double angle, unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout, bool hideObject) { DropShadowFilter* o = (DropShadowFilter*)gc_alloc(GCT_CLASS, sizeof(DropShadowFilter)); o->vtable = &DropShadowFilter_vt; DropShadowFilter_ctor(o, distance, angle, color, alpha, blurX, blurY, strength, quality, inner, knockout, hideObject); return o; }');
    this.line('BitmapFilter* DropShadowFilter_clone(void* _this) { DropShadowFilter* s = (DropShadowFilter*)_this; return (BitmapFilter*)DropShadowFilter_new(s->distance, s->angle, s->color, s->alpha, s->blurX, s->blurY, s->strength, s->quality, s->inner, s->knockout, s->hideObject); }');
    this.line('void GlowFilter_ctor(GlowFilter* o, unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout) { BitmapFilter_ctor((BitmapFilter*)o); o->color = color; o->alpha = floor(alpha * 255.0) / 255.0; o->blurX = blurX; o->blurY = blurY; o->strength = strength; o->quality = quality; o->inner = inner; o->knockout = knockout; }');
    this.line('GlowFilter* GlowFilter_new(unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout) { GlowFilter* o = (GlowFilter*)gc_alloc(GCT_CLASS, sizeof(GlowFilter)); o->vtable = &GlowFilter_vt; GlowFilter_ctor(o, color, alpha, blurX, blurY, strength, quality, inner, knockout); return o; }');
    this.line('BitmapFilter* GlowFilter_clone(void* _this) { GlowFilter* s = (GlowFilter*)_this; return (BitmapFilter*)GlowFilter_new(s->color, s->alpha, s->blurX, s->blurY, s->strength, s->quality, s->inner, s->knockout); }');
    this.line('Rectangle* BitmapData_get_rect(void* _this) { BitmapData* bd = (BitmapData*)_this; return Rectangle_new(0.0, 0.0, (double)bd->width, (double)bd->height); }');
    this.line('');
    // Separable repeated box blur. `passes` rounds of horizontal+vertical box
    // filtering approximate a Gaussian — exactly what AS3's `quality` knob controls
    // (higher = more passes = closer to Gaussian). Naive per-pixel window is O(w*h*r)
    // but simple and exact; BlurFilter test images are small.
    this.line('static void as_blur_apply(unsigned* dst, const unsigned* src, int w, int h, int rx, int ry, int passes) {');
    this.indent++;
    this.line('if (w <= 0 || h <= 0) return;');
    this.line('unsigned* tmp = (unsigned*)malloc(sizeof(unsigned) * (size_t)(w * h));');
    this.line('unsigned* a = (unsigned*)malloc(sizeof(unsigned) * (size_t)(w * h));');
    this.line('memcpy(a, src, sizeof(unsigned) * (size_t)(w * h));');
    this.line('if (rx < 0) rx = 0; if (ry < 0) ry = 0; if (passes < 1) passes = 1;');
    this.line('for (int p = 0; p < passes; p++) {');
    this.indent++;
    this.line('for (int y = 0; y < h; y++) {');
    this.indent++;
    this.line('const unsigned* row = a + (size_t)y * w; unsigned* out = tmp + (size_t)y * w;');
    this.line('for (int x = 0; x < w; x++) {');
    this.indent++;
    this.line('int lo = x - rx; if (lo < 0) lo = 0; int hi = x + rx; if (hi >= w) hi = w - 1;');
    this.line('long sa = 0, sr = 0, sg = 0, sb = 0; int cnt = 0;');
    this.line('for (int xx = lo; xx <= hi; xx++) { unsigned c = row[xx]; sa += c >> 24; sr += (c >> 16) & 0xFF; sg += (c >> 8) & 0xFF; sb += c & 0xFF; cnt++; }');
    this.line('out[x] = (unsigned)((sa / cnt) << 24) | (unsigned)((sr / cnt) << 16) | (unsigned)((sg / cnt) << 8) | (unsigned)(sb / cnt);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('for (int x = 0; x < w; x++) {');
    this.indent++;
    this.line('for (int y = 0; y < h; y++) {');
    this.indent++;
    this.line('int lo = y - ry; if (lo < 0) lo = 0; int hi = y + ry; if (hi >= h) hi = h - 1;');
    this.line('long sa = 0, sr = 0, sg = 0, sb = 0; int cnt = 0;');
    this.line('for (int yy = lo; yy <= hi; yy++) { unsigned c = tmp[(size_t)yy * w + x]; sa += c >> 24; sr += (c >> 16) & 0xFF; sg += (c >> 8) & 0xFF; sb += c & 0xFF; cnt++; }');
    this.line('a[(size_t)y * w + x] = (unsigned)((sa / cnt) << 24) | (unsigned)((sr / cnt) << 16) | (unsigned)((sg / cnt) << 8) | (unsigned)(sb / cnt);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('memcpy(dst, a, sizeof(unsigned) * (size_t)(w * h));');
    this.line('free(tmp); free(a);');
    this.indent--;
    this.line('}');
    // applyFilter: blur sourceRect of sourceBitmapData (via BlurFilter) into this
    // at destPoint. DropShadowFilter/GlowFilter rasterization is deferred (throw);
    // unknown filters are value-only no-ops.
    this.line('void BitmapData_applyFilter(void* _this, BitmapData* source, Rectangle* sourceRect, Point* destPoint, BitmapFilter* filter) {');
    this.indent++;
    this.line('BitmapData* dst = (BitmapData*)_this;');
    this.line('if (dst == NULL || source == NULL || source->pixels == NULL || dst->pixels == NULL || filter == NULL || sourceRect == NULL || destPoint == NULL) return;');
    this.line('int blurX = 0, blurY = 0, quality = 1;');
    this.line('if (as_is(filter, &BlurFilter_vt)) { BlurFilter* b = (BlurFilter*)filter; blurX = (int)b->blurX; blurY = (int)b->blurY; quality = b->quality; }');
    this.line('else if (as_is(filter, &DropShadowFilter_vt) || as_is(filter, &GlowFilter_vt)) { as_throw(Error_new((char*)"applyFilter: DropShadowFilter/GlowFilter rasterization not implemented", 0)); return; }');
    this.line('else { return; }');
    this.line('int sx = (int)sourceRect->x, sy = (int)sourceRect->y;');
    this.line('int sw = (int)sourceRect->width, sh = (int)sourceRect->height;');
    this.line('if (sx < 0) { sw += sx; sx = 0; } if (sy < 0) { sh += sy; sy = 0; }');
    this.line('if (sw > source->width - sx) sw = source->width - sx;');
    this.line('if (sh > source->height - sy) sh = source->height - sy;');
    this.line('if (sw <= 0 || sh <= 0) return;');
    this.line('int dx = (int)destPoint->x, dy = (int)destPoint->y;');
    this.line('unsigned* region = (unsigned*)malloc(sizeof(unsigned) * (size_t)(sw * sh));');
    this.line('const unsigned* sp = (const unsigned*)source->pixels;');
    this.line('for (int y = 0; y < sh; y++) memcpy(region + (size_t)y * sw, sp + (size_t)(sy + y) * source->width + sx, sizeof(unsigned) * (size_t)sw);');
    this.line('unsigned* blurred = (unsigned*)malloc(sizeof(unsigned) * (size_t)(sw * sh));');
    this.line('as_blur_apply(blurred, region, sw, sh, blurX / 2, blurY / 2, quality);');
    this.line('unsigned* dp = (unsigned*)dst->pixels;');
    this.line('for (int y = 0; y < sh; y++) { int ty = dy + y; if (ty < 0 || ty >= dst->height) continue; for (int x = 0; x < sw; x++) { int tx = dx + x; if (tx < 0 || tx >= dst->width) continue; dp[(size_t)ty * dst->width + tx] = blurred[(size_t)y * sw + x]; } }');
    this.line('free(region); free(blurred);');
    this.indent--;
    this.line('}');
    // perlinNoise: fill the bitmap with a deterministic hash-based grayscale noise
    // (an approximation of the Perlin/fractal noise AIR generates; the demo only
    // needs a textured source for DisplacementMapFilter, not an exact match).
    this.line('void BitmapData_perlinNoise(void* _this, double baseX, double baseY, unsigned numOctaves, int randomSeed, bool stitch, bool fractalNoise) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('(void)baseX; (void)baseY; (void)numOctaves; (void)stitch; (void)fractalNoise;');
    this.line('if (bd->pixels == NULL) return;');
    this.line('unsigned* p = (unsigned*)bd->pixels;');
    this.line('unsigned seed = (unsigned)randomSeed;');
    this.line('for (int y = 0; y < bd->height; y++) {');
    this.indent++;
    this.line('for (int x = 0; x < bd->width; x++) {');
    this.indent++;
    this.line('unsigned h = seed + ((unsigned)x * 73856093u) ^ ((unsigned)y * 19349663u);');
    this.line('h = (h ^ (h >> 13)) * 1274126177u;');
    this.line('h = h ^ (h >> 16);');
    this.line('unsigned g = h & 0xFFu;');
    this.line('p[(size_t)y * bd->width + x] = 0xFF000000u | (g << 16) | (g << 8) | g;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // dispose: release the raw pixel buffer and the decoded SkImage view (AS3 frees
    // the bitmap's pixel memory; the object is unusable afterward).
    this.line('void BitmapData_dispose(void* _this) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (bd == NULL) return;');
    // dispose() drops the pixel buffer instead of free()ing it: the buffer lives
    // on the GC heap now (free() on it would corrupt the GC's free list). AIR
    // releases the memory immediately; here the next collection reclaims it.
    this.line('bd->pixels = NULL;');
    this.line('if (bd->image != NULL) { as_skia_image_delete(bd->image); bd->image = NULL; }');
    this.indent--;
    this.line('}');
    // setPixels(rect, inputByteArray): copy 32-bit ARGB pixel values out of the
    // byte array into this bitmap's rectangle. AIR's contract is "32-bit ARGB
    // pixel values", and ByteArray is BIG-endian by default, so a
    // writeUnsignedInt(0xAARRGGBB) lands in the array as A,R,G,B bytes -- read
    // them in that order. Composing the word from individual bytes keeps this
    // endian-independent (a raw 32-bit load would not be).
    this.line('void BitmapData_setPixels(void* _this, Rectangle* rect, ByteArray* ba) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('if (bd == NULL || bd->pixels == NULL || rect == NULL || ba == NULL || ba->data == NULL) return;');
    this.line('int x0 = (int)rect->x, y0 = (int)rect->y;');
    this.line('int w = (int)rect->width, h = (int)rect->height;');
    this.line('unsigned char* src = (unsigned char*)ba->data;');
    this.line('for (int y = 0; y < h; y++) { for (int x = 0; x < w; x++) {');
    this.line('int px = x0 + x, py = y0 + y;');
    this.line('if (px < 0 || py < 0 || px >= bd->width || py >= bd->height) continue;');
    this.line('int i = (y * w + x) * 4;');
    this.line('unsigned a = src[i], r = src[i + 1], g = src[i + 2], b = src[i + 3];');
    this.line('((unsigned*)bd->pixels)[py * bd->width + px] = (a << 24) | (r << 16) | (g << 8) | b;');
    this.line('} }');
    this.indent--;
    this.line('}');
    // copyPixels: blit a source rectangle into this bitmap at destPoint.
    this.line('void BitmapData_copyPixels(void* _this, BitmapData* src, Rectangle* srcRect, Point* dest, BitmapData* alphaBmp, Point* alphaPt, bool mergeAlpha) {');
    this.indent++;
    this.line('BitmapData* bd = (BitmapData*)_this;');
    this.line('(void)alphaBmp; (void)alphaPt; (void)mergeAlpha;');
    this.line('if (bd == NULL || bd->pixels == NULL || src == NULL || src->pixels == NULL || srcRect == NULL || dest == NULL) return;');
    this.line('int sx0 = (int)srcRect->x, sy0 = (int)srcRect->y;');
    this.line('int w = (int)srcRect->width, h = (int)srcRect->height;');
    this.line('int dx0 = (int)dest->x, dy0 = (int)dest->y;');
    this.line('for (int y = 0; y < h; y++) { for (int x = 0; x < w; x++) {');
    this.line('int sx = sx0 + x, sy = sy0 + y, dx = dx0 + x, dy = dy0 + y;');
    this.line('if (sx < 0 || sy < 0 || sx >= src->width || sy >= src->height) continue;');
    this.line('if (dx < 0 || dy < 0 || dx >= bd->width || dy >= bd->height) continue;');
    this.line('((unsigned*)bd->pixels)[dy * bd->width + dx] = ((unsigned*)src->pixels)[sy * src->width + sx];');
    this.line('} }');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.utils.ByteArray (stage 36 runtime support) ----
    // Big-endian byte buffer. as_ba_grow doubles capacity as needed (arena-backed,
    // so old buffers are never freed); put/get helpers encode/decode big-endian.
    this.line('static void as_ba_grow(ByteArray* o, int extra) {');
    this.indent++;
    this.line('int need = o->length + extra;');
    this.line('if (need <= o->capacity) return;');
    this.line('int cap = o->capacity > 0 ? o->capacity : 16;');
    this.line('while (cap < need) cap *= 2;');
    this.line('unsigned char* nd = (unsigned char*)gc_alloc(GCT_BYTES, (size_t)cap);');
    this.line('if (o->data != NULL && o->length > 0) memcpy(nd, o->data, (size_t)o->length);');
    // The old buffer is simply dropped: it is GC-managed now, so a later
    // collection reclaims it (arena storage here was the documented leak).
    // Barrier: `o` may be BLACK (allocated during an incremental cycle) and
    // `nd` is fresh/white, so the write must be visible to the marker.
    this.line('o->data = (void*)nd; o->capacity = cap; gc_write_barrier((void*)nd);');
    this.indent--;
    this.line('}');
    // AS3 write* semantics write at the current `position` cursor and advance it
    // (auto-extending `length`), unlike the append-to-length model above which
    // serves the absolute-offset callers (FileStream.readBytes / readBytes).
    // Mixing the two is what previously made VertexData.set numVertices loop
    // forever: `while (bytesAvailable) writeUnsignedInt(0)` relies on writes
    // advancing `position` so bytesAvailable (=length-position) shrinks to 0.
    this.line('static void as_ba_grow_pos(ByteArray* o, int extra) {');
    this.indent++;
    this.line('int need = o->position + extra;');
    this.line('if (need <= o->capacity) return;');
    this.line('int cap = o->capacity > 0 ? o->capacity : 16;');
    this.line('while (cap < need) cap *= 2;');
    this.line('unsigned char* nd = (unsigned char*)gc_alloc(GCT_BYTES, (size_t)cap);');
    this.line('if (o->data != NULL && o->length > 0) memcpy(nd, o->data, (size_t)o->length);');
    // The old buffer is simply dropped: it is GC-managed now, so a later
    // collection reclaims it (arena storage here was the documented leak).
    // Barrier: `o` may be BLACK (allocated during an incremental cycle) and
    // `nd` is fresh/white, so the write must be visible to the marker.
    this.line('o->data = (void*)nd; o->capacity = cap; gc_write_barrier((void*)nd);');
    this.indent--;
    this.line('}');
    // Endianness: ByteArray defaults to big-endian; `endian = Endian.LITTLE_ENDIAN`
    // (a string constant) flips the byte order of multi-byte put/get primitives.
    // The string is compared once per op; AGAL assembly writes at setup time, not
    // per-frame, so the strcmp cost is irrelevant.
    // Endianness of a ByteArray. `endian` is a String, so testing it costs a
    // strcmp -- and readFloat/writeFloat/readUnsignedInt test it per ELEMENT.
    // In the Starling benchmark that put a strcmp on every float of every
    // vertex copied by VertexData.copyTo: measured as the single hottest leaf
    // in the process (26% of the main thread). Strings are immutable, so a
    // pointer-keyed cache is always correct -- the same pointer can never mean
    // a different endianness. Two slots cover the littleEndian / bigEndian
    // pair without eviction churn (the NULL default is slot-filled too).
    this.line('static int as_ba_little(ByteArray* o) {');
    this.indent++;
    this.line('static const char* ba_key[2] = { NULL, NULL };');
    this.line('static int ba_val[2] = { 0, 0 };');
    this.line('if (ba_key[0] == o->endian) return ba_val[0];');
    this.line('if (ba_key[1] == o->endian) return ba_val[1];');
    this.line('int v = o->endian != NULL && strcmp(o->endian, "littleEndian") == 0;');
    this.line('ba_key[1] = ba_key[0]; ba_val[1] = ba_val[0];');
    this.line('ba_key[0] = o->endian; ba_val[0] = v;');
    this.line('return v;');
    this.indent--;
    this.line('}');
    // Host byte order, so bulk copies can memcpy whenever the ByteArray's
    // endianness already agrees with the machine's.
    this.line('static int as_host_little(void) { unsigned x = 1; return *(unsigned char*)&x == 1; }');
    this.line('static void as_ba_put_u16(ByteArray* o, unsigned v) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data; int p = o->position;');
    this.line('if (as_ba_little(o)) { d[p++] = (unsigned char)(v & 0xFF); d[p++] = (unsigned char)((v >> 8) & 0xFF); }');
    this.line('else { d[p++] = (unsigned char)((v >> 8) & 0xFF); d[p++] = (unsigned char)(v & 0xFF); }');
    this.line('o->position = p; if (p > o->length) o->length = p;');
    this.indent--;
    this.line('}');
    this.line('static void as_ba_put_u32(ByteArray* o, unsigned v) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data; int p = o->position;');
    // Host-order fast path (like the bulk memcpy in uploadFromByteArray): when
    // the ByteArray's endianness already matches the machine, the AS3 byte
    // sequence is exactly the in-memory word, so one 32-bit store replaces four
    // shifted byte stores. Observable bytes are unchanged either way -- see
    // examples/reg-bytearray-endian.as. readFloat/writeFloat dominate the
    // Starling vertex-batch copy, so this is on the per-frame hot path.
    this.line('if (as_ba_little(o) == as_host_little()) { memcpy(d + p, &v, 4); p += 4; }');
    this.line('else if (as_ba_little(o)) { d[p++] = (unsigned char)(v & 0xFF); d[p++] = (unsigned char)((v >> 8) & 0xFF); d[p++] = (unsigned char)((v >> 16) & 0xFF); d[p++] = (unsigned char)((v >> 24) & 0xFF); }');
    this.line('else { d[p++] = (unsigned char)((v >> 24) & 0xFF); d[p++] = (unsigned char)((v >> 16) & 0xFF); d[p++] = (unsigned char)((v >> 8) & 0xFF); d[p++] = (unsigned char)(v & 0xFF); }');
    this.line('o->position = p; if (p > o->length) o->length = p;');
    this.indent--;
    this.line('}');
    this.line('static unsigned as_ba_get_u16(ByteArray* o) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data;');
    this.line('unsigned v = as_ba_little(o) ? ((unsigned)d[o->position] | ((unsigned)d[o->position + 1] << 8)) : (((unsigned)d[o->position] << 8) | (unsigned)d[o->position + 1]);');
    this.line('o->position += 2; return v;');
    this.indent--;
    this.line('}');
    this.line('static unsigned as_ba_get_u32(ByteArray* o) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data; unsigned v;');
    this.line('if (as_ba_little(o) == as_host_little()) memcpy(&v, d + o->position, 4);');
    this.line('else if (as_ba_little(o)) v = ((unsigned)d[o->position] | ((unsigned)d[o->position + 1] << 8) | ((unsigned)d[o->position + 2] << 16) | ((unsigned)d[o->position + 3] << 24));');
    this.line('else v = (((unsigned)d[o->position] << 24) | ((unsigned)d[o->position + 1] << 16) | ((unsigned)d[o->position + 2] << 8) | (unsigned)d[o->position + 3]);');
    this.line('o->position += 4; return v;');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_ctor(ByteArray* o) { o->data = NULL; o->length = 0; o->capacity = 0; o->position = 0; o->endian = (char*)"bigEndian"; }');
    this.line('ByteArray* ByteArray_new(void) { ByteArray* o = (ByteArray*)gc_alloc(GCT_CLASS, sizeof(ByteArray)); o->vtable = &ByteArray_vt; ByteArray_ctor(o); return o; }');
    this.line('void ByteArray_writeByte(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow_pos(o, 1);');
    this.line('((unsigned char*)o->data)[o->position++] = (unsigned char)(v & 0xFF);');
    this.line('if (o->position > o->length) o->length = o->position;');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeShort(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow_pos(o, 2); as_ba_put_u16(o, (unsigned)v);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeInt(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow_pos(o, 4); as_ba_put_u32(o, (unsigned)v);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeUnsignedInt(void* _this, unsigned v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow_pos(o, 4); as_ba_put_u32(o, v);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeFloat(void* _this, double v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow_pos(o, 4);');
    this.line('float f = (float)v; unsigned bits; memcpy(&bits, &f, 4); as_ba_put_u32(o, bits);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeUTFBytes(void* _this, char* s) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (s == NULL) return;');
    this.line('int n = (int)strlen(s); as_ba_grow_pos(o, n);');
    this.line('memcpy((unsigned char*)o->data + o->position, s, (size_t)n); o->position += n;');
    this.line('if (o->position > o->length) o->length = o->position;');
    this.indent--;
    this.line('}');
    // writeUTF = a 16-bit byte length (respecting `endian`, like readUTF) followed
    // by the raw UTF-8 bytes, so readUTF round-trips it.
    this.line('void ByteArray_writeUTF(void* _this, char* value) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (value == NULL) value = (char*)"";');
    this.line('int n = (int)strlen(value); as_ba_grow_pos(o, n + 2);');
    this.line('as_ba_put_u16(o, (unsigned)n);');
    this.line('if (n > 0) memcpy((unsigned char*)o->data + o->position, value, (size_t)n);');
    this.line('o->position += n;');
    this.line('if (o->position > o->length) o->length = o->position;');
    this.indent--;
    this.line('}');
    this.line('int ByteArray_readByte(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position >= o->length) return 0;');
    this.line('return (int)(signed char)((unsigned char*)o->data)[o->position++];');
    this.indent--;
    this.line('}');
    this.line('int ByteArray_readShort(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 2 > o->length) return 0;');
    this.line('return (int)(short)as_ba_get_u16(o);');
    this.indent--;
    this.line('}');
    this.line('int ByteArray_readInt(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 4 > o->length) return 0;');
    this.line('return (int)as_ba_get_u32(o);');
    this.indent--;
    this.line('}');
    this.line('double ByteArray_readFloat(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 4 > o->length) return 0.0;');
    this.line('unsigned bits = as_ba_get_u32(o); float f; memcpy(&f, &bits, 4); return (double)f;');
    this.indent--;
    this.line('}');
    this.line('unsigned ByteArray_readUnsignedByte(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position >= o->length) return 0;');
    this.line('return (unsigned)((unsigned char*)o->data)[o->position++];');
    this.indent--;
    this.line('}');
    this.line('unsigned ByteArray_readUnsignedShort(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 2 > o->length) return 0;');
    this.line('return as_ba_get_u16(o);');
    this.indent--;
    this.line('}');
    this.line('unsigned ByteArray_readUnsignedInt(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 4 > o->length) return 0;');
    this.line('return as_ba_get_u32(o);');
    this.indent--;
    this.line('}');
    this.line('double ByteArray_readDouble(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 8 > o->length) return 0.0;');
    this.line('unsigned hi = as_ba_get_u32(o); unsigned lo = as_ba_get_u32(o);');
    this.line('unsigned long long bits = ((unsigned long long)hi << 32) | lo;');
    this.line('double r; memcpy(&r, &bits, 8); return r;');
    this.indent--;
    this.line('}');
    this.line('char* ByteArray_readUTF(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (o->position + 2 > o->length) return (char*)"";');
    this.line('unsigned n = as_ba_get_u16(o);');
    this.line('if (o->position + (int)n > o->length) n = (unsigned)(o->length - o->position);');
    this.line('char* r = (char*)as_str_alloc((size_t)n + 1);');
    this.line('if (n > 0) memcpy(r, (unsigned char*)o->data + o->position, (size_t)n);');
    this.line('r[n] = 0; o->position += (int)n; return r;');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_readBytes(void* _this, ByteArray* dst, unsigned offset, unsigned length) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (dst == NULL) return;');
    this.line('if (length == 0) length = (unsigned)(o->length - o->position);');
    this.line('if (o->position + (int)length > o->length) length = (unsigned)(o->length - o->position);');
    this.line('as_ba_grow(dst, (int)(offset + length));');
    this.line('if (length > 0) memcpy((unsigned char*)dst->data + offset, (unsigned char*)o->data + o->position, (size_t)length);');
    this.line('if ((int)(offset + length) > dst->length) dst->length = (int)(offset + length);');
    this.line('o->position += (int)length;');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeBytes(void* _this, ByteArray* src, unsigned offset, unsigned length) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (src == NULL) return;');
    this.line('if (length == 0) length = (unsigned)(src->length - (int)offset);');
    this.line('if ((int)(offset + length) > src->length) length = (unsigned)(src->length - (int)offset);');
    this.line('as_ba_grow_pos(o, (int)length);');
    this.line('if (length > 0) memcpy((unsigned char*)o->data + o->position, (unsigned char*)src->data + offset, (size_t)length);');
    this.line('o->position += (int)length;');
    this.line('if (o->position > o->length) o->length = o->position;');
    this.indent--;
    this.line('}');
    this.line('char* ByteArray_readUTFBytes(void* _this, int n) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (n <= 0) { char* e = (char*)as_str_alloc(1); e[0] = 0; return e; }');
    this.line('int avail = o->length - o->position; if (avail < 0) avail = 0;');
    this.line('if (n > avail) n = avail;');
    this.line('char* r = (char*)as_str_alloc((size_t)n + 1);');
    this.line('if (n > 0) memcpy(r, (unsigned char*)o->data + o->position, (size_t)n);');
    this.line('r[n] = 0; o->position += n; return r;');
    this.indent--;
    this.line('}');
    this.line('int ByteArray_get_bytesAvailable(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; int a = o->length - o->position; return a > 0 ? a : 0;');
    this.indent--;
    this.line('}');
    // ByteArray.length is an accessor in AS3, not a plain slot: assigning it
    // resizes the buffer (growing zero-fills, shrinking truncates and pulls
    // `position` back to the new end). Treating it as a field let Starling's
    // VertexData.set numVertices claim a length larger than the backing buffer,
    // and the next write overran the allocation (SIGSEGV in as_ba_grow_pos).
    this.line('int ByteArray_get_length(void* _this) { return ((ByteArray*)_this)->length; }');
    this.line('void ByteArray_set_length(void* _this, unsigned value) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; int n = (int)value;');
    this.line('if (n < 0 || (unsigned)n != value) { as_throw(RangeError_new((char*)"The length property of a ByteArray cannot be negative", 0)); return; }');
    this.line('if (n > o->capacity) {');
    this.indent++;
    this.line('int cap = o->capacity > 0 ? o->capacity : 16;');
    this.line('while (cap < n && cap < 0x40000000) cap *= 2;');
    this.line('if (cap < n) { as_throw(RangeError_new((char*)"ByteArray length is too large", 0)); return; }');
    this.line('unsigned char* nd = (unsigned char*)gc_alloc(GCT_BYTES, (size_t)cap);');
    this.line('if (o->data != NULL && o->length > 0) memcpy(nd, o->data, (size_t)o->length);');
    this.line('if (n > o->length) memset(nd + o->length, 0, (size_t)(n - o->length));');
    this.line('o->data = (void*)nd; o->capacity = cap; gc_write_barrier((void*)nd);');
    this.indent--;
    this.line('} else if (n > o->length && o->data != NULL) {');
    this.indent++;
    this.line('memset((unsigned char*)o->data + o->length, 0, (size_t)(n - o->length));');
    this.indent--;
    this.line('}');
    this.line('o->length = n;');
    this.line('if (o->position > n) o->position = n;');
    this.indent--;
    this.line('}');
    // ByteArray[index] reads the byte at an absolute index (does not advance
    // `position`); out-of-range returns 0, matching AS3's undefined->NaN->0.
    this.line('int ByteArray_get_index(void* _this, int i) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this;');
    this.line('if (i < 0 || i >= o->length || o->data == NULL) return 0;');
    this.line('return (int)((unsigned char*)o->data)[i];');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_clear(void* _this) { ByteArray* o = (ByteArray*)_this; o->length = 0; o->position = 0; }');
    this.line('void ByteArray_compress(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (o->length == 0) return;');
    this.line('#ifdef __wasi__');
    this.line('(void)o; // no zlib on WASI: compress is a documented no-op');
    this.line('#else');
    this.line('uLongf dst = compressBound((uLong)o->length);');
    this.line('unsigned char* tmp = (unsigned char*)gc_alloc(GCT_BYTES, (size_t)dst);');
    this.line('if (compress(tmp, &dst, (const unsigned char*)o->data, (uLong)o->length) == Z_OK) {');
    this.indent++;
    this.line('o->data = (void*)tmp; o->length = (int)dst; o->capacity = (int)dst; o->position = 0; gc_write_barrier((void*)tmp);');
    this.indent--;
    this.line('}');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_uncompress(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (o->length == 0) return;');
    this.line('#ifdef __wasi__');
    this.line('(void)o; // no zlib on WASI');
    this.line('#else');
    this.line('uLongf cap = (uLong)o->length * 4 + 64;');
    this.line('for (int attempt = 0; attempt < 8; attempt++) {');
    this.indent++;
    this.line('unsigned char* out = (unsigned char*)gc_alloc(GCT_BYTES, (size_t)cap);');
    this.line('uLongf dst = cap;');
    this.line('int rc = uncompress(out, &dst, (const unsigned char*)o->data, (uLong)o->length);');
    // A failed attempt's buffer is dropped (GC garbage); only the successful one is installed.
    this.line('if (rc == Z_OK) { o->data = (void*)out; o->length = (int)dst; o->capacity = (int)dst; o->position = 0; gc_write_barrier((void*)out); break; }');
    this.line('if (rc != Z_BUF_ERROR) break;');
    this.line('cap *= 2;');
    this.indent--;
    this.line('}');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.text (stage 38) ----
    this.line('void TextFormat_ctor(TextFormat* o, char* font, double size, unsigned color, bool bold, bool italic, double leading) {');
    this.indent++;
    this.line('o->font = font; o->size = size; o->color = color; o->bold = bold; o->italic = italic; o->underline = false; o->align = NULL; o->leading = leading; o->kerning = false; o->letterSpacing = 0.0;');
    this.line('gc_write_barrier((void*)font);');
    this.indent--;
    this.line('}');
    this.line('TextFormat* TextFormat_new(char* font, double size, unsigned color, bool bold, bool italic, double leading) {');
    this.indent++;
    this.line('TextFormat* o = (TextFormat*)gc_alloc(GCT_CLASS, sizeof(TextFormat));');
    this.line('o->vtable = &TextFormat_vt;');
    this.line('TextFormat_ctor(o, font, size, color, bold, italic, leading);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void TextField_ctor(TextField* o) {');
    this.indent++;
    this.line('InteractiveObject_ctor((InteractiveObject*)o);');
    // AIR: a TextField defaults to 100×100 (unlike other DisplayObjects, which
    // start at 0×0). The render path clips text to (width,height), so leaving
    // height at 0 would clip every glyph away when the field is positioned
    // without an explicit size.
    this.line('o->width = 100.0; o->height = 100.0;');
    this.line('o->text = NULL;');
    this.line('o->defaultTextFormat = TextFormat_new(NULL, 12.0, 0x000000u, false, false, 0.0);');
    this.line('o->multiline = false;');
    this.line('o->wordWrap = false;');
    this.line('o->background = false;');
    this.line('o->backgroundColor = 0xFFFFFFFFu;');
    this.line('o->scrollV = 1;');
    this.line('o->_scroll_h = 0;');
    this.line('o->hscroll = false;');
    this.line('o->selectable = true;');
    this.line('o->autoSize = (char*)"none";');
    // textColor defaults to 0 (black). A non-zero value overrides the
    // defaultTextFormat color at render time (see as_tf_paragraph).
    this.line('o->textColor = 0u;');
    this.line('o->_para = NULL;');
    this.line('o->_para_text = NULL;');
    this.line('o->_para_w = 0.0;');
    this.line('o->_para_size = 0.0;');
    this.line('o->_para_bold = 0;');
    this.line('o->_para_italic = 0;');
    this.line('o->_para_color = 0u;');
    this.line('o->_para_collapse = 0;');
    this.line('o->_para_leading = 0.0;');
    this.line('o->_para_align = 0;');
    this.line('o->_sel_begin = -1;');
    this.line('o->_sel_end = -1;');
    this.line('o->_sel_caret = -1;');
    this.line('o->_runs = NULL;');
    this.line('o->_html_dirty = 0;');
    this.indent--;
    this.line('}');
    this.line('TextField* TextField_new(void) { TextField* o = (TextField*)gc_alloc(GCT_CLASS, sizeof(TextField)); o->vtable = &TextField_vt; TextField_ctor(o); return o; }');
    // --- TextField text layout (SkParagraph, stage 38/44) ---
    // TextField lays its text out through SkParagraph (modules/skparagraph), which
    // shapes with HarfBuzz and breaks lines per UAX#14 — replacing the earlier
    // self-built greedy word-wrap. The laid-out Paragraph is cached on the object
    // and keyed on (text pointer, width, size, bold, italic, color): repaints and
    // property reads reuse one layout instead of re-measuring every frame, and a
    // width change re-flows automatically (AIR re-wraps when width changes too).
    // scrollV/maxScrollV remain a viewport-line concern (numLines - visibleLines +
    // 1) computed from SkParagraph's line metrics; SkParagraph does not model it.
    // flash.text.TextFormat.align (TextFormatAlign.LEFT/CENTER/RIGHT/JUSTIFY),
    // mapped to SkParagraph's TextAlign enum (kLeft=0, kRight=1, kCenter=2,
    // kJustify=3). Starling's own TextFormat.horizontalAlign is copied onto the
    // native field's `align` by TextFormat.toNativeFormat.
    this.line('static int as_tf_align_index(TextFormat* fmt) {');
    this.indent++;
    this.line('if (fmt == NULL || fmt->align == NULL) return 0;');
    this.line('if (strcmp(fmt->align, "center") == 0) return 2;');
    this.line('if (strcmp(fmt->align, "right") == 0) return 1;');
    this.line('if (strcmp(fmt->align, "justify") == 0) return 3;');
    this.line('return 0;');
    this.indent--;
    this.line('}');
    this.line('static void* as_tf_paragraph(TextField* tf) {');
    this.indent++;
    this.line('if (tf->text == NULL || tf->defaultTextFormat == NULL) return NULL;');
    this.line('TextFormat* fmt = tf->defaultTextFormat;');
    this.line('double size = fmt->size;');
    this.line('int bold = fmt->bold ? 1 : 0;');
    this.line('int italic = fmt->italic ? 1 : 0;');
    this.line('double leading = fmt->leading;');
    // textColor (default 0 = black) overrides defaultTextFormat.color for plain
    // text; a field keeps fmt->color when textColor is left at its default.
    this.line('unsigned color = (tf->textColor != 0u) ? tf->textColor : fmt->color;');
    // wordWrap wraps whenever a positive width is set, independent of multiline
    // (AIR wraps a wordWrap=true field even when multiline stays false — the
    // official wordWrap example sets only wordWrap). multiline instead controls
    // whether explicit '\n' hard breaks are honored (collapse), not whether the
    // field auto-wraps.
    //
    // The usable width is width - 4, NOT width: AIR lays text out inside a 2px
    // inset on each side, so a candidate line exactly as wide as the field still
    // wraps. Measured against adl 51.4.1 with a Verdana-24 run of ink 124.945px:
    // AIR keeps it on one line only from width 129 (= ceil(ink + 4)); laying out
    // against the un-inset width wrapped at 125, i.e. one word later than AIR
    // exactly at the boundary. Same inset autoSize/maxScrollH already assume
    // (width = textWidth + 4, below) — only the wrap threshold forgot it.
    this.line('double w = 0.0;');
    this.line('if (tf->wordWrap && tf->width > 0.0) {');
    this.indent++;
    this.line('w = tf->width - 4.0;');
    // A field narrower than its own inset leaves no usable width. Clamp above 0
    // rather than let it go <= 0: the glue reads width <= 0 as "no wrapping" (it
    // substitutes 1e9), which would silently turn a very narrow field into a
    // non-wrapping one instead of wrapping every word.
    this.line('if (w < 1.0) w = 1.0;');
    this.indent--;
    this.line('}');
    this.line('int collapse = tf->multiline ? 0 : 1;');
    // Horizontal alignment. SkParagraph can only align within a layout width, so
    // it must stay kLeft when there is none (the glue substitutes 1e9 for a zero
    // width, and centering inside 1e9 would shove the text far to the right);
    // as_tf_align_dx below applies the alignment as a block shift in that case.
    // AIR honours horizontalAlign on a non-wrapping field too -- that is exactly
    // how Starling's TrueTypeCompositor centers native text (it draws the field
    // into a bitmap sized to textWidth and offsets by (width - textWidth) / 2).
    this.line('int align = as_tf_align_index(tf->defaultTextFormat);');
    this.line('int layoutAlign = (w > 0.0) ? align : 0;');
    this.line('int hasRuns = (tf->_runs != NULL && tf->_runs->length > 0);');
    this.line('if (tf->_para != NULL && tf->_para_text == tf->text && tf->_para_w == w &&');
    this.line('    tf->_para_size == size && tf->_para_bold == bold && tf->_para_italic == italic &&');
    this.line('    tf->_para_color == color && tf->_para_collapse == collapse && tf->_para_leading == leading &&');
    this.line('    tf->_para_align == layoutAlign &&');
    this.line('    hasRuns == 0) {');
    this.indent++;
    this.line('return tf->_para;');
    this.indent--;
    this.line('}');
    this.line('as_skia_textlayout_delete(tf->_para);');
    this.line('if (hasRuns) {');
    this.indent++;
    // Build a stack sk_text_run[] from the _runs array. Each run is stored as
    // three consecutive as_value slots: begin (num), end (num), TextFormat (obj).
    // A stack cap keeps this allocation out of the GC heap (hot render path).
    this.line('int n = tf->_runs->length / 3;');
    this.line('if (n > 32) n = 32;');
    this.line('sk_text_run runs[32];');
    this.line('for (int i = 0; i < n; i++) {');
    this.indent++;
    this.line('int b = as_v_int_val(tf->_runs->data[i * 3]);');
    this.line('int e = as_v_int_val(tf->_runs->data[i * 3 + 1]);');
    this.line('TextFormat* rf = (TextFormat*)as_v_obj_val(tf->_runs->data[i * 3 + 2]);');
    this.line('if (rf == NULL) continue;');
    this.line('runs[i].start = (unsigned)b;');
    this.line('runs[i].end = (unsigned)e;');
    this.line('runs[i].family = rf->font;');
    this.line('runs[i].size = rf->size;');
    this.line('runs[i].bold = rf->bold ? 1 : 0;');
    this.line('runs[i].italic = rf->italic ? 1 : 0;');
    this.line('runs[i].color = rf->color;');
    this.line('runs[i].leading = rf->leading;');
    this.indent--;
    this.line('}');
    this.line('tf->_para = as_skia_textlayout_new_runs(tf->text, runs, n, w, layoutAlign, collapse);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('tf->_para = as_skia_textlayout_new_leading(tf->text, fmt->font, size, bold, italic, color, leading, w, layoutAlign, collapse);');
    this.indent--;
    this.line('}');
    this.line('tf->_para_text = tf->text;');
    this.line('tf->_para_w = w;');
    this.line('tf->_para_size = size;');
    this.line('tf->_para_bold = bold;');
    this.line('tf->_para_italic = italic;');
    this.line('tf->_para_color = color;');
    this.line('tf->_para_collapse = collapse;');
    this.line('tf->_para_leading = leading;');
    this.line('tf->_para_align = layoutAlign;');
    this.line('return tf->_para;');
    this.indent--;
    this.line('}');
    // Horizontal-align offset for a field with no layout width (wordWrap off):
    // SkParagraph had no box to align within, so shift the whole block here. AIR
    // still centers/right-aligns inside the field's box even without wrapping --
    // Starling's TrueTypeCompositor depends on it. The 2px text inset AIR keeps on
    // the left and right edges cancels out for centering and is subtracted for
    // right alignment.
    this.line('static double as_tf_align_dx(TextField* tf) {');
    this.indent++;
    this.line('if (tf->defaultTextFormat == NULL) return 0.0;');
    this.line('if (tf->wordWrap && tf->width > 0.0) return 0.0;');
    this.line('int a = as_tf_align_index(tf->defaultTextFormat);');
    this.line('if (a != 1 && a != 2) return 0.0;');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para == NULL) return 0.0;');
    this.line('double tw = as_skia_textlayout_max_width(para);');
    this.line('if (a == 2) return (tf->width - 4.0 - tw) / 2.0;');
    this.line('return tf->width - 4.0 - tw;');
    this.indent--;
    this.line('}');
    this.line('static double as_tf_line_height(TextField* tf) {');
    this.indent++;
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para != NULL) {');
    this.indent++;
    this.line('int n = as_skia_textlayout_line_count(para);');
    this.line('double h = as_skia_textlayout_height(para);');
    // Average line height = total height / line count. For a single-style
    // paragraph with AIR's default leading=0 this equals each line's
    // ascent+descent, and it is exactly consistent with textHeight/numLines so
    // the viewport math (visible = height / lineHeight) has no float mismatch.
    this.line('if (n > 0 && h > 0.0) return h / (double)n;');
    this.indent--;
    this.line('}');
    this.line('double size = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->size : 12.0;');
    this.line('double lead = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->leading : 0.0;');
    this.line('if (lead < 0.0) lead = 0.0;');
    this.line('return size * 1.2 + lead;');
    this.indent--;
    this.line('}');
    this.line('static int as_tf_visible_lines(TextField* tf) {');
    this.indent++;
    this.line('if (!tf->multiline) return 1;');
    this.line('double lh = as_tf_line_height(tf);');
    this.line('int n = (lh > 0.0) ? (int)(tf->height / lh) : 1;');
    this.line('return (n < 1) ? 1 : n;');
    this.indent--;
    this.line('}');
    this.line('static int as_tf_line_count(TextField* tf) {');
    this.indent++;
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para != NULL) {');
    this.indent++;
    this.line('int n = as_skia_textlayout_line_count(para);');
    this.line('return (n < 1) ? 1 : n;');
    this.indent--;
    this.line('}');
    // Pure-C fallback (no Skia linked): count explicit '\n' hard breaks. A
    // single-line field never breaks (AIR keeps it on one line).
    this.line('if (tf->text == NULL) return 0;');
    this.line('if (!tf->multiline) return 1;');
    this.line('int n = 1;');
    this.line('for (const char* p = tf->text; *p; p++) if (*p == \'\\n\') n++;');
    this.line('return n;');
    this.indent--;
    this.line('}');
    // autoSize != "none" makes the field shrink/grow to hug its text: width to
    // textWidth and height to textHeight (plus a small 2px gutter on each side
    // matching the paint origin). LEFT/RIGHT/CENTER only differ in anchoring,
    // which the renderer handles via the alignment already carried by the layout.
    // Word-wrapping depends on width, so autoSize re-flows: we first size height
    // from the current wrap width, then width from textWidth, then height once
    // more. This is called after every property read / render that needs it.
    this.line('static void as_tf_apply_autosize(TextField* tf) {');
    this.indent++;
    this.line('if (tf->autoSize == NULL || strcmp(tf->autoSize, "none") == 0) return;');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para == NULL) return;');
    this.line('double tw = as_skia_textlayout_max_width(para);');
    this.line('double th = as_skia_textlayout_height(para);');
    this.line('tf->width = tw + 4.0;');
    this.line('tf->height = th + 4.0;');
    this.indent--;
    this.line('}');
    this.line('double TextField_get_textWidth(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para == NULL) return 0.0;');
    this.line('return as_skia_textlayout_max_width(para);');
    this.indent--;
    this.line('}');
    this.line('double TextField_get_textHeight(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para != NULL) return as_skia_textlayout_height(para);');
    // Pure-C fallback (no Skia linked): line count × approximated line height.
    this.line('double size = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->size : 12.0;');
    this.line('double lead = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->leading : 0.0;');
    this.line('if (lead < 0.0) lead = 0.0;');
    this.line('return (double)as_tf_line_count(tf) * (size * 1.2 + lead);');
    this.indent--;
    this.line('}');
    this.line('int TextField_get_numLines(void* _this) { return as_tf_line_count((TextField*)_this); }');
    // maxScrollV is the highest line index scrollV accepts while still filling the
    // box (numLines - visibleLines + 1). That is why the log idiom
    // `scrollV = maxScrollV` pins the newest line to the BOTTOM of the field rather
    // than scrolling it to the top.
    this.line('int TextField_get_maxScrollV(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('int m = as_tf_line_count(tf) - as_tf_visible_lines(tf) + 1;');
    this.line('return (m < 1) ? 1 : m;');
    this.indent--;
    this.line('}');
    // maxScrollH is the horizontal scroll extent in pixels: the widest line minus
    // the box width (plus a small gutter). It is 0 unless hscroll is on and the
    // text actually overflows — AIR clips (not wraps) a wordWrap=false field and
    // lets scrollH pan it.
    this.line('int TextField_get_maxScrollH(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (!tf->hscroll) return 0;');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para == NULL) return 0;');
    this.line('double tw = as_skia_textlayout_max_width(para);');
    this.line('double over = tw + 4.0 - tf->width;');
    this.line('return (over > 0.0) ? (int)(over + 0.999) : 0;');
    this.indent--;
    this.line('}');
    // Map a stage-space point to a caret index in the field's paragraph. The
    // point is converted to paragraph coordinates: subtract the field's stage
    // position, undo the paint-origin gutter (2px), and add back the current
    // scroll offset. SkParagraph returns a UTF-16 code unit; for the ASCII text
    // this runtime models UTF-16 == UTF-8 byte offset, so the index is directly
    // compatible with the _sel_* byte offsets. scrollV is clamped like the renderer.
    this.line('static int as_tf_index_at(TextField* tf, double x, double y) {');
    this.indent++;
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para == NULL) return 0;');
    this.line('double lh = as_tf_line_height(tf);');
    this.line('int vis = as_tf_visible_lines(tf);');
    this.line('int lc = as_tf_line_count(tf);');
    this.line('int maxs = lc - vis + 1; if (maxs < 1) maxs = 1;');
    this.line('int top = tf->scrollV; if (top < 1) top = 1; if (top > maxs) top = maxs;');
    this.line('double scrollY = (double)(top - 1) * lh;');
    this.line('int maxsh = TextField_get_maxScrollH((void*)tf);');
    this.line('int leftpx = tf->hscroll ? tf->_scroll_h : 0;');
    this.line('if (leftpx < 0) leftpx = 0; if (leftpx > maxsh) leftpx = maxsh;');
    this.line('double lx = x - tf->x + (double)leftpx - 2.0;');
    this.line('double ly = y - tf->y + scrollY - 2.0;');
    this.line('int idx = as_skia_textlayout_glyph_position_at(para, lx, ly);');
    this.line('if (idx < 0) idx = 0;');
    this.line('if (tf->text != NULL) { int len = (int)strlen(tf->text); if (idx > len) idx = len; }');
    this.line('return idx;');
    this.indent--;
    this.line('}');
    // scrollH is clamped to [0, maxScrollH] on assignment (AIR semantics): a
    // field that fits cannot pan, and scrollH past the overflow extent sticks.
    this.line('int TextField_get_scrollH(void* _this) { return ((TextField*)_this)->_scroll_h; }');
    this.line('void TextField_set_scrollH(void* _this, int value) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('int m = TextField_get_maxScrollH(_this);');
    this.line('if (value < 0) value = 0;');
    this.line('if (value > m) value = m;');
    this.line('tf->_scroll_h = value;');
    this.indent--;
    this.line('}');
    // Selection indices are UTF-16 code-unit offsets per AS3, but the runtime
    // stores strings as UTF-8 bytes and every string index (charAt/substring/
    // indexOf) is a byte offset. For ASCII text the two coincide, so we report
    // byte offsets — exact for ASCII, a documented subset limitation otherwise.
    this.line('int TextField_get_selectionBeginIndex(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (tf->_sel_begin < 0) return TextField_get_caretIndex(_this);');
    this.line('return tf->_sel_begin;');
    this.indent--;
    this.line('}');
    this.line('int TextField_get_selectionEndIndex(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (tf->_sel_end < 0) return TextField_get_caretIndex(_this);');
    this.line('return tf->_sel_end;');
    this.indent--;
    this.line('}');
    this.line('int TextField_get_caretIndex(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('return (tf->_sel_caret < 0) ? 0 : tf->_sel_caret;');
    this.indent--;
    this.line('}');
    this.line('void TextField_setSelection(void* _this, int begin, int end) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('int len = (tf->text != NULL) ? (int)strlen(tf->text) : 0;');
    this.line('if (begin < 0) begin = 0;');
    this.line('if (end < 0) end = 0;');
    this.line('if (begin > len) begin = len;');
    this.line('if (end > len) end = len;');
    this.line('tf->_sel_begin = begin;');
    this.line('tf->_sel_end = end;');
    this.line('tf->_sel_caret = end;');
    this.indent--;
    this.line('}');
    this.line('void TextField_setTextFormat(void* _this, TextFormat* format, int begin, int end) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (format == NULL) return;');
    this.line('int len = (tf->text != NULL) ? (int)strlen(tf->text) : 0;');
    this.line('if (begin < 0) begin = 0;');
    this.line('if (end < 0 || end > len) end = len;');
    this.line('if (begin > end) { int t = begin; begin = end; end = t; }');
    this.line('if (tf->_runs == NULL) tf->_runs = as_array_new();');
    this.line('as_array_push(tf->_runs, as_v_num((double)begin));');
    this.line('as_array_push(tf->_runs, as_v_num((double)end));');
    this.line('as_array_push(tf->_runs, as_v_obj((void*)format));');
    this.line('as_skia_textlayout_delete(tf->_para); tf->_para = NULL;');
    this.indent--;
    this.line('}');
    // htmlText setter: parse a small HTML subset into plain text + style runs.
    // Supported tags: <font color="#RRGGBB" size="N" face="...">, <b>, <i>, <u>,
    // <p>, <br> (and self-closing <br/>). Everything else is stripped and its
    // inner text is kept. The result reuses setTextFormat's run encoding (three
    // as_value slots per run: begin, end, TextFormat object), so as_tf_paragraph
    // lays it out through sk_textlayout_new_runs exactly like setTextFormat runs.
    this.line('static void as_tf_html_emit_run(TextField* tf, int begin, int end, char* face, double size, unsigned color, bool bold, bool italic, bool underline) {');
    this.indent++;
    this.line('(void)underline; // underline not yet modeled by the TextStyle subset');
    this.line('if (begin >= end) return;');
    this.line('if (tf->_runs == NULL) tf->_runs = as_array_new();');
    this.line('TextFormat* f = TextFormat_new(face, size, color, bold, italic, 0.0);');
    this.line('as_array_push(tf->_runs, as_v_num((double)begin));');
    this.line('as_array_push(tf->_runs, as_v_num((double)end));');
    this.line('as_array_push(tf->_runs, as_v_obj((void*)f));');
    this.indent--;
    this.line('}');
    this.line('static int as_tf_html_parse_hex(const char* s) {');
    this.indent++;
    this.line('int v = 0;');
    this.line('for (int i = 0; i < 6 && s[i]; i++) {');
    this.indent++;
    this.line('char c = s[i];');
    this.line('int d = (c >= \'0\' && c <= \'9\') ? c - \'0\' : (c >= \'a\' && c <= \'f\') ? c - \'a\' + 10 : (c >= \'A\' && c <= \'F\') ? c - \'A\' + 10 : 0;');
    this.line('v = v * 16 + d;');
    this.indent--;
    this.line('}');
    this.line('return v;');
    this.indent--;
    this.line('}');
    // Attribute-value reader for the HTML subset. AIR quotes attribute values with
    // EITHER quote style (`color="#ff0000"` and `color=\'#ff0000\'` are equally
    // valid), so the value must be delimited by the quote that actually opened it.
    // Returns the position just past the value (and past its closing quote) so the
    // caller's scan resumes at the next separator.
    this.line('static char* as_tf_html_attr_value(char* s, char* out, int cap) {');
    this.indent++;
    this.line('char q = 0;');
    this.line('if (*s == \'"\' || *s == \'\\\'\') q = *s++;');
    this.line('int n = 0;');
    this.line('while (*s && n < cap - 1) {');
    this.indent++;
    this.line('if (q != 0) { if (*s == q) { s++; break; } }');
    this.line('else if (*s == \' \' || *s == \'"\' || *s == \'\\\'\' || *s == \'/\') break;');
    this.line('out[n++] = *s++;');
    this.indent--;
    this.line('}');
    this.line('out[n] = 0;');
    this.line('return s;');
    this.indent--;
    this.line('}');
    this.line('static void as_tf_html_set(TextField* tf, char* html) {');
    this.indent++;
    this.line('if (tf->_runs != NULL) { as_skia_textlayout_delete(tf->_para); tf->_para = NULL; tf->_runs = NULL; }');
    this.line('if (html == NULL) { tf->text = NULL; return; }');
    // Build plain text (newline normalization) into a GC string, tracking byte
    // offsets, while accumulating runs from the tags encountered.
    this.line('size_t n = strlen(html);');
    this.line('char* out = as_str_alloc(n + 1);');
    this.line('int opos = 0;');
    this.line('char* face = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->font : NULL;');
    this.line('double size = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->size : 12.0;');
    this.line('unsigned color = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->color : 0x000000u;');
    this.line('bool bold = false, italic = false, underline = false;');
    this.line('int runStart = 0;');
    this.line('int i = 0;');
    this.line('while (i < (int)n) {');
    this.indent++;
    this.line('if (html[i] != \'<\') {');
    this.indent++;
    this.line('out[opos++] = html[i++];');
    this.indent--;
    this.line('} else {');
    this.indent++;
    // Find the closing '>', then dispatch on the tag name.
    this.line('int j = i + 1;');
    this.line('while (j < (int)n && html[j] != \'>\') j++;');
    this.line('if (j >= (int)n) { out[opos++] = html[i++]; continue; }');
    this.line('int tagLen = j - (i + 1);');
    this.line('char tag[64];');
    this.line('int tl = tagLen < 63 ? tagLen : 63;');
    this.line('memcpy(tag, html + i + 1, (size_t)tl);');
    this.line('tag[tl] = 0;');
    this.line('int closing = (tagLen > 0 && tag[0] == \'/\');');
    this.line('char* name = closing ? tag + 1 : tag;');
    this.line('int nl = 0;');
    this.line('while (name[nl] && name[nl] != \' \' && name[nl] != \'/\' && name[nl] != \'=\' ) nl++;');
    this.line('char nm[24]; int k = 0; while (k < nl && k < 23) { nm[k] = name[k]; k++; } nm[k] = 0;');
    // Flush the run ending here BEFORE any style/break change.
    this.line('#define AS_TF_FLUSH() do { as_tf_html_emit_run(tf, runStart, opos, face, size, color, bold, italic, underline); runStart = opos; } while (0)');
    this.line('if (strcmp(nm, "br") == 0) {');
    this.indent++;
    this.line('AS_TF_FLUSH();');
    this.line('out[opos++] = \'\\n\';');
    this.indent--;
    this.line('} else if (strcmp(nm, "p") == 0) {');
    this.indent++;
    this.line('AS_TF_FLUSH();');
    this.line('if (opos > 0 && out[opos - 1] != \'\\n\') out[opos++] = \'\\n\';');
    this.indent--;
    this.line('} else if (strcmp(nm, "b") == 0) { AS_TF_FLUSH(); bold = !closing; }');
    this.line('else if (strcmp(nm, "i") == 0) { AS_TF_FLUSH(); italic = !closing; }');
    this.line('else if (strcmp(nm, "u") == 0) { AS_TF_FLUSH(); underline = !closing; }');
    this.line('else if (strcmp(nm, "font") == 0 && !closing) {');
    this.indent++;
    this.line('AS_TF_FLUSH();');
    this.line('char* s = tag + nl;');
    this.line('while (*s) {');
    this.indent++;
    this.line('while (*s == \' \' || *s == \'/\') s++;');
    this.line('if (strncmp(s, "color=", 6) == 0) { char v[32]; s = as_tf_html_attr_value(s + 6, v, 32); color = (unsigned)as_tf_html_parse_hex(v[0] == \'#\' ? v + 1 : v); }');
    this.line('else if (strncmp(s, "size=", 5) == 0) { char v[32]; s = as_tf_html_attr_value(s + 5, v, 32); size = atof(v); if (size < 1.0) size = 1.0; }');
    this.line('else if (strncmp(s, "face=", 5) == 0) { char v[128]; s = as_tf_html_attr_value(s + 5, v, 128); int fl = (int)strlen(v); face = as_str_alloc((size_t)fl + 1); memcpy(face, v, (size_t)fl); face[fl] = 0; }');
    // Advance past the just-parsed attribute value. A recognised value was already
    // consumed by as_tf_html_attr_value (together with its closing quote, single or
    // double); for an unrecognised token both quote kinds must be skipped, otherwise
    // the outer `while (*s)` re-examines the same quote, matches no branch, and spins
    // forever on it.
    this.line('while (*s && *s != \' \' && *s != \'"\' && *s != \'\\\'\') s++;');
    this.line('if (*s == \'"\' || *s == \'\\\'\') s++;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else if (strcmp(nm, "font") == 0 && closing) {');
    this.indent++;
    this.line('AS_TF_FLUSH();');
    this.line('face = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->font : NULL;');
    this.line('size = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->size : 12.0;');
    this.line('color = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->color : 0x000000u;');
    this.indent--;
    this.line('}');
    this.line('#undef AS_TF_FLUSH');
    this.line('i = j + 1;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('as_tf_html_emit_run(tf, runStart, opos, face, size, color, bold, italic, underline);');
    this.line('out[opos] = 0;');
    this.line('tf->text = out;');
    this.indent--;
    this.line('}');
    // ".text = ..." setter: a plain-text assignment replaces the whole content, so
    // the cached SkParagraph and any rich-text runs a previous htmlText /
    // setTextFormat installed are dropped (AIR semantics: the new content is laid
    // out from defaultTextFormat alone). Without this a field that once used
    // htmlText keeps replaying those runs on ALL later plain text — Starling's
    // TrueTypeCompositor reuses one static native TextField for every text it
    // composes, so entering a scene with HTML text silently re-sized every
    // plain-text label drawn afterwards (textHeight 29 -> 38 at the same font).
    // `_runs` is a GC array, so dropping the reference is enough to retire it.
    this.line('void TextField_set_text(void* _this, char* value) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('as_skia_textlayout_delete(tf->_para);');
    this.line('tf->_para = NULL;');
    this.line('tf->_para_text = NULL;');
    this.line('tf->_runs = NULL;');
    this.line('tf->text = value;');
    this.line('gc_write_barrier((void*)value);');
    this.indent--;
    this.line('}');
    this.line('void TextField_set_htmlText(void* _this, char* value) { as_tf_html_set((TextField*)_this, value); }');
    this.line('char* TextField_get_htmlText(void* _this) { return ((TextField*)_this)->text; }');
    // Point/Rectangle/Matrix/ColorTransform hold only double fields, so they are
    // plain value bundles (no GC pointers); Transform holds Matrix/ColorTransform
    // object references and is marked via its prop table.
    this.line('static Point* Point_mk(double x, double y) { Point* p = (Point*)gc_alloc(GCT_CLASS, sizeof(Point)); p->vtable = &Point_vt; p->x = x; p->y = y; return p; }');
    this.line('void Point_ctor(Point* o, double x, double y) { o->x = x; o->y = y; }');
    this.line('Point* Point_new(double x, double y) { Point* o = (Point*)gc_alloc(GCT_CLASS, sizeof(Point)); o->vtable = &Point_vt; Point_ctor(o, x, y); return o; }');
    this.line('double Point_get_length(void* _this) { Point* p = (Point*)_this; return sqrt(p->x * p->x + p->y * p->y); }');
    this.line('double Point_distance_static(Point* pt1, Point* pt2) { double dx = pt1->x - pt2->x, dy = pt1->y - pt2->y; return sqrt(dx * dx + dy * dy); }');
    // AS3 quirk: the closer f is to 1, the closer the result is to pt1 (not pt2).
    this.line('Point* Point_interpolate_static(Point* pt1, Point* pt2, double f) { return Point_mk(pt2->x + f * (pt1->x - pt2->x), pt2->y + f * (pt1->y - pt2->y)); }');
    this.line('Point* Point_polar_static(double len, double angle) { return Point_mk(len * cos(angle), len * sin(angle)); }');
    this.line('Point* Point_add(void* _this, Point* v) { Point* p = (Point*)_this; return Point_mk(p->x + v->x, p->y + v->y); }');
    this.line('Point* Point_subtract(void* _this, Point* v) { Point* p = (Point*)_this; return Point_mk(p->x - v->x, p->y - v->y); }');
    this.line('void Point_offset(void* _this, double dx, double dy) { Point* p = (Point*)_this; p->x += dx; p->y += dy; }');
    this.line('void Point_normalize(void* _this, double thickness) { Point* p = (Point*)_this; double l = sqrt(p->x * p->x + p->y * p->y); if (l == 0.0) { p->x = thickness; p->y = 0.0; return; } double s = thickness / l; p->x *= s; p->y *= s; }');
    this.line('void Point_setTo(void* _this, double xa, double ya) { Point* p = (Point*)_this; p->x = xa; p->y = ya; }');
    this.line('void Point_copyFrom(void* _this, Point* src) { Point* p = (Point*)_this; p->x = src->x; p->y = src->y; }');
    this.line('Point* Point_clone(void* _this) { Point* p = (Point*)_this; return Point_mk(p->x, p->y); }');
    this.line('bool Point_equals(void* _this, Point* o) { Point* p = (Point*)_this; return p->x == o->x && p->y == o->y; }');
    this.line('char* Point_toString(void* _this) { Point* p = (Point*)_this; char* r = as_str_alloc(64); snprintf(r, 64, "(x=%s, y=%s)", as_str_from_double(p->x), as_str_from_double(p->y)); return r; }');
    this.line('');
    this.line('static Rectangle* Rectangle_mk(double x, double y, double w, double h) { Rectangle* r = (Rectangle*)gc_alloc(GCT_CLASS, sizeof(Rectangle)); r->vtable = &Rectangle_vt; r->x = x; r->y = y; r->width = w; r->height = h; return r; }');
    this.line('void Rectangle_ctor(Rectangle* o, double x, double y, double width, double height) { o->x = x; o->y = y; o->width = width; o->height = height; }');
    this.line('Rectangle* Rectangle_new(double x, double y, double width, double height) { Rectangle* o = (Rectangle*)gc_alloc(GCT_CLASS, sizeof(Rectangle)); o->vtable = &Rectangle_vt; Rectangle_ctor(o, x, y, width, height); return o; }');
    this.line('double Rectangle_get_top(void* _this) { return ((Rectangle*)_this)->y; }');
    this.line('double Rectangle_get_bottom(void* _this) { Rectangle* r = (Rectangle*)_this; return r->y + r->height; }');
    this.line('double Rectangle_get_left(void* _this) { return ((Rectangle*)_this)->x; }');
    this.line('double Rectangle_get_right(void* _this) { Rectangle* r = (Rectangle*)_this; return r->x + r->width; }');
    this.line('void Rectangle_set_left(void* _this, double value) { ((Rectangle*)_this)->x = value; }');
    this.line('void Rectangle_set_top(void* _this, double value) { ((Rectangle*)_this)->y = value; }');
    this.line('void Rectangle_set_right(void* _this, double value) { Rectangle* r = (Rectangle*)_this; r->width = value - r->x; }');
    this.line('void Rectangle_set_bottom(void* _this, double value) { Rectangle* r = (Rectangle*)_this; r->height = value - r->y; }');
    this.line('bool Rectangle_isEmpty(void* _this) { Rectangle* r = (Rectangle*)_this; return r->width <= 0.0 || r->height <= 0.0; }');
    this.line('void Rectangle_setEmpty(void* _this) { Rectangle* r = (Rectangle*)_this; r->x = r->y = r->width = r->height = 0.0; }');
    this.line('void Rectangle_setTo(void* _this, double x, double y, double width, double height) { Rectangle* r = (Rectangle*)_this; r->x = x; r->y = y; r->width = width; r->height = height; }');
    this.line('Rectangle* Rectangle_intersection(void* _this, Rectangle* b) { Rectangle* a = (Rectangle*)_this; double x1 = fmax(a->x, b->x), y1 = fmax(a->y, b->y); double x2 = fmin(a->x + a->width, b->x + b->width), y2 = fmin(a->y + a->height, b->y + b->height); if (x2 < x1 || y2 < y1) return Rectangle_mk(0.0, 0.0, 0.0, 0.0); return Rectangle_mk(x1, y1, x2 - x1, y2 - y1); }');
    this.line('Rectangle* Rectangle_union(void* _this, Rectangle* b) { Rectangle* a = (Rectangle*)_this; double x1 = fmin(a->x, b->x), y1 = fmin(a->y, b->y); double x2 = fmax(a->x + a->width, b->x + b->width), y2 = fmax(a->y + a->height, b->y + b->height); return Rectangle_mk(x1, y1, x2 - x1, y2 - y1); }');
    this.line('bool Rectangle_contains(void* _this, double x, double y) { Rectangle* r = (Rectangle*)_this; return x >= r->x && x < r->x + r->width && y >= r->y && y < r->y + r->height; }');
    this.line('bool Rectangle_containsPoint(void* _this, Point* pt) { return Rectangle_contains(_this, pt->x, pt->y); }');
    this.line('bool Rectangle_containsRect(void* _this, Rectangle* q) { Rectangle* r = (Rectangle*)_this; if (r->width <= 0.0 || r->height <= 0.0) return false; if (q->width <= 0.0 || q->height <= 0.0) return true; return q->x >= r->x && q->y >= r->y && q->x + q->width <= r->x + r->width && q->y + q->height <= r->y + r->height; }');
    this.line('bool Rectangle_intersects(void* _this, Rectangle* b) { Rectangle* a = (Rectangle*)_this; double x0 = a->x < b->x ? b->x : a->x; double x1 = (a->x + a->width) > (b->x + b->width) ? (b->x + b->width) : (a->x + a->width); if (x1 <= x0) return false; double y0 = a->y < b->y ? b->y : a->y; double y1 = (a->y + a->height) > (b->y + b->height) ? (b->y + b->height) : (a->y + a->height); return y1 > y0; }');
    this.line('bool Rectangle_equals(void* _this, Rectangle* b) { Rectangle* a = (Rectangle*)_this; return a->x == b->x && a->y == b->y && a->width == b->width && a->height == b->height; }');
    this.line('void Rectangle_inflate(void* _this, double dx, double dy) { Rectangle* r = (Rectangle*)_this; r->x -= dx; r->width += 2.0 * dx; r->y -= dy; r->height += 2.0 * dy; }');
    this.line('void Rectangle_offset(void* _this, double dx, double dy) { Rectangle* r = (Rectangle*)_this; r->x += dx; r->y += dy; }');
    this.line('Rectangle* Rectangle_clone(void* _this) { Rectangle* r = (Rectangle*)_this; return Rectangle_mk(r->x, r->y, r->width, r->height); }');
    this.line('void Rectangle_copyFrom(void* _this, Rectangle* src) { Rectangle* r = (Rectangle*)_this; r->x = src->x; r->y = src->y; r->width = src->width; r->height = src->height; }');
    this.line('char* Rectangle_toString(void* _this) { Rectangle* r = (Rectangle*)_this; char* b = as_str_alloc(96); snprintf(b, 96, "(x=%s, y=%s, w=%s, h=%s)", as_str_from_double(r->x), as_str_from_double(r->y), as_str_from_double(r->width), as_str_from_double(r->height)); return b; }');
    this.line('');
    this.line('static Matrix* Matrix_mk(double a, double b, double c, double d, double tx, double ty) { Matrix* m = (Matrix*)gc_alloc(GCT_CLASS, sizeof(Matrix)); m->vtable = &Matrix_vt; m->a = a; m->b = b; m->c = c; m->d = d; m->tx = tx; m->ty = ty; return m; }');
    this.line('void Matrix_ctor(Matrix* o, double a, double b, double c, double d, double tx, double ty) { o->a = a; o->b = b; o->c = c; o->d = d; o->tx = tx; o->ty = ty; }');
    this.line('Matrix* Matrix_new(double a, double b, double c, double d, double tx, double ty) { Matrix* o = (Matrix*)gc_alloc(GCT_CLASS, sizeof(Matrix)); o->vtable = &Matrix_vt; Matrix_ctor(o, a, b, c, d, tx, ty); return o; }');
    this.line('void Matrix_identity(void* _this) { Matrix* m = (Matrix*)_this; m->a = 1.0; m->b = 0.0; m->c = 0.0; m->d = 1.0; m->tx = 0.0; m->ty = 0.0; }');
    this.line('void Matrix_translate(void* _this, double dx, double dy) { Matrix* m = (Matrix*)_this; m->tx += dx; m->ty += dy; }');
    // AS3 Matrix uses row-vector convention: p' = p * M, so x' = a*x + c*y + tx, y' = b*x + d*y + ty.
    // scale(sx,sy) = concat(Matrix(sx,0,0,sy,0,0)) => a*=sx; b*=sy; c*=sx; d*=sy; tx*=sx; ty*=sy.
    this.line('void Matrix_scale(void* _this, double sx, double sy) { Matrix* m = (Matrix*)_this; m->a *= sx; m->b *= sy; m->c *= sx; m->d *= sy; m->tx *= sx; m->ty *= sy; }');
    this.line('void Matrix_rotate(void* _this, double angle) { Matrix* m = (Matrix*)_this; double c = cos(angle), s = sin(angle); double a1 = m->a * c - m->b * s, b1 = m->a * s + m->b * c; double c1 = m->c * c - m->d * s, d1 = m->c * s + m->d * c; double tx1 = m->tx * c - m->ty * s, ty1 = m->tx * s + m->ty * c; m->a = a1; m->b = b1; m->c = c1; m->d = d1; m->tx = tx1; m->ty = ty1; }');
    // concat = this * m in row-vector form (apply this first, then m to a point).
    this.line('void Matrix_concat(void* _this, Matrix* q) { Matrix* m = (Matrix*)_this; double a1 = m->a * q->a + m->b * q->c, b1 = m->a * q->b + m->b * q->d; double c1 = m->c * q->a + m->d * q->c, d1 = m->c * q->b + m->d * q->d; double tx1 = m->tx * q->a + m->ty * q->c + q->tx, ty1 = m->tx * q->b + m->ty * q->d + q->ty; m->a = a1; m->b = b1; m->c = c1; m->d = d1; m->tx = tx1; m->ty = ty1; }');
    this.line('void Matrix_invert(void* _this) { Matrix* m = (Matrix*)_this; double det = m->a * m->d - m->b * m->c; if (det == 0.0) { as_throw(Error_new((char*)"Matrix cannot be inverted", 0)); return; } double na = m->d / det, nb = -m->b / det, nc = -m->c / det, nd = m->a / det; double ntx = (m->c * m->ty - m->d * m->tx) / det, nty = (m->b * m->tx - m->a * m->ty) / det; m->a = na; m->b = nb; m->c = nc; m->d = nd; m->tx = ntx; m->ty = nty; }');
    this.line('Point* Matrix_transformPoint(void* _this, Point* p) { Matrix* m = (Matrix*)_this; return Point_mk(m->a * p->x + m->c * p->y + m->tx, m->b * p->x + m->d * p->y + m->ty); }');
    this.line('Point* Matrix_deltaTransformPoint(void* _this, Point* p) { Matrix* m = (Matrix*)_this; return Point_mk(m->a * p->x + m->c * p->y, m->b * p->x + m->d * p->y); }');
    this.line('void Matrix_createBox(void* _this, double sx, double sy, double rotation, double tx, double ty) { Matrix* m = (Matrix*)_this; m->a = cos(rotation) * sx; m->b = sin(rotation) * sx; m->c = -sin(rotation) * sy; m->d = cos(rotation) * sy; m->tx = tx; m->ty = ty; }');
    this.line('void Matrix_createGradientBox(void* _this, double width, double height, double rotation, double tx, double ty) { Matrix* m = (Matrix*)_this; m->a = width / 1638.4; m->d = height / 1638.4; if (rotation != 0.0) { double c = cos(rotation), s = sin(rotation); m->b = s * m->d; m->c = -s * m->a; m->a *= c; m->d *= c; } else { m->b = 0.0; m->c = 0.0; } m->tx = tx + width / 2.0; m->ty = ty + height / 2.0; }');
    this.line('Matrix* Matrix_clone(void* _this) { Matrix* m = (Matrix*)_this; return Matrix_mk(m->a, m->b, m->c, m->d, m->tx, m->ty); }');
    this.line('void Matrix_copyFrom(void* _this, Matrix* src) { Matrix* m = (Matrix*)_this; m->a = src->a; m->b = src->b; m->c = src->c; m->d = src->d; m->tx = src->tx; m->ty = src->ty; }');
    this.line('void Matrix_setTo(void* _this, double a, double b, double c, double d, double tx, double ty) { Matrix* m = (Matrix*)_this; m->a = a; m->b = b; m->c = c; m->d = d; m->tx = tx; m->ty = ty; }');
    this.line('char* Matrix_toString(void* _this) { Matrix* m = (Matrix*)_this; char* b = as_str_alloc(160); snprintf(b, 160, "(a=%s, b=%s, c=%s, d=%s, tx=%s, ty=%s)", as_str_from_double(m->a), as_str_from_double(m->b), as_str_from_double(m->c), as_str_from_double(m->d), as_str_from_double(m->tx), as_str_from_double(m->ty)); return b; }');
    this.line('');
    this.line('void ColorTransform_ctor(ColorTransform* o, double rm, double gm, double bm, double am, double ro, double go, double bo, double ao) { o->redMultiplier = rm; o->greenMultiplier = gm; o->blueMultiplier = bm; o->alphaMultiplier = am; o->redOffset = ro; o->greenOffset = go; o->blueOffset = bo; o->alphaOffset = ao; }');
    this.line('ColorTransform* ColorTransform_new(double rm, double gm, double bm, double am, double ro, double go, double bo, double ao) { ColorTransform* o = (ColorTransform*)gc_alloc(GCT_CLASS, sizeof(ColorTransform)); o->vtable = &ColorTransform_vt; ColorTransform_ctor(o, rm, gm, bm, am, ro, go, bo, ao); return o; }');
    this.line('void ColorTransform_concat(void* _this, ColorTransform* q) { ColorTransform* t = (ColorTransform*)_this; double rm = t->redMultiplier * q->redMultiplier, gm = t->greenMultiplier * q->greenMultiplier, bm = t->blueMultiplier * q->blueMultiplier, am = t->alphaMultiplier * q->alphaMultiplier; double ro = t->redMultiplier * q->redOffset + t->redOffset, go = t->greenMultiplier * q->greenOffset + t->greenOffset, bo = t->blueMultiplier * q->blueOffset + t->blueOffset, ao = t->alphaMultiplier * q->alphaOffset + t->alphaOffset; t->redMultiplier = rm; t->greenMultiplier = gm; t->blueMultiplier = bm; t->alphaMultiplier = am; t->redOffset = ro; t->greenOffset = go; t->blueOffset = bo; t->alphaOffset = ao; }');
    this.line('char* ColorTransform_toString(void* _this) { ColorTransform* t = (ColorTransform*)_this; char* b = as_str_alloc(160); snprintf(b, 160, "(redMultiplier=%s, greenMultiplier=%s, blueMultiplier=%s, alphaMultiplier=%s, redOffset=%s, greenOffset=%s, blueOffset=%s, alphaOffset=%s)", as_str_from_double(t->redMultiplier), as_str_from_double(t->greenMultiplier), as_str_from_double(t->blueMultiplier), as_str_from_double(t->alphaMultiplier), as_str_from_double(t->redOffset), as_str_from_double(t->greenOffset), as_str_from_double(t->blueOffset), as_str_from_double(t->alphaOffset)); return b; }');
    this.line('');
    // Transform holds an identity Matrix and ColorTransform by default; wiring to
    // DisplayObject.transform is deferred to a later stage.
    this.line('void Transform_ctor(Transform* o) { o->matrix = Matrix_new(1.0, 0.0, 0.0, 1.0, 0.0, 0.0); o->colorTransform = ColorTransform_new(1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0); }');
    this.line('Transform* Transform_new(void) { Transform* o = (Transform*)gc_alloc(GCT_CLASS, sizeof(Transform)); o->vtable = &Transform_vt; Transform_ctor(o); return o; }');
    this.line('');
    // --- Vector3D (flash.geom stage 79): 4-component vector, pure double bundle. ---
    // Geometric ops (length/normalize/dot/cross/distance/angle) use the x/y/z
    // components only; w is the homogeneous coordinate. add/subtract/scaleBy/
    // negate are 4-component.
    this.line('static Vector3D* Vector3D_mk(double x, double y, double z, double w) { Vector3D* v = (Vector3D*)gc_alloc(GCT_CLASS, sizeof(Vector3D)); v->vtable = &Vector3D_vt; v->x = x; v->y = y; v->z = z; v->w = w; return v; }');
    this.line('void Vector3D_ctor(Vector3D* o, double x, double y, double z, double w) { o->x = x; o->y = y; o->z = z; o->w = w; }');
    this.line('Vector3D* Vector3D_new(double x, double y, double z, double w) { Vector3D* o = (Vector3D*)gc_alloc(GCT_CLASS, sizeof(Vector3D)); o->vtable = &Vector3D_vt; Vector3D_ctor(o, x, y, z, w); return o; }');
    this.line('Vector3D* Vector3D_add(void* _this, Vector3D* a) { Vector3D* v = (Vector3D*)_this; return Vector3D_mk(v->x + a->x, v->y + a->y, v->z + a->z, v->w + a->w); }');
    this.line('Vector3D* Vector3D_subtract(void* _this, Vector3D* a) { Vector3D* v = (Vector3D*)_this; return Vector3D_mk(v->x - a->x, v->y - a->y, v->z - a->z, v->w - a->w); }');
    this.line('void Vector3D_scaleBy(void* _this, double s) { Vector3D* v = (Vector3D*)_this; v->x *= s; v->y *= s; v->z *= s; v->w *= s; }');
    this.line('void Vector3D_negate(void* _this) { Vector3D* v = (Vector3D*)_this; v->x = -v->x; v->y = -v->y; v->z = -v->z; v->w = -v->w; }');
    this.line('double Vector3D_normalize(void* _this) { Vector3D* v = (Vector3D*)_this; double l = sqrt(v->x * v->x + v->y * v->y + v->z * v->z); if (l == 0.0) { v->x = v->y = v->z = 0.0; v->w = 1.0; return 0.0; } double s = 1.0 / l; v->x *= s; v->y *= s; v->z *= s; v->w = 1.0; return l; }');
    this.line('double Vector3D_dotProduct(void* _this, Vector3D* a) { Vector3D* v = (Vector3D*)_this; return v->x * a->x + v->y * a->y + v->z * a->z; }');
    this.line('Vector3D* Vector3D_crossProduct(void* _this, Vector3D* a) { Vector3D* v = (Vector3D*)_this; return Vector3D_mk(v->y * a->z - v->z * a->y, v->z * a->x - v->x * a->z, v->x * a->y - v->y * a->x, 1.0); }');
    this.line('double Vector3D_get_length(void* _this) { Vector3D* v = (Vector3D*)_this; return sqrt(v->x * v->x + v->y * v->y + v->z * v->z); }');
    this.line('double Vector3D_get_lengthSquared(void* _this) { Vector3D* v = (Vector3D*)_this; return v->x * v->x + v->y * v->y + v->z * v->z; }');
    this.line('double Vector3D_distance_static(Vector3D* a, Vector3D* b) { double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z; return sqrt(dx * dx + dy * dy + dz * dz); }');
    this.line('double Vector3D_angleBetween_static(Vector3D* a, Vector3D* b) { double dot = a->x * b->x + a->y * b->y + a->z * b->z; double la = sqrt(a->x * a->x + a->y * a->y + a->z * a->z), lb = sqrt(b->x * b->x + b->y * b->y + b->z * b->z); if (la == 0.0 || lb == 0.0) return 0.0; double c = dot / (la * lb); if (c > 1.0) c = 1.0; if (c < -1.0) c = -1.0; return acos(c); }');
    this.line('Vector3D* Vector3D_clone(void* _this) { Vector3D* v = (Vector3D*)_this; return Vector3D_mk(v->x, v->y, v->z, v->w); }');
    this.line('void Vector3D_setTo(void* _this, double x, double y, double z) { Vector3D* v = (Vector3D*)_this; v->x = x; v->y = y; v->z = z; }');
    this.line('void Vector3D_project(void* _this) { Vector3D* v = (Vector3D*)_this; if (v->w != 0.0) { v->x /= v->w; v->y /= v->w; v->z /= v->w; } }');
    this.line('bool Vector3D_equals(void* _this, Vector3D* o, bool allFour) { Vector3D* v = (Vector3D*)_this; if (allFour) return v->x == o->x && v->y == o->y && v->z == o->z && v->w == o->w; return v->x == o->x && v->y == o->y && v->z == o->z; }');
    this.line('char* Vector3D_toString(void* _this) { Vector3D* v = (Vector3D*)_this; char* b = as_str_alloc(96); snprintf(b, 96, "Vector3D(%s, %s, %s)", as_str_from_double(v->x), as_str_from_double(v->y), as_str_from_double(v->z)); return b; }');
    this.line('');
    // --- Matrix3D helpers: column-major 4x4 (element _m[c*4+r] == M[r][c]). ---
    this.line('static void as_mat3d_identity(double* out) { static const double I[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1}; memcpy(out, I, sizeof(I)); }');
    this.line('static void as_mat3d_mul(const double* a, const double* b, double* out) {');
    this.indent++;
    this.line('for (int c = 0; c < 4; c++)');
    this.indent++;
    this.line('for (int r = 0; r < 4; r++) {');
    this.indent++;
    this.line('double s = 0.0;');
    this.line('for (int k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];');
    this.line('out[c * 4 + r] = s;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.indent--;
    this.line('}');
    this.line('static int as_mat3d_invert4(const double* m, double* out) {');
    this.indent++;
    this.line('double a[16]; memcpy(a, m, sizeof(a));');
    this.line('double b[16]; as_mat3d_identity(b);');
    this.line('for (int i = 0; i < 4; i++) {');
    this.indent++;
    this.line('int pivot = i;');
    this.line('for (int r = i + 1; r < 4; r++) if (fabs(a[i * 4 + r]) > fabs(a[i * 4 + pivot])) pivot = r;');
    this.line('if (fabs(a[i * 4 + pivot]) < 1e-12) return 0;');
    this.line('if (pivot != i) for (int c = 0; c < 4; c++) { double ta = a[c * 4 + i]; a[c * 4 + i] = a[c * 4 + pivot]; a[c * 4 + pivot] = ta; double tb = b[c * 4 + i]; b[c * 4 + i] = b[c * 4 + pivot]; b[c * 4 + pivot] = tb; }');
    this.line('double pv = a[i * 4 + i];');
    this.line('for (int c = 0; c < 4; c++) { a[c * 4 + i] /= pv; b[c * 4 + i] /= pv; }');
    this.line('for (int r = 0; r < 4; r++) {');
    this.indent++;
    this.line('if (r == i) continue;');
    this.line('double f = a[i * 4 + r];');
    this.line('if (f == 0.0) continue;');
    this.line('for (int c = 0; c < 4; c++) { a[c * 4 + r] -= f * a[c * 4 + i]; b[c * 4 + r] -= f * b[c * 4 + i]; }');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('memcpy(out, b, sizeof(b));');
    this.line('return 1;');
    this.indent--;
    this.line('}');
    this.line('static void as_mat3d_translation(double x, double y, double z, double* out) { as_mat3d_identity(out); out[12] = x; out[13] = y; out[14] = z; }');
    this.line('static void as_mat3d_rotation(double degrees, double ax, double ay, double az, double* out) {');
    this.indent++;
    this.line('double rad = degrees * 3.14159265358979323846 / 180.0;');
    this.line('double len = sqrt(ax * ax + ay * ay + az * az);');
    this.line('if (len < 1e-12) { as_mat3d_identity(out); return; }');
    this.line('double ux = ax / len, uy = ay / len, uz = az / len;');
    this.line('double c = cos(rad), s = sin(rad), t = 1.0 - c;');
    this.line('out[0] = c + ux * ux * t; out[1] = uy * ux * t + uz * s; out[2] = uz * ux * t - uy * s; out[3] = 0.0;');
    this.line('out[4] = ux * uy * t - uz * s; out[5] = c + uy * uy * t; out[6] = uz * uy * t + ux * s; out[7] = 0.0;');
    this.line('out[8] = ux * uz * t + uy * s; out[9] = uy * uz * t - ux * s; out[10] = c + uz * uz * t; out[11] = 0.0;');
    this.line('out[12] = 0.0; out[13] = 0.0; out[14] = 0.0; out[15] = 1.0;');
    this.indent--;
    this.line('}');
    this.line('static Matrix3D* Matrix3D_mk(const double* m) { Matrix3D* o = (Matrix3D*)gc_alloc(GCT_CLASS, sizeof(Matrix3D)); o->vtable = &Matrix3D_vt; memcpy(o->_m, m, 16 * sizeof(double)); return o; }');
    this.line('void Matrix3D_ctor(Matrix3D* o, as_vector_number* v) { as_mat3d_identity(o->_m); if (v != NULL) { int n = v->length < 16 ? v->length : 16; for (int i = 0; i < n; i++) o->_m[i] = v->data[i]; } }');
    this.line('Matrix3D* Matrix3D_new(as_vector_number* v) { Matrix3D* o = (Matrix3D*)gc_alloc(GCT_CLASS, sizeof(Matrix3D)); o->vtable = &Matrix3D_vt; Matrix3D_ctor(o, v); return o; }');
    this.line('void Matrix3D_identity(void* _this) { as_mat3d_identity(((Matrix3D*)_this)->_m); }');
    // AS3 semantics: append(lhs) = lhs * this (pre-multiply, applied AFTER existing
    // transforms); prepend(rhs) = this * rhs (post-multiply, applied BEFORE). The
    // matrices are column-major, so as_mat3d_mul(a,b,out) == out = a * b.
    this.line('void Matrix3D_append(void* _this, Matrix3D* lhs) { Matrix3D* m = (Matrix3D*)_this; double r[16]; as_mat3d_mul(lhs->_m, m->_m, r); memcpy(m->_m, r, sizeof(r)); }');
    this.line('void Matrix3D_prepend(void* _this, Matrix3D* rhs) { Matrix3D* m = (Matrix3D*)_this; double r[16]; as_mat3d_mul(m->_m, rhs->_m, r); memcpy(m->_m, r, sizeof(r)); }');
    this.line('bool Matrix3D_invert(void* _this) { Matrix3D* m = (Matrix3D*)_this; double r[16]; if (!as_mat3d_invert4(m->_m, r)) return false; memcpy(m->_m, r, sizeof(r)); return true; }');
    this.line('void Matrix3D_transpose(void* _this) { Matrix3D* m = (Matrix3D*)_this; for (int r = 0; r < 4; r++) for (int c = r + 1; c < 4; c++) { double t = m->_m[c * 4 + r]; m->_m[c * 4 + r] = m->_m[r * 4 + c]; m->_m[r * 4 + c] = t; } }');
    this.line('Vector3D* Matrix3D_transformVector(void* _this, Vector3D* v) { Matrix3D* m = (Matrix3D*)_this; return Vector3D_mk(m->_m[0] * v->x + m->_m[4] * v->y + m->_m[8] * v->z + m->_m[12] * v->w, m->_m[1] * v->x + m->_m[5] * v->y + m->_m[9] * v->z + m->_m[13] * v->w, m->_m[2] * v->x + m->_m[6] * v->y + m->_m[10] * v->z + m->_m[14] * v->w, m->_m[3] * v->x + m->_m[7] * v->y + m->_m[11] * v->z + m->_m[15] * v->w); }');
    this.line('Vector3D* Matrix3D_deltaTransformVector(void* _this, Vector3D* v) { Matrix3D* m = (Matrix3D*)_this; return Vector3D_mk(m->_m[0] * v->x + m->_m[4] * v->y + m->_m[8] * v->z, m->_m[1] * v->x + m->_m[5] * v->y + m->_m[9] * v->z, m->_m[2] * v->x + m->_m[6] * v->y + m->_m[10] * v->z, 0.0); }');
    this.line('void Matrix3D_transformVectors(void* _this, as_vector_number* vin, as_vector_number* vout) { Matrix3D* m = (Matrix3D*)_this; int n = vin->length / 3; for (int i = 0; i < n; i++) { double x = vin->data[i * 3], y = vin->data[i * 3 + 1], z = vin->data[i * 3 + 2]; vout->data[i * 3] = m->_m[0] * x + m->_m[4] * y + m->_m[8] * z + m->_m[12]; vout->data[i * 3 + 1] = m->_m[1] * x + m->_m[5] * y + m->_m[9] * z + m->_m[13]; vout->data[i * 3 + 2] = m->_m[2] * x + m->_m[6] * y + m->_m[10] * z + m->_m[14]; } }');
    // appendTranslation = T * this (translate AFTER). T pre-multiplies, so each
    // row r in {0,1,2} gains t_r * (old row 3) — NOT just the last column. For an
    // affine matrix (row 3 == [0,0,0,1]) this degenerates to shifting only _m[12..14].
    this.line('void Matrix3D_appendTranslation(void* _this, double x, double y, double z) { Matrix3D* m = (Matrix3D*)_this; m->_m[0] += x * m->_m[3]; m->_m[4] += x * m->_m[7]; m->_m[8] += x * m->_m[11]; m->_m[12] += x * m->_m[15]; m->_m[1] += y * m->_m[3]; m->_m[5] += y * m->_m[7]; m->_m[9] += y * m->_m[11]; m->_m[13] += y * m->_m[15]; m->_m[2] += z * m->_m[3]; m->_m[6] += z * m->_m[7]; m->_m[10] += z * m->_m[11]; m->_m[14] += z * m->_m[15]; }');
    // prependTranslation = this * T (translate BEFORE). Only the last column c=3
    // changes: new _m[12+r] = dot(row r, (x,y,z)) + _m[12+r], for ALL four rows —
    // the w-row (r=3) must be updated too, else a perspective matrix keeps
    // _m[15]=0 and the w-coordinate collapses (Starling projection SIGSEGV/blank).
    this.line('void Matrix3D_prependTranslation(void* _this, double x, double y, double z) { Matrix3D* m = (Matrix3D*)_this; m->_m[12] += m->_m[0] * x + m->_m[4] * y + m->_m[8] * z; m->_m[13] += m->_m[1] * x + m->_m[5] * y + m->_m[9] * z; m->_m[14] += m->_m[2] * x + m->_m[6] * y + m->_m[10] * z; m->_m[15] += m->_m[3] * x + m->_m[7] * y + m->_m[11] * z; }');
    // appendScale = S * this (scale AFTER): scales the ROWS (each row of _m).
    this.line('void Matrix3D_appendScale(void* _this, double x, double y, double z) { Matrix3D* m = (Matrix3D*)_this; m->_m[0] *= x; m->_m[4] *= x; m->_m[8] *= x; m->_m[12] *= x; m->_m[1] *= y; m->_m[5] *= y; m->_m[9] *= y; m->_m[13] *= y; m->_m[2] *= z; m->_m[6] *= z; m->_m[10] *= z; m->_m[14] *= z; }');
    // prependScale = this * S (scale BEFORE): scales the COLUMNS of _m.
    this.line('void Matrix3D_prependScale(void* _this, double x, double y, double z) { Matrix3D* m = (Matrix3D*)_this; m->_m[0] *= x; m->_m[1] *= x; m->_m[2] *= x; m->_m[3] *= x; m->_m[4] *= y; m->_m[5] *= y; m->_m[6] *= y; m->_m[7] *= y; m->_m[8] *= z; m->_m[9] *= z; m->_m[10] *= z; m->_m[11] *= z; }');
    this.line('void Matrix3D_appendRotation(void* _this, double degrees, Vector3D* axis, Vector3D* pivot) {');
    this.indent++;
    this.line('Matrix3D* m = (Matrix3D*)_this;');
    this.line('double R[16]; as_mat3d_rotation(degrees, axis->x, axis->y, axis->z, R);');
    this.line('if (pivot == NULL) { double r[16]; as_mat3d_mul(R, m->_m, r); memcpy(m->_m, r, sizeof(r)); }');
    this.line('else { double Tp[16], Tm[16], t1[16], t2[16]; as_mat3d_translation(pivot->x, pivot->y, pivot->z, Tp); as_mat3d_translation(-pivot->x, -pivot->y, -pivot->z, Tm); as_mat3d_mul(Tp, R, t1); as_mat3d_mul(t1, Tm, t2); as_mat3d_mul(t2, m->_m, t1); memcpy(m->_m, t1, sizeof(t1)); }');
    this.indent--;
    this.line('}');
    this.line('void Matrix3D_prependRotation(void* _this, double degrees, Vector3D* axis, Vector3D* pivot) {');
    this.indent++;
    this.line('Matrix3D* m = (Matrix3D*)_this;');
    this.line('double R[16]; as_mat3d_rotation(degrees, axis->x, axis->y, axis->z, R);');
    this.line('if (pivot == NULL) { double r[16]; as_mat3d_mul(m->_m, R, r); memcpy(m->_m, r, sizeof(r)); }');
    this.line('else { double Tp[16], Tm[16], t1[16], t2[16]; as_mat3d_translation(pivot->x, pivot->y, pivot->z, Tp); as_mat3d_translation(-pivot->x, -pivot->y, -pivot->z, Tm); as_mat3d_mul(Tp, R, t1); as_mat3d_mul(t1, Tm, t2); as_mat3d_mul(m->_m, t2, t1); memcpy(m->_m, t1, sizeof(t1)); }');
    this.indent--;
    this.line('}');
    this.line('void Matrix3D_pointAt(void* _this, Vector3D* pos, Vector3D* at, Vector3D* up) {');
    this.indent++;
    this.line('Matrix3D* m = (Matrix3D*)_this;');
    this.line('double zx = pos->x - at->x, zy = pos->y - at->y, zz = pos->z - at->z;');
    this.line('double zl = sqrt(zx * zx + zy * zy + zz * zz);');
    this.line('if (zl == 0.0) { as_mat3d_identity(m->_m); return; }');
    this.line('zx /= zl; zy /= zl; zz /= zl;');
    this.line('double xx = up->y * zz - up->z * zy, xy = up->z * zx - up->x * zz, xz = up->x * zy - up->y * zx;');
    this.line('double xl = sqrt(xx * xx + xy * xy + xz * xz);');
    this.line('if (xl == 0.0) { as_mat3d_identity(m->_m); return; }');
    this.line('xx /= xl; xy /= xl; xz /= xl;');
    this.line('double yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;');
    this.line('m->_m[0] = xx; m->_m[1] = xy; m->_m[2] = xz; m->_m[3] = 0.0;');
    this.line('m->_m[4] = yx; m->_m[5] = yy; m->_m[6] = yz; m->_m[7] = 0.0;');
    this.line('m->_m[8] = zx; m->_m[9] = zy; m->_m[10] = zz; m->_m[11] = 0.0;');
    this.line('m->_m[12] = pos->x; m->_m[13] = pos->y; m->_m[14] = pos->z; m->_m[15] = 1.0;');
    this.indent--;
    this.line('}');
    this.line('void Matrix3D_interpolate(void* _this, Matrix3D* a, Matrix3D* b, double p) { Matrix3D* m = (Matrix3D*)_this; for (int i = 0; i < 16; i++) m->_m[i] = a->_m[i] + (b->_m[i] - a->_m[i]) * p; }');
    this.line('Matrix3D* Matrix3D_interpolate_static(Matrix3D* a, Matrix3D* b, double p) { Matrix3D* o = (Matrix3D*)gc_alloc(GCT_CLASS, sizeof(Matrix3D)); o->vtable = &Matrix3D_vt; for (int i = 0; i < 16; i++) o->_m[i] = a->_m[i] + (b->_m[i] - a->_m[i]) * p; return o; }');
    this.line('Matrix3D* Matrix3D_identity_static(void) { Matrix3D* o = (Matrix3D*)gc_alloc(GCT_CLASS, sizeof(Matrix3D)); o->vtable = &Matrix3D_vt; as_mat3d_identity(o->_m); return o; }');
    this.line('void Matrix3D_copyFrom(void* _this, Matrix3D* src) { memcpy(((Matrix3D*)_this)->_m, src->_m, 16 * sizeof(double)); }');
    this.line('void Matrix3D_copyRawDataTo(void* _this, as_vector_number* v, unsigned int index, bool transpose) { Matrix3D* m = (Matrix3D*)_this; if (v == NULL) return; for (int i = 0; i < 16; i++) { double val = transpose ? m->_m[(i % 4) * 4 + (i / 4)] : m->_m[i]; int j = (int)index + i; if (j < v->length) v->data[j] = val; } }');
    this.line('void Matrix3D_copyRawDataFrom(void* _this, as_vector_number* v, unsigned int index, bool transpose) { Matrix3D* m = (Matrix3D*)_this; if (v == NULL) return; for (int i = 0; i < 16; i++) { int j = (int)index + i; double val = (j < v->length) ? v->data[j] : 0.0; if (transpose) m->_m[(i % 4) * 4 + (i / 4)] = val; else m->_m[i] = val; } }');
    this.line('Matrix3D* Matrix3D_clone(void* _this) { return Matrix3D_mk(((Matrix3D*)_this)->_m); }');
    this.line('as_vector_number* Matrix3D_get_rawData(void* _this) { Matrix3D* m = (Matrix3D*)_this; as_vector_number* v = as_vector_number_new(); for (int i = 0; i < 16; i++) as_vector_number_push(v, m->_m[i]); return v; }');
    this.line('void Matrix3D_set_rawData(void* _this, as_vector_number* v) { Matrix3D* m = (Matrix3D*)_this; int n = v->length < 16 ? v->length : 16; for (int i = 0; i < n; i++) m->_m[i] = v->data[i]; }');
    this.line('as_vector_Vector3D* Matrix3D_decompose(void* _this, char* orientation) {');
    this.indent++;
    this.line('(void)orientation;');
    this.line('Matrix3D* m = (Matrix3D*)_this;');
    this.line('Vector3D* tr = Vector3D_mk(m->_m[12], m->_m[13], m->_m[14], 0.0);');
    this.line('double sx = sqrt(m->_m[0] * m->_m[0] + m->_m[1] * m->_m[1] + m->_m[2] * m->_m[2]);');
    this.line('double sy = sqrt(m->_m[4] * m->_m[4] + m->_m[5] * m->_m[5] + m->_m[6] * m->_m[6]);');
    this.line('double sz = sqrt(m->_m[8] * m->_m[8] + m->_m[9] * m->_m[9] + m->_m[10] * m->_m[10]);');
    this.line('Vector3D* sc = Vector3D_mk(sx, sy, sz, 0.0);');
    this.line('double r00 = sx == 0.0 ? 1.0 : m->_m[0] / sx, r10 = sx == 0.0 ? 0.0 : m->_m[1] / sx, r20 = sx == 0.0 ? 0.0 : m->_m[2] / sx;');
    this.line('double r01 = sy == 0.0 ? 0.0 : m->_m[4] / sy, r11 = sy == 0.0 ? 1.0 : m->_m[5] / sy, r21 = sy == 0.0 ? 0.0 : m->_m[6] / sy;');
    this.line('double r02 = sz == 0.0 ? 0.0 : m->_m[8] / sz, r12 = sz == 0.0 ? 0.0 : m->_m[9] / sz, r22 = sz == 0.0 ? 1.0 : m->_m[10] / sz;');
    this.line('double syv = r02 > 1.0 ? 1.0 : (r02 < -1.0 ? -1.0 : r02);');
    this.line('double ry = asin(syv);');
    this.line('double rx = atan2(-r12, r22);');
    this.line('double rz = atan2(-r01, r00);');
    this.line('Vector3D* rot = Vector3D_mk(rx, ry, rz, 0.0);');
    this.line('as_vector_Vector3D* out = as_vector_Vector3D_new();');
    this.line('as_vector_Vector3D_push(out, tr); as_vector_Vector3D_push(out, rot); as_vector_Vector3D_push(out, sc);');
    this.line('return out;');
    this.indent--;
    this.line('}');
    this.line('bool Matrix3D_recompose(void* _this, as_vector_Vector3D* components, char* orientation) {');
    this.indent++;
    this.line('(void)orientation;');
    this.line('if (components->length < 3) return false;');
    this.line('Vector3D* tr = as_vector_Vector3D_get(components, 0);');
    this.line('Vector3D* rot = as_vector_Vector3D_get(components, 1);');
    this.line('Vector3D* sc = as_vector_Vector3D_get(components, 2);');
    this.line('Matrix3D* m = (Matrix3D*)_this;');
    this.line('double cx = cos(rot->x), sx = sin(rot->x), cy = cos(rot->y), sy = sin(rot->y), cz = cos(rot->z), sz = sin(rot->z);');
    this.line('double r00 = cy * cz, r01 = -cy * sz, r02 = sy;');
    this.line('double r10 = cx * sz + sx * sy * cz, r11 = cx * cz - sx * sy * sz, r12 = -sx * cy;');
    this.line('double r20 = sx * sz - cx * sy * cz, r21 = sx * cz + cx * sy * sz, r22 = cx * cy;');
    this.line('m->_m[0] = r00 * sc->x; m->_m[1] = r10 * sc->x; m->_m[2] = r20 * sc->x; m->_m[3] = 0.0;');
    this.line('m->_m[4] = r01 * sc->y; m->_m[5] = r11 * sc->y; m->_m[6] = r21 * sc->y; m->_m[7] = 0.0;');
    this.line('m->_m[8] = r02 * sc->z; m->_m[9] = r12 * sc->z; m->_m[10] = r22 * sc->z; m->_m[11] = 0.0;');
    this.line('m->_m[12] = tr->x; m->_m[13] = tr->y; m->_m[14] = tr->z; m->_m[15] = 1.0;');
    this.line('return true;');
    this.indent--;
    this.line('}');
    this.line('char* Matrix3D_toString(void* _this) { Matrix3D* m = (Matrix3D*)_this; char* b = as_str_alloc(320); int p = snprintf(b, 320, "Matrix3D("); for (int i = 0; i < 16; i++) p += snprintf(b + p, 320 - p, "%s%s", i == 0 ? "" : ", ", as_str_from_double(m->_m[i])); snprintf(b + p, 320 - p, ")"); return b; }');
    this.line('');
    // AGALTranslator.translate(bytes, target): stage-80 bridge over the runtime
    // AGAL -> MSL/GLSL translator (as_agal_translate). `target` is "msl" (default)
    // or "glsl". Validation errors throw Error with the translator's message.
    this.line('char* AGALTranslator_translate_static(ByteArray* bytes, char* target) {');
    this.indent++;
    this.line('int t = (target != NULL && strcmp(target, "glsl") == 0) ? 1 : 0;');
    this.line('char* r = as_agal_translate((const unsigned char*)bytes->data, bytes->length, t);');
    this.line('if (r == NULL) { as_throw(Error_new((char*)as_agal_errmsg, 0)); return NULL; }');
    this.line('return r;');
    this.indent--;
    this.line('}');
    this.line('');
    // ===== flash.display3D (stage 81): resource classes + Context3D state machine
    // + Stage3D slot. CPU-side only; the GPU upload/draw lands in stage 82. =====
    this.line('void VertexBuffer3D_ctor(VertexBuffer3D* o) { Object_ctor((Object*)o); o->numVertices = 0; o->data32PerVertex = 0; o->raw = NULL; o->startVertex = 0; }');
    this.line('VertexBuffer3D* VertexBuffer3D_new(void) { VertexBuffer3D* o = (VertexBuffer3D*)gc_alloc(GCT_CLASS, sizeof(VertexBuffer3D)); o->vtable = &VertexBuffer3D_vt; VertexBuffer3D_ctor(o); return o; }');
    // Vertex payload storage: one 32-bit word per component, in the order the
    // upload produced them (absolute vertex index * stride + component offset).
    // AS3's Vector.<Number> upload goes through float32 (that is what the GPU
    // receives), so the double is narrowed here once and the submit path never
    // re-widens/re-narrows it. Element storage is pledged separately for
    // word-only buffers, so this is 4 bytes per component where the old
    // data+rawBits double pair kept 16.
    this.line('static unsigned* VertexBuffer3D_words(VertexBuffer3D* o, int need) {');
    this.indent++;
    this.line('if (o->raw == NULL) { as_vector_uint* v = as_vector_uint_new(); o->raw = v; gc_write_barrier((void*)v); }');
    this.line('if (o->raw->length < need) as_vector_uint_setLength(o->raw, need);');
    this.line('return o->raw->data;');
    this.indent--;
    this.line('}');
    this.line('void VertexBuffer3D_uploadFromVector(void* _this, as_vector_number* data, int startVertex, int numVertices) {');
    this.indent++;
    this.line('VertexBuffer3D* o = (VertexBuffer3D*)_this;');
    this.line('if (data == NULL || numVertices <= 0) return;');
    this.line('int stride = o->data32PerVertex;');
    this.line('if (stride <= 0) return;');
    // Clamp to the source vector: both indices are absolute vertex indices into
    // the caller's Vector (uploadFromByteArray works the same way).
    this.line('int avail = (data->length - startVertex * stride) / stride;');
    this.line('if (avail < numVertices) numVertices = avail;');
    this.line('if (numVertices <= 0) return;');
    this.line('unsigned* dst = VertexBuffer3D_words(o, startVertex * stride + numVertices * stride);');
    this.line('double* src = data->data + (size_t)startVertex * (size_t)stride;');
    this.line('int n = numVertices * stride;');
    this.line('for (int i = 0; i < n; i++) {');
    this.indent++;
    this.line('float f = (float)src[i];');
    this.line('memcpy(dst + startVertex * stride + i, &f, 4);');
    this.indent--;
    this.line('}');
    this.line('o->startVertex = startVertex;');
    this.line('o->numVertices = numVertices;');
    this.indent--;
    this.line('}');
    this.line('void VertexBuffer3D_dispose(void* _this) { VertexBuffer3D* o = (VertexBuffer3D*)_this; o->raw = NULL; }');
    // uploadFromByteArray (stage 87): Starling's VertexData stores vertices as
    // little-endian float32 in a ByteArray (not Vector.<Number>). Copy the words
    // straight out of the ByteArray (a single memcpy when its endianness matches
    // the host's) -- no per-element float decode, because the submit path now
    // interprets the word according to the attribute format.
    this.line('void VertexBuffer3D_uploadFromByteArray(void* _this, ByteArray* data, unsigned int byteArrayOffset, int startVertex, int numVertices) {');
    this.indent++;
    this.line('VertexBuffer3D* o = (VertexBuffer3D*)_this;');
    this.line('if (data == NULL || data->data == NULL) return;');
    this.line('int stride = o->data32PerVertex;');
    this.line('if (stride <= 0) return;');
    this.line('int count = numVertices * stride;');
    this.line('int avail = data->length - (int)byteArrayOffset;');
    this.line('int maxCount = avail >= 0 ? avail / 4 : 0;');
    this.line('if (count > maxCount) count = maxCount;');
    this.line('if (count <= 0) return;');
    this.line('int uploaded = count / stride;');
    this.line('if (uploaded <= 0) return;');
    this.line('unsigned* dst = VertexBuffer3D_words(o, startVertex * stride + count);');
    this.line('unsigned char* src = (unsigned char*)data->data + byteArrayOffset;');
    this.line('unsigned* out = dst + (size_t)startVertex * (size_t)stride;');
    this.line('if (as_ba_little(data) == as_host_little()) {');
    this.indent++;
    this.line('memcpy(out, src, (size_t)count * 4);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('for (int i = 0; i < count; i++) out[i] = ((unsigned)src[i*4] << 24) | ((unsigned)src[i*4+1] << 16) | ((unsigned)src[i*4+2] << 8) | (unsigned)src[i*4+3];');
    this.indent--;
    this.line('}');
    this.line('o->startVertex = startVertex;');
    this.line('o->numVertices = uploaded;');
    this.indent--;
    this.line('}');
    this.line('void IndexBuffer3D_ctor(IndexBuffer3D* o) { Object_ctor((Object*)o); o->numIndices = 0; o->data = NULL; o->startIndex = 0; }');
    this.line('IndexBuffer3D* IndexBuffer3D_new(void) { IndexBuffer3D* o = (IndexBuffer3D*)gc_alloc(GCT_CLASS, sizeof(IndexBuffer3D)); o->vtable = &IndexBuffer3D_vt; IndexBuffer3D_ctor(o); return o; }');
    this.line('void IndexBuffer3D_uploadFromVector(void* _this, as_vector_uint* data, int startIndex, int numIndices) {');
    this.indent++;
    this.line('IndexBuffer3D* o = (IndexBuffer3D*)_this;');
    this.line('if (data == NULL || numIndices <= 0) return;');
    // AS3 copies the data into the buffer; aliasing the caller's Vector would let a
    // later in-place upload mutate an object the AS3 program still owns. Keep our
    // own copy, indexed by absolute index like uploadFromByteArray.
    this.line('if (o->data == NULL) { o->data = as_vector_uint_new(); gc_write_barrier((void*)o->data); }');
    this.line('int need = startIndex + numIndices;');
    this.line('if (o->data->length < need) as_vector_uint_setLength(o->data, need);');
    this.line('for (int i = 0; i < numIndices; i++) o->data->data[startIndex + i] = data->data[i];');
    this.line('o->startIndex = startIndex;');
    this.line('o->numIndices = numIndices;');
    this.indent--;
    this.line('}');
    this.line('void IndexBuffer3D_dispose(void* _this) { IndexBuffer3D* o = (IndexBuffer3D*)_this; o->data = NULL; }');
    // uploadFromByteArray (stage 87): Starling's IndexData stores indices as
    // little-endian uint16 (INDEX_SIZE=2) in a ByteArray; widen to uint32 so the
    // submit path (MTLIndexTypeUInt32) reads the same layout as uploadFromVector.
    // Reused across uploads for the same reason as the vertex buffer.
    this.line('void IndexBuffer3D_uploadFromByteArray(void* _this, ByteArray* data, unsigned int byteArrayOffset, int startIndex, int numIndices) {');
    this.indent++;
    this.line('IndexBuffer3D* o = (IndexBuffer3D*)_this;');
    this.line('if (data == NULL || data->data == NULL) return;');
    this.line('int count = numIndices;');
    this.line('int avail = data->length - (int)byteArrayOffset;');
    this.line('int maxCount = avail >= 0 ? avail / 2 : 0;');
    this.line('if (count > maxCount) count = maxCount;');
    this.line('if (count <= 0) return;');
    this.line('int need = startIndex + count;');
    this.line('if (o->data == NULL) { o->data = as_vector_uint_new(); gc_write_barrier((void*)o->data); }');
    this.line('if (o->data->length < need) as_vector_uint_setLength(o->data, need);');
    this.line('unsigned char* src = (unsigned char*)data->data + byteArrayOffset;');
    this.line('int little = as_ba_little(data);');
    this.line('unsigned int* dst = o->data->data + startIndex;');
    this.line('for (int i = 0; i < count; i++) {');
    this.indent++;
    this.line('unsigned v = little ? ((unsigned)src[i*2] | ((unsigned)src[i*2+1] << 8)) : (((unsigned)src[i*2] << 8) | (unsigned)src[i*2+1]);');
    this.line('dst[i] = (unsigned int)v;');
    this.indent--;
    this.line('}');
    this.line('o->startIndex = startIndex;');
    this.line('o->numIndices = count;');
    this.indent--;
    this.line('}');
    this.line('void Program3D_ctor(Program3D* o) { Object_ctor((Object*)o); o->vertexProgram = NULL; o->fragmentProgram = NULL; }');
    this.line('Program3D* Program3D_new(void) { Program3D* o = (Program3D*)gc_alloc(GCT_CLASS, sizeof(Program3D)); o->vtable = &Program3D_vt; Program3D_ctor(o); return o; }');
    this.line('void Program3D_upload(void* _this, ByteArray* vertexProgram, ByteArray* fragmentProgram) {');
    this.indent++;
    this.line('Program3D* o = (Program3D*)_this;');
    this.line('o->vertexProgram = vertexProgram; gc_write_barrier((void*)vertexProgram);');
    this.line('o->fragmentProgram = fragmentProgram; gc_write_barrier((void*)fragmentProgram);');
    this.indent--;
    this.line('}');
    this.line('void Program3D_dispose(void* _this) { Program3D* o = (Program3D*)_this; o->vertexProgram = NULL; o->fragmentProgram = NULL; }');
    this.line('void TextureBase_ctor(TextureBase* o) { Object_ctor((Object*)o); }');
    this.line('TextureBase* TextureBase_new(void) { TextureBase* o = (TextureBase*)gc_alloc(GCT_CLASS, sizeof(TextureBase)); o->vtable = &TextureBase_vt; TextureBase_ctor(o); return o; }');
    this.line('void TextureBase_dispose(void* _this) { (void)_this; }');
    this.line('void VideoTexture_ctor(VideoTexture* o) { TextureBase_ctor((TextureBase*)o); o->videoWidth = 0; o->videoHeight = 0; }');
    this.line('VideoTexture* VideoTexture_new(void) { VideoTexture* o = (VideoTexture*)gc_alloc(GCT_CLASS, sizeof(VideoTexture)); o->vtable = &VideoTexture_vt; VideoTexture_ctor(o); return o; }');
    this.line('void VideoTexture_dispose(void* _this) { (void)_this; }');
    this.line('void VideoTexture_attachCamera(void* _this, Object* camera) { (void)_this; (void)camera; }');
    this.line('void VideoTexture_attachNetStream(void* _this, Object* netStream) { (void)_this; (void)netStream; }');
    this.line('void Texture_ctor(Texture* o) { TextureBase_ctor((TextureBase*)o); o->width = 0; o->height = 0; o->format = NULL; o->bitmapData = NULL; o->gpu = NULL; o->ctx = NULL; }');
    this.line('Texture* Texture_new(void) { Texture* o = (Texture*)gc_alloc(GCT_CLASS, sizeof(Texture)); o->vtable = &Texture_vt; Texture_ctor(o); return o; }');
    this.line('void Texture_uploadFromBitmapData(void* _this, BitmapData* bitmapData, unsigned int miplevel) {');
    this.indent++;
    this.line('Texture* o = (Texture*)_this;');
    // Our GPU texture is a single-level (mipmapped:NO) BGRA8 surface, so only
    // level 0 is stored and later uploaded. Higher mip levels (the demo's halving
    // loop) are ignored rather than overwriting the full-res sprite sheet with a
    // smaller mip.
    this.line('if (miplevel != 0) return;');
    // Invalidate any cached GPU handle: a new bitmap means the texture content
    // changed.
    this.line('if (o->gpu != NULL) { as_s3d_destroy_texture(o->gpu); o->gpu = NULL; }');
    this.line('o->bitmapData = bitmapData; gc_write_barrier((void*)bitmapData);');
    this.line('if (bitmapData != NULL) { o->width = bitmapData->width; o->height = bitmapData->height; }');
    // Upload NOW, exactly like AIR's synchronous uploadFromBitmapData. Starling
    // rasterizes each text field into a BitmapData, hands it to
    // Texture.fromBitmapData and immediately calls bitmapData.dispose(); an upload
    // deferred to the next Context3D_submit would read the freed pixel buffer (the
    // text texture then never got uploaded -- the sampler kept whatever the
    // previous draw had left on that unit, so button labels rendered as garbage
    // slices of the sprite atlas). The bitmapData reference above is kept only for
    // the pre-upload fallback below and for onRestore-style re-uploads.
    this.line('if (o->ctx != NULL && bitmapData != NULL && bitmapData->pixels != NULL) o->gpu = as_s3d_texture_from_pixels(o->ctx, o->width, o->height, (const uint32_t*)bitmapData->pixels);');
    this.indent--;
    this.line('}');
    this.line('void Texture_dispose(void* _this) { Texture* o = (Texture*)_this; o->width = 0; o->height = 0; o->format = NULL; o->bitmapData = NULL; as_s3d_destroy_texture(o->gpu); o->gpu = NULL; o->ctx = NULL; }');
    // ATF (Adobe Texture Format) decoding lives in as_atf_decode_dxt (runtime):
    // the container is parsed, the DXT record of mip level 0 is decoded to ARGB
    // and handed on as an ordinary bitmap-sourced texture. AIR would bind the
    // block-compressed payload directly; our backend only takes unpacked BGRA8
    // pixels, so the decode is mandatory -- otherwise the texture stays empty and
    // every quad sampling it draws as a flat block.
    // The async contract still holds: AIR fires TEXTURE_READY once the upload
    // completes, and Starling's AtfTextureFactory registers an onTextureReady
    // listener before calling this. Dispatching on the next frame tick (rather
    // than synchronously) also lets Texture.fromData return first, so the
    // factory's `texture` local is assigned before its onReady closure reads it.
    this.line('static as_value Texture__textureReady(void* env, as_value* args, int argc) {');
    this.indent++;
    this.line('(void)args; (void)argc;');
    this.line('EventDispatcher_dispatchEvent((EventDispatcher*)env, Event_new((char*)"textureReady", false, false));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('void Texture_uploadCompressedTextureFromByteArray(void* _this, ByteArray* data, unsigned int byteArrayOffset, bool async) {');
    this.indent++;
    this.line('Texture* o = (Texture*)_this;');
    this.line('int aw = 0, ah = 0;');
    this.line('unsigned* px = NULL;');
    this.line('if (data != NULL && data->data != NULL && (size_t)byteArrayOffset < (size_t)data->length)');
    this.line('  px = as_atf_decode_dxt((const unsigned char*)data->data + byteArrayOffset, (int)((size_t)data->length - byteArrayOffset), &aw, &ah);');
    this.line('if (px != NULL) {');
    this.indent++;
    // Reuse the ordinary BitmapData path: a Texture sampled by Context3D_submit
    // either has a GPU handle or a bitmapData holding its pixels in ARGB, and the
    // ATF decode produces exactly the latter. BitmapData_ctor mallocs and fills
    // the buffer, so copy in the decoded pixels and release our temporary.
    this.line('BitmapData* bd = BitmapData_new(aw, ah, true, 0);');
    this.line('if (bd != NULL && bd->pixels != NULL) {');
    this.indent++;
    this.line('memcpy(bd->pixels, px, sizeof(unsigned) * (size_t)aw * (size_t)ah);');
    this.line('if (o->gpu != NULL) { as_s3d_destroy_texture(o->gpu); o->gpu = NULL; }');
    this.line('o->bitmapData = bd; gc_write_barrier((void*)bd);');
    this.line('o->width = aw; o->height = ah;');
    // Upload eagerly, like Texture_uploadFromBitmapData: mip level 0 only, the
    // upload is synchronous and the GPU handle is cached on the texture.
    this.line('if (o->ctx != NULL) o->gpu = as_s3d_texture_from_pixels(o->ctx, aw, ah, (const uint32_t*)bd->pixels);');
    this.indent--;
    this.line('}');
    this.line('free(px);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    // Never fail silently: an undecodable ATF would otherwise render as an empty
    // texture with no diagnostic at all (the original pink-square symptom). AIR
    // throws ArgumentError for containers it cannot hand to the GPU.
    this.line('as_throw(ArgumentError_new((char*)"Error #3680: ATF data is not in a supported format (only raw DXT containers are decoded)", 0));');
    this.indent--;
    this.line('}');
    this.line('if (async) as_set_timeout(as_fn_make(Texture__textureReady, _this, 0), 0.0);');
    this.indent--;
    this.line('}');
    // CubeTexture (stage 83): six faces as a CPU descriptor. uploadFromBitmapData
    // records the source per face; the GPU cube target is a future follow-up.
    this.line('void CubeTexture_ctor(CubeTexture* o) { TextureBase_ctor((TextureBase*)o); o->width = 0; o->height = 0; o->format = NULL; o->face0 = o->face1 = o->face2 = o->face3 = o->face4 = o->face5 = NULL; }');
    this.line('CubeTexture* CubeTexture_new(void) { CubeTexture* o = (CubeTexture*)gc_alloc(GCT_CLASS, sizeof(CubeTexture)); o->vtable = &CubeTexture_vt; CubeTexture_ctor(o); return o; }');
    this.line('void CubeTexture_uploadFromBitmapData(void* _this, BitmapData* bitmapData, unsigned int side, unsigned int miplevel) {');
    this.indent++;
    this.line('CubeTexture* o = (CubeTexture*)_this;');
    this.line('(void)miplevel;');
    this.line('if (bitmapData != NULL) { o->width = bitmapData->width; o->height = bitmapData->height; }');
    this.line('switch (side) {');
    for (let i = 0; i < 6; i++) this.line(`case ${i}: o->face${i} = bitmapData; break;`);
    this.line('default: break;');
    this.line('}');
    this.line('gc_write_barrier((void*)bitmapData);');
    this.indent--;
    this.line('}');
    this.line('void CubeTexture_dispose(void* _this) { CubeTexture* o = (CubeTexture*)_this; o->face0 = o->face1 = o->face2 = o->face3 = o->face4 = o->face5 = NULL; }');
    // RectangleTexture (stage 83): NPOT 2D descriptor (uploadFromBitmapData).
    // Layout-identical to Texture (vtable, width, height, format, bitmapData, gpu)
    // so Context3D_submit can read ->gpu/->bitmapData through a Texture* without
    // reading past the struct end (see symbols.ts RectangleTexture field comment).
    this.line('void RectangleTexture_ctor(RectangleTexture* o) { TextureBase_ctor((TextureBase*)o); o->width = 0; o->height = 0; o->format = NULL; o->bitmapData = NULL; o->gpu = NULL; o->ctx = NULL; }');
    this.line('RectangleTexture* RectangleTexture_new(void) { RectangleTexture* o = (RectangleTexture*)gc_alloc(GCT_CLASS, sizeof(RectangleTexture)); o->vtable = &RectangleTexture_vt; RectangleTexture_ctor(o); return o; }');
    this.line('void RectangleTexture_uploadFromBitmapData(void* _this, BitmapData* bitmapData) {');
    this.indent++;
    this.line('RectangleTexture* o = (RectangleTexture*)_this;');
    // Invalidate the cached GPU handle, then upload eagerly -- same contract as
    // Texture_uploadFromBitmapData (the caller may dispose the bitmap right away).
    this.line('if (o->gpu != NULL) { as_s3d_destroy_texture(o->gpu); o->gpu = NULL; }');
    this.line('o->bitmapData = bitmapData; gc_write_barrier((void*)bitmapData);');
    this.line('if (bitmapData != NULL) { o->width = bitmapData->width; o->height = bitmapData->height; }');
    this.line('if (o->ctx != NULL && bitmapData != NULL && bitmapData->pixels != NULL) o->gpu = as_s3d_texture_from_pixels(o->ctx, o->width, o->height, (const uint32_t*)bitmapData->pixels);');
    this.indent--;
    this.line('}');
    this.line('void RectangleTexture_dispose(void* _this) { RectangleTexture* o = (RectangleTexture*)_this; o->bitmapData = NULL; as_s3d_destroy_texture(o->gpu); o->gpu = NULL; o->ctx = NULL; }');
    this.line('');
    this.line('// ---- Context3D: CPU state machine + optional Stage3D GPU backend. ----');
    this.line('void Context3D_ctor(Context3D* o) {');
    this.indent++;
    this.line('Object_ctor((Object*)o);');
    this.line('o->backBufferWidth = 0; o->backBufferHeight = 0; o->antiAlias = 0; o->enableDepthAndStencil = false;');
    this.line('o->blendSource = NULL; o->blendDest = NULL;');
    this.line('o->depthTestOn = false; o->depthCompare = NULL; o->cullMode = NULL;');
    this.line('o->program = NULL; o->indexBuffer = NULL; o->vc = NULL; o->fc = NULL;');
    this.line('o->gpu = NULL;');
    this.line('o->stencilFace = NULL; o->stencilCompare = NULL; o->stencilBothPass = NULL; o->stencilDepthFail = NULL; o->stencilDepthPassStencilFail = NULL; o->stencilRefValue = 0;');
    this.line('o->scissorOn = false; o->scissorX = 0.0; o->scissorY = 0.0; o->scissorW = 0.0; o->scissorH = 0.0;');
    this.line('o->maxBackBufferWidth = 16384; o->maxBackBufferHeight = 16384;');
    this.line('o->clearR = 0.0; o->clearG = 0.0; o->clearB = 0.0; o->clearA = 1.0;');
    for (let i = 0; i < 8; i++) this.line(`o->vb${i} = NULL; o->vbOff${i} = 0; o->vbFmt${i} = NULL; o->tex${i} = NULL;`);
    this.indent--;
    this.line('}');
    this.line('Context3D* Context3D_new(void) { Context3D* o = (Context3D*)gc_alloc(GCT_CLASS, sizeof(Context3D)); o->vtable = &Context3D_vt; Context3D_ctor(o); return o; }');
    this.line('void Context3D_configureBackBuffer(void* _this, unsigned int width, unsigned int height, unsigned int antiAlias, bool enableDepthAndStencil, bool wantsBestResolution, bool wantsBestResolutionOnBrowserZoom) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('(void)wantsBestResolutionOnBrowserZoom;');
    // AIR's wantsBestResolution asks for a back buffer at the display's native
    // resolution: the runtime allocates width*devicePixelRatio by
    // height*devicePixelRatio and reports that as backBufferWidth/Height
    // (verified against adl: configureBackBuffer(640,1048,...,true) on a 2x
    // display gives backBufferWidth=1280/backBufferHeight=2096). Starling relies
    // on exactly this: it passes contentScaleFactor != 1.0 as wantsBestResolution
    // and then sets its projection, text textureScale and painter scale factor
    // from that same factor (Starling.Painter.configureBackBuffer). Ignoring the
    // flag left the render target at 1x while Starling laid everything out for
    // 2x — the scene was rasterized at half resolution and then upscaled by the
    // compositor, i.e. visibly blurry next to adl.
    this.line('double bbScale = 1.0;');
    this.line('if (wantsBestResolution && ASC_win_scale > 1.0) bbScale = ASC_win_scale;');
    this.line('int bbw = (int)((double)width * bbScale);');
    this.line('int bbh = (int)((double)height * bbScale);');
    this.line('if (bbw < 1) bbw = 1; if (bbh < 1) bbh = 1;');
    // backBufferWidth/Height mirror AIR: the size of the allocated buffer (device
    // pixels), not the requested size. drawToBitmapData/maxBackBuffer checks see
    // the real buffer size because of this.
    this.line('o->backBufferWidth = bbw; o->backBufferHeight = bbh; o->antiAlias = (int)antiAlias; o->enableDepthAndStencil = enableDepthAndStencil;');
    // The compositor needs the logical (stage-unit) size to place the target in
    // the display list — see ASC_stage3d_lw/lh.
    this.line('ASC_stage3d_lw = (int)width; ASC_stage3d_lh = (int)height;');
    // Lazily create the offscreen GPU context on first configureBackBuffer, or
    // resize it on a later call (window resize). Pure-C builds: gpu stays NULL.
    this.line('if (o->gpu == NULL) o->gpu = as_s3d_create(bbw, bbh);');
    this.line('else as_s3d_resize(o->gpu, bbw, bbh);');
    this.indent--;
    this.line('}');
    this.line('void Context3D_clear(void* _this, double red, double green, double blue, double alpha, double depth, unsigned int stencil, unsigned int mask) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('o->clearR = red; o->clearG = green; o->clearB = blue; o->clearA = alpha;');
    // The mask bits select which attachments the next draw clears
    // (COLOR=1/DEPTH=2/STENCIL=4 — AIR's Context3DClearMask, verified with adl).
    // Starling relies on this: it clears once per frame, and the stencil must
    // survive the following masked draws to hold the mask shape. The depth and
    // stencil VALUES matter too — Starling clears the stencil to 127
    // (Painter.DEFAULT_STENCIL_VALUE), which its mask passes compare against.
    this.line('as_s3d_clear(o->gpu, (float)red, (float)green, (float)blue, (float)alpha, (float)depth, stencil, (int)(mask & 7u));');
    this.indent--;
    this.line('}');
    this.line('void Context3D_present(void* _this) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('if (o->gpu == NULL) return;');
    // present() = "the frame is done, show it". On the GPU paths (Metal native,
    // WebGL2 web) expose the offscreen render target's backend texture for a
    // direct GPU→GPU composite (no CPU readback, no CPU→GPU re-upload — the
    // latter leaked a blit command buffer per frame on Metal). On the CPU raster
    // path, read it back into the global BGRA8 buffer that ASC_window_render
    // composites behind the 2D display list.
    this.line('int w = as_s3d_width(o->gpu), h = as_s3d_height(o->gpu);');
    this.line('if (w <= 0 || h <= 0) return;');
    this.line('#if defined(ASC_RENDER_METAL) || defined(ASC_RENDER_GPU)');
    this.line('ASC_stage3d_tex = as_s3d_get_render_target(o->gpu);');
    this.line('ASC_stage3d_w = w; ASC_stage3d_h = h;');
    this.line('#else');
    this.line('if (ASC_stage3d_pixels == NULL || ASC_stage3d_w != w || ASC_stage3d_h != h) {');
    this.indent++;
    this.line('if (ASC_stage3d_pixels != NULL) free(ASC_stage3d_pixels);');
    this.line('ASC_stage3d_pixels = (uint8_t*)malloc((size_t)w * (size_t)h * 4);');
    this.line('ASC_stage3d_w = w; ASC_stage3d_h = h;');
    this.indent--;
    this.line('}');
    this.line('as_s3d_readback_render(o->gpu, ASC_stage3d_pixels);');
    this.line('#endif');
    this.line('ASC_stage3d_ready = 1;');
    this.indent--;
    this.line('}');
    // Per-frame vertex de-interleave scratch (Context3D_submit). A cached buffer
    // instead of malloc/free per bound stream per frame: the *transient* peak is what
    // the allocator keeps as high-water RSS in a long-running app (measured: live malloc
    // stays flat at ~17 MB while the Starling scene cycle's RSS climbs; see gc.md §6.14).
    // Reuse is safe because as_s3d_upload_vertex copies synchronously -- the pointer
    // never outlives the call.
    this.line('static double* s3d_submit_scratch = NULL;');
    this.line('static size_t s3d_submit_scratch_cap = 0;');
    this.line('static double* s3d_submit_scratch_get(size_t need) {');
    this.line('  if (need > s3d_submit_scratch_cap) {');
    this.line('    free(s3d_submit_scratch);');
    this.line('    s3d_submit_scratch = (double*)malloc(need * sizeof(double));');
    this.line('    s3d_submit_scratch_cap = s3d_submit_scratch != NULL ? need : 0;');
    this.line('  }');
    this.line('  return s3d_submit_scratch;');
    this.line('}');
    // Context3D_submit: the single GPU sync point shared by drawTriangles and
    // drawTrianglesInstanced. Uploads bound streams/constants/textures, compiles
    // the Program3D (AGAL bytecode -> MSL -> MTLRenderPipelineState) on first
    // use, then submits one clear+draw+commit with the given instance count.
    this.line('void Context3D_submit(Context3D* o, IndexBuffer3D* indexBuffer, int numTriangles, int numInstances) {');
    this.indent++;
    this.line('if (o->gpu == NULL) { (void)numTriangles; (void)numInstances; (void)indexBuffer; return; }');
    // Upload vertex streams va0..va7 from the bound VertexBuffer3D. Starling
    // packs position/texCoords/color into ONE interleaved buffer (stride =
    // data32PerVertex) and binds that same buffer at several attribute indices
    // with different offsets/formats via setVertexBufferAt. s3d_upload_vertex
    // wants a contiguous non-interleaved component array, so de-interleave each
    // attribute here: stride = data32PerVertex, base offset = vbOff{i} (32-bit
    // units), component count derived from the format string.
    // Color is "bytes4": 4 big-endian RGBA bytes stored in one 32-bit word; each
    // byte is normalized to [0,1] so the float4 register matches Stage3D's
    // bytes4 semantics (and Starling's premultiplied-alpha pipeline).
    for (let i = 0; i < 8; i++) {
      this.line(`if (o->vb${i} != NULL && o->vb${i}->raw != NULL) {`);
      this.indent++;
      this.line(`int stride = o->vb${i}->data32PerVertex;`);
      this.line(`int off = o->vbOff${i};`);
      this.line(`int sv = o->vb${i}->startVertex;`);
      this.line(`int nv = o->vb${i}->numVertices;`);
      this.line(`const char* fmt = o->vbFmt${i};`);
      this.line(`int comp = 4; if (fmt != NULL) { if (strcmp(fmt, "float1") == 0) comp = 1; else if (strcmp(fmt, "float2") == 0) comp = 2; else if (strcmp(fmt, "float3") == 0) comp = 3; }`);
      this.line(`int isBytes4 = (fmt != NULL && strcmp(fmt, "bytes4") == 0);`);
      this.line(`double* tmp = s3d_submit_scratch_get((size_t)nv * (size_t)comp);`);
      this.line(`for (int v = 0; v < nv; v++) {`);
      this.indent++;
      this.line(`if (isBytes4) {`);
      this.indent++;
      // bytes4 packs four normalized bytes in ONE 32-bit word -- read the word
      // as it was uploaded, no double round trip.
      this.line(`unsigned w = o->vb${i}->raw->data[(size_t)(sv + v) * stride + off];`);
      this.line(`tmp[v * 4 + 0] = (double)(w & 0xFF) / 255.0;`);
      this.line(`tmp[v * 4 + 1] = (double)((w >> 8) & 0xFF) / 255.0;`);
      this.line(`tmp[v * 4 + 2] = (double)((w >> 16) & 0xFF) / 255.0;`);
      this.line(`tmp[v * 4 + 3] = (double)((w >> 24) & 0xFF) / 255.0;`);
      this.indent--;
      this.line(`} else {`);
      this.indent++;
      // floatN: the stored word is the float32 the GPU receives, so widen it
      // without ever having kept a double of it alive in the heap.
      this.line(`for (int c = 0; c < comp; c++) {`);
      this.indent++;
      this.line(`float f; memcpy(&f, &o->vb${i}->raw->data[(size_t)(sv + v) * stride + off + c], 4);`);
      this.line(`tmp[v * comp + c] = (double)f;`);
      this.indent--;
      this.line(`}`);
      this.indent--;
      this.line(`}`);
      this.indent--;
      this.line(`}`);
      this.line(`as_s3d_upload_vertex(o->gpu, ${i}, tmp, nv, comp);`);
      this.indent--;
      this.line('}');
    }
    // Upload the index buffer (Vector.<uint> is uint32).
    this.line('if (indexBuffer != NULL && indexBuffer->data != NULL) as_s3d_upload_index(o->gpu, indexBuffer->data->data + indexBuffer->startIndex, indexBuffer->numIndices);');
    // Upload vertex/fragment constants (double -> float4 arrays).
    this.line('if (o->vc != NULL && o->vc->length > 0) as_s3d_upload_constants(o->gpu, 0, o->vc->data, o->vc->length);');
    this.line('if (o->fc != NULL && o->fc->length > 0) as_s3d_upload_constants(o->gpu, 1, o->fc->data, o->fc->length);');
    // Upload textures fs0..fs7 from their source BitmapData (ARGB pixels), or
    // bind a render-to-texture MTLTexture directly (optimizeForRenderToTexture).
    for (let i = 0; i < 8; i++) {
      this.line(`if (o->tex${i} != NULL) {`);
      this.indent++;
      this.line(`if (o->tex${i}->gpu != NULL) as_s3d_bind_texture(o->gpu, ${i}, o->tex${i}->gpu);`);
      this.line(`else if (o->tex${i}->bitmapData != NULL && o->tex${i}->bitmapData->pixels != NULL) o->tex${i}->gpu = as_s3d_upload_texture(o->gpu, ${i}, o->tex${i}->width, o->tex${i}->height, (const uint32_t*)o->tex${i}->bitmapData->pixels);`);
      this.indent--;
      this.line('}');
    }
    // Propagate blend factors to the GPU context BEFORE the lazy pipeline
    // compile below — Metal bakes the blend state into MTLRenderPipelineState,
    // so the factors set via setBlendFactors must be visible when s3d_compile
    // builds the pipeline (the demo sets them right before drawTriangles).
    this.line('as_s3d_set_blend(o->gpu, o->blendSource, o->blendDest);');
    // Compile the program lazily (keyed on the Program3D pointer; the demo keeps
    // one program per batch with a stable vertex layout).
    this.line('if (o->program != NULL && o->program != o->gpuProgram) {');
    this.indent++;
    this.line('ByteArray* vp = o->program->vertexProgram;');
    this.line('ByteArray* fp = o->program->fragmentProgram;');
    this.line('if (vp != NULL && fp != NULL && vp->data != NULL && fp->data != NULL) {');
    this.indent++;
    this.line('char* vs = as_agal_translate((const unsigned char*)vp->data, vp->length, ASC_AGAL_TARGET);');
    this.line('char* fs = as_agal_translate((const unsigned char*)fp->data, fp->length, ASC_AGAL_TARGET);');
    this.line('if (vs == NULL || fs == NULL) { as_throw(Error_new((char*)as_agal_errmsg, 0)); return; }');
    this.line('char errbuf[512];');
    this.line('if (!as_s3d_compile(o->gpu, vs, fs, errbuf, (int)sizeof(errbuf))) { as_throw(Error_new(errbuf, 0)); return; }');
    this.line('o->gpuProgram = o->program;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('as_s3d_set_instance_count(o->gpu, numInstances);');
    this.line('as_s3d_draw(o->gpu, numTriangles);');
    this.indent--;
    this.line('}');
    this.line('void Context3D_drawTriangles(void* _this, IndexBuffer3D* indexBuffer, int firstIndex, int numTriangles) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('o->indexBuffer = indexBuffer; gc_write_barrier((void*)indexBuffer);');
    this.line('(void)firstIndex;');
    this.line('Context3D_submit(o, indexBuffer, numTriangles, 1);');
    this.indent--;
    this.line('}');
    // drawTrianglesInstanced (AGAL3): same geometry, numInstances copies drawn.
    this.line('void Context3D_drawTrianglesInstanced(void* _this, IndexBuffer3D* indexBuffer, int firstIndex, int numTriangles, int numInstances) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('o->indexBuffer = indexBuffer; gc_write_barrier((void*)indexBuffer);');
    this.line('(void)firstIndex;');
    this.line('Context3D_submit(o, indexBuffer, numTriangles, numInstances);');
    this.indent--;
    this.line('}');
    this.line('void Context3D_setProgram(void* _this, Program3D* program) { Context3D* o = (Context3D*)_this; o->program = program; gc_write_barrier((void*)program); }');
    this.line('void Context3D_setBlendFactors(void* _this, char* sourceFactor, char* destinationFactor) { Context3D* o = (Context3D*)_this; o->blendSource = sourceFactor; o->blendDest = destinationFactor; }');
    this.line('void Context3D_setProgramConstantsFromMatrix(void* _this, char* programType, int firstRegister, Matrix3D* matrix, bool transposedMatrix) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('bool isVertex = strcmp(programType, "vertex") == 0;');
    this.line('as_vector_number* dst = isVertex ? o->vc : o->fc;');
    this.line('if (dst == NULL) { dst = as_vector_number_new(); if (isVertex) { o->vc = dst; } else { o->fc = dst; } gc_write_barrier((void*)dst); }');
    this.line('int base = firstRegister * 4;');
    this.line('if (dst->length < base + 16) as_vector_number_setLength(dst, base + 16);');
    this.line('double* m = matrix->_m;');
    // AIR semantics: rawData is column-major (every 4 elements = a column).
    // m44/dp4 compute dest.c = dot(src1, src2[c]), i.e. vc_c must hold the matrix ROW c
    // (including translation in its 4th component) for the transform to apply translation.
    // So transposedMatrix=true means "copy in transposed order" = put each math row into a register;
    // the default false copies rawData directly (each register = a column).
    this.line('if (transposedMatrix) { for (int row = 0; row < 4; row++) for (int col = 0; col < 4; col++) dst->data[base + row * 4 + col] = m[col * 4 + row]; }');
    this.line('else { for (int i = 0; i < 16; i++) dst->data[base + i] = m[i]; }');
    this.indent--;
    this.line('}');
    this.line('void Context3D_setTextureAt(void* _this, int first, Texture* texture) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('switch (first) {');
    for (let i = 0; i < 8; i++) this.line(`case ${i}: o->tex${i} = texture; break;`);
    this.line('default: break;');
    this.line('}');
    this.line('gc_write_barrier((void*)texture);');
    this.indent--;
    this.line('}');
    // setCubeTextureAt / setRectangleTextureAt record the texture as a CPU
    // reference (the demo does not sample cube/rectangle textures).
    this.line('void Context3D_setCubeTextureAt(void* _this, int first, CubeTexture* texture) { Context3D* o = (Context3D*)_this; (void)o; (void)first; gc_write_barrier((void*)texture); }');
    this.line('void Context3D_setRectangleTextureAt(void* _this, int first, RectangleTexture* texture) { Context3D* o = (Context3D*)_this; (void)o; (void)first; gc_write_barrier((void*)texture); }');
    // setSamplerStateAt(sampler, wrap, filter, mipfilter) — AIR's Context3DWrapMode /
    // Context3DTextureFilter / Context3DMipFilter names. The AGAL->MSL translator
    // emits one shared sampler (`sampler smp [[sampler(0)]]`) for every fragment
    // program, so per-unit state is recorded but the state of the lowest bound
    // texture unit decides the sampler bound at index 0 (see the glue).
    this.line('void Context3D_setSamplerStateAt(void* _this, int sampler, char* wrap, char* filter, char* mipfilter) { Context3D* o = (Context3D*)_this; as_s3d_set_sampler_state(o->gpu, sampler, wrap, filter, mipfilter); }');
    // setProgramConstantsFromVector uploads numRegisters*4 doubles to vc/fc.
    // AIR's signature is `(... data:Vector.<Number>, numRegisters:int = -1)`, where
    // -1 means "take the register count from the vector" (Starling relies on it:
    // BlurFilter/ColorMatrixFilter pass only the data vector). Treating -1 as a
    // literal count multiplies it out to a negative length that clamps to zero,
    // silently uploading NO constants -- a blur whose fc0 weights stay 0 draws
    // pure black (the filtered image vanished).
    this.line('void Context3D_setProgramConstantsFromVector(void* _this, char* programType, int firstRegister, as_vector_number* data, int numRegisters) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('bool isVertex = strcmp(programType, "vertex") == 0;');
    this.line('as_vector_number* dst = isVertex ? o->vc : o->fc;');
    this.line('if (dst == NULL) { dst = as_vector_number_new(); if (isVertex) { o->vc = dst; } else { o->fc = dst; } gc_write_barrier((void*)dst); }');
    this.line('int base = firstRegister * 4;');
    this.line('int n = (numRegisters < 0) ? (((int)(data != NULL ? data->length : 0)) & ~3) : numRegisters * 4;');
    this.line('if (n < 0) n = 0;');
    this.line('if (data == NULL) n = 0;');
    this.line('if (dst->length < base + n) as_vector_number_setLength(dst, base + n);');
    this.line('for (int i = 0; i < n; i++) dst->data[base + i] = (i < data->length) ? data->data[i] : 0.0;');
    this.indent--;
    this.line('}');
    this.line('void Context3D_setVertexBufferAt(void* _this, int index, VertexBuffer3D* buffer, int bufferOffset, char* format) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('switch (index) {');
    for (let i = 0; i < 8; i++) this.line(`case ${i}: o->vb${i} = buffer; o->vbOff${i} = bufferOffset; o->vbFmt${i} = format; break;`);
    this.line('default: break;');
    this.line('}');
    this.line('gc_write_barrier((void*)buffer);');
    this.indent--;
    this.line('}');
    this.line('VertexBuffer3D* Context3D_createVertexBuffer(void* _this, int numVertices, int data32PerVertex, char* bufferUsage) {');
    this.indent++;
    this.line('(void)_this; (void)bufferUsage;');
    this.line('VertexBuffer3D* b = VertexBuffer3D_new();');
    this.line('b->numVertices = numVertices; b->data32PerVertex = data32PerVertex;');
    this.line('return b;');
    this.indent--;
    this.line('}');
    this.line('IndexBuffer3D* Context3D_createIndexBuffer(void* _this, int numIndices, char* bufferUsage) {');
    this.indent++;
    this.line('(void)_this; (void)bufferUsage;');
    this.line('IndexBuffer3D* b = IndexBuffer3D_new();');
    this.line('b->numIndices = numIndices;');
    this.line('return b;');
    this.indent--;
    this.line('}');
    this.line('Program3D* Context3D_createProgram(void* _this) { (void)_this; return Program3D_new(); }');
    this.line('Texture* Context3D_createTexture(void* _this, int width, int height, char* format, bool optimizeForRenderToTexture) {');
    this.indent++;
    this.line('Context3D* ctx = (Context3D*)_this;');
    this.line('Texture* t = Texture_new();');
    this.line('t->width = width; t->height = height; t->format = format;');
    // optimizeForRenderToTexture=true allocates a render-target MTLTexture up
    // front (setRenderToTexture binds it); false leaves gpu=NULL (sampler-only,
    // uploaded later via uploadFromBitmapData).
    this.line('if (optimizeForRenderToTexture) t->gpu = as_s3d_create_render_texture(ctx->gpu, width, height);');
    // Hand the texture its context so uploadFromBitmapData can upload eagerly.
    this.line('t->ctx = ctx->gpu;');
    this.line('return t;');
    this.indent--;
    this.line('}');
    this.line('CubeTexture* Context3D_createCubeTexture(void* _this, int size, char* format, bool optimizeForRenderToTexture) {');
    this.indent++;
    this.line('(void)_this; (void)optimizeForRenderToTexture;');
    this.line('CubeTexture* t = CubeTexture_new();');
    this.line('t->width = size; t->height = size; t->format = format;');
    this.line('return t;');
    this.indent--;
    this.line('}');
    this.line('RectangleTexture* Context3D_createRectangleTexture(void* _this, int width, int height, char* format, bool optimizeForRenderToTexture) {');
    this.indent++;
    this.line('Context3D* ctx = (Context3D*)_this;');
    // Same contract as createTexture: optimizeForRenderToTexture=true allocates a
    // render-target MTLTexture up front (Starling's FragmentFilter renders its
    // offscreen passes into such a texture through setRenderToTexture); false
    // leaves gpu=NULL for a later uploadFromBitmapData.
    this.line('RectangleTexture* t = RectangleTexture_new();');
    this.line('t->width = width; t->height = height; t->format = format;');
    this.line('if (optimizeForRenderToTexture) t->gpu = as_s3d_create_render_texture(ctx->gpu, width, height);');
    this.line('t->ctx = ctx->gpu;');
    this.line('return t;');
    this.indent--;
    this.line('}');
    // VideoTexture: a video-backed texture. No video decoder in this subset; the
    // object exists so Starling's ConcreteVideoTexture can hold/attach a base,
    // so this allocates an empty VideoTexture (videoWidth/videoHeight default 0).
    this.line('VideoTexture* Context3D_createVideoTexture(void* _this) { (void)_this; return VideoTexture_new(); }');
    this.line('void Context3D_setDepthTest(void* _this, bool depthMask, char* passCompareMode) { Context3D* o = (Context3D*)_this; o->depthTestOn = depthMask; o->depthCompare = passCompareMode; as_s3d_set_depth(o->gpu, depthMask ? 1 : 0, passCompareMode); }');
    // Context3DTriangleFace -> MTLCullMode. AIR's naming: "back"/"front"/"none"/
    // "frontAndBack" (culling frontAndBack would drop everything, which is what
    // AIR does too, so it maps to Front-and-Back culling respectively = cull all).
    this.line('void Context3D_setCulling(void* _this, char* triangleFaceToCull) { Context3D* o = (Context3D*)_this; o->cullMode = triangleFaceToCull; as_s3d_set_cull(o->gpu, triangleFaceToCull); }');
    // setStencilActions records the stencil front/back compare mode + three actions
    // (both-pass / depth-fail / depth-pass-stencil-fail) and forwards them to the
    // glue, which turns them into a cached MTLDepthStencilState. Starling's
    // Paintter.drawMask/eraseMask drive masking entirely through this call plus
    // setStencilReferenceValue: the mask shape is rendered with INCREMENT_SATURATE
    // (or DECREMENT for an inverted mask) and the masked content is then drawn with
    // compareMode EQUAL against the incremented reference value.
    this.line('void Context3D_setStencilActions(void* _this, char* triangleFace, char* compareMode, char* actionOnBothPass, char* actionOnDepthFail, char* actionOnDepthPassStencilFail) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('o->stencilFace = triangleFace; o->stencilCompare = compareMode;');
    this.line('o->stencilBothPass = actionOnBothPass; o->stencilDepthFail = actionOnDepthFail; o->stencilDepthPassStencilFail = actionOnDepthPassStencilFail;');
    this.line('as_s3d_set_stencil(o->gpu, triangleFace, compareMode, actionOnBothPass, actionOnDepthFail, actionOnDepthPassStencilFail);');
    this.indent--;
    this.line('}');
    // setScissorRectangle(null) disables scissoring. The rectangle is in stage
    // (logical) units; the render target is at device resolution, so scale by
    // backBuffer/logical before handing it to Metal (MTLScissorRect is also
    // top-left origin, same as Stage3D, so no flip is needed).
    this.line('void Context3D_setScissorRectangle(void* _this, Rectangle* rectangle) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('double sc = (ASC_stage3d_lw > 0) ? (double)o->backBufferWidth / (double)ASC_stage3d_lw : 1.0;');
    this.line('if (rectangle == NULL) { o->scissorOn = false; o->scissorX = 0.0; o->scissorY = 0.0; o->scissorW = 0.0; o->scissorH = 0.0; as_s3d_set_scissor(o->gpu, 0, 0, 0, 0, 0); }');
    this.line('else { o->scissorOn = true; o->scissorX = rectangle->x; o->scissorY = rectangle->y; o->scissorW = rectangle->width; o->scissorH = rectangle->height;');
    this.line('  as_s3d_set_scissor(o->gpu, 1, (int)(rectangle->x * sc), (int)(rectangle->y * sc), (int)(rectangle->width * sc), (int)(rectangle->height * sc)); }');
    this.indent--;
    this.line('}');
    // setStencilReferenceValue stores the 8-bit reference plus the read/write masks
    // (all three go to the GPU: Starling increments/decrements the reference while
    // drawing/erasing a mask, then compares the content against it with EQUAL).
    this.line('void Context3D_setStencilReferenceValue(void* _this, unsigned int referenceValue, unsigned int readMask, unsigned int writeMask) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('o->stencilRefValue = (int)(referenceValue & 0xFFu);');
    this.line('as_s3d_set_stencil_ref(o->gpu, referenceValue, readMask, writeMask);');
    this.indent--;
    this.line('}');
    this.line('void Context3D_dispose(void* _this, bool recreate) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('(void)recreate;');
    this.line('o->program = NULL; o->indexBuffer = NULL; o->vc = NULL; o->fc = NULL;');
    for (let i = 0; i < 8; i++) this.line(`o->vb${i} = NULL; o->tex${i} = NULL;`);
    this.line('o->gpuProgram = NULL;');
    this.line('as_s3d_destroy(o->gpu); o->gpu = NULL;');
    this.indent--;
    this.line('}');
    this.line('void Context3D_drawToBitmapData(void* _this, BitmapData* destination) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    // Read the last committed frame (BGRA row bytes) and convert to BitmapData
    // ARGB pixels. Pure-C: destination is cleared to black.
    this.line('if (destination == NULL) return;');
    this.line('if (o->gpu != NULL && destination->pixels != NULL) {');
    this.indent++;
    this.line('uint8_t* rgba = (uint8_t*)malloc((size_t)o->backBufferWidth * o->backBufferHeight * 4);');
    this.line('if (rgba != NULL) {');
    this.indent++;
    this.line('if (as_s3d_readback_render(o->gpu, rgba)) {');
    this.indent++;
    this.line('for (int y = 0; y < o->backBufferHeight; y++) {');
    this.indent++;
    this.line('for (int x = 0; x < o->backBufferWidth; x++) {');
    this.indent++;
    this.line('int idx = y * o->backBufferWidth + x;');
    this.line('uint8_t b = rgba[idx * 4 + 0];');
    this.line('uint8_t g = rgba[idx * 4 + 1];');
    this.line('uint8_t r = rgba[idx * 4 + 2];');
    this.line('uint8_t a = rgba[idx * 4 + 3];');
    this.line('((uint32_t*)destination->pixels)[idx] = ((uint32_t)a << 24) | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('free(rgba);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('memset(destination->pixels, 0, (size_t)destination->width * destination->height * 4);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // setRenderToTexture redirects the offscreen target to an in-heap texture
    // (render-to-texture). drawTriangles then renders into that MTLTexture; the
    // texture can later be sampled via setTextureAt (s3d_bind_texture) or read
    // back with drawToBitmapData (s3d_readback_render).
    this.line('void Context3D_setRenderToTexture(void* _this, Texture* texture, bool enableDepthAndStencil, int antiAlias, int surfaceSelector) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('(void)antiAlias; (void)surfaceSelector;');
    // enableDepthAndStencil asks for a depth/stencil surface matching the render
    // target (Metal rejects a pass whose depth attachment has a different size).
    this.line('as_s3d_set_render_target(o->gpu, (texture != NULL) ? texture->gpu : NULL, enableDepthAndStencil ? 1 : 0);');
    this.indent--;
    this.line('}');
    this.line('void Context3D_setRenderToBackBuffer(void* _this) {');
    this.indent++;
    this.line('as_s3d_set_render_target(((Context3D*)_this)->gpu, NULL, 0);');
    this.indent--;
    this.line('}');
    // driverInfo reflects the compile-time backend, not the runtime gpu pointer:
    // `gpu` is created lazily in configureBackBuffer (after CONTEXT3D_CREATE), so
    // reading it here would report "Software" at trace time and make Starling's
    // profile-retry loop reject every profile as a software fallback.
    //
    // The probe must be ASC_RENDER_STAGE3D, NOT ASC_RENDER_METAL: the two are
    // independent backends. ASC_RENDER_METAL only means the *window* composes on
    // the GPU via CAMetalLayer (metal_glue.mm); it does not wire Context3D to a
    // device. Context3D itself renders on the GPU iff stage3d_glue.mm is linked,
    // which is exactly ASC_RENDER_STAGE3D — that macro is what turns the as_s3d_*
    // wrappers from no-ops into real Metal calls. Using ASC_RENDER_METAL reported
    // "Software" for a Stage3D-only build (stage82/83 build.json define only
    // ASC_RENDER_STAGE3D) and would conversely report "Metal" for an air-native
    // build whose Context3D is a pure-C state machine.
    this.line('char* Context3D_get_driverInfo(void* _this) { (void)_this;');
    this.indent++;
    this.line('#if defined(ASC_S3D_GLSL)');
    // Web backend: stage3d_webgl.cc drives the WebGL2 pipeline.
    this.line('return (char*)"WebGL2 (Stage3D)";');
    this.line('#elif defined(ASC_RENDER_STAGE3D)');
    this.line('return (char*)"Metal (Stage3D)";');
    this.line('#else');
    this.line('return (char*)"Software (state machine)";');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('char* Context3D_get_profile(void* _this) { (void)_this; return (char*)"baseline"; }');
    // totalGPUMemory: AIR reports how much GPU memory this context holds. We do not
    // account for every buffer, so report the one allocation we always know — the
    // back buffer (BGRA8 + 4 bytes/pixel) — plus the depth/stencil surface when the
    // build has one. Approximate, but the API is used for display only (Starling's
    // stats box) and must be present: `"totalGPUMemory" in context` gates a row.
    this.line('double Context3D_get_totalGPUMemory(void* _this) {');
    this.indent++;
    this.line('Context3D* o = (Context3D*)_this;');
    this.line('double bytes = (double)o->backBufferWidth * (double)o->backBufferHeight * 4.0;');
    this.line('#if defined(ASC_RENDER_DEPTH_STENCIL)');
    this.line('bytes += (double)o->backBufferWidth * (double)o->backBufferHeight * 8.0;');
    this.line('#endif');
    this.line('return bytes;');
    this.indent--;
    this.line('}');
    // maxBackBufferWidth/Height: the platform back-buffer size limit (16384 for
    // AIR 64-bit desktop). configureBackBuffer clamps to this upper bound.
    this.line('int Context3D_get_maxBackBufferWidth(void* _this) { return ((Context3D*)_this)->maxBackBufferWidth; }');
    this.line('int Context3D_get_maxBackBufferHeight(void* _this) { return ((Context3D*)_this)->maxBackBufferHeight; }');
    this.line('void Context3D_set_enableErrorChecking(void* _this, bool value) { (void)_this; (void)value; }');
    this.line('');
    this.line('// ---- Stage3D: per-display slot; lazily creates a Context3D on request. ----');
    this.line('void Stage3D_ctor(Stage3D* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->x = 0.0; o->y = 0.0; o->visible = true; o->context3d = NULL; o->renderMode = NULL;');
    this.indent--;
    this.line('}');
    this.line('Stage3D* Stage3D_new(void) { Stage3D* o = (Stage3D*)gc_alloc(GCT_CLASS, sizeof(Stage3D)); o->vtable = &Stage3D_vt; Stage3D_ctor(o); return o; }');
    // AIR creates the Context3D asynchronously: requestContext3D() returns
    // immediately and dispatches context3DCreate on a later frame. Firing it
    // synchronously would dispatch CONTEXT3D_CREATE -> ROOT_CREATED while the
    // Starling constructor is still on the stack, so app code that registers its
    // ROOT_CREATED listener AFTER `new Starling(...)` would miss it (white screen).
    // We therefore create the context object eagerly (so stage3D.context3D is
    // readable) but defer the event to the next frame tick.
    this.line('static as_value Stage3D__contextReady(void* env, as_value* args, int argc) {');
    this.indent++;
    this.line('(void)args; (void)argc;');
    this.line('EventDispatcher_dispatchEvent((EventDispatcher*)env, Event_new((char*)"context3DCreate", false, false));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('void Stage3D_requestContext3D(void* _this, char* renderMode) {');
    this.indent++;
    this.line('Stage3D* o = (Stage3D*)_this;');
    this.line('o->renderMode = renderMode;');
    this.line('if (o->context3d == NULL) { o->context3d = Context3D_new(); gc_write_barrier((void*)o->context3d); }');
    this.line('as_set_timeout(as_fn_make(Stage3D__contextReady, (void*)o, 0), 0.0);');
    this.indent--;
    this.line('}');
    this.line('Context3D* Stage3D_get_context3D(void* _this) { return ((Stage3D*)_this)->context3d; }');
    this.line('void Stage3D_set_x(void* _this, double value) { ((Stage3D*)_this)->x = value; }');
    this.line('void Stage3D_set_y(void* _this, double value) { ((Stage3D*)_this)->y = value; }');
    this.line('void Stage3D_set_visible(void* _this, bool value) { ((Stage3D*)_this)->visible = value; }');
    this.line('as_vector_Stage3D* Stage_get_stage3Ds(void* _this) {');
    this.indent++;
    this.line('Stage* s = (Stage*)_this;');
    this.line('if (s->stage3ds == NULL) { s->stage3ds = as_vector_Stage3D_new(); gc_write_barrier((void*)s->stage3ds); as_vector_Stage3D_push(s->stage3ds, Stage3D_new()); }');
    this.line('return s->stage3ds;');
    this.indent--;
    this.line('}');
    this.line('');
    // Stage.dispatchWheel(x, y, delta): native-backend hook (like dispatchMouse) that
    // the SDL2 event loop calls for every wheel notch. Emitted here — after the
    // as_tf_* helpers — because C requires a declaration before use.
    //
    // Two things happen, in AIR's order:
    //  1. the TextField under the pointer scrolls itself (no listener needed) —
    //     measured against adl, one delta unit moves exactly one line and scrollV
    //     *decreases* as the wheel turns up, clamped to [1, maxScrollV];
    //  2. a bubbling MouseEvent.MOUSE_WHEEL is dispatched so app code can react.
    this.line('void Stage_dispatchWheel(void* _this, double x, double y, double delta) {');
    this.indent++;
    this.line('void* target = as_pick_hit(_this, x, y);');
    this.line('if (target == NULL) return;');
    this.line('DisplayObject* o = (DisplayObject*)target;');
    this.line('if (as_is(target, &TextField_vt)) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)target;');
    this.line('int maxs = as_tf_line_count(tf) - as_tf_visible_lines(tf) + 1;');
    this.line('if (maxs < 1) maxs = 1;');
    this.line('int nv = tf->scrollV - (int)delta;');
    this.line('if (nv < 1) nv = 1;');
    this.line('if (nv > maxs) nv = maxs;');
    this.line('tf->scrollV = nv;');
    this.indent--;
    this.line('}');
    this.line('MouseEvent* evt = MouseEvent_new((char*)"mouseWheel", true, false, x - o->x, y - o->y, NULL, false, false, false, false, delta);');
    this.line('EventDispatcher_dispatchEvent(target, (Event*)evt);');
    this.indent--;
    this.line('}');
    // Stage.dispatchFrame(): broadcast ENTER_FRAME once per rendered frame. AIR
    // fires ENTER_FRAME as a broadcast (not a bubbling) event: every object that
    // registered an "enterFrame" listener gets its own target-phase dispatch,
    // including objects OFF the display list (e.g. GreenSock's private static
    // Shape that drives tween updates). The global as_ef_* registry (populated by
    // addEventListener) is iterated for exactly this reason instead of walking the
    // display list. The event is reused and reset between dispatches so a 60 Hz
    // loop allocates nothing.
    this.line('void Stage_dispatchFrame(void* _this) {');
    this.indent++;
    this.line('(void)_this;');
    // Frame-boundary GC safe point: all user frame callbacks have returned, so
    // only permanent roots (static fields, stage, event registry, timers) are
    // live. Each frame advances the incremental mark/sweep by a fixed budget
    // (GC-4) so the pause stays bounded instead of growing with the heap.
    // The two ASC_FRAME_STATS probes time the slice and the whole frame so a
    // stutter can be attributed to the collector or to the allocator.
    this.line('const double asc_frame_t0 = as_now_ms();');
    // gc_step() also marks the collector frame-driven, which is what retires
    // gc_alloc's non-GUI allocation trigger (see gc_frame_driven in the preamble).
    this.line('gc_step();');
    this.line('as_dbg_frame(as_now_ms() - asc_frame_t0);');
    // Collect finished asynchronous IO/decode jobs before anything else this
    // frame: their finish thunks dispatch PROGRESS/COMPLETE, which user code
    // (AssetManager chains) reacts to by queueing the next load. Doing it first
    // means a job that completed while the last frame was rendering is visible
    // to listeners in this frame, matching AIR's "as soon as possible" delivery.
    this.line('as_async_tick();');
    // Fire due setTimeout/clearTimeout timers first (AIR drives timers on the
    // same frame clock as ENTER_FRAME), then advance playing MovieClips, then
    // broadcast the enterFrame event.
    this.line('as_timer_tick();');
    this.line('as_mc_tick();');
    this.line('static Event* evt = NULL;');
    this.line('if (evt == NULL) { evt = Event_new((char*)"enterFrame", false, false); gc_root_register((void**)&evt); }');
    this.line('for (int i = 0; i < as_ef_count; i++) {');
    this.indent++;
    this.line('evt->target = NULL; evt->propStopped = false; evt->immStopped = false;');
    this.line('EventDispatcher_dispatchEvent(as_ef_objs[i], evt);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('void TextField_appendText(void* _this, char* s) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (s == NULL) return;');
    this.line('tf->text = (tf->text == NULL) ? as_str_concat("", s) : as_str_concat(tf->text, s);');
    this.indent--;
    this.line('}');
    // Recursive render: depth order = low first (children[0..n-1]); the type-
    // specific draw is dispatched on the runtime class name carried by the vtable.
    // Transforms are applied inside a save/restore pair so sibling subtrees stay
    // independent; a partial alpha uses saveLayerAlpha so it multiplies the subtree.
    this.line('static void as_render_object_content(void* canvas, DisplayObject* o);');
    this.line('static void as_render_filtered(void* canvas, DisplayObject* o, as_array* filters, int idx);');
    this.line('static void as_filters_expand(as_array* filters, double* l, double* t, double* r, double* b);');
    this.line('');
    // Transform a local-coordinate AABB by a DisplayObject's full transform —
    // user Matrix first, then scale, rotate, translate — matching the order
    // as_render_object applies to the Skia canvas (concat(matrix) AFTER
    // scale/rotate/translate). Returns the enclosing AABB of the 4 transformed
    // corners so rotated/scaled/skewed children (via either the built-in fields
    // or transform.matrix) are never clipped by a bake surface or filter
    // saveLayer. The old code ignored transform.matrix entirely, which clipped
    // the GeometryDemos rotate(30deg)/scale/skew boxes.
    this.line('static void as_bounds_xform(double* l, double* t, double* r, double* b, double x, double y, double rotation, double sx, double sy, Matrix* m) {');
    this.indent++;
    this.line('double a = 1.0, mb = 0.0, c = 0.0, d = 1.0, tx = 0.0, ty = 0.0;');
    this.line('if (m != NULL) { a = m->a; mb = m->b; c = m->c; d = m->d; tx = m->tx; ty = m->ty; }');
    this.line('double rad = rotation * 3.14159265358979323846 / 180.0;');
    this.line('double cs = cos(rad), sn = sin(rad);');
    this.line('double px[4] = { *l, *r, *l, *r };');
    this.line('double py[4] = { *t, *t, *b, *b };');
    this.line('double minx = 1e300, miny = 1e300, maxx = -1e300, maxy = -1e300;');
    this.line('for (int i = 0; i < 4; i++) {');
    this.indent++;
    this.line('double qx = px[i], qy = py[i];');
    this.line('double mx = a * qx + c * qy + tx;');
    this.line('double my = mb * qx + d * qy + ty;');
    this.line('mx *= sx; my *= sy;');
    this.line('double rx = mx * cs - my * sn;');
    this.line('double ry = mx * sn + my * cs;');
    this.line('rx += x; ry += y;');
    this.line('if (rx < minx) minx = rx; if (rx > maxx) maxx = rx;');
    this.line('if (ry < miny) miny = ry; if (ry > maxy) maxy = ry;');
    this.indent--;
    this.line('}');
    this.line('*l = minx; *t = miny; *r = maxx; *b = maxy;');
    this.indent--;
    this.line('}');
    this.line('');
    // Tight local-coordinate bounds for filter saveLayers: the filtered subtree's
    // backing store is limited to the object's own extent (+ blur spread) instead
    // of the whole canvas clip, which was the per-frame hot spot (20 fps). Shape
    // uses the cached SkPath bounds; Bitmap/TextField use their declared size.
    // Containers fall back to unbounded (as_render_bounds returns 0).
    this.line('static int as_render_bounds(DisplayObject* o, double* l, double* t, double* r, double* b) {');
    this.indent++;
    this.line('if (as_is(o, &Shape_vt)) {');
    this.indent++;
    this.line('Graphics* g = ((Shape*)o)->graphics;');
    this.line('if (g == NULL || g->path == NULL) return 0;');
    this.line('return as_skia_path_get_bounds(g->path, l, t, r, b);');
    this.indent--;
    this.line('}');
    this.line('if (as_is(o, &Bitmap_vt)) {');
    this.indent++;
    this.line('BitmapData* bd = ((Bitmap*)o)->bitmapData;');
    this.line('if (bd == NULL) return 0;');
    this.line('*l = 0.0; *t = 0.0; *r = (double)bd->width; *b = (double)bd->height;');
    this.line('return 1;');
    this.indent--;
    this.line('}');
    this.line('if (as_is(o, &TextField_vt)) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)o;');
    this.line('*l = 0.0; *t = 0.0; *r = tf->width; *b = tf->height;');
    this.line('return 1;');
    this.indent--;
    this.line('}');
    // Containers: union of child bounds. Each child's local AABB is transformed
    // by its full transform (matrix -> scale -> rotate -> translate) via
    // as_bounds_xform, so rotated/scaled/skewed children — including transform.matrix
    // — are never clipped.
    this.line('if (as_is(o, &DisplayObjectContainer_vt)) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)o;');
    this.line('int found = 0;');
    this.line('if (c->children != NULL) {');
    this.indent++;
    this.line('for (int i = 0; i < c->children->length; i++) {');
    this.indent++;
    this.line('DisplayObject* ch = (DisplayObject*)as_v_obj_val(c->children->data[i]);');
    this.line('if (ch == NULL || !ch->visible) continue;');
    this.line('double cl, ct, cr, cb;');
    this.line('if (!as_render_bounds(ch, &cl, &ct, &cr, &cb)) continue;');
    this.line('if (ch->filters != NULL && ch->filters->length > 0) as_filters_expand(ch->filters, &cl, &ct, &cr, &cb);');
    this.line('Matrix* cm = (ch->transform != NULL) ? ch->transform->matrix : NULL;');
    this.line('as_bounds_xform(&cl, &ct, &cr, &cb, ch->x, ch->y, ch->rotation, ch->scaleX, ch->scaleY, cm);');
    this.line('if (!found) { *l = cl; *t = ct; *r = cr; *b = cb; found = 1; }');
    this.line('else {');
    this.indent++;
    this.line('if (cl < *l) *l = cl; if (ct < *t) *t = ct;');
    this.line('if (cr > *r) *r = cr; if (cb > *b) *b = cb;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('return found;');
    this.indent--;
    this.line('}');
    this.line('return 0;');
    this.indent--;
    this.line('}');
    // Grow bounds by every filter's blur spread and (for DropShadow) its
    // directional offset, plus a 1px margin against edge clipping.
    this.line('static void as_filters_expand(as_array* filters, double* l, double* t, double* r, double* b) {');
    this.indent++;
    this.line('for (int i = 0; i < filters->length; i++) {');
    this.indent++;
    this.line('void* f = as_v_obj_val(filters->data[i]);');
    this.line('double ex = 0.0, ey = 0.0, dx = 0.0, dy = 0.0;');
    this.line('if (as_is(f, &BlurFilter_vt)) {');
    this.indent++;
    this.line('ex = ((BlurFilter*)f)->blurX; ey = ((BlurFilter*)f)->blurY;');
    this.indent--;
    this.line('} else if (as_is(f, &DropShadowFilter_vt)) {');
    this.indent++;
    this.line('DropShadowFilter* ds = (DropShadowFilter*)f;');
    this.line('double rad = ds->angle * 3.14159265358979323846 / 180.0;');
    this.line('dx = ds->distance * cos(rad); dy = ds->distance * sin(rad);');
    this.line('ex = ds->blurX; ey = ds->blurY;');
    this.indent--;
    this.line('} else if (as_is(f, &GlowFilter_vt)) {');
    this.indent++;
    this.line('ex = ((GlowFilter*)f)->blurX; ey = ((GlowFilter*)f)->blurY;');
    this.indent--;
    this.line('}');
    this.line('*l -= ex; *t -= ey; *r += ex; *b += ey;');
    this.line('if (dx > 0.0) *r += dx; else *l += dx;');
    this.line('if (dy > 0.0) *b += dy; else *t += dy;');
    this.indent--;
    this.line('}');
    this.line('*l -= 1.0; *t -= 1.0; *r += 1.0; *b += 1.0;');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- incremental redraw: auto cacheAsBitmap (dirty-free fingerprint) ----
    // DisplayObject x/y/rotation/scaleX/scaleY/alpha/visible are plain fields
    // (written directly by generated code, no setter), so they cannot be cheaply
    // intercepted. Instead of a push dirty flag we compute, each frame, a
    // recursive *content fingerprint* of the subtree: the object's transform +
    // its type-specific content (Shape path generation id + paints, Bitmap image,
    // TextField text/format) + its filters + the recursive fingerprints of its
    // children. A subtree whose fingerprint is unchanged for ASC_AUTO_BAKE_FRAMES
    // consecutive frames is treated as static and auto-baked into _cache_image
    // (reusing the cacheAsBitmap path), so subsequent frames emit a single
    // drawImage instead of re-walking the subtree. The instant the fingerprint
    // moves the bake is dropped and the normal path resumes. This is the render-
    // side equivalent of a dirty flag and mirrors cacheAsBitmap's semantics:
    // while baked, intra-subtree changes are not tracked until the fingerprint
    // differs (which any visible change does).
    this.line('#define ASC_AUTO_BAKE_FRAMES 3');
    // Device pixel ratio of the current render pass. The render entry points set
    // it (Stage_render -> its local scale, ASC_window_render -> ASC_win_scale);
    // as_render_cached reads it to bake cacheAsBitmap/auto-bake offscreen surfaces
    // at *physical* resolution so the baked image stays crisp when blitted onto a
    // canvas that has already been scaled by the device ratio (Retina 2x).
    this.line('static double ASC_render_scale = 1.0;');
    this.line('');
    this.line('static inline uint32_t as_fp_u32(uint32_t h, uint32_t v) { return (h ^ v) * 16777619u; }');
    this.line('static inline uint32_t as_fp_i32(uint32_t h, int v) { return (h ^ (uint32_t)v) * 16777619u; }');
    this.line('static inline uint32_t as_fp_ptr(uint32_t h, const void* p) { return (h ^ (uint32_t)(uintptr_t)p) * 16777619u; }');
    this.line('static inline uint32_t as_fp_bool(uint32_t h, bool v) { return (h ^ (v ? 1u : 0u)) * 16777619u; }');
    this.line('static inline uint32_t as_fp_dbl(uint32_t h, double v) {');
    this.indent++;
    this.line('uint64_t b; memcpy(&b, &v, sizeof b);');
    this.line('h = as_fp_u32(h, (uint32_t)b); h = as_fp_u32(h, (uint32_t)(b >> 32));');
    this.line('return h;');
    this.indent--;
    this.line('}');
    this.line('static uint32_t as_render_fp(DisplayObject* o);');
    this.line('static uint32_t as_render_fp(DisplayObject* o) {');
    this.indent++;
    this.line('uint32_t h = 2166136261u;');
    this.line('if (o == NULL) return h;');
    this.line('h = as_fp_dbl(h, o->x); h = as_fp_dbl(h, o->y);');
    this.line('h = as_fp_dbl(h, o->rotation); h = as_fp_dbl(h, o->scaleX); h = as_fp_dbl(h, o->scaleY);');
    this.line('h = as_fp_dbl(h, o->alpha); h = as_fp_bool(h, o->visible);');
    this.line('if (o->transform != NULL && o->transform->matrix != NULL) {');
    this.indent++;
    this.line('Matrix* m = o->transform->matrix;');
    this.line('h = as_fp_dbl(h, m->a); h = as_fp_dbl(h, m->b); h = as_fp_dbl(h, m->c);');
    this.line('h = as_fp_dbl(h, m->d); h = as_fp_dbl(h, m->tx); h = as_fp_dbl(h, m->ty);');
    this.indent--;
    this.line('}');
    this.line('if (as_is(o, &Shape_vt)) {');
    this.indent++;
    this.line('Graphics* g = ((Shape*)o)->graphics;');
    this.line('if (g != NULL) {');
    this.indent++;
    this.line('if (g->path != NULL) h = as_fp_u32(h, as_skia_path_generation_id(g->path));');
    this.line('h = as_fp_ptr(h, g->fill); h = as_fp_ptr(h, g->stroke);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else if (as_is(o, &Bitmap_vt)) {');
    this.indent++;
    this.line('BitmapData* bd = ((Bitmap*)o)->bitmapData;');
    this.line('if (bd != NULL) h = as_fp_ptr(h, bd->image);');
    this.indent--;
    this.line('} else if (as_is(o, &TextField_vt)) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)o;');
    this.line('h = as_fp_ptr(h, tf->text); h = as_fp_ptr(h, tf->defaultTextFormat);');
    this.line('if (tf->defaultTextFormat != NULL) {');
    this.indent++;
    this.line('TextFormat* f = tf->defaultTextFormat;');
    this.line('h = as_fp_ptr(h, f->font); h = as_fp_dbl(h, f->size); h = as_fp_u32(h, f->color);');
    this.line('h = as_fp_bool(h, f->bold); h = as_fp_bool(h, f->italic); h = as_fp_dbl(h, f->leading);');
    this.indent--;
    this.line('}');
    this.line('h = as_fp_dbl(h, tf->width); h = as_fp_dbl(h, tf->height);');
    this.line('h = as_fp_bool(h, tf->background); h = as_fp_u32(h, tf->backgroundColor);');
    this.line('h = as_fp_i32(h, tf->scrollV); h = as_fp_bool(h, tf->hscroll);');
    this.line('h = as_fp_bool(h, tf->multiline); h = as_fp_bool(h, tf->wordWrap);');
    this.indent--;
    this.line('}');
    this.line('if (o->filters != NULL) {');
    this.indent++;
    this.line('h = as_fp_i32(h, o->filters->length);');
    this.line('for (int i = 0; i < o->filters->length; i++) {');
    this.indent++;
    this.line('void* f = as_v_obj_val(o->filters->data[i]);');
    this.line('if (as_is(f, &BlurFilter_vt)) {');
    this.indent++;
    this.line('h = as_fp_dbl(h, ((BlurFilter*)f)->blurX); h = as_fp_dbl(h, ((BlurFilter*)f)->blurY);');
    this.line('h = as_fp_i32(h, ((BlurFilter*)f)->quality);');
    this.indent--;
    this.line('} else if (as_is(f, &DropShadowFilter_vt)) {');
    this.indent++;
    this.line('DropShadowFilter* ds = (DropShadowFilter*)f;');
    this.line('h = as_fp_dbl(h, ds->distance); h = as_fp_dbl(h, ds->angle); h = as_fp_u32(h, ds->color);');
    this.line('h = as_fp_dbl(h, ds->alpha); h = as_fp_dbl(h, ds->blurX); h = as_fp_dbl(h, ds->blurY);');
    this.line('h = as_fp_dbl(h, ds->strength); h = as_fp_i32(h, ds->quality);');
    this.line('h = as_fp_bool(h, ds->inner); h = as_fp_bool(h, ds->knockout); h = as_fp_bool(h, ds->hideObject);');
    this.indent--;
    this.line('} else if (as_is(f, &GlowFilter_vt)) {');
    this.indent++;
    this.line('GlowFilter* gf = (GlowFilter*)f;');
    this.line('h = as_fp_u32(h, gf->color); h = as_fp_dbl(h, gf->alpha); h = as_fp_dbl(h, gf->blurX);');
    this.line('h = as_fp_dbl(h, gf->blurY); h = as_fp_dbl(h, gf->strength); h = as_fp_i32(h, gf->quality);');
    this.line('h = as_fp_bool(h, gf->inner); h = as_fp_bool(h, gf->knockout);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('if (as_is(o, &DisplayObjectContainer_vt)) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)o;');
    this.line('if (c->children != NULL) {');
    this.indent++;
    this.line('for (int i = 0; i < c->children->length; i++) h = as_fp_u32(h, as_render_fp((DisplayObject*)as_v_obj_val(c->children->data[i])));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // Update the auto-bake state from this frame's fingerprint. Unchanged =>
    // count a still frame; changed => reset and, if we were baked, drop the bake
    // (invalidate the cache so the normal path resumes). When the still counter
    // exactly reaches the threshold and the object has deterministic bounds, mark
    // it auto-baked; objects without bounds (empty containers) reset so they only
    // retry the bounds probe every ASC_AUTO_BAKE_FRAMES frames, not every frame.
    this.line('if (h == o->_auto_fp) { o->_auto_still++; }');
    this.line('else { o->_auto_fp = h; o->_auto_still = 0; if (o->_auto_baked) { o->_auto_baked = 0; o->_cache_valid = 0; } }');
    this.line('if (o->visible && !o->cacheAsBitmap && !o->_auto_baked && o->_auto_still == ASC_AUTO_BAKE_FRAMES) {');
    this.indent++;
    this.line('double bl, bt, br, bb;');
    this.line('if (as_render_bounds(o, &bl, &bt, &br, &bb)) o->_auto_baked = 1; else o->_auto_still = 0;');
    this.indent--;
    this.line('}');
    this.line('return h;');
    this.indent--;
    this.line('}');
    this.line('');
    // cacheAsBitmap: bake the subtree (content + own filters) into an offscreen
    // surface sized to its tight bounds, snapshot it to an SkImage, and draw that
    // image every frame instead of re-walking the subtree. The bake is keyed on
    // the bounds size; toggling cacheAsBitmap off/on (via the setter) invalidates
    // it. Objects without deterministic bounds (empty containers) fall through to
    // the normal path.
    this.line('static void as_render_cached(void* canvas, DisplayObject* o) {');
    this.indent++;
    this.line('double bl = 0.0, bt = 0.0, br = 0.0, bb = 0.0;');
    this.line('if (!as_render_bounds(o, &bl, &bt, &br, &bb)) {');
    this.indent++;
    this.line('if (o->filters != NULL && o->filters->length > 0) as_render_filtered(canvas, o, o->filters, o->filters->length - 1);');
    this.line('else as_render_object_content(canvas, o);');
    this.line('return;');
    this.indent--;
    this.line('}');
    this.line('if (o->filters != NULL && o->filters->length > 0) as_filters_expand(o->filters, &bl, &bt, &br, &bb);');
    this.line('int lw = (int)ceil(br - bl); int lh = (int)ceil(bb - bt);');
    this.line('if (lw <= 0 || lh <= 0) { as_render_object_content(canvas, o); return; }');
    // Bake at physical resolution: the destination canvas is already scaled by the
    // device ratio, so a 1x logical-sized surface would be magnified (blurry) when
    // blitted back. Multiply the surface size by ASC_render_scale and scale the
    // bake canvas the same way, then draw at *logical* size on the scaled canvas.
    this.line('double sc = ASC_render_scale; if (sc < 1.0) sc = 1.0;');
    this.line('int pw = (int)ceil((double)lw * sc); int ph = (int)ceil((double)lh * sc);');
    this.line('if (!o->_cache_valid || o->_cache_image == NULL || o->_cache_w != (double)pw || o->_cache_h != (double)ph) {');
    this.indent++;
    this.line('if (o->_cache_image != NULL) { as_skia_image_delete(o->_cache_image); o->_cache_image = NULL; }');
    this.line('void* surface = as_skia_surface_bake_new(pw, ph);');
    this.line('if (surface != NULL) {');
    this.indent++;
    this.line('void* c2 = as_skia_surface_canvas(surface);');
    this.line('as_skia_canvas_clear_transparent(c2);');
    this.line('as_skia_canvas_scale(c2, sc, sc);');
    this.line('as_skia_canvas_translate(c2, -bl, -bt);');
    this.line('if (o->filters != NULL && o->filters->length > 0) as_render_filtered(c2, o, o->filters, o->filters->length - 1);');
    this.line('else as_render_object_content(c2, o);');
    this.line('o->_cache_image = as_skia_surface_make_snapshot(surface);');
    this.line('as_skia_surface_delete(surface);');
    this.line('o->_cache_w = (double)pw; o->_cache_h = (double)ph;');
    this.line('o->_cache_valid = 1;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('if (o->_cache_image != NULL) {');
    this.indent++;
    this.line('as_skia_canvas_draw_image_rect(canvas, o->_cache_image, bl, bt, (double)lw, (double)lh);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('');
    this.line('static void as_render_object(void* canvas, DisplayObject* o) {');
    this.indent++;
    this.line('if (o == NULL || !o->visible) return;');
    this.line('if (o->alpha < 1.0) as_skia_canvas_save_layer_alpha(canvas, o->alpha);');
    this.line('else as_skia_canvas_save(canvas);');
    this.line('as_skia_canvas_translate(canvas, o->x, o->y);');
    this.line('as_skia_canvas_rotate(canvas, o->rotation);');
    this.line('as_skia_canvas_scale(canvas, o->scaleX, o->scaleY);');
    // DisplayObject.transform.matrix: concat the user Matrix after the built-in
    // x/y/rotation/scale so both views of the same transform compose (AS3 applies
    // the concat matrix as an additional local transform).
    this.line('if (o->transform != NULL && o->transform->matrix != NULL) {');
    this.indent++;
    this.line('Matrix* m = o->transform->matrix;');
    this.line('as_skia_canvas_concat(canvas, m->a, m->b, m->c, m->d, m->tx, m->ty);');
    this.indent--;
    this.line('}');
    this.line('if (o->cacheAsBitmap || o->_auto_baked) {');
    this.indent++;
    this.line('as_render_cached(canvas, o);');
    this.indent--;
    this.line('} else if (o->filters != NULL && o->filters->length > 0) {');
    this.indent++;
    this.line('double bl, bt, br, bb;');
    this.line('if (as_render_bounds(o, &bl, &bt, &br, &bb)) {');
    this.indent++;
    this.line('as_filters_expand(o->filters, &bl, &bt, &br, &bb);');
    this.line('void* clip = as_skia_paint_fill(0x000000, 1.0);');
    this.line('as_skia_canvas_save_layer_paint_bounds(canvas, clip, bl, bt, br, bb);');
    this.line('as_skia_paint_delete(clip);');
    this.line('as_render_filtered(canvas, o, o->filters, o->filters->length - 1);');
    this.line('as_skia_canvas_restore(canvas);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('as_render_filtered(canvas, o, o->filters, o->filters->length - 1);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('as_render_object_content(canvas, o);');
    this.indent--;
    this.line('}');
    this.line('as_skia_canvas_restore(canvas);');
    this.indent--;
    this.line('}');
    this.line('');
    // AS3 applies filters in array order (filters[0] first = innermost), so the
    // outermost wrap is the LAST filter. We recurse from the last index down to 0
    // and draw the plain content once idx < 0. BlurFilter and DropShadowFilter
    // wrap the content in a single saveLayer; an outer GlowFilter draws a blurred
    // recolored silhouette layer first, then the unfiltered body on top so only
    // the fringe shows. sigma ~= blurX/3 approximates AS3's box-blur diameter.
    this.line('static void as_render_filtered(void* canvas, DisplayObject* o, as_array* filters, int idx) {');
    this.indent++;
    this.line('if (idx < 0) { as_render_object_content(canvas, o); return; }');
    this.line('void* f = as_v_obj_val(filters->data[idx]);');
    this.line('if (as_is(f, &BlurFilter_vt)) {');
    this.indent++;
    this.line('BlurFilter* bf = (BlurFilter*)f;');
    this.line('void* p = as_skia_paint_fill(0x000000, 1.0);');
    this.line('as_skia_paint_set_blur(p, bf->blurX / 3.0, bf->blurY / 3.0);');
    this.line('as_skia_canvas_save_layer_paint(canvas, p);');
    this.line('as_skia_paint_delete(p);');
    this.line('as_render_filtered(canvas, o, filters, idx - 1);');
    this.line('as_skia_canvas_restore(canvas);');
    this.indent--;
    this.line('} else if (as_is(f, &DropShadowFilter_vt)) {');
    this.indent++;
    this.line('DropShadowFilter* ds = (DropShadowFilter*)f;');
    this.line('double rad = ds->angle * 3.14159265358979323846 / 180.0;');
    this.line('double ddx = ds->distance * cos(rad);');
    this.line('double ddy = ds->distance * sin(rad);');
    this.line('void* p = as_skia_paint_fill(0x000000, 1.0);');
    this.line('as_skia_paint_set_drop_shadow(p, ddx, ddy, ds->blurX / 3.0, ds->blurY / 3.0, ds->color, ds->alpha);');
    this.line('as_skia_canvas_save_layer_paint(canvas, p);');
    this.line('as_skia_paint_delete(p);');
    this.line('as_render_filtered(canvas, o, filters, idx - 1);');
    this.line('as_skia_canvas_restore(canvas);');
    this.indent--;
    this.line('} else if (as_is(f, &GlowFilter_vt)) {');
    this.indent++;
    this.line('GlowFilter* gf = (GlowFilter*)f;');
    this.line('void* p = as_skia_paint_fill(0x000000, 1.0);');
    this.line('as_skia_paint_set_glow(p, gf->blurX / 3.0, gf->blurY / 3.0, gf->color, gf->alpha);');
    this.line('as_skia_canvas_save_layer_paint(canvas, p);');
    this.line('as_skia_paint_delete(p);');
    this.line('as_render_filtered(canvas, o, filters, idx - 1);');
    this.line('as_skia_canvas_restore(canvas);');
    this.line('as_render_filtered(canvas, o, filters, idx - 1);');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('as_render_filtered(canvas, o, filters, idx - 1);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.line('');
    this.line('static void as_render_object_content(void* canvas, DisplayObject* o) {');
    this.indent++;
    this.line('if (as_is(o, &Shape_vt)) {');
    this.indent++;
    this.line('Graphics* g = ((Shape*)o)->graphics;');
    this.line('if (g->fill != NULL) as_skia_canvas_draw_path(canvas, g->path, g->fill);');
    this.line('if (g->stroke != NULL) as_skia_canvas_draw_path(canvas, g->path, g->stroke);');
    this.indent--;
    this.line('} else if (as_is(o, &Bitmap_vt)) {');
    this.indent++;
    this.line('BitmapData* bd = ((Bitmap*)o)->bitmapData;');
    this.line('if (bd != NULL && bd->image != NULL) as_skia_canvas_draw_image_rect(canvas, bd->image, 0.0, 0.0, (double)bd->width, (double)bd->height);');
    this.indent--;
    this.line('} else if (as_is(o, &TextField_vt)) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)o;');
    this.line('if (tf->background) {');
    this.indent++;
    this.line('void* bg = as_skia_paint_fill(tf->backgroundColor, 1.0);');
    this.line('as_skia_canvas_draw_rect(canvas, 0.0, 0.0, tf->width, tf->height, bg);');
    this.line('as_skia_paint_delete(bg);');
    this.indent--;
    this.line('}');
    this.line('if (tf->text != NULL && tf->defaultTextFormat != NULL) {');
    this.indent++;
    this.line('as_tf_apply_autosize(tf);');
    this.line('void* para = as_tf_paragraph(tf);');
    this.line('if (para != NULL) {');
    this.indent++;
    this.line('double lh = as_tf_line_height(tf);');
    this.line('int vis = as_tf_visible_lines(tf);');
    this.line('int lc = as_tf_line_count(tf);');
    this.line('int maxs = lc - vis + 1; if (maxs < 1) maxs = 1;');
    this.line('int top = tf->scrollV; if (top < 1) top = 1; if (top > maxs) top = maxs;');
    this.line('double scrollY = (double)(top - 1) * lh;');
    // Horizontal scroll: hscroll=false clips at width (no pan); hscroll=true lets
    // scrollH pan within [0, maxScrollH].
    this.line('int maxsh = TextField_get_maxScrollH((void*)tf);');
    this.line('int leftpx = tf->hscroll ? tf->_scroll_h : 0;');
    this.line('if (leftpx < 0) leftpx = 0; if (leftpx > maxsh) leftpx = maxsh;');
    this.line('double scrollX = (double)leftpx;');
    // Block shift for horizontalAlign when the paragraph carries none itself
    // (non-wrapping field): AIR centers/right-aligns inside the field box anyway.
    this.line('double alignDx = as_tf_align_dx(tf);');
    this.line('as_skia_canvas_save(canvas);');
    this.line('as_skia_canvas_clip_rect(canvas, 0.0, 0.0, tf->width, tf->height);');
    // Selection highlight (drawn behind the glyphs, paragraph-relative).
    this.line('if (tf->_sel_begin >= 0 && tf->_sel_end > tf->_sel_begin) {');
    this.indent++;
    this.line('double rl[16], rt[16], rr[16], rb[16];');
    this.line('int nr = as_skia_textlayout_rects_for_range(para, tf->_sel_begin, tf->_sel_end, rl, rt, rr, rb, 16);');
    this.line('void* hp = as_skia_paint_fill(0x4D90FEu, 0.35);');
    this.line('for (int i = 0; i < nr; i++) { as_skia_canvas_draw_rect(canvas, 2.0 + alignDx - scrollX + rl[i], 2.0 - scrollY + rt[i], rr[i] - rl[i], rb[i] - rt[i], hp); }');
    this.line('as_skia_paint_delete(hp);');
    this.indent--;
    this.line('}');
    this.line('as_skia_textlayout_paint(para, canvas, 2.0 + alignDx - scrollX, 2.0 - scrollY);');
    this.line('as_skia_canvas_restore(canvas);');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('} else if (as_is(o, &DisplayObjectContainer_vt)) {');
    this.indent++;
    this.line('DisplayObjectContainer* c = (DisplayObjectContainer*)o;');
    this.line('if (c->children != NULL) {');
    this.indent++;
    this.line('for (int i = 0; i < c->children->length; i++) as_render_object(canvas, (DisplayObject*)as_v_obj_val(c->children->data[i]));');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
    // Stage.render(width, height, path): non-standard test hook (like dispatchMouse)
    // that rasterizes the whole tree offscreen and encodes it to PNG. The surface is
    // created at *physical* pixel size and the canvas is scaled by the device ratio,
    // so AIR's <requestedDisplayResolution>high gives a crisp PNG while AS3 code keeps
    // working in logical stage coordinates.
    this.line('void Stage_render(void* _this, double width, double height, char* path) {');
    this.indent++;
    this.line('Stage* st = (Stage*)_this;');
    this.line('int pw = (int)width, ph = (int)height;');
    this.line('double scale = as_window_device_scale((int)width, (int)height, &pw, &ph);');
    this.line('void* surface = as_skia_surface_new(pw, ph);');
    this.line('if (surface == NULL) return;');
    this.line('void* canvas = as_skia_surface_canvas(surface);');
    this.line('st->stage_w = (int)width; st->stage_h = (int)height; st->stage_scale = scale;');
    this.line('as_skia_canvas_scale(canvas, scale, scale);');
    this.line('as_skia_canvas_clear(canvas, st->stage_color);');
    this.line('ASC_render_scale = scale;');
    this.line('as_render_fp((DisplayObject*)_this);');
    this.line('as_render_object(canvas, (DisplayObject*)_this);');
    this.line('as_skia_surface_save_png(surface, path);');
    this.line('as_skia_surface_delete(surface);');
    this.indent--;
    this.line('}');
    // Stage.showWindow(width, height, title): rasterizes the tree offscreen, then
    // presents the pixels in an SDL2 window and blocks on the event loop (stage
    // 39). Mouse input is forwarded back into the AS3 event system through the
    // callbacks below: on_mouse routes to Stage_dispatchMouse (hit test + bubble),
    // and the render helper re-rasterizes the (possibly mutated) tree after each
    // event so the window reflects listener-driven changes. Offscreen-only builds (no
    // ASC_USE_WINDOW) still compile: the helper is a no-op and the function
    // simply renders and returns.
    this.line('static void* ASC_win_canvas = NULL;');
    this.line('static void* ASC_win_surface = NULL;');
    this.line('static Stage* ASC_win_stage = NULL;');
    this.line('static double ASC_win_scale = 1.0;');   // device pixel ratio (2.0 on Retina)
    this.line('static int ASC_win_design_w = 0, ASC_win_design_h = 0;');  // size passed to showWindow
    this.line('static int ASC_win_lw = 0, ASC_win_lh = 0;');              // current logical window size
    // Physical drawable size (Metal mode: the size passed to sk_mtl_begin_frame,
    // which re-sizes the CAMetalLayer and acquires the one-shot drawable each
    // frame). CPU raster mode derives it on demand instead.
    this.line('static int ASC_win_pw = 0, ASC_win_ph = 0;');
    this.line('static double ASC_win_cx = 1.0, ASC_win_cy = 1.0;');       // content scale (scaleMode)
    this.line('static double ASC_win_ox = 0.0, ASC_win_oy = 0.0;');       // content offset (align)
    // stageWidth/stageHeight follow AIR: under NO_SCALE they track the real window
    // size (the app is expected to relayout on Event.RESIZE); under every scaling
    // mode they stay at the design size, because the content is scaled to fit it.
    this.line('static void ASC_window_apply_stage_size(void) {');
    this.indent++;
    this.line('Stage* st = ASC_win_stage;');
    this.line('const char* sm = st->scale_mode;');
    this.line('if (sm == NULL || strcmp(sm, "noScale") == 0) { st->stage_w = ASC_win_lw; st->stage_h = ASC_win_lh; }');
    this.line('else { st->stage_w = ASC_win_design_w; st->stage_h = ASC_win_design_h; }');
    this.indent--;
    this.line('}');
    // Rasterize the tree into the current surface. The canvas transform is
    // device-scale -> align-offset -> content-scale, so AS3 code always draws in
    // logical stage coordinates while the pixels land 1:1 on a Retina drawable.
    this.line('static void ASC_window_render(void) {');
    this.indent++;
    this.line('Stage* st = ASC_win_stage;');
    this.line('#ifdef ASC_RENDER_METAL');
    this.line('void* canvas = as_skia_mtl_begin_frame(ASC_win_pw, ASC_win_ph);');
    this.line('if (canvas == NULL) return;');
    this.line('#else');
    this.line('void* canvas = ASC_win_canvas;');
    this.line('if (canvas == NULL) return;');
    this.line('#endif');
    this.line('if (st == NULL) return;');
    this.line('double cx = 1.0, cy = 1.0;');
    this.line('const char* sm = st->scale_mode;');
    this.line('int dw = ASC_win_design_w, dh = ASC_win_design_h;');
    this.line('int lw = ASC_win_lw, lh = ASC_win_lh;');
    this.line('if (sm != NULL && dw > 0 && dh > 0 && strcmp(sm, "noScale") != 0) {');
    this.indent++;
    this.line('double rx = (double)lw / (double)dw, ry = (double)lh / (double)dh;');
    this.line('if (strcmp(sm, "showAll") == 0) { cx = cy = (rx < ry) ? rx : ry; }');
    this.line('else if (strcmp(sm, "noBorder") == 0) { cx = cy = (rx > ry) ? rx : ry; }');
    this.line('else if (strcmp(sm, "exactFit") == 0) { cx = rx; cy = ry; }');
    this.indent--;
    this.line('}');
    // Leftover space is distributed by Stage.align; "TL" (the AIR default) pins the
    // content to the top-left corner, which is what NO_SCALE looks like in adl.
    this.line('double remx = (double)lw - cx * (double)dw, remy = (double)lh - cy * (double)dh;');
    this.line('double ox = 0.0, oy = 0.0;');
    this.line('const char* al = st->align;');
    this.line('if (al != NULL) {');
    this.indent++;
    this.line('if (strcmp(al, "B") == 0 || strcmp(al, "BL") == 0 || strcmp(al, "BR") == 0) oy = remy;');
    this.line('else if (strcmp(al, "L") == 0 || strcmp(al, "R") == 0) oy = remy * 0.5;');
    this.line('if (strcmp(al, "R") == 0 || strcmp(al, "TR") == 0 || strcmp(al, "BR") == 0) ox = remx;');
    this.line('else if (strcmp(al, "T") == 0 || strcmp(al, "B") == 0) ox = remx * 0.5;');
    this.indent--;
    this.line('}');
    this.line('ASC_win_cx = cx; ASC_win_cy = cy; ASC_win_ox = ox; ASC_win_oy = oy;');
    this.line('ASC_window_apply_stage_size();');
    this.line('as_skia_canvas_clear(canvas, st->stage_color);');
    this.line('as_skia_canvas_save(canvas);');
    this.line('as_skia_canvas_scale(canvas, ASC_win_scale, ASC_win_scale);');
    this.line('as_skia_canvas_translate(canvas, ox, oy);');
    this.line('as_skia_canvas_scale(canvas, cx, cy);');
    // Composite the Stage3D frame behind the 2D display list (AIR puts Stage3D
    // behind). The render target may be larger than the stage-unit rect it covers
    // (HiDPI/+wantsBestResolution), so the source size and the destination rect
    // are passed separately. Both GPU backends blit the render-target texture
    // directly (Metal: MTLTexture; web: the GL texture wrapped as a
    // GrBackendTexture); the CPU path draws the readback BGRA buffer.
    this.line('#ifdef ASC_RENDER_METAL');
    this.line('if (ASC_stage3d_ready && ASC_stage3d_tex != NULL) {');
    this.indent++;
    // Source rect = the real render target (device pixels when wantsBestResolution
    // scaled it); dest rect = its logical footprint in stage units, which the canvas
    // scale above turns back into device pixels 1:1.
    this.line('as_skia_mtl_draw_texture(canvas, ASC_stage3d_tex, ASC_stage3d_w, ASC_stage3d_h, 0.0, 0.0, (double)ASC_stage3d_lw, (double)ASC_stage3d_lh);');
    this.indent--;
    this.line('}');
    this.line('#elif defined(ASC_RENDER_GPU)');
    this.line('if (ASC_stage3d_ready && ASC_stage3d_tex != NULL) {');
    this.indent++;
    this.line('as_skia_gl_draw_texture(canvas, ASC_stage3d_tex, ASC_stage3d_w, ASC_stage3d_h, 0.0, 0.0, (double)ASC_stage3d_lw, (double)ASC_stage3d_lh);');
    this.indent--;
    this.line('}');
    this.line('#else');
    this.line('if (ASC_stage3d_ready && ASC_stage3d_pixels != NULL) {');
    this.indent++;
    this.line('as_skia_canvas_draw_bgra(canvas, ASC_stage3d_pixels, ASC_stage3d_w, ASC_stage3d_h, 0.0, 0.0, (double)ASC_stage3d_lw, (double)ASC_stage3d_lh);');
    this.indent--;
    this.line('}');
    this.line('#endif');
    this.line('ASC_render_scale = ASC_win_scale;');
    this.line('as_render_fp((DisplayObject*)st);');
    this.line('as_render_object(canvas, (DisplayObject*)st);');
    this.line('as_skia_canvas_restore(canvas);');
    this.line('#ifdef ASC_RENDER_METAL');
    this.line('as_skia_mtl_flush();');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('static void ASC_window_on_mouse(double x, double y, const char* type) {');
    this.indent++;
    // SDL reports mouse coordinates in logical *window* points, so they must be
    // mapped back through the align offset and the content scale before they mean
    // anything in stage coordinates. Under NO_SCALE + TOP_LEFT this is the identity.
    this.line('double sx = (x - ASC_win_ox) / ASC_win_cx;');
    this.line('double sy = (y - ASC_win_oy) / ASC_win_cy;');
    this.line('Stage_dispatchMouse((void*)ASC_win_stage, sx, sy, (char*)type);');
    this.indent--;
    this.line('}');
    this.line('static void ASC_window_on_wheel(double x, double y, double delta) {');
    this.indent++;
    this.line('double sx = (x - ASC_win_ox) / ASC_win_cx;');
    this.line('double sy = (y - ASC_win_oy) / ASC_win_cy;');
    this.line('Stage_dispatchWheel((void*)ASC_win_stage, sx, sy, delta);');
    this.indent--;
    this.line('}');
    this.line('static void ASC_window_on_redraw(void) { ASC_window_render(); }');
    this.line('static void ASC_window_on_frame(void) { Stage_dispatchFrame((void*)ASC_win_stage); }');
    // Stage.frameRate drives the event-loop cadence: 1000/frameRate ms per tick.
    // frameRate <= 0 (unset) follows the display's refresh rate (vsync cadence);
    // if that cannot be read, fall back to a 120 Hz default. A huge frameRate
    // (e.g. 1000) yields a ~1 ms sleep, letting ENTER_FRAME run near the CPU's
    // limit just like adl. With vsync on, an explicit frameRate above the display
    // refresh rate is capped to that rate — a monitor cannot present faster than
    // it refreshes, and pacing above it just beats (e.g. 120 vs 50) and jitters
    // the frame interval, which is what made delta-time animation stutter.
    this.line('static double ASC_window_on_frame_delay(void) {');
    this.indent++;
    this.line('double fr = ASC_win_stage->frame_rate;');
    this.line('double rr = as_window_display_refresh();');
    this.line('if (fr <= 0.0) {');
    this.indent++;
    this.line('if (rr > 0.0) return 1000.0 / rr;');
    this.line('return 1000.0 / 120.0;');
    this.indent--;
    this.line('}');
    this.line('if (rr > 0.0 && fr > rr) return 1000.0 / rr;');
    this.line('return 1000.0 / fr;');
    this.indent--;
    this.line('}');
    // Rebuild the surface at the window's new physical size. Without this the
    // blit would resample a stale bitmap across the new drawable — the visible
    // "content deforms while dragging the window" bug that NO_SCALE must prevent.
    // `scale` is the device pixel ratio computed by window_glue.cc from SDL's own
    // size queries (macOS contentsScaleFactor); use it verbatim — do NOT re-derive
    // pw/lw here, which can be stale while the window straddles two displays with
    // different backing scales (Retina 2x vs external 1x).
    this.line('static void* ASC_window_on_resize(int lw, int lh, int pw, int ph, double scale) {');
    this.indent++;
    this.line('if (lw <= 0 || lh <= 0 || pw <= 0 || ph <= 0) return NULL;');
    this.line('#ifdef ASC_RENDER_METAL');
    // Metal: there is no persistent surface to rebuild — the drawable is re-acquired
    // per frame and sized in sk_mtl_begin_frame from ASC_win_pw/ph. on_resize only
    // updates the stage dimensions + device scale and fires Event.RESIZE; the next
    // on_redraw re-renders at the new size. The return value is ignored.
    this.line('ASC_win_lw = lw; ASC_win_lh = lh;');
    this.line('ASC_win_pw = pw; ASC_win_ph = ph;');
    this.line('if (scale <= 0.0) scale = 1.0;');
    this.line('ASC_win_scale = scale;');
    this.line('ASC_win_stage->stage_scale = scale;');
    this.line('ASC_window_apply_stage_size();');
    this.line('Event* revt = Event_new((char*)"resize", false, false);');
    this.line('EventDispatcher_dispatchEvent((void*)ASC_win_stage, revt);');
    this.line('return NULL;');
    this.line('#else');
    this.line('if (ASC_win_surface != NULL) as_skia_surface_delete(ASC_win_surface);');
    this.line('ASC_win_surface = NULL; ASC_win_canvas = NULL;');
    this.line('void* s = as_skia_surface_new(pw, ph);');
    this.line('if (s == NULL) return NULL;');
    this.line('ASC_win_surface = s;');
    this.line('ASC_win_canvas = as_skia_surface_canvas(s);');
    this.line('ASC_win_lw = lw; ASC_win_lh = lh;');
    // The device pixel ratio can change when the window is dragged onto a monitor
    // with a different backing scale (e.g. 2x Retina -> 1x external). Use the
    // scale handed in by the glue layer (authoritative, from SDL) rather than
    // recomputing pw/lw, which is what made the content appear enlarged/cropped
    // and zeroed stageWidth/stageHeight during a cross-display drag.
    this.line('if (scale <= 0.0) scale = 1.0;');
    this.line('ASC_win_scale = scale;');
    this.line('ASC_win_stage->stage_scale = scale;');
    this.line('ASC_window_render();');
    // AIR fires Event.RESIZE on the stage after the new size is in effect, so an
    // app that relayouts on resize (the NO_SCALE idiom) sees the updated values.
    this.line('Event* revt = Event_new((char*)"resize", false, false);');
    this.line('EventDispatcher_dispatchEvent((void*)ASC_win_stage, revt);');
    this.line('return s;');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('void Stage_showWindow(void* _this, double width, double height, char* title) {');
    this.indent++;
    this.line('Stage* st = (Stage*)_this;');
    this.line('#ifdef ASC_RENDER_METAL');
    // Metal: no persistent surface is created up front. The window backend builds
    // the CAMetalLayer + GrDirectContext and calls on_resize to report the initial
    // drawable size, then on_redraw acquires a one-shot drawable every frame.
    this.line('ASC_win_stage = st;');
    this.line('ASC_win_scale = 1.0;');
    this.line('st->stage_scale = 1.0;');
    this.line('ASC_win_design_w = (int)width; ASC_win_design_h = (int)height;');
    this.line('ASC_win_lw = (int)width; ASC_win_lh = (int)height;');
    this.line('ASC_win_pw = (int)width; ASC_win_ph = (int)height;');
    this.line('int fullscreen = (st->display_state != NULL && strcmp(st->display_state, "fullScreen") == 0) ? 1 : 0;');
    this.line('as_skia_surface_show_window_metal((int)width, (int)height, title, fullscreen, ASC_window_on_mouse, ASC_window_on_wheel, ASC_window_on_redraw, ASC_window_on_frame, ASC_window_on_frame_delay, ASC_window_on_resize);');
    this.line('ASC_win_stage = NULL;');
    this.line('#else');
    // The surface must be created at the drawable's physical pixel size *before* the
    // window exists, otherwise SDL resamples a logical-sized texture onto a Retina
    // drawable and everything looks blurry (AIR's "standard" resolution).
    this.line('int pw = (int)width, ph = (int)height;');
    this.line('double scale = as_window_device_scale((int)width, (int)height, &pw, &ph);');
    this.line('void* surface = as_skia_surface_new(pw, ph);');
    this.line('if (surface == NULL) return;');
    this.line('ASC_win_surface = surface;');
    this.line('ASC_win_canvas = as_skia_surface_canvas(surface);');
    this.line('ASC_win_stage = st;');
    this.line('ASC_win_scale = scale;');
    this.line('st->stage_scale = scale;');
    this.line('ASC_win_design_w = (int)width; ASC_win_design_h = (int)height;');
    this.line('ASC_win_lw = (int)width; ASC_win_lh = (int)height;');
    this.line('ASC_window_render();');
    this.line('int fullscreen = (st->display_state != NULL && strcmp(st->display_state, "fullScreen") == 0) ? 1 : 0;');
    this.line('as_skia_surface_show_window(ASC_win_surface, (int)width, (int)height, pw, ph, title, fullscreen, ASC_window_on_mouse, ASC_window_on_wheel, ASC_window_on_redraw, ASC_window_on_frame, ASC_window_on_frame_delay, ASC_window_on_resize);');
    // The event loop may have replaced the surface on resize, so free whatever is
    // current rather than the pointer we started with.
    this.line('if (ASC_win_surface != NULL) as_skia_surface_delete(ASC_win_surface);');
    this.line('ASC_win_surface = NULL; ASC_win_canvas = NULL;');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('');
    // Vector.<T> monomorphized helpers: new/push/pop/get/set with bounds checks.
    // Index errors throw RangeError (which longjmps to the nearest handler), so
    // the trailing `return` only satisfies the compiler and is never reached.
    for (const [, elem] of this.vectorSpecs) {
      const key = this.vectorCName(elem);
      const ec = this.cTypeName(elem);
      const def = this.defaultInit(elem);
      const defExpr = def.startsWith('{') ? `(${ec})${def}` : def;
      const isPtr = this.vectorElemIsPtr(elem);
      // GC mark callback: trace the data buffer. Reference elements live in a
      // GCT_PTR_ARRAY whose children the GC scans; scalar/boxed/interface elements
      // live in a GCT_RAW leaf, which the GC does not scan at all — hence the
      // explicit per-element tracing below.
      this.line(`static void as_vector_${key}_mark(void* self) {`);
      this.indent++;
      this.line(`as_vector_${key}* v = (as_vector_${key}*)self;`);
      this.line('gc_mark_ptr(v->data);');
      // Interface elements are stored BY VALUE as `{ obj, vt }` structs in a
      // buffer the GC does not scan, so the scan of `data` above sees nothing
      // live: the element's `obj` pointer (a real GC object) must be traced
      // explicitly or the collector recycles objects that are still referenced
      // from the vector (e.g. every Tween/DelayedCall sitting in a
      // Juggler._objects). Same rule as an interface-typed field.
      if (elem.kind === 'interface') {
        this.line('for (int i = 0; i < v->length; i++) gc_mark_ptr((void*)v->data[i].obj);');
      }
      // `*`/any elements live in a buffer of boxed as_value slots that the GC does
      // not scan, so any object/string reachable only through `Vector.<*>` would be
      // swept while still referenced. Trace the boxed slots explicitly.
      if (elem.kind === 'any') {
        this.line('for (int i = 0; i < v->length; i++) gc_mark_value(v->data[i]);');
      }
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_new(void) {`);
      this.indent++;
      this.line(`as_vector_${key}* v = (as_vector_${key}*)gc_alloc(GCT_CUSTOM, sizeof(as_vector_${key}));`);
      this.line(`v->mark = as_vector_${key}_mark;`);
      this.line('v->data = NULL; v->length = 0; v->capacity = 0;');
      this.line('return v;');
      this.indent--;
      this.line('}');
      // Grow the element storage to `cap` elements (a no-op when it already fits).
      // The payload lives on the GC heap like everything else the Vector owns:
      // with malloc/realloc it would outlive every reference to it, so a Vector the
      // collector reclaims (or whose `data` a grow replaces) leaks its whole buffer
      // for the rest of the process. That is unbounded in practice — Starling
      // re-uploads a multi-MB VertexBuffer3D on every frame, which leaked ~1 MB per
      // batched object in the Benchmark scene (14 GB within 23 s).
      // Reference elements use GCT_PTR_ARRAY, whose elements the GC scans; scalar /
      // boxed / interface elements use the GCT_RAW leaf, and `_mark` above traces
      // the object references those hold (`*` boxes and interface `obj` members).
      this.line(`static void as_vector_${key}_grow(as_vector_${key}* v, int cap) {`);
      this.indent++;
      this.line('if (cap <= v->capacity) return;');
      // Big payloads round up to a power-of-two element count. The allocator
      // segregates big blocks by size class, and equal-sized requests are what
      // let a freed buffer be handed straight back: Starling rebuilds a
      // multi-MB VertexBuffer3D each frame and its element count drifts by a
      // few hundred per frame, so exact sizing meant every frame carved a new
      // segment and never reused the previous one. Small payloads keep exact
      // sizes (rounding them would waste memory for no reuse benefit).
      this.line(`if ((size_t)cap * sizeof(${ec}) >= GC_BIG_CLASS) { int p2 = 1; while (p2 > 0 && p2 < cap) p2 <<= 1; if (p2 > 0) cap = p2; }`);
      this.line(`${ec}* nd = (${ec}*)gc_alloc(${isPtr ? 'GCT_PTR_ARRAY' : 'GCT_RAW'}, (size_t)cap * sizeof(${ec}));`);
      this.line(`if (v->data != NULL && v->length > 0) memcpy(nd, v->data, (size_t)v->length * sizeof(${ec}));`);
      this.line('v->data = nd;');
      this.line('v->capacity = cap;');
      this.line('gc_write_barrier((void*)nd);');
      if (isPtr) this.line('for (int i = 0; i < v->length; i++) gc_write_barrier((void*)v->data[i]);');
      this.indent--;
      this.line('}');
      this.line(`int as_vector_${key}_push(as_vector_${key}* v, ${ec} e) {`);
      this.indent++;
      this.line(`if (v->length == v->capacity) as_vector_${key}_grow(v, v->capacity ? v->capacity * 2 : 4);`);
      this.line('v->data[v->length++] = e;');
      if (isPtr) this.line('gc_write_barrier((void*)e);');
      else if (elem.kind === 'interface') this.line('gc_write_barrier((void*)e.obj);');
      this.line('return v->length;');
      this.indent--;
      this.line('}');
      // Spread-push: vec.push.apply(vec, argsArray) (Starling idiom). Unboxes each
      // array element and pushes it into this vector.
      {
        let ux: string;
        switch (elem.kind) {
          case 'int': ux = 'as_v_int_val(a->data[i])'; break;
          case 'uint': ux = 'as_v_uint_val(a->data[i])'; break;
          case 'number': ux = 'as_v_num_val(a->data[i])'; break;
          case 'bool': ux = 'as_v_bool_val(a->data[i])'; break;
          case 'string': ux = 'as_v_str_val(a->data[i])'; break;
          case 'object': ux = `((${elem.className}*)as_v_obj_val(a->data[i]))`; break;
          case 'interface': ux = `((${elem.name}){ (void*)as_v_obj_val(a->data[i]), (${elem.name}_vtable*)as_iface_lookup(as_v_obj_val(a->data[i]), "${elem.name}") })`; break;
          case 'array': ux = '((as_array*)as_v_obj_val(a->data[i]))'; break;
          case 'vector': ux = `((as_vector_${this.vectorCName((elem as any).elem)}*)as_v_obj_val(a->data[i]))`; break;
          case 'record': ux = '((as_object*)as_v_obj_val(a->data[i]))'; break;
          case 'dict': ux = '((as_dict*)as_v_obj_val(a->data[i]))'; break;
          case 'class': ux = '((as_class*)as_v_obj_val(a->data[i]))'; break;
          case 'function': ux = '((as_fn)as_v_obj_val(a->data[i]))'; break;
          default: ux = 'a->data[i]'; break;
        }
        this.line(`int as_vector_${key}_push_all(as_vector_${key}* v, as_array* a) {`);
        this.indent++;
        this.line('if (a == NULL) return v->length;');
        this.line(`for (int i = 0; i < a->length; i++) as_vector_${key}_push(v, ${ux});`);
        this.line('return v->length;');
        this.indent--;
        this.line('}');
      }
      this.line(`${ec} as_vector_${key}_pop(as_vector_${key}* v) {`);
      this.indent++;
      this.line(`if (v->length == 0) { as_throw(RangeError_new("Vector index out of bounds", 0)); return ${defExpr}; }`);
      this.line('return v->data[--v->length];');
      this.indent--;
      this.line('}');
      this.line(`${ec} as_vector_${key}_shift(as_vector_${key}* v) {`);
      this.indent++;
      this.line(`if (v->length == 0) { as_throw(RangeError_new("Vector index out of bounds", 0)); return ${defExpr}; }`);
      this.line(`${ec} e = v->data[0];`);
      this.line('for (int i = 1; i < v->length; i++) v->data[i - 1] = v->data[i];');
      this.line('v->length--;');
      this.line('return e;');
      this.indent--;
      this.line('}');
      this.line(`int as_vector_${key}_unshift(as_vector_${key}* v, ${ec} e) {`);
      this.indent++;
      this.line(`if (v->length == v->capacity) as_vector_${key}_grow(v, v->capacity ? v->capacity * 2 : 4);`);
      this.line('for (int i = v->length; i > 0; i--) v->data[i] = v->data[i - 1];');
      this.line('v->data[0] = e;');
      this.line('v->length++;');
      if (isPtr) this.line('gc_write_barrier((void*)e);');
      else if (elem.kind === 'interface') this.line('gc_write_barrier((void*)e.obj);');
      this.line('return v->length;');
      this.indent--;
      this.line('}');
      this.line(`${ec} as_vector_${key}_get(as_vector_${key}* v, int i) {`);
      this.indent++;
      this.line(`if (i < 0 || i >= v->length) { as_throw(RangeError_new("Vector index out of bounds", 0)); return ${defExpr}; }`);
      this.line('return v->data[i];');
      this.indent--;
      this.line('}');
      this.line(`void as_vector_${key}_set(as_vector_${key}* v, int i, ${ec} e) {`);
      this.indent++;
      this.line(`if (i < 0 || i > v->length) { as_throw(RangeError_new("Vector index out of bounds", 0)); return; }`);
      // AS3 `vec[vec.length] = x` appends (grows the Vector by one), unlike a plain
      // C array write. An index equal to the current length is therefore routed
      // through push (which grows the buffer and applies the write barrier), and
      // only strictly-out-of-range indices throw.
      this.line(`if (i == v->length) { as_vector_${key}_push(v, e); return; }`);
      this.line('v->data[i] = e;');
      if (isPtr) this.line('gc_write_barrier((void*)e);');
      else if (elem.kind === 'interface') this.line('gc_write_barrier((void*)e.obj);');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_new_sized(int n) {`);
      this.indent++;
      this.line(`as_vector_${key}* v = as_vector_${key}_new();`);
      this.line(`for (int i = 0; i < n; i++) as_vector_${key}_push(v, ${defExpr});`);
      this.line('return v;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_make(int n, ${ec}* items) {`);
      this.indent++;
      this.line(`as_vector_${key}* v = as_vector_${key}_new();`);
      this.line(`for (int i = 0; i < n; i++) as_vector_${key}_push(v, items[i]);`);
      this.line('return v;');
      this.indent--;
      this.line('}');
      this.line(`int as_vector_${key}_indexOf(as_vector_${key}* v, ${ec} e) {`);
      this.indent++;
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line(`if (${this.vectorElemEq(elem, 'v->data[i]', 'e')}) return i;`);
      this.indent--;
      this.line('}');
      this.line('return -1;');
      this.indent--;
      this.line('}');
      this.line(`char* as_vector_${key}_join(as_vector_${key}* v, const char* sep) {`);
      this.indent++;
      this.line('if (v->length == 0) return (char*)"";');
      this.line('size_t total = 0;');
      this.line('char** parts = (char**)malloc(sizeof(char*) * v->length);');
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line(`parts[i] = ${this.vectorElemToStr(elem, 'v->data[i]')};`);
      this.line('total += strlen(parts[i]);');
      this.indent--;
      this.line('}');
      this.line('size_t seplen = strlen(sep);');
      this.line('char* r = as_str_alloc(total + seplen * (v->length - 1) + 1);');
      this.line('char* p = r;');
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line('if (i > 0) { memcpy(p, sep, seplen); p += seplen; }');
      this.line('size_t n = strlen(parts[i]); memcpy(p, parts[i], n); p += n;');
      this.indent--;
      this.line('}');
      this.line('*p = 0;');
      this.line('free(parts);');
      this.line('return r;');
      this.indent--;
      this.line('}');
      this.line(`void as_vector_${key}_setLength(as_vector_${key}* v, int n) {`);
      this.indent++;
      this.line('if (n < 0) { as_throw(RangeError_new("Vector length cannot be negative", 0)); return; }');
      this.line('if (n < v->length) { v->length = n; return; }');
      // Growth is amortised from whatever capacity already exists, but a vector
      // that has never allocated (capacity 0) must not climb the doubling
      // ladder: Starling rebuilds a multi-MB Vector.<Number> in one
      // setLength() call per frame (VertexBuffer3D), so 4, 8, ... up to the
      // full size would allocate and copy every rung only to discard it. Start
      // at n: one allocation, and later pushes still double from there.
      this.line('int cap = v->capacity ? v->capacity : n;');
      this.line('while (cap < n) cap *= 2;');
      this.line(`as_vector_${key}_grow(v, cap);`);
      this.line(`for (int i = v->length; i < n; i++) v->data[i] = ${defExpr};`);
      this.line('v->length = n;');
      this.indent--;
      this.line('}');
      // ---- higher-order / sequence methods ----
      // Box/unbox reuse the same as_value representation the Array higher-order
      // methods use, so Vector callbacks receive (element, index, vector) exactly
      // like Array callbacks receive (element, index, array). A temporary is used
      // for the unboxed element so interface unboxes (which contain a comma in
      // their struct literal) never break the push() argument list.
      const boxElem = (expr: string): string => this.boxExpr({ code: expr, type: elem });
      const unboxElem = (expr: string): string => this.unboxAny({ code: expr, type: { kind: 'any' } as CType }, elem);
      const defaultCmp = (a: string, b: string): string => {
        if (elem.kind === 'string') return `strcmp(${a}, ${b})`;
        if (elem.kind === 'object') return `strcmp(as_obj_to_str((void*)(${a})), as_obj_to_str((void*)(${b})))`;
        if (elem.kind === 'interface') return `strcmp(as_obj_to_str(${a}.obj), as_obj_to_str(${b}.obj))`;
        return `((${a}) > (${b}) ? 1 : ((${a}) < (${b}) ? -1 : 0))`;
      };
      this.line(`static void as_vector_${key}_ensure(as_vector_${key}* v, int need) {`);
      this.indent++;
      this.line('if (need <= v->capacity) return;');
      // Same reasoning as setLength: a fresh vector allocates exactly what the
      // caller needs instead of walking a doubling ladder to reach it.
      this.line('int cap = v->capacity ? v->capacity : need;');
      this.line('while (cap < need) cap *= 2;');
      this.line(`as_vector_${key}_grow(v, cap);`);
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_slice(as_vector_${key}* v, int from, int to) {`);
      this.indent++;
      this.line('if (from < 0) from = 0;');
      this.line('if (to > v->length) to = v->length;');
      this.line('int n = to - from;');
      this.line(`as_vector_${key}* r = as_vector_${key}_new();`);
      this.line('if (n <= 0) return r;');
      this.line(`for (int i = 0; i < n; i++) as_vector_${key}_push(r, v->data[from + i]);`);
      this.line('return r;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_concat(as_vector_${key}* a, as_vector_${key}* b) {`);
      this.indent++;
      this.line(`as_vector_${key}* r = as_vector_${key}_new();`);
      this.line(`for (int i = 0; i < a->length; i++) as_vector_${key}_push(r, a->data[i]);`);
      this.line(`for (int i = 0; i < b->length; i++) as_vector_${key}_push(r, b->data[i]);`);
      this.line('return r;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_splice(as_vector_${key}* v, int start, int deleteCount, ${ec}* items, int itemCount) {`);
      this.indent++;
      this.line('if (start < 0) start = 0;');
      this.line('if (start > v->length) start = v->length;');
      this.line('if (deleteCount < 0) deleteCount = 0;');
      this.line('if (deleteCount > v->length - start) deleteCount = v->length - start;');
      this.line(`as_vector_${key}* removed = as_vector_${key}_new();`);
      this.line(`for (int i = 0; i < deleteCount; i++) as_vector_${key}_push(removed, v->data[start + i]);`);
      this.line('int tail = v->length - start - deleteCount;');
      this.line('int delta = itemCount - deleteCount;');
      this.line(`if (delta > 0) as_vector_${key}_ensure(v, v->length + delta);`);
      this.line(`if (tail > 0) memmove(&v->data[start + itemCount], &v->data[start + deleteCount], (size_t)tail * sizeof(${ec}));`);
      const itemBarrier = isPtr ? ' gc_write_barrier((void*)items[i]);'
        : (elem.kind === 'interface' ? ' gc_write_barrier((void*)items[i].obj);' : '');
      this.line('for (int i = 0; i < itemCount; i++) { v->data[start + i] = items[i];' + itemBarrier + ' }');
      this.line('v->length += delta;');
      this.line('return removed;');
      this.indent--;
      this.line('}');
      this.line(`${ec} as_vector_${key}_removeAt(as_vector_${key}* v, int index) {`);
      this.indent++;
      this.line('if (index < 0 || index >= v->length) index = v->length - 1;');
      this.line(`${ec} removed = v->data[index];`);
      this.line('if (index < v->length - 1) memmove(&v->data[index], &v->data[index + 1], (size_t)(v->length - index - 1) * sizeof(' + ec + '));');
      this.line('v->length--;');
      this.line('return removed;');
      this.indent--;
      this.line('}');
      this.line(`void as_vector_${key}_insertAt(as_vector_${key}* v, int index, ${ec} e) {`);
      this.indent++;
      this.line('if (index < 0) index = 0;');
      this.line('if (index > v->length) index = v->length;');
      this.line(`as_vector_${key}_ensure(v, v->length + 1);`);
      this.line(`if (index < v->length) memmove(&v->data[index + 1], &v->data[index], (size_t)(v->length - index) * sizeof(${ec}));`);
      const insertBarrier = isPtr ? ' gc_write_barrier((void*)e);'
        : (elem.kind === 'interface' ? ' gc_write_barrier((void*)e.obj);' : '');
      this.line(`v->data[index] = e;${insertBarrier}`);
      this.line('v->length++;');
      this.indent--;
      this.line('}');
      this.line(`void as_vector_${key}_forEach(as_vector_${key}* v, as_fn cb) {`);
      this.indent++;
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line(`as_value args[3] = { ${boxElem('v->data[i]')}, as_v_num((double)i), as_v_obj((void*)v) };`);
      this.line('cb->fn(cb->env, args, 3);');
      this.indent--;
      this.line('}');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_map(as_vector_${key}* v, as_fn cb) {`);
      this.indent++;
      this.line(`as_vector_${key}* r = as_vector_${key}_new();`);
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line(`as_value args[3] = { ${boxElem('v->data[i]')}, as_v_num((double)i), as_v_obj((void*)v) };`);
      this.line('as_value res = cb->fn(cb->env, args, 3);');
      this.line(`${ec} tmp = ${unboxElem('res')};`);
      this.line(`as_vector_${key}_push(r, tmp);`);
      this.indent--;
      this.line('}');
      this.line('return r;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_filter(as_vector_${key}* v, as_fn cb) {`);
      this.indent++;
      this.line(`as_vector_${key}* r = as_vector_${key}_new();`);
      this.line('for (int i = 0; i < v->length; i++) {');
      this.indent++;
      this.line(`as_value args[3] = { ${boxElem('v->data[i]')}, as_v_num((double)i), as_v_obj((void*)v) };`);
      this.line('as_value res = cb->fn(cb->env, args, 3);');
      this.line(`if (as_v_truthy(res)) as_vector_${key}_push(r, v->data[i]);`);
      this.indent--;
      this.line('}');
      this.line('return r;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_sort(as_vector_${key}* v, as_fn cb) {`);
      this.indent++;
      this.line('for (int i = 1; i < v->length; i++) {');
      this.indent++;
      this.line(`${ec} key = v->data[i];`);
      this.line('int j = i - 1;');
      this.line('while (j >= 0) {');
      this.indent++;
      this.line('int c;');
      this.line('if (cb != NULL) {');
      this.indent++;
      this.line(`as_value args[2] = { ${boxElem('v->data[j]')}, ${boxElem('key')} };`);
      this.line('double d = as_v_num_val(cb->fn(cb->env, args, 2));');
      this.line('c = d < 0.0 ? -1 : (d > 0.0 ? 1 : 0);');
      this.indent--;
      this.line('} else {');
      this.indent++;
      this.line(`c = ${defaultCmp('v->data[j]', 'key')};`);
      this.indent--;
      this.line('}');
      this.line('if (c <= 0) break;');
      this.line('v->data[j + 1] = v->data[j];');
      this.line('j--;');
      this.indent--;
      this.line('}');
      this.line('v->data[j + 1] = key;');
      this.indent--;
      this.line('}');
      this.line('return v;');
      this.indent--;
      this.line('}');
      this.line(`as_vector_${key}* as_vector_${key}_reverse(as_vector_${key}* v) {`);
      this.indent++;
      this.line('for (int i = 0, j = v->length - 1; i < j; i++, j--) {');
      this.indent++;
      this.line(`${ec} t = v->data[i]; v->data[i] = v->data[j]; v->data[j] = t;`);
      this.indent--;
      this.line('}');
      this.line('return v;');
      this.indent--;
      this.line('}');
      this.line('');
    }
    // constructors: a separate init function lets a subclass invoke its
    // superclass constructor (via `super(...)`) on the already-allocated object.
    for (const stmt of this.program.body) {
      if (stmt.kind !== 'ClassDecl') continue;
      const name = qualifiedName(stmt.name, stmt.packageName);
      const info = this.symbols.getClass(name)!;
      this.currentClass = name; // so paramDecls / declareVar resolve types in this file's import context
      const ctor = stmt.members.find(
        (m): m is Extract<ClassMember, { kind: 'Constructor' }> => m.kind === 'Constructor',
      );
      const params = this.paramDecls(info.constructor.params);
      const paramNames = info.constructor.params.map((p) => this.cIdent(p.name)).join(', ');

      // init: super() (explicit or implicit) -> own field defaults -> constructor
      // body (no allocation, no vtable write). Inherited fields are NOT re-init'd
      // here: the superclass constructor already set their AS3 defaults.
      const ctorBody = ctor ? ctor.body.body : [];
      // AS3 allows local variable declarations before super() (as long as they
      // do not read `this`/`super`); find the super() call anywhere in the body,
      // not necessarily as the first statement.
      const superIdx = ctorBody.findIndex((s) => s.kind === 'SuperCall');
      const hasNestedSuper = superIdx < 0 && this.containsSuperCall(ctorBody);
      const hasExplicitSuper = superIdx >= 0 || hasNestedSuper;
      // AS3 rule: a subclass whose superclass constructor takes required args
      // must call super(...) explicitly (the implicit super() passes no args).
      if (!hasExplicitSuper && info.superClass) {
        const superInfo = this.symbols.getClass(info.superClass)!;
        if (superInfo.constructor.params.some((p) => p.defaultValue === null && !p.isRest)) {
          throw new CodegenError(
            `class '${name}' must call super(...) explicitly: superclass '${info.superClass}' constructor requires arguments`,
          );
        }
      }
      this.line(`void ${name}_ctor(${name}* o${params ? ', ' + params : ''}) {`);
      this.indent++;
      // Dynamic class (`dynamic class`, or any subclass of one): arbitrary
      // undeclared keys live in the instance's own `_dyn` slot table, so it must
      // exist before the first body statement (as_dyn_set writes through it).
      // Allocated here rather than after super() because a class may legally set
      // properties on `this` before calling super().
      if (info.isDynamic) {
        this.line('o->_dyn = as_object_new();');
        this.line('gc_write_barrier((void*)o->_dyn);');
      }
      if (ctor) {
        this.pushScope();
        this.functionScope = this.scopes[this.scopes.length - 1];
        this.declareVar('this', { kind: 'object', className: name });
        for (const p of ctor.params) this.declareVar(p.name, this.rt(p.type));
        this.line(`${name}* this = o;`);
        this.hoistFunctionLocals(ctorBody);
      }
      // gc_alloc zeroes the instance, so every non-`Number` field already holds
      // its AS3 default (null/0/false/0.0). Only `Number` fields default to NaN,
      // which is NOT the zero bit pattern, so seed them here — BEFORE super() and
      // any constructor body statement — so a field default cannot clobber an
      // assignment that ran before super() (the `o->_bounds = NULL` bug). Field
      // *initializers* (`= value`) still run after super(), per AS3.
      for (const [fname, f] of info.fields) {
        if (f.owner !== name) continue;
        if (!f.init && f.type.kind === 'number') this.line(`o->${this.cIdent(fname)} = NAN;`);
      }
      if (hasNestedSuper) {
        // `super()` is inside a nested conditional/loop. Field *defaults* were
        // seeded above; the body (containing super()) is emitted verbatim below.
        // Field initializers (rare in this shape) follow the body, an
        // approximation only hit by classes with both a nested super() and a
        // field initializer.
      } else if (superIdx >= 0) {
        for (const s of ctorBody.slice(0, superIdx)) this.emitStmt(s);
        this.emitStmt(ctorBody[superIdx]);
      } else if (info.superClass) {
        this.line(`${info.superClass}_ctor((${info.superClass}*)o);`);
      }
      // Field initializers run after super() (AS3). Defaults are already seeded.
      for (const [fname, f] of info.fields) {
        if (f.owner !== name) continue; // inherited fields are set by super()
        if (f.init) {
          this.line(`o->${this.cIdent(fname)} = ${this.convert(this.emitExpr(f.init), f.type)};`);
        }
      }
      if (ctor) {
        const stmts = superIdx >= 0 ? ctorBody.slice(superIdx + 1) : ctorBody;
        this.emitArgsIfUsed({ kind: 'Block', body: stmts }, ctor.params);
        this.emitBlockBody({ kind: 'Block', body: stmts });
        this.currentArgs = null;
        this.functionScope = null;
        this.hoistedLocals = new Set();
        this.popScope();
      }
      this.indent--;
      this.line('}');
      this.line('');

      // new: allocate, set the vtable once, then run init.
      this.line(`${name}* ${name}_new(${params || 'void'}) {`);
      this.indent++;
      this.line(`${name}* o = (${name}*)gc_alloc(GCT_CLASS, sizeof(${name}));`);
      this.line(`o->vtable = &${name}_vt;`);
      this.line(`${name}_ctor(o${paramNames ? ', ' + paramNames : ''});`);
      this.line('return o;');
      this.indent--;
      this.line('}');
      this.line('');
      // No-arg entry point for reflection (`Object(this).constructor as Class`
      // + `new actualClass()`). AS3 semantics: `new Foo()` is legal whenever
      // every parameter has a default; this wrapper supplies those defaults so
      // the registry never stores a NULL factory for such a class. Emitted here
      // (not in emitClassRegistry) because the default expressions must be
      // converted in this class's import context.
      const cparams = info.constructor.params;
      if (cparams.length > 0 && cparams.every((p) => p.defaultValue !== null || p.isRest)) {
        const defaults = cparams
          .map((p) => (p.isRest ? `as_array_new()` : this.convert(this.emitExpr(p.defaultValue!), this.rt(p.type))))
          .join(', ');
        this.line(`${name}* ${name}_new_default(void) { return ${name}_new(${defaults}); }`);
        this.line('');
      }
      this.currentClass = null;
    }
    // methods (instance / static / getter / setter)
    for (const stmt of this.program.body) {
      if (stmt.kind !== 'ClassDecl') continue;
      for (const m of stmt.members) {
        if (m.kind !== 'Method') continue;
        const cname = qualifiedName(stmt.name, stmt.packageName);
        // Set the class context BEFORE resolving the return type and parameter
        // types: `rt` keys off `currentClass.importAlias` so short names like
        // `Rectangle` resolve through THIS class's imports. Resolving first would
        // use the previous class's (or the global) alias and could pull in a
        // same-short-name user class instead of the built-in flash.geom.Rectangle.
        this.currentClass = cname;
        const returnType = this.rt(m.returnType);
        this.line(`// ${cname}.${m.name}`);
        this.currentMethod = m.name;
        this.currentIsStatic = m.isStatic;
        this.currentReturnType = returnType;
        this.pushScope();
        this.functionScope = this.scopes[this.scopes.length - 1];
        this.declareVar('this', { kind: 'object', className: cname });
        for (const p of m.params) this.declareVar(p.name, this.rt(p.type));
        const params = this.paramDecls(m.params);

        if (m.isStatic && m.isGetter) {
          // Static getter: no `this` receiver; `_this` is unused. The `_static`
          // suffix distinguishes it from an instance getter of the same name.
          this.line(`${this.cTypeName(returnType)} ${cname}_get_${m.name}_static(void* _this) {`);
          this.indent++;
          this.line('(void)_this;');
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isStatic && m.isSetter) {
          this.line(`void ${cname}_set_${m.name}_static(void* _this${params ? ', ' + params : ''}) {`);
          this.indent++;
          this.line('(void)_this;');
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isStatic) {
          this.line(`${this.cTypeName(returnType)} ${cname}_${m.name}_static(${params}) {`);
          this.indent++;
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isGetter) {
          this.line(`${this.cTypeName(returnType)} ${cname}_get_${m.name}(void* _this) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isSetter) {
          this.line(`void ${cname}_set_${m.name}(void* _this${params ? ', ' + params : ''}) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else {
          this.line(`${this.cTypeName(returnType)} ${cname}_${m.name}(void* _this${params ? ', ' + params : ''}) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.hoistFunctionLocals(m.body.body);
          this.emitClosureCellLocals();
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        }
        this.functionScope = null;
        this.hoistedLocals = new Set();
        this.popScope();
        this.currentClass = null;
        this.currentMethod = null;
        this.currentIsStatic = false;
        this.currentReturnType = null;
        this.currentArgs = null;
      }
    }
    // free functions
    for (const stmt of this.program.body) {
      if (stmt.kind !== 'FuncDecl') continue;
      const f = this.symbols.getFunc(stmt.name)!;
      this.pushScope();
      this.functionScope = this.scopes[this.scopes.length - 1];
      for (const p of stmt.params) this.declareVar(p.name, this.rt(p.type));
      this.currentReturnType = f.returnType;
      this.line(`${this.cTypeName(f.returnType)} ${stmt.name}(${this.paramDecls(stmt.params)}) {`);
      this.indent++;
      this.hoistFunctionLocals(stmt.body.body);
      this.emitClosureCellLocals();
      this.emitArgsIfUsed(stmt.body, stmt.params);
      this.emitBlockBody(stmt.body);
      this.indent--;
      this.line('}');
      this.line('');
      this.functionScope = null;
      this.hoistedLocals = new Set();
      this.popScope();
      this.currentReturnType = null;
      this.currentArgs = null;
    }
  }

  // Module-level `var`/`const` are hoisted to C file-scope globals so free
  // functions and main() share them. Const gets a real constant initializer;
  // var gets a default initializer and its actual init runs in main() in source
  // order (preserving AS3 top-level sequential execution semantics).
  private emitModuleVars(): void {
    // Every declaration held by the script scope, wherever it is written in the
    // top-level tree (see collectScriptDecls): AS3 gives the script one scope, so a
    // `var` inside a top-level block/`if`/`for` init shares the same slot as a
    // top-level one and survives the block.
    const vars = collectScriptDecls(this.program.body);
    if (vars.length === 0) return;

    for (const v of vars) {
      const ctype = v.type !== null
        ? this.rt(v.type)
        : v.loop
          ? this.loopVarType(v.loop.kind, this.emitExpr(v.loop.iterable).type, v.loop.declared)
          : (v.init ? this.emitExpr(v.init).type : { kind: 'int' });
      this.moduleScope.set(v.name, ctype);
      const cn = this.moduleCName(v.name);
      if (v.isConst && this.isConstExpr(v.init)) {
        this.moduleConsts.add(v.name);
        const e = this.emitExpr(v.init!);
        this.line(`static ${this.constTypeName(ctype)} ${cn} = ${this.convert(e, ctype)};`);
      } else {
        // Mutable file-scope slot; a var's (or runtime-init const's) initializer
        // runs in main() (emitTopLevel) in source order.
        this.line(`static ${this.cTypeName(ctype)} ${cn} = ${this.defaultInit(ctype)};`);
      }
    }
    this.line('');
  }

  // C identifier for a hoisted module-level variable. The `g_` prefix keeps
  // AS3 names from colliding with C library symbols (e.g. `nan` vs math.h's
  // nan()), and remains visibly traceable back to the AS source name.
  private moduleCName(name: string): string {
    return `g_${name}`;
  }

  // C type of a loop variable, derived from the iterable's C type. This is the
  // ONE place the rule lives, so `emitModuleVars` (which must declare the C
  // global before main) and the for-in/for-each emit sites cannot drift apart:
  //   for-in     : Array -> int index; dynamic object -> char* key; Dictionary -> boxed key
  //   for-each-in: element/value type — the source annotation wins when present
  //                (`for each (var s:Sprite in list)`), otherwise the iterable decides
  private loopVarType(kind: 'in' | 'each', it: CType, declared: ASType | null): CType {
    if (kind === 'in') {
      if (it.kind === 'dict') return { kind: 'any' };
      if (it.kind === 'array') return { kind: 'int' };
      return { kind: 'string' }; // record / dynamic Object keys
    }
    if (declared !== null) return this.rt(declared);
    if (it.kind === 'vector') return it.elem;
    if (it.kind === 'xmllist') return { kind: 'xml' };
    return { kind: 'any' }; // Dictionary value, dynamic-object value, Array element
  }

  // True when a loop variable is a script-scope global rather than a block-local:
  // AS3 gives the script exactly one scope, so `for (var k in o) {}` at top level
  // must leave `k` visible to the statements that follow it.
  private isModuleLoopVar(name: string): boolean {
    return this.functionScope === null && this.moduleScope.has(name);
  }

  // Emit a per-class lazy initializer (`C_cinit`) for every class that owns a
  // runtime-initialized static field. AS3 initializes a class's statics on its
  // first access; mirroring that lazily (instead of eagerly in main() in
  // declaration order) sidesteps the classic static-init-order hazard, where one
  // class's static field reads another class's still-NULL static field either
  // directly (`FilterEffect.VERTEX_FORMAT` -> `Effect.VERTEX_FORMAT`) or through
  // a static method (`VertexDataFormat.fromString` -> `sFormats`). Cross-class
  // reads call the other class's `_cinit` first (see `sfRead`), so dependencies
  // resolve recursively; the `_cinit_done` flag breaks cycles like AVM2 does.
  private emitStaticInits(): void {
    if (this.staticFieldInits.length === 0) return;
    const byClass = new Map<string, { cname: string; fname: string; f: FieldInfo }[]>();
    for (const si of this.staticFieldInits) {
      if (!byClass.has(si.cname)) byClass.set(si.cname, []);
      byClass.get(si.cname)!.push(si);
    }
    for (const cname of byClass.keys()) {
      this.line(`static bool ${cname}_cinit_done = false;`);
      this.line(`static void ${cname}_cinit(void);`);
    }
    this.line('');
    for (const [cname, inits] of byClass) {
      this.line(`static void ${cname}_cinit(void) {`);
      this.indent++;
      this.line(`if (${cname}_cinit_done) return;`);
      this.line(`${cname}_cinit_done = true;`);
      for (const si of inits) {
        // Emit each initializer in its declaring class's static context, so
        // protected members resolve and short types map via its imports.
        this.currentClass = cname;
        const init = this.convert(this.emitExpr(si.f.init!), si.f.type);
        this.line(`${si.cname}_${si.fname} = ${init};`);
        this.currentClass = null;
      }
      this.indent--;
      this.line('}');
      this.line('');
    }
  }

  // Read a static field, running the declaring class's `_cinit` first when the
  // field is runtime-initialized (so a read can never observe an uninitialized
  // NULL/default slot). Compile-time-literal consts are emitted at file scope
  // and need no guard.
  private sfRead(owner: string, name: string): string {
    if (this.cinitClasses.has(owner)) return `(${owner}_cinit(), ${owner}_${name})`;
    return `${owner}_${name}`;
  }

  // Write a static field, running the declaring class's `_cinit` first for the
  // same reason as `sfRead` (a `static var`'s initializer must run before any
  // write can overwrite it).
  private sfWrite(owner: string, name: string, value: string): string {
    if (this.cinitClasses.has(owner)) return `(${owner}_cinit(), ${owner}_${name} = ${value})`;
    return `(${owner}_${name} = ${value})`;
  }

  private emitMain(): void {
    this.line('int main(void) {');
    this.indent++;
    this.pushScope();
    // Record this frame as the top of the stack: a collection forced from inside
    // AS3 code (System.gc()) conservatively treats everything between the
    // scanning frame and here as roots (see gc_mark_stack in the preamble).
    this.line('GC_NOTE_STACK_BASE();');
    // Static fields initialize lazily on first access (see emitStaticInits), so
    // main() only runs module-level variable initializers and top-level
    // statements; the demo bootstrap's static reads trigger each class's cinit.
    for (const stmt of this.program.body) {
      this.emitTopLevel(stmt);
    }
    this.popScope();
    this.line('return 0;');
    this.indent--;
    this.line('}');
  }

  // Top-level statements: class/function declarations emit nothing here
  // (already defined); executable statements emit into main().
  private emitTopLevel(stmt: Stmt): void {
    if (stmt.kind === 'ClassDecl' || stmt.kind === 'FuncDecl') return;
    // Module-level var/const are already emitted at file scope by
    // emitModuleVars(); here we only run a var's initializer in place (const
    // needs nothing — its constant initializer lives at file scope).
    if (stmt.kind === 'VarDecl' && this.moduleScope.has(stmt.name)) {
      if (stmt.init) {
        // Same sequencing pass `emitStmt` runs for a function-local initializer:
        // this path bypasses `emitVarDecl`, so without it a module-level
        // `var r = box.get().m();` would inline `get()` twice (see hoistImpure).
        this.sequenceValueExpr(stmt.init, true, true);
        const e = this.emitExpr(stmt.init);
        const ctype = this.moduleScope.get(stmt.name)!;
        this.line(`${this.moduleCName(stmt.name)} = ${this.convert(e, ctype)};`);
      }
      return;
    }
    if (stmt.kind === 'ConstDecl' && this.moduleScope.has(stmt.name)) {
      // A runtime-initialized const (e.g. `const d = new Dictionary()`) still
      // needs its initializer to run once in main(); compile-time-literal const
      // was already initialized at file scope.
      if (!this.isConstExpr(stmt.init)) {
        this.sequenceValueExpr(stmt.init!, true, true);
        const e = this.emitExpr(stmt.init!);
        const ctype = this.moduleScope.get(stmt.name)!;
        this.line(`${this.moduleCName(stmt.name)} = ${this.convert(e, ctype)};`);
      }
      return;
    }
    if (stmt.kind === 'ConstDecls') {
      // Multi-declarator module-level const: emit each runtime-initialized member.
      let anyRuntime = false;
      for (const d of stmt.decls) {
        if (this.moduleScope.has(d.name) && !this.isConstExpr(d.init)) {
          anyRuntime = true;
          break;
        }
      }
      if (anyRuntime) {
        for (const d of stmt.decls) {
          if (this.moduleScope.has(d.name) && !this.isConstExpr(d.init)) {
            this.sequenceValueExpr(d.init!, true, true);
            const e = this.emitExpr(d.init!);
            const ctype = this.moduleScope.get(d.name)!;
            this.line(`${this.moduleCName(d.name)} = ${this.convert(e, ctype)};`);
          }
        }
      }
      return;
    }
    this.emitStmt(stmt);
  }

  // ---------- statements ----------

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'VarDecl': {
        if (stmt.init) this.sequenceValueExpr(stmt.init, true, true);
        const d = this.emitVarDecl(stmt.name, stmt.type, stmt.init);
        if (d) this.line(`${d};`);
        break;
      }
      case 'VarDecls': {
        for (const d of stmt.decls) {
          if (d.init) this.sequenceValueExpr(d.init, true, true);
          const e = this.emitVarDecl(d.name, d.type, d.init);
          if (e) this.line(`${e};`);
        }
        break;
      }
      case 'ConstDecl': {
        if (stmt.init) this.sequenceValueExpr(stmt.init, true, true);
        // A const in the script scope (even inside a block in the top-level tree)
        // lives in a file-scope slot emitted by emitModuleVars: a compile-time
        // literal const is already initialized there, a runtime-initialized one
        // (e.g. `const d = new Dictionary()`) needs one assignment here.
        if (this.functionScope === null && this.moduleScope.has(stmt.name)) {
          if (!this.isConstExpr(stmt.init)) {
            const ctype = this.moduleScope.get(stmt.name)!;
            const e = this.emitExpr(stmt.init!);
            this.line(`${this.moduleCName(stmt.name)} = ${this.convert(e, ctype)};`);
          }
          break;
        }
        const ctype = stmt.type !== null ? this.rt(stmt.type) : this.emitExpr(stmt.init!).type;
        this.declareVar(stmt.name, ctype);
        const e = this.emitExpr(stmt.init!);
        this.line(`${this.constTypeName(ctype)} ${this.cIdent(stmt.name)} = ${this.convert(e, ctype)};`);
        break;
      }
      case 'ConstDecls': {
        for (const d of stmt.decls) {
          if (d.init) this.sequenceValueExpr(d.init, true, true);
          if (this.functionScope === null && this.moduleScope.has(d.name)) {
            if (!this.isConstExpr(d.init)) {
              const ctype = this.moduleScope.get(d.name)!;
              const e = this.emitExpr(d.init!);
              this.line(`${this.moduleCName(d.name)} = ${this.convert(e, ctype)};`);
            }
            continue;
          }
          const ctype = d.type !== null ? this.rt(d.type) : this.emitExpr(d.init!).type;
          this.declareVar(d.name, ctype);
          const e = this.emitExpr(d.init!);
          this.line(`${this.constTypeName(ctype)} ${this.cIdent(d.name)} = ${this.convert(e, ctype)};`);
        }
        break;
      }
      case 'ExprStmt': {
        this.sequenceValueExpr(stmt.expr, false, true);
        // A getter/setter update (`prop++`) was already expanded into a getter
        // read + setter write by sequenceValueExpr; emitExpr would only reproduce
        // the invalid `get_prop(...)++` rvalue.
        if (stmt.expr.kind === 'Update' && this.resolveUpdateSetter(stmt.expr.target)) {
          break;
        }
        const e = this.emitExpr(stmt.expr);
        // A write-barrier field assignment's comma expression carries a value that
        // is intentionally discarded in statement position; (void) silences clang's
        // -Wunused-value while the value stays for chained-assignment contexts.
        this.line(e.discard ? `(void)(${e.code});` : `${e.code};`);
        break;
      }
      case 'Block':
        this.pushScope();
        this.emitBlockBody(stmt);
        this.popScope();
        break;
      case 'If': {
        this.sequenceValueExpr(stmt.cond, true, true);
        const c = this.emitExpr(stmt.cond);
        this.line(`if (${this.condExpr(c)}) {`);
        this.indent++;
        this.emitStmt(stmt.then);
        this.indent--;
        if (stmt.else) {
          this.line('} else {');
          this.indent++;
          this.emitStmt(stmt.else);
          this.indent--;
        }
        this.line('}');
        break;
      }
      case 'While':
        this.emitWhile(stmt, null);
        break;
      case 'DoWhile':
        this.emitDoWhile(stmt, null);
        break;
      case 'For':
        this.emitFor(stmt, null);
        break;
      case 'ForIn': {
        // A `var` here is a script-scope global at top level (AS3 has one script
        // scope), so emit into the hoisted global `g_x` instead of declaring a
        // block-local; `emitModuleVars` already emitted its C declaration.
        const modVar = stmt.declares && this.isModuleLoopVar(stmt.varName);
        const it = this.emitExpr(stmt.iterable);
        it.code = this.hoistCollection(it);
        // for-in iterates array indices (int), Dictionary object keys, or
        // dynamic-object string keys.
        const isRecord = it.type.kind === 'record' || it.type.kind === 'any'
          || (it.type.kind === 'object' && it.type.className === 'Object');
        const isDict = it.type.kind === 'dict';
        if (it.type.kind !== 'array' && !isRecord && !isDict) {
          throw new CodegenError('for-in requires an Array, Dictionary, or dynamic Object');
        }
        const idx = this.tmpName('i');
        this.pushScope();
        this.breakTargets.push(this.tryFrames.length);
        this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
        if (isDict) {
          // Dictionary keys are boxed as_value. `for (var key:* in dict)` declares
          // an `any` loop var that keeps the box; an existing typed loop var
          // (`for (tgt:Object in dict)`) must unbox the key to its declared type.
          if (stmt.declares && !modVar) this.declareVar(stmt.varName, { kind: 'any' });
          this.line(`for (int ${idx} = 0; ${idx} < (${it.code})->length; ${idx}++) {`);
          this.indent++;
          if (stmt.declares) {
            const lhs = modVar ? this.moduleCName(stmt.varName) : `as_value ${this.cIdent(stmt.varName)}`;
            this.line(`${lhs} = (${it.code})->keys[${idx}];`);
          } else {
            const keyVal = { code: `(${it.code})->keys[${idx}]`, type: { kind: 'any' } as CType };
            this.line(`${this.cIdent(stmt.varName)} = ${this.unboxAny(keyVal, this.emitVar(stmt.varName).type)};`);
          }
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        } else if (isRecord) {
          const objCode = it.type.kind === 'record'
            ? it.code
            : `((as_object*)${it.type.kind === 'any' ? `as_v_obj_val(${it.code})` : it.code})`;
          if (stmt.declares && !modVar) this.declareVar(stmt.varName, { kind: 'string' });
          this.line(`for (int ${idx} = 0; ${idx} < (${objCode})->length; ${idx}++) {`);
          this.indent++;
          const recLhs = stmt.declares
            ? (modVar ? this.moduleCName(stmt.varName) : `char* ${this.cIdent(stmt.varName)}`)
            : this.cIdent(stmt.varName);
          this.line(`${recLhs} = (${objCode})->keys[${idx}];`);
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        } else {
          if (stmt.declares && !modVar) this.declareVar(stmt.varName, { kind: 'int' });
          this.line(`for (int ${idx} = 0; ${idx} < (${it.code})->length; ${idx}++) {`);
          this.indent++;
          const arrLhs = stmt.declares
            ? (modVar ? this.moduleCName(stmt.varName) : `int ${this.cIdent(stmt.varName)}`)
            : this.cIdent(stmt.varName);
          this.line(`${arrLhs} = ${idx};`);
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        }
        this.continueTargets.pop();
        this.breakTargets.pop();
        this.popScope();
        break;
      }
      case 'ForEachIn': {
        const modVar = stmt.declares && this.isModuleLoopVar(stmt.varName);
        const arr = this.emitExpr(stmt.iterable);
        arr.code = this.hoistCollection(arr);
        // XMLList iteration: `for each (child in xml.children)` walks the list's
        // items (each an XML node), mirroring the Array loop below.
        if (arr.type.kind === 'xmllist') {
          const idx = this.tmpName('i');
          this.pushScope();
          this.breakTargets.push(this.tryFrames.length);
          this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
          this.line(`for (int ${idx} = 0; ${idx} < (${arr.code})->length; ${idx}++) {`);
          this.indent++;
          const elem = { code: `(${arr.code}->items[${idx}])`, type: { kind: 'xml' } as CType };
          if (stmt.declares) {
            const elemType = this.loopVarType('each', arr.type, stmt.varType);
            if (!modVar) this.declareVar(stmt.varName, elemType);
            const lhs = modVar ? this.moduleCName(stmt.varName) : `${this.cTypeName(elemType)} ${this.cIdent(stmt.varName)}`;
            this.line(`${lhs} = ${this.convert(elem, elemType)};`);
          } else {
            const existing = this.emitVar(stmt.varName);
            this.line(`${existing.code} = ${this.convert(elem, existing.type)};`);
          }
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
          this.continueTargets.pop();
          this.breakTargets.pop();
          this.popScope();
          break;
        }
        if (arr.type.kind !== 'array' && arr.type.kind !== 'vector' && arr.type.kind !== 'dict' && arr.type.kind !== 'record' && !(arr.type.kind === 'object' && arr.type.className === 'Object')) {
          throw new CodegenError('for-each-in requires an Array, Vector, Dictionary, Object or XMLList');
        }
        if (arr.type.kind === 'vector') {
          const key = this.vectorCName(arr.type.elem);
          const idx = this.tmpName('i');
          this.pushScope();
          this.breakTargets.push(this.tryFrames.length);
          this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
          this.line(`for (int ${idx} = 0; ${idx} < (${arr.code})->length; ${idx}++) {`);
          this.indent++;
          const elem = { code: `as_vector_${key}_get(${arr.code}, ${idx})`, type: arr.type.elem };
          if (stmt.declares) {
            const elemType = this.loopVarType('each', arr.type, stmt.varType);
            if (!modVar) this.declareVar(stmt.varName, elemType);
            const lhs = modVar ? this.moduleCName(stmt.varName) : `${this.cTypeName(elemType)} ${this.cIdent(stmt.varName)}`;
            this.line(`${lhs} = ${this.convert(elem, elemType)};`);
          } else {
            const existing = this.emitVar(stmt.varName);
            this.line(`${existing.code} = ${this.convert(elem, existing.type)};`);
          }
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
          this.continueTargets.pop();
          this.breakTargets.pop();
          this.popScope();
          break;
        }
        if (arr.type.kind === 'dict') {
          // Dictionary iteration walks its values (AS3 for-each-in over a
          // Dictionary yields the values, not the keys).
          const idx = this.tmpName('i');
          this.pushScope();
          this.breakTargets.push(this.tryFrames.length);
          this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
          this.line(`for (int ${idx} = 0; ${idx} < (${arr.code})->length; ${idx}++) {`);
          this.indent++;
          const elem = { code: `(${arr.code}->vals[${idx}])`, type: { kind: 'any' } as CType };
          if (stmt.declares) {
            const elemType = this.loopVarType('each', arr.type, stmt.varType);
            if (!modVar) this.declareVar(stmt.varName, elemType);
            const lhs = modVar ? this.moduleCName(stmt.varName) : `${this.cTypeName(elemType)} ${this.cIdent(stmt.varName)}`;
            this.line(`${lhs} = ${this.convert(elem, elemType)};`);
          } else {
            const existing = this.emitVar(stmt.varName);
            this.line(`${existing.code} = ${this.unboxAny(elem, existing.type)};`);
          }
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
          this.continueTargets.pop();
          this.breakTargets.pop();
          this.popScope();
          break;
        }
        if (arr.type.kind === 'record' || (arr.type.kind === 'object' && arr.type.className === 'Object')) {
          // for-each-in over a dynamic object (record literal or `Object`)
          // iterates its dynamic slot VALUES (AS3 for-each semantics).
          const objCode = arr.type.kind === 'record' ? arr.code : `((as_object*)${arr.code})`;
          const idx = this.tmpName('i');
          this.pushScope();
          this.breakTargets.push(this.tryFrames.length);
          this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
          this.line(`for (int ${idx} = 0; ${idx} < (${objCode})->length; ${idx}++) {`);
          this.indent++;
          const elem = { code: `(${objCode}->vals[${idx}])`, type: { kind: 'any' } as CType };
          if (stmt.declares) {
            const elemType = this.loopVarType('each', arr.type, stmt.varType);
            if (!modVar) this.declareVar(stmt.varName, elemType);
            const lhs = modVar ? this.moduleCName(stmt.varName) : `${this.cTypeName(elemType)} ${this.cIdent(stmt.varName)}`;
            this.line(`${lhs} = ${this.convert(elem, elemType)};`);
          } else {
            const existing = this.emitVar(stmt.varName);
            this.line(`${existing.code} = ${this.unboxAny(elem, existing.type)};`);
          }
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
          this.continueTargets.pop();
          this.breakTargets.pop();
          this.popScope();
          break;
        }
        const idx = this.tmpName('i');
        this.pushScope();
        this.breakTargets.push(this.tryFrames.length);
        this.continueTargets.push({ depth: this.tryFrames.length, label: null, used: false });
        this.line(`for (int ${idx} = 0; ${idx} < (${arr.code})->length; ${idx}++) {`);
        this.indent++;
        const elem = { code: `as_array_get(${arr.code}, ${idx})`, type: { kind: 'any' } as CType };
        if (stmt.declares) {
          const elemType = this.loopVarType('each', arr.type, stmt.varType);
          if (!modVar) this.declareVar(stmt.varName, elemType);
          const lhs = modVar ? this.moduleCName(stmt.varName) : `${this.cTypeName(elemType)} ${this.cIdent(stmt.varName)}`;
          this.line(`${lhs} = ${this.convert(elem, elemType)};`);
        } else {
          // No `var`: iterate into an already-declared variable. Its type comes
          // from the enclosing scope (not the loop annotation), and an `any` loop
          // var keeps the box while a typed one unboxes the element. The C name
          // must come from emitVar (a module-level var is `g_x`, not `x`).
          const existing = this.emitVar(stmt.varName);
          this.line(`${existing.code} = ${this.unboxAny(elem, existing.type)};`);
        }
        this.emitStmt(stmt.body);
        this.indent--;
        this.line('}');
        this.continueTargets.pop();
        this.breakTargets.pop();
        this.popScope();
        break;
      }
      case 'Switch': {
        this.sequenceValueExpr(stmt.disc, true, true);
        const disc = this.emitExpr(stmt.disc);
        if (disc.type.kind === 'int' || disc.type.kind === 'uint') {
          this.emitSwitchIntegral(stmt, disc);
        } else {
          this.emitSwitchChained(stmt, disc);
        }
        break;
      }
      case 'Break': {
        if (stmt.label) {
          const lbl = this.findLabel(stmt.label);
          if (!lbl) throw new CodegenError(`undefined label '${stmt.label}'`);
          this.emitUnwind(lbl.tryDepth);
          this.line(`goto ${lbl.cName}__end;`);
        } else if (this.suppressBreak === 0) {
          this.emitUnwind(this.breakTargets[this.breakTargets.length - 1]);
          this.line('break;');
        }
        break;
      }
      case 'Continue': {
        if (stmt.label) {
          const lbl = this.findLabel(stmt.label);
          if (!lbl) throw new CodegenError(`undefined label '${stmt.label}'`);
          this.emitUnwind(lbl.tryDepth);
          this.line(`goto ${lbl.cName}__continue;`);
        } else {
          // `continue` must re-run the loop's condition (and, for a `for`, its
          // update). A rewritten loop puts those behind a label, so an unlabelled
          // continue jumps there rather than to the C loop's own back edge.
          const tgt = this.continueTargets[this.continueTargets.length - 1];
          this.emitUnwind(tgt.depth);
          if (tgt.label) {
            tgt.used = true;
            this.line(`goto ${tgt.label};`);
          } else {
            this.line('continue;');
          }
        }
        break;
      }
      case 'Label': {
        const cName = this.tmpName('lbl');
        this.labels.push({ asName: stmt.name, cName, tryDepth: this.tryFrames.length });
        const cont = `${cName}__continue`;
        if (stmt.body.kind === 'While') this.emitWhile(stmt.body, cont);
        else if (stmt.body.kind === 'For') this.emitFor(stmt.body, cont);
        else if (stmt.body.kind === 'DoWhile') this.emitDoWhile(stmt.body, cont);
        else this.emitStmt(stmt.body);
        this.line(`${cName}__end: ;`);
        this.labels.pop();
        break;
      }
      case 'Return': {
        if (stmt.value) {
          this.sequenceValueExpr(stmt.value, true, true);
          const e = this.emitExpr(stmt.value);
          const code = this.currentReturnType ? this.convert(e, this.currentReturnType) : e.code;
          if (this.tryFrames.length === 0) {
            this.line(`return ${code};`);
          } else {
            // AS3 evaluates the return value first, then runs any pending finally
            // blocks, then returns. Capture the value, unwind try frames, return.
            const retType = this.currentReturnType ?? e.type;
            const t = this.tmpName('ret');
            this.line(`${this.cTypeName(retType)} ${t} = ${code};`);
            this.emitUnwind(0);
            this.line(`return ${t};`);
          }
        } else {
          if (this.tryFrames.length > 0) this.emitUnwind(0);
          this.line('return;');
        }
        break;
      }
      case 'SuperCall': {
        if (!this.currentClass) throw new CodegenError("'super' used outside a constructor");
        const info = this.symbols.getClass(this.currentClass)!;
        if (!info.superClass) throw new CodegenError(`class '${this.currentClass}' has no superclass`);
        const superInfo = this.symbols.getClass(info.superClass)!;
        const args = this.emitArgs(superInfo.constructor.params, stmt.args);
        const callArgs = args ? ', ' + args : '';
        this.line(`${info.superClass}_ctor((${info.superClass}*)this${callArgs});`);
        break;
      }
      case 'Throw':
        this.emitThrow(stmt);
        break;
      case 'Try':
        this.emitTry(stmt);
        break;
      case 'FuncDecl':
      case 'ClassDecl':
        break; // handled in emitDefinitions
    }
  }

  private emitBlockBody(block: Block): void {
    for (const s of block.body) this.emitStmt(s);
  }

  // Resolve an AS label name to the most recent matching active label.
  private findLabel(name: string): { asName: string; cName: string; tryDepth: number } | null {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      if (this.labels[i].asName === name) return this.labels[i];
    }
    return null;
  }

  // Emit cleanup for every open try frame above `targetDepth` (innermost first):
  // pop the jmp stack for still-active frames and re-run any pending finally
  // body. Used by return/break/continue that exit a try block before its inline
  // `as_jmp_depth--` / finally code is reached. Re-running the finally here (in
  // a nested C block so its locals stay isolated) keeps AS3's guarantee that
  // `finally` always runs, even when a return/break/continue jumps out of the try.
  private emitUnwind(targetDepth: number): void {
    for (let i = this.tryFrames.length - 1; i >= targetDepth; i--) {
      const f = this.tryFrames[i];
      if (f.active) this.line('as_jmp_depth--;');
      const fb = f.finallyBody;
      if (fb) {
        // Temporarily mark this frame as already-unwound so a return/break/
        // continue *inside* the finally body does not re-run it (which would
        // double-pop the jmp stack); restore afterward for later exits.
        const savedActive = f.active;
        f.active = false;
        f.finallyBody = null;
        this.line('{');
        this.indent++;
        this.pushScope();
        this.emitBlockBody(fb);
        this.popScope();
        this.indent--;
        this.line('}');
        f.active = savedActive;
        f.finallyBody = fb;
      }
    }
  }

  // Emit loop statements with an optional `continue` label placed at the end of
  // the loop body (where C loops naturally jump back to the condition/update).
  //
  // AS3 evaluates the loop condition (and a `for`'s update) **once per
  // iteration** — and in C some forms mention a sub-expression several times
  // (`p.get().n > 0` expands to `p->vtable->get_n(p->vtable->get(p), …)`, so
  // `get()` runs twice). `sequenceValueExpr` fixes that by hoisting the impure
  // operand into a temp, but its prelude must run *inside* the loop: a prelude
  // statement before the loop would freeze the value across iterations and break
  // `while (a.x = f())`. So when — and only when — the sequencing pass actually
  // has something to hoist, the loop is rewritten around the controls:
  //
  //   while (cond) body      ->  for (;;) { <cond prelude> if (!(cond)) break; body }
  //   do body while (cond)   ->  for (;;) { body; <cond prelude> if (!(cond)) break; }
  //   for (init; cond; upd)  ->  for (init; ;) { <cond prelude> if (!(cond)) break;
  //                                                body; <upd prelude> <upd>; }
  //
  // The condition/update leave the C header, so an unlabelled `continue` can no
  // longer reach them by falling off the body — it `goto`s the label placed in
  // front of them instead (recorded in `continueTargets`). Loops with nothing to
  // hoist keep the readable `while (cond)` / `for (a; b; c)` form.
  private emitWhile(stmt: Extract<Stmt, { kind: 'While' }>, continueLabel: string | null): void {
    const depth = this.tryFrames.length;
    this.breakTargets.push(depth);
    const prelude = this.captureSequence(stmt.cond, true, true);
    const c = this.emitExpr(stmt.cond);
    if (prelude.length === 0) {
      this.continueTargets.push({ depth, label: null, used: false });
      this.line(`while (${this.condExpr(c)}) {`);
      this.indent++;
      this.emitStmt(stmt.body);
      if (continueLabel) this.line(`${continueLabel}: ;`);
      this.indent--;
      this.line('}');
      this.continueTargets.pop();
      this.breakTargets.pop();
      return;
    }
    const tgt = { depth, label: this.tmpName('cont'), used: false };
    this.continueTargets.push(tgt);
    this.line('for (;;) {');
    this.indent++;
    this.emitLines(prelude);
    this.line(`if (!(${this.condExpr(c)})) break;`);
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    if (tgt.used) this.line(`${tgt.label}: ;`);
    this.indent--;
    this.line('}');
    this.continueTargets.pop();
    this.breakTargets.pop();
  }

  private emitDoWhile(stmt: Extract<Stmt, { kind: 'DoWhile' }>, continueLabel: string | null): void {
    const depth = this.tryFrames.length;
    this.breakTargets.push(depth);
    const prelude = this.captureSequence(stmt.cond, true, true);
    const c = this.emitExpr(stmt.cond);
    if (prelude.length === 0) {
      this.continueTargets.push({ depth, label: null, used: false });
      this.line('do {');
      this.indent++;
      this.emitStmt(stmt.body);
      if (continueLabel) this.line(`${continueLabel}: ;`);
      this.indent--;
      this.line(`} while (${this.condExpr(c)});`);
      this.continueTargets.pop();
      this.breakTargets.pop();
      return;
    }
    // A `continue` must re-test the condition, so the check moves to the end of
    // an unconditional loop body (after the label).
    const tgt = { depth, label: this.tmpName('cont'), used: false };
    this.continueTargets.push(tgt);
    this.line('for (;;) {');
    this.indent++;
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    if (tgt.used) this.line(`${tgt.label}: ;`);
    this.emitLines(prelude);
    this.line(`if (!(${this.condExpr(c)})) break;`);
    this.indent--;
    this.line('}');
    this.continueTargets.pop();
    this.breakTargets.pop();
  }

  private emitFor(stmt: Extract<Stmt, { kind: 'For' }>, continueLabel: string | null): void {
    this.pushScope();
    const depth = this.tryFrames.length;
    this.breakTargets.push(depth);
    // The `for` init runs exactly once, so it gets the same sequencing pass a
    // normal statement would (an impure method receiver or `x.f = v` in the init
    // would otherwise appear twice in the emitted C). It is emitted first, so the
    // condition/update capture below sees the loop variables in scope.
    let init = '';
    if (stmt.init) {
      if (stmt.init.kind === 'VarDecl') {
        if (stmt.init.init) this.sequenceValueExpr(stmt.init.init, true, true);
        init = this.emitVarDecl(stmt.init.name, stmt.init.type, stmt.init.init);
      } else if (stmt.init.kind === 'VarDecls') {
        // C for-init admits only one declaration (or one type with comma
        // declarators). Multi-declarator AS3 `for (var i:int=0, len:int=n; ...)`
        // may mix types, so emit each declarator as a standalone statement before
        // the loop and leave the for-init empty. All share the loop's pushed scope.
        for (const d of stmt.init.decls) if (d.init) this.sequenceValueExpr(d.init, true, true);
        const decls = stmt.init.decls.map((d) => this.emitVarDecl(d.name, d.type, d.init)).filter(Boolean);
        for (const d of decls) this.line(`${d};`);
        init = '';
      } else if (stmt.init.kind === 'ExprStmt') {
        this.sequenceValueExpr(stmt.init.expr, true, true);
        init = this.emitExpr(stmt.init.expr).code;
      }
    }
    // The condition and update run *per iteration*; their preludes are captured
    // here and placed inside the loop body (never before it — that would freeze
    // the side effects; see `emitWhile`). An update's value is discarded, so it
    // takes the statement-level `valueCtx = false` pass that `ExprStmt` uses.
    const condPrelude = stmt.cond ? this.captureSequence(stmt.cond, true, true) : [];
    const updPrelude = stmt.update ? this.captureSequence(stmt.update, false, true) : [];
    const cond = stmt.cond ? this.condExpr(this.emitExpr(stmt.cond)) : '';
    if (condPrelude.length === 0 && updPrelude.length === 0) {
      this.continueTargets.push({ depth, label: null, used: false });
      const update = stmt.update ? this.emitExpr(stmt.update).code : '';
      this.line(`for (${init}; ${cond}; ${update}) {`);
      this.indent++;
      this.emitStmt(stmt.body);
      if (continueLabel) this.line(`${continueLabel}: ;`);
      this.indent--;
      this.line('}');
      this.continueTargets.pop();
      this.breakTargets.pop();
      this.popScope();
      return;
    }
    const tgt = { depth, label: this.tmpName('cont'), used: false };
    this.continueTargets.push(tgt);
    this.line(`for (${init}; ;) {`);
    this.indent++;
    this.emitLines(condPrelude);
    if (cond) this.line(`if (!(${cond})) break;`);
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    if (tgt.used) this.line(`${tgt.label}: ;`);
    this.emitLines(updPrelude);
    // A getter/setter `prop++` update was already expanded into a getter read +
    // setter write by the sequencing pass; emitExpr would only reproduce the
    // invalid `get_prop(...)++` rvalue (same rule as the `ExprStmt` case).
    if (stmt.update && !(stmt.update.kind === 'Update' && this.resolveUpdateSetter(stmt.update.target))) {
      const e = this.emitExpr(stmt.update);
      this.line(e.discard ? `(void)(${e.code});` : `${e.code};`);
    }
    this.indent--;
    this.line('}');
    this.continueTargets.pop();
    this.breakTargets.pop();
    this.popScope();
  }

  // Run the sequencing pass for an expression whose evaluation must happen
  // *inside* a loop body, intercepting any prelude statements it emits so the
  // caller can place them at the right point. The generated lines are captured
  // from the output buffer rather than recomputed, so this can never drift from
  // `sequenceValueExpr`'s actual notion of "needs hoisting".
  private captureSequence(e: Expr, valueCtx: boolean, guaranteed: boolean): string[] {
    const start = this.out.length;
    this.sequenceValueExpr(e, valueCtx, guaranteed);
    if (this.out.length === start) return [];
    return this.out.splice(start);
  }

  // Re-emit captured prelude lines one indent level deeper than they were
  // generated (every line carries its full indent, so a uniform shift is exact).
  private emitLines(lines: string[]): void {
    for (const l of lines) this.out.push(l === '' ? '' : '  ' + l);
  }

  // `throw expr` — AS3 throws an Error (or any value). We normalize everything
  // to an Error object: Error values pass through, strings are wrapped, and
  // other primitives are stringified first.
  private emitThrow(stmt: Extract<Stmt, { kind: 'Throw' }>): void {
    this.sequenceValueExpr(stmt.value, true, true);
    const e = this.emitExpr(stmt.value);
    // Any Error subclass (Error/TypeError/RangeError/ArgumentError) passes through
    // as-is; other values are wrapped into a fresh Error.
    if (e.type.kind === 'object' && this.symbols.isSubclassOf(e.type.className, 'Error')) {
      this.line(`as_throw(${e.code});`);
    } else if (e.type.kind === 'string') {
      this.line(`as_throw(Error_new(${e.code}, 0));`);
    } else if (e.type.kind === 'object') {
      this.line(`as_throw(Error_new(as_obj_to_str((void*)(${e.code})), 0));`);
    } else {
      this.line(`as_throw(Error_new(${this.toStringExpr(e)}, 0));`);
    }
  }

  // `try { ... } catch (e:Error) { ... } finally { ... }` — setjmp/longjmp-based.
  // The handler is pushed onto a global stack so nested try blocks and throws
  // inside catch/finally re-enter the correct outer handler. `finally` always
  // runs — on normal completion, on a caught/uncaught throw, and on an early
  // return/break/continue out of the try (the last handled by `emitUnwind` in
  // the Return/Break/Continue cases, which also pops the jmp stack). If the
  // exception is still pending afterward (a finally-only try, or a throw inside
  // finally), it is rethrown to the outer handler.
  private emitTry(stmt: Extract<Stmt, { kind: 'Try' }>): void {
    const env = this.tmpName('env');
    const ret = this.tmpName('ex');
    const frame: { active: boolean; finallyBody: Block | null } = {
      active: false,
      finallyBody: stmt.finallyBody ?? null,
    };
    this.tryFrames.push(frame);
    this.line('{');
    this.indent++;
    this.line(`jmp_buf ${env};`);
    this.line(`int ${ret} = setjmp(${env});`);
    this.line(`if (${ret} == 0) {`);
    this.indent++;
    this.line(`as_jmp_stack[as_jmp_depth++] = &${env};`);
    frame.active = true;
    this.emitBlockBody(stmt.tryBody);
    frame.active = false;
    this.line('as_jmp_depth--;');
    this.indent--;
    this.line('} else {');
    this.indent++;
    this.line('as_jmp_depth--;');
    this.indent--;
    this.line('}');
    if (stmt.catchBody && stmt.catchVar) {
      const catchTypeName = stmt.catchType ?? 'Error';
      if (!this.symbols.hasClass(catchTypeName)) {
        throw new CodegenError(`undefined class '${catchTypeName}' in catch`);
      }
      this.line(`if (${ret} != 0) {`);
      this.indent++;
      this.pushScope();
      // AS3 `catch (e:Type)` only catches instances of Type (or its subclasses).
      // as_is walks the vtable super chain; an unmatched exception keeps
      // as_exception non-NULL so the rethrow at the end propagates it outward.
      this.line(`if (as_is(as_exception, &${catchTypeName}_vt)) {`);
      this.indent++;
      this.declareVar(stmt.catchVar, { kind: 'object', className: catchTypeName });
      this.line(`${catchTypeName}* ${this.cIdent(stmt.catchVar)} = (${catchTypeName}*)as_exception;`);
      this.line('as_exception = NULL;');
      this.emitBlockBody(stmt.catchBody);
      this.indent--;
      this.line('}');
      this.popScope();
      this.indent--;
      this.line('}');
    }
    if (stmt.finallyBody) {
      // The finally is now running inline, so a return/break/continue inside it
      // must not re-run it (its try frame is already popped).
      frame.finallyBody = null;
      this.emitBlockBody(stmt.finallyBody);
    }
    this.line(`if (${ret} != 0 && as_exception != NULL) as_throw(as_exception);`);
    this.indent--;
    this.line('}');
    this.tryFrames.pop();
  }

  // Integer switch maps to a native C switch (supports fall-through and break).
  private emitSwitchIntegral(stmt: Extract<Stmt, { kind: 'Switch' }>, disc: { code: string; type: CType }): void {
    this.breakTargets.push(this.tryFrames.length);
    this.line(`switch (${disc.code}) {`);
    this.indent++;
    for (const c of stmt.cases) {
      // A bare `case X:` / `default:` must be followed by a *statement*, and in
      // C11 a declaration is not one. The sequencing pass (`hoistImpure`) may put
      // a leading declaration right after the label and there is no way to know
      // that in advance, so the label always gets an empty statement. Native
      // clang silently accepts `label: int x = ...` as a C23 extension
      // (-Wc23-extensions), but the wasm frontend rejects it with "expected
      // expression" — the generated C must be valid C11, not extension-dependent.
      if (c.test === null) {
        this.line('default: ;');
      } else {
        const t = this.emitExpr(c.test);
        this.line(`case ${t.code}: ;`);
      }
      this.indent++;
      for (const s of c.body) this.emitStmt(s);
      this.indent--;
    }
    this.indent--;
    this.line('}');
    this.breakTargets.pop();
  }

  // Non-integer switch (string/Number/bool) lowers to an if/else chain using strict
  // equality. Each case is an independent branch, so `break` inside is suppressed.
  private emitSwitchChained(stmt: Extract<Stmt, { kind: 'Switch' }>, disc: { code: string; type: CType }): void {
    const cases = stmt.cases.filter((c) => c.test !== null);
    const def = stmt.cases.find((c) => c.test === null);

    if (cases.length === 0) {
      if (def) for (const s of def.body) this.emitStmt(s);
      return;
    }

    for (let i = 0; i < cases.length; i++) {
      const test = this.emitExpr(cases[i].test!);
      const cond = this.emitEquality(disc, test, '==');
      const kw = i === 0 ? 'if' : 'else if';
      this.line(`${kw} (${cond}) {`);
      this.indent++;
      this.suppressBreak++;
      for (const s of cases[i].body) this.emitStmt(s);
      this.suppressBreak--;
      this.indent--;
      this.line('}');
    }
    if (def) {
      this.line('else {');
      this.indent++;
      this.suppressBreak++;
      for (const s of def.body) this.emitStmt(s);
      this.suppressBreak--;
      this.indent--;
      this.line('}');
    }
  }

  // Returns declaration text without trailing semicolon.
  private emitVarDecl(name: string, type: ASType | null, init: Expr | null): string {
    // A declaration in the script scope keeps the module-scope slot even when it is
    // written inside a block, an `if`, a `for` init or a `switch` case (AS3 hoists
    // the whole top-level tree into the one script scope — see collectScriptDecls).
    // emitModuleVars already emitted the C global, so emit only the assignment:
    // declaring a C local here would hide the global from sibling blocks and from
    // main()'s later statements (`for (var i…) {}` then `trace(i)` used to fail with
    // "undefined variable 'i' at top level").
    if (this.functionScope === null && this.moduleScope.has(name)) {
      if (!init) return ''; // already default-initialized at file scope
      const ctype = this.moduleScope.get(name)!;
      const e = this.emitExpr(init);
      return `${this.moduleCName(name)} = ${this.convert(e, ctype)}`;
    }
    let ctype: CType;
    if (type !== null) {
      ctype = this.rt(type);
    } else if (init) {
      ctype = this.emitExpr(init).type;
    } else {
      ctype = { kind: 'int' };
    }
    // A hoisted (function-scoped) var is already declared at the function top;
    // emit only the assignment here so the C declaration isn't duplicated inside
    // a block where it would be invisible to sibling scopes.
    if (this.hoistedLocals.has(name)) {
      if (!init) return '';
      const e = this.emitExpr(init);
      const code = this.convert(e, ctype);
      // A boxed captured local has no C local of its own — assign through the
      // shared closure cell (reference semantics).
      return `${this.emitVar(name).code} = ${code}`;
    }
    this.declareVar(name, ctype);
    if (init) {
      const e = this.emitExpr(init);
      const code = this.convert(e, ctype);
      return `${this.cTypeName(ctype)} ${this.cIdent(name)} = ${code}`;
    }
    return `${this.cTypeName(ctype)} ${this.cIdent(name)} = ${this.defaultInit(ctype)}`;
  }

  // ---------- expressions ----------

  // Walk `e` in AS3 evaluation order and hoist self-modifying assignments to
  // simple local/parameter variables (`x op= y`, `x = y`, `++x`/`x++`/`--x`/`x--`)
  // into standalone prelude statements whose value is captured in a temp.
  //
  // AS3 evaluates operands strictly left-to-right with full sequencing, so
  // `c*(t/=d)*t*t` first assigns `t`, then reads the updated `t` three times.
  // C leaves the operands of `*` unsequenced, so the write to `t` would race the
  // sibling reads (undefined behavior, clang `-Wunsequenced`). By emitting
  // `double _seq0 = (t = (t/d));` first and substituting `_seq0` for the
  // assignment node, the write is sequenced before every later read.
  //
  // `valueCtx` marks positions whose value is consumed (a discarded top-level
  // assignment needs no hoisting); `guaranteed` marks positions that always run
  // when the enclosing statement runs. We deliberately do not hoist inside
  // short-circuit RHS, conditional branches, or nested functions — those may not
  // execute, so hoisting would change semantics.
  // Identify a setter assignment target and return enough info to emit the
  // write (used by sequenceValueExpr to give setter assignments a value when they
  // appear in chained-assignment RHS position, since the setter itself is void).
  private resolveInstanceSetter(target: Expr): { owner: string; property: string; paramType: CType; objCode: string; isStatic: boolean } | null {
    if (target.kind !== 'Member') return null;
    // static setter: ClassName.prop = v
    if (target.object.kind === 'Var') {
      const cname = this.resolveClassName(target.object.name);
      if (this.symbols.hasClass(cname)) {
        const cinfo = this.symbols.getClass(cname)!;
        const ss = cinfo.staticSetters?.get(target.property);
        if (ss) {
          return { owner: ss.owner, property: target.property, paramType: this.rt(ss.params[0].type), objCode: 'NULL', isStatic: true };
        }
      }
    }
    const obj = this.emitExpr(target.object);
    if (obj.type.kind === 'object') {
      const cinfo = this.symbols.getClass(obj.type.className);
      const s = cinfo?.setters.get(target.property);
      if (s) return { owner: s.owner, property: target.property, paramType: this.rt(s.params[0].type), objCode: obj.code, isStatic: false };
    }
    return null;
  }

  // Like resolveInstanceSetter, but for an unqualified bare setter name (`scaleX =
  // scaleY = value` inside a setter body), where the target is a Var, not a Member.
  private resolveBareSetter(target: Expr): { owner: string; property: string; paramType: CType; objCode: string; isStatic: boolean } | null {
    if (target.kind !== 'Var' || !this.currentClass) return null;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(target.name)) return null;
    }
    const cinfo = this.symbols.getClass(this.currentClass);
    if (!this.currentIsStatic) {
      const s = cinfo?.setters.get(target.name);
      if (s) {
        return { owner: s.owner, property: target.name, paramType: this.rt(s.params[0].type), objCode: this.emitVar('this').code, isStatic: false };
      }
    }
    const ss = cinfo?.staticSetters?.get(target.name);
    if (ss) {
      return { owner: ss.owner, property: target.name, paramType: this.rt(ss.params[0].type), objCode: 'NULL', isStatic: true };
    }
    return null;
  }

  // Setter target of an update expression (`prop++` / `obj.prop++`), where the
  // getter returns an rvalue so the read-modify-write must be expanded.
  private resolveUpdateSetter(target: Expr): { owner: string; property: string; paramType: CType; objCode: string; isStatic: boolean } | null {
    if (target.kind === 'Var') return this.resolveBareSetter(target);
    if (target.kind === 'Member') return this.resolveInstanceSetter(target);
    return null;
  }

  // A plain static FIELD (not a getter/setter) used as an lvalue — either a bare
  // name inside a class or a `Class.field` reference. Unlike `resolveUpdateSetter`,
  // which returns setter call info, this returns the field's C symbol so the
  // caller can emit a true lvalue (`++` / `=`), wrapping the class's `_cinit`
  // call around the operation rather than turning the lvalue into a comma rvalue.
  private resolveStaticFieldTarget(target: Expr): { owner: string; name: string } | null {
    if (target.kind === 'Var' && this.currentClass) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        if (this.scopes[i].has(target.name)) return null;
      }
      const cinfo = this.symbols.getClass(this.currentClass);
      // Mirror emitVar's precedence: an instance field or getter shadows a
      // static field for an unqualified name, so those are not static lvalues.
      if (cinfo?.fields.has(target.name) || cinfo?.getters.has(target.name)) return null;
      const sf = cinfo?.staticFields.get(target.name);
      if (sf && !this.symbols.isAccessible(sf.visibility, sf.owner, this.currentClass)) {
        throw new CodegenError(`static field '${target.name}' is not accessible here`);
      }
      return sf ? { owner: sf.owner, name: target.name } : null;
    }
    if (target.kind === 'Member' && target.object.kind === 'Var') {
      const cname = this.resolveClassName(target.object.name);
      if (this.symbols.hasClass(cname)) {
        const sf = this.symbols.getClass(cname)!.staticFields.get(target.property);
        if (sf) return { owner: sf.owner, name: target.property };
      }
    }
    return null;
  }

  // True when a bare-identifier assignment target resolves to a field of a
  // GC-managed object (an instance field `this->x`, a captured closure variable
  // `env->x`, or a boxed enclosing cell `cell->x`) rather than a C stack local,
  // module variable, or static field. The former must go through the write
  // barrier when storing a GC pointer (a BLACK object must not gain a WHITE
  // reference unobserved); the latter are roots or dead at the frame-boundary
  // safe point and need none. Mirrors emitVar's resolution precedence.
  private resolvesToHeapField(target: Expr): boolean {
    if (target.kind !== 'Var') return false;
    const name = target.name;
    // Captured closure variable: read/written through the closure env struct.
    if (this.currentClosureCaptures?.has(name)) return true;
    // Boxed captured local in the enclosing function: shared closure cell slot.
    if (this.enclosingCaptured.has(name)) return true;
    // A C stack local shadows any field of the same name.
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return false;
    }
    if (this.currentClass) {
      const cinfo = this.symbols.getClass(this.currentClass);
      if (cinfo?.fields.has(name)) return true;
    }
    return false;
  }

  // True when an expression is guaranteed side-effect-free and safe to duplicate
  // in the emitted C (a bare variable/literal, or a field/index chain whose base
  // is itself pure). Method/function calls, `new`, assignments and updates are
  // impure: they may allocate, mutate state, or (for `pop()`/`shift()`) consume an
  // element, so evaluating them twice is a bug.
  private isPureExpr(e: Expr): boolean {
    switch (e.kind) {
      case 'Var':
      case 'Num':
      case 'Str':
      case 'Bool':
      case 'Null':
        return true;
      case 'Member':
        return this.isPureExpr(e.object);
      case 'Index':
        return this.isPureExpr(e.object) && this.isPureExpr(e.index);
      case 'Unary':
        // `!`, unary `-`/`+`/`~` read their operand only (no side effects).
        return this.isPureExpr(e.operand);
      case 'Typeof':
        return this.isPureExpr(e.operand);
      case 'Binary': {
        // Arithmetic/comparison/bitwise AND logical `&&`/`||` are all pure (no
        // side effects) when both operands are. Even though `&&`/`||` short-circuit,
        // they merely select one operand's value, so if both operands are pure the
        // whole expression can be re-evaluated safely — and *must* be considered
        // pure here, otherwise a pure `a || b` nested inside another `&&`/`||` would
        // get hoisted to an unconditional statement, breaking the outer short-circuit
        // (e.g. `false && (o.x > 0 || o.y > 0)` would deref `o` even though the
        // whole guard is dead).
        return this.isPureExpr(e.left) && this.isPureExpr(e.right);
      }
      default:
        return false;
    }
  }

  // True for expressions that compile to a single C atom — a variable (incl. `this`)
  // or a literal. `&&`/`||` emit their left operand twice (once as the condition,
  // once as the branch value), which is free for an atom but otherwise both grows
  // the emitted expression (2^n along a left-nested `a && b && c …` chain) and
  // re-evaluates it. Everything else is hoisted to a temp by sequenceValueExpr.
  private isAtomicExpr(e: Expr): boolean {
    return e.kind === 'Var' || e.kind === 'Num' || e.kind === 'Str'
        || e.kind === 'Bool' || e.kind === 'Null';
  }

  // Capture a sub-expression that is mentioned more than once in the C text of a
  // single AS3 operation, so that it runs exactly once — AS3 evaluates every
  // operand once, left to right, and a call repeated twice is observable
  // (`box.get().label = "Z"` ran the getter three times: store, write barrier,
  // value; `h.getFn()()` ran it twice: closure + env).
  //
  // Impure operands only: a pure operand costs nothing to repeat. Only when the
  // operand is *guaranteed* to run — inside a short-circuited `&&`/`||` branch a
  // prelude statement would evaluate it even when the branch is skipped (see the
  // `guaranteed` discussion in sequenceValueExpr).
  private hoistImpure(e: Expr, guaranteed: boolean): void {
    if (!guaranteed || this.hoistedAssigns.has(e) || this.isPureExpr(e)) return;
    this.sequenceValueExpr(e, true, guaranteed);
    if (this.hoistedAssigns.has(e)) return; // the recursion already captured it
    const v = this.emitExpr(e);
    const tmp = this.tmpName('once');
    this.line(`${this.cTypeName(v.type)} ${tmp} = ${v.code};`);
    this.hoistedAssigns.set(e, { tmp, type: v.type });
  }

  // The store half of a container-element update, `x[i] = Number(x[i]) ± 1`, built
  // as an AST the ordinary Assign path can emit (used by the `Update` handling in
  // sequenceValueExpr and emitExpr). `Number(...)` is the ToNumber that the
  // increment operator itself performs.
  private indexUpdateStore(target: Expr, op: string): Expr {
    return {
      kind: 'Assign',
      op: '=',
      target,
      value: {
        kind: 'Binary',
        op: op === '++' ? '+' : '-',
        left: this.toNumberAst(target),
        right: { kind: 'Num', value: 1, isInt: true },
      },
    };
  }

  // `Number(x)` — the ToNumber the increment operator performs on its operand. It
  // must be a real conversion, not the raw unbox for the operand's static type: a
  // container element typed `any` may hold the STRING "5", and `a[i]++` has to
  // yield 5 and store 6 (ES3 §11.3.1), not read the union's numeric field.
  private toNumberAst(x: Expr): Expr {
    return { kind: 'Call', callee: { kind: 'Var', name: 'Number' }, args: [x] };
  }

  private sequenceValueExpr(e: Expr, valueCtx: boolean, guaranteed: boolean): void {
    switch (e.kind) {
      case 'Assign': {
        if (valueCtx && guaranteed && e.target.kind === 'Var') {
          // A bare setter name (`scaleX = scaleY = value`) is a Var target whose
          // setter call returns void; hoist the RHS value instead of the setter.
          const bst = this.resolveBareSetter(e.target);
          if (bst) {
            this.sequenceValueExpr(e.value, true, guaranteed);
            const v = this.emitExpr(e.value);
            const cv = this.convert(v, bst.paramType);
            const tmp = this.tmpName('seq');
            this.line(`${this.cTypeName(bst.paramType)} ${tmp} = ${cv};`);
            this.line(this.setterCallCode(bst.owner, bst.property, bst.isStatic, bst.objCode, tmp) + ';');
            this.hoistedAssigns.set(e, { tmp, type: bst.paramType });
            return;
          }
          // The whole assignment is emitted as one standalone statement (which is
          // UB-free on its own); its RHS side effects are captured there, so we do
          // not recurse into the value.
          const asg = this.emitAssign(e);
          const tmp = this.tmpName('seq');
          this.line(`${this.cTypeName(asg.type)} ${tmp} = ${asg.code};`);
          this.hoistedAssigns.set(e, { tmp, type: asg.type });
          return;
        }
        // Setter assignment used as a value (`a.x = a.y = 0`, or a COMPOUND write
        // `t = obj.prop += v`): the setter returns void but the assignment
        // expression's value is the RHS (for a compound write, `get() OP v`).
        // Evaluate that value into a temp, call the setter, and let later
        // references read the temp.
        if (valueCtx && guaranteed) {
          // Capture an impure receiver before `resolveInstanceSetter` reads it: the
          // setter call mentions it twice (vtable lookup + `this` argument) and it
          // must also run *before* the RHS, which is the AS3 left-to-right order
          // (this prelude used to be skipped entirely, so a loop condition like
          // `while (q.get().n = v)` ran `get()` twice per evaluation).
          if (e.target.kind === 'Member' || e.target.kind === 'AttrAccess') {
            this.hoistImpure(e.target.object, guaranteed);
          }
          const st = this.resolveInstanceSetter(e.target);
          if (st) {
            // Recurse into the RHS first so a nested chained setter assignment
            // (`a.x = a.y = a.z = 0`) is hoisted to a temp too; emitExpr then
            // reads that temp instead of the inner void setter call.
            this.sequenceValueExpr(e.value, true, guaranteed);
            // A compound write's value is `get() OP rhs` — the same expression the
            // setter argument is built from in emitAssign. Its type (not the
            // setter's parameter type) is the expression's value type: `+=` on a
            // String property yields the concatenated String.
            const v = e.op === '=' ? this.emitExpr(e.value)
              : this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[e.op], left: e.target, right: e.value });
            const tmp = this.tmpName('seq');
            const tmpType = e.op === '=' ? st.paramType : v.type;
            this.line(`${this.cTypeName(tmpType)} ${tmp} = ${this.convert(v, tmpType)};`);
            this.line(this.setterCallCode(st.owner, st.property, st.isStatic, st.objCode, this.convert({ code: tmp, type: tmpType }, st.paramType)) + ';');
            this.hoistedAssigns.set(e, { tmp, type: tmpType });
            return;
          }
        }
        // Vector element chained assignment (`v[0] = v[2] = 0`): as_vector_set
        // returns void; the assignment expression's value is the RHS.
        if (valueCtx && guaranteed && e.op === '=' && e.target.kind === 'Index') {
          const obj = this.emitExpr(e.target.object);
          if (obj.type.kind === 'vector') {
            this.sequenceValueExpr(e.value, true, guaranteed);
            const idx = this.convert(this.emitExpr(e.target.index), { kind: 'int' });
            const v = this.emitExpr(e.value);
            const ev = this.convert(v, obj.type.elem);
            const tmp = this.tmpName('seq');
            this.line(`${this.cTypeName(obj.type.elem)} ${tmp} = ${ev};`);
            this.line(`as_vector_${this.vectorCName(obj.type.elem)}_set(${obj.code}, ${idx}, ${tmp});`);
            this.hoistedAssigns.set(e, { tmp, type: obj.type.elem });
            return;
          }
        }
        // A member write mentions the receiver three times in the emitted C
        // (`x->f = v`, the GC write barrier on the same lvalue, and the value of
        // the assignment expression), so an impure receiver is captured once.
        if (e.target.kind === 'Member' || e.target.kind === 'AttrAccess') {
          this.hoistImpure(e.target.object, guaranteed);
        }
        this.sequenceValueExpr(e.target, false, guaranteed);
        this.sequenceValueExpr(e.value, true, guaranteed);
        return;
      }
      case 'Update': {
        // getter/setter property `prop++` / `obj.prop++`: the getter returns an
        // rvalue, so the read-modify-write expands to a getter read + setter write
        // (and, when the value is consumed, a result temp). Both the getter read
        // and the setter call mention the receiver, so an impure one is captured
        // first — and *before* `resolveUpdateSetter`, which bakes the receiver's C
        // text into `objCode` (`obj.get().n++` used to run `get()` four times).
        if (e.target.kind === 'Member' || e.target.kind === 'AttrAccess') {
          this.hoistImpure(e.target.object, guaranteed);
        }
        const us = this.resolveUpdateSetter(e.target);
        if (us) {
          // A value context that cannot be pre-evaluated (guaranteed false: a `?:`
          // or `&&` branch) is left entirely to emitExpr, which folds the
          // read-modify-write into one expression so the branch stays conditional —
          // emitting the store here would run it even when the branch is not taken.
          if (valueCtx && !guaranteed) return;
          const oldv = this.emitExpr(e.target);
          if (valueCtx && guaranteed) {
            const oldTmp = this.tmpName('upd');
            this.line(`${this.cTypeName(oldv.type)} ${oldTmp} = ${oldv.code};`);
            const newCode = `(${oldTmp} ${e.op === '++' ? '+' : '-'} 1)`;
            this.line(this.setterCallCode(us.owner, us.property, us.isStatic, us.objCode, this.convert({ code: newCode, type: oldv.type }, us.paramType)) + ';');
            const resTmp = this.tmpName('upd');
            this.line(`${this.cTypeName(oldv.type)} ${resTmp} = ${e.prefix ? newCode : oldTmp};`);
            this.hoistedAssigns.set(e, { tmp: resTmp, type: oldv.type });
            return;
          }
          const newCode = `(${oldv.code} ${e.op === '++' ? '+' : '-'} 1)`;
          this.line(this.setterCallCode(us.owner, us.property, us.isStatic, us.objCode, this.convert({ code: newCode, type: oldv.type }, us.paramType)) + ';');
          return;
        }
        if (valueCtx && guaranteed && e.target.kind === 'Index') {
          // Container element `x[i]++` / `++x[i]` (Array / Vector / Dictionary /
          // dynamic object / plain record): the element is reached through a runtime
          // accessor, so there is no C lvalue to increment — `as_array_get(a, i)++`
          // does not even compile. The increment expands to a read-modify-write
          // through the Assign path, which knows how each container kind is read and
          // written, with the operator's own ToNumber applied to the read (ES3
          // §11.3.1/§11.4.1 define `++` as ToNumber(v) ± 1; a plain `v + 1` would
          // concatenate for a String element).
          const oldTmp = this.tmpName('upd');
          const num: CType = { kind: 'number' };
          this.line(`${this.cTypeName(num)} ${oldTmp} = ${this.convert(this.emitExpr(this.toNumberAst(e.target)), num)};`);
          this.line(this.emitAssign(this.indexUpdateStore(e.target, e.op)).code + ';');
          const resTmp = this.tmpName('upd');
          this.line(`${this.cTypeName(num)} ${resTmp} = ${e.prefix ? `(${oldTmp} ${e.op === '++' ? '+' : '-'} 1)` : oldTmp};`);
          this.hoistedAssigns.set(e, { tmp: resTmp, type: num });
          return;
        }
        if (valueCtx && guaranteed && e.target.kind === 'Var') {
          const upd = this.emitExpr(e);
          const tmp = this.tmpName('seq');
          this.line(`${this.cTypeName(upd.type)} ${tmp} = ${upd.code};`);
          this.hoistedAssigns.set(e, { tmp, type: upd.type });
          return;
        }
        // `x.f++` reads and writes the receiver (and runs the write barrier); the
        // receiver was already captured at the top of this case.
        this.sequenceValueExpr(e.target, false, guaranteed);
        return;
      }
      case 'Binary': {
        // `&&`/`||` return the value of one operand (AS3/JS semantics) and are
        // emitted as `(cond(left) ? ... : ...)`. The left operand is read twice
        // there (once for the condition, once as a branch value), so when it has
        // side effects it must be hoisted to a temp and evaluated exactly once.
        //
        // Any non-atom left operand is hoisted for the same reason, even when it is
        // pure: a chain like `a && b && c` nests left-associatively, so re-emitting
        // the left subtree in both slots doubles the emitted code at every level
        // (2^n), and at runtime re-evaluates that subtree as many times. Hoisting to
        // a temp makes both linear (RenderState.copyFrom's 6-term guard used to emit
        // 32 identical `as_str_eq` calls, MatrixUtil.isIdentity3D's 16-term chain
        // 65535 `as_vector_number_get` calls). Boolean operands are exempt in
        // emitBinary, which collapses them to a plain C `&&`/`||` (no duplication at
        // all); the temp is still harmless there. Only hoisted when the operand is
        // guaranteed to run — inside a short-circuited branch a prelude statement
        // would evaluate it even when the branch is skipped (see `guaranteed`).
        // `==`/`!=` read an operand twice in the interface form
        // (`a.obj == b.obj && a.vt == b.vt`), so an impure operand is captured
        // once; the scalar/string/value forms read each operand once and are
        // unaffected by the extra temp.
        if (e.op === '==' || e.op === '!=' || e.op === '===' || e.op === '!==') {
          this.hoistImpure(e.left, guaranteed);
          this.hoistImpure(e.right, guaranteed);
        }
        const logical = e.op === '&&' || e.op === '||';
        if (logical && (!this.isPureExpr(e.left) || (guaranteed && !this.isAtomicExpr(e.left)))) {
          this.sequenceValueExpr(e.left, true, guaranteed);
          const l = this.emitExpr(e.left);
          const tmp = this.tmpName('sc');
          this.line(`${this.cTypeName(l.type)} ${tmp} = ${l.code};`);
          this.hoistedAssigns.set(e.left, { tmp, type: l.type });
          this.sequenceValueExpr(e.right, true, false);
          return;
        }
        this.sequenceValueExpr(e.left, true, guaranteed);
        const g2 = logical ? false : guaranteed;
        this.sequenceValueExpr(e.right, true, g2);
        return;
      }
      case 'Conditional': {
        this.sequenceValueExpr(e.cond, true, guaranteed);
        this.sequenceValueExpr(e.then, true, false);
        this.sequenceValueExpr(e.else, true, false);
        return;
      }
      case 'Unary': {
        this.sequenceValueExpr(e.operand, true, guaranteed);
        return;
      }
      case 'Typeof': {
        this.sequenceValueExpr(e.operand, true, guaranteed);
        return;
      }
      case 'Delete': {
        this.sequenceValueExpr(e.target, true, guaranteed);
        return;
      }
      case 'Call': {
        // A method call whose receiver has side effects (e.g. `pool.pop().reset()`)
        // is emitted by emitCall with the receiver code duplicated — once for the
        // vtable lookup and once as the `this` argument. Hoist such a receiver to a
        // temp so it is evaluated exactly once: evaluating `pop()` twice would pop
        // two elements and throw on an empty pool.
        //
        // The hoist is only safe when the call is *guaranteed* to run. Inside a
        // short-circuited `&&`/`||` (guaranteed=false), hoisting the receiver to a
        // standalone prelude statement would evaluate it even when the branch is
        // skipped — e.g. `p in plugins && (plugin = new (...)).onInitTween(...)`
        // must NOT run `new (...)` when `p in plugins` is false. There we leave
        // the receiver inline so the surrounding ternary short-circuits it.
        if (e.callee.kind === 'Member' && !this.isPureExpr(e.callee.object) && guaranteed) {
          this.sequenceValueExpr(e.callee.object, true, guaranteed);
          const recv = this.emitExpr(e.callee.object);
          const tmp = this.tmpName('recv');
          this.line(`${this.cTypeName(recv.type)} ${tmp} = ${recv.code};`);
          this.hoistedAssigns.set(e.callee.object, { tmp, type: recv.type });
          for (const a of e.args) this.hoistImpure(a, guaranteed);
          return;
        }
        // A call through a value (`getFn()()`, `arr[i]()`) mentions the callee twice
        // (the closure and its environment pointer).
        if (e.callee.kind !== 'Var' && e.callee.kind !== 'Member') this.hoistImpure(e.callee, guaranteed);
        this.sequenceValueExpr(e.callee, true, guaranteed);
        // Arguments are evaluated once, left to right, before the call; several
        // built-in calls inline an argument more than once in their C form
        // (`s.replace(h.mkRe(), x)` reads `->compiled` and `->global`,
        // `Boolean(getS())` reads the string twice), so capture impure ones.
        for (const a of e.args) this.hoistImpure(a, guaranteed);
        return;
      }
      case 'SuperMethod': {
        for (const a of e.args) this.sequenceValueExpr(a, true, guaranteed);
        return;
      }
      case 'SuperProperty': {
        return; // a pure field/getter access on the superclass — no side effects
      }
      case 'Member': {
        // A getter read emits `obj->vtable->get_x(obj)` — the receiver twice.
        this.hoistImpure(e.object, guaranteed);
        this.sequenceValueExpr(e.object, true, guaranteed);
        return;
      }
      case 'AttrAccess': {
        this.hoistImpure(e.object, guaranteed);
        this.sequenceValueExpr(e.object, true, guaranteed);
        return;
      }
      case 'Filter': {
        this.sequenceValueExpr(e.object, true, guaranteed);
        this.sequenceValueExpr(e.value, true, guaranteed);
        return;
      }
      case 'Is':
      case 'As': {
        // `x as T` tests the operand and then converts it, so the emitted C mentions
        // it twice; capture an impure operand once.
        this.hoistImpure(e.obj, guaranteed);
        this.sequenceValueExpr(e.obj, true, guaranteed);
        return;
      }
      case 'In': {
        this.sequenceValueExpr(e.key, true, guaranteed);
        this.sequenceValueExpr(e.object, true, guaranteed);
        return;
      }
      case 'New': {
        for (const a of e.args) this.sequenceValueExpr(a, true, guaranteed);
        return;
      }
      case 'NewDynamic': {
        this.sequenceValueExpr(e.classExpr, true, guaranteed);
        for (const a of e.args) this.sequenceValueExpr(a, true, guaranteed);
        return;
      }
      case 'ArrayLit': {
        for (const el of e.elements) this.sequenceValueExpr(el, true, guaranteed);
        return;
      }
      case 'VectorLit': {
        for (const el of e.elements) this.sequenceValueExpr(el, true, guaranteed);
        return;
      }
      case 'Index': {
        this.sequenceValueExpr(e.object, true, guaranteed);
        this.sequenceValueExpr(e.index, true, guaranteed);
        return;
      }
      case 'ObjectLit': {
        for (const f of e.fields) this.sequenceValueExpr(f.value, true, guaranteed);
        return;
      }
      case 'FunctionExpr': {
        // Separate scope; its own statements sequence independently.
        return;
      }
      default:
        return; // Num, Str, Bool, Null, Var, RegExp
    }
  }

  private emitExpr(expr: Expr): { code: string; type: CType; discard?: boolean } {
    // A node hoisted by sequenceValueExpr (e.g. an impure method-call receiver or
    // a chained assignment) has already been evaluated into a temp by a prelude
    // statement; return that temp instead of re-emitting the side effects.
    const hoisted = this.hoistedAssigns.get(expr);
    if (hoisted) return { code: hoisted.tmp, type: hoisted.type };
    switch (expr.kind) {
      case 'Num': {
        if (expr.isInt) return { code: String(expr.value), type: { kind: 'int' } };
        if (Number.isNaN(expr.value)) return { code: 'NAN', type: { kind: 'number' } };
        if (expr.value === Infinity) return { code: 'INFINITY', type: { kind: 'number' } };
        if (expr.value === -Infinity) return { code: '(-INFINITY)', type: { kind: 'number' } };
        return { code: this.formatDouble(expr.value), type: { kind: 'number' } };
      }

      case 'Str':
        return { code: `"${this.escapeCString(expr.value)}"`, type: { kind: 'string' } };

      case 'Bool':
        return { code: expr.value ? 'true' : 'false', type: { kind: 'bool' } };

      case 'Null':
        return { code: 'NULL', type: { kind: 'null' } };

      case 'Var':
        return this.emitVar(expr.name);

      case 'Binary':
        return this.emitBinary(expr);

      case 'Unary': {
        const o = this.emitExpr(expr.operand);
        if (expr.op === '!') return { code: `(!${this.condExpr(o)})`, type: { kind: 'bool' } };
        if (expr.op === '~') return { code: `(~(${this.toInt32Expr(o)}))`, type: { kind: 'int' } };
        return { code: `(${expr.op}${o.code})`, type: o.type };
      }

      case 'Typeof':
        return this.emitTypeof(expr);

      case 'Delete':
        return this.emitDelete(expr);

      case 'Update': {
        const hoisted = this.hoistedAssigns.get(expr);
        if (hoisted) return { code: hoisted.tmp, type: hoisted.type };
        // A plain static field `C.f++` / `f++` keeps the field as a true lvalue
        // but must run `C_cinit()` first; `(C_cinit(), C.f++)` is valid where a
        // comma-wrapped lvalue (`(C_cinit(), C.f)++`) would not be.
        const sf = this.resolveStaticFieldTarget(expr.target);
        if (sf) {
          const raw = `${sf.owner}_${sf.name}`;
          const upd = expr.prefix ? `${expr.op}${raw}` : `${raw}${expr.op}`;
          const o = this.emitExpr(expr.target);
          return {
            code: this.cinitClasses.has(sf.owner) ? `(${sf.owner}_cinit(), ${upd})` : `(${upd})`,
            type: o.type,
          };
        }
        const o = this.emitExpr(expr.target);
        // Increment/decrement of a NON-lvalue target that sequenceValueExpr could
        // not hoist: an Index element (`x[i]++` — a runtime accessor, never a C
        // lvalue) or a getter/setter property. This shape reaches here from a
        // value context that must not be pre-evaluated (a `?:`/`&&` branch), so
        // the read-modify-write is folded into ONE C expression whose side effects
        // stay inside that branch: `(t = read, store, t)` for the postfix form
        // (the value is the pre-increment read) and `(t = read, store, t ± 1)` for
        // the prefix form. The scratch variable is declared here — the enclosing
        // statement is emitted only after this expression's text is built, so the
        // declaration lands ahead of it — and deliberately left uninitialized, so
        // the branch that is not taken leaves no side effect behind.
        if (expr.target.kind === 'Index') {
          const num: CType = { kind: 'number' };
          const sign = expr.op === '++' ? '+' : '-';
          const t = this.tmpName('upd');
          this.line(`${this.cTypeName(num)} ${t};`);
          const read = this.convert(this.emitExpr(this.toNumberAst(expr.target)), num);
          const store = this.emitAssign(this.indexUpdateStore(expr.target, expr.op));
          return {
            code: `((${t} = ${read}), ${store.code}, ${expr.prefix ? `(${t} ${sign} 1)` : t})`,
            type: num,
          };
        }
        const us2 = this.resolveUpdateSetter(expr.target);
        if (us2) {
          // Getter/setter property `obj.prop++` in a branch that cannot be
          // pre-evaluated: the getter read is not a C lvalue either.
          const t = this.tmpName('upd');
          this.line(`${this.cTypeName(o.type)} ${t};`);
          const sign = expr.op === '++' ? '+' : '-';
          const call = this.setterCallCode(us2.owner, us2.property, us2.isStatic, us2.objCode,
            this.convert({ code: `(${t} ${sign} 1)`, type: o.type }, us2.paramType));
          return {
            code: `((${t} = ${o.code}), ${call}, ${expr.prefix ? `(${t} ${sign} 1)` : t})`,
            type: o.type,
          };
        }
        const code = expr.prefix ? `(${expr.op}${o.code})` : `(${o.code}${expr.op})`;
        return { code, type: o.type };
      }

      case 'Conditional': {
        const c = this.emitExpr(expr.cond);
        const tRaw = this.emitExpr(expr.then);
        const eRaw = this.emitExpr(expr.else);
        const type = this.unifyType(tRaw.type, eRaw.type);
        const t = this.convert(tRaw, type);
        const e = this.convert(eRaw, type);
        return { code: `(${this.condExpr(c)} ? ${t} : ${e})`, type };
      }

      case 'Assign': {
        const hoisted = this.hoistedAssigns.get(expr);
        if (hoisted) return { code: hoisted.tmp, type: hoisted.type };
        return this.emitAssign(expr);
      }

      case 'Call':
        return this.emitCall(expr);

      case 'Member':
        return this.emitMember(expr);

      case 'AttrAccess':
        return this.emitAttrAccess(expr);

      case 'Filter':
        return this.emitFilter(expr);

      case 'SuperMethod':
        return this.emitSuperMethod(expr);

      case 'SuperProperty':
        return this.emitSuperProperty(expr);

      case 'Is':
        return this.emitIs(expr);

      case 'As':
        return this.emitAs(expr);

      case 'In':
        return this.emitIn(expr);

      case 'New':
        return this.emitNew(expr);
      case 'NewDynamic':
        return this.emitNewDynamic(expr);

      case 'ArrayLit':
        return this.emitArrayLit(expr);

      case 'VectorLit':
        return this.emitVectorLit(expr);

      case 'Index':
        return this.emitIndex(expr);

      case 'ObjectLit':
        return this.emitObjectLit(expr);

      case 'FunctionExpr': {
        const name = this.anonIndex.get(expr)!;
        const captures = this.anonCaptures.get(expr) ?? [];
        const anonFn = this.anonFuncs.find((f) => f.name === name);
        const arity = anonFn ? this.requiredArity(anonFn.params) : 0;
        if (captures.length === 0) {
          return { code: `as_fn_make(${name}__call, NULL, ${arity})`, type: { kind: 'function' } };
        }
        // Capture each free variable's current value into a heap-allocated env.
        const vals = captures.map((c) => this.emitVar(c.name).code).join(', ');
        return { code: `as_fn_make(${name}__call, ${name}_env_make(${vals}), ${arity})`, type: { kind: 'function' } };
      }

      case 'RegExp': {
        const pattern = `"${this.escapeCString(expr.pattern)}"`;
        const flags = `"${this.escapeCString(expr.flags)}"`;
        return { code: `RegExp_new(${pattern}, ${flags})`, type: { kind: 'object', className: 'RegExp' } };
      }
    }
  }

  private emitVar(name: string): { code: string; type: CType } {
    if (name === 'this') {
      if (!this.currentClass) throw new CodegenError("'this' used outside a class method");
      // Inside a closure that captured `this`, the receiver lives in the env
      // (the closure body has no `this` parameter of its own).
      if (this.currentClosureCaptures?.has('this')) {
        return { code: `env->${this.cIdent('this')}`, type: this.currentClosureCaptures.get('this')! };
      }
      return { code: 'this', type: { kind: 'object', className: this.currentClass } };
    }
    // AS3 global `undefined` constant (boxed as_value with a dedicated tag).
    if (name === 'undefined') {
      return { code: 'as_v_undefined()', type: { kind: 'any' } };
    }
    // Captured variable inside a closure: read through the environment pointer.
    if (this.currentClosureCaptures?.has(name)) {
      const t = this.currentClosureCaptures.get(name)!;
      // Capture by reference: a captured var-local that owns an activation cell is
      // reached through the cell the env carries, so assignments made by the
      // enclosing body after this closure was created are visible here too.
      const cell = this.currentClosureCells?.get(name);
      if (cell !== undefined) return { code: `env->${this.cIdent(cell)}->${this.cIdent(name)}`, type: t };
      return { code: `env->${this.cIdent(name)}`, type: t };
    }
    // Boxed captured local in the enclosing function: read through the shared
    // closure cell so the enclosing body and its closures see the same storage
    // (reference semantics — a closure mutating `numComplete` propagates back).
    if (this.enclosingCaptured.has(name)) {
      const cap = this.enclosingCaptured.get(name)!;
      return { code: `${cap.cell}->${cap.field}`, type: cap.type };
    }
    // Local (block-scoped) variables shadow class members and module globals.
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const lt = this.scopes[i].get(name);
      if (lt !== undefined) return { code: this.cIdent(name), type: lt };
    }
    // Unqualified identifier inside a method falls back to a field (this->name),
    // a static field (Class_name), or a getter.
    if (this.currentClass) {
      const self = this.emitVar('this').code;
      const cinfo = this.symbols.getClass(this.currentClass);
      const f = this.symbols.fieldSlot(this.currentClass, name);
      if (f) {
        if (!this.symbols.isAccessible(f.visibility, f.owner, this.currentClass)) {
          throw new CodegenError(`field '${name}' is not accessible here`);
        }
        return { code: `${self}->${this.cIdent(f.cName ?? name)}`, type: f.type };
      }
      const sf = cinfo?.staticFields.get(name);
      if (sf) {
        if (!this.symbols.isAccessible(sf.visibility, sf.owner, this.currentClass)) {
          throw new CodegenError(`static field '${name}' is not accessible here`);
        }
        return { code: this.sfRead(sf.owner, name), type: sf.type };
      }
      const g = cinfo?.getters.get(name);
      if (g) {
        if (!this.symbols.isAccessible(g.visibility, g.owner, this.currentClass)) {
          throw new CodegenError(`getter '${name}' is not accessible here`);
        }
        // Instance getter dispatch is VIRTUAL (a subclass may override `get foo()`
        // and a base-typed reference must reach the runtime object's override).
        // Dispatch through the vtable slot rather than statically to g.owner.
        return { code: `(${self}->vtable->get_${this.cIdent(name)}(${self}))`, type: g.returnType };
      }
      // A bare identifier naming a static getter (`useDoubleBuffering` inside a
      // static or instance method) reaches `Class.prop`, not `this.prop`.
      const sg = cinfo?.staticGetters?.get(name);
      if (sg) {
        if (!this.symbols.isAccessible(sg.visibility, sg.owner, this.currentClass)) {
          throw new CodegenError(`static getter '${name}' is not accessible here`);
        }
        return { code: `${sg.owner}_get_${name}_static(NULL)`, type: sg.returnType };
      }
      // A method referenced by its bare name is `this.method` used as a value
      // (e.g. passed as a listener). Bind the receiver in a thunk.
      if (!this.currentIsStatic) {
        const m = cinfo?.methods.get(name);
        if (m) {
          if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
            throw new CodegenError(`method '${name}' is not accessible here`);
          }
          return { code: `as_fn_make(${this.currentClass}_${name}__bound, (void*)${self}, ${this.requiredArity(m.params)})`, type: { kind: 'function' } };
        }
      }
      // A bare identifier naming a static method is `Class.method` used as a value
      // in ANY context (static methods carry no receiver).
      const sm = cinfo?.staticMethods.get(name);
      if (sm) {
        if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
          throw new CodegenError(`static method '${name}' is not accessible here`);
        }
        return { code: `as_fn_make(${sm.owner}_${name}__call, NULL, ${this.requiredArity(sm.params)})`, type: { kind: 'function' } };
      }
    }
    // Module-level (top-level) variables are only visible outside class methods,
    // so a top-level `stage` never shadows the DisplayObject.stage getter.
    if (this.currentClass === null) {
      const mt = this.moduleScope.get(name);
      if (mt !== undefined) return { code: this.moduleCName(name), type: mt };
    }
    // A free function used as a value (var f:Function = foo).
    const func = this.symbols.getFunc(name);
    if (func) return { code: `as_fn_make(${name}__call, NULL, ${this.requiredArity(func.params)})`, type: { kind: 'function' } };
    // A recursive nested function references its own name (`setTimeout(fn, 1)`);
    // that resolves to a closure over the CURRENT env, not a rebuilt env (which
    // would recurse forever). Only relevant while emitting that function's body.
    if (name === this.currentFuncCName || (this.currentFuncAsName !== null && name === this.currentFuncAsName)) {
      const envArg = this.currentClosureCaptures ? 'env' : 'NULL';
      return { code: `as_fn_make(${this.currentFuncCName}__call, ${envArg}, ${this.currentFuncArity})`, type: { kind: 'function' } };
    }
    // A nested function declaration used as a value: build its closure by
    // capturing the enclosing variables recorded during pass 1. Resolve the
    // source-level name to the defining class's unique C name (nested function
    // names are function-scoped, so they can legitimately repeat across classes).
    const nfKey = this.nestedFuncByAsName.get(`${this.currentClass ?? ''}:${this.currentMethod ?? ''}:${name}`);
    const nf = nfKey !== undefined ? this.nestedFuncs.get(nfKey) : undefined;
    if (nf) {
      // A mutually-recursive sibling group member's function value lives in the
      // shared cell (identity-stable, so `removeEventListener(..., handler)`
      // still matches). Inside a sibling body `env` IS the cell; in the enclosing
      // method body the cell local is lazily initialized once on first reference
      // (after any prior variable assignments, e.g. `profiles = [...]`).
      const group = this.closureGroups.get(nfKey);
      if (group) {
        if (this.currentClosureCaptures) return { code: `env->${nfKey}`, type: { kind: 'function' } };
        // The cell is eagerly allocated in emitClosureCellLocals; the member's
        // `as_fn` slot is already populated by `<cell>_alloc`, so read it directly
        // (identity-stable for removeEventListener's `listener === handler` match).
        return { code: `${group.cellLocal}->${nfKey}`, type: { kind: 'function' } };
      }
      if (nf.captures.length === 0) return { code: `as_fn_make(${nfKey}__call, NULL, ${this.requiredArity(nf.params)})`, type: { kind: 'function' } };
      // Mutual recursion between sibling nested functions (onLoadComplete <->
      // cleanup) would otherwise rebuild each other's env forever. Break the
      // cycle by yielding NULL for a closure that is already being built. This
      // is a pragmatic AOT-subset approximation; see the known-limitations note.
      if (this.buildingClosures.has(nfKey)) return { code: 'NULL', type: { kind: 'function' } };
      this.buildingClosures.add(nfKey);
      try {
        const vals = nf.captures.map((c) => this.emitVar(c.name).code).join(', ');
        return { code: `as_fn_make(${nfKey}__call, ${nfKey}_env_make(${vals}), ${this.requiredArity(nf.params)})`, type: { kind: 'function' } };
      } finally {
        this.buildingClosures.delete(nfKey);
      }
    }
    // A bare class name used as a Class value (`new Starling(Game, ...)`, or a
    // `Class`-typed argument): resolve to the named class object emitted by
    // emitClassRegistry. Only user classes (which have an `_cls` object) qualify.
    const clsName = this.resolveClassName(name);
    if (this.symbols.hasClass(clsName)) {
      const clsInfo = this.symbols.getClass(clsName)!;
      if (clsInfo.fqn !== undefined) {
        return { code: `&${clsName}_cls`, type: { kind: 'class' } };
      }
    }
    throw new CodegenError(`undefined variable '${name}'` + (this.currentClass ? ` in class ${this.currentClass}` : ' at top level') + (this.currentClosureCaptures ? ` (closure captures: [${[...this.currentClosureCaptures.keys()].join(', ')}])` : ''));
  }

  // Whether a statement/expression tree references AS3's `arguments` object.
  // Nested FunctionExpr bodies are NOT descended into: they have their own
  // arguments object, so the enclosing function must not capture them.
  private usesArgumentsStmts(stmts: Stmt[]): boolean {
    for (const s of stmts) if (this.usesArgumentsStmt(s)) return true;
    return false;
  }
  private usesArgumentsStmt(s: Stmt): boolean {
    switch (s.kind) {
      case 'VarDecl': return s.init ? this.usesArgumentsExpr(s.init) : false;
      case 'VarDecls': return s.decls.some((d) => (d.init ? this.usesArgumentsExpr(d.init) : false));
      case 'ConstDecl': return this.usesArgumentsExpr(s.init);
      case 'ConstDecls': return s.decls.some((d) => (d.init ? this.usesArgumentsExpr(d.init) : false));
      case 'ExprStmt': return this.usesArgumentsExpr(s.expr);
      case 'Block': return this.usesArgumentsStmts(s.body);
      case 'If': return this.usesArgumentsExpr(s.cond) || this.usesArgumentsStmt(s.then) || (s.else ? this.usesArgumentsStmt(s.else) : false);
      case 'While': return this.usesArgumentsExpr(s.cond) || this.usesArgumentsStmt(s.body);
      case 'DoWhile': return this.usesArgumentsExpr(s.cond) || this.usesArgumentsStmt(s.body);
      case 'For': return (s.init ? this.usesArgumentsStmt(s.init) : false) || (s.cond ? this.usesArgumentsExpr(s.cond) : false) || (s.update ? this.usesArgumentsExpr(s.update) : false) || this.usesArgumentsStmt(s.body);
      case 'ForIn': return this.usesArgumentsExpr(s.iterable) || this.usesArgumentsStmt(s.body);
      case 'ForEachIn': return this.usesArgumentsExpr(s.iterable) || this.usesArgumentsStmt(s.body);
      case 'Switch': return this.usesArgumentsExpr(s.disc) || s.cases.some((c) => (c.test ? this.usesArgumentsExpr(c.test) : false) || this.usesArgumentsStmts(c.body));
      case 'Break': case 'Continue': return false;
      case 'Label': return this.usesArgumentsStmt(s.body);
      case 'Return': return s.value ? this.usesArgumentsExpr(s.value) : false;
      case 'SuperCall': return s.args.some((a) => this.usesArgumentsExpr(a));
      case 'Throw': return this.usesArgumentsExpr(s.value);
      case 'Try': return this.usesArgumentsStmts(s.tryBody.body) || (s.catchBody ? this.usesArgumentsStmts(s.catchBody.body) : false) || (s.finallyBody ? this.usesArgumentsStmts(s.finallyBody.body) : false);
      case 'FuncDecl': case 'ClassDecl': case 'InterfaceDecl': return false;
    }
  }
  private usesArgumentsExpr(e: Expr): boolean {
    switch (e.kind) {
      case 'Var': return e.name === 'arguments';
      case 'Binary': return this.usesArgumentsExpr(e.left) || this.usesArgumentsExpr(e.right);
      case 'Unary': return this.usesArgumentsExpr(e.operand);
      case 'Typeof': return this.usesArgumentsExpr(e.operand);
      case 'Delete': return this.usesArgumentsExpr(e.target);
      case 'Conditional': return this.usesArgumentsExpr(e.cond) || this.usesArgumentsExpr(e.then) || this.usesArgumentsExpr(e.else);
      case 'Update': return this.usesArgumentsExpr(e.target);
      case 'Assign': return this.usesArgumentsExpr(e.target) || this.usesArgumentsExpr(e.value);
      case 'Call': return this.usesArgumentsExpr(e.callee) || e.args.some((a) => this.usesArgumentsExpr(a));
      case 'Member': return this.usesArgumentsExpr(e.object);
      case 'AttrAccess': return this.usesArgumentsExpr(e.object);
      case 'Filter': return this.usesArgumentsExpr(e.object) || this.usesArgumentsExpr(e.value);
      case 'SuperMethod': return e.args.some((a) => this.usesArgumentsExpr(a));
      case 'SuperProperty': return false;
      case 'Is': return this.usesArgumentsExpr(e.obj);
      case 'As': return this.usesArgumentsExpr(e.obj);
      case 'In': return this.usesArgumentsExpr(e.key) || this.usesArgumentsExpr(e.object);
      case 'New': return e.args.some((a) => this.usesArgumentsExpr(a));
      case 'NewDynamic': return this.usesArgumentsExpr(e.classExpr) || e.args.some((a) => this.usesArgumentsExpr(a));
      case 'ArrayLit': return e.elements.some((el) => this.usesArgumentsExpr(el));
      case 'VectorLit': return e.elements.some((el) => this.usesArgumentsExpr(el));
      case 'Index': return this.usesArgumentsExpr(e.object) || this.usesArgumentsExpr(e.index);
      case 'ObjectLit': return e.fields.some((f) => this.usesArgumentsExpr(f.value));
      case 'FunctionExpr': case 'Num': case 'Str': case 'Bool': case 'Null': case 'RegExp': return false;
    }
  }

  // Emit the `arguments` object for the enclosing function: an as_array* holding
  // each formal parameter re-boxed (AS3 arguments contains the actual values).
  private emitArgumentsDecl(params: Param[]): void {
    this.declareVar('arguments', { kind: 'array' });
    if (params.length === 0) {
      this.line('as_array* arguments = as_array_new();');
      return;
    }
    const items = params.map((p) => this.boxExpr({ code: this.cIdent(p.name), type: this.rt(p.type) }));
    this.line(`as_array* arguments = as_array_make(${params.length}, (as_value[${params.length}]){ ${items.join(', ')} });`);
  }

  // Track the enclosing function's params, and emit the arguments object only
  // when the body actually references it (keeps generated C free of dead locals).
  private emitArgsIfUsed(body: Block, params: Param[]): void {
    this.currentArgs = params;
    if (this.usesArgumentsStmts(body.body)) this.emitArgumentsDecl(params);
  }

  private emitBinary(expr: Extract<Expr, { kind: 'Binary' }>): { code: string; type: CType } {
    const l = this.emitExpr(expr.left);
    const r = this.emitExpr(expr.right);
    const op = expr.op;

    if (op === '+') {
      // string concatenation if either side is a string
      if (l.type.kind === 'string' || r.type.kind === 'string') {
        const ls = l.type.kind === 'string' ? l.code : this.toStringExpr(l);
        const rs = r.type.kind === 'string' ? r.code : this.toStringExpr(r);
        return { code: `as_str_concat(${ls}, ${rs})`, type: { kind: 'string' } };
      }
      // dynamic operand: the runtime tag decides concatenation vs numeric add
      // (AS3/ES3 ToPrimitive — a String, or an object that stringifies, on either
      // side means concatenation). Both operands are boxed and the result is boxed,
      // hence the `any` result type. A statically-typed String operand is already
      // handled above, but a *dynamic* one cannot be: `var a:Array=["x","y"];
      // a[0]+a[1]` used to emit `as_v_to_number(a[0]) + as_v_to_number(a[1])` = 0
      // instead of "xy", and `d + 1` with `d:*` holding "x" gave 1 instead of "x1".
      // The `null` operand rides along: AS3 coerces null to 0 numerically (and to
      // "null" when the other side is a String, handled above), whereas
      // emitArith would emit `(NULL + 1)` — a compile error in C.
      if (l.type.kind === 'any' || r.type.kind === 'any' || l.type.kind === 'null' || r.type.kind === 'null') {
        return { code: `as_add_v(${this.boxExpr(l)}, ${this.boxExpr(r)})`, type: { kind: 'any' } };
      }
      return this.emitArith(l, r, '+');
    }

    if (op === '-' || op === '*') {
      if (l.type.kind === 'any' || r.type.kind === 'any') {
        return { code: `(${this.toNumberExpr(l)} ${op} ${this.toNumberExpr(r)})`, type: { kind: 'number' } };
      }
      return this.emitArith(l, r, op);
    }

    if (op === '/') {
      return { code: `(${this.toNumberExpr(l)} / ${this.toNumberExpr(r)})`, type: { kind: 'number' } };
    }

    if (op === '%') {
      if (l.type.kind === 'any' || r.type.kind === 'any') {
        return { code: `fmod(${this.toNumberExpr(l)}, ${this.toNumberExpr(r)})`, type: { kind: 'number' } };
      }
      // Both operands int/uint: AS3's `%` is int/uint-typed here, but C's `%` is
      // UB on a zero divisor (and on INT_MIN % -1), so both go through the
      // guarded helpers — see as_int_rem/as_uint_rem for the adl-probed values.
      if (l.type.kind === 'int' && r.type.kind === 'int') return { code: `as_int_rem(${l.code}, ${r.code})`, type: { kind: 'int' } };
      if (l.type.kind === 'uint' && r.type.kind === 'uint') return { code: `as_uint_rem(${l.code}, ${r.code})`, type: { kind: 'uint' } };
      // Mixed/Number operands: AS3's remainder is Number here, and fmod matches
      // it exactly (including NaN for a zero divisor, and truncation toward zero).
      return { code: `fmod(${this.convert(l, { kind: 'number' })}, ${this.convert(r, { kind: 'number' })})`, type: { kind: 'number' } };
    }

    // bitwise operators: AS3 converts operands to 32-bit int; `>>>` is unsigned.
    if (op === '&' || op === '|' || op === '^') {
      return { code: `(${this.toInt32Expr(l)} ${op} ${this.toInt32Expr(r)})`, type: { kind: 'int' } };
    }
    if (op === '<<' || op === '>>') {
      return { code: `(${this.toInt32Expr(l)} ${op} (${this.toInt32Expr(r)} & 31))`, type: { kind: 'int' } };
    }
    if (op === '>>>') {
      return { code: `(${this.toUint32Expr(l)} >> (${this.toInt32Expr(r)} & 31))`, type: { kind: 'uint' } };
    }

    if (op === '&&' || op === '||') {
      // Fast path: with both operands statically Boolean, C's `&&`/`||` already has
      // AS3's value semantics — a false left yields `false`, which *is* the left
      // operand's value, and a truthy left yields the right operand — and it
      // short-circuits, evaluating each operand exactly once. The general ternary
      // below would instead emit the left operand twice, which is exponential along
      // a left-nested chain (`a && b && c`, the shape of nearly every AS3 guard:
      // `if (x != null && x.parent != null && …)`).
      if (l.type.kind === 'bool' && r.type.kind === 'bool') {
        return { code: `(${l.code} ${op} ${r.code})`, type: { kind: 'bool' } };
      }
      // AS3's `&&`/`||` return the VALUE of one operand (like JS), not a C bool:
      // `a || b` yields `a` when truthy else `b`; `a && b` yields `b` when `a` is
      // truthy else `a`. A plain C `&&`/`||` here would collapse object references
      // (`_parent || _maskee`) to `bool` and corrupt the result. The left operand
      // is hoisted to a temp by sequenceValueExpr when impure, so it is evaluated
      // exactly once (the ternary short-circuits the right operand as AS3 does).
      const lc = this.condExpr(l);
      const numeric = (t: CType) => t.kind === 'int' || t.kind === 'uint' || t.kind === 'number';
      // Compatible branches unify to a concrete C type; a mixed guard idiom
      // (`bool && object`) has a dynamically-typed result, so both branches are
      // boxed to as_value and the result is typed `any`.
      const compatible =
        l.type.kind === 'any' || r.type.kind === 'any' ||
        l.type.kind === r.type.kind ||
        (numeric(l.type) && numeric(r.type));
      let type: CType;
      let lt: string;
      let rt: string;
      if (compatible) {
        type = this.unifyType(l.type, r.type);
        lt = this.convert(l, type);
        rt = this.convert(r, type);
      } else {
        type = { kind: 'any' };
        lt = this.boxExpr(l);
        rt = this.boxExpr(r);
      }
      return op === '||'
        ? { code: `(${lc} ? ${lt} : ${rt})`, type }
        : { code: `(${lc} ? ${rt} : ${lt})`, type };
    }

    // comparison
    if (op === '==' || op === '!=' || op === '===' || op === '!==') {
      if (l.type.kind === 'any' || r.type.kind === 'any') {
        // Strict equality (`===`/`!==`) dispatches on tag only; loose (`==`/`!=`)
        // treats undefined == null and cross-tag coercion via as_v_eq.
        const cmp = op === '===' || op === '!=='
          ? `as_v_seq(${this.boxExpr(l)}, ${this.boxExpr(r)})`
          : `as_v_eq(${this.boxExpr(l)}, ${this.boxExpr(r)})`;
        return { code: (op === '!=' || op === '!==') ? `(!${cmp})` : cmp, type: { kind: 'bool' } };
      }
      // Statically-typed operands: `===` differs from `==` only in AS3's implicit
      // coercion (absent here since both sides are already the same C type), so the
      // generated C is identical. `emitEquality` only inspects `!=`; strict `!==`
      // collapses to the same negated comparison.
      const code = this.emitEquality(l, r, op === '!==' ? '!=' : op);
      return { code, type: { kind: 'bool' } };
    }
    // < <= > >=
    if (l.type.kind === 'any' || r.type.kind === 'any') {
      return { code: `(${this.toNumberExpr(l)} ${op} ${this.toNumberExpr(r)})`, type: { kind: 'bool' } };
    }
    return { code: `(${l.code} ${op} ${r.code})`, type: { kind: 'bool' } };
  }

  // Numeric arithmetic with AS3 type rules: int op int -> int, uint op uint -> uint,
  // any mix involving Number (or int/uint mix) -> Number. Mixed int/uint is promoted
  // to double in C to avoid unsigned wrap-around pitfalls.
  private emitArith(l: { code: string; type: CType }, r: { code: string; type: CType }, op: string): { code: string; type: CType } {
    if (l.type.kind === 'int' && r.type.kind === 'int') {
      return { code: `(${l.code} ${op} ${r.code})`, type: { kind: 'int' } };
    }
    if (l.type.kind === 'uint' && r.type.kind === 'uint') {
      return { code: `(${l.code} ${op} ${r.code})`, type: { kind: 'uint' } };
    }
    const lc = (l.type.kind === 'int' || l.type.kind === 'uint') ? `((double)(${l.code}))` : l.code;
    const rc = (r.type.kind === 'int' || r.type.kind === 'uint') ? `((double)(${r.code}))` : r.code;
    return { code: `(${lc} ${op} ${rc})`, type: { kind: 'number' } };
  }

  // Result type for the ternary operator: strings win, then Number over integers.
  private unifyType(a: CType, b: CType): CType {
    if (a.kind === b.kind) {
      if (a.kind === 'object') return { kind: 'object', className: (a as { className: string }).className };
      return a;
    }
    if (a.kind === 'string' || b.kind === 'string') return { kind: 'string' };
    if (a.kind === 'any' || b.kind === 'any') {
      if (a.kind === 'any' && b.kind === 'any') return { kind: 'any' };
      // `any` unboxes to the concrete branch's type at runtime (e.g. a record
      // field read vs. a statically-typed SimpleTimeline); keep the concrete one.
      return a.kind === 'any' ? b : a;
    }
    const numeric = new Set(['int', 'uint', 'number']);
    if (numeric.has(a.kind) && numeric.has(b.kind)) {
      return { kind: 'number' };
    }
    return a; // fallback: keep the then-branch type
  }

  private emitEquality(
    l: { code: string; type: CType },
    r: { code: string; type: CType },
    op: string,
  ): string {
    const isNull = (t: CType) => t.kind === 'null';
    const neg = op === '!=' ? '!' : '';
    // Interface values are `{ obj, vt }` structs; `== null` tests the underlying
    // object reference, and interface-to-interface identity compares both fields.
    if (l.type.kind === 'interface' || r.type.kind === 'interface') {
      if (isNull(l.type) || isNull(r.type)) {
        const iv = l.type.kind === 'interface' ? l : r;
        return `${neg}(${iv.code}.obj == NULL)`;
      }
      if (l.type.kind === 'interface' && r.type.kind === 'interface') {
        return `${neg}(${l.code}.obj == ${r.code}.obj && ${l.code}.vt == ${r.code}.vt)`;
      }
      const iv = l.type.kind === 'interface' ? l : r;
      const other = l.type.kind === 'interface' ? r : l;
      return `${neg}(${iv.code}.obj == (void*)(${other.code}))`;
    }
    if (l.type.kind === 'string' || r.type.kind === 'string') {
      if (isNull(l.type) || isNull(r.type)) {
        const s = isNull(l.type) ? r.code : l.code;
        return `${neg}(${s} == NULL)`;
      }
      // Non-string operand is converted to a string first (AS3 loose `==`), so
      // an object whose runtime value is null compares as "null" instead of
      // crashing on strcmp(NULL, ...).
      const ls = l.type.kind === 'string' ? l.code : this.toStringExpr(l);
      const rs = r.type.kind === 'string' ? r.code : this.toStringExpr(r);
      return `${neg}as_str_eq(${ls}, ${rs})`;
    }
    // AS3 `==` on objects is reference identity. When the two static classes
    // differ (e.g. Object* vs EventDispatcher*), cast both to void* so C's
    // distinct-pointer-type warning doesn't fire.
    if (l.type.kind === 'object' && r.type.kind === 'object' && (l.type as { className: string }).className !== (r.type as { className: string }).className) {
      return `${neg}(((void*)(${l.code})) == ((void*)(${r.code})))`;
    }
    return `${neg}(${l.code} == ${r.code})`;
  }

  private toStringExpr(e: { code: string; type: CType }): string {
    switch (e.type.kind) {
      case 'int': return `as_str_from_int(${e.code})`;
      case 'uint': return `as_str_from_uint(${e.code})`;
      case 'number': return `as_str_from_double(${e.code})`;
      case 'bool': return `as_str_from_bool(${e.code})`;
      case 'string': return e.code;
      case 'null': return '"null"';
      case 'object': return `as_obj_to_str(${e.code})`;
      case 'interface': return `as_obj_to_str(${e.code}.obj)`;
      case 'array': return 'as_array_join(' + e.code + ', ",")';
      case 'vector': return '"[Vector]"';
      case 'record': return '"[object Object]"';
      case 'any': return `as_v_str_val(${e.code})`;
      case 'function': return '"function"';
      case 'class': return '"[class]"';
      // XML/XMLList stringify to their markup (XML.toString()).
      case 'xml': return `as_xml_to_string(${e.code})`;
      case 'xmllist': return `as_xml_list_to_string(${e.code})`;
      // Dictionary/RegExp have no recoverable source text here (as_regex keeps only
      // compiled instructions); render the class form used by vectorElemToStr.
      case 'dict': return '"[object Dictionary]"';
      case 'regexp': return '"[object RegExp]"';
      case 'void': return '""';
      default: throw new CodegenError(`toStringExpr: unhandled operand type '${(e.type as CType).kind}'`);
    }
  }

  // Logical assignment (`a ||= b` / `a &&= b`): short-circuits and writes only
  // when the LHS is falsy / truthy, mirroring AS3's `a || (a = b)` / `a && (a = b)`.
  // The LHS is read twice (test + write), which is only safe for a simple variable
  // (the sole shape Starling uses); an addressable target would need a temporary to
  // avoid duplicating a getter/index side effect.
  private emitLogicalAssign(expr: Extract<Expr, { kind: 'Assign' }>): { code: string; type: CType; discard?: boolean } {
    const target = expr.target;
    // Member field (`obj.field ||= v`): read the field's addressable l-value and
    // short-circuit against it. The receiver is a simple variable in Starling, so
    // no temporary is needed to preserve receiver side effects.
    if (target.kind === 'Var' || target.kind === 'Member') {
      const t = this.emitExpr(target);
      // AS3 truthiness: boxed `any` dispatches on tag; interface values test the
      // underlying object reference; every other C type's native truthiness
      // (non-zero / non-NULL) already matches AS3.
      const truthy = this.condExpr(t);
      const v = this.convert(this.emitExpr(expr.value), t.type);
      const store = this.gcWriteAssign(t.code, t.type, v);
      const write = store ?? `(${t.code} = ${v})`;
      if (expr.op === '||=') {
        return { code: `(${truthy} ? ${t.code} : ${write})`, type: t.type, discard: true };
      }
      return { code: `(${truthy} ? ${write} : ${t.code})`, type: t.type, discard: true };
    }
    throw new CodegenError(`logical assignment ${expr.op} only supports a simple variable or field target`);
  }

  private emitAssign(expr: Extract<Expr, { kind: 'Assign' }>): { code: string; type: CType; discard?: boolean } {
    const hoisted = this.hoistedAssigns.get(expr);
    if (hoisted) return { code: hoisted.tmp, type: hoisted.type };
    const target = expr.target;

    // Logical assignment (`||=` / `&&=`): short-circuits and writes only when the
    // LHS is falsy / truthy. Deferred to a dedicated emitter (cannot fold through
    // COMPOUND_BASE because `||`/`&&` in emitBinary return a bool, not a value).
    if (expr.op === '||=' || expr.op === '&&=') {
      return this.emitLogicalAssign(expr);
    }

    // a[i] = v  (and a[i] += v etc.)
    if (target.kind === 'Index') {
      const obj = this.emitExpr(target.object);
      if (obj.type.kind === 'vector') {
        const elem = obj.type.elem;
        const key = this.vectorCName(elem);
        const idx = this.convert(this.emitExpr(target.index), { kind: 'int' });
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          const ev = this.convert(v, elem);
          return { code: `as_vector_${key}_set(${obj.code}, ${idx}, ${ev})`, type: elem };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        const cv = this.convert(combined, elem);
        return { code: `as_vector_${key}_set(${obj.code}, ${idx}, ${cv})`, type: elem };
      }
      if (obj.type.kind === 'array') {
        const idx = this.convert(this.emitExpr(target.index), { kind: 'int' });
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_array_set(${obj.code}, ${idx}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_array_set(${obj.code}, ${idx}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // Dictionary obj[key] = v, key is an object reference.
      if (obj.type.kind === 'dict') {
        const key = this.emitExpr(target.index);
        const keyRef = this.dictKeyRef(key);
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_dict_set(${obj.code}, ${keyRef}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_dict_set(${obj.code}, ${keyRef}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // record / Object / any dynamic key write.
      const key = this.emitExpr(target.index);
      const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
      if (obj.type.kind === 'record') {
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_object_set(${obj.code}, ${keyStr}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_object_set(${obj.code}, ${keyStr}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // Any class instance supports obj[key] = value dynamic write: route through
      // as_dyn_set, which walks the vtable super chain for a reflectable field
      // named `key` (and falls back to the record/_dyn slot table for dynamic
      // objects). AS3's `obj[key] = v` is reflection-based, not limited to
      // `dynamic class` receivers (e.g. `tween[property] = value` in Juggler).
      if (obj.type.kind === 'object') {
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_dyn_set((void*)(${obj.code}), ${keyStr}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_dyn_set((void*)(${obj.code}), ${keyStr}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      if (obj.type.kind === 'any') {
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_any_set(${obj.code}, ${keyStr}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_any_set(${obj.code}, ${keyStr}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      throw new CodegenError('index write on non-dynamic type');
    }

    // super.prop = v (and super.prop OP= v): write a superclass field or setter.
    if (target.kind === 'SuperProperty') {
      if (!this.currentClass) throw new CodegenError("'super' used outside a class method");
      const info = this.symbols.getClass(this.currentClass)!;
      if (!info.superClass) throw new CodegenError(`class '${this.currentClass}' has no superclass`);
      const superInfo = this.symbols.getClass(info.superClass)!;
      const f = this.symbols.fieldSlot(info.superClass, target.property);
      if (f) {
        const code = expr.op === '='
          ? this.convert(this.emitExpr(expr.value), f.type)
          : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), f.type);
        const lv = `this->${this.cIdent(f.cName ?? target.property)}`;
        const store = this.gcWriteAssign(lv, f.type, code);
        if (store) return { code: store, type: f.type, discard: true };
        return { code: `(${lv} = ${code})`, type: f.type };
      }
      const s = superInfo.setters.get(target.property);
      if (s) {
        const paramType = this.rt(s.params[0].type);
        const code = expr.op === '='
          ? this.convert(this.emitExpr(expr.value), paramType)
          : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), paramType);
        return { code: `${s.owner}_set_${target.property}(this, ${code})`, type: { kind: 'void' } };
      }
      throw new CodegenError(`undefined property '${target.property}' on superclass '${info.superClass}'`);
    }

    if (target.kind !== 'Var' && target.kind !== 'Member') {
      throw new CodegenError('invalid assignment target');
    }

    // o.x = v (and o.x OP= v) on an object literal: mutate the associative map.
    if (target.kind === 'Member') {
      // static field: ClassName.field = v
      if (target.object.kind === 'Var') {
        const cname = this.resolveClassName(target.object.name);
        if (this.symbols.hasClass(cname)) {
          const cinfo = this.symbols.getClass(cname)!;
          const sf = cinfo.staticFields.get(target.property);
          if (sf) {
            // Compound assignment folds the old value in (`C.f += v` =>
            // `C.f = C.f OP v`), matching AS3 semantics.
            const code = expr.op === '='
              ? this.convert(this.emitExpr(expr.value), sf.type)
              : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), sf.type);
            return { code: this.sfWrite(sf.owner, target.property, code), type: sf.type };
          }
          // Static setter: `Class.prop = v` -> `Class_set_prop_static(NULL, v)`.
          const ss = cinfo.staticSetters?.get(target.property);
          if (ss) {
            if (!this.symbols.isAccessible(ss.visibility, ss.owner, this.currentClass)) {
              throw new CodegenError(`static setter '${target.property}' is not accessible here`);
            }
            const paramType = this.rt(ss.params[0].type);
            const code = expr.op === '='
              ? this.convert(this.emitExpr(expr.value), paramType)
              : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), paramType);
            return { code: `${ss.owner}_set_${target.property}_static(NULL, ${code})`, type: { kind: 'void' } };
          }
        }
      }
      const obj = this.emitExpr(target.object);
      // Vector.length = n: shrink truncates; grow fills with element default.
      if (obj.type.kind === 'vector' && target.property === 'length') {
        if (expr.op !== '=') throw new CodegenError('Vector.length only supports simple assignment');
        const n = this.convert(this.emitExpr(expr.value), { kind: 'int' });
        return { code: `as_vector_${this.vectorCName(obj.type.elem)}_setLength(${obj.code}, ${n})`, type: { kind: 'void' } };
      }
      if (obj.type.kind === 'record') {
        const key = `"${this.escapeCString(target.property)}"`;
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_object_set(${obj.code}, ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_object_set(${obj.code}, ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // AS3 Array is dynamic: writing an undeclared property stores an ordinary
      // named property, never an element. Excludes `length`, which the language
      // gives real resize semantics (unsupported here, so it still errors loudly
      // rather than silently landing in the named-property table).
      if (obj.type.kind === 'array' && target.property !== 'length') {
        const key = `"${this.escapeCString(target.property)}"`;
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_array_prop_set(${obj.code}, ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_array_prop_set(${obj.code}, ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // `d.prop = v` where `d` is dynamically typed (`*`): the receiver's runtime
      // tag decides how the write lands, so this must go through as_any_set
      // (tag 4 object → as_dyn_set: vtable field/setter reflection, then a
      // record-slot fallback; tag 6 array → index write; anything else → no-op).
      // The previous code cast the box unconditionally to `as_object*` and called
      // as_object_set, i.e. it treated the receiver as an anonymous record: on a
      // sealed class instance the vtable pointer was read as a props table and on
      // an Array the element buffer was written as one — `d.unknown = 5` on a
      // sealed instance segfaulted, and `d.bar = 8` on an Array silently corrupted
      // it (d.length became garbage), stage 89-33. This mirrors the read path
      // (as_any_get) and the `d["k"] = v` path (as_any_set).
      if (obj.type.kind === 'any') {
        const key = `"${this.escapeCString(target.property)}"`;
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_any_set(${obj.code}, ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_any_set(${obj.code}, ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // AS3 root Object is dynamic: obj.prop = v on an Object-typed value is a
      // reflective field write (falls back to a record slot for plain records).
      if (obj.type.kind === 'object' && obj.type.className === 'Object') {
        const key = `"${this.escapeCString(target.property)}"`;
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_dyn_set((void*)(${obj.code}), ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_dyn_set((void*)(${obj.code}), ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
      }
      // setter: obj.prop = v -> ClassName_set_prop(obj, v)
      if (obj.type.kind === 'object') {
        const cinfo = this.symbols.getClass(obj.type.className);
        const s = cinfo?.setters.get(target.property);
        if (s) {
          const paramType = this.rt(s.params[0].type);
          // Compound assignment reads the current value through the getter and
          // folds it in (`obj.prop += v` => `set(obj, get(obj) OP v)`) instead of
          // discarding the old value.
          const code = expr.op === '='
            ? this.convert(this.emitExpr(expr.value), paramType)
            : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), paramType);
          return { code: this.setterCallCode(s.owner, target.property, false, obj.code, code), type: { kind: 'void' } };
        }
        // Dynamic class (AS3 `dynamic class`): an undeclared member write lands in
        // the runtime slot table via as_dyn_set (falls back to the `_dyn` record).
        if (cinfo?.isDynamic && !cinfo.fields.has(target.property)) {
          const key = `"${this.escapeCString(target.property)}"`;
          if (expr.op === '=') {
            const v = this.emitExpr(expr.value);
            return { code: `as_dyn_set((void*)(${obj.code}), ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
          }
          const op = COMPOUND_BASE[expr.op];
          const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
          return { code: `as_dyn_set((void*)(${obj.code}), ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
        }
      }
    }

    // Bare-identifier setter assignment (`nativeOverlayBlocksTouches = true` or a
    // static `useDoubleBuffering = true`). An unqualified name that names a setter
    // (and is not shadowed by a local) writes through the setter; without this,
    // `emitExpr` resolves the bare name to the getter and we'd emit an rvalue into
    // `=` ("expression is not assignable").
    if (target.kind === 'Var' && this.currentClass) {
      let isLocal = false;
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        if (this.scopes[i].has(target.name)) { isLocal = true; break; }
      }
      if (!isLocal) {
        const cinfo = this.symbols.getClass(this.currentClass);
        if (!this.currentIsStatic) {
          const s = cinfo?.setters.get(target.name);
          if (s) {
            const self = this.emitVar('this').code;
            const paramType = this.rt(s.params[0].type);
            const code = expr.op === '='
              ? this.convert(this.emitExpr(expr.value), paramType)
              : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), paramType);
            return { code: this.setterCallCode(s.owner, target.name, false, self, code), type: { kind: 'void' } };
          }
        }
        const ss = cinfo?.staticSetters?.get(target.name);
        if (ss) {
          const paramType = this.rt(ss.params[0].type);
          const code = expr.op === '='
            ? this.convert(this.emitExpr(expr.value), paramType)
            : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), paramType);
          return { code: `${ss.owner}_set_${target.name}_static(NULL, ${code})`, type: { kind: 'void' } };
        }
      }
    }

    // Bare-identifier static-FIELD assignment (`sCurrent = null` where `sCurrent`
    // is `static var sCurrent`). The field must remain an lvalue, so fold the
    // class's `_cinit` around the whole assignment (sfWrite) instead of wrapping
    // the read into a comma expression and assigning into it.
    const sfTarget = this.resolveStaticFieldTarget(target);
    if (sfTarget) {
      const ft = this.emitExpr(target).type;
      const code = expr.op === '='
        ? this.convert(this.emitExpr(expr.value), ft)
        : this.convert(this.emitBinary({ kind: 'Binary', op: COMPOUND_BASE[expr.op], left: target, right: expr.value }), ft);
      return { code: this.sfWrite(sfTarget.owner, sfTarget.name, code), type: ft };
    }

    const t = this.emitExpr(target);
    const v = this.emitExpr(expr.value);

    if (expr.op === '=') {
      const code = this.convert(v, t.type);
      // Direct field write of a pointer/boxed slot (o.field = v) needs a write
      // barrier during incremental marking (GC-4): a BLACK object must not gain
      // a direct WHITE reference unobserved. Local/global variable slots are
      // covered by roots at the safe point and need no barrier. A bare-identifier
      // target can also name an instance field / captured closure slot (e.g. a
      // setter body's `_name = value`), so those heap-field writes need the same
      // barrier as an explicit `o.field = v`.
      if (target.kind === 'Member' || this.resolvesToHeapField(target)) {
        const store = this.gcWriteAssign(t.code, t.type, code);
        if (store) return { code: store, type: t.type, discard: true };
      }
      return { code: `(${t.code} = ${code})`, type: t.type };
    }

    // compound assignment: target = target OP value
    const op = COMPOUND_BASE[expr.op];
    const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
    const code = this.convert(combined, t.type);
    if (target.kind === 'Member' || this.resolvesToHeapField(target)) {
      const store = this.gcWriteAssign(t.code, t.type, code);
      if (store) return { code: store, type: t.type, discard: true };
    }
    return { code: `(${t.code} = ${code})`, type: t.type };
  }

  private emitCall(expr: Extract<Expr, { kind: 'Call' }>): { code: string; type: CType } {
    const callee = expr.callee;

    // builtin trace(...)
    if (callee.kind === 'Var' && callee.name === 'trace') {
      return { code: this.emitTrace(expr.args), type: { kind: 'void' } };
    }

    // method call obj.method(...)
    if (callee.kind === 'Member') {
      // System.gc(): force a stop-the-world collection (offscreen loops use this
      // to bound memory; window builds collect incrementally via gc_step).
      if (callee.object.kind === 'Var' && callee.object.name === 'System' && callee.property === 'gc') {
        return { code: 'as_system_gc()', type: { kind: 'void' } };
      }
      // System.output(str): write a string verbatim to stdout (AIR 33.1 console).
      if (callee.object.kind === 'Var' && callee.object.name === 'System' && callee.property === 'output') {
        const a = this.emitExpr(expr.args[0]);
        return { code: `as_system_output(${a.code})`, type: { kind: 'void' } };
      }
      // System.pauseForGCIfCollectionImminent(n): a GC hint; no-op under AOT
      // (the managed heap is precise and incrementally collected at frame
      // boundaries, so there is no stop-the-world collection to forestall).
      if (callee.object.kind === 'Var' && callee.object.name === 'System' && callee.property === 'pauseForGCIfCollectionImminent') {
        return { code: '(void)0', type: { kind: 'void' } };
      }
      // System.disposeXML(xml): AIR hint to release an XML object early. Our GC
      // reclaims XML automatically, so it is a no-op (the argument is still
      // evaluated to preserve any side effects).
      if (callee.object.kind === 'Var' && callee.object.name === 'System' && callee.property === 'disposeXML') {
        const a = this.emitExpr(expr.args[0]);
        return { code: `(void)(${a.code})`, type: { kind: 'void' } };
      }
      // Math.abs(...) etc.
      if (callee.object.kind === 'Var' && callee.object.name === 'Math') {
        return this.emitMathMethod(callee.property, expr.args);
      }
      // String.fromCharCode(...) static method.
      if (callee.object.kind === 'Var' && callee.object.name === 'String') {
        return this.emitStringStatic(callee.property, expr.args);
      }
      // JSON.stringify(...) / JSON.parse(...) top-level static methods.
      if (callee.object.kind === 'Var' && callee.object.name === 'JSON') {
        return this.emitJSONMethod(callee.property, expr.args);
      }
      // static method: ClassName.method(...)
      if (callee.object.kind === 'Var') {
        const cname = this.resolveClassName(callee.object.name);
        if (this.symbols.hasClass(cname)) {
          const cinfo = this.symbols.getClass(cname)!;
          const sm = cinfo.staticMethods.get(callee.property);
          if (sm) {
            if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
              throw new CodegenError(`static method '${callee.property}' is not accessible here`);
            }
            const args = this.emitArgs(sm.params, expr.args);
            return { code: `${sm.owner}_${callee.property}_static(${args})`, type: sm.returnType };
          }
          throw new CodegenError(`undefined static method '${callee.property}' on class '${callee.object.name}'`);
        }
      }
      // vec.push.apply(vec, argsArray) / arr.push.apply(arr, argsArray): Starling's
      // spread-push idiom. vec.push is a bound variadic method; apply spreads an
      // Array of values into it.
      if (callee.property === 'apply' && callee.object.kind === 'Member' && callee.object.property === 'push') {
        const target = this.emitExpr(callee.object.object);
        const argsArray = this.emitExpr(expr.args[1]);
        if (target.type.kind === 'vector') {
          return { code: `as_vector_${this.vectorCName(target.type.elem)}_push_all(${target.code}, ${argsArray.code})`, type: { kind: 'int' } };
        }
      }
      const obj = this.emitExpr(callee.object);
      // Function.apply(thisArg, argsArray) / Function.call(thisArg, ...args) on a
      // statically-typed Function value (a bound method reference or a closure).
      // `thisArg` is redundant for already-bound methods but matches AS3.
      if (obj.type.kind === 'function' && callee.property === 'apply') {
        if (expr.args.length !== 2) throw new CodegenError('Function.apply expects (thisArg, argsArray)');
        const argsBox = this.boxExpr(this.emitExpr(expr.args[1]));
        return { code: `as_fn_apply_v(as_v_fn((void*)${obj.code}), ${argsBox})`, type: { kind: 'any' } };
      }
      if (obj.type.kind === 'function' && callee.property === 'call') {
        const items = expr.args.slice(1).map((a) => this.boxExpr(this.emitExpr(a)));
        const n = items.length;
        const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
        return { code: `as_fn_call_dyn(as_v_fn((void*)${obj.code}), ${arr}, ${n})`, type: { kind: 'any' } };
      }
      if (obj.type.kind === 'array') {
        return this.emitArrayMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'vector') {
        return this.emitVectorMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'string') {
        return this.emitStringMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'number' || obj.type.kind === 'int' || obj.type.kind === 'uint') {
        return this.emitNumberMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'bool') {
        return this.emitBoolMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'any') {
        return this.emitAnyMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'xml' || obj.type.kind === 'xmllist') {
        return this.emitXmlMethod(obj, callee.property, expr.args);
      }
      if (obj.type.kind === 'interface') {
        const intf = this.symbols.interfaces.get(obj.type.name)!;
        const m = intf.methods.get(callee.property);
        if (!m) throw new CodegenError(`undefined method '${callee.property}' on interface '${obj.type.name}'`);
        const args = this.emitArgs(m.params, expr.args);
        const callArgs = args ? ', ' + args : '';
        return { code: `(${obj.code}.vt->${this.cIdent(callee.property)}(${obj.code}.obj${callArgs}))`, type: m.returnType };
      }
      if (obj.type.kind !== 'object') {
        throw new CodegenError(`cannot call method '${callee.property}' on non-object type`);
      }
      const cinfo = this.symbols.getClass(obj.type.className);
      let m = cinfo?.methods.get(callee.property);
      // Inherited method: AS3 dispatches through the vtable, so a method declared
      // on a superclass (e.g. Object.hasOwnProperty) is callable on any subclass
      // even when its static type does not redeclare it.
      if (!m) {
        const found = this.symbols.findMethod(obj.type.className, callee.property);
        if (found) m = found.m;
      }
      // `Object` is the dynamic-record convention (as_object*); a method call on
      // it is resolved at runtime through as_dyn_call (returns null when absent).
      if (!m && obj.type.className === 'Object') {
        const items = expr.args.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = items.length;
        const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
        return { code: `as_dyn_call(${obj.code}, "${this.escapeCString(callee.property)}", ${arr}, ${n})`, type: { kind: 'any' } };
      }
      if (!m) throw new CodegenError(`undefined method '${callee.property}' on class '${obj.type.className}'`);
      if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
        throw new CodegenError(`method '${callee.property}' is not accessible here`);
      }
      const args = this.emitArgs(m.params, expr.args);
      const callArgs = args ? ', ' + args : '';
      return {
        code: `(${obj.code}->vtable->${this.cIdent(callee.property)}(${obj.code}${callArgs}))`,
        type: m.returnType,
      };
    }

    // free function call
    if (callee.kind === 'Var') {
      // Implicit `this.method(...)` call: a bare method name inside an instance
      // method dispatches through the vtable with `this` as the receiver.
      if (this.currentClass && !this.currentIsStatic) {
        const cinfo = this.symbols.getClass(this.currentClass);
        const m = cinfo?.methods.get(callee.name);
        if (m) {
          if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
            throw new CodegenError(`method '${callee.name}' is not accessible here` + (this.currentClass ? ` in class ${this.currentClass}` : ''));
          }
          const args = this.emitArgs(m.params, expr.args);
          const callArgs = args ? ', ' + args : '';
          // The receiver is `this` normally, or `env->this` when this call site
          // lives inside a closure that captured the enclosing `this`.
          const self = this.emitVar('this').code;
          return { code: `(${self}->vtable->${this.cIdent(callee.name)}(${self}${callArgs}))`, type: m.returnType };
        }
      }
      // Bare static-method call from within the same class (e.g. `init()` called
      // by the constructor, or a static helper called by an instance method).
      // AS3 resolves these to the class's static method without a receiver.
      if (this.currentClass) {
        const cinfo = this.symbols.getClass(this.currentClass);
        const sm = cinfo?.staticMethods.get(callee.name);
        if (sm) {
          if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
            throw new CodegenError(`static method '${callee.name}' is not accessible here`);
          }
          const args = this.emitArgs(sm.params, expr.args);
          return { code: `${sm.owner}_${callee.name}_static(${args})`, type: sm.returnType };
        }
      }
      const builtin = this.emitGlobalCall(callee.name, expr.args);
      if (builtin) return builtin;
      // AS3 cast syntax `Type(expr)`: a single-argument call whose callee names
      // a known user class/interface is a checked cast (semantically `expr as
      // Type`). Guard with hasClass so plain free functions are never misread.
      if (expr.args.length === 1) {
        const ct = this.rt(callee.name);
        if (ct.kind === 'interface' || (ct.kind === 'object' && this.symbols.hasClass(ct.className))) {
          return { code: this.convert(this.emitExpr(expr.args[0]), ct), type: ct };
        }
      }
      const f = this.symbols.getFunc(callee.name);
      if (f) {
        return { code: `${callee.name}(${this.emitArgs(f.params, expr.args)})`, type: f.returnType };
      }
      // a value of type Function held in a variable (var f:Function = ...)
      const v = this.emitExpr(callee);
      if (v.type.kind === 'function') {
        return this.emitFunctionCall(v, expr.args);
      }
      throw new CodegenError(`undefined function '${callee.name}'`);
    }

    // callee is an arbitrary expression resolving to a callable value (e.g.
    // dynamic dispatch `obj[type]()` or a returned Function). Statically-typed
    // Functions dispatch directly; an `any` callee is a boxed function invoked
    // through the uniform thunk.
    {
      const ce = this.emitExpr(callee);
      if (ce.type.kind === 'function') return this.emitFunctionCall(ce, expr.args);
      if (ce.type.kind === 'any') {
        const items = expr.args.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = items.length;
        const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
        return { code: `as_fn_call_dyn(${ce.code}, ${arr}, ${n})`, type: { kind: 'any' } };
      }
    }
    throw new CodegenError('unsupported call expression');
  }

  private emitTrace(args: Expr[]): string {
    if (args.length === 0) return 'printf("\\n")';
    const formats: string[] = [];
    const vals: string[] = [];
    for (const a of args) {
      const e = this.emitExpr(a);
      switch (e.type.kind) {
        case 'int': formats.push('%d'); vals.push(e.code); break;
        case 'uint': formats.push('%u'); vals.push(e.code); break;
        case 'number': formats.push('%s'); vals.push(`as_str_from_double(${e.code})`); break;
        case 'bool': formats.push('%s'); vals.push(`as_str_from_bool(${e.code})`); break;
        case 'string': formats.push('%s'); vals.push(e.code); break;
        case 'array': formats.push('%s'); vals.push(`as_array_join(${e.code}, ",")`); break;
        case 'vector': formats.push('%s'); vals.push('"[Vector]"'); break;
        case 'any': formats.push('%s'); vals.push(`as_v_str_val(${e.code})`); break;
        case 'record': formats.push('%s'); vals.push('"[object Object]"'); break;
        case 'object': formats.push('%s'); vals.push(`as_obj_to_str((void*)(${e.code}))`); break;
        case 'interface': formats.push('%s'); vals.push(`as_obj_to_str(${e.code}.obj)`); break;
        case 'function': formats.push('%s'); vals.push('"function"'); break;
        case 'null': formats.push('%s'); vals.push('"null"'); break;
        case 'void': formats.push('%s'); vals.push('""'); break;
      }
    }
    const fmt = formats.join(' ') + '\\n';
    return `printf("${fmt}"${vals.length ? ', ' + vals.join(', ') : ''})`;
  }

  // E4X attribute access: expr.@name reads the named attribute as a String
  // (XML) or the first matching item's attribute (XMLList). E4X returns an
  // XMLList, but Starling only reads it in a scalar String context, so the
  // emitter narrows it to String (documented in e4x.md).
  private emitAttrAccess(expr: Extract<Expr, { kind: 'AttrAccess' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.object);
    const attr = this.escapeCString(expr.name);
    if (o.type.kind === 'xml') {
      return { code: `as_xml_attr(${o.code}, "${attr}")`, type: { kind: 'string' } };
    }
    if (o.type.kind === 'xmllist') {
      return { code: `as_xml_list_attr(${o.code}, "${attr}")`, type: { kind: 'string' } };
    }
    throw new CodegenError(`'@' attribute access on non-XML type ${o.type.kind}`);
  }

  // E4X filter predicate: expr.(@attr == value) keeps only the items whose named
  // attribute equals (or, for !=, differs from) the given string. Returns an
  // XMLList. Starling uses only `==` here (asset metadata extraction).
  private emitFilter(expr: Extract<Expr, { kind: 'Filter' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.object);
    if (o.type.kind !== 'xmllist' && o.type.kind !== 'xml') {
      throw new CodegenError(`E4X filter '.(...)' requires an XML/XMLList receiver, got ${o.type.kind}`);
    }
    const attr = this.escapeCString(expr.attr);
    const v = this.emitExpr(expr.value);
    const vStr = v.type.kind === 'string' ? v.code : this.toStringExpr(v);
    const op = expr.op === '!=' ? 1 : 0;
    return { code: `as_xml_filter(${o.code}, "${attr}", ${vStr}, ${op})`, type: { kind: 'xmllist' } };
  }

  private emitMember(expr: Extract<Expr, { kind: 'Member' }>): { code: string; type: CType } {
    // flash.system.System static read-only memory stats (System is final and has
    // no instantiable class, so it is handled here like Math/Number constants).
    if (expr.object.kind === 'Var' && expr.object.name === 'System') {
      return this.emitSystemConst(expr.property);
    }
    // flash.system.Capabilities static read-only environment info (same final
    // static-readonly-class pattern as System; version is injected at compile time).
    if (expr.object.kind === 'Var' && expr.object.name === 'Capabilities') {
      return this.emitCapabilitiesConst(expr.property);
    }
    // flash.filesystem.File static directory shortcuts (applicationDirectory /
    // applicationStorageDirectory / desktopDirectory / documentsDirectory /
    // userDirectory), resolved at runtime from the process environment rather than
    // a compile-time path.
    if (expr.object.kind === 'Var' && expr.object.name === 'File') {
      const c = this.emitFileStaticDir(expr.property);
      if (c) return c;
    }
    // Math.PI / Math.E
    if (expr.object.kind === 'Var' && expr.object.name === 'Math') {
      return this.emitMathConst(expr.property);
    }
    // Array sort-option constants (values per the AS3 Array class).
    if (expr.object.kind === 'Var' && expr.object.name === 'Array') {
      const c = this.emitArrayConst(expr.property);
      if (c !== null) return c;
    }
    // Number.MAX_VALUE / int.MAX_VALUE / uint.MAX_VALUE etc.
    if (expr.object.kind === 'Var' && (expr.object.name === 'Number' || expr.object.name === 'int' || expr.object.name === 'uint')) {
      const c = this.emitNumConst(expr.object.name, expr.property);
      if (!c) throw new CodegenError(`undefined constant '${expr.object.name}.${expr.property}'`);
      return c;
    }
    // Fully-qualified static reference: `pkg.subpkg.Class.CONST` / `.staticMethod`.
    // The parser emits a nested Member chain rooted at a Var holding the package's
    // first segment; flatten it and resolve the longest class prefix, the trailing
    // segment being a static member of that class (e.g. `starling.events.Event.ROOT_CREATED`).
    const chain = this.flattenDotChain(expr);
    if (chain && chain.length >= 2) {
      for (let split = chain.length - 1; split >= 1; split--) {
        const cname = this.resolveClassName(chain.slice(0, split).join('.'));
        if (!this.symbols.hasClass(cname)) continue;
        const cinfo = this.symbols.getClass(cname)!;
        const memberName = chain[split];
        const sf = cinfo.staticFields.get(memberName);
        if (sf) {
          if (!this.symbols.isAccessible(sf.visibility, sf.owner, this.currentClass)) {
            throw new CodegenError(`static field '${memberName}' is not accessible here`);
          }
          // Only return when this static member is the FINAL chain segment. When
          // it is an intermediate segment (e.g. `Vector3D.X_AXIS.x`), the static
          // field's value is an object that still has a trailing `.x` field to
          // read — fall through to the normal member path below instead.
          if (split === chain.length - 1) {
            return { code: this.sfRead(sf.owner, memberName), type: sf.type };
          }
          break;
        }
        const sm = cinfo.staticMethods.get(memberName);
        if (sm) {
          if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
            throw new CodegenError(`static method '${memberName}' is not accessible here`);
          }
          if (split === chain.length - 1) {
            return { code: `as_fn_make(${sm.owner}_${memberName}__call, NULL, ${this.requiredArity(sm.params)})`, type: { kind: 'function' } };
          }
          break;
        }
        break; // a known class prefix but unknown member: not an FQN static ref
      }
    }
    // static field access: ClassName.field
    if (expr.object.kind === 'Var') {
      const cname = this.resolveClassName(expr.object.name);
      if (this.symbols.hasClass(cname)) {
        const cinfo = this.symbols.getClass(cname)!;
        const sf = cinfo.staticFields.get(expr.property);
        if (sf) {
          if (!this.symbols.isAccessible(sf.visibility, sf.owner, this.currentClass)) {
            throw new CodegenError(`static field '${expr.property}' is not accessible here`);
          }
          return { code: this.sfRead(sf.owner, expr.property), type: sf.type };
        }
        // Static getter accessor: `Class.prop` -> `Class_get_prop_static(NULL)`.
        const sg = cinfo.staticGetters?.get(expr.property);
        if (sg) {
          if (!this.symbols.isAccessible(sg.visibility, sg.owner, this.currentClass)) {
            throw new CodegenError(`static getter '${expr.property}' is not accessible here`);
          }
          return { code: `${sg.owner}_get_${expr.property}_static(NULL)`, type: sg.returnType };
        }
        // Static method referenced as a Function value (`var f:Function = Foo.bar`).
        const sm = cinfo.staticMethods.get(expr.property);
        if (sm) {
          if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
            throw new CodegenError(`static method '${expr.property}' is not accessible here`);
          }
          return { code: `as_fn_make(${sm.owner}_${expr.property}__call, NULL, ${this.requiredArity(sm.params)})`, type: { kind: 'function' } };
        }
        throw new CodegenError(`undefined static field '${expr.property}' on class '${cname}'`);
      }
    }
    const obj = this.emitExpr(expr.object);
    if (obj.type.kind === 'string' && expr.property === 'length') {
      return { code: `((int)strlen(${obj.code}))`, type: { kind: 'int' } };
    }
    if (obj.type.kind === 'array' && expr.property === 'length') {
      return { code: `(${obj.code}->length)`, type: { kind: 'int' } };
    }
    if (obj.type.kind === 'vector' && expr.property === 'length') {
      return { code: `(${obj.code}->length)`, type: { kind: 'int' } };
    }
    if (obj.type.kind === 'function' && expr.property === 'length') {
      // AS3 Function.length is the declared parameter count.
      return { code: `(${obj.code}->arity)`, type: { kind: 'int' } };
    }
    // E4X child navigation: xml.child / xmlList.child return the matching
    // child nodes as an XMLList (a structural navigation, not a field read).
    if (obj.type.kind === 'xml') {
      return { code: `as_xml_children(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'xmllist' } };
    }
    if (obj.type.kind === 'xmllist') {
      return { code: `as_xml_list_children(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'xmllist' } };
    }
    if (obj.type.kind === 'record') {
      return { code: `as_object_get(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    if (obj.type.kind === 'any' && expr.property === 'length') {
      // a dynamically-typed array/string length (e.g. parsed.tags.length).
      return { code: `as_any_length(${obj.code})`, type: { kind: 'int' } };
    }
    if (obj.type.kind === 'any') {
      // an `any` that is an object at runtime. as_any_get dispatches on the box
      // tag: object (4) → as_dyn_get (field reflection + record-slot fallback),
      // array (6) → index. Using as_object_get here would misread a class
      // instance's vtable as a record slot table — e.g. `event.target.content
      // .bitmapData` in BitmapTextureFactory, where `event.target` is a LoaderInfo
      // held as `*`.
      return { code: `as_any_get(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    // AS3's root `Object` is dynamic: `o.name` on an Object-typed value may be a
    // record slot lookup (JSON.parse results, generic records) OR a reflectable
    // field of a real class instance held as Object (e.g. e.currentTarget.loader).
    // as_dyn_get walks the vtable super chain for a field first, then falls back to
    // the record slot table — a strict superset of as_object_get.
    if (obj.type.kind === 'object' && (obj.type as { className: string }).className === 'Object') {
      if (expr.property === 'constructor') {
        // Object.constructor: the runtime Class reference of the receiver (used
        // for polymorphic cloning: `Object(this).constructor as Class`).
        return { code: `as_v_as_class(as_v_class_of(as_v_obj((void*)(${obj.code}))))`, type: { kind: 'class' } };
      }
      return { code: `as_dyn_get((void*)(${obj.code}), "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    if (obj.type.kind === 'interface') {
      const iname = (obj.type as { name: string }).name;
      const iinfo = this.symbols.interfaces.get(iname);
      const im = iinfo?.methods.get(expr.property);
      if (im) {
        if (im.isGetter) {
          return { code: `${obj.code}.vt->${this.cIdent(expr.property)}(${obj.code}.obj)`, type: im.returnType };
        }
        if (im.isSetter) {
          throw new CodegenError(`setter '${expr.property}' used as a value on interface '${iname}'`);
        }
        // Interface method referenced as a Function value.
        return { code: `as_fn_make(${iname}_${this.cIdent(expr.property)}__bound, (void*)(${obj.code}.obj), ${this.requiredArity(im.params)})`, type: { kind: 'function' } };
      }
      throw new CodegenError(`undefined member '${expr.property}' on interface '${iname}'`);
    }
    if (obj.type.kind === 'array' && expr.property !== 'length') {
      // AS3 Array is dynamic: every property other than the modelled members
      // (`length`) is an ordinary named property. AIR stores `a.bar = 8` beside
      // the elements without touching them, so read it from the named-property
      // table (null when absent) — previously a loud compile error.
      return { code: `as_array_prop_get(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    if (obj.type.kind !== 'object') {
      throw new CodegenError(`cannot access property '${expr.property}' on non-object type`);
    }
    // Object.constructor: the runtime Class reference of the receiver (used for
    // polymorphic cloning: `Object(this).constructor as Class`). `Object(x)`
    // returns x unchanged for reference types, so this fires for any object class.
    if (expr.property === 'constructor') {
      return { code: `as_v_as_class(as_v_class_of(as_v_obj((void*)(${obj.code}))))`, type: { kind: 'class' } };
    }
    const cinfo = this.symbols.getClass(obj.type.className);
    const f = this.symbols.fieldSlot(obj.type.className, expr.property);
    if (f) {
      if (!this.symbols.isAccessible(f.visibility, f.owner, this.currentClass)) {
        throw new CodegenError(`field '${expr.property}' is not accessible here`);
      }
      return { code: `(${obj.code}->${this.cIdent(f.cName ?? expr.property)})`, type: f.type };
    }
    // getter accessor: obj.prop -> dispatch through the runtime object's vtable
    // (virtual): a base-typed reference (`Texture`) must reach an overriding
    // subclass getter (`ConcreteTexture.get root()`), not the base getter.
    const g = cinfo?.getters.get(expr.property);
    if (g) {
      if (!this.symbols.isAccessible(g.visibility, g.owner, this.currentClass)) {
        throw new CodegenError(`getter '${expr.property}' is not accessible here`);
      }
      return { code: `(${obj.code}->vtable->get_${this.cIdent(expr.property)}(${obj.code}))`, type: g.returnType };
    }
    // A method referenced as a Function value (`this.onDone`, `obj.callback`).
    // Bind the receiver; the thunk dispatches through the runtime object's vtable
    // so overrides resolve on the actual class.
    const m = cinfo?.methods.get(expr.property);
    if (m) {
      if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
        throw new CodegenError(`method '${expr.property}' is not accessible here`);
      }
      return { code: `as_fn_make(${obj.type.className}_${expr.property}__bound, (void*)(${obj.code}), ${this.requiredArity(m.params)})`, type: { kind: 'function' } };
    }
    // Dynamic class (AS3 `dynamic class`): an undeclared member read resolves at
    // runtime through the slot table (falls back to the `_dyn` record).
    if (cinfo?.isDynamic) {
      return { code: `as_dyn_get((void*)(${obj.code}), "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    throw new CodegenError(`undefined field '${expr.property}' on class '${obj.type.className}' (obj=${obj.code}, in ${this.currentClass})`);
  }

  // Built-in XML / XMLList methods (E4X navigation). XML exposes localName()/
  // toString()/length(); XMLList exposes length()/toString(). @attr and .child
  // are handled in emitMember (they are postfix operators, not method calls).
  private emitXmlMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    if (args.length !== 0) throw new CodegenError(`${method}() takes no arguments`);
    switch (method) {
      case 'localName':
        if (obj.type.kind !== 'xml') throw new CodegenError('localName() only on XML');
        return { code: `as_xml_local_name(${obj.code})`, type: { kind: 'string' } };
      case 'toString':
        if (obj.type.kind === 'xml') return { code: `as_xml_to_string(${obj.code})`, type: { kind: 'string' } };
        return { code: `as_xml_list_to_string(${obj.code})`, type: { kind: 'string' } };
      case 'length':
        if (obj.type.kind === 'xmllist') return { code: `(${obj.code}->length)`, type: { kind: 'int' } };
        return { code: '1', type: { kind: 'int' } }; // XML.length() is always 1
      case 'namespace':
        // E4X namespace objects are transparent; return NULL as a placeholder.
        return { code: 'NULL', type: { kind: 'object', className: 'Namespace' } };
      default:
        throw new CodegenError(`unsupported XML/XMLList method '${method}'`);
    }
  }

  // Built-in Vector.<T> methods: push/pop (element type is enforced at compile
  // time via the monomorphized element C type).
  private emitVectorMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    if (obj.type.kind !== 'vector') throw new CodegenError('not a Vector');
    const elem = obj.type.elem;
    const key = this.vectorCName(elem);
    const ec = this.cTypeName(elem);
    const v = obj.code;
    switch (method) {
      case 'push': {
        // AS3 Vector.push is variadic (push(a, b, c, ...)) and returns the new
        // length. Multiple args are sequenced left-to-right via the comma
        // operator; each push returns the running length, so the expression's
        // value is the final length (matching AS3).
        if (args.length === 0) throw new CodegenError('Vector.push expects at least 1 argument');
        const pushes = args.map((a) => `as_vector_${key}_push(${v}, ${this.convert(this.emitExpr(a), elem)})`);
        const code = pushes.length === 1 ? pushes[0] : `(${pushes.join(', ')})`;
        return { code, type: { kind: 'int' } };
      }
      case 'pop':
        return { code: `as_vector_${key}_pop(${v})`, type: elem };
      case 'shift':
        return { code: `as_vector_${key}_shift(${v})`, type: elem };
      case 'unshift': {
        if (args.length === 0) throw new CodegenError('Vector.unshift expects at least 1 argument');
        // AS3 Vector.unshift is variadic; the args keep their left-to-right order
        // at the front, so insert from last to first to preserve it.
        const items = args.map((a) => this.convert(this.emitExpr(a), elem));
        if (items.length === 1) {
          return { code: `as_vector_${key}_unshift(${v}, ${items[0]})`, type: { kind: 'int' } };
        }
        const calls = [...items].reverse().map((it) => `as_vector_${key}_unshift(${v}, ${it})`);
        return { code: `(${calls.join(', ')})`, type: { kind: 'int' } };
      }
      case 'indexOf': {
        if (args.length !== 1) throw new CodegenError('Vector.indexOf expects 1 argument');
        const e = this.convert(this.emitExpr(args[0]), elem);
        return { code: `as_vector_${key}_indexOf(${v}, ${e})`, type: { kind: 'int' } };
      }
      case 'removeAt': {
        if (args.length !== 1) throw new CodegenError('Vector.removeAt expects 1 argument');
        const idx = this.convert(this.emitExpr(args[0]), { kind: 'int' });
        return { code: `as_vector_${key}_removeAt(${v}, ${idx})`, type: elem };
      }
      case 'insertAt': {
        if (args.length !== 2) throw new CodegenError('Vector.insertAt expects 2 arguments');
        const idx = this.convert(this.emitExpr(args[0]), { kind: 'int' });
        const item = this.convert(this.emitExpr(args[1]), elem);
        return { code: `as_vector_${key}_insertAt(${v}, ${idx}, ${item})`, type: { kind: 'void' } };
      }
      case 'join': {
        const sep = args.length >= 1 ? this.emitExpr(args[0]).code : '","';
        return { code: `as_vector_${key}_join(${v}, ${sep})`, type: { kind: 'string' } };
      }
      case 'slice': {
        const from = args.length >= 1 ? this.convert(this.emitExpr(args[0]), { kind: 'int' }) : '0';
        const to = args.length >= 2 ? this.convert(this.emitExpr(args[1]), { kind: 'int' }) : `(${v}->length)`;
        return { code: `as_vector_${key}_slice(${v}, ${from}, ${to})`, type: obj.type };
      }
      case 'concat': {
        // Vector.concat() with no arguments returns a shallow copy (AS3).
        if (args.length === 0) return { code: `as_vector_${key}_slice(${v}, 0, ${v}->length)`, type: obj.type };
        if (args.length !== 1) throw new CodegenError('Vector.concat expects 0 or 1 argument');
        const b = this.emitExpr(args[0]);
        if (b.type.kind !== 'vector') throw new CodegenError('Vector.concat expects a Vector argument');
        return { code: `as_vector_${key}_concat(${v}, ${b.code})`, type: obj.type };
      }
      case 'splice': {
        const start = args.length >= 1 ? this.convert(this.emitExpr(args[0]), { kind: 'int' }) : '0';
        const delCount = args.length >= 2 ? this.convert(this.emitExpr(args[1]), { kind: 'int' }) : '0';
        const rest = args.slice(2);
        let itemsExpr = 'NULL';
        if (rest.length > 0) {
          const items = rest.map((e) => this.convert(this.emitExpr(e), elem));
          itemsExpr = `(${ec}[${rest.length}]){ ${items.join(', ')} }`;
        }
        return { code: `as_vector_${key}_splice(${v}, ${start}, ${delCount}, ${itemsExpr}, ${rest.length})`, type: obj.type };
      }
      case 'forEach': {
        if (args.length !== 1) throw new CodegenError('Vector.forEach expects 1 argument');
        const cb = this.emitExpr(args[0]);
        if (cb.type.kind !== 'function') throw new CodegenError('Vector.forEach expects a Function argument');
        return { code: `as_vector_${key}_forEach(${v}, ${cb.code})`, type: { kind: 'void' } };
      }
      case 'map': {
        if (args.length !== 1) throw new CodegenError('Vector.map expects 1 argument');
        const cb = this.emitExpr(args[0]);
        if (cb.type.kind !== 'function') throw new CodegenError('Vector.map expects a Function argument');
        return { code: `as_vector_${key}_map(${v}, ${cb.code})`, type: obj.type };
      }
      case 'filter': {
        if (args.length !== 1) throw new CodegenError('Vector.filter expects 1 argument');
        const cb = this.emitExpr(args[0]);
        if (cb.type.kind !== 'function') throw new CodegenError('Vector.filter expects a Function argument');
        return { code: `as_vector_${key}_filter(${v}, ${cb.code})`, type: obj.type };
      }
      case 'sort': {
        // AS3 Vector.sort accepts either a comparator Function or sort-option
        // flags (Array.CASEINSENSITIVE == 1, etc.). For flags (or no arg) we
        // fall back to the element's default compare; a comparator is honored.
        const cb = args.length >= 1 ? this.emitExpr(args[0]) : null;
        if (cb && cb.type.kind === 'function') {
          return { code: `as_vector_${key}_sort(${v}, ${cb.code})`, type: obj.type };
        }
        return { code: `as_vector_${key}_sort(${v}, NULL)`, type: obj.type };
      }
      case 'reverse':
        return { code: `as_vector_${key}_reverse(${v})`, type: obj.type };
      default:
        throw new CodegenError(`unsupported Vector method '${method}'`);
    }
  }

  // Built-in Array methods. `a.push/pop/shift/unshift/splice/slice/indexOf/join/concat`.
  private emitArrayMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    const a = obj.code;
    switch (method) {
      case 'push': {
        // AS3 Array.push is variadic: append every argument in order, return the
        // new length.
        if (args.length === 0) return { code: `${a}->length`, type: { kind: 'int' } };
        const vals = args.map((arg) => `as_array_push(${a}, ${this.boxExpr(this.emitExpr(arg))})`);
        return { code: `(${vals.join(', ')})`, type: { kind: 'int' } };
      }
      case 'pop':
        return { code: `as_array_pop(${a})`, type: { kind: 'any' } };
      case 'shift':
        return { code: `as_array_shift(${a})`, type: { kind: 'any' } };
      case 'unshift': {
        // AS3 Array.unshift is variadic: prepend every argument (rightmost first),
        // return the new length.
        if (args.length === 0) return { code: `${a}->length`, type: { kind: 'int' } };
        const vals = args.map((arg) => `as_array_unshift(${a}, ${this.boxExpr(this.emitExpr(arg))})`);
        return { code: `(${vals.reverse().join(', ')})`, type: { kind: 'int' } };
      }
      case 'indexOf': {
        if (args.length !== 1) throw new CodegenError('indexOf expects 1 argument');
        const v = this.boxExpr(this.emitExpr(args[0]));
        return { code: `as_array_indexOf(${a}, ${v})`, type: { kind: 'int' } };
      }
      case 'insertAt': {
        if (args.length !== 2) throw new CodegenError('Array.insertAt expects 2 arguments');
        const idx = this.convert(this.emitExpr(args[0]), { kind: 'int' });
        const v = this.boxExpr(this.emitExpr(args[1]));
        return { code: `as_array_insertAt(${a}, ${idx}, ${v})`, type: { kind: 'void' } };
      }
      case 'removeAt': {
        if (args.length !== 1) throw new CodegenError('Array.removeAt expects 1 argument');
        const idx = this.convert(this.emitExpr(args[0]), { kind: 'int' });
        return { code: `as_array_removeAt(${a}, ${idx})`, type: { kind: 'any' } };
      }
      case 'join': {
        const sep = args.length >= 1 ? this.emitExpr(args[0]).code : '","';
        return { code: `as_array_join(${a}, ${sep})`, type: { kind: 'string' } };
      }
      case 'slice': {
        const from = args.length >= 1 ? this.convert(this.emitExpr(args[0]), { kind: 'int' }) : '0';
        const to = args.length >= 2 ? this.convert(this.emitExpr(args[1]), { kind: 'int' }) : `(${a}->length)`;
        return { code: `as_array_slice(${a}, ${from}, ${to})`, type: { kind: 'array' } };
      }
      case 'concat': {
        // Array.concat() with no arguments returns a shallow copy (AS3).
        if (args.length === 0) return { code: `as_array_slice(${a}, 0, ${a}->length)`, type: { kind: 'array' } };
        if (args.length !== 1) throw new CodegenError('concat expects 1 argument');
        const b = this.emitExpr(args[0]);
        if (b.type.kind === 'array') return { code: `as_array_concat(${a}, ${b.code})`, type: { kind: 'array' } };
        if (b.type.kind === 'any') {
          return { code: `as_array_concat(${a}, (as_array*)as_v_obj_val(${b.code}))`, type: { kind: 'array' } };
        }
        throw new CodegenError('concat expects an Array argument');
      }
      case 'splice': {
        const start = args.length >= 1 ? this.convert(this.emitExpr(args[0]), { kind: 'int' }) : '0';
        const delCount = args.length >= 2 ? this.convert(this.emitExpr(args[1]), { kind: 'int' }) : '0';
        const rest = args.slice(2);
        let itemsExpr = 'NULL';
        if (rest.length > 0) {
          const items = rest.map((e) => this.boxExpr(this.emitExpr(e)));
          itemsExpr = `(as_value[${rest.length}]){ ${items.join(', ')} }`;
        }
        return { code: `as_array_splice(${a}, ${start}, ${delCount}, ${itemsExpr}, ${rest.length})`, type: { kind: 'array' } };
      }
      case 'map': {
        if (args.length !== 1) throw new CodegenError('map expects 1 argument');
        const cb = this.emitExpr(args[0]);
        if (cb.type.kind !== 'function') throw new CodegenError('map expects a Function argument');
        return { code: `as_array_map(${a}, ${cb.code})`, type: { kind: 'array' } };
      }
      case 'filter': {
        if (args.length !== 1) throw new CodegenError('filter expects 1 argument');
        const cb = this.emitExpr(args[0]);
        if (cb.type.kind !== 'function') throw new CodegenError('filter expects a Function argument');
        return { code: `as_array_filter(${a}, ${cb.code})`, type: { kind: 'array' } };
      }
      case 'reverse':
        return { code: `as_array_reverse(${a})`, type: { kind: 'array' } };
      case 'sortOn': {
        if (args.length < 1) throw new CodegenError('sortOn expects a field name');
        const field = this.emitExpr(args[0]);
        const fieldStr = field.type.kind === 'string' ? field.code : this.toStringExpr(field);
        const opts = args.length >= 2 ? this.convert(this.emitExpr(args[1]), { kind: 'int' }) : '0';
        return { code: `as_array_sortOn(${a}, ${fieldStr}, ${opts})`, type: { kind: 'array' } };
      }
      case 'sort': {
        // AS3 sort() default = string sort; a Function arg = custom comparator;
        // any other single numeric arg (Array.NUMERIC == 16) = numeric sort.
        if (args.length === 0) return { code: `as_array_sort_str(${a})`, type: { kind: 'array' } };
        const arg = this.emitExpr(args[0]);
        if (arg.type.kind === 'function') {
          return { code: `as_array_sort_cb(${a}, ${arg.code})`, type: { kind: 'array' } };
        }
        return { code: `as_array_sort_num(${a})`, type: { kind: 'array' } };
      }
      default:
        throw new CodegenError(`undefined Array method '${method}'`);
    }
  }

  // Built-in static String methods: fromCharCode.
  private emitStringStatic(method: string, args: Expr[]): { code: string; type: CType } {
    switch (method) {
      case 'fromCharCode': {
        const codes = args.map((a) => this.convert(this.emitExpr(a), { kind: 'int' }));
        if (codes.length === 0) return { code: '""', type: { kind: 'string' } };
        return { code: `as_str_fromCharCodes(${codes.length}, (int[]){ ${codes.join(', ')} })`, type: { kind: 'string' } };
      }
      default:
        throw new CodegenError(`undefined static String method '${method}'`);
    }
  }

  // Top-level JSON.stringify / JSON.parse. stringify boxes its argument (so
  // records serialize as objects, arrays as arrays via the distinct box tag)
  // and returns a String; parse returns a dynamically-typed `any` holding the
  // reconstructed object/array/primitive.
  private emitJSONMethod(method: string, args: Expr[]): { code: string; type: CType } {
    switch (method) {
      case 'stringify': {
        if (args.length !== 1) throw new CodegenError('JSON.stringify expects exactly 1 argument');
        const v = this.emitExpr(args[0]);
        return { code: `as_json_stringify(${this.boxExpr(v)})`, type: { kind: 'string' } };
      }
      case 'parse': {
        if (args.length !== 1) throw new CodegenError('JSON.parse expects exactly 1 argument');
        const s = this.toStringExpr(this.emitExpr(args[0]));
        return { code: `as_json_parse(${s})`, type: { kind: 'any' } };
      }
      default:
        throw new CodegenError(`undefined static JSON method '${method}'`);
    }
  }

  // Built-in String methods: charAt / charCodeAt / indexOf / lastIndexOf /
  // substring / substr / slice / split / toUpperCase / toLowerCase.
  private emitStringMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    const s = obj.code;
    const argInt = (i: number): string => this.convert(this.emitExpr(args[i]), { kind: 'int' });
    const argStr = (i: number): string => {
      const e = this.emitExpr(args[i]);
      return e.type.kind === 'string' ? e.code : this.toStringExpr(e);
    };
    switch (method) {
      case 'charAt': return { code: `as_str_charAt(${s}, ${argInt(0)})`, type: { kind: 'string' } };
      case 'charCodeAt': return { code: `as_str_charCodeAt(${s}, ${argInt(0)})`, type: { kind: 'int' } };
      // AS3's optional startIndex on both search methods: omitting it must mean
      // the documented default, and a THIRD argument is a mistake the compiler
      // reports rather than drops (AGENTS.md §2.5). The defaults (0 and 0x7FFFFFFF)
      // are what adl uses; see as_str_indexOf_from in the runtime preamble.
      case 'indexOf': {
        if (args.length > 2) throw new CodegenError('String.indexOf expects 1 or 2 arguments');
        const from = args.length >= 2 ? argInt(1) : '0';
        return { code: `as_str_indexOf_from(${s}, ${argStr(0)}, ${from})`, type: { kind: 'int' } };
      }
      case 'lastIndexOf': {
        if (args.length > 2) throw new CodegenError('String.lastIndexOf expects 1 or 2 arguments');
        const from = args.length >= 2 ? argInt(1) : '0x7FFFFFFF';
        return { code: `as_str_lastIndexOf_from(${s}, ${argStr(0)}, ${from})`, type: { kind: 'int' } };
      }
      case 'substring': {
        const from = argInt(0);
        const to = args.length >= 2 ? argInt(1) : `(int)strlen(${s})`;
        return { code: `as_str_substring(${s}, ${from}, ${to})`, type: { kind: 'string' } };
      }
      case 'substr': {
        const from = argInt(0);
        const len = args.length >= 2 ? argInt(1) : `(int)strlen(${s})`;
        return { code: `as_str_substr(${s}, ${from}, ${len})`, type: { kind: 'string' } };
      }
      case 'slice': {
        const from = argInt(0);
        const to = args.length >= 2 ? argInt(1) : `(int)strlen(${s})`;
        return { code: `as_str_slice(${s}, ${from}, ${to})`, type: { kind: 'string' } };
      }
      case 'split': {
        const sep = argStr(0);
        return { code: `as_str_split(${s}, ${sep})`, type: { kind: 'array' } };
      }
      case 'toUpperCase': return { code: `as_str_toUpper(${s})`, type: { kind: 'string' } };
      case 'toLowerCase': return { code: `as_str_toLower(${s})`, type: { kind: 'string' } };
      case 'match': {
        const arg = this.emitExpr(args[0]);
        if (arg.type.kind === 'object' && arg.type.className === 'RegExp') {
          return { code: `as_str_match_regex(${s}, ${arg.code}->compiled, ${arg.code}->global)`, type: { kind: 'array' } };
        }
        // String.match(pattern) also accepts a String, implicitly converted to a
        // RegExp (the string is the raw regex pattern, not a literal substring).
        const pat = arg.type.kind === 'string' ? arg.code : this.toStringExpr(arg);
        return { code: `as_str_match_regex(${s}, as_regex_compile(${pat}, ""), 0)`, type: { kind: 'array' } };
      }
      case 'search': {
        const arg = this.emitExpr(args[0]);
        if (arg.type.kind === 'object' && arg.type.className === 'RegExp') {
          return { code: `as_str_search_regex(${s}, ${arg.code}->compiled)`, type: { kind: 'int' } };
        }
        // String.search(pattern) also accepts a String, implicitly converted to a
        // RegExp (e.g. line.search("//") finds the literal "//" comment marker).
        const pat = arg.type.kind === 'string' ? arg.code : this.toStringExpr(arg);
        return { code: `as_str_search_regex(${s}, as_regex_compile(${pat}, ""))`, type: { kind: 'int' } };
      }
      case 'replace': {
        const arg = this.emitExpr(args[0]);
        if (arg.type.kind === 'object' && arg.type.className === 'RegExp') {
          const repl: { code: string; type: CType } = args.length >= 2 ? this.emitExpr(args[1]) : { code: '""', type: { kind: 'string' } };
          if (repl.type.kind === 'function') {
            return { code: `as_str_replace_regex_fn(${s}, ${arg.code}->compiled, ${repl.code})`, type: { kind: 'string' } };
          }
          const replStr = repl.type.kind === 'string' ? repl.code : this.toStringExpr(repl);
          return { code: `as_str_replace_regex(${s}, ${arg.code}->compiled, ${replStr}, ${arg.code}->global)`, type: { kind: 'string' } };
        }
        return { code: `as_str_replace(${s}, ${argStr(0)}, ${argStr(1)})`, type: { kind: 'string' } };
      }
      case 'concat': {
        // String.concat(...args): concatenate the receiver plus every argument,
        // each auto-stringified via AS3's implicit boxing.
        const parts = [s, ...args.map((a) => this.toStringExpr(this.emitExpr(a)))];
        return { code: `as_str_concat_n(${parts.length}, (const char*[]){ ${parts.join(', ')} })`, type: { kind: 'string' } };
      }
      case 'valueOf': return { code: s, type: { kind: 'string' } };
      case 'toString': return { code: s, type: { kind: 'string' } };
      case 'localeCompare': return { code: `as_str_localeCompare(${s}, ${argStr(0)})`, type: { kind: 'int' } };
      // Locale case folding is simplified to ASCII toUpper/toLower (no locale table).
      case 'toLocaleLowerCase': return { code: `as_str_toLower(${s})`, type: { kind: 'string' } };
      case 'toLocaleUpperCase': return { code: `as_str_toUpper(${s})`, type: { kind: 'string' } };
      case 'startsWith': return { code: `as_str_startsWith(${s}, ${argStr(0)})`, type: { kind: 'bool' } };
      case 'endsWith': return { code: `as_str_endsWith(${s}, ${argStr(0)})`, type: { kind: 'bool' } };
      default:
        throw new CodegenError(`undefined String method '${method}'`);
    }
  }

  // Built-in Number methods: toFixed / toExponential / toPrecision / toString /
  // valueOf. Also serves int/uint (they share the numeric method surface).
  private emitNumberMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    const v = obj.code;
    const argInt = (i: number): string => args.length > i ? this.convert(this.emitExpr(args[i]), { kind: 'int' }) : '0';
    switch (method) {
      case 'toFixed': return { code: `as_num_toFixed(${v}, ${argInt(0)})`, type: { kind: 'string' } };
      case 'toExponential': return { code: `as_num_toExponential(${v}, ${argInt(0)})`, type: { kind: 'string' } };
      case 'toPrecision': {
        // no argument => Number.toString() (shortest round-trip representation).
        if (args.length === 0) return { code: `as_str_from_double(${v})`, type: { kind: 'string' } };
        return { code: `as_num_toPrecision(${v}, ${argInt(0)})`, type: { kind: 'string' } };
      }
      case 'toString': {
        // toString(radix=10): Number uses the shortest round-trip for base 10 and
        // truncates to an integer for other bases; int/uint convert directly.
        if (args.length === 0) {
          if (obj.type.kind === 'int') return { code: `as_str_from_int(${v})`, type: { kind: 'string' } };
          if (obj.type.kind === 'uint') return { code: `as_str_from_uint(${v})`, type: { kind: 'string' } };
          return { code: `as_str_from_double(${v})`, type: { kind: 'string' } };
        }
        const radix = argInt(0);
        if (obj.type.kind === 'int') return { code: `as_int_radix((long long)(${v}), ${radix})`, type: { kind: 'string' } };
        if (obj.type.kind === 'uint') return { code: `as_uint_radix((unsigned long long)(${v}), ${radix})`, type: { kind: 'string' } };
        return { code: `as_int_radix((long long)(${v}), ${radix})`, type: { kind: 'string' } };
      }
      case 'valueOf': return { code: v, type: obj.type };
      default:
        throw new CodegenError(`undefined Number method '${method}'`);
    }
  }

  // Built-in Boolean methods: toString / valueOf.
  private emitBoolMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    switch (method) {
      case 'toString': return { code: `as_str_from_bool(${obj.code})`, type: { kind: 'string' } };
      case 'valueOf': return { code: obj.code, type: { kind: 'bool' } };
      default:
        throw new CodegenError(`undefined Boolean method '${method}'`);
    }
  }

  // A method called on a dynamically-typed (`any`) value (e.g. a nested JSON
  // array's `.join`). Only the array methods the runtime can dispatch are
  // supported here; anything else is a semantic error at compile time.
  private emitAnyMethod(obj: { code: string; type: CType }, method: string, args: Expr[]): { code: string; type: CType } {
    switch (method) {
      case 'join': {
        const sep = args.length > 0 ? this.toStringExpr(this.emitExpr(args[0])) : '","';
        return { code: `as_any_join(${obj.code}, ${sep})`, type: { kind: 'string' } };
      }
      case 'length':
        return { code: `as_any_length(${obj.code})`, type: { kind: 'int' } };
      // Function.apply(thisArg, argsArray): the receiver is the boxed function,
      // the single argument is an Array of arguments (or null).
      case 'apply': {
        if (args.length !== 2) throw new CodegenError('Function.apply expects (thisArg, argsArray)');
        const argsBox = this.boxExpr(this.emitExpr(args[1]));
        return { code: `as_fn_apply_v(${obj.code}, ${argsBox})`, type: { kind: 'any' } };
      }
      // Dynamically-typed method dispatch: obj.method(args...) where the object's
      // static type is `*`. Resolved at runtime through the vtable method tables
      // (or the string-method table when the receiver is a string).
      default: {
        const items = args.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = args.length;
        const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
        return { code: `as_any_call(${obj.code}, "${this.escapeCString(method)}", ${arr}, ${n})`, type: { kind: 'any' } };
      }
    }
  }

  // Math.abs(...) etc. All Math methods return Number (double).
  private emitMathMethod(method: string, args: Expr[]): { code: string; type: CType } {
    const a = args.map((x) => this.toNumberExpr(this.emitExpr(x)));
    switch (method) {
      case 'random': return { code: 'as_math_random()', type: { kind: 'number' } };
      case 'abs': return { code: `fabs(${a[0]})`, type: { kind: 'number' } };
      case 'floor': return { code: `floor(${a[0]})`, type: { kind: 'number' } };
      case 'ceil': return { code: `ceil(${a[0]})`, type: { kind: 'number' } };
      case 'round': return { code: `round(${a[0]})`, type: { kind: 'number' } };
      case 'sqrt': return { code: `sqrt(${a[0]})`, type: { kind: 'number' } };
      case 'pow': return { code: `pow(${a[0]}, ${a[1]})`, type: { kind: 'number' } };
      case 'min': return { code: `fmin(${a[0]}, ${a[1]})`, type: { kind: 'number' } };
      case 'max': return { code: `fmax(${a[0]}, ${a[1]})`, type: { kind: 'number' } };
      // Trigonometric / inverse / exponential / logarithmic. C math.h maps 1:1.
      case 'sin': return { code: `sin(${a[0]})`, type: { kind: 'number' } };
      case 'cos': return { code: `cos(${a[0]})`, type: { kind: 'number' } };
      case 'tan': return { code: `tan(${a[0]})`, type: { kind: 'number' } };
      case 'asin': return { code: `asin(${a[0]})`, type: { kind: 'number' } };
      case 'acos': return { code: `acos(${a[0]})`, type: { kind: 'number' } };
      case 'atan': return { code: `atan(${a[0]})`, type: { kind: 'number' } };
      case 'atan2': return { code: `atan2(${a[0]}, ${a[1]})`, type: { kind: 'number' } };
      case 'exp': return { code: `exp(${a[0]})`, type: { kind: 'number' } };
      case 'log': return { code: `log(${a[0]})`, type: { kind: 'number' } };
      default:
        throw new CodegenError(`unknown Math method '${method}'`);
    }
  }

  // Math.PI / Math.E constants.
  // flash.system.System static read-only memory stats (see System.html). No
  // AVM2 GC heap exists, so these map to the runtime-managed heap + OS RSS.
  private emitSystemConst(name: string): { code: string; type: CType } {
    switch (name) {
      case 'totalMemory': return { code: 'as_system_total_memory()', type: { kind: 'uint' } };
      case 'totalMemoryNumber': return { code: 'as_system_total_memory_number()', type: { kind: 'number' } };
      case 'freeMemory': return { code: 'as_system_free_memory()', type: { kind: 'number' } };
      case 'privateMemory': return { code: 'as_system_private_memory()', type: { kind: 'number' } };
      default:
        throw new CodegenError(`unknown System constant '${name}'`);
    }
  }

  // flash.system.Capabilities static read-only environment info. Capabilities is
  // `final` with no instantiable ClassInfo (same pattern as System): each getter
  // maps to a compile-time constant, a conditional-compile helper, or a fixed
  // desktop-native value. `version` is a fixed AIR-compatible "50,0,0,0" (via
  // as_cap_version); the AS-AOT marker is `manufacturer` = "AS-AOT". os/
  // cpuArchitecture use #ifdef; screenResolution* are
  // 0 in headless builds (no SDL2 window backend) and the real display otherwise.
  private emitCapabilitiesConst(name: string): { code: string; type: CType } {
    switch (name) {
      case 'version': return { code: 'as_cap_version()', type: { kind: 'string' } };
      case 'os': return { code: 'as_cap_os()', type: { kind: 'string' } };
      case 'cpuArchitecture': return { code: 'as_cap_cpu_arch()', type: { kind: 'string' } };
      case 'cpuAddressSize': return { code: '(int)(sizeof(void*) * 8)', type: { kind: 'int' } };
      case 'supports64BitProcesses': return { code: '(sizeof(void*) == 8)', type: { kind: 'bool' } };
      case 'supports32BitProcesses': return { code: '(sizeof(void*) == 4)', type: { kind: 'bool' } };
      case 'playerType': return { code: '"Desktop"', type: { kind: 'string' } };
      case 'manufacturer': return { code: '"AS-AOT"', type: { kind: 'string' } };
      case 'isDebugger': return { code: 'false', type: { kind: 'bool' } };
      case 'touchscreenType': return { code: '"none"', type: { kind: 'string' } };
      case 'language': return { code: 'as_cap_language()', type: { kind: 'string' } };
      case 'screenResolutionX': return { code: 'as_cap_screen_resolution_x()', type: { kind: 'int' } };
      case 'screenResolutionY': return { code: 'as_cap_screen_resolution_y()', type: { kind: 'int' } };
      case 'screenDPI': return { code: 'as_cap_screen_dpi()', type: { kind: 'number' } };
      case 'screenColor': return { code: '"color"', type: { kind: 'string' } };
      case 'pixelAspectRatio': return { code: '1.0', type: { kind: 'number' } };
      case 'hasAudio': return { code: 'true', type: { kind: 'bool' } };
      default:
        throw new CodegenError(`unknown Capabilities constant '${name}'`);
    }
  }

  // flash.filesystem.File static directory shortcuts, resolved at runtime from the
  // process environment. Returns null for a non-directory member so the caller
  // falls through to ordinary static-field resolution.
  private emitFileStaticDir(name: string): { code: string; type: CType } | null {
    switch (name) {
      case 'applicationDirectory': return { code: 'File_new(as_app_dir())', type: { kind: 'object', className: 'File' } };
      case 'applicationStorageDirectory': return { code: 'File_new(as_app_storage_dir())', type: { kind: 'object', className: 'File' } };
      case 'desktopDirectory': return { code: 'File_new(as_desktop_dir())', type: { kind: 'object', className: 'File' } };
      case 'documentsDirectory': return { code: 'File_new(as_documents_dir())', type: { kind: 'object', className: 'File' } };
      case 'userDirectory': return { code: 'File_new(as_user_dir())', type: { kind: 'object', className: 'File' } };
      default: return null;
    }
  }

  private emitMathConst(name: string): { code: string; type: CType } {
    switch (name) {
      case 'PI': return { code: 'M_PI', type: { kind: 'number' } };
      case 'E': return { code: 'M_E', type: { kind: 'number' } };
      // Math constants as high-precision literals (avoids POSIX M_* macro
      // availability differences across platforms/standards).
      case 'LN10': return { code: '2.302585092994046', type: { kind: 'number' } };
      case 'LN2': return { code: '0.6931471805599453', type: { kind: 'number' } };
      case 'LOG10E': return { code: '0.4342944819032518', type: { kind: 'number' } };
      case 'LOG2E': return { code: '1.4426950408889634', type: { kind: 'number' } };
      case 'SQRT1_2': return { code: '0.7071067811865476', type: { kind: 'number' } };
      case 'SQRT2': return { code: '1.4142135623730951', type: { kind: 'number' } };
      default:
        throw new CodegenError(`unknown Math constant '${name}'`);
    }
  }

  // Array sort-option constants (values per the AS3 Array class).
  private emitArrayConst(name: string): { code: string; type: CType } | null {
    switch (name) {
      case 'CASEINSENSITIVE': return { code: '1', type: { kind: 'int' } };
      case 'DESCENDING': return { code: '2', type: { kind: 'int' } };
      case 'UNIQUESORT': return { code: '4', type: { kind: 'int' } };
      case 'RETURNINDEXEDARRAY': return { code: '8', type: { kind: 'int' } };
      case 'NUMERIC': return { code: '16', type: { kind: 'int' } };
      default: return null;
    }
  }

  // Number/int/uint static constants.
  private emitNumConst(cls: string, name: string): { code: string; type: CType } | null {
    switch (cls) {
      case 'Number':
        switch (name) {
          case 'MAX_VALUE': return { code: '1.7976931348623157e308', type: { kind: 'number' } };
          case 'MIN_VALUE': return { code: '5e-324', type: { kind: 'number' } };
          case 'NaN': return { code: 'NAN', type: { kind: 'number' } };
          case 'POSITIVE_INFINITY': return { code: 'INFINITY', type: { kind: 'number' } };
          case 'NEGATIVE_INFINITY': return { code: '(-INFINITY)', type: { kind: 'number' } };
        }
        return null;
      case 'int':
        switch (name) {
          case 'MAX_VALUE': return { code: '2147483647', type: { kind: 'int' } };
          // -2147483648 written as (-2147483647 - 1) to avoid an out-of-range
          // integer-literal warning in C.
          case 'MIN_VALUE': return { code: '(-2147483647 - 1)', type: { kind: 'int' } };
        }
        return null;
      case 'uint':
        switch (name) {
          case 'MAX_VALUE': return { code: '4294967295u', type: { kind: 'uint' } };
          case 'MIN_VALUE': return { code: '0u', type: { kind: 'uint' } };
        }
        return null;
    }
    return null;
  }

  // Global built-in functions: parseInt/parseFloat/isNaN/isFinite and the
  // type conversion functions String/Number/Boolean/int/uint. Returns null when
  // the name is not a builtin (so the caller can fall back to a user function).
  private emitGlobalCall(name: string, args: Expr[]): { code: string; type: CType } | null {
    const e0 = args.length >= 1 ? this.emitExpr(args[0]) : null;
    switch (name) {
      case 'parseInt': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `atoi(${s})`, type: { kind: 'int' } };
      }
      case 'parseFloat': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `atof(${s})`, type: { kind: 'number' } };
      }
      case 'isNaN': return { code: `isnan(${this.toNumberExpr(e0!)})`, type: { kind: 'bool' } };
      case 'isFinite': return { code: `isfinite(${this.toNumberExpr(e0!)})`, type: { kind: 'bool' } };
      // flash.utils.getTimer(): milliseconds since the process started. AIR exposes
      // it as a package-level function; this subset treats it as a global built-in
      // (like parseInt) so frame counters can time themselves without importing it.
      case 'getTimer': return { code: 'as_getTimer()', type: { kind: 'int' } };
      // flash.utils.getQualifiedClassName(value:*): String — AS3 fully-qualified
      // class name ("包::类"). The value is boxed to as_value and dispatched at
      // runtime: primitives map to canonical names, objects/Classes read the
      // vtable `fqn` slot (both carry the class vtable as their first field).
      case 'getQualifiedClassName': {
        return { code: `as_get_qualified_class_name(${this.boxExpr(e0!)})`, type: { kind: 'string' } };
      }
      // flash.utils.getDefinitionByName(name:String): Object — returns a Class
      // reference boxed as an object (tag 4); `... as Class` unboxes it back to
      // as_class* for `new (classRef)()`. Throws ReferenceError when no public
      // definition matches (Starling's SystemUtil catches this to detect AIR).
      case 'getDefinitionByName': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_get_definition_by_name(${s})`, type: { kind: 'any' } };
      }
      // flash.utils.describeType(value:*):XML — build a minimal <type name="fqn"/>
      // DOM tree from a Class reference. Starling's AssetManager reads @name plus
      // constant/variable nodes of type "Class" (empty here: the demo passes File
      // values, never Class). Returns a real XML so @name/.child/.(pred) all work.
      case 'describeType': {
        const arg = this.emitExpr(args[0]);
        const cls = `as_v_as_class(${this.boxExpr(arg)})`;
        return { code: `as_describe_type(${cls})`, type: { kind: 'xml' } };
      }
      // flash.utils.setTimeout(closure, delay, ...): schedule a Function call after
      // 'delay' ms and return a uint timer id (0 when the closure is null). The
      // closure is a boxed function value; unboxed to as_fn for the runtime helper.
      // Trailing boxed args are passed through so callbacks like
      // setTimeout(base.dispatchEvent, 1, new Event(...)) dispatch with that event.
      case 'setTimeout': {
        const fne = this.emitExpr(args[0]);
        const fn = fne.type.kind === 'function' ? fne.code : `((as_fn)as_v_obj_val(${this.boxExpr(fne)}))`;
        const delay = this.toNumberExpr(this.emitExpr(args[1]));
        if (args.length <= 2) {
          return { code: `as_set_timeout(${fn}, ${delay})`, type: { kind: 'uint' } };
        }
        const extras = args.slice(2);
        const items = extras.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = items.length;
        const arr = `(as_value[${n}]){ ${items.join(', ')} }`;
        return { code: `as_set_timeout_args(${fn}, ${delay}, ${n}, ${arr})`, type: { kind: 'uint' } };
      }
      // flash.utils.clearTimeout(id): cancel a scheduled timer (no-op if already
      // fired or unknown).
      case 'clearTimeout': {
        return { code: `as_clear_timeout(${this.emitExpr(args[0]).code})`, type: { kind: 'void' } };
      }
      // tickTimers(): headless test hook — pumps the timer queue once (as_timer_tick).
      // In window builds timers are driven by the frame loop; offscreen examples call
      // this to advance flash.utils.Timer / setTimeout deterministically.
      // tickTimers(): headless test hook - pumps the async IO jobs and the timer
      // queue once. as_async_tick_wait() (rather than the frame boundary's
      // non-blocking as_async_tick) is what keeps the examples deterministic:
      // one call is enough to observe COMPLETE even when the work ran on a
      // worker thread.
      case 'tickTimers': return { code: '(as_async_tick_wait(), as_timer_tick())', type: { kind: 'void' } };
      // tickFrame(): the NON-blocking variant of tickTimers — exactly one frame
      // boundary (as_async_tick + as_timer_tick), with no wait for the workers.
      // Streaming reads (URLStream.bytesAvailable) are only observable across
      // frames while a transfer is still running, which tickTimers' drain-then-wait
      // semantics can never show; this is the headless equivalent of the real
      // frame loop for that case. Callers that need determinism use tickTimers.
      case 'tickFrame': return { code: '(as_async_tick(), as_timer_tick())', type: { kind: 'void' } };
      // tickMovieClips(): headless test hook — advances every playing MovieClip by
      // one frame (as_mc_tick). In window builds clips are driven by the frame loop.
      case 'tickMovieClips': return { code: 'as_mc_tick()', type: { kind: 'void' } };
      // flash.net.navigateToURL(request, window="_blank"): opens the URL in the
      // system's default handler. Nothing is fetched by this process and no event
      // is dispatched; a target with no launcher (WASI) reports AIR's #2032.
      case 'navigateToURL': {
        const req = this.emitExpr(args[0]!);
        const rc = req.type.kind === 'any' ? `(URLRequest*)as_v_obj_val(${req.code})` : `((URLRequest*)(${req.code}))`;
        if (args.length < 2) return { code: `URLRequest__navigate(${rc}, NULL)`, type: { kind: 'void' } };
        const win = this.emitExpr(args[1]!);
        const wc = win.type.kind === 'any' ? `as_v_str_val(${win.code})` : win.code;
        return { code: `URLRequest__navigate(${rc}, ${wc})`, type: { kind: 'void' } };
      }
      // flash.net.sendToURL(request): navigateToURL minus the response, which here
      // is the same call — the response never existed.
      case 'sendToURL': {
        const req = this.emitExpr(args[0]!);
        const rc = req.type.kind === 'any' ? `(URLRequest*)as_v_obj_val(${req.code})` : `((URLRequest*)(${req.code}))`;
        return { code: `URLRequest__sendToURL(${rc})`, type: { kind: 'void' } };
      }
      case 'String': return { code: this.toStringExpr(e0!), type: { kind: 'string' } };
      case 'Number': {
        if (e0!.type.kind === 'string') return { code: `atof(${e0!.code})`, type: { kind: 'number' } };
        if (e0!.type.kind === 'any') return { code: `as_v_to_number(${e0!.code})`, type: { kind: 'number' } };
        return { code: this.toNumberExpr(e0!), type: { kind: 'number' } };
      }
      case 'Boolean': {
        if (e0!.type.kind === 'string') {
          return { code: `(${e0!.code} != NULL && strlen(${e0!.code}) > 0)`, type: { kind: 'bool' } };
        }
        if (e0!.type.kind === 'bool') return { code: e0!.code, type: { kind: 'bool' } };
        if (e0!.type.kind === 'any') return { code: `as_v_truthy(${e0!.code})`, type: { kind: 'bool' } };
        // AS3's rule is "false for null/undefined/0/NaN/empty string, true
        // otherwise" — a *non-null reference* is therefore true, NOT
        // `ToNumber(v) != 0` (which gave false for every object). Verified against
        // AIR: Boolean({}) / Boolean([]) / Boolean(new Sprite()) / Boolean(iface)
        // are all `true` while int(obj) is 0 and Number(obj) is NaN.
        if (e0!.type.kind === 'null') return { code: 'false', type: { kind: 'bool' } };
        if (e0!.type.kind === 'interface') return { code: `(${e0!.code}.obj != NULL)`, type: { kind: 'bool' } };
        if (e0!.type.kind === 'dict' || e0!.type.kind === 'class' || this.isRefType(e0!.type)) {
          return { code: `(${e0!.code} != NULL)`, type: { kind: 'bool' } };
        }
        if (e0!.type.kind === 'number') return { code: `as_num_truthy(${e0!.code})`, type: { kind: 'bool' } };
        return { code: `((${this.toNumberExpr(e0!)}) != 0.0)`, type: { kind: 'bool' } };
      }
      case 'int': {
        if (e0!.type.kind === 'string') return { code: `atoi(${e0!.code})`, type: { kind: 'int' } };
        if (e0!.type.kind === 'any') return { code: `as_v_to_int(${e0!.code})`, type: { kind: 'int' } };
        return { code: `((int)(${this.toNumberExpr(e0!)}))`, type: { kind: 'int' } };
      }
      case 'uint': {
        if (e0!.type.kind === 'string') return { code: `((unsigned int)atoi(${e0!.code}))`, type: { kind: 'uint' } };
        if (e0!.type.kind === 'any') return { code: `as_v_to_uint(${e0!.code})`, type: { kind: 'uint' } };
        return { code: `((unsigned int)(${this.toNumberExpr(e0!)}))`, type: { kind: 'uint' } };
      }
      case 'encodeURI': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_encode(${s}, ";/?:@&=+$,#-_.!~*'()")`, type: { kind: 'string' } };
      }
      case 'decodeURI': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_decode(${s})`, type: { kind: 'string' } };
      }
      case 'encodeURIComponent': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_encode(${s}, "-_.!~*'()")`, type: { kind: 'string' } };
      }
      case 'decodeURIComponent': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_decode(${s})`, type: { kind: 'string' } };
      }
      case 'escape': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_encode(${s}, "@*_+-./")`, type: { kind: 'string' } };
      }
      case 'unescape': {
        const s = e0!.type.kind === 'string' ? e0!.code : this.toStringExpr(e0!);
        return { code: `as_uri_decode(${s})`, type: { kind: 'string' } };
      }
      // Built-in constructor calls without `new`.
      case 'XML': {
        if (e0!.type.kind !== 'string') throw new CodegenError('XML() expects a String argument');
        // one helper argument => the operand is evaluated exactly once
        return { code: `as_xml_parse_str_checked(${e0!.code})`, type: { kind: 'xml' } };
      }
      case 'Array': return this.emitArrayConstructor(args);
      // flash.geom value types constructible without `new` (Point(x, y) etc.).
      case 'Point':
      case 'Rectangle':
      case 'Matrix':
      case 'ColorTransform':
      case 'Transform':
        return this.emitGeomConstructor(name, args);
      case 'Object': {
        if (args.length === 0) return { code: 'as_object_new()', type: { kind: 'record' } };
        // Object(x): AS3 returns x itself ("every value is an object"). Reference
        // types are returned unchanged; primitives are boxed into a dynamic `any`.
        const e = this.emitExpr(args[0]);
        switch (e.type.kind) {
          case 'object':
          case 'interface':
          case 'array':
          case 'vector':
          case 'record':
          case 'function':
          case 'regexp':
          case 'xml':
          case 'xmllist':
            return { code: e.code, type: e.type };
          case 'any':
            return { code: e.code, type: { kind: 'any' } };
          default: // int / uint / number / bool / string / null / void -> box
            return { code: this.boxExpr(e), type: { kind: 'any' } };
        }
      }
      default: return null;
    }
  }

  // no-`new` construction of a flash.geom value type: identical to `new Type(...)`,
  // routing through the symbol table's constructor signature and factory name.
  private emitGeomConstructor(className: string, args: Expr[]): { code: string; type: CType } {
    const cinfo = this.symbols.getClass(className)!;
    const cargs = this.emitArgs(cinfo.constructor.params, args);
    return { code: `${className}_new(${cargs})`, type: { kind: 'object', className } };
  }

  // super.method(...): call the superclass implementation directly, bypassing the
  // vtable (i.e. skipping any override in the current class).
  private emitSuperMethod(expr: Extract<Expr, { kind: 'SuperMethod' }>): { code: string; type: CType } {
    if (!this.currentClass) throw new CodegenError("'super' used outside a class method");
    const info = this.symbols.getClass(this.currentClass)!;
    if (!info.superClass) throw new CodegenError(`class '${this.currentClass}' has no superclass`);
    const superInfo = this.symbols.getClass(info.superClass)!;
    const m = superInfo.methods.get(expr.method);
    if (!m) throw new CodegenError(`undefined method '${expr.method}' on superclass '${info.superClass}'`);
    const args = this.emitArgs(m.params, expr.args);
    const callArgs = args ? ', ' + args : '';
    return {
      code: `${m.owner}_${expr.method}(this${callArgs})`,
      type: m.returnType,
    };
  }

  // `super.property` read: resolve against the superclass's fields/getters (and
  // static fields). Instance fields live at the same offset in the subclass
  // struct (inherited layout), so `super.prop` reads `this->prop`.
  private emitSuperProperty(expr: Extract<Expr, { kind: 'SuperProperty' }>): { code: string; type: CType } {
    if (!this.currentClass) throw new CodegenError("'super' used outside a class method");
    const info = this.symbols.getClass(this.currentClass)!;
    if (!info.superClass) throw new CodegenError(`class '${this.currentClass}' has no superclass`);
    const superInfo = this.symbols.getClass(info.superClass)!;
    const f = this.symbols.fieldSlot(info.superClass, expr.property);
    if (f) return { code: `this->${this.cIdent(f.cName ?? expr.property)}`, type: f.type };
    const g = superInfo.getters.get(expr.property);
    if (g) return { code: `${g.owner}_get_${expr.property}(this)`, type: g.returnType };
    const sf = superInfo.staticFields.get(expr.property);
    if (sf) return { code: this.sfRead(sf.owner, expr.property), type: sf.type };
    // super.method referenced as a Function value (`super.addVertices.apply(...)`),
    // bound to `this` with the superclass implementation. This MUST bypass the
    // vtable: `super.m` denotes the superclass method, so dispatching virtually
    // would re-enter an override of `m` in the current class (infinite recursion
    // for the common `super.m.apply(this, args)` delegation pattern).
    const sm = superInfo.methods.get(expr.property);
    if (sm) return { code: `as_fn_make(${sm.owner}_${expr.property}__superbound, (void*)this, ${this.requiredArity(sm.params)})`, type: { kind: 'function' } };
    throw new CodegenError(`undefined property '${expr.property}' on superclass '${info.superClass}'`);
  }

  // `obj is Type`: runtime subtype check via the vtable `super` chain. For
  // interfaces we use a compile-time check against the static type's implements list.
  // AS3 primitive type names that participate in `is`/`as` runtime checks.
  private isScalarTypeName(name: string): boolean {
    return name === 'int' || name === 'uint' || name === 'Number' || name === 'Boolean' || name === 'String';
  }

  // The Object *root* type (as opposed to a concrete subclass): its slots can
  // hold auto-boxed scalars/arrays/functions, so every `is`/`as` test on it must
  // be a runtime check rather than a static fold.
  private isObjectRoot(t: CType): boolean {
    return t.kind === 'object' && t.className === 'Object';
  }

  private isScalarCType(t: CType): boolean {
    return t.kind === 'int' || t.kind === 'uint' || t.kind === 'number' || t.kind === 'bool' || t.kind === 'string';
  }

  // Compile-time `is` answer for a statically-typed scalar. int/uint are Number
  // subtypes; Number is not int/uint.
  private scalarIsCompatible(actual: CType, target: string): boolean {
    switch (target) {
      case 'int': return actual.kind === 'int';
      case 'uint': return actual.kind === 'uint';
      case 'Number': return actual.kind === 'int' || actual.kind === 'uint' || actual.kind === 'number';
      case 'Boolean': return actual.kind === 'bool';
      case 'String': return actual.kind === 'string';
      default: return false;
    }
  }

  // Runtime `is` expression for a boxed (`any`) value.
  private runtimeScalarIs(v: string, target: string): string {
    switch (target) {
      case 'int': case 'uint': case 'Number': return `as_v_is_number(${v})`;
      case 'Boolean': return `as_v_is_bool(${v})`;
      case 'String': return `as_v_is_string(${v})`;
      default: return 'false';
    }
  }

  private emitIs(expr: Extract<Expr, { kind: 'Is' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.obj);
    // Primitive scalar `is` checks.
    if (this.isScalarTypeName(expr.typeName)) {
      if (this.isScalarCType(o.type)) {
        return { code: this.scalarIsCompatible(o.type, expr.typeName) ? 'true' : 'false', type: { kind: 'bool' } };
      }
      if (o.type.kind === 'any') {
        return { code: this.runtimeScalarIs(o.code, expr.typeName), type: { kind: 'bool' } };
      }
      // An `Object`-typed slot auto-boxes scalars in AS3 ('var d:Object = "x"'),
      // so the check must be a runtime test on the box's vtable identity — the
      // same representation `as` unboxes. Folding to `false` here silently drops
      // a live check: Starling's 'Tween.reset' tests 'transition is String' on its
      // Object-typed parameter, and the folded false made every default
      // ("linear") transition throw at runtime.
      if (this.isObjectRoot(o.type)) {
        const raw = `(void*)(${o.code})`;
        switch (expr.typeName) {
          // int/uint/Number share one boxed representation (documented limitation).
          case 'Number': case 'int': case 'uint': return { code: `as_is_number_obj(${raw})`, type: { kind: 'bool' } };
          case 'String': return { code: `as_is_string_obj(${raw})`, type: { kind: 'bool' } };
          // A boxed Boolean lives in the same as_number wrapper; mirror `as Boolean`.
          case 'Boolean': return { code: `(as_is_bool_obj(${raw}) || (as_is_number_obj(${raw}) && as_number_obj_val(${raw}) != 0.0))`, type: { kind: 'bool' } };
        }
      }
      return { code: 'false', type: { kind: 'bool' } };
    }
    // Object root: every class instance is an Object.
    if (expr.typeName === 'Object') {
      if (o.type.kind === 'object' || o.type.kind === 'interface') return { code: 'true', type: { kind: 'bool' } };
      if (o.type.kind === 'any') return { code: `as_v_is_object(${o.code})`, type: { kind: 'bool' } };
      return { code: 'false', type: { kind: 'bool' } };
    }
    // `x is Function`: Function values carry their own box tag (as_v_fn), distinct
    // from plain objects, so typeof/`is` can tell them apart from objects.
    if (expr.typeName === 'Function') {
      if (o.type.kind === 'function') return { code: 'true', type: { kind: 'bool' } };
      if (o.type.kind === 'any') return { code: `as_v_is_fn(${o.code})`, type: { kind: 'bool' } };
      if (this.isObjectRoot(o.type)) return { code: `as_is_fn_obj((void*)(${o.code}))`, type: { kind: 'bool' } };
      return { code: 'false', type: { kind: 'bool' } };
    }
    // `x is Array`: a boxed array carries its own tag (as_v_arr), distinct from
    // plain objects, so `is` can tell arrays apart from objects at runtime.
    if (expr.typeName === 'Array') {
      if (o.type.kind === 'array') return { code: 'true', type: { kind: 'bool' } };
      if (o.type.kind === 'any') return { code: `as_v_is_array(${o.code})`, type: { kind: 'bool' } };
      return { code: 'false', type: { kind: 'bool' } };
    }
    // `x is Class`: a Class reference is boxed as an object (tag 4) but points to a
    // static as_class entry in the registry, so distinguish it by pointer identity.
    if (expr.typeName === 'Class') {
      if (o.type.kind === 'class') return { code: 'true', type: { kind: 'bool' } };
      if (o.type.kind === 'any') return { code: `as_v_is_class(${o.code})`, type: { kind: 'bool' } };
      if (o.type.kind === 'object') return { code: `as_v_is_class(as_v_obj((void*)(${o.code})))`, type: { kind: 'bool' } };
      return { code: 'false', type: { kind: 'bool' } };
    }
    // `x is XML` / `x is XMLList`: XML is a dedicated boxed C type (not a class).
    // A statically-known xml/xmllist passes; an `any` is checked against the
    // runtime vtable (XML values are tag-4 objects with a distinct vtable).
    if (expr.typeName === 'XML' || expr.typeName === 'XMLList') {
      const rt2 = this.rt(expr.typeName as ASType);
      if (o.type.kind === 'xml' || o.type.kind === 'xmllist') {
        return { code: o.type.kind === rt2.kind ? 'true' : 'false', type: { kind: 'bool' } };
      }
      if (o.type.kind === 'any') {
        const vt = rt2.kind === 'xml' ? 'as_xml_vt' : 'as_xml_list_vt';
        return { code: `as_is(as_v_obj_val(${o.code}), &${vt})`, type: { kind: 'bool' } };
      }
      return { code: 'false', type: { kind: 'bool' } };
    }
    // `x is Vector.<T>`: Vector is a monomorphic value type; the check is true
    // only when the static element type matches (a boxed `any` cannot recover the
    // element type at runtime, so it is always false).
    if (expr.typeName.startsWith('Vector.<')) {
      const rt = this.rt(expr.typeName as ASType);
      if (o.type.kind === 'vector') {
        const ok = o.type.elem.kind === rt.elem.kind
          && (o.type.elem.kind !== 'object' || o.type.elem.className === rt.elem.className);
        return { code: ok ? 'true' : 'false', type: { kind: 'bool' } };
      }
      return { code: 'false', type: { kind: 'bool' } };
    }
    // Resolve the target type name to a CType first, so `x is IAnimatable`
    // matches the interface's FQN key (interfaces are keyed by FQN, not the
    // source-level short name).
    const it = this.rt(expr.typeName as ASType);
    if (it.kind === 'interface') {
      if (o.type.kind === 'object') {
        const cinfo = this.symbols.getClass(o.type.className);
        const impl = cinfo ? cinfo.implements.includes(it.name) : false;
        return { code: impl ? 'true' : 'false', type: { kind: 'bool' } };
      }
      if (o.type.kind === 'interface') {
        return { code: o.type.name === it.name ? 'true' : 'false', type: { kind: 'bool' } };
      }
      return { code: 'false', type: { kind: 'bool' } };
    }
    // Resolve a short class name (e.g. `TweenCore` in package com.greensock.core)
    // to its FQN before the vtable reference and runtime subtype check.
    const rt = this.rt(expr.typeName as ASType);
    const fqn = rt.kind === 'object' ? rt.className : expr.typeName;
    if (!this.symbols.hasClass(fqn)) throw new CodegenError(`unknown type '${expr.typeName}'`);
    if (o.type.kind === 'any') {
      return { code: `as_v_is_inst(${o.code}, &${fqn}_vt)`, type: { kind: 'bool' } };
    }
    if (o.type.kind === 'interface') {
      // An interface reference wraps a concrete object + interface vtable; `is`
      // tests the wrapped object against the target class vtable.
      return { code: `as_is(${o.code}.obj, &${fqn}_vt)`, type: { kind: 'bool' } };
    }
    if (o.type.kind !== 'object' && o.type.kind !== 'null') {
      throw new CodegenError(`'is' on non-object type is not supported`);
    }
    return { code: `as_is(${o.code}, &${fqn}_vt)`, type: { kind: 'bool' } };
  }

  // `obj as Type`: cast to Type if it is one, otherwise null. Interfaces cast
  // to a reference pair (object + interface vtable) or the null reference.
  // AS3 `typeof x`: returns the runtime type as a string. Static types are
  // known at compile time; `any`/`record` dispatch at runtime on the box tag.
  private emitTypeof(expr: Extract<Expr, { kind: 'Typeof' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.operand);
    const lit = (s: string) => ({ code: `"${s}"`, type: { kind: 'string' } as CType });
    switch (o.type.kind) {
      case 'int': case 'uint': case 'number': return lit('number');
      case 'bool': return lit('boolean');
      case 'string': return lit('string');
      // A `function` slot is an as_fn pointer that may legitimately hold NULL, and
      // AIR reports typeof(null) == "object" (typeof inspects the value, not the
      // declared slot type). Folding to "function" unconditionally got
      // `var f:Function = null; typeof f` wrong.
      case 'function': return { code: `(${o.code} == NULL ? "object" : "function")`, type: { kind: 'string' } };
      // Object / interface slots are statically typed but hold values of any
      // dynamic type (autoboxed primitives, Function wrappers, class instances),
      // so typeof must dispatch on the runtime vtable -- folding to "object"
      // here would be wrong for e.g. `var o:Object = someFunction`.
      case 'object': case 'interface':
        return { code: `as_ptr_typeof((void*)${o.code})`, type: { kind: 'string' } };
      case 'array': case 'vector': case 'record': case 'dict':
      case 'regexp': case 'class': case 'xml': case 'xmllist': return lit('object');
      case 'null': return lit('object'); // AS3: typeof null == "object"
      case 'any': return { code: `as_v_typeof(${o.code})`, type: { kind: 'string' } };
      case 'void': return lit('undefined');
      default: throw new CodegenError('typeof: unsupported operand type');
    }
  }

  // AS3 `delete obj[key]`: remove a key from a dynamic object, returning whether
  // it was present. Only dynamic objects (record/Object/any) are deletable.
  private emitDelete(expr: Extract<Expr, { kind: 'Delete' }>): { code: string; type: CType } {
    const t = expr.target;
    if (t.kind !== 'Index' && t.kind !== 'Member') {
      throw new CodegenError('delete only supports obj[key] or obj.key');
    }
    const obj = this.emitExpr(t.kind === 'Index' ? t.object : t.object);
    let objCode: string;
    // Dictionary keys are object references, not strings: `delete dict[key]`.
    if (obj.type.kind === 'dict') {
      const key = this.emitExpr((t as { index: Expr }).index);
      const keyRef = this.boxExpr(key);
      return { code: `as_dict_del(${obj.code}, ${keyRef})`, type: { kind: 'bool' } };
    }
    if (obj.type.kind === 'record') objCode = obj.code;
    else if (obj.type.kind === 'any') objCode = `((as_object*)as_v_obj_val(${obj.code}))`;
    else if (obj.type.kind === 'object' && obj.type.className === 'Object') objCode = `((as_object*)${obj.code})`;
    else throw new CodegenError(`delete on non-dynamic type ${obj.type.kind}`);
    const key = t.kind === 'Index'
      ? this.toStringExpr(this.emitExpr(t.index))
      : `"${this.escapeCString(t.property)}"`;
    return { code: `as_object_del(${objCode}, ${key})`, type: { kind: 'bool' } };
  }

  // AS3 `key in object` membership test: true when the dynamic object has the
  // named key. Operates on a record (as_object*), a dynamic Object field, or an
  // `any` that boxes a record/object.
  private emitIn(expr: Extract<Expr, { kind: 'In' }>): { code: string; type: CType } {
    const obj = this.emitExpr(expr.object);
    const key = this.emitExpr(expr.key);
    // Dictionary membership: key is an object reference, not a string.
    if (obj.type.kind === 'dict') {
      const keyRef = this.boxExpr(key);
      return { code: `as_dict_has(${obj.code}, ${keyRef})`, type: { kind: 'bool' } };
    }
    const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
    if (obj.type.kind === 'record') {
      return { code: `as_object_has(${obj.code}, ${keyStr})`, type: { kind: 'bool' } };
    }
    if (obj.type.kind === 'any') {
      // A boxed value: could be a record or a class instance, so route through the
      // vtable-aware membership check (falls back to record slot lookup).
      return { code: `as_dyn_has(as_v_obj_val(${obj.code}), ${keyStr})`, type: { kind: 'bool' } };
    }
    if (obj.type.kind === 'object') {
      // Class instance: `in` reflects fields/getters/methods (and _dyn slots for
      // dynamic classes), matching AS3 member semantics.
      return { code: `as_dyn_has(${obj.code}, ${keyStr})`, type: { kind: 'bool' } };
    }
    throw new CodegenError(`'in' requires a dynamic Object, found ${obj.type.kind}`);
  }

  private emitAs(expr: Extract<Expr, { kind: 'As' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.obj);
    // Primitive scalar `as` casts.
    if (this.isScalarTypeName(expr.typeName)) {
      const targetType = this.rt(expr.typeName as ASType);
      if (this.scalarIsCompatible(o.type, expr.typeName)) {
        return { code: this.convert(o, targetType), type: targetType };
      }
      if (o.type.kind === 'any') {
        switch (expr.typeName) {
          case 'int': return { code: `as_v_as_int(${o.code})`, type: targetType };
          case 'uint': return { code: `as_v_as_uint(${o.code})`, type: targetType };
          case 'Number': return { code: `as_v_as_number(${o.code})`, type: targetType };
          case 'Boolean': return { code: `as_v_as_bool(${o.code})`, type: targetType };
          case 'String': return { code: `as_v_as_string(${o.code})`, type: targetType };
        }
      }
      // `obj as Number` where obj is an Object-typed reference: if the slot holds
      // a boxed Number (auto-boxed scalar), recover its value; otherwise AS3 yields
      // null (NaN when read as Number).
      if (o.type.kind === 'object' && (o.type as { className: string }).className === 'Object') {
        const raw = `(void*)(${o.code})`;
        switch (expr.typeName) {
          case 'Number': return { code: `(as_is_number_obj(${raw}) ? as_number_obj_val(${raw}) : NAN)`, type: targetType };
          case 'int': return { code: `(as_is_number_obj(${raw}) ? as_to_int32(as_number_obj_val(${raw})) : 0)`, type: targetType };
          case 'uint': return { code: `(as_is_number_obj(${raw}) ? as_to_uint32(as_number_obj_val(${raw})) : 0)`, type: targetType };
          case 'Boolean': return { code: `(as_is_bool_obj(${raw}) ? as_bool_obj_val(${raw}) : (as_is_number_obj(${raw}) && as_number_obj_val(${raw}) != 0.0))`, type: targetType };
          case 'String': return { code: `(as_is_string_obj(${raw}) ? as_string_obj_val(${raw}) : NULL)`, type: targetType };
        }
      }
      return { code: this.defaultInit(targetType), type: targetType };
    }
    // Object root: object/interface/null cast to Object*; scalars -> NULL.
    if (expr.typeName === 'Object') {
      if (o.type.kind === 'object' || o.type.kind === 'interface') {
        return { code: `(void*)(${o.code})`, type: { kind: 'object', className: 'Object' } };
      }
      return { code: 'NULL', type: { kind: 'object', className: 'Object' } };
    }
    // `x as Vector.<T>`: succeeds only when the static type already matches the
    // target element type (Vector is monomorphic; a boxed `any` cannot recover its
    // element type, so it casts to NULL).
    if (expr.typeName.startsWith('Vector.<')) {
      const rt = this.rt(expr.typeName as ASType);
      if (o.type.kind === 'vector') {
        const ok = o.type.elem.kind === rt.elem.kind
          && (o.type.elem.kind !== 'object' || o.type.elem.className === rt.elem.className);
        return ok ? { code: o.code, type: rt } : { code: 'NULL', type: rt };
      }
      // Object-typed slot holding a Vector at runtime (`data as Vector.<Touch>`):
      // the Object* already aliases the Vector, so cast it back.
      if (o.type.kind === 'object') {
        return { code: `((as_vector_${this.vectorCName((rt as { elem: CType }).elem)}*)(${o.code}))`, type: rt };
      }
      return { code: 'NULL', type: rt };
    }
    // `x as Array`: a dynamically-typed array (or already-Array) is unboxed to
    // as_array*; any other value yields NULL.
    if (expr.typeName === 'Array') {
      if (o.type.kind === 'any') return { code: `((as_array*)as_v_obj_val(${o.code}))`, type: { kind: 'array' } };
      if (o.type.kind === 'array') return { code: o.code, type: { kind: 'array' } };
      return { code: 'NULL', type: { kind: 'array' } };
    }
    // `x as Dictionary`: unbox a dynamically-held Dictionary; else NULL.
    if (expr.typeName === 'Dictionary') {
      if (o.type.kind === 'any') return { code: `((as_dict*)as_v_obj_val(${o.code}))`, type: { kind: 'dict' } };
      if (o.type.kind === 'dict') return { code: o.code, type: { kind: 'dict' } };
      return { code: 'NULL', type: { kind: 'dict' } };
    }
    // `x as Class`: unbox a dynamically-held class reference; any other value
    // yields NULL. This enables `new (plugins[p] as Class)()`.
    if (expr.typeName === 'Class') {
      if (o.type.kind === 'any') return { code: `as_v_as_class(${o.code})`, type: { kind: 'class' } };
      if (o.type.kind === 'class') return { code: o.code, type: { kind: 'class' } };
      return { code: 'NULL', type: { kind: 'class' } };
    }
    // `x as Function`: unbox a dynamically-held function value; any other value
    // yields NULL.
    if (expr.typeName === 'Function') {
      if (o.type.kind === 'any') return { code: `as_v_as_fn(${o.code})`, type: { kind: 'function' } };
      if (o.type.kind === 'function') return { code: o.code, type: { kind: 'function' } };
      // Object-typed slot: a Function stored there is a boxed Function wrapper,
      // so the cast recovers the wrapped closure (mirrors `obj as String`).
      if (this.isObjectRoot(o.type)) {
        const raw = `(void*)(${o.code})`;
        return { code: `(as_is_fn_obj(${raw}) ? as_fn_obj_val(${raw}) : NULL)`, type: { kind: 'function' } };
      }
      return { code: 'NULL', type: { kind: 'function' } };
    }
    // `x as XML` / `x as XMLList`: XML is a dedicated boxed C type (not a class),
    // so resolve the dedicated kind. A statically xml/xmllist value passes
    // through; an object/any is cast to the target pointer (AS3 `as` never
    // throws — a non-XML yields null at runtime, approximated here by the cast).
    if (expr.typeName === 'XML' || expr.typeName === 'XMLList') {
      const rt2 = this.rt(expr.typeName as ASType);
      if (o.type.kind === 'xml' || o.type.kind === 'xmllist') return { code: o.code, type: rt2 };
      const c = rt2.kind === 'xml' ? 'as_xml_node*' : 'as_xml_list*';
      // An `any` holding an XML/XMLList box (tag-4 object) unboxes to the node
      // pointer; a statically-scalar value cannot be XML so it yields NULL.
      if (o.type.kind === 'any') return { code: `((${c})as_v_obj_val(${o.code}))`, type: rt2 };
      return { code: `((${c})(${o.code}))`, type: rt2 };
    }
    // Resolve the target type name first (interfaces are keyed by FQN, so the
    // source-level short name must go through rt()/resolveType).
    const it = this.rt(expr.typeName as ASType);
    if (it.kind === 'interface') {
      const iname = it.name;
      if (o.type.kind === 'object') {
        const cinfo = this.symbols.getClass(o.type.className);
        const impl = cinfo ? cinfo.implements.includes(iname) : false;
        if (!impl) return { code: `(${iname}){ NULL, NULL }`, type: { kind: 'interface', name: iname } };
        return { code: `(${iname}){ (void*)(${o.code}), &${o.type.className}_${iname}_vt }`, type: { kind: 'interface', name: iname } };
      }
      if (o.type.kind === 'interface') {
        const code = o.type.name === iname ? o.code : `(${iname}){ NULL, NULL }`;
        return { code, type: { kind: 'interface', name: iname } };
      }
      return { code: `(${iname}){ NULL, NULL }`, type: { kind: 'interface', name: iname } };
    }
    const rt = this.rt(expr.typeName as ASType);
    const fqn = rt.kind === 'object' ? rt.className : expr.typeName;
    if (!this.symbols.hasClass(fqn)) throw new CodegenError(`unknown type '${expr.typeName}'`);
    // `as` never throws in AS3 — a failed cast yields null. A dynamically-typed
    // `any` is instance-checked at runtime; a primitive (string/number/int/uint/
    // bool) can never be a class instance, so the cast is statically null.
    if (o.type.kind === 'any') {
      return { code: `(as_v_is_inst(${o.code}, &${fqn}_vt) ? ((${fqn}*)as_v_obj_val(${o.code})) : NULL)`, type: { kind: 'object', className: fqn } };
    }
    // Interface value cast to a class (`graphicsData as GraphicsSolidFill`): the
    // interface value carries the underlying object pointer in `.obj`, so the
    // runtime check targets that pointer.
    if (o.type.kind === 'interface') {
      const code = `(as_is(${o.code}.obj, &${fqn}_vt) ? ((${fqn}*)(${o.code}.obj)) : NULL)`;
      return { code, type: { kind: 'object', className: fqn } };
    }
    if (o.type.kind !== 'object' && o.type.kind !== 'null') {
      return { code: 'NULL', type: { kind: 'object', className: fqn } };
    }
    const code = `(as_is(${o.code}, &${fqn}_vt) ? ((${fqn}*)(${o.code})) : NULL)`;
    return { code, type: { kind: 'object', className: fqn } };
  }

  // Look up a Class-typed variable/param by name (used by `new assetClass()`,
  // where the identifier is a Class reference rather than a literal class name).
  // Returns its emitted reference, or null if the name is not a Class in scope.
  private lookupClassVar(name: string): { code: string; type: CType } | null {
    if (this.currentClosureCaptures?.has(name)) {
      const t = this.currentClosureCaptures.get(name)!;
      return t.kind === 'class' ? { code: `env->${this.cIdent(name)}`, type: t } : null;
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const lt = this.scopes[i].get(name);
      if (lt !== undefined) return lt.kind === 'class' ? { code: this.cIdent(name), type: lt } : null;
    }
    // A Class-typed instance field (`private var _rootClass:Class`) is `this->_rootClass`.
    if (this.currentClass) {
      const cinfo = this.symbols.getClass(this.currentClass);
      const f = this.symbols.fieldSlot(this.currentClass, name);
      if (f && f.type.kind === 'class') {
        return { code: `this->${this.cIdent(f.cName ?? name)}`, type: f.type };
      }
      const sf = cinfo?.staticFields.get(name);
      if (sf && sf.type.kind === 'class') {
        return { code: this.sfRead(sf.owner, name), type: sf.type };
      }
    }
    if (this.currentClass === null) {
      const mt = this.moduleScope.get(name);
      if (mt !== undefined) return mt.kind === 'class' ? { code: this.moduleCName(name), type: mt } : null;
    }
    return null;
  }

  // Like lookupClassVar, but returns an Object/any-typed variable holding a Class
  // reference at runtime (AS3 `if (asset is Class) asset = new asset()`). Used by
  // `new asset()` where `asset` is statically Object but dynamically a Class.
  private lookupObjectVar(name: string): { code: string; type: CType } | null {
    if (this.currentClosureCaptures?.has(name)) {
      const t = this.currentClosureCaptures.get(name)!;
      return (t.kind === 'object' || t.kind === 'any') ? { code: `env->${this.cIdent(name)}`, type: t } : null;
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const lt = this.scopes[i].get(name);
      if (lt !== undefined) return (lt.kind === 'object' || lt.kind === 'any') ? { code: this.cIdent(name), type: lt } : null;
    }
    return null;
  }

  private emitNew(expr: Extract<Expr, { kind: 'New' }>): { code: string; type: CType } {
    if (expr.className.startsWith('Vector.<')) {
      const vt = this.rt(expr.className);
      if (vt.kind !== 'vector') throw new CodegenError(`invalid Vector type '${expr.className}'`);
      if (expr.args.length === 0) {
        return { code: `as_vector_${this.vectorCName(vt.elem)}_new()`, type: vt };
      }
      // new Vector.<T>(length[, fixed]): sized construction; the `fixed` flag is
      // accepted but not enforced in this subset.
      if (expr.args.length <= 2) {
        const n = this.convert(this.emitExpr(expr.args[0]), { kind: 'int' });
        return { code: `as_vector_${this.vectorCName(vt.elem)}_new_sized(${n})`, type: vt };
      }
      throw new CodegenError('new Vector.<T>() takes at most (length, fixed)');
    }
    // new Array(...): `Array` is not a class in the symbol table; it resolves to
    // an `array` CType, so route to the dynamic-array constructor path.
    if (expr.className === 'Array') {
      return this.emitArrayConstructor(expr.args);
    }
    // new Object(): the root class has no user-declared constructor and no vtable
    // instance body; it maps to a dynamic object (record), like the `{}` literal.
    if (expr.className === 'Object') {
      if (expr.args.length > 0) throw new CodegenError('new Object() takes no arguments');
      return { code: 'as_object_new()', type: { kind: 'record' } };
    }
    // built-in Date constructor overloads (now / epoch ms / string / calendar).
    if (expr.className === 'Date') {
      return this.emitDateConstructor(expr.args);
    }
    // new Dictionary([weakKeys]): an object-reference-keyed associative map. The
    // weakKeys flag is accepted but not modeled (keys are strongly held).
    if (expr.className === 'Dictionary') {
      if (expr.args.length > 1) throw new CodegenError('new Dictionary() takes at most (weakKeys)');
      return { code: 'as_dict_new()', type: { kind: 'dict' } };
    }
    // new XML(source): parse a String or ByteArray into a DOM node. Malformed
    // input throws an Error (as_xml_parse_checked), matching AS3's TypeError.
    if (expr.className === 'XML') {
      if (expr.args.length !== 1) throw new CodegenError('new XML() takes exactly 1 argument');
      const e = this.emitExpr(expr.args[0]);
      let parse: string;
      // the helpers below take the operand once, so `new XML(expr)` evaluates
      // `expr` exactly once even when it is a side-effecting call
      if (e.type.kind === 'string') {
        parse = `as_xml_parse_str_checked(${e.code})`;
      } else if (e.type.kind === 'object' && (e.type as { className: string }).className === 'ByteArray') {
        parse = `as_xml_parse_bytes_checked(${e.code})`;
      } else {
        throw new CodegenError('new XML() expects a String or ByteArray argument');
      }
      return { code: parse, type: { kind: 'xml' } };
    }
    // new String(x) / new Number(x) / new Boolean(x) / new int(x) / new uint(x):
    // AS3 primitive-wrapper constructors, semantically identical to the conversion
    // functions String(x)/Number(x)/... (primitives are modeled directly here, not
    // as boxed wrapper objects). Delegated to emitGlobalCall.
    if (expr.className === 'String' || expr.className === 'Number' || expr.className === 'Boolean' || expr.className === 'int' || expr.className === 'uint') {
      if (expr.args.length !== 1) throw new CodegenError(`new ${expr.className}() takes exactly 1 argument`);
      return this.emitGlobalCall(expr.className, expr.args)!;
    }
    const vt = this.rt(expr.className);
    if (vt.kind !== 'object' || !this.symbols.hasClass(vt.className)) {
      // `new assetClass()`: the identifier names a Class-typed variable, not a
      // literal class name — dynamic class instantiation.
      const ref = this.lookupClassVar(expr.className);
      if (ref) {
        if (expr.args.length > 0) throw new CodegenError('dynamic class instantiation only supports no-arg constructors');
        return { code: `as_dyn_new((as_class*)(void*)(${ref.code}))`, type: { kind: 'any' } };
      }
      // `new asset()` where `asset` is an Object/any-typed variable that holds a
      // Class reference at runtime (AS3 `if (asset is Class) asset = new asset()`).
      const ov = this.lookupObjectVar(expr.className);
      if (ov) {
        if (expr.args.length > 0) throw new CodegenError('dynamic class instantiation only supports no-arg constructors');
        return { code: `as_dyn_new((as_class*)(void*)(${ov.code}))`, type: { kind: 'any' } };
      }
      throw new CodegenError(`unknown class '${expr.className}'`);
    }
    const cname = vt.className;
    const cinfo = this.symbols.getClass(cname);
    if (!cinfo) throw new CodegenError(`unknown class '${cname}'`);
    let args: string;
    try {
      args = this.emitArgs(cinfo.constructor.params, expr.args);
    } catch (e) {
      if (e instanceof CodegenError) throw new CodegenError(`${e.message} (constructor of ${cname}, args=${expr.args.length}, params=[${cinfo.constructor.params.map((p) => `${p.name}${p.defaultValue !== null ? '?' : ''}`).join(', ')}])`);
      throw e;
    }
    return { code: `${cname}_new(${args})`, type: { kind: 'object', className: cname } };
  }

  // `new (classRef)()`: dynamic class instantiation via an `as Class` reference.
  // The factory heap-allocates a fully-constructed instance and returns it as an
  // object pointer, which we box into `any` (the `plugin:*` idiom). Args beyond
  // the no-arg form are not representable in this subset.
  private emitNewDynamic(expr: Extract<Expr, { kind: 'NewDynamic' }>): { code: string; type: CType } {
    if (expr.args.length > 0) throw new CodegenError('dynamic class instantiation only supports no-arg constructors');
    const c = this.emitExpr(expr.classExpr);
    if (c.type.kind !== 'class') throw new CodegenError('dynamic instantiation requires a Class reference');
    return { code: `as_dyn_new((as_class*)(void*)(${c.code}))`, type: { kind: 'any' } };
  }

  // Shared path for `new Array(...)` and the no-`new` call `Array(...)`. AS3's
  // Array constructor: zero args = empty array; a single int/uint arg = a sized
  // array of `undefined` slots; otherwise the args are the initial elements.
  private emitArrayConstructor(args: Expr[]): { code: string; type: CType } {
    if (args.length === 0) return { code: 'as_array_new()', type: { kind: 'array' } };
    if (args.length === 1) {
      const e = this.emitExpr(args[0]);
      if (e.type.kind === 'int' || e.type.kind === 'uint') {
        return { code: `as_array_new_sized((int)(${e.code}))`, type: { kind: 'array' } };
      }
    }
    const n = args.length;
    const items = args.map((a) => this.boxExpr(this.emitExpr(a)));
    return {
      code: `as_array_make(${n}, (as_value[${n}]){ ${items.join(', ')} })`,
      type: { kind: 'array' },
    };
  }

  // Built-in Date constructor overloads: () = now, (number) = epoch ms,
  // (string) = parsed date, (year, month, day, hour, min, sec, ms) = local
  // calendar components (day defaults to 1, trailing time fields to 0).
  private emitDateConstructor(args: Expr[]): { code: string; type: CType } {
    const t = { kind: 'object', className: 'Date' } as CType;
    if (args.length === 0) return { code: 'Date_new()', type: t };
    if (args.length === 1) {
      const e = this.emitExpr(args[0]);
      if (e.type.kind === 'string') {
        return { code: `Date_new_ms(Date_parse_static(${e.code}))`, type: t };
      }
      return { code: `Date_new_ms(${this.convert(e, { kind: 'number' })})`, type: t };
    }
    const defaults = ['0', '0', '1', '0', '0', '0', '0'];
    const vals = args.slice(0, 7).map((a) => this.convert(this.emitExpr(a), { kind: 'int' }));
    const parts = defaults.slice();
    for (let i = 0; i < vals.length; i++) parts[i] = vals[i];
    return { code: `Date_new_ymd(${parts.join(', ')})`, type: t };
  }

  // `[e1, e2, ...]` builds a dynamic array, boxing each element into an as_value.
  private emitArrayLit(expr: Extract<Expr, { kind: 'ArrayLit' }>): { code: string; type: CType } {
    if (expr.elements.length === 0) {
      return { code: 'as_array_new()', type: { kind: 'array' } };
    }
    const n = expr.elements.length;
    const items = expr.elements.map((e) => this.boxExpr(this.emitExpr(e)));
    return {
      code: `as_array_make(${n}, (as_value[${n}]){ ${items.join(', ')} })`,
      type: { kind: 'array' },
    };
  }

  // `new <T>[...]` builds a monomorphized Vector.<T> from an element literal.
  // Elements are converted to the element C type (no boxing — the Vector holds
  // raw typed values), then handed to the per-specialization make helper.
  private emitVectorLit(expr: Extract<Expr, { kind: 'VectorLit' }>): { code: string; type: CType } {
    const vt = this.rt(`Vector.<${expr.elem}>`);
    if (vt.kind !== 'vector') throw new CodegenError('invalid Vector literal element type');
    const key = this.vectorCName(vt.elem);
    const ec = this.cTypeName(vt.elem);
    if (expr.elements.length === 0) {
      return { code: `as_vector_${key}_new()`, type: vt };
    }
    const n = expr.elements.length;
    const items = expr.elements.map((e) => this.convert(this.emitExpr(e), vt.elem));
    return {
      code: `as_vector_${key}_make(${n}, (${ec}[${n}]){ ${items.join(', ')} })`,
      type: vt,
    };
  }

  // `{ x: 1, y: "a" }` builds an associative object (simplified Object literal).
  private emitObjectLit(expr: Extract<Expr, { kind: 'ObjectLit' }>): { code: string; type: CType } {
    if (expr.fields.length === 0) {
      return { code: 'as_object_new()', type: { kind: 'record' } };
    }
    const n = expr.fields.length;
    const keys = expr.fields.map((f) => `"${this.escapeCString(f.name)}"`);
    const vals = expr.fields.map((f) => this.boxExpr(this.emitExpr(f.value)));
    return {
      code: `as_object_make(${n}, (char*[${n}]){ ${keys.join(', ')} }, (as_value[${n}]){ ${vals.join(', ')} })`,
      type: { kind: 'record' },
    };
  }

  // `a[i]` reads a dynamically-typed element. The object may be a statically-
  // known Array, or an `any` (e.g. an array nested inside another array), in
  // which case we unbox it to as_array* at runtime.
  private emitIndex(expr: Extract<Expr, { kind: 'Index' }>): { code: string; type: CType } {
    // `ClassName["staticMember"]` dynamic static access (e.g. Context3D["supportsVideoTexture"]):
    // resolve the string key against the class's static fields/getters.
    if (expr.object.kind === 'Var' && expr.index.kind === 'Str') {
      const cname = this.resolveClassName(expr.object.name);
      if (this.symbols.hasClass(cname)) {
        const cinfo = this.symbols.getClass(cname)!;
        const prop = expr.index.value;
        const sf = cinfo.staticFields.get(prop);
        if (sf) return { code: this.sfRead(sf.owner, prop), type: sf.type };
        const sg = cinfo.staticGetters?.get(prop);
        if (sg) return { code: `${sg.owner}_get_${prop}_static(NULL)`, type: sg.returnType };
      }
    }
    const obj = this.emitExpr(expr.object);
    if (obj.type.kind === 'vector') {
      const idx = this.convert(this.emitExpr(expr.index), { kind: 'int' });
      return { code: `as_vector_${this.vectorCName(obj.type.elem)}_get(${obj.code}, ${idx})`, type: obj.type.elem };
    }
    if (obj.type.kind === 'array') {
      const idx = this.convert(this.emitExpr(expr.index), { kind: 'int' });
      return { code: `as_array_get(${obj.code}, ${idx})`, type: { kind: 'any' } };
    }
    // ByteArray[index] reads a byte at an absolute index (AGALMiniAssembler's
    // `agalcode[index].toString(16)` debug path).
    if (obj.type.kind === 'object' && obj.type.className === 'ByteArray') {
      const idx = this.convert(this.emitExpr(expr.index), { kind: 'int' });
      return { code: `ByteArray_get_index((void*)(${obj.code}), ${idx})`, type: { kind: 'int' } };
    }
    // Dictionary: obj[key] where key is an OBJECT REFERENCE (not a string).
    if (obj.type.kind === 'dict') {
      const key = this.emitExpr(expr.index);
      const keyRef = this.dictKeyRef(key);
      return { code: `as_dict_get(${obj.code}, ${keyRef})`, type: { kind: 'any' } };
    }
    // record (as_object*): obj[key] with a string key, read the slot table.
    if (obj.type.kind === 'record') {
      const key = this.emitExpr(expr.index);
      const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
      return { code: `as_object_get(${obj.code}, ${keyStr})`, type: { kind: 'any' } };
    }
    // Any class instance supports obj[key] dynamic access: route through the
    // runtime reflection helper, which walks the vtable super chain for a field
    // named `key` (and falls back to the record/_dyn slot table for dynamic objects).
    if (obj.type.kind === 'object') {
      const key = this.emitExpr(expr.index);
      const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
      return { code: `as_dyn_get((void*)(${obj.code}), ${keyStr})`, type: { kind: 'any' } };
    }
    // dynamically-typed (`any`) index: dispatch by runtime tag.
    if (obj.type.kind === 'any') {
      const key = this.emitExpr(expr.index);
      const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
      return { code: `as_any_get(${obj.code}, ${keyStr})`, type: { kind: 'any' } };
    }
    throw new CodegenError('index access on non-array type');
  }

  // Dictionary keys are boxed and compared by strict equality (===): string
  // keys by value, object keys by reference. Boxing the key lets as_dict_find
  // use as_v_eq instead of raw pointer identity.
  private dictKeyRef(key: { code: string; type: CType }): string {
    return this.boxExpr(key);
  }

  // Turn an expression that must denote an Array into the `as_array*` C code
  // needed to index or mutate it. Accepts a statically-typed Array or a
  // dynamically-typed (`any`) value that is an array at runtime.
  private arrayTarget(obj: { code: string; type: CType }): string {
    if (obj.type.kind === 'array') return obj.code;
    if (obj.type.kind === 'any') return `((as_array*)as_v_obj_val(${obj.code}))`;
    throw new CodegenError('index access on non-array type');
  }

  // Turn a condition expression into a C boolean test. Dynamically-typed (`any`)
  // values are tested for AS3 truthiness; interface values are `{ obj, vt }` value
  // structs, whose truthiness is the underlying object reference being non-NULL;
  // all other types are already bool/int.
  private condExpr(e: { code: string; type: CType }): string {
    if (e.type.kind === 'any') return `as_v_truthy(${e.code})`;
    if (e.type.kind === 'interface') return `(${e.code}.obj != NULL)`;
    // A statically-number-typed condition must not rely on C's own test: `if (d)`
    // calls NaN true, while AS3 calls it false (`if (0/0)` must not run). The
    // helper also keeps the operand mentioned exactly once.
    if (e.type.kind === 'number') return `as_num_truthy(${e.code})`;
    return e.code;
  }

  // Box a value expression into `as_value` (dynamic type).
  private boxExpr(e: { code: string; type: CType }): string {    switch (e.type.kind) {
      case 'any': return e.code;
      case 'int': return `as_v_num((double)(${e.code}))`;
      case 'uint': return `as_v_num((double)(${e.code}))`;
      case 'number': return `as_v_num(${e.code})`;
      case 'bool': return `as_v_bool(${e.code})`;
      case 'string': return `as_v_str(${e.code})`;
      case 'array': return `as_v_arr((void*)(${e.code}))`;
      case 'vector': return `as_v_obj((void*)(${e.code}))`;
      case 'record': return `as_v_obj((void*)(${e.code}))`;
      case 'object': {
        const cls = (e.type as { className: string }).className;
        // The Object root can hold an auto-boxed scalar (Number/String); when it
        // does, the boxed as_value must carry the primitive tag so '==' and
        // 'is String'/'is Number' work downstream. Concrete subclasses box as the
        // plain object reference.
        return cls === 'Object' ? `as_obj_to_value((void*)(${e.code}))` : `as_v_obj((void*)(${e.code}))`;
      }
      case 'interface': return `as_v_obj(${e.code}.obj)`;
      case 'function': return `as_v_fn((void*)(${e.code}))`;
      case 'class': return `as_v_obj((void*)(${e.code}))`;
      case 'dict': return `as_v_obj((void*)(${e.code}))`;
      case 'xml': return `as_v_obj((void*)(${e.code}))`;
      case 'xmllist': return `as_v_obj((void*)(${e.code}))`;
      case 'null': return 'as_v_null()';
      case 'void': return 'as_v_null()';
      // A RegExp value boxes as a plain object reference (tag 4), like XML/dict.
      case 'regexp': return `as_v_obj((void*)(${e.code}))`;
      default: throw new CodegenError(`boxExpr: unhandled type '${(e.type as CType).kind}'`);
    }
  }

  // Unbox a dynamically-typed (`any`) expression to a concrete target type.
  private unboxAny(e: { code: string; type: CType }, target: CType): string {
    switch (target.kind) {
      case 'int': return `as_v_int_val(${e.code})`;
      case 'uint': return `as_v_uint_val(${e.code})`;
      case 'number': return `as_v_num_val(${e.code})`;
      case 'bool': return `as_v_bool_val(${e.code})`;
      case 'string': return `as_coerce_str(${e.code})`;
      case 'array': return `((as_array*)as_v_obj_val(${e.code}))`;
      case 'vector': {
        const ve = target as { elem: CType };
        return `((as_vector_${this.vectorCName(ve.elem)}*)as_v_obj_val(${e.code}))`;
      }
      case 'record': return `((as_object*)as_v_obj_val(${e.code}))`;
      case 'object': {
        const cls = (target as { className: string }).className;
        // Any->Object unboxing must AUTOBOX primitives: a dynamic member read
        // (properties[property] in Starling's Juggler.tween) hands back an
        // as_value carrying a primitive tag, and reinterpreting that as a
        // pointer yields a dangling Object* (observed as 'rotationX = NaN').
        if (cls === 'Object') return `((Object*)as_value_to_obj(${e.code}))`;
        return `((${cls}*)as_v_obj_val(${e.code}))`;
      }
      case 'interface': {
        const iname = (target as { name: string }).name;
        return `(${iname}){ (void*)as_v_obj_val(${e.code}), (${iname}_vtable*)as_iface_lookup(as_v_obj_val(${e.code}), "${iname}") }`;
      }
      case 'function': return `((as_fn)as_v_obj_val(${e.code}))`;
      case 'class': return `((as_class*)as_v_obj_val(${e.code}))`;
      case 'dict': return `((as_dict*)as_v_obj_val(${e.code}))`;
      case 'xml': return `((as_xml_node*)as_v_obj_val(${e.code}))`;
      case 'xmllist': return `((as_xml_list*)as_v_obj_val(${e.code}))`;
      case 'null': return 'NULL';
      case 'any': return e.code;
      case 'void': return e.code;
    }
  }

  // Coerce a value expression to a double (Number) for arithmetic. `any` values
  // are unboxed at runtime; int/uint are widened; Number is unchanged.
  private toNumberExpr(e: { code: string; type: CType }): string {
    switch (e.type.kind) {
      case 'any': return `as_v_num_val(${e.code})`;
      case 'int':
      case 'uint': return `((double)(${e.code}))`;
      case 'number': return e.code;
      default: return `as_v_num_val(${this.boxExpr(e)})`;
    }
  }

  // Convert a value to a 32-bit signed int for bitwise ops (AS3 ToInt32).
  private toInt32Expr(e: { code: string; type: CType }): string {
    switch (e.type.kind) {
      case 'int': return e.code;
      case 'uint': return `((int)(${e.code}))`;
      case 'any': return `as_v_int_val(${e.code})`;
      case 'bool': return `(${e.code} ? 1 : 0)`;
      default: return `as_to_int32(${e.code})`;
    }
  }

  // Convert a value to a 32-bit unsigned int for the unsigned shift `>>>`.
  private toUint32Expr(e: { code: string; type: CType }): string {
    switch (e.type.kind) {
      case 'uint': return e.code;
      case 'int': return `((unsigned int)(${e.code}))`;
      case 'any': return `as_v_uint_val(${e.code})`;
      default: return `as_to_uint32(${e.code})`;
    }
  }

  // Convert a value expression to the target type where a C cast is required.
  private isRefType(t: CType): boolean {
    return t.kind === 'string' || t.kind === 'object' || t.kind === 'array' || t.kind === 'vector' || t.kind === 'record' || t.kind === 'interface' || t.kind === 'function' || t.kind === 'regexp' || t.kind === 'xml' || t.kind === 'xmllist';
  }

  private describeType(t: CType): string {
    switch (t.kind) {
      case 'object': return t.className;
      case 'interface': return t.name;
      case 'vector': return `Vector.<${this.describeType(t.elem)}>`;
      default: return t.kind;
    }
  }

  private convert(e: { code: string; type: CType }, target: CType): string {
    // dynamic -> concrete: unbox at runtime.
    if (e.type.kind === 'any' && target.kind !== 'any') {
      return this.unboxAny(e, target);
    }
    if (e.type.kind === target.kind) {
      if (target.kind === 'object') {
        // same class already; otherwise pointer cast
        const t = target as { className: string };
        const s = e.type as { className: string };
        return t.className === s.className ? e.code : `((${t.className}*)(${e.code}))`;
      }
      return e.code;
    }
    if (target.kind === 'any') return this.boxExpr(e);
    // Passing/assigning a null literal to a String-typed slot yields a null
    // string (NULL), not the literal "null" (that is the String(null)
    // conversion-function result, emitted only by toStringExpr in trace/concat).
    if (target.kind === 'string' && e.type.kind === 'null') return 'NULL';
    if (target.kind === 'string') return this.toStringExpr(e);
    // Reference types cannot implicitly convert to numeric/bool scalars in AS3.
    // This guards `var x; x = "hello";` (x inferred as int) from silently
    // truncating a char*/pointer to an int — a semantic error, not a valid cast.
    if (this.isRefType(e.type) && (target.kind === 'int' || target.kind === 'uint' || target.kind === 'number' || target.kind === 'bool')) {
      throw new CodegenError(`cannot convert ${this.describeType(e.type)} to ${target.kind}`);
    }
    if (target.kind === 'int') return e.type.kind === 'number' ? `as_to_int32(${e.code})` : `((int)(${e.code}))`;
    if (target.kind === 'uint') return e.type.kind === 'number' ? `as_to_uint32(${e.code})` : `((unsigned int)(${e.code}))`;
    if (target.kind === 'number') return `((double)(${e.code}))`;
    if (target.kind === 'bool') return `((bool)(${e.code}))`;
    if (target.kind === 'object') {
      if (e.type.kind === 'null') return 'NULL';
      const cls = (target as { className: string }).className;
      // AS3 auto-boxes a scalar stored into an Object-typed slot (`var data:Object
      // = 3.14`) into a boxed Number, recovered later by `data as Number`. Only the
      // Object root can hold a boxed scalar — a concrete class target would be a
      // type error, so those keep the raw pointer cast.
      if (cls === 'Object' && (e.type.kind === 'number' || e.type.kind === 'int' || e.type.kind === 'uint')) {
        const d = e.type.kind === 'number' ? e.code : `((double)(${e.code}))`;
        return `((Object*)as_number_new(${d}))`;
      }
      // AS3's String is an Object subclass: 'var data:Object = "hi"' must store a
      // boxed String (round-tripped by as_obj_to_value / 'data as String'), not a
      // raw char* reinterpret-cast into an Object* (which would be a dangling
      // pointer with no vtable).
      if (cls === 'Object' && e.type.kind === 'bool') {
        return `((Object*)as_boolean_new(${e.code}))`;
      }
      if (cls === 'Object' && e.type.kind === 'string') {
        return `((Object*)as_string_new(${e.code}))`;
      }
      // AS3's Function is an Object subclass too: 'var data:Object = myFunc' must
      // store a boxed Function (round-tripped by as_obj_to_value / 'data as
      // Function'), not a raw closure pointer that has no vtable header.
      if (cls === 'Object' && e.type.kind === 'function') {
        return `((Object*)as_function_new(${e.code}))`;
      }
      return `((${cls}*)(${e.code}))`;
    }
    if (target.kind === 'interface') {
      if (e.type.kind === 'null') return `(${(target as { name: string }).name}){ NULL, NULL }`;
      if (e.type.kind === 'object') {
        const cls = (e.type as { className: string }).className;
        const iname = (target as { name: string }).name;
        return `(${iname}){ (void*)(${e.code}), &${cls}_${iname}_vt }`;
      }
      return e.code;
    }
    return e.code;
  }
}
