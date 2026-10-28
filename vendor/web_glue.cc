// web_glue.cc — the C++ -> C bridge for the HTML5 <canvas> window backend.
//
// Where window_glue.cc drives an SDL2 window on desktop, this file drives an
// HTML5 <canvas> in the browser. It exposes the *same* flat extern "C" surface
// (sk_window_show / sk_window_probe_scale / sk_window_get_display_size /
// sk_window_get_display_refresh), so the generated .c stays byte-for-byte
// unchanged — only this glue layer and the build backend (emcc vs cc) differ
// between the native and web targets.
//
// Three replacements over the SDL2 backend:
//   - frame driver: requestAnimationFrame (emscripten_set_main_loop) instead of
//     the blocking SDL_PollEvent loop;
//   - pixel present: Skia raster pixels -> canvas ImageData via EM_ASM, instead
//     of an SDL streaming texture;
//   - input: Emscripten HTML5 pointer/wheel callbacks instead of SDL events.

#include <emscripten.h>
#include <emscripten/html5.h>
#include <cstdio>
#include <cstdint>

extern "C" {

int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes);
#ifdef ASC_RENDER_GPU
void sk_gr_flush(void);
#endif

// Window state shared by the frame loop and the input callbacks. The surface is
// never owned here (the AS3 side frees it after sk_window_show returns, which on
// web never happens — the main loop runs forever).
static void* g_surface = nullptr;
static int g_pw = 0, g_ph = 0;
// Unlike window_glue.cc there is no window registry: a page owns exactly one
// canvas, so the window id is always 0. The signatures still carry it so the
// generated C is byte-for-byte identical across the two window backends.
static void (*g_on_mouse)(int, double, double, const char*) = nullptr;
static void (*g_on_wheel)(int, double, double, double) = nullptr;
static void (*g_on_redraw)(int) = nullptr;
static void (*g_on_frame)(int) = nullptr;
static double (*g_on_frame_delay)(int) = nullptr;

