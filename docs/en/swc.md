# SWC Resource Extraction and Embedding

> This document answers one question: **in a pure-AS project, images and other resources are packed into an
> SWC — how does the AOT compiler extract them and display them on the UI**.
> Core conclusion first: an SWC is a ZIP archive, but the resources are **not standalone files inside the ZIP**;
> they are compiled by mxmlc into `library.swf` and stored as SWF binary tags (bitmap → `DefineBitsLossless2`/
> `DefineBitsJPEG2`, mapped to class names via `SymbolClass`). Therefore "parse the SWC to get resources" =
> **unzip → decompress the SWF → scan the tag stream → extract bitmap pixels/JPEG bytes**.
> This chain happens at **compile time** (Node side, zero third-party dependencies), converting resources into C
> byte arrays embedded into the output; the runtime decode/display reuses the existing Skia backend (the same
> `DeferredFromEncodedData` path as `BitmapData.loadFile`).
>
> **Scope boundary (must read)**: besides resources, `library.swf` also contains **255 `DoABC` tags** — the real
> AVM2 bytecode of 254 classes (54,162 B of actual code). This plan **treats the SWC purely as a resource
> container and leaves code out of scope**: turning bytecode into something compilable needs a decompiler or an
> AVM2 interpreter, which is a different product (see §3.3).
>
> **But "code" barely constrains this plan** (re-examined 2026-09-26): the **only** classes lacking source are
> **8 in `mx.core`/`mx.utils`, totalling 3,135 B** (5 of them empty interfaces; the real work is ~150 lines).
> The other 240+ classes either **have `.as` sources** (37 logic classes / 32,465 B) or their "content" is
> bitmaps/timelines rather than code (16 resource classes + 192 skin symbol classes, whose class-level bytecode
> is only 5,641 B and almost entirely empty constructors). So this plan is **not blocked by "code"** (see §3.3).
>
> **Status (re-verified 2026-09-26, v0.3.138): this is a *plan* document, not implemented yet.**
> `src/swc.ts` does not exist, no `swc` reference exists anywhere in `src/`, the CLI has no `--swc` and the build
> manifest has no `swc-paths` (none of the 10 manifests list a `.c` in `sources`), and git history has no related
> commit; `TODO.md` lists it as "researched, implementation deferred (pending user decision)".
>
> **This revision corrects six errors in the earlier version; read this page as authoritative**:
> ① it called `BitmapData.pixels` a "RGBA buffer" (it is **straight ARGB**);
> ② it counted `small_gift`/`checkbom` among the 16 bitmap resources (they are `DefineSprite`);
> ③ it under-estimated the embedding cost as "a few hundred KB of JPEG" (with the embedding form it then
> prescribed — "raw pixels → `0xNN,` arrays" — it is **7.42 MB of C source**);
> ④ it **omitted premultiplied alpha** — the only item that directly produces a visible bug (see §3.2);
> ⑤ it **omitted an entire category of SWC content: code** — the 255 `DoABC` tags (254 classes / 54,162 B of
> bytecode) did not even appear in the earlier "explicit deferrals" table; and its class breakdown stopped at
> the superclass level, treating "192 `skin_fla/*`" as one category (192 is the count of `extends MovieClip`,
> of which only 89 are actually named `skin_fla.*`), which **misjudged source availability** (see §3.3);
> ⑥ it **picked the wrong embedding form**: the earlier version decoded `DefineBitsLossless*` into **raw ARGB**
> and embedded that as C arrays — measured at **7.42 MB** of source. Embedding the **encoded bytes** (a PNG
> re-encode, or JPEG bytes copied verbatim) needs only **42.7 KB** (**178×** less) and **reuses an existing
> decode path** — `as_skia_image_decode_bytes_argb` **already exists**, it is not "to be added" (see §5, §7).
>
> All technical conclusions here rest on **unpacking a real `temp/skin.swc`** (743,520 B, 255 classes, 59 bitmap
> resources), cross-checked against ground truth read from AIR SDK's `adl` via `getPixel32` (method in §11).
> Note that file lives in the **repository root's** `temp/`, not in `as3compiler/temp/`.

---

## 1. Why This Requirement Exists: SWC Is the Resource Carrier in Pure-AS Projects

In the Flash/Flex ecosystem, resources (skin bitmaps, icons, fonts) have two kinds of ownership:

| Scenario | Where the resource lives | Extraction difficulty | Current compiler state |
|------|---------|---------|---------------|
| Own project + `[Embed(source="a.png")]` | The source image is still on disk | Low — read the image directly, **no SWC involved** | **Also not implemented**: `parser.ts` only does generic metadata parsing (`parseMetadataIfPresent`); `Embed` has no semantic-layer consumer. Apart from comments and `EmbedFont` (app.xml fonts), `src/` has no `Embed` handling |
| Third-party library / Flash IDE skin library | The source image is gone; only the `.wc` remains | High — must unpack SWC + SWF | Covered by this plan |

The user's scenario is the latter: `temp/skin.swc` is a Flash IDE-exported UI skin library (containing
`logo`/`imgback`/`desktopicon`/`cambitmap` resource classes) whose source art is lost, so the bytes can only be
extracted from the SWC.

> Both paths require code. Do not read the first row as "an existing shortcut" — its only advantage is that it
> needs no SWF parsing.

---

## 2. Anatomy of an SWC: ZIP Shell + Embedded SWF

Rename `.swc` to `.zip` and unpack it; the standard structure has exactly two files (`docs/` is optional ASDoc):

```
skin.swc (ZIP archive)
├── catalog.xml     84,463 B (uncompressed) / 5,570 B (deflated) — component catalog: <script> lists each class + deps
└── library.swf    737,552 B (uncompressed) / 737,700 B (deflated) — build output: SWF container (CWS = zlib)
```

Structure of `catalog.xml` (measured on `temp/skin.swc`):

```xml
<swc xmlns="http://www.adobe.com/swccatalog/9">
  <libraries>
    <library path="library.swf">
      <script name="logo" mod="..." signatureChecksum="...">
        <def id="logo" />
        <dep id="flash.display:BitmapData" type="s" />
        <dep id="Object" type="i" />
      </script>
      ...
    </library>
  </libraries>
</swc>
```

**Key fact**: `catalog.xml` only describes "which classes exist and what they depend on"; it contains **no
resource bytes**. The actual image bytes are in `library.swf`. The earlier version quoted "84 KB" for
`catalog.xml` and "737 KB" for `library.swf` — those two numbers use different baselines (uncompressed vs
compressed), so they need not match.

Measured extras: `catalog.xml` has **255** `<script>` entries; `library.swf`'s SWF header has `version = 44`,
and its tag stream contains **255 `DoABC` (tag 82)** tags — the source of the "255 classes" figure (consistent
with `catalog.xml`).

> `<dep>` is more than documentation: it is a **ready-made dependency graph** (which class depends on what, and
> whether the relation is inheritance or implementation). This plan uses it in §3.3.3 for a compile-time early
> diagnostic on "references to classes that exist only as bytecode".

