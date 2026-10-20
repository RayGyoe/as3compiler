# Skia Rendering Backend Research and Integration Plan

> This document answers two questions: **why use Skia to implement the GUI**, and **how close the
> relationship between Skia and the event/view system really is**.
> Core conclusions up front: Skia is a **pure 2D rasterization library**; it is only responsible for "turning
> geometry/bitmaps/text into pixels". The display list (`DisplayObject` tree), the event flow, and hit testing
> — these AS3 semantics — **are not in Skia and must be implemented by us in a C runtime** (stages thirty-three
> to thirty-five, with Ruffle as the semantic reference). Skia and our self-built event/view system are
> **orthogonal**; the only **convergence point** between them is `DisplayObject.render()` — each display object
> translates its own geometry into Skia `SkCanvas` drawing calls.
>
> Positioning: Skia is to this project the equivalent of "link skia/cairo rather than build your own
> rasterizer" from the "stage twenty-nine GUI direction plan"; what it replaces is the **pixel output** layer,
> not the display-list/event layer.

---

## 1. Why Skia (and the Skia-vs-cairo tradeoff)

Skia is the open-source cross-platform 2D graphics library developed and maintained by Google, and the
underlying rendering engine of Chrome / Android / Flutter.

| Dimension | Skia | cairo |
|------|------|-------|
| Maintainer | Google (backed by Chrome/Android/Flutter) | the GNOME community |
| Language | **C++20** | C (with a stable C ABI) |
| Backends | CPU raster / GPU (Vulkan/Metal/GL/D3D) / PDF/SVG | CPU raster / GL / PDF/PS/SVG |
| Text | SkFont/SkTextBlob + SkParagraph (full typesetting) | Pango/Cairo toy API (needs an external typesetter) |
| Anti-aliasing | high-quality AA + analytic AA | good |
| Vector Path | extremely strong (including pathops boolean operations) | strong (has path booleans) |
| License | **BSD-3-Clause** (permissive, allows static linking into closed source) | LGPL/MPL |
| Size/build | heavy (GN/ninja, `libskia.a` tens of MB) | light |

**Why Skia**: AS3's `flash.display.Graphics` (vector `moveTo/lineTo/curveTo` + gradient fill + stroke) is
essentially a "Path + Paint" model, and Skia's `SkPath`/`SkPaint`/`SkShader` correspond to it **almost
semantically one-to-one**; plus the Flutter ecosystem depends heavily on Skia, so the community is mature and
cross-platform consistency is good. cairo's strengths are "has a C ABI, small size", but its text typesetting
needs Pango bolted on, and its vector-gradient API is more cumbersome than Skia's.

**This project's decision**: primarily use **Skia**, with the rendering layer exposing an `extern "C"`
interface to the generated `.c` through a **C++ glue layer** (see §4). cairo stays in the options as a backup
backend for "size-sensitive scenarios", but is not done by default.

---

## 2. Skia Core Concepts (the part this project uses)

Everything in Skia is organized around `SkCanvas` (the canvas). A drawing call `canvas->drawRect(rect, paint)`
splits into two parts: **what is being drawn** (`SkRect`/`SkPath`/`SkImage`/text) and **how to draw it**
(`SkPaint`: color, fill/stroke, line width, shader, blend mode).

| Class | Responsibility | Corresponding AS3 concept |
|----|------|--------------|
| `SkCanvas` | drawing entry point, maintains the matrix/clip stack (`save`/`restore`/`translate`/`rotate`/`scale`/`clip*`) | `Graphics`'s drawing target + `DisplayObject`'s `x/y/rotation/scaleX/scaleY` transform |
| `SkPaint` | color, fill/stroke style, line width, anti-aliasing, blend mode, shader/filter | `Graphics.lineStyle`/`beginFill`/`blendMode`/filters |
| `SkPath` | a geometric path of lines/beziers/arcs | the path data of `Graphics.moveTo/lineTo/curveTo` |
| `SkSurface` | the pixel carrier (CPU/GPU/PDF), `getCanvas()` gets the canvas | the Stage's bitmap surface / `BitmapData`'s pixel buffer |
| `SkBitmap` / `SkImage` | bitmap pixel storage (`SkBitmap` leans writable, `SkImage` leans read-only) | `BitmapData` / `Bitmap` |
| `SkImageInfo` | width + height + color type + alpha type (e.g. `kN32_SkColorType` premul) | `BitmapData`'s pixel format (ARGB) |
| `SkMatrix` | 3×3 affine transform matrix | `DisplayObject.transform.matrix` |
| `SkFont` / `SkTypeface` | font and font size | `TextField` / `TextFormat` font settings |
| `SkTextBlob` | a typeset glyph run | `TextField`'s text content (basic path) |
| `SkShader` (`SkGradientShader`) | gradient/pattern fill | `Graphics.beginGradientFill` |
| `SkBlendMode` | pixel blend operation | `DisplayObject.blendMode` |
| `SkMaskFilter` / `SkImageFilter` | filters such as blur | `BlurFilter`/`DropShadowFilter` |

**Coordinate system**: Skia's origin is top-left with the **y axis pointing down** — consistent with Flash's
display coordinate system, so no flip is needed when translating.

### 2.1 The pixel byte-order boundary: `kN32` varies by platform (always specify it explicitly)

`BitmapData.pixels` is a `uint32` array in the runtime, storing the **numeric** value `0xAARRGGBB` (straight
alpha). But Skia's "native" format `kN32_SkColorType` is only a **platform-dependent** alias:

| Platform | `SK_R32_SHIFT` | the memory byte order of `kN32` |
|------|----------------|----------------------|
| Windows | 16 | B,G,R,A (`kBGRA_8888`) |
| macOS / Linux | 0 | R,G,B,A (`kRGBA_8888`) |