// Present the Skia surface to the canvas. Two backends, selected at compile
// time by <renderMode> (efficiency-first — not AIR's "direct = CPU compose +
// GPU blit" split):
//   - cpu/auto: Skia raster surface (CPU compose). Skia's kN32 premultiplied
//     bytes are laid out R,G,B,A on little-endian, exactly canvas ImageData's
//     RGBA layout, so each row copies 1:1 into an ImageData and putImageData
//     presents it.
//   - ASC_RENDER_GPU (direct/gpu): the surface is Ganesh-backed — Skia composed
//     the whole frame into the WebGL2 default framebuffer on the GPU. Present
//     is just a flush; there is no CPU pixel buffer to copy.
static void present_frame(void) {
#ifdef ASC_RENDER_GPU
  sk_gr_flush();
#else
  void* pixels = nullptr;
  int rowBytes = 0;
  if (g_surface == nullptr || !sk_surface_peek_pixels(g_surface, &pixels, &rowBytes)) return;
  int w = g_pw, h = g_ph;
  // Note: EM_ASM code must not contain a top-level comma (the C preprocessor
  // would split it as a macro argument) — hence one `var` per line.
  EM_ASM({
    var src = $0;
    var rowBytes = $1;
    var w = $2;
    var h = $3;
    var canvas = Module.canvas;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var heap = HEAPU8;
    for (var y = 0; y < h; y++) {
      var row = src + y * rowBytes;
      img.data.set(heap.subarray(row, row + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
  }, (intptr_t)pixels, rowBytes, w, h);
#endif
}

// Display-refresh estimate from the rAF grid.
//
// The browser calls main_loop once per display refresh, but exposes no API for
// that rate: sk_window_get_display_refresh() returns 0 on web (there is no
// browser analogue of SDL_GetDisplayMode), so on_frame_delay never learns the
// panel's period and the pacer has to infer it. The interval between two
// consecutive callbacks *is* the refresh period, because rAF fires on the
// compositor's vsync grid.
//
// Estimator: median of the last kRafRing intervals. A median (not a mean/EMA)
// is what makes this robust — a long callback (GC pause, first-frame font
// raster, tab switch, a dragged window) inflates one or two samples and cannot
// move the median, whereas an EMA would be dragged off for a second or more and
// mis-pick the divisor for that whole window.
static const int kRafRing = 16;
static double g_raf_ring[kRafRing];
static int g_raf_ring_n = 0;   // valid samples so far
static int g_raf_ring_i = 0;   // next write slot
static double g_raf_prev_ms = 0.0;

// Median interval between rAF callbacks, or 0.0 while still warming up.
static double raf_period_ms(void) {
  if (g_raf_ring_n == 0) return 0.0;
  double sorted[kRafRing];
  for (int i = 0; i < g_raf_ring_n; i++) sorted[i] = g_raf_ring[i];
  for (int i = 1; i < g_raf_ring_n; i++) {   // insertion sort, n <= 16
    double v = sorted[i];
    int j = i - 1;
    while (j >= 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j--; }
    sorted[j + 1] = v;
  }
  return sorted[g_raf_ring_n / 2];
}

// Counts rAF ticks since the last presented frame (see the pacer below).
static int g_tick = 0;

// Frame diagnostics — compile-time opt-in (`-D ASC_FRAME_STATS=1`), the web
// counterpart of runtime.ts's ASC_FRAME_STATS runtime probe. Publishes a
// per-second summary on window.__ascFrameStats so a harness can read the
// achieved cadence, the callback count, how many callbacks the pacer dropped
// and the time actually spent in on_frame + on_redraw + present. Compiled out
// entirely by default, so the shipped wasm carries no probe.
#ifdef ASC_FRAME_STATS
static double g_fs_t0 = 0.0;
static int g_fs_frames = 0;
static int g_fs_loopcalls = 0;
static int g_fs_skips = 0;
static double g_fs_render_ms = 0.0;
#endif

// One frame: advance the frame clock (ENTER_FRAME + timers), then re-rasterize
// (reflecting any listener-driven mutation) and present. requestAnimationFrame
// replaces SDL_PollEvent as the frame driver; the browser caps the cadence at
// the display refresh rate, so a very high Stage.frameRate simply saturates it.
static void main_loop(void) {
  double now = emscripten_get_now();

  // Update the refresh estimate from consecutive callback timestamps. Samples
  // outside 1..100 ms are implausible for a vsync grid (a 1000 Hz panel up to a
  // 10 Hz one) so they are dropped rather than polluting the window — this is
  // also what keeps a tab-switch stall (~seconds) out of the estimate.
  if (g_raf_prev_ms > 0.0) {
    double d = now - g_raf_prev_ms;
    if (d >= 1.0 && d <= 100.0) {
      g_raf_ring[g_raf_ring_i] = d;
      g_raf_ring_i = (g_raf_ring_i + 1) % kRafRing;
      if (g_raf_ring_n < kRafRing) g_raf_ring_n++;
    }
  }
  g_raf_prev_ms = now;

  double interval = g_on_frame_delay ? g_on_frame_delay(0) : 16.0;
#ifdef ASC_FRAME_STATS
  g_fs_loopcalls++;
#endif

  // Frame pacing on a vsync-driven loop.
  //
  // One rAF tick is one vsync, so the only clock the compositor honors is the
  // tick itself. Pace in *whole ticks*: render every `skip`-th callback, with
  // skip chosen so skip x refresh is as close as possible to the requested
  // interval (Stage.frameRate -> 1000/fr ms).
  //
  // Do NOT compare the requested interval against the raw callback timestamp
  // ("is now past the deadline?"). rAF timestamps jitter around the true vsync
  // — measured on this machine's 120 Hz panel: p50 8.30 ms, p95 9.30 ms for a
  // 8.333 ms period. With `next_tick = now + interval`, a callback landing a few
  // hundred microseconds early fails that test, so its tick is dropped and the
  // next one (a full vsync later) is taken; the loop then alternates drop/take
  // and delivers HALF the rate. Measured on the 120 Hz panel with
  // Stage.frameRate = 120: rAF fired 120x/s but the old pacer presented 66 fps,
  // discarding 55 callbacks/s.
  //
  // This mirrors the native SDL2 backend, whose present step is also vsync-bound
  // (see the comment there: "an explicit frameRate above the display refresh
  // rate is capped to that rate"). A target rate the panel cannot represent
  // (e.g. 24 fps on a 60 Hz panel, needing 2.5 vsyncs) rounds to the nearest
  // achievable divisor, so a request never lands more than half a vsync from its
  // target.
  int skip = 1;
  if (interval > 0.0) {
    double rp = raf_period_ms();
    if (rp > 0.0) {
      skip = (int)(interval / rp + 0.5);
      if (skip < 1) skip = 1;   // target above the refresh rate: every vsync
    }
  }
  if (g_tick >= skip) g_tick = 0;
  int render_now = (g_tick == 0);
  g_tick++;
  if (!render_now) {
#ifdef ASC_FRAME_STATS
    g_fs_skips++;
#endif
    return;
  }

#ifdef ASC_FRAME_STATS
  double t_frame0 = emscripten_get_now();
#endif
  if (g_on_frame) g_on_frame(0);
  if (g_on_redraw) g_on_redraw(0);
  present_frame();
#ifdef ASC_FRAME_STATS
  double t_frame1 = emscripten_get_now();
  g_fs_render_ms += (t_frame1 - t_frame0);
  g_fs_frames++;
  if (g_fs_t0 == 0.0) g_fs_t0 = t_frame1;
  if (t_frame1 - g_fs_t0 >= 1000.0) {
    EM_ASM({
      var p = {};
      p.frames = $0;
      p.loopcalls = $1;
      p.skips = $2;
      p.renderMs = $3;
      p.spanMs = $4;
      p.intervalMs = $5;
      p.rafPeriodMs = $6;
      p.skip = $7;
      p.fps = $0 / ($4 / 1000.0);
      window.__ascFrameStats = p;
      if (!window.__ascFrameStatsAll) window.__ascFrameStatsAll = [];
      window.__ascFrameStatsAll.push(p);
    }, g_fs_frames, g_fs_loopcalls, g_fs_skips, g_fs_render_ms, t_frame1 - g_fs_t0,
       interval, raf_period_ms(), skip);
    g_fs_frames = 0; g_fs_loopcalls = 0; g_fs_skips = 0;
    g_fs_render_ms = 0.0; g_fs_t0 = t_frame1;
  }
#endif
}

// Pointer input on the canvas: movement plus the left-button down/up/click gate.
// Coordinates are CSS pixels relative to the canvas, matching SDL2's logical
// window points (the AS3 side maps through align/scale).
static EM_BOOL on_mouse_evt(int eventType, const EmscriptenMouseEvent* e, void* ud) {
  (void)ud;
  if (g_on_mouse == nullptr) return EM_TRUE;
  // Right button (阶段二百八十九): the popup opens from rightMouseDown, exactly as on
  // the native backends. Unlike Cocoa the browser keeps delivering the matching up
  // event, so rightMouseUp/rightClick arrive immediately -- BEFORE the menu's
  // selection, because this backend cannot block (see sk_menu_popup).
  if (e->button == 2) {
    if (eventType == EMSCRIPTEN_EVENT_MOUSEDOWN) {
      g_on_mouse(0, (double)e->targetX, (double)e->targetY, "rightMouseDown");
    } else if (eventType == EMSCRIPTEN_EVENT_MOUSEUP) {
      g_on_mouse(0, (double)e->targetX, (double)e->targetY, "rightMouseUp");
      g_on_mouse(0, (double)e->targetX, (double)e->targetY, "rightClick");
    }
    return EM_TRUE;
  }
  if (eventType == EMSCRIPTEN_EVENT_MOUSEDOWN && e->button == 0) {
    g_on_mouse(0, (double)e->targetX, (double)e->targetY, "mouseDown");
  } else if (eventType == EMSCRIPTEN_EVENT_MOUSEUP && e->button == 0) {
    g_on_mouse(0, (double)e->targetX, (double)e->targetY, "mouseUp");
    g_on_mouse(0, (double)e->targetX, (double)e->targetY, "click");
  } else if (eventType == EMSCRIPTEN_EVENT_MOUSEMOVE) {
    // Hover, dragging and text-selection all ride this one channel, exactly as
    // SDL_MOUSEMOTION does in window_glue.cc; without it the web backend has no
    // hover at all.
    g_on_mouse(0, (double)e->targetX, (double)e->targetY, "mouseMove");
  } else if (eventType == EMSCRIPTEN_EVENT_MOUSELEAVE) {
    // The pointer left the canvas: AIR rolls the window's roll-over state back to
    // its up/out state. The coordinates are deliberately 0,0 -- a leave carries
    // none, and AIR does NOT touch mouseX/mouseY on one, so the AS3 side keeps its
    // last in-window values and ignores these. Kept in step with window_glue.cc's
    // SDL_WINDOWEVENT_LEAVE block: same reserved "mouseLeave" type, same 0,0 (the
    // cursor reset and dirty flag there are SDL-only; on web CSS owns the cursor
    // and the rAF loop presents every frame).
    g_on_mouse(0, 0.0, 0.0, "mouseLeave");
  }
  return EM_TRUE;
}

// Wheel: the browser DOM WheelEvent uses deltaY > 0 = scrolling DOWN, which is
// the OPPOSITE of SDL_MOUSEWHEEL's e.wheel.y (positive = scrolling UP) that
// window_glue.cc forwards. Stage_dispatchWheel on the AS3 side treats delta as
// "positive = scrolling up" (scrollV -= delta), so we negate deltaY here to make
// the web backend match the native convention — otherwise scroll direction flips.
static EM_BOOL on_wheel_evt(int eventType, const EmscriptenWheelEvent* e, void* ud) {
  (void)eventType; (void)ud;
  if (g_on_wheel) g_on_wheel(0, (double)e->mouse.targetX, (double)e->mouse.targetY, -(double)e->deltaY);
  return EM_TRUE;
}

// Device pixel ratio backs AIR's <requestedDisplayResolution>high: the offscreen
// surface is sized in physical pixels so text stays crisp, mirroring the SDL2
// high-DPI probe. The browser's window.devicePixelRatio is the authoritative
// scale (the wasm analogue of SDL_GetWindowSizeInPixels).
double sk_window_probe_scale(int w, int h, int highdpi, int* pw, int* ph) {
  double dpr = EM_ASM_DOUBLE({
    return (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1.0;
  });
  double scale = highdpi ? dpr : 1.0;
  int dw = (int)((double)w * scale);
  int dh = (int)((double)h * scale);
  if (pw) *pw = dw;
  if (ph) *ph = dh;
  return scale;
}

// Primary display size in CSS pixels (Stage.fullScreenWidth/fullScreenHeight).
int sk_window_get_display_size(int* w, int* h) {
  int dw = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.width : 0; });
  int dh = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.height : 0; });
  if (w) *w = dw;
  if (h) *h = dh;
  return (dw > 0 && dh > 0) ? 1 : 0;
}

