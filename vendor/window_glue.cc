// window_glue.cc — the C++ -> C bridge for the SDL2 window backend.
//
// Where skia_glue.cc owns the *pixels* (offscreen CPU raster -> PNG), this file
// owns the *window*: it takes a Skia offscreen raster surface, blits its pixels
// into an SDL2 window, runs the event loop, and forwards input events back into
// the generated AS3 code through C function pointers (so this glue layer never
// needs to know the generated function names).
//
// The generated .c stays C; this glue layer is compiled as C++ only because it
// must pull in SDL2 headers. The single data hand-off from Skia to SDL is the
// raw pixel buffer obtained through sk_surface_peek_pixels (defined in
// skia_glue.cc), so no Skia type crosses the C boundary.

// clang's MSVC mode (--target=*-pc-windows-msvc, clang 23) declares `_m_prefetch`
// as a builtin. The vendored SDL2 SDL_endian.h carries a workaround for an older
// clang that redefines `_m_prefetch` as an __inline__ shim guarded by
// __PRFCHWINTRIN_H; under clang 23 that shim collides with the builtin
// ("definition of builtin function '_m_prefetch'"). Pre-defining __PRFCHWINTRIN_H
// (the include guard of <prfchwintrin.h>) skips the shim — the builtin stays
// available for SDL's own use. Inert on non-Windows targets, where this
// _MSC_VER-only branch never compiles.
#if defined(_WIN32)
#define __PRFCHWINTRIN_H
#endif
// SDL.h on macOS redefines `main` as `SDL_main` unless this is defined first.
// Our generated .c provides its own standard `int main(void)`, so we opt out
// of SDL's main wrapping here.
#define SDL_MAIN_HANDLED
#include <SDL2/SDL.h>
#ifdef ASC_RENDER_METAL
#include <SDL2/SDL_metal.h>
#endif
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <SDL2/SDL_syswm.h>
// SDL_GetWindowBordersSize is NOT implemented by the Cocoa driver in the SDL we
// vendor (it answers "That operation is not supported"), so the truth comes from
// the NSWindow itself: AIR's NativeWindow.bounds is the OUTER frame rectangle, and
// without the real borders every bounds value would be short by the title bar
// (measured 32pt here — exactly adl's 410-vs-378 relationship).
// These two headers are plain C (no Cocoa.h, no .mm), so this file stays C++.
// They are macOS-only: the NSWindow border shim below is compiled out on other
// platforms (objc_msgSend/SEL do not exist outside Objective-C).
#if defined(__APPLE__)
#include <objc/message.h>
#include <objc/runtime.h>
#endif

extern "C" {

int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes);

// Mouse pointer shape. The kinds mirror the AS_CURSOR_* block in runtime.ts and
// the setter itself is defined with the other window exports further down; both
// are declared here because the event pump below turns the cursor back into an
// arrow when the pointer leaves a window.
#define SK_CURSOR_ARROW  0
#define SK_CURSOR_IBEAM  1
#define SK_CURSOR_HAND   2
#define SK_CURSOR_BUTTON 3
void sk_window_set_cursor(int id, int kind);
#ifdef ASC_RENDER_METAL
// Native Metal GPU backend (metal_glue.mm). A CAMetalDrawable is one-shot, so
// each window acquires a fresh surface per frame, renders, then presents. Both
// calls are keyed by the same window id the rest of this file hands out, so the
// Metal state is per window and the device/context behind it are shared.
int sk_mtl_init(int id, void* layer);
void sk_mtl_destroy(int id);
#endif
#ifdef ASC_RENDER_D3D
// Native D3D12 GPU backend (d3d_glue.cc). Same per-window contract as the Metal
// one above: the swapchain and its back buffers are per window (keyed by this
// same id), the ID3D12Device / command queue / GrDirectContext are process-wide.
// `native_handle` is the window's HWND — this file owns the SDL2 window and
// hands the backend the one thing it needs from it.
int sk_gpu_init(int id, void* native_handle);
void sk_gpu_destroy(int id);
#endif

// Cached primary-display size so Stage.fullScreenWidth/fullScreenHeight can be
// read without holding SDL initialized. Populated lazily here and refreshed
// whenever a window is shown.
static int g_display_w = 0;
static int g_display_h = 0;
// Cached primary-display refresh rate (Hz) for Stage.frameRate's "unset"
// fallback. AIR sets frameRate from the first SWF's header, but this compiler
// treats an unset (<=0) frameRate as "follow the display": the event-loop
// cadence then mirrors the monitor's vsync rate.
static double g_display_refresh = 0.0;
// The window whose refresh rate the frame pacer should follow is no longer a
// single global: every window keeps its own display affinity, so the rate is
// queried per window inside the registry below.

// ---------- HiDPI probing ----------

// AIR's <requestedDisplayResolution> has two values: "high" renders at the
// device's native resolution (on a Retina display that is 2x the logical size),
// "standard" renders at 1x and lets the OS scale the result up — which is what
// makes our window look blurry. The SDL2 equivalent is SDL_WINDOW_ALLOW_HIGHDPI:
// without it the window's drawable size equals its logical size, so an offscreen
// surface sized in logical points gets stretched by the compositor.
//
// The generated C creates the Skia surface *before* it can open the window, so
// it has to ask up front how many physical pixels that window will own. We
// answer by briefly opening a hidden high-DPI window and comparing its logical
// size against its drawable size, then reporting the resulting ratio. This is a
// probe of the *primary* display, which is where the window is centered.
// Everything that starts the video subsystem goes through here, because some of
// the hints below only take effect if they are set BEFORE the first
// SDL_Init(SDL_INIT_VIDEO) — a bare SDL_Init anywhere in this file would silently
// skip them. SDL_SetHint is idempotent and re-latching the same values on a later
// init is exactly right, so calling this on every init is correct rather than
// merely harmless.
static int sk_video_init(void) {
#ifdef _WIN32
#ifdef ASC_DISPLAY_HIGH
  // A DPI-UNAWARE process has its whole window bitmap stretched by the compositor
  // on a scaled monitor: a 1000x680 window is rasterized at 1000x680 and then
  // blown up 1.5x on this machine's 150% 3840x2560 panel. The pixels the app never
  // renders at are precisely the ones it is judged by, so
  // <requestedDisplayResolution>high changed nothing on screen.
  //
  // SDL_WINDOWS_DPI_SCALING=1 is what makes SDL_WINDOW_ALLOW_HIGHDPI mean anything
  // here. It (a) requests per-monitor-v2 DPI awareness, so the process stops being
  // bitmap-stretched at all, and (b) puts SDL's coordinate system in DPI-scaled
  // POINTS — which is the macOS model this whole file is written against:
  // SDL_GetWindowSize() = logical points, SDL_GetWindowSizeInPixels() = physical
  // pixels, and their ratio is the device scale sk_window_probe_scale() and
  // do_resize() report. Measured on this machine (96 -> 144 DPI): without the hint
  // a 1000x680 window reports 1000x680 / scale 1.0; with it, 1000x680 points ->
  // 1500x1020 pixels / scale 1.5. Setting SDL_WINDOWS_DPI_AWARENESS as well would
  // be redundant (this hint implies per-monitor-v2), and it would additionally
  // force SDL_WINDOW_ALLOW_HIGHDPI on every window.
  //
  // Gated on ASC_DISPLAY_HIGH on purpose. AIR defines
  // <requestedDisplayResolution>standard as "render at 1x and let the OS scale the
  // result up", which is exactly what a DPI-unaware process already does; latching
  // awareness there without also rescaling the 1x blit up to the physical backing
  // would leave the picture in the corner of a physical-sized render target. So a
  // standard build keeps its previous behaviour bit for bit. Inert outside _WIN32,
  // so macOS and wasm are untouched either way.
  SDL_SetHint(SDL_HINT_WINDOWS_DPI_SCALING, "1");
#endif
#endif
  return SDL_Init(SDL_INIT_VIDEO);
}

static void ensure_video(void) {
  static int inited = 0;
  if (!inited) { sk_video_init(); inited = 1; }
}

// Write the physical pixel size a logical w*h window would draw into when
// high-DPI is on, and return the ratio (w_ratio = pw / w). With highdpi == 0
// the ratio is always 1.0 and pw/ph mirror the logical size.
double sk_window_probe_scale(int w, int h, int highdpi, int* pw, int* ph) {
  ensure_video();
  int dw = w, dh = h;
  if (highdpi) {
    SDL_Window* probe = SDL_CreateWindow("",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, w, h,
        SDL_WINDOW_HIDDEN | SDL_WINDOW_ALLOW_HIGHDPI);
    if (probe != NULL) {
      // SDL_GetWindowSizeInPixels (SDL 2.26+, pinned 2.32) is the authoritative
      // physical-pixel accessor for the backing store, even on a Metal renderer.
      SDL_GetWindowSizeInPixels(probe, &dw, &dh);
      SDL_DestroyWindow(probe);
    }
  }
  if (pw) *pw = dw;
  if (ph) *ph = dh;
  return (w > 0) ? (double)dw / (double)w : 1.0;
}

// Query the primary display's current mode (pixels). Returns 1 on success.
int sk_window_get_display_size(int* w, int* h) {
  if (g_display_w <= 0 || g_display_h <= 0) {
    if (sk_video_init() != 0) return 0;
    SDL_DisplayMode dm;
    if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
      g_display_w = dm.w; g_display_h = dm.h;
    }
    SDL_Quit();
  }
  if (w) *w = g_display_w;
  if (h) *h = g_display_h;
  return (g_display_w > 0 && g_display_h > 0) ? 1 : 0;
}

// ---------- display enumeration (flash.display.Screen) ----------
// SDL reports display rectangles in the same top-left-origin point space AIR's
// Screen uses, so no coordinate flipping is needed. `bounds` is the display's
// full extent; `usable bounds` excludes the menu bar and the Dock — the two are
// different quantities on the same display (measured against adl: bounds
// 0,0 1800x1169 vs visibleBounds 47,39 1753x1130 on a dock-left desktop).
//
// These queries may run from inside the window event loop (AS3 code reading
// Screen.mainScreen in a frame callback), so they must never call SDL_Quit —
// that would tear down the video subsystem the window loop is running on.
// ensure_video() initializes once and leaves it initialized; the loop's own
// SDL_Init/SDL_Quit pair still owns the final shutdown.
int sk_display_count(void) {
  ensure_video();
  int n = SDL_GetNumVideoDisplays();
  return n > 0 ? n : 0;
}

int sk_display_bounds(int i, int* x, int* y, int* w, int* h) {
  ensure_video();
  SDL_Rect r;
  if (SDL_GetDisplayBounds(i, &r) != 0) return 0;
  if (x) *x = r.x;
  if (y) *y = r.y;
  if (w) *w = r.w;
  if (h) *h = r.h;
  return 1;
}

