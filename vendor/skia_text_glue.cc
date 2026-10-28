// skia_text_glue.cc — the TEXT half of the Skia glue layer: TextField typesetting.
//
// Split out of vendor/skia_glue.cc in stage 221 so that a build which draws no
// text does not link any of this. That matters because linking Skia's text stack
// is not incremental: every sk_textlayout_* entry point needs
// skia::textlayout::Paragraph, which lives in libskparagraph.a, which needs
// libskunicode.a + libharfbuzz.a + libicu.a, and libicu.a carries its whole
// unicode/CLDR/line-break dataset as ONE 9.71 MB object (libicu.icudtl_dat.o) --
// so the first resolved reference drags ~13 MB in (ICU data 9.71 MB + the rest).
//
// The rule this file exists to keep: NOTHING else in the glue may reference a
// SkParagraph symbol. Entry points here are the same flat extern "C" ones the
// generated C already calls (the 15-function seam documented in
// docs/zh-cn/rust-text-backend.md §1.1), so moving a function between the two
// files is invisible to the generated C -- the seam was always opaque.
//
// Which half a build links, and with which seam, is decided by
// src/index.ts::usesTextEngine from the program's own sources, because the
// decision has to be made BEFORE the generated C is compiled: ASC_HAVE_TEXT
// changes what the seam compiles to, so it cannot be inferred from the object
// afterwards. The detector is deliberately over-inclusive (the flash.text package
// OR any bare class name), and the failure mode is symmetric and loud either way:
// a false positive keeps the size a build had before the split, and a false
// negative warns on stderr the first time a TextField really lays out.

#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkString.h"
#include "include/core/SkFontStyle.h"

// SkParagraph (modules/skparagraph) is the full text-layout engine used for
// TextField's real typesetting (shaping via HarfBuzz, UAX#14 line breaking,
// per-line metrics, alignment, letter/word spacing). It lives in a separate
// library (libskparagraph.a) from core Skia, hence the module includes below.
#include "modules/skparagraph/include/Paragraph.h"
#include "modules/skparagraph/include/ParagraphBuilder.h"
#include "modules/skparagraph/include/ParagraphStyle.h"
#include "modules/skparagraph/include/TextStyle.h"
#include "modules/skparagraph/include/FontCollection.h"

// The platform font manager (CoreText / GDI+DirectWrite / Custom_Data) lives in
// the graphics half; this file only ever calls it.
#include "skia_glue_internal.h"

#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// ICU data: loaded by US, under OUR file name.
//
// Skia's own loader (third_party/icu/SkLoadICU.cpp, compiled into libskunicode)
// reads `icudtl.dat` beside the exe. That name is not ours to own: any
// Chromium-based runtime staged beside the same exe reads it too -- a browser
// control's CEF, whose renderer subprocess maps that exact path for its own,
// older ICU -- and one file cannot serve both. Measured both ways on this host
// (CEF 3.2987 vs Skia's ICU 69):
//
//   * Skia's 10,185,008 B set in that slot  -> every CEF renderer aborts ~250 ms
//     after start (libcef+0x404d7c, FATAL "unreachable code", raised by a failed
//     NumberFormat::createInstance) and the web view stays blank forever.
//   * CEF's 10,130,464 B set in that slot   -> CEF renders, but our own text loses
//     glyph runs (the FPS overlay draws its first line and drops the rest).
//
// So the data moves to `aot-icudtl.dat` (build.ts::deploySkiaIcuData) and this is
// the only thing that reads it. Supplying the symbol ourselves is what makes that
// work against PREBUILT archives: skunicode.lib's SkLoadICU.obj is pulled in only
// while the symbol is undefined, and this object is linked before the archives.
//
// `icudtl.dat` is still accepted as a fallback -- a tree built before this change
// deployed the data under the shared name -- but never preferred, and using it is
// reported, because in a CEF staging directory it is the other runtime's data.
// ---------------------------------------------------------------------------
#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdio>
#include <io.h>

// The two ICU entry points this loader needs, declared here instead of included
// from <unicode/udata.h> because the vendored tree ships no ICU headers (the
// archives are prebuilt). Signatures are ICU's, verbatim:
//   void udata_setCommonData(const void* data, UErrorCode* err);
//   void udata_setFileAccess(UDataFileAccess access, UErrorCode* status);
// UErrorCode is an int-sized enum, so the ABI is (pointer, int*) and (int, int*).
// UDATA_ONLY_PACKAGES == 1 (icu/source/common/unicode/udata.h).
extern "C" void udata_setCommonData(const void* data, int* err);
extern "C" void udata_setFileAccess(int access, int* status);

