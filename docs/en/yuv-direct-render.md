# BitmapData Direct YUV Rendering — Design Document (Implemented)

> Goal: add an AIR-exceeding enhancement method `setYuv420(rect, inputByteArray)` to `BitmapData` so ANE video
> frames enter the render pipeline **as raw I420 YUV bytes** and the GPU performs YUV→RGB in hardware, instead of
> converting to ARGB on the CPU first and then calling `setPixels`. This is an **enhancement beyond AIR** (AIR's
> `BitmapData` has no such method), so per §1.5 it must be opt-in-clear, fail loudly when the capability is missing,
> and list cross-backend differences explicitly.

---

## 0. Implementation status

**Fully landed** (all three stages, stage three-hundred-seventy-four):

- **Stage A / B**: `_yuv_data` field + `setYuv420` method (gated by `--features yuv420`, absent from the default
  build), the four backend context getters (Metal `sk_metal_get_context` / D3D12 `sk_d3d_get_context` / WGL
  `sk_gl_get_context` / WebGL2 `sk_gr_get_context`), the `sk_image_from_yuv` glue, and the `as_bmd_live_image` YUV
  branch;
- **Stage C**: CPU fallback semantics (one warning + black when there is no context) + end-to-end acceptance;
- **Artifacts**: `examples/yuv420-probe.as` (byte-read contract: cursor advance / short buffer `#2030` / odd and
  partial rect `#2004` / no-overlap silent), `examples/yuv420-render.as` (Skia link + CPU black + red positive control);
- **Tests**: `test/unit/build.ts` (`yuv420` → `ASC_USE_YUV420=1`, default has no macro, native/wasm accepted),
  `test/unit/emit.ts` (`unit: emit/Yuv420`: default has no member; with the feature the method body/field/YUV branch
  are all present);
- **On-device colour check still pending**: BT.601 color correctness on the GPU needs an `--air-app` +
  `renderMode=gpu` window build (Metal) and a WebGL2 browser page; not yet done pixel-for-pixel (see §7).

---

## 1. Background and motivation

### 1.1 Current state: the CPU conversion path for video frames

ANE camera / screen-share video frames currently take two legs — "convert to ARGB in the ANE, then `setPixels`":

1. **ANE side (C++)**: libyuv `I420ToARGB` converts the YUV420 planes into 32-bit BGRA packed into a `ByteArray`;
2. **AS3 side**: `videoByteArray.endian = LITTLE_ENDIAN`, then `BitmapData.setPixels(rect, ba)`;
3. **Render side**: `as_bmd_live_image` uses `sk_image_from_argb` to copy `bd->pixels` (straight ARGB) once more
   into a CPU raster `SkImage`, which is uploaded to the GPU only at draw time.

So every frame does, on the CPU, **one YUV→ARGB conversion (libyuv) plus two whole-frame copies** (the `setPixels`
write and the `sk_image_from_argb` SkImage build). YUV420 is only 3/2 the size of ARGB, yet it is inflated to ARGB at
the ANE boundary and carried through the whole pipeline.

### 1.2 Target shape: YUV straight to the GPU

`setYuv420` aims to cut the conversion / inflation in steps 1 and 2:

- the ANE produces **I420 plane bytes** directly (its native decode form, libyuv's input), with **no** `I420ToARGB`;
- AS3 calls `setYuv420(rect, ba)` to store the three planes **verbatim** into the BitmapData;
- rendering uses Skia's GPU YUV-texture entry (`SkImages::TextureFromYUVAPixmaps`) to turn the Y/U/V planes into a
  **GPU texture**, letting the GPU shader do BT.601 YUV→RGB and skipping the CPU conversion and whole-frame ARGB copy.

---

## 2. Goals and non-goals

### 2.1 Goals

- `BitmapData.setYuv420(rect:Rectangle, inputByteArray:ByteArray):void`: read compact I420 planes from the ByteArray
  cursor (Y `w×h`, U `w/2×h/2`, V `w/2×h/2`, total `w×h×3/2` bytes) and store them in the BitmapData YUV buffer;
- the render path uses YUV-texture direct rendering on **GPU backends** (native `ASC_RENDER_WINGPU` / web
  `ASC_RENDER_GPU`);
- color space fixed to **BT.601 video range** (Skia `kRec601_Limited_SkYUVColorSpace`, Y∈[16,235], U/V∈[16,240]);
- name `setYuv420`: names the 4:2:0 subsampling, avoids libyuv-specific terminology, leaves room for future
  `setNv12` / `setYuv422`;
- **opt-in switch**: `--features yuv420` (manifest `"features": ["yuv420"]`) → macro `ASC_USE_YUV420=1`, available
  on native / wasm; without the switch `BitmapData` has no `setYuv420` member, verbatim AIR (reports
  `BitmapData has no member 'setYuv420'`).

### 2.2 Non-goals (out of scope this round)

- **No** CPU hand-written YUV→ARGB conversion: without a GPU backend, **warn + render black** (loud, not silent);
- **No** NV12 / YUY2 / 10-bit / strided layouts; no three-separate-planes parameter form;
- **No** runtime color-space switching (BT.709 / JPEG full range / BT.2020): fixed BT.601, add a parameter later;
- **No** native AIR alignment — `setYuv420` is an enhancement with no AIR counterpart.

---

## 3. Current-state inventory

### 3.1 BitmapData pixel and render path

- `BitmapData.pixels` stores **straight ARGB** (`0xAARRGGBB`, `unsigned` per pixel), a GC-heap `GCT_BYTES` buffer;
- a display-list `Bitmap` gets its SkImage via `as_bmd_visible_image(bd)`: un-mutated decoded bitmaps use the
  zero-copy `image`, anything whose pixels were written goes through `as_bmd_live_image(bd)` →
  `sk_image_from_argb(bd->pixels, w, h)` (`vendor/skia_glue.cc`, `SkImages::RasterFromPixmapCopy`, a CPU copy into a
  raster SkImage);
- `_live_image` + `_live_ver` cache the SkImage, rebuilt when the version counter is bumped by every mutator's
  `as_bd_mark_dirty`.

### 3.2 Where the GPU contexts live (the key constraint)

Skia's `TextureFromYUVAPixmaps` is **backend-agnostic** (it only takes a `GrRecordingContext*`), so YUV direct
rendering works on **all four Ganesh backends below** — the only difference is how the context is obtained:

| Backend | Macro | GrDirectContext location | Shape |
|---|---|---|---|
| Metal (macOS) | `ASC_RENDER_METAL` | `vendor/metal_glue.mm` `g_context` (`GrDirectContexts::MakeMetal`) | process-wide single context |
| Direct3D12 (Windows default) | `ASC_RENDER_D3D` | `vendor/d3d_glue.cc` `g_context` (`GrDirectContext::MakeDirect3D`) | process-wide single context |
| OpenGL/WGL (Windows Win7 compatible) | `ASC_RENDER_GL` | `vendor/gl_glue.cc` `w->ctx` (`GrDirectContexts::MakeGL`) | **one context per window** (Skia rule: one GrDirectContext per GL context) |
| WebGL2 (web) | `ASC_RENDER_GPU` | `vendor/skia_glue.cc` `g_gr_context` (`__EMSCRIPTEN__`, `GrDirectContexts::MakeGL`) | process-wide single context |
| CPU (native/web default) | none of the above | **none** | `SkSurfaces::Raster` + SDL streaming texture / putImageData |

### 3.3 Skia's YUV capability

- Skia has **no** "CPU raster YUV SkImage" entry; YUV→RGB lives only in the GPU header:
  `vendor/skia/include/gpu/ganesh/SkImageGanesh.h` → `SkImages::TextureFromYUVAPixmaps(GrRecordingContext*, const SkYUVAPixmaps&)`.
- `nm` confirms the symbol exists in **macos-arm64 / wasm libskia.a** (4 overloads native, 2 wasm).
- The color-space enum is in `vendor/skia/include/core/SkImageInfo.h`: `kRec601_Limited_SkYUVColorSpace` (= legacy
  `kRec601_SkYUVColorSpace`) is BT.601 video range; `kJPEG_Full_SkYUVColorSpace` is full range.
- `SkYUVAPixmaps` plane-layout enums are in `SkYUVAInfo.h`: `PlaneConfig::kY_U_V` + `Subsampling::k420`.

**Conclusion**: direct YUV rendering is GPU-only and requires a GrDirectContext; the default CPU build can only
"warn + black".

---

## 4. Core design

### 4.1 API shape

```as3
// Enhancement beyond AIR. I420 planar, BT.601 video range, compact (no stride, no endianness).
function setYuv420(rect:Rectangle, inputByteArray:ByteArray):void;
```

Read semantics **mirror `setPixels`**: start at `inputByteArray.position`, advance `position` byte by byte; clip
pixels that fall outside the bitmap; on a short buffer **keep the cells already written and throw `EOFError #2030`**
(`as_throw_eof`), matching `setPixels`'s short-buffer contract (measured in `temp/gdsetpixels/`).

### 4.2 Data structure

`BitmapData` gains one GC-heap YUV buffer (`GCT_BYTES`), following the same ownership field pattern as `pixels`:

```c
// New BitmapData field (alongside pixels, not a replacement):
unsigned char* _yuv_data;   // compact I420: Y[w*h] | U[w*h/4] | V[w*h/4], total w*h*3/2
```

- **Stores YUV, not ARGB**: `_yuv_data` and `pixels` are used exclusively — `setYuv420` writes `_yuv_data`, ordinary
  mutators (`setPixel`/`fillRect`/`setPixels`/`draw`…) keep writing `pixels`; when both exist, **rendering prefers YUV**,
  and any ordinary mutator writing `pixels` releases `_yuv_data` and yields.
- The three planes are derived from one contiguous buffer plus known `w/h` (Y=`_yuv_data`, U=`+w*h`, V=`+w*h*5/4`),
  **not** three separate pointers.

### 4.3 Skia YUV conversion (`vendor/skia_glue.cc`)

Add one cross-backend entry point; the caller passes the GrDirectContext it already obtained:

```cpp
// skia_glue.cc — hand the compact I420 planes to Ganesh and get a GPU-backed SkImage.
// TextureFromYUVAPixmaps copies the YUV into the GPU texture before returning (SkYUVAPixmaps
// need not stay valid afterwards).
void* sk_image_from_yuv(void* gr_ctx, const void* y, const void* u, const void* v, int w, int h) {
  if (gr_ctx == nullptr || y == nullptr || u == nullptr || v == nullptr || w <= 0 || h <= 0) return nullptr;
  SkYUVAInfo info = SkYUVAInfo::Make(SkISize::Make(w, h),
                                     SkYUVAInfo::PlaneConfig::kY_U_V,
                                     SkYUVAInfo::Subsampling::k420,
                                     kRec601_Limited_SkYUVColorSpace);
  const void* planes[3] = { y, u, v };
  auto pixmaps = SkYUVAPixmaps::FromExternalMemory(info, planes);   // borrows, does not copy
  if (!pixmaps.isValid()) return nullptr;
  auto img = SkImages::TextureFromYUVAPixmaps((GrRecordingContext*)gr_ctx, pixmaps,
                                              SkBudgeted::kYes, nullptr);
  return img.release();   // caller owns one ref (or NULL on failure)
}
```

A single context getter (see 4.4) keeps the emitted C from caring about backend differences.

### 4.4 Render branch and context consolidation

`as_bmd_live_image` gains a YUV branch that replaces the ARGB path **only when YUV data is present**:

```c
static void* as_bmd_live_image(BitmapData* bd) {
  // ... existing ARGB cache checks unchanged ...
  if (bd->_yuv_data != NULL) {
    void* ctx = as_skia_gr_context();       // runtime helper: dispatches by backend macro to Metal/D3D/GL getter, web uses g_gr_context
    if (ctx == NULL) { as_yuv_cpu_warn(bd); return NULL; }
    void* img = as_skia_image_from_yuv(ctx, bd->_yuv_data, bd->_yuv_data + w*h, bd->_yuv_data + w*h*5/4, w, h);
    // finalizer-register img (like _live_image), return it
  }
  return as_skia_image_from_argb(bd->pixels, bd->width, bd->height);
}
```

Context consolidation lives in the glue, not leaked into the emitted C:

- each backend glue exports its own `extern "C"` getter — `sk_metal_get_context()` / `sk_d3d_get_context()` /
  `sk_gl_get_context()` (web is served directly by `g_gr_context` inside `skia_glue.cc`) — uniformly returning the
  "current window"'s GrDirectContext;
- `src/runtime.ts` adds `as_skia_gr_context()`: dispatches via `#ifdef ASC_RENDER_METAL / ASC_RENDER_D3D /
  ASC_RENDER_GL / ASC_RENDER_GPU` to the matching getter (the CPU arm returns NULL); `as_skia_image_from_yuv()` is an
  inline wrapper (Skia arm + no-Skia no-op stub), so the generated C never touches the glue's internal statics directly;
- **GL-backend extra note**: `w->ctx` is one-per-window, so `sk_gl_get_context()` must return the **currently
  rendering window's** ctx, not just cache a process-wide singleton (gl_glue already tracks window activation; the
  getter reuses that same "current window").

