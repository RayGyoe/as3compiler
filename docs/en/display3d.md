# Stage3D (`flash.display3D`) Alignment Investigation and Integration Plan

> This document answers one question: **can AIR SDK's `flash.display3D.*` (Stage3D) be aligned to this project**,
> and if so, how should it land. The core conclusion up front: **it can be implemented, and it is not an
> architectural overthrow but a bounded extension of the existing GPU infrastructure**; but it is the heaviest
> single piece in this project so far (equivalent to rebuilding a small 3D graphics API runtime), and its core
> difficulty is the **AGAL bytecode → native shader language (MSL/GLSL) translation**. The gap is concentrated in
> the whole block "3D GPU resources + state machine + AGAL", not scattered point-filling.
>
> Positioning: Stage3D is to this project the **isomorphic extension** of stages thirty-six through thirty-eight
> "link Skia rather than build our own rasterizer" — what it replaces is the "programmable GPU triangle pipeline"
> layer (raw MTLBuffer/render pass/MSL), **not** the 2D display-list/event layer of `flash.display.*`. The
> display-list stacking relationship and event-flow semantics are unchanged; Stage3D merely adds a separate GPU
> render pass that converges with the 2D surface at the window compositing stage.

---

## 1. What `flash.display3D` (Stage3D) Is

It is the **programmable GPU 3D pipeline** introduced by Flash Player 11; the official description says it is
"highly similar to OpenGL ES 2, but abstracted to be hardware-portable". **Its only geometric primitive is the
triangle.** It is not the 2D display list of `flash.display.*` — Stage3D is independent of the display list,
stacked between `StageVideo` and the display list.

The full API surface (one more layer of dependencies than the 19 classes listed on the package-detail page):

| Category | Classes |
|---|---|
| Host | `flash.display.Stage3D` (`requestContext3D`/`context3D`/`x`/`y`/`visible`, dispatching the `context3DCreate` event) |
| Context | `Context3D` (about 30 methods: `configureBackBuffer`/`clear`/`present`/`drawTriangles`/`drawTrianglesInstanced`/`setVertexBufferAt`/`setProgram`/`setTextureAt`/`setBlendFactors`/`setDepthTest`/`setCulling`/`setStencilActions`/`setRenderToTexture`/`setScissorRectangle`/`setProgramConstantsFrom*`/`setColorMask`/`drawToBitmapData`, etc.) |
| Resources | `VertexBuffer3D`, `IndexBuffer3D`, `Program3D` (`upload(AGAL bytecode)`) |
| Textures | `flash.display3D.textures.{Texture, CubeTexture, RectangleTexture, TextureBase, VideoTexture}` |
| Constant classes | 15: `BlendFactor`/`BufferUsage`/`ClearMask`/`CompareMode`/`FillMode`/`MipFilter`/`Profile`/`ProgramType`/`RenderMode`/`StencilAction`/`TextureFilter`/`TextureFormat`/`TriangleFace`/`VertexBufferFormat`/`WrapMode` |
| Implicit dependencies | `flash.geom.Matrix3D`, `flash.geom.Vector3D`, `Vector.<Number\|uint\|float>`, `ByteArray` (little-endian reads) |

> Note that `AGALMiniAssembler` (`com.adobe.utils.*`) is **not a runtime** but a pure AS3 utility class — as long
> as the compiler can compile its source, it runs as user code (only string parsing + bit packing, producing a
> `ByteArray`). So no special runtime support is needed, but real Starling/Away3D projects all depend on it, so it
> must be used for end-to-end acceptance.

---

## 2. Current-State Inventory (have vs missing)

| Item | Status |
|---|---|
| 2D render loop | ✅ Skia CPU raster + GPU (native **Metal** `metal_glue.mm`, web **WebGL2** `web_glue.cc`) + SDL2 window |
| `ByteArray` (including grow/compress/uncompress) | ✅ implemented |
| `Point`/`Rectangle`/`Matrix` | ✅ implemented |
| `Vector.<T>` type system | ✅ modeled |
| `Stage3D` / `Context3D` / `display3D.*` | ❌ entirely unimplemented (`TODO.md` explicitly lists `stage3Ds` as an unmodeled type) |
| `Matrix3D` / `Vector3D` | ❌ unimplemented |
| **Native GPU triangle pipeline** | ❌ the existing Metal backend is only "Skia Ganesh → Metal + flush", with **no** raw `MTLBuffer`/render-pass/MSL-compilation ability |

Conclusion: **the gap is concentrated in the whole block "3D GPU resources + state machine + AGAL"**, not
scattered point-filling.

---

## 3. The Core Technical Difficulty: AGAL Translation (the only genuinely "hard" point)

Stage3D shaders are **AGAL (Adobe Graphics Assembly Language) binary bytecode**, not GLSL/HLSL/MSL.
`Program3D.upload()` receives bytecode, and the runtime is responsible for translating it into the target
platform's shader language.

- **Structure**: magic `0xa0` + version + program type + shader type, followed by a run of **fixed 24-byte**
  slots (`[opcode:4][dest:4][src1:8][src2:8]`), ≤200 instructions/program.
  **Instructions with no destination register (`kil`/`ife`/`ine`/`ifg`/`ifl`) also fill all 24 bytes**:
  `AGALMiniAssembler.as` writes only the instruction's **operands** into the slot's `src1`/`src2`, but **still
  writes 4 zero bytes into the `dest` slot** (`if ( j == 0 ) { agalcode.writeUnsignedInt( 0 ); }`) — so the
  decoder **must unconditionally** skip the `dest` slot, otherwise each operand of that instruction is **read 4
  bytes early**. That is exactly what happened before stage one-hundred-fifteen: away3d `EnvMapMethod`'s
  `kil temp2.w` ("kill the fragment if the cube sample alpha < 0.5") was decoded as `in.v0.xxxx`, turning the
  criterion into **post-transform normal x < 0** — a world-space half-plane whose projection is exactly the
  **screen-center vertical line**, discarding whole swaths of the left outer surface of `Basic_SkyBox`'s torus,
  varying with the rotation angle (looking like "at some angles the ring goes missing"). Nail:
  `test/unit/stage3d.ts`'s `stage3d/agal-operand-slots`.
