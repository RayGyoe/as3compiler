// Unit checks: statement-level emitter shape — generated-C invariants that no
// example can catch, because the examples suite compiles with Apple clang, which
// is far more permissive than the LLVM clang behind `emcc`. Each group returns
// the list of failed labels and is registered as one node:test case, so it can be
// re-run alone with:
//   node --test --test-name-pattern='emit/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root } from '../harness.ts';

// A left-nested chain of N string literals, which is what the emitter sees for
// `"a" + "b" + ... + "z"` (and what Away3D's AGAL code builders produce with
// several hundred terms).
function chain(n: number): string {
  const parts = Array.from({ length: n }, (_, i) => `"p${i}"`);
  return `var s:String = ${parts.join(' + ')};\ntrace(s);\n`;
}

function initializer(c: string): string {
  // The module variable is also declared (`char* g_s = NULL;`) earlier in the
  // file, so pick the assignment whose value is the concatenation itself.
  for (const m of c.matchAll(/\bg_s = ([\s\S]*?);\n/g)) {
    if (m[1].startsWith('as_str_concat')) return m[1];
  }
  return '';
}

// Deepest parenthesis nesting anywhere in the initializer: this is the quantity
// LLVM clang caps at 256 (`bracket nesting level exceeded maximum of 256`).
function parenDepth(s: string): number {
  let d = 0;
  let max = 0;
  for (const ch of s) {
    if (ch === '(') { d++; if (d > max) max = d; }
    else if (ch === ')') d--;
  }
  return max;
}

