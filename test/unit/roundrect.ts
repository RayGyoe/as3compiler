// Unit checks: Graphics.drawRoundRect keeps both radii (阶段二百六十七 · G19).
//
// Why source-level pins here and pixels in an example: examples/roundrect.as can only
// show that THIS build paints corners (and it needs a Skia build to paint anything at
// all). What has to hold for every build is that the emitter never goes back to the
// stub -- the old body was literally
//   `{ (void)ellipseWidth; (void)ellipseHeight; Graphics_drawRect(...); }`
// so the two parameters were consumed and dropped, and the radii never reached the
// path. These checks pin each half of the replacement:
//
//   * the stub is gone and the radii are used;
//   * the ArgumentError/NaN/clamp rules measured on adl 51.4.1 are in the emitted C;
//   * the AS3 default for ellipseHeight is NaN (not 0, which silently meant "square");
//   * the Skia seam gained the primitive on BOTH arms (real + no-op stub), because a
//     program that never draws must still link.
//
// Measured reference: temp/g16g19g20/ab-round.cjs (AIR vs AOT, 9 geometry cases x 40
// rows + the argument matrix); the behavioural matrix is examples/roundrect.as.
//
//   node --test --test-name-pattern='roundrect' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

function mainOf(src: string): string {
  const c = generateC(parse(src)).c;
  return c.slice(c.indexOf('int main('));
}

function checkRoundRect(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [rrect] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [rrect] ${label}`); }
  };

  const emit = readFileSync(join(root, 'src', 'emit.ts'), 'utf8').replace(/\r\n/g, '\n');
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = runtime.indexOf('RUNTIME_PREAMBLE');
  const preamble = start >= 0 ? runtime.slice(start) : runtime;

  // ---- the emitter ----
  const bodyAt = emit.indexOf('void Graphics_drawRoundRect(void* _this');
  const bodyEnd = emit.indexOf('void Graphics_drawCircle', bodyAt);
  const body = bodyAt >= 0 && bodyEnd > bodyAt ? emit.slice(bodyAt, bodyEnd) : '';
  check('Graphics_drawRoundRect is emitted', bodyAt >= 0);
  check('the old stub is gone (no `(void)ew` / no forwarded drawRect call)',
    !body.includes('(void)ew') && !body.includes('(void)eh') && !body.includes('Graphics_drawRect(_this'));
  check('a round rect is a real path primitive (as_skia_path_add_rrect)',
    body.includes('as_skia_path_add_rrect(g->path, x, y, w, h, rx, ry)'));
  check('a radius of 0 falls back to a plain rect path (AIR paints nothing different)',
    body.includes('as_skia_path_add_rect(g->path, x, y, w, h)'));
  check('the radii are half the ellipse WH (AIR: the ellipse IS the corner)',
    body.includes('double rx = ew * 0.5, ry = eh * 0.5;'));
  check('each radius is clamped to half the box (ew=eh=80 on 40x40 -> 20)',
    body.includes('if (rx > w * 0.5) rx = w * 0.5;') && body.includes('if (ry > h * 0.5) ry = h * 0.5;'));
  check('a negative radius becomes 0 (AIR uncovers a rasterizer bulge instead; documented)',
    body.includes('if (rx < 0) rx = 0;') && body.includes('if (ry < 0) ry = 0;'));
  check('ellipseHeight NaN means "use ellipseWidth" (the AS3 default)',
    body.includes('if (isnan(eh)) eh = ew;'));
  check('ellipseWidth NaN is ArgumentError #2004 (measured on adl)',
    body.includes('if (isnan(ew)) { as_throw(ArgumentError_new(') && body.includes(', 2004)'));
  check('a negative w/h is the same box mirrored',
    body.includes('if (w < 0) { x += w; w = -w; }') && body.includes('if (h < 0) { y += h; h = -h; }'));

  // ---- the AS3 default the callers get ----
  const declAt = symbols.indexOf("['drawRoundRect', gpm(");
  const declEnd = symbols.indexOf('])]', declAt);
  const decl = declAt >= 0 && declEnd > declAt ? symbols.slice(declAt, declEnd) : '';
  check("the ellipseHeight default is NaN, not 0 (0 would mean 'square corner')",
    decl.includes("name: 'ellipseHeight'") && decl.includes('value: NaN') && !decl.includes("gnum('ellipseHeight', 0)"));
  const call = mainOf([
    'import flash.display.Shape;',
    'var s:Shape = new Shape();',
    's.graphics.drawRoundRect(0, 0, 40, 40, 12);',
    '',
  ].join('\n'));
  check('the five-argument call passes NAN for ellipseHeight',
    /drawRoundRect\(.*, \(\(double\)\(12\)\), NAN\)/.test(call));

  // ---- the Skia seam: extern + both arms ----
  check('the glue declares sk_path_add_rrect', preamble.includes('extern void sk_path_add_rrect('));
  check('the real-Skia arm forwards it', preamble.includes('sk_path_add_rrect(p, x, y, w, h, rx, ry)'));
  const stubAt = preamble.indexOf('static inline void as_skia_path_add_rrect(void* p, double x, double y, double w, double h, double rx, double ry) { (void)p;');
  check('the no-Skia arm has a matching no-op (a non-drawing program still links)', stubAt > 0);
  check('vendor/skia_glue.cc implements it with SkRRect', glue.includes('addRRect(SkRRect::MakeRectXY(')
    && glue.includes('#include "include/core/SkRRect.h"'));

  if (ok > 0) console.log(`[rrect] ${ok} drawRoundRect checks passed`);
  return bad;
}
registerGroup('unit: graphics/roundrect', checkRoundRect);