// Unit checks: a null LITERAL joined with a value in the conditional operator
// (阶段二百六十六 · G16).
//
// Why source-level pins here and behaviour in an example: the defect was TYPE
// INFERENCE, not a runtime path. `unifyType` fell through to "keep the then-branch
// type" whenever the null literal sat in the THEN slot, so the whole conditional was
// typed `null` and `convert` emitted it as a constant -- the arm that actually runs
// was dropped at COMPILE time. A behavioural example cannot show that the static type
// is right (a collapsed `NULL` also prints as null); only the emitted C can.
//
// The two things pinned here are the two halves of the fix:
//   1. ORDER -- the null-family rule must be reached BEFORE the `any` rule, or a `*`
//      on the other side wins and the result is typed `null` again (probe case 8).
//   2. SHAPE -- a pointer-shaped counterpart keeps its concrete type (null arm = NULL,
//      the live arm untouched); a numeric/boolean/`*` counterpart boxes to `any`
//      (`as_v_null()` on the null arm), because a double/bool has no null in C.
//
// The behavioural matrix lives in examples/ternary-null.as, whose 27 cells are
// byte-identical to adl 51.4.1 (temp/g16g19g20/ab-g16.cjs), and the 20-case matrix
// form the gap report lives in asaotui/probes/g16-ternary-null/.
//
//   node --test --test-name-pattern='ternary/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

// Call-site pins must look at the emitted MAIN BODY: the runtime preamble defines
// every helper unconditionally, so `c.includes('as_v_null()')` would be true even for
// a program that never mentions null.
function mainOf(src: string): string {
  const c = generateC(parse(src)).c;
  return c.slice(c.indexOf('int main('));
}

// One program per result family, all top-level so every expression lands in `main`.
function program(decls: string[]): string {
  return ['import flash.display.Bitmap;', 'var o:Object = new Object();', ...decls,
    'trace(o);', ''].join('\n');
}

function checkTernaryNull(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ternnull] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ternnull] ${label}`); }
  };

  // ---- the rule itself, in the compiler source ----
  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8').replace(/\r\n/g, '\n');
  const uniAt = emit.indexOf('private unifyType(a: CType, b: CType): CType {');
  const uniBody = uniAt >= 0 ? emit.slice(uniAt, uniAt + 3000) : '';
  const nullRuleAt = uniBody.indexOf("if (a.kind === 'null' || b.kind === 'null') {");
  const anyRuleAt = uniBody.indexOf("if (a.kind === 'any' || b.kind === 'any') {");
  check('unifyType has a null-literal rule', uniAt >= 0 && nullRuleAt > 0);
  check('it is reached BEFORE the `any` rule (otherwise `? null : <*>` types the whole ternary null)',
    nullRuleAt > 0 && anyRuleAt > nullRuleAt);
  check('a numeric/boolean/`*` counterpart boxes to `any`; a pointer counterpart keeps its type',
    uniBody.includes('return scalar ? { kind: \'any\' } : other;')
    && uniBody.includes("|| other.kind === 'any'"));
  check('the scalar set is exactly int/uint/int64/uint64/number/bool/any',
    uniBody.includes("other.kind === 'int'") && uniBody.includes("other.kind === 'uint'")
    && uniBody.includes("other.kind === 'int64'") && uniBody.includes("other.kind === 'uint64'")
    && uniBody.includes("other.kind === 'number'") && uniBody.includes("other.kind === 'bool'"));

  // ---- pointer result: the null arm is NULL, the live arm is untouched ----
  const ptr = mainOf(program([
    'var t1:Bitmap = o == null ? null : new Bitmap(null);',
  ]));
  check('object result keeps the class type: `? NULL : new Bitmap(...)`',
    ptr.includes('? NULL : Bitmap_new('));
  check('...and is NOT emitted as a constant NULL (the collapsed form of the bug)',
    !/g_t1 = NULL;/.test(ptr));

  // ---- value results: boxed, so that BOTH arms survive ----
  const num = mainOf(program(['var t2:Number = o == null ? null : 42;']));
  check('Number result boxes: `? as_v_null() : as_v_num(42)`',
    num.includes('? as_v_null() : as_v_num((double)(42))'));
  const bool = mainOf(program(['var t3:Boolean = o == null ? null : true;']));
  check('Boolean result boxes: `? as_v_null() : as_v_bool(true)`',
    bool.includes('? as_v_null() : as_v_bool(true)'));
  const str = mainOf(program(['var t4:String = o == null ? null : String("hi");']));
  check('String result was always immune (string rule wins first): `? NULL : "hi"`',
    str.includes('? NULL : "hi"'));
  const star = mainOf(program(['var t5:* = o == null ? null : 7;']));
  check('`*` result boxes too (probe case 8: a `*` on the other side used to win)',
    star.includes('? as_v_null() : as_v_num((double)(7))'));

  // ---- the controls the fix must NOT have touched ----
  const ctl = mainOf(program(['var t6:int = o == null ? 0 : 42;']));
  check('no null literal involved: still plain ints, no boxing',
    ctl.includes('? 0 : 42') && !ctl.includes('as_v_null() : as_v_num'));
  const rev = mainOf(program(['var t7:Bitmap = o == null ? new Bitmap(null) : null;']));
  check('the reverse shape (null in the ELSE slot) is unchanged',
    rev.includes('? Bitmap_new(') && rev.includes(': NULL'));
  const nested = mainOf(program(['var t8:int = o == null ? null : 5;']));
  check('the boxed result unboxes through the normal int path (as_v_int_cast of the boxed ternary)',
    nested.includes('as_v_int_cast((as_v_loose_eq(') && nested.includes('? as_v_null() : as_v_num((double)(5))'));

  if (ok > 0) console.log(`[ternnull] ${ok} ternary/null-join checks passed`);
  return bad;
}
registerGroup('unit: ternary/null-join', checkTernaryNull);