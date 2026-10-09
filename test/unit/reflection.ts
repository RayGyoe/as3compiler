// Unit checks: as Object, Function-valued members, Vector names, qualified superclass.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='reflection/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- `x as Object` (stage 94e) ----
// adl 51.4.1 measured (temp/a3probe/): AS3 treats primitives as Objects, so
// `as Object` never nulls a value out — `5 as Object` is 5, `null`/`undefined`
// as Object are null, and a record keeps every dynamic slot. The old emitter
// answered a literal NULL for every non-object operand, so `({k:"v"}) as Object`
// silently lost its keys (the AMF round-trip of stage 94d hit exactly this).
// The fix routes the cast through the ordinary coercion, which is also what the
// implicit `var o:Object = n` path already emitted — asserted here so the two
// forms cannot drift apart again.
function checkAsObjectCast(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cast] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cast] ${label}`); }
  };
  const c = generateC(parse('var n:Number = 5;\nvar dn:* = 5;\nvar r:* = {k: 1};\nvar o1:Object = n as Object;\nvar o2:Object = dn as Object;\nvar o3:Object = r as Object;\nvar o4:Object = n;\n')).c;

  check('a statically scalar `as Object` boxes (no longer NULL)',
    c.includes('g_o1 = ((Object*)as_number_new(g_n));'));
  check('a dynamically typed `as Object` unboxes via as_value_to_obj (no longer NULL)',
    c.includes('g_o2 = ((Object*)as_value_to_obj(g_dn));'));
  check('a record through `*` cast to Object unboxes too (the AMF round-trip bug)',
    c.includes('g_o3 = ((Object*)as_value_to_obj(g_r));'));
  check('`as Object` and the implicit conversion emit the identical boxing form',
    c.includes('g_o4 = ((Object*)as_number_new(g_n));'));

  const ex = readFileSync(join(dir, 'stage94e.as'), 'utf8');
  check('the example pins the measured `as Object` goldens',
    ex.includes('"a record cast to Object keeps its dynamic members, got "')
    && ex.includes('"null as Object is null"')
    && ex.includes('"undefined as Object is null (measured on adl)"')
    && ex.includes('"a boxed Number round-trips through `as Number`"')
    && ex.includes('"a nested record survives `holder.props as Object`, got "'));

  if (ok > 0) console.log(`[cast] ${ok} cast checks passed`);
  return bad;
}

// ---- calling a Function-valued member (stage 94e) ----
// adl 51.4.1 measured (temp/a4probe/): `cb.fn()` and `with (cb) { fn() }` both
// invoke the stored function (and both rebind `this` to the receiver, which our
// lexically captured `this` cannot reproduce -- registered in TODO.md 遗留).
// Before this, BOTH forms were a hard 'undefined method' / 'not supported'
// build error even though a Function field could be read into a temp. Anything
// that is neither a method nor a Function-valued field must still fail loudly.
function checkFunctionMemberCall(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fncall] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fncall] ${label}`); }
  };
  const c = generateC(parse('class Cb {\n public var fn:Function;\n public function Cb() {}\n public function callDotted():void { this.fn(); }\n}\nvar cb:Cb = new Cb();\nwith (cb) { fn(); }\n')).c;

  // The closure pointer is null-guarded by as_req_fn (#1006), so the callee/env
  // reads are wrapped.
  check('a dotted call of a Function-valued field invokes the stored closure',
    c.includes('as_req_fn((this->fn), NULL)->fn(as_req_fn((this->fn), NULL)->env, NULL, 0);'));
  check('a `with` call of a Function-valued field invokes the stored closure',
    c.includes('as_req_fn((_w0->fn), NULL)->fn(as_req_fn((_w0->fn), NULL)->env, NULL, 0);'));

  const loud = (src: string): string => {
    try { generateC(parse(src)); return ''; } catch (e) { return (e as Error).message; }
  };
  check('a non-Function field called through `with` still fails loudly',
    loud('class R { public var tag:String = "x"; public function R() {} }\nvar r:R = new R();\nwith (r) { tag(); }\n')
      .includes("with: calling the member 'tag' of 'R' is not supported"));
  check('a non-Function field called by dotted name still fails loudly',
    loud('class R { public var tag:String = "x"; public function R() {} }\nvar r:R = new R();\nr.tag();\n')
      .includes("undefined method 'tag' on class 'R'"));

  const ex = readFileSync(join(dir, 'stage94e.as'), 'utf8');
  check('the example pins the measured Function-member call goldens',
    ex.includes('"a dotted call of a Function-valued field runs it, got "')
    && ex.includes('"a bare call of a Function-valued field runs it, got "')
    && ex.includes('"a `with` call of a Function-valued field runs it, got "'));

  if (ok > 0) console.log(`[fncall] ${ok} function-member call checks passed`);
  return bad;
}

