// skia_glue.cc — the C++ -> C bridge for the Skia raster backend (GRAPHICS half).
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
// THE FILE IS ONE HALF OF A DELIBERATE SPLIT (stage 221). Everything that needs
// the text engine -- SkParagraph, skunicode, HarfBuzz, the 9.71 MB ICU data blob
// inside libicu.a -- lives in vendor/skia_text_glue.cc instead, because a single
// object file is linked WHOLE: as long as one object referenced
// skia::textlayout::*, every binary that linked this glue dragged the entire
// shaping stack in, including programs that never draw a glyph (measured: a
// Graphics-only app and a TextField app were both 19.43 MB).
//
// Split, the halves are separate link units and the build can leave the text half
// out. src/index.ts::usesTextEngine makes that call from the program's own
// sources (plus the SWC bake, whose text characters are real TextFields), and it
// adds vendor/skia_text_glue.cc to the sources and ASC_HAVE_TEXT to the defines
// in ONE branch -- never one without the other. The seam in src/runtime.ts then
// resolves to the glue or to no-ops; the no-op arm warns on stderr the first time
// a TextField tries to lay something out, so a wrong verdict is loud, never a
// silent downgrade. Measured on the same no-text program: 19.43 MB -> 6.53 MB.
//
// What did NOT move: the platform font manager (SkFontMgr_New_CoreText / GDI /
// Custom_Data). It is a graphics-layer service as much as a text one -- the SVG
// rasterizer (ASC_USE_SVG) hands it to SkSVGDOM for <text>, and the web build's
// font injection (sk_fontmgr_register_data, exported to JS) feeds it -- so it
// stays here, at file scope and with C++ linkage, declared in
// skia_glue_internal.h for the text half to call.
//
// This is the minimal closed loop for stage 36: offscreen CPU raster -> PNG.

#include "include/core/SkSurface.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkRRect.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkStrokeRec.h"
#include "include/core/SkImage.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkData.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkSpan.h"
#include "include/core/SkString.h"
#include "include/core/SkFontStyle.h"
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
// Windows font backends: GDI for family/style resolution, DirectWrite for the
// per-character fallback tier (see SkAirFontMgr below). Both factories live in
// SkTypeface_win.h, exposed under SK_BUILD_FOR_WIN (which SkFeatures.h derives
// from _WIN32); the mac_ct port below is CoreText-only and cannot compile for
// Windows. SkStream.h is here (rather than only in the SVG block further down)
// because SkAirFontMgr forwards SkFontMgr::makeFromStream's
// unique_ptr<SkStreamAsset> parameter, and moving/destroying it needs the
// complete type.
#include "include/core/SkStream.h"
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

// Shared with the text half (vendor/skia_text_glue.cc): the platform font
// manager. C++ linkage on purpose -- sk_sp<SkFontMgr> cannot cross an
// extern "C" boundary.
#include "skia_glue_internal.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <new>
#include <vector>

// ---------- C++ allocation failure -> AS3 Error #1000 (阶段二百八十) ----------
//
// A 32-bit process runs out of ADDRESS SPACE long before it runs out of RAM, and
// Skia/STL answer an allocation they cannot satisfy by throwing std::bad_alloc.
// The generated C has no handler for a C++ exception, so it reaches
// std::terminate -- which on Windows is abort(): __fastfail(7), exit code
// 0xC0000409, no AS3 error, no chance to catch anything. That is exactly what the
// stage-二百八十 dump shows (fault in _abort+0x29 with __CxxThrowException and the
// std::bad_alloc type descriptor still on the stack, because terminate runs from
// the handler search and never unwinds the frames).
//
// This file is the only place C++ is linked into the program, so the replacement
// belongs here: the global operator new asks the runtime what to do instead of
// throwing. The runtime answers with a collection-and-retry (1) or by raising
// Error #1000 (never returns) -- AIR's kOutOfMemoryError, which AS3 can catch.
//
// Boundary, deliberately: only the ordinary new/new[] are replaced. C++17
// over-aligned allocation (operator new(size, align_val_t)) and the nothrow forms
// still come from the CRT -- nothing in this link set heap-allocates a type whose
// alignment exceeds __STDCPP_DEFAULT_NEW_ALIGNMENT__, and a nothrow new that
// cannot fail never returns null (it either succeeds or the hook raises).
static int (*g_cxx_oom_hook)(size_t) = NULL;
// ASC_FORCE_CXX_OOM (read by sk_set_oom_hook) makes the first allocation after
// startup fail on purpose, so the path can be tested where memory is plentiful.
static int g_cxx_oom_force_left = 0;

