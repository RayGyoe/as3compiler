// Unit checks for 阶段二百七十五 (compiler-gaps G24 / G25 / G26).
//
// All three gaps are "the API exists but the SEMANTICS differ from AIR", so the
// reference is always an adl 51.4.1 measurement recorded in temp/g242526:
//   G24 child-index errors  -> air-sem.txt   (probe AirSem.as)
//   G25 roll-over contract  -> mouse2-air.txt (probe AirMouse2.as, REAL cursor walk)
//   G26 drawPath / cubic    -> air-sem.txt, air-sem2.txt, bounds-air.txt, pix6/7 ink
//
// These are source-level pins on the emitter plus one behavioural example each:
// the examples layer runs the behaviour (examples/child-index-errors.as,
// examples/roll-over.as, examples/graphics-path.as), this layer makes sure the
// decisions cannot be silently reverted.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

// ---- G24: DisplayObjectContainer.setChildIndex validation order ----
//
// Measured on adl 51.4.1: null child -> TypeError #2007, an out-of-range index (or
// ANY index on an empty container) -> RangeError #2006, a non-child at an IN-RANGE
// index -> ArgumentError #2025. A non-child at an OUT-OF-RANGE index reports #2006,
// which is what proves the index check runs before the child check.
function checkChildIndexErrors(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [childindex] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [childindex] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const start = emitSource.indexOf("this.line('void DisplayObjectContainer_setChildIndex(void* _this, DisplayObject* child, int index) {')");
  check('setChildIndex is emitted', start >= 0);
  const block = start < 0 ? '' : emitSource.slice(start, start + 2200);
  const iNull = block.indexOf('Error #2007: Parameter child must be non-null.');
  const iRange = block.indexOf('Error #2006: The supplied index is out of bounds.');
  const iChild = block.indexOf('Error #2025: The supplied DisplayObject must be a child of the caller.');
  const iSearch = block.indexOf('int cur = -1;');

  check('a null child throws TypeError #2007 first', iNull >= 0 && block.includes('TypeError_new('));
  check('an out-of-range index throws RangeError #2006', iRange >= 0 && block.includes('RangeError_new('));
  check('a non-child throws ArgumentError #2025', iChild >= 0 && block.includes('ArgumentError_new('));
  check('the checks run in AIR order: null, then index, then is-my-child',
    iNull >= 0 && iNull < iRange && iRange < iChild && iSearch > iRange && iSearch < iChild);
  check('the index is range-checked against the CURRENT length, not clamped',
    block.includes('int n = (c->children == NULL) ? 0 : c->children->length;') &&
    block.includes('if (index < 0 || index >= n)') &&
    !block.includes('if (index < 0) index = 0;') &&
    !block.includes('if (index >= c->children->length) index = c->children->length - 1;'));
  check('a rejected call cannot have moved anything (no write before the checks)',
    !block.slice(0, iChild).includes('children->data[i] =') &&
    !block.slice(0, iChild).includes('children->data[index] ='));

  if (ok > 0) console.log(`[childindex] ${ok} setChildIndex checks passed`);
  return bad;
}