- **Register model** (tiered by version, see AGALMiniAssembler `initregmap`): `va` (attribute, v1/v2=7, v3=15),
  `vc` (vertex constant, v1=127, v2/v3=249), `vt` (temp, v1=7, v2/v3=25), `op/oc` (output),
  `v` (varying, v1=7, v2/v3=9), `fc` (fragment constant, v1=27, v2=63, v3=199), `ft` (v1=7, v2/v3=25),
  `fo` (v1=0 only `oc`, v2/v3=3 i.e. MRT), `fd` (v2/v3 depth output), `fs` (sampler); AGAL3-unique `iid`
  (instancing), `vs` (vertex texture sampling).
- **Instruction set**: about 28 base instructions (`mov/add/sub/mul/div/rcp/min/max/frc/sqt/rsq/pow/log/exp/nrm/sin/cos/dp3/dp4/crs/m33/m34/m44/abs/neg/sat/kil/tex`, etc.),
  with swizzle and write-mask; AGAL2 extends control flow (`ife/ine/ifg/ifl/els/eif`) + derivatives
  (`ddx/ddy`) + MRT; AGAL3 extends instancing and vertex texture sampling.

**The translation approach is mature and deterministic**:
- native: AGAL → **MSL** (`newLibraryWithSource` compilation), registers mapped to `float4`, `tex` mapped to
  `texture2d.sample()`.
- web: AGAL → **GLSL ES** (WebGL2).
- **Authoritative reference**: Ruffle already implements Stage3D (AGAL → wgpu/WebGPU), and there are several
  open-source AGAL → GLSL implementations in the community; the semantic rules (swizzle/mask/register
  constraints/validation-error list) are fully defined in `Program3D.upload`'s 40+ validation errors.

This part is a **self-contained deterministic translator in the pure C/C++ glue layer**, not touching the
front-end "translate AS3→C" main pipeline, consistent with AGENTS.md §2.9's "heavy work goes through linking/glue"
iron rule. The real grunt work is in the AGAL validator (40+ errors) and the extensions of AGAL1/2/3's three
generations (MRT, instancing, the `iid` register, `fragment output index`).

---

## 4. Layered Alignment Plan (key: reuse what already exists)

| Layer | Approach |
|---|---|
| Front end (AST/lexer/parser) | zero changes. `Context3D` etc. are all ordinary builtin classes, going through `symbols.ts` modeling + `runtime.ts` helpers |
| Runtime state machine | `Context3D` is a pure state machine (blend/depth/stencil/cull/scissor/colorMask/fillMode + the currently bound buffer/program/texture/constants); a C struct suffices |
| GPU resources | `metal_glue.mm` extension: `MTLBuffer` (vertex/index), `MTLTexture` (2D/cube/rect), `MTLLibrary` (MSL), `MTLRenderPassDescriptor` (render-to-texture), `MTLDepthStencilState` |
| On-screen compositing | Stage3D's back buffer composites with the Skia 2D surface into the same window (the display3D layer above/below the display list), reusing the existing SDL2/Metal presentation path |
| web | `web_glue.cc` extension with raw WebGL2 (`createBuffer`/`shaderSource`/`drawElements`), or reuse the existing Ganesh context |
| Prerequisite classes | `Matrix3D` (perspective projection/append/recompose), `Vector3D` — pure logic, the same pattern as `Matrix` |

`AGALMiniAssembler` (`com.adobe.utils.*`) is **not a runtime** but a pure AS3 utility class — as long as the
compiler can compile its source, it runs as user code (only string parsing + bit packing, producing a
`ByteArray`). So no special runtime support is needed, but real Starling/Away3D projects all depend on it, so it
must be used for end-to-end acceptance.

---

## 5. Build and Linking

Stage3D's landing reuses the "glue layer + build manifest" capability already present in stages thirty-six
through thirty-eight, doing only an **incremental extension** without introducing a new build paradigm:

| Concern | Note |
|---|---|
| Glue layer | Add the AGAL→MSL/GLSL translator + GPU resource-management functions into `metal_glue.mm` (native) / `web_glue.cc` (web), still exposing a flat C interface via `extern "C"` |
| Prerequisite classes | `Matrix3D`/`Vector3D` are pure AS3 logic classes, going through the existing `symbols.ts` builtin modeling, not touching the GPU |
| Build manifest | No new third-party library needed — Metal (a macOS system framework) and WebGL2 (built into the browser) need no extra `-l`; reuse the existing `metal_glue.mm`'s `-framework Metal -framework QuartzCore` linking |

> **Metal headers and frameworks**: `metal_glue.mm` already exists from stage seventy-five (the native Metal
> rendering backend), and the creation of `MTLDevice`/`MTLCommandQueue` and the Ganesh integration of
> `SkSurface::MakeFromBackendRenderTarget` have landed. What Stage3D reuses is the "**raw** Metal command buffer
> on the same `MTLDevice`", not going through Ganesh again — Ganesh is Skia's 2D abstraction, whereas Stage3D's
> triangle pipeline wants direct `MTLBuffer` + `MTLRenderPipelineDescriptor`; the two coexist on the same
> `MTLDevice`, submitted via the same `MTLCommandQueue`, and finally share one drawable for presentation.