// The browser exposes no physical display refresh rate, so return 0 and let the
// frame pacer derive it itself: main_loop measures the rAF callback interval and
// paces in whole vsync ticks (see the pacer comment there). Returning a rate
// would not help — the AS3-side deadline pacer has no way to express "every Nth
// vsync", which is the only pacing a compositor honors.
double sk_window_get_display_refresh(int win) { (void)win; return 0.0; }

// ---------- display enumeration (flash.display.Screen) ----------
// A page sees exactly one display: the one its window is on. `bounds` stays the
// full screen (window.screen.width/height) so it keeps agreeing with
// Capabilities.screenResolutionX/Y, and `visibleBounds` uses the browser's own
// "available" rectangle, which already excludes the OS taskbar/dock — the same
// distinction AIR draws (measured on adl: bounds 0,0 1800x1169 vs visibleBounds
// 47,39 1753x1130). availLeft/availTop are non-standard but present in Chromium;
// where they are missing the origin falls back to 0.
int sk_display_count(void) {
  return EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? 1 : 0; });
}

int sk_display_bounds(int i, int* x, int* y, int* w, int* h) {
  if (i != 0) return 0;
  int dw = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.width : 0; });
  int dh = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.height : 0; });
  if (dw <= 0 || dh <= 0) return 0;
  if (x) *x = 0;
  if (y) *y = 0;
  if (w) *w = dw;
  if (h) *h = dh;
  return 1;
}

