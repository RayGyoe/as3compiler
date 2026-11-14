# Native shader passthrough (E6: GLSL ES 3.00 as the source language)

> English mirror of [`docs/zh-cn/native-shader.md`](../zh-cn/native-shader.md). The Chinese file is the
> canonical one and carries the longer measurement narrative; every decision, contract, table and command
> below is present here too. If the two ever disagree, the Chinese file wins — and that disagreement is a bug.
>
> This document answers: **what the "native shader passthrough" enhancement actually is, why it is necessary,
> which AS-side and compiler-side pieces it touches, how it is staged, and where the red lines are.** It is the
> design document for E6 in [`enhancements.md`](enhancements.md) §3 and the companion of
> [`display3d.md`](display3d.md) §3 — AGAL translation solves "matching AIR", this document solves
> "exceeding AIR".
>
> Conclusion first: **the source language is GLSL ES 3.00; Metal / D3D / Vulkan are reached with
> glslang + SPIRV-Cross cross-compiling to MSL / HLSL / SPIR-V; the Web backend (WebGL2) consumes the source
> verbatim with zero cross-compilation. MSL is a compile target for Metal, never a source language.** This is
> the same chain Flutter Impeller and Godot 4 already run in production.
>
> Neighbours: [`enhancements.md`](enhancements.md) (enhancement criteria and `--features`),
> [`display3d.md`](display3d.md) (Stage3D alignment and AGAL translation), [`compile.md`](compile.md) (manifest
> and backends), `asaot3d/three-api-design.md` §9 and §37 (render seam, `NativeShaderRenderer`).
>
> **Status (2026-11-03 re-check)**: M1 cross-compile chain / M2 compiler side / M3 Metal backend / M6 engine side are
> **landed and verified on device** — `asaot3d/apps/shader-m30` draws a quad from a pair of author-written
> GLSL ES 3.00 shaders and `drawToBitmapData` reads back centre `#804020` (= `uColor.rgb * vUV.x`) and
> `#361b0e` at 3/8; the same `.as` under a default build / `adl` prints `NO-CHANNEL` and exits 0 (§8 red
> line). **M3's capability surface** (float-target read/write, per-attachment MRT readback, depth texture as
> an attachment) was filled in by the 13 items of `apps/shader-m31` (stage 355); **M4 Web passthrough**
> landed in stage 358 (§6.11) — wasm consumes the GLSL ES 3.00 source verbatim while native still goes
> through glslang + SPIRV-Cross; **M7 Ultra-Water alignment** landed on the engine side in
> `apps/ocean-m34` (86 passes/frame, 7 self-checks all PASS).
> **M5 D3D12/HLSL** has landed and been accepted on real hardware (2026-11-14, §6.12): the
> same `shader-m30` passes all 15 checks and reads back `#804020` in an AOT Windows build.
> **Still not done**: `sampler2DShadow` comparison sampling for depth textures (the contract
> stands at "depth = render attachment"), and offscreen MSAA on this backend (§6.10, rejected
> loudly). Work breakdown and per-item as-built notes are in
> [`native-shader-plan.md`](native-shader-plan.md).

---

## 1. What E6 is and what it solves

### 1.1 One sentence

Stage3D's shader language is **AGAL** (Adobe Graphics Assembly Language, binary bytecode) with an **ES 1.00
level** ceiling baked into the specification. E6 opens a **path that bypasses AGAL and submits native shader
source directly**: the author writes GLSL ES 3.00, and it is cross-compiled to each backend at runtime.

### 1.2 The trigger

Porting [Ultra-Water](https://github.com/Humpalumps/Ultra-Water) (a three.js/WebGL2 Tessendorf FFT ocean
demo) hit AGAL's hard ceiling: its whole "FFT simulation + HDR pipeline + caustics + atmosphere LUT +
underwater" stack rests on **float render targets + MRT + `texelFetch` + integer types**, none of which
Stage3D's standard `Context3D` profile provides.

E6's scope is **not** Ultra-Water alone: every three.js `ShaderMaterial`-shaped workload (GPU particles,
fluids, volumetric fog, screen-space reflections, compute-style post-processing) sits under the same AGAL
ceiling. E6 paves the "author writes shaders" road once.

---

## 2. Inventory: what already exists

State the facts first so nothing is built twice.

| Existing capability | Where | Value for E6 |
|---|---|---|
| **AGAL three-target translator** `as_agal_translate` | `src/runtime.ts` (AGAL bytecode → MSL / GLSL ES / HLSL), `ASC_AGAL_TARGET` (MSL=0 / GLSL=1 / HLSL=2) | proves the **emission pipeline** "shader source string → per-backend text → glue compile" exists; E6 only swaps the **source language** (AGAL → GLSL ES 3.00) and the **compiler** (hand-written translation → glslang+SPIRV-Cross) |
| **Three self-contained GPU glue files** | `vendor/stage3d_glue.mm` (Metal) / `stage3d_webgl.cc` (WebGL2) / `stage3d_d3d.cc` (D3D12), one `s3d_*` interface | E6's new capabilities (float RT / MRT / native program submission) land in these three layers; the front-end pipeline is untouched |
| **`Context3DTextureFormat` deviates from AIR in 4 places** | `src/symbols.ts:7556`: missing `RGBA_HALF_FLOAT`, extra `RGBA`, wrong `BGR_PACKED`/`BGRA_PACKED` values | this is a **legacy debt** (unrelated to E6, must be fixed); E6's superset formats (`RGBA_FLOAT`/`R32F`…) go through `Context3DNative` instead, see §6.1 |
| **Render seam `IRenderer`** | `asaot3d/seam/asaot/three/IRenderer.as`: `render(scene,camera)` + `setSize(w,h)` | E6's engine-side landing spot is the second implementation: `NativeShaderRenderer` |
| **`AGALRenderer`** (default backend) | `asaot3d/seam/asaot/three/AGALRenderer.as`, machine-generated AGAL PBR (GGX/IBL/shadows/tone map) | fidelity reference and fallback for complex workloads; E6 does not compete for the default, it is an opt-in bypass |
| **E6 already reserved in the design doc** | `three-api-design.md` §9 table: `NativeShaderRenderer`, bypasses AGAL, E6 opt-in later | interface shape fixed, implementation missing |
| **E6 already registered in the enhancement list** | `enhancements.md` §3 / `TODO.md` `### 增强待做` | this document moves it from "unscheduled" to "scheduled" |

---

## 3. Verdict: an "enhancement", not "legacy debt"

E6 hits all five criteria of [`enhancements.md`](enhancements.md) §1.2:

| # | Criterion | E6 |
|---|---|---|
| a | Outside AIR semantics | `adl`'s `Context3D` **never had** float RT / MRT / `texelFetch` / a native shader submission API. The same `.as` either throws under `adl` or the API shape simply does not exist |
| b | Never silent | when the AIR side (adl) does not support it, it **says so**; no "looks like it worked, actually black" degradation |
| c | Cross-end differences listed explicitly | §9: **AOT-only**; the AIR side either fails loudly, and docs + runtime errors both say why |
| d | Opt-in, default build not inflated | named switch `--features native-shader`; the default build does **not** link glslang/SPIRV-Cross (multi-MB static libraries, §6.3) |
| e | Passes the DoD | §11: `examples/*.as` + assertion regression + docs + version bump |

**The distinction that must not be blurred**:

- "**`adl` runs it correctly, we cannot**" ⇒ **legacy debt**, goes into `### 遗留待开发`.
- "**`adl` errors out anyway / the API does not exist**" ⇒ **enhancement**, goes into `### 增强待做`.

E6 is the latter: Adobe's Stage3D has no float render targets and no native shader passthrough **by design**.
This is AIR's capability boundary, not a hole in our implementation. Landing E6 is a **gain**, not catching up.

---

## 4. Source language: GLSL ES 3.00, MSL as target only

### 4.1 Industry fact (what Flutter / Unity / Godot / Web actually do)

| Platform / engine | Source language (author-written) | Mechanism to each backend |
|---|---|---|
| **Unity** | **HLSL** (wrapped in ShaderLab) | HLSL → GLSL / MSL / SPIR-V (in-house chain) |
| **Flutter (Impeller)** | **GLSL / SkSL** | glslang (GLSL→SPIR-V) + SPIRV-Cross (SPIR-V→MSL/SPIR-V) |
| **Godot 4** | **GLSL dialect** | same SPIRV-Cross chain to GLSL/HLSL/MSL/SPIR-V |
| **Web (WebGL2)** | **GLSL ES 3.00** | WebGL's only language, runs natively |
| Desktop native | — | Metal=MSL, D3D12=HLSL, Vulkan=SPIR-V, GL=GLSL |

The pattern is consistent: **nobody uses MSL as a source language.** MSL is Metal's target language, the
end of the chain, never the start.

### 4.2 Why GLSL ES 3.00 and not MSL

1. **MSL is a single-vendor Apple language; making it the source cuts you off from cross-platform.** Android
   (Vulkan/GLES), Windows (D3D) and Web would all need an "MSL → X" compiler, and there is **no mature
   toolchain** taking MSL as input (SPIRV-Cross goes SPIR-V in, MSL out; nobody does the reverse).
2. **GLSL is the largest common denominator**: GLSL → SPIR-V → {MSL / HLSL / GLSL / SPIR-V}, all four
   directions with official Khronos tools.
3. **Ultra-Water is already GLSL3**: a dozen shaders copy over with zero rewrite — the deciding vote.
4. **The Web backend comes for free**: `--target wasm` (emcc) targets WebGL2, which eats GLSL ES 3.00
   natively — **zero cross-compilation** on that path.

### 4.3 Why ES 3.00 and not ES 1.00

The existing AGAL translator's GLSL target emits **ES 1.00** (`attribute`/`varying`/`texture2D`, no `#version`
directive; see the `runtime.ts` comments and [`display3d.md`](display3d.md) §3). But everything E6 needs is
ES 3.00-only:

| Feature | ES 1.00 | ES 3.00 | Ultra-Water dependency |
|---|---|---|---|
| `texelFetch` | no | yes | `OceanSim.js` FFT indexing, `UnderwaterPass.js`, `WaterQuery.js` |
| Integer types `uint` / bit ops | no | yes | PCG hash, FFT indexing |
| Explicit `textureLod` | no | yes | `OceanSurface.js` vertex band-limited displacement, caustics, atmosphere LUT |
| `layout(location=N) out` (MRT) | no | yes | `OceanSim.js` writes two RTs per FFT stage |
| `gl_InstanceID` | no (`runtime.ts` **rejects loudly** for this reason) | yes | `terrain.js` instancing |
| Vertex texture fetch | optional extension | core | `OceanSurface.js` vertex `textureLod` displacement |
| `sampler2DShadow` (shadow compare) | no | yes | `OceanSurface.js`, `UnderwaterPass.js` |

So E6's source language **must** be ES 3.00; the existing AGAL→GLSL(ES 1.00) output cannot be reused.

---

## 5. Cross-compile chain: glslang + SPIRV-Cross (linked C libraries, not npm dependencies)

### 5.1 Shape of the chain

```
GLSL ES 3.00 (author-written)
      │  glslang (Khronos)
      ▼
    SPIR-V (IR)
      │  SPIRV-Cross (Khronos)
      ├──────────────┬──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
    MSL           HLSL          GLSL(ES3)      SPIR-V
 (Metal)       (D3D12)        (WebGL2 passthru) (Vulkan)
```

### 5.2 Why this is legitimate (correcting a common misreading)

The "zero third-party dependencies" rule in `AGENTS.md` §3.1 **only forbids npm/TypeScript dependencies in
`package.json`**; it does **not** forbid §2.9's "link C libraries" — that is how skia, SDL and libcurl got in.
glslang and SPIRV-Cross are **Apache-2.0** Khronos libraries, linked as C/C++ static archives, fully compliant.
**No in-house cross-compiler is needed** — that would be the truly fatal amount of work, and Flutter Impeller
already runs this road in production.

### 5.3 Mapping onto our backends

