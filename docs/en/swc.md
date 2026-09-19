# SWC Resource Extraction and Embedding

> This document answers one question: **in a pure-AS project, images and other resources are packed into an
> SWC — how does the AOT compiler extract them and display them on the UI**.
> Core conclusion first: an SWC is a ZIP archive, but the resources are **not standalone files inside the ZIP**;
> they are compiled by mxmlc into `library.swf` and stored as SWF binary tags (bitmap → `DefineBitsLossless2`/
> `DefineBitsJPEG2`, mapped to class names via `SymbolClass`). Therefore "parse the SWC to get resources" =
> **unzip → decompress the SWF → scan the tag stream → extract bitmap pixels/JPEG bytes**.
> This chain happens at **compile time** (Node side, zero third-party dependencies), converting resources into C
> byte arrays embedded into the output; the runtime decode/display reuses the existing Skia backend (the same
> `MakeFromEncoded` path as `BitmapData.loadFile`), with zero new code.
>
> All conclusions in this document are based on unpacking a real `temp/skin.swc` (743 KB, 255 classes, 59 bitmap
> resources), not on documentation retelling.

---

## 1. Why This Requirement Exists: SWC Is the Resource Carrier in Pure-AS Projects

In the Flash/Flex ecosystem, resources (skin bitmaps, icons, fonts) have two kinds of ownership:

| Scenario | Where the resource lives | Extraction difficulty |
|------|---------|---------|
| Own project + `[Embed(source="a.png")]` | The original image is still in the source directory | Low — read the original directly, **no need to touch the SWC** |
| Third-party library / Flash IDE exported skin library | The original image is unavailable; only `.swc` | High — must unpack the SWC + decompress the SWF |

The user's scenario is the latter: `temp/skin.swc` is a UI skin library exported by the Flash IDE (containing
resource classes such as `logo`/`imgback`/`desktopicon`/`cambitmap`), the original images are lost, and it can
only be extracted from the SWC.

---

## 2. Anatomy of an SWC: ZIP Shell + Embedded SWF

Rename the `.swc` suffix to `.zip` and unzip it; the standard structure has only two files (`docs/` is optional
ASDoc documentation):

```
skin.swc (ZIP archive)
├── catalog.xml      84 KB   —— component catalog: <script> lists each class and its dependencies (<dep>)
└── library.swf     737 KB   —— compilation artifact: an SWF container (CWS = zlib-compressed)
```

The structure of `catalog.xml` (measured from `temp/skin.swc`):

```xml
<swc xmlns="http://www.adobe.com/flash/swccatalog/9">
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

**Key fact**: `catalog.xml` only describes "which classes exist and what they depend on" — it does **not**
contain the resource bytes. The real image bytes are in `library.swf`.

---

## 3. The Real Storage Form of the Resource: SWF Tags

`library.swf` is a standard SWF container; the first 8 bytes `CWS` indicate zlib compression (`FWS` =
uncompressed, `ZWS` = LZMA). Measured: `temp/skin.swc`'s `library.swf` is **CWS**. After decompression it is a
tag stream, each tag consisting of a `(code:length)` header + data body.

Resource-related tags (measured tag-type distribution):

| `[Embed]` type / resource | SWF tag | tag code | Data body content |
|---|---|---|---|
| PNG/lossless bitmap | `DefineBitsLossless` | 20 | SWF's own bitmap format (see §3.1) |
| PNG/lossless bitmap (new) | `DefineBitsLossless2` | 36 | SWF's own bitmap format (see §3.1) |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **complete JPEG bytes** (starts with `FF D8`) |
| JPEG (with alpha) | `DefineBitsJPEG3/4` | 35/90 | JPEG + alpha data |
| Raw bytes | `DefineBinaryData` | 87 | `characterID` + raw bytes |
| Font / sound | `DefineFont*` / `DefineSound` | 10/48/14 | font/audio data |
| **symbol → class name** | `SymbolClass` | 76 | `{id → "class name"}` mapping |

Measured: `temp/skin.swc`'s `library.swf` has **59 bitmap tags** (`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2), and **214 mappings** in `SymbolClass`.

