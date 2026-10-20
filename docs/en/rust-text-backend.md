# Rust text backend: replacing SkParagraph with cosmic-text + swash for `TextField`

> **Status: research / evaluation document. Not implemented, carries no version number.**
> This document answers one question: **can we, and should we**, replace the `flash.text` typesetting
> engine (currently = Skia's SkParagraph + HarfBuzz + ICU) with a pure-Rust stack (cosmic-text +
> swash + rustybuzz), linked in as a static library.
>
> **One-line conclusion:**
> **We can, and the seam has existed all along** — on the C side the text engine is nothing but an
> opaque 15-function interface (`src/runtime.ts:8723–8745`); the generated C has no idea who is
> behind it. Swapping engines = swapping one `.a`.
> **But the set of situations where it pays off is very narrow**: not desktop and not web (the
> platform font managers already cover those, and SkParagraph has been calibrated value-by-value
> against `adl`). The only account that balances is **removing Skia's unicode/shaping stack from the
> link (measured ~13 MB, of which a single ICU data object alone is 9.71 MB)** — and that only holds
> when a **mobile target is actually being built and size is a hard constraint**. The real barrier is
> not linking: it is the catalogue of layout values calibrated against `adl` in `skia.md` §8 /
> `flash-text.md` §2, which would have to be **re-derived from scratch** on a completely different
> engine.
>
> **⚠️ Chapter 2 below corrects an intuition**: the ICU bulk is **not** introduced by the text path —
> a graphics-only application that draws no text at all produces a binary of **exactly the same size**
> (18.53 MB == 18.53 MB). See §2.4.

---

## 0. Scope

**In scope**: backend selection for `flash.text` layout / measurement / painting; the integration
shape of a Rust static library; per-platform impact.

**Out of scope**: the AS3 semantics of `TextField` itself (see [`flash-text.md`](flash-text.md));
Skia integration and the Metal backend in general (see [`skia.md`](skia.md)); SWC static-text baking
(see [`swc.md`](swc.md)); "should the frontend TS be ported to Rust" (a different question, answered
in §10).

**The only oracle**: AIR 51.4.1's `adl`. Every "matches / does not match" claim below is decided
value-by-value against `adl` (AGENTS §1.5).

---

## 1. Today: four layers, exactly one seam

```
① Generated readable C     as_tf_*  /  TextField_*     (emitted by emit.ts; the only place touching C strings)
        │  calls
② runtime.ts inline forwarders   as_skia_text_measure / as_skia_textlayout_*
        │  runtime.ts:8886+ (ASC_USE_SKIA)  or  runtime.ts:9547+ (pure-C all-zero stubs)
③ The C seam (extern, 15 functions)   src/runtime.ts:8723–8745
        │
④ Glue implementation      vendor/skia_glue.cc:1364–1960 (~600 lines)
        │                  SkParagraph / SkFontMgr / SkTypeface / HarfBuzz / ICU
⑤ Prebuilt Skia libraries  vendor/skia/lib/<platform>/
```

### 1.1 The seam is exactly 15 functions

| Group | Functions | Location |
|---|---|---|
| Single-line measure (2) | `sk_text_measure` / `sk_text_measure_n` | `runtime.ts:8723–8724` |
| Paragraph layout (13) | `sk_textlayout_new` / `_new_leading` / `_new_runs` / `_height` / `_max_width` / `_line_metrics` / `_line_box` / `_line_count` / `_paint` / `_delete` / `_glyph_position_at` / `_rects_for_range` / `_caret_rect` | `runtime.ts:8725–8745` |

A paragraph is an **opaque handle** (`void*`); the C side only queries it through those 13 functions
(height / width / line count / line box / caret / range rectangles) and paints it
(`_paint(para, canvas, x, y)`). **Not a single C struct exposes a SkParagraph type.**

> This is the product of the §2.9 rule ("link third-party libraries, do not embed them"): precisely
> because the seam is 15 opaque functions, "swap the engine" does not equal "change the architecture".

### 1.2 The platform font manager is already tiered

`sk_platform_fontmgr()` in `vendor/skia_glue.cc` dispatches per platform:

| Platform | Implementation | Location |
|---|---|---|
| macOS | `SkFontMgr_New_CoreText(nullptr)` | `skia_glue.cc:1240` |
| Windows | `SkAirFontMgr(GDI, DirectWrite)` — a two-tier fallback | `skia_glue.cc:1227–1235` |
| web / no platform | `SkFontMgr_New_Custom_Empty()` → `SkFontMgr_New_Custom_Data()` (fixed font data, scanned by FreeType) | `skia_glue.cc:1116–1126` |
| Android (future) | Skia already ships `SkFontMgr_New_Android` (reads `/system/fonts` + `fonts.xml`) | not wired up |