int sk_display_usable_bounds(int i, int* x, int* y, int* w, int* h) {
  ensure_video();
  SDL_Rect r;
  // SDL_GetDisplayUsableBounds is SDL 2.0.5+ (we pin 2.32). Where the platform
  // reports nothing usable, fall back to the full bounds rather than handing back
  // a zero rectangle — a 0x0 visibleBounds would silently match no Screen at all.
  if (SDL_GetDisplayUsableBounds(i, &r) != 0) return sk_display_bounds(i, x, y, w, h);
  if (x) *x = r.x;
  if (y) *y = r.y;
  if (w) *w = r.w;
  if (h) *h = r.h;
  return 1;
}

// Query the refresh rate (Hz) of the display a given window occupies. The
// per-window form (defined in the registry section below) supersedes an earlier
// single global `g_win`: with several windows open, each one paces its own frame
// clock, so "the display the app is on" is not a well-defined question.


// Callback types handed in from the generated C code. Every callback now takes
// the id of the window it belongs to: once AIR's NativeWindow lets an app open
// more than one window, "the window" is no longer implicit. Passing the id
// explicitly is what lets ONE generated callback table serve every window
// instead of the emitter having to duplicate a whole callback set per window,
// and it removes the ambient "current window" global that a nested call (a
// resize during a frame) would silently clobber.
//
// on_mouse receives the window-relative x/y and an AS3 event-type string
// ("mouseDown"/"mouseUp"/"click", plus the reserved "wordSelect" described at
// its dispatch site); on_redraw is invoked after every handled event
// so the AS3 side can re-rasterize the (possibly mutated) display tree into the
// same surface.
typedef void (*sk_mouse_cb)(int win, double x, double y, const char* type);
typedef void (*sk_wheel_cb)(int win, double x, double y, double delta);
// on_key carries an already-AIR-shaped keyboard event: the AS3 side only has to
// wrap it in a KeyboardEvent and dispatch it. Both codes are AIR's numbers, not
// SDL's, because they are not the same thing at all — see sk_air_keycode below
// for the measured mapping (letters report their UPPERCASE ASCII keyCode, the
// Delete key reports keyCode 46 with charCode 127, Cmd reports keyCode 15, ...).
// `mod` is an SK_MOD_* bitmask; `type` is "keyDown" or "keyUp".
typedef void (*sk_key_cb)(int win, const char* type, int keyCode, int charCode, int mod);
// Composed text input (SDL_TEXTINPUT: the OS's text for the keystroke, already
// composed for Option/dead keys and non-US layouts). It travels through on_key
// with the reserved type "textInput" and NO key codes, because a text commit is
// not a keyboard event: the AS3 side drains the bytes with sk_window_text_take()
// and dispatches AIR's TextEvent.TEXT_INPUT. Passing it by an existing callback
// rather than a new one keeps the callback signature list (and every
// on_*/as_skia_*/as_window_* pass-through) unchanged. The buffer is per window and
// cleared by the drain, and SDL delivers at most SDL_TEXTINPUTEVENT_TEXT_SIZE
// bytes per event, so nothing is lost.
typedef void (*sk_redraw_cb)(int win);
typedef void (*sk_frame_cb)(int win);
typedef double (*sk_frame_delay_cb)(int win);
// Invoked after the window changed size or moved to a display with a different
// backing scale. The AS3 side rebuilds its offscreen surface at the new
// *physical* pixel size, re-renders the tree into it, and returns the new
// surface pointer (NULL on failure, meaning "keep the old one"). Ownership
// stays with the AS3 side, which also frees the previous surface. This is what
// keeps a resized window from stretching the content. `scale` is the device
// pixel ratio (macOS contentsScaleFactor) computed by this glue layer from
// SDL's own size queries — the AS3 side must use it verbatim rather than
// re-deriving it from physW/logicalW, which can be stale during a cross-display
// drag. The GPU (Metal) path returns NULL: it re-acquires a right-sized drawable
// per frame instead of keeping a surface.
typedef void* (*sk_resize_cb)(int win, int logicalW, int logicalH, int physW, int physH, double scale);
// Invoked exactly once, after a window has actually been destroyed and its SDL
// resources released. THIS is the point at which AIR's `NativeWindow.closed`
// flips to true and Event.CLOSE is dispatched — `close()` only *requests* the
// teardown, which is why reading `closed` immediately after close() still says
// false under adl (measured). Calling back from here makes the asynchrony fall
// out of the architecture instead of being faked with a delay.
typedef void (*sk_close_cb)(int win);

// ---------- window registry ----------
// A fixed table of window slots. The ids handed to the AS3 side are indices into
// this table, so they stay stable for the window's whole life (a freed slot is
// only ever reused by a later window, never recycled under a live one).
//
// SK_MAX_WINDOWS must match ASC_MAX_WINDOWS in the generated C: the generated
// side keeps a parallel per-window state array indexed by the same id, and the
// two only have to agree on the bound.
#define SK_MAX_WINDOWS 16

struct WinCtx {
  int used;
  // This window composes on the GPU (a CAMetalLayer via metal_glue.mm on macOS,
  // a D3D12 swapchain via d3d_glue.cc on Windows, either way through a shared
  // GrDirectContext) instead of the CPU raster surface + SDL streaming texture
  // below. EVERY window may be GPU-composed — that state is per window — and
  // under ASC_RENDER_WINGPU that is the default for a NativeWindow too (AIR's
  // NativeWindowRenderMode.AUTO); only an explicit renderMode="cpu" asks for the
  // software path.
  int is_gpu;
  SDL_Window* win;
  SDL_Renderer* ren;
  SDL_Texture* tex;
  // The SDL_MetalView backing a GPU window (NULL on the CPU path). Cast back to
  // SDL_MetalView when destroying it; kept as void* so this struct compiles in
  // builds without SDL_metal.h. Always NULL in a D3D build: that backend owns its
  // swapchain (d3d_glue.cc) and needs no handle stored here.
  void* metal_view;
  void* surface;
  void* pixels;
  int rowBytes;
  int pw, ph;
  Uint32 pixfmt;
  // Frame borders (title bar / window edge) for a chrome-decorated window. AIR's
  // NativeWindow.bounds is the OUTER frame rectangle while SDL's window size is
  // the client area, so bounds is derived from the client size plus these — that
  // is exactly the 410-vs-378 difference adl reports for a 600x410 frame.
  int b_top, b_left, b_bottom, b_right;
  int decorated;
  int visible;
  // NativeWindow.alwaysInFront. SDL's SDL_SetWindowAlwaysOnTop is the backing call;
  // the flag is cached here because AIR's getter is expected to read back what the
  // last setter wrote even on a platform that cannot honour it.
  int always_in_front;
  int dirty;
  int destroy_pending;
  int in_watch;
  sk_mouse_cb on_mouse;
  sk_wheel_cb on_wheel;
  sk_key_cb on_key;
  // Pending composed text from SDL_TEXTINPUT, drained by sk_window_text_take().
  char text[256];
  // Pending in-progress composition from SDL_TEXTEDITING (the IME's marked text),
  // drained by sk_window_text_edit_take(). Kept next to `text` because both are
  // per-window pending input; `text` is the COMMIT, this is the preview.
  char edit_text[256];
  int edit_start;
  int edit_len;
  sk_resize_cb on_resize;
  sk_redraw_cb on_redraw;
  sk_frame_cb on_frame;
  sk_frame_delay_cb on_frame_delay;
  sk_close_cb on_close;
};

static WinCtx g_wins[SK_MAX_WINDOWS];
// -1 until the first window exists; the "main" window is simply the first slot
// ever filled, so it stays index 0 in every build.
static int g_main = -1;
// Deadline of the next application frame. There is exactly one frame clock for the
// whole application because AIR's Stage.frameRate is application-wide; per-window
// deadlines would let a second window tick (and broadcast ENTER_FRAME) on top of
// the first window's frames.
static double g_app_next = 0.0;

static WinCtx* sk_slot(int id) {
  if (id < 0 || id >= SK_MAX_WINDOWS) return NULL;
  return g_wins[id].used ? &g_wins[id] : NULL;
}

// Bind a slot. `is_main` reserves index 0 for the app's initial window: that slot
// is the only one the generated C can name without a round trip (ASC_win_claim_main
// uses index 0), so a NativeWindow must never occupy it. An app is allowed to do
// `new NativeWindow()` inside its document class constructor — i.e. BEFORE
// Stage.showWindow opens the initial window — and if that grabbed slot 0 the two
// sides would disagree about which window the callbacks describe.
static int sk_alloc_slot_ex(int is_main) {
  if (is_main && !g_wins[0].used) {
    memset(&g_wins[0], 0, sizeof(g_wins[0]));
    g_wins[0].used = 1;
    g_main = 0;
    return 0;
  }
  for (int i = is_main ? 0 : 1; i < SK_MAX_WINDOWS; i++) {
    if (!g_wins[i].used) {
      memset(&g_wins[i], 0, sizeof(g_wins[i]));
      g_wins[i].used = 1;
      if (is_main) g_main = i;
      return i;
    }
  }
  return -1;
}
static int sk_alloc_slot(void) { return sk_alloc_slot_ex(0); }
static int sk_alloc_slot_main(void) { return sk_alloc_slot_ex(1); }

static int sk_any_open(void) {
  for (int i = 0; i < SK_MAX_WINDOWS; i++) {
    if (g_wins[i].used && !g_wins[i].destroy_pending) return 1;
  }
  return 0;
}

static int sk_id_from_window_id(Uint32 wid) {
  for (int i = 0; i < SK_MAX_WINDOWS; i++) {
    if (g_wins[i].used && g_wins[i].win != NULL &&
        SDL_GetWindowID(g_wins[i].win) == wid) return i;
  }
  return -1;
}

// Blit the Skia pixel buffer into a persistent streaming texture and present it.
// The pixel format note from sk_window_show below applies here too; the masks are
// R/G/B/A = 0x000000FF/0x0000FF00/0x00FF0000/0xFF000000 (R in the low byte on
// macOS). The texture is created once and updated in place each frame instead of
// being created/destroyed per frame — that per-frame churn was the dominant cost
// at high Stage.frameRate values.
static void present_frame(SDL_Renderer* ren, SDL_Texture* tex, void* pixels, int w, int h, int rowBytes) {
  if (tex == NULL) return;
  SDL_UpdateTexture(tex, NULL, pixels, rowBytes);
  SDL_RenderClear(ren);
  // Explicit 1:1 destination rect. Passing NULL instead asks SDL to stretch the
  // texture across the whole render target, which is exactly what distorted the
  // picture on window resize: the target grows to the new drawable size while
  // the surface keeps its old dimensions, so the frame gets resampled (and
  // non-uniformly, once the aspect ratio changes). AIR's NO_SCALE keeps content
  // at a fixed size, so the blit must never scale.
  SDL_Rect dst = { 0, 0, w, h };
  SDL_RenderCopy(ren, tex, NULL, &dst);
  SDL_RenderPresent(ren);
}