// ---- G25: the roll-over / roll-out dispatch contract ----
//
// Measured order on adl 51.4.1 (real cursor, temp/g242526/mouse2-air.txt):
//   mouseOut(old, bubbles) -> rollOut(old chain, innermost first, no bubbles)
//   -> rollOver(new chain, innermost first, no bubbles) -> mouseOver(new, bubbles)
// with the Stage excluded from the roll pair, no event at all when the target does
// not change, and a removed hovered subtree delivering its leave one beat later on
// the detached node.
function checkRollOverContract(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [rollover] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [rollover] ${label}`); }
  };

  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const moveStart = emitSource.indexOf("this.line('static void as_hover_move(Stage* st, void* next, double x, double y, void* anchor) {')");
  check('as_hover_move is emitted', moveStart >= 0);
  const move = moveStart < 0 ? '' : emitSource.slice(moveStart, emitSource.indexOf("this.line('static void as_hover_flush(void) {')", moveStart));

  const iOut = move.indexOf('(char*)"mouseOut", true');
  const iRollOut = move.indexOf('(char*)"rollOut", false');
  const iRollIn = move.indexOf('(char*)"rollOver", false');
  const iOver = move.indexOf('(char*)"mouseOver", true');
  check('the four events fire in the measured order',
    iOut >= 0 && iRollOut > iOut && iRollIn > iRollOut && iOver > iRollIn);
  check('the mouse pair bubbles and the roll pair does not',
    move.includes('(char*)"mouseOut", true') && move.includes('(char*)"mouseOver", true') &&
    move.includes('(char*)"rollOut", false') && move.includes('(char*)"rollOver", false'));
  check('an unchanged target dispatches nothing at all', move.includes('if (prev == next) return;'));
  check('only objects that no longer hold the pointer get a rollOut',
    move.includes('if (!as_hover_holds((void*)p, next)) as_hover_fire((void*)p, (char*)"rollOut"'));
  check('only objects the pointer was not already in get a rollOver',
    move.includes('if (!as_hover_holds((void*)p, prev) && (anchor == NULL || !as_hover_holds((void*)p, anchor))) as_hover_fire((void*)p, (char*)"rollOver"'));
  check('the roll chain stops below the Stage (the Stage only sees the bubbling pair)',
    emitSource.includes('static DisplayObject* as_hover_next(DisplayObject* p) {') &&
    emitSource.includes('if (par->vtable != NULL && strcmp(par->vtable->cls_name, "Stage") == 0) return NULL;'));
  check('every pointer notification re-evaluates the target before its own event',
    emitSource.includes("this.line('as_hover_move(mst, target, x, y, NULL);')"));
  check('the window leave reports -1,-1 like AIR and then hands over to mouseLeave',
    emitSource.includes("this.line('as_hover_move(mst, NULL, -1.0, -1.0, NULL);')"));

  // catastrophic bug guard: the hover state must never be global
  check('removeChild hands the hovered run to the deferred leave',
    emitSource.includes("this.line('as_hover_on_remove((void*)_this, child);')"));
  check('a queued leave is delivered at the frame boundary',
    emitSource.includes("this.line('as_hover_flush();')") &&
    emitSource.indexOf("this.line('as_hover_flush();')") < emitSource.indexOf("this.line('as_timer_tick();')", emitSource.indexOf('void Stage_dispatchFrame(void* _this) {')));

  // GC: the deferred target outlives the event, and it is exactly the object the app
  // may have dropped its last reference to.
  const gcStart = emitSource.indexOf("this.line('static void gc_mark_user_roots(void) {')");
  const gc = gcStart < 0 ? '' : emitSource.slice(gcStart, gcStart + 12000);
  check('the roll target and the queued leave are permanent GC roots',
    gc.includes('gc_mark_ptr(as_hover_target);') && gc.includes('gc_mark_ptr(as_hover_pending);'));

  if (ok > 0) console.log(`[rollover] ${ok} roll-over checks passed`);
  return bad;
}

// ---- G26: drawPath / cubicCurveTo / winding / tight curve bounds ----
function checkGraphicsPath(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [gpath] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [gpath] ${label}`); }
  };

  const symbolsSource = readFileSync(join(root, 'src', 'symbols.ts'), 'utf8');
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const runtimeSource = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');

  // the API surface, exactly as AIR declares it
  check('GraphicsPathCommand.NO_OP is 0',
    symbolsSource.includes("['NO_OP', { type: { kind: 'int' }, init: { kind: 'Num', value: 0, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }]"));
  check('GraphicsPathWinding is a constants-only final class',
    symbolsSource.includes("this.classMap.set('GraphicsPathWinding', {") &&
    symbolsSource.includes("init: { kind: 'Str', value: 'evenOdd' }") &&
    symbolsSource.includes("init: { kind: 'Str', value: 'nonZero' }") &&
    symbolsSource.includes('constructor: { params: [] },'));
  check('cubicCurveTo takes six Numbers (so .length is 6)',
    symbolsSource.includes("['cubicCurveTo', gpm({ kind: 'void' }, [") &&
    symbolsSource.includes('greq(\'controlX1\', \'Number\')') &&
    symbolsSource.includes('greq(\'anchorY\', \'Number\')'));
  check('drawPath takes (Vector.<int>, Vector.<Number>, winding=evenOdd)',
    symbolsSource.includes("['drawPath', gpm({ kind: 'void' }, [") &&
    symbolsSource.includes("{ name: 'commands', type: 'Vector.<int>', defaultValue: null, isRest: false }") &&
    symbolsSource.includes("{ name: 'data', type: 'Vector.<Number>', defaultValue: null, isRest: false }") &&
    symbolsSource.includes("{ name: 'winding', type: 'String', defaultValue: { kind: 'Str', value: 'evenOdd' }, isRest: false }"));

  // the interpreter: validation before drawing, and the measured way of giving up
  const dpStart = emitSource.indexOf("this.line('void Graphics_drawPath(void* _this, as_vector_int* commands, as_vector_number* data, char* winding) {')");
  check('Graphics_drawPath is emitted', dpStart >= 0);
  const dp = dpStart < 0 ? '' : emitSource.slice(dpStart, emitSource.indexOf("this.line('void Graphics_clear(void* _this) {')", dpStart));
  check('a bad winding is ArgumentError #2008 before anything is drawn',
    dp.indexOf('Error #2008: Parameter winding must be one of the accepted values.') >= 0 &&
    dp.indexOf('#2008') < dp.indexOf('#2004'));
  check('an odd data length is ArgumentError #2004, also before drawing',
    dp.includes('if ((nd & 1) != 0) { as_throw(ArgumentError_new((char*)"Error #2004: One of the parameters is invalid.", 2004)); return; }'));
  check('NO_OP consumes nothing and draws nothing', dp.includes('if (cmd == 0) continue;'));
  check('an unknown or WIDE_* command keeps the built geometry and drops the rest',
    dp.includes('} else break;  // unknown OR wide command: keep what is built, drop the rest'));
  check('a command whose numbers ran out also stops without an error',
    dp.includes('if (di + 4 > nd) break;') && dp.includes('if (di + 6 > nd) break;'));

  // the bridge: a cubic has to reach Skia as a cubic (converting it to quads would
  // change the shape and the ink counts measured against AIR)
  check('cubicCurveTo goes through the cubic bridge, not a quad approximation',
    emitSource.includes('as_skia_path_cubic_to(g->path, c1x, c1y, c2x, c2y, ax, ay)') &&
    glue.includes('sk_path_cubic_to') &&
    runtimeSource.includes('as_skia_path_cubic_to'));

  // tight curve bounds (measured: 80x37.5 / 80x25 -- the control hull would say 80x50)
  check('the CPU-side box takes the curve extrema, not the control points',
    emitSource.includes('static void as_gpath_quad(Graphics* g, double p0x, double p0y, double cx, double cy, double ax, double ay) {') &&
    emitSource.includes('static void as_gpath_cubic(Graphics* g, double p0x, double p0y, double c1x, double c1y, double c2x, double c2y, double ax, double ay) {') &&
    emitSource.includes('as_gpath_quad(g, g->_lastx, g->_lasty, cx, cy, ax, ay)') &&
    emitSource.includes('as_gpath_cubic(g, g->_lastx, g->_lasty, c1x, c1y, c2x, c2y, ax, ay)') &&
    !emitSource.includes('as_gpath_pt(g, c1x, c1y); as_gpath_pt(g, c2x, c2y);'));

  if (ok > 0) console.log(`[gpath] ${ok} drawPath checks passed`);
  return bad;
}

