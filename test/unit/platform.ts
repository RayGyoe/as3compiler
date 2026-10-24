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
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures, platformFrameworks } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, parseAirApp, prepareAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS, readNorm } from '../harness.ts';

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
    c.includes('{ "_bounds", 6, offsetof(Screen, _bounds), NULL, NULL, 1 },')
    && c.includes('{ "_visible_bounds", 6, offsetof(Screen, _visible_bounds), NULL, NULL, 1 },'));

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
  // (2b) …and `_win` must stay at NativeWindow's offset even when the SUBCLASS has
  // fields of its own. The emitter used to append the built-in base slots AFTER the
  // subclass's fields, so `class wsub extends NativeWindow { var fa:int; var fb:String; }`
  // came out as {…, fa, fb, _win}: NativeWindow_ctor's `o->_win = id` wrote
  // into `fa`, the subclass's own field write overwrote it, and every later
  // `stage` read (NativeWindow_get_stage casts to NativeWindow*) went through a
  // pointer fragment — ASC_w(-2137378480) → NULL ⇒ #1009. Measured on the TalkMED
  // app: its FixLaunchView (extends NativeWindow, 4 own fields) threw #1009 in its
  // Event.CLOSE handler and the exit(1) path took the whole app down (阶段一百四十五).
  // A base class with NO fields of its own (the demo windowTest, and the unit
  // fixture above) cannot show the bug, which is why it survived until a real app
  // subclassed a built-in. Asserted as the general rule: a subclass's slot list
  // must START with its base's slot list, verbatim.
  const subC = generateC(parse(
    'import flash.display.NativeWindow;\n' +
    'import flash.display.NativeWindowInitOptions;\n' +
    'class wsub extends NativeWindow {\n' +
    '  private var fa:int = 1;\n' +
    '  private var fb:String = "x";\n' +
    '  public function wsub() { super(new NativeWindowInitOptions()); }\n' +
    '}\n' +
    'var w:NativeWindow = new wsub();\n' +
    'w.close();\n'
  )).c;
  const slots = (src: string, cls: string): string[] => {
    const m = new RegExp(`^struct ${cls} \\{\\n([\\s\\S]*?)^\\};`, 'm').exec(src);
    return m === null ? [] : m[1].trim().split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(1);
  };
  const baseSlots = slots(subC, 'NativeWindow');
  const subSlots = slots(subC, 'wsub');
  check('a NativeWindow subclass repeats the base slot list first, own fields after it',
    baseSlots.length > 0 && baseSlots.every((l, i) => subSlots[i] === l));
  // `_win` is the LAST base slot (right after the EventDispatcher trio) and must
  // still precede every own field of the subclass. Written against the slot-list
  // positions rather than a named field: minSize/maxSize used to be placeholder
  // FIELDS pinned here, until 阶段一百九十六 turned them into real accessors backed
  // by the glue's own size table, so no field name is stable enough to pin.
  check('`_win` is the last BASE slot, never after the subclass\'s own fields',
    baseSlots.indexOf('int _win;') === baseSlots.length - 1
    && subSlots.indexOf('int _win;') === baseSlots.length - 1
    && subSlots.indexOf('int fa;') > subSlots.indexOf('int _win;'));
  // The other built-in bases that own C-runtime-only slots are field-less, so the
  // same rule puts their slots BEFORE the subclass's first field.
  const scrC = generateC(parse(
    'import flash.display.Screen;\n' +
    'class ssub extends Screen { private var fa:int = 1; }\n'
  )).c;
  const scrSlots = slots(scrC, 'Screen');
  const ssubSlots = slots(scrC, 'ssub');
  check('a field-less base (Screen) still contributes its slots before the subclass\'s',
    scrSlots.length === 3 && scrSlots.every((l, i) => ssubSlots[i] === l)
    && ssubSlots.indexOf('int fa;') === 3);
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
    /int sk_window_create\([\s\S]{0,2400}?return -1;/.test(webGlue)
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
    // Default 24 -- AIR's Stage.frameRate before any assignment (measured on
    // adl 51.4.1, temp/frprobe). It used to default to 0, which this compiler read
    // as "follow the display refresh rate" (so an app that never set a rate ran at
    // the panel's 120Hz and `stage.frameRate` read back 0 -- what Fps.as printed in
    // its overlay). `[SWF(frameRate = N)]` is the document class's override and
    // reaches the emitted initializer (temp/tkmeet-mac/talkmed.c: = 60, the
    // talkmed-meeting descriptor; the [SWF] probe emits = 30).
    && (c.includes('static double ASC_app_frame_rate = 24;') || /static double ASC_app_frame_rate = [0-9.]+;/.test(c))
    && !c.includes('offsetof(Stage, frame_rate)')
    && !c.includes('->frame_rate'));
  check('the Stage.frameRate setter CLAMPS to AIR\'s 0.01..1000 range',
    // Measured read-backs on adl 51.4.1 (temp/frclamp): -5 and 0 become 0.01,
    // 2000 and 1e9 become 1000, while 0.005 / 0.01 / 12.5 / 1000 pass through (and
    // NaN stays NaN).
    c.includes('void Stage_set_frameRate(void* _this, double value) {')
    && body('void Stage_set_frameRate(void* _this, double value) {').includes('if (value <= 0.0) value = 0.01;')
    && body('void Stage_set_frameRate(void* _this, double value) {').includes('else if (value > 1000.0) value = 1000.0;')
    && body('void Stage_set_frameRate(void* _this, double value) {').includes('ASC_app_frame_rate = value;'));
  check('every Stage\'s frameRate getter/setter proxies that one value',
    c.includes('double Stage_get_frameRate(void* _this) { (void)_this; return ASC_app_frame_rate; }'));
  check('the frame cadence is read from the application rate, not a stage field',
    body('static double ASC_window_on_frame_delay(int id) {').includes('double fr = ASC_app_frame_rate;'));
  check('a NaN rate cannot poison the pacer deadline (it falls back to the refresh)',
    // NaN fails both <= and >, so the guard must be a negated > comparison.
    body('static double ASC_window_on_frame_delay(int id) {').includes('if (!(fr > 0.0)) {'));
  // NOTE: the loop itself no longer dispatches the frame — it runs the shared
  // sk_pump_frame, and so does the live-resize event watch, which is what makes a
  // frame during a window drag literally the same frame as a frame here (see
  // checkWindowFrame / docs/zh-cn/win32.md §2.8). The "ONE application frame"
  // invariant therefore lives in the pump: one deadline, one on_frame call.
  const pumpBody = glueBody('static double sk_pump_frame(void) {');
  check('the event loop runs ONE application frame (one deadline, one on_frame call)',
    !glue.includes('double next[SK_MAX_WINDOWS]')
    && glue.includes('static double g_app_next = 0.0;')
    && count(glueBody('static void sk_run_loop(void) {'), 'sk_pump_frame()') === 1
    && count(glueBody('static void sk_run_loop(void) {'), 'on_frame(') === 0
    && count(pumpBody, 'on_frame(') === 1
    && count(pumpBody, 'on_frame_delay(') === 1);
  check('...and that one frame tick marks every visible window dirty',
    pumpBody.includes('if (c->used && !c->destroy_pending && c->visible) c->dirty = 1;'));

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
  // The initial window's title must honour an assignment made BEFORE the OS window
  // exists: the document class runs first, so `stage.nativeWindow.title = X` lands in
  // w->title while the glue (which only touches an already-open window) ignores it.
  // D7: adl showed the app's title while we kept the app.xml descriptor's.
  check('Stage.showWindow re-claims a title the app set before the window existed',
    body('void Stage_showWindow(void* _this, double width, double height, char* title) {')
      .includes('if (w->title != NULL && w->title[0] != 0) title = w->title;'));
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
  // The same seam now also carries the pair of per-window style flags, so the audit
  // counts the arguments of every sk_open_window call site instead of trusting one
  // signature to have been updated everywhere (see unit: platform/InitialWindowStyle).
  const seamDefs = count(preamble, 'as_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,');
  check(`every as_window_create definition takes the backend request (${seamDefs})`,
    seamDefs === 2
    && count(preamble, 'int gpu,') === seamDefs + 1  // + the sk_window_create extern
    && count(preamble, '(void)gpu;') === seamDefs
    && preamble.includes('return sk_window_create(w, h, title, resizable, maximizable, minimizable, decorated, highdpi, gpu,'));
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
  // `static` 定义**不算 seam**：静态函数不参与链接，生成 C 根本引用不到它（如
  // sk_window_size_defaults/size_floor 这两个胶水内部助手，它们只被 window_glue.cc
  // 自己的 sk_window_limits_default 调用）。把这族算进来只会把「内部助手」误报成
  // 「web 缺符号」，反而埋住真正的缺口（阶段一百九十六实测：两个内部助手进集合后
  // 这条钉直接变红）。
  const defRe = /^(?:int|void|double|float|long|unsigned|char|size_t|short|bool)\s*\**\s*(sk_window_\w+)\s*\(/gm;
  const seamDefs = (rel: string): Set<string> =>
    new Set([...readNorm(join(root, rel)).matchAll(defRe)].map((m) => m[1]));
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
      readNorm(join(root, 'src', 'runtime.ts'))));
  // 反向：web 不得凭空多出 native 没有的 seam 符号（那说明两边已经分叉）。
  const webOnly = [...webDefs].filter((n) => !nativeDefs.has(n));
  check('web defines no sk_window_* seam symbol that native lacks', webOnly.length === 0);

  // 阶段二百五十五 的菜单 seam 与上面同一类断裂：生成的 C 在 ASC_USE_WINDOW 下
  // 无条件调用 sk_menu_install_app/sk_menu_install_dock/sk_menu_supported/
  // sk_dock_bounce/sk_window_set_auto_exit，而 web 目标也只链接 web_glue.cc。
  // 只实现 native 那一半 ⇒ `--target wasm --package web` 链接期报
  // undefined symbol（浏览器本就没有菜单栏，但**符号必须在**、行为必须是空桩）。
  const menuRe = /^(?:int|void)\s*\**\s*(sk_menu_\w+|sk_dock_bounce|sk_window_set_auto_exit)\s*\(/gm;
  const menuSeam = (rel: string): Set<string> =>
    new Set([...readNorm(join(root, rel)).matchAll(menuRe)].map((m) => m[1]));
  const nativeMenu = menuSeam(join('vendor', 'window_glue.cc'));
  const webMenu = menuSeam(join('vendor', 'web_glue.cc'));
  const missingOnWeb = [...nativeMenu].filter((n) => !webMenu.has(n));
  check('both backends define the whole flash.desktop menu seam',
    nativeMenu.size >= 5 && missingOnWeb.length === 0);
  // 文字输入 seam 必须在两个后端都落地（这正是断链的那三个）。
  check('the composed-text seam is implemented by BOTH backends',
    ['sk_window_text_take', 'sk_window_text_edit_take', 'sk_window_set_text_input_rect']
      .every((n) => nativeDefs.has(n) && webDefs.has(n)));

  // ---- socket fd seam ----
  const preamble = readNorm(join(root, 'src', 'runtime.ts'));
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
// Windows window backend: the high-DPI latch and the live-resize frame
// (阶段一百二十七). A window drag/resize runs inside the OS's own modal message
// loop, entered from within SDL_PumpEvents, so the shared loop is blocked for the
// whole drag and the ONLY frames that happen are the ones SDL's live-resize event
// watch drives. Two things must therefore hold, and both are invisible to
// architecture-dependent code review:
//
//   1. the watch must be armed on EVERY window, the main one included — it was
//      armed only for NativeWindows, so a main-window drag froze completely;
//   2. the watch must run the loop's own PACED frame for all windows, not a
//      private unpaced tick of the dragged window (which sped the app's
//      ENTER_FRAME up to the OS message rate and left every other window frozen).
//
// Ground truth, measured under a REAL Windows modal move loop (2.5 s caption
// drag; temp/dpiprobe/probe8.c enters the loop via WM_NCLBUTTONDOWN/HTCAPTION):
//   watch before the fix -> loopIters +1, appFrames +1235 (≈494 fps), the other
//                           window's renders +0 (frozen)
//   watch after  the fix -> loopIters +1, appFrames +156 (≈62 fps, paced), the
//                           other window's renders +156
// The same run shows what feeds the watch on Windows: 235 EXPOSED (SDL's
// USER_TIMER_MINIMUM live-resize timer, armed in WM_ENTERSIZEMOVE) + 75 MOVED
// (WM_WINDOWPOSCHANGED, sent on every step of the drag).
function checkWindowFrame(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [windowframe] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [windowframe] ${label}`); }
  };

  // 本仓库的 .cc 是 CRLF 检出，正则里只要跨行就必须先归一化换行。
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const code = stripComments(glue);
  // 取 name 的**定义体**（跳过同名声明/调用）：找 name( 后配平参数表，紧跟 `{` 的才是定义。
  const bodyOf = (name: string): string => {
    for (let i = glue.indexOf(`${name}(`); i >= 0; i = glue.indexOf(`${name}(`, i + 1)) {
      let j = i + name.length; // at '('
      let depth = 0;
      for (; j < glue.length; j++) {
        if (glue[j] === '(') depth++;
        else if (glue[j] === ')') { depth--; if (depth === 0) break; }
      }
      let k = j + 1;
      while (k < glue.length && /\s/.test(glue[k])) k++;
      if (glue[k] !== '{') continue;
      let d = 0;
      for (; k < glue.length; k++) {
        if (glue[k] === '{') d++;
        else if (glue[k] === '}') { d--; if (d === 0) return glue.slice(i, k + 1); }
      }
    }
    return '';
  };

  // ---- the high-DPI latch ----
  // A DPI-unaware process has its whole window bitmap stretched by the compositor
  // on a scaled monitor, so <requestedDisplayResolution>high changed nothing on
  // screen. SDL_HINT_WINDOWS_DPI_SCALING=1 is what makes SDL_WINDOW_ALLOW_HIGHDPI
  // mean anything on Windows (measured: 1000x680 logical -> 1500x1020 physical at
  // 150% scaling). It must be latched BEFORE the first SDL_Init(SDL_INIT_VIDEO),
  // which is why every video entry point goes through sk_video_init().
  check('the Windows DPI-scaling hint is latched inside #ifdef _WIN32 + #ifdef ASC_DISPLAY_HIGH',
    /#ifdef _WIN32\n#ifdef ASC_DISPLAY_HIGH\n[\s\S]{0,8000}?SDL_SetHint\(SDL_HINT_WINDOWS_DPI_SCALING, "1"\);\n#endif\n#endif/.test(glue));
  check('...and that is its only occurrence (a standard build stays DPI-unaware)',
    (glue.match(/SDL_HINT_WINDOWS_DPI_SCALING/g) ?? []).length === 1);
  check('all video start-up is routed through sk_video_init (so no init can skip the hint)',
    (code.match(/\bSDL_Init\(SDL_INIT_VIDEO\)/g) ?? []).length === 1 &&
    bodyOf('sk_video_init').includes('SDL_Init(SDL_INIT_VIDEO)') &&
    (code.match(/sk_video_init\(\)/g) ?? []).length >= 5);

  // ---- the watch must exist on every window ----
  // sk_window_create arms it for NativeWindows; the main window is opened by
  // sk_window_show (CPU) / sk_window_show_metal (macOS GPU) / sk_window_show_gpu
  // (Windows GPU) and each of those must arm it too. It was missing from the two
  // GPU ones, so a main-window drag froze its animation entirely.
  const entries = ['sk_window_show', 'sk_window_show_metal', 'sk_window_show_gpu', 'sk_window_create'];
  for (const name of entries) {
    check(`the live-resize watch is armed on the window ${name} opens`,
      bodyOf(name).includes('SDL_AddEventWatch(live_resize_watch'));
  }
  check('...and no path that opens a window is left without one',
    (glue.match(/SDL_AddEventWatch\(live_resize_watch/g) ?? []).length === entries.length);

  // ---- the watch must run the SHARED frame, not a private per-window tick ----
  const watch = bodyOf('live_resize_watch');
  check('the watch runs the shared frame pump', watch.includes('sk_pump_frame();'));
  check('...and ticks no frame nor presents any window of its own',
    !/\bon_frame\b/.test(watch) && !/\bon_redraw\b/.test(watch) && !/\bpresent_frame\b/.test(watch));
  check('the watch accepts every event that arrives DURING a drag (MOVED/RESIZED/EXPOSED)',
    ['SDL_WINDOWEVENT_SIZE_CHANGED', 'SDL_WINDOWEVENT_RESIZED', 'SDL_WINDOWEVENT_EXPOSED',
     'SDL_WINDOWEVENT_MOVED'].every((n) => watch.includes(n)));

  // ---- one paced application frame for the whole application ----
  const pump = bodyOf('sk_pump_frame');
  check('the application frame is dispatched from exactly one place',
    (code.match(/on_frame\(/g) ?? []).length === 1 && pump.includes('on_frame(clock)'));
  check('the loop and the watch run that same pump',
    bodyOf('sk_run_loop').includes('sk_pump_frame()') && watch.includes('sk_pump_frame()'));
  check('the pump paces against the shared deadline (a drag cannot out-run frameRate)',
    pump.includes('if (t >= g_app_next)'));
  check('a new frame dirties every visible window (hidden/dying ones excluded)',
    pump.includes('if (c->used && !c->destroy_pending && c->visible) c->dirty = 1;'));
  check('the pump is re-entrancy guarded (its callbacks run real AS3)',
    pump.includes('if (in_pump) return g_app_next;'));

  if (ok > 0) console.log(`[windowframe] ${ok} window-frame checks passed`);
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

  // Host-dependent by construction, in exactly one place: miniaudio picks its
  // backend from the TARGET (CoreAudio on Apple, WASAPI/DirectSound/WinMM on
  // Windows), so the glue source + define pair belongs on every host that has a
  // backend built, while the framework flags exist only where a `-framework`
  // argument does. Windows is where that asymmetry bit: an unconditional
  // `frameworks: ['CoreAudio','AudioToolbox']` compiled fine (clang only warns)
  // and then failed at LINK time -- `lld-link: ignoring unknown argument
  // '-framework'`, then `could not open 'CoreAudio'` -- leaving the app with no
  // audio at all. macOS must keep its two frameworks; every other host must get
  // an empty list rather than flags its linker cannot read.
  const apples = process.platform === 'darwin';
  const hostHasAudioBackend = apples || process.platform === 'win32';
  const readSrc = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const airApp = readSrc('src/air-app.ts');
  const audioFw = list(audioNative, 'frameworks');

  check('an app using flash.media compiles vendor/audio_glue.c in (wherever a backend was built)',
    !hostHasAudioBackend || list(audioNative, 'sources').some((p) => p.endsWith('vendor/audio_glue.c')));
  check('an app using flash.media defines ASC_HAVE_AUDIO',
    list(audioNative, 'defines').includes('ASC_HAVE_AUDIO=1'));
  check('the backend hosts are named as data (darwin + win32), once, in checks.ts',
    /export const AUDIO_GLUE_HOSTS: readonly string\[\] = \['darwin', 'win32'\];/.test(readSrc('src/checks.ts'))
    && /AUDIO_GLUE_HOSTS\.includes\(process\.platform\)/.test(airApp)
    // Not two copies: the check table and air-app must read the SAME list, or
    // one of them eventually says "nothing will play" about a build that does.
    && !/audioGlueHosts = \['darwin', 'win32'\]/.test(airApp));
  check(apples
    ? 'macOS names miniaudio\'s CoreAudio backend (CoreAudio + AudioToolbox)'
    : 'Windows names no -framework at all (miniaudio LoadLibrary\'s WASAPI/DirectSound/WinMM)',
    apples ? audioFw.includes('CoreAudio') && audioFw.includes('AudioToolbox') : audioFw.length === 0);
  const darwinGate = airApp.indexOf("if (process.platform === 'darwin') {");
  check('...because the CoreAudio/AudioToolbox push sits inside the darwin branch (readable on any host)',
    darwinGate >= 0
    && airApp.slice(darwinGate, darwinGate + 240).includes("'CoreAudio'")
    && airApp.slice(darwinGate, darwinGate + 240).includes("'AudioToolbox'"));
  check('the rationale records the measured Windows link set (no -l: LoadLibrary/GetProcAddress)',
    airApp.includes('reaches all three of its Windows backends through LoadLibrary/GetProcAddress')
    && airApp.includes('is not even a Windows flag'));
  check('the no-backend warning names the glue, the hosts that have one, and this host',
    /it carries a backend for \$\{AUDIO_GLUE_HOSTS\.join\('\/'\)\} only, and this host is \$\{process\.platform\}/.test(readSrc('src/checks.ts'))
    && /this build does not link it/.test(readSrc('src/checks.ts')));
  check('and the CLI hint only offers `frameworks` where the flag exists (no Apple flags on Windows)',
    // Moved with the requirement: the hint is built by the vendor.audio check now,
    // not by a hand-written block in index.ts, so the pin follows it. Pinned as
    // the exact expression rather than "somewhere within N characters of a
    // guessable anchor", which is what made the previous form fragile.
    readSrc('src/checks.ts').includes(
      "+ (process.platform === 'darwin' ? ', plus `CoreAudio`/`AudioToolbox` to frameworks' : '')"));
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

  // The three air-starling-demo pins that used to live here are GONE (阶段一百九十八),
  // and they are not coming back: they asserted Starling's OWN classes
  // (`registerFactory(new SoundFactory())`, `ByteArrayFactory` at priority -100,
  // `getSound("wing_flap")` + `_movie.setFrameSound(2, …)`), none of which is an AIR
  // API -- `setFrameSound` appears nowhere under src/. So they never tested this
  // compiler; they pinned the acceptance fixture's source text, guarding against
  // an edit that would have made the audio evidence stale. Once the fixture became
  // an external, untracked clone (examples/EXTERNAL-FIXTURES.md) that guard has no
  // remaining object: editing your own local copy is your business.
  //
  // What they recorded is not lost -- it is written up in full in
  // docs/zh-cn/audio.md §13.4 (the commented-out SoundFactory line, the
  // ByteArrayFactory fallback swallowing the mp3 as raw bytes, and the resulting
  // silently-dead frame sound). The behavioural coverage of the API surface they
  // really depended on is examples/audio.as, which the example suite runs.

  if (ok > 0) console.log(`[audio] ${ok} audio-wiring checks passed`);
  return bad;
}

// Presentation must never be rescaled by the platform compositor (阶段一百三十三).
//
// The GPU backends handed the frame to the OS and let it scale-to-fit, which both
// platforms default to:
//   * Metal  — CALayer's default contentsGravity is kCAGravityResize, so the
//              layer stretches the drawable to its bounds;
//   * D3D12  — a zero-initialised DXGI_SWAP_CHAIN_DESC1.Scaling is
//              DXGI_SCALING_STRETCH, so DXGI stretches the back buffer to the
//              client rect.
// During a live resize the presented frame is transiently a different size than
// the window the compositor has already grown to -- the window keeps growing
// after the frame was drawn, so the mismatch is inherent -- and scale-to-fit then
// rescales the WHOLE picture for that frame. Measured on the air-native demo
// (Retina 2x, fast programmatic drag, canary = an ISOLATED 44x44 logical / 88x88
// px mid-gray square at (1120,1020)): with the resize default 15 of 93 captured
// frames showed a uniform rescale about the origin (k ~ 0.94-0.98, e.g. 83x84 at
// (1063,981) -- both dims AND the origin offset scaled together), and with
// top-left 0 of 151 frames across 6 drags. The red "open window" box is NOT a
// usable canary: an animated 100x100 red square drifts against it and the two
// merge into one 4-connected component, which reads as a bogus size change.
// Same demo, same drag script, same measurement: temp/resizeprobe/fast.py.
//
// Both are pinned here because neither default is visible in a diff: each is the
// *absence* of an assignment, and both files are host-only (the macOS half cannot
// be compiled on Windows and vice versa), so only a source-level pin catches a
// regression on the other host. Evidence for the D3D half is the same defect
// class measured on Metal plus the documented flip-model requirement; it has NOT
// been re-measured on Windows hardware.
function checkPresentScale(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [presentscale] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [presentscale] ${label}`); }
  };

  // The .cc/.mm files are CRLF in a Windows checkout; normalise before matching.
  const read = (rel: string): string =>
    readFileSync(join(root, 'vendor', rel), 'utf8').replace(/\r\n/g, '\n');
  // Comments matter here: the prose above names kCAGravityResize /
  // DXGI_SCALING_STRETCH, so only the real code may be searched.
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // ---- Metal: lay the drawable out 1:1 from the top-left, never scale it ----
  const mtl = strip(read('metal_glue.mm'));
  // Any contentsGravity assignment other than top-left is the bug (the file may
  // still *name* kCAGravityResize when logging the gravity it found).
  check('the CAMetalLayer is not assigned a scale-to-fit gravity',
    !/contentsGravity\s*=(?!\s*kCAGravityTopLeft\s*;)/.test(mtl));
  check('...it is pinned to kCAGravityTopLeft, exactly once',
    (mtl.match(/contentsGravity\s*=\s*kCAGravityTopLeft;/g) ?? []).length === 1);
  const iCast = mtl.indexOf('CAMetalLayer* l =');
  const iGrav = mtl.indexOf('contentsGravity = kCAGravityTopLeft;');
  const iDev = mtl.indexOf('l.device =');
  check('...on the attached layer, before that layer is configured or stored',
    iCast >= 0 && iGrav > iCast && iDev > iGrav);
  check('...so the drawable size stays what SDL reported (the gravity is the only change)',
    /m->layer\.drawableSize = CGSizeMake\(\(CGFloat\)width, \(CGFloat\)height\);/.test(mtl));

  // ---- The device scale must not be read out of two SDL size queries ----
  // Measured on macOS (temp/resizeprobe, 2026-10-21) while dragging a window edge:
  // SDL_GetWindowSize reads SDL's CACHED logical size (written from the resize
  // event) while SDL_GetWindowSizeInPixels asks Cocoa live, so mid-drag the pair is
  // one step apart — the layer was truly 329x580 pt / 658x1160 px while SDL still
  // reported lw=320, i.e. pw/lw = 2.056 instead of the display's 2.0. The stage size
  // and the canvas were then computed from that same bogus ratio, so the picture was
  // scaled ~3% too big and shrank back on the next step: the content visibly
  // "breathes" while the window is dragged. Measured over four drags (L/R/SE/SW):
  // 151/151 resize events reported contentsScaleFactor != 2 before the fix, 0/151
  // after. A right/bottom drag hides it behind the stage background the app paints
  // in the exposed area, which is why only the other corners were reported.
  const glue = strip(read('window_glue.cc'));
  const iDevScale = glue.indexOf('static int do_resize(WinCtx* c) {');
  const iDevNext = glue.indexOf('static void sk_measure_borders(');
  const resizeBody = (iDevScale >= 0 && iDevNext > iDevScale) ? glue.slice(iDevScale, iDevNext) : '';
  check('do_resize takes the device scale from the window/display, never by dividing SDL\'s two size queries',
    resizeBody.includes('sk_window_device_scale(') &&
    !/\(double\)npw \/ \(double\)nw/.test(resizeBody));
  check('...the seam asks the NSWindow for its own backing scale (stable for one display)',
    /sel_registerName\("backingScaleFactor"\)/.test(glue));
  check('...and reconciles a logical size that lags the live pixel size',
    /if \(dw > 0\) \*lw = dw;/.test(glue) && /if \(dh > 0\) \*lh = dh;/.test(glue));
  // One-sided repair is not enough, and that is a second, independent bug: do_resize
  // returns early as soon as the PIXEL size matches, so a logical size that is too
  // LARGE is never revisited. Measured on Windows with a real caption double-click:
  // after restore the stage stayed 2560x1636 inside a 1000x680 window for the rest of
  // the run. So the pin is on the REPLACEMENT (no comparison against *lw at all).
  check('...by replacing both halves, not only repairing the one that lags',
    !/if \(dw > \*lw\)/.test(glue) && !/if \(dh > \*lh\)/.test(glue));
  // Windows counterpart of the NSWindow query (phase 225): GetDpiForWindow is looked
  // up dynamically so the binary still starts on a pre-1607 system, and a missing
  // export leaves the SDL ratio in charge rather than guessing a scale.
  check('...and Windows asks the HWND for its DPI, resolved at run time',
    /#elif defined\(_WIN32\)[\s\S]{0,600}?GetProcAddress\([\s\S]{0,120}?"GetDpiForWindow"/.test(glue) &&
    /dpi \/ 96\.0/.test(glue));
  check('...while a platform without that query keeps SDL\'s own ratio unchanged',
    /return \(\*lw > 0\) \? \(double\)pw \/ \(double\)\*lw : 1\.0;/.test(glue));

  // ---- D3D12: present the back buffer 1:1, never stretch it to the client rect ----
  const d3d = strip(read('d3d_glue.cc'));
  check('dxgi1_4.h is included (it is what defines the scaling enum)',
    /#include <dxgi1_\d\.h>/.test(d3d));
  check('the D3D12 swapchain is not left on the scale-to-fit default',
    !/DXGI_SCALING_STRETCH/.test(d3d) &&
    !/DXGI_SCALING_ASPECT_RATIO_STRETCH/.test(d3d) &&
    !/Scaling\s*=\s*0\b/.test(d3d));
  check('...it asks for DXGI_SCALING_NONE, exactly once',
    (d3d.match(/sd\.Scaling = DXGI_SCALING_NONE;/g) ?? []).length === 1);
  const iDesc = d3d.indexOf('DXGI_SWAP_CHAIN_DESC1 sd = {};');
  const iScale = d3d.indexOf('sd.Scaling = DXGI_SCALING_NONE;');
  const iCreate = d3d.indexOf('CreateSwapChainForHwnd(');
  check('...on the same desc CreateSwapChainForHwnd consumes',
    iDesc >= 0 && iScale > iDesc && iCreate > iScale);
  check('...and the swapchain is still created at the client rect it will be shown in',
    /GetClientRect\(hwnd, &rc\);/.test(d3d) && /sd\.Width = \(UINT\)cw;/.test(d3d));

  // ---- D3D12: a SPARE back buffer, so moving a window cannot stall the frame ----
  // Windows-only and measured on real hardware (temp/dragtrace, 2026-10-17): with
  // two buffers, DXGI's presentation queue can hold BOTH of them while the
  // compositor is busy with the window -- which is exactly when the user is moving
  // it -- so sk_gpu_begin_frame's acquire wait blocks for two vblanks per frame
  // (~31 ms). Our frames can run inside the OS modal move loop dispatch
  // (live_resize_watch -> sk_pump_frame), so that wait is time the move loop never
  // gets: the window advanced in rock-steady 66.6 ms (four vblank) steps while
  // being dragged, where a plain Win32 window, a CPU-rendered SDL window and adl
  // all move in ~3 ms steps. With a third buffer the wait measures 0.0 ms and the
  // drag 3.1-4.4 ms steps (max 14 ms, zero gaps over 20 ms), still animating.
  // Harness: temp/dragtrace/dragtrace2.c (a real SendInput caption drag) + run2.cjs.
  check('the D3D12 swapchain keeps a spare back buffer (3, not the flip-model minimum 2)',
    /#define SK_D3D_NUM_FRAMES 3\b/.test(d3d));
  check('...and that one count sizes the swapchain and its per-buffer fences together',
    /sd\.BufferCount = SK_D3D_NUM_FRAMES;/.test(d3d) &&
    /buffers\[SK_D3D_NUM_FRAMES\]/.test(d3d) &&
    /fence_values\[SK_D3D_NUM_FRAMES\]/.test(d3d));

  // ---- D3D12: the resize path must not corrupt the fence ledger, and must not ----
  // ---- block forever if the compositor stalls (stages 177 and 177-one) --------
  // Windows-only and measured on real hardware (temp/dragtrace, 2026-10-17): the
  // flip-model acquire waits on fence_values[<the buffer about to be drawn into>],
  // which begin_frame fills in as "<the value that slot held> + 1". Resizing used to
  // re-read GetCurrentBackBufferIndex() right after ResizeBuffers -- pointing that
  // "value this slot held" lookup at whichever buffer the rebuilt swapchain landed
  // on, possibly an OLDER slot -- so the value assigned could be one the fence had
  // already passed. A fence never moves backwards, so Signal() on a passed value is
  // a no-op: that buffer lost its "the GPU is done with me" marker and the NEXT
  // resize's per-slot drain waited forever on a value that could never be reached
  // (measured: the window wedged solid after three corner-resize steps; 34 no-op
  // signals in 72 size changes before the fix, 0 in 298 after). The drain is also
  // bounded now, and on timeout it must release NOTHING -- the swapchain and every
  // surface stay as they are and the next frame retries.
  // Harness: temp/dragtrace/resizetrace.c (a real HTBOTTOMRIGHT SendInput drag).
  const iResize = d3d.indexOf('if (width != w->width || height != w->height)');
  const iAcq = d3d.indexOf('const UINT64 current = w->fence_values[w->buffer_index];');
  const resizeBlock = iResize >= 0 && iAcq > iResize ? d3d.slice(iResize, iAcq) : '';
  check('the resize drain waits with a bound, not INFINITE',
    /#define SK_D3D_DRAIN_MS \d+\b/.test(d3d) &&
    /WaitForSingleObjectEx\(w->fence_event, SK_D3D_DRAIN_MS, FALSE\)/.test(resizeBlock) &&
    !/INFINITE/.test(resizeBlock));
  check('...and on a timeout it skips the frame instead of releasing anything',
    // The releases must stay BEFORE ResizeBuffers (you cannot resize a swapchain
    // while still holding its back buffers), and the skip-the-frame return must
    // come before both -- that ordering is what makes an abandoned drain harmless.
    resizeBlock.length > 0 &&
    /if \(!drained\)/.test(resizeBlock) &&
    resizeBlock.indexOf('return nullptr;') > 0 &&
    resizeBlock.indexOf('return nullptr;') < resizeBlock.indexOf('surfaces[i].reset()') &&
    resizeBlock.indexOf('surfaces[i].reset()') < resizeBlock.indexOf('ResizeBuffers('));
  check('...and the resize path never re-reads the back-buffer index',
    resizeBlock.length > 0 && !/w->buffer_index\s*=/.test(resizeBlock) &&
    (d3d.match(/w->buffer_index = w->swapchain->GetCurrentBackBufferIndex\(\);/g) ?? []).length === 1);
  if (ok > 0) console.log(`[presentscale] ${ok} presentation-scaling checks passed`);
  return bad;
}

// ---- Capabilities.language / Capabilities.languages ----------------
// AIR reports the USER INTERFACE language here, in a CLOSED SET, plus the OS's
// preferred-UI-language list. Measured on adl 51.4.1:
//   - macOS 26.6.2: language == "zh-CN" and languages == ["zh-CN"] while the
//     process LANG is "en_US.UTF-8";
//   - Windows 11: language == "zh-CN" and languages == ["zh-CN","en-US"], and BOTH
//     stayed exactly that after the region format was switched to de-DE and again
//     after de-DE was moved to the head of the OS language list — so neither the
//     user locale (GetUserDefaultLocaleName answered de-DE, LangID 0x0407) nor that
//     list is the source. The reference agrees for Windows: this property "returns
//     the user interface (UI) language, which refers to the language used for all
//     menus, dialog boxes, error messages, and help files".
// The format is not a locale tag either: the reference states the value is "a
// lowercase two-letter language code from ISO 639-1" with an ISO 3166 region
// appended for Chinese only, lists every value it can take, and warns that the
// property "is limited to the possible values on this list" (which is why it tells
// applications to read languages[0] instead). Anything outside the table is "xu".
//
// The runtime used to read the process LANG and cut it to two letters, so a program
// testing `Capabilities.language == "zh-CN"` never saw the Chinese value on Windows
// (LANG is unset there) and silently switched to English. Three independently
// regressible halves are pinned here:
//   (1) the two formatters, BEHAVIOURALLY, compiled from the real shipped text —
//       on every host, because the tables below are fixed inputs and so no host
//       locale is involved;
//   (2) the host wiring end to end, which needs CoreFoundation and therefore runs
//       on darwin only;
//   (3) the source-level wiring pins and the darwin link requirement.
function checkCapabilitiesLocale(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [capabilities] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [capabilities] ${label}`); }
  };
  const LF = String.fromCharCode(10);
  // A C driver's stdout goes through the CRT, which turns each newline into CRLF on
  // Windows; strip the CR so the printed records compare equal on every host.
  const CR = String.fromCharCode(13);

  // Fixed inputs. `tags` drives the "language-REGION" normalizer that the entries of
  // Capabilities.languages go through; `airTags` drives Capabilities.language
  // itself, where a region survives for Chinese only, AIR's table decides the rest,
  // and anything outside that table collapses to "xu".
  const tags = ['zh_CN', 'zh-Hans-CN', 'en_US.UTF-8', 'en', 'zh_CN@currency=CNY', 'sr-Latn-RS'];
  const want = ['zh-CN', 'zh-CN', 'en-US', 'en', 'zh-CN', 'sr-RS'];
  const airTags = ['zh_CN', 'zh-Hans-CN', 'zh-Hant-TW', 'zh-HK', 'zh-TW', 'zh', 'en_US.UTF-8',
    'en', 'de-DE', 'fr', 'nb-NO', 'nn-NO', 'es-419', 'ar-SA', 'sr-Latn-RS'];
  const airWant = ['zh-CN', 'zh-CN', 'zh-TW', 'zh-TW', 'zh-TW', 'zh-CN', 'en',
    'en', 'de', 'fr', 'nb', 'xu', 'es', 'xu', 'xu'];

  // (1) Behaviour, compiled from the REAL text: the two helpers are sliced out of
  // the preamble, so there is no second copy of the rules to drift out of sync.
  {
    const from = RUNTIME_PREAMBLE.indexOf('static const char* const as_cap_air_langs[] = {');
    const upto = RUNTIME_PREAMBLE.indexOf('static const char* as_cap_language(void) {');
    const sliced = from >= 0 && upto > from ? RUNTIME_PREAMBLE.slice(from, upto) : '';
    const dir = join(root, 'temp', 'caploc-fmt');
    mkdirSync(dir, { recursive: true });
    const fmtC = join(dir, 'fmt.c');
    // Windows appends .exe to the output of -o <name>.
    const fmtExe = join(dir, 'fmt' + (process.platform === 'win32' ? '.exe' : ''));
    const inList = airTags.map((t) => `"${t}"`).join(', ');
    writeFileSync(fmtC, [
      '#include <stdio.h>',
      '#include <string.h>',
      '#include <stddef.h>',
      '',
      sliced,
      'int main(void) {',
      `  static const char* in[] = { ${inList} };`,
      `  for (int i = 0; i < ${airTags.length}; i++) {`,
      '    char out[32];',
      '    const char* got = as_cap_language_from_tag(in[i], out, sizeof(out));',
      '    printf("%s %s", in[i], got);',
      '    fputc(10, stdout);',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join(LF));
    let fOut = '';
    let fErr = '';
    try {
      execFileSync('cc', ['-O1', '-w', fmtC, '-o', fmtExe], { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS });
      fOut = execFileSync(fmtExe, [], { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS }).toString().split(CR).join('');
    } catch (e) {
      fErr = String((e as { stderr?: Buffer }).stderr ?? e).split(LF).slice(0, 3).join(' | ');
    }
    const gotLines = fOut.trim() === '' ? [] : fOut.trim().split(LF);
    check(`the language formatter compiles and runs on this host${fErr ? ` -- ${fErr}` : ''}`,
      fErr === '' && gotLines.length === airTags.length);
    for (let i = 0; i < airTags.length; i++) {
      const line = gotLines[i] ?? '';
      check(`language("${airTags[i]}") == "${airWant[i]}" (${line})`,
        line === `${airTags[i]} ${airWant[i]}`);
    }
  }

  // (2) The host wiring end to end, plus the normalizer that the list entries go
  // through. Needs CoreFoundation, so it runs on darwin (where CI runs). The
  // preamble alone does not link: it forward-declares helpers that the generated C
  // defines (as_v_is_class, as_class_fqn_of_ptr, ...), so the link runs with
  // -undefined dynamic_lookup — the driver calls only helpers that resolve, and what
  // is pinned here is the host VALUE, not a build.
  if (process.platform === 'darwin') {
    const scratch = join(root, 'temp', 'caploc-unit');
    mkdirSync(scratch, { recursive: true });
    const hostC = join(scratch, 'norm.c');
    const hostExe = join(scratch, 'norm' + (process.platform === 'win32' ? '.exe' : ''));
    const list = tags.map((t) => `"${t}"`).join(', ');
    writeFileSync(hostC, RUNTIME_PREAMBLE + [
      'static void caploc_line(const char* prefix, const char* value) {',
      '  printf("%s %s", prefix, value);',
      '  fputc(10, stdout);',
      '}',
      'int main(void) {',
      `  static const char* tags[] = { ${list} };`,
      `  for (int i = 0; i < ${tags.length}; i++) {`,
      '    char out[32];',
      '    as_cap_lang_normalize(tags[i], out, sizeof(out));',
      '    caploc_line("N", out);',
      '  }',
      '  // language vs languages[0]: AIR documents that the two "generally" share the',
      '  // PRIMARY language, NOT that they are equal (an en-US host reports "en" for',
      '  // language and "en-US" for languages[0], so same= is reported but not pinned).',
      '  {',
      '    as_array* ls = as_cap_languages();',
      '    const char* lang = as_cap_language();',
      '    const char* first = (ls->length > 0) ? (const char*)as_v_obj_val(ls->data[0]) : NULL;',
      '    size_t n = strlen(lang);',
      '    size_t m = (first != NULL) ? strlen(first) : 0;',
      '    size_t p = 0;',
      '    int same = (first != NULL && strcmp(first, lang) == 0) ? 1 : 0;',
      '    int prim = 0;',
      '    while (p < n && lang[p] != 45) p++;',
      '    if (first != NULL) {',
      '      if (strcmp(lang, "xu") == 0) prim = 1;',
      '      else if (m >= p && strncmp(lang, first, p) == 0 && (m == p || first[p] == 45)) prim = 1;',
      '    }',
      '    printf("L lang=%s first=%s same=%d prim=%d n=%d", lang, first != NULL ? first : "", same, prim, (int)ls->length);',
      '    fputc(10, stdout);',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join(LF));
    let out = '';
    let err = '';
    try {
      execFileSync('cc', ['-O1', '-w', hostC, '-o', hostExe, '-lm', '-lz',
        '-framework', 'CoreFoundation', '-Wl,-undefined,dynamic_lookup'],
        { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS });
      out = execFileSync(hostExe, [], { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS }).toString().split(CR).join('');
    } catch (e) {
      err = String((e as { stderr?: Buffer }).stderr ?? e).split(LF).slice(0, 3).join(' | ');
    }
    const lines = out.trim() === '' ? [] : out.trim().split(LF);
    const gotNorm = lines.filter((l) => l.startsWith('N ')).map((l) => l.slice(2));
    const tail = lines.find((l) => l.startsWith('L ')) ?? '';
    check(`the host probe builds and runs${err ? ` -- ${err}` : ''}`,
      err === '' && gotNorm.length === tags.length && tail !== '');
    for (let i = 0; i < tags.length; i++) {
      check(`normalize("${tags[i]}") == "${want[i]}"`, gotNorm[i] === want[i]);
    }
    check(`the host value is xx / zh-CN / zh-TW / xu shaped: ${tail}`,
      /^L lang=([a-z]{2}|zh-(CN|TW)|xu) first=/.test(tail));
    check(`language and languages[0] agree on the primary language: ${tail}`,
      tail.includes('prim=1') && !tail.includes('n=0'));
  } else {
    console.log('SKIP  [capabilities] the host-value probe needs macOS (CoreFoundation)');
  }

  // (2) Wiring. `language`/`languages` must be resolved to the runtime helpers, and
  // the runtime must reach the system locale rather than the process locale.
  const c = generateC(parse(
    'import flash.system.Capabilities;\n' +
    'var s:String = Capabilities.language;\n' +
    'var a:Array = Capabilities.languages;\n' +
    'var n:int = a.length;\n'
  )).c;
  check('the emitter resolves `language` to as_cap_language()', c.includes('as_cap_language()'));
  check('the emitter resolves `languages` to as_cap_languages()', c.includes('as_cap_languages()'));
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  check('the CoreFoundation entry points are declared by hand (the Apple headers cannot be included)',
    pre.includes('extern ASC_CFRef CFLocaleCopyCurrent(void);')
    && pre.includes('extern unsigned char CFStringGetCString(ASC_CFStringRef s, char* buf, long cap, unsigned encoding);'));
  check('the declarations are Apple-only (no Apple dependency on other targets)',
    /#if defined\(__APPLE__\) && !defined\(__wasi__\)\n#define ASC_HAVE_CFLOCALE 1/.test(pre));
  const langBody = (() => {
    const i = pre.indexOf('static const char* as_cap_language(void) {');
    return i < 0 ? '' : pre.slice(i, pre.indexOf('\n}', i));
  })();
  check('language reads CFLocaleCopyCurrent() before ever consulting LANG',
    langBody.indexOf('CFLocaleCopyCurrent()') >= 0
    && langBody.indexOf('CFLocaleCopyCurrent()') < langBody.indexOf('getenv("LANG")'));
  const normBody = (() => {
    const i = pre.indexOf('static void as_cap_lang_normalize(const char* tag, char* out, size_t cap) {');
    return i < 0 ? '' : pre.slice(i, pre.indexOf('\n}', i));
  })();
  check('the normalizer detects a region subtag as 2 letters or 3 digits',
    normBody.includes("if (len == 2 || (len == 3 && start[0] >= '0' && start[0] <= '9')) {"));

  // (3) The Windows half: `language` is the UI language (the reference: "On Microsoft
  // Windows systems, this property returns the user interface (UI) language"), and
  // the list is the OS preferred-UI-language list. The process locale is only the
  // last resort, tried after both platform sources.
  check('on Windows language comes from the UI language, never from LANG',
    langBody.includes('#if defined(_WIN32)')
    && langBody.indexOf('GetUserDefaultUILanguage') > langBody.indexOf('#if defined(_WIN32)')
    && langBody.indexOf('getenv("LANG")') > langBody.indexOf('GetUserDefaultUILanguage'));
  check('the Windows value is rebuilt from the ISO 639-1 name plus the ISO 3166 region',
    langBody.includes('LOCALE_SISO639LANGNAME') && langBody.includes('LOCALE_SISO3166CTRYNAME'));
  check('the Windows list comes from GetUserPreferredUILanguages',
    pre.includes('GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &cnt, wbuf, &cap)'));
  check('language is a closed set: AIR own table is spelled out',
    pre.includes('"cs", "da", "nl", "en", "fi", "fr", "de", "hu", "it", "ja", "ko", "nb",')
    && pre.includes('"pl", "pt", "ru", "es", "sv", "tr", NULL'));
  check('Chinese keeps a region, and it is the only language that does',
    pre.includes('strcmp(lang, "zh") == 0') && pre.includes('"zh-TW" : "zh-CN"'));
  check('a language outside the table reports xu',
    pre.includes('return "xu";') && pre.includes('as_cap_air_langs[i] != NULL'));

  // The runtime's CoreFoundation calls have to be resolved by the link, and only
  // where the declarations exist (darwin native). Missing it is a link error the
  // build layer reports for the whole program, so it is pinned here as data.
  const darwinNative = { ...defaultBuildConfig(), frameworks: [] } as BuildConfig;
  const wasmCfg = { ...defaultBuildConfig(), target: 'wasm' as Target } as BuildConfig;
  if (process.platform === 'darwin') {
    check('the darwin native link adds -framework CoreFoundation',
      platformFrameworks(darwinNative).includes('CoreFoundation'));
  }
  check('the wasm link does not ask for a macOS framework',
    platformFrameworks(wasmCfg).length === 0);
  check('a manifest that already lists CoreFoundation is not duplicated',
    platformFrameworks({ ...darwinNative, frameworks: ['CoreFoundation'] } as BuildConfig).length === 0
    || process.platform !== 'darwin');

  if (ok > 0) console.log(`[capabilities] ${ok} locale checks passed`);
  return bad;
}


// ---- the presented drawable must be readable as a shader input (stage 160) ----
//
// AS3 `DisplayObject.blendMode` reaches Skia as a paint blend mode
// (`sk_paint_set_blend` in skia_glue.cc, fed from the generated
// `as_skia_canvas_save_layer_paint(canvas, bp)` in emit.ts). All but `add`/`layer`
// of those modes -- darken, multiply, screen, lighten, difference, overlay,
// hardlight -- are *advanced* blend modes: fixed-function blending cannot express
// them, so Ganesh has to READ THE DESTINATION and blend it in a shader. On the
// Metal backend the destination is the CAMetalLayer drawable we wrapped, and a
// CAMetalLayer's drawables are `framebufferOnly = YES` by default -- a
// render-only storage mode that forbids being used as a shader input and answers
// with uninitialized memory when forced. Measured on TalkMED (temp/tkmeet-mac,
// diff D26): the home page's baked-in `BlendMode.DARKEN` layer composited that
// memory over the whole window as large magenta regions, in every frame, on any
// hover. The fix is one property; the pin exists so it cannot be "cleaned up".
function checkDrawableReadable(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [drawableread] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [drawableread] ${label}`); }
  };

  const read = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const mtlRaw = read('vendor/metal_glue.mm');
  const mtl = strip(mtlRaw);
  check('the CAMetalLayer drawable is allowed to be used as a shader input',
    (mtl.match(/framebufferOnly\s*=\s*NO;/g) ?? []).length === 1);
  check('...and never left on the render-only default',
    !/framebufferOnly\s*=\s*YES/.test(mtl));
  const iCast = mtl.indexOf('CAMetalLayer* l =');
  const iFbo = mtl.indexOf('framebufferOnly = NO;');
  const iBind = mtl.indexOf('g_mtl[win_id].used = 1;');
  check('...on the attached layer, during sk_mtl_init and before the slot is usable',
    iCast >= 0 && iFbo > iCast && iBind > iFbo);
  check('...and before any drawable of that layer is ever requested',
    iFbo > 0 && iFbo < mtl.indexOf('nextDrawable'));
  // The property is a workaround for a dst-reading pass, so the file must say so
  // -- a bare assignment invites removal as "unused configuration".
  check('the reason (advanced blend modes sample the destination) is documented next to it',
    /framebufferOnly/.test(mtlRaw) && /blend/i.test(mtlRaw) && /sampl/i.test(mtlRaw));

  // Consumer anchor: the renderer must really be able to ask for a dst-reading
  // blend, i.e. the mode table and the layer wrapper are still wired.
  const glue = strip(read('vendor/skia_glue.cc'));
  const emit = read('src/emit.ts');
  check('the blend-name table still maps advanced (dst-reading) modes',
    glue.includes('m = SkBlendMode::kDarken;') &&
    glue.includes('m = SkBlendMode::kMultiply;') &&
    glue.includes('m = SkBlendMode::kOverlay;'));
  check('...and a DisplayObject with blendMode is still composited through a layer',
    emit.includes('as_skia_canvas_save_layer_paint(canvas, bp)'));

  // The finding must stay written down, in both mirrors (docs/en mirrors docs/zh-cn).
  const zh = read('docs/zh-cn/skia.md');
  const en = read('docs/en/skia.md');
  check('the Metal drawable requirement is documented in skia.md (zh + en)',
    zh.includes('framebufferOnly') && zh.includes('kDarken') &&
    en.includes('framebufferOnly'));

  if (ok > 0) console.log(`[drawableread] ${ok} drawable-readability checks passed`);
  return bad;
}

// Display metrics: AIR mixes two display spaces in one run, and both have to be ITS
// space. Measured on this box (3840x2560 desktop, 150% scaling, adl 51.4.1):
//   Stage.fullScreenWidth/Height        2560x1707   <- logical points (DIP)
//   Capabilities.screenResolutionX/Y    2560x1707   <- logical points (DIP)
//   flash.display.Screen.mainScreen.bounds 3840x2560 <- physical pixels
//   Capabilities.screenDPI              96          <- a platform baseline
// (SDL's own DisplayDPI answers 144, and its DisplayMode answers 3840x2560.) Using the
// DISPLAY MODE for fullScreen* is what made a Stage3D app that sizes its viewport from
// it (examples/air-starling-demo -> Starling's projection) diverge from adl on Windows
// while macOS -- where both queries agree -- matched: the fix is a different QUERY
// (SDL_GetDisplayBounds, DIP-aware), not a divide, because the numbers alone cannot
// tell the two spaces apart at 100% scaling.
//
// The query alone was not enough (阶段二百零六): that value is CACHED in the glue, and every
// window-show path went on refilling the cache from the display MODE -- so the DIP query was
// unreachable in any app that has a window, and the whole app answered 3840x2560 (with
// Screen.bounds swapped against it: that one read 2560x1707 where adl reads 3840x2560). One
// writer, one space.
function checkDisplayMetrics(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [displaymetrics] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [displaymetrics] ${label}`); }
  };

  const readSrc = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const glue = readSrc('vendor/window_glue.cc');
  const runtime = readSrc('src/runtime.ts');
  const emit = readSrc('src/emit.ts');
  const bodyOfIn = (src: string, sig: string): string => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    const m = /\r?\n\}\r?\n/.exec(src.slice(i));
    return m == null ? '' : src.slice(i, i + m.index);
  };

  // The query, not just the number: SDL_GetDisplayBounds is DIP-aware once
  // SDL_HINT_WINDOWS_DPI_SCALING is set, SDL_GetCurrentDisplayMode is not. It also has to be
  // the ONLY writer of the cache, since the value is cached: a second writer in the pixel
  // space makes the DIP query unreachable, which is exactly what shipped. Pinned as the
  // invariant (one query, every refresh site) rather than as "the number is 2560", because
  // the numbers alone cannot tell the two spaces apart on a 100% display.
  const code = glue.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const refresh = bodyOfIn(code, 'static void sk_refresh_display_size_cache(');
  const size = bodyOfIn(code, 'int sk_window_get_display_size(');
  check('the fullScreen*/screenResolution* query is the DIP-aware one',
    refresh !== '' && /SDL_GetDisplayBounds\(0, &r\)/.test(refresh)
    && !/SDL_GetCurrentDisplayMode/.test(refresh));
  check('...and nothing refills the cache from the physical display mode (one writer only)',
    !/g_display_[wh] *= *dm\./.test(code)
    && /if \(r\.w > 0\) g_display_w = r\.w;/.test(refresh)
    // 3 window-show paths + the lazy branch in sk_window_get_display_size.
    && (code.match(/sk_refresh_display_size_cache\(\);/g) || []).length === 4
    && /sk_refresh_display_size_cache\(\);\n\s*if \(we_inited\) SDL_Quit\(\);/.test(size));
  check('the DIP-vs-pixels rationale is written down where it bit',
    glue.includes('SDL_GetDisplayBounds is DIP-aware') && glue.includes('150% scaling')
    && glue.includes('matching adl value for')
    && glue.includes('the cache can only ever hold the DIP-space value'));

  // screenDPI is a platform baseline, explicitly NOT the panel's DPI.
  const dpi = bodyOfIn(runtime, 'static double as_cap_screen_dpi(');
  check('Capabilities.screenDPI is a platform baseline (96 on Windows, 72 elsewhere)',
    /#ifdef _WIN32[\s\S]*?return 96\.0;[\s\S]*?#else[\s\S]*?return 72\.0;[\s\S]*?#endif/.test(dpi));
  check('...and the rationale names the trap (SDL_GetDisplayDPI answers 144)',
    /SDL_GetDisplayDPI answers 144/.test(runtime.slice(runtime.indexOf('as_cap_screen_dpi') - 700,
      runtime.indexOf('static double as_cap_screen_dpi('))));

  // One seam for all four accessors: changing the query changes Stage and Capabilities
  // together, which is what keeps the two from drifting apart.
  check('Stage.fullScreenWidth/Height read the same seam',
    (emit.match(/Stage_get_fullScreenWidth\(void\* _this\) \{ \(void\)_this; int w = 0, h = 0; as_window_get_display_size\(&w, &h\); return \(unsigned int\)w; \}/g) || []).length === 1
    && (emit.match(/as_window_get_display_size\(&w, &h\)/g) || []).length === 2);
  check('Capabilities.screenResolutionX/Y read the same seam',
    (runtime.match(/as_window_get_display_size\(&w, &h\)/g) || []).length === 2);

  // The remaining half is a KNOWN divergence, so it has to be written down in both
  // places rather than look like an oversight.
  check('the Screen.bounds physical-pixel divergence is registered at the code site and in TODO.md',
    glue.includes('SPACE NOTE (open divergence') && readSrc('TODO.md').includes('sk_display_pixel_bounds'));

  console.log(`     [displaymetrics] ${ok} check(s) passed`);
  return bad;
}