// Rebuild the offscreen surface + streaming texture to the window's current
// size. Returns 1 when a resize happened, 0 when the size is unchanged, -1 when
// the new surface no longer exposes pixels (fatal).
//
// On the Metal backend there is no persistent surface: the drawable is re-sized
// per frame from the window's own physical size, so this only reports the new
// size to the AS3 side (which updates its stage dimensions + device scale) and
// returns 0.
static int do_resize(WinCtx* c) {
  int nw = 0, nh = 0, npw = 0, nph = 0;
  SDL_GetWindowSize(c->win, &nw, &nh);
  // SDL_GetWindowSizeInPixels is the authoritative drawable size (SDL 2.26+,
  // pinned 2.32) — it reports physical pixels even for a Metal renderer,
  // whereas SDL_GL_GetDrawableSize can return the logical size or 0 on a
  // non-GL backend. During a cross-display drag macOS briefly reports a 0 or
  // transitional size while it re-syncs the backing scale; rebuilding the
  // surface from that bogus size is exactly what zeroed stageWidth/stageHeight
  // and distorted the picture. Skip until both are sane.
  SDL_GetWindowSizeInPixels(c->win, &npw, &nph);
  if (nw <= 0 || nh <= 0 || npw <= 0 || nph <= 0) return 0;
  if (npw == c->pw && nph == c->ph) return 0;
  // Device pixel ratio (contentsScaleFactor) = physical / logical. Compute it
  // here from SDL's own queries — the single reliable source — and hand it to
  // the AS3 side instead of letting it re-derive pw/lw (which can disagree
  // while the window straddles two displays with different scales).
  double scale = (double)npw / (double)nw;
  if (c->on_resize != NULL) {
    void* ns = c->on_resize(c->win == NULL ? -1 : (int)(c - g_wins), nw, nh, npw, nph, scale);
    if (c->is_gpu) {
      c->pw = npw; c->ph = nph;
      return 1;
    }
    if (ns != NULL) {
      c->surface = ns;
      if (!sk_surface_peek_pixels(c->surface, &c->pixels, &c->rowBytes)) return -1;
    }
  } else if (c->is_gpu) {
    c->pw = npw; c->ph = nph;
    return 1;
  }
  c->pw = npw; c->ph = nph;
  SDL_DestroyTexture(c->tex);
  c->tex = SDL_CreateTexture(c->ren, c->pixfmt, SDL_TEXTUREACCESS_STREAMING, c->pw, c->ph);
  if (c->tex != NULL) SDL_SetTextureBlendMode(c->tex, SDL_BLENDMODE_NONE);
  return 1;
}

// Track the frame borders of a chrome-decorated window so NativeWindow.bounds can
// report the OUTER rectangle AIR reports. SDL returns 0 for a borderless window,
// which is exactly right for NativeWindowSystemChrome.NONE.
// An NSRect, laid out by hand so no Cocoa header is needed. NSRect is four
// CGFloat (double) values, and on arm64 objc_msgSend uses the same calling
// convention as a plain C function for struct arguments and struct returns, so
// the ordinary ABI casts below are correct.
#if defined(__APPLE__)
typedef struct { double x, y, w, h; } sk_nsrect;

static sk_nsrect sk_ns_msg_frame(void* nswin) {
  sk_nsrect (*fn)(void*, SEL) = (sk_nsrect (*)(void*, SEL))objc_msgSend;
  return fn(nswin, sel_registerName("frame"));
}

static sk_nsrect sk_ns_msg_content_rect(void* nswin, sk_nsrect frame) {
  sk_nsrect (*fn)(void*, SEL, sk_nsrect) = (sk_nsrect (*)(void*, SEL, sk_nsrect))objc_msgSend;
  return fn(nswin, sel_registerName("contentRectForFrameRect:"), frame);
}
#endif

// Frame borders (title bar / window edges): AIR's bounds is the OUTER frame rect
// while SDL sizes and positions the CLIENT area, so both bounds conversions go
// through these numbers.
//
// macOS is queried through the NSWindow because SDL_GetWindowBordersSize is
// unimplemented there. NSWindow coordinates are bottom-left-origin, so the title
// bar sits at the TOP: (frame.y + frame.h) - (content.y + content.h). Measured on
// this machine: frame 400x232 vs content 400x200 -> top=32, everything else 0,
// which is exactly the 32pt offset adl reports between a 600x410 frame and its
// 600x378 stage. Other platforms fall back to SDL's own API where it exists, and
// to zero (client == frame) where it does not — zero is the honest answer there:
// we cannot observe a decoration the platform will not describe.
static void sk_measure_borders(WinCtx* c, int decorated) {
  c->decorated = decorated;
  c->b_top = c->b_left = c->b_bottom = c->b_right = 0;
  if (!decorated) return;
  int t = 0, l = 0, b = 0, r = 0;
#if defined(__APPLE__)
  {
    SDL_SysWMinfo info;
    SDL_VERSION(&info.version);
    if (SDL_GetWindowWMInfo(c->win, &info) &&
        info.subsystem == SDL_SYSWM_COCOA && info.info.cocoa.window != NULL) {
      sk_nsrect f = sk_ns_msg_frame(info.info.cocoa.window);
      sk_nsrect ct = sk_ns_msg_content_rect(info.info.cocoa.window, f);
      c->b_top = (int)((f.y + f.h) - (ct.y + ct.h));
      c->b_left = (int)(ct.x - f.x);
      c->b_right = (int)((f.x + f.w) - (ct.x + ct.w));
      c->b_bottom = (int)(ct.y - f.y);
      return;
    }
  }
#endif
  if (SDL_GetWindowBordersSize(c->win, &t, &l, &b, &r) == 0) {
    c->b_top = t; c->b_left = l; c->b_bottom = b; c->b_right = r;
  }
}

// One application frame plus one repaint pass — the shared body of the main loop
// AND of the live-resize watch below. Returns the next frame deadline in ms (the
// caller sleeps to it), or -1 when no window can hold the frame clock.
//
// Why the watch must run THIS and not a private per-window repaint: a window
// drag/resize runs inside the OS's own modal message loop, entered from within
// SDL_PumpEvents, so sk_run_loop is blocked for the whole drag and the only frames
// that happen are the ones the watch drives. SDL feeds it from a
// USER_TIMER_MINIMUM timer on Windows (SDL_windowsevents.c: WM_ENTERSIZEMOVE ->
// WM_TIMER -> SDL_OnWindowLiveResizeUpdate -> SDL_WINDOWEVENT_EXPOSED) and from a
// 60 Hz NSTimer installed during a live resize on macOS (SDL_cocoawindow.m) —
// the same window event through the same hook on both.
//
// An earlier version of the watch called on_frame directly and repainted only the
// dragged window, with two visible consequences: the application's ENTER_FRAME
// ticked at the OS message rate (so every window's animations sped up during a
// drag), and every OTHER window stayed frozen until the drag ended — nothing
// marked it dirty and nothing presented it. Reusing the loop's own frame — same
// clock, same g_app_next deadline, same "a new frame dirties every visible window"
// rule — is what makes a drag behave exactly like a normal frame, on every
// window, on every backend.
static double sk_pump_frame(void) {
  // Re-entrancy: the frame callbacks run real AS3, which can open or close
  // windows and therefore push SDL events — and the watch is reached from inside
  // SDL_PushEvent. A nested call would advance the same frame clock twice.
  static int in_pump = 0;
  if (in_pump) return g_app_next;
  in_pump = 1;

  // Resize service + clock election. AIR runs ONE frame clock for the whole
  // application (Stage.frameRate is application-wide), so the cadence is computed
  // once and the frame dispatched once, however many windows are open. Any live
  // window can hold the clock — they all install the same two generated callbacks
  // — so the clock survives the main window closing.
  int clock = -1;
  for (int i = 0; i < SK_MAX_WINDOWS; i++) {
    WinCtx* c = &g_wins[i];
    if (!c->used || c->destroy_pending) continue;
    int rres = do_resize(c);
    if (rres > 0) c->dirty = 1;
    // A hidden window still keeps its stage alive (NativeWindow.activate() is what
    // makes it visible) but renders nothing, so it cannot hold the clock.
    if (clock < 0 && c->visible && c->on_frame != NULL) clock = i;
  }

  // One application frame, then repaint every visible window. The frame is a
  // single broadcast (ENTER_FRAME + timers + MovieClip advance + GC slice + async
  // retire); each window only rasterizes its own stage afterwards. Doing this per
  // window is what made a second window add its frame rate to the first window's
  // ENTER_FRAME count.
  double earliest = -1.0;
  if (clock >= 0) {
    double t = (double)SDL_GetTicks();
    if (t >= g_app_next) {
      g_wins[clock].on_frame(clock);
      // A new application frame invalidates every visible window: they all render
      // that same frame tick.
      for (int i = 0; i < SK_MAX_WINDOWS; i++) {
        WinCtx* c = &g_wins[i];
        if (c->used && !c->destroy_pending && c->visible) c->dirty = 1;
      }
      double interval = g_wins[clock].on_frame_delay ? g_wins[clock].on_frame_delay(clock) : 16.0;
      if (interval > 0.0) {
        g_app_next += interval;
        if (g_app_next < t) g_app_next = t;
      } else {
        g_app_next = t;
      }
    }
    earliest = g_app_next;
  }

  // Present: only windows whose content is dirty re-rasterize. A window the user
  // cannot see (hidden, or already being destroyed) is skipped.
  for (int i = 0; i < SK_MAX_WINDOWS; i++) {
    WinCtx* c = &g_wins[i];
    if (!c->used || c->destroy_pending) continue;
    if (c->visible && c->dirty && c->on_redraw != NULL) {
      c->on_redraw(i);
      if (!c->is_gpu) present_frame(c->ren, c->tex, c->pixels, c->pw, c->ph, c->rowBytes);
      c->dirty = 0;
    }
  }
  in_pump = 0;
  return earliest;
}