static void sk_cxx_oom_no_hook(size_t need) {
    // No runtime hook: a C++-only link (unit probe) or an allocation made before
    // main installed it. There is no AS3 error to raise, so report and stop --
    // this is the abort the platform would have performed anyway, now with a
    // message that names the cause.
    fprintf(stderr, "[as3-aot] out of memory: C++ operator new failed for %lu bytes "
                    "(no runtime OOM hook installed)\n", (unsigned long)need);
    fflush(stderr);
    abort();
}

static void* sk_cxx_alloc(size_t n) {
    for (;;) {
        if (g_cxx_oom_force_left > 0) {
            g_cxx_oom_force_left--;
        } else {
            void* p = std::malloc(n != 0 ? n : 1);
            if (p != NULL) return p;
        }
        if (g_cxx_oom_hook == NULL) sk_cxx_oom_no_hook(n);
        if (g_cxx_oom_hook(n) == 0) sk_cxx_oom_no_hook(n);
        // else: the runtime freed something, so try the allocation again
    }
}

void* operator new(std::size_t n) { return sk_cxx_alloc(n); }
void* operator new[](std::size_t n) { return sk_cxx_alloc(n); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

extern "C" void sk_set_oom_hook(int (*hook)(size_t)) {
    g_cxx_oom_hook = hook;
    const char* force = std::getenv("ASC_FORCE_CXX_OOM");
    if (force != NULL && force[0] != '0') g_cxx_oom_force_left = 1;
}

// ---------- platform font manager (shared with the text engine) ----------

// Platform font manager: CoreText on native macOS (enumerates installed
// families, expensive to construct — hence the cache); a custom FreeType
// manager on web/wasm, fed by runtime-injected font byte streams (there is no
// system font to enumerate in the sandbox).
//
// This is the ONE symbol both halves of the glue share (see skia_glue_internal.h):
// the text engine resolves every family through it, and the SVG rasterizer below
// hands it to SkSVGDOM so <text> inside an SVG renders with platform faces.
// It stays in the graphics half because the SVG path and the web font-injection
// entry point (sk_fontmgr_register_data) need it even when no TextField exists.
#ifdef __EMSCRIPTEN__
static std::vector<sk_sp<SkData>> g_font_datas;
static sk_sp<SkFontMgr> g_fontmgr_cache;

sk_sp<SkFontMgr> sk_platform_fontmgr() {
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
// Windows font manager: GDI for naming, DirectWrite for per-character fallback.
//
// GDI cannot do per-character font fallback AT ALL, and that is a rendering
// correctness hole, not a nicety: SkFontMgrGDI overrides
// onMatchFamilyStyleCharacter to an unconditional `return nullptr` (see
// src/ports/SkFontHost_win.cpp ~2267), and Windows' GDI port has no system
// cascade to fall back on the way CoreText has on macOS. SkParagraph asks the
// manager for a fallback face for EVERY code point the run's own face does not
// map, so when the field's family is one GDI's table cannot match — e.g. the
// Chinese family name "微软雅黑", which an en-US UI locale exposes only as
// "Microsoft YaHei" — the resolved face is the Latin-only default and every
// character of the field renders as .notdef: a whole field of identical boxes,
// not a stray one (measured: temp/fntface, where the 微软雅黑 row and the
// deliberately bogus-family row drew the same .notdef for 创建会议).
//
// So the manager is a GDI primary with DirectWrite appended as the fallback
// tier, and BOTH the name query and the character query cross over (the
// character query always, the name query only when GDI misses). Every name/style
// call still goes to GDI FIRST, so no family that resolves today changes face.
//
// The name-query cross-over is what fixes the Chinese family names. GDI's family
// table exposes each family under its ENGLISH face name only -- the localized
// name is what GDI reports back, not what it matches on -- so a field whose
// DefineEditText says 微软雅黑 (what a zh-CN skin carries) missed, fell through to
// the default face, and Windows' GDI default is a MONOSPACE face (measured:
// 10x'W'/10x'i'/10x'm' all 80 px), so a whole button read like a typewriter.
// DirectWrite's IDWriteFontCollection::FindFamilyName DOES match localized family
// names, but its metrics are unhinted and do not match AIR's: measured on this
// machine at size 12, DirectWrite's Microsoft YaHei measures 122.109/31.934/
// 112.441 for 10x'W'/10x'i'/10x'm' where GDI -- and adl 51.4.1, which uses the
// GDI path -- reports 120/30/110. So DirectWrite is used as a NAME TRANSLATOR,
// not as the face source: resolve the localized name there, read the typeface's
// English family name (Skia returns entry 0 of the font's name table, en-US for
// every system font that ships one), and ask GDI again with that.
//
// Measured on adl 51.4.1 + temp/fontprobe (both sides, same machine):
//   微软雅黑       AIR 120/30/110   ours before 80/80/80   after 120/30/110
//   微软雅黑 Light AIR 120/30/110   ours before 80/80/80   after 120/30/110
//   1095 Uninstalled family AIR 110/30/90 -- see sk_family_alias, which now
//   lands there instead of on the monospace default.
//
// "微软雅黑 Light" needs one extra step: it is not a DirectWrite family at all
// (this Windows registers the Light face as its own GDI family, "Microsoft YaHei
// Light", with the localized name 微软雅黑 Light), so the base name is translated
// and the style word appended back before GDI is asked. AIR reports the same
// 120/30/110 for the Light family as for the regular one, so falling back to the
// base family would be observationally identical -- the appended-style lookup is
// tried first only because it is the exact face the skin asked for.
//
// DirectWrite's own IDWriteFontFallback::MapCharacters cascade — the one
// DirectWrite-based browsers use, and the closest thing to what AIR does for a
// code point the run's face lacks — answers the character query. Skia reaches
// DirectWrite through LoadLibraryW("dwrite.dll")/GetProcAddress
// (src/utils/win/SkDWrite.cpp), so this adds no link dependency to any manifest.
//
// NOTE the earlier probe that reported DirectWrite faces as unrenderable
// (textHeight -Infinity) was a MIXED paragraph: the strut still named the
// unresolvable family while a DWrite face supplied the glyphs. Once the same
// face is used for the strut, the runs and the typeface (which is what the
// alias + this cross-over ensure), the paragraph lays out normally.
class SkAirFontMgr : public SkFontMgr {
public:
  SkAirFontMgr(sk_sp<SkFontMgr> primary, sk_sp<SkFontMgr> fallback)
      : fPrimary(std::move(primary)), fFallback(std::move(fallback)) {}

protected:
  int onCountFamilies() const override { return fPrimary->countFamilies(); }
  void onGetFamilyName(int index, SkString* familyName) const override {
    fPrimary->getFamilyName(index, familyName);
  }
  sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {
    return fPrimary->createStyleSet(index);
  }
  sk_sp<SkFontStyleSet> onMatchFamily(const char familyName[]) const override {
    // SkParagraph resolves a TextStyle's family through THIS call (FontCollection
    // ::matchTypeface asks for a style set and then matchStyle), not through
    // matchFamilyStyle -- so the localized-name translation must live here too:
    // returning GDI's empty set for 微软雅黑 made the paragraph skip the family
    // entirely and render with the legacy default face.
    sk_sp<SkFontStyleSet> set = fPrimary->matchFamily(familyName);
    if (set && set->count() > 0) return set;
    SkString alt[2];
    int n = this->airFamilyNames(familyName, alt);
    for (int i = 0; i < n; i++) {
      sk_sp<SkFontStyleSet> g = fPrimary->matchFamily(alt[i].c_str());
      if (g && g->count() > 0) return g;
    }
    // Last resort: DirectWrite's own collection (localized names, unhinted
    // metrics -- see the class comment for why GDI is preferred).
    if (fFallback != nullptr) {
      sk_sp<SkFontStyleSet> fb = fFallback->matchFamily(familyName);
      if (fb && fb->count() > 0) return fb;
    }
    return set;
  }
  sk_sp<SkTypeface> onMatchFamilyStyle(const char familyName[],
                                      const SkFontStyle& style) const override {
    return this->matchAir(familyName, style);
  }
  // The one query GDI answers with nullptr for every code point.
  sk_sp<SkTypeface> onMatchFamilyStyleCharacter(const char familyName[], const SkFontStyle& style,
                                               const char* bcp47[], int bcp47Count,
                                               SkUnichar character) const override {
    if (auto tf = fPrimary->matchFamilyStyleCharacter(familyName, style, bcp47, bcp47Count,
                                                      character)) {
      return tf;
    }
    return fFallback->matchFamilyStyleCharacter(familyName, style, bcp47, bcp47Count, character);
  }
  // Typeface-from-data/file never comes from the fallback tier: those paths mean
  // "this exact font file", which is what a stream/file query is about.
  sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data, int ttcIndex) const override {
    return fPrimary->makeFromData(std::move(data), ttcIndex);
  }
  sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,
                                          int ttcIndex) const override {
    return fPrimary->makeFromStream(std::move(stream), ttcIndex);
  }
  sk_sp<SkTypeface> onMakeFromStreamArgs(std::unique_ptr<SkStreamAsset> stream,
                                         const SkFontArguments& args) const override {
    return fPrimary->makeFromStream(std::move(stream), args);
  }
  sk_sp<SkTypeface> onMakeFromFile(const char path[], int ttcIndex) const override {
    return fPrimary->makeFromFile(path, ttcIndex);
  }
  sk_sp<SkTypeface> onLegacyMakeTypeface(const char familyName[],
                                         SkFontStyle style) const override {
    return fPrimary->legacyMakeTypeface(familyName, style);
  }

private:
  // The style words AIR's own lookup accepts as part of a family name. A GDI
  // family named "Microsoft YaHei Light" is spelled that way, while the same
  // face's localized name is 微软雅黑 Light -- and DirectWrite has no family under
  // either spelling on this Windows (it registers the Light face inside the
  // Microsoft YaHei family). Measured: matchFamilyStyle("Microsoft YaHei Light")
  // on DirectWrite returns nullptr, on GDI 120/30/110.
  static bool isStyleWord(const char* w) {
    static const char* const kWords[] = {
        "Light", "Bold", "Italic", "Oblique", "Regular", "Normal", "Medium",
        "SemiBold", "Semibold", "DemiBold", "Demi", "Black", "Heavy", "Thin",
        "ExtraLight", "Extralight", "UltraLight", "ExtraBold", "Book",
    };
    for (const char* k : kWords) {
      if (strcmp(w, k) == 0) return true;
    }
    return false;
  }

  // English family name of a family DirectWrite can name, or false.
  bool englishFamilyName(const char* familyName, SkString* out) const {
    if (fFallback == nullptr) return false;
    sk_sp<SkTypeface> dw = fFallback->matchFamilyStyle(familyName, SkFontStyle());
    if (dw == nullptr) return false;
    dw->getFamilyName(out);
    return out->size() > 0 && strcmp(out->c_str(), familyName) != 0;
  }

  // The spellings of `familyName` that GDI can actually MATCH, in preference
  // order, for a name GDI itself could not name. DirectWrite indexes localized
  // family names, so it is used here purely as a localized->English translator
  // (its own metrics are unhinted and do not match AIR's, see the class comment).
  // Returns 0 for a name no tier can resolve -- which is what keeps
  // sk_family_alias's "not installed" test meaningful.
  int airFamilyNames(const char* familyName, SkString out[2]) const {
    if (fFallback == nullptr || familyName == nullptr) return 0;
    // (a) DirectWrite knows the name as given: use its English family name.
    if (sk_sp<SkTypeface> dw = fFallback->matchFamilyStyle(familyName, SkFontStyle())) {
      SkString en;
      dw->getFamilyName(&en);
      if (en.size() > 0 && strcmp(en.c_str(), familyName) != 0) {
        out[0] = en;
        return 1;
      }
      return 0;  // same spelling: GDI has nothing else to try
    }
    // (b) "<localized base> <style word>": translate the base and re-append the
    // style (the exact face GDI knows), with the base alone as the last try.
    const char* sp = strrchr(familyName, ' ');
    if (sp == nullptr || sp[1] == 0 || !isStyleWord(sp + 1)) return 0;
    SkString base(familyName, (size_t)(sp - familyName));
    SkString en;
    if (!this->englishFamilyName(base.c_str(), &en)) return 0;
    out[0] = en;
    out[0].append(" ");
    out[0].append(sp + 1);
    out[1] = en;
    return 2;
  }

  // GDI first (unchanged faces for every family it can name), then the
  // localized-name translation described in the class comment. Only a real miss
  // in every step returns nullptr.
  sk_sp<SkTypeface> matchAir(const char* familyName, const SkFontStyle& style) const {
    if (familyName == nullptr) return fPrimary->matchFamilyStyle(familyName, style);
    if (sk_sp<SkTypeface> g = fPrimary->matchFamilyStyle(familyName, style)) return g;
    SkString alt[2];
    int n = this->airFamilyNames(familyName, alt);
    for (int i = 0; i < n; i++) {
      if (sk_sp<SkTypeface> g = fPrimary->matchFamilyStyle(alt[i].c_str(), style)) return g;
    }
    // DirectWrite's own face only when GDI cannot name any translation.
    if (fFallback != nullptr) return fFallback->matchFamilyStyle(familyName, style);
    return nullptr;
  }

  sk_sp<SkFontMgr> fPrimary;
  sk_sp<SkFontMgr> fFallback;
};

