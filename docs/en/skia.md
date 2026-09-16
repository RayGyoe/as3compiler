# Skia Rendering Backend Research and Integration Plan

> This document answers two questions: **why use Skia for GUI**, and **how closely Skia relates to the
> event/view system**. The core conclusion first: Skia is a **pure 2D rasterization library**; it only draws
> "geometry/bitmap/text into pixels". The display list (`DisplayObject` tree), event flow, and hit testing —
> these AS3 semantics **are not in Skia**; we must implement them ourselves in the C runtime (stages
> thirty-three~thirty-five, with Ruffle as the semantic reference). Skia and our self-built event/view system
> are **orthogonal**; their single **convergence point** is `DisplayObject.render()` — each display object
> translates its own geometry into Skia `SkCanvas` drawing calls.
>
> Positioning: Skia is to this project what the "stage twenty-nine GUI direction plan" said — "link
> skia/cairo rather than self-build rasterization". It replaces the **pixel-output** layer, not the display
> list/event layer.

---

## 1. Why Skia (and the Skia-vs-cairo tradeoff)

Skia is an open-source cross-platform 2D graphics library developed and maintained by Google, the underlying
rendering engine for Chrome / Android / Flutter.

| Dimension | Skia | cairo |
|------|------|-------|
| Maintainer | Google (backed by Chrome/Android/Flutter) | GNOME community |
| Language | **C++20** | C (stable C ABI) |
| Backend | CPU raster / GPU (Vulkan/Metal/GL/D3D) / PDF/SVG | CPU raster / GL / PDF/PS/SVG |
| Text | SkFont/SkTextBlob + SkParagraph (full typesetting) | Pango/Cairo toy API (needs external typesetting) |
| Anti-aliasing | high-quality AA + analytic AA | good |
| Vector Path | extremely strong (including pathops boolean ops) | strong (has path boolean) |
| License | **BSD-3-Clause** (permissive, static-link into closed source) | LGPL/MPL |
| Size/build | heavy (GN/ninja, `libskia.a` tens of MB) | light |

**Reason for choosing Skia**: AS3's `flash.display.Graphics` (vector `moveTo/lineTo/curveTo` + gradient fill +
stroke) is essentially the "Path + Paint" model, and Skia's `SkPath`/`SkPaint`/`SkShader` map to it
**semantically nearly one-to-one**; plus the Flutter ecosystem heavily depends on Skia, so the community is
mature and cross-platform consistency is good. cairo's advantage is "has a C ABI, small footprint", but its
text typesetting needs external Pango, and its vector-gradient API is more cumbersome than Skia's.

**Project decision**: primarily use **Skia**, with the rendering layer exposed to the generated `.c` through a
**C++ glue layer** exposing `extern "C"` interfaces (see §4). cairo is kept as an alternative backend for
"footprint-sensitive scenarios", but not done by default.

---

## 2. Skia Core Concepts (the part this project uses)

Everything in Skia is organized around `SkCanvas` (the canvas). A draw call `canvas->drawRect(rect, paint)`
splits into two parts: **what is drawn** (`SkRect`/`SkPath`/`SkImage`/text) and **how it is drawn**
(`SkPaint`: color, fill/stroke, line width, shader, blend mode).

| Class | Responsibility | Corresponding AS3 concept |
|----|------|--------------|
| `SkCanvas` | drawing entry, maintains matrix/clip stack (`save`/`restore`/`translate`/`rotate`/`scale`/`clip*`) | `Graphics`'s draw target + `DisplayObject`'s `x/y/rotation/scaleX/scaleY` transforms |
| `SkPaint` | color, fill/stroke style, line width, anti-aliasing, blend mode, shader/filter | `Graphics.lineStyle`/`beginFill`/`blendMode`/filters |
| `SkPath` | geometric path of lines/beziers/arcs | `Graphics.moveTo/lineTo/curveTo`'s path data |
| `SkSurface` | pixel carrier (CPU/GPU/PDF), `getCanvas()` to get the canvas | Stage's bitmap surface / `BitmapData`'s pixel buffer |
| `SkBitmap` / `SkImage` | bitmap pixel storage (`SkBitmap` more writable, `SkImage` more read-only) | `BitmapData` / `Bitmap` |
| `SkImageInfo` | width/height + color type + alpha type (e.g. `kN32_SkColorType` premul) | `BitmapData`'s pixel format (ARGB) |
| `SkMatrix` | 3×3 affine transform matrix | `DisplayObject.transform.matrix` |
| `SkFont` / `SkTypeface` | font and size | `TextField` / `TextFormat`'s font settings |
| `SkTextBlob` | typeset glyph runs | `TextField`'s text content (basic path) |
| `SkShader` (`SkGradientShader`) | gradient/pattern fill | `Graphics.beginGradientFill` |
| `SkBlendMode` | pixel blend operation | `DisplayObject.blendMode` |
| `SkMaskFilter` / `SkImageFilter` | blur and other filters | `BlurFilter`/`DropShadowFilter` |

