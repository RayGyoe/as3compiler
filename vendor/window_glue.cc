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
// CGImage/CGDataProvider for the transparent-window present path (see
// sk_mac_present_layer below). Plain C header, so this file stays C++.
#include <CoreGraphics/CoreGraphics.h>
#include <cstdlib>
#endif

extern "C" {

int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes);
// Byte order of that buffer: 1 = R,G,B,A, 2 = B,G,R,A, 0 = not 32-bit RGBA/BGRA.
// Skia decides this at build time per target platform (R,G,B,A on macOS, B,G,R,A on
// Windows), so it must be asked, never assumed -- see sk_pixfmt_for_surface below.
int sk_surface_pixel_order(void* surface);

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
#if defined(ASC_RENDER_D3D) || defined(ASC_RENDER_GL)
// Native Windows GPU backend (d3d_glue.cc for ASC_RENDER_D3D, gl_glue.cc for
// ASC_RENDER_GL). Same per-window entry points and the same `native_handle` = the
// window's HWND, because both need the one thing this file owns and neither can
// obtain for itself.
//
// What the two share and where they part: the seam is identical (an id-keyed
// begin/draw/flush cycle over a frame-scoped canvas), and both create their GPU
// state per window. They differ in lifetime — D3D shares one ID3D12Device and one
// GrDirectContext across every window, while GL cannot: Skia requires one
// GrDirectContext per GL context, and each window needs its own GL context
// because its render target is that window's default framebuffer.
int sk_gpu_init(int id, void* native_handle);
void sk_gpu_destroy(int id);
#endif

// Cached primary-display size so Stage.fullScreenWidth/fullScreenHeight can be
// read without holding SDL initialized. Populated lazily here and refreshed
// whenever a window is shown -- both writers go through sk_refresh_display_size_cache,
// so the cache can only ever hold the DIP-space value those properties are defined in.
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
  // The SDL Windows IME backend defaults to UILess (TSF) mode, and in that mode the IME
  // does NOT draw its own candidate window: the application is expected to render the
  // candidate list itself through SDL_VideoData::IME_Present(), which no public API in
  // SDL 2.32 ever calls (IME_Present has no caller anywhere in the tree). Measured on
  // Windows 11 + Microsoft Pinyin: the marked text appeared inline at the caret while the
  // candidate list never showed (temp/imelive/q2-type2.png). With this hint the backend
  // keeps the native IMM32 UI alive and the candidate window appears under the caret,
  // positioned by the same ImmSetCandidateWindow call that follows our text-input rect
  // (temp/imelive/q1-type2.png). Set BEFORE SDL_Init: the hint is latched when the video
  // driver brings up the keyboard backend. Guarded because older SDL headers (before
  // 2.0.14) do not define the hint name at all.
#ifdef SDL_HINT_IME_SHOW_UI
  SDL_SetHint(SDL_HINT_IME_SHOW_UI, "1");
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

// Screen size for Stage.fullScreenWidth/Height and
// Capabilities.screenResolutionX/Y, in **logical** units (AIR calls them DIP).
//
// Which SDL query, and why it matters on Windows: adl 51.4.1 on a 3840x2560
// desktop at 150% scaling reports fullScreen 2560x1707 and screenDPI 96, while
// flash.display.Screen.bounds on the SAME display is 3840x2560 -- AIR mixes a
// DIP-space Stage property with a pixel-space Screen one. SDL hands back exactly
// those two spaces, one query each: SDL_GetDisplayBounds is DIP-aware once the
// DPI_SCALING hint above is set (measured 0,0 2560x1707, matching adl value for
// value), whereas SDL_GetCurrentDisplayMode stays in physical pixels (3840x2560).
// macOS reports points for BOTH, so the two agree there and nothing changes.
// Using the mode here was what made a Stage3D app (examples/air-starling-demo,
// which sizes its Starling viewport from fullScreenWidth/Height) diverge from adl
// on Windows while macOS matched -- see docs/zh-cn/win32.md.
// Refresh the cached primary-display size from the DIP-AWARE query, with SDL already up.
// EVERY writer of g_display_w comes through here, and that is the point: a second writer in
// another space silently wins, which is exactly what happened. The window paths used to
// fill the cache from SDL_GetCurrentDisplayMode, which on a scaled Windows desktop answers
// the PHYSICAL mode (3840x2560 at 150%) while Stage.fullScreenWidth/Height and
// Capabilities.screenResolutionX/Y are DIP (2560x1707, what adl reports) -- so every app
// that shows a window reported the pixel count and the lazy branch below became dead code
// (`Screen.bounds` went on answering the DIP space, so the two reads came out swapped).
// macOS is unaffected either way: SDL reports its display modes in POINTS
// (SDL_cocoamodes.c: mode->w = CGDisplayModeGetWidth), the same space CGDisplayBounds
// gives, so both queries already agreed there.
static void sk_refresh_display_size_cache(void) {
  SDL_Rect r;
  if (SDL_GetDisplayBounds(0, &r) == 0) {
    if (r.w > 0) g_display_w = r.w;
    if (r.h > 0) g_display_h = r.h;
  }
}

