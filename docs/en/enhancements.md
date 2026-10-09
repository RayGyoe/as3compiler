# Enhancements Beyond AIR (gains on top of fidelity)

> This document answers two things: **what counts as "aligning with AIR" and what counts as an "enhancement"**
> (§1), and **which enhancements are actually worth doing under the "generate readable C + link the mature
> ecosystem" architecture** (§3 list, §4 key items).
>
> The conclusion up front: **alignment is the bottom line, an enhancement is a gain.** AIR semantics measured
> with `adl` are aligned verbatim; only where AIR **does not define / explicitly does not support / has no
> counterpart at all** is the scope of an enhancement.
>
> Adjacent docs: [`as3-semantics.md`](as3-semantics.md) §4/§5 (principles and divergences), `TODO.md`'s
> `### 增强待做` (scheduling), and the "Beyond AIR" section in [`README-CN.md`](../../README-CN.md).

---

## 1. Principles

### 1.1 The two underlying principles

1. **Fidelity is the bottom line (non-negotiable).** AIR-defined semantics must be aligned **verbatim** —
   error numbers, error text, event order and count, boundary values, API shape, all per the **measurement** of
   `$AIRSDK_HOME/bin/mxmlc` + `adl` (AGENTS.md §2.4). An enhancement **must not** rewrite any AIR-defined
   behavior: whatever the same `.as` is under `adl`, it must be the same in our output.
2. **An enhancement is a gain (whitelisted, must be argued).** An enhancement is allowed only where AIR
   **does not define / explicitly does not support / has no counterpart** it, and it **must be opt-in**. A
   default output that declares no switch stays isomorphic to AIR.

> In one line: **we are not "another AIR implementation", we are "AIR semantics + the native-C execution
> dividend".**

### 1.2 Criteria for an enhancement (all five must hold)

| # | Criterion | "Pseudo-enhancements" that get rejected |
|---|---|---|
| a | Falls **outside** AIR semantics: AIR never accepts that input / never provides that API / already errors on that path | Making `Loader` accept input AIR would reject and **changing** its return semantics — that is changing semantics, not an enhancement |
| b | **Never silent**: when a capability is missing, state "this backend / this build does not support X", without degrading or pretending success | An unsupported input falls back to an empty object / `0×0`, looking like success |
| c | **Cross-end capability differences must be listed explicitly**: when native has it and web does not (or vice versa), both the docs and the runtime error text must say "which end, missing what, how to enable it" | Only writing "not supported", without saying which end or why |
| d | **opt-in and does not bloat the default output**: the switch is off by default; the default build stays zero-dependency and self-contained (AGENTS.md §2.6/§2.9) | Making every user's default binary link an extra 1.4 MB for one optional enhancement |
| e | Passes DoD: `examples/*.as` + assertion regression + docs sync + version bump | Writing only code, without examples and regression |

### 1.3 Why an enhancement is worth it here (the architectural dividend)

AIR's capability ceiling is locked by the **AVM2 runtime + Flash sandbox** — what it can do depends on which
classes Adobe compiled into the runtime back then. Our output, by contrast, is **a readable C file handed to
`clang -O2`**, which yields four dividends AIR cannot get:

- **Link the mature ecosystem**: Skia (vector / typesetting / filters / codecs), libcurl + nghttp2 (network),
  SQLite, … linked in with `-l`, rather than rewritten by hand (AGENTS.md §2.9).
- **Reap the compiler dividend**: LTO / PGO / `static`-ized tree-shake are all freebies of the "generate C"
  path.
- **Interop with the host C**: the generated C is in the same translation unit as the host program, so it can
  call host functions directly (FFI) — something a bytecode interpreter cannot do.
- **Step beyond browser / desktop**: the same C compiles to native / WASI / web, and can also run
  **windowless server-side rendering**.

**This is not compatibility debt, it is an architectural dividend** — provided §1.2's five criteria hold;
otherwise "enhancement" degenerates into "semantic drift".

### 1.4 How to enable an enhancement: named switches (`--features`)

Criterion (d) requires an enhancement to be **opt-in**, and the concrete form of opt-in is unified in this
project as a **named switch**:

```bash
as-aot app.as --air-app app.xml --features svg     # equivalent to -D ASC_USE_SVG=1
```

The same-named manifest field (`"features": ["svg"]`) has identical semantics. Why not let the user write the
macro directly:

| | `-D ASC_USE_SVG=1` | `--features svg` |
|---|---|---|
| Discoverability | The macro name appears only in the docs body | `--help` lists the names; errors list the known names too |
| Typos | Silently ineffective (clang ignores unused macros) — **exactly what (b) forbids** | `unknown feature 'sgg' (known: formats, raw, svg)` and exits before generating code |
| Cross-end capability | The user must know web cannot build it | `feature 'svg' is not available with --target wasm` stated directly (criterion c) |
| Once enabled | Silent | A build banner names it `== enhancements: svg (-D ASC_USE_SVG=1) ==`, and states explicitly that this is an AIR superset |
| Set semantics | Can only append | `--features` **replaces** the whole set (`-D` appends), so "keep only X" is expressible; `--features none` clears it |