int sk_display_usable_bounds(int i, int* x, int* y, int* w, int* h) {
  if (i != 0) return 0;
  int ux = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen && typeof window.screen.availLeft === 'number') ? window.screen.availLeft : 0; });
  int uy = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen && typeof window.screen.availTop === 'number') ? window.screen.availTop : 0; });
  int uw = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.availWidth : 0; });
  int uh = EM_ASM_INT({ return (typeof window !== 'undefined' && window.screen) ? window.screen.availHeight : 0; });
  if (uw <= 0 || uh <= 0) return sk_display_bounds(i, x, y, w, h);
  if (x) *x = ux;
  if (y) *y = uy;
  if (w) *w = uw;
  if (h) *h = uh;
  return 1;
}

// Present the Skia raster surface in the canvas and run the rAF frame loop until
// the page is closed. Mirrors sk_window_show's signature in window_glue.cc so the
// generated C calls it identically. `w`/`h` are logical size (AIR <width>/<height>),
// `pw`/`ph` the physical pixel size of the surface (from sk_window_probe_scale).
int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,
                   int fullscreen, void (*on_mouse)(int, double, double, const char*),
                   void (*on_wheel)(int, double, double, double),
                   void (*on_key)(int, const char*, int, int, int),
                   void (*on_redraw)(int), void (*on_frame)(int),
                   double (*on_frame_delay)(int),
                   void* (*on_resize)(int, int, int, int, int, double),
                   void (*on_close)(int)) {
  (void)on_resize;  // resize not yet wired on web (fixed canvas for now)
  (void)on_close;   // a page has no window to close; the tab is the window
  // The keyboard transport is NOT wired on web yet: a page delivers keys through
  // DOM events on the canvas, whose keyCode/charCode are the browser's, not AIR's,
  // so they need their own translation table (and a focus model that follows the
  // DOM). Left unwired on purpose and recorded in TODO.md rather than faked —
  // silently dropping keys would be a silent capability gap.
  (void)on_key;
  g_surface = surface;
  g_pw = pw;
  g_ph = ph;
  g_on_mouse = on_mouse;
  g_on_wheel = on_wheel;
  g_on_redraw = on_redraw;
  g_on_frame = on_frame;
  g_on_frame_delay = on_frame_delay;

  // Size the canvas backing store to the physical pixels but its CSS box to the
  // logical size, so a high-DPI surface presents 1:1 without blur. Also set the
  // document title to the AIR window title.
  EM_ASM({
    var canvas = Module.canvas;
    canvas.width = $0;
    canvas.height = $1;
    canvas.style.width = $2 + 'px';
    canvas.style.height = $3 + 'px';
    if ($4) document.title = UTF8ToString($4);
  }, pw, ph, w, h, title ? title : "");

  // Full-screen mirrors Stage.displayState = FULL_SCREEN via the Fullscreen API.
  if (fullscreen) {
    EM_ASM({
      var el = Module.canvas;
      if (el.requestFullscreen) el.requestFullscreen();
    });
  }

  // Pointer/wheel input is registered on the canvas element itself.
  emscripten_set_mousedown_callback("#canvas", nullptr, EM_FALSE, on_mouse_evt);
  emscripten_set_mouseup_callback("#canvas", nullptr, EM_FALSE, on_mouse_evt);
  emscripten_set_mousemove_callback("#canvas", nullptr, EM_FALSE, on_mouse_evt);
  emscripten_set_mouseleave_callback("#canvas", nullptr, EM_FALSE, on_mouse_evt);
  emscripten_set_wheel_callback("#canvas", nullptr, EM_FALSE, on_wheel_evt);
  // Suppress the BROWSER's own context menu on the canvas: a right click belongs to
  // the AS3 side (阶段二百八十九). There is no emscripten_set_contextmenu_callback in
  // emsdk 3.1.44 (checked: system/include/emscripten/html5.h has no "contextmenu"),
  // so the listener is attached directly and preventDefault() keeps the browser menu
  // away. Idempotent: sk_window_show may run again for a re-created stage.
  EM_ASM({
    var el = Module.canvas;
    if (el && !el.__skNoCtxMenu) {
      el.__skNoCtxMenu = true;
      el.addEventListener('contextmenu', function(ev) { ev.preventDefault(); });
    }
  });

  // Initial frame (the surface is already rasterized by Stage_showWindow).
  present_frame();

  // Run the loop forever: fps=0 means "follow requestAnimationFrame", and
  // simulate_infinite_loop=1 prevents main() from returning (the web analogue of
  // the SDL2 backend's blocking event loop).
  emscripten_set_main_loop(main_loop, 0, 1);
  return 1;  // unreachable (simulate_infinite_loop keeps the loop running)
}

