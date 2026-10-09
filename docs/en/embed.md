# `[Embed]` Resources (stage one-hundred-twelve, v0.4.85)

> This document records `[Embed]`'s implementation boundaries, measured basis, and known deviations **in this
> compiler**. The semantic baseline is always **adl 51.4.1**; every "AIR does this" has a reproducible probe
> (`temp/embedprobe`…`temp/embedprobe7`). Implementation locations:
> [`src/embed.ts`](../../src/embed.ts) (resource expansion) + `emitEmbedResources` in
> [`src/emit.ts`](../../src/emit.ts) (bytes and binding helpers) + the same-class resource channel in
> [`src/swc.ts`](../../src/swc.ts) (SWC named resources, stage ninety-five).

## 1. What It Is

AIR's `[Embed]` metadata compiles an **external file** into the output, and makes the **annotated class member
itself** a "resource class" — i.e. the member's value is a **Class**, and `new <member>()` yields the resource
object:

```as3
public class Assets {
  [Embed(source="sky.jpg")] public static var Sky:Class;
}
var bmp:Bitmap = new Assets.Sky();   // the decoded image
```

This is AIR's standard means of distributing texture/audio/shader bytes with an application, and the premise
on which away3d's `Basic_SkyBox` (6 skybox JPEGs) and `EnvMapMethod` (`RayTriangleKernel.pbj`) start up.

## 2. AIR Measurement (adl 51.4.1)

| Declaration | Generated class | Instance |
|---|---|---|
| `.png`/`.jpg`/`.jpeg`/`.gif`/`.bmp` | `extends flash.display.Bitmap` | has `bitmapData` (the decoded `BitmapData`) |
| `mimeType="application/octet-stream"` (any extension) | `extends flash.utils.ByteArray` | content = the file bytes **verbatim** (`length` = file size, `position` 0) |
| `.mp3` or `mimeType="audio/mpeg"` | `extends flash.media.Sound` | `.length` = the real decoded duration (ms), `bytesTotal` = file size |

Remaining measured conclusions (each with a probe):

- **Constructor takes 0 arguments**: `new C(0, 0)` ⇒ `ArgumentError #1063` ("Expected 0, got 2"), not "silently
  ignore extra arguments".
- **`mimeType` overrides the extension**: `source="a.png" mimeType="application/octet-stream"` ⇒ `ByteArray`;
  `source="a.xml"` (no `mimeType`) ⇒ `Object` (**not** `XML`), whereas
  `source="a.xml" mimeType="application/octet-stream"` ⇒ `ByteArray`.
- **`source` path**: relative to the directory of the `.as` file **declaring it**; if it starts with `/`, relative
  to the **source root** (`<appRoot>/src` under `--air-app`). Basic_SkyBox's two `pbj` are written as
  `/../pb/RayTriangleKernel.pbj`.
- **Deduplication**: the same `(file, mimeType)` embedded multiple times ⇒ **only one class object** (in AQIR,
  `A === B` is true).
- **Hard rejection** (`mxmlc` errors outright, not at runtime): `.txt`/`text/plain`, `.svg`, `.wav`,
  `application/xml`. AIR's SVG/text channels are **creation-time conversions**, outside the runtime's range.
- **Relationship between the Class value and the instance**: `var x:* = Assets.Sky; x is Class` is true, whereas
  `x is Bitmap` is **false** (the instance is the Bitmap);
  `getDefinitionByName(getQualifiedClassName(Assets.Sky)) === Assets.Sky` is true. away3d's `Cast.bitmapData()`
  branches precisely on this pair of tests.

## 3. Implementation Form

`[Embed]` goes through the same "**resource-expansion pre-pass**" as SWC:

```
lexer → parser → parser keeps `[Embed(...)]` as Metadata.named / Field.metadata
      → embed.ts expands (produces AST + bytes, produces no C text, touches no build)
      → codegen (the new classes join symbol collection / vtable / class registry)
      → emit.ts writes the bytes as C arrays + one binding helper per kind
```