---

## 3. The Real Storage Form of the Resource: SWF Tags

`library.swf` is a standard SWF container; a leading `CWS` means zlib-compressed (`FWS` = uncompressed,
`ZWS` = LZMA). Measured: `temp/skin.swc`'s `library.swf` is **CWS** (body after inflate = 1,031,069 B). After
decompression it is a tag stream, each tag being `(code:length) header + body`.

> **Important**: before scanning tags you must skip the SWF stage header — `RECT` (a 5-bit `nbits` followed by
> `4*nbits` bits) + `frameRate` (UI16) + `frameCount` (UI16). Measured here `nbits=17`, so the header is
> **14 bytes**. Scanning from body offset 0 yields a pile of meaningless tag codes (and can easily be misread as
> "there are no bitmaps").

Resource-related tags (measured distribution):

| `[Embed]` type / resource | SWF tag | tag code | Body content |
|---|---|---|---|
| PNG / lossless bitmap | `DefineBitsLossless` | 20 | SWF-native bitmap format, **no alpha** (see §3.1) |
| PNG / lossless bitmap (with alpha) | `DefineBitsLossless2` | 36 | SWF-native bitmap format, **with alpha** (see §3.1) |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **complete JPEG bytes** (starts `FF D8`) |
| JPEG (with alpha) | `DefineBitsJPEG3/4` | 35/90 | JPEG + alpha data |
| Raw bytes | `DefineBinaryData` | 87 | `characterID` + raw bytes |
| Font / sound | `DefineFont*` / `DefineSound` | 10/48/14/75 | font/audio data |
| **symbol → class name** | `SymbolClass` | 76 | `{id → "ClassName"}` mapping |
| Timeline movie clip | `DefineSprite` | 39 | display tree (`PlaceObject` children) |

Measured on `temp/skin.swc`'s `library.swf`: **59 bitmap tags** (`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2), **214 `SymbolClass` mappings**; plus
`DefineSprite`×333, `DefineShape*`×378, `DefineButton2`×29, **`DefineFont3`×7**.

### 3.1 Important Pitfall: `DefineBitsLossless` Stores **Not PNG**, and tag 20 ≠ tag 36

This is the easiest trap. A `DefineBitsLossless2` body **is not** a PNG file; it is SWF's own bitmap format:

```
DefineBitsLossless2 (tag 36) body:
  characterID   u16   (symbol id)
  bitmapFormat  u8    (3 = 8-bit colour table; 4 = 15-bit RGB; 5 = 32-bit **ARGB (with alpha, premultiplied)**)
  width         u16
  height        u16
  [colorTableSize u8]  (only when bitmapFormat == 3; actual entries = this value + 1)
  zlibData      ...   (zlib-compressed pixel data)
```

Extracting `symbol#2` (`logo`): `characterID=2, format=5, 100×72`, decompressed pixels
`28800 bytes = 100×72×4`, first 16 bytes all zero (transparent edge), 37.1 % non-zero — valid image content.

**tag 20 and tag 36 must not be conflated**: their bodies are nearly identical, but **tag 20's format 5 is
24-bit RGB (XRGB — the first byte is padding with no alpha meaning)**, whereas tag 36's format 5 is true ARGB.
Treating tag 20's first byte as alpha turns the whole image fully transparent whenever the producer wrote
`0x00` there. Measured: the single tag 20 in `temp/skin.swc` happens to be the **largest resource**
`cambitmap` (700×393, 1,100,400 B of pixels) and its padding byte happens to be `0xFF`, so it displays
correctly — by luck, which is exactly what we must stop relying on.

**Conclusion**: `DefineBitsLossless*` needs "inflate → raw pixels" and **cannot** be fed straight to Skia's
`MakeFromEncoded` (which only understands PNG/JPEG and similar encoded formats). `DefineBitsJPEG2`, by contrast,
stores a **complete JPEG** and can be handed to Skia directly.

### 3.2 Pixel Format Contract (added by the 2026-09-26 re-verification; the only omission that causes a visible bug)

Raw bitmap pixels have two properties that must be pinned down first: **byte order** and **premultiplication**.
Both are now settled against `adl` ground truth.

**① Byte order = `A, R, G, B` (first byte is alpha)** — verified across 7200/7200 pixels: the `px[0]` we parse
equals the alpha channel of `logo.getPixel32()` **exactly**, with no exceptions.

**② The data is "premultiplied ARGB", while AIR's `getPixel32` returns "straight ARGB".**

How this was established:

- **Controlled experiment** (hand-built PNG with known straight values, compiled by `mxmlc`, both ends inspected):
  writing a pixel `R=200, G=100, B=50, A=4`, AIR reads back `A=4, R=191, G=64, B=0`. Straight storage would read
  back 200/100/50; what actually comes back is the result of amplifying tiny premultiplied values
  (`R_pm≈3` → `3×255/4=191.25`), and **`B` is lost entirely (50→0)** because `50×4/255 < 1` truncates.
- **Statistical check**: across all 7200 pixels of `logo` in the SWC, **zero** pixels have `R|G|B > alpha`, and
  **zero** pixels have `alpha = 0` with non-zero RGB — the signature of premultiplied data (straight data can
  hardly satisfy both at once).
- **AIR's exact un-premultiply rule** (derived from 340,644 channel samples over 219 distinct
  `(alpha, stored)` pairs taken from `logo` + `imgback` + `desktopicon`): the map
  `(alpha, stored) → AIR value` is a **pure function** (0 conflicts across 219 pairs), equal to
  `floor(stored × 255 / alpha + t)` with `t ∈ [0.329, 0.413)`. **`floor(x + 1/3)` matches all 219 pairs
  exactly (219/219)**; against the obvious `round(c*255/a)` the maximum deviation is only **−1**
  (2/219 exceptions, the other 217 identical).

**What this means**: this project's runtime buffer is **straight ARGB (`0xAARRGGBB`)**, matching the AS3
`BitmapData` contract (see §5, §7). So **"fill the extracted ARGB pixels straight into `BitmapData.pixels`" is
wrong** — it yields a uniformly darker image, and the lower the alpha the worse the error:

| Case | Stored | Direct fill (wrong) | After un-premultiply (correct = AIR) |
|---|---|---|---|
| `logo` pixel with A=31 | R=24 | 24 (87 % too dark) | **197** |
| Controlled A=4 pixel | R=3, G=1, B=0 | 3 / 1 / 0 | **191 / 64 / 0** |

**Correct approach**: un-premultiply **at compile time** (inside `swc.ts`, during extraction), so the embedded
bytes are already straight ARGB and the runtime cost is zero. Reference implementation:

```c
/* Compile time (Node side): stored premultiplied ARGB -> straight ARGB.
   t = 1/3 is the empirically fitted value that matches AIR (threshold band [0.329, 0.413)). */
static uint8_t out = a == 0 ? 0 : min(255, (int)floor(c * 255.0 / a + 1.0 / 3.0));
```