**Coordinate system**: Skia's origin is top-left, **y-axis downward** — consistent with Flash's display
coordinate system, so no flipping is needed during translation.

---

## 3. Key Decision: Skia Has No C API, Must Add a C++ Glue Layer

This is the most important technical conclusion of this plan, and a detail the earlier "link skia" notes left
unspoken:

- Current Skia `main`'s `include/` directory (android / codec / config / core / cpu / docs / effects / encode /
  gpu / pathops / ports / private / sksl / svg / third_party / utils) has **no `c/` subdirectory** — the early
  C API (`sk_canvas.h`, etc.) used for PDFium/some bindings has been removed; Skia is now a **pure C++20
  interface**.
- But our compiler produces **C** (`as-aot` generates `.c`), and C cannot directly link C++ symbols (name
  mangling, `SkRefCnt` reference counting, `sk_sp<>` smart pointers, exceptions, etc.).
- Therefore a hand-written C++ glue file (`skia_glue.cc`) **is required**, wrapping the needed Skia
  capabilities into flat C functions with `extern "C"`, and the generated `.c` only calls these `sk_*` C
  functions. This falls squarely within stage twenty-nine's build-manifest capability:

```json
{
  "target": "native",
  "c-compiler": "clang",
  "opt": "-O2",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia/include"],
  "link-libs": ["skia", "skparagraph"],
  "link-paths": ["../vendor/skia/lib"],
  "defines": ["ASC_USE_SKIA=1"],
  "objects": []
}
```

> Note: the existing `examples/skia-link.build.example.json` writes `skia_glue.c`. Because Skia is C++, the
> glue layer should actually be `.cc` (a C++ source), and the compile command needs to be driven by
> `c++/clang++` (`-lstdc++` implicit). `build.ts` needs to recognize `.cc/.cpp` suffixes in `sources` and
> switch to the C++ compile driver — this is a build-layer capability to add when the rendering stage lands.

**Glue-layer design principles** (following AGENTS.md §2.9):

1. Only expose **flat C functions**, all signatures `extern "C"`, parameters only POD
   (`int/float/double/const char*/pointer`), no `sk_sp`/`SkString`/STL containers exposed.
2. All Skia objects pass in/out via **opaque pointers** (`void*` / `sk_handle`); lifetimes are managed inside
   the glue layer (reference counting), corresponding to the AS3-side `as_skia_*` runtime helpers.
3. Platform coupling (window/surface creation) is centralized in the glue layer; the generated `.c` never
   touches any Skia header directly — `#ifdef __wasi__` still lives in `RUNTIME_PREAMBLE` (native uses CPU
   raster / SDL, WASI uses offscreen raster outputting `SkImage`).

---

## 4. `flash.display.*` → Skia Mapping Table (core)

This is the actual translation mapping for "implementing GUI with Skia". **Remember one main thread**: the
display list (who is whose parent, depth order, hit testing) is implemented by the stage thirty-four/
thirty-five C structures; Skia only takes over at **leaf rendering**, drawing geometry into the `SkCanvas`.

