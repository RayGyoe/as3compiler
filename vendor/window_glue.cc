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

// SDL.h on macOS redefines `main` as `SDL_main` unless this is defined first.
// Our generated .c provides its own standard `int main(void)`, so we opt out
// of SDL's main wrapping here.
#define SDL_MAIN_HANDLED
#include <SDL2/SDL.h>
#include <cstdio>
#include <cstdint>

extern "C" {

int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes);

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
static void ensure_video(void) {
  static int inited = 0;
  if (!inited) { SDL_Init(SDL_INIT_VIDEO); inited = 1; }
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
      // SDL_GL_GetDrawableSize is SDL2's accessor for the physical pixel size of a
      // window's backing store; it works for non-GL windows too (the Cocoa backend
      // fills it from the layer's contentsSize * contentsScale).
      SDL_GL_GetDrawableSize(probe, &dw, &dh);
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
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return 0;
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

// Query the primary display's refresh rate in Hz. Returns 0 when it cannot be
// determined (caller falls back to a compiler-side default).
double sk_window_get_display_refresh(void) {
  if (g_display_refresh <= 0.0) {
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return 0.0;
    SDL_DisplayMode dm;
    if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
      g_display_refresh = (double)dm.refresh_rate;
    }
    SDL_Quit();
  }
  return g_display_refresh;
}

// Callback types handed in from the generated C code. on_mouse receives the
// window-relative x/y and an AS3 event-type string ("mouseDown"/"mouseUp"/
// "click"); on_redraw is invoked after every handled event so the AS3 side can
// re-rasterize the (possibly mutated) display tree into the same surface.
typedef void (*sk_mouse_cb)(double x, double y, const char* type);
typedef void (*sk_wheel_cb)(double x, double y, double delta);
typedef void (*sk_redraw_cb)(void);
typedef void (*sk_frame_cb)(void);
typedef double (*sk_frame_delay_cb)(void);
// Invoked after the window changed size. The AS3 side rebuilds its offscreen
// surface at the new *physical* pixel size, re-renders the tree into it, and
// returns the new surface pointer (NULL on failure, meaning "keep the old
// one"). Ownership stays with the AS3 side, which also frees the previous
// surface. This is what keeps a resized window from stretching the content.
typedef void* (*sk_resize_cb)(int logicalW, int logicalH, int physW, int physH);

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

// Window render state shared between the main loop and the live-resize event
// filter. On macOS the SDL_PollEvent call blocks for the whole duration of a
// window drag/resize (Cocoa runs its own tracking loop), so the main loop stalls
// and neither rebuilds the surface nor advances the frame — which is why the
// content stretches and the animation freezes until the mouse is released. The
// event filter (SDL_AddEventWatch) is the only hook SDL still calls during that
// block, so the state lives here for it to drive a frame too.
struct WinCtx {
  SDL_Window* win;
  SDL_Renderer* ren;
  SDL_Texture* tex;
  void* surface;
  void* pixels;
  int rowBytes;
  int pw, ph;
  Uint32 pixfmt;
  sk_resize_cb on_resize;
  sk_redraw_cb on_redraw;
  sk_frame_cb on_frame;
  int in_watch;
};

// Rebuild the offscreen surface + streaming texture to the window's current
// size. Returns 1 when a resize happened, 0 when the size is unchanged, -1 when
// the new surface no longer exposes pixels (fatal).
static int do_resize(WinCtx* c) {
  int nw = 0, nh = 0, npw = 0, nph = 0;
  SDL_GetWindowSize(c->win, &nw, &nh);
  SDL_GL_GetDrawableSize(c->win, &npw, &nph);
  if (npw <= 0 || nph <= 0) { npw = nw; nph = nh; }
  if (npw == c->pw && nph == c->ph) return 0;
  if (c->on_resize != NULL) {
    void* ns = c->on_resize(nw, nh, npw, nph);
    if (ns != NULL) {
      c->surface = ns;
      if (!sk_surface_peek_pixels(c->surface, &c->pixels, &c->rowBytes)) return -1;
    }
  }
  c->pw = npw; c->ph = nph;
  SDL_DestroyTexture(c->tex);
  c->tex = SDL_CreateTexture(c->ren, c->pixfmt, SDL_TEXTUREACCESS_STREAMING, c->pw, c->ph);
  if (c->tex != NULL) SDL_SetTextureBlendMode(c->tex, SDL_BLENDMODE_NONE);
  return 1;
}