> **Do not** do it the other way round (un-premultiplying at runtime decode): that would pollute every resource
> class instance's construction path and diverge from the `BitmapData.loadFile` path, where Skia already yields
> straight pixels. Compile time keeps the runtime free and makes the embedded bytes semantically identical to
> what `getPixel32` returns.

> If you would rather not depend on the fitted `t = 1/3`, `round(c*255/a)` is an acceptable fallback — the
> difference from AIR is ±1 per channel (visually indistinguishable). What is **never** acceptable is skipping
> un-premultiplication altogether.

### 3.3 The Other Tag Category: Code (`DoABC` / ABC Bytecode) — **a Scope Declaration, Not a "Deferral"**

Besides bitmap resources, `library.swf` contains **255 `DoABC` (tag 82)** tags, and they hold the **real AVM2
bytecode of 254 classes** — not empty placeholders. Measured (our own parser round-trips **255/255** modules
exactly; method in §11):

| Metric | Measured |
|---|---|
| `DoABC` modules | **255** |
| Total ABC container size | **252,737 B** |
| Classes / methods / method bodies | **254 / 1429 / 1316** |
| **Actual bytecode** | **54,162 B** (21 % of the ABC; the rest is constant pool and metadata) |
| String constants | **9,977** entities (the raw count including reserved slot 0 is 10,232) |
| Largest single method body | 2,234 B |

The content is real logic, not symbol placeholders (ranked by per-module bytecode):

| Module | Bytecode | Note |
|---|---|---|
| `com/vsdevelop/utils/StringCore` | 4,373 B | in-house utility library (largest) |
| `com/vsdevelop/air/download/DownLoader` | 3,576 B | in-house downloader |
| `com/greensock/TweenLite` | 2,799 B | Greensock tweening library |
| `com/adobe/crypto/MD5` | 2,616 B | AS3 crypto |
| `mx/core/BitmapAsset` | 2,515 B | Flex framework |
| `com/adobe/serialization/json/JSONTokenizer` | 2,480 B | JSON parser |
| `com/vsdevelop/controls/scrollbar/MWIOSScrollBar` | 2,195 B | scrollbar component |
| `com/vsdevelop/controls/ComBoBox` | 1,557 B | combo-box component |

#### 3.3.0 The Full Breakdown of the 254 Classes (including **source availability** — the real data deciding feasibility)

The earlier version stopped at the superclass level and concluded from that "~240 classes have no source to compile" — which is wrong. Re-counted with **mutually exclusive** categories (class-level bytecode counts only methods attached to instance/class traits):

| Category | Count | Class-level bytecode | Content | Source availability |
|---|---|---|---|---|
| Bitmap resource classes (`extends BitmapData`×4 / `BitmapAsset`×12) | 16 | **152 B** | content = the bitmap; the class is a 9–11 B constructor | must be synthesised from the SWC (§5) |
| `extends MovieClip` Flash IDE symbol classes | **192** | **5,489 B** | UI skin symbols (`alertskin`/`popgiftskin`/`homeskin`…); **almost all are 9 B empty constructors**, only a few carry real code (`checkbom` 132 B, `toastbtn` 73 B, `devicesitemskin` 62 B, `PPTNextPage(Pre)Button` 51 B) | code negligible; **content** is timeline/bitmap |
| Interfaces (`extends null`) | 6 | 6 B | empty | — |
| `mx.core` / `mx.utils` (Flex) | **8** (5 of them are the interfaces above) | **3,135 B** | see below | **no source (the only such group)** |
| Remaining logic classes | 37 | **32,465 B** | `TweenLite`/`MD5`/JSON/`StringCore`/`DownLoader`/`XMLLoader`/scrollbar components… | **have `.as` sources** |
| **Total** | **254** | **41,242 B** | | |

> **Counting convention**: class-level bytecode covers only methods attached to instance/class traits. The
> remaining **12,920 B** belongs to module-level `script_info` initialisers and nested functions not attached to
> any trait; the two together are the **54,162 B** total (see §11).

> **Two earlier statements corrected**: ① "192 Flash IDE-exported `skin_fla/*`" is inaccurate — 192 is the total
> number of `extends MovieClip`, of which only **89** are named `skin_fla.*` and another **103** are plain-named
> skin classes (`alertskin`, `popgiftskin`, `checkbom`, …); ② the string constants' **entity count** is **9,977**;
> `10,232` is the raw count including reserved slot 0.

**`mx`/flex is the only "no source" group, and it is tiny**:

| Class | Bytecode | Form |
|---|---|---|
| `mx.core.BitmapAsset` | 2,464 B | thin wrapper: `extends mx.core.FlexBitmap`, holds `bitmapData`/`smoothing` |
| `mx.utils.NameUtil` | 566 B | utility functions |
| `mx.core.FlexBitmap` | 100 B | `extends flash.display.Bitmap` |
| `mx.core.IFlexDisplayObject` / `IAssetLayoutFeatures` / `IRepeaterClient` / `ILayoutDirectionElement` / `IFlexAsset` | 1 B each | empty interfaces |

That is: **hand-writing ~150 lines of AS3 covering ~3 KB of bytecode closes the entire "no source" gap**. Note
`mx.core.BitmapAsset` is the **superclass of the 12 `ScrollSkin_*` resource classes**, so it must have an
implementation.

**Conclusion (scope declaration)**: the realistic default is "**resources come from the SWC, code comes from
`.as` sources**". That constraint costs very little: measured, only **8 mx/flex classes (3,135 B)** lack source,
and 5 of those are empty interfaces; the other 240+ classes either have sources (37 logic classes / 32,465 B)
or their "content" is bitmaps/timelines rather than code (16 + 192 = 208 classes, class-level bytecode only
5,641 B). **The earlier version wrongly listed `TweenLite`/JSON parsers/`DownLoader` as "no source to
compile"** (they do have sources), which would make a reader think this plan is blocked by "code".

#### 3.3.1 Reading the Container: Solved, and a Closed Little Problem (~400 lines)

A `DoABC` (tag 82) body is **not** the ABC itself: it is `u32 flags` + a **NUL-terminated cstring name** (the
module name, e.g. `com/greensock/TweenLite`) + the ABC. The ABC parses as a fixed sequence of sections, but
four semantic traps must be remembered (all hit during implementation; settled against Ruffle
`swf/src/avm2/read.rs::read_trait`):

| Section | Semantics |
|---|---|
| Pool sections (int/uint/double/string/ns/nsset/multiname) | The count **includes reserved slot 0** (entities = `count-1`) |
| method / class / script / method_body / metadata | The count is an **exact value** (**no** reserved slot) |
| `instance_info` | An extra `protectedNS: u30` exists **only** when `flags & 0x08` (`CONSTANT_ClassProtectedNs`) |
| `trait_info` | The `kind` byte's **low nibble is the trait type** (0 Slot/1 Method/2 Getter/3 Setter/4 Class/5 Function/6 Const) and its **high nibble holds attributes** (`0x10` Final / `0x20` Override / `0x40` Metadata); the **metadata table comes *after* the kind payload, not before** |