// Event filter: SDL invokes this as events are pumped, which on BOTH platforms
// still happens while the main loop is blocked inside a live-resize drag (see
// sk_pump_frame for the mechanism on each). Redrawing from here is the only thing
// that keeps the animation alive during a drag — and because it runs the shared
// frame, it keeps every OTHER window alive too instead of freezing them for the
// duration.
static int SDLCALL live_resize_watch(void* userdata, SDL_Event* e) {
  WinCtx* c = (WinCtx*)userdata;
  if (!c->used || c->destroy_pending) return 1;
  if (c->in_watch) return 1;
  if (e->type != SDL_WINDOWEVENT) return 1;
  // The watch is registered per window but SDL calls every watch for every event,
  // so ignore events that belong to a different window: sk_pump_frame already
  // repaints every dirty window, and what must NOT happen is each window's watch
  // running its own frame off the same event.
  if (e->window.windowID != SDL_GetWindowID(c->win)) return 1;
  Uint8 we = e->window.event;
  if (we != SDL_WINDOWEVENT_SIZE_CHANGED &&
      we != SDL_WINDOWEVENT_RESIZED &&
      we != SDL_WINDOWEVENT_EXPOSED &&
      we != SDL_WINDOWEVENT_MOVED &&
      we != SDL_WINDOWEVENT_DISPLAY_CHANGED) return 1;
  c->in_watch = 1;
  sk_pump_frame();
  c->in_watch = 0;
  return 1;
}

// Refresh rate (Hz) of the display a given window occupies, or of the primary
// display when it has no window yet. Returns 0 when it cannot be determined (the
// caller falls back to a compiler-side default). Queried live because a
// cross-display drag changes the answer — caching the primary's rate is what let
// a 120 Hz target beat against a 50 Hz external monitor and jitter the interval.
double sk_window_get_display_refresh(int win) {
  WinCtx* c = sk_slot(win);
  if (c != NULL && c->win != NULL) {
    int idx = SDL_GetWindowDisplayIndex(c->win);
    if (idx >= 0) {
      SDL_DisplayMode dm;
      if (SDL_GetCurrentDisplayMode(idx, &dm) == 0) return (double)dm.refresh_rate;
    }
  }
  return g_display_refresh;
}

// Tear down every window whose teardown was requested, then report each one back
// to the AS3 side through on_close. Called once per loop iteration, i.e. at a
// frame boundary with no callback on the stack — the same safety point the GC
// uses, and the reason `NativeWindow.close()` is asynchronous rather than
// re-entrant into the user's own call.
static void sk_service_destroy(void) {
  for (int i = 0; i < SK_MAX_WINDOWS; i++) {
    WinCtx* c = &g_wins[i];
    if (!c->used || !c->destroy_pending) continue;
    SDL_DelEventWatch(live_resize_watch, c);
    if (c->tex != NULL) SDL_DestroyTexture(c->tex);
    if (c->ren != NULL) SDL_DestroyRenderer(c->ren);
    // Release the GPU state before the window it draws into: the backend drops
    // this window's surfaces there (and the shared device/context once the last
    // GPU window is gone). On Metal the view owning the layer must also go before
    // SDL tears the window down; on D3D the backend owns the swapchain and only
    // needs to hear about it while the HWND is still alive.
    if (c->is_gpu) {
#ifdef ASC_RENDER_METAL
      sk_mtl_destroy(i);
      if (c->metal_view != NULL) SDL_Metal_DestroyView((SDL_MetalView)c->metal_view);
      c->metal_view = NULL;
#endif
#ifdef ASC_RENDER_D3D
      sk_gpu_destroy(i);
#endif
    }
    if (c->win != NULL) SDL_DestroyWindow(c->win);
    sk_close_cb cb = c->on_close;
    int was_main = (i == g_main);
    memset(c, 0, sizeof(*c));
    if (was_main) g_main = -1;
    // Notify last: the AS3 side frees its surface and dispatches Event.CLOSE, and
    // a listener is free to open another window from there.
    if (cb != NULL) cb(i);
  }
}

// ---------- keyboard: SDL keysym -> AIR KeyboardEvent ----------
// AIR's keyCode/charCode are NOT the platform's raw codes, so the translation
// lives here (next to the mouse translation) and the AS3 side receives values it
// can put straight into a KeyboardEvent. Every number below is measured on adl
// 51.4.1 (temp/xformcmp/seldir round 6, py-posted CGEvents + an on-screen log):
//   letters        keyCode 67 for 'c' (UPPERCASE ASCII), charCode 99/67
//   Left/Right/Up/Down 37/39/38/40   Return 13  Tab 9  Space 32  Esc 27
//   Backspace 8    Delete 46 (charCode 127)
//   Home 36  End 35  PageUp 33  PageDown 34  F1..F15 112..126
//   Shift 16  Ctrl 17  Opt 18  Cmd 15 (!)  -- modifiers are ordinary keyDowns
//   Opt+letter     keyCode 0 and the composed charCode
// Consequence: the AS3 side must not assume keyCode == charCode for printable
// keys, and must expect keyCode 0 on an Option-composed key.
#define SK_MOD_CTRL   1  /* KeyboardEvent.ctrlKey (Cmd counts as ctrl on macOS) */
#define SK_MOD_ALT    2  /* altKey */
#define SK_MOD_SHIFT  4  /* shiftKey */
#define SK_MOD_CMD    8  /* the platform accelerator: Cmd / Ctrl elsewhere */
#define SK_MOD_CAPS  16  /* capsLock */

static int sk_mod_mask(SDL_Keymod m) {
  int r = 0;
  if ((m & KMOD_CTRL) || (m & KMOD_GUI)) r |= SK_MOD_CTRL;
  if (m & KMOD_ALT) r |= SK_MOD_ALT;
  if (m & KMOD_SHIFT) r |= SK_MOD_SHIFT;
  if (m & KMOD_CAPS) r |= SK_MOD_CAPS;
#if defined(__APPLE__)
  if (m & KMOD_GUI) r |= SK_MOD_CMD;
#else
  if (m & KMOD_CTRL) r |= SK_MOD_CMD;
#endif
  return r;
}

// The typed character for a printable key under a US layout. SDL 2 exposes no
// keyboard-layout query and no composed character on SDL_KEYDOWN (that arrives
// separately as SDL_TEXTINPUT), so a non-US layout is approximated by its base
// key, and an Option-composed character is reported as its base letter. Both
// divergences are recorded in TODO.md's lingering list rather than papered over.
static int sk_us_char(SDL_Keycode sym, int shifted) {
  if (sym >= SDLK_a && sym <= SDLK_z) return shifted ? (int)sym - 32 : (int)sym;
  if (sym >= SDLK_0 && sym <= SDLK_9) {
    static const char sh[10] = {')', '!', '@', '#', '$', '%', '^', '&', '*', '('};
    return shifted ? sh[(int)sym - SDLK_0] : (int)sym;
  }
  switch (sym) {
    case SDLK_SPACE:        return ' ';
    case SDLK_MINUS:        return shifted ? '_' : '-';
    case SDLK_EQUALS:       return shifted ? '+' : '=';
    case SDLK_LEFTBRACKET:  return shifted ? '{' : '[';
    case SDLK_RIGHTBRACKET: return shifted ? '}' : ']';
    case SDLK_BACKSLASH:    return shifted ? '|' : '\\';
    case SDLK_SEMICOLON:    return shifted ? ':' : ';';
    case SDLK_QUOTE:        return shifted ? '"' : '\'';
    case SDLK_COMMA:        return shifted ? '<' : ',';
    case SDLK_PERIOD:       return shifted ? '>' : '.';
    case SDLK_SLASH:        return shifted ? '?' : '/';
    case SDLK_BACKQUOTE:    return shifted ? '~' : '`';
    default: return 0;
  }
}

static int sk_air_keycode(SDL_Keycode sym) {
  if (sym >= SDLK_a && sym <= SDLK_z) return (int)sym - 32;
  if (sym >= SDLK_0 && sym <= SDLK_9) return (int)sym;
  switch (sym) {
    case SDLK_RETURN: case SDLK_KP_ENTER: return 13;
    case SDLK_ESCAPE:     return 27;
    case SDLK_BACKSPACE:  return 8;
    case SDLK_TAB:        return 9;
    case SDLK_SPACE:      return 32;
    case SDLK_DELETE:     return 46;   /* AIR: Delete is 46, its charCode 127 */
    case SDLK_INSERT:     return 45;
    case SDLK_LEFT:       return 37;
    case SDLK_RIGHT:      return 39;
    case SDLK_UP:         return 38;
    case SDLK_DOWN:       return 40;
    case SDLK_HOME:       return 36;
    case SDLK_END:        return 35;
    case SDLK_PAGEUP:     return 33;
    case SDLK_PAGEDOWN:   return 34;
    case SDLK_CAPSLOCK:   return 20;
    case SDLK_LSHIFT: case SDLK_RSHIFT: return 16;
    case SDLK_LCTRL:  case SDLK_RCTRL:  return 17;
    case SDLK_LALT:   case SDLK_RALT:   return 18;
    case SDLK_LGUI:   case SDLK_RGUI:   return 15;
    default:
      if (sym >= SDLK_F1 && sym <= SDLK_F15) return 112 + (int)(sym - SDLK_F1);
      return 0;
  }
}

static void sk_key_map(SDL_Keycode sym, SDL_Keymod mod, int* keyCode, int* charCode) {
  int shifted = ((mod & KMOD_SHIFT) != 0) ^ ((mod & KMOD_CAPS) != 0);
  int kc = sk_air_keycode(sym);
  int cc = sk_us_char(sym, shifted);
  // Option-composed keys report keyCode 0 (measured), with the composed
  // character as charCode — approximated here by the base character.
  if ((mod & KMOD_ALT) && cc != 0 && sym >= SDLK_a && sym <= SDLK_z) kc = 0;
  if (cc == 0) {
    // Non-printing keys: AIR mirrors the keyCode for the editing keys whose
    // charCode it does keep, and reports 0 for everything else.
    if (sym == SDLK_DELETE) cc = 127;
    else if (kc == 13 || kc == 9 || kc == 8 || kc == 27) cc = kc;
  }
  if (keyCode) *keyCode = kc;
  if (charCode) *charCode = cc;
}

// ---------- clipboard (flash.desktop.Clipboard text flavour) ----------
// SDL owns the platform clipboard, so the text flavour is a direct pass-through;
// the AS3 side never touches SDL. A copy is normally followed by the app being
// closed (or by the user pasting into another app), so the text must live in the
// OS clipboard, not in a heap buffer here.
void sk_clipboard_set_text(const char* text) {
  ensure_video();
  SDL_SetClipboardText(text != NULL ? text : "");
}

// Drains the composed text a window's SDL_TEXTINPUT just delivered (see
// sk_key_cb). NUL-terminated, truncated to cap-1, and the pending buffer is
// cleared so a second drain in the same frame returns nothing. Returns the
// number of bytes written.
int sk_window_text_take(int id, char* buf, int cap) {
  if (buf == NULL || cap <= 0) return 0;
  buf[0] = '\0';
  if (id < 0 || id >= SK_MAX_WINDOWS) return 0;
  WinCtx* c = sk_slot(id);
  if (c == NULL) return 0;
  int n = (int)strlen(c->text);
  if (n > cap - 1) n = cap - 1;
  memcpy(buf, c->text, (size_t)n);
  buf[n] = '\0';
  c->text[0] = '\0';
  return n;
}

