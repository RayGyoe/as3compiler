// video_metal.mm — zero-copy seam for the VideoToolbox (macOS/iOS) decoder.
//
// The macOS counterpart of vendor/video_d3d.cc, and it exists for the same reason:
// hardware decode only pays off if the decoded picture never comes back through
// system memory. Measured on this host (§16.8.3's Windows numbers, reproduced for
// macOS in video.md §16.13): a 4K 10-bit frame costs 6.6 ms of CPU in the software
// path and 13+ ms as "hardware decode + readback", so the readback is what makes
// hardware lose. This file removes it.
//
// Where the copy used to be: FFmpeg's videotoolbox decoder writes each frame into a
// CVPixelBuffer whose backing store IS an IOSurface. CVMetalTextureCache wraps that
// IOSurface as an MTLTexture with no blit and no CPU touch, so the frame can go
// decoder -> MTLTexture -> SkImage exactly like the D3D12 path goes decoder ->
// D3D12 texture -> SkImage.
//
// Interface (declared by hand in video_glue.c, which must stay a C file that knows
// nothing about Skia, Metal or Objective-C):
//   sk_video_mtl_image(ctx, cvbuf, w, h, ten_bit, yuv_cs) -> SkImage* or NULL
//   sk_video_mtl_probe(ctx, w, h, ten_bit) -> 1 when zero-copy can work at all
//   sk_video_mtl_stats(&frames, &starved)
//   sk_video_mtl_forget()      -- no per-stream identity on this platform
//
// NULL from `image` is always a valid answer: it means "no zero-copy this frame",
// and video_glue.c falls back to the readback route rather than showing nothing.

// SK_GANESH/SK_METAL gate the Metal constructors in GrBackendSurface.h; Skia's own
// build sets them from `skia_use_metal = true`, and a consumer of the prebuilt
// libskia.a must define both before any Skia header (same preamble as metal_glue.mm).
#define SK_GANESH
#define SK_METAL

#include "include/core/SkColorSpace.h"
#include "include/core/SkImage.h"
#include "include/core/SkYUVAInfo.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/GrYUVABackendTextures.h"
#include "include/gpu/ganesh/SkImageGanesh.h"
#include "include/gpu/ganesh/mtl/GrMtlTypes.h"

#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreVideo/CVMetalTextureCache.h>

#include <cstdio>
#include <cstdlib>
#include <cstdint>

// The process-wide MTLDevice that Skia's Ganesh context (and every Stage3D window)
// runs on. Owned by metal_glue.mm; ASC_RENDER_METAL already implies that file is
// linked (window_glue.cc resolves sk_gpu_init there).
extern "C" void* sk_mtl_device_ptr(void);

