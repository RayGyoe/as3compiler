// Unit checks: the member surface of a boxed primitive (Number / Boolean / String /
// Function) reached through a DYNAMIC receiver.
//
// Two representations of the same value have to answer identically:
//   · a raw box tag in `as_value` (what a `*` or Array slot holds)  -> as_any_call
//   · a heap box behind as_number_vt / ... (what an Object slot holds) -> as_dyn_call
//
// They used to answer differently AND wrongly (a `*` number answered null for every
// method because the tag's ptr slot is not an object header; an Object-slot number
// threw #1069 because the boxed vtables carry no method table). Both doors now open
// onto the single as_prim_call, and these pins keep them there. Every expected value
// is measured on adl 51.4.1 (temp/dynnum/body.inc via mk.sh, byte-identical diff).
//
//   node --test --test-name-pattern='unit: prim/PrimMethods' test/unit/*.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root } from '../harness.ts';

function checkPrimMethods(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [prim] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [prim] ${label}`); }
  };
  const flatPre = RUNTIME_PREAMBLE.replace(/\s+/g, ' ');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');

  // ---- both doorways reach the same implementation ----
  const dyn = generateC(parse('var n:* = 1.5;\nvar s:String = n.toFixed(2);\ntrace(s);\n')).c.replace(/\r\n/g, '\n');
  check('as_any_call routes a boxed Number/Boolean/Function to as_prim_call',
    dyn.includes('if (v.tag == 1 || v.tag == 2 || v.tag == 7) return as_prim_call(v, name, args, argc);'));
  check('as_dyn_call routes a heap Boxed primitive to the same as_prim_call',
    dyn.includes('if (pk != 0) return as_prim_call(as_prim_box_value(pk, obj), name, args, argc);'));
  check('as_dyn_get answers a boxed String/Function own DATA trait before the props walk',
    /as_dyn_get\(void\* obj, const char\* key\)[\s\S]{0,2200}if \(as_prim_own_get\(obj, key, &pout\)\) return pout;/.test(dyn));
  check('as_dyn_has answers the same traits',
    /as_dyn_has\(void\* obj, const char\* key\)[\s\S]{0,1200}if \(as_prim_box_kind\(obj\) != 0\) return as_prim_own_has\(obj, key\);/.test(dyn));
  check('the box kinds are matched by vtable identity, not by a tag',
    flatPre.includes('if (vt == (void*)&as_number_vt) return 1;')
    && flatPre.includes('if (vt == (void*)&as_boolean_vt) return 2;')
    && flatPre.includes('if (vt == (void*)&as_string_vt) return 3;')
    && flatPre.includes('if (vt == (void*)&as_function_vt) return 4;'));

  // ---- Number's own traits through either receiver ----
  check('toFixed/toExponential/toPrecision/toString(radix) are all answered',
    flatPre.includes('if (strcmp(name, "toFixed") == 0)')
    && flatPre.includes('if (strcmp(name, "toExponential") == 0)')
    && flatPre.includes('if (strcmp(name, "toPrecision") == 0)')
    && flatPre.includes('return as_v_str(argc > 0 ? as_num_toString_radix(v.num, as_v_int_val(args[0]))'));
  check('valueOf answers the receiver itself, so "is Number" stays true',
    flatPre.includes('if (strcmp(name, "valueOf") == 0) return v;'));
  const typedPred = generateC(parse([
    'var t:Number = 1;', 'var i:int = 2;', 'var u:uint = 3;', 'var b:Boolean = true;',
    'trace(t.hasOwnProperty("x"), t.propertyIsEnumerable("x"), i.hasOwnProperty("x"),',
    '      u.propertyIsEnumerable("x"), b.hasOwnProperty("x"));',
  ].join('\n'))).c;
  check('a Number/int/uint/Boolean owns no property, so the typed predicates fold to false',
    (typedPred.match(/_once\d+ = false;/g) || []).length === 5);
  check('a boxed Function keeps `length` (declared arity) and owns `prototype`',
    flatPre.includes('if (pk == 4 && strcmp(key, "length") == 0)')
    && flatPre.includes('if (pk == 4) return strcmp(key, "length") == 0 || strcmp(key, "prototype") == 0;'));
  check('a boxed String keeps `length` and owns nothing else',
    flatPre.includes('if (pk == 3) return strcmp(key, "length") == 0;'));
  check('call drops the receiver, apply takes the Array',
    flatPre.includes('return as_fn_call_dyn(v, argc > 0 ? args + 1 : NULL, argc > 0 ? argc - 1 : 0, "call");')
    && flatPre.includes('if (strcmp(name, "apply") == 0) return as_fn_apply_v(v, argc > 1 ? args[1] : as_v_null());'));

  // ---- the typed fast paths agree with the runtime ----
  const typedNum = generateC(parse('var t:Number = 12.34;\nvar a:String = t.toString(16);\nvar b:String = t.toPrecision(3);\ntrace(a + b);\n')).c;
  check('a typed Number goes through as_num_toString_radix (radix 10 keeps the fraction)',
    typedNum.includes('as_num_toString_radix(g_t, 16)'));
  check('a typed toPrecision no longer collapses into the shortest round-trip text',
    typedNum.includes('as_num_toPrecision(g_t, 3)') && !typedNum.includes('args.length === 0) return { code: `as_str_from_double'));
  const typedInt = generateC(parse('var i:int = 12;\nvar s:String = i.toString(16);\ntrace(s);\n')).c;
  check('int/uint keep the integer radix path', typedInt.includes('as_int_radix((long long)(g_i), 16)'));

  // ---- the argument contract is RangeError, not a silent clamp ----
  // The guards live in the runtime preamble; the RangeError subclasses and their
  // messages are generated C (they need Error's own machinery).
  const dynFlat = dyn.replace(/\s+/g, ' ');
  check('toString(radix) outside 2..36 throws RangeError #1003',
    flatPre.includes('if (radix < 2 || radix > 36) as_throw_radix(radix);')
    && dynFlat.includes('Error #1003: The radix argument must be between 2 and 36; got '));
  check('the int/uint radix helpers no longer fall back to base 10',
    !flatPre.includes('if (radix < 2 || radix > 36) radix = 10;'));
  check('the digit-count contract throws RangeError #1002 instead of clamping',
    flatPre.includes('if (digits < 0 || digits > 20) as_throw_number_format_range();')
    && flatPre.includes('if (precision < 1 || precision > 21) as_throw_number_format_range();')
    && dynFlat.includes('Error #1002: Number.toPrecision has a range of 1 to 21.'));

  // ---- toPrecision keeps its digit count (the %g trailing-zero bug) ----
  check('toPrecision no longer goes through %g (which strips trailing zeros)',
    !flatPre.includes('snprintf(buf, 128, "%.*g", precision, v);')
    && flatPre.includes("snprintf(buf, sizeof buf, \"%.*e\", precision - 1, v);")
    && flatPre.includes('if (dec < 0) dec = 0;'));
  check('toPrecision follows AIR: fixed notation for every small magnitude',
    flatPre.includes('if (e >= precision) {') && !flatPre.includes('if (e < -6 || e >= precision)'));
  check('zero pads to the requested precision ("0.000" for 3)',
    flatPre.includes('for (int i = 0; i < precision; i++) buf[k++] = \'0\';'));
  check('a negative zero prints unsigned',
    flatPre.includes('static double as_clear_neg_zero(double v) { return v == 0.0 ? 0.0 : v; }'));

  // ---- integer radix conversion is exact at any magnitude ----
  check('the radix converter uses 2^32 limbs, not a 64-bit cast',
    flatPre.includes('limbs[nl++] = (uint32_t)(x - q * 4294967296.0);'));

  // ---- a typed Function value keeps its method surface ----
  const typedFn = generateC(parse('function f(a:int, b:int):int { return a; }\nvar g:Function = f;\nvar t:String = g.toString();\nvar h:Boolean = g.hasOwnProperty("length");\ntrace(t + h);\n')).c;
  check('a typed Function answers toString with the AIR constant',
    typedFn.includes('(char*)"function Function() {}"'));
  check('a typed Function owns length/prototype and nothing else',
    typedFn.includes('(strcmp(\"length\", \"length\") == 0 || strcmp(\"length\", \"prototype\") == 0)'));
  check('emitFunctionMethod exists as the typed Function surface',
    emitSource.includes('private emitFunctionMethod(') && emitSource.includes("if (obj.type.kind === 'function') {\n        return this.emitFunctionMethod("));

  // ---- an untyped slot starts as UNDEFINED ----
  const undef = generateC(parse('var u:*;\ntrace(u);\n')).c;
  check('an untyped local is initialised to the undefined tag, not null',
    undef.includes('= (as_value){5, 0.0, NULL};'));
  check('defaultInit spells undefined as a constant, so a static initialiser also works',
    emitSource.includes("return '(as_value){5, 0.0, NULL}';"));
  check('an untyped instance field is seeded to undefined in the constructor',
    emitSource.includes("if (!f.init && f.type.kind === 'any') this.line(`o->${this.cIdent(fname)} = as_v_undefined();`);"));

  // ---- a String method with no argument applies its documented default ----
  check('a missing String argument is an undefined stand-in, not NULL',
    dyn.includes('_undef_args[0] = as_v_undefined();') && dyn.includes('if (args == NULL) args = _undef_args;'));
  check('replace() without a replacement inserts the text "undefined"',
    dyn.includes(': "undefined", re->_global));') && dyn.includes('argc >= 2 ? as_v_str_val(args[1]) : "undefined"'));

  // ---- the example pins the measured values ----
  const ex = readFileSync(join(root, 'examples', 'dyn-prim-methods.as'), 'utf8');
  check('the example keeps its assertions wired to the valueOf dispatch',
    ex.includes('if (strcmp(name, "valueOf")') || ex.includes('dyn number valueOf'));
  check('the example fixes the measured contract values',
    ex.includes('"dyn number toFixed(2)"')
    && ex.includes('"3635c9adc5dea00000"')
    && ex.includes('"Object-slot number toFixed(2)"')
    && ex.includes('"an uninitialized * variable is undefined, not null"')
    && ex.includes('"an absent precision is RangeError #1002"'));

  console.log(`     [prim] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: prim/PrimMethods', checkPrimMethods);