int sk_window_get_display_size(int* w, int* h) {
  if (g_display_w <= 0 || g_display_h <= 0) {
    // Whether SDL was already up decides whether this call may tear it down again: a Screen
    // query that ran before any window (ensure_video()) leaves it initialized, and the
    // SDL_Quit below would then destroy the video subsystem a live window loop is on.
    int we_inited = (SDL_WasInit(SDL_INIT_VIDEO) == 0);
    if (sk_video_init() != 0) return 0;
    sk_refresh_display_size_cache();
    if (we_inited) SDL_Quit();
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
// SPACE NOTE (open divergence, TODO.md): AIR reports Screen.bounds/visibleBounds in
// PHYSICAL pixels (3840x2560 on the desktop where Stage.fullScreenWidth is 2560, i.e.
// a 2560x1707 DIP space), while this query answers the same point space the Stage
// property uses. It is deliberately left alone: the window frame/centering math shares
// this function and is written in SDL's logical space, so converting only Screen would
// break centering. See docs/zh-cn/win32.md 3.5.
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
// ("mouseDown"/"mouseUp"/"click", the reserved "mouseLeave" for leaving the
// window, plus the reserved "wordSelect" described at its dispatch site); on_redraw
// is invoked after every handled event
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
  // NativeWindow.transparent / the descriptor's <transparent>. Kept here because the
  // present step has to clear the renderer to alpha 0 (SDL's default draw colour is
  // opaque black, which would paint every unpainted pixel black).
  int transparent;
  // macOS transparent-window present path: the vibrancy backdrop view and the layer
  // hosting view whose contents carry the frame (see sk_mac_ensure_transparent).
  // Both NULL on every other backend and on a non-transparent window.
  void* vib_eff;
  void* vib_host;
  // The three style-affecting flags the descriptor / NativeWindowInitOptions carry.
  // AIR's win32 mapping is THICKFRAME <=> resizable, MAXIMIZEBOX <=> maximizable,
  // MINIMIZEBOX <=> minimizable (measured off the real window, temp/nwwin/wstyle.exe),
  // which is NOT SDL's (it ties THICKFRAME|MAXIMIZEBOX to one flag and always keeps
  // MINIMIZEBOX). MAXIMIZEBOX also decides the maximized geometry, so these cannot be
  // re-derived from SDL's own flags afterwards -- see sk_win_apply_style.
  int resizable, maximizable, minimizable;
  int dirty;
  int destroy_pending;
  // The user (or the OS) asked this window to close -- its close button, its Cmd-W
  // equivalent, or a session shutdown. This is NOT teardown: AIR makes it a
  // cancelable Event.CLOSING first, so the request is parked here until the AS3
  // side answers (sk_window_take_close_request + sk_window_close, or nothing at all
  // when a listener called preventDefault()). Keeping it apart from
  // destroy_pending is what makes that choice possible.
  int close_request;
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
  // NativeWindow.startMove()/startResize(): an in-progress SYSTEM drag that AS3
  // started but the pointer drives. 0 = idle, 1 = moving, 2 = resizing. The
  // start snapshot (global pointer + frame rect) is what each mouseMove is
  // measured against, so the window tracks the pointer exactly instead of
  // accumulating per-event rounding.
  int sys_drag;
  int sys_gx, sys_gy;
  int sys_x, sys_y, sys_w, sys_h;
  int sys_t, sys_b, sys_l, sys_r;
  // NativeWindow.minSize/maxSize, enforced by the window manager while the user
  // drags an edge. 0 means "no limit" in that direction.
  int min_w, min_h, max_w, max_h;
};

static WinCtx g_wins[SK_MAX_WINDOWS];
// The largest size a window can be given. It is AIR's own default maximum
// (measured 107374182 on adl 51.4.1, both platforms), and anything at or above it
// means "no limit" to sk_window_set_limits.
#define SK_LIMIT_UNBOUNDED 107374182
// NativeApplication.exit() sets this; sk_run_loop consumes it and retires every
// window through the normal teardown path (see sk_window_request_exit).
static int g_exit_requested = 0;
// NativeApplication.autoExit, inverted: 1 (the default) means the loop ends with
// the last window, 0 means it keeps running with none (see sk_window_set_auto_exit).
static int g_auto_exit = 1;
// Applied from sk_run_loop; declared here because the loop is defined above the
// menu glue at the bottom of this file.
static void sk_menu_flush(void);
static void sk_menu_ensure(void);
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
// The SDL pixel format for a Skia raster surface, derived from the surface's own
// byte order instead of a per-platform guess. The masks here used to be hardcoded to
// R/G/B/A = 0x000000FF/0x0000FF00/0x00FF0000/0xFF000000, which is what a macOS build
// of Skia stores -- true there, WRONG on Windows, where Skia's kN32 is B,G,R,A
// (include/core/SkTypes.h sets SK_R32_SHIFT=16 under SK_BUILD_FOR_WIN). Every
// CPU-mode window on Windows was therefore blitted with red and blue exchanged: the
// gallery's #2563EB blue button came out #EB6325 orange, whites went cream.
// `order`: 1 = bytes R,G,B,A; 2 = bytes B,G,R,A. Anything else is refused rather
// than guessed -- a wrong format is silent, while SDL_PIXELFORMAT_UNKNOWN makes the
// caller report it (AGENTS.md 2.5: never fall back to a wrong semantic).
static Uint32 sk_pixfmt_for_surface(void* surface) {
  int order = sk_surface_pixel_order(surface);
  Uint32 r, b;
  if (order == 1)      { r = 0x000000FFu; b = 0x00FF0000u; }
  else if (order == 2) { b = 0x000000FFu; r = 0x00FF0000u; }
  else return SDL_PIXELFORMAT_UNKNOWN;
  return SDL_MasksToPixelFormatEnum(32, r, 0x0000FF00u, b, 0xFF000000u);
}

// The texture is created once and updated in place each frame instead of being
// created/destroyed per frame — that per-frame churn was the dominant cost at high
// Stage.frameRate values.
#if defined(__APPLE__)
// Defined with the other transparency glue further down (it needs sk_nsrect).
static void sk_mac_present_layer(WinCtx* c, void* pixels, int w, int h, int rowBytes);
#endif

static void present_frame(WinCtx* c, void* pixels, int w, int h, int rowBytes) {
#if defined(__APPLE__)
  // A transparent window does not go through SDL's renderer at all: its backing
  // store is opaque, so the frame is handed to a CALayer instead (rationale in
  // sk_mac_ensure_transparent below).
  if (c->transparent) { sk_mac_present_layer(c, pixels, w, h, rowBytes); return; }
#endif
  SDL_Renderer* ren = c->ren;
  SDL_Texture* tex = c->tex;
  int transparent = c->transparent;
  if (tex == NULL) return;
  SDL_UpdateTexture(tex, NULL, pixels, rowBytes);
  // A transparent window is cleared to alpha 0. SDL's default draw colour is opaque
  // black, so without this every pixel the display list did not paint would come out
  // black instead of letting the desktop through (measured on adl 51.4.1: those
  // pixels are alpha 0).
  if (transparent) SDL_SetRenderDrawColor(ren, 0, 0, 0, 0);
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

// Defined below, together with its rationale (a window whose size SDL is still
// reporting across a resize): the device pixel ratio plus a logical size that is
// consistent with the physical one.
static double sk_window_device_scale(SDL_Window* win, int* lw, int* lh, int pw, int ph);

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
  // Device pixel ratio (contentsScaleFactor) + a self-consistent logical size
  // (see sk_window_device_scale for why dividing SDL's two queries is wrong).
  double scale = sk_window_device_scale(c->win, &nw, &nh, npw, nph);
  if (c->on_resize != NULL) {
    void* ns = c->on_resize(c->win == NULL ? -1 : (int)(c - g_wins), nw, nh, npw, nph, scale);
    if (c->is_gpu) {
      c->pw = npw; c->ph = nph;
      return 1;
    }
    if (ns != NULL) {
      c->surface = ns;
      if (!sk_surface_peek_pixels(c->surface, &c->pixels, &c->rowBytes)) return -1;
      // The rebuilt surface is asked again rather than inheriting the old format:
      // a resize must not be the one path that keeps a stale channel order.
      c->pixfmt = sk_pixfmt_for_surface(c->surface);
      if (c->pixfmt == SDL_PIXELFORMAT_UNKNOWN) {
        fprintf(stderr, "window_glue: resized surface has an unsupported colour type\n");
        return -1;
      }
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

// The backing scale the window's backing store is actually drawn at (1.0 on a
// non-Retina display, 2.0 on Retina) — queried from the NSWindow, so it is
// stable for as long as the window stays on one display. Returns 0 when it
// cannot be read, so the caller falls back to SDL's own queries.
static double sk_window_backing_scale(SDL_Window* win) {
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (win == NULL || !SDL_GetWindowWMInfo(win, &info)) return 0.0;
  if (info.subsystem != SDL_SYSWM_COCOA || info.info.cocoa.window == NULL) return 0.0;
  double (*fn)(void*, SEL) = (double (*)(void*, SEL))objc_msgSend;
  return fn(info.info.cocoa.window, sel_registerName("backingScaleFactor"));
}
#elif defined(_WIN32)
// The DPI scale Windows actually lays this window out at (144/96 = 1.5 on this
// machine's 150% panel) — the Windows half of the very same rule the Cocoa query
// above exists for: SDL_GetWindowSize is a CACHE that is written when the resize
// event is *processed*, while SDL_GetWindowSizeInPixels asks the HWND live, so on
// any transition that moves and resizes at once the two disagree. Measured on this
// box with a real title-bar double-click on a 1000x680 window: on maximize the
// cached logical size was still 1000 while the client rect was already
// 3840x2454 px, so dividing them gave 3.84 instead of 1.5 and the whole picture
// was blown up 2.56x; on restore the pair was 1500/2560 = 0.586 and it shrank to
// 39% — the reported "double-click the header to maximize, the scale is wrong;
// double-click again and it is wrong the other way".
//
// GetDpiForWindow is resolved dynamically on purpose: it only exists from Windows
// 10 1607 on, and a static import would stop the binary from STARTING on anything
// older, while a missing export simply falls back to SDL's own ratio (0.0 here).
typedef UINT (WINAPI *sk_getdpi_fn)(HWND);
static sk_getdpi_fn sk_getdpi_lookup(void) {
  static sk_getdpi_fn fn = NULL;
  static int done = 0;
  if (!done) {
    HMODULE user32 = GetModuleHandleA("user32.dll");
    if (user32 != NULL) fn = (sk_getdpi_fn)(void*)GetProcAddress(user32, "GetDpiForWindow");
    done = 1;
  }
  return fn;
}
static double sk_window_backing_scale(SDL_Window* win) {
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (win == NULL || !SDL_GetWindowWMInfo(win, &info)) return 0.0;
  if (info.subsystem != SDL_SYSWM_WINDOWS || info.info.win.window == NULL) return 0.0;
  sk_getdpi_fn fn = sk_getdpi_lookup();
  if (fn == NULL) return 0.0;
  UINT dpi = fn(info.info.win.window);
  return (dpi > 0) ? (double)dpi / 96.0 : 0.0;
}
#else
static double sk_window_backing_scale(SDL_Window* win) { (void)win; return 0.0; }
#endif

// Device pixel ratio (contentsScaleFactor) + the logical client size, kept
// MUTUALLY CONSISTENT by construction — the AS3 side maps its stage (in logical
// points) onto a canvas of pw x ph physical pixels with exactly this ratio, so a
// ratio that does not match the pair stretches the whole picture.
//
// Do NOT divide SDL's two queries where the platform can report a backing scale
// (macOS: NSWindow.backingScaleFactor; Windows: GetDpiForWindow): SDL_GetWindowSize
// reads SDL's cached
// logical size (written from the resize event) while SDL_GetWindowSizeInPixels
// asks Cocoa live, so during a live resize they are one step apart. Measured
// during a left-edge drag: the layer was truly 329x580 pt / 658x1160 px while
// SDL still reported lw=320, giving scale 2.056 instead of 2.0 — and because the
// canvas and the stage were both derived from that same bogus ratio, the picture
// did not merely sit in the wrong place, the WHOLE thing was scaled up by ~3%,
// so the content visibly breathed (and shrank back) on every resize step (the
// "picture distorts while dragging" report; a right/bottom drag hides it behind
// the stage background the app already paints there). A stage size lagging its
// own canvas also meant stageWidth/stageHeight could be a step behind the window.
//
// The window's own backing scale is the stable answer (it changes only when the
// display does), so take it and read the logical size back out of the live pixel
// size — always, not just when the cached size disagrees (see the note inside).
// On platforms that cannot answer, SDL's ratio is what we have, and there the
// cross-display case is the one that matters.
static double sk_window_device_scale(SDL_Window* win, int* lw, int* lh, int pw, int ph) {
  double bs = sk_window_backing_scale(win);
  if (bs > 0.0) {
    const int dw = (int)((double)pw / bs + 0.5);
    const int dh = (int)((double)ph / bs + 0.5);
    // Both directions, and the stated logical size is REPLACED rather than only
    // repaired when it lags. The pair is only ever consumed as "stage size in
    // points + the ratio that maps it onto pw x ph pixels", so it is consistent by
    // construction only when both halves come out of the same live measurement.
    // A one-sided rule leaves the other half of this bug alive — and latches it:
    // do_resize returns early as soon as the PIXEL size matches, so a logical size
    // that is too LARGE is never revisited. Measured after restore-from-maximize
    // with the one-sided rule in place: the stage stayed 2560x1636 inside a
    // 1000x680 window for the rest of the run (the picture was correctly scaled
    // but the app laid itself out for a window 2.5x wider than the real one).
    if (dw > 0) *lw = dw;
    if (dh > 0) *lh = dh;
    return bs;
  }
  return (*lw > 0) ? (double)pw / (double)*lw : 1.0;
}

// The window's logical (client) size, read exactly the way do_resize reads it: the
// live pixel size over the window's own backing scale. Anything reached from inside
// a resize transition must NOT use SDL_GetWindowSize, whose value is written when
// the RESIZE event is *processed* — one step behind the client rect that
// SDL_GetWindowSizeInPixels queries live. That is not only do_resize's business:
// NativeWindow.bounds/clientSize are read from an app's Event.RESIZE handler, and
// measured on this machine a title-bar double-click to maximize answered
// NativeWindow.width = 1022 (the previous frame) while the stage was already 2560
// wide — so the app laid itself out for a window 2.5x too small (the TalkMED
// meeting window derives a content scale from nativeWindow.width).
static void sk_client_size_live(WinCtx* c, int* lw, int* lh) {
  int w = 0, h = 0, pw = 0, ph = 0;
  SDL_GetWindowSize(c->win, &w, &h);
  SDL_GetWindowSizeInPixels(c->win, &pw, &ph);
  if (pw > 0 && ph > 0) (void)sk_window_device_scale(c->win, &w, &h, pw, ph);
  if (lw != NULL) *lw = w;
  if (lh != NULL) *lh = h;
}

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
    // UNIT OF THE MEASUREMENT: SDL_GetWindowBordersSize answers in PHYSICAL pixels,
    // while every consumer of b_* works in LOGICAL points --
    //   sk_window_set_bounds / sk_window_get_bounds   bounds is AIR's frame rect in DIP
    //   NativeWindow_globalToScreen                   screen coords are DIP
    //   SDL_SetWindowPosition / SDL_SetWindowSize, startMove, min/max size   SDL is logical
    // Mixing them costs the client area a slice of the frame on any display above
    // 100%. Measured on this 150% panel (temp/shwin/metrics.log, plus adl for the
    // same bounds): the frame is 22x56 PHYSICAL px, so subtracting it from a
    // 614x436 DIP frame gave a 592x380 client where AIR's own arithmetic gives
    // 598x397 -- 17 points of client height gone, and the share window's fixed
    // 600x400 skin was cut at y=380, right through its bottom button bar (the bar
    // is 363..391, so its lower 11 points and the whole refresh button at 378..411
    // fell outside the stage: painted nowhere, and unreachable by the mouse).
    // Normalising ONCE, here, is what keeps the other call sites honest: a
    // per-consumer conversion would drift the moment one of them is written in the
    // other unit, and there are six of them.
    const double bs = sk_window_backing_scale(c->win);
    if (bs > 0.0 && bs != 1.0) {
      t = (int)((double)t / bs + 0.5);
      l = (int)((double)l / bs + 0.5);
      b = (int)((double)b / bs + 0.5);
      r = (int)((double)r / bs + 0.5);
    }
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

  // Keep the app's menu bar authoritative against AppKit's own launch-time menu
  // (see sk_menu_ensure).
  sk_menu_ensure();

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
      if (!c->is_gpu) present_frame(c, c->pixels, c->pw, c->ph, c->rowBytes);
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
#if defined(ASC_RENDER_D3D) || defined(ASC_RENDER_GL)
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

// ---------- clipboard (flash.desktop.Clipboard, 阶段二百九十三) ----------
// The AS3 side (src/emit.ts emitClipboardClass) owns the data model: a set of
// (format -> data) entries, the same set AIR documents. This file owns the
// PLATFORM translation of the four standard formats AIR maps to native ones:
//
//   text     <-> CF_UNICODETEXT              / the SDL text clipboard
//   html     <-> the "HTML Format" format    / not available on this backend
//   richText <-> the "Rich Text Format" one  / not available on this backend
//   url      <-> "UniformResourceLocatorW"   / not available on this backend
//
// A backend that cannot carry a format answers 0 from sk_clipboard_has_fmt, and
// the AS3 side reports that the value stayed inside the application instead of
// pretending it reached the system clipboard.
//
// The get/set pair is also the store behind TextField copy/paste (as_clipboard_
// set_text / get_text in runtime.ts), so both paths see the same clipboard.
#if defined(_WIN32)
// The Win32 clipboard format behind one of our names (0 = not translated here).
// The clipboard is a global, single-owner resource: while another application has
// it open, OpenClipboard fails with ERROR_ACCESS_DENIED. That is transient (a
// reader holds it for a few milliseconds), so retrying is what makes a copy
// reliable instead of randomly reporting a failure.
static BOOL sk_clip_open(void) {
  for (int i = 0; i < 10; i++) {
    if (OpenClipboard(NULL)) return TRUE;
    Sleep(2);
  }
  return FALSE;
}

static UINT sk_clip_fmt_id(const char* fmt) {
  if (fmt == NULL) return 0;
  if (strcmp(fmt, "text") == 0) return CF_UNICODETEXT;
  if (strcmp(fmt, "html") == 0) return RegisterClipboardFormatW(L"HTML Format");
  if (strcmp(fmt, "richText") == 0) return RegisterClipboardFormatW(L"Rich Text Format");
  if (strcmp(fmt, "url") == 0) return RegisterClipboardFormatW(L"UniformResourceLocatorW");
  return 0;
}

// A clipboard allocation holding len bytes (zero terminated), or NULL. Moveable
// memory is what SetClipboardData requires: the system takes ownership of it.
static HGLOBAL sk_clip_blob(const void* data, int len) {
  if (len < 0) len = 0;
  HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, (SIZE_T)len + 2);
  if (h == NULL) return NULL;
  void* p = GlobalLock(h);
  if (p == NULL) { GlobalFree(h); return NULL; }
  if (len > 0 && data != NULL) memcpy(p, data, (size_t)len);
  GlobalUnlock(h);
  return h;
}

// UTF-8 -> UTF-16 into a fresh allocation (NUL terminated). Used for the two
// formats the platform stores as wide characters (text, url).
static HGLOBAL sk_clip_wide(const char* s, int len) {
  int n = (s != NULL && len > 0) ? MultiByteToWideChar(CP_UTF8, 0, s, len, NULL, 0) : 0;
  HGLOBAL h = sk_clip_blob(NULL, (n > 0 ? n : 0) * 2);
  if (h == NULL) return NULL;
  wchar_t* w = (wchar_t*)GlobalLock(h);
  if (w == NULL) { GlobalFree(h); return NULL; }
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, len, w, n);
  w[n > 0 ? n : 0] = 0;
  GlobalUnlock(h);
  return h;
}

// CF_HTML is a plain byte payload behind a small ASCII header carrying four
// absolute byte offsets. Ten fixed-width digits keep the header length constant,
// so the offsets can be computed before the header is formatted.
static HGLOBAL sk_clip_html(const char* frag, int fragLen) {
  static const char* kPre = "<html><body><!--StartFragment-->";
  static const char* kPost = "<!--EndFragment--></body></html>";
  int preLen = (int)strlen(kPre);
  int postLen = (int)strlen(kPost);
  char head[256];
  // Two passes: the first gives the exact header length (which is also StartHTML).
  snprintf(head, sizeof(head),
           "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\n"
           "StartFragment:0000000000\r\nEndFragment:0000000000\r\n");
  int headLen = (int)strlen(head);
  int startFrag = headLen + preLen;
  int endFrag = startFrag + (fragLen > 0 ? fragLen : 0);
  int endHtml = endFrag + postLen;
  snprintf(head, sizeof(head),
           "Version:0.9\r\nStartHTML:%010d\r\nEndHTML:%010d\r\n"
           "StartFragment:%010d\r\nEndFragment:%010d\r\n",
           headLen, endHtml, startFrag, endFrag);
  int headOut = (int)strlen(head);
  if (headOut != headLen) return NULL;
  HGLOBAL h = sk_clip_blob(NULL, headOut + preLen + endFrag - startFrag + postLen);
  if (h == NULL) return NULL;
  char* p = (char*)GlobalLock(h);
  if (p == NULL) { GlobalFree(h); return NULL; }
  char* w = p;
  memcpy(w, head, (size_t)headOut); w += headOut;
  memcpy(w, kPre, (size_t)preLen); w += preLen;
  if (fragLen > 0 && frag != NULL) { memcpy(w, frag, (size_t)fragLen); w += fragLen; }
  memcpy(w, kPost, (size_t)postLen);
  GlobalUnlock(h);
  return h;
}

static int sk_clip_atoi(const char* p) {
  int v = 0;
  while (*p >= '0' && *p <= '9') v = v * 10 + (*p++ - '0');
  return v;
}

// ClipboardFormats.HTML_FORMAT is the FRAGMENT, so the CF_HTML header is stripped
// on read. A payload with no header is passed through unchanged: plenty of
// applications put bare HTML on the clipboard.
static int sk_clip_html_fragment(const char* all, int len, int* outStart) {
  const char* sf = strstr(all, "StartFragment:");
  const char* ef = strstr(all, "EndFragment:");
  if (sf != NULL && ef != NULL) {
    int s = sk_clip_atoi(sf + 14);
    int e = sk_clip_atoi(ef + 12);
    if (s >= 0 && e > s && e <= len) {
      if (outStart != NULL) *outStart = s;
      return e - s;
    }
  }
  if (outStart != NULL) *outStart = 0;
  return len;
}

// Replace one translated format, keeping the other three alive. Win32 only lets
// the clipboard OWNER call SetClipboardData, and taking ownership means
// EmptyClipboard first, so the survivors are copied out and written back.
// A format this build cannot read (a bitmap, a file list) cannot survive the
// rebuild; the AS3 side records that limitation once.
static void sk_clip_rebuild(UINT setid, HGLOBAL blob, UINT drop) {
  static const char* kNames[4] = { "text", "html", "richText", "url" };
  UINT ids[4];
  HGLOBAL keep[4];
  int nkeep = 0;
  if (!sk_clip_open()) { if (blob != NULL) GlobalFree(blob); return; }
  for (int i = 0; i < 4; i++) {
    UINT id = sk_clip_fmt_id(kNames[i]);
    if (id == 0 || id == setid || id == drop) continue;
    if (!IsClipboardFormatAvailable(id)) continue;
    HANDLE h = GetClipboardData(id);
    if (h == NULL) continue;
    const void* p = GlobalLock(h);
    if (p == NULL) continue;
    HGLOBAL copy = sk_clip_blob(p, (int)GlobalSize(h));
    GlobalUnlock(h);
    if (copy != NULL) { ids[nkeep] = id; keep[nkeep] = copy; nkeep++; }
  }
  EmptyClipboard();
  if (setid != 0 && blob != NULL) {
    if (SetClipboardData(setid, blob) == NULL) GlobalFree(blob);
  } else if (blob != NULL) {
    GlobalFree(blob);
  }
  for (int i = 0; i < nkeep; i++) {
    if (SetClipboardData(ids[i], keep[i]) == NULL) GlobalFree(keep[i]);
  }
  CloseClipboard();
}

void sk_clipboard_set_fmt(const char* fmt, const void* data, int len) {
  if (data == NULL || len < 0) return;
  UINT id = sk_clip_fmt_id(fmt);
  if (id == 0) return;
  HGLOBAL h;
  if (id == CF_UNICODETEXT) h = sk_clip_wide((const char*)data, len);
  else if (strcmp(fmt, "html") == 0) h = sk_clip_html((const char*)data, len);
  else if (strcmp(fmt, "url") == 0) h = sk_clip_wide((const char*)data, len);
  else h = sk_clip_blob(data, len);
  sk_clip_rebuild(id, h, 0);
}

int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap) {
  UINT id = sk_clip_fmt_id(fmt);
  if (id == 0) return 0;
  if (!IsClipboardFormatAvailable(id)) return 0;
  if (!sk_clip_open()) return 0;
  int n = 0;
  HANDLE h = GetClipboardData(id);
  const void* p = (h != NULL) ? GlobalLock(h) : NULL;
  if (p != NULL) {
    int bytes = (int)GlobalSize(h);
    if (id == CF_UNICODETEXT || strcmp(fmt, "url") == 0) {
      int wlen = bytes / 2;
      while (wlen > 0 && ((const wchar_t*)p)[wlen - 1] == 0) wlen--;
      n = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t*)p, wlen, NULL, 0, NULL, NULL);
      if (buf != NULL && cap > 0) {
        int room = (cap - 1 < n) ? cap - 1 : n;
        if (room > 0) {
          n = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t*)p, wlen, buf, room, NULL, NULL);
        } else {
          n = 0;
        }
        buf[n] = 0;
      }
    } else if (strcmp(fmt, "html") == 0) {
      int start = 0;
      int frag = sk_clip_html_fragment((const char*)p, bytes, &start);
      n = frag;
      if (buf != NULL && cap > 0) {
        int room = (cap - 1 < frag) ? cap - 1 : frag;
        if (room > 0) memcpy(buf, (const char*)p + start, (size_t)room);
        n = room;
        buf[n] = 0;
      }
    } else {
      n = bytes;
      if (buf != NULL && cap > 0) {
        int room = (cap - 1 < bytes) ? cap - 1 : bytes;
        if (room > 0) memcpy(buf, p, (size_t)room);
        n = room;
        buf[n] = 0;
      }
    }
    GlobalUnlock(h);
  }
  CloseClipboard();
  return n;
}

void sk_clipboard_set_text(const char* text) {
  // The text format goes through the same rebuild so an html/rtf/url payload set
  // moments earlier survives (SDL_SetClipboardText would empty the clipboard).
  sk_clipboard_set_fmt("text", text != NULL ? text : "", (int)strlen(text != NULL ? text : ""));
}

int sk_clipboard_get_text(char* buf, int cap) { return sk_clipboard_get_fmt("text", buf, cap); }

int sk_clipboard_has_fmt(const char* fmt) {
  UINT id = sk_clip_fmt_id(fmt);
  if (id == 0) return 0;
  return IsClipboardFormatAvailable(id) ? 1 : 0;
}

void sk_clipboard_clear_fmt(const char* fmt) {
  UINT drop = sk_clip_fmt_id(fmt);
  if (drop == 0) return;
  if (!IsClipboardFormatAvailable(drop)) return;
  sk_clip_rebuild(0, NULL, drop);
}

void sk_clipboard_clear(void) {
  if (!sk_clip_open()) return;
  EmptyClipboard();
  CloseClipboard();
}

int sk_clipboard_available(void) { return 1; }
#else
// Everything except Windows: the SDL text clipboard is the only carrier. The
// three remaining formats answer "not present" and the AS3 side reports that a
// value set for one of them stayed inside the application (registered gap).
void sk_clipboard_set_text(const char* text) {
  ensure_video();
  SDL_SetClipboardText(text != NULL ? text : "");
}