| AS3 (`flash.display` / `flash.filters`) | Skia translation | Notes |
|-----------------------------------------|-----------|------|
| `DisplayObject.x/y/rotation/scaleX/scaleY` | `canvas->translate(x,y)` + `rotate` + `scale` (inside `save`/`restore`) | corresponds to AS3's matrix transform |
| `DisplayObject.alpha` | `SkPaint::setAlpha` or `saveLayerAlpha` | whole-subtree transparency uses `saveLayerAlpha` |
| `DisplayObject.visible=false` | skip rendering that subtree | pure display-list decision, no Skia involved |
| `DisplayObject.blendMode` | `SkPaint::setBlendMode` (`SkBlendMode::k*`) | AS3 `BlendMode` enum → Skia enum mapping |
| `Shape.graphics.moveTo/lineTo/curveTo` | `SkPath::moveTo/lineTo/cubicTo/quadTo` | `curveTo` is a quadratic bezier → `quadTo` |
| `Graphics.beginFill(color, alpha)` | `SkPaint` fill style + `setColor`/`setAlpha` | `drawPath(path, paint)` after `endFill` |
| `Graphics.lineStyle(thickness, color, alpha)` | `SkPaint` stroke style + `setStrokeWidth` + `setStrokeMiter/Cap/Join` | stroke attributes aligned item by item |
| `Graphics.beginGradientFill(...)` | `SkGradientShader::MakeLinear/MakeRadial` → `SkPaint::setShader` | linear/radial two kinds |
| `Graphics.drawCircle/drawRect/drawRoundRect` | `SkCanvas::drawCircle/drawRect/drawRRect` | shortcut geometry |
| `Bitmap.bitmapData` / `BitmapData` | `SkBitmap`/`SkImage` + `drawImage` | `BitmapData` is the pixel buffer, `Bitmap` is the display node |
| `BitmapData.setPixel/getPixel` | `SkBitmap::setPixel/getColor` (or `SkPixmap`) | CPU pixel read/write |
| `BitmapData.draw(source)` | `SkCanvas::drawImage/drawSurface` (offscreen surface compositing) | bitmap copy/composite |
| `TextField.text` (basic glyphs) | `SkFont` + `SkTextBlob` → `drawTextBlob` | glyph positioning only, no line wrap |
| `TextField` (full typesetting: wrap/align/paragraph) | **SkParagraph** (`modules/skparagraph`) → `SkParagraph::layout` + `paint` | AS3 auto-wrap/multiline needs SkParagraph |
| `TextFormat.font/size/color/bold/italic` | `SkFont` + `SkTypeface` + `SkPaint` | font family/size/bold/italic |
| `filters.BlurFilter` | `SkImageFilters::Blur` (`saveLayer` wraps subtree) | landed (stage sixty-one), `sigma ≈ blurX/3` |
| `filters.DropShadowFilter` | `SkImageFilters::DropShadow` (`saveLayer` + `SkImageFilter`) | landed (stage sixty-one), outer shadow |
| `filters.GlowFilter` | `SkColorFilters::Matrix` (alpha outline coloring) + blur + overlay base | landed (stage sixty-one), outer glow |
| `DisplayObject.mask` | `canvas->saveLayer` + mask draw + `SkBlendMode::kSrcIn` | AS3 mask semantics |
| `scrollRect` | `canvas->clipRect` | clip visible area |

**The correct posture for coordinate transforms** (matching Skia `SkCanvas`'s matrix stack):

```
Render a DisplayObject subtree (recursive):
  canvas->save();
  canvas->translate(obj->x, obj->y);
  canvas->rotate(obj->rotation);
  canvas->scale(obj->scaleX, obj->scaleY);
  canvas->concat(obj->transform.matrix);     // if a full matrix exists
  if (obj->scrollRect) canvas->clipRect(obj->scrollRect);
  // 1) draw self first: obj->render_self(canvas)   (Shape draws path, Bitmap draws image, TextField draws textBlob)
  // 2) then draw children in depth order: for child in children: render(child)
  canvas->restore();
```

> **Depth order**: `DisplayObjectContainer`'s render order = depth order (low depth first, high depth later
> drawn on top). This is the same children array as stage thirty-five's "mouse hit reverse order, keyboard
> forward order" — two perspectives. **Rendering uses forward order, mouse hit uses reverse order**.

---

## 5. Skia and the Event System: Orthogonal, Not "Highly Related"

This directly answers "whether it's highly related to the event/view system":

- **Skia provides none of**: display list/scene graph, event dispatch (capture/bubble), hit testing, focus,
  window management, input-device abstraction. These are exactly what stages thirty-three~thirty-five build,
  with Ruffle as the semantic reference.
- **The event system does not depend on Skia**: `hitTestPoint(x, y)` deciding "which object the mouse is on"
  uses **display-list geometry (coordinate transform + shape)**, not Skia's pixels. Ruffle's `interactive.rs`
  hit three-state machine (`Avm2MousePick`) traverses the `DisplayObject` tree, fully decoupled from the
  rendering backend.
- **Their single convergence point is `render()`**: the event system decides "who responds first, who gets
  hit", the rendering system decides "what it finally looks like". An object is first hit (stage thirty-five's
  geometric hit), then rendered (this file's Skia translation). Both share the same `DisplayObject` tree, but
  their responsibilities are orthogonal.

**Optional reuse**: Skia's `SkPath::contains(x, y)` / `SkRegion` can **assist** implementing `hitTestPoint`'s
"point inside shape" judgment (especially complex vector shapes). But this is only a bonus — AS3's
`hitTestPoint(shapeFlag=false)` by default uses the bounding box (geometric judgment), and only
`shapeFlag=true` does shape-level hit. **Use the bounding box first**; defer SkPath hit to when precise shape
hit is needed.

> In one sentence: **Skia handles "drawing", the event/view handles "who's on top, who responds first"**.
> The two converge at the leaf node through the `DisplayObject.render()` interface, rather than being "highly
> coupled".

---

## 6. Build and Linking (landing points)

### 6.1 Obtaining and Compiling Skia

> **This project's actual landing approach (prebuilt)**: the local machine lacks `gn`/`ninja` and doesn't have
> enough disk space to compile from source, so it uses the
> [Aseprite official prebuilt Skia](https://github.com/aseprite/skia/releases) **m124**
> (`Skia-macOS-Release-arm64.zip`). That package ships headers (`include/`) and the full set of static
> libraries (`out/Release-arm64/*.a`), already unpacked as `vendor/skia/{include,lib}/`, and wired into the
> build manifest together with transitive dependencies like PNG/JPEG/WebP/freetype/harfbuzz/icu/zlib (see
> `examples/skia-link.build.example.json`). **If you need to compile from source yourself, use the flow below**.

Skia builds with **GN/ninja**, requiring a C++20 compiler (officially strongly recommended **clang**; software
rasterization/image decoding needs clang to trigger optimal paths, other compilers noticeably regress
performance).

```bash
git clone https://skia.googlesource.com/skia.git
cd skia
python3 tools/git-sync-deps        # pull third-party deps (libpng/libjpeg-turbo/libwebp etc.)
python3 bin/fetch-ninja

# produce static lib libskia.a (is_official_build=true means release, dynamic-link system deps)
bin/gn gen out/Static --args='is_official_build=true'
ninja -C out/Static skia           # target name skia → out/Static/libskia.a

# if SkParagraph is needed (TextField full typesetting)
bin/gn gen out/Static --args='is_official_build=true skia_use_skparagraph=true'
ninja -C out/Static skia skparagraph
```

Artifact layout (assuming installed to `vendor/skia/`):

```
vendor/skia/
  include/   ← headers (include/core, include/effects, include/codec, ...)
  lib/       ← libskia.a (+ libskparagraph.a etc.)
```

### 6.2 How the Build Manifest Connects

Stage twenty-nine's `build.ts` already supports `sources`/`include-paths`/`link-libs`/`link-paths`. The
rendering stage needs to add two things:

1. **C++ glue-layer compile driver**: when `.cc/.cpp` appears in `sources`, drive with `clang++` (not `cc`),
   and ensure `-lstdc++` is linked (macOS's `clang++` brings it implicitly).
2. **Skia's transitive dependencies**: `libskia.a` depends on libpng/libjpeg-turbo/libwebp/fontconfig/
   freetype/zlib etc. With `is_official_build=true` these go through system dynamic libraries, and the link
   line needs `-lpng -ljpeg -lwebp -lz ...` (or directly link Skia's bundled `skia_public` description).
   **First-phase recommendation**: use `is_official_build=false` to statically bundle all dependencies into
   `libskia.a`, cleanest link line, at the cost of longer compile and larger library.

### 6.3 Rendering Backend Choice (first-phase recommendation: CPU raster)

| Backend | Pros | Cons | Applicable |
|------|------|------|------|
| **CPU raster** (`SkSurface::MakeRaster` / `SkBitmapDevice`) | zero window-system dependency, zero GPU driver, offscreen output, easy to test | slow on large canvases | **first phase**: offscreen render → output PNG/bitmap, or hand to SDL for blitting |
| GPU (Vulkan/Metal/GL/D3D) | fast, smooth animation | depends on graphics API + window context | connect later when doing real desktop windows |
| PDF/SVG (`SkDocument`) | vector output | non-interactive | optional: `BitmapData` export |

**Recommended landing order**: first do **offscreen CPU raster** (`SkSurface::MakeRaster` → `SkCanvas` →
`makeImageSnapshot` → `SkImage::encodeToData(SkEncodedImageFormat::kPNG)`), so `as-aot --run` can directly
produce bitmap files, be regression-asserted on pixels, and never touch the window system. Real desktop
windows have landed (stage thirty-nine: SDL2 blit + event loop; stage forty: mouse input bridged back to the
AS3 event system, see [`compile.md`](compile.md) §6).

> This is the continuation of the project's "frontend only translates, optimization to mature libraries" iron
> rule: **we don't even self-build windows and pixels**; Skia handles pixels, SDL2 handles windows and input
> (landed: stage thirty-nine window blit + stage forty mouse-event bridge, see [`compile.md`](compile.md) §6),
> and we only translate AS3 semantics over.

---

## 7. Multi-target: native and wasm

- **native**: Skia static-link `libskia.a` (CPU raster or GPU), producing Mach-O/ELF/PE.
- **wasm**: Skia officially has **CanvasKit** (`modules/canvaskit`, the JS-binding artifact of Skia +
  WebAssembly), but that's the JS ecosystem; we want the C ABI, so the approach is **to compile Skia + our
  glue layer together into WASI using a wasm32 toolchain**. Note Skia's wasm build generally targets emscripten
  (the CanvasKit path), and WASI adaptation costs more than native — **first phase only ensures the native
  rendering chain runs**, wasm rendering deferred (`--target wasm` still only supports GUI-less programs). This
  matches "stage by stage, run the main chain first".

---

## 8. Two-tier Plan for Text Rendering

`TextField` is the most complex part of AS3 GUI; Skia provides two tiers:

1. **Basic glyphs (`SkFont` + `SkTextBlob`)**: given font/size/color, draw a UTF-8 string to a specified
   baseline position. **No auto-wrap, alignment, or paragraph support**. Suitable for first-phase "single-line
   text / simple label" implementation.
2. **Full typesetting (SkParagraph, `modules/skparagraph`)**: supports wrap, left/right alignment, letter
   spacing, multiple paragraphs, rich-text styles. Corresponds to AS3 `TextField`'s `wordWrap`/`multiline`/
   `textWidth`/`textHeight`/`autoSize`/`htmlText`.

**Decision correction (actual landing in stage forty-four)**: originally planned to use SkParagraph, but the
actual landing is **`SkFont` measurement + self-built greedy wrapping** (`as_text_wrap` in `runtime.ts`), for
the same reason as stages twenty-four~twenty-seven self-built the regex engine — **semantic drift**:

- AS3 `wordWrap` only breaks at **spaces**; an over-wide single word overflows whole (not split); SkParagraph
  uses the UAX#14 Unicode line-breaking algorithm, which can break at any character boundary (hyphen/CJK
  inter-character), inconsistent with AIR behavior if taken directly.
- AIR's `maxScrollV`/`scrollV` is "viewport line" semantics (`numLines - visibleLines + 1`, `scrollV =
  maxScrollV` pins the latest line to the bottom), belonging to the display-list/clip-layer logic, which
  SkParagraph does not provide.
- Importantly **no self-built rasterization**: glyph measurement (`sk_text_measure_n`) and drawing
  (`sk_canvas_draw_text_n` → `drawSimpleText`) are still all handed to Skia; self-built is only the
  "where to break" layer of AS3 semantics, consistent with the §2.9 iron rule.

SkParagraph is still reserved for real rich-text needs (`htmlText`, multiple `TextFormat` range styles,
alignment/letter spacing/multiple paragraphs), listed as a later sub-stage. Not currently done:
`autoSize`/`hscroll`/`selectable`/`leading`, line height approximated as `size × 1.2` instead of font-metrics
tables; no typesetting cache (recomputed each frame, fine at demo scale). Assertion-based regression at
`examples/textflow.as`.

---

## 9. Image Decoding (`BitmapData.loadBytes` / `Loader`)

Skia's `SkCodec` (`include/codec`) + `SkImage::MakeFromEncoded` covers PNG/JPEG/WebP/GIF decoding,
corresponding to AS3's `Loader`/`BitmapData.loadBytes` image loading. Decoding depends on
libpng/libjpeg-turbo/libwebp (§6.2). The `ByteArray` binary runtime (`flash.utils.ByteArray`) is a
prerequisite and not yet implemented (stages thirty~thirty-two only added pure-logic builtins, `ByteArray`
still in the exclusion list), so image decoding is queued after ByteArray.

---

## 10. Relationship with TODO.md Stages + Suggested New Rendering Stages

The existing plan (stages thirty-three~thirty-five) is "event + display list + hit"; rendering has always been
a placeholder. This document fills in the **pixel rendering** part. Suggested additions after stage
thirty-five:

| Suggested stage | Goal | Content |
|---------|------|------|
| **Stage thirty-six** | v0.3.36 | **Skia glue layer + build integration**: `vendor/skia` import, `skia_glue.cc` minimal `extern "C"` surface (surface/canvas/paint/path/color/matrix), `build.ts` supports `.cc` compile driver and `-lskia` link, `as_skia_*` runtime helpers, end-to-end offscreen CPU raster → PNG demo |
| **Stage thirty-seven** | v0.3.37 | **`flash.display` rendering landing**: `Shape`/`Graphics` → `SkPath`+`SkPaint` (fill/stroke/gradient), `Bitmap`/`BitmapData` → `SkImage` (including `setPixel/getPixel/draw`), `DisplayObject` transforms (translate/rotate/scale/alpha/blendMode), recursive rendering + depth order |
| **Stage thirty-eight** | v0.3.38 | **`TextField` text rendering**: `SkFont` + `drawString` single-line direct draw, `TextFormat` styles (font/size/color/bold/italic), background rectangle; multiline typesetting not done at the time |
| **Stage forty-four** | v0.3.45 | **`TextField` multiline typesetting + Retina hi-DPI**: `as_text_wrap` hard break/`wordWrap` greedy soft wrap (Skia-measured width), `clip` clipping, `numLines`/`maxScrollV`/`scrollV` viewport math; `sk_canvas_draw_text_n`/`sk_text_measure_n` by-length interface; `ASC_DISPLAY_HIGH` via `ALLOW_HIGHDPI` + drawable probe; fix `sk_font()` rebuilding CoreText FontMgr every time causing multiline first-frame hang |

> Stage thirty-six is the key gate for "connecting Skia"; it verifies "the generated C can call Skia through
> the glue layer and produce correct pixels". It's recommended to first make it a **minimum viable closed
> loop** (draw a `Shape` rectangle → output PNG → assert pixels), then roll out stages thirty-seven/thirty-
> eight.

---

## 11. Risks and Boundaries

| Risk | Description | Mitigation |
|------|------|------|
| **Build complexity** | Skia uses GN/ninja, large footprint, long compile (full build tens of MB of library) | use `is_official_build` + only build the `skia` target; document the compile steps; consider distributing prebuilt artifacts with repo/CI |
| **C++20 requirement** | needs clang, and the local Apple clang must be new enough | document the minimum version; `build.ts` detects the C++ compiler |
| **No C API** | must maintain the glue layer; Skia API upgrades ripple into glue | glue only exposes the minimal surface; add functions on demand, no full wrapping |
| **Footprint/startup** | static linking noticeably enlarges the binary | acceptable for a teaching compiler; GPU backend reduces CPU rasterization cost |
| **wasm adaptation** | Skia's wasm targets emscripten, WASI adaptation cost high | first phase only native rendering, wasm GUI deferred |
| **Text typesetting** | SkParagraph is a separate library, both footprint and complexity are significant, and its UAX#14 wrapping semantically drifts from AIR `wordWrap` (break only at spaces) | stage forty-four uses `SkFont` measurement + self-built greedy wrapping to cover `multiline`/`wordWrap`/`scrollV`; SkParagraph reserved for `htmlText`/rich text |

**Boundary statement (consistent with project philosophy)**: Skia only solves "drawing"; it does **not** solve
AS3 display-list hierarchy, event capture/bubble, hit three-state machine, focus, tab order — these remain the
stage thirty-three~thirty-five C-runtime responsibilities (Ruffle semantic reference). Skia is not a "GUI
framework", but a "rasterization backend"; the GUI skeleton (display list + event + hit) is AS3 semantics we
translate ourselves.

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
