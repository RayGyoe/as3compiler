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
import { FRE_BODY } from '../../src/fre.ts';
import { SymbolTable, C_RESERVED, C_RESERVED_SCOPE, sanitizeCIdent, sanitizeFileCIdent } from '../../src/symbols.ts';
import { C_RESERVED_HEADERS } from '../../src/c-reserved.gen.ts';
import { registerGroup, root, readNorm } from '../harness.ts';

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
    gen('var s:String = "1x";\ntrace(parseInt(s), parseFloat(s));\n').includes('as_parse_int(g_s, 0.0)')
    && gen('var s:String = "1x";\ntrace(parseInt(s), parseFloat(s));\n').includes('as_parse_float(g_s)'));
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
    flat.includes('for (gc_header* h = *list; h != NULL; prev = h, h = h->next) { if (gc_audit_mode_cache != 0) gc_audit_gate("free-list node", h); if (h->size >= size) { *out_head = list; *out_prev = prev; return h; } }'));
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

// E4X `list.@attr` in a scalar (String) context is the CONCATENATION of every
// item's attribute value in document order (adl-measured, temp/qfix/xmlattr.body.as):
// two items at="1"/at="2" give "12", not "1". The single-element shape is covered
// end to end by examples/stage91.as; the multi-element list helper is only reached
// through the runtime text, so it is pinned here.
function checkEmitE4xListAttrScalar(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [e4x] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [e4x] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('as_xml_list_attr concatenates every item (E4X scalar context)',
    pre.includes('out = (out == NULL) ? v : as_str_concat(out, v);'));
  check('...and no longer short-circuits on the first non-empty value',
    !/if \(v\[0\] != 0\) return v;/.test(pre));
  check('the single-item fast path still returns the raw attribute value',
    pre.includes('if (l->length == 1) return as_xml_attr(l->items[0], name);'));
  console.log(`     [e4x] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: e4x/ListAttrScalar', checkEmitE4xListAttrScalar);

// E4X string value + the ByteArray arm of XML(value) (阶段一百四十三). MEASURED on
// adl 51.4.1 (temp/tkmeet-mac/xmlstr, temp/tkmeet-mac/xmlba):
//   * XML.toString() is the E4X STRING VALUE, not the markup -- a text node yields
//     its text, and an element with NO element children yields its text content
//     ("<a b='1'>txt</a>" -> "txt", "<a b='1'/>" -> ""), while an element WITH
//     element children yields the markup.
//   * XMLList.toString() delegates for a ONE-item list ("a") and joins the items'
//     MARKUP with a newline for several.
//   * XML(value) accepts a ByteArray and parses its bytes as UTF-8 markup -- the
//     `[Embed(mimeType="application/octet-stream")]` + `XML(new Cls())` idiom that
//     Config/Language.as relies on (it used to fail loudly).
// The rules live in the runtime preamble, the wiring in the emitter, so both halves
// are pinned here; examples/xml-embed.as covers them end to end.
function checkEmitE4xStringValue(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [e4xstr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [e4xstr] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  // as_xml_from_value is emitted by the emitter (not the runtime preamble), so the
  // ByteArray arm has to be pinned against generated C.
  const c = generateC(parse('var doc:XML = new XML("<a/>");\ntrace(doc.toString());\n')).c;
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
  check('XML(byteArray) parses the payload instead of failing loudly',
    c.includes('if (v.tag == 4 && as_is(as_v_obj_val(v), &ByteArray_vt)) return as_xml_parse_bytes_checked((ByteArray*)as_v_obj_val(v));'));
  check('the residual loud message names ByteArray too',
    c.includes('"XML(value) is only supported for String, XML and ByteArray values by this subset"'));
  // 阶段一百四十七: a String handed to AS3 is a VALUE, so the XML readers copy out
  // of the node (as_str_dup) instead of lending the node's own buffer. Lending it
  // left ~1000 Language statics pointing into a parsed tree that then died, and
  // the freed blocks corrupted the GC free list (SIGSEGV in gc_sweep_step).
  // 阶段二百零八: the element/childless test became "no ELEMENT child" -- an element
  // whose content is only text (now possibly several runs) still reduces to text.
  check('as_xml_string_value copies the node text',
    pre.includes('if (!has_elem) return as_str_dup(n->text ? n->text : "");'));
  check('…and the text-node branch copies too',
    pre.includes('if (!n->name) return as_str_dup(n->text ? n->text : "");'));
  check('...and falls back to the markup serializer otherwise',
    pre.includes('return as_xml_to_string(n);'));
  check('a one-item XMLList delegates to the item string value',
    pre.includes('if (l->length == 1) return as_xml_string_value(l->items[0]);'));
  check('a multi-item XMLList joins item markup with a newline',
    pre.includes('if (i > 0) out = as_str_concat(out, "\\n");'));
  // Wiring: XML.toString() must lower to the string-value helper (the markup
  // serializer now serves only the runtime's own recursion / list fallback).
  check('XML.toString() lowers to as_xml_string_value',
    count(c, 'as_xml_string_value') > count(pre, 'as_xml_string_value'));
  // Dynamic-path wiring: a value that travels through an Object/*/Array/dynamic slot
  // is stringified by the object vtable, not by the emitter, so the vtable's
  // box_to_str slot must be the E4X string value -- otherwise every label the real
  // app resolves out of an XML document renders "[object XML]".
  // The three int slots before the toString hook are is_proxy / is_dynamic /
  // is_final; the last one is what describeType reports as <type isFinal="...">
  // (XML is final in AIR, Object is not).
  check('the XML vtable stringifies through as_xml_box_to_str',
    pre.includes('static as_object_vtable as_xml_vt = { "XML", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XML", 0, 0, 1, as_xml_box_to_str,'));
  check('the XMLList vtable stringifies through as_xml_list_box_to_str',
    pre.includes('static as_object_vtable as_xml_list_vt = { "XMLList", &as_object_vt, NULL, NULL, NULL, NULL, NULL, -1, "XMLList", 0, 0, 1, as_xml_list_box_to_str,'));
  check('...and both helpers delegate to the string-value rules',
    pre.includes('static char* as_xml_box_to_str(void* o) { return as_xml_string_value((as_xml_node*)o); }')
    && pre.includes('static char* as_xml_list_box_to_str(void* o) { return as_xml_list_to_string((as_xml_list*)o); }'));
  console.log(`     [e4xstr] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: e4x/StringValue', checkEmitE4xStringValue);
// ---- E4X markup serialisation (`toXMLString()`), 阶段一百九十三 ----------------
// `toXMLString()` used to be a LOUD CodegenError (TODO.md leftover row "E4X 序列化
// 残差"). It now lowers to the runtime markup serialiser, and that serialiser
// re-indents the way adl does instead of keeping the source form. Every rule pinned
// here was measured on adl 51.4.1 (temp/toxml/: mxmlc + adl, XML and XMLList);
// examples/e4x-toxmlstring.as carries the values end to end.
function checkEmitE4xToXMLString(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [toxml] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [toxml] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
  // Wiring is only observable in the generated C: the emitter decides the lowering.
  // A CodegenError here is a MISSING lowering, not a harness crash -- record it as a
  // failed label so this group reports the reason instead of dying whole.
  const gen = (src: string): string => {
    try { return generateC(parse(src)).c; }
    catch (e) { return '<<codegen error: ' + String(e) + '>>'; }
  };
  const cXml = gen('var doc:XML = new XML("<a/>");\ntrace(doc.toXMLString());\n');
  const cList = gen('var doc:XML = new XML("<r><i>a</i></r>");\nvar l:XMLList = doc.i;\ntrace(l.toXMLString());\n');
  check('toXMLString() on an XML lowers to the markup serialiser',
    cXml.includes('as_xml_to_string('));
  check('toXMLString() on an XMLList lowers to the LIST markup helper',
    cList.includes('as_xml_list_to_xml_string('));
  check('…and the emitted call is the list MARKUP helper',
    count(cList, 'as_xml_list_to_xml_string') >= 2); // once as the definition, once as the call
  check('…never the string-value helper at the call site',
    !/as_xml_list_to_string\(\(\(/.test(cList));
  // The shape rules. A childless element stays INLINE; an element with element
  // children puts one item per line and indents the closing tag back to its level.
  check('a childless element self-closes',
    pre.includes('if (n->child_count == 0) {')
    && pre.includes('as_xml_append(&out, &len, &cap, "/>", 2);'));
  check('children are serialised one level deeper',
    pre.includes('char* cs = as_xml_markup(n->children[i], level + 1);'));
  check('the item indent is one level deeper than the element',
    pre.includes('as_xml_indent(ib, level + 1);'));
  check('the closing tag returns to the element own level',
    pre.includes('as_xml_indent(ib, level);'));
  check('indentation is two spaces per level',
    pre.includes("for (int i = 0; i < level && ind < 62; i++) { buf[ind++] = ' '; buf[ind++] = ' '; }"));
  // Whitespace-only text is pruned at PARSE time, which is why <a> </a> prints as
  // <a/> and not <a></a> -- the reason the inline branch above can be trusted.
  // 阶段二百零八 moved that pruning into as_xml_text_run (a run that is whitespace
  // IN THE SOURCE is dropped, while one that only BECOMES whitespace after entity
  // decoding keeps an empty node: <a>&#32;</a> prints <a></a>, as adl does).
  check('a whitespace-only source run is dropped by the parser',
    pre.includes('if (a == b) return NULL;'));
  // toXMLString is the markup, ALWAYS: unlike toString() it must not reduce a
  // childless element to its text, and a one-item XMLList keeps its item's markup.
  check('the XML markup branch is reachable without the child-count test',
    pre.includes('static char* as_xml_to_string(as_xml_node* n) { return as_xml_markup(n, 0); }'));
  // A substring that occurs in TWO helpers cannot pin either one: `as_xml_list_to_string`
  // and `as_xml_list_to_xml_string` differ only in which reader they call per item.
  // Extract the body under test, so the pin discriminates the helper it names.
  const bodyOf = (name: string): string => {
    const i = pre.indexOf('static char* ' + name + '(');
    if (i < 0) return '<<no such helper>>';
    return pre.slice(i, pre.indexOf('\n}\n', i) + 3);
  };
  check('a one-item XMLList keeps the item MARKUP for toXMLString',
    bodyOf('as_xml_list_to_xml_string').includes('as_xml_to_string(l->items[i])')
    && !bodyOf('as_xml_list_to_xml_string').includes('as_xml_string_value'));
  check('…while toString() of a one-item XMLList still delegates to the string value',
    bodyOf('as_xml_list_to_string').includes('if (l->length == 1) return as_xml_string_value(l->items[0]);'));
  // The attribute quote is built as a char array, not as an escaped literal: the
  // preamble is a TS template literal, so "\\\"" in the source would reach the C
  // half-eaten (see the as_xml_markup comment). Pin the working form.
  check('attributes are quoted with a char array, not an escaped literal',
    pre.includes("char q[2]; q[0] = '\"'; q[1] = 0;"));
  console.log(`     [toxml] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: e4x/ToXMLString', checkEmitE4xToXMLString);

// ---- E4X text nodes, mixed content and entities (阶段二百零八) ----------------
// The three residuals of TODO.md's "E4X 序列化残差" row all lived in the PARSER:
//   ① new XML("plaintext") must build a TEXT node, not fail;
//   ② text runs and elements must keep DOCUMENT ORDER (the DOM used to have a
//     single `text` slot, so every run was folded into one blob);
//   ③ entities must decode on input, which is what forces the serialiser to
//     escape -- per context, with the two different sets adl uses.
// Every rule pinned here was measured on adl 51.4.1; the differential probe is
// temp/e4xres/diff/ (63 records, byte-identical) and the end-to-end assertions
// live in examples/e4x-text-mixed.as.
function checkEmitE4xTextNodes(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [e4xtext] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [e4xtext] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const gen = (src: string): string => {
    try { return generateC(parse(src)).c; }
    catch (e) { return '<<codegen error: ' + String(e) + '>>'; }
  };

  // ---- the node model ----
  check('a text node is an as_xml_node with no name',
    pre.includes('static as_xml_node* as_xml_text_new(char* text, int cdata) {')
    && pre.includes('as_xml_node* n = as_xml_node_new(NULL);'));
  check('…and carries a CDATA flag for the MARKUP form only',
    pre.includes('int cdata;') && pre.includes('n->cdata = cdata;'));

  // ---- ① text-only input ----
  // The "<" search decides the whole branch: without markup the input IS a text
  // node, so new XML("") / new XML("   ") / new XML("plaintext") all succeed.
  check('an input with no markup builds a text node',
    pre.includes('int has_markup = 0;')
    && pre.includes('if (!has_markup) {'));
  check('…and whitespace-only text still yields an EMPTY node, not NULL',
    pre.includes('if (t == NULL) t = as_str_empty();'));

  // ---- ② mixed content ----
  check('text runs become children in document order',
    pre.includes('as_xml_buf_push(&children, (void*)as_xml_text_new(t, 0));'));
  check('the element text cache is rebuilt from those children',
    pre.includes('c->name == NULL && c->text != NULL) ttotal += strlen(c->text);'));

  // ---- ③ entities ----
  check('the five predefined entities decode',
    pre.includes('strncmp(nm, "amp", 3)') && pre.includes('strncmp(nm, "apos", 4)'));
  check('&nbsp; decodes to the code point AIR reports (U+FFA0, not U+00A0)',
    pre.includes('else if (nl == 4 && strncmp(nm, "nbsp", 4) == 0) cp = 0xFFA0u;'));
  check('numeric references decode in both bases',
    pre.includes('if (nm[k] == \'x\' || nm[k] == \'X\') { base = 16; k++; }'));
  check('…but anything above the BMP stays VERBATIM (as adl leaves it)',
    pre.includes('if (ok && v != 0 && v <= 0xFFFFu) cp = v;'));
  check('a decoded code point is UTF-8 encoded',
    pre.includes('static int as_xml_utf8_put(unsigned int cp, char* out) {'));

  // ---- the serialiser side of ③: two DIFFERENT escape sets ----
  const esc = pre.slice(pre.indexOf('static void as_xml_append_esc('),
    pre.indexOf('// MARKUP serialiser'));
  check('text escapes & < > only',
    esc.includes('if (c == \'&\') as_xml_append(outp, lenp, capp, "&amp;", 5);')
    && esc.includes('else if (c == \'>\' && mode == 0) as_xml_append(outp, lenp, capp, "&gt;", 4);'));
  check('attribute values ALSO escape the quote',
    esc.includes('else if (c == \'"\' && mode == 1) as_xml_append(outp, lenp, capp, "&quot;", 6);'));
  check('…and write whitespace as numeric references (attribute normalisation)',
    esc.includes('"&#xA;", 5') && esc.includes('"&#xD;", 5') && esc.includes('"&#x9;", 5'));
  check('an attribute > stays raw (mode 1 has no &gt; arm)',
    esc.includes('c == \'>\' && mode == 0'));
  check('CDATA content is written literally, never escaped',
    pre.includes('as_xml_append(&out, &len, &cap, "<![CDATA[", 9);'));

  // ---- the pretty-print rule changed shape ----
  // One text/CDATA child stays INLINE; two or more children, or any element
  // child, pretty-print. <a>pre<![CDATA[mid]]>post</a> is the case that separates
  // the new rule from the old "no element children => inline".
  check('an element with ONE non-element child stays inline',
    pre.includes('if (!has_elem && n->child_count == 1) {'));

  // ---- the axes ----
  check('the wildcard child axis counts text nodes',
    pre.includes('// Text nodes take part in the WILDCARD axis only.')
    && pre.includes('if (as_xml_name_all(name)) as_xml_buf_push(&buf, (void*)c);'));
  check('elements() is the element axis only',
    pre.includes('static as_xml_list* as_xml_elements(as_xml_node* n, const char* name) {'));
  check('the descendant axis counts them too',
    (() => {
      const i = pre.indexOf('static void as_xml_desc_walk(');
      if (i < 0) return false;
      const body = pre.slice(i, pre.indexOf('\n}\n', i) + 3);
      return body.includes('} else if (as_xml_name_all(name)) {');
    })());

  // ---- the emit lowerings ----
  const c = gen('var x:XML = new XML("t");\ntrace(x.nodeKind());\ntrace(x.text());\nvar l:XMLList = x.elements();\ntrace("" + l);\n');
  check('nodeKind() lowers to the node-kind helper, not a constant',
    c.includes('as_xml_node_kind('));
  check('text() lowers to the text helper (a text node answers "")',
    c.includes('as_xml_text_of('));
  check('elements() lowers to the element axis',
    c.includes('as_xml_elements('));

  // ---- parse failures raise the reference TypeError ----
  const perr = gen('var x:XML = new XML("t");\ntrace(x);\n');
  check('a parse failure throws a TypeError with the measured id',
    perr.includes('as_throw(TypeError_new(as_xml_error_message(), as_xml_error_id()));'));
  check('#1085 names the open element',
    pre.includes('Error #1085: The element type '));
  check('#1088 is the document-level error',
    pre.includes('Error #1088: The markup in the document following the root element must be well-formed.'));
  check('#1090 is the malformed-element error',
    pre.includes('Error #1090: XML parser failure: element is malformed.'));

  // ---- the localName() nullptr must stay comparable ----
  check('localName() is null for a text node',
    pre.includes('if (n == NULL || n->name == NULL) return NULL;'));
  check('name() is null for a text node',
    pre.includes('if (n == NULL || n->name == NULL) return as_v_null();'));

  console.log(`     [e4xtext] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: e4x/TextNodes', checkEmitE4xTextNodes);

// ---- an Object slot holding a primitive / a function value ----
// Our Object-typed slots are raw pointers, so a scalar must be BOXED to live in one
// (as_number_new / as_string_new / as_boolean_new). AIR keeps the primitive, so the
// observable behaviour has to be reconstructed at every sink. Three of them, all
// measured on adl 51.4.1 (temp/apv/adl):
//   * truthiness applies the PRIMITIVE's ToBoolean (false/""/0 -> F);
//   * String(boxed Boolean) is "false"/"true", and a NULL String/Function assigned
//     to an Object slot IS null (wrapper-free), which is what the app's
//     `if (loader.data) loader.data()` guard depends on (uncaught #1006 before);
//   * any function value stringifies to "function Function() {}", but a NULL one to
//     "null".
// examples/object-box.as covers the behaviour end to end; the shape is pinned here.
function checkEmitObjectBoxCoercion(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [objbox] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [objbox] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

  // Null-preserving boxing: both wrappers must answer NULL for a null payload.
  check('a null String boxes to NULL, not to a wrapper',
    count(pre, 'if (value == NULL) return NULL;') >= 2);
  check('the boxed Boolean stringifies as its own text',
    pre.includes('static char* as_boolean_box_to_str(void* o) { return as_str_from_bool(((as_boolean*)o)->value); }')
    && pre.includes('0, as_boolean_box_to_str, as_object_own_has_own_property'));
  check('a function value stringifies to the AIR constant',
    pre.includes('static char* as_function_box_to_str(void* o) { (void)o; return "function Function() {}"; }')
    && pre.includes('case 7: return "function Function() {}";'));

  const c = generateC(parse('function hi():void { }\nvar o:Object = null;\nif (o) { trace("x"); }\ntrace(String(hi));\n')).c;
  // The Object ROOT cannot be tested as a bare pointer: false/""/0 sit in a
  // non-NULL box, so the test has to unbox first (a concrete subclass cannot hold a
  // boxed scalar and keeps the plain pointer test).
  check('an Object-typed condition unboxes before the truthiness test',
    c.includes('as_v_truthy(as_obj_to_value((void*)(g_o)))'));
  check('a statically-typed Function stringifies with a null check',
    c.includes('== NULL ? (char*)"null" : (char*)"function Function() {}"'));
  check('...and the old bare "function" placeholder is gone',
    !c.includes('concat("function")'));
  console.log(`     [objbox] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ObjectBoxCoercion', checkEmitObjectBoxCoercion);

// Object ToPrimitive (ES3 11.9.3): an object/class instance converted to a number
// (Number/int/uint, numeric comparison) or compared loosely against a primitive
// runs valueOf() first, then toString(). Measured on adl 51.4.1
// (temp/qfix/gcadl/numMain.as -> result5.txt): Number({}) is NaN, Number(undefined)
// is NaN, a class whose toString() is "42" gives 42, and a valueOf() override
// (7) beats its toString() (99). The runtime half is reached only through the
// preamble, so it is pinned here as text.
function checkEmitObjectToPrimitive(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [objprim] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [objprim] ${label}`); }
  };

  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('an object routes to the number-hint ToPrimitive helper',
    pre.includes('if (v.tag == 4) return as_obj_to_number(v.ptr);'));
  check('undefined and a Function value are NaN (only null is 0)',
    pre.includes('if (v.tag == 5 || v.tag == 7) return NAN;'));
  check('the helper tries a user valueOf() through the method table',
    pre.includes('if (strcmp(methods[i].name, "valueOf") == 0) {'));
  check('...and falls back to the vtable toString() slot (or the [object X] default)',
    pre.includes('char* s = toStr != NULL ? toStr(obj) : as_obj_default_str(obj);'));
  check('int/uint route an object through ToNumber first',
    pre.replace(/\s+/g, ' ').includes('if (v.tag == 4) return as_to_int32(as_obj_to_number(v.ptr));')
    && pre.replace(/\s+/g, ' ').includes('if (v.tag == 4) return as_to_uint32(as_obj_to_number(v.ptr));'));
  check('loose equality coerces an object against a string (string-hint)',
    pre.includes('if (a.tag == 4 && b.tag == 3) return strcmp(as_obj_to_str(a.ptr), (char*)b.ptr) == 0;')
    && pre.includes('if (b.tag == 4 && a.tag == 3) return strcmp(as_obj_to_str(b.ptr), (char*)a.ptr) == 0;'));
  check('loose equality coerces an object against a Number/Bool (number-hint)',
    pre.replace(/\s+/g, ' ').includes('if (a.tag == 4 && bn) return as_obj_to_number(a.ptr) == as_v_to_number(b);')
    && pre.replace(/\s+/g, ' ').includes('if (b.tag == 4 && an) return as_obj_to_number(b.ptr) == as_v_to_number(a);'));

  // A class instance compared with a primitive must box both sides; a same-class
  // pointer or a null check must stay a cheap identity comparison.
  const c = generateC(parse('class W { public function toString():String { return "42"; } }\n'
    + 'var w:W = new W();\n'
    + 'var n:Boolean = (w == 42);\n'
    + 'var s:Boolean = (w == "42");\n'
    + 'var z:Boolean = (w == null);\n'
    + 'var p:W = w;\n'
    + 'var id:Boolean = (w == p);\ntrace(n && s && z && id);\n')).c;
  check('class instance == a number goes through as_v_loose_eq',
    /as_v_loose_eq\(as_v_obj\([^)]*\), as_v_num\(42/.test(c) || /as_v_loose_eq\([^;]*42/.test(c));
  check('class instance == a string goes through as_v_loose_eq',
    /as_v_loose_eq\([^;]*as_v_str\("42"\)/.test(c));
  check('class instance == null stays a pointer check (no as_v_loose_eq)',
    !/as_v_loose_eq\([^;]*NULL\)/.test(c));
  check('same-class identity stays a pointer comparison',
    !/as_v_loose_eq\([^;]*g_p[^;]*g_w\)/.test(c));

  console.log(`     [objprim] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ObjectToPrimitive', checkEmitObjectToPrimitive);

// AIR validates DisplayObject.name against null/undefined (TypeError #2007,
// measured on adl 51.4.1: temp/qfix/gcadl/result16.txt -- the static slot,
// `this.name`, an unqualified `name` in a subclass method, `super.name` and
// dynamic * / Object receivers all throw, and the field keeps its old value).
// Error.name is a plain String slot and does not throw, so the guard must key on
// the DECLARING class rather than on the field name.
function checkEmitNameNullGuard(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dname] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dname] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the guard helper is forward-declared in the runtime preamble',
    pre.includes('static char* as_req_name(char* s);'));

  // Static slot, unqualified field and `super.name` all take the guard.
  const c = generateC(parse(
    'import flash.display.Sprite;\n' +
    'class Sub extends Sprite {\n' +
    '  public function run():void { name = null; this.name = null; super.name = null; }\n' +
    '}\n' +
    'var s:Sprite = new Sprite(); s.name = null;\n')).c;
  check('the guard helper throws #2007 with AIR\'s message',
    c.includes('Error #2007: Parameter name must be non-null.'));
  check('a static-slot null write wraps the value in as_req_name',
    /s->name\)? *=\s*as_req_name\(/.test(c));
  check('an unqualified null write takes the guard',
    (c.match(/as_req_name\(/g) || []).length >= 3);

  // A dynamic receiver routes through the prop table's tag-13 entry.
  const dyn = generateC(parse(
    'import flash.display.Sprite;\n' +
    'var s:Sprite = new Sprite();\n' +
    'var d:* = s; d.name = null;\n')).c;
  check('the DisplayObject name slot is prop tag 13',
    /\{ "name", 13, /.test(dyn));
  check('a dynamic write reaches the same guard',
    dyn.includes('as_req_name(as_coerce_str(v))'));
  check('the dynamic read still treats tag 13 as a string',
    dyn.includes('case 3: case 13:'));

  // Error.name is a plain slot: no guard may be emitted for it.
  const err = generateC(parse(
    'var e:Error = new Error("x"); e.name = null;\n')).c;
  check('Error.name is NOT guarded (plain String slot, tag 3)',
    err.includes('->name) = NULL') && !/as_req_name\(NULL\)/.test(err) && /\{ "name", 3, /.test(err));

  console.log(`     [dname] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DisplayObjectNameNull', checkEmitNameNullGuard);

// A missing Array element / named Array property and a missing dynamic object
// property read as AIR's `undefined`, not null (measured on adl 51.4.1:
// temp/qfix/gcadl/arrMain.as gives "undefined|xundefined", === undefined true and
// == null true; omMain.as the same for objects). Only the runtime text can pin
// this, since the examples suite exercises it but cannot assert the source.
function checkRuntimeMissingIsUndefined(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [missing] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [missing] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('an out-of-range Array index is undefined',
    pre.includes('if (i < 0 || i >= a->length) return as_v_undefined();'));
  check('pop and shift on an empty Array are undefined',
    (pre.match(/if \(a->length == 0\) return as_v_undefined\(\);/g) || []).length === 2);
  check('a missing object property is undefined',
    pre.replace(/\s+/g, ' ').includes('return i < 0 ? as_v_undefined() : o->vals[i];'));
  check('a missing named Array property is undefined',
    pre.replace(/\s+/g, ' ').includes('return (a == NULL || a->props == NULL) ? as_v_undefined() : as_object_get(a->props, key);'));
  check('as_v_undefined is forward-declared before those reads',
    pre.indexOf('static as_value as_v_undefined(void);') > 0
    && pre.indexOf('static as_value as_v_undefined(void);') < pre.indexOf('static as_value as_array_get'));
  console.log(`     [missing] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/MissingIsUndefined', checkRuntimeMissingIsUndefined);

// ---- the GC must be able to reach every C-runtime-only pointer slot ----
// A class instance is traced by walking the props reflection table of its vtable
// and of every super (runtime.ts, gc_scan case GCT_CLASS) -- so a pointer field
// that is NOT in that table is invisible to the collector, and built-in classes
// keep fields AS3 cannot declare (a storage path, an element array, a Skia
// handle). Each one must therefore be classified deliberately:
//
//   * GC pointer -> an entry in the props table (type 3 = char* string,
//     6 = object/array/instance), or, for a dynamic class's slot table, the
//     vtable's dyn_offset;
//   * C-owned    -> named in C_OWNED_CHAR_SLOTS below and NEVER listed.
//
// Getting it wrong is silent and delayed: the slot is reclaimed by a later sweep
// and the program misbehaves seconds afterwards. That is exactly what happened to
// SharedObject.name/path -- the persisted-file path was collected, so app startup
// died with `Uncaught exception: SharedObject.flush: cannot write the storage
// file` and, under a tighter GC budget, corrupted the heap (阶段一百四十七).
// examples/so-persist.as covers the behaviour; the classification is pinned here.
function checkEmitGcMarkedRuntimeSlots(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [gcslot] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [gcslot] ${label}`); }
  };
  const src = [
    'import flash.net.SharedObject;',
    'import flash.net.URLStream;',
    'import flash.text.TextField;',
    'import flash.display.Screen;',
    'import flash.display.NativeWindow;',
    'import flash.display.NativeWindowInitOptions;',
    'import flash.geom.Matrix3D;',
    'var so:SharedObject = SharedObject.getLocal("k");',
    'var us:URLStream = new URLStream();',
    'var tf:TextField = new TextField();',
    'var sc:Screen = Screen.mainScreen;',
    'var nw:NativeWindow = new NativeWindow(new NativeWindowInitOptions());',
    'var m3:Matrix3D = new Matrix3D();',
    'trace(so.size + us.bytesAvailable + tf.text.length + sc.bounds.x + nw.title + m3.rawData.length);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // char* slots owned by C (a malloc'd rendering aid, or a borrowed alias into a
  // String field that IS marked): they must never appear in a props table, since
  // gc_scan would either tag a malloc block or mark an interior pointer.
  const C_OWNED_CHAR_SLOTS = new Set([
    'TextField._mask',      // displayAsPassword layout text (malloc, as_tf_layout_text)
    'TextField._mask_src',  // borrowed alias of TextField.text (marked itself)
    'TextField._comp',      // IME composition preview (malloc, as_tf_set_comp)
    'TextField._para_text', // borrowed alias of the layout text (marked itself)
  ]);

  const structFields = new Map<string, string[]>();
  for (const m of c.matchAll(/\nstruct (\w+) \{\n([\s\S]*?)\n\};/g)) {
    const fields: string[] = [];
    for (const decl of m[2].split(';')) {
      const fm = /(?:^|\s)(?:const\s+)?char\s*\*\s*(\w+)\s*$/.exec(decl.trim());
      if (fm) fields.push(fm[1]);
    }
    structFields.set(m[1], fields);
  }
  const supers = new Map<string, string>();
  for (const m of c.matchAll(/static \w+_vtable (\w+)_vt = \{ "[^"]*", &(\w+)_vt,/g)) supers.set(m[1], m[2]);
  const marks = new Map<string, Set<string>>();
  for (const m of c.matchAll(/static as_prop (\w+)_props\[\] = \{([\s\S]*?)\n\};/g)) {
    const set = new Set<string>();
    for (const p of m[2].matchAll(/\{\s*"[^"]*",\s*(\d+),\s*offsetof\((\w+),\s*(\w+)\)/g)) {
      if (p[1] === '3' || p[1] === '13') set.add(p[3]);
    }
    marks.set(m[1], set);
  }
  const covered = (cls: string, field: string): boolean => {
    for (let k: string | undefined = cls; k !== undefined; k = supers.get(k)) {
      if (marks.get(k)?.has(field)) return true;
    }
    return false;
  };

  check('the fixture reaches the built-in classes with C-only slots',
    structFields.has('SharedObject') && structFields.has('TextField') && structFields.has('URLStream')
    && structFields.has('Screen') && structFields.has('NativeWindow'));
  // The regression itself: both string slots are reachable from the marker.
  check('SharedObject.name is marked as a string slot',
    (marks.get('SharedObject') ?? new Set()).has('name')
    && c.includes('{ "_name", 3, offsetof(SharedObject, name), NULL, NULL, 1 }'));
  check('SharedObject.path is marked as a string slot',
    (marks.get('SharedObject') ?? new Set()).has('path')
    && c.includes('{ "_path", 3, offsetof(SharedObject, path), NULL, NULL, 1 }'));
  check('...and both are stored under a write barrier',
    c.includes('o->name = name; gc_write_barrier((void*)name);')
    && c.includes('o->path = path; gc_write_barrier((void*)path);'));
  check('SharedObject._data / _client stay marked as object slots',
    c.includes('{ "_data", 6, offsetof(SharedObject, _data), NULL, NULL, 1 }')
    && c.includes('{ "_client", 6, offsetof(SharedObject, _client), NULL, NULL, 1 }'));

  // The general rule, over every char* slot of every class the fixture emits.
  let checked = 0;
  for (const [cls, fields] of structFields) {
    if (!marks.has(cls)) continue; // no reflection table => not scanned as an instance
    for (const f of fields) {
      checked++;
      const byName = `${cls}.${f}`;
      if (C_OWNED_CHAR_SLOTS.has(byName)) {
        check(`${byName} is C-owned and NOT in the props table`, !covered(cls, f));
      } else {
        check(`${byName} is a GC string slot the marker can reach`, covered(cls, f));
      }
    }
  }
  check('the scan actually looked at the string slots', checked >= 12);

  // A props-table entry is only half of the contract: gc_scan has to FOLLOW the
  // tag. DisplayObject.name is stored as a char* under its own tag 13 (see
  // emitPropTables -- the tag exists so a dynamic null write throws #2007 like AIR)
  // and the marker's switch listed 3/6/7/10/11/12 but not 13, so every object name
  // was swept on the first collection that reached it and the freed block was handed
  // to the next short-lived string. TalkMED's HomeView.clickTabList reads the clicked
  // tab out of e.target.name, so every tab click then indexed menuArray[0] and opened
  // the "打开网页" StageWebView (examples/gc_name.as is the end-to-end pin).
  // The tags that carry a pointer are exactly the ones as_prop uses for storage kinds
  // 3 (char* string), 6 (unchecked ref), 7 (boxed as_value), 10/11/12 (typed ref) and
  // 13 (DisplayObject.name).
  const POINTER_TAGS = ['3', '6', '7', '10', '11', '12', '13'];
  const usedTags = new Set<string>();
  for (const m of c.matchAll(/static as_prop \w+_props\[\] = \{([\s\S]*?)\n\};/g)) {
    for (const p of m[1].matchAll(/\{\s*"[^"]*",\s*(\d+),/g)) {
      if (POINTER_TAGS.includes(p[1])) usedTags.add(p[1]);
    }
  }
  const scanStart = RUNTIME_PREAMBLE.indexOf('static void gc_scan(gc_header* h) {');
  const scanEnd = RUNTIME_PREAMBLE.indexOf('\nstatic ', scanStart + 10);
  const scanBody = scanStart >= 0 ? RUNTIME_PREAMBLE.slice(scanStart, scanEnd > 0 ? scanEnd : undefined) : '';
  const scanCases = new Set([...scanBody.matchAll(/case (\d+):/g)].map((m) => m[1]));
  check('the fixture really emits more than one pointer-carrying prop tag', usedTags.size >= 2);
  check('gc_scan follows every pointer-carrying prop tag',
    [...usedTags].every((t) => scanCases.has(t)));
  check('...including the DisplayObject name slot (tag 13)',
    scanCases.has('13') && scanBody.includes('case 13: gc_mark_ptr(*(char**)(base + props[i].offset));'));

  console.log(`     [gcslot] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/GcMarkedRuntimeSlots', checkEmitGcMarkedRuntimeSlots);

// ---- No AS3-owned slot may hold an interior pointer (阶段一百四十七) ----
// The marker reads a slot as a block BODY: gc_hdr(p) = p - sizeof(gc_header), so
// a pointer into the middle of a string makes the GC treat payload bytes as a
// header and grey a bogus "block". The next sweep then links that garbage into a
// free list and the heap collapses seconds later -- measured on TalkMED as a
// SIGSEGV in gc_sweep_step whose faulting address was literally the ASCII of the
// FPS overlay's "FPS: 121". Two sites produced interior pointers; both are pinned
// here on the sources, because the failure mode is silent and the two spots are
// exactly the shape a future in-place parse would reintroduce:
//   * URLLoader__parseHeaders splits an HTTP header line in place and handed
//     colon+1 (a pointer into that line) to URLRequestHeader as the VALUE.
//   * as_object_set stored the CALLER'S key pointer. Its keys array is a
//     GCT_PTR_ARRAY, so it is marked as pointers too (URLVariables.decode passes
//     a pointer into the buffer it just split in place).
// The general rule: any char* that lands in AS3-visible storage is an independent
// VALUE (as_str_dup / as_str_alloc) -- never a pointer borrowed from another
// object or from the middle of a buffer.
function checkEmitNoInteriorPointers(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [interior] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [interior] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const pre = RUNTIME_PREAMBLE;

  check('a parsed header VALUE is copied out of the line it was split from',
    emitSource.includes('URLRequestHeader_new(line, as_str_dup(val))'));
  check('…and the borrowing form is gone',
    !emitSource.includes('URLRequestHeader_new(line, val)'));
  check('as_object_set copies the key into a fresh GC string',
    pre.includes('if (copy_key && key != NULL) owned = as_str_dup(key);')
    && pre.includes('o->keys[o->length] = (char*)owned;'));
  check('…and never stores the caller\'s pointer',
    !pre.includes('o->keys[o->length] = (char*)key;'));
  check('the borrowed statement was dropped with the pointer',
    !pre.includes('gc_write_barrier((void*)key);'));
  // The one exception is a compile-time literal key (as_object_make). Pin BOTH halves:
  // the literal path skips the copy, and every other caller still gets it by default.
  check('object literal keys are stored as-is (they are C string literals)',
    pre.includes('for (int i = 0; i < n; i++) as_object_set_key(o, keys[i], vals[i], 0);'));
  check('…while as_object_set itself is the copying path',
    pre.includes('static as_value as_object_set(as_object* o, const char* key, as_value v) {')
    && pre.includes('return as_object_set_key(o, key, v, 1);'));

  // The two helpers the rule leans on must really dupe.
  check('as_str_dup allocates a fresh string and copies into it',
    pre.includes('static char* as_str_dup(const char* s) {')
    && pre.includes('char* out = as_str_alloc(n + 1);'));
  // The trimmer copies into a FRESH GC string rather than advancing the pointer:
  // an interior pointer is unmarkable and used to corrupt the free list. 阶段二百零八
  // renamed it as_xml_text_run (one raw run -> one text node value).
  check('the text-run trimmer copies rather than advancing the pointer',
    pre.includes('static char* as_xml_text_run(const char* s, int len) {')
    && pre.includes('char* t = as_str_alloc((size_t)(db - da) + 1);'));

  console.log(`     [interior] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/NoInteriorPointers', checkEmitNoInteriorPointers);

// ---- URLVariables.toString() sizes its buffer from the ENCODED lengths (阶段一百五十三) ----
// The query string percent-encodes every non-alphanumeric byte of BOTH halves,
// so the output can be ~3x the sum of the raw lengths. Sizing the destination from
// the raw lengths (the form this pins against) writes past the end of the GC
// string into whatever block follows. Measured on TalkMED: the 159-byte
// device_info JSON blob of the SMS-code login request encodes to 285, and the 126
// bytes written past the end landed on a free-list node's `next` -- the heap
// collapsed seconds later in gc_sweep_step / as_render_fp with a faulting address
// that was literally the ASCII of the encoded body ("...%22%2C..."). A silent
// overflow, and "build a buffer, then fill it" is exactly the shape an edit would
// rewrite, so the size and the encoder are pinned to agree on the same rule.
function checkEmitUrlVarEncoding(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [urlvar] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [urlvar] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const pre = RUNTIME_PREAMBLE;

  const sizeLine = 'total += as_url_encoded_len(d->keys[i]) + as_url_encoded_len(as_v_str_val(d->vals[i])) + 2;';
  check('the buffer is sized from the ENCODED key + ENCODED value', emitSource.includes(sizeLine));
  check('…and no longer from the raw value length',
    !emitSource.includes('total += strlen(d->keys[i]) + strlen(as_v_str_val(d->vals[i])) + 2;'));
  check('both halves are encoded straight into the destination',
    emitSource.includes('p += as_url_encode_into(p, d->keys[i]);')
    && emitSource.includes('p += as_url_encode_into(p, as_v_str_val(d->vals[i]));'));
  check('…so the encode-then-strlen-then-memcpy form is gone',
    !emitSource.includes('char* v = as_url_encode(as_v_str_val(d->vals[i]));')
    && !emitSource.includes('size_t kl = strlen(k), vl = strlen(v);'));

  check('the length helper exists and never allocates',
    pre.includes('static size_t as_url_encoded_len(const char* s) {')
    && pre.includes('n += as_url_var_safe((char)*p) ? 1 : 3;'));
  check('the encoder writes through the SAME predicate',
    pre.includes('static size_t as_url_encode_into(char* dst, const char* s) {')
    && pre.includes('if (as_url_var_safe((char)c)) dst[p++] = (char)c;'));
  check('as_url_encode is the allocating wrapper of that pair',
    pre.includes('static char* as_url_encode(const char* s) {')
    && pre.includes('char* r = as_str_alloc(as_url_encoded_len(s) + 1);'));
  // The escape set is alphanumeric-only, measured on adl 51.4.1: '-' '_' '.' '~'
  // come out as %2D %5F %2E %7E. The old permissive predicate kept them literal.
  check('the URLVariables escape set is [A-Za-z0-9] only',
    pre.includes('static bool as_url_var_safe(char c) {') && !pre.includes('as_url_is_unreserved'));

  // The read side is FORM decoding and it applies to BOTH halves of a pair.
  // Measured on adl 51.4.1 (temp/uvarair): new URLVariables("a%20b=c%20d") answers
  // the key "a b" -- and toString() gives "a%20b=c%20d" back, a round trip that only
  // closes because the key was decoded on the way in; "p+q=1" answers the key "p q".
  // Keys used to be stored raw ("AIR decodes values but not keys" was an assumption).
  check('decode() percent-decodes the KEY as well as the value',
    emitSource.includes('as_object_set(o->_dyn, as_url_decode(p), as_v_str(as_url_decode(val)));'));
  check('…and the raw-key form is gone',
    !emitSource.includes('as_object_set(o->_dyn, p, as_v_str(as_url_decode(val)));'));
  check("a literal '+' decodes to a space (form encoding, not URI)",
    pre.includes("        } else if (s[i] == '+') {\n            r[p++] = ' ';"));

  console.log(`     [urlvar] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/UrlVarEncoding', checkEmitUrlVarEncoding);

// A one-byte as_str_alloc is the *empty string* — the single case where the
// allocation has no content to copy in. The GC deliberately does not zero
// GCT_STRING (see the as_str_alloc contract in runtime.ts), so the caller must
// write the terminator; a bare `as_str_alloc(1)` that forgets it yields a string
// whose bytes are whatever the recycled block used to hold (阶段一百四十九:
// TalkMED's SWC-baked empty TextField rendered "MS: 17/18" as its text, and the
// Socket.read error paths returned the same kind of garbage). The invariant is
// source-level, so it is pinned here rather than in an example.
function checkEmitEmptyStringTerminator(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const pre = RUNTIME_PREAMBLE;

  check('the runtime provides as_str_empty',
    pre.includes('static char* as_str_empty(void) {'));
  check('as_str_empty writes the terminator itself',
    /static char\* as_str_empty\(void\) \{\n\s*char\* s = \(char\*\)gc_alloc\(GCT_STRING, 1\);\n\s*s\[0\] = 0;/.test(pre));
  check('no bare as_str_alloc(1) is left in the emitter',
    !emitSource.includes('as_str_alloc(1)'));
  check('no bare as_str_alloc(1) is left in the runtime',
    !pre.includes('as_str_alloc(1)'));

  // The generated TextField constructor must produce a real empty string, not a
  // one-byte buffer with an uninitialised first byte.
  const c = generateC(parse('var t:TextField = new TextField();\ntrace(t.text);\n')).c;
  check('TextField_ctor initialises text through as_str_empty',
    c.includes('o->text = as_str_empty();'));
  check('…and no longer zero-fills-by-omission',
    !c.includes('o->text = as_str_alloc(1);'));

  // Both Socket.read error paths (invalid socket, read past the end) return "".
  check('Socket__str error paths return as_str_empty',
    (emitSource.match(/Socket__(invalid|eof)\(\); return as_str_empty\(\);/g) ?? []).length === 2);
  check('…while the success path still allocates n+1 bytes for n characters',
    emitSource.includes('char* s = as_str_alloc((size_t)n + 1);'));

  console.log(`     [empty-string] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/EmptyStringTerminator', checkEmitEmptyStringTerminator);

// The one-argument class call (`Type(expr)`), which AIR resolves class by class:
// the native Error family CONSTRUCTS while every other class COERCES at run time
// through #1034. The shape is a source-level emitter invariant (a bare C pointer
// cast of the argument used to be emitted for the coerce case, which boxed a
// string BODY as an object and SIGSEGV'd the first `catch (e:Error)` -- the
// talkmed-meeting close-the-window crash), so it is pinned here; the runtime
// semantics are the example's job (examples/error-call.as, verified against adl).
function checkEmitClassCall(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };
  const emit = (src: string): string => generateC(parse(src)).c;
  // Compile-time refusals: the emitter must throw, never emit a broken cast.
  const refuses = (src: string, re: RegExp): boolean => {
    try { generateC(parse(src)); return false; }
    catch (e) { return re.test(String(e)); }
  };

  // 1. The native Error family constructs -- emitted as the very same
  //    `X_new(message, id)` call the `new` form uses, so the two are equivalent
  //    by construction. A bare pointer cast (`(Error*)("boom")`) is what used to
  //    be emitted, which boxed a string BODY as an object.
  const boom = emit('var e:* = Error("boom");\ntrace(e);\n');
  check('Error("boom") emits Error_new', boom.includes('Error_new("boom", 0)'));
  check('…and not a pointer cast of the argument', !boom.includes('(Error*)("boom")'));
  const five = emit('var e:* = Error(5);\ntrace(e);\n');
  check('Error(5) converts the message', five.includes('Error_new(as_str_from_int(5), 0)'));
  const terr = emit('var t:* = TypeError(5);\ntrace(t);\n');
  check('TypeError(5) constructs its own class', terr.includes('TypeError_new('));
  const sec = emit('var s:* = SecurityError(5);\ntrace(s);\n');
  check('SecurityError(5) constructs too', sec.includes('SecurityError_new('));
  const rx = emit('var r:* = RegExp("a");\ntrace(r);\n');
  check('RegExp("a") constructs', rx.includes('RegExp_new("a", "")'));
  const ns = emit('var n:* = Namespace("u");\ntrace(n);\n');
  check('Namespace("u") constructs', ns.includes('((void)("u"), Namespace_new())'));

  // 2. Everything else coerces through the shared as_v_req_inst runtime rule
  //    (null/undefined -> null, an instance -> the instance, else #1034), which
  //    needs the class fqn for the error message.
  const spr = emit('var s:* = Sprite(5);\ntrace(s);\n');
  check('Sprite(5) coerces', spr.includes('as_v_req_inst(as_v_num((double)(5)), &Sprite_vt,'));
  const sprn = emit('var s:* = Sprite(null);\ntrace(s);\n');
  check('Sprite(null) coerces the null literal', sprn.includes('as_v_req_inst(as_v_null(), &Sprite_vt,'));
  const foo = emit('class Foo { }\nvar f:* = Foo(5);\ntrace(f);\n');
  check('a user class coerces', foo.includes('as_v_req_inst(as_v_num((double)(5)), &Foo_vt,'));
  // The flash.errors subclasses and a user subclass of Error are NOT native, so
  // AIR has no constructor call behaviour for them (measured in temp/errsub).
  const ioerr = emit('import flash.errors.IOError;\nvar x:* = IOError(5);\ntrace(x);\n');
  check('IOError(5) coerces instead of constructing',
    ioerr.includes('as_v_req_inst(as_v_num((double)(5)), &IOError_vt,'));
  const myerr = emit('class MyErr extends Error { public function MyErr() { super("m"); } }\nvar m:* = MyErr(5);\ntrace(m);\n');
  check('a user subclass of Error coerces', myerr.includes('&MyErr_vt,'));

  // 3. Arity outside the one-argument form stays a loud compile error, as in
  //    mxmlc ("参数的数量不正确。不超过 1 个" for the two-argument spelling).
  check('a two-argument no-new class call is refused',
    refuses('var e:* = Error("m", 42);\ntrace(e);\n', /undefined function 'Error'/));
  check('the no-new Date(...) call is refused at compile time',
    refuses('var d:* = Date(5);\ntrace(d);\n', /no-new Date/));

  // 4. The conversion functions are reached before the class-call rule, so their
  //    existing behaviour must be untouched.
  const obj = emit('var o:* = Object(5);\ntrace(o);\n');
  check('Object(5) still autoboxes rather than coercing', obj.includes('as_obj_to_value'));
  const str = emit('var s:* = String(5);\ntrace(s);\n');
  check('String(5) still converts', str.includes('as_str_from_'));

  console.log(`     [class-call] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ClassCall', checkEmitClassCall);

// ---- listener registration identity + the AT_TARGET phase (adl 51.4.1) ----
//
// Two AIR rules the emitter has to encode, both measured on adl in
// temp/dupprobe (cases A-I) and pinned end-to-end by examples/listener_identity.as:
//   * addEventListener is idempotent per (function, receiver, useCapture) and
//     removeEventListener matches by that same pair -- appending blindly made
//     dual-registered handlers run twice and left a stray listener behind after a
//     single removal (TalkMED's scrollbars re-register MOUSE_DOWN from a subclassed
//     ADDED_TO_STAGE hook, so the app ended up with two live stage mouseMove/mouseUp
//     pairs that permanently disabled the scrolled container's mouse and killed the
//     flick's bounce).
//   * AT_TARGET consults only the non-capture list: the capture phase ends at the
//     target's parent.
function checkEmitListenerIdentity(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [listener] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [listener] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Sprite;\n' +
    'import flash.events.MouseEvent;\n' +
    'var s:Sprite = new Sprite();\n' +
    'function h(e:MouseEvent):void { trace("hit"); }\n' +
    's.addEventListener(MouseEvent.CLICK, h, true);\n' +
    's.addEventListener(MouseEvent.CLICK, h, false);\n' +
    's.removeEventListener(MouseEvent.CLICK, h);\n')).c.replace(/\r\n/g, '\n');

  // Slice one emitted function DEFINITION by scanning braces from its signature.
  // The same signature also appears in the prototype block, so an occurrence whose
  // first brace comes after its terminating ';' is skipped.
  const fnBody = (sig: string): string => {
    for (let from = 0; ;) {
      const i = c.indexOf(sig, from);
      if (i < 0) return '';
      const semi = c.indexOf(';', i);
      const brace = c.indexOf('{', i);
      if (brace >= 0 && (semi < 0 || brace < semi)) {
        let depth = 0;
        for (let j = brace; j < c.length; j++) {
          if (c[j] === '{') depth++;
          else if (c[j] === '}') { depth--; if (depth === 0) return c.slice(i, j + 1); }
        }
        return '';
      }
      from = i + sig.length;
    }
  };

  const add = fnBody('static void EventDispatcher_addEventListener(');
  const rem = fnBody('static void EventDispatcher_removeEventListener(');
  const target = fnBody('static bool as_disp_target(');
  const phase = fnBody('static bool as_disp_phase(Event* evt, void* current, bool capture)');
  check('the fixtures emitted all four listener entry points',
    add.length > 0 && rem.length > 0 && target.length > 0 && phase.length > 0);
  // Dedup: the identical (fn, env) already in the list short-circuits the add.
  check('addEventListener skips an already-registered (function, receiver)',
    /for \(int i = 0; i < arr->length; i\+\+\) \{[\s\S]*?if \(a->fn == listener->fn && a->env == listener->env\) return;[\s\S]*?\}\s*as_array_push\(arr, as_v_obj\(\(void\*\)listener\)\);/.test(add));
  check('the dedup runs before the push, not after',
    add.indexOf('a->env == listener->env') < add.indexOf('as_array_push(arr, as_v_obj'));
  check('removeEventListener matches the same (function, receiver) pair',
    /if \(a->fn == listener->fn && a->env == listener->env\)/.test(rem));
  // AT_TARGET: bubble list only -- no capture lookup may appear in the body.
  check('as_disp_target reads only the non-capture list',
    target.includes('as_listeners_get(d->listeners, evt->type, false)') &&
    !target.includes('as_listeners_get(d->listeners, evt->type, true)'));
  check('as_disp_target still sets the AT_TARGET phase and currentTarget',
    target.includes('evt->eventPhase = 2;') && target.includes('evt->currentTarget = (Object*)target;'));
  // The ancestor capture phase must stay (that is where capture listeners live);
  // as_disp_phase takes the flag as a parameter, so the walk itself supplies `true`.
  check('the capture phase still walks the ancestors',
    c.includes('for (int i = anc_count - 1; i >= 0; i--) { if (event->propStopped) break; if (as_disp_phase(event, ancestors[i], true)) ran = true; }') &&
    phase.includes('as_listeners_get(d->listeners, evt->type, capture)'));

  console.log(`     [listener] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ListenerIdentity', checkEmitListenerIdentity);
// Dispatch-time listener snapshot (阶段二百零九). AIR walks the listener list as it
// stood when the phase started, so a listener may add or remove listeners without
// disturbing the dispatch in flight; measured on adl 51.4.1 (temp/disprem):
//   C1 self-removal keeps the NEXT listener running, C2 removing the next one keeps
//   IT running this time, C3 an addition waits for the next dispatch, C4 remove +
//   re-add runs each once. examples/listener-mutation.as asserts all of that.
// Walking the live array instead made the loop skip the entry after a removed one --
// which silently swallowed the app's own Event.CLOSE handler (the window could be
// opened once and never again, temp/nwreopen).
function checkEmitListenerSnapshot(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [listener-snap] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [listener-snap] ${label}`); }
  };
  const c = generateC(parse(
    'import flash.display.Sprite;\n' +
    'import flash.events.MouseEvent;\n' +
    'var s:Sprite = new Sprite();\n' +
    'function h(e:MouseEvent):void { trace("hit"); }\n' +
    's.addEventListener(MouseEvent.CLICK, h);\n' +
    's.removeEventListener(MouseEvent.CLICK, h);\n' +
    's.dispatchEvent(new MouseEvent(MouseEvent.CLICK));\n')).c.replace(/\r\n/g, '\n');

  const fnBody = (sig: string): string => {
    for (let from = 0; ;) {
      const i = c.indexOf(sig, from);
      if (i < 0) return '';
      const semi = c.indexOf(';', i);
      const brace = c.indexOf('{', i);
      if (brace >= 0 && (semi < 0 || brace < semi)) {
        let depth = 0;
        for (let j = brace; j < c.length; j++) {
          if (c[j] === '{') depth++;
          else if (c[j] === '}') { depth--; if (depth === 0) return c.slice(i, j + 1); }
        }
        return '';
      }
      from = i + sig.length;
    }
  };

  const arr = fnBody('static bool as_disp_arr(');
  const rem = fnBody('static void EventDispatcher_removeEventListener(');
  const add = fnBody('static void EventDispatcher_addEventListener(');
  const disp = fnBody('bool EventDispatcher_dispatchEvent(');
  check('the fixture emitted the walk plus add/remove/dispatch',
    arr.length > 0 && rem.length > 0 && add.length > 0 && disp.length > 0);

  // The walk runs on a COPY of the list, taken before the first listener runs.
  check('as_disp_arr copies the list into a per-depth buffer',
    /for \(int i = 0; i < arr->length; i\+\+\) as_array_push\(snap, arr->data\[i\]\);/.test(arr) &&
    /arr = snap;/.test(arr));
  check('the copy happens BEFORE the first listener is invoked',
    arr.indexOf('arr = snap;') < arr.indexOf('fn->fn(fn->env, arg, 1);'));
  // Length is captured, so an addition during the walk cannot extend it (C3).
  check('the walk freezes the length it started with',
    /int n = arr->length;/.test(arr) && /for \(int i = 0; i < n; i\+\+\) \{/.test(arr));
  check('the one-entry case skips the copy (no per-event allocation in the hot path)',
    /if \(arr->length > 1 && slot >= 0 && slot < AS_DISP_SNAP_SLOTS\)/.test(arr));
  // The buffers are GC roots: a closure an earlier listener removed must not be
  // collected while the snapshot still holds it.
  check('the snapshot buffers are registered as GC roots',
    c.includes('gc_root_register((void**)&as_disp_snaps[i]);'));

  // Add/remove must stay IMMEDIATE on the live list -- a tombstone would make a
  // removal invisible to this dispatch's own walk (C2 wants the removed entry to
  // still run) and to hasEventListener / re-add dedupe afterwards.
  check('removeEventListener shifts the live list immediately',
    /for \(int j = i; j < arr->length - 1; j\+\+\) arr->data\[j\] = arr->data\[j \+ 1\];\s*arr->length--;/.test(rem));
  check('removeEventListener leaves no tombstone behind',
    !rem.includes('as_v_null()') && !rem.includes('as_disp_depth'));
  check('addEventListener appends immediately',
    add.includes('as_array_push(arr, as_v_obj((void*)listener));') && !add.includes('as_disp_depth'));

  // Depth bookkeeping: one increment for the whole dispatch (nested dispatches take
  // deeper snapshot slots), decremented before returning, and reset by the frame
  // guard when an uncaught exception unwinds a dispatch.
  check('dispatchEvent bumps the depth exactly once',
    disp.split('as_disp_depth++;').length === 2);
  check('the depth is restored before dispatchEvent returns',
    disp.indexOf('as_disp_depth++;') < disp.indexOf('as_disp_depth--;') &&
    disp.indexOf('as_disp_depth--;') < disp.indexOf('return !event->cancelled;'));
  check('the frame guard resets the depth after a longjmp',
    c.includes('as_frame_guard = 0; as_disp_depth = 0; return;'));

  console.log(`     [listener-snap] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ListenerSnapshot', checkEmitListenerSnapshot);

// 动态写（`obj[key] = v`）的解析顺序：**最近一层优先，层内 setter 优先于字段**。
// AS3 里访问器压过同名存储槽，而这个运行时故意让一批属性「字段 + setter」并存：
// text/type/borderColor/backgroundColor/textColor（TextField）、length（ByteArray）、
// delay/repeatCount（Timer）、quality/align（Stage）、filters（DisplayObject）、
// totalFrames（MovieClip）、x/y/visible（Stage3D）——字段是实现细节，副作用（_para/_runs
// 失效、缓冲区 resize + position 钳位、Timer 重启、RGB 去 alpha、范围校验）全在 setter 里。
// 先走字段表时，动态写（烘焙 SWC 子件全走这条路）会静默跳过所有副作用：真应用里
// `item.note.text = ...` 保留了上一次 htmlText 的 _runs=[0,12)，只排 12 字节并把一个字
// 劈成两半（两个 U+FFFD，temp/shareitem）。examples/textfield-dyn-set.as 端到端钉行为，
// 这里钉发射形态——纯 C 构建没有排版后端时宽度恒 0，测不出差别。
function checkRuntimeDynSetAccessorFirst(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dynset] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dynset] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const i = pre.indexOf('static void as_dyn_set(void* obj, const char* key, as_value v) {');
  check('the preamble still defines as_dyn_set', i >= 0);
  const body = i < 0 ? '' : pre.slice(i, pre.indexOf('\nstatic ', i + 10));

  // 1. 同层内 setter 扫描必须先于 props 扫描（顺序即优先级）。
  const setScan = body.indexOf('setters[i].name');
  const propScan = body.indexOf('props[i].name');
  check('the setter table is scanned before the field table',
    setScan >= 0 && propScan > setScan);
  check('a setter hit invokes the accessor and returns at once',
    /if \(strcmp\(setters\[i\]\.name, key\) == 0\) \{ setters\[i\]\.fn\(obj, &v, 1\); return; \}/.test(body));
  check('a field hit still returns after the coercing store (accessor is not re-scanned)',
    body.indexOf('props[i].name') >= 0 && body.indexOf('as_v_to_number(v); return;') > propScan);

  // 2. 只有一处 setter 调用点：修前的实现是「先遍历所有层查字段，循环外再查一遍
  //    setter」，那等于让**远端层**的字段压过**近端层**的访问器，也会漏掉副作用。
  const setterCalls = body.split('setters[i].fn(obj, &v, 1)').length - 1;
  check('there is exactly one setter dispatch site (no second pass after the loop)', setterCalls === 1);
  check('both scans live inside the per-layer loop',
    body.indexOf('while (vt != NULL)') < setScan && body.indexOf('while (vt != NULL)') < propScan);
  check('the layer advance comes after both scans',
    body.indexOf('vt = ((as_vtable_header*)vt)->super;') > Math.max(setScan, propScan));

  // 3. 特殊容器先分流（Dictionary/Array/Vector），不能被 setter 表挡住。
  check('Dictionary/Array/Vector still short-circuit before the vtable walk',
    body.indexOf('as_dict_set(') < setScan && body.indexOf('as_array_key_set(') < setScan
    && body.indexOf('as_vec_set_hook') < setScan);

  console.log(`     [dynset] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/DynSetAccessorFirst', checkRuntimeDynSetAccessorFirst);

// `String.prototype.substr` 是 AVM2 对 ES3 的**偏离**：`String::AS3_substr` 把 `start`
// 与 `start + count` 都过 ClampIndex（负数从尾部回算），所以 `substr(0,-3)` 是「砍掉
// 最后 3 个字符」而不是空串（avmplus core/StringObject.cpp + NativeObjectHelpers.h）。
// 我们原来按 ES3 把负 len 夹到 0，真应用 myMeetingRenderers 的
// `start_at.substr(0,-3)` 因此整条时间变空——卡片上只剩「开始时间：」。
// examples/string-substr.as 端到端钉行为（含动态接收者路径），这里钉发射形态，
// 防止有人「顺手」把它改回 ES3 的夹 0 写法。
function checkRuntimeSubstrNegativeLen(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [substr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [substr] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const ci = pre.indexOf('static int as_clamp_index(int n, int length) {');
  check('the preamble defines as_clamp_index', ci >= 0);
  const clampBody = ci < 0 ? '' : pre.slice(ci, pre.indexOf('\nstatic ', ci + 10));
  // ClampIndex 的三条分支：负数回算（仍越界 → 0）、正向越界 → length、其余原值。
  check('negative indices count from the end and clamp to 0',
    /if \(n < 0\) \{\s*if \(n \+ length < 0\) return 0;\s*return n \+ length;\s*\}/.test(clampBody));
  check('positive indices past the end clamp to length', clampBody.indexOf('if (n > length) return length;') >= 0);

  const si = pre.indexOf('static char* as_str_substr(const char* s, int from, int len) {');
  check('the preamble defines as_str_substr', si >= 0);
  const body = si < 0 ? '' : pre.slice(si, pre.indexOf('\nstatic ', si + 10));
  check('start goes through as_clamp_index', body.indexOf('as_clamp_index(from, slen)') >= 0);
  // 关键一行：end 也要过 as_clamp_index，且入参是「夹过的 start + 原始 len」
  // ——这正是 AVM2 让负长度从尾部回算的地方。
  check('end takes start+len through as_clamp_index too',
    body.indexOf('as_clamp_index(start + len, slen)') >= 0);
  check('end is pulled back to start before slicing', body.indexOf('if (end < start) end = start;') >= 0);
  check('the old ES3 clamp of a negative length is gone', body.indexOf('if (len < 0) len = 0;') < 0);
  // slice / substring 的负数语义各自不同，不能被这次改动带偏。
  check('as_str_substring still treats a negative bound as 0',
    /static char\* as_str_substring\([^)]*\) \{[\s\S]*?if \(to < 0\) to = 0;/.test(pre));
  check('as_str_slice still resolves a negative bound from the end',
    /static char\* as_str_slice\([^)]*\) \{[\s\S]*?if \(to < 0\) to = slen \+ to;/.test(pre));

  console.log(`     [substr] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/SubstrNegativeLen', checkRuntimeSubstrNegativeLen);

// int(x) / uint(x) must be ES3 ToInt32 / ToUint32 for EVERY source type, never a
// bare C cast. `(int)` of a double is UNDEFINED BEHAVIOUR once the value is NaN,
// infinite or outside int32 -- the same expression printed 1, 1073741824,
// 2147483647 or a garbage negative depending on the surrounding function (arm64
// -O2, temp/d31probe) -- while AIR is total and WRAPS. Reference values are the
// adl 51.4.1 oracle (temp/d31probe/adl/result-adl.txt, same source both sides):
// int(NaN)=0, int(1e10)=1410065408, int(-1e10)=-1410065408, uint(-1e10)=2884901888,
// int(2147483648)=-2147483648, uint(4294967296)=0, int(Infinity)=0.
// examples/int-cast.as covers the values end to end; the emitted shape is pinned
// here, because with a correct helper the two spellings are indistinguishable at
// runtime on the inputs an example can reach.
function checkEmitIntCastCall(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [intcast] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [intcast] ${label}`); }
  };

  const c = generateC(parse('function i32(n:Number):int { return int(n); }\n'
    + 'function u32(n:Number):uint { return uint(n); }\n'
    + 'var a:int = i32(1.5);\nvar b:uint = u32(1.5);\n'
    + 'var d:* = 1.5;\nvar e:int = int(d);\ntrace(a + b + e);\n')).c;

  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    if (i < 0) return '';
    const brace = c.indexOf('{', i);
    let depth = 0;
    for (let j = brace; j < c.length; j++) {
      if (c[j] === '{') depth++;
      else if (c[j] === '}') { depth--; if (depth === 0) return c.slice(i, j + 1); }
    }
    return '';
  };

  const i32 = body('static int i32(double n) {');
  const u32 = body('static unsigned int u32(double n) {');
  check('the fixtures emitted both conversion functions', i32.length > 0 && u32.length > 0);
  check('int(Number) goes through the ES3 ToInt32 helper',
    i32.includes('as_to_int32(') && !i32.includes('(int)('));
  check('uint(Number) goes through the ES3 ToUint32 helper',
    u32.includes('as_to_uint32(') && !u32.includes('(unsigned int)('));
  check('the ToInt32 helper wraps out-of-range and NaN input (not a machine cast)',
    RUNTIME_PREAMBLE.includes('if (isnan(v) || isinf(v)) return 0;')
    && RUNTIME_PREAMBLE.includes('fmod(t, 4294967296.0)'));
  // Dynamic source: the coercing helper, which also handles String/object payloads.
  check('int(*) dispatches on the box tag',
    c.includes('as_v_int_cast('));
  // The same two bugs lived in the `new (ClassValue)(x)` path (as_core_cls_ctor),
  // which is a SEPARATE emitter string: a bare cast there was undefined behaviour
  // too -- measured, temp/d31probe/newcore2.as: int 1e10 printed 2147483647 (a
  // saturating fold) where adl gives 1410065408.
  check('the dynamic core-class constructor uses the same ES3 helpers',
    c.includes('if (strcmp(n, "int") == 0) return as_v_num((double)as_to_int32(as_v_to_number(a)));')
    && c.includes('if (strcmp(n, "uint") == 0) return as_v_num((double)as_to_uint32(as_v_to_number(a)));'));
  // `new co(5)` on a Class value is the Object(5) CONVERSION (the number 5), not a
  // fresh object -- measured on adl 51.4.1 (temp/d31probe/adl-newcore3.txt).
  check('new (Object Class)(x) is the Object(x) conversion, not a fresh object',
    c.includes('if (strcmp(n, "Object") == 0) return as_obj_conv(a);'));
  // `new Number()` is 0 (the constructor default) while the CONVERSION `Number()`
  // is NaN -- the two must not share an implementation.
  check('new Number() with no argument is 0, not NaN',
    generateC(parse('var zzq:Number = new Number();\ntrace(zzq);\n')).c.includes('g_zzq = 0;'));

  console.log(`     [intcast] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/IntCastCall', checkEmitIntCastCall);

// E4X has its own typeof bucket in AIR: "xml" for XML and XMLList alike, in every
// slot shape (static, `*`, Object -- measured on adl 51.4.1, temp/xmlmeth +
// temp/d31probe/adl). We used to fold every xml-typed operand to "object", and a
// boxed XML value fell through as_ptr_typeof's vtable chain to "object" too.
function checkEmitTypeofXml(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [toxm] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [toxm] ${label}`); }
  };

  const c = generateC(parse('var x:XML = <a/>;\nvar xl:XMLList = XMLList(x);\n'
    + 'var t1:String = typeof x;\nvar t2:String = typeof xl;\n'
    + 'var a:* = x;\nvar t3:String = typeof a;\n'
    + 'var o:Object = x;\nvar t4:String = typeof o;\ntrace(t1 + t2 + t3 + t4);\n')).c;

  check('a statically xml-typed operand reports "xml"',
    c.includes('typeof x').toString() === 'false' && /g_t1 = "xml";/.test(c));
  check('...and so does a statically xml-typed XMLList',
    /g_t2 = "xml";/.test(c));
  check('a `*` slot holding an XML goes through the runtime dispatcher',
    c.includes('as_v_typeof('));
  check('an Object slot holding an XML goes through as_ptr_typeof',
    c.includes('as_ptr_typeof('));
  // The two runtime dispatchers are the ones that decide for boxed values, so both
  // must know the two E4X vtables (a missing branch silently answers "object").
  const pre = RUNTIME_PREAMBLE;
  const needle = 'as_xml_vt || vt == (void*)&as_xml_list_vt) return "xml";';
  check('as_v_typeof and as_ptr_typeof both recognise the XML/XMLList vtables',
    pre.split(needle).length - 1 === 2);
  check('the vtables are the ones E4X values actually carry',
    pre.includes('static as_object_vtable as_xml_vt =') && pre.includes('as_xml_list_vt ='));

  console.log(`     [toxm] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: e4x/TypeofXml', checkEmitTypeofXml);

// The generated C body plants FIXED identifier spellings that AS3 source is free
// to use as well: `o` is the receiver parameter of a generated class constructor
// (`Widget_ctor(Widget* o, ...)`) and `_this` the receiver of every generated
// instance method. Before cIdent reserved them, a class declaring a parameter,
// field or local named `o` emitted C that clang rejected:
//   static void Widget_ctor(Widget* o) { ... Object* o = NULL; ... }
//   error: redefinition of 'o' with a different type: 'Object *' vs 'Widget *'
// (temp/d31probe/ocollide2.as, a 7-line AIR app that `adl` runs fine). The fix is
// spelling-only: the AS3 identifier is renamed (`_o`, `__this`) while the
// REFLECTION name stays the original string, which is what `w["o"]` resolves
// against -- examples/ident-collide.as pins that end to end.
function checkEmitGeneratedNameReservation(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [gname] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [gname] ${label}`); }
  };

  const c = generateC(parse('class Widget {\n'
    + '  public var o:int;\n'
    + '  public function Widget(o:int, _this:String) { this.o = o; }\n'
    + '  public function add(o:int, _this:int):int { var _i0:int = 1; return o + _this + _i0; }\n'
    + '  public function o():int { return 9; }\n'
    + '}\n'
    + 'var w:Widget = new Widget(1, "a");\ntrace("" + w.o + w.add(2, 3) + w["o"]);\n')).c;

  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    if (i < 0) return '';
    const brace = c.indexOf('{', i);
    let depth = 0;
    for (let j = brace; j < c.length; j++) {
      if (c[j] === '{') depth++;
      else if (c[j] === '}') { depth--; if (depth === 0) return c.slice(i, j + 1); }
    }
    return '';
  };

  // The receiver keeps its spelling (it is emitted raw, never through cIdent) and
  // the source identifiers move out of the way.
  check('the constructor receiver stays `o` while a param named `o` is renamed',
    c.includes('Widget_ctor(Widget* o, int _o, char* __this)'));
  const ctor = body('static void Widget_ctor(Widget* o, int _o, char* __this) {');
  check('the fixture emitted the colliding constructor', ctor.length > 0);
  check('no C local reuses the receiver spelling',
    !/\bObject\* o =|\bchar\* o =|\bint o =/.test(ctor) && ctor.includes('this->_o'));
  check('a method param named `_this` is renamed to `__this`',
    c.includes('Widget_add(void* _this, int _o, int __this)'));
  const add = body('static int Widget_add(void* _this, int _o, int __this) {');
  check('a local spelled like a tmpName() temporary is renamed out of that space',
    add.includes('int __i0 = 0;') && !/\bint _i0 = 0;/.test(add));
  // A method NAMED `o` is not a collision (it is `Owner_o`), but it must not be
  // renamed either -- cIdent's reservation is for function-scope locals.
  check('a method named `o` keeps its owner prefix', c.includes('static int Widget_o(void* _this)'));
  // The reflection table maps the ORIGINAL AS3 name to the renamed slot: this is
  // what keeps `w["o"]`, for-in and AMF member lists AIR-correct.
  check('the props table keeps the AS3 name "o" pointing at the renamed slot',
    /\{ "o", \d+, offsetof\(Widget, _o\)/.test(c));
  check('the AMF member list keeps the AS3 name "o"',
    /static const char\* Widget_amf_members\[\] = \{ "o", NULL \};/.test(c));

  console.log(`     [gname] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/GeneratedNameReservation', checkEmitGeneratedNameReservation);

// ---- the ANE-facing ExtensionContext surface (docs/zh-cn/ane.md) ----
//
// These pin the AS3 half of the native-extension bridge as EMITTED C -- the exact
// text a build produces. That matters here because each of these bodies is a §1.5
// decision: an API this build cannot honour answers null / an empty File AND says
// so, rather than fabricating a value. A body that silently returns something
// plausible is the failure mode the pins exist for: the old
// getExtensionDirectory() handed back a pathless File with no announcement at all,
// which reads exactly like "this extension genuinely has no directory".
function checkAneExtensionContextSurface(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ane] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ane] ${label}`); }
  };
  // `mxmlc` 51.4.1 requires BOTH arguments of createExtensionContext (measured: the
  // one-argument call is rejected with 「参数的数量不正确。要求 2 个」), so the second
  // argument is passed explicitly here -- the pins below are about the emitted ANE
  // surface, not about this call's arity (see unit: builtin/Arity).
  const c = generateC(parse('import flash.external.ExtensionContext;\nvar x:* = ExtensionContext.createExtensionContext("a.b", null);\ntrace(x);\n')).c;

  // getExtensionDirectory() names the directory the extension's OWN files live in.
  // The build stages each extension's native library into a directory of its own,
  // but that directory holds the library alone -- the rest of the package is not
  // unpacked -- so it has to say so rather than hand back a path that looks right
  // and fails one level deeper inside the extension.
  const dir = /File\* ExtensionContext_getExtensionDirectory_static\(char\* extensionID\) \{[^}]*\}/.exec(c);
  check('getExtensionDirectory has an emitted body', dir !== null);
  check('…and reports the gap instead of silently returning a pathless File',
    dir !== null && /as_shell_unsupported\("/.test(dir[0]));
  check('…still returns a live File so a caller can inspect it',
    dir !== null && /return File_new\(NULL\);/.test(dir[0]));
  // …and the report is not a guess about the platform: it names this build's own
  // staging layout and what is missing from it, which is what a reader needs to know
  // to work around it.
  check('…naming the staging layout rather than guessing a path',
    dir !== null && /extensions\/<extensionID>\/<platform>/.test(dir[0]));
  check('…and saying what that directory does NOT hold',
    dir !== null && /the rest of the package is not unpacked/.test(dir[0]));

  // AIR has no ExtensionContext.extensionID member (mxmlc rejects it, adl raises
  // #1069). The struct must not grow one just to look more complete: the id is an
  // argument to createExtensionContext, not a property of the context.
  const struct = /struct ExtensionContext \{[^}]*\}/.exec(c);
  check('the ExtensionContext struct is emitted', struct !== null);
  check('…with actionScriptData as a real member', struct !== null && /actionScriptData/.test(struct[0]));
  check('…and no extensionID member', struct !== null && !/extensionID/.test(struct[0]));

  // A context whose extension never loaded is the one case AIR also answers with
  // null; the call site must be named rather than folded into a generic miss.
  check('call() on a never-loaded context names that case',
    c.includes('ExtensionContext.call on a context whose extension never loaded'));

  console.log(`     [ane-ctx] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: ane/ExtensionContextSurface', checkAneExtensionContextSurface);

// Built-in arity vs AIR (阶段一百九十五, TODO.md 遗留项 #75).
//
// The defect was a table defect, not an emitter one: `gnum` handed every numeric
// built-in parameter a `0` default, so AIR-REQUIRED parameters looked optional
// (`g.moveTo(1)`, `m.rotate()`, `new ShaderData()` all compiled here although
// `mxmlc` 51.4.1 rejects them), while parameters AIR really does default were
// declared REQUIRED (`ctx.drawTriangles(ib)`). Every arity was measured cell by
// cell against `mxmlc` (temp/optarg/: 4964 cells, the acceptance oracle) and the
// default VALUES come from the AS3 reference pages (temp/asdoc/docs.json).
//
// This group pins the DATA (the parameter list a built-in method declares) and the
// EMISSION (the C call the omitted argument produces); the negative half -- what
// must NOT compile -- lives in unit: diagnostics/Codegen, because a CodegenError
// cannot be asserted from an example.

function checkBuiltinArity(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [arity] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [arity] ${label}`); }
  };
  // `name` + `?` marks an optional parameter (a default the caller may omit);
  // the value itself is asserted separately where the VALUE is the contract.
  const table = new SymbolTable();
  table.collect(parse('var x:int = 1;'));
  const params = (cls: string, name: string, isStatic = false) => {
    const info = table.classes.get(cls);
    const m = info ? (isStatic ? info.staticMethods : info.methods).get(name) : undefined;
    return m ? m.params : undefined;
  };
  const shapeOf = (cls: string, name: string, isStatic = false): string => {
    const ps = params(cls, name, isStatic);
    return ps ? ps.map((p) => p.name + (p.defaultValue === null ? '' : '?')).join(',') : '<<no such method>>';
  };
  const defOf = (cls: string, name: string, param: string, isStatic = false): string => {
    const p = (params(cls, name, isStatic) ?? []).find((q) => q.name === param);
    return p ? JSON.stringify(p.defaultValue) : '<<no such parameter>>';
  };

  check('a built-in required parameter carries no default (Graphics.moveTo)',
    shapeOf('Graphics', 'moveTo') === 'x,y');
  check('…the invented `0` default is gone from the data, not just the emitter',
    params('Graphics', 'moveTo')!.every((p) => p.defaultValue === null));
  check('Matrix.rotate has one required parameter', shapeOf('Matrix', 'rotate') === 'angle');
  check('Point.normalize / Rectangle.contains are required again too',
    shapeOf('Point', 'normalize') === 'thickness' && shapeOf('Rectangle', 'contains') === 'x,y');

  check('an AIR-optional parameter keeps its place (Graphics.beginFill)',
    shapeOf('Graphics', 'beginFill') === 'color,alpha?');
  check('…with AIR the documented default value (alpha = 1)',
    defOf('Graphics', 'beginFill', 'alpha') === JSON.stringify({ kind: 'Num', value: 1, isInt: false }));

  // Context3D: the AIR signatures, parameter by parameter.
  check('Context3D.drawTriangles takes (indexBuffer, firstIndex = 0, numTriangles = -1)',
    shapeOf('Context3D', 'drawTriangles') === 'indexBuffer,firstIndex?,numTriangles?'
    && defOf('Context3D', 'drawTriangles', 'firstIndex') === JSON.stringify({ kind: 'Num', value: 0, isInt: true })
    && defOf('Context3D', 'drawTriangles', 'numTriangles') === JSON.stringify({ kind: 'Num', value: -1, isInt: true }));
  // ORDER is semantic: AIR puts numInstances SECOND, so a table with
  // (indexBuffer, firstIndex, numTriangles, numInstances) would silently read
  // firstIndex where the caller wrote numInstances.
  check('Context3D.drawTrianglesInstanced puts numInstances SECOND (AIR order)',
    shapeOf('Context3D', 'drawTrianglesInstanced') === 'indexBuffer,numInstances,firstIndex?,numTriangles?');
  check('…and only the first TWO parameters are required',
    defOf('Context3D', 'drawTrianglesInstanced', 'numInstances') === 'null'
    && defOf('Context3D', 'drawTrianglesInstanced', 'firstIndex') !== 'null');
  check('Context3D.configureBackBuffer keeps antiAlias REQUIRED (AIR: no default)',
    shapeOf('Context3D', 'configureBackBuffer') === 'width,height,antiAlias,enableDepthAndStencil?,wantsBestResolution?,wantsBestResolutionOnBrowserZoom?'
    && defOf('Context3D', 'configureBackBuffer', 'enableDepthAndStencil') === JSON.stringify({ kind: 'Bool', value: true }));
  check('Context3D.setProgramConstantsFromMatrix defaults only transposedMatrix',
    shapeOf('Context3D', 'setProgramConstantsFromMatrix') === 'programType,firstRegister,matrix,transposedMatrix?'
    && defOf('Context3D', 'setProgramConstantsFromMatrix', 'transposedMatrix') === JSON.stringify({ kind: 'Bool', value: false }));
  check('Context3D.setRenderToTexture / setVertexBufferAt / setProgramConstantsFromVector match AIR',
    shapeOf('Context3D', 'setRenderToTexture') === 'texture,enableDepthAndStencil?,antiAlias?,surfaceSelector?'
    && shapeOf('Context3D', 'setVertexBufferAt') === 'index,buffer,bufferOffset?,format?'
    && shapeOf('Context3D', 'setProgramConstantsFromVector') === 'programType,firstRegister,data,numRegisters?');
  // AIR declares BOTH parameters: requestContext3D(context3DRenderMode = "auto",
  // profile = "baseline"). The one-parameter form this used to pin made every
  // two-argument call a compile error, and Starling's profile ladder calls it through
  // Function.apply (=> #1063 at runtime), so the profile half is not optional.
  check('Stage3D.requestContext3D declares (context3DRenderMode, profile) with AIR\'s defaults',
    shapeOf('Stage3D', 'requestContext3D') === 'context3DRenderMode?,profile?'
    && defOf('Stage3D', 'requestContext3D', 'context3DRenderMode') === JSON.stringify({ kind: 'Str', value: 'auto' })
    && defOf('Stage3D', 'requestContext3D', 'profile') === JSON.stringify({ kind: 'Str', value: 'baseline' }));

  // The shell-block classes still go through the old `shReq` helpers -- the audit
  // had to fix their parameters by hand (their class blocks are built by `shell`).
  check('StageWebView.loadString defaults mimeType to text/html (shell-block class)',
    shapeOf('StageWebView', 'loadString') === 'text,mimeType?'
    && defOf('StageWebView', 'loadString', 'mimeType') === JSON.stringify({ kind: 'Str', value: 'text/html' }));
  check('Microphone.setLoopBack defaults state to true (shell-block class)',
    shapeOf('Microphone', 'setLoopBack') === 'state?'
    && defOf('Microphone', 'setLoopBack', 'state') === JSON.stringify({ kind: 'Bool', value: true }));
  check('Clipboard.clearData requires its mimeType again',
    shapeOf('Clipboard', 'clearData') === 'mimeType');
  check('in the Matrix3D block BOTH the instance and the static interpolate lost the 0 default',
    shapeOf('Matrix3D', 'interpolate') === 'thisMat,toMat,percent'
    && shapeOf('Matrix3D', 'interpolate', true) === 'thisMat,toMat,percent');
  check('Object.hasOwnProperty/propertyIsEnumerable take `name` as optional-null (AIR accepts the empty call)',
    shapeOf('Object', 'hasOwnProperty') === 'name?' && defOf('Object', 'hasOwnProperty', 'name') === JSON.stringify({ kind: 'Null' })
    && shapeOf('Object', 'propertyIsEnumerable') === 'name?');

  // ---- the emission half: an omitted argument becomes AIR's default in the call ----
  const src = [
    'import flash.display3D.Context3D;',
    'import flash.display3D.IndexBuffer3D;',
    'import flash.geom.Matrix3D;',
    'function probe(ctx:Context3D, ib:IndexBuffer3D, m:Matrix3D):void {',
    '  ctx.drawTriangles(ib);',
    '  ctx.drawTrianglesInstanced(ib, 3);',
    '  ctx.drawTrianglesInstanced(ib, 3, 1);',
    '  ctx.configureBackBuffer(1, 1, 0);',
    '  ctx.setProgramConstantsFromMatrix("vertex", 0, m);',
    '  trace("probe");',
    '}',
    'probe(null, null, null);',
    '',
  ].join('\n');
  let c: string;
  try { c = generateC(parse(src)).c; }
  catch (e) { c = '<<codegen error: ' + String(e) + '>>'; }
  const callLine = (needle: string, nth = 0): string =>
    c.split('\n').filter((l) => l.includes(needle))[nth] ?? '<<no such call>>';
  check('drawTriangles(ib) emits the AIR defaults (idx 0, triangles -1)',
    callLine('->drawTriangles(').trim().endsWith('ib, 0, -1));'));
  check('drawTrianglesInstanced(ib, 3) fills numInstances (NOT firstIndex) with 3',
    callLine('->drawTrianglesInstanced(').trim().endsWith('ib, 3, 0, -1));'));
  check('…and a three-argument call fills firstIndex after numInstances',
    callLine('->drawTrianglesInstanced(', 1).trim().endsWith('ib, 3, 1, -1));'));
  check('configureBackBuffer(1,1,0) emits depth/stencil true and both resolution flags false',
    callLine('->configureBackBuffer(').trim().endsWith('((unsigned int)(0)), true, false, false));'));
  check('setProgramConstantsFromMatrix(..., 0, m) emits transposedMatrix false',
    callLine('->setProgramConstantsFromMatrix(').trim().endsWith('"vertex", 0, m, false));'));
  // The C helper signature must use the SAME order as the AS3 parameter list --
  // otherwise the call above would compile and silently swap the two ints.
  check('the C helper takes the AIR order too (numInstances before firstIndex)',
    c.includes('Context3D_drawTrianglesInstanced(void* _this, IndexBuffer3D* indexBuffer, int numInstances, int firstIndex, int numTriangles) {'));

  console.log(`     [arity] ${ok} built-in arity check(s) passed`);
  return bad;
}
registerGroup('unit: builtin/Arity', checkBuiltinArity);

// The exception-unwinding state must be per-THREAD and growable. It used to be
// `static jmp_buf* as_jmp_stack[64]` written with unchecked `stack[depth++]`
// pushes: the AS3 dispatcher thread and every ANE worker thread (FRE callbacks
// such as FRESetObjectProperty) shared one counter, so past the 64th frame the
// write landed on the depth counter itself and then at wild .data addresses --
// silently corrupting the runtime statics next to it -- and a throw could
// longjmp into another thread's frame. Measured A/B on examples/try-deep.as
// (201-deep try/catch with rethrow): the old shape exits 0xC0000005 with no
// output at all, the fixed shape completes all 8 checks.
function checkRuntimeUnwindStackPerThread(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [unwind] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [unwind] ${label}`); }
  };

  const program = generateC(parse(
    `function dive(n:int):void {` +
    `  try { if (n > 0) dive(n - 1); else throw new Error("bottom"); }` +
    `  catch (e:Error) { throw e; }` +
    `}` +
    `try { dive(2); } catch (e:Error) { trace(e.message); }` +
    `try { dive(1); } catch (e:Error) { trace(e.message); }`
  )).c;
  const pre = RUNTIME_PREAMBLE;
  const fre = FRE_BODY;

  // 1. The storage is thread-local, starts empty, and grew out of a fixed array.
  check('the frame stack is thread-local and starts empty',
    pre.includes('static ASC_TLS jmp_buf** as_jmp_stack = NULL;'));
  check('depth and capacity are thread-local too',
    pre.includes('static ASC_TLS int as_jmp_depth = 0;') && pre.includes('static ASC_TLS int as_jmp_cap = 0;'));
  check('the old process-global fixed array is gone', !pre.includes('static jmp_buf* as_jmp_stack[64];'));
  check('ASC_TLS is defined before its first use and for all three toolchains',
    pre.indexOf('#define ASC_TLS __declspec(thread)') >= 0 &&
    pre.indexOf('#define ASC_TLS __declspec(thread)') < pre.indexOf('static ASC_TLS') &&
    pre.includes('#define ASC_TLS __thread') && pre.includes('__wasm__'));

  // 2. No unchecked indexing survives: the only write to the array is the one
  //    inside the helper, which grows the stack first.
  check('the emitted program indexes the array exactly once (inside as_jmp_push)',
    (program.match(/as_jmp_stack\[as_jmp_depth\+\+\]/g) || []).length === 1 &&
    program.includes('as_jmp_stack[as_jmp_depth++] = jb;'));
  check('…and its try/catch sites go through the helpers',
    (program.match(/as_jmp_push\(&/g) || []).length >= 2 &&
    (program.match(/as_jmp_pop\(\);/g) || []).length >= 4);
  check('the FRE entry points go through the helpers too',
    (fre.match(/as_jmp_push\(&jb\);/g) || []).length >= 5 &&
    (fre.match(/as_jmp_pop\(\);/g) || []).length >= 5 &&
    !/as_jmp_stack\[as_jmp_depth/.test(fre) && !/as_jmp_depth--/.test(fre));

  // 3. Growth, and a pop that cannot underflow.
  check('as_jmp_push grows the stack instead of overflowing',
    pre.includes('realloc(as_jmp_stack, sizeof(jmp_buf*) * (size_t)ncap)') &&
    pre.includes('int ncap = as_jmp_cap == 0 ? 64 : as_jmp_cap * 2;'));
  check('a failed grow reports instead of silently dropping the frame',
    pre.includes('AS3 out of memory: exception stack') && pre.includes('exit(1);'));
  check('as_jmp_pop cannot go negative', pre.includes('if (as_jmp_depth > 0) as_jmp_depth--;'));
  check('throw still unwinds to the innermost frame',
    (pre.match(/longjmp\(\*as_jmp_stack\[as_jmp_depth - 1\], 1\);/g) || []).length === 2);

  // 4. The rest of the unwinding state -- the frame-boundary guard and the
  //    pending throw -- is per-thread for the same reason: a worker thread must
  //    not longjmp into the dispatcher thread's frame, and two threads inside
  //    FRE calls must not clobber each other's pending value.
  check('the frame-boundary guard is thread-local',
    pre.includes('static ASC_TLS jmp_buf as_frame_jmp;') && pre.includes('static ASC_TLS int as_frame_guard = 0;'));
  check('the pending throw is thread-local',
    pre.includes('static ASC_TLS void* as_exception = NULL;') &&
    pre.includes('static ASC_TLS as_value as_exception_v = {0, 0.0, NULL};') &&
    pre.includes('static ASC_TLS int as_exception_boxed = 0;'));

  console.log(`     [unwind] ${ok} exception-unwinding state check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/UnwindStackPerThread', checkRuntimeUnwindStackPerThread);

// ---- RegExp construction is INERT on an uncompilable pattern (adl 51.4.1) ----
// This is the real-time-translation bug in talkmed-meeting: every recognised
// sentence goes through AISubTitleSetupWindow.sqliteEscape, which does
// StringCore.replaceAllByRegex(keyWord, "[", "/[") and therefore builds
// new RegExp("[") -> a PCRE2 compile failure. AVM2 keeps that failure silent
// (core/RegExpObject.cpp::completeInitialization calls RegExp::compile and never
// reads the reported error back), so on AIR the object merely never matches; our
// emitter used to throw SyntaxError there, which aborted the recognition message
// handler BEFORE the AI_SUBTITLE_MSG dispatch, so the subtitle window opened and
// stayed empty forever. The runtime behaviour is pinned by examples/regexp.as;
// the emitter shape is pinned here, because that is what a refactor re-breaks.
function checkRegExpInertConstruction(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [regexp-inert] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [regexp-inert] ${label}`); }
  };
  const c = generateC(parse('var r:RegExp = new RegExp("a", "g");\ntrace(r);\n')).c;
  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    if (i < 0) return '';
    const j = c.indexOf('\n}', i);
    return c.slice(i, j < 0 ? c.length : j);
  };

  // 1. The constructor never throws: the compile error is recorded on the regex
  //    (as_regex.err) and surfaces as "no match", exactly like AVM2.
  const ctor = body('void RegExp_ctor(RegExp* o, char* pattern, char* flags) {');
  check('RegExp_ctor is emitted', ctor.length > 0);
  check('RegExp_ctor does not throw on a bad pattern', !/as_throw|SyntaxError_new/.test(ctor));
  check('RegExp_ctor still compiles the pattern', ctor.includes('o->compiled = as_regex_compile(pattern, flags);'));

  // 2. Every consumer must consult that error flag, or the zero-instruction
  //    program would run and match at position 0.
  check('as_regex_search bails out on err', c.includes('if (re == NULL || re->err) return -1;'));
  check('RegExp_exec bails out on err', c.includes('if (re->compiled == NULL || re->compiled->err) return NULL;'));
  check('RegExp_test bails out on err', c.includes('if (re->compiled == NULL || re->compiled->err) return false;'));

  // 3. A stray ')' must be a COMPILE error, not a silent stop. A sequence
  //    compiler that merely stops at the ')' leaves a zero-instruction program,
  //    which matches the empty string at every offset -- String.replace on such
  //    a "never matching" pattern would splice the replacement between every
  //    pair of characters.
  check('a stray ) is reported as a compile error',
    c.includes('unmatched closing parenthesis') &&
    c.includes('if (!re->err && c.pos < c.len) as_re_err(&c, "unmatched closing parenthesis");'));

  // 4. A lone ']' outside a class stays an ordinary literal (PCRE2), so the
  //    check above must not turn into a blanket "reject anything odd".
  check('the class compiler still owns [..]', c.includes('static int as_re_comp_class(as_re_comp* c) {'));

  console.log(`     [regexp-inert] ${ok} RegExp-inert check(s) passed`);
  return bad;
}
registerGroup('unit: runtime/RegExpInertConstruction', checkRegExpInertConstruction);

// ---- BitmapData pixels reach the screen, and setPixels honours ByteArray.endian ----
// The real-app bug (stage 216): the ANEVideo camera preview was a blank rectangle at a
// healthy fps. Two independent gaps stacked up --
//   1. BitmapData_setPixels read the buffer as A,R,G,B unconditionally, while ANEVideo
//      declares VideoByteArray.endian = Endian.LITTLE_ENDIAN because libyuv's
//      I420ToARGB output is B,G,R,A in memory, so every frame came out channel-swapped
//      with a bogus alpha; and
//   2. as_render_object_content only painted a Bitmap when bd->image != NULL, but a
//      decoded SkImage is only ever produced by loadFile/Loader/[Embed] -- a bitmap
//      built by "new BitmapData(...)" + setPixels (the shape every raw-pixel producer
//      uses) never got one, so the display list drew NOTHING.
// examples/bitmap-setpixels-endian.as pins the behaviour; this pins the emitted shape,
// because a refactor is what would quietly reintroduce either gap.
function checkRenderBitmapLivePixels(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [bmd-live] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [bmd-live] ${label}`); }
  };
  const src = 'var b:Bitmap = new Bitmap(new BitmapData(2, 2, false, 0));\ntrace(b);\n';
  const c = generateC(parse(src)).c;
  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    if (i < 0) return '';
    const j = c.indexOf('\n}', i);
    return c.slice(i, j < 0 ? c.length : j);
  };

  // 1. setPixels consults the source ByteArray's endian flag and flips the read order.
  const sp = body('void BitmapData_setPixels(void* _this, Rectangle* rect, ByteArray* ba) {');
  check('BitmapData_setPixels is emitted', sp.length > 0);
  check('setPixels reads ByteArray.endian', sp.includes('strcmp(ba->endian, "littleEndian") == 0'));
  check('littleEndian reads B,G,R,A (alpha last)',
    sp.includes('if (le) { a = src[3]; r = src[2]; g = src[1]; b = src[0]; }'));
  check('bigEndian keeps reading A,R,G,B (alpha first)',
    sp.includes('else { a = src[0]; r = src[1]; g = src[2]; b = src[3]; }'));
  check('setPixels bumps the pixel version', sp.includes('bd->_px_ver++;'));

  // 1b. The pixels come off the ByteArray CURSOR, and a short array is an
  //     EOFError rather than an over-read: AIR fills the cells it can and then
  //     throws #2030 (temp/gdsetpixels/, adl 51.4.1). Reading past `length` is
  //     exactly how the client process died -- a truncated ANE video frame read
  //     off a 1080p buffer into an unmapped page (exe+0x91a41, READ 0x50d1c000).
  check('setPixels reads at the ByteArray position',
    sp.includes('(unsigned char*)ba->data + ba->position'));
  check('setPixels advances the ByteArray position per pixel',
    sp.includes('ba->position += 4;'));
  check('setPixels refuses to read past the ByteArray length',
    sp.includes('ba->position + 4 > ba->length'));
  check('setPixels raises EOFError #2030 on a shortfall',
    sp.includes('{ as_throw_eof(); return; }'));
  check('setPixels advances the cursor before the bitmap bounds clip',
    sp.indexOf('ba->position += 4;') < sp.indexOf('px >= bd->width'));

  // 2. Every pixel mutator invalidates the cached view, or the screen freezes.
  const mutators = [
    'void BitmapData_setPixel(void* _this, int x, int y, unsigned color) {',
    'void BitmapData_setPixel32(void* _this, int x, int y, unsigned color) {',
    'void BitmapData_fillRect(void* _this, Rectangle* rect, unsigned color) {',
    'void BitmapData_copyPixels(void* _this, BitmapData* src,',
  ];
  for (const sig of mutators) {
    const fn = body(sig);
    const name = sig.slice('void '.length, sig.indexOf('('));
    check(name + ' bumps _px_ver', fn.length > 0 && fn.includes('_px_ver++'));
  }
  // draw/filter are emitted inline with their argument list on the same line.
  // draw's first parameter is IBitmapDrawable (AIR's declared type), not BitmapData.
  for (const [name, sig] of [
    ['draw', 'void BitmapData_draw(void* _this, IBitmapDrawable source, Matrix* matrix, ColorTransform* ct, char* blendMode, Rectangle* clipRect, bool smoothing) {'],
    ['copyChannel', 'void BitmapData_copyChannel(void* _this, BitmapData* src'],
    ['setVector', 'void BitmapData_setVector(void* _this, Rectangle* rect, as_vector_uint* v) {'],
    ['scroll', 'void BitmapData_scroll(void* _this, int dx, int dy) {'],
    ['perlinNoise', 'void BitmapData_perlinNoise(void* _this, double baseX, double baseY, unsigned numOctaves, int randomSeed, bool stitch, bool fractalNoise) {'],
    ['applyFilter', 'void BitmapData_applyFilter(void* _this, BitmapData* source, Rectangle* sourceRect, Point* destPoint, BitmapFilter* filter) {'],
  ]) {
    const fn = body(sig);
    check(name + ' bumps _px_ver', fn.length > 0 && fn.includes('_px_ver++'));
  }

  // 3. The render branch draws the live pixel view, not only a decoded image.
  check('the Bitmap render branch samples as_bmd_visible_image',
    c.includes('void* bd_img = as_bmd_visible_image(bd);'));
  check('the Bitmap render branch no longer requires bd->image',
    !c.includes('if (bd != NULL && bd->image != NULL) as_skia_canvas_draw_image_rect'));
  const live = body('static void* as_bmd_live_image(BitmapData* bd) {');
  check('as_bmd_live_image is emitted', live.length > 0);
  check('as_bmd_live_image caches on the version counter',
    live.includes('bd->_live_image != NULL && bd->_live_ver == bd->_px_ver'));
  check('as_bmd_live_image rebuilds from the pixel buffer',
    live.includes('as_skia_image_from_argb(bd->pixels, bd->width, bd->height)'));
  check('as_bmd_visible_image prefers the decoded view while unmutated',
    body('static void* as_bmd_visible_image(BitmapData* bd) {')
      .includes('if (bd->image != NULL && bd->_px_ver == 0) return bd->image;'));

  // 4. The cacheAsBitmap fingerprint must include the pixel version, or an
  //    auto-baked video view bakes once and never updates again.
  check('the auto-bake fingerprint hashes _px_ver', c.includes('h = as_fp_u32(h, bd->_px_ver);'));

  console.log(`     [bmd-live] ${ok} BitmapData live-pixel check(s) passed`);
  return bad;
}
registerGroup('unit: render/BitmapLivePixels', checkRenderBitmapLivePixels);

// ---- a package class must not hijack a bare spelling of a language built-in ----
//
// The host app compiles as3corelib's `com.adobe.serialization.json.JSON`
// alongside its own sources (it is under `src/`, so `--include-third-party` puts
// it in the same class table). `resolveType`'s last-resort short-name alias then
// maps the bare name `JSON` to that FQN, and a bare `JSON.parse(...)` with NO
// import at all (BaseModel.as:21) looked like a static call on the third-party
// class -- which declares only encode/decode/stringify -- so the whole app build
// died with `undefined static method 'parse' on class 'JSON'`.
//
// AS3 precedence: a package-less built-in (JSON/System/Math/Capabilities) is
// always in scope, while a package class is visible only after an import, so the
// built-in must win for the bare spelling. The SECOND check pins the other half:
// an explicit import still shadows the built-in, which is why the guard consults
// the file's import alias before trusting the set.
function checkStaticOnlyClassShadowing(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [shadow] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [shadow] ${label}`); }
  };
  // Two packages, because the hijack needs the foreign class to be OUT of the
  // referring file's own package (a same-package class really does shadow, and
  // that case must keep failing). Concatenating the two parses is exactly what
  // the `--air-app` path hands codegen.
  const merge = (parts: { body: unknown[]; imports: string[] }[]): { body: never; imports: string[] } =>
    ({ body: parts.flatMap((p) => p.body) as never, imports: parts.flatMap((p) => p.imports) });
  const lib = parse(`package acme.json {
  public class JSON {
    public static function decode(s:String):Object { return null; }
  }
}`);
  const plain = parse(`package acme.app {
  public class Probe {
    public static function run(s:String):Object { return JSON.parse(s); }
  }
}`);
  // The helper's own definition is always in the runtime preamble, so the number
  // of occurrences -- not mere presence -- tells a CALL apart from the definition.
  const calls = (c: string): number => [...c.matchAll(/as_json_parse\(/g)].length;

  let cPlain = '';
  let threw = '';
  try {
    cPlain = generateC(merge([lib, plain])).c;
  } catch (e) {
    threw = String(e);
  }
  check('a bare JSON.parse compiles even when another package declares a JSON class', threw === '');
  if (threw !== '') console.log(`      (threw: ${threw.split('\n')[0]})`);
  check('...and it CALLS the built-in parse helper (definition + call)',
    calls(cPlain) === 2);
  check('...while the foreign class is still emitted under its own package',
    cPlain.includes('acme_json_JSON'));

  // The other half of AS3 precedence: an explicit import wins over the built-in.
  const imported = parse(`package acme.app {
  import acme.json.JSON;
  public class Probe2 {
    public static function run(s:String):Object { return JSON.decode(s); }
  }
}`);
  const cImported = generateC(merge([lib, imported])).c;
  check('an explicit import still resolves the foreign class',
    cImported.includes('acme_json_JSON_decode_static('));
  check('...and the built-in parse helper is never called in that build',
    calls(cImported) === 1);

  console.log(`     [shadow] ${ok} built-in shadowing check(s) passed`);
  return bad;
}
registerGroup('unit: emit/StaticOnlyClassShadowing', checkStaticOnlyClassShadowing);

// The body of a generated C function, located by its exact signature. Used to
// tell WHERE a call lives (the wrapper or the _impl it delegates to), which a
// plain includes() cannot express.
function fnBody(c: string, sig: string): string {
  const i = c.indexOf(sig);
  if (i < 0) return '';
  const j = c.indexOf('\n}', i);
  return j < 0 ? c.slice(i) : c.slice(i, j + 2);
}

// Uncaught errors raised from a NATIVE ENTRY POINT must not end the process.
//
// The SDL callbacks (mouse/wheel/key), the window RESIZE/CLOSE notifications and
// the frame clock all run AS3 OUTSIDE any frame, so as_frame_guard is 0 when a
// handler throws and as_throw's fallback -- exit(1) -- used to fire. On Windows
// that exit deadlocks in the CRT/ANE DLL-detach teardown, so the process never
// dies: the window stays on screen and unresponsive. Measured:
// ShareWindowView.selectItemView threw #1009 (a missing dynamic String method) and
// the 分享屏幕 window froze as "(未响应)" instead of reporting and carrying on. AIR
// reports and keeps the player running, so every entry point plants the SAME
// recovery buffer Stage_dispatchFrame uses -- at most once per thread, never nested.
//
// The guard has to be released on EVERY exit path, including the early returns the
// bodies already had: a guard left planted against a returned stack frame would
// make every later entry point skip planting (leaving the old, dead buffer armed)
// and swallow the frame clock's own recovery point. `planted` is read before
// setjmp and never written after it, so longjmp cannot clobber it.
function checkEntryPointRecovery(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [entry] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [entry] ${label}`); }
  };
  const c = generateC(parse('trace(1);')).c;
  // (`dispatch` is how this entry point reaches AS3; it must still be here, not
  // moved into a helper the glue never calls.)
  const entry = (name: string, sig: string, dispatch: string): void => {
    const body = fnBody(c, sig);
    check(`${name} is the function the glue is handed`, body !== '');
    check(`${name}: plants the recovery buffer in its own frame`,
      body.includes('int planted = (as_frame_guard == 0);')
      && body.includes('if (planted && setjmp(as_frame_jmp) != 0)'));
    check(`${name}: takes the guard`, body.includes('as_frame_guard = 1;'));
    check(`${name}: still runs the dispatch itself`, body.includes(dispatch));
    // Every return must release the guard: either the recovery line itself, or an
    // explicit `if (planted) as_frame_guard = 0;` immediately before it.
    const lines = body.split('\n');
    const unguarded = lines.filter((l, k) => /\breturn\b/.test(l)
      && !l.includes('as_frame_guard = 0')
      && !(lines[k - 1] || '').includes('if (planted) as_frame_guard = 0;'));
    check(`${name}: releases the guard on every exit path`, unguarded.length === 0);
    if (unguarded.length > 0) console.log('      (unguarded: ' + unguarded.map((s) => s.trim()).join(' | ') + ')');
  };
  entry('ASC_window_on_mouse',
    'static void ASC_window_on_mouse(int id, double x, double y, const char* type) {',
    'Stage_dispatchMouse(');
  entry('ASC_window_on_wheel',
    'static void ASC_window_on_wheel(int id, double x, double y, double delta) {',
    'Stage_dispatchWheel(');
  entry('ASC_window_on_key',
    'static void ASC_window_on_key(int id, const char* type, int keyCode, int charCode, int mod) {',
    'Stage_dispatchKey(');
  entry('ASC_window_on_frame',
    'static void ASC_window_on_frame(int id) {',
    'Stage_dispatchFrame(');
  entry('ASC_window_on_resize',
    'static void* ASC_window_on_resize(int id, int lw, int lh, int pw, int ph, double scale) {',
    'EventDispatcher_dispatchEvent(');
  entry('ASC_window_on_close',
    'static void ASC_window_on_close(int id) {',
    'EventDispatcher_dispatchEvent(');

  // A resize that throws must still hand the glue a surface. It keeps the OLD one
  // when the callback answers NULL -- and by then this function has already freed
  // that surface and installed the replacement, so NULL would be a use-after-free.
  check('a resize that throws still hands back the NEW surface',
    fnBody(c, 'static void* ASC_window_on_resize(int id, int lw, int lh, int pw, int ph, double scale) {')
      .includes('return (w != NULL) ? w->surface : NULL;'));
  // A close that throws must still detach the object, or a later window that
  // reuses this id inherits a stale NativeWindow pointing at it.
  const closeBody = fnBody(c, 'static void ASC_window_on_close(int id) {');
  check('a close that throws still detaches the window slot',
    closeBody.includes('as_disp_depth = 0; if (w->window != NULL) ((NativeWindow*)w->window)->_win = -1; w->stage = NULL; w->window = NULL; return;'));
  // The callbacks are handed to the native layer by these exact names, so no
  // _impl/body split may reappear: both halves would have to be installed, and a
  // missed rename leaves the window with a dead handler.
  // The slice starts at the DEFINITION (the forward declaration above it matches
  // `static void ASC_window_on_mouse(int id, double x, double y, const char* type);`
  // too, and cutting there would span half the file).
  const mouseBody = c.slice(
    c.indexOf('static void ASC_window_on_mouse(int id, double x, double y, const char* type) {'),
    c.indexOf('static double ASC_window_on_frame_delay('));
  check('no entry point is split into a helper the glue does not know about',
    mouseBody.length > 1000 && !/_impl\b/.test(mouseBody));
  console.log(`     [entry] ${ok} entry-point recovery check(s) passed`);
  return bad;
}
registerGroup('unit: emit/EntryPointRecovery', checkEntryPointRecovery);

// displayState must follow the WINDOW, not the last call the app made.
//
// NativeWindow.minimize/maximize/restore write w->display_state (and dispatch their
// own displayStateChange), so an app that decides "maximize or restore?" from
// displayState -- the TalkMED meeting window's header does exactly that -- works as
// long as nobody else moves the window. The window manager does: a caption
// double-click, the maximize box and a taskbar minimize change the state without
// calling anything on the AS3 side, and the record then stays "normal" for the rest
// of the run. Measured on Windows 11: a real caption double-click left
// displayState pinned at "normal" on a maximized 2582x1692 window, so the app's next
// header click called maximize() again instead of restore(). adl reports
// "maximized" there (and dispatches displayStateChange), because its own record is
// fed by the platform events.
//
// The fix is in ASC_win_poll: ask the window what it is, write the answer back into
// the record, then let the existing snapshot comparison dispatch the event. The
// record stays the single source the getter reads, so no second code path can
// disagree with it, and a PROGRAMMATIC change needs no help -- it writes the record
// itself and SDL's flag agrees by the next pump, so the comparison sees no change
// and the event is not reported twice (verified: one displayStateChange per
// maximize() and per restore()).
function checkDisplayStateFollowsWindow(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dsfollow] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dsfollow] ${label}`); }
  };
  const c = generateC(parse('trace(1);')).c;
  const body = fnBody(c, 'static void ASC_win_poll(int id) {');
  check('ASC_win_poll is the poll the frame boundary calls', body !== '' &&
    c.includes('ASC_win_poll('));
  check('the poll asks the window for its own display state',
    body.includes('int osds = as_window_os_display_state(id);'));
  // Order matters: the code below compares against w->display_state, so a stale
  // record would make the transition invisible for exactly the frame that carried it.
  const iAsk = body.indexOf('int osds = as_window_os_display_state(id);');
  const iRead = body.indexOf('int ds = ASC_win_ds_code(w);');
  check('...and reconciles the record BEFORE the snapshot comparison reads it',
    iAsk >= 0 && iRead > iAsk);
  check('...writing it back as the one record the displayState getter answers',
    /w->display_state = want;\s*gc_write_barrier\(\(void\*\)w->display_state\);/.test(body));
  check('...mapping all three states the window manager can report',
    body.includes('(osds == 1) ? (char*)"minimized"') &&
    body.includes('(osds == 2) ? (char*)"maximized"') &&
    body.includes('(char*)"normal"'));
  // "fullScreen" is AS3's own notion (Stage.displayState / NativeWindow fallback);
  // a backend that reports fullscreen through the same flags must not overwrite it.
  check('...but never overwrites an AS3-owned fullScreen record',
    body.includes('strcmp(w->display_state, "fullScreen") == 0') &&
    body.includes('if (osds >= 0 && !ds_owned) {'));
  // The state code the poll compares with is still derived from the record, so the
  // getter, the snapshot and the event payload can never disagree.
  const dsCode = fnBody(c, 'static int ASC_win_ds_code(ASCWin* w) {');
  check('the code the poll compares is still taken from the record',
    dsCode.includes('char* ds = (w != NULL) ? w->display_state : NULL;') &&
    !dsCode.includes('os_display_state'));

  // Seam: both build flavours must provide it, or the generated C stops linking in
  // one of them (the exact failure mode unit: platform/BackendParity guards).
  const rt = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  check('the seam is declared once in runtime.ts',
    (rt.match(/extern int sk_window_os_display_state\(int id\);/g) ?? []).length === 1);
  check('...has a real body under ASC_USE_WINDOW',
    /static inline int as_window_os_display_state\(int id\) \{\s*#ifdef ASC_USE_WINDOW\s*return sk_window_os_display_state\(id\);/.test(rt));
  check('...and an inert -1 stub for builds without a window backend',
    rt.includes('static inline int as_window_os_display_state(int id) { (void)id; return -1; }'));
  const web = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8');
  check('the web backend answers "no opinion" rather than a wrong state',
    /int sk_window_os_display_state\(int id\) \{ \(void\)id; return -1; \}/.test(web));
  console.log(`     [dsfollow] ${ok} display-state check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DisplayStateFollowsWindow', checkDisplayStateFollowsWindow);