**Only channels that are truly implemented end-to-end are registered as names.** Registering an unimplemented
switch is worse than not providing one — it gives the user something that "looks enabled but is not actually
compiled in". So three are currently registered: `svg` (E1), `formats` (E3), `raw` (E4); E2 (Lottie) will be
registered once implemented. The table below lists the currently effective names and macros (`--help` and the
error text both list them):

| Name | Macro | Available compile targets | Channel opened |
|---|---|---|---|
| `svg` | `ASC_USE_SVG=1` | native | E1: `Loader` decodes SVG (web has no svg/sksg/expat archives) |
| `formats` | `ASC_ALLOW_EXTRA_FORMATS=1` | native / wasm | E3: extra image formats WebP / BMP / ICO |
| `raw` | `ASC_ALLOW_RAW_FORMATS=1` | native | E4: camera RAW / DNG (web has no piex/dng_sdk archives) |

**Default refusal (stage ninety-four · twenty-five)**: the E3/E4 channels were previously "usable with zero
code" — our Skia already carries those codecs, so the **default output was wider than AIR**: AIR reports
`#2124` for BMP/WebP/ICO/DNG uniformly, while we decoded them. This violates criterion (d) (the default output
must be isomorphic to AIR) and §1.5, so both channels were changed to **refuse by default**: the glue layer
blocks those families by magic number (PNG/JPG/GIF are unaffected), and after blocking it takes the existing
`#2124` failure path — **reporting an error verbatim identical to `adl`**. Only opening the switch decodes,
and the build banner names it (never silent once opened).

**Interaction with `--air-app`**: `--air-app` rewrites the generated `<filename>.build.json` wholesale on
every run, so the choice must survive the rewrite — `--features svg` writes it into the manifest, so the
**next run without arguments still takes effect** and prints a carry-over note (not silent); `--features none`
turns it off. Only `features` is inherited; the other fields remain functions of the descriptor + sources.

The detailed rules are in [`compile.md`](compile.md) §3.4.2; the regression nails are in `test.ts`'s
`[features]` group (24 items, including 4 reverse-control mutations: switch ineffective / enabled by default /
persistence lost / unknown name silent, all caught).

---

## 2. Difference from "legacy to develop"

| | Nature | Home | One-line criterion |
|---|---|---|---|
| **Legacy to develop** | **Defect / incomplete alignment** — AIR has it, we do not, or we have it but unfaithfully | `TODO.md`'s `### 遗留待开发` | Run `adl` and you immediately see **where the difference is** |
| **Enhancement to do** | **A gain beyond AIR** — AIR does not have it, we may | §3 of this doc + `TODO.md`'s `### 增强待做` | Run `adl` and AIR **already errors / does not have it at all** |

The criterion is hard: **for the same input, if `adl` produces a correct result and we cannot → that is a
legacy defect; if `adl` itself errors on the same input (or the API does not exist in AIR at all) → only then
does our building it count as an enhancement.** Example: `Loader.load("*.svg")` on `adl 51.4.1` is measured to
be `Error #2124: Loaded file is an unknown type.`, so "supporting SVG" is an enhancement, not closing a gap.

---

## 3. Enhancement backlog

> **6 items completed**: E1 SVG (native half), E3 multi-format decoding, E4 RAW/DNG (native half), E9 64-bit
> integers, E13 LTO/PGO, E16 refresh-rate query.
>
> Status contract: **already have** = usable now (may just be undocumented / without an example); **half-done**
> = the library exists, the AS3 surface is missing; **to build** = needs new glue or a toolchain change. "web
> needs rebuild" in the target-ends column = needs a change to `build-tools/skia-src/out/wasm/args.gn` and a
> rebuild of the wasm Skia.

