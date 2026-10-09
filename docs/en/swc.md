# SWC Resource Extraction and Embedding

> This document answers one question: **when a pure-AS project packs resources such as images into an SWC,
> how does the AOT compiler get those resources out and display them in the UI**.
> The core conclusion up front: an SWC is a ZIP archive, but the resources **are not standalone files inside
> the ZIP** — they are compiled by mxmlc into `library.swf` and stored as SWF binary tags (bitmaps →
> `DefineBitsLossless2`/`DefineBitsJPEG2`, mapped to class names via `SymbolClass`).
> So "parse an SWC to get resources" = **unpack the ZIP → decompress the SWF → scan the tag stream → extract
> bitmap pixels / JPEG bytes**.
> This chain runs at **compile time** (on the Node side, zero third-party dependencies), turning resources into
> C byte arrays embedded in the artifact; runtime decoding/display reuses the existing Skia backend (the same
> `DeferredFromEncodedData` path as `BitmapData.loadFile`).
>
> **Scope boundary (must read)**: besides resources, `library.swf` also holds **255 `DoABC` blocks** — the real
> AVM2 bytecode of 254 classes (54,162 B of pure code). This plan **treats the SWC purely as a resource
> container; code is out of scope**: bytecode → compilable artifact needs a decompiler or an AVM2 interpreter,
> which is another product (see §3.3).
>
> **But "code" constrains the main body very little** (re-examined 2026-09-26): measured, the **only** classes
> lacking source are **8 classes in `mx.core`/`mx.utils`, 3,135 B** (5 of them empty interfaces, so about 150
> lines are actually needed); the other 240+ classes either have `.as` **source** (37 logic classes / 32,465 B)
> or have bitmaps/timelines rather than code as their "content" (16 resource classes + 192 skin symbol classes,
> whose class-level bytecode totals only 5,641 B and is almost entirely empty constructors). So this plan is
> **not blocked by "code"** (see §3.3).
>
> **Status (re-verified 2026-09-26, v0.3.138): this document is a "plan" document, not yet implemented.**
> `src/swc.ts` does not exist, `src/` contains no `swc` reference, the CLI has no `--swc` and the build
> manifest has no `swc-paths` (none of the 10 manifests' `sources` list contains a `.c`), and git history has
> no related commit; `TODO.md` marks it as "research complete · implementation deferred (pending a user
> decision)".
>
> **This re-verification corrected seven errors in the earlier version; when reading, take this page as
> authoritative**:
> ① It described `BitmapData.pixels` as an "RGBA buffer" (it is actually **straight ARGB**);
> ② It counted `small_gift`/`checkbom` as two of the 16 bitmap resources (they are actually `DefineSprite`);
> ③ It underestimated the embedding cost as "a few hundred KB of JPEG" (measured, using the earlier form of
> "raw pixels → `0xNN,` array", it is **7.42 MB of C source**);
> ④ **It missed premultiplied alpha** — the one omission that directly produces a visible bug (see §3.2);
> ⑤ **It missed an entire category of SWC content: code** — the 255 `DoABC` blocks (254 classes / 54,162 B of
> bytecode) did not appear in the earlier version's "explicit deferrals" table at all; and the class breakdown
> only went to the parent-class level, treating "192 `skin_fla/*`" as one category (measured: 192 is the total
> number of `extends MovieClip`, of which only 89 are named `skin_fla.*`), which also led to a **misjudgment**
> of source availability (see §3.3);
> ⑥ **Wrong embedding form**: the earlier version decoded `DefineBitsLossless*` into **raw ARGB** and embedded
> it as a C array, measured at **7.42 MB** of source; switching to embedding the **encoded bytes** (PNG
> re-encoding / JPEG raw byte copy) needs only **42.7 KB** (a **178×** difference), and **reuses the existing
> decode path** — `as_skia_image_decode_bytes_argb` **already exists**, it is not "to be added" (see §5, §7);
> ⑦ **An entire category of content omitted: vector shapes** — the earlier version equated "resources" with
> bitmaps and **did not handle `DefineShape` at all** (this document mentioned the count
> `DefineShape*×378` only once, in the tag distribution table). Measured, these tags are the **bulk** of this
> library's resources: 378 shapes / 5,052 edges / 401 fill styles (including **73 bitmap fills**), and **43
> shapes have multiple fills** — **the existing runtime's `Graphics` model (single `SkPath` + single fill +
> single stroke) simply cannot carry that** (see the new §3.4, §5.3).
>
> The technical conclusions here are all based on **unpacking measurements** of the real `temp/skin.swc`
> (743,520 B, 255 classes, 59 bitmap resources), cross-verified against the AIR SDK's `adl` for
> `getPixel32` ground truth (method in §11). Note that this file lives in the **repository root**'s `temp/`,
> not `as3compiler/temp/`.

---

## 1. Why This Requirement Exists: SWC Is the Resource Carrier in Pure-AS Projects

In the Flash/Flex ecosystem, resources (skin bitmaps, icons, fonts) have two possible homes:

| Scenario | Resource storage | Extraction difficulty | Current compiler state |
|------|---------|---------|---------------|
| Own project + `[Embed(source="a.png")]` | the original image is still in the source directory | low — read the original directly, **no need to touch the SWC** | **also unimplemented**: `parser.ts` only does generic metadata parsing (`parseMetadataIfPresent`), and `Embed` has no semantic-layer consumer; apart from comments and `EmbedFont` (app.xml fonts), `src/` has no Embed handling |
| Third-party library / a skin library exported by Flash IDE | the original image is unavailable, only the `.swc` | high — must unpack the SWC + parse the SWF | covered by this plan |

The user's scenario is the latter: `temp/skin.swc` is a UI skin library exported by Flash IDE (with resource
classes `logo`/`imgback`/`desktopicon`/`cambitmap` etc.), whose original images are lost, so they can only be
extracted from the SWC.

> Both roads require writing code, so don't treat the first row as an "existing shortcut" — its only advantage
> is **not needing to parse SWF**.

---

## 2. Anatomy of an SWC: ZIP Shell + Embedded SWF

Rename the `.swc` suffix to `.zip` and unpack it; the standard structure has only two files (`docs/` is an
optional ASDoc document):

```
skin.swc (ZIP archive)
├── catalog.xml     84,463 B (uncompressed) / 5,570 B (after deflate) — component catalog: <script> lists each class and its dependencies (<dep>)
└── library.swf    737,552 B (uncompressed) / 737,700 B (after deflate) — the build product: an SWF container (CWS = zlib compressed)
```

The structure of `catalog.xml` (measured on `temp/skin.swc`):

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

**Key fact**: `catalog.xml` only describes "which classes exist and what they depend on"; it **contains no
resource bytes**. The real image bytes are in `library.swf`. The earlier version recorded `catalog.xml` as
"84 KB" and `library.swf` as "737 KB" — those two numbers are actually not the same measure (the former
uncompressed, the latter compressed), and need not be reconciled.

Measured addendum: `catalog.xml` has **255** `<script>` entries in total; `library.swf`'s SWF header has
`version = 44`, and its tag stream contains **255 `DoABC` (tag 82)** — exactly the source of "255 classes"
(consistent with `catalog.xml`).

> `<dep>` is not just documentation: it is a **ready-made dependency graph** (which classes depend on whom,
> and whether it is inheritance or implementation), used in §3.3.3 for the compile-time early diagnostic on
> "referencing a class that exists only as bytecode".

---

## 3. The Real Storage Form of the Resource: SWF Tags

`library.swf` is a standard SWF container; the first 8 bytes `CWS` mean zlib compression (`FWS` =
uncompressed, `ZWS` = LZMA). Measured, `temp/skin.swc`'s `library.swf` is **CWS** (decompressed body =
1,031,069 B). After decompression comes the tag stream, each tag being a `(code:length) header + data body`.

> **Important**: before scanning the tag stream you must skip the SWF stage header — `RECT` (`nbits` starts
> with 5 bits, total `5+4*nbits` bits) + `frameRate`(UI16) + `frameCount`(UI16). Measured, this file has
> `nbits=17` and a **14-byte** header. An earlier implementation that scanned from body offset 0 would get a
> pile of meaningless tag codes (easily misjudging "there are no bitmaps").

Resource-related tags (measured tag type distribution):

| `[Embed]` type / resource | SWF tag | tag code | Data body contents |
|---|---|---|---|
| PNG/lossless bitmap | `DefineBitsLossless` | 20 | SWF's own bitmap format, **no alpha** (see §3.1) |
| PNG/lossless bitmap (with alpha) | `DefineBitsLossless2` | 36 | SWF's own bitmap format, **with alpha** (see §3.1) |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **the complete JPEG bytes** (starting `FF D8`) |
| JPEG (with alpha) | `DefineBitsJPEG3/4` | 35/90 | JPEG + alpha data |
| Raw bytes | `DefineBinaryData` | 87 | `characterID` + raw bytes |
| Fonts / sounds | `DefineFont*` / `DefineSound` | 10/48/14/75 | font/audio data |
| **symbol → class name** | `SymbolClass` | 76 | `{id → "class name"}` mapping |
| Timeline movie clip | `DefineSprite` | 39 | display tree (`PlaceObject` children) |

Measured, `temp/skin.swc`'s `library.swf` has **59 bitmap tags** (`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2), and **214 mappings** in `SymbolClass`;
plus `DefineSprite`×333, `DefineShape*`×378, `DefineButton2`×29, **`DefineFont3`×7**.

### 3.1 Important Pitfall: `DefineBitsLossless` Stores **Not PNG**, and tag 20 ≠ tag 36

This is the easiest pit to fall into. `DefineBitsLossless2`'s data body is **not** a PNG file but SWF's own
custom bitmap format:

```
DefineBitsLossless2 (tag 36) data body:
  characterID   u16   (symbol id)
  bitmapFormat  u8    (3 = 8-bit with color table; 4 = 15-bit RGB; 5 = 32-bit **ARGB (with alpha, premultiplied)**)
  width         u16
  height        u16
  [colorTableSize u8]  (only when bitmapFormat==3; actual color-table entry count = this value + 1)
  zlibData      ...   (zlib-compressed pixel data)
```

Measured, extracting `symbol#2` (`logo`): `characterID=2, format=5, 100×72`, decompressed pixels
`28800 bytes = 100×72×4`, the first 16 bytes all 0 (transparent edge), non-zero pixels 37.1% — valid image
content.

**tag 20 and tag 36 must not be conflated**: their data-body layouts are almost identical, but **tag 20's
format 5 is 24-bit RGB (XRGB, the first byte is padding with no alpha semantics)**, while only tag 36's
format 5 is true ARGB. Treating tag 20's first byte as alpha would make a whole image fully transparent on a
product where the padding bit is `0x00`. Measured, the only tag 20 in `temp/skin.swc` happens to be the
**largest resource**, `cambitmap` (700×393, 1,100,400 B of pixels, whose padding bit is exactly `0xFF`, so it
happens to display correctly — and that "happening to" is exactly what must be avoided).

**Conclusion**: `DefineBitsLossless*` requires "decompress zlib → get the raw pixels" and **cannot** be fed
directly to Skia's `MakeFromEncoded` (which only recognizes encoded formats such as PNG/JPEG). Whereas
`DefineBitsJPEG2` stores **the complete JPEG**, which can be fed to Skia directly.

### 3.2 Pixel Format Contract (added by the 2026-09-26 re-verification; the only omission that causes a visible bug)

A raw bitmap's pixels have two properties that must be clarified first: **byte order** and **whether it is
premultiplied**. Both have been settled against `adl` ground truth.

**① Byte order = `A, R, G, B` (the first byte is alpha)** — verified pixel by pixel on 7200/7200: the
`px[0]` we parse out and `logo.getPixel32()`'s alpha channel are **exactly equal**, without exception.

**② The data is "premultiplied ARGB", whereas AIR's `getPixel32` returns "straight ARGB".**

Verification method and results:

- **Controlled experiment** (a self-made PNG with known straight values, compiled through `mxmlc` and
  observed at both ends): after writing a pixel with `R=200, G=100, B=50, A=4`, AIR read back
  `A=4, R=191, G=64, B=0`. If the storage were straight, the readback would be 200/100/50; what is actually
  read back is the result of "scaling an extremely small premultiplied value back up"
  (`R_pm≈3` → `3×255/4=191.25`), and **`B` is lost entirely (50→0)** — because `50×4/255<1` was truncated.
- **Statistical verification**: across all 7200 pixels of `logo` in the SWC, the number of pixels with
  **`R|G|B > alpha` is 0** and the number with **alpha=0 but non-zero RGB is 0** — exactly the signature of
  premultiplied data (straight data could hardly satisfy both at once).
- **AIR's exact de-premultiplication rule** (reverse-solved from 340,644 channel samples across
  `logo`+`imgback`+`desktopicon`, 219 distinct `(alpha, stored)` combinations): `(alpha, stored) → AIR value`
  is a **pure function** (0 conflicts across the 219 combinations), equal to
  `floor(stored × 255 / alpha + t)`, `t ∈ [0.329, 0.413)`.
  **`floor(x + 1/3)` hits 219/219 exactly** across all 219 combinations; compared with the most common
  `round(c*255/a)`, the maximum deviation is only **−1** (2/219 exceptions, the other 217 identical).

**What this means**: this plan's runtime buffer is **straight ARGB (`0xAARRGGBB`)**, consistent with AS3's
`BitmapData` contract (see §5, §7). So **"filling `BitmapData.pixels` directly with the decoded ARGB pixels"
is wrong** — it yields an overall darker result, and the lower the alpha the worse the error:

| Scenario | Stored value | Filled directly (wrong) | After de-premultiply (correct = AIR) |
|---|---|---|---|
| `logo`'s A=31 pixel | R=24 | 24 (87% too dark) | **197** |
| Controlled-experiment A=4 pixel | R=3, G=1, B=0 | 3 / 1 / 0 | **191 / 64 / 0** |

**Correct approach**: de-premultiply **at compile time** (convert right when `swc.ts` extracts), so the
embedded bytes are straight ARGB directly, with zero runtime cost. Reference implementation:

```c
/* compile time (Node side): stored premultiplied ARGB -> straight ARGB.
   t = 1/3 is the value fitted from measurement for AIR (threshold band [0.329, 0.413)), pixel-identical to AIR. */
static uint8_t out = a == 0 ? 0 : min(255, (int)floor(c * 255.0 / a + 1.0 / 3.0));
```

> Do **not** do it the other way (de-premultiplying at runtime decode): that would pollute the construction
> path of every resource class instance, and would be inconsistent with `BitmapData.loadFile`'s path where
> "Skia already gives straight pixels". Doing it at compile time both saves runtime cost and unifies the
> semantics of the embedded bytes with `getPixel32`'s return value.

> If in the future you don't want to depend on the fitted value `t=1/3`, falling back to `round(c*255/a)` is
> also acceptable — the difference from AIR is ±1 channel level (visually indistinguishable); but you must
> **never skip de-premultiplication**.

### 3.3 The Other Tag Category: Code (`DoABC` / ABC Bytecode) — **a Scope Declaration, Not a "Deferral"**

Besides bitmap resources, `library.swf` also holds **255 `DoABC` (tag 82)** blocks, which are the **real AVM2
bytecode of 254 classes**, not empty placeholders. Measured (a self-written parser round-trips **255/255**
modules exactly; method in §11):

