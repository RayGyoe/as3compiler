// gl_glue.cc — the WGL (desktop OpenGL) counterpart of d3d_glue.cc and
// metal_glue.mm: the C bridge to Skia's Ganesh GL backend for a Windows window.
//
// This is the third native window-GPU backend. It satisfies exactly the same
// five-function seam as the other two (sk_gpu_init / sk_gpu_destroy /
// sk_gpu_begin_frame / sk_gpu_flush / sk_gpu_draw_texture, keyed by the window id
// window_glue.cc assigned), so neither the generated C nor window_glue.cc learns
// that OpenGL exists: the only per-backend line in window_glue.cc is the attach
// step, and the render loop is shared.
//
// WHY THIS EXISTS AT ALL. d3d_glue.cc targets D3D12, whose API floor is Windows 10
// 1507 + WDDM 2.0 + feature level 11_0: it cannot run on Windows 7/8.x at all.
// OpenGL 2.1+ ships with every Windows since XP (opengl32.dll in the OS), so a GL
// window backend is the only path to hardware compositing on the older systems
// without vendoring a translation layer. It is NOT a performance play: on modern
// Windows the D3D12 path keeps the flip-model presentation advantage (see the
// presentation note in sk_gpu_flush below).
//
// SKIA COST. Zero rebuild. vendor/provision/windows.ps1 turns off metal/vulkan/
// direct3d-allocator but never touches `skia_use_gl`, which defaults to true
// (gn/skia.gni: `skia_use_gl = !is_fuchsia`), so the shipped skia.lib already
// carries the whole Ganesh GL backend (GrGLGpu, GrGLCaps, GrDirectContexts::MakeGL
// and GrGLMakeNativeInterface are all exported from windows-x64/skia.lib).
//
// Spec references (AGENTS.md §2.4 requires the authority, not a guess):
//   * pixel format / context creation / swap interval:
//     build-tools/skia-src/tools/gpu/gl/win/SkWGL_win.cpp (SkCreateWGLContext)
//   * render target wrapping, origin and color type (the exact four lines this
//     file's gl_build_surface mirrors):
//     build-tools/skia-src/tools/window/GLWindowContext.cpp
//   * compatibility-profile preference for a plain (non-RenderDoc) run:
//     build-tools/skia-src/tools/window/win/GLWindowContext_win.cpp
//
// STATUS: built and run on Windows 11 26200 (see the smoke run recorded next to
// this file's test target). Not yet exercised on Windows 7/8.x — the API surface
// used here is Vista-era (WGL 1.1 + WGL_EXT_swap_control, both optional), but
// "compiles against old headers" is not evidence of "runs on an old machine".

#define SK_GANESH

// windows.h must precede GL/gl.h (which needs WINGDIAPI/APIENTRY from it) and must
// not inject the min/max macros, for the same reason d3d_glue.cc says so: they are
// function-like macros over the whole translation unit and would break Skia's own
// std::min/std::max.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <GL/gl.h>

#include "include/core/SkSurface.h"
#include "include/core/SkCanvas.h"
// GrBackendRenderTarget carries a sk_sp<SkColorSpace>, so SkColorSpace must be a
// complete type where the surface is wrapped.
#include "include/core/SkColorSpace.h"
#include "include/core/SkImage.h"
#include "include/core/SkPaint.h"
#include "include/gpu/GrTypes.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/gl/GrGLTypes.h"
#include "include/gpu/gl/GrGLInterface.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
#include "include/gpu/ganesh/SkImageGanesh.h"
// The GL factory namespaces. Unlike Metal and Direct3D — whose factories hang off
// GrDirectContext/GrBackendSurface directly (MakeMetal/MakeDirect3D) — the GL ones
// live in the backend-scoped public headers, exactly as skia_glue.cc's emscripten
// block includes them: GrDirectContexts::MakeGL in the first, GrBackendRenderTargets
// and GrBackendTextures in the second.
#include "include/gpu/ganesh/gl/GrGLDirectContext.h"
#include "include/gpu/ganesh/gl/GrGLBackendSurface.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>

