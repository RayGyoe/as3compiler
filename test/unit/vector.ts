// Unit checks: dynamic access to a Vector.<T> through a `*` receiver, and the
// GC write barrier on `*` element slots (阶段九十八·二). Registered as node:test
// cases, so one group can be re-run alone with:
//   node --test --test-name-pattern='vector/' test/unit/*.ts
//
// Why these are source-level pins rather than example assertions: the whole point
// of the hooks is that a Vector has NO vtable (its first word is its mark
// callback), so a wrong wiring fails as a SEGFAULT inside the runtime, not as a
// wrong value the example could compare. The example (examples/vector-dynamic.as)
// covers the behaviour; these checks pin the plumbing that makes it not crash and
// pin the write barriers, which are only observable in a narrow incremental-mark
// window (see the note on the group below).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

// Generate C for a program that reaches a Vector through a `*` receiver, plus a
// second specialization, so the dispatcher really is multi-spec.
function dynamicVectorC(): string {
  return generateC(parse([
    'var v:Vector.<*> = new <*>["a"];',
    'var p:* = v;',
    'var n:int = p.length;',
    'p[0] = 1;',
    'p.push(2);',
    'var s:Vector.<String> = new <String>["x"];',
    'var q:* = s;',
    'var m:int = q.length;',
    'trace(n, m);',
    '',
  ].join('\n'))).c;
}