| # | Enhancement | AIR status | Our status | Target ends | Cost |
|---|--------|---------|-----------|--------|------|
| E1 | **SVG runtime decoding** (`Loader.load("*.svg")` → `Bitmap`) | ✗ never supported (measured `#2124`) | ✅ **native implemented (opt-in)**: with `--features svg` (= `ASC_USE_SVG=1`) all four decode entry points support it; web has no svg/sksg/expat libraries and is **not supported** | native done / web needs rebuild | native **done** |
| E2 | **Lottie vector animation** (Skottie playing `.json`) | ✗ no counterpart | native: `libskottie.a` already built + linked, missing player API | native ready / web needs rebuild | medium |
| E3 | **Multi-format image decoding** (WebP / BMP / ICO) | partial: only JPG / PNG / GIF (measured: `adl 51.4.1` reports `#2124` for BMP/WebP/ICO) | ✅ **implemented, opt-in named switch `--features formats`**: the default build **reports `#2124` just like AIR**; once the switch is on, both ends measured to **decode correctly** (see §4.3); `QOI` is **not** included (no `SkQoiCodec` compiled in) | both ends | **done (default-refuse + switch)** |
| E4 | **Camera RAW / DNG decoding** | ✗ (measured: `adl 51.4.1` reports `#2124` for `.dng`; `BitmapData.loadFile` **does not even exist**, `#1069`) | ✅ **implemented, opt-in named switch `--features raw`**: the default build reports `#2124` just like AIR; once the switch is on, all four native decode entry points decode DNG 600×338 (see §4.5); the web-side wasm Skia has **no** piex/dng_sdk archives (measured `nm`: 0 `SkRawDecoder` symbols) ⇒ the switch is **pre-rejected** on wasm, naming the missing archive | native done / web isomorphic to AIR | **done (default-refuse + switch)** |
| E5 | **Vector graphics straight to screen** (`Shape` via `SkPath`, infinite resolution) | ✗ (`BitmapData` is bitmap-only) | Skia is already there, the AS3 surface is missing | both ends | medium |
| E6 | **Raw shader passthrough** (MSL / GLSL ES) | ✗ (only the AGAL register language) | The AGAL→MSL/GLSL translator already exists (`ASC_AGAL_TARGET`), missing the extension API for "submitting a native shader" | both ends | medium |
| E7 | **General-purpose GPU compute** (Metal compute / WebGL2 transform feedback) | ✗ | Needs a new glue layer | both ends | high |
| E8 | **Windowless / server-side rendering** | half (offscreen possible, but bound to the AIR runtime) | **already present**: headless runs, and `stage.render()` produces a PNG directly | both ends | already have |
| E9 | **64-bit integers** (`int64` / `uint64`) | ✗ (`int` / `uint` are both 32-bit) | ✅ **implemented (opt-in, pure C, same shape both ends)**: types + `L`/`UL` literals + `int64()`/`uint64()` conversions + 64-bit arithmetic/bitwise/comparison + a dedicated box tag (see §4.7) | both ends (native / web / WASI, the same C) | **done** |
| E10 | **`Vector.<Number>` batch SIMD** (NEON / SSE) | ✗ | Native C + `-O2` auto-vectorization already partly effective, can be made explicit | both ends | medium-high |
| E11 | **FFI: declare and directly call host C functions** | ✗ | **the unique dividend of "direct-to-C"** (same translation unit as the host) | native | medium |
| E12 | **Truly-concurrent `Worker` (OS threads)** | partial (AIR Workers are limited, need `flash.concurrent`) | A 4-worker pool already exists (currently serving only async I/O) | native | medium |
| E13 | **LTO / PGO build switches** | — | ✅ **implemented**: manifest `lto`/`pgo`/`pgo-dir` + CLI `--lto`/`--pgo`/`--pgo-dir`, **all off by default** (see §4.4) | both ends | **done** |
| E14 | **Frame recording / deterministic replay** | ✗ | Self-held by the runtime (frame boundaries, events, and the random source are all in our hands) | both ends | medium |
| E15 | **Readable C as a first-class deliverable** (embeddable in a host project / hand-auditable) | ✗ | **already promised** (README: "keep the `.c` for readability") | both ends | already have |
| E16 | **Display refresh-rate query** (`VsyncStateChangeAvailabilityEvent.refreshRate`) | ✗ **no refresh-rate query API at all** (measured: `adl 51.4.1` dispatches `vSyncStateChangeAvailability` once with only a read-only `available=false`) | ✅ **implemented**: the event gains a read-only `refreshRate:Number` (the constructor's 5th, **optional** parameter, default `0`); dispatched once at the first known frame after startup, and again each time the window lands on a display of a different rate | both ends (**web/offscreen has no counterpart ⇒ honestly does not dispatch**, no faking `0`) | **done** |

---

## 4. Notes on key items

### 4.1 E1 — SVG runtime decoding (flagship item) — ✅ **native done (opt-in)**

**Why it counts as an enhancement**: AIR's `Loader` spec is consistent in three places — the class description
"load SWF files or image (JPG, PNG, or GIF)", `load()` "SWF, JPEG, progressive JPEG, unanimated GIF, or PNG",
and `loadBytes()` "SWF, GIF, JPEG, or PNG". **SVG was never within Loader's supported range** (SVG import in
the Flash Pro era was a **creation-time** conversion, not runtime decoding). On this machine, `adl 51.4.1`
measured against the same-URL SVG and PNG:

```
AIR|IO_ERROR | crossplatform.svg | Error #2124: Loaded file is an unknown type. URL: …/crossplatform.svg
AIR|COMPLETE | ane-icon-black-border.png | 320x320 bytesTotal=8875
```

**Why it currently fails**: the existing decode path is `SkImages::DeferredFromEncodedData` → `SkCodec`, and
**SVG is not a SkCodec format** (it necessarily returns null and falls into `AS_JOB_ERR_DECODE`). SVG's correct
path is a different one:

```
SkSVGDOM::Builder::make(SkStream)  →  SkSVGDOM::render(SkCanvas)  →  rasterize to SkSurface  →  SkImage
```

i.e. "parse → render → get image", **a new decode channel, not a branch added to the existing one**; `<text>`
also needs `SkFontMgr`, and external links / `<use>` need a `ResourceProvider`.

**Asymmetric capability between the two ends (a canonical §1.2c case)**:

| | native | web |
|---|---|---|
| Does Skia have SVG compiled in | ✅ `skia_enable_svg=true` + `skia_use_expat=true` → `libsvg.a`(439 KB) + `libsksg.a` **already built** | ❌ `skia_use_expat=false`, the svg target is gated by `if (skia_enable_svg && skia_use_expat)` → **no `libsvg.a`** |
| Already linked | ✅ `air-app.ts`'s `linkLibs` already contains `svg`/`sksg`/`skottie`/`skresources` | ❌ not in the wasm library table |
| To do it | Only need to wire `SkSVGDOM` into the decode path (glue + runtime + emit) | Also need to change wasm `args.gn` (`skia_use_expat=true`) and add **expat / skresources / svg / sksg** four libraries, **rebuilding wasm Skia** |

> Note: although native is "already linked", nothing references it, so those targets in the static library are
> **automatically stripped** by `-O2`'s call-graph analysis (`nm` finds no `SkSVGDOM`) — a normal result of
> §2.6's `static`-ization optimization, not a missing library.

**Recommendation**: do the **native half** first (the library is ready, the cost is only glue), and touch the
toolchain for the web half on demand; write the two-end difference into the docs and error text per §1.2c.

#### Result (stage eighty-nine · sixty-five)

**The native half was done**, and made **opt-in** per §1.5 (the default build stays verbatim-isomorphic to
AIR):

| Build | `Loader.load("x.svg")` |
|---|---|
| default (no enhancement switch) | `ioError #2124 Error #2124: Loaded file is an unknown type.` — **verbatim identical** to `adl 51.4.1` |
| `--features svg` (= `-D ASC_USE_SVG=1`) | decode succeeds (size/pixels correct) |

**Implementation** (all in `vendor/skia_glue.cc`, adding a uniform "after the codec fails" fallback to all four
decode entry points):

```
sk_svg_header(data,len)                 // cheap sniff: after skipping BOM/whitespace the first byte is '<'
SkSVGDOM::Builder()
    .setFontManager(sk_platform_fontmgr())   // without it <text> draws not a single glyph
    .make(SkMemoryStream)
→ setContainerSize(the document's own width/height; the spec default 300×150 if absent)
→ SkSurfaces::Raster(N32/premul) + clear(TRANSPARENT) + dom.render(canvas)
→ makeImageSnapshot → (SkImage) or readPixels into straight-ARGB
```

