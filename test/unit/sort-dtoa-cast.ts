// Unit checks: three library/codegen defects found while profiling the AOT build
// of a real AIR application (阶段三百一十四).
//
// All three were measured, not suspected, and all three are the kind of thing that
// silently comes back: a sort rewritten to qsort loses AS3's stability contract, a
// precision scan re-unrolled to `for (prec = 0..17)` is 3.5x slower for identical
// output, and a value-class cast `Point(o)` regressing to `Point_new(...)` turns
// every read into `NaN`/`0` with no compile error at all. So each fix is pinned
// twice where possible: on the emitted/runtime source, and (for the cast) on the
// actual generated C, which is the only artifact where "coercion" vs "constructor
// call" is observable without a C toolchain.
//
// Measured reference (same .as run under `adl 51.3.2` and under AOT, line-by-line
// diff): temp/perf-b3/src/{SemCheck,GeomProbe,RTProbe}.as with the readings kept
// beside them; the baseline-vs-patched three-way comparison lives in
// temp/perf-b3/cmp3.sh.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

function readSrc(name: string): string {
  return readFileSync(join(root, 'src', name), 'utf8').replace(/\r\n/g, '\n');
}

// Slice one C function out of the runtime preamble, from its definition line to
// the first column-0 closing brace.
function cFunction(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const end = src.indexOf('\n}', at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 2);
}

