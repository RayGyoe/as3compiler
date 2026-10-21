# Text layout backend: split the text engine out of the link first (done), then decide about Rust

> **Status: step 1 has landed (stage 221, `v0.4.195 → v0.4.196`); step 2 (swapping in a Rust engine) is
> still an evaluation — not implemented, no version number.**
>
> This document answers two questions, in an order that cannot be swapped:
>
> 1. **Can a program that draws no text stop paying for the text engine?** — **Yes. Done, and
>    measured**: the text half of the glue is now its own source file / object, and the build layer
>    decides whether to link it from whether the program touches `flash.text`. On the same
>    text-free program: **19.43 MB → 6.53 MB (−12.90 MB, −66.4%)**, with zero semantic change.
> 2. **Should the layout engine be replaced with a pure-Rust stack (cosmic-text + swash +
>    rustybuzz)?** — **The seam already exists** (15 opaque functions), **but the set of situations
>    where it pays off is very narrow**: not desktop, not web. The only account that balances is a
>    mobile target with a hard size constraint, and the real cost is not linking — it is re-deriving
>    every layout convention calibrated value-by-value against `adl` on a completely different
>    engine (§9).
>
> The previous revision (2026-10-20) filed "split it into an independent object" under §2.4 as a
> *precondition for swapping engines*. It turns out the split **is itself the win**, and it needs
> **no engine swap at all** — the biggest structural change in this revision.

---

## 0. Scope and the two steps

**Step 1 (done, §1–§2 here)**: carve the text section out of `vendor/skia_glue.cc` into
`vendor/skia_text_glue.cc`, so a build that does not use text **never puts it in the link** at all.
This changes no AS3 or rendering semantics — only the **link graph**.

**Step 2 (evaluation, §4–§12 here)**: replace the *implementation* behind those 15 seam functions,
from SkParagraph to a Rust static library. This does change semantics, and every layout calibration
must be redone.

**Out of scope**: the AS3 semantics of `TextField` itself ([`flash-text.md`](flash-text.md)); the
overall Skia integration and the Metal backend ([`skia.md`](skia.md)); SWC static-text baking
([`swc.md`](swc.md)); "should the frontend TS be ported to Rust" (verdict in §11).

**Single oracle**: `adl` from AIR 51.4.1. Any "matches / doesn't match" in this document is decided
value-by-value against `adl` (AGENTS §1.5).

---

## 1. Today: four layers, exactly one seam

```
① generated, readable C        as_tf_*  /  TextField_*   (emitted by emit.ts, the only place that touches C strings)
        │  calls
② runtime.ts inline forwarders as_skia_text_measure / as_skia_textlayout_*
        │  runtime.ts:8927+  (ASC_USE_SKIA + ASC_HAVE_TEXT)
        │  runtime.ts:9592+  (no Skia, or no text engine linked: all-zero stubs)
③ the C seam (extern, 15 fns)  src/runtime.ts:8763–8789
        │
④ the glue implementation      vendor/skia_text_glue.cc (695 lines, split out in stage 221)
        │                      SkParagraph / SkFontMgr / SkTypeface / HarfBuzz / ICU
⑤ prebuilt Skia libraries      vendor/skia/lib/<platform>/
```

### 1.1 The seam is exactly 15 functions

| Group | Functions | Location |
|---|---|---|
| single-line measurement (2) | `sk_text_measure` / `sk_text_measure_n` | `runtime.ts:8767–8768` |
| paragraph layout (13) | `sk_textlayout_new` / `_new_leading` / `_new_runs` / `_height` / `_max_width` / `_line_metrics` / `_line_box` / `_line_count` / `_paint` / `_delete` / `_glyph_position_at` / `_rects_for_range` / `_caret_rect` | `runtime.ts:8769–8789` |

A paragraph is an **opaque handle** (`void*`); the C side can only query it through those 13
functions (height / width / line count / line box / caret / range rectangles) and draw it
(`_paint(para, canvas, x, y)`). **No C struct anywhere exposes a SkParagraph type.**

> This is what §2.9 ("link third-party libraries in, don't embed them") produces: precisely because
> the seam is 15 opaque functions, both ① "move the implementation into another source file" and
> ② "swap the engine" are **not** architecture changes.

### 1.2 The file layout after the split (stage 221)

| File | Lines | Contents | When it enters the link |
|---|---|---|---|
| `vendor/skia_glue.cc` | 1492 | **graphics half**: surface/GPU/canvas/paint/blend/path/gradient/rich-fills/filters/bitmap/SVG/image codecs + **the platform font manager** | **always**, on a Skia build |
| `vendor/skia_text_glue.cc` | 695 | **text half**: `sk_default_typeface`, AIR device-font aliases, `sk_text_measure*`, `sk_canvas_draw_text*`, every `sk_textlayout_*`, the AIR line-box/strut conversions | only when the program uses `flash.text` (or the SWC bake produced text characters) |
| `vendor/skia_glue_internal.h` | 18 | the single shared declaration: `sk_sp<SkFontMgr> sk_platform_fontmgr();` (C++ linkage, **deliberately not inline**) | header |

### 1.3 The platform font manager is already tiered

`sk_platform_fontmgr()` dispatches per platform and **stays in the graphics half** (why: §2.5):

| Platform | Implementation | Location |
|---|---|---|
| macOS | `SkFontMgr_New_CoreText(nullptr)` | `skia_glue.cc:394` |
| Windows | `SkAirFontMgr(GDI, DirectWrite)` — two-tier fallback | `skia_glue.cc:231` (class) / `:381` (factory) |
| web / no platform | `SkFontMgr_New_Custom_Empty()` → `SkFontMgr_New_Custom_Data()` (fixed font data, FreeType scan) | `skia_glue.cc:143` |
| Android (future) | Skia already ships `SkFontMgr_New_Android` (reads `/system/fonts` + `fonts.xml`) | not wired |

**This fact matters**: it means "mobile font matching is poor" is **not** a reason to bring in a Rust
text stack — all three platforms already delegate to the system font manager. A corollary: the font
manager **had to stay in the graphics half** during the split, or SVG `<text>` and web font injection
would have vanished along with the text engine.