// Drains the in-progress composition an SDL_TEXTEDITING just delivered (the IME's
// marked text). `*start`/`*length` receive the selection the IME wants highlighted
// INSIDE the composition string (UTF-16 code units, SDL's convention; -1/0 when it
// has none). Same one-shot rule as sk_window_text_take: the buffer is cleared, so a
// second drain in the same frame returns nothing. An empty `text` is meaningful —
// it is how the platform signals "the composition ended" (committed or cancelled).
// Returns the number of bytes written.
int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length) {
  if (start != NULL) *start = -1;
  if (length != NULL) *length = 0;
  if (buf == NULL || cap <= 0) return 0;
  buf[0] = '\0';
  if (id < 0 || id >= SK_MAX_WINDOWS) return 0;
  WinCtx* c = sk_slot(id);
  if (c == NULL) return 0;
  int n = (int)strlen(c->edit_text);
  if (n > cap - 1) n = cap - 1;
  memcpy(buf, c->edit_text, (size_t)n);
  buf[n] = '\0';
  if (start != NULL) *start = c->edit_start;
  if (length != NULL) *length = c->edit_len;
  c->edit_text[0] = '\0';
  c->edit_start = -1;
  c->edit_len = 0;
  return n;
}

// Tells the platform where the text cursor is, in window (client) logical
// coordinates, so the IME's candidate window / composition UI appears next to the
// caret instead of at a default corner. Pure pass-through: the AS3 side owns the
// caret geometry (it is the only side that knows the layout) and calls this
// whenever the composing field's caret moves or focus changes.
void sk_window_set_text_input_rect(int id, double x, double y, double w, double h) {
  if (id < 0 || id >= SK_MAX_WINDOWS) return;
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  SDL_Rect r;
  r.x = (int)(x + 0.5);
  r.y = (int)(y + 0.5);
  r.w = (int)(w + 0.5);
  r.h = (int)(h + 0.5);
  SDL_SetTextInputRect(&r);
}

// Copies the clipboard's text into `buf` (NUL-terminated, truncated to cap-1)
// and returns the number of bytes written, or 0 when the clipboard holds no
// text. SDL_GetClipboardText hands back a fresh buffer the caller must free.
int sk_clipboard_get_text(char* buf, int cap) {
  ensure_video();
  if (buf == NULL || cap <= 0) return 0;
  buf[0] = '\0';
  char* s = SDL_GetClipboardText();
  if (s == NULL) return 0;
  int n = (int)strlen(s);
  if (n > cap - 1) n = cap - 1;
  memcpy(buf, s, (size_t)n);
  buf[n] = '\0';
  SDL_free(s);
  return n;
}

// The shared event loop. Every window is polled, paced and presented from here;
// the loop runs until no window is left (AIR's NativeApplication.autoExit
// behaviour, which is what SDL's own "quit on last window close" matches).
static void sk_run_loop(void) {
  double now = (double)SDL_GetTicks();
  // Rolling deadline of the ONE application frame (see step 4).
  g_app_next = now;
  SDL_Event e;
  while (sk_any_open()) {
    // 1. Frame boundary: retire windows whose close was requested last frame.
    sk_service_destroy();
    if (!sk_any_open()) break;

    // 2. Poll input, routing each event to the window that owns it.
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) {
        // SDL posts QUIT only once the LAST window is gone, so this is the same
        // condition sk_any_open() tests; retiring everything keeps the two in
        // agreement instead of leaving a stale slot behind.
        for (int i = 0; i < SK_MAX_WINDOWS; i++) {
          if (g_wins[i].used) g_wins[i].destroy_pending = 1;
        }
        continue;
      }
      int id = sk_id_from_window_id(
          e.type == SDL_WINDOWEVENT ? e.window.windowID :
          e.type == SDL_MOUSEMOTION ? e.motion.windowID :
          e.type == SDL_MOUSEBUTTONDOWN || e.type == SDL_MOUSEBUTTONUP ? e.button.windowID :
          e.type == SDL_MOUSEWHEEL ? e.wheel.windowID :
          e.type == SDL_TEXTINPUT ? e.text.windowID :
          e.type == SDL_KEYDOWN || e.type == SDL_KEYUP ? e.key.windowID : 0);
      if (id < 0) continue;
      WinCtx* c = &g_wins[id];
      if (c->destroy_pending) continue;
      switch (e.type) {
        case SDL_WINDOWEVENT:
          if (e.window.event == SDL_WINDOWEVENT_CLOSE) {
            // The user (or the OS) asked this window to go away. Route it through
            // the same deferred teardown close() uses, so the CLOSE dispatch and
            // the `closed` flag behave identically for both paths.
            c->destroy_pending = 1;
          } else if (e.window.event == SDL_WINDOWEVENT_EXPOSED) {
            c->dirty = 1;
          } else if (e.window.event == SDL_WINDOWEVENT_LEAVE) {
            // The pointer left the window. macOS can keep a cursor installed by
            // the last window (SDL_SetCursor is not per-window), so an I-beam
            // would otherwise follow the pointer onto the menu bar / desktop.
            sk_window_set_cursor(id, SK_CURSOR_ARROW);
          }
          // SIZE_CHANGED/RESIZED are handled by live_resize_watch during pump.
          break;
        case SDL_MOUSEMOTION:
          if (c->on_mouse) {
            c->on_mouse(id, (double)e.motion.x, (double)e.motion.y, "mouseMove");
            c->dirty = 1;
          }
          break;
        case SDL_MOUSEBUTTONDOWN:
          if (e.button.button == SDL_BUTTON_LEFT && c->on_mouse) {
            c->on_mouse(id, (double)e.button.x, (double)e.button.y, "mouseDown");
            // Second press of a double click: AIR extends the selection to the whole
            // word right HERE, at the mouseDown — before the mouseUp and the click
            // event — so a listener on "click" already sees the word selected and
            // typing replaces it instead of inserting. Measured on adl 51.4.1
            // (temp/editprobe/drive_ed2.py step 12: after the double click the field
            // holds (0,2) and typing "9" leaves the single character "9", not the
            // insertion "789").
            // It rides the on_mouse channel under the reserved "wordSelect" type:
            // text-editing state, never an AS3 MouseEvent (the AS3 bridge intercepts
            // it — see ASC_window_on_mouse in the emitter).
            if (e.button.clicks >= 2)
              c->on_mouse(id, (double)e.button.x, (double)e.button.y, "wordSelect");
            c->dirty = 1;
          }
          break;
        case SDL_MOUSEBUTTONUP:
          if (e.button.button == SDL_BUTTON_LEFT && c->on_mouse) {
            c->on_mouse(id, (double)e.button.x, (double)e.button.y, "mouseUp");
            // Second click of a double click: AIR REPLACES that click with a
            // single "doubleClick" event (a double click is down,up,click,
            // down,up,doubleClick -- there is no second click; a triple click is
            // click,doubleClick,click, i.e. clickCount 3 is a plain click again).
            // Measured on adl 51.4.1 (temp/editprobe/drive_ed9.py, log
            // adl_ed9.txt). SDL's e.button.clicks carries the platform click
            // count, so it is exactly 2 for the middle press. The reserved
            // "dblclick" type is resolved AS3-side (ASC_window_on_mouse) because
            // the gate -- the HIT TARGET's own doubleClickEnabled -- is not
            // visible here: it becomes "doubleClick" or a plain "click".
            c->on_mouse(id, (double)e.button.x, (double)e.button.y,
                        e.button.clicks == 2 ? "dblclick" : "click");
            c->dirty = 1;
          }
          break;
        case SDL_KEYDOWN:
        case SDL_KEYUP:
          // Auto-repeat is NOT filtered: measured on adl 51.4.1 by posting
          // 1 plain keyDown + 8 keyDowns flagged kCGKeyboardEventAutorepeat=1
          // (temp/xformcmp/seldir/repeat_probe.py); AIR delivered all 9
          // keyDowns, so a held key keeps producing keyDown here too.
          // (The earlier "hold the key and count" test was inconclusive:
          // reptap.py shows a synthetic hold produces no OS repeats at all.)
          if (c->on_key) {
            int kc = 0, cc = 0;
            // keysym.mod is Uint16 in this SDL2, not SDL_Keymod.
            SDL_Keymod mod = (SDL_Keymod)e.key.keysym.mod;
            sk_key_map(e.key.keysym.sym, mod, &kc, &cc);
            c->on_key(id, e.type == SDL_KEYDOWN ? "keyDown" : "keyUp", kc, cc,
                      sk_mod_mask(mod));
            // A key can change what is on screen (an app moves something on
            // keyDown), so request a repaint exactly like a mouse event does.
            c->dirty = 1;
          }
          break;
        case SDL_TEXTEDITING:
          // The IME's MARKED text (a pinyin syllable before it is committed, a
          // Japanese reading before conversion, ...). SDL re-sends the whole
          // composition on every change, and sends it EMPTY when the composition
          // ends (committed => a following SDL_TEXTINPUT carries the result, or
          // cancelled => nothing follows). It rides the same on_key channel under
          // the reserved type "textEditing", exactly like "textInput", so the
          // callback signature list stays put; the AS3 side drains it with
          // sk_window_text_edit_take().
          if (c->on_key) {
            const char* t = e.edit.text;
            strncpy(c->edit_text, t != NULL ? t : "", sizeof(c->edit_text) - 1);
            c->edit_text[sizeof(c->edit_text) - 1] = '\0';
            c->edit_start = e.edit.start;
            c->edit_len = e.edit.length;
            c->on_key(id, "textEditing", 0, 0, 0);
            c->dirty = 1;
          }
          break;
        case SDL_TEXTINPUT:
          // The OS's text for the keystroke just delivered as keyDown. AIR models
          // this as TextEvent.TEXT_INPUT (measured: keyDown -> textInput -> change),
          // so hand the bytes to the AS3 side under the reserved "textInput" type.
          // An empty commit is still forwarded: AIR dispatches textInput for input
          // the field will reject (measured at maxChars), where the payload matters.
          if (c->on_key) {
            const char* t = e.text.text;
            // The per-event cap is SDL_TEXTINPUTEVENT_TEXT_SIZE (32); keep the last
            // commit instead of concatenating, matching SDL's one-event-one-commit
            // model (and the per-key textInput adl dispatches).
            strncpy(c->text, t != NULL ? t : "", sizeof(c->text) - 1);
            c->text[sizeof(c->text) - 1] = '\0';
            c->on_key(id, "textInput", 0, 0, 0);
            c->dirty = 1;
          }
          break;
        case SDL_MOUSEWHEEL: {
          // SDL_MOUSEWHEEL carries no position, so sample the cursor like AIR
          // does (the wheel event targets whatever sits under the pointer).
          // e.wheel.y is positive when scrolling up, matching MouseEvent.delta.
          if (c->on_wheel) {
            int mx = 0, my = 0;
            SDL_GetMouseState(&mx, &my);
            c->on_wheel(id, (double)mx, (double)my, (double)e.wheel.y);
            c->dirty = 1;
          }
          break;
        }
        default:
          break;
      }
    }

    // 3-5. Service resizes, dispatch the one application frame if it is due, and
    //      repaint every dirty visible window. This is the same function the
    //      live-resize watch runs, so a frame during a drag is literally the same
    //      frame as a frame here — same clock, same deadline, same dirtying rule.
    //      See sk_pump_frame.
    double earliest = sk_pump_frame();

    // 6. Sleep to the application frame deadline. Sleeping *to* a rolling deadline
    // (rather than for a fixed delay after each frame) absorbs the
    // rasterize+present cost so the loop sustains the requested frameRate instead
    // of falling short.
    if (earliest > 0.0) {
      double t = (double)SDL_GetTicks();
      if (earliest > t) SDL_Delay((Uint32)(earliest - t));
    } else {
      SDL_Delay(1);
    }
  }
  sk_service_destroy();
}

