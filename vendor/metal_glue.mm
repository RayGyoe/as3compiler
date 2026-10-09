// metal_glue.mm — the Objective-C++ -> C bridge for the native Metal GPU backend.
//
// renderMode=direct/gpu on native composes each frame on the GPU through Skia's
// Ganesh Metal backend. A CAMetalDrawable is one-shot — it is acquired per frame
// from the CAMetalLayer via -nextDrawable, wrapped as a GrBackendRenderTarget,
// rendered into, then presented with presentDrawable + commit. Because the
// surface is rebuilt every frame, this backend is *not* the generic
// sk_surface_gpu_new (that stays web-only, wrapping a persistent WebGL2 FBO 0);
// it exposes a flat frame-scoped API: sk_mtl_init / sk_mtl_begin_frame /
// sk_mtl_flush / sk_mtl_destroy, all keyed by the window id window_glue.cc
// assigned. Only the window render path uses it — offscreen PNG export and
// cacheAsBitmap still rasterize on the CPU.
//
// EVERY window may be GPU-composed (the initial window and any NativeWindow):
// the layer + drawable + SkSurface are per window because a CAMetalDrawable is a
// one-shot resource of that window's own CAMetalLayer, while the MTLDevice /
// MTLCommandQueue / GrDirectContext underneath are process-wide and shared —
// they carry no per-window state, and one set per window would only multiply GPU
// memory.
//
// SK_METAL gates the Metal-specific constructors in GrBackendSurface.h (e.g.
// GrBackendRenderTarget(width, height, GrMtlTextureInfo)). Skia's own build sets
// this via `skia_use_metal = true`; a consumer of a prebuilt Metal-enabled
// libskia.a must define it here so those overloads are visible. SK_GANESH is
// also required: SkTypes.h #undefs SK_METAL unless a GPU backend (SK_GANESH /
// SK_GRAPHITE) is selected, so both must be defined before any Skia header.
#define SK_GANESH
#define SK_METAL

#include "include/core/SkSurface.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColorSpace.h"
#include "include/core/SkImage.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
#include "include/gpu/ganesh/SkImageGanesh.h"
#include "include/gpu/ganesh/mtl/GrMtlBackendContext.h"
#include "include/gpu/ganesh/mtl/GrMtlDirectContext.h"
#include "include/gpu/ganesh/mtl/GrMtlTypes.h"

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <CoreFoundation/CoreFoundation.h>

#include <cstdio>
#include <cstdlib>
#include <ctime>

// ARC is intentionally off for this file (matching Skia's own window tooling),
// so every ObjC object retained here is balanced by a manual release.
extern "C" {

// Frame counter for the ASC_S3D_STATS probe: bumped once per presented frame so
// the probe can report frame rate and ms/frame. stage3d_glue.mm prints its own
// draw-side line; the two rates (frames/s and draws/s) together give
// draws/frame and ms/frame for each bucket without a shared symbol.
static long asc_dbg_frames = 0;
static double asc_dbg_t_first = 0.0;
static double asc_dbg_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1.0e6;
}

// Window slots. MUST match SK_MAX_WINDOWS in window_glue.cc and ASC_MAX_WINDOWS
// in the generated C: an id is an index into all three tables.
#define SK_MTL_MAX_WINDOWS 16

// Per-window Metal state. `layer` is handed in by window_glue.cc (which got it
// from SDL_Metal_GetLayer); it is owned by that window's SDL_MetalView, so it is
// borrowed here and must be dropped before the view is destroyed. The drawable
// and the SkSurface wrapping it belong to the CURRENT frame and are released in
// sk_mtl_flush (or in sk_mtl_destroy if the window closed mid-frame).
typedef struct {
  int used;
  CAMetalLayer* layer;
  id<CAMetalDrawable> drawable;
  sk_sp<SkSurface> surface;
} MtlWin;

static MtlWin g_mtl[SK_MTL_MAX_WINDOWS];
// Process-wide backend: created with the first GPU window and torn down when the
// last one goes away. Skia requires these to outlive the context.
static id<MTLDevice> g_device = nil;
static id<MTLCommandQueue> g_queue = nil;
static sk_sp<GrDirectContext> g_context = nullptr;