static const int kUdataOnlyPackages = 1;

static void* sk_aot_map_icu_data(const wchar_t* path) {
  struct FileCloser { void operator()(FILE* f) const { if (f) fclose(f); } };
  std::unique_ptr<FILE, FileCloser> stream(_wfopen(path, L"rb"));
  if (!stream) return nullptr;
  HANDLE file = (HANDLE)_get_osfhandle(_fileno(stream.get()));
  if (file == INVALID_HANDLE_VALUE) return nullptr;
  struct MapCloser { void operator()(HANDLE h) const { if (h) CloseHandle(h); } };
  std::unique_ptr<void, MapCloser> mapping(
      CreateFileMapping(file, nullptr, PAGE_READONLY, 0, 0, nullptr));
  if (!mapping) return nullptr;
  // Deliberately never unmapped: ICU keeps pointers into this range for the
  // lifetime of the process (Skia's own loader leaks it the same way).
  return MapViewOfFile(mapping.get(), FILE_MAP_READ, 0, 0, 0);
}

static bool sk_aot_init_icu(void* data) {
  if (data == nullptr) return false;
  int err = 0;  // U_ZERO_ERROR
  udata_setCommonData(data, &err);
  if (err > 0) {  // U_FAILURE(x) is (x) > U_ZERO_ERROR; negatives are warnings
    fprintf(stderr, "SkIcuLoader: udata_setCommonData() returned %d.\n", err);
    return false;
  }
  udata_setFileAccess(kUdataOnlyPackages, &err);
  return err <= 0;
}

// Fills `out` with the directory part of the module's path (no trailing '\\').
static bool sk_aot_module_dir(HMODULE module, std::wstring* out) {
  wchar_t buf[MAX_PATH];
  const DWORD n = GetModuleFileNameW(module, buf, (DWORD)MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return false;
  wchar_t* slash = wcsrchr(buf, L'\\');
  if (slash == nullptr) return false;
  *slash = 0;
  *out = buf;
  return true;
}

static bool sk_aot_load_dir(const std::wstring& dir, bool report) {
  // Our own name first; the historical shared name second, and loudly.
  struct Candidate { const wchar_t* name; bool shared; };
  static const Candidate kNames[] = { { L"\\aot-icudtl.dat", false }, { L"\\icudtl.dat", true } };
  for (const Candidate& c : kNames) {
    const std::wstring path = dir + c.name;
    if (void* data = sk_aot_map_icu_data(path.c_str())) {
      if (sk_aot_init_icu(data)) {
        if (c.shared) {
          // A legacy tree, or another runtime's data set in a shared directory.
          // Say which, every time: silent here is a text engine running on data
          // it was not built against.
          fprintf(stderr, "SkIcuLoader: %ls (shared name -- a rebuild deploys aot-icudtl.dat)\n",
                  path.c_str());
        }
        return true;
      }
    }
  }
  if (report) {
    fprintf(stderr, "SkIcuLoader: no ICU data in %ls (tried aot-icudtl.dat, icudtl.dat).\n",
            dir.c_str());
  }
  return false;
}

static std::wstring sk_aot_exe_dir() {
  std::wstring dir;
  return sk_aot_module_dir(GetModuleHandleW(nullptr), &dir) ? dir : std::wstring();
}

static std::wstring sk_aot_library_dir() {
  HMODULE self = nullptr;
  GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                     reinterpret_cast<LPCSTR>(&sk_aot_library_dir), &self);
  std::wstring dir;
  return sk_aot_module_dir(self, &dir) ? dir : std::wstring();
}

// Skia's own symbol (third_party/icu/SkLoadICU.h declares `bool SkLoadICU();` in
// the global namespace). Identical signature => identical mangled name => this
// definition wins and the archive's member is never read.
bool SkLoadICU() {
  static bool loaded = false;
  static std::once_flag once;
  std::call_once(once, []() {
    const std::wstring exe = sk_aot_exe_dir();
    if (!exe.empty() && sk_aot_load_dir(exe, true)) { loaded = true; return; }
    const std::wstring lib = sk_aot_library_dir();
    if (!lib.empty() && lib != exe && sk_aot_load_dir(lib, false)) loaded = true;
  });
  return loaded;
}