int sk_clipboard_get_text(char* buf, int cap) {
  ensure_video();
  if (buf == NULL) {
    char* s = SDL_GetClipboardText();
    int n = (s != NULL) ? (int)strlen(s) : 0;
    if (s != NULL) SDL_free(s);
    return n;
  }
  if (cap <= 0) return 0;
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

int sk_clipboard_available(void) { return 1; }

int sk_clipboard_has_fmt(const char* fmt) {
  if (fmt == NULL || strcmp(fmt, "text") != 0) return 0;
  ensure_video();
  return SDL_HasClipboardText() ? 1 : 0;
}

void sk_clipboard_set_fmt(const char* fmt, const void* data, int len) {
  if (fmt != NULL && strcmp(fmt, "text") == 0 && data != NULL && len >= 0) {
    char* s = (char*)malloc((size_t)len + 1);
    if (s == NULL) return;
    memcpy(s, data, (size_t)len);
    s[len] = '\0';
    sk_clipboard_set_text(s);
    free(s);
  }
}

int sk_clipboard_get_fmt(const char* fmt, char* buf, int cap) {
  if (fmt != NULL && strcmp(fmt, "text") == 0) return sk_clipboard_get_text(buf, cap);
  return 0;
}

void sk_clipboard_clear_fmt(const char* fmt) {
  if (fmt != NULL && strcmp(fmt, "text") == 0) sk_clipboard_set_text("");
}

void sk_clipboard_clear(void) { sk_clipboard_set_text(""); }
#endif


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

#if defined(__APPLE__)
// The AIR keyCode of a modifier scancode, or 0 when the key is not a modifier.
//
// KEYED ON AIR'S KEYCODE, NOT ON THE SDL SCANCODE — that is the whole point.
// AS3's KeyboardEvent cannot see sides: both Shift keys are keyCode 16, both
// Control keys 17, both Alt keys 18, both Command keys 15. Measured on
// adl 51.4.1 (macOS 26.6.2): pressing LSHIFT then RSHIFT yields exactly ONE
// keyDown + ONE keyUp on the AS3 side, and the same holds for L/R Control, Alt
// and Command -- harness and per-variant logs in temp/shiftdup/. SDL reports
// them as four separate scancodes, so a scancode-keyed filter cannot collapse
// them -- and collapsing is what AIR does.
static int sk_modifier_keycode(SDL_Scancode sc) {
  switch (sc) {
    case SDL_SCANCODE_LSHIFT: case SDL_SCANCODE_RSHIFT: return 16;
    case SDL_SCANCODE_LCTRL:  case SDL_SCANCODE_RCTRL:  return 17;
    case SDL_SCANCODE_LALT:   case SDL_SCANCODE_RALT:   return 18;
    case SDL_SCANCODE_LGUI:   case SDL_SCANCODE_RGUI:   return 15;
    default:
      return 0;
  }
}

// The last modifier transition actually handed to the AS3 side. File scope
// because SDL keeps ONE keystate[] for the whole process (src/events/
// SDL_keyboard.c), not one per window.
static int g_mod_last_keycode = 0;
static int g_mod_last_down = -1;
static int g_mod_last_valid = 0;
#endif

// ---------- system move/resize (NativeWindow.startMove / startResize) ----------
// AIR's startMove()/startResize() hand the drag over to the window manager: the
// app keeps receiving mouse events, but the OS now moves/resizes the frame until
// the button comes up. macOS can do that natively (performWindowDragWithEvent:),
// but that call is ObjC/platform-specific while our window layer is SDL — and SDL
// exposes no "begin system drag" entry point. So the drag is driven here: the
// pointer's global position is sampled on every mouseMove and the frame is
// re-placed relative to the snapshot taken at the start, which reproduces the
// same observable behaviour (window follows the pointer, one MOVE per step, ends
// on button-up) on every backend.
static void sk_sys_drag_begin(WinCtx* c, int mode, int t, int b, int l, int r) {
  if (c == NULL || c->win == NULL) return;
  int gx = 0, gy = 0;
  SDL_GetGlobalMouseState(&gx, &gy);
  int px = 0, py = 0, cw = 0, ch = 0;
  SDL_GetWindowPosition(c->win, &px, &py);
  SDL_GetWindowSize(c->win, &cw, &ch);
  c->sys_drag = mode;
  c->sys_gx = gx; c->sys_gy = gy;
  // The snapshot is the FRAME rect (what NativeWindow.bounds reports), because
  // that is the rectangle the user sees; SDL works in client coordinates, so the
  // conversion happens on the way back out.
  c->sys_x = px - c->b_left;
  c->sys_y = py - c->b_top;
  c->sys_w = cw + c->b_left + c->b_right;
  c->sys_h = ch + c->b_top + c->b_bottom;
  c->sys_t = t; c->sys_b = b; c->sys_l = l; c->sys_r = r;
}

// Re-place the frame for the pointer's current global position. Called from the
// mouseMove handler, so a drag costs one SetWindowPosition/SetWindowSize per
// motion event — the same pacing the OS's own drag loop produces.
static void sk_sys_drag_step(WinCtx* c) {
  if (c == NULL || c->win == NULL || c->sys_drag == 0) return;
  int gx = 0, gy = 0;
  SDL_GetGlobalMouseState(&gx, &gy);
  int dx = gx - c->sys_gx;
  int dy = gy - c->sys_gy;
  if (c->sys_drag == 1) {
    // sys_x/sys_y hold FRAME coordinates (what NativeWindow.bounds reports), SDL takes the
    // client origin, so the frame borders are converted on the way out — the same
    // conversion the resize branch below and sk_window_set_bounds do. Without it a
    // startMove drag follows the pointer 8px off on Windows (b_left 8) and correctly on
    // macOS (b_left 0), which is exactly why the asymmetry was invisible there.
    SDL_SetWindowPosition(c->win, c->sys_x + dx + c->b_left, c->sys_y + dy + c->b_top);
    return;
  }
  // Resizing: the dragged edges move with the pointer, the opposite ones stay.
  int nx = c->sys_x, ny = c->sys_y, nw = c->sys_w, nh = c->sys_h;
  if (c->sys_l) { nx = c->sys_x + dx; nw = c->sys_w - dx; }
  if (c->sys_r) { nw = c->sys_w + dx; }
  if (c->sys_t) { ny = c->sys_y + dy; nh = c->sys_h - dy; }
  if (c->sys_b) { nh = c->sys_h + dy; }
  // AIR's minSize/maxSize bound the FRAME, and they are what stops a drag from
  // inverting the window; the client area shrinks by the borders.
  if (c->min_w > 0 && nw < c->min_w) {
    if (c->sys_l) nx -= (c->min_w - nw);
    nw = c->min_w;
  }
  if (c->min_h > 0 && nh < c->min_h) {
    if (c->sys_t) ny -= (c->min_h - nh);
    nh = c->min_h;
  }
  if (c->max_w > 0 && nw > c->max_w) {
    if (c->sys_l) nx -= (nw - c->max_w);
    nw = c->max_w;
  }
  if (c->max_h > 0 && nh > c->max_h) {
    if (c->sys_t) ny -= (nh - c->max_h);
    nh = c->max_h;
  }
  int cw = nw - c->b_left - c->b_right;
  int ch = nh - c->b_top - c->b_bottom;
  if (cw < 1) cw = 1;
  if (ch < 1) ch = 1;
  if (nx != c->sys_x || ny != c->sys_y) SDL_SetWindowPosition(c->win, nx + c->b_left, ny + c->b_top);
  if (cw + c->b_left + c->b_right != c->sys_w || ch + c->b_top + c->b_bottom != c->sys_h)
    SDL_SetWindowSize(c->win, cw, ch);
}

// The shared event loop. Every window is polled, paced and presented from here;
// the loop runs until no window is left (AIR's NativeApplication.autoExit
// behaviour, which is what SDL's own "quit on last window close" matches).
// Lazily-read ASC_TRACE_INPUT flag (see the event loop below).
static int sk_trace_input = -1;

// The OS release that ends the press which opened a context menu is swallowed by the
// modal menu itself (AppKit's tracking loop owns the event stream while it is up), so
// SDL's cached button mask keeps RIGHT pressed. SDL then DROPS the next right press
// because it looks like a duplicate of a button that never came up: measured on macOS,
// right-click -> pick an item -> right-click again delivered no rightMouseDown at all,
// and only that second click's own release got through (temp/ctxmenu, aot.log + the
// ASC_TRACE_INPUT trace, which shows 1025 right-down, then 1026 with no 1025 before it).
// Feed SDL the release it missed once the OS says the button is really up: SDL clears
// the mask AND queues the SDL_MOUSEBUTTONUP, which is exactly the deferred
// rightMouseUp/rightClick AIR delivers after a menu closes (measured on adl 51.4.1).
// SDL_SendMouseButton is not in the public headers we ship, but it is the only way to
// put the mouse state machine straight -- pushing an event with SDL_PushEvent would
// bypass the state update that is the whole problem.
// (SDL_MouseID is internal-only in 2.32's public headers; it is a Sint32.)
extern "C" int SDL_SendMouseButton(SDL_Window *, Sint32, Uint8, Uint8);

static int g_synth_right_up = 0;
// Set by the Win32 popup when TrackPopupMenu really ran (see sk_menu_popup). The
// two window backends differ in exactly one way that matters here: AppKit's
// tracking loop CONSUMES the release, so SDL never sees it and sk_resync_right_button
// has to manufacture one; Win32's modal pump DELIVERS it, so SDL queues a real
// SDL_MOUSEBUTTONUP behind our back and it reaches the branch below after the menu
// is gone. The emitter has already replayed that release at the dismissal point
// (AIR's order), so the queued copy is a duplicate: measured on this box, one
// right-click that opened a menu produced two full rightMouseUp/rightClick pairs,
// the second one after the selection events. Swallow it.
static int g_popup_up_swallow = 0;

static void sk_resync_right_button(SDL_Window *win) {
  if (!(SDL_GetMouseState(NULL, NULL) & SDL_BUTTON_RMASK)) return;
  if (SDL_GetGlobalMouseState(NULL, NULL) & SDL_BUTTON_RMASK) return;
  // The event this queues is NOT the AS3 rightMouseUp: the emitter replays that one
  // itself (at the dismissal point, before the selection events, exactly the order
  // adl 51.4.1 produces). This call exists only to clear SDL's mask, so the up it
  // produces is swallowed in the MOUSEBUTTONUP case.
  g_synth_right_up = 1;
  SDL_SendMouseButton(win, 0, SDL_RELEASED, SDL_BUTTON_RIGHT);
}

static void sk_run_loop(void) {
  // Anything the app installed before the window opened is applied NOW (see
  // sk_pending_menu): NSApp only exists once video is up.
  sk_menu_flush();
  double now = (double)SDL_GetTicks();
  // Rolling deadline of the ONE application frame (see step 4).
  g_app_next = now;
  SDL_Event e;
  // NativeApplication.autoExit = false outlives its last window (see
  // sk_window_set_auto_exit), so the condition is not simply "a window is open".
  while (sk_any_open() || !g_auto_exit) {
    // NativeApplication.exit(): retire everything and leave, even though windows
    // are still open. It goes through the same deferred teardown as a natural
    // close, so the CLOSE dispatch and the ordering are identical. A separate
    // path (destroying the SDL windows here) would be observable: the loop would
    // stop pumping events while AS3 still held live window objects.
    if (g_exit_requested) {
      g_exit_requested = 0;
      for (int i = 0; i < SK_MAX_WINDOWS; i++) {
        if (g_wins[i].used) g_wins[i].destroy_pending = 1;
      }
    }
    // 1. Frame boundary: retire windows whose close was requested last frame.
    sk_service_destroy();
    if (!sk_any_open()) break;

    // 2. Poll input, routing each event to the window that owns it.
    while (SDL_PollEvent(&e)) {
      // ASC_TRACE_INPUT=1 prints every SDL event type. It exists because a
      // synthetic click (CGEvent) that skipped the pointer's entry into the window
      // reached us as motion only -- SDL routes buttons through the window that
      // holds mouse focus, which mouseEntered is what sets.
      if (sk_trace_input < 0) sk_trace_input = (getenv("ASC_TRACE_INPUT") != NULL) ? 1 : 0;
      if (sk_trace_input) fprintf(stderr, "trace-input: type=%d win=%u\n", (int)e.type, (unsigned)e.window.windowID);
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
          // SDL_TEXTEDITING (the IME marked text) carries its windowID too. Without this
          // branch it fell through to the 0 default, sk_id_from_window_id() answered -1
          // and the whole composition event was dropped before the switch: the field
          // never saw a marked character, so nothing was previewed at the caret and
          // sk_window_set_text_input_rect() was never called either (measured: temp/
          // imelive, 15 x SDL_TEXTEDITING while the app dispatched none).
          e.type == SDL_TEXTEDITING ? e.edit.windowID :
          e.type == SDL_KEYDOWN || e.type == SDL_KEYUP ? e.key.windowID : 0);
      if (id < 0) continue;
      WinCtx* c = &g_wins[id];
      if (c->destroy_pending) continue;
      switch (e.type) {
        case SDL_WINDOWEVENT:
          if (e.window.event == SDL_WINDOWEVENT_CLOSE) {
            // The user (or the OS) asked this window to go away. AIR reports that as
            // a cancelable Event.CLOSING, so it is parked and handed to the AS3 side
            // (which either closes the window through the normal teardown, or --
            // when a listener prevented the default -- does nothing). A window
            // nobody listens for still closes: the AS3 side closes it on the very
            // next frame.
            c->close_request = 1;
          } else if (e.window.event == SDL_WINDOWEVENT_EXPOSED) {
            c->dirty = 1;
          } else if (e.window.event == SDL_WINDOWEVENT_LEAVE) {
            // Is the pointer really outside now? Raising/activating a window that
            // already sits under a stationary pointer makes Windows emit
            // WM_MOUSELEAVE for it and SDL therefore reports a LEAVE with the
            // pointer still INSIDE the window -- measured: win=1 ev=11 with the
            // pointer at 1268,301 inside its 1108,181 304x201 client rect (temp/
            // mouse2w, GLUE-DBG). Forwarding that as mouseLeave would roll the
            // window's roll-over state back for no reason while the pointer never
            // left, and AIR does not do it (its own window in the same schedule
            // never reported a leave). So a LEAVE with the pointer STRICTLY inside
            // the client rect is not a leave. The 2px margin keeps a REAL leave --
            // where the pointer is already outside, typically by a pixel -- from
            // being swallowed at the boundary.
            int gx = 0, gy = 0, wx = 0, wy = 0, ww = 0, wh = 0;
            SDL_GetGlobalMouseState(&gx, &gy);
            SDL_GetWindowPosition(c->win, &wx, &wy);
            SDL_GetWindowSize(c->win, &ww, &wh);
            int still_inside = gx >= wx + 2 && gx <= wx + ww - 2 &&
                               gy >= wy + 2 && gy <= wy + wh - 2;
            if (!still_inside) {
              // The pointer left the window. macOS can keep a cursor installed by
              // the last window (SDL_SetCursor is not per-window), so an I-beam
              // would otherwise follow the pointer onto the menu bar / desktop.
              sk_window_set_cursor(id, SK_CURSOR_ARROW);
              // Tell the AS3 side, on the mouse channel under the reserved
              // "mouseLeave" type (ASC_window_on_mouse): AIR rolls the window's
              // roll-over state back to its up/out state when the pointer leaves the
              // stage, so without this a button stayed hovered until the pointer came
              // back and moved once more (TODO.md's "指针移出窗口不 roll-out"). The
              // coordinates are deliberately 0,0 -- the event carries none, and AIR
              // does NOT touch mouseX/mouseY on a leave: they keep the last in-window
              // position (measured on adl 51.4.1, temp/mouse2w), so the AS3 side keeps
              // its own last values and ignores these. dirty makes the window repaint
              // with the rolled-back state.
              if (c->on_mouse) {
                c->on_mouse(id, 0.0, 0.0, "mouseLeave");
                c->dirty = 1;
              }
            }
          }
          // SIZE_CHANGED/RESIZED are handled by live_resize_watch during pump.
          break;
        case SDL_MOUSEMOTION:
          // A system drag owns the pointer: re-place the frame first so the
          // mouseMove the app sees already describes the new geometry, which is
          // the order AIR's own drag loop produces.
          sk_sys_drag_step(c);
          if (c->on_mouse) {
            c->on_mouse(id, (double)e.motion.x, (double)e.motion.y, "mouseMove");
            c->dirty = 1;
          }
          break;
        case SDL_MOUSEBUTTONDOWN:
          // Right button (阶段二百八十九): only the down event reaches AS3 from here --
          // the context menu pops up right after it, inside the same call, and while a
          // Cocoa menu is tracking it owns the event stream, so the matching up/click
          // is consumed by AppKit (identical to AIR's modal behaviour).
          if (e.button.button == SDL_BUTTON_RIGHT && c->on_mouse) {
            // A new press supersedes any swallow still pending from an earlier popup
            // (the release can arrive after the menu closed when it was dismissed
            // from the keyboard).
            g_popup_up_swallow = 0;
            c->on_mouse(id, (double)e.button.x, (double)e.button.y, "rightMouseDown");
            c->dirty = 1;
            // That call may have popped up a context menu, which eats this press's
            // release -- see sk_resync_right_button.
            sk_resync_right_button(c->win);
            break;
          }
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
          // The left-button drag latch is cleared first: it is independent of what
          // the right button does, and the right-button branches below all break.
          if (e.button.button == SDL_BUTTON_LEFT) c->sys_drag = 0;
          if (e.button.button == SDL_BUTTON_RIGHT && g_popup_up_swallow) {
            // The release the Win32 modal pump queued while the menu was up: AS3
            // already got the replayed pair at the dismissal point, so reporting
            // this one would be a second rightMouseUp/rightClick for one click.
            g_popup_up_swallow = 0;
            break;
          }
          if (e.button.button == SDL_BUTTON_RIGHT && g_synth_right_up) {
            // The release sk_resync_right_button manufactured: its only job was
            // resetting SDL's button mask (AS3 already got the rightMouseUp from the
            // popup path). Report nothing and clear the flag.
            g_synth_right_up = 0;
            break;
          }
          if (e.button.button == SDL_BUTTON_RIGHT && c->on_mouse) {
            c->on_mouse(id, (double)e.button.x, (double)e.button.y, "rightMouseUp");
            c->on_mouse(id, (double)e.button.x, (double)e.button.y, "rightClick");
            c->dirty = 1;
            break;
          }
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
#if defined(__APPLE__)
          // MODIFIER COALESCING (macOS only).
          //
          // AIR dispatches a modifier by KEYCODE, so the two physical sides of
          // one modifier look like the same key to AS3: LSHIFT and RSHIFT are
          // both keyCode 16 (measured on adl 51.4.1, macOS 26.6.2 -- press L
          // then R and the app sees ONE keyDown and ONE keyUp; likewise for
          // Control 17, Alt 18, Command 15). SDL, on the other hand, reports
          // four distinct scancodes, and the Cocoa backend can also emit BOTH
          // sides from one `NSEventTypeFlagsChanged`: `Cocoa_DispatchEvent`
          // (src/video/cocoa/SDL_cocoaevents.m:95-99) hands every keyboard
          // NSEvent to `Cocoa_HandleKeyEvent` ONCE, and that function's
          // FlagsChanged arm calls `HandleModifiers`
          // (src/video/cocoa/SDL_cocoakeyboard.m:200), which consults the
          // event's modifier flags for EVERY scancode in the family. A
          // synthetic event carrying only the generic Shift bit therefore
          // presses LSHIFT and RSHIFT at once. Either way the AS3 side would
          // receive two byte-identical keyDowns where adl delivers one.
          //
          // So the filter keys on (AIR keyCode, direction), not on the SDL
          // scancode and not on SDL's `repeat` (a modifier's KEYUP half
          // carries no repeat flag at all). Holding a modifier produces no
          // repeats on macOS, hence a repeat of the same (keyCode, direction)
          // cannot be real input. Deliberately NOT done on Windows, which does
          // auto-repeat modifiers: there the repetition is real input. (The
          // TODO.md row about Shift being dispatched twice was removed in stage
          // 209, when all of this was re-measured on macOS.)
          {
            int mod_kc = sk_modifier_keycode(e.key.keysym.scancode);
            if (mod_kc != 0) {
              int down = (e.type == SDL_KEYDOWN) ? 1 : 0;
              if (g_mod_last_valid && g_mod_last_keycode == mod_kc &&
                  g_mod_last_down == down) {
                break;
              }
              g_mod_last_keycode = mod_kc;
              g_mod_last_down = down;
              g_mod_last_valid = 1;
            }
          }
#endif
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
      // No window can hold the frame clock (none is visible), so there is nothing
      // to pace against. Idle at ~60 Hz rather than spinning at 1000 Hz while an
      // autoExit=false app waits for its Dock menu.
      SDL_Delay(sk_any_open() ? 1 : 16);
    }
  }
  sk_service_destroy();
}

// ---------- window creation ----------

// Common window setup shared by the main window and every NativeWindow. Returns
// the registry id, or -1 on failure.
// Size limits of a fresh window and the floor a minSize assignment is clamped to.
// Defined with the rest of the minSize/maxSize support further down; declared here
// because window creation is what installs the defaults.
static void sk_window_size_defaults(int* mnw, int* mnh, int* mxw, int* mxh);
static void sk_window_size_floor(int* fw, int* fh);
// Deliberately NOT static: this one is the glue's public entry point (the generated C's
// NativeWindow_set_minSize/maxSize reach it through as_window_set_limits), so a `static`
// here would silently pull the whole definition to internal linkage and the link would
// fail with an undefined symbol.
void sk_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh);