---

## 2. Step 1: split the text engine out of the link (done)

### 2.1 Why splitting is the only way out

`vendor/skia_glue.cc` used to be **one** 2106-line `.cc`, compiled into **one** `skia_glue.o`.
**An object file is linked whole**: if any function inside it references `skia::textlayout::*`
(`StrutStyle`, `FontCollection`, `ParagraphBuilder`…), the linker must resolve them, so

```
libskparagraph.a → libskunicode.a → libharfbuzz.a → libicu.a → libicu.icudtl_dat.o (10.19 MB)
```

is dragged in as a chain, **even if the program never draws a single glyph**. Two approaches were
measured and rejected:

| Approach tried | Result |
|---|---|
| compile the glue with `-ffunction-sections` + link with `-Wl,-dead_strip` | **still fails to link** (`Undefined symbols: skia::textlayout::StrutStyle::StrutStyle()`) — even with sections, an object file's undefined symbols must be resolvable |
| add `-Wl,-dead_strip` to the final binary only | saves 2.74 MB, but ICU is still there (the text symbols are already in the link graph) |

So **splitting the source file is the only lever that changes the link graph**: only by putting the
SkParagraph-referencing code into a **different** `.o` can that `.o` be left out.

### 2.2 How it was split

There is exactly one rule: **the graphics half must contain no SkParagraph symbol whatsoever** (the
rule is written in the header comment of `vendor/skia_text_glue.cc`, and pinned by source-level
assertions in `test/unit/build.ts` under `unit: build/TextEngineSplit`).

| Stays in the graphics half | Moves to the text half |
|---|---|
| surface / GPU / canvas / paint / blend / path / gradient / rich-fills / filters / bitmap | `sk_default_typeface`, AIR device-font aliases (`_sans`/`_serif`/`_typewriter`…) |
| SVG rasterization (`ASC_USE_SVG`) | the AIR line-box model (`sk_air_line_metrics` / `sk_round_half` / `sk_set_air_strut`) |
| image → PNG / image codecs | `sk_text_measure` / `sk_text_measure_n` / `sk_canvas_draw_text*` |
| **the platform font manager** (§2.5) | all 13 `sk_textlayout_*` + `sk_family_alias` |

Symmetry check: **the seam itself did not change by a single byte**. What moved is the
implementation, not the interface — which is exactly why the opaque seam in §1.1 exists.

### 2.3 Who decides which half is linked: `src/index.ts::usesTextEngine`

The decision has to be made **before the generated C is compiled**, because `ASC_HAVE_TEXT` changes
**what the seam compiles to**; inspecting the object's undefined symbols afterwards is too late (the C
is already compiled). So this is a **source-level detector**, with the same shape and the same bias as
the existing `usesFlashData` (which decides whether SQLite is linked):

```ts
// src/index.ts:384–402
function usesTextEngine(texts: string[]): boolean {
  const re = /flash\.text\.|(?:^|[^A-Za-z0-9_.$])(?:TextField|TextFormat|TextLineMetrics|StyleSheet|
    TextFieldAutoSize|TextFieldType|TextInteractionMode|AntiAliasType|GridFitType|StaticText)(?![A-Za-z0-9_])/;
  for (const t of texts) if (re.test(t)) return true;
  return false;
}
```

Four points matter:

1. **Both spellings are matched**: AS3 allows `new flash.text.TextField()` without an import, while a
   bare `TextField` requires one — both must be caught.
2. **Text baked from an SWC counts as a user**: characters with `kind === 'text'` in
   `swcBake.characters` are baked into real `TextField`s, and the AS3 sources mention `flash.text`
   **nowhere** (`src/swc.ts:2234` produces them, `:2365`–`:2446` bake them into `TextField` children,
   `swc.md` §9.2). Miss this and a skinned `--air-app` silently loses its text.
3. **The manifest wins when it speaks**: if the manifest *names* `vendor/skia_text_glue.cc`, it is
   always linked (the user said so).
4. **Source and macro are added in the same branch**, so it is impossible to add only one — source
   alone is dead weight, macro alone is an `undefined symbol`.

The verdict is printed during the build; nothing is silent:

```
+ flash.text: text engine linked (program uses flash.text)
- flash.text: no text in this program -- text engine NOT linked (~12.9 MB smaller)
```

### 2.4 The runtime seam: `ASC_HAVE_TEXT` has two states, and neither is silent

The seam forwarders starting at `src/runtime.ts:8927` are now three blocks:

| Branch | Contents |
|---|---|
| `#ifdef ASC_HAVE_TEXT` (Skia + text engine linked) | 16 lines forwarding to `sk_*` |
| `#else` (Skia, no text engine linked) | same-shaped no-op stubs + a **one-time stderr warning** from `as_text_engine_absent()` |
| `#ifndef ASC_USE_SKIA` (pure C / WASI) | the pre-existing all-zero stubs, **untouched** |

The warning fires once and only when the seam is **actually driven**, so the "compiles, runs, has no
text" silent shape cannot happen:

```
warning: flash.text is not linked into this build, so every TextField operation is a no-op.
         The build found no flash.text class in the program's sources, so it skipped the text engine;
         rebuild with it linked (docs/zh-cn/rust-text-backend.md) if that verdict was wrong.
```

That path was verified on a real text-using program linked **without** the text half: the three lines
above, then the program stops on its own `textWidth <= 0` self-check (`examples/tf-scale-metrics.as:97`).

### 2.5 What was deliberately left in the graphics half

`sk_platform_fontmgr()` **stays**, because it is a **graphics-layer service**, not merely a text one:

- SVG rasterization (`ASC_USE_SVG`) hands it to `SkSVGDOM`, or `<text>` inside an SVG has no fonts
  (`skia_glue.cc:1431`);
- the web build's font injection `sk_fontmgr_register_data` (`skia_glue.cc:163`) mutates the same
  cache, and `EXPORTED_FUNCTIONS` exports `_sk_fontmgr_register_data` **unconditionally** — move it
  and a text-free web build fails to link.