// The default framebuffer's internal format. Windows' GL/gl.h is the 1.1 header
// and stops before GL_RGBA8 (that constant is GL 1.2), so it is spelled out here
// exactly as Skia's own GR_GL_RGBA8 macro expands it.
#define SK_GL_RGBA8 0x8058

// Window slots. MUST match ASC_MAX_WINDOWS in the generated C, SK_MAX_WINDOWS in
// window_glue.cc and SK_MTL_MAX_WINDOWS / SK_D3D_MAX_WINDOWS in the other two
// backends: an id is an index into all of those tables.
#define SK_GL_MAX_WINDOWS 16

// Unlike the other two backends there is ONE GrDirectContext PER WINDOW here, not
// one per process: Skia requires a GrDirectContext per GL context, and each window
// must own its own GL context because the render target is that window's default
// framebuffer (a context is bound to one DC at a time). The consequences run
// through the whole file: every entry point makes its window's context current
// before touching Skia, and there is no shared state to tear down with the last
// window.
typedef struct {
  int used;
  HWND hwnd;
  // Held for the window's lifetime rather than re-fetched per SwapBuffers (which
  // is what Skia's reference does): SetPixelFormat is a one-shot per window, and
  // keeping the same DC makes the wglMakeCurrent/SwapBuffers pair unambiguous.
  HDC hdc;
  HGLRC hglrc;
  sk_sp<GrDirectContext> ctx;
  // Wraps FBO 0 at the current physical size. Dropped and rebuilt when the window
  // is resized (the framebuffer itself follows the window on its own).
  sk_sp<SkSurface> surface;
  int width, height;
  int stencil_bits;
} GLWin;

static GLWin g_gl[SK_GL_MAX_WINDOWS];
static long g_gl_frames = 0;
static double g_gl_t_first = 0.0;

// ASC_GPU_STATS: how much CPU the frame costs, with the blocking present removed
// from the measurement. sk_stats above times whole frame intervals, which under
// vsync reads 16.7 ms on every backend and therefore cannot compare backends at
// all. This accumulator times only "record the frame and hand it to the driver":
// from the end of sk_gpu_begin_frame (after any acquire wait) to just before
// SwapBuffers. It is CPU submit cost, NOT GPU time -- Ganesh's submit is async, so
// a GPU-bound frame still reads low here. Kept identical in d3d_glue.cc so the two
// backends produce comparable numbers.
static double gl_now_ms(void);  // defined below; the probe needs it here
static int g_gl_stats_on = -1;
static double g_gl_work_t0 = 0.0;
static double g_gl_work_sum = 0.0;
static double g_gl_work_max = 0.0;
static long g_gl_work_n = 0;

// One line per 120 samples: enough to average out noise in a few seconds, few
// enough to read by eye.
static void gl_stats_frame_done(void) {
  if (g_gl_stats_on <= 0) return;
  const double dt = gl_now_ms() - g_gl_work_t0;
  g_gl_work_sum += dt;
  if (dt > g_gl_work_max) g_gl_work_max = dt;
  g_gl_work_n++;
  if (g_gl_work_n % 120 == 0) {
    fprintf(stderr, "gpu_stats frames=%ld work_avg=%.3f work_max=%.3f ms\n",
            g_gl_work_n, g_gl_work_sum / (double)g_gl_work_n, g_gl_work_max);
    fflush(stderr);
  }
}

static GLWin* gl_slot(int win_id) {
  if (win_id < 0 || win_id >= SK_GL_MAX_WINDOWS) return nullptr;
  return g_gl[win_id].used ? &g_gl[win_id] : nullptr;
}

// Progress trace for the init sequence, same switch and same reason as
// d3d_glue.cc's gpu_trace: a hang before the event loop prints nothing at all.
static void gpu_trace(const char* what) {
  if (getenv("ASC_GPU_TRACE") == nullptr) return;
  fprintf(stderr, "gl_glue: trace %s\n", what);
  fflush(stderr);
}