// The app's OWN initial window, as the AIR descriptor describes it. Compile-time because
// --air-app turns <initialWindow> into build defines, and deliberately named after the
// FIRST window: AIR's descriptor does not describe any window the program creates itself.
// Measured against a strict descriptor (<resizable>false</resizable>, <maximizable>false,
// <x>50</x><y>60</y>, <minSize>300 500</minSize>) with temp/nwwin/Leak.as: a plain
// `new NativeWindow(new NativeWindowInitOptions())` still answers resizable/maximizable/
// minimizable all true, minSize (136,39), maxSize (107374182,107374182) and the platform's
// own bounds -- i.e. nothing from the descriptor reaches it. So these may only ever be
// read under `is_main`.
#ifdef ASC_WINDOW_FIXED
#define SK_MAIN_RESIZABLE 0
#else
#define SK_MAIN_RESIZABLE 1
#endif
#ifdef ASC_WINDOW_NOT_MAXIMIZABLE
#define SK_MAIN_MAXIMIZABLE 0
#else
#define SK_MAIN_MAXIMIZABLE 1
#endif
#ifdef ASC_WINDOW_NOT_MINIMIZABLE
#define SK_MAIN_MINIMIZABLE 0
#else
#define SK_MAIN_MINIMIZABLE 1
#endif

// Put AIR's frame style on a window: WS_THICKFRAME iff resizable, WS_MAXIMIZEBOX iff
// maximizable, WS_MINIMIZEBOX iff minimizable. AIR's own mapping, read off the real window
// with temp/nwwin/wstyle.exe (adl 51.4.1 on Windows 11), where the bits beside
// CAPTION|SYSMENU|BORDER|DLGFRAME are:
//
//   <resizable> <maximizable> <minimizable>   style
//   true        true         true            THICKFRAME|MAXIMIZEBOX|MINIMIZEBOX
//   true        false        true            THICKFRAME|MINIMIZEBOX
//   true        true         false           THICKFRAME|MAXIMIZEBOX
//   false       true         true            MAXIMIZEBOX|MINIMIZEBOX
//   false       false        true            MINIMIZEBOX
//
// SDL instead maps the single SDL_WINDOW_RESIZABLE flag onto THICKFRAME|MAXIMIZEBOX and
// always keeps MINIMIZEBOX, so any window whose maximizable/minimizable differ from its
// resizable comes out wrong. MAXIMIZEBOX is not cosmetic: Windows sizes a MAXIMIZED window
// to the WORK AREA when the bit is present and to the FULL MONITOR -- taskbar included --
// when it is absent (SDL's own WIN_MaximizeWindow comment says the OS "resizes the window
// weirdly (covering the taskbar)" without it), and adl follows that bit rather than the
// resizable one: a 366x630 frame on this 2560x1707 desktop settles at 2576x1675 (work area)
// with MAXIMIZEBOX and 2576x1723 (full monitor) without it, for <resizable> true and false
// alike. So the bit has to be right BEFORE a maximize, not only after it.
static void sk_win_apply_style(WinCtx* c) {
#ifdef _WIN32
  if (c == NULL || c->win == NULL) return;
  // A borderless window has no frame to style; AIR's own <systemChrome>none</systemChrome>
  // window keeps the caption bits but draws no non-client area, which is what SDL's
  // SDL_WINDOW_BORDERLESS (WS_POPUP) already gives observationally: a client equal to the
  // frame and 366x630 bounds for a 366x630 descriptor.
  if (!c->decorated) return;
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info) || info.subsystem != SDL_SYSWM_WINDOWS) return;
  HWND hwnd = info.info.win.window;
  LONG style = GetWindowLongPtrA(hwnd, GWL_STYLE);
  LONG want = style & ~(LONG)(WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX);
  if (c->resizable) want |= WS_THICKFRAME;
  if (c->maximizable) want |= WS_MAXIMIZEBOX;
  if (c->minimizable) want |= WS_MINIMIZEBOX;
  if (want == style) return;
  SetWindowLongPtrA(hwnd, GWL_STYLE, want);
  // The non-client area is laid out from the style, and SDL's own WIN_SetWindowResizable
  // skips this step (it only writes GWL_STYLE), which is why a runtime flip can leave a
  // stale title bar behind. A redundant SWP is cheaper than a maximize button that should
  // not be there.
  SetWindowPos(hwnd, NULL, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
#else
  (void)c;
#endif
}

// The replacement for SDL's -[SDLView isOpaque]. The signature must match BOOL(id, SEL),
// and ABI-wise BOOL is a signed char on arm64/x86_64.
#if defined(__APPLE__)
static signed char sk_view_is_opaque_no(void* self, SEL _cmd) { (void)self; (void)_cmd; return 0; }

// Clear the two opacity flags a view contributes to compositing: the view's own
// -isOpaque (swapped on its class, once) and its layer's opaque hint.
static void sk_view_clear_opaque(void* view, int on) {
  Class cls = object_getClass((id)view);
  static Class patched[8];
  static int patched_n = 0;
  int seen = 0;
  for (int i = 0; i < patched_n; i++) { if (patched[i] == cls) { seen = 1; break; } }
  if (!seen && patched_n < 8) {
    patched[patched_n++] = cls;
    Method m = class_getInstanceMethod(cls, sel_registerName("isOpaque"));
    // Only a class that actually overrides it needs swapping; NSView's own answer is
    // already NO, and replacing the base implementation would touch every view AppKit
    // owns (the window frame included).
    if (m != NULL) {
      IMP cur = method_getImplementation(m);
      if (cur != (IMP)sk_view_is_opaque_no) method_setImplementation(m, (IMP)sk_view_is_opaque_no);
    }
  }
  (void)on;
  void* layer = ((void* (*)(void*, SEL))objc_msgSend)(view, sel_registerName("layer"));
  if (layer != NULL) {
    ((void (*)(void*, SEL, signed char))objc_msgSend)(layer, sel_registerName("setOpaque:"), (signed char)0);
  }
}
#endif

// ---- Transparent-window present path (macOS) --------------------------------
//
// SDL2 has no transparent-window flag (SDL_WINDOW_TRANSPARENT is SDL3's), and the
// native route does not work either on this backend: with NSWindow.opaque = NO, a
// clear background, both view and layer -isOpaque overridden to NO and alpha 0
// pixels reaching the blit, the screen still showed opaque black. A 14-line bare
// SDL program reproduces it on both the Metal and the OpenGL renderer, so it is a
// property of SDL's backing store, not of our drawing (AGENTS.md §1.5;
// temp/transprobe/FINDINGS.md, temp/sdltrans.cc, temp/sdltrans2.cc).
//
// What DOES work (temp/sdl_layer.cc, temp/sdl_layer2.cc): make the content view
// LAYER-HOSTING — [contentView setLayer:] rather than wantsLayer — so SDLView stops
// painting its own opaque backing store, and hand each frame to a CALayer's
// `contents` as a CGImage instead of calling SDL_RenderPresent. The window's alpha
// channel then reaches the window server (measured: alpha histogram 0 / 235 over the
// whole window, rounded corners transparent).
//
// With ASC_WINDOW_VIBRANT an NSVisualEffectView sits UNDER the frame layer, so
// unpainted pixels show a blurred backdrop instead of the raw desktop: the macOS
// 毛玻璃 look, which is what a floating panel wants. That is a deliberate, documented
// DIVERGENCE from AIR (adl shows the desktop itself), so it is opt-in and off by
// default; see docs/zh-cn/compile.md.
#if defined(__APPLE__)
#define SK_OBJ(o, s) ((void* (*)(void*, SEL))objc_msgSend)((o), sel_registerName(s))
#define SK_SET_OBJ(o, s, v) ((void (*)(void*, SEL, void*))objc_msgSend)((o), sel_registerName(s), (v))
#define SK_SET_BOOL(o, s, v) ((void (*)(void*, SEL, signed char))objc_msgSend)((o), sel_registerName(s), (signed char)((v) ? 1 : 0))
#define SK_SET_INT(o, s, v) ((void (*)(void*, SEL, long))objc_msgSend)((o), sel_registerName(s), (long)(v))
#define SK_SET_DBL(o, s, v) ((void (*)(void*, SEL, double))objc_msgSend)((o), sel_registerName(s), (double)(v))
#define SK_ALLOC(cls) ((void* (*)(void*, SEL))objc_msgSend)((void*)objc_getClass(cls), sel_registerName("alloc"))
#define SK_NSRECT(o, s) ((sk_nsrect (*)(void*, SEL))objc_msgSend)((o), sel_registerName(s))
#define SK_SET_RECT(o, s, r) ((void (*)(void*, SEL, sk_nsrect))objc_msgSend)((o), sel_registerName(s), (r))

// NSView autoresizing bits: width + height sizable.
#define SK_AUTORESIZE_WH 18
// NSWindowLevel of a floating panel; the same 25 used by ak_window_set_level.
#define SK_PANEL_LEVEL 25
// 1 = the transparent window gets a frosted (vibrant) backdrop and rounded corners.
#if defined(ASC_WINDOW_VIBRANT)
#define SK_VIBRANT 1
#else
#define SK_VIBRANT 0
#endif
#define SK_PANEL_RADIUS 12.0

static CGColorSpaceRef sk_cg_device_rgb(void) {
  static CGColorSpaceRef cs = NULL;
  if (cs == NULL) cs = CGColorSpaceCreateDeviceRGB();
  return cs;
}

static void sk_cg_provider_release(void* info, const void* data, size_t size) {
  (void)info; (void)size;
  free((void*)data);
}

// A DISPLAY-ONLY VIEW. The frame host and the backdrop are subviews added ON TOP
// of SDL's own view, which makes them the window's hit view: AppKit then sends
// mouseDown to a plain NSView that forwards nothing, so SDL's mouse driver never
// runs and EVERY click in a transparent window was swallowed. Hover still worked,
// because SDL reads mouse-moved from a local event monitor (not view-routed),
// which made the symptom look like "the widgets are dead but the hit test is
// fine". Returning nil from hitTest: takes both views out of hit testing, so the
// window falls through to SDL's view underneath. Measured on the Prune panel
// (ASC_WINDOW_VIBRANT + transparent): before, no click ever reached AS3.
//
// Built through the ObjC runtime because this file is plain C++ and cannot
// include Cocoa (same reason as SKMenuTarget below).
typedef struct { double x, y; } sk_nspoint;

static void* sk_inert_hit_test(void* self, SEL _cmd, sk_nspoint pt) {
  (void)self; (void)_cmd; (void)pt;
  return NULL;
}

// One subclass of `base` whose instances ignore the pointer. Idempotent.
static void* sk_inert_view_class(const char* name, const char* base) {
  Class cls = objc_getClass(name);
  if (cls != NULL) return (void*)cls;
  cls = objc_allocateClassPair((Class)objc_getClass(base), name, 0);
  if (cls == NULL) return NULL;
  class_addMethod(cls, sel_registerName("hitTest:"), (IMP)sk_inert_hit_test, "@@:{CGPoint=dd}");
  objc_registerClassPair(cls);
  return (void*)cls;
}

// Defined further down (the NSString helper used by the menu/dock code); declared
// here because the transparent host layer needs it to name its contents gravity.
static void* sk_nsstring(const char* s);

// Keep a CALayer's contentsScale equal to the backing scale of the display the
// window is CURRENTLY on. This has to be re-read on every present, not set once:
// sk_mac_ensure_transparent makes the content view LAYER-HOSTING with setLayer:,
// and a layer-hosting view is by definition one whose backing AppKit no longer
// manages -- so neither it nor its sublayers get the contentsScale update AppKit
// would otherwise push on -viewDidChangeBackingProperties. The layers therefore
// keep the scale of the display the window was CREATED on.
//
// Measured on this box (2x built-in 1800x1169 + 1x external 2560x1440), Prune's
// 340x440 panel: it is created on the Retina screen (contentsScale 2.0), then
// opened on the 1x screen. The frame handed over was correctly 340x440 device px
// (do_resize had already reported the new size), but the layer still said 2.0, so
// CoreAnimation drew those 340x440 px as 170x220 POINTS: the whole panel appeared
// at half size in the top-left quarter, with the rest of the window empty. No
// amount of re-presenting fixes it -- the number itself was stale.
static void sk_layer_sync_scale(void* layer, double bs) {
  if (layer == NULL || bs <= 0.0) return;
  double cur = ((double (*)(void*, SEL))objc_msgSend)(layer, sel_registerName("contentsScale"));
  if (cur != bs) SK_SET_DBL(layer, "setContentsScale:", bs);
}

// The backing scale of the display this window is on right now (live NSWindow
// query, the same one sk_window_device_scale uses). 0.0 when it cannot be read.
static double sk_window_live_scale(SDL_Window* win) {
  return win != NULL ? sk_window_backing_scale(win) : 0.0;
}