// ---------- window creation ----------

// Common window setup shared by the main window and every NativeWindow. Returns
// the registry id, or -1 on failure.
static int sk_open_window(int w, int h, const char* title, int decorated, int visible, int fullscreen, int highdpi, int is_main) {
  Uint32 winFlags = visible ? SDL_WINDOW_SHOWN : SDL_WINDOW_HIDDEN;
#ifndef ASC_WINDOW_FIXED
  winFlags |= SDL_WINDOW_RESIZABLE;
#endif
  if (highdpi) winFlags |= SDL_WINDOW_ALLOW_HIGHDPI;
  if (!decorated) winFlags |= SDL_WINDOW_BORDERLESS;
  SDL_Window* win = SDL_CreateWindow(
      title ? title : "AS3", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
      w, h, winFlags);
  if (win == NULL) {
    fprintf(stderr, "window_glue: SDL_CreateWindow failed: %s\n", SDL_GetError());
    return -1;
  }
  // Stage.displayState = FULL_SCREEN is applied here, before the event loop
  // (SDL_WINDOW_FULLSCREEN_DESKTOP keeps the desktop resolution).
  if (fullscreen) SDL_SetWindowFullscreen(win, SDL_WINDOW_FULLSCREEN_DESKTOP);
  // Editable text needs SDL_TEXTINPUT, and SDL only produces it for a window with
  // text input started. macOS happens to deliver it anyway, but Windows does not
  // (it needs WM_CHAR, which SDL_StartTextInput turns on), so ask explicitly — the
  // call is a no-op where it is already the default.
  SDL_StartTextInput();
  int id = is_main ? sk_alloc_slot_main() : sk_alloc_slot();
  if (id < 0) { SDL_DestroyWindow(win); return -1; }
  WinCtx* c = &g_wins[id];
  c->win = win;
  c->visible = visible;
  c->pixfmt = SDL_MasksToPixelFormatEnum(32, 0x000000FFu, 0x0000FF00u, 0x00FF0000u, 0xFF000000u);
  sk_measure_borders(c, decorated);
  return id;
}

// Attach a renderer + streaming texture to a window that renders on the CPU.
// The main window uses this too unless the app asked for the Metal backend.
static int sk_attach_cpu(WinCtx* c) {
  // Prefer the hardware renderer (Metal) — the final blit and present are far
  // cheaper there than in SDL_RENDERER_SOFTWARE, which is the real ceiling at
  // high Stage.frameRate. Fall back to software when no GPU is available.
  SDL_Renderer* ren = SDL_CreateRenderer(c->win, -1, SDL_RENDERER_ACCELERATED);
  if (ren == NULL) ren = SDL_CreateRenderer(c->win, -1, SDL_RENDERER_SOFTWARE);
  if (ren == NULL) {
    fprintf(stderr, "window_glue: SDL_CreateRenderer failed: %s\n", SDL_GetError());
    return 0;
  }
  c->ren = ren;
  // Enable vsync so SDL_RenderPresent blocks until the display's next refresh.
  // The monitor can only show 50 frames/sec on a 50 Hz panel — no amount of
  // CPU-side pacing can change that. Disabling vsync and chasing a 120 Hz target
  // there just makes the logical frame rate beat against the 50 Hz refresh
  // (120 vs 50), jittering the frame interval so delta-time animation stutters.
  // With vsync on the present step enforces an even interval equal to the refresh
  // period, and the event-loop pacer caps its deadline to that same rate — the
  // cadence stays uniform (and smooth) on every display. SDL_RenderSetVSync has
  // existed since SDL 2.0.18; we pin 2.32.
  SDL_RenderSetVSync(ren, 1);
  return 1;
}

// Hand the AS3 side's raster surface to a window and build its streaming texture.
// Called right after window creation, because the surface must be sized from the
// window's real physical pixel size (which is only knowable once the window
// exists) and the AS3 side is the only owner of that surface.
void sk_window_attach_surface(int id, void* surface, int pw, int ph) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->is_gpu) return;
  c->surface = surface;
  c->pw = pw; c->ph = ph;
  if (!sk_surface_peek_pixels(c->surface, &c->pixels, &c->rowBytes)) {
    fprintf(stderr, "window_glue: surface does not expose pixels (not CPU raster)\n");
    return;
  }
  if (c->tex != NULL) SDL_DestroyTexture(c->tex);
  c->tex = SDL_CreateTexture(c->ren, c->pixfmt, SDL_TEXTUREACCESS_STREAMING, c->pw, c->ph);
  if (c->tex != NULL) SDL_SetTextureBlendMode(c->tex, SDL_BLENDMODE_NONE);
  c->dirty = 1;
}

// Show a Skia offscreen raster surface in a window and block on the SDL event
// loop until every window has closed. Returns 1 on a clean run, 0 on any setup
// failure. The surface is never owned here — the caller (Stage_showWindow)
// still deletes it after this returns.
//
// Input events are forwarded to `on_mouse` (left-button mouseDown/mouseUp/click
// at the window-relative coordinates); after each handled event `on_redraw` is
// called so the AS3 tree re-renders, then the updated pixels are presented.
//
// Pixel format note: on little-endian macOS, Skia's kN32 premultiplied surface
// stores pixels in memory as R,G,B,A bytes, so each pixel read back as a uint32
// is 0xAABBGGRR (R in the low byte, B in the high byte). The explicit channel
// masks below are therefore R/G/B/A = 0x000000FF/0x0000FF00/0x00FF0000/0xFF000000.
// The naive 0xAARRGGBB ordering swaps red and blue, which a blue-rectangle
// render exposed — so this ordering is load-bearing, not cosmetic.
// `w`/`h` are the logical window size (AIR's <width>/<height>); `pw`/`ph` are
// the pixel dimensions of the surface handed in, which the caller sized using
// sk_window_probe_scale. When they match the window's drawable size the blit is
// 1:1 and text stays crisp; any mismatch and SDL resamples (blur).
int sk_window_show(void* surface, int w, int h, int pw, int ph, const char* title,
                   int fullscreen, sk_mouse_cb on_mouse, sk_wheel_cb on_wheel,
                   sk_key_cb on_key,
                   sk_redraw_cb on_redraw, sk_frame_cb on_frame,
                   sk_frame_delay_cb on_frame_delay, sk_resize_cb on_resize,
                   sk_close_cb on_close) {
  ensure_video();
  if (sk_video_init() != 0) {
    fprintf(stderr, "window_glue: SDL_Init failed: %s\n", SDL_GetError());
    return 0;
  }

  // Refresh the cached display size while SDL is initialized.
  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_w = dm.w; g_display_h = dm.h;
    g_display_refresh = (double)dm.refresh_rate;
  }

  // The app's own initial window is always chrome-decorated: AIR's initial window
  // takes its systemChrome from the descriptor, and an app.xml that asks for
  // `none` is rare enough that the border difference is reported rather than
  // guessed at here.
  int id = sk_open_window(w, h, title, 1, 1, fullscreen,
#ifdef ASC_DISPLAY_HIGH
                         1, 1
#else
                         0, 1
#endif
  );
  if (id < 0) { SDL_Quit(); return 0; }
  WinCtx* c = &g_wins[id];
  c->on_mouse = on_mouse;
  c->on_wheel = on_wheel;
  c->on_key = on_key;
  c->on_resize = on_resize;
  c->on_redraw = on_redraw;
  c->on_frame = on_frame;
  c->on_frame_delay = on_frame_delay;
  c->on_close = on_close;
  if (!sk_attach_cpu(c)) {
    c->destroy_pending = 1;
    sk_service_destroy();
    SDL_Quit();
    return 0;
  }
  if (!sk_surface_peek_pixels(surface, &c->pixels, &c->rowBytes)) {
    fprintf(stderr, "window_glue: surface does not expose pixels (not CPU raster)\n");
    c->destroy_pending = 1;
    sk_service_destroy();
    SDL_Quit();
    return 0;
  }
  c->surface = surface;
  c->pw = pw; c->ph = ph;

  // Initial frame (the surface is already rasterized by Stage_showWindow).
  // The streaming texture is created once and updated in place every frame; the
  // format is derived from the exact channel masks so it can never mismatch.
  c->tex = SDL_CreateTexture(c->ren, c->pixfmt, SDL_TEXTUREACCESS_STREAMING, pw, ph);
  if (c->tex != NULL) SDL_SetTextureBlendMode(c->tex, SDL_BLENDMODE_NONE);
  present_frame(c->ren, c->tex, c->pixels, c->pw, c->ph, c->rowBytes);

  // Register the live-resize filter so a drag keeps rendering (see WinCtx).
  SDL_AddEventWatch(live_resize_watch, c);

  sk_run_loop();

  SDL_Quit();
  return 1;
}

