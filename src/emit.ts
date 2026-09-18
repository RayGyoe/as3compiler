// C emitter: pass 2 of the generator. Walks the AST and emits readable C for
// declarations, statements, and expressions using the symbols gathered in pass 1.

import type { Program, Stmt, Expr, ASType, Param, ClassMember, Block } from './ast.ts';
import { RUNTIME_PREAMBLE } from './runtime.ts';
import { resolveType, CodegenError, qualifiedName } from './symbols.ts';
import type { CType, MethodInfo, SymbolTable } from './symbols.ts';

// Compound assignment operator -> underlying binary operator.
const COMPOUND_BASE: Record<string, string> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/',
  '<<=': '<<', '>>=': '>>', '>>>=': '>>>', '&=': '&', '|=': '|', '^=': '^',
};

// C reserved keywords. AS3 method/field names that collide with one (e.g.
// Rectangle.union) must be mangled to a valid C identifier; appending '_' keeps
// the name recognizable and guarantees no clash with the AS3 surface.
const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Bool', '_Complex', '_Imaginary',
]);

function cIdent(name: string): string {
  return C_KEYWORDS.has(name) ? name + '_' : name;
}

export class Emitter {
  private out: string[] = [];
  private indent = 0;
  private scopes: Map<string, CType>[] = [];
  private currentClass: string | null = null;
  private suppressBreak = 0;
  private labels: { asName: string; cName: string }[] = [];
  private tmpCounter = 0;
  private currentReturnType: CType | null = null;
  // module-level (file-scope) variables: AS3 top-level `var`/`const` are hoisted
  // to C file-scope globals so free functions and main() both see them.
  private moduleScope = new Map<string, CType>();
  private moduleConsts = new Set<string>();

  private program: Program;
  private symbols: SymbolTable;
  // Compile-time injected AS-AOT version (Capabilities.version). Empty when the
  // CLI does not supply one (e.g. library tests that call generateC directly).
  private asAotVersion: string;
  private anonFuncs: { name: string; params: Param[]; returnType: ASType; body: Block; captures: { name: string; type: CType }[] }[] = [];
  private anonIndex = new Map<object, string>();
  private vectorSpecs = new Map<string, CType>();
  // closure analysis state (pass 1 pre-scan)
  private funcVars: Map<string, CType>[] = [];
  private anonCaptures = new Map<object, { name: string; type: CType }[]>();
  private currentAnonLocal: Map<string, CType> | null = null;
  private currentAnonRefs: { name: string; type: CType }[] | null = null;
  // closure emit state (pass 2): non-null while emitting a capturing anon body
  private currentClosureCaptures: Map<string, CType> | null = null;
  // bound-method state: an unqualified identifier inside an instance method that
  // names one of the class's methods is `this.method` used as a value (e.g. passed
  // to addEventListener). Each such reference needs a thunk that captures `this`
  // and dispatches through the vtable.
  private boundMethods = new Map<string, { cname: string; mname: string; m: MethodInfo }>();
  // static-method-as-value state: `ClassName.method` referenced as a Function value
  // (e.g. `var f:Function = TweenLite.killTweensOf`) needs a non-capturing thunk.
  private staticMethodRefs = new Map<string, { cname: string; mname: string; m: MethodInfo }>();
  private currentWalkClass: string | null = null;
  private currentWalkIsStatic = false;
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

  constructor(program: Program, symbols: SymbolTable, asAotVersion = '') {
    this.program = program;
    this.symbols = symbols;
    this.asAotVersion = asAotVersion;
  }

  // ---------- top level ----------