**This fact matters**: it means "mobile font matching is weak" is **not** a reason to adopt a Rust
text stack — all three platforms already delegate to the system font manager. See §7.

---

## 2. Size: the only account that balances (including one measured correction)

### 2.1 Archive sizes (measured locally, `vendor/skia/lib/`)

| Archive | macos-arm64 | wasm | windows-x64 |
|---|---|---|---|
| `icu` | 16.11 MB | 6.98 MB | 15.25 MB |
| `skunicode` | 16.17 MB | 7.04 MB | 15.37 MB |
| `skshaper` | 3.55 MB | 3.84 MB | 5.08 MB |
| `harfbuzz` | 3.48 MB | 3.78 MB | 4.96 MB |
| `skparagraph` | 0.45 MB | 0.45 MB | 0.75 MB |
| **text stack subtotal** | **~39.8 MB** | **~22.1 MB** | **~41.4 MB** |
| `skia` (reference) | 14.55 MB | 11.89 MB | 35.77 MB |

> Archive size ≠ final binary delta (the linker only pulls referenced members). The measured final
> numbers follow below.
> On Windows the archives are named `<name>.lib` with no `lib` prefix (they are MSVC ABI as standard —
> see `vendor/provision/README.md`).

### 2.2 The decisive fact: ICU data is **one indivisible 9.71 MB object**

```
$ ar tv vendor/skia/lib/macos-arm64/libicu.a | sort -k3 -n | tail -3
  9.71 MB  libicu.icudtl_dat.o     ← all UCD/CLDR/line-break/collation/charset data, one big object
  0.65 MB  __.SYMDEF
  0.14 MB  libicu.uchar.o
   (415 members total; everything else is tens-to-hundreds-of-KB of code objects)
```

`libicu.a` has 415 members, **but the data itself is a single object**. Any reference to a `u_*` API
drags that whole 9.71 MB into the binary (unless ICU was built with `-ffunction-sections` and the link
enables GC — it is prebuilt, so no). `libskunicode.a` **also contains a same-named, same-size
`libicu.icudtl_dat.o`**.

### 2.3 Measured final binaries (local, macOS arm64)

| Build | Binary | `__const` | ICU data symbol present |
|---|---|---|---|
| `examples/hello.as` (no Skia) | **0.78 MB** | — | no |
| Minimal Skia program (own `min.cc`: create a surface, draw a rect; **no glue**, only `-lskia -lskcms -lz -lm`) | **5.43 MB** | — | **no** |
| `examples/textflow.as` (has text, normal pipeline) | **18.53 MB** | 10.79 MB | **yes** |
| `examples/draw-over.as` (**draws no text at all**, normal pipeline) | **18.53 MB** | 10.79 MB | **yes** |
| Same + `-Wl,-dead_strip` | **15.91 MB** | — | **yes** |

Reproduction commands and artifacts live in `temp/textsize/` (`probe`=textflow, `notxt`=draw-over,
`minA`=minimal program).

### 2.4 ⚠️ Correction: ICU is not introduced by the text path

**Rows three and four** above are the most important measurement in this document:

> **An application that never calls `flash.text` and only draws `Graphics` produces a binary the same
> size as one with text (18.53 MB), with the same 10.79 MB `__const` and the same `_icudt69_dat`.**

Why: `vendor/skia_glue.cc` is compiled into **a single object file** `vendor/skia_glue.o` that holds
both the graphics and the text functions. An object file participates in the link **as a whole**, so
the `skia::textlayout::*` symbols it references (`StrutStyle`, `FontCollection`, `ParagraphBuilder`, …)
must be resolved; that pulls the whole chain `libskparagraph.a → libskunicode.a → libicu.a →
libicu.icudtl_dat.o (9.71 MB)` **even for a program that never draws a glyph**. Measured: compiling the
glue with `-ffunction-sections` and linking with `-Wl,-dead_strip` **still fails to link**
(`Undefined symbols: skia::textlayout::StrutStyle::StrutStyle()`) — ld64 still requires an object
file's undefined symbols to be resolvable.

**This correction changes the shape of the conclusion:**

1. "Swap the text engine to save size" **cannot stop at swapping the engine** — the glue must
   simultaneously **stop referencing** SkParagraph, i.e. the text glue has to be split into its own
   object / its own source file and **not participate in the link at all** for builds that do not use
   text.
2. Conversely, **a zero-risk win is currently being left on the table**: `-Wl,-dead_strip` (a grep of
   `build.ts` finds no `-Wl,-dead_strip` anywhere). Measured **18.53 → 15.91 MB (−2.62 MB)**, having
   nothing to do with Rust. *(Needs full-suite validation: ObjC categories / `constructor` attributes /
   typeinfo can be wrongly stripped under `-dead_strip`; `metal_glue.mm` contains ObjC classes, so
   `node test.ts` must be run before landing this.)*
