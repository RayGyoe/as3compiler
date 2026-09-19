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

// One frame: advance the frame clock (ENTER_FRAME + timers), then re-rasterize
// (reflecting any listener-driven mutation) and present. requestAnimationFrame
// replaces SDL_PollEvent as the frame driver; the browser caps the cadence at
// the display refresh rate, so a very high Stage.frameRate simply saturates it.
static void main_loop(void) {
  // Frame pacing: honor Stage.frameRate via on_frame_delay (ms/frame); the
  // rolling deadline absorbs render time so the loop sustains the requested rate
  // up to the rAF ceiling (see the SDL2 backend's equivalent comment).
  double now = emscripten_get_now();
  static double next_tick = 0.0;
  double interval = g_on_frame_delay ? g_on_frame_delay() : 16.0;
  if (interval > 0.0 && now < next_tick) return;
  if (interval > 0.0) next_tick = now + interval; else next_tick = now;

  if (g_on_frame) g_on_frame();
  if (g_on_redraw) g_on_redraw();
  present_frame();
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

// The browser exposes no physical display refresh rate; return 0 so the frame
// pacer falls back to its compiler-side default (see ASC_window_on_frame_delay).
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
