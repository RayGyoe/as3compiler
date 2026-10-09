// Unit checks: `&&`/`||` operand pass-through and String truthiness — the two
// emit-time defects behind the examples/air-native TweenDemo crash
// (`#1034: cannot convert false to Array`, stage 一百二十四).
//
// These are SOURCE-LEVEL pins on the generated C, deliberately not behavioural:
// the behavioural half lives in examples/logical-value.as and
// examples/string-truthy.as (run by test/examples.ts). Pinning the emitted shape
// here catches a regression even when an example's particular operand shapes
// would no longer exercise it — and it is the only layer that can assert the
// ABSENCE of the buggy `as_v_req_*` unbox, which is what actually threw.
//
// Run alone: node --test --test-name-pattern='logical/' test/unit/*.ts
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup } from '../harness.ts';

// Only the translation unit's `main` is inspected: RUNTIME_PREAMBLE mentions
// as_v_truthy / as_v_req_* by design, so a whole-file search would always match.
function mainOf(src: string): string {
  const c = generateC(parse(src)).c;
  const i = c.indexOf('int main(');
  return i < 0 ? c : c.slice(i);
}

function makeCheck(tag: string) {
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { console.log(`PASS  [${tag}] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [${tag}] ${label}`); }
  };
  return { bad, check };
}

// The TweenLite.as:399 guard, verbatim: `_overwrite > 1 && this.cachedPT1 &&
// siblings && siblings.length > 1`. `cachedPT1:Object` gives the chain an `any`
// link, so the two right-hand `&&`s join `any` with a concrete type (Array, bool)
// — exactly the pairs that used to be declared "compatible".
const TWEEN_CHAIN =
  'var ow:uint = 0;\nvar c:Object = null;\nvar s:Array = ["a","b"];\n' +
  'var r:* = (ow > 1 && c && s && s.length > 1);\ntrace(r);\n';

export function checkLogicalOperandPassThrough(): string[] {
  const { bad, check } = makeCheck('logical');

  // ── The bug: an `any` operand must NOT be unified into the other side's
  // concrete type. Unification narrowed the result and the pass-through operand
  // was then unboxed with a runtime type check, which threw on a value that was
  // legitimately of another type.
  const tween = mainOf(TWEEN_CHAIN);
  check('a falsy `any` operand is not unboxed by a runtime type check',
    !/\bas_v_req_\w*/.test(tween));
  check('the logical chain temporaries stay boxed as_value (no concrete pointer decl)',
    /as_value _sc\d+ = \(as_v_truthy\(_sc\d+\) \? as_v_arr\(\(void\*\)\(g_s\)\) : _sc\d+\);/.test(tween));
  check('the `bool && Object` link also passes its operand through verbatim',
    /as_value _sc\d+ = \(_sc\d+ \? as_obj_to_value\(\(void\*\)\(g_c\)\) : as_v_bool\(_sc\d+\)\);/.test(tween));
  check('the chain tests boxed truthiness (as_v_truthy), not a raw pointer',
    tween.includes('as_v_truthy('));

  // ── The `||` mirror with the same shape (`uint || Array`).
  const orMirror = mainOf('var z:uint = 0;\nvar arr:Array = ["a"];\nvar r:* = (z || arr);\ntrace(r);\n');
  check('`||` with an any-side keeps BOTH branches boxed',
    orMirror.includes('(g_z ? as_v_num((double)(g_z)) : as_v_arr((void*)(g_arr)))'));
  check('`||` does not unbox either branch', !/\bas_v_req_\w*/.test(orMirror));

  // ── The concrete-type fast paths must SURVIVE the fix (they are why the
  // unification exists at all): same-kind and numeric pairs stay unboxed.
  const boolBool = mainOf('var a:Boolean = true;\nvar b:Boolean = false;\nvar r:* = (a && b);\ntrace(r);\n');
  check('`bool && bool` still lowers to C `&&` (no boxing)',
    boolBool.includes('(g_a && g_b)') && !boolBool.includes('as_v_truthy'));

  const intInt = mainOf('var i:int = 0;\nvar j:int = 1;\nvar r:* = (i && j);\ntrace(r);\n');
  check('`int && int` still lowers to a bare int ternary (no boxing)',
    intInt.includes('(g_i ? g_j : g_i)') && !intInt.includes('as_v_truthy'));

  const objOr = mainOf('var o:Object = null;\nvar p:Object = null;\nvar r:* = (o || p);\ntrace(r);\n');
  check('`Object || Object` still passes references through unboxed',
    objOr.includes('(g_o ? g_o : g_p)') && !objOr.includes('as_v_truthy'));

  return bad;
}

export function checkStringTruthiness(): string[] {
  const { bad, check } = makeCheck('logical');

  // ── The runtime helper exists and agrees with the boxed path (tag 3). The two
  // implementations must stay identical: "empty string is falsy".
  check('as_str_truthy tests NULL and the empty string',
    RUNTIME_PREAMBLE.includes('static bool as_str_truthy(const char* s) { return s != NULL && s[0] != 0; }'));
  check('the boxed as_v_truthy tag-3 case uses the same rule',
    RUNTIME_PREAMBLE.includes('case 3: return v.ptr != NULL && ((char*)v.ptr)[0] != 0;'));

  // ── Every condExpr call site must route a static String through the helper.
  const strIf = mainOf('var s:String = "";\nif (s) { trace("T"); } else { trace("F"); }\n');
  check('`if (string)` uses as_str_truthy',
    strIf.includes('if (as_str_truthy(g_s))'));

  const strNot = mainOf('var s:String = "";\nvar b:Boolean = !s;\ntrace(b);\n');
  check('`!string` uses as_str_truthy',
    strNot.includes('(!as_str_truthy(g_s))'));

  const strTernary = mainOf('var s:String = "";\nvar t:String = (s ? "T" : "F");\ntrace(t);\n');
  check('`string ? a : b` uses as_str_truthy',
    strTernary.includes('(as_str_truthy(g_s) ? "T" : "F")'));

  const whileStr = mainOf('var s:String = "";\nvar n:int = 0;\nwhile (s) { n++; }\ntrace(n);\n');
  check('`while (string)` uses as_str_truthy',
    whileStr.includes('while (as_str_truthy(g_s))'));

  const strAnd = mainOf('var s:String = "";\nvar t:* = (s && "x");\ntrace(t);\n');
  check('`string && x` uses as_str_truthy',
    strAnd.includes('(as_str_truthy(g_s) ? "x" : g_s)'));

  // ── The helper takes the value as an argument, so a call operand is emitted
  // exactly once. An inline `s != NULL && s[0] != 0` would duplicate it.
  const strCall = mainOf(
    'function f():String { return ""; }\nvar g:Boolean = false;\nif (f()) { g = true; }\ntrace(g);\n');
  check('a String-returning condition operand is evaluated exactly once',
    strCall.includes('if (as_str_truthy(f()))') && strCall.split('f()').length - 1 === 1);
  check('the condition does not inline strlen (which would double-mention the operand)',
    !strIf.includes('strlen(') && !whileStr.includes('strlen('));

  return bad;
}

registerGroup('unit: logical/OperandPassThrough', checkLogicalOperandPassThrough);
registerGroup('unit: logical/StringTruthy', checkStringTruthiness);