> **Landing status (native = stages eighty-two~eighty-three, web = stage eighty-nine / thirty)**: it was not put
> into `metal_glue.mm`/`web_glue.cc`, but into separate self-contained glue files each exposing the **same flat
> `s3d_*` C signatures**:
>
> | Target | File | Shader | Build switch |
> |---|---|---|---|
> | native (macOS) | `vendor/stage3d_glue.mm` | raw Metal, AGAL→MSL | `ASC_RENDER_STAGE3D=1` |
> | web | `vendor/stage3d_webgl.cc` | WebGL2/GLES3, AGAL→GLSL ES | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_GLSL=1` (plus `ASC_RENDER_DEPTH_STENCIL=1` when `<depthAndStencil>` is present) |
>
> Therefore the `Context3D` state machine, the `as_s3d_*` wrappers, and the AGAL translator call sites in the
> generated C are **completely identical on both ends**, and the shader language is chosen only by the build-time
> `ASC_AGAL_TARGET`. The web side's GL↔AS3 semantic differences (Y-axis flip, BGRA swap, per-register uniform,
> FBO/stencil, CPU-readback presentation and its cost) are in [`html5-web.md`](html5-web.md) §3.3.
> Whether to mount a backend is auto-determined by `src/air-app.ts`'s `detectStage3D(files)` scanning the source
> (applicable to both native and web).

---

## 6. Recommended Phased Roadmap (matching the existing "stage XX" convention)

| Stage | Goal |
|---|---|
| **A prerequisite** | `Matrix3D` + `Vector3D` + completing `Vector.<Number/uint/float>` (pure logic, low risk) |
| **B AGAL kernel** | AGAL bytecode parser (AGAL1/2/3) + validator + →MSL/GLSL translator (**the hardest step**, a stage of its own) |
| **C Context3D skeleton** | `Stage3D` + `Context3D` state machine + `VertexBuffer3D`/`IndexBuffer3D`/`Program3D`/`Texture`(BGRA/RGBA) + `drawTriangles`, `enableErrorChecking=false` taking the async path |
| **D end-to-end** | Land the raw Metal pipeline, get a "colored triangle" demo running, then roll out blend/depth/stencil/cull/scissor/render-to-texture |
| **E alignment hardening** | `drawToBitmapData`, `setRenderToTexture`, CubeTexture/RectangleTexture, AGAL2/3 GPU-side end-to-end on-screen (MRT render pass / instancing) |

**The kernel translator supports all three AGAL1/2/3 generations; the initial `Context3D.profile` converges to
baseline (AGAL1 capability + uncompressed 2D/cube textures + no instancing/MRT)** — which exactly covers Stage3D's
largest real consumer, **Starling** (a 2D-on-GPU framework).

### 6.1 Final Acceptance Demo: `examples/shmup-stage3d`

> This demo is the **final end-to-end acceptance target** of stages seventy-nine through eighty-three — once
> everything lands, this project should compile it from `.as` into a native executable and produce a picture
> identical to `mxmlc + adl`.

**Source and structure**: Christer Kaitila's "Stage3D Shoot-em-up Tutorial" (a tutsplus tutorial; a batched
sprite engine predating Starling). Roughly 1806 lines of AS3:

| File | Responsibility |
|---|---|
| `Main.as` | entry: `requestContext3D` → `CONTEXT3D_CREATE` → the ENTER_FRAME render loop |
| `LiteSpriteStage.as` | the Stage3D renderer: `configureBackBuffer` + `Matrix3D` model-view matrix + batch driving |
| `LiteSpriteBatch.as` | draws all sprites in a single batched `drawTriangles` (re-uploading vertices each frame) |
| `LiteSpriteSheet.as` | atlas texture: `createTexture(BGRA)` + `uploadFromBitmapData` + per-level mipmap generation |
| `Entity.as` / `EntityManager.as` | entity object pool (`Vector` splice reuse) |
| `GameGUI.as` | the 2D GUI (a `Sprite` display-list layer, coexisting with the Stage3D layer) |
| `com/adobe/utils/AGALMiniAssembler.as` | a pure AS3 utility class (818 lines): string AGAL → bit-packed `ByteArray` |

**The Stage3D API surface this demo covers** (i.e. the acceptance checklist, all required):

- `Stage3D`: `requestContext3D(Context3DRenderMode.AUTO)`, `context3D`, the `CONTEXT3D_CREATE` event, `x`/`y` positioning
- `Context3D`: `configureBackBuffer`, `clear`, `present`, `drawTriangles`, `setProgram`,
  `setBlendFactors(ONE, ONE_MINUS_SOURCE_ALPHA)`, `setProgramConstantsFromMatrix(VERTEX, transpose)`,
  `setTextureAt`, `setVertexBufferAt` (**multiple vertex streams**: stream 0 = `FLOAT_3` position/alpha, stream 1 = `FLOAT_2` UV),
  `createVertexBuffer`, `createIndexBuffer`, `createProgram`, `createTexture`
- `Program3D.upload` (two AGAL bytecodes: vertex + fragment)
- `VertexBuffer3D` / `IndexBuffer3D.uploadFromVector`
- `Texture.uploadFromBitmapData` (BGRA + multiple mipmap levels)
- `Matrix3D.appendTranslation` / `appendScale`
- **AGAL1 shaders** (`AGALMiniAssembler.assemble` defaults to `version=1`): `dp4`/`mov`/`tex`/`mul` + swizzle + sampler options
- Implicit dependencies: `Vector.<Number/uint/T>`, `Rectangle`/`Point`/`Matrix`, `BitmapData`, `getTimer`

**Correspondence with the stages**:

- This demo's shaders are **AGAL1** (`assemble` called without a `version` argument), **falling exactly within
  the baseline convergence range** — once stage seventy-nine (`Matrix3D`/`Vector3D`) + eighty (AGAL kernel,
  covering AGAL1 instructions) + eighty-one (`Context3D` state machine) + eighty-two (Metal end-to-end) are all
  done, it can be compiled and run, without waiting for stage eighty-three's MRT/instancing.
- It **does not depend on** AGAL2/3 features (no `ife`/`ddx`/MRT/`iid`), making it a precise probe of "is
  baseline closed"; stage eighty-three's (AGAL2/3 on-screen) acceptance is covered separately by a dedicated demo.
- `build-and-run.sh` compiles and runs with `mxmlc -swf-version=13` + `adl` (`renderMode=direct`), consistent with
  AGENTS.md §2.4's convention "use `mxmlc` as the reference compiler and cross-validate on the same `.as`" —
  when this project compiles it, that script's produced picture/behavior is the baseline comparison.

---

## 7. Risks and the Boundary of "Explicitly Not Recommended for Alignment"

| Item | Judgment |
|---|---|
| `VideoTexture` | ❌ depends on `NetStream`/`Camera` (video decoding), **excluded**, returns null |
| Compressed textures (ATF/DXT/PVRTC) | ⚠️ **partial** (stage eighty-nine / twenty-one): the ATF container's `format 3/5` (raw DXT1/DXT5) is implemented — at runtime `as_atf_decode_dxt` decodes to straight-alpha ARGB on the CPU and takes the ordinary texture-upload path (no premultiply, consistent with adl handing raw DXT5 to the GPU; mip 1+ is not decoded, only level 0 taken); ETC1/PVRTC, cubemap, and `format 0xc/0xd` (JPEG-XR lossy) still **error loudly** (`Error #3680`), not silently producing an empty image |
| Precise reporting of `driverInfo`/`totalGPUMemory`/`profile` | `driverInfo` now reports by "context-level backend": linked with `stage3d_glue.mm` (`ASC_RENDER_STAGE3D`) gives `"Metal (Stage3D)"`, otherwise `"Software (state machine)"` (**not** looking at `ASC_RENDER_METAL`, which denotes only the window-compositing backend); `profile` is fixed to `"baseline"`; `totalGPUMemory` is implemented but is an **approximation** (stage eighty-nine / twenty-one: the back-buffer BGRA8 byte count plus the D32S8 byte count when depth-stencil is present) — it must exist because Starling's `StatsDisplay.supportsGpuMem` probes with `"totalGPUMemory" in context` and adds/removes a whole HUD row accordingly |
| Synchronous throw on `enableErrorChecking=true` | optional; do only the `false` async path first |
| AGAL2/AGAL3 GPU-side end-to-end on-screen (MRT/instancing) | translation is covered in the kernel stage (stage eighty); the Metal-side MRT `[[color(i)]]` and AGAL3 `iid` → `[[instance_id]]` on-screen are deferred to stage eighty-three |