// ---- Capabilities.os (阶段一百八十七) ----
// AIR reports an OS *name plus version* here — "Windows 11", "Windows Server 2012 R2" —
// and apps read the version back out of it: a device-info field does
// `Capabilities.os.split(" ")[1]`, and the same string is hashed into a device
// fingerprint. Returning the bare family name "Windows" silently blanked that field and
// changed the fingerprint; it is also what made an extension's
// `Capabilities.os.search('Windows') > -1` gate false under AOT while it was true under
// adl (the gate used to read `manufacturer`, which is deliberately "AS-AOT").
//
// The Windows mapping is AIR 51.4.1's OWN table, recovered from `Adobe AIR.dll` (the
// VerifyVersionInfoW chain feeding its string pool, plus its build-22000 promotion and
// its wProductType server split). AIR asks VerifyVersionInfoW, which is subject to the
// manifest version lie — an app without a supportedOS manifest is told 6.2 on Windows
// 8.1+ — so the runtime reads the true version from ntdll's RtlGetVersion instead and
// feeds that same table. What is pinned here are the invariants that no AS-level example
// can see; the behaviour itself is pinned end to end by examples/stage65.as, which runs
// the real compiled binary on both Windows and macOS (§2.7).
function checkCapabilitiesOs(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [capos] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [capos] ${label}`); }
  };

  const from = RUNTIME_PREAMBLE.indexOf('static const char* as_win_os_name(');
  const upto = RUNTIME_PREAMBLE.indexOf('static const char* as_cap_os(void) {');
  const map = from >= 0 && upto > from ? RUNTIME_PREAMBLE.slice(from, upto) : '';

  // Every name AIR can answer on Windows must survive edits to the table. Dropping any of
  // them turns a real OS into the "Windows" fallback, which is the silent-degradation
  // shape this whole change exists to remove.
  const names = [
    'Windows 11 Server', 'Windows 11', 'Windows 10 Server', 'Windows 10',
    'Windows Server 2012 R2', 'Windows 8.1', 'Windows Server 2012', 'Windows 8',
    'Windows 7', 'Windows Server 2008 R2', 'Windows Vista', 'Windows Server 2008',
    'Windows Server 2003 R2', 'Windows Server 2003', 'Windows Home Server',
    'Windows XP 64', 'Windows XP', 'Windows 2000',
  ];
  const missing = names.filter((n) => !map.includes(`"${n}"`));
  check(`the mapping carries every name AIR can answer on Windows (${names.length} of them)`,
    map !== '' && missing.length === 0);
  if (missing.length > 0) console.log(`       missing: ${missing.join(', ')}`);

  // Windows 11 is 10.0 with build >= 22000 — not a separate major version. Getting this
  // wrong reports "Windows 10" on every Windows 11 machine, which is exactly the kind of
  // wrong-but-plausible value that goes unnoticed.
  check('Windows 11 is derived from the build number (>= 22000), not from major == 11',
    /major == 10 && minor == 0/.test(map) && /build >= 22000/.test(map));

  // Server SKUs differ only by wProductType (1 == VER_NT_WORKSTATION).
  check('the server/workstation split keys on wProductType, like AIR',
    /wProductType != 1/.test(RUNTIME_PREAMBLE) && /server \?/.test(map));

  // Load-bearing: this helper is compiled into EVERY build, including headless ones,
  // which do not link user32. A static GetSystemMetrics import therefore breaks those
  // links outright (measured: `lld-link: error: undefined symbol: GetSystemMetrics`),
  // so the SM_SERVERR2 probe has to go through GetProcAddress.
  check('as_cap_os adds no user32 dependency (headless builds do not link it)',
    !/\bGetSystemMetrics\s*\(/.test(map) && /GetProcAddress\(user32, "GetSystemMetrics"\)/.test(map));
  check('...and RtlGetVersion is resolved dynamically too, so no import library is added',
    /GetProcAddress\(ntdll, "RtlGetVersion"\)/.test(RUNTIME_PREAMBLE));

  // The two facts a future editor would otherwise "fix" the wrong way.
  check('the comment names the manifest version lie that forces RtlGetVersion',
    /manifest version lie/.test(RUNTIME_PREAMBLE) && /supportedOS/.test(RUNTIME_PREAMBLE));
  check('...and states that Linux/WASI still report the bare family name (macOS is closed out)',
    /Linux\/WASI still report the bare family name/.test(RUNTIME_PREAMBLE)
    && !/macOS\/Linux\/WASI still report/.test(RUNTIME_PREAMBLE));
  // macOS is no longer a gap: it appends the *product* version, taken from
  // kern.osproductversion rather than uname -r (which answers the Darwin kernel
  // release, 25.6.0 on macOS 26.6.2 -- a plausible-looking wrong value a future
  // editor could switch to, since both live in the same comment).
  check('...and pins the macOS product version to kern.osproductversion, not uname -r',
    /kern\.osproductversion/.test(RUNTIME_PREAMBLE)
    && /sysctlbyname\("kern\.osproductversion"/.test(RUNTIME_PREAMBLE)
    && !/\buname\s*\(/.test(RUNTIME_PREAMBLE) && !/utsname\.h/.test(RUNTIME_PREAMBLE)
    && /Mac OS 26\.6\.2/.test(RUNTIME_PREAMBLE));

  console.log(`     [capos] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/DrawableReadable', checkDrawableReadable);
registerGroup('unit: platform/AudioWiring', checkAudioWiring);
registerGroup('unit: platform/Screen', checkScreen);
registerGroup('unit: platform/NativeWindow', checkNativeWindow);
registerGroup('unit: platform/BackendParity', checkBackendParity);
registerGroup('unit: platform/WindowFrame', checkWindowFrame);
registerGroup('unit: platform/PresentScale', checkPresentScale);
registerGroup('unit: platform/NullRef', checkNullRef);
registerGroup('unit: platform/Intervals', checkIntervals);
registerGroup('unit: platform/CapabilitiesLocale', checkCapabilitiesLocale);
registerGroup('unit: platform/DisplayMetrics', checkDisplayMetrics);
// ---- NativeWindow/NativeApplication window-table surface (阶段一百九十) ----
// Every member in this group answers from ONE source of truth: the runtime's
// window table (ASC_wins). AIR keeps openedWindows, stage.nativeWindow and the
// application's exit bookkeeping in the same place, and the failure mode of
// keeping a second copy is an Array whose elements are not the very window
// objects the rest of the program holds. So these pins are about derivation and
// identity, not about the getters merely being present.
//
// Oracle: adl 51.4.1, temp/nwor/adl-oracle.txt -- openedWindows is an Array
// (cls=Array, not Vector) whose element n is identity-equal to that window's
// stage.nativeWindow, its length going 1 -> 2 -> 1 across a new and a close;
// orderInFrontOf/orderInBackOf answer true; globalToScreen(0,0) is the bounds
// frame origin plus the non-client border inset (measured bounds (26,26) with
// borders (8,31) -> (34,57)); NativeWindow.menu is null.
function checkNativeWindowSurface(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-surface] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-surface] ${label}`); }
  };

  // A program that touches every member of the group, so nothing here is pinned
  // on a class the emitter had no reason to emit.
  const c = generateC(parse(
    'import flash.display.NativeWindow;\n' +
    'import flash.display.NativeWindowInitOptions;\n' +
    'import flash.display.Stage;\n' +
    'import flash.desktop.NativeApplication;\n' +
    'import flash.events.NativeWindowDisplayStateEvent;\n' +
    'import flash.geom.Point;\n' +
    'var stage:Stage = new Stage();\n' +
    'var app:NativeApplication = NativeApplication.nativeApplication;\n' +
    'var w:NativeWindow = new NativeWindow(new NativeWindowInitOptions());\n' +
    'var arr:* = app.openedWindows;\n' +
    'var n:int = arr.length;\n' +
    'var m:* = w.menu;\n' +
    'var f1:Boolean = w.orderInFrontOf(w);\n' +
    'var f2:Boolean = w.orderInBackOf(null);\n' +
    'var pt:Point = w.globalToScreen(new Point(0, 0));\n' +
    'var ds:String = NativeWindowDisplayStateEvent.DISPLAY_STATE_CHANGE;\n' +
    'var ds2:String = NativeWindowDisplayStateEvent.DISPLAY_STATE_CHANGING;\n' +
    'app.exit();\n'
  )).c;
  const preamble = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n');
  const glue = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8');

  const body = (sig: string): string => {
    const i = c.indexOf(sig);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i) + 2);
  };
  const glueBody = (sig: string): string => {
    const i = glue.indexOf(sig);
    return i < 0 ? '' : glue.slice(i, glue.indexOf('\n}', i) + 2);
  };

  // (1) openedWindows is a VIEW of the window table. A separate list would drift
  // as soon as a window is retired, and fresh wrappers instead of the cached ones
  // would make `app.openedWindows[0] === stage.nativeWindow` false -- adl says true.
  check('openedWindows is emitted as an Array getter (AIR: cls=Array, not Vector)',
    c.includes('as_array* NativeApplication_get_openedWindows(void* _this)')
    && c.includes('{ "openedWindows", NativeApplication_get_openedWindows__dyn, 0, "Array" }'));
  const ow = body('static as_array* as_win_opened_windows(void) {');
  check('...derived by walking the live window table, not a parallel list',
    ow.includes('as_array_new()') && ow.includes('ASC_MAX_WINDOWS')
    && ow.includes('ASC_w(i)') && ow.includes('w->stage == NULL || w->closed')
    && ow.includes('as_win_wrapper(i)'));
  check('...and its elements are the cached wrappers, so an element IS stage.nativeWindow',
    c.includes('static NativeWindow* as_win_wrapper(int id);')
    && body('static NativeWindow* as_win_wrapper(int id) {').includes('w->window = (void*)nw;'));

  // (2) exit() has to reach the GLUE. Ending the app is the window backend's job
  // (the SDL_QUIT-equivalent teardown), so the CLOSE dispatches and their order
  // stay the ones a user-initiated close produces; a compiler-side "return from
  // main" would skip every CLOSE handler.
  check('NativeApplication.exit() is emitted and routed to the window backend',
    c.includes('void NativeApplication_exit(void* _this)')
    && c.includes('{ "exit", NativeApplication_exit__dyn, 0, "void" }')
    && body('static void NativeApplication_exit(void* _this) {').includes('as_window_request_exit()')
    && preamble.includes('sk_window_request_exit();'));
  check('...and the glue turns that request into a normal window retire, not a hard exit',
    glueBody('void sk_window_request_exit(void) {').includes('g_exit_requested = 1;')
    && glue.includes('if (g_exit_requested) {')
    && glue.includes('destroy_pending = 1;'));

  // (3) menu answers AIR's null rather than inventing an object: this runtime has
  // no NativeMenu subsystem. The C return type has to stay Object* -- that is
  // AIR's declared type, and the prototype/signature mismatch is a link error.
  check('NativeWindow.menu is declared Object and answers null (no NativeMenu subsystem)',
    c.includes('static Object* NativeWindow_get_menu(void* _this);')
    && body('static Object* NativeWindow_get_menu(void* _this) {').includes('return NULL;')
    && c.includes('{ "menu", NativeWindow_get_menu__dyn, 0, "Object" }'));

  // (4) The z-order pair reports true for a live OTHER window (adl), and a null /
  // self / retired target is a no-op that must not be reported as success.
  const front = body('bool NativeWindow_orderInFrontOf(void* _this, NativeWindow* window) {');
  const back = body('bool NativeWindow_orderInBackOf(void* _this, NativeWindow* window) {');
  check('orderInFrontOf/orderInBackOf perform the existing z-order move and return true',
    front.includes('as_window_order_front(me);') && front.includes('return true;')
    && back.includes('as_window_order_back(me);') && back.includes('return true;'));
  check('...but reject a null, self, or retired target instead of reporting success',
    [front, back].every((b) => b.includes('if (window == NULL) return false;')
      && b.includes('int me = ((NativeWindow*)_this)->_win;')
      && b.includes('if (window->_win == me) return false;')
      && b.includes('o->stage == NULL || o->closed) return false;')));

  // (5) globalToScreen counts from the CLIENT area's top-left, so the frame border
  // is added back to the (frame-rect) bounds origin: adl's (26,26) with borders
  // (8,31) became (34,57). Using the bounds origin alone is off by exactly the
  // title bar and the left frame.
  const g2s = body('Point* NativeWindow_globalToScreen(void* _this, Point* point) {');
  check('globalToScreen adds the non-client border to the bounds origin',
    g2s.includes('as_window_get_bounds(id, &x, &y, &w, &h);')
    && g2s.includes('as_window_get_borders(id, &bt, &bl, &bb, &br);')
    && g2s.includes('Point_new((double)(x + bl) + point->x, (double)(y + bt) + point->y)')
    && g2s.includes('if (point == NULL) return NULL;'));

  // (6) The event class exists with the measured constant strings, so a listener
  // written against AIR compiles and compares equal. The two names ARE the long
  // ones: mxmlc 51.4.1 accepts DISPLAY_STATE_CHANGE/DISPLAY_STATE_CHANGING and
  // REJECTS CHANGE/CHANGING plus NORMAL/MINIMIZED/MAXIMIZED on this class (those
  // three live on NativeWindowDisplayState) -- measured temp/nwmac/cstest.
  check('NativeWindowDisplayStateEvent carries AIR\'s measured constants',
    c.includes('static char* const NativeWindowDisplayStateEvent_DISPLAY_STATE_CHANGE = "displayStateChange";')
    && c.includes('static char* const NativeWindowDisplayStateEvent_DISPLAY_STATE_CHANGING = "displayStateChanging";'));
  check('...and the class carries AIR\'s before/afterDisplayState pair',
    c.includes('"beforeDisplayState"') && c.includes('"afterDisplayState"')
    && c.includes('{ "clone", NativeWindowDisplayStateEvent_clone__dyn, 0, "flash.events::Event" }'));

  // (7) The two new glue entry points sit behind the window seam, so a headless /
  // browser build (ASC_USE_WINDOW undefined) still links: the wrappers degrade to
  // no-ops instead of pulling SDL in.
  check('the new glue calls are inside the ASC_USE_WINDOW seam (headless stays link-clean)',
    /as_window_get_borders\(int id, int\* top, int\* left, int\* bottom, int\* right\) \{\n#ifdef ASC_USE_WINDOW\n    sk_window_get_borders\(id, top, left, bottom, right\);\n#else\n    \(void\)id; if \(top\) \*top = 0;/.test(preamble)
    && /as_window_request_exit\(void\) \{\n#ifdef ASC_USE_WINDOW\n    sk_window_request_exit\(\);\n#endif/.test(preamble));
  // The seam has TWO branches, and a wrapper present only in the ASC_USE_WINDOW
  // one compiles everywhere EXCEPT the headless build -- which is exactly how
  // these two first landed (air-native's dir unit: "call to undeclared function
  // 'as_window_request_exit'"). Both entry points need the no-window branch too.
  check('...and the headless branch declares them as well (stub out both, not just the real one)',
    /as_window_get_borders\(int id, int\* top, int\* left, int\* bottom, int\* right\) \{ \(void\)id; if \(top\) \*top = 0;/.test(preamble)
    && /as_window_request_exit\(void\) \{ \}/.test(preamble));

  console.log(`     [win-surface] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/WindowSurface', checkNativeWindowSurface);