// A String reached through a * / Object slot dispatches on a DIFFERENT table from
// a statically typed one (as_any_call -> as_str_dyn_call). Two of AVM2's String
// methods are implemented in AS3 rather than native (core/String.as:
// `prototype.toLowerCase = prototype.toLocaleLowerCase = ...`, same pairing for
// toUpperCase), and four more are ordinary members, so the dynamic table has to
// carry all of them:
//
//   var d:Object = { name: "WPS" };
//   var n:String = d.name.toLocaleLowerCase();   // was null -> #1009 on n.indexOf
//
// That exact pair of lines is ShareWindowView.selectItemView in talkmed-meeting,
// and the #1009 it raised is what froze the 分享屏幕 window. An unknown name still
// answers null (the documented as_dyn_call contract), so a MISSING method is
// silent -- which is why the whole surface is pinned here, not just the two that
// bit us.
function checkDynamicStringMethods(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dynstr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dynstr] ${label}`); }
  };
  const c = generateC(parse("trace(1);")).c;
  const body = fnBody(c, "static as_value as_str_dyn_call(char* s, const char* name, as_value* args, int argc) {");
  check("the dynamic string dispatch table exists", body !== "");
  const has = (m: string): boolean => body.includes(`strcmp(name, "${m}") == 0`);
  // The two locale aliases must map to the PLAIN helpers, exactly as AVM2 does
  // (a separate locale table would diverge the moment one side changed).
  check("toLocaleLowerCase is dispatched", has("toLocaleLowerCase"));
  check("...to the plain lowercase helper",
    body.includes('strcmp(name, "toLocaleLowerCase") == 0) return as_v_str(as_str_toLower(s));'));
  check("toLocaleUpperCase is dispatched", has("toLocaleUpperCase"));
  check("...to the plain uppercase helper",
    body.includes('strcmp(name, "toLocaleUpperCase") == 0) return as_v_str(as_str_toUpper(s));'));
  check("concat is dispatched", has("concat"));
  check("...folding every argument through as_str_concat",
    body.includes("r = as_str_concat(r, as_v_str_val(args[i]));"));
  check("localeCompare is dispatched", has("localeCompare"));
  check("...through as_str_localeCompare", body.includes("as_str_localeCompare(s,"));
  check("startsWith is dispatched", has("startsWith"));
  check("endsWith is dispatched", has("endsWith"));
  // The rest of the ES3 surface that was already there must stay (a rewrite of
  // the table that dropped one would be just as fatal as a missing locale alias).
  for (const m of ["charAt", "charCodeAt", "indexOf", "lastIndexOf", "slice", "split",
                   "substr", "substring", "toLowerCase", "toUpperCase", "match",
                   "replace", "search", "toString", "valueOf"]) {
    check(`the pre-existing ${m} dispatch survives`, has(m));
  }
  console.log(`     [dynstr] ${ok} dynamic String dispatch check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DynamicStringMethods', checkDynamicStringMethods);

