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
#include "include/ports/SkFontMgr_mac_ct.h"
#include "include/effects/SkGradientShader.h"
#include "include/effects/SkImageFilters.h"
#include "include/core/SkColorFilter.h"
#include "include/encode/SkPngEncoder.h"

#include <cstdio>
#include <cstdint>
#include <cstring>

extern "C" {

// ---------- surface ----------

void* sk_surface_raster_new(int width, int height) {
  // m124 moved the factory off SkSurface into the SkSurfaces namespace.
  auto surface = SkSurfaces::Raster(
      SkImageInfo::MakeN32Premul(width, height));
  return surface.release();  // caller owns one ref
}

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

// The CoreText font manager enumerates and sorts every installed font family on
// construction, so it must be created once, not per draw call: a multi-line
// TextField draws one string per line (plus one measure per word while wrapping),
// and doing that work per call made the window hang for tens of seconds on the
// first frame. The default typeface is cached the same way.
static const sk_sp<SkTypeface>& sk_default_typeface() {
  static sk_sp<SkTypeface> cached = []() -> sk_sp<SkTypeface> {
    sk_sp<SkFontMgr> mgr = SkFontMgr_New_CoreText(nullptr);
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