(Three further details desync just as silently:
① a `method_info` `HAS_OPTIONAL` entry is **two** fields — `value u30 + kind u8`; `HAS_PARAM_NAMES` reads
`param_count` names;
② **the `class_info` vector has no count prefix** — its length is simply `instance_count` (Ruffle:
`read_vec(instances.len(), read_class)`); reading one extra u30 desyncs everything;
③ **pool index 0 is a reserved slot** — to resolve a name you must read `pool[idx-1]` (otherwise you get a
screen of garbage names, yet **nothing errors**).
Also, `trait_info` kind 4 (`Class`) has a **class index** as its second field, not a method index — do not use
it to look up method bodies.)

A parser built to this spec **consumes every one of the 255 modules exactly to the last byte** — i.e. round-trip
proves itself correct, rather than "looks about right". So container reading is a **~400-line, fully testable
job**: if it is ever wanted, this part is not hard.

#### 3.3.2 Reading the Code: Five Roads, of Which **Only D + E** Are on This Plan's Heading

Method bodies are **AVM2 stack-machine bytecode**, not source. There are only these ways to actually *use*
them:

| Approach | How | Cost |
|---|---|---|
| A. Decompile → AS3 source | bytecode → source → feed the existing front end | stack→expression, control-flow reconstruction, exception tables→try/catch; research-grade (JPEXS / rabcdasm territory), imperfect fidelity, output still needs manual fixing |
| B. ABC → our AST (skip text) | build `ast.ts` nodes directly | still needs stack→expression plus scope/closure semantics, i.e. **writing another front end**; plus AVM2 trait/slot dispatch we do not implement |
| C. Embed an AVM2 interpreter | run the bytecode instead of translating | the **opposite direction** from AGENTS.md §1 ("translate to readable C"); a different product |
| **D. Do not parse code** | the SWC is only a resource container; code comes from `.as` | **the position of this plan** (`src/swc.ts` in §7 does resource extraction only) |
| **E. Hand-write those few classes** | write equivalent `.as` for the classes that lack source | **the realistic choice for the 8 mx/flex classes (3,135 B)**: 5 are empty interfaces, so only `mx.core.BitmapAsset` / `FlexBitmap` / `NameUtil` are thin wrappers — **~150 lines** (see §3.3.0) |

> Since measured **only** mx/flex lacks source (§3.3.0), the natural combination in practice is **D + E**
> (everything else goes through sources; those few classes are hand-written) — and **none of A/B/C is needed**.

**So the scope is fixed**: this plan **excludes** "bytecode → C" translation. Supporting classes that exist only
as ABC would require a **separate initiative** (a decompiler or an AVM2 interpreter), not an extra subtask here.

#### 3.3.3 Compile-Time Early Diagnostic via `catalog.xml`'s `<dep>` (**recommended for the first iteration**)

Each `<script>` in `catalog.xml` already lists the class's definition and dependencies with their types
(`<dep id="flash.display:BitmapData" type="s"/>`, where `s` = inheritance and `i` = implementation) — **that is
a ready-made dependency graph, readable without parsing any ABC**.

Use it to turn "a reference to a class that exists only as bytecode inside the SWC" from a **silent runtime
failure** into an **explicit compile-time error**:

```
error: class 'mx.core.BitmapAsset' is only available as AVM2 bytecode inside
       'skin.swc' (2,464 B of ABC, not translatable); provide its .as source
       or a source-compatible replacement.
```

> Note the example uses an **mx class**, not `TweenLite`: measured, **only** the 8 mx/flex classes actually
> lack source (§3.3.0), whereas `TweenLite`/`MD5`/JSON all **do have sources**. What the diagnostic must do is
> intersect "SWC-only" with "has no `.as` source" — not report every bytecode class in the SWC, which would
> flag a large number of classes that do have sources.

The implementation is set arithmetic at the name level (classes in `catalog.xml` ∩ front-end symbol table ∩
"has no `.as` source") → report on a hit; it **decompiles nothing**. The cost is tiny and the value is high:
the alternative is the hardest class of failure to debug — "compiles fine, undefined at runtime".

---

## 4. Compile-Time Extraction Chain (End-to-End Re-verified)

```
SWC (ZIP)
  │  ① hand-written ZIP central-directory parse (Node side, no deps)
  ▼
library.swf (deflate-compressed CWS file)
  │  ② zlib raw-inflate for the ZIP layer → CWS file bytes
  ▼
CWS file ("CWS" + version + fileLength + zlib stream)
  │  ③ zlib inflate for the CWS layer → SWF body
  ▼
SWF body (skip stage header: RECT + frameRate + frameCount)
  │  ④ tag-by-tag scan, matching DefineBitsLossless2(36)/Lossless(20)/JPEG2(21)/JPEG3(35)
  ▼
bitmap resources:
  ├─ Lossless2/Lossless → zlib inflate → raw **premultiplied** pixels (+ width/height)
  │                         ├─→ un-premultiply → straight ARGB (§3.2, compile time)
  │                         └─→ **PNG re-encode** (§5.1, ~100-line encoder) → encoded bytes
  └─ JPEG2/3   → complete JPEG bytes (+ alpha) — **copied verbatim, zero conversion**

both feed the existing runtime entry point (§5): as_skia_image_decode_bytes_argb → straight ARGB → BitmapData
```

**Re-verification result** (real `skin.swc`, re-run 2026-09-26):

```
① ZIP-layer deflate inflate: 737,700 B → CWS 737,552 B
② CWS-layer zlib inflate:    → SWF body 1,031,069 B
③ stage header skipped:      nbits=17 → 14 bytes
④ 1,504 tags total; 59 bitmap tags (36×53, 20×1, 21×3, 35×2); 214 SymbolClass mappings
⑤ Lossless2 extract:         characterID=2, format=5, 100×72, 28,800 B of pixels
⑥ 37.1 % non-zero; aligned pixel-by-pixel with adl's getPixel32 (§3.2) — extraction is correct
```

**Zero-dependency feasibility**: a hand-written ZIP central-directory parse (the `PK\x01\x02` header plus the
`PK\x05\x06` EOCD tail) is ~30 lines; zlib decompression uses Node's built-in `zlib.inflateSync`/
`inflateRawSync`; the SWF tag scan is ~40 lines. All of it runs in the compile-time front end (Node side),
satisfying AGENTS.md §3.1 ("zero third-party dependencies").

**Exact layout of `ZWS` (LZMA)** (the earlier version only said "needs mangled-header handling" without giving a
method; now measured):

```
'ZWS' + version(1) + fileLength(4, = total uncompressed size)
  + compressedLength(4)          ← note: this 4-byte length field is easy to miss
  + lzmaProps(5)                 ← props[0] → lc/lp/pb; measured lc=3, lp=0, pb=2
  + LZMA1 raw stream             ← dict comes from props[1..4] (measured 0x200000 = 2 MB),
                                   uncompressed length unknown (validate against the SWF header's fileLength)
```