---

## 8. Workload and Conclusion

- **Workload**: this is "small GPU runtime" scale, roughly estimated at the same magnitude as the entire existing
  "stages thirty-three through forty (events + display list + rendering + window)" block; the AGAL translator +
  validator is about 40%, the `Context3D` state machine and Metal/WebGL resource management 40%, and the
  prerequisite classes plus end-to-end regression 20%.
- **Feasibility**: ✅ technically fully feasible, with no insurmountable obstacle; AGAL translation has mature
  references (Ruffle/open-source AGAL→GLSL), the raw Metal/WebGL pipeline is a standard capability, and the
  project already has a Metal/WebGL2/GPU presentation foundation to reuse.
- **The only thing to decide**: whether it is worth the investment — because the project already has a complete
  2D GPU rendering chain, and Stage3D's incremental value lies only in "running third-party engines built on
  Stage3D such as Starling/Away3D", not in drawing ordinary UI.

---

## 9. Cube Maps and Texture Upload (landed in stage one-hundred-twelve; mip/sampler corrected in one-hundred-thirteen; shared queue settled in one-hundred-fourteen; web backend completed in one-hundred-sixteen; program cache in one-hundred-seventeen; 2D mip chain + no-chain drop + state-object cache completed in one-hundred-twenty-eight)

`CubeTexture` and the 2D `Texture`'s **upload timing**, **mip semantics**, and **cube faces** were all settled by
measurement while getting headless `Basic_SkyBox` (away3d) running, and they **jointly** decide "whether the 3D
channel is visible" — a mistake does not error, it merely makes the texture **silently** empty and the window show
the stage background (Basic_SkyBox was once **pure white** because of this).

### 9.1 Upload Is **Synchronous** (not deferred to draw)

AIR's `uploadFromBitmapData(source, …)` hands the pixels to the GPU **on the spot**; the caller subsequently
`source.dispose()`-ing it is **legal and common** — away3d's `MipmapGenerator.generateMipMaps` does exactly
`mipmap.dispose()` on the line right after uploading that temporary `BitmapData`. This runtime's
`BitmapData_dispose` nulls `pixels`, therefore:

- 2D `Texture_uploadFromBitmapData`: on a hit it **immediately** calls `as_s3d_texture_from_pixels` (Starling's
  text-field textures likewise "dispose right after upload", for the same reason).
- `CubeTexture_uploadFromBitmapData`: six faces cannot be deferred one MTLTexture per face, so it **snapshots the
  pixels at mip 0** into the face's own `BitmapData` (with a write barrier, synchronously), then builds one
  `MTLTextureTypeCube` at submit time.

### 9.2 The mip Chain: cubes get a full chain + 2D accepts every uploaded level (corrected in stage one-hundred-thirteen, **2D completed in stage one-hundred-twenty-eight**)

**What the bug was**: the torus's environment reflection once showed a fine "mesh pattern" across its whole body
(high-frequency noise from the snowy background showing through the ring), while the skybox was fine. The root
cause was that the **cube map had no mip chain**: AIR's `BitmapCubeTexture` uploads **every level** via
`MipmapGenerator.generateMipMaps`, and away3d's AGAL says `<cube,linear,miplinear>` (§9.5) — so AIR's environment
reflection is **per-level mip filtered**; this runtime at the time kept only level 0 to sidestep the deferred
upload, and "the **magnified** skybox showed no problem, while the **minified** torus reflection directly
went wrong".

- **`CubeTexture`**: it now builds an `MTLTextureTypeCube` with `mipmapped:YES`, writes level 0 for the six faces,
  then uses one blit (`generateMipmapsForTexture:`, on the same queue so it is ordered before the frame's draw
  batch and waits for its completion) to generate levels 1..n. Metal's box filter produces content at the same
  level as the CPU-side `MipmapGenerator`, and **does not depend on** the deferred-upload ordering — a more robust
  approach than replicating away3d's software mip generation.