// ---- A) Array.sort / sortOn: stable merge on the five option bits ----
// Two things are pinned here, both measured against adl 51.4.1 (temp/sortprobe/):
//   1. stability — ties keep their original relative order. AIR itself does NOT
//      guarantee that (its qsort permutes equal keys), which is why the reference
//      tables in temp/sortprobe differ from ours only inside tie groups; keeping
//      our order deterministic is a deliberate decision, documented in the stage.
//   2. the five option bits — CASEINSENSITIVE / DESCENDING / UNIQUESORT /
//      RETURNINDEXEDARRAY / NUMERIC all used to be discarded, so every flag
//      combination produced the same array as sort().
function checkArraySortMerge(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sortmerge] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sortmerge] ${label}`); }
  };

  const runtime = readSrc('runtime.ts');
  const impl = cFunction(runtime, 'static as_value as_array_sort_ex(as_array* a, as_sort_ctx* ctx) {');
  const merge = cFunction(runtime, 'static void as_sort_order(int* ord, int* aux, int k, as_array* a, as_cmp_fn cmp, void* ctx) {');

  check('as_array_sort_ex exists', impl.length > 0);
  check('as_sort_order exists', merge.length > 0);
  // Bottom-up merge, window doubling: the O(n^2) core must not come back.
  check('the core is a bottom-up merge (width doubling)', /for \(int width = 1; width < k; width \*= 2\)/.test(merge));
  // Stability is the AS3 contract (and the reason qsort is not an option):
  // taking the left run on equality is the only place it comes from.
  check('ties take the left run (this is the stability)', /cmp\(a->data\[src\[p\]\], a->data\[src\[q\]\], ctx\) <= 0/.test(merge));
  // The comparator is user AS3: it may push/splice the array being sorted, so we
  // sort an INDEX table and re-read a->data on every comparison.
  check('the sort orders indices, not a cached value buffer', /as_sort_order\(ord, aux, k, a, as_cmp_opts, ctx\)/.test(impl));
  check('a pass left in the scratch table is copied back', /if \(in_aux\) memcpy\(ord, aux,/.test(merge));
  check('the scratch tables are freed on every exit path',
    (impl.match(/free\(ord\); free\(aux\);/g) || []).length >= 3);
  // The insertion loop survives only as the out-of-memory fallback (same semantics,
  // just slow) -- pinning the count keeps it from silently becoming the core.
  const insertionSites = (impl.match(/as_value key = a->data\[i\];/g) || []).length;
  check('the insertion loop remains only in the allocation-failure fallback',
    insertionSites === 1 && /if \(ord == NULL \|\| aux == NULL \|\| vals == NULL\) \{/.test(impl));

  // --- the five option bits ---
  check('CASEINSENSITIVE has its own ASCII-folding comparator',
    /static int as_str_cmp_ci\(const char\* x, const char\* y\)/.test(runtime) &&
    /\(c->flags & AS_SORT_CI\) != 0/.test(runtime));
  check('DESCENDING negates the comparison (not a post-reverse)',
    /return \(\(c->flags & AS_SORT_DESC\) != 0\) \? -r : r;/.test(runtime));
  // UNIQUESORT: a duplicate returns Number 0 and leaves the array untouched.
  check('UNIQUESORT returns Number 0 without touching the array',
    /if \(dup\) \{ free\(ord\); free\(aux\); free\(vals\); return as_v_num\(0\); \}/.test(impl));
  check('UNIQUESORT counts >=2 holes as a duplicate', /\(n - k\) >= 2/.test(impl));
  // RETURNINDEXEDARRAY: index table out, original array untouched, holes last.
  check('RETURNINDEXEDARRAY emits defined indices then hole indices',
    /for \(int i = 0; i < k; i\+\+\) as_array_push\(r, as_v_num\(\(double\)ord\[i\]\)\);/.test(impl) &&
    /if \(a->data\[i\].tag == 5\) as_array_push\(r, as_v_num\(\(double\)i\)\);/.test(impl));
  // NUMERIC sorts NaN last (AIR: [NaN,1].sort(NUMERIC) is 1,NaN) and `sort`
  // raises #1034 for a value ToNumber cannot parse (sortOn does not).
  check('NUMERIC puts NaN after every number', /if \(isnan\(na\)\) r = isnan\(nb\) \? 0 : 1;/.test(runtime));
  check('numeric validation is sort-only (sortOn compares as NaN)',
    /if \(ctx->field == NULL && ctx->cb == NULL && \(ctx->flags & AS_SORT_NUMERIC\) != 0\)/.test(impl) &&
    /as_throw_1034\(v, "Number"\)/.test(runtime));
  // 32 and every unknown bit must stay a no-op: sort(32) == sort(0).
  check('unknown flag bits are ignored', !/AS_SORT_[A-Z]+ *32|0x20/.test(runtime.split('AS_SORT_NUMERIC 16')[1].slice(0, 400)));

  // --- sparse slots ---
  // adl: 'var a=[5,4,3]; a[10]=1; a.sort()' => join "1,3,4,5,,,,,,,", '4 in a' false.
  check('sort compacts defined elements and holes the tail',
    /for \(int i = k; i < n; i\+\+\) \{ as_value u = \{5, 0.0, NULL\}; a->data\[i\] = u; \}/.test(impl));
  check('only defined slots are collected for sorting',
    /if \(a->data\[i\].tag != 5\) ord\[k\+\+\] = i;/.test(impl));

  // All entry points share the one core -- if any of them grew its own sort, the
  // fixes above would stop covering it.
  const wrappers = [
    'as_array_sort_flags(as_array* a, int options)',
    'as_array_sort_arr(as_array* a, int options)',
    'as_array_sort_any(as_array* a, as_value v)',
  ];
  for (const w of wrappers) check(`shared core serves ${w.slice(0, w.indexOf('('))}`, runtime.includes(w));
  check('sort()/sortOn()/comparator forms all reach as_array_sort_ex',
    (runtime.match(/as_array_sort_ex\(a, &ctx\)/g) || []).length >= 4);

  // Emitter: an UNIQUESORT-bearing (or unknown) flag set keeps the boxed result,
  // because that call can return Number 0. A statically known set stays Array.
  const gen = generateC(parse('var a:Array = ["b","a"]; a.sort(Array.NUMERIC); a.sort(Array.UNIQUESORT); a.sortOn("k", Array.NUMERIC);'));
  // Only the call sites matter here: the runtime preamble owns the definitions.
  const callSites = String(gen.c).split('\n').filter((l) => /^\s+(as_array_sort\w*\(|as_array_sortOn_\w*\()/.test(l)).join('\n');
  check('known flag bits take the typed array path', /as_array_sort_arr\(.*, 16\);/.test(callSites));
  check('UNIQUESORT takes the boxed path', /as_array_sort_flags\(.*, 4\);/.test(callSites));
  check('sortOn keeps the typed path for known bits', /as_array_sortOn_arr\(.*, "k", 16\);/.test(callSites));
  check('an unknown flag argument takes the boxed path', /as_array_sort_flags\(/.test(
    String(generateC(parse('var a:Array = ["b","a"]; var f:int = 16; a.sort(f);')).c)));

  if (ok > 0) console.log(`[sortmerge] ${ok} Array.sort/sortOn checks passed`);
  return bad;
}

// ---- B) Number -> String: binary search over precision, same output ----
function checkDoubleToStringBinary(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [dtoa] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [dtoa] ${label}`); }
  };

  const runtime = readSrc('runtime.ts');
  const fn = cFunction(runtime, 'static char* as_str_from_double(double v) {');

  check('as_str_from_double exists', fn.length > 0);
  // The linear scan is what made one conversion cost up to 18 snprintf+strtod pairs.
  check('the linear precision scan is gone', !/for \(int prec = 0; prec <= 17; prec\+\+\)/.test(fn));
  check('the precision search is a binary search over 0..17',
    /int lo = 0, hi = 17;/.test(fn) && /while \(lo < hi\) \{/.test(fn) && /int mid = \(lo \+ hi\) >> 1;/.test(fn));
  check('the monotone predicate is unchanged (strtod round-trip)',
    /if \(strtod\(buf, NULL\) == v\) hi = mid; else lo = mid \+ 1;/.test(fn));
  check('the winning precision is emitted with the same format string',
    /snprintf\(buf, sizeof\(buf\), sci \? "%\.\*e" : "%\.\*f", lo, v\);/.test(fn));
  // Byte-identical output is the whole point of the rewrite: same predicate, same
  // format strings, same interval, same scientific-notation gate.
  check('the scientific-notation gate is untouched', /bool sci = \(av < 1e-6 \|\| av >= 1e21\);/.test(fn));
  check('the two format branches are still exactly %.*e / %.*f', (fn.match(/sci \? "%\.\*e" : "%\.\*f"/g) || []).length === 2);
  check('exponential form is still normalised once, after the emit', (fn.match(/if \(sci\) as_norm_exp\(buf\);/g) || []).length === 1);
  check('NaN/Infinity/zero special cases are untouched',
    /if \(isnan\(v\)\) return "NaN";/.test(fn) && /return v > 0 \? "Infinity" : "-Infinity";/.test(fn) && /if \(v == 0\.0\) return "0";/.test(fn));

  if (ok > 0) console.log(`[dtoa] ${ok} Number->String checks passed`);
  return bad;
}