// Event filter: SDL invokes this as events are pumped, which on macOS still
// happens while the main loop is blocked inside a live-resize drag. Rebuilding
// the surface and presenting a frame here is what keeps the content from
// stretching and the animation from freezing during the drag.
static int SDLCALL live_resize_watch(void* userdata, SDL_Event* e) {
  WinCtx* c = (WinCtx*)userdata;
  if (c->in_watch) return 1;
  if (e->type != SDL_WINDOWEVENT) return 1;
  Uint8 we = e->window.event;
  if (we != SDL_WINDOWEVENT_SIZE_CHANGED &&
      we != SDL_WINDOWEVENT_RESIZED &&
      we != SDL_WINDOWEVENT_EXPOSED) return 1;
  c->in_watch = 1;
  int rres = do_resize(c);
  if (rres >= 0 && c->on_redraw != NULL) {
    if (c->on_frame != NULL) c->on_frame();
    c->on_redraw();
    present_frame(c->ren, c->tex, c->pixels, c->pw, c->ph, c->rowBytes);
  }
  c->in_watch = 0;
  return 1;
}

// Show a Skia offscreen raster surface in a window and block on the SDL event
// loop until the user closes it. Returns 1 on a clean run, 0 on any setup
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
                   sk_redraw_cb on_redraw, sk_frame_cb on_frame,
                   sk_frame_delay_cb on_frame_delay, sk_resize_cb on_resize) {
  ensure_video();
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "window_glue: SDL_Init failed: %s\n", SDL_GetError());
    return 0;
  }

  // Refresh the cached display size while SDL is initialized.
  SDL_DisplayMode dm;
  if (SDL_GetCurrentDisplayMode(0, &dm) == 0) {
    g_display_w = dm.w; g_display_h = dm.h;
    g_display_refresh = (double)dm.refresh_rate;
  }

  // Window flags: resizable unless ASC_WINDOW_FIXED mirrors AIR's
  // <resizable>false</resizable> (fixed-size window, matching adl). ASC_DISPLAY_HIGH
  // mirrors <requestedDisplayResolution>high</requestedDisplayResolution> and asks
  // SDL for a native-resolution drawable.
  Uint32 winFlags = SDL_WINDOW_SHOWN;
#ifndef ASC_WINDOW_FIXED
  winFlags |= SDL_WINDOW_RESIZABLE;
#endif
#ifdef ASC_DISPLAY_HIGH
  winFlags |= SDL_WINDOW_ALLOW_HIGHDPI;
