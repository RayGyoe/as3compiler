// metal_glue.mm — the Objective-C++ -> C bridge for the native Metal GPU backend.
//
// renderMode=direct/gpu on native composes each frame on the GPU through Skia's
// Ganesh Metal backend. A CAMetalDrawable is one-shot — it is acquired per frame
// from the CAMetalLayer via -nextDrawable, wrapped as a GrBackendRenderTarget,
// rendered into, then presented with presentDrawable + commit. Because the
// surface is rebuilt every frame, this backend is *not* the generic
// sk_surface_gpu_new (that stays web-only, wrapping a persistent WebGL2 FBO 0);
// it exposes a flat frame-scoped API: sk_mtl_init / sk_mtl_begin_frame /
// sk_mtl_flush / sk_mtl_destroy. Only the window render path uses it — offscreen
// PNG export and cacheAsBitmap still rasterize on the CPU.
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

// ARC is intentionally off for this file (matching Skia's own window tooling),
// so every ObjC object retained here is balanced by a manual release.
extern "C" {

// Process-wide Metal state. The layer is handed in by window_glue.cc (which got
// it from SDL_Metal_GetLayer); it is owned by the SDL_MetalView and outlives the
// render loop. The device/queue are created once per window and kept alive for
// the GrDirectContext's whole lifetime (Skia requires backend objects to outlive
// the context).
static CAMetalLayer* g_layer = nil;
static id<MTLDevice> g_device = nil;
static id<MTLCommandQueue> g_queue = nil;
static sk_sp<GrDirectContext> g_context = nullptr;
// The current frame's one-shot drawable and its wrapped SkSurface. Both are
// released in sk_mtl_flush once the frame has been presented.
static id<CAMetalDrawable> g_drawable = nil;
static sk_sp<SkSurface> g_surface = nullptr;

// Build the MTLDevice + MTLCommandQueue + GrDirectContext(Metal) for a given
// CAMetalLayer (from SDL_Metal_GetLayer). Returns 1 on success. Must be called
// after the window exists — Metal has no surface to wrap until SDL has attached
// a CAMetalLayer to the window.
int sk_mtl_init(void* layer) {
  if (layer == NULL) return 0;
  g_layer = (CAMetalLayer*)layer;

  g_device = MTLCreateSystemDefaultDevice();
  if (g_device == nil) {
    fprintf(stderr, "metal_glue: MTLCreateSystemDefaultDevice failed\n");
    return 0;
  }
  g_queue = [g_device newCommandQueue];
  if (g_queue == nil) {
    [g_device release];
    g_device = nil;
    return 0;
  }

  // The CAMetalLayer must be told which device to draw with and which pixel
  // format to use. BGRA8Unorm matches Skia's kBGRA_8888_SkColorType, and the
  // layer's top-left gravity keeps drawable row 0 at the visual top, so Skia
  // renders with kTopLeft_GrSurfaceOrigin (no vertical flip).
  g_layer.device = g_device;
  g_layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  fprintf(stderr, "metal_glue: layer bounds=%gx%g contentsScale=%g\n",
          (double)g_layer.bounds.size.width, (double)g_layer.bounds.size.height,
          (double)g_layer.contentsScale);

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
  return 1;
}

// Shut down the Metal backend: release the context first (it may hold refs on
// device/queue), then the queue and device.
void sk_mtl_destroy(void) {
  if (g_surface) g_surface.reset();
  if (g_drawable) {
    CFRelease((CFTypeRef)g_drawable);
    g_drawable = nil;
  }
  g_context.reset();
  if (g_queue) {
    [g_queue release];
    g_queue = nil;
  }
  if (g_device) {
    [g_device release];
    g_device = nil;
  }
  g_layer = nil;
}

// Begin a frame: size the layer's drawable in physical pixels, acquire the next
// one-shot drawable, wrap its texture as a SkSurface, and return the surface's
// canvas (the caller renders into it, then calls sk_mtl_flush). Returns NULL
// when no drawable is available (window minimized/occluded). The previous
// frame's surface is dropped here — a Metal drawable cannot be re-wrapped.
void* sk_mtl_begin_frame(int width, int height) {
  if (g_context == nullptr || g_layer == nil) return nullptr;
  if (width <= 0 || height <= 0) return nullptr;

  // nextDrawable returns an autoreleased (+0) CAMetalDrawable; with no pool in
  // the C++ loop that +0 reference would leak every frame. Wrap the frame in an
  // explicit @autoreleasepool (the CFRetain below keeps the drawable alive past
  // the pool for present in sk_mtl_flush).
  @autoreleasepool {

  // The drawable size is set from SDL's own physical-pixel query (see
  // window_glue.cc), so the surface always matches the backing store even across
  // a HiDPI change. nextDrawable respects this size on subsequent frames.
  g_layer.drawableSize = CGSizeMake((CGFloat)width, (CGFloat)height);
  fprintf(stderr, "metal_glue: begin_frame w=%d h=%d layerScale=%g drawableSize=%gx%g\n",
          width, height, (double)g_layer.contentsScale,
          (double)g_layer.drawableSize.width, (double)g_layer.drawableSize.height);

  if (g_surface) g_surface.reset();
  if (g_drawable) {
    CFRelease((CFTypeRef)g_drawable);
    g_drawable = nil;
  }

  id<CAMetalDrawable> drawable = [g_layer nextDrawable];
  if (drawable == nil) return nullptr;
  if (drawable.texture == nil) return nullptr;
  fprintf(stderr, "metal_glue: drawable.texture=%lux%lu (requested %dx%d)\n",
          (unsigned long)drawable.texture.width, (unsigned long)drawable.texture.height,
          width, height);

  GrMtlTextureInfo fbInfo;
  fbInfo.fTexture.retain((GrMTLHandle)drawable.texture);

  GrBackendRenderTarget backendRT(width, height, fbInfo);
  g_surface = SkSurfaces::WrapBackendRenderTarget(
      g_context.get(), backendRT, kTopLeft_GrSurfaceOrigin,
      kBGRA_8888_SkColorType, nullptr, nullptr);
  if (g_surface == nullptr) return nullptr;

  // Retain the drawable so it survives until present (it would otherwise be
  // autoreleased at the end of the runloop turn). Released in sk_mtl_flush.
  g_drawable = (id<CAMetalDrawable>)CFRetain((CFTypeRef)drawable);
  return (void*)g_surface->getCanvas();
  }  // @autoreleasepool
}

// Submit all queued Ganesh work to the GPU and present the current drawable.
// Mirrors MetalWindowContext::onSwapBuffers, but with the crucial first step
// that flush() alone omits: Ganesh only *records* commands into a Metal command
// buffer on flush(); they are not sent to the GPU until submit(). Without the
// submit the drawable is presented still-uninitialized (solid magenta). So we
// flushAndSubmit, then hand the drawable to a command buffer for present+commit,
// then release it (the drawable is one-shot).
void sk_mtl_flush(void) {
  // Skia's Ganesh Metal backend allocates autoreleased MTLCommandBuffer/encoder
  // objects inside flushAndSubmit, and the present command buffer below is also
  // autoreleased. The C++ SDL loop has no autorelease pool, so without an
  // explicit pool every frame leaks Metal command objects (the air-native slow
  // leak). Drain the whole frame here.
  @autoreleasepool {
  if (g_context && g_surface) {
    g_context->flushAndSubmit(g_surface.get(), GrSyncCpu::kNo);
  }
  if (g_drawable && g_queue) {
    id<MTLCommandBuffer> commandBuffer = [g_queue commandBuffer];
    [commandBuffer presentDrawable:g_drawable];
    [commandBuffer commit];
  }
  }
  if (g_drawable) {
    CFRelease((CFTypeRef)g_drawable);
    g_drawable = nil;
  }
  if (g_surface) g_surface.reset();
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
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect(img.get(), dst, SkSamplingOptions());
}

}  // extern "C"
