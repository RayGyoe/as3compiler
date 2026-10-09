// Unit checks: hit testing, display geometry, transform matrix.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='display/' test/unit/*.ts

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

// ---- hitTestPoint(x, y, shapeFlag) region test (stage 94.22) ----
//
// AIR answers shapeFlag=true from the drawn REGION, not the bounding box: the gap
// between two children of a Sprite is a miss, a stroke-only line is hit along its
// band, a TextField and a Bitmap are their rect (a fully transparent BitmapData
// still hits -- shapeFlag is NOT a pixel test), and neither flag cares about
// visible/mouseEnabled/mouseChildren (measured, temp/editprobe/app8..app10).
function checkHitShape(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [hitshape] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [hitshape] ${label}`); }
  };

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  // Containment must come from the same geometry that is painted: the fill via
  // SkPath::contains (even-odd) and the stroke via the stroke outline Skia would
  // build, with AIR's default round caps/joints.
  check('the glue answers fill and stroked-band containment',
    glue.includes('int sk_path_contains(void* path, double x, double y)') &&
    glue.includes('int sk_path_stroke_contains(void* path, double width, double x, double y)') &&
    glue.includes('SkStrokeRec rec(p);') && glue.includes('applyToPath(&dst, *(SkPath*)path)') &&
    glue.includes('SkPaint::kRound_Cap, SkPaint::kRound_Join') &&
    runtime.includes('extern int sk_path_stroke_contains(void* path, double width, double x, double y);') &&
    runtime.includes('static inline int as_skia_path_stroke_contains(void* p, double width, double x, double y) { return sk_path_stroke_contains(p, width, x, y); }'));
  // ... and the fill rule must be even-odd, matching what AIR paints: one fill with
  // two same-direction nested drawRects leaves the inner rect hollow on adl, both
  // in the hit test and in the rendered pixels (Ed21 §E, Ed26).
  check('graphics fills are even-odd, so paint and hit region agree',
    glue.includes('SkPathFillType::kEvenOdd : SkPathFillType::kWinding') &&
    emitted.includes('as_skia_path_set_even_odd(o->path, 1);'));
  // No alpha/pixel sampling anywhere in the region path.
  check('the region test never samples pixels',
    emitted.includes('static bool as_obj_region_hit_local(DisplayObject* o, double lx, double ly) {') &&
    !/as_obj_region_hit_local\(DisplayObject\* o, double lx, double ly\) \{[\s\S]{0,1200}?getPixel32/.test(emitted) &&
    emitted.includes('if (as_is((void*)o, &Bitmap_vt) || as_is((void*)o, &TextField_vt)) {'));
  // Containers recurse (gap = miss) instead of falling back to their own box.
  check('containers recurse into children',
    /as_obj_region_hit_local\(DisplayObject\* o, double lx, double ly\) \{[\s\S]{0,2600}?if \(as_obj_region_hit_local\(ch, clx, cly\)\) return true;/.test(emitted));
  // The box flag includes the stroke, which also makes stroke-only Shapes pickable.
  check('the box hit test includes the stroke',
    emitted.includes('if (!as_bounds_walk(o, 1, 0, &l, &t, &r, &b)) return false;') &&
    !/as_obj_hit_local\(DisplayObject\* o, double lx, double ly\) \{[\s\S]{0,300}?as_bounds_walk\(o, 0/.test(emitted));
  check('hitTestPoint dispatches on shapeFlag instead of ignoring it',
    !emitSource.includes("this.line('(void)shapeFlag;');") &&
    emitted.includes('if (shapeFlag) return as_obj_region_hit(_this, x, y);'));

  if (ok > 0) console.log(`[hitshape] ${ok} hit-region checks passed`);
  return bad;
}

// ---- 阶段九十四·五 C1：DisplayObject 几何 + 变换感知命中测试 ----------------
// 被实测推翻的三条旧假设（证据 temp/c1probe/ + temp/c1probe/click/，adl 51.4.1）：
// width/height 是派生值而非存储槽、赋值 = 缩放、命中要逐层折算父变换。
function checkDisplayGeometry(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [geometry] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [geometry] ${label}`); }
  };
  const c = generateC(parse('var s:Shape = new Shape();\ns.graphics.drawRect(0, 0, 10, 10);\nvar t:TextField = new TextField();\nt.width = 5;\nvar n:Number = s.width;\n')).c;

  // width/height 是访问器，不是槽：typedef 里必须有 get/set 槽，且不再有裸字段。
  check('DisplayObject declares width/height as accessors',
    c.includes('double (*get_width)(void* _this);') && c.includes('void (*set_width)(void* _this, double);'));
  check('DisplayObject no longer stores width/height as plain fields',
    !/typedef struct DisplayObject \{[\s\S]{0,600}?double width;/.test(c));

  // 派生 = 内容包围盒经自身变换；赋值为缩放（实测 50 宽 + width=100 -> scaleX 2）。
  check('width measures the content bounds through the object transform',
    c.includes('static double as_do_width(DisplayObject* o) {')
    && c.includes('if (!as_bounds_walk(o, 1, 1, &l, &t, &r, &b)) return 0.0;')
    && c.includes('return r - l;'));
  check('the width setter SCALES (AIR semantics), collapsing to 0 on empty content',
    c.includes('o->scaleX = o->scaleX * value / cur;')
    && c.includes('if (cur == 0.0 || cur != cur) { o->scaleX = 0.0; return; }'));
  check('TextField keeps real storage and the setter writes the field',
    c.includes('((TextField*)o)->_fieldWidth = value; return;')
    && c.includes('((TextField*)o)->_fieldHeight = value; return;'));
  check('strokes count toward width (half thickness per side) but not the hit test',
    c.includes('if (with_stroke && g->_max_sw > 0.0) {')
    && c.includes('double half = g->_max_sw * 0.5;')
    && c.includes('if (!as_bounds_walk(o, 0, 0, &l, &t, &r, &b)) return false;'));

  // CPU 侧路径包围盒：纯 C（无 Skia）构建也必须能测几何。
  check('every path mutation maintains a CPU-side bounds box',
    c.includes('static void as_gpath_pt(Graphics* g, double x, double y) {')
    && c.includes('void Graphics_lineTo(void* _this, double x, double y) { Graphics* g = (Graphics*)_this; as_skia_path_line_to(g->path, x, y); as_gpath_pt(g, x, y); as_gpen(g, x, y); }')
    && c.includes('as_skia_path_add_rect(g->path, x, y, w, h); as_gpath_rect(g, x, y, w, h); as_gclosed(g, x, y);'));

  // E（阶段九十五）：Graphics 从「单路径 + 单组画笔」升级为「有序绘制组」。
  // AIR 按 beginFill/endFill 组独立上色，旧模型会用最后写入的画笔把之前画的
  // 图形全部重涂；这里把新模型的三个不变量钉死：组在样式/endFill 处切分、
  // 画笔位置跨切分延续、渲染/命中/指纹都逐组遍历。
  check('Graphics splits draw groups at every style change and at endFill',
    c.includes('static void as_gflush(Graphics* g) {')
    && c.includes('void Graphics_endFill(void* _this) { as_gflush((Graphics*)_this); }')
    && c.includes('as_gflush(g);'));
  check('a closed group keeps its own paints instead of the last style written',
    c.includes('d->path = g->path; d->fill = g->fill; d->stroke = g->stroke;')
    && c.includes('g->fill = NULL; g->stroke = NULL; g->strokeWidth = 0.0;'));
  check('the pen position carries across a flush so a mid-path style change keeps the segment',
    c.includes('if (g->_cur_open) as_skia_path_move_to(g->path, g->_lastx, g->_lasty);')
    && c.includes('static void as_gpen(Graphics* g, double x, double y) {'));
  check('render, hit test and the bake fingerprint all walk the group list',
    c.includes('for (as_gdraw* d = (as_gdraw*)g->draws; d != NULL; d = d->next) {')
    && c.includes('static void as_graphics_paint(void* canvas, Graphics* g) {')
    && c.includes('d->fill != NULL && as_skia_path_contains(d->path, lx, ly)')
    && c.includes('h = as_fp_dbl(h, d->stroke_width);'));
  check('clear() releases the group list (the only owner of the malloc nodes)',
    c.includes('as_gdraw* next = d->next;') && c.includes('free(d);'));
  check('bounds read the CPU box, never Skia',
    c.includes('if (g == NULL || !g->_has_b) return 0;')
    && c.includes('*l = g->_bl; *t = g->_bt; *r = g->_br; *b = g->_bb;'));
  check('clear() resets the box and the stroke width',
    c.includes('g->strokeWidth = 0.0;') && c.includes('g->_has_b = 0;'));

  // C1-1：Sprite/MovieClip 也有 graphics（惰性创建，不进每个容器的分配路径）。
  check('Sprite/MovieClip expose a lazy graphics getter',
    c.includes('Graphics* Sprite_get_graphics(void* _this) {')
    && c.includes('if (o->_graphics == NULL) {')
    && c.includes('o->_graphics = Graphics_new();'));
  check('the accessor is scanned and write-barriered for the GC',
    c.includes('gc_write_barrier((void*)o->_graphics);'));
  check('geometry dispatch covers Shape and Sprite/MovieClip',
    c.includes('if (as_is((void*)o, &Shape_vt)) return ((Shape*)o)->graphics;')
    && c.includes('if (as_is((void*)o, &Sprite_vt)) return ((Sprite*)o)->_graphics;'));
  check('a container draws its own graphics under its children',
    /DisplayObjectContainer\* c = \(DisplayObjectContainer\*\)o;[\s\S]{0,700}?Graphics\* sg = as_graphics_of\(o\);[\s\S]{0,400}?for \(int i = 0; i < c->children->length; i\+\+\) as_render_object/.test(c));
  check('the auto-bake fingerprint covers Sprite/MovieClip graphics too',
    c.includes('Graphics* g = as_graphics_of(o);'));

  // 命中测试：舞台坐标 -> 逐层折算局部坐标 -> 按内容包围盒判定。
  check('the pick carries the accumulated parent matrix into each child',
    c.includes('as_mat_mul(a, b, c, d, tx, ty, ca, cb, ccn, cd, ctx, cty, &ga, &gb, &gc, &gd, &gtx, &gty);')
    && c.includes('void* res = as_pick_hit_m(ch, x, y, ga, gb, gc, gd, gtx, gty);'));
  check('the object matrix is recovered from the same transform the renderer uses',
    c.includes('as_do_point(o, &x0, &y0); as_do_point(o, &x1, &y1); as_do_point(o, &x2, &y2);')
    && c.includes('*a = x1 - x0; *b = y1 - y0; *c = x2 - x0; *d = y2 - y0; *tx = x0; *ty = y0;'));
  check('hitTestPoint takes a stage point and walks the parent chain',
    c.includes('if (!as_local_point(o, x, y, &lx, &ly)) return false;')
    && c.includes('p = (DisplayObject*)p->parent;'));
  check('MouseEvent.localX/localY and the caret index use the same mapping',
    c.includes('as_local_point(o, x, y, &tlx, &tly);')
    && c.includes('as_local_point((DisplayObject*)tf, x, y, &tfx, &tfy);'));

  // 阶段九十四·九：DisplayObject 几何/坐标 API 族（口径全部来自 adl 51.4.1
  // 实测，证据台 temp/geoprobe/）。
  check('the geometry family lives on DisplayObject and is dispatched through the vtable',
    c.includes('Rectangle* DisplayObject_getBounds(void* _this, DisplayObject* target) {')
    && c.includes('Rectangle* DisplayObject_getRect(void* _this, DisplayObject* target) {')
    && c.includes('Point* DisplayObject_localToGlobal(void* _this, Point* point) {')
    && c.includes('Point* DisplayObject_globalToLocal(void* _this, Point* point) {')
    && c.includes('bool DisplayObject_hitTestObject(void* _this, DisplayObject* obj) {')
    && c.includes('Rectangle* (*getBounds)(void*, DisplayObject*);'));
  check('hitTestPoint moved off Sprite onto DisplayObject (AIR owner)',
    c.includes('bool DisplayObject_hitTestPoint(void* _this, double x, double y, bool shapeFlag) {')
    && !c.includes('Sprite_hitTestPoint'));
  check('the local->stage matrix composes with temporaries, never aliasing as_mat_mul inputs',
    c.includes('as_mat_mul(pa, pb, pc, pd, ptx, pty, *a, *b, *c, *d, *tx, *ty, &na, &nb, &nc, &nd, &ntx, &nty);')
    && c.includes('*a = na; *b = nb; *c = nc; *d = nd; *tx = ntx; *ty = nty;'));
  check('getBounds/getRect use the stroke flag and short-circuit a self target',
    c.includes('as_rect_to_stage(o, &l, &t, &r, &b); as_rect_from_stage(target, &l, &t, &r, &b);')
    && c.includes('if (target != NULL && target != o) {')
    && c.includes('if (!as_bounds_walk(o, 1, 1, &l, &t, &r, &b)) return Rectangle_new(0.0, 0.0, 0.0, 0.0);')
    && c.includes('if (!as_bounds_walk(o, 0, 0, &l, &t, &r, &b)) return Rectangle_new(0.0, 0.0, 0.0, 0.0);'));
  // SWC 矢量：AIR 报的 Shape 包围盒 = 角色自己声明的 SWF ShapeBounds（也等于
  // 路径并集 + 描边，实测 #210/#212/#214 三者完全相等），而不是我们运行时那套
  // 路径点累积盒（它在若干角色上会偏）。命中测试刻意仍用绘制区域（decl 0）。
  check('a display getter reports a baked shape box as its declared ShapeBounds',
    c.includes('if (decl && g->_clip) {')
    && c.includes('*l = g->_clx; *t = g->_cly; *r = g->_clx + g->_clw; *b = g->_cly + g->_clh;')
    && c.includes('static int as_bounds_walk(DisplayObject* o, int with_stroke, int decl,')
    && c.includes('if (!as_bounds_walk(ch, with_stroke, decl, &cl, &ct, &cr, &cb)) continue;'));
  check('hitTestObject intersects stroke-inclusive stage boxes and rejects empties',
    c.includes('return l1 <= r2 && l2 <= r1 && t1 <= b2 && t2 <= b1;')
    && c.includes('if (!as_bounds_walk(o, 1, 1, &l1, &t1, &r1, &b1)) return false;'));
  check('a null point throws TypeError #2007 in localToGlobal/globalToLocal',
    (c.match(/Error #2007: Parameter point must be non-null\./g) || []).length === 2);

  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the pure-C Skia stubs still compile against the new geometry code',
    preamble.includes('static inline int as_skia_path_get_bounds(void* p, double* l, double* t, double* r, double* b) { (void)p;'));

  return bad;
}

// ---- DisplayObject.transform.matrix, the TextField repaint fingerprint, cursors ----
// Three adl-fidelity fixes measured in stage 89-51:
//  * `X.transform.matrix` used to be a raw read/write of Transform's own matrix
//    slot, so `get -> rotate(30) -> set` left the object at its old x/y and moved
//    the artwork instead of the object (adl moves the object: assigning a matrix
//    re-derives x/y/rotation/scaleX/scaleY). Reads and writes now route through a
//    compose/decompose accessor pair.
//  * A TextField's auto-bake fingerprint (its repaint signature) ignored the
//    selection range and scroll offset, so a drag-selection only showed up once
//    something else forced a repaint (scrolling).
//  * `Mouse.cursor` was stored but never applied: selectable text never got an
//    I-beam (adl shows one). The generated mouse handler now samples the cursor
//    after dispatch and pushes it to the glue.
function checkTransformMatrix(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [xform] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [xform] ${label}`); }
  };

  const src = [
    'import flash.display.Shape;',
    'import flash.display.Stage;',
    'import flash.geom.Matrix;',
    'import flash.text.TextField;',
    'var s:Shape = new Shape();',
    'var m:Matrix = new Matrix(2, 0, 0, 2, 5, 6);',
    's.transform.matrix = m;',
    'var r:Matrix = s.transform.matrix;',
    'var q:Matrix = (s.transform.matrix = m);',
    'var f:TextField = new TextField();',
    'var t:String = f.text;',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  const webGlue = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8');
  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i) + 2);
  };
  const count = (s: string, sub: string): number => s.split(sub).length - 1;

  // (1) The accessor pair exists and the expression routes through it on both
  // sides. The old failure mode was a silent no-op: `transform->matrix` was read
  // and written directly, so the write never reached x/y/rotation/scale.
  const getter = body('static Matrix* DisplayObject_get_transform_matrix(void* _this) {');
  const setter = body('static void DisplayObject_set_transform_matrix(void* _this, Matrix* m) {');
  check('a Shape built per-case emits both accessors', getter.length > 0 && setter.length > 0);
  check('the read is the accessor, not Transform\'s raw matrix slot',
    c.includes('DisplayObject_get_transform_matrix((void*)'));
  check('the write is the accessor, not a raw slot store',
    count(c, 'DisplayObject_set_transform_matrix((void*)') >= 2);
  // The getter must hand back a fresh Matrix: adl returns a copy, so mutating the
  // result without setting it back must not move the object.
  check('the getter returns a copy (Matrix_new), never the stored matrix',
    getter.includes('return Matrix_new(') && !getter.includes('return o->transform->matrix;'));

  // (2) The decomposition gauge is the one measured on adl: rotation=atan2(b,a),
  // scaleX=hypot(a,b), determinant sign folded into scaleY, and the residual
  // (skew, if any) re-based on the linear factor so the render stays exact.
  check('rotation comes from atan2(b, a) and the scale from the column norms',
    setter.includes('atan2(m->b, m->a)') && setter.includes('sqrt(m->a * m->a + m->b * m->b)')
    && setter.includes('sqrt(m->c * m->c + m->d * m->d)'));
  check('a negative determinant folds into scaleY', setter.includes('if (det < 0.0) sy = -sy;'));
  check('the residual is re-based (tx/ty zeroed) so it only holds the skew',
    setter.includes('dst->tx = 0.0; dst->ty = 0.0;'));
  check('a singular linear factor still renders the assigned matrix',
    setter.includes('if (sx == 0.0 || sy == 0.0) {') && setter.includes('*dst = *m;'));

  // (3) `a = b.transform.matrix = m` is a property write in AIR, so the expression
  // yields the assigned matrix. The setter returns void, so a value context must
  // hoist the RHS into a temp instead of nesting the call.
  check('a valued transform.matrix write is hoisted, never nested as a void operand',
    !c.includes('(Matrix*)(DisplayObject_set_transform_matrix') && !c.includes(' = DisplayObject_set_transform_matrix'));

  // (4) Repaint fingerprint: the TextField branch of as_render_fp must include the
  // selection range and the scroll offset (and the layout inputs that were already
  // stale-prone), or a drag-selection is invisible until something else repaints.
  const fpStart = c.indexOf('static uint32_t as_render_fp(DisplayObject* o) {');
  const fp = fpStart < 0 ? '' : c.slice(fpStart, c.indexOf('\nstatic ', fpStart + 10));
  check('the TextField fingerprint covers the selection range and scroll offset',
    ['tf->_sel_begin', 'tf->_sel_end', 'tf->_scroll_h'].every((f) => fp.includes(f)));
  check('...and the run list, so a text change invalidates it', fp.includes('tf->_runs'));
  check('...and the layout inputs (align / autoSize / textColor)',
    ['f->align', 'tf->autoSize', 'tf->textColor'].every((f) => fp.includes(f)));

  // (5) Cursor: the glue seam must exist on every backend, the sampler must run
  // after the mouse dispatch (a listener may set Mouse.cursor or toggle
  // selectable), and leaving the window must restore the arrow.
  check('the generated mouse handler samples the cursor after dispatching',
    c.includes('ASC_window_update_cursor(') && /ASC_window_update_cursor\(id, [^)]*\);\s*\n\s*}\s*\n\s*\n?/.test(c));
  check('the sampler maps Mouse.cursor names and falls back to hit testing',
    body('static int ASC_cursor_kind_of_name(const char* name) {').includes('"ibeam"')
    && c.includes('ASC_cursor_kind_of_name'));
  check('selectable text is reported as an I-beam, everything else the arrow',
    c.includes('AS_CURSOR_IBEAM : AS_CURSOR_ARROW') && c.includes('&TextField_vt'));
  // The AS_CURSOR_* kinds are needed by the generated sampler in EVERY build, so
  // they must be defined exactly ONCE and OUTSIDE the backend branches. A
  // per-branch copy is how the documented "Skia offscreen, no window" manifest
  // lost its enum and stopped compiling (2026-10-06: 10 x "use of undeclared
  // identifier", examples/skia-link.build.example.json); pinning the count keeps
  // the duplication from creeping back, and pinning the position keeps a future
  // copy from landing inside a branch again.
  const cursorDefine = preamble.indexOf('#define AS_CURSOR_ARROW');
  const firstBranch = Math.min(
    ...[preamble.indexOf('#ifdef ASC_USE_SKIA'), preamble.indexOf('#ifdef ASC_USE_WINDOW'),
        preamble.indexOf('#ifdef ASC_RENDER_')].filter((i) => i >= 0));
  check('the cursor kinds are defined exactly once',
    count(preamble, '#define AS_CURSOR_IBEAM  1') === 1);
  check('...and outside every backend branch, so no define set can miss them',
    cursorDefine >= 0 && cursorDefine < firstBranch);
  check('the runtime calls the glue through the as_window_* seam',
    preamble.includes('as_window_set_cursor(int id, int kind) {') && preamble.includes('sk_window_set_cursor(id, kind);')
    && preamble.includes('extern void sk_window_set_cursor(int id, int kind);'));
  check('the native glue defines the seam and caches one SDL_Cursor per kind',
    glue.includes('void sk_window_set_cursor(int id, int kind)') && glue.includes('SDL_CreateSystemCursor')
    && glue.includes('static SDL_Cursor* g_cursors[4]'));
  check('the glue declares the seam before the event pump uses it',
    glue.indexOf('void sk_window_set_cursor(int id, int kind);') < glue.indexOf('SDL_WINDOWEVENT_LEAVE'));
  check('leaving the window restores the arrow',
    glueBodyArrow(glue).includes('SK_CURSOR_ARROW'));
  check('the web glue stubs the seam so wasm builds still link',
    webGlue.includes('void sk_window_set_cursor(int id, int kind) { (void)id; (void)kind; }'));

  if (ok > 0) console.log(`[xform] ${ok} transform/cursor checks passed`);
  return bad;
}

// ---- DisplayObject.scale9Grid (stage 101) ----
//
// The AS3 property over the DefineScalingGrid slots, aligned with adl 51.4.1
// (examples/scale9grid.as carries the behavioural assertions; the catches below are
// negative/source-level facts an example cannot pin). The trap this group guards is
// that AIR validates the RAW numbers (so (0.5,0.5,5,5) is inside while (0,5,5,5) is
// not), stores the TRUNCATED ones, and keeps the truncated grid readable after it
// throws -- the store order and the separation of "present" (_s9_on, the getter) from
// "apply" (_s9_apply, the renderer) are exactly what makes that observable behaviour
// hold, so both are pinned here.
function checkScale9Grid(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [s9grid] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [s9grid] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\(\'((?:[^\'\\]|\\.)*)\'/g)].map((m) => m[1]).join('\n');
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const example = readFileSync(join(root, 'examples', 'scale9grid.as'), 'utf8');
  // The generated C itself, for the bits that are emitted through template literals
  // (the reflection shims and the SWC bind line) and therefore invisible to the
  // `this.line('...')` scrape above.
  const gen = generateC(parse('import flash.display.Sprite;\nimport flash.geom.Rectangle;\n'
    + 'var s:Sprite = new Sprite();\ns.scale9Grid = new Rectangle(10, 10, 5, 5);\n'
    + 'trace(s.scale9Grid.x);\n')).c;

  // The property is an accessor pair over the private C slots -- NOT an AS3 field.
  // Declaring a `_s9x` member in symbols.ts would emit a second `double _s9x;` in
  // every display struct, so pin both the declaration and the single C field.
  check('scale9Grid is a declared getter/setter of type Rectangle',
    symbols.includes("['scale9Grid', dog({ kind: 'object', className: 'Rectangle' })]") &&
    symbols.includes("['scale9Grid', dos('Rectangle')]"));
  check('the grid slots are not exposed as AS3 fields (no duplicate C field)',
    !/[\[]'_s9/.test(symbols) &&
    (emitted.match(/double _s9x;/g) || []).length === 1 &&
    (emitted.match(/int _s9_apply;/g) || []).length === 1);

  // Getter: fresh Rectangle per read, built from the truncated slots.
  check('the getter builds a FRESH Rectangle from the stored slots',
    emitted.includes('Rectangle* DisplayObject_get_scale9Grid(void* _this) {') &&
    emitted.includes('if (!o->_s9_on) return NULL;') &&
    emitted.includes('return Rectangle_new(o->_s9x, o->_s9y, o->_s9w, o->_s9h);'));

  // Setter: validate the raw numbers, store truncated, keep the present bit even when
  // invalid, then throw #2004.
  check('the setter validates the RAW numbers before truncating them',
    emitted.indexOf('int ok = as_do_s9_valid(o, x, y, w, h);') > -1 &&
    emitted.indexOf('int ok = as_do_s9_valid(o, x, y, w, h);') <
      emitted.indexOf('o->_s9x = trunc(x); o->_s9y = trunc(y); o->_s9w = trunc(w); o->_s9h = trunc(h);'));
  check('storage truncates toward zero',
    emitted.includes('o->_s9x = trunc(x); o->_s9y = trunc(y); o->_s9w = trunc(w); o->_s9h = trunc(h);'));
  check('presence and application are separate bits',
    emitted.includes('o->_s9_on = 1; o->_s9_apply = ok;'));
  check('the throw happens AFTER the store, so the getter still reports it',
    emitted.indexOf('o->_s9_on = 1; o->_s9_apply = ok;') <
      emitted.indexOf('as_throw(ArgumentError_new((char*)"Error #2004: One of the parameters is invalid.", 2004))'));
  check('null clears both bits and returns early',
    emitted.includes('if (value == NULL) { o->_s9_on = 0; o->_s9_apply = 0; return; }'));

  // Validation: strictly inside, non-degenerate, bounds come from the object.
  check('validation is strict on all four sides',
    emitted.includes('return x > l && y > t && x + w < r && y + h < b;'));
  check('a degenerate grid is invalid and an empty object has no valid grid',
    emitted.includes('if (!(w > 0.0) || !(h > 0.0)) return 0;') &&
    emitted.includes('if (!as_bounds_walk(o, 1, 1, &l, &t, &r, &b)) return 0;'));

  // Renderer/ctor/wiring.
  check('the 9-slice render gate reads the apply bit, not the present bit',
    emitted.includes("if (o->_s9_apply && (o->scaleX != 1.0 || o->scaleY != 1.0)) {"));
  check('a DefineScalingGrid character sets both bits, so SWC rendering is unchanged',
    emitSource.includes('o->_s9_on = 1; o->_s9_apply = 1; o->_s9x = ${this.formatDouble(g.x)}'));
  check('the DisplayObject ctor resets both bits',
    emitted.includes('o->_s9_on = 0;') && emitted.includes('o->_s9_apply = 0;'));
  check('the dynamic shim unwraps a Rectangle argument (null-safe: #1009 via as_req_inst)',
    gen.includes('DisplayObject_set_scale9Grid(_this, ((Rectangle*)as_v_req_inst(args[0], &Rectangle_vt, "flash.geom::Rectangle")));'));
  check('the compiled accessors are the ones this group pinned',
    gen.includes('static Rectangle* DisplayObject_get_scale9Grid(void* _this) {')
    && gen.includes('return Rectangle_new(o->_s9x, o->_s9y, o->_s9w, o->_s9h);')
    && gen.includes('static int as_do_s9_valid(DisplayObject* o, double x, double y, double w, double h) {')
    && gen.includes('o->_s9_on = 1; o->_s9_apply = ok;')
    && gen.includes('as_throw(ArgumentError_new((char*)"Error #2004: One of the parameters is invalid.", 2004));')
    && gen.includes('if (o->_s9_apply && (o->scaleX != 1.0 || o->scaleY != 1.0)) {'));

  // The example has to be the positive regression, and it must cover the raw-value
  // trap (the one case that separates "validate raw" from "validate truncated").
  check('the example pins the raw-value vs truncated-value trap',
    example.includes('check(setAndRead(box(30, 30, 0, 0), 0.5, 0.5, 5, 5) == "ok", "validation uses the RAW values: (0.5,..) is inside");') &&
    example.includes('check(setAndRead(valid, 25, 25, 5, 5) == "THROW 2004", "touching right/bottom throws");') &&
    example.includes('trace("scale9grid: all assertions passed");'));

  if (ok > 0) console.log(`[s9grid] ${ok} scale9Grid checks passed`);
  return bad;
}

// The SDL_WINDOWEVENT_LEAVE arm of the glue's event switch, isolated so the check
// cannot be satisfied by some other SK_CURSOR_ARROW mention.
function glueBodyArrow(glue: string): string {
  const i = glue.indexOf('SDL_WINDOWEVENT_LEAVE) {');
  return i < 0 ? '' : glue.slice(i, i + 400);
}

// ---- TextField.getLineMetrics / flash.text.TextLineMetrics (stage 103) ----
//
// The numbers have to follow AIR's model, which was measured on adl 51.4.1
// (temp/metricprobe/: Metrics6.as, Align6.as, Lead7.as):
//   * out of range -> RangeError #2006 (NOT null);
//   * "height == ascent + descent + leading" with ascent/descent INDEPENDENT of the
//     leading (Monaco 12: 12/3 at leading 0, 4, 10 and -3), so the leading is
//     stripped back out of Skia's stride-derived split; a NEGATIVE leading has to
//     take the AIR face model because Skia folds it into the strut and drags the
//     baseline (measured drift 12.6/2.4 vs AIR's 12/3);
//   * x == 2px inset + a PER-LINE alignment shift (center 89/75, right 176/147.5 on a
//     200px field), which is why this uses as_tf_align_index + the line's own width
//     rather than the painter's whole-block as_tf_align_dx;
//   * an empty field is still 1 line and reports textHeight/textWidth 0 (both paths).
function checkLineMetrics(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [linemetrics] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [linemetrics] ${label}`); }
  };

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const runtime = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const symbols = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  const example = readFileSync(join(root, 'examples', 'textline.as'), 'utf8');
  // The generated C, for the parts that come out of template literals (the vtable
  // entries and the reflection shims) and are invisible to the scrape above.
  const gen = generateC(parse('import flash.text.TextField;\nimport flash.text.TextLineMetrics;\n'
    + 'var tf:TextField = new TextField();\ntf.text = "a\\nb";\n'
    + 'var m:TextLineMetrics = tf.getLineMetrics(0);\ntrace(m.height, m.ascent);\n')).c;

  // ---- the AS3 surface -------------------------------------------------
  check('TextLineMetrics declares the six Number fields',
    symbols.includes("this.classMap.set('TextLineMetrics', {") &&
    ['x', 'width', 'height', 'ascent', 'descent', 'leading'].every((f) =>
      symbols.includes(`['${f}', tlmf({ kind: 'number' })]`)));
  check('its constructor takes exactly the six documented Numbers, in order',
    /this\.classMap\.set\('TextLineMetrics', \{[\s\S]{0,2500}?constructor: \{ params: \[[\s\S]{0,900}?\{ name: 'x'[\s\S]{0,600}?\{ name: 'leading'/.test(symbols) &&
    (symbols.match(/set\('TextLineMetrics', \{[\s\S]{0,2500}?constructor: \{ params: \[([\s\S]{0,900}?)\] \}/) || ['', ''])[1]
      .split('name:').length - 1 === 6);
  check('TextField.getLineMetrics(index:int) is declared as returning a TextLineMetrics',
    symbols.includes("['getLineMetrics', txm({ kind: 'object', className: 'TextLineMetrics' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])]"));

  // ---- the C function --------------------------------------------------
  check('the line count comes from as_tf_line_table, and the range check throws #2006',
    emitted.includes('int n = as_tf_line_table(tf, starts, NULL, NULL, AS_TF_MAX_LINES);') &&
    emitted.includes('if (index < 0 || index >= n) { as_throw(RangeError_new((char*)"Error #2006: The supplied index is out of bounds.", 2006)); return NULL; }'));
  // The body, isolated: textHeight's no-Skia branch DOES clamp a negative leading
  // (a different model -- it approximates a line height), so a whole-file search
  // for a clamp would false-positive. getLineMetrics must pass it through verbatim.
  const lmBody = gen.slice(gen.indexOf('static TextLineMetrics* TextField_getLineMetrics(void* _this, int index) {'));
  const lmBodyScoped = lmBody.slice(0, lmBody.indexOf('\n}\n'));
  check('the leading comes from defaultTextFormat and is NOT clamped',
    lmBodyScoped.includes('double lead = (tf->defaultTextFormat != NULL) ? tf->defaultTextFormat->leading : 0.0;') &&
    !/lead\s*<\s*0/.test(lmBodyScoped));
  check('the per-line box is asked for the default format face plus that leading',
    emitted.includes('as_skia_textlayout_line_box(para, index, lead, fam, size, bold, italic, &asc, &desc, &left, &w);'));
  check('x is the 2px text inset plus the line box left offset',
    emitted.includes('double x = 2.0 + left;'));
  check('the alignment shift is PER LINE, taken from the line width (not as_tf_align_dx)',
    lmBodyScoped.includes('int a = as_tf_align_index(tf->defaultTextFormat);') &&
    lmBodyScoped.includes('double inner = tf->_fieldWidth - 4.0;') &&
    lmBodyScoped.includes('if (a == 2) x += (inner - w) / 2.0;') &&
    lmBodyScoped.includes('else if (a == 1) x += inner - w;') &&
    !lmBodyScoped.includes('as_tf_align_dx'));
  check('a wrapping field leaves the alignment to Skia (the guard skips the shift)',
    emitted.includes('if (!(tf->wordWrap && tf->_fieldWidth > 0.0) && tf->defaultTextFormat != NULL) {'));
  check('height is built as ascent + descent + leading, in that argument order',
    emitted.includes('return TextLineMetrics_new(x, w, asc + desc + lead, asc, desc, lead);'));
  check('the compiled function is the one this group pinned',
    gen.includes('static TextLineMetrics* TextField_getLineMetrics(void* _this, int index) {') &&
    gen.includes('as_throw(RangeError_new((char*)"Error #2006: The supplied index is out of bounds.", 2006));') &&
    gen.includes('return TextLineMetrics_new(x, w, asc + desc + lead, asc, desc, lead);'));

  // ---- the value type --------------------------------------------------
  check('the ctor assigns the six fields in declaration order',
    emitted.includes('o->x = x; o->width = width; o->height = height;') &&
    emitted.includes('o->ascent = ascent; o->descent = descent; o->leading = leading;'));
  check('new allocates on the GC heap and sets the vtable (closed over by the GC)',
    emitted.includes('TextLineMetrics* o = (TextLineMetrics*)gc_alloc(GCT_CLASS, sizeof(TextLineMetrics));') &&
    emitted.includes('o->vtable = &TextLineMetrics_vt;'));
  check('the class is registered as an Object subclass and gets a vtable slot',
    gen.includes('static TextLineMetrics_vtable TextLineMetrics_vt = { "TextLineMetrics", &Object_vt,') &&
    gen.includes('TextLineMetrics* (*getLineMetrics)(void*, int);'));
  check('TextField\'s vtable and method table expose it through both call forms',
    gen.includes('TextField_getLineMetrics,') &&
    gen.includes('{ "getLineMetrics", TextField_getLineMetrics__dyn }') &&
    // The dynamic thunk's argument is a typed `int` parameter, so it COERCES
    // (ES3 ToInt32); the raw as_v_int_val would read .num and turn a String index
    // into 0 (see unit: emit/DynamicSlotCoercion).
    gen.includes('TextField_getLineMetrics((TextField*)_this, as_v_int_cast(args[0]))'));

  // ---- the glue model --------------------------------------------------
  check('the glue takes the leading and the face explicitly, and writes four outs',
    glue.includes('int sk_textlayout_line_box(void* para, int idx, double leading, const char* family, double size,') &&
    glue.includes('int bold, int italic,') &&
    glue.includes('double* ascent, double* descent, double* left, double* width) {'));
  check('an empty field falls back to the AIR face metrics with width 0',
    /if \(idx >= n\) \{[\s\S]{0,600}?if \(idx != 0 \|\| n != 0\) return 0;[\s\S]{0,300}?SkAirLineMetrics am = sk_air_line_metrics\(family, size, bold, italic\);/.test(glue) &&
    glue.includes('if (left) *left = 0.0;') && glue.includes('if (width) *width = 0.0;'));
  check('the stride is derived from the baselines (paragraph height for a single line)',
    glue.includes('double stride = (n > 1) ? (lm[n - 1].fBaseline - lm[0].fBaseline) / (double)(n - 1)') &&
    glue.includes(': (double)((Paragraph*)para)->getHeight();') &&
    glue.includes('double asc = (double)m.fBaseline - (double)idx * stride - leading;') &&
    glue.includes('double desc = stride - leading - asc;'));
  check('a negative leading switches to the AIR face split (Skia folds it into the strut)',
    glue.includes('if (leading < 0.0) {') &&
    /if \(leading < 0\.0\) \{[\s\S]{0,900}?asc = am\.asc;[\s\S]{0,120}?desc = am\.desc;/.test(glue));
  check('left/width come from the line box itself',
    glue.includes('if (left) *left = (double)m.fLeft;') &&
    glue.includes('if (width) *width = (double)m.fWidth;'));

  // ---- runtime plumbing: extern + BOTH stubs ---------------------------
  check('runtime declares the extern so C99 does not reject the call',
    runtime.includes('extern int sk_textlayout_line_box(void* para, int idx, double leading, const char* family, double size, int bold, int italic, double* ascent, double* descent, double* left, double* width);'));
  check('both the Skia and the no-Skia inline stubs forward the same 11 arguments',
    runtime.includes('static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { return sk_textlayout_line_box(p, i, ld, fam, sz, b, it, a, d, l, w); }') &&
    runtime.includes('static inline int as_skia_textlayout_line_box(void* p, int i, double ld, const char* fam, double sz, int b, int it, double* a, double* d, double* l, double* w) { (void)p; (void)i; (void)ld; (void)fam; (void)sz; (void)b; (void)it; (void)a; (void)d; (void)l; (void)w; return 0; }'));

  // ---- the empty-field fix in textHeight/textWidth ---------------------
  check('textHeight returns 0 for an empty field on BOTH paths (Skia and stub)',
    emitted.includes('if (as_skia_textlayout_line_count(para) == 0) return 0.0;') &&
    emitted.includes('const char* t = as_tf_layout_text(tf);') &&
    emitted.includes('if (t == NULL || t[0] == 0) return 0.0;'));
  check('textWidth guards the empty paragraph instead of reporting -FLT_MAX',
    /static double TextField_get_textWidth\(void\* _this\) \{[\s\S]{0,260}?if \(as_skia_textlayout_line_count\(para\) == 0\) return 0\.0;[\s\S]{0,120}?as_skia_textlayout_max_width\(para\)/.test(gen));

  // ---- the example -----------------------------------------------------
  check('the example asserts the adl-measured model (#2006, leading per line, height identity)',
    example.includes('check(errId(empty, 1) == 2006, "getLineMetrics(1) on a 1-line field throws #2006");') &&
    example.includes('check(q0.leading == 4 && q1.leading == 4, "leading is reported on every line, last included");') &&
    example.includes('check(n0.height == n0.ascent + n0.descent - 3, "negative leading shrinks the line height");') &&
    example.includes('check(empty.textHeight == 0, "an empty field has textHeight 0");'));
  check('the example stays valid under the no-Skia regression build (font metrics guarded)',
    example.includes('if (l0.ascent > 0) {') &&
    example.includes('check(l0.ascent == 0 && l0.descent == 0, "no-Skia fallback reports zero font metrics");') &&
    example.includes('trace("textline: all assertions passed; lines="'));
  check('the ctor order and w/h model are asserted in the example too',
    example.includes('check(m.leading == 6, "ctor arg order (leading)");') &&
    example.includes('check(m.ascent == 9.5, "ascent is writable");'));

  if (ok > 0) console.log(`[linemetrics] ${ok} getLineMetrics checks passed`);
  return bad;
}

registerGroup('unit: display/HitShape', checkHitShape);
registerGroup('unit: display/DisplayGeometry', checkDisplayGeometry);
registerGroup('unit: display/TransformMatrix', checkTransformMatrix);
registerGroup('unit: display/Scale9Grid', checkScale9Grid);
registerGroup('unit: display/LineMetrics', checkLineMetrics);