| Metric | Measured |
|---|---|
| `DoABC` modules | **255** |
| Total ABC container | **252,737 B** |
| Classes / methods / method bodies | **254 / 1429 / 1316** |
| **Pure bytecode** | **54,162 B** (21% of ABC; the rest is constant pools and metadata) |
| String constants | **9,977** (entity count; the raw count including reserved slot 0 is 10,232) |
| Largest single method body | 2,234 B |

The content is real logic, not symbolic placeholders (sorted by single-module bytecode):

| Module | Bytecode | Note |
|---|---|---|
| `com/vsdevelop/utils/StringCore` | 4,373 B | in-house utility library (largest) |
| `com/vsdevelop/air/download/DownLoader` | 3,576 B | in-house downloader |
| `com/greensock/TweenLite` | 2,799 B | Greensock tweening library |
| `com/adobe/crypto/MD5` | 2,616 B | AS3 crypto |
| `mx/core/BitmapAsset` | 2,515 B | Flex framework |
| `com/adobe/serialization/json/JSONTokenizer` | 2,480 B | JSON parser |
| `com/vsdevelop/controls/scrollbar/MWIOSScrollBar` | 2,195 B | scrollbar component |
| `com/vsdevelop/controls/ComBoBox` | 1,557 B | combo box component |

#### 3.3.0 The Full Breakdown of the 254 Classes (including **source availability** — the real data deciding feasibility)

The earlier version only broke down to the parent-class level and concluded, wrongly, that "about 240 classes
have no source to compile". Recomputing by a **mutually exclusive** partition (class-level bytecode = counting
only methods attached to instance/class traits):

| Category | Count | Class-level bytecode | Content | Source availability |
|---|---|---|---|---|
| Bitmap resource classes (`extends BitmapData`×4 / `BitmapAsset`×12) | 16 | **152 B** | content=bitmap, the class is just a 9–11 B constructor | must be synthesized from the SWC (§5) |
| Flash IDE symbol classes with `extends MovieClip` | **192** | **5,489 B** | UI skin components (`alertskin`/`popgiftskin`/`homeskin`…); **the vast majority are 9 B empty constructors**, only a few have real code (`checkbom` 132 B, `toastbtn` 73 B, `devicesitemskin` 62 B, `PPTNextPage(Pre)Button` 51 B) | code can be ignored; the **content** is timeline/bitmap |
| Interfaces (`extends null`) | 6 | 6 B | empty | — |
| `mx.core` / `mx.utils` (Flex) | **8** (of which 5 are the interfaces in the row above) | **3,135 B** | see below | **no source (the only such group)** |
| Remaining logic classes | 37 | **32,465 B** | `TweenLite`/`MD5`/JSON/`StringCore`/`DownLoader`/`X MLLoader`/scrollbar components… | **has `.as` source** |
| **Total** | **254** | **41,242 B** | | |

> **Counting caveat**: class-level bytecode covers only "methods attached to class/instance traits"; the
> remaining **12,920 B** belongs to module-level `script_info` initialization and nested functions not
> attached to traits, and the two add up to the **54,162 B** total (see §11).

> **Two earlier statements corrected**: ① "192 `skin_fla/*` exported by Flash IDE" is inaccurate — 192 is the
> **total** for `extends MovieClip`, of which only **89** are named `skin_fla.*`, the other **103** being
> flat-named skin classes (`alertskin`, `popgiftskin`, `checkbom`…); ② the string constant **entity count** is
> **9,977**; `10,232` is the raw count including reserved slot 0.

**`mx`/`flex` is the only "no source" group, and it is tiny**:

| Class | Bytecode | Form |
|---|---|---|
| `mx.core.BitmapAsset` | 2,464 B | thin wrapper: `extends mx.core.FlexBitmap`, holds `bitmapData`/`smoothing` |
| `mx.utils.NameUtil` | 566 B | utility functions |
| `mx.core.FlexBitmap` | 100 B | `extends flash.display.Bitmap` |
| `mx.core.IFlexDisplayObject` / `IAssetLayoutFeatures` / `IRepeaterClient` / `ILayoutDirectionElement` / `IFlexAsset` | 1 B each | empty interfaces |

That is: **hand-writing about 3 KB of bytecode's equivalent AS3 (≈150 lines) closes the entire "no source"
gap**. Note `mx.core.BitmapAsset` is the **parent class of the 12 `ScrollSkin_*` resource classes**, so it
must have an implementation.

**Conclusion (scope declaration)**: the realistic default form = "**resources from the SWC, code from `.as`
source**". The actual cost of this constraint is small: measured, only the **8 mx/flex classes (3,135 B)** lack
source, and 5 of those are empty interfaces; the other 240+ classes either have source (37 logic classes /
32,465 B) or have bitmaps/timelines rather than code as their content (16 + 192 = 208 classes, class-level
bytecode totaling only 5,641 B). **The earlier version wrongly listed `TweenLite`/the JSON parser/`DownLoader`
among "no source to compile"** (they do have source); reading the original as written would make one think
this plan is stuck on "code".

#### 3.3.1 Reading the Container: Solved, and a Closed Little Problem (~400 lines)

`DoABC` (tag 82)'s data body is **not** the ABC itself but `u32 flags` + an **empty-terminated cstring name**
(the module name, e.g. `com/greensock/TweenLite`) + ABC. ABC parses in a fixed section order, but there are
four semantic pitfalls you must remember (each hit during implementation; settled per Ruffle's
`swf/src/avm2/read.rs::read_trait`):

| Section | Semantics |
|---|---|
| Pool classes (int/uint/double/string/ns/nsset/multiname) | the count **includes reserved slot 0** (entity count = `count-1`) |
| method / class / script / method_body / metadata | the count is the **exact value** (**no** reserved slot) |
| `instance_info` | only when `flags & 0x08` (`CONSTANT_ClassProtectedNs`) is an extra `protectedNS: u30` present |
| `trait_info` | the `kind` byte's **low 4 bits = trait type** (0 Slot/1 Method/2 Getter/3 Setter/4 Class/5 Function/6 Const), **high 4 bits = attributes** (`0x10` Final / `0x20` Override / `0x40` Metadata); **the metadata table comes after the kind payload, not before** |

(Three other details also silently misalign:
① `method_info`'s `HAS_OPTIONAL` entry is **two items**, `value u30 + kind u8`; `HAS_PARAM_NAMES` reads
`param_count` names;
② **the `class_info` vector has no count prefix** — its length is `instance_count` (Ruffle:
`read_vec(instances.len(), read_class)`), and reading one extra u30 misaligns everything;
③ **pool index 0 is a reserved slot**, so when looking up a name you must take `pool[idx-1]` (otherwise you
get a pile of garbage names but **no error**).
Also `trait_info`'s kind 4 (`Class`) has a **class index** as its second field, not a method index — don't use
it to look up a method body.)

A parser implemented this way **consumes exactly to the last byte** for **255/255** modules — that is,
round-trip self-proves correctness, not "looks about right". So **container reading is a ~400-line, fully
testable job**; if it is done in the future, this step is not hard.

#### 3.3.2 Reading the Code: Five Roads, of Which **Only D + E** Are on This Plan's Heading

Method bodies are **AVM2 stack bytecode**, not source. To truly "use" it there are only these roads:

| Option | Approach | Cost |
|---|---|---|
| A. Decompile → AS3 source | bytecode → source → feed the existing frontend | stack→expression, control-flow reconstruction, exception table→try/catch; research-grade (JPEXS / rabcdasm scale), poor fidelity, the output still needs manual repair |
| B. ABC → our AST (skip text) | build `ast.ts` nodes directly | still needs stack→expression and scope/closure semantics, i.e. **writing another frontend**; plus covering AVM2 trait/slot dispatch we haven't implemented |
| C. Embed an AVM2 interpreter | run the bytecode directly | **opposite to AGENTS.md §1's "translate into readable C"**; it is another product |
| **D. Don't parse the code** | treat the SWC only as a resource container, code comes from `.as` | **this plan's positioning** (§7's `src/swc.ts` only extracts resources) |
| **E. Hand-write those classes** | hand-write equivalent `.as` for the "no source" classes | **the realistic choice for the 8 mx/flex classes (3,135 B)**: 5 are empty interfaces, and really only `mx.core.BitmapAsset` / `FlexBitmap` / `NameUtil` — three thin wrappers, **about 150 lines** — need writing (see §3.3.0) |

> Because measured, **only** mx/flex lack source (§3.3.0), the most natural realistic combination is **D + E**
> (everything else goes through source, those few classes hand-written), and **none** of A/B/C is needed.

**So the scope is fixed**: this plan **does not include** "bytecode → C" translation; if classes that exist
only as ABC are to be supported in the future, that requires a **separate project** (a decompiler or an AVM2
interpreter), not a sub-task added here.

#### 3.3.3 Compile-Time Early Diagnostic via `catalog.xml`'s `<dep>` (**recommended for the first iteration**)

Each `<script>` in `catalog.xml` already lists that class's definition and its dependencies and their types
(`<dep id="flash.display:BitmapData" type="s"/>`, `s`=extends / `i`=implements) — **this is a ready-made
dependency graph, and reading it requires parsing no ABC at all**.

Use it to turn "referencing a class that exists in the SWC only as bytecode" from a **silent runtime failure**
into an **explicit compile-time error**:

```
error: class 'mx.core.BitmapAsset' is only available as AVM2 bytecode inside
       'skin.swc' (2,464 B of ABC, not translatable); provide its .as source
       or a source-compatible replacement.
```

> Note the example uses an **mx class** rather than `TweenLite`: measured, **only** the 8 mx/flex classes truly
> lack source (§3.3.0), while `TweenLite`/`MD5`/JSON all **have source**. What the diagnostic should do is the
> intersection of "SWC-only and no `.as` source", not report every bytecode class in the SWC (the latter would
> produce a flood of false positives on classes that do have source).

The approach is a name-level set operation (the class-name set of `catalog.xml` ∩ the frontend symbol table ∩
"no `.as` source") → a hit errors out, **decompiling nothing**. The cost is tiny and the value high: otherwise
the user gets "compiles fine, undefined at runtime", one of the hardest failures to track down.

---

### 3.4 The Other Tag Category: Vector Shapes (`DefineShape`) — **the bulk of this library's assets, entirely omitted earlier**

The earlier version equated "resources" with bitmaps; `DefineShape*×378` appeared once as a count in §3's tag
distribution table, **with neither a section nor a plan**. Measured, these tags are the **bulk** of this
library's resources (and vectors are precisely Flash's core capability).

**① Measured tag profile** (recursively scanning into `DefineSprite`; `temp/skin.swc`):

| tag | Count | Note |
|---|---|---|
| `DefineShape`/`2`/`3`/`4` (2/22/32/83) | 186 / 50 / 56 / 86 = **378** | vector shapes, payload total **29,774 B** |
| `DefineSprite` (39) | 333 | timeline containers for skin symbols |
| `PlaceObject`(1) / `PlaceObject2`(26) / `PlaceObject3`(70) | 1,479 / 1,935 / 64 | timeline placement records |
| `DefineScalingGrid` (78) | 22 | **nine-slice scaling** (`scale9Grid`); skin stretching must cut per it |
| `DefineButton2` (34) | 29 | button four states |
| `DefineMorphShape`/`2` (46/84) | 4 / 2 | morph shapes |
| `DefineEditText`(37) / `DefineText`/`2`(11/33) | 337 / 3 | text fields (go through the existing `TextField`, not the vector domain) |
| `DefineFont3` (75) | 7 | SWC-embedded fonts (listed in §10) |

**② Measured shape geometry and styles**:

| Item | Measured value |
|---|---|
| Version distribution | v1 186 / v2 50 / v3 56 / v4 86 |
| Total edges | **5,052** (straight 3,059 / **quadratic Bézier 1,993**) |
| Subpaths (`moveTo`) / style switches | 905 / 998 |
| Fill styles 401 | solid 326, **bitmap 73**, linear gradient 2, radial/focal **0** |

| Strokes (`LineStyle`) | 86; **80 shapes have strokes**; **43 shapes have multiple fills** |
|---|---|
| Referenced bitmaps | **39 distinct bitmaps** used as fills |
| v4 `UsesFillWindingRule` | **no shape uses it** (i.e. no even-odd fill rule) |
| Largest shape | 284×432 px |
| Path-building calls | edges 5,052 + `moveTo` 905 = **5,957** → about **233 KB of C** (@40 B/call) |

**③ A shape is not a standalone symbol; it must be handled together with the display tree**:

| Item | Measured |
|---|---|
| `SymbolClass` 214 entries | **196 are `MovieClip` sprites**, 16 bitmaps, 2 buttons; **no shape is exported directly as a class (0/378)** |
| Exported-symbol closure | needs **322 shapes / 327 sprites / 16 bitmaps / 337 edittext**; 4,181 edges → about **194 KB of C** |
| Reference-graph self-check | all 978/978 placed character ids hit known characters |