- **2D `Texture` (since stage one-hundred-twenty-eight)**: `uploadFromBitmapData(source, miplevel)`'s
  `miplevel != 0` now **really uploads that level per AIR's measured contract** (see §9.12) — no longer the
  "only level 0 accepted" known deviation. **One faithful record**: away3d's `MipmapGenerator`-style loop uploads
  the **same** scratch bitmap level by level (`mipmap.draw(...)` draws the downscaled content back into itself),
  and our region rule copies exactly what AIR reads (top-left `lw×lh`, read **by the source's row pitch**) — which
  is precisely adl's behavior (`temp/mipprobe/`'s T5: reading back `16/48/80/112` level by level), so it is
  dot-for-dot aligned, without extra "correcting" of the pixels the app itself writes back.
- **No chain + `miplinear` ⇒ the whole draw is dropped**: `Texture.mips` (set by any `miplevel > 0` upload) is the
  only criterion, **not** `createTexture`'s `mipmapped` flag (§9.12 T3/T4 measurement).

> Full comparison evidence: `temp/ringdiag/` (screenshots before and after the fix + side-by-side with the AIR
> reference), `temp/ringdiag/mipfix-*.png`.

### 9.5 Sampler State Comes from the AGAL `tex` Flags (stage one-hundred-thirteen measurement)

**Why it is necessary**: away3d and Starling **both never call** `setSamplerStateAt` (0 hits in each tree); they
only write AGAL flags: away3d's environment map is `<cube,linear,miplinear>`, the skybox (`SkyBoxPass`) likewise
`,miplinear`, and Starling is something like `<2d,linear,nomip>`. If the runtime **ignores** these bits (the old
behavior), filtering/wrapping/mip are all whatever self-chosen default applies — which happens to match away3d's
default path, **looking right**, but away3d's `useSmoothTextures = false` branch wants `nearest` and would be
silently rendered as bilinear.

Measured (AIR SDK 51.4.1; probe `temp/sampprobe/`, 13 cases × 2 read-backs, each case with an independent clear
color + md5 version stamp):

| Conclusion | Evidence |
|---|---|
| **AGAL flags are executed** | the same program `<2d,linear,nomip>` vs `<2d,nearest,nomip>`: a 2×2 texture magnified shows **gray** at the center (bilinear average) vs **a solid color** (single texel) |
| **`setSamplerStateAt` overrides the flags** | cases A3/A4: called after setProgram, the result follows the explicit call |
| **The two are "last writer wins"** | case A5: call `setSamplerStateAt` **first**, then setProgram → the result follows the AGAL flags |
| **`miplinear` really selects a level by lod** | uv tiling T=1/8/16/64 (lod = log2(texels per pixel) = log2(T/4)) → samples the **per-level distinctive color** (red/green/blue/magenta) of level 0/1/2/4 |
| `nomip` / explicit `MIPNONE` does not select a level | cases B6/B7: same tiling still gives level 0 |
| mip filtering + a texture with **no mip chain** → **the whole draw is dropped** | case A6: the read-back is entirely the clear color (AIR treats it as an invalid combination). **Already landed** (stage one-hundred-twenty-eight, same condition both ends; the web-side drop point must be **before** `glUseProgram`, otherwise GL samples the incomplete texture and reads **black** rather than the clear color) — see §9.12 |

Implementation: `as_agal_sampler_flags` (`runtime.ts`) decodes, at `Program3D.upload` time, each sampler
register's `(filter, wrap, mip)` from AGALMiniAssembler's bit fields (`filter` 28 / `mipmap` 24 / `repeat` 20 /
`dim` 12), packing them into `Program3D.samplerUsed/samplerFlags`; `Context3D_setProgram` calls
`as_s3d_apply_agal_sampler_state` to write them into the GPU's **same** per-unit state
(`s3d_set_sampler_state_i`), so it is naturally "last writer wins" with an explicit `setSamplerStateAt` (AIR
semantics). Note that AGAL's filter bit 1 = linear, whereas the glue's `filter` 1 = nearest; invert when crossing
the boundary.

> Previously `miplinear` degraded to level 0 (`mipmapped:NO`); now the cube has a chain + the sampler really
> selects a level, and **both are indispensable** — adding only the mip chain while the sampler is still `nomip`
> leaves the torus wrong.

### 9.6 Cube Maps' GPU Side

- One `MTLTextureTypeCube`, with the six faces written in **AGAL/Stage3D order +X, −X, +Y, −Y, +Z, −Z** — a face is
  a texture **slice**, and must use the selector with `bytesPerImage`
  (`replaceRegion:mipmapLevel:slice:withBytes:bytesPerRow:` **does not exist** on a cube; sending it is an
  unrecognized selector, i.e. a hard crash, not a driver no-op).
- **Identification is by vtable, prior to any field read shaped like `Texture`**: `CubeTexture.face0` and
  `Texture.gpu` are at the **same word offset**, so reading `->gpu` first would use a `BitmapData*` as an
  MTLTexture (Basic_SkyBox collided with this early on via `objc_retain` on a dangling pointer).
- AGAL's `<cube>` dimension declares the sampler as `texturecube<float>` (MSL) / `samplerCube` (GLSL), and the
  coordinates take `.xyz`.

### 9.7 Acceptance

`examples/away3d-core/Basic_SkyBox.as` (8 `[Embed]` resources, including 6 512² JPEG skybox faces), once built
headless, renders a **snowy-mountain skybox + an environment-reflective chrome ring**, matching the adl reference
(`temp/away3d/skybox-01-view.png`) in the same scene and composition; sky sample (30,35,35) vs adl (33,37,36). The
torus's **reflection sharpness** is stage one-hundred-thirteen's acceptance point: before the fix the lower half
of the ring body was a per-pixel mesh pattern, after the fix it is a continuous sharp mirror of AIR's level
(`temp/ringdiag/ab-air-vs-ours.png`). These invariants cannot go into `examples/` (the example suite is pure C,
no GPU), so they are pinned at the source level by the unit groups **`stage3d/texture-upload`**,
**`stage3d/mip-semantics`**, **`stage3d/dss-cache`**, **`stage3d/agal-sampler-flags`**, and
**`stage3d/gpu-queue-sharing`** (`test/unit/stage3d.ts`). Stage one-hundred-twenty-eight's three-end acceptance
also has offscreen runnable probes: `temp/mipprobe/` (mip semantics, 18 lines) and `temp/bakeprobe/` (bake
resolution and `draw` geometry, 20 lines), both `adl == native(AOT) == web(AOT)` line-for-line identical — see
§9.12, §9.13.