So it became **the one symbol the two halves share**: defined in the graphics half (its `static` was
removed), declared for the text half in `vendor/skia_glue_internal.h`. That declaration is
**deliberately not `inline`**: an inline definition would drag the CoreText/GDI manager into every
build and cancel the split.

### 2.6 Measurements

The same program (`temp/split/notxt.as`, `Graphics` only, no `flash.text` anywhere), the same manifest
(`examples/draw-over.build.json`); the only difference is that the build layer now classifies it as
"no text":

| | Binary | ICU data (`nm | grep icudt`) |
|---|---|---|
| before the split (baseline, same code before this change) | **19,429,928 B = 19.43 MB** | present (`_icudt69_dat`) |
| after the split | **6,531,688 B = 6.53 MB** | **absent** |
| after the split, generated C compiled at `-O0` (proof that this does not rely on `-O2` dead-code elimination) | 6,809,608 B, links clean | absent |

- **12,898,240 B saved (−66.4%)**, of which the ICU data block is 10.19 MB and the remaining ≈2.7 MB
  is skunicode + harfbuzz + skshaper + skparagraph code.
- **Text-using programs are unchanged**: `examples/tf-scale-metrics.as` is still 19,430,208 B
  (classified as "has text"). In other words this cut takes from the **"no text"** side, not from
  text *functionality*.
- The generated C is **byte-for-byte unchanged** (only the C++ side moved), so every existing
  example's numeric assertions pass as before.
- The `-O0` row is **deliberate**: if the new link only held after `-O2` had pruned dead branches,
  that would mean we depend on the optimizer instead of the link graph, and any `opt` change would
  break it.

**It holds on the web target too** (`--target wasm --package web`, same manifest, only the verdict
differs):

| | `.wasm` | Verdict |
|---|---|---|
| a small program that draws no text | **2,769,084 B = 2.77 MB** | `- flash.text: ... text engine NOT linked` |
| the same program using a `TextField` | **5,846,710 B = 5.85 MB** | `+ flash.text: text engine linked` |

The 3.08 MB difference is the web-side ICU + shaping stack. These two rows also prove §2.5's decision by
contradiction: **the text-free one does not link the text half yet still exports
`_sk_fontmgr_register_data`** (`EXPORTED_FUNCTIONS` demands it unconditionally) — had the font manager
moved to the text half, that build would fail to link. Both `--air-app` examples
(`air-starling-demo` 8.97 MB, `air-native` 7.43 MB) now build for web as well.

### 2.7 The four traps of this split (all written into comments)

| Trap | Symptom | Handling |
|---|---|---|
| `RUNTIME_PREAMBLE` is a **backtick template literal** | a backtick in a C comment ⇒ TS syntax error (`ERR_INVALID_TYPESCRIPT_SYNTAX`) | no backticks in comments |
| same, `\n` is eaten by JS first | `fprintf(stderr, "...\n")` becomes a real newline plus a broken string in the generated C | write `\\n` in the source |
| unit pins read **one** glue file | five groups (`display`/`render`/`text-input`/`platform`/`build`) went red once the text code moved | `test/harness.ts` grew `readGlue()` (concatenation of both files); **the split itself** is pinned separately by the new `unit: build/TextEngineSplit` (13 checks) |
| making `sk_platform_fontmgr` non-`static` broke a `platform/FontFallback` anchor | the assertion could not find `#else\nstatic sk_sp<SkFontMgr> sk_platform_fontmgr()` | the anchor drops `static`, with a comment saying why the halves share it |

---

## 3. Step 2's account: what is left after the split

The split **made the difference explicit**: "draws text or not" is now an **optional 12.90 MB**
instead of something everyone pays. What remains, ordered by risk/benefit:

| Route | How | Expected gain | Risk | Status |
|---|---|---|---|---|
| **L0** | **this split** (no text ⇒ no text stack) | **−12.90 MB** (for builds that draw no text) | absorbed | ✅ **done** |
| **L1** | link-time `-Wl,-dead_strip` (`grep` finds none in `build.ts`) | **−2.74 MB** (every build) | low (ObjC categories / typeinfo under `-dead_strip` need a full regression) | ⏸ not done (§10) |
| **L2** | rebuild Skia with `skia_use_icu=false` + `skia_use_icu4x=true` | could remove most of the 10.19 MB | medium (must verify SkParagraph's line breaking/bidi still match) | ⏸ not done |
| **L3** | rebuild Skia with `skia_use_libgrapheme=true` + `skia_use_icu=false` | same, more aggressive | high (libgrapheme **does no bidi**) | ⚠️ generally not advised |
| **L4** | prune the codecs that `air-app.ts` lists 1:1 (`skottie`/`svg`/`dng_sdk`/`piex`/`expat`) | ~2.5 MB | low | partly covered by L1 |
| **L5** | **swap in the Rust text engine** (this document's step 2) | another ~13 MB for **text-using** builds | **high** (§9 B1/B2) | ⏸ only for mobile + a hard size constraint |

**How to read this table**: L0 has already banked the largest single amount, and it **touches no
layout semantics**. L5's gain does **not** stack with L0's — L0 saves the *text-free* program, L5
saves what is left of the *text-using* one. L5 only enters the picture when "uses text + hard size
constraint" hold at the same time.

---

## 4. Candidate stack (Rust side)

| crate | Role | Who does it today | Note |
|---|---|---|---|
| `rustybuzz` | **shaping** | HarfBuzz | **a Rust port of HarfBuzz** ⇒ same shaping behaviour, low migration risk — but "removing HarfBuzz" actually means "swapping in HarfBuzz's Rust version" |
| `ttf-parser` | font parsing / cmap / metrics | FreeType + SkTypeface | |
| `swash` | **rasterization + glyph cache** | SkScalerContext + SkGlyphCache | weak on colour emoji (CBDT/sbix) |
| `fontdb` | font enumeration / family matching | `SkFontMgr` | already covered by three platform font managers, see §1.3 |
| `cosmic-text` | **line breaking + paragraphs + cache** | SkParagraph (UAX#14) | depends on all of the above |
| `parley` (alternative) | line breaking + paragraphs | SkParagraph | from linebender like `swash`, more active |

**The key trade-off**: shaping with `rustybuzz` keeps the semantics "same-origin" (good for `adl`
alignment), but **does not remove the shaping logic itself**; what is actually removed is **ICU's
unicode data tables** (10.19 MB) and the C++ HarfBuzz implementation.

---

## 5. Integration shapes (three tiers)

| Tier | How | Verdict |
|---|---|---|
| **1. Full replacement**: Rust emits `(mask, x, y)`, C++ only composites onto the Skia canvas | add a shim under `vendor/` implementing the same 13 `sk_textlayout_*`, **compiled instead of** the ones in `skia_text_glue.cc`; the generated C does not change by a line | ✅ **recommended** (the only shape that delivers L5) |
| 2. Swap only the font library (`fontdb` feeding `SkFontMgr_New_Custom_Data`) | only "family matching" changes | ❌ already covered by the platform FontMgr (§1.3), gain ≈ 0 |
| 3. Two backends side by side (Skia and Rust both linked, switched at runtime) | for A/B | ⚠️ **temporary** verification only: two font stacks in the binary at once, so the size is the largest of all |

**Why tier 1 still needs C++**: `_paint` lands on **Skia's `SkCanvas`** (`sk_textlayout_paint(para,
canvas, x, y)`). After the Rust side rasterizes glyphs into alpha masks, someone still has to composite
them onto the Skia canvas (`SkImage::MakeRasterCopy` / `SkSurface`). So the correct cut is:

```
Rust: shaping + line breaking + raster → (glyph mask, x, y)   ← pure Rust, no ICU / no HarfBuzz
C++ shim: mask → SkImage → canvas->drawImage                  ← still Skia, but only "blitting"
```

---

## 6. Concrete integration steps

### 6.1 The Rust crate

```toml
# vendor/rust/textlayout-rs/Cargo.toml
[lib]
crate-type = ["staticlib"]          # → libtextlayout_rs.a
[profile.release]
panic = "abort"                     # no unwind runtime: smaller, and it does not fight this repo's setjmp exceptions
opt-level = "z"
lto = true
codegen-units = 1
```

```rust
// a C ABI mapping 1:1 onto the 15 seam functions (excerpt)
#[no_mangle] pub unsafe extern "C" fn rtl_text_measure(t: *const c_char, size: f64, b: c_int, i: c_int) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_new_runs(…) -> *mut Layout { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_height(p: *const Layout) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_line_metrics(p: *const Layout, …) -> c_int { … }
// raster output goes back to C++ for compositing
#[repr(C)] pub struct RtlGlyph { pub x: f32, pub y: f32, pub w: u32, pub h: u32,
                                 pub stride: u32, pub mask: *const u8 }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_glyphs(p: *const Layout, out: *mut RtlGlyph, cap: u32) -> u32 { … }
```

### 6.2 C++ shim `vendor/textglue_rs.cc`

Implement the **same** 13 `sk_textlayout_*`, forwarding internally to `rtl_*`; `paint` wraps the mask
in an `SkImage` and calls `drawImage`. Select it against the 13 implementations in
`skia_text_glue.cc` with a **compile-time macro** (one symbol cannot have two definitions) — that is
already the pattern used by `metal_glue.mm` / `d3d_glue.cc` / `stage3d_webgl.cc` (§2.9).

> **The precondition is already met**: the old revision said here "and you must also cut the text
> section out of `skia_glue.cc`, or ICU stays as long as it references SkParagraph". **Stage 221 did
> exactly that** (§2) — so replacing the backend now means replacing **one** translation unit,
> `vendor/skia_text_glue.cc`, with no effect on the graphics half, which therefore cannot pull ICU
> back in. That is the biggest convenience the split hands to step 2.

### 6.3 Build manifest (the existing `objects` field suffices)

```json
{
  "objects": ["../../vendor/rust/libtextlayout_rs.a"],
  "defines": ["ASC_TEXT_RUST=1"],
  "link-paths": ["../../vendor/skia/lib/macos-arm64"]
}
```

The fields are defined in `src/build.ts:168–205` (`objects?: string[]` at `:204`); `objects` land at
`build.ts:738`. **No new manifest field is needed.** A new `ASC_TEXT_RUST` macro should be turned on
from the **same** place as `ASC_HAVE_TEXT` (`src/index.ts::usesTextEngine`), or there will again be two
truths: "engine present, seam stubbed" and its converse.

### 6.4 Link order is correct by construction

`build.ts:734–741` builds: `generated .c → sources (our .cc) → objects (rust .a) → -L → -l →
-framework`. A static archive lands exactly after the objects that reference it — which is what the
comment at `build.ts:743` (*"Static-archive order: libraries must follow the objects that reference
them"*) enforces.

### 6.5 The `--air-app` detection point

`auto-app` has isomorphic precedents: `detectText` (`air-app.ts:168`), `detectStage3D`
(`air-app.ts:110`), `detectAudio` (`air-app.ts:180`), `findAppFonts` (`air-app.ts:827`).
**Note**: stage 221 chose `src/index.ts::usesTextEngine` (source scan + SWC bake + manifest override)
rather than another `detect*` in `air-app.ts`, because "do we need the text engine" is the same
question for **every** build shape (bare `.as`, `--manifest`, `--air-app`, web); putting it in
`air-app` only would make the other three paths grow their own copy. If step 2 ever happens,
`ASC_TEXT_RUST` should hang off the same decision.

### 6.6 Cross-compilation matrix (**this is where the real work is**)

One `.a` per target, mirroring the `vendor/skia/lib/{macos-arm64,wasm,windows-x64,windows-x86}` layout:

| target | Rust target triple | Linker | Status |
|---|---|---|---|
| macOS arm64/x64 | `aarch64-apple-darwin` / `x86_64-apple-darwin` | `clang++` | ✅ buildable here |
| Windows x64/x86 | `x86_64-pc-windows-msvc` / `i686-pc-windows-msvc` | `clang` (MSVC ABI) | ⚠️ must use the **MSVC ABI** like Skia (`vendor/provision/README.md`) |
| web | `wasm32-unknown-emscripten` | `emcc` | ✅ target exists |
| WASI | `wasm32-wasip1` | `clang --target=wasm32-wasip1` | no GUI, not needed |
| iOS (planned) | `aarch64-apple-ios` | `clang` | waits for the target |
| Android (planned) | `aarch64-linux-android` | NDK clang | waits for the target |

### 6.7 Suggested phasing (if it is ever done)

| Stage | Contents | Acceptance |
|---|---|---|
| P0 | ~~do the low-risk items in §3 first~~: **L0 is done**; remaining are `-dead_strip` (L1) and `icu4x` (L2) | size + full regression |
| P1 | desktop **A/B two backends** (tier 3): run the same `textfield` example twice and diff the two-sided `adl` report into a **divergence list** | `flash-text.md` §5.1 numeric report |
| P2 | calibrate item by item against that list; switch the default once it converges | divergence list at zero (or recorded honestly) |
| P3 | once a mobile target lands, enable the Rust backend for that target only | per-target layering (`compile.md` §4.1) |

---

## 7. Per-platform analysis

### 7.0 Summary table

| Platform | Status | Who does text today | Gain from Rust | Cost / risk | Verdict |
|---|---|---|---|---|---|
| **macOS native** | ✅ shipped | CoreText (fonts) + SkParagraph (layout) + this repo's CoreText patch | size ~13 MB | loses the benefit of `skia.md` §6.9's patch, emoji (Apple Color Emoji), and all `adl` calibration | ❌ don't |
| **Windows native** | ✅ shipped | GDI + DirectWrite two-tier fallback + Uniscribe shaping | size ~13 MB | must rebuild an equivalent DirectWrite fallback chain; emoji (Segoe UI Emoji) | ❌ don't |
| **Linux native** | ⛔ not provisioned | — (`vendor/skia/lib/` has no linux) | — | — | ⛔ nothing to analyse |
| **web (emcc)** | ✅ shipped | `SkFontMgr_New_Custom_Data` + runtime injection of `font-urls` | size (wasm text stack archive 22.1 MB; the `.wasm` first-load payload could shed on the order of ~7 MB) | the font-injection contract must be redone; but the **relative** first-load gain is the largest | ⚠️ **the most valuable tier** |
| **WASI (raw)** | ✅ shipped (no GUI) | **none** (all `as_skia_*` are zero stubs, `runtime.ts:9592+`) | 0 | 0 | ⛔ not involved |
| **iOS** (planned) | ❌ not started | CoreText planned (the patch already covers the iOS branch) | size + a pure-static-library shape that **natively fits** (iOS has no `dlopen` problem) | needs the target and an iOS Skia build first | ⏸ evaluate together with the target |
| **Android** (planned) | ❌ not started (`--package android-project` throws today, `index.ts:1060`) | `SkFontMgr_New_Android` planned | size (APK-sensitive) + no need to write `fonts.xml` parsing ourselves | as iOS | ⏸ evaluate together with the target |

> **After stage 221 this tier's account has changed**: a text-free web build no longer links the text
> stack, so the `.wasm` is directly smaller; a *text-using* web build still carries whatever it pulls
> from the 22.1 MB of archives. L5's web gain therefore shrinks from "every page" to "pages that draw
> text" — **the trigger got narrower, not wider**.

### 7.1 macOS native

- **Today**: `SkFontMgr_New_CoreText` enumerates system fonts; SkParagraph lays out; **plus a local
  patch to the third-party library** — `vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch`
  fixes CoreText swapping faces between two font files with the same family and PostScript name
  (`skia.md` §6.9, `flash-text.md` D-T15). After the fix, ink masks match `adl` at IoU 100%.
- **After Rust**: that patch's benefit disappears (the Rust side does not go through CoreText), while
  its own font-matching problems arrive; Apple Color Emoji's colour rendering is provided by CoreText,
  and `swash` is weak on CBDT/sbix.
- **Size**: ~13 MB.
- **Verdict**: ❌ **don't**. The gain is pure size; the cost is every behaviour already pinned down.

### 7.2 Windows native

- **Today**: `SkAirFontMgr(GDI, DirectWrite)` two-tier fallback (`skia_glue.cc:231`); the GDI
  backend shapes with Uniscribe (comment at `air-app.ts:676`). Skia ships x64/x86 libraries.
- **After Rust**: an equivalent fallback chain must be rebuilt (`fontdb` can read `C:\Windows\Fonts`,
  but DirectWrite's script-aware fallback is ours to write); emoji goes through Segoe UI Emoji.
- **Size**: ~13 MB (41.4 MB of archives → roughly 13 MB saved, same order as macOS).
- **Verdict**: ❌ **don't**, for the same reason as macOS.

### 7.3 Linux native

- `vendor/skia/lib/` contains only `macos-arm64` / `wasm` / `windows-x64` / `windows-x86`, **no linux**
  (`compile.md` §2 states "four sets of prebuilt dependency libraries"). So there is currently **no
  text stack on Linux to analyse**.
- If Linux is ever provisioned: Skia would use fontconfig (`skia_use_fontconfig` is currently `false`),
  while `fontdb` on the Rust side is actually simpler there. Leave this until a Linux target is
  proposed.

### 7.4 web / wasm (emcc)

- **Today**: `SkFontMgr_New_Custom_Empty` → `SkFontMgr_New_Custom_Data`, with font bytes fetched by the
  page JS and injected through `Module._sk_fontmgr_register_data(ptr, len)` (`html5-web.md` §4).
  `EXPORTED_FUNCTIONS` must export that entry point (`html5-web.md` §5.2) — **which is also why it has
  to stay in the graphics half** (§2.5).
- **A web-only trap lives here**: the sandbox has **no enumerable system fonts**; an empty `font-urls`
  leaves `sk_platform_fontmgr()` at `Custom_Empty`, so **drawString draws not a single glyph** while the
  build succeeds, the page runs and the trace looks fine (a silent failure — see the failure-mode note
  in `html5-web.md` §4).
- **After Rust**: the font-injection contract has to be redone (the same bytes must cross the wasm
  boundary to reach Rust), but **the seam can keep the same shape**: still "JS fetch → inject → must be
  in place before layout".
- **Gain**: the wasm text stack is 22.1 MB of archives, worth roughly 7 MB. **`.wasm` size is a
  first-load download cost**, so the size gain here is **worth more than on desktop**.
- **Verdict**: ⚠️ **if a Rust text backend is ever built, this is the first candidate** (but compare it
  against L1/L2 in §3 first, and check the §7.0 note that the page really does draw text).

### 7.5 WASI (`--target wasm --package raw`)

- **Not involved**: the WASI artifact is a GUI-less command-line module with no rendering. In the pure-C
  branch every `as_skia_text_*` is an inline stub **returning 0/NULL** (`runtime.ts:9592+`).
- Swapping in any text engine does not affect WASI. **Zero gain, zero cost.**

### 7.6 iOS (planned)

- `compile.md` §6.1 already lists `--target ios` as a **planned** value (`clang --target=arm64-apple-ios`).
- **Rust's shape is actually an advantage on iOS**: iOS extensions/components are **statically linked
  into the application image**, with no `dlopen` step (the ANE entry in `TODO.md` already records this
  difference between iOS and macOS). A Rust `staticlib` is exactly that shape.
- On the font side, however: iOS is CoreText too, and the patch in `skia.md` §6.9 **already sits inside
  the `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS` branch** — i.e. the Skia-side font matching is already
  fixed for iOS.
- **Verdict**: ⏸ do not propose this separately; **evaluate it together with `--target ios`**.

### 7.7 Android (planned)

- `--package android-project` **throws outright** today (`src/index.ts:1060`: `not yet implemented`), and
  `vendor/skia/lib/` has no android directory either.
- On the font side: Skia ships `SkFontMgr_New_Android` (reads `/system/fonts` + `fonts.xml`), which is
  less work than parsing `fonts.xml` in Rust ourselves ⇒ **font matching is again not a reason**.
- **Verdict**: ⏸ the only scenario that could make a Rust text backend pay is a **hard APK size
  constraint** (app-store limits). In that case the shape should be: **enabled for that target only**,
  via `targets.android` manifest layering (`build.ts:355–396`, whose semantics are **replace, not
  append**).

---

## 8. Advantages (item by item)

| # | Advantage | Magnitude / evidence | Platforms |
|---|---|---|---|
| A1 | **Drops the ICU data block** | a single 10.19 MB object, see §3 | all |
| A2 | **Drops skunicode + harfbuzz + skshaper + paragraph** | ≈2.7 MB together (measured by the split: 12.90 saved − 10.19 of ICU data) | all |
| A3 | **Pure Rust, no C++ dependency** | removes the `SK_TRIVIAL_ABI` / `-std=c++17` / MSVC ABI interlink constraints (`html5-web.md` §5.1, `provision/README.md`) | all |
| A4 | **Static-library shape suits mobile** | iOS has no `dlopen`; static linking is the only shape | iOS / Android |
| A5 | **Same shaping semantics** | `rustybuzz` is a Rust port of HarfBuzz ⇒ lower migration risk than a genuinely new shaper | all |
| A6 | **One engine across all platforms** | today macOS/Windows/web are **three** font managers plus two shaping paths | all |
| A7 | **Reproducible builds via `cargo`** | compared with rebuilding through gn+ninja in `build-tools/skia-src` (`skia.md` §6.1) | all |
| A8 | **The link graph is already in place** | stage 221 made the text section its own `vendor/skia_text_glue.cc`: swapping engines = swapping this one translation unit, with the graphics half unaffected | all (a by-product of step 1) |

## 9. Disadvantages and costs (item by item)

| # | Cost | What it actually is | Severity |
|---|---|---|---|
| B1 | **All `adl` calibration redone** | `flash-text.md` §2's D-T1…D-T21 plus the whole of `skia.md` §8: the break threshold is exactly `ceil(ink+4)`, `autoSize` only changes width when `wordWrap=false`, the trailing-space convention for `textWidth`, the `sy/sx` convention for `textWidth/Height` on a scaled field, glyphs scaled only by cumulative `scaleY`… all of it is **pinned to SkParagraph's behaviour** | 🔴 **most expensive** |
| B2 | **Line-box model re-derived** | `sk_air_line_metrics` + `sk_round_half` + `sk_set_air_strut` (`skia_text_glue.cc:123–168`) — AIR is `rhalf(ascent)+rhalf(descent)+leading(px)` and **never adds the line gap**; Skia is `ceil(ascent+descent+lineGap)`. That conversion matches nine named faces exactly; on a new engine it must be re-derived from scratch | 🔴 |
| B3 | **Family alias semantics** | `sk_family_alias` (`skia_text_glue.cc:225`): `_sans→Helvetica`, `_serif→Times New Roman`, `_typewriter→Monaco`, `NULL→Times`, plus "**an uninstalled family falls back to the platform default face**" (`D-T17`, measured 6 px difference) | 🟠 |
| B4 | **Colour emoji** | `swash` is weak on CBDT/sbix bitmap colour fonts; CoreText (macOS) and DirectWrite (Windows) both support them out of the box | 🟠 |
| B5 | **Installed fonts ≠ enumerable fonts** | the web injection contract must be redone (§7.4); on native the platform fallback chain must be rebuilt | 🟠 |
| B6 | **Losing the glyph cache / performance** | `SkGlyphCache` and Skia's glyph atlas are free today; the Rust side must build its own (`swash` has `scale::Scaler`, but the cache is ours to manage) | 🟡 |
| B7 | **`skia.md` §6.9's patch benefit disappears** | the face-swap problem that patch fixes reappears in a different form on the Rust side (same family, same PostScript name) | 🟡 |
| B8 | **Toolchain into CI** | there is currently **no Rust toolchain on this machine** (`rustc`/`cargo`/`rustup` all `command not found`); CI would need cross-compilation for 5–6 targets | 🟡 |
| B9 | **Licence review** | Skia=BSD-3, ICU=Unicode License; the Rust side's `cosmic-text`/`swash`/`fontdb`/`rustybuzz`/`ttf-parser` licences must be reviewed item by item before deciding (**not reviewed in this document**; must be checked before landing) | 🟡 |
| B10 | **Two backends is the largest option** | during tier 3 (A/B), two font stacks sit in the binary at once | 🟡 |
| B11 | **The whole suite must be re-run** | 200+ examples + the two-sided `textfield` report + structural nails such as `[textwrap]` | 🟡 |

### 9.1 Evidence for B1/B2: what these conventions look like

Of the 695 lines in `vendor/skia_text_glue.cc`, **most are not "drawing glyphs" but "dragging Skia
onto AIR's conventions"**:

```cpp
// AIR rounds each half of the line box to the nearest 0.5 and never adds the font's own
// line gap; Skia reports ceil-ish(ascent + descent + lineGap).
// Measured (Helvetica 9.24→9 / 2.76→3; Times New Roman 10.6875→10.5 / 2.59375→2.5):
// rounding the halves reproduces every named face's line height -- Courier 12,
// Courier New 13.5, Menlo 14, Monaco 15, Times 12, Times New Roman 13, Arial 13.5,
// Helvetica 12, Geneva 15.
static double sk_round_half(double v) { return floor(v * 2.0 + 0.5) / 2.0; }
                                                 // skia_text_glue.cc:123
```

```cpp
// StrutStyle::leading does not reach the line box in this build (measured: leading=4 leaves a
// 2-line paragraph at 2*model) and a negative leading is clamped to 0 by Skia; so the leading
// must be folded into the height. And because Skia scales by (height * fontSize / rawFull),
// the height must be pre-multiplied by rawFull/rawSum.
strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));   // from skia_text_glue.cc:168
```

These two are **not things that can be "translated"; they are things that must be measured again,
probe by probe, against `adl`.** That is where B2's severity comes from.

---

## 10. Side-by-side: slimming further after the split

**L0 is already banked (§2.6).** The remaining tiers are mutually compatible and differ by an order of
magnitude in cost:

| Route | How | Expected gain | Risk | Recommendation |
|---|---|---|---|---|
| **L1** | Link-time `-Wl,-dead_strip` (currently absent entirely) | **measured −2.74 MB** (19.43 → 16.69, `temp/textsize/notxt_ds`) | low (full regression needed to check ObjC categories/typeinfo) | ✅ **next thing to do** |
| **L2** | Rebuild Skia with `skia_use_icu=false` + `skia_use_icu4x=true` | could remove most of the 10.19 MB (ICU4X data is **modular and prunable**, and ICU4X is itself **Rust**) | medium (must verify SkParagraph's line breaking/bidi still match; `build-tools/skia-src` already has the rebuild flow) | ✅ **immediately after L1** |
| **L4** | Prune the codecs that `air-app.ts` lists 1:1 (`skottie`/`svg`/`dng_sdk`/`piex`/`expat`) | ~2.5 MB | low | largely covered by L1 |

> L2 deserves emphasis: **ICU4X is Rust**. So the idea "use a Rust unicode library" does **not** require
> replacing the whole text engine — Skia itself exposes the `skia_use_icu4x` switch, at the cost of
> rebuilding Skia once.
> **Replace the ICU data block via L2 first, then decide whether the text engine needs touching at all.**

The current `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` (identical in both):

```
skia_use_icu = true
skia_use_icu4x = false          ← ICU4X is itself a modular Rust unicode library
skia_use_libgrapheme = false
skia_use_harfbuzz = true
skia_enable_skparagraph = true
skia_enable_skshaper = true
```

---

## 11. A side note: "so should the frontend TS be ported to Rust?"

**Two different things. Do not conflate them.**

| Question | Meaning | Impact | Verdict |
|---|---|---|---|
| A. What language is the artifact | generated C → generated Rust | runtime architecture, size, semantics | ❌ rejected (three hard blockers: cyclic GC / `setjmp` exceptions / "readable C") |
| B. What the compiler is written in | frontend TS → Rust | affects only the compiler's own distribution | ❌ rejected (~55k lines portable, and the 736 KB C runtime is kept as-is ⇒ "ported to Rust and still emits C") |
| C. **This document's**: replace one **native component** with a Rust static library | one more `.a` under `vendor/` | size / no Node | ⏸ **the only legitimate shape, and only for mobile + a hard size constraint** |

C is **orthogonal** to the first two: it does not touch the generated C, the frontend, or the runtime —
it only adds a static library under `vendor/`, linked through the manifest's `objects`. That is exactly
the shape §2.9 permits.

---

## 12. Trigger conditions and decision tree

```
Is size a hard constraint?
├─ No ──────────────────────────► Don't do L5. The ~13 MB text stack is a tolerable cost,
│                                 while the re-calibration cost of §9 B1/B2 far exceeds the gain.
│                                 (But L0 has already handed text-free builds 12.9 MB for free.)
└─ Yes
   ├─ Does that build draw text?
   │  ├─ No ──► Already solved automatically (stage 221); nobody has to decide anything. ◄── banked
   │  └─ Yes
   │     ├─ Does that platform have rebuildable prebuilt Skia libraries?
   │     │  ├─ Yes ──► Do L1 (-dead_strip) + L2 (icu4x) first. That is usually enough. ◄── recommended stopping point
   │     │  └─ No  ──► Provision first (neither Linux nor Android has Skia libraries yet)
   │     └─ Still insufficient after L1+L2?
   │        └─ Yes ──► Only then L5 (the Rust text engine),
   │                   and **only for that target** (targets.<target> layering, replace semantics)
