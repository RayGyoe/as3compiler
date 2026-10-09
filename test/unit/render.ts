// Unit checks: SVG channel, font metrics, text wrap, borders, color path, filters, Skia ABI.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='render/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { extractSwc, swcCompileInputs, swcBakePlan } from '../../src/swc.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- E1: the opt-in SVG decode channel (+ the GC red line it exposed) ----
//
// SVG cannot be an examples/ unit: it needs a Skia link AND the ASC_USE_SVG
// define, while the example suite runs every entry manifest-free in pure-C mode.
// So this pins the two things a mutation could silently break -- the opt-in
// guard that keeps the default build AIR-isomorphic, and the GC rule that the
// channel's first successful decode exposed.
function checkSvgChannel(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [svg] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [svg] ${label}`); }
  };

  // Assert on what the emitter WRITES OUT, not on the raw file: comments in
  // emit.ts quote both the broken and the fixed form, so a substring search over
  // the source would count documentation as code.
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  // Stage 89-42 put `pixels` on the GC heap. free()ing it corrupts the GC free
  // list (the same rule BitmapData_dispose documents), and it abort()ed on the
  // first successful BitmapData.loadFile over a user-constructed bitmap -- which
  // no regression had ever exercised, because every probe fed loadFile a file
  // that failed to decode and left the adoption branch untaken.
  check('no generated statement free()s BitmapData.pixels (it is a GC buffer)',
    !emitted.includes('free(bd->pixels)'));
  // Every site that adopts pixels onto the GC heap must publish the reference to
  // the incremental-marker write barrier. Counting against the adoption sites
  // themselves (not a hard-coded total) keeps this honest as sites are added —
  // loadFile, loadBytes and the SWC resource path `BitmapData_adoptEncoded`.
  const adoptSites = (emitted.match(/bd->pixels = \(void\*\)gcpx;/g) ?? []).length;
  check('every pixel-adoption site keeps the GC write barrier',
    adoptSites > 0 && (emitted.match(/gc_write_barrier\(bd->pixels\)/g) ?? []).length === adoptSites);

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  // Opt-in is the whole point (AIR has no SVG at all, so per §1.5 the default
  // build must stay byte-for-byte AIR). Split the file on the guards and require
  // that nothing SVG-flavoured survives outside one.
  let rest = glue;
  let guards = 0;
  for (;;) {
    const i = rest.indexOf('#ifdef ASC_USE_SVG');
    if (i < 0) break;
    guards++;
    const j = rest.indexOf('#endif', i);
    if (j < 0) break;
    rest = rest.slice(0, i) + rest.slice(j);
  }
  check('the SVG channel exists and is guarded', guards >= 5 && glue.includes('#endif  // ASC_USE_SVG'));
  // Comments are stripped before the test: the design rationale above the guard
  // legitimately NAMES SkSVGDOM, and a pin that flags prose teaches nothing. A
  // naive suppressor (no string-literal state) can only over-strip, which makes
  // this check weaker -- never falsely failing -- which is the safe direction.
  const uncommented = rest.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  check('no SVG reference escapes its #ifdef ASC_USE_SVG guard',
    !/SkSVGDOM|sk_svg_|SK_SVG_DEFAULT/.test(uncommented));
  // One fallback per decode entry point (file/bytes x SkImage/ARGB), plus the
  // forward declaration and the definition: 6 mentions. Fewer means some caller
  // still reports "unknown type" for an SVG while its sibling decodes it.
  check('every decode entry point tries SVG (file + bytes, both return shapes)',
    (glue.match(/sk_svg_header\(/g) ?? []).length === 6);
  // An SVG document with no absolute width/height has no intrinsic size; the
  // spec's replaced-element default is what we answer with.
  check('the no-intrinsic-size case falls back to the SVG spec default (300x150)',
    glue.includes('#define SK_SVG_DEFAULT_W 300') && glue.includes('#define SK_SVG_DEFAULT_H 150'));
  // Without setFontManager the DOM renders <text> as nothing at all -- measured:
  // 97 glyph pixels with it, 0 without.
  check('the SVGDOM builder gets the platform font manager (else <text> vanishes)',
    glue.includes('setFontManager(sk_platform_fontmgr())'));
  // The sniff runs only AFTER the codec path failed, and only then: trying a
  // parse first would make every "unknown type" payload pay for it.
  check('the SVG sniff runs as a codec fallback, never as a competing decoder',
    (glue.match(/if \(!image && sk_svg_header\(/g) ?? []).length === 4);

  if (ok > 0) console.log(`[svg] ${ok} opt-in SVG channel checks passed`);
  return bad;
}

// ---- ④-A: AIR font metric alignment (Skia-only, so no examples/ unit) ----
//
// The metric surface (textWidth/textHeight/numLines/caret geometry) needs a Skia
// link, which the headless example suite does not have, so this pins the shape of
// the two mechanisms that make our numbers equal adl 51.4.1's, plus the two
// measured AIR quirks they encode. Every constant below was measured, not guessed
// (input matrix + adl output in temp/metricprobe/, model in docs/zh-cn/skia.md).
function checkFontMetrics(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fontmetrics] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fontmetrics] ${label}`); }
  };

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // AIR's three device-font aliases are not font families: passing them through
  // verbatim made CoreText fall back to the system default, so a "_typewriter"
  // field measured 113.26 px per 10 "W" instead of 72 (proportional, not
  // monospace). Each alias must map to the face whose adl advances match.
  check('the three AIR device-font aliases are resolved to real faces',
    glue.includes('strcmp(family, "_typewriter") == 0) return "Monaco"') &&
    glue.includes('strcmp(family, "_sans") == 0) return "Helvetica"') &&
    glue.includes('strcmp(family, "_serif") == 0) return "Times New Roman"') &&
    glue.includes('if (family == nullptr || family[0] == 0) return "Times";'));
  // No unaliased passthrough may survive: SkParagraph must never see "_sans".
  check('no paragraph style is built from an unaliased family name',
    (glue.match(/setFontFamilies\(\{ SkString\(family\) \}\)/g) ?? []).length === 0 &&
    (glue.match(/sk_family_alias\(/g) ?? []).length >= 6);
  // AIR rounds each half of the line box to the nearest 0.5 and drops the font's
  // own line gap (Monaco: 12/3 = 15 where Skia reports 16.002 -> 16). Stage 103
  // split the two halves out as fields (getLineMetrics needs them separately),
  // so the halves are pinned individually and the model is their sum.
  check('the line box uses AIR\'s half-rounded ascent/descent, gap dropped',
    glue.includes('floor(v * 2.0 + 0.5) / 2.0') &&
    glue.includes('out.asc = sk_round_half(-m.fAscent);') &&
    glue.includes('out.desc = sk_round_half(m.fDescent);') &&
    glue.includes('out.model = out.asc + out.desc;'));
  // Skia divides the height override by (ascent+descent+lineGap) but drops the
  // gap from the box, so the factor must be pre-multiplied by rawFull/rawSum --
  // without it every forced line box came out exactly one line gap short
  // (measured: 14 instead of 15 for a 12 px Monaco line).
  check('the strut height is pre-multiplied by the raw metric ratio',
    glue.includes('am.rawFull / (am.rawSum * size)') && /boxHeight \* am\.rawFull/.test(glue));
  // Negative leading: Skia clamps StrutStyle::leading < 0 to 0, so AIR's
  // "leading -3 shrinks the box to 12" case has to go through the height.
  check('negative leading is folded into the height, positive stays a leading',
    glue.includes('(leading < 0.0) ? box : am.model') &&
    glue.includes('if (leading > 0.0) strut.setLeading((SkScalar)(leading / size));') &&
    !glue.includes('strut.setLeading((SkScalar)leading);'));
  // Every paragraph builder installs the strut (flat field, flat field with
  // TextFormat.leading, htmlText runs) -- one miss silently reverts that path to
  // Skia's own line height.
  check('all three paragraph builders install the AIR line box',
    (glue.match(/sk_set_air_strut\(ps,/g) ?? []).length === 3);
  // AIR's field height omits the TRAILING inter-line leading (measured: 19/34/53/
  // 72 for 1..4 lines at a 19 px stride), which is one subtraction in the getter.
  check('textHeight drops the trailing leading for a multi-line field',
    emitted.includes('if (lead != 0.0 && as_skia_textlayout_line_count(para) > 1) h -= lead;'));
  // Perf: the typeface lookup is cached, so a repaint does not re-run CoreText's
  // family scan per paragraph.
  check('the typeface lookup is cached per (family, weight, slant)',
    glue.includes('static std::map<std::string, sk_sp<SkTypeface>> cache;'));

  if (ok > 0) console.log(`[fontmetrics] ${ok} AIR font-metric checks passed`);
  return bad;
}

// ---- ① TextField wordWrap usable width (AIR's 2px inset) ----
//
// Not an examples/ unit for the same reason as SVG: it needs a raster/paragraph
// backend (numLines comes from a real SkParagraph layout), while the suite runs
// every example manifest-free in pure-C mode where the as_skia_* calls are no-ops.
// The measurement lives in temp/tfwrap/ (Main.as = adl probe, tfwrap.as = ours).
function checkTextWrap(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [textwrap] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [textwrap] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  // The wrap threshold must be computed against the inset width. Reverting to the
  // bare width changes an observable: a Verdana-24 line of ink 124.945px stops
  // wrapping at field width 125 instead of AIR's 129 -- one word late, exactly at
  // the boundary, which is what the 12-scenario Starling comparison caught.
  // (阶段九十四·六: TextField 的尺寸搬进私有 _fieldWidth/_fieldHeight —— DisplayObject
  // 的 width/height 变成访问器后，`tf->width` 不再是可读的槽，这里同步改名。)
  check('the wordWrap layout width subtracts AIR\'s 2px inset (width - 4)',
    emitted.includes('w = tf->_fieldWidth - 4.0;'));
  check('the wrap path no longer lays out against the bare field width',
    !emitted.includes("'double w = (tf->wordWrap && tf->_fieldWidth > 0.0) ? tf->_fieldWidth : 0.0;'"));
  // Without the floor a field narrower than its inset goes <= 0, and the glue reads
  // width <= 0 as "no wrapping" (1e9), silently converting wrap to overflow.
  check('a field narrower than its own inset is clamped, not passed through as <= 0',
    emitted.includes('if (w < 1.0) w = 1.0;'));
  if (ok > 0) console.log(`[textwrap] ${ok} wordWrap inset checks passed`);
  return bad;
}

// ---- TextField border: a screen-space 1px line (stage 94.21) ----
//
// AIR keeps a bordered field's outline one *logical* pixel wide however the
// object is scaled (measured with a window pixel scan: 1px per line at
// scaleX=scaleY=2, at scaleX=2/scaleY=1 and at scale 0.5). Drawing a fixed
// 1.0 local unit instead makes the border scale with the object, so the pins
// below guard each of the three things that had to change.
function checkBorderWidth(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [border1px] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [border1px] ${label}`); }
  };

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // The canvas must be able to say how many device units one local unit covers.
  check('the glue exposes the canvas total scale',
    glue.includes('void sk_canvas_total_scale(void* canvas, double* sx, double* sy)') &&
    glue.includes('getTotalMatrix()') && glue.includes('sqrt(a * a + b * b)') &&
    runtime.includes('extern void sk_canvas_total_scale(void* canvas, double* sx, double* sy);'));
  // Thickness = ASC_render_scale / 1 device px, i.e. the old 1.0 local constant
  // must be gone from all four rects.
  check('the border thickness is divided by the effective canvas scale',
    emitted.includes('double btx = ASC_render_scale / bsx, bty = ASC_render_scale / bsy;') &&
    emitted.includes('as_skia_canvas_draw_rect(canvas, 0.0, bh, bw + btx, bty, bd);') &&
    !/as_skia_canvas_draw_rect\(canvas, 0\.0, bh, bw \+ 1\.0, 1\.0, bd\)/.test(emitted));
  // An auto-baked (cacheAsBitmap) object renders into an OFFSCREEN surface whose
  // canvas scale is the bake resolution, while the blit magnifies the image by the
  // object's own scale -- so the bake pass must publish the destination scale or a
  // scaled object's border comes out scale times too thick (measured: 4 device px
  // instead of 2).
  check('the bake pass publishes the destination canvas scale',
    emitted.includes('static double ASC_bake_ctm_x = 0.0;') &&
    emitted.includes('as_skia_canvas_total_scale(canvas, &ASC_bake_ctm_x, &ASC_bake_ctm_y);') &&
    emitted.includes('ASC_bake_ctm_x = keep_bx; ASC_bake_ctm_y = keep_by;') &&
    emitted.includes('double bsx = ASC_bake_ctm_x, bsy = ASC_bake_ctm_y;'));

  if (ok > 0) console.log(`[border1px] ${ok} screen-space border checks passed`);
  return bad;
}

// ---- bake/draw resolution + draw source transform (stage 128) ----
//
// Row 7927 (cacheAsBitmap baked at the device ratio) and row 7928 (the draw
// source rect / border `+1`) were settled by measuring adl 51.4.1 offscreen
// (temp/bakeprobe/BakeProbe.as, 21 lines, native + web end in the same directory):
//   * cacheAsBitmap on vs off is PIXEL-IDENTICAL at every scale (1/2/3 and with a
//     scaled ancestor) -- so the bake must be sized to the destination resolution
//     instead of being magnified by the object's own scale;
//   * `bd.draw(src, matrix)` extent is width*k + 1 with a 1 px outline at every k
//     (matrix scale), i.e. the object is rasterized at the destination resolution
//     and the source rect's `+1` is one BITMAP pixel, not one local unit;
//   * `bd.draw(src, matrix)` IGNORES the source's own transform: a container with
//     scaleX=scaleY=2 draws at 1x (41x21, not 81x41) and with a scale-3 matrix too
//     the result is 121x61 = matrix only (the two do not multiply).
function checkBakeResolution(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [bakeres] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [bakeres] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // (1) The bake surface follows the destination canvas, bounded by two guards.
  check('the bake scale comes from the destination canvas total scale',
    emitted.includes('static double as_bake_scale(void* canvas, int lw, int lh) {') &&
    emitted.includes('as_skia_canvas_total_scale(canvas, &dt_x, &dt_y);') &&
    emitted.includes('double s = dt_x > dt_y ? dt_x : dt_y;') &&
    (emitted.match(/double sc = as_bake_scale\(canvas, /g) ?? []).length === 2 &&
    !emitted.includes('double sc = ASC_render_scale;'));
  check('the bake scale is capped in ratio and in pixels',
    emitted.includes('#define AS_BAKE_MAX_PIXELS 4000000.0') &&
    emitted.includes('double cap = 4.0 * ASC_render_scale; if (cap < 1.0) cap = 1.0;') &&
    emitted.includes('if (s > cap) s = cap;') &&
    emitted.includes('double area = sqrt(AS_BAKE_MAX_PIXELS / ((double)lw * (double)lh));') &&
    emitted.includes('if (s > area) s = area;'));

  // (2) BitmapData.draw rasterizes a DisplayObject source at the matrix's scale
  // and reads the raster back 1:1 (source coords are multiplied by that scale).
  check('the draw raster scale comes from the destination matrix',
    emitted.includes('double rs = 1.0;') &&
    emitted.includes('{ double rsx = sqrt(a * a + b * b), rsy = sqrt(c * c + d * d); rs = rsx > rsy ? rsx : rsy; if (rs < 1.0) rs = 1.0; }') &&
    emitted.includes("double scx = (ia * (dx + 0.5) + ic * (dy + 0.5) + itx) * rs;") &&
    emitted.includes("double scy = (ib * (dx + 0.5) + id * (dy + 0.5) + ity) * rs;"));
  check('both draw raster branches are scaled and the source rect +1 is one bitmap px',
    (emitted.match(/as_skia_canvas_scale\(canvas, rs, rs\);/g) ?? []).length === 2 &&
    emitted.includes("sw = (int)ceil(tf->_fieldWidth * rs) + (tf->border ? 1 : 0); if (sw < 1) sw = 1;") &&
    emitted.includes("sh = (int)ceil(tf->_fieldHeight * rs) + (tf->border ? 1 : 0); if (sh < 1) sh = 1;"));
  check('the raster pass pins ASC_render_scale to one bitmap pixel',
    emitted.includes('static double ASC_render_scale;') &&
    emitted.includes('double keep_render_scale = ASC_render_scale; ASC_render_scale = 1.0;') &&
    (emitted.match(/ASC_render_scale = keep_render_scale;/g) ?? []).length >= 5);

  // (3) The source's own transform is zeroed for the raster and restored after.
  check('draw ignores the source transform',
    emitted.includes('DisplayObject* sdo = (DisplayObject*)source;') &&
    emitted.includes('sdo->x = 0.0; sdo->y = 0.0; sdo->rotation = 0.0; sdo->scaleX = 1.0; sdo->scaleY = 1.0;') &&
    emitted.includes('if (sdo->transform != NULL) sdo->transform->matrix = NULL;') &&
    emitted.includes('as_render_object(canvas, sdo);') &&
    emitted.includes('if (sdo->transform != NULL) sdo->transform->matrix = sx_km;'));

  // (4) The recorded oracle: native and web ends agree with adl line for line.
  const probeDir = join(root, 'temp', 'bakeprobe');
  const adl = readFileSync(join(probeDir, 'adl.txt'), 'utf8').split('\n').filter((l) => l.includes('PROBE|'));
  const nat = readFileSync(join(probeDir, 'aot-native.txt'), 'utf8').split('\n').filter((l) => l.includes('PROBE|'));
  const web = readFileSync(join(probeDir, 'aot-web.txt'), 'utf8').split('\n').filter((l) => l.includes('PROBE|'));
  const same = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((l, i) => l === b[i] || l.startsWith('PROBE|tf '));
  check('the bake probe matches adl on every line but the font metric',
    adl.length === 20 && same(adl, nat) && same(adl, web) &&
    nat.some((l) => l.includes('H1 k=2 cache=on ') && l.includes('pixdiff=0')) &&
    nat.some((l) => l.includes('H1b cont2 cache=off ext=41x21')) &&
    nat.some((l) => l.includes('H1d cont2+mat3 ext=121x61')));

  if (ok > 0) console.log(`[bakeres] ${ok} bake/draw resolution checks passed`);
  return bad;
}

// ---- render color path (stage 94.23) ----
//
// The non-grey colour offsets originally recorded as "our pipeline converts sRGB
// to the display P3" turned out to live in the *capture* path: our offscreen Skia
// raster and the Metal drawable we hand to the compositor are both bit-exact
// (measured, temp/editprobe/app10). Two things must stay in place: the layer's
// sRGB declaration (the values we paint ARE sRGB) and the drawable readback hook
// that proved it.
function checkColorPath(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [colormanage] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [colormanage] ${label}`); }
  };

  const glue = readFileSync(join(root, 'vendor', 'metal_glue.mm'), 'utf8');
  const docs = readFileSync(join(root, 'temp', 'editprobe', 'README.md'), 'utf8');

  check('the CAMetalLayer declares sRGB',
    glue.includes('l.colorspace = cs;') &&
    glue.includes('CGColorSpaceCreateWithName(kCGColorSpaceSRGB)'));
  check('the drawable readback hook is env-gated and reads the current surface',
    glue.includes('#include <cstdlib>') &&
    glue.includes('const char* rb = getenv("ASC_MTL_READBACK");') &&
    /getenv\("ASC_MTL_READBACK"\)[\s\S]{0,900}?m->surface->readPixels\(/.test(glue));
  // The comparison tooling must keep its tolerance for capture-path colour drift,
  // and the evidence table for the four measured stages must stay documented.
  check('the capture-path finding is documented with its four stages',
    docs.includes('ASC_MTL_READBACK') && docs.includes('ff00ff00') &&
    docs.includes('FF7700') && docs.includes('offscreen_cpu.txt'));

  if (ok > 0) console.log(`[colormanage] ${ok} render-color checks passed`);
  return bad;
}