// The one MTLCommandQueue every GPU producer in the process shares, created on
// first use and deliberately never released (process lifetime).
//
// Why it must be *shared*: a Stage3D window composites its offscreen render
// target by having Skia *read* a texture that Stage3D *writes* on the next frame
// (see ASC_window_render in the generated C: flush -> composite -> present).
// Metal only tracks resource hazards *within one queue*, so with Skia on its own
// queue and Stage3D on another the composite's read races the following frame's
// write. The write wins tile by tile, so the composite lands the previous frame's
// completed skybox plus the current frame's *half-written* torus pass: the ring
// comes out cut along a straight tile boundary, showing background where the band
// should be (measured on Basic_SkyBox: the ring was cut in ~11 of 25 consecutive
// frames; 0 of 150 once the queues were shared, and 0 of 25 when a CPU wait was
// forced instead -- that A/B is what pinned the race).
// One queue lets Metal order the composite's read before the next write with no
// CPU stall -- see stage3d_glue.mm's s3d_create, which adopts this queue.
static id<MTLCommandQueue> g_shared_queue = nil;

// Weak, because a headless Stage3D build links stage3d_glue.mm without
// metal_glue.mm (no window => no Ganesh => nothing to share with).
id<MTLCommandQueue> sk_mtl_shared_queue(void) {
  if (g_shared_queue == nil) {
    id<MTLDevice> d = MTLCreateSystemDefaultDevice();
    if (d != nil) g_shared_queue = [d newCommandQueue];
  }
  return g_shared_queue;
}

static MtlWin* mtl_slot(int win_id) {
  if (win_id < 0 || win_id >= SK_MTL_MAX_WINDOWS) return nullptr;
  return g_mtl[win_id].used ? &g_mtl[win_id] : nullptr;
}

// Build (once) the shared MTLDevice + MTLCommandQueue + GrDirectContext(Metal)
// and bind a window's CAMetalLayer to it. Returns 1 on success. Must be called
// after the window exists — Metal has no drawable to wrap until SDL has attached
// a CAMetalLayer to the window.
//
// The window parameter is named `win_id`, not `id`: inside an Objective-C++ file
// `id` is a TYPE keyword, and a parameter of that name shadows it — every later
// `id<CAMetalDrawable>` in the function then parses as a comparison instead.
int sk_mtl_init(int win_id, void* layer) {
  if (layer == NULL || win_id < 0 || win_id >= SK_MTL_MAX_WINDOWS) return 0;
  // One init per window: the glue frees the slot before a new window can reuse
  // the id, so a second init here would mean the two sides disagree about which
  // layer the id names — refuse rather than silently rebind.
  if (g_mtl[win_id].used) return 0;

  if (g_device == nil) {
    g_device = MTLCreateSystemDefaultDevice();
    if (g_device == nil) {
      fprintf(stderr, "metal_glue: MTLCreateSystemDefaultDevice failed\n");
      return 0;
    }
    g_queue = sk_mtl_shared_queue();
    if (g_queue == nil) {
      [g_device release];
      g_device = nil;
      return 0;
    }
    GrMtlBackendContext backendContext = {};
    backendContext.fDevice.retain((GrMTLHandle)g_device);
    backendContext.fQueue.retain((GrMTLHandle)g_queue);
    g_context = GrDirectContexts::MakeMetal(backendContext);
    if (g_context == nullptr) {
      fprintf(stderr, "metal_glue: GrDirectContexts::MakeMetal failed\n");
      [g_queue release];
      [g_device release];
      g_queue = nil;
      g_device = nil;
      return 0;
    }
  }

  // The CAMetalLayer must be told which device to draw with and which pixel
  // format to use. BGRA8Unorm matches Skia's kBGRA_8888_SkColorType, and the
  // layer's top-left gravity keeps drawable row 0 at the visual top, so Skia
  // renders with kTopLeft_GrSurfaceOrigin (no vertical flip).
  CAMetalLayer* l = (CAMetalLayer*)layer;
  l.device = g_device;
  l.pixelFormat = MTLPixelFormatBGRA8Unorm;
  // Tag the layer as sRGB: MTLPixelFormatBGRA8Unorm carries *encoded* values and
  // says nothing about their color space, so an untagged layer is interpreted as
  // display-native (over-saturated on a wide-gamut display). What Skia paints is
  // sRGB, so this is the layer's correct declaration. Note: the tag is NOT
  // observable through `screencapture` (identical pixel numbers with and without
  // it -- measured, Ed26 in ④-B), so its justification is semantic, not captured.
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (cs != NULL) { l.colorspace = cs; CGColorSpaceRelease(cs); }
  // Tag the layer as sRGB. MTLPixelFormatBGRA8Unorm carries *encoded* values and
  // says nothing about their color space, so without a tag the window server
  // treats the content as display-native and converts: a `beginFill(0x00FF00)`
  // read back from the framebuffer as 03FF00 (measured, Ed26 in ④-B) while the
  // AIR window on the same display reads back exactly. The value is what AS3
  // handed us, so the layer must claim sRGB -- the space AIR's own pipeline
  // assumes -- and let the compositor convert if the display is wider-gamut.
  fprintf(stderr, "metal_glue: window %d layer bounds=%gx%g contentsScale=%g\n", win_id,
          (double)l.bounds.size.width, (double)l.bounds.size.height,
          (double)l.contentsScale);

  g_mtl[win_id].used = 1;
  g_mtl[win_id].layer = l;
  g_mtl[win_id].drawable = nil;
  g_mtl[win_id].surface = nullptr;
  return 1;
}