### 9.8 The compositing target texture **must share one `MTLCommandQueue` with Skia** (stage one-hundred-fourteen)

Stage3D's offscreen target (`ASC_stage3d_tex`) is **written first and read later within the same frame**:
`ASC_window_render`'s order is `as_s3d_flush_all()` (commit + `waitUntilCompleted`) → get the drawable →
`as_skia_mtl_draw_texture(canvas, ASC_stage3d_tex, …)` (Skia **samples** this texture) →
`as_skia_mtl_flush` (Ganesh `flushAndSubmit` + present). **The CPU-side submission order is correct**, but
**the GPU-side read and the next frame's write still overlap**, because Metal's hazard tracking is **effective
only within a single queue** — between two queues there is neither an execution-order guarantee nor cross-command-buffer
hazard tracking.

The consequence is a picture easily misjudged as "the model is broken": frame N's compositing read overlaps
frame N+1's Stage3D write, **the write wins**, so tiles not yet written by the ring pass stay on that frame's
skybox (background) ⇒ **the object is sliced along a straight vertical tile boundary, the gap revealing the
background, while the background itself is intact**. On `Basic_SkyBox`, 11 of 25 consecutive frames hit it
(occasionally a frame with a vertical seam across the whole picture).

**Therefore: `s3d_create` must adopt Ganesh's queue** (`metal_glue.mm`'s process-level `sk_mtl_shared_queue()`),
rather than creating its own. Key points:

- That queue is **held until process exit and never released** (`sk_mtl_destroy` only sets `g_queue = nil`): a live
  Stage3D context is still using it, and the next window must get **the same one**;
- `stage3d_glue.mm` declares it with `__attribute__((weak_import))` — **a headless Stage3D build links
  `stage3d_glue.mm` without linking `metal_glue.mm`** (no window ⇒ no Ganesh), where the symbol does not exist and
  the context falls back to creating its own (always +1, balanced with `s3d_destroy`'s release);
- The target texture itself needs no change: `MTLStorageModeShared` + `usage = RenderTarget|ShaderRead` + the
  default `MTLHazardTrackingModeTracked` is exactly the precondition for same-queue hazard tracking to take
  effect;
- **Do not** substitute "make the CPU wait for the GPU at submit time" (Ganesh `GrSyncCpu::kYes`) for a shared
  queue: that serializes CPU/GPU every frame, precisely eating up the ~0.6 ms/frame that stage one-hundred-four
  saved with batched submission. `MTLSharedEvent` is also infeasible — it needs a reliable "compositing has
  finished reading" signal, which Ganesh cannot provide.

**Acceptance** (`temp/ringdiag/cap.py`: window positioning + parking the cursor at the window center to freeze the
camera + region-screenshot burst): after sharing the queue, **390 frames with zero slicing** (before the fix 11
of 25 frames were sliced, `adl` 60 frames with zero tearing).

### 9.9 The Frame Boundary Only `commit`s, **not** `waitUntilCompleted` (stage one-hundred-fifteen)

`s3d_flush` splits into two flavors, sharing one submission path (`s3d_flush_impl(ctx, wait)`):

| Flavor | When used | Why |
|---|---|---|
| `s3d_flush` (commit + wait) | `s3d_readback`, `s3d_readback_render`, `s3d_resize`, `s3d_destroy` | the CPU really must **read** the target pixels (AIR's "readback gets what was drawn" contract) |
| `s3d_flush_async` (commit only) | `Context3D.present`, before `ASC_window_render` compositing | only the write needs to land before **GPU-side** compositing |

**The key is that "CPU-visible" and "GPU-visible" are not the same thing**: the CPU wait
(`waitUntilCompleted`) exists only so the write is visible to the **CPU**; what really samples this texture at the
frame boundary is the **GPU-side compositing**, which since §9.8 **shares one queue** with Stage3D, and Metal
executes command buffers on the same queue in submission order and automatically inserts dependency barriers for a
default-`Tracked` target ⇒ a later-submitted compositing buffer **cannot** read it before this batch's write has
landed. Ganesh itself does exactly this: `sk_mtl_end_frame` submits the compositing buffer **without waiting at
all**. If the list contains any **CPU read-back**, the wait flavor must be used — `s3d_draw` itself **never**
flushes (the batch retires only once, at the frame boundary).

**Measured** (`ASC_S3D_STATS=1`, `Basic_SkyBox`): `gpu=0.13ms wait=0.00ms commit=0.01ms
per-batch draws/batch=2.0` — the `wait≈0.93ms/frame` on stage one-hundred-four's books (the whole frame's GPU is
only 0.34ms, ~11% of the 120Hz budget of 8.33ms) drops to `commit≈0.01ms/frame`; re-measuring stage
one-hundred-four's capacity in the same round: Starling's `showStats` penalty **−6.4%/−5.0% → zero** (OFF 61238 /
ON 61603 peak object count).

**Acceptance method (reference-independent)**: a per-pixel mask over the screenshot region is unusable — the
camera yaw is the **cumulative sum** of mouse offset (poses across runs are incomparable), the skybox's **clouds
move**, and the window server overlays color-management dithering on the screenshot (within one run the per-pixel
max−min of a static sky corner reaches 103). So a detector that **only recognizes "a vertical line running
through the ring band"** was used instead (per column, the row mean of `V(x)=|I(x+1)-I(x)|`, minus the left/right
neighboring columns and the column's temporal median across the whole sequence): 320 frames max **15.96**
(median 5.34), whereas a sensitivity self-check with a pasted 10px-wide vertical bar of another pose gives
**24.88**; the seams of both defects are such vertical lines (the AGAL `kil` world x=0 half-plane, and the
cross-queue tearing tile boundary), while a real torus contour is a **curve** (any single column has an edge on
only a few rows).

### 9.10 Three Alignments of the web backend (`vendor/stage3d_webgl.cc`) (stage one-hundred-sixteen)

Stage one-hundred-thirteen landed "AGAL sampler flags" and "the cube's whole mip chain" on the Metal side first,
and the WebGL glue **did not keep up** — yet the `s3d_*` signatures are the **same seam** shared by both ends (the
generated C switches backend with zero changes), so the web builds of `away3d-core` and `air-starling-demo` both
fell at **link time** on `undefined symbol: s3d_set_sampler_state_i / s3d_upload_cube_texture`. Three alignments:

1. **Texture target registry**: GL **cannot answer** "what is this texture object's target" (there is no
   `glGetTexParameter`-style query), so the glue records it itself: `struct S3DTexTarget{GLuint id; int cube;}`
   + a `texTarget[64]/texTargetN` registry (`s3d_record_target`/`s3d_tex_gltarget`), registered at upload,
   **bound per unit by the registered target at draw**, cleaned up at destroy. **An empty unit must clear both
   `GL_TEXTURE_2D` and `GL_TEXTURE_CUBE_MAP`** — clearing only 2D leaves the last cube binding on that unit to be
   read by the next **2D** sampler (the measured failure mode: not "not bound").
2. **cube upload + mip chain**: `s3d_upload_cube_texture` uploads level 0 face by face via
   `GL_TEXTURE_CUBE_MAP_POSITIVE_X + face`, then `glGenerateMipmap` generates the whole chain (choosing GPU
   generation over replicating away3d's software mips, consistent with §9.2's Metal contract); the cube also sets
   `GL_TEXTURE_WRAP_R` (the 3D wrap axis, absent for 2D).
3. **Clear must explicitly enable the write masks**: the only **web-only** rendering bug this round — **`glClear`
   is governed by the GL write masks** (`glColorMask`/`glDepthMask`/`glStencilMask`), whereas Metal's
   `loadAction=Clear` is **not**. A pass's `depthWrite=false` leaves `GL_DEPTH_WRITEMASK` at 0, so `s3d_draw`'s
   **deferred depth clear is silently skipped** ⇒ the previous frame's near depth occludes the skybox (z≈1.0) and
   all subsequent draws, turning `Basic_SkyBox`'s torus into a **solid black disk** (the black disk = the union of
   the torus outlines across frames; a per-draw probe measured RGB constantly `(0,0,0,255)`). Fix: before
   clearing, do `glDepthMask(GL_TRUE); glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE); glStencilMask(0xFF);` then
   `glClear`; each draw carries its own masks, so nothing leaks to subsequent passes.