// ARC is off, matching metal_glue.mm and Skia's own tooling: every CF/ObjC object
// held here is balanced by a manual release.
extern "C" {

// One CVMetalTextureCache per MTLDevice. The cache is what turns an IOSurface into
// an MTLTexture, and it caches by (pixel buffer properties); a cache built for one
// device cannot serve a texture used by another, so the identity is checked rather
// than assumed. g_cache_dev is a raw pointer and a device can be freed and a new one
// land at the same address, but both are process-lifetime here (metal_glue keeps the
// device alive until the last window closes, and the release path below drops the
// cache first).
static CVMetalTextureCacheRef g_cache = NULL;
static void* g_cache_dev = NULL;
static long long g_frames = 0;    // frames that really went zero-copy
static long long g_starved = 0;   // frames that had to fall back (slots/wrap refused)
// Skia refusing the YUVA wrap refuses it for the lifetime of the context, and each
// refusal can leave its own retain on the plane textures behind. So the answer is
// remembered: after one refusal every later frame takes the readback route without
// asking again, and a new cache (device change) clears it.
static int g_wrap_refused = 0;

// What Skia's release callback gets back: the two plane wrappers and the pixel
// buffer they came from. All three must outlive the SkImage, because the MTLTextures
// are views into the CVPixelBuffer's IOSurface -- releasing the buffer while a
// texture still points into it is a use-after-free that shows up as a corrupt frame,
// not a crash.
struct ZcToken {
  CVMetalTextureRef y;
  CVMetalTextureRef uv;
  CVPixelBufferRef pb;
};

static void zc_release(void* ctx) {
  ZcToken* t = (ZcToken*)ctx;
  if (t == NULL) return;
  if (t->y != NULL) CFRelease(t->y);
  if (t->uv != NULL) CFRelease(t->uv);
  if (t->pb != NULL) CFRelease(t->pb);
  free(t);
}

// Drop the cache and everything keyed to it. Called when the device changes and when
// a stream closes (sk_video_mtl_forget): a cache holds IOSurface-backed wrappers, and
// leaving it behind would keep the last frame's buffers alive after the stream is
// gone -- the same leak class the D3D path's zc_reset exists for.
static void zc_reset(void) {
  if (g_cache != NULL) { CFRelease(g_cache); g_cache = NULL; }
  g_cache_dev = NULL;
  g_wrap_refused = 0;
}

static CVMetalTextureCacheRef zc_cache(void* dev) {
  if (dev == NULL) return NULL;
  if (g_cache != NULL && g_cache_dev == dev) return g_cache;
  zc_reset();
  CFDictionaryRef empty = CFDictionaryCreate(kCFAllocatorDefault, NULL, NULL, 0,
                                            &kCFTypeDictionaryKeyCallBacks,
                                            &kCFTypeDictionaryValueCallBacks);
  CVReturn rc = CVMetalTextureCacheCreate(kCFAllocatorDefault, empty, (id<MTLDevice>)dev,
                                          NULL, &g_cache);
  if (empty != NULL) CFRelease(empty);
  if (rc != kCVReturnSuccess || g_cache == NULL) {
    g_cache = NULL;
    return NULL;
  }
  g_cache_dev = dev;
  return g_cache;
}

// The plane layout of a VideoToolbox output buffer, derived from the buffer itself
// rather than from the caller's `ten_bit` flag: 'x420' is 10-bit 4:2:0 with the
// samples in the HIGH ten bits of a 16-bit word (the same packing as P010, which is
// why R16Unorm samples it as a 0..1 value and the BT.2020 10-bit matrix applies
// unchanged), and 'x422' is the 4:2:2 variant ProRes uses. Anything else -- 4:4:4,
// full-range RGBA, an unexpected layout -- answers 0 and the caller reads the frame
// back instead of painting it wrong.
enum : int {
  kPlaneR8 = 1,
  kPlaneRG8,
  kPlaneR16,
  kPlaneRG16,
};

static int zc_plane_layout(OSType fmt, int* y_fmt, int* uv_fmt, int* sub_x, int* sub_y) {
  switch (fmt) {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:   // '420v'
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:    // '420f'
      *y_fmt = kPlaneR8; *uv_fmt = kPlaneRG8; *sub_x = 2; *sub_y = 2;
      return 1;
    case kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange:  // 'x420'
    case kCVPixelFormatType_420YpCbCr10BiPlanarFullRange:   // 'xf20'
      *y_fmt = kPlaneR16; *uv_fmt = kPlaneRG16; *sub_x = 2; *sub_y = 2;
      return 1;
    case kCVPixelFormatType_422YpCbCr10BiPlanarVideoRange:  // 'x422'
    case kCVPixelFormatType_422YpCbCr10BiPlanarFullRange:   // 'xf22'
      *y_fmt = kPlaneR16; *uv_fmt = kPlaneRG16; *sub_x = 2; *sub_y = 1;
      return 1;
    default:
      return 0;
  }
}

static MTLPixelFormat zc_mtl_fmt(int tag) {
  switch (tag) {
    case kPlaneR8: return MTLPixelFormatR8Unorm;
    case kPlaneRG8: return MTLPixelFormatRG8Unorm;
    case kPlaneR16: return MTLPixelFormatR16Unorm;
    case kPlaneRG16: return MTLPixelFormatRG16Unorm;
    default: return MTLPixelFormatInvalid;
  }
}

// Can this build do zero-copy at all? Asked once per stream at the first frame
// boundary, before the decoder commits to hardware (video.md §16.9.6), so that a
// machine where it cannot work keeps the 8-thread software decoder -- hardware plus
// a readback is measurably worse than software, not better.
extern "C" int sk_video_mtl_probe(void* ctx, int w, int h, int ten_bit) {
  (void)w; (void)h; (void)ten_bit;
  if (ctx == nullptr) return 0;
  void* dev = sk_mtl_device_ptr();
  if (dev == NULL) return 0;
  if (zc_cache(dev) == NULL) {
    static int once = 0;
    if (!once) {
      once = 1;
      fprintf(stderr, "video_metal: CVMetalTextureCacheCreate failed; video stays on the "
                      "CPU route\n");
      fflush(stderr);
    }
    return 0;
  }
  // R16Unorm/RG16Unorm have to be usable as *sampled* textures for the 10-bit path;
  // Apple GPUs have carried them since family Apple4/Mac2 and Metal reports no query
  // for it, so the first real frame is the test (and zc_plane_layout already refuses
  // layouts this file cannot describe).
  return 1;
}

// Called by video_glue.c for a frame whose format is AV_PIX_FMT_VIDEOTOOLBOX.
//   ctx      GrRecordingContext* (Skia, from the display list)
//   cvbuf    the frame's CVPixelBufferRef (AVFrame.data[3])
//   w, h     the picture size (frame->width/height), used for the YUVAInfo
//   ten_bit  1 for a 10-bit stream, 0 for 8-bit -- cross-checked against the buffer
//   yuv_cs   SkYUVColorSpace value (0..9), the frame's own matrix/range
// Returns an SkImage* the caller owns, or NULL.
extern "C" void* sk_video_mtl_image(void* ctx, void* cvbuf, int w, int h, int ten_bit,
                                    int yuv_cs) {
  if (ctx == nullptr || cvbuf == nullptr || w <= 0 || h <= 0) return NULL;
  if (g_wrap_refused) { g_starved++; return NULL; }
  CVPixelBufferRef pb = (CVPixelBufferRef)cvbuf;
  void* dev = sk_mtl_device_ptr();
  CVMetalTextureCacheRef cache = zc_cache(dev);
  if (cache == NULL) { g_starved++; return NULL; }

  int ytag = 0, uvtag = 0, sx = 2, sy = 2;
  const OSType fmt = CVPixelBufferGetPixelFormatType(pb);
  if (!zc_plane_layout(fmt, &ytag, &uvtag, &sx, &sy)) { g_starved++; return NULL; }
  // The plane geometry must be the picture geometry. VideoToolbox pads rows (handled
  // by bytesPerRow, which CVMetalTextureCache carries into the texture) but can also
  // hand back a buffer whose plane HEIGHT is aligned up; wrapping that as an w*h
  // YUVAInfo would stretch the picture, so it falls back instead of looking subtly
  // wrong.
  const size_t pw = CVPixelBufferGetWidthOfPlane(pb, 0);
  const size_t ph = CVPixelBufferGetHeightOfPlane(pb, 0);
  const size_t cw = CVPixelBufferGetWidthOfPlane(pb, 1);
  const size_t ch = CVPixelBufferGetHeightOfPlane(pb, 1);
  if ((int)pw != w || (int)ph != h || (int)cw != w / sx || (int)ch != h / sy) {
    static int once = 0;
    if (!once && getenv("AS_VIDEO_DEBUG") != NULL) {
      once = 1;
      fprintf(stderr, "[zc] plane geometry %zux%zu + %zux%zu does not match %dx%d\n", pw, ph,
              cw, ch, w, h);
      fflush(stderr);
    }
    g_starved++;
    return NULL;
  }

  @autoreleasepool {
    CVReturn rc = kCVReturnError;
    CVMetalTextureRef ytex = NULL, uvtex = NULL;
    rc = CVMetalTextureCacheCreateTextureFromImage(
        kCFAllocatorDefault, cache, pb, NULL, zc_mtl_fmt(ytag), pw, ph, 0, &ytex);
    if (rc != kCVReturnSuccess || ytex == NULL) { g_starved++; return NULL; }
    rc = CVMetalTextureCacheCreateTextureFromImage(
        kCFAllocatorDefault, cache, pb, NULL, zc_mtl_fmt(uvtag), cw, ch, 1, &uvtex);
    if (rc != kCVReturnSuccess || uvtex == NULL) { CFRelease(ytex); g_starved++; return NULL; }

    id<MTLTexture> ty = CVMetalTextureGetTexture(ytex);
    id<MTLTexture> tuv = CVMetalTextureGetTexture(uvtex);
    if (ty == nil || tuv == nil) {
      CFRelease(ytex);
      CFRelease(uvtex);
      g_starved++;
      return NULL;
    }

    ZcToken* token = (ZcToken*)calloc(1, sizeof(ZcToken));
    if (token == NULL) {
      CFRelease(ytex);
      CFRelease(uvtex);
      g_starved++;
      return NULL;
    }
    // The pixel buffer outlives both plane wrappers only because we hold it: the
    // MTLTextures are views into its IOSurface, and Skia's texture may be sampled
    // many frames later (the SkImage is kept in the display list).
    token->y = ytex;
    token->uv = uvtex;
    token->pb = (CVPixelBufferRef)CFRetain(pb);

    // One-shot packing report: 10-bit samples are documented as high-aligned, but
    // "documented" is not a measurement, and a 16x-too-dark picture is exactly what a
    // low-aligned buffer would look like. AS_VIDEO_DEBUG=1 prints the max Y value of
    // the first frame: > 1023 means the ten bits sit in the top of the word, <= 1023
    // would mean they do not and the plane format above is wrong.
    if (getenv("AS_VIDEO_DEBUG") != NULL && g_frames == 0 && ten_bit) {
      CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
      const uint16_t* base = (const uint16_t*)CVPixelBufferGetBaseAddressOfPlane(pb, 0);
      const size_t stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0) / 2;
      if (base != NULL) {
        uint16_t mx = 0;
        for (size_t r = 0; r < ph; r += 16) {
          const uint16_t* row = base + r * stride;
          for (size_t c = 0; c < pw; c += 16) if (row[c] > mx) mx = row[c];
        }
        fprintf(stderr, "[zc] ten-bit Y sample max=%u (fmt=%08x) -> %s\n", (unsigned)mx,
                (unsigned)fmt, mx > 1023 ? "high-aligned" : "low-aligned");
        fflush(stderr);
      }
      CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    }

    GrMtlTextureInfo yi;
    yi.fTexture.retain((GrMTLHandle)ty);
    GrMtlTextureInfo ui;
    ui.fTexture.retain((GrMTLHandle)tuv);
    GrBackendTexture planes[SkYUVAInfo::kMaxPlanes];
    planes[0] = GrBackendTexture((int)pw, (int)ph, skgpu::Mipmapped::kNo, yi);
    planes[1] = GrBackendTexture((int)cw, (int)ch, skgpu::Mipmapped::kNo, ui);

    const SkYUVAInfo::Subsampling ss =
        (sy == 1) ? SkYUVAInfo::Subsampling::k422 : SkYUVAInfo::Subsampling::k420;
    SkYUVAInfo info(SkISize::Make(w, h), SkYUVAInfo::PlaneConfig::kY_UV, ss,
                    (SkYUVColorSpace)(yuv_cs < 0 ? 1 : yuv_cs));
    GrYUVABackendTextures yuva(info, planes, kTopLeft_GrSurfaceOrigin);

    sk_sp<SkImage> img = SkImages::TextureFromYUVATextures(
        static_cast<GrRecordingContext*>(ctx), yuva, nullptr, zc_release, token);
    if (img == nullptr) {
      // Only the first frame is worth a line: a backend that refuses the wrap refuses
      // it every time, and this is a diagnostic, not a log.
      if (getenv("AS_VIDEO_DEBUG") != NULL && g_frames == 0) {
        fprintf(stderr, "[zc] TextureFromYUVATextures returned null\n");
        fflush(stderr);
      }
      g_wrap_refused = 1;
      g_starved++;
      // TextureFromYUVATextures calls the release proc on failure too (SkImageGanesh.h:
      // "If ReleaseProc is provided it is also called before return on failure"), so the
      // token and its pixel buffer are freed here, not leaked.
      return NULL;
    }
    g_frames++;
    return img.release();
  }
}

extern "C" void sk_video_mtl_stats(long long* frames, long long* starved) {
  if (frames != NULL) *frames = g_frames;
  if (starved != NULL) *starved = g_starved;
}

// Called when a stream closes. This platform has no per-stream device identity (the
// MTLDevice is process-wide), so the only state to drop is the texture cache itself:
// every SkImage of this stream is already destroyed by the time video_glue calls
// this, which means no plane wrapper is still in flight.
extern "C" void sk_video_mtl_forget(void* device) {
  (void)device;
  zc_reset();
}

}  // extern "C"