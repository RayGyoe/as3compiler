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

  // ---- SimpleButton: no shape of its own (D3) ----
  // adl 51.4.1 实测（temp/sbtnstate2，七个探针）：按钮的 shapeFlag=true 命中区恒为空
  // （四态是独立 DisplayObject，hitTestState 只是**事件输入**的命中区），且 upState==NULL 时
  // 什么都不画、width/height/getRect 全 0。
  check('a SimpleButton has no shapeFlag region of its own',
    emitted.includes('if (as_is((void*)o, &SimpleButton_vt)) return false;') &&
    !/as_obj_region_hit_local\(DisplayObject\* o, double lx, double ly\) \{[\s\S]{0,1500}?as_sbtn_contains_local/.test(emitted));
  // ---- 鼠标拾取与 hitTestPoint 是两条路（阶段一百五十七 D20）----
  // 真应用里 29 个 `DefineButton2` / 73 处 placement 全点不动，而同类位置的 Sprite 按钮能点：
  // 那些按钮是「**隐形点击靶**」（SWF 里只有 down + hit 两条记录、没有 up），`upState == NULL`
  // ⇒ `as_bounds_walk` 的 PAINT 状态拿不到任何盒子 ⇒ 包围盒拾取永远失败。AIR 是拿**命中态**
  // 做拾取的（与 hover 同一个判据），所以拾取必须走 `as_sbtn_contains_local`；
  // 而 `hitTestPoint(x, y, false)` 仍走包围盒（无 up 态时 0x0 就是 adl 的实测答案）—— 两条路不得混。
  check('the mouse pick path asks a button through its hit state, not its painted box',
    emitted.includes('static bool as_pick_hit_local(DisplayObject* o, double lx, double ly) {') &&
    /as_pick_hit_local\(DisplayObject\* o, double lx, double ly\) \{[\s\S]{0,400}?if \(as_is\(\(void\*\)o, &SimpleButton_vt\)\) return as_sbtn_contains_local\(\(SimpleButton\*\)o, lx, ly\) != 0;/.test(emitted) &&
    emitted.includes('if (as_pick_hit_local(o, lx, ly) && ((InteractiveObject*)obj)->mouseEnabled) return obj;') &&
    !emitted.includes('if (as_obj_hit_local(o, lx, ly) && ((InteractiveObject*)obj)->mouseEnabled) return obj;'));
  check('hitTestPoint keeps the bounding-box path for a button',
    /static bool as_pick_hit_local[\s\S]{0,400}?return as_obj_hit_local\(o, lx, ly\);/.test(emitted) &&
    emitted.includes('if (shapeFlag) return as_obj_region_hit(_this, x, y);'));
  check('the SimpleButton hit region never falls back to the button itself',
    emitted.includes('DisplayObject* hs = (b->hitTestState != NULL) ? b->hitTestState : b->upState;') &&
    emitted.includes('if (hs == NULL) return 0;') &&
    !emitted.includes('? b->upState : (DisplayObject*)b)'));
  check('upState==NULL paints nothing',
    emitted.includes('if (b->upState == NULL) return NULL;'));

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
    c.includes('as_mat_mul(oa, ob, oc, od, otx, oty, ca, cb, ccn, cd, ctx, cty, &ga, &gb, &gc, &gd, &gtx, &gty);')
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
//     split back out of the line box (h = asc + desc + leading) instead of being
//     folded into the ascent. The box itself is Skia's per-line height, so a rich
//     paragraph gets one box PER LINE rather than a paragraph-wide average;
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
  check('x is the 2px inset, the block align shift and the line box left offset',
    emitted.includes('double x = 2.0 + as_tf_align_dx(tf) + left;'));
  // A field with no layout width (wordWrap off) still honours horizontalAlign PER
  // LINE (adl: 200 px center field, "abc\\ndefghij" -> line left edges 89/75).
  // Skia can only align inside a layout width, so the paragraph is laid out
  // unwrapped once to measure the longest line, then re-laid-out at that width
  // with the real align: no line exceeds it, nothing wraps, and the shifts of the
  // two stages sum to AIR's per-line offset (the M terms cancel, hence the +1).
  check('a width-less field hands its align to the paragraph, sized to its longest line',
    emitted.includes('if (w <= 0.0 && (align == 1 || align == 2)) layoutAlign = align;') &&
    emitted.includes('void* pp = as_skia_textlayout_new_leading(ltext, fmt->font, size, bold, italic, color, leading, 0.0, 0, collapse);') &&
    emitted.includes('void* pr = as_skia_textlayout_new_runs(ltext, &dr, runs, n, 0.0, 0, collapse);') &&
    emitted.includes('sk_text_run dr;') &&
    emitted.includes('dr.family = fmt->font; dr.size = size;') &&
    emitted.includes('if (m > 0.0) pw = m + 1.0; else pa = 0;') &&
    emitted.includes('tf->_para = as_skia_textlayout_new_leading(ltext, fmt->font, size, bold, italic, color, leading, pw, pa, collapse);') &&
    emitted.includes('tf->_para = as_skia_textlayout_new_runs(ltext, &dr, runs, n, pw, pa, collapse);'));
  // justify needs a wrap width to stretch into: it is left to the old path.
  check('justify keeps the old path (only center/right are carried into a width-less paragraph)',
    !emitted.includes('&& (align == 3') && !emitted.includes('align <= 3'));
  check('a wrapping field leaves the alignment to Skia (as_tf_align_dx returns 0)',
    emitted.includes('if (tf->wordWrap && tf->_fieldWidth > 0.0) return 0.0;'));
  check('the hit test subtracts the same block shift (a click in a centered field)',
    emitted.includes('double lx = x + (double)leftpx - 2.0 - as_tf_align_dx(tf);'));
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
    // as_method is { name, fn, vis, sig }: the trailing sig is describeType's
    // <method><parameter/></method> source.
    gen.includes('{ "getLineMetrics", TextField_getLineMetrics__dyn, 0, "flash.text::TextLineMetrics;int" }') &&
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
  // The per-line box is Skia's own LineMetrics::fHeight, and the ascent/descent
  // pair is scaled into (box - leading) because a forced box (strut or per-run
  // height override) leaves Skia reporting the UNFORCED halves there (measured on
  // Windows/Arial 12: a 12 px box reports asc 10 / desc 4).
  check('the line box is Skia\'s own per-line height, not a stride over the paragraph',
    glue.includes('const double lh = (double)m.fHeight;') &&
    !glue.includes('double stride = (n > 1) ? (lm[n - 1].fBaseline') &&
    !glue.includes('(double)idx * stride'));
  check('the ascent/descent pair is scaled so that asc + desc + leading == the box',
    glue.includes('const double sum = (double)m.fAscent + (double)m.fDescent;') &&
    glue.includes('const double model = lh - leading;') &&
    glue.includes('const double k = (sum > 0.0 && model > 0.0) ? model / sum : 1.0;') &&
    glue.includes('double asc = (double)m.fAscent * k;') &&
    glue.includes('double desc = (double)m.fDescent * k;') &&
    !glue.includes('if (leading < 0.0) {'));
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

// ---- display-list add/remove events (the TalkMED ViewControl leak) ----------
//
// AIR dispatches ADDED/REMOVED (bubbling) and ADDED_TO_STAGE/REMOVED_FROM_STAGE
// (non-bubbling, one per descendant) on every add/remove; nothing stage-related
// when the container is off the stage; and addChild() of an object that already
// has a parent first removes it (REMOVED through the OLD parent, then ADDED).
// Every expected string in the example is verbatim adl 51.4.1 output
// (temp/dlprobe/), and the example is what test/examples.ts executes; these are
// the source-level invariants behind it. Not cosmetic: TalkMED's
// com.vsdevelop.proxy.ViewControl listens for Event.REMOVED and stops a leaked
// Timer from it -- with no "removed" at all, closing the WeChat scan-code dialog
// left its 2 s poll running forever.
function checkListEvents(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [listev] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [listev] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');

  check('ADDED/REMOVED bubble, the stage pair does not',
    emitted.includes('EventDispatcher_dispatchEvent(child, Event_new((char*)"added", true, false));') &&
    (emitted.match(/EventDispatcher_dispatchEvent\(child, Event_new\(\(char\*\)"added", true, false\)\);/g) ?? []).length === 2 &&
    emitted.includes('EventDispatcher_dispatchEvent(child, Event_new((char*)"removed", true, false));') &&
    emitted.includes('as_disp_stage_walk(child, (char*)"addedToStage");') &&
    emitted.includes('as_disp_stage_walk(child, (char*)"removedFromStage");') &&
    emitted.includes('EventDispatcher_dispatchEvent((void*)o, (Event*)Event_new(type, false, false));'));

  check('the stage pair walks the whole subtree, parent first',
    emitted.includes('static void as_disp_stage_walk(DisplayObject* o, char* type) {') &&
    emitted.includes('if (!as_is((void*)o, &DisplayObjectContainer_vt)) return;') &&
    emitted.includes('for (int i = 0; i < c->children->length; i++) as_disp_stage_walk((DisplayObject*)as_v_obj_val(c->children->data[i]), type);'));

  // DisplayObject_get_stage deliberately falls back to ASC_root_stage (the document
  // class's `stage` is non-null in its constructor, matching Flash) -- but an orphan
  // is NOT on the stage in AIR, so the event path must ask the strict question.
  check('off-stage containers dispatch no stage events (no root-stage fallback)',
    emitted.includes('static int as_on_stage(DisplayObject* o) {') &&
    emitted.includes('return o->vtable != NULL && strcmp(o->vtable->cls_name, "Stage") == 0;') &&
    (emitted.match(/if \(as_on_stage\(\(DisplayObject\*\)_this\)\) as_disp_stage_walk\(child, /g) ?? []).length === 2 &&
    emitted.includes('int was_on_stage = as_on_stage(child);') &&
    !emitted.includes('if (DisplayObject_get_stage(_this) != NULL) EventDispatcher_dispatchEvent(child,'));

  // AIR dispatches REMOVED while the child is still attached (the handler sees
  // parent/numChildren/index intact and the event bubbles to the parent).
  check('REMOVED is dispatched before the child is detached, then re-found',
    emitted.includes('int was_on_stage = as_on_stage(child);') &&
    emitted.includes('as_disp_stage_walk(child, (char*)"removedFromStage");') &&
    emitted.includes('if ((DisplayObject*)as_v_obj_val(c->children->data[i]) != child) continue;') &&
    emitted.includes('if (child->parent == (Object*)_this) child->parent = NULL;') &&
    emitted.includes('return DisplayObjectContainer_removeChild(_this, (DisplayObject*)as_v_obj_val(c->children->data[index]));'));

  check('addChild implicitly re-parents through the old parent first',
    (emitted.match(/if \(child->parent != NULL\) DisplayObjectContainer_removeChild\(\(void\*\)child->parent, child\);/g) ?? []).length === 2);

  // The behaviour itself is pinned by the example (run by test/examples.ts).
  const example = readFileSync(join(root, 'examples', 'displaylist-events.as'), 'utf8');
  check('the example asserts the adl-measured sequences verbatim',
    example.includes('check("addChild", "kid:added b=1 p=2 kid:added b=1 p=3 kid:addedToStage b=0 p=2 ");') &&
    example.includes('check("nested addChild", "grand:added b=1 p=2 grand:added b=1 p=3 grand:added b=1 p=3 grand:addedToStage b=0 p=2 ");') &&
    example.includes('check("removeChild", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 ");') &&
    example.includes('check("removeChildAt", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 grand:removedFromStage b=0 p=2 ");') &&
    example.includes('check("addChild off stage", "c2:added b=1 p=2 ");') &&
    example.includes('check("re-parent", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 grand:removedFromStage b=0 p=2 kid:added b=1 p=2 kid:addedToStage b=0 p=2 grand:addedToStage b=0 p=2 ");') &&
    example.includes('check("subtree remove", "sub:removed b=1 p=2 sub:removedFromStage b=0 p=2 subsub:removedFromStage b=0 p=2 ")'));

  if (ok > 0) console.log(`[listev] ${ok} display-list event checks passed`);
  return bad;
}

// ---- TextField.autoSize 的大小口径 + 装不上的字族的兜底脸（阶段一百六十八）----
//
// 两个 AIR 保真回归，都用 adl 51.4.1 双端同源探针定过真值（temp/tfswc 的 case ⑥⑦⑧⑨⑩，
// 修后 AOT 侧与 adl 的报告逐字相同）：
//   ① wordWrap=true 时 autoSize **只改高度**（height = textHeight + 4），宽度保持用户值；
//      只有 wordWrap=false 才 width = textWidth + 4。旧的「高度从当前换行宽算、宽度取换行后的
//      最长行 + 4」会在每次绘制后把宽度再收一圈（290 → 64.66 → 50.66 → 36.66 → 32），
//      把 AI 同传列表项的 title 断成三行压住 ctime。
//   ② 装不上的字族用**平台默认脸**的行盒（adl 对 MiSans Regular / 宋体 量到 16px → 行盒 16 = 
//      Helvetica），不是「哪个 CJK 脸供字形就用哪个的行盒」（PingFang/Songti SC 1.4em → 22）。
// 行为型判据（断言式）在 examples/autosize-metrics.as；这里只钉生成 C / glue 的结构，
// 因为 CI 上既没有 微软雅黑 也没有 MiSans，像素级真值不可能有。
function checkAutoSizeMetrics(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [autosize] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [autosize] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  const example = readFileSync(join(root, 'examples', 'autosize-metrics.as'), 'utf8');
  const registry = readFileSync(join(root, 'test', 'examples.ts'), 'utf8');

  // ① autoSize：宽度只在 wordWrap=false 时才跟 textWidth 走
  check('the width hug is guarded on wordWrap (height stays unconditional)',
    emitted.includes('if (!tf->wordWrap) tf->_fieldWidth = tw + 4.0;') &&
    emitted.includes('tf->_fieldHeight = th + 4.0;') &&
    !/^\ttf->_fieldWidth = tw \+ 4\.0;$/m.test(emitted));

  // ①b 几何读取也要刷新 autoSize（adl 赋值后不画就能读到新高度）
  check('geometry access refreshes autoSize (as_do_extents -> as_tf_apply_autosize)',
    emitted.includes('if (as_is((void*)o, &TextField_vt)) as_tf_apply_autosize((TextField*)o);'));

  // ② 装不上的字族 → 平台默认脸（名字替换 + 度量兜底两处都在）
  const aliasBody = glue.slice(glue.indexOf('static const char* sk_family_alias(const char* family) {'));
  check('an uninstalled family is substituted with the platform default family',
    aliasBody.includes('!mgr->matchFamilyStyle(family, SkFontStyle())') &&
    aliasBody.includes('dflt->getFamilyName(&n)') &&
    aliasBody.includes('alias_cache'));
  check('the typeface lookup falls back to the default face when the family misses',
    glue.includes('if (!tf && mgr) tf = mgr->matchFamilyStyle(nullptr, style);'));

  // ③ 行为型回归必须真的存在并被回归套件跑到（链 Skia，否则度量恒 0）
  check('examples/autosize-metrics.as asserts the no-cascade + fallback rules',
    example.includes('反复绘制后宽度/行数不得自噬') &&
    example.includes('wordWrap=false 时宽度收成 textWidth + 4') &&
    example.includes('装不上的字族必须用平台默认脸的行盒'));
  check('the example is registered with its Skia manifest',
    registry.includes("'autosize-metrics.as': ['--manifest', join(dir, 'autosize-metrics.build.json')]"));

  if (ok > 0) console.log(`[autosize] ${ok} autoSize/family-fallback checks passed`);
  return bad;
}

// unit: display/TfScaleMetrics — TextField 缩放下的度量/字形口径（阶段一百六十九，adl 口径：
// textWidth/textHeight = 名义 × scaleY/scaleX（含祖先链），字形按 scaleY 整体缩放、scaleX 不拉宽）。
// 结构钉子盯生成 C 的两处来源：度量 getter 的 ÷ 比值、绘制前对 CTM 的归一化；行为钉子靠
// examples/tf-scale-metrics.as 的相对断言 + temp/tfswc 双端探针（case ⑯⑯b⑯c⑰b）钉绝对数。
function checkTfScaleMetrics(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [tfscale] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [tfscale] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  const example = readFileSync(join(root, 'examples', 'tf-scale-metrics.as'), 'utf8');
  const registry = readFileSync(join(root, 'test', 'examples.ts'), 'utf8');

  // ① 累积 scale 助手真的沿 parent 链走，而且线性部分按 T·R·S·M 的顺序累乘
  check('the accumulated scale walks the parent chain',
    emitted.includes('for (DisplayObject* p = o; p != NULL; p = (DisplayObject*)p->parent) {'));
  check('the accumulated scale composes R(rotation)*S(scaleX,scaleY)*transform.matrix',
    emitted.includes('double la = cs * p->scaleX, lb = sn * p->scaleX, lc = -sn * p->scaleY, ld = cs * p->scaleY;') &&
    emitted.includes('Matrix* m = (p->transform != NULL) ? p->transform->matrix : NULL;'));

  // ② 度量 = 名义 × (scaleY/scaleX)，两个方向同一个除数
  check('the ratio is scaleY/scaleX',
    emitted.includes('return (sx > 0.0) ? sy / sx : 1.0;'));
  check('textWidth is scaled by the ratio',
    emitted.includes('return as_skia_textlayout_max_width(para) * as_tf_scale_ratio(tf);'));
  check('textHeight is scaled by the ratio (Skia path)',
    emitted.includes('return h * as_tf_scale_ratio(tf);'));
  check('textHeight is scaled by the ratio (pure-C path)',
    emitted.includes('return (double)as_tf_line_count(tf) * (size * 1.2 + lead) * as_tf_scale_ratio(tf);'));

  // ③ 绘制前把 CTM 归一成 scaleY 的均匀缩放，且用「最终落点 CTM」而不是当前 canvas 盲读
  check('the glyph paint normalises the CTM to a uniform scaleY',
    emitted.includes('if (tsx > 0.0 && fabs(tsy / tsx - 1.0) > 1e-9) as_skia_canvas_scale(canvas, tsy / tsx, 1.0);'));
  check('the normalisation measures the destination CTM (bake-aware)',
    emitted.includes('double tsx = ASC_bake_ctm_x, tsy = ASC_bake_ctm_y;'));

  // ④ 行为型回归必须存在并被套件跑到（链 Skia，否则度量恒 0、draw 是空桩）
  check('examples/tf-scale-metrics.as asserts both the metric and the glyph rules',
    example.includes('scaleX=2 时 textWidth 减半') &&
    example.includes('scaleX=2 时 textHeight 也减半（同除 scaleX）') &&
    example.includes('父容器 scaleX=2 时子字段 textWidth 减半') &&
    example.includes('scaleX=2 不得把字形横向拉宽') &&
    example.includes('scaleY=2 时字形整体放大一倍'));
  check('the example is registered with its Skia manifest',
    registry.includes("'tf-scale-metrics.as': ['--manifest', join(dir, 'tf-scale-metrics.build.json')]"));

  if (ok > 0) console.log(`[tfscale] ${ok} TextField scale-metric checks passed`);
  return bad;
}

// unit: swc/TextChildOrigin — 被缩放的文本子件的 x/y（阶段一百六十九；adl 口径：
// 文本子件的 RECT 原点在**角色自己的空间**里，故要走 placement 的线性部分，且 AIR 把结果
// 存回 twip 栅格（1/20 px）。真值 = temp/tfswc case ⑰ 的四个判别例（subtitleskin.ctime
// 12.0000 / filesskin.tab1 0.0500 / filesskin.tab2 90.1000 / logintabskin.tab1 0.0000，
// 与 `tx + ox` 分别差 11.7 / 0.45 / 0.45 / 0.10 px）。本组只钉生成侧来源与两处调用点，
// 绝对数由 temp/tfswc 双端探针钉（CI 无 .swc，见 test/unit 的约定：不断言 temp/ 内容）。
function checkSwcTextChildOrigin(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [swcxy] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [swcxy] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const swcSource = readFileSync(join(root, 'src', 'swc.ts'), 'utf8');

  // ① 原点走线性部分，并把结果落到 AIR 的 twip 栅格上
  const helper = emitSource.slice(emitSource.indexOf('private swcTextChildXY('));
  const helperDoc = emitSource.slice(emitSource.indexOf('a TEXT child reports for a placement'));
  check('the RECT origin is mapped through the placement linear part',
    helper.includes('x: round20(m[4] + m[0] * ox + m[2] * oy),') &&
    helper.includes('y: round20(m[5] + m[1] * ox + m[3] * oy),'));
  check('the result is snapped to the twip grid (1/20 px)',
    helper.includes('const round20 = (v: number): number => Math.round(v * 20) / 20;'));

  // ② 两处（帧 1 placement / 时间轴 modify）都必须走这个 helper，不能再各算一份
  check('the frame-1 placement uses the helper',
    emitSource.includes('const { x, y } = this.swcTextChildXY(m, ox, oy);\n      this.line(`  ${child}->x = '));
  check('the timeline modify path uses the helper',
    emitSource.includes('const { x, y } = this.swcTextChildXY(m, ox, oy);\n      this.line(`${name}->x = '));
  check('no call site still adds the raw origin',
    !/->x = \$\{this\.formatDouble\(m\[4\] \+ ox\)\}/.test(emitSource));

  // ③ 四条判别证据留在注释里（数量级决定 1/20 取整这一条）
  check('the four discriminating measurements are cited',
    helperDoc.includes('subtitleskin.ctime') && helperDoc.includes('filesskin.tab1') &&
    helperDoc.includes('filesskin.tab2') && helperDoc.includes('logintabskin.tab1') &&
    helperDoc.includes('adl 12.0000') && helperDoc.includes('adl  0.0500') && helperDoc.includes('adl  0.0000'));

  // ④ swc.ts 的接口注释同步（老注释写的是 `x = matrix.tx + xmin`）
  check('swc.ts documents the linear-part + twip-grid rule',
    swcSource.includes('x = round20(tx + a*xmin + c*ymin)'));

  if (ok > 0) console.log(`[swcxy] ${ok} SWC text-child origin checks passed`);
  return bad;
}

// unit: display/McButtonState — MovieClip 的三种按钮态（阶段一百七十一）。
// adl 51.4.1 实测口径在 temp/btnprobe（Probe.as + p4~p7 截图 + Aot.as 双端）；本组只钉生成侧
// 来源与关键判断点（CI 无 .swc，按 test/unit 约定不断言 temp/ 内容）。四条最容易再丢的东西：
//   ① 门是 buttonMode（不是“有标签就算按钮”）；
//   ② 帧由标签决定，且缺失时按 _down → _over → _up 退链；
//   ③ 按压锁在“按下的那个对象”上（生成号递增，鼠标松开靠 ASC_mouse_down 清）；
//   ④ 状态在**指纹 pass**与绘制 pass 两处都要结算 —— 祖先被自动烘培时只有指纹 pass 会走到子件。
function checkMcButtonState(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [mcbtn] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [mcbtn] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const symbolsSource = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const registry = readFileSync(join(root, 'test', 'examples.ts'), 'utf8');
  const example = readFileSync(join(root, 'examples', 'swc-mc-button.as'), 'utf8');
  const fn = emitSource.slice(emitSource.indexOf("this.line('static void as_mc_button_state(DisplayObject* o) {')"));

  // ① 三道门：有烘培时间轴、buttonMode、真的有鼠标（离屏保持 _up）
  check('the state machine is gated on a baked timeline, buttonMode and a live pointer',
    fn.includes("if (mc->_tl_char == 0) return;") &&
    fn.includes("if (!((InteractiveObject*)o)->buttonMode) return;") &&
    fn.includes("if (!ASC_mouse_has) return;"));

  // ② 帧由标签决定 + 缺失时退链（不作帧号映射）
  check('the frame comes from the label, with a _down -> _over -> _up fallback chain',
    fn.includes("const char* want = pressed ? \"_down\" : (over ? \"_over\" : \"_up\");") &&
    fn.includes("as_swc_tl_labelframe(mc->_tl_char, want)") &&
    fn.includes("if (f <= 0 && pressed) f = as_swc_tl_labelframe(mc->_tl_char, \"_over\");") &&
    fn.includes("if (f <= 0 && (pressed || over)) f = as_swc_tl_labelframe(mc->_tl_char, \"_up\");"));
  check('an unchanged state never re-enters as_mc_goto (frame scripts must not replay)',
    fn.includes('if (f > 0 && f != mc->currentFrame) as_mc_goto(mc, f);'));
  check('the roll-over target is the pick result, walked up the ancestor chain',
    emitSource.includes("this.line('for (DisplayObject* p = (DisplayObject*)ASC_mouse_target; p != NULL; p = (DisplayObject*)p->parent) if (p == o) return 1;');"));

  // ③ 按压锁：按下的代际 + 只增不减 + 链上盖章
  check('the press is latched by a generation on the pressed chain',
    emitSource.includes("for (DisplayObject* p = (DisplayObject*)target; p != NULL; p = (DisplayObject*)p->parent) { if (as_is((void*)p, &InteractiveObject_vt)) ((InteractiveObject*)p)->_btn_press_gen = ASC_press_gen; }") &&
    fn.includes('int pressed = ASC_mouse_down && ASC_press_gen != 0 && ((InteractiveObject*)o)->_btn_press_gen == ASC_press_gen;'));
  check('the generation only grows (a stale stamp can never match a later press)',
    emitSource.includes("if (ASC_press_gen <= 0) ASC_press_gen = 1;") &&
    !emitSource.includes("ASC_press_gen = 0;  // mouseUp"));
  check('the private latch field is declared on InteractiveObject (not a GC-rooted pointer)',
    symbolsSource.includes("['_btn_press_gen', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'InteractiveObject'"));

  // ④ 两处结算点：绘制 pass + 指纹 pass（祖先被自动烘培时只有后者会走到子件）
  check('the state settles in the paint pass',
    emitSource.includes("if (as_is((void*)o, &MovieClip_vt)) as_mc_button_state(o);"));
  check('the state settles in the fingerprint pass (baked-ancestor path)',
    emitSource.includes("if (as_is(o, &MovieClip_vt)) as_mc_button_state(o);"));
  check('the fingerprint carries the timeline frame (so a stale bake drops)',
    emitSource.includes('if (as_is(o, &MovieClip_vt)) h = as_fp_i32(h, ((MovieClip*)o)->currentFrame);'));

  // ⑤ 每帧刷新拾取目标（鼠标停着不动时也要跟着显示列表变）+ 两个入口都要刷新
  check('the pointer target is refreshed once per pass, in both paint entries',
    (emitSource.match(/as_mouse_refresh_target\(\(DisplayObject\*\)/g) ?? []).length === 2 &&
    emitSource.includes("ASC_mouse_target = (ASC_mouse_has && root != NULL) ? as_pick_hit((void*)root, ASC_mouse_x, ASC_mouse_y) : NULL;"));

  // ⑥ 四条实测结论留在注释里（门是 buttonMode / 帧看标签 / 按压锁 / 祖先烘培）
  const doc = emitSource.slice(emitSource.indexOf('MovieClip button states: buttonMode + the FrameLabel triple'));
  check('the measurements are cited in the runtime comment',
    doc.slice(0, 4000).includes('gate = buttonMode, NOT the labels') &&
    doc.slice(0, 4000).includes('the LABEL decides the frame, not an index') &&
    doc.slice(0, 4000).includes('press is LATCHED') &&
    doc.slice(0, 4000).includes('29 symbols in the TalkMED skin carry the triple'));

  // ⑦ 示例与登记
  check('the example is registered with the Skia manifest and the skin requirement',
    registry.includes("'swc-mc-button.as': ['--manifest', join(dir, 'swc-bitmap.build.json')]") &&
    registry.includes("'swc-mc-button.as': join(root, '..', 'temp', 'skin.swc')"));
  check('the example asserts the exact label frames measured on adl',
    example.includes('_up@1,_over@4,_down@7') && example.includes('_up@1,_over@5,_down@10') &&
    example.includes('home card roll-over -> 5:_over'));
  check('the example exercises the auto-bake (many frames per state) and pixel differences',
    example.includes('for (var i:int = 0; i < n; i++) stage.render(400, 700, "temp/swc-mc-button.png");') &&
    example.includes('function inkDiff(a:BitmapData, b:BitmapData):int'));

  if (ok > 0) console.log(`[mcbtn] ${ok} MovieClip button-state checks passed`);
  return bad;
}

registerGroup('unit: display/HitShape', checkHitShape);
registerGroup('unit: swc/TextChildOrigin', checkSwcTextChildOrigin);
registerGroup('unit: display/McButtonState', checkMcButtonState);
registerGroup('unit: display/DisplayGeometry', checkDisplayGeometry);
registerGroup('unit: display/TransformMatrix', checkTransformMatrix);
registerGroup('unit: display/Scale9Grid', checkScale9Grid);
registerGroup('unit: display/LineMetrics', checkLineMetrics);
registerGroup('unit: display/AutoSizeMetrics', checkAutoSizeMetrics);
registerGroup('unit: display/TfScaleMetrics', checkTfScaleMetrics);
registerGroup('unit: display/ListEvents', checkListEvents);