**Regression nails**: `test/unit/stage3d.ts`'s **`stage3d/webgl-abi`** pins "**every `s3d_*` called at runtime
must be defined in the WebGL glue**" as a structural invariant (a "reference ⊆ definition" comparison after
stripping comments, naming the two entry points above), plus pins on the target registry, clearing both targets on
an empty unit, and forcing the three masks before a clear. (Simulating pre-fix text with the two entry points
deleted from the glue, that group immediately lists those two symbols.)

---

### 9.11 Program Cache: The Same Program Is a "Binding", Not a "Recompile" (stage one-hundred-seventeen)

**Why it is worth a dedicated section**: this is the real root cause of `Basic_SkyBox`'s **62 MB/min memory
growth**, and a category easily masked by "it looks like it runs" — **the picture is completely correct**, only
the driver side keeps creating objects.

**Symptom and characterization**: RSS grows linearly +62.4 MB/min after the window is activated; a `footprint`
diff shows the increment **100% in `MALLOC_SMALL`** (not the GC heap, not GPU/IOSurface); `leaks` reports only
304 KB (all system XPC) ⇒ **the objects are still referenced, not an unreachable leak**; `heap` at 44 s reports
**10,790 `MTLVertexDescriptor`s** (≈ 2/frame) and 68,706 `CFString`s.

**Root cause**: the emit-side program guard is **depth 1** (`o->program != o->gpuProgram` = "recompile only when
different from **the previous one**"), while a scene **alternating two material sets per draw** is the norm
(`Basic_SkyBox` alternates the 1600-triangle chrome ring with the 12-triangle skybox) ⇒ the guard is hit on every
draw. A counting probe nails it in one line: **`compile=7980, make_pso=7980`, with `draw` also 7980**. Each
`MTLRenderPipelineState` carries a freshly created `MTLVertexDescriptor` handed to Metal, and the driver's
**pipeline cache holds it long-term** ⇒ it never falls back. The web backend is isomorphic and heavier (plus 512
more `glGetUniformLocation` calls).

**Fix (isomorphic on both backends)**: `s3d_compile` gains a **Program3D identity** parameter (`emit.ts` passes
`o->program`), and the glue maintains `S3DProgramCache progs[16]` (LRU) + `s3d_prog_stash`/`s3d_prog_load`, where
**a hit binds and never enters the driver's compiler** — semantically exactly AIR's `Program3D.upload()`
compiles once / `setProgram()` only binds. Two points to note:

1. **Slot identity = pointer + source hash** (FNV-1a 64-bit). The same `Program3D` can be **re-`upload`ed** with
   new bytecode, and comparing only the pointer would silently reuse a stale pipeline. The hash type must be
   `unsigned long long`: **wasm32's `unsigned long` is 32-bit**, an `ULL` constant overflows there (and `-Werror`
   makes the web build fail outright).
2. **The hit must be decided before the first driver compile** (Metal before `newLibraryWithSource:`, WebGL before
   `glCreateShader`) — only the right order counts as a fix; the wrong order recompiles every draw anyway.