| Backend | Source | Chain | Artefact | New dependency |
|---|---|---|---|---|
| **Metal (macOS/iOS)** | GLSL ES 3.00 | glslang → SPIR-V → SPIRV-Cross → **MSL** | MSL string → `id<MTLLibrary>` (reuses the existing `newLibraryWithSource:`) | glslang + SPIRV-Cross |
| **D3D12 (Windows)** | GLSL ES 3.00 | same chain → **HLSL** | HLSL → `D3DCompile` (reused) | same |
| **Vulkan / GL** (future) | GLSL ES 3.00 | same chain → SPIR-V / GLSL | direct | same |
| **Web (WASM+emcc)** | GLSL ES 3.00 | **passthrough** (native WebGL2) | verbatim `compileShader` | **none** |

> **Web is the first free point**: `vendor/stage3d_webgl.cc` is pinned at `-s MAX_WEBGL_VERSION=2`, and WebGL2
> accepts both ES 1.00 and ES 3.00 sources, so native shaders on the web need **no** glslang/SPIRV-Cross at
> all — hand the author source to `compileShader`. The only missing piece is enabling the WebGL2 float-RT
> extensions (`EXT_color_buffer_float` / `EXT_color_buffer_half_float`).

### 5.4 Compile timing: runtime (same shape as three.js)

three.js's `ShaderMaterial` compiles at **runtime**: author source is a string literal in AS3, becomes a C
string constant, and the backend compiles it at run time. E6 is the same shape: **glslang + SPIRV-Cross are
linked into the product as runtime libraries**; the first use of a shader cross-compiles and caches it (same
idea as the existing `AGALTranslator` program cache, [`display3d.md`](display3d.md) §9.11).

> The alternative (build-time precompile to MSL/HLSL strings embedded in the binary) saves runtime size when
> author shaders are static constants, but conflicts with three.js's "uniform/define-driven shader chunk
> assembly" model, so **the main path is runtime**; build-time stays a possible PGO-style optimisation.

---

## 6. Compiler side (as3compiler) work list

The compiler side is the pipe: expose native shader submission + float RT + MRT as AS3 APIs and wire them
into the three glue files.

### 6.1 Texture format landscape (three layers: AIR alignment → E6 superset → per-end mapping)

The earlier draft listed "a few float formats for Ultra-Water", missing what AIR already has and never
separating **debt** from **enhancement**. After checking AIR's authoritative `Context3DTextureFormat` set
([airsdk.dev](https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3DTextureFormat.html)),
formats must be split into **three layers**, otherwise debt and enhancement end up in one table.

#### Layer 1 — AIR alignment (legacy debt, unrelated to E6, must fix)

AIR's official set is **6 constants**. Our `src/symbols.ts:7556` deviates in **4 places**:

| Constant | Authoritative AIR value (Runtime) | Ours (`symbols.ts:7556`) | Verdict |
|---|---|---|---|
| `BGRA` | `"bgra"` (AIR 3) | `"bgra"` | ✅ |
| `BGR_PACKED` | `"bgrPacked565"` (AIR 3.7) | `"bgrPacked"` | ❌ wrong value (missing `565`) |
| `BGRA_PACKED` | `"bgraPacked4444"` (AIR 3.7) | `"bgraPacked"` | ❌ wrong value (missing `4444`) |
| `COMPRESSED` | `"compressed"` (AIR 3) | `"compressed"` | ✅ |
| `COMPRESSED_ALPHA` | `"compressedAlpha"` (AIR 3.4) | `"compressedAlpha"` | ✅ |
| `RGBA_HALF_FLOAT` | `"rgbaHalfFloat"` (AIR 14) | **missing** | ❌ absent |
| (AIR has no such constant) | — | `RGBA: "rgba"` | ❌ extra |

These four are "`adl` gets it right, we get it wrong or cannot run it" ⇒ per `AGENTS.md` §1.5 they are
**legacy debt**, filed under `### 遗留待开发`, **unrelated to E6 and mandatory**. The C runtime is equally
incomplete: `emit.ts`'s `Texture_uploadFromByteArray` knows only `"bgra"`/`"rgba"` and routes the rest to
`as_shell_unsupported`. The missing `RGBA_HALF_FLOAT` was already registered in `TODO.md` (stage
two-hundred-twenty-six); this table adds the other three (the extra `RGBA`, the two wrong packed values).

#### Layer 2 — E6 superset (AIR superset, opt-in, via `Context3DNative`)

**First, correct an attribution error**: the `RGBA16F` Ultra-Water uses heavily (`RGBAFormat` +
`HalfFloatType`, the workhorse of the HDR pipeline) is AIR 14's existing `RGBA_HALF_FLOAT` (layer 1), **not**
an E6 enhancement — its absence is legacy debt fixed by layer 1. Layer 2 only adds formats AIR **lacks**:
full-precision float, non-RGBA half float, integer, SNORM, depth/stencil.

Below is the **complete renderable texture-format surface** of GLSL ES 3.00, systematised by "channels ×
precision". `★` = actually used by Ultra-Water; unmarked entries are part of the complete capability surface
but untouched by Ultra-Water.

**(a) Float formats** (colour-renderable needs a runtime extension):

| Format | Channels × precision | Metal `MTLPixelFormat` | WebGL2 (extension) | D3D12 `DXGI_FORMAT` | Ultra-Water |
|---|---|---|---|---|---|
| `RGBA_FLOAT` | RGBA32F | `RGBA32Float` | `EXT_color_buffer_float` | `R32G32B32A32_FLOAT` | ★ OceanSim FFT output / WaterQuery |
| `R32F` | R32F | `R32Float` | `EXT_color_buffer_float` | `R32_FLOAT` | ★ caustics / shoreMap / terrain / floaterShadow |
| `RG32F` | RG32F | `RG32Float` | `EXT_color_buffer_float` | `R32G32_FLOAT` | — (surface) |
| `R16F` | R16F | `R16Float` | `EXT_color_buffer_half_float` | `R16_FLOAT` | — (surface) |
| `RG16F` | RG16F | `RG16Float` | `EXT_color_buffer_half_float` | `R16G16_FLOAT` | ★ caustics (displacement + slope) |
| `R11G11B10F` | RGB10F | `RG11B10Float` | `EXT_color_buffer_float` | `R11G11B10_FLOAT` | — (surface; cheap HDR colour) |
| `R8` | R8 UNorm | `R8Unorm` | `R8` (core, no extension) | `R8_UNORM` | — (surface; single-channel packing) |

> Note: `RGBA16F` (= `RGBA_HALF_FLOAT`) is **deliberately absent** from this table — it is layer 1, present in
> AIR 14. Only full-precision `RGBA_FLOAT` is layer 2, absent from AIR. Do not conflate the two.

**(b) Integer formats** (`uint`/`int` types + integer `texelFetch`; Ultra-Water's PCG hash runs inside the
shader and writes float RTs, but E6 as a complete surface should support integer textures):

| Format | Metal | WebGL2 | D3D12 |
|---|---|---|---|
| `R8I` / `R8UI` | `R8Sint` / `R8Uint` | `R8I` / `R8UI` | `R8_SINT` / `R8_UINT` |
| `R16I` / `R16UI` | `R16Sint` / `R16Uint` | `R16I` / `R16UI` | `R16_SINT` / `R16_UINT` |
| `R32I` / `R32UI` | `R32Sint` / `R32Uint` | `R32I` / `R32UI` | `R32_SINT` / `R32_UINT` |
| `RG32I` / `RG32UI` / `RGBA32I` / `RGBA32UI` | corresponding `Sint`/`Uint` | corresponding | corresponding |

**(c) Normalised integers (SNORM)** (`-1..1` fixed point, one precision step better than `UNORM`; capability
surface, optional):

| Format | Metal | WebGL2 | D3D12 |
|---|---|---|---|
| `R8_SNORM` / `RG8_SNORM` / `RGBA8_SNORM` | `R8Snorm` / `RG8Snorm` / `RGBA8Snorm` | same names | `R8_SNORM` / `R8G8_SNORM` / `R8G8B8A8_SNORM` |
| `R16_SNORM` / `RG16_SNORM` / `RGBA16_SNORM` | `R16Snorm` / `RG16Snorm` / `RGBA16Snorm` | same names | `R16_SNORM` / `R16G16_SNORM` / `R16G16B16A16_SNORM` |

**(d) Depth / stencil formats** (depth textures + shadow compare sampling, §6.4; Ultra-Water uses
`FloatType` depth, i.e. `DEPTH_COMPONENT32F`):

| Format | Metal | WebGL2 | D3D12 | Ultra-Water |
|---|---|---|---|---|
| `DEPTH_COMPONENT16` / `24` / `32F` | `Depth16Unorm` / (no 24) / `Depth32Float` | `DEPTH_COMPONENT16` / `24` / `32F` | `D16_UNORM` / `D24_UNORM_S8_UINT` / `D32_FLOAT` | ★ `32F` (main.js:117 / floaterShadow.js:22) |
| `DEPTH24_STENCIL8` / `DEPTH32F_STENCIL8` | `Depth24Unorm_Stencil8` / `Depth32Float_Stencil8` | `DEPTH24_STENCIL8` / `DEPTH32F_STENCIL8` | `D24_UNORM_S8_UINT` / `D32_FLOAT_S8X24_UINT` | — (surface) |

> **Modelling warning**: the format surface has two capability layers — "renderable" (as an RT attachment) and
> "sampleable" (bound as a shader texture). In GLES 3.0 not every format is both (integer formats render but
> must be read with integer samplers). The three glue files must consult WebGL2's `color-renderable` and
> `texture-filterable` tables separately; "the format name exists" is not enough.

#### Layer 3 — Per-end mapping

The **union** of layers 1 and 2 must land in all three glue files (`MTLPixelFormat` selection in
`vendor/stage3d_glue.mm`, `DXGI_FORMAT` in `vendor/stage3d_d3d.cc`, `internalformat` in
`stage3d_webgl.cc`) instead of the current "BGRA8 only" on all three. The Metal/WebGL2/D3D12 columns of
(a)–(d) above together are that mapping's work list.