### 3.1 Important Pitfall: `DefineBitsLossless` Stores **Not PNG**

This is the easiest pitfall to hit. The data body of `DefineBitsLossless2` is **not** a PNG file, but SWF's own
custom bitmap format:

```
DefineBitsLossless2 data body:
  characterID   u16   (symbol id)
  bitmapFormat  u8    (3 = 8bit with color table; 4 = 15bit RGB; 5 = 32bit ARGB)
  width         u16
  height        u16
  [colorTableSize u8]  (only when bitmapFormat==3)
  zlibData      ...   (zlib-compressed pixel data)
```

Measured extraction of `symbol#2` (`logo`): `characterID=2, format=5(32bit ARGB), 100×72`; decompressed pixel
data `28800 bytes = 100×72×4`, the first 16 bytes all 0 (transparent edge), non-zero pixels 37.1% — valid image
content.

**Conclusion**: `DefineBitsLossless2` requires "decompress zlib → get raw ARGB/RGB pixels", and **cannot** be
fed directly to Skia's `MakeFromEncoded` (which only accepts encoded formats like PNG/JPEG). In contrast,
`DefineBitsJPEG2` stores the **complete JPEG**, which can be fed to Skia directly.

---

## 4. Compile-Time Extraction Chain (End-to-End Verified)

```
SWC (ZIP)
  │  ① hand-written ZIP central-directory parsing (Node side, zero dependency)
  ▼
library.swf (deflate-compressed CWS file)
  │  ② zlib raw-inflate to decompress the ZIP layer → get CWS file bytes
  ▼
CWS file ("CWS" + version + fileLength + zlib stream)
  │  ③ zlib inflate to decompress the CWS layer → get SWF tag stream
  ▼
tag stream (header decodes code:length, scanned tag by tag)
  │  ④ hit DefineBitsLossless2(36)/Lossless(20)/JPEG2(21)/JPEG3(35)
  ▼
bitmap resources:
  ├─ Lossless2 → zlib decompress → raw ARGB pixels (+ width/height)
  └─ JPEG2/3   → complete JPEG bytes (+ alpha)
```

**Verification result** (real `skin.swc`, `symbol#2 logo`):

```
① ZIP layer deflate decompress: 737700 bytes → CWS 737552 bytes
② CWS layer zlib decompress:    → SWF body 1031069 bytes
③ Lossless2 extraction:         characterID=2, format=5(32bitARGB), 100×72, 28800B pixels
④ valid content 37.1% non-zero —— extraction correct
```

**Zero-third-party-dependency feasibility**: the ZIP central-directory structure (`PK\x01\x02` header +
`PK\x05\x06` EOCD tail) parses in about 30 lines by hand; zlib decompression uses Node's built-in
`zlib.inflateSync`/`inflateRawSync`; SWF tag scanning is about 40 lines. All done on the compile front end (Node
side), consistent with AGENTS.md §3.1 "zero third-party dependencies".

---

## 5. Resource → Output: Two Compile-Time Embedding Strategies

The user has already decided on **compile-time extraction, embedded into the output** (self-contained output,
no external file dependency). The two embedding approaches, by resource format:

| Resource format | Embedded content | Runtime decode |
|---------|---------|-----------|
| `DefineBitsJPEG2/3` | Raw JPEG bytes (C byte array) | Skia `SkImages::DeferredFromEncodedData` (existing path) |
| `DefineBitsLossless2` | Decompressed ARGB pixels (C byte array) + width/height | Fill `BitmapData.pixels` directly (existing RGBA buffer), or convert to `SkBitmap` |

JPEG embeds the bytes directly and is decoded by Skia at runtime — exactly the same path as the existing
`as_skia_image_from_file` (`sk_image_from_file`), except the data source changes from "a disk file" to "an
in-memory byte array" (a new `as_skia_image_from_bytes(data, len)`, a few lines of glue).

The ARGB pixels decompressed from Lossless2 fill `BitmapData.pixels` directly — the project already has the RGBA
buffer and rendering path of `BitmapData.getPixel/setPixel`, with zero decode.