**Re-check probe (kept)**: `AS_S3D_TRACE=1` reports a line of counters every 60 draws. The criterion is the
**ratio**: `make_pso` must track the **number of programs** (this demo = **2**), and **must never** track the
**number of draws** (1:1 before the fix). `ASC_S3D_DUMP=1` can still show the state per draw (this round it was
used to confirm the torus/skybox depth states alternate, see the leftover table's "rebuild `MTLDepthStencilState`
every draw" row).

**Regression nails**: `stage3d/program-cache` (17 items, `test/unit/stage3d.ts`).

---

### 9.12 2D mip Chain and "No-Chain Drop": Three adl Measurements Settled (stage one-hundred-twenty-eight)

First, the adl contract (probe `temp/mipprobe/`: AGALMiniAssembler + an 8×8 BGRA texture + a 256 px viewport,
with `T` = uv tiling count ⇒ `lod = log2(T/32)`; each case with an independent clear color, so a "drop" shows up
as the clear color in the read-back):

| Conclusion | Evidence (`temp/mipprobe/adl.txt`) |
|---|---|
| The drop trigger is **"no level > 0 was ever uploaded"**, **not** `createTexture(..., mipmapped=true)` | T1 `texN` (flag false, only L0 uploaded) `nomip` → **RED** (drawn); T2 same texture `miplinear` → all = clear color (**dropped**); T3 `texY` (flag **true**, only L0) `miplinear` → **dropped**; T4 same texture `nomip` → RED |
| Uploading one level follows the **region rule**: take **the source bitmap's top-left `lw×lh`** (`lw = max(1, width>>level)`), read **by the source's row pitch** | T5 `texC` (upload the whole 8×8 band once each at level 1/2/3) `miplinear T64`: instead of the expected out-of-range random colors, y0..y3 read `16/48/80/112`, exactly the source bitmap's rows 0..3 (row pitch 8, not 4) |
| Read-back at the correct scale for each level **equals exactly the uploaded value**, and lod selects only one layer | T6 `texD` (L1 rows 40/120/200/240, L2 70/210, L3 130) → `y0..y3 = 40/120/200/240`; T7 (lod −2) → RED (level 0) |

**Implementation** (one generated C + both glues):

- `Texture`/`RectangleTexture` gain a private `mips` counter (any `miplevel > 0` upload sets `1`; a level 0 upload
  clears it to `0` and rebuilds the texture); `Texture_uploadFromBitmapData`'s `miplevel != 0` branch computes the
  layer count from `max(width,height)`, rejects `miplevel >= nlv`, takes `lw/lh = max(1, w>>miplevel)` and **clamps
  to the source bitmap size**, going through the new seam
  `as_s3d_texture_upload_level(ctx, gpu, level, lw, lh, pixels, srcW)`.
- The binding side passes "has chain or not" down (2D passes `o->tex{i}->mips`, the cube passes `1`):
  `s3d_bind_texture(gpu, unit, tex, hasChain)`.
- The drop rule is the **same condition** on both ends: `c->samplerStateSet[i] && c->samplerMip[i] != 0 &&
  c->texHasMips[i] == 0 && texture non-null` ⇒ the whole draw is dropped. On the Metal side it takes an empty
  pass with `loadAction=Clear` to **consume the pending clear color** (the read-back is then the clear color); on
  the WebGL side it **must be placed before `glUseProgram`**.
- Cost: Metal's 2D textures are always `mipmapped:YES` (~33% VRAM, in exchange for "any level uploadable at any
  time"); WebGL pays that memory only when level > 0 is actually uploaded.

**Acceptance**: `temp/mipprobe/`'s 18 lines are **bit-for-bit identical** across `adl == native == web`, the only
difference being the trailing line `END-OF-SCENE (sync)` vs `(frames)` (a headless build has no frame loop and
ends synchronously when it finishes).

### 9.13 State-Object Cache and Per-Draw Rebuild (stage one-hundred-twenty-eight)

away3d's chrome ring and skybox **alternate** depth states per draw (`ASC_S3D_DUMP=1` measures
`depth=(less,w=0)` alternating with `depth=(lessEqual,w=1)`), while `s3d_rebuild_dss` originally **created +
released** an `MTLDepthStencilState` on every state change ⇒ `dss=8039 / draw=8040` (**not a leak, just
churn**: one driver-object allocation per draw). Changed to a **keyed cache**: `S3D_MAX_DSS` 16 slots +
`S3DDssVariant` (key = a snapshot of the state fields; `s3d_key_str` **copies the caller's string into the slot**;
`depthCompare` is part of the key), `s3d_select_dss` reuses on a hit and only creates and `asc_tr_dss++` on a miss
(**the counter counts only creations**, so `dss` reads directly as "the real number of objects"), evicting by LRU
once 16 slots are full; the lifetime is organized as "the slot holds +1, `c->dss` borrows". **Measured
(`Basic_SkyBox`, 1680 draws)**: `TRACE draw=1680 compile=1680 make_pso=2 pso_miss=0 dss=2 smp_miss=1 bindtex=1679
cube=1 uptex=0 mipbuild=0 mipdrop=0`, with the screenshot having 204748/204800 non-black pixels.

Also record one contract related to the browser/linker: `sk_mtl_shared_queue` (§9.8) was originally declared in
`stage3d_glue.mm` with `__attribute__((weak_import))`, but **modern macOS linkers still treat it as an undefined
symbol** ⇒ a headless Stage3D build (linking `stage3d_glue` without `metal_glue`) fails to link; stage
one-hundred-twenty-eight changed it to a lazy `dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue")` lookup (a cached
function pointer, falling back to its own queue if unavailable), so an ordinary manifest links. The nail is
`stage3d/gpu-queue-sharing`.

## 10. Reference Links

- AIR SDK reference (`flash.display3D` package): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/package-detail.html>
- AIR SDK reference (`Context3D`): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html>
- AIR SDK reference (`Program3D`): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Program3D.html>
- Ruffle (AGAL → wgpu/WebGPU Stage3D implementation): <https://github.com/ruffle-rs/ruffle>
- AGAL bytecode format reference (official Flash): <https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/AGAL.html>