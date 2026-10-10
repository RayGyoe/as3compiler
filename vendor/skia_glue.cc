// skia_glue.cc — the C++ -> C bridge for the Skia raster backend.
//
// Skia is a C++20 library with no C API, and as-aot emits C. This file wraps the
// minimal Skia surface/canvas/paint/path/encode surface in flat extern "C"
// functions so the generated .c can drive rendering through as_skia_* helpers.
//
// Design (see docs/zh-cn/skia.md §3):
//   - every object crosses the boundary as an opaque pointer (void*);
//   - only POD arguments (int/double/const char*/pointers), no sk_sp/STL;
//   - lifetime is managed here (ref-count for SkSurface/SkImage, delete for
//     SkPaint/SkPath) via the matching sk_*_delete/release entry points.
//
// This is the minimal closed loop for stage 36: offscreen CPU raster -> PNG.

#include "include/core/SkSurface.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkStrokeRec.h"
#include "include/core/SkImage.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkData.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkSpan.h"
// Multi-stop gradients + bitmap-fill shaders (swc.md §9 E). SkGradientShader is the
// only extra include the rich-fill path needs; SkImageShader comes with SkImage.h.
#include "include/effects/SkGradientShader.h"
#include <map>
#include <string>
#include <cstring> // strcmp: the AS3 BlendMode name -> SkBlendMode table
// E1 (opt-in, native-only): the SVG rasterizer needs the stream adapter and the
// svg module. Both are guarded by ASC_USE_SVG -- see the forward declarations in
// the bitmap/image section for why this is an opt-in enhancement.
#ifdef ASC_USE_SVG
#include "include/core/SkStream.h"
#include "include/core/SkSize.h"
#include "modules/svg/include/SkSVGDOM.h"
#include "modules/svg/include/SkSVGSVG.h"
#endif
// Font backend is the one platform-coupled piece of the whole raster layer:
// native (macOS) enumerates installed system fonts via CoreText; the wasm/web
// sandbox has no system fonts to enumerate, so it injects TTF/OTF byte streams
// at runtime (fetched by the host) into a custom FreeType font manager. The two
// backends are mutually exclusive — Emscripten defines __EMSCRIPTEN__.
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/html5.h>
#include <vector>
#include "include/ports/SkFontMgr_data.h"
#include "include/ports/SkFontMgr_empty.h"
// Ganesh (GPU) backend — the WebGL2 rasterization path behind renderMode=gpu/direct.
// Native uses the macOS raster surface + SDL streaming texture (already hardware
// blitted via CVDisplayLink at the display refresh), so the GPU backend is
// web-only: it replaces SkSurfaces::Raster with a GrDirectContext-backed surface
// so Skia composes every frame on the GPU instead of the CPU (the fix for the
// ~60 fps CPU-raster ceiling).
#include "include/gpu/GrTypes.h"
#include "include/gpu/gl/GrGLTypes.h"
#include "include/gpu/gl/GrGLInterface.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
#include "include/gpu/ganesh/SkImageGanesh.h"
#include "include/gpu/ganesh/gl/GrGLMakeWebGLInterface.h"
#include "include/gpu/ganesh/gl/GrGLDirectContext.h"
#include "include/gpu/ganesh/gl/GrGLBackendSurface.h"
#else
#if defined(_WIN32)
// Windows font backend: GDI (Skia's default font manager on Windows). It
// enumerates the installed system font collection through gdi32 — an import lib
// already on the Windows link line for SDL2 — so it adds no dependency, unlike
// DirectWrite (dwrite.lib). The factory lives in SkTypeface_win.h, exposed under
// SK_BUILD_FOR_WIN (which SkFeatures.h derives from _WIN32); the mac_ct port
// below is CoreText-only and cannot compile for Windows.
#include "include/ports/SkTypeface_win.h"
#else
#include "include/ports/SkFontMgr_mac_ct.h"
#endif
#endif
#include "include/effects/SkGradientShader.h"
#include "include/effects/SkImageFilters.h"
#include "include/core/SkColorFilter.h"
#include "include/effects/SkColorMatrix.h"
#include "include/encode/SkPngEncoder.h"

// SkParagraph (modules/skparagraph) is the full text-layout engine used for
// TextField's real typesetting (shaping via HarfBuzz, UAX#14 line breaking,
// per-line metrics, alignment, letter/word spacing). It lives in a separate
// library (libskparagraph.a) from core Skia, hence the module includes below.
#include "modules/skparagraph/include/Paragraph.h"
#include "modules/skparagraph/include/ParagraphBuilder.h"
#include "modules/skparagraph/include/ParagraphStyle.h"
#include "modules/skparagraph/include/TextStyle.h"
#include "modules/skparagraph/include/FontCollection.h"
#include "include/core/SkString.h"
#include "include/core/SkFontStyle.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>