- **Bytes embedded verbatim**: `static const unsigned char <sym>[]`, whose content is the **raw file**. At runtime
  images are decoded by Skia (`as_skia_image_decode_bytes_argb`) into a **straight-through ARGB** snapshot, so
  opaque pixels are **pixel-for-pixel identical** to AIR; semi-transparent pixels have a **known deviation**
  (see §4).
- **One binding helper per kind** (`as_embed_bitmap_fill` / `as_embed_ba_fill` / `as_embed_sound_fill`), called
  in the generated class's **constructor**; the `bitmap` class uses `BitmapData_adoptEncoded` (the same decode
  path as SWC bitmaps, no new decoding code).
- **Generated class name**: `Embed_<host class C name>_<field name>`. AIR's `<file>_<ext>$<hash>` hash is not
  reproducible, so only the `getQualifiedClassName()` string differs.
- **Deduplication key** = `(resolved file, kind)`, matching AIR's "one class object per resource".
- **Field initialization** is injected at the symbol layer (`SymbolTable.embedFieldInits`), without touching the
  AST.
- **`source` resolution** follows the same rules as AIR (declaring file's directory / a leading `/` is the
  source root).

## 4. Known Deviations (all explicit, none silent)

| Deviation | Note |
|---|---|
| Class-name string | `getQualifiedClassName(Assets.Sky)` yields `Embed_Assets_Sky`, AIR yields `<file>_<ext>$<hash>` (the hash is not reproducible). The class-object identity, `is Class`, `new` behavior, and `bitmapData` are all identical |
| Semi-transparent pixels | AIR un-premultiplies the RGB of semi-transparent pixels before storing them in **bitmapData** (measured to be a definite function of `(c,a)`, but not a clean premultiply/un-premultiply pair); we store **straight-through ARGB**. Opaque pixels are pixel-for-pixel identical |
| Embedded audio | A real `Sound` subclass is generated, decoding handed to the audio backend; in a build **without** an audio backend `loadCompressedDataFromByteArray` returns −1 ⇒ `#2068` (different from AIR's behavior when a device is present, but this is a backend capability, not `[Embed]` semantics) |
| Rejection set | `.txt`/`.svg`/`.wav`/`application/xml` are rejected just like AIR; an unknown extension/`mimeType` also **errors loudly** and lists the supported set (§1.5, never silent) |
| **Compile scope = the whole `src/`** | We do **no reachability analysis**: every `.as`'s `[Embed]` under `<appRoot>/src` is packed in (including **other demos**' resources) and **survives into the output**; `mxmlc`/`adl` compile **transitively**, handling only reachable classes' `[Embed]`. Knock-on consequence: a bad `[Embed]` in an unreachable class makes us **fail at compile time**. Measurement and criteria in **§7**; registered in `TODO.md`'s leftover table |
| Sound's `extract`/`id3` | Depends on audio-backend capability, see `docs/zh-cn/audio.md` |

## 5. Usage

