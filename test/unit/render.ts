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
import type { SwcLibrary } from '../../src/swc.ts';
import { deflateSync } from 'node:zlib';
import { readGlue } from '../harness.ts';

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

  const glue = readGlue();
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

  const glue = readGlue();
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
    glue.includes('am.rawFull / (am.rawSum * size)') && /strut\.setHeight\(\(SkScalar\)\(box \* am\.rawFull/.test(glue));
  // AIR's box is ascent + descent + leading with an ascent/descent split that
  // ignores the leading, and Skia has no usable leading knob here: StrutStyle's
  // leading never reaches the line box (measured -- a leading of 4 left a 2-line
  // paragraph at 2*model) and a negative one is clamped to 0 outright, so BOTH
  // signs go through the height and sk_textlayout_line_box scales the split back.
  check('leading, either sign, is folded into the strut height',
    glue.includes('strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));') &&
    !glue.includes('strut.setLeading(') &&
    glue.includes('const double model = lh - leading;'));
  // Both run-free paragraph builders install the strut (flat field, flat field
  // with TextFormat.leading) -- the rich-text builder cannot: it must give EACH
  // run its own AIR box (TextStyle::heightOverride) because a strut would force
  // one box on every line (measured on adl: a 12 px default with a 24 px run gives
  // 13.975/27.950, and the gap line must follow defaultTextFormat). One miss
  // silently reverts that path to Skia's own line height.
  check('the two run-free paragraph builders install the AIR strut',
    (glue.match(/sk_set_air_strut\(ps,/g) ?? []).length === 2);
  check('the rich-text builder uses a per-run AIR box instead of the strut',
    glue.includes('sk_set_air_run_height(ts, r.family, r.size, r.bold, r.italic, r.leading);') &&
    glue.includes('ts.setHeightOverride(true);') &&
    !/sk_textlayout_new_runs[\s\S]{0,2400}?sk_set_air_strut/.test(glue));
  // AIR's field height omits the TRAILING inter-line leading (measured: 19/34/53/
  // 72 for 1..4 lines at a 19 px stride), which is one subtraction in the getter.
  // 阶段三百三十七: the leading subtracted is the LAST COUNTED line's own (a stylesheet
  // rule's `leading` lives on the run, not on defaultTextFormat), and trailing EMPTY
  // lines are stepped over first (adl: two 18 px rule lines are 30 tall, not 36).
  check('textHeight drops the trailing leading for a multi-line field',
    emitted.includes('if (lead != 0.0 && k > 1) h -= lead;')
    && emitted.includes('TextFormat* hf = as_tf_fmt_at(tf, starts[k - 1]);')
    && emitted.includes('while (k > 1 && as_tf_line_end(et, starts, n, k - 1, elen) <= starts[k - 1]) k--;'));
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

  const glue = readGlue();
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
  const runtimeSource = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [bakeres] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [bakeres] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // (1) The bake surface follows the destination canvas -- but PER AXIS, and it is
  // blitted back 1:1 in device pixels. A single shared scale (max of the two axes)
  // is what the TalkMED account page exposed: whenever the destination scaled x and
  // y differently, the blit rect stayed logical-sized while the surface had been
  // sized with the max, so the whole image was re-scaled by ctx/sc -- an error that
  // grows with the distance from the bake origin (left edge still, right edge
  // drifting) and compounds through nested bakes (measured: the caret in the
  // account field jumped ~2 px). s * lw must therefore equal the surface width in
  // device pixels.
  check('the bake scale is per axis with one shared degrade factor',
    emitted.includes('static void as_bake_scale2(void* canvas, int lw, int lh, double* sx, double* sy) {') &&
    emitted.includes('as_skia_canvas_total_scale(canvas, &dt_x, &dt_y);') &&
    emitted.includes('double f = 1.0;') &&
    emitted.includes('*sx = dt_x * f; *sy = dt_y * f;') &&
    (emitted.match(/as_bake_scale2\(canvas, /g) ?? []).length === 1 &&
    !emitted.includes('double sc = ASC_render_scale;'));
  check('the bake blits back 1:1 in device pixels',
    // The sampler is derived, not fixed: 0 while the surface really is at the
    // destination scale (nearest is then identical to linear and the pixel-identity
    // invariant holds), 1 when as_bake_scale2's clamps left the blit as a
    // minification (nearest aliases a photograph there -- see the note in
    // as_render_cached).
    emitted.includes('double bl_bx = 1.0, bl_by = 1.0; as_skia_canvas_total_scale(canvas, &bl_bx, &bl_by);') &&
    emitted.includes('int bl_smooth = (fabs(bl_bx - sx) > 0.001 || fabs(bl_by - sy) > 0.001) ? 1 : 0;') &&
    emitted.includes('as_skia_canvas_draw_image_rect(canvas, o->_cache_image, bxo, byo, (double)pw / sx, (double)ph / sy, bl_smooth);') &&
    emitted.includes('as_skia_canvas_scale(c2, sx, sy);') &&
    // as_bake_scale (max-of-axes) survives for the ONLY caller whose rect is
    // computed in logical units by itself: the 9-slice path.
    (emitted.match(/double sc = as_bake_scale\(canvas, /g) ?? []).length === 1);
  // (1b) The bake's ORIGIN is snapped down to the destination canvas' DEVICE pixel
  // grid. The blit is a whole-image drawImageRect under the default sampling options
  // (nearest), so a surface anchored on a half device pixel has the entire image
  // rounded to an integer pixel while its content was rasterized against the
  // unrounded origin: the bake then lands up to one device pixel away from the live
  // rendering of the same subtree. Because a fingerprint change drops the bake for
  // ASC_AUTO_BAKE_FRAMES frames, every roll-over/press/edit popped the content by
  // that pixel and popped it back -- measured on the host app's home card
  // (temp/hover/, window-layer capture): the roll-over rendered the card's title band
  // as an exact 1 px translation of itself (residual 0.00 at (dx,dy)=(1,1)) for
  // exactly 3 frames, and with ASC_NO_AUTO_BAKE=1 the same sweep showed no offset at
  // all. On the grid the blit is a 1:1 copy with nothing left to round.
  //
  // The grid is the CANVAS' device grid, which is not the same thing as the object's
  // own coordinates: floor(bl*tx)/tx (the shape this pin used to assert) puts bl*tx on
  // an integer, and the surface then lands on device tx*bxo + otx, i.e. an integer
  // only when the canvas' own device translation otx is one. That holds at the top
  // level and fails for every bake nested in another bake or under a fractional
  // parent -- which at a 1.5 device scale is most of a real UI (the 41-page gallery
  // demo: 315 baked objects, 47 of them at a fractional device translation, 41 of
  // those at ~.5, i.e. blitted a whole device pixel off the live rendering). The snap
  // therefore folds otx in, so the invariant is about where the surface lands rather
  // than about where the object thinks it is.
  check('the bake origin is snapped to the destination device pixel grid',
    emitted.includes('double bxo = bl, byo = bt, bpx = 0.0, bpy = 0.0;') &&
    emitted.includes('as_skia_canvas_total_translate(canvas, &otx, &oty);') &&
    emitted.includes('bxo = (floor(gx) - otx) / tx; byo = (floor(gy) - oty) / ty;') &&
    emitted.includes('int lw = (int)ceil(bw); int lh = (int)ceil(bh);') &&
    // the snapped origin feeds BOTH the surface transform and the blit rect (same
    // call site, so the two can never drift apart again)
    emitted.includes("as_skia_canvas_scale(c2, sx, sy);\nas_skia_canvas_translate(c2, -bxo, -byo);") &&
    !emitted.includes('as_skia_canvas_draw_image_rect(canvas, o->_cache_image, bl, bt,'));
  // (1b-2) A bake is only reusable on the canvas phase it was baked for. The snap puts
  // the surface origin on an integer device pixel of THAT canvas, so the image is
  // grid-aligned to it and to no other: a canvas whose translation has a different
  // fraction (BitmapData.draw zeroes the source transform, a second window, a filter
  // pass) would blit the image a fraction of a pixel off. Measured with this pin's
  // own example (autobake-origin.as, container at x=20.4): baked on the stage (phase
  // .9) and then drawn into the 160x80 BitmapData (phase .5) the anti-aliased circles
  // gained 9 pixels (333 -> 342) -- the phase is part of the cache key, and a miss
  // paints LIVE, which is what the cache promises to be indistinguishable from.
  check('a bake is only reused on the device phase it was baked for',
    emitted.includes('double gx = bl * tx + otx, gy = bt * ty + oty;') &&
    emitted.includes('bpx = gx - floor(gx); bpy = gy - floor(gy);') &&
    emitted.includes('if (o->_cache_valid && o->_cache_image != NULL && (fabs(o->_cache_phx - bpx) > 0.001 || fabs(o->_cache_phy - bpy) > 0.001)) { as_render_live(canvas, o); return; }') &&
    emitted.includes('o->_cache_phx = bpx; o->_cache_phy = bpy;') &&
    // the guard runs BEFORE the rebuild branch, so a mis-phased hit re-bakes nothing
    emitted.indexOf('else { as_render_live(canvas, o); return; }') < 0 &&
    emitted.indexOf('o->_cache_phx = bpx') > emitted.indexOf('fabs(o->_cache_phx - bpx)') &&
    // the fields exist in every subclass (inheritance-flattened) and start at 0
    emitSource.includes("this.line('double _cache_phx;');") &&
    emitSource.includes('o->_cache_w = 0.0; o->_cache_h = 0.0; o->_cache_phx = 0.0; o->_cache_phy = 0.0;'));
  // (1d) The surface covers the whole DRAWN extent, stroke included. A stroke is
  // centred on its path, so a surface sized to the path bounds clips half of a 1px
  // line -- cached then renders with a thinner border than live (0.5 local units
  // per side). as_paint_bound is the one place that widens a bake/filter box by
  // _max_sw/2; a baked SWC shape keeps its declared ShapeBounds (g->_clip).
  check('the bake surface covers the stroke, not just the path',
    emitted.includes('static int as_paint_bound(DisplayObject* o, double* l, double* t, double* r, double* b) {') &&
    emitted.includes('if (!g->_clip && g->_max_sw > 0.0) { double half = g->_max_sw * 0.5; *l -= half; *t -= half; *r += half; *b += half; }') &&
    // both call sites that feed a bake/filter box: Shape, and a Sprite/MovieClip's
    // own graphics inside a container's union
    emitted.includes('if (as_is(o, &Shape_vt) || as_is(o, &MorphShape_vt) || as_is(o, &StaticText_vt)) return as_paint_bound(o, l, t, r, b);') &&
    emitted.includes('if (as_paint_bound(o, l, t, r, b)) found = 1;') &&
    !emitted.includes('if (as_is(o, &Shape_vt)) return as_graphics_bound(o, l, t, r, b);') &&
    !emitted.includes('if (as_graphics_bound(o, l, t, r, b)) found = 1;'));
  // (1e) The snap needs the canvas' device translation, i.e. a second CTM read next
  // to sk_canvas_total_scale: declared for the Skia build, stubbed to 0 for a pure-C
  // one (where the snap cannot round anyway, so identity is the honest answer).
  check('the CTM translate read exists in every build',
    runtimeSource.includes('extern void sk_canvas_total_translate(void* canvas, double* tx, double* ty);') &&
    runtimeSource.includes('static inline void as_skia_canvas_total_translate(void* c, double* tx, double* ty) { sk_canvas_total_translate(c, tx, ty); }') &&
    runtimeSource.includes('static inline void as_skia_canvas_total_translate(void* c, double* tx, double* ty) { (void)c; if (tx != NULL) *tx = 0.0; if (ty != NULL) *ty = 0.0; }') &&
    readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8').includes('void sk_canvas_total_translate(void* canvas, double* tx, double* ty) {'));
  check('the bake scale is capped in ratio and in pixels',
    emitted.includes('#define AS_BAKE_MAX_PIXELS 4000000.0') &&
    (emitted.match(/double cap = 4\.0 \* ASC_render_scale; if \(cap < 1\.0\) cap = 1\.0;/g) ?? []).length === 2 &&
    emitted.includes('if (s > cap) s = cap;') &&
    emitted.includes('if (s > area) s = area;') &&
    emitted.includes('if (dt_x > cap) f = cap / dt_x;') &&
    emitted.includes('if (dt_y * f > cap) f = cap / dt_y;') &&
    emitted.includes('double area = sqrt(AS_BAKE_MAX_PIXELS / ((double)lw * (double)lh));') &&
    emitted.includes('if (area > AS_BAKE_MAX_PIXELS) f *= sqrt(AS_BAKE_MAX_PIXELS / area);'));
  check('automatic snapshots default to the measured 1M-pixel memory/GPU balance',
    emitted.includes('static double ASC_auto_bake_cap = 1000000.0;')
    && emitted.includes('getenv("ASC_AUTO_BAKE_MAX_PIXELS")'));
  check('the automatic cap paints large subtrees live but never overrides cacheAsBitmap',
    emitted.includes('o->_auto_baked && !o->_cache_flag && ASC_auto_bake_cap > 0.0 && (double)pw * (double)ph > ASC_auto_bake_cap')
    && emitted.includes('ASC_auto_bake_cap) { as_render_live(canvas, o); return; }'));
  // (1c) When either cap had to shrink the surface, an AUTO-bake is skipped
  // entirely and the object renders live at the exact device resolution. A
  // magnified bake is strictly softer than live rendering, and because a
  // content change drops the bake for ASC_AUTO_BAKE_FRAMES frames the object
  // flipped between soft and sharp at the change rate (the meeting client's
  // "clear, then blurry, then clear again": container at ctx 2.76562 capped to
  // sx 2.08333, i.e. a 1.33x magnified blit, next to a 10 fps BitmapData.draw
  // pass that re-baked the same pointers at ctx 0.78431). An explicit
  // cacheAsBitmap keeps the degraded fallback -- that cache is what the author
  // asked for, and AIR's own cache is a fixed-resolution bitmap too.
  check('an auto-bake the caps had to shrink falls back to the live path',
    emitted.includes('if (o->_auto_baked && !o->_cache_flag) {') &&
    emitted.includes('double bdt_x = 0.0, bdt_y = 0.0;') &&
    emitted.includes('if (sx < bdt_x - 0.001 || sy < bdt_y - 0.001) {') &&
    emitted.includes('as_render_live(canvas, o);\nreturn;') &&
    emitted.indexOf('as_bake_scale2(canvas, lw, lh, &sx, &sy);') <
      emitted.indexOf('if (sx < bdt_x - 0.001 || sy < bdt_y - 0.001) {'));
  // (1d) Every "cannot bake / must not bake" branch paints through as_render_live, so
  // none of them can drop the filters branch or paint nothing. The span is checked
  // in double space first: a degenerated transform yields the +-3.4028235e38 bounds
  // sentinel and (int) of 6.8e38 is UB. A failed surface allocation falls back live
  // instead of leaving the object invisible.
  check('no bake branch can silently paint nothing',
    emitted.includes('static void as_render_live(void* canvas, DisplayObject* o) {') &&
    emitted.includes('if (o->filters != NULL && o->filters->length > 0) as_render_filtered(canvas, o, o->filters, o->filters->length - 1);\nelse as_render_object_content(canvas, o);') &&
    emitted.includes('double bw = br - bxo, bh = bb - byo;') &&
    emitted.includes('if (!(bw > 0.0) || !(bh > 0.0) || bw > 32768.0 || bh > 32768.0) { as_render_live(canvas, o); return; }') &&
    (emitted.match(/as_render_live\(canvas, o\);\nreturn;/g) ?? []).length >= 2 &&
    emitted.includes('else as_render_live(canvas, o);') &&
    !emitted.includes('int lw = (int)ceil(br - bxo); int lh = (int)ceil(bb - byo);'));

  // (2) BitmapData.draw rasterizes a DisplayObject source at the matrix's scale
  // and reads the raster back 1:1 (source coords are multiplied by that scale).
  // The sampler walks a destination row incrementally instead of re-evaluating the
  // matrix per texel: moving one texel right adds exactly the column basis vector
  // of the inverse matrix (ia, ib) scaled by rs, so the coordinates are the same.
  check('the draw raster scale comes from the destination matrix',
    emitted.includes('double rs = 1.0;') &&
    emitted.includes('{ double rsx = sqrt(a * a + b * b), rsy = sqrt(c * c + d * d); rs = rsx > rsy ? rsx : rsy; if (rs < 1.0) rs = 1.0; }') &&
    emitted.includes('const double _dscx = ia * rs, _dscy = ib * rs;') &&
    emitted.includes('double scx = (ia * ((double)cx0 + 0.5) + ic * ((double)dy + 0.5) + itx) * rs;') &&
    emitted.includes('double scy = (ib * ((double)cx0 + 0.5) + id * ((double)dy + 0.5) + ity) * rs;') &&
    emitted.includes('scx += _dscx; scy += _dscy;'));
  check('both draw raster branches are scaled and the source rect +1 is one bitmap px',
    (emitted.match(/as_skia_canvas_scale\(canvas, rs, rs\);/g) ?? []).length === 2 &&
    emitted.includes("sw = (int)ceil(tf->_fieldWidth * rs) + (tf->border ? 1 : 0); if (sw < 1) sw = 1;") &&
    emitted.includes("sh = (int)ceil(tf->_fieldHeight * rs) + (tf->border ? 1 : 0); if (sh < 1) sh = 1;"));
  check('the raster pass pins ASC_render_scale to one bitmap pixel',
    emitted.includes('static double ASC_render_scale;') &&
    emitted.includes('double keep_render_scale = ASC_render_scale; ASC_render_scale = 1.0;') &&
    (emitted.match(/ASC_render_scale = keep_render_scale;/g) ?? []).length >= 5);

  // (3) The source's own transform is zeroed for the raster and restored after.
  //
  // The source is reached through the interface's object half (`src`), not through
  // the raw parameter, because the parameter is an IBitmapDrawable pair -- a
  // BitmapData argument has no DisplayObject fields at all, so there is nothing to
  // zero for it (that arm samples pixels instead).
  check('draw ignores the source transform',
    emitted.includes('DisplayObject* sdo = (DisplayObject*)src;') &&
    emitted.includes('sdo->x = 0.0; sdo->y = 0.0; sdo->rotation = 0.0; sdo->scaleX = 1.0; sdo->scaleY = 1.0;') &&
    emitted.includes('if (sdo->transform != NULL) sdo->transform->matrix = NULL;') &&
    emitted.includes('as_render_object(canvas, sdo);') &&
    emitted.includes('if (sdo->transform != NULL) sdo->transform->matrix = sx_km;'));

  // (4) The recorded oracle: native and web ends agree with adl line for line.
  //
  // temp/ is a disposable scratch tree (see .gitignore), so the three recordings
  // exist only where the probe was run -- a fresh clone has none of them. Guarded
  // like checkSwcTimeline and [skia-abi] below: absent means SKIP, never a
  // failure, because "the recording is not here" is not "the bake regressed".
  // Unguarded, this read was the whole reason CI went red while every developer
  // machine stayed green.
  const probeDir = join(root, 'temp', 'bakeprobe');
  const probeFiles = ['adl.txt', 'aot-native.txt', 'aot-web.txt'].map((f) => join(probeDir, f));
  if (probeFiles.every((f) => existsSync(f))) {
    const probeLines = (f: string): string[] =>
      readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('PROBE|'));
    const [adl, nat, web] = probeFiles.map(probeLines);
    const same = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((l, i) => l === b[i] || l.startsWith('PROBE|tf '));
    check('the bake probe matches adl on every line but the font metric',
      adl.length === 20 && same(adl, nat) && same(adl, web) &&
      nat.some((l) => l.includes('H1 k=2 cache=on ') && l.includes('pixdiff=0')) &&
      nat.some((l) => l.includes('H1b cont2 cache=off ext=41x21')) &&
      nat.some((l) => l.includes('H1d cont2+mat3 ext=121x61')));
  } else {
    console.log('SKIP  [bakeres] the recorded bake probe (temp/bakeprobe) is not present');
  }

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
  // The evidence table lives in the disposable temp/editprobe tree, which only
  // exists where the probe was run, so it is read only when present -- the same
  // guard, and for the same reason, as checkSwcTimeline and [skia-abi] below. An
  // unguarded readFileSync here made a fresh clone report ENOENT as a failure.
  const docsPath = join(root, 'temp', 'editprobe', 'README.md');
  const docs = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : null;

  check('the CAMetalLayer declares sRGB',
    glue.includes('l.colorspace = cs;') &&
    glue.includes('CGColorSpaceCreateWithName(kCGColorSpaceSRGB)'));
  check('the drawable readback hook is env-gated and reads the current surface',
    glue.includes('#include <cstdlib>') &&
    glue.includes('const char* rb = getenv("ASC_MTL_READBACK");') &&
    /getenv\("ASC_MTL_READBACK"\)[\s\S]{0,900}?m->surface->readPixels\(/.test(glue));
  // The comparison tooling must keep its tolerance for capture-path colour drift,
  // and the evidence table for the four measured stages must stay documented.
  if (docs === null) {
    console.log('SKIP  [colormanage] temp/editprobe/README.md is not present');
  } else {
    check('the capture-path finding is documented with its four stages',
      docs.includes('ASC_MTL_READBACK') && docs.includes('ff00ff00') &&
      docs.includes('FF7700') && docs.includes('offscreen_cpu.txt'));
  }

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
  const glue = readGlue();
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
  const swcPath = join(dir, 'embed-assets', 'skin.swc');
  if (!existsSync(swcPath)) {
    console.log('SKIP  [swctimeline] sample SWC examples/embed-assets/skin.swc not present');
    return bad;
  }
  const lib = extractSwc(swcPath);
  const inputs = swcCompileInputs(lib);
  const bake = swcBakePlan(lib, inputs.specs, inputs.chars);
  const byId = new Map(bake.characters.map((c) => [c.id, c]));

  // 按**类名反查**字符号，而不是把某次导出的字符号写死：符号 id 由 Animate 的导出顺序决定，
  // 同一份 FLA 每重导出一次就会整体平移（实测：旧的 426/154/634/84 → 入库夹具的 40/26/32）。
  // 类名才是稳定锚点；id 只当查找键用，断言里一律不再出现字面量字符号。
  const idOf = (name: string): number => {
    for (const [id, n] of lib.classNames) if (n === name) return id;
    return -1;
  };
  const dsi = byId.get(idOf('desktopshareitem')); // the rollover skins' home symbol
  const cb = byId.get(idOf('checkbom'));           // a frame-2 replace + a frame-2 place
  const tb = byId.get(idOf('toastbtn'));           // a frame-2 RemoveObject2 + a re-place
  check('FrameLabel records become the bake\'s label table in SWF frame order',
    (dsi?.labels ?? []).map((l) => `${l.name}@${l.frame}`).join(',') === '_up@1,_over@8,_down@15');
  const cbOps = cb?.frames?.[0]?.ops ?? [];
  check('a frame-2 replace at depth 2 inherits the placement it omits (identity matrix)',
    cbOps.some((o) => o.depth === 2 && o.charId != null && o.replace === true && o.matrix?.join(',') === '1,0,0,1,0,0'));
  // The frame-2 label sits at SWF x=200 twips (10 px) + the text RECT origin (-2)
  // == x 8 in adl, and the same origin rule must be applied to a frame-2 record too.
  check('a frame-2 place at depth 3 carries 200 twips + the text origin as x=10-2=8',
    cbOps.some((o) => o.depth === 3 && o.charId != null && o.matrix?.join(',') === '1,0,0,1,10,3'));
  // toastbtn frame 2 = RemoveObject2(depth 2) + a fresh place at depth 3: adl keeps 3
  // children (depths 1, 3, 4) with the artwork swapped, so BOTH halves are the pin.
  check('the frame-2 RemoveObject2 is parsed and the re-place is a fresh object',
    tb?.totalFrames === 2 &&
    (tb?.frames?.[0]?.ops ?? []).some((o) => o.depth === 2 && o.del === true) &&
    (tb?.frames?.[0]?.ops ?? []).some((o) => o.depth === 3 && o.charId != null && !o.replace));

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
  // A SWF outline has no close verb, so the Graphics path our shape builders emit is
  // OPEN. Skia fills an open contour implicitly but its AA clipper drops it, so a
  // clipDepth mask built straight from that path clipped the whole region away (the
  // TalkMED login banner painted blank). Every contour must be closed first.
  // 阶段三百一十九 replaced the bake-time outline with a per-frame stencil built
  // from the LIVE mask object, so the closing step moved into as_clip_path.
  check('a clipDepth mask path closes every contour before becoming a clip',
    /static void\* as_clip_path\(DisplayObject\* m\) \{[\s\S]{0,400}?as_mask_ink\(m, p, a, b, c, d, tx, ty\);\s*as_skia_path_close_all\(p\);/.test(c));
  // A clipDepth mask is a SIBLING of what it clips, so it must not travel with it:
  // the clip is set before the object's translate/rotate/scale (parent space).
  // The window (rather than an exact-adjacency regex) is deliberate: statements may be
  // inserted between the save and the translate (e.g. the `alpha_on` local that pairs
  // with the saveLayerAlpha restore) without changing what this pin is about.
  const clipBlock = /as_skia_canvas_save\(canvas\);[\s\S]{0,1200}?as_skia_canvas_translate\(canvas, o->x, o->y\);/.exec(c);
  check('the clipDepth clip is applied BEFORE the object transform',
    !!clipBlock && clipBlock[0].includes('if (o->_clip_src != NULL) {') &&
    clipBlock[0].includes('as_skia_canvas_clip_path(canvas, cclip, 1);'));
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

  // ---- SWC 符号级 DoABC 帧脚本（D17）----
  // 协议的勾选框 `agreebtn`（char#84 = skin_fla.元件172_339）的勾选态**不在 AS3 代码里**，
  // 而在符号自己的时间轴脚本（DoABC）里：`this.stop(); this.buttonMode = true;
  // addEventListener(CLICK, function(){ _self.gotoAndStop(_self.currentFrame < 3 ? 3 : 2) })`。
  // 编译器在**编译期**把这些字节码解成 AST、复用现有发射器（`src/abc.ts`）。
  //
  // **入库夹具里没有那个符号**：`examples/embed-assets/skin.swc` 的 35 个导出符号里没有任何
  // 一个的 DoABC 引用 `gotoAndStop` 或 `CLICK`（全库实测），所以下面两条与它绑定的钉子
  // **注释保留**（按“缺样本即显式停用、不静默通过”的口径；夹具补齐后原样恢复）：
  //
  //   check('the DoABC frame script of the agree checkbox is decoded and translated',
  //     c.includes('static as_value skin_fla__u5143_u4ef6172_339_frame1(void* _this) {') &&
  //     /->_self = as_v_obj\(\(void\*\)\(this\)\);\s*\(this->vtable->stop\(this\)\);\s*\(\(this->buttonMode\) = true\);/.test(c));
  //   check('the CLICK handler\'s ternary gotoAndStop survives translation',
  //     /as_any_get\(as_req_box\(env->\w+->_self\), "currentFrame"\)\) < \(\(double\)\(3\)\)\) \? 3 : 2\);/.test(c) &&
  //     /as_any_call\(env->\w+->_self, "gotoAndStop",/.test(c));
  //
  // 同一个机制的另一半样本在夹具里**存在**，下面三条钉的就是它（`checkbom` 自带两个帧脚本，
  // 且第 1 帧脚本真的执行 stop + buttonMode，与那个勾选框的脚本原文一致）：
  check('the DoABC frame scripts of checkbom are decoded and translated',
    c.includes('static as_value checkbom_frame1(void* _this) {') &&
    /checkbom\* this = \(checkbom\*\)_this;\s*\(MovieClip_stop\(this\)\);\s*\(\(this->buttonMode\) = true\);/.test(c));
  check('a frame-2 script is decoded too and its ternary survives translation',
    c.includes('static as_value checkbom_frame2(void* _this) {') &&
    c.includes('as_any_set_v(as_req_box(as_dyn_get((void*)(this), "label")), "text",') &&
    c.includes('as_v_truthy(as_dyn_get((void*)(this), "labelOn")) ? as_v_str_val('));
  check('a one-frame symbol with a script still starts its timeline and runs frame 1',
    /as_swc_bind\(\(DisplayObject\*\)o, 136\);\s*as_swc_tl_start\(\(MovieClip\*\)o, 136\);\s*as_swc_frames\(136, 1, \(DisplayObject\*\)o\);/.test(c));
  check('as_swc_frames dispatches per character and per frame',
    c.includes('static void as_swc_frames(int charId, int frame, DisplayObject* o) {') &&
    c.includes('case 1: checkbom_frame1((void*)o); break;') &&
    c.includes('case 2: checkbom_frame2((void*)o); break;') &&
    c.includes('as_swc_frames(o->_tl_char, f, (DisplayObject*)o);'));
  // 勾选框的描边色来自 LINESTYLE 的 rgba：#00948C（而不是 fillStyle，也不是默认黑）——
  // 夹具里 shape #36 是**只有描边**的字符（`line>0 && fill0==0 && fill1==0`），所以它的
  // 函数体里必须**一次 `as_swc_fill` 都没有**：取错色就成黑框，把描边当填充画就多出一个面。
  const shape36 = /static void as_swc_shape_36\(Graphics\* g\) \{[\s\S]*?\n\}/.exec(c)?.[0] ?? '';
  check('a stroke-only SWC shape takes its colour from the LINESTYLE rgba',
    shape36.includes('as_swc_stroke(g, as_swc_paint_solid(0xff00948cu), 1.0, 0, 0, 3.0);') &&
    shape36.includes('as_swc_move_to(g, 7.9, 0.0);') &&
    !shape36.includes('as_swc_fill(g,'));

  // ---- D43：回退到旧帧时子件必须**复用**（而不是重建第 1 帧）----
  // AIR 实测（temp/btnprobe/Rewind2.as）：从 _over(5) 退回 _up(1) 时 label1/label2 仍是同一批对象
  // （#1/#2 不变）且 App 写进去的文字保留；只有「目标帧的（深度, 角色）与当前不同」的深度上才换新对象。
  // 旧实现是 `as_swc_tl_clear + as_swc_bind`，会把第 1 帧全部子件重建一遍——于是 TalkMED 首页卡片
  // 悬停一次就把 App 写的「快速入会 / Join creating」换回皮肤原稿（D43，阶段一百七十二）。
  // 这里钉住四件事：快照表、按 (父, 深度, 角色) 复用、回退路径改走 rewind、以及“角色来源”字段在基类上。
  check('the rewind snapshots the frame-1 children (parent-scoped, GC-rooted slots)',
    c.includes('static as_array* ASC_tl_snap_par = NULL;') &&
    c.includes('static as_array* ASC_tl_snap_obj = NULL;') &&
    c.includes('gc_root_register((void**)&ASC_tl_snap_par); gc_root_register((void**)&ASC_tl_snap_obj);'));
  check('a rewind reuses a child only when (parent, depth, character) still match',
    c.includes('static DisplayObject* as_swc_tl_reuse(DisplayObject* parent, int depth, int charId) {') &&
    /DisplayObject\* as_swc_tl_reuse\(DisplayObject\* parent, int depth, int charId\) \{[^}]*as_v_obj_val\(ASC_tl_snap_par->data\[i\]\) != parent[^}]*c->_tl_depth == depth && c->_tl_char == charId/.test(c));
  check('the backtrack branch calls as_swc_tl_rewind instead of clear + rebind',
    c.includes('if (f <= 1 || f < o->currentFrame) as_swc_tl_rewind(o->_tl_char, (DisplayObject*)o, f);') &&
    !c.includes('as_swc_tl_clear('));
  check('every baked child knows its SWC character (the field lives on DisplayObject)',
    readFileSync(join(root, 'src', 'symbols.ts'), 'utf8')
      .includes("['_tl_char', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'DisplayObject'"));
  check('as_swc_new stamps the character id so a rewind can compare it',
    c.includes('DisplayObject* o = as_swc_new_char(charId);') &&
    c.includes('o->_tl_char = charId;'));
  check('frame-1 timeline children are built through as_swc_tl_new/as_swc_tl_link (depth recorded)',
    /as_swc_tl_link\(o, c\d+, \d+\);/.test(c) && /as_swc_tl_new\(o, \d+, \d+\)/.test(c));
  check('the rewind prunes leftovers by pointer identity, not by depth',
    c.includes('static void as_swc_tl_unlink(DisplayObject* parentD, DisplayObject* c) {') &&
    c.includes('if (c != NULL) as_swc_tl_unlink(o, c);'));

  if (ok > 0) console.log(`[swctimeline] ${ok} timeline-bake checks passed`);
  return bad;
}

// ---- SWC `SymbolClass` id 0 = the document class (阶段二百一十二) ----
//
// Animate emits a `SymbolClass` entry mapping character id 0 to the FLA's MAIN
// TIMELINE class (`skin_fla.MainTimeline`) as soon as that FLA carries a
// main-timeline script -- which a real skin FLA does (the TalkMED skin's 动作 layer).
// Id 0 names the loaded SWF's ROOT timeline, so it owns no character definition by
// design. The closure walk in `swcBakePlan` used to visit it like any other linked
// symbol and abort the whole library with "exported character #0 has no definition",
// so a library our own extractor reads without a single warning took every swc-*
// example down as a codegen crash instead of an assertion.
//
// The pairing below is the point: id 0 is skipped AND named in a note, while any
// OTHER linked id that the library does not define stays a hard error. Keeping only
// the first half would turn a loud failure into a silent one (AGENTS.md §1.5).
function checkSwcDocumentClass(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [swcdoc] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [swcdoc] ${label}`); }
  };
  const u16 = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
  const tag = (code: number, payload: Buffer): Buffer => {
    const head = Buffer.alloc(2);
    head.writeUInt16LE((code << 6) | payload.length, 0);
    return Buffer.concat([head, payload]);
  };
  // STORE-method ZIP writer: swc.ts's `unzip` walks the EOCD + central directory.
  const zip = (name: string, data: Buffer): Buffer => {
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30 + n.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    n.copy(lh, 30);
    const ch = Buffer.alloc(46 + n.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    n.copy(ch, 46);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(ch.length, 12);
    eocd.writeUInt32LE(lh.length + data.length, 16);
    return Buffer.concat([lh, data, ch, eocd]);
  };
  // RECT with nbits=0 is one zero byte, then frameRate + frameCount (swc.md §4).
  const swf = (tags: Buffer[]): Buffer => {
    const stage = Buffer.alloc(5);
    stage.writeUInt16LE(0x0100, 1);
    stage.writeUInt16LE(1, 3);
    const body = Buffer.concat([stage, ...tags, tag(0, Buffer.alloc(0))]);
    const head = Buffer.alloc(8);
    head.write('FWS', 0, 'latin1');
    head[3] = 6;
    head.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([head, body]);
  };
  const symbolClass = (entries: [number, string][]): Buffer =>
    tag(76, Buffer.concat([u16(entries.length), ...entries.flatMap(([id, name]) => [u16(id), Buffer.from(`${name}\0`, 'utf8')])]));

  const d = join(root, 'temp', 'swcdoc');
  mkdirSync(d, { recursive: true });

  // #1 is a real (empty) sprite; id 0 is the document class Animate adds for the
  // main timeline. Two entries keep the payload under the long-form length limit.
  const docClass = join(d, 'docclass.swc');
  writeFileSync(docClass, zip('library.swf', swf([
    tag(39, Buffer.concat([u16(1), u16(1), tag(0, Buffer.alloc(0))])),
    symbolClass([[0, 'skin_fla.MainTimeline'], [1, 'probeArt']]),
  ])));
  const lib = extractSwc(docClass);
  check('the document-class entry is kept as a SymbolClass binding (faithful read)',
    lib.classNames.get(0) === 'skin_fla.MainTimeline' && lib.classNames.get(1) === 'probeArt');
  const inputs = swcCompileInputs(lib);
  let msg = '';
  let bake: ReturnType<typeof swcBakePlan> | undefined;
  try { bake = swcBakePlan(lib, inputs.specs, inputs.chars); } catch (err) { msg = (err as Error).message; }
  check('a SymbolClass entry for character id 0 no longer aborts the library',
    msg === '' && bake !== undefined);
  check('id 0 is not baked as artwork while the real symbol still is',
    (bake?.characters ?? []).some((c) => c.id === 1) && !(bake?.characters ?? []).some((c) => c.id === 0));
  check('the skipped document class is reported, never silently dropped',
    (bake?.notes ?? []).some((n) => n.includes('skin_fla.MainTimeline') && n.includes('DOCUMENT class')));

  // The other half: an id OTHER than 0 that SymbolClass links but the library never
  // defines is a broken library, not a document class.
  const ghost = join(d, 'ghost.swc');
  writeFileSync(ghost, zip('library.swf', swf([symbolClass([[9, 'ghostArt']])])));
  const glib = extractSwc(ghost);
  const gin = swcCompileInputs(glib);
  let ghostMsg = '';
  try { swcBakePlan(glib, gin.specs, gin.chars); } catch (err) { ghostMsg = (err as Error).message; }
  check('any other linked character without a definition is still a hard error',
    ghostMsg.includes('exported character #9 has no definition'));

  if (ok > 0) console.log(`[swcdoc] ${ok} document-class checks passed`);
  return bad;
}

// ---- SWC DefineBitsJPEG3 alpha plane (diff doc D25) ----
//
// A `DefineBitsJPEG3` tag stores its picture TWICE: an ordinary JPEG for RGB (no
// alpha channel exists in JPEG) plus a zlib-compressed 8-bit coverage plane. AIR
// composites the two; an FLA export fills the "transparent" area of the JPEG with
// BLACK, so a bitmap whose plane is dropped paints a black rectangle over the skin
// (measured on the TalkMED home cards #1113/#1118: the artwork's corners are
// exactly `(0,0,0)` in the extracted JPEG and `0` in the plane).
//
// The composition happens at RUNTIME (Skia decodes the JPEG there; the Node side
// has no JPEG decoder and must not gain one, AGENTS.md §3.1), so two things can
// silently regress and both are pinned here:
//   · the compile-time decode — decompress the plane and refuse to use a stream
//     that does not inflate to `width * height` (garbage coverage is worse than
//     none: it must be reported and the image left opaque, never composed);
//   · the emitted wiring — the plane's own C array, `as_argb_apply_alpha` and the
//     alpha-aware adopt/`as_swc_image` calls. A bitmap WITHOUT a plane must keep
//     the old `BitmapData_adoptEncoded` / `as_skia_image_from_bytes` path, or its
//     lazy Skia decode is silently replaced by a full pixel copy.
function checkSwcJpeg3Alpha(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [swcjpeg3] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [swcjpeg3] ${label}`); }
  };

  const u16 = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
  const tag = (code: number, payload: Buffer): Buffer => {
    const head = payload.length < 0x3f ? Buffer.alloc(2) : Buffer.alloc(6);
    if (payload.length < 0x3f) head.writeUInt16LE((code << 6) | payload.length, 0);
    else { head.writeUInt16LE((code << 6) | 0x3f, 0); head.writeUInt32LE(payload.length, 2); }
    return Buffer.concat([head, payload]);
  };
  // A JPEG only has to reach `jpegSize`'s SOF0 reader (it never decodes at compile
  // time): SOI, SOF0 with the 2-byte height/width, then filler.
  const jpeg = (w: number, h: number): Buffer => {
    const b = Buffer.alloc(21);
    b.writeUInt16BE(0xffd8, 0);
    b.writeUInt16BE(0xffc0, 2);
    b.writeUInt16BE(17, 4);
    b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9); b[11] = 3;
    return b;
  };
  const jpeg3 = (id: number, w: number, h: number, plane: Buffer): Buffer => {
    const jpg = jpeg(w, h);
    const p = Buffer.alloc(6 + jpg.length + plane.length);
    p.writeUInt16LE(id, 0);
    p.writeUInt32LE(jpg.length, 2);
    jpg.copy(p, 6);
    plane.copy(p, 6 + jpg.length);
    return p;
  };
  // STORE-method ZIP writer: swc.ts's `unzip` walks the EOCD + central directory
  // (it does not scan local headers), so a fixture needs both records.
  const zip = (name: string, data: Buffer): Buffer => {
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30 + n.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    n.copy(lh, 30);
    const ch = Buffer.alloc(46 + n.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    n.copy(ch, 46);
    const cd = ch;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(lh.length + data.length, 16);
    return Buffer.concat([lh, data, cd, eocd]);
  };
  const swf = (tags: Buffer[]): Buffer => {
    // RECT with nbits=0 is one zero byte, then frameRate + frameCount (swc.md §4).
    const stage = Buffer.alloc(5);
    stage.writeUInt16LE(0x0100, 1);
    stage.writeUInt16LE(1, 3);
    const body = Buffer.concat([stage, ...tags, tag(0, Buffer.alloc(0))]);
    const head = Buffer.alloc(8);
    head.write('FWS', 0, 'latin1');
    head[3] = 6;
    head.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([head, body]);
  };

  const quad = Buffer.from([
    0, 0, 0, 0,
    0, 64, 128, 255,
    0, 255, 128, 64,
    0, 0, 0, 0,
  ]);
  const sym = Buffer.concat([u16(1), u16(1), Buffer.from('probeArt\0', 'latin1')]);
  const d = join(root, 'temp', 'swcjpeg3');
  mkdirSync(d, { recursive: true });
  const fixture = join(d, 'probe.swc');
  writeFileSync(fixture, zip('library.swf', swf([
    tag(35, jpeg3(1, 4, 4, deflateSync(quad))),
    // #2: the plane inflates to only 3 bytes for a 4x4 image -- unreadable.
    tag(35, jpeg3(2, 4, 4, deflateSync(Buffer.from([1, 2, 3])))),
    tag(76, sym),
  ])));

  const lib = extractSwc(fixture);
  const b1 = lib.bitmaps.find((b) => b.tagId === 1);
  const b2 = lib.bitmaps.find((b) => b.tagId === 2);
  check('the JPEG3 alpha plane is decompressed to one byte per pixel',
    b1?.alpha !== null && b1?.alpha?.length === 16 && b1?.width === 4 && b1?.height === 4);
  check('the plane keeps the coverage values (corners transparent, centre opaque)',
    b1?.alpha?.[0] === 0 && b1?.alpha?.[15] === 0 && b1?.alpha?.[7] === 255 && b1?.alpha?.[5] === 64);
  check('the JPEG half is embedded verbatim and sniffs as jpeg',
    b1?.format === 'jpeg' && b1?.encoded.length === 21 && b1?.encoded[0] === 0xff);
  check('a plane that does not inflate to width*height is refused, not composed',
    b2?.alpha === null && b2?.width === 4 && b2?.height === 4);
  check('a non-empty plane is interned for a NAMED bitmap too (class registry)',
    lib.classNames.get(1) === 'probeArt' && lib.characters.get(1)?.kind === 'bitmap');

  const inputs = swcCompileInputs(lib);
  const bake = swcBakePlan(lib, inputs.specs, inputs.chars);
  const prog = parse('var _pad:int = 0;\n');
  prog.body.push(...inputs.decls);
  const c = generateC(prog, [], inputs.specs, bake).c;
  check('the plane is emitted as its own C array next to the JPEG bytes',
    c.includes('static const unsigned char __res_probeArt_a[] =') &&
    c.includes('static const unsigned char __res_probeArt[] ='));
  check('the alpha composer is one helper shared by both adopt paths',
    c.includes('static void as_argb_apply_alpha(unsigned* p, int n, const unsigned char* alpha) {') &&
    c.includes('unsigned a = ((((c >> 24) & 0xffu) * (unsigned)alpha[i]) + 127u) / 255u;') &&
    c.includes('p[i] = (a << 24) | (c & 0x00ffffffu);'));
  check('a BitmapData is adopted through the alpha-aware helper with the plane + size',
    c.includes('BitmapData_adoptEncodedAlpha((BitmapData*)o, __res_probeArt, (size_t)21, __res_probeArt_a, 4, 4);'));
  // 阶段二百八十三: the arm also registers the image with the collector's finalizer (a
  // named-resource BitmapData that is dropped without dispose() would otherwise keep
  // its 8.3 MB SkImage forever), so the arm is matched as a slice of its own.
  check('the composed pixels become the view (the encoded bytes would paint black)',
    c.includes('if (alpha != NULL) { bd->image = as_skia_image_from_argb(gcpx, w, h);') &&
    c.indexOf('if (alpha != NULL) { bd->image = as_skia_image_from_argb(gcpx, w, h);') <
      c.indexOf('as_final_register(bd, bd->image);', c.indexOf('if (alpha != NULL) { bd->image = as_skia_image_from_argb(gcpx, w, h);')));
  check('no plane is still the plain adopt, i.e. the lazy Skia decode is kept',
    c.includes('static void BitmapData_adoptEncoded(BitmapData* bd, const unsigned char* bytes, size_t len) {') &&
    c.includes('BitmapData_adoptEncodedAlpha(bd, bytes, len, NULL, 0, 0);'));

  // The fill path is a separate call site (`as_swc_image` builds the shader's
  // SkImage), and a skin's artwork is mostly bitmap FILLS, not Bitmap children --
  // the two TalkMED cards are fills, so this is the branch that actually regresses.
  // Built as a SwcLibrary value: no SWF shape encoding is needed to reach it.
  const fillLib: SwcLibrary = {
    source: 'probe',
    morphs: [],
    bitmaps: [{ tagId: 7, className: null, format: 'jpeg', width: 4, height: 4, encoded: Buffer.alloc(21), alpha: quad }],
    shapes: [{
      id: 9, version: 1, winding: 'evenOdd',
      bounds: { xmin: 0, xmax: 80, ymin: 0, ymax: 80 },
      layers: [{ fills: [{ type: 0 }, { type: 0x41, bitmapId: 7, matrix: [1, 0, 0, 1, 0, 0], repeating: false, smoothed: true }], lines: [] }],
      subpaths: [{
        layer: 0, fill0: 1, fill1: 0, line: 0, moveToFirst: true,
        start: { x: 0, y: 0 },
        pts: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 0 }],
      }],
    }],
    sprites: [{
      id: 10, frames: 1, frameStarts: [1], labels: [],
      placements: [{
        depth: 1, charId: 9, move: true, name: null, matrix: [1, 0, 0, 1, 0, 0], cxform: null,
        clipDepth: null, hidden: false, visibleFlag: null, ratio: null, filters: [], skippedFilters: [],
        blendMode: null, bitmapCached: false,
      }],
    }],
    buttons: [], texts: [], fonts: new Map(), scalingGrids: new Map(),
    classNames: new Map([[10, 'probeSkin']]),
    characters: new Map([
      [7, { id: 7, kind: 'bitmap', tag: 35 }],
      [9, { id: 9, kind: 'shape', tag: 2 }],
      [10, { id: 10, kind: 'sprite', tag: 39 }],
    ]),
    scripts: new Map(),
    bases: new Map(),
  };
  const fillInputs = swcCompileInputs(fillLib);
  const fillBake = swcBakePlan(fillLib, fillInputs.specs, fillInputs.chars);
  const prog2 = parse('var _pad2:int = 0;\n');
  prog2.body.push(...fillInputs.decls);
  const c2 = generateC(prog2, [], fillInputs.specs, fillBake).c;
  check('a bitmap FILL with a plane goes through the composing SkImage builder',
    c2.includes('static void* as_swc_image_alpha(const unsigned char* bytes, size_t len, const unsigned char* alpha, int aw, int ah) {') &&
    /case 7: \{ static void\* img = NULL; if \(img == NULL\) img = as_swc_image_alpha\(__swcbmp_7, \(size_t\)21, __swcbmp_7_a, 4, 4\); return img; \}/.test(c2));
  check('the fill bitmap gets its own plane array (it is not a named resource)',
    c2.includes('static const unsigned char __swcbmp_7_a[] ='));
  // The counterpart: the SAME library with the plane absent must keep the encoded
  // bytes as the view (Skia decodes lazily) -- and must not emit a plane array or
  // the composing builder at all.
  const plainLib: SwcLibrary = { ...fillLib, bitmaps: [{ ...fillLib.bitmaps[0], alpha: null }] };
  const plainInputs = swcCompileInputs(plainLib);
  const plainBake = swcBakePlan(plainLib, plainInputs.specs, plainInputs.chars);
  const prog3 = parse('var _pad3:int = 0;\n');
  prog3.body.push(...plainInputs.decls);
  const c3 = generateC(prog3, [], plainInputs.specs, plainBake).c;
  check('a fill bitmap without a plane keeps the encoded-byte view',
    /case 7: \{ static void\* img = NULL; if \(img == NULL\) img = as_skia_image_from_bytes\(__swcbmp_7, \(size_t\)21\); return img; \}/.test(c3) &&
    c3.includes('as_swc_fill(g, as_swc_paint_bitmap(as_swc_image(7), lm, 0, 1));'));
  check('no plane means no plane array and no fill composer (the fill C stays as it was)',
    !c3.includes('__swcbmp_7_a') && !c3.includes('as_swc_image_alpha'));

  if (ok > 0) console.log(`[swcjpeg3] ${ok} JPEG3-alpha checks passed`);
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

// ---- D29: the scrollRect window is anchored on the object's own box ----
//
// The behavioural oracle is examples/scrollrect-clip.as (measured on adl 51.4.1:
// `scrollRect = (20,30,100,80)` on a box at (100,50) paints at (100,50)-(199,129)).
// What a pixel test CANNOT see is the ORDER of the two renderer calls and the pick
// window, because both mistakes still produce a rectangle on screen:
//   * clipRect after the translate: Skia maps the clip through the CTM in force at
//     the call, so the window itself slid to (r.x,r.y,w,h) -- TalkMED's file list
//     then painted over its fixed header and left a blank band below it;
//   * as_pick_hit_m testing (sr->x,sr->y,w,h): the top `scrollY` points of a
//     scrolled list went dead (adl hits the row there -- verified live by scrolling
//     the adl file list and clicking its first row, which toggled the checkmark).
// So pin the emitted C's shape, in the spirit of the other source-level pins here.
function checkScrollRectWindow(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [scrollrect] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [scrollrect] ${label}`); }
  };
  const src = [
    'import flash.display.Sprite;',
    'import flash.geom.Rectangle;',
    'var s:Sprite = new Sprite();',
    "s.scrollRect = new Rectangle(0, 30, 100, 80);",
    'trace(s.scrollRect.y);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  const start = c.indexOf('int scroll_on = (o->_scroll_rect != NULL);');
  check('the renderer has a scrollRect branch', start >= 0);
  const end = start < 0 ? -1 : c.indexOf('if (scroll_on) as_skia_canvas_restore(canvas);', start);
  const block = start < 0 || end < 0 ? '' : c.slice(start, end);
  // Stage 349 moved the window clip to the rounding-aware entry point; the ORDER is
  // what this group pins, so accept either name (rounding itself is pinned by
  // unit: render/ScrollRectWindowRounding).
  const clip = /as_skia_canvas_clip_rect(?:_window)?\(canvas, 0\.0, 0\.0, o->_scroll_rect->width, o->_scroll_rect->height\);/.exec(block)?.index ?? -1;
  const move = block.indexOf('as_skia_canvas_translate(canvas, -o->_scroll_rect->x, -o->_scroll_rect->y);');
  check('the window is clipped at the object\'s own box (0,0,w,h)', clip >= 0);
  check('the content is shifted by -x/-y', move >= 0);
  check('the clip comes FIRST, so the shift cannot move the window (D29)', clip >= 0 && move >= 0 && clip < move);
  check('the window never uses the rectangle\'s x/y slot as its origin',
    !block.includes('clip_rect(canvas, o->_scroll_rect->x'));

  const pstart = c.indexOf('static void* as_pick_hit_m(');
  const pend = pstart < 0 ? -1 : c.indexOf('if (as_is(obj, &DisplayObjectContainer_vt))', pstart);
  const pick = pstart < 0 || pend < 0 ? '' : c.slice(pstart, pend);
  check('the pick window tests the object\'s own box',
    pick.includes('if (lx < 0 || ly < 0 || lx > sr->width || ly > sr->height) return NULL;'));
  check('...and does not test the read-back rect (that left the top of a scrolled list dead)',
    !pick.includes('lx < sr->x'));

  console.log(`[scrollrect] ${ok} scrollRect window checks passed`);
  return bad;
}

// ---- D34: a scrollRect change must invalidate an ancestor's auto-bake ----
//
// The behavioural oracle is examples/autobake-scrollrect.as (its mutation is the
// reported defect: without the fingerprint entry the example fails with "a
// scrollRect change must invalidate the ancestor's bake .. 0xff0000, want 0xff00").
// What a structural pin adds is the INVARIANT that makes the entry necessary:
// as_render_cached bakes only as_render_object_content, so the scrollRect clip and
// translate run OUTSIDE the cached image -- which means a baked ancestor freezes
// the scrolled child unless scrollRect is part of the per-frame subtree fingerprint
// (as_render_fp). If a future change moves the clip inside the bake, that is fine,
// but then this rationale (and the pin) must be revisited deliberately rather than
// silently: TalkMED's home tab row kept painting the frame in which a drag started,
// so the bounce looked broken even though scrollX went 0 -> 105 -> 0.
function checkScrollRectBakeInvalidation(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [scrollrectbake] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [scrollrectbake] ${label}`); }
  };
  const src = [
    'import flash.display.Sprite;',
    'import flash.geom.Rectangle;',
    'var s:Sprite = new Sprite();',
    "s.scrollRect = new Rectangle(0, 30, 100, 80);",
    'trace(s.scrollRect.y);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  check('scrollRect setter marks the object dirty (stage C: write-driven, no fingerprint)',
    c.includes('void DisplayObject_set_scrollRect(void* _this, Rectangle* value) {')
    && c.includes('as_mark_dirty(o);'));

  const cacheStart = c.indexOf('static void as_render_cached(void* canvas, DisplayObject* o) {');
  const cacheEnd = cacheStart < 0 ? -1 : c.indexOf('\nstatic ', cacheStart + 10);
  const cache = cacheStart < 0 || cacheEnd < 0 ? '' : c.slice(cacheStart, cacheEnd);
  check('as_render_cached bakes the CONTENT only (clip/translate stay outside the bake)',
    cache.includes('as_render_object_content(c2, o)') && !cache.includes('clip_rect(canvas, 0.0, 0.0, o->_scroll_rect'));

  // 阶段二百八十一: an EXPLICIT cacheAsBitmap expires on content change the way
  // AIR's does -- not frozen at whatever it looked like when the setter ran (the
  // meeting client's cacheAsBitmapAndMatrix() path).
  //
  // RepaintBoundary stage B switch: that invalidation is now WRITE-driven. The
  // fingerprint walk (as_render_fp) no longer drops the bake; the cache branch in
  // as_render_object consumes _render_dirty instead -- an explicit cacheAsBitmap
  // re-bakes this frame, an auto-bake tears the boundary down and falls through
  // to the live filters/content path.
  const guardAt = c.indexOf('int use_cache = 0;');
  const guard = guardAt < 0 ? '' : c.slice(guardAt, guardAt + 800);
  check('a render-input write drops the bake via _render_dirty (not the fingerprint)',
    guardAt >= 0
    && guard.includes('if (o->_render_dirty) {')
    && guard.includes('if (o->_cache_flag) { use_cache = 1; }')
    && guard.includes('else { o->_render_dirty = 0; o->_auto_baked = 0; o->_cache_valid = 0; }'));
  check('no fingerprint residue remains (the walk was removed in stage C)',
    !c.includes('as_render_fp'));

  // 阶段二百八十一: BitmapData identity. Without it a Bitmap whose bitmapData is
  // swapped to another bitmap built the same way hashes identically (image ==
  // NULL, _px_ver == 1 both times) and a baked ancestor replays the old picture.
  // Stage C: the identity is no longer a fingerprint input; a mutator now marks
  // every referring Bitmap dirty via the _refs reverse edges.
  check('BitmapData carries a per-instance id', c.includes('unsigned int _uid;'));
  check('...assigned from a monotonic counter in the constructor',
    c.includes('static unsigned as_bd_uid_next = 0;') && c.includes('o->_uid = ++as_bd_uid_next;'));
  check('a BitmapData mutator marks every referring Bitmap dirty (not a fingerprint)',
    c.includes('static void as_bd_mark_dirty(BitmapData* bd) {')
    && c.includes('as_mark_dirty((DisplayObject*)b);'));

  // 阶段二百八十二: BitmapData.draw is a rendering PATH of its own. The window pass
  // and Stage.render both refresh the fingerprint before drawing, and that walk is
  // the only thing that ever drops a bake -- so a subtree reachable ONLY through
  // draw() baked once and replayed that image forever (measured: an off-stage
  // cacheAsBitmap Sprite, swap its bitmapData, the second `bd.draw` still读了旧图).
  // The meeting client is exactly this shape: FilePreviewView.drawTimeEvent()
  // rasterizes skinView.view (a ViewControl => cacheAsBitmap) into a 1280x720
  // BitmapData at 10 fps and hands that BitmapData to previewPpt.Render(), i.e.
  // what the presenter sees on screen IS the draw path's output.
  // Two occurrences: a forward declaration (it is called from the Texture/Starling
  // helpers earlier in the file) and the definition — the body is the last one.
  const drawStart = c.lastIndexOf('void BitmapData_draw(');
  // 12k chars is comfortably longer than the body of BitmapData_draw and short
  // enough that the slice cannot reach the next definition (the generated C is
  // one file, and every runtime helper is a top-level definition).
  const draw = drawStart < 0 ? '' : c.slice(drawStart, drawStart + 12000);
  check('BitmapData.draw no longer refreshes a fingerprint (stage C removed it)',
    !draw.includes('as_render_fp(sdo);'));
  check('...and the draw path is flagged (ASC_draw_path) for future trace use',
    c.includes('static int ASC_draw_path = 0;') && draw.includes('ASC_draw_path = 1;'));
  // RepaintBoundary stage B switch: the fingerprint no longer emits a bake_drop
  // trace (invalidation is write-driven, not fingerprint-driven).

  console.log(`[scrollrectbake] ${ok} scrollRect bake-invalidation checks passed`);
  return bad;
}