extern "C" {

// ---------- surface ----------

void* sk_surface_raster_new(int width, int height) {
  // m124 moved the factory off SkSurface into the SkSurfaces namespace.
  auto surface = SkSurfaces::Raster(
      SkImageInfo::MakeN32Premul(width, height));
  return surface.release();  // caller owns one ref
}

// ---------- GPU (Ganesh / WebGL2) surface — renderMode=gpu/direct ----------
//
// The GPU path replaces the CPU raster surface with a GrDirectContext-backed
// surface rendering into the WebGL2 default framebuffer (FBO 0). Skia then
// composes the whole frame on the GPU (glyph atlas, gradients, filters all
// become GPU textures/draws), removing the CPU-raster bottleneck that capped
// web at ~60 fps. The context is a process-wide singleton: Skia requires one
// GrDirectContext per GL context, and the canvas lives for the whole page.
#ifdef __EMSCRIPTEN__
static sk_sp<GrDirectContext> g_gr_context = nullptr;
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_gl_ctx = 0;

// Lazily create the WebGL2 context + GrDirectContext on first use. Called from
// sk_surface_gpu_new, which runs inside Stage_showWindow — by then the host has
// fetched/injected fonts and the #canvas element exists, so the GL context can
// be requested against it.
static int sk_gr_init(void) {
  if (g_gr_context != nullptr) return 1;
  EmscriptenWebGLContextAttributes attrs;
  emscripten_webgl_init_context_attributes(&attrs);
  attrs.majorVersion = 2;            // WebGL2 (Ganesh requires it for UNPACK_ROW_LENGTH etc.)
  attrs.alpha = EM_TRUE;             // premultiplied-alpha canvas backing Skia's kN32
  attrs.premultipliedAlpha = EM_TRUE;
  attrs.depth = EM_FALSE;
  attrs.stencil = EM_FALSE;          // Skia render target is FBO 0, no stencil needed
  attrs.antialias = EM_FALSE;        // Skia does its own AA in-shader
  attrs.preserveDrawingBuffer = EM_TRUE;  // keep the frame until the next present
  attrs.enableExtensionsByDefault = EM_TRUE;
  g_gl_ctx = emscripten_webgl_create_context("#canvas", &attrs);
  if (g_gl_ctx <= 0) return 0;
  emscripten_webgl_make_context_current(g_gl_ctx);

  auto iface = GrGLInterfaces::MakeWebGL();
  if (!iface) return 0;
  g_gr_context = GrDirectContexts::MakeGL(std::move(iface));
  return g_gr_context != nullptr ? 1 : 0;
}

void* sk_surface_gpu_new(int width, int height) {
  // Size the canvas backing store BEFORE requesting the WebGL2 context: the GL
  // drawing buffer is fixed to canvas.width/height at context creation and does
  // not follow later changes (the CSS box size is set separately in
  // sk_window_show). width/height here are the physical pixels (pw/ph).
  EM_ASM({ Module.canvas.width = $0; Module.canvas.height = $1; }, width, height);
  if (!sk_gr_init()) return nullptr;
  // Wrap the default framebuffer (FBO 0) as the render target: Skia draws
  // directly to the on-screen buffer, so present is just a flush — no CPU↔JS
  // pixel round-trip. GL_RGBA8 (0x8058) matches Skia's kN32_Premul color type.
  GrGLFramebufferInfo fbInfo;
  fbInfo.fFBOID = 0;
  fbInfo.fFormat = 0x8058;  // GL_RGBA8
  auto rt = GrBackendRenderTargets::MakeGL(width, height, 0 /*sampleCnt*/, 0 /*stencilBits*/, fbInfo);
  if (!rt.isValid()) return nullptr;
  // GL framebuffers are bottom-left origin (row 0 = screen bottom); Skia must
  // know this so its top-left canvas (0,0) maps to the framebuffer's top row.
  auto surface = SkSurfaces::WrapBackendRenderTarget(
      g_gr_context.get(), rt, kBottomLeft_GrSurfaceOrigin,
      kRGBA_8888_SkColorType, nullptr, nullptr);
  return surface.release();
}

// Submit all queued Ganesh work to the GL driver so the frame appears on the
// canvas. Called by the web backend's present_frame instead of the CPU blit.
// Mirrors the Metal backend's lesson: GrDirectContext::flush() only sends the
// commands to the driver and, on the GL backend, never calls glFlush — so the
// FBO 0 contents are not guaranteed to be presentable. flushAndSubmit() is
// flush + submit, which actually submits the work to the GPU (submit issues
// glFlush for GL), making the frame appear. Without it the canvas showed
// uninitialized magenta slivers and half-drawn, misplaced tiles.
void sk_gr_flush(void) {
  if (g_gr_context) g_gr_context->flushAndSubmit(GrSyncCpu::kNo);
}

// Mark Ganesh's cached GL state stale after external code (the Stage3D WebGL
// backend in stage3d_webgl.cc, which binds its own FBO/VAO/program on the shared
// WebGL2 context) has touched it. Skia caches "what is currently bound", so
// without this the next Ganesh op would draw with the wrong program/texture/attrib
// state. Setting the dirty bit is cheap — the state is re-established lazily on
// Ganesh's next operation, unlike flushAndSubmit which would force a submission.
void sk_gr_reset_context(void) {
  if (g_gr_context) g_gr_context->resetContext();
}

// Ganesh applies sampler state to the *texture object* it samples (GL keeps
// filter/wrap per texture, not per sampler object), so after Skia samples a
// texture that the Stage3D backend also binds, the backend's "this texture is
// already LINEAR/CLAMP" cache is stale. sk_gl_draw_texture therefore fires a
// hook so the Stage3D glue can drop that cache; stage3d_webgl.cc registers its
// invalidator from s3d_create. A callback (rather than a direct call) keeps
// skia_glue.cc from depending on the Stage3D glue, which is absent from
// non-Stage3D web builds (air-native).
static void (*g_gr_texture_dirty_hook)(void) = nullptr;

void sk_gr_set_texture_dirty_hook(void (*fn)(void)) {
  g_gr_texture_dirty_hook = fn;
}

// Draw an externally-owned GL texture directly onto the current Ganesh canvas —
// the GPU→GPU counterpart of sk_mtl_draw_texture, used to composite the Stage3D
// offscreen render target behind the 2D display list with no CPU readback and no
// CPU→GPU re-upload. The texture is borrowed (Skia wraps, does not own it) and
// Stage3D re-renders into it in place every frame, so this samples the LIVE
// texture rather than a snapshot.
//
// The render target is GL_TEXTURE_2D / GL_RGBA8 (what stage3d_webgl.cc
// allocates) and holds the image TOP-DOWN: the Stage3D vertex program negates
// clip-space Y, so row 0 of the render target is the visual top — the same
// layout as Metal's textures and as Skia's own canvas — hence
// kTopLeft_GrSurfaceOrigin. (FBO 0 is the opposite case: GL's row 0 is the
// bottom row there, which is why sk_surface_gpu_new wraps it kBottomLeft.)
void sk_gl_draw_texture(void* canvas, unsigned textureId, int w, int h,
                        double dx, double dy, double dw, double dh) {
  if (canvas == nullptr || textureId == 0 || g_gr_context == nullptr) return;
  if (w <= 0 || h <= 0) return;
  GrGLTextureInfo glInfo;
  glInfo.fTarget = 0x0DE1;  // GL_TEXTURE_2D
  glInfo.fID = textureId;
  glInfo.fFormat = 0x8058;  // GL_RGBA8 — must match the attached texture's internal format
  GrBackendTexture backendTex = GrBackendTextures::MakeGL(
      w, h, skgpu::Mipmapped::kNo, glInfo);
  if (!backendTex.isValid()) return;
  sk_sp<SkImage> img = SkImages::BorrowTextureFrom(
      g_gr_context.get(), backendTex, kTopLeft_GrSurfaceOrigin,
      kRGBA_8888_SkColorType, kPremul_SkAlphaType, nullptr);
  if (!img) return;
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect(img.get(), dst, SkSamplingOptions());
  // Ganesh may retune this texture's GL filter/wrap while executing the draw
  // above (during the next flushAndSubmit), which invalidates the Stage3D
  // backend's per-texture sampler cache — tell it to re-apply on next use.
  if (g_gr_texture_dirty_hook) g_gr_texture_dirty_hook();
}
#endif  // __EMSCRIPTEN__

void* sk_surface_canvas(void* surface) {
  return (void*)((SkSurface*)surface)->getCanvas();
}

// Peek the raster surface's pixel buffer so a window backend (SDL2) can blit it
// on screen without an intermediate PNG round-trip. Only CPU raster surfaces
// expose writable pixels; on any other backend this returns 0 and the caller
// falls back to offscreen-only behavior.
int sk_surface_peek_pixels(void* surface, void** pixels, int* rowBytes) {
  SkPixmap pm;
  if (!((SkSurface*)surface)->peekPixels(&pm)) return 0;
  *pixels = pm.writable_addr();
  *rowBytes = (int)pm.rowBytes();
  return 1;
}

void* sk_surface_make_snapshot(void* surface) {
  auto image = ((SkSurface*)surface)->makeImageSnapshot();
  return image.release();  // caller owns one ref
}

void sk_surface_delete(void* surface) {
  ((SkSurface*)surface)->unref();
}

// ---------- canvas ----------

void sk_canvas_clear(void* canvas, unsigned rgb) {
  SkColor c = SkColorSetRGB((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
  ((SkCanvas*)canvas)->clear(c);
}

// Clears to fully transparent — used by cacheAsBitmap's offscreen surface so the
// baked subtree keeps transparent padding (the surface may be GPU-backed, whose
// initial contents are undefined, unlike N32Premul raster which starts at 0).
void sk_canvas_clear_transparent(void* canvas) {
  ((SkCanvas*)canvas)->clear(SK_ColorTRANSPARENT);
}

void sk_canvas_save(void* canvas)   { ((SkCanvas*)canvas)->save(); }
void sk_canvas_restore(void* canvas){ ((SkCanvas*)canvas)->restore(); }
void sk_canvas_translate(void* canvas, double x, double y) {
  ((SkCanvas*)canvas)->translate((SkScalar)x, (SkScalar)y);
}
void sk_canvas_rotate(void* canvas, double degrees) {
  ((SkCanvas*)canvas)->rotate((SkScalar)degrees);
}
void sk_canvas_scale(void* canvas, double sx, double sy) {
  ((SkCanvas*)canvas)->scale((SkScalar)sx, (SkScalar)sy);
}

// Concat an AS3 Matrix [a b c d tx ty] onto the current canvas transform.
// AS3 maps x' = a*x + c*y + tx, y' = b*x + d*y + ty, which is Skia's
// row-major setAll(scaleX, skewX, transX, skewY, scaleY, transY, 0, 0, 1).
void sk_canvas_concat(void* canvas, double a, double b, double c, double d, double tx, double ty) {
  SkMatrix m;
  m.setAll((SkScalar)a, (SkScalar)c, (SkScalar)tx,
           (SkScalar)b, (SkScalar)d, (SkScalar)ty,
           0, 0, 1);
  ((SkCanvas*)canvas)->concat(m);
}

// Offscreen-only alpha/blend approximation: a saveLayerAlpha isolates the
// subtree so a partial DisplayObject.alpha multiplies the whole subtree (stage
// 37 acceptance). Full SkBlendMode plumbing is a later sub-stage.
void sk_canvas_save_layer_alpha(void* canvas, double alpha) {
  ((SkCanvas*)canvas)->saveLayerAlpha(nullptr, (uint8_t)(alpha * 255.0));
}

void sk_canvas_draw_rect(void* canvas, double x, double y, double w, double h, void* paint) {
  ((SkCanvas*)canvas)->drawRect(
      SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h),
      *(SkPaint*)paint);
}

void sk_canvas_draw_circle(void* canvas, double cx, double cy, double r, void* paint) {
  ((SkCanvas*)canvas)->drawCircle((SkScalar)cx, (SkScalar)cy, (SkScalar)r, *(SkPaint*)paint);
}

void sk_canvas_draw_path(void* canvas, void* path, void* paint) {
  ((SkCanvas*)canvas)->drawPath(*(SkPath*)path, *(SkPaint*)paint);
}

// Total canvas scale: device units per logical unit of the CURRENT transform
// (i.e. the product of every ancestor scale, the object's own scale and the
// render pass's device pixel ratio). A screen-space 1px line (TextField's
// border) is drawn in local coordinates, so its local thickness must be
// 1 / scale to stay one *pixel* wide no matter how the object is scaled --
// measured on adl 51.4.1: a bordered field keeps a 1px outline at scale 2,
// scaleX=2/scaleY=1 and scale 0.5 alike. Column norms so a rotated matrix
// reports the scale along each (rotated) axis rather than the raw matrix
// entries.
void sk_canvas_total_scale(void* canvas, double* sx, double* sy) {
  const SkMatrix& m = ((SkCanvas*)canvas)->getTotalMatrix();
  double a = (double)m.getScaleX(), b = (double)m.getSkewY();
  double c = (double)m.getSkewX(),  d = (double)m.getScaleY();
  *sx = sqrt(a * a + b * b);
  *sy = sqrt(c * c + d * d);
}

// Intersect the current clip with a rectangle — used by TextField to keep
// wrapped lines inside the field box when the text is scrolled (stage 44).
void sk_canvas_clip_rect(void* canvas, double x, double y, double w, double h) {
  ((SkCanvas*)canvas)->clipRect(
      SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h));
}

// Clip the canvas to an arbitrary path -- the clipDepth mask of a DefineSprite
// (swc.md §9 E-4). The path is already in the canvas' current space (the baker
// composed the mask matrix into the masked child's local pixels), so this is a
// plain intersect.
void sk_canvas_clip_path(void* canvas, void* path, int antialias) {
  ((SkCanvas*)canvas)->clipPath(*(const SkPath*)path, SkClipOp::kIntersect,
                                antialias != 0);
}

// ---------- paint ----------

void* sk_paint_new(void) { return (void*)new SkPaint(); }
void sk_paint_delete(void* paint) { delete (SkPaint*)paint; }

static SkColor sk_argb(unsigned rgb, double alpha) {
  uint8_t a = (uint8_t)(alpha * 255.0);
  return SkColorSetARGB(a, (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
}

void sk_paint_set_color(void* paint, unsigned rgb) {
  SkColor c = sk_argb(rgb, 1.0);
  // Keep the caller-set alpha (AS3 beginFill color defaults to fully opaque).
  c = SkColorSetA(c, ((SkPaint*)paint)->getAlpha());
  ((SkPaint*)paint)->setColor(c);
}

// Straight 8-bit ARGB from a packed word. `sk_paint_set_color` + `sk_paint_set_alpha`
// cannot express this exactly: alpha would have to round-trip through a double
// (128/255.0*255.0 = 127.999... -> 127), which no baked SWC fill may do.
void sk_paint_set_color_argb(void* paint, unsigned argb) {
  SkPaint* p = (SkPaint*)paint;
  p->setColor(SkColorSetARGB((argb >> 24) & 0xFF, (argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF));
  p->setAlpha((uint8_t)((argb >> 24) & 0xFF));
}

void sk_paint_set_alpha(void* paint, double alpha) {
  ((SkPaint*)paint)->setAlpha((uint8_t)(alpha * 255.0));
}

// ---------- AS3 BlendMode (DisplayObject.blendMode, incl. baked SWC placements) ----------
//
// AS3 names a mix mode with a string (flash.display.BlendMode). The renderer
// reaches this by putting the object's subtree into a saveLayer whose paint
// carries the mode: the layer is composited with the parent only once, with the
// requested operator, which is what AIR's per-object blend does.
//
// Returns 1 when the caller must open that layer, 0 when the object composites
// normally (nothing to isolate). "layer" is NOT a mix operator -- AS3 defines it
// as pure group isolation, so it returns 1 with plain kSrcOver: children are
// precomposited before they reach the parent, exactly like AIR's LAYER.
//
// The modes AIR defines but Skia has no operator for (subtract / invert / alpha /
// erase) return 0 rather than an approximation; the baker reports the ones it
// meets instead of silently rendering them as normal (docs/zh-cn/swc.md §9.2 F4).
int sk_paint_set_blend(void* paint, const char* name) {
  if (name == NULL) return 0;
  SkBlendMode m;
  if (strcmp(name, "layer") == 0) m = SkBlendMode::kSrcOver;
  else if (strcmp(name, "multiply") == 0) m = SkBlendMode::kMultiply;
  else if (strcmp(name, "screen") == 0) m = SkBlendMode::kScreen;
  else if (strcmp(name, "lighten") == 0) m = SkBlendMode::kLighten;
  else if (strcmp(name, "darken") == 0) m = SkBlendMode::kDarken;
  else if (strcmp(name, "difference") == 0) m = SkBlendMode::kDifference;
  else if (strcmp(name, "add") == 0) m = SkBlendMode::kPlus;
  else if (strcmp(name, "overlay") == 0) m = SkBlendMode::kOverlay;
  else if (strcmp(name, "hardlight") == 0) m = SkBlendMode::kHardLight;
  else return 0;
  ((SkPaint*)paint)->setBlendMode(m);
  return 1;
}

void sk_paint_set_fill(void* paint)   { ((SkPaint*)paint)->setStyle(SkPaint::kFill_Style); }
void sk_paint_set_stroke(void* paint) { ((SkPaint*)paint)->setStyle(SkPaint::kStroke_Style); }
void sk_paint_set_stroke_width(void* paint, double w) {
  ((SkPaint*)paint)->setStrokeWidth((SkScalar)w);
}
void sk_paint_set_antialias(void* paint, int on) {
  ((SkPaint*)paint)->setAntiAlias(on != 0);
}

// ---------- path ----------

void* sk_path_new(void) { return (void*)new SkPath(); }
void sk_path_delete(void* path) { delete (SkPath*)path; }
void sk_path_move_to(void* path, double x, double y) {
  ((SkPath*)path)->moveTo((SkScalar)x, (SkScalar)y);
}
void sk_path_line_to(void* path, double x, double y) {
  ((SkPath*)path)->lineTo((SkScalar)x, (SkScalar)y);
}
void sk_path_cubic_to(void* path, double c1x, double c1y, double c2x, double c2y, double x, double y) {
  ((SkPath*)path)->cubicTo((SkScalar)c1x, (SkScalar)c1y,
                           (SkScalar)c2x, (SkScalar)c2y,
                           (SkScalar)x, (SkScalar)y);
}
void sk_path_quad_to(void* path, double cx, double cy, double x, double y) {
  ((SkPath*)path)->quadTo((SkScalar)cx, (SkScalar)cy, (SkScalar)x, (SkScalar)y);
}
void sk_path_add_rect(void* path, double x, double y, double w, double h) {
  ((SkPath*)path)->addRect(SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h));
}
void sk_path_add_circle(void* path, double cx, double cy, double r) {
  ((SkPath*)path)->addCircle((SkScalar)cx, (SkScalar)cy, (SkScalar)r);
}
void sk_path_close(void* path) { ((SkPath*)path)->close(); }
// Append `src` transformed by the affine [a, b, c, d, tx, ty] (AS3 convention:
// x' = a*x + c*y + tx). Used to place a mask shape's outline into the masked
// child's local pixel space without duplicating the geometry.
void sk_path_add_transformed(void* dst, void* src, double a, double b, double c, double d, double tx, double ty) {
  ((SkPath*)dst)->addPath(*(const SkPath*)src,
                          SkMatrix::MakeAll((SkScalar)a, (SkScalar)c, (SkScalar)tx,
                                            (SkScalar)b, (SkScalar)d, (SkScalar)ty,
                                            0, 0, 1));
}

// Fill rule for Graphics fills: AIR paints (and therefore hit-tests) a fill as
// EVEN-ODD. Measured on adl 51.4.1 with the hit-test probe (temp/editprobe/Ed21
// §E): one beginFill followed by drawRect(0,0,40,40) and drawRect(10,10,20,20)
// -- two same-direction nested subpaths -- leaves the inner 20x20 area OUTSIDE
// the shape (shapeFlag=true misses it), which nonzero winding would fill. Two
// *separate* beginFill/endFill groups stay fully filled (§E2), matching the
// single-path model here only for non-overlapping subpaths (documented subset).
void sk_path_set_even_odd(void* path, int evenOdd) {
  ((SkPath*)path)->setFillType(evenOdd ? SkPathFillType::kEvenOdd : SkPathFillType::kWinding);
}

// Is the point inside the filled area? Uses the path's own fill type, so this is
// exactly the region the renderer paints.
int sk_path_contains(void* path, double x, double y) {
  return ((SkPath*)path)->contains((SkScalar)x, (SkScalar)y) ? 1 : 0;
}

// Is the point inside the STROKED band of the path? AIR's lineStyle defaults are
// round caps and round joints (`CapsStyle.ROUND`/`JointStyle.ROUND`), and the hit
// region is the painted band: measured with a 10px stroke-only line, a point 4.5px
// perpendicular from the centreline hits while 5.5px misses, and a point 2px past
// the endpoint still hits (round cap) -- temp/editprobe/Ed24 §7. getFillPath builds
// the same outline the stroke renderer would, so flattening, joins and caps all
// agree with what is drawn.
int sk_path_stroke_contains(void* path, double width, double x, double y) {
  SkPaint p;
  p.setStyle(SkPaint::kStroke_Style);
  p.setStrokeWidth((SkScalar)width);
  p.setStrokeCap(SkPaint::kRound_Cap);
  p.setStrokeJoin(SkPaint::kRound_Join);
  SkStrokeRec rec(p);
  rec.setStrokeParams(SkPaint::kRound_Cap, SkPaint::kRound_Join, 4.0f);
  SkPath dst;
  if (!rec.applyToPath(&dst, *(SkPath*)path)) return 0;
  return dst.contains((SkScalar)x, (SkScalar)y) ? 1 : 0;
}

// Bounding box of a path in its own coordinate space (already cached by Skia, so
// this is O(1)). Returns 0 when the path is empty so callers can fall back to an
// unbounded saveLayer instead of passing a degenerate rect.
int sk_path_get_bounds(void* path, double* l, double* t, double* r, double* b) {
  SkRect rc = ((SkPath*)path)->getBounds();
  if (rc.isEmpty()) return 0;
  *l = rc.left(); *t = rc.top(); *r = rc.right(); *b = rc.bottom();
  return 1;
}

// Content fingerprint: SkPath's generation ID changes on every mutation (moveTo/
// lineTo/drawRect/...), so it is an O(1) "has this Shape's geometry changed?"
// signal. The incremental-redraw pass (auto cacheAsBitmap) hashes this to decide
// when a static subtree has stopped changing and can be baked into a bitmap.
uint32_t sk_path_generation_id(void* path) {
  return ((SkPath*)path)->getGenerationID();
}

// ---------- gradient ----------

// Minimal two-stop linear gradient (SkGradientShader::MakeLinear). AS3
// beginGradientFill's full multi-stop colors/alphas/ratios arrays are a later
// sub-stage; the single color pair here still exercises the SkShader path.
void sk_paint_set_linear_gradient(void* paint,
                                  double x0, double y0, double x1, double y1,
                                  unsigned rgb0, double a0, unsigned rgb1, double a1) {
  SkPoint pts[2] = { SkPoint::Make((SkScalar)x0, (SkScalar)y0),
                     SkPoint::Make((SkScalar)x1, (SkScalar)y1) };
  SkColor colors[2] = { sk_argb(rgb0, a0), sk_argb(rgb1, a1) };
  SkScalar pos[2] = { 0.0f, 1.0f };
  auto shader = SkGradientShader::MakeLinear(pts, colors, pos, 2, SkTileMode::kClamp);
  ((SkPaint*)paint)->setShader(shader);
}

// ---------- rich fills: multi-stop gradients, bitmap shaders, stroke params ----
// (swc.md §9 E)

// SWF gradient/focal spread: 0 pad, 1 reflect, 2 repeat.
static SkTileMode sk_tile_from_spread(int spread) {
  switch (spread) {
    case 1:  return SkTileMode::kMirror;
    case 2:  return SkTileMode::kRepeat;
    default: return SkTileMode::kClamp;
  }
}

// SWF gradient space is a unit construct spanning [-16384, 16384] along the
// gradient axis (Ruffle's swf_to_gl_matrix divides the axis by 32768 and
// recentres by +0.5, which is the same statement). Everything the shader needs is
// therefore authored in that space and placed by the SWF matrix, so one code path
// covers linear/radial/focal. The matrix arrives as lm[6] = SWF matrix / 20 (the
// SWF matrix maps gradient space -> twips; our shape space is pixels).
#define AS_SWC_GRAD_EXTENT 16384.0

static void sk_lm_from6(SkMatrix* m, const double* lm) {
  m->setAll((SkScalar)lm[0], (SkScalar)lm[2], (SkScalar)lm[4],
            (SkScalar)lm[1], (SkScalar)lm[3], (SkScalar)lm[5],
            0.0f, 0.0f, 1.0f);
}

// kind: 0 linear, 1 radial, 2 focal. Returns 1 when a shader was installed.
int sk_paint_set_gradient(void* paint, int kind, const double* lm,
                          const unsigned* argb, const double* pos, int count,
                          int spread, double focal) {
  if (count > 32) count = 32;
  if (count < 2) return 0;
  SkColor cols[32];
  SkScalar ps[32];
  for (int i = 0; i < count; i++) {
    cols[i] = (SkColor)argb[i];
    ps[i] = (SkScalar)pos[i];
  }
  SkMatrix m;
  sk_lm_from6(&m, lm);
  const SkTileMode tm = sk_tile_from_spread(spread);
  sk_sp<SkShader> sh;
  if (kind == 1) {
    sh = SkGradientShader::MakeRadial(SkPoint::Make(0.0f, 0.0f),
                                      (SkScalar)AS_SWC_GRAD_EXTENT,
                                      cols, ps, count, tm, 0, &m);
  } else if (kind == 2) {
    // The focal point sits at (focal, 0) in the normalised [-1,1] space, i.e.
    // focal * 16384 along the gradient axis. Skia's two-point conical is the
    // same construction (a point-radius circle morphing into the outer circle).
    double f = focal;
    if (f > 0.999) f = 0.999;
    if (f < -0.999) f = -0.999;
    sh = SkGradientShader::MakeTwoPointConical(
        SkPoint::Make((SkScalar)(f * AS_SWC_GRAD_EXTENT), 0.0f), 0.0f,
        SkPoint::Make(0.0f, 0.0f), (SkScalar)AS_SWC_GRAD_EXTENT,
        cols, ps, count, tm, 0, &m);
  } else {
    SkPoint pts[2] = { SkPoint::Make((SkScalar)-AS_SWC_GRAD_EXTENT, 0.0f),
                       SkPoint::Make((SkScalar)AS_SWC_GRAD_EXTENT, 0.0f) };
    sh = SkGradientShader::MakeLinear(pts, cols, ps, count, tm, 0, &m);
  }
  if (!sh) return 0;
  ((SkPaint*)paint)->setShader(std::move(sh));
  return 1;
}

// Bitmap fills: the SWF bitmap matrix maps the bitmap's PIXEL rect (0,0)-(w,h)
// onto the shape, so lm[6] = that matrix / 20 lands the image directly (verified
// against the skin: a 46x46 bitmap with matrix scale 20 covers exactly 920 twips).
// `repeat` false = CLIPPED, i.e. decal tile mode (SWF fill types 0x41/0x43).
int sk_paint_set_bitmap_shader(void* paint, void* image, const double* lm,
                              int repeat, int smooth) {
  if (image == nullptr) return 0;
  SkMatrix m;
  sk_lm_from6(&m, lm);
  // SWF bitmap fills are either repeating (0x40/0x42) or CLIPPED (0x41/0x43).
  // "Clipped" means the bitmap is painted once and the area outside its own rect
  // stays empty, so the non-repeating mode must be kDecal (transparent outside),
  // never kClamp -- clamping smears the border pixels over the rest of the shape.
  // skin.swc shape #815 (a 1416x402 filmstrip whose bitmap covers only the first
  // 375 px) is the canary: with kClamp we repainted the whole strip while adl
  // painted the covered part only.
  const SkTileMode tm = repeat ? SkTileMode::kRepeat : SkTileMode::kDecal;
  const SkSamplingOptions so =
      smooth ? SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNearest)
             : SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
  auto sh = ((SkImage*)image)->makeShader(tm, tm, so, &m);
  if (!sh) return 0;
  ((SkPaint*)paint)->setShader(std::move(sh));
  return 1;
}

// SWF stroke caps: 0 round, 1 butt, 2 square; joins: 0 round, 1 bevel, 2 miter.
void sk_paint_set_stroke_params(void* paint, int cap, int join, double miter) {
  SkPaint::Cap c = SkPaint::kButt_Cap;
  if (cap == 0) c = SkPaint::kRound_Cap;
  else if (cap == 2) c = SkPaint::kSquare_Cap;
  SkPaint::Join j = SkPaint::kMiter_Join;
  if (join == 0) j = SkPaint::kRound_Join;
  else if (join == 1) j = SkPaint::kBevel_Join;
  SkPaint* p = (SkPaint*)paint;
  p->setStrokeCap(c);
  p->setStrokeJoin(j);
  if (miter > 0.0) p->setStrokeMiter((SkScalar)miter);
}

// ---------- image filters (stage 61: DisplayObject.filters rendering) ----------

// Each filter is attached to a SkPaint whose only role is carrying the
// SkImageFilter into SkCanvas::saveLayer. The generated C wraps an object's
// whole drawn subtree in such a layer so the filter sees the composited pixels,
// matching AS3's "filter the DisplayObject" semantics (not a single paint).

void sk_paint_set_image_filter_blur(void* paint, double sigmaX, double sigmaY) {
  auto f = SkImageFilters::Blur((SkScalar)sigmaX, (SkScalar)sigmaY, nullptr);
  ((SkPaint*)paint)->setImageFilter(std::move(f));
}

// AS3 `strength` scales the imprint AFTER the blur, without a pre-clamp at
// alpha 1.0. Measured on adl (temp/filterprobe): a DropShadow with colour alpha 1
// gives fringe darkness 0.106 at strength 0.5 and 0.431 at strength 2 — four
// times as dark, i.e. min(1, silhouette * alpha * strength); clamping the colour
// alpha first would have flattened strength 2 to the silhouette's 0.212, and
// GlowFilter alpha 0.5 x strength 2 renders exactly like strength 1 (also
// measured), so the product is what counts. Skia's colour matrices carry
// unpremultiplied channels, so an alpha row of `strength` saturates at 1.0 on
// its own — the same min(1, ...) AIR exhibits.
static sk_sp<SkImageFilter> sk_alpha_scale_after(float strength, sk_sp<SkImageFilter> inner) {
  if (strength == 1.0f || inner == nullptr) return inner;
  float m[20] = {1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,strength,0};
  return SkImageFilters::ColorFilter(SkColorFilters::Matrix(m), std::move(inner));
}

// Two regimes, both exact, because Skia's DropShadow composites the SOURCE too and
// the strength scale must therefore never touch the source:
//   * alpha*strength <= 1 and the source is wanted: bake the whole imprint into the
//     shadow colour and let Skia composite the source itself (the caller draws
//     nothing on top). Scaling this filter's output instead would scale the source
//     as well — measured: a baked SWC shadow (colour alpha 0.5, strength 0.539) washed
//     an entire 425x124 bar down to alpha 137/255, i.e. exactly the strength factor.
//   * otherwise (the imprint would exceed 1, or the source is not wanted): shadow
//     only, scaled after the blur, with the caller painting the source itself — the
//     saturating case AIR exhibits (alpha 1, strength 2 -> fringe 0.431, not 0.212).
void sk_paint_set_image_filter_drop_shadow(void* paint, double dx, double dy,
                                           double sigmaX, double sigmaY,
                                           unsigned rgb, double alpha,
                                           double strength, int drawSource) {
  if (drawSource != 0 && alpha * strength <= 1.0) {
    auto f = SkImageFilters::DropShadow((SkScalar)dx, (SkScalar)dy,
                                        (SkScalar)sigmaX, (SkScalar)sigmaY,
                                        sk_argb(rgb, alpha * strength), nullptr);
    ((SkPaint*)paint)->setImageFilter(std::move(f));
    return;
  }
  auto f = SkImageFilters::DropShadowOnly((SkScalar)dx, (SkScalar)dy,
                                          (SkScalar)sigmaX, (SkScalar)sigmaY,
                                          sk_argb(rgb, alpha), nullptr);
  f = sk_alpha_scale_after((float)strength, std::move(f));
  ((SkPaint*)paint)->setImageFilter(std::move(f));
}

// Outer glow: recolor the object's alpha silhouette to the glow color (RGB
// replaced by the glow color, alpha scaled by the filter's alpha), then blur it.
// The caller draws the unfiltered body on top afterwards, so only the blurred
// fringe peeks out around the edge — exactly what an outer GlowFilter shows.
void sk_paint_set_image_filter_glow(void* paint, double sigmaX, double sigmaY,
                                    unsigned rgb, double alpha,
                                    double strength) {
  float ga = (float)alpha;
  float m[20] = {
    0, 0, 0, 0, (float)((rgb >> 16) & 0xFF),
    0, 0, 0, 0, (float)((rgb >> 8) & 0xFF),
    0, 0, 0, 0, (float)(rgb & 0xFF),
    0, 0, 0, ga, 0,
  };
  auto cf = SkColorFilters::Matrix(m);
  auto colorFilter = SkImageFilters::ColorFilter(std::move(cf), nullptr);
  auto blur = SkImageFilters::Blur((SkScalar)sigmaX, (SkScalar)sigmaY, std::move(colorFilter));
  // The strength scale MUST come after the blur, not in the matrix above. The
  // silhouette is fully opaque inside the shape, so scaling alpha by a strength
  // above 1 before blurring saturates immediately and changes nothing — measured:
  // glow strength 1 and 2 gave identical fringe coverage, while adl's 2 was
  // exactly twice the strength-1 darkness. After the blur the fringe alpha is
  // still below 1 and scales linearly (see sk_alpha_scale_after).
  blur = sk_alpha_scale_after((float)strength, std::move(blur));
  ((SkPaint*)paint)->setImageFilter(std::move(blur));
}

// A full 4x5 colour matrix (SkColorMatrix row-major order; the translation column
// is in 0..1 units because Skia's matrices carry unpremultiplied 0..1 channels).
// Applied to a saveLayer paint, it re-colours the whole composited subtree on
// restore — that is how an AS3 ColorTransform is rendered: per-paint application
// would multiply alpha twice wherever a sprite's own geometry overlaps.
void sk_paint_set_color_matrix(void* paint, const float* m20) {
  SkColorMatrix m;
  // fMat is private; setRowMajor is the public row-major setter.
  m.setRowMajor(m20);
  ((SkPaint*)paint)->setColorFilter(SkColorFilters::Matrix(m));
}

// A paint that maps every colour to opaque BLACK, keeping only alpha. Painting it
// as a saveLayer paint re-colours that layer on composite, so re-drawing the
// SAME text layout through it yields black glyphs with the original coverage in
// their antialiased edges — no second SkParagraph needed. This is how a focused
// TextField's selected glyphs are drawn: adl paints them pure (0,0,0) on the
// selection band whatever the field's colours are (measured, SelFocus probe).
void* sk_paint_black_keep_alpha(void) {
  SkPaint* p = new SkPaint();
  float m[20] = {
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 1, 0,
  };
  p->setColorFilter(SkColorFilters::Matrix(m));
  return (void*)p;
}

// saveLayer with an explicit paint (null bounds = auto-extend to the clip). The
// paint's image filter is applied to the layer's composited result on restore.
void sk_canvas_save_layer_paint(void* canvas, void* paint) {
  ((SkCanvas*)canvas)->saveLayer(nullptr, (SkPaint*)paint);
}

// saveLayer restricted to an explicit local-coordinate bounds. Passing a tight
// bounds keeps the offscreen backing store small (just the filtered subtree +
// blur spread) instead of extending to the whole canvas clip, which is what made
// per-frame filter rendering drop to ~20 fps on large windows.
void sk_canvas_save_layer_paint_bounds(void* canvas, void* paint,
                                       double l, double t, double r, double b) {
  SkRect bounds = SkRect::MakeLTRB((SkScalar)l, (SkScalar)t, (SkScalar)r, (SkScalar)b);
  ((SkCanvas*)canvas)->saveLayer(&bounds, (SkPaint*)paint);
}

// ---------- bitmap / image ----------

// E3 / E4 (opt-in): the extra SKCodec formats our Skia build happens to carry
// are NOT formats AIR decodes -- adl 51.4.1 answers #2124 ("not a recognized
// image format") for BMP, WebP, ICO and every camera RAW/DNG file alike. A
// superset capability must be opt-in (AGENTS.md §1.5 / enhancements.md §1.2d),
// so the DEFAULT build refuses those families here and the ordinary #2124 path
// reports exactly what adl reports. Two named switches open them:
//
//   -D ASC_ALLOW_EXTRA_FORMATS=1  -> WebP / BMP / ICO   (--features formats)
//   -D ASC_ALLOW_RAW_FORMATS=1    -> camera RAW / DNG    (--features raw)
//
// The test is a magic-byte sniff, not a codec probe: it costs a few compares on
// every load and never parses the file twice. The signatures cannot collide with
// the formats AIR does support (PNG 89 50 4E 47, JPEG FF D8, GIF "GIF8"):
//   RIFF....WEBP | BM | 00 00 01 00 (ICO) | TIFF "II*\0" / "MM\0*" (DNG/CR2/...)
// WBMP (SkWbmpCodec is compiled in) is deliberately NOT gated: its header is a
// bare multi-byte type field with no reliable magic, so it keeps the codec's
// behaviour -- stated here rather than guessed at (see docs §4.3).
static bool sk_extra_format_refused(const void* data, size_t len) {
    const unsigned char* p = (const unsigned char*)data;
    if (p == nullptr || len < 4) return false;
#ifndef ASC_ALLOW_EXTRA_FORMATS
    if (len >= 12 && p[0] == 'R' && p[1] == 'I' && p[2] == 'F' && p[3] == 'F'
        && p[8] == 'W' && p[9] == 'E' && p[10] == 'B' && p[11] == 'P') return true;
    if (p[0] == 'B' && p[1] == 'M') return true;
    if (p[0] == 0 && p[1] == 0 && p[2] == 1 && p[3] == 0) return true;   // ICO
    if (p[0] == 0 && p[1] == 0 && p[2] == 2 && p[3] == 0) return true;   // CUR
#endif
#ifndef ASC_ALLOW_RAW_FORMATS
    // Every TIFF-based raw container (DNG, CR2, NEF, ARW, ORF, RW2, PEF, SRW...)
    // starts with a TIFF header; RAF is the one non-TIFF exception.
    if (p[0] == 'I' && p[1] == 'I' && p[2] == 42 && p[3] == 0) return true;
    if (p[0] == 'M' && p[1] == 'M' && p[2] == 0 && p[3] == 42) return true;
    if (len >= 16 && memcmp(p, "FUJIFILMCCD-RAW", 15) == 0) return true;
#endif
    return false;
}

// E1 (opt-in, native-only): SVG is NOT an SkCodec format, so the whole
// DeferredFromEncodedData pipeline that serves PNG/JPEG/GIF/WebP/BMP/ICO has
// nothing to say about it -- Loader.load("x.svg") reports the same #2124
// "unknown type" AIR does (verified against adl 51.4.1). Rendering one means a
// different pipeline: parse to an SkSVGDOM and rasterize through a canvas.
//
// That makes it an ENHANCEMENT (AIR never supported SVG at all), and per
// AGENTS.md §1.5 enhancements are opt-in: the declarations below only exist
// when the build defines ASC_USE_SVG, so the default build keeps AIR's behavior
// byte for byte. Implementations live further down, next to the font manager
// (an SVG with <text> renders with the same platform fonts as TextField).
//
// Native only: vendor/skia/lib/wasm ships no svg/sksg/expat static libraries at
// all, so a web build that defines ASC_USE_SVG fails at link time instead of
// silently dropping the feature.
#ifdef ASC_USE_SVG
static bool sk_svg_header(const void* data, size_t len);
static sk_sp<SkImage> sk_svg_to_image(const void* data, size_t len, int* outW, int* outH);
static void* sk_svg_to_argb(const void* data, size_t len, int* width, int* height);
#endif

// SkImage view of a runtime pixel buffer: the exact INVERSE of the read-back
// below (sk_image_decode_argb / sk_surface_read_argb). `px` holds width*height
// uint32 words in the runtime's canonical 0xAARRGGBB straight-alpha layout, which
// on a little-endian host is byte-for-byte kBGRA_8888 -- so the explicit color
// type is all that is needed, exactly like the read-back direction, and
// kUnpremul states that the alpha in the buffer is straight. Used by
// Graphics.beginBitmapFill, whose source is a live BitmapData rather than an
// encoded file. Always a COPY: the caller's buffer keeps ownership (it may be
// rewritten by the next BitmapData.fillRect) and lives in the GC heap.
void* sk_image_from_argb(const void* px, int w, int h) {
  if (px == nullptr || w <= 0 || h <= 0) return nullptr;
  SkImageInfo info = SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kUnpremul_SkAlphaType);
  sk_sp<SkImage> image = SkImages::RasterFromPixmapCopy(SkPixmap(info, px, (size_t)w * 4));
  return image.release();  // caller owns one ref (or NULL on failure)
}

void* sk_image_from_file(const char* path) {
  auto data = SkData::MakeFromFileName(path);
  if (!data) return nullptr;
  // E3/E4: an AIR-unknown format family is refused before any decode, so the
  // caller reports the same #2124 adl does (see sk_extra_format_refused).
  if (sk_extra_format_refused(data->data(), data->size())) return nullptr;
  // m124: SkImage::MakeFromEncoded -> SkImages::DeferredFromEncodedData.
  auto image = SkImages::DeferredFromEncodedData(data);
#ifdef ASC_USE_SVG
  // Only after the codec path has definitively failed: SVG is the fallback for
  // "not an encoded image", never a competing decoder for one.
  if (!image && sk_svg_header(data->data(), data->size())) {
    image = sk_svg_to_image(data->data(), data->size(), nullptr, nullptr);
  }
#endif
  return image.release();  // caller owns one ref (or NULL on decode failure)
}

// SkImage view of an image that is already in memory, i.e. one that arrived over
// the network (Loader.load of an http(s):// URL) rather than from a file. The
// bytes are COPIED into the SkData: the caller's buffer belongs to the async job
// and is released when the job retires, while a deferred SkImage can outlive it
// (the display-list Bitmap keeps the view for as long as it is on the stage, and
// the actual pixel decode happens lazily, at first draw).
void* sk_image_from_bytes(const void* data, size_t len) {
  if (data == nullptr || len == 0) return nullptr;
  if (sk_extra_format_refused(data, len)) return nullptr;   // E3/E4, see above
  auto skdata = SkData::MakeWithCopy(data, len);
  if (!skdata) return nullptr;
  auto image = SkImages::DeferredFromEncodedData(skdata);
#ifdef ASC_USE_SVG
  if (!image && sk_svg_header(data, len)) {
    image = sk_svg_to_image(data, len, nullptr, nullptr);
  }
#endif
  return image.release();  // caller owns one ref (or NULL on decode failure)
}

// ---- Skia -> runtime pixel boundary ----
//
// The runtime's canonical BitmapData layout is a uint32 holding 0xAARRGGBB with
// straight (un-premultiplied) alpha. Skia's own native layout, kN32_SkColorType,
// differs BY PLATFORM (BGRA on Windows, RGBA on macOS/Linux -- see
// SkColorType.h + SK_PMCOLOR_BYTE_ORDER in SkTypes.h), so the generated C must
// never assume a byte order of a Skia surface. Every read-back therefore requests
// kBGRA_8888 EXPLICITLY and the host-endian interpretation is settled here, in
// one place, where Skia does the channel conversion for us: on a little-endian
// host a BGRA byte sequence read as a uint32 already IS 0xAARRGGBB, so the
// explicit request alone fixes the order with no per-pixel pass.
//
// (Assuming a BGRA-equivalent order on the generated-C side is exactly what
// swapped red and blue in BitmapData.draw(TextField) -- see
// examples/bitmapdraw-channel.as.)
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
// Big-endian host: bytes B,G,R,A interpret as 0xBBGGRRAA, so compose the ARGB
// word explicitly. No such target exists today; kept for correctness.
static void sk_bgra_readback_to_argb(uint32_t* buf, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint32_t p = buf[i];
    buf[i] = ((p & 0xFFu) << 24) | (((p >> 8) & 0xFFu) << 16) |
             (((p >> 16) & 0xFFu) << 8) | ((p >> 24) & 0xFFu);
  }
}
#else
// Little-endian host: BGRA bytes already read as 0xAARRGGBB, nothing to do.
static void sk_bgra_readback_to_argb(uint32_t*, size_t) {}
#endif

