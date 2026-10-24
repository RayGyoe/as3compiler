// Unit checks: a static field read that only happens INSIDE a closure must still
// run the declaring class's `_cinit()` (阶段二百六十九 · G22).
//
// Why source-level pins here and behaviour in an example: the defect was EMISSION
// ORDER, not a runtime path. Closure bodies are emitted by `emitFunctionValues`,
// which runs before `emitClassRegistry`/`emitStaticFields` -- the two places that
// used to fill the "which classes own a `_cinit`" set. So `sfRead` saw an empty set
// and emitted a bare slot read; the class initializer never ran and the C slot was
// NULL. A behavioural example alone cannot say WHY it works, and the interesting
// regression (someone moving the collect back down) is invisible until a program
// happens to read a static from a closure only.
//
// The three things pinned here are the fix's contract:
//   1. ORDER -- `collectCinitClasses()` runs before `emitFunctionValues()`.
//   2. GUARD -- every read of a runtime-initialized static is `(Owner_cinit(), ...)`,
//      including the one inside a closure body.
//   3. DECLARATION -- `static void Owner_cinit(void);` precedes its first call (the
//      guard alone makes C reject the program: implicit declaration).
//
// The behavioural matrix lives in examples/closure-statics.as and the 10-case
// AIR/AOT matrix plus the generated-C audit live in
// asaotui/probes/g22-closure-statics/.
//
//   node --test --test-name-pattern='closstat/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

function checkClosureStatics(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [closstat] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [closstat] ${label}`); }
  };

  // ---- the ordering contract, in the compiler source ----
  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8').replace(/\r\n/g, '\n');
  const runAt = emit.indexOf('  run(): string {');
  const runBody = runAt >= 0 ? emit.slice(runAt, runAt + 2500) : '';
  const collectAt = runBody.indexOf('this.collectCinitClasses();');
  const fnValuesAt = runBody.indexOf('this.emitFunctionValues();');
  const declAt = runBody.indexOf('_cinit(void);');
  check('run() collects the `_cinit` owners itself', collectAt > 0);
  check('...BEFORE emitFunctionValues -- closure bodies are the earliest emitters that can call one',
    collectAt > 0 && fnValuesAt > collectAt);
  check('run() also forward-declares every `_cinit` before that point', declAt > 0 && declAt < fnValuesAt);

  // ---- the emitted C: a closure-only static read carries its guard ----
  const src = [
    'package {',
    '  public class Holder {',
    '    private static const NAMES:Array = ["alpha", "beta"];',
    '    private static const LIT:String = "lit";',
    '    private static const NUM:int = 5;',
    '    public static function f():Function {',
    '      return function ():String { return NAMES[0]; };',
    '    }',
    '    public static function g():Function {',
    '      return function ():int { return NUM * 2; };',
    '    }',
    '    public static function h():Function {',
    '      return function ():String { return LIT; };',
    '    }',
    '  }',
    '  public class Plain {',
    '    public static const LIT:String = "plain";',
    '    public static function h():Function {',
    '      return function ():String { return LIT; };',
    '    }',
    '  }',
    '}',
    'trace(Holder.f()());',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;
  const lines = c.split(/\r?\n/);

  check('closure read of a runtime-initialized Array is guarded',
    c.includes('(Holder_cinit(), Holder_NAMES)'));

  // Every non-declaration, non-definition occurrence of Holder_NAMES must be guarded.
  const readLines = lines.filter((l) => /\bHolder_NAMES\b/.test(l)
    && !/^\s*static\s+/.test(l) && !/^\s*gc_mark_ptr\(/.test(l) && !/^\s*Holder_NAMES\s*=/.test(l));
  check('every Holder_NAMES read point is guarded (no bare slot read survives)',
    readLines.length > 0 && readLines.every((l) => l.includes('Holder_cinit()')));

  check('a second runtime-initialized static in the same class is guarded too (same `_cinit`)',
    c.includes('(Holder_cinit(), Holder_NUM)'));

  // ---- the control: `_cinit` is a CLASS-level switch ----
  // A guard is decided by the DECLARING CLASS, not by the individual field: a
  // literal `const` in a class that also owns a runtime initializer rides the same
  // `_cinit` (harmless and by design). The meaningful control is a class that owns
  // NO runtime initializer at all -- it must stay bare, i.e. no `_cinit` is born.
  check('a class with only literal consts gets no `_cinit`', !c.includes('Plain_cinit'));
  const plainReads = lines.filter((l) => /\bPlain_LIT\b/.test(l)
    && !/^\s*static\s+/.test(l) && !/^\s*gc_mark_ptr\(/.test(l));
  check('...and its closure read stays a bare slot read',
    plainReads.length > 0 && plainReads.every((l) => !l.includes('_cinit()')));

  // ---- declaration before first call ----
  const declLine = lines.findIndex((l) => /^\s*static void Holder_cinit\(void\);/.test(l));
  const callLine = lines.findIndex((l) => /\bHolder_cinit\(\)/.test(l) && !/static void Holder_cinit\(void\);/.test(l)
    && !/^\s*static void Holder_cinit\(void\) \{/.test(l));
  check('`static void Holder_cinit(void);` is declared before its first call',
    declLine >= 0 && callLine > declLine);

  if (ok > 0) console.log(`[closstat] ${ok} closure/static-init checks passed`);
  return bad;
}
registerGroup('unit: closure/statics', checkClosureStatics);