**④ Format essentials (must read for implementation; aligned with Ruffle's `read_define_shape`)**:

- `SHAPEWITHSTYLE` = `FillStyleArray` + `LineStyleArray` + `NumFillBits`/`NumLineBits` (4 bits each)
  + **shape records (a continuous bit stream)**; a `NEW_STYLES` record **redefines the style table** mid-way
  (and byte-aligns).
- There are only two kinds of edge: **straight lines** and **quadratic Béziers** → mapped directly to
  `SkPath::lineTo` / `quadTo` (no cubics, no arcs).
- **Each subpath carries its own `fill0` / `fill1` / `line` index** → you must build and draw **per subpath**,
  not merge into one path drawn in a single pass (43 shapes in this library have multiple fills).

**⑤ Two bit-order pitfalls (measured; the easiest to misalign silently)**:

- **`LINESTYLE2` (only shape v4)'s flags are an MSB-first bit stream**: `JoinStyle` falls on bits 13–12
  (`JoinStyle==2` means miter). If read as a little-endian `u16`, the field order is reversed → everything
  after it in that shape drifts (measured: 5 v4 shapes failed to parse for this reason). Criterion:
  `MiterLimitFactor`'s `FIXED8` commonly has the value **4.0 = `0x0400`**, and when misread this value turns
  into an impossible number like 0.0156.
- **`PlaceObject2`'s flags are LSB-first** (the opposite of the previous item): `HasCharacter = 0x02`.
  Also note each `DefineSprite` ends with a **zero-length `PlaceObject` (the bytes `40 00`)**; without a length
  guard you read a garbage reference with `id=0` (measured: it polluted 336 references).
- **The self-check criterion is the same as for ABC**: the parser must **consume exactly to the end of the
  tag** — this library's **378/378** all hit before the section order is considered correct.

**⑥ Relationship to the bitmap plan**: the 73 bitmap fills reference exactly 39 of those 59 bitmap tags —
**vectors and bitmaps are two halves of the same channel, and only one half cannot be done**. The runtime-side
gap and the size scale are in §5.3.
---

## 4. Compile-Time Extraction Chain (End-to-End Re-verified)

```
SWC (ZIP)
  │  ① hand-written ZIP central-directory parsing (Node side, zero dependencies)
  ▼
library.swf (a deflate-compressed CWS file)
  │  ② zlib raw-inflate to undo the ZIP layer → the CWS file bytes
  ▼
CWS file ("CWS" + version + fileLength + zlib stream)
  │  ③ zlib inflate to undo the CWS layer → the SWF body
  ▼
SWF body (skip the stage header: RECT + frameRate + frameCount)
  │  ④ scan tag by tag, hitting DefineBitsLossless2(36)/Lossless(20)/JPEG2(21)/JPEG3(35)
  ▼
Bitmap resources:
  ├─ Lossless2/Lossless → zlib decompress → raw **premultiplied** pixels (+ width/height)
  │                         ├─→ de-premultiply → straight ARGB (§3.2, compile time)
  │                         └─→ **PNG re-encode** (§5.1, a ~100-line encoder) → encoded bytes
  └─ JPEG2/3   → complete JPEG bytes (+ alpha) — **raw byte copy, zero conversion**

Both are handed uniformly to the existing runtime interface (§5): as_skia_image_decode_bytes_argb → straight ARGB → BitmapData
```

**Re-verification results** (the real `skin.swc`, re-run 2026-09-26):

```
① ZIP-layer deflate decompress: 737,700 B → CWS 737,552 B
② CWS-layer zlib decompress:    → SWF body 1,031,069 B
③ stage header skipped:         nbits=17 → 14 bytes
④ 1,504 tags total, 59 bitmap tags (36×53, 20×1, 21×3, 35×2), SymbolClass with 214 mappings
⑤ Lossless2 extraction:         characterID=2, format=5, 100×72, 28,800 B of pixels
⑥ 37.1% non-zero valid content; aligned point by point with adl's getPixel32 (§3.2) — extraction correct
```

**Feasibility with zero third-party dependencies**: the ZIP central-directory structure (the `PK\x01\x02`
header + the `PK\x05\x06` EOCD tail) is hand-parsed in about 30 lines; zlib decompression uses Node's
built-in `zlib.inflateSync`/`inflateRawSync`; SWF tag scanning is about 40 lines. All of it happens in the
compile frontend (Node side), consistent with AGENTS.md §3.1's "zero third-party dependencies".

**The exact `ZWS` (LZMA) layout** (the earlier version only said "needs mangled-header handling" without
giving the method; now measured and solved):

```
'ZWS' + version(1) + fileLength(4, = total decompressed length)
  + compressedLength(4)          ← note: this 4-byte length field is easily missed
  + lzmaProps(5)                 ← props[0] → lc/lp/pb; measured lc=3, lp=0, pb=2
  + LZMA1 raw stream             ← the dict comes from props[1..4] (measured 0x200000 = 2 MB),
                                    with an unknown decompressed length (validated against the SWF header's fileLength)
```

That is, "LZMA raw filter + lc/lp/pb/dict recovered from props" is enough; no mangled-header patch like
`make_lzma_reader` is needed (that one is for the 13-byte LZMA-alone header). `temp/skin.swc` is `CWS`, so this
path can be skipped in the first iteration, but since the layout is settled, implementing it is cheap.

---

## 5. Resource → Output: Embedding the **Encoded Bytes** (this section was rewritten after measurement)

The user has decided on **compile-time extraction, compile-time embedding** (an AIR resource class's
constructor is **synchronous** and cannot be turned into runtime asynchronous loading).
But the **content form** of the embedding was chosen wrongly earlier: the earlier version decoded
`DefineBitsLossless*` into **raw ARGB** and put a C array into the artifact. Measured, this is the single
biggest waste of source size (see §5.1); it should be changed to **embedding the encoded bytes**:

| Resource format | Embedded content (**encoded bytes**) | Runtime decode |
|---------|----------------------|-----------|
| `DefineBitsJPEG2/3` (21/35) | **raw JPEG byte copy** (zero conversion) | existing `as_skia_image_decode_bytes_argb` |
| `DefineBitsLossless2` (36) | **de-premultiply** at compile time (§3.2), then **re-encode as PNG** | same as above |
| `DefineBitsLossless` (20) | same as above, but the source data has no alpha → write `A=0xFF` | same as above |

**Why this is equivalent, and better**:

- **Zero new runtime code**. The needed API **already exists** —
  `as_skia_image_decode_bytes_argb(data, len, &w, &h)` (`runtime.ts`; non-Skia builds have a same-named stub)
  internally does `SkData::MakeWithCopy` → `SkImages::DeferredFromEncodedData` →
  `readPixels(kBGRA_8888, kUnpremul)` → `sk_bgra_readback_to_argb`, **producing straight ARGB directly**.
  `emit.ts` already uses it on the `Loader.loadBytes` path.
- **Fidelity**. PNG is lossless, and the information loss of "rounding after premultiplication" happens at
  **compile time**, under our control: what goes into the PNG is exactly the AIR readback value computed in
  §3.2.

  > **Measurement correction (2026-10-05, during stage-ninety-five implementation)**: the earlier version said
  > here "runtime decoding gets the same set of straight ARGB, `getPixel32` **aligns point by point**" — that
  > statement is **too strong and has been rewritten per measurement**. Verified in two stages:
  >
  > 1. **The PNG we write out is point-by-point exact**: decoding `encodePng`'s output with a pure decoder
  >    (zlib inflate + filter 0, without Skia) and comparing against `adl`'s `getPixel32` ground truth gives
  >    **322,300 pixels with maxChannelDiff=0** (logo/imgback/cambitmap). Compile-time extraction and
  >    de-premultiplication have **no deviation whatsoever**.
  > 2. **The deviation comes from Skia's runtime decode, and only on semi-transparent pixels**:
  >    `readPixels(kBGRA_8888, kUnpremul)` does not do "straight" for a straight-alpha PNG — Skia internally
  >    premultiplies via `SkMulDiv255Round`, then unpemultiplies via `(v*255 + a/2)/a`, and the two roundings
  >    let the result drift by ±1. Measured, AOT artifact vs `adl`: **206 of 388,648 pixels differ (0.053%),
  >    all with maxChannelDiff=1, and all falling on `logo`'s A∈{143,191} semi-transparent pixels** (imgback /
  >    desktopicon / cambitmap show 0 deviation — their alpha is only 0 or 255, so both roundings are
  >    identities).
  >
  > Conclusion: this is consistent with §11 acceptance criterion ③ "±1 channel deviation allowed"; the **alpha
  > channel is bit-exact**, and it is visually indistinguishable. This is Skia library boundary behavior, not a
  > defect in our implementation; eliminating it entirely would require shipping our own PNG decoder (zlib
  > inflate + unfilter) in the generated C to bypass Skia's alpha transform, a cost disproportionate to the
  > benefit, so it is **not done** (recorded as a known limitation in §10).
- **Size**: see §5.1, a **178×** difference in source size.

> **Note the "buffer format"**: `BitmapData.pixels` is a **`uint32` array storing the straight ARGB value
> `0xAARRGGBB`** (`runtime.ts`'s `sk_surface_read_argb` comment declares exactly this; `getPixel32`/`setPixel32`/
> `threshold`/`colorTransform`/`copyChannel`/`merge`/`paletteMap`/`floodFill` and the `(c>>16)&0xFF` convention
> all depend on that contract). The earlier version recording it as an "RGBA buffer" was wrong — on a
> little-endian machine that value's **memory bytes** are indeed `B,G,R,A`, which is naturally consistent with
> Metal's `BGRA8Unorm`, **but the value semantics are always ARGB**.
> (That is: we **never** write into `pixels` byte-wise; we always go through Skia decode to get straight ARGB
> values, independent of host endianness.)