The four entry points covered: `sk_image_from_file`/`sk_image_from_bytes` (Loader's display-list view) and
`sk_image_decode_argb`/`sk_image_decode_bytes_argb` (BitmapData's CPU pixels). Measured
(`temp/codec-probe/svg-probe.as`, the same source compiled twice):

| Path | default | `--features svg` (= `ASC_USE_SVG=1`) |
|---|---|---|
| `Loader.load("t.svg")` (file) | `ioError #2124` | ok 37×23 `tl=ff0000` |
| `Loader.loadBytes(svg bytes)` | `ioError #2124` | ok 37×23 |
| `BitmapData.loadFile("t.svg")` | unchanged (1×1) | ok 37×23 |
| a document with only relative units (`width="100%"`) | `ioError #2124` | ok **300×150**, content colors correct |
| a document containing `<text>` | `ioError #2124` | ok 120×30, **97 dark pixels** in the text area (**0** without a font manager, reverse-controlled) |
| `t.png` (reverse control) | ok 37×23 | ok 37×23 (still goes through the codec, not intercepted by the SVG path) |

**Incidentally fixed a pre-existing defect it exposed**: on a successful decode,
`BitmapData.loadFile` did `free(bd->pixels)`, but `pixels` has been on the **GC heap** since stage eighty-nine
/ forty-two — `free`ing a GC buffer corrupts the GC free list (exactly the rule already noted in
`BitmapData_dispose`). **Measured `abort()`**, and **unrelated to SVG**: in the default build, calling
`loadFile` on an **ordinary PNG** crashes just the same. It had gone unnoticed because no regression ever ran a
**successful** `loadFile` (the probes all fed undecodable files, never reaching that branch), and
`Loader__imageFinish`'s identical `free(bd->pixels)` was masked by being `free(NULL)` (its BitmapData is built
0×0 and the constructor leaves pixels NULL). Both were changed to "drop the reference, do not free", with
regression nails added (see `test.ts`'s `[svg]` group).

**The web end is not done**: `vendor/skia/lib/wasm` has **no** `libsvg.a`/`libsksg.a`/`libexpat.a` at all
(`args.gn`'s `skia_use_expat=false` gates off the svg target entirely), so defining `ASC_USE_SVG` fails at
**link time** — an explicit error, not a silent downgrade. Supporting it requires changing the wasm `args.gn`
+ adding four libraries + **rebuilding wasm Skia**, an independent effort.

**Why it is not an `examples/` unit**: it needs Skia linked **and** the `ASC_USE_SVG` macro, whereas every
examples entry in the regression suite runs on a **bare manifest (pure-C mode)**, so coverage lands in
`temp/codec-probe/svg-probe.as` (evidence) + `test.ts`'s `[svg]` 8 structural nails (including 4 reverse-control
mutations, all caught).

### 4.2 E2 — Lottie vector animation

AIR has no counterpart at all (there is no vector-animation player in `flash.display`). Skia's Skottie
(`libskottie.a` + `libskresources.a`) is already built on native and already in the link table; all that is
missing is an AS3 surface (e.g. a `LottieSprite extends DisplayObject`, or making `Loader.load("*.json")`
recognize Lottie). Likewise an "beyond AIR" enhancement, and likewise with a native / web asymmetry (web needs
a rebuild).

### 4.3 E3 — Multi-format image decoding — ✅ **done (default-refuse + `--features formats`)**

The existing decode goes through `SkCodec`, and Skia's codecs are **already compiled into both ends**
(`libwebp_decode=true` and `wuffs=true`). Measured conclusion: **WebP / BMP / ICO decode right now, with no
line of code** — unlike SVG, they **are** SkCodec formats and go through the existing channel. Probe
`temp/codec-probe/codec-probe.as` (the same source built with the native manifest and the web manifest), each
cell checking **size and pixels** (top-left should be `ff0000` red, bottom-right `ffff00` yellow):

| Format | AIR (`mxmlc` + `adl 51.4.1`) | Our native | Our web |
|---|---|---|---|
| PNG (control) | ok 37×23 | ok 37×23 `ff0000` | ok 37×23 `ff0000` |
| JPG (control) | ok 37×23 | ok 37×23 `fe0000` | ok 37×23 `fe0000` |
| GIF (control) | ok 37×23 | ok 37×23 `ff0000` | ok 37×23 `ff0000` |
| **BMP** | **`ioError #2124` unknown type** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| **WebP** | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| **ICO** | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |

- The AIR side is the **authoritative criterion** (AGENTS.md §1.5): `#2124` shows these three **really are
  beyond AIR**, so this item is an **enhancement** rather than a debt.
- The web side was obtained by running the same page in headless Chrome (`ascErrors` empty), **cell-for-cell
  identical** to native.
- **QOI is not in the supported range**: `SkQoiCodec` is not compiled in (`args.gn` has no `skia_use_qoi`).
  Supporting it requires enabling that switch and **rebuilding Skia on both ends**, a separate effort (of the
  same shape as SVG/Lottie's web side, see §1.2c).
- Incidental finding: `SkRawCodec` is **already compiled in** on native (13 symbols), a ready channel for E4
  (camera RAW/DNG).

**Settled (stage ninety-four · twenty-five): take (b), refuse by default.** Per §1.5/§1.2d an enhancement must
be opt-in — the default output must be isomorphic to AIR, and these three formats were previously **passively**
allowed (the default build accepted input AIR would reject). Now the glue layer (`vendor/skia_glue.cc`'s
`sk_extra_format_refused`) blocks WebP (`RIFF....WEBP`) / BMP (`BM`) / ICO (`00 00 01 00`, same family as CUR)
by magic number, and after blocking it takes the existing decode-failure path ⇒ reports `#2124`, **the text
verbatim identical to `adl`**; PNG/JPG/GIF magic numbers cannot collide with those (`89 50 4E 47` / `FF D8` /
`GIF8`), so they are unaffected. How to enable:

```bash
as-aot app.as --air-app app.xml --features formats     # equivalent to -D ASC_ALLOW_EXTRA_FORMATS=1
```

Measured (`temp/codec-probe/codec-probe.as`, the same source built three times; `bash temp/codec-probe/run.sh`
reproduces it in one shot):
default → BMP/WebP/ICO all `ioError #2124 Error #2124: Loaded file is an unknown type.`;
`--features formats` → the three `ok 37×23 tl=ff0000 br=ffff00` (same values as the table above);
PNG/JPG/GIF normal in all three builds.
**Both ends measured**: the web side builds the same source with `codec-web.build.json` and reads
`window.__ascStdout` in a headless browser — the default build is line-for-line identical to native/`adl`
(BMP/WebP/ICO all `#2124`), `--features formats` likewise gives `ok 37×23 tl=ff0000` for the three, and SVG
stays `#2124` in both (each switch is separate). **WBMP is deliberately not blocked**: `SkWbmpCodec` is
compiled in, but its header is a bare multi-byte type field with no reliable magic number, so we would rather
record it honestly here (see the end of §4.3) than guess a criterion that might harm a real format.
`QOI` is still not in the supported range and requires rebuilding Skia on both ends (see above).

### 4.4 E13 — LTO / PGO build switches — ✅ **done**

"Enhancement" in its purest form: this is not a language feature, but putting **mature compiler capabilities**
(`-flto`, profile data) into the user's hands, hand-writing not one line of optimization (§1.1). The manifest
`lto`/`pgo`/`pgo-dir` and the CLI `--lto`/`--pgo`/`--pgo-dir` are two equivalent routes, **all off by
default** — when unset, the output is byte-for-byte identical to before, so it does not violate "the default
output stays isomorphic to AIR".

The one substantive design point: `-flto` must be on **both** the compile step and the link step. Adding it to
only one side does not error, it merely **silently has no effect**, which is exactly the class of failure
§1.5's "never silent" targets; so the flags are supplied by a single `perfFlags()` to the four command
constructors, the regression asserts **every step** for native/web, and a reverse control was done (omitting
either step → the test fails immediately; measured: all 4 mutations caught). `-fprofile-correction` is
**deliberately not emitted**: that is a GCC flag, which clang merely warns `not supported` about and then
ignores.

Measured (`temp/perf/`, a 900k-call dense loop, median of five): `-O2` ~30.6 ms → `-O2 -flto` ~25.6 ms (about
16%), with no measurable gain from adding PGO; the three checksums are completely identical (only faster, no
semantic change). **We do not claim PGO is a universal speedup** — this workload has simple branches, whereas
PGO's benefit surface is programs with many branches/indirect calls. See [`compile.md`](compile.md) §4.2.

### 4.5 E4 — Camera RAW / DNG decoding — ✅ **done (default-refuse + `--features raw`)**

A case of the same shape as E3 — "thought we needed to write code, measured that the channel was already
open". Camera RAW (DNG/CR2/NEF/ARW…) is **not** a format AIR supports: on `adl 51.4.1`, item by item against a
real DNG:

| Entry point | AIR (`adl 51.4.1`) |
|---|---|
| `Loader.load(new URLRequest("file://…/sample_1mp.dng"))` | `ioError #2124 Error #2124: Loaded file is an unknown type.` |
| `Loader.loadBytes(ByteArray)` (the same bytes) | `ioError #2124` |
| `BitmapData.loadFile(...)` | **method does not exist**: `#1069 Property loadFile not found on flash.display.BitmapData and there is no default value.` (only dynamic access compiles; mxmlc errors "possibly undefined" on a static reference) |
| `t.png` (control) | `ok 37×23 tl=ff0000` |

And our native build (since stage ninety-four · twenty-five, **refusing by default**, see below):

| Entry point | Our native (default) | Our native (`--features raw`) | Our web (any case) |
|---|---|---|---|
| `Loader.load` | **`ioError #2124`** (verbatim identical to AIR) | **`ok 600×338`** | reports `#2124` just like AIR |
| `Loader.loadBytes` | **`ioError #2124`** | **`ok 600×338`** | — |
| `BitmapData.loadFile` (our own String channel) | fails (still 1×1) | **`ok 600×338`** | — |
| `BitmapData.draw` another DNG (`dng_with_preview.dng`) | **`ioError #2124`** | **`ok 600×338`** | — |
| `t.png` (control, guarding against the RAW channel intercepting) | `ok 37×23 tl=ff0000` | `ok 37×23 tl=ff0000` | `ok` |
| `t.svg` (non-RAW, still follows existing rules) | `ioError #2124` | `ioError #2124` | `ioError #2124` |

Implementation of default-refusal: `sk_extra_format_refused` recognizes the TIFF header (`II*\0`/`MM\0*` — the
common header of all TIFF-family RAW such as DNG/CR2/NEF/ARW/ORF/RW2) and `FUJIFILMCCD-RAW` (RAF), and on a
hit returns NULL, taking the upper layer's existing `#2124` path. The switch:

```bash
as-aot app.as --air-app app.xml --features raw     # equivalent to -D ASC_ALLOW_RAW_FORMATS=1
```

**Why zero code was needed at first** (now blocked by the default-refusal gate, see above): RAW in Skia is
`SkRawDecoder` (`include/codec/SkRawDecoder.h`), enabled by `skia_use_dng_sdk` + `skia_use_piex`, which is
exactly how this machine's native Skia is built (measured `nm`: three `SkRawDecoder::Decode`/`IsRaw` symbols in
`libskia.a`), and it is **already in Skia's default codec table** (`SkRawDecoder::IsRaw` is always true; the
comment explicitly says "always checked last") — so the existing `DeferredFromEncodedData` channel **would**
have passed DNG to it anyway. On native, `libpiex.a`/`libdng_sdk.a` were already in the link table.

**The web side is a natural honest gap**: `vendor/skia/lib/wasm/libskia.a` has **0** `SkRawDecoder` symbols,
and `vendor/skia/lib/wasm/` has no `libpiex.a`/`libdng_sdk.a` (the wasm `args.gn` does not enable the two
switches) ⇒ the web build reports `#2124` for DNG **verbatim identically** to AIR, without silently degrading
(§1.2c). Supporting it requires rebuilding wasm Skia, an independent effort.

**Measured boundary**: only **DNG** was verified (three ready samples, `resources/images/*.dng` in the Skia
source tree). Other RAW families such as `.cr2`/`.nef`/`.arw` go through the same piex channel, but **there is
no sample on this machine, so it was not measured** — per §1.5 it is recorded as "unverified" rather than
"supported".

**Coverage arrangement**: like E1/E3, it does not go into `examples/` regression (it needs Skia linked);
evidence lands in `temp/codec-probe/raw-probe.as` (our side, four entry points + reverse control) and
`temp/codec-probe/RawAdl.as` (the AIR-side baseline, `adl 51.4.1` output item by item), with the manifest
`temp/codec-probe/codec-raw.build.json`.

**The same item as E3, likewise settled (stage ninety-four · twenty-five: default-refuse + `--features
raw`)**. The web side cannot be switched on without a switch either: `--features raw --target wasm` is
**pre-rejected** with a direct statement of which archive is missing
(`the wasm Skia has no piex/dng_sdk archive ...`), rather than vomiting a screen of `undefined symbol` (§1.5,
cross-end differences listed explicitly).

### 4.6 E11 — FFI: directly calling host C functions

This is the dividend **unique** to "generating C directly": the output is in the same translation unit as the
host program, so a metadata declaration + a generated `extern` declaration suffices to call directly. A
bytecode interpreter (including AIR) structurally cannot do this. A typical enhancement, but **only holds on
native** (web is sandbox-limited and must explicitly report "this backend does not support FFI" per §1.2c).

### 4.7 E9 — 64-bit integers `int64` / `uint64` — ✅ **done (opt-in)**

**Why it counts as an enhancement**: AIR's numeric types are only `Number` (double) and `int`/`uint` (32-bit);
there is **no** 64-bit integer type — `mxmlc` reports an unknown type for `var x:int64` outright, and `adl`
can never run such code. So accepting these two type names **cannot** rewrite any AIR-defined behavior
(§1.2a), while the benefit is real: C's `int64_t`/`uint64_t` are native types, and the output is a single
64-bit add (per §1.2d, source not using these two types produces byte-for-byte identical output to before).

**How to use it** (the complete contract is in `examples/stage94t.as`'s comments and `test.ts`'s `[int64]`
nails):

```as3
var a:int64  = 9223372036854775807L;        // L suffix ⇒ int64 literal (the number is emitted from the source text)
var u:uint64 = 18446744073709551615UL;      // UL / LU ⇒ uint64
var exact:*  = int64("9007199254740993");   // a dynamic value is also preserved verbatim (not via double)
trace(a - 1L, u + 1UL, exact, a is int64);
```

| Rule | Contract | Rationale |
|---|---|---|
| Literals | `123L` → int64; `123UL`/`123LU` → uint64 | The number is **emitted from the source text** as `INT64_C(...)`/`UINT64_C(...)`; going through double would already have rounded above 2^53, making 64-bit pointless |
| Conversion functions | `int64(x)` / `uint64(x)` | Same family as `int()`/`uint()`: **coercive** conversion (String parses decimal, Number truncates toward zero, Boolean→1/0, null→0) |
| Type check | `x as int64` | tag mismatch gives 0, the same rule as `x as int`; use `int64(x)` for a **coercive** conversion |
| Same-type operations | `+ - * % & \| ^ << >> >>> ~ ++ --` | Stay 64-bit (this is the point of the type) |
| Division | `/` is always Number | The same rule as AS3's `int/int → Number` — the division result is not an integer |
| Mixed with `int`/`uint`/`Boolean` | The other side **exactly** widens into 64-bit | Lossless, and better than degrading to double |
| Mixed with `Number` / dynamic `*` | The whole expression degrades to Number | AS3's numeric promotion rule; >2^53 rounds (**exactly why a 64-bit type is needed**) |
| `int64` ↔ `uint64` | `+ - * %` degrade to Number; bitwise takes the unsigned family; `< <= > >= == !=` are **mathematical comparisons** | No common C type; `int64(-1) < uint64(0)` is true (not C's unsigned reinterpretation) |
| Boxing | Dedicated tags 8/9, the value placed verbatim in `as_value` | 64-bit values in `*` / Array / Dictionary do not go through double; `typeof` reports `"number"` (no AIR counterpart, unobservable) |
| `%` zero divisor | Gives 0 | C's `%` is UB; the same contract as AS3's `int % 0` |
| Shift amount | Masked to 0..63 | C is UB for ≥ the bit width; AS3 masks 32-bit shifts to 31, so this is a faithful analogue |
| GC | The tag 8/9 `ptr` slot is **integer bytes** | `gc_mark_value`/`gc_write_barrier_value` use an **explicit tag table**: a range check would treat integer bits as heap references to mark |

**Explicit boundaries (never silent, all compile-time errors with alternatives)**: `Vector.<int64>` is not
monomorphized (use `Array` or a dynamic slot); storing a 64-bit value into an `Object` slot (boxing as double
there would round — use a `*` or `int64`/`uint64` slot).

**Cross-end**: a pure-C feature, native / web(wasm) / WASI **the same code, the same behavior** (no glue, no
Skia dependency); the display/parsing of `number` (`as_i64_to_str`/`as_str_to_i64`) is a self-contained
fixed-point decimal implementation that does not rely on libc's `printf` varargs format (avoiding `%lld`'s
portability problems).

**Acceptance**: `examples/stage94t.as` (groups A~G, 50+ assertions, pure-C build ⇒ naturally covers both
ends); `test.ts`'s `[int64]` 10 structural nails (lexer suffix / source-text emission / type mapping /
conversion functions / box tags / the four value helpers / the GC explicit tag table / guards for three C
undefined-behavior boundaries / two "loud refusals" / example golden).