// ---------- dynamic window API (flash.display.NativeWindow) ----------
// AIR's NativeWindow is a DESKTOP capability: a browser page cannot open extra
// OS windows, so there is no way to honour it here. Following the project's rule
// for platform hard boundaries (never silently degrade), every entry point is
// present — so the generated C still links — but creation fails, which the AS3
// side turns into a thrown Error naming the limitation. The alternative
// (pretending to succeed and drawing into a window nobody can see) would be a
// silent, undetectable lie.
int sk_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,
                     int decorated, int highdpi,
                     int gpu,
                     void (*on_mouse)(int, double, double, const char*),
                     void (*on_wheel)(int, double, double, double),
                     void (*on_key)(int, const char*, int, int, int),
                     void (*on_redraw)(int),
                     void (*on_frame)(int),
                     double (*on_frame_delay)(int),
                     void* (*on_resize)(int, int, int, int, int, double),
                     void (*on_close)(int)) {
  // A browser has no second OS window, so the whole per-window style is moot here;
  // the signature still tracks window_glue.cc's.
  (void)w; (void)h; (void)title; (void)resizable; (void)maximizable; (void)minimizable;
  (void)decorated; (void)highdpi;
  (void)gpu;
  (void)on_mouse; (void)on_wheel; (void)on_key; (void)on_redraw; (void)on_frame;
  (void)on_frame_delay; (void)on_resize; (void)on_close;
  return -1;
}