static double gl_now_ms(void) {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

// Make this window's GL context current. Every entry point starts here: Skia's GL
// backend issues its calls into whatever context is current, so a missing
// wglMakeCurrent does not fail loudly — it draws into another window (or nowhere),
// which is exactly the kind of silent wrong result AGENTS.md §2.5 forbids.
static int gl_make_current(GLWin* w) {
  if (w->hglrc == NULL || w->hdc == NULL) return 0;
  if (wglGetCurrentContext() == w->hglrc) return 1;
  if (!wglMakeCurrent(w->hdc, w->hglrc)) {
    fprintf(stderr, "gl_glue: wglMakeCurrent failed (GetLastError %lu)\n",
            (unsigned long)GetLastError());
    fflush(stderr);
    return 0;
  }
  return 1;
}

// Ask the driver for vsync. Optional in both directions: WGL_EXT_swap_control is
// not in WGL 1.1, so a driver without it leaves the interval at its default and
// the frame rate is whatever SwapBuffers does — reported once rather than
// silently assumed.
static void gl_set_swap_interval(int interval) {
  typedef const char* (WINAPI *PFN_wglGetExtensionsStringEXT)(void);
  typedef BOOL (WINAPI *PFN_wglSwapIntervalEXT)(int);
  PFN_wglGetExtensionsStringEXT get_ext =
      (PFN_wglGetExtensionsStringEXT)wglGetProcAddress("wglGetExtensionsStringEXT");
  if (get_ext == NULL) {
    fprintf(stderr, "gl_glue: WGL_EXT_swap_control unavailable (no extension "
                    "string query); vsync is the driver default\n");
    return;
  }
  const char* exts = get_ext();
  if (exts == NULL || strstr(exts, "WGL_EXT_swap_control") == NULL) {
    fprintf(stderr, "gl_glue: WGL_EXT_swap_control not advertised; vsync is the "
                    "driver default\n");
    return;
  }
  PFN_wglSwapIntervalEXT set_interval =
      (PFN_wglSwapIntervalEXT)wglGetProcAddress("wglSwapIntervalEXT");
  if (set_interval == NULL || !set_interval(interval)) {
    fprintf(stderr, "gl_glue: wglSwapIntervalEXT(%d) failed\n", interval);
  }
}

// Wrap the window's default framebuffer as an SkSurface.
//
// The four arguments after the context are Skia's own Windows recipe
// (tools/window/GLWindowContext.cpp): FBO 0, GL_RGBA8, kBottomLeft_GrSurfaceOrigin,
// kRGBA_8888_SkColorType. The origin is the one that matters and the one that is
// easy to get wrong — a window framebuffer's row 0 is the BOTTOM row of the screen,
// so kTopLeft here would render the frame upside down. (The emscripten WebGL path
// in skia_glue.cc uses kBottomLeft for FBO 0 for the same reason and kTopLeft for
// the Stage3D texture, which it wraps by hand.)
static int gl_build_surface(GLWin* w) {
  w->surface.reset();
  if (w->width <= 0 || w->height <= 0) return 0;

  GrGLFramebufferInfo fbInfo;
  fbInfo.fFBOID = 0;
  fbInfo.fFormat = SK_GL_RGBA8;
  // sampleCount 0 = "not multisampled" (Skia reads 0 as 1 for a single-sample
  // target); stencilBits is what DescribePixelFormat reported for the format we
  // actually got, not what we asked for.
  auto rt = GrBackendRenderTargets::MakeGL(w->width, w->height, 0, w->stencil_bits,
                                           fbInfo);
  if (!rt.isValid()) {
    fprintf(stderr, "gl_glue: MakeGL render target invalid for %dx%d\n",
            w->width, w->height);
    fflush(stderr);
    return 0;
  }
  w->surface = SkSurfaces::WrapBackendRenderTarget(w->ctx.get(), rt,
                                                   kBottomLeft_GrSurfaceOrigin,
                                                   kRGBA_8888_SkColorType,
                                                   nullptr, nullptr);
  if (w->surface == nullptr) {
    fprintf(stderr, "gl_glue: WrapBackendRenderTarget failed for %dx%d\n",
            w->width, w->height);
    fflush(stderr);
    return 0;
  }
  return 1;
}

// --- the seam the generated C calls ---------------------------------------

extern "C" {

// Bind a window's HWND to a fresh GL context and GrDirectContext. `native_handle`
// is the HWND (window_glue.cc fetched it from SDL). Returns 1 on success; on
// failure the caller refuses the window rather than showing one nothing can draw
// into.
int sk_gpu_init(int win_id, void* native_handle) {
  HWND hwnd = (HWND)native_handle;
  if (hwnd == NULL || win_id < 0 || win_id >= SK_GL_MAX_WINDOWS) return 0;
  if (g_gl[win_id].used) return 0;

  GLWin* w = &g_gl[win_id];
  w->hwnd = hwnd;

  w->hdc = GetDC(hwnd);
  if (w->hdc == NULL) {
    fprintf(stderr, "gl_glue: GetDC failed\n");
    return 0;
  }

  // Pixel format: a double-buffered, window-drawn, hardware-accelerated 32-bit
  // RGBA format with a stencil buffer.
  //
  // Deliberately the LEGACY ChoosePixelFormat path rather than
  // wglChoosePixelFormatARB. The ARB query needs a current context to fetch its
  // entry point, which needs a throwaway window+context first (Skia's
  // SkWGL_win.cpp does that bootstrap); ChoosePixelFormat needs nothing but the
  // DC, and the format it returns here is the same one the ARB attribute list in
  // SkWGL_win.cpp asks for (DRAW_TO_WINDOW + SUPPORT_OPENGL + DOUBLE_BUFFER +
  // 24 color + 8 alpha + 8 stencil). Every Windows driver since NT4 answers it.
  //
  // Stencil is not cosmetic: Ganesh uses it for clip masks and for AA path
  // rendering, and Context3D masking depends on it too. A format without stencil
  // still works — GrGLCaps reads the real bit count and disables the stencil-based
  // paths — but the picture degrades, so it is requested and then REPORTED.
  PIXELFORMATDESCRIPTOR pfd;
  memset(&pfd, 0, sizeof pfd);
  pfd.nSize = sizeof pfd;
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 24;
  pfd.cAlphaBits = 8;
  pfd.cDepthBits = 0;     // Skia's window targets carry no depth; Stage3D's own
                          // render targets do, in its own framebuffer.
  pfd.cStencilBits = 8;
  pfd.iLayerType = PFD_MAIN_PLANE;

  int format = ChoosePixelFormat(w->hdc, &pfd);
  if (format == 0) {
    fprintf(stderr, "gl_glue: ChoosePixelFormat found no match (GetLastError %lu)\n",
            (unsigned long)GetLastError());
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }
  // SetPixelFormat can only succeed once per window: a second call with a
  // different format fails, which is why this file never re-runs init for an id.
  if (!SetPixelFormat(w->hdc, format, &pfd)) {
    fprintf(stderr, "gl_glue: SetPixelFormat(%d) failed (GetLastError %lu)\n",
            format, (unsigned long)GetLastError());
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }

  // The format we got is not necessarily the one asked for: DescribePixelFormat
  // is the only way to learn the real stencil/alpha bit counts, and Skia needs the
  // stencil count to be the truth.
  PIXELFORMATDESCRIPTOR got;
  memset(&got, 0, sizeof got);
  w->stencil_bits = 0;
  if (DescribePixelFormat(w->hdc, format, sizeof got, &got) != 0) {
    w->stencil_bits = got.cStencilBits;
  }

  // Compatibility-profile context, deliberately.
  //
  // A legacy wglCreateContext returns the driver's highest-version context in the
  // COMPATIBILITY profile, which is exactly what Skia's own Windows reference asks
  // for on a normal run (kGLPreferCompatibilityProfile_SkWGLContextRequest in
  // GLWindowContext_win.cpp; it only switches to a core profile when RenderDoc is
  // attached). For this project the compatibility profile is not merely
  // acceptable, it is REQUIRED by a second client of the same context: the
  // AGAL→GLSL translator emits GLSL ES 1.00 (`attribute` / `varying` / `texture2D`,
  // no #version directive — see ASC_S3D_GLSL in src/runtime.ts), and a CORE
  // profile rejects all three. A compat context accepts them, so a future Windows
  // Stage3D-on-GL backend can share this context without touching the translator.
  w->hglrc = wglCreateContext(w->hdc);
  if (w->hglrc == NULL) {
    fprintf(stderr, "gl_glue: wglCreateContext failed (GetLastError %lu)\n",
            (unsigned long)GetLastError());
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }
  if (!wglMakeCurrent(w->hdc, w->hglrc)) {
    fprintf(stderr, "gl_glue: wglMakeCurrent failed after create (GetLastError %lu)\n",
            (unsigned long)GetLastError());
    wglDeleteContext(w->hglrc);
    w->hglrc = NULL;
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }
  gpu_trace("context");

  // Report the implementation once: the GL version is the single most useful line
  // when a driver turns out to be the problem, and on the Windows-7 class of
  // machine it is the difference between "Ganesh's fast paths" and "the floor".
  {
    const char* vendor = (const char*)glGetString(GL_VENDOR);
    const char* renderer = (const char*)glGetString(GL_RENDERER);
    const char* version = (const char*)glGetString(GL_VERSION);
    fprintf(stderr, "gl_glue: window %d on %s | %s | %s (stencil %d)\n", win_id,
            vendor != NULL ? vendor : "?", renderer != NULL ? renderer : "?",
            version != NULL ? version : "?", w->stencil_bits);
    fflush(stderr);
  }

  gl_set_swap_interval(1);

  // A GrDirectContext per GL context (Skia's rule), created while this context is
  // current: GrGLMakeNativeInterface queries the extensions of whatever context is
  // bound, so calling it with none bound yields an interface that reports nothing.
  auto iface = GrGLMakeNativeInterface();
  if (iface == nullptr) {
    fprintf(stderr, "gl_glue: GrGLMakeNativeInterface failed\n");
    wglMakeCurrent(NULL, NULL);
    wglDeleteContext(w->hglrc);
    w->hglrc = NULL;
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }
  w->ctx = GrDirectContexts::MakeGL(std::move(iface));
  gpu_trace("GrDirectContext");
  if (w->ctx == nullptr) {
    fprintf(stderr, "gl_glue: GrDirectContexts::MakeGL failed\n");
    wglMakeCurrent(NULL, NULL);
    wglDeleteContext(w->hglrc);
    w->hglrc = NULL;
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }

  RECT rc;
  GetClientRect(hwnd, &rc);
  w->width = (int)(rc.right - rc.left);
  w->height = (int)(rc.bottom - rc.top);
  if (w->width <= 0 || w->height <= 0) { w->width = 1; w->height = 1; }

  // Clear once before wrapping: a freshly created window framebuffer holds
  // uninitialised pixels, and a first frame that only partially covers it would
  // show them (the same reason Skia's reference clears here).
  glViewport(0, 0, w->width, w->height);
  glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
  glClearStencil(0);
  glStencilMask(0xffffffffu);
  glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);

  if (!gl_build_surface(w)) {
    wglMakeCurrent(NULL, NULL);
    w->ctx.reset();
    wglDeleteContext(w->hglrc);
    w->hglrc = NULL;
    ReleaseDC(hwnd, w->hdc);
    w->hdc = NULL;
    return 0;
  }
  gpu_trace("surface");

  w->used = 1;
  fprintf(stderr, "gl_glue: window %d bound to %dx%d WGL context\n",
          win_id, w->width, w->height);
  return 1;
}

// Release one window's GL context and Skia context. Order matters: the surface
// wraps FBO 0 of this context, so it goes first, then Ganesh's context (which
// flushes on destruction), then the GL context itself — and only after that is the
// DC released.
void sk_gpu_destroy(int win_id) {
  GLWin* w = gl_slot(win_id);
  if (w == nullptr) return;

  if (w->ctx != nullptr) {
    gl_make_current(w);
    // Submit whatever is queued before the context disappears; kYes is a CPU
    // sync, which is what "nothing is still in flight" requires here.
    w->ctx->flushAndSubmit(GrSyncCpu::kYes);
    w->surface.reset();
    w->ctx.reset();
  }
  if (wglGetCurrentContext() == w->hglrc) wglMakeCurrent(NULL, NULL);
  if (w->hglrc != NULL) wglDeleteContext(w->hglrc);
  if (w->hdc != NULL && w->hwnd != NULL) ReleaseDC(w->hwnd, w->hdc);
  w->hglrc = NULL;
  w->hdc = NULL;
  w->hwnd = NULL;
  w->width = w->height = 0;
  w->used = 0;
}

// Debug: write the just-drawn back buffer to a 24-bit BMP. The GL counterpart of
// d3d_glue.cc's d3d_dump_backbuffer, with the same env contract
// (ASC_GPU_DUMP / ASC_GPU_DUMP_AT) so the same probe scripts work on both
// backends and their output can be compared pixel for pixel.
//
// Two things differ from the D3D dump and both are easy to get wrong:
//   * glReadPixels returns rows BOTTOM-UP (GL's window origin is the bottom-left),
//     while the D3D readback and the BMP we write are TOP-DOWN — so the row loop
//     runs backwards.
//   * the read must happen after Ganesh's submit and before SwapBuffers, because
//     the back buffer is undefined once swapped.
static void gl_dump_backbuffer(GLWin* w) {
  const char* out = getenv("ASC_GPU_DUMP");
  if (out == nullptr || out[0] == '\0') return;
  static long n = 0;
  const char* atEnv = getenv("ASC_GPU_DUMP_AT");
  const long at = atEnv != nullptr ? atol(atEnv) : 30;
  static int done = 0;
  if (done || n++ < at) return;
  done = 1;

  const int width = w->width, height = w->height;
  if (width <= 0 || height <= 0) {
    fprintf(stderr, "ASC_GPU_DUMP: zero size\n");
    fflush(stderr);
    return;
  }
  const size_t row_bytes = (size_t)width * 4u;
  const unsigned char* px =
      (const unsigned char*)malloc(row_bytes * (size_t)height);
  if (px == NULL) {
    fprintf(stderr, "ASC_GPU_DUMP: out of memory\n");
    fflush(stderr);
    return;
  }
  // glPixelStorei: the default PACK_ALIGNMENT is 4, which row_bytes always is for
  // RGBA8 — set explicitly anyway so a future format change cannot silently skew
  // the rows.
  glPixelStorei(GL_PACK_ALIGNMENT, 4);
  glReadBuffer(GL_BACK);
  glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, (void*)px);
  // Drain the pipeline so the error (if any) belongs to the read above and not to
  // something later; a failed read would otherwise be written out as a black frame.
  GLenum err = glGetError();
  if (err != GL_NO_ERROR) {
    fprintf(stderr, "ASC_GPU_DUMP: glReadPixels error 0x%04x\n", (unsigned)err);
    fflush(stderr);
  }

  const unsigned int rowBytes = ((unsigned int)width * 3u + 3u) & ~3u;
  const unsigned int dataBytes = rowBytes * height;
  const unsigned int fileBytes = 54u + dataBytes;
  FILE* f = fopen(out, "wb");
  if (f == NULL) {
    fprintf(stderr, "gl_glue: ASC_GPU_DUMP: cannot open %s\n", out);
  } else {
    unsigned char hdr[54] = { 0 };
    hdr[0] = 'B'; hdr[1] = 'M';
    memcpy(hdr + 2, &fileBytes, 4);
    const unsigned int off = 54, hsz = 40;
    memcpy(hdr + 10, &off, 4);
    memcpy(hdr + 14, &hsz, 4);
    const int iw = width, ih = -height;   // negative height = top-down rows
    memcpy(hdr + 18, &iw, 4);
    memcpy(hdr + 22, &ih, 4);
    const unsigned short planes = 1, bpp = 24;
    memcpy(hdr + 26, &planes, 2);
    memcpy(hdr + 28, &bpp, 2);
    memcpy(hdr + 34, &dataBytes, 4);
    fwrite(hdr, 1, sizeof hdr, f);
    for (int y = height - 1; y >= 0; --y) {
      const unsigned char* row = px + (size_t)y * row_bytes;
      for (int x = 0; x < width; ++x) {
        // GL_RGBA in memory (R,G,B,A) -> BMP's B,G,R.
        const unsigned char bgr[3] = { row[x * 4 + 2], row[x * 4 + 1], row[x * 4 + 0] };
        fwrite(bgr, 1, 3, f);
      }
      const unsigned char pad[3] = { 0, 0, 0 };
      if (rowBytes > (unsigned int)width * 3u) {
        fwrite(pad, 1, rowBytes - (unsigned int)width * 3u, f);
      }
    }
    fclose(f);
    fprintf(stderr, "gl_glue: ASC_GPU_DUMP wrote %s (%dx%d)\n", out, width, height);
  }
  free((void*)px);
}