---

### 4.8 E16 — Display refresh-rate query (`VsyncStateChangeAvailabilityEvent.refreshRate`) — ✅ **done**

**Why it counts as an enhancement**: AIR has **no API to query the screen refresh rate at all**. The most
obvious `flash.display.Screen` has only `bounds`/`visibleBounds`/`colorDepth` — no refresh-rate field at all;
and the only event touching refresh rate, `flash.events.VsyncStateChangeAvailabilityEvent`, is measured on
`adl 51.4.1` to have **only two members**: the constant `VSYNC_STATE_CHANGE_AVAILABILITY`
(= `"vSyncStateChangeAvailability"`) and a **read-only** `available:Boolean`. Measured (`mxmlc` + `adl`): the
constructor signature is exactly `(type:String, bubbles=false, cancelable=false, available=false)`
— **adding a 5th argument is rejected outright by `mxmlc`** ("no more than 4"); the event is dispatched
**exactly once** after `ADDED_TO_STAGE`, and `available` measures **`false`**. That is: in AIR this event
cannot even report "the screen supports vsync state switching", let alone a rate.

**The enhancement**: while **fully preserving AIR's defined surface**, give the event a **read-only**
`refreshRate:Number`:

| Surface | AIR contract | Ours | Does it rewrite AIR behavior |
|---|---|---|---|
| Constant string | `"vSyncStateChangeAvailability"` | same | no |
| Constructor | `(type, bubbles=false, cancelable=false, available=false)` | **the same 4 args usable**, the 5th `refreshRate=0` **optional** | no (pure addition) |
| `available` | read-only, measured `false` | same | no |
| `refreshRate` | **does not exist** | read-only `Number`, = the measured refresh rate of the display the window is on | yes (a **new field**, AIR code cannot read it) |
| Dispatch timing | once after startup | once after startup **+ again when the window lands on a display of a different rate** | yes (a **new dispatch point**, but a listener written the AIR way, caring only about `available`, behaves unchanged) |