// Read a surface back into the runtime's straight-ARGB (0xAARRGGBB) uint32
// buffer (`dst` holds width*height words). kUnpremul yields AS3's straight-alpha
// semantics in the same step, so no manual un-premultiply pass is needed.
int sk_surface_read_argb(void* surface, uint32_t* dst, int width, int height) {
  if (surface == nullptr || dst == nullptr || width <= 0 || height <= 0) return 0;
  SkImageInfo info = SkImageInfo::Make(width, height, kBGRA_8888_SkColorType, kUnpremul_SkAlphaType);
  if (!((SkSurface*)surface)->readPixels(info, dst, (size_t)width * 4, 0, 0)) return 0;
  sk_bgra_readback_to_argb(dst, (size_t)width * (size_t)height);
  return 1;
}

// Decode an image file into a freshly malloc'd ARGB (0xAARRGGBB) uint32 buffer,
// returning the buffer (caller frees) or NULL on failure. *width/*height receive
// the image dimensions. This mirrors AS3 BitmapData's `pixels` layout so
// BitmapData_loadFile can populate the CPU pixel buffer directly.
void* sk_image_decode_argb(const char* path, int* width, int* height) {
  auto data = SkData::MakeFromFileName(path);
  if (!data) return nullptr;
  if (sk_extra_format_refused(data->data(), data->size())) return nullptr;   // E3/E4
  auto image = SkImages::DeferredFromEncodedData(data);
#ifdef ASC_USE_SVG
  if (!image && sk_svg_header(data->data(), data->size())) {
    return sk_svg_to_argb(data->data(), data->size(), width, height);
  }
#endif
  if (!image) return nullptr;
  int w = image->width(), h = image->height();
  if (w <= 0 || h <= 0) return nullptr;
  size_t n = (size_t)w * (size_t)h;
  uint32_t* buf = (uint32_t*)malloc(n * 4);
  if (!buf) return nullptr;
  // Decode straight into the ARGB buffer -- no staging copy, no per-pixel loop:
  // kBGRA_8888 + little-endian is already 0xAARRGGBB, and kUnpremul gives AS3's
  // straight alpha.
  SkImageInfo info = SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kUnpremul_SkAlphaType);
  if (!image->readPixels(info, buf, (size_t)w * 4, 0, 0)) { free(buf); return nullptr; }
  sk_bgra_readback_to_argb(buf, n);
  *width = w; *height = h;
  return buf;
}