// Begin a frame: make this window's context current, follow a size change, and
// return the canvas to draw into. Returns NULL when the frame cannot start so the
// render loop skips it instead of drawing into a surface that no longer matches
// the window.
void* sk_gpu_begin_frame(int win_id, int width, int height) {
  GLWin* w = gl_slot(win_id);
  if (w == nullptr || w->ctx == nullptr) return nullptr;
  if (width <= 0 || height <= 0) return nullptr;
  if (!gl_make_current(w)) return nullptr;

  // A resize needs no allocation dance here, unlike D3D12's ResizeBuffers: the
  // default framebuffer follows the window by itself. Only the Skia wrapper has to
  // be rebuilt (it carries the size) and the viewport re-set.
  if (width != w->width || height != w->height) {
    // Drain first: the surface being dropped may still have work queued against it.
    w->ctx->flushAndSubmit(GrSyncCpu::kYes);
    w->width = width;
    w->height = height;
    glViewport(0, 0, width, height);
    if (!gl_build_surface(w)) return nullptr;
  }

  SkCanvas* canvas = w->surface != nullptr ? w->surface->getCanvas() : nullptr;
  if (canvas == nullptr) return nullptr;

  if (getenv("ASC_S3D_STATS") != NULL) {
    g_gl_frames++;
    const double now = gl_now_ms();
    if (g_gl_t_first == 0.0) g_gl_t_first = now;
    if (g_gl_frames % 600 == 0) {
      const double el = (now - g_gl_t_first) / 1000.0;
      fprintf(stderr, "sk_stats t=%.1fs frames=%ld fps=%.1f ms/frame=%.2f\n", el,
              g_gl_frames, el > 0.0 ? (double)g_gl_frames / el : 0.0,
              el > 0.0 ? 1000.0 * el / (double)g_gl_frames : 0.0);
      fflush(stderr);
    }
  }
  if (g_gl_stats_on < 0) g_gl_stats_on = getenv("ASC_GPU_STATS") != NULL ? 1 : 0;
  if (g_gl_stats_on > 0) g_gl_work_t0 = gl_now_ms();
  return (void*)canvas;
}