// ---- C) flash.geom value classes: T(expr) is a coercion, not a constructor ----
//
// `Point(o, 3)` is a non-AIR convenience we kept; `Point(o)` is NOT a one-argument
// construction. mxmlc rejects `Point(1, 2)` with "参数的数量不正确。要求不超过 1 个",
// i.e. the class-as-value is a coercion function taking at most one argument, and
// adl measured it returning the very same object. Routing the one-argument form to
// emitGeomConstructor produced `Point_new(as_v_to_number(o), 0.0)`, so every field
// read afterwards answered NaN/0 -- wrong values, no error, no warning.
const CAST_SRC = `package {
import flash.geom.Point;
import flash.geom.Rectangle;
public class CastProbe {
  public function one(o:Object):Number { return Point(o).x; }
  public function two(o:Object):Number { return Point(o, 3).y; }
  public function scalar():Number { return Point(5).x; }
  public function rect(o:Object):Number { return Rectangle(o).width; }
}}`;

// The DEFINITION, not the forward declaration: `static double CastProbe_one(...);`
// precedes `static double CastProbe_one(...) {`, so the opening brace is load-bearing.
function castBodies(): Record<string, string> {
  const c = generateC(parse(CAST_SRC)).c;
  const out: Record<string, string> = {};
  for (const name of ['one', 'two', 'scalar', 'rect']) {
    const re = new RegExp(`^static double CastProbe_${name}\\(.*\\) \\{$`, 'm');
    const m = re.exec(c);
    if (!m) { out[name] = ''; continue; }
    const end = c.indexOf('\n}', m.index);
    out[name] = c.slice(m.index, end < 0 ? undefined : end + 2);
  }
  return out;
}

function checkValueClassCoercion(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [geomcast] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [geomcast] ${label}`); }
  };

  const emit = readSrc('emit.ts');
  // The dispatch order is the fix: bail out of the "constructible without new"
  // case for exactly one argument, so the generic Type(expr) coercion path wins.
  const from = emit.indexOf("case 'Point':");
  // `case 'Object':` occurs earlier in the same giant switch too, so search forward
  // from the geom block rather than from the top of the file.
  const to = from < 0 ? -1 : emit.indexOf("case 'Object':", from);
  const caseBlock = from >= 0 && to > from ? emit.slice(from, to) : '';
  check('the geom case block is present', caseBlock.length > 0 && /case 'Matrix':/.test(caseBlock));
  check('a single argument yields to the coercion path', /if \(args\.length === 1\) return null;/.test(caseBlock));
  check('the yield happens before emitGeomConstructor',
    caseBlock.indexOf('args.length === 1') < caseBlock.indexOf('return this.emitGeomConstructor(name, args);'));
  for (const cls of ['Point', 'Rectangle', 'Matrix', 'ColorTransform', 'Transform'])
    check(`${cls} is still in the no-new constructible table`, caseBlock.includes(`case '${cls}':`));

  const b = castBodies();
  check('Point(o) compiles to a coercion, not Point_new',
    b.one.includes('as_v_req_inst') && b.one.includes('&Point_vt, "flash.geom::Point"') && !b.one.includes('Point_new('));
  check('Point(o, 3) still constructs (the non-AIR convenience is kept)',
    b.two.includes('Point_new(') && !b.two.includes('as_v_req_inst'));
  check('Point(5) is a coercion too -- AIR raises TypeError #1034 here',
    b.scalar.includes('as_v_req_inst') && !b.scalar.includes('Point_new('));
  check('Rectangle(o) is a coercion', b.rect.includes('as_v_req_inst') && !b.rect.includes('Rectangle_new('));

  if (ok > 0) console.log(`[geomcast] ${ok} value-class coercion checks passed`);
  return bad;
}

registerGroup('unit: runtime/ArraySortMerge', checkArraySortMerge);
registerGroup('unit: runtime/DoubleToStringBinary', checkDoubleToStringBinary);
registerGroup('unit: emit/ValueClassCoercion', checkValueClassCoercion);