registerGroup('unit: platform/CapabilitiesOs', checkCapabilitiesOs);

// flash.filesystem.File's two host-OS string statics (阶段二百一十八): separator and
// lineEnding.
//
// Why this is a PLATFORM pin and not merely a File one: the answer to both is a
// property of the HOST, so the honest way to produce it in an AOT compiler is a
// conditional in the emitted code -- which is precisely the shape that rots silently
// when only one of its branches is ever compiled by the machine you develop on (this
// repo's developer is on Windows; the CI runner is arm64 macOS). Same discipline as
// the "both branches of the seam" pins above, and it is the Windows bug class
// recorded with it: a helper written for the host you can test compiles fine
// everywhere EXCEPT the platforms that take the other branch.
//
// The values themselves are AIR's, not ours (airsdk.dev): File.separator is "the
// forward slash (/) character" on Mac OS and Linux and "the backslash (\) character"
// on Windows; File.lineEnding is the line-feed character on Mac OS and Linux, and on
// Windows "the carriage return character ... followed by the line-feed character".
// The browser build has no AIR counterpart at all and keeps the POSIX pair -- the
// honest answer there, not a silent Windows-ism.
function checkFileHostConstants(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [file-host] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [file-host] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n' +
    'trace("x" + File.separator + File.lineEnding);\n' +
    'trace("y" + flash.filesystem.File.separator + flash.filesystem.File.lineEnding);\n'
  )).c;
  const fn = (sig: string): string => {
    const i = c.indexOf(sig);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i));
  };
  const sep = fn('static char* as_file_separator(void) {');
  const eol = fn('static char* as_file_line_ending(void) {');

  check('File.separator is emitted with BOTH platform branches, each with AIR\'s value',
    sep.includes('#ifdef _WIN32') && sep.includes('#else')
    && sep.includes('return (char*)"\\\\";') && sep.includes('return (char*)"/";'));
  check('File.lineEnding is emitted with BOTH platform branches (CRLF on Windows, LF elsewhere)',
    eol.includes('#ifdef _WIN32') && eol.includes('#else')
    && eol.includes('return (char*)"\\r\\n";') && eol.includes('return (char*)"\\n";'));

  console.log(`     [file-host] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/FileHostConstants', checkFileHostConstants);

// The Windows arm of the two File host backends (阶段二百四十四): the Recycle Bin behind
// File.moveToTrash, and the volume query behind File.spaceAvailable.
//
// Same bug class as File.separator above -- a conditional whose Windows branch the
// developer's machine never compiles if you only ever build and run on POSIX -- but
// found this time from the other end: the POSIX arm was the real implementation and
// the _WIN32 arm was the stub (as_trash_dir returned NULL, so moveToTrash threw #2038
// while AIR recycled the item). Measured against adl 51.4.1 ON WINDOWS
// (temp/trashwin/): the item lands in the Recycle Bin with its payload readable and
// its original path recorded in the $I sidecar, directories included; the async form
// dispatches COMPLETE; the failure numbers are the same #3003/#2037 as on macOS; and a
// regular file reports the same spaceAvailable as the directory that holds it.
//
// The half this machine CANNOT run is the POSIX one, so it is pinned structurally:
// as_trash_move must still reach as_trash_dir on every non-Windows target, and the
// POSIX body has to survive verbatim inside the new #else -- the whole Windows change
// being an #ifdef wrap of it is what makes "unchanged" checkable without a Mac.
function checkWindowsHostBackends(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-host] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-host] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n' +
    'var f:File = new File("x");\n' +
    'f.moveToTrash();\n' +
    'f.moveToTrashAsync();\n' +
    'trace("" + f.spaceAvailable);\n'
  )).c;
  const fn = (sig: string): string => {
    const i = c.indexOf(sig);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i));
  };

  const shell = fn('static long as_trash_move_shell(const char* path) {');
  const move = fn('static long as_trash_move(const char* path) {');
  const space = fn('static double as_file_space_available(const char* p) {');
  const dirFn = fn('static char* as_trash_dir(const char* path) {');

  check('the Recycle Bin helper is emitted, guarded for _WIN32 only',
    c.includes('#ifdef _WIN32\nstatic long as_trash_move_shell')
    && c.includes('}\n#endif\n\n// as_trash_move:') && c.includes('void File_moveToTrash(void* _this) {'));
  check('it deletes through SHFileOperationW with FOF_ALLOWUNDO (recycled, not erased)',
    shell.includes('op.wFunc = FO_DELETE;') && shell.includes('FOF_ALLOWUNDO')
    && shell.includes('FOF_NOCONFIRMATION') && shell.includes('FOF_NOERRORUI')
    && shell.includes('if (SHFileOperationW(&op) != 0) return 2038;'));
  check('the path list is DOUBLE-NUL terminated and converted the way the rest of the runtime converts',
    shell.includes('MultiByteToWideChar(CP_ACP, 0, path, -1, NULL, 0)')
    && shell.includes('(size_t)(need + 1) * sizeof(WCHAR)') && shell.includes('from[need] = 0;'));
  check('as_trash_move reaches it on Windows BEFORE the POSIX trash directory lookup',
    move.includes('#ifdef _WIN32') && move.includes('return as_trash_move_shell(path);')
    && move.includes('#else') && move.indexOf('as_trash_move_shell') < move.indexOf('as_trash_dir'));
  check('...and the POSIX body survives verbatim inside that #else',
    move.includes('char* dir = as_trash_dir(path);') && move.includes('rename(path, target)')
    && move.includes('as_trash_note(dir, target, path);') && move.trimEnd().endsWith('#endif'));
  check('the Windows arm of as_trash_dir stays a stub: this host never renames into a trash directory',
    dirFn.includes('#elif defined(_WIN32)')
    && dirFn.slice(dirFn.indexOf('#elif defined(_WIN32)'), dirFn.indexOf('#elif defined(__APPLE__)')).includes('return NULL;')
    && dirFn.includes('.Trashes'));
  check('spaceAvailable maps a path to its volume root, so a FILE answers too',
    space.includes('GetVolumePathNameA(p, root, MAX_PATH)') && space.includes('GetDiskFreeSpaceExA(root, &freeAvail, NULL, NULL)'));
  check('...gated on existence, because GetVolumePathName walks up to a mounted ancestor',
    space.includes('if (!as_path_exists(p)) return 0.0;')
    && space.indexOf('as_path_exists') < space.indexOf('GetVolumePathNameA'));

  const build = readNorm(join(root, 'src', 'build.ts'));
  check('the Windows link line carries shell32 (SHFileOperationW and ShellExecuteA)',
    /if \(process\.platform === 'win32'\) return \['shell32'\];/.test(build));

  const ex = readNorm(join(root, 'examples', 'move-to-trash.as'));
  check('the example proves recoverability on BOTH hosts, not only in the POSIX trash dirs',
    ex.includes('function isWindows()') && ex.includes('$Recycle.Bin')
    && ex.includes('recordedPath(k)') && ex.includes('purge(payload)')
    && ex.includes('every recycled entry this run made is gone'));

  // ---- 阶段二百六十五：两条只有 Windows 宿主才编译得到、因而 macOS CI 天生看不见的
  //      「产物根本编不过 / 链不上」的缺陷 ----
  // 它们不改变任何 AS3 语义，所以 examples 套件在 macOS 上永远是绿的；反过来，本机
  // clang 的双态实测才是证据：改前 `clang -fsyntax-only` 在生成的 C 上**7 条 error**，
  // 改前 lld-link 报 `undefined symbol: sk_menu_flush/sk_menu_ensure`。下面钉的是
  // 那两处根因，故任何宿主都能跑。
  //
  // ① runtime.ts 是模板字符串，`\\` 只在 JS 层掉一层：想发射 C 的 `'\\'` 与 `'\0'`
  //    就得在源码里写双份。少一层时 C 看到的是 `'\'`（反斜杠吞掉收尾引号，字面量
  //    跨到行尾）与一个字面 NUL 字节（`\0` 被 JS 先解释掉了）。
  const enumAt = c.indexOf('FindFirstFileA(pat,');
  const enumBlock = enumAt < 0 ? '' : c.slice(Math.max(0, enumAt - 500), enumAt);
  check('the emitted _WIN32 enumeration block exists at all', enumAt > 0);
  // 反斜杠本身用 fromCharCode 拼：这条断言若再依赖模板/raw 的转义层数，就成了
  // 「用同一类易错语法去证明那类语法没错」。
  const BS = String.fromCharCode(92);
  check('...and its separator/terminator escapes survive the template literal',
    enumBlock.includes("pat[i] = '" + BS + BS + "';") && enumBlock.includes("pat[pn + 2] = '" + BS + "0';"));
  // 字面 NUL 是同一处失误的另一半：它让 C 源码里出现裸 0 字节，clang 只报 warning 时
  // 更危险（值恰好 0，看起来对），所以这里直接禁掉。
  check('...with no raw NUL byte smuggled into the generated C', !enumBlock.includes('\u0000'));

  // ② 事件泵与事件循环**无条件**调用这两个文件内静态钩子（sk_pump_frame / sk_run_loop），
  //    而真身只在 Cocoa 那一支里 ⇒ 非 Cocoa 支（Windows）声明了、调用了、却没定义。
  const glueW = readNorm(join(root, 'vendor', 'window_glue.cc'));
  const menuAt = glueW.indexOf('int sk_menu_supported(void) { return 1; }');
  const menuElse = glueW.indexOf('\n#else', menuAt);
  const cocoaArm = menuAt < 0 ? '' : glueW.slice(menuAt, menuElse);
  const otherArm = menuElse < 0 ? '' : glueW.slice(menuElse, glueW.indexOf('\n#endif', menuElse));
  check('both arms of the menu seam are found (else this pin is vacuous)',
    menuAt > 0 && menuElse > menuAt && otherArm.length > 0);
  check('the Cocoa arm defines the two file-local hooks the shared loop calls',
    cocoaArm.includes('static void sk_menu_flush(void) {') && cocoaArm.includes('static void sk_menu_ensure(void) {'));
  check('the non-Cocoa arm defines them too, as explicit no-ops',
    otherArm.includes('static void sk_menu_flush(void) { }') && otherArm.includes('static void sk_menu_ensure(void) { }'));
  check('...and both call sites are still unconditional (they are why the stubs are required)',
    /\n\s*sk_menu_ensure\(\);/.test(glueW) && /\n\s*sk_menu_flush\(\);/.test(glueW));

  console.log(`     [win-host] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/WindowsHostBackends', checkWindowsHostBackends);

// The CPU-raster window blit, and the one assumption that broke it (阶段二百七十三).
//
// Skia's kN32 is a BUILD-TIME property of the TARGET: include/core/SkTypes.h sets
// SK_R32_SHIFT=16 (bytes B,G,R,A) under SK_BUILD_FOR_WIN and 0 (bytes R,G,B,A)
// everywhere else, and SK_BUILD_FOR_WIN itself comes from _WIN32
// (include/private/base/SkFeatures.h). window_glue.cc used to hardcode the macOS
// answer for every host, so every CPU-mode window on Windows blitted its pixels with
// red and blue exchanged -- measured on ui-demo/air-gallery: the accent #2563EB came
// out #EB6325, whites went cream (temp/colorprobe/ links the vendored skia.lib and
// prints the surface's own bytes: colorType 6 = BGRA_8888, `EB 63 25 FF` for that
// colour).
//
// The fix is "ask the surface, never assume". What is pinned here is that shape: the
// two header facts that make Windows differ (so a vendored-Skia bump that moves the
// default is a red gate, not a silently orange app), and the rule that every path
// creating the streaming texture derives its format from the surface instead of a
// literal.
function checkCpuPixelFormat(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cpupix] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cpupix] ${label}`); }
  };

  // ---- the fact this bug was made of, straight from the vendored Skia ----
  const types = readNorm(join(root, 'vendor', 'skia', 'include', 'core', 'SkTypes.h'));
  const feats = readNorm(join(root, 'vendor', 'skia', 'include', 'private', 'base', 'SkFeatures.h'));
  check('windows really is the BGRA build (SkTypes.h: SK_R32_SHIFT=16 under SK_BUILD_FOR_WIN)',
    /#elif defined\(SK_BUILD_FOR_WIN\)\n\s*#define SK_R32_SHIFT 16\n/.test(types));
  check('...and SK_BUILD_FOR_WIN is derived from _WIN32, i.e. it holds for our own TUs',
    /#if defined\(_WIN32\) \|\| defined\(__SYMBIAN32__\)\n\s*#define SK_BUILD_FOR_WIN\n/.test(feats));

  // ---- the glue asks the surface ----
  const glue = readNorm(join(root, 'vendor', 'window_glue.cc'));
  const sk = readNorm(join(root, 'vendor', 'skia_glue.cc'));
  const sliceFn = (src: string, sig: string): string => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    const end = src.indexOf('\n}\n', i);
    return end < 0 ? src.slice(i) : src.slice(i, end);
  };

  check('the macOS masks are gone: no SDL format is built from a literal RGBA order',
    !glue.includes('SDL_MasksToPixelFormatEnum(32, 0x000000FFu, 0x0000FF00u, 0x00FF0000u, 0xFF000000u)'));
  const helper = sliceFn(glue, 'static Uint32 sk_pixfmt_for_surface(void* surface) {');
  check('the format helper exists and maps both byte orders explicitly',
    helper.includes('if (order == 1)      { r = 0x000000FFu; b = 0x00FF0000u; }')
    && helper.includes('else if (order == 2) { b = 0x000000FFu; r = 0x00FF0000u; }'));
  check('...and an unknown order is refused rather than guessed',
    helper.includes('else return SDL_PIXELFORMAT_UNKNOWN;'));
  check('the surface is asked for its own byte order (declared across the C boundary)',
    glue.includes('int sk_surface_pixel_order(void* surface);'));
  check('the Skia side answers from the SAME pixmap the blit is handed',
    /int sk_surface_pixel_order\(void\* surface\) \{\n  SkPixmap pm;\n  if \(surface == nullptr \|\| !\(\(SkSurface\*\)surface\)->peekPixels\(&pm\)\) return 0;/
      .test(sk)
    && sk.includes('case kRGBA_8888_SkColorType: return 1;')
    && sk.includes('case kBGRA_8888_SkColorType: return 2;'));

  // ---- every path that creates the streaming texture derives the format ----
  const calls = (glue.match(/sk_pixfmt_for_surface\(/g) || []).length;
  check('all three texture paths derive the format (attach / show / resize)', calls === 4);
  check('...attach: a NativeWindow creation',
    sliceFn(glue, 'void sk_window_attach_surface(int id, void* surface, int pw, int ph) {')
      .includes('c->pixfmt = sk_pixfmt_for_surface(c->surface);'));
  check('...show: the app\'s initial window',
    sliceFn(glue, 'int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,')
      .includes('c->pixfmt = sk_pixfmt_for_surface(surface);'));
  check('...resize: a rebuilt surface is asked again, not inherited',
    sliceFn(glue, 'static int do_resize(WinCtx* c) {')
      .includes('c->pixfmt = sk_pixfmt_for_surface(c->surface);'));
  check('an unsupported surface is reported at every one of them (never a silent wrong blit)',
    (glue.match(/if \(c->pixfmt == SDL_PIXELFORMAT_UNKNOWN\) \{/g) || []).length === 3
    && (glue.match(/window_glue: .*unsupported colour type/g) || []).length === 3);

  // ---- and nowhere else in the vendor tree re-derives it ----
  let maskUsers: string[] = [];
  for (const f of readdirSync(join(root, 'vendor'))) {
    if (!/\.(cc|c|mm)$/.test(f)) continue;
    if (readNorm(join(root, 'vendor', f)).includes('SDL_MasksToPixelFormatEnum')) maskUsers.push(f);
  }
  check('window_glue.cc is the only TU that builds an SDL pixel format at all',
    maskUsers.length === 1 && maskUsers[0] === 'window_glue.cc');

  console.log(`     [cpupix] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/CpuPixelFormat', checkCpuPixelFormat);

// Windows per-character font fallback. GDI's manager has no system cascade at all:
// SkFontMgrGDI::onMatchFamilyStyleCharacter is an unconditional `return nullptr`
// (src/ports/SkFontHost_win.cpp ~2267), while SkParagraph asks the manager for a
// fallback face for EVERY code point the run's own face does not map. A family GDI
// cannot match therefore renders as a whole field of .notdef boxes -- not a stray
// glyph: measured on the host app, the AI-subtitle window's tag-37 field whose SWC
// family is "微软雅黑" (an en-US UI locale exposes that family to GDI only as
// "Microsoft YaHei") drew 创建同传 as four .notdef glyphs, which is the garble the
// user reported. temp/fntface reproduces it headlessly: the 微软雅黑 row and a
// deliberately bogus family drew the same .notdef for the same text.
//
// The fix is deliberately NOT a DirectWrite swap and NOT SkOrderedFontMgr: an ordered
// manager lets DirectWrite answer the STRUCTURED (family/style) queries as well, and a
// DirectWrite typeface then reaches SkParagraph's structured path -- the one our AIR
// strut / height-override machinery drives -- which measured textHeight -Infinity with
// that row painting nothing at all. GDI therefore stays primary for every query but
// the character one.
function checkFontFallback(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fontfallback] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fontfallback] ${label}`); }
  };

  // The glue is CRLF in a Windows checkout; normalise before matching. Prose matters
  // here (the rationale names the Windows API entry points), so keep a raw copy.
  const read = (rel: string): string =>
    readFileSync(join(root, 'vendor', rel), 'utf8').replace(/\r\n/g, '\n');
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Both halves of the Skia glue: the platform font manager lives in the graphics
  // half, but sk_family_alias (which resolves an UNINSTALLED family to the
  // platform default) went with the text engine in stage 221 -- see
  // docs/zh-cn/rust-text-backend.md.
  const raw = read('skia_glue.cc') + '\n' + read('skia_text_glue.cc');
  const glue = strip(raw);

  const win = glue.indexOf('#elif defined(_WIN32)');
  const cls = glue.indexOf('class SkAirFontMgr : public SkFontMgr {');
  const clsEnd = cls < 0 ? -1 : glue.indexOf('\n};', cls);
  const mb = cls >= 0 && clsEnd > cls ? glue.slice(cls, clsEnd) : '';
  const ovBody = (sig: string): string => {
    const i = mb.indexOf(sig);
    if (i < 0) return '';
    const j = mb.indexOf('\n  }', i);
    return mb.slice(i, j < 0 ? mb.length : j);
  };

  // (1) The manager is a two-tier wrapper, primary first.
  check('the Windows font manager is a primary + fallback wrapper',
    cls > win && win > 0 &&
    mb.includes('SkAirFontMgr(sk_sp<SkFontMgr> primary, sk_sp<SkFontMgr> fallback)') &&
    mb.includes(': fPrimary(std::move(primary)), fFallback(std::move(fallback)) {}') &&
    mb.includes('sk_sp<SkFontMgr> fPrimary;') && mb.includes('sk_sp<SkFontMgr> fFallback;'));

  // (2) Exactly ONE query crosses to the fallback tier UNCONDITIONALLY: the per-character
  // one. Skia's GDI port answers that with nullptr for every code point, so it is not a
  // preference, it is the only way a run whose face lacks a glyph can render at all.
  const charSig = 'sk_sp<SkTypeface> onMatchFamilyStyleCharacter(const char familyName[], const SkFontStyle& style,';
  const charBody = ovBody(charSig);
  check('the character query is the only unconditional cross to the fallback tier',
    charBody !== '' &&
    (charBody.match(/fFallback->/g) ?? []).length === 1 &&
    charBody.includes('fFallback->matchFamilyStyleCharacter(familyName, style, bcp47, bcp47Count, character);'));
  check('...and only after the primary tier declines (primary first, then fallback)',
    charBody.includes('if (auto tf = fPrimary->matchFamilyStyleCharacter(familyName, style, bcp47, bcp47Count,') &&
    charBody.includes('character)) {') && charBody.includes('return tf;') &&
    charBody.indexOf('fPrimary->') < charBody.indexOf('fFallback->'));

  // (2b) The NAME queries additionally cross over, but only as a last resort and only
  // through the localized-name translator: GDI's family table matches the English face
  // name and merely REPORTS the localized one, so a zh-CN skin's 微软雅黑 was unmatched and
  // fell to GDI's default -- a monospace face, i.e. every such field read like a
  // typewriter (adl 51.4.1 + temp/fontprobe: AIR 120/30/110 for 微软雅黑). DirectWrite does
  // index localized names, but its metrics are unhinted (122.109/31.934/112.441 for the
  // same probe), so it is a NAME TRANSLATOR: its English family name is handed back to
  // GDI, and the DWrite face is used only when GDI cannot name any translation.
  const styleBody = ovBody('sk_sp<SkTypeface> onMatchFamilyStyle(const char familyName[],');
  const famBody = ovBody('sk_sp<SkFontStyleSet> onMatchFamily(const char familyName[]) const override {');
  check('a name query asks the primary tier first, so every face that resolves today is unchanged',
    // onMatchFamilyStyle delegates to matchAir, which opens with the GDI query; a
    // style-set query asks GDI before it considers a translation.
    styleBody.includes('return this->matchAir(familyName, style);') &&
    mb.includes('if (sk_sp<SkTypeface> g = fPrimary->matchFamilyStyle(familyName, style)) return g;') &&
    famBody.indexOf('fPrimary->') < famBody.indexOf('airFamilyNames('));
  check('both name queries go through the localized-name translator',
    famBody.includes('airFamilyNames(familyName, alt)') && styleBody.includes('matchAir(familyName, style)') &&
    mb.includes('int airFamilyNames(const char* familyName, SkString out[2]) const {'));
  check('a DirectWrite face is taken only after GDI misses every translated spelling',
    mb.includes('int n = this->airFamilyNames(familyName, alt);') &&
    mb.includes('if (fFallback != nullptr) return fFallback->matchFamilyStyle(familyName, style);') &&
    mb.includes('if (fb && fb->count() > 0) return fb;'));

  // (3) The remaining overrides -- everything that is not a name query or the character
  // query -- still goes to the primary untouched, so no family that resolves today can
  // change face.
  const primarySigs: string[] = [
    'int onCountFamilies() const override {',
    'void onGetFamilyName(int index, SkString* familyName) const override {',
    'sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {',
    'sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data, int ttcIndex) const override {',
    'sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,',
    'sk_sp<SkTypeface> onMakeFromStreamArgs(std::unique_ptr<SkStreamAsset> stream,',
    'sk_sp<SkTypeface> onMakeFromFile(const char path[], int ttcIndex) const override {',
    'sk_sp<SkTypeface> onLegacyMakeTypeface(const char familyName[],',
  ];
  check('the 8 untouched queries delegate to the primary tier as before',
    primarySigs.every((s) => ovBody(s).includes('fPrimary->')) &&
    primarySigs.every((s) => !ovBody(s).includes('fFallback')));

  // (4) On Windows the two tiers are GDI (naming) + DirectWrite (character fallback),
  // and a machine where either factory fails still gets the old single-tier manager
  // rather than a null manager.
  const fac = glue.slice(cls, glue.indexOf('#else\nstatic sk_sp<SkFontMgr> sk_platform_fontmgr()'));
  check('the Windows factory builds GDI + DirectWrite and degrades to GDI alone',
    fac.includes('sk_sp<SkFontMgr> gdi = SkFontMgr_New_GDI();') &&
    fac.includes('sk_sp<SkFontMgr> dw = SkFontMgr_New_DirectWrite();') &&
    fac.includes('if (!gdi || !dw) return gdi ? gdi : dw;') &&
    fac.includes('return sk_sp<SkFontMgr>(new SkAirFontMgr(std::move(gdi), std::move(dw)));') &&
    fac.includes('static sk_sp<SkFontMgr> cached = []() -> sk_sp<SkFontMgr> {'));
  // The rejected approach must not creep back: an ordered manager would hand the
  // structured family/style queries to DirectWrite too.
  check('the ordered-manager approach is not used',
    !glue.includes('SkOrderedFontMgr') && !raw.includes('SkOrderedFontMgr.h'));

  // (5) Windows-only: the macOS branch stays the cached CoreText manager.
  const apple = glue.slice(glue.indexOf('#else\nsk_sp<SkFontMgr> sk_platform_fontmgr()'));
  check('the two-tier manager is Windows-only; macOS keeps CoreText',
    win > glue.indexOf('#ifdef __EMSCRIPTEN__') && cls > win &&
    apple.startsWith('#else\nsk_sp<SkFontMgr> sk_platform_fontmgr() {\n  static sk_sp<SkFontMgr> cached = SkFontMgr_New_CoreText(nullptr);\n  return cached;\n}') &&
    !apple.slice(0, 400).includes('SkAirFontMgr'));

  // (6) The rationale has to stay written down next to the class: WHY GDI alone cannot
  // render the field, why the fallback is confined to the character query, and that
  // DirectWrite costs no link dependency (Skia reaches it through LoadLibraryW).
  check('the rationale is documented next to the class',
    raw.includes('onMatchFamilyStyleCharacter to an unconditional') &&
    raw.includes('SkFontHost_win.cpp') && raw.includes('.notdef') &&
    // the diagnosis line and the measurement line are separate evidence, so pin both
    raw.includes('"微软雅黑", which an en-US UI locale exposes only as') &&
    raw.includes('the 微软雅黑 row and the') &&
    raw.includes('MapCharacters') &&
    raw.includes('LoadLibraryW("dwrite.dll")') && raw.includes('SkDWrite.cpp') &&
    raw.includes('this adds no link dependency to any manifest'));

  // (7) Both doc mirrors carry the finding.
  const zh = readFileSync(join(root, 'docs', 'zh-cn', 'skia.md'), 'utf8');
  const en = readFileSync(join(root, 'docs', 'en', 'skia.md'), 'utf8');
  check('the Windows fallback tier is documented in skia.md (zh + en)',
    zh.includes('SkAirFontMgr') && zh.includes('Microsoft YaHei') && en.includes('SkAirFontMgr')
    && en.includes('Microsoft YaHei'));
  check('...and so is the localized-name translation and the Times default (zh + en)',
    zh.includes('名字翻译器') && zh.includes('Times') && en.includes('name translator') && en.includes('Times'));

  // (8) The OTHER half of the same Windows defect (stage 212): the localized name must
  // be translated, and an uninstalled family must land on AIR's default tier.
  // SkParagraph resolves a TextStyle's family through onMatchFamily (style set +
  // matchStyle), NOT through onMatchFamilyStyle, so a translator wired into only the
  // latter is invisible to every paragraph -- the first attempt measured DirectWrite's
  // 122.109/31.934/112.441 for 微软雅黑 and 60/60/60 for 微软雅黑 Light (adl: 120/30/110).
  check('a "<family> <style word>" name translates the base and re-appends the style',
    mb.includes('if (sp == nullptr || sp[1] == 0 || !isStyleWord(sp + 1)) return 0;') &&
    mb.includes('out[0] = en;') && mb.includes('out[0].append(" ");') &&
    // 微软雅黑 Light is NOT a DirectWrite family: the base is translated, the style word
    // re-appended, and the bare base kept as the last spelling to try.
    mb.includes('out[1] = en;'));
  check('an uninstalled family resolves to AIR\'s Windows default (Times), not the platform default',
    /if \(mgr && !mgr->matchFamilyStyle\(family, SkFontStyle\(\)\)\) \{\s*#if defined\(_WIN32\)[\s\S]{0,900}?resolved = "Times";/.test(glue));
  check('...while macOS keeps asking CoreText for its own default face',
    /#if defined\(_WIN32\)[\s\S]{0,1600}?#else[\s\S]{0,700}?mgr->matchFamilyStyle\(nullptr, SkFontStyle\(\)\)/.test(glue));

  console.log(`     [font-fallback] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/FontFallback', checkFontFallback);

// ---- NativeWindow minSize/maxSize, startMove/startResize, listOwnedWindows and the
// ---- per-frame event poll (阶段一百九十六) ----
// Four measured facts drive every pin below, and each one is in a place a reader
// would not look for it:
//
//  (1) The limits are a property of the OS WINDOW, not of the AS3 wrapper: a
//      startResize drag has to respect them, so they live in the glue's WinCtx and
//      the getters read the SAME storage. A wrapper-side copy reads back right and
//      lets the user drag the window out of range.
//  (2) `minSize` clamping is against the PLATFORM floor and the CURRENT OPPOSITE
//      limit, not against the requested pair: adl 51.4.1 answers minSize=(0,0) ->
//      (2,32), minSize=(100,10) -> (100,32) on macOS (temp/nwmac/limits-out.txt), and
//      setting min=(2000,2000) after max=(1000,800) leaves BOTH at (1000,800).
//  (3) The bounds events are dispatched ONCE PER FRAME from a snapshot, not inline
//      from each setter, and both events of one frame take their `before` from the
//      state the frame STARTED in. Measured: a change that moves and resizes at once
//      answers RESIZE(100,100 300x200->200,200 500x400) | MOVE(...same pair...)
//      (temp/nwmac/ev-out-adl.txt t2) -- a before taken from the half-updated
//      snapshot would answer the move's before as "200,200 300x200".
//  (4) A user close is a REQUEST answered with a cancelable Event.CLOSING, so the
//      glue must not tear the window down in its own event handler.
function checkNativeWindowLimitsAndEvents(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-limits] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-limits] ${label}`); }
  };

  // 本仓库的 .cc 是 CRLF 检出（.gitattributes 只钉了 *.bat），正则里只要跨行就必须
  // 先归一化换行 —— 下面有一半的钉子都是跨行的。
  const glueWin = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  const glueWeb = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  // These two symbols are emitted by the AS3 side of the window table, so they are
  // matched in the generated C rather than in the emitter source.
  const exSrc = readFileSync(join(dir, 'native-window.as'), 'utf8');
  const c = generateC(parse(exSrc)).c;
  const preamble = RUNTIME_PREAMBLE;

  // (1) One storage for the limits, in the glue, read back by the getters.
  check('the limits live in the window context, not in the wrapper',
    /int min_w, min_h, max_w, max_h;/.test(glueWin)
    && /void sk_window_get_limits\(int id, int\* mnw[^)]*\) \{\n  WinCtx\* c = sk_slot\(id\);\n  if \(mnw\) \*mnw = \(c != NULL\) \? c->min_w : 0;/.test(glueWin)
    && /void sk_window_set_limits\(int id, int mnw, int mnh, int mxw, int mxh\) \{\n  WinCtx\* c = sk_slot\(id\);\n  if \(c == NULL\) return;\n  c->min_w = mnw;/.test(glueWin));
  // ...and the drag really enforces them on the frame, flipping the origin when the
  // dragged edge is the moving one.
  check('a startResize drag is bounded by the frame limits',
    /if \(c->min_w > 0 && nw < c->min_w\) \{\n    if \(c->sys_l\) nx -= \(c->min_w - nw\);\n    nw = c->min_w;/.test(glueWin)
    && /if \(c->max_h > 0 && nh > c->max_h\) \{/.test(glueWin));
  check('...and the opposite edge stays put while the dragged one clamps',
    /if \(c->sys_t\) ny -= \(c->min_h - nh\);/.test(glueWin));

  // (2) AIR's own defaults/floor, per platform, with the unverifiable Windows floor
  // spelled out as an assumption rather than derived.
  check('the default limits are AIR\'s numbers, per platform (macOS 78x32 measured)',
    /#ifdef _WIN32\n  if \(mnw\) \*mnw = 136; if \(mnh\) \*mnh = 39;\n#else\n  if \(mnw\) \*mnw = 78; if \(mnh\) \*mnh = 32;\n#endif/.test(glueWin)
    && /if \(mxw\) \*mxw = 107374182; if \(mxh\) \*mxh = 107374182;/.test(glueWin));
  check('the floor (what minSize=(0,0) reads back as) is the OS content minimum',
    /#ifdef _WIN32\n  if \(fw\) \*fw = 136; if \(fh\) \*fh = 39;\n#else\n  if \(fw\) \*fw = 2; if \(fh\) \*fh = 32;/.test(glueWin));
  check('both columns say they are measured, not assumed',
    /The Windows column is measured as well/.test(glueWin)
    && /\(100,10\) reads back \(136,39\)/.test(glueWin));

  // (2b) A fixed window has to stay MAXIMIZABLE, which is not the same thing as being
  // resizable: SDL's win32 backend refuses to maximize a window without
  // SDL_WINDOW_RESIZABLE (WIN_MaximizeWindow is guarded by it) while Cocoa's zoom:
  // is not, so our Windows build silently did nothing where macOS worked -- and AIR
  // does maximize such a window (adl on Windows answers displayState=maximized,
  // 2576x1723, for a <resizable>false</resizable> descriptor). The flag is lent for
  // the duration of the call and taken back, never left on.
  check('maximize() lends the RESIZABLE flag on Windows, around the call only',
    /#ifdef _WIN32\n  int was = \(SDL_GetWindowFlags\(c->win\) & SDL_WINDOW_RESIZABLE\) != 0;\n  if \(!was\) SDL_SetWindowResizable\(c->win, SDL_TRUE\);\n  sk_win_apply_style\(c\);\n  SDL_MaximizeWindow\(c->win\);\n  if \(!was\) SDL_SetWindowResizable\(c->win, SDL_FALSE\);\n  sk_win_apply_style\(c\);\n#else\n  SDL_MaximizeWindow\(c->win\);\n#endif/.test(glueWin)
    // The style is re-derived BEFORE the call and again after the un-lend: SDL's
    // WIN_SetWindowResizable puts WS_MAXIMIZEBOX back, and that bit (not <resizable>)
    // is what decides whether the maximized frame is the work area or the whole monitor.
    && glueWin.indexOf('sk_win_apply_style(c);\n  SDL_MaximizeWindow(c->win);') > 0);
  check('...and every other platform keeps the bare call (macOS is not touched)',
    /#else\n  SDL_MaximizeWindow\(c->win\);\n#endif\n\}/.test(glueWin));

  // (2c) A child window that ASKED for resizable=true must get it, even in a build
  // whose descriptor turned ASC_WINDOW_FIXED on for everybody: that define is
  // build-wide, the descriptor element is about the main window alone.
  check("a child window's own resizable request decides its style",
    /int id = sk_open_window\(w, h, title, decorated, 0, 0, highdpi, 0, resizable, maximizable, minimizable\);/.test(glueWin)
    && /c->resizable = resizable \? 1 : 0;\n  c->maximizable = maximizable \? 1 : 0;\n  c->minimizable = minimizable \? 1 : 0;\n  sk_win_apply_style\(c\);/.test(glueWin)
    // The build-wide define's ONLY remaining consumer is the first window's macro trio:
    // reading it inside sk_open_window/sk_window_create is what made every program-made
    // window fixed, and a runtime flip cannot repair it (WIN_SetWindowResizable leaves the
    // non-client area stale).
    && /#ifdef ASC_WINDOW_FIXED\n#define SK_MAIN_RESIZABLE 0\n#else\n#define SK_MAIN_RESIZABLE 1\n#endif/.test(glueWin)
    && (glueWin.match(/#ifdef ASC_WINDOW_FIXED/g) || []).length === 1);
  check('an app that never chose a maximum does not install AIR\'s own unbounded one on SDL',
    /if \(mxw > 0 && mxw < SK_LIMIT_UNBOUNDED && mxh > 0 && mxh < SK_LIMIT_UNBOUNDED\) \{/.test(glueWin)
    && /SDL_SetWindowMaximumSize\(c->win, 0, 0\);/.test(glueWin));

  // (3) startMove/startResize are real system drags that refuse the non-draggable
  // cases, and an unknown edge refuses instead of guessing.
  check('startMove refuses a window with no frame to drag (maximized/minimized)',
    /int sk_window_start_move\(int id\) \{[\s\S]{0,220}if \(flags & \(SDL_WINDOW_MAXIMIZED \| SDL_WINDOW_MINIMIZED\)\) return 0;/.test(glueWin));
  check('startResize refuses a non-resizable window and an unknown edge',
    /if \(!\(SDL_GetWindowFlags\(c->win\) & SDL_WINDOW_RESIZABLE\)\) return 0;/.test(glueWin)
    && /else return 0;   \/\/ unknown edge: refuse rather than guess/.test(glueWin));
  check('...and both begin a drag the pointer drives, latched until the button comes up',
    /sk_sys_drag_begin\(c, 1, 0, 0, 0, 0\);/.test(glueWin)
    && /sk_sys_drag_begin\(c, 2, t, b, l, r\);/.test(glueWin)
    && /case SDL_MOUSEBUTTONUP:[\s\S]{0,400}c->sys_drag = 0;/.test(glueWin));
  check('the drag tracks the pointer against its START snapshot (no per-event drift)',
    /int dx = gx - c->sys_gx;/.test(glueWin)
    && /SDL_SetWindowPosition\(c->win, c->sys_x \+ dx \+ c->b_left, c->sys_y \+ dy \+ c->b_top\);/.test(glueWin));

  // (4) A user close is a request the AS3 side answers with CLOSING.
  check('a window-manager close is a REQUEST, not an inline teardown',
    /c->close_request = 1;/.test(glueWin)
    && /int sk_window_take_close_request\(int id\) \{[\s\S]{0,200}c->close_request = 0;/.test(glueWin));
  check('...and the poll answers it with a cancelable CLOSING before closing',
    /if \(as_window_take_close_request\(id\)\) \{\n\s*if \(ASC_win_fire\(id, \(char\*\)"closing", true\)\) as_window_close\(id\);/.test(c));

  // The per-frame poll: all windows, once per application frame, from one snapshot.
  check('every open window is polled once per application frame (not just the clock window)',
    /for \(i = 0; i < ASC_MAX_WINDOWS; i\+\+\) ASC_win_poll\(i\);/.test(c));
  check('the poll bails out of a closed or stage-less window',
    /static void ASC_win_poll\(int id\) \{\n  ASCWin\* w = ASC_w\(id\);\n  if \(w == NULL \|\| w->closed \|\| w->stage == NULL\) return;/.test(c));
  check('both bounds events take their before from the FRAME-START snapshot',
    /int fx = w->snap_x, fy = w->snap_y, fw = w->snap_w, fh = w->snap_h;/.test(c)
    && (c.match(/Rectangle\* before = Rectangle_new\(\(double\)fx, \(double\)fy, \(double\)fw, \(double\)fh\);/g) || []).length === 2);
  check('...and the dispatch order is deactivate, resize, displayStateChange, move, activate',
    (() => {
      const at = (needle: string): number => c.indexOf(needle);
      const ds = at('ASC_win_fire(id, (char*)"deactivate", false);');
      const rs = at('ASC_win_fire_bounds(id, (char*)"resize", before, after);');
      const st = at('ASC_win_fire_ds(id, before, after);');
      const mv = at('ASC_win_fire_bounds(id, (char*)"move", before, after);');
      const ac = at('ASC_win_fire(id, (char*)"activate", false);');
      return ds > 0 && ds < rs && rs < st && st < mv && mv < ac;
    })());
  check('the two carrying events are AIR\'s own classes, not a bare Event',
    /NativeWindowBoundsEvent_new\(\(char\*\)type, false, false, before, after\)/.test(c)
    && /NativeWindowDisplayStateEvent_new\(\(char\*\)"displayStateChange", false, false, before, after\)/.test(c));
  check('a minimize is reported as DEACTIVATE before the display-state change',
    /if \(ds == 1 && w->snap_ds != 1 && w->snap_active\) \{ w->snap_active = 0; ASC_win_fire\(id, \(char\*\)"deactivate", false\); \}/.test(c));
  check('ACTIVATE is the raw 0->1 focus transition (a stale flag cannot undo the inferred deactivate)',
    /if \(!w->snap_raw_active && active\) \{\n    w->snap_active = 1;\n    ASC_win_fire\(id, \(char\*\)"activate", false\);/.test(c));
  check('the display-state string is rewritten through the write barrier',
    /ASCWin_displayState_set|as_win_set_display_state/.test(c) || /gc_write_barrier_value/.test(c));

  // minSize/maxSize getters/setters: the getter allocates (adl: `w.minSize === w.minSize`
  // is false) and the setter clamps against the floor and the current opposite limit.
  check('the minSize getter allocates a fresh Point (adl: identity is false)',
    /static Point\* NativeWindow_get_minSize\(void\* _this\)/.test(c)
    && /Point_new\(/.test(c));
  check('the minSize setter clamps to [platform floor, current maxSize]',
    /as_window_limits_floor\(&fw, &fh\);/.test(c)
    && /as_window_get_limits\(/.test(c)
    && /as_window_set_limits\(/.test(c));
  check('listOwnedWindows walks the live window table and filters by owner',
    /static as_vector_NativeWindow\* as_win_owned_windows\(int id\) \{/.test(c)
    && /as_vector_NativeWindow\* a = as_vector_NativeWindow_new\(\);/.test(c)
    && /if \(w->owner != me->window\) continue;/.test(c));

  // The AS3-facing seam: real backend, headless fallback, and the web stub -- all
  // three have to exist or the backend-less builds stop linking.
  check('the runtime declares the new glue externs',
    /sk_window_get_limits\(int id, int\* mnw/.test(preamble)
    && /sk_window_start_resize\(int id, const char\* edge\)/.test(preamble));
  check('...and the headless branch stubs the whole set (link cleanliness)',
    /static inline void as_window_limits_default\(int\* mnw, int\* mnh, int\* mxw, int\* mxh\) \{\n\s*if \(mnw\) \*mnw = 0;/.test(preamble)
    && /static inline int as_window_start_resize\(int id, const char\* edge\) \{ \(void\)id; \(void\)edge; return 0; \}/.test(preamble));
  check('the web glue stubs the same set so the same C links there',
    ['sk_window_get_limits', 'sk_window_set_limits', 'sk_window_limits_floor',
     'sk_window_limits_default', 'sk_window_start_move', 'sk_window_start_resize',
     'sk_window_take_close_request'].every((f) => new RegExp(`\\n(?:void|int) ${f}\\(`).test(glueWeb)));
  check('...including the one the web glue had been missing all along (get_borders)',
    /void sk_window_get_borders\(int id, int\* top/.test(glueWeb));

  // The platform facts the static fields answer with come from the same place the
  // rest of the class does, not from a bare `false` literal.
  check('supportsMenu/supportsNotification are platform macros, not literals',
    /#define ASC_NW_SUPPORTS_MENU true/.test(preamble)
    && /ASC_NW_SUPPORTS_MENU false/.test(preamble));

  // The example that exercises all of this is windowed (it never returns on its own
  // until nativeApplication.exit()), so it cannot be part of the run suite -- but it
  // must still be the file the pins above are read from, and it must compile.
  check('the example compiles and carries its measured expectations',
    c.includes('NativeWindow_listOwnedWindows')
    && /RESIZE\(100,100 300x200->200,200 500x400\) \| MOVE\(100,100 300x200->200,200 500x400\)/.test(exSrc));

  console.log(`     [win-limits] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/WindowLimitsAndEvents', checkNativeWindowLimitsAndEvents);

// ---- the app's OWN initial window: the descriptor describes THAT window only ----
//
// 阶段二百零五. AIR's `<initialWindow>` is the FIRST window's description, not a
// build-wide policy, and the two halves have to be held apart in code:
//
//   * `stage.nativeWindow` under a strict descriptor reads back false/false/false with
//     minSize (300,500) / maxSize (800,900) and bounds 50,60,366,630 (measured on adl
//     51.4.1, temp/nwwin/out-w-strict.txt), while a plain `new NativeWindow(new
//     NativeWindowInitOptions())` in the SAME process still answers
//     resizable/maximizable/minimizable all true with minSize (136,39) -- nothing from
//     the descriptor reaches it;
//   * our build had folded the descriptor into ONE build-wide define
//     (`ASC_WINDOW_FIXED`), which `sk_open_window` consulted for every window, so every
//     program-made window came out fixed too -- and SDL's win32 backend then refused to
//     maximize them (WIN_MaximizeWindow is gated on SDL_WINDOW_RESIZABLE), which is why
//     a Windows build silently ignored `maximize()` where macOS worked.
//
// So the descriptor now travels as per-window create-time values (plus defines for the
// two translation units that have to agree about the FIRST window), and the pins below
// check both directions: what reaches the main window, and what may NOT read those
// defines. Two traps recorded here because neither is visible from the platform this
// kit was written on (Windows): the Metal show path is compiled only on macOS
// (`#ifdef ASC_RENDER_METAL`), so a stale `sk_open_window` call site there is a CI-only
// failure -- hence the call-site arity audit; and a `static` forward declaration of
// `sk_window_set_limits` silently internalises its definition, which nothing but a real
// link reports.
function checkInitialWindowStyle(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [init-win] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [init-win] ${label}`); }
  };

  const glueWin = readFileSync(join(root, 'vendor', 'window_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  const glueWeb = readFileSync(join(root, 'vendor', 'web_glue.cc'), 'utf8').replace(/\r\n/g, '\n');
  const preamble = RUNTIME_PREAMBLE;
  const c = generateC(parse(readFileSync(join(dir, 'native-window.as'), 'utf8'))).c;

  // The descriptors are inlined (a `temp/` fixture would not exist on CI).
  const strict = parseAirApp(
    '<application xmlns="http://ns.adobe.com/air/application/51.3"><id>t</id>' +
    '<versionNumber>1.0</versionNumber><filename>t</filename><initialWindow>' +
    '<content>t.swf</content><visible>true</visible><systemChrome>standard</systemChrome>' +
    '<transparent>false</transparent><maximizable>false</maximizable><minimizable>false</minimizable>' +
    '<resizable>false</resizable><x>50</x><y>60</y><width>366</width><height>630</height>' +
    '<minSize>300 500</minSize><maxSize>800 900</maxSize></initialWindow></application>').style;
  // ...and the same descriptor with every optional element left out, which is the
  // shape the host app's application.xml has: <x>/<y>/<minSize>/<maxSize> absent must
  // mean "undefined", not "null that the helper trips over" (that crash shipped: the
  // helper guarded on `undefined` while childText answers null, so a descriptor without
  // <x> took the whole --air-app build down with a TypeError).
  const plain = parseAirApp(
    '<application xmlns="http://ns.adobe.com/air/application/51.3"><id>t</id>' +
    '<versionNumber>1.0</versionNumber><filename>t</filename><initialWindow>' +
    '<content>t.swf</content><visible>true</visible>' +
    '<width>300</width><height>200</height></initialWindow></application>').style;

  check('the descriptor names all three style flags',
    strict.maximizable === false && strict.minimizable === false);
  check('a descriptor that omits them keeps AIR\'s defaults',
    plain.maximizable === true && plain.minimizable === true && plain.systemChrome === 'standard');
  check('an absent optional element is undefined, not a null the helper trips over',
    plain.x === undefined && plain.y === undefined && plain.minSize === undefined && plain.maxSize === undefined);
  check('<x>/<y> are xs:int and reach the style (a negative coordinate is legal)',
    strict.x === 50 && strict.y === 60
    && parseAirApp('<?xml version="1.0"?><application xmlns="http://ns.adobe.com/air/application/51.3">' +
      '<id>t</id><versionNumber>1.0</versionNumber><filename>t</filename><initialWindow>' +
      '<content>t.swf</content><visible>true</visible><x>-10</x><y>0</y><width>300</width>' +
      '<height>200</height></initialWindow></application>').style.x === -10);
  check('<minSize>/<maxSize> are the BoundsSizeType pairs, both axes required',
    strict.minSize!.w === 300 && strict.minSize!.h === 500
    && strict.maxSize!.w === 800 && strict.maxSize!.h === 900);
  // <transparent>: AIR's own descriptor key. Measured on adl 51.4.1 (temp/transprobe/):
  // with it on, the window image is alpha 0 wherever the display list painted nothing,
  // while stage.color still answers 0xFFFFFFFF — the stage background is not filled.
  check('<transparent> reaches the style, and an absent one defaults to false',
    strict.transparent === false && plain.transparent === false
    && parseAirApp('<?xml version="1.0"?><application xmlns="http://ns.adobe.com/air/application/51.3">' +
      '<id>t</id><versionNumber>1.0</versionNumber><filename>t</filename><initialWindow>' +
      '<content>t.swf</content><visible>true</visible><transparent>true</transparent>' +
      '<width>300</width><height>200</height></initialWindow></application>').style.transparent === true);
  check('a <minSize> that is not two integers is an error, not a silent default',
    (() => {
      try {
        parseAirApp('<?xml version="1.0"?><application xmlns="http://ns.adobe.com/air/application/51.3">' +
          '<id>t</id><versionNumber>1.0</versionNumber><filename>t</filename><initialWindow>' +
          '<content>t.swf</content><visible>true</visible><minSize>300</minSize>' +
          '<width>300</width><height>200</height></initialWindow></application>');
        return false;
      } catch (e) { return /two unsigned integers/.test((e as Error).message); }
    })());

  // The descriptor -> build defines half. Both translation units need the values: the
  // glue puts them on the real window, the generated C mirrors them for the getters.
  const man = (st: unknown): Record<string, unknown> => airManifest('vendor', true, true, true, false, 'auto',
    false, true, [], [], [], [], true, false, '64', [], st as never) as Record<string, unknown>;
  check('airManifest carries the descriptor into the build defines',
    (() => {
      const d = man(strict)['defines'] as string[];
      return ['ASC_WINDOW_NOT_MAXIMIZABLE=1', 'ASC_WINDOW_NOT_MINIMIZABLE=1', 'ASC_WIN_X=50', 'ASC_WIN_Y=60',
        'ASC_WIN_MIN_W=300', 'ASC_WIN_MIN_H=500', 'ASC_WIN_MAX_W=800', 'ASC_WIN_MAX_H=900'].every((x) => d.includes(x));
    })());
  check('...while a default descriptor invents none of them (the windows are not fixed)',
    (() => {
      const d = man(plain)['defines'] as string[];
      return !d.some((x) => /^ASC_WIN_|^ASC_WINDOW_NOT/.test(x));
    })());
  // <transparent> is the one style flag whose meaning does not live only in the glue:
  // the compose step has to clear to alpha 0 as well, or an opaque black clear would
  // paint every unpainted pixel (measured: adl leaves them at alpha 0).
  check('a transparent descriptor becomes ASC_WINDOW_TRANSPARENT=1',
    (() => {
      const on = man({ maximizable: true, minimizable: true, systemChrome: 'none', transparent: true })['defines'] as string[];
      const off = man(plain)['defines'] as string[];
      return on.includes('ASC_WINDOW_TRANSPARENT=1') && !off.includes('ASC_WINDOW_TRANSPARENT=1');
    })());

  // The glue half: one place applies AIR's frame style, read off the real window.
  check('the three SK_MAIN_ macros come from the three defines',
    /#ifdef ASC_WINDOW_FIXED\n#define SK_MAIN_RESIZABLE 0\n#else\n#define SK_MAIN_RESIZABLE 1\n#endif/.test(glueWin)
    && /#ifdef ASC_WINDOW_NOT_MAXIMIZABLE\n#define SK_MAIN_MAXIMIZABLE 0/.test(glueWin)
    && /#ifdef ASC_WINDOW_NOT_MINIMIZABLE\n#define SK_MAIN_MINIMIZABLE 0/.test(glueWin));
  check('resizable is a per-window create-time value, not the build-wide define',
    /if \(resizable\) winFlags \|= SDL_WINDOW_RESIZABLE;/.test(glueWin)
    && !/#ifndef ASC_WINDOW_FIXED[\s\S]{0,80}winFlags \|= SDL_WINDOW_RESIZABLE;/.test(glueWin));
  check('sk_win_apply_style is AIR\'s measured mapping (MAXIMIZEBOX decides the maximized rect)',
    /if \(c->resizable\) want \|= WS_THICKFRAME;\n  if \(c->maximizable\) want \|= WS_MAXIMIZEBOX;\n  if \(c->minimizable\) want \|= WS_MINIMIZEBOX;/.test(glueWin)
    && /SWP_NOMOVE \| SWP_NOSIZE \| SWP_NOZORDER \| SWP_NOACTIVATE \| SWP_FRAMECHANGED/.test(glueWin)
    && /if \(!c->decorated\) return;/.test(glueWin));
  check('...and it is a Windows-only override (every other platform keeps the bare call)',
    /static void sk_win_apply_style\(WinCtx\* c\) \{\n#ifdef _WIN32\n/.test(glueWin)
    && /#else\n  \(void\)c;\n#endif\n\}/.test(glueWin));
  // Transparency. SDL2 has no SDL_WINDOW_TRANSPARENT (that flag is SDL3's), so the
  // platform layer owns it; and the flag must reach BOTH halves — the NSWindow (else
  // the compositor still treats the client rect as filled) and the compose step (else
  // SDL's default opaque-black clear paints the transparent area black).
  check('transparency is applied to the native window, not just latched in AS3',
    /static void sk_window_apply_transparent\(SDL_Window\* win, int on\)/.test(glueWin)
    && /sel_registerName\("setOpaque:"\)/.test(glueWin)
    && /void sk_window_set_transparent\(int id, int on\) \{/.test(glueWin)
    && /#ifdef ASC_WINDOW_TRANSPARENT\n  if \(is_main\) transparent = 1;\n#endif/.test(glueWin));
  check('the transparent flag reaches the present step (an opaque clear would paint black)',
    /static void present_frame\(WinCtx\* c, void\* pixels, int w, int h, int rowBytes\)/.test(glueWin)
    && /if \(transparent\) SDL_SetRenderDrawColor\(ren, 0, 0, 0, 0\);/.test(glueWin)
    && (glueWin.match(/present_frame\(c, c->pixels, c->pw, c->ph, c->rowBytes\)/g) ?? []).length === 2);
  // A transparent window does not go through SDL's renderer at all. Measured on a real
  // machine: SDL's backing store is opaque and a bare 14-line SDL program reproduces it
  // on both the Metal and the OpenGL renderer (temp/transprobe/FINDINGS.md,
  // temp/sdltrans.cc), so the frame goes to a CALayer instead (temp/sdl_layer.cc).
  check('a transparent frame is presented through a CALayer, never SDL_RenderPresent',
    /if \(c->transparent\) \{ sk_mac_present_layer\(c, pixels, w, h, rowBytes\); return; \}/.test(glueWin)
    && /static void sk_mac_present_layer\(WinCtx\* c, void\* pixels, int w, int h, int rowBytes\);/.test(glueWin));
  // Layer-HOSTING (setLayer:) is the load-bearing bit: with a plain wantsLayer SDLView
  // keeps filling its backing store with opaque black every display pass.
  check('the content view is made layer-hosting so SDLView stops painting its opaque store',
    /SK_SET_BOOL\(view, "setWantsLayer:", 1\);/.test(glueWin)
    && /SK_SET_OBJ\(view, "setLayer:", container\);/.test(glueWin)
    && /if \(sv != NULL\) SK_SET_BOOL\(sv, "setHidden:", 1\);/.test(glueWin));
  // The surface's own channel order is R,G,B,A bytes on macOS Skia (see the masks in
  // sk_window_show), i.e. "alpha last" in RGB space -- NOT the BGRA-first layout that
  // looks like the same thing. Getting it wrong swaps red and blue.
  check('the frame is handed over as a premultiplied CGImage in the surface\'s own order',
    /kCGImageAlphaPremultipliedLast \| kCGBitmapByteOrderDefault/.test(glueWin)
    && /SK_SET_OBJ\(hl, "setContents:", \(void\*\)img\);/.test(glueWin)
    && /CGDataProviderCreateWithData\(NULL, copy, bytes, sk_cg_provider_release\)/.test(glueWin));
  check('ASC_WINDOW_VIBRANT puts an NSVisualEffectView under the frame (the 毛玻璃 divergence)',
    /#if defined\(ASC_WINDOW_VIBRANT\)\n#define SK_VIBRANT 1\n#else\n#define SK_VIBRANT 0\n#endif/.test(glueWin)
    && /SK_ALLOC\("NSVisualEffectView"\)/.test(glueWin)
    && /SK_SET_INT\(eff, "setMaterial:", 6\);/.test(glueWin)
    && /SK_SET_INT\(eff, "setBlendingMode:", 0\);/.test(glueWin)
    && /SK_SET_INT\(eff, "setState:", 1\);/.test(glueWin));
  // A selector literal without its trailing colon is an unrecognised-selector CRASH at
  // run time (-[SDLView setWantsLayer]), and it compiled cleanly twice while this block
  // was written -- the macros cannot catch it.
  check('every SK_SET_* selector literal carries its trailing colon',
    !/SK_SET_(?:BOOL|INT|DBL|OBJ)\([^,\n]+,\s*"set[A-Za-z]+"/.test(glueWin));
  check('a program-made window hands its own flag to the platform layer',
    c.includes('if (w->transparent) as_window_set_transparent(id, 1);'));
  check('the compose step clears to alpha 0 for a transparent window, not to the stage colour',
    c.includes('if (w->transparent) as_skia_canvas_clear_transparent(canvas);')
    && c.includes('else as_skia_canvas_clear(canvas, st->stage_color);'));

  check('sk_window_set_limits is declared NON-static (a static decl internalises the definition)',
    /\nvoid sk_window_set_limits\(int id, int mnw, int mnh, int mxw, int mxh\);\n/.test(glueWin)
    && !/\nstatic void sk_window_set_limits\(int id, int mnw, int mnh, int mxw, int mxh\);\n/.test(glueWin));
  // The Metal show path only exists on macOS, so this audit is what stands in for
  // compiling it here: the definition plus four call sites, of which the three main
  // paths must pass the macros and the `new NativeWindow()` path its own values.
  check('every sk_open_window call site passes the three flags (the macOS-only path included)',
    (() => {
      const callArgs = (src: string, name: string): string[][] => {
        const out: string[][] = [];
        let i = src.indexOf(name + '(');
        while (i >= 0) {
          let depth = 0, j = i + name.length, start = j + 1;
          const args: string[] = [];
          for (; j < src.length; j++) {
            const ch = src[j];
            if (ch === '(') { depth++; if (depth === 1) start = j + 1; }
            else if (ch === ')') { depth--; if (depth === 0) { args.push(src.slice(start, j).trim()); break; } }
            else if (ch === ',' && depth === 1) { args.push(src.slice(start, j).trim()); start = j + 1; }
          }
          out.push(args);
          i = src.indexOf(name + '(', j);
        }
        return out;
      };
      const calls = callArgs(glueWin, 'sk_open_window');
      if (calls.length !== 5) return false;
      const tail = (a: string[]): string =>
        a.slice(-3).map((x) => x.replace(/#[^\n]*\n/g, '').replace(/\s+/g, '')).join(',');
      const tails = calls.map(tail);
      const main3 = tails.slice(1).filter((t) => t === 'SK_MAIN_RESIZABLE,SK_MAIN_MAXIMIZABLE,SK_MAIN_MINIMIZABLE');
      const own3 = tails.slice(1).filter((t) => t === 'resizable,maximizable,minimizable');
      return tails[0] === 'intresizable,intmaximizable,intminimizable' && main3.length === 3 && own3.length === 1;
    })());
  check('the descriptor\'s limits are installed on the initial window only, clamped as the setter clamps',
    /#if defined\(ASC_WIN_MIN_W\) \|\| defined\(ASC_WIN_MAX_W\)\n  if \(is_main\) \{/.test(glueWin)
    && /if \(mnw < fw\) mnw = fw;/.test(glueWin) && /if \(mxw < mnw\) mxw = mnw;/.test(glueWin)
    && /sk_window_set_limits\(id, mnw, mnh, mxw, mxh\);/.test(glueWin));
  check('the descriptor\'s position is installed on the initial window only, in FRAME coordinates',
    /#if defined\(ASC_WIN_X\) \|\| defined\(ASC_WIN_Y\)\n  if \(is_main\) \{/.test(glueWin)
    && /px = ASC_WIN_X \+ c->b_left;/.test(glueWin) && /py = ASC_WIN_Y \+ c->b_top;/.test(glueWin));
  check('every frame->client conversion adds both borders (drag, bounds, position)',
    /SDL_SetWindowPosition\(c->win, c->sys_x \+ dx \+ c->b_left, c->sys_y \+ dy \+ c->b_top\);/.test(glueWin)
    && /SDL_SetWindowPosition\(c->win, x \+ c->b_left, y \+ c->b_top\);/.test(glueWin)
    && /SDL_GetWindowPosition\(c->win, &px, &py\);[\s\S]{0,700}if \(x\) \*x = px - c->b_left;/.test(glueWin));

  // The generated C half: the AS3 table mirrors the same values so the getters answer
  // what the window was built with, and the AS3 seed is applied only to slot 0.
  check('the emitted main-window mirror is seeded from the same defines',
    /static void ASC_win_seed_main\(ASCWin\* w\) \{\n  if \(w == NULL\) return;\n  #ifndef ASC_WINDOW_FIXED\n  w->resizable = 1;\n  #endif/.test(c)
    && /#ifndef ASC_WINDOW_NOT_MAXIMIZABLE\n  w->maximizable = 1;\n  #endif/.test(c)
    && /#ifndef ASC_WINDOW_NOT_MINIMIZABLE\n  w->minimizable = 1;\n  #endif/.test(c));
  check('...seeded exactly when the main slot is claimed (never for a program-made window)',
    /if \(ASC_wins\[0\]\.stage == NULL && ASC_wins\[0\]\.window == NULL\) \{\n    memset\(&ASC_wins\[0\], 0, sizeof\(ASCWin\)\);\n    ASC_win_seed_main\(&ASC_wins\[0\]\);/.test(c)
    && !/ASC_win_seed_main\(&ASC_wins\[1\]\)/.test(c));
  check('...and the seed clamps like the minSize setter so both orders converge',
    /ASC_win_limits_init\(0\);/.test(c) && /as_window_limits_floor\(&fw, &fh\);/.test(c)
    && /if \(w->max_w < w->min_w\) w->max_w = w->min_w;/.test(c));
  check('a program-made window passes its OWN flags to the glue',
    /int decorated = 1, resizable = 1, maximizable = 1, minimizable = 1;/.test(c)
    && /as_window_create\(\(int\)cw, \(int\)ch, \(char\*\)"", resizable, maximizable, minimizable, decorated,/.test(c));
  check('the runtime seam, the headless stub and the web stub all track the new arity',
    /extern int sk_window_create\(int w, int h, const char\* title, int resizable, int maximizable, int minimizable,/.test(preamble)
    && (preamble.match(/static inline int as_window_create\(int w, int h, const char\* title, int resizable, int maximizable, int minimizable,/g) || []).length === 2
    && /\(void\)resizable; \(void\)maximizable; \(void\)minimizable;/.test(preamble)
    && (glueWeb.match(/\nint sk_window_create\(int w, int h, const char\* title, int resizable, int maximizable, int minimizable,/g) || []).length === 1);

  console.log(`     [init-win] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/InitialWindowStyle', checkInitialWindowStyle);