#endif
  SDL_Window* win = SDL_CreateWindow(
      title ? title : "AS3", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
      w, h, winFlags);
  if (win == NULL) {
    fprintf(stderr, "window_glue: SDL_CreateWindow failed: %s\n", SDL_GetError());
    SDL_Quit();
    return 0;
  }

  // Stage.displayState = FULL_SCREEN is applied here, before the event loop
  // (SDL_WINDOW_FULLSCREEN_DESKTOP keeps the desktop resolution).
  if (fullscreen) SDL_SetWindowFullscreen(win, SDL_WINDOW_FULLSCREEN_DESKTOP);

  // Prefer the hardware renderer (Metal) — the final blit and present are far
  // cheaper there than in SDL_RENDERER_SOFTWARE, which is the real ceiling at
  // high Stage.frameRate. Fall back to software when no GPU is available.
  SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
  if (ren == NULL) ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_SOFTWARE);
  if (ren == NULL) {
    fprintf(stderr, "window_glue: SDL_CreateRenderer failed: %s\n", SDL_GetError());
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
  }

  // Window render state lives in a single context shared with the live-resize
  // event filter (see WinCtx above).
  WinCtx ctx;
  ctx.win = win;
  ctx.ren = ren;
  ctx.tex = NULL;
  ctx.surface = surface;
  ctx.pixels = NULL;
  ctx.rowBytes = 0;
  ctx.pw = pw; ctx.ph = ph;
  ctx.pixfmt = SDL_MasksToPixelFormatEnum(32, 0x000000FFu, 0x0000FF00u, 0x00FF0000u, 0xFF000000u);
  ctx.on_resize = on_resize;
  ctx.on_redraw = on_redraw;
  ctx.on_frame = on_frame;
  ctx.in_watch = 0;
  if (!sk_surface_peek_pixels(ctx.surface, &ctx.pixels, &ctx.rowBytes)) {
    fprintf(stderr, "window_glue: surface does not expose pixels (not CPU raster)\n");
    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
  }

  // Initial frame (the surface is already rasterized by Stage_showWindow).
  // The streaming texture is created once and updated in place every frame; the
  // format is derived from the exact channel masks so it can never mismatch.
  ctx.tex = SDL_CreateTexture(ren, ctx.pixfmt, SDL_TEXTUREACCESS_STREAMING, pw, ph);
  if (ctx.tex != NULL) SDL_SetTextureBlendMode(ctx.tex, SDL_BLENDMODE_NONE);
  present_frame(ctx.ren, ctx.tex, ctx.pixels, ctx.pw, ctx.ph, ctx.rowBytes);

  // Register the live-resize filter so a drag keeps rendering (see WinCtx).
  SDL_AddEventWatch(live_resize_watch, &ctx);

  // Event loop: forward left-button mouse input to the AS3 side, redraw after
  // any handled event, and quit on window close (SDL_QUIT). The per-frame size
  // poll below is a fallback; live_resize_watch handles the macOS drag case
  // where SDL_PollEvent blocks until the mouse is released.

  int running = 1;
  int fatal = 0;
  SDL_Event e;
  // Frame-pacing deadline. See the comment at the loop tail: we sleep *to* a
  // rolling deadline rather than *for* a fixed delay, so the rasterize+present
  // time is absorbed and the loop sustains the full requested frameRate instead
  // of falling short of it (a 120 Hz target otherwise lands around 80).
  double next_tick = (double)SDL_GetTicks();
  while (running && !fatal) {
    int dirty = 0;
    // Poll the size every frame as a fallback (the filter covers the drag case).
    int rres = do_resize(&ctx);
    if (rres < 0) { fatal = 1; break; }
    if (rres > 0) dirty = 1;
    while (SDL_PollEvent(&e)) {
      switch (e.type) {
        case SDL_QUIT:
          running = 0;
          break;
        case SDL_WINDOWEVENT:
          if (e.window.event == SDL_WINDOWEVENT_EXPOSED) {
            dirty = 1;
          }
          // SIZE_CHANGED/RESIZED are handled by live_resize_watch during pump.
          break;
        case SDL_MOUSEBUTTONDOWN:
          if (e.button.button == SDL_BUTTON_LEFT && on_mouse) {
            on_mouse((double)e.button.x, (double)e.button.y, "mouseDown");
            dirty = 1;
          }
          break;
        case SDL_MOUSEBUTTONUP:
          if (e.button.button == SDL_BUTTON_LEFT && on_mouse) {
            on_mouse((double)e.button.x, (double)e.button.y, "mouseUp");
            on_mouse((double)e.button.x, (double)e.button.y, "click");
            dirty = 1;
          }
          break;
        case SDL_MOUSEWHEEL: {
          // SDL_MOUSEWHEEL carries no position, so sample the cursor like AIR
          // does (the wheel event targets whatever sits under the pointer).
          // e.wheel.y is positive when scrolling up, matching MouseEvent.delta.
          if (on_wheel) {
            int mx = 0, my = 0;
            SDL_GetMouseState(&mx, &my);
            on_wheel((double)mx, (double)my, (double)e.wheel.y);
            dirty = 1;
          }
          break;
        }
        default:
          break;
      }
    }
    // Advance the frame clock every iteration so ENTER_FRAME listeners (FPS
    // meters, animations) run even when there is no input event. Each tick marks
    // the frame dirty so the (possibly mutated) tree is re-rendered and presented.
    if (on_frame) {
      on_frame();
      dirty = 1;
    }
    if (dirty && on_redraw) {
      on_redraw();  // AS3 re-rasterizes the tree into the same surface
      present_frame(ctx.ren, ctx.tex, ctx.pixels, ctx.pw, ctx.ph, ctx.rowBytes);
    }
    // Honor Stage.frameRate via a rolling deadline. on_frame_delay returns the
    // target interval in ms (1000/frameRate); 0 means "run as fast as possible"
    // (a busy loop, like AIR at a very high frameRate). Sleeping *to* the next
    // deadline (rather than a fixed delay after each frame) absorbs the
    // rasterize+present cost, so the loop actually sustains the requested rate —
    // the old fixed-delay form added render time on top and capped a 120 Hz
    // target around 80 fps.
    double interval = on_frame_delay ? on_frame_delay() : 16.0;
    double now = (double)SDL_GetTicks();
    if (interval > 0.0) {
      if (now < next_tick) {
        SDL_Delay((Uint32)(next_tick - now));
        now = (double)SDL_GetTicks();
      }
      next_tick += interval;
      // Catch-up guard: if a frame overshot the deadline (rendering slower than
      // the target rate), snap the deadline forward so we don't keep sleeping
      // into an ever-deeper deficit.
      if (next_tick < now) next_tick = now;
    } else {
      next_tick = now;
    }
  }

  SDL_DelEventWatch(live_resize_watch, &ctx);
  SDL_DestroyTexture(ctx.tex);
  SDL_DestroyRenderer(ren);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 1;
}

}  // extern "C"