// Submit the frame and present it.
//
// flushAndSubmit, not flush: on the GL backend flush() only records the commands,
// and submit() is what issues the glFlush — exactly the lesson skia_glue.cc's
// web path already documents (a frame that never reaches the driver shows
// uninitialised slivers). SwapBuffers then swaps and, with WGL_EXT_swap_control(1)
// set at init, blocks until the next vblank.
//
// PRESENTATION NOTE (the one real cost of this backend against D3D12): a windowed
// SwapBuffers goes through the DWM blt-model composition path, while the D3D12
// backend's DXGI_SWAP_EFFECT_FLIP_DISCARD swapchain is the only model Windows 10+
// can promote to independent flip. Both are correct; the flip path can skip a
// composition copy and a frame of latency, which is why D3D12 stays the default
// backend on systems that support it.
void sk_gpu_flush(int win_id) {
  GLWin* w = gl_slot(win_id);
  if (w == nullptr || w->ctx == nullptr || w->surface == nullptr) return;
  if (!gl_make_current(w)) return;

  w->ctx->flushAndSubmit(GrSyncCpu::kNo);

  // Before the present call below, which blocks on vblank (see above).
  gl_stats_frame_done();

  gl_dump_backbuffer(w);

  if (!SwapBuffers(w->hdc)) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "gl_glue: SwapBuffers failed (GetLastError %lu)\n",
              (unsigned long)GetLastError());
      fflush(stderr);
    }
  }
}