// Build the layer tree that replaces SDL's opaque backing store. Idempotent, and a
// no-op on a non-transparent window.
static void sk_mac_ensure_transparent(WinCtx* c) {
  if (c == NULL || c->win == NULL || c->vib_host != NULL) return;
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info)) return;
  if (info.subsystem != SDL_SYSWM_COCOA) return;
  void* nswin = (void*)info.info.cocoa.window;
  if (nswin == NULL) return;
  void* view = SK_OBJ(nswin, "contentView");
  if (view == NULL) return;
  sk_nsrect bounds = SK_NSRECT(view, "bounds");

  // Layer-hosting: the view no longer draws, so the alpha the AS3 side leaves in
  // the frame is what the window server sees. A plain wantsLayer does NOT do this —
  // SDLView still fills its backing store with opaque black every display pass.
  SK_SET_BOOL(view, "setWantsLayer:", 1);
  void* container = SK_OBJ((void*)objc_getClass("CALayer"), "layer");
  if (container != NULL) {
    SK_SET_BOOL(container, "setOpaque:", 0);
    SK_SET_OBJ(view, "setLayer:", container);
  }
  // The renderer's own view composites an opaque frame; hide it rather than tear
  // the renderer down (other code still queries it, and a hidden view costs
  // nothing).
  void* subs = SK_OBJ(view, "subviews");
  if (subs != NULL) {
    unsigned long n = ((unsigned long (*)(void*, SEL))objc_msgSend)(subs, sel_registerName("count"));
    for (unsigned long i = 0; i < n; i++) {
      void* sv = ((void* (*)(void*, SEL, unsigned long))objc_msgSend)(subs, sel_registerName("objectAtIndex:"), i);
      if (sv != NULL) SK_SET_BOOL(sv, "setHidden:", 1);
    }
  }

#if SK_VIBRANT
  void* effcls = sk_inert_view_class("SKFrameEffectView", "NSVisualEffectView");
  void* eff = (effcls != NULL) ? SK_ALLOC("SKFrameEffectView") : SK_ALLOC("NSVisualEffectView");
  if (eff != NULL) {
    eff = ((void* (*)(void*, SEL, sk_nsrect))objc_msgSend)(eff, sel_registerName("initWithFrame:"), bounds);
    // Material 6 = popover, blending 0 = behindWindow (blurs what is BEHIND the
    // window, which is what makes it read as a floating panel), state 1 = active.
    SK_SET_INT(eff, "setMaterial:", 6);
    SK_SET_INT(eff, "setBlendingMode:", 0);
    SK_SET_INT(eff, "setState:", 1);
    SK_SET_BOOL(eff, "setWantsLayer:", 1);
    SK_SET_INT(eff, "setAutoresizingMask:", SK_AUTORESIZE_WH);
    SK_SET_OBJ(view, "addSubview:", eff);
    void* effl = SK_OBJ(eff, "layer");
    if (effl != NULL) {
      SK_SET_DBL(effl, "setCornerRadius:", SK_PANEL_RADIUS);
      SK_SET_BOOL(effl, "setMasksToBounds:", 1);
    }
    c->vib_eff = eff;
  }
#endif

  // The frame host is added LAST so it composites above the backdrop. It must be
  // pointer-inert (see sk_inert_view_class) or it steals every click.
  void* hostcls = sk_inert_view_class("SKFrameHostView", "NSView");
  // No silent breakage if the runtime class cannot be created: that fallback
  // DOES swallow input, so say so instead of looking healthy.
  if (hostcls == NULL) fprintf(stderr, "window_glue: SKFrameHostView unavailable, clicks will be lost\n");
  void* host = (hostcls != NULL) ? SK_ALLOC("SKFrameHostView") : SK_ALLOC("NSView");
  if (host == NULL) return;
  host = ((void* (*)(void*, SEL, sk_nsrect))objc_msgSend)(host, sel_registerName("initWithFrame:"), bounds);
  SK_SET_BOOL(host, "setWantsLayer:", 1);
  SK_SET_INT(host, "setAutoresizingMask:", SK_AUTORESIZE_WH);
  SK_SET_OBJ(view, "addSubview:", host);
  void* hl = SK_OBJ(host, "layer");
  if (hl != NULL) {
    SK_SET_BOOL(hl, "setOpaque:", 0);
    // The frame is presented by handing a CGImage to this layer's contents
    // (sk_mac_present_layer), and a CALayer's default contentsGravity is
    // kCAGravityResize: it STRETCHES the image to fill the layer's bounds. In the
    // steady state bounds*contentsScale == image size, so that is invisible -- but
    // every path where the layer's geometry moves before the next image arrives
    // (a live resize, and above all a programmatic nativeWindow.width/height write)
    // shows the PREVIOUS frame resampled to the new bounds, non-uniformly (the
    // aspect ratio changes whenever the image's aspect no longer matches).
    //
    // Measured on this box with temp/transjitter (transparent, high resolution, a
    // 40x40 logical red square = 80x80 device px, window toggled 400 -> 700 pt every
    // 300 ms): the square reads 140x80 on the frames that follow a resize and 45x80
    // on the way back -- i.e. the picture is scaled 1.75x horizontally and left
    // untouched vertically. This is the same defect class the Metal path pinned away
    // in stage 133 (kCAGravityTopLeft); the transparent path simply never got the
    // same line. AIR's NO_SCALE semantics are "content keeps its size, anchored
    // top-left": a frame whose size has not caught up must be shown 1:1 and clipped
    // (or padded), never resampled.
    SK_SET_OBJ(hl, "setContentsGravity:", sk_nsstring("topLeft"));
#if SK_VIBRANT
    SK_SET_DBL(hl, "setCornerRadius:", SK_PANEL_RADIUS);
    SK_SET_BOOL(hl, "setMasksToBounds:", 1);
#endif
  }
  c->vib_host = host;
}

// Re-pin every layer this path owns to the LIVE backing scale. Called from the
// present step (once per frame) rather than from a delegate callback: the whole
// hierarchy hangs off a layer-HOSTING content view, so AppKit's automatic
// -viewDidChangeBackingProperties propagation does not reach it (see
// sk_layer_sync_scale for the measured cross-display failure).
static void sk_mac_sync_layer_scales(WinCtx* c) {
  double bs = sk_window_live_scale(c->win);
  if (bs <= 0.0) return;
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info)) return;
  if (info.subsystem != SDL_SYSWM_COCOA || info.info.cocoa.window == NULL) return;
  void* view = SK_OBJ((void*)info.info.cocoa.window, "contentView");
  if (view != NULL) sk_layer_sync_scale(SK_OBJ(view, "layer"), bs);
  if (c->vib_eff != NULL) sk_layer_sync_scale(SK_OBJ(c->vib_eff, "layer"), bs);
  if (c->vib_host != NULL) sk_layer_sync_scale(SK_OBJ(c->vib_host, "layer"), bs);
}

// Copy the frame into a CGImage and hand it to the host layer. The copy is required:
// the source buffer is Skia's surface, which is rewritten next frame while
// CoreAnimation still holds the image.
//
// Channel order: on macOS Skia's N32 surface stores R,G,B,A bytes (see the masks in
// sk_window_show), so the image is built as "alpha last" in RGB space. 
static void sk_mac_present_layer(WinCtx* c, void* pixels, int w, int h, int rowBytes) {
  sk_mac_ensure_transparent(c);
  if (c->vib_host == NULL || pixels == NULL || w <= 0 || h <= 0) return;
  sk_mac_sync_layer_scales(c);
  size_t bytes = (size_t)rowBytes * (size_t)h;
  void* copy = malloc(bytes);
  if (copy == NULL) return;
  memcpy(copy, pixels, bytes);
  CGDataProviderRef prov = CGDataProviderCreateWithData(NULL, copy, bytes, sk_cg_provider_release);
  if (prov == NULL) { free(copy); return; }
  CGImageRef img = CGImageCreate((size_t)w, (size_t)h, 8, 32, (size_t)rowBytes, sk_cg_device_rgb(),
                                 kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault,
                                 prov, NULL, false, kCGRenderingIntentDefault);
  CGDataProviderRelease(prov);
  if (img == NULL) return;
  void* hl = SK_OBJ(c->vib_host, "layer");
  if (getenv("ASC_TRACE_TRANSPARENT") != NULL) {
    static int n = 0;
    if (n++ == 1) {
      sk_nsrect hb = SK_NSRECT(c->vib_host, "frame");
      sk_nsrect lb = hl ? SK_NSRECT(hl, "bounds") : hb;
      double sc = hl ? ((double (*)(void*, SEL))objc_msgSend)(hl, sel_registerName("contentsScale")) : 0.0;
      fprintf(stderr, "trace: img=%dx%d rowBytes=%d hostframe=%.0fx%.0f layerbounds=%.0fx%.0f scale=%.2f\n",
              w, h, rowBytes, hb.w, hb.h, lb.w, lb.h, sc);
    }
  }
  if (hl != NULL) SK_SET_OBJ(hl, "setContents:", (void*)img);
  CGImageRelease(img);
}
#endif  // __APPLE__

// Per-window transparency. SDL2 has no SDL_WINDOW_TRANSPARENT (that flag is SDL3's),
// so the platform side has to go through the native window handle. macOS: an NSWindow
// is opaque by default, which makes the compositor treat the whole client rect as
// filled; dropping that plus a clear background is what lets the window's own alpha
// channel show the desktop through. The CONTENT VIEW's layer must be non-opaque too,
// or CoreAnimation paints a black rectangle behind whatever the renderer draws.
static void sk_window_apply_transparent(SDL_Window* win, int on) {
  if (win == NULL) return;
#if defined(__APPLE__)
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(win, &info)) return;
  void* nswin = (void*)info.info.cocoa.window;
  if (nswin == NULL) return;
  ((void (*)(void*, SEL, signed char))objc_msgSend)(nswin, sel_registerName("setOpaque:"), (signed char)(on ? 0 : 1));
  void* color = on
      ? ((void* (*)(void*, SEL))objc_msgSend)((void*)objc_getClass("NSColor"), sel_registerName("clearColor"))
      : NULL;
  ((void (*)(void*, SEL, void*))objc_msgSend)(nswin, sel_registerName("setBackgroundColor:"), color);
  void* view = ((void* (*)(void*, SEL))objc_msgSend)(nswin, sel_registerName("contentView"));
  if (view != NULL) {
    // Every view in the window's hierarchy has to agree, on TWO levels, or the window
    // still composites as filled: the LAYER's -isOpaque (a CALayer hint) and the
    // VIEW's -isOpaque (what AppKit tells CoreAnimation about the backing store). SDL's
    // SDLView and SDL_cocoametalview both override the latter to answer YES, and that
    // answer beats NSWindow.opaque = NO -- measured on a real machine: with the window
    // and both layer flags cleared, the plaintext window still rendered opaque black
    // over its own alpha (temp/transprobe/aottrans.c). Swapping the method on each
    // class we meet is the only hook short of forking SDL, and it is idempotent.
    sk_view_clear_opaque(view, on);
    void* subs = ((void* (*)(void*, SEL))objc_msgSend)(view, sel_registerName("subviews"));
    if (subs != NULL) {
      unsigned long n = ((unsigned long (*)(void*, SEL))objc_msgSend)(subs, sel_registerName("count"));
      for (unsigned long i = 0; i < n; i++) {
        void* sv = ((void* (*)(void*, SEL, unsigned long))objc_msgSend)(subs, sel_registerName("objectAtIndex:"), i);
        if (sv != NULL) sk_view_clear_opaque(sv, on);
      }
    }
  }
#else
  // Not implemented on this backend. REPORT it once rather than hand back an opaque
  // window that silently ignores the flag (AGENTS.md §2.5: never a silent wrong
  // semantic). Windows would need DwmExtendFrameIntoClientArea + a layered surface.
  (void)win;
  if (on) {
    static int reported = 0;
    if (!reported) {
      reported = 1;
      fprintf(stderr, "window_glue: transparent windows are not implemented on this backend\n");
    }
  }
#endif
}

// The renderer's own layer. SDL's macOS renderer is the Metal one (verified with
// SDL_GetRendererInfo: name="metal"), and it composites through a CAMetalLayer that
// SDL leaves OPAQUE. Work is therefore split in two: this function kills the layer's
// opacity, sk_window_apply_transparent above kills the NSWindow's. Both are needed --
// dropping only one leaves an opaque black rectangle behind the drawn content (that is
// exactly what the first implementation did on a real machine: window pixels carried
// alpha 0 and reached here, and the screen still showed black).
static void sk_renderer_apply_transparent(SDL_Renderer* ren, int on) {
  if (ren == NULL) return;
#if defined(__APPLE__)
  void* layer = SDL_RenderGetMetalLayer(ren);
  if (layer != NULL) {
    ((void (*)(void*, SEL, signed char))objc_msgSend)(layer, sel_registerName("setOpaque:"), (signed char)(on ? 0 : 1));
  }
#else
  (void)on;
#endif
}