registerGroup('unit: display/SetChildIndex', checkChildIndexErrors);
registerGroup('unit: display/RollOverContract', checkRollOverContract);
registerGroup('unit: render/GraphicsPath', checkGraphicsPath);

// ---- Graphics paints must anti-alias (阶段二百七十五) ----
//
// SkPaint defaults to AA OFF, and as_skia_paint_fill / as_skia_paint_stroke never set
// it, so every diagonal edge was a staircase and every slanted thin stroke came out
// thin next to AIR. Measured on temp/g242526 Pix8: an AIR triangle edge carries 44
// partial-coverage pixels, ours carried 0. The two constructors are the only ones that
// were missing it (bitmap fill / gradient / SWC bake all set it).
function checkGfxAntialias(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [antialias] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [antialias] ${label}`); }
  };
  const runtimeSource = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const fillBody = runtimeSource.slice(runtimeSource.indexOf('static inline void* as_skia_paint_fill('), runtimeSource.indexOf('static inline void* as_skia_paint_delete('));
  check('the solid fill paint anti-aliases', fillBody.includes('sk_paint_set_antialias(p, 1);'));
  check('the stroke paint anti-aliases',
    fillBody.slice(fillBody.indexOf('as_skia_paint_stroke')).includes('sk_paint_set_antialias(p, 1);'));
  check('the glue really exposes setAntiAlias', readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8').includes('setAntiAlias(on != 0)'));
  if (ok > 0) console.log(`[antialias] ${ok} paint checks passed`);
  return bad;
}

registerGroup('unit: render/GfxAntialias', checkGfxAntialias);