// ---- Vector.<T> reflection names (stage 94e) ----
// adl 51.4.1 measured (temp/a5probe/): a Vector is named
// "__AS3__.vec::Vector.<element>", with the element spelled the way
// getQualifiedClassName would spell an instance of it (int and uint stay
// distinct, a class keeps its "pkg::Name" fqn, a nested vector recurses). The
// superclass splits by element kind: numerics (int/uint/Number) extend Object,
// every reference element type extends "__AS3__.vec::Vector.<*>". A Vector is a
// monomorphized struct with no vtable, so the runtime asks the emitted hooks,
// which switch on the identity of the struct's leading mark pointer.
function checkVectorReflectionNames(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [vecfqn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [vecfqn] ${label}`); }
  };
  const c = generateC(parse('var a:Vector.<int> = new <int>[1];\nvar b:Vector.<String> = new <String>["x"];\nvar d:Vector.<Vector.<int>> = new <Vector.<int>>[new <int>[1]];\n')).c;

  check('a numeric-element Vector names itself and extends Object',
    c.includes('if (mark == (void*)as_vector_int_mark) return "__AS3__.vec::Vector.<int>";')
    && c.includes('if (mark == (void*)as_vector_int_mark) return "Object";'));
  check('a reference-element Vector extends Vector.<*>',
    c.includes('if (mark == (void*)as_vector_string_mark) return "__AS3__.vec::Vector.<String>";')
    && c.includes('if (mark == (void*)as_vector_string_mark) return "__AS3__.vec::Vector.<*>";'));
  check('a nested vector element is named recursively',
    c.includes('if (mark == (void*)as_vector_vector_int_mark) return "__AS3__.vec::Vector.<__AS3__.vec::Vector.<int>>";'));
  check('the wire installs both hooks and main calls it',
    c.includes('as_vec_fqn_hook = as_vec_fqn_impl;')
    && c.includes('as_vec_super_fqn_hook = as_vec_super_fqn_impl;')
    && c.includes('as_vec_fqn_wire();'));

  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the runtime declares both hooks',
    preamble.includes('static const char* (*as_vec_fqn_hook)(void* ptr) = NULL;')
    && preamble.includes('static const char* (*as_vec_super_fqn_hook)(void* ptr) = NULL;'));
  check('the class-name helper asks the hook for GCT_CUSTOM but an Array still says "Array"',
    preamble.includes('if (kind == GCT_ARRAY) return "Array";')
    && /kind == GCT_CUSTOM\) \{[\s\S]{0,400}?as_vec_fqn_hook\(v\.ptr\)/.test(preamble));
  check('the superclass helper asks its hook too',
    /kind == GCT_CUSTOM\) \{[\s\S]{0,400}?as_vec_super_fqn_hook\(v\.ptr\)/.test(preamble));

  const ex = readFileSync(join(dir, 'stage94e.as'), 'utf8');
  check('the example pins the measured Vector reflection goldens',
    ex.includes('"__AS3__.vec::Vector.<int>"')
    && ex.includes('"__AS3__.vec::Vector.<uint>"')
    && ex.includes('"__AS3__.vec::Vector.<*>"')
    && ex.includes('"__AS3__.vec::Vector.<__AS3__.vec::Vector.<int>>"'));

  if (ok > 0) console.log(`[vecfqn] ${ok} vector reflection checks passed`);
  return bad;
}

// ---- flash.utils.getQualifiedSuperclassName (stage 94c) ----
// adl 51.4.1 measured (temp/qscnprobe, temp/mixprobe): the value's class is looked
// up, then ONE vtable super step decides the answer. A class with no superclass
// (Object itself, an interface) and a value with no class (null, undefined, a
// plain {} record) all yield AS3 null — not the string "null" (typeof is
// "object"). Boxed primitives / Array / Function yield "Object" because their
// classes extend Object. Super names keep the "pkg::Name" form
// (getQualifiedSuperclassName(SceneLeaf) is "scenes::SceneBase"). The result is
// declared String (NULL == AS3 null) so `== "pkg::K"` and `.indexOf` stay static.
function checkQualifiedSuperclassName(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [qscn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [qscn] ${label}`); }
  };
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const fn = preamble.slice(preamble.indexOf('static char* as_get_qualified_superclass_name(as_value v) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  check('the runtime defines as_get_qualified_superclass_name',
    body.length > 0);
  check('null and undefined (tags 0/5) answer NULL (AS3 null)',
    /case 0:[\s\S]*?case 5:[\s\S]*?return NULL;/.test(body));
  check('boxed primitives, Array and Function answer "Object"',
    /case 1: case 2: case 3: case 6: case 7:[\s\S]*?return \(char\*\)"Object";/.test(body));
  check('an object walks exactly ONE vtable super step',
    body.includes('void* sup = ((as_vtable_header*)vt)->super;'));
  check('a vtable without a super (Object / interface / plain record) answers NULL',
    body.includes('if (sup == NULL) return NULL;'));
  check('getQualifiedClassName is unchanged (still the own-name helper)',
    preamble.includes('static char* as_get_qualified_class_name(as_value v) {'));

  const c = generateC(parse([
    'class RBase { }',
    'class RMid extends RBase { }',
    'class RLeaf extends RMid { }',
    'var s:String = getQualifiedSuperclassName(new RLeaf());',
    'var t:String = getQualifiedClassName(RLeaf);',
    '',
  ].join('\n'))).c;
  check('emit routes getQualifiedSuperclassName through the runtime helper',
    c.includes('as_get_qualified_superclass_name('));
  check('emit boxes the argument like getQualifiedClassName does',
    c.includes('as_get_qualified_superclass_name(as_v_obj('));
  // A String-typed result (not `any`): a static String method call must compile,
  // and adl's declaration is String, so `== "pkg::K"` / `.indexOf` behave statically.
  const strC = generateC(parse([
    'class SBase { }',
    'class SLeaf extends SBase { }',
    'var n:int = getQualifiedSuperclassName(new SLeaf()).indexOf("::");',
    '',
  ].join('\n'))).c;
  check('the result is String-typed, so String methods apply statically',
    strC.includes('as_get_qualified_superclass_name(') && strC.includes('as_str_indexOf_from('));

  const ex = readFileSync(join(root, 'examples', 'stage94c.as'), 'utf8');
  check('the example pins the multi-level chain (Leaf -> Mid -> Base)',
    ex.includes('getQualifiedSuperclassName(Leaf) == "Mid"')
    && ex.includes('getQualifiedSuperclassName(Mid) == "Base"'));
  check('the example pins the null boundary values (Object level / {} / null / undefined)',
    ex.includes('getQualifiedSuperclassName({}) == null')
    && ex.includes('getQualifiedSuperclassName(null) == null')
    && ex.includes('getQualifiedSuperclassName(undefined) == null'));
  check('the example pins "Object" for boxed primitives / Array / Function',
    ex.includes('getQualifiedSuperclassName(1) == "Object"')
    && ex.includes('getQualifiedSuperclassName([1, 2]) == "Object"')
    && ex.includes('getQualifiedSuperclassName(function():void { }) == "Object"'));
  check('the example pins the packaged "pkg::Name" super form',
    ex.includes('getQualifiedSuperclassName(SceneLeaf) == "scenes::SceneBase"'));

  if (ok > 0) console.log(`[qscn] ${ok} superclass-name checks passed`);
  return bad;
}