```

**Concrete trigger** (all three must hold before starting L5):

1. `--target ios` or `--target android` **has landed** (both are "planned" today, `compile.md` §6.1);
2. that platform's **size is externally constrained** (app store / first-load budget);
3. L1 + L2 have been executed and **still fall short**, leaving measured data.

---

## 13. Appendices

### A. The 15 seam functions (complete current inventory)

Declarations: `src/runtime.ts:8763–8789`; implementation: `vendor/skia_text_glue.cc` (linked only when
`ASC_HAVE_TEXT` is set).

| # | Function | Signature essentials | Implementation |
|---|---|---|---|
| 1 | `sk_text_measure` | `(text, size, bold, italic) → double` | `skia_text_glue.cc:308` (`SkFont::measureText`) |
| 2 | `sk_text_measure_n` | same + explicit byte count | `skia_text_glue.cc:315` |
| 3 | `sk_textlayout_new` | flat single-style text | `skia_text_glue.cc:373` |
| 4 | `sk_textlayout_new_leading` | + `leading` | `skia_text_glue.cc:411` |
| 5 | `sk_textlayout_new_runs` | **rich text** (`sk_text_run[]`) | `skia_text_glue.cc:465` |
| 6 | `sk_textlayout_height` | paragraph height | same file |
| 7 | `sk_textlayout_max_width` | longest line width | same file |
| 8 | `sk_textlayout_line_metrics` | per-line start/end/top/bottom | same file |
| 9 | `sk_textlayout_line_box` | one line's ascent/descent/left/width | `skia_text_glue.cc:640` |
| 10 | `sk_textlayout_line_count` | line count | same file |
| 11 | `sk_textlayout_paint` | **draw onto an SkCanvas** | same file |
| 12 | `sk_textlayout_delete` | free | same file |
| 13 | `sk_textlayout_glyph_position_at` | click → character index | same file |
| 14 | `sk_textlayout_rects_for_range` | range → rectangles (selection/underline) | same file |
| 15 | `sk_textlayout_caret_rect` | caret rectangle | same file |

> There is also the **`sk_text_run` struct** (`runtime.ts:8594–8596`), defined **unconditionally**
> (pure-C builds need it too); and the two **direct drawing** paths `sk_canvas_draw_text` /
> `sk_canvas_draw_text_n` (`skia_text_glue.cc:291` / `:300`), which bypass SkParagraph and do
> single-line work only.

### B. Measured data from this machine

**B.1 Before/after the split (2026-10-21, macOS arm64, `temp/split/`)**

| Item | Bytes | Note |
|---|---|---|
| `notxt`, baseline before the split | 19,429,928 | `examples/draw-over.as` manifest; text and graphics in the same `.o` |
| `notxt2`, after the split | **6,531,688** | classified "no text"; only `skia_glue.o` is linked |
| `notxt_o0` | 6,809,608 | generated C compiled at `-O0`, proving the link does not rely on dead-code elimination |
| `tf` (uses text, after the split) | 19,430,208 | `examples/tf-scale-metrics.as`, classified "has text", same order as the baseline |
| `tf_notxt` (text half deliberately not linked) | 6,548,376 | prints the three warning lines of §2.4 and stops on its own `textWidth <= 0` check |

**B.2 The original measurements before the split (2026-10-20, `temp/textsize/`)**

| Item | Value | Reproduction |
|---|---|---|
| Skia-free baseline binary | 0.81 MB | `node src/index.ts examples/hello.as -o temp/textsize/hello` |
| Minimal Skia program (no glue) | 5.69 MB, **no ICU data** | `temp/textsize/min.cc` + `temp/textsize/minA` |
| Text example binary | 19.43 MB (`__const` 10.79 MB, contains `_icudt69_dat`) | `temp/textsize/probe` (source `examples/textflow.as`) |
| **Graphics example** (no text) binary | **19.43 MB** (identical) | `temp/textsize/notxt` (source `examples/draw-over.as`) |
| Same + `-Wl,-dead_strip` | 16.69 MB | `temp/textsize/notxt_ds` |
| Same + glue `-ffunction-sections` + `-dead_strip` | 16.69 MB (ICU still present), and a combination **without** `-dead_strip` fails to link outright | `temp/textsize/notxt_fs` |
| `libicu.icudtl_dat.o` | **10.19 MB (single object)** | `ar tv vendor/skia/lib/macos-arm64/libicu.a` |
| Rust toolchain | **not installed** (`rustc`/`cargo`/`rustup` all `command not found`) | — |

> Measurement method: `ls -l` for byte counts / `size -m` for segment and section sizes /
> `nm | grep _icudt69_dat` to tell whether ICU data made it into the image.
> **These tables use decimal MB (10^6).** The previous revision's "18.53 MB / 15.91 MB / 9.71 MB" were
> the same artifacts read in MiB (19,429,928 B = 18.53 MiB, 10,185,576 B = 9.71 MiB) — the files did
> not change, only the unit is now uniform.
> Artifacts are kept in `temp/split/` and `temp/textsize/` (scratch directories, not committed).

### C. References

- [`flash-text.md`](flash-text.md) §1 (capability inventory) §2 (divergence list D-T1…D-T21) §5 (two-sided report conventions)
- [`skia.md`](skia.md) §2.9 (link, don't embed) §6.1 (rebuilding Skia) §6.4 (version selection) §6.9 (CoreText patch)
  §7 (multi-target) §8 (the two tiers of text + calibration history)
- [`html5-web.md`](html5-web.md) §3.1–§5.2 (web rendering, font injection, `SK_TRIVIAL_ABI`, `EXPORTED_FUNCTIONS`)
- [`swc.md`](swc.md) §9.2 (baked timelines / text characters baked into `TextField`s)
- [`compile.md`](compile.md) §2 (four sets of prebuilt dependencies) §4 (build manifest) §5 (multi-target table)
  §6.1 (target × package) §6.4 (manifest extension fields)
- [`size-optimization.md`](size-optimization.md) (`static`-ization + `-O2` tree-shake)
- `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` (current unicode/shaping switches)
- `vendor/provision/README.md` (the Windows MSVC ABI hard constraint)