// Release one window's Metal state. When it was the last GPU window, tear the
// shared backend down too: release the context first (it may hold refs on
// device/queue), then the queue and device.
void sk_mtl_destroy(int win_id) {
  MtlWin* m = mtl_slot(win_id);
  if (m != nullptr) {
    m->surface.reset();
    if (m->drawable) {
      CFRelease((CFTypeRef)m->drawable);
      m->drawable = nil;
    }
    m->layer = nil;
    m->used = 0;
  }
  for (int i = 0; i < SK_MTL_MAX_WINDOWS; i++) {
    if (g_mtl[i].used) return;
  }
  g_context.reset();
  // g_queue is the process-wide shared queue (sk_mtl_shared_queue): a live
  // Stage3D context may still be writing through it, so it is not ours to
  // release here -- only to drop the handle. g_device IS released, because a
  // later sk_mtl_init re-creates it -- and MTLCreateSystemDefaultDevice hands
  // back the same device object every time, so the queue outlives this window
  // and stays valid for that device.
  g_queue = nil;
  if (g_device) {
    [g_device release];
    g_device = nil;
  }
}

// Begin a frame: size the layer's drawable in physical pixels, acquire the next
// one-shot drawable, wrap its texture as a SkSurface, and return the surface's
// canvas (the caller renders into it, then calls sk_mtl_flush). Returns NULL
// when no drawable is available (window minimized/occluded). The previous
// frame's surface is dropped here — a Metal drawable cannot be re-wrapped.
void* sk_mtl_begin_frame(int win_id, int width, int height) {
  MtlWin* m = mtl_slot(win_id);
  if (m == nullptr || g_context == nullptr || m->layer == nil) return nullptr;
  if (width <= 0 || height <= 0) return nullptr;

  // nextDrawable returns an autoreleased (+0) CAMetalDrawable; with no pool in
  // the C++ loop that +0 reference would leak every frame. Wrap the frame in an
  // explicit @autoreleasepool (the CFRetain below keeps the drawable alive past
  // the pool for present in sk_mtl_flush).
  @autoreleasepool {

  // The drawable size is set from SDL's own physical-pixel query (see
  // window_glue.cc), so the surface always matches the backing store even across
  // a HiDPI change. nextDrawable respects this size on subsequent frames.
  m->layer.drawableSize = CGSizeMake((CGFloat)width, (CGFloat)height);

  if (m->surface) m->surface.reset();
  if (m->drawable) {
    CFRelease((CFTypeRef)m->drawable);
    m->drawable = nil;
  }

  id<CAMetalDrawable> drawable = [m->layer nextDrawable];
  if (drawable == nil) return nullptr;
  if (drawable.texture == nil) return nullptr;

  GrMtlTextureInfo fbInfo;
  fbInfo.fTexture.retain((GrMTLHandle)drawable.texture);

  GrBackendRenderTarget backendRT(width, height, fbInfo);
  m->surface = SkSurfaces::WrapBackendRenderTarget(
      g_context.get(), backendRT, kTopLeft_GrSurfaceOrigin,
      kBGRA_8888_SkColorType, nullptr, nullptr);
  if (m->surface == nullptr) return nullptr;

  // Retain the drawable so it survives until present (it would otherwise be
  // autoreleased at the end of the runloop turn). Released in sk_mtl_flush.
  m->drawable = (id<CAMetalDrawable>)CFRetain((CFTypeRef)drawable);
  if (getenv("ASC_S3D_STATS")) {
    asc_dbg_frames++;
    const double now = asc_dbg_now_ms();
    if (asc_dbg_t_first == 0.0) asc_dbg_t_first = now;
    if (asc_dbg_frames % 600 == 0) {
      const double el = (now - asc_dbg_t_first) / 1000.0;
      fprintf(stderr, "sk_stats t=%.1fs frames=%ld fps=%.1f ms/frame=%.2f\n", el,
              asc_dbg_frames, el > 0.0 ? (double)asc_dbg_frames / el : 0.0,
              el > 0.0 ? 1000.0 * el / (double)asc_dbg_frames : 0.0);
      fflush(stderr);
    }
  }
  return (void*)m->surface->getCanvas();
  }  // @autoreleasepool
}