`[Embed]` images must be **decoded**, so the build manifest must link Skia (the same as SWC bitmaps; this is a
**build-layer** choice, not codegen's):

```bash
node src/index.ts my-app.as --manifest my.build.json --run
```

`examples/embed.as` + `examples/embed.build.json` is a complete sample (covering image / binary / sound
resources, Class-value identity, deduplication, `new C(0,0)`'s #1063, and decoded pixel values), guarded by
`node test.ts`'s `example: embed.as` case; `test/unit/embed.ts` pins the source-level structure and negative-case
text.

## 6. Evidence and Reproduction

- `temp/embedprobe*`: adl probes (the kind table, the 0-arg constructor, `mimeType` override, path rules,
  deduplication, the rejection set), with conclusions written to `temp/embedprobe7/adl.txt`.
- `examples/away3d-core/Basic_SkyBox.as`: 6 skybox JPEGs; under headless runtime the window renders a snowy
  skybox + an environment-reflective chrome ring (see `docs/zh-cn/display3d.md` §9).
- Static implementation locations: `src/embed.ts` (expansion), `emit.ts`'s `emitEmbedResources` (bytes and
  binding helpers), `test/unit/embed.ts` (source-level nails, 3 groups).


## 7. Compile Scope: Whose Embeds Get Packed (a Known Deviation)

**The AIR side compiles transitively**: `mxmlc` starts from the main class (`-source-path+=src` + `$MAIN_SRC`)
and handles only `[Embed]` in **reachable classes** (`src/air-app.ts`'s script comment says this too:
"AIR/mxmlc compiles transitively from the main class").

**We compile the whole package**: `--air-app`'s `walk(srcDir)` pulls **every** `.as` under `<appRoot>/src` into
the compile (excepting only `SKIP_FILES` and the reverse-domain directories `com/org/net`), with **no
reachability analysis**; `src/index.ts`'s `collectEmbeds` runs the embed expansion over **every** parsed file ⇒
**every** `[Embed]` becomes a resource. Both away3d-core main programs therefore get
**40 resources / 4,969,434 B (4.74 MB)**:

```
[1/4] read   examples/away3d-core/Basic_SkyBox-app.xml (main Basic_SkyBox, 485 sources)
      embed  40 asset(s)
              image  Basic_SkyBox.EnvPosX <- ../embeds/skybox/snow_positive_x.jpg (107566 bytes)
              ...
              image  Basic_SpriteSheetAnimation.testSheet1 <- ../embeds/spritesheets/testSheet1.jpg (19455 bytes)
```

Note the last line: `Basic_SkyBox` **does not use** the sprite sheet, yet its resource made it into this build
anyway. (`Basic_SkyBox.as` itself declares only 6 skybox JPEGs; `Basic_Stereo.as` declares **none**.)

### These Resources Survive into the Output

It is not just extra work at compile time — they **really go into the binary**: `emitClassRegistry`'s
`as_class_registry[]` references **every** class object (embedded classes included), and
`getDefinitionByName` at `src/away3d/utils/Cast.as:254` makes `as_get_definition_by_name` a reachable symbol ⇒
the registry lives in the closure ⇒ **`-O2` cannot strip** the embed factories and embedded byte arrays.

**The criterion is the binary bytes** (48 bytes taken from the middle of each; `Basic_Stereo` uses none of these
four resources):

| Resource | Bytes | Occurrences in `Basic_SkyBox` | Occurrences in `Basic_Stereo` |
|---|---|---|---|
| `embeds/road.jpg` | 55,879 | 1 (unused) | 1 (unused) |
| `embeds/rockbase_normals.png` | 584,811 | 1 (unused) | 1 (unused) |
| `embeds/hellknight/idle2.md5anim` | 292,064 | 1 (unused) | 1 (unused) |
| `embeds/skybox/grimnight_posX.png` | 57,507 | 1 (used) | 1 (unused) |

Compare against **SWF size** (AIR's transitively-compiled output carries only its own few):

| demo | Its own resources | `mxmlc`'s `.swf` |
|---|---|---|
| `Basic_Stereo` | **0** | **94 KB** |
| `Basic_SkyBox` | 6 skybox JPEGs (645,180 B) | 746 KB |
| `Basic_UVAnimation` | 2 (326,601 B) | 421 KB |
| `Intermediate_MD5Animation` | multiple md5/textures | 2.71 MB |

If all 40 resources were meant to go in, any single SWF should be ≥4.6 MB.

### Knock-on Consequence: a Bad `[Embed]` in an Unreachable Class Fails Our Compile

If a class in **another** demo (or one nobody calls at all) has an `[Embed]` pointing at a nonexistent file, an
`adl` build is fine (that class is not in the closure), while we **fail loudly**. This is a **fidelity gap**
(AGENTS.md §1.5: `adl` produces a correct result and we cannot ⇒ legacy), not an enhancement, and is registered
in [`TODO.md`](../../TODO.md)'s `### 遗留待开发`.

> When fixing it, note: **do not casually make `as_class_registry[]` lazy** — it also serves `x is SomeClass`,
> the dynamic path of `new x()`, `getDefinitionByName()`, and the GC root; programs relying on `[Embed]`
> (`Basic_SkyBox`) and programs relying on reflection (`Cast.bitmapData`) must both keep working. The current
> deviation is **explicit** (the build log lists every resource), not silent behavior.