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
static void (*g_on_mouse)(double, double, const char*) = nullptr;
static void (*g_on_wheel)(double, double, double) = nullptr;
static void (*g_on_redraw)(void) = nullptr;
static void (*g_on_frame)(void) = nullptr;
static double (*g_on_frame_delay)(void) = nullptr;

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

  double interval = g_on_frame_delay ? g_on_frame_delay() : 16.0;
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
  if (g_on_frame) g_on_frame();
  if (g_on_redraw) g_on_redraw();
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

// Left-button pointer input. Coordinates are CSS pixels relative to the canvas,
// matching SDL2's logical window points (the AS3 side maps through align/scale).
static EM_BOOL on_mouse_evt(int eventType, const EmscriptenMouseEvent* e, void* ud) {
  (void)ud;
  if (g_on_mouse == nullptr) return EM_TRUE;
  if (eventType == EMSCRIPTEN_EVENT_MOUSEDOWN && e->button == 0) {
    g_on_mouse((double)e->targetX, (double)e->targetY, "mouseDown");
  } else if (eventType == EMSCRIPTEN_EVENT_MOUSEUP && e->button == 0) {
    g_on_mouse((double)e->targetX, (double)e->targetY, "mouseUp");
    g_on_mouse((double)e->targetX, (double)e->targetY, "click");
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
  if (g_on_wheel) g_on_wheel((double)e->mouse.targetX, (double)e->mouse.targetY, -(double)e->deltaY);
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
double sk_window_get_display_refresh(void) { return 0.0; }

// Present the Skia raster surface in the canvas and run the rAF frame loop until
// the page is closed. Mirrors sk_window_show's signature in window_glue.cc so the
// generated C calls it identically. `w`/`h` are logical size (AIR <width>/<height>),
// `pw`/`ph` the physical pixel size of the surface (from sk_window_probe_scale).
int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,
                   int fullscreen, void (*on_mouse)(double, double, const char*),
                   void (*on_wheel)(double, double, double),
                   void (*on_redraw)(void), void (*on_frame)(void),
                   double (*on_frame_delay)(void),
                   void* (*on_resize)(int, int, int, int, double)) {
  (void)on_resize;  // resize not yet wired on web (fixed canvas for now)
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
  emscripten_set_wheel_callback("#canvas", nullptr, EM_FALSE, on_wheel_evt);

  // Initial frame (the surface is already rasterized by Stage_showWindow).
  present_frame();

  // Run the loop forever: fps=0 means "follow requestAnimationFrame", and
  // simulate_infinite_loop=1 prevents main() from returning (the web analogue of
  // the SDL2 backend's blocking event loop).
  emscripten_set_main_loop(main_loop, 0, 1);
  return 1;  // unreachable (simulate_infinite_loop keeps the loop running)
}

}  // extern "C"