#endif  // _WIN32

extern "C" {

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
  // The alias already points an uninstalled family at the default one; this only
  // covers the default family itself missing the requested weight/slant (e.g.
  // bold of a family that ships Regular only). AIR keeps the family's own metrics
  // there, so taking the default face's box is the closer approximation.
  if (!tf && mgr) tf = mgr->matchFamilyStyle(nullptr, style);
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
  // the resulting box is exactly AIR's. The leading is folded into the height in
  // BOTH directions: AIR's box is ascent + descent + leading with an ascent /
  // descent split that ignores the leading, and StrutStyle::leading does not reach
  // the line box in this build (measured: a leading of 4 leaves a 2-line paragraph
  // at 2*model, so the box must be raised by the height instead); a negative
  // leading cannot go through StrutStyle::leading at all (Skia clamps it to 0 --
  // ParagraphImpl.cpp). sk_textlayout_line_box scales the split back out.
  strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));
  strut.setHeightOverride(true);
  strut.setForceStrutHeight(true);
  ps.setStrutStyle(strut);
  ps.setStrutStyle(strut);
}

// AIR's line box for ONE face, applied to a run through TextStyle::heightOverride:
// round_half(ascent) + round_half(descent) + leading (in px). A paragraph-wide
// StrutStyle can only force ONE box on every line, which is wrong as soon as runs
// carry different sizes -- measured on adl 51.4.1: a 12 px default plus one 24 px
// run gives line heights 13.975 / 27.950, not a uniform box, and the same probe
// shows the GAP between runs must be laid out in the defaultTextFormat's face
// (not runs[0]'s: with a _sans default the gap line reports _sans metrics even
// when runs[0] is _typewriter). Run::calculateMetrics() makes a run's
// ascent+descent equal height*fontSize and keeps the FACE's line gap as the line
// leading, so the height handed over is (box - lineGap)/size to land on AIR's box.
// Known residual: with leading != 0 Skia folds it into the ascent/descent ratio
// (AIR keeps the ascent independent of the leading), so a rich paragraph WITH an
// explicit leading can sit its baseline up to ~leading*asc/(asc+desc) low.
static void sk_set_air_run_height(skia::textlayout::TextStyle& ts, const char* family, double size,
                                  int bold, int italic, double leading) {
  using namespace skia::textlayout;
  SkAirLineMetrics am = sk_air_line_metrics(family, size, bold, italic);
  if (size <= 0.0 || am.model <= 0.0 || am.rawFull <= 0.0) return;
  // Run::calculateMetrics splits the face's own line gap half into the ascent and
  // half into the descent and then rescales BOTH by height*size/rawFull, so the
  // line box ends up exactly height*size (the gap is not added on top). AIR's box
  // for a run is its font model (ascent + descent) plus the TextFormat leading,
  // which has no knob of its own on a run -- fold it into the height.
  double h = am.model + leading;
  if (h <= 0.0) h = am.model + leading;        // degenerate face: best effort
  if (h <= 0.0) return;
  ts.setHeight((SkScalar)(h / size));
  ts.setHeightOverride(true);
  ts.setHalfLeading(false);
}