// ---- filter rasterization model (stage 95.7) ----
//
// The SWC bake installs PlaceObject3 filters on baked children, so the render
// path's filter model is now load-bearing for real content. Two things were
// measurably wrong against adl (temp/filterprobe, black 40x40 rect drawn into a
// transparent bitmap, alpha sampled left of the edge, AIR-side numbers):
//   * `strength` was ignored outright. AIR scales the imprint AFTER the blur, with
//     no clamp at 1: GlowFilter strength 1/2 -> 21/42 and DropShadowFilter
//     0.5/2 -> 27/110 (linear), and GlowFilter(alpha 0.5, strength 2) renders
//     exactly like strength 1. Scaling before the blur saturates the opaque
//     silhouette and changes nothing.
//   * the blur was approximated as a wide Gaussian (sigma = blurX/3). AIR applies a
//     BOX blur of diameter blurX, `quality` times, so for quality 1 nothing at all
//     is painted beyond blurX/2 (measured: zero at 4..13px for BlurFilter(6,6,1)),
//     while a box of diameter b has variance b^2/12 — hence the variance-matched
//     sigma = blurX*sqrt(quality)/sqrt(12). Both regressions are pinned below as
//     generated-C shape and glue-text nails (pixel equality with adl is asserted by
//     the harness in temp/filterprobe, and by temp/swc-render for baked content).
function checkFilterRaster(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [filterraster] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [filterraster] ${label}`); }
  };

  const src = [
    'import flash.display.Sprite;',
    'import flash.filters.*;',
    'var s:Sprite = new Sprite();',
    's.filters = [new BlurFilter(6, 6, 2), new GlowFilter(0, 1, 6, 6, 0.2, 1, false, false), new DropShadowFilter(4, 45, 0, 1, 6, 6, 0.5, 1, false, false, false)];',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;
  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');

  check('the blur/blow-up sigma helper is variance-matched to AIR\'s box blur',
    c.includes('static double as_filter_sigma(double blur, int quality)') &&
    c.includes('return blur * sqrt(q) / 3.4641016151377544;'));
  check('every blur call goes through the helper (no blurX/3 left)',
    c.includes('as_skia_paint_set_blur(p, as_filter_sigma(bf->blurX, bf->quality), as_filter_sigma(bf->blurY, bf->quality));') &&
    !c.includes('bf->blurX / 3.0'));
  check('glow and drop shadow pass strength through to the rasterizer',
    c.includes('as_skia_paint_set_glow(p, as_filter_sigma(gf->blurX, gf->quality), as_filter_sigma(gf->blurY, gf->quality), gf->color, gf->alpha, gf->strength);') &&
    c.includes('as_skia_paint_set_drop_shadow(p, ddx, ddy, as_filter_sigma(ds->blurX, ds->quality), as_filter_sigma(ds->blurY, ds->quality), ds->color, ds->alpha, ds->strength, drawSource);'));
  // Skia's DropShadow already composites the SOURCE, so its output must never carry the
  // strength scale (measured: a 425x124 bar washed to alpha 137/255 == strength 0.539).
  // The glue therefore has a source-free regime (strength baked into the shadow colour)
  // and picks per call, and the emitted C only repaints the source when the glue did not.
  check('the drop shadow takes the two exact regimes instead of scaling its whole output',
    c.includes('int drawSource = !ds->_shadow_only;') &&
    c.includes('if (drawSource && ds->alpha * ds->strength > 1.0) as_render_filtered(canvas, o, filters, idx - 1);'));
  check('the glue picks DropShadowOnly + post-blur strength only when the source is excluded',
    /if \(drawSource != 0 && alpha \* strength <= 1\.0\) \{/.test(glue) &&
    glue.includes('SkImageFilters::DropShadowOnly(') &&
    glue.includes('sk_argb(rgb, alpha * strength), nullptr)') &&
    glue.includes('f = sk_alpha_scale_after((float)strength, std::move(f));'));
  check('the strength scale is composed AFTER the blur in the glue',
    glue.includes('f = sk_alpha_scale_after((float)strength, std::move(f));') &&
    glue.includes('blur = sk_alpha_scale_after((float)strength, std::move(blur));') &&
    /sk_alpha_scale_after\(float strength, sk_sp<SkImageFilter> inner\)/.test(glue) &&
    glue.includes('SkImageFilters::ColorFilter(SkColorFilters::Matrix(m), std::move(inner))'));
  check('the runtime exposes the strength parameter on both wrappers',
    preamble.includes('as_skia_paint_set_glow(void* p, double sx, double sy, unsigned rgb, double a, double st)') &&
    preamble.includes('as_skia_paint_set_drop_shadow(void* p, double dx, double dy, double sx, double sy, unsigned rgb, double a, double st, int drawSource)'));
  // The SWC runtime-only flag must exist on both filter structs and default off for AS3,
  // because a glow has no AS3 field able to carry the SWC CompositeSource bit.
  check('the C-runtime-only _shadow_only flag exists on both filter structs',
    c.includes('bool _shadow_only;') &&
    c.includes('DropShadowFilter* o, double distance, double angle, unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout, bool hideObject) { BitmapFilter_ctor((BitmapFilter*)o); o->_shadow_only = hideObject;') &&
    c.includes('GlowFilter* o, unsigned color, double alpha, double blurX, double blurY, double strength, int quality, bool inner, bool knockout) { BitmapFilter_ctor((BitmapFilter*)o); o->_shadow_only = false;'));
  check('the adl-measured filter numbers stay documented where they were measured',
    c.includes('temp/filterprobe') || glue.includes('temp/filterprobe'));

  if (ok > 0) console.log(`[filterraster] ${ok} filter-model checks passed`);
  return bad;
}

// ---- SWC baked timelines (阶段九十五·九) ----
//
// The timeline of a multi-frame SWF sprite is baked at compile time (keyframe
// deltas into `as_swc_tl_*` tables) so the AS3 MovieClip API answers what adl
// answers. What a mutation could silently break, and what is pinned here:
//   · a RemoveObject2 record must survive parsing (it used to be dropped, which
//     made "delete depth 2 + place at depth 3" look like a pure add -- adl says 3
//     children for toastbtn frame 2, we said 4);
//   · a label name must be emitted as a plain C string literal, not as the
//     UTF-16 byte escapes the embedded-resource encoder produces (that bug made
//     every FrameLabel.name read empty while currentLabels.length stayed right);
//   · a baked sprite must be instantiated as a MovieClip and started on its
//     timeline, and `as_swc_bind` must exist even with no bake at all (without
//     the stub the no-SWC build fails to LINK);
//   · a clip must start on frame 1 stopped (adl: a fresh skin symbol never
//     advances) -- `_playing`, not the old public `playing` field.
// The sample SWC is the same fixture every swc.md §9 measurement uses; without it
// this group reports a skip instead of failing.
function checkSwcTimeline(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [swctimeline] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [swctimeline] ${label}`); }
  };
  const swcPath = join(root, '..', 'temp', 'skin.swc');
  if (!existsSync(swcPath)) {
    console.log('SKIP  [swctimeline] sample SWC temp/skin.swc not present');
    return bad;
  }
  const lib = extractSwc(swcPath);
  const inputs = swcCompileInputs(lib);
  const bake = swcBakePlan(lib, inputs.specs, inputs.chars);
  const byId = new Map(bake.characters.map((c) => [c.id, c]));

  const dsi = byId.get(426); // desktopshareitem: the rollover skins' home symbol
  const cb = byId.get(154);  // checkbom: a frame-2 replace + a frame-2 modify
  const tb = byId.get(634);  // toastbtn: a frame-2 RemoveObject2 + a re-place
  check('FrameLabel records become the bake\'s label table in SWF frame order',
    (dsi?.labels ?? []).map((l) => `${l.name}@${l.frame}`).join(',') === '_up@1,_over@8,_down@15');
  const cbOps = cb?.frames?.[0]?.ops ?? [];
  check('a frame-2 modify inherits the transform it omits and a replace inherits the placement',
    cbOps.some((o) => o.depth === 2 && o.charId === 152 && o.replace === true && o.matrix?.join(',') === '1,0,0,1,0,0'));
  // The frame-2 label sits at SWF x=200 twips (10 px) + the text RECT origin (-2)
  // == x 8 in adl, and the text origin must be applied to a MODIFY record too.
  check('a frame-2 place at depth 3 carries 200 twips + the text origin as x=10-2=8',
    cbOps.some((o) => o.depth === 3 && o.charId === 153 && o.matrix?.join(',') === '1,0,0,1,10,3'));
  // toastbtn frame 2 = RemoveObject2(depth 2) + place #633 at depth 3: adl keeps 3
  // children (depths 1, 3, 4) with the artwork swapped, so BOTH halves are the pin.
  check('the frame-2 RemoveObject2 is parsed and the re-place is a fresh object',
    tb?.totalFrames === 2 &&
    (tb?.frames?.[0]?.ops ?? []).some((o) => o.depth === 2 && o.del === true) &&
    (tb?.frames?.[0]?.ops ?? []).some((o) => o.depth === 3 && o.charId === 633 && !o.replace));

  const prog = parse('import flash.display.MovieClip;\nvar m:MovieClip = new (getDefinitionByName("desktopshareitem") as Class)() as MovieClip;\n');
  prog.body.push(...inputs.decls);
  const c = generateC(prog, [], inputs.specs, bake).c;
  check('label names are plain C string literals, not UTF-16 byte escapes',
    c.includes('case 1: return "_over";') && !c.includes('\\x0_'));
  check('the label lookups are emitted as strcmp tables and a frame->name switch',
    c.includes('if (strcmp(name, "_down") == 0) return 15;') && c.includes('case 15: return "_down";'));
  check('a baked multi-frame sprite is instantiated as a MovieClip and started on its timeline',
    c.includes('MovieClip_new()') && /as_swc_tl_start\(s, \d+\);/.test(c) && c.includes('as_swc_tl_start((MovieClip*)o, '));
  check('currentLabels builds FrameLabel objects from the baked tables',
    c.includes('FrameLabel_new((char*)as_swc_tl_labelat(o->_tl_char, i), as_swc_tl_frameat(o->_tl_char, i))'));
  check('isPlaying is the property (the old public `playing` field is gone)',
    c.includes('bool MovieClip_get_isPlaying(void* _this)') && c.includes('o->_playing = false;'));
  // The MovieClip runtime calls as_swc_bind long before the bake defines it, and a
  // build with NO swc has no bake to define it: the stub is what keeps it linking.
  const plain = generateC(parse('import flash.display.MovieClip;\nvar m:MovieClip = new MovieClip();\nm.gotoAndStop(2);\n')).c;
  check('as_swc_bind is stubbed when there is no bake at all (else the link fails)',
    plain.includes('void as_swc_bind(DisplayObject* o, int charId) { (void)o; (void)charId; }'));
  // The other direction: a bake whose characters have no multi-frame timeline still
  // gets its as_swc_bind from the bake, and the timeline helpers must be STUBS --
  // emitting both a prototype set and the bake's definitions would be a duplicate
  // symbol, emitting neither would leave the MovieClip runtime with no definition.
  const stubBake = { characters: [], bitmaps: [], classOf: new Map(), chars: [], notes: [], unsupported: [] } as unknown as typeof bake;
  const noTl = generateC(parse('import flash.display.MovieClip;\nvar m:MovieClip = new MovieClip();\nm.gotoAndStop(2);\n'), [], [], stubBake).c;
  check('a bake with no multi-frame sprite defines as_swc_bind exactly once',
    (noTl.match(/void as_swc_bind\(DisplayObject\* o, int charId\) \{/g) ?? []).length === 1 &&
    noTl.includes('static void as_swc_tl_apply(int charId, DisplayObject* o, int frame) { (void)charId; (void)o; (void)frame; }'));

  if (ok > 0) console.log(`[swctimeline] ${ok} timeline-bake checks passed`);
  return bad;
}