// stageWidth/stageHeight are DERIVED values — (window client size, scaleMode) — and
// AIR re-derives them the moment scaleMode changes. Ours only re-derived them on a
// resize or a render, which yields the same answer ONLY while the app never touches
// the mode after the window exists. Every AIR app with a NativeWindow does exactly
// that (measured: talkmed-meeting cn.edoctor.view.meeting.MeetingWindow, plus all
// its Toast/Files/Subtitle windows, which all follow `super(opts)` -> `bounds = rect`
// -> `stage.scaleMode = NO_SCALE` -> read stageWidth on the NEXT line to lay out):
//   temp/nworder/ , Windows 11 150%: after `bounds` the window was 1792x1038 while
//   stageWidth still read 400x200 (the ctor default, which is what showAll pins the
//   stage to), and it read 400x200 AFTER the scaleMode write too -- so the whole tree
//   was laid out for a 400x200 stage inside a maximized window, and the resize that
//   would have corrected it never came (the RESIZE listener is added after the layout).
//
// The fix is that Stage_set_scaleMode is no longer field-backed: it writes the field
// and then re-derives the size for the window that owns this Stage. Pinned here: the
// write order (field first, then refresh), the forward declaration (the window table
// is emitted far below, so without it the generated C is not C99-clean), and the fact
// that ONLY scaleMode got this treatment -- align and the rest stay plain field writes.
function checkStageSizeFollowsScaleMode(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [stagesize] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [stagesize] ${label}`); }
  };
  const c = generateC(parse('trace(1);')).c;
  const setter = fnBody(c, 'void Stage_set_scaleMode(void* _this, char* value) {');
  check('the scaleMode setter is hand-written, not the generic field assignment', setter !== '');
  check('...it still writes the field', setter.includes('((Stage*)_this)->scale_mode = value;'));
  check('...and then re-derives the stage size for the owning window',
    setter.includes('ASC_stage_size_refresh(_this);'));
  // Field BEFORE refresh: the refresh reads w->lw/design, not scale_mode, but a
  // future reader of the mode inside it would silently see the old value.
  check('...in that order', setter.indexOf('scale_mode = value') < setter.indexOf('ASC_stage_size_refresh'));
  check('no generic field-backed scaleMode setter survives to clash with it',
    !c.includes('void Stage_set_scaleMode(void* _this, char* value) { ((Stage*)_this)->scale_mode = value; }'));
  // A forward declaration must PRECEDE the definition: ASC_wins/ASCWin are emitted
  // with the multi-window block, long after the Stage accessors. Without the
  // prototype the definition is an implicit declaration at the call site (a hard
  // error in C99, which is what emcc compiles as).
  const decl = c.indexOf('static void ASC_stage_size_refresh(void* stage);');
  const def = c.indexOf('static void ASC_stage_size_refresh(void* stage) {');
  check('the helper is forward-declared', decl >= 0);
  check('...before its definition', decl >= 0 && def > decl);
  const body = fnBody(c, 'static void ASC_stage_size_refresh(void* stage) {');
  check('a NULL stage (boot stage, headless render) is not dereferenced',
    body.includes('if (stage == NULL) return;'));
  check('it finds the window that owns this Stage', body.includes('ASC_wins[i].stage == (Stage*)stage'));
  check('...and re-derives through the single stage-size writer',
    body.includes('ASC_window_apply_stage_size(i);') && !body.includes('stage_w = '));
  // Only scaleMode. align/quality/color are plain writes; adding the refresh to them
  // would turn every stage property write into a window-table scan.
  const align = 'void Stage_set_align(void* _this, char* value) { ((Stage*)_this)->align = value; }';
  check('align stays a plain field write', c.includes(align));
  // ---- 跨端：这段实现是目标无关的 ----
  // generateC 不按 --target/--package 分叉（native 与 wasm 产出的 .c 逐字节相同，实测
  // 2561482 字节完全相等），所以 macOS 与 web 拿到的是**同一份** setter + 助手。这里钉住
  // 两件事，免得将来有人给 web/mac 加 #ifdef 把它悄悄切窄：
  //   1) 两者都不在任何 #if 里；
  //   2) 它们只读共享窗口表（ASC_wins/ASCWin->lw）与舞台字段，不调任何后端入口。
  // 于是「后端答不上来」也不会把尺寸猜坏：web 后端是单窗口、画布尺寸即舞台尺寸，
  // sk_window_get_client_size 恒答 0（见 vendor/web_glue.cc），助手只在这条链表里找不到
  // 归属窗口时 no-op；macOS 侧的 lw 由 sk_client_size_live（NSWindow 倍率 + 活像素）给出。
  const noIf = (s: string): boolean => !/#\s*if/.test(s);
  check('the scaleMode setter is not behind a #ifdef (macOS/web compile it verbatim)', noIf(setter));
  check('...nor is the refresh helper', noIf(body));
  check('...and neither of them calls a backend entry point (shared window table only)',
    !/sk_window_|as_window_/.test(setter) && !/sk_window_|as_window_/.test(body));
  const writer = fnBody(c, 'static void ASC_window_apply_stage_size(int id) {');
  check('the single stage-size writer derives NO_SCALE from the window table alone',
    writer.includes('st->stage_w = w->lw;') && !/sk_window_|as_window_/.test(writer));
  console.log(`     [stagesize] ${ok} scaleMode stage-size check(s) passed`);
  return bad;
}
registerGroup('unit: emit/StageSizeFollowsScaleMode', checkStageSizeFollowsScaleMode);

// BitmapData.draw() takes an IBitmapDrawable, and that interface has TWO unrelated
// implementors: DisplayObject and BitmapData (in AVM2 a BitmapData is NOT a
// DisplayObject). Typing the parameter as either one made every capture path throw
// #1034 -- measured on the real app, whose capture is
//   bd.draw(skinView.view, matrix, null, Normal, null, true)
// where `view` is a dynamically read child (a MovieClip), so the call site coerced
// with as_v_req_inst(..., &BitmapData_vt, "flash.display::BitmapData") and every
// share-screen frame died with
//   Error #1034: Type Coercion failed: cannot convert [object MovieClip] to
//   flash.display.BitmapData.
// (temp/bmdraw, linked and run: sprite / movieclip / shape+textfield / typed
// DisplayObject / dynamic DisplayObject all paint pixels, a dynamic number throws
// #1034 naming flash.display.IBitmapDrawable, and null does not throw.)
//
// Pinned here: the declared parameter type (reflection signature too, since
// describeType reads the same table), the marker-interface registration that makes
// `x is IBitmapDrawable` true for BOTH roots, the explicit three-way vtable dispatch
// in the method body, and the dynamic coercion helper. Reintroducing the single-root
// type fails all of these at once.
function checkBitmapDrawableParam(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [drawable] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [drawable] ${label}`); }
  };
  const c = generateC(parse('var b:BitmapData = new BitmapData(2, 2, false, 0);\nb.draw(new Sprite());\n')).c;
  const fnBody = (sig: string): string => {
    const i = c.indexOf(sig);
    if (i < 0) return '';
    const j = c.indexOf('\n}', i);
    return c.slice(i, j < 0 ? c.length : j);
  };

  // 1. The declared parameter type is the interface, in C and in reflection.
  const sig = 'void BitmapData_draw(void* _this, IBitmapDrawable source, Matrix* matrix, ColorTransform* ct, char* blendMode, Rectangle* clipRect, bool smoothing) {';
  check('BitmapData_draw takes IBitmapDrawable', c.includes(sig));
  check('describeType reports flash.display::IBitmapDrawable for the source parameter',
    c.includes('"void;flash.display::IBitmapDrawable;?flash.geom::Matrix;'));
  check('the old BitmapData-typed parameter is gone',
    !c.includes('void BitmapData_draw(void* _this, BitmapData* source'));

  // 2. The marker interface is registered and both roots implement it.
  check('IBitmapDrawable is emitted as an interface type', c.includes('struct IBitmapDrawable {'));
  check('DisplayObject implements IBitmapDrawable',
    c.includes('static IBitmapDrawable_vtable DisplayObject_IBitmapDrawable_vt'));
  check('BitmapData implements IBitmapDrawable (a separate root)',
    c.includes('static IBitmapDrawable_vtable BitmapData_IBitmapDrawable_vt'));
  check('the implemented-interface table names the reflect FQN',
    c.includes('{ "IBitmapDrawable", "flash.display::IBitmapDrawable" }'));

  // 3. The body dispatches by vtable on the object half, one arm per root, and only
  //    an explicit BitmapData test reads its pixels.
  const body = fnBody(sig);
  check('the body reads the pair, object half', body.includes('void* src = source.obj;'));
  check('the TextField arm tests the vtable', body.includes('if (as_is(src, &TextField_vt)) {'));
  check('the DisplayObject arm tests the vtable', body.includes('} else if (as_is(src, &DisplayObject_vt)) {'));
  check('the BitmapData arm tests its own vtable before touching pixels',
    body.includes('} else if (as_is(src, &BitmapData_vt)) {') && body.includes('BitmapData* sbd = (BitmapData*)src;'));
  check('nothing dereferences the raw parameter as a BitmapData',
    !body.includes('(BitmapData*)source') && !body.includes('source->pixels'));

  // 4. A static call site passes the object straight through (no coercion), and a
  //    dynamic one goes through the runtime helper.
  check('a static DisplayObject argument builds the pair without a vtable lookup',
    /\(IBitmapDrawable\)\{ \(void\*\)\([a-z_0-9]+(\[[0-9]+\])?\), NULL \}/.test(c));
  check('draw is no longer coerced to BitmapData anywhere',
    !/BitmapData_draw(_\w+)?\([^;]{0,400}?as_v_req_inst\(args\[0\], &BitmapData_vt/.test(c));

  // 5. The dynamic helper accepts both roots and rejects everything else with the
  //    interface name (AIR's message), letting null through.
  const req = fnBody('static void* as_v_req_drawable(as_value v, const char* fqn) {');
  check('as_v_req_drawable is emitted', req.length > 0);
  check('...accepts BitmapData and DisplayObject',
    req.includes('as_is(p, &BitmapData_vt)') && req.includes('as_is(p, &DisplayObject_vt)'));
  check('...requires a heap class instance', req.includes('as_heap_kind(p) == GCT_CLASS'));
  check('...throws #1034 for anything else', req.includes('as_throw_1034(v, fqn)'));
  check('...lets null/undefined through', req.includes('if (v.tag == 0 || v.tag == 5) return NULL;'));
  check('the dynamic thunk routes through as_v_req_drawable',
    c.includes('as_v_req_drawable(args[0], "flash.display::IBitmapDrawable")'));

  console.log(`     [drawable] ${ok} IBitmapDrawable draw check(s) passed`);
  return bad;
}
registerGroup('unit: emit/BitmapDrawableParam', checkBitmapDrawableParam);
// Bitmap.smoothing (stage 230). AIR's default is false = nearest-neighbour
// sampling; true = bilinear. The Bitmap render branch used to pass Skia's default
// SkSamplingOptions() (== nearest) no matter what the property said, so
// `bitmap.smoothing = true` -- which the meeting client sets on every slide and
// screen-share bitmap -- was silently ignored, and a sub-pixel scale wobble showed
// up as a sharp/mushy flicker instead of a smooth interpolation.
//
// The pin covers the three places the flag has to travel through (the extern
// declaration, the ASC_USE_SKIA wrapper, the no-Skia stub) plus the two call
// sites, because a signature change that misses the stub only fails on a build
// that has no Skia -- i.e. exactly the configuration the examples suite runs.
function checkBitmapSmoothing(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [smoothing] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [smoothing] ${label}`); }
  };

  const glue = readNorm(join(root, 'vendor', 'skia_glue.cc'));
  const pre = RUNTIME_PREAMBLE;
  const c = generateC(parse('var bm:Bitmap = new Bitmap(new BitmapData(2, 2, false, 0));\nbm.smoothing = true;\n')).c;

  // 1. The glue takes the flag and maps it onto the SAME sampling pair the bitmap
  //    shader path already uses (kLinear/kNearest for smooth, kNearest/kNone for
  //    the AIR default).
  const gi = glue.indexOf('void sk_canvas_draw_image_rect(');
  const gbody = gi < 0 ? '' : glue.slice(gi, glue.indexOf('\n}', gi));
  check('the glue draw_image_rect takes an int smooth', /sk_canvas_draw_image_rect\(void\* canvas, void\* image,[\s\S]{0,160}int smooth\)/.test(glue));
  check('...and no longer draws with the bare default sampler', !/drawImageRect\(\(SkImage\*\)image, dst, SkSamplingOptions\(\)\)/.test(gbody));
  check('...smooth=true is kLinear', /smooth \? SkSamplingOptions\(SkFilterMode::kLinear, SkMipmapMode::kNearest\)/.test(gbody));
  check('...smooth=false is kNearest', /SkSamplingOptions\(SkFilterMode::kNearest, SkMipmapMode::kNone\)/.test(gbody));

  // 2. The flag must cross the C boundary in all three declarations, or the
  //    skia and no-skia builds disagree about the signature.
  check('the extern declaration carries int smooth',
    pre.includes('extern void sk_canvas_draw_image_rect(void* canvas, void* image, double dx, double dy, double dw, double dh, int smooth);'));
  check('the ASC_USE_SKIA wrapper carries int smooth',
    /static inline void as_skia_canvas_draw_image_rect\(void\* c, void\* img, double dx, double dy, double dw, double dh, int smooth\) \{ sk_canvas_draw_image_rect\(c, img, dx, dy, dw, dh, smooth\); \}/.test(pre));
  check('the no-Skia stub carries int smooth',
    pre.includes('static inline void as_skia_canvas_draw_image_rect(void* c, void* img, double dx, double dy, double dw, double dh, int smooth) { (void)c; (void)img; (void)dx; (void)dy; (void)dw; (void)dh; (void)smooth; }'));

  // 3. The Bitmap branch passes the AS3 property, not a constant.
  check('the Bitmap render branch passes ((Bitmap*)o)->smoothing',
    c.includes('as_skia_canvas_draw_image_rect(canvas, bd_img, 0.0, 0.0, (double)bd->width, (double)bd->height, ((Bitmap*)o)->smoothing ? 1 : 0);'));

  // 4. The cache-bake blit derives its sampler (see as_render_cached): nearest while
  //    the surface is exactly at the destination scale, linear while as_bake_scale2's
  //    up-clamp left it a minification.
  check('the cache bake blit derives its sampler from the canvas scale',
    c.includes('int bl_smooth = (fabs(bl_bx - sx) > 0.001 || fabs(bl_by - sy) > 0.001) ? 1 : 0;'));

  console.log(`     [smoothing] ${ok} Bitmap.smoothing check(s) passed`);
  return bad;
}
registerGroup('unit: emit/BitmapSmoothing', checkBitmapSmoothing);
// ---- trailing C-runtime-only slots must be inheritance-flattened ----------------
// `_arr` / `_dyn` / URLStream's transfer block / a socket's borrowed handle live
// after the last declared field of the class that INTRODUCES them, so a subclass
// pointer cast to its base reads the same offset. Appending a fresh copy at the end
// of every class in the chain instead left the inherited copy's bytes unused and
// handed them to the subclass's FIRST own field: `mheader._dyn` and
// `HeaderView.popInfoView` shared offset 0x130, so mheader_ctor's
// `_dyn = new Object()` made the info button's toggle dispatch through
// _as_object_vt slot 0x13c (which holds 1) — execute AV at 0x1 on the first click
// (阶段二百三十五). examples/dyn-layout.as pins the runtime side of this; the
// checks below pin the emitted layout itself.
function structBody(c: string, name: string): string {
  const start = c.indexOf(`struct ${name} {`);
  if (start < 0) return '';
  const end = c.indexOf('\n};', start);
  return end < 0 ? '' : c.slice(start, end);
}

function membersOf(body: string): string[] {
  return body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('struct '));
}

function checkRuntimeSlotLayout(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };

  const src = [
    'dynamic class SlotBase { public var slotBaseField:int = 1; }',
    'class SlotSub extends SlotBase { public var slotOwnField:Object; public var slotOwnInt:int = 2; }',
    'class SlotStream extends URLStream { public var slotStreamField:int = 3; }',
    'class SlotArray extends Array { public var slotArrayField:int = 4; }',
    'class SlotArray2 extends SlotArray { public var slotArrayOwn2:int = 5; }',
    'var sub:SlotSub = new SlotSub();',
    'var stm:SlotStream = new SlotStream();',
    'var arr:SlotArray = new SlotArray();',
    'trace(sub.slotOwnInt + stm.slotStreamField + arr.slotArrayField);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;
  const base = membersOf(structBody(c, 'SlotBase'));
  const sub = membersOf(structBody(c, 'SlotSub'));
  const stream = membersOf(structBody(c, 'SlotStream'));
  const array = membersOf(structBody(c, 'SlotArray'));

  const count = (ms: string[], m: string): number => ms.filter((x) => x === m).length;

  check('the dynamic base keeps _dyn as its last member', base[base.length - 1] === 'as_object* _dyn;');
  check('the subclass declares exactly one _dyn', count(sub, 'as_object* _dyn;') === 1);
  check('...and it sits right after the inherited field, not at the end',
    sub.indexOf('as_object* _dyn;') === sub.indexOf('int slotBaseField;') + 1);
  check('the subclass own fields follow the inherited _dyn slot',
    sub.indexOf('as_object* _dyn;') < sub.indexOf('Object* slotOwnField;'));

  check('URLStream keeps its transfer block after its last declared field',
    count(stream, 'void* _job;') === 1 && stream.indexOf('void* _job;') === stream.indexOf('void* _buf;') - 1);
  check('...and a URLStream subclass inherits it instead of re-declaring it',
    count(stream, 'void* _job;') === 1 && stream.indexOf('void* _job;') < stream.indexOf('int slotStreamField;'));

  const array2 = membersOf(structBody(c, 'SlotArray2'));
  check('an Array subclass keeps _arr as its last member', array[array.length - 1] === 'as_array* _arr;');
  check('...and ITS subclass declares exactly one _arr', count(array2, 'as_array* _arr;') === 1);
  check('...placed before the subclass own field',
    array2.indexOf('as_array* _arr;') < array2.indexOf('int slotArrayOwn2;'));

  console.log(`     [slots] ${ok} runtime-slot layout check(s) passed`);
  return bad;
}
registerGroup('unit: emit/RuntimeSlotLayout', checkRuntimeSlotLayout);

// ---- trace() of an AS3-null String must print "null", never hand NULL to printf --
// 阶段二百三十六: a statically String-typed slot holds AS3 null as C NULL, and
// String(null) is the four characters "null". Passing that NULL to printf("%s")
// is a hard fault on Windows ucrt (_invalid_parameter -> __fastfail(FAST_FAIL_
// INVALID_ARG), which is exactly how the TalkMED gift panel died: updateList()
// does trace(targetUrl) with targetUrl:String = null) and prints "(null)" on
// Apple libc. examples/trace-null.as reproduces the fatal path here (removing the
// wrapper from its generated C makes it exit 0xC0000409); these checks pin the
// emitted call shape and the runtime helper so the wrapper cannot silently go away.
function checkTraceNullString(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };

  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the runtime defines a NULL-safe display helper for static Strings',
    pre.includes('static char* as_str_or_null(const char* s) { return s != NULL ? (char*)s : (char*)"null"; }'));

  const src = [
    'class TraceHolder { public var neverSet:String; public var empty:String = ""; }',
    'var th:TraceHolder = new TraceHolder();',
    'function traceIt(s:String):void { trace(s); }',
    'traceIt("x");',
    'trace(th.neverSet);',
    'trace(th.empty);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  check('trace(String param) goes through as_str_or_null',
    c.includes('printf("%s\\n", as_str_or_null(s));'));
  check('...and never passes the raw String slot to printf',
    !c.includes('printf("%s\\n", s);'));
  check('trace(String field read) goes through as_str_or_null too',
    /printf\("%s\\n", as_str_or_null\([^;]*neverSet\)\)\);/.test(c));
  check('trace("" ) still goes through the helper (empty stays empty, not "null")',
    /printf\("%s\\n", as_str_or_null\([^;]*empty\)\)\);/.test(c));

  console.log(`     [trace-null] ${ok} trace-null check(s) passed`);
  return bad;
}
registerGroup('unit: emit/TraceNullString', checkTraceNullString);
// ---- Skia's "no runs" longest-line sentinel must never reach a TextField size -----
// 阶段二百三十七: `Paragraph::getLongestLine()` answers `FLT_MIN - FLT_MAX` (i.e.
// -3.4028e38) for a paragraph that produced no text runs at all, and autoSize did
// `_fieldWidth = tw + 4` with that raw value. The field's local box then ran
// [0 .. _fieldWidth] BACKWARDS, as_bounds_walk's union gave the parent l=-3.4028e38,
// and that propagated up the whole tree: the real TalkMED meeting client reported
// MeetingView.getBounds (and the Stage's) as +-3.4028235e38 every frame
// (ASC_MOUSE_TRACE=3 path dump, temp/applog/err-bb1.log:
// `flash.text::TextField own=0,0 -3.40282e+38x15`). examples/tf-autosize-empty.as
// pins the runtime side (with the clamp removed it fails with
// `empty width=3.4028234663852886e+38`); the checks below pin that every consumer
// reads the clamped helper, so the sentinel cannot come back through one of them.
function checkTextFieldLongestLine(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [emit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [emit] ${label}`); }
  };

  const src = [
    'import flash.text.TextField;',
    'import flash.text.TextFieldAutoSize;',
    'var tf:TextField = new TextField();',
    'tf.autoSize = TextFieldAutoSize.LEFT;',
    'trace(tf.textWidth);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  check('the emitted C defines as_tf_longest_line and clamps the sentinel to 0',
    c.includes('static double as_tf_longest_line(void* para) {')
    && c.includes('return (w > 0.0 && w < 1e30) ? w : 0.0;'));

  const helperAt = c.indexOf('static double as_tf_longest_line(void* para) {');
  const consumers = [
    'static double as_tf_align_dx(TextField* tf) {',
    'static void as_tf_apply_autosize(TextField* tf) {',
    'double TextField_get_textWidth(void* _this) {',
    'int TextField_get_maxScrollH(void* _this) {',
  ];
  check('...before every one of its callers (C has no implicit declarations)',
    helperAt >= 0 && consumers.every((s) => c.indexOf(s) > helperAt));

  check('autoSize takes its width from the clamped helper',
    /double tw = as_tf_longest_line\(para\);\s*double th = as_skia_textlayout_height\(para\);\s*if \(!tf->wordWrap\) tf->_fieldWidth = tw \+ 4\.0;/.test(c));
  check('TextAlignment dx does too',
    /double tw = as_tf_longest_line\(para\);\s*if \(a == 2\) return \(tf->_fieldWidth - 4\.0 - tw\) \/ 2\.0;/.test(c));
  check('TextField.textWidth does too (and still reports 0 for an empty paragraph)',
    /if \(as_skia_textlayout_line_count\(para\) == 0\) return 0\.0;\s*return as_tf_longest_line\(para\) \* as_tf_scale_ratio\(tf\);/.test(c));
  check('maxScrollH does too',
    /double tw = as_tf_longest_line\(para\);\s*double over = tw \+ 4\.0 - tf->_fieldWidth;/.test(c));
  check('the caret underline rect is sized by the helper, not by the raw sentinel',
    /as_skia_textlayout_height\(cpara\), as_tf_longest_line\(cpara\), 1\.0, up\)/.test(c));
  check('no size decision is left reading as_skia_textlayout_max_width directly',
    !/double tw = as_skia_textlayout_max_width\(para\);/.test(c));

  console.log(`     [tf-line] ${ok} TextField longest-line check(s) passed`);
  return bad;
}
registerGroup('unit: emit/TextFieldLongestLine', checkTextFieldLongestLine);