// Composite an externally-owned GL texture onto the current canvas — the GL
// counterpart of d3d_glue.cc's sk_gpu_draw_texture and of sk_gl_draw_texture in
// skia_glue.cc's emscripten block.
//
// The texture id contract is the WebGL one: a GL_TEXTURE_2D name holding
// premultiplied RGBA8, with row 0 at the visual TOP (the Stage3D vertex program
// negates clip-space Y, see stage3d_webgl.cc's header), hence kTopLeft here where
// the window framebuffer uses kBottomLeft.
//
// NOTE: no Windows build produces such a texture yet. The only GL Stage3D backend
// in this tree is stage3d_webgl.cc, which is Emscripten-only; a Windows build with
// both ASC_RENDER_GL and ASC_RENDER_STAGE3D must be refused at build time rather
// than linked into a window that composites nothing (AGENTS.md §1.5) — see the
// guard in src/air-app.ts. This function exists so the seam is complete and so the
// eventual GL Stage3D backend has its composite path already written and tested
// against the emscripten one.
void sk_gpu_draw_texture(void* canvas, void* glTexture, int w, int h,
                         double dx, double dy, double dw, double dh) {
  if (canvas == nullptr || glTexture == nullptr) return;
  if (w <= 0 || h <= 0) return;
  // The caller's context must be current — it is, because sk_gpu_begin_frame made
  // it current for this frame and nothing else rebinds inside a frame.
  const unsigned int tex_id = (unsigned int)(uintptr_t)glTexture;

  GrGLTextureInfo glInfo;
  glInfo.fTarget = 0x0DE1;   // GL_TEXTURE_2D
  glInfo.fID = tex_id;
  glInfo.fFormat = SK_GL_RGBA8;  // must match the texture's internal format
  GrBackendTexture backendTex =
      GrBackendTextures::MakeGL(w, h, skgpu::Mipmapped::kNo, glInfo);
  if (!backendTex.isValid()) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "gl_glue: sk_gpu_draw_texture: invalid GL texture %u\n", tex_id);
      fflush(stderr);
    }
    return;
  }

  // Skia needs the GrDirectContext that owns the current GL context, and a raw
  // SkCanvas cannot be traced back to it, so the owner is found by asking which
  // slot's HGLRC is current. That is unambiguous: sk_gpu_begin_frame bound exactly
  // one of them for this frame and nothing rebinds inside a frame.
  GrDirectContext* ctx = nullptr;
  for (int i = 0; i < SK_GL_MAX_WINDOWS; ++i) {
    if (g_gl[i].used && wglGetCurrentContext() == g_gl[i].hglrc) {
      ctx = g_gl[i].ctx.get();
      break;
    }
  }
  if (ctx == nullptr) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "gl_glue: sk_gpu_draw_texture: no current GPU window context\n");
      fflush(stderr);
    }
    return;
  }

  sk_sp<SkImage> img = SkImages::BorrowTextureFrom(
      ctx, backendTex, kTopLeft_GrSurfaceOrigin, kRGBA_8888_SkColorType,
      kPremul_SkAlphaType, nullptr);
  if (img == nullptr) {
    static int warned = 0;
    if (!warned) {
      warned = 1;
      fprintf(stderr, "gl_glue: sk_gpu_draw_texture: BorrowTextureFrom failed\n");
      fflush(stderr);
    }
    return;
  }

  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  // kSrc and linear filtering, for the two reasons d3d_glue.cc records at length:
  // AIR composites the Stage3D back buffer with its alpha channel ignored (so
  // kSrcOver would let Starling's ERASE show the stage colour through), and the
  // destination is the render target's LOGICAL size against a DEVICE-sized source
  // under HiDPI, so nearest would alias.
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  ((SkCanvas*)canvas)->drawImageRect(img.get(), dst,
                                     SkSamplingOptions(SkFilterMode::kLinear,
                                                       SkMipmapMode::kNone),
                                     &paint);
}

}  // extern "C"