sk_sp<SkFontMgr> sk_platform_fontmgr() {
  // GDI enumerates the Windows system font collection (the analogue of CoreText
  // on macOS). Cached for the same reason as the CoreText path: construction
  // walks the whole installed family list and must not repeat per draw call.
  static sk_sp<SkFontMgr> cached = []() -> sk_sp<SkFontMgr> {
    sk_sp<SkFontMgr> gdi = SkFontMgr_New_GDI();
    sk_sp<SkFontMgr> dw = SkFontMgr_New_DirectWrite();
    if (!gdi || !dw) return gdi ? gdi : dw;  // no fallback tier: GDI as before
    return sk_sp<SkFontMgr>(new SkAirFontMgr(std::move(gdi), std::move(dw)));
  }();
  return cached;
}
#else
sk_sp<SkFontMgr> sk_platform_fontmgr() {
  static sk_sp<SkFontMgr> cached = SkFontMgr_New_CoreText(nullptr);
  return cached;
}
#endif

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
  // kSrc, NOT Skia's default kSrcOver: AIR composites the Stage3D back buffer with
  // its alpha channel ignored (see sk_gpu_draw_texture in d3d_glue.cc for the adl
  // measurement). Without this, Starling's ERASE mode -- which zeroes RGB *and*
  // alpha -- lets the stage colour through and the Blend Modes demo draws a white
  // rocket silhouette where AIR draws a black one.
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  ((SkCanvas*)canvas)->drawImageRect(img.get(), dst, SkSamplingOptions(), &paint);
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