function checkEmitStringConcatFlat(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };

  const nestedInit = initializer(generateC(parse(chain(32))).c);
  const flatInit = initializer(generateC(parse(chain(33))).c);

  // The boundary: at the threshold the ordinary nested `as_str_concat(a, b)`
  // spine survives (so everyday code generates the same C as before), and one
  // term past it the whole spine becomes a single flat call.
  check('a 32-term chain still emits the nested as_str_concat spine',
    nestedInit.startsWith('as_str_concat(') && !nestedInit.includes('as_str_concat_n('));
  check('a 33-term chain emits one flat as_str_concat_n call',
    /^as_str_concat_n\(33, \(const char\*\[\]\)\{ "p0", "p1", .*"p32" \}\)$/.test(flatInit));

  // Order is semantic: AS3 evaluates the operands left to right, and the flat
  // form hands the parts to a runtime helper, so the array must already be in
  // source order (or every concatenation would come out permuted).
  const parts = [...flatInit.matchAll(/"p(\d+)"/g)].map((m) => Number(m[1]));
  check('the flattened call keeps left-to-right part order',
    parts.length === 33 && parts.every((v, i) => v === i));

  // The point of the change: bracket depth stops growing with the term count.
  // 32 terms already nest 32 deep (447 in the Away3D method that started this);
  // the flat form is a constant handful regardless of how many parts follow.
  check('flattening keeps the emitted bracket depth constant (not O(terms))',
    parenDepth(flatInit) <= 4 && parenDepth(nestedInit) >= 30);

  // The helper must count and copy with the same NULL substitution: AS3 turns a
  // null operand into "null", so a bearer that measures with strlen(NULL) either
  // truncates the result or crashes before it.
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const helper = runtime.slice(runtime.indexOf('static char* as_str_concat_n(int n, const char** parts)'));
  const body = helper.slice(0, helper.indexOf('\n}\n'));
  check('as_str_concat_n substitutes "null" in both the measure and the copy pass',
    (body.match(/parts\[i\] == NULL \? "null" : parts\[i\]/g) || []).length === 2
    && body.includes('const char* s = parts[i] == NULL ? "null" : parts[i];'));

  console.log(`     [emit] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: emit/StringConcatFlat', checkEmitStringConcatFlat);

// Interface accessors satisfied by an accessor-backed BUILT-IN property. AIR
// declares `DisplayObject.x` as `get x`/`set x`, so a subclass INHERITING it
// implements `interface I { get x():Number; set x(v:Number):void; }` (measured on
// adl 51.4.1, temp/ifacc/ — both sides print the same 4 lines). Our C model stores
// x as a plain field, so the emitter must synthesize an accessor that reads/writes
// the inherited field slot and wire it into the interface vtable. Those slots are
// literal function pointers, so a NULL or mis-typed entry is a runtime crash that
// no example would reach until the accessor is called THROUGH the interface.
function checkEmitInterfaceAccessorThunk(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ifaccthunk] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ifaccthunk] ${label}`); }
  };

  const c1 = generateC(parse('package { public interface IX { function get x():Number; function set x(v:Number):void; } }\n'
    + 'package { import flash.display.Sprite; public class Box extends Sprite implements IX {} }')).c;
  check('a getter thunk reads the inherited field slot',
    c1.includes('static double Box_get_x(void* _this) { return (double)((Box*)_this)->x; }'));
  check('a setter thunk writes the inherited field slot',
    c1.includes('static void Box_set_x(void* _this, double value) { ((Box*)_this)->x = value; }'));
  check('the interface vtable points at the thunks (not at NULL)',
    /static IX_vtable Box_IX_vt = \{ "IX", NULL, NULL, NULL, NULL, Box_get_x, Box_set_x \};/.test(c1));

  // Two interfaces may declare the same accessor; the thunk is keyed by symbol
  // name, so it must be DEFINED once and referenced from both vtables (a second
  // definition would not compile).
  const c2 = generateC(parse('package { public interface IA { function get x():Number; function set x(v:Number):void; } }\n'
    + 'package { public interface IB { function get x():Number; function set x(v:Number):void; } }\n'
    + 'package { import flash.display.Sprite; public class Two extends Sprite implements IA, IB {} }')).c;
  check('two interfaces sharing one accessor define the thunk only once',
    (c2.match(/static double Two_get_x\(/g) || []).length === 1);
  check('...and both vtables reference that single thunk',
    (c2.match(/Two_get_x, Two_set_x \};/g) || []).length === 2);

  console.log(`     [ifaccthunk] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: emit/InterfaceAccessorThunk', checkEmitInterfaceAccessorThunk);
// ---- Array ToPrimitive / ToString (Array as a primitive) ----
// An Array participates in every primitive conversion the way ES3 says: ToString
// is join(","), ToNumber parses that same string, and a loose comparison against
// a scalar stringifies. AIR does all three (measured on adl 51.4.1, temp/pkgA/
// arrstr + arrnum + arr2/3/4/5 + eq: `[1,2]` prints "1,2", `Number([5])` is 5,
// `[5] == 5` and `[1,2] == "1,2"` are true). Before this the runtime answered
// "[object Object]"/0 for the array cases and `a.toString()` on a `*` receiver
// passed the element buffer to as_dyn_call, which read a vtable header out of it
// and SEGFAULTED. None of that is reachable from a typed example, so it is pinned
// here on the emitted C and on the preamble text.
function checkEmitArrayToPrimitive(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [arrprim] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [arrprim] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');

  check('as_v_str_val turns an array into join(",")',
    pre.includes('case 6: return as_arr_to_str(v.ptr);'));
  check('as_arr_to_str IS join(","), so the two spellings cannot drift',
    pre.includes('static char* as_arr_to_str(void* a) {') && pre.includes('return as_array_join((as_array*)a, ",");'));
  check('as_v_to_number parses the array string (Number([5]) == 5)',
    pre.includes('if (v.tag == 6 && v.ptr != NULL) return as_str_to_number(as_arr_to_str(v.ptr));'));
  check('as_v_to_int / as_v_to_uint go through ToInt32 of the same number',
    pre.replace(/\s+/g, ' ').includes('if (v.tag == 6 && v.ptr != NULL) return as_to_int32(as_str_to_number(as_arr_to_str(v.ptr)));')
    && pre.replace(/\s+/g, ' ').includes('if (v.tag == 6 && v.ptr != NULL) return as_to_uint32(as_str_to_number(as_arr_to_str(v.ptr)));'));
  check('the loose-equality array branch stringifies against a string scalar',
    pre.includes("if (a.tag == 6 && bScalar) return (b.tag == 3) ? strcmp(as_arr_to_str(a.ptr), (char*)b.ptr) == 0")
    && pre.includes("if (b.tag == 6 && aScalar) return (a.tag == 3) ? strcmp(as_arr_to_str(b.ptr), (char*)a.ptr) == 0"));
  check('a NULL element joins as the string "null", not a NULL separator',
    pre.includes('as_array_join') && pre.includes('return (v.tag == 5) ? (char*)"," : as_v_str_val(v);'));

  // A dynamically-typed receiver must not hand an as_array* to as_dyn_call.
  const c = generateC(parse('var a:* = [1,2];\nvar s:String = a.toString();\ntrace(s);\n')).c;
  check('as_any_call routes a boxed array to as_arr_call (the segfault fix)',
    c.includes('if (v.tag == 6) return as_arr_call((as_array*)v.ptr, name, args, argc);'));
  check('...and keeps the final as_dyn_call fallthrough (records + Vector hooks)',
    c.includes('static as_value as_any_call(as_value v, const char* name, as_value* args, int argc) {')
    && /static as_value as_any_call\(as_value v, const char\* name, as_value\* args, int argc\) \{\s*v = as_req_box\(v\);\s*if \(v\.tag == 3\) return as_str_dyn_call\(\(char\*\)v\.ptr, name, args, argc\);\s*if \(v\.tag == 6\) return as_arr_call\(\(as_array\*\)v\.ptr, name, args, argc\);\s*return as_dyn_call\(v\.ptr, name, args, argc\);/.test(c.replace(/\r\n/g, '\n')));

  // join()'s separator: a dynamically-typed argument goes through as_join_sep so
  // null is the literal "null" while undefined selects "," (ES3 15.4.4.5).
  const j = generateC(parse('var a:Array = [1,2];\nvar q:* = null;\nvar s:String = a.join(q);\nvar t:String = a.join(null);\ntrace(s + t);\n')).c;
  check('a dynamically-typed join separator goes through as_join_sep',
    j.includes('as_array_join(((as_array*)as_req_obj((void*)(g_a))), as_join_sep(g_q))'));
  check('a statically-known null separator folds to the literal "null"',
    j.includes('as_array_join(((as_array*)as_req_obj((void*)(g_a))), "null")'));

  console.log(`     [arrprim] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ArrayToPrimitive', checkEmitArrayToPrimitive);

// ---- Function-value arity (#1063) and the qname in its message ----
// AIR builds every Function value with a fixed parameter list and raises
// TypeError... no: ArgumentError #1063 when it is invoked with fewer REQUIRED or
// more than ALLOWED arguments (measured on adl 51.4.1, temp/pkgA/arity{,2,3}:
// "(a:int)" with 0 or 2 args, "(a:int,b:int=2)" with 0 or 3, "(a:int=1)" with 2;
// a 0-parameter closure and any "..."rest signature accept any count). The guard
// must run BEFORE the thunk unboxes args[i] -- the old lenient behavior read a
// NULL args pointer for `f()` on a 1-parameter closure and crashed. The class
// half of the message is the method's qname: "<class>/<m>" for an instance,
// "<class>$/<m>" for a static, "Function/<name>" for a free function or a named
// function expression (`foo::Widget/m` for a packaged class).
function checkEmitFunctionArityQName(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fnarity] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fnarity] ${label}`); }
  };

  const src = 'class K2 {\n'
    + '  public function inst(a:int):void { }\n'
    + '  public static function stat(a:int):void { }\n'
    + '}\n'
    + 'function topfn(e:Error):void { }\n'
    + 'function restfn(...r):void { }\n'
    + 'function probe():void {\n'
    + '  var named:Function = function onError(e:Error):void { };\n'
    + '  var anon:Function = function(e:Error):void { };\n'
    + '  var zero:Function = function():void { };\n'
    + '  var opt:Function = function o(a:int = 1):void { };\n'
    + '  var fv:Function = topfn;\n'
    + '  var fr:Function = restfn;\n'
    + '  var k:K2 = new K2();\n'
    + '  var bm:Function = k.inst;\n'
    + '  var sm:Function = K2.stat;\n'
    + '  named(); anon(); zero(); opt(); fv(); fr(); bm(); sm();\n'
    + '}\nprobe();\n';
  const c = generateC(parse(src)).c;

  check('the #1063 helper carries AIR\'s exact message shape and error id',
    c.includes('parts[0] = "Error #1063: Argument count mismatch on ";')
    && c.includes('parts[2] = "(). Expected ";')
    && c.includes('parts[4] = ", got ";')
    && c.includes('as_throw(ArgumentError_new(as_str_concat_n(7, parts), 1063));'));

  check('a free function reports Function/<name>',
    c.includes('as_fn_arity_error("Function/topfn", 1, argc); return as_v_null(); }'));
  check('a named function expression reports Function/<its own name>',
    c.includes('as_fn_arity_error("Function/onError", 1, argc); return as_v_null(); }'));
  check('an anonymous closure is best-effort (AVM2\'s <file>.as$N index is not reproducible)',
    c.includes('as_fn_arity_error("Function/anonymous", 1, argc); return as_v_null(); }'));
  check('an instance method reports <class>/<method>',
    c.includes('as_fn_arity_error("K2/inst", 1, argc); return as_v_null(); }'));
  check('a static method reports <class>$/<method>',
    c.includes('as_fn_arity_error("K2$/stat", 1, argc); return as_v_null(); }'));

  // Guard placement + the two signatures AIR lets through with any count.
  const guard = c.indexOf('as_fn_arity_error("Function/topfn"');
  const unbox = c.indexOf('static as_value topfn__call(');
  check('the arity guard sits inside the thunk that unboxes args',
    unbox >= 0 && guard > unbox);
  // Both `anon` and `zero` are anonymous, so exactly ONE guard name appears:
  // the 1-parameter closure's. The 0-parameter one emits none at all.
  check('a 0-parameter closure emits NO guard (AIR treats it as variadic)',
    (c.match(/as_fn_arity_error\("Function\/anonymous"/g) || []).length === 1);
  check('...neither does a rest signature (max stays open)',
    !c.includes('as_fn_arity_error("Function/restfn"'));
  check('an optional-only signature still caps the upper bound (Expected 0)',
    /as_fn_arity_error\("Function\/o", 0, argc\)/.test(c));

  // The interface path must never leak the sanitized C identifier into a message.
  const i = generateC(parse('package foo { public interface IFoo { function m(a:int):void; } }\n'
    + 'package foo { public class Widget implements IFoo { public function Widget():void {} public function m(a:int):void {} } }\n'
    + 'package { import foo.IFoo; import foo.Widget; public class Main { public function go(i:IFoo, w:Widget):void { var f:Function = i.m; var g:Function = w.m; f(); g(); } } }\n'
    + 'var m:Main = new Main();\n')).c;
  check('an interface-typed bound method reports the AS3 name, not the C key',
    i.includes('as_fn_arity_error("foo::IFoo/m"') && !i.includes('as_fn_arity_error("foo_IFoo/m"'));
  check('a concrete bound method reports the pkg::Class/method spelling (AIR verbatim)',
    i.includes('as_fn_arity_error("foo::Widget/m"'));

  console.log(`     [fnarity] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/FunctionArityQName', checkEmitFunctionArityQName);