// Submit all queued Ganesh work to the GPU and present the current drawable.
// Mirrors MetalWindowContext::onSwapBuffers, but with the crucial first step
// that flush() alone omits: Ganesh only *records* commands into a Metal command
// buffer on flush(); they are not sent to the GPU until submit(). Without the
// submit the drawable is presented still-uninitialized (solid magenta). So we
// flushAndSubmit, then hand the drawable to a command buffer for present+commit,
// then release it (the drawable is one-shot).
void sk_mtl_flush(int win_id) {
  MtlWin* m = mtl_slot(win_id);
  if (m == nullptr) return;
  // Skia's Ganesh Metal backend allocates autoreleased MTLCommandBuffer/encoder
  // objects inside flushAndSubmit, and the present command buffer below is also
  // autoreleased. The C++ SDL loop has no autorelease pool, so without an
  // explicit pool every frame leaks Metal command objects (the air-native slow
  // leak). Drain the whole frame here.
  @autoreleasepool {
  if (g_context && m->surface) {
    g_context->flushAndSubmit(m->surface.get(), GrSyncCpu::kNo);
  }
  // Debug-only readback of the layer's own drawable, before the compositor ever
  // sees it. ASC_MTL_READBACK=<x>,<y>[,<n>] prints n consecutive physical pixels
  // of row y starting at x. This is the ④-B probe that separates "our raster /
  // submission already shifted the color" from "the window server's color
  // management shifted it during capture" -- both look identical in a
  // `screencapture -l` snapshot.
  const char* rb = getenv("ASC_MTL_READBACK");
  if (rb != NULL && m->surface != nullptr) {
    int rx = 0, ry = 0, rn = 1;
    if (sscanf(rb, "%d,%d,%d", &rx, &ry, &rn) >= 2) {
      if (rn < 1) rn = 1;
      if (rn > 64) rn = 64;
      SkImageInfo rinfo = SkImageInfo::Make(rn, 1, kBGRA_8888_SkColorType,
                                           kPremul_SkAlphaType, nullptr);
      uint32_t buf[64];
      if (m->surface->readPixels(rinfo, buf, sizeof(uint32_t) * (size_t)rn, rx, ry)) {
        fprintf(stderr, "mtl_readback y=%d x=%d:", ry, rx);
        for (int i = 0; i < rn; i++) fprintf(stderr, " %08x", buf[i]);
        fprintf(stderr, "\n");
        fflush(stderr);
      } else {
        fprintf(stderr, "mtl_readback: readPixels failed\n");
      }
    }
  }
  if (m->drawable && g_queue) {
    id<MTLCommandBuffer> commandBuffer = [g_queue commandBuffer];
    [commandBuffer presentDrawable:m->drawable];
    [commandBuffer commit];
  }
  }
  if (m->drawable) {
    CFRelease((CFTypeRef)m->drawable);
    m->drawable = nil;
  }
  if (m->surface) m->surface.reset();
}