> **`as_skia_image_from_bytes` need not be added**: the earlier version listed it as "to be added / does not
> currently exist"; measured, that capability is already provided by `as_skia_image_decode_bytes_argb` (see §7).
> The glue side now uses `SkImages::DeferredFromEncodedData` (not the earlier version's `MakeFromEncoded`).

### 5.1 Embedding Form and Source-Size Cost (**three forms measured item by item**; earlier estimate corrected)

Measured item by item for `temp/skin.swc`'s **16 named resources**:

| Form | Total | Note |
|---|---|---|
| Compressed bytes in the SWC (tag payload) | **13,097 B** | fmt5 is zlib-compressed **premultiplied** ARGB |
| Decoded to raw ARGB | **1,555,412 B** | what the earlier plan intended to embed |
| **Re-encoded as PNG** | **14,569 B** | only 11% larger than the tag payload |
| PNG embedded in C source (`\xNN` escaped string) | **43,723 B ≈ 42.7 KB** | **the form to adopt** |
| Raw ARGB embedded in C source (`0xNN,`) | **7,777,060 B ≈ 7.42 MB** | **the earlier plan — wrong** |

Looking at only the largest, `cambitmap` (700×393, tag 20): raw ARGB **1,100,400 B** → PNG **8,070 B**.

**A 178× difference in source size**. So the resource section should look like this (encoded bytes, not
pixels):

```c
/* SWC resource: skin.swc#logo (100x72) — PNG bytes; decoded at runtime by
   as_skia_image_decode_bytes_argb (same path as Loader.loadBytes). */
static const unsigned char __res_skin_logo_png[] =
  "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR...";   /* PNG total 1,651 B */
static const int __res_skin_logo_w = 100;
static const int __res_skin_logo_h = 72;
```

**No longer in conflict with stage seventy-eight**: the resources total about **42.7 KB of C source** (5%
relative to `hello.as`'s 854 KB), entirely embeddable within a **single `.c`**, consistent with "a single-file
`.c` is the default form". Only because the earlier version chose the raw-pixel form did it have to write
"the resource section **must** be a separate `.c`" — **that mandate is withdrawn along with this section's
conclusion**:

- **Default**: the resource bytes are embedded into the same `.c` (no need to split at the measured scale).
- **Exception**: if some SWC's total resources make the single `.c` exceed an implementer-set threshold
  (e.g. >5 MB of source), degrade to "a separate resource `.c` + build-manifest `sources` merge" — already
  supported by the build layer (AGENTS.md §2.9).
- In both forms, `-O2` discards unreferenced resource sections and does not affect the final binary size.

  > **Measurement correction (2026-10-05, implementation)**: the first half of that sentence **holds but needs a
  > qualifier**. Under native `-O2`, comparing `hello.as` (referencing no resource at all) with the same plus
  > `--swc temp/skin.swc`: the binary goes **130,552 → 195,880 B (+≈65 KB)**, of which `__text` 59,012 → 99,556
  > (**+40.5 KB of code**) and `__data` 4,088 → 17,384 (**+13.3 KB of tables**). **The embedded PNG bytes
  > themselves are indeed discarded** (no resource's complete bytes can be found in the artifact), but **the 16
  > synthesized resource classes are not trimmed** — their constructors/`_new`/vtables/props tables/registry
  > entries reference one another into a cluster that the linker cannot drop from the reachable roots (and this
  > is **the semantics §6 wants**: `getDefinitionByName("logo")` must be resolvable at any time). So the
  > accurate statement is: **unreferenced resources' "bytes" are discarded, but the resource "classes'" cost
  > stays in the artifact** (16 classes, about 53 KB, i.e. ≈3.3 KB per class). Only when a resource is
  > referenced do its bytes truly enter the artifact.

> **A PNG encoder is needed at compile time**: implementable with Node's built-in `zlib` (IHDR/IDAT/IEND + a
> filter 0 per row, about 100 lines, zero third-party dependencies). `DefineBitsJPEG2/3` tags already store a
> complete JPEG, so **the raw bytes are copied, with no encoder needed**. Measured, all 16 named resources in
> this sample are lossless (no JPEG hit), so the first iteration must implement the PNG encoder.

### 5.2 Resources That Should *Not* Be Embedded: the Desktop / Web / Mobile Channel (**already exists — do not rebuild it**)

"Resources" are not only the compile-time-known bitmap classes in an SWC. Large images, audio, fonts, and
external data **should not** be compiled into the `.c` — they need lazy loading, and the web's first paint
should not carry a huge `.wasm`. The good news is that this channel **is already implemented and dispatched by
platform**:

| Platform | Existing mechanism | Code location |
|---|---|---|
| desktop native | the executable runs with **CWD = app directory**, and `File.applicationDirectory` resolves to that directory → resources are just **ordinary files** (`assets/...` placed alongside), matching `adl`'s install-directory semantics | `air-app.ts` |
| web (wasm) | the browser sandbox FS is empty → under `--package web`, `findPreloadPaths()` hands the entries under the app directory (excluding `src/`, the `<filename>*` artifact prefix, dotfiles) to **`--preload-file <root>@<dest>`** to pack a FS image (+ `-s FORCE_FILESYSTEM=1`), so **the same `assets/...` path** is readable in the browser too | `build.ts` (`preloadPaths`), `air-app.ts::findPreloadPaths` |
| macOS / iOS (`.app`) | `--package xcode-project` generates an application bundle, and resources go through **PBXResourcesBuildPhase** (currently `icon` is implemented; fonts via `font-urls`) | `xcode-project.ts`, `pbxproj.ts` |
| **Fonts (a ready precedent)** | `<embedFonts><font><fontPath>` → manifest `font-urls` → **on web, fetched at runtime and injected into Skia's font manager** | `air-app.ts`, `html5-web.md §3` |

> **Platform maturity (same measurement)**: `--package xcode-project` **currently supports macOS only**
> (a non-native `--target` errors explicitly; iOS needs a separate project), and `--package android-project`
> directly reports `not yet implemented`. So of the "three platforms", what is actually usable today is
> **desktop + web**; `.app` only reaches macOS.

**Resources should therefore be split into two layers** (this is the design decision this section fixes):

1. **Runtime-loadable** (large images, audio, fonts, external data) → go through the **file + preload/
   Resources channel** (table above). Naturally adapted on all three platforms, and web can even lazy-load.
2. **Compile-time symbolized** (`new logo()`, `new ScrollSkin_topSkinClass()`) → must be **embedded** (§5.1),
   because an AIR resource class's constructor is **synchronous**.

> **One exception that must be stated explicitly**: layer 2 **cannot** degrade into "lazily load from disk on
> first access" — that would turn `new logo()` from synchronous into needing a frame pumped, which is
> **changing semantics**. Better to embed (measured, only 42.7 KB).

---

### 5.3 Vector Shapes: Also a Compile-Time Bake, but the Runtime Gap Is the `Graphics` Model

Vectors and bitmaps **share the same channel** (§3.4⑥), but the landing form differs: bitmaps only need the
encoded bytes embedded + decode reuse; shapes must be **translated at compile time into C code that "builds an
`SkPath` + paints it"** (an AIR resource class's constructor is synchronous ⇒ no lazy loading).

The good news is that the **target model is naturally isomorphic** (`skia.md` §4: `Graphics` ↔
`SkPath`/`SkPaint`), so this is translation rather than a new engine.
**The bad news is that the runtime capability has hard gaps**:

| Capability | Current state (`vendor/skia_glue.cc`, 1,101 lines) |
|---|---|
| Path | ✅ `moveTo/lineTo/quadTo/cubicTo/addRect/addCircle/close/getBounds` all present |
| Paint | ✅ color/alpha/fill/stroke/line width/antialiasing |
| Gradients | ⚠️ **only two-color linear** (`SkGradientShader::MakeLinear`, 2 stops + `kClamp`; `Graphics_beginGradientFill` even hard-codes the coordinates to `0,0→100,0`). Missing radial/focal, multi-stop, spread/interpolation |
| Bitmap-fill shader | ❌ none — and this library needs it in **73** places |
| Stroke details | ❌ no cap/join/miter (`LineStyle2` fields), no "stroke using a fill" |
| Fill rule | ❌ no `setFillType` (even-odd) — unused in this library, can be deferred |
| **`Graphics` model** | ❌ **simply not enough**: it is currently "one `SkPath` + one fill + one stroke", `endFill` is a no-op, and it **never calls `sk_path_close`**; whereas a real `DefineShape` is **per-subpath** `fill0/fill1/line` indices (§3.4④) |

So the work is not just "add a few glue functions"; the `Graphics` model must be upgraded from "single path,
two paints" to a "**subpath + style-index table**" model.

Size scale: bitmaps 42.7 KB (§5.1) + vectors 194–233 KB (§3.4②③) ≈ **0.28 MB of C**, still within the
acceptable range for "the single-file default form" relative to `hello.as`'s 854 KB (§5.1), so **no** forced
split into a separate `.c`. Code must also be generated for sprite timelines/placements (3,478 placement
records).

---

## 6. AS3-Side Reference Semantics: Resource Class = `BitmapData` Subclass

This is the key to how codegen lands resource references. In the ABC of `temp/skin.swc`'s `library.swf`:

```
public dynamic class logo extends flash.display::BitmapData
  public function logo(int,int):*
public dynamic class imgback extends flash.display::BitmapData
public dynamic class desktopicon extends flash.display::BitmapData
public dynamic class cambitmap extends flash.display::BitmapData
```

**Resource classes (`logo`/`imgback`/`desktopicon`/`cambitmap` etc.) are dynamic subclasses of
`flash.display.BitmapData`**, constructor signature `(int width, int height)`. This is the standard form of a
skin library exported by Flash IDE.

> **The constructor arguments are ignored** — measured, `new logo(0, 0)` yields a `BitmapData` of **100×72**
> (the real size comes from the SWF tag), not `0×0`. The factory **must use the resource's own width/height**
> and must not trust the arguments (writing `new logo(0,0)` is the customary style in the Flash IDE ecosystem;
> the parameter is a placeholder).

And of the 214 mappings in `SymbolClass`, **only 16 bitmaps map directly to class names**, the other **43
bitmaps having no class name** (referenced by `Sprite`/`DefineShape` as children). Those 16 are:

```
desktopicon  logo  imgback  cambitmap
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wbottom,wleft,wmiddle,wtop,wright}SkinClass
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wmiddle,wtop,wright}SkinClass_200
```

> **The earlier version had two errors here**:
> ① The examples **`small_gift`/`checkbom` do not belong to these 16** — measured, they are
> **`DefineSprite` (tag 39)**, i.e. `small_gift` = symbol 19, `checkbom` = symbol 154, falling into the
> "display tree must be parsed" tier (the next section).
> ② **12 of the 16 are fully qualified names** (`com.vsdevelop.controls.scrollbar.*`). This is a hard
> constraint on "approach one: directly `new resourceClass`" — real code would hardly write
> `new com.vsdevelop....(...)`, and scrollbar skins are usually referenced inside a component class or fetched
> via `getDefinitionByName`. **So on a library like `skin.swc`, what is actually usable is approach two**, and
> approach one is only convenient when the library has short-named resource classes (such as a top-level short
> name like `logo`).

**AS3-side reference approaches (two, by user code style)**:

| Reference approach | Typical code | codegen landing | Applicability |
|---------|---------|-------------|---------|
| Direct `new resourceClass(w,h)` | `var b:Bitmap = new Bitmap(new logo(0,0));` | the resource class is registered as a `BitmapData` subclass, and `new` dispatches to an "embedded pixel fill" factory (ignoring the arguments, using the tag's width/height) | top-level short-named resources (measured 4/16) |
| `SymbolClass` reflection | `getDefinitionByName("logo")` | a resource registry `{name → factory pointer}`, looked up dynamically | all 16 (including the 12 fully qualified names) |

> The reflection path is **no longer a "later extension"**: `emit.ts` already has a
> `flash.utils.getDefinitionByName` registry (`getQualifiedClassName` ↔ `getDefinitionByName` round trip), so
> registering the resource classes into it is a reuse.
> Given that 12/16 of `skin.swc` are fully qualified names, **approach two is recommended as the primary
> landing**, with approach one as a convenience supplement.

---

## 7. Implementation Landing Points (Aligned with AGENTS.md Layering)

| Layer | Change | Note |
|----|------|------|
| **build layer `src/swc.ts` (new)** | SWC extractor | ZIP parsing + CWS/ZWS decompression + stage-header skip + tag scan + bitmap extraction + **de-premultiply (§3.2)**, producing `SwcResource[]` (class name/format/width/height/straight ARGB pixels or JPEG bytes). **Reads resources only, does not parse `DoABC` bytecode** (§3.3); also reads `catalog.xml`'s `<script>/<dep>` for the §3.3.3 early diagnostic |
| **build orchestration `src/build.ts`** | `--swc` argument / manifest `swc-paths` | collect SWC dependencies and call the extractor; when the resource section exceeds a threshold, generate a separate resource `.c` and wire it into `sources` (§5.1, **no split by default**) |
| **semantic layer `src/symbols.ts`** | resource class registration | register the resource class names as `BitmapData` subclasses (`dynamic`, constructor `(int,int)` but **arguments ignored**) |
| **semantic layer `src/emit.ts`** | resource-section emission + `new`/reflection dispatch | emit the C encoded-byte resource section (PNG/JPEG, §5.1); `new logo(w,h)` dispatches to the "embedded bytes → Skia decode → BitmapData" factory, with width/height from the **resource itself**; resource classes are also registered into the existing `getDefinitionByName` registry (§6) |
| **runtime `src/runtime.ts`** | **nothing to add** | the needed capability already exists: `as_skia_image_decode_bytes_argb(data, len, &w, &h)` (`emit.ts` already uses it in `Loader.loadBytes`), internally going through `DeferredFromEncodedData` + `readPixels(kUnpremul)` → straight ARGB directly. The earlier version's `as_skia_image_from_bytes` is superfluous |
| **build layer `src/swc.ts` (extension)** | `DefineShape*` → C path-building code | reuse the existing ZIP/CWS/tag scan chain; parse shapes per §3.4④, producing a "subpath + style-index table" intermediate representation, then emit `sk_path_*` calls. **Done at compile time, with zero SWF parsing at runtime** |
| **semantic layer `src/emit.ts` + runtime `src/runtime.ts`** | `Graphics` model upgrade + glue completion | see §5.3: subpath/style-index model, radial gradients, bitmap-fill shader, stroke cap/join/miter, `sk_path_close` semantics |

**Boundary iron rule**: the extraction logic (ZIP/SWF parsing) **may only** happen at compile time
(`swc.ts`), and **must not** be put into `RUNTIME_PREAMBLE` — that would make the runtime carry an SWF parser,
violating the "the frontend only translates" iron rule (AGENTS.md §1.3). De-premultiplication likewise belongs
at compile time.

**Second boundary**: `swc.ts` **reads resources only, does not parse `DoABC` bytecode** (§3.3) — bytecode → C
needs a decompiler or an AVM2 interpreter, which is a separate project. `catalog.xml`'s `<dep>` is used only
for the **name-level** early diagnostic (§3.3.3).

---

## 8. Relationship to Ruffle (Reuse Evaluation)

> **First clear up a common misunderstanding: Ruffle does not decompile.** It treats AVM2 bytecode as an
> **executable artifact** and runs it directly — it is a VM/emulator, not a decompiler, so it never produces
> source. Measured against its implementation (checking `ruffle-rs/ruffle` master):
>
> | Step | Actual approach |
> |---|---|
> | `swf/src/avm2/read.rs` | decodes ABC into **its own IR** (`AbcFile{constant_pool, methods, metadata, instances, classes, scripts, method_bodies}`), and `read_op()` decodes each bytecode into an `Op` enum |
> | `core/src/avm2/activation.rs` | `loop { match op { Op::PushDouble{..} => self.op_push_double(..), … } }` — **the interpreter main loop** |
> | `core/src/avm2/optimizer.rs` + JIT | the original code comment: "Most methods are executed in **JIT mode**" — a **runtime** JIT, not compile-time C generation |
> | `core/src/avm2/verify.rs` / `swf/src/avm2/write.rs` | bytecode verifier / writer (for tests) |
>
> So "no source" is not a problem for Ruffle at all (it doesn't need source); it is a problem for us (we must
> translate to C, see §3.3.2). But as §3.3.0 shows, only 3 KB of mx/flex classes truly lack source in this
> body of work — so **we don't need to imitate its interpreter route either**.

Ruffle's `swf` crate has a complete `read_tag_with_code` (including `DefineBitsLossless`/`DefineBitsJPEG`
parsing), **but it is not portable** (Rust + `gc_arena` GC). Its value is as a **reference implementation**:

- `swf/src/read.rs`'s tag-header parsing and `DefineBitsLossless2`'s field offsets (`characterID/bitmapFormat/
  width/height/zlibData`) can serve as the **format alignment baseline** for our hand-written `swc.ts` parser;
- `make_lzma_reader` (mangled LZMA header handling) is only useful for `ZWS`. **Note**: SWF's `ZWS` layout is
  given by measurement in §4 and differs from LZMA-alone's 13-byte header, so copying `make_lzma_reader` would
  actually be wrong.
- `swf/src/avm2/read.rs`'s `read_trait` / `read_method` / `read_constant_pool` are the **authoritative
  baseline for ABC section order** (the four semantic pitfalls in §3.3.1 were settled from it); likewise as
  reference only, no code imported.

**No Ruffle code is imported**; it is used only to align format details.

---

## 9. Phased Plan (**decided: Stage 95**)

> **This section's stage numbers are void**: the earlier draft occupied "stage sixty-six / sixty-seven /
> sixty-eight", but those three numbers have been taken by **other completed features** — sixty-six =
> `Vector.<T>` higher-order/sequence methods (v0.3.69), sixty-seven = the three-subsystem deferred wrap-up
> (v0.3.70), sixty-eight = the `--package xcode-project` project generator (v0.3.71).
> Reading the original would wrongly suggest SWC is already implemented. **A new number will be requested from
> `TODO.md` when implementation starts.**

> **Project decision (2026-10-05, decided by the user)**:
> ① **number = stage ninety-five** (a separate top-level number, a peer of stage eighty-nine / ninety-four,
> rather than continuing `ninety-four·thirty`);
> ② **the five steps A~E are delivered in the same batch**, with vectors not split into a separate project —
> otherwise an SWC skin would be "bitmaps but no vectors", and the 73 bitmap fills are themselves inside
> shapes;
> ③ the first iteration, on top of §10's deferral table, **additionally includes two items**: **nine-slice
> scaling (`DefineScalingGrid`, 22)** and **button four states (`DefineButton2`, 29)**, see **F** below; the
> rest (timeline animation / SWC-embedded fonts / morph / `ZWS` / sound) remain deferred;
> ④ runtime glue is completed to the **minimal surface measured on this library** (bitmap-fill shader +
> solid/linear gradient + stroke cap/join/miter; radial/focal gradients and even-odd are measured as 0 in this
> library, so deferred);
> ⑤ other defaults: resource-class references **both roads are implemented** (`getDefinitionByName` primary,
> direct `new` as a convenience supplement, §6), de-premultiplication takes `floor(stored*255/A + 1/3)` (§3.2),
> the early diagnostic **D goes with the first iteration**, the resource section **is embedded in the same
> `.c` by default** (§5.1), and the `Graphics` group model **is done fully in one pass**, incidentally closing
> `TODO.md`'s existing same-origin leftover line ("multiple nested `beginFill/endFill` groups", registered in
> stage ninety-four·twenty-two).

- [ ] **A. `src/swc.ts` extractor (compile time)**: ZIP central-directory parsing → `library.swf` ZIP-layer
      raw-inflate → CWS `inflateSync` (ZWS per the §4 layout) → skip the stage header → scan tags; extract
      `DefineBitsLossless2` (tag 36)/`Lossless` (tag 20, filling `A=0xFF`)/`DefineBitsJPEG2/3`;
      **de-premultiply per §3.2**, then **re-encode as PNG** (for JPEG tags, keep the raw bytes); parse
      `SymbolClass`(76)'s `{id → className}`. Produce `SwcResource[]` (`className`/`format`/`width`/`height`/
      **`encoded` bytes**). Includes a ~100-line, zero-dependency PNG encoder (Node `zlib`, see §5.1)
- [ ] **B. Resource-class registration + embedded-byte filling (codegen)**: `symbols.ts` registers it as a
      `BitmapData` subclass; `emit.ts` emits the resource section (§5.1, **embedded in the same `.c` by
      default**) + the two dispatch paths `new`/`getDefinitionByName`, with the factory going through the
      **already-existing** `as_skia_image_decode_bytes_argb` decode (§5, §7, **no new runtime API**)
- [ ] **C. CLI / manifest wiring + wrap-up**: `--swc` (repeatable) + manifest `swc-paths`; regress all old
      examples; bump the version
- [ ] **D. Early diagnostic (small, but recommended with the first iteration)**: read `catalog.xml`'s
      `<script>/<dep>` and give a compile-time error for "referencing a class that exists in the SWC only as
      ABC bytecode" (§3.3.3). **Decompiles nothing**, only a name-level set operation. It is the fallback for
      the inevitable scenario "user code references an SWC-only class", at minimal cost
- [x] **E. `DefineShape` baking + `Graphics` model upgrade (**in the same batch** as A~C, otherwise a skin
      would be "bitmaps but no vectors")**: `swc.ts` extends shape parsing (§3.4④, producing a "subpath +
      style-index table" intermediate representation) → `emit.ts` emits `sk_path_*` building code; the runtime
      gains glue (radial/focal gradients, bitmap-fill shader, stroke cap/join/miter, `sk_path_close`), and
      `Graphics` is upgraded from "single path, two paints" to "subpath + style-index table" (§5.3). The scope
      includes the display tree: `DefineSprite` timelines + `PlaceObject*`'s matrix/color transforms (**frame 1
      is enough to run a static skin**; timeline animation and morph remain in §10's deferral table — note
      **multi-frame timelines have since been completed by G·nine**, see §9.2 F6; nine-slice and button four
      states moved into the first iteration's **F**).
      **Completed; measured data in §9.1**
- [x] **F. Nine-slice scaling + button four states (included in the first iteration, decided 2026-10-05)**:
      `DefineScalingGrid`(78, 22) → runtime `scale9Grid` stretch semantics (otherwise it blurs when scaled);
      `DefineButton2`(34, 29) → `ButtonRecord` parsing + a button state machine (up/over/down/hit four states
      + hit flipping). Both build on A~E's display-tree/shape baking.
      **Completed; measured data in §9.2**
- [x] **G. `PlaceObject3` attributes + display-list observable surface (three later rounds, 2026-10-06)**:
      `Visible=0` (·six, v0.4.64), `FILTERLIST`/`BlendMode`/`BitmapCached` (·seven, v0.4.65), and
      **placeholder children** for unsupported characters (`DefineEditText`/`DefineText`/`morph`) + `clipDepth`
      mask children + placing translation into child `x/y` + Shape declared bounds (·eight, v0.4.66).
      Plus multi-frame **timeline baking** + `FrameLabel` + the `MovieClip` timeline API (·nine, v0.4.68).
      **Completed; measured data in §9.2 F3/F4/F5/F6**

### 9.1 E measurement results (2026-10-05, reproducible)

**Method**: `temp/swc-render/` (the harness's `gen.ts` generates a shared body from `temp/skin.swc`; both
sides render the same batch of exported symbols to `ours.txt` / `adl.txt`, respectively with this compiler and
with `adl`; the comparator is `compare.ts`). Each symbol gets a fingerprint from the 64-cell 8×8 alpha-weighted
cell means (`fp`), the non-transparent pixel count `nz`, and a raw ARGB dump
(`raw_<id>_{ours,adl}.png` + `cmp_<id>.png`).

**Vocabulary**: `exact` = fingerprint/nz/sum all equal; `tol16` = every one of the 64 cells differs in alpha
mean by ≤ 16; `no-struct` = no cell's alpha differs by > 64 (i.e. no structural loss); `colour-ok` = no
structural difference and every **already-colored** cell (both sides' alpha mean ≥ 32) differs per channel by
≤ 16.

**Results (200 symbols = 4 bitmaps + 196 display symbols)**:

| Bucket | Total | exact | tol16 | no-struct | colour-ok |
|---|---|---|---|---|---|
| bitmap | 4 | 3 | 1 | 1 | 1 |
| display (no text) | 39 | 2 | 37 | 37 | 27 |
| display (with text) | 157 | 0 | **90** | **120** | **23** |

> The table above was refreshed on **2026-10-06** with two fixes: ① `PlaceObject3` visibility (§9.2 F3)
> `no-struct 118 → 120`, `colour-ok 21 → 22`; ② `PlaceObject3`'s Filter / BlendMode / BitmapCache (§9.2 F4,
> including alignment of filter `strength` and blur σ) `colour-ok 22 → 23`, with `tol16`/`no-struct`
> unchanged. The bitmap and display (no text) buckets are unchanged throughout.
>
> The bucketing criterion was adjusted once more on **2026-10-06** (§9.2 F5): `元件27_310`'s morph mask is now
> a **child**, and the "with text" bucket's criterion is having a text **or morph** character in the closure ⇒
> `display (no text) 40 → 39`, `display (with text) 156 → 157`, with **each bucket's counts unchanged** (it was
> that bucket's only structurally differing symbol anyway, so after moving it both buckets' `exact/tol16/
> no-struct/colour-ok` are unchanged).