static int sk_open_window(int w, int h, const char* title, int decorated, int visible, int fullscreen, int highdpi, int is_main,
                          int resizable, int maximizable, int minimizable) {
  // The descriptor's <transparent> describes the app's initial window only, exactly
  // like <systemChrome> above -- a window the program creates carries the flag in
  // NativeWindowInitOptions and sets it through sk_window_set_transparent.
  int transparent = 0;
#ifdef ASC_WINDOW_TRANSPARENT
  if (is_main) transparent = 1;
#endif
  // The descriptor's <systemChrome> is the initial window's too: measured on adl 51.4.1,
  // a none-chrome initial window answers a client equal to its frame and 366x630 bounds
  // for a <width>366</width><height>630</height> descriptor, i.e. no frame at all -- what
  // SDL_WINDOW_BORDERLESS gives. is_main keeps it off every window the program makes.
#ifdef ASC_WINDOW_NOCHROME
  if (is_main) decorated = 0;
#endif
  Uint32 winFlags = visible ? SDL_WINDOW_SHOWN : SDL_WINDOW_HIDDEN;
  // resizable is a PER-WINDOW value, not the build-wide one it used to be: the caller
  // passes the descriptor's <resizable> for the app's initial window and
  // NativeWindowInitOptions.resizable for a `new NativeWindow()`. `#ifndef
  // ASC_WINDOW_FIXED` here is what made every program-made window fixed as well (AIR's
  // descriptor describes the first window only).
  if (resizable) winFlags |= SDL_WINDOW_RESIZABLE;
  if (highdpi) winFlags |= SDL_WINDOW_ALLOW_HIGHDPI;
  if (!decorated) winFlags |= SDL_WINDOW_BORDERLESS;
  SDL_Window* win = SDL_CreateWindow(
      title ? title : "AS3", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
      w, h, winFlags);
  if (win == NULL) {
    fprintf(stderr, "window_glue: SDL_CreateWindow failed: %s\n", SDL_GetError());
    return -1;
  }
  if (transparent) sk_window_apply_transparent(win, 1);
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
  c->transparent = transparent;
  // Deliberately not set here: the streaming texture's format is a property of the
  // surface handed in later, and sk_window_attach_surface / sk_window_show derive it
  // from that surface (sk_pixfmt_for_surface). Hardcoding it at window-creation time
  // is what produced the red/blue swap on Windows.
  c->pixfmt = SDL_PIXELFORMAT_UNKNOWN;
  sk_measure_borders(c, decorated);
  // NativeWindow.minSize/maxSize start at AIR's own defaults for this platform —
  // set HERE so both entry points (sk_window_show* for the app's initial window,
  // sk_window_create for a `new NativeWindow()`) get them, and so the numbers live
  // next to the other platform measurements. See sk_window_size_defaults.
  int dmnw = 0, dmnh = 0, dmxw = 0, dmxh = 0;
  sk_window_size_defaults(&dmnw, &dmnh, &dmxw, &dmxh);
  c->min_w = dmnw; c->min_h = dmnh; c->max_w = dmxw; c->max_h = dmxh;
  // Keep the three style flags (AIR's mapping, see sk_win_apply_style) and put the real
  // win32 style on the window now that it exists. Done here rather than at each call
  // site so the main window and every NativeWindow go through one place.
  c->resizable = resizable ? 1 : 0;
  c->maximizable = maximizable ? 1 : 0;
  c->minimizable = minimizable ? 1 : 0;
  sk_win_apply_style(c);
  // The descriptor's <minSize>/<maxSize>/<x>/<y>, which are likewise the initial window's.
  // The pair is clamped the way the AS3 setter clamps it -- floor for the min, min for the
  // max -- so a descriptor pair and a `minSize = ...` assignment cannot end up with two
  // different口径. (Measured on adl 51.4.1: `minSize = (0,0)` reads back the floor, and a
  // min above the max is pulled down to it, temp/nwmac/limits-out.txt.) A `null` test is
  // not needed: c->min_w/max_w hold the platform defaults already.
#if defined(ASC_WIN_MIN_W) || defined(ASC_WIN_MAX_W)
  if (is_main) {
    int fw = 0, fh = 0;
    int mnw = c->min_w, mnh = c->min_h, mxw = c->max_w, mxh = c->max_h;
    sk_window_size_floor(&fw, &fh);
#ifdef ASC_WIN_MIN_W
    mnw = ASC_WIN_MIN_W; mnh = ASC_WIN_MIN_H;
#endif
#ifdef ASC_WIN_MAX_W
    mxw = ASC_WIN_MAX_W; mxh = ASC_WIN_MAX_H;
#endif
    if (mnw < fw) mnw = fw;
    if (mnh < fh) mnh = fh;
    if (mxw < mnw) mxw = mnw;
    if (mxh < mnh) mxh = mnh;
    sk_window_set_limits(id, mnw, mnh, mxw, mxh);
  }
#endif
#if defined(ASC_WIN_X) || defined(ASC_WIN_Y)
  if (is_main) {
    // Half a position is legal in the descriptor (x and y are independent children), and
    // AIR does have an opinion about the other axis that we have not measured, so the
    // axis that was NOT given keeps whatever the platform chose rather than a guess.
    int px = 0, py = 0;
    SDL_GetWindowPosition(c->win, &px, &py);
#ifdef ASC_WIN_X
    px = ASC_WIN_X + c->b_left;
#endif
#ifdef ASC_WIN_Y
    py = ASC_WIN_Y + c->b_top;
#endif
    // SDL positions a window by its CLIENT origin -- measured on both backends: Cocoa keeps
    // window->x at contentRectForFrameRect's origin, win32 at the WM_MOVE client origin --
    // while AIR's bounds is the FRAME. So the frame borders go back on, including the
    // horizontal ones, where the two platforms differ (b_left 8 on Windows, 0 on macOS).
    SDL_SetWindowPosition(c->win, px, py);
  }
#endif
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
  // A transparent window's layer has to be re-flagged here, not in sk_open_window:
  // the renderer (and with it the CAMetalLayer) only exists once this returns. The
  // view-level pass has to run again for the same reason -- SDL adds its render view
  // as a SUBVIEW when the renderer is created, so the walk done at window creation
  // time never saw it, and that view answers -isOpaque YES.
  if (c->transparent) {
    sk_renderer_apply_transparent(ren, 1);
    sk_window_apply_transparent(c->win, 1);
  }
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
  c->pixfmt = sk_pixfmt_for_surface(c->surface);
  if (c->pixfmt == SDL_PIXELFORMAT_UNKNOWN) {
    fprintf(stderr, "window_glue: surface has an unsupported colour type (need 32-bit RGBA/BGRA)\n");
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
// Pixel format note: Skia's kN32 premultiplied surface stores either R,G,B,A or
// B,G,R,A bytes depending on how Skia was BUILT for the target (macOS: R,G,B,A;
// Windows: B,G,R,A), so the format is read from the surface itself via
// sk_pixfmt_for_surface and never assumed. Getting it wrong is not cosmetic: it
// swaps red and blue, which turned a blue button orange in a CPU-mode window on
// Windows.
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

  // Refresh the cached display size (DIP space -- see sk_refresh_display_size_cache)
  // while SDL is initialized.
  sk_refresh_display_size_cache();
  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_refresh = (double)dm.refresh_rate;
  }

  // The app's own initial window takes its whole style from the descriptor: the chrome
  // (ASC_WINDOW_NOCHROME) and the three style flags are read inside sk_open_window under
  // `is_main`, so nothing in the descriptor can reach a window the program makes.
  int id = sk_open_window(w, h, title, 1, 1, fullscreen,
#ifdef ASC_DISPLAY_HIGH
                         1, 1,
#else
                         0, 1,
#endif
                         SK_MAIN_RESIZABLE, SK_MAIN_MAXIMIZABLE, SK_MAIN_MINIMIZABLE);
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
  c->pixfmt = sk_pixfmt_for_surface(surface);
  if (c->pixfmt == SDL_PIXELFORMAT_UNKNOWN) {
    fprintf(stderr, "window_glue: surface has an unsupported colour type (need 32-bit RGBA/BGRA)\n");
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
  present_frame(c, c->pixels, c->pw, c->ph, c->rowBytes);

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

#ifdef ASC_RENDER_GL
// Attach a WGL context to a window. Identical shape to sk_attach_d3d above and
// for the same reason: this file owns the SDL2 window, gl_glue.cc owns everything
// GPU, and the only thing that crosses is the HWND. One extra requirement the
// D3D path does not have: the window's DC must not already carry a pixel format
// from another client, so the check below is about telling the two backends
// apart rather than about validating the WM.
static int sk_attach_gl(WinCtx* c, int id) {
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info)) {
    fprintf(stderr, "window_glue: SDL_GetWindowWMInfo failed: %s\n", SDL_GetError());
    return 0;
  }
  if (info.subsystem != SDL_SYSWM_WINDOWS) {
    // Loud, not silent (AGENTS.md §1.5): a WGL build on a non-Windows WM is a
    // backend mismatch, and falling back to the SDL CPU blit here would hide it.
    fprintf(stderr, "window_glue: the WGL backend needs a native Windows window (subsystem %d)\n", (int)info.subsystem);
    return 0;
  }
  if (!sk_gpu_init(id, (void*)info.info.win.window)) {
    fprintf(stderr, "window_glue: WGL backend init failed\n");
    return 0;
  }
  c->is_gpu = 1;
  return 1;
}
#endif  // ASC_RENDER_GL

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
#elif defined(ASC_RENDER_GL)
  return sk_attach_gl(c, id);
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

  sk_refresh_display_size_cache();
  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_refresh = (double)dm.refresh_rate;
  }

  int id = sk_open_window(w, h, title, 1, 1, fullscreen, 1, 1,
                          SK_MAIN_RESIZABLE, SK_MAIN_MAXIMIZABLE, SK_MAIN_MINIMIZABLE);
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
  double scale = sk_window_device_scale(c->win, &lw, &lh, pw, ph);
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
#elif defined(ASC_RENDER_D3D) || defined(ASC_RENDER_GL)
  // One loop for both native Windows backends: the event wiring, the initial
  // resize report and the live-resize watch are backend-neutral, and only the
  // attach step differs (hidden behind sk_attach_gpu).
  ensure_video();
  if (sk_video_init() != 0) {
    fprintf(stderr, "window_glue: SDL_Init failed: %s\n", SDL_GetError());
    return 0;
  }

  sk_refresh_display_size_cache();
  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_refresh = (double)dm.refresh_rate;
  }

  int id = sk_open_window(w, h, title, 1, 1, fullscreen, 1, 1,
                          SK_MAIN_RESIZABLE, SK_MAIN_MAXIMIZABLE, SK_MAIN_MINIMIZABLE);
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
  // The scale comes from sk_window_device_scale for the same reason it does on the
  // Metal path — dividing the two SDL sizes is only ever right while they are in
  // step, and this entry used to be the one Windows-only place that still did it.
  int lw = w, lh = h, pw = w, ph = h;
  SDL_GetWindowSize(c->win, &lw, &lh);
  SDL_GetWindowSizeInPixels(c->win, &pw, &ph);
  double scale = sk_window_device_scale(c->win, &lw, &lh, pw, ph);
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

int sk_window_create(int w, int h, const char* title, int resizable, int maximizable, int minimizable,
                     int decorated, int highdpi,
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
  // The three style flags are NativeWindowInitOptions' own values -- NOT the build-wide
  // ASC_WINDOW_FIXED, which describes the app's initial window only (AIR's descriptor does
  // not describe a window the program creates). Passing them here means the flag is right
  // from SDL_CreateWindow onward, so SDL_WINDOW_RESIZABLE does not have to be flipped on
  // afterwards -- a flip reaches the win32 style but leaves the non-client area stale unless
  // a frame-changed SetWindowPos follows (WIN_SetWindowResizable only writes GWL_STYLE).
  int id = sk_open_window(w, h, title, decorated, 0, 0, highdpi, 0, resizable, maximizable, minimizable);
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
    // The FRAME is centered, so the client origin it is derived from carries the left
    // border as well (0 on macOS, 8 on Windows).
    SDL_SetWindowPosition(c->win, dx + (dw - fw + 1) / 2 + c->b_left, dy + (dh - fh + 1) / 2 + c->b_top);
  }
  SDL_AddEventWatch(live_resize_watch, c);
  return id;
}

void sk_window_set_visible(int id, int visible) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) return;
  c->visible = visible ? 1 : 0;
  if (visible) {
    SDL_ShowWindow(c->win);
    c->dirty = 1;
    // Re-apply the transparency once the view hierarchy is really on screen: the
    // content view's layer may not exist yet when the constructor asked (a window
    // created by the program is transparent BEFORE it is ever shown).
    if (c->transparent) {
      sk_window_apply_transparent(c->win, 1);
      sk_renderer_apply_transparent(c->ren, 1);
      }
  }
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
//
// The horizontal border is part of that conversion too, and it is zero only on macOS:
// a win32 standard-chrome window has b_left = b_right = 8 (measured: frame 366x630 at
// 26,26 with clientOrigin 34,57 and client 350x591, temp/nwwin/out-ws-res.txt), so
// passing the frame x straight through as the client x put NativeWindow.x — and every
// `bounds = ...` — 8px to the left of what adl reports. macOS never showed it because
// its b_left is 0.
void sk_window_set_bounds(int id, int x, int y, int w, int h) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  int cw = w - c->b_left - c->b_right;
  int ch = h - c->b_top - c->b_bottom;
  if (cw < 1) cw = 1;
  if (ch < 1) ch = 1;
  SDL_SetWindowPosition(c->win, x + c->b_left, y + c->b_top);
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
  // The live pair, not SDL's cached one — see sk_client_size_live. The position needs
  // no such treatment: SDL writes window->x/y before it pushes the MOVED event, and
  // MOVED is what reaches us first.
  sk_client_size_live(c, &cw, &ch);
  // SDL reports the CLIENT origin; AIR's bounds is the frame, so both frame borders go
  // back on. b_left is 0 on macOS and 8 on Windows, which is why the x was right there
  // and 8px off here (see sk_window_set_bounds).
  if (x) *x = px - c->b_left;
  if (y) *y = py - c->b_top;
  if (w) *w = cw + c->b_left + c->b_right;
  if (h) *h = ch + c->b_top + c->b_bottom;
}

// Frame borders of a chrome-decorated window, in LOGICAL points: top, left,
// bottom, right. The counterparts of the b_* fields sk_measure_borders fills in
// (which divides SDL's physical measurement by the window's backing scale, see the
// comment there).
// NativeWindow.globalToScreen is the caller that needs them -- AIR's bounds is
// the OUTER frame rect while globalToScreen counts from the CLIENT area's
// top-left, so the border has to be added back. Measured on adl 51.4.1: bounds
// (26,26) with borders (8,31) answers globalToScreen(0,0) = (34,57).
void sk_window_get_borders(int id, int* top, int* left, int* bottom, int* right) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) {
    if (top) *top = 0; if (left) *left = 0; if (bottom) *bottom = 0; if (right) *right = 0;
    return;
  }
  if (top) *top = c->b_top;
  if (left) *left = c->b_left;
  if (bottom) *bottom = c->b_bottom;
  if (right) *right = c->b_right;
}

// ---------- NativeWindow minSize/maxSize ----------
// AIR's initial window size limits, per platform, and the floor a later minSize
// assignment is clamped to. These are AIR's own numbers, NOT the platform's: a bare
// NSWindow reports minSize (0,32) and maxSize FLT_MAX (measured with a 20-line
// Cocoa probe, temp/nwmac/nswin.m), while adl 51.4.1 answers (78,32) and
// (107374182,107374182) on macOS. The floor is the OS's minimum CONTENT size and is
// separately measurable: `minSize = (0,0)` reads back (2,32) and (100,10) reads back
// (100,32) on macOS (temp/nwmac/limits-out.txt).
//
// The Windows column is measured as well (adl 51.4.1 on Windows 11, temp/nwwin/):
// the defaults are 136x39 and 107374182x107374182, and the floor really does equal
// the minimum window size there -- `minSize = (0,0)` reads back (136,39) and
// (100,10) reads back (136,39), where macOS answers (2,32) and (100,32). The floor is
// therefore not one shared constant with two callers but the OS's own content
// minimum, and the two OSes really do disagree about it.
static void sk_window_size_defaults(int* mnw, int* mnh, int* mxw, int* mxh) {
#ifdef _WIN32
  if (mnw) *mnw = 136; if (mnh) *mnh = 39;
#else
  if (mnw) *mnw = 78; if (mnh) *mnh = 32;
#endif
  if (mxw) *mxw = 107374182; if (mxh) *mxh = 107374182;
}

static void sk_window_size_floor(int* fw, int* fh) {
#ifdef _WIN32
  if (fw) *fw = 136; if (fh) *fh = 39;
#else
  if (fw) *fw = 2; if (fh) *fh = 32;
#endif
}

void sk_window_limits_default(int* mnw, int* mnh, int* mxw, int* mxh) {
  sk_window_size_defaults(mnw, mnh, mxw, mxh);
}

void sk_window_limits_floor(int* fw, int* fh) {
  sk_window_size_floor(fw, fh);
}

// NativeWindow.minSize/maxSize. Stored here because they are a property of the OS
// window (a resize drag must respect them), and read back by the AS3 getters — so
// the clamp AIR applies is applied to one set of values, not to a copy of them.
void sk_window_get_limits(int id, int* mnw, int* mnh, int* mxw, int* mxh) {
  WinCtx* c = sk_slot(id);
  if (mnw) *mnw = (c != NULL) ? c->min_w : 0;
  if (mnh) *mnh = (c != NULL) ? c->min_h : 0;
  if (mxw) *mxw = (c != NULL) ? c->max_w : 0;
  if (mxh) *mxh = (c != NULL) ? c->max_h : 0;
}

void sk_window_set_limits(int id, int mnw, int mnh, int mxw, int mxh) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) return;
  c->min_w = mnw; c->min_h = mnh; c->max_w = mxw; c->max_h = mxh;
  if (c->win == NULL) return;
  // SDL has no "frame" size limits, only client ones, and the frame limits are
  // enforced by sk_sys_drag_step during a startResize drag — these calls only need
  // to stop the USER's own edge drag from leaving the range. 0 means "no limit" in
  // our vocabulary and SDL spells that as "any" when the value is <= 0.
  int cw = (mnw > 0) ? mnw - c->b_left - c->b_right : 0;
  int ch = (mnh > 0) ? mnh - c->b_top - c->b_bottom : 0;
  if (cw < 1) cw = 1;
  if (ch < 1) ch = 1;
  SDL_SetWindowMinimumSize(c->win, mnw > 0 ? cw : 0, mnh > 0 ? ch : 0);
  // Only a max the app actually chose is installed: AIR's own default maximum
  // (107374182, measured on adl 51.4.1) is what the AS3 side passes when nothing
  // was set, and handing that to SDL would clamp the window to a limit no user can
  // reach while making SDL believe a limit exists.
  if (mxw > 0 && mxw < SK_LIMIT_UNBOUNDED && mxh > 0 && mxh < SK_LIMIT_UNBOUNDED) {
    int cmw = mxw - c->b_left - c->b_right;
    int cmh = mxh - c->b_top - c->b_bottom;
    if (cmw < 1) cmw = 1;
    if (cmh < 1) cmh = 1;
    SDL_SetWindowMaximumSize(c->win, cmw, cmh);
  } else {
    SDL_SetWindowMaximumSize(c->win, 0, 0);
  }
}

// NativeWindow.startMove(): hand the frame over to the pointer until the button
// comes up. Returns AIR's true/false. A window that is maximized or minimized has
// no frame to drag, and a non-resizable window cannot be resized, so those are the
// false cases (AIR returns false for them too).
int sk_window_start_move(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return 0;
  Uint32 flags = SDL_GetWindowFlags(c->win);
  if (flags & (SDL_WINDOW_MAXIMIZED | SDL_WINDOW_MINIMIZED)) return 0;
  sk_sys_drag_begin(c, 1, 0, 0, 0, 0);
  return 1;
}

// NativeWindow.startResize(): same, for one edge or corner. `edge` uses the values
// of flash.display.NativeWindowResize ("T","B","L","R","TL","TR","BL","BR";
// NONE is the empty string and is not a drag). A non-resizable window refuses.
int sk_window_start_resize(int id, const char* edge) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL || edge == NULL) return 0;
  if (!(SDL_GetWindowFlags(c->win) & SDL_WINDOW_RESIZABLE)) return 0;
  int t = 0, b = 0, l = 0, r = 0;
  for (const char* p = edge; *p != '\0'; p++) {
    if (*p == 'T') t = 1;
    else if (*p == 'B') b = 1;
    else if (*p == 'L') l = 1;
    else if (*p == 'R') r = 1;
    else return 0;   // unknown edge: refuse rather than guess
  }
  if (!t && !b && !l && !r) return 0;
  sk_sys_drag_begin(c, 2, t, b, l, r);
  return 1;
}

// NativeApplication.exit(): stop the shared event loop at the next turn even
// though windows are still open. The flag is consumed in sk_run_loop, which then
// lets sk_service_destroy retire every window exactly like a natural shutdown, so
// the process exits with the same status either way.
void sk_window_request_exit(void) {
  g_exit_requested = 1;
}

