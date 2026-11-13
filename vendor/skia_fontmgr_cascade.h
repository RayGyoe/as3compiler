// skia_fontmgr_cascade.h — a font manager wrapper that adds the per-character
// fallback tier SkFontMgr_Custom refuses to implement.
//
// Why this exists
// ---------------
// The web/wasm arm has no system fonts to enumerate, so it builds its manager
// from injected byte streams: SkFontMgr_New_Custom_Data (vendor/skia_glue.cc,
// sk_platform_fontmgr). That manager is SkFontMgr_Custom, whose
//   onMatchFamilyStyleCharacter(...) { return nullptr; }
// (skia-src/src/ports/SkFontMgr_custom.cpp:190) is an unconditional refusal.
// SkParagraph asks the manager for a fallback face for EVERY code point the
// run's own face does not map, so an injected set of faces never cascades:
// install Arial + a CJK face together and a CJK run still draws .notdef for
// every character, because the run resolved to Arial, Arial lacks the glyph,
// and the manager will not look at the second face. That is G40 in
// docs/zh-cn/compiler-gaps.md, and it is why the ui-demo web arm had to ship
// one all-scripts subset (MiSans) instead of a proper Latin face.
//
// What it does NOT do
// -------------------
// It does not change any name/style query: countFamilies / getFamilyName /
// createStyleSet / matchFamily / matchFamilyStyle / makeFrom* / legacyMake
// are forwarded verbatim, so every family that resolves today resolves to the
// same face. Only the character query gains a tier, and only when the wrapped
// manager itself answered with nothing (on platforms whose manager does have a
// real cascade, e.g. CoreText or GDI+DirectWrite, the base answer wins and
// nothing here changes).
//
// Ordering (the fallback is honest, not arbitrary)
// 1. the wrapped manager's own answer;
// 2. the requested family in the requested style, then in its default style
//    (covers "the family has the glyph but not at this weight");
// 3. every family the wrapped manager knows, in its registration order, again
//    style-then-default.
// Registration order is the host's declared preference (the page's font-urls
// list / the injected data order), so the first face that actually maps the
// code point wins and later faces are never consulted for it.
//
// Bidi/locale (bcp47) is deliberately not used to reorder candidates: the web
// arm injects a handful of explicit faces, and reordering them by language
// would make the same text resolve differently per <html lang>, which no other
// backend does. It stays a documented simplification, not a silent one.

#ifndef ASC_SKIA_FONTMGR_CASCADE_H
#define ASC_SKIA_FONTMGR_CASCADE_H

#include "include/core/SkData.h"
#include "include/core/SkFontArguments.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkStream.h"
#include "include/core/SkString.h"
#include "include/core/SkTypeface.h"

#include <cstring>
#include <utility>

class SkFontMgrCascading : public SkFontMgr {
public:
    // Returns nullptr for a null base so a caller can wrap unconditionally.
    static sk_sp<SkFontMgr> Make(sk_sp<SkFontMgr> base) {
        if (!base) return nullptr;
        return sk_sp<SkFontMgr>(new SkFontMgrCascading(std::move(base)));
    }

protected:
    int onCountFamilies() const override { return fBase->countFamilies(); }
    void onGetFamilyName(int index, SkString* familyName) const override {
        fBase->getFamilyName(index, familyName);
    }
    sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {
        return fBase->createStyleSet(index);
    }
    sk_sp<SkFontStyleSet> onMatchFamily(const char familyName[]) const override {
        return fBase->matchFamily(familyName);
    }
    sk_sp<SkTypeface> onMatchFamilyStyle(const char familyName[],
                                         const SkFontStyle& style) const override {
        return fBase->matchFamilyStyle(familyName, style);
    }

    sk_sp<SkTypeface> onMatchFamilyStyleCharacter(const char familyName[],
                                                  const SkFontStyle& style,
                                                  const char* bcp47[], int bcp47Count,
                                                  SkUnichar character) const override {
        (void)bcp47;
        (void)bcp47Count;
        if (sk_sp<SkTypeface> hit =
                fBase->matchFamilyStyleCharacter(familyName, style, bcp47, bcp47Count, character)) {
            return hit;
        }

        if (familyName != nullptr && familyName[0] != 0) {
            if (sk_sp<SkTypeface> hit = firstWithGlyph(familyName, style, character)) return hit;
        }

        const int families = fBase->countFamilies();
        for (int i = 0; i < families; ++i) {
            SkString family;
            fBase->getFamilyName(i, &family);
            if (familyName != nullptr && std::strcmp(family.c_str(), familyName) == 0) continue;
            if (sk_sp<SkTypeface> hit = firstWithGlyph(family.c_str(), style, character)) return hit;
        }
        return nullptr;
    }

    sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data, int ttcIndex) const override {
        return fBase->makeFromData(std::move(data), ttcIndex);
    }
    sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,
                                            int ttcIndex) const override {
        return fBase->makeFromStream(std::move(stream), ttcIndex);
    }
    sk_sp<SkTypeface> onMakeFromStreamArgs(std::unique_ptr<SkStreamAsset> stream,
                                           const SkFontArguments& args) const override {
        return fBase->makeFromStream(std::move(stream), args);
    }
    sk_sp<SkTypeface> onMakeFromFile(const char path[], int ttcIndex) const override {
        return fBase->makeFromFile(path, ttcIndex);
    }
    sk_sp<SkTypeface> onLegacyMakeTypeface(const char familyName[],
                                           SkFontStyle style) const override {
        return fBase->legacyMakeTypeface(familyName, style);
    }

private:
    explicit SkFontMgrCascading(sk_sp<SkFontMgr> base) : fBase(std::move(base)) {}

    // The family's face in the requested style, else in its default style —
    // whichever actually maps the code point. An unmapped code point stays 0,
    // so we never hand SkParagraph a face that would still draw .notdef.
    sk_sp<SkTypeface> firstWithGlyph(const char familyName[], const SkFontStyle& style,
                                     SkUnichar character) const {
        const SkFontStyle candidates[2] = {style, SkFontStyle()};
        for (const SkFontStyle& s : candidates) {
            sk_sp<SkTypeface> tf = fBase->matchFamilyStyle(familyName, s);
            if (tf && tf->unicharToGlyph(character) != 0) return tf;
        }
        return nullptr;
    }

    sk_sp<SkFontMgr> fBase;
};

#endif  // ASC_SKIA_FONTMGR_CASCADE_H