**Item-by-item attribution**:

- **3/4 bitmaps are bit-exact**; the fourth (`cambitmap`) has only 1 cell out of bounds, belonging to the
  Skia de-premultiplication ±1 channel drift already registered in §10.
- **Text-containing symbols (156)**: `DefineEditText`(338)/`DefineText` are unimplemented (§3.3), so the text
  area is necessarily empty — this is a **declared gap** outside the first iteration's scope, not a regression.
  Their tol16 reaches 90/156, showing the vector part outside the text is already aligned.
- **37/40 non-text symbols are within tol16**, and 27 of those even have their colored cells within ±16.
- **`skin_fla_元件27_310` (charId 215) is the only non-text structural difference**: its frame 1 uses charId
  **209** (`DefineMorphShape`, deferred in §10) **as a mask** (`clipDepth=3` covering the child at depth 2). A
  morph mask cannot be expressed as a path clip, so that child is not clipped ⇒ we draw more (nz 6104 vs adl
  3973). **Per the "never silent" principle**, it is reported via `swcBake.notes`; since §9.2 F5 the mask
  object is **kept as a child** (no longer marked `unsupported`).
- **The remaining non-text differences are all low-amplitude color/antialiasing level** (most colored cells
  are also within ±16). Sampling and attributing pixel by pixel: an edge-coverage difference of 1 pixel (ours
  `14,255,255,255` vs adl `0,0,0,0`) is antialiasing; `元件163_149` is a 1px thin-feature difference.