// ---- flash.desktop icon family / NativeMenu glue (阶段二百五十五) ----
// The generated C hands over a FLATTENED menu tree (see runtime.ts `sk_menu`), so
// this translation unit never sees a generated C type. A click comes back through
// `cb` carrying the model's own 1-based tag, which is why the tag is assigned
// while flattening instead of being derived from an index here.
// Measured (temp/statusprobe/statuslog1.txt): a real NSStatusItem/NSMenu works
// inside an SDL app, and SDL's own Cocoa pump dispatches menu actions, so no
// extra NSEvent loop is needed.
typedef struct sk_menu_item_t { int kind; const char* label; int enabled; int checked; const char* key; int mods; int submenu; int tag; } sk_menu_item_t;
typedef struct sk_menu_t { const char* title; int first; int count; } sk_menu_t;

#if defined(__APPLE__)
static void (*g_menu_cb)(int) = NULL;
// Context-menu popup state (阶段二百八十九). popUpMenuPositioningItem: runs a nested
// tracking loop, so the selection is known when the call returns; this is how the
// action (which AppKit sends from inside that loop) finds its way back out.
static int g_popup_mode = 0;
static int g_popup_tag = 0;
// Kept in statics so ARC-less retain counts never reach zero while the menu is
// still on screen; both are replaced wholesale on the next install.
static void* g_app_nsmenu = NULL;
static void* g_dock_nsmenu = NULL;