// ---- web builds whose text has no font (阶段八十九·五十七) ----
// A browser sandbox has NO system fonts: the page injects the bytes and Skia
// builds its font manager from them, so with nothing injected every TextField
// draws its background and none of its glyphs. That is SILENT -- the build
// succeeds and the page runs -- and it is web-only (native/adl enumerate the
// installed families through CoreText), which is exactly the shape the user hit:
// `air-starling-demo` previewed fine because it ships assets/fonts/Ubuntu-R.ttf,
// while `url-test` shipped no font at all and showed empty boxes. Pinned on the
// adapter's own report (prepareAirApp.warnings + the manifest it writes), since
// what matters is the diagnosis the user gets, not the code shape. Fixtures live
// under temp/ for the same reason as the transport ones: a descriptor + src/ is
// an *input to the adapter*, not an AS3 program.
function checkAirAppFonts(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [air-app-font] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [air-app-font] ${label}`); }
  };
  const base = join(root, 'temp', 'air-app-font');
  const vendorAbs = resolve(root, 'vendor');

  // A fixture app that draws text (flash.text is the marker), optionally shipping
  // a font. The "font" is arbitrary bytes: findAppFonts matches by extension and
  // nothing in the manifest path opens the file, so the bytes never matter.
  const fixture = (name: string, body: string, shipFont: boolean, fontName = 'Fixture.ttf'): string => {
    const d = join(base, name);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, `${name}-app.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
      `  <id>com.example.${name}</id>\n  <filename>${name}</filename>\n` +
      `  <initialWindow><content>main.swf</content><visible>true</visible>` +
      `<width>400</width><height>400</height></initialWindow>\n</application>\n`);
    writeFileSync(join(d, 'src', 'Main.as'),
      `package {\n  import flash.display.Sprite;\n${body}\n}\n`);
    if (shipFont) {
      mkdirSync(join(d, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(d, 'assets', 'fonts', fontName), 'not-a-real-font');
    }
    return join(d, `${name}-app.xml`);
  };

  const textBody =
    '  import flash.text.TextField;\n' +
    '  public class Main extends Sprite {\n' +
    '    public function Main() { var t:TextField = new TextField(); t.text = "hi"; addChild(t); }\n  }';
  const plainBody =
    '  import flash.display.Bitmap;\n' +
    '  public class Main extends Sprite {\n' +
    '    public function Main() { addChild(new Bitmap()); }\n  }';

  const prep = (appXml: string, web: boolean) => prepareAirApp(appXml, 'Main', vendorAbs, web);
  const warningsText = (w: string[]): string => w.join('\n');

  // (1) The defect: text on web, no font anywhere in the app.
  const noFont = prep(fixture('text-nofont', textBody, false), true);
  const noFontManifest = JSON.parse(readFileSync(noFont.manifestPath, 'utf8')) as Record<string, unknown>;
  check('a text-drawing web app with no font resolves no font',
    ((noFontManifest['font-urls'] as string[]) ?? []).length === 0);
  check('...and is told its TextFields will render blank',
    /render blank/.test(warningsText(noFont.warnings)));
  check('...and is told the two ways to fix it',
    /\.ttf/.test(warningsText(noFont.warnings)) && /embedFonts/.test(warningsText(noFont.warnings)));

  // (2) The fix: the same app shipping one font. Reverse control for (1) -- if the
  // detector or the empty-list test were wrong this would keep warning.
  const withFont = prep(fixture('text-font', textBody, true), true);
  const withFontManifest = JSON.parse(readFileSync(withFont.manifestPath, 'utf8')) as Record<string, unknown>;
  check('shipping a font is picked up automatically (no descriptor edit)',
    ((withFontManifest['font-urls'] as string[]) ?? []).some((u) => u.endsWith('Fixture.ttf')));
  check('a web app that ships a font is not warned about', withFont.warnings.length === 0);
  // ...and that font must not also be packed into the FS image: the page fetches
  // it over HTTP and injects the bytes into Skia, so the preloaded copy is never
  // read and would ship the file twice. The generator names exactly the fonts it
  // also lists as font-urls, and nothing else (a bitmap `.fnt` + atlas that the
  // app opens through File is not a font-url and must stay).
  const withFontExcludes = (withFontManifest['preload-excludes'] as string[]) ?? [];
  const withFontUrls = (withFontManifest['font-urls'] as string[]) ?? [];
  check('the font the page fetches is excluded from the preload set',
    withFontExcludes.length === withFontUrls.length &&
    withFontUrls.every((u) => withFontExcludes.includes(u)) &&
    withFontExcludes.every((e) => e.endsWith('Fixture.ttf')));
  check('...and the rest of the app tree is still preloaded',
    ((withFontManifest['preload-paths'] as string[]) ?? []).includes('assets'));
  check('a native build excludes nothing (it reads the real directory)',
    ((JSON.parse(readFileSync(prep(fixture('text-font', textBody, true), false).manifestPath, 'utf8')) as Record<string, unknown>)['preload-excludes']) === undefined);

  // (2b) `--exclude-file` is an fnmatch pattern, so a path that itself contains a
  // metacharacter must be escaped or it silently mis-targets: passed verbatim,
  // `My[bold].ttf` is a character class that excludes a sibling `Myb.ttf` while
  // sparing the file it names (measured against emcc 3.1.44).
  const meta = JSON.parse(readFileSync(prep(fixture('text-font-meta', textBody, true, 'My[bold].ttf'), true).manifestPath, 'utf8')) as Record<string, unknown>;
  check('a metacharacter in a font name is escaped for fnmatch',
    ((meta['preload-excludes'] as string[]) ?? [])[0] === 'assets/fonts/My[[]bold[]].ttf');

  // (3) Native is immune: CoreText enumerates the installed families, so the same
  // no-font app must NOT be warned about there (the check is web-only).
  check('the same app built for native is not warned about',
    prep(fixture('text-nofont', textBody, false), false).warnings.length === 0);

  // (4) The detector stays scoped: an app that never imports flash.text is silent
  // even with no font, so the warning still means something when it appears.
  check('an app that draws no text is not warned about',
    prep(fixture('plain-web', plainBody, false), true).warnings.length === 0);

  if (ok > 0) console.log(`[air-app-font] ${ok} font checks passed`);
  return bad;
}

