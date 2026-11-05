// Unit checks: the generated C must compile with NO warnings under clang's
// DEFAULT warning set -- which is what every real build uses (`clang -O2`, no
// -Wall). Default-on diagnostics are exactly the ones a downstream app sees and
// complains about: -Wparentheses-equality, -Wreturn-type, -Wunused-value,
// -Wnull-character, -Wpointer-integer-compare, -Wmacro-redefined.
//
// Every shape pinned here was a real warning in a 414k-line generated file
// (TalkMED Meeting, 725 warnings before this group existed). The pins are
// source-level in their *expectation* (they assert warning-free compilation of a
// program that exercises the shapes), because a single shape's C text is a
// moving target -- what must never regress is "clang has nothing to say".
//
// -Wall is deliberately NOT used: the runtime preamble has its own -Wall-only
// noise (-Wframe-address, -Wmissing-braces in the C89 struct initialisers), which
// no default build ever reports and which is not this project's contract.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

// One program exercising every emitter shape that used to warn. Kept as a single
// source (not several) so the compile is one process: the group runs in the
// examples' timing budget, not the unit budget.
const PROBE = `
var field:TextField = new TextField();
field.autoSize = "left";
field.blendMode = "layer";
field.opaqueBackground = 123;
field.x = 1, field.y = 2;
var mode:String = (field.autoSize = "center");
var background:* = (field.opaqueBackground = 456);
trace(mode, background, field.x, field.y);
var arr:Array = [1, 2, 3];
var n:int = 1;
var idx:int = 0;
function pick(v:int):String {
  switch (v) {
    case 1: return "one";
    case 2: return "two";
    default: return "?";
  }
}
function untyped(v) {
  if (v) { trace("t"); }
}
function maybe(s:String):void {
  if (s != null) { trace(s); }
}
// -Wunused-value: the discarded short-circuit / read-modify-write statements.
arr[n]++;
++arr[n];
arr[n] ||= 0;
arr[n] &&= 2;
for (n; n > 0; n--) { }
(0 as Object);
// -Wpointer-integer-compare: primitive == null is ALWAYS false in AS3 (adl
// 51.4.1, temp/warnprobe/adl/Sem2.as), while C compares a double against NULL
// -- which does not even compile.
var f:Boolean = false;
var t:Number = 0.5;
if (f == null) { trace("boolean==null"); }
if (n != null) { trace("int!=null"); }
if (t == null) { trace("number==null"); }
// -Wunused-value: a ternary STATEMENT whose branches are value-only.
idx = n > 0 ? 1 : 2;
(n > 0) ? (idx--) : (idx++);
// capabilities return a const char*; the AS3 property is a plain String.
trace(pick(n) + " " + Capabilities.os + " " + Capabilities.playerType);
untyped(1);
maybe(null);
trace(arr.length + " " + idx);
`;

function findCompiler(): string | null {
  for (const c of ['clang', 'cc', 'gcc']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // Not on this machine; try the next name.
    }
  }
  return null;
}

function checkGeneratedCWarnings(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { ok++; console.log(`PASS  [cwarn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cwarn] ${label}${detail ? `\n      ${detail}` : ''}`); }
  };

  const cc = findCompiler();
  if (cc === null) {
    console.log('SKIP  [cwarn] no C compiler on this machine');
    return bad;
  }

  const c = generateC(parse(PROBE)).c;
  // A few shapes have a stable spelling worth pinning directly, because a
  // warning-free compile alone would also accept a plain removal of the code.
  check('`x[i]++` in statement position is ONE store (no scratch temp)',
    !/as_v_num\(as_v_to_number\(as_array_get\([^)]*\)\) \+ \(\(double\)\(1\)\)\)\)\), _sv/.test(c));
  // The re-read that carries the short-circuit value is only skipped in STATEMENT
  // position; in a value context `(store, re-read)` must stay (that is how the
  // element setters, which return void, report a value).
  check('`x[i] ||= v` / `x[i] &&= v` in statement position store without a temp',
    !/(\|\|=|&&=)/.test(PROBE) || !/as_v_truthy\(as_array_get\(.*\), _sv\d/.test(c));
  check('a compared expression is not double-parenthesised (`if (x == y)`)',
    !/\b(if|while) \(\([^()]*==[^()]*\)\)/.test(c));
  check('an `||`/`&&` chain keeps its grouping', /\(as_v_truthy\(/.test(c));
  check('primitive == null folded to a constant', /if \(false\) \{/.test(c) || /if \(true\) \{/.test(c));
  check('a `?:` statement is cast to void', /\(void\)\(\(.*\?.*:.*\)\);/.test(c));
  check(`a pure for-init is cast to void (\`for ((void)(i); …)\`)`, /for \(\(void\)\(/.test(c));
  check('null char literals are spelled with two characters', c.includes("'\\0'"));

  const dir = mkdtempSync(join(tmpdir(), 'asc-cwarn-'));
  try {
    const p = join(dir, 'warn.c');
    writeFileSync(p, c);
    // Default warning set, exactly like a real build (`clang -O2`).
    const result = spawnSync(cc, ['-fsyntax-only', p], { encoding: 'utf8' });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    check('the generated C passes syntax checking', result.status === 0, out);
    const exe = join(dir, 'warn-probe');
    const linked = spawnSync(cc, [p, '-O2', '-lm', '-lz', ...(process.platform === 'darwin' ? ['-liconv'] : []), '-o', exe], { encoding: 'utf8' });
    check('the warning probe links', linked.status === 0, linked.stderr ?? '');
    if (linked.status === 0) {
      const run = spawnSync(exe, [], { encoding: 'utf8' });
      check('dirty-field assignment values and comma effects are preserved',
        run.status === 0 && run.stdout.startsWith('center 456 1 2\n'),
        `${run.stdout ?? ''}${run.stderr ?? ''}`);
    }
    const warnings = out.split('\n').filter((l) => l.includes('warning:'));
    check('the generated C compiles with zero default-set warnings', warnings.length === 0,
      warnings.slice(0, 6).join('\n      '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`     [cwarn] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: emit/NoWarnings', checkGeneratedCWarnings);