#ifdef ASC_RENDER_METAL
// Attach a CAMetalLayer-backed view to a window and bind that layer to the Metal
// backend. Shared by the initial window (sk_window_show_metal) and every
// NativeWindow created with gpu=1, so both get the identical setup — the same
// reason the seven callbacks are parameterised rather than installed afterwards.
static int sk_attach_metal(WinCtx* c, int id) {
  SDL_MetalView view = SDL_Metal_CreateView(c->win);
  if (view == NULL) {
    fprintf(stderr, "window_glue: SDL_Metal_CreateView failed: %s\n", SDL_GetError());
    return 0;
  }
  void* layer = SDL_Metal_GetLayer(view);
  if (layer == NULL || !sk_mtl_init(id, layer)) {
    fprintf(stderr, "window_glue: Metal backend init failed\n");
    SDL_Metal_DestroyView(view);
    return 0;
  }
  c->metal_view = view;
  c->is_gpu = 1;
  return 1;
}
#endif  // ASC_RENDER_METAL

#ifdef ASC_RENDER_D3D
// Attach a D3D12 swapchain to a window. The mirror of sk_attach_metal above: this
// file owns the SDL2 window and the event loop, d3d_glue.cc owns everything GPU.
// The one thing that must cross is the HWND — it is what CreateSwapChainForHwnd
// binds the swapchain to — so it is fetched here, where the SDL_Window lives, and
// passed in as the backend's native handle. No renderer/texture is created: a GPU
// window presents through its swapchain (sk_gpu_flush), never through SDL's
// renderer.
static int sk_attach_d3d(WinCtx* c, int id) {
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info)) {
    fprintf(stderr, "window_glue: SDL_GetWindowWMInfo failed: %s\n", SDL_GetError());
    return 0;
  }
  if (info.subsystem != SDL_SYSWM_WINDOWS) {
    // Loud, not silent (AGENTS.md \u00a71.5): a D3D build on a non-Windows WM is a
    // build/backend mismatch, and a CPU window here would be a wrong result.
    fprintf(stderr, "window_glue: the D3D12 backend needs a native Windows window (subsystem %d)\n", (int)info.subsystem);
    return 0;
  }
  if (!sk_gpu_init(id, (void*)info.info.win.window)) {
    fprintf(stderr, "window_glue: D3D12 backend init failed\n");
    return 0;
  }
  c->is_gpu = 1;
  return 1;
}
#endif  // ASC_RENDER_D3D

// Backend-neutral GPU attach — the only name the rest of this file uses. Exactly
// one branch is compiled in: ASC_RENDER_METAL on macOS (air-app.ts), ASC_RENDER_D3D
// on Windows. With neither (a plain CPU build) no caller can reach this at all,
// because sk_window_create zeroes the request above and STAGE_showWindow only
// emits the call under ASC_RENDER_WINGPU.
static int sk_attach_gpu(WinCtx* c, int id) {
#if defined(ASC_RENDER_METAL)
  return sk_attach_metal(c, id);
#elif defined(ASC_RENDER_D3D)
  return sk_attach_d3d(c, id);
#else
  (void)c; (void)id;
  fprintf(stderr, "window_glue: no GPU window backend is compiled in\n");
  return 0;
#endif
}

#ifdef ASC_RENDER_METAL
// Metal GPU window backend: the same event loop as sk_window_show above, but the
// presentation path is completely different. Instead of a persistent CPU raster
// surface that is peeked and blitted through an SDL streaming texture, the
// window owns a CAMetalLayer (via SDL_Metal_CreateView + SDL_Metal_GetLayer) and
// a GrDirectContext(Metal) (via metal_glue.mm). Every frame on_redraw re-acquires
// a one-shot drawable, rasterizes the tree into it on the GPU, and presents it
// — no CPU pixel round-trip. There is no surface to pass in or hand back on
// resize: the drawable is rebuilt per frame and sized from the window's own
// physical dimensions, so on_resize only has to update the AS3-side stage
// dimensions and device scale (its return value is ignored).
int sk_window_show_metal(int w, int h, const char* title, int fullscreen,
                         sk_mouse_cb on_mouse, sk_wheel_cb on_wheel,
                         sk_key_cb on_key,
                         sk_redraw_cb on_redraw, sk_frame_cb on_frame,
                         sk_frame_delay_cb on_frame_delay, sk_resize_cb on_resize,
                         sk_close_cb on_close) {
  ensure_video();
  if (sk_video_init() != 0) {
    fprintf(stderr, "window_glue: SDL_Init failed: %s\n", SDL_GetError());
    return 0;
  }

  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_w = dm.w; g_display_h = dm.h;
    g_display_refresh = (double)dm.refresh_rate;
  }

  int id = sk_open_window(w, h, title, 1, 1, fullscreen, 1, 1);
  if (id < 0) { SDL_Quit(); return 0; }
  WinCtx* c = &g_wins[id];
  c->on_mouse = on_mouse;
  c->on_wheel = on_wheel;
  c->on_key = on_key;
  c->on_resize = on_resize;
  c->on_redraw = on_redraw;
  c->on_frame = on_frame;
  c->on_frame_delay = on_frame_delay;
  c->on_close = on_close;

  // Attach a CAMetalLayer-backed view and hand its layer to the Metal backend.
  if (!sk_attach_metal(c, id)) {
    c->destroy_pending = 1;
    sk_service_destroy();
    SDL_Quit();
    return 0;
  }

  // Report the initial physical size + device scale to the AS3 side so its
  // first frame is sized correctly. SDL_GetWindowSizeInPixels is authoritative
  // for the drawable backing (matches CAMetalLayer.drawableSize).
  int lw = w, lh = h, pw = w, ph = h;
  SDL_GetWindowSize(c->win, &lw, &lh);
  SDL_GetWindowSizeInPixels(c->win, &pw, &ph);
  double scale = (lw > 0) ? (double)pw / (double)lw : 1.0;
  c->pw = pw; c->ph = ph;
  if (on_resize) on_resize(id, lw, lh, pw, ph, scale);

  // Arm the live-resize watch on the MAIN window too. sk_window_create arms it
  // for every NativeWindow, but the main window is opened here (and by the D3D
  // entry below) and was left without one — and since the loop is blocked inside
  // SDL for the whole of a drag/resize, a main-window drag froze its animation
  // completely while a secondary window's kept running.
  SDL_AddEventWatch(live_resize_watch, c);

  sk_run_loop();

  // The loop retires every window on its way out — sk_service_destroy() has
  // already released the Metal state and destroyed the view — so there is nothing
  // left to release here.
  SDL_Quit();
  return 1;
}
#endif  // ASC_RENDER_METAL

#ifdef ASC_RENDER_WINGPU
// GPU window backend, named by the generated C / runtime seam and dispatch to
// whichever concrete backend this build linked. The event loop, the input
// plumbing, the cursor/display queries and the per-frame callback contract are
// identical across backends — Skia just rasterizes into a different kind of
// surface — so the only genuinely per-backend part is the attach step, which
// sk_attach_gpu already hides. Running one shared loop rather than duplicating
// sk_window_show_metal is what keeps a Windows-only divergence from being able to
// affect the macOS path (and vice versa).
int sk_window_show_gpu(int w, int h, const char* title, int fullscreen,
                       sk_mouse_cb on_mouse, sk_wheel_cb on_wheel,
                       sk_key_cb on_key,
                       sk_redraw_cb on_redraw, sk_frame_cb on_frame,
                       sk_frame_delay_cb on_frame_delay, sk_resize_cb on_resize,
                       sk_close_cb on_close) {
#if defined(ASC_RENDER_METAL)
  // The Metal path has its own loop entry (sk_window_show_metal) because it was
  // written before this seam existed; it is the identical sequence, so delegate
  // rather than fork the two.
  return sk_window_show_metal(w, h, title, fullscreen, on_mouse, on_wheel, on_key,
                              on_redraw, on_frame, on_frame_delay, on_resize, on_close);
#elif defined(ASC_RENDER_D3D)
  ensure_video();
  if (sk_video_init() != 0) {
    fprintf(stderr, "window_glue: SDL_Init failed: %s\n", SDL_GetError());
    return 0;
  }

  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_w = dm.w; g_display_h = dm.h;
    g_display_refresh = (double)dm.refresh_rate;
  }

  int id = sk_open_window(w, h, title, 1, 1, fullscreen, 1, 1);
  if (id < 0) { SDL_Quit(); return 0; }
  WinCtx* c = &g_wins[id];
  c->on_mouse = on_mouse;
  c->on_wheel = on_wheel;
  c->on_key = on_key;
  c->on_resize = on_resize;
  c->on_redraw = on_redraw;
  c->on_frame = on_frame;
  c->on_frame_delay = on_frame_delay;
  c->on_close = on_close;

  if (!sk_attach_gpu(c, id)) {
    c->destroy_pending = 1;
    sk_service_destroy();
    SDL_Quit();
    return 0;
  }

  // Report the initial physical size + device scale, exactly as the Metal path
  // does: the first frame is sized from the swapchain's real back-buffer size.
  int lw = w, lh = h, pw = w, ph = h;
  SDL_GetWindowSize(c->win, &lw, &lh);
  SDL_GetWindowSizeInPixels(c->win, &pw, &ph);
  double scale = (lw > 0) ? (double)pw / (double)lw : 1.0;
  c->pw = pw; c->ph = ph;
  if (on_resize) on_resize(id, lw, lh, pw, ph, scale);

  // Arm the live-resize watch on the MAIN window, exactly as the macOS entry
  // above does: the drag/resize modal loop blocks sk_run_loop inside SDL, so the
  // watch is what keeps every window's animation running for its duration.
  SDL_AddEventWatch(live_resize_watch, c);

  sk_run_loop();
  SDL_Quit();
  return 1;
#else
  (void)w; (void)h; (void)title; (void)fullscreen;
  (void)on_mouse; (void)on_wheel; (void)on_key;
  (void)on_redraw; (void)on_frame; (void)on_frame_delay; (void)on_resize; (void)on_close;
  return 0;
#endif
}
#endif  // ASC_RENDER_WINGPU

// ---------- NativeWindow (flash.display.NativeWindow) ----------
// Everything below backs AIR's dynamic window API: an app can open extra windows
// at runtime and drive them (bounds, title, visibility, activation, close).
// `w`/`h` here are the CONTENT size, matching what SDL measures; NativeWindow's
// bounds arithmetic on the AS3 side adds the frame borders back on.