**Why no `--features` switch is needed** (its relation to §1.2d's "opt-in"): the purpose of opt-in is "do not
change the observable behavior of the default output". Here AIR-shaped code (4-arg construction, reading
`available`, listening by constant) is **bit-for-bit unchanged**, and the added field and added dispatch point
are **unreadable on the AIR side at all** (the AIR compiler does not allow that argument; AIR's class has no
such property), so a "default output deviating from AIR" is impossible — this is the same reasoning as E9 (the
`int64` type name does not exist in AIR). **Cross-end differences are explicit**: web and the offscreen
(headless) backend **cannot find** the panel refresh rate ⇒ the `refreshRate` dispatch **simply does not
happen** (`rr <= 0` returns immediately), **not dispatching a fabricated `0`** — a listener simply receives no
event on web, which is exactly the "state the missing capability" form.

**Usage** (portably aligning the logical frame rate to the real panel):

```as3
stage.addEventListener(VsyncStateChangeAvailabilityEvent.VSYNC_STATE_CHANGE_AVAILABILITY, onVsync);
function onVsync(e:VsyncStateChangeAvailabilityEvent):void {
    if (e.refreshRate > 0) stage.frameRate = e.refreshRate;   // native: follow the panel
}                                                              // web: no event received, frame rate keeps its value
```