// ---- null-literal coercion per target kind ----
// `convert` folds a null literal to each target's default (measured on adl 51.4.1,
// temp/pkgA/vals.body.as): 0 into Number/int/uint, false into Boolean, NULL into
// String/Object/Array, and -- the trap -- a NULL {obj, vt} PAIR into an interface
// slot. Interfaces are by-value structs, so what is valid C for a pointer slot
// (`NULL`) is a type error for them; grouping interface with object/class emitted
// a bare `NULL` and Starling's `Vector.<IAnimatable>[i] = null` (Juggler) died at
// `clang`: "passing 'void *' to parameter of incompatible type
// 'starling_animation_IAnimatable'". Apple clang 21 rejects it too, so this is
// reachable from any build, not just emcc/LLVM clang at link time.
function checkEmitNullLiteralCoercion(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [nullco] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [nullco] ${label}`); }
  };

  const src = 'package { public interface ISmall { function m():void; }\n'
    + ' public class Impl implements ISmall { public function Impl():void{} public function m():void{} }\n'
    + ' public class Main {\n'
    + '   public function go(v:Vector.<ISmall>, i:int, o:Object, str:String):void {\n'
    + '     v[i] = null;\n'
    + '     var x:ISmall = null;\n'
    + '     var oo:Object = null;\n'
    + '     var ss:String = null;\n'
    + '     var nn:Number = null;\n'
    + '     var bb:Boolean = null;\n'
    + '   }\n'
    + ' }}\n'
    + 'var mm:Main = new Main();\n';
  const c = generateC(parse(src)).c.replace(/\r\n/g, '\n');

  // The vector-element write is the shape that regressed: an interface element
  // MUST be a null pair, and the bare pointer form must not survive anywhere.
  check('Vector.<Iface>[i] = null writes a null {obj, vt} pair',
    c.includes('as_vector_ISmall_set(((as_vector_ISmall*)as_req_obj((void*)(v))), i, (ISmall){ NULL, NULL });'));
  check('...and the interface element setter takes the struct BY VALUE',
    c.includes('static void as_vector_ISmall_set(as_vector_ISmall* v, int i, ISmall e) {'));
  check('no as_vector_*_set call passes a bare NULL for an interface element',
    !/as_vector_ISmall_set\([^;]*,\s*(?:\(void\*\))?NULL\)/.test(c));

  // An interface-typed local/assignment must also fold to the null pair.
  check('var x:Iface = null declares an initialised null pair',
    c.includes('ISmall x = (ISmall){ NULL, NULL };'));

  // The pointer and scalar slots keep their (unchanged) pointer/scalar defaults.
  check('Object slot still takes a bare NULL',
    c.includes('Object* oo = NULL;'));
  check('String slot still takes a bare NULL (not the literal "null")',
    c.includes('char* ss = NULL;'));
  // The declaration itself default-initialises to the type's zero value (Number
  // -> NAN, per AS3's uninitialised `var`), so the null fold is visible on the
  // assignment that follows it.
  check('Number slot folds to 0.0 (not (double)(NULL))',
    c.includes('nn = 0.0;') && !c.includes('(double)(NULL)'));
  check('Boolean slot folds to false',
    c.includes('bool bb = false;'));

  console.log(`     [nullco] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/NullLiteralCoercion', checkEmitNullLiteralCoercion);

// ---- dynamic value into a TYPED scalar slot: coerce, never reinterpret ----
// A dynamically-typed (`*`) value landing in an int/uint/Boolean/Number/String
// slot is an AS3 COERCION (ToInt32 / ToUint32 / ToBoolean / ToNumber), not a
// reinterpretation of the boxed union. The runtime has two families of unboxers:
//   as_v_int_val / as_v_uint_val / as_v_bool_val / as_v_num_val -- raw: they read
//     the union's .num word, which is 0/false for a String tag;
//   as_v_to_int / as_v_to_uint / as_v_truthy / as_v_to_number / as_coerce_str --
//     coercing: a String parses or stringifies, exactly as int()/Boolean() do.
// Using the raw family at a coercion site silently produced 0/false for a
// string-valued dynamic source. Measured against adl 51.4.1 with temp/pkgA/
// unboxcoerce + coerce2/3/5 + arrkey (`var i:int = arr[0]` with arr[0]=="7" is 7;
// sp.tabIndex = "7" stores 7; ("5":*) | 0 is 5; Vector.<int>.push.apply(v,["5"])
// pushes 5; v["length"] = "2" resizes). The examples suite cannot see any of it:
// every one of those needs a `*` source, and a wrong 0 still compiles and runs.
function checkEmitDynamicSlotCoercion(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dynco] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dynco] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const gen = (src: string): string => generateC(parse(src)).c.replace(/\r\n/g, '\n');

  // 1. The preamble must keep the coercing helpers total for a String tag; the
  //    raw ones must not become coercing by accident (they sit in hot paths).
  //    A boxed String goes through ES3 ToNumber (so "10x" is NaN->0 and "0x10"
  //    is 16) -- the same rule int(String) uses.
  check('as_v_to_int parses a boxed String with ES3 ToNumber (ToInt32)',
    pre.includes('if (v.tag == 3) return as_to_int32(as_str_to_number((char*)v.ptr));'));
  check('as_v_to_uint parses a boxed String with ES3 ToNumber (ToUint32)',
    pre.includes('if (v.tag == 3) return as_to_uint32(as_str_to_number((char*)v.ptr));'));
  check('a static String reaches int()/uint()/Number() through the same parser',
    gen('var s:String = "10x";\ntrace(int(s), uint(s), Number(s));\n').includes('as_to_int32(as_str_to_number(g_s))')
    && gen('var s:String = "10x";\ntrace(int(s), uint(s), Number(s));\n').includes('as_to_uint32(as_str_to_number(g_s))')
    && gen('var s:String = "10x";\ntrace(int(s), uint(s), Number(s));\n').includes('as_str_to_number(g_s)'));
  check('...and never the C prefix parsers (atoi/atof would say 10 for "10x")',
    !/\b(?:atoi|atof)\(g_s\)/.test(gen('var s:String = "10x";\ntrace(int(s), uint(s), Number(s));\n')));
  check('parseInt/parseFloat keep their own PREFIX parsers (per spec)',
    gen('var s:String = "1x";\ntrace(parseInt(s), parseFloat(s));\n').includes('atoi(g_s)')
    && gen('var s:String = "1x";\ntrace(parseInt(s), parseFloat(s));\n').includes('atof(g_s)'));
  check('as_v_truthy treats a non-empty boxed String as true',
    pre.includes('case 3: return v.ptr != NULL && ((char*)v.ptr)[0] != 0;'));
  check('as_coerce_str stringifies a boxed Number for a String slot',
    pre.includes('case 1: return as_str_from_double(v.num);'));
  // The raw helper is still what the hot element paths use, so it must NOT grow
  // the String branch (that would be a silent behaviour change in the GC/array
  // read path); it stays a pure union read.
  check('as_v_int_val stays a raw union read (no String branch)',
    pre.includes('static int as_v_int_val(as_value v)     { return (v.tag == 8 || v.tag == 9) ? as_v_to_int(v) : as_to_int32(v.num); }'));

  // 1b. The emitter's coercion sites use the inlinable cast spelling. The general
  //     coercer is deliberately OVER the inline threshold (it calls the ES3
  //     ToNumber parser), so emitting it inside a loop costs an out-of-line call
  //     per iteration -- 169 ms vs 116 ms on benchmarks/array's 20M-iteration
  //     `sum += a[j]` (measured with clang -Rpass-missed=inline, 2025-10). The
  //     cast helpers must therefore (a) exist, (b) be cheap enough for clang to
  //     inline, and (c) delegate EVERY other tag to the general helper so the
  //     coercion rules still exist exactly once.
  check('the inlinable int/uint cast spellings exist',
    pre.includes('static int as_v_int_cast(as_value v) {')
    && pre.includes('static unsigned as_v_uint_cast(as_value v) {'));
  check('the hot path is the numeric tags 1/2 only, read straight from num',
    pre.includes('if (v.tag == 1 || v.tag == 2) return as_to_int32(v.num);')
    && pre.includes('if (v.tag == 1 || v.tag == 2) return as_to_uint32(v.num);'));
  check('every other tag (String/Array/64-bit/null/obj) delegates to the general helper',
    /static int as_v_int_cast\(as_value v\) \{\s*if \(v\.tag == 1 \|\| v\.tag == 2\) return as_to_int32\(v\.num\);\s*return as_v_to_int\(v\);\s*\}/.test(pre)
    && /static unsigned as_v_uint_cast\(as_value v\) \{\s*if \(v\.tag == 1 \|\| v\.tag == 2\) return as_to_uint32\(v\.num\);\s*return as_v_to_uint\(v\);\s*\}/.test(pre));

  // 2. Every coercion site in the emitter must name the coercing helper.
  const src = 'package { public class Main {\n'
    + '  public function go(a:Array):void {\n'
    + '    var ai:int = a[0]; var au:uint = a[0]; var ab:Boolean = a[0]; var an:Number = a[0]; var as_:String = a[0];\n'
    + '  }\n'
    + ' }}\n'
    + 'var m:Main = new Main();\n';
  const c = gen(src);
  check('dynamic -> int coerces', c.includes('as_v_int_cast(g_a->data[0])') || /ai = as_v_int_cast\(/.test(c));
  check('dynamic -> uint coerces', /au = as_v_uint_cast\(/.test(c));
  check('dynamic -> Boolean coerces (ToBoolean, so "x" is true)', /ab = as_v_truthy\(/.test(c));
  check('dynamic -> Number coerces', /an = as_v_to_number\(/.test(c));
  check('dynamic -> String coerces', /as_ = as_coerce_str\(/.test(c));
  check('no dynamic->typed-slot assignment still uses a raw unboxer',
    !/\b(?:ai|au|ab|an|as_) = as_v_(?:int_val|uint_val|bool_val|num_val)\(/.test(c));
  check('a coercion site never calls the general (non-inlinable) helper directly',
    !/\b(?:ai|au) = as_v_to_(?:int|uint)\(/.test(c));

  // 3. Bitwise operators apply ToInt32 to a dynamic operand.
  const bit = gen('var d:* = "5";\nvar r:int = d | 0;\nvar q:uint = d >>> 1;\ntrace(r + q);\n');
  check('dynamic operand of a bitwise op coerces through as_v_int_cast',
    bit.includes('as_v_int_cast(g_d)') && !bit.includes('as_v_int_val(g_d)'));
  check('dynamic operand of >>> coerces through as_v_uint_cast',
    bit.includes('as_v_uint_cast(g_d)'));

  // 4. A dynamic write into a typed FIELD (vtable reflection) coerces.
  check('as_dyn_set writes a double field with as_v_to_number',
    pre.includes('case 1: *(double*)(base + props[i].offset) = as_v_to_number(v); return;'));
  check('as_dyn_set writes a bool field with as_v_truthy',
    pre.includes('case 2: *(bool*)(base + props[i].offset) = as_v_truthy(v); return;'));
  check('as_dyn_set writes an int field with as_v_to_int',
    pre.includes('case 4: *(int*)(base + props[i].offset) = as_v_to_int(v); return;'));
  check('as_dyn_set writes a uint field with as_v_to_uint',
    pre.includes('case 5: *(unsigned*)(base + props[i].offset) = as_v_to_uint(v); return;'));
  // ...while the 64-bit fields were already coercing; keep them that way.
  check('as_dyn_set keeps the 64-bit fields coercing',
    pre.includes('case 8: *(int64_t*)(base + props[i].offset) = as_v_to_i64(v); return;')
    && pre.includes('case 9: *(uint64_t*)(base + props[i].offset) = as_v_to_u64(v); return;'));

  // 5. Array `length` written through a DYNAMIC receiver resizes (AIR: 5), and
  //    the routing must not fall back to the named-property table.
  check('a dynamic Array write routes keys through as_array_key_set',
    pre.includes('if (dk == 2) { as_array_key_set((as_array*)obj, key, v); return; }'));
  check('as_any_set routes a boxed Array through as_array_key_set',
    pre.replace(/\s+/g, ' ').includes('case 6: { // Route through the same key classifier the literal form uses'));
  check('as_array_key_set resizes on "length" with UINT semantics',
    pre.includes('if (strcmp(key, "length") == 0) { as_array_set_length(a, as_v_to_uint(v)); return; }'));

  // 6. The dynamic-dispatch helpers and the vector spread-push coerce their
  //    arguments too -- those are typed parameters reached without any static
  //    check at all, so a String argument used to land as 0.
  const vc = gen('var v:* = new <int>[10,20,30];\nvar k:* = "1";\ntrace(v.removeAt(k));\n');
  check('a dynamic-receiver Vector method coerces its int argument',
    vc.includes('as_vector_int_removeAt(v, as_v_int_cast(args[0]))'));
  const sc = gen('var s:* = "abcdef";\nvar k:* = "1";\ntrace(s.charAt(k));\n');
  check('a dynamic-receiver String method coerces its int argument',
    sc.includes('as_str_charAt(s, as_v_int_cast(args[0]))'));
  const pc = gen('var v:Vector.<int> = new <int>[];\nv.push.apply(v, ["5","6"]);\ntrace(v.join(","));\n');
  check('Vector.<T>.push.apply coerces each dynamic element',
    pc.includes('as_v_int_cast(a->data[i])') && !pc.includes('as_v_int_val(a->data[i])'));

  console.log(`     [dynco] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DynamicSlotCoercion', checkEmitDynamicSlotCoercion);

// ---- GC free-list size classes ----
// Free blocks are graded: gc_free_small[] holds blocks in 32-byte size windows,
// gc_free_mid holds the rest below GC_BIG_CLASS, gc_free_big the rest. Before the
// classes, EVERY block under GC_BIG_CLASS shared one list walked from the head
// with an `h->size >= size` test, and since the runtime allocates millions of
// same-sized short strings that walk degraded to O(list length) per allocation
// (~36% of the strings benchmark). The invariant that keeps it sound is that a
// block is released onto the class of its TRUE size and allocation re-checks
// h->size >= size within the class it starts from -- otherwise a block handed out
// for a request larger than its size is a buffer overflow, and the class arrays
// are the only reason gc_find_block can stop at a list head.
function checkRuntimeGcSizeClasses(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [gcclass] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [gcclass] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
  const flat = pre.replace(/\s+/g, ' ');

  check('the class array and the two residual lists exist',
    flat.includes('static gc_header* gc_free_small[GC_SMALL_CLASSES];')
    && flat.includes('static gc_header* gc_free_mid = NULL;')
    && flat.includes('static gc_header* gc_free_big = NULL;'));
  check('the old single small list is gone (nothing aliases it)',
    !/static gc_header\* gc_free = NULL;/.test(flat) && !/\bgc_free_for\(/.test(flat));
  check('the class window is one GC_SMALL_ALIGN wide, below GC_BIG_CLASS',
    flat.includes('#define GC_SMALL_ALIGN 32u')
    && flat.includes('#define GC_SMALL_CLASSES 16')
    && flat.includes('#define GC_SMALL_MAX (GC_SMALL_ALIGN * GC_SMALL_CLASSES)'));
  check('release grade is the FLOOR class of the block size',
    flat.includes('static int gc_small_class(size_t size) { if (size >= GC_SMALL_MAX) return -1; return (int)(size / GC_SMALL_ALIGN); }'));
  check('a class block is released under its true size, mid/big split at GC_BIG_CLASS',
    flat.includes('int i = gc_small_class(size); if (i >= 0) return &gc_free_small[i]; return size >= GC_BIG_CLASS ? &gc_free_big : &gc_free_mid;'));
  check('allocation re-checks h->size >= size while walking a class',
    flat.includes('for (gc_header* h = *list; h != NULL; prev = h, h = h->next) { gc_audit_gate("free-list node", h); if (h->size >= size) { *out_head = list; *out_prev = prev; return h; } }'));
  check('a small request climbs from its own class; a big request only uses the big list',
    flat.includes('bool big = size >= GC_BIG_CLASS; int first = big ? GC_SMALL_CLASSES + 1 : gc_small_class(size);')
    && flat.includes('if (!big && first < 0) first = GC_SMALL_CLASSES;')
    && flat.includes('int last = big ? GC_SMALL_CLASSES + 1 : GC_SMALL_CLASSES;'));
  check('gc_alloc takes its block from gc_find_block, then splits/charges as before',
    flat.includes('gc_header* h = gc_find_block(size, &head, &prev); if (h != NULL) {')
    && flat.includes('gc_seg_range* _sr = gc_seg_find(h);'));
  check('the freshly-carved segment does not shadow the search block pointer',
    flat.includes('gc_header* fresh = (gc_header*)s->base;')
    && flat.includes('gc_header** hl = gc_free_list_for(fresh->size);'));
  check('the sweeper releases onto the graded list for the block size',
    flat.includes('gc_header** fl = gc_free_list_for(h->size);'));
  // The accounting/diagnostics walks must cover every list, not just the two old
  // ones -- a missed list means free_bytes drifts and the segment release pass
  // hands back a segment that still holds live objects (the historical SIGSEGV).
  const walks = flat.match(/GC_SMALL_CLASSES \+ 2/g) || [];
  check('every free-list walk iterates all classes plus mid and big (4 sites)',
    walks.length >= 4 && flat.includes('static gc_header** gc_free_list_at(int i) {'));
  check('the release pass rebuilds the class lists in place',
    flat.includes('for (int li = 0; li < GC_SMALL_CLASSES + 2; li++) { gc_header** listp = gc_free_list_at(li);'));

  console.log(`     [gcclass] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/GcSizeClasses', checkRuntimeGcSizeClasses);

// The memory-query hot path (阶段一百二十一). System.totalMemory/freeMemory sum
// gc_heap_used_bytes(); that used to be a linear walk of gc_all, i.e. O(live
// objects) -- at the Starling demo's ~800k live objects one StatsDisplay update
// (every 0.5 s, and it polls totalMemory) cost 6.4 ms and the frame overran two
// vsyncs. The fix is an O(1) mirror maintained wherever a block is linked or
// unlinked, with the walk kept only as the ASC_GC_AUDIT cross-check. Both halves
// are load-bearing: drop a mirror bump and totalMemory silently drifts, put the
// walk back on the fast path and the half-second stall returns.
function checkRuntimeMemoryQueryO1(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [memq] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [memq] ${label}`); }
  };
  const flat = RUNTIME_PREAMBLE.replace(/\s+/g, ' ');

  check('gc_heap_used_bytes returns the mirror, not a walk',
    flat.includes('static size_t gc_heap_used_bytes(void) { if (gc_audit_on()) {')
    && flat.includes('return gc_all_bytes; }'));
  check('the only walk left is the ASC_GC_AUDIT cross-check',
    (flat.match(/for \(gc_header\* h = gc_all; h != NULL; h = h->next\) walk/g) || []).length === 1
    && flat.includes('if (walk != gc_all_bytes)'));
  check('one bump per list-mutation site (alloc x2, sweep unlink x1)',
    (flat.match(/gc_all_bytes \+= sizeof\(gc_header\) \+ h->size;/g) || []).length === 1
    && (flat.match(/gc_new_bytes \+= sizeof\(gc_header\) \+ h->size;/g) || []).length === 1
    && (flat.match(/gc_all_bytes -= sizeof\(gc_header\) \+ h->size;/g) || []).length === 1);
  check('gc_alloc links into gc_all/gc_new and bumps the matching mirror',
    flat.includes('gc_all = h; gc_all_bytes += sizeof(gc_header) + h->size;')
    && flat.includes('gc_new = h; gc_new_bytes += sizeof(gc_header) + h->size;'));
  check('the sweeper subtracts as it unlinks',
    flat.includes('gc_all = next; gc_all_bytes -= sizeof(gc_header) + h->size;'));
  check('both gc_new splices fold the pending bytes into the mirror',
    flat.includes('gc_all_bytes += gc_new_bytes; gc_new_bytes = 0; gc_new = NULL;')
    && flat.includes('gc_all_bytes += gc_new_bytes; gc_new_bytes = 0; for (gc_header* h = gc_new;'));
  check('the memory API still reads the mirror through gc_heap_used_bytes',
    (flat.match(/gc_heap_used_bytes\(\)/g) || []).length >= 3);

  console.log(`     [memq] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/MemoryQueryO1', checkRuntimeMemoryQueryO1);

// ---- Closure `this` capture vs a module-level variable shadowing a getter ----
// A bare identifier inside a closure must be resolved the SAME way the emitter
// resolves it, or the capture analysis records the wrong free variables and the
// closure body is emitted with a receiver it never captured (`use of undeclared
// identifier 'this'`). The concrete case (found while building the vsync event's
// windowed probe): the `--air-app` bootstrap declares a top-level `var stage`, and
// `emitVarLexical` deliberately lets the class win inside a class method -- a
// top-level `stage` never shadows `DisplayObject.stage` there, because the module
// scope is only read when `currentClass === null`. The walk's shadow test did
// consult the module frame, so `stage` looked like a local, the getter check was
// skipped, and `this` was never captured. Measured on a plain compile of
// temp/anonthis/stageshadow.as before/after the fix; the `--air-app` bootstrap
// emits exactly this shape.
function checkEmitClosureThisCapture(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [closthis] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [closthis] ${label}`); }
  };

  // A module-level `var stage` (what --air-app's bootstrap emits) plus a class
  // whose ctor installs a closure reading bare `stage` -- and NOTHING else: a
  // sibling name like `width` would set needsThis on its own and mask the defect
  // (verified by reverting the fix against this exact program).
  const c = generateC(parse('import flash.display.Sprite;\n'
    + 'import flash.display.Stage;\n'
    + 'import flash.utils.Timer;\n'
    + 'import flash.events.TimerEvent;\n'
    + 'var stage:Stage = new Stage();\n'
    + 'class Shadow extends Sprite {\n'
    + '  public function Shadow() {\n'
    + '    var t:Timer = new Timer(1000);\n'
    + '    t.addEventListener(TimerEvent.TIMER, function (e:*):void { trace("x=" + stage); });\n'
    + '    t.start();\n'
    + '  }\n'
    + '}\n'
    + 'var s:Shadow = new Shadow();\n')).c;

  check('the closure captures the receiver into its env struct',
    c.includes('typedef struct { void (*mark)(void*); Shadow* this; } _fn0_env;')
    && c.includes('as_fn_make(_fn0__call, _fn0_env_make(this), 1)'));
  check('a module-level `stage` does not stop the getter from setting needsThis',
    c.includes('env->this->vtable->get_stage(env->this)'));
  // Independent control: with no module-level `width`, the same shape must still
  // work (this half passed even before the fix, which is what hid the defect).
  const cw = generateC(parse('import flash.display.Sprite;\n'
    + 'class Wide extends Sprite {\n'
    + '  public function go():void {\n'
    + '    var f:Function = function ():void { trace("w=" + width); };\n'
    + '    f();\n'
    + '  }\n'
    + '}\n')).c;
  check('...and the sibling DisplayObject getter still resolves the same way',
    cw.includes('env->this->vtable->get_width(env->this)'));
  // No emitted closure body may mention a receiver without having captured it:
  // strip the legal `env->this` form, then a bare `this` (or `this->`) anywhere in
  // an impl body means the capture was missed.
  const impls = c.match(/static void _fn\d+__impl\(_fn\d+_env\* env[^)]*\) \{[\s\S]*?\n\}/g) || [];
  check('every closure impl reaches its receiver through env->this', impls.length > 0
    && impls.every((b) => !/[^>A-Za-z0-9_]this\b/.test(b.replace(/env->this/g, 'ENVRECV'))));

  // Control: OUTSIDE a class method the module scope IS the resolution, so a
  // top-level closure reads the C global and does not capture `this` at all.
  const c2 = generateC(parse('var stage:Object = { frameRate: 24 };\n'
    + 'var t:Object = null;\n'
    + 'function go():void { t = function ():void { trace(stage); }; }\n'
    + 'go();\n')).c;
  check('a top-level closure still reads the module variable as a C global',
    /trace\(\(as_obj_to_str\(\(as_value\)[^)]*g_stage/.test(c2) || c2.includes('g_stage'));
  check('...and therefore has no receiver in its env', !/struct \{ void \(\*mark\)\(void\*\); Object\* this; \}/.test(c2));

  console.log(`     [closthis] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ClosureThisCapture', checkEmitClosureThisCapture);
