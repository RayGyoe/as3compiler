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
#include "include/core/SkImage.h"
#include "include/core/SkData.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkSpan.h"
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
#include "include/gpu/ganesh/gl/GrGLMakeWebGLInterface.h"
#include "include/gpu/ganesh/gl/GrGLDirectContext.h"
#include "include/gpu/ganesh/gl/GrGLBackendSurface.h"
#else
#include "include/ports/SkFontMgr_mac_ct.h"
#endif
#include "include/effects/SkGradientShader.h"
#include "include/effects/SkImageFilters.h"
#include "include/core/SkColorFilter.h"
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

// Intersect the current clip with a rectangle — used by TextField to keep
// wrapped lines inside the field box when the text is scrolled (stage 44).
void sk_canvas_clip_rect(void* canvas, double x, double y, double w, double h) {
  ((SkCanvas*)canvas)->clipRect(
      SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h));
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

void sk_paint_set_alpha(void* paint, double alpha) {
  ((SkPaint*)paint)->setAlpha((uint8_t)(alpha * 255.0));
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

// ---------- image filters (stage 61: DisplayObject.filters rendering) ----------

// Each filter is attached to a SkPaint whose only role is carrying the
// SkImageFilter into SkCanvas::saveLayer. The generated C wraps an object's
// whole drawn subtree in such a layer so the filter sees the composited pixels,
// matching AS3's "filter the DisplayObject" semantics (not a single paint).

void sk_paint_set_image_filter_blur(void* paint, double sigmaX, double sigmaY) {
  auto f = SkImageFilters::Blur((SkScalar)sigmaX, (SkScalar)sigmaY, nullptr);
  ((SkPaint*)paint)->setImageFilter(std::move(f));
}

void sk_paint_set_image_filter_drop_shadow(void* paint, double dx, double dy,
                                           double sigmaX, double sigmaY,
                                           unsigned rgb, double alpha) {
  SkColor c = sk_argb(rgb, alpha);
  auto f = SkImageFilters::DropShadow((SkScalar)dx, (SkScalar)dy,
                                      (SkScalar)sigmaX, (SkScalar)sigmaY, c, nullptr);
  ((SkPaint*)paint)->setImageFilter(std::move(f));
}

// Outer glow: recolor the object's alpha silhouette to the glow color (RGB
// replaced by the glow color, alpha scaled by the filter's alpha), then blur it.
// The caller draws the unfiltered body on top afterwards, so only the blurred
// fringe peeks out around the edge — exactly what an outer GlowFilter shows.
void sk_paint_set_image_filter_glow(void* paint, double sigmaX, double sigmaY,
                                    unsigned rgb, double alpha) {
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
  ((SkPaint*)paint)->setImageFilter(std::move(blur));
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

void* sk_image_from_file(const char* path) {
  auto data = SkData::MakeFromFileName(path);
  if (!data) return nullptr;
  // m124: SkImage::MakeFromEncoded -> SkImages::DeferredFromEncodedData.
  auto image = SkImages::DeferredFromEncodedData(data);
  return image.release();  // caller owns one ref (or NULL on decode failure)
}

void sk_canvas_draw_image_rect(void* canvas, void* image,
                               double dx, double dy, double dw, double dh) {
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  ((SkCanvas*)canvas)->drawImageRect((SkImage*)image, dst, SkSamplingOptions());
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
#else
static sk_sp<SkFontMgr> sk_platform_fontmgr() {
  static sk_sp<SkFontMgr> cached = SkFontMgr_New_CoreText(nullptr);
  return cached;
}
#endif

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
  if (family && family[0]) ts.setFontFamilies({ SkString(family) });

  ParagraphStyle ps;
  ps.setTextStyle(ts);
  ps.setTextAlign((TextAlign)align);
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string collapsed;
  const char* t = text;
  if (collapseNewlines && strchr(text, '\n')) {
    collapsed.assign(text);
    for (auto& c : collapsed) if (c == '\n') c = ' ';
    t = collapsed.c_str();
  }
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
  if (family && family[0]) ts.setFontFamilies({ SkString(family) });

  ParagraphStyle ps;
  ps.setTextStyle(ts);
  ps.setTextAlign((TextAlign)align);
  if (leading > 0.0) {
    StrutStyle strut;
    strut.setStrutEnabled(true);
    strut.setFontSize((SkScalar)size);
    strut.setLeading((SkScalar)leading);
    strut.setForceStrutHeight(true);
    if (family && family[0]) strut.setFontFamilies({ SkString(family) });
    ps.setStrutStyle(strut);
  }
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string collapsed;
  const char* t = text;
  if (collapseNewlines && strchr(text, '\n')) {
    collapsed.assign(text);
    for (auto& c : collapsed) if (c == '\n') c = ' ';
    t = collapsed.c_str();
  }
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
    if (r.family && r.family[0]) ts.setFontFamilies({ SkString(r.family) });
    return ts;
  };

  ParagraphStyle ps;
  ps.setTextStyle(mkStyle(runs[0]));
  ps.setTextAlign((TextAlign)align);
  // Uniform paragraph leading from the first run that sets it.
  for (int i = 0; i < run_count; i++) {
    if (runs[i].leading > 0.0) {
      StrutStyle strut;
      strut.setStrutEnabled(true);
      strut.setFontSize((SkScalar)runs[i].size);
      strut.setLeading((SkScalar)runs[i].leading);
      strut.setForceStrutHeight(true);
      if (runs[i].family && runs[i].family[0]) strut.setFontFamilies({ SkString(runs[i].family) });
      ps.setStrutStyle(strut);
      break;
    }
  }
  auto builder = ParagraphBuilder::make(ps, sk_textlayout_collection());

  std::string collapsed;
  const char* t = text;
  if (collapseNewlines && strchr(text, '\n')) {
    collapsed.assign(text);
    for (auto& c : collapsed) if (c == '\n') c = ' ';
    t = collapsed.c_str();
  }

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
int sk_textlayout_rects_for_range(void* para, int start, int end,
                                  double* lefts, double* tops, double* rights, double* bottoms,
                                  int max_rects) {
  if (para == NULL || max_rects <= 0) return 0;
  using namespace skia::textlayout;
  auto p = (Paragraph*)para;
  auto boxes = p->getRectsForRange((unsigned)start, (unsigned)end,
                                   RectHeightStyle::kTight, RectWidthStyle::kTight);
  int n = 0;
  for (auto& b : boxes) {
    if (n >= max_rects) break;
    lefts[n] = (double)b.rect.fLeft;
    tops[n] = (double)b.rect.fTop;
    rights[n] = (double)b.rect.fRight;
    bottoms[n] = (double)b.rect.fBottom;
    n++;
  }
  return n;
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