That is, "LZMA raw filter + lc/lp/pb/dict recovered from props" is enough; no `make_lzma_reader`-style
mangled-header patch (that one is for the 13-byte LZMA-alone header). `temp/skin.swc` is `CWS`, so this path can
be deferred for the first pass, but since the layout is now settled the implementation cost is small.

---

## 5. Resource → Output: Embedding the **Encoded Bytes** (this section was rewritten after measurement)

The user has already decided on **compile-time extraction with compile-time embedding** (AIR's resource-class
constructors are **synchronous**, so this cannot become an asynchronous runtime load). But the **form of the
embedded content** was chosen wrongly: the earlier version decoded `DefineBitsLossless*` into **raw ARGB** and
embedded that as a C array. Measured, this is the single largest waste of source size (see §5.1). Embed the
**encoded bytes** instead:

| Resource format | Embedded content (**encoded bytes**) | Runtime decoding |
|---------|----------------------|-----------|
| `DefineBitsJPEG2/3` (21/35) | **JPEG bytes copied verbatim** (zero conversion) | the existing `as_skia_image_decode_bytes_argb` |
| `DefineBitsLossless2` (36) | un-premultiply (§3.2) then **re-encode as PNG** | same |
| `DefineBitsLossless` (20) | same, but the source has no alpha → write `A=0xFF` | same |

**Why this is equivalent and actually better**:

- **Zero new runtime code.** The API it needs **already exists** — `as_skia_image_decode_bytes_argb(data, len,
  &w, &h)` (in `runtime.ts`; a same-named stub exists for non-Skia builds) is internally
  `SkData::MakeWithCopy` → `SkImages::DeferredFromEncodedData` → `readPixels(kBGRA_8888, kUnpremul)` →
  `sk_bgra_readback_to_argb`, producing **straight ARGB directly**. `emit.ts` already calls it on the
  `Loader.loadBytes` path.
- **Fidelity.** PNG is lossless, and the "premultiplied-then-rounded" information loss happens at **compile
  time**, under our control: what goes into the PNG is exactly the AIR read-back value computed per §3.2. The
  runtime decode yields that same set of straight ARGB values, so `getPixel32` matches point for point.
- **Volume**: see §5.1 — a **178×** difference in source size.

> **Note on the buffer format**: `BitmapData.pixels` is a **`uint32` array holding straight ARGB *values*
> (`0xAARRGGBB`)** (as declared by the `sk_surface_read_argb` comment in `runtime.ts`; `getPixel32`/`setPixel32`/
> `threshold`/`colorTransform`/`copyChannel`/`merge`/`paletteMap`/`floodFill` and the familiar `(c>>16)&0xFF`
> idiom all depend on that contract). The earlier version calling it a "RGBA buffer" was wrong — on a
> little-endian machine the *memory bytes* of that value are `B,G,R,A`, which happens to match Metal's
> `BGRA8Unorm`, but the **numeric semantics are always ARGB**.
> (i.e. we **never** write bytes into `pixels` directly; we always let Skia decode to straight ARGB values,
> which is host-endianness independent.)

> **`as_skia_image_from_bytes` does not need to be added**: the earlier version listed it as "planned / does not
> exist yet", but measured, that capability is already provided by `as_skia_image_decode_bytes_argb` (see §7).
> The glue side currently uses `SkImages::DeferredFromEncodedData` (not the `MakeFromEncoded` named in the
> earlier version).

### 5.1 Embedding Form and Source-Size Cost (**three forms measured item by item**; earlier estimate corrected)

Measured across the **16 named resources** of `temp/skin.swc`:

| Form | Total | Note |
|---|---|---|
| Compressed bytes inside the SWC (tag payload) | **13,097 B** | fmt5 is zlib-compressed **premultiplied** ARGB |
| Decoded to raw ARGB | **1,555,412 B** | what the earlier plan intended to embed |
| **Re-encoded as PNG** | **14,569 B** | only 11 % larger than the tag payload |
| PNG embedded as C source (`\xNN` escaped string) | **43,723 B ≈ 42.7 KB** | **the form to adopt** |
| Raw ARGB embedded as C source (`0xNN,`) | **7,777,060 B ≈ 7.42 MB** | **the earlier plan; wrong** |

Looking at the largest one, `cambitmap` (700×393, tag 20): raw ARGB **1,100,400 B** → PNG **8,070 B**.

**A 178× difference in source size.** So the resource section should look like this (encoded bytes, not pixels):

```c
/* SWC resource: skin.swc#logo (100x72) — PNG bytes; decoded at runtime by
   as_skia_image_decode_bytes_argb (same path as Loader.loadBytes). */
static const unsigned char __res_skin_logo_png[] =
  "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR...";   /* 1,651 B of PNG */
static const int __res_skin_logo_w = 100;
static const int __res_skin_logo_h = 72;
```

**The conflict with stage 78 is gone**: the resources total about **42.7 KB of C source** (5 % next to
`hello.as`'s 854 KB), so they fit comfortably in **a single `.c`**, consistent with "a single `.c` is the
default form". The earlier version, having chosen raw pixels, was forced to write "the resource section **must**
be a separate `.c`" — **that mandatory item is cancelled along with this section's conclusion**:

- **Default**: embed the resource bytes into the same `.c` (no split is warranted at the measured scale).
- **Exception**: if some SWC's resources push a single `.c` past an implementer-set threshold (say >5 MB of
  source), fall back to "a separate resource `.c` merged via the build manifest's `sources`" — the build layer
  already supports it (AGENTS.md §2.9).
- In either form `-O2` discards unreferenced resource sections, so the final binary size is unaffected.

> **A compile-time PNG encoder is required**: Node's built-in `zlib` is enough (IHDR/IDAT/IEND + filter 0 per
> row, ~100 lines, zero third-party dependencies). `DefineBitsJPEG2/3` tags already hold a complete JPEG, so
> **copy the bytes verbatim — no encoder needed**. Measured, all 16 named resources in this sample are lossless
> (no JPEG tag hit), so the first iteration must ship a PNG encoder.

### 5.2 Resources That Should *Not* Be Embedded: the Desktop / Web / Mobile Channel (**already exists — do not rebuild it**)

"Resources" covers more than the compile-time-known bitmap classes inside an SWC. Large images, audio, fonts and
external data should **not** be compiled into a `.c` — they need lazy loading, and a web first paint should not
pull down a huge `.wasm`. The good news is that this channel **is already implemented and already dispatched
per platform**:

| Platform | Existing mechanism | Where |
|---|---|---|
| Desktop native | The executable runs with **CWD = the app directory**, so `File.applicationDirectory` resolves there → resources are **ordinary files** (`assets/...` sitting alongside), matching `adl`'s install-directory semantics | `air-app.ts` |
| Web (wasm) | The browser sandbox FS starts empty → with `--package web`, `findPreloadPaths()` hands every entry of the app directory (excluding `src/`, the `<filename>*` artifact prefix and dotfiles) to **`--preload-file <root>@<dest>`**, packing them into a packed FS image (+ `-s FORCE_FILESYSTEM=1`), so the **same `assets/...` paths** resolve in the browser | `build.ts` (`preloadPaths`), `air-app.ts::findPreloadPaths` |
| macOS / iOS (`.app`) | `--package xcode-project` produces an application bundle; resources go through **PBXResourcesBuildPhase** (currently the `icon`; fonts via `font-urls`) | `xcode-project.ts`, `pbxproj.ts` |
| **Fonts (a ready-made precedent)** | `<embedFonts><font><fontPath>` → manifest `font-urls` → **on web, fetched at runtime and injected into Skia's font manager** | `air-app.ts`, `html5-web.md §3` |