// Decode an image from an in-memory byte buffer (ByteArray / Loader.loadBytes)
// into a freshly malloc'd ARGB uint32 buffer, mirroring sk_image_decode_argb.
// Returns NULL on failure and sets *width/*height on success.
void* sk_image_decode_bytes_argb(const void* data, size_t len, int* width, int* height) {
  if (data == nullptr || len == 0) return nullptr;
  if (sk_extra_format_refused(data, len)) return nullptr;   // E3/E4
  auto skdata = SkData::MakeWithCopy(data, len);
  if (!skdata) return nullptr;
  auto image = SkImages::DeferredFromEncodedData(skdata);
#ifdef ASC_USE_SVG
  if (!image && sk_svg_header(data, len)) {
    return sk_svg_to_argb(data, len, width, height);
  }
#endif
  if (!image) return nullptr;
  int w = image->width(), h = image->height();
  if (w <= 0 || h <= 0) return nullptr;
  size_t n = (size_t)w * (size_t)h;
  uint32_t* buf = (uint32_t*)malloc(n * 4);
  if (!buf) return nullptr;
  SkImageInfo info = SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kUnpremul_SkAlphaType);
  if (!image->readPixels(info, buf, (size_t)w * 4, 0, 0)) { free(buf); return nullptr; }
  sk_bgra_readback_to_argb(buf, n);
  *width = w; *height = h;
  return buf;
}