**Modelling rule** (consistent with the "option B" decision in §7.5): layer 1 is a **fix** (align
`Context3DTextureFormat` with AIR's six constants); layer 2 formats **must not** be pushed into
`Context3DTextureFormat` — that would give the default product constants AIR does not have, breaking
`AGENTS.md` §1.5's "default product isomorphic to AIR". Hence:

- **(A) Conditional symbols — incompatible with runtime probing, rejected.** `Context3DTextureFormat.RGBA_FLOAT`
  is a **constant reference**, and AS3 has no runtime probe for "does this constant exist" (`describeType`
  could, but it drags in XML/E4X, which the project deferred — see `TODO.md` stage eighty-six).
- **(B) New class `Context3DNative` — adopted.** Layer 2 float/depth formats, MRT (§6.2), native shader
  submission (§6.3) and depth textures (§6.4) **all** go into this one AOT-only class, probed by the author
  with `getDefinitionByName` (the §7.4 factory pattern). `Context3DTextureFormat` itself only performs
  **layer 1 alignment** (still AIR's six constants, no more, no less).

### 6.2 Render targets: MRT (the second hole)

Existing MRT (`fo0..fo3`) is implemented **only for HLSL** ([`display3d.md`](display3d.md) §3 says MSL/GLSL
fold into a single output). The E6 native path must support `layout(location=N) out` on **all three**
(OceanSim.js's FFT writes two RTs per stage). The complete semantics include:

**a. Attachment count limit** (differs per end, must be queried at runtime):

- Metal: no fixed limit in `MTLFeatureSet` (modern hardware ≥ 8).
- WebGL2: the spec guarantees **≥ 4** (`MAX_DRAW_BUFFERS`); query beyond that. Ultra-Water uses 2
  (`location=0/1`), safe.
- D3D12: `SV_Target0..7` (≥ 8).

**b. Per-attachment blending**: ES 3.00 supports per-attachment blend state (`glBlendEquationi` /
`glBlendFunci`), Metal configures per attachment via `MTLRenderPipelineColorAttachmentDescriptor`, D3D12 via
`D3D12_BLEND_DESC`'s `RenderTarget[N]`. E6 must pass **per-attachment** blend when submitting MRT, not one
global blend.

**c. WebGL2's format-consistency hard constraint** (the easiest trap): the WebGL2 spec requires all colour
attachments of an MRT to have **identical formats** (not just identical sizes), and identical width/height.
Metal/D3D have no such restriction (mixed-format MRT works). Ultra-Water's two FFT levels write the **same**
format into `out0`/`out1` (displacement/slope of one cascade), so all three hold — but E6 as a generic
capability must register this difference so authors do not assume "any two float formats can share one MRT".

**d. Attachment renderability**: every attachment format must be colour-renderable (§6.1 layer 2's warning);
integer attachments cannot be read by float samplers and vice versa, and the shader's `out` type must match
the attachment format.

**e. Degrading to a single output**: the current MSL/GLSL implementations fold `fo0..fo3` into one output —
the AGAL path keeps that behaviour; the E6 native path **does not fold**, `layout(location=N)` maps straight
to multiple attachments.

### 6.3 Native shader submission API (the core addition)

Today `Program3D.upload()` takes AGAL bytecode. E6 adds an entry point that takes **source**, **inside §6.1's
option B `Context3DNative`** (a new class, discoverable with `getDefinitionByName`, see §7.4).

Internally it runs a path parallel to `as_agal_translate`:
`GLSL ES 3.00 source → (native) glslang+SPIRV-Cross → MSL/HLSL → glue compile; → (web) verbatim compileShader`.

**The complete API surface** (submitting source is not enough on its own; these are also needed):

**a. Program lifecycle + error logs**: after `uploadProgram(vertexSource, fragmentSource)` there must be
`link()` and **compile/link logs** (the equivalent of `getProgramInfoLog`/`getShaderInfoLog`). GLSL ES 3.00 is
strict; the author's first attempt almost always fails to compile, and without an info log that is debugging
blindfolded. Logs must be surfaced to AS3 (`Error` + raw log text), never swallowed in C.

**b. Uniform binding**: three.js `ShaderMaterial`'s `uniforms` map onto GLSL uniforms. Three kinds:

- scalars/vectors/matrices (`float/int/bool`, `vec*`/`mat*`): plain `setUniform`.
- samplers (`sampler2D`/`samplerCube`/`sampler2DShadow`…): bind the **texture unit number**
  (`setUniform1i` to a unit), with the texture bound separately via `bindTexture(unit, texture)`.
- uniform arrays (`uImpact[8]`, OceanSurface.js): set element by element, not just the first slot.

**c. Vertex attribute layout**: GLSL ES 3.00 uses `layout(location=N) in` or runtime `bindAttribLocation`. E6
must expose "attribute name/location → vertex buffer + stride + offset" (three.js `BufferGeometry`
attributes). Unlike AGAL's `va0..va7` registers, native attribute locations are **declared in the author's
source**; E6 cannot assume fixed register numbers.

**d. Uniform buffer objects (UBO, optional)**: ES 3.00 supports `layout(std140) uniform`. Ultra-Water does not
use it (few uniforms), but E6 as a complete surface should, otherwise future shaders hit "uniform count
limit" with no way out. (Interim as-built: UBO is **not implemented**; nothing in the runtime computes std140
offsets, and `ShaderMaterial` carries no `uniformsGroups`.)

**e. Program cache**: cross-compilation and backend compilation cost time; key the program object by
"vertexSource + fragmentSource + defines hash" and reuse the `AGALTranslator` cache idea
([`display3d.md`](display3d.md) §9.11).

Sketch (illustrative, not the final API shape — §12):

```as3
var nat:Object = RendererFactory.nativeContext();   // getDefinitionByName + try/catch inside, §7.4
if (nat != null) {
    var prog:Object = nat.uploadProgram(vertexSource, fragmentSource);  // compile + link
    if (nat.hasError(prog)) throw new Error(nat.getInfoLog(prog));      // surface the log
    nat.bindAttribute(prog, "position", vbo, stride, offset);           // vertex layout
    nat.setUniform1i(prog, "uDisp0", 0);  nat.bindTexture(0, dispTex);  // samplers
    nat.setUniform4fv(prog, "uImpact", impactArray);                    // uniform arrays
    nat.draw(prog, triCount);                                           // draw
}
```

### 6.4 Depth textures

`OceanSurface.js`'s depth-validated refraction (`main.js:117`'s `uSceneDepth`) samples the scene depth
texture. Stage3D cannot read depth. E6 fills that in; the complete semantics include:

**a. Depth format + binding**: `createTexture(DEPTH_COMPONENT16/24/32F)` bound as a depth attachment
(§6.1 layer 2 (d)). Metal `Depth32Float` / WebGL2 `DEPTH_COMPONENT*` / D3D12 `D32_FLOAT`.

**b. Sampled depth value semantics**: sampling a depth texture yields **non-linear depth** (NDC `z ∈ [0,1]`);
`linearDepth(z, near, far)` recovers view-space distance — exactly OceanSurface.js:414's
`linearDepth(textureLod(...).r)`. E6 must not treat the sampled value as a distance; near/far must be exposed
as uniforms.

**c. Comparison sampling `sampler2DShadow`** (needed for shadow mapping, used twice by Ultra-Water):
OceanSurface.js:271 and UnderwaterPass.js:17 declare `precision highp sampler2DShadow` alongside `uShadowMap`
(main.js:401's `sunLight.shadow.map.depthTexture`). ES 3.00-only: the `depth <= ref` comparison happens **in
hardware at sample time** and returns 0/1, replacing ES 1.00's manual `texture2DProj` compare. Metal maps it
to `MipmapFilter` + `CompareFunction`, D3D12 to `D3D12_COMPARISON_FUNC`; both must be set in the sampler state.
(Interim as-built: SPIRV-Cross emits a plain sampler and the comparison is done in the shader, so
`sampler2DShadow` hardware compare is **not** what you get today.)

**d. Framebuffer with depth + colour together**: `main.js:116-117`'s HDR RT carries both a colour attachment
(`RGBA16F`) and a depth attachment (`DepthTexture`), and both are sampled by later passes. E6's
`Context3DNative` must support "one RT producing sampleable colour **and** depth" — the common base for
depth-validated refraction, shadows and SSR.

**e. Sampler distinction for depth**: a depth texture must be sampled as `sampler2D` (float read) or
`sampler2DShadow` (compare read); WebGL2 restricts `texture-filterable` for depth formats, Metal/D3D have
equivalent constraints — it cannot be treated like an ordinary colour texture.

### 6.5 Build layer (build.ts + build-tools)

1. **glslang + SPIRV-Cross into `build-tools/`** (same level as `skia-src/`, `emsdk/`), producing native static
   archives.
2. **Register the named switch**: `--features native-shader` → `ASC_USE_NATIVE_SHADER=1`, added to `build.ts`'s
   FEATURES registry ([`enhancements.md`](enhancements.md) §1.4). **Available targets**: `native` today; `web`
   comes with M4's passthrough and needs **no** cross-compiler. **AIR is not supported** (§8).
3. **Manifest fields**: `link-libs`/`link-paths` for the glslang/SPIRV-Cross archives (native only); the web
   target links nothing (passthrough, zero dependency).
4. **Banner**: when enabled the build banner prints
   `== enhancements: native-shader (-D ASC_USE_NATIVE_SHADER=1) ==` and states this is an AIR superset
   ([`enhancements.md`](enhancements.md) §1.4's fixed action).

### 6.6 Runtime glue (vendor/stage3d_*.cc)

- **Metal (first batch)**: `stage3d_glue.mm` gains float-RT `MTLPixelFormat` branches, MRT multiple colour
  attachments, depth textures, `[[instance_id]]` (already present, AGAL `iid` uses it), and a "compile native
  MSL directly" entry that bypasses AGAL translation and feeds SPIRV-Cross output to `newLibraryWithSource:`.
- **WebGL2 (the second free point)**: `stage3d_webgl.cc` enables and queries `EXT_color_buffer_float` /
  `EXT_color_buffer_half_float`; native shaders go straight to `compileShader` (no cross-compilation).
- **D3D12 (third batch)**: `stage3d_d3d.cc` gains float `DXGI_FORMAT`s, MRT (`SV_TargetN` already works) and a
  native HLSL compile entry.

> **`ASC_AGAL_TARGET` and E6 are two different things.** `ASC_AGAL_TARGET` picks "which target language AGAL is
> translated to"; E6 picks "which target language native GLSL ES 3.00 is cross-compiled to". The target sets are
> the same (MSL/GLSL/HLSL) but the **source languages differ** (AGAL vs GLSL ES 3.00). Never merge them into one
> macro.

### 6.7 Reachability for runtime probing (the critical prerequisite)

§7.4 decided "runtime probing", but as-aot's `getDefinitionByName` (`emit.ts:3170`'s `as_class_registry[]`)
**only holds classes in the compile face**; and `getDefinitionByName("…NativeShaderRenderer")` takes a
**string literal**, which produces no reference edge in `reach.ts` ⇒ with `--features native-shader` on, the
class still **never enters the compile face**, the registry lacks it, and probing throws `#1065` anyway. This
differs in kind from the `AGALTranslator` precedent — that one is an as-aot built-in class, permanently in the
compile face.

**Decided (§12 ⑤): option 2** — manifest field `extra-roots: ["asaot.three.NativeShaderRenderer"]` plus CLI
`--extra-roots a.b.C,d.E` (because `--air-app` rewrites `<Main>.build.json` on every run, a manifest-only field
is unusable from build scripts). `[WasmExport]` was rejected: that annotation would have to serve two masters
(JS export / closure root), which is not a single meaning.

As-built: `computeReachable(parsedFiles, mainClass, [...swcBaseRoots, ...cfg.extraRoots])`; names are pushed
into the root set, **no path resolution**; deduplicated; a name that matches no class is **silently ignored**
(the manifest must be reusable across builds). Measured: in `shader-m30` the single line in the `extra-roots`
file does pull `NativeShaderRenderer` into the closure (65/123 sources); the three `unit: reach/*` assertions
(resurrect an unreferenced class / resurrect only it / ignore an undeclared name) pin the behaviour.

### 6.8 Shader language features AGAL cannot express (native path gets them for free)

§4.3 lists ES 3.00-only features; this section ties them to actual capabilities. These are used by
Ultra-Water, absent from AGAL, and supported by E6's native path automatically (author GLSL ES 3.00 goes
straight to the backend) — but they must be listed completely so nobody assumes support that is not there:

| Feature | Ultra-Water site | AGAL | E6 native path |
|---|---|---|---|
| **Instancing** (`gl_InstanceID` / `instanceMatrix`) | terrain.js:256 `InstancedMesh`, terrain.js:170/175 `instanceMatrix` | none (`runtime.ts` rejects loudly because ES 1.00 has no `gl_InstanceID`) | Metal `[[instance_id]]` (exists), WebGL2 native, D3D12 `SV_InstanceID` |
| **Vertex texture fetch** | OceanSurface.js:223-225 vertex `textureLod` displacement | none (ES 1.00 optional `VERTEX_TEXTURE_FETCH`) | ES 3.00 core, native on all three |
| **Shadow compare sampling** `sampler2DShadow` | OceanSurface.js:271, UnderwaterPass.js:17 | none (ES 1.00 manual `texture2DProj`) | §6.4(c) — today the comparison is done in the shader, not in hardware |
| **Integer types + bit ops** `uint`/`uvec2`/`^`/`>>` | OceanSim.js:38/41/51 PCG hash | none (AGAL has no integers) | ES 3.00 core, native on all three |

### 6.9 Channel constraint list (derived from M3 + the FFT ocean, 2026-11-02)

None of these five is "not implemented" — each is "writing it this way is wrong". Every one was forced out by
an actual crash or a silent black screen in `apps/shader-m31` / `apps/ocean-m32`; they are contract now:

| # | Constraint | Symptom (what you see) | Correct form |
|---|---|---|---|
| 1 | **Vertex attributes must carry `layout(location = N)`** | `MSL(vertex) compile failed: invalid type 'vs_main_in' of input declaration with attribute 'stage_in'` / `field with missing attribute 'attribute'` | `layout(location = 0) in vec3 aPos;`, numbered 0..n contiguously |
| 2 | **GLSL helper functions that read `uniform` do not translate** | `cannot bind reference in address space 'constant' to object in default address space` | Inline it; or copy the uniform into a local first (`vec3 w = uFoo;`) and pass that (locals live in the `thread` address space) |
| 3 | **Integer uniforms must not go through `setUniform1f`** | Pass 2, the shader reads `1073741824` (the IEEE bit pattern of `2.0`) | `Context3DNative.setUniformInts(program, name, values)`; the reflection's `base_type` decides the dispatch, `components`/`size` decide `setUniform1f..4f` / `setUniformFloats` / `setUniformMatrix4` |
| 4 | **Never submit a draw with an "empty" render-target set** | The Metal draw aborts; the process dies near `MTLResourceListAddResource` | Read the backbuffer with `setBackBuffer()` (or `setRenderToBackBuffer()`); never `setRenderTargets([], null)` |
| 5 | **`drawToBitmapData`'s destination may be smaller than the backbuffer** (a compiler defect fixed in this round) | The readback is correct, then the **next** frame dies inside Metal (method cache corrupted) — looking like "a Metal bug" | Clip the copy to the **destination** size (`min(bb, dest)`); the old code wrote the full backbuffer, so a 64x64 probe wrote through a 256 KB heap buffer |

Item 5 is a **semantic defect** in `Context3D.drawToBitmapData`, not a channel problem: AIR requires the
destination to be no smaller than the backbuffer, we relax that to "copy the overlap, leave the rest alone" —
but **never write out of bounds**. That defect had been there since the first readback probe; the probe then
exited immediately so the heap corruption never surfaced, until a 34-passes-per-frame ocean caught it.

### 6.10 Render-target MSAA: `setRenderTargetSamples` (M34, enhancement)

`ASC_S3D_MSAA` multisamples the **drawable** only; offscreen targets were pinned to one sample (D54/D55).
The offscreen-chain apps need edge antialiasing there, so M34 adds a **per-target** knob:

```as3
var ok:Boolean = ctxNative.setRenderTargetSamples(waterTex, 4);   // 1 / 2 / 4 / 8
```

The channel allocates a same-size multisample companion for that target and tracks whether it still holds
unresolved samples. A later pass renders into the companion **only if every attachment in that pass has the
same sample count**; otherwise it silently falls back to one sample (no error, no slow path). Resolution is
**lazy** — performed before sampling bind, `bindTexture`, `get_render_target`, `generateMipmaps` and the frame
flush — so the app always reads the single-sample texture and never has to know the companion exists.

Per target rather than global because the full-screen data passes (FFT atlases, metering grid, bloom
pyramid) cover every sample identically: multisampling them costs memory and a resolve for a bit-identical
result. Colour and depth must be attached together (Metal requires one sample count per pass).
`renderOverride` passes (shadow prepass, `drawToBitmapData`) stay at one sample (D54), and `generateMipmaps`
now encodes into the current frame's command batch — submitting an immediate command buffer would reorder it
against the draws under MSAA.

Measured (ocean-m34, frozen time, identical camera): off vs 4x differs on 1.58% of pixels (mean 0.185), and
92.5% of that lands on strong edges; the Breakers view shows 1.12% with hard-step pixels down 1.8%. A
difference covering flat surfaces means the wrong targets were multisampled.

**Boundaries**: `setRenderTargetSamples` does not touch the drawable (that still belongs to `ASC_S3D_MSAA`);
`renderOverride` passes (shadow prepass, `drawToBitmapData`) are always one sample (D54); the companion is
lost when the target is recreated, so the caller must push it again.

### 6.11 The WebGL2 passthrough arm: the same GLSL ES 3.00, no SPIR-V (2026-11-03)

The native channel used to have a single arm (Metal), and web/wasm builds **rejected**
`--features native-shader`, so the five demos M30/M31/M32/M33/M34 were written off as "native only". This
round judged that wrong: the author writes **GLSL ES 3.00**, which is exactly WebGL2's native shading
language — translating it to MSL and then running it in a browser is a trip around the world.

**Conclusion: wasm accepts `native-shader` too, but the two arms take different compile inputs.**

| | native (Metal / D3D12) | wasm (WebGL2) |
|---|---|---|
| Compile chain | glslang → SPIR-V → SPIRV-Cross → MSL/HLSL | **none**: ES 3.00 source goes straight to `glCompileShader` |
| Linked tool libs | links `vendor/glslang`, `vendor/SPIRV-Cross` (host archives) | **not linked** (`shader_compiler.cc` is not built; there is no SPIRV-Cross in wasm) |
| Reflection source | SPIRV-Cross's `spvc_*` resource list | **the driver**: `glGetActiveUniform` / `glGetActiveAttrib` on the linked program |
| Slot semantics | `spvc_compiler_msl_get_automatic_resource_binding`: `[[buffer(N)]]` / `[[texture(N)]]` | the same semantics: **numbered from 0 per (kind, stage)** (see below) |
| Limits | 31 buffers / 31 textures (per stage) | 16 texture units (both stages **share** one global unit namespace) |

`test/unit/native-shader.ts` pins this contract in four assertions: wasm accepts the feature, wasm does not
build `shader_compiler.cc`, wasm does not link `glslang`/`SPIRV-Cross`, and native still builds the shim when
the archives are present.

**Wiring (`vendor/stage3d_webgl.cc`, all inside `S3DContext`)**: `s3d_native_use` creates the program,
`s3d_native_uniform` stages a 64-byte payload per (stage, slot), `s3d_native_bind_texture` /
`s3d_native_set_sampler_state` record bindings, `s3d_native_set_targets` / `s3d_native_target_create` build
FBOs, and `s3d_native_reflect` replaces `asc_shader_translate` while filling the same `asc_shader_program`
(`translatedVertex/Fragment` are the author's source itself, and `asc_shader_backend_info` honestly reports
"driver reflection"). `s3d_native_layout` is a **no-op** on Metal (the bindings are already baked into
`[[buffer(N)]]` by SPIRV-Cross) and a required step on WebGL2 (GL addresses uniforms **by name**).

**Three "it compiles but the result is wrong" traps** (all WebGL2-only; structurally impossible on Metal):

1. **Reflection must run on the program after linking.** In GLES3 `glGetActiveUniform` is program-level;
   asking the compiled shader object always answers "no such uniform". The same place must attribute every
   program uniform to a stage — done by scanning the source with `s3d_declares_uniform(vs, name)` /
   `(fs, name)` — so `setUniform`'s (stage, slot) has the same key as Metal's `[[buffer(N)]]`.
2. **Slots are numbered per (kind, stage), not consecutively across kinds.** The first version numbered
   consecutively, so in a program with "a few uniforms + a few samplers" the samplers got slots 8..10 while
   the sampler table ends at 7 — the sky program therefore sampled unbound units and the entire ocean
   rendered **black with `glError == 0`**. The same spot had a second limit: the binding loop walked
   `S3D_MAX_TEX` (8, AGAL's texture-register ceiling) while native programs allow 16 samplers and
   `ocean-m32`'s water program declares 10 — the extra slots were silently skipped every time, so the
   displacement map read back as a constant (a glassy surface, spread 0/255).
3. **Front face must be flipped, not completed with cull modes.** AGAL's GLSL vertex-level negates clip-space
   Y, so `GL_CCW` happens to equal Stage3D's front; a native program writes `gl_Position` itself, without that
   negation, so the same triangles look reversed to GL. **Completing the cull modes fixes dM30's quad, but
   `gl_FrontFacing` is still inverted** — `ocean-m34`'s water pass then judged every fragment "underside"
   (49.9% underside / 0.2% top side, self-check red). The fix is one line:
   `glFrontFace(c->nativeMode ? GL_CW : GL_CCW)`.

**Acceptance**: all five demos are green in a real browser — `shader-m30` (`#version 300 es` passthrough,
centre pixel `#804020`), `shader-m31` (float32/half/MRT/depth/texelFetch/uint), `shader-m33` (helpers /
derivatives / blending / offscreen / atlas), `ocean-m32` (FFT displacement range `-1.498..1.420 m`, spread
186/255), `ocean-m34` (all 7 self-checks PASS: displacement `-10.0..10.0 m`, sky LUT `0.078..20.0`,
reflection `0.235..10.0`, caustics `0.000..1.042`, water coverage 49.9%/0.2%, shafts, from below).
**Remaining difference, registered honestly**: WebGL2's `setRenderTargetSamples` (§6.10) still "rejects and
says so" (offscreen MSAA needs a multisample renderbuffer plus `glBlitFramebuffer` resolution, and the
resolution must interleave with the pass chain rather than being a per-texture switch); the page prints one
line noting that edges stay single-sampled.

---

### 6.12 The D3D12/HLSL passthrough arm (M5, 2026-11-14)

The third arm of the native channel: the same GLSL ES 3.00 source on `stage3d_d3d.cc`, through
glslang -> SPIR-V -> SPIRV-Cross -> **HLSL** -> `D3DCompile`. **Acceptance**: an AOT Windows build of
`apps/shader-m30` passes all 15 checks, and `drawToBitmapData` reads back `#804020` at the centre and
`#31190c` three-eighths across -- the two sample points of `uColor.rgb * vUV.x`, bit-identical to the
Metal arm.

**Why the channel needs only two new things.** A native program is an ordinary `S3DProg`: `s3d_compile`
keys and caches it by the same FNV-1a source hash, it goes through the same PSO cache, the same
`TEXCOORD{slot}` input layout and the same `register(b0)` root signature, and what `D3DCompile` receives
(`vs_main`/`fs_main` plus HLSL text) has exactly the shape the AGAL path already produces. The one thing
AGAL had for free is a 256-register file whose lanes the compiler knew at build time, so the additions are
exactly two:

- **the byte offsets inside `$Globals`**, answered by `D3DReflect` (`s3d_native_reflect_stage` plus
  `s3d_native_resolve` joining by name). Hand-computed offsets are not an option: HLSL packs a cbuffer by
  its own rules (a `float3` is followed by a float, matrix rows are 16-byte aligned), so a guessed offset
  compiles, samples the wrong lane, and reports nothing at all;
- **one staged block per stage** (a whole `S3D_CB_REGION`), memcpy'd into the bump allocator shared with
  the AGAL path before the frame's first draw. Sharing one allocator is deliberate: the two channels never
  draw at the same time.

`s3d_native_layout` is mandatory on this backend (on Metal the bindings are already baked into
`[[buffer(N)]]` and it is a no-op), but all it has to do is match names to offsets; `s3d_native_uniform`
matches on `(kind == uniform, stage, slot)`, writes, and clamps to the variable's byte size.

**Five real defects, all of the "compiles and produces the wrong/empty picture" kind** (each measured):

1. **Combined image-sampler bindings all collapse to 0.** Every sampler
   `build_combined_image_samplers` creates carries no binding decoration in OpenGL mode, and
   `spvc_hlsl_resource_binding` is keyed on `(set, binding)` -- so two textures were pinned to the same
   `t1`. Fix: `set_decoration(SpvDecorationBinding, i)` before generation, then set
   `srv/sampler.register_binding` from the same `i`.
2. **GLSL ES 3.00 attributes carry no Location decoration.** glslang only emits one for
   `layout(location=N)`, and `spvc_compiler_get_decoration` answers 0 for a missing decoration -- so
   `in vec3 aPos; in vec2 aUV;` reflected as **aPos=0 and aUV=0** while SPIRV-Cross actually wrote
   `aPos : TEXCOORD0, aUV : TEXCOORD1`. A host binding streams by the reflected slot fed one stream twice.
   Fix: a **two-pass** location pinner before code generation (collect the undecorated inputs ranked by
   SPIR-V id, then write them all; a one-pass version makes the just-ranked input look decorated).
3. **HLSL matrices must be declared `row_major` (the expensive one).** SPIRV-Cross translates GLSL
   `M * v` into `mul(v, M)`, which is only equivalent when the matrix arrives **transposed**; this project
   (and the Metal arm, the AGAL arm, three.js convention) uploads **column-major** bytes, so the product
   silently became `M^T v`. An identity-ish quad matrix hides it; a real camera matrix pushes the scene out
   of clip space: **empty frame, no `D3DCompile` error, PSO builds fine, every uniform reads back
   correct**. Three probes pin it down: `uColor` into the fragment shader -> correct pixel; replace the
   vertex position with `vec4(aPos*0.5, 1.0)` (no matrices) -> picture returns immediately; read `M[3].z`
   and `M[2].z` -> values all correct. Fix: add `row_major` to the HLSL matrix **declaration** lines in the
   shim (data and multiplication untouched), so the same column-major bytes read as the transposed matrix
   and `mul(v, M)` becomes `M * v`. The AS-side contract then matches the Metal arm exactly, and nested
   products stay consistent (HLSL's `mul(A, B)` is the logical product whatever the storage class is).
4. **`skia.lib` bundles its own SPIRV-Cross.** `llvm-ar t` lists
   `spirv_cross.spirv_{glsl,msl,hlsl,reflect,...}.obj`, so linking it beside our freshly built
   `spirv-cross-glsl.lib` dies on `duplicate symbol: spirv_cross::CompilerGLSL::emit_resources`. Skia has
   **no** `spirv_cross_c.obj` (the C dispatcher is not in it), so the fix is
   `-DSPIRV_CROSS_NAMESPACE_OVERRIDE=asc_spvc` in `build-tools/shader/build-win.sh`: our C++ backends move
   into the `asc_spvc` namespace while the `extern "C"` `spvc_*` entry points (absent from Skia) are
   unaffected. `src/build.ts` compiles the shim with the same define.
5. **The PSO's `RTVFormats[0]` must be the target's real DXGI format.** The native channel can create a
   target in any format (§6.1 layer 2), and `CreateGraphicsPipelineState` **fails** -- not warns -- when
   `RTVFormats[0]` disagrees with the bound view. The cache key therefore carries the full `DXGI_FORMAT`
   instead of a half-float/8-bit boolean.

**Capability edges (registered, never silent)**:

| Item | State on this backend |
|---|---|
| Colour attachments | **One.** `s3d_native_use` refuses `ncolor > 1` up front and says so (the PSO binds a single RTV, so a program declaring `SV_Target1` cannot be built at all) |
| `setRenderTargetSamples` | **Reports unsupported**, targets stay single-sampled (multisampling needs a multisampled resource plus a resolve pass interleaved with the pass chain, not a per-texture switch) |
| `generateMipmaps` | D3D12 has no blit-style generation (D3D11's `GenerateMips` is gone), so it is a **CPU box filter plus per-level upload**, 4-byte BGRA8 only; other formats are reported rather than half-filled (a half-built chain lets a mip-sampling draw read uninitialised levels) |
| Explicit `cbuffer` | Only loose uniforms in `$Globals` (b0); the shim lifts explicit blocks to b8+, which this backend has no slot for -> reported, not dropped |
| Depth textures | Render attachment only (same rule as the rest of the project); no `sampler2DShadow` comparison sampling |
| Float/integer targets | Supported (`s3d_create_texture_fmt` fmt ids 0..10 -> DXGI); the PSO is chosen per real format |

**Build side**: `build-tools/shader/build-win.sh` takes `ARCH=32|64` (-> `windows-x86` / `windows-x64`),
and Windows archives must be named `NAME.lib` (**no `lib` prefix**, because MSVC's `-lNAME` appends
`.lib`). Two other pieces of one-link-list-four-hosts housekeeping: (1) this build folds glslang's
`MachineIndependent` / `GenericCodeGen` / `OSDependent` into `glslang.lib`, while the macOS archive set
keeps a **one-member stub archive** for each (`libMachineIndependent.a` is literally `stub.cpp.o`) -- do
the same, or any list that names the whole set (such as `examples/native-shader-probe.build.json`) dies on
Windows with `could not open 'MachineIndependent.lib'` before a single symbol is resolved; (2) that example
manifest pinned `../vendor/shader/lib/macos-arm64` and needed a separate zlib on Windows -- it is now
`${host}` plus `${win:z}`, so one manifest works on all four hosts.

---

## 7. AS side (asaot3d) work list

The AS side is the engine: wire the compiler's pipe into a three.js-style author API. This section first
answers something the document did not make clear before: what happens to these AOT-only symbols when the same
`.as` source is handed to `mxmlc`/`adl`? "adl can compile it" and "it degrades at runtime" are **two orthogonal
questions** and must be guaranteed separately.

### 7.1 Two iron rules: compile-time reachable ≠ run-time reachable

The AS3 compiler distinguishes them, and mxmlc treats **type positions** and **expression positions** completely
differently (`three-api-design.md:2360-2365`):

| Position | Example | mxmlc behaviour | When missing |
|---|---|---|---|
| **Type position** | `var m:ShaderMaterial`, `function f():Context3DNative` | must resolve to a real definition at compile time | **`#1046`, compile fails** |
| **Expression position** | `new ShaderMaterial()`, `AGALTranslator.translate(...)` | under `strict=false`, degrades to a runtime name-chain lookup | **`#1065`, runtime fails** |

Note: an `import` alone does not force resolution; the **use site** does. So `import flash.display3D.AGALTranslator`
compiles, and as soon as `AGALTranslator` appears in expression position, mxmlc (non-strict) says nothing and
the runtime throws `#1065`.

**The project's verified standard solution** is in `AGALRenderer.as:5596-5611` — a static reference "compiles but
throws #1065 at runtime", so it was changed to a runtime `getDefinitionByName` + `try/catch` probe with graceful
degradation:

```as3
private static function translatorClass():Object {
    try { return getDefinitionByName("flash.display3D.AGALTranslator"); }
    catch (e:Error) { return null; }   // AIR has no such class → degrade
}
```

### 7.2 Three existence tiers: compile-time fate of E6's new symbols

| Symbol | Existence | mxmlc | adl runtime | Isolation |
|---|---|---|---|---|
| `ShaderMaterial` | **shared by both backends** (§7.3) | compiles (pure data, no missing AIR API) | `new` works; rendering into it via `AGALRenderer` reports the limitation | none needed |
| `NativeShaderRenderer` | **AOT-only, opt-in** (§7.4) | compiles (authors never `new` it, only string probing) | probe fails → `ShaderMaterial` throws, other materials fall back to `AGALRenderer` | `getDefinitionByName` + factory |
| `Context3DNative` (float formats/MRT/native shader/depth) | **AOT-only, opt-in** (§7.5) | compiles (authors only probe by string, never put it in a type position) | probe fails → CPU path | `getDefinitionByName` + factory |

**Iron rule**: an AOT-only symbol **must never** appear in an author's **type position** (mxmlc `#1046`), and even
in expression position it may only be referenced indirectly through a **string** in `getDefinitionByName`
(otherwise `#1065` at runtime, with no way to degrade).

### 7.3 `ShaderMaterial`: shared by both backends (decided)

`ShaderMaterial` extends only `Material` and stores `vertexShader:String`, `fragmentShader:String`,
`uniforms:Object`, `defines:Object` — **AS3 expresses all of these, no missing AIR API**. So it lives in
shared `asaot3d` source: mxmlc compiles it, AIR can `new` it (type-position references are safe too).

```as3
class ShaderMaterial extends Material {
  var vertexShader:String;      // GLSL ES 3.00 source
  var fragmentShader:String;
  var uniforms:Object;          // { uTime:Number, uDisplacement:Texture, ... }
  var defines:Object;           // optional: compile-time macros prepended to the shader
  // semantics mirror three.js r187 ShaderMaterial (three-src/src/materials/ShaderMaterial.js)
}
```

Under AIR the real boundary is the **renderer**: `AGALRenderer` does not understand hand-written GLSL, so it
**says so** ("the AGAL backend does not support ShaderMaterial") and **must not** silently render it as some
`MeshBasicMaterial` — that would be wrong semantics (§0 red line). As-built, the base class's
`_drawShaderMaterial` throws, naming the material and the exact switch; there is no AGAL fallback
(`asaot3d/three-api-design.md` §37.4).

### 7.4 `NativeShaderRenderer` + factory: runtime probing (decided)

`three-api-design.md` §9 fixed the interface shape; landing E6 means the second `IRenderer` implementation. But
authors **cannot** `new` it directly — it is an AOT-only capability class, absent under AIR. Authors only reach
it through a **factory shared by both backends**:

```as3
// RendererFactory (shared, mxmlc compiles it too)
public static function create(context:Context3D):IRenderer {
    var cls:Class = null;
    try { cls = getDefinitionByName("asaot.three.NativeShaderRenderer") as Class; }
    catch (e:Error) { cls = null; }
    if (cls != null) return new cls(context) as IRenderer;   // `as IRenderer` is safe: the interface is shared
    return new AGALRenderer(context);                        // AIR / default as-aot → fallback
}
```

Three points:

1. **`as Class`, not `as NativeShaderRenderer`**: `Class` is a built-in type and `as Class` is safe; the latter
   would put an AOT-only class name in a type position and mxmlc fails with `#1046`. `getDefinitionByName(...)
   as Class` is a supported unboxing path (`emit.ts:39042`).
2. **Probing throws, it does not return null**: `getDefinitionByName` throws `ReferenceError #1065` when it
   cannot find the name (`emit.ts:3864`), same number and semantics as AIR — hence `try/catch`, not a null check.
3. **The `IRenderer` seam already exists** (`IRenderer.as` even says "future NativeShaderRenderer will implement
   the same interface"), and `AGALRenderer` is the ready-made fallback.

`NativeShaderRenderer` itself (symmetric with `AGALRenderer`) walks the scene graph → binds each `ShaderMaterial`'s
GLSL ES 3.00 program → uploads uniforms/attributes/textures → draws.

### 7.5 Float formats / native shader / depth textures: `Context3DNative` (option B, forced by runtime probing)

Layer 2 float/depth formats (§6.1), native shader submission (§6.3) and depth textures (§6.4) **all** go into one
new class, `Context3DNative` — the **only** choice under the runtime-probing approach:

- Option A (conditional symbols on `Context3D`) relies on constant references such as
  `Context3DTextureFormat.RGBA_FLOAT`, and AS3 has no runtime probe for "does this constant exist"
  (`describeType` could but drags in XML/E4X, deferred) ⇒ no graceful degradation, rejected.
- Option B's new class **can be probed** with `getDefinitionByName`, same pattern as the §7.4 factory;
  `Context3DTextureFormat` only gets **layer 1 alignment** (still AIR's six constants) and layer 2 formats do
  **not** enter it (default product isomorphic to AIR).

Author usage (the factory encapsulates probing, so author code has zero type-position references to AOT-only
classes):

```as3
var nat:Object = RendererFactory.nativeContext();   // getDefinitionByName("...Context3DNative") + try/catch
if (nat != null) {
    var rt:* = nat.createTexture(w, h, "rgba32f", false);   // float RT, format ids are Strings
    // ... FFT on the GPU
} else {
    // AIR / default as-aot: float RT unavailable → CPU FFT (§7.8)
}
```

### 7.6 Error vs degradation: the two runtime boundaries

These are not alternatives; the split follows the semantic consequence of the missing capability (`README.md:178`
red line: degradation must be explicit — probed, tested, documented; `AGENTS.md` §1.5: never silent, never
degrade into wrong semantics):

| Scenario | Policy | Why |
|---|---|---|
| `NativeShaderRenderer` missing | **degrade** → fall back to `AGALRenderer` | an equivalent path exists and the `IRenderer` seam is already there |
| Float RT missing | **degrade** → FFT on the CPU (same pattern as M25) | an equivalent path exists (fidelity-preserving CPU FFT) |
| A `ShaderMaterial` reaching `AGALRenderer` | **fail loudly** | no equivalent: pretending it is `MeshBasicMaterial` is wrong semantics |
| `--features native-shader` was requested but the build/run has no channel | **fail loudly** (at once) | a hard dependency is missing, nothing to degrade to |

### 7.7 The AS3 face of float / integer / depth textures

`Texture` / `DataTexture` must carry float data (FFT displacement/spectrum) matching §6.1's new formats. The
current 8-bit `BitmapData` payload model needs three side channels:

- **float payload**: `Vector.<Number>` (float32) or `ByteArray` (packed half float) — §6.1 layer 2 (a).
- **integer payload**: `Vector.<uint>` / `Vector.<int>` — §6.1 layer 2 (b); integer textures cannot be read with
  float samplers, so AS3 must be able to mark "this is an integer texture".
- **depth payload**: `DEPTH_COMPONENT*` depth textures (§6.4) — used as both depth attachment and sampleable
  texture, with a different create/bind path from colour textures.

And "texture" has two roles that must be distinguishable: **sampleable** (bound as a sampler) and **renderable**
(RT attachment). §6.1's warning says not every format is both, so the AS3 creation API must express both uses
(mirroring three.js's `WebGLRenderTarget` (renderable) vs `Texture` (sampleable) split) instead of a single
`createTexture`.

### 7.8 Ultra-Water port: the shape flips (key decision point)

Once E6 lands, **FFT ownership flips from "forced onto the CPU" to "may run on the GPU"**:

| Route | Before (no E6) | After (E6) |
|---|---|---|
| **CPU FFT** (fidelity) | the only viable option (M25's HDR was the same "float panorama → CPU prefilter → 8-bit cube" pattern) | still the fallback when float RT is unavailable |
| **GPU FFT** (Tessendorf) | impossible (no float RT / texelFetch / MRT) | **unlocked**: `OceanSim.js`'s FFT copies over, displacement/slope/Jacobian/foam all computed on the GPU |

**Ultra-Water's soul is the GPU FFT** — a faithful port should use it; that is what E6 exists for. CPU FFT is the
detour, not the goal (`AGENTS.md` §0: do not detour).

### 7.9 Engine-side work split

- **Batch 1 (prove the path)**: `NativeShaderRenderer` + `ShaderMaterial` + a minimal ocean (Tessendorf single-
  stage FFT + displacement + one float RT), on-screen on AOT-Metal. — *As-built, the first landing replaced the
  ocean with a 2×2 quad; FFT moved to M7 (§9).*
- **Batch 2 (the free web point)**: the same `ShaderMaterial` running under `--target wasm` verbatim, proving
  GLSL ES 3.00 runs without cross-compilation.
- **Batch 3 (align with Ultra-Water's full stack)**: caustics / atmosphere LUT / underwater / foam / buoyancy
  (CPU sampling of water height), ported one by one.

---

### 7.10 First real client: `apps/nyc-m36` (as-built, 2026-11-14)

`shader-m30` proved the channel runs; nyc-m36 proves **a real scene — 39 meshes, 365k triangles, a material
switch every draw — runs through it**. The shape is *mirror, don't rewrite*: `CityNativeSet` keeps each
`MeshStandardMaterial` original, `mirror()` builds a `ShaderMaterial` with the same fields, and `sync()` copies
the originals' fields into uniforms every frame (in-place `put3`, no allocation). `City.setNight()` keeps
mutating the originals; the mirrors only consume that output.

**Four real defects hit while wiring it** (all of the "drew, but drew something else" kind — none was a compile
or link error):

1. **mip drop 94 → 0: AGAL's `t0..t7` rebind stomps the native samplers.** `Context3D_submit` resumes the AGAL
   program's sampler table by rebinding `t0..t7`; a native draw goes through the same submit point, so the
   freshly bound native textures were replaced with what the AGAL program believed. The fix splits the submit
   point into `Context3D_submit_ex(..., int keepTextures)` and passes `1` from the native draw (in `src/emit.ts`).
2. **Native → AGAL shader pollution: `$Globals` read as `vc[]`.** The first AGAL draw after a native one read
   the previous frame's native constant block as the AGAL register file, producing a screenful of wrong colour
   that then recovered.
3. **The expensive one: making "native drew" a persistent flag hands the AGAL lazy compile a mid-sequence fire
   order.** To skip `$Globals`, an `as_s3d_native_drawn` static was added inside `Context3D_submit_ex` and
   consumed by `Context3D_submit`. But a native draw enters `submit_ex` **directly**, the flag was never
   cleared, so the AGAL lazy compile fired **halfway through the same draw sequence** — walking the only
   `nativeMode = 0` in `s3d_compile` — and **30 of 31 city draws fell back to AGAL semantics**: 3 fps, half the
   picture wrong. The correct fix invalidates the AGAL cache inside the native draw instead: gate the lazy
   compile on `!keepTextures` and drop `self->context->gpuProgram = NULL;` at the end. Measured after the fix:
   `draws 251 nat1 155` per frame, first-frame pattern `0 0 111…1 0 1 0…` = one AGAL sky draw → 30 native city
   draws → the remaining AGAL traffic/crowd/sky.
4. **`uAlphaTest` was delivered but the fragment stage ignored it.** Proven by a live histogram
   (`uAlphaTest … [('0', 140), ('0.45', 15)]` — only leaves0/1/2 are 0.45); adding
   `if (alpha < uAlphaTest) discard;` removed the leaves' hard edges.

**Two non-defects, recorded so nobody re-litigates them:**

- **The ground bbox `[-8000,8000]²` with z=0 is not a bug**: `PlaneGeometry(16000,16000,1,1)` is a plane in
  **local XY**; `mesh.rotation.x = -Math.PI*0.5` lays it flat. The probe reads local coordinates.
- **`[nmat] color=undefined` is not a bug**: `uniforms["uColor"].value` is a `Vector.<Number>` (written by
  `put3`), so `.x` is undefined; the upload still sends three floats via `_toNumbers`.

**One root cause behind two "open defects", now fixed (the most expensive item in this section).** The
symptoms were: 1.5 fps (the same scene in pure AGAL: 59.9), the building **adjacent to the camera at street
level not appearing**, and occasional huge black wedges on the roofline. All three pointed at
`S3D_MAX_PROGRAMS`, which was **16** while nyc-m36 keeps **35** programs alive in one frame (24–31 native
materials plus the AGAL programs that frame still draws with). The LRU therefore **evicted the whole pool
every frame**:

- `s3d_compile` re-ran `D3DCompile` 35 times per frame and `s3d_select_pso` re-created the pipeline 35 times
  per frame ⇒ 1.5 fps;
- a slot was recycled **within the same frame**, and `s3d_prog_release` freed the blob / PSO of the program
  that was still being drawn ⇒ that draw vanished (the near building, and the stray black triangles).

The discriminator is one field: `comp=` in `S3DDRAW` (`c->statCompiles`) **grew by exactly 35 every frame**.
Raising the cap to **96** stops it at 35; measured **59 fps**, and the near building plus the wedges went
away along with the eviction. The pool is a static array (~4.3 KB of PSO-variant cache per slot), so the cap
is **memory, not time**: 96 slots ≈420 KB per context, and it costs nothing until programs exist.

**What the 9 remaining AGAL draws are.** The native channel mirrors `MeshStandardMaterial`; the sky dome,
billboards, lamp heads, subway entrances and crowns are `MeshBasicMaterial` (unlit) — they must not go through
PBR, and AGAL's basic program is their correct home. `calls=` counts AGAL draws only, so 50 → 19 → 9 as the
channel took over is a **decrease**, not "the native channel is unused".

**Two more real defects, fixed while wiring traffic and crowd:**

- **Traffic and crowd never joined the native set.** `CityNative.install()` walked `_city.root` only, while
  `Traffic`/`Crowd` create their meshes slightly later in the same frame — so their `MeshStandardMaterial`s
  kept drawing through AGAL (most of the measured 19 AGAL draws per frame). The walk is now
  `CityNative.addTree(set, root)`, called again once those roots exist.
- **Dynamic geometry allocated a `VertexBuffer3D` every frame.** `_ensureBuffers` / `_ensureAttributeBuffer`
  used to recreate on any version bump, and the car/pedestrian arrays change **every frame** ⇒ one D3D12
  resource creation per mesh per frame. Now the same-size case re-uploads in place and only a size change
  rebuilds.
- AS3 trap worth recording: material dedup needs a `Dictionary`, **not `{}`** — Object keys are coerced to
  strings, so every material landed in one `"[object Object]"` slot (measured: `install()` reported 1).

**Instrumentation kept in the tree** (all behind env vars): `ASC_S3D_DUMP=1` prints
`S3DNAT`/`S3DNATUP`/`S3DDRAW`/`S3DU`/`S3DB`/`S3DF`/`S3DL`/`S3DM`/`S3DV`/`mip-drop`;
`ASC_NATIVE_DUMP_BINDINGS=1` prints `[pin]`/`[bindings]`. To isolate one mesh, filter by `mesh.name` prefix
inside `NativeShaderRenderer._drawShaderMaterial` and give each mesh a constant colour (`[pcol]`); **always
confirm the screenshot came from the process this run started** — a leftover window turns "bit-identical A/B"
into a false conclusion.

---


### 7.11 Wrap-up: the non-PBR materials join the native channel too (`calls=0`, 2026-11-14)

After §7.10 the frame still had nine AGAL draws: sky dome, billboards (LED walls), lamp heads,
subway mouths and the Empire State crown. All of them are `MeshBasicMaterial`, so the first call
was to leave them on AGAL "because they need no lighting". That call was wrong, and the reason is
the state machine rather than image quality: alternating AGAL and native draws inside one frame
means every switch back re-enters `Context3D_submit`, which rebinds the AGAL program's t0..t7,
re-validates sampler flags and can fire the AGAL lazy compile -- exactly the accident that cost
3 fps in the previous stage (§7.10 defect 2). With the last nine draws on the native path the
frame has a single renderer, and `calls=0 / tris=0` becomes the cleanest possible proof that
nothing fell back.

The shape: `CityNative` gains `UNLIT_VS`/`UNLIT_FS`; `CityNativeSet` gains
`mirrorBasic(MeshBasicMaterial)` plus a separate `basicMaterials` list (a lit mirror needs twenty
uniforms, an unlit one nine -- folding them into one loop turns `sync()` into a `hasOwnProperty`
sieve). `CityNative.addTree()` now takes both kinds, and `NycM36` walks `_scene` once after
traffic and crowd have had their first `update(0)` (the sky dome hangs off `_scene`, not
`_city.root`; `mirror()` dedups on the source material, so re-walking the city is a no-op).

**Readings** (preset 1 street at 15:30 / preset 2 Times Square at 21:30): `calls=0 tris=0`,
**59.7 fps / 62.9 fps**, 43 native materials (32 lit + 11 unlit), `comp` no longer grows,
zero `mip-drop` lines. At night the three LED walls (green/yellow/blue), the lit shopfronts and
the lit facades all emit correctly.

**Pitfalls hit (all real defects, none of them configuration)**:

1. **ACES must not be applied to the unlit pass.** The first version copied the lit tail
   (fog -> ACES(exposure) -> sRGB) and the sky immediately washed out: the same pixel went from
   `(166,195,217)` to `(199,219,233)`, losing about thirty code values of blue. These surfaces
   carry colours that are *already* display-referred (the sky gradient is painted straight into a
   BitmapData, the LED walls and shop fascia are sRGB bitmaps, a lamp head is one flat value), so
   tone-mapping them is a second exposure. Straight multiply + fog mix + direct output restores
   pixel-for-pixel equality with the pre-migration frame. Related: the unlit FS must **not**
   declare `uExposure` -- the compiler drops unused uniforms and
   `as_shader_set_uniform_vec` throws `ArgumentError 2008` for a name that is not there.
2. **Anchor-shape lesson: include the const name when patching shader source.** I anchored on
   `uniform float uExposure; + out vec4 fragColor; + const float PI` to rewrite the unlit shader,
   but the lit FS contains the identical three lines earlier in the file, so `index()` hit the lit
   one and deleted its helpers and `main` (symptom: only sky colour on screen, `calls=0` yet no
   lit draw at all). Recovery used the copy taken for the HLSL probe
   (`temp/shc-city/city_shaders.h`), and was only accepted after a pixel check: 6/6 sampled lit
   points byte-identical to the pre-migration frame.
3. Rebuilding the lit FS had one more detail: `acesFilmic` does **not** carry a `1/0.6` pre-scale
   (`uExposure` already receives `exposure/0.6`). Adding the pre-scale "because three.js puts it
   in the operator" measured 1.5x too bright in the midtones (47->72); removing it restored the
   baseline immediately.

### 7.12 Environment probe: the specular half of IBL, for free from the sky dome (2026-11-14)

nyc-m36 carried a self-imposed rule for a long time: the README said metalness must stay 0 because
the build has no environment map. That was true in the AGAL era -- an equirectangular lookup meant
hand-writing a spherical reprojection in AGAL and spending a sampler slot that was already gone.
Once the native channel exists the rule is pure inertia: `CityNative.FS` can write any GLSL, and a
`reflect` plus one `atan/acos` is all it takes.

Three steps, all on the AS3 side:

1. The sky dome's own `BitmapData` is already equirectangular (`SphereGeometry` uvs are longitude/
   latitude), so it is bound as `uEnvMap` directly -- no separate bake for reflections.
2. `CityNative.FS` adds a specular term after the diffuse: `reflect(-V, N)` ->
   `(atan(R.z,R.x)/2pi+0.5, acos(R.y)/pi)` -> `srgbToLinear(texture(uEnvMap, euv).rgb)`, times
   `F_Schlick(f0, N.V)`.
3. `CityNativeSet.sync()` writes `uEnvMap` / `uHasEnv` / `uEnvIntensity` every frame; the handle comes
   from `SkyRig.skyTexture` (a new getter) and is re-assigned per frame so a sky repaint follows.

`calls` stays 0: the probe is the 21st uniform of the same native program, not a second draw path.

Three measured boundaries -- do not step on them:

- **The probe supplies the specular half only, never irradiance.** An earlier build added
  `diffuse * 0.35` and lifted the whole-frame mean from 46 to 54: in three.js IBL and `AmbientLight`
  are separate inputs, while here both come from the same sky, so that counted the ambient twice.
- **Metalness cannot borrow energy from the probe.** Raising the curtain wall to metalness 0.55
  dropped the frame mean **46 -> 31**: the half of the diffuse that `albedo * (1 - metalness)` takes
  away cannot be repaid by one unblurred sample. Glass therefore keeps `metalness = 0` and gets its
  sheen from `roughness` (0.42 -> 0.30).
- **`envIntensity` keys off roughness only.** `0.06 + 0.94 * (1-roughness)^2`: glass at 0.30 gets
  0.52, masonry at 0.92 gets 0.066, asphalt at 0.90 gets 0.07. The 0.06 baseline was 0.12 until every
  brick wall picked up a grey-blue veil.

The asphalt numbers are measured, not guessed (same camera, same hour; whole-frame mean, reference
`ref-default.png` = 61):

| asphalt roughness / metalness | frame mean | reading |
|---|---|---|
| 0.62 / 0.16 | 61 | the avenue washed out white: Fresnel is 1 at grazing angles and half the road is grazing |
| 0.78 / 0.05 | 35 (**bogus**, see below) | -- |
| 0.90 / 0.03 | 60 | wet without blowing out, still picks up sky at grazing angles |

**The instrument trap that inverts conclusions:** if a Windows Security dialog is parked on top
while you screenshot, the whole window is darkened by a **~0.58 multiplicative factor** -- sky
`(156,150,139)->(94,93,90)`, brick `(43,48,50)->(25,28,29)`, road `(180,179,175)->(104,105,103)`, all
the same ratio. "Raising roughness made it darker" is a false reading under that. Procedure: bring the
target process to the foreground with `SetForegroundWindow`, confirm no modal dialog, then read the
mean; when comparing single pixels, also sample a region the renderer cannot affect (e.g. HUD
background) and check whether it moved by the same ratio.

### 7.13 Native shadow pass: an R32F shadow map, and the canyon finally has building shade (2026-11-14)

After §7.11 brought the unlit surfaces into the native channel, one engine gap dominated nyc-m36:
**no sun shadows**. Half the reference (slop-newyork) image is the slice of building shadow thrown
across the road; our road averaged 155 against the reference's 55 -- the light/dark relationship was
inverted. The old AGAL shadow pass fails on D3D12 because **the fs4 binding never lands**: the lookup
returns one position-independent constant (bias / normalBias sweeps left the frame byte-identical, see
TODO stage 411). With the demo no longer on AGAL, the shadow becomes the native channel's own render
target. New file: `apps/nyc-m36/src/city/CityShadow.as`.

**Why R32F.** `Context3DNative.createTexture(w, h, "r32f", true, false)` makes a renderable
`R32_FLOAT` surface; `s3d_select_pso` keys the pipeline on the target's **full DXGI format**, so the
depth program gets its own R32F PSO for free. One float per texel IS the light-space depth -- no AGAL
RG packing, no 8-bit banding (256 levels over a 3 km ortho range is ~12 m per step, i.e. acne on every
wall). This is a direct dividend of the native channel over AGAL.

**Conventions verified against source, not guessed.** The engine's `Matrix4.makeOrthographic` is
Stage3D **[0,1] depth, Y-up NDC**; `stage3d_d3d.cc` uses a positive viewport height (no shader Y flip)
and an RT's texel (0,0) is its **top-left**. So NDC (nx,ny) lands at uv ((nx+1)/2, (1-ny)/2): the bias
matrix's **Y column = -0.5**, the same top-left convention as Metal (the note in
`AGALRenderer._setShadowBiasMatrix`); the Z column stays identity (depth is already [0,1], do not
remap). The old path broke on the binding, **not on this math**.

**Implementation notes:**

- Two position-only programs: `SOLID` writes only `gl_FragCoord.z`; `CUTOUT` samples the base-color
  alpha for alphaTest (otherwise every tree casts a solid rectangle). The VS declares only `uLightMVP`
  (= shadowVP * modelWorld, uploaded per caster) and **no auto uniform**, so the pass does not depend
  on the renderer having a current camera -- it runs in `updateFrame`, before `render()`.
- The light camera reuses `sun.shadow.camera` (the ortho frame `SkyRig.setFocus` already sized for the
  shot), sits at the sun and looks at its target.
- Solid casters cull front faces (store the far wall of a closed box so its lit face does not
  self-shadow); double-sided leaf quads render both faces.
- `CityNative.FS`'s `shadowTerm`: offset the world position along the normal by `normalBias` (world
  units) before projecting, nudge the compared depth by a constant `bias`, soften with **3x3 PCF**;
  the map itself is **point-sampled** (interpolating two depths across a silhouette is wrong), the
  softening comes from averaging nine binary comparisons. Only the sun term is shadowed (the fill is
  the shadowless sky stand-in); outside the light frame the term is 1, and fog hides the cascade edge.
- **`sun.castShadow` stays false forever** -- that flag drives AGALRenderer's own (broken-on-D3D12)
  prepass; the panel's `shadows` knob drives CityShadow. Keeping them apart is what keeps `calls=` 0.
  `NycPanelState.shadows` now defaults to **true**.

**Measured (same viewpoint, grey mean; `calls=0 tris=0` unchanged):**

| view | reading |
|---|---|
| street, day | road **155 -> 88**, with lateral structure: left (sunlit) ~108, right (building shade) ~65, a clean diagonal shadow edge; contact shadows under cars |
| helicopter aerial | towers throw long crisp shadows across the grid; neighbouring roofs carry shadow shapes |
| Times Square night 21.5h | no regression; lit windows / LED walls / shopfronts intact |

**The spatial structure** is what decisively separates a real shadow from the old bug's
"constant everywhere". All three views log `[CityShadow] native R32F shadow map 2048x2048, 16
casters` (the city is welded geometry: 16 = building chunks + car bodies + crowd).

**Still owed:** tree canopies do not cast (`leaves`/`trunks` have `castShadow=false`, a content gap);
the shaded road at ~65 is still brighter than the reference's ~32 (an ambient/fill balance issue, not
a shadow bug); the road's planar reflection is not done.

### 7.14 Planar reflection on the road: a mirror camera plus a screen-space lookup (2026-11-15)

The environment probe of §7.12 can only supply the **sky half** of a specular term -- there are no
buildings, no lane markings and no tail lights in it. The reference's wet street is made of exactly
those, so the last piece is a **real mirror pass**: `apps/nyc-m36/src/city/CityReflection.as`.

**The structure in one line.** A genuine mirror camera (position and forward reflected across
`y = 0`) renders the whole scene into a **half-resolution** RGBA8 target; `CityNative.FS` fetches it
on the asphalt at `gl_FragCoord.xy / uResolution` and blends it in by Fresnel. The half resolution
does not shift anything (the uv is normalised), it only blurs more -- which is what a rough wet road
wants anyway.

**Why no texture matrix is needed.** The road **is** the mirror plane `y = 0`. Any point P on that
plane projects to the **same pixel** in the real camera and in its reflection (a reflection fixes
every point of the plane), so the mirror target is already aligned and the screen uv can be used
directly.

**Why a lookAt camera instead of a reflection matrix.** Reflecting `camera.matrixWorld` across
`y = 0` yields a left-handed frame (determinant -1) which **flips the winding of every face**, and
would need a per-pass cull flip in `render()`. A real right-handed camera instead (position
reflected, `up` reflected to `(0,-1,0)`, looking at the reflected forward point) sees the scene from
below with correct winding, and `render()` culls it exactly like any other camera.

**No feedback.** While the mirror pass draws, the road's own `uHasReflection` is forced to 0 -- else
it would sample the very target it is drawing into.

**Display-space blend.** The mirror target has already been tone-mapped and sRGB-encoded by the
**same** `CityNative.FS`, so the blend happens **after** the tone map (mix in sRGB); otherwise the
reflection would be mapped twice.

**Wet asphalt is not a mirror -- two deliberate non-idealities:**

- **Vertical smear**: four extra taps offset along `uv.y` (weights 0.2/0.2/0.1/0.1), the offset
growing up to 3x with `vDepth`. The micro-roughness of a wet surface stretches a reflection along
the view direction, and at standing height that direction **is vertical** on screen.
- **Wetness mask**: two octaves of a value noise over `world.xz` (`smoothstep(0.34,0.72)` -> 0.30..1.0).
  It uses **world** coordinates, not screen ones: a screen-space pattern swims as the camera moves.

**The double count that had to go.** The road carried both the environment probe's specular term
*and* the planar reflection, and both approximate the **same reflected sky** -- the probe term was
counted twice. So `envW = 0` whenever `uHasReflection != 0`; the probe now serves only the surfaces
with no mirror pass (i.e. all the rest). Same discipline as §7.12's "probe supplies the specular
half, never add diffuse", one term further along.

**A content trap fixed along the way.** The base colour `0x4a4e52` in `CityTextures.asphalt()` is
**dead code**: the 2x2 noise loop right after it covers the whole 128x128 with
`scaleColor(0x5d6063, k)`, which is why changing the base measured as *no change at all*. The
literal that actually reaches the texture is the one in the loop, now `0x4b4f53`.

**Measured (one 65,194-pixel road mask, taken from the reflection-on/off difference; `calls=0
tris=0` unchanged):**

| configuration | road mean | frame mean |
|---|---|---|
| no reflection, probe on, albedo `0x4b` | 57.0 | 56.4 |
| no albedo contribution (black map), probe on | 41.9 | 55.7 |
| reflection + probe (double count), strength 0.60 | 40.7 | 55.4 |
| **final: reflection + `envW=0`, strength 0.45, blur 0.0046** | **36.3** | **55.3** |
| night, Times Square 21.5h | 31.6 | 46.4 |

The reference (golden hour) road sits around 35..59. **The black-map row is the decisive evidence**:
a road with a black albedo still reads 41.9, so most of the original brightness came from the
**albedo-independent probe specular**, not from sun-plus-albedo. That is also why nudging the asphalt
colour alone did nothing (81.8 -> 79.7), and why dropping the probe took the road from 57 to 40 in
one step.

**Switches**: besides the panel's `shadows`, `R` now toggles `reflection on/off` (HUD line);
`_reflectionOn` defaults true. First frame traces `[CityReflection] native planar reflection
693x411 (half of 1386x823)`.

**Still owed:** the reference street lies entirely in building shade (low sun, warm grazing light)
while our default 15:30 puts the sun at 37.9 deg with the street in direct light -- that is a
**lighting-rig balance** (sun elevation / colour temperature / ambient ratio), not a defect of the
reflection or the shadow; and facade window recesses, fire escapes, road patches/cracks/manholes are
still low-poly **content**.

## 8. Red line: AOT-only, reported honestly on the AIR side

**This chain cannot run on AIR (adl)** — Adobe's `Context3D` has neither float RT nor GLSL3 passthrough. Hence:

- **AOT side**: with `--features native-shader`, float RT / MRT / native shaders all work (native via Metal/D3D,
  web via WebGL2).
- **AIR side**: the same `.as` under `adl` has **no** such API to begin with ⇒ per `AGENTS.md` §1.5 this is an
  enhancement, not debt; the AIR side either shows nothing or gets the AGAL path, and it **must say so**, never
  silently.
- **Cross-end differences listed explicitly** (§1.2 criterion c):
  - native (Metal/D3D): complete.
  - web (WebGL2): complete (passthrough + float extensions), but float RT depends on `EXT_color_buffer_float`
    and must be queried at runtime; older GPUs may only have half float, and degrading `RGBA_FLOAT` to
    `RGBA_HALF_FLOAT` must be **reported**.
  - AIR (adl): **unsupported**; `NativeShaderRenderer` / `Context3DNative` do not exist in `airglobal.swc`, so a
    static reference is `#1065`; authors probing through the §7.4 factory fall back to `AGALRenderer` (the same
    shape as the existing `AGALTranslator` gap, recorded in `AGALRenderer.as`'s header comment).

**This has been decided and landed** (§12): E6 ships as an **enhancement**, AOT-only, with the AIR side **failing
loudly** instead of showing a silent black screen. The landed shape is harder than originally planned:

- **The default build changes by zero bytes** — `Context3DNative` / `NativeProgram3D` **do not exist** in a
  default build's symbol table, and `getDefinitionByName` throws `#1065` exactly as `adl` does;
  `examples/native-shader-probe.as` and `test/unit/native-shader.ts` pin both directions (including "no native
  method bodies in the default build's C" and `#define ASC_HAS_NATIVE_SHADER 0`).
- **The engine never draws an approximation** — when a `ShaderMaterial` finds no native channel,
  `AGALRenderer._drawShaderMaterial` **throws**, naming the material and the switch (`asaot3d` §37.4). Faking the
  author's GLSL with AGAL would be "a wrong answer in convincing clothes" (`AGENTS.md` §0).
- The cost is recorded in `enhancements.md` §3's E6 row: this is an **enhancement**, not legacy debt, and does not
  belong under "遗留待开发".

---

## 9. Staging

| Stage | Content | Acceptance | Backend | Status |
|---|---|---|---|---|
| **P1 · Metal only** | glslang+SPIRV-Cross into `build-tools/`; `--features native-shader` registered; `stage3d_glue.mm` gains float RT + MRT + native MSL compile; `NativeShaderRenderer` + `ShaderMaterial` | a program on screen | Metal | ✅ **M1+M2+M3 path done**: `apps/shader-m30` reads back centre `#804020` bit-exact. Not via `xcrun metal` (no offline toolchain on this machine, §3.4) but via the runtime `newLibraryWithSource:` path |
| **P2 · the free web point** | `stage3d_webgl.cc` passes GLSL ES 3.00 through + `EXT_color_buffer_float`; the same `ShaderMaterial` runs under `--target wasm` | the same image in a browser, zero cross-compilation | WebGL2 | ✅ **landed 2026-11-03** (stage 358) — `--features native-shader` now lists both `native` and `wasm`; the two arms take different compile inputs (source verbatim vs glslang+SPIRV-Cross) |
| **P3 · D3D12** | `stage3d_d3d.cc` gains float `DXGI_FORMAT` + native HLSL compilation | on screen on Windows | D3D12 | ✅ landed 2026-11-14 (§6.12; `shader-m30` 15 checks PASS, pixel `#804020`) |
| **P4 · Ultra-Water alignment** | caustics / atmosphere LUT / underwater / foam / buoyancy, ported and compared item by item | close to the three.js reference on every item | all three | ✅ **landed (engine side)** — `asaot3d/apps/ocean-m34`: 4-cascade FFT + atmosphere LUT + caustics + planar reflection + deferred surface + spray + underwater shafts + composite, 86 passes/frame, 7 self-checks all PASS (`asaot3d/three-api-design.md` §39). Residuals against the three.js reference (direct specular 3.4x too bright, fog lift too weak) are recorded in `three-api-design.md` §29.8 / §30.7 and belong to the engine side, not the compiler DoD |

**Why batch 1 is Metal only**: this machine is macOS + Metal, MSL and GLSL ES 3.00 are syntactically close, so the
minimal loop "E6 + float RT + MRT + texelFetch" gets nailed down first before spreading out.

> P1's stated acceptance used to be "a Tessendorf-displaced water surface" — the **actual first acceptance was a
> 2×2 quad**. Deliberate: an ocean tangles "the path is wrong" and "the FFT is wrong" into one symptom, while a
> quad's pixels match `uColor.rgb * vUV.x` bit for bit. FFT is M7.

---

## 10. Risks and effort

| Risk | Description | Mitigation |
|---|---|---|
| **glslang+SPIRV-Cross size** | two multi-MB static libraries; linking them by default violates §1.2(d) | **opt-in**: only `--features native-shader` links them; the default build grows by zero |
| **Cross-compile semantic traps** | GLSL ES 3.00 `uint`/`texelFetch`/MRT → MSL/HLSL has corners (precision qualifiers, `flat` interpolation, integer division) | use the official Khronos chain (not in-house); the corners are production-proven in Flutter/Godot; unit pins per feature |
| **MSL/HLSL semantic differences** | the three ends are not identical (float RT precision, max MRT attachments) | follow `display3d.md` §10.5 "unverified is not silent", measure and register per end |
| **Runtime cross-compile cost** | the first compile of a shader pays glslang+SPIRV-Cross | program cache (same idea as `display3d.md` §9.11); build-time precompile as later optimisation |
| **AOT-only red-line debate** | AIR cannot run it, so it may be mistaken for debt | §8 states it: AIR never had this API; it is an enhancement, decided up front |
| **Effort** | compiler side (formats+MRT+glue) + engine side (renderer+material) + cross-compile chain, across three ends | four stages, P1 Metal first, acceptance per stage |

---

## 11. Definition of done

E6 counts as "done" for a stage only when all of the following hold (`AGENTS.md` §4). **The table separates
verified from unverified** so "the code landed" is never confused with "it was accepted":

| # | Criterion | Status |
|---|---|---|
| 1 | With `--features native-shader`, `Context3DNative` (§6.3) submits GLSL ES 3.00 and it compiles correctly to the target backend | ✅ **verified** — via the runtime `newLibraryWithSource:`, **not** `xcrun metal` (no offline Metal toolchain on this machine, §3.4) |
| 2 | float RT (at least `RGBA_HALF_FLOAT` / `RGBA_FLOAT` / `R32F`) reads and writes correctly, values within tolerance | ✅ **verified** — the 13 items of `apps/shader-m31` (stage 355): 32F/16F targets render and read back, and fp16 **really does lose bits** (it is not silently promoted to 32F). Earlier only the `shader-m30` backbuffer path existed |
| 3 | MRT with at least two attachments, `layout(location=0/1) out` lands correctly | ✅ **verified** — stage 355 reads back the two attachments **separately** (no longer just the reflection's `colorAttachments == 2`) |
| 4 | An `examples/*.as` minimal sample; `as-aot --features native-shader examples/x.as --run` works | ✅ **verified** — `examples/native-shader-probe.as` (compiler side) + `asaot3d/apps/shader-m30` (engine side) |
| 5 | The default build (no `--features native-shader`) is **byte-identical**, and `Context3DTextureFormat` matches AIR's six constants verbatim | ✅ **verified** — `test/unit/native-shader.ts` pins both directions |
| 6 | The AIR side reports honestly (no silent black screen) | ✅ **verified** — default build / `adl` prints `NO-CHANNEL` and exits 0; `ShaderMaterial` throws |
| 7 | `test/unit/` has source-level pins (new format enums, MRT, `--features` registration, the negative "AIR does not support it") | ✅ `test/unit/native-shader.ts` |
| 8 | `enhancements.md` §3's E6 row updated, `README-CN.md`/`README.md` synced, version bumped | ✅ v0.4.314 (project start + M2), v0.4.316 (M3 path + M6) |

> **Why 1/2/3 once differed**: the path (source → MSL → pipeline → draw → pixels) was verified end to end, but
> **float-target and MRT readback** were not. So "float render targets work" could only be said as far as "the API is
> there and the format can be created", not "the numbers are right" — which was exactly the first thing to fix
> before M7 (whose FFT needs two float attachments). **2026-11-03 note**: all three are now covered by
> `shader-m31` (stage 355), and M7 subsequently landed on the engine side (`ocean-m34`).

---

## 12. Decision record

**Decided (this round's implementation is the conclusion)**:

- **Source language**: GLSL ES 3.00 (§4).
- **`ShaderMaterial` existence**: shared by both backends (§7.3).
- **AOT-only isolation mechanism**: runtime probing (§7.4 / §7.5).
- **Float format API shape**: option B, the new class `Context3DNative` (forced by runtime probing, §7.5).
- **① AOT-only red line**: shipped as an **enhancement** (§8), and the landing is harder than planned: zero-byte
  default build + the engine throws and names the switch.
- **② Compile timing**: **runtime** (same shape as three.js) — `uploadProgram` returns `ok=false` plus `infoLog`,
  it does not throw. Build-time precompilation stays registered as "not done" in §8.
- **③ Package path**: `flash.display3D.Context3DNative` / `flash.display3D.NativeProgram3D` /
  `asaot.three.NativeShaderRenderer` / `asaot.three.RendererFactory` / `asaot.three.ShaderMaterial`; format ids
  are `String`s (`"rgba32f"` etc., nine of them), matching `Context3DTextureFormat`'s shape.
- **④ Reachability hook**: the manifest field **`extra-roots`** (plus CLI `--extra-roots`), not `[WasmExport]` —
  that annotation would have to serve two masters (JS export / closure root), which is not a single meaning.
- **⑤ UBO**: not implemented (nothing computes std140 offsets); `uniformsGroups` is not borrowed.
- **⑥ `RawShaderMaterial`**: not implemented — `ShaderMaterial` already takes raw source, a separate class would
  have carried three.js's "no built-in uniforms/attributes" semantics that we inject anyway.
- **⑦ Offscreen MSAA**: per-target `setRenderTargetSamples(tex, n)`, default 1 (§6.10). Not a `Context3D`-wide
  switch: a global one would drag the full-screen data passes into multisampling for no gain.

**Still open**:

1. **FFT ownership**: with E6 unlocked, GPU FFT (§7.8 recommended, no detour) or keeping CPU FFT as a fallback?
   It decides M7's shape and must be settled before starting.
2. **Float-target verification tolerance**: bit-exact / 1e-5 relative / shape-only? The M3 remainder needs it to
   write assertions. (Suggestion: 1e-5 relative for 32F, 1e-3 for 16F, bit-exact only for shape.)

---

## 13. References

- [ActionScript 3.0 reference: `Context3DTextureFormat`](https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3DTextureFormat.html)
- [glslang](https://github.com/KhronosGroup/glslang) — GLSL → SPIR-V, Apache-2.0
- [SPIRV-Cross](https://github.com/KhronosGroup/SPIRV-Cross) — SPIR-V → MSL/HLSL/GLSL, Apache-2.0
- [Ultra-Water](https://github.com/Humpalumps/Ultra-Water) — the reference ocean renderer
- [three.js `ShaderMaterial`](https://threejs.org/docs/#api/en/materials/ShaderMaterial)
- In-repo: [`native-shader-plan.md`](native-shader-plan.md) (work breakdown), [`display3d.md`](display3d.md) §3/§9.18,
  [`compile.md`](compile.md) §3.4.2/§3.5.1, `asaot3d/three-api-design.md` §37