// Draw an externally-owned MTLTexture directly onto the current Metal canvas — a
// GPU→GPU composite with no CPU readback and no CPU→GPU upload. Used to composite
// the Stage3D offscreen render target behind the 2D display list. The texture is
// borrowed (Skia wraps, does not own); its contents are re-rendered in place every
// frame by the Stage3D context, so this samples the LIVE texture. Unlike the old
// readback + RasterFromPixmapCopy path, there is no per-frame CPU→GPU upload and
// therefore no per-frame blit command buffer — the shmup residual leak's root
// cause (AGXG14XFamilyCommandBuffer / BlitContext × 1/frame).
void sk_mtl_draw_texture(void* canvas, void* mtlTexture, int w, int h,
                         double dx, double dy, double dw, double dh) {
  if (canvas == nullptr || mtlTexture == nullptr || g_context == nullptr) return;
  if (w <= 0 || h <= 0) return;
  id<MTLTexture> tex = (id<MTLTexture>)mtlTexture;
  GrMtlTextureInfo info;
  info.fTexture.retain((GrMTLHandle)tex);
  GrBackendTexture backendTex(w, h, skgpu::Mipmapped::kNo, info);
  sk_sp<SkImage> img = SkImages::BorrowTextureFrom(
      g_context.get(), backendTex, kTopLeft_GrSurfaceOrigin,
      kBGRA_8888_SkColorType, kPremul_SkAlphaType, nullptr);
  if (!img) return;
  // Debug probe (ASC_S3D_TRACE=1): confirm the composite really happens and that
  // the source texture is not itself blank. Samples a few pixels straight off the
  // borrowed MTLTexture (shared storage, so getBytes is a memcpy).
  if (getenv("ASC_S3D_TRACE") != NULL) {
    static int n = 0;
    if (n++ < 4) {
      uint32_t px[2] = { 0, 0 };
      [tex getBytes:px bytesPerRow:8 fromRegion:MTLRegionMake2D(100, 100, 2, 1) mipmapLevel:0];
      uint32_t py[2] = { 0, 0 };
      [tex getBytes:py bytesPerRow:8 fromRegion:MTLRegionMake2D(w / 2, h / 2, 2, 1) mipmapLevel:0];
      fprintf(stderr, "mtl_draw_texture: tex=%p %dx%d img=%d px100,100=%08x,%08x pxmid=%08x,%08x\n",
              mtlTexture, w, h, img != nullptr, px[0], px[1], py[0], py[1]);
      fflush(stderr);
    }
  }
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect(img.get(), dst, SkSamplingOptions());
}

// ---------------------------------------------------------------------------
// The backend-neutral seam: this file is the Metal end of the sk_gpu_* five that
// src/runtime.ts externs under ASC_RENDER_WINGPU (d3d_glue.cc is the D3D12 end).
// The generated C and the runtime only ever name these five, so that ONE
// generated .c serves both backends; which backend it gets is decided in
// window_glue.cc's sk_attach_gpu, never here.
//
// These are not the init path: window_glue.cc's sk_attach_gpu calls sk_mtl_init
// directly (through sk_attach_metal), so the per-window CAMetalLayer is already
// bound before any frame runs. What the generated C actually reaches is the
// per-frame pair — ASC_window_render calls as_skia_gpu_begin_frame /
// as_skia_gpu_flush — plus sk_gpu_draw_texture on a Stage3D build. Those MUST
// resolve at LINK time even though a macOS window normally renders inside
// sk_window_show_metal's own loop in window_glue.cc: "not called at runtime" is
// not "not referenced".
//
// That distinction is not hypothetical. Until 2026-10-09 the five names were
// externed but implemented only on D3D12, so every macOS GPU build of an AIR app
// failed to link (`_sk_gpu_begin_frame`, `_sk_gpu_flush`, referenced from
// _ASC_window_render) while the examples suite stayed green — its air-native unit
// compiles the demo's .as files WITHOUT --air-app, so ASC_RENDER_WINGPU was never
// defined there and the whole GPU path was never compiled. Only
// `node src/index.ts --air-app examples/air-native/air-native-app.xml --target
// native` (the command in test/unit/platform.ts's seam nail) sees it.
int sk_gpu_init(int win_id, void* layer) { return sk_mtl_init(win_id, layer); }
void sk_gpu_destroy(int win_id) { sk_mtl_destroy(win_id); }
void* sk_gpu_begin_frame(int win_id, int width, int height) {
  return sk_mtl_begin_frame(win_id, width, height);
}
void sk_gpu_flush(int win_id) { sk_mtl_flush(win_id); }
void sk_gpu_draw_texture(void* canvas, void* mtlTexture, int w, int h,
                         double dx, double dy, double dw, double dh) {
  sk_mtl_draw_texture(canvas, mtlTexture, w, h, dx, dy, dw, dh);
}

}  // extern "C"
