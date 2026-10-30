// Unit checks: `TextField.getTextFormat(begin, end)` must answer the formatting IN
// EFFECT over the range, not the field default (阶段二百七十 · G21).
//
// The defect was a one-liner written before the run table existed:
//   return (tf != NULL) ? tf->defaultTextFormat : NULL;
// so a field with `setTextFormat(new TextFormat("Arial", 30, 0xFF0000))` kept
// reporting size 20 / colour 0 for every range, and the no-arg form never saw a run.
//
// What is pinned here is the SHAPE of the replacement, because the interesting
// regressions are all silent:
//   1. the emitted body consults `_runs` and compares the formats of the segments
//      (a range straddling a change answers an EMPTY TextFormat, not the first one);
//   2. the empty answer exists and nulls every modelled field;
//   3. the out-of-bounds RangeError #2006 path exists;
//   4. TextFormat's Object-typed fields are boxed, which is what makes (2) expressible.
//
// The 30-cell behaviour matrix (values, both arms) lives in
// asaotui/probes/g21-gettextformat/ and the readable assertions in
// examples/gettextformat.as.
//
//   node --test --test-name-pattern='getfmt/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

function checkGetTextFormat(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [getfmt] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [getfmt] ${label}`); }
  };

  // ---- TextFormat's Object-typed fields are boxed ----
  // AIR's TextFormat declares size/color/bold/... as Object precisely because an
  // UNSET one reads back as null. Keeping them as `double`/`unsigned` made that
  // unrepresentable, which is the structural reason the old one-liner ever looked
  // acceptable.
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8').replace(/\r\n/g, '\n');
  for (const f of ['size', 'color', 'bold', 'italic', 'underline', 'leading', 'kerning', 'letterSpacing', 'leftMargin', 'rightMargin']) {
    check(`TextFormat.${f} is a boxed (any) field, so null is representable`,
      symbols.includes(`['${f}', tff({ kind: 'any' }, 'TextFormat')]`));
  }

  // ---- the emitted function ----
  const src = [
    'package {',
    '  import flash.text.TextField;',
    '  import flash.text.TextFormat;',
    '  public class FmtProbe {',
    '    public static function run():String {',
    '      var t:TextField = new TextField();',
    '      t.defaultTextFormat = new TextFormat("Arial", 20, 0x000000);',
    '      t.text = "0123456789";',
    '      t.setTextFormat(new TextFormat("Arial", 30, 0xFF0000), 2, 6);',
    '      var f:TextFormat = t.getTextFormat(3, 5);',
    '      return String(f.size);',
    '    }',
    '  }',
    '}',
    'trace(FmtProbe.run());',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // The prototype is emitted too; the DEFINITION is the last occurrence.
  const at = c.lastIndexOf('TextField_getTextFormat(void* _this');
  check('the generated C defines TextField_getTextFormat', at > 0);
  let body = '';
  if (at > 0) {
    const open = c.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < c.length; i++) {
      if (c[i] === '{') depth++;
      else if (c[i] === '}') { depth--; if (depth === 0) { body = c.slice(open, i + 1); break; } }
    }
  }
  check('the definition has a parsable body', body.length > 0);

  check('it consults the run table', body.includes('tf->_runs'));
  check('it compares the formats of the segments it walks', body.includes('as_tf_fmt_eq('));
  check('a straddling / empty range answers an empty TextFormat', body.includes('as_tf_fmt_empty()'));
  check('the answer is a COPY of the covering format', body.includes('as_tf_fmt_clone('));
  check('an out-of-bounds range still throws #2006', body.includes('2006'));
  check('the old range-blind one-liner is gone',
    !/return \(tf != NULL\) \? tf->defaultTextFormat : NULL;/.test(body));
  check('the no-argument form is recognised (`-1` = not supplied)',
    body.includes('beginIndex < 0 && endIndex < 0'));

  // ---- the empty answer really is all-null ----
  // 阶段三百三十五 moved the all-null body into as_tf_fmt_blank (a bare AS3
  // TextFormat is now exactly that), so the pin follows it there: `empty` must
  // delegate to the blank builder and clear `display` on top.
  const blankAt = c.lastIndexOf('static TextFormat* as_tf_fmt_blank(void) {');
  check('as_tf_fmt_blank exists in the generated C', blankAt > 0);
  if (blankAt > 0) {
    const end = c.indexOf('return o;', blankAt);
    const blankBody = c.slice(blankAt, end);
    for (const f of ['size', 'color', 'bold', 'italic', 'underline', 'leading', 'kerning', 'letterSpacing', 'leftMargin', 'rightMargin', 'indent', 'blockIndent', 'bullet', 'tabStops']) {
      check(`the blank TextFormat nulls ${f}`, blankBody.includes(`o->${f} = as_v_null();`));
    }
    for (const f of ['font', 'align', 'url', 'target']) {
      check(`the blank TextFormat leaves ${f} as C NULL`, blankBody.includes(`o->${f} = NULL;`));
    }
  }
  const emptyAt = c.lastIndexOf('static TextFormat* as_tf_fmt_empty(void) {');
  check('as_tf_fmt_empty builds on the blank format', emptyAt > 0 && c.slice(emptyAt, emptyAt + 200).includes('as_tf_fmt_blank()'));

  // ---- the constructor boxes, so a fresh TextFormat reads back numbers ----
  // (Null-preserving boxing: an omitted field must stay null, not become 0.)
  check('TextFormat_ctor boxes its Object fields',
    c.includes('o->size = as_tf_num_or_null(size);') && c.includes('o->bold = as_tf_bool_or_null(bold);'));

  if (ok > 0) console.log(`[getfmt] ${ok} getTextFormat checks passed`);
  return bad;
}
registerGroup('unit: text/getTextFormat', checkGetTextFormat);