  run(): string {
    this.line(RUNTIME_PREAMBLE.trimEnd());
    this.line('');
    this.collectFunctionValues(); // also gathers Vector.<T> specializations
    this.emitTypedefs();
    this.emitStructs();
    this.emitPrototypes();
    this.emitModuleVars();
    this.emitFunctionValues();
    this.emitPropTables();
    this.emitMethodThunks();
    this.emitMethodTables();
    this.emitInterfaceVtables();
    this.emitVtables();
    this.emitStaticFields();
    this.emitDefinitions();
    this.emitExportWrappers();
    this.emitGCRoots();
    this.emitMain();
    return this.out.join('\n') + '\n';
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
      case 'void': return 'void';
    }
  }

  // const-declared type. AS3's `const String` means the *reference* is immutable,
  // not the character buffer (strings are stored as writable `char*` buffers).
  // C's `const char*` (pointee-qualified) would force a discarded-qualifier
  // warning when passed to `char*` params (e.g. Event_ENTER_FRAME ->
  // addEventListener(char* type)); `char* const` (pointer-qualified) preserves
  // the AS3 semantics and drops cleanly at call sites.
  private constTypeName(t: CType): string {
    if (t.kind === 'string') return 'char* const';
    return `const ${this.cTypeName(t)}`;
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
      case 'void': return '';
    }
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
      default: throw new CodegenError('unsupported Vector element type');
    }
  }

  // Whether a Vector element type is a GC-managed reference (string/object/interface)
  // vs. a scalar value (int/uint/number/bool). Reference elements need their data
  // array GC-traced; scalar elements' data is a plain (non-GC) value buffer.
  private vectorElemIsPtr(elem: CType): boolean {
    return elem.kind === 'string' || elem.kind === 'object' || elem.kind === 'interface';
  }

  // How a captured CType must be traced from a closure environment: 'ptr' for a
  // raw object/string/function pointer (gc_mark_ptr), 'value' for a boxed
  // as_value (gc_mark_value), or null for a scalar needing no tracing.
  private captureMarkKind(t: CType): 'ptr' | 'value' | null {
    switch (t.kind) {
      case 'string': case 'object': case 'interface': case 'array':
      case 'vector': case 'record': case 'dict': case 'function':
      case 'regexp': case 'class': return 'ptr';
      case 'any': return 'value';
      default: return null;
    }
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
      default: throw new CodegenError('unsupported Vector element type for join');
    }
  }

  // C expression testing whether two Vector element values are equal (for indexOf).
  private vectorElemEq(elem: CType, a: string, b: string): string {
    if (elem.kind === 'string') return `strcmp(${a}, ${b}) == 0`;
    return `${a} == ${b}`;
  }

  // Record a Vector.<T> specialization so its struct and helpers can be emitted
  // once, monomorphized to the element type.
  private noteType(t: ASType | null): void {
    if (t && t.startsWith('Vector.<')) {
      const ct = resolveType(t);
      if (ct.kind === 'vector') this.vectorSpecs.set(t, ct.elem);
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

  private tmpName(prefix: string): string {
    return `_${prefix}${this.tmpCounter++}`;
  }

  // Resolve a short class name written in source (e.g. `Log` in package `demo`)
  // to its fully-qualified C identifier (`demo.Log`) via the same alias table
  // resolveType uses. Built-ins and package-less classes map to themselves.
  private resolveClassName(name: string): string {
    const t = resolveType(name);
    if (t.kind === 'object') return t.className;
    if (t.kind === 'interface') return t.name;
    return name;
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
      // Byte offset of the `_dyn` slot table (dynamic classes only), -1 otherwise.
      // Mirrors as_vtable_header.dyn_offset so a class vtable can be cast to it.
      this.line('int dyn_offset;');
      for (const [mname, m] of info.methods) {
        this.line(`${this.methodPtrField(m, mname)};`);
      }
      this.indent--;
      this.line('};');
      // object struct: vtable pointer first (so a subclass pointer is layout-
      // compatible with its superclass pointer), then fields.
      this.line(`struct ${name} {`);
      this.indent++;
      this.line(`${name}_vtable* vtable;`);
      for (const [fname, f] of info.fields) {
        this.line(`${this.cTypeName(f.type)} ${fname};`);
      }
      // Dynamic classes (AS3 `dynamic class`) carry a runtime slot table for
      // arbitrary undeclared string-keyed properties. Its byte offset is emitted
      // into the vtable so as_dyn_get/set can reach it.
      if (info.isDynamic) this.line('as_object* _dyn;');
      this.indent--;
      this.line('};');
      this.line('');
    }
    // interface vtables (method function pointers only) and reference structs
    // (a pair of object pointer + interface vtable).
    for (const [name, info] of this.symbols.interfaces) {
      this.line(`struct ${name}_vtable {`);
      this.indent++;
      this.line('const char* name;');
      this.line('void* super;');
      this.line('void** ifaces;');
      this.line('void* props;');
      this.line('void* methods;');
      for (const [mname, m] of info.methods) {
        this.line(`${this.methodPtrField(m, mname)};`);
      }
      this.indent--;
      this.line('};');
      this.line(`struct ${name} {`);
      this.indent++;
      this.line('void* obj;');
      this.line(`${name}_vtable* vt;`);
      this.indent--;
      this.line('};');
      this.line('');
    }
    // Vector.<T> monomorphized structs: a GCT_CUSTOM mark callback (so the GC
    // can trace element pointers for reference element types), then the
    // contiguous element array + length/capacity.
    for (const [, elem] of this.vectorSpecs) {
      const key = this.vectorCName(elem);
      this.line(`typedef struct { void (*mark)(void*); ${this.cTypeName(elem)}* data; int length; int capacity; } as_vector_${key};`);
    }
    if (this.vectorSpecs.size > 0) this.line('');
  }

  private emitPrototypes(): void {
    // constructors (init + new)
    for (const [name, info] of this.symbols.classes) {
      const params = this.paramDecls(info.constructor.params);
      this.line(`void ${name}_ctor(${name}* o${params ? ', ' + params : ''});`);
      this.line(`${name}* ${name}_new(${params || 'void'});`);
    }
    // methods
    for (const [cname, info] of this.symbols.classes) {
      for (const [mname, m] of info.methods) {
        if (m.owner !== cname) continue; // inherited methods are declared under their owner
        const p = this.paramDecls(m.params);
        this.line(`${this.cTypeName(m.returnType)} ${cname}_${mname}(void* _this${p ? ', ' + p : ''});`);
      }
      // static methods (no receiver)
      for (const [mname, m] of info.staticMethods) {
        if (m.owner !== cname) continue;
        this.line(`${this.cTypeName(m.returnType)} ${cname}_${mname}(${this.paramDecls(m.params)});`);
      }
      // getters / setters
      for (const [mname, m] of info.getters) {
        if (m.owner !== cname) continue;
        this.line(`${this.cTypeName(m.returnType)} ${cname}_get_${mname}(void* _this);`);
      }
      for (const [mname, m] of info.setters) {
        if (m.owner !== cname) continue;
        const p = this.paramDecls(m.params);
        this.line(`void ${cname}_set_${mname}(void* _this${p ? ', ' + p : ''});`);
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
      this.line(`void as_vector_${key}_push(as_vector_${key}* v, ${ec} e);`);
      this.line(`${ec} as_vector_${key}_pop(as_vector_${key}* v);`);
      this.line(`${ec} as_vector_${key}_get(as_vector_${key}* v, int i);`);
      this.line(`void as_vector_${key}_set(as_vector_${key}* v, int i, ${ec} e);`);
      this.line(`int as_vector_${key}_indexOf(as_vector_${key}* v, ${ec} e);`);
      this.line(`char* as_vector_${key}_join(as_vector_${key}* v, const char* sep);`);
      this.line(`void as_vector_${key}_setLength(as_vector_${key}* v, int n);`);
      this.line(`as_vector_${key}* as_vector_${key}_slice(as_vector_${key}* v, int from, int to);`);
      this.line(`as_vector_${key}* as_vector_${key}_concat(as_vector_${key}* a, as_vector_${key}* b);`);
      this.line(`as_vector_${key}* as_vector_${key}_splice(as_vector_${key}* v, int start, int deleteCount, ${ec}* items, int itemCount);`);
      this.line(`void as_vector_${key}_forEach(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_map(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_filter(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_sort(as_vector_${key}* v, as_fn cb);`);
      this.line(`as_vector_${key}* as_vector_${key}_reverse(as_vector_${key}* v);`);
    }
    if (this.symbols.classes.size > 0 || this.symbols.funcs.size > 0 || this.vectorSpecs.size > 0) this.line('');
  }

  private paramDecls(params: Param[]): string {
    return params.map((p) => `${this.cTypeName(resolveType(p.type))} ${p.name}`).join(', ');
  }

  // Function-pointer field declaration for a vtable slot. The receiver is a
  // `void*` so an overriding method keeps the same signature as the overridden one.
  private methodPtrField(m: MethodInfo, name: string): string {
    const params = m.params.map((p) => this.cTypeName(resolveType(p.type))).join(', ');
    const args = params ? `void*, ${params}` : 'void*';
    return `${this.cTypeName(m.returnType)} (*${cIdent(name)})(${args})`;
  }

  // Static vtable instance per class, filled with the implementing function for
  // each method slot (inherited methods point at their owner's implementation).
  private emitVtables(): void {
    // Forward-declare every class vtable so subclass initializers can reference
    // their superclass vtable regardless of declaration order.
    for (const [name] of this.symbols.classes) {
      this.line(`static ${name}_vtable ${name}_vt;`);
    }
    if (this.symbols.classes.size > 0) this.line('');
    for (const [name, info] of this.symbols.classes) {
      const superVt = info.superClass ? `&${info.superClass}_vt` : 'NULL';
      const ifaceArr = info.implements.length > 0 ? `${name}_ifaces` : 'NULL';
      const props = this.hasOwnProps(name) ? `${name}_props` : 'NULL';
      const methods = this.hasOwnMethods(name) ? `${name}_methods` : 'NULL';
      // Dynamic classes record the byte offset of their `_dyn` slot table here
      // (struct has the field only when isDynamic); non-dynamic classes use -1.
      const dynOffset = info.isDynamic ? `(int)offsetof(${name}, _dyn)` : '-1';
      const entries: string[] = [`"${name}"`, superVt, ifaceArr, props, methods, dynOffset];
      for (const [mname, m] of info.methods) {
        entries.push(`${m.owner}_${mname}`);
      }
      this.line(`static ${name}_vtable ${name}_vt = { ${entries.join(', ')} };`);
    }
    if (this.symbols.classes.size > 0) this.line('');
  }

  // Whether a class declares any of its own (non-inherited) instance fields that
  // are reflectable via dynamic obj[key] access.
  private hasOwnProps(name: string): boolean {
    const info = this.symbols.classes.get(name);
    if (!info) return false;
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
        this.line(`{ "${this.escapeCString(fname)}", ${this.propTypeTag(f.type)}, offsetof(${name}, ${fname}) },`);
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
          this.unboxAny({ code: `args[${i}]`, type: { kind: 'any' } as CType }, resolveType(p.type)),
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
          const m = cinfo.methods.get(mname)!;
          entries.push(`${m.owner}_${mname}`);
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
        if (f.isConst) {
          this.currentClass = cname;
          const init = f.init ? this.convert(this.emitExpr(f.init), f.type) : this.defaultInit(f.type);
          this.line(`static ${this.constTypeName(f.type)} ${cname}_${fname} = ${init};`);
          this.currentClass = null;
        } else {
          this.line(`static ${this.cTypeName(f.type)} ${cname}_${fname} = ${this.defaultInit(f.type)};`);
          if (f.init) this.staticFieldInits.push({ cname, fname, f });
        }
      }
    }
    if (this.symbols.classes.size > 0) this.line('');
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
    this.line('for (int i = 0; i < as_ef_count; i++) gc_mark_ptr(as_ef_objs[i]);');
    for (const [cname, info] of this.symbols.classes) {
      for (const [fname, f] of info.staticFields) {
        if (f.owner !== cname) continue;
        if (f.isConst) continue; // const = compile-time literal, never a GC object
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
    this.anonCaptures.clear();
    this.funcVars = [new Map()];
    this.currentAnonLocal = null;
    this.currentAnonRefs = null;
    this.walkStmts(this.program.body);
    this.funcVars = [];
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

  private walkStmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': {
        const vt = resolveType(s.type);
        this.funcVars[this.funcVars.length - 1].set(s.name, vt);
        if (this.currentAnonLocal) this.currentAnonLocal.set(s.name, vt);
        this.noteType(s.type);
        if (s.init) this.walkExpr(s.init);
        break;
      }
      case 'VarDecls': {
        for (const d of s.decls) {
          const vt = resolveType(d.type);
          this.funcVars[this.funcVars.length - 1].set(d.name, vt);
          if (this.currentAnonLocal) this.currentAnonLocal.set(d.name, vt);
          this.noteType(d.type);
          if (d.init) this.walkExpr(d.init);
        }
        break;
      }
      case 'ConstDecl': {
        const vt = resolveType(s.type);
        this.funcVars[this.funcVars.length - 1].set(s.name, vt);
        if (this.currentAnonLocal) this.currentAnonLocal.set(s.name, vt);
        this.noteType(s.type);
        this.walkExpr(s.init!);
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
        this.funcVars.push(new Map(s.params.map((p) => [p.name, resolveType(p.type)])));
        this.walkParams(s.params);
        this.walkStmts(s.body.body);
        this.funcVars.pop();
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
            this.currentWalkClass = cname;
            this.currentWalkIsStatic = isStatic;
            this.funcVars.push(new Map(m.params.map((p) => [p.name, resolveType(p.type)])));
            this.walkParams(m.params);
            this.walkStmts(m.body.body);
            this.funcVars.pop();
            this.currentWalkClass = saved;
            this.currentWalkIsStatic = savedStatic;
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
        if (this.currentAnonRefs) {
          const t = this.lookupFuncVar(e.name);
          if (t) this.currentAnonRefs.push({ name: e.name, type: t });
        }
        // Bound-method / static-method reference: an unqualified identifier inside
        // a method that names one of the class's methods (and is not shadowed by a
        // local) denotes `this.method` or `Class.method` used as a value. Record it
        // so the thunk is emitted in emitFunctionValues before any body uses it.
        if (this.currentWalkClass && !this.lookupFuncVar(e.name)) {
          const cinfo = this.symbols.getClass(this.currentWalkClass);
          if (this.currentWalkIsStatic) {
            const sm = cinfo?.staticMethods.get(e.name);
            if (sm) {
              const key = `${this.currentWalkClass}:${e.name}`;
              if (!this.staticMethodRefs.has(key)) {
                this.staticMethodRefs.set(key, { cname: this.currentWalkClass, mname: e.name, m: sm });
              }
            }
          } else {
            const m = cinfo?.methods.get(e.name);
            if (m) {
              const key = `${this.currentWalkClass}:${e.name}`;
              if (!this.boundMethods.has(key)) {
                this.boundMethods.set(key, { cname: this.currentWalkClass, mname: e.name, m });
              }
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
              const key = `${cname}:${e.property}`;
              if (!this.staticMethodRefs.has(key)) {
                this.staticMethodRefs.set(key, { cname, mname: e.property, m: sm });
              }
            }
          } else if (e.object.name === 'this' && this.currentWalkClass && !this.currentWalkIsStatic) {
            // `this.method` referenced as a Function value (e.g. a callback passed
            // to setTimeout / TweenLite.onComplete). Record it so the bound-method
            // thunk is emitted before any body uses it.
            const cinfo = this.symbols.getClass(this.currentWalkClass);
            const m = cinfo?.methods.get(e.property);
            if (m) {
              const key = `${this.currentWalkClass}:${e.property}`;
              if (!this.boundMethods.has(key)) {
                this.boundMethods.set(key, { cname: this.currentWalkClass, mname: e.property, m });
              }
            }
          }
        }
        this.walkExpr(e.object);
        break;
      }
      case 'SuperMethod': for (const a of e.args) this.walkExpr(a); break;
      case 'Is': this.walkExpr(e.obj); break;
      case 'As': this.walkExpr(e.obj); break;
      case 'In': this.walkExpr(e.key); this.walkExpr(e.object); break;
      case 'New': this.noteType(e.className); for (const a of e.args) this.walkExpr(a); break;
      case 'NewDynamic': this.walkExpr(e.classExpr); for (const a of e.args) this.walkExpr(a); break;
      case 'ArrayLit': for (const el of e.elements) this.walkExpr(el); break;
      case 'VectorLit': this.noteType(`Vector.<${e.elem}>`); for (const el of e.elements) this.walkExpr(el); break;
      case 'Index': this.walkExpr(e.object); this.walkExpr(e.index); break;
      case 'ObjectLit': for (const f of e.fields) this.walkExpr(f.value); break;
      case 'FunctionExpr': {
        const name = `_fn${this.anonFuncs.length}`;
        this.anonIndex.set(e, name);
        // Free-variable analysis: push this anonymous function's own scope, walk
        // its body collecting Var references, then keep those that resolve to the
        // enclosing function scope (captured variables).
        this.funcVars.push(new Map(e.params.map((p) => [p.name, resolveType(p.type)])));
        const local = this.funcVars[this.funcVars.length - 1];
        const outer = this.funcVars[this.funcVars.length - 2];
        const savedLocal = this.currentAnonLocal;
        const savedRefs = this.currentAnonRefs;
        this.currentAnonLocal = local;
        this.currentAnonRefs = [];
        this.noteType(e.returnType);
        this.walkParams(e.params);
        this.walkStmts(e.body.body);
        const seen = new Map<string, CType>();
        for (const r of this.currentAnonRefs) {
          if (!local.has(r.name) && outer.has(r.name)) seen.set(r.name, r.type);
        }
        const captures = [...seen.entries()].map(([n, t]) => ({ name: n, type: t }));
        this.anonCaptures.set(e, captures);
        this.currentAnonLocal = savedLocal;
        this.currentAnonRefs = savedRefs;
        this.anonFuncs.push({ name, params: e.params, returnType: e.returnType, body: e.body, captures });
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
        `(((${b.cname}*)env)->vtable->${cIdent(b.mname)})`,
        b.m.params,
        b.m.returnType,
        `((${b.cname}*)env)`,
      );
    }
    // Static-method-as-value thunks: `ClassName.method` used as a Function value.
    // No receiver; the static method is called directly.
    for (const s of this.staticMethodRefs.values()) {
      this.emitThunk(
        `${s.cname}_${s.mname}__call`,
        `${s.cname}_${s.mname}`,
        s.m.params,
        s.m.returnType,
        null,
      );
    }
    // closure environment structs and heap-allocating constructors
    for (const fn of this.anonFuncs) {
      if (fn.captures.length === 0) continue;
      const fields = fn.captures.map((c) => `${this.cTypeName(c.type)} ${c.name};`).join(' ');
      this.line(`typedef struct { void (*mark)(void*); ${fields} } ${fn.name}_env;`);
    }
    for (const fn of this.anonFuncs) {
      if (fn.captures.length === 0) continue;
      const params = fn.captures.map((c) => `${this.cTypeName(c.type)} ${c.name}`).join(', ');
      // GC mark callback for the captured environment: trace each captured field
      // that carries a GC pointer (raw object/string) or a boxed as_value. The
      // env is a GCT_CUSTOM object so gc_scan dispatches to this callback, which
      // keeps any object/string the closure captured alive.
      this.line(`static void ${fn.name}_env_mark(void* self) {`);
      this.indent++;
      this.line(`${fn.name}_env* e = (${fn.name}_env*)self;`);
      for (const c of fn.captures) {
        const k = this.captureMarkKind(c.type);
        if (k === 'ptr') this.line(`gc_mark_ptr((void*)e->${c.name});`);
        else if (k === 'value') this.line(`gc_mark_value(e->${c.name});`);
      }
      this.indent--;
      this.line('}');
      this.line(`static ${fn.name}_env* ${fn.name}_env_make(${params}) {`);
      this.indent++;
      this.line(`${fn.name}_env* e = (${fn.name}_env*)gc_alloc(GCT_CUSTOM, sizeof(${fn.name}_env));`);
      this.line(`e->mark = ${fn.name}_env_mark;`);
      for (const c of fn.captures) this.line(`e->${c.name} = ${c.name};`);
      this.line('return e;');
      this.indent--;
      this.line('}');
    }
    if (this.anonFuncs.length > 0) this.line('');
    // prototypes first so a nested anonymous function's thunk resolves before
    // its enclosing body references it.
    for (const fn of this.anonFuncs) {
      const rt = resolveType(fn.returnType);
      if (fn.captures.length === 0) {
        this.line(`${this.cTypeName(rt)} ${fn.name}(${this.paramDecls(fn.params)});`);
      } else {
        const p = this.paramDecls(fn.params);
        this.line(`${this.cTypeName(rt)} ${fn.name}__impl(${fn.name}_env* env${p ? ', ' + p : ''});`);
      }
      this.line(`as_value ${fn.name}__call(void* env, as_value* args, int argc);`);
    }
    if (this.anonFuncs.length > 0) this.line('');
    for (const fn of this.anonFuncs) {
      const rt = resolveType(fn.returnType);
      this.pushScope();
      for (const p of fn.params) this.declareVar(p.name, resolveType(p.type));
      this.currentReturnType = rt;
      if (fn.captures.length === 0) {
        this.line(`${this.cTypeName(rt)} ${fn.name}(${this.paramDecls(fn.params)}) {`);
      } else {
        const p = this.paramDecls(fn.params);
        this.line(`${this.cTypeName(rt)} ${fn.name}__impl(${fn.name}_env* env${p ? ', ' + p : ''}) {`);
        this.currentClosureCaptures = new Map(fn.captures.map((c) => [c.name, c.type]));
      }
      this.indent++;
      this.emitBlockBody(fn.body);
      this.indent--;
      this.line('}');
      this.line('');
      this.currentClosureCaptures = null;
      this.popScope();
      this.currentReturnType = null;
      if (fn.captures.length === 0) {
        this.emitThunk(`${fn.name}__call`, fn.name, fn.params, rt, null);
      } else {
        this.emitThunk(`${fn.name}__call`, `${fn.name}__impl`, fn.params, rt, `((${fn.name}_env*)env)`);
      }
    }
    if (this.symbols.funcs.size > 0 || this.anonFuncs.length > 0) this.line('');
  }

  // A calling thunk: unbox each argument from the as_value[] list, call the
  // typed implementation, and box the result back into as_value. `envArg` is the
  // environment expression passed first for capturing closures (null otherwise).
  private emitThunk(name: string, callTarget: string, params: Param[], returnType: CType, envArg: string | null): void {
    const argCodes = params.map((p, i) =>
      this.unboxAny({ code: `args[${i}]`, type: { kind: 'any' } as CType }, resolveType(p.type)),
    );
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
        codes.push(this.convert(this.emitExpr(args[i]), resolveType(p.type)));
      } else if (p.defaultValue !== null) {
        codes.push(this.convert(this.emitExpr(p.defaultValue), resolveType(p.type)));
      } else {
        throw new CodegenError(`missing argument for parameter '${p.name}'`);
      }
    }
    if (args.length > params.length) {
      throw new CodegenError(`too many arguments (expected ${params.length}, got ${args.length})`);
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
    this.line('');
    // built-in Object: no fields to initialize, but every subclass's implicit
    // super() lands here, so it needs a real (empty) constructor definition.
    this.line('void Object_ctor(Object* o) { (void)o; }');
    this.line('Object* Object_new(void) { Object* o = (Object*)gc_alloc(GCT_CLASS, sizeof(Object)); o->vtable = &Object_vt; Object_ctor(o); return o; }');
    this.line('');
    // Stage 41 constant classes are pure static-String holders and are never
    // instantiated, but they still need concrete (empty) ctor/new definitions
    // so any reference links cleanly.
    for (const cc of ['StageAlign', 'StageScaleMode', 'StageQuality', 'StageDisplayState']) {
      this.line(`void ${cc}_ctor(${cc}* o) { Object_ctor((Object*)o); }`);
      this.line(`${cc}* ${cc}_new(void) { ${cc}* o = (${cc}*)gc_alloc(GCT_CLASS, sizeof(${cc})); o->vtable = &${cc}_vt; ${cc}_ctor(o); return o; }`);
    }
    this.line('');
    // built-in Error: constructor copies the message into the message field.
    this.line('void Error_ctor(Error* o, char* message) { o->message = message; gc_write_barrier((void*)message); }');
    this.line('Error* Error_new(char* message) {');
    this.indent++;
    this.line('Error* o = (Error*)gc_alloc(GCT_CLASS, sizeof(Error));');
    this.line('o->vtable = &Error_vt;');
    this.line('Error_ctor(o, message);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('');
    // built-in Error subclasses: identical { vtable; message } layout, but each
    // has its own vtable instance so `catch (e:TypeError)` can match precisely.
    for (const sub of ['TypeError', 'RangeError', 'ArgumentError', 'SyntaxError']) {
      this.line(`void ${sub}_ctor(${sub}* o, char* message) { o->message = message; gc_write_barrier((void*)message); }`);
      this.line(`${sub}* ${sub}_new(char* message) {`);
      this.indent++;
      this.line(`${sub}* o = (${sub}*)gc_alloc(GCT_CLASS, sizeof(${sub}));`);
      this.line(`o->vtable = &${sub}_vt;`);
      this.line(`${sub}_ctor(o, message);`);
      this.line('return o;');
      this.indent--;
      this.line('}');
      this.line('');
    }
    // built-in Date: stores milliseconds since the epoch; calendar accessors
    // convert through C's localtime() (AS3 getMonth/getDay are 0-based, matching
    // tm_mon/tm_wday). Constructors: () = now, (ms) = epoch ms, (string) = parsed,
    // (year, month, day, ...) = local calendar components.
    this.line('void Date_ctor(Date* o) { o->time = as_now_ms(); }');
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
    this.line('o->time = ms;');
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
    this.line('o->time = Date_mkms(year, mon, day, hour, min, sec, ms);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    // Date.parse: accept "YYYY/MM/DD" / "YYYY-MM-DD" with an optional time part.
    this.line('double Date_parse(char* s) {');
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
    this.line('static struct tm* Date_tm(Date* o) { time_t t = (time_t)(o->time / 1000.0); return localtime(&t); }');
    this.line('double Date_getTime(void* _this) { return ((Date*)_this)->time; }');
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
    this.line('time_t t = (time_t)(((Date*)_this)->time / 1000.0);');
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
    this.line('if (o->compiled->err) as_throw(SyntaxError_new((char*)o->compiled->errmsg));');
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
    this.line('Stage* DisplayObject_get_stage(void* _this) {');
    this.indent++;
    this.line('DisplayObject* o = (DisplayObject*)_this;');
    this.line('while (o->parent != NULL) o = (DisplayObject*)o->parent;');
    this.line("return (o->vtable != NULL && strcmp(o->vtable->name, \"Stage\") == 0) ? (Stage*)o : NULL;");
    this.indent--;
    this.line('}');
    this.line('');
    // filters: getter returns the stored array (NULL = empty); setter stores it
    // (assigning an empty array clears filters). The render() backend applies
    // these filters to the object's subtree (see as_render_filtered below).
    this.line('as_array* DisplayObject_get_filters(void* _this) { return ((DisplayObject*)_this)->filters; }');
    this.line('void DisplayObject_set_filters(void* _this, as_array* value) { DisplayObject* o = (DisplayObject*)_this; o->filters = value; if (value != NULL) gc_write_barrier((void*)value); }');
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
    this.line('');
    this.line('void Sprite_ctor(Sprite* o) { DisplayObjectContainer_ctor((DisplayObjectContainer*)o); }');
    this.line('Sprite* Sprite_new(void) { Sprite* o = (Sprite*)gc_alloc(GCT_CLASS, sizeof(Sprite)); o->vtable = &Sprite_vt; Sprite_ctor(o); return o; }');
    this.line('');
    // ---- flash.events mouse/keyboard/focus events + hit test (stage 35) ----
    this.line('void MouseEvent_ctor(MouseEvent* o, char* type, bool bubbles, bool cancelable, double localX, double localY, Object* relatedObject, bool ctrlKey, bool altKey, bool shiftKey, bool buttonDown, double delta) {');
    this.indent++;
    this.line('Event_ctor((Event*)o, type, bubbles, cancelable);');
    this.line('o->localX = localX; o->localY = localY;');
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
    this.line('void IOErrorEvent_ctor(IOErrorEvent* o, char* type, bool bubbles, bool cancelable, char* text) { ErrorEvent_ctor((ErrorEvent*)o, type, bubbles, cancelable, text); }');
    this.line('IOErrorEvent* IOErrorEvent_new(char* type, bool bubbles, bool cancelable, char* text) { IOErrorEvent* o = (IOErrorEvent*)gc_alloc(GCT_CLASS, sizeof(IOErrorEvent)); o->vtable = &IOErrorEvent_vt; IOErrorEvent_ctor(o, type, bubbles, cancelable, text); return o; }');
    this.line('void DataEvent_ctor(DataEvent* o, char* type, bool bubbles, bool cancelable, char* data) { Event_ctor((Event*)o, type, bubbles, cancelable); o->data = data; gc_write_barrier((void*)data); }');
    this.line('DataEvent* DataEvent_new(char* type, bool bubbles, bool cancelable, char* data) { DataEvent* o = (DataEvent*)gc_alloc(GCT_CLASS, sizeof(DataEvent)); o->vtable = &DataEvent_vt; DataEvent_ctor(o, type, bubbles, cancelable, data); return o; }');
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
    this.line('void Timer_set_delay(void* _this, double value) { if (isnan(value) || isinf(value) || value < 0) { as_throw(RangeError_new((char*)"The delay specified is negative or not a finite number")); return; } ((Timer*)_this)->delay = value; }');
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
    this.line('o->currentFrame = 0; o->totalFrames = 1; o->playing = false;');
    this.indent--;
    this.line('}');
    this.line('MovieClip* MovieClip_new(void) { MovieClip* o = (MovieClip*)gc_alloc(GCT_CLASS, sizeof(MovieClip)); o->vtable = &MovieClip_vt; MovieClip_ctor(o); return o; }');
    this.line('int MovieClip_get_currentFrame(void* _this) { return ((MovieClip*)_this)->currentFrame; }');
    this.line('int MovieClip_get_totalFrames(void* _this) { return ((MovieClip*)_this)->totalFrames; }');
    // totalFrames is writable in this subset (no symbol timeline); a value < 1 is
    // rejected like AIR rejects an empty timeline.
    this.line('void MovieClip_set_totalFrames(void* _this, int value) { if (value < 1) { as_throw(RangeError_new((char*)"The totalFrames specified is less than 1")); return; } ((MovieClip*)_this)->totalFrames = value; }');
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
    this.line('o->bytesLoaded = 0; o->bytesTotal = 0; o->url = NULL;');
    this.indent--;
    this.line('}');
    this.line('LoaderInfo* LoaderInfo_new(void) { LoaderInfo* o = (LoaderInfo*)gc_alloc(GCT_CLASS, sizeof(LoaderInfo)); o->vtable = &LoaderInfo_vt; LoaderInfo_ctor(o); return o; }');
    this.line('');
    // Loader: a DisplayObjectContainer holding loaded content. contentLoaderInfo is
    // created at construction (never null, matching AIR). load(url) is a synchronous
    // simulation — real async URLRequest/URLLoader arrives in stage 63.
    this.line('void Loader_ctor(Loader* o) {');
    this.indent++;
    this.line('DisplayObjectContainer_ctor((DisplayObjectContainer*)o);');
    this.line('o->content = NULL; o->contentLoaderInfo = LoaderInfo_new();');
    this.line('gc_write_barrier((void*)o->contentLoaderInfo);');
    this.indent--;
    this.line('}');
    this.line('Loader* Loader_new(void) { Loader* o = (Loader*)gc_alloc(GCT_CLASS, sizeof(Loader)); o->vtable = &Loader_vt; Loader_ctor(o); return o; }');
    this.line('DisplayObject* Loader_get_content(void* _this) { return ((Loader*)_this)->content; }');
    this.line('LoaderInfo* Loader_get_contentLoaderInfo(void* _this) { return ((Loader*)_this)->contentLoaderInfo; }');
    // Async completion thunk: fires COMPLETE on contentLoaderInfo on a later frame
    // tick (AIR dispatches load completion asynchronously, so listeners registered
    // after load() still receive it).
    this.line('static as_value Loader__complete(void* env, as_value* args, int argc) {');
    this.indent++;
    this.line('(void)args; (void)argc;');
    this.line('Loader* o = (Loader*)env;');
    this.line('EventDispatcher_dispatchEvent((void*)o->contentLoaderInfo, (Event*)Event_new((char*)"complete", false, false));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('void Loader_load(void* _this, char* url) {');
    this.indent++;
    this.line('Loader* o = (Loader*)_this;');
    this.line('LoaderInfo* li = o->contentLoaderInfo;');
    this.line('li->url = url; gc_write_barrier((void*)url);');
    this.line('li->bytesLoaded = 0; li->bytesTotal = 0;');
    this.line('EventDispatcher_dispatchEvent((void*)li, (Event*)Event_new((char*)"init", false, false));');
    this.line('as_set_timeout(as_fn_make(Loader__complete, (void*)o), 0.0);');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.net / flash.ui (stage 63): URLRequest / URLLoader / Keyboard / Mouse ----
    //
    // as_read_file: synchronous whole-file read into a GC-managed String buffer
    // (NUL-terminated via as_str_alloc). URLLoader.data holds this buffer and is
    // therefore GC-tracked — a GC cycle that runs between load() and the deferred
    // COMPLETE dispatch cannot collect it because the URLLoader instance (and its
    // `data` field) is reachable from the pending timer's closure env. Returns
    // NULL on failure and sets *out_len to -1.
    this.line('static char* as_read_file(const char* path, int* out_len) {');
    this.indent++;
    this.line('FILE* f = fopen(path, "rb");');
    this.line('if (f == NULL) { if (out_len) *out_len = -1; return NULL; }');
    this.line('fseek(f, 0, SEEK_END);');
    this.line('long sz = ftell(f);');
    this.line('fseek(f, 0, SEEK_SET);');
    this.line('if (sz < 0) sz = 0;');
    this.line('char* buf = as_str_alloc((size_t)sz + 1);');
    this.line('if (sz > 0) { size_t n = fread(buf, 1, (size_t)sz, f); sz = (long)n; }');
    this.line('buf[sz] = \'\\0\';');
    this.line('fclose(f);');
    this.line('if (out_len) *out_len = (int)sz;');
    this.line('return buf;');
    this.indent--;
    this.line('}');
    this.line('');
    // URLRequest: load-request value bundle. method defaults to "GET"; data is
    // boxed `any` (null by default); contentType defaults to null.
    this.line('void URLRequest_ctor(URLRequest* o, char* url) {');
    this.indent++;
    this.line('o->url = url; gc_write_barrier((void*)url);');
    this.line('o->method = (char*)"GET";');
    this.line('o->data = as_v_null();');
    this.line('o->contentType = NULL;');
    this.indent--;
    this.line('}');
    this.line('URLRequest* URLRequest_new(char* url) { URLRequest* o = (URLRequest*)gc_alloc(GCT_CLASS, sizeof(URLRequest)); o->vtable = &URLRequest_vt; URLRequest_ctor(o, url); return o; }');
    this.line('');
    // URLLoader: asynchronous local-file load. The URL is treated as a filesystem
    // path; the file is read synchronously but COMPLETE/IO_ERROR are deferred to a
    // later frame tick via setTimeout(0), so listeners registered after load() still
    // fire (AIR's async contract). data holds the GC-managed file text.
    this.line('void URLLoader_ctor(URLLoader* o) {');
    this.indent++;
    this.line('EventDispatcher_ctor((EventDispatcher*)o);');
    this.line('o->data = NULL; o->dataFormat = (char*)"text";');
    this.indent--;
    this.line('}');
    this.line('URLLoader* URLLoader_new(void) { URLLoader* o = (URLLoader*)gc_alloc(GCT_CLASS, sizeof(URLLoader)); o->vtable = &URLLoader_vt; URLLoader_ctor(o); return o; }');
    this.line('static as_value URLLoader__finish(void* env, as_value* args, int argc) {');
    this.indent++;
    this.line('(void)args; (void)argc;');
    this.line('URLLoader* o = (URLLoader*)env;');
    this.line('if (o->data != NULL) EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"complete", false, false));');
    this.line('else EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"ioError", false, false));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('void URLLoader_load(void* _this, URLRequest* request) {');
    this.indent++;
    this.line('URLLoader* o = (URLLoader*)_this;');
    this.line('o->data = NULL;');
    this.line('if (request != NULL && request->url != NULL) {');
    this.indent++;
    this.line('int len = 0;');
    this.line('char* buf = as_read_file(request->url, &len);');
    this.line('if (buf != NULL && len >= 0) { o->data = buf; gc_write_barrier((void*)buf); }');
    this.indent--;
    this.line('}');
    this.line('as_set_timeout(as_fn_make(URLLoader__finish, (void*)o), 0.0);');
    this.indent--;
    this.line('}');
    this.line('void URLLoader_close(void* _this) { (void)_this; }');
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
    this.line('if (source != NULL && *source != \'\\0\') {');
    this.indent++;
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
    this.indent--;
    this.line('}');
    this.line('URLVariables* URLVariables_new(char* source) { URLVariables* o = (URLVariables*)gc_alloc(GCT_CLASS, sizeof(URLVariables)); o->vtable = &URLVariables_vt; URLVariables_ctor(o, source); return o; }');
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
    this.line('void Mouse_hide(void) { as_mouse_visible = false; }');
    this.line('void Mouse_show(void) { as_mouse_visible = true; }');
    this.line('');
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
    this.line('File* File_resolvePath(void* _this, char* path) { File* o = (File*)_this; return (o->nativePath == NULL) ? File_new(path) : File_new(as_path_join(o->nativePath, path)); }');
    this.line('void File_createDirectory(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) as_mkdirs(o->nativePath); }');
    this.line('void File_deleteFile(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) remove(o->nativePath); }');
    this.line('void File_deleteDirectory(void* _this) { File* o = (File*)_this; if (o->nativePath != NULL) remove(o->nativePath); }');
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
    // Async completion thunk for openAsync: reports the full byte count via a
    // ProgressEvent.PROGRESS then Event.COMPLETE on a later frame tick (AIR reads
    // the file asynchronously and fires these before the data is consumed).
    this.line('static as_value FileStream__async(void* env, as_value* args, int argc) {');
    this.indent++;
    this.line('(void)args; (void)argc;');
    this.line('FileStream* o = (FileStream*)env;');
    this.line('unsigned total = 0;');
    this.line('FILE* f = (FILE*)o->_handle;');
    this.line('if (f != NULL) { long cur = ftell(f); fseek(f, 0, SEEK_END); total = (unsigned)ftell(f); fseek(f, cur, SEEK_SET); }');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)ProgressEvent_new((char*)"progress", false, false, total, total));');
    this.line('EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new((char*)"complete", false, false));');
    this.line('return as_v_null();');
    this.indent--;
    this.line('}');
    this.line('void FileStream_openAsync(void* _this, File* file, char* fileMode) {');
    this.indent++;
    this.line('FileStream_open(_this, file, fileMode);');
    this.line('as_set_timeout(as_fn_make(FileStream__async, (void*)_this), 0.0);');
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
    this.line('void Stage_dispatchMouse(void* _this, double x, double y, char* type) {');
    this.indent++;
    this.line('void* target = as_pick_hit(_this, x, y);');
    this.line('if (target == NULL) return;');
    this.line('DisplayObject* o = (DisplayObject*)target;');
    this.line('MouseEvent* evt = MouseEvent_new(type, true, false, x - o->x, y - o->y, NULL, false, false, false, false, 0.0);');
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
    this.line('o->pixels = (void*)malloc(sizeof(unsigned) * (size_t)(width * height));');
    this.line('unsigned a = transparent ? (fillColor >> 24) : 0xFFu;');
    this.line('unsigned argb = (a << 24) | (fillColor & 0xFFFFFFu);');
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
    this.line('void BitmapData_loadFile(void* _this, char* path) { ((BitmapData*)_this)->image = as_skia_image_from_file(path); }');
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
    this.line('else if (as_is(filter, &DropShadowFilter_vt) || as_is(filter, &GlowFilter_vt)) { as_throw(Error_new((char*)"applyFilter: DropShadowFilter/GlowFilter rasterization not implemented")); return; }');
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
    this.line('unsigned char* nd = (unsigned char*)as_alloc((size_t)cap);');
    this.line('if (o->data != NULL && o->length > 0) memcpy(nd, o->data, (size_t)o->length);');
    this.line('o->data = (void*)nd; o->capacity = cap;');
    this.indent--;
    this.line('}');
    this.line('static void as_ba_put_u16(ByteArray* o, unsigned v) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data;');
    this.line('d[o->length++] = (unsigned char)((v >> 8) & 0xFF);');
    this.line('d[o->length++] = (unsigned char)(v & 0xFF);');
    this.indent--;
    this.line('}');
    this.line('static void as_ba_put_u32(ByteArray* o, unsigned v) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data;');
    this.line('d[o->length++] = (unsigned char)((v >> 24) & 0xFF);');
    this.line('d[o->length++] = (unsigned char)((v >> 16) & 0xFF);');
    this.line('d[o->length++] = (unsigned char)((v >> 8) & 0xFF);');
    this.line('d[o->length++] = (unsigned char)(v & 0xFF);');
    this.indent--;
    this.line('}');
    this.line('static unsigned as_ba_get_u16(ByteArray* o) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data;');
    this.line('unsigned v = ((unsigned)d[o->position] << 8) | (unsigned)d[o->position + 1];');
    this.line('o->position += 2; return v;');
    this.indent--;
    this.line('}');
    this.line('static unsigned as_ba_get_u32(ByteArray* o) {');
    this.indent++;
    this.line('unsigned char* d = (unsigned char*)o->data;');
    this.line('unsigned v = ((unsigned)d[o->position] << 24) | ((unsigned)d[o->position + 1] << 16) | ((unsigned)d[o->position + 2] << 8) | (unsigned)d[o->position + 3];');
    this.line('o->position += 4; return v;');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_ctor(ByteArray* o) { o->data = NULL; o->length = 0; o->capacity = 0; o->position = 0; }');
    this.line('ByteArray* ByteArray_new(void) { ByteArray* o = (ByteArray*)gc_alloc(GCT_CLASS, sizeof(ByteArray)); o->vtable = &ByteArray_vt; ByteArray_ctor(o); return o; }');
    this.line('void ByteArray_writeByte(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow(o, 1);');
    this.line('((unsigned char*)o->data)[o->length++] = (unsigned char)(v & 0xFF);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeShort(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow(o, 2); as_ba_put_u16(o, (unsigned)v);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeInt(void* _this, int v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow(o, 4); as_ba_put_u32(o, (unsigned)v);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeFloat(void* _this, double v) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; as_ba_grow(o, 4);');
    this.line('float f = (float)v; unsigned bits; memcpy(&bits, &f, 4); as_ba_put_u32(o, bits);');
    this.indent--;
    this.line('}');
    this.line('void ByteArray_writeUTFBytes(void* _this, char* s) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (s == NULL) return;');
    this.line('int n = (int)strlen(s); as_ba_grow(o, n);');
    this.line('memcpy((unsigned char*)o->data + o->length, s, (size_t)n); o->length += n;');
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
    this.line('void ByteArray_clear(void* _this) { ByteArray* o = (ByteArray*)_this; o->length = 0; o->position = 0; }');
    this.line('void ByteArray_compress(void* _this) {');
    this.indent++;
    this.line('ByteArray* o = (ByteArray*)_this; if (o->length == 0) return;');
    this.line('#ifdef __wasi__');
    this.line('(void)o; // no zlib on WASI: compress is a documented no-op');
    this.line('#else');
    this.line('uLongf dst = compressBound((uLong)o->length);');
    this.line('unsigned char* tmp = (unsigned char*)as_alloc((size_t)dst);');
    this.line('if (compress(tmp, &dst, (const unsigned char*)o->data, (uLong)o->length) == Z_OK) {');
    this.indent++;
    this.line('o->data = (void*)tmp; o->length = (int)dst; o->capacity = (int)dst; o->position = 0;');
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
    this.line('unsigned char* out = (unsigned char*)as_alloc((size_t)cap);');
    this.line('uLongf dst = cap;');
    this.line('int rc = uncompress(out, &dst, (const unsigned char*)o->data, (uLong)o->length);');
    this.line('if (rc == Z_OK) { o->data = (void*)out; o->length = (int)dst; o->capacity = (int)dst; o->position = 0; break; }');
    this.line('if (rc != Z_BUF_ERROR) break;');
    this.line('cap *= 2;');
    this.indent--;
    this.line('}');
    this.line('#endif');
    this.indent--;
    this.line('}');
    this.line('');
    // ---- flash.text (stage 38) ----
    this.line('void TextFormat_ctor(TextFormat* o, char* font, double size, unsigned color, bool bold, bool italic) {');
    this.indent++;
    this.line('o->font = font; o->size = size; o->color = color; o->bold = bold; o->italic = italic;');
    this.line('gc_write_barrier((void*)font);');
    this.indent--;
    this.line('}');
    this.line('TextFormat* TextFormat_new(char* font, double size, unsigned color, bool bold, bool italic) {');
    this.indent++;
    this.line('TextFormat* o = (TextFormat*)gc_alloc(GCT_CLASS, sizeof(TextFormat));');
    this.line('o->vtable = &TextFormat_vt;');
    this.line('TextFormat_ctor(o, font, size, color, bold, italic);');
    this.line('return o;');
    this.indent--;
    this.line('}');
    this.line('void TextField_ctor(TextField* o) {');
    this.indent++;
    this.line('InteractiveObject_ctor((InteractiveObject*)o);');
    this.line('o->text = NULL;');
    this.line('o->defaultTextFormat = TextFormat_new(NULL, 12.0, 0x000000u, false, false);');
    this.line('o->multiline = false;');
    this.line('o->wordWrap = false;');
    this.line('o->background = false;');
    this.line('o->backgroundColor = 0xFFFFFFFFu;');
    this.line('o->scrollV = 1;');
    this.indent--;
    this.line('}');
    this.line('TextField* TextField_new(void) { TextField* o = (TextField*)gc_alloc(GCT_CLASS, sizeof(TextField)); o->vtable = &TextField_vt; TextField_ctor(o); return o; }');
    // --- TextField text layout (stage 44) ---
    // AIR breaks text into display lines: '\n' always starts a new line, and with
    // wordWrap a line additionally breaks at the last space that still fits width.
    // Line height is approximated as 1.2 * size (what a 12px _typewriter yields in
    // AIR, ~15px) because the offscreen Skia path has no font metric table here.
    this.line('static void as_tf_layout(TextField* tf, AsLines* L) {');
    this.indent++;
    this.line('as_lines_reset(L);');
    this.line('if (tf->text == NULL) return;');
    this.line('TextFormat* fmt = tf->defaultTextFormat;');
    this.line('double size = (fmt != NULL) ? fmt->size : 12.0;');
    this.line('int bold = (fmt != NULL && fmt->bold) ? 1 : 0;');
    this.line('int italic = (fmt != NULL && fmt->italic) ? 1 : 0;');
    // A single-line field keeps '\n' inline instead of breaking (AIR behavior).
    this.line('if (!tf->multiline) { as_lines_push(L, 0, (int)strlen(tf->text)); return; }');
    this.line('as_text_wrap(tf->text, tf->wordWrap ? tf->width : 0.0, size, bold, italic, tf->wordWrap ? 1 : 0, L);');
    this.indent--;
    this.line('}');
    this.line('static double as_tf_line_height(TextField* tf) {');
    this.indent++;
    this.line('double size = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->size : 12.0;');
    this.line('return size * 1.2;');
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
    this.line('AsLines L; as_tf_layout(tf, &L); int n = L.count; as_lines_free(&L); return n;');
    this.indent--;
    this.line('}');
    this.line('double TextField_get_textWidth(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (tf->text == NULL || tf->defaultTextFormat == NULL) return 0.0;');
    this.line('TextFormat* fmt = tf->defaultTextFormat;');
    this.line('AsLines L; as_tf_layout(tf, &L);');
    this.line('double max = 0.0;');
    this.line('for (int i = 0; i < L.count; i++) {');
    this.indent++;
    this.line('double w = as_skia_text_measure_n(tf->text + L.items[i].start, L.items[i].len, fmt->size, fmt->bold, fmt->italic);');
    this.line('if (w > max) max = w;');
    this.indent--;
    this.line('}');
    this.line('as_lines_free(&L);');
    this.line('return max;');
    this.indent--;
    this.line('}');
    this.line('double TextField_get_textHeight(void* _this) {');
    this.indent++;
    this.line('TextField* tf = (TextField*)_this;');
    this.line('if (tf->defaultTextFormat == NULL) return 0.0;');
    this.line('return (double)as_tf_line_count(tf) * as_tf_line_height(tf);');
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
    // --- flash.geom (stage 58) ---
    // Point/Rectangle/Matrix/ColorTransform hold only double fields, so they are
    // plain value bundles (no GC pointers); Transform holds Matrix/ColorTransform
    // object references and is marked via its prop table.
    this.line('static Point* Point_mk(double x, double y) { Point* p = (Point*)gc_alloc(GCT_CLASS, sizeof(Point)); p->vtable = &Point_vt; p->x = x; p->y = y; return p; }');
    this.line('void Point_ctor(Point* o, double x, double y) { o->x = x; o->y = y; }');
    this.line('Point* Point_new(double x, double y) { Point* o = (Point*)gc_alloc(GCT_CLASS, sizeof(Point)); o->vtable = &Point_vt; Point_ctor(o, x, y); return o; }');
    this.line('double Point_get_length(void* _this) { Point* p = (Point*)_this; return sqrt(p->x * p->x + p->y * p->y); }');
    this.line('double Point_distance(Point* pt1, Point* pt2) { double dx = pt1->x - pt2->x, dy = pt1->y - pt2->y; return sqrt(dx * dx + dy * dy); }');
    // AS3 quirk: the closer f is to 1, the closer the result is to pt1 (not pt2).
    this.line('Point* Point_interpolate(Point* pt1, Point* pt2, double f) { return Point_mk(pt2->x + f * (pt1->x - pt2->x), pt2->y + f * (pt1->y - pt2->y)); }');
    this.line('Point* Point_polar(double len, double angle) { return Point_mk(len * cos(angle), len * sin(angle)); }');
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
    this.line('bool Rectangle_isEmpty(void* _this) { Rectangle* r = (Rectangle*)_this; return r->width <= 0.0 || r->height <= 0.0; }');
    this.line('void Rectangle_setEmpty(void* _this) { Rectangle* r = (Rectangle*)_this; r->x = r->y = r->width = r->height = 0.0; }');
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
    this.line('char* Rectangle_toString(void* _this) { Rectangle* r = (Rectangle*)_this; char* b = as_str_alloc(96); snprintf(b, 96, "(x=%s, y=%s, w=%s, h=%s)", as_str_from_double(r->x), as_str_from_double(r->y), as_str_from_double(r->width), as_str_from_double(r->height)); return b; }');
    this.line('');
    this.line('static Matrix* Matrix_mk(double a, double b, double c, double d, double tx, double ty) { Matrix* m = (Matrix*)gc_alloc(GCT_CLASS, sizeof(Matrix)); m->vtable = &Matrix_vt; m->a = a; m->b = b; m->c = c; m->d = d; m->tx = tx; m->ty = ty; return m; }');
    this.line('void Matrix_ctor(Matrix* o, double a, double b, double c, double d, double tx, double ty) { o->a = a; o->b = b; o->c = c; o->d = d; o->tx = tx; o->ty = ty; }');
    this.line('Matrix* Matrix_new(double a, double b, double c, double d, double tx, double ty) { Matrix* o = (Matrix*)gc_alloc(GCT_CLASS, sizeof(Matrix)); o->vtable = &Matrix_vt; Matrix_ctor(o, a, b, c, d, tx, ty); return o; }');
    this.line('void Matrix_identity(void* _this) { Matrix* m = (Matrix*)_this; m->a = 1.0; m->b = 0.0; m->c = 0.0; m->d = 1.0; m->tx = 0.0; m->ty = 0.0; }');
    this.line('void Matrix_translate(void* _this, double dx, double dy) { Matrix* m = (Matrix*)_this; m->tx += m->a * dx + m->c * dy; m->ty += m->b * dx + m->d * dy; }');
    this.line('void Matrix_scale(void* _this, double sx, double sy) { Matrix* m = (Matrix*)_this; m->a *= sx; m->b *= sx; m->c *= sy; m->d *= sy; }');
    this.line('void Matrix_rotate(void* _this, double angle) { Matrix* m = (Matrix*)_this; double c = cos(angle), s = sin(angle); double a1 = m->a * c + m->c * s, b1 = m->b * c + m->d * s; double c1 = -m->a * s + m->c * c, d1 = -m->b * s + m->d * c; m->a = a1; m->b = b1; m->c = c1; m->d = d1; }');
    // concat = this * m (apply m first, then this); matrix product is non-commutative.
    this.line('void Matrix_concat(void* _this, Matrix* q) { Matrix* m = (Matrix*)_this; double a1 = m->a * q->a + m->c * q->b, b1 = m->b * q->a + m->d * q->b; double c1 = m->a * q->c + m->c * q->d, d1 = m->b * q->c + m->d * q->d; double tx1 = m->a * q->tx + m->c * q->ty + m->tx, ty1 = m->b * q->tx + m->d * q->ty + m->ty; m->a = a1; m->b = b1; m->c = c1; m->d = d1; m->tx = tx1; m->ty = ty1; }');
    this.line('void Matrix_invert(void* _this) { Matrix* m = (Matrix*)_this; double det = m->a * m->d - m->b * m->c; if (det == 0.0) { as_throw(Error_new((char*)"Matrix cannot be inverted")); return; } double na = m->d / det, nb = -m->b / det, nc = -m->c / det, nd = m->a / det; double ntx = (m->c * m->ty - m->d * m->tx) / det, nty = (m->b * m->tx - m->a * m->ty) / det; m->a = na; m->b = nb; m->c = nc; m->d = nd; m->tx = ntx; m->ty = nty; }');
    this.line('Point* Matrix_transformPoint(void* _this, Point* p) { Matrix* m = (Matrix*)_this; return Point_mk(m->a * p->x + m->c * p->y + m->tx, m->b * p->x + m->d * p->y + m->ty); }');
    this.line('Point* Matrix_deltaTransformPoint(void* _this, Point* p) { Matrix* m = (Matrix*)_this; return Point_mk(m->a * p->x + m->c * p->y, m->b * p->x + m->d * p->y); }');
    this.line('void Matrix_createBox(void* _this, double sx, double sy, double rotation, double tx, double ty) { Matrix* m = (Matrix*)_this; m->a = cos(rotation) * sx; m->b = sin(rotation) * sx; m->c = -sin(rotation) * sy; m->d = cos(rotation) * sy; m->tx = tx; m->ty = ty; }');
    this.line('void Matrix_createGradientBox(void* _this, double width, double height, double rotation, double tx, double ty) { Matrix* m = (Matrix*)_this; m->a = width / 1638.4; m->d = height / 1638.4; if (rotation != 0.0) { double c = cos(rotation), s = sin(rotation); m->b = s * m->d; m->c = -s * m->a; m->a *= c; m->d *= c; } else { m->b = 0.0; m->c = 0.0; } m->tx = tx + width / 2.0; m->ty = ty + height / 2.0; }');
    this.line('Matrix* Matrix_clone(void* _this) { Matrix* m = (Matrix*)_this; return Matrix_mk(m->a, m->b, m->c, m->d, m->tx, m->ty); }');
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
    this.line('gc_step();');
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
    this.line('if (o->filters != NULL && o->filters->length > 0) {');
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
    this.line('TextFormat* fmt = tf->defaultTextFormat;');
    this.line('AsLines L; as_tf_layout(tf, &L);');
    this.line('double lh = as_tf_line_height(tf);');
    this.line('int vis = as_tf_visible_lines(tf);');
    this.line('int maxs = L.count - vis + 1; if (maxs < 1) maxs = 1;');
    this.line('int top = tf->scrollV; if (top < 1) top = 1; if (top > maxs) top = maxs;');
    this.line('void* paint = as_skia_paint_fill(fmt->color, 1.0);');
    this.line('as_skia_canvas_save(canvas);');
    this.line('as_skia_canvas_clip_rect(canvas, 0.0, 0.0, tf->width, tf->height);');
    this.line('for (int i = top - 1; i < L.count && i < (top - 1) + vis; i++) {');
    this.indent++;
    this.line('double baseline = 2.0 + (double)(i - (top - 1)) * lh + fmt->size * 0.8;');
    this.line('as_skia_canvas_draw_text_n(canvas, tf->text + L.items[i].start, L.items[i].len,');
    this.line('    2.0, baseline, fmt->size, fmt->bold, fmt->italic, paint);');
    this.indent--;
    this.line('}');
    this.line('as_skia_canvas_restore(canvas);');
    this.line('as_skia_paint_delete(paint);');
    this.line('as_lines_free(&L);');
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
    this.line('if (ASC_win_canvas == NULL || st == NULL) return;');
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
    this.line('as_skia_canvas_clear(ASC_win_canvas, st->stage_color);');
    this.line('as_skia_canvas_save(ASC_win_canvas);');
    this.line('as_skia_canvas_scale(ASC_win_canvas, ASC_win_scale, ASC_win_scale);');
    this.line('as_skia_canvas_translate(ASC_win_canvas, ox, oy);');
    this.line('as_skia_canvas_scale(ASC_win_canvas, cx, cy);');
    this.line('as_render_object(ASC_win_canvas, (DisplayObject*)st);');
    this.line('as_skia_canvas_restore(ASC_win_canvas);');
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
    this.indent--;
    this.line('}');
    this.line('void Stage_showWindow(void* _this, double width, double height, char* title) {');
    this.indent++;
    this.line('Stage* st = (Stage*)_this;');
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
      // GC mark callback: trace the data buffer. For reference elements the data
      // is a GCT_PTR_ARRAY whose children the GC scans; for scalar elements the
      // data is a plain malloc'd value buffer, which gc_mark_ptr skips (outside
      // the GC segment range).
      this.line(`static void as_vector_${key}_mark(void* self) {`);
      this.indent++;
      this.line(`as_vector_${key}* v = (as_vector_${key}*)self;`);
      this.line('gc_mark_ptr(v->data);');
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
      this.line(`void as_vector_${key}_push(as_vector_${key}* v, ${ec} e) {`);
      this.indent++;
      this.line('if (v->length == v->capacity) {');
      this.indent++;
      if (isPtr) {
        this.line('int cap = v->capacity ? v->capacity * 2 : 4;');
        this.line(`${ec}* nd = (${ec}*)gc_alloc(GCT_PTR_ARRAY, (size_t)cap * sizeof(${ec}));`);
        this.line(`if (v->data != NULL && v->length > 0) memcpy(nd, v->data, (size_t)v->length * sizeof(${ec}));`);
        this.line('v->data = nd; v->capacity = cap;');
      } else {
        this.line('v->capacity = v->capacity ? v->capacity * 2 : 4;');
        this.line(`v->data = (${ec}*)realloc(v->data, v->capacity * sizeof(${ec}));`);
      }
      this.indent--;
      this.line('}');
      this.line('v->data[v->length++] = e;');
      if (isPtr) this.line('gc_write_barrier((void*)e);');
      this.indent--;
      this.line('}');
      this.line(`${ec} as_vector_${key}_pop(as_vector_${key}* v) {`);
      this.indent++;
      this.line(`if (v->length == 0) { as_throw(RangeError_new("Vector index out of bounds")); return ${defExpr}; }`);
      this.line('return v->data[--v->length];');
      this.indent--;
      this.line('}');
      this.line(`${ec} as_vector_${key}_get(as_vector_${key}* v, int i) {`);
      this.indent++;
      this.line(`if (i < 0 || i >= v->length) { as_throw(RangeError_new("Vector index out of bounds")); return ${defExpr}; }`);
      this.line('return v->data[i];');
      this.indent--;
      this.line('}');
      this.line(`void as_vector_${key}_set(as_vector_${key}* v, int i, ${ec} e) {`);
      this.indent++;
      this.line(`if (i < 0 || i >= v->length) { as_throw(RangeError_new("Vector index out of bounds")); return; }`);
      this.line('v->data[i] = e;');
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
      this.line('if (n < 0) { as_throw(RangeError_new("Vector length cannot be negative")); return; }');
      this.line('if (n < v->length) { v->length = n; return; }');
      if (isPtr) {
        this.line(`if (v->capacity < n) { ${ec}* nd = (${ec}*)gc_alloc(GCT_PTR_ARRAY, (size_t)n * sizeof(${ec})); if (v->data != NULL && v->length > 0) memcpy(nd, v->data, (size_t)v->length * sizeof(${ec})); v->data = nd; v->capacity = n; }`);
      } else {
        this.line(`while (v->capacity < n) { v->capacity = v->capacity ? v->capacity * 2 : 4; v->data = (${ec}*)realloc(v->data, v->capacity * sizeof(${ec})); }`);
      }
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
      this.line('int cap = v->capacity ? v->capacity : 4;');
      this.line('while (cap < need) cap *= 2;');
      if (isPtr) {
        this.line(`${ec}* nd = (${ec}*)gc_alloc(GCT_PTR_ARRAY, (size_t)cap * sizeof(${ec}));`);
        this.line(`if (v->data != NULL && v->length > 0) memcpy(nd, v->data, (size_t)v->length * sizeof(${ec}));`);
        this.line('v->data = nd;');
      } else {
        this.line(`v->data = (${ec}*)realloc(v->data, (size_t)cap * sizeof(${ec}));`);
      }
      this.line('v->capacity = cap;');
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
      this.line('for (int i = 0; i < itemCount; i++) { v->data[start + i] = items[i];' + (isPtr ? ' gc_write_barrier((void*)items[i]);' : '') + ' }');
      this.line('v->length += delta;');
      this.line('return removed;');
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
      const ctor = stmt.members.find(
        (m): m is Extract<ClassMember, { kind: 'Constructor' }> => m.kind === 'Constructor',
      );
      const params = this.paramDecls(info.constructor.params);
      const paramNames = info.constructor.params.map((p) => p.name).join(', ');

      // init: super() (explicit or implicit) -> own field defaults -> constructor
      // body (no allocation, no vtable write). Inherited fields are NOT re-init'd
      // here: the superclass constructor already set their AS3 defaults.
      const ctorBody = ctor ? ctor.body.body : [];
      const hasExplicitSuper = ctorBody.length > 0 && ctorBody[0].kind === 'SuperCall';
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
      if (ctor) {
        this.pushScope();
        this.declareVar('this', { kind: 'object', className: name });
        for (const p of ctor.params) this.declareVar(p.name, resolveType(p.type));
        this.line(`${name}* this = o;`);
        this.currentClass = name;
      }
      if (hasExplicitSuper) {
        this.emitStmt(ctorBody[0]);
      } else if (info.superClass) {
        this.line(`${info.superClass}_ctor((${info.superClass}*)o);`);
      }
      for (const [fname, f] of info.fields) {
        if (f.owner !== name) continue; // inherited fields are set by super()
        const init = f.init ? this.convert(this.emitExpr(f.init), f.type) : this.defaultInit(f.type);
        this.line(`o->${fname} = ${init};`);
      }
      if (ctor) {
        const stmts = hasExplicitSuper ? ctorBody.slice(1) : ctorBody;
        this.emitArgsIfUsed({ kind: 'Block', body: stmts }, ctor.params);
        this.emitBlockBody({ kind: 'Block', body: stmts });
        this.currentClass = null;
        this.currentArgs = null;
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
    }
    // methods (instance / static / getter / setter)
    for (const stmt of this.program.body) {
      if (stmt.kind !== 'ClassDecl') continue;
      for (const m of stmt.members) {
        if (m.kind !== 'Method') continue;
        const cname = qualifiedName(stmt.name, stmt.packageName);
        const returnType = resolveType(m.returnType);
        this.line(`// ${cname}.${m.name}`);
        this.currentClass = cname;
        this.currentIsStatic = m.isStatic;
        this.currentReturnType = returnType;
        this.pushScope();
        this.declareVar('this', { kind: 'object', className: cname });
        for (const p of m.params) this.declareVar(p.name, resolveType(p.type));
        const params = this.paramDecls(m.params);

        if (m.isStatic) {
          this.line(`${this.cTypeName(returnType)} ${cname}_${m.name}(${params}) {`);
          this.indent++;
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isGetter) {
          this.line(`${this.cTypeName(returnType)} ${cname}_get_${m.name}(void* _this) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else if (m.isSetter) {
          this.line(`void ${cname}_set_${m.name}(void* _this${params ? ', ' + params : ''}) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        } else {
          this.line(`${this.cTypeName(returnType)} ${cname}_${m.name}(void* _this${params ? ', ' + params : ''}) {`);
          this.indent++;
          this.line(`${cname}* this = (${cname}*)_this;`);
          this.emitArgsIfUsed(m.body, m.params);
          this.emitBlockBody(m.body);
          this.indent--;
          this.line('}');
          this.line('');
        }
        this.popScope();
        this.currentClass = null;
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
      for (const p of stmt.params) this.declareVar(p.name, resolveType(p.type));
      this.currentReturnType = f.returnType;
      this.line(`${this.cTypeName(f.returnType)} ${stmt.name}(${this.paramDecls(stmt.params)}) {`);
      this.indent++;
      this.emitArgsIfUsed(stmt.body, stmt.params);
      this.emitBlockBody(stmt.body);
      this.indent--;
      this.line('}');
      this.line('');
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
    const vars: { name: string; type: ASType | null; init: Expr | null; isConst: boolean }[] = [];
    for (const stmt of this.program.body) {
      if (stmt.kind === 'VarDecl') vars.push({ name: stmt.name, type: stmt.type, init: stmt.init, isConst: false });
      else if (stmt.kind === 'ConstDecl') vars.push({ name: stmt.name, type: stmt.type, init: stmt.init, isConst: true });
    }
    if (vars.length === 0) return;

    for (const v of vars) {
      const ctype = v.type !== null ? resolveType(v.type) : (v.init ? this.emitExpr(v.init).type : { kind: 'int' });
      this.moduleScope.set(v.name, ctype);
      const cn = this.moduleCName(v.name);
      if (v.isConst) {
        this.moduleConsts.add(v.name);
        const e = this.emitExpr(v.init!);
        this.line(`static ${this.constTypeName(ctype)} ${cn} = ${this.convert(e, ctype)};`);
      } else {
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

  private emitMain(): void {
    this.line('int main(void) {');
    this.indent++;
    this.pushScope();
    // Run runtime static-field initializers in class-declaration order (each in
    // its declaring class's static context, so protected members resolve).
    for (const si of this.staticFieldInits) {
      this.currentClass = si.cname;
      const init = this.convert(this.emitExpr(si.f.init!), si.f.type);
      this.line(`${si.cname}_${si.fname} = ${init};`);
      this.currentClass = null;
    }
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
        const e = this.emitExpr(stmt.init);
        const ctype = this.moduleScope.get(stmt.name)!;
        this.line(`${this.moduleCName(stmt.name)} = ${this.convert(e, ctype)};`);
      }
      return;
    }
    if (stmt.kind === 'ConstDecl' && this.moduleScope.has(stmt.name)) return;
    this.emitStmt(stmt);
  }

  // ---------- statements ----------

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'VarDecl': {
        if (stmt.init) this.sequenceValueExpr(stmt.init, true, true);
        const d = this.emitVarDecl(stmt.name, stmt.type, stmt.init);
        this.line(`${d};`);
        break;
      }
      case 'VarDecls': {
        for (const d of stmt.decls) {
          if (d.init) this.sequenceValueExpr(d.init, true, true);
          const e = this.emitVarDecl(d.name, d.type, d.init);
          this.line(`${e};`);
        }
        break;
      }
      case 'ConstDecl': {
        if (stmt.init) this.sequenceValueExpr(stmt.init, true, true);
        const ctype = stmt.type !== null ? resolveType(stmt.type) : this.emitExpr(stmt.init!).type;
        this.declareVar(stmt.name, ctype);
        const e = this.emitExpr(stmt.init!);
        this.line(`${this.constTypeName(ctype)} ${stmt.name} = ${this.convert(e, ctype)};`);
        break;
      }
      case 'ExprStmt': {
        this.sequenceValueExpr(stmt.expr, false, true);
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
        const it = this.emitExpr(stmt.iterable);
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
        if (isDict) {
          // Dictionary keys are object references; a declared loop var is boxed
          // (`var key:* in dict`), an existing `Object` var receives the pointer.
          if (stmt.declares) this.declareVar(stmt.varName, { kind: 'any' });
          this.line(`for (int ${idx} = 0; ${idx} < (${it.code})->length; ${idx}++) {`);
          this.indent++;
          this.line(`${stmt.declares ? `as_value ${stmt.varName} = ` : `${stmt.varName} = `}${stmt.declares ? 'as_v_obj' : ''}((${it.code})->keys[${idx}]);`);
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        } else if (isRecord) {
          const objCode = it.type.kind === 'record'
            ? it.code
            : `((as_object*)${it.type.kind === 'any' ? `as_v_obj_val(${it.code})` : it.code})`;
          if (stmt.declares) this.declareVar(stmt.varName, { kind: 'string' });
          this.line(`for (int ${idx} = 0; ${idx} < (${objCode})->length; ${idx}++) {`);
          this.indent++;
          this.line(`${stmt.declares ? `char* ${stmt.varName} = ` : `${stmt.varName} = `}(${objCode})->keys[${idx}];`);
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        } else {
          if (stmt.declares) this.declareVar(stmt.varName, { kind: 'int' });
          this.line(`for (int ${idx} = 0; ${idx} < (${it.code})->length; ${idx}++) {`);
          this.indent++;
          this.line(`${stmt.declares ? `int ${stmt.varName} = ` : `${stmt.varName} = `}${idx};`);
          this.emitStmt(stmt.body);
          this.indent--;
          this.line('}');
        }
        this.popScope();
        break;
      }
      case 'ForEachIn': {
        const arr = this.emitExpr(stmt.iterable);
        if (arr.type.kind !== 'array') {
          throw new CodegenError('for-each-in requires an Array');
        }
        const idx = this.tmpName('i');
        this.pushScope();
        this.line(`for (int ${idx} = 0; ${idx} < (${arr.code})->length; ${idx}++) {`);
        this.indent++;
        if (stmt.varType === null) {
          this.declareVar(stmt.varName, { kind: 'any' });
          this.line(`as_value ${stmt.varName} = as_array_get(${arr.code}, ${idx});`);
        } else {
          const elemType = resolveType(stmt.varType);
          this.declareVar(stmt.varName, elemType);
          const elem = { code: `as_array_get(${arr.code}, ${idx})`, type: { kind: 'any' } as CType };
          this.line(`${this.cTypeName(elemType)} ${stmt.varName} = ${this.convert(elem, elemType)};`);
        }
        this.emitStmt(stmt.body);
        this.indent--;
        this.line('}');
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
          this.line(`goto ${lbl.cName}__end;`);
        } else if (this.suppressBreak === 0) {
          this.line('break;');
        }
        break;
      }
      case 'Continue': {
        if (stmt.label) {
          const lbl = this.findLabel(stmt.label);
          if (!lbl) throw new CodegenError(`undefined label '${stmt.label}'`);
          this.line(`goto ${lbl.cName}__continue;`);
        } else {
          this.line('continue;');
        }
        break;
      }
      case 'Label': {
        const cName = this.tmpName('lbl');
        this.labels.push({ asName: stmt.name, cName });
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
          this.line(`return ${code};`);
        } else {
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
  private findLabel(name: string): { asName: string; cName: string } | null {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      if (this.labels[i].asName === name) return this.labels[i];
    }
    return null;
  }

  // Emit loop statements with an optional `continue` label placed at the end of
  // the loop body (where C loops naturally jump back to the condition/update).
  private emitWhile(stmt: Extract<Stmt, { kind: 'While' }>, continueLabel: string | null): void {
    const c = this.emitExpr(stmt.cond);
    this.line(`while (${this.condExpr(c)}) {`);
    this.indent++;
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    this.indent--;
    this.line('}');
  }

  private emitDoWhile(stmt: Extract<Stmt, { kind: 'DoWhile' }>, continueLabel: string | null): void {
    this.line('do {');
    this.indent++;
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    this.indent--;
    const c = this.emitExpr(stmt.cond);
    this.line(`} while (${this.condExpr(c)});`);
  }

  private emitFor(stmt: Extract<Stmt, { kind: 'For' }>, continueLabel: string | null): void {
    this.pushScope();
    let init = '';
    if (stmt.init) {
      if (stmt.init.kind === 'VarDecl') {
        init = this.emitVarDecl(stmt.init.name, stmt.init.type, stmt.init.init);
      } else if (stmt.init.kind === 'ExprStmt') {
        init = this.emitExpr(stmt.init.expr).code;
      }
    }
    const cond = stmt.cond ? this.condExpr(this.emitExpr(stmt.cond)) : '';
    const update = stmt.update ? this.emitExpr(stmt.update).code : '';
    this.line(`for (${init}; ${cond}; ${update}) {`);
    this.indent++;
    this.emitStmt(stmt.body);
    if (continueLabel) this.line(`${continueLabel}: ;`);
    this.indent--;
    this.line('}');
    this.popScope();
  }

  // `throw expr` — AS3 throws an Error (or any value). We normalize everything
  // to an Error object: Error values pass through, strings are wrapped, and
  // other primitives are stringified first.
  private emitThrow(stmt: Extract<Stmt, { kind: 'Throw' }>): void {
    const e = this.emitExpr(stmt.value);
    // Any Error subclass (Error/TypeError/RangeError/ArgumentError) passes through
    // as-is; other values are wrapped into a fresh Error.
    if (e.type.kind === 'object' && this.symbols.isSubclassOf(e.type.className, 'Error')) {
      this.line(`as_throw(${e.code});`);
    } else if (e.type.kind === 'string') {
      this.line(`as_throw(Error_new(${e.code}));`);
    } else if (e.type.kind === 'object') {
      this.line(`as_throw(Error_new(as_obj_to_str((void*)(${e.code}))));`);
    } else {
      this.line(`as_throw(Error_new(${this.toStringExpr(e)}));`);
    }
  }

  // `try { ... } catch (e:Error) { ... } finally { ... }` — setjmp/longjmp-based.
  // The handler is pushed onto a global stack so nested try blocks and throws
  // inside catch/finally re-enter the correct outer handler. `finally` always
  // runs (on normal completion and on a caught/uncaught throw); if the exception
  // is still pending afterward (a finally-only try, or a throw inside finally),
  // it is rethrown to the outer handler.
  private emitTry(stmt: Extract<Stmt, { kind: 'Try' }>): void {
    const env = this.tmpName('env');
    const ret = this.tmpName('ex');
    this.line('{');
    this.indent++;
    this.line(`jmp_buf ${env};`);
    this.line(`int ${ret} = setjmp(${env});`);
    this.line(`if (${ret} == 0) {`);
    this.indent++;
    this.line(`as_jmp_stack[as_jmp_depth++] = &${env};`);
    this.emitBlockBody(stmt.tryBody);
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
      this.line(`${catchTypeName}* ${stmt.catchVar} = (${catchTypeName}*)as_exception;`);
      this.line('as_exception = NULL;');
      this.emitBlockBody(stmt.catchBody);
      this.indent--;
      this.line('}');
      this.popScope();
      this.indent--;
      this.line('}');
    }
    if (stmt.finallyBody) {
      this.emitBlockBody(stmt.finallyBody);
    }
    this.line(`if (${ret} != 0 && as_exception != NULL) as_throw(as_exception);`);
    this.indent--;
    this.line('}');
  }

  // Integer switch maps to a native C switch (supports fall-through and break).
  private emitSwitchIntegral(stmt: Extract<Stmt, { kind: 'Switch' }>, disc: { code: string; type: CType }): void {
    this.line(`switch (${disc.code}) {`);
    this.indent++;
    for (const c of stmt.cases) {
      if (c.test === null) {
        this.line('default:');
      } else {
        const t = this.emitExpr(c.test);
        this.line(`case ${t.code}:`);
      }
      this.indent++;
      for (const s of c.body) this.emitStmt(s);
      this.indent--;
    }
    this.indent--;
    this.line('}');
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
    let ctype: CType;
    if (type !== null) {
      ctype = resolveType(type);
    } else if (init) {
      ctype = this.emitExpr(init).type;
    } else {
      ctype = { kind: 'int' };
    }
    this.declareVar(name, ctype);
    if (init) {
      const e = this.emitExpr(init);
      const code = this.convert(e, ctype);
      return `${this.cTypeName(ctype)} ${name} = ${code}`;
    }
    return `${this.cTypeName(ctype)} ${name} = ${this.defaultInit(ctype)}`;
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
  private sequenceValueExpr(e: Expr, valueCtx: boolean, guaranteed: boolean): void {
    switch (e.kind) {
      case 'Assign': {
        if (valueCtx && guaranteed && e.target.kind === 'Var') {
          // The whole assignment is emitted as one standalone statement (which is
          // UB-free on its own); its RHS side effects are captured there, so we do
          // not recurse into the value.
          const asg = this.emitAssign(e);
          const tmp = this.tmpName('seq');
          this.line(`${this.cTypeName(asg.type)} ${tmp} = ${asg.code};`);
          this.hoistedAssigns.set(e, { tmp, type: asg.type });
          return;
        }
        this.sequenceValueExpr(e.target, false, guaranteed);
        this.sequenceValueExpr(e.value, true, guaranteed);
        return;
      }
      case 'Update': {
        if (valueCtx && guaranteed && e.target.kind === 'Var') {
          const upd = this.emitExpr(e);
          const tmp = this.tmpName('seq');
          this.line(`${this.cTypeName(upd.type)} ${tmp} = ${upd.code};`);
          this.hoistedAssigns.set(e, { tmp, type: upd.type });
          return;
        }
        this.sequenceValueExpr(e.target, false, guaranteed);
        return;
      }
      case 'Binary': {
        this.sequenceValueExpr(e.left, true, guaranteed);
        const g2 = (e.op === '&&' || e.op === '||') ? false : guaranteed;
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
        this.sequenceValueExpr(e.callee, true, guaranteed);
        for (const a of e.args) this.sequenceValueExpr(a, true, guaranteed);
        return;
      }
      case 'SuperMethod': {
        for (const a of e.args) this.sequenceValueExpr(a, true, guaranteed);
        return;
      }
      case 'Member': {
        this.sequenceValueExpr(e.object, true, guaranteed);
        return;
      }
      case 'Is':
      case 'As': {
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
        const o = this.emitExpr(expr.target);
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

      case 'Assign':
        return this.emitAssign(expr);

      case 'Call':
        return this.emitCall(expr);

      case 'Member':
        return this.emitMember(expr);

      case 'SuperMethod':
        return this.emitSuperMethod(expr);

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
        if (captures.length === 0) {
          return { code: `as_fn_make(${name}__call, NULL)`, type: { kind: 'function' } };
        }
        // Capture each free variable's current value into a heap-allocated env.
        const vals = captures.map((c) => this.emitVar(c.name).code).join(', ');
        return { code: `as_fn_make(${name}__call, ${name}_env_make(${vals}))`, type: { kind: 'function' } };
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
      return { code: 'this', type: { kind: 'object', className: this.currentClass } };
    }
    // AS3 global `undefined` constant (boxed as_value with a dedicated tag).
    if (name === 'undefined') {
      return { code: 'as_v_undefined()', type: { kind: 'any' } };
    }
    // Captured variable inside a closure: read through the environment pointer.
    if (this.currentClosureCaptures?.has(name)) {
      return { code: `env->${name}`, type: this.currentClosureCaptures.get(name)! };
    }
    // Local (block-scoped) variables shadow class members and module globals.
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const lt = this.scopes[i].get(name);
      if (lt !== undefined) return { code: name, type: lt };
    }
    // Unqualified identifier inside a method falls back to a field (this->name),
    // a static field (Class_name), or a getter.
    if (this.currentClass) {
      const cinfo = this.symbols.getClass(this.currentClass);
      const f = cinfo?.fields.get(name);
      if (f) {
        if (!this.symbols.isAccessible(f.visibility, f.owner, this.currentClass)) {
          throw new CodegenError(`field '${name}' is not accessible here`);
        }
        return { code: `this->${name}`, type: f.type };
      }
      const sf = cinfo?.staticFields.get(name);
      if (sf) {
        if (!this.symbols.isAccessible(sf.visibility, sf.owner, this.currentClass)) {
          throw new CodegenError(`static field '${name}' is not accessible here`);
        }
        return { code: `${sf.owner}_${name}`, type: sf.type };
      }
      const g = cinfo?.getters.get(name);
      if (g) {
        if (!this.symbols.isAccessible(g.visibility, g.owner, this.currentClass)) {
          throw new CodegenError(`getter '${name}' is not accessible here`);
        }
        return { code: `${g.owner}_get_${name}(this)`, type: g.returnType };
      }
      // A method referenced by its bare name is `this.method` used as a value
      // (e.g. passed as a listener). Bind the receiver in a thunk.
      if (!this.currentIsStatic) {
        const m = cinfo?.methods.get(name);
        if (m) {
          if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
            throw new CodegenError(`method '${name}' is not accessible here`);
          }
          return { code: `as_fn_make(${this.currentClass}_${name}__bound, (void*)this)`, type: { kind: 'function' } };
        }
      } else {
        // In a static context, a bare identifier naming a static method is
        // `Class.method` used as a value (no receiver).
        const sm = cinfo?.staticMethods.get(name);
        if (sm) {
          if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
            throw new CodegenError(`static method '${name}' is not accessible here`);
          }
          return { code: `as_fn_make(${sm.owner}_${name}__call, NULL)`, type: { kind: 'function' } };
        }
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
    if (func) return { code: `as_fn_make(${name}__call, NULL)`, type: { kind: 'function' } };
    throw new CodegenError(`undefined variable '${name}'`);
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
      case 'SuperMethod': return e.args.some((a) => this.usesArgumentsExpr(a));
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
    const items = params.map((p) => this.boxExpr({ code: p.name, type: resolveType(p.type) }));
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
      // dynamic operand: unbox to Number and add.
      if (l.type.kind === 'any' || r.type.kind === 'any') {
        return { code: `(${this.toNumberExpr(l)} + ${this.toNumberExpr(r)})`, type: { kind: 'number' } };
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
      if (l.type.kind === 'int' && r.type.kind === 'int') return { code: `(${l.code} % ${r.code})`, type: { kind: 'int' } };
      if (l.type.kind === 'uint' && r.type.kind === 'uint') return { code: `(${l.code} % ${r.code})`, type: { kind: 'uint' } };
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
      const lb = l.type.kind === 'any' ? `as_v_truthy(${l.code})` : l.code;
      const rb = r.type.kind === 'any' ? `as_v_truthy(${r.code})` : r.code;
      return { code: `(${lb} ${op} ${rb})`, type: { kind: 'bool' } };
    }

    // comparison
    if (op === '==' || op === '!=') {
      if (l.type.kind === 'any' || r.type.kind === 'any') {
        const cmp = `as_v_eq(${this.boxExpr(l)}, ${this.boxExpr(r)})`;
        return { code: op === '!=' ? `(!${cmp})` : cmp, type: { kind: 'bool' } };
      }
      const code = this.emitEquality(l, r, op);
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
      return `${neg}(strcmp(${ls}, ${rs}) == 0)`;
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
      case 'void': return '""';
    }
  }

  private emitAssign(expr: Extract<Expr, { kind: 'Assign' }>): { code: string; type: CType; discard?: boolean } {
    const hoisted = this.hoistedAssigns.get(expr);
    if (hoisted) return { code: hoisted.tmp, type: hoisted.type };
    const target = expr.target;

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
      if (obj.type.kind === 'object' && obj.type.className === 'Object') {
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
            const v = this.emitExpr(expr.value);
            const code = this.convert(v, sf.type);
            return { code: `(${sf.owner}_${target.property} = ${code})`, type: sf.type };
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
      if (obj.type.kind === 'record' || obj.type.kind === 'any') {
        const objCode = obj.type.kind === 'record' ? obj.code : `((as_object*)as_v_obj_val(${obj.code}))`;
        const key = `"${this.escapeCString(target.property)}"`;
        if (expr.op === '=') {
          const v = this.emitExpr(expr.value);
          return { code: `as_object_set(${objCode}, ${key}, ${this.boxExpr(v)})`, type: { kind: 'any' } };
        }
        const op = COMPOUND_BASE[expr.op];
        const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
        return { code: `as_object_set(${objCode}, ${key}, ${this.boxExpr(combined)})`, type: { kind: 'any' } };
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
          const v = this.emitExpr(expr.value);
          const paramType = resolveType(s.params[0].type);
          const code = this.convert(v, paramType);
          return { code: `${s.owner}_set_${target.property}(${obj.code}, ${code})`, type: { kind: 'void' } };
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

    const t = this.emitExpr(target);
    const v = this.emitExpr(expr.value);

    if (expr.op === '=') {
      const code = this.convert(v, t.type);
      // Direct field write of a pointer/boxed slot (o.field = v) needs a write
      // barrier during incremental marking (GC-4): a BLACK object must not gain
      // a direct WHITE reference unobserved. Local/global variable slots are
      // covered by roots at the safe point and need no barrier.
      if (target.kind === 'Member') {
        const store = this.gcWriteAssign(t.code, t.type, code);
        if (store) return { code: store, type: t.type, discard: true };
      }
      return { code: `(${t.code} = ${code})`, type: t.type };
    }

    // compound assignment: target = target OP value
    const op = COMPOUND_BASE[expr.op];
    const combined = this.emitBinary({ kind: 'Binary', op, left: target, right: expr.value });
    const code = this.convert(combined, t.type);
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
            return { code: `${sm.owner}_${callee.property}(${args})`, type: sm.returnType };
          }
          throw new CodegenError(`undefined static method '${callee.property}' on class '${callee.object.name}'`);
        }
      }
      const obj = this.emitExpr(callee.object);
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
      if (obj.type.kind === 'interface') {
        const intf = this.symbols.interfaces.get(obj.type.name)!;
        const m = intf.methods.get(callee.property);
        if (!m) throw new CodegenError(`undefined method '${callee.property}' on interface '${obj.type.name}'`);
        const args = this.emitArgs(m.params, expr.args);
        const callArgs = args ? ', ' + args : '';
        return { code: `(${obj.code}.vt->${cIdent(callee.property)}(${obj.code}.obj${callArgs}))`, type: m.returnType };
      }
      if (obj.type.kind !== 'object') {
        throw new CodegenError(`cannot call method '${callee.property}' on non-object type`);
      }
      const cinfo = this.symbols.getClass(obj.type.className);
      const m = cinfo?.methods.get(callee.property);
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
        code: `(${obj.code}->vtable->${cIdent(callee.property)}(${obj.code}${callArgs}))`,
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
            throw new CodegenError(`method '${callee.name}' is not accessible here`);
          }
          const args = this.emitArgs(m.params, expr.args);
          const callArgs = args ? ', ' + args : '';
          return { code: `(this->vtable->${cIdent(callee.name)}(this${callArgs}))`, type: m.returnType };
        }
      }
      const builtin = this.emitGlobalCall(callee.name, expr.args);
      if (builtin) return builtin;
      // AS3 cast syntax `Type(expr)`: a single-argument call whose callee names
      // a known user class/interface is a checked cast (semantically `expr as
      // Type`). Guard with hasClass so plain free functions are never misread.
      if (expr.args.length === 1) {
        const ct = resolveType(callee.name);
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
    // desktopDirectory / documentsDirectory / userDirectory), resolved at runtime
    // from the process environment rather than a compile-time path.
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
          return { code: `${sf.owner}_${expr.property}`, type: sf.type };
        }
        // Static method referenced as a Function value (`var f:Function = Foo.bar`).
        const sm = cinfo.staticMethods.get(expr.property);
        if (sm) {
          if (!this.symbols.isAccessible(sm.visibility, sm.owner, this.currentClass)) {
            throw new CodegenError(`static method '${expr.property}' is not accessible here`);
          }
          return { code: `as_fn_make(${sm.owner}_${expr.property}__call, NULL)`, type: { kind: 'function' } };
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
    if (obj.type.kind === 'record') {
      return { code: `as_object_get(${obj.code}, "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    if (obj.type.kind === 'any' && expr.property === 'length') {
      // a dynamically-typed array/string length (e.g. parsed.tags.length).
      return { code: `as_any_length(${obj.code})`, type: { kind: 'int' } };
    }
    if (obj.type.kind === 'any') {
      // an `any` that is an object at runtime (e.g. a nested object literal).
      return { code: `as_object_get(((as_object*)as_v_obj_val(${obj.code})), "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    // AS3's root `Object` is dynamic: `o.name` on an Object-typed value is a
    // runtime key lookup (JSON.parse results, generic records, ...).
    if (obj.type.kind === 'object' && (obj.type as { className: string }).className === 'Object') {
      return { code: `as_object_get(((as_object*)${obj.code}), "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    if (obj.type.kind !== 'object') {
      throw new CodegenError(`cannot access property '${expr.property}' on non-object type`);
    }
    const cinfo = this.symbols.getClass(obj.type.className);
    const f = cinfo?.fields.get(expr.property);
    if (f) {
      if (!this.symbols.isAccessible(f.visibility, f.owner, this.currentClass)) {
        throw new CodegenError(`field '${expr.property}' is not accessible here`);
      }
      return { code: `(${obj.code}->${cIdent(expr.property)})`, type: f.type };
    }
    // getter accessor: obj.prop -> ClassName_get_prop(obj)
    const g = cinfo?.getters.get(expr.property);
    if (g) {
      if (!this.symbols.isAccessible(g.visibility, g.owner, this.currentClass)) {
        throw new CodegenError(`getter '${expr.property}' is not accessible here`);
      }
      return { code: `${g.owner}_get_${expr.property}(${obj.code})`, type: g.returnType };
    }
    // A method referenced as a Function value (`this.onDone`, `obj.callback`).
    // Bind the receiver; the thunk dispatches through the runtime object's vtable
    // so overrides resolve on the actual class.
    const m = cinfo?.methods.get(expr.property);
    if (m) {
      if (!this.symbols.isAccessible(m.visibility, m.owner, this.currentClass)) {
        throw new CodegenError(`method '${expr.property}' is not accessible here`);
      }
      return { code: `as_fn_make(${obj.type.className}_${expr.property}__bound, (void*)(${obj.code}))`, type: { kind: 'function' } };
    }
    // Dynamic class (AS3 `dynamic class`): an undeclared member read resolves at
    // runtime through the slot table (falls back to the `_dyn` record).
    if (cinfo?.isDynamic) {
      return { code: `as_dyn_get((void*)(${obj.code}), "${this.escapeCString(expr.property)}")`, type: { kind: 'any' } };
    }
    throw new CodegenError(`undefined field '${expr.property}' on class '${obj.type.className}'`);
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
        if (args.length !== 1) throw new CodegenError('Vector.push expects 1 argument');
        const a = this.convert(this.emitExpr(args[0]), elem);
        return { code: `as_vector_${key}_push(${v}, ${a})`, type: { kind: 'int' } };
      }
      case 'pop':
        return { code: `as_vector_${key}_pop(${v})`, type: elem };
      case 'indexOf': {
        if (args.length !== 1) throw new CodegenError('Vector.indexOf expects 1 argument');
        const e = this.convert(this.emitExpr(args[0]), elem);
        return { code: `as_vector_${key}_indexOf(${v}, ${e})`, type: { kind: 'int' } };
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
        if (args.length !== 1) throw new CodegenError('Vector.concat expects 1 argument');
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
        const cb = args.length >= 1 ? this.emitExpr(args[0]) : null;
        if (cb && cb.type.kind !== 'function') throw new CodegenError('Vector.sort expects a Function argument');
        return { code: `as_vector_${key}_sort(${v}, ${cb ? cb.code : 'NULL'})`, type: obj.type };
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
        if (args.length !== 1) throw new CodegenError('push expects 1 argument');
        const v = this.boxExpr(this.emitExpr(args[0]));
        return { code: `as_array_push(${a}, ${v})`, type: { kind: 'int' } };
      }
      case 'pop':
        return { code: `as_array_pop(${a})`, type: { kind: 'any' } };
      case 'shift':
        return { code: `as_array_shift(${a})`, type: { kind: 'any' } };
      case 'unshift': {
        if (args.length !== 1) throw new CodegenError('unshift expects 1 argument');
        const v = this.boxExpr(this.emitExpr(args[0]));
        return { code: `as_array_unshift(${a}, ${v})`, type: { kind: 'int' } };
      }
      case 'indexOf': {
        if (args.length !== 1) throw new CodegenError('indexOf expects 1 argument');
        const v = this.boxExpr(this.emitExpr(args[0]));
        return { code: `as_array_indexOf(${a}, ${v})`, type: { kind: 'int' } };
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
      case 'indexOf': return { code: `as_str_indexOf(${s}, ${argStr(0)})`, type: { kind: 'int' } };
      case 'lastIndexOf': return { code: `as_str_lastIndexOf(${s}, ${argStr(0)})`, type: { kind: 'int' } };
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
        throw new CodegenError('String.match requires a RegExp argument');
      }
      case 'search': {
        const arg = this.emitExpr(args[0]);
        if (arg.type.kind === 'object' && arg.type.className === 'RegExp') {
          return { code: `as_str_search_regex(${s}, ${arg.code}->compiled)`, type: { kind: 'int' } };
        }
        throw new CodegenError('String.search requires a RegExp argument');
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
      // static type is `*`. Resolved at runtime through the vtable method tables.
      default: {
        const items = args.map((a) => this.boxExpr(this.emitExpr(a)));
        const n = args.length;
        const arr = n > 0 ? `(as_value[${n}]){ ${items.join(', ')} }` : 'NULL';
        return { code: `as_dyn_call(as_v_obj_val(${obj.code}), "${this.escapeCString(method)}", ${arr}, ${n})`, type: { kind: 'any' } };
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
  // desktop-native value. `version` is the injected AS-AOT version (package.json
  // read at codegen time); os/cpuArchitecture use #ifdef; screenResolution* are
  // 0 in headless builds (no SDL2 window backend) and the real display otherwise.
  private emitCapabilitiesConst(name: string): { code: string; type: CType } {
    switch (name) {
      case 'version': return { code: `"AS-AOT ${this.escapeCString(this.asAotVersion)}"`, type: { kind: 'string' } };
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
      // flash.utils.setTimeout(closure, delay, ...): schedule a Function call after
      // 'delay' ms and return a uint timer id (0 when the closure is null). The
      // closure is a boxed function value; unboxed to as_fn for the runtime helper.
      case 'setTimeout': {
        const fne = this.emitExpr(args[0]);
        const fn = fne.type.kind === 'function' ? fne.code : `((as_fn)as_v_obj_val(${this.boxExpr(fne)}))`;
        const delay = this.toNumberExpr(this.emitExpr(args[1]));
        return { code: `as_set_timeout(${fn}, ${delay})`, type: { kind: 'uint' } };
      }
      // flash.utils.clearTimeout(id): cancel a scheduled timer (no-op if already
      // fired or unknown).
      case 'clearTimeout': {
        return { code: `as_clear_timeout(${this.emitExpr(args[0]).code})`, type: { kind: 'void' } };
      }
      // tickTimers(): headless test hook — pumps the timer queue once (as_timer_tick).
      // In window builds timers are driven by the frame loop; offscreen examples call
      // this to advance flash.utils.Timer / setTimeout deterministically.
      case 'tickTimers': return { code: 'as_timer_tick()', type: { kind: 'void' } };
      // tickMovieClips(): headless test hook — advances every playing MovieClip by
      // one frame (as_mc_tick). In window builds clips are driven by the frame loop.
      case 'tickMovieClips': return { code: 'as_mc_tick()', type: { kind: 'void' } };
      case 'String': return { code: this.toStringExpr(e0!), type: { kind: 'string' } };
      case 'Number': {
        if (e0!.type.kind === 'string') return { code: `atof(${e0!.code})`, type: { kind: 'number' } };
        return { code: this.toNumberExpr(e0!), type: { kind: 'number' } };
      }
      case 'Boolean': {
        if (e0!.type.kind === 'string') {
          return { code: `(${e0!.code} != NULL && strlen(${e0!.code}) > 0)`, type: { kind: 'bool' } };
        }
        if (e0!.type.kind === 'bool') return { code: e0!.code, type: { kind: 'bool' } };
        return { code: `((${this.toNumberExpr(e0!)}) != 0.0)`, type: { kind: 'bool' } };
      }
      case 'int': {
        if (e0!.type.kind === 'string') return { code: `atoi(${e0!.code})`, type: { kind: 'int' } };
        return { code: `((int)(${this.toNumberExpr(e0!)}))`, type: { kind: 'int' } };
      }
      case 'uint': {
        if (e0!.type.kind === 'string') return { code: `((unsigned int)atoi(${e0!.code}))`, type: { kind: 'uint' } };
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

  // `obj is Type`: runtime subtype check via the vtable `super` chain. For
  // interfaces we use a compile-time check against the static type's implements list.
  // AS3 primitive type names that participate in `is`/`as` runtime checks.
  private isScalarTypeName(name: string): boolean {
    return name === 'int' || name === 'uint' || name === 'Number' || name === 'Boolean' || name === 'String';
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
      return { code: 'false', type: { kind: 'bool' } };
    }
    // Object root: every class instance is an Object.
    if (expr.typeName === 'Object') {
      if (o.type.kind === 'object' || o.type.kind === 'interface') return { code: 'true', type: { kind: 'bool' } };
      if (o.type.kind === 'any') return { code: `as_v_is_object(${o.code})`, type: { kind: 'bool' } };
      return { code: 'false', type: { kind: 'bool' } };
    }
    if (this.symbols.hasInterface(expr.typeName)) {
      if (o.type.kind === 'object') {
        const cinfo = this.symbols.getClass(o.type.className);
        const impl = cinfo ? cinfo.implements.includes(expr.typeName) : false;
        return { code: impl ? 'true' : 'false', type: { kind: 'bool' } };
      }
      if (o.type.kind === 'interface') {
        return { code: o.type.name === expr.typeName ? 'true' : 'false', type: { kind: 'bool' } };
      }
      return { code: 'false', type: { kind: 'bool' } };
    }
    // Resolve a short class name (e.g. `TweenCore` in package com.greensock.core)
    // to its FQN before the vtable reference and runtime subtype check.
    const rt = resolveType(expr.typeName as ASType);
    const fqn = rt.kind === 'object' ? rt.className : expr.typeName;
    if (!this.symbols.hasClass(fqn)) throw new CodegenError(`unknown type '${expr.typeName}'`);
    if (o.type.kind === 'any') {
      return { code: `as_v_is_inst(${o.code}, &${fqn}_vt)`, type: { kind: 'bool' } };
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
      case 'function': return lit('function');
      case 'object': case 'interface': case 'array': case 'vector':
      case 'record': case 'regexp': case 'class': return lit('object');
      case 'null': return lit('object'); // AS3: typeof null == "object"
      case 'any': return { code: `as_v_typeof(${o.code})`, type: { kind: 'string' } };
      case 'void': return lit('undefined');
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
      const keyRef = key.type.kind === 'object' || key.type.kind === 'interface'
        ? `(void*)(${key.code})`
        : `(void*)as_v_obj_val(${this.boxExpr(key)})`;
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
      const keyRef = key.type.kind === 'object' || key.type.kind === 'interface'
        ? `(void*)(${key.code})`
        : `(void*)as_v_obj_val(${this.boxExpr(key)})`;
      return { code: `as_dict_has(${obj.code}, ${keyRef})`, type: { kind: 'bool' } };
    }
    const keyStr = key.type.kind === 'string' ? key.code : this.toStringExpr(key);
    let objCode: string;
    if (obj.type.kind === 'record') {
      objCode = obj.code;
    } else if (obj.type.kind === 'any') {
      objCode = `((as_object*)as_v_obj_val(${obj.code}))`;
    } else if (obj.type.kind === 'object' && obj.type.className === 'Object') {
      objCode = `((as_object*)${obj.code})`;
    } else {
      throw new CodegenError(`'in' requires a dynamic Object, found ${obj.type.kind}`);
    }
    return { code: `as_object_has(${objCode}, ${keyStr})`, type: { kind: 'bool' } };
  }

  private emitAs(expr: Extract<Expr, { kind: 'As' }>): { code: string; type: CType } {
    const o = this.emitExpr(expr.obj);
    // Primitive scalar `as` casts.
    if (this.isScalarTypeName(expr.typeName)) {
      const targetType = resolveType(expr.typeName as ASType);
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
      return { code: this.defaultInit(targetType), type: targetType };
    }
    // Object root: object/interface/null cast to Object*; scalars -> NULL.
    if (expr.typeName === 'Object') {
      if (o.type.kind === 'object' || o.type.kind === 'interface') {
        return { code: `(void*)(${o.code})`, type: { kind: 'object', className: 'Object' } };
      }
      return { code: 'NULL', type: { kind: 'object', className: 'Object' } };
    }
    // `x as Array`: a dynamically-typed array (or already-Array) is unboxed to
    // as_array*; any other value yields NULL.
    if (expr.typeName === 'Array') {
      if (o.type.kind === 'any') return { code: `((as_array*)as_v_obj_val(${o.code}))`, type: { kind: 'array' } };
      if (o.type.kind === 'array') return { code: o.code, type: { kind: 'array' } };
      return { code: 'NULL', type: { kind: 'array' } };
    }
    // `x as Class`: unbox a dynamically-held class reference; any other value
    // yields NULL. This enables `new (plugins[p] as Class)()`.
    if (expr.typeName === 'Class') {
      if (o.type.kind === 'any') return { code: `as_v_as_class(${o.code})`, type: { kind: 'class' } };
      if (o.type.kind === 'class') return { code: o.code, type: { kind: 'class' } };
      return { code: 'NULL', type: { kind: 'class' } };
    }
    if (this.symbols.hasInterface(expr.typeName)) {
      if (o.type.kind === 'object') {
        const cinfo = this.symbols.getClass(o.type.className);
        const impl = cinfo ? cinfo.implements.includes(expr.typeName) : false;
        if (!impl) return { code: '{ NULL, NULL }', type: { kind: 'interface', name: expr.typeName } };
        return { code: `(${expr.typeName}){ (void*)(${o.code}), &${o.type.className}_${expr.typeName}_vt }`, type: { kind: 'interface', name: expr.typeName } };
      }
      if (o.type.kind === 'interface') {
        const code = o.type.name === expr.typeName ? o.code : '{ NULL, NULL }';
        return { code, type: { kind: 'interface', name: expr.typeName } };
      }
      return { code: '{ NULL, NULL }', type: { kind: 'interface', name: expr.typeName } };
    }
    const rt = resolveType(expr.typeName as ASType);
    const fqn = rt.kind === 'object' ? rt.className : expr.typeName;
    if (!this.symbols.hasClass(fqn)) throw new CodegenError(`unknown type '${expr.typeName}'`);
    if (o.type.kind !== 'object' && o.type.kind !== 'null') {
      throw new CodegenError(`'as' on non-object type is not supported`);
    }
    const code = `(as_is(${o.code}, &${fqn}_vt) ? ((${fqn}*)(${o.code})) : NULL)`;
    return { code, type: { kind: 'object', className: fqn } };
  }

  private emitNew(expr: Extract<Expr, { kind: 'New' }>): { code: string; type: CType } {
    if (expr.className.startsWith('Vector.<')) {
      const vt = resolveType(expr.className);
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
    const vt = resolveType(expr.className);
    if (vt.kind !== 'object') throw new CodegenError(`unknown class '${expr.className}'`);
    const cname = vt.className;
    const cinfo = this.symbols.getClass(cname);
    if (!cinfo) throw new CodegenError(`unknown class '${cname}'`);
    const args = this.emitArgs(cinfo.constructor.params, expr.args);
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
    return { code: `as_v_obj((${c.code})->factory())`, type: { kind: 'any' } };
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
        return { code: `Date_new_ms(Date_parse(${e.code}))`, type: t };
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
    const vt = resolveType(`Vector.<${expr.elem}>`);
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
    const obj = this.emitExpr(expr.object);
    if (obj.type.kind === 'vector') {
      const idx = this.convert(this.emitExpr(expr.index), { kind: 'int' });
      return { code: `as_vector_${this.vectorCName(obj.type.elem)}_get(${obj.code}, ${idx})`, type: obj.type.elem };
    }
    if (obj.type.kind === 'array') {
      const idx = this.convert(this.emitExpr(expr.index), { kind: 'int' });
      return { code: `as_array_get(${obj.code}, ${idx})`, type: { kind: 'any' } };
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
    // AS3 root Object is dynamic: obj[key] may be a record slot OR a reflectable
    // field of a real class instance. Route through the runtime reflection helper.
    if (obj.type.kind === 'object' && obj.type.className === 'Object') {
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

  // Dictionary keys are object references; the boxed form recovers the raw ptr.
  private dictKeyRef(key: { code: string; type: CType }): string {
    switch (key.type.kind) {
      case 'any': return `as_v_obj_val(${key.code})`;
      case 'interface': return `(void*)(${key.code}.obj)`;
      default: return `(void*)(${key.code})`;
    }
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
  // values are tested for AS3 truthiness; all other types are already bool/int.
  private condExpr(e: { code: string; type: CType }): string {
    return e.type.kind === 'any' ? `as_v_truthy(${e.code})` : e.code;
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
      case 'object': return `as_v_obj((void*)(${e.code}))`;
      case 'interface': return `as_v_obj(${e.code}.obj)`;
      case 'function': return `as_v_fn((void*)(${e.code}))`;
      case 'class': return `as_v_obj((void*)(${e.code}))`;
      case 'dict': return `as_v_obj((void*)(${e.code}))`;
      case 'null': return 'as_v_null()';
      case 'void': return 'as_v_null()';
    }
  }

  // Unbox a dynamically-typed (`any`) expression to a concrete target type.
  private unboxAny(e: { code: string; type: CType }, target: CType): string {
    switch (target.kind) {
      case 'int': return `as_v_int_val(${e.code})`;
      case 'uint': return `as_v_uint_val(${e.code})`;
      case 'number': return `as_v_num_val(${e.code})`;
      case 'bool': return `as_v_bool_val(${e.code})`;
      case 'string': return `as_v_str_val(${e.code})`;
      case 'array': return `((as_array*)as_v_obj_val(${e.code}))`;
      case 'vector': {
        const ve = target as { elem: CType };
        return `((as_vector_${this.vectorCName(ve.elem)}*)as_v_obj_val(${e.code}))`;
      }
      case 'record': return `((as_object*)as_v_obj_val(${e.code}))`;
      case 'object': return `((${(target as { className: string }).className}*)as_v_obj_val(${e.code}))`;
      case 'interface': {
        const iname = (target as { name: string }).name;
        return `(${iname}){ (void*)as_v_obj_val(${e.code}), (${iname}_vtable*)as_iface_lookup(as_v_obj_val(${e.code}), "${iname}") }`;
      }
      case 'function': return `((as_fn)as_v_obj_val(${e.code}))`;
      case 'class': return `((as_class*)as_v_obj_val(${e.code}))`;
      case 'dict': return `((as_dict*)as_v_obj_val(${e.code}))`;
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
      default: return `((int)(${e.code}))`;
    }
  }

  // Convert a value to a 32-bit unsigned int for the unsigned shift `>>>`.
  private toUint32Expr(e: { code: string; type: CType }): string {
    switch (e.type.kind) {
      case 'uint': return e.code;
      case 'int': return `((unsigned int)(${e.code}))`;
      case 'any': return `as_v_uint_val(${e.code})`;
      default: return `((unsigned int)(${e.code}))`;
    }
  }

  // Convert a value expression to the target type where a C cast is required.
  private isRefType(t: CType): boolean {
    return t.kind === 'string' || t.kind === 'object' || t.kind === 'array' || t.kind === 'vector' || t.kind === 'record' || t.kind === 'interface' || t.kind === 'function' || t.kind === 'regexp';
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
    if (target.kind === 'string') return this.toStringExpr(e);
    // Reference types cannot implicitly convert to numeric/bool scalars in AS3.
    // This guards `var x; x = "hello";` (x inferred as int) from silently
    // truncating a char*/pointer to an int — a semantic error, not a valid cast.
    if (this.isRefType(e.type) && (target.kind === 'int' || target.kind === 'uint' || target.kind === 'number' || target.kind === 'bool')) {
      throw new CodegenError(`cannot convert ${this.describeType(e.type)} to ${target.kind}`);
    }
    if (target.kind === 'int') return `((int)(${e.code}))`;
    if (target.kind === 'uint') return `((unsigned int)(${e.code}))`;
    if (target.kind === 'number') return `((double)(${e.code}))`;
    if (target.kind === 'bool') return `((bool)(${e.code}))`;
    if (target.kind === 'object') {
      if (e.type.kind === 'null') return 'NULL';
      return `((${(target as { className: string }).className}*)(${e.code}))`;
    }
    if (target.kind === 'interface') {
      if (e.type.kind === 'null') return '{ NULL, NULL }';
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