> **Platform maturity (same measurement)**: `--package xcode-project` **currently supports macOS only** (a
> non-native `--target` errors out explicitly; iOS would need a separate initiative), and
> `--package android-project` reports `not yet implemented`. So of the "three platforms", what is actually
> usable today is **desktop + web**, with `.app` reaching macOS only.

**Resources therefore belong in two layers** (the design decision this section pins down):

1. **Loadable at runtime** (large images, audio, fonts, external data) → the **file + preload/Resources
   channel** (table above). Naturally portable across platforms, and lazily loadable on web.
2. **Compile-time-symbolised** (`new logo()`, `new ScrollSkin_topSkinClass()`) → **must be embedded** (§5.1),
   because AIR's resource-class constructors are **synchronous**.

> **One exception that must be written down explicitly**: layer 2 **cannot** degrade into "lazily load from disk
> on first access" — that would turn `new logo()` from synchronous into something needing a pumped frame, which
> is a **semantic change**. Embed instead (measured at only 42.7 KB).

---

## 6. AS3-Side Reference Semantics: Resource Class = `BitmapData` Subclass

This determines how codegen must wire resource references. Measured in `temp/skin.swc`'s `library.swf` ABC:

```
public dynamic class logo extends flash.display::BitmapData
  public function logo(int,int):*
public dynamic class imgback extends flash.display::BitmapData
public dynamic class desktopicon extends flash.display::BitmapData
public dynamic class cambitmap extends flash.display::BitmapData
```

**Resource classes (`logo`/`imgback`/`desktopicon`/`cambitmap` etc.) are dynamic subclasses of
`flash.display.BitmapData`**, with constructor signature `(int width, int height)`. This is the standard shape
of a Flash IDE-exported skin library.

> **Constructor arguments are ignored** — measured: `new logo(0, 0)` yields a **100×72** `BitmapData` (the real
> size comes from the SWF tag), not `0×0`. The factory **must use the resource's own width/height** and never
> trust the arguments (`new logo(0,0)` is idiomatic in the Flash IDE ecosystem; the parameters are placeholders).

Of the 214 `SymbolClass` mappings, **only 16 bitmaps map directly to a class name**; the other **43 bitmaps have
no class name** (referenced as children by `Sprite`/`DefineShape`). Those 16 are:

```
desktopicon  logo  imgback  cambitmap
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wbottom,wleft,wmiddle,wtop,wright}SkinClass
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wmiddle,wtop,wright}SkinClass_200
```

> **The earlier version had two errors here**:
> ① the examples **`small_gift`/`checkbom` are not among those 16** — measured, they are **`DefineSprite`
> (tag 39)**: `small_gift` = symbol 19, `checkbom` = symbol 154, which puts them in the "needs display-tree
> parsing" bucket (next section).
> ② **12 of the 16 are fully-qualified names** (`com.vsdevelop.controls.scrollbar.*`). That is a hard constraint
> on "approach one: `new ResourceClass`" — real code almost never writes `new com.vsdevelop....(...)`; scrollbar
> skins are normally referenced from inside the component classes or fetched with `getDefinitionByName`. **So for
> a library like `skin.swc`, approach two is the one that actually works**; approach one is only convenient when
> the library has short top-level resource classes such as `logo`.

**AS3-side reference styles (two, by code style)**:

| Reference style | Typical code | codegen wiring | Applicability |
|---------|---------|-------------|---------|
| `new ResourceClass(w,h)` directly | `var b:Bitmap = new Bitmap(new logo(0,0));` | Resource class registered as a `BitmapData` subclass; `new` dispatched to the "fill from embedded pixels" factory (ignoring args, using tag width/height) | short top-level names (4/16 measured) |
| `SymbolClass` reflection | `getDefinitionByName("logo")` | Resource registry `{name → factory pointer}`, dynamic lookup | all 16 (including the 12 fully-qualified) |

> The reflection path is **no longer "a later extension"**: `emit.ts` already has a
> `flash.utils.getDefinitionByName` registry (round-tripping `getQualifiedClassName` ↔ `getDefinitionByName`),
> so registering resource classes in it is reuse. Given 12/16 of `skin.swc` are fully-qualified,
> **approach two is the recommended primary implementation**, with approach one as a convenience addition.

---

## 7. Implementation Landing Points (Aligned with AGENTS.md Layering)

| Layer | Change | Notes |
|----|------|------|
| **Build layer `src/swc.ts` (new)** | SWC extractor | ZIP parse + CWS/ZWS decompression + stage-header skip + tag scan + bitmap extraction + **un-premultiply (§3.2)** + **PNG re-encode** (JPEG tags copied verbatim), producing `SwcResource[]` (class name / format / width / height / **`encoded` bytes**). Includes a ~100-line, zero-dependency PNG encoder (Node `zlib`, §5.1). **Reads resources only; it does not parse `DoABC` bytecode** (§3.3); it also reads `catalog.xml`'s `<script>/<dep>` to feed the §3.3.3 early diagnostic |
| **Build orchestration `src/build.ts`** | `--swc` argument / manifest `swc-paths` | Collect SWC dependencies, invoke the extractor; if a resource section exceeds the implementer-set threshold, emit a separate resource `.c` and wire it into `sources` (§5.1, **no split by default**) |
| **Semantic layer `src/symbols.ts`** | Resource class registration | Register resource class names as `BitmapData` subclasses (`dynamic`, constructor `(int,int)` but **arguments ignored**) |
| **Semantic layer `src/emit.ts`** | Resource section emission + `new`/reflection dispatch | Emit the C **encoded-bytes** resource section (PNG/JPEG, §5.1); dispatch `new logo(w,h)` to the "embedded bytes → Skia decode → BitmapData" factory using the **resource's own** size; also register resource classes in the existing `getDefinitionByName` registry (§6) |
| **Runtime `src/runtime.ts`** | **nothing to add** | What is needed already exists: `as_skia_image_decode_bytes_argb(data, len, &w, &h)` (`emit.ts` already uses it on the `Loader.loadBytes` path), internally `DeferredFromEncodedData` + `readPixels(kUnpremul)` → straight ARGB directly. The earlier version's `as_skia_image_from_bytes` row was redundant |

**Hard boundary**: extraction logic (ZIP/SWF parsing) may **only** live at compile time (`swc.ts`) and must
**never** be pushed into `RUNTIME_PREAMBLE` — that would force a SWF parser into the runtime, violating the
"front end only translates" rule (AGENTS.md §1.3). The same applies to un-premultiplication: compile time.