void sk_canvas_draw_image_rect(void* canvas, void* image,
                               double dx, double dy, double dw, double dh) {
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect((SkImage*)image, dst, SkSamplingOptions());
}

// Draw one SUB-RECT of an image into a destination rect. Nine-slice scaling needs
// this: the 8 border pieces reuse their source pixels unchanged while the middle
// piece stretches, which a whole-image drawImageRect cannot express (swc.md §9 F).
void sk_canvas_draw_image_src_rect(void* canvas, void* image,
                                   double sx, double sy, double sw, double sh,
                                   double dx, double dy, double dw, double dh) {
  SkRect src = SkRect::MakeXYWH((SkScalar)sx, (SkScalar)sy, (SkScalar)sw, (SkScalar)sh);
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  // kStrict stops the stretched middle band from sampling across its border into
  // the piece next to it (the src-rect overload has no default constraint).
  ((SkCanvas*)canvas)->drawImageRect((SkImage*)image, src, dst, SkSamplingOptions(),
                                     nullptr, SkCanvas::kStrict_SrcRectConstraint);
}

// Draw a tightly packed BGRA8 pixel buffer (width*height*4 bytes, B,G,R,A byte
// order) scaled into the destination rect. Used to composite the Stage3D
// offscreen render target (an MTLPixelFormatBGRA8Unorm texture read back via
// s3d_readback_render) onto the window canvas so Stage3D content actually
// reaches the screen (stage 82 P2). The pixels are premultiplied — a Metal
// render target produces premultiplied alpha when blending is enabled, and the
// opaque clear-color regions (alpha=255) are unaffected either way.
//
// NOTE: this is the CPU-raster compositing path only. On the GPU Metal backend
// the Stage3D render target is blitted directly as a GPU texture
// (sk_mtl_draw_texture), avoiding the CPU round-trip entirely. RasterFromPixmapCopy
// is deliberately used here (not a cached SkBitmap): a cached image would freeze
// the first frame's pixels, and the copy has no cost on a CPU raster canvas
// (there is no per-frame GPU texture upload to leak).
void sk_canvas_draw_bgra(void* canvas, const uint8_t* bgra, int w, int h,
                         double dx, double dy, double dw, double dh) {
  if (canvas == nullptr || bgra == nullptr || w <= 0 || h <= 0) return;
  SkImageInfo info = SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kPremul_SkAlphaType);
  sk_sp<SkImage> image = SkImages::RasterFromPixmapCopy(SkPixmap(info, bgra, (size_t)w * 4));
  if (!image) return;
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect(image.get(), dst, SkSamplingOptions());
}

// ---------- text ----------

// Platform font manager: CoreText on native macOS (enumerates installed
// families, expensive to construct — hence the cache); a custom FreeType
// manager on web/wasm, fed by runtime-injected font byte streams (there is no
// system font to enumerate in the sandbox).
#ifdef __EMSCRIPTEN__
static std::vector<sk_sp<SkData>> g_font_datas;
static sk_sp<SkFontMgr> g_fontmgr_cache;