- **~~1 item still open~~ closed (2026-10-06, §9.2 F3)**: `vbitemskin` (charId 293, 146×112) had 541 pixels
  where ours = gray `0x999999` vs adl = white, while **both sides' 64-cell alpha means were exactly equal**
  (`maxda=0`) ⇒ the **coverage shapes agree**, only the fill color differs there. That symbol's tree is depth 1
  `#282` (→ gray rectangle `#86`, 30.5×11px scaled 2.69×4.36), depth 3/4 white rectangle `#283`
  (80×45.5px @1,1), depth 6 `#286`→`#285` (gray body + white triangle), depth 9 three dots (whitened via
  `ColorTransform`), depth 21 the close button; the differing region falls exactly on the intersection of the
  white rectangle `#283` and the gray rectangle `#86`. A byte-level re-check confirmed: `#282`'s `PlaceObject2`
  has no color transform and no `clipDepth` (flags=0x06), and the matrix and scale are correct ⇒ **parsing is
  not at fault**; `adl`'s `#86` fill color is indeed `DefineShape`(code 2)'s RGB `99 99 99` (gray) ⇒ it also
  cannot be explained by "wrong fill parsing". **Root cause located**: `#282`'s depth-6 sibling placement
  (#286) carries `PlaceObject3`'s `Visible = 0`; AIR does not draw it, while we read that field and throw it
  away (§9.2 F3). After the fix that symbol's `maxdcS 76 → 30`, the remainder being antialiasing/color-level
  difference. Original reproduction command:
  `cd temp/swc-render && node gen.ts && node ../../src/index.ts scene.as --manifest t.build.json --run && ./run_adl.sh && node compare.ts`.

**Acceptance baseline (this re-verification's data can be reused directly)**: run the extractor on
`temp/skin.swc`:
① all 16 named resources extracted; ② `logo` is 100×72 and holds the **de-premultiplied** values (first solve
straight ARGB, then encode as PNG); ③ **compared point by point with `adl`'s `getPixel32`** (§11's method),
allowing ±1 channel deviation; ④ size: the 16 resources' encoded bytes total ≈ **14.6 KB** (PNG), C source ≈
**43 KB** (rather than 7.42 MB); ⑤ vectors: **378/378** shapes parse round-trip clean, and the exported-symbol
closure's (322 shapes / 327 sprites) rendering is compared against `adl` screenshots (§3.4, §11⑤);
⑥ nine-slice scaling (22 `DefineScalingGrid`) and button four states (29 `DefineButton2`) compared against
`adl` screenshots.

### 9.2 F measurement results (2026-10-05, reproducible)

F's two items both first measure "what AIR actually does", then decide the implementation form; both add
**zero new runtime APIs** (only `Graphics`/`DisplayObject` internal state and paint paths).

#### F1 Nine-slice scaling (`DefineScalingGrid`, tag 78)

**Parsing**: all 22 grids land on sprites, and the rect is given in twips (`lib.scalingGrids: Map<id,
SwcRect>`); when baking, besides converting `TWIPS = 20` to px and writing it into
`SwcBakeCharacter.scalingGrid`, **all 22 baked characters carry a grid**. Only `#545 元件97` has an exported
class name (i.e. the harness's entry 103, `w:251 h:89`).

**Key semantics (settled by measurement): AIR applies nine-slice stretching only to a character's** own
`scaleX`/`scaleY`**, not to stretching via a timeline `PlaceObject` matrix.** Two independent pieces of
evidence:

| Experiment | Result |
|---|---|
| 1× A/B (a temporary `ASC_NO_S9` switch) letting "timeline placement triggers grid" participate | the difference surface against `adl` **widens in the opposite direction** (42 entries get worse) ⇒ placement stretching must not trigger nine-slice |
| raw pixel-by-pixel comparison of entry 103 after 2× stretching via a container | grid **ON**: 51 px difference from `adl` (0.06%), `nz` 18674 vs `adl` 18676; grid **OFF**: 200 px difference (0.22%), `nz` 18568 |

⇒ The implementation lands accordingly: `emitSwcPlacement` **always** writes the SWF matrix into
`transform.matrix` (never into the object's own `x/y/scaleX/scaleY`), so a nested sprite enlarged by placement
does **not** go through nine-slice — consistent with AIR.

**Runtime**: `as_render_object`'s dispatch chain starts with
`if (o->_s9_on && (o->scaleX != 1.0 || o->scaleY != 1.0))`; the new helper `as_render_nine_slice` bakes once at
natural size (reusing `as_render_cached`'s mechanism and the `ASC_bake_ctm_x/y` compensation, going through
`as_render_filtered` when there is a filter), then reassembles the 9 src/dst strips; **the border strips are
divided by the scale in local units**, so that the canvas transform already applied lands them back at natural
size; when scaled down extremely, the middle segment clamps to ≥ 0 and the borders shrink proportionally.
Strip sampling uses `sk_canvas_draw_image_src_rect` (`kStrict_SrcRectConstraint`, so the middle does not sample
into the borders).

#### F2 Button four states (`DefineButton2`, tag 34)

**Parsing**: `ButtonRecord.states` is a bitmask (0b0001 up / 0010 over / 0100 down / 1000 hit); all 29 buttons
are baked, two of them exported: `#957 downvpage`, `#961 upvpage`. Taking `upvpage` as an example
(`states=5` records):

```
up    : 958
down  : 954 + 960      ← shares 954 with over, the second differs (this is the cyan triangle under AIR)
over  : 954 + 959
hit   : 960 + 252(scale 0.714, 0.261)
```

**State machine**: `as_sbtn_state` selects **at draw time** by the live pointer state — `down` (hover ∧
mouseDown), `over`, else up→over→down→hit fallback. The pointer state (`ASC_mouse_x/y/has/down`) is written
uniformly by `Stage_dispatchMouse`, so **both the window's SDL callback and AS3's
`stage.dispatchMouse(x,y,type)` test hook drive the four states**; off-window (`BitmapData.draw`)
`ASC_mouse_has = 0`, so only the up state is seen — which is why §9.1's offscreen acceptance only compares the
up state.

**Hit determination (the real pit of this item)**: in the window probe hover was always 0. Root cause:
`as_sbtn_contains` initially used `as_pick_hit`, which **only reports InteractiveObject**; a button's hit state
is built from ordinary `Shape`s, so it never hit. Changed to a geometric determination — map the stage point
into the button's local space, then map it into the hit state's own space, and call `as_obj_region_hit_local`
(which walks its own children and outline), i.e. the region AIR actually hits. The fix landed at the **shared
helper** layer: `as_sbtn_contains_local` (local space) was factored out for `as_sbtn_contains` (stage space)
and `as_obj_region_hit_local` to share, so `SimpleButton.hitTestPoint(x, y, true)` also now determines by hit
-state geometry (previously always a miss) — structural regression in `examples/swc-shape.as`.

**Results**:

| Path | up | over | down | fallback |
|---|---|---|---|---|
| ours offscreen (`temp/btnstate/off.as`, triangle pixels) | `4dfcfcfc` (pale) | `ffffffff` (white triangle) | **`ff00948c` (cyan)** | `ffffffff` (reversible) |
| `adl` window screenshot | pale white | white triangle | **(0,147,139) = `0x00938b` (cyan)** | — |

⇒ The down-state cyan is ours `0x00948c` vs `adl` `0x00938b`, a difference within the screenshot's color
management drift; **the four states behave identically**.

**Harness note**: on the window side ours only reliably captures three states (up/over/fallback); the press
frame's report image did not reproduce (`adl`'s side has all four). The same paint path (`as_render_object`) is
pixel-identical to AIR in the offscreen probe, so this is judged a **window reporting/harness limitation**,
not an implementation gap; the offscreen probe `off.as` is the deterministic acceptance criterion for the four
states.

#### F3 `PlaceObject3`'s attributes: visibility implemented, Filter / BlendMode / BitmapCache still discarded

**Origin (found by a survey on 2026-10-06)**: `readSwfPlacement` had always read `PlaceObject3`'s three
attributes and thrown them away. Surveying `temp/skin.swc` (`temp/swc_po3_visible.ts`): **64 `PlaceObject3`
records, 63 of them inside the baked closure of exported symbols** — `hasVisible` 38, `FILTERLIST` 13,
`BlendMode` 8, `BitmapCached` 2.

**① Visibility (`Visible`, implemented)**: all 38 records carrying a `Visible` field have it **all `0`** (AIR
does not draw them). Measured criterion (`temp/vishidden/`, the same body on both sides: `numChildren` +
per-child `visible`):

| Symbol | `adl` | Ours (before the fix) |
|---|---|---|
| `vbitemskin`(#293) | 6 children, `c3.visible == false` (hidden at depth 6, #286) | 5 (the child was skipped entirely) |
| `fileitemdoctorskin`(#63) | 7, of which 2 have `visible == false` | 4 |
| `fileitemskin`(#389) | 5, of which 2 have `visible == false` | 2 |
| `homeskin`(#1121) | 7, all visible | 7 ✓ |

⇒ **AIR creates the child and sets `visible = false`, rather than omitting that placement.** The
implementation lands accordingly: the bake side carries `hidden` into `SwcBakePlacement`, and the emission
side does `if (p.hidden) c->visible = false;`. The render side already skips invisible children
(`as_render_object_content`'s `!ch->visible` branch), so the **pixels are exactly the same as "skip the whole
record"**, while the object tree also aligns with AIR. (The skip-only form can fool a pixel comparison, but
`numChildren`/`getChildAt(i).visible` would give it away.)

**Pixel gains (1× full re-test, 42 entries changed, all improvements)**: `maxdcS` (max channel difference over
colored cells) collapses generally on symbols with `Visible = 0` — `fileitemdoctorskin` **205 → 2**,
`setupskin` 239 → 31, `mymtskin` 211 → 30, `subtitleskin` 181 → 22, `surveyhdskin` 185 → 61,
`systemUpdateSkin` 154 → 37, `onlineskin` 73 → 24, `cretaemeetingskin` 39 → 17, `vbitemskin` **76 → 30**; on
the structural tier (`no cell alpha diff > 64`) `元件1_3`/`元件2_6` **struct 16 → 0**, `userskin` 4 → 1,
`filepreviewskin` 2 → 1. Summary: the text tier `no-struct 118 → 120`, `colour-ok 21 → 22`; the bitmap/display
tiers unchanged.

⇒ **That "unlocated" gray/white difference on `vbitemskin` at the end of §9.1 has exactly this root cause**:
the depth-6 #286 is hidden by AIR and drawn by us (the coverage shape identical, only the fill differing —
precisely the signature of a hidden object over an opaque white rectangle).

**② Not yet implemented at the time**: `FILTERLIST` (13), `BlendMode` (8), `BitmapCached` (2) were still
**read and discarded**, which is AIR-defined behavior ⇒ a legacy defect. **Implemented; see §9.2 F4.**

**Reproduction**:

```
# PlaceObject3 attribute survey (how many records, whether inside the baked closure, the actual Visible values)
node temp/swc_po3_visible.ts ../temp/skin.swc
# Object-tree comparison (one each for ours and adl, per-child visible)
cd temp/vishidden && node gen.ts && ../../src/index.ts ours.as --manifest t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# 1× full pixel re-test (the same harness as §9.1)
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts

# Structural regression (vectors/display tree/nine-slice/button four states, both builds succeed)
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
# F1 nine-slice (entry 103 = 元件97; #545 has a grid)
cd temp/swc-render && RAW=103 SCALE=2,2 node gen.ts && <ours> && ./run_adl.sh && node rawpng.ts 103
# F2 button four states (offscreen, deterministic)
cd as3compiler && node src/index.ts temp/btnstate/off.as --manifest temp/btnstate/off.build.json --run
# F2 button four states (window, ours self-driven + adl real cursor)
cd temp/btnstate && node gen.ts && python3 drive.py <repo>/temp/btnstate/ours <AIRSDK>
```

---

### 9.2 F4 `PlaceObject3`'s Filter / BlendMode / BitmapCache (stage ninety-five·seven, v0.4.65)

**Background**: §9.2 F3's survey found 63 `PlaceObject3` records, of which 13 carry `FILTERLIST`, 8 carry
`BlendMode` and 2 carry `BitmapCached`, and these three had previously been **parsed and then discarded
wholesale** (`SwcPlacement` did not even have the fields). They are all AIR-defined behavior ⇒ legacy defects,
all closed in one pass in this stage.

**Owner distribution** (`node temp/swc_po3_detail.ts ../temp/skin.swc`, counting only records inside the baked
closure):

| Attribute | Count | Detail |
|---|---|---|
| `FILTERLIST` | 13 | 11 × Glow, 2 × DropShadow |
| `BlendMode` | 8 | 7 × value 2 (`layer`), 1 × value 6 (`darken`, `homeskin` depth 2) |
| `BitmapCached` | 2 | the `mymtskin`/`subtitleskin` family |

Glow records are uniformly shaped: `Glow{color:0xff000000, blurX/Y:16, strength:0.19921875, quality:1,
inner:0, knockout:0, composite:1}` (`#343 staticskin`'s char #324; `#647 editnickname` blur 17;
`#672 filepreviewskin`'s d3 char #660 is a **white** Glow, blur 6, strength 10);
the two DropShadow records are identically shaped: `{color:0x7f000000, blurX/Y:10, angle:0, distance:0,
strength:0.5390625, quality:1}` (`#925 skin_fla.元件124_72`'s d1 char #923 and `#931 ()`).

> **Note how to read `0xff000000`**: in SWF, GLOW's `GlowColor` is **RGBA** (the high bits are alpha),
> whereas AS3 `GlowFilter.color` only takes RGB — so `0xff000000` lands on the AS3 side as `color = 0` (black)
> with `alpha = 1`. `0x7f000000` likewise → `color = 0`, `alpha = 0.5`.
> `alpha` and `strength` are two independent quantities (see below); conflating them early on would compute
> the strength wrongly.

**Two key measurements aligning with AIR** (the substantive work of this stage, all measured on adl 51.4.1):

1. **`strength` is a strength coefficient applied *after* blurring, and AIR's model is
   `min(1, silhouette × color alpha × strength)`** (`temp/filterprobe/`: a 40×40 black rectangle drawn into a
   `BitmapData`, reading alpha point by point).
   Glow `strength` 0.2/0.5/1/2 → darkness 4/10/21/42 (per unit 0.0785/0.0785/0.0824/0.0824, **linear**);
   `GlowFilter(alpha 0.5, strength 2)` and `strength 1` render **identically**;
   DropShadow `strength` 0.5/2 → 27/110 (ratio 4.07). ⇒ It must be multiplied **after** blurring.
   - Counter-lessons (each disproved by measurement):
     * Ignoring `strength` entirely: every baked glow draws at full opacity (`staticskin`'s nz was once
       41094 → 52503).
     * Clamping `alpha*strength` to 1 **before** blurring and then tinting: `strength 2` collapses to the
       silhouette (0.212 instead of 0.431); moreover the silhouette itself is opaque, so a pre-factor with
       alpha ≥ 1 saturates completely — at one point `strength 1` and `strength 2` glows were **identical**,
       only separating once the scaling was moved after the blur.
   - Implementation: `vendor/skia_glue.cc`'s `sk_alpha_scale_after(strength, inner)` — an identity matrix +
     one alpha row `{1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,strength,0}`, wrapping the inner filter with
     `SkImageFilters::ColorFilter`; glow and drop shadow each get one layer after the blur.

2. **AIR's blur is "a box blur of diameter = `blurX`, repeated `quality` times", not a Gaussian**
   (same probe, alpha point by point): `blur 6, q1` → alpha at -1/0/1/2/3/4 px from the edge is
   191/148/106/63/21/0 (i.e. 0.75/0.583/0.4167/0.25/0.0824/0, and **0 from `d = 4`**, finite support);
   `blur 12, q1` → d2 74, d4 31; `blur 6, q3` = 3 superimposed boxes.
   A box of diameter b has variance `b²/12` ⇒ **variance-matching equivalent `sigma = blur * sqrt(quality) /
   sqrt(12)`**, replacing the earlier empirical value `blurX / 3.0` (the latter is completely insensitive to
   `quality > 1` and cannot produce "0 beyond 4 px").
   Implementation: the generated C gains `static double as_filter_sigma(double blur, int quality)`.
   - **Residual criterion (registered, not intended to be fixed)**: Skia's blur is "3 boxes approximating a
     Gaussian", so our profile is steeper in the middle and thinner in the tail: for `blur6q1` measured ours
     217/161/94/38/9 vs AIR 191/148/106/63/21. Point-by-point agreement would require `MatrixConvolution` for
     a true box (36~256 taps per layer, non-separable), a performance risk outweighing the benefit.

3. **DropShadow's "double scaling" incident (must be recorded in the document)**:
   the `strength` scaling was initially wrapped around the **output** of Skia's `SkImageFilters::DropShadow` —
   but that Skia factory is the composite of "shadow **+ source**", so **the source itself was also multiplied
   by `strength`**. Symptom: in the 1× harness two symbols with DropShadow (`popcontrolskin`,
   `skin_fla.元件124_72`) went struct 0→12/14 and `maxda` 6→118; a pixel-by-pixel re-check of `RAW=29`
   (popcontrolskin, 425×124) showed **36.34% of pixels differing**, and the per-cell alpha map showed the
   entire bar's alpha as **137/255 = 0.537** — exactly that record's `strength` of **0.539** — the source had
   been thinned by 54% overall.
   ⇒ It now branches by **the two intervals that are both exact**:
   * `alpha*strength ≤ 1` and the source is needed: bake the whole imprint into the **shadow color**
     (`alpha*strength`) and use `SkImageFilters::DropShadow` to let Skia composite the source itself, with the
     **caller no longer redrawing the source**;
   * otherwise (the imprint would cross 1, or AIR's `CompositeSource = 0` / AS3's `hideObject` means the source
     is not drawn): use `SkImageFilters::DropShadowOnly` + post-blur `strength` scaling, with the caller
     drawing the source separately — exactly reproducing AIR's saturation interval
     (`alpha 1, strength 2` → edge pattern 0.431, not the clamped 0.212).
   The generated-C side corresponds to `int drawSource = !ds->_shadow_only;` and
   `if (drawSource && ds->alpha * ds->strength > 1.0) as_render_filtered(...)`.

**Landing mapping**:

| SWC | AS3 / C runtime | Note |
|---|---|---|
| `FILTERLIST` 0 DropShadow | `DropShadowFilter_new(...)` | color split by RGBA into `color` (RGB) + `alpha`; `CompositeSource = 0` → `hideObject = true` |
| `FILTERLIST` 1 Blur | `BlurFilter_new(bx, by, passes)` | `passes` goes straight into `quality` |
| `FILTERLIST` 2 Glow | `GlowFilter_new(...)` | same as above; `CompositeSource = 0` has no AS3 counterpart field, so it goes through the C runtime's private bit `_shadow_only` |
| `FILTERLIST` 3–7 | **reported** (`notes`) | Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix skip bytes only by documented length, never silently |
| `BlendMode` | `DisplayObject.blendMode` (a String slot) + the `BlendMode` constant class | `layer` = pure group isolation (`saveLayer` + `kSrcOver`, glue returns 1); `darken/multiply/screen/lighten/difference/add(→kPlus)/overlay/hardlight` map to `SkBlendMode`; **a mode Skia cannot express returns 0 and is reported**, never approximated |
| `BitmapCached` | `DisplayObject_set_cacheAsBitmap(true)` | the same path as AS3 `cacheAsBitmap` |

**Two structural decisions** (both the established technique of "AS3 attributes stay readable, the C field
layout is unchanged"):

- **`blendMode` is an ordinary String slot** (like `name`): the default literal `"normal"` lives in rodata and
  needs no write barrier.
- **`cacheAsBitmap` becomes a private backing slot `_cache_flag`**: reading a statically typed AS3 field takes
  the C struct slot directly and **bypasses the accessor**, so if `cacheAsBitmap` remained a public slot,
  `c.cacheAsBitmap` would not see the "OR-ed with `filters`" semantics. Now the public name exists only in
  `getters`/`setters`, and the `get` body is
  `if (o->_cache_flag) return true; return o->filters != NULL && o->filters->length > 0;`
  (measured in AIR: an object that has had `filters` set reports `cacheAsBitmap` true), while the C side and
  the render side still use `_cache_flag` (after the change, `temp/attrsprobe/`'s cache column matches AIR item
  by item).

- **The blend layer is the outermost wrap of `as_render_object`** (the color transform `ct` and `clipDepth` are
  both inside it), and the restore order is clip → ct → blend.

**Acceptance** (1× harness, the same one as §9.1; baseline file `temp/swc-render/rep_final.txt`):

```
bitmap  total=4    exact=3  tol16=1  no-struct=1  colour-ok=1
display total=40   exact=2  tol16=37 no-struct=37 colour-ok=27
text    total=156  exact=0  tol16=90 no-struct=120 colour-ok=23
params: ours lines 200, adl lines 200, ERR ours/adl 0/0
```

That is: bitmap and display (no text) **are unchanged**, and the text tier's `tol16/no-struct` is unchanged
while `colour-ok 22 → 23`. Item by item it is **uniformly better, worse nowhere** (`staticskin` maxdc 93 → 35 /
maxda 7 → 3, `popinfoskin` maxdc 185 → 79, `poproomIdsskin` maxdc 100 → 13, `popnoticskin` maxdcS 34 → 5,
`poppluginskin` maxdcS 10 → 7, `popmiccamskin` maxdcS 4 → 1, `popgiftskin` maxdc 38 → 23,
`popsubtitleskin` maxda 5 → 3 — and the two DropShadow symbols that got worse at v0.4.64 are back to
baseline).

**Reproduction**:

```
# Po3 attribute survey (with a kind histogram and per-record shape)
node temp/swc_po3_detail.ts ../temp/skin.swc
# Strength model / box-blur model / invariants (run once per side; CHK identical line by line)
cd temp/filterprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh
# Attribute fingerprint (filtered children, blendMode, cacheAsBitmap item by item against adl)
cd temp/attrsprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# Pixel-by-pixel re-check of the DropShadow double-scaling incident (entry 29 popcontrolskin 425x124)
cd temp/swc-render && RAW=29 node gen.ts && <ours> && ./run_adl.sh && node rawpng.ts raw_ours.bin raw_adl.bin . && node pixq.ts 29
# 1× full pixel re-test
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts
# Structural regression (tree and field assertions for glow / darken / layer / cacheAsBitmap; pure structure, no Skia)
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
```

---

### 9.2 F5 Placeholder children for unsupported characters + child transform/bbox alignment (stage ninety-five·eight, v0.4.66)

**Background**: the `temp/childfx/` probe (15 exported symbols / 99 children) prints `numChildren`,
`getQualifiedClassName`, `x/y`, `width/height`, `transform.matrix`, `visible` per child against `adl`.
Before the fix: `x/y` were **all wrong** (we always reported `0,0`), `numChildren` was too small (`minfo` we
reported 2 vs `adl`'s 6), and `width/height` differed in **39** places.
After the fix: **`x/y` 0 mismatches, `numChildren` 0 mismatches, `width/height` 35** (3 of those from missing
morph geometry, the rest precision-level differences ≤ 0.021px).

**① Unsupported characters become placeholder children (never silent)**

- `DefineEditText`(37) / `DefineText`(11): measured **341** in this library (338 + 3) ⇒ baked as an **empty
  `TextField`** (`as_swc_new`'s `'text'` branch = `TextField_new()` + `_fieldWidth/_fieldHeight` taken from the
  declared `RECT` size), so `numChildren` / `getChildAt` index order match AIR. Glyphs and initial text remain
  a **declared gap**, reported via `notes`
  (`341 DefineText/DefineEditText character(s) are baked as EMPTY TextField placeholders …`).
- `AutoSize` measured: bit `0x80` of `DefineEditText`'s second flags byte is **0 for all 341** in this
  library; we do parse it out (`SwcText.autoSize`) — since it is all 0, reporting the placeholder box per the
  `RECT` matches AIR.
- `DefineMorphShape`(46) / `2`(84): measured **6** inside the closure ⇒ baked as an **empty `Shape`** (AIR
  uses `MorphShape`, a subclass of `Shape`; this project has no such class, so `getQualifiedClassName` reports
  `Shape`). The tree (count/index) aligns and **no wrong pixels are drawn** (an empty Shape draws nothing);
  the missing geometry is reported via `notes`.
- The old implementation was "`unsupported` ⇒ skip at the placement", which would leave **no child at all**;
  now it is "create a placeholder + report". `is TextField` holds for text children
  (`examples/swc-shape.as` ⑦ assertion).

**② The `clipDepth` mask object is a child, not "a nonexistent child"**

Measured, `skin_fla.元件27_310`'s `c0` is a `MorphShape` in AIR, `visible=true`, with its own bbox (1×18),
only **never drawn**. Before the fix we marked mask characters `unsupported` — which would make that character
**disappear at any position** (a latent bug). Now it is changed to: the mask placement **is kept as a child**,
plus a private field `_mask_object` (C-runtime only; `false` when a DisplayObject is constructed), and
`as_render_object` / `as_pick_hit_m` skip it entirely. A morph/sprite mask cannot be expressed as a path clip
⇒ one `notes` line reports it (`clipDepth mask …`), no longer `unsupported`. Measured `fileitemskin.c2`:
AIR `n=4` (including the `MorphShape` mask) ↔ ours `n=4` ✓.

**③ The placement translation lands on the child's own `x/y` (scale stays in `transform.matrix`)**

`emitSwcPlacement` now writes only the 2×2 (rotation/scale/skew) into `transform.matrix`, and the
**translation** into the child's own `x/y` (text children add their `RECT` origin). Measured with AIR:
non-text child `child.x == matrix.tx` (`vbitemskin c4 xy=41,23.75`), TextField child
`x = tx + RECT.xmin` (`staticskin c1 xy=9.25,55.7` ✓ bit-identical). Scale **must** stay in the matrix:
F1 measured that AIR's nine-slice does not recognize placement stretching (only that way do the 42 stretched
gridded entries match), and AIR still reads decomposed values from the matrix. Pixels unchanged (rendering
composes `T(x,y)·R·S·M`).

**④ `width/height` precision alignment (`as_do_extents`)**

A text child's width/height going through "corner-point mapping" would carry the child's own `y` and subtract
it back; measured, `staticskin`'s text child read `19.950000000000003` (AIR exactly `19.95`); now in the
axis-aligned case it computes `(r-l)*a*scaleX` / `(b-t)*d*scaleY` directly (rotation/skew still go through
corner mapping), bit-identical to AIR.

**⑤ Shape bbox = the declared SWF `ShapeBounds` (`as_bounds_walk` gains a `decl` parameter)**

Measured: `#212` (adl `396.45×22.75`), `#214` (`361.6×17.6`), `#210` (`360×16`) — all three are
**bit-identical to the ShapeBounds declared in the tag**, whereas our **runtime path-point accumulated box**
drifts on some characters (`#212` once reported `374.7×1`: it is a hatch of 74 hairline diagonals, and the
accumulated box is unstable). So `as_bounds_walk` gains a third parameter `decl`: when `decl && g->_clip`,
take the declared rect recorded by `as_swc_clip` directly (**no longer adding the stroke half-width** — the
declared rect already includes the stroke), passing through recursively (button states / containers); **the
display-format call sites pass 1** (`as_do_extents` / `as_do_width` / `as_do_height`, `getBounds`,
`hitTestObject`), **hit testing and `getRect` pass 0** (AIR picks by the **drawing region**; `getRect` keeps
its existing "excluding stroke" convention). A `temp/shbox.ts` re-check: among the 378 shapes, "declared rect"
and "path union + stroke" differ on **116** ⇒ the declared rect is the authoritative union (our path-accumulated
box also counts pen `moveTo` positions). `decl` only feeds the AS3 bbox readout, **it does not participate in
rasterization**.

**Acceptance**:

- `temp/childfx/` (`cmp.py`, `TOL=1e-6`): 15 symbols / 99 children → **`x/y` 0, `numChildren` 0 mismatches**;
  `width/height` down from 39 to 35 (evidence `temp/childfx/cmp_item2_final.txt`).
- **Residual 35**: 33 are **precision-level** (`|Δ| ≤ 0.021px`, most ≤ 0.005: AIR's own bbox quantization/
  accumulation convention differs from ours, e.g. `playskin c0` `634.3×31` vs `634.3×30.975`, `userskin c4`
  `260×30` vs `260.0006×30.0001`, `homeskin c6` `354×580` vs `353.999×580.021`); 3 come from **missing morph
  geometry** (`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`, `元件124_72 c2` `11.75×11.75` vs `0×0`,
  `元件27_310 c0` `1×18` vs `0×0`) ⇒ recorded in §10.
- **The 1× harness is bit-unchanged** (`decl` does not participate in rasterization):
  `temp/swc-render/rep_final.txt` has **0 differences per entry** against the 196 lines before the fix
  (`bitmap 3/1/1/1`, `display(no text) 2/37/37/27`, `display(with text) 0/90/120/23`, `params 200/200`,
  `ERR 0/0`); the only change is the **bucketing** (see the §9.1 note).
- `examples/swc-shape.as` gains **⑦** structural assertions (`staticskin numChildren==19`, `c1 is TextField &&
  x==9.25 && y==55.7 && width==79.4 && height==19.95`, `fileitemskin n==5 && c2 n==4 && c2 c1 is Shape`,
  `loginskin n==9 && c1 is Shape && c1.visible`, `popchatitem c0 scaleX==1 && scaleY==1 &&
  transform.matrix.a==1.497314453125 && .d==1.1999969482421875`) → `swc-shape-ok` (pure structure, no Skia).
- `node test.ts` = **147 passed / 0 failed** (exit 0), with 2 new geometry checks (the declared-box branch +
  recursive pass-through) and 6 `as_bounds_walk` signature assertions synced.

**Reproduction**:

```
# Child tree item by item against adl (15 symbols / 99 children)
cd temp/childfx && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && python3 cmp.py
# Declared rect vs path union (survey of 378 shapes)
node temp/shbox.ts
# Structural regression
node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
# 1x full pixels (must be line-identical to rep_final.txt)
cd temp/swc-render && node gen.ts && <ours> && ./run_adl.sh && VERBOSE=1 node compare.ts
```

---

### 9.2 F6 Multi-frame timeline baking + `FrameLabel` + the `MovieClip` timeline API (stage ninety-five·nine, v0.4.68)

**Background**: previously `DefineSprite` baked **only frame 1** (`spriteChildren` read only the records before
`frameStarts[0]`), and `FrameLabel`(43) and `RemoveObject2`(5/28) were **not parsed at all**, so `MovieClip`
could only report "frame 1 + a `totalFrames` it counted itself". This stage bakes the **per-frame keyframe
delta** into a static table at compile time, and `gotoAndStop`/`nextFrame`/`prevFrame`/`currentLabels` align
with `adl 51.4.1` item by item at runtime.

**Method**: `temp/tlprobe/` (`gen.ts` generates a shared body; each side compiled with mxmlc+adl and with us;
`app.xml` `<visible>true</visible>`, 400×300, so `ENTER_FRAME` really dispatches). `cmp.py` compares 68 lines
of API output, and after explicitly normalizing the known differences (child `name`, the built-in class name's
`flash.display::` prefix) ⇒ **0 differences**.

**AIR measured semantics (`temp/tlprobe/adl.txt`, all read straight from adl)**

| Observation | `adl` semantics |
|---|---|
| `totalFrames` | = the SWF's number of `ShowFrame`s (`desktopshareitem` 21, `devicesitemskin` 23, `元件16_124` 17, `checkbom`/`toastbtn` 2, `元件172_339` 3) |
| Initial state of a fresh clip | `currentFrame == 1`, **`isPlaying == false`**, and it **does not self-advance across 12 frames** while on the display list (same offscreen and onscreen) ⇒ the skin symbol's `stop()` is in the DoABC, which we cannot read; so **a baked clip always stops at frame 1** (inventing no animation, and keeping the pixel harness bit-unchanged) |
| Property name | it is **`isPlaying`** (there is no `playing`) |
| `currentLabel` / `currentFrameLabel` | that frame's `FrameLabel` name, or `null` |
| `currentLabels` | an **`Array` of `FrameLabel`** (`{name, frame}`), item-by-item identical to our parse (e.g. `_up@1 _over@8 _down@15`) |
| `gotoAndStop(n\|label)` | **advancing**: apply the delta in place (child identity preserved); **going back or back to 1**: **rebuild** the target frame's objects (adl reproduces a new auto instance name `instance5`) |
| `nextFrame` / `prevFrame` | step + **wrap** (`totalFrames` wraps to 1, 1 wraps to `totalFrames`) |

**Implementation**

- **Parsing** (`src/swc.ts`): new `FrameLabel`(43) (`readSwfCString` → `SwcSprite.labels`); **new
  `RemoveObject`(5)/`RemoveObject2`(28)** → a delete record with `charId: null, move: false`; `SwcPlacement`
  gains `visibleFlag: boolean|null` (three states; `Visible=1` must **cancel** hiding, and a missing field
  leaves visibility **untouched**) and `ratio`.
- **Baking** (`spriteFrames`, keyed by Flash **depth** rather than child index): frame 1 establishes the
  `depth → {charId, matrix}` state, then each frame is derived: with a character = add/replace
  (`replace: true`, inheriting the omitted transform), `Move` with no character = modify, no `Move` and no
  character = **delete**, and for the same frame and depth a later write overrides an earlier one; **an op
  carrying nothing is dropped** and counted/reported (this library has 270 records carrying only a morph
  `Ratio`). `SwcBakeCharacter` gains `totalFrames`/`frames`/`labels`.
- **Emission** (`src/emit.ts`): `as_swc_tl_total/start/find/put/del/clear/apply` + `as_swc_tl_labelcount/
  labelat/frameat/label/labelframe` (a static `switch (charId)`, label names compared with `strcmp`);
  `MovieClip` gains `play`/`stop`/`gotoAndPlay`/`gotoAndStop`/`nextFrame`/`prevFrame` and `isPlaying`/
  `currentLabel`/`currentFrameLabel`/`currentLabels`; a new built-in class **`FrameLabel`**; timeline children
  carry a depth `_tl_depth` (0 = a child added by the user's `addChild`) so that "rebuild on going back"
  clears only timeline children. **With no bake, everything emits an empty stub.**
- **Class identity incidentally narrowed**: a multi-frame sprite is now instantiated as a `MovieClip`
  (`as_swc_new`'s sprite branch), consistent with the `flash.display::MovieClip` AIR reports (previously
  `Sprite`).

**Three "never silent" measured findings**

1. **`RemoveObject2` was previously silently dropped by the parser** (17 records). `toastbtn`(#634) frame 2 =
   "delete depth 2 + place a new character at depth 3" ⇒ AIR reports **3** children (depths 1/3/4, the art
   replaced), while we previously reported **4**. After the fix `cmp.py` goes to zero.
   Of the SWF's original 17 `RemoveObject2`, 9 collapse with "a replay at the same frame and depth" into
   "create a new object" (not inheriting the omitted transform).
2. **Label names were emitted with UTF-16 byte escaping**: `cStringLiteral` is for **embedded bytes**
   (producing `"\x0_\x0u\x0p"`), and label names used it ⇒ `FrameLabel.name` all empty and `currentLabel`
   empty, while `currentLabels.length` was nonetheless **correct** (the length came from another table).
   Switching to `escapeCString` ⇒ `case 1: return "_over";`. **This is exactly why a C text pin is needed**:
   `test/unit/render.ts`'s `unit: render/SwcTimeline` pins that line's literal form directly.
3. **With no bake, `as_swc_bind` was undefined**: `MovieClip`'s table-walking function now calls it, so
   **builds without an SWC** (`examples/dyn-prop.as`, `stage62.as`, `stage94f.as`, `air-native/`) failed to
   link (the 4 failures recorded in stage ninety-seven's acceptance). Adding a stub (emitted when
   `this.swcBake === undefined`) ⇒ all 4 examples green.

**Baked counts (`temp/tlcheck.ts`)**: 79 multi-frame sprites, of which **75** change after frame 1, **448**
op frames, **514** ops (**102** add/replace, **404** modify, **8** delete); **89** `FrameLabel`s (31 sprites).

**Acceptance**

- **API item-by-item alignment**: `temp/tlprobe/`'s 68 lines (`totalFrames`/`currentFrame`/`currentLabel`/
  `currentFrameLabel`/`nLabels`/child count/child class name/child `x/y`/`gotoAndStop(2)`/`gotoAndStop(label)`/
  `nextFrame`/`prevFrame`/`stop`/12 frames × the `isPlaying` of 4 fresh clips) ⇒ **0 differences**. Note
  `checkbom` frame 2's text child `x = 200/20 + RECT.xmin(-2) = 8` (AIR measures 8) — **a modify record also
  must apply the text-origin rule**.
- **The child tree does not regress**: `temp/childfx/` 15 symbols / 99 children ⇒ `x/y` **0**, `numChildren`
  **0**, `width/height` still **35** (same as F5).
- **The 1× pixel harness is bit-unchanged**: `temp/swc-render/rep_final.txt` is **0 differences per entry**
  against the 196 lines before the fix (starting stopped at frame 1 ⇒ the timeline does not participate in
  rasterization; `MovieClip_new()` changes no pixels).
- `examples/swc-shape.as` gains **⑧** structural assertions (`desktopshareitem totalFrames==21 /
  currentLabel=="_up" / !isPlaying / currentLabels.length==3 / [1] == _over@8`,
  `gotoAndStop("_down")→15`, `nextFrame/prevFrame` 1↔2, `toastbtn` still has 3 children after the frame-2
  delete record, `checkbom` frame 2's text `x==8` and reverting back to `24`, `元件172_339` 3 frames 1 child) →
  `swc-shape-ok`.
- `node test.ts` **all green (exit 0)**, with 11 new pins in `unit: render/SwcTimeline` (label table /
  replace-inherit / text origin / delete record / label literal / `strcmp` table / `MovieClip_new` +
  `as_swc_tl_start` / `FrameLabel` constructor / `isPlaying` / the no-bake `as_swc_bind` stub).

**Residuals (recorded in §10)**: ① a timeline child's `name` is always `null` (AIR auto-names it `instanceN`;
the SWF record has no `Name` field); ② **per-frame ActionScript (DoABC) is not executed** ⇒ the clip always
stops at frame 1; ③ a morph timeline's `Ratio` records are discarded (morph is an empty placeholder child);
④ the **last-digit difference** in a child's `x/y` (`0.9500000000000002` vs `0.95`, ≤2 ULP, from two `/20`
additions).

**Reproduction**:

```
# Timeline API item by item against adl (68 lines)
cd temp/tlprobe && node gen.ts && ../../src/index.ts ours.as --swc ../../temp/skin.swc --run && ./run_adl.sh && python3 cmp.py adl.txt ours.txt
# Baked counts and op counts
node temp/tlcheck.ts
# Child tree (15 symbols / 99 children)
cd temp/childfx && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && python3 cmp.py
# 1x full pixels (must be line-identical to rep_final.txt)
cd temp/swc-render && node gen.ts && <ours> && ./run_adl.sh && VERBOSE=1 node compare.ts
```

---

## 10. Explicit deferrals / limitations

| Item | Reason |
|----|------|
| The ±1 channel drift of runtime decoding (semi-transparent pixels) | Skia's `readPixels(kUnpremul)` does premultiply → unpremultiply, two roundings, for a straight-alpha PNG, drifting the RGB of pixels with A∈(0,255) by ±1 (alpha bit-exact). Measured, 206 of 388,648 pixels differ (0.053%), all within §11③'s allowance. Eliminating it entirely would require shipping our own PNG decoder (bypassing Skia's alpha transform), at a cost disproportionate to the benefit. See §5's "fidelity" measurement correction |
| ~~One occlusion difference on `vbitemskin` (charId 293), unlocated~~ **located and fixed** (§9.2 F3) | Root cause = `PlaceObject3`'s `Visible = 0` (depth 6's #286) was parsed and then discarded ⇒ AIR hides it, we draw it. After the fix that symbol's `maxdcS 76 → 30`, and all 42 entries in the same batch improve (`fileitemdoctorskin` 205 → 2 etc.). The residual 30 is antialiasing/color-level difference |
| ~~`PlaceObject3`'s `FILTERLIST` / `BlendMode` / `BitmapCached` parsed and then discarded~~ **implemented** (§9.2 F4, v0.4.65) | All 13 filters (11 Glow + 2 DropShadow), 8 `BlendMode` (7 = `layer`, 1 = `darken`) and 2 `BitmapCached` landed; including the AIR alignment of `strength` and blur σ. On the 1× harness every symbol is uniformly better, worse nowhere |
| Filters' `inner` (inner glow / inner shadow) and `knockout` | Both are parsed out of the SWC record and go into the AS3 filter object, but the **raster path is unimplemented**: we always draw an outer glow / outer shadow. Measured, the 13 records in `temp/skin.swc` have `inner = 0`, `knockout = 0`, so there is currently no pixel impact. Expressing "inner" on the Skia side needs extra construction (invert the silhouette + `Blend(kSrcIn)`), not done |
| Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix in `FILTERLIST` (FilterID 3–7) | Skip bytes only by the documented length and **report** via `swcBake.notes`, never silently drop; measured 0 in this library. "Implement when encountered" |
| Blur profile: we use a **Gaussian approximation**, AIR uses a **true box** | Already variance-matched (`sigma = blur*sqrt(quality)/sqrt(12)`), but the center/tail still differ (`blur6q1` ours 217/161/94/38/9 vs AIR 191/148/106/63/21). A true box needs `MatrixConvolution` (36~256 taps per layer, non-separable), a performance risk outweighing the benefit |
| `BlendMode` modes Skia cannot express (subtract / invert / alpha / erase) | The glue returns 0 (treated as `kSrcOver`) and **reports** via `notes`, with no approximation — measured, all 8 in this library are in the expressible set (`layer`/`darken`) |
| The semantic definition of `BlendMode.LAYER` | Implemented as **pure group isolation** (`saveLayer` + `kSrcOver`). AIR's `layer` also requires that object to become an independent cache group (equivalent to `cacheAsBitmap`); this library's only `layer` scene has no pixel difference, so no cache is layered on |
| ~~Skipped character types make the display list's **child count too small**~~ **fixed** (§9.2 F5, v0.4.66) | `DefineEditText`/`DefineText` (341) bake to an empty `TextField`, `DefineMorphShape`/`2` (6) to an empty `Shape`, and `numChildren`/`getChildAt` indexes match AIR (`minfo` 6 vs 6, `fileitemskin` 5 vs 5, `staticskin` 19 vs 19). **Residuals**: ① text placeholder children have no glyphs/initial text, and their `width/height` are reported only per the declared `RECT` (measured, all 341 `DefineEditText` in this library have `AutoSize = 0` ⇒ no difference from AIR); ② morph placeholder children have no geometry ⇒ 3 `width/height` differences (`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`, `元件124_72 c2` `11.75×11.75` vs `0×0`, `元件27_310 c0` `1×18` vs `0×0`) |
| A child's **class-name identity** differs from AIR | AIR reports the **class name** for characters linked by SymbolClass (e.g. `popbgskin`) and `MorphShape` for morph; we uniformly report the base class `Sprite`/`Shape` (observable via `getQualifiedClassName`). Pixels and tree are unaffected |
| AIR's bbox **quantization/accumulation convention** differs from ours (not settled) | Measured, `temp/childfx/` has 33 `width/height` differences with `\|Δ\| ≤ 0.021px` (most ≤ 0.005, and **in both directions**): e.g. `userskin c4` AIR `260×30` vs ours `260.0006×30.0001` (the same 280×46 rect × the same 16.16 matrix scale; AIR's value looks like its own internal rounding), `homeskin c6` `354×580` vs `353.999×580.021`. The two models differ by under 0.4 twip, not settled. **Also**: baked coordinates themselves have a last-digit difference (in the timeline probe a text child's `y = 0.9500000000000002` vs `adl 0.95`, ≤2 ULP, caused by two `/20` additions), likewise only affecting string printing |
| ~~Timeline placement matrices not back-filled into the child's **own** `x/y/scaleX/scaleY`~~ **`x/y` fixed** (§9.2 F5, v0.4.66) | The translation is now written into the child's own `x/y` (measured `vbitemskin c4` `41,23.75`, text child `x = tx + RECT.xmin`, both bit-identical). **Deliberately preserved**: the 2×2 (scale/rotation/skew) stays only in `transform.matrix` — F1 measured that AIR's nine-slice does **not** recognize placement stretching (only that way do the 42 stretched gridded entries match), so `child.scaleX/scaleY` we report as 1 while AIR sometimes reports the decomposed value (e.g. `popchatitem c0` `1.4973`). Pixels and the `transform.matrix` readback agree; only code that reads `child.scaleX` directly can observe it |
| `ZWS` (LZMA) SWC | `temp/skin.swc` is `CWS`; the layout is given in §4, so implementation cost is low, but the value is limited, hence deferred |
| Fonts (`DefineFont*`) | Two roads must be distinguished: the **app.xml `<embedFonts>` path is already implemented in `air-app.ts`** (producing manifest `font-urls` / `preload-paths`); **SWC-embedded fonts are not yet handled** — measured, `temp/skin.swc` contains **7 `DefineFont3`**, belonging to the separate decoding domain of "getting fonts from an SWC" |
| Sound (`DefineSound`) | Measured, `temp/skin.swc` has **no** `DefineSound` (0); if encountered in the future, it is a separate decoding domain |
| Bitmaps referenced by `Sprite` without a class name (43) | Requires parsing the complete display tree of `DefineSprite`/`PlaceObject`; **note `small_gift`/`checkbom` belong to this bucket** (an earlier version wrongly listed them among the 16) |
| `[Embed]` metadata syntax | **not an "existing shortcut"**: `Embed` currently has no semantic-layer consumer (§1), and the own-project scenario equally needs implementation |
| `DefineBitsJPEG4` (tag 90) | Measured, `temp/skin.swc` has none; same family as JPEG3, support it casually. **Note**: `CHARACTER_TAG_KINDS` already classifies it as `bitmap`, but the extractor only handles 20/21/35/36 ⇒ a real tag 90 would fail on `swcBakePlan`'s bitmap branch with a **misleading** `bitmap fill references missing bitmap #N` (it should report as JPEG4) |
| ~~Nine-slice scaling (`DefineScalingGrid`, measured 22)~~ **implemented** (§9 F/§9.2 F1); but the **AS3-side `DisplayObject.scale9Grid` property is not yet implemented** | The project only bakes nine-slice from the SWF tag, and the runtime **has no** readable/writable `scale9Grid` property (AIR does). That is: scaling in an SWF skin does not blur, but user code cannot set/query it itself. Recorded per §1.5 in `TODO.md`'s `### 遗留待开发` |
| `BitmapData.draw(source, matrix)` handling of source's **own transform** differs from AIR | Measured with `adl`: setting `o.scaleX = 2` on the drawn object has **no effect** in `draw(source, matrix)` (only the `matrix` argument matters); our implementation applies it. The probe was therefore uniformly changed to wrap in a container first and then draw. **Not settled**, recorded in `### 遗留待开发` |
| Morph shapes (`DefineMorphShape`/`2`, measured 6) | Requires two sets of geometry + interpolation; only 6 in this library, low value, hence deferred. **Current state**: already baked as an **empty `Shape` placeholder child** (§9.2 F5) ⇒ the tree aligns and no wrong pixels are drawn, but geometry and interpolation remain gaps; its timeline `Ratio` records (270 in this library) are discarded and reported (§9.2 F6) |
| ~~Button four states (`DefineButton2`, measured 29)~~ **implemented** (§9 F/§9.2 F2) | `ButtonRecord.states` bitmask + a draw-time state machine (`as_sbtn_state`); offscreen pixel-identical to `adl` |
| ~~Timeline animation (`DefineSprite` multi-frame + `FrameLabel`)~~ **implemented** (§9.2 F6, v0.4.68) | The per-frame delta (add/replace/modify/delete) is baked at compile time, and `gotoAndStop`/`nextFrame`/`prevFrame`/`currentLabels` match `adl` item by item (68 lines, 0 differences); 79 multi-frame sprites / 514 ops / 89 `FrameLabel`s. **Residuals**: ① a timeline child's `name` is always `null` (AIR auto-names it `instanceN`; the SWF record has no `Name` field); ② **per-frame ActionScript (DoABC) is not executed** — the skin symbol's `stop()` cannot be read, so a baked clip **always stops at frame 1** (this is exactly `adl`'s observed behavior, which is why the pixel harness is bit-unchanged); ③ a morph timeline's `Ratio` records are discarded (morph is an empty placeholder child) |
| **SWC-embedded code (ABC bytecode)** | **This is out of scope, not a "deferral"**: measured 255 `DoABC` = 254 classes / 54,162 B of bytecode. Container reading is solved (§3.3.1, 255/255 round-trip self-proving), but bytecode → a compilable artifact needs a **decompiler or an AVM2 interpreter** (§3.3.2), a separate project. The realistic form = "resources from the SWC, code from `.as`", with `<dep>` for the compile-time diagnostic (§3.3.3). **Measured, only the 8 mx/flex classes (3,135 B) lack source**, so hand-writing them suffices (§3.3.0) |

---

## 11. Appendix: Measurement methods and data (reproducible)

This section records the methods used for the re-verification, to aid alignment in future regressions.

**① Headless unpacking audit** (depending on no third-party library):

```
Node: zlib.inflateRawSync to undo the ZIP layer → zlib.inflateSync to undo the CWS layer
      → skip the stage header (nbits from body[0]>>3; header = ceil((5+4*nbits)/8) + 4 bytes)
      → scan tag by tag (length==0x3f means read the following UI32)
```

**② AIR ground truth (`adl`)**:

```as3
// Use mxmlc to link the SWC in (-include-libraries+=skin.swc is needed for resources to be embedded):
var bd:BitmapData = new logo(0, 0);           // the argument is ignored, yielding 100x72
bd.getPixel32(x, y)                            // export point by point, compare against the local extraction
```

Pitfalls (all hit during this work):

- `-library-path+=` does **not embed** resources (the generated SWF is only 748 B); you must use
  `-include-libraries+=` (the SWF becomes ~692 KB, and only then are the resources truly embedded).
- `adl`'s `trace()` **does not go to stdout** (it goes to the AIR debug log). To get data, write it to a file
  with `File`/`FileStream` and end with `NativeApplication.nativeApplication.exit()`.
- Passing the application descriptor requires an **absolute path**, and per project convention add
  `-- <appDir>`.
- `mxmlc` produces **`ZWS`** by default; if you want to parse a self-made SWF locally, decode LZMA per §4's
  `ZWS` layout.

**③ Summary of key measured data**:

| Item | Value |
|---|---|
| `skin.swc` | 743,520 B; inside the ZIP `catalog.xml` (5,570/84,463) + `library.swf` (737,700/737,552) |
| `library.swf` | `CWS`, version 44, body 1,031,069 B, 1,504 tags |
| Bitmap tags | 59 = `DefineBitsLossless2`×53 + `DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2 |
| `SymbolClass` | 1 tag, 214 mappings; of the 59 mapped to bitmaps, **16 have class names / 43 do not** |
| `catalog.xml` | 255 `<script>` entries (= the class count; `library.swf`'s `DoABC` is also 255) |
| The 16 named resources | `desktopicon`(342×194) `logo`(100×72) `imgback`(200×200) `cambitmap`(700×393, tag20) + 12 `com.vsdevelop.controls.scrollbar.*SkinClass[_200]` |
| Pixel byte order | `A,R,G,B` (7200/7200 first byte == AIR alpha) |
| Premultiplied | yes (340,644 samples: `R\|G\|B > A` is 0; `A=0` with non-zero RGB is 0) |
| AIR de-premultiply | `floor(stored*255/A + t)`, `t ∈ [0.329, 0.413)`; `floor(x+1/3)` = 219/219 exact |
| Embedding cost (raw ARGB → `0xNN,`) | 1,555,412 B raw → **7,777,060 B of C source ≈ 7.42 MB** (the wrong approach) |
| **Embedding cost (PNG re-encode, recommended)** | PNG binary **14,569 B** → C source (`\xNN`) **43,723 B ≈ 42.7 KB** (**178×** smaller) |
| tag payload (for comparison) | the 16 resources total **13,097 B** inside the SWC |
| Single-resource example (`cambitmap` 700×393, tag20) | raw **1,100,400 B** → PNG **8,070 B** |
| `DoABC` | 255 (tag 82); ABC containers total **252,737 B** |
| ABC contents | 254 classes / 1429 methods / 1316 method bodies / **54,162 B of bytecode** / **9,977** string entities (raw count including reserved slot 10,232) / largest single method body 2,234 B |
| ABC parse self-proof | **255/255** modules round-trip exactly (consuming exactly to the last byte) |
| ABC class breakdown (mutually exclusive) | bitmap resources 16 (152 B) / `extends MovieClip` 192 (5,489 B, of which `skin_fla.*` 89) / interfaces 6 (6 B) / mx/flex 8 (3,135 B) / remaining logic 37 (32,465 B) = 254 classes, **41,242 B**; + unassigned 12,920 B = 54,162 B |
| Classes lacking source | **only the 8 mx/flex classes (3,135 B)**, 5 of which are empty interfaces (1 B each) |
| Top module-level bytecode | `StringCore` 4,373 / `DownLoader` 3,576 / `TweenLite` 2,799 / `MD5` 2,616 / `mx.core.BitmapAsset` 2,515 / `JSONTokenizer` 2,480 / `MHIOSScrollBar` 2,333 / `MWIOSScrollBar` 2,195 / `ComBoBox` 1,557 |

**④ ABC (`DoABC`) audit** (the data source for §3.3):

```
Use §4's headless unpacking to get the SWF body → scan tag by tag, collecting tag 82 (DoABC):
  payload = u32 flags + null-terminated cstring moduleName + ABC
Then parse the ABC per §3.3.1's section order, counting classes/methods/bodies/total bytecode.
```

**Self-proof method**: the parser must "**consume exactly to the last byte**" for every module (round-trip),
and **only 255/255 means the section order is correct** — this is the only criterion that can prove "no silent
misalignment" (a wrong order can also "run to completion", only with all subsequent fields turned to garbage,
which is hard to spot by eye).

Pitfalls (all listed in §3.3.1): the metadata table comes **after** the kind payload (reading it in the wrong
order is the most insidious misalignment source); a `HAS_OPTIONAL` entry is `value u30 + kind u8`;
`HAS_PARAM_NAMES` reads `param_count` names (not `param_count+1`); pool class counts include reserved slot 0,
while method/class/script/method_body/metadata are exact values; **the `class_info` vector has no count
prefix** (length = `instance_count`); **pool class index 0 is a reserved slot**, so name lookup takes
`pool[idx-1]`.

This re-examination hit three more (now folded into §3.3.1), showing that "reading the container correctly"
really needs self-proving rather than eyeballing:
① treating `class_info` as an ordinary vector and reading one extra u30 → global misalignment;
② forgetting `pool[idx-1]` → all names become garbage (**but no error is raised**, only the round-trip
reveals it);
③ aggregating bytecode per class using the **module-global method index table**, whereas method indices are
**numbered per module**, colliding across modules → numbers inflated twofold — which is why §3.3.0's
class-level bytecode must be aggregated **per module**.

Authoritative reference: Ruffle `swf/src/avm2/read.rs`'s `read_trait` / `read_method` /
`read_constant_pool` (Rust, **used only as a format baseline, no code imported**). If implemented in the
future, it is advisable to write the section order straight from it and keep §3.3.1's self-proof criterion.

**⑤ Vector shape / display tree audit** (the data source for §3.4):

```
Decode the SWF body → skip the stage header → scan tags recursively (entering tag 39's payload[4:]):
  DefineShape(2)/2(22)/3(32)/4(83) → parse SHAPEWITHSTYLE in Ruffle's section order + each shape record
                                   (FillStyleArray/LineStyleArray/NumFillBits/NumLineBits → bit stream)
  PlaceObject(1)/2(26)/3(70)       → take the placed character id
  SymbolClass(76)                  → id → class name
  DefineSprite(39)                 → recurse
```

**Self-proof**: every shape must **consume exactly to the end of the payload** (remaining < 8 bit) — this
library is **378/378**. The reference graph is cross-checked separately by "does a placed id hit a known
character", **978/978**.

Pitfalls (all folded into §3.4⑤): `LINESTYLE2` flags are **MSB-first** (reading them as a little-endian `u16`
drifts on 5 v4 shapes); `PlaceObject2` flags are **LSB-first** (`HasCharacter=0x02`); every sprite ends with a
**zero-length** `PlaceObject` (`40 00`), and without a guard this introduces a garbage reference with `id=0`;
`DefineEditText` (337) is also a character, and failing to register it makes the reference graph sprout 336
phantom "unknown ids".

Authoritative reference: Ruffle `swf/src/read.rs`'s `read_define_shape` / `read_fill_style` /
`read_shape_record` (format baseline only, no code imported).

**Vector / display tree measurement summary**:

| Item | Value |
|---|---|
| `DefineShape` | **378** (v1 186 / v2 50 / v3 56 / v4 86), payload **29,774 B** |
| Edges / subpaths | 5,052 (straight 3,059 / quadratic 1,993) / 905 `moveTo`, 998 style switches |
| Fills 401 | solid 326 / bitmap 73 / linear 2 / radial·focal 0 |
| Strokes / multiple fills | 86 (80 shapes have strokes); 43 shapes have multiple fills |
| v4 flags | `UsesScalingStrokes` 84 / `UsesNonScalingStrokes` 1 / `UsesFillWindingRule` **0** |
| Path-building calls → C | 5,957 → about **233 KB**; exported closure 4,181 → about **194 KB** |
| Exported symbols | 214 = sprite 196 / bitmap 16 / button 2; **shape 0** |
| Display tree | `DefineSprite` 333; `PlaceObject` 1,479 + `PlaceObject2` 1,935 + `PlaceObject3` 64; nine-slice 22 |
| Other characters | `DefineEditText` 337, `DefineText` 3, `DefineMorphShape` 4+2, `DefineButton2` 29 |
| Reference-graph self-proof | placed ids hit known characters **978/978**; shapes round-trip exactly **378/378** |

**Open item (left to the implementation stage)**: the exact value of `t` can only be narrowed further by more
`(alpha, stored)` combinations (in this sample the interval with frac ∈ (0.5874, 0.6709) has no observations,
so any `t` within that band matches). In practice `1/3` suffices; if per-channel exactness with AIR is
required, construct a synthetic resource covering that fractional band and re-measure.