**Second boundary**: `swc.ts` **reads resources only and never parses `DoABC` bytecode** (§3.3) — bytecode→C
needs a decompiler or an AVM2 interpreter and is a separate initiative. `catalog.xml`'s `<dep>` is used only for
the **name-level** early diagnostic (§3.3.3).

---

## 8. Relationship to Ruffle (Reuse Evaluation)

> **First, a common misconception: Ruffle does not decompile.** It treats AVM2 bytecode as an **executable
> artifact** and runs it — it is a VM/emulator, not a decompiler, so it never produces source. Its implementation
> (verified against `ruffle-rs/ruffle` master):
>
> | Stage | What it actually does |
> |---|---|
> | `swf/src/avm2/read.rs` | Parses ABC into **its own IR** (`AbcFile{constant_pool, methods, metadata, instances, classes, scripts, method_bodies}`), and `read_op()` decodes each instruction into an `Op` enum |
> | `core/src/avm2/activation.rs` | `loop { match op { Op::PushDouble{..} => self.op_push_double(..), … } }` — **an interpreter main loop** |
> | `core/src/avm2/optimizer.rs` + JIT | Its own comment: "Most methods are executed in **JIT mode**" — a **runtime** JIT, not compile-time C generation |
> | `core/src/avm2/verify.rs` / `swf/src/avm2/write.rs` | Bytecode verifier / writer (for tests) |
>
> So "no source" is not a problem for Ruffle at all (it does not need source); it is a problem for us (we
> translate to C — see §3.3.2). But as §3.3.0 shows, only 3 KB of mx/flex classes actually lack source in this
> library — so **we do not need to imitate its interpreter route either**.

Ruffle's `swf` crate has a complete `read_tag_with_code` (including `DefineBitsLossless`/`DefineBitsJPEG`
parsing), **but it is not portable** (Rust + `gc_arena` GC). Its value is as a **reference implementation**:

- `swf/src/read.rs`'s tag-header parsing and `DefineBitsLossless2` field offsets
  (`characterID/bitmapFormat/width/height/zlibData`) serve as a **format baseline** for our hand-written
  `swc.ts` parser;
- `make_lzma_reader` (mangled LZMA header handling) matters only for `ZWS`. **Note**: SWF's `ZWS` layout is
  measured in §4 and differs from the LZMA-alone 13-byte header, so copying `make_lzma_reader` would actually be
  wrong.
- `swf/src/avm2/read.rs`'s `read_trait` / `read_method` / `read_constant_pool` is the **authoritative baseline
  for ABC section order** (the four semantic traps in §3.3.1 were settled against it); again, reference only —
  no code vendored.

**No Ruffle code is vendored**; it is only used to align format details.

---

## 9. Phased Plan (**numbering TBD**)

> **The stage numbers in this section are void.** The earlier draft claimed "stage sixty-six / sixty-seven /
> sixty-eight", but those numbers are already used by **other, completed features** — sixty-six =
> `Vector.<T>` higher-order/sequence methods (v0.3.69), sixty-seven = deferred items across three subsystems
> (v0.3.70), sixty-eight = the `--package xcode-project` generator (v0.3.71). Reading the original text would
> wrongly suggest SWC support already exists. **Request a fresh number from `TODO.md` when implementation
> starts.**