// ---------- clipboard ----------
// A page's clipboard is asynchronous (navigator.clipboard.writeText returns a
// Promise) and gated on user activation, so it does not fit the synchronous
// set/get seam the AS3 side needs. Left unimplemented and declared in TODO.md:
// on web a copy silently does nothing rather than copying something else.
void sk_clipboard_set_text(const char* text) { (void)text; }
int sk_clipboard_get_text(char* buf, int cap) { (void)buf; (void)cap; return 0; }
// The rest of the clipboard seam (stage 293). available() answers 0, so the AS3
// side reports "this build has no clipboard backend" instead of claiming the value
// reached the system clipboard; has_fmt/get_fmt answer "nothing there".
int sk_clipboard_available(void) { return 0; }
int sk_clipboard_has_fmt(const char* fmt) { (void)fmt; return 0; }
void sk_clipboard_set_fmt(const char* fmt, const void* data, int len) { (void)fmt; (void)data; (void)len; }
int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap) { (void)fmt; (void)buf; (void)cap; return 0; }
void sk_clipboard_clear_fmt(const char* fmt) { (void)fmt; }
void sk_clipboard_clear(void) { }
void sk_window_attach_surface(int id, void* surface, int pw, int ph) { (void)id; (void)surface; (void)pw; (void)ph; }
void sk_window_set_visible(int id, int visible) { (void)id; (void)visible; }
// Cursor shape is the page's business on web (the CSS cursor follows the DOM
// element under the pointer), so the native cursor kind has no effect here; the
// stub exists only so a `--package web` build links against the same glue API.
void sk_window_set_cursor(int id, int kind) { (void)id; (void)kind; }
int sk_window_get_visible(int id) { (void)id; return 0; }
void sk_window_set_title(int id, const char* title) { (void)id; (void)title; }
void sk_window_set_bounds(int id, int x, int y, int w, int h) { (void)id; (void)x; (void)y; (void)w; (void)h; }
void sk_window_get_bounds(int id, int* x, int* y, int* w, int* h) { (void)id; if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0; }
// Frame borders do not exist in a page: the stage IS the window, so the border is
// zero and NativeWindow.bounds and globalToScreen coincide (see the AS3 comment on
// as_window_get_borders).
void sk_window_get_borders(int id, int* top, int* left, int* bottom, int* right) {
  (void)id; if (top) *top = 0; if (left) *left = 0; if (bottom) *bottom = 0; if (right) *right = 0;
}
// A page has no platform window object: there is no HWND and no NSWindow, only a
// canvas owned by the browser and unreachable from here. NULL is the honest
// answer, and FREAcquireNativeWindowHandle turns it into a REPORTED
// FRE_ILLEGAL_STATE (docs/zh-cn/ane.md 3.8) rather than handing an extension a
// pointer it would dereference.
void* sk_window_native_handle(int id) { (void)id; return 0; }
void sk_window_close(int id) { (void)id; }
int sk_window_is_closed(int id) { (void)id; return 1; }
void sk_window_activate(int id) { (void)id; }
void sk_window_minimize(int id) { (void)id; }
void sk_window_maximize(int id) { (void)id; }
void sk_window_restore(int id) { (void)id; }
void sk_window_order_front(int id) { (void)id; }
void sk_window_order_back(int id) { (void)id; }
int sk_window_display_index(int id) { (void)id; return 0; }
void sk_window_get_pixel_size(int id, int* pw, int* ph) { (void)id; if (pw) *pw = 0; if (ph) *ph = 0; }
void sk_window_get_client_size(int id, int* lw, int* lh) { (void)id; if (lw) *lw = 0; if (lh) *lh = 0; }
int sk_window_is_active(int id) { (void)id; return 0; }
// The browser owns the window, so it cannot answer "is this page maximized" the way
// a native window manager does (and a page's own fullscreen request is already
// recorded on the AS3 side). -1 means "no opinion": the generated poll then keeps
// whatever NativeWindow.maximize/restore/Stage.displayState wrote. Answering 0 would
// be a lie that overwrites that record on every frame.
int sk_window_os_display_state(int id) { (void)id; return -1; }
void sk_window_set_always_in_front(int id, int on) { (void)id; (void)on; }
// The browser owns the page's compositing: a page cannot ask for a translucent
// window, so there is nothing to apply. The generated C still keeps the flag, and
// the compose step clears to alpha 0, which is harmless — the page background
// shows through exactly as it does for any transparent canvas.
void sk_window_set_transparent(int id, int on) { (void)id; (void)on; }
// minSize/maxSize and the system move/resize drags have no browser counterpart:
// a page's window belongs to the browser, so there is no frame to size-limit and
// no frame to hand over to the pointer. "No limit" and "the drag did not start"
// are the honest answers; the generated C turns the latter into AIR's `false`
// (Beta 1 note: the browser's window is not scriptable, so this is a platform
// boundary, not a missing feature).
void sk_window_get_limits(int id, int* mnw, int* mnh, int* mxw, int* mxh) {
  (void)id;
  if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
}
void sk_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh) {
  (void)id; (void)mnw; (void)mnh; (void)mxw; (void)mxh;
}
// No window manager, so nothing to clamp against: a zero floor lets minSize answer
// with whatever was written (see the note on sk_window_get_limits above).
void sk_window_limits_floor(int* fw, int* fh) { if (fw) *fw = 0; if (fh) *fh = 0; }
// No OS window exists on web at all, so there is no platform default to report;
// zeros keep the getter honest instead of inventing a window manager's numbers.
void sk_window_limits_default(int* mnw, int* mnh, int* mxw, int* mxh) {
  if (mnw) *mnw = 0; if (mnh) *mnh = 0; if (mxw) *mxw = 0; if (mxh) *mxh = 0;
}
int sk_window_start_move(int id) { (void)id; return 0; }
int sk_window_start_resize(int id, const char* edge) { (void)id; (void)edge; return 0; }
// A browser tab's close button is the browser's to own: the page never sees it, so
// there is never a pending request -- but the generated C asks once per frame, so
// the stub has to exist for this backend to link.
int sk_window_take_close_request(int id) { (void)id; return 0; }
// NativeApplication.exit(): ask the frame loop to end. A page cannot end its own
// browser process, but this backend DOES define ASC_USE_WINDOW=1 (src/air-app.ts,
// examples/web/hello-web.build.json), so the generated C really does compile the
// call -- leaving this a silent no-op would swallow NativeApplication.exit(),
// which the project's "a capability gap is never silent" rule forbids. This is the
// web analogue of window_glue.cc's g_exit_requested flag that ends the SDL pump:
// emscripten_cancel_main_loop() stops the loop sk_window_show started with
// emscripten_set_main_loop(main_loop, 0, 1), whose simulate_infinite_loop=1 is
// what keeps main() from returning.
void sk_window_request_exit(void) {
  emscripten_cancel_main_loop();
}
// Composed-text seam (native window_glue.cc drains SDL_TEXTINPUT/SDL_TEXTEDITING
// through these). On web the whole keyboard transport is unwired — see the note in
// sk_window_show above — so there is no composed-text queue to drain and no OS
// candidate window to position. The generated C still calls these every frame
// under ASC_USE_WINDOW, so web must define them or the link fails; returning
// "nothing pending" is the honest answer, not a silent capability drop.
int sk_window_text_take(int id, char* buf, int cap) { (void)id; (void)buf; (void)cap; return 0; }
int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length) {
  (void)id; (void)buf; (void)cap; (void)start; (void)length; return 0;
}
void sk_window_set_text_input_rect(int id, double x, double y, double w, double h) {
  (void)id; (void)x; (void)y; (void)w; (void)h;
}
// The page's canvas is the only window; the generated boot code uses this id for
// Stage.showWindow, so it must be 0 rather than "none".
int sk_window_main(void) { return 0; }