// The byte order of a raster surface's pixels, for a host that has to declare the
// format to a 32-bit blitter. This is NOT a property of our code but of the Skia
// BUILD: SkTypes.h defaults SK_R32_SHIFT to 16 (=> bytes B,G,R,A) on Windows and to
// 0 (=> bytes R,G,B,A) everywhere else, and the vendored archive is a Windows build.
// A caller that hardcodes the macOS answer therefore paints every Windows frame with
// red and blue swapped -- measured: #2563EB blue arrived as #EB6325 orange in a
// CPU-mode window (temp/colorprobe/, and the same surface reports colorType 6).
// Derived from the same SkPixmap peeking hands out, so it cannot drift from the
// buffer the caller is about to blit, even if SK_R32_SHIFT is overridden at build
// time.
// Returns 1 = bytes R,G,B,A; 2 = bytes B,G,R,A; 0 = not a 32-bit RGBA/BGRA raster.
int sk_surface_pixel_order(void* surface) {
  SkPixmap pm;
  if (surface == nullptr || !((SkSurface*)surface)->peekPixels(&pm)) return 0;
  switch (pm.colorType()) {
    case kRGBA_8888_SkColorType: return 1;
    case kBGRA_8888_SkColorType: return 2;
    default: return 0;
  }
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
// Frame-start hygiene for a canvas that outlives one frame (the cached GPU back-buffer
// canvas). A save/scale pair leaked by an exception unwinding out of the renderer would
// otherwise COMPOUND frame over frame -- measured 1.0 -> 1.5 -> 2.25 -> 3.375 on the window
// canvas, i.e. the whole picture grows without bound after every AS3 error thrown mid-frame.
void sk_canvas_reset(void* canvas) {
  SkCanvas* c = (SkCanvas*)canvas;
  if (c == nullptr) return;
  c->restoreToCount(1);
  c->resetMatrix();
}
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

// Where the canvas LOCAL ORIGIN lands in its own device pixels -- the second
// half of the transform that sk_canvas_total_scale reports. A device pixel is
// the unit a baked image is blitted in, so "which grid is this surface on" is a
// question about this translation, not about the object coordinates: inside a
// parent bake (or under any parent with a fractional position, e.g. a 1.5 device
// scale), local 0 sits on a fractional device pixel and a grid computed from the
// object own x/y is off by that fraction. Used by as_render_cached origin snap
// (emit.ts).
void sk_canvas_total_translate(void* canvas, double* tx, double* ty) {
  const SkMatrix& m = ((SkCanvas*)canvas)->getTotalMatrix();
  *tx = (double)m.getTranslateX();
  *ty = (double)m.getTranslateY();
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
// Graphics.drawEllipse: AIR's ellipse inscribed in the (x, y, width, height)
// rectangle. A negative width/height mirrors the rectangle, which for a symmetric
// oval is the same outline, so the caller normalizes before calling this.
void sk_path_add_oval(void* path, double x, double y, double w, double h) {
  ((SkPath*)path)->addOval(SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h));
}
// Graphics.drawRoundRect: the four corners are quarter ellipses with radii
// (rx, ry) INSIDE the (x, y, w, h) rectangle -- SkRRect's MakeRectXY is exactly
// that. The radius clamp (each pair to half the box) and the swap for a negative
// w/h happen in the caller, because AIR's clamping is part of the AS3 contract
// and must hold on the no-Skia path too (where this function does not exist).
void sk_path_add_rrect(void* path, double x, double y, double w, double h,
                       double rx, double ry) {
  ((SkPath*)path)->addRRect(SkRRect::MakeRectXY(
      SkRect::MakeXYWH((SkScalar)x, (SkScalar)y, (SkScalar)w, (SkScalar)h),
      (SkScalar)rx, (SkScalar)ry));
}
void sk_path_close(void* path) { ((SkPath*)path)->close(); }
// Close EVERY contour of a path. A SWF shape outline is a closed figure by
// definition, but the SWF edge records spell that out only as "the last point
// coincides with the first" -- there is no close verb in the format, so our
// emitter produces `move_to, line_to, ...` with no kClose (Skia fills an open
// contour implicitly, so fills looked right). Skia's AA CLIPPER does not: an
// unclosed contour contributes no area, so a clip path built from it clips the
// whole region away -- every clipDepth-masked sibling (the app's banner and
// whatever else the skin masks) rendered blank. Measured on the TalkMED login
// skin: mask #346 (a 36.25x18.5 rect) as a clip left the banner empty, the same
// outline with the closing verb restored rendered it. `close()` alone only
// closes the LAST contour, hence this per-contour rewrite.
void sk_path_close_all(void* path) {
  SkPath* p = (SkPath*)path;
  if (p->countVerbs() == 0) return;
  SkPath out;
  out.setFillType(p->getFillType());
  SkPath::Iter it(*p, false);
  SkPoint pts[4];
  SkPath::Verb v;
  bool open = false;
  while ((v = it.next(pts)) != SkPath::kDone_Verb) {
    switch (v) {
      case SkPath::kMove_Verb:
        if (open) out.close();
        out.moveTo(pts[0]);
        open = true;
        break;
      case SkPath::kLine_Verb: out.lineTo(pts[1]); break;
      case SkPath::kQuad_Verb: out.quadTo(pts[1], pts[2]); break;
      case SkPath::kConic_Verb: out.conicTo(pts[1], pts[2], it.conicWeight()); break;
      case SkPath::kCubic_Verb: out.cubicTo(pts[1], pts[2], pts[3]); break;
      case SkPath::kClose_Verb: out.close(); open = false; break;
      default: break;
    }
  }
  if (open) out.close();
  *p = out;
}
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

// Draw an image scaled into a destination rect. `smooth` is Bitmap.smoothing:
// AIR's default is false, which is nearest-neighbour (a scaled-up 2x sprite keeps
// hard pixel edges, adl-verified), and true is bilinear. Same pairing as
// sk_paint_set_bitmap_shader below, so the two bitmap paths cannot drift apart.
// Before stage 230 the flag was ignored and every Bitmap was nearest: the meeting
// client sets smoothing=true on its slide bitmaps and the nearest blit turned a
// half-pixel scale wobble into a visible sharp/mushy flicker.
void sk_canvas_draw_image_rect(void* canvas, void* image,
                               double dx, double dy, double dw, double dh, int smooth) {
  SkRect dst = SkRect::MakeXYWH((SkScalar)dx, (SkScalar)dy, (SkScalar)dw, (SkScalar)dh);
  const SkSamplingOptions so =
      smooth ? SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNearest)
             : SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
  ((SkCanvas*)canvas)->drawImageRect((SkImage*)image, dst, so);
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
  // kSrc, NOT Skia's default kSrcOver: AIR composites the Stage3D back buffer with
  // its alpha channel ignored (see sk_gpu_draw_texture in d3d_glue.cc for the adl
  // measurement). Without this, Starling's ERASE mode -- which zeroes RGB *and*
  // alpha -- lets the stage colour through and the Blend Modes demo draws a white
  // rocket silhouette where AIR draws a black one.
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  ((SkCanvas*)canvas)->drawImageRect(image.get(), dst, SkSamplingOptions(), &paint);
}


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