### 5.1 Embedding Form (C Byte Array)

The compile step generates a resource segment shaped like:

```c
/* SWC resource: skin.swc#logo (100x72, 32bit ARGB) */
static const unsigned char __res_skin_logo[] = {
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, /* ... 28800 bytes ... */
};
static const int __res_skin_logo_w = 100;
static const int __res_skin_logo_h = 72;
```

Embedding a large resource (e.g. a few hundred KB of JPEG) bloats the single `.c`, but this is the natural
consequence of the "single readable `.c`" default form; if resources get too large later, it can be degraded to
"a separate resource `.c` + merged via the build manifest `sources`" — already supported by the build layer
(§2.9).

---

## 6. AS3-Side Reference Semantics: Resource Class = `BitmapData` Subclass

This is the key to how codegen lands the resource reference. Measured in the ABC of `temp/skin.swc`'s
`library.swf`:

```
public dynamic class logo extends flash.display::BitmapData
  public function logo(int,int):*
public dynamic class imgback extends flash.display::BitmapData
public dynamic class desktopicon extends flash.display::BitmapData
public dynamic class cambitmap extends flash.display::BitmapData
```

**The resource classes (`logo`/`imgback`/`desktopicon`/`cambitmap`, etc.) are dynamic subclasses of
`flash.display.BitmapData`**, with constructor signature `(int width, int height)`. This is the standard form of
a Flash IDE exported skin library.

And of the 214 mappings in `SymbolClass`, **only 16 bitmaps map directly to class names** (`logo`/`imgback`/
`desktopicon`/`cambitmap`/`small_gift`/`checkbom`, etc.); the remaining **43 bitmaps have no class name**
(`className` missing, referenced as child objects by `Sprite`/`DefineShape`).

**AS3-side reference ways (two, by user code style)**:

| Reference way | Typical code | codegen landing |
|---------|---------|-------------|
| Direct `new resourceClass(w,h)` | `var b:Bitmap = new Bitmap(new logo(0,0));` | Register the resource class as a `BitmapData` subclass; `new` dispatches to the "fill embedded pixels" factory |
| `SymbolClass` reflection | `getDefinitionByName("logo")` | Resource registry `{name → factory pointer}`, dynamic lookup (depends on dynamic class instantiation, landed in stage forty-eight) |

**Recommended to land way one first**: for resources mapped to class names in `SymbolClass` that are
`BitmapData` subclasses (16), extract pixels/bytes at compile time, have codegen generate the corresponding
`BitmapData` subclass + factory, and `new logo(w,h)` returns a `BitmapData` with pixels already filled in. Way
two (reflection lookup) is a later extension.

---

## 7. Implementation Landing Points (Aligned with AGENTS.md Layering)

| Layer | Change | Notes |
|----|------|------|
| **Build layer `src/swc.ts` (new)** | SWC extractor | ZIP parsing + CWS decompression + tag scanning + bitmap extraction, producing `SwcResource[]` (class name/format/width/height/pixels-or-bytes) |
| **Build orchestration `src/build.ts`** | `--swc` argument / build manifest `swc-paths` | Collect SWC dependencies, invoke the extractor, inject resources into codegen |
| **Semantic layer `src/symbols.ts`** | Resource class registration | Register the resource class name as a `BitmapData` subclass (`dynamic`, constructor `(int,int)`) |
| **Semantic layer `src/emit.ts`** | Resource segment emission + `new` dispatch | Emit the C byte-array resource segment; `new logo(w,h)` dispatches to the "embedded pixels → BitmapData" factory |
| **Runtime `src/runtime.ts`** | `as_skia_image_from_bytes` | In-memory bytes → Skia `MakeFromEncoded` (JPEG path, a few lines of glue) |

**Boundary iron rule**: the extraction logic (ZIP/SWF parsing) **may only** happen at compile time (`swc.ts`)
and is **forbidden** from being stuffed into `RUNTIME_PREAMBLE` — that would saddle the runtime with an SWF
parser, violating the "front end only translates" iron rule (AGENTS.md §1.3).