### 4.5 CPU-backend fallback (loud, not silent)

Without a GrDirectContext (default CPU build), `setYuv420` still stores the YUV, but `as_skia_gr_context()` returns
NULL at render time:

- emit **one** warning (de-duplicated per BitmapData, not every frame):
  `warning: setYuv420 needs a GPU backend (ASC_RENDER_WINGPU/ASC_RENDER_GPU); rendering black`;
- return NULL → that Bitmap renders black/transparent, **never a silently wrong color**.

This is §1.5's "fail loudly when the capability is missing": black + warning is preferred over secretly hand-writing
YUV→ARGB on the CPU (which would defeat the whole premise of direct rendering).

### 4.6 Lifetime

- `_yuv_data` is GC-heap `GCT_BYTES`, released on `dispose()` / destruction / the next `setYuv420` / any ordinary
  mutator writing `pixels`;
- the produced GPU SkImage follows the same finalizer path as `_live_image` (`as_final_register`), avoiding a dangling
  SkImage when the BitmapData is replaced or collected — `TextureFromYUVAPixmaps` already copied the YUV into the GPU
  texture, so `_yuv_data` may be reused, but the SkImage must be freed with the BitmapData (delete by kind `SkImage`,
  reusing the existing finalizer table).

---

## 5. Staged implementation