static sk_sp<SkFontMgr> sk_platform_fontmgr() {
  if (g_fontmgr_cache == nullptr) {
    // No fonts injected yet -> empty manager (matchFamilyStyle returns an empty
    // typeface, so text renders as nothing until the host registers fonts).
    if (g_font_datas.empty()) {
      g_fontmgr_cache = SkFontMgr_New_Custom_Empty();
    } else {
      // SkFontMgr_New_Custom_Data scans each data blob (via FreeType) and builds
      // a matchable family->typeface table, so matchFamilyStyle / SkParagraph
      // find the injected fonts by name — the wasm analogue of CoreText.
      g_fontmgr_cache = SkFontMgr_New_Custom_Data(
          SkSpan<sk_sp<SkData>>(g_font_datas.data(), g_font_datas.size()));
    }
  }
  return g_fontmgr_cache;
}

// Host-facing font injection entry point (Emscripten exports it to JS): the
// host fetches a TTF/OTF byte stream and hands it here. The cache is dropped so
// the next manager construction rescans the enlarged set. Returns 1 on success.
extern "C" EMSCRIPTEN_KEEPALIVE
int sk_fontmgr_register_data(const void* data, int len) {
  if (data == nullptr || len <= 0) return 0;
  g_font_datas.push_back(SkData::MakeWithCopy(data, (size_t)len));
  g_fontmgr_cache = nullptr;  // force a rebuild that sees the new data
  return 1;
}
#elif defined(_WIN32)
static sk_sp<SkFontMgr> sk_platform_fontmgr() {
  // GDI enumerates the Windows system font collection (the analogue of CoreText
  // on macOS). Cached for the same reason as the CoreText path: construction
  // walks the whole installed family list and must not repeat per draw call.
  static sk_sp<SkFontMgr> cached = SkFontMgr_New_GDI();
  return cached;
}
#else
static sk_sp<SkFontMgr> sk_platform_fontmgr() {
  static sk_sp<SkFontMgr> cached = SkFontMgr_New_CoreText(nullptr);
  return cached;
}
#endif

#ifdef ASC_USE_SVG
// SVG's own default viewport when the document declares no width/height (the
// SVG spec's replaced-element default, 300x150). AIR has no SVG support whose
// behavior could be copied here, so the spec's number is the honest choice.
#define SK_SVG_DEFAULT_W 300
#define SK_SVG_DEFAULT_H 150

// Cheap sniff, run only AFTER the codec path has already failed. "Not an
// encoded image" is a normal outcome (any non-image payload), so the SVG test
// must not cost a parse attempt on data that is plainly not XML: an SVG/XML
// payload starts with '<' once leading whitespace and a UTF-8 BOM are skipped.
static bool sk_svg_header(const void* data, size_t len) {
  if (data == nullptr || len == 0) return false;
  const unsigned char* p = (const unsigned char*)data;
  size_t i = 0;
  if (len >= 3 && p[0] == 0xEF && p[1] == 0xBB && p[2] == 0xBF) i = 3;
  while (i < len && (p[i] == ' ' || p[i] == '\t' || p[i] == '\n' || p[i] == '\r')) i++;
  return i < len && p[i] == '<';
}

// Rasterize an SVG document to a premultiplied N32 image, or null when it cannot
// be parsed. Sizes to the document's own width/height when it declares one,
// otherwise to the spec default above. The same font manager the rest of the
// raster layer uses is handed to the parser, so <text> renders with platform
// fonts instead of vanishing.
static sk_sp<SkImage> sk_svg_to_image(const void* data, size_t len, int* outW, int* outH) {
  auto skdata = SkData::MakeWithCopy(data, len);
  if (!skdata) return nullptr;
  auto stream = SkMemoryStream::Make(skdata);
  if (!stream) return nullptr;
  // The Builder form is what this Skia revision exposes: MakeFromStream(str)
  // alone would leave the font manager unset, and an SVG's <text> then renders
  // as nothing at all (documented on Builder::setFontManager).
  auto dom = SkSVGDOM::Builder().setFontManager(sk_platform_fontmgr()).make(*stream);
  if (!dom) return nullptr;

  SkSize intrinsic = dom->containerSize();
  SkScalar w = intrinsic.width();
  SkScalar h = intrinsic.height();
  if (!(w > 0)) w = SK_SVG_DEFAULT_W;
  if (!(h > 0)) h = SK_SVG_DEFAULT_H;
  dom->setContainerSize(SkSize::Make(w, h));

  SkImageInfo info = SkImageInfo::Make(SkScalarRoundToInt(w), SkScalarRoundToInt(h),
                                       kN32_SkColorType, kPremul_SkAlphaType);
  auto surface = SkSurfaces::Raster(info);
  if (!surface) return nullptr;
  // An SVG has no background of its own; start transparent so a document that
  // paints nothing (or only part of the viewport) does not read back as opaque
  // black, which is what an uninitialized surface would give.
  surface->getCanvas()->clear(SK_ColorTRANSPARENT);
  dom->render(surface->getCanvas());
  auto image = surface->makeImageSnapshot();
  if (!image) return nullptr;
  if (outW) *outW = image->width();
  if (outH) *outH = image->height();
  return image;
}

// Adapter for the BitmapData-side entry points: rasterize, then copy into the
// runtime's straight-ARGB (0xAARRGGBB) uint32 layout exactly as the codec
// decoders do (kBGRA_8888 + kUnpremul + the one endianness settle), so an SVG
// BitmapData is indistinguishable from a PNG one to everything downstream.
static void* sk_svg_to_argb(const void* data, size_t len, int* width, int* height) {
  sk_sp<SkImage> image = sk_svg_to_image(data, len, nullptr, nullptr);
  if (!image) return nullptr;
  int w = image->width(), h = image->height();
  if (w <= 0 || h <= 0) return nullptr;
  size_t n = (size_t)w * (size_t)h;
  uint32_t* buf = (uint32_t*)malloc(n * 4);
  if (!buf) return nullptr;
  SkImageInfo info = SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kUnpremul_SkAlphaType);
  if (!image->readPixels(info, buf, (size_t)w * 4, 0, 0)) { free(buf); return nullptr; }
  sk_bgra_readback_to_argb(buf, n);
  if (width) *width = w;
  if (height) *height = h;
  return buf;
}
#endif  // ASC_USE_SVG

// The CoreText font manager enumerates and sorts every installed font family on
// construction, so it must be created once, not per draw call: a multi-line
// TextField draws one string per line (plus one measure per word while wrapping),
// and doing that work per call made the window hang for tens of seconds on the
// first frame. The default typeface is cached the same way.
static const sk_sp<SkTypeface>& sk_default_typeface() {
  static sk_sp<SkTypeface> cached = []() -> sk_sp<SkTypeface> {
    sk_sp<SkFontMgr> mgr = sk_platform_fontmgr();
    if (!mgr) return nullptr;
    return mgr->matchFamilyStyle(nullptr, SkFontStyle());
  }();
  return cached;
}

// AIR's three "device font" aliases are not font families: they are generic
// names the Flash runtime resolves to installed faces itself. CoreText has never
// heard of "_typewriter", so handing it through verbatim made SkParagraph fall
// back to the system default -- a PROPORTIONAL face -- and a "_typewriter" field
// measured 113.26 px per 10 "W" glyphs instead of 72 (adl 51.4.1, size 12),
// i.e. every metric of a typewriter field was wrong by ~40%. The faces below are
// the ones whose adl-measured ADVANCES match AIR's aliases exactly:
//   "_typewriter" -> Monaco            (7.2 px/char monospace; adl line height 15)
//   "_sans"       -> Helvetica         (10W=113, 10i=26.5, 10*=46.5 -- identical)
//   "_serif"      -> Times New Roman   (10W=113, 10i=33, 10*=60 -- identical)
//   ""/NULL       -> Times             (AIR's default format font, reported as
//                                       "Times Roman"; adl single-line height 12
//                                       matches Times' 12, not Times New Roman's 14)
// Named families pass through untouched -- our CoreText advances already match
// AIR's for Courier / Courier New / Menlo / Monaco / Helvetica / Arial / Times
// New Roman / Geneva (measured; table in docs/zh-cn/skia.md). The residual
// per-face line-height skew (ours runs up to 1 px taller: Monaco 16 vs adl 15,
// Arial 14 vs 13.5) is SkParagraph's ascent+descent rounding and is recorded as
// a known deviation rather than papered over with a fudge factor.
// Typeface lookup keyed by (family, weight, slant), cached: the CSS font family
// names of a TextField never change at runtime, and CoreText's matchFamilyStyle
// is the expensive part of building a paragraph (it walks the installed family
// list). Misses are cached too -- an unknown family must fall back to the same
// face every time, not re-resolve per frame.
static const char* sk_family_alias(const char* family);

static sk_sp<SkTypeface> sk_match_typeface(const char* family, int bold, int italic) {
  static std::map<std::string, sk_sp<SkTypeface>> cache;
  SkString key;
  key.printf("%s|%d|%d", family ? family : "", bold ? 1 : 0, italic ? 1 : 0);
  auto it = cache.find(std::string(key.c_str()));
  if (it != cache.end()) return it->second;
  sk_sp<SkFontMgr> mgr = sk_platform_fontmgr();
  SkFontStyle style(bold ? SkFontStyle::kBold_Weight : SkFontStyle::kNormal_Weight,
                    SkFontStyle::kNormal_Width,
                    italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant);
  sk_sp<SkTypeface> tf = mgr ? mgr->matchFamilyStyle(sk_family_alias(family), style) : nullptr;
  cache[std::string(key.c_str())] = tf;
  return tf;
}

// AIR rounds each half of the line box to the nearest 0.5 (measured: Helvetica
// ascent 9.24 -> 9 and descent 2.76 -> 3, Times New Roman 10.6875 -> 10.5 and
// 2.59375 -> 2.5) and never adds the font's own line gap, while Skia reports
// ceil-ish(ascent + descent + lineGap) -- Monaco's 16.002 px line gap pushed a
// 12 px line to 16 where AIR says 15. Rounding the halves reproduces every adl
// named-face line height exactly (Courier 12, Courier New 13.5, Menlo 14,
// Monaco 15, Times 12, Times New Roman 13, Arial 13.5, Helvetica 12, Geneva 15).
static double sk_round_half(double v) { return floor(v * 2.0 + 0.5) / 2.0; }

// AIR's line box for a face: round_half(ascent) + round_half(descent), plus the
// raw Skia sums needed to drive Skia's height-override path. Skia computes the
// line box as `rawSum * (StrutStyle::height * fontSize / rawFull)` where rawSum
// excludes the face's line gap but rawFull includes it, so the strut height must
// be pre-multiplied by rawFull/rawSum to land on AIR's number (Monaco's gap of
// 1.002 px otherwise silently shortens a 12 px line by a whole pixel).
struct SkAirLineMetrics {
  double model;    // AIR: rhalf(ascent) + rhalf(descent)
  double asc;      // AIR: rhalf(ascent)
  double desc;     // AIR: rhalf(descent)
  double rawSum;   // Skia: -fAscent + fDescent
  double rawFull;  // Skia: -fAscent + fDescent + fLeading (the override divisor)
};

static SkAirLineMetrics sk_air_line_metrics(const char* family, double size, int bold, int italic) {
  SkAirLineMetrics out{0.0, 0.0, 0.0, 0.0, 0.0};
  if (size <= 0.0) return out;
  sk_sp<SkTypeface> tf = sk_match_typeface(family, bold, italic);
  SkFont font(tf, (SkScalar)size);
  SkFontMetrics m;
  font.getMetrics(&m);
  out.asc = sk_round_half(-m.fAscent);
  out.desc = sk_round_half(m.fDescent);
  out.model = out.asc + out.desc;
  out.rawSum = -m.fAscent + m.fDescent;
  out.rawFull = out.rawSum + m.fLeading;
  return out;
}