// ---- TextField 的可编辑滚动与插入光标（阶段二百四十二）------------------------
// 用户（air-native 实测）报的三件事里有两件是真缺陷：
//   ① 长文本打字不滚动：`maxScrollH` 被一个**我们自己发明的** `hscroll` 开关挡住，
//      而 AIR 根本没有这个属性（adl 51.4.1 赋值抛 #1056）⇒ 任何 AIR 程序的
//      `maxScrollH` 恒 0，`scrollH` 也只能是 0，字段永远停在左边/第一行。
//   ② 动态（非 INPUT）字段画了插入光标：AIR 只在 INPUT 字段画。
// 另一件（`.text` 读不到）与光标/选区鼠标操作在 adl 与 AOT 双端复现结果一致，不是缺陷。
// 行为侧由 examples/tf-scale-metrics.as ③ 段（Skia）与 examples/textrich.as 钉住；
// 这里钉生成代码里的四处形状，防止回退。
function checkTextFieldScrollAndCaret(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [tfscroll] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [tfscroll] ${label}`); }
  };

  const src = [
    'import flash.text.TextField;',
    'import flash.text.TextFieldType;',
    'var tf:TextField = new TextField();',
    'tf.type = TextFieldType.INPUT;',
    'tf.text = "abc";',
    'trace(tf.maxScrollH);',
    'trace(tf.scrollH);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // ① AIR has no `hscroll`: neither a slot, nor a props-table entry, nor a read.
  check('the invented `hscroll` slot is gone from the TextField struct',
    !/bool hscroll;/.test(c));
  check('...and from the props reflection table',
    !/"hscroll"/.test(c));
  check('...and nothing reads tf->hscroll any more',
    !/tf->hscroll/.test(c));

  // ② maxScrollH is unconditional and wordWrap-gated (measured on adl 51.4.1).
  check('maxScrollH ignores wrapping only (no hscroll gate)',
    /int TextField_get_maxScrollH\(void\* _this\) \{\s*TextField\* tf = \(TextField\*\)_this;\s*if \(tf->wordWrap\) return 0;/.test(c));
  check('maxScrollH truncates textWidth + 4 - width (AIR reports 18 for 214.1 in a 200 px box)',
    /double over = tw \+ 4\.0 - tf->_fieldWidth;\s*return \(over > 0\.0\) \? \(int\)over : 0;/.test(c));

  // ③ Every painter/hit-tester pans by _scroll_h directly.
  const leftpx = c.match(/int leftpx = tf->_scroll_h;/g) ?? [];
  check('all three pan sites read _scroll_h with no ternary', leftpx.length === 3);
  check('no `tf->hscroll ?` ternary survives',
    !/tf->hscroll \?/.test(c));

  // ④ The post-edit pan exists, is declared before its use, and is called from splice.
  const helperDef = c.indexOf('static void as_tf_scroll_after_edit(TextField* tf) {');
  const fwd = c.indexOf('static void as_tf_scroll_after_edit(TextField* tf);');
  const splice = c.indexOf('static bool as_tf_splice(TextField* tf, int lo, int hi, const char* ins) {');
  check('as_tf_scroll_after_edit has a forward declaration', fwd >= 0);
  check('...placed before as_tf_splice (C needs it)',
    fwd >= 0 && splice > fwd);
  check('...defined after maxScrollH (it reads it)',
    helperDef > c.indexOf('int TextField_get_maxScrollH(void* _this) {'));
  check('...and every splice ends by panning the caret into view',
    /as_tf_set_caret\(tf, lo \+ insLen\);\s*as_tf_scroll_after_edit\(tf\);/.test(c));
  check('the horizontal pan steps by a quarter of the inner width (AIR 200 -> 49)',
    /int step = \(int\)\(inner \/ 4\.0\); if \(step < 1\) step = 1;/.test(c));
  check('the vertical pan only moves when the caret line leaves the viewport',
    /as_tf_scroll_caret\(tf, as_tf_line_of_index\(starts, n, caret\), 0\);/.test(c));

  // ⑤ The caret is an INPUT affordance (measured: a focused dynamic field shows none),
  //    while the selection band stays a selectable-only thing (dragging a dynamic
  //    field does paint it). The two gates must therefore differ by exactly the type
  //    test, or one of the two measured rules breaks.
  check('the caret gate requires an INPUT field',
    c.includes('if (ASC_caret_pass && as_focus_obj == (void*)tf && tf->selectable && as_tf_is_input(tf)) {'));
  check('the selection band gate does NOT (dynamic selectable fields still highlight)',
    c.includes('int selVis = (as_focus_obj == (void*)tf) && tf->_sel_begin >= 0 && tf->_sel_end > tf->_sel_begin;'));

  console.log(`     [tfscroll] ${ok} TextField scroll/caret check(s) passed`);
  return bad;
}
registerGroup('unit: emit/TextFieldScrollAndCaret', checkTextFieldScrollAndCaret);

// Top-level FREE FUNCTIONS were the last identifier class outside the C naming
// sanitizer: `freeCName` returned the raw AS3 name for everything except `main`.
// Four measured collisions followed (measured on the generated C, and `adl` runs
// each of these files fine -- §1.5 => 遗留缺陷):
//   `function log`    vs <math.h>    "static declaration of 'log' follows non-static declaration"
//   `function index`  vs <string.h>  (legacy BSD alias, same error)
//   `function Sprite` vs the typedef "redefinition of 'Sprite' as different kind of symbol"
//   `function max`    vs <windef.h>  `#define max(a,b)` (Windows, NOMINMAX unset)
// The rename is C-side only, and must reach EVERY emission site, or a call or a
// Function value would keep naming the clashing symbol. examples/ident-free-fn.as
// pins the behaviour end to end; this group pins the spellings.
function checkEmitFreeFunctionNameReservation(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ffname] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ffname] ${label}`); }
  };

  const c = generateC(parse(
    'function log(x:Number):Number { return x * 10; }\n'
    + 'function _log(x:Number):Number { return x * 100; }\n'
    + 'function index(s:String):String { return "i:" + s; }\n'
    + 'function Sprite():int { return 42; }\n'
    + 'function max(a:Number, b:Number):Number { return a > b ? a : b; }\n'
    + 'function isnan(x:Number):Boolean { return x !== x; }\n'
    + 'function helper():int { return 7; }\n'
    + 'function main():int { return 1; }\n'
    + 'var v:Number = log(5) + _log(2) + Sprite() + max(1, 2) + (isnan(0) ? 1 : 0);\n'
    + 'var s:String = index("x");\n'
    + 'var f:Function = log;\n'
    + 'trace("" + v + s + helper() + main() + f(3));\n')).c;

  // The prototypes must not spell a libc/libm/typedef/host-macro name. The
  // disambiguation is a `__` SUFFIX (阶段 247, G8 part B): a `_` prefix is defeated
  // by the host's own object-like macros -- MSVC's `#define _stat _stat64i32`
  // turned the old `stat -> _stat` rename into a collision with the real
  // declaration. See sanitizeFileCIdent in src/symbols.ts.
  check('a free function named `log` is emitted as `log__`',
    c.includes('static double log__(double x);'));
  check('no prototype is left spelled `log`',
    !/\bdouble log\(double x\)/.test(c) && !/\bstatic double log\(/.test(c));
  check('a free function named `index` is emitted as `index__`',
    c.includes('static char* index__(char* s);'));
  check('a free function named after a C TYPE is renamed (`Sprite` -> `Sprite__`)',
    c.includes('static int Sprite__();') && !/\bstatic int Sprite\(\)/.test(c));
  check('function-like host macros are avoided (`max`/`isnan` -> `max__`/`isnan__`)',
    c.includes('static double max__(double a, double b);') && c.includes('static bool isnan__(double x);'));
  check('a name that does not collide is left alone',
    c.includes('static int helper();'));

  // Distinct AS3 names must stay distinct C symbols. `log` claims `log__`, and the
  // AS3 name `_log` is itself free (no header spells `_log`), so it keeps its own
  // spelling -- the two never alias. (Under the old `_`-prefix scheme this was the
  // `_log` -> `__log` climb; the suffix scheme makes the pair fall out naturally.)
  check('the pair `log`/`_log` stays two distinct C symbols',
    c.includes('static double log__(double x);') && c.includes('static double _log(double x);'));

  // Every emission site must use the renamed symbol, not just the prototype.
  check('the definition is renamed too',
    c.includes('static double log__(double x) {'));
  check('the call site is renamed',
    c.includes('log__(((double)(5)))') && c.includes('_log(((double)(2)))'));
  check('the Function-value thunk is renamed (`__call` names the same symbol)',
    c.includes('log____call') && c.includes('as_fn_make(log____call'));

  // `main` keeps its bespoke rename (user-main.as is the end-to-end pin).
  check('a user `main()` still becomes `asc_user_main`',
    c.includes('static int asc_user_main()') && c.includes('int main(void) {'));

  // The OTHER half of the same defect: object-like Windows macros (`#define small
  // char`) rewrite a struct member wherever it appears, so renaming a function
  // cannot fix them — the preamble's `#undef` block does. Pinned at source level
  // because the block is `#if defined(_WIN32)`-guarded and this suite runs on
  // macOS; `examples/ident-free-fn.as` carries the runtime half on Windows.
  const undef = /#if defined\(_WIN32\)([\s\S]*?)#endif/.exec(RUNTIME_PREAMBLE);
  const block = undef ? undef[1] : '';
  check('the preamble has a _WIN32 #undef block for object-like host macros', block.includes('#undef _timezone'));
  check('it covers the measured `small` case', block.includes('#undef small'));
  check('it covers the measured `near`/`far` case', block.includes('#undef near') && block.includes('#undef far'));
  check('it does NOT undef CALLBACK (the Win32 path really uses BOOL CALLBACK)',
    !block.includes('#undef CALLBACK'));

  console.log(`     [ffname] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/FreeFunctionNameReservation', checkEmitFreeFunctionNameReservation);

// File.moveToTrash / moveToTrashAsync / spaceAvailable (阶段二百四十三).
//
// Source-level pins for the parts an example cannot see: the error numbers each
// failure path throws, the fact that the trash layout is chosen per platform
// (none of the three branches but one is compiled on any given host), the
// collision-name shape measured on adl, and the regular-file guard that makes
// spaceAvailable answer 0 for a device. `examples/move-to-trash.as` carries the
// runtime half on macOS; the Windows branch of as_trash_dir returns NULL by
// design, so this group is what keeps the whole block honest on one host.
function checkEmitFileMoveToTrash(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [newfiles] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [newfiles] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n'
    + 'var f:File = new File("/tmp/x");\n'
    + 'f.moveToTrash();\n'
    + 'f.moveToTrashAsync();\n'
    + 'var n:Number = f.spaceAvailable;\n'
    + 'trace("" + n);\n')).c;

  // Signature: AIR declares moveToTrash():void, so the C body must return void
  // and take no arguments.
  check('moveToTrash is emitted as a void method',
    c.includes('static void File_moveToTrash(void* _this);'));
  check('moveToTrashAsync is emitted as a void method',
    c.includes('static void File_moveToTrashAsync(void* _this);'));
  // Both must be reachable through the method table, not just emitted.
  check('both names are in File\'s method table',
    c.includes('"moveToTrash"') && c.includes('"moveToTrashAsync"'));

  // The three measured failure numbers, and the measured success semantics.
  check('a missing path throws #3003',
    c.includes('if (err == 3003) { as_throw(Error_new((char*)"Error #3003: File or directory does not exist.", 3003)); return; }'));
  check('a filesystem refusal throws #2038',
    c.includes('as_throw(IOError_new((char*)"Error #2038: File I/O Error.", 2038));'));
  check('an empty File throws #2037',
    c.includes('Functions called in incorrect sequence, or earlier call was unsuccessful.", 2037)'));
  // AIR leaves nativePath alone after a successful move (measured), so the body
  // must not rewrite it -- File_moveTo, right below, is the member that does.
  const trashBody = /void File_moveToTrash\(void\* _this\) \{([\s\S]*?)\n\}/.exec(c);
  check('the receiver is never rewritten to the trash path',
    trashBody != null && !trashBody[1].includes('nativePath ='));

  // The async half reports through events (measured), and carries errorID.
  check('moveToTrashAsync dispatches COMPLETE',
    c.includes('EventDispatcher_dispatchEvent((void*)o, Event_new((char*)"complete", false, false));'));
  check('moveToTrashAsync dispatches ioError with the AIR error id',
    c.includes('IOErrorEvent_new((char*)"ioError", false, false, (char*)text)') && c.includes('ev->errorID = (int)err;'));

  // Trash layouts: Finder's on macOS, the freedesktop.org pair on other POSIX, the
  // shell's Recycle Bin on Windows (stage 244 -- pinned by platform/WindowsHostBackends),
  // and NULL on wasm (the browser has no trash concept: reported, not faked).
  check('macOS uses ~/.Trash', c.includes('as_path_join(home, ".Trash")'));
  check('another macOS volume uses .Trashes/<uid>',
    c.includes('snprintf(owner, sizeof owner, ".Trashes/%d", (int)getuid())'));
  check('freedesktop uses files/ beside info/',
    c.includes('as_path_join(base, "files")') && c.includes('as_path_join(base, "info")'));
  check('freedesktop writes the .trashinfo sidecar',
    c.includes('[Trash Info]') && c.includes('DeletionDate='));
  check('a trashed item already inside the trash directory is a no-op',
    c.includes('if (!nested) return 0;'));

  // Collision naming, measured on adl 51.4.1: "x.txt" -> "x.txt 18-34-09-271.txt"
  // -- the whole name, a space, HH-MM-SS-mmm, then the extension again.
  check('the collision suffix is HH-MM-SS-mmm',
    c.includes('" %02d-%02d-%02d-%03d"'));
  check('the collision name keeps the whole original name',
    c.includes('memcpy(stamped + nl, stamp, sl);'));

  // spaceAvailable answers only for a regular file or a directory (measured:
  // /dev/null is 0), which statvfs()/GetDiskFreeSpaceExA alone would not do.
  check('spaceAvailable type-checks the path first',
    c.includes('if (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) return 0.0;'));

  console.log(`     [newfiles] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/FileMoveToTrash', checkEmitFileMoveToTrash);

// ---- 阶段二百六十二：File.isSymbolicLink （唯一不跟随链接的谓词） ----------
// The member was added because a size walk that follows links over-reports: on this
// machine ~/Library/Caches answers 124 GB that way and 7.6 GB with the guard (see
// docs/{zh-cn,en}/filesystem.md §6, which also carries the adl 51.4.1 table). These
// checks pin the emission; `example: file-symlink.as` pins the values and the walk.
function checkEmitFileIsSymbolicLink(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [symlink] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [symlink] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n'
    + 'var f:File = new File("/tmp/x");\n'
    + 'var b:Boolean = f.isSymbolicLink;\n'
    + 'trace("" + b);\n')).c;

  check('isSymbolicLink is emitted as a bool getter',
    c.includes('bool File_get_isSymbolicLink(void* _this)'));
  // Reachability, not just emission: an instance property is only callable if it is
  // in the getter table the property read dispatches through.
  check('it is reachable through the instance getter table',
    c.includes('"isSymbolicLink"'));

  // lstat, never stat. Following the link is precisely the bug this member removes,
  // and `S_ISLNK` is what makes a DANGLING link answer true while exists answers
  // false -- the one asymmetry that cannot be produced with stat().
  check('the POSIX probe is lstat()-based',
    c.includes('static bool as_path_is_symlink(const char* p) {')
    && c.includes('return lstat(p, &st) == 0 && S_ISLNK(st.st_mode);'));
  check('the probe answers false for a NULL path instead of crashing',
    c.substring(c.indexOf('static bool as_path_is_symlink')).includes('if (p == NULL) return false;'));
  // Windows has no lstat that sees a reparse point, so it asks the attributes
  // directly; an NTFS junction answers true on adl as well.
  check('the Windows probe is FILE_ATTRIBUTE_REPARSE_POINT',
    c.includes('(a & FILE_ATTRIBUTE_REPARSE_POINT) != 0'));
  check('the two probes are selected at compile time, not at runtime',
    /#ifdef _WIN32\s*\n\s*DWORD a = GetFileAttributesA\(p\);/.test(c.substring(c.indexOf('static bool as_path_is_symlink')))
    && c.substring(c.indexOf('static bool as_path_is_symlink')).includes('#else'));

  // The OTHER family must stay on stat(): isDirectory follows the link, so for a
  // symlink to a directory both predicates are true. Asserted side by side so a
  // later "unify the two probes" refactor cannot quietly pass.
  check('isDirectory still follows the link (stat/S_ISDIR)',
    c.includes('static bool as_path_is_dir(const char* p)')
    && c.includes('&& stat(p, &st) == 0 && S_ISDIR(st.st_mode);'));

  console.log(`     [symlink] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/FileIsSymbolicLink', checkEmitFileIsSymbolicLink);

// ---- 阶段二百六十四：File.getDirectoryListingAsync 真异步化（+ 同步成员异常口径） ----
// The async member used to be a synchronous fake: it called getDirectoryListing()
// and dispatched FileListEvent from the same call, so the AS3 thread paid for the
// whole walk and cancel() could not mean anything. The new shape is pinned HERE
// because the property under test is "the enumeration moved off this thread", and
// the examples pool can only observe the results, not where they were produced.
// The measured contract lives in temp/listingprobe/ (adl 51.4.1) and the
// behavioural end-to-end assertions in examples/file-listing-async.as.
function checkEmitDirListingAsync(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dirasync] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dirasync] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.events.FileListEvent;\n'
    + 'import flash.filesystem.File;\n'
    + 'var f:File = new File("/tmp/x");\n'
    + 'f.getDirectoryListingAsync();\n'
    + 'var a:Array = f.getDirectoryListing();\n'
    + 'trace("" + a.length);\n')).c;
  const pre = RUNTIME_PREAMBLE;
  const emitSrc = readNorm(join(root, 'src', 'emit.ts'));

  // 1. The enumeration really happens in the pool: a dedicated job kind, submitted
  //    with the finish thunk, and the async member's body no longer enumerates.
  check('the job pool has a directory-listing kind', /#define AS_JOB_DIR\s+10\n/.test(pre));
  check('the async member submits that kind rather than enumerating',
    emitSrc.includes("as_async_submit(AS_JOB_DIR, (void*)o, File__dirFinish, o->nativePath, NULL, 0);"));
  check('the async member no longer calls the sync member',
    !emitSrc.substring(
      emitSrc.indexOf("'void File_getDirectoryListingAsync(void* _this) {'"),
      emitSrc.indexOf("'void File_deleteFileAsync(void* _this) {'"),
    ).includes('File_getDirectoryListing(_this)'));
  check('the worker enumerates (opendir on POSIX, FindFirstFile on Windows)',
    /case AS_JOB_DIR: \{[\s\S]*?opendir\(j->path\)/.test(pre)
    && pre.includes('FindFirstFileA(pat, &fd)'));

  // 2. The worker must not touch the GC heap: it stages names in malloc'd memory
  //    and only the finish thunk (on the AS3 thread) builds File objects.
  check('the worker stages names in malloc memory, not an as_array',
    /case AS_JOB_DIR: \{[\s\S]*?as_job_dir_push\(j, /.test(pre)
    // Scoped to the case body: later cases in the same switch do use as_array.
    && !pre.substring(pre.indexOf('case AS_JOB_DIR: {'), pre.indexOf('case AS_JOB_HTTP: {'))
      .includes('as_array_push('));
  check('the staged names are freed when the job retires',
    /as_job_retire\(as_job\* j\)[\s\S]{0,1200}?free\(j->names\);/.test(pre));
  check('the finish thunk reads them through accessors',
    c.includes('as_job_dir_count(job)') && c.includes('as_job_dir_name(job, i)'));

  // 3. Only a MISSING path is an error. An unreadable directory (EACCES) and a path
  //    that is not a directory both complete with an EMPTY listing on adl, so "the
  //    open failed" must not be turned into an ioError -- that would be a silent
  //    wrong answer for a cleaner, which is exactly the caller this matters to.
  check('a failed stat is the only enumeration error (ioError #3003)',
    /case AS_JOB_DIR: \{[\s\S]*?stat\(j->path, &st\) != 0\) \{ j->error = AS_JOB_ERR_NOT_FOUND; break; \}/.test(pre));
  check('an unopenable-but-existing directory is an empty listing, not an error',
    !/DIR\* d = opendir\(j->path\);\s*\n\s*if \(d == NULL\) \{[\s\S]{0,400}?AS_JOB_ERR_IO/.test(pre));
  check('the #3003 dispatch carries the measured id and text',
    c.includes('ev->errorID = 3003;')
    && c.includes('Error #3003: File or directory does not exist.'));

  // 4. cancel() cancels, and a second call while one is in flight throws #2037.
  //    Both are what make this member's async-ness observable to a caller.
  check('cancel() marks the in-flight job dead',
    emitSrc.includes('void File_cancel(void* _this) {') && emitSrc.includes('as_async_cancel((void*)_this);'));
  check('the in-flight guard is what raises #2037',
    emitSrc.includes('as_async_dir_pending((void*)o)')
    && pre.includes('static int as_async_dir_pending(void* obj)'));
  check('the #2037 text is the measured one',
    c.includes('Error #2037: Functions called in incorrect sequence, or earlier call was unsuccessful.'));

  // 5. The SYNC member's guards, measured on adl side by side with the async ones:
  //    it THROWS where the async member completes, so sharing an assertion between
  //    the two would be wrong.
  check('sync throws #2037 for an empty File',
    emitSrc.includes('if (o->nativePath == NULL) as_throw(Error_new((char*)"Error #2037:'));
  check('sync throws #3003 for a path that does not exist',
    emitSrc.includes('if (!as_path_exists(o->nativePath)) as_throw(Error_new((char*)"Error #3003: File or directory does not exist.", 3003));'));
  check('sync throws #3007 for a path that is not a directory',
    emitSrc.includes('if (!as_path_is_dir(o->nativePath)) as_throw(Error_new((char*)"Error #3007: Not a directory.", 3007));'));
  // The guards must precede the opendir body, or an unreadable directory would be
  // reported as one of them instead of as the empty listing adl answers.
  check('the guards run before the enumeration body',
    emitSrc.indexOf('Error #3007: Not a directory.') < emitSrc.indexOf('opendir(o->nativePath)'));

  console.log(`     [dirasync] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DirListingAsync', checkEmitDirListingAsync);

// ---- 阶段二百四十五：flash.system.System.exit(code:uint) ----------------
// Pins the SHAPE of the emission. The running process status is asserted end to
// end by `example: system-exit-status.as` in test/examples.ts (an examples/ pool
// unit cannot: that pool requires status 0), and the two diagnostics by
// `unit: diagnostics/Codegen`.
function checkEmitSystemExit(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sysexit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sysexit] ${label}`); }
  };
  const gen = (src: string) => generateC(parse(src)).c;

  const c0 = gen('System.exit(0);');
  check('a System.exit call reaches the runtime helper',
    c0.includes('as_system_exit(((unsigned int)(0)));'));
  // A Number goes through the AS3 ToUint32 helper (ES3 ToUint32: NaN/±Infinity ->
  // 0, wrap at 2^32), NOT a C cast -- `(unsigned)double` is UB out of range.
  check('a Number argument is coerced with as_to_uint32, not a C cast',
    gen('var n:Number = 7.9;\nSystem.exit(n);').includes('as_system_exit(as_to_uint32(g_n));'));
  check('a * argument is coerced through the boxed ToUint32 helper',
    gen('var a:* = 3;\nSystem.exit(a);').includes('as_system_exit(as_v_uint_cast(g_a));'));

  // main returns the RECORDED status: a literal 0 there would silently drop the
  // code, which is exactly the half an examples/ unit cannot observe.
  check('main returns as_exit_status instead of a literal 0',
    c0.includes('return as_exit_status;')
    && /int main\(void\) \{[\s\S]*?return as_exit_status;/.test(c0));

  // Both preamble arms record the code. The windowed one also asks the shared loop
  // to stop (the SAME teardown NativeApplication.exit() takes -- AIR's reference
  // tells AIR apps to call that method instead); the headless arm has no loop.
  const pre = RUNTIME_PREAMBLE;
  check('the windowed arm records the code and requests the exit',
    /static int as_exit_status = 0;\r?\nstatic inline void as_system_exit\(unsigned code\) \{\r?\n {4}as_exit_status = \(int\)code;\r?\n {4}as_window_request_exit\(\);\r?\n\}/.test(pre));
  check('the headless arm records the code (no loop to stop)',
    pre.includes('static inline void as_system_exit(unsigned code) { as_exit_status = (int)code; }'));
  // ...and nothing else in the preamble writes that flag, so the status can only
  // come from a System.exit call.
  check('as_exit_status is written in exactly one place per arm',
    (pre.match(/as_exit_status = \(int\)code;/g) ?? []).length === 2);

  console.log(`     [sysexit] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/SystemExit', checkEmitSystemExit);

// 阶段二百四十七 (G8): a top-level AS3 function is emitted under its own name, so
// any name a system header already DECLARES or #DEFINES is a hard C compile error --
// `bind` vs <winsock.h>/<sys/socket.h>, `stat` vs <sys/stat.h>, `printf` vs <stdio.h>.
// These names are legal AS3 and run under `adl`, so the fix is to rename the C symbol,
// never to reject the program. Pinned here (not in examples/) because what must not
// silently change is the SPELLING of the renamed symbol, and the fact that the
// block-scope table stayed narrow -- a rename that compiles is invisible to an
// examples/ unit that only observes behaviour.
function checkEmitCNameCollision(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cname] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cname] ${label}`); }
  };
  const gen = (src: string) => generateC(parse(src)).c;

  // --- file scope: `__` SUFFIX, never `_` prefix -------------------------------
  // The suffix is the whole point of G8 part B: MSVC <sys/stat.h> has
  // `#define _stat _stat64i32`, so the old `stat -> _stat` rename expanded into a
  // direct collision with the real declaration (`conflicting types for
  // '_stat64i32'`). C reserves the `__` PREFIX, not the suffix.
  check('a declared function name gets a `__` suffix (`bind`)',
    gen("function bind(a:int, b:int):int { return a + b; }\ntrace(bind(1, 2));")
      .includes('static int bind__(int a, int b);'));
  check('a macro-only name gets the same suffix (`stat`)',
    gen("function stat(x:int):int { return x; }\ntrace(stat(1));")
      .includes('static int stat__(int x);'));
  check('`stat` is NOT renamed to the macro-eaten `_stat`',
    !/\bint _stat\(/.test(gen("function stat(x:int):int { return x; }\ntrace(stat(1));")));
  check('a socket-family name is renamed (`socket`, `listen`)', (() => {
    const c = gen("function socket(x:int):int { return x; }\n"
      + "function listen(x:int):int { return x; }\ntrace(socket(1) + listen(2));");
    return c.includes('static int socket__(int x);') && c.includes('static int listen__(int x);');
  })());
  check('a stdio name is renamed (`printf`)',
    gen("function printf(x:int):int { return x; }\ntrace(printf(1));")
      .includes('static int printf__(int x);'));
  check('a function-like host macro is renamed (`min`, `isnan`)', (() => {
    const c = gen("function min(a:int, b:int):int { return a; }\n"
      + "function isnan(x:int):int { return x; }\ntrace(min(1, 2) + isnan(3));");
    return c.includes('static int min__(int a, int b);') && c.includes('static int isnan__(int x);');
  })());
  check('an ordinary name is left byte-identical (`helper`)',
    gen("function helper(x:int):int { return x; }\ntrace(helper(1));")
      .includes('static int helper(int x);'));
  check('`main` still maps to asc_user_main',
    gen('function main():void { trace(1); }').includes('asc_user_main'));

  // A user name that ALREADY ends in `__` must not alias onto the renamed spelling
  // of its reserved twin (`time` -> `time__`), or two AS3 functions would share one
  // C symbol.
  check('a literal trailing-`__` name does not alias the renamed twin', (() => {
    const c = gen("function time(x:int):int { return x; }\n"
      + "function time__(x:int):int { return x + 1; }\ntrace(time(1) + time__(2));");
    return c.includes('static int time__(int x);') && c.includes('static int time____(int x);');
  })());

  // Class names are file-scope typedefs too: a package-less `class close` would be
  // `typedef struct close close;`, colliding with close(2).
  check('a class named after a C function is renamed (`close`)',
    gen("class close { public var v:int = 1; }\nvar c:close = new close();\ntrace(c.v);")
      .includes('typedef struct close__ close__;'));

  // --- the two tables must stay SEPARATE --------------------------------------
  // Locals/fields keep the `_` prefix against the narrow seed table. That is not an
  // oversight: the built-in classes are emitted with hand-written bodies that spell
  // their own fields literally (`o->socket`, `o->_time`), so widening the BLOCK-scope
  // table disconnects those structs from their own bodies -- measured as
  // `error: no member named 'socket' in 'struct ServerSocketConnectEvent'` the moment
  // the header sweep was unioned into it. See C_RESERVED_SCOPE.
  check('the block-scope table stays narrow (no header-sweep names)',
    !C_RESERVED_SCOPE.has('socket') && !C_RESERVED_SCOPE.has('bind')
    && !C_RESERVED_SCOPE.has('listen') && !C_RESERVED_SCOPE.has('min'));
  check('the file-scope table is the union (header sweep included)',
    C_RESERVED.has('socket') && C_RESERVED.has('bind') && C_RESERVED.has('printf')
    && C_RESERVED.has('stat'));
  check('fields keep the `_` prefix spelling the builtin bodies hardcode',
    sanitizeCIdent('stat') === '_stat' && sanitizeCIdent('time') === '_time');
  check('file-scope names take the `__` suffix spelling',
    sanitizeFileCIdent('stat') === 'stat__' && sanitizeFileCIdent('time') === 'time__');
  // The generator drops everything C reserves to the implementation; keeping that
  // invariant here means a future generator edit cannot quietly add `__va_start`
  // (or an `_[A-Z]` name) and change nothing observable. It applies to the
  // GENERATED half only: the hand-written seed deliberately carries `__restrict`,
  // a spelling clang accepts as a keyword alias.
  check('the generated table holds no implementation-reserved names',
    ![...C_RESERVED_HEADERS].some((n) => n.startsWith('__') || /^_[A-Z]/.test(n)));
  check('the generated table is non-trivial', C_RESERVED_HEADERS.size > 5000);

  console.log(`     [cname] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/CNameCollision', checkEmitCNameCollision);

// 阶段二百四十八 (G9): `Boolean(x)` on a slot STATICALLY declared `Object`.
// We BOX scalars into Object slots (as_number_new/as_string_new/as_boolean_new), so
// the holder of false/0/NaN/"" is a non-NULL object and the old `isRefType` branch
// (a bare pointer test) answered TRUE. AIR keeps the primitive in the slot and
// applies ITS ToBoolean -- measured, all seven cells false on adl 51.4.1
// (asaotui/probes/g9-adl). The emitted SPELLING is pinned here because the
// behaviour is covered by examples/object-truthy.as: what must not silently change
// is WHICH types take the unboxing path (only the Object ROOT -- a concrete subclass
// can never hold a boxed scalar, so it keeps the pointer test).
function checkEmitObjectTruthy(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [objtruthy] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [objtruthy] ${label}`); }
  };
  const gen = (src: string) => generateC(parse(src)).c;
  const body = (c: string, sig: RegExp): string => {
    const m = c.match(sig);
    if (m === null) return '';
    return c.slice(m.index!, (c.indexOf('\r\n}', m.index!) >= 0 ? c.indexOf('\r\n}', m.index!) : c.length));
  };

  // --- the Object ROOT unboxes first (the G9 fix) ------------------------------
  const objParam = gen('function t(o:Object):Boolean { return Boolean(o); }\ntrace(t(null));');
  const objBody = body(objParam, /static bool t\(Object\* _o\) \{/);
  check('Boolean(<Object param>) unboxes before ToBoolean',
    objBody.includes('return as_v_truthy(as_obj_to_value((void*)(_o)));'));
  check('Boolean(<Object param>) is NOT a pointer test',
    objBody !== '' && !/_o != NULL/.test(objBody));

  const objField = gen('class Holder { public var o:Object; public function f():Boolean { return Boolean(o); } }\ntrace(new Holder());');
  check('an Object FIELD takes the same path',
    body(objField, /static bool Holder_f\(void\* _this\) \{/)
      .includes('return as_v_truthy(as_obj_to_value((void*)(this->_o)));'));

  // --- everything else keeps its old, AIR-matching spelling ---------------------
  const plain = gen('class Plain { public var v:int = 1; }\n'
    + 'function t(p:Plain):Boolean { return Boolean(p); }\ntrace(t(null));');
  check('a CONCRETE subclass keeps the pointer test',
    body(plain, /static bool t\(Plain\* p\) \{/).includes('return (p != NULL);'));
  check('an Array keeps the pointer test',
    body(gen('function t(a:Array):Boolean { return Boolean(a); }\ntrace(t(null));'),
      /static bool t\(as_array\* a\) \{/).includes('return (a != NULL);'));
  check('a `*` operand still goes through as_v_truthy',
    body(gen('function t(d:*):Boolean { return Boolean(d); }\ntrace(t(1));'),
      /static bool t\(as_value d\) \{/).includes('return as_v_truthy(d);'));
  check('a static String keeps the empty-string test',
    body(gen('function t(s:String):Boolean { return Boolean(s); }\ntrace(t(""));'),
      /static bool t\(char\* s\) \{/).includes('return (s != NULL && strlen(s) > 0);'));
  check('a bool operand is still the value itself',
    body(gen('function t(b:Boolean):Boolean { return Boolean(b); }\ntrace(t(true));'),
      /static bool t\(bool b\) \{/).includes('return b;'));

  // --- condExpr already agreed; the fix must not diverge from it --------------
  const cond = gen('function t(o:Object):void { if (o) trace(1); }\ntrace(1);');
  check('`if (o)` and `Boolean(o)` share the same helper',
    cond.includes('if (as_v_truthy(as_obj_to_value((void*)(_o)))) {'));

  console.log(`     [objtruthy] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ObjectTruthy', checkEmitObjectTruthy);

// ---- 阶段二百五十五：flash.desktop 图标族 + flash.display.NativeMenu --------
// Every assertion below is a MEASURED adl 51.4.1 answer (raw probe output in
// temp/deskprobe2/probe*.txt and probe7.txt). The end-to-end half -- that a click
// in the macOS menu bar really fires Event.SELECT -- is driven through AX by
// `example: native-menu.as` plus the G4App bundle run, not here.
function checkEmitNativeMenu(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [menu] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [menu] ${label}`); }
  };
  const gen = (src: string) => generateC(parse(src)).c;
  const c = gen([
    'import flash.display.NativeMenu;',
    'import flash.display.NativeMenuItem;',
    'import flash.desktop.NativeApplication;',
    'import flash.desktop.DockIcon;',
    'var m:NativeMenu = new NativeMenu();',
    'm.addItem(new NativeMenuItem("A"));',
    'NativeApplication.nativeApplication.menu = m;',
  ].join('\n'));

  // ---- the classes actually exist (a phantom declaration would compile a call
  // but leave the method table empty) ------------------------------------------
  for (const cls of ['NativeMenu', 'NativeMenuItem', 'Icon', 'InteractiveIcon', 'DockIcon', 'SystemTrayIcon']) {
    check(`${cls} is emitted`, c.includes(`${cls}_new(`) || c.includes(`flash.desktop::${cls}`) || c.includes(`flash.display::${cls}`));
  }
  check('the menu method table is populated',
    c.includes('"addSubmenuAt"') && c.includes('"setItemIndex"') && c.includes('"getItemByName"'));

  // ---- measured throwing constructors ---------------------------------------
  for (const cls of ['InteractiveIcon', 'DockIcon', 'SystemTrayIcon']) {
    check(`new ${cls}() throws #2012 with AIR's wording`,
      c.includes(`Error #2012: ${cls}$ class cannot be instantiated.`));
  }
  check('new Icon() is allowed (no #2012 for Icon)', !c.includes('Error #2012: Icon$ class cannot be instantiated.'));

  // ---- measured argument / range errors -------------------------------------
  check('addItem(null) is #2007 item',
    c.includes('Error #2007: Parameter item must be non-null.'));
  check('getItemByName(null) is #2007 name',
    c.includes('Error #2007: Parameter name must be non-null.'));
  check('bitmaps = null is #2007 bitmaps',
    c.includes('Error #2007: Parameter bitmaps must be non-null.'));
  check('bounce(null) is #2007 value',
    c.includes('Error #2007: Parameter value must be non-null.'));
  check('a bad bitmaps entry is #2005 naming BitmapData',
    c.includes('is of the incorrect type. Should be type BitmapData.'));
  check('duplicate addItemAt is #2004',
    c.includes('if (as_menu_index(m, item) >= 0) { as_throw(ArgumentError_new((char*)"Error #2004: One of the parameters is invalid.", 2004)); return NULL; }'));
  check('a duplicate addItem is a silent no-op',
    c.includes('if (as_menu_index(m, item) >= 0) return item;  // measured: silent no-op'));
  check('an out-of-range index is RangeError #2006',
    c.includes('RangeError_new((char*)"Error #2006: The supplied index is out of bounds.", 2006)'));

  // ---- measured copy semantics ----------------------------------------------
  check('items returns a fresh Array on every read',
    /NativeMenu_get_items\(void\* _this\) \{\n {2}NativeMenu\* m = [\s\S]{0,120}as_array_new\(\);  \/\/ measured: a fresh Array on every read/.test(c));
  check('getItemByName matches name, never the label',
    c.includes('// measured: matches NativeMenuItem.name only -- NOT the label'));
  check('clone does not carry data over',
    c.includes('// measured: clone() does NOT carry the data field over'));
  check('the modifier setter keeps only 15..20',
    c.includes('n < 15 || n > 20) continue;  // measured: 0..14 and >=21 are dropped'));
  check('the modifier getter answers a copy',
    /NativeMenuItem_get_keyEquivalentModifiers\([\s\S]{0,400}?as_array_new\(\)/.test(c));

  // ---- submenu parenting, measured with probe7 ------------------------------
  check('addItem re-parents an existing submenu',
    c.includes('adding an item that already carries a\n  // submenu re-parents that submenu to the menu it just joined.'));
  check('removeItem detaches the submenu',
    c.includes("// measured: a removed item's submenu loses its parent along with it."));

  // ---- the flattened description handed to the glue -------------------------
  // A menu's own items must be contiguous in the flat array: recursing inside the
  // parent's loop made a second top-level menu vanish from the real menu bar.
  const fill = /static int as_menu_fill\(NativeMenu\* m, as_menu_ctx\* c, int depth\) \{([\s\S]*?)\n\}/.exec(c);
  check('as_menu_fill lays a menu out in one contiguous run',
    fill != null && fill[1].indexOf('Pass 1:') >= 0 && fill[1].indexOf('Pass 2:') >= 0
    && fill[1].indexOf('Pass 2:') > fill[1].lastIndexOf('c->menus[idx].count++'));
  check('the click tag is 1-based into the tag table',
    c.includes('c->items[k].tag = c->tag_base + k + 1;'));
  // The menu-level dispatch goes through as_menu_select_on so that the MENU is the
  // currentTarget while the ITEM stays the target (measured on adl 51.4.1: the
  // handler sees cur=menu, tgt=item). A plain dispatchEvent on the menu would make
  // the menu its own target.
  check('a click dispatches select on the item AND its menu',
    c.includes('EventDispatcher_dispatchEvent((EventDispatcher*)it, (Event*)Event_new((char*)"select", false, false));')
    && c.includes('if (it->_menu != NULL) as_menu_select_on((void*)it->_menu, it);')
    && /static void as_menu_select_on\(void\* disp, NativeMenuItem\* item\) \{[\s\S]{0,300}?e->target = \(Object\*\)item;/.test(c));

  // ---- capability flags answer for the backend ------------------------------
  const pre = RUNTIME_PREAMBLE;
  // The Dock IMAGE capability now shares this block (阶段二百五十五 follow-up), so the
  // check asserts the block's SHAPE rather than a verbatim three-line run: the
  // Apple arm must turn DOCK / APP_MENU / DOCK_IMAGE on and the else arm off.
  const dockBlock = /#if defined\(ASC_USE_WINDOW\) && defined\(__APPLE__\)([\s\S]*?)#else([\s\S]*?)#endif/.exec(pre);
  check('the Dock and the app menu are Cocoa-only',
    dockBlock != null
    && /#define ASC_HAS_DOCK 1/.test(dockBlock[1])
    && /#define ASC_HAS_APP_MENU 1/.test(dockBlock[1])
    && /#define ASC_HAS_DOCK 0/.test(dockBlock[2])
    && /#define ASC_HAS_APP_MENU 0/.test(dockBlock[2]));
  check('the Dock IMAGE capability follows the same backend test',
    dockBlock != null
    && /#define ASC_HAS_DOCK_IMAGE 1/.test(dockBlock[1])
    && /#define ASC_HAS_DOCK_IMAGE 0/.test(dockBlock[2]));
  check('tray / login item / default app are never advertised',
    pre.includes('#define ASC_HAS_TRAY 0')
    && pre.includes('#define ASC_HAS_LOGIN_ITEM 0')
    && pre.includes('#define ASC_HAS_DEFAULT_APP 0'));
  check('the four capability getters read those macros',
    ['ASC_HAS_DOCK', 'ASC_HAS_TRAY', 'ASC_HAS_APP_MENU', 'ASC_HAS_LOGIN_ITEM', 'ASC_HAS_DEFAULT_APP']
      .every((m) => c.includes(`${m} ? true : false`) || c.includes(`${m} != 0`)));

  // ---- NativeApplication.menu / autoExit ------------------------------------
  check('na.menu is never null (AIR never answers null)',
    c.includes('if (ASC_app_menu == NULL) { ASC_app_menu = NativeMenu_new();'));
  check('na.menu = null is a reported no-op, not a crash',
    c.includes('flash.desktop.NativeApplication.menu = null (adl crashes on this; the menu is left unchanged)'));
  check('autoExit reaches the shared run loop',
    c.includes('sk_window_set_auto_exit(value ? 1 : 0);'));
  // 阶段二百八十九: the modal backend EXISTS now (Cocoa runs a nested tracking
  // loop inside popUpMenuPositioningItem:), so display() must pop up rather than
  // report, and the old "unsupported" string must be gone.
  check('display() pops a real menu instead of reporting a missing backend',
    !c.includes('cannot run a modal native menu')
    && /void NativeMenu_display\(void\* _this, Stage\* stage, double x, double y\) \{[\s\S]{0,600}?as_menu_popup_stage\(/.test(c));
  check('startAtLogin throws #2014 like adl',
    c.includes('as_throw(IllegalOperationError_new') && c.includes('2014'));
  // keyEquivalentModifiers is MAPPED now, not reported away. The table in the
  // generated C is the measured one (temp/keyeqprobe: real keys at a real adl menu
  // bar + a screen grab of the open dropdown), and it must stay separate from the
  // bit the backends treat as "unreachable shortcut".
  check('keyEquivalentModifiers is translated into portable bits',
    c.includes('static int as_menu_mods(NativeMenuItem* it)')
    && c.includes('c->items[k].mods = as_menu_mods(it);'));
  check('the measured modifier table is in the generated C',
    c.includes('#define AS_KEM_CMD   1')
    && c.includes('else if (d == 18.0) m |= AS_KEM_OPT;')
    && c.includes('else if (d == 20.0) m |= AS_KEM_DEAD;'));
  check('an unmapped modifier set is no longer reported as unsupported',
    !c.includes('does not apply the modifier flags yet'));

  console.log(`     [menu] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/NativeMenu', checkEmitNativeMenu);

// ---- 阶段二百五十六：DockIcon.bitmaps 上屏 ----------------------------------
// Two things are pinned here that no example can see: (1) the bitmap AIR actually
// paints, which was derived from screen-grab probes (temp/dockprobe) and is a pure
// selection rule inside the generated C, and (2) the conversion the Cocoa glue has
// to do, which failed visibly the first time it was left out (straight-alpha bytes
// reaching NSBitmapImageRep paint a transparent pixel's colour as a black bar).
function checkEmitDockIconImage(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dockimg] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dockimg] ${label}`); }
  };
  const c = generateC(parse([
    'import flash.display.BitmapData;',
    'import flash.desktop.NativeApplication;',
    'var b:BitmapData = new BitmapData(128, 128, true, 0xFFFF0000);',
    'NativeApplication.nativeApplication.icon.bitmaps = [b];',
  ].join('\n'))).c;
  const sync = fnBody(c, 'static void as_dock_icon_sync(Icon* o) {');
  check('the sync helper is emitted', sync !== '');
  // The three probes that fix the rule: {16,512}->16, {64,160}->160, {127,129}->127
  // are "closest to 128"; {129,127}->129 is "first wins" on a tie; 128x400 loses to
  // 200x200 is "per-axis maximum", not width.
  check('the pick metric is the per-axis MAXIMUM',
    sync.includes('int m = b->width > b->height ? b->width : b->height;'));
  check('...measured against 128', sync.includes('int d = m > 128 ? m - 128 : 128 - m;'));
  check('...with a tie going to the earlier entry (strict improvement)',
    sync.includes('if (best == NULL || d < bestd) { best = b; bestd = d; }'));
  check('the selected bitmap is what gets painted',
    sync.includes('sk_dock_set_icon_image(best->pixels, best->width, best->height);'));
  // measured: bitmaps = [] puts the default Dock icon back instead of leaving the
  // last painted image on screen.
  check('an empty list CLEARS the icon', sync.includes('sk_dock_set_icon_image(NULL, 0, 0);'));
  check('a bare Icon holding non-BitmapData elements cannot be painted',
    sync.includes('!as_is(e.ptr, &BitmapData_vt)'));
  // The predicate is a compile-time capability, so a backend without a Dock still
  // reports the gap once instead of silently doing nothing.
  check('painting is gated on ASC_HAS_DOCK_IMAGE', c.includes('#if ASC_HAS_DOCK_IMAGE'));
  check('the non-Cocoa arm still reports the missing capability once',
    sync.includes('the Dock icon image is not painted by this backend yet')
    && c.includes('as_shell_unsupported'));
  check('the report latch only exists in the arm that reports',
    c.includes('#if !ASC_HAS_DOCK_IMAGE') && c.includes('static bool ASC_dock_image_reported = false;'));

  // ---- the Cocoa half (vendor/window_glue.cc) ----
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  check('the glue premultiplies instead of handing AppKit straight alpha',
    glue.includes('r = (r * a + 127u) / 255u;'));
  check('...into an RGBA NSBitmapImageRep at its OWN bytesPerRow',
    glue.includes('long rb = (long)sk_send_int(rep, "bytesPerRow");'));
  check('...and installs it as the application icon (nil restores the bundle icon)',
    glue.includes('sk_send_void_obj(app, "setApplicationIconImage:", g_dock_image);'));
  // An icon set before NSApp exists must be retried, not dropped: measured, AS3
  // code that assigns bitmaps at startup does so before the window opens.
  check('an early assignment is retried from the event loop',
    glue.includes('static void sk_dock_image_flush(void) {')
    && /static void sk_menu_ensure\(void\)([\s\S]*?)sk_dock_image_flush\(\);/.test(glue));
  check('the non-Cocoa window backend defines the seam so a flipped macro still links',
    /void sk_dock_set_icon_image\(const void\* argb, int w, int h\) \{ \(void\)argb; \(void\)w; \(void\)h; \}/.test(glue));
  const web = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8');
  check('the wasm backend stubs it too (else wasm-ld: undefined symbol)',
    /void sk_dock_set_icon_image\(const void\* argb, int w, int h\) \{ \(void\)argb; \(void\)w; \(void\)h; \}/.test(web));

  console.log(`     [dockimg] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/DockIconImage', checkEmitDockIconImage);

// ---- 阶段二百五十八：flash.events.ScreenMouseEvent --------------------------
// The class is a pure data carrier on this backend (AIR dispatches it only from
// SystemTrayIcon, which macOS does not have), so everything below was measured on
// adl 51.4.1 with temp/smeprobe/ and is otherwise invisible to the examples suite:
// the ctor ORDER (buttonDown sits between shiftKey and commandKey, and localX/
// localY are not parameters), the read-only accessor pair, and the two toString/
// clone shapes that differ from Event's own.
function checkEmitScreenMouseEvent(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sme] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sme] ${label}`); }
  };
  const src = [
    'import flash.events.ScreenMouseEvent;',
    'var e:ScreenMouseEvent = new ScreenMouseEvent("t", true, true, 11, 22, true, false, true, true, false, true);',
    'trace(e.screenX, e.screenY, e.commandKey, e.controlKey);',
    'var c:ScreenMouseEvent = e.clone() as ScreenMouseEvent;',
    'trace(c);',
  ].join('\n');
  const c = generateC(parse(src)).c;
  // Constructor: 11 parameters, in AIR's own order.
  check('the ctor takes AIR\'s 11 parameters',
    c.includes('void ScreenMouseEvent_ctor(ScreenMouseEvent* o, char* type, bool bubbles, bool cancelable, double screenX, double screenY, bool ctrlKey, bool altKey, bool shiftKey, bool buttonDown, bool commandKey, bool controlKey)'));
  check('buttonDown comes BEFORE commandKey/controlKey (AIR order, not MouseEvent order)',
    /bool shiftKey, bool buttonDown, bool commandKey, bool controlKey\) \{/.test(c));
  // localX/localY are not ctor params: they are handed to the MouseEvent base as
  // 0, not NaN (measured: a plain MouseEvent leaves localX NaN).
  check('localX/localY start at 0, not NaN',
    c.includes('MouseEvent_ctor((MouseEvent*)o, type, bubbles, cancelable, 0.0, 0.0, NULL, ctrlKey, altKey, shiftKey, buttonDown, 0.0);'));
  // Read-only screenX/screenY: getter-only accessors over C-runtime-only slots.
  check('screenX/screenY are getter-only accessors',
    c.includes('double ScreenMouseEvent_get_screenX(void* _this)') && !c.includes('void ScreenMouseEvent_set_screenX('));
  check('...backed by C-runtime-only slots',
    /struct ScreenMouseEvent \{[\s\S]*?double _screen_x;[\s\S]*?double _screen_y;/.test(c));
  check('...which the props table never exposes as fields',
    !(/static as_prop ScreenMouseEvent_props\[\] = \{([^}]*)\}/.exec(c)?.[1] ?? 'screenX').includes('screenX')
    && /static as_method ScreenMouseEvent_getters\[\] = \{[^}]*"screenX"/.test(c));
  // The vtable override must go through the slots, not a static call: measured,
  // `String(e)` and `e.clone()` on a ScreenMouseEvent hit these bodies.
  check('toString is the ScreenMouseEvent body in its own vtable',
    /ScreenMouseEvent_vt = \{[^}]*ScreenMouseEvent_toString/.test(c));
  check('clone shadows Event\'s slot (same position as in Event_vt)',
    /ScreenMouseEvent_vt = \{[^}]*Object_propertyIsEnumerable, ScreenMouseEvent_clone,/.test(c)
    && /Event_vt = \{[^}]*Object_propertyIsEnumerable, Event_clone,/.test(c));
  // clone(): ctor-level state only (measured: localX/delta reset, screenX survives).
  check('clone copies the screen coordinates and the two extra flags',
    c.includes('ScreenMouseEvent_new(e->type, e->bubbles, e->cancelable, e->_screen_x, e->_screen_y, e->ctrlKey, e->altKey, e->shiftKey, e->buttonDown, e->commandKey, e->controlKey)')
    && c.includes('c->target = e->target;'));
  // toString(): AIR's own shape -- no eventPhase, unlike Event_toString.
  check('toString has AIR\'s ScreenMouseEvent shape', c.includes('"[ScreenMouseEvent type='));
  check('...and carries no eventPhase',
    fnBody(c, 'char* ScreenMouseEvent_toString(void* _this) {').includes('eventPhase') === false);
  // The six constants, measured by reading them at runtime on adl (values the
  // describeType dump cannot show: it lists only the names).
  for (const [name, value] of [['CLICK', 'click'], ['RIGHT_CLICK', 'rightClick'], ['MOUSE_DOWN', 'mouseDown'], ['MOUSE_UP', 'mouseUp'], ['RIGHT_MOUSE_DOWN', 'rightMouseDown'], ['RIGHT_MOUSE_UP', 'rightMouseUp']] as [string, string][]) {
    check(`${name} is "${value}"`,
      c.includes(`static char* const ScreenMouseEvent_${name} = "${value}";`));
  }
  // Reading a read-only trait through a dynamic write is #1074, not the sealed
  // #1056 -- a general runtime rule measured in the same probe batch.
  check('a dynamic write to a getter-only trait raises #1074',
    c.includes('static void as_throw_readonly_set(const char* key, const char* fqn) {')
    && c.includes('Error #1074: Illegal write to read-only property '));
  check('...and a write to a method raises #1037',
    c.includes('static void as_throw_method_assign(const char* key, const char* fqn) {')
    && c.includes('Error #1037: Cannot assign to a method '));
  check('both name the RECEIVER class and sit before the _dyn fallback',
    /for \(as_vtable_header\* t = hv; t != NULL; t = \(as_vtable_header\*\)t->super\) \{\s*as_method\* gs = \(as_method\*\)t->getters;/.test(c));
  // The static-type write is rejected at compile time (mxmlc: "property is read-only"),
  // instead of surfacing as a C "expression is not assignable".
  let threw = '';
  try { generateC(parse('import flash.events.ScreenMouseEvent;\nvar e:ScreenMouseEvent = new ScreenMouseEvent("x");\ne.screenX = 1;\n')); }
  catch (err) { threw = (err as Error).message; }
  check('a static write to screenX is a codegen error', /cannot assign to read-only property 'screenX' of 'ScreenMouseEvent'/.test(threw));

  console.log(`     [sme] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/ScreenMouseEvent', checkEmitScreenMouseEvent);

// ---- 阶段二百六十：SystemTrayIcon 背后的真 NSStatusItem（--features tray）------
// This channel is an ENHANCEMENT, and the compiler's hardest promise here is the
// DEFAULT: without `--features tray` the artifact must still be AIR-isomorphic --
// measured on adl 51.4.1 / macOS, `NativeApplication.supportsSystemTrayIcon` is
// false and `new SystemTrayIcon()` throws #2012, so nothing may appear in the menu
// bar. Everything below pins one of the two arms, plus the three things the live
// probe (temp/trayprobe, real clicks + AX on the running app) taught us and no
// example can see: the click POSITION rules, the action-vs-setMenu: ordering, and
// the GC roots the Cocoa side points into.
function checkEmitSystemTrayIcon(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [tray] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [tray] ${label}`); }
  };
  const src = [
    'import flash.display.BitmapData;',
    'import flash.display.NativeMenu;',
    'import flash.display.NativeMenuItem;',
    'import flash.desktop.NativeApplication;',
    'import flash.desktop.SystemTrayIcon;',
    'import flash.events.MouseEvent;',
    'import flash.utils.getQualifiedSuperclassName;',
    'var b:BitmapData = new BitmapData(22, 22, true, 0xFFFF8800);',
    'var t:SystemTrayIcon = new SystemTrayIcon();',
    't.tooltip = "Prune";',
    't.bitmaps = [b];',
    'var m:NativeMenu = new NativeMenu();',
    'm.addItem(new NativeMenuItem("Open"));',
    't.menu = m;',
    't.addEventListener(MouseEvent.RIGHT_CLICK, function(e:*):void { trace(e); });',
    'trace(getQualifiedSuperclassName(SystemTrayIcon));',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // ---- arm 1: the default build -------------------------------------------
  // The preamble decides the capability bit from the macro pair, so an ordinary
  // build cannot accidentally claim a tray it does not have.
  check('ASC_HAS_TRAY is derived from the macro, not assumed',
    c.includes('#if defined(ASC_USE_TRAY) && defined(ASC_USE_WINDOW) && defined(__APPLE__)'));
  check('the refusal AIR gives on macOS is the default arm',
    c.includes('Error #2012: SystemTrayIcon$ class cannot be instantiated.'));
  // as_tray_sync is emitted unconditionally (the vtable references it), but with the
  // switch off its body must be inert -- a stray sk_tray_* call there would be an
  // undefined symbol in every default app.
  const sync = fnBody(c, 'static void as_tray_sync(SystemTrayIcon* o) {');
  check('the sync helper exists', sync !== '');
  // Both arms are always present in the emitted text (the preprocessor decides), so
  // the pin is the ARM ORDER: the real work first, then the inert `(void)o;`. A file
  // that lost the switch would still read the same either way -- what must not
  // happen is the ON arm falling outside the guard.
  check('...with the inert arm being the #else of the real one',
    sync.indexOf('#if ASC_HAS_TRAY') >= 0
    && sync.indexOf('#if ASC_HAS_TRAY') < sync.indexOf('sk_tray_set_images(')
    && sync.indexOf('sk_tray_set_images(') < sync.indexOf('#else')
    && sync.slice(sync.indexOf('#else')).includes('(void)o;'));
  // A status item is 22pt on every display, but a display may be 1x or 2x: the
  // array hands over one rendering per density and the glue adds one NSImage
  // representation each. Emitting only `bitmaps[0]` (the old rule) makes AppKit
  // downscale the 2x art on a 1x panel, which at a 15pt glyph averages a 1.5pt
  // stroke into haze -- measured on a 2560x1440 secondary display.
  check('every bitmap is handed over as its own representation, up to 4',
    sync.includes('sk_tray_set_images(n > 0 ? argbs : NULL, n > 0 ? ws : NULL, n > 0 ? hs : NULL, n);')
    && sync.includes('const void* argbs[4];') && sync.includes('n < 4'));
  check('the click dispatcher lives inside the same guard',
    c.includes('#if ASC_HAS_TRAY\n// A click on the status item.'));

  // ---- arm 2: what the switch turns on ------------------------------------
  check('the switch constructs and registers the singleton',
    c.includes('ASC_tray_icon = o;') && c.includes('as_tray_sync(o);'));
  // The click is dispatched as ScreenMouseEvent, i.e. the ONE AIR class that models
  // "a mouse event on a system icon" -- invented from AIR's own constants, since
  // macOS has no behaviour to copy.
  check('a left click is MouseEvent.CLICK and a right click is RIGHT_CLICK',
    c.includes('char* type = (char*)(kind == 1 ? "rightClick" : "click");'));
  check('the event carries the SCREEN position and the live modifiers',
    c.includes('ScreenMouseEvent_new(type, false, false, sx, sy,'));
  check('the three right-button constants exist (AIR members, previously missing)',
    c.includes('"rightClick"') && c.includes('"rightMouseDown"') && c.includes('"rightMouseUp"'));

  // ---- the class model ----------------------------------------------------
  // Measured (temp/trayprobe/Sup.as): Icon's base is EventDispatcher. With the old
  // `Object` base an icon could not dispatch at all, which is exactly what the tray
  // click needs.
  check('Icon extends EventDispatcher (measured, not Object)',
    /Icon_vt = \{[^}]*&EventDispatcher_vt/.test(c) || c.includes('"flash.desktop::Icon", &EventDispatcher_vt'));
  check('Icon_ctor chains to EventDispatcher_ctor',
    c.includes('void Icon_ctor(Icon* o) { EventDispatcher_ctor((EventDispatcher*)o, NULL);'));
  check('SystemTrayIcon overrides bitmaps (the inherited setter only sizes)',
    c.includes('void SystemTrayIcon_set_bitmaps(void* _this, as_array* v) {')
    && c.includes('InteractiveIcon_set_bitmaps(_this, v);'));

  // ---- the menu: a third install target -----------------------------------
  check('the tray menu is built from the same tag table as app/Dock menus',
    c.includes('c.tag_base = appItems + dockItems;')
    && c.includes('sk_tray_set_menu(c.menus, c.nmenus, c.items, c.nitems, idx, as_menu_click_cb);'));
  check('tray.menu = null detaches instead of leaving a stale menu',
    c.includes('sk_tray_set_menu(NULL, 0, NULL, 0, 0, NULL);'));
  // A tag is an index into ASC_menu_tags + 1, and as_menu_sync rebuilds that array
  // from scratch -- so the tray's tags MUST start after the app's and the Dock's, or
  // a click on "Open" would fire a Dock item.
  check('the tag base is exclusive to the three install targets',
    c.includes('c.tag_base = 0;') && c.includes('c.tag_base = appItems;'));

  // ---- GC roots ------------------------------------------------------------
  // The Cocoa side holds raw pointers to these objects for the life of the process;
  // a collection between frames would leave the status item pointing at reclaimed
  // memory. The tag array and the DockIcon singleton were missing until this stage.
  const roots = fnBody(c, 'static void gc_mark_user_roots(void) {');
  for (const st of ['ASC_tray_icon', 'ASC_tray_menu', 'ASC_menu_tags', 'ASC_icon_singleton', 'ASC_app_menu', 'ASC_dock_menu']) {
    check(`${st} is a GC root`, roots.includes(`gc_mark_ptr((void*)${st});`));
  }
  // Unconditional declaration: the roots block above compiles with the switch off.
  check('the statics are declared with the channel off as well',
    c.includes('static SystemTrayIcon* ASC_tray_icon = NULL;')
    && c.includes('static NativeMenu* ASC_tray_menu = NULL;'));

  // ---- the Cocoa half (vendor/statusitem_glue.cc) --------------------------
  const glue = readFileSync(join(root, 'vendor', 'statusitem_glue.cc'), 'utf8');
  // Measured (temp/statusprobe/statusprobe2.mm): -[NSStatusItem setMenu:] makes
  // AppKit swallow the mouse-down for menu tracking, so the action never fires and
  // AS3 would never see a CLICK. Popping the menu from inside the action gives both.
  check('the menu is NOT installed with setMenu:',
    !glue.includes('"setMenu:"'));
  check('...it is popped from the action instead', glue.includes('"popUpStatusItemMenu:"'));
  check('right clicks reach the action too (sendActionOn mask)',
    glue.includes('sk_send_void_int(btn, "sendActionOn:", (long)((1 << 2) | (1 << 4)));'));
  // The event is dispatched BEFORE the menu opens: the popup runs a nested tracking
  // loop, so a dispatch after it would only happen once the user dismissed the menu.
  const fired = fnBody(glue, 'static void sk_tray_fired(void* self, SEL _cmd, void* sender) {');
  check('the AS3 event is dispatched before the menu pops',
    fired.indexOf('g_tray_cb(kind') >= 0 && fired.indexOf('g_tray_cb(kind') < fired.indexOf('popUpStatusItemMenu:'));
  // Position: the event's own point when there IS a mouse event, else the button's
  // centre. Measured: an accessibility press leaves currentEvent pointing at a stale
  // event and mouseLocation reporting the resting cursor -- both kilometres off.
  check('the click position comes from the event itself',
    fired.includes('sel_registerName("locationInWindow")') && fired.includes('"convertPointToScreen:"'));
  check('...with the button centre as the no-mouse-event fallback',
    fired.includes('"convertRectToScreen:"'));
  check('the y flip uses the PRIMARY display, not mainScreen (multi-display)',
    fired.includes('"screens"') && !fired.includes('"mainScreen"'));
  // Same single-premultiply rule as the Dock icon: straight ARGB in, premultiplied
  // RGBA out (AIR's own Dock icon double-multiplies; that divergence is registered,
  // not copied).
  check('the bitmap is premultiplied exactly once',
    glue.includes('r = (r * a + 127u) / 255u;') && (glue.match(/r = \(r \* a \+ 127u\) \/ 255u;/g) ?? []).length === 1);
  // One status item per process: a second SystemTrayIcon reuses the same bar slot
  // (sk_tray_create early-returns), so the LAST constructed icon owns it. No AIR
  // behaviour exists to copy here -- it is stated in docs/zh-cn/enhancements.md.
  check('creation is once-per-process', /if \(g_tray_created \|\| NSApp == NULL\) return;/.test(glue));
  check('an install before NSApp exists is retried, not dropped',
    glue.includes('"NSApplicationDidFinishLaunchingNotification"') && glue.includes('static void sk_tray_flush(void) {'));
  // keyEquivalentModifiers reaches AppKit as a real mask now. The four single
  // modifiers were identified by pressing synthesized keys at a real adl menu bar
  // and reading the open dropdown's glyph column (temp/keyeqprobe): 15 Cmd,
  // 16 Shift, 17 Control, 18 Option, 19 none, 20 "shows S but never fires".
  check('the tray menu applies the modifier mask',
    glue.includes('sk_menu_apply_mods(item, items[k].mods);')
    && glue.includes('"setKeyEquivalentModifierMask:"'));
  check('the tray mask maps the four measured modifiers and keeps 20 unreachable',
    glue.includes('#define SK_MOD_CMD     (1UL << 20)')
    && glue.includes('#define SK_MOD_OPT     (1UL << 19)')
    && glue.includes('if (mask == 0 && (mods & 16)) mask |= SK_MOD_FN;'));
  const winGlue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  check('the app/Dock menus use the same measured table',
    winGlue.includes('sk_menu_apply_mods(item, items[k].mods);')
    && winGlue.includes('#define SK_MOD_CTRL    (1UL << 18)')
    && !winGlue.includes('not mapped to NSEventModifierFlags yet'));

  check('the non-Cocoa build still defines all four seams',
    /void sk_tray_set_images\(const void\* const\* argbs, const int\* ws, const int\* hs, int n\) \{ \(void\)argbs; \(void\)ws; \(void\)hs; \(void\)n; \}/.test(glue)
    && glue.includes('void sk_tray_set_tooltip(const char* text) { (void)text; }'));
  // The multi-representation rule itself: one NSImage, a representation per bitmap,
  // and the point size fixed by the MENU BAR rather than by whichever bitmap came
  // first. `setTemplate:` last, so both appearances of the bar are covered.
  check('the image is one NSImage with a rep per bitmap and a template flag',
    glue.includes('static void* sk_tray_nsimage(void) {')
    && (glue.match(/addRepresentation:/g) ?? []).length === 1
    && glue.includes('sk_send_void_bool(img, "setTemplate:", 1);')
    && glue.includes('double ptH = 22.0;'));
  // Every rep must DECLARE its point size: that is the only thing that tells AppKit
  // a bitmap's scale (pixels / points). Without it both reps claim "1px == 1pt", the
  // 2x bitmap is taken for an image twice too large and resampled down, the 1x bitmap
  // is never selected as the 1x variant, and the item arrives blurred on BOTH
  // displays. Measured on a 2x main + 1x secondary pair; the 1x bar was mush.
  check('every tray rep declares the point size that fixes its scale',
    /static void\* sk_tray_nsrep\(const unsigned\* argb, int w, int h, double ptW, double ptH\)/.test(glue)
    && glue.includes('sel_registerName("setSize:"), (sk_nssize){ptW, ptH});')
    && /sk_tray_nsrep\(g_tray_rep_px\[i\], g_tray_rep_w\[i\], g_tray_rep_h\[i\], ptW, ptH\)/.test(glue)
    && glue.includes('typedef struct { double w, h; } sk_nssize;'));

  console.log(`     [tray] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: emit/SystemTrayIcon', checkEmitSystemTrayIcon);