static const char* sk_family_alias(const char* family) {
  if (family == nullptr || family[0] == 0) return "Times";
  if (strcmp(family, "_typewriter") == 0) return "Monaco";
  if (strcmp(family, "_sans") == 0) return "Helvetica";
  if (strcmp(family, "_serif") == 0) return "Times New Roman";
  // A family that is NOT installed behaves like the platform default face in AIR,
  // not like the CJK face that happens to supply the glyphs. Measured on adl
  // 51.4.1 (temp/tfswc cases 6/9, both sides running the same Main.as): a field
  // whose family is "MiSans Regular" (not installed anywhere on the machine, but
  // shipped inside the app bundle -- AIR does NOT register app fonts) lays out a
  // 16 px line as 16 px, and "宋体" (also unresolvable: CoreText+Skia both return
  // NULL, only "Songti SC" exists) as 16 px too, i.e. Helvetica's box. We used to
  // hand the unresolvable name straight to Skia, which returns NULL and lets
  // SkParagraph size the line from whichever cascade face drew the CJK glyphs
  // (PingFang/Songti SC: 1.4 em -> 22 px at size 16, 20 px at 14). That 6 px made
  // the AI subtitle list item taller than adl and pushed its ctime down
  // (stage 168). Substituting the default family keeps the strut, the runs and
  // the typeface lookup on ONE face. Cached: the lookup walks the whole installed
  // family list, and CSS family names of a TextField never change at runtime.
  //
  // WHICH default face differs per platform: on macOS it is whatever CoreText
  // answers (Helvetica), on Windows AIR is Times while GDI's own default is a
  // monospace face -- see the _WIN32 branch below.
  static std::map<std::string, std::string> alias_cache;
  auto it = alias_cache.find(std::string(family));
  if (it != alias_cache.end()) return it->second.c_str();
  std::string resolved(family);
  sk_sp<SkFontMgr> mgr = sk_platform_fontmgr();
  if (mgr && !mgr->matchFamilyStyle(family, SkFontStyle())) {
#if defined(_WIN32)
    // AIR's Windows default face is Times (measured on adl 51.4.1,
    // temp/fontprobe: a bogus family "NoSuchFaceXYZ" lays out 10x'W'/10x'i'/
    // 10x'm' as 110/30/90, exactly the NULL-family row). We used to take
    // whatever the platform calls its default face -- and GDI's default on
    // Windows is a MONOSPACE face (80/80/80), i.e. every field with an
    // uninstalled family silently became a typewriter. The NULL-family branch
    // above already maps to "Times", so this makes both miss paths agree.
    resolved = "Times";
#else
    // macOS: the platform default face IS AIR's default (measured: an
    // unresolvable family -- "MiSans Regular", or "宋体" without Songti SC --
    // reports Helvetica's line box, which is what matchFamilyStyle(nullptr)
    // returns), so keep asking CoreText.
    sk_sp<SkTypeface> dflt = mgr->matchFamilyStyle(nullptr, SkFontStyle());
    if (dflt) {
      SkString n;
      dflt->getFamilyName(&n);
      if (n.size() > 0) resolved = n.c_str();
    }
#endif
  }
  return alias_cache.emplace(std::string(family), std::move(resolved)).first->second.c_str();
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
// ParagraphBuilder pushStyle/addText/pop.
//
// `defaultStyle` describes the FIELD's defaultTextFormat and is what AIR uses for
// everything the runs do not cover -- both the gaps between runs and the whole
// line box (measured on adl: see sk_set_air_run_height). It also gets the per-run
// height override, so a paragraph with one run covering all text measures exactly
// like a run-free field (pinned by the probe's whole1line-24 vs plain24-1line).
void* sk_textlayout_new_runs(const char* text, const sk_text_run* defaultStyle,
                             const sk_text_run* runs, int run_count,
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
    sk_set_air_run_height(ts, r.family, r.size, r.bold, r.italic, r.leading);
    return ts;
  };

  sk_text_run def = runs[0];
  if (defaultStyle != nullptr) def = *defaultStyle;

  ParagraphStyle ps;
  ps.setTextStyle(mkStyle(def));
  ps.setTextAlign((TextAlign)align);
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
  // This LINE's own box, not a paragraph-wide stride: LineMetrics::fHeight is the
  // height of THIS line (not the cumulative paragraph height) and already carries
  // whatever strut or per-run height override was forced on it, so a paragraph
  // whose runs differ in size reports each line's own box instead of one average
  // over all of them (measured on adl: a 12 px default plus a 24 px run has line
  // heights 13.975 / 27.950, not a uniform box).
  LineMetrics& m = lm[idx];
  const double lh = (double)m.fHeight;
  // AIR splits that box as ascent + descent + leading with an ascent/descent pair
  // that ignores the leading. Skia keeps exposing the UNFORCED halves when a box
  // was forced on the line (measured: a 12 px Arial strut reports asc 10 / desc 4
  // for a 12 px box), so scale the pair into the box minus the leading. With
  // leading 0 -- the common case -- the split is left exactly as Skia reports it,
  // and a run-level height override already reports halves that sum to its box.
  const double sum = (double)m.fAscent + (double)m.fDescent;
  const double model = lh - leading;
  const double k = (sum > 0.0 && model > 0.0) ? model / sum : 1.0;
  double asc = (double)m.fAscent * k;
  double desc = (double)m.fDescent * k;
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

}  // extern "C"
