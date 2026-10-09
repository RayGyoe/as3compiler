// Unit checks: Screen / NativeWindow, backend seam parity, null receivers, timers.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='platform/' test/unit/*.ts

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

// ---- flash.display.Screen (阶段八十九·七十一) ----
// Screen's contract is not "return some display info" — it is a set of measured
// adl 51.4.1 behaviours that a naive implementation gets wrong in four different
// ways: (1) the wrapper is NOT a singleton (mainScreen === mainScreen is false,
// so the getter must allocate), (2) bounds and visibleBounds are two DIFFERENT
// quantities on one display, (3) getScreensForRectangle matches against bounds
// (not visibleBounds) with half-open overlap, so a zero-area or merely
// edge-touching rectangle matches nothing, and (4) the class is not
// constructible (Error #2012). Each assertion below pins one of those, on the
// generated C rather than on emitter source text — the allocating getter and a
// cached-one look nearly identical in the emitter.
function checkScreen(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [screen] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [screen] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.display.Screen;\n' +
    'import flash.geom.Rectangle;\n' +
    'var s:Screen = Screen.mainScreen;\n' +
    'var a:Array = Screen.screens;\n' +
    'var h:Array = Screen.getScreensForRectangle(new Rectangle(0, 0, 1, 1));\n' +
    'var b:Rectangle = s.bounds;\n' +
    'var v:Rectangle = s.visibleBounds;\n' +
    'var d:int = s.colorDepth;\n'
  )).c;
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');

  // (1) Fresh wrapper per access. The getter must BUILD one; a global cached
  // instance would make mainScreen === mainScreen true, which adl says is false.
  const mainGetter = (() => {
    const i = c.indexOf('Screen* Screen_get_mainScreen_static(void* _this) {');
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i));
  })();
  check('Screen.mainScreen allocates a fresh wrapper (not a cached singleton)',
    mainGetter.includes('return Screen_mk(0);'));
  check('Screen.screens builds a fresh Array and fills it from the display count',
    /as_array\* Screen_get_screens_static\(void\* _this\) \{[\s\S]*?as_array\* a = as_array_new\(\);[\s\S]*?as_screen_count\(\);[\s\S]*?as_array_push\(a, as_v_obj\(\(void\*\)Screen_mk\(i\)\)\);/.test(c));

  // (2) Two different quantities: the getters must hit different queries.
  check('bounds and visibleBounds are backed by separate display queries',
    c.includes('as_screen_bounds(index, &x, &y, &w, &h);')
    && c.includes('as_screen_usable_bounds(index, &ux, &uy, &uw, &uh);'));
  check('each Screen caches exactly one live Rectangle per rectangle',
    c.includes('Rectangle* Screen_get_bounds(void* _this) { return (Rectangle*)((Screen*)_this)->_bounds; }')
    && c.includes('Rectangle* Screen_get_visibleBounds(void* _this) { return (Rectangle*)((Screen*)_this)->_visible_bounds; }'));
  // The cached Rectangles are GC objects in C-runtime-only slots, so the props
  // table must expose them or a collection can free a live bounds rectangle.
  check('both cached Rectangles are reachable from the GC props table',
    c.includes('{ "_bounds", 6, offsetof(Screen, _bounds) },')
    && c.includes('{ "_visible_bounds", 6, offsetof(Screen, _visible_bounds) },'));

  // (3) Intersection rule: against bounds, half-open.
  const hitFn = (() => {
    const i = c.indexOf('static int Screen_bounds_hit(');
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', c.indexOf('return y1 > y0;', i)));
  })();
  check('the screen match uses bounds, not the usable area',
    hitFn.includes('as_screen_bounds(index, &bx, &by, &bw, &bh);')
    && !hitFn.includes('as_screen_usable_bounds'));
  check('the overlap is half-open (a touching or zero-area rect matches nothing)',
    hitFn.includes('if (x1 <= x0) return 0;') && hitFn.includes('return y1 > y0;'));
  check('getScreensForRectangle filters the displays through that predicate',
    /Screen_getScreensForRectangle_static\(Rectangle\* rect\)[\s\S]*?Screen_bounds_hit\(i, rect->x, rect->y, rect->width, rect->height\)/.test(c));

  // (4) Not constructible. AIR: Error #2012 with this exact wording.
  check('new Screen() throws AIR\'s Error #2012',
    c.includes('as_throw(Error_new((char*)"Error #2012: Screen$ class cannot be instantiated.", 2012));'));
  check('colorDepth is the desktop 32bpp value',
    c.includes('int Screen_get_colorDepth(void* _this) { (void)_this; return as_screen_color_depth(); }')
    && preamble.includes('static inline int as_screen_color_depth(void) { return 32; }'));

  // The runtime half: a display list that cannot be read must still report one
  // display (AIR always has a mainScreen), and every backend must provide the
  // three queries so a non-window build links.
  check('the display count is never 0',
    /static inline int as_screen_count\(void\) \{[\s\S]*?int n = sk_display_count\(\);[\s\S]*?return n > 0 \? n : 1;/.test(preamble));
  check('the headless build defines the same three queries (link parity)',
    (preamble.match(/static inline int as_screen_(count|bounds|usable_bounds)\(/g) ?? []).length === 6);

  // The example that drove this item must keep driving it: windowTest.as is the
  // only reason NativeWindow/Screen were registered at all. If Screen stops being
  // referenced there, the pins above would still pass on an unused class.
  const winTest = readFileSync(join(root, 'examples', 'air-native', 'src', 'demo', 'windowTest.as'), 'utf8');
  check('the reproducing example still reads Screen.mainScreen',
    /Screen\.mainScreen/.test(winTest) && /\.bounds/.test(winTest));

  if (ok > 0) console.log(`[screen] ${ok} Screen checks passed`);
  return bad;
}

// ---- flash.display.NativeWindow family (阶段八十九·七十一) ----
// A second OS window is not a "feature flag" — every one of its behaviours was
// measured on adl 51.4.1 and several of them are counter-intuitive enough to be
// re-broken by a plausible-looking refactor:
//   * NativeWindow is NOT construct-then-configure; the ctor opens the window
//     immediately (visible=false, active=false on return), so the default frame
//     400x232 and the hidden state are contract, not accident;
//   * NO AS3 state is mirrored per window: every getter queries the generated
//     ASC_wins[] table by the `_win` id. A mirrored field looks tidier and goes
//     stale the moment the OS changes the window — that is exactly how
//     alwaysInFront read false right after being set, and how a mirrored `used`
//     flag silenced Event.CLOSE;
//   * close() is DEFERRED, so `closed` is still false in the frame that called it;
//   * Resize.NONE really is the empty string.
// The pins below are on generated/glue C rather than on emitter text, because the
// point is the runtime contract. The single most expensive bug of this stage is
// pinned first: a window created WITHOUT its callbacks is a black, unresponsive
// rectangle that still reports correct bounds/title/visible/active — every probe
// except "is it painted?" passes.
function checkNativeWindow(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [native-window] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [native-window] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.display.NativeWindow;\n' +
    'import flash.display.NativeWindowInitOptions;\n' +
    'import flash.display.NativeWindowSystemChrome;\n' +
    'import flash.display.NativeWindowType;\n' +
    'import flash.display.NativeWindowRenderMode;\n' +
    'import flash.display.NativeWindowDisplayState;\n' +
    'import flash.display.NativeWindowResize;\n' +
    'import flash.geom.Rectangle;\n' +
    'var o:NativeWindowInitOptions = new NativeWindowInitOptions();\n' +
    'o.systemChrome = NativeWindowSystemChrome.NONE;\n' +
    'o.maximizable = false;\n' +
    'var a:String = NativeWindowSystemChrome.STANDARD;\n' +
    'var b:String = NativeWindowType.NORMAL;\n' +
    'var d:String = NativeWindowRenderMode.AUTO;\n' +
    'var e:String = NativeWindowDisplayState.MINIMIZED;\n' +
    'var f:String = NativeWindowResize.NONE;\n' +
    'var w:NativeWindow = new NativeWindow(o);\n' +
    'w.stage.scaleMode = "noScale";\n' +
    'var r:Rectangle = new Rectangle(600, 379, 600, 410);\n' +
    'w.bounds = r;\n' +
    'w.activate();\n' +
    'var g:Boolean = w.closed;\n' +
    'var h:Boolean = w.visible;\n' +
    'var i2:String = w.title;\n' +
    'w.close();\n'
  )).c;
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');
  const webGlue = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8');

  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i) + 2);
  };
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  // Same slice, but out of the glue source (body() reads the generated C).
  const glueBody = (sig: string): string => {
    const i = glue.indexOf(sig);
    return i < 0 ? '' : glue.slice(i, glue.indexOf('\n}', i) + 2);
  };

  // (1) The whole handler set is installed at creation. A window whose on_redraw
  // is missing is never rasterized and never presented: it stays black while every
  // other getter agrees with adl.
  const nwCtor = body('static void NativeWindow_ctor(NativeWindow* o, NativeWindowInitOptions* options) {');
  for (const h of ['ASC_window_on_mouse', 'ASC_window_on_wheel', 'ASC_window_on_redraw',
                   'ASC_window_on_frame', 'ASC_window_on_frame_delay', 'ASC_window_on_resize',
                   'ASC_window_on_close']) {
    check(`the new window is handed ${h} at creation`,
      nwCtor.includes(h + ',') || nwCtor.includes(h + ');'));
  }
  check('the ctor creates the window through the as_window_* seam, never the glue directly',
    nwCtor.includes('as_window_create(') && !nwCtor.includes('sk_window_create('));
  // Reverse half: the glue must actually install what it is handed. Without this,
  // the generated C above would look right and the window would still be dead.
  const glueCreate = (() => {
    const i = glue.indexOf('int sk_window_create(');
    return i < 0 ? '' : glue.slice(i, glue.indexOf('\n}', i));
  })();
  check('the glue installs all seven callbacks on every window it creates',
    ['on_mouse', 'on_wheel', 'on_redraw', 'on_frame', 'on_frame_delay', 'on_resize', 'on_close']
      .every(n => glueCreate.includes(`c->${n} = ${n};`)));
  // The capacity must agree across the seam, or windows beyond the smaller bound
  // silently fail to exist.
  const glueMax = /#define SK_MAX_WINDOWS (\d+)/.exec(glue);
  const cMax = /#define ASC_MAX_WINDOWS (\d+)/.exec(c);
  check('the two window-capacity constants agree (16)',
    glueMax !== null && cMax !== null && glueMax[1] === cMax[1] && cMax[1] === '16');

  // (2) No mirrored AS3 state: the `_win` id indexes the ASC_wins[] table and
  // every getter reads it back. `_win` starts at -1 so a half-constructed object
  // cannot alias window 0.
  check('the window object carries only the glue id, and starts it at -1',
    /\n\s*int _win;/.test(c) && nwCtor.includes('o->_win = -1;'));
  check('x/y/width/height are queries into the window table, not stored fields',
    body('static double NativeWindow_get_x(void* _this) {').includes('NativeWindow_coord(((NativeWindow*)_this)->_win, 0)')
    && body('static double NativeWindow_get_height(void* _this) {').includes('NativeWindow_coord(((NativeWindow*)_this)->_win, 3)'));
  check('the bounds setter writes through the glue, then re-sizes the Stage',
    body('static void NativeWindow_write_bounds(int id, double x, double y, double w, double h) {')
      .includes('as_window_set_bounds(id, (int)x, (int)y, (int)w, (int)h)')
    && body('static void NativeWindow_write_bounds(int id, double x, double y, double w, double h) {')
      .includes('ASC_window_apply_stage_size(id)'));
  check('closed reads the window table, so the OS closing a window is observable',
    body('static bool NativeWindow_get_closed(void* _this) {').includes('w->closed != 0'));

  // (3) Measured defaults: frame 400x232, and standard chrome puts the title bar
  // inside that frame, so the client starts at 400x200, while a chrome-less window
  // is its own client at the full 232. NativeWindowInitOptions has its own defaults.
  check('a new window defaults to a 400x200 client (400x232 frame) with standard chrome',
    nwCtor.includes('double cw = 400.0, ch = 200.0;') && nwCtor.includes('ch = 232.0;'));
  const optCtor = body('static void NativeWindowInitOptions_ctor(NativeWindowInitOptions* o) {');
  check('NativeWindowInitOptions defaults match adl (standard/normal/auto/false/true/true/true/null)',
    optCtor.includes('o->systemChrome = (char*)"standard";')
    && optCtor.includes('o->type = (char*)"normal";')
    && optCtor.includes('o->renderMode = (char*)"auto";')
    && optCtor.includes('o->transparent = false;')
    && optCtor.includes('o->maximizable = true;')
    && optCtor.includes('o->minimizable = true;')
    && optCtor.includes('o->resizable = true;')
    && optCtor.includes('o->owner = NULL;'));
  // A secondary Stage is not configured like the initial one: adl reports
  // scaleMode showAll and align "" until the app changes them. Its frameRate is
  // NOT set here — the frame rate is application-wide (see block (8)), so a new
  // window already reports and follows the one app rate.
  check('the new window\'s Stage starts at showAll / align "" and inherits the app rate',
    nwCtor.includes('w->stage->scale_mode = (char*)"showAll";')
    && nwCtor.includes('w->stage->align = (char*)""')
    && !nwCtor.includes('frame_rate'));

  // (4) close() is deferred by one frame: the flag is set when the glue retires the
  // window, so `closed` is still false in the frame that called close().
  check('close() only asks the glue to close (the id is not marked closed locally)',
    body('static void NativeWindow_close(void* _this) {').includes('as_window_close(')
    && !body('static void NativeWindow_close(void* _this) {').includes('closed = 1'));
  check('Event.CLOSE is dispatched when the window is actually retired',
    body('static void ASC_window_on_close(int id) {').includes('w->closed = 1;')
    && body('static void ASC_window_on_close(int id) {').includes('Event_new((char*)"close", false, false)'));
  check('the retire path drops the dangling Stage/object pointers (no use-after-free)',
    body('static void ASC_window_on_close(int id) {').includes('w->stage = NULL;')
    && body('static void ASC_window_on_close(int id) {').includes('w->window = NULL;'));

  // (5) Loud failure instead of a window object that does nothing, with AIR's exact
  // wording. The browser/headless stub returns -1, so the same path is taken there.
  check('a window that cannot be created throws AIR\'s Error #2012',
    nwCtor.includes('Error #2012: NativeWindow cannot be instantiated on this target.'));
  check('the browser backend reports "no second OS window" instead of faking one',
    /int sk_window_create\([\s\S]{0,900}?return -1;/.test(webGlue)
    && preamble.includes('static inline int as_window_create('));
  check('toString matches adl',
    body('static char* NativeWindow_toString(void* _this) {').includes('[object NativeWindow]'));

  // (6) The token classes keep the measured string values -- in particular
  // Resize.NONE, which is the empty string (the same T/BR codes StageAlign uses).
  check('the NativeWindow token classes keep their measured values',
    c.includes('NativeWindowSystemChrome_ctor') && c.includes('NativeWindowResize_ctor')
    && c.includes('(char*)"standard"') && c.includes('(char*)"none"')
    && c.includes('(char*)"minimized"') && c.includes('(char*)"auto"'));

  // (7) NativeWindow extends EventDispatcher (AIR). This one is a LAYOUT contract,
  // not cosmetic inheritance: EventDispatcher_dispatchEvent() reads `listeners` at
  // offset 8 and `parent` at offset 16, and ASCWin.window is a void* — so the call
  // site `EventDispatcher_dispatchEvent(w->window, ...)` cannot be type-checked by
  // the C compiler. Registering NativeWindow with Object as its superclass emitted
  // `struct NativeWindow { vtable; int _win; }`, and dispatchEvent then read `_win`
  // (an int) as a listener table and `parent` past the end of the 16-byte
  // allocation. Closing a window SIGSEGV'd with KERN_INVALID_ADDRESS at 0x20, with
  // the stack EventDispatcher_dispatchEvent <- ASC_window_on_close <-
  // sk_service_destroy <- sk_run_loop <- sk_window_show_metal.
  const nwStruct = (() => {
    const i = c.indexOf('struct NativeWindow {');
    return i < 0 ? '' : c.slice(i, c.indexOf('};', i));
  })();
  check('NativeWindow is laid out as an EventDispatcher (listeners + parent, then _win)',
    /NativeWindow_vtable\* vtable;[\s\S]*?as_object\* listeners;[\s\S]*?Object\* parent;[\s\S]*?int _win;/.test(nwStruct));
  check('...and its vtable keeps EventDispatcher as the super',
    /static NativeWindow_vtable NativeWindow_vt = \{ "NativeWindow", &EventDispatcher_vt,/.test(c));
  check('...and the ctor builds the base part before touching _win',
    /EventDispatcher_ctor\(\(EventDispatcher\*\)o, NULL\);[\s\S]{0,40}o->_win = -1;/.test(nwCtor));
  check('Event.CLOSE reaches the window through the base-typed dispatcher',
    body('static void ASC_window_on_close(int id) {')
      .includes('EventDispatcher_dispatchEvent(w->window, Event_new((char*)"close", false, false))'));
  // The same invariant for the whole program, not just NativeWindow: any class
  // whose vtable advertises the EventDispatcher listener API must carry the base
  // fields first. Pinned over the generated C because the defect was invisible to
  // the C compiler at every dispatch site that takes a void* target.
  const structs = new Map<string, string>();
  for (const m of c.matchAll(/struct (\w+) \{\n([\s\S]*?)\n\};/g)) structs.set(m[1], m[2]);
  const brokenLayout: string[] = [];
  let advertised = 0;
  for (const m of c.matchAll(/static (\w+)_vtable \w+_vt = \{ "([^"]*)", &\w+_vt,([\s\S]*?)\};/g)) {
    if (!m[3].includes('EventDispatcher_dispatchEvent')) continue;
    advertised++;
    const s = structs.get(m[1]) ?? '';
    if (!s.includes('as_object* listeners;') || !s.includes('Object* parent;')) brokenLayout.push(m[2]);
  }
  check(`every event-dispatching class carries the EventDispatcher fields (${advertised} classes)`,
    advertised >= 20 && brokenLayout.length === 0);
  if (brokenLayout.length > 0) console.log(`      broken layout: ${brokenLayout.join(', ')}`);

  // The example that drove this item: windowTest.as subclasses NativeWindow and the
  // demo constructs it from a real click. If either half stopped existing, the pins
  // above would still pass on a class nothing instantiates.
  const winTest = readFileSync(join(root, 'examples', 'air-native', 'src', 'demo', 'windowTest.as'), 'utf8');
  const ntWindow = readFileSync(join(root, 'examples', 'air-native', 'src', 'demo', 'NtWindow.as'), 'utf8');
  check('the reproducing example still subclasses NativeWindow and activates it',
    /super\(windowOptions\)/.test(winTest) && /this\.activate\(\)/.test(winTest)
    && /bounds = rect/.test(winTest));
  check('...and the demo still opens it from a click handler',
    /new windowTest\(\)/.test(ntWindow) && /addEventListener\(MouseEvent\.CLICK/.test(ntWindow));

  // (8) ONE frame clock for the whole application. AIR's Stage.frameRate is
  // application-wide ("setting the frameRate property of one Stage object changes
  // the frame rate for all Stage objects" — AS3 reference; measured with adl:
  // set 12 on a secondary window's stage and the main window's stage reads 12, and
  // both windows tick at 12). So the rate cannot be a struct Stage field, and the
  // event loop must dispatch ONE application frame — not one frame per window.
  // Per-window ticks broadcast ENTER_FRAME once per window, so every listener
  // counted the SUM of the windows' rates: with the initial window following the
  // display rate and a second window at 24, an FPS meter read 120+24 = 168 instead
  // of 120. The same multiplication advanced playing MovieClips and ran the GC
  // slice / async retire once per window per frame.
  check('frameRate is one application-wide value, not a per-Stage field',
    c.includes('static double ASC_app_frame_rate;')
    && c.includes('static double ASC_app_frame_rate = 0.0;')
    && !c.includes('offsetof(Stage, frame_rate)')
    && !c.includes('->frame_rate'));
  check('every Stage\'s frameRate getter/setter proxies that one value',
    c.includes('double Stage_get_frameRate(void* _this) { (void)_this; return ASC_app_frame_rate; }')
    && c.includes('void Stage_set_frameRate(void* _this, double value) { (void)_this; ASC_app_frame_rate = value; }'));
  check('the frame cadence is read from the application rate, not a stage field',
    body('static double ASC_window_on_frame_delay(int id) {').includes('double fr = ASC_app_frame_rate;'));
  check('the event loop runs ONE application frame (one deadline, one on_frame call)',
    !glue.includes('double next[SK_MAX_WINDOWS]')
    && glue.includes('static double g_app_next = 0.0;')
    && count(glueBody('static void sk_run_loop(void) {'), 'on_frame(') === 1
    && count(glueBody('static void sk_run_loop(void) {'), 'on_frame_delay(') === 1);
  check('...and that one frame tick marks every visible window dirty',
    glueBody('static void sk_run_loop(void) {').includes('if (c->used && !c->destroy_pending && c->visible) c->dirty = 1;'));

  // (9) EVERY window may composite on the GPU. AIR's NativeWindowRenderMode default
  // is AUTO, and under a GPU-window build (<renderMode>direct</renderMode> =>
  // ASC_RENDER_WINGPU) AUTO means the GPU. It could not be honoured, because the
  // Metal backend was a PROCESS-WIDE singleton (one CAMetalLayer, one
  // GrDirectContext, one drawable, one surface) and sk_window_create() never
  // attached a layer at all — renderMode was stored in ASCWin.render_mode and read
  // by nobody. Every runtime NativeWindow therefore took the CPU path: a full-frame
  // Skia rasterization plus an SDL_UpdateTexture upload of 600x410 @2x = 3.9 MB per
  // window per frame (~470 MB/s at 116 fps). Measured cost: +12-14% CPU per window,
  // 44% with three open. The state is now per window, keyed by the same id the rest
  // of the seam hands out.
  const metalGlue = readFileSync(join(root, 'vendor', 'metal_glue.mm'), 'utf8');
  check('the Metal backend keeps one slot per window, not one global layer/drawable',
    /static MtlWin g_mtl\[/.test(metalGlue)
    && !/static CAMetalLayer\* g_layer/.test(metalGlue)
    && !/static id<CAMetalDrawable> g_drawable/.test(metalGlue));
  check('...and its capacity matches both window tables',
    (() => {
      const m = /#define SK_MTL_MAX_WINDOWS (\d+)/.exec(metalGlue);
      return m !== null && m[1] === cMax?.[1] && m[1] === '16';
    })());
  check('every Metal entry point is keyed by the window id',
    ['sk_mtl_init(int win_id, void* layer)', 'sk_mtl_destroy(int win_id)',
     'sk_mtl_begin_frame(int win_id, int width, int height)', 'sk_mtl_flush(int win_id)']
      .every(sig => metalGlue.includes(sig)));
  // The window parameter cannot be named `id`: in Objective-C++ that shadows the id
  // TYPE, so `id<CAMetalDrawable>` inside the function parses as a comparison and
  // the file stops compiling.
  check('the Metal entry points avoid the ObjC++ id keyword as a parameter name',
    !/sk_mtl_(?:init|destroy|begin_frame|flush)\(int id\b/.test(metalGlue));

  // Glue half: the layer is attached per window, on request, and released before
  // the SDL window that owns it.
  check('the glue attaches a GPU surface to a window when the caller asks for one',
    glue.includes('static int sk_attach_metal(WinCtx* c, int id)')
    && glue.includes('static int sk_attach_d3d(WinCtx* c, int id)')
    && glue.includes('static int sk_attach_gpu(WinCtx* c, int id)')
    && glueCreate.includes('if (gpu) attached = sk_attach_gpu(c, id);')
    && glueCreate.includes('if (!attached && !sk_attach_cpu(c))'));
  check('a build without a GPU window backend cannot mint a GPU window',
    /#ifndef ASC_RENDER_WINGPU\s*\n\s*gpu = 0;/.test(glue));
  check('the GPU state and its view go before the SDL window they belong to',
    /if \(c->is_gpu\) \{[\s\S]{0,300}?sk_mtl_destroy\(i\);\s*\n[\s\S]{0,200}?SDL_Metal_DestroyView\(\(SDL_MetalView\)c->metal_view\);\s*\n[\s\S]{0,300}?SDL_DestroyWindow\(c->win\)/.test(glue));

  // Generated-C half: the backend is chosen from renderMode, which is the ONLY
  // place in a Metal build where a window can still ask for software.
  check('a new window asks for the GPU unless renderMode says cpu',
    nwCtor.includes('char* want_mode = (options != NULL && options->renderMode != NULL) ? options->renderMode : (char*)"auto";')
    && nwCtor.includes('gpu = (strcmp(want_mode, "cpu") != 0) ? 1 : 0;'));
  check('...and that request exists only in a build that has the backend',
    /#ifdef ASC_RENDER_WINGPU\s*\n\s*gpu = \(strcmp\(want_mode, "cpu"\) != 0\) \? 1 : 0;\s*\n\s*#endif/.test(nwCtor));
  check('the request reaches the glue, and the answer is what the render path reads',
    /as_window_create\([\s\S]{0,300}?\bgpu,/.test(nwCtor) && nwCtor.includes('w->is_gpu = gpu;'));
  check('a GPU window owns no CPU surface (its frame canvas is acquired per frame)',
    nwCtor.includes('if (!w->is_gpu) {')
    && nwCtor.indexOf('if (!w->is_gpu) {') < nwCtor.indexOf('void* surface = as_skia_surface_new(pw, ph);'));
  check('the GPU frame calls carry the window id (a shared layer would corrupt)',
    body('static void ASC_window_render(int id) {').includes('as_skia_gpu_begin_frame(id, w->pw, w->ph)')
    && body('static void ASC_window_render(int id) {').includes('if (w->is_gpu) as_skia_gpu_flush(id);'));
  check('Stage3D composites only into a GPU window (AIR: software windows do not)',
    body('static void ASC_window_render(int id) {')
      .includes('if (w->is_gpu && ASC_stage3d_ready && ASC_stage3d_tex != NULL) {'));
  // A resize must not hand a GPU window a CPU surface it never draws into: the
  // next frame walks the is_gpu branch and would leak the replacement surface.
  const onResize = body('static void* ASC_window_on_resize(int id, int lw, int lh, int pw, int ph, double scale) {');
  check('resizing a GPU window only re-sizes the drawable, never allocates a surface',
    onResize.indexOf('if (w->is_gpu) {') >= 0
    && onResize.indexOf('if (w->is_gpu) {') < onResize.indexOf('as_skia_surface_new('));

  // Seam half: the backend request must cross both signatures, and the headless /
  // browser stub must accept it rather than fall out of sync with the caller.
  // Both as_window_create definitions must move together: the Skia one reaches the
  // glue, the pure-C stub (Emits for --target without Skia) does not, and only the
  // compile of a stub build catches the drift — which is a 14th argument to a 13
  // parameter function, i.e. "too many arguments to function call" in generated C.
  const seamDefs = count(preamble, 'as_window_create(int w, int h, const char* title, int resizable, int decorated, int highdpi,');
  check(`every as_window_create definition takes the backend request (${seamDefs})`,
    seamDefs === 2
    && count(preamble, 'int gpu,') === seamDefs + 1  // + the sk_window_create extern
    && count(preamble, '(void)gpu;') === seamDefs
    && preamble.includes('return sk_window_create(w, h, title, resizable, decorated, highdpi, gpu,'));
  check('the GPU frame helpers take the window id too',
    preamble.includes('static inline void* as_skia_gpu_begin_frame(int id, int w, int h)')
    && preamble.includes('static inline void as_skia_gpu_flush(int id)')
    && preamble.includes('extern void* sk_gpu_begin_frame(int id, int w, int h);'));
  check('the no-window stub keeps the same arity',
    webGlue.includes('int gpu,') && webGlue.includes('(void)gpu;'));
  // Reverse half: the acceptance example must keep exercising the DEFAULT
  // (AUTO -> GPU) path. If it pinned renderMode to cpu, the Metal branch would stop
  // being driven by any example and these pins would pass on code nothing runs.
  check('the acceptance example still takes the default renderMode',
    !/windowOptions\.renderMode/.test(winTest.replace(/\/\/[^\n]*/g, '')));

  if (ok > 0) console.log(`[native-window] ${ok} NativeWindow checks passed`);
  return bad;
}

// ---- backend parity: the sk_window_* seam + the socket fd seam ----
//
// 阶段九十四·二十七：两个“只改了一边”的静默断裂，原生/原生与 wasm 家族都踩过，
// 且都不会让任何测试变红：
//
//   1. 生成的 C 在 ASC_USE_WINDOW 下无条件声明并调用整族 sk_window_*；但它由
//      **两个**胶水文件分别实现（native 的 window_glue.cc 与 web 的 web_glue.cc）。
//      文字输入 seam 只加进了 native，web 就缺三个符号 —— 一直到 wasm-ld 报
//      `undefined symbol: sk_window_text_take` 才暴露（`--target wasm --package web`）。
//   2. socket 状态机的 as_sock_drop_fd/as_sock_free 在**每个**目标都跑，却直接调
//      POSIX 的 close(fd)；WASI/Windows 不含 <unistd.h>，C99+ 下未声明的 close 是硬错误
//      —— `--target wasm` 对整个 examples/ 报 `call to undeclared function 'close'`。
//
// 所以这里钉住两条不变量：(a) 两个胶水后端提供的 sk_window_* 集合只在
// 有文档的 native 专属符号上有差；(b) socket 的 fd 关闭只有一个平台无关入口。
function checkBackendParity(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [backendparity] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [backendparity] ${label}`); }
  };

  // 定义形态：行首是返回类型，然后 sk_window_<name>(（native 与 web 两个文件都是这一风格）。
  const defRe = /^(?:static\s+)?(?:int|void|double|float|long|unsigned|char|size_t|short|bool)\s*\**\s*(sk_window_\w+)\s*\(/gm;
  const seamDefs = (rel: string): Set<string> =>
    new Set([...readFileSync(join(root, rel), 'utf8').matchAll(defRe)].map((m) => m[1]));
  const nativeDefs = seamDefs(join('vendor', 'window_glue.cc'));
  const webDefs = seamDefs(join('vendor', 'web_glue.cc'));
  const nativeOnly = [...nativeDefs].filter((n) => !webDefs.has(n));

  // 唯一允许的 native 专属 seam 符号：GPU 窗口后端。它只在 ASC_RENDER_WINGPU 下
  // 被声明/调用（具体是 Metal 还是 D3D12 由胶水内部选），而 web 从不定义该宏，
  // 故不需要（也不该有）web 实现。
  const NATIVE_ONLY = ['sk_window_show_metal', 'sk_window_show_gpu'];
  const unlisted = nativeOnly.filter((n) => !NATIVE_ONLY.includes(n));
  check('every native-only sk_window_* seam symbol is a documented GPU-only one',
    unlisted.length === 0);
  check('the GPU-only exemption is real: runtime.ts declares it under ASC_RENDER_WINGPU',
    /#ifdef ASC_RENDER_WINGPU[\s\S]{0,400}?extern int sk_window_show_gpu\s*\(/.test(
      readFileSync(join(root, 'src', 'runtime.ts'), 'utf8')));
  // 反向：web 不得凭空多出 native 没有的 seam 符号（那说明两边已经分叉）。
  const webOnly = [...webDefs].filter((n) => !nativeDefs.has(n));
  check('web defines no sk_window_* seam symbol that native lacks', webOnly.length === 0);
  // 文字输入 seam 必须在两个后端都落地（这正是断链的那三个）。
  check('the composed-text seam is implemented by BOTH backends',
    ['sk_window_text_take', 'sk_window_text_edit_take', 'sk_window_set_text_input_rect']
      .every((n) => nativeDefs.has(n) && webDefs.has(n)));

  // ---- socket fd seam ----
  const preamble = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  check('as_sock_close_fd has a real POSIX body and an inert non-POSIX stub',
    preamble.includes('static inline void as_sock_close_fd(int fd) { if (fd >= 0) close(fd); }') &&
    preamble.includes('static inline void as_sock_close_fd(int fd) { (void)fd; }'));
  // 裸 close(s->fd) 一旦回来，WASI/Windows 就会重新编译失败。
  check('no unguarded close(s->fd) survives in the socket state machine',
    !/close\(s->fd\)/.test(preamble));
  // struct sockaddr_storage 由 sys/socket.h 提供；定义必须整体待在 POSIX 守卫内，
  // 否则其参数类型在 WASI 上是不完整类型（-Wvisibility）。
  check('as_sock_fill_addr lives entirely inside the ASC_SOCK_POSIX guard',
    /#ifdef ASC_SOCK_POSIX\nstatic void as_sock_fill_addr[\s\S]*?\n}\n#endif/.test(preamble));

  // ---- GPU-window seam: BOTH backend files must implement the neutral five ----
  // 生成的 C 在 ASC_RENDER_WINGPU 下无条件引用 sk_gpu_begin_frame / sk_gpu_flush
  // （ASC_window_render），而它们由**后端文件**实现：macOS 的 metal_glue.mm、
  // Windows 的 d3d_glue.cc（window_glue.cc 的 sk_attach_gpu 只负责二选一）。
  // 「运行期不会被调到」≠「链接期不需要」——那一对 static inline 包装器一旦被发射，
  // 符号就必须可解析。2026-10-09 实测：五个名字只在 D3D12 侧落地，于是
  // `node src/index.ts --air-app examples/air-native/air-native-app.xml --target native`
  // 报 `_sk_gpu_begin_frame` / `_sk_gpu_flush` 未定义（referenced from _ASC_window_render），
  // 而**整套测试全绿**——因为 examples 的 air-native 单元不带 --air-app
  // （ASC_RENDER_WINGPU 从未定义，GPU 分支从未被编译）。下面三条钉住它。
  const wingpuStart = preamble.indexOf('#ifdef ASC_RENDER_WINGPU');
  const wingpu = preamble.slice(wingpuStart, preamble.indexOf('#endif', wingpuStart));
  const gpuSeam = [...new Set([...wingpu.matchAll(/extern\s+\S+\s+\**(sk_gpu_\w+)\s*\(/g)].map((m) => m[1]))];
  // 定义形态：行首是返回类型，参数表之后紧跟 `{`（多行签名也认，因 [^;] 可跨行）。
  const gpuDefRe = /^[ \t]*(?:int|void|void\*)\s+(sk_gpu_\w+)\s*\([^;]*\)\s*\{/gm;
  const defsOf = (rel: string): Set<string> =>
    new Set([...readFileSync(join(root, rel), 'utf8').matchAll(gpuDefRe)].map((m) => m[1]));
  const metalDefs = defsOf(join('vendor', 'metal_glue.mm'));
  const d3dDefs = defsOf(join('vendor', 'd3d_glue.cc'));
  check(`the GPU-window seam is those five names and no more (${gpuSeam.join(', ')})`,
    gpuSeam.length === 5
    && gpuSeam.every((n) => /^sk_gpu_(init|destroy|begin_frame|flush|draw_texture)$/.test(n)));
  check('metal_glue.mm implements every sk_gpu_* the generated C can reference',
    gpuSeam.every((n) => metalDefs.has(n)));
  check('d3d_glue.cc implements every sk_gpu_* the generated C can reference',
    gpuSeam.every((n) => d3dDefs.has(n)));
  check('...and neither backend invents a sk_gpu_* outside that seam',
    [...metalDefs, ...d3dDefs].every((n) => gpuSeam.includes(n)));

  if (ok > 0) console.log(`[backendparity] ${ok} cross-backend seam checks passed`);
  return bad;
}

// Null-receiver member access (阶段九十四·十二). AIR throws TypeError #1009 for a
// property/method access on null (any static type) and #1006 for a null Function
// call. adl ground truth: temp/nullprobe/NullMain.as -> adl_null.txt.
function checkNullRef(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [nullref] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [nullref] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const c = generateC(parse('var s:Sprite = null;\nvar o:Object = null;\nvar a:Array = null;\n' +
    'var st:String = null;\nvar r1:* = s.x;\ns.x = 5;\ns.hitTestPoint(0, 0);\n' +
    'var r2:* = o.x;\nvar r3:* = a[0];\nvar r4:* = a.length;\na[0] = 1;\n' +
    'var r5:* = st.length;\nst.charAt(0);\n')).c;
  // (1) The two runtime guards exist with the measured ids/messages.
  check('as_req_obj raises TypeError #1009 on NULL',
    /static void\* as_req_obj\(void\* p\)\s*\{\s*if \(p == NULL\)/.test(c)
    && c.includes('Error #1009: Cannot access a property or method of a null object reference.'));
  check('as_req_fn raises the #1006 "value is not a function" for a null Function',
    /static as_fn as_req_fn\(as_fn f, const char\* name\)/.test(c)
    && /if \(f == NULL\) \{ as_throw_not_function\(name\); return NULL; \}/.test(c));
  // (2) Every receiver kind is guarded: class field, class method, Object, Array
  // index read/write, String length + method.
  check('a nullable class instance field read is guarded',
    /as_req_obj\(\(void\*\)\(g_s\)\)\)->x/.test(c));
  check('a nullable class instance field write is guarded',
    /as_req_obj\(\(void\*\)\(g_s\)\)\)->x\) = /.test(c));
  check('a method call on a nullable receiver is guarded',
    /as_req_obj\(\(void\*\)\(g_s\)\)\)->vtable->hitTestPoint/.test(c));
  check('a nullable Object read routes through the guard',
    c.includes('as_dyn_get((void*)(((Object*)as_req_obj((void*)(g_o)))), "x")'));
  check('a nullable Array index read is guarded',
    /as_array_get\(\(\(as_array\*\)as_req_obj\(\(void\*\)\(g_a\)\)\), 0\)/.test(c));
  check('a nullable Array index write is guarded',
    /as_array_set\(\(\(as_array\*\)as_req_obj\(\(void\*\)\(g_a\)\)\), 0, as_v_num\(\(double\)\(1\)\)\)/.test(c));
  check('a nullable String.length is guarded',
    /\(\(int\)strlen\(\(\(char\*\)as_req_obj\(\(void\*\)\(g_st\)\)\)\)\)/.test(c));
  check('a nullable String method call is guarded',
    /as_str_charAt\(\(\(char\*\)as_req_obj\(\(void\*\)\(g_st\)\)\), 0\)/.test(c));
  // (3) Boxed (`*`) receivers: the null check lives in as_req_box, reached from
  // as_any_call (#1009) and the as_any_get/set/length sites.
  const cb = generateC(parse('var x:* = null;\nvar r:* = x.foo;\nx.bar();\nvar n:int = x.length;\nx.baz = 3;\n')).c;
  check('as_req_box raises #1009/#1010',
    /static as_value as_req_box\(as_value v\)/.test(c)
    && /if \(v.tag == 5\) \{ as_throw\(TypeError_new/.test(c));
  check('as_any_call null-guards its receiver first',
    /static as_value as_any_call\(as_value v,[\s\S]{0,300}?v = as_req_box\(v\);/.test(c));
  check('the any-typed read/write/length sites wrap with as_req_box',
    /as_any_get\(as_req_box\(/.test(cb) && /as_any_set(_v)?\(as_req_box\(/.test(cb) && /as_any_length\(as_req_box\(/.test(cb));
  // (4) No false positive / no bloat: `this` and provably non-null receivers
  // (a literal) skip the guard.
  const c2 = generateC(parse('class C { public var name:String = "x";\n' +
    ' public function C() {}\n public function get n():String { return this.name; } }\n' +
    'var m:int = "abc".length;\n')).c;
  check('this is not guarded (provably non-null)',
    c2.includes('return (this->name);'));
  check('a string-literal receiver is not guarded',
    c2.includes('((int)strlen("abc"))'));
  return bad;
}

// ---- flash.utils.setInterval / clearInterval (stage 94c) ----
// adl 51.4.1 measured (temp/intervalprobe): setTimeout and setInterval share ONE
// table and ONE id counter (ids 1,2,3... across both), so clearInterval cancels a
// timeout id and clearTimeout cancels an interval id; an unknown/0 id is a silent
// no-op. A repeat timer is rescheduled from the END of its callback (a 50 ms
// callback under a 20 ms interval ticks every ~69 ms) and fires at most once per
// frame pass; clearInterval from inside the callback stops every later tick. A
// negative or NaN delay is RangeError #2066 and consumes no id; a null closure is
// accepted (consumes an id, never fires). Same-deadline ordering is registration
// order (measured: T then I).
function checkIntervals(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [interval] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [interval] ${label}`); }
  };
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const setter = preamble.slice(preamble.indexOf('static unsigned int as_set_timeout_args('));
  const setterBody = setter.slice(0, setter.indexOf('\n}\n'));
  const interval = preamble.slice(preamble.indexOf('static unsigned int as_set_interval_args('));
  const intervalBody = interval.slice(0, interval.indexOf('\n}\n'));
  const tick = preamble.slice(preamble.indexOf('static void as_timer_tick(void) {'));
  const tickBody = tick.slice(0, tick.indexOf('\n}\n'));

  check('setInterval reuses setTimeout\'s registration (one table, one id counter)',
    intervalBody.includes('as_set_timeout_args(fn, delay, argc, args)')
    && intervalBody.includes('as_timers[i].repeat = 1'));
  check('the timer slot carries a repeat flag and the period',
    preamble.includes('int repeat;       // setInterval: 1; setTimeout: 0')
    && preamble.includes('double delay;     // repeat timer\'s period, in ms'));
  check('a negative or NaN delay is rejected before an id is handed out',
    setterBody.includes('if (!(delay >= 0)) as_throw_delay_range(delay);   // also catches NaN')
    && setter.indexOf('as_throw_delay_range(delay)') < setter.indexOf('t->id = as_timer_next_id++'));
  check('the delay guard throws RangeError #2066',
    /static void as_throw_delay_range\(double delay\)/.test(generateC(parse('var d:int = 1;\n')).c)
    && generateC(parse('var d:int = 1;\n')).c.includes('RangeError_new(as_str_concat_n(2, parts), 2066)'));
  check('a null closure is registered (consumes an id) instead of early-returning 0',
    !setterBody.includes('if (fn == NULL || fn->fn == NULL) return 0;')
    && tickBody.includes('if (f == NULL || f->fn == NULL) { t->alive = 0; continue; }'));
  check('a repeat timer is rescheduled from the END of its callback (from-completion)',
    tickBody.indexOf('f->fn(f->env, args, argc);') < tickBody.indexOf('as_timers[j].deadline = as_now_ms() + delay;'));
  check('the reschedule is skipped when the callback cleared the timer itself',
    tickBody.includes('t->alive = rep ? 2 : 0;') && tickBody.includes('if (as_timers[j].alive == 2) {'));
  check('the reschedule re-finds the slot by id (a callback may realloc the table)',
    tickBody.includes('if (as_timers[j].id == id) {'));
  const cTo = generateC(parse('function ct(id:uint):void { clearTimeout(id); }\n')).c;
  const cIv = generateC(parse('function ci(id:uint):void { clearInterval(id); }\n')).c;
  check('both clear functions route to the same helper (ids are interchangeable)',
    cTo.includes('as_clear_timeout(id);') && cIv.includes('as_clear_timeout(id);'));
  check('the runtime helper says unknown ids are silent no-ops',
    preamble.includes('Unknown and 0 ids are silent'));

  const ex = readFileSync(join(root, 'examples', 'stage94c.as'), 'utf8');
  check('the example pins the shared id space (setInterval id == setTimeout id + 1)',
    ex.includes('check(ivId == toId + 1, "setTimeout and setInterval share one id counter'));
  check('the example pins both cross-cancels',
    ex.includes('"clearInterval cancels a setTimeout id"') && ex.includes('"clearTimeout cancels a setInterval id"'));
  check('the example pins the fixed-tick sequence and the self-clear stop',
    ex.includes('check(seq == "123", "tick 3 fires, then clears itself from inside the callback")')
    && ex.includes('check(seq == "123" && n == 3, "after clearInterval the interval stays stopped'));
  check('the example pins #2066 for negative and NaN delays',
    ex.includes('setInterval(function():void { }, -1); return 0; }) == 2066')
    && ex.includes('setInterval(function():void { }, NaN); return 0; }) == 2066'));
  check('the example pins the null-closure behaviour',
    ex.includes('var nullId:uint = setTimeout(null, 0);') && ex.includes('"a null closure still consumes an id'));
  check('the example pins the same-pump ordering (registration order)',
    ex.includes('check(mix == "TI", "a timeout and an interval due in the same pump both fire, in id order")'));

  if (ok > 0) console.log(`[interval] ${ok} interval checks passed`);
  return bad;
}

// ---- flash.media audio backend seam, and the demo that exercises it (阶段九十六) ----
// Two silent-failure modes were reproduced on 2026-10-06; each is pinned here
// rather than left to a run, because in both cases the symptom is *only* silence
// (no exception, no log, nothing for the example suite to assert on).
//
//   * Build time — the `as_audio_*` seam degrades to "no backend" unless
//     vendor/audio_glue.c is compiled in AND `ASC_HAVE_AUDIO` is defined. The
//     degraded path answers honestly (`loadPCMFromByteArray` → #2068,
//     `areSoundsInaccessible()` → true, `play()` → null) instead of faking
//     success (§1.5), so a build that silently loses the glue looks correct at
//     runtime — exactly what a missed manifest field would produce. `usesAudio`
//     is what wires it, hence the whole triple (source + define + frameworks).
//
//   * Run time — examples/air-starling-demo makes no sound at all unless
//     AssetManager registers SoundFactory: the mp3 then has no claimant and
//     falls through to the ByteArrayFactory fallback (priority -100, whose
//     canHandle() is true for every ByteArray), so it is stored as raw bytes.
//     getSound("wing_flap") is null and MovieClip.setFrameSound(2, null) is a
//     no-op. The demo is in test/examples.ts' SKIP_DIRS (a 25 MB build), so the
//     two lines that decide sound-vs-silence are pinned here instead.
function checkAudioWiring(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [audio] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [audio] ${label}`); }
  };
  const list = (m: Record<string, unknown>, key: string): string[] =>
    Array.isArray(m[key]) ? (m[key] as string[]) : [];

  const audioNative = airManifest('../../vendor', true, true, true, false, 'direct',
    true, true, [], [], [], [], false, true) as Record<string, unknown>;
  const plainNative = airManifest('../../vendor', true, true, true, false, 'direct',
    true, true, [], [], [], [], false, false) as Record<string, unknown>;

  check('an app using flash.media compiles vendor/audio_glue.c in',
    list(audioNative, 'sources').some((p) => p.endsWith('vendor/audio_glue.c')));
  check('an app using flash.media defines ASC_HAVE_AUDIO',
    list(audioNative, 'defines').includes('ASC_HAVE_AUDIO=1'));
  check('an app using flash.media links miniaudio\'s CoreAudio backend',
    list(audioNative, 'frameworks').includes('CoreAudio')
    && list(audioNative, 'frameworks').includes('AudioToolbox'));
  check('an app that does not use flash.media gets no audio backend (and no stray frameworks)',
    !list(plainNative, 'sources').some((p) => p.endsWith('vendor/audio_glue.c'))
    && !list(plainNative, 'defines').includes('ASC_HAVE_AUDIO=1')
    && !list(plainNative, 'frameworks').includes('CoreAudio'));

  // The web backend returns before the audio block on purpose: miniaudio's build
  // here is CoreAudio/AudioToolbox, which wasm-ld cannot link. So a web build of
  // an audio app stays honest-but-silent, and the CLI says so out loud.
  const audioWeb = airManifest('../../vendor', true, true, true, true, 'direct',
    true, true, [], [], [], [], false, true) as Record<string, unknown>;
  check('a web build of an audio app stays clean (no glue, no ASC_HAVE_AUDIO)',
    !list(audioWeb, 'sources').some((p) => p.endsWith('vendor/audio_glue.c'))
    && !list(audioWeb, 'defines').includes('ASC_HAVE_AUDIO=1'));

  const demo = join(root, 'examples', 'air-starling-demo');
  const am = readFileSync(join(demo, 'src', 'starling', 'assets', 'AssetManager.as'), 'utf8');
  const movie = readFileSync(join(demo, 'src', 'scenes', 'MovieScene.as'), 'utf8');
  const sfLines = am.split('\n').filter((l) => l.includes('registerFactory(new SoundFactory())'));
  check('AssetManager registers SoundFactory, uncommented (else the mp3 is stored as raw bytes)',
    sfLines.length > 0 && sfLines.every((l) => !l.trim().startsWith('//')));
  check('ByteArrayFactory is still the last-priority fallback (why the registration above decides it)',
    am.includes('registerFactory(new ByteArrayFactory(), -100)'));
  check('MovieScene wires the wing_flap frame sound through getSound + setFrameSound',
    /getSound\("wing_flap"\)/.test(movie) && /_movie\.setFrameSound\(2,\s*\w+\)/.test(movie));

  if (ok > 0) console.log(`[audio] ${ok} audio-wiring checks passed`);
  return bad;
}

registerGroup('unit: platform/AudioWiring', checkAudioWiring);
registerGroup('unit: platform/Screen', checkScreen);
registerGroup('unit: platform/NativeWindow', checkNativeWindow);
registerGroup('unit: platform/BackendParity', checkBackendParity);
registerGroup('unit: platform/NullRef', checkNullRef);
registerGroup('unit: platform/Intervals', checkIntervals);