// ---- flash.desktop menu seam (stage 255) ----
// A browser page has no application menu bar and no Dock, so the whole seam is
// inert here: the AS3 model (flash.display.NativeMenu / NativeMenuItem) still
// works, and NativeApplication.supportsMenu / .supportsDockIcon answer false
// because ASC_HAS_APP_MENU / ASC_HAS_DOCK are 0 outside ASC_USE_WINDOW && __APPLE__.
// These definitions must still EXIST: the generated C references them
// unconditionally under ASC_USE_WINDOW, so leaving them out is a wasm-ld
// "undefined symbol: sk_menu_install_app", not a graceful degradation.
typedef struct sk_menu_item_t { int kind; const char* label; int enabled; int checked; const char* key; int mods; int submenu; int tag; } sk_menu_item_t;
typedef struct sk_menu_t { const char* title; int first; int count; } sk_menu_t;
int sk_menu_supported(void) { return 0; }
int sk_menu_install_app(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root; (void)cb; return 0;
}
int sk_menu_install_dock(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root; (void)cb; return 0;
}
void sk_dock_bounce(int critical) { (void)critical; }
// ---- context-menu popup (阶段二百八十九) ----
// A browser page has no native popup menu, and no thread to block on: the popup is
// a DOM overlay and the selection comes back asynchronously, so
// sk_menu_popup answers 0 (pending) and the generated C polls
// sk_menu_popup_take once per frame. That is a REAL cross-platform difference
// against AIR, where the menu is modal: on the web the rightMouseUp/rightClick that
// follow the menu arrive BEFORE the selection instead of after it. Only the ROOT
// menu's items are rendered (an item whose NativeMenuItem.submenu is set shows as a
// plain, inert row) -- nested popups are registered as a web divergence in TODO.md.
//
// The picked tag lives in window.__skMenu (a plain JS object) so no C function has to
// be exported back to JS: `done`/`result` are the handshake, result -1 = dismissed.

