// Unit checks: 64-bit integers and the non-returning throw path.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='numeric/' test/unit/*.ts

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

// ---- 64-bit integers (stage 94.24, enhancement E9) ----
//
// AIR has no int64/uint64, so the feature is opt-in by writing the type: the
// checks below pin the whole chain (lexer suffix -> verbatim literal -> C type ->
// box tag -> GC safety) plus the example's golden output, which is a plain C
// build (no Skia), so it doubles as the native/WASI parity check.
function checkInt64(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [int64] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [int64] ${label}`); }
  };

  const lexer = readFileSync(join(root, 'src', 'lexer.ts'), 'utf8');
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const preamble = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const ex = readFileSync(join(root, 'examples', 'stage94t.as'), 'utf8');

  // The opt-in literal form: the DIGITS are what gets emitted, never the token's
  // double (which cannot hold 2^53+1).
  check('the lexer recognises the L / UL literal suffixes',
    lexer.includes("width = 'int64'") && lexer.includes("width = 'uint64'"));
  check('the emitter expands a suffixed literal through INT64_C/UINT64_C',
    emitSource.includes("const macro = expr.width === 'int64' ? 'INT64_C' : 'UINT64_C';")
    && emitSource.includes('literal out of range'));
  check('the type maps to the stdint C types',
    emitSource.includes("case 'int64': return 'int64_t';")
    && symbols.includes("case 'int64': return { kind: 'int64' };"));
  check('the conversion functions exist alongside int()/uint()',
    emitSource.includes("case 'int64': {") && emitSource.includes("case 'uint64': {"));

  // Box tags 8/9 ride in the pointer slot's union, so no existing initializer or
  // object size changed -- and the GC must treat them as integers, never pointers.
  check('the box tags link the payload to the raw 64-bit slot',
    preamble.includes('union { void* ptr; int64_t i64; uint64_t u64; };')
    && preamble.includes('static as_value as_v_i64(int64_t x)'));
  check('the four value helpers all know the 64-bit tags',
    preamble.includes('case 8: return v.i64 != 0;')        // truthy
    && preamble.includes("case 8: return as_str_from_i64(v.i64);")   // str_val
    && preamble.includes('case 8: return a.i64 == b.i64;')  // eq (+seq)
    && preamble.includes('case 8: case 9: return "number";'));  // typeof
  check('GC never chases a 64-bit tag as a pointer',
    preamble.includes('if (v.tag == 3 || v.tag == 4 || v.tag == 6 || v.tag == 7)')
    && preamble.includes('a range test here would mark raw')
    && !preamble.includes('if (v.tag >= 3 && v.tag <= 7)'));
  // C's undefined edges are guarded, not inherited: % by zero, shift >= 64, and
  // the double -> int64 cast on NaN/Infinity.
  check('the C undefined edges are guarded',
    preamble.includes('static int64_t as_i64_rem(int64_t a, int64_t b) { return b == 0 ? 0 : a % b; }')
    && preamble.includes('? 0 : (int64_t)d;')
    && emitSource.includes('((unsigned)(${rc}) & 63u)'));
  // The refusals that keep it honest (no silent rounding).
  check('the lossy conversions are refused loudly',
    emitSource.includes('cannot store an int64/uint64 value in an Object-typed slot')
    && emitSource.includes('not vector-monomorphised'));
  check('the example pins the exactness and cross-type goldens',
    ex.includes('and the +1 is not lost') && ex.includes('"int64/uint64 compare mathematically, not by C' + String.fromCharCode(39) + 's unsigned conversion"')
    && ex.includes('"boxed 64-bit values survive a GC (no pointer chasing)"')
    && ex.includes('all 64-bit integer checks passed'));

  if (ok > 0) console.log(`[int64] ${ok} 64-bit integer checks passed`);
  return bad;
}

// ---- non-returning throw path (stage 94.26, the Starling 2x regression) ----
//
// The #1009 null-receiver guard is emitted at thousands of member-access sites,
// so it must be *inlinable*. clang only inlines it when it can see that the
// error path terminates, which is what the C11 `_Noreturn` on as_throw states.
// Losing that specifier silently turns every guarded access in a hot loop into
// an opaque out-of-line call -- the Starling benchmark halved (42k -> 22k
// objects) without any test going red, so it is pinned here.
function checkNoreturn(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [noreturn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [noreturn] ${label}`); }
  };

  const preamble = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  // The A/B numbers live in the roadmap entry (阶段九十四·二十六), NOT in the
  // original scratch harness under temp/ -- temp/ is disposable and the pin went
  // red the moment that directory was pruned. TODO.md is the durable record.
  const ev = readFileSync(join(root, 'TODO.md'), 'utf8');

  check('as_throw carries the standard C11 _Noreturn specifier',
    preamble.includes('static _Noreturn void as_throw(void* e) {'));
  // The specifier must stay TRUE: both terminating paths have to be present, or
  // _Noreturn would be undefined behaviour rather than a fact.
  check('the specifier is true: the body only exits or longjmps',
    preamble.includes('longjmp(*as_jmp_stack[as_jmp_depth - 1], 1);') &&
    preamble.includes('fflush(stderr);') &&
    preamble.includes('exit(1);'));
  // The guard must route its null path through as_throw (possibly wrapped by
  // other as_throw_* helpers), so that it inherits the noreturn fact.
  check('the #1009 guard still throws through as_throw',
    emitSource.includes('static void* as_req_obj(void* p) {') &&
    /static void\* as_req_obj\(void\* p\) \{[\s\S]{0,400}?as_throw\(TypeError_new/.test(emitSource));
  // Guard against a "tidy-up" deleting the explanation and the specifier with it.
  check('the reason is documented next to the specifier',
    /_Noreturn(?:.|\n){0,1200}?OUT OF LINE/.test(preamble));
  // The regression and its measurement live in the evidence platform.
  check('the regression and its A/B numbers are recorded',
    ev.includes('42 144') && ev.includes('21 888') &&
    ev.includes('_Noreturn') && ev.includes('bl'));

  if (ok > 0) console.log(`[noreturn] ${ok} non-returning throw checks passed`);
  return bad;
}

registerGroup('unit: numeric/Int64', checkInt64);
registerGroup('unit: numeric/Noreturn', checkNoreturn);

// ES3/AIR parseInt & parseFloat. The examples suite runs examples/parse-int.as
// (assertions against adl 51.4.1), but the emitter shape and the runtime helpers
// are only visible here: parseInt must return a Number (not int), pass the radix
// through, and the two runtime scanners must implement AVM2's measured quirks
// (trailing junk ignored, 0x stripped only at radix 0/16, leading zeros decimal,
// "5e-" NaN but "5e"/"5e+" rewound). Reference: temp/qfix/gcadl/p{1,2,3,4}Main.as
// -> 82 paired lines, 0 diff.
function checkParseIntFloat(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [numparse] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [numparse] ${label}`); }
  };

  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const flat = pre.replace(/\s+/g, ' ');
  const call = generateC(parse('function zzq():Number { return parseInt("ff", 16); }\nvar qq:Number = zzq();\ntrace(qq);\n')).c;
  check('parseInt compiles to the helper, not atoi',
    call.includes('return as_parse_int("ff", ((double)(16)));') && !/return atoi\(/.test(call));
  check('the radix is passed through', call.includes('as_parse_int("ff", ((double)(16)))'));
  check('a radix-less call defaults to 0 (auto-detect)',
    /as_parse_int\([^)]*, 0\.0\)/.test(generateC(parse('var n:Number = parseInt("ff");\ntrace(n);\n')).c));
  check('parseInt returns a Number, not an int', call.includes('static double zzq()'));
  check('the auto-detect branch sets radix 16 on a 0x/0X prefix',
    flat.includes("if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { radix = 16; p += 2; }"));
  check('...and radix 10 otherwise (leading zeros stay decimal)',
    flat.includes('else radix = 10;'));
  check('an explicit radix 16 also strips the 0x prefix',
    flat.includes("else if (radix == 16 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { p += 2; }"));
  check('an invalid radix is NaN', flat.includes('} else if (radix < 2 || radix > 36) { return NAN; }'));
  check('a digitless scan is NaN', flat.includes('if (digits == 0) return NAN;'));
  check('parseFloat ignores trailing junk (scan, not full-string)',
    flat.includes('return strtod(buf, NULL);'));
  check('parseFloat is case-sensitive about Infinity',
    flat.includes('if (strncmp(p, "Infinity", 8) == 0) return (start[0] == \'-\') ? -INFINITY : INFINITY;'));
  check('the "5e-" NaN quirk is encoded', flat.includes('} else if (eneg) {') && flat.includes('// "5e-" is NaN'));

  console.log(`     [numparse] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: numeric/ParseIntFloat', checkParseIntFloat);