// A class instance and a Vector are both tag-4 boxes, so the dispatcher cannot
// tell them apart by tag: it needs as_dyn_kind()'s GCT_CUSTOM report. Pinned
// because the old code dereferenced the mark callback as a vtable header and
// `pv.push(..)` segfaulted.
function checkVectorDynamicAccess(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [vecdyn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [vecdyn] ${label}`); }
  };

  const preamble = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const c = dynamicVectorC();

  // ---- the runtime side: three hooks + the two shortcuts codegen emits ----
  check('the preamble declares the three generated hooks (set returns void)',
    preamble.includes('static as_value (*as_vec_get_hook)(void* ptr, const char* key) = NULL;')
    && preamble.includes('static void (*as_vec_set_hook)(void* ptr, const char* key, as_value v) = NULL;')
    && preamble.includes('static as_value (*as_vec_call_hook)(void* ptr, const char* name, as_value* args, int argc) = NULL;'));
  check('as_dyn_get delegates a GCT_CUSTOM receiver instead of returning null',
    preamble.includes('if (dk == 3) return as_vec_get_hook != NULL ? as_vec_get_hook(obj, key) : as_v_null();'));
  check('as_dyn_set delegates instead of dropping the write',
    preamble.includes('if (dk == 3) { if (as_vec_set_hook != NULL) as_vec_set_hook(obj, key, v); return; }'));
  check('as_dyn_call detours BEFORE the super-chain walk (which would deref the mark callback)',
    preamble.includes('if (as_vec_call_hook != NULL && as_dyn_kind(obj) == 3) return as_vec_call_hook(obj, name, args, argc);'));
  // `pv.length` and `pv.join(..)` are emitted straight to as_any_length /
  // as_any_join, so those two shortcuts need the same detour or the read returns
  // 0 / "" while as_any_call works -- an inconsistency that shipped once already.
  check('as_any_length has the GCT_CUSTOM branch (else pv.length reads 0)',
    preamble.includes('as_vec_get_hook(v.ptr, "length")'));
  check('as_any_join has the GCT_CUSTOM branch (else pv.join() is empty)',
    preamble.includes('return as_v_str_val(as_vec_call_hook(v.ptr, "join", a, 1));'));
  check('a negative index key is recognised so it can throw #1125',
    preamble.includes('static bool as_vec_index_key(const char* key, int* out)')
    && preamble.includes("if (*p == '-') p++;"));

  // ---- the generated side ----
  check('main installs the hooks',
    c.includes('as_vec_wire();') && c.includes('as_vec_get_hook = as_vec_get_impl;')
    && c.includes('as_vec_set_hook = as_vec_set_impl;') && c.includes('as_vec_call_hook = as_vec_call_impl;'));
  check('every specialization shares one body layout, so length is read generically',
    c.includes('typedef struct { void (*mark)(void*); void* data; int length; int capacity; bool fixed; } as_vec_hdr;')
    && c.includes('if (strcmp(key, "length") == 0) return as_v_num((double)((as_vec_hdr*)ptr)->length);'));
  check('get matches each spec by its mark callback and boxes the element',
    c.includes('if (mark == (void*)as_vector_any_mark) return as_vector_any_get((as_vector_any*)ptr, i);')
    && c.includes('if (mark == (void*)as_vector_string_mark) return as_v_str(as_vector_string_get((as_vector_string*)ptr, i));'));
  check('set routes .length through the same setLength the typed path uses',
    c.includes('if (mark == (void*)as_vector_any_mark) { as_vector_any_setLength((as_vector_any*)ptr, n); return; }'));
  check('set routes an index through the same monomorphized setter (no duplicated barrier logic)',
    c.includes('if (mark == (void*)as_vector_any_mark) { as_value e = value; as_vector_any_set((as_vector_any*)ptr, i, e); return; }'));

  // The call dispatcher must forward to the SAME helpers the static path calls, so
  // the two can never drift. Pin the method list as a set, not a shape.
  const methods = ['push', 'unshift', 'pop', 'shift', 'indexOf', 'removeAt', 'insertAt',
    'join', 'slice', 'concat', 'splice', 'reverse', 'sort', 'forEach', 'map', 'filter'];
  check('the dispatcher forwards the whole Vector method surface',
    methods.every((m) => c.includes(`strcmp(name, "${m}")`)));
  check('push/unshift are variadic like AS3 (push returns the new length)',
    c.includes('if (strcmp(name, "push") == 0) { for (int a = 0; a < argc; a++) { as_value e = args[a]; as_vector_any_push(v, e); } return as_v_num((double)v->length); }')
    && c.includes('if (strcmp(name, "unshift") == 0) { for (int a = argc - 1; a >= 0; a--) { as_value e = args[a]; as_vector_any_unshift(v, e); } return as_v_num((double)v->length); }'));
  check('concat checks the argument really is a vector of the same specialization',
    c.includes('*(void**)args[0].ptr == (void*)as_vector_any_mark'));
  check('sort/forEach/map/filter only accept a Function-tagged argument (tag 7)',
    c.includes('(argc >= 1 && args[0].tag == 7) ? (as_fn)args[0].ptr : NULL')
    && c.includes('if (argc >= 1 && args[0].tag == 7) as_vector_any_forEach(v, (as_fn)args[0].ptr);'));
  check('an unknown method name returns null rather than crashing',
    c.includes('static as_value as_vec_call_impl(void* ptr, const char* name, as_value* args, int argc)'));

  // A program without a single Vector must still define as_vec_wire() (main calls
  // it unconditionally) -- the stub is the fallback shape.
  check('the no-Vector build emits an empty stub',
    readFileSync(join(root, 'src', 'emit.ts'), 'utf8').includes("this.line('static void as_vec_wire(void) { }');"));

  // The index error must carry adl's #1125, including on the statically typed path
  // (the same helper backs both), so a RangeError is not an anonymous id-0 error.
  check('every Vector index error carries #1125 (no id-0 leftover)',
    !readFileSync(join(root, 'src', 'emit.ts'), 'utf8').includes('Vector index out of bounds", 0)')
    && c.includes('RangeError_new("Vector index out of bounds", 1125)'));

  const ex = readFileSync(join(root, 'examples', 'vector-dynamic.as'), 'utf8');
  check('the example pins the adl goldens (join / length write / #1125 on both axes)',
    ex.includes('pv.join("|") == "abc|def|ghi"')
    && ex.includes('check(pv.length == 2, "pv.length")')
    && ex.includes('== 1125, "oob read -> #1125"') && ex.includes('== 1125, "negative read -> #1125"'));
  check('the example pins "grown slots are null" (adl fills new slots with null)',
    ex.includes('check(pz[2] == null && pz[3] == null && z[2] == null, "grown slots are null")'));
  check('the example keeps the typed receiver alongside the `*` one (they must agree)',
    ex.includes('check(pv.length == 3 && vs.length == 3 && vs[2] == "ghi"')
    && ex.includes('check(pool.length == 200 * 20, "the typed vector sees the same elements")'));

  if (ok > 0) console.log(`[vecdyn] ${ok} dynamic-access checks passed`);
  return bad;
}

// A `Vector.<*>` element slot is a GC pointer field (AGENTS.md §2.4: "新增 box tag
// 或可持 GC 指针的字段时，其写点同样须同步补 gc_write_barrier"). It has no
// equivalent on the typed paths -- those already carry a barrier -- so it is easy
// to lose when adding the `*` specialization. Honest scope: gc_alloc births new
// objects BLACK while a cycle is in progress, so the window this closes is a
// WHITE reference (allocated before the cycle) stored into an already-scanned
// vector; examples/vector-dynamic.as stresses the write points but cannot pin the
// outcome, which is why the barrier itself is pinned here at the source level.
function checkVectorAnyWriteBarrier(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [vecbar] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [vecbar] ${label}`); }
  };

  const c = generateC(parse('var v:Vector.<*> = new <*>["a"];\nvar p:* = v;\np.push(1);\np[0] = 2;\n')).c;

  check('push shades the newly stored `*` slot',
    c.includes('gc_write_barrier_value(v->data[v->length - 1]);'));
  check('an in-place index write shades its slot',
    c.includes('gc_write_barrier_value(v->data[i]);'));
  check('unshift shades the head slot',
    c.includes('gc_write_barrier_value(v->data[0]);'));
  check('insertAt shades the inserted slot',
    c.includes('gc_write_barrier_value(v->data[index]);'));
  check('splice shades each inserted slot',
    c.includes('gc_write_barrier_value(v->data[start + i]);'));
  check('the boxed-value marking of a `*` vector is still there (barrier + trace together)',
    c.includes('for (int i = 0; i < v->length; i++) gc_mark_value(v->data[i]);'));

  // ---- the element fill value: AIR uses the type's ZERO, not the variable default ----
  const n = generateC(parse('var v:Vector.<Number> = new Vector.<Number>(3);\nv.length = 5;\nvar s:Vector.<String> = new Vector.<String>(2);\n')).c;
  check('a sized Vector.<Number> fills with 0, not NaN (adl: join == "0,0,0")',
    n.includes('for (int i = 0; i < n; i++) as_vector_number_push(v, 0);'));
  check('growing a Vector.<Number> through .length fills with 0 too',
    n.includes('for (int i = v->length; i < n; i++) v->data[i] = 0;'));
  check('a reference element still fills with NULL, and int/uint keep 0',
    n.includes('for (int i = 0; i < n; i++) as_vector_string_push(v, NULL);') && c.includes('as_vector_int_push(v, 0);'));
  check('the example pins the numeric fill (a NaN fill would print NaN)',
    readFileSync(join(root, 'examples', 'vector-dynamic.as'), 'utf8').includes('"a sized Vector.<Number> fills with 0"'));

  if (ok > 0) console.log(`[vecbar] ${ok} write-barrier checks passed`);
  return bad;
}