// ---- the vendored Skia headers must describe the same objects as libskia.a ----
// vendor/skia is a PREBUILT Skia plus a copy of the headers it was compiled from,
// and the two drifted apart: vendor/skia/include carried an older m124 revision of
// GrBackendSurface.h whose kMaxSubclassSize was 160 where the built library used
// 176. Each stack-allocated GrBackendRenderTarget was therefore 16 bytes smaller
// than the library believed, so the library's constructor wrote past the end of our
// object and smashed the neighbouring stack slots -- the event loop's callee-saved
// x28 among them. That segfaulted the -O2 air-native demo ~1s after launch (and
// only at -O2, and never at -O0, and any perturbation moved the frame layout and
// hid it). Sharing a milestone is not enough: the layouts have to match, so pin the
// sizes and, when the tree that built the library is checked out beside us, pin the
// two copies against each other.
function checkSkiaAbi(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [skia-abi] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [skia-abi] ${label}`); }
  };
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  const surfacePath = join(root, 'vendor', 'skia', 'include', 'gpu', 'GrBackendSurface.h');
  const vulkanPath = join(root, 'vendor', 'skia', 'include', 'gpu', 'vk', 'VulkanTypes.h');
  const surface = readFileSync(surfacePath, 'utf8');
  const vulkan = readFileSync(vulkanPath, 'utf8');

  check('the vendored GrBackendSurface.h sizes the backend objects the way the built library does',
    surface.includes('kMaxSubclassSize = 80;') && count(surface, 'kMaxSubclassSize = 176;') === 2);
  check('...and the Vulkan backend info carries the field that layout implies',
    vulkan.includes('fComponents'));

  const srcInclude = resolve(root, '..', 'build-tools', 'skia-src', 'include');
  if (existsSync(join(srcInclude, 'gpu', 'GrBackendSurface.h'))) {
    check('the vendored Skia headers match the tree that built the library, field for field',
      readFileSync(join(srcInclude, 'gpu', 'GrBackendSurface.h'), 'utf8') === surface &&
      readFileSync(join(srcInclude, 'gpu', 'vk', 'VulkanTypes.h'), 'utf8') === vulkan);
  } else {
    console.log('SKIP  [skia-abi] build-tools/skia-src is not checked out beside us; sizes pinned literally');
  }

  console.log(`[skia-abi] ${ok} Skia ABI checks passed`);
  return bad;
}

registerGroup('unit: render/SvgChannel', checkSvgChannel);
registerGroup('unit: render/FontMetrics', checkFontMetrics);
registerGroup('unit: render/TextWrap', checkTextWrap);
registerGroup('unit: render/BorderWidth', checkBorderWidth);
registerGroup('unit: render/BakeResolution', checkBakeResolution);
registerGroup('unit: render/ColorPath', checkColorPath);
registerGroup('unit: render/FilterRaster', checkFilterRaster);
registerGroup('unit: render/SwcTimeline', checkSwcTimeline);
registerGroup('unit: render/AirAppFonts', checkAirAppFonts);
registerGroup('unit: render/SkiaAbi', checkSkiaAbi);
