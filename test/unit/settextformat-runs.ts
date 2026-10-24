// Unit checks: TextField.setTextFormat() REPLACES the formatting of a range (G20, 阶段二百六十八).
//
// Why source-level pins here and pixels in an example: examples/settextformat-runs.as can
// only show that THIS build stops duplicating (and it needs the Skia text backend to
// measure anything at all -- without it textWidth is 0 and the example skips). What has
// to hold for every build is the *shape* of the emitted run table:
//
//   * the old body pushed one (begin, end, TextFormat) triple onto tf->_runs and never
//     trimmed, and sk_textlayout_new_runs copies text[start..end) once PER run -- so the
//     same characters were laid out once per call ("the typed text got copied");
//   * the replacement has to drop covered runs, keep the two remainders of a straddling
//     run, and (because the layout loop carries a `pos` cursor forward) keep the table
//     sorted by start.
//
// Every assertion is positional: it slices the emitted `TextField_setTextFormat` body out
// of the generated C, so `c.includes(...)` cannot be satisfied by unrelated runtime code.
//
//   node --test --test-name-pattern='setfmt' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

const SRC = [
  'import flash.text.TextField;',
  'import flash.text.TextFormat;',
  'var t:TextField = new TextField();',
  't.text = "1111";',
  't.setTextFormat(new TextFormat("Arial", 24, 0xFF0000), 0, 2);',
  '',
].join('\n');

// Slice one emitted function body out of the generated C (brace-matched, so the caller
// gets exactly the function under test).
function bodyOf(c: string, head: string): string {
  const at = c.indexOf(head + ' {');
  if (at < 0) return '';
  let i = c.indexOf('{', at);
  if (i < 0) return '';
  let depth = 0;
  for (let k = i; k < c.length; k++) {
    const ch = c[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return c.slice(at, k + 1); }
  }
  return '';
}

function checkSetTextFormat(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [setfmt] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [setfmt] ${label}`); }
  };

  const c = generateC(parse(SRC)).c;
  const body = bodyOf(c, 'void TextField_setTextFormat(void* _this, TextFormat* format, int begin, int end)');
  check('TextField_setTextFormat is emitted', body.length > 0);

  // The defect: an unconditional append to the live run table.
  check('nothing is appended to the live run table any more',
    !body.includes('as_array_push(tf->_runs,'));
  check('the table is rebuilt into a fresh array and swapped in at the end',
    body.includes('as_array* out = as_array_new();') && body.includes('tf->_runs = out;'));
  check('the swapped-in array is shaded (incremental GC: tf is already scanned)',
    body.includes('gc_write_barrier((void*)out);'));

  // Replacement, not stacking: covered runs disappear, neighbours are kept whole.
  check('a run that ends at or before begin is kept as-is',
    body.includes('if (e <= begin) { as_array_push(out, as_v_num((double)b));'));
  check('a run reaching past begin keeps its LEFT part (b .. begin)',
    body.includes('if (b < begin) { as_array_push(out, as_v_num((double)b)); as_array_push(out, as_v_num((double)begin));'));
  check('the new run is inserted exactly once',
    body.includes('if (!placed) {') && body.includes('placed = 1;'));
  check('a run starting at or after end is kept as-is',
    body.includes('if (b >= end) { as_array_push(out, as_v_num((double)b));'));
  check('a run reaching past end keeps its RIGHT part (end .. e)',
    body.includes('if (e > end) { as_array_push(out, as_v_num((double)end));'));

  // Ordering is not cosmetic: sk_textlayout_new_runs walks a `pos` cursor forward and
  // copies gaps only when s > pos, so an out-of-order run is laid out a second time.
  // The insert therefore has to sit BETWEEN the two halves of a split run.
  const leftHalf = body.indexOf('if (b < begin)');
  const insert = body.indexOf('if (!placed) {');
  const rightHalf = body.indexOf('if (e > end)');
  check('the insert point is between the left and right halves of a split run',
    leftHalf >= 0 && insert > leftHalf && rightHalf > insert);

  // Degenerate inputs: the reference normalises the arguments first (AIR defaults are
  // -1/-1 = whole string) and an empty range formats nothing, so it must not add an
  // empty run (the layout loop would skip it, but the table would grow forever).
  check('begin/end are normalised to the text length before use',
    body.includes('if (begin < 0) begin = 0;') && body.includes('if (end < 0 || end > len) end = len;')
    && body.includes('if (begin > end) { int t = begin; begin = end; end = t; }'));
  check('an empty range is a no-op', body.includes('if (begin >= end) return;'));
  check('a null format is a no-op', body.includes('if (format == NULL) return;'));
  check('the paragraph cache is invalidated', body.includes('tf->_runs_gen++;')
    && body.includes('as_skia_textlayout_delete(tf->_para); tf->_para = NULL;'));

  // The emitter side: this is emitted C, so pin where it comes from too -- a revert to
  // the append shape is then caught even if the C were to be reformatted.
  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8').replace(/\r\n/g, '\n');
    const at = emit.indexOf("void TextField_setTextFormat(void* _this");
  const stop = emit.indexOf('// htmlText setter:', at);
  const emitted = at >= 0 ? emit.slice(at, stop > at ? stop : at + 6000) : '';
  check('src/emit.ts no longer pushes a lone run onto tf->_runs',
    emitted.length > 0 && !emitted.includes("as_array_push(tf->_runs,"));

  if (ok > 0) console.log(`[setfmt] ${ok} setTextFormat checks passed`);
  return bad;
}
registerGroup('unit: text/settextformat', checkSetTextFormat);