int sk_window_create(int w, int h, const char* title, int resizable, int decorated, int highdpi,
                     int gpu,
                     sk_mouse_cb on_mouse, sk_wheel_cb on_wheel,
                     sk_key_cb on_key,
                     sk_redraw_cb on_redraw, sk_frame_cb on_frame,
                     sk_frame_delay_cb on_frame_delay, sk_resize_cb on_resize,
                     sk_close_cb on_close) {
  ensure_video();
  if (sk_video_init() != 0) return -1;
  // A new NativeWindow starts HIDDEN (measured: w.visible is false right after
  // the constructor) and becomes visible on activate(), so open it hidden.
  int id = sk_open_window(w, h, title, decorated, 0, 0, highdpi, 0);
  if (id < 0) return -1;
  WinCtx* c = &g_wins[id];
  c->visible = 0;
  // Install the same callback set the main window gets in sk_window_show*().
  // Without these a secondary window is a dead rectangle: on_redraw absent means
  // nothing is ever rasterized or presented, on_frame absent means its stage
  // never ticks, on_mouse absent means it receives no input, and on_resize
  // absent means do_resize() would resize the texture without re-peeking the
  // (new) surface pixels.
  c->on_mouse = on_mouse;
  c->on_wheel = on_wheel;
  c->on_key = on_key;
  c->on_resize = on_resize;
  c->on_redraw = on_redraw;
  c->on_frame = on_frame;
  c->on_frame_delay = on_frame_delay;
  c->on_close = on_close;
  if (!resizable) SDL_SetWindowResizable(c->win, SDL_FALSE);
  // Backend choice. The AS3 side passes gpu=1 when NativeWindowInitOptions.
  // renderMode asks for the GPU — which is AIR's default ('auto') and also what
  // 'direct' and 'gpu' mean. ASC_RENDER_WINGPU is a build-wide define, so in a
  // build without a GPU window backend the request cannot be honoured and the CPU
  // path is the only one that exists (the generated C asks for gpu=0 there, so
  // the two sides never disagree about what the window is).
#ifndef ASC_RENDER_WINGPU
  gpu = 0;
#endif
  int attached = 0;
#ifdef ASC_RENDER_WINGPU
  if (gpu) attached = sk_attach_gpu(c, id);
#endif
  if (!attached && !sk_attach_cpu(c)) {
    c->destroy_pending = 1;
    sk_service_destroy();
    return -1;
  }
  // AIR centers a new window's FRAME on the display (measured on adl: 700,469 for
  // a 400x232 frame on a 1800x1169 display), whereas SDL_WINDOWPOS_CENTERED centers
  // the CLIENT area — which would place the frame 16pt above adl's. Re-place it so
  // bounds matches adl's measured numbers; the +1 before halving reproduces adl's
  // rounding of the .5 remainder (1800-400 -> 700, 1169-232 -> 469).
  //
  // Center on the display SDL actually put the window on, NOT display 0: SDL's
  // display indices come from the OS and 0 is not guaranteed to be the primary
  // monitor. On a two-display machine where 0 is a secondary screen, centering on
  // 0 moved new windows off-screen (measured: display 0 = 2560x1707 @(-333,-1707),
  // so y came out around -1377). SDL places a fresh window on the display it
  // chooses, so its index is the right one; fall back to 0 if SDL cannot say.
  int disp = SDL_GetWindowDisplayIndex(c->win);
  if (disp < 0) disp = 0;
  int dx = 0, dy = 0, dw = 0, dh = 0;
  if (sk_display_bounds(disp, &dx, &dy, &dw, &dh)) {
    int fw = w + c->b_left + c->b_right;
    int fh = h + c->b_top + c->b_bottom;
    SDL_SetWindowPosition(c->win, dx + (dw - fw + 1) / 2, dy + (dh - fh + 1) / 2 + c->b_top);
  }
  SDL_AddEventWatch(live_resize_watch, c);
  return id;
}

void sk_window_set_visible(int id, int visible) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) return;
  c->visible = visible ? 1 : 0;
  if (visible) { SDL_ShowWindow(c->win); c->dirty = 1; }
  else SDL_HideWindow(c->win);
}

int sk_window_get_visible(int id) {
  WinCtx* c = sk_slot(id);
  return c != NULL ? c->visible : 0;
}

void sk_window_set_title(int id, const char* title) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_SetWindowTitle(c->win, title ? title : "");
}

// ---- mouse pointer shape -------------------------------------------------
// AIR's TextField (and Mouse.cursor) decide the pointer shape; the generated C
// computes the kind and calls sk_window_set_cursor with it. The kinds are
// declared at the top of this file (SK_CURSOR_*) and mirror the AS_CURSOR_*
// block in runtime.ts — the two lists must stay in step.

// SDL_CreateSystemCursor is expensive (an NSCursor per call) and a mouse move
// fires dozens of times a second, so each kind is created once and cached.
static SDL_Cursor* g_cursors[4];
// SDL2 has no per-window cursor API: SDL_SetCursor installs the cursor for the
// window that currently has mouse focus. Tracking the LAST INSTALLED kind (and
// not a per-window one) is therefore what keeps the pointer correct as it crosses
// from a text field in one window to bare background in another, while still
// skipping the SDL call when the shape did not actually change.
static int g_cursor_kind = SK_CURSOR_ARROW;

static SDL_Cursor* sk_cursor_for(int kind) {
  if (kind < 0 || kind > 3) kind = SK_CURSOR_ARROW;
  if (g_cursors[kind] == NULL) {
    SDL_SystemCursor sys = SDL_SYSTEM_CURSOR_ARROW;
    if (kind == SK_CURSOR_IBEAM) sys = SDL_SYSTEM_CURSOR_IBEAM;
    else if (kind == SK_CURSOR_HAND) sys = SDL_SYSTEM_CURSOR_HAND;
    // SDL2 ships no "button" system cursor, so MouseCursor.BUTTON has no exact
    // counterpart here and falls back to the arrow (the closest available one).
    g_cursors[kind] = SDL_CreateSystemCursor(sys);
  }
  return g_cursors[kind];
}

void sk_window_set_cursor(int id, int kind) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  if (kind < 0 || kind > 3) kind = SK_CURSOR_ARROW;
  if (kind == g_cursor_kind) return;
  SDL_Cursor* cur = sk_cursor_for(kind);
  if (cur == NULL) return;
  g_cursor_kind = kind;
  SDL_SetCursor(cur);
}

// Bounds are AIR's OUTER frame rectangle. Both SDL calls take the CLIENT area
// (verified: SDL_SetWindowPosition positions the content top-left, SDL_SetWindowSize
// sizes the content), so the frame rect is converted on the way in: a 600x410 frame
// with a 32pt title bar becomes a 600x378 client placed at y+32 — which is why
// stage.stageHeight comes out 378 under NO_SCALE, exactly as measured on adl.
void sk_window_set_bounds(int id, int x, int y, int w, int h) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  int cw = w - c->b_left - c->b_right;
  int ch = h - c->b_top - c->b_bottom;
  if (cw < 1) cw = 1;
  if (ch < 1) ch = 1;
  SDL_SetWindowPosition(c->win, x, y + c->b_top);
  SDL_SetWindowSize(c->win, cw, ch);
}

void sk_window_get_bounds(int id, int* x, int* y, int* w, int* h) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) {
    if (x) *x = 0; if (y) *y = 0; if (w) *w = 0; if (h) *h = 0;
    return;
  }
  int px = 0, py = 0, cw = 0, ch = 0;
  SDL_GetWindowPosition(c->win, &px, &py);
  SDL_GetWindowSize(c->win, &cw, &ch);
  if (x) *x = px;
  if (y) *y = py - c->b_top;   // SDL reports the client top; the frame starts above it
  if (w) *w = cw + c->b_left + c->b_right;
  if (h) *h = ch + c->b_top + c->b_bottom;
}

// Request teardown. The window is NOT destroyed here: it is retired at the next
// loop frame boundary, which is what makes NativeWindow.closed stay false for the
// remainder of the call that invoked close() (measured against adl) and what
// keeps the CLOSE dispatch out of the caller's own stack frame.
void sk_window_close(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL) c->destroy_pending = 1;
}

int sk_window_is_closed(int id) {
  return sk_slot(id) == NULL ? 1 : 0;
}

// A NativeWindow is created hidden and raised by activate(), which per adl also
// makes it visible — the two are one gesture there, so they are one call here.
void sk_window_activate(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  if (!c->visible) { c->visible = 1; SDL_ShowWindow(c->win); c->dirty = 1; }
  SDL_RaiseWindow(c->win);
}

void sk_window_minimize(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_MinimizeWindow(c->win);
}

void sk_window_maximize(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_MaximizeWindow(c->win);
}

void sk_window_restore(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_RestoreWindow(c->win);
}

void sk_window_order_front(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_RaiseWindow(c->win);
}

void sk_window_order_back(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_ShowWindow(c->win);
  // SDL has no portable "send to back"; lowering below the app's own other
  // windows is the part that is observable, so hide-then-show is deliberately
  // NOT used (it would flicker). Instead the window is left where it is; the AS3
  // side reports no error, matching AIR's behaviour on platforms that cannot
  // reorder (NativeWindow.orderToBack is a no-op there).
}

// Which display the window sits on, for Screen lookups.
int sk_window_display_index(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return 0;
  int idx = SDL_GetWindowDisplayIndex(c->win);
  return idx >= 0 ? idx : 0;
}

// The window's drawable size in physical pixels, so the AS3 side can size its
// offscreen surface exactly (a mismatch would make SDL resample the blit).
void sk_window_get_pixel_size(int id, int* pw, int* ph) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) { SDL_GetWindowSizeInPixels(c->win, pw, ph); return; }
  if (pw) *pw = 0;
  if (ph) *ph = 0;
}
// The window's logical (client) size. Needed because a bounds write is expressed
// as an OUTER frame rectangle: after SDL resizes the client area, the AS3 side
// reads the resulting client size back so stageWidth/stageHeight under NO_SCALE
// are correct in the same synchronous block (adl reports 600x378 immediately
// after `w.bounds = rect` for a 600x410 frame).
void sk_window_get_client_size(int id, int* lw, int* lh) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) { SDL_GetWindowSize(c->win, lw, lh); return; }
  if (lw) *lw = 0;
  if (lh) *lh = 0;
}
// Keyboard focus. NativeWindow.active is read-only in AIR and reports whether
// the window is the app's active window — SDL's input focus is the same notion.
int sk_window_is_active(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return 0;
  // SDL only updates SDL_WINDOW_INPUT_FOCUS when events are pumped, and AS3 can
  // read `active` immediately after activate() — before the loop's next poll. Pump
  // first so the answer reflects the OS's current focus (measured: false without
  // this, true with it; adl reports activate() -> active == true).
  SDL_PumpEvents();
  return (SDL_GetWindowFlags(c->win) & SDL_WINDOW_INPUT_FOCUS) ? 1 : 0;
}
// NativeWindow.alwaysInFront. SDL_SetWindowAlwaysOnTop exists since 2.0.16
// (we pin 2.32).
void sk_window_set_always_in_front(int id, int on) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  c->always_in_front = on ? 1 : 0;
  SDL_SetWindowAlwaysOnTop(c->win, on ? SDL_TRUE : SDL_FALSE);
}

// The main window's id, for the generated boot code (Stage.showWindow).
int sk_window_main(void) { return g_main; }

}  // extern "C"