registerGroup('unit: reflection/AsObjectCast', checkAsObjectCast);
registerGroup('unit: reflection/FunctionMemberCall', checkFunctionMemberCall);
registerGroup('unit: reflection/VectorReflectionNames', checkVectorReflectionNames);
registerGroup('unit: reflection/QualifiedSuperclassName', checkQualifiedSuperclassName);

// ---- `is` / `as` with a runtime Class VALUE as the right operand (stage 99) ----
// adl 51.4.1 measured (temp/cisprobe/cis-result.txt): AS3 resolves `x is Name` in
// the SCOPE first, so a Class variable/parameter/field is a runtime class object
// and the check walks the real super chain; a right operand holding no class
// object (a Class slot with null) throws TypeError #1009 from BOTH `is` and `as`,
// and the operand is validated before the left side is considered. The old
// emitter fed the operand to the type-name resolver, so `ch is cls` was a
// codegen error (`unknown type 'cls'`).
function checkClassValueOperand(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [clsop] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [clsop] ${label}`); }
  };
  const src = 'class A { }\nclass B extends A { }\n'
    + 'function f(x:*, c:Class):Boolean { return x is c; }\n'
    + 'var c:Class = B;\n'
    + 'var r1:Boolean = new A() is c;\n'
    + 'var r2:* = new A() as c;\n'
    + 'var n:int = 5;\n'
    + 'var r3:Boolean = n is c;\n'
    + 'var r6:* = n as c;\n'
    + 'var dyn:* = new A();\n'
    + 'var r4:Boolean = dyn is c;\n'
    + 'var r5:* = dyn as c;\n';
  const c = generateC(parse(src)).c;

  check('an object left side goes through as_class_is_obj with the runtime class object',
    /g_r1 = as_class_is_obj\(\(_once\d+\), g_c\);/.test(c));
  check('a primitive left side is autoboxed and checked at runtime (true only for Object)',
    c.includes('g_r3 = as_class_is_val(as_v_num((double)(g_n)), g_c);'));
  check('`as` on an object wraps the same pointer: it or null',
    /g_r2 = as_class_as_val\(as_v_obj\(\(void\*\)\(_once\d+\)\), g_c\);/.test(c));
  check('`as` on a primitive uses the same autoboxing check (and validates the operand)',
    c.includes('g_r6 = as_class_as_val(as_v_num((double)(g_n)), g_c);'));
  check('a `*` left side uses the tag-checked box variants',
    c.includes('g_r4 = as_class_is_val(g_dyn, g_c);') && c.includes('g_r5 = as_class_as_val(g_dyn, g_c);'));
  check('a Class PARAMETER resolves to the parameter (no `unknown type` error)',
    c.includes('return as_class_is_val(x, c);'));
  check('the runtime helper validates the operand with #1009',
    c.includes('static as_class* as_req_class(as_class* c) {')
    && c.includes('Error #1009: Cannot access a property or method of a null object reference.'));
  check('the runtime subtype test folds object receivers through the autoboxing value form',
    c.includes('return as_class_is_val(as_v_obj(obj), c);') && c.includes('as_is_object_cls(cl)'));

  // The type-name path must be untouched: a qualified or generic target is never
  // read as a value, and a literal class name still folds through the vtable.
  const c2 = generateC(parse('class A { }\nvar r:Boolean = new A() is A;\nvar s:Boolean = new A() is Object;\n')).c;
  check('a literal type name still uses the static vtable test', c2.includes('as_is(') && c2.includes('&A_vt'));
  check('`is Object` is true for a class instance', c2.includes('g_s = true;'));

  // `is Object` holds for every value except null/undefined (adl islit-result.txt
  // O1-O27): primitives, arrays, records, functions, class instances and a boxed
  // value in a `*` slot all pass.
  const c3 = generateC(parse('var a:Boolean = 1 is Object;\nvar b:Boolean = "x" is Object;\nvar d:Boolean = [1] is Object;\nvar e:Boolean = null is Object;\nvar f:Boolean = undefined is Object;\nvar g:Boolean = true is Object;\n')).c;
  check('a statically scalar `is Object` is true (was folded to false)',
    c3.includes('g_a = true;') && c3.includes('g_b = true;') && c3.includes('g_g = true;'));
  check('an array `is Object` is true', c3.includes('g_d = true;'));
  check('null `is Object` is false', c3.includes('g_e = false;'));
  check('undefined `is Object` is false', c3.includes('g_f = as_v_is_object(as_v_undefined());'));
  check('the boxed `is Object` rule is tag-based (null and undefined only)',
    RUNTIME_PREAMBLE.includes('static bool as_v_is_object(as_value v) { return v.tag != 0 && v.tag != 5; }'));

  // The example pins the measured AIR values end to end.
  const ex = readFileSync(join(dir, 'is-class-operand.as'), 'utf8');
  check('the example pins the #1009 operand error', ex.includes('a null Class slot throws #1009 from `is`'));
  check('the example pins subtype walking', ex.includes('"a Dog is the Animal class (up the chain)"'));
  check('the example pins the Object rule', ex.includes('"an int is an Object"'));

  if (ok > 0) console.log(`[clsop] ${ok} class-operand checks passed`);
  return bad;
}

registerGroup('unit: reflection/ClassValueOperand', checkClassValueOperand);

// ---- the operand of a dynamic instantiation (stage 一百二十二) ----
// `new <expr>()` is legal whenever the operand CAN carry a Class, which is not
// only the `class`-typed spelling: an Array/Vector element is `any` (it boxes) and
// an Object-typed variable carries the class as a bare pointer. away3d's
// Intermediate_MD5Animation reaches codegen as
//   AssetLibrary.loadData(new ANIM_CLASSES[i](), ...)
// (ANIM_CLASSES is `Array` of Class values), and the previous guard -- which
// accepted only `class` -- made the whole demo uncompilable.
//
// The runtime side is the interesting half: the operand must be checked, not
// reinterpreted. `x is Class` and `new x` must therefore be the SAME predicate
// (registry identity), or the `if (x is Class) new x()` idiom can disagree with
// itself -- and a boxed String/instance/Array operand must reach AIR's TypeError
// #1007 instead of having its payload followed as an `as_class*`.
function checkDynNewOperand(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dynnew] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dynnew] ${label}`); }
  };

  // An Array element: the reported breakage. The value is boxed, so it must go
  // through the tag/gate-checked unbox -- not a blind as_v_obj_val.  The comparison
  // between the two `new abc` forms is the whole point: the parenthesized spelling
  // must now behave exactly like the bare one that lookupObjectVar already handled.
  const c = generateC(parse([
    'class A { }',
    'var cls:Class = A;',
    'var arr:Array = [A];',
    'var v:* = new arr[0]();',
    'var w:* = new (cls)();',
    'var o:Object = A;',
    'var z:* = new (o)();',
  ].join('\n'))).c;
  check('an Array-element operand is accepted (was a codegen error)',
    c.includes('as_v_new_class(as_array_get('));
  check('the element unbox is tag/heap gated, not a blind as_v_obj_val',
    !c.includes('as_dyn_new((as_class*)(void*)(as_v_obj_val(as_array_get('));
  check('a `class`-typed operand still passes its pointer straight through',
    c.includes('as_dyn_new((as_class*)(void*)(g_cls))'));
  check('an Object-typed operand goes through the pointer gate',
    c.includes('as_new_class_ptr((void*)(g_o))'));

  // A Vector.<Class> element (SingleFileLoader._parsers) is statically a Class, so
  // its getter already hands back the raw class pointer -- no unbox is needed and
  // none is emitted. Only the boxed (`any`) shapes take the checked unbox.
  const cv = generateC(parse('class A { }\nvar ps:Vector.<Class> = Vector.<Class>([A]);\nvar x:* = new ps[0]();\n')).c;
  check('a Vector.<Class> element is accepted, with the element getter dereferenced directly',
    cv.includes('as_dyn_new((as_class*)(void*)(as_vector_class_get('));
  check('a Vector.<Class> element is NOT needlessly re-unboxed',
    !cv.includes('as_v_new_class(as_vector_class_get('));

  // A member chain ending in an index -- `new obj.list[i]()`.
  const cm = generateC(parse('class A { }\nclass H { public var list:Array = [A]; }\nvar h:H = new H();\nvar x:* = new h.list[0]();\n')).c;
  check('a member chain ending in an index is accepted', cm.includes('as_v_new_class(as_array_get('));

  // The helpers themselves: fail-closed, and sharing the `is Class` predicate.
  const rt = RUNTIME_PREAMBLE;
  check('the boxed-operand helper rejects every non-tag-4 value',
    rt.includes('static as_class* as_v_new_class(as_value v) {')
    && rt.includes('if (v.tag != 4 || v.ptr == NULL || gc_in_heap(v.ptr)) return NULL;'));
  check('the boxed-operand helper identifies a Class by registry identity (same as `is Class`)',
    rt.includes('return as_v_is_class(v) ? (as_class*)v.ptr : NULL;'));
  check('the Object-pointer helper is gated the same way',
    rt.includes('static as_class* as_new_class_ptr(void* p) {')
    && rt.includes('if (p == NULL || gc_in_heap(p)) return NULL;')
    && rt.includes('return as_v_is_class(as_v_obj(p)) ? (as_class*)p : NULL;'));
  check('a NULL operand is AIR TypeError #1007 (the unbox yields NULL, the ctor test throws)',
    rt.includes('static as_class* as_v_new_class(as_value v) {')
    && c.includes('if (c == NULL) {') && c.includes('Error #1007: Instantiation attempted on a non-constructor.'));

  // A statically scalar operand can never be a Class: refused loudly rather than
  // emitted as a guaranteed #1007. (mxmlc accepts the spelling -- measured
  // temp/dynnewop -- so this is deliberate strictness on nonsense, not AIR parity.)
  let msg = '';
  try {
    generateC(parse('var n:int = 3;\nvar x:* = new (n)();\n'));
  } catch (e) {
    msg = String((e as Error).message);
  }
  check('a scalar operand is refused with a diagnostic naming the operand type',
    msg.includes('dynamic instantiation requires a Class reference') && msg.includes('int'));

  // The example pins the measured AIR goldens end to end.
  const ex = readFileSync(join(dir, 'dynnew-operand.as'), 'utf8');
  check('the example pins the Array/Vector/member-chain shapes',
    ex.includes('new kinds[i]()') && ex.includes('new parsers[0]()') && ex.includes('new h.list[0]()'));
  check('the example pins constructor arguments through the thunk',
    ex.includes('new ctors[0](3, "x")'));
  check('the example pins TypeError #1007 for non-Class operands',
    ex.includes('new (badStr)()') && ex.includes('new badArr[0]()') && ex.includes('err.errorID == 1007'));
  check('the example pins the `is Class` / `new` agreement',
    ex.includes('if (candidate is Class) return new (candidate)();'));

  if (ok > 0) console.log(`[dynnew] ${ok} dynamic-instantiation checks passed`);
  return bad;
}