static void sk_send_void(void* o, const char* sel) { ((void (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }
static void* sk_send_obj(void* o, const char* sel) { return ((void* (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }
static void sk_send_void_obj(void* o, const char* sel, void* a) { ((void (*)(void*, SEL, void*))objc_msgSend)(o, sel_registerName(sel), a); }
static void sk_send_void_int(void* o, const char* sel, long v) { ((void (*)(void*, SEL, long))objc_msgSend)(o, sel_registerName(sel), v); }
static void sk_send_void_bool(void* o, const char* sel, int v) { ((void (*)(void*, SEL, signed char))objc_msgSend)(o, sel_registerName(sel), (signed char)(v ? 1 : 0)); }
static int sk_send_int(void* o, const char* sel) { return (int)((long (*)(void*, SEL))objc_msgSend)(o, sel_registerName(sel)); }

// AppKit's NSApp. NEVER call +[NSApplication sharedApplication] from here: menu
// installation runs from AS3 code that executes BEFORE the window is opened, and
// creating the application object that early leaves SDL unable to open a window at
// all (measured: with the old sharedApplication() call the process stayed alive
// with ZERO windows, while the identical program without the menu install showed
// its window). So NSApp is read, and an install that arrives too early is queued
// and applied from sk_run_loop, where video (and NSApp) are already up.
extern id NSApp;
static void* sk_nsapp(void) { return (void*)NSApp; }
static void* sk_nsstring(const char* s) {
  if (s == NULL) s = "";
  return ((void* (*)(void*, SEL, const char*))objc_msgSend)((void*)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), s);
}

// ---- Dock icon image (DockIcon.bitmaps) ----
// The picked bitmap arrives as STRAIGHT ARGB rows (BitmapData.pixels, 0xAARRGGBB,
// top-down), but NSBitmapImageRep's non-planar 8-bit format is PREMULTIPLIED RGBA in
// memory order R,G,B,A. Handing AppKit straight alpha is visible, not cosmetic: every
// semi-transparent pixel comes out too bright and a fully transparent one paints
// its colour (a black bar in a corner-cut icon). So the copy below premultiplies.
// `g_dock_have` records that AS3 owns the icon (even when the value is "clear it"),
// `g_dock_applied` that the current value already reached AppKit -- a set that
// arrives before NSApp exists is retried by sk_dock_image_flush from the event loop.
static void* g_dock_image = NULL;
static int g_dock_have = 0;
static int g_dock_applied = 0;
static void sk_dock_image_flush(void) {
  if (!g_dock_have || g_dock_applied) return;
  void* app = sk_nsapp();
  if (app == NULL) return;
  // nil restores the bundle's own icon (measured: bitmaps=[] puts the default back).
  sk_send_void_obj(app, "setApplicationIconImage:", g_dock_image);
  g_dock_applied = 1;
}
void sk_dock_set_icon_image(const void* argb, int w, int h) {
  if (argb == NULL || w <= 0 || h <= 0) {
    g_dock_image = NULL; g_dock_have = 1; g_dock_applied = 0;
    sk_dock_image_flush();
    return;
  }
  void* rep = sk_send_obj((void*)objc_getClass("NSBitmapImageRep"), "alloc");
  if (rep == NULL) return;
  rep = ((void* (*)(void*, SEL, void*, long, long, long, long, signed char, signed char, void*, long, long))objc_msgSend)(
      rep, sel_registerName("initWithBitmapDataPlanes:pixelsWide:pixelsHigh:bitsPerSample:samplesPerPixel:hasAlpha:isPlanar:colorSpaceName:bytesPerRow:bitsPerPixel:"),
      NULL, (long)w, (long)h, 8L, 4L, (signed char)1, (signed char)0,
      sk_nsstring("NSDeviceRGBColorSpace"), (long)w * 4L, 32L);
  unsigned char* dst = (unsigned char*)sk_send_obj(rep, "bitmapData");
  if (dst == NULL) return;
  // The rep pads rows to its own stride, so write at ITS bytesPerRow, not w*4.
  long rb = (long)sk_send_int(rep, "bytesPerRow");
  if (rb < (long)w * 4L) rb = (long)w * 4L;
  const unsigned* src = (const unsigned*)argb;
  for (int y = 0; y < h; y++) {
    unsigned char* row = dst + (size_t)y * (size_t)rb;
    const unsigned* srow = src + (size_t)y * (size_t)w;
    for (int x = 0; x < w; x++) {
      unsigned p = srow[x];
      unsigned a = (p >> 24) & 0xFFu;
      unsigned r = (p >> 16) & 0xFFu, g = (p >> 8) & 0xFFu, b = p & 0xFFu;
      if (a != 255u) {
        r = (r * a + 127u) / 255u; g = (g * a + 127u) / 255u; b = (b * a + 127u) / 255u;
      }
      row[x * 4 + 0] = (unsigned char)r;
      row[x * 4 + 1] = (unsigned char)g;
      row[x * 4 + 2] = (unsigned char)b;
      row[x * 4 + 3] = (unsigned char)a;
    }
  }
  void* img = sk_send_obj((void*)objc_getClass("NSImage"), "alloc");
  // Points == pixels: the Dock scales the tile to its own size anyway, which is what
  // makes AIR's "closest to 128" pick look sharp at some sizes and soft at others.
  img = ((void* (*)(void*, SEL, double, double))objc_msgSend)(img, sel_registerName("initWithSize:"), (double)w, (double)h);
  sk_send_void_obj(img, "addRepresentation:", rep);
  g_dock_image = img; g_dock_have = 1; g_dock_applied = 0;
  sk_dock_image_flush();
}

static void sk_menu_fired(void* self, SEL _cmd, void* sender) {
  (void)self; (void)_cmd;
  // A popup's menu is not the app/Dock menu: its action must land in the popup's own
  // tag, not in the installed menu's callback (the tag tables are different).
  if (g_popup_mode) { g_popup_tag = sk_send_int(sender, "tag"); return; }
  if (g_menu_cb != NULL) g_menu_cb(sk_send_int(sender, "tag"));
}
// The Dock asks the app DELEGATE (SDL installs its own) for the Dock menu.
static void* sk_dock_menu_answer(void* self, SEL _cmd, void* sender) {
  (void)self; (void)_cmd; (void)sender;
  return g_dock_nsmenu;
}

// One action target, created on first use. Built through the ObjC runtime so this
// file stays plain C++ (it is compiled as .cc, not .mm, and cannot include Cocoa).
static void* sk_menu_target(void) {
  static void* target = NULL;
  if (target != NULL) return target;
  Class cls = objc_getClass("SKMenuTarget");
  if (cls == NULL) {
    cls = objc_allocateClassPair((Class)objc_getClass("NSObject"), "SKMenuTarget", 0);
    if (cls == NULL) return NULL;
    class_addMethod(cls, sel_registerName("skFired:"), (IMP)sk_menu_fired, "v@:@");
    objc_registerClassPair(cls);
  }
  target = sk_send_obj((void*)cls, "new");
  return target;
}

static void* sk_nsmenu_new(const char* title) {
  void* m = sk_send_obj((void*)objc_getClass("NSMenu"), "alloc");
  m = ((void* (*)(void*, SEL, void*))objc_msgSend)(m, sel_registerName("initWithTitle:"), sk_nsstring(title));
  // AppKit otherwise re-derives enabled/checked from the responder chain and
  // overrides what the AS3 side set.
  sk_send_void_bool(m, "setAutoenablesItems:", 0);
  return m;
}

// keyEquivalentModifiers -> AppKit's mask.
//
// The four single modifiers were identified by pressing real keys at a real adl
// menu bar (temp/keyeqprobe): 15 = Cmd, 16 = Shift, 17 = Control, 18 = Option,
// 19 = none (and an empty array behaves like 19), 20 = INERT -- the item shows a
// plain "S" in the dropdown yet no combination of the four modifiers ever fired
// it, while [15,20] fired on Cmd+S exactly like [15]. AS_KEM_DEAD therefore
// carries 20 on its own: when nothing else is set the shortcut must stay
// unreachable. NSEventModifierFlagFunction (the Fn key) reproduces that: AppKit
// renders no glyph for it and none of the four keys can produce it, so the item
// keeps its "S" text and never fires. The mechanism AIR uses internally is not
// observable; only these two outcomes are measured.
#define SK_MOD_CMD     (1UL << 20)  // NSEventModifierFlagCommand
#define SK_MOD_SHIFT   (1UL << 17)  // NSEventModifierFlagShift
#define SK_MOD_CTRL    (1UL << 18)  // NSEventModifierFlagControl
#define SK_MOD_OPT     (1UL << 19)  // NSEventModifierFlagOption
#define SK_MOD_FN      (1UL << 23)  // NSEventModifierFlagFunction
static void sk_menu_apply_mods(void* item, int mods) {
  unsigned long mask = 0;
  if (mods & 1) mask |= SK_MOD_CMD;
  if (mods & 2) mask |= SK_MOD_SHIFT;
  if (mods & 4) mask |= SK_MOD_CTRL;
  if (mods & 8) mask |= SK_MOD_OPT;
  if (mask == 0 && (mods & 16)) mask |= SK_MOD_FN;
  sk_send_void_int(item, "setKeyEquivalentModifierMask:", (long)mask);
}

// Build one NSMenu (and, recursively, its submenus) out of the flattened model.
static void* sk_menu_build(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root) {
  if (menus == NULL || root < 0 || root >= nmenus) return NULL;
  void* menu = sk_nsmenu_new(menus[root].title != NULL ? menus[root].title : "");
  int first = menus[root].first;
  for (int i = 0; i < menus[root].count; i++) {
    int k = first + i;
    if (k < 0 || k >= nitems) break;
    if (items[k].kind == 1) {
      sk_send_void_obj(menu, "addItem:", sk_send_obj((void*)objc_getClass("NSMenuItem"), "separatorItem"));
      continue;
    }
    void* item = sk_send_obj((void*)objc_getClass("NSMenuItem"), "alloc");
    item = ((void* (*)(void*, SEL, void*, SEL, void*))objc_msgSend)(item, sel_registerName("initWithTitle:action:keyEquivalent:"),
        sk_nsstring(items[k].label), sel_registerName("skFired:"), sk_nsstring(items[k].key));
    sk_send_void_obj(item, "setTarget:", sk_menu_target());
    sk_send_void_int(item, "setTag:", items[k].tag);
    sk_menu_apply_mods(item, items[k].mods);
    if (items[k].submenu >= 0) {
      void* sub = sk_menu_build(menus, nmenus, items, nitems, items[k].submenu);
      if (sub != NULL) {
        sk_send_void_obj(sub, "setTitle:", sk_nsstring(items[k].label));
        sk_send_void_obj(item, "setSubmenu:", sub);
      }
    } else {
      sk_send_void_bool(item, "setEnabled:", items[k].enabled);
      sk_send_void_int(item, "setState:", items[k].checked ? 1 : 0);
    }
    sk_send_void_obj(menu, "addItem:", item);
  }
  return menu;
}

// A menu tree installed before NSApp exists is kept here verbatim (the model is
// arena-allocated by the generated C and never freed, so the pointers stay valid)
// and applied by sk_menu_flush from the event loop's first turn.
typedef struct {
  int set;
  const sk_menu_t* menus; int nmenus;
  const sk_menu_item_t* items; int nitems;
  int root; void (*cb)(int);
} sk_pending_menu;
static sk_pending_menu g_pending_app;
static sk_pending_menu g_pending_dock;

int sk_menu_supported(void) { return 1; }

static int sk_menu_apply_app(const sk_pending_menu* p) {
  if (p == NULL || !p->set || sk_nsapp() == NULL) return 0;
  g_menu_cb = p->cb;
  void* menu = sk_menu_build(p->menus, p->nmenus, p->items, p->nitems, p->root);
  if (menu == NULL) return 0;
  g_app_nsmenu = menu;
  sk_send_void_obj(sk_nsapp(), "setMainMenu:", menu);
  return 1;
}

static int sk_menu_apply_dock(const sk_pending_menu* p) {
  if (p == NULL || !p->set || sk_nsapp() == NULL) return 0;
  g_menu_cb = p->cb;
  void* menu = sk_menu_build(p->menus, p->nmenus, p->items, p->nitems, p->root);
  if (menu == NULL) return 0;
  g_dock_nsmenu = menu;
  void* del = sk_send_obj(sk_nsapp(), "delegate");
  if (del == NULL) return 0;
  Class dc = object_getClass((id)del);
  if (!class_respondsToSelector(dc, sel_registerName("applicationDockMenu:"))) {
    class_addMethod(dc, sel_registerName("applicationDockMenu:"), (IMP)sk_dock_menu_answer, "@@:@");
  }
  return 1;
}

// Apply anything queued while NSApp was still null. Idempotent: re-applying is the
// same as a fresh install, so calling it every time a window opens is safe.
static void sk_menu_flush(void) {
  if (g_pending_app.set) sk_menu_apply_app(&g_pending_app);
  if (g_pending_dock.set) sk_menu_apply_dock(&g_pending_dock);
  sk_dock_image_flush();
}

// SDL installs its OWN main menu when the application finishes launching, which
// happens on the first event pump -- i.e. AFTER sk_menu_flush has run. Rather than
// guess that ordering, the loop re-asserts the app's menu whenever AppKit's
// current main menu is not the one this app installed, and re-arms the Dock menu
// answer if the delegate changed. Both are pointer comparisons: no rebuilding.
static void sk_menu_ensure(void) {
  void* app = sk_nsapp();
  if (app == NULL) return;
  // A Dock icon set before the application object existed lands here on the first
  // pumped frame; once applied this is one int compare per frame.
  sk_dock_image_flush();
  if (g_app_nsmenu != NULL && sk_send_obj(app, "mainMenu") != g_app_nsmenu) {
    sk_send_void_obj(app, "setMainMenu:", g_app_nsmenu);
  }
  if (g_dock_nsmenu != NULL) {
    static void* armed_for = NULL;
    void* del = sk_send_obj(app, "delegate");
    if (del != NULL && del != armed_for) {
      Class dc = object_getClass((id)del);
      if (!class_respondsToSelector(dc, sel_registerName("applicationDockMenu:"))) {
        class_addMethod(dc, sel_registerName("applicationDockMenu:"), (IMP)sk_dock_menu_answer, "@@:@");
      }
      armed_for = del;
    }
  }
}

int sk_menu_install_app(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  g_pending_app.set = 1;
  g_pending_app.menus = menus; g_pending_app.nmenus = nmenus;
  g_pending_app.items = items; g_pending_app.nitems = nitems;
  g_pending_app.root = root; g_pending_app.cb = cb;
  return sk_menu_apply_app(&g_pending_app);
}

int sk_menu_install_dock(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  g_pending_dock.set = 1;
  g_pending_dock.menus = menus; g_pending_dock.nmenus = nmenus;
  g_pending_dock.items = items; g_pending_dock.nitems = nitems;
  g_pending_dock.root = root; g_pending_dock.cb = cb;
  return sk_menu_apply_dock(&g_pending_dock);
}

// NSInformationalRequest = 10, NSCriticalRequest = 0.
void sk_dock_bounce(int critical) {
  if (sk_nsapp() == NULL) return;
  ((void (*)(void*, SEL, long))objc_msgSend)(sk_nsapp(), sel_registerName("requestUserAttention:"), critical ? 0 : 10);
}

// ---- context-menu popup (阶段二百八十九) ----
// AppKit screen coordinates are BOTTOM-UP from the main display, while the model's
// screen space (NativeWindow.globalToScreen, sk_window_get_bounds) is SDL's: top-LEFT
// origin, y downward, measured in the same points. SDL_GetDisplayBounds(0) is that
// main display in exactly those units, so its height is the flip constant.
static double sk_screen_flip_y(double y) {
  SDL_Rect r;
  if (SDL_GetDisplayBounds(0, &r) != 0 || r.h <= 0) return y;
  return (double)r.h - y;
}

// Pop the menu up and BLOCK until it closes -- the same modality AIR has: the
// tracking loop inside popUpMenuPositioningItem: owns the event stream, so the
// pending rightMouseUp/rightClick stay queued until the menu is gone. Returns 1
// (resolved synchronously) with *tag = the chosen tag, or 0 for a dismissal.
int sk_menu_popup(int win, const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, double x, double y, int* tag, double* outx, double* outy) {
  if (tag != NULL) *tag = 0;
  // Default answer: the opening point. Replaced below with where the pointer really
  // was when the menu closed, which is what AIR replays the right release at.
  if (outx != NULL) *outx = x;
  if (outy != NULL) *outy = y;
  if (sk_nsapp() == NULL) return 0;
  void* menu = sk_menu_build(menus, nmenus, items, nitems, root);
  if (menu == NULL) return 0;
  g_popup_tag = 0;
  g_popup_mode = 1;
  // inView:nil means `atLocation:` is already in screen coordinates. With a nil
  // item the menu's TOP-LEFT corner goes to that point, which is what the model
  // measured for AIR (the menu opens down-right of the cursor).
  ((signed char (*)(void*, SEL, void*, double, double, void*))objc_msgSend)(
      menu, sel_registerName("popUpMenuPositioningItem:atLocation:inView:"),
      NULL, x, sk_screen_flip_y(y), NULL);
  g_popup_mode = 0;
  if (tag != NULL) *tag = g_popup_tag;
  // The tracking loop is over, so the pointer sits where the user picked or clicked
  // the menu away -- the dismissal point air replays the swallowed right release
  // at. SDL_GetGlobalMouseState answers in the same top-left screen space as x/y.
  if (outx != NULL || outy != NULL) {
    int gx = 0, gy = 0;
    SDL_GetGlobalMouseState(&gx, &gy);
    if (outx != NULL) *outx = (double)gx;
    if (outy != NULL) *outy = (double)gy;
  }
  return 1;
}

// Cocoa resolves inside sk_menu_popup, so nothing is ever pending here.
int sk_menu_popup_take(int* tag) {
  if (tag != NULL) *tag = 0;
  return 0;
}
#else
// Same two hooks as the Cocoa branch, as explicit no-ops: the frame pump and the
// event loop call them unconditionally, and this backend has no application menu
// to keep authoritative (sk_menu_supported() is 0 and both installers refuse).
static void sk_menu_flush(void) { }
static void sk_menu_ensure(void) { }
int sk_menu_supported(void) { return 0; }
int sk_menu_install_app(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root; (void)cb; return 0;
}
int sk_menu_install_dock(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, void (*cb)(int)) {
  (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root; (void)cb; return 0;
}
#if defined(_WIN32)
// ---- context-menu popup (阶段二百八十九) ----
// TrackPopupMenu is MODAL the same way Cocoa's popUpMenuPositioningItem: is: it runs
// its own message pump, so the pending rightMouseUp/rightClick stay queued until the
// menu closes -- the order AIR produces. TPM_RETURNCMD makes the call answer the
// chosen command id instead of posting WM_COMMAND, so no callback plumbing is
// needed. Command ids are 1-based positions inside the flattened array (separators
// take positions of their own), and the AS3 tag is carried separately.
//
// MEASURED ON WINDOWS (Windows 11 / 150% panel, temp/ctxwin, real mouse + keyboard
// input driven by drive.ps1): the popup opens under the cursor, closes with a pick,
// the emitted event order matches AIR's (rightMouseDown -> MENU_SELECT -> replayed
// rightMouseUp/rightClick -> item SELECT -> menu SELECT -> MENU_ITEM_SELECT), a second
// right-click pops again, and submenus open and select. Two things that bit and are
// fixed: the coordinates used to be pushed through ScreenToClient (see below), and
// the release the modal pump queues had to be swallowed (see g_popup_up_swallow).
// Remaining Windows-only gap: keyEquivalent is neither displayed nor wired up, so a
// menu item shows its label only (a Win32 menu needs a message filter to honour an
// accelerator during TrackPopupMenu).
static void sk_utf8_to_wide(const char* s, wchar_t* out, int cap) {
  if (cap <= 0) return;
  out[0] = 0;
  if (s == NULL) return;
  if (MultiByteToWideChar(CP_UTF8, 0, s, -1, out, cap) <= 0) out[0] = 0;
}
// One HMENU (and, recursively, its submenus) out of the flattened model -- the exact
// counterpart of sk_menu_build on the Cocoa side, so a nested NativeMenu behaves the
// same on both. Attaching submenus is not optional: a ContextMenu with a submenu used
// to lose those items entirely and silently.
// Command ids stay "flat index + 1" so the tag lookup below is unchanged. A submenu
// parent gets an id from a separate high range: MF_POPUP's id is never returned as a
// command, but keeping the two namespaces apart costs nothing.
static HMENU sk_win_menu_build(const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root) {
  if (menus == NULL || root < 0 || root >= nmenus) return NULL;
  HMENU menu = CreatePopupMenu();
  if (menu == NULL) return NULL;
  int first = menus[root].first;
  for (int i = 0; i < menus[root].count; i++) {
    int k = first + i;
    if (k < 0 || k >= nitems) break;
    if (items[k].kind == 1) { AppendMenuW(menu, MF_SEPARATOR, 0, NULL); continue; }
    wchar_t wlabel[512];
    sk_utf8_to_wide(items[k].label, wlabel, 512);
    if (items[k].submenu >= 0) {
      HMENU sub = sk_win_menu_build(menus, nmenus, items, nitems, items[k].submenu);
      // MF_POPUP takes the SUBMENU HANDLE in uIDNewItem and the label in lpNewItem --
      // not an id. Passing an id here silently turns the parent into a plain command
      // (measured: the arrow beside it never opened anything and Right did nothing).
      if (sub != NULL) { AppendMenuW(menu, MF_POPUP | MF_STRING, (UINT_PTR)sub, wlabel); continue; }
    }
    UINT flags = MF_STRING;
    if (!items[k].enabled) flags |= MF_GRAYED;
    if (items[k].checked) flags |= MF_CHECKED;
    AppendMenuW(menu, flags, (UINT_PTR)(k + 1), wlabel);
  }
  return menu;
}
int sk_menu_popup(int win, const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, double x, double y, int* tag, double* outx, double* outy) {
  if (tag != NULL) *tag = 0;
  if (outx != NULL) *outx = x;
  if (outy != NULL) *outy = y;
  if (menus == NULL || items == NULL || root < 0 || root >= nmenus) return 0;
  WinCtx* c = sk_slot(win);
  if (c == NULL || c->win == NULL) return 0;
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  if (!SDL_GetWindowWMInfo(c->win, &info)) return 0;
  HWND hwnd = info.info.win.window;
  if (hwnd == NULL) return 0;
  HMENU menu = sk_win_menu_build(menus, nmenus, items, nitems, root);
  if (menu == NULL) return 0;
  // SCREEN coordinates (never the client area -- ScreenToClient put the menu at the
  // click's CLIENT point, measured at (101,101) for a click at (1480,1020)), and in
  // PHYSICAL pixels rather than the DIP the model works in. Everything upstream is
  // DIP: the stage is DIP (the canvas is scaled by w->scale), NativeWindow.bounds is
  // DIP, and SDL reports window/mouse positions in DIP as well. TrackPopupMenu, in a
  // per-monitor-DPI-aware process, wants physical pixels, so the point has to be
  // scaled by the window's DPI factor. Measured on this 150% box (temp/ctxpos), on
  // the meeting window at physical (1605,1049) 2200x1319 with the client origin at
  // (1616,1094): a right click on the user row at physical (3516,1245) put the
  // 206x111 popup at (2344,830), which is exactly the click divided by 1.5. The
  // earlier temp/ctxwin probe looked correct only because the PowerShell that
  // measured it was DPI-unaware, so every number it compared had been divided by
  // the same 1.5 -- see docs/zh-cn/desktop.md.
  double bk = sk_window_backing_scale(c->win);
  if (!(bk > 0.0)) bk = 1.0;
  POINT pt;
  pt.x = (LONG)(x * bk + (x >= 0.0 ? 0.5 : -0.5));
  pt.y = (LONG)(y * bk + (y >= 0.0 ? 0.5 : -0.5));
  // The modal pump below queues the real right release; see g_popup_up_swallow.
  g_popup_up_swallow = 1;
  int cmd = (int)TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, NULL);
  DestroyMenu(menu);
  if (tag != NULL && cmd > 0 && cmd - 1 < nitems) *tag = items[cmd - 1].tag;
  // Same contract as Cocoa: the pointer at dismissal, not the press point -- and
  // back in DIP, because the caller turns it into stage coordinates for the
  // replayed rightMouseUp/rightClick (ASC_window_on_mouse divides by the stage
  // scale, so a physical answer here would be off by bk).
  if (outx != NULL || outy != NULL) {
    POINT g;
    if (GetCursorPos(&g)) {
      if (outx != NULL) *outx = (double)g.x / bk;
      if (outy != NULL) *outy = (double)g.y / bk;
    }
  }
  return 1;
}
int sk_menu_popup_take(int* tag) {
  if (tag != NULL) *tag = 0;
  return 0;
}
#else
// No popup on this backend: report "resolved, nothing chosen" so the caller never
// waits for a menu that will not appear.
int sk_menu_popup(int win, const sk_menu_t* menus, int nmenus, const sk_menu_item_t* items, int nitems, int root, double x, double y, int* tag, double* outx, double* outy) {
  (void)win; (void)menus; (void)nmenus; (void)items; (void)nitems; (void)root;
  if (tag != NULL) *tag = 0;
  if (outx != NULL) *outx = x;
  if (outy != NULL) *outy = y;
  return 1;
}
int sk_menu_popup_take(int* tag) {
  if (tag != NULL) *tag = 0;
  return 0;
}
#endif
void sk_dock_bounce(int critical) { (void)critical; }
// No Dock on the other window backends either, and the generated C only calls this
// when ASC_HAS_DOCK_IMAGE is 1 (Cocoa). Defined anyway so a future backend that
// flips the macro cannot fail to link.
void sk_dock_set_icon_image(const void* argb, int w, int h) { (void)argb; (void)w; (void)h; }
#endif

// NativeApplication.autoExit = false: keep the loop alive with zero open windows
// (the Dock-icon-only shape). Measured on adl 51.4.1: with autoExit=false and only
// a hidden window the application keeps running, so this is AIR behaviour and not
// an invention.
void sk_window_set_auto_exit(int on) { g_auto_exit = on ? 1 : 0; }

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

// Did the window manager ask this window to close since the last call? The AS3
// side polls it once per frame: a request is answered with Event.CLOSING (which a
// listener may cancel) and, unless it was cancelled, with close(). Taking the flag
// clears it, so one gesture is reported exactly once.
int sk_window_take_close_request(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) return 0;
  int r = c->close_request;
  c->close_request = 0;
  return r;
}

// A NativeWindow is created hidden and raised by activate(), which per adl also
// makes it visible — the two are one gesture there, so they are one call here.
void sk_window_activate(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  if (!c->visible) { c->visible = 1; SDL_ShowWindow(c->win); c->dirty = 1; }
  // AIR's activate() is "bring this window to the front and give it focus", and a
  // minimized window has to come back first: adl 51.4.1 answers
  // activate() on a minimized window with DISPLAY_STATE_CHANGE + ACTIVATE
  // (temp/nwmac/ev-out-adl.txt t5b, whose displayState reads back "normal"). SDL
  // needs the explicit restore — raising a minimized window leaves it minimized.
  if (SDL_GetWindowFlags(c->win) & SDL_WINDOW_MINIMIZED) SDL_RestoreWindow(c->win);
  SDL_RaiseWindow(c->win);
}

void sk_window_minimize(int id) {
  WinCtx* c = sk_slot(id);
  if (c != NULL && c->win != NULL) SDL_MinimizeWindow(c->win);
}

void sk_window_maximize(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  // SDL's win32 backend refuses to maximize a window without SDL_WINDOW_RESIZABLE
  // (WIN_MaximizeWindow: `if (window->flags & SDL_WINDOW_RESIZABLE) { ...
  // ShowWindow(hwnd, SW_MAXIMIZE); }`), while Cocoa's zoom: carries no such guard.
  // A --air-app build with <resizable>false</resizable> creates exactly that window
  // (ASC_WINDOW_FIXED), so the same AS3 call would maximize on macOS and silently do
  // nothing on Windows -- and AIR does maximize it: adl 51.4.1 on Windows answers
  // displayState=maximized for that descriptor shape (temp/nwwin/out-mx-fix.txt).
  //
  // Lend the flag for the duration of the call instead of leaving it on. Measured with
  // temp/nwwin/probe.c (SDL 2.32.10, Windows 11): the window really maximizes; its style
  // has no WS_THICKFRAME while the flag is off, so it stays non-resizable; and a second
  // maximize with the flag off is still refused, i.e. nothing leaks between calls.
  //
  // The style is re-applied to AIR's mapping around the call, and that is not cosmetic:
  // Windows sizes a maximized window to the WORK AREA when WS_MAXIMIZEBOX is present and
  // to the FULL MONITOR -- taskbar included -- when it is absent, and adl follows that bit
  // rather than <resizable>: a 366x630 frame on this 2560x1707 desktop settles at
  // 2576x1675 with <maximizable>true and 2576x1723 with <maximizable>false, for
  // <resizable> true and false alike (temp/nwwin/out-ws-*.txt). SDL_SetWindowResizable
  // puts MAXIMIZEBOX back, so the strip has to happen after the lend and before the call.
  // The non-Windows branches keep the bare call: on macOS a style-mask round trip around
  // zoom: is not known to be neutral, and there it is not needed.
#ifdef _WIN32
  int was = (SDL_GetWindowFlags(c->win) & SDL_WINDOW_RESIZABLE) != 0;
  if (!was) SDL_SetWindowResizable(c->win, SDL_TRUE);
  sk_win_apply_style(c);
  SDL_MaximizeWindow(c->win);
  if (!was) SDL_SetWindowResizable(c->win, SDL_FALSE);
  sk_win_apply_style(c);
#else
  SDL_MaximizeWindow(c->win);
#endif
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
  if (c != NULL && c->win != NULL) { sk_client_size_live(c, lw, lh); return; }
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
// The display state as the WINDOW sees it: 0 normal, 1 minimized, 2 maximized,
// -1 = cannot say. AIR's NativeWindow.displayState follows the window manager, not
// the last call the app made: the maximize box, a title-bar double-click and a
// taskbar minimize all change it without calling anything on the AS3 side, and
// adl reports "maximized" for exactly those (the poll in the generated C then sees
// the transition it must dispatch displayStateChange for). An app that decides
// maximize-vs-restore from displayState -- the TalkMED meeting window does -- would
// otherwise call maximize() again on an already maximized window and never restore.
//
// Full screen answers -1 on purpose: whether a window is "fullScreen" is an AS3-side
// notion (the OS flag pair is also set by backends that keep displayState "normal"),
// so the caller must keep its own record there rather than have it overwritten.
int sk_window_os_display_state(int id) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return -1;
  SDL_PumpEvents();
  Uint32 f = SDL_GetWindowFlags(c->win);
  if (f & (SDL_WINDOW_FULLSCREEN | SDL_WINDOW_FULLSCREEN_DESKTOP)) return -1;
  if (f & SDL_WINDOW_MINIMIZED) return 1;
  if (f & SDL_WINDOW_MAXIMIZED) return 2;
  return 0;
}
// NativeWindow.alwaysInFront. SDL_SetWindowAlwaysOnTop exists since 2.0.16
// (we pin 2.32).
void sk_window_set_always_in_front(int id, int on) {
  WinCtx* c = sk_slot(id);
  if (c == NULL || c->win == NULL) return;
  c->always_in_front = on ? 1 : 0;
  SDL_SetWindowAlwaysOnTop(c->win, on ? SDL_TRUE : SDL_FALSE);
}

// NativeWindowInitOptions.transparent for a window the PROGRAM creates (the initial
// window takes the same path at creation time, from ASC_WINDOW_TRANSPARENT). Latched
// on the context because the present step reads it every frame, and applied to the
// native window immediately: the AS3 constructor runs before the window is shown.
void sk_window_set_transparent(int id, int on) {
  WinCtx* c = sk_slot(id);
  if (c == NULL) return;
  c->transparent = on ? 1 : 0;
  sk_window_apply_transparent(c->win, c->transparent);
  sk_renderer_apply_transparent(c->ren, c->transparent);
  c->dirty = 1;
}

// The main window's id, for the generated boot code (Stage.showWindow).
int sk_window_main(void) { return g_main; }

}  // extern "C"