static void sk_menu_dom_init(void) {
  // Plain emscripten_run_script with a raw string, not EM_ASM: EM_ASM stringifies its
  // one macro argument, so a top-level comma (an object or array literal, e.g.
  // { items: [], done: 0 }) splits the JS into extra macro arguments and the build
  // fails with "use of undeclared identifier" (measured with emsdk 3.1.44). Commas
  // inside parentheses/strings are safe, top-level ones are not.
  emscripten_run_script(R"SKJS(
(function () {
  if (window.__skMenu) return;
  var m = {};
  m.items = [];
  m.done = 0;
  m.result = -1;
  m.el = null;
  m.outside = null;
  window.__skMenu = m;
  function close() {
    if (m.outside) { document.removeEventListener('mousedown', m.outside, true); m.outside = null; }
    if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    m.el = null;
  }
  m.open = function (x, y) {
    close();
    m.items = [];
    m.done = 0;
    m.result = -1;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;z-index:2147483647;background:#f5f5f5;border:1px solid #a8a8a8;' +
      'border-radius:5px;box-shadow:0 5px 14px rgba(0,0,0,.28);padding:4px 0;' +
      'font:13px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#111;' +
      'min-width:130px;user-select:none;-webkit-user-select:none;';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    document.body.appendChild(el);
    m.el = el;
  };
  m.add = function (label, enabled, checked, tag) {
    if (!m.el) return;
    var row = document.createElement('div');
    row.textContent = (checked ? '\u2713 ' : '') + label;
    row.style.cssText = 'padding:4px 22px 4px 16px;white-space:nowrap;cursor:default;' +
      (enabled ? '' : 'opacity:.4;');
    if (enabled) {
      row.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        m.done = 1;
        m.result = tag;
        close();
      });
    }
    m.el.appendChild(row);
  };
  m.sep = function () {
    if (!m.el) return;
    var hr = document.createElement('div');
    hr.style.cssText = 'height:1px;background:#c8c8c8;margin:4px 0;';
    m.el.appendChild(hr);
  };
  m.show = function () {
    if (!m.el) return;
    // Keep the menu inside the viewport: AppKit does the same on the native side.
    var r = m.el.getBoundingClientRect();
    if (r.right > window.innerWidth) m.el.style.left = Math.max(0, window.innerWidth - r.width) + 'px';
    if (r.bottom > window.innerHeight) m.el.style.top = Math.max(0, window.innerHeight - r.height) + 'px';
    // The press that opened the menu is still in flight: an outside-click listener
    // installed now would fire for it, so install it on the next turn.
    setTimeout(function () {
      if (!m.el) return;
      m.outside = function (ev) {
        if (m.el && m.el.contains(ev.target)) return;
        m.done = 1;
        m.result = -1;
        close();
      };
      document.addEventListener('mousedown', m.outside, true);
    }, 0);
  };
})();
)SKJS");
}

int sk_menu_popup(int win, const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, double x, double y, int* tag, double* outx, double* outy) {
  // A page owns one canvas: the window id is always 0 and unused here.
  (void)win; (void)menus; (void)nmenus;
  if (tag != NULL) *tag = 0;
  // Never used: this backend answers "pending", so the dismissal point the emitter
  // replays the right release at is not asked for here. The browser has already
  // delivered rightMouseUp/rightClick by then (that is the documented divergence).
  if (outx != NULL) *outx = x;
  if (outy != NULL) *outy = y;
  if (items == NULL || root < 0 || root >= nmenus) return 0;
  sk_menu_dom_init();
  EM_ASM({ window.__skMenu.open($0, $1); }, x, y);
  int first = menus[root].first;
  for (int i = 0; i < menus[root].count; i++) {
    int k = first + i;
    if (k < 0 || k >= nitems) break;
    if (items[k].kind == 1) { EM_ASM({ window.__skMenu.sep(); }); continue; }
    EM_ASM({ window.__skMenu.add(UTF8ToString($0), $1, $2, $3); },
           items[k].label != NULL ? items[k].label : "", items[k].enabled, items[k].checked, items[k].tag);
  }
  EM_ASM({ window.__skMenu.show(); });
  return 0;  // pending: resolved by sk_menu_popup_take from a later frame
}

int sk_menu_popup_take(int* tag) {
  if (tag != NULL) *tag = 0;
  // -2 = "not open / still open", anything else is the outcome.
  int code = EM_ASM_INT({
    if (!window.__skMenu || !window.__skMenu.done) return -2;
    return window.__skMenu.result | 0;
  });
  if (code == -2) return 0;
  EM_ASM({ window.__skMenu.done = 0; window.__skMenu.result = -1; });
  if (tag != NULL) *tag = code > 0 ? code : 0;
  return 1;
}
// autoExit: a page cannot "exit", and the requestAnimationFrame loop is owned by
// the host, so there is nothing to keep alive here. Accepted and ignored.
void sk_window_set_auto_exit(int on) { (void)on; }
// DockIcon.bitmaps: a browser tab has no Dock icon. Exists only so a build that
// flips ASC_HAS_DOCK_IMAGE later still links.
void sk_dock_set_icon_image(const void* argb, int w, int h) { (void)argb; (void)w; (void)h; }

}  // extern "C"