3. The amount the text stack can **really** save: 18.53 − 5.43 ≈ **13.1 MB** (of which 9.71 MB is ICU
   data and ~3.4 MB is skunicode helper code + harfbuzz + skshaper + paragraph).

### 2.5 Current `args.gn` (the switches available for pruning)

Both `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` say:

```
skia_use_icu = true
skia_use_icu4x = false          ← ICU4X is itself a Rust, modular unicode library
skia_use_libgrapheme = false
skia_use_harfbuzz = true
skia_enable_skparagraph = true
skia_enable_skshaper = true
```

⇒ There are three **mutually independent** slimming routes, compared in §9. **Replacing the text
engine with Rust is only one of them, and not the cheapest.**

---

## 3. Candidate stack (Rust side)

| crate | Role | What it replaces | Note |
|---|---|---|---|
| `rustybuzz` | **shaping** | HarfBuzz | **It is a Rust port of HarfBuzz** ⇒ same shaping behaviour, low migration risk, but "removing HarfBuzz" is really "swapping in HarfBuzz's Rust version" |
| `ttf-parser` | font parsing / cmap / metrics | FreeType + SkTypeface | |
| `swash` | **rasterization + glyph cache** | SkScalerContext + SkGlyphCache | weak on colour emoji (CBDT/sbix) |
| `fontdb` | font enumeration / family matching | `SkFontMgr` | already covered per platform, see §1.2 |
| `cosmic-text` | **line breaking + paragraphs + caching** | SkParagraph (UAX#14) | depends on all of the above |
| `parley` (alternative) | line breaking + paragraphs | SkParagraph | same linebender family as `swash`, more active |

**The key trade-off**: shaping with `rustybuzz` means "same semantics" (good for `adl` alignment), but
it **does not remove the shaping logic itself**; what is genuinely removed is **ICU's unicode tables**
(9.71 MB) and the HarfBuzz/C++ implementation.

---

## 4. Integration shapes (three tiers)

| Tier | Approach | Verdict |
|---|---|---|
| **1. Full replacement**: Rust emits `(mask, x, y)`, C++ only composites into Skia | Add a shim in `vendor/` implementing the same 13 `sk_textlayout_*` names, compiled **either-or** with the implementations in `skia_glue.cc`; the generated C is untouched | ✅ **recommended** (the only shape that can deliver the §2 goal) |
| 2. Swap only the font database (`fontdb` → `SkFontMgr_New_Custom_Data`) | Replaces only "family matching" | ❌ already covered by the platform FontMgr (§1.2), gain ≈ 0 |
| 3. Two backends side by side (Skia and Rust both linked, switched at runtime) | For A/B work | ⚠️ only valid **temporarily**: two font stacks in one binary makes it the largest option |

**Why tier 1 still needs C++**: the destination of `_paint` is **Skia's `SkCanvas`**
(`sk_textlayout_paint(para, canvas, x, y)`). After Rust rasterises glyphs into alpha masks, someone
still has to composite them onto the Skia canvas (`SkImage::MakeRasterCopy` / `SkSurface`). So the
correct split is:

```
Rust: shaping + line breaking + rasterization → (glyph mask, x, y)   ← pure Rust, no ICU / no HarfBuzz
C++ shim: mask → SkImage → canvas->drawImage                         ← still Skia, but only "blitting"
```

---

## 5. Concrete integration steps

### 5.1 The Rust crate

```toml
# vendor/rust/textlayout-rs/Cargo.toml
[lib]
crate-type = ["staticlib"]          # → libtextlayout_rs.a
[profile.release]
panic = "abort"                     # no unwind runtime: smaller, and does not conflict with this repo's setjmp exception model
opt-level = "z"
lto = true
codegen-units = 1
```

```rust
// C ABI answering the 15 seam functions one-for-one (excerpt)
#[no_mangle] pub unsafe extern "C" fn rtl_text_measure(t: *const c_char, size: f64, b: c_int, i: c_int) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_new_runs(…) -> *mut Layout { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_height(p: *const Layout) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_line_metrics(p: *const Layout, …) -> c_int { … }
// rasterized output handed to C++ for compositing
#[repr(C)] pub struct RtlGlyph { pub x: f32, pub y: f32, pub w: u32, pub h: u32,
                                 pub stride: u32, pub mask: *const u8 }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_glyphs(p: *const Layout, out: *mut RtlGlyph, cap: u32) -> u32 { … }
```

### 5.2 C++ shim `vendor/textglue_rs.cc`

Implements the same 13 `sk_textlayout_*` names, forwarding to `rtl_*` internally; `paint` wraps the
mask into an `SkImage` and calls `drawImage`. Compile it **either-or** with the 13 implementations in
`skia_glue.cc` via a macro (one symbol cannot have two definitions) — `metal_glue.mm` /
`d3d_glue.cc` / `stage3d_webgl.cc` already follow exactly this pattern (§2.9).

> **At the same time the text section must be cut out of `skia_glue.cc`** (§2.4): as long as it still
> references SkParagraph, ICU is still there. This is the step most easily overlooked and the most
> critical one in this document.

### 5.3 Build manifest (the existing `objects` field suffices)

```json
{
  "objects": ["../../vendor/rust/libtextlayout_rs.a"],
  "defines": ["ASC_TEXT_RUST=1"],
  "link-paths": ["../../vendor/skia/lib/macos-arm64"]
}
```

Field definitions are in `src/build.ts:186–205`; `objects` lands at `build.ts:738`. **No new manifest
field is needed.**

### 5.4 Link order is correct by construction

The order in `build.ts:734–741` is: `generated .c → sources (our .cc) → objects (rust .a) → -L → -l →
-framework`. The static archive sits exactly after the objects that reference it — which is the
convention managed by the comment at `build.ts:743` (*"Static-archive order: libraries must follow the
objects that reference them"*).

### 5.5 The `--air-app` detection point

`air-app.ts` already has isomorphic precedents: `detectText` (`air-app.ts:168`), `detectStage3D`
(`air-app.ts:110`), `detectAudio` (`air-app.ts:180`), `findAppFonts` (`air-app.ts:827`). Adding a
`detectTextBackend` would inject `objects` + `defines` per target when generating the manifest.

### 5.6 Cross-compilation matrix (**this is where the real work is**)

One `.a` per target, mirroring the layout of `vendor/skia/lib/{macos-arm64,wasm,windows-x64,windows-x86}`:

| target | Rust target triple | Linker | Status |
|---|---|---|---|
| macOS arm64/x64 | `aarch64-apple-darwin` / `x86_64-apple-darwin` | `clang++` | ✅ buildable locally |
| Windows x64/x86 | `x86_64-pc-windows-msvc` / `i686-pc-windows-msvc` | `clang` (MSVC ABI) | ⚠️ must use the **MSVC ABI** like Skia does (see the hard constraint in `vendor/provision/README.md`) |
| web | `wasm32-unknown-emscripten` | `emcc` | ✅ target exists |
| WASI | `wasm32-wasip1` | `clang --target=wasm32-wasip1` | no GUI, unnecessary |
| iOS (planned) | `aarch64-apple-ios` | `clang` | pending target |
| Android (planned) | `aarch64-linux-android` | NDK clang | pending target |

### 5.7 Suggested phasing (if it is ever done)

| Phase | Content | Acceptance |
|---|---|---|
| P0 | **Do the low-risk items in §9 first** (`-dead_strip`, `skia_use_icu4x`) and re-take the size measurement | size + full regression |
| P1 | Desktop **A/B two backends** (tier 3): run the same `textfield` example twice and diff the two-sided `adl` reports to produce a **divergence list** | `flash-text.md` §5.1 numeric report |
| P2 | Calibrate item by item against the divergence list; switch the default once clear | divergence list empty (or honestly registered) |
| P3 | When a mobile target lands, enable the Rust backend **for that target only** | layered per target (`compile.md` §4.1) |

---

## 6. Per-platform analysis (the core of this document)

### 6.0 Summary table

| Platform | Status | Who does text today | Gain from Rust | Cost / risk | Verdict |
|---|---|---|---|---|---|
| **macOS native** | ✅ shipped | CoreText (fonts) + SkParagraph (layout) + this repo's CoreText patch | size ~13 MB | loses the benefit of `skia.md` §6.9's patch, emoji (Apple Color Emoji), and all `adl` calibration | ❌ don't |
| **Windows native** | ✅ shipped | GDI + DirectWrite two-tier fallback + Uniscribe shaping | size ~13 MB | must rebuild an equivalent DirectWrite fallback chain; emoji (Segoe UI Emoji) | ❌ don't |
| **Linux native** | ⛔ not provisioned | — (`vendor/skia/lib/` has no linux) | — | — | ⛔ nothing to analyse |
| **web (emcc)** | ✅ shipped | `SkFontMgr_New_Custom_Data` + runtime injection of `font-urls` | size (wasm text stack archive 22.1 MB; the `.wasm` first-load payload could shed on the order of ~7 MB) | the font-injection contract must be redone; but the **relative** first-load gain is the largest | ⚠️ **the most valuable tier** |
| **WASI (raw)** | ✅ shipped (no GUI) | **none** (all `as_skia_*` are zero stubs, `runtime.ts:9547+`) | 0 | 0 | ⛔ not involved |
| **iOS** (planned) | ❌ not started | CoreText planned (the patch already covers the iOS branch) | size + a pure-static-library shape that **natively fits** (iOS has no `dlopen` problem) | needs the target and an iOS Skia build first | ⏸ evaluate together with the target |
| **Android** (planned) | ❌ not started (`--package android-project` throws today, `index.ts:997`) | `SkFontMgr_New_Android` planned | size (APK-sensitive) + no need to write `fonts.xml` parsing ourselves | as iOS | ⏸ evaluate together with the target |

### 6.1 macOS native

- **Today**: `SkFontMgr_New_CoreText` enumerates system fonts; SkParagraph lays out; **plus a local
  patch to the third-party library** — `vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch`
  fixes CoreText swapping faces between two font files with the same family and PostScript name
  (`skia.md` §6.9, `flash-text.md` D-T15). After the fix, ink masks match `adl` at IoU 100%.
- **After Rust**: that patch's benefit disappears (the Rust side does not go through CoreText), while
  its own font-matching problems arrive; Apple Color Emoji's colour rendering is provided by CoreText,
  and `swash` is weak on CBDT/sbix.
- **Size**: ~13 MB.
- **Verdict**: ❌ **don't**. The gain is pure size; the cost is every behaviour already pinned down.

### 6.2 Windows native

- **Today**: `SkAirFontMgr(GDI, DirectWrite)` two-tier fallback (`skia_glue.cc:1227–1235`); the GDI
  backend shapes with Uniscribe (comment at `air-app.ts:676`). Skia ships x64/x86 libraries.
- **After Rust**: an equivalent fallback chain must be rebuilt (`fontdb` can read `C:\Windows\Fonts`,
  but DirectWrite's script-aware fallback is ours to write); emoji goes through Segoe UI Emoji.
- **Size**: ~13 MB (41.4 MB of archives → roughly 13 MB saved, same order as macOS).
- **Verdict**: ❌ **don't**, for the same reason as macOS.

### 6.3 Linux native

- `vendor/skia/lib/` contains only `macos-arm64` / `wasm` / `windows-x64` / `windows-x86`, **no linux**
  (`compile.md` §2 states "four sets of prebuilt dependency libraries"). So there is currently **no
  text stack on Linux to analyse**.
- If Linux is ever provisioned: Skia would use fontconfig (`skia_use_fontconfig` is currently `false`),
  while `fontdb` on the Rust side is actually simpler there. Leave this until a Linux target is
  proposed.

### 6.4 web / wasm (emcc)

- **Today**: `SkFontMgr_New_Custom_Empty` → `SkFontMgr_New_Custom_Data`, with font bytes fetched by the
  page JS and injected through `Module._sk_fontmgr_register_data(ptr, len)` (`html5-web.md` §4).
  `EXPORTED_FUNCTIONS` must export that entry point (`html5-web.md` §5.2).
- **A web-only trap lives here**: the sandbox has **no enumerable system fonts**; an empty `font-urls`
  leaves `sk_platform_fontmgr()` at `Custom_Empty`, so **drawString draws not a single glyph** while the
  build succeeds, the page runs and the trace looks fine (a silent failure — see the failure-mode note
  in `html5-web.md` §4).
- **After Rust**: the font-injection contract has to be redone (the same bytes must cross the wasm
  boundary to reach Rust), but **the seam can keep the same shape**: still "JS fetch → inject → must be
  in place before layout".
- **Gain**: the wasm text stack is 22.1 MB of archives, worth roughly 7 MB. **`.wasm` size is a
  first-load download cost**, so the size gain here is **worth more than on desktop** (desktop's 13 MB
  rides on an 18 MB binary, web's ~7 MB rides on a `.wasm` that is usually barely over 5 MB — a
  completely different relative magnitude).
- **Verdict**: ⚠️ **if a Rust text backend is ever built, this is the first candidate** (but compare it
  against the `icu4x` route in §9 first).

### 6.5 WASI (`--target wasm --package raw`)

- **Not involved**: the WASI artifact is a GUI-less command-line module with no rendering. In the pure-C
  branch every `as_skia_text_*` is an inline stub **returning 0/NULL** (`runtime.ts:9547+`).
- Swapping in any text engine does not affect WASI. **Zero gain, zero cost.**

### 6.6 iOS (planned)

- `compile.md` §6.1 already lists `--target ios` as a **planned** value (`clang --target=arm64-apple-ios`).
- **Rust's shape is actually an advantage on iOS**: iOS extensions/components are **statically linked
  into the application image**, with no `dlopen` step (the ANE entry in `TODO.md` already records this
  difference between iOS and macOS). A Rust `staticlib` is exactly that shape.
- On the font side, however: iOS is CoreText too, and the patch in `skia.md` §6.9 **already sits inside
  the `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS` branch** — i.e. the Skia-side font matching is already
  fixed for iOS.
- **Verdict**: ⏸ do not propose this separately; **evaluate it together with `--target ios`**.

### 6.7 Android (planned)

- `--package android-project` **throws outright** today (`src/index.ts:997`: `not yet implemented`), and
  `vendor/skia/lib/` has no android directory either.
- On the font side: Skia ships `SkFontMgr_New_Android` (reads `/system/fonts` + `fonts.xml`), which is
  less work than parsing `fonts.xml` in Rust ourselves ⇒ **font matching is again not a reason**.
- **Verdict**: ⏸ the only scenario that could make a Rust text backend pay is a **hard APK size
  constraint** (app-store limits). In that case the shape should be: **enabled for that target only**,
  via `targets.android` manifest layering (`build.ts:390–396`, whose semantics are **replace, not
  append**).

---

## 7. Advantages (item by item)

| # | Advantage | Magnitude / evidence | Platforms |
|---|---|---|---|
| A1 | **Drops the ICU data block** | a single 9.71 MB object, see §2.2 | all |
| A2 | **Drops skunicode + harfbuzz + skshaper + paragraph** | ~3.4 MB together (18.53 − 5.43 − 9.71) | all |
| A3 | **Pure Rust, no C++ dependency** | removes the `SK_TRIVIAL_ABI` / `-std=c++17` / MSVC ABI interlink constraints (`html5-web.md` §5.1, `provision/README.md`) | all |
| A4 | **Static-library shape suits mobile** | iOS has no `dlopen`; static linking is the only shape | iOS / Android |
| A5 | **Same shaping semantics** | `rustybuzz` is a Rust port of HarfBuzz ⇒ lower migration risk than a genuinely new shaper | all |
| A6 | **One engine across all platforms** | today macOS/Windows/web are **three** font managers plus two shaping paths | all |
| A7 | **Reproducible builds via `cargo`** | compared with rebuilding through gn+ninja in `build-tools/skia-src` (`skia.md` §6.1) | all |

## 8. Disadvantages and costs (item by item)

| # | Cost | What it actually is | Severity |
|---|---|---|---|
| B1 | **All `adl` calibration redone** | `flash-text.md` §2's D-T1…D-T21 plus the whole of `skia.md` §8: the break threshold is exactly `ceil(ink+4)`, `autoSize` only changes width when `wordWrap=false`, the trailing-space convention for `textWidth`, the `sy/sx` convention for `textWidth/Height` on a scaled field, glyphs scaled only by cumulative `scaleY`… all of it is **pinned to SkParagraph's behaviour** | 🔴 **most expensive** |
| B2 | **Line-box model re-derived** | `sk_air_line_metrics` + `sk_round_half` + `sk_set_air_strut` (`skia_glue.cc:1393–1457`) — AIR is `rhalf(ascent)+rhalf(descent)+leading(px)` and **never adds the line gap**; Skia is `ceil(ascent+descent+lineGap)`. That conversion matches nine named faces exactly; on a new engine it must be re-derived from scratch | 🔴 |
| B3 | **Family alias semantics** | `sk_family_alias` (`skia_glue.cc:1495`): `_sans→Helvetica`, `_serif→Times New Roman`, `_typewriter→Monaco`, `NULL→Times`, plus "**an uninstalled family falls back to the platform default face**" (`D-T17`, measured 6 px difference) | 🟠 |
| B4 | **Colour emoji** | `swash` is weak on CBDT/sbix bitmap colour fonts; CoreText (macOS) and DirectWrite (Windows) both support them out of the box | 🟠 |
| B5 | **Installed fonts ≠ enumerable fonts** | the web injection contract must be redone (§6.4); on native the platform fallback chain must be rebuilt | 🟠 |
| B6 | **Losing the glyph cache / performance** | `SkGlyphCache` and Skia's glyph atlas are free today; the Rust side must build its own (`swash` has `scale::Scaler`, but the cache is ours to manage) | 🟡 |
| B7 | **`skia.md` §6.9's patch benefit disappears** | the face-swap problem that patch fixes reappears in a different form on the Rust side (same family, same PostScript name) | 🟡 |
| B8 | **Toolchain into CI** | there is currently **no Rust toolchain on this machine** (`rustc`/`cargo`/`rustup` all `command not found`); CI would need cross-compilation for 5–6 targets | 🟡 |
| B9 | **Licence review** | Skia=BSD-3, ICU=Unicode License; the Rust side's `cosmic-text`/`swash`/`fontdb`/`rustybuzz`/`ttf-parser` licences must be reviewed item by item before deciding (**not reviewed in this document**; must be checked before landing) | 🟡 |
| B10 | **Two backends is the largest option** | during tier 3 (A/B), two font stacks sit in the binary at once | 🟡 |
| B11 | **The whole suite must be re-run** | 310 examples + the two-sided `textfield` report + structural nails such as `[textwrap]` | 🟡 |

### 8.1 Evidence for B1/B2: what these conventions look like

In the text section of `skia_glue.cc` (~600 lines), **most of the lines are not "drawing glyphs" but
"dragging Skia onto AIR's conventions"**:

```cpp
// AIR rounds each half of the line box to the nearest 0.5 and never adds the font's own
// line gap; Skia reports ceil-ish(ascent + descent + lineGap).
// Measured (Helvetica 9.24→9 / 2.76→3; Times New Roman 10.6875→10.5 / 2.59375→2.5):
// rounding the halves reproduces every named face's line height -- Courier 12,
// Courier New 13.5, Menlo 14, Monaco 15, Times 12, Times New Roman 13, Arial 13.5,
// Helvetica 12, Geneva 15.
static double sk_round_half(double v) { return floor(v * 2.0 + 0.5) / 2.0; }
                                                 // skia_glue.cc:1393
```

```cpp
// StrutStyle::leading does not reach the line box in this build (measured: leading=4 leaves a
// 2-line paragraph at 2*model) and a negative leading is clamped to 0 by Skia; so the leading
// must be folded into the height. And because Skia scales by (height * fontSize / rawFull),
// the height must be pre-multiplied by rawFull/rawSum.
strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));   // skia_glue.cc:1457
```

These two are **not things that can be "translated"; they are things that must be measured again,
probe by probe, against `adl`.** That is where B2's severity comes from.

---

## 9. Side-by-side: slimming without swapping the engine

**This section should come first.** The three routes are mutually compatible and differ by an order of
magnitude in cost:

| Route | How | Expected gain | Risk | Recommendation |
|---|---|---|---|---|
| **L1** | Link-time `-Wl,-dead_strip` (currently absent entirely) | **measured −2.62 MB** (18.53 → 15.91) | low (full regression needed to check ObjC categories/typeinfo) | ✅ **do first** |
| **L2** | Rebuild Skia with `skia_use_icu=false` + `skia_use_icu4x=true` | could remove most of the 9.71 MB (ICU4X data is **modular and prunable**, and ICU4X is itself **Rust**) | medium (must verify SkParagraph's line breaking/bidi still match; `build-tools/skia-src` already has the rebuild flow) | ✅ **immediately after L1** |
| **L3** | Rebuild Skia with `skia_use_libgrapheme=true` + `skia_use_icu=false` | more aggressive (libgrapheme is a tiny C library) | high (**libgrapheme does no bidi**, so paragraph direction degrades) | ⚠️ only if bidi is confirmed unnecessary |
| **L4** | Prune the codecs that `air-app.ts` lists 1:1 (`skottie`/`svg`/`dng_sdk`/`piex`/`expat`) | ~2.5 MB | low | largely covered by L1 |
| **L5** | **Swap in the Rust text engine** (the topic of this document) | ~13 MB | **high** (§8 B1/B2) | ⏸ only for mobile + a hard size constraint |

> L2 deserves emphasis: **ICU4X is Rust**. So the idea "use a Rust unicode library" does **not** require
> replacing the whole text engine — Skia itself exposes the `skia_use_icu4x` switch, at the cost of
> rebuilding Skia once.
> **Replace the ICU data block via L2 first, then decide whether the text engine needs touching at all.**

---

## 10. A side note: "so should the frontend TS be ported to Rust?"

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

## 11. Trigger conditions and decision tree

```
Is size a hard constraint?
├─ No ──────────────────────────► Don't. The ~13 MB text stack is a tolerable cost,
│                                 while the re-calibration cost of §8 B1/B2 far exceeds the gain.
└─ Yes
   ├─ Does that platform have rebuildable prebuilt Skia libraries?
   │  ├─ Yes ──► Do L1 (-dead_strip) + L2 (icu4x) first. That is usually enough.  ◄── recommended stopping point
   │  └─ No  ──► Provision first (neither Linux nor Android has Skia libraries yet)
   └─ Still insufficient after L1+L2?
      └─ Yes ──► Only then L5 (the Rust text engine),
                 and **only for that target** (targets.<target> layering, replace semantics)
```

**Concrete trigger** (all three must hold before starting L5):

1. `--target ios` or `--target android` **has landed** (both are "planned" today, `compile.md` §6.1);
2. that platform's **size is externally constrained** (app store / first-load budget);
3. L1 + L2 have been executed and **still fall short**, leaving measured data.

---

## 12. Appendices

### A. The 15 seam functions (complete current inventory)

| # | Function | Signature essentials | Current implementation |
|---|---|---|---|
| 1 | `sk_text_measure` | `(text, size, bold, italic) → double` | `skia_glue.cc:1559` (`SkFont::measureText`) |
| 2 | `sk_text_measure_n` | same + explicit byte count | `skia_glue.cc:1566` |
| 3 | `sk_textlayout_new` | flat single-style text | `skia_glue.cc:1624` |
| 4 | `sk_textlayout_new_leading` | + `leading` | `skia_glue.cc:1662` |
| 5 | `sk_textlayout_new_runs` | **rich text** (`sk_text_run[]`) | `skia_glue.cc:1716` |
| 6 | `sk_textlayout_height` | paragraph height | — |
| 7 | `sk_textlayout_max_width` | longest line width | — |
| 8 | `sk_textlayout_line_metrics` | per-line start/end/top/bottom | — |
| 9 | `sk_textlayout_line_box` | one line's ascent/descent/left/width | around `skia_glue.cc:1904` |
| 10 | `sk_textlayout_line_count` | line count | — |
| 11 | `sk_textlayout_paint` | **draw onto an SkCanvas** | — |
| 12 | `sk_textlayout_delete` | free | — |
| 13 | `sk_textlayout_glyph_position_at` | click → character index | — |
| 14 | `sk_textlayout_rects_for_range` | range → rectangles (selection/underline) | — |
| 15 | `sk_textlayout_caret_rect` | caret rectangle | — |

> There is also the **`sk_text_run` struct** (`runtime.ts:8456`), defined **unconditionally** (pure-C
> builds need it too); and the two **direct drawing** paths `sk_canvas_draw_text` /
> `sk_canvas_draw_text_n` (`skia_glue.cc:1542` / `:1551`), which bypass SkParagraph and do single-line
> work only.

### B. Measured data from this machine (2026-10-20, macOS arm64)

| Item | Value | Reproduction |
|---|---|---|
| Skia-free baseline binary | 0.78 MB | `node src/index.ts examples/hello.as -o temp/textsize/hello` |
| Minimal Skia program (no glue) | 5.43 MB, **no ICU data** | `temp/textsize/min.cc` + `temp/textsize/minA` |
| Text example binary | 18.53 MB (`__const` 10.79 MB, contains `_icudt69_dat`) | `temp/textsize/probe` (source `examples/textflow.as`) |
| **Graphics example** (no text) binary | **18.53 MB** (identical) | `temp/textsize/notxt` (source `examples/draw-over.as`) |
| Same + `-Wl,-dead_strip` | 15.91 MB | `temp/textsize/notxt_ds` |
| Same + glue `-ffunction-sections` + `-dead_strip` | 15.91 MB (ICU still present) | `temp/textsize/notxt_fs` |
| `libicu.icudtl_dat.o` | **9.71 MB (single object)** | `ar tv vendor/skia/lib/macos-arm64/libicu.a` |
| Rust toolchain | **not installed** (`rustc`/`cargo`/`rustup` all `command not found`) | — |

> Measurement method: `ls -l` for byte counts / `size -m` for segment and section sizes /
> `nm | grep _icudt69_dat` to tell whether ICU data made it into the image.
> Artifacts are kept in `temp/textsize/` (a scratch directory, not committed).

### C. References

- [`flash-text.md`](flash-text.md) §1 (capability inventory) §2 (divergence list D-T1…D-T21) §5 (two-sided report conventions)
- [`skia.md`](skia.md) §2.9 (link, don't embed) §6.1 (rebuilding Skia) §6.4 (version selection) §6.9 (CoreText patch)
  §7 (multi-target) §8 (the two tiers of text + calibration history)
- [`html5-web.md`](html5-web.md) §3.1–§5.2 (web rendering, font injection, `SK_TRIVIAL_ABI`, `EXPORTED_FUNCTIONS`)
- [`compile.md`](compile.md) §2 (four sets of prebuilt dependencies) §4 (build manifest) §5 (multi-target table)
  §6.1 (target × package) §6.4 (manifest extension fields)
- [`size-optimization.md`](size-optimization.md) (`static`-ization + `-O2` tree-shake)
- `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` (current unicode/shaping switches)
- `vendor/provision/README.md` (the Windows MSVC ABI hard constraint)