registerGroup('unit: reflection/DynNewOperand', checkDynNewOperand);

// ---------------------------------------------------------------------------
// Nearest-declaration member resolution (stage 123).
//
// `away3d.containers.ObjectContainer3D` declares `get parent():ObjectContainer3D`,
// but our built-in EventDispatcher stores the display-list ancestor link in a slot
// of the SAME name (AIR's EventDispatcher has no `parent` at all, so the two never
// meet there). `info.fields` is FLATTENED, so `fieldSlot()` happily returned the
// ANCESTOR's slot, and the read paths consult fields before accessors -- the read
// became a raw `->parent` of a slot an away3d ObjectContainer3D never assigns
// (its own graph uses `_parent`), so `parent` read NULL and `as_req_obj` threw
// #1009 in ObjectContainer3D.updateMouseChildren (lldb stack of
// Intermediate_MD5Animation: initObjects -> addChild -> setParent ->
// updateMouseChildren -> as_throw). AS3 settles an instance-member reference by the
// NEAREST declaration, so a class's OWN accessor must shadow an inherited field --
// and a nearer SETTER must NOT (our built-ins keep AIR's accessor PAIRS as stored
// fields, so there is no inherited getter to fall back to: counting setters made
// away3d's `View3D`, which does `override set x` and then reads `x`, die with
// "undefined variable 'x' in class away3d_containers_View3D").
function checkMemberShadow(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [shadow] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [shadow] ${label}`); }
  };

  // Both READ paths must apply the rule: the member form (`o.parent`) and the
  // bare-identifier form inside a method body (`return parent;`) -- the latter is
  // the one the away3d crash actually hit.
  const c = generateC(parse([
    'class S2 extends EventDispatcher {',
    '  public function get parent():String { return "s"; }',
    '  public function probe():String { return parent; }',
    '}',
    'var o:S2 = new S2();',
    'var q:String = o.parent;',
  ].join('\n'))).c;
  check('an own getter shadows the inherited field on `o.parent`',
    c.includes('->vtable->get_parent('));
  check('...and on a bare `parent` inside a method body',
    c.includes('return (this->vtable->get_parent(this));'));

  // A subclass that does NOT redeclare the getter still gets it (away3d reads
  // `parent` on Entity/Mesh/SegmentSet/... constantly), dispatched virtually.
  const cd = generateC(parse([
    'class S2 extends EventDispatcher { public function get parent():String { return "s"; } }',
    'class D extends S2 { }',
    'var d:D = new D();',
    'var z:String = d.parent;',
  ].join('\n'))).c;
  check('an inherited getter still shadows the inherited field on a deeper subclass',
    cd.includes('->vtable->get_parent('));

  // The fix must NOT be implemented by deleting the inherited slot: the slot is the
  // runtime's display-list ancestor link (EventDispatcher_ctor / as_disp_parent),
  // its layout is pinned in platform.ts, and it still must read for a receiver that
  // does not shadow it.
  check('the EventDispatcher `parent` slot survives as the runtime ABI anchor',
    c.includes('{ "parent", 12, offsetof(EventDispatcher, parent) },'));
  const cu = generateC(parse('class U extends Sprite { }\nvar u:U = new U();\nu.name = "k";\nvar n:String = u.name;\n')).c;
  check('an unshadowed inherited field is still read/written directly',
    cu.includes('->name) = "k", gc_write_barrier')
    && cu.includes('->name);')
    && !cu.includes('get_name('));

  // A nearer setter-only override must not make the read disappear (the View3D
  // shape). Before the setter exclusion this shape failed to compile at all.
  let setterOnly = '';
  let threw = '';
  try {
    setterOnly = generateC(parse('class T extends Sprite { public function set y(v:Number):void { if (y == v) return; } }')).c;
  } catch (e) { threw = String((e as Error).message); }
  check('a setter-only override does not hide the inherited field on a read',
    threw === '' && setterOnly.includes('if ((this->y == v)) {'));
  check('...while the setter itself is still emitted for writes',
    setterOnly.includes('static void T_set_y(void* _this, double v) {')
    && setterOnly.includes('{ "y", T_set_y__dyn },'));

  // Source-level: the rule lives in one place and every member-resolution site
  // consults it — the three read paths plus the two type-inference paths in
  // walkInferType, so inference can never disagree with the emitted read.
  const symbolsSrc = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  check('the rule is a single named helper (shadowedForRead), not inlined twice',
    symbolsSrc.includes('shadowedForRead(cls: string, fieldOwner: string, name: string): boolean {'));
  const emitSrc = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  check('all five resolution sites consult it (3 reads + 2 type inferences)',
    (emitSrc.match(/shadowedForRead\(/g) ?? []).length === 5);

  // The example pins the measured AIR goldens end to end.
  const ex = readFileSync(join(dir, 'member-shadow.as'), 'utf8');
  check('the example pins the own-getter-shadows-inherited-field rule',
    ex.includes('class ShadowSub extends ShadowBase')
    && ex.includes('get parent():String { return "shadow"; }')
    && ex.includes('check(sub.parent == "shadow"'));
  check('the example pins the setter-only non-regression',
    ex.includes('override public function set y(value:Number):void')
    && ex.includes('check(setterOnly.y == 7'));

  if (ok > 0) console.log(`[shadow] ${ok} member-resolution checks passed`);
  return bad;
}

registerGroup('unit: reflection/MemberShadow', checkMemberShadow);

// ---------------------------------------------------------------------------
// A bound-method / static-method thunk is emitted from emitFunctionValues, i.e.
// OUTSIDE any class body, so its default parameter values could not name the
// owning class's STATIC consts: away3d's
// `applyToContainer(..., radiusMode:int = RADIUS, ...)` failed codegen with
// "undefined variable 'RADIUS' at top level". The thunk now re-enters the owning
// class scope. 阶段一百零九.
// ---------------------------------------------------------------------------
function checkThunkOwnerScope(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [thunkcls] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [thunkcls] ${label}`); }
  };

  const src = [
    'class D {',
    '  public static const RADIUS:int = 1;',
    '  public function apply(x:int = RADIUS):int { return x; }',
    '  public static function run():void {',
    '    var d:D = new D();',
    '    var f:Function = d.apply;',
    '    trace(f());',
    '  }',
    '}',
    'D.run();',
    '',
  ].join('\n');

  // The whole point: this used to THROW at codegen time. It must now emit.
  let c = '';
  let threw = '';
  try { c = generateC(parse(src)).c; } catch (e) { threw = String(e); }
  check('a bound-method thunk resolves a static const in its default value', threw === '');
  check('...by binding the class scope, so the default reads the static field slot',
    c.includes('D_RADIUS'));

  // A free function's default value must NOT gain a class scope: `RADIUS` stays
  // unresolved at top level, which is the pre-existing (correct) behavior.
  let freeThrew = false;
  try { generateC(parse('function g(x:int = RADIUS):int { return x; }\ng();\n')); }
  catch { freeThrew = true; }
  check('a free function default is still resolved at top level (RADIUS is undefined)',
    freeThrew);

  if (ok > 0) console.log(`[thunkcls] ${ok} thunk-owner-scope checks passed`);
  return bad;
}
registerGroup('unit: reflection/ThunkOwnerScope', checkThunkOwnerScope);