static double sk_air_line_height(const char* family, double size, int bold, int italic) {
  return sk_air_line_metrics(family, size, bold, italic).model;
}

// AIR's line box, applied to every paragraph: per-line height =
// round_half(ascent) + round_half(descent) + leading, with `leading` in PIXELS
// (TextFormat.leading; AIR adds px, never an em multiple -- measured, see
// docs/zh-cn/skia.md). SkParagraph instead reports ceil-ish(ascent+descent+
// lineGap) and reads StrutStyle::leading as an em multiple of the font size.
// Forcing a strut with an explicit height override makes Skia scale the face's
// ascent/descent to exactly AIR's box, and dividing the px leading by the size
// converts it back to the em multiple Skia expects. leading may be negative
// (AIR: a negative leading shrinks the box, adl 15-3 = 12), so the guard is on
// the resulting height, not on the sign.
static void sk_set_air_strut(skia::textlayout::ParagraphStyle& ps, const char* family, double size,
                             int bold, int italic, double leading) {
  using namespace skia::textlayout;
  SkAirLineMetrics am = sk_air_line_metrics(family, size, bold, italic);
  if (size <= 0.0 || am.model <= 0.0 || am.rawSum <= 0.0) return;
  double box = am.model + leading;  // AIR's per-line height, px leading included
  if (box <= 0.0) return;
  StrutStyle strut;
  strut.setStrutEnabled(true);
  strut.setFontSize((SkScalar)size);
  strut.setFontFamilies({ SkString(sk_family_alias(family)) });
  // Skia scales the raw metrics by (height * fontSize / rawFull); pre-multiply so
  // the resulting box before the strut leading is exactly the intended one.
  // Negative leading cannot go through StrutStyle::leading (Skia clamps a
  // negative value to 0 -- ParagraphImpl.cpp), so it is folded into the height
  // instead; a positive one stays a leading so the ascent keeps its AIR ratio.
  const double boxHeight = (leading < 0.0) ? box : am.model;
  strut.setHeight((SkScalar)(boxHeight * am.rawFull / (am.rawSum * size)));
  strut.setHeightOverride(true);
  strut.setForceStrutHeight(true);
  if (leading > 0.0) strut.setLeading((SkScalar)(leading / size));
  ps.setStrutStyle(strut);
}

static const char* sk_family_alias(const char* family) {
  if (family == nullptr || family[0] == 0) return "Times";
  if (strcmp(family, "_typewriter") == 0) return "Monaco";
  if (strcmp(family, "_sans") == 0) return "Helvetica";
  if (strcmp(family, "_serif") == 0) return "Times New Roman";
  return family;
}

static SkFont sk_font(double size, int bold, int italic) {
  SkFont font;
  font.setSize((SkScalar)size);
  font.setEmbolden(bold != 0);
  if (italic) font.setSkewX((SkScalar)-0.25);
  // A default-constructed SkFont has no typeface, so drawString would render
  // nothing. Bind the cached system default (macOS target: CoreText).
  const sk_sp<SkTypeface>& tf = sk_default_typeface();
  if (tf) font.setTypeface(tf);
  return font;
}

void sk_canvas_draw_text(void* canvas, const char* text, double x, double y,
                         double size, int bold, int italic, void* paint) {
  SkFont font = sk_font(size, bold, italic);
  ((SkCanvas*)canvas)->drawString(text, (SkScalar)x, (SkScalar)y, font, *(SkPaint*)paint);
}

// Length-bounded draw: TextField hands this a slice of the original string (an
// offset + byte count) rather than a copy, so the text never has to be
// re-terminated. Breaks happen at spaces, so the slice is always whole UTF-8.
void sk_canvas_draw_text_n(void* canvas, const char* text, int len, double x, double y,
                           double size, int bold, int italic, void* paint) {
  if (len <= 0) return;
  SkFont font = sk_font(size, bold, italic);
  ((SkCanvas*)canvas)->drawSimpleText(text, (size_t)len, SkTextEncoding::kUTF8,
                                      (SkScalar)x, (SkScalar)y, font, *(SkPaint*)paint);
}

double sk_text_measure(const char* text, double size, int bold, int italic) {
  SkFont font = sk_font(size, bold, italic);
  return (double)font.measureText(text, strlen(text), SkTextEncoding::kUTF8);
}

// Length-bounded measure: the word wrapper runs this per word against a source
// buffer it must not copy, so it takes an explicit byte count.
double sk_text_measure_n(const char* text, int len, double size, int bold, int italic) {
  if (len <= 0) return 0.0;
  SkFont font = sk_font(size, bold, italic);
  return (double)font.measureText(text, (size_t)len, SkTextEncoding::kUTF8);
}

// ---------- text layout (SkParagraph: TextField full typesetting) ----------
// SkParagraph replaces the self-built greedy word-wrap that measured every word
// with SkFont. A single flat TextField becomes one Paragraph: shaping is done by
// HarfBuzz (ligatures / complex scripts / emoji), line breaking follows UAX#14,
// and paint() draws the whole run at once. The FontCollection is created once
// and shared — its CoreText FontMgr enumerates every installed family on
// construction, so per-paragraph construction would repeat that expensive scan
// (the same hang-on-first-frame issue sk_font() above already avoided).

static sk_sp<skia::textlayout::FontCollection>& sk_textlayout_collection() {
  static sk_sp<skia::textlayout::FontCollection> cached = []() -> sk_sp<skia::textlayout::FontCollection> {
    sk_sp<SkFontMgr> mgr = sk_platform_fontmgr();
    auto fc = sk_sp<skia::textlayout::FontCollection>(new skia::textlayout::FontCollection());
    if (mgr) fc->setDefaultFontManager(mgr);
    return fc;
  }();
  return cached;
}

// Build and lay out a paragraph from a flat single-style TextField, returning an
// opaque Paragraph* the C side queries (height/longestLine/lineNumber/lineHeight)
// and paints, then deletes. width <= 0 means "no wrapping": the paragraph is laid
// out against a very large width so every '\n'-separated segment stays on one
// line (AIR single-line / wordWrap=false behavior). align maps to TextAlign.
// collapseNewlines turns '\n' into spaces before shaping — AIR's single-line
// field (multiline=false) never breaks on newlines, it renders them as spaces;
// SkParagraph otherwise treats '\n' as a hard break unconditionally.
//
// Semantic note vs AIR: SkParagraph uses UAX#14, so an over-wide single word or a
// hyphenated token can break mid-word where AIR wordWrap would keep it whole and
// let it overflow. Recorded as a known limitation (skia.md §8); the common
// "break at spaces" and CJK per-character breaking both match AIR.
// TextField.text stores a CR (0x0D) for every Return line break AIR inserts, but
// Skia's paragraph breaks lines only on LF (0x0A): a CR is treated as an ordinary
// control character, which silently laid every "line" of a multiline field out on
// ONE visual line (measured: a 6-line field reported numLines 1 and textHeight of a
// single line). Normalizing CR -> LF keeps the byte length identical (both are one
// byte), so every UTF-16 index elsewhere in the pipeline stays valid. With
// collapseNewlines (single-line field) both breaks become spaces instead, mirroring
// AIR's own single-line collapse.
static const char* sk_textlayout_normalize(const char* text, int collapseNewlines, std::string& buf) {
  for (const char* p = text; *p; p++) {
    if (*p != '\r' && *p != '\n') continue;
    buf.assign(text);
    for (auto& c : buf) {
      if (c == '\r' || c == '\n') c = collapseNewlines ? ' ' : '\n';
    }
    return buf.c_str();
  }
  return text;
}

