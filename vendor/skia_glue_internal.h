// skia_glue_internal.h — the one declaration the two halves of the Skia glue
// share: the platform font manager.
//
// vendor/skia_glue.cc (graphics) DEFINES it; vendor/skia_text_glue.cc (text
// engine) uses it to resolve every family. C++ linkage is deliberate: the return
// type is sk_sp<SkFontMgr>, which cannot cross an extern "C" boundary, and the
// whole point of keeping the text half out of a no-text link is that the two
// files stay separate translation units -- an inline definition in this header
// would drag the CoreText/GDI manager into every build instead.
#ifndef AS3_SKIA_GLUE_INTERNAL_H
#define AS3_SKIA_GLUE_INTERNAL_H

#include "include/core/SkFontMgr.h"
#include "include/core/SkRefCnt.h"

sk_sp<SkFontMgr> sk_platform_fontmgr();

#endif  // AS3_SKIA_GLUE_INTERNAL_H