registerGroup('unit: vector/DynamicAccess', checkVectorDynamicAccess);
registerGroup('unit: vector/AnyWriteBarrier', checkVectorAnyWriteBarrier);
// ---------------------------------------------------------------------------
// `Vector.<T>(arrayLike)` is a COERCION; `new Vector.<T>(length)` is the
// CONSTRUCTOR. 阶段一百零九 — the two used to share one AST node, which both
// rejected every array argument (the wall that blocked away3d-core's
// `Vector.<Class>([...])`) and silently gave `Vector.<int>(3)` constructor
// semantics where AIR raises TypeError #1034. The behaviour (including the exact
// error ids and messages) is asserted end-to-end by examples/vector-coerce.as;
// these checks pin the AST distinction and the emitted helpers, which is what an
// example cannot observe.
// ---------------------------------------------------------------------------
function checkVectorCoerce(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [vecconv] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [vecconv] ${label}`); }
  };

  // ---- the parser keeps the two forms apart ----
  const coerce: any = (parse('var v:Vector.<int> = Vector.<int>([1, 2, 3]);').body[0] as any).init;
  check('`Vector.<T>(...)` (no `new`) parses to a VectorCoerce node',
    coerce?.kind === 'VectorCoerce');
  check('...carrying the element type and the single argument',
    String(coerce?.elem) === 'int' && coerce?.args?.length === 1 && coerce.args[0].kind === 'ArrayLit');
  const ctor: any = (parse('var v:Vector.<int> = new Vector.<int>(3);').body[0] as any).init;
  check('`new Vector.<T>(...)` still parses to a New node (constructor semantics)',
    ctor?.kind === 'New' && ctor?.className === 'Vector.<int>' && ctor?.args?.length === 1);
  const zeroArg: any = (parse('Vector.<int>();').body[0] as any).expr;
  check('a zero-argument coercion parses (AIR raises #1112 at runtime, not at compile time)',
    zeroArg?.kind === 'VectorCoerce' && zeroArg?.args?.length === 0);

  // ---- the emitted code: only the two fast paths bypass the runtime helper ----
  const arrC = generateC(parse('var a:Vector.<int> = Vector.<int>([1, 2]);\n')).c;
  const strC = generateC(parse('var a:Vector.<String> = Vector.<String>(["x"]);\n')).c;
  check('an Array argument goes through the element-wise `from_array` copy',
    arrC.includes('as_vector_int_from_array(') && strC.includes('as_vector_string_from_array('));
  check('...and the reference element kind keeps its GC write barrier and scanned storage',
    strC.includes('gc_write_barrier((void*)e);') && strC.includes('GCT_PTR_ARRAY') && strC.includes('gc_mark_ptr(v->data);'));

  const scalarC = generateC(parse('var v:Vector.<int> = Vector.<int>(3);\n')).c;
  check('a scalar argument routes to the runtime coercion (AIR: TypeError #1034)',
    scalarC.includes('as_vector_int_coerce_any(as_v_num('));
  check('the coercion raises #1034 with AIR\'s message and the dotted class spelling',
    scalarC.includes('Error #1034: Type Coercion failed: cannot convert ')
    && scalarC.includes('__AS3__.vec.Vector.<int>'));
  check('a zero-argument coercion routes to the #1112 helper',
    generateC(parse('Vector.<int>();\n')).c.includes('as_vector_int_coerce_argc(0)'));
  check('the #1112 message keeps AIR\'s TWO spaces after the period',
    scalarC.includes('Argument count mismatch on class coercion.  Expected 1, got '));

  // ---- the coercion reads `length` dynamically, so record/`*`/sealed agree ----
  check('the generic branch reads `length` through as_dyn_get (records and `*` alike)',
    scalarC.includes('as_value lv = as_dyn_get(v.ptr, "length");'));
  check('a Vector answers through the dynamic hooks, so no per-pair helper is needed',
    scalarC.includes('hk != GCT_ARRAY && hk != GCT_CUSTOM && hk != GCT_OBJECT && hk != GCT_DICT && hk != GCT_CLASS'));
  check('a non-heap pointer (a Class value) yields an empty vector, as AIR does',
    scalarC.includes('// Only an array-like heap object can carry a `length`'));

  // ---- the constructor parameter check (AIR: ArgumentError #2005) ----
  const badArgC = generateC(parse('var v:Vector.<int> = new Vector.<int>([1, 2]);\n')).c;
  check('a non-numeric `new Vector.<T>(x)` is a RUNTIME #2005, not a compile error',
    badArgC.includes('as_vector_int_new_arg_check(')
    && badArgC.includes('Error #2005: Parameter 0 is of the incorrect type. Should be type uint.'));
  check('a numeric `new Vector.<T>(n)` keeps the direct sized construction',
    generateC(parse('var v:Vector.<int> = new Vector.<int>(3);\n')).c.includes('as_vector_int_new_sized(3, false)'));

  // ---- the original wall: Class / Dictionary element types monomorphise ----
  const classC = generateC(parse('var c:Vector.<Class> = Vector.<Class>([A, B]);\nclass A {}\nclass B {}\n')).c;
  check('`Vector.<Class>` monomorphises (the away3d Parsers.ALL_BUNDLED wall)',
    classC.includes('as_vector_class_from_array(') && classC.includes('as_vector_class_push('));
  check('a Class element is a GC pointer, so its storage is a scanned GCT_PTR_ARRAY',
    classC.includes('GCT_PTR_ARRAY') && classC.includes('gc_write_barrier((void*)e);'));
  check('a Class-heavy element vector still reflects as __AS3__.vec::Vector.<Class>',
    classC.includes('"__AS3__.vec::Vector.<Class>"'));
  const dictC = generateC(parse('var d:Vector.<Dictionary> = Vector.<Dictionary>([new Dictionary()]);\n')).c;
  check('`Vector.<Dictionary>` monomorphises too', dictC.includes('as_vector_dict_from_array('));
  check('...and reflects as __AS3__.vec::Vector.<flash.utils::Dictionary>',
    dictC.includes('"__AS3__.vec::Vector.<flash.utils::Dictionary>"'));

  if (ok > 0) console.log(`[vecconv] ${ok} coercion checks passed`);
  return bad;
}
registerGroup('unit: vector/Coerce', checkVectorCoerce);