(Based on `include/core/SkTypes.h`'s `SK_R32_SHIFT` + the `SK_PMCOLOR_BYTE_ORDER(R,G,B,A)` expansion, and
`include/core/SkColorType.h`'s `kN32_SkColorType` definition.)

Therefore **the generated C must never assume the byte order of a Skia surface / `SkBitmap`** — "looks like
BGRA" holds only on Windows. Every "Skia ↔ runtime" read-back uniformly requests `kBGRA_8888` + `kUnpremul`,
and endianness parsing is converged in one place, `skia_glue.cc`: on a little-endian host, the byte sequence
B,G,R,A read as a `uint32` **already is** `0xAARRGGBB`, so "specifying it explicitly" pins the channel order
without a per-pixel loop; `kUnpremul` also gives AS3's straight alpha, saving a manual un-premultiply. Only a
big-endian host needs explicit reassembly (the `__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__` branch; there is no
such target currently).

Historical lesson: `BitmapData.draw(TextField)`'s read-back once took channels directly as `q[0]=B, q[2]=R`
(treating `kN32` as BGRA), swapping red and blue on macOS (a red-background `TextField` read back as blue).
Regression: `examples/bitmapdraw-channel.as`.

There are two more boundaries of the same kind, handled with the same principle:

- **Image decoding** (`sk_image_decode_argb` / `sk_image_decode_bytes_argb`): `readPixels` writes directly
  into the ARGB buffer, no longer going through a temporary buffer + per-pixel swizzle.
- **Stage3D texture upload** (`stage3d_glue.mm`'s `s3d_upload_texture`): the target is
  `MTLPixelFormatBGRA8Unorm`, which under little-endian is **naturally consistent** with the runtime buffer's
  byte order, so a direct `replaceRegion` suffices (the old code's malloc + swizzle was a byte-for-byte no-op
  on little-endian).

---

## 3. Key Decision: Skia Has No C API, Must Add a C++ Glue Layer

This is the most important technical conclusion of this plan, and a detail that earlier docs glossed over in
"link skia":

- The current Skia `main`'s `include/` directory (android / codec / config / core / cpu / docs / effects /
  encode / gpu / pathops / ports / private / sksl / svg / third_party / utils) has **no `c/` subdirectory** —
  the C API (`sk_canvas.h` etc.) once used for PDFium/some bindings has been removed, and Skia is now a
  **pure C++20 interface**.
- But our compiler produces **C** (`as-aot` generates `.c`), and C cannot directly link C++ symbols (name
  mangling, `SkRefCnt` reference counting, `sk_sp<>` smart pointers, exceptions, etc.).
- So there **must** be a hand-written C++ glue file (`skia_glue.cc`) that wraps the Skia capabilities we use
  into flat C functions with `extern "C"`, and the generated `.c` calls only these `sk_*` C functions. This
  lands exactly in stage twenty-nine's build-manifest capability:

```json
{
  "target": "native",
  "c-compiler": "clang",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia"],
  "link-libs": ["skia", "…"],
  "link-paths": ["../vendor/skia/lib/macos-arm64"],
  "defines": ["ASC_USE_SKIA=1"]
}
```

> The above only sketches the **shape** (`link-libs` actually has twenty-odd entries, and copying the whole
> thing into the docs would only go stale — an earlier version of this file did exactly that and got
> `skia_glue.c` and `include-paths: ["../vendor/skia/include"]` wrong). **The only authority is
> [`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json)**, and commands in
> the docs always reference it via `--manifest`, never copying a second version. Skia is C++: the glue layer
> is `.cc`, and `build.ts` recognizes `.cc/.cpp` in `sources` and automatically switches to the C++ driver
> (`clang++`, implicitly linking `libstdc++`), with linking likewise finished by the C++ driver — all of this
> was already implemented in stage thirty-six. Regression guard: `test/unit/build.ts`'s
> `build/DocumentedLinkSets` compiles the generated C once with the **real manifest**'s `defines`, so any
> backend combination defined by a documented manifest that fails to compile turns red (on 2026-10-06 it was
> the offscreen branch missing `AS_CURSOR_*` and silently failing).

**Glue-layer design principles** (following AGENTS.md §2.9):

1. Expose only **flat C functions**, all signatures `extern "C"`, with parameters containing only PODs
   (`int/float/double/const char*/pointer`), not exposing `sk_sp`/`SkString`/STL containers.
2. All Skia objects pass in and out as **opaque pointers** (`void*` / `sk_handle`), with lifetimes managed
   inside the glue layer (reference counting), corresponding to the AS3-side `as_skia_*` runtime helpers.
3. Platform coupling (window/surface creation) is concentrated in the glue layer; the generated `.c` touches
   no Skia header directly — `#ifdef __wasi__` is still contained in `RUNTIME_PREAMBLE` (native uses CPU
   raster / SDL, WASI uses offscreen raster output to `SkImage`).

---

## 4. `flash.display.*` → Skia Mapping Table (core)

This is the actual translation correspondence for "implementing the GUI with Skia". **Keep one main thread in
mind**: the display list (who is whose parent, depth order, hit testing) is implemented by the C structures of
stages thirty-four/thirty-five; Skia only takes over at **leaf rendering**, drawing geometry into `SkCanvas`.

| AS3 (`flash.display` / `flash.filters`) | Skia translation | Note |
|-----------------------------------------|-----------|------|
| `DisplayObject.x/y/rotation/scaleX/scaleY` | `canvas->translate(x,y)` + `rotate` + `scale` (inside `save`/`restore`) | corresponds to AS3's matrix transform |
| `DisplayObject.alpha` | `SkPaint::setAlpha` or `saveLayerAlpha` | whole-subtree transparency uses `saveLayerAlpha` |
| `DisplayObject.visible=false` | skip rendering that subtree | pure display-list decision, no Skia involved |
| `DisplayObject.blendMode` | `SkPaint::setBlendMode` (`SkBlendMode::k*`) | AS3 `BlendMode` enum → Skia enum mapping |
| `Shape.graphics.moveTo/lineTo/curveTo` | `SkPath::moveTo/lineTo/cubicTo/quadTo` | `curveTo` is a quadratic bezier → `quadTo` |
| `Graphics.beginFill(color, alpha)` | `SkPaint` fill style + `setColor`/`setAlpha` | after `endFill`, `drawPath(path, paint)` |
| `Graphics.lineStyle(thickness, color, alpha)` | `SkPaint` stroke style + `setStrokeWidth` + `setStrokeMiter/Cap/Join` | stroke attributes aligned item by item |
| `Graphics.beginGradientFill(...)` | `SkGradientShader::MakeLinear/MakeRadial` → `SkPaint::setShader` | two kinds, linear/radial |
| `Graphics.drawCircle/drawRect/drawRoundRect` | `SkCanvas::drawCircle/drawRect/drawRRect` | convenience geometry |
| `Bitmap.bitmapData` / `BitmapData` | `SkBitmap`/`SkImage` + `drawImage` | `BitmapData` is a pixel buffer, `Bitmap` is a display node |
| `BitmapData.setPixel/getPixel` | `SkBitmap::setPixel/getColor` (or `SkPixmap`) | CPU pixel read/write |
| `BitmapData.draw(source)` | `SkCanvas::drawImage/drawSurface` (offscreen surface compositing) | bitmap-to-bitmap copy/composite |
| `TextField.text` (basic glyphs) | `SkFont` + `SkTextBlob` → `drawTextBlob` | glyph positioning only, no line breaking |
| `TextField` (full typesetting: wrap/align/paragraphs) | **SkParagraph** (`modules/skparagraph`) → `SkParagraph::layout` + `paint` | AS3's automatic wrapping/multiline needs SkParagraph |
| `TextFormat.font/size/color/bold/italic` | `SkFont` + `SkTypeface` + `SkPaint` | font family/size/bold/italic |
| `filters.BlurFilter` | `SkImageFilters::Blur` (wrapping the subtree with `saveLayer`) | landed (stage sixty-one), `sigma = blur * sqrt(quality) / sqrt(12)` — a **variance match** against AIR's "diameter = a box repeated `blurX` times `quality` times" (pinned by measurement in stage ninety-five / seven, replacing the earlier empirical `blurX/3`). The profile is still a Gaussian approximation: steeper in the middle, thinner in the tails |
| `filters.DropShadowFilter` | `SkImageFilters::DropShadow` / `DropShadowOnly` (`saveLayer` + `SkImageFilter`) | landed (stage sixty-one), outer drop shadow. Stage ninety-five / seven adds `strength` (multiplied **after** the blur, `min(1, silhouette × alpha × strength)`, aligned with adl measurement) and `hideObject`; note the `DropShadow` factory already composites the **source** in, so `strength` must never be applied to its output (it would thin the whole object — see `swc.md` §9.2 F4's 137/255 incident) |
| `filters.GlowFilter` | `SkColorFilters::Matrix` (alpha-silhouette coloring) + blur + overlay the body | landed (stage sixty-one), outer glow. Stage ninety-five / seven adds `strength` (same as DropShadow, and multiplied after the blur: a pre-applied alpha factor saturates because the silhouette is opaque, so measured `strength 1` and `2` come out identical) |
| `DisplayObject.mask` | `canvas->saveLayer` + mask drawing + `SkBlendMode::kSrcIn` | AS3 mask semantics |
| `scrollRect` | `canvas->clipRect(0,0,w,h)` **then** `translate(-x,-y)` | the window stays anchored on the object's own box and only the **content** slides (measured in stage one-sixty-two; see "coordinate transforms" below and D29) |

**The correct posture for coordinate transforms** (corresponding to Skia `SkCanvas`'s matrix stack):

```
Rendering a DisplayObject subtree (recursive):
  canvas->save();
  canvas->translate(obj->x, obj->y);
  canvas->rotate(obj->rotation);
  canvas->scale(obj->scaleX, obj->scaleY);
  canvas->concat(obj->transform.matrix);     // if there is a full matrix
  // if (obj->scrollRect) { clipRect(0,0,w,h); translate(-x,-y); }
  //   ↑ the order is not swappable: Skia maps clipRect through the CTM in force at the
  //     call, so clipping after the translate moves the WINDOW itself to (x,y,w,h)
  //     (the window slides along with the content) -- that was D29 in stage one-sixty-two.
  // 1) first draw itself: obj->render_self(canvas)   (Shape draws path, Bitmap draws image, TextField draws textBlob)
  // 2) then draw children in depth order: for child in children: render(child)
  canvas->restore();
```

> **Depth order**: a `DisplayObjectContainer`'s render order = depth order (lower depth drawn first, higher
> depth drawn later and covering on top). This is the same children array as stage thirty-five's "mouse hit
> testing in reverse order, keyboard in forward order", two views of one thing. **Rendering uses forward
> order; mouse hit testing uses reverse order.**

---

## 5. Skia and the Event System: Orthogonal, Not "Highly Related"

This is the direct answer to "is it highly related to the event/view system":

- **Skia does not provide at all**: the display list/scene graph, event dispatch (capture/bubble), hit
  testing, focus, window management, input-device abstraction. These are exactly what stages thirty-three to
  thirty-five build themselves, with Ruffle as the semantic reference.
- **The event system does not depend on Skia**: `hitTestPoint(x, y)` determines "which object the mouse is on"
  using **the display list's geometry (coordinate transforms + shapes)**, not Skia's pixels. Ruffle's
  `interactive.rs` hit three-state machine (`Avm2MousePick`) traverses the `DisplayObject` tree, completely
  decoupled from the rendering backend.
- **Their only convergence point is `render()`**: the event system decides "who responds first, who gets hit",
  and the rendering system decides "what it ultimately looks like". An object is first hit (stage thirty-five's
  geometric hit test), then rendered (this file's Skia translation). The two share the same `DisplayObject`
  tree, but their responsibilities are orthogonal.

**Optional reuse**: Skia's `SkPath::contains(x, y)` / `SkRegion` can **assist** implementing `hitTestPoint`'s
"point inside shape" determination (especially for complex vector shapes). But this is only a bonus — AS3's
`hitTestPoint(shapeFlag=false)` uses a bounding box by default (a geometric determination), and only
`shapeFlag=true` does shape-level hit testing. **The first phase can use the bounding box**; SkPath hit testing
is left until precise shape hit testing is needed.

> In one sentence: **Skia handles "drawing", the event/view system handles "who is on top, who responds
> first"**. The two converge at leaf nodes through the `DisplayObject.render()` interface, rather than being
> "highly coupled".

---

## 6. Build and Linking (landing points)

### 6.1 Obtaining and Compiling Skia

> **This project's actual landing approach — read this before touching `vendor/skia/`**: `vendor/skia/include`
> comes from the upstream prebuilt milestone, but `vendor/skia/lib/macos-arm64/libskia.a` is **compiled from
> source** in `build-tools/skia-src` and carries a **local patch** (see §6.9 and
> `vendor/skia/patches/README.md`). Never replace that library with an upstream prebuilt one: the patch fixes
> CoreText silently switching faces between two font files that share family + PostScript name (stage 167).
> The wasm and Windows libraries are unpatched (the change is macOS/iOS-only).
>
> Historically this machine lacked `gn`/`ninja` and disk space, so
> [Aseprite's official precompiled Skia](https://github.com/aseprite/skia/releases) **m124**
> (`Skia-macOS-Release-arm64.zip`) was used instead; that package ships headers (`include/`) and the full set of
> static libraries (`out/Release-arm64/*.a`), extracted into `vendor/skia/{include,lib}/` and wired into the
> build manifest together with the transitive dependencies PNG/JPEG/WebP/freetype/harfbuzz/icu/zlib (see
> `examples/skia-link.build.example.json`). **If you need to compile from source yourself, follow the process
> below**.

Skia is built with **GN/ninja** and needs a C++20 compiler (officially **clang** is strongly recommended;
only clang triggers the optimal paths for software rasterization/image decoding, and other compilers are
noticeably slower).

```bash
git clone https://skia.googlesource.com/skia.git
cd skia
python3 tools/git-sync-deps        # fetch third-party dependencies (libpng/libjpeg-turbo/libwebp etc.)
python3 bin/fetch-ninja

# produce the static lib libskia.a (is_official_build=true means release, dynamic-link system deps)
bin/gn gen out/Static --args='is_official_build=true'
ninja -C out/Static skia           # target name skia -> out/Static/libskia.a

# if SkParagraph is needed (TextField full typesetting)
bin/gn gen out/Static --args='is_official_build=true skia_use_skparagraph=true'
ninja -C out/Static skia skparagraph
```

Artifact layout (assuming installation into `vendor/skia/`):

```
vendor/skia/
  include/   ← headers (include/core, include/effects, include/codec, ...)
  lib/       ← libskia.a (+ libskparagraph.a etc.)
```

### 6.2 How the Build Manifest Connects

Stage twenty-nine's `build.ts` already supports `sources`/`include-paths`/`link-libs`/`link-paths`. The
rendering stage needs two additions:

1. **C++ glue-layer compile driver**: when `.cc/.cpp` appears in `sources`, drive with `clang++` (not `cc`),
   and make sure `-lstdc++` is linked (macOS's `clang++` includes it implicitly).
2. **Skia's transitive dependencies**: `libskia.a` depends on libpng/libjpeg-turbo/libwebp/fontconfig/
   freetype/zlib etc. With `is_official_build=true` these go through system dynamic libraries, and the link
   line must complete `-lpng -ljpeg -lwebp -lz ...` (or link Skia's own `skia_public` description directly).
   **First-phase recommendation**: use `is_official_build=false` to statically pack all dependencies into
   `libskia.a`, giving the cleanest link line at the cost of longer compilation and a bigger library.

### 6.3 Rendering Backend Choice (first-phase recommendation: CPU raster)

| Backend | Pros | Cons | Applicable |
|------|------|------|------|
| **CPU raster** (`SkSurface::MakeRaster` / `SkBitmapDevice`) | zero window-system dependency, zero GPU driver, offscreen output possible, easy to test | slow on large canvases | **first phase**: offscreen render → output PNG/bitmap, or hand it to SDL for presentation |
| GPU (Vulkan/Metal/GL/D3D) | fast, smooth animation | depends on a graphics API + a window context | connect later when doing a real desktop window |
| PDF/SVG (`SkDocument`) | vector output | non-interactive | optional: `BitmapData` export |

**Recommended landing order**: first do **offscreen CPU raster** (`SkSurface::MakeRaster` → `SkCanvas` →
`makeImageSnapshot` → `SkImage::encodeToData(SkEncodedImageFormat::kPNG)`), so `as-aot --run` can directly
produce bitmap files and regress-assert pixels, without touching the window system at all. A real desktop
window has landed (stage thirty-nine: SDL2 presentation + event loop; stage forty: mouse input bridged back
to the AS3 event system, see [`compile.md`](compile.md) §6).

> This is precisely the continuation of this project's iron rule "the front end only translates, optimization
> goes to mature libraries": **we don't even build the window and pixels ourselves** — Skia handles pixels,
> SDL2 handles the window and input (already landed: stage thirty-nine window presentation + stage forty mouse
> event bridging, see [`compile.md`](compile.md) §6), and we are only responsible for translating AS3
> semantics over.

### 6.4 Version Selection Conclusion (why SDL 2.32 and Skia m124)

**SDL: 2.32.10 is the current SDL2 mainline, not old.** See [`compile.md`](compile.md) §6 (window backend).
The project pins SDL2 rather than SDL3 because: SDL3 (first released as 3.2.0 in 2025-01) is too new, with 90%
of the community ecosystem/tutorials/third-party bindings still on SDL2; there is no substantial gain for a
lightweight "single window + blit the Skia surface to screen" scenario; and SDL3 removed
`SDL_CreateRGBSurface`, changed the renderer interface, and turned `SDL_Event` into a union, so
`window_glue.cc`'s `SDL_CreateRGBSurfaceFrom`/`SDL_RenderCopy`/`SDL_GetWindowSizeInPixels`/`SDL_RenderSetVSync`
would all have to be rewritten. These capabilities (especially `SDL_GetWindowSizeInPixels`, added only in SDL
2.26) are exactly the dependency for fixing the cross-screen-scale bug, showing that 2.32 is sufficient for
this project and happens to support what is needed. We compile an arm64 static library from source
(`configure --host=arm64-apple-darwin --disable-shared`), controlling the version ourselves, with no need to
chase a new major version barely a year old.

**Skia: m124 is indeed old (~2.5 years, m124 ≈ 2024-04), but there is a concrete reason.** Note that
"environmental constraints" is **no longer** the reason — it is **historical**, as §6.1's "how this project
actually does it" already marks it: the repo-root `build-tools/skia-src` is now a full m124 source tree (with
`bin/gn` + `third_party`), and `vendor/skia/lib/macos-arm64/libskia.a` is **self-compiled** from it along with a
local patch (`vendor/skia/patches/`). The real reasons are three: ① Skia has no stable API/ABI, the milestone
rolls every 4 weeks and interfaces change frequently, so an upgrade means rewriting the entire `skia_glue.cc`
layer; ② the four platform libraries (`macos-arm64`/`wasm`/`windows-x64`/`windows-x86`) and the vendored headers
must move **in one batch**, the local patches must be re-applied and the `[skia-abi]` byte-for-byte pins re-run —
§6.5 records an incident where a change made *within the same milestone* to `kMaxSubclassSize` was enough to
corrupt a register (`x28`), so a cross-milestone jump can only be worse; ③ m124 already contains all needed
modules (`SkParagraph`/`Skottie`/GPU backends). **Upgrade trigger condition**: only when a feature available
only in a new milestone is truly needed (e.g. some new `SkImageFilter`, new font-engine behavior) do you take
the corresponding milestone from `build-tools/skia-src` and recompile (**no** need to set up a `gn`/`ninja`
environment again) and re-test the entire glue layer.

> **Re-checked 2026-10-19 (v0.4.179)**: `skia-canvas` **4.0.0** (released 2026-10-12) bundles **Skia m153**
> (`skia-safe` 0.99.0), but it is a **Node.js N-API binding** driving Skia through runtime JS Canvas calls,
> which is **not the same layer** as this project's "**compile-time** static linking of Skia C++ into a native
> artifact / wasm" — there is no integration path (and this project's npm dependency set is permanently empty,
> §3.1). Nor is there anything to take from 4.0's fix list: the one cross-cutting item (the macOS Metal exporter
> missing an autorelease pool ⇒ native-buffer leak) we already have (`@autoreleasepool` in `metal_glue.mm` /
> `stage3d_glue.mm`). **The "upgrade the milestone" decision was therefore not reopened; the trigger condition
> is unchanged.**

### 6.5 vendored headers must be the **same version** as the precompiled library (this is ABI, not documentation)

`vendor/skia` holds a **precompiled library + a copy of the headers**. Once the two fall out of sync, the
symptom is not "drawn wrong" but **memory/registers being corrupted**: stage eighty-nine / seventy-four
measured that `vendor/skia/include/gpu/GrBackendSurface.h` was stuck at an **older revision of m124**, with
`kMaxSubclassSize` as `64/160/160`, while the tree that built `vendor/skia/lib/libskia.a`
(`build-tools/skia-src`) was `80/176/176`.
The consequence: **we reserve 160 bytes for a stack `GrBackendRenderTarget`, and the library writes 176** —
the library's constructor writes 16 bytes out of bounds, landing exactly on the stack slot where
`sk_mtl_begin_frame` saves `x28`/`x27` (clang's canary is right next to it at `sp+0x138`).
Symptom: an `-O2` `examples/air-native` SIGSEGVs about 1 second after startup, while `-O0` is completely
normal, and **any perturbed build with added prints/counters masks it** (because the perturbation changes the
frame layout and register allocation).

- **Criterion**: `diff -rq vendor/skia/include build-tools/skia-src/include` must be empty.
- **The same milestone does not imply a consistent layout**: upstream also changed `kMaxSubclassSize` within
  m124 (and added fields to `VulkanTypes.h` too), so "both are m124" is not enough to be safe — you must
  **compare byte by byte**.
- **Regression nail**: `node test.ts`'s `[skia-abi]` group (3 items) pins the specific values of
  `kMaxSubclassSize` and the fields of `VulkanTypes.h`, and requires the two header sets to be **byte-for-byte
  identical** when `build-tools/skia-src` exists (when it does not, it prints `SKIP` and keeps the literal-value
  nails).
- **Upgrade process**: any "replace vendor/skia" operation must **replace the headers and the library
  together**, and run `[skia-abi]`; replacing only the library immediately regresses to the state above.

### 6.6 The Metal backend's window state is **per window** (stage eighty-nine / seventy-five)

`metal_glue.mm` was originally a **process-level singleton** (one `CAMetalLayer` + `GrDirectContext` +
drawable + surface), serving only one window.
The consequence is not "the second window draws slowly" but that **at runtime any `new NativeWindow()` gets no
Metal at all**, falling back to CPU raster + a whole-frame `SDL_UpdateTexture` upload (600×410 @2x = 3.9
MB/frame/window, ~470 MB/s at 116 fps), and the cost **stacks linearly with the number of open windows**
(measured +12–14% CPU per window, 44% for three). Now:

| State | Ownership | Note |
|---|---|---|
| `MTLDevice` / `MTLCommandQueue` / `GrDirectContext` | **shared process-wide** | Skia requires them to outlive a context; the first GPU window creates them lazily, and the last slot tears them down on release |
| `CAMetalLayer` | **per window** (slot `g_mtl[id]`) | provided by that window's `SDL_MetalView`, merely borrowed: it must be released **before** the view is destroyed |
| the one-shot `CAMetalDrawable` + its wrapping `SkSurface` | **per window** | `sk_mtl_begin_frame(id, …)` acquires, `sk_mtl_flush(id)` presents and releases |

- **The id is the key through the whole chain**: `ASC_wins[]` (generated C) / `WinCtx[]` (window_glue.cc) /
  `g_mtl[]` (metal_glue.mm) are three tables with the same index, and the capacity constants
  `ASC_MAX_WINDOWS` = `SK_MAX_WINDOWS` = `SK_MTL_MAX_WINDOWS` = 16 must all agree.
- **Which windows go through GPU**: under an `ASC_RENDER_METAL` build the main window always goes Metal; at
  runtime `NativeWindow` also does by default (AIR's `NativeWindowRenderMode.AUTO` is exactly "use the GPU if
  there is one"), and only an explicit `renderMode = "cpu"` falls back to software raster.
  Measured comparison changing only that one line in the same binary (two secondary windows): **32.8% → 14.0%
  average CPU**.
- **The reverse comparison must stay in the code**: `#ifndef ASC_RENDER_METAL gpu = 0;` ensures a "build without
  a Metal backend" does not conjure up a window that claims to be Metal; and `renderMode="cpu"` is the reverse
  comparison within the same build (`temp/gpuprobe/`).
- **Pitfall (Objective-C++)**: a parameter in a `.mm` **must not be named `id`** — that shadows the **type
  keyword** `id`, so every `id<CAMetalDrawable>` in the function body is parsed as a comparison expression and
  the whole file fails to compile. Parameter names uniformly use `win_id`.
- **Semantic boundary**: a cpu-mode window in a Metal build **does not composite Stage3D/StageVideo** — AIR's
  docs explicitly state "software windows do not support StageVideo/Stage3D compositing", and a Metal build has
  no CPU read-back buffer anyway (exposing the render-target texture is precisely to save a read-back each
  time). This is not a silent degradation, it is AIR-defined behavior.
- **Regression nail**: `node test.ts`'s `[native-window]` group adds 15 items (Metal's unique slot-per-window,
  consistent capacities, every entry point carrying an id, the ObjC++ `id` keyword, attach/release order,
  `renderMode` selecting the backend, render/on_resize splitting, the pure-C stub matching the Skia version's
  shape, and the example being required to take the default path).

---

### 6.7 The picture must be presented 1:1, never rescaled by the compositor (stage one-hundred-thirty-three)

**Symptom**: in `examples/air-native` (`scaleMode=NO_SCALE` + `align=TOP_LEFT`, Metal compositing), dragging
the window to resize makes **the whole picture jitter violently** — not tearing, not content reflow, but the
entire image being scaled up/down by a little between consecutive frames.

**Root cause**: `CAMetalLayer`'s `contentsGravity` **defaults to `kCAGravityResize`** (`metal_glue.mm` had
never set it, though a comment still claimed "top-left gravity"). The compositor therefore **stretches the
drawable to fill the layer's bounds**. And during a live resize the drawable we just presented and the bounds
the compositor is using are **necessarily transiently inconsistent**: the window keeps growing after the frame
was drawn, so **no size picked at draw time can satisfy both** (`SDL_GetWindowSizeInPixels` and the layer
bounds both come from Cocoa, but the compositor uses later geometry). Under Resize semantics that frame rescales
**the whole picture** by `bounds/drawable` — which is exactly the jitter observed.

**Fix**: `l.contentsGravity = kCAGravityTopLeft;`. This is precisely AIR's `scaleMode=NO_SCALE` semantics
(content size fixed, anchored top-left): a frame whose size has not caught up is shown at its **original size**
with the newly exposed area left as background until the next frame paints it — **never resampled**. In the
steady state (`drawableSize == bounds*contentsScale`) the two gravities are pixel-for-pixel equivalent, so this
is a pure win.

**Measurement** (`temp/resizeprobe/fast.py`: `CGWindowListCreateImage` captures in-process at ~68 fps,
concurrently with a user-speed drag over Quartz compositing):

- **Pick the right ruler (we tripped once)**: at first we used the demo's fixed red "open window" box
  (100x50 logical ⇒ exactly 200x100 px at 2x) as the canary — **that does not work**. Another 100x100 red
  square **drifts** next to it by animation and the two **merge into one 4-connected component**, reading out as
  a bogus size change (once mistaken for a residual defect). Only the **completely isolated** mid-gray
  `identity` square (44x44 logical ⇒ **88x88 px** @(1120,1020)) made the measurement trustworthy.
- **Result** (one drag of 500 px / 0.3 s):

| `contentsGravity` | Frames rescaled (wrong size) | Samples |
|---|---|---|
| `kCAGravityResize` (pre-fix default) | **15 / 93** (4 drags: 2/24, 5/23, 4/23, 4/23) | 83x84@(1063,981), 86x86@(1111,1014), 85x85@(1084,994)… |
| `kCAGravityTopLeft` (post-fix) | **0 / 151** (6 drags, no anomalous frame at all) | — |

- **The samples prove it is a "whole-picture rescale", not local perturbation**: for 83x84@(1063,981),
  83/88 = 0.943, 1063/1120 = 0.949, 981/1020 = 0.962 — **both dimensions and the origin offset shrink by the
  same ~0.94**, i.e. a uniform scale about the origin, with the ratio varying between 0.94 and 0.98 from frame
  to frame (exactly because the window size is changing mid-drag).
- **It does not break "unpainted residue"**: after the fix, the transient frames during a drag have **only 2
  colors** in the bottom-right (newly exposed) area, consistent with the same region of a steady-state frame
  (no seam, no garbage pixels) — the newly exposed area shows the stage background; the cost of 1:1
  presentation is just "a bit more background showing", not corruption.

**Note**: a slow scripted drag (~2 px per step) **cannot see** this defect — the per-step scale ratio is only
~0.3%, so it must be reproduced with a **user-speed** fast drag (this harness's `[px] [ms/step]` parameters).
Early sampling with `screencapture` + a slow drag "looked perfectly normal" for exactly this reason.

**Regression nail**: `test/unit/platform.ts`'s `unit: platform/PresentScale` (9 checks, spanning the two host
files); reverting both fixes to their pre-fix shape turns **5 of them red on the spot**. Probes:
`temp/resizeprobe/{fast.py,fastdump.py,measure.py,drive.py,drag.py}`. The same defect on Windows is in
[`win32.md`](win32.md) §2.10.

---

### 6.8 The drawable must be allowed to be sampled as a texture (advanced blend modes, stage one-hundred-sixty)

**Symptom**: the AOT build of the AcmeApp desktop app (`acme-app`) shows **large magenta regions** on
its home page (`(255,0,255)`, or `(117,20,124)` where the app's own dimming scrim covers it): the whole
background band under the toolbar and the gaps between the cards, while the cards, icons and text themselves
render correctly — in **every** frame, as soon as the cursor moves inside the window (and also when the window
is inactive, just dimmed). `adl` never shows it.

**Root cause**: AS3 `DisplayObject.blendMode` becomes a Skia paint blend mode (`sk_paint_set_blend` in
`skia_glue.cc`, applied by the generated `as_skia_canvas_save_layer_paint(canvas, bp)`, see `emit.ts`).
Everything except `add` (`kPlus`) and `layer` (`kSrcOver`) — `darken`/`multiply`/`screen`/`lighten`/
`difference`/`overlay`/`hardlight` — is an **advanced blend mode** in Skia: fixed-function blending cannot
express it, so Ganesh has to **read the destination back as a texture** and blend in a shader. On the Metal
backend that destination is the **CAMetalLayer drawable** we wrapped, and a CAMetalLayer's drawables default to
**`framebufferOnly = YES`** — a write-only storage mode that **forbids being used as a shader input**; when
forced, Apple GPUs answer with **uninitialized memory**. The AcmeApp home-page skin carries a
`BlendMode.DARKEN` (baked from the SWC `PlaceObject3` BlendMode tag) whose clip covers the whole canvas, so
that layer composites the garbage it read back (magenta) over the **entire window** with SrcOver semantics;
whatever is drawn afterwards (cards, icons, dialog) simply lands on top — which is exactly the observed
L-shaped / fragmented shape.

**Fix**: `l.framebufferOnly = NO;` (`sk_mtl_init` in `metal_glue.mm`, right next to `pixelFormat`/`colorspace`).
The cost is a slower drawable *allocation* (not a per-frame cost); what it buys is the correct declaration that
this render target may be read as a texture — the documented requirement for any dst-reading pass.

**Why it must stay pinned**: it is not "unused configuration" — deleting it breaks no build and turns no unit
test red, it just makes **any** app using one of those 7 modes render a fully magenta screen (`add`/`layer` are
spared because they never read the destination, which is also why earlier acceptance runs never caught it:
the Starling demo and every `examples/` program used none of them).

**Measurements** (`temp/acme-mac/`, diff D26):

| Step | Result |
|---|---|
| Home-page capture (product binary, pre-fix) | background `(117,20,124)` (magenta under the dimming scrim), reproducible every frame |
| Add only `framebufferOnly = NO` (no drawing code touched) | same boot state, same dialog scrim: that pixel becomes `(128,128,128)` (dimmed white) |
| Strict criterion (`min(r,b)>70 && 2g<min(r,b)`) over the whole window, **excluding the app's own FPS/MEM/MAX overlay** (its `MAX:` is deliberately pink; device px x 296..404 / y 70..150) | hit in every frame pre-fix; **0 px** post-fix |
| 15-point hover sweep (activate window → move cursor → `screencapture -l`) | **0/15 frames contain magenta** post-fix |
| How it was localised | bisect on the `saveLayer` paint's **blend mode**: degrading advanced-blend layers to a plain `save` (`ASC_DEBUG_NO_BM_LAYER`) removed the magenta while plain `kSrcOver` layers (colour matrix / filters) stayed ⇒ only dst-reading layers trigger it; the pre-existing `ASC_MTL_READBACK` hook then proved the magenta was already inside the drawable (not introduced by the window server's compositing) |

**Regression nail**: `unit: platform/DrawableReadable` in `test/unit/platform.ts`. **Whether Windows shares this
defect is unverified** (no Windows machine here; how Skia reads a D3D12 flip-model swapchain buffer was not
measured) — registered in `TODO.md`.

---

### 6.9 LOCAL PATCH: CoreText switches faces between two font files that share family + PS name (stage 167)

> **In one sentence**: `vendor/skia/lib/macos-arm64/libskia.a` is **not** the upstream prebuilt — it is
> built from `build-tools/skia-src` (a full m124 source tree) with the local patch
> `vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` applied. Reproducing on another
> machine/CI requires applying that patch first, otherwise fonts like 微软雅黑 silently paint the wrong
> characters. Patch list + rebuild steps: `vendor/skia/patches/README.md`.

**Symptom** (AcmeApp's 「创建同传」): the same source renders `创建同传` under `adl 51.4.1` but
`初开名伤` on our side; **ASCII/Latin is untouched and so are other CJK families** (PingFang SC,
华文细黑) — only family `微软雅黑`, and only on a machine that has that particular pair of files.

**Root cause** (after ruling out the layers beneath it; evidence in `temp/tfswc/{ctprobe*,skgl,skdata}.mm`):

1. `~/Library/Fonts/` ships both `微软雅黑.ttf` (Regular) and `微软雅黑粗体.ttf` (Bold); **both files
   declare** family `Microsoft YaHei`/`微软雅黑` and PS name `MicrosoftYaHei`, and both have 29126
   glyphs — but their **glyph order diverges at index 110** (`sfthyphen` vs `uni00AD`), so Regular's
   `创=1259 / 建=1679 / 同=1379 / 传=1134` shift by one in Bold into `1258/1678/1378/1133`, while
   ASCII ids agree exactly (space=3, `A`=39, `C`=41, `a`=71). That is why **CJK is garbled while Latin
   is pixel-perfect**: with the wrong face, every CJK gid paints the *next* character.
2. Shaping and cmap are correct: `SkTypeface::textToGlyphs`, HarfBuzz (from file bytes and from
   CoreText tables alike) and `SkShaper` all return the right ids `1259 1679 1379 1134`.
3. The **rasterizer** is where it goes wrong: `SkScalerContext_mac` rebuilds a per-size CTFont through
   `SkCTFontCreateExactCopy(baseFont, size, opsz)`, which passes an **attributes-only** descriptor
   (`CTFontDescriptorCreateWithAttributes`). **Given a non-NULL descriptor,
   `CTFontCreateCopyWithAttributes` re-resolves the face by family** and, with two same-family /
   same-PS-name files installed, picks the *other* file (`kCTFontURLAttribute` becomes
   `微软雅黑粗体.ttf`; a copy with `descriptor == NULL` stays Regular). Adding attributes
   (`NSCTFontOpticalSizeAttribute`, `NSCTFontUnscaledTrackingAttribute`, even merging the base's own
   attributes back in) does **not** pin the face.
4. Corroboration: a bare-Skia probe shows `SkFont::getPath(1259)` has the **Bold** face's width
   (`Bold 1259 = 0.23/14.80`), while a face created straight from **file bytes**
   (`SkFontMgr::makeFromData(微软雅黑.ttf)`) draws it correctly (`14.578`) — data-backed faces survive
   this copy.

**Fix** (~20 lines in `SkCTFontCreateExactCopy.cpp`): after the copy, compare `kCTFontURLAttribute`
and, **if the file changed, copy again without a descriptor** (keeping the base face):

```cpp
static bool sk_fonts_share_file(CTFontRef a, CTFontRef b) {          // no URL either side => "same", never interfere
    SkUniqueCFRef<CFTypeRef> ua(CTFontCopyAttribute(a, kCTFontURLAttribute));
    SkUniqueCFRef<CFTypeRef> ub(CTFontCopyAttribute(b, kCTFontURLAttribute));
    if (!ua || !ub) return true;
    return CFEqual(ua.get(), ub.get());
}
...
SkUniqueCFRef<CTFontRef> copy(CTFontCreateCopyWithAttributes(baseFont, textSize, nullptr, desc.get()));
if (copy && !sk_fonts_share_file(baseFont, copy.get()))
    return SkUniqueCFRef<CTFontRef>(CTFontCreateCopyWithAttributes(baseFont, textSize, nullptr, nullptr));
```

**Why Skia and not the glue layer**: a face is resolved along several paths — `SkParagraph`'s
`FontCollection::matchTypeface/findTypefaces`, the line-metric helpers (`sk_air_line_metrics`) and the
legacy `drawString` path. Intercepting in the glue (e.g. `makeFromData` inside `sk_match_typeface`, or
wrapping a `SkFontMgr`) either misses paragraph's second resolution or costs a hundred-line proxy
class; pinning it in `SkScalerContext` fixes **all** paths at once.

**Boundaries**: macOS/iOS only (`SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS`), so the **wasm/Windows
libraries are unaffected**; the patch only fires when the file really changed, so fonts with a single
backing file (Helvetica, PingFang SC — measured) behave **byte-for-byte as before**; the cost is the
lost `tracking/opsz` attributes for that family (only noticeable with a `trak` table), paid for a
stable face.

**Verification** (same-source two-sided probe `temp/tfswc/`: `BitmapData.draw()` + `getPixels()` raw
ARGB, one `Main.as` run under both our build and `adl`):

| case | family | ink-mask IoU (vs `adl`) |
|---|---|---|
| plain `TextField` 16px | 微软雅黑 | **100.00%** (wrong glyphs before the fix) |
| plain `TextField` 16px | Microsoft YaHei | **100.00%** |
| plain `TextField` 16px | 华文细黑 | **100.00%** |
| plain `TextField` 16px | PingFang SC | 97.24% (antialiasing coverage, not wrong glyphs) |
| SWC skin text (`aisubtitlehomeskin…label1`) | 微软雅黑 | glyphs correct (`创建同传`); pixel deltas come from that child's dump origin |

**Regression pin**: `test/unit/build.ts`, group `unit: build/SkiaLocalPatch` (guards **provenance**: the
patch file exists, carries both halves of the fix, targets `SkCTFontCreateExactCopy.cpp`, and is
referenced by this document — a binary's internals cannot be asserted, so the pin only protects "the
patch was not quietly lost"). **Reproducing the defect needs the two same-family fonts installed on the
machine** (CI machines do not have them), so no example assertion is provided; the measurements live in
`temp/tfswc/`.

---

### 6.10 The frame boundary must reset the canvas state (stage 185; a real app whose "picture grows")

The window compositing canvas **outlives a frame** (on the GPU path it is one reused `SkCanvas` per
back buffer), and `ASC_window_render` is written as `save()` -> `scale(w->scale)` -> ... -> `restore()`.
**When AS3 throws, longjmp unwinds through the renderer and skips those C-level `restores`**, so one
`save` plus one device `scale` stay on the canvas; the next frame scales an already-scaled canvas and the
damage **compounds frame over frame**. Measured on a real application (frame-start
`getSaveCount()` / `getTotalMatrix()`):

| Frame start | Base matrix scale | Effective content scale |
|---|---|---|
| pristine | `depth=1` / 1.0 | 1.5 (device scale only -- correct) |
| after a boot exception | `depth=2` / 1.5 | 2.25 |
| after one more | `depth=3` / 2.25 | **3.375 = 1.5^3** |

Pixel ruler (`Fps` draws exactly 70x100 DIP): 105x150 px when correct, 236x337 px (~2.25x) when broken --
and the **whole window** grows (HUD, SWC skin, login page), which is what separates this from a scaled
display-list node. Rule the display list out first: every `scaleX/scaleY` and every `transform.matrix` was
1 (dumped per level for `self`/`LoginView`/`stageView`/`Stage`/`skin`), `w->scale` stayed 1.5, and the
per-object enter/exit CTM comparison showed **0 mismatches** -- yet the picture was scaled, so the scale
lives in the canvas state itself.

Fix: `sk_canvas_reset()` = `restoreToCount(1)` + `resetMatrix()`, called in `ASC_window_render` after
`ASC_window_apply_stage_size` and **before this frame's own `save()` and device scale** (the order is the
whole point -- resetting after the scale would throw the device scale away). Restores are balanced inside a
frame, so on a clean frame this is a no-op; what it guarantees is that **no frame is ever contaminated by
the previous one**. An exception still ruins only the frame it lands in (matching AIR: an uncaught error
aborts the rest of that frame), and the next frame is pristine. The fix lives in the EMITTED code, so it is
backend-agnostic (Metal / GL / D3D12 / raster share it; builds without a canvas API get a no-op stub).
Source-level pin: `unit: render/FrameCanvasHygiene`.

## 7. Multi-target: native and wasm

- **native**: Skia statically links `libskia.a` (CPU raster), producing Mach-O/ELF/PE.
- **wasm (browser, `--target wasm --package web`)**: Emscripten compiles Skia + the glue layer into a wasm32
  static library (`vendor/skia/lib/wasm/`), and emcc links it into `.wasm` + `.js` + `index.html`.
  The font backend switches from CoreText to `SkFontMgr_New_Custom_Data()` (runtime font-data injection), and
  the window layer switches from SDL2 to canvas + `requestAnimationFrame`. Implementation and constraints are
  detailed in [`html5-web.md`](html5-web.md).
- **wasm (WASI, `--target wasm --package raw`)**: still a GUI-less command-line `.wasm`, with no rendering.

> The path of "adapting Skia with the WASI toolchain" was once evaluated (Skia's official wasm targets
> emscripten/CanvasKit, and WASI adaptation is costly). It has now switched to using emscripten to produce
> browser artifacts directly, bypassing WASI adaptation: `--package web` is end-to-end verified (a blue
> rectangle + `TextField` text + runtime font injection, with no runtime crash).

---

## 8. Two-tier Plan for Text Rendering

`TextField` is the most complex part of the AS3 GUI, and Skia offers two tiers:

1. **Basic glyphs (`SkFont` + `SkTextBlob`)**: given a font/size/color, draw a UTF-8 string at a given baseline
   position. **Does not support automatic wrapping, alignment, or paragraphs**. Suited to the first-phase
   implementation of "single-line text / simple labels".
2. **Full typesetting (SkParagraph, `modules/skparagraph`)**: supports line breaking, left/right alignment,
   character spacing, multiple paragraphs, and rich-text styles. Corresponds to AS3 `TextField`'s
   `wordWrap`/`multiline`/`textWidth`/`textHeight`/`autoSize`/`htmlText`.

**Decision revision (stage thirty-eight → the v0.3.73 upgrade)**: stage thirty-eight initially used
**`SkFont` measurement + self-built greedy wrapping** (`runtime.ts`'s `as_text_wrap`) to get multiline working,
reasoning that SkParagraph's UAX#14 line breaking diverges from AIR's `wordWrap` semantics. It was later
upgraded in v0.3.73 to **SkParagraph (`modules/skparagraph`) full typesetting**, because:

- Self-built greedy wrapping measures each word with `SkFont` and recomputes every frame with no cache, so both
  performance and correctness (approximate line height `size × 1.2`, no shaping) are limited; SkParagraph does
  one HarfBuzz shaping pass + UAX#14 line breaking, and `getHeight()`/`getLongestLine()` provide the real line
  height and textWidth, with paragraph-level alignment/character spacing naturally available.
- The semantic divergence converges to two edge cases: SkParagraph breaks at overlong words/hyphens, whereas
  AIR's `wordWrap` breaks only at spaces and lets an overlong word overflow whole; CJK breaks character by
  character identically in both. These are recorded as known limitations in comments/docs.
- **A third divergence (found in stage eighty-nine / twenty-eight, fixed in stage eighty-nine / sixty-six) — the
  line-break threshold was 4px short of the padding**: with the same size/font the two have **perfectly
  identical per-word ink widths** (measured in the Starling demo's `TextFields` scene, third field: the ink
  widths of the five words `... or centered. Embedded fonts` are 25/32/154/178/81 px on both AOT/AIR, and the
  word spacing matches too); the difference is only **in the break point itself**: the Skia side's 6-word line
  is 591 px wide (typeset against the field's 600 px), so it leaves `are` on the first line, whereas AIR breaks
  at 5 words.
  At the time this was attributed to "AIR counts **trailing spaces** into the candidate width" — **that
  attribution was wrong**. Stage eighty-nine / sixty-six did a controlled scan (`temp/tfwrap/`, the same set of
  TextFields scanning only the field width, reading `numLines`, where the first width with `numLines == 1` is
  the threshold):

  | Text | AIR threshold | before fix | after fix |
  |---|---|---|---|
  | `"Multitouch"` (no space) | 129 | 125 | **129** |
  | `"Multitouch "` (1 trailing space) | 129 | 125 | **129** |
  | `"Multi touch"` (inter-word space) | 138 | 134 | **138** |
  | `"Multitouch  "` (2 trailing spaces) | 129 | 125 | **129** |
  | `"Multitouch Multitouch"` | 263 | 259 | **263** |
  | `"Multitouch  Multitouch"` | 271 | 267 | **271** |

  Present-or-absent/how-many trailing spaces **does not affect AIR's threshold at all** (all three tiers of
  0/1/2 trailing spaces give 129), so "trailing spaces" is not the cause.
  The real cause is that the **available width must subtract AIR's 2px padding**: the threshold is always
  `ceil(ink + 4)` — `124.945+4→129`, `133.383+4→138`, `258.328+4→263`, `266.766+4→271`, hitting **every one of
  the six values**. Before the fix we typeset against the un-padded field width, so we were one word late at
  the boundary.
  This 4px is not a new convention: `autoSize` (`width = textWidth + 4`, **only when `wordWrap=false`**;
  with `wordWrap=true` the width stays put and only the height follows — see §8.2) and `maxScrollH`
  (`over = textWidth + 4 - width`) were already written against it; **only the line-break threshold was missed
  the subtraction**. The fix is in stage eighty-nine / sixty-six, and `test.ts` has a `[textwrap]` structural
  nail.
  > Another note: for text with trailing spaces, `textWidth` includes the trailing spaces in AIR
  > (`"Multitouch "` = 133), while ours does not (always 124.945).
  > This is **another** independent contract difference that **does not affect line breaking** (see the table
  > above), and it is recorded in `TODO.md`'s leftover table per §1.5.
- AIR's `maxScrollV`/`scrollV` are "viewport line" semantics (`numLines - visibleLines + 1`, with
  `scrollV = maxScrollV` pinning the latest line to the bottom), still computed by the runtime layer;
  SkParagraph only handles "typeset" and "draw", consistent with the §2.9 iron rule.
- Likewise there is **no self-built rasterization**: shaping/line-breaking/drawing are all handed to
  SkParagraph, and the only self-built part is the "cache-invalidation key" layer.

SkParagraph's rich-text capabilities (`htmlText`, multi-`TextFormat` interval styles, alignment/character
spacing/multiple paragraphs) have all landed: `htmlText` parses a subset of
`<font>`/`<b>`/`<i>`/`<u>`/`<p>`/`<br>` and produces a run list of "byte interval + `TextFormat`", and
`setTextFormat` appends runs by the same mechanism; `sk_textlayout_new_runs` does `pushStyle`/`addText`/`pop` in
run order, with the gaps between runs falling back to the paragraph default style (= `runs[0]`'s font/size,
color from `defaultTextFormat`). `autoSize`/`hscroll`/`selectable`/`leading` have also landed, with
assertion-style regressions in `examples/textrich.as` (`examples/textflow.as` is the layout baseline).

### 8.2 `autoSize` sizing contract and the fallback face for an uninstalled family (stage 168)

Both live in the text layer (`vendor/skia_glue.cc` / `src/emit.ts`), and both were pinned against the
`adl 51.4.1` same-source dual-end probe (`temp/tfswc` cases 6/7/8/9/10; after the fix the AOT report is
**byte-identical** to `adl`'s).

**① With `autoSize != "none"`, the width only follows the text when `wordWrap=false`.** Measured:
`wordWrap=true` keeps the width the user set (290 for both a short run and a 3-line run) and only sets
`height := textHeight + 4`; `wordWrap=false` sets `width := textWidth + 4` in **both** directions
(290→28 for "中文", 100→523.5 for a long run). The old code unconditionally wrote
`width = longest line of the already-wrapped layout + 4`, which is a **self-reinforcing loop**: a narrower
field shortens the longest line, the shorter line narrows the field again, and every repaint shrinks it once
more (measured 290 → 64.66 → 50.66 → 36.66 → 32). That is what broke the `title` of the AcmeApp AI
subtitle list item: it wrapped into three lines and ran over the `ctime`. One more observable point: `adl`
reports the new box **right after assignment, with no draw in between** (`autoSize=LEFT` then `h=18`), so the
generated `as_do_extents` (where both the `width` and `height` reads land) calls `as_tf_apply_autosize` too.

**② An uninstalled family means the platform default face's line box, not the box of whichever CJK face
supplied the glyphs.** `adl` measures a 16px line box of **16px** for both `MiSans Regular` (absent locally;
shipped only inside the app bundle, and **AIR does not register app fonts**) and `宋体` — exactly Helvetica's
box. `SkFontMgr::matchFamilyStyle` returns **NULL** for those names, so SkParagraph sized the line from the
CJK cascade (PingFang/Songti SC, 1.4 em → 22px at size 16). `sk_family_alias` therefore checks whether the
family is installed at all and substitutes the `matchFamilyStyle(nullptr)` family name (Helvetica on macOS),
cached, so the strut and the runs both land on one face.
> This is **user visible**: the list item was 6px taller than `adl` and pushed `ctime.y` down. Note it is
> **not** evidence for registering app fonts: `adl` cannot see that bundled `MiSans-Regular.ttf` either, so
> registering it would move us away from the oracle.

Regression: `examples/autosize-metrics.as` (behavioural assertions, links Skia) +
`unit: display/AutoSizeMetrics` (generated-C / glue structural nails, reverse-mutation verified).

### 8.3 Metrics and glyph normalisation for a scaled field (stage one-hundred-sixty-nine)

When a field's CTM carries a **non-uniform** scale (common with SWC placements — e.g. the AcmeApp subtitle
skin's `ctime` child is `scaleX = 1.2246, scaleY = 1`), `adl`'s contract differs from ours in **two** places.
Both were pinned against the `adl 51.4.1` same-source dual-end probe (`temp/tfswc` cases ⑯⑯b⑯c⑰b, size 12,
nominal `166.00/12.00`):

| (scaleX,scaleY) | adl textWidth | adl textHeight | adl rendered ink width |
|---|---|---|---|
| (1.0000,1.0000) | 166.00 | 12.00 | 165.0pt |
| (2.0000,1.0000) | 83.00 | 6.00 | 165.0pt |
| (1.0000,2.0000) | 332.00 | 24.00 | 329.5pt |
| (2.0000,2.0000) | 166.00 | 12.00 | 329.5pt |
| (0.5000,1.0000) | 332.00 | 24.00 | 165.0pt |
| (1.0000,0.5000) | 83.00 | 6.00 | 82.5pt |
| parent scaleX=2 | 83.00 | 6.00 | — |

**① Metrics: `textWidth`/`textHeight` = nominal × scaleY/scaleX — both extents divided by `scaleX`.** Not
"width by scaleX and height by scaleY": at `scaleY=2` the height **doubles** too (`24.00`) without being
divided by anything. The scale is the **accumulated** value over the object and every ancestor (a parent at
scaleX=2 halves a child field's numbers). In the generated C, `as_disp_chain_scale` multiplies the linear
parts down the `parent` chain in the same order as `as_bounds_xform`/`as_render_object`
(`T·R·S·transform.matrix`; translations cannot change a basis vector's length, so they drop out), and
`as_tf_scale_ratio` returns `sy/sx`.

**② Rendering: the glyphs are scaled **uniformly by the accumulated `scaleY`** and `scaleX` never widens
them (nor their advances).** Hence a field at `scaleX=2` inks **exactly as wide** as at `scaleX=1` (165.0pt),
while its **box** still follows scaleX (`width` = local width × scaleX). The implementation post-concatenates
`scale(sy/sx, 1)` onto the CTM in the TextField glyph pass: a non-uniform `M = R(θ)·S(sx,sy)·…` times
`S(sy/sx,1)` is exactly `R(θ)·S(sy,sy)·…`, i.e. the same rotation with a uniform scaleY. It **must** be
issued **after** the `clipRect`: Skia maps a clip through the CTM in force at clip time, and the visible box
*is* supposed to follow scaleX (stage 162's D29 was bitten by exactly that mapping). The ratio is read from the
**destination CTM** (`ASC_bake_ctm_*`, the same idiom as the 1px border), so:

- a normal window pass: the CTM carries the object's accumulated transform ⇒ ratio = accumulated `sy/sx`;
- a `cacheAsBitmap`/filter bake: the canvas only holds the bake resolution, and `ASC_bake_ctm_*` supplies the
  destination ratio;
- `BitmapData.draw(field)`: that path re-rasterises in **local** space, and `adl` measurably **ignores the
  source's own transform** in `draw()` (a scaleY=2 field dumps a **byte-identical** raster) ⇒ the ratio
  degrades to 1, which is exactly what that path needs.

Regression: `examples/tf-scale-metrics.as` (6 relative metric assertions + 3 ink-width assertions through
`draw(container)`, links Skia) + `unit: display/TfScaleMetrics` (10 nails, two reverse-mutation verified).

### 8.4 Windows per-character font fallback: GDI primary + DirectWrite fallback (stage one-hundred-ninety-one)

**GDI's font manager has no per-character fallback at all** -- `SkFontMgrGDI::onMatchFamilyStyleCharacter`
is an unconditional `return nullptr` (`build-tools/skia-src/src/ports/SkFontHost_win.cpp` ~2267), and Windows
has no system-wide cascade of the kind CoreText provides on macOS. SkParagraph asks the manager for a fallback
face for **every** code point the run's own face does not map, so when the field's family is a name GDI's family
table cannot match, the resolved face is the Latin-only default and the **whole field** paints as `.notdef` --
a block of identical boxes, not a stray glyph or two.

Measured (`temp/fntface/`, 8 TextFields, size 18, text `创建会议 abc 0123`, `Stage.render` to a PNG + trace):

| family | before textWidth/Height | after | before, pixels |
|---|---|---|---|
| `微软雅黑` | 153/16 | 153/16 | **4 `.notdef`** |
| `MiSans Regular` | 153.532/18 | 153.532/18 | fine (the app registers MiSans itself) |
| `Microsoft YaHei` | 157/20 | 157/20 | fine |
| `SimSun` | 153/18 | 153/18 | fine |
| `Arial` | 135/17 | 151/17 | fine |
| `NoSuchFamilyXYZ` | 153/16 | 153/16 | **4 `.notdef`** |
| `""` | 127/16 | 143/16 | **4 `.notdef`** |

The trigger is the **same family, different spelling** problem: this box reports `Get-WinSystemLocale = zh-CN`
but its **UI language is en-US**, so the 874 families GDI+ enumerates carry **English names only** -- there is
`Microsoft YaHei`, there is no `微软雅黑`. And the family the SWC's tag-37 text characters declare
(`createaisubtitleskin.title` / `stime` / `sourcetxt` / `targettxt` / `typetxt`, ...) is exactly `微软雅黑`.
That is the garble the user reported: the AI-subtitle window's card painted its first line, 创建同传, as four
`.notdef` glyphs; after the fix the same window at the same position renders 创建同传 normally (the other fields
use MiSans or other families and were never garbled).

**The fix: the Windows branch of `vendor/skia_glue.cc` becomes `SkAirFontMgr : public SkFontMgr`, GDI as
`fPrimary` and DirectWrite as `fFallback`, with only `onMatchFamilyStyleCharacter` allowed across.** The other
10 queries (`countFamilies` / `getFamilyName` / `createStyleSet` / `matchFamily` / `matchFamilyStyle` /
`makeFromData` / `makeFromStream{Index,Args}` / `makeFromFile` / `legacyMakeTypeface`) are forwarded verbatim to
GDI, so **a family that resolves today changes face in zero cases** (`MiSans Regular` / `Microsoft YaHei` /
`SimSun` are byte-identical before and after in the table above). DirectWrite answers through its own
`IDWriteFontFallback::MapCharacters` cascade -- the same one DirectWrite-based browsers use -- and only for the
"the face lacks this code point" query. `Arial` and `""` got wider because the CJK they never used to draw now
draws.

**Why not a full DirectWrite swap, and why not `SkOrderedFontMgr`:** an ordered manager lets DirectWrite answer
the **structured** (family/style) queries as well, and once a DirectWrite typeface reaches SkParagraph's
structured path the AIR strut / height-override machinery stops working -- that row measured
`textHeight = -Infinity` and painted nothing at all. Keeping GDI primary is what guarantees the
"already-resolving families stay byte-identical" half.

**No new link dependency:** Skia reaches DirectWrite through `LoadLibraryW("dwrite.dll")` +
`GetProcAddress("DWriteCreateFactory")` (`build-tools/skia-src/src/utils/win/SkDWrite.cpp`), so no `.build.json`
needs a `dwrite` entry and no manifest was changed. The block is inside `#if defined(_WIN32)`, so macOS and wasm
are untouched; this Windows-side change is **not covered by CI** (CI is macOS), so the local pixel A/B is the
only verification.

Regression: `unit: platform/FontFallback` (9 nails: the single crossing point / the 10 `fPrimary->` delegations /
the factory and its degradation / the macOS branch untouched / `SkOrderedFontMgr` excluded in reverse / both doc
mirrors).

### 8.1 `flash.text.StyleSheet` and HTML's **block-level** model (stage one-hundred-forty-eight)

`StyleSheet` was upgraded in stage one-hundred-forty-eight from a "reports but does nothing" shell into a **real class**
(`superClass: EventDispatcher`, reflect name `flash.text::StyleSheet`): `setStyle`/`getStyle`/`clear`/`styleNames`
all land, and it becomes the **rule source** for `htmlText` layout. The trigger was acme-app's FPS overlay
(`com.example.controls.Fps.as`), which puts `htmlText` plus a `styleSheet` on a `TextField` whose `multiline`
stays at its default `false`: AIR shows **four lines** (FPS / MS / MEM / MAX), we squeezed the four values onto one.

**The root cause is the block-level rule, not `<br>`.** Item-by-item measurement against `adl 51.4.1` (probes in
`temp/ssprobe/`, `temp/blockprobe/`, `temp/mlprobe/`, `temp/fpsprobe2/`) yields AIR's model, implemented as follows:

| Observation | AIR's behaviour |
|---|---|
| An unruled unknown tag (`<x>`, `<fps>`, `<memmax>`, ...) | **inline** (plain unstyled text, absent from `text`) |
| **Ruled** unknown tag | **block**: the break lands **after its closing tag** (break-after) and is **independent of `multiline`** |
| Tags AIR renders inline (`span`/`p`/`b`/`i`/`u`/`font`/`a`/`li`/`br`/`img`/`textformat`) | **never** become blocks -- not even with `display:block` |
| `display:inline` | **downgrades** an unknown tag back to inline |
| `display:none` | **hides** the element (and its text) |
| `<br>`, `</p>` | break only when `multiline == true` |
| Selectors | matched **case-insensitively**; `styleNames` reports the **lowercased** names |
| `setStyle` / `getStyle` | both **copy**: mutating the passed-in object leaves the rule table alone, and so does mutating what `getStyle` returns; `setStyle(name, null)` **removes** |

Implementation notes:

- The tag name is **lowercased** before the rule lookup (`as_ss_lookup`, keys are lowercase); `as_str_ieq` does the
  case-insensitive ASCII comparison with **zero allocation**, so no `toLower` allocation per tag.
- Style state is **stacked** (`st_face/st_size/st_color/st_bold/st_italic/st_under/st_block`, depth 32); a closing
  tag restores the enclosing level, matching AIR's scoped styling.
- "The break lands after the close" means the block's text is emitted first and the `\n` appended afterwards, with
  `tf->_html_block = true`. This is what makes a **single-line** field honour that break: Skia collapses `\n` to a
  space in a single-line field (`collapseNewlines`), whereas AIR breaks anyway for a rule-driven block. So
  `as_tf_paragraph` uses `collapse = (tf->multiline || tf->_html_block) ? 0 : 1` -- a **raw `\n` still collapses**
  in a single-line field (measured); only a rule-driven block break is exempt. `_html_block` is a C-side `bool`
  with no GC pointer, so it is deliberately **not** in the reflection table.
- Declaration values flow through `as_ss_str` (CSS numbers take their numeric part, colours only `#RRGGBB`) into the
  existing run machinery: `color`/`fontSize`/`fontFamily`/`fontWeight`/`fontStyle`/`textDecoration`. Note that
  `as_ss_str` reuses a **static buffer**, so the `display`-derived `hidden`/`noinline` must be read **before** any
  other `as_ss_str` call.
- The FPS overlay sets no `defaultTextFormat`, so `as_tf_paragraph` supplies an implicit `TextFormat` (`_sans`/12/black)
  when none is set.

**Measured but not yet aligned** (logged in `TODO.md`, not prettified): multi-line run **height** is ~1.5x too tall
(the same htmlText reports `h=45` for us against AIR's `30.1`, while line counts and widths match value-for-value);
`leading` coming from a rule is not applied per run; `numLines` semantics (AIR counts a trailing empty line) still
follow our reading. `StyleSheet.parseCSS` / `transform` are **deliberately unimplemented** -- calling them is a
**loud** `undefined method` compile error rather than silently accepting CSS AIR would have parsed.


**Two semantic details aligned with AIR (fixed in stage eighty-nine / twenty-eight)**:

1. **`.text = ...` replaces the entire content**: AIR's `.text` assignment discards runs previously loaded by
   `htmlText`/`setTextFormat`, and the new text is typeset only per `defaultTextFormat`. Early AOT modeled
   `text` as a bare field (a direct struct write), so the run list could linger — and Starling's
   `TrueTypeCompositor` **reuses the same static native `TextField`** (`sNativeTextField`), so after one field
   had used HTML rich text, **all** subsequent plain-text typesetting would replay those runs (measured: the
   demo button label `Back` went from 29 px high to 38 px high, and did not recover after switching scenes).
   Now `text` keeps its field slot (reads are still `tf->text`) **and** registers a setter:
   `TextField_set_text` clears `_runs` and releases the `_para` typesetting cache before writing (see
   `src/symbols.ts`'s `TextField` setters and `src/emit.ts`'s `TextField_set_text`).
2. **Single/double quotes in attribute values are equivalent**: AIR's HTML subset allows both
   `color='#ff0000'` and `color="#ff0000"`. Early parsing recognized only `"`, so a single-quoted value was
   taken **starting from the quote itself**: `size='30'` was read by `atof` as 0 and fell to the 1.0 lower
   bound, and `color='#208080'` was read by `as_tf_html_parse_hex` as `2080`, giving a wrong dark blue (in the
   Starling demo `basic` showed as green and `HTML` as cyan).
   Now `as_tf_html_attr_value(s, out, cap)` delimits by "the opening quote kind" (and supports unquoted bare
   values).

**Fonts and line height aligned with AIR (stage ninety-four / twenty)**: `textWidth`/`textHeight`/`numLines`/
cursor geometry are all derived from SkParagraph's layout result, so "which face is used" and "how tall the
line box is" directly determine every typesetting number. Both were inconsistent with AIR before the fix, and
are now aligned value by value per `adl 51.4.1` measurement (evidence bench `temp/metricprobe/`, with the input
matrix and both sides' output inside).

**(1) The three device font aliases must be translated into real faces.** AS3's
`_sans`/`_serif`/`_typewriter` are not font family names but generic aliases the Flash runtime must **resolve
itself**; CoreText does not recognize `_typewriter`, and passing it through as-is to SkParagraph **silently
falls back to the system default proportional font** — a `_typewriter` field measuring 10 `W`s gives 113.26 px
instead of 72 (the monospace face rendered as proportional, a 40% glyph-width difference).
Faces are chosen per adl-measured **glyph widths** (the table below shows 10-character ink widths, adl /
ours):

| family | 10×W | 10×i | 10×* | 10×space | adl line height / ours |
|---|---|---|---|---|---|
| `_typewriter` | 72 / 72.01 | 72 / 72.01 | 72 / 72.01 | 72 / 72.01 | **15 / 15** ✓ |
| `_sans` | 113 / 113.26 | 26.5 / 26.66 | 46.5 / 46.70 | 33 / 33.17 | 15.5 / 12 ✗ |
| `_serif` | 113 / 113.26 | 33 / 33.34 | 60 / 60 | 30 / 30 | 15 / 13 ✗ |
| *(empty string)* | 113 / 113.26 | 33 / 33.34 | 60 / 60 | 30 / 30 | **12 / 12** ✓ |
| Courier / Courier New | 72 / 72.01 | — | — | — | **12 / 12**, 13.5 / 14 |
| Menlo / Monaco | 72 / 72.25, 72.01 | — | — | — | **14 / 14**, **15 / 15** |
| Helvetica / Arial | 113 / 113.26 | 26.5 / 26.66 | 46.5 / 46.70 | 33 / 33.17 | **12 / 12**, 13.5 / 13 |
| Times New Roman / Geneva | 113 / 113.26, 113.5 / 113.61 | 33, 28 | 60, 60.5 | 30, 40 | **13 / 13**, **15 / 15** |

Mapping table: `_typewriter` → `Monaco`, `_sans` → `Helvetica`, `_serif` → `Times New Roman`, empty/`null` →
`Times` (AIR reads an empty font family back as `"Times Roman"`, and its midline height 12 matches Times's 12
value by value, not Times New Roman's 14).
Named fonts are always **passed through as-is** — they already match value by value (the bolded items in the
table). Alias translation and face lookup are both done in the glue (`sk_family_alias()` /
`sk_match_typeface()`, the latter cached by `(family, bold, italic)` to avoid rerunning CoreText's family-table
scan every paragraph), and **every** `setFontFamilies` path (the flat field, a field with
`TextFormat.leading`, htmlText multi-run) goes through it, with `test.ts`'s `[fontmetrics]` having a reverse
nail "leave no untranslated pass-through".

**(2) The line-box height is forced per AIR's model.** AIR **rounds each of the line box's upper and lower
halves to 0.5** and **does not use the font's own line gap at all**; Skia reports the `ceil`-style
(ascent + descent + lineGap). Monaco's gap is 1.002 px, so the same 12 px line is 15 in AIR and 16 in Skia. Our
AIR-aligned model is:

```
line height h   = round_half(ascent) + round_half(descent) + leading      (leading in px)
field textHeight = numLines × h − leading            (numLines ≥ 2)
                 = h                                 (numLines = 1)
```

The second line is AIR's **last-line quirk** (measured: with `TextFormat.leading = 4` and a line-box step of
19 px, 1/2/3/4 lines report 19 / 34 / 53 / 72 respectively — **the last line's leading is not counted**, while
inter-line leading applies as usual). In implementation you cannot rely on Skia's own line height:
`sk_set_air_strut()` installs a **height-override strut** on each paragraph, making Skia scale the face's
ascent/descent to AIR's box by that factor; there is a counter-intuitive point here — Skia's factor denominator
is `ascent + descent + lineGap` (`rawFull`) while the box **does not include** the gap, so the height must be
**pre-multiplied by `rawFull / rawSum`**, otherwise every forced line box comes out exactly one line gap short
(measured 14 instead of 15).
Negative leading takes a separate path: Skia **clamps `StrutStyle::leading < 0` to 0**, so `leading = -3`
(AIR's box 15 → 12) folds into the height, and only positive leading is leading; `test.ts` has a nail for each
of these two.

**(3) `TextFormat.leading`'s unit is px.** Before the fix, `leading` was passed to Skia as an em multiple
(`setLeading(leading)` × fontSize ⇒ a 12 px value amplified 12×, a 1-line field reporting 60+ px). Now the px
value goes into the model as-is, and for a 12 px font with `leading = 4` the four tiers (1..4 lines) match adl
**value for value across all 12 numbers** (19/34/53/72 and the negative values 12/27/39/51).

**The remaining divergence (recorded honestly, not papered over)**: the line heights of the two **generic
aliases** `_sans` / `_serif` still do not match (we compute 12 / 13 from the alias face, AIR reports 15.5 /
15). The reason is that AIR uses **its own device-font metrics table** for generic aliases, and that table is
**nonlinear** (measured: at 12 px `_sans` = 12.5+3, at 20 px 19.5+4.5; `_serif` at 12 px = 12+3, at 20 px =
17.5+5; `_typewriter` at 12 px happens to equal Monaco's 12+3, but from 14 px on it diverges from Monaco) —
no parseable face can reproduce it. We **do not** hard-code a table interpolated between measured points
(that would claim unmeasured sizes as "measured"); we only keep the measured values for 9 tiers on the evidence
bench and register it as a leftover item in `TODO.md`. Likewise the line heights of `Courier New` / `Arial`
each have a 0.5 px residual (Skia's internal rounding direction for half pixels), also recorded.

> **Thinking of replacing this layout engine? Read [`rust-text-backend.md`](rust-text-backend.md) first** —
> that document evaluates, platform by platform, the pros and cons of swapping SkParagraph for a
> cosmic-text + swash static library, with the measured size account (the ICU data is **one indivisible
> 9.71 MB object**, and **an application that draws no text pays it too**), and explains why the
> conclusion is "do `-dead_strip` and `skia_use_icu4x` first; only touch the Rust backend for mobile
> plus a hard size constraint".

---

## 9. Image Decoding (`BitmapData.loadBytes` / `Loader`)

Skia's `SkCodec` (`include/codec`) + `SkImage::MakeFromEncoded` cover decoding PNG/JPEG/WebP/GIF etc.,
corresponding to AS3's `Loader`/`BitmapData.loadBytes` image loading. Decoding depends on
libpng/libjpeg-turbo/libwebp (§6.2).
The `ByteArray` binary runtime (`flash.utils.ByteArray`) is a prerequisite and is not yet implemented (stages
thirty to thirty-two only added pure-logic builtins, and `ByteArray` is still on the exclusion list), so image
decoding is scheduled after ByteArray.

### 9.1 The actual supported surface (measured) and SVG's separate channel

The "PNG/JPEG/WebP/GIF etc." written above has a **wider measured surface than expected**: both ends' Skia are
built with `skia_use_libwebp_decode=true` + `skia_use_wuffs=true`, and wuffs **also** covers BMP / ICO, so
`SkCodec` is capability-wise **PNG / JPEG / GIF / BMP / WebP / ICO — six formats**, all going through the same
`SkImages::DeferredFromEncodedData` → `SkCodec` (measured in stage eighty-nine / sixty-three, consistent on
both ends).
**QOI is not included** — `SkQoiCodec` is not built in (`args.gn` has no `skia_use_qoi`).

**But `Loader` by default only decodes the three AIR supports** (since stage ninety-four / twenty-five):
BMP/WebP/ICO are formats beyond AIR (`adl` reports `#2124`), so the default build **blocks them at the glue
layer by magic number** (together with the TIFF-family camera RAW/DNG) — after blocking, they take the upper
layer's existing `#2124` failure path, with an error verbatim identical to `adl`. To let them through you must
explicitly enable `--features formats` (BMP/WebP/ICO, available on both ends) or `--features raw` (camera
RAW/DNG, native only) — see [`compile.md`](compile.md) §3.4.3.1 and [`enhancements.md`](enhancements.md)
§4.3/§4.5.
`WBMP` (`SkWbmpCodec` is built in) is **deliberately not blocked**: its header is a bare multi-byte type field
with no reliable magic number.

**SVG is the sole exception, with its own channel** (stage eighty-nine / sixty-five, native, opt-in; enabled by
the named switch `--features svg`, i.e. defining `ASC_USE_SVG`, see [`compile.md`](compile.md) §3.4.2):
SVG is **not a `SkCodec` format**, and `DeferredFromEncodedData` necessarily returns null for it, so at all four
decode entry points (`sk_image_from_file` / `sk_image_from_bytes` / `sk_image_decode_argb` /
`sk_image_decode_bytes_argb`) it is a **fallback "after codec failure"**:

```
SkSVGDOM::Builder().setFontManager(sk_platform_fontmgr()).make(stream)
→ setContainerSize(the document's own size, defaulting to the spec default 300×150)
→ SkSurfaces::Raster(N32/premul) + clear(TRANSPARENT) + render → SkImage / ARGB
```

Two key points: **without `setFontManager`, not a single `<text>` glyph is drawn** (measured glyph pixels 97 →
0); and **the wasm side has no `libsvg.a`/`libsksg.a`/`libexpat.a`** (`skia_use_expat=false` gates out the
whole svg target), so web does not support SVG, and defining the macro is a link-time error. The default build
does not contain the macro, with behavior verbatim isomorphic to AIR (`#2124`).

### 9.2 The display SkImage and the bytes it was decoded from share one lifetime (stage 154)

A `Bitmap` in the display list is painted **only from `bd->image`** (the SkImage view); `bd->pixels`
(the CPU buffer) does not take part in drawing. On the `Loader.loadBytes` path `bd->image` is built
from **the encoded bytes carried by the same job**
(`as_skia_image_from_bytes(as_job_bytes(job), as_job_len(job))`) — there is no file to re-open by
name and no URL to fall back on. So as soon as the job's `AS_JOB_DECODE` branch freed the payload
right after decoding and nulled `bytes/len` (the comment said "only needed to decode"), `bd->image`
stayed `NULL`: `bitmapData.width/height` and `getPixel32` were **all correct** (the pixels really
were decoded) and the screen **painted nothing**, without any error.

AcmeApp's login captcha takes exactly this path (the server returns `data:image/jpeg;base64,...`,
the app runs `Base64.decodeToByteArray` and then `Loader.loadBytes`): after the request started
succeeding the captcha slot stayed blank while `adl` showed the image. It was localised by
**temporarily instrumenting the app** (`content=[object Bitmap]`, `bitmapData 100x50`,
`getPixel32(1,1)` non-zero, `numChildren=1`, `parent/onStage` both true), which separates "the image
was obtained" from "the image was painted" and lands on the job payload's ownership.

**Rule**: both `AS_JOB_IMAGE_URL` (an image fetched over http) and `AS_JOB_DECODE` (a `loadBytes`
payload) **must keep their encoded bytes until `as_job_retire`**; only `AS_JOB_IMAGE` (a local file)
may release them right after the decode, because its display view is re-opened **by file name**
(`as_skia_image_from_file`). Pinned by `unit: transport/JobOwnership` (three checks); the ownership
table is in [`gc.md`](gc.md).


---

## 10. Relationship with TODO.md Stages + Suggested New Rendering Stages

The existing plan (stages thirty-three to thirty-five) is "events + display list + hit testing", and rendering
has always been a placeholder. What this file fills in is the **pixel rendering** segment. It is suggested to
add after stage thirty-five:

| Suggested stage | Goal | Content |
|---------|------|---------|
| **stage thirty-six** | v0.3.36 | **Skia glue layer + build integration**: introducing `vendor/skia`, a minimal `extern "C"` surface for `skia_glue.cc` (surface/canvas/paint/path/color/matrix), `build.ts` supporting `.cc` compile driving and `-lskia` linking, `as_skia_*` runtime helpers, and an end-to-end demo of offscreen CPU raster output to PNG |
| **stage thirty-seven** | v0.3.37 | **`flash.display` rendering landing**: `Shape`/`Graphics` → `SkPath`+`SkPaint` (fill/stroke/gradient), `Bitmap`/`BitmapData` → `SkImage` (including `setPixel/getPixel/draw`), `DisplayObject` transforms (translate/rotate/scale/alpha/blendMode), recursive rendering + depth order |
| **stage thirty-eight** | v0.3.38 → v0.3.73 | **`TextField` text rendering**: single-line `SkFont` + `drawString` direct drawing, `TextFormat` styles (font/size/color/bold/italic); multiline typesetting first via self-built greedy wrapping (v0.3.45) then upgraded to SkParagraph (v0.3.73, the `sk_textlayout_*` bridge, HarfBuzz shaping + UAX#14 line breaking + real line height + caching), `clip` clipping, `numLines`/`maxScrollV`/`scrollV` viewport math; fixing the multiline first-frame hang caused by `sk_font()` rebuilding the CoreText FontMgr every time |
| **stage forty-four** | v0.3.45 | **Retina high-DPI rendering**: `ASC_DISPLAY_HIGH` goes through `ALLOW_HIGHDPI` + a drawable probe, the surface is created at physical pixels, and the texture is presented 1:1 with no resampling |

> Stage thirty-six is the key chokepoint of "hooking up Skia": it verifies "the generated C can call Skia
> through the glue layer and produce correct pixels". It is suggested to first make it a **minimal viable
> closed loop** (draw a `Shape`'s rectangle → output PNG → assert pixels), then roll out stages thirty-seven/
> thirty-eight.

---

## 11. Risks and Boundaries

| Risk | Note | Mitigation |
|------|------|------|
| **Build complexity** | Skia uses GN/ninja, is large, and takes long to compile (a full library of tens of MB) | use `is_official_build` + build only the `skia` target; the docs fix the compilation steps, and precompiled artifacts could be distributed with the repo/CI |
| **C++20 requirement** | needs clang, and the local Apple clang version must be new enough | the docs state the minimum version; `build.ts` detects the C++ compiler |
| **No C API** | the glue layer must be maintained, and a Skia API upgrade drags the glue along | the glue exposes only a minimal surface; add functions as needed, no comprehensive wrapping |
| **Size/startup** | the binary grows noticeably after static linking | acceptable for a teaching compiler; a GPU backend can reduce CPU rasterization cost |
| **wasm adaptation** | Skia's wasm targets emscripten, and WASI adaptation is costly | use emscripten to produce browser artifacts directly (`--package web`), already end-to-end verified; see [`html5-web.md`](html5-web.md) |
| **Text typesetting** | SkParagraph is a separate library, sizable and complex, and its UAX#14 line breaking diverges semantically from AIR `wordWrap` (space-only breaking) at overlong words/hyphens | stage thirty-eight first self-builds greedy wrapping, v0.3.73 upgrades to SkParagraph (the divergence converges to two edge cases, recorded as known limitations); rich-text `htmlText`/multi-`TextFormat` interval styles are left for later |

**Boundary statement (consistent with the project philosophy)**: Skia only solves "drawing" and **does not
solve** the AS3 display-list hierarchy, event capture/bubbling, the hit three-state machine, focus, or tab
order — these remain the C runtime's responsibility in stages thirty-three to thirty-five (with Ruffle as the
semantic reference). Skia is not a "GUI framework" but a "rasterization backend"; the GUI's skeleton (display
list + events + hit testing) is AS3 semantics we translate ourselves.

---

## 12. Reference Links

- Official docs: <https://skia.org/docs/>
- API index (Doxygen): <https://api.skia.org>
- Build guide: <https://skia.org/docs/user/build/>
- Download guide: <https://skia.org/docs/user/download/>
- SkCanvas overview: <https://skia.org/docs/user/api/skcanvas_overview/>
- Coordinate system: <https://skia.org/docs/user/coordinates/>
- Source (GitHub mirror): <https://github.com/google/skia> (main repo <https://skia.googlesource.com/skia>)
- License: BSD-3-Clause (`LICENSE`, Copyright 2011 Google Inc.)