- [ ] **A. `src/swc.ts` extractor (compile time)**: ZIP central-directory parse → `library.swf` ZIP-layer
      raw-inflate → CWS `inflateSync` (ZWS per §4) → skip stage header → scan tags; extract
      `DefineBitsLossless2` (tag 36) / `Lossless` (tag 20, add `A=0xFF`) / `DefineBitsJPEG2/3`;
      **un-premultiply per §3.2**, then **re-encode as PNG** (JPEG tags keep their original bytes); parse
      `SymbolClass`(76)'s `{id → className}`. Produce `SwcResource[]`
      (`className`/`format`/`width`/`height`/**`encoded` bytes**).
      Includes a ~100-line, zero-dependency PNG encoder (Node `zlib`, see §5.1)
- [ ] **B. Resource class registration + embedded-byte filling (codegen)**: `symbols.ts` registers them as
      `BitmapData` subclasses; `emit.ts` emits the resource section (§5.1, **default: same `.c`**) plus
      both `new`/`getDefinitionByName` dispatch paths, with the factory calling the **existing**
      `as_skia_image_decode_bytes_argb` (§5, §7 — **no new runtime API**)
- [ ] **C. CLI / manifest wiring + wrap-up**: `--swc` (repeatable) + manifest `swc-paths`; regress all existing
      examples; sync README limitations; bump the version
- [ ] **D. Early diagnostic (small, but recommended for the first iteration)**: read `catalog.xml`'s
      `<script>/<dep>` and report a compile-time error for "a reference to a class that exists only as ABC
      bytecode inside the SWC" (§3.3.3). **It decompiles nothing** — just name-level set arithmetic. It is the
      safety net for the inevitable "user code references an SWC-only class" case, and costs next to nothing

**Acceptance baseline (reuse this revision's data directly)**: run the extractor on `temp/skin.swc` and check
① all 16 named resources extracted; ② `logo` is 100×72 and holds the **un-premultiplied** values (decode to
straight ARGB first, then encode as PNG);
③ **pixel-by-pixel comparison against `adl`'s `getPixel32`** (§11 method), allowing ±1 per channel;
④ volume: the 16 resources' encoded bytes total ≈ **14.6 KB** (PNG), C source ≈ **43 KB** (not 7.42 MB);

---

## 10. Explicit Deferrals / Limitations

| Item | Reason |
|----|------|
| `ZWS` (LZMA) SWC | `temp/skin.swc` is `CWS`; the layout is given in §4, so the cost is low, but the value is limited — deferred |
| Fonts (`DefineFont*`) | Two paths must be distinguished: **the app.xml `<embedFonts>` path is already implemented** in `air-app.ts` (producing manifest `font-urls` / `preload-paths`); **fonts embedded inside an SWC are not handled** — measured, `temp/skin.swc` contains **7 `DefineFont3`**, which is a separate decoding domain ("fonts from an SWC") |
| Sound (`DefineSound`) | Measured: `temp/skin.swc` has **none** (0); if encountered later it is a separate domain |
| Nameless bitmaps referenced by `Sprite` (43) | Needs full `DefineSprite`/`PlaceObject` display-tree parsing; **note `small_gift`/`checkbom` belong here** (the earlier version miscounted them among the 16) |
| `[Embed]` metadata syntax | **Not an existing shortcut**: `Embed` currently has no semantic-layer consumer (§1); the own-project scenario needs implementation too |
| `DefineBitsJPEG4` (tag 90) | Measured absent from `temp/skin.swc`; same family as JPEG3, trivial to support alongside |
| **Code embedded in the SWC (ABC bytecode)** | **Out of scope, not "deferred"**: measured 255 `DoABC` = 254 classes / 54,162 B of bytecode. Container reading is solved (§3.3.1, self-proven by 255/255 round-trip), but bytecode→compilable output needs a **decompiler or an AVM2 interpreter** (§3.3.2) and is a separate initiative. The realistic shape is "resources from the SWC, code from `.as` sources", with `<dep>` driving the compile-time diagnostic (§3.3.3). **Measured: only 8 mx/flex classes (3,135 B) lack source** — hand-writing them closes the gap (§3.3.0) |

---

## 11. Appendix: Measurement Method and Data (Reproducible)

This section records the method used for the re-verification, so future regressions can align with it.

**① Headless unpacking audit** (no third-party library):

```
Node: zlib.inflateRawSync for the ZIP layer → zlib.inflateSync for the CWS layer
      → skip the stage header (nbits = body[0] >> 3; header = ceil((5+4*nbits)/8) + 4 bytes)
      → scan tags (when length == 0x3f, read the following UI32)
```

**② AIR ground truth (`adl`)**:

```as3
// Link the SWC with mxmlc (-include-libraries+=skin.swc; only this actually embeds resources):
var bd:BitmapData = new logo(0, 0);           // args ignored; yields 100x72
bd.getPixel32(x, y)                            // dump every pixel; compare against the local extraction
```

Pitfalls hit along the way:

- `-library-path+=` does **not** embed resources (the resulting SWF was only 748 B); you must use
  `-include-libraries+=` (SWF grows to ~692 KB and the assets are genuinely embedded).
- `adl`'s `trace()` **does not reach stdout** (it goes to the AIR debug log). To collect data, write it with
  `File`/`FileStream` and finish with `NativeApplication.nativeApplication.exit()`.
- Pass the application descriptor as an **absolute path**, and follow project convention with `-- <appDir>`.
- `mxmlc` emits **`ZWS`** by default; to parse a self-built SWF locally, decode LZMA per §4's `ZWS` layout.

**③ Key measured data**:

| Item | Value |
|---|---|
| `skin.swc` | 743,520 B; ZIP holds `catalog.xml`(5,570/84,463) + `library.swf`(737,700/737,552) |
| `library.swf` | `CWS`, version 44, body 1,031,069 B, 1,504 tags |
| Bitmap tags | 59 = `DefineBitsLossless2`×53 + `DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2 |
| `SymbolClass` | 1 tag, 214 mappings; of the 59 mapped to bitmaps, **16 named / 43 unnamed** |
| `catalog.xml` | 255 `<script>` entries (= class count; `library.swf` also has 255 `DoABC`) |
| The 16 named resources | `desktopicon`(342×194) `logo`(100×72) `imgback`(200×200) `cambitmap`(700×393, tag20) + 12 `com.vsdevelop.controls.scrollbar.*SkinClass[_200]` |
| Pixel byte order | `A,R,G,B` (7200/7200 first byte == AIR alpha) |
| Premultiplied | Yes (340,644 samples: `R|G|B > A` zero times; `A=0` with non-zero RGB zero times) |
| AIR un-premultiply | `floor(stored*255/A + t)`, `t ∈ [0.329, 0.413)`; `floor(x+1/3)` = 219/219 exact |
| Embedding cost (raw ARGB → `0xNN,`) | 1,555,412 B raw → **7,777,060 B of C source ≈ 7.42 MB** (the wrong plan) |
| **Embedding cost (PNG re-encode, recommended)** | PNG binary **14,569 B** → C source (`\xNN`) **43,723 B ≈ 42.7 KB** (**178×** smaller) |
| tag payload (for comparison) | the 16 resources total **13,097 B** inside the SWC |
| One resource (`cambitmap` 700×393, tag20) | raw **1,100,400 B** → PNG **8,070 B** |
| `DoABC` | 255 (tag 82); ABC container total **252,737 B** |
| ABC content | 254 classes / 1429 methods / 1316 method bodies / **54,162 B bytecode** / string **9,977** entities (raw count incl. reserved slot: 10,232) / largest single body 2,234 B |
| ABC parse self-proof | **255/255** modules round-trip exactly (consume to the last byte) |
| ABC category breakdown (mutually exclusive) | bitmap resources 16 (152 B) / `extends MovieClip` 192 (5,489 B; only 89 named `skin_fla.*`) / interfaces 6 (6 B) / mx/flex 8 (3,135 B) / other logic 37 (32,465 B) = 254 classes, **41,242 B**; + unattributed 12,920 B = 54,162 B |
| Classes lacking source | **only the 8 mx/flex classes (3,135 B)**, 5 of them empty interfaces (1 B each) |
| Module-level bytecode top | `StringCore` 4,373 / `DownLoader` 3,576 / `TweenLite` 2,799 / `MD5` 2,616 / `mx.core.BitmapAsset` 2,515 / `JSONTokenizer` 2,480 / `MHIOSScrollBar` 2,333 / `MWIOSScrollBar` 2,195 / `ComBoBox` 1,557 |

**④ ABC (`DoABC`) audit** (the source of §3.3's data):

```
Use §4's headless unpacking to get the SWF body → scan tags and collect tag 82 (DoABC):
  payload = u32 flags + NUL-terminated cstring moduleName + ABC
Then parse the ABC in §3.3.1's section order and tally classes/methods/bodies/bytecode bytes.
```

**Self-proof method**: the parser must **consume every module exactly to the last byte** (round-trip), and
**only 255/255 proves the section order correct** — it is the only criterion that demonstrates "nothing desynced
silently" (a wrong order also "runs to completion"; every later field is merely garbage, which the eye easily
misses).

Traps (all listed in §3.3.1): the metadata table comes **after** the kind payload (reading it first is the most
insidious desync source); a `HAS_OPTIONAL` entry is `value u30 + kind u8`; `HAS_PARAM_NAMES` reads `param_count`
names (not `param_count+1`); pool counts include reserved slot 0 while method/class/script/method_body/metadata
counts are exact; **the `class_info` vector has no count prefix** (its length = `instance_count`); **pool index 0
is a reserved slot**, so name lookups must read `pool[idx-1]`.

This re-audit tripped three more (folded into §3.3.1), which shows "reading the container correctly" really needs
self-proof rather than eyeballing:
① treating `class_info` as an ordinary vector and reading one extra u30 → total desync;
② forgetting `pool[idx-1]` → every name turns to garbage (but **nothing errors**; only round-trip reveals it);
③ aggregating bytecode per class via a **single method-index table shared across modules**, when method indices
   are **numbered per module** — cross-module collisions inflate the numbers (this is why §3.3.0's per-class
   bytecode must be aggregated **per module**).

Authoritative reference: Ruffle's `swf/src/avm2/read.rs` (`read_trait` / `read_method` / `read_constant_pool`) —
**a format baseline only, no code vendored**.

**Open item (left to the implementation phase)**: `t`'s exact value can only be narrowed with more
`(alpha, stored)` pairs (this sample has no observations with frac ∈ (0.5874, 0.6709), so any `t` in that band
fits). `1/3` is fine in practice; exact per-channel parity with AIR would require synthesising a resource that
covers that fraction band.