---

## 8. Relationship to Ruffle (Reuse Evaluation)

Ruffle's `swf` crate has a complete `read_tag_with_code` (including `DefineBitsLossless`/`DefineBitsJPEG`
parsing), **but it is not portable** (Rust + `gc_arena` GC). Its value is as a **reference implementation**:

- The tag-header parsing and the `DefineBitsLossless2` field offsets (`characterID/bitmapFormat/width/height/
  zlibData`) in `swf/src/read.rs` can serve as the **format-alignment baseline** for our hand-written `swc.ts`
  parser;
- `make_lzma_reader` (mangled LZMA header handling) is only useful for `ZWS`; `temp/skin.swc` is `CWS`, so the
  first phase does not touch it.

**Do not introduce Ruffle code** — only use it to align format details.

---

## 9. Phased Plan (Corresponding to the User-Selected "Compile-Time Extract + Embed into Output")

### Stage Sixty-Six: SWC Extractor + ZIP/SWF Parsing (Compile Time)

- [ ] `src/swc.ts`: hand-written ZIP central-directory parsing + `zlib` raw-inflate to decompress the ZIP layer
      of `library.swf`; CWS decompression (`zlib.inflateSync`) to get the tag stream; scan tags and extract
      `DefineBitsLossless2`/`Lossless` (decompress zlib → ARGB pixels) / `DefineBitsJPEG2/3` (JPEG bytes)
- [ ] `SymbolClass`(76) parsing: `{symbol id → className}` mapping; filter out resources "mapped to a class
      name + being a BitmapData subclass"
- [ ] Produce `SwcResource[]` (`className`/`format`/`width`/`height`/`pixels` or `jpegBytes`)
- [ ] Acceptance: run the extractor on `temp/skin.swc`, all 16 class-named resources extracted, pixel sizes
      correct (`logo` 100×72)

### Stage Sixty-Seven: Resource Class Registration + Embedded Pixel Filling (codegen)

- [ ] `symbols.ts`: register the resource class name as a `BitmapData` dynamic subclass (constructor `(int,int)`)
- [ ] `emit.ts`: emit the C byte-array resource segment (`__res_skin_logo[]` + width/height); `new logo(w,h)`
      dispatches to the "allocate BitmapData + fill embedded pixels + write width/height" factory; JPEG
      resources decode via `as_skia_image_from_bytes`
- [ ] `runtime.ts`: add `as_skia_image_from_bytes(data, len)` (JPEG in-memory decode glue)
- [ ] Acceptance: in `examples/swc_skin.as`, `new logo(0,0)` + `getPixel` asserts non-empty pixels + renders a
      PNG

### Stage Sixty-Eight: CLI/Manifest Wiring + Wrap-Up

- [ ] `build.ts` + `index.ts`: `--swc path/to/skin.swc` argument (multiple allowed) + build manifest
      `swc-paths` field; inject the extractor results into codegen's resource table
- [ ] Full regression over all old examples; README sync of the "SWC resource embedding" supported subset and
      limitations (ZWS/LZMA, font, sound, SymbolClass reflection deferred); bump the version number

---

## 10. Explicit Deferrals / Limitations

| Item | Reason |
|----|------|
| `ZWS`(LZMA) SWC | `temp/skin.swc` is `CWS`; LZMA needs `make_lzma_reader`'s mangled-header handling, a separate sub-stage |
| Font (`DefineFont*`) / sound (`DefineSound`) | The first phase only does the bitmaps needed for "displaying UI"; font/audio are separate decode domains |
| `SymbolClass` reflection (`getDefinitionByName`) | Depends on dynamic class instantiation + reflection table; stage forty-eight has the foundation, to extend later |
| Class-name-less bitmaps referenced by `Sprite` (43) | Requires parsing the full `DefineSprite`/`PlaceObject` display tree; the first phase only does "class-named direct resources" |
| `[Embed]` metadata syntax | For own-project scenarios reading the original image directly is simpler; this plan focuses on the "only SWC" scenario |