void* sk_textlayout_new(const char* text, const char* family, double size, int bold, int italic,
                        unsigned color, double width, int align, int collapseNewlines) {
  if (text == NULL) return nullptr;
  using namespace skia::textlayout;

  TextStyle ts;
  ts.setFontSize((SkScalar)size);
  ts.setColor(SkColorSetRGB((color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF));
  ts.setFontStyle(SkFontStyle(bold ? SkFontStyle::kBold_Weight : SkFontStyle::kNormal_Weight,
                              SkFontStyle::kNormal_Width,
                              italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant));
  ts.setFontFamilies({ SkString(sk_family_alias(family)) });

  ParagraphStyle ps;
  ps.setTextStyle(ts);
  ps.setTextAlign((TextAlign)align);
  sk_set_air_strut(ps, family, size, bold, italic, 0.0);
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string normbuf;
  const char* t = sk_textlayout_normalize(text, collapseNewlines, normbuf);
  builder->addText(t);
  auto para = builder->Build();

  double w = (width > 0.0) ? width : 1.0e9;
  para->layout((SkScalar)w);
  return (void*)para.release();
}

// ---------- text layout: leading / autoSize / selection extensions ----------
//
// TextFormat.leading is AIR's "extra vertical space between lines" (pixels,
// default 0). SkParagraph expresses per-line spacing through the strut: a
// paragraph-wide minimum line height with an additive leading. We enable the
// strut only when leading > 0 so the default (leading=0) keeps the font's
// natural ascent+descent exactly as before. forceStrutHeight makes every line
// share strutHeight = font natural height + leading, matching AIR's uniform
// line height for a single defaultTextFormat.
void* sk_textlayout_new_leading(const char* text, const char* family, double size, int bold,
                                int italic, unsigned color, double leading, double width,
                                int align, int collapseNewlines) {
  if (text == NULL) return nullptr;
  using namespace skia::textlayout;

  TextStyle ts;
  ts.setFontSize((SkScalar)size);
  ts.setColor(SkColorSetRGB((color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF));
  ts.setFontStyle(SkFontStyle(bold ? SkFontStyle::kBold_Weight : SkFontStyle::kNormal_Weight,
                              SkFontStyle::kNormal_Width,
                              italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant));
  ts.setFontFamilies({ SkString(sk_family_alias(family)) });

  ParagraphStyle ps;
  ps.setTextStyle(ts);
  ps.setTextAlign((TextAlign)align);
  // AIR's TextFormat.leading is in pixels and is added to the line box; the
  // strut helper converts it for Skia (see sk_set_air_strut).
  sk_set_air_strut(ps, family, size, bold, italic, leading);
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string normbuf;
  const char* t = sk_textlayout_normalize(text, collapseNewlines, normbuf);
  builder->addText(t);
  auto para = builder->Build();

  double w = (width > 0.0) ? width : 1.0e9;
  para->layout((SkScalar)w);
  return (void*)para.release();
}

// A single styled run of a rich-text paragraph. Ranges are UTF-8 byte offsets
// into the (collapseNewlines-normalized) text, half-open [start, end).
struct sk_text_run {
  unsigned start;
  unsigned end;
  const char* family;
  double size;
  int bold;
  int italic;
  unsigned color;
  double leading;
};

// Rich text: lay out a paragraph from an array of style runs, each carrying its
// own font/size/color/weight/slant/leading. Runs are applied in order via
// ParagraphBuilder pushStyle/addText/pop; a leading on the *paragraph* level
// (strut) is applied from the first run that requests it (AIR applies one
// uniform line height from defaultTextFormat.leading).
void* sk_textlayout_new_runs(const char* text, const sk_text_run* runs, int run_count,
                             double width, int align, int collapseNewlines) {
  if (text == NULL || run_count <= 0) return nullptr;
  using namespace skia::textlayout;

  auto mkStyle = [](const sk_text_run& r) {
    TextStyle ts;
    ts.setFontSize((SkScalar)r.size);
    ts.setColor(SkColorSetRGB((r.color >> 16) & 0xFF, (r.color >> 8) & 0xFF, r.color & 0xFF));
    ts.setFontStyle(SkFontStyle(r.bold ? SkFontStyle::kBold_Weight : SkFontStyle::kNormal_Weight,
                                SkFontStyle::kNormal_Width,
                                r.italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant));
    ts.setFontFamilies({ SkString(sk_family_alias(r.family)) });
    return ts;
  };

  ParagraphStyle ps;
  ps.setTextStyle(mkStyle(runs[0]));
  ps.setTextAlign((TextAlign)align);
  // One line box for the whole paragraph: AIR gives a TextField a single line
  // height (htmlText runs with different sizes all share it), so the strut is
  // taken from the first run that sets a leading, else from the first run.
  {
    int leadIdx = 0;
    for (int i = 0; i < run_count; i++) {
      if (runs[i].leading != 0.0) { leadIdx = i; break; }
    }
    sk_set_air_strut(ps, runs[leadIdx].family, runs[leadIdx].size,
                     runs[leadIdx].bold ? 1 : 0, runs[leadIdx].italic ? 1 : 0, runs[leadIdx].leading);
  }
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string normbuf;
  const char* t = sk_textlayout_normalize(text, collapseNewlines, normbuf);

  // Emit runs in order; the builder applies each run's style to its [start,end)
  // slice. Gaps between runs fall back to the paragraph default style.
  size_t len = strlen(t);
  unsigned pos = 0;
  for (int i = 0; i < run_count; i++) {
    unsigned s = runs[i].start, e = runs[i].end;
    if (e > len) e = (unsigned)len;
    if (s >= e) continue;
    if (s > pos) builder->addText(t + pos, s - pos);  // gap: default style
    builder->pushStyle(mkStyle(runs[i]));
    builder->addText(t + s, e - s);
    builder->pop();
    pos = e;
  }
  if (pos < len) builder->addText(t + pos, len - pos);  // trailing gap

  auto para = builder->Build();
  double w = (width > 0.0) ? width : 1.0e9;
  para->layout((SkScalar)w);
  return (void*)para.release();
}

// Returns the UTF-16 code-unit index at a paragraph-relative coordinate, used by
// TextField selection hit-testing. x/y are relative to the paragraph's top-left
// (the same origin paint() uses). Returns -1 when the paragraph is empty.
int sk_textlayout_glyph_position_at(void* para, double x, double y) {
  if (para == NULL) return -1;
  auto p = (skia::textlayout::Paragraph*)para;
  auto r = p->getGlyphPositionAtCoordinate((SkScalar)x, (SkScalar)y);
  return r.position;
}

// Fills the caller's arrays with the bounding rects of the half-open UTF-16 range
// [start, end), returning the number of rects written (capped at max_rects). Each
// rect is 4 doubles: left, top, right, bottom (paragraph-relative). These are
// used to paint the selection highlight. Tight height per run, tight width.
// Rects covering a selection range, in *pages*: `skip` drops that many leading
// rects so a caller with a small fixed buffer can walk the whole range.
// A long selection spans one rect per line, so a single 16-rect call would only
// ever paint the first 16 lines (measured on adl 51.4.1: AIR highlights every
// visible selected line — the demo's scrolled trace field showed *no* highlight
// at all when Cmd+A selected ~90 lines, because those 16 rects sat above the
// scroll window and were clipped away).
int sk_textlayout_rects_for_range(void* para, int start, int end, int skip,
                                  double* lefts, double* tops, double* rights, double* bottoms,
                                  int max_rects) {
  if (para == NULL || max_rects <= 0 || skip < 0) return 0;
  using namespace skia::textlayout;
  auto p = (Paragraph*)para;
  auto boxes = p->getRectsForRange((unsigned)start, (unsigned)end,
                                   RectHeightStyle::kTight, RectWidthStyle::kTight);
  int n = 0, i = 0;
  for (auto& b : boxes) {
    if (i++ < skip) continue;
    if (n >= max_rects) break;
    lefts[n] = (double)b.rect.fLeft;
    tops[n] = (double)b.rect.fTop;
    rights[n] = (double)b.rect.fRight;
    bottoms[n] = (double)b.rect.fBottom;
    n++;
  }
  return n;
}

// Caret rectangle for a text index: where the text insertion point sits when it
// is at `index`, as a paragraph-relative box (x = the caret line's left edge,
// y/h = that line's tight top and height). Used to place the IME composition
// preview and to tell the OS where the composing text is, so the candidate
// window follows the caret. Returns 1 on success, 0 when no box can be derived
// (NULL paragraph, or an index outside the laid-out text).
//
// A zero-width range is what the caret "is", but Skia may report no box for one,
// so ask for the character box at the index and fall back to the previous
// character's box (caret at the end of a line/paragraph). NOTE: the index is a
// UTF-16 offset into the paragraph, whereas the generated C indexes text by
// UTF-8 BYTE (the documented divergence) — identical for ASCII.
int sk_textlayout_caret_rect(void* para, int index, double* x, double* y, double* h) {
  if (para == NULL) return 0;
  using namespace skia::textlayout;
  auto p = (Paragraph*)para;
  unsigned i = (index > 0) ? (unsigned)index : 0u;
  auto boxes = p->getRectsForRange(i, i + 1u, RectHeightStyle::kTight, RectWidthStyle::kTight);
  int use_right = 0;
  if (boxes.empty()) {
    if (i == 0) return 0;
    boxes = p->getRectsForRange(i - 1u, i, RectHeightStyle::kTight, RectWidthStyle::kTight);
    if (boxes.empty()) return 0;
    use_right = 1;
  }
  auto& r = boxes.front().rect;
  if (x) *x = (double)(use_right ? r.fRight : r.fLeft);
  if (y) *y = (double)r.fTop;
  if (h) *h = (double)(r.fBottom - r.fTop);
  return 1;
}

// Total height of the laid-out paragraph (sum of every line's ascent+descent).
double sk_textlayout_height(void* para) {
  return (double)((skia::textlayout::Paragraph*)para)->getHeight();
}

// Longest physical line width = AS3 TextField.textWidth.
double sk_textlayout_max_width(void* para) {
  return (double)((skia::textlayout::Paragraph*)para)->getLongestLine();
}

int sk_textlayout_line_count(void* para) {
  return (int)((skia::textlayout::Paragraph*)para)->lineNumber();
}

// Per-VISUAL-line metrics: the UTF-16 index range of every line (soft-wrapped
// lines included, which lineNumber() alone cannot describe) plus its top/bottom y
// in paragraph coordinates. TextField's page/arrow keys and the caret's
// scroll-into-view need exactly this: one call turns "which line is the caret on,
// where does line k start/end, how tall is it" into array lookups instead of
// re-deriving the wrap from character advances. Fixed caller buffers, capped at
// `cap` lines; returns how many were written.
int sk_textlayout_line_metrics(void* para, int* starts, int* ends, double* tops, double* bottoms, int cap) {
  if (para == NULL || cap <= 0) return 0;
  using namespace skia::textlayout;
  auto p = (Paragraph*)para;
  std::vector<LineMetrics> lm;
  p->getLineMetrics(lm);
  int n = 0;
  for (auto& m : lm) {
    if (n >= cap) break;
    if (starts) starts[n] = (int)m.fStartIndex;
    if (ends) ends[n] = (int)m.fEndIndex;
    if (tops) tops[n] = (double)m.fBaseline - (double)m.fAscent;
    if (bottoms) bottoms[n] = (double)m.fBaseline + (double)m.fDescent;
    n++;
  }
  return n;
}

// Per-line box for TextField.getLineMetrics: the line's advance width and its
// left offset inside the paragraph come straight from the line box, while the
// ascent/descent split has to be rebuilt to AIR's model. AIR reports
// `ascent + descent + leading == height` with the ascent/descent INDEPENDENT of
// the leading (measured: leading 0 -> 12/3 h15, leading 4 -> 12/3 h19, leading
// -3 -> h12 at 12 px Monaco), while Skia folds the line's leading into the
// baseline offset. The line stride (distance between consecutive baselines, or
// the paragraph height for a single line) is what the renderer lays out with, so
// stripping the leading back out of both the stride and the baseline reproduces
// AIR's split on the adl-measured cases (Monaco 12 px: 12/3 h15 exactly;
// temp/metricprobe/metric6-adl.txt vs metric6-aot.txt).
int sk_textlayout_line_box(void* para, int idx, double leading, const char* family, double size,
                           int bold, int italic,
                           double* ascent, double* descent, double* left, double* width) {
  if (para == NULL || idx < 0) return 0;
  using namespace skia::textlayout;
  std::vector<LineMetrics> lm;
  ((Paragraph*)para)->getLineMetrics(lm);
  int n = (int)lm.size();
  if (idx >= n) {
    // An empty field still has one line (AIR: numLines == 1) and reports the
    // default format's font metrics with width 0 -- Skia has no line box to read
    // then, so fall back to the AIR model of the face the field is set in.
    if (idx != 0 || n != 0) return 0;
    SkAirLineMetrics am = sk_air_line_metrics(family, size, bold, italic);
    if (am.model <= 0.0) return 0;
    if (ascent) *ascent = am.asc;
    if (descent) *descent = am.desc;
    if (left) *left = 0.0;
    if (width) *width = 0.0;
    return 1;
  }
  double stride = (n > 1) ? (lm[n - 1].fBaseline - lm[0].fBaseline) / (double)(n - 1)
                          : (double)((Paragraph*)para)->getHeight();
  LineMetrics& m = lm[idx];
  double asc = (double)m.fBaseline - (double)idx * stride - leading;
  double desc = stride - leading - asc;
  if (leading < 0.0) {
    // A negative leading is folded into the strut height (Skia clamps
    // StrutStyle::leading to 0), which drags the baseline up with it -- the
    // stride-derived split then drifts (Monaco 12, leading -3: 12.6/2.4 instead
    // of AIR's 12/3). AIR keeps ascent/descent independent of the leading, so for
    // this one case take the AIR model of the face directly (measured,
    // temp/metricprobe/Lead7.as: asc 12 / desc 3 at every leading).
    SkAirLineMetrics am = sk_air_line_metrics(family, size, bold, italic);
    if (am.model > 0.0) {
      asc = am.asc;
      desc = am.desc;
    }
  }
  if (ascent) *ascent = asc;
  if (descent) *descent = desc;
  if (left) *left = (double)m.fLeft;
  if (width) *width = (double)m.fWidth;
  return 1;
}

void sk_textlayout_paint(void* para, void* canvas, double x, double y) {
  ((skia::textlayout::Paragraph*)para)->paint((SkCanvas*)canvas, (SkScalar)x, (SkScalar)y);
}

void sk_textlayout_delete(void* para) {
  delete (skia::textlayout::Paragraph*)para;
}

// ---------- image -> PNG ----------

int sk_image_encode_png(void* image, const char* path) {
  auto data = SkPngEncoder::Encode(nullptr, (SkImage*)image, {});
  if (!data) return 0;
  FILE* f = fopen(path, "wb");
  if (!f) return 0;
  size_t n = fwrite(data->data(), 1, data->size(), f);
  fclose(f);
  return (int)n;
}

void sk_image_delete(void* image) { ((SkImage*)image)->unref(); }

}  // extern "C"