**The accompanying AIR surface**: `Stage.vsyncEnabled` (AIR **has** this switch, writable; measured default
`true`) is wired as a **application-level** single value (like `Stage.frameRate`, "one value for the whole
application", see `as3-semantics.md` §2). When it is `true` (the default), the code path is byte-for-byte
identical to before; when `false`, it **drops the rule "an explicit frameRate above the panel refresh rate is
capped"** (AIR: "the player does not wait for the display's vertical refresh") — i.e. that long-standing
"keep as-is" note (see `as3-semantics.md` §2's frame-rate contract row) now has AIR's own escape hatch.

**Acceptance**: `examples/vsyncevent.as` (offscreen, same shape both ends; asserting the constructor's two
forms, `available` read-only, the constant string, `vsyncEnabled` read/write and default, `refreshRate`
default `0`); `test/unit/vsync.ts`'s structural nails; the window probe `temp/vsyncwin/` (native real machine:
`VSYNC available=false refreshRate=120` → move to a 60 Hz external display, dispatch `refreshRate=60` → move
back to 120 Hz, dispatch `120` again, with `stage.frameRate` following each time); the Starling demo was
changed to listen for the event and set `stage.frameRate = e.refreshRate`, with no regression in the benchmark
scene's peak (`front` 59280 / the old baseline band 61.4k–66.2k).

---

## 5. Relationship to scheduling / regression

- **Scheduling**: this list's **to-do view** is in `TODO.md`'s `### 增强待做`; this doc covers "what it is, why,
  what it depends on".
- **Not default**: none of the items changes the default output before implementation; implementation must be
  opt-in (§1.2d).
- **Entry conditions**: each item's landing must pass §1.2's five criteria + AGENTS.md §4's DoD (example +
  assertion regression + docs + version).