> **Status: all three stages landed** (stage three-hundred-seventy-four). The staged plan is kept below; actual
> artifacts are in §0.

### Stage A: data structure + `setYuv420` stores the field (pure addition, not yet read)

- `src/symbols.ts` registers `setYuv420` (two params, `void`), gated by the **internal macro
  `ASC_USE_YUV420`** (without it `BitmapData` has no such member, reporting `no member 'setYuv420'`); this stage does
  **not** yet register `--features yuv420` (exposed only after Stage C end-to-end acceptance);
- `src/emit.ts`: `BitmapData` gains `_yuv_data` (ctor initializes NULL); `BitmapData_setYuv420` reads `w*h*3/2` bytes
  from the ByteArray cursor into `_yuv_data`, `as_bd_mark_dirty`, short-buffer `EOFError #2030`, out-of-range clip;
  `dispose` / ordinary mutators release `_yuv_data`;
- this stage **still renders via ARGB** (`_yuv_data` written but not read), keeping it a pure addition that does not
  disturb the existing 623-case regression.

### Stage B: Skia glue + context consolidation + render branch (the core)

- each backend glue exports its getter: `metal_glue.mm` adds `sk_metal_get_context()`, `d3d_glue.cc` adds
  `sk_d3d_get_context()`, `gl_glue.cc` adds `sk_gl_get_context()`; `skia_glue.cc` adds `sk_image_from_yuv`;
- `src/runtime.ts` adds `as_skia_gr_context()` / `as_skia_image_from_yuv()` wrappers and no-op stubs;
- `src/emit.ts`'s `as_bmd_live_image` gains the YUV branch (YUV data → GPU direct render; no context → warn + black);
- unit nails: the emitted C contains the YUV branch, the `sk_image_from_yuv` call, `kRec601_Limited`, the
  `as_yuv_cpu_warn` branch.

### Stage C: CPU fallback semantics + end-to-end acceptance

- end-to-end nail for the CPU (no GPU) build: `setYuv420` → black render + one warning;
- GPU build (`ASC_RENDER_WINGPU`): fixed YUV frame (pure red/gray/blue) → `getPixel32` color check against libyuv /
  the BT.601 formula;
- **register `yuv420` → `ASC_USE_YUV420=1` in `build.ts`'s FEATURES registry** (expose `--features yuv420`,
  available native / wasm; `--help` and the error text list it);
- bilingual docs, `TODO.md` stage record, version bump, commit/push.

---

## 6. Risks and boundaries (stated plainly)

1. **Cross-file / multi-backend context consolidation**: native GrDirectContexts live in three glue files
   (`metal_glue.mm`, `d3d_glue.cc`, `gl_glue.cc`); each must export an `extern "C"` getter and `src/runtime.ts`
   dispatches by backend macro — a GPU build already links its backend glue, so no extra link burden; but **GL is
   one-context-per-window**, so its getter must bind to the "current rendering window", an extra state Metal/D3D's
   process-wide singleton does not have.
2. **CPU-backend black render**: in the default CPU build `setYuv420` stores but does not render (warn + black). This
   is a deliberate §1.5 trade-off, meaning the enhancement has no visual output in the out-of-the-box build and only
   the GPU build shows anything — acceptance must be two-state, never using a CPU build to prove correctness.
3. **YUV texture lifetime**: `TextureFromYUVAPixmaps` copies YUV into the GPU texture; the SkImage must enter the
   finalizer. `_yuv_data` and `pixels` are mutually exclusive — any ordinary mutator writing `pixels` must release
   `_yuv_data` and invalidate the SkImage version, or a `fillRect` after a YUV frame would silently not take effect.
4. **Fixed BT.601 color space**: no runtime switch; BT.709 / JPEG full-range / BT.2020 inputs will be off-color. This
   is an explicit non-goal, listed in the docs and `enhancements.md`.
5. **Backend verification coverage**: GPU direct render needs an `ASC_RENDER_WINGPU` (Metal) real-window check; web
   `ASC_RENDER_GPU` needs a browser WebGL2 page check. A pure-C build with no raster backend never triggers rendering,
   so it cannot prove GPU-direct-render equivalence.

---

## 7. Acceptance and regression outline

- Unit nails (landed): `unit: build/Features` (`yuv420` macro mapping, default has no macro, native/wasm accepted),
  `unit: emit/Yuv420` (default build has no `setYuv420` member; with the feature the method body/field/
  `as_bmd_live_image` YUV branch are all present).
- End-to-end examples (landed): `examples/yuv420-probe.as` (byte-read contract, runs headless),
  `examples/yuv420-render.as` (Skia link + CPU black + red positive control).
- Full regression `node test.ts` stays green; `setYuv420` must not disturb the existing `setPixels`/`fillRect`/`draw`
  ARGB paths.
- **Still pending on-device color check**: GPU build (`ASC_RENDER_WINGPU`) fixed YUV frame (pure red/gray/blue) →
  `getPixel32` compared pixel-for-pixel against libyuv / the formula; WebGL2 browser page check. A pure-C build with
  no raster backend never triggers rendering, so it cannot prove GPU-direct-render equivalence.

---

## 8. References

- Skia Ganesh YUV: `vendor/skia/include/gpu/ganesh/SkImageGanesh.h`, `vendor/skia/include/core/SkYUVAPixmaps.h`,
  `SkYUVAInfo.h`, `SkImageInfo.h` (the `SkYUVColorSpace` enum).
- Existing render path: `src/emit.ts` `as_bmd_live_image`/`as_bmd_visible_image`, `BitmapData_setPixels`;
  `vendor/skia_glue.cc` `sk_image_from_argb`; `vendor/metal_glue.mm` / `d3d_glue.cc` `g_context` and `gl_glue.cc` `w->ctx`.
- Enhancement policy: `docs/en/enhancements.md` (§1.5 opt-in / loud reporting / cross-backend differences).
- Short-buffer EOF contract: `temp/gdsetpixels/` measurements (already recorded in the `setPixels` comment).