// ---- D30: draw() composites SourceOver instead of replacing the destination ----
//
// The behavioural oracle is examples/draw-over.as (measured on adl 51.4.1: green
// destination kept where the source has no coverage, 50% red over opaque blue =
// 0x7f0080). What a pixel test cannot see is the SHAPE of the sampler, and it is the
// shape that made this invisible for so long: the loop wrote the source pixel (and
// wrote 0 where the source had no coverage), which is the same answer whenever the
// destination is transparent -- i.e. for every bake onto a fresh bitmap, but wrong
// for a composing draw() onto a pre-filled one. Pin the two writes.
function checkDrawComposite(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [drawover] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [drawover] ${label}`); }
  };
  const src = [
    'import flash.display.BitmapData;',
    'import flash.display.Sprite;',
    'var bd:BitmapData = new BitmapData(8, 8, false, 0x0000FF);',
    'bd.draw(new Sprite());',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;
  const start = c.indexOf('void BitmapData_draw(');
  const end = start < 0 ? -1 : c.indexOf('void Bitmap_ctor(', start);
  check('BitmapData.draw is emitted', start >= 0 && end > start);
  const body = start < 0 || end < 0 ? '' : c.slice(start, end);

  // The sampler has three arms and all of them end in SourceOver:
  //  (a) the exact 1:1 case (identity matrix, rs == 1) where the destination texel
  //      IS the source texel -- opaque texels are copied, transparent ones skipped
  //      (as_bd_over's `sa == 0` rule), partly transparent ones still blended;
  //  (b) the general affine case -- opaque results stored directly, the rest blended.
  check('the source pixel is combined with the destination, not stored over it',
    body.includes('as_bd_over(dp, _dw2, dx, dy, sr, sg, sb, sa);') &&
    body.includes('as_bd_over(dp, _dw2, dx, dy, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF, a);'));
  check('...and the helper really is SourceOver (straight-ARGB un-premultiply)',
    c.includes('double oa = s + df * ia;') && c.includes('static void as_bd_over('));
  check('the direct-store arms only fire for a fully opaque sample',
    body.includes('if (a == 255) { dr[dx] = c; continue; }') &&
    body.includes('if (sa == 255) { dp[(size_t)dy * (size_t)_dw2 + (size_t)dx] = (255u << 24) | (sr << 16) | (sg << 8) | sb; continue; }') &&
    body.includes('if (sa == 0) continue;'));
  check('the 1:1 fast arm is gated on an exactly integral destination mapping',
    body.includes('if (!_hasct && rs == 1.0 && ia == 1.0 && ib == 0.0 && ic == 0.0 && id == 1.0 && itx == 0.0 && ity == 0.0) {'));
  check('a sampled pixel with no coverage leaves the destination alone',
    body.includes('if (sa == 0) return;') && body.includes('if (a == 0) continue;'));
  check('missing source coverage no longer writes 0 over the destination',
    !body.includes('dp[dy * bd->width + dx] = 0u;'));
  check('the sampler never assigns the destination directly any more',
    !body.includes('dp[dy * bd->width + dx] ='));

  console.log(`[drawover] ${ok} BitmapData.draw composite checks passed`);
  return bad;
}

// ---- Frame-start canvas hygiene (the "window grows after a while" bug) ----
//
// The window pass is save() -> scale(w->scale) -> ... -> restore() on a canvas that
// OUTLIVES the frame (the cached GPU back-buffer canvas). An AS3 exception thrown while
// the frame is being composed unwinds through the renderer with longjmp, so that
// restore() never runs and the leaked save+scale stay on the canvas. The next frame then
// scales an already-scaled canvas, and the damage COMPOUNDS: measured on the real app
// 1.0 -> 1.5 -> 2.25 -> 3.375 device scale, which is exactly the user-visible symptom
// (the whole window, its HUD and its SWC skin all render 2.25x too big, then grow again).
// Resetting at the frame entry makes every frame independent of the previous one; restores
// are balanced within a frame, so on a clean frame it is a no-op. The ORDER is the whole
// point -- a reset after the scale(w->scale) would throw the device scale away.
function checkFrameCanvasHygiene(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [canvasreset] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [canvasreset] ${label}`); }
  };
  const c = generateC(parse('var n:int = 1;\n')).c;
  const head = 'static int ASC_window_render(int id) {';
  const at = c.indexOf(head);
  check('the window pass is emitted', at >= 0);
  const body = at >= 0 ? c.slice(at, c.indexOf('\n}', at)) : '';
  const call = 'as_skia_canvas_reset(canvas);';
  const clear = 'as_skia_canvas_clear(canvas, st->stage_color);';
  const save = 'as_skia_canvas_save(canvas);';
  const scale = 'as_skia_canvas_scale(canvas, w->scale, w->scale);';
  check('the frame entry drops any pending save and resets the base matrix', body.includes(call));
  check('...and does so before this frame\'s own save()',
    body.indexOf(call) >= 0 && body.indexOf(save) >= 0 && body.indexOf(call) < body.indexOf(save));
  check('...before the device scale, so the reset cannot undo it',
    body.indexOf(call) >= 0 && body.indexOf(scale) >= 0 && body.indexOf(call) < body.indexOf(scale));
  check('...and before the stage-colour clear of the same pass',
    body.indexOf(call) >= 0 && body.indexOf(clear) >= 0 && body.indexOf(call) < body.indexOf(clear));
  check('the reset is emitted once per frame, not per object', c.split(call).length - 1 === 1);
  check('the preamble declares the glue entry point',
    RUNTIME_PREAMBLE.includes('extern void sk_canvas_reset(void* canvas);'));
  check('the preamble wraps it for the emitted code',
    RUNTIME_PREAMBLE.includes('static inline void as_skia_canvas_reset(void* c) { sk_canvas_reset(c); }'));
  check('a build without a canvas API still compiles (no-op stub)',
    RUNTIME_PREAMBLE.includes('static inline void as_skia_canvas_reset(void* c) { (void)c; }'));
  const glue = readGlue();
  check('sk_canvas_reset drops every pending save and clears the matrix',
    glue.includes('c->restoreToCount(1);') && glue.includes('c->resetMatrix();'));
  check('...and refuses a NULL canvas instead of dereferencing it',
    /void sk_canvas_reset\(void\* canvas\) \{[^}]*if \(c == nullptr\) return;/.test(glue));

  console.log(`[canvasreset] ${ok} frame-canvas hygiene checks passed`);
  return bad;
}
function checkPresentSkip(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [presentskip] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [presentskip] ${label}`); }
  };
  const c = generateC(parse('var n:int = 1;\n')).c;
  const at = c.indexOf('static int ASC_window_render(int id) {');
  const body = at < 0 ? '' : c.slice(at, c.indexOf('\n}', at));
  check('as_render_states settles states before drawable acquisition',
    body.indexOf('as_render_states((DisplayObject*)st)') >= 0
    && body.indexOf('as_render_states((DisplayObject*)st)') < body.indexOf('as_skia_gpu_begin_frame'));
  check('a hit requires a previously completed frame and every generation to match (dirty epoch + serials)',
    body.includes('w->render_valid && w->render_epoch == ASC_dirty_epoch')
    && body.includes('w->render_s3d_serial == ASC_stage3d_serial')
    && body.includes('w->render_gpu_generation == _gpu_generation')
    && body.includes('w->render_window_generation == _window_generation'));
  check('the A/B escape hatch and the diagnostic counter are present',
    body.includes('getenv("ASC_NO_PRESENT_SKIP") == NULL') && body.includes('as_dbg_present_skip_n++'));
  check('a partial frame is never committed as valid',
    body.indexOf('w->render_valid = 0;') >= 0
    && body.indexOf('w->render_valid = 0;') < body.indexOf('as_skia_gpu_begin_frame')
    && body.indexOf('w->render_valid = 1;') > body.indexOf('as_render_object(canvas'));
  check('window and GPU generations are guarded for no-window and CPU-window builds',
    body.includes('#ifdef ASC_USE_WINDOW') && body.includes('#ifdef ASC_RENDER_WINGPU')
    && body.includes('uint64_t _window_generation = 0;'));

  check('the fingerprint walk is gone: as_render_states settles states, no as_fp_* residue',
    !c.includes('static uint32_t as_render_fp')
    && !c.includes('as_fp_u32')
    && !c.includes('as_textformat_fp')
    && !c.includes('as_fp_mask_stack'));
  check('as_render_states settles SimpleButton state pixels',
    c.includes('static void as_render_states(DisplayObject* o) {')
    && c.includes('if (as_is(o, &SimpleButton_vt)) {')
    && c.includes('DisplayObject* st = as_sbtn_state(o);'));
  check('Stage3D present advances the compositor serial',
    /void Context3D_present[\s\S]*?ASC_stage3d_serial\+\+;/.test(c));

  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  check('the CPU backend presents only a frame that was actually rasterized',
    glue.includes('int painted = c->on_redraw(i);') && glue.includes('if (!c->is_gpu && painted) present_frame'));
  check('OS exposure invalidates an otherwise unchanged swapchain',
    glue.includes('e.window.event == SDL_WINDOWEVENT_EXPOSED') && glue.includes('c->redraw_generation++;'));
  console.log(`[presentskip] ${ok} static-present checks passed`);
  return bad;
}

function checkAlphaLayerBalance(): string[] {
  // `saveLayerAlpha` is a SAVE, not a cosmetic flag: it pushes a layer that must be
  // popped by its own restore. The unbalanced version (阶段二百一十四 前的真缺陷) let a
  // child's save leak upward, so the PARENT's save -- and the translate/rotate/scale
  // it had applied -- stayed on the canvas for the rest of the frame, dragging every
  // later sibling along with that child's position. In the app one list row sets
  // `bg.alpha = 0.5` on MOUSE_DOWN and never sees its MOUSE_UP once a drag starts
  // (the scrollbar turns mouseChildren off), so the "创建同传" card was painted shifted
  // down by that row's y until the list was rebuilt.
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [alphalayer] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [alphalayer] ${label}`); }
  };
  const c = generateC(parse('var n:int = 1;\n')).c;
  const head = 'static void as_render_object(void* canvas, DisplayObject* o) {';
  const at = c.indexOf(head);
  check('the per-object renderer is emitted', at >= 0);
  const body = at >= 0 ? c.slice(at, c.indexOf('\n}', at)) : '';
  const opens = body.match(/as_skia_canvas_save(?:_layer_\w+)?\(/g) ?? [];
  const closes = body.match(/as_skia_canvas_restore\(/g) ?? [];
  check('the object-level alpha layer is opened conditionally',
    body.includes('else if (alpha_on) as_skia_canvas_save_layer_alpha(canvas, o->alpha);'));
  check('...and its condition is remembered for the restore',
    body.includes('int alpha_on = (o->alpha < 1.0);'));
  // 阶段三百一十五: a single-primitive object folds its alpha into the paint
  // instead of opening a layer (see as_single_primitive). The fold must be decided
  // from the SAME condition that gates the layer, and its multiplier must be
  // restored on the same path that restores the canvas -- otherwise the next
  // sibling inherits the dimming, which is the 阶段二百一十四 bug in a new dress.
  check('...folded into the paint when the object draws exactly one primitive',
    body.includes('int alpha_fold = (alpha_on && as_single_primitive(o));')
    && body.includes('if (alpha_fold) ASC_alpha_mul = keep_alpha_mul * o->alpha;'));
  check('...and the fold multiplier is saved and restored around the object',
    body.includes('double keep_alpha_mul = ASC_alpha_mul;')
    && body.indexOf('ASC_alpha_mul = keep_alpha_mul;') > body.indexOf('if (alpha_on && !alpha_fold) as_skia_canvas_restore(canvas);'));
  check('...and the layer is popped again', body.includes('if (alpha_on && !alpha_fold) as_skia_canvas_restore(canvas);'));
  const blendPop = body.indexOf('if (blend_on) as_skia_canvas_restore(canvas);');
  const alphaPop = body.indexOf('if (alpha_on && !alpha_fold) as_skia_canvas_restore(canvas);');
  check('...in reverse order, after blend/colour-transform/scrollRect',
    blendPop >= 0 && alphaPop > blendPop);
  check('...but before the last unconditional restore that closes the object',
    alphaPop >= 0 && alphaPop < body.lastIndexOf('as_skia_canvas_restore(canvas);'));
  check('every canvas push in the renderer has a matching restore (save/restore balance)',
    opens.length === closes.length && opens.length >= 5);

  console.log(`[alphalayer] ${ok} alpha-layer balance checks passed`);
  return bad;
}
registerGroup('unit: render/DrawComposite', checkDrawComposite);
registerGroup('unit: render/ScrollRectWindow', checkScrollRectWindow);
registerGroup('unit: render/ScrollRectBake', checkScrollRectBakeInvalidation);
// ---- 阶段二百八十三: a collected object must give back the C++ resources it owns ----
//
// The behavioural oracle is examples/gc-image-free.as (39 pages of 1920x1080, dropped
// without dispose the way the meeting client drops them: RSS +341 MB with
// ASC_NO_FINAL=1, +42 MB without). What a memory reading cannot show is the WIRING,
// and the wiring is where this defect lived for as long as the renderer cached
// anything: an SkImage is malloc'd/C++ memory, so the collector has no idea a dying
// BitmapData still owns one.
//
// Pin the four halves that make the hook correct rather than merely present:
//   1. the sweeper calls it for a WHITE (unreachable) block, with the payload address
//      that owners register against;
//   2. every delete of an owner-held image is preceded by as_final_release, so the
//      owner's death cannot delete it a second time (a double SkImage release is a
//      crash, not a leak);
//   3. every creation site registers, so none of the four ways to give a BitmapData an
//      image silently falls back to leaking;
//   4. the baked surface snapshot (DisplayObject._cache_image) is on the same list.
function checkImageFinalizer(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [imgfinal] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [imgfinal] ${label}`); }
  };
  const src = [
    'import flash.display.Sprite;',
    'import flash.display.Bitmap;',
    'import flash.display.BitmapData;',
    'var bd:BitmapData = new BitmapData(8, 8, false, 0x0000FF);',
    'var b:Bitmap = new Bitmap(bd);',
    'var s:Sprite = new Sprite();',
    's.addChild(b);',
    'bd.draw(s);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // 1. the sweep-side hook
  const swStart = c.indexOf('static bool gc_sweep_step(');
  const swEnd = swStart < 0 ? -1 : c.indexOf('\nstatic ', swStart + 10);
  const sweep = swStart < 0 || swEnd < 0 ? '' : c.slice(swStart, swEnd);
  check('the sweeper runs the finalizer before recycling a block',
    sweep.includes('as_final_on_free((char*)h + sizeof(gc_header));'));
  check('...only for a WHITE (unreachable) block, inside that branch',
    sweep.indexOf('if (h->color == GC_WHITE) {') >= 0
    && sweep.indexOf('if (h->color == GC_WHITE) {') < sweep.indexOf('as_final_on_free('));
  check('...using the payload address, i.e. exactly what owners register',
    sweep.includes('(char*)h + sizeof(gc_header)')
    && c.includes('void* body = (void*)((char*)h + sizeof(gc_header));'));

  // 2. the hook itself
  check('the hook deletes the registered image and forgets the entry',
    c.includes('static void as_final_on_free(void* owner) {') && c.includes('as_skia_image_delete(res);'));
  check('...and is a no-op while nothing is registered (a hot path: one compare)',
    c.includes('if (ASC_final_used == 0 || !as_final_on()) return;'));
  check('the leak is reproducible on the same binary (ASC_NO_FINAL=1)',
    c.includes('static int as_final_disabled = -1;') && c.includes('getenv("ASC_NO_FINAL")'));

  // 3. every delete of an owner-held image releases first (no double free)
  const liveStart = c.indexOf('as_bmd_live_image(');
  const liveDef = c.lastIndexOf('static void* as_bmd_live_image(');
  const liveEnd = liveDef < 0 ? -1 : c.indexOf('\nstatic ', liveDef + 10);
  const live = liveDef < 0 || liveEnd < 0 ? '' : c.slice(liveDef, liveEnd);
  check('as_bmd_live_image is emitted', liveStart >= 0 && live.length > 0);
  check('...releases the old view before deleting it',
    live.includes('as_final_release(bd, bd->_live_image)')
    && live.indexOf('as_final_release(bd, bd->_live_image)') < live.indexOf('as_skia_image_delete(bd->_live_image)'));
  check('...and registers the new one', live.includes('as_final_register(bd, bd->_live_image);'));

  const disStart = c.indexOf('void BitmapData_dispose(void* _this) {');
  const disEnd = disStart < 0 ? -1 : c.indexOf('\nstatic ', disStart + 10);
  const dispose = disStart < 0 || disEnd < 0 ? '' : c.slice(disStart, disEnd);
  check('BitmapData.dispose releases both registrations before deleting',
    dispose.includes('as_final_release(bd, bd->image)')
    && dispose.includes('as_final_release(bd, bd->_live_image)')
    && dispose.indexOf('as_final_release(bd, bd->image)') < dispose.indexOf('as_skia_image_delete(bd->image)')
    && dispose.indexOf('as_final_release(bd, bd->_live_image)') < dispose.indexOf('as_skia_image_delete(bd->_live_image)'));

  // Each creation site lives in its own emitted function, so pin the function rather
  // than a global count: the Loader body registers ONCE for both of its arms (bytes and
  // file), which is correct and would look like a missing site under a 1:1 count.
  // Skip forward declarations: the emitted C declares the loaders before defining
  // them, so the first "name(" is a prototype whose "{" belongs to another function.
  const fnBody = (name: string): string => {
    let at = c.indexOf(name + '(');
    while (at >= 0) {
      const open = c.indexOf('{', at);
      const semi = c.indexOf(';', at);
      if (open >= 0 && (semi < 0 || open < semi)) {
        const close = c.indexOf('\n}', open);
        return close < 0 ? '' : c.slice(open, close);
      }
      at = c.indexOf(name + '(', at + 1);
    }
    return '';
  };
  const loader = fnBody('Loader__imageFinish');
  check('the Loader COMPLETE decode registers the view it just decoded',
    loader.includes('bd->image = as_skia_image_from_') && loader.includes('as_final_register(bd, bd->image);'));
  const loadFile = fnBody('BitmapData_loadFile');
  check('the local loadFile decode registers too',
    loadFile.includes('bd->image = as_skia_image_from_file(path);') && loadFile.includes('as_final_register(bd, bd->image);'));
  check('the embedded/SWC adopt path registers (when that emitter is present)',
    c.indexOf('BitmapData_adoptEncodedAlpha') < 0
    || fnBody('BitmapData_adoptEncodedAlpha').includes('as_final_register(bd, bd->image);'));
  // 4. the baked surface snapshot
  const bakeStart = c.indexOf('static void as_render_cached(void* canvas, DisplayObject* o) {');
  const bakeEnd = bakeStart < 0 ? -1 : c.indexOf('\nstatic ', bakeStart + 10);
  const bake = bakeStart < 0 || bakeEnd < 0 ? '' : c.slice(bakeStart, bakeEnd);
  check('a bake registers its surface snapshot with the finalizer',
    bake.includes('as_final_register(o, o->_cache_image);'));
  check('...and releases the previous one before replacing it',
    bake.includes('as_final_release(o, o->_cache_image)')
    && bake.indexOf('as_final_release(o, o->_cache_image)') < bake.indexOf('o->_cache_image = as_skia_surface_make_snapshot(surface);'));
  check('cacheAsBitmap = false releases its registration too',
    /void DisplayObject_set_cacheAsBitmap[\s\S]{0,600}as_final_release\(o, o->_cache_image\)/.test(c));

  console.log(`[imgfinal] ${ok} image-finalizer checks passed`);
  return bad;
}

// ---- G29: clipping a SUBTREE (the compiler half of `overflow: hidden`) ----
//
// The behavioural oracle is examples/overflow-clip.as (ten pixel cases measured against
// adl 51.4.1 in temp/g29/: a 200-wide child inside a 120-wide parent paints x=20..139
// under scrollRect AND under mask, and the grandchild, the straddling stroke, a
// BlurFilter's spill, a cacheAsBitmap bake, nested clips and a TextField child are all
// cut at the same edge). What a pixel test cannot say is WHY that still holds after a
// refactor: it would keep passing while a future change re-introduced a clip that
// wrapped only the object's own geometry. So pin the SCOPE -- the clip is entered
// before the content call and left after it, and the two clip sources compose.
function checkOverflowClip(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [overflowclip] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [overflowclip] ${label}`); }
  };
  const src = [
    'import flash.display.Sprite;',
    'import flash.geom.Rectangle;',
    'var s:Sprite = new Sprite();',
    's.scrollRect = new Rectangle(0, 0, 120, 28);',
    'trace(s.scrollRect.y);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // The scrollRect clip must enclose as_render_object_content (own geometry AND the
  // children it recurses into), not just the object's own draws.
  // Stage 349 renamed the entry point (see ScrollRectWindowRounding); the SCOPE is what
  // this group pins, so either name is acceptable here.
  const clipAt = /as_skia_canvas_clip_rect(?:_window)?\(canvas, 0\.0, 0\.0, o->_scroll_rect->width, o->_scroll_rect->height\);/.exec(c)?.index ?? -1;
  const contentAt = c.indexOf('as_render_object_content(canvas, o);', clipAt < 0 ? 0 : clipAt);
  const restoreAt = c.indexOf('if (scroll_on) as_skia_canvas_restore(canvas);', clipAt < 0 ? 0 : clipAt);
  check('the scrollRect clip is entered before the content call', clipAt >= 0 && contentAt > clipAt);
  check('...and left only after it, so the whole subtree is inside the clip',
    restoreAt > contentAt && contentAt >= 0);

  // The mask is a SIBLING, so its stencil is built in parent space and clipped before
  // the object's own translate -- otherwise a mask would follow the masked object and
  // the two would drift apart on every move (measured, temp/maskprobe).
  const maskAt = c.indexOf('if (o->_mask_ref != NULL) {');
  const maskClip = c.indexOf('as_skia_canvas_clip_path(canvas, mp, 1);', maskAt < 0 ? 0 : maskAt);
  const translateAt = c.indexOf('as_skia_canvas_translate(canvas, o->x, o->y);', maskAt < 0 ? 0 : maskAt);
  check('the mask stencil is clipped before the object transform', maskAt >= 0 && maskClip > maskAt && translateAt > maskClip);
  // A binary clipPath, not an alpha mask: adl does NOT attenuate by a 50% mask's alpha
  // (temp/g29 H: a 50%-green mask leaves the content at 0xff0000), and an alpha stencil
  // would halve it.
  check('the mask is a binary clipPath (adl does not attenuate by the mask alpha)',
    !c.includes('as_skia_canvas_clip_alpha_image') &&
    c.includes('as_skia_canvas_clip_path(canvas, mp, 1);'));

  // Both sources can be armed at once (a masked, scrolled container) and the nesting
  // order does not matter to the result, but each must have its own save/restore pair
  // or the restore below would drop the wrong scope.
  const objStart = c.indexOf('static void as_render_object(void* canvas, DisplayObject* o) {');
  const firstSave = c.indexOf('as_skia_canvas_save(canvas);', objStart);
  const saveGap = firstSave < 0 || maskAt < 0 ? 'x' : c.slice(firstSave, maskAt);
  check('the outer save comes before the mask clip, with no restore in between',
    firstSave >= 0 && firstSave < maskAt && !saveGap.includes('as_skia_canvas_restore'));
  check('the scrollRect scope opens its own save (it must be popped by its own restore)',
    /if \(scroll_on\) \{\s*as_skia_canvas_save\(canvas\);/.test(c));

  console.log(`[overflowclip] ${ok} subtree-clip checks passed`);
  return bad;
}
registerGroup('unit: render/OverflowClip', checkOverflowClip);
registerGroup('unit: render/SvgChannel', checkSvgChannel);
registerGroup('unit: render/ImageFinalizer', checkImageFinalizer);
registerGroup('unit: render/FontMetrics', checkFontMetrics);
registerGroup('unit: render/TextWrap', checkTextWrap);
registerGroup('unit: render/BorderWidth', checkBorderWidth);
registerGroup('unit: render/BakeResolution', checkBakeResolution);
registerGroup('unit: render/ColorPath', checkColorPath);
registerGroup('unit: render/FilterRaster', checkFilterRaster);
registerGroup('unit: render/SwcTimeline', checkSwcTimeline);
registerGroup('unit: swc/DocumentClass', checkSwcDocumentClass);
registerGroup('unit: render/SwcJpeg3Alpha', checkSwcJpeg3Alpha);
registerGroup('unit: render/AirAppFonts', checkAirAppFonts);
registerGroup('unit: render/SkiaAbi', checkSkiaAbi);
registerGroup('unit: render/FrameCanvasHygiene', checkFrameCanvasHygiene);
registerGroup('unit: render/PresentSkip', checkPresentSkip);
registerGroup('unit: render/AlphaLayerBalance', checkAlphaLayerBalance);

// ---- 阶段三百一十五: a single-primitive object folds its alpha into the paint ----
//
// AIR has no alpha LAYER at the display-object level: it multiplies the alpha into
// each paint, so a translucent row costs one extra blend there and one offscreen
// surface here. Measured on the meeting client's chat list (output/perf/chat, 192
// rows on the same machine, process CPU per frame): 14.5 us per translucent Shape
// with the layer, 2.0 us once folded -- and the frame slope fell from 20.0 to
// 8.1 us per row, which is the whole regression this stage is about.
//
// The fold is only legal where the subtree paints exactly ONE primitive: with two
// overlapping primitives a layer isolates the group from the backdrop while
// per-paint alpha double-blends the overlap. temp/alphafold/ is the pixel oracle
// for both branches (adl vs AOT, sampled through BitmapData.draw); these checks
// pin the C shape that makes that oracle reachable.
function checkAlphaFold(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [alphafold] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [alphafold] ${label}`); }
  };
  const c = generateC(parse('var n:int = 1;\n')).c;
  const pre = RUNTIME_PREAMBLE;
  const glue = readGlue();

  // 1. What qualifies. Every exclusion below was found the hard way: a mask has no
  //    pixels of its own, a filter needs the isolated layer it composites through,
  //    opaqueBackground already paints an opaque rect behind the content, and a
  //    TextField draws one primitive per glyph run (overlapping AA coverage).
  const at = c.indexOf('static int as_draw_count(DisplayObject* o) {');
  const fn = at < 0 ? '' : c.slice(at, c.indexOf('\n}', at));
  check('the fold predicate is emitted',
    at >= 0 && c.includes('static int as_single_primitive(DisplayObject* o) { return as_draw_count(o) == 1; }'));
  check('...and refuses masks, filters and opaqueBackground',
    fn.includes('o->_mask_object') && fn.includes('o->filters != NULL') && fn.includes('as_v_is_number(o->opaqueBackground)'));
  check('...and counts a Bitmap with a real image as ONE primitive',
    fn.includes('&Bitmap_vt') && fn.includes('as_bmd_visible_image'));
  check('...and counts the whole SUBTREE: own Graphics draws plus every child, capped at 2',
    fn.includes('as_graphics_of(o)')
    && fn.includes('n += as_draw_count((DisplayObject*)as_v_obj_val(c->children->data[i]));')
    && fn.includes('return n > 1 ? 2 : n;'));
  check('...and never folds a TextField (counted as 2)',
    fn.includes('if (as_is((void*)o, &TextField_vt)) return 2;'));
  check('...and assumes an unknown leaf paints through a path the fold cannot reach',
    fn.includes('if (!as_is((void*)o, &Shape_vt) && !as_is((void*)o, &Sprite_vt) && !as_is((void*)o, &MorphShape_vt) && !as_is((void*)o, &StaticText_vt)) return 2;'));

  // 2. The renderer wires it to the SAME condition as the layer (see the
  //    AlphaLayerBalance pins) and restores the multiplier on that path.
  check('the renderer saves the incoming multiplier before deciding',
    c.includes('double keep_alpha_mul = ASC_alpha_mul;') && c.includes('int alpha_fold = (alpha_on && as_single_primitive(o));'));

  // 3. A bake snapshot must hold UNFOLDED content: the object's own alpha is
  //    applied once, on the blit of the snapshot (or on its paints, when the bake
  //    is skipped). Resetting it inside the bake is what keeps alpha from being
  //    applied twice -- a baked 0.5 object with 0.5 folded into its content came
  //    out at 0.25.
  const bakeResets = (c.match(/ASC_alpha_mul = 1\.0;/g) ?? []).length;
  check('both bake passes reset the multiplier to 1 (image-rect bake + nine-slice bake)',
    bakeResets >= 2 && c.includes('double keep_bx = ASC_bake_ctm_x, keep_by = ASC_bake_ctm_y, keep_am = ASC_alpha_mul;'));
  check('...and restore it after the snapshot',
    (c.match(/ASC_bake_ctm_x = keep_bx; ASC_bake_ctm_y = keep_by; ASC_alpha_mul = keep_am;/g) ?? []).length >= 2);

  // 4. The seam. Three primitives are reachable from a foldable object; each
  //    wrapper must dispatch on the multiplier, and the no-Skia build must still
  //    compile the same call sites.
  for (const [name, fn] of [['rect', 'as_skia_canvas_draw_rect'], ['path', 'as_skia_canvas_draw_path'], ['image_rect', 'as_skia_canvas_draw_image_rect']]) {
    check(`the ${name} wrapper dispatches on ASC_alpha_mul`, pre.includes(`if (ASC_alpha_mul < 1.0)`) && pre.includes(`sk_canvas_draw_${fn === 'as_skia_canvas_draw_image_rect' ? 'image_rect' : name}_mul(`));
    check(`the glue has the folded ${name} entry point`, glue.includes(`void sk_canvas_draw_${fn === 'as_skia_canvas_draw_image_rect' ? 'image_rect' : name}_mul(`));
  }
  check('a build without Skia still declares the multiplier (one definition, both builds)',
    (pre.match(/static double ASC_alpha_mul = 1\.0;/g) ?? []).length === 2);

  // 5. The folded paint must be a COPY of the source paint, and the multiplier
  //    must be quantized to AIR's 8-bit coverage. Both are pixel-visible:
  //    mutating the source keeps a shared Graphics paint dimmed for every later
  //    object, and setAlphaf's rounding turned every 0.5 fill one step brighter
  //    than adl (0x80 vs 0x7f).
  check('the folded entries copy the caller\'s paint instead of mutating it',
    /void sk_canvas_draw_path_mul\(void\* canvas, void\* path, void\* paint, double mul\) \{\s*SkPaint p = \*\(const SkPaint\*\)paint;/.test(glue)
    && /void sk_canvas_draw_rect_mul\([\s\S]{0,200}SkPaint p = \*\(const SkPaint\*\)paint;/.test(glue));
  check('the multiplier is quantized to the 8-bit alpha AIR applies',
    /static void sk_paint_mul_alpha\(SkPaint\* p, double mul\) \{[\s\S]{0,300}?\(int\)\(mul \* 255\.0\)/.test(glue));

  console.log(`[alphafold] ${ok} alpha-fold checks passed`);
  return bad;
}
registerGroup('unit: render/AlphaFold', checkAlphaFold);

// ---- SWC symbol classes bound to a PROJECT base class (阶段一百九十一) ---------
//
// A code library can export a symbol whose Flash class extends one of the LIBRARY's
// own widget classes — and when the project compiles that same class from source, the
// behaviour belongs to the project (`AIAsrComBox` extends
// `com.example.controls.ComBoBox`, and the app's own `ComBoBox.as` is that class).
// Before this stage the synthesized class was always a `MovieClip`/`SimpleButton`
// subclass, so the symbol rendered but its widget never ran. These pins hold the whole
// chain: the superclass is read out of the DoABC, carried through the library, used as
// the class's base, and that class's source is seeded into the reachability closure.
function checkSwcBaseClass(): string[] {
  const bad: string[] = [];
  const ck = (ok: boolean, msg: string): void => { if (!ok) bad.push(msg); };
  const readSrc = (rel: string): string => readFileSync(join(root, 'src', rel), 'utf8');
  const abc = readSrc('abc.ts');
  const swc = readSrc('swc.ts');
  const index = readSrc('index.ts');
  const reach = readSrc('reach.ts');
  const rt = readSrc('runtime.ts');
  const emit = readSrc('emit.ts');

  // --- what the ABC tells us about a symbol class: its base AND its dynamic trait ---
  ck(/const base = mnAt\(r\.u30\(\)\);/.test(abc) && /baseNames\.push\(/.test(abc) &&
    /superName: baseNames\[i\],/.test(abc),
    "abc.ts reads each instance's super multiname instead of discarding it");
  ck(/const flags = r\.u8\(\);\s+instanceFlags\.push\(flags\);/.test(abc) &&
    /flags: instanceFlags\[i\],/.test(abc),
    '...and keeps the InstanceInfo flags byte, which is what AVM2 derives `dynamic` from');
  ck(/if \(\(flags & 0x08\) !== 0\) r\.u30\(\);/.test(abc),
    'the protectedNs index stays consumed -- it is not the sealed bit (skin.swc uses both 0x08 and 0x09)');
  ck(/interface AbcSymbolBase \{/.test(abc) && /baseName: string;/.test(abc) && /dynamic: boolean;/.test(abc),
    'AbcSymbolBase carries both the superclass name and the dynamic trait');
  ck(/if \(onBase\) onBase\(\{ baseName: inst\.superName, dynamic: \(inst\.flags & 0x05\) === 0 \}\);/.test(abc),
    'a class with neither the sealed nor the interface bit is dynamic (AVM2 rule, not an inference)');
  ck(/function decodeSymbolClass\(abc: Buffer, className: string, onBase\?: \(base: AbcSymbolBase\) => void\)/.test(abc),
    '...reported even when the scripts themselves cannot be decoded');
  ck(/bases: Map<number, AbcSymbolBase> \}/.test(abc) && /const bases = new Map<number, AbcSymbolBase>\(\);/.test(abc),
    'decodeSymbolScripts returns those bases keyed by character id');
  ck(/bases: Map<number, AbcSymbolBase>;/.test(swc) && /scripts: scriptsDecoded, bases: scriptBases,/.test(swc),
    'swc.ts carries them on the extracted library');

  // --- binding the symbol to a project base class (the stage-191 fix) ---
  ck(/const base = lib\.bases\.get\(charId\) \?\? \{ baseName: '', dynamic: false \};/.test(swc) &&
    /const baseName = availableProjectBase\(base\.baseName, hasProjectClass\);/.test(swc) &&
    /swcDisplayClassDecl\(name, pkg, kind, script, baseName, base\.dynamic\)/.test(swc),
    'the character binding reports each symbol class its base AND its dynamic trait');
  ck(/if \(baseName\.length === 0 \|\| baseName\.startsWith\('flash\.display\.'\)\) return '';/.test(swc) &&
    /if \(hasProjectClass\(baseName\)\) return baseName;/.test(swc) &&
    /const projectBase = baseName\.length > 0 && !baseName\.startsWith\('flash\.display\.'\) \? baseName : '';/.test(swc),
    'a base the project compiles from source outranks the stock artwork superclass -- and only when it compiles it');
  ck(/export function swcCompileInputs\(\s*lib: SwcLibrary,/.test(swc) &&
    /hasProjectClass: \(fqn: string\) => boolean = \(\) => false/.test(swc) &&
    /const declaredFqn = new Set<string>\(\)/.test(index) &&
    /swcCompileInputs\(lib, \(fqn\) => declaredFqn\.has\(fqn\)\)/.test(index),
    'the caller supplies that answer from the sources it is compiling (index.ts), and the artwork-only default says "no"');
  ck(/superClass: projectBase\.length > 0 \? splitFqn\(projectBase\)\.name : builtin,/.test(swc),
    '...and becomes the synthesized class superclass (short name, as a source `extends` clause)');
  ck(/projectBase\.length > 0 \? projectBase : builtin,/.test(swc),
    '...with the fully-qualified name in the import list, which is how the semantic layer resolves it');

  // --- the stage-192 fix: reproduce the ABC's own `dynamic`, never inherit it ---
  //
  // Inheriting was the trap. Before this, the trait came from the base chain, and the
  // base was `flash.display.MovieClip` (dynamic) -- so every symbol owned a `_dyn`
  // table by accident, and the bug stayed invisible until a symbol was bound to a
  // project widget (a SEALED `Sprite` subclass). A sealed instance has nowhere for the
  // baker to put the timeline children, so `this["title"]` inside the bound base
  // raised #1069 (CreateAiSubTitleView sets `selectData` before `addChild`).
  ck(/isDynamic: dynamic,/.test(swc),
    'the synthesized class reproduces the ABC dynamic trait instead of inheriting it from the base');
  const declBody = swc.slice(swc.indexOf('function swcDisplayClassDecl'), swc.indexOf('isDynamic: dynamic,'));
  ck(/must OWN a dynamic property table/.test(declBody),
    'the reason is written down next to the field (an own table, not an inherited one)');

  // --- the two halves that actually make `this["title"]` resolve at runtime ---
  // 阶段二百三十五: the slot is no longer appended at the end of EVERY class in the
  // chain (which let a subclass own field share its offset); the class that
  // INTRODUCES the dynamic trait emits it, subclasses inherit it at that offset.
  ck(/if \(this\.trailingSlotOwner\(cls, \(c\) => this\.symbols\.getClass\(c\)\?\.isDynamic === true\) === cls\) {/.test(emit) &&
    /out\.push\('as_object\* _dyn;'\);/.test(emit) &&
    /for \(const slot of this\.trailingSlotLines\(cls\)\) this\.line\(slot\);/.test(emit),
    'a dynamic class gets the `_dyn` slot table in its C struct (flattened into the class that introduces it)');
  ck(/const dynOffset = info\.isDynamic \? `\(int\)offsetof\(\$\{name\}, _dyn\)` : '-1';/.test(emit),
    '...and a non-negative vtable dyn_offset, which is how as_dyn_get decides it may look there');
  ck(/static void as_swc_child_name\(void\* parent, const char\* name, void\* child\)/.test(rt) &&
    /if \(hv->dyn_offset < 0\) return;/.test(rt) && /as_object_set\(dyn, name, as_v_obj\(child\)\);/.test(rt),
    'the baker registers each named timeline child in exactly that table (and no-ops when sealed)');
  ck(/as_swc_child_name\(\(void\*\)\(/.test(emit),
    '...and the emitter calls it for every named placement');

  // Behavioural: build a library in memory. The symbols differ only in the base their
  // DoABC declares and in the flags byte, so the emitted declarations answer exactly
  // the question the fix is about.
  const mkLib = (bases: [number, string, boolean][]): SwcLibrary =>
    ({
      source: 'probe.swc',
      bitmaps: [], shapes: [], morphs: [],
      sprites: [
        { id: 230, frames: 1, placements: [], frameStarts: [0], labels: [] },
        { id: 231, frames: 1, placements: [], frameStarts: [0], labels: [] },
        { id: 233, frames: 1, placements: [], frameStarts: [0], labels: [] },
      ],
      buttons: [{ id: 232, trackAsMenu: false, records: [] }],
      texts: [], fonts: new Map(), scalingGrids: new Map(),
      classNames: new Map([[230, 'probeWidget'], [231, 'probeArt'], [232, 'probeBtn'], [233, 'probeSealed']]),
      characters: new Map([
        [230, { id: 230, kind: 'sprite', tag: 39 }],
        [231, { id: 231, kind: 'sprite', tag: 39 }],
        [232, { id: 232, kind: 'button', tag: 34 }],
        [233, { id: 233, kind: 'sprite', tag: 39 }],
      ]),
      scripts: new Map(),
      bases: new Map(bases.map(([id, n, d]) => [id, { baseName: n, dynamic: d }])),
    }) as unknown as SwcLibrary;

  const lib = mkLib([
    [230, 'com.example.controls.ComBoBox', true],
    [231, 'flash.display.MovieClip', true],
    [232, 'flash.display.SimpleButton', true],
    [233, 'flash.display.MovieClip', false],
  ]);
  // The caller answers "does THIS compilation provide that class" (index.ts passes the
  // set of sources it is compiling). Here the base is provided -- that is the app case.
  const provided = (fqn: string): boolean => fqn === 'com.example.controls.ComBoBox';
  const inputs = swcCompileInputs(lib, provided);
  type Decl = { kind: string; name: string; superClass?: string | null; isDynamic?: boolean; imports?: string[] };
  const declOf = (n: string): Decl | undefined =>
    (inputs.decls as unknown as Decl[]).find((d) => d.kind === 'ClassDecl' && d.name === n);
  const widget = declOf('probeWidget');
  const art = declOf('probeArt');
  const btn = declOf('probeBtn');
  const sealed = declOf('probeSealed');
  ck(widget !== undefined && widget.superClass === 'ComBoBox',
    'a symbol based on a project class is emitted as a subclass of THAT class');
  // The other half of the same rule, and the reason it exists: a base the compilation
  // does NOT provide cannot even be declared (`unknown superclass`), because the
  // library's own copy of that class is ABC we do not compile (swc.md §3.3). Falling
  // back to the artwork superclass is announced, never silent -- five SWC examples and
  // the whole `render/SwcTimeline` group broke on this before the fallback existed.
  {
    const errs: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (chunk: string): boolean => { errs.push(String(chunk)); return true; };
    let missing: ReturnType<typeof swcCompileInputs>;
    try { missing = swcCompileInputs(lib); } finally {
      (process.stderr as unknown as { write: unknown }).write = realWrite;
    }
    const mw = (missing.decls as unknown as Decl[]).find((d) => d.kind === 'ClassDecl' && d.name === 'probeWidget');
    ck(mw !== undefined && mw.superClass === 'flash.display.MovieClip' &&
      (mw.imports ?? []).length === 1 && mw.imports?.[0] === 'flash.display.MovieClip',
      'a base this compilation does NOT provide falls back to the artwork superclass (and drops the dangling import)');
    ck(missing.chars[0].baseName === '',
      '...and the character spec drops it too, so nothing downstream still names the absent class');
    ck(errs.filter((e) => e.includes("extends 'com.example.controls.ComBoBox'")).length === 1,
      '...loudly, once per missing base, never silently');
    ck(mw?.isDynamic === true,
      '...while the ABC dynamic trait is still reproduced (the fallback changes the base, not the trait)');
  }
  ck(widget !== undefined && (widget.imports ?? []).includes('com.example.controls.ComBoBox'),
    '...with the base imported so symbol collection resolves it');
  ck(art !== undefined && art.superClass === 'flash.display.MovieClip',
    '...while an artwork-only symbol keeps MovieClip (nothing changes for the 194 others)');
  ck(widget?.isDynamic === true,
    'the dynamic symbol class stays dynamic even though its project base (a sealed Sprite subclass) is not');
  ck(btn?.isDynamic === true,
    'a BUTTON symbol is dynamic too -- SimpleButton is sealed, so inheriting would silently reseal it');
  ck(sealed?.isDynamic === false,
    'a symbol whose ABC really is sealed stays sealed (the trait is reproduced, not forced on)');
  ck(inputs.chars.length === 4 && inputs.chars[0].baseName === 'com.example.controls.ComBoBox',
    'the emitted character spec carries the base too (the emitter can report on it)');
  ck(inputs.chars[0].dynamic === true && inputs.chars[3].dynamic === false,
    '...and the dynamic trait, so the bake can report a sealed symbol loudly');

  // Behavioural, source -> C: the same declarations through the real emitter. The
  // AST field is not the fix on its own -- the trait has to reach the generated
  // struct and vtable, which is what as_dyn_get and as_swc_child_name read.
  const prog = parse(
    'package com.example.controls {\n' +
      '  import flash.display.Sprite;\n' +
      '  public class ComBoBox extends Sprite {\n' +
      '    public function ComBoBox(maxheight:int = -1) { super(); }\n' +
      '  }\n' +
      '}\n' +
      'var a:probeWidget = new probeWidget();\n' +
      'var b:probeBtn = new probeBtn();\n' +
      'var d:probeSealed = new probeSealed();\n',
  );
  prog.body.push(...inputs.decls);
  const c = generateC(prog, [], inputs.specs, swcBakePlan(lib, inputs.specs, inputs.chars)).c;
  const ctorOf = (n: string): string => {
    const m = new RegExp(`static void ${n}_ctor\\(${n}\\* o\\) \\{([\\s\\S]*?)\\n\\}`).exec(c);
    return m ? m[1] : '';
  };
  const vtableOf = (n: string): string => {
    const m = new RegExp(`static ${n}_vtable ${n}_vt = \\{([\\s\\S]*?)\\n\\};`).exec(c);
    return m ? m[1] : '';
  };
  ck(/_dyn = as_object_new\(\)/.test(ctorOf('probeWidget')) &&
    /com_example_controls_ComBoBox_ctor\(\(com_example_controls_ComBoBox\*\)o, \(-1\)\);/.test(ctorOf('probeWidget')) &&
    /as_swc_bind\(\(DisplayObject\*\)o, 230\);/.test(ctorOf('probeWidget')),
    'the bound symbol compiles to a ctor that initialises `_dyn`, runs the project base ctor, then bakes its own artwork');
  ck(/offsetof\(probeWidget, _dyn\)/.test(vtableOf('probeWidget')) && /"probeWidget", 0, 1, 0,/.test(vtableOf('probeWidget')),
    '...and its vtable carries a non-negative dyn_offset with isDynamic=1');
  ck(/offsetof\(probeBtn, _dyn\)/.test(vtableOf('probeBtn')) && /"probeBtn", 0, 1, 0,/.test(vtableOf('probeBtn')),
    'a button symbol is dynamic too (SimpleButton is sealed, so only the ABC trait can make it so)');
  ck(/_dyn = as_object_new\(\)/.test(ctorOf('probeSealed')),
    'a symbol that declares itself sealed but extends the dynamic MovieClip still owns a table -- the inheritance that used to hide this bug');

  ck(/\[\.\.\.cfg\.swcPaths, \.\.\.\(opts\.overrides\.swcPaths \?\? \[\]\)\]/.test(index),
    '--air-app seeds the closure with those bases, including a CLI-only --swc');
  // The roots are the SWC bases PLUS the manifest/`--extra-roots` list: a class
  // that only a getDefinitionByName string names has no reference edge, so the
  // closure cannot see it and would drop it from the compile face.
  ck(/computeReachable\(parsedFiles, air\.mainClass, \[\.\.\.swcBaseRoots, \.\.\.cfg\.extraRoots\]\)/.test(index),
    '...and passes them (plus extra-roots) to the closure computation');
  ck(/extraRoots: readonly string\[\] = \[\]/.test(reach) && /for \(const r of extraRoots\)/.test(reach),
    'reach.ts keeps the extra roots in the kept set');
  ck(/const swcLibs = new Map<string, SwcLibrary>\(\)/.test(index) && /const lib = swcLib\(libPath\);/.test(index),
    'each library is parsed once and shared (the closure and the emitter see the same parse)');
  return bad;
}
registerGroup('unit: swc/BaseClassBinding', checkSwcBaseClass);

// ---------------------------------------------------------------------------
// unit: render/SwcMorph -- DefineMorphShape bake + emit shape.
//
// The example `examples/swc-morph.as` pins the display-box contract against the
// real skin.swc, but AIR gives no AS3-readable outlet for "which ratio is the
// geometry at" (the only one is pixels, and every morph in that library is a
// clipDepth mask), so the interpolation itself can only be pinned here, on the
// emitted C. The library is a hand-built SwcLibrary value: the bake reads the
// parse result, so no SWF encoding is needed to reach it.
// ---------------------------------------------------------------------------
function checkSwcMorphEmit(): string[] {
  const bad: string[] = [];
  const lib = {
    source: 'probe',
    bitmaps: [],
    shapes: [],
    // Twips: the start shape is 100x40 at (0,0), the end shape slides +10 px.
    morphs: [{
      id: 70,
      version: 1,
      bounds: { xmin: 0, xmax: 2000, ymin: 0, ymax: 800 },
      endBounds: { xmin: 200, xmax: 2200, ymin: 0, ymax: 800 },
      layers: [{
        // Index 0 is the "no style" slot, exactly as a parsed shape stores it.
        fills: [{ start: { type: 0 }, end: { type: 0 } }, { start: { type: 0 }, end: { type: 0 } }],
        lines: [],
      }],
      subpaths: [{
        layer: 0, fill0: 1, fill1: 1, line: 0, moveToFirst: true,
        start: { x: 0, y: 0 }, startE: { x: 200, y: 0 },
        pts: [
          { x: 2000, y: 0, xE: 2200, yE: 0 },
          { x: 2000, y: 800, xE: 2200, yE: 800 },
          { x: 0, y: 800, xE: 200, yE: 800 },
          { x: 0, y: 0, xE: 200, yE: 0 },
        ],
      }],
    }],
    sprites: [{
      id: 74, frames: 2, frameStarts: [1, 2], labels: [],
      placements: [
        // Frame 1 places the morph with NO ratio record (the SWF default is 0).
        {
          depth: 1, charId: 70, move: false, name: null, matrix: [1, 0, 0, 1, 0, 0], cxform: null,
          clipDepth: null, hidden: false, visibleFlag: null, ratio: null, filters: [], skippedFilters: [],
        },
        // Frame 2 only carries the Ratio -- a "modify" record.
        {
          depth: 1, charId: null, move: true, name: null, matrix: null, cxform: null,
          clipDepth: null, hidden: false, visibleFlag: null, ratio: 32768, filters: [], skippedFilters: [],
        },
      ],
    }],
    buttons: [],
    texts: [],
    fonts: new Map(),
    scalingGrids: new Map(),
    classNames: new Map([[74, 'probeMorphClip']]),
    characters: new Map([[70, { kind: 'morph' }], [74, { kind: 'sprite' }]]),
    scripts: new Map(),
    bases: new Map(),
  } as unknown as SwcLibrary;

  const inputs = swcCompileInputs(lib);
  const bake = swcBakePlan(lib, inputs.specs, inputs.chars);
  const prog = parse('var _pad:int = 0;\n');
  prog.body.push(...inputs.decls);
  const c = generateC(prog, [], inputs.specs, bake).c;
  const check = (label: string, cond: boolean): void => { if (!cond) bad.push(label); };

  // ---- bake: two boxes, and they are NOT the same one ----
  const baked = bake.characters.find((ch) => ch.kind === 'morph') as { morph?: { bounds: { x: number; y: number; w: number; h: number }; decl: { x: number; y: number; w: number; h: number }; groups: unknown[] } } | undefined;
  const m = baked?.morph;
  check('the morph bakes to a real geometry (not an empty placeholder)',
    m !== undefined && m.groups.length > 0);
  check('the raster clip is the UNION of both shapes (110x40)', m !== undefined && m.bounds.w === 110 && m.bounds.h === 40);
  check('the reported box is the START shape only (100x40) -- what AIR pins to a MorphShape',
    m !== undefined && m.decl.w === 100 && m.decl.h === 40 && m.decl.x === 0 && m.decl.y === 0);

  // ---- emit: the two boxes reach two different fields ----
  check('the builder clips to the union and records the start box separately',
    c.includes('as_swc_clip(g, 0.0, 0.0, 110.0, 40.0);') &&
    c.includes('as_swc_morph_decl(g, 0.0, 0.0, 100.0, 40.0);'));
  check('_mdecl is a Graphics field, not a reuse of _clip (a plain Shape still answers _clip)',
    c.includes('int _mdecl;') && c.includes('{ "_mdecl", 4, offsetof(Graphics, _mdecl), NULL, NULL, 1, 0, 0 }'));
  check('as_bounds_walk answers the morph box for decl 1/2 but keeps raw geometry for hit tests',
    c.includes('if (g->_mdecl && decl != 0) {') &&
    c.includes('if (!as_bounds_walk(o, 0, 2, &l, &t, &r, &b)) return Rectangle_new(0.0, 0.0, 0.0, 0.0);'));

  // ---- emit: real interpolation, endpoint by endpoint ----
  check('every morphing coordinate is interpolated from BOTH stored positions',
    c.includes('as_swc_move_to(g, as_swc_lerp(0.0, 10.0, t), 0.0);') &&
    c.includes('as_swc_line_to(g, as_swc_lerp(100.0, 110.0, t), 40.0);'));
  // The one line that does the work: a lerp that ignored t would still emit both
  // endpoints and pass every text assertion above, and no AS3 API can read a
  // MorphShape.s geometry (see the header). So pin the helper body itself.
  check('as_swc_lerp actually blends (a + (b - a) * t)',
    c.includes('static double as_swc_lerp(double a, double b, double t) { return a + (b - a) * t; }'));
  check('a coordinate the two shapes agree on stays a constant (no pointless lerp)',
    c.includes('as_swc_move_to(g, as_swc_lerp(0.0, 10.0, t), 0.0);') &&
    !c.includes('as_swc_lerp(0.0, 0.0, t)'));

  // ---- emit: the ratio reaches the geometry, and a rewind resets it ----
  check('as_swc_morph_ratio clears then rebuilds at t = ratio/65535',
    c.includes(' Graphics_clear(g);\n  build(g, (double)ratio / 65535.0);'));
  check('the dispatcher knows the character',
    c.includes('case 70: as_swc_morph_ratio(o, as_swc_morph_70, ratio); break;'));
  check('the factory starts a morph at ratio 0',
    c.includes('case 70: { MorphShape* s = as_MorphShape_create(); as_swc_morph_70(s->_graphics, 0.0); return (DisplayObject*)s; }'));
  // The frame-1 builder is also the REWIND path (as_swc_tl_rewind -> as_swc_bind)
  // and it reuses the object that is already at that depth -- without this reset
  // a rewind kept the last frame's geometry (measured: rect.x stayed -4.95).
  check('a frame-1 placement of a morph applies ratio 0 even with no Ratio record',
    c.includes('DisplayObject* c0 = as_swc_tl_new(o, 1, 70);\n  as_swc_morph_apply(c0, 0);'));
  check('a Ratio-only record re-morphs that depth on its own frame',
    c.includes('as_swc_morph_apply(f2_0, 32768);'));

  // ---- the note tells the truth about the one deliberate deviation ----
  check('successful morph baking is informational, with no type-identity warning',
    (bake.info ?? []).some((n) => /MorphShape/.test(n)) && !bake.notes.some((n) => /class name does not/.test(n)));
  check('the notes report the animated ratios',
    (bake.info ?? []).some((n) => /carry a morph Ratio/.test(n)));

  return bad;
}
registerGroup('unit: render/SwcMorph', checkSwcMorphEmit);
// ---------------------------------------------------------------------------
// unit: render/SwcClipMaskPerFrame -- clipDepth masks are LIVE per frame.
//
// Before 阶段三百一十九 the baker froze frame 1's mask outline into a static
// `_clip_path`, which could not express three things the skin actually uses: a MORPH
// mask (its geometry follows PlaceObject2's Ratio), a SPRITE mask (the union of its
// children), and a mask the timeline moves or replaces. The baker now records only the
// mask's DEPTH; the renderer rebuilds the stencil from the live object every frame.
//
// The pixel contract lives in `examples/swc-mask-frames.as` (real skin.swc against
// adl 51.4.1); this group pins the wiring that makes it work.
// ---------------------------------------------------------------------------
function checkSwcClipMaskPerFrame(): string[] {
  const bad: string[] = [];
  // Three frames: depth 2 masks depths 3..4 with shape 70, frame 2 REPLACES depth 2
  // with a plain shape (the mask is retired), frame 3 puts the mask back.
  const place = (depth: number, charId: number | null, move: boolean, clipDepth: number | null) => ({
    depth, charId, move, name: null, matrix: charId === null ? null : [1, 0, 0, 1, 0, 0],
    cxform: null, clipDepth, hidden: false, visibleFlag: null, ratio: null, filters: [], skippedFilters: [],
  });
  const lib = {
    source: 'probe',
    bitmaps: [],
    shapes: [69, 70, 71, 73].map((id) => ({
      id, version: 4, bounds: { xmin: 0, xmax: 200, ymin: 0, ymax: 100 }, winding: false,
      layers: [{ fills: [{ type: 0 }, { type: 0 }], lines: [] }],
      subpaths: [{
        layer: 0, fill0: 1, fill1: 1, line: 0, moveToFirst: true,
        start: { x: 0, y: 0 },
        pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }],
      }],
    })),
    morphs: [],
    sprites: [{
      id: 74,
      frames: 3,
      labels: [],
      frameStarts: [3, 4, 5],
      placements: [
        place(1, 69, false, null),
        place(2, 70, false, 4),
        place(3, 71, false, null),
        place(2, 73, false, null),
        place(2, 73, false, 4),
      ],
    }],
    buttons: [],
    texts: [],
    fonts: new Map(),
    scalingGrids: new Map(),
    classNames: new Map([[74, 'probeFrameMask']]),
    characters: new Map([[69, { kind: 'shape' }], [70, { kind: 'shape' }], [71, { kind: 'shape' }], [73, { kind: 'shape' }], [74, { kind: 'sprite' }]]),
    scripts: new Map(),
    bases: new Map(),
  } as unknown as SwcLibrary;

  const inputs = swcCompileInputs(lib);
  const bake = swcBakePlan(lib, inputs.specs, inputs.chars);
  const prog = parse('var _pad:int = 0;\n');
  prog.body.push(...inputs.decls);
  const c = generateC(prog, [], inputs.specs, bake).c;
  const check = (label: string, cond: boolean): void => { if (!cond) bad.push(label); };

  // ---- bake: the frame-1 wiring knows the mask's DEPTH, not its geometry ----
  const sprite = bake.characters.find((ch) => ch.kind === 'sprite' && ch.id === 74) as
    { children?: { depth: number; mask?: { charId: number; depth: number } | null }[]; frames?: { ops: unknown[] }[] } | undefined;
  const masked = sprite?.children?.find((ch) => ch.depth === 3);
  check('the frame-1 child records the mask as { charId, depth } (no baked outline)',
    masked !== undefined && masked.mask !== undefined && masked.mask !== null &&
    masked.mask.depth === 2 && masked.mask.charId === 70 && !('matrix' in masked.mask));
  const frames = (sprite?.frames ?? []) as { ops: { mask?: { depth: number; clipDepth: number }; maskOff?: number; del?: boolean }[] }[];
  const f2 = frames[0]?.ops ?? [];
  const f3 = frames[1]?.ops ?? [];
  check('a later frame that drops the clipDepth releases the range (maskOff)',
    f2.some((op) => op.maskOff === 2) && !f2.some((op) => op.mask !== undefined));
  check('a later frame that re-declares it re-arms the range (mask)',
    f3.some((op) => op.mask !== undefined && op.mask.depth === 2 && op.mask.clipDepth === 4));

  // ---- emit: the frame-1 child is wired straight to its sibling object ----
  check('the sprite builder points the clipped child at the mask OBJECT (GC-barriered)',
    c.includes('// sprite-74: depth 3 is clipped by the mask object at depth 2.') &&
    c.includes('{ c2->_clip_src = c1; gc_write_barrier((void*)c2); }'));
  check('a mask is never painted itself', c.includes('c1->_mask_object = true;'));
  check('the timeline re-arms and retires the range through as_swc_tl_mask',
    c.includes('as_swc_tl_mask((DisplayObject*)o, 2, 4);') && c.includes('as_swc_tl_mask((DisplayObject*)o, 2, 0);'));
  // The SWF range is the OPEN-LOW interval (maskDepth, clipDepth]: the mask itself is
  // in it neither as a stencilled object nor as a stencil target.
  check('as_swc_tl_mask uses the (maskDepth, clipDepth] range of the SWF spec',
    c.includes('if (m != NULL && c->_tl_depth > maskDepth && c->_tl_depth <= clipDepth) { c->_clip_src = m; gc_write_barrier((void*)c); }'));
  check('as_swc_tl_mask releases only the stencil that belonged to that depth',
    c.includes('else if (c->_clip_src != NULL && c->_clip_src->_tl_depth == maskDepth) c->_clip_src = NULL;'));
  check('retiring the mask finds the depth first (clipDepth <= 0 means "no mask")',
    c.includes('DisplayObject* m = clipDepth > 0 ? as_swc_tl_find(p, maskDepth) : NULL;'));

  // ---- emit: the stencil is rebuilt from the live object ----
  check('as_clip_path maps the mask into parent space and closes the contours',
    /static void\* as_clip_path\(DisplayObject\* m\) \{[\s\S]{0,400}?as_do_matrix\(m, &a, &b, &c, &d, &tx, &ty\);/.test(c) &&
    /static void\* as_clip_path\(DisplayObject\* m\) \{[\s\S]{0,400}?as_mask_ink\(m, p, a, b, c, d, tx, ty\);\s*as_skia_path_close_all\(p\);/.test(c));
  // 'sk_canvas_clip_path' is the GLUE entry point and stays: what must be gone is the
  // baked field and its builder.
  check('the baked static outline is gone (no _clip_path field survives)',
    !c.includes('o->_clip_path') && !c.includes('as_swc_clip_path_new'));
  check('_clip_src is a DisplayObject* prop (so the GC walks it)',
    c.includes('{ "_clip_src", 11, offsetof(DisplayObject, _clip_src), (void*)&DisplayObject_vt, "flash.display::DisplayObject", 1, 0, 0 }'));

  // ---- the stencil is the mask's PAINTED geometry ----
  // Measured on skin.swc #74: the morph mask carries a second group that strokes the
  // same rectangle with width 0, and adding that invisible outline as well made the
  // stencil empty -- the masked sibling went blank while adl kept it.
  check('as_mask_ink only collects groups that actually paint',
    c.includes('if (dr->fill == NULL && (dr->stroke == NULL || dr->stroke_width <= 0.0)) continue;'));
  check('as_mask_ink adds the open tail group only when it paints too',
    c.includes('if (g->fill != NULL || (g->stroke != NULL && g->strokeWidth > 0.0)) as_skia_path_add_transformed(p, g->path, a, b, c, d, tx, ty);'));

  return bad;
}
registerGroup('unit: render/SwcClipMaskPerFrame', checkSwcClipMaskPerFrame);
// ---------------------------------------------------------------------------
// unit: render/ScrollRectWindowRoundsToEven -- the scrolling window's SIZE rule.
//
// Measured on adl 51.4.1 (temp/clipround, 24 cases): AIR quantizes
// scrollRect.width/height with ties-to-EVEN **in object units** (100.5 -> 100,
// 101.5 -> 102, 119.5/120.5 -> 120, 121.5/122.5 -> 122, 123.5 -> 124; a scale-2
// parent still spans 100.5*2 = 200 device px) and antialiases the window's own
// edges at the object's fractional device position (x=20.25/20.5/20.75 give
// 25/50/25% first-column coverage). We snapped half-UP in DEVICE space with
// antialiasing off (SkCanvas' *rect* clip overload defaults doAntiAlias=false),
// i.e. one column too many and a whole-pixel shift of the window at fractional
// origins. The behavioral half of this pin is examples/scrollrect-round.as; the
// structural half is here, because a pure-C build has no raster backend and the
// example self-skips.
function checkScrollRectWindowRounding(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [srwin] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [srwin] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.display.*;\nimport flash.geom.*;\n' +
    'var s:Sprite = new Sprite();\nvar b:Shape = new Shape();\ns.addChild(b);\n' +
    's.scrollRect = new Rectangle(0, 0, 100.5, 20.5);\n')).c;

  // ---- emit: the scrollRect branch uses the window entry point ----
  check('the scrollRect clip goes through as_skia_canvas_clip_rect_window',
    c.includes('as_skia_canvas_clip_rect_window(canvas, 0.0, 0.0, o->_scroll_rect->width, o->_scroll_rect->height);'));
  // The window must not be pre-quantized in the generated C: the rounding lives in
  // the glue, where the OBJECT-space rect is still existent before the CTM applies.
  check('the emitted width/height are the live scrollRect fields (no (int) cast at the call site)',
    !/as_skia_canvas_clip_rect_window\(canvas, 0\.0, 0\.0, \(double\)\(int\)/.test(c));
  // ...and the object-space rounding is what the scale-2 row proved: a device-space
  // rint would give 201 there.
  const glue = readGlue();
  check('the window clip rounds with rint (ties-to-even, FE_TONEAREST)',
    /void sk_canvas_clip_rect_window\(void\* canvas, double x, double y, double w, double h\) \{[\s\S]{0,400}?\(SkScalar\)rint\(w\), \(SkScalar\)rint\(h\)/.test(glue));
  check('the window clip antialiases (SkCanvas rect clip defaults to no AA)',
    /void sk_canvas_clip_rect_window\(void\* canvas[\s\S]{0,2000}?c->clipRect\(r, SkClipOp::kIntersect, true\);\n\}/.test(glue));
  // Whole-pixel windows must keep the cheap non-AA rect clip: an AA clip on every
  // scrolled list would be a silent per-frame regression for zero visual change.
  check('whole-device-pixel windows take the fast non-AA path',
    /axis_aligned[\s\S]{0,600}?d\.left\(\) == rintf\(d\.left\(\)\)/.test(glue) &&
    /d\.right\(\) == rintf\(d\.right\(\)\)[\s\S]{0,200}?c->clipRect\(r\);\n      return;/.test(glue));
  check('<cmath> is included for rint/rintf',
    glue.includes('#include <cmath>'));

  // ---- runtime seam: both the Skia build and the pure-C stub ----
  const pre = RUNTIME_PREAMBLE;
  check('the seam declares the glue entry point', pre.includes('extern void sk_canvas_clip_rect_window('));
  check('the Skia build forwards to it', pre.includes('static inline void as_skia_canvas_clip_rect_window(void* c, double x, double y, double w, double h) { sk_canvas_clip_rect_window(c, x, y, w, h); }'));
  check('the no-Skia build has a stub (the example then self-skips)',
    pre.includes('static inline void as_skia_canvas_clip_rect_window(void* c, double x, double y, double w, double h) { (void)c; (void)x; (void)y; (void)w; (void)h; }'));
  // The plain entry point keeps its (half-UP, no-AA) behavior for its other callers
  // -- TextField boxes, baked ShapeBounds, text-line windows.
  check('plain clip_rect is untouched (still the non-AA rect overload)',
    /void sk_canvas_clip_rect\(void\* canvas, double x, double y, double w, double h\) \{\n  \(\(SkCanvas\*\)canvas\)->clipRect\(\n      SkRect::MakeXYWH\(\(SkScalar\)x, \(SkScalar\)y, \(SkScalar\)w, \(SkScalar\)h\)\);/.test(glue));

  // ---- the example carries the measured table ----
  const ex = readFileSync(join(root, 'examples', 'scrollrect-round.as'), 'utf8');
  check('the example pins the measured width table',
    ex.includes('var WS:Array = [100, 100.1, 100.25, 100.5, 100.9, 101, 101.5, 119.5, 120, 120.5, 121, 121.5, 122.5, 123.5];'));
  check('the example pins the object-space rounding under scale 2',
    ex.includes('scaledCase(100.5, 2, 200);') && ex.includes('scaledCase(101.5, 2, 204);'));
  check('the example pins the fractional-origin coverage',
    ex.includes('fracCase(20.5, 20, 120);') && ex.includes('fracCase(20.75, 20, 120);'));
  // The expectation must be computed by the measured rule, not by Math.round.
  check('evenRound implements ties-to-even rather than reusing Math.round',
    ex.includes('if (v - f == 0.5) {') && ex.includes('return (fi % 2 == 0) ? fi : fi + 1;'));

  return bad;
}
registerGroup('unit: render/ScrollRectWindowRounding', checkScrollRectWindowRounding);

// ---- 阶段三百六十一: BitmapData.draw() 忽略**参数对象自己**的 visible/alpha ----
//
// AIR 的口径是「draw() 看内容、不看这个对象自己的外观状态」，但**后代**照常生效。
// adl 51.4.1 逐像素实测（temp/svgaprobe/VisProbe.as，A..O 共 15 项，AOT 修后逐条一致）：
//   root.visible=false        -> 1600 ink（照画），作为子件时 0 ink；
//   root.alpha=0 / 0.5        -> ink 1600 / alpha 和 408000（全不透明），而子件 0.5 是 203200、0 是 0；
//   Bitmap 作为根 visible/alpha 归零 -> 同样 400 ink 照画。
//
// 为什么这条值得专门钉：com.svgaplayer.Player（「高级礼物」的播放器）把整棵树放进
// rootLayer 后设 rootLayer.visible = false，再用 bitmapData.draw(rootLayer, ...) 出图。
// 修前 as_render_object 开头就 `if (o == NULL || !o->visible) return;`，于是**每帧都是空的**
// ——不报错、也没有画面，正是用户看到的「错误没了但动画不出来」。
//
// 行为由 examples/bd-draw-root-aspect.as 端到端钉住（3 个变异全红）；这里只钉生成的 C
// 必须把两个字段**临时**改成可见/不透明并在光栅后**还原**，且还原不能排在 as_render_object 之前。
function checkDrawRootAspect(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [drawroot] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [drawroot] ${label}`); }
  };
  const src = [
    'import flash.display.Sprite;',
    'import flash.display.BitmapData;',
    'var bd:BitmapData = new BitmapData(8, 8, false, 0);',
    'var s:Sprite = new Sprite();',
    'bd.draw(s);',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  const save = 'bool sx_kv = sdo->visible; double sx_ka = sdo->alpha;';
  const force = 'sdo->visible = true; sdo->alpha = 1.0;';
  const restore = 'sdo->visible = sx_kv; sdo->alpha = sx_ka;';
  const raster = 'as_render_object(canvas, sdo);';

  check('the root appearance is saved', c.includes(save));
  check('...forced to visible+opaque for the raster', c.includes(force));
  check('...and restored afterwards', c.includes(restore));
  check('the force happens before the raster pass',
    c.indexOf(force) >= 0 && c.indexOf(force) < c.indexOf(raster));
  check('the restore happens after the raster pass',
    c.indexOf(restore) > c.indexOf(raster));
  // Stage C removed the per-frame fingerprint: invalidation is write-driven
  // (_render_dirty), so there is no hash to refresh before draw() clobbers the
  // transform. draw() renders through as_render_object, which reads the dirty flag.
  check('draw() no longer refreshes a fingerprint (stage C removed it)',
    !c.includes('as_render_fp(sdo);'));

  // The descendant rule this fix must NOT change: as_render_object still skips an
  // invisible object, which is what makes an invisible CHILD vanish (ADL: 0 ink).
  const rb = c.indexOf('static void as_render_object(void* canvas, DisplayObject* o) {');
  check('as_render_object still skips invisible objects (the descendant rule)',
    rb >= 0 && c.slice(rb, rb + 400).includes('if (o == NULL || !o->visible) return;'));

  // The transform fields keep the same save/force/restore shape (regression guard for
  // whoever edits this block next).
  check('the transform zeroing/restore is still in place',
    c.includes('sdo->x = 0.0; sdo->y = 0.0; sdo->rotation = 0.0; sdo->scaleX = 1.0; sdo->scaleY = 1.0;')
    && c.includes('sdo->x = sx_kx; sdo->y = sx_ky; sdo->rotation = sx_kr; sdo->scaleX = sx_ksx; sdo->scaleY = sx_ksy;'));

  console.log(`[drawroot] ${ok} draw-root-appearance checks passed`);
  return bad;
}
registerGroup('unit: render/DrawRootAspect', checkDrawRootAspect);

// ---- RepaintBoundary (stage B skeleton, docs/zh-cn/repaint-boundary.md) ----
//
// Pins the SOURCE-LEVEL structure of the write-time dirty-marking path: the
// DisplayObject layout flag, the boundary predicate, the upward-bubbling marker,
// the forward declaration, the cache branch that consumes the flag, and the
// field-write tail that appends the marker after a render-input store. These are
// the invariants a later "remove the fingerprint fallback" switch must not break
// (the fingerprint path is still present during the parallel phase, so a
// behaviour-level pin is premature until the switch lands).
function checkRepaintBoundary(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [repaint] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [repaint] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const symSource = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const runtimeSource = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  check('DisplayObject struct declares the _render_dirty field', emitted.includes('int _render_dirty;'));
  check('DisplayObject_ctor zeroes _render_dirty', emitted.includes('o->_render_dirty = 0;'));
  check('as_is_boundary treats cacheAsBitmap as a repaint boundary',
    emitted.includes('static int as_is_boundary(DisplayObject* o) { return o != NULL && o->_cache_flag; }'));
  check('as_mark_dirty is defined', emitted.includes('static void as_mark_dirty(DisplayObject* o) {'));
  check('as_mark_dirty sets the flag', emitted.includes('o->_render_dirty = 1;'));
  check('as_mark_dirty bubbles through nested cacheAsBitmap to the root (no boundary stop)',
    !emitted.includes('if (o->_cache_flag) break;'));
  check('as_mark_dirty walks the parent chain', emitted.includes('o = (DisplayObject*)o->parent;'));
  check('as_mark_dirty always walks the full chain (no dirty short-circuit)',
    !emitted.includes('while (o != NULL && !o->_render_dirty) {') && emitted.includes('while (o != NULL) {'));
  check('as_mark_dirty is forward-declared for user-code call sites',
    emitted.includes('static void as_mark_dirty(DisplayObject* o);'));
  check('the cache branch re-bakes on _render_dirty (deferred to as_render_cached)',
    emitted.includes('int use_cache = 0;')
    && emitted.includes('if (o->_render_dirty) {')
    && emitted.includes('if (o->_cache_flag) { use_cache = 1; }')
    && emitted.includes('else { o->_render_dirty = 0; o->_auto_baked = 0; o->_cache_valid = 0; }'));
  // ---- Stage C: dirty rectangle (docs/zh-cn/repaint-boundary.md §4.2/§4.3) ----
  check('DisplayObject declares the dirty-rectangle fields',
    emitted.includes('int _dirty_full;')
    && emitted.includes('double _dirty_l;')
    && emitted.includes('double _dirty_t;')
    && emitted.includes('double _dirty_r;')
    && emitted.includes('double _dirty_b;'));
  check('DisplayObject_ctor zeroes the dirty rectangle',
    emitted.includes('o->_dirty_full = 0;')
    && emitted.includes('o->_dirty_l = 0.0;')
    && emitted.includes('o->_dirty_t = 0.0;')
    && emitted.includes('o->_dirty_r = -1.0;')
    && emitted.includes('o->_dirty_b = -1.0;'));
  check('as_mark_dirty promotes to a whole-object dirty (unbounded rectangle)',
    emitted.includes('o->_render_dirty = 1;')
    && emitted.includes('o->_dirty_full = 1;'));
  check('as_dirty_merge is defined and guards against a non-finite rectangle',
    emitted.includes('static void as_dirty_merge(DisplayObject* o, double l, double t, double r, double b) {')
    && emitted.includes('if (o->_dirty_full) return;')
    && emitted.includes('!(l > -1e300) || !(t > -1e300)'));
  check('as_mark_dirty_rect merges then transforms the rect up the parent chain',
    emitted.includes('static void as_mark_dirty_rect(DisplayObject* o, double l, double t, double r, double b) {')
    && emitted.includes('as_dirty_merge(o, l, t, r, b);')
    && emitted.includes('as_bounds_xform(&l, &t, &r, &b, o->x, o->y, o->rotation, o->scaleX, o->scaleY'));
  check('as_mark_dirty_rect is forward-declared',
    emitted.includes('static void as_mark_dirty_rect(DisplayObject* o, double l, double t, double r, double b);'));
  check('as_clear_dirty clears the flag and rectangle and recurses into children',
    emitted.includes('static void as_clear_dirty(DisplayObject* o) {')
    && emitted.includes('o->_render_dirty = 0;')
    && emitted.includes('o->_dirty_full = 0;')
    && emitted.includes('as_clear_dirty((DisplayObject*)as_v_obj_val(c->children->data[i]));'));
  // ---- Stage C step 3/4: retained surface + incremental re-bake (§4.4) ----
  check('DisplayObject declares the retained bake surface',
    emitted.includes('void* _cache_surface;'));
  check('as_render_cached retains the raster surface and registers a surface finalizer',
    emitted.includes('o->_cache_surface = surface;')
    && emitted.includes('as_final_register_surface(o, surface);'));
  check('a rebuild releases both the image and the retained surface',
    emitted.includes('if (o->_cache_surface != NULL) { as_final_release(o, o->_cache_surface); as_skia_surface_delete(o->_cache_surface); o->_cache_surface = NULL; }'));
  check('an explicit cacheAsBitmap defers the dirty flag to as_render_cached (no consume-time clear)',
    emitted.includes('if (o->_cache_flag) { use_cache = 1; }')
    && emitted.includes('else { o->_render_dirty = 0; o->_auto_baked = 0; o->_cache_valid = 0; }'));
  check('a finite dirty rect repaints in place (bake_patch) instead of rebuilding',
    emitted.includes('else if (o->_render_dirty && !o->_dirty_full && (o->filters == NULL || o->filters->length == 0) && o->_cache_surface != NULL) {')
    && emitted.includes('as_skia_canvas_clip_rect(c2, dl, dt, dr - dl, db - dt);')
    && emitted.includes('as_skia_canvas_clear_rect(c2, dl, dt, dr - dl, db - dt);')
    && emitted.includes('o->_cache_image = as_skia_surface_make_snapshot(o->_cache_surface);'));
  check('a _dirty_full (or filtered) boundary repaints the whole retained surface',
    emitted.includes('else if (o->_render_dirty && o->_cache_surface != NULL) {')
    && emitted.includes('as_skia_canvas_reset(c2);'));
  check('as_gflush invalidates the precise accumulated bounds, not the whole object',
    emitted.includes('static void as_gflush(Graphics* g) {')
    && emitted.includes('as_mark_dirty_rect(g->_owner, g->_bl - half, g->_bt - half, g->_br + half, g->_bb + half);'));
  // ---- G30: Graphics_clear precise invalidation (asaotui drawBox clear+redraw) ----
  check('Graphics_clear invalidates the old accumulated bounds precisely, not the whole object',
    emitted.includes('void Graphics_clear(void* _this) {')
    && emitted.includes('if (g->_owner != NULL && g->_has_b) {')
    && emitted.includes('as_mark_dirty_rect(g->_owner, g->_bl - half, g->_bt - half, g->_br + half, g->_bb + half);'));
  check('Graphics_clear no longer fires an unconditional whole-object as_mark_dirty (empty graphics skips the mark)',
    !/void Graphics_clear\(void\* _this\) \{\nGraphics\* g = \(Graphics\*\)_this;\nif \(g->_owner != NULL\) as_mark_dirty\(g->_owner\);/.test(emitted));
  // ---- Stage C: showRedrawRegions paints the dirty-rect oracle (§4.4) ----
  check('showRedrawRegions records the flag without an unsupported report',
    !runtimeSource.includes('does not paint region outlines')
    && runtimeSource.includes('ASC_show_redraw_regions = on;'));
  check('as_render_cached records the repaint rect before clearing the dirty flag',
    emitted.includes('redrawn = 1; rl = bl; rt = bt; rr = br; rb = bb;')
    && emitted.includes('redrawn = 1; rl = dl; rt = dt; rr = dr; rb = db;'));
  check('a repainted boundary paints a stroke outline of its repaint rect',
    emitted.includes('if (redrawn && ASC_show_redraw_regions) {')
    && emitted.includes('as_skia_paint_stroke((unsigned)(long long)ASC_show_redraw_regions_color, 1.0, 1.0);')
    && emitted.includes('as_skia_canvas_draw_rect(canvas, rl, rt, rr - rl, rb - rt, rrp);'));
  // Stage C: end-of-frame reset (as_clear_dirty) is ENABLED after incremental
  // re-bake — it clears live subtrees the cache branch never touches, so auto-bake
  // can fire on them next frame.
  check('as_clear_dirty runs end-of-frame in Stage_render and ASC_window_render',
    emitted.includes('as_clear_dirty((DisplayObject*)_this);')
    && emitted.includes('as_clear_dirty((DisplayObject*)w->stage);'));
  // 阶段三百八十: the tail appends dirtyCall, which is as_mark_dirty for every render input
  // EXCEPT the two translation fields (see render/MovedBake below).
  check('the field-write tail appends the render-input dirty mark after the store',
    emitSource.includes('${dirtyCall}((DisplayObject*)${doDirtyRecv})')
    && emitSource.includes("? 'as_mark_moved'")
    && emitSource.includes(": 'as_mark_dirty'"));
  // G30: the render-input store is change-detected -- an unchanged value (the
  // common per-frame `backing.alpha = 1.0` re-write) skips the full dirty mark so
  // a Graphics_clear precise dirty-rect is not widened back to a whole object.
  check('the render-input store change-detects: unchanged value skips the dirty mark',
    emitSource.includes('${t.code} != ${code} ?')
    && emitSource.includes(': (void)0, ${t.code})'));
  check('the render-input set lists the nine plain geometry/colour fields',
    emitSource.includes("'x', 'y', 'rotation', 'scaleX', 'scaleY'")
    && emitSource.includes("'alpha', 'visible', 'blendMode', 'opaqueBackground'"));

  // ---- Stage B write points: BitmapData reverse edges ----
  check('BitmapData declares the _refs reverse edge', symSource.includes("['_refs', bdf({ kind: 'array' })]"));
  check('Bitmap declares the _bound_bd back edge', symSource.includes("['_bound_bd', bmpf({ kind: 'object', className: 'BitmapData' })]"));
  check('Bitmap.bitmapData writes route through a setter', symSource.includes("['bitmapData', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'BitmapData'"));
  check('as_bd_bind / as_bd_unbind / as_bd_mark_dirty are forward-declared',
    emitted.includes('static void as_bd_bind(BitmapData* bd, Bitmap* b);')
    && emitted.includes('static void as_bd_unbind(BitmapData* bd, Bitmap* b);')
    && emitted.includes('static void as_bd_mark_dirty(BitmapData* bd);'));
  check('as_bd_mark_dirty bumps _px_ver then marks every referring Bitmap',
    emitted.includes('static void as_bd_mark_dirty(BitmapData* bd) {')
    && emitted.includes('bd->_px_ver++;')
    && emitted.includes('as_mark_dirty((DisplayObject*)as_v_obj_val(bd->_refs->data[i]));'));
  check('Bitmap_set_bitmapData re-wires the reverse edge and marks dirty',
    emitted.includes('void Bitmap_set_bitmapData(void* _this, BitmapData* value) {')
    && emitted.includes('as_bd_unbind(b->_bound_bd, b);')
    && emitted.includes('as_bd_bind(value, b);'));
  check('removeChild unbinds the removed subtree from its BitmapData',
    emitted.includes('static void as_disp_unbind_bd(DisplayObject* o) {')
    && emitted.includes('as_disp_unbind_bd(child);'));
  check('BitmapData mutators call as_bd_mark_dirty (no bare _px_ver++ outside the helper)',
    emitted.includes('as_bd_mark_dirty(bd);') && emitted.includes('as_bd_mark_dirty(dst);'));

  // ---- Stage B write points: TextField + Stage accessors ----
  check('TextField text/htmlText setters mark dirty',
    emitted.includes('void TextField_set_text(void* _this, char* value) {')
    && emitted.includes('void TextField_set_htmlText(void* _this, char* value) { as_tf_html_set((TextField*)_this, value); as_mark_dirty((DisplayObject*)_this); }'));
  check('TextField colour setters mark dirty',
    emitted.includes('void TextField_set_textColor(void* _this, unsigned int value) { ((TextField*)_this)->textColor = value & 0xFFFFFFu; as_mark_dirty((DisplayObject*)_this); }'));
  check('TextField text-mutation methods (appendText/replaceText/scrollH/selection/setTextFormat) mark dirty',
    emitted.includes('void TextField_appendText(void* _this, char* s) {')
    && emitted.includes('void TextField_replaceText(void* _this, int beginIndex, int endIndex, char* newText) {')
    && emitted.includes('void TextField_set_scrollH(void* _this, int value) {')
    && emitted.includes('void TextField_setSelection(void* _this, int begin, int end) {')
    && emitted.includes('void TextField_setTextFormat(void* _this, TextFormat* format, int begin, int end) {'));
  check('TextField render-input field set is declared',
    emitSource.includes("['TextField', new Set(['multiline', 'wordWrap', 'background', 'border', 'scrollV'"));
  check('autoSize re-derivation marks the field dirty when the box changes',
    emitted.includes('double nw = tf->wordWrap ? tf->_fieldWidth : tw + 4.0;')
    && emitted.includes('if (nw != tf->_fieldWidth || nh != tf->_fieldHeight) { tf->_fieldWidth = nw; tf->_fieldHeight = nh; as_mark_dirty((DisplayObject*)tf); }'));
  check('Stage color/align/scaleMode setters mark dirty',
    emitSource.includes("const stageRenderDirty = new Set(['color', 'align', 'scaleMode']);")
    && emitted.includes('void Stage_set_scaleMode(void* _this, char* value) {')
    && emitted.includes('as_mark_dirty((DisplayObject*)_this);'));
  check('stage C removed the fingerprint: no as_render_fp / _auto_fp / DIRTY_MISS / as_dirty_dump residue',
    !emitted.includes('as_render_fp')
    && !emitted.includes('_auto_fp')
    && !emitted.includes('DIRTY_MISS')
    && !emitted.includes('ASC_dirty_trace')
    && !emitted.includes('ASC_fp_trace')
    && !emitted.includes('as_dirty_dump')
    && !emitted.includes('as_fp_u32'));
  check('window Present-skip keys on the global dirty epoch, not a tree hash',
    emitted.includes('static uint64_t ASC_dirty_epoch = 0;')
    && emitted.includes('ASC_dirty_epoch++;')
    && emitted.includes('uint64_t render_epoch;')
    && emitted.includes('if (w->render_valid && w->render_epoch == ASC_dirty_epoch')
    && emitted.includes('w->render_epoch = ASC_dirty_epoch;'));
  check('as_render_states settles MovieClip/SimpleButton states (the fingerprint walk is gone)',
    emitted.includes('static void as_render_states(DisplayObject* o) {')
    && emitted.includes('if (as_is(o, &MovieClip_vt)) as_mc_button_state(o);')
    && emitted.includes('if (as_is(o, &SimpleButton_vt)) {')
    && emitted.includes('as_render_states((DisplayObject*)as_v_obj_val(c->children->data[i]));'));
  check('auto-bake triggers in as_render_object before the cache decision (root excluded)',
    emitted.includes('if (!ASC_no_auto_bake && o->parent != NULL && o->visible && !o->_cache_flag && !o->_auto_baked && !o->_render_dirty && !as_single_primitive(o)) {')
    && emitted.includes('int use_cache = 0;'));
  check('dynamic field write (as_dyn_set) marks DisplayObject render-dirty via the disp hook',
    runtimeSource.includes('static void (*as_disp_dirty_hook)(void* obj) = NULL;')
    && runtimeSource.includes('if (as_disp_dirty_hook != NULL) as_disp_dirty_hook(obj);')
    && emitted.includes('static void as_disp_dirty_impl(void* obj) {')
    && emitted.includes('if (as_is(obj, &DisplayObject_vt)) as_mark_dirty((DisplayObject*)obj);')
    && emitted.includes('as_disp_dirty_hook = as_disp_dirty_impl;')
    && emitted.includes('as_disp_dirty_wire();'));

  // ---- Stage B write points: runtime internal state (焦点/IME/caret/hover) ----
  check('focus change marks both ends render-dirty',
    emitted.includes('static void as_set_focus(DisplayObject* obj) {')
    && emitted.includes('as_mark_dirty(old);')
    && emitted.includes('as_mark_dirty(obj);'));
  check('IME composition changes mark the field dirty',
    emitted.includes('static void as_tf_set_comp(TextField* tf, const char* text, int start, int length) {')
    && emitted.includes('as_mark_dirty((DisplayObject*)tf);'));
  check('caret/selection helpers mark the field dirty',
    emitted.includes('static void as_tf_set_caret(TextField* tf, int pos) {')
    && emitted.includes('static void as_tf_extend_caret(TextField* tf, int pos) {')
    && emitted.includes('static void as_tf_select_all(TextField* tf) {')
    && emitted.includes('static void as_tf_word_select(TextField* tf, int idx) {'));
  check('caret-blink phase flip is detected and marks the focused field dirty',
    emitted.includes('static int as_tf_blink_prev = -1;')
    && emitted.includes('if (as_tf_blink_prev >= 0 && _kon != as_tf_blink_prev) as_mark_dirty((DisplayObject*)_btf);'));
  check('BitmapFilter declares the _owner reverse edge',
    symSource.includes("['_owner', { type: { kind: 'object', className: 'DisplayObject' }, init: null, visibility: 'private', owner: 'BitmapFilter'"));
  check('filter field writes mark the filter owner via FILTER_CLASSES',
    emitSource.includes("private static readonly FILTER_CLASSES: ReadonlySet<string> = new Set(['BlurFilter', 'DropShadowFilter', 'GlowFilter'])")
    && emitSource.includes('Emitter.FILTER_CLASSES.has(f.owner)')
    && emitSource.includes('`(${recv})->_owner`'));
  check('DisplayObject_set_filters wires each filter _owner',
    emitted.includes('void DisplayObject_set_filters(void* _this, as_array* value) {')
    && emitted.includes('((BitmapFilter*)_f)->_owner = o;'));
  check('Stage3D declares the _owner reverse edge',
    symSource.includes("['_owner', { type: { kind: 'object', className: 'Stage' }, init: null, visibility: 'private', owner: 'Stage3D'"));
  check('Stage3D x/y/visible setters mark the owning stage',
    emitted.includes('void Stage3D_set_x(void* _this, double value) { Stage3D* o = (Stage3D*)_this; o->x = value; if (o->_owner != NULL) as_mark_dirty((DisplayObject*)o->_owner); }'));
  check('SimpleButton state flip is detected and marks the button dirty',
    symSource.includes("['_sbtn_prev', { type: { kind: 'object', className: 'DisplayObject' }, init: null, visibility: 'private', owner: 'SimpleButton'")
    && emitted.includes('if (((SimpleButton*)o)->_sbtn_prev != st) { ((SimpleButton*)o)->_sbtn_prev = st; as_mark_dirty(o); }'));

  console.log(`[repaint] ${ok} repaint-boundary checks passed`);
  return bad;
}
registerGroup('unit: render/RepaintBoundary', checkRepaintBoundary);

// ---- 阶段三百八十: a pure translation keeps the bake ----
//
// The behavioural oracle is examples/autobake-move.as (pixels: a baked card moved by WHOLE
// pixels must equal the same content painted live at the destination, the old position must be
// empty, moving back must restore the picture, and a CONTENT write after a move must still
// repaint). Same example, bake traces: x/y writes rebuild the card 2x under the old
// whole-object marker and 0x now (the ancestor container still rebuilds in both -- that is the
// part that really changed on screen). These are the source-level invariants that keep the
// oracle meaningful.
function checkMovedBake(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [movedbake] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [movedbake] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  check('as_mark_moved is forward-declared next to as_mark_dirty',
    emitted.includes('static void as_mark_moved(DisplayObject* o);'));
  const start = emitted.indexOf('static void as_mark_moved(DisplayObject* o) {');
  const end = start < 0 ? -1 : emitted.indexOf('\nstatic ', start + 10);
  const body = start < 0 || end < 0 ? '' : emitted.slice(start, end);
  check('as_mark_moved is defined', body.length > 0);
  // The whole point: the moved object KEEPS its bake, so its own flag must stay clear. Setting
  // it here would drop the cache branch into the live path and re-bake on the next clean frame --
  // i.e. exactly the behaviour this helper exists to avoid.
  check('as_mark_moved never dirties the moved object itself', !body.includes('o->_render_dirty = 1;'));
  check('as_mark_moved dirties every ancestor (walking the parent chain)',
    body.includes('for (DisplayObject* p = (DisplayObject*)o->parent; p != NULL; p = (DisplayObject*)p->parent) {')
    && body.includes('p->_render_dirty = 1;')
    && body.includes('p->_dirty_full = 1;'));
  check('as_mark_moved still bumps the dirty epoch (the window has to repaint)',
    body.includes('ASC_dirty_epoch++;'));
  // A mask's position is an input to the object it stencils, which is not necessarily an
  // ancestor -- that case must stay on the conservative whole-object path.
  check('a moved mask falls back to as_mark_dirty',
    body.includes('if (o->_mask_user) { as_mark_dirty(o); return; }'));
  check('the move set is exactly {x, y} (rotation/scale change the bake resolution)',
    emitSource.includes("private static readonly DO_MOVE_FIELDS: ReadonlySet<string> = new Set(['x', 'y']);"));
  check('emitAssign routes the store through DO_MOVE_FIELDS',
    emitSource.includes('Emitter.DO_MOVE_FIELDS.has(doDirtyField)'));
  check('the member-write path records WHICH render input it hit',
    emitSource.includes('this.lastDoDirtyField = expr.property;')
    && emitSource.includes('this.lastDoDirtyField = name;'));
  // A Transform / filter write goes through the _owner edge and is never a translation.
  check('the Transform/filter path clears the move field',
    (emitSource.match(/this\.lastDoDirtyField = null;/g) ?? []).length >= 2);

  // Behavioural: which marker each store actually got in the generated C.
  const c = generateC(parse(
    'import flash.display.Sprite;\nimport flash.geom.Matrix;\nvar s:Sprite = new Sprite();\n' +
    's.x = 10;\ns.y += 3;\ns.rotation = 5;\ns.alpha = 0.5;\ns.scaleX = 2;\n' +
    'var m:Matrix = new Matrix(1, 0, 0, 1, 5, 0);\ns.transform.matrix = m;\n')).c;
  const style = c.split('\n').filter((l) => l.includes('as_req_obj((void*)(g_s))') && /->(x|y|rotation|alpha|scaleX)\)/.test(l))
    .map((l) => {
      const field = /->(x|y|rotation|alpha|scaleX)\)/.exec(l)![1];
      return { field, moved: l.includes('as_mark_moved('), dirty: l.includes('as_mark_dirty(') };
    });
  check('every x/y store (plain and compound) takes as_mark_moved in the generated C',
    style.filter((s) => s.field === 'x' || s.field === 'y').length === 2
    && style.filter((s) => s.field === 'x' || s.field === 'y').every((s) => s.moved && !s.dirty));
  check('rotation/alpha/scaleX keep as_mark_dirty (no as_mark_moved leak)',
    style.filter((s) => s.field !== 'x' && s.field !== 'y').length === 3
    && style.filter((s) => s.field !== 'x' && s.field !== 'y').every((s) => !s.moved && s.dirty));
  // A matrix can carry scale/rotation, so a Transform.matrix write must stay whole-object:
  // DisplayObject_set_transform_matrix marks the owner itself.
  check('a Transform.matrix write still marks the owner whole-object',
    c.includes('void DisplayObject_set_transform_matrix(void* _this, Matrix* m) {')
    && /void DisplayObject_set_transform_matrix\(void\* _this, Matrix\* m\) \{[\s\S]{0,160}?as_mark_dirty\(o\);/.test(c));

  console.log(`[movedbake] ${ok} translation/bake checks passed`);
  return bad;
}
registerGroup('unit: render/MovedBake', checkMovedBake);

// ---- 阶段三百八十一: an auto-bake repairs its retained surface in place ----
//
// The behavioural oracle is examples/autobake-patch.as (pixels: after a SPORADIC change the
// repaired boundary must be pixel-identical to a from-scratch bake of the same content, the same
// holds through a 5-frame churn and after it, and the changed pixel really changes). Bake traces
// on that same example, same AS3 input, only emit.ts swapped (temp/s381/ab-bake.cjs):
// bake_rebuild 47 -> 5, bake_patch 0 -> 7, and ASC_BAKE_VERIFY=1 reports no bake_verify_bad.
// These are the source-level invariants that keep that oracle meaningful.
function checkAutoBakePatch(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [autopatch] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [autopatch] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // The field exists, starts clean, and is reset by an explicit invalidation too.
  check('DisplayObject carries the consecutive-dirty counter',
    emitted.includes('int _cache_dirty_run;'));
  check('the ctor starts the counter at 0',
    (emitted.match(/o->_cache_dirty_run = 0;/g) ?? []).length >= 2);
  check('the cacheAsBitmap setter resets the counter (a rebuilt surface may patch next change)',
    /o->_cache_valid = 0;\no->_cache_dirty_run = 0;/.test(emitted));

  // The decision: count first, patch only on the FIRST dirty render after a clean one.
  check('the dirty branch counts consecutive dirty renders',
    emitted.includes('o->_cache_dirty_run++;'));
  check('an explicit cacheAsBitmap is unaffected (still unconditional)',
    emitted.includes('if (o->_cache_flag) { use_cache = 1; }'));
  check('an auto-bake patches only when the previous render was clean AND a surface exists',
    emitted.includes('else if (o->_cache_valid && o->_cache_surface != NULL && o->_cache_dirty_run == 1) { use_cache = 1; }'));
  check('a per-frame animator still drops to live (the stage B behaviour is kept)',
    emitted.includes('else { o->_render_dirty = 0; o->_auto_baked = 0; o->_cache_valid = 0; }'));
  check('a clean render resets the counter before reusing the cache',
    emitted.includes('o->_cache_dirty_run = 0;\nuse_cache = 1;'));

  // The verify oracle that makes a silent stale block impossible to miss.
  check('the ASC_BAKE_VERIFY oracle is forward-declared',
    emitted.includes('static void as_bake_verify(DisplayObject* o, void* canvas, int pw, int ph, double sx, double sy, double bxo, double byo, const char* kind);'));
  check('the oracle is opt-in through the environment',
    emitted.includes('static int ASC_bake_verify = -1;')
    && emitted.includes('ASC_bake_verify = getenv("ASC_BAKE_VERIFY") != NULL ? 1 : 0;'));
  check('the oracle rebuilds from scratch and compares the two rasters',
    emitted.includes('static void as_bake_verify(DisplayObject* o, void* canvas, int pw, int ph, double sx, double sy, double bxo, double byo, const char* kind) {')
    && emitted.includes('as_skia_surface_read_argb(o->_cache_surface, va, pw, ph)')
    && emitted.includes('for (int i = 0; i < pw * ph; i++) if (va[i] != vb[i]) bad++;')
    && emitted.includes('bake_verify_bad o=%p kind=%s npix=%d of=%d'));
  check('both in-place repairs verify, the from-scratch rebuild does not',
    (emitted.match(/if \(ASC_bake_verify > 0\) as_bake_verify\(o, canvas, pw, ph, sx, sy, bxo, byo, "patch"\);/g) ?? []).length === 1
    && (emitted.match(/if \(ASC_bake_verify > 0\) as_bake_verify\(o, canvas, pw, ph, sx, sy, bxo, byo, "repaint"\);/g) ?? []).length === 1
    && emitted.split('as_bake_verify(o, canvas').length - 1 === 2);

  // Source shape inside the generated C itself (not just the emitter's text).
  const c = generateC(parse(
    'import flash.display.Sprite;\nimport flash.display.Shape;\nvar s:Sprite = new Sprite();\n' +
    'var p:Shape = new Shape();\np.graphics.beginFill(0xFF0000);\np.graphics.drawRect(0,0,4,4);\np.graphics.endFill();\ns.addChild(p);\n')).c;
  check('the generated renderer counts consecutive dirty renders',
    c.includes('o->_cache_dirty_run++;'));
  check('the generated patch branch verifies its own repair',
    /o->_cache_image = as_skia_surface_make_snapshot\(o->_cache_surface\);\n\s*if \(ASC_bake_verify > 0\) as_bake_verify\(o, canvas, pw, ph, sx, sy, bxo, byo, "patch"\);/.test(c));
  check('the whole-surface repaint verifies too',
    /o->_cache_image = as_skia_surface_make_snapshot\(o->_cache_surface\);\n\s*if \(ASC_bake_verify > 0\) as_bake_verify\(o, canvas, pw, ph, sx, sy, bxo, byo, "repaint"\);/.test(c));
  check('every oracle call site is guarded by the environment switch',
    c.split('\n').filter((l) => l.includes('as_bake_verify(o, canvas')).every((l) => l.trimStart().startsWith('if (ASC_bake_verify > 0)')));

  console.log(`[autopatch] ${ok} auto-bake repair checks passed`);
  return bad;
}
registerGroup('unit: render/AutoBakePatch', checkAutoBakePatch);

// ---- BakeReleaseOnRemove: 自动烘焙缓存离开显示列表后一帧即归还（阶段三百八十四） ----
//
// 真机症状：设置窗口每轮开关进程私有内存 +10.5 MB，AIR 下不涨。根因是 auto-bake 的
// surface 生命周期只绑在 owner 的 GC 生命周期上 —— 子树已被 removeChildren 摘离显示
// 列表、但仍被别处引用时，那几十张 surface 永不归还。这组钉住生成 C 的形态：释放点、
// 一帧延迟、回舞台不清、以及 A/B 环保留。
function checkBakeReleaseOnRemove(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [bakerelease] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [bakerelease] ${label}`); }
  };

  const c = generateC(parse("import flash.display.Sprite;\nimport flash.display.Shape;\nvar s:Sprite = new Sprite();\nvar p:Shape = new Shape();\np.graphics.beginFill(0xFF0000);\np.graphics.drawRect(0,0,4,4);\np.graphics.endFill();\ns.addChild(p);\n")).c;
  const removeFn = 'DisplayObject* DisplayObjectContainer_removeChild(void* _this, DisplayObject* child) {';
  // 限定在释放函数体内：同一串 delete 在重建分支里也出现，全局 indexOf 会撞上别处。
  const ro = c.slice(c.indexOf('static void as_bake_release_one(DisplayObject* o) {'),
                     c.indexOf('static void as_bake_pend_push(DisplayObject* o) {'));

  check('the release helper is defined before its first use',
    c.includes('static void as_bake_release_one(DisplayObject* o) {') &&
    c.indexOf('static void as_bake_release_one(DisplayObject* o) {') < c.indexOf(removeFn));
  check('the image is unregistered before it is deleted',
    ro.indexOf('as_final_release((void*)o, o->_cache_image)') > 0 &&
    ro.indexOf('as_skia_image_delete(o->_cache_image)') > ro.indexOf('as_final_release((void*)o, o->_cache_image)'));
  check('the surface is unregistered before it is deleted',
    ro.indexOf('as_final_release((void*)o, o->_cache_surface)') > 0 &&
    ro.indexOf('as_skia_surface_delete(o->_cache_surface)') > ro.indexOf('as_final_release((void*)o, o->_cache_surface)'));
  check('releasing marks the node cold so the next frame rebuilds it',
    c.includes('o->_cache_valid = 0;') &&
    /o->_cache_w = 0\.0; o->_cache_h = 0\.0; o->_cache_phx = 0\.0; o->_cache_phy = 0\.0;/.test(c));
  check('the pending walk covers the whole subtree (containers recurse)',
    /as_bake_pend_push\(\(DisplayObject\*\)as_v_obj_val\(c->children->data\[i\]\)\)/.test(c));
  check('removeChild enqueues only subtrees that were on stage',
    c.includes('if (was_on_stage) as_bake_pend_push(child);'));
  check('the enqueue happens after the BitmapData back-edge is cut',
    c.indexOf('if (was_on_stage) as_bake_pend_push(child);') > c.indexOf('as_disp_unbind_bd(child);'));
  // 阶段三百八十四·修复：sweep 不再解引用 pending 项（那里曾是崩溃点）。
  check('a node that comes back on stage is dropped at addChild time, not by re-reading parent',
    c.includes('as_bake_pend_drop(child);') &&
    !c.includes('if (as_on_stage(o)) continue;'));
  check('the sweep never tests gc_in_heap or parent on a possibly recycled slot',
    !c.includes('if (!gc_in_heap((void*)o)) continue;'));
  check('releasing a node whose owner the collector already freed is a no-op (no double free)',
    ro.includes('if (!as_final_has_owner((void*)o)) return;'));
  check('a resource is deleted only when its registration was actually still present',
    ro.includes('if (as_final_release((void*)o, o->_cache_image)) as_skia_image_delete') &&
    ro.includes('if (as_final_release((void*)o, o->_cache_surface)) as_skia_surface_delete'));
  check('both addChild and addChildAt revoke the pending release',
    c.split('as_bake_pend_drop(child);').length - 1 === 2);
  check('both frame entry points advance the sweep (window frame + headless render)',
    c.split('as_bake_pend_sweep();').length - 1 === 2);
  check('the release path keeps an A/B switch like ASC_NO_FINAL',
    c.includes('ASC_NO_BAKE_RELEASE'));
  check('a full table flushes instead of silently dropping pending nodes',
    c.includes('static DisplayObject* AS_bake_pend[2048];') &&
    c.includes('if (AS_bake_pend_n >= (int)(sizeof(AS_bake_pend) / sizeof(AS_bake_pend[0]))) {'));

  console.log(`[bakerelease] ${ok} bake-release-on-remove checks passed`);
  return bad;
}
registerGroup('unit: render/BakeReleaseOnRemove', checkBakeReleaseOnRemove);

// ---- TextFieldBoundsAutosize: 算盒入口必须先套 autoSize（G34） ----
//
// 症状：文字一变长，改后的**第一次**重画右端被裁，第二次才完整 —— 真机表现是「最后一截字
// 晚一点才出现」。不是度量问题（宽度数字本身是对的），错的是「拿哪个宽度去建烘焙面」：
// `tf.text = …` 只作废段落，`_fieldWidth` 要等 `as_tf_apply_autosize` 才跟上新文本，而它原本
// 只在**绘制**（字段自己的 paint 分支）与 `width`/`height`（`as_do_extents`）里被调用；两个
// 算盒入口 —— `as_bounds_walk`（getBounds/getRect/父级并集）与 `as_render_bounds`（烘焙与
// 滤镜表面尺寸）—— 直接读裸字段 ⇒ 保留面按上一段文字的宽度建，新文字画进去就被裁掉。
// 像素侧由 `examples/tf-grow-bake.as` 钉住（修前 first=47 second=332），这里钉生成 C 的形态。
function checkTextFieldBoundsAutosize(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [tfbounds] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [tfbounds] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.display.TextField;\nvar t:TextField = new TextField();\n')).c;

  // 只取**定义**（形参里没有右括号，故 [^)]* 安全）：同名的前向声明以 ; 结尾，正则跳过它。
  const walkDef = /static int as_bounds_walk\([^)]*\) \{/.exec(c);
  const renderDef = /static int as_render_bounds\([^)]*\) \{/.exec(c);
  check('both bounds walkers are defined, walk before render',
    walkDef !== null && renderDef !== null && walkDef.index < renderDef.index);

  const walkBody = (walkDef && renderDef) ? c.slice(walkDef.index, renderDef.index) : '';
  const renderBody = renderDef ? c.slice(renderDef.index, renderDef.index + 9000) : '';

  // 分支窗口：从 &TextField_vt 判定起 300 字符内必须「先 autoSize、后读 _fieldWidth」。
  const branchOrder = (body: string): { call: number; read: number } => {
    const i = body.indexOf('&TextField_vt');
    if (i < 0) return { call: -1, read: -1 };
    const win = body.slice(i, i + 300);
    return { call: win.indexOf('as_tf_apply_autosize(tf);'), read: win.indexOf('tf->_fieldWidth') };
  };
  const wb = branchOrder(walkBody);
  const rb = branchOrder(renderBody);
  check('as_bounds_walk autosizes before answering the box (getBounds/getRect/parent union)',
    wb.call >= 0 && wb.read > wb.call);
  check('as_render_bounds autosizes before sizing the bake/filter surface',
    rb.call >= 0 && rb.read > rb.call);
  check('width/height keeps its autosize (as_do_extents)',
    c.includes('if (as_is((void*)o, &TextField_vt)) as_tf_apply_autosize((TextField*)o);'));
  check('the field paint still autosizes first, so the box above is the painted one',
    c.includes('if (tf->text != NULL && as_tf_base_fmt(tf) != NULL) {\n      as_tf_apply_autosize(tf);'));
  // 7 = 1 前向声明 + 1 定义 + 5 调用点（烘焙落点、bounds walk、width/height、render bounds、paint）。
  // 定数钉子：任何一处被删、或被挪出算盒路径，都会当场红。
  check('every autosize call site is still there (5 call sites + decl + definition)',
    (c.match(/as_tf_apply_autosize\(/g) ?? []).length === 7);

  console.log(`[tfbounds] ${ok} TextField bounds/autoSize checks passed`);
  return bad;
}
registerGroup('unit: render/TextFieldBoundsAutosize', checkTextFieldBoundsAutosize);
