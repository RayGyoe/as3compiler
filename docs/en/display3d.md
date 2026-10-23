# Stage3D (`flash.display3D`) Alignment and Landing

> This document began as a project-inception investigation — **can AIR SDK's `flash.display3D.*` (Stage3D) be
> aligned to this project, and if so how should it land**. The conclusion is **yes, and it is not an architectural
> overthrow but a bounded extension of the existing GPU infrastructure**; it is the heaviest single piece in this
> project so far (equivalent to rebuilding a small 3D graphics API runtime), and its core difficulty is the
> **AGAL bytecode → native shader language translation**. The gap is concentrated in the whole block "3D GPU
> resources + state machine + AGAL", not scattered point-filling.
>
> **Current state (2026-10-13, v0.4.112, stage one-hundred-forty-one)**: the whole block missing at project
> inception is **now fully closed**,
> and a whole extra **Windows / Direct3D 12** backend exists beyond the original plan — the AGAL translator (three
> targets **MSL / GLSL ES / HLSL**), `Matrix3D`/`Vector3D`, the `Stage3D`/`Context3D` state machine and resource
> classes, and three self-contained glues (`vendor/stage3d_glue.mm` Metal / `vendor/stage3d_webgl.cc` WebGL2 /
> `vendor/stage3d_d3d.cc` D3D12, one shared `s3d_*` ABI) have all landed. **This document splits by nature into
> two halves**: §1–§8 is the inception reasoning and layered design (each section ends with a "Landing status"
> note), **and §9 onward is the per-stage landing record, which is also the authoritative source for the current
> contract** (§9 textures/samplers/program cache/state objects, §10 the Windows D3D12 backend); the per-stage
> log is in `TODO.md`.
>
> Positioning: Stage3D is to this project the **isomorphic extension** of stages thirty-six through thirty-eight
> "link Skia rather than build our own rasterizer" — what it replaces is the "programmable GPU triangle pipeline"
> layer (raw `MTLBuffer`/D3D12 command lists/render pass/shader compilation), **not** the 2D display-list/event
> layer of `flash.display.*`. The display-list stacking relationship and event-flow semantics are unchanged;
> Stage3D merely adds a separate GPU render pass that converges with the 2D surface at the window compositing
> stage.

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
| Constant classes | 16: `BlendFactor`/`BufferUsage`/`ClearMask`/`CompareMode`/`CubeMapFace`/`FillMode`/`MipFilter`/`Profile`/`ProgramType`/`RenderMode`/`StencilAction`/`TextureFilter`/`TextureFormat`/`TriangleFace`/`VertexBufferFormat`/`WrapMode` (all named with a `Context3D` prefix in AS3) |
| Implicit dependencies | `flash.geom.Matrix3D`, `flash.geom.Vector3D`, `Vector.<Number\|uint\|float>`, `ByteArray` (little-endian reads) |

> Note that `AGALMiniAssembler` (`com.adobe.utils.*`) is **not a runtime** but a pure AS3 utility class — as long
> as the compiler can compile its source, it runs as user code (only string parsing + bit packing, producing a
> `ByteArray`). So no special runtime support is needed, but real Starling/Away3D projects all depend on it, so it
> must be used for end-to-end acceptance.
>
> **Landing status**: every class in the table above is implemented — `Matrix3D`/`Vector3D` (stage seventy-nine),
> `Stage3D`/`Context3D` plus the resource/texture/constant classes (stages eighty-one~eighty-three, eighty-seven,
> eighty-nine / twenty-one, one-hundred-twenty-eight), and `AGALMiniAssembler` compiled as **user code**
> (validated end-to-end in `shmup-stage3d` at stage eighty-four).

---

## 2. Current-State Inventory

At project inception (before stage seventy-nine) the conclusion here was "everything except the 2D render loop is
missing". As of v0.4.112 (stage one-hundred-forty-one), the gap is fully closed, and a whole extra
**Windows / Direct3D 12** backend exists beyond the original plan:

| Item | Current state |
|---|---|
| 2D render loop | ✅ Skia CPU raster + GPU (macOS `metal_glue.mm`, Windows `window_glue.cc`+`d3d_glue.cc`, web `web_glue.cc`) + SDL2 window |
| `ByteArray` (including grow/compress/uncompress) | ✅ implemented |
| `Point`/`Rectangle`/`Matrix` | ✅ implemented |
| `Vector.<T>` type system | ✅ modeled |
| `Matrix3D` / `Vector3D` | ✅ stage seventy-nine |
| `Stage3D` / `Context3D` / `display3D.*` | ✅ state machine + resource/texture classes + 16 constant classes (stages eighty-one~eighty-seven, eighty-nine / twenty-one, one-hundred-twenty-eight) |
| AGAL translator (**MSL / GLSL ES / HLSL** three targets) | ✅ stage eighty (MSL/GLSL), one-hundred-thirty-one (HLSL) |
| Native GPU triangle pipeline | ✅ three self-contained glues sharing one `s3d_*` ABI: `stage3d_glue.mm` (Metal) / `stage3d_webgl.cc` (WebGL2) / `stage3d_d3d.cc` (D3D12) |

Conclusion: the inception verdict "the gap is concentrated in the whole block '3D GPU resources + state machine +
AGAL'" **holds and the whole block is now closed**; the three glues are structurally isomorphic, with the semantic
trade-offs (§9.1–§9.13) ported one by one to all three backends.

> **The authoritative source for the current state is this document's "Landing status" notes in §3/§5 plus the
> landing records in §9 and §10** (§9 textures/samplers/program cache/state objects, §10 the Windows D3D12
> backend); the per-stage log and acceptance evidence are in `TODO.md`.

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

**The translation approach is mature and deterministic** (landed in stage eighty; widened from one target to
three in stage one-hundred-thirty-one):
- macOS native: AGAL → **MSL** (compiled by `newLibraryWithSource:` in `vendor/stage3d_glue.mm`), registers mapped
  to `float4`, `tex` mapped to `texture2d.sample()`.
- web: AGAL → **GLSL ES** (`vendor/stage3d_webgl.cc`, WebGL2).
- Windows native: AGAL → **HLSL** (shader model 4+, compiled by a real `D3DCompile` into `vs_5_1`/`ps_5_1` in
  `vendor/stage3d_d3d.cc`).
- The target is chosen at build time by `ASC_AGAL_TARGET` (**MSL=0 / GLSL=1 / HLSL=2**); the generated C is
  completely unchanged and it is the linked glue plus the build manifest that decide. The translator is exposed
  as the pure-static builtin bridge `AGALTranslator.translate(bytes:ByteArray, target:String):String`
  (`"msl"`/`"glsl"`/`"hlsl"`, not an AS3 runtime API).
- **Authoritative reference**: Ruffle already implements Stage3D (AGAL → wgpu/WebGPU), and there are several
  open-source AGAL → GLSL implementations in the community; the semantic rules (swizzle/mask/register
  constraints/validation-error list) are fully defined in `Program3D.upload`'s 40+ validation errors.

This part is a **self-contained deterministic translator in the pure C/C++ glue layer**, not touching the
front-end "translate AS3→C" main pipeline, consistent with AGENTS.md §2.9's "heavy work goes through linking/glue"
iron rule. The real grunt work is in the AGAL validator (40+ errors) and the extensions of AGAL1/2/3's three
generations (MRT, instancing, the `iid` register, `fragment output index`).

> **Cross-target coverage gaps (faithfully recorded)**: fragment **MRT** (`oc1..oc3` → multiple outputs) is
> still complete only in the **HLSL target** (`SV_TargetN`); MSL/GLSL fold the fragment into a **single output**
> (`oc` / `gl_FragColor`). That one is still filed in `TODO.md`'s `### 遗留待开发` table.
>
> **The depth output (`od`) and the AGAL3 `iid` register were closed in stage 261** (previously only the HLSL
> target was right): `od` is a **local `float4 od`** on all three targets (a write mask of `0xF` produces a
> whole-register store and `0x1` per-component stores, so a scalar cannot hold it) and the entry point copies
> `od.x` into that target's depth slot — MSL `struct FSOut { … float depth [[depth(any)]]; }`, GLSL
> `gl_FragDepthEXT = od.x;` (**not** `gl_FragDepth`, which is an ES 3.00 name that does not exist in an ES 1.00
> source — and WebGL additionally requires the context to `getExtension('EXT_frag_depth')` first, see
> `s3d_create` in `vendor/stage3d_webgl.cc`), HLSL `output.depth = od.x;`. `iid` comes from the host's system
> value on MSL/HLSL (`uint iid [[instance_id]]` / `SV_InstanceID`) and is broadcast to a `float4`; **GLSL ES
> 1.00 has no `gl_InstanceID`** (that is ES 3.00), so the GLSL target **refuses loudly**, and a fragment program
> reading `iid` is refused on all three targets — no more undeclared `r<num>`. Empty `VSIn`/`FSIn` structs are
> suppressed from real use, exactly like HLSL. **Do not confuse this with instancing itself**:
> `drawTrianglesInstanced` → `instanceCount` is **on-screen on all three backends**; what is missing is only the
> shader's **per-instance ID register** (which the GLSL target still cannot provide, hence the refusal).
> Acceptance: `xcrun metal` compiles 7/7 (the two old shapes both fail), real WebGL compiles too, evidence in
> `temp/metalshader/`.
>
> **`nrm` normalizes `.xyz` only, and "read before write" is an upload error — both settled in stage 263 against
> `adl 51.4.1`.** Both were previously a **silent guess**:
>
> ① `nrm`'s divisor is **|xyz|**, not |xyzw|. The pixel probe in `temp/agalprobe/` (`nrm ft1.xyz, ft0` with
> `ft0=(3,4,0,7)`) reads back rgb `0.6/0.8` on `adl` (i.e. divided by 5); dividing by |xyzw| = 8.6023 would give
> `0x587600` but the measurement is `0xFF99CC00` ⇒ **w neither joins the norm nor gets written**. The translator
> used to emit `normalize(<src>)` (four components); it now emits `vec4(normalize(<src>.xyz), 0.0)` and then picks
> by **destination** component (a swizzled source is gathered into `vec3(z,y,x)` first, so no double swizzle).
> A `nrm` whose destination mask includes w is **refused loudly** (`adl` reports **Error #3628**, "destination …
> must mask w (use .xyz or less)", measured).
>
> ② **Reading a temporary register that was never written is an `upload`-time error**, not "reads as zero".
> Measured **Error #3647** (whole register) / **#3648** (single component), and reproducing them with bytes
> assembled by Adobe's own `AGALMiniAssembler` shows this is not an artefact of our hand-rolled encoding.
> The translator now does a **per-component linear scan** exactly like `adl` (`agal_check_temp_writes`: the write
> set comes from the destination mask, the read set from the operand count implied by `agal_op_nreg` and
> `agal_op_nodest` plus the source swizzle, with `tex`/`tld`'s third slot being a sampler and not a read) and
> **refuses the upload** with the same error numbers — instead of emitting an uninitialised `float4 ft0;` (UB).
>
> ③ One misconception of **our own** corrected on the way: the opcode token carries the **bare opcode**
> (`0x00`–`0x2e`) with no `hasDst/hasSrc1/hasSrc2` flag bits (OR-ing `0x100/0x200/0x400` makes `adl` reject the
> program with **Error #3620**, "Invalid opcode, value out of range: 768"); the operand count is implied by
> `agal_op_nreg`. The encoders in `examples/stage80/82/83.as` were fixed.
>
> Acceptance: the **`adl` truth and the AOT output in `temp/agalprobe/` are byte-for-byte identical** (`out.txt`
> vs `out-aot.txt`, all five lines including `nrm-xyz-masked = 0xFF99CC00`); and each of the three targets really
> compiles — Metal 2/2 (`temp/metalshader/nrm*.msl` through `xcrun metal`), WebGL 2/2 (`glslcheck3.html` doing a
> real `compileShader`), HLSL pinned by text only (no `fxc` on this machine).

---

## 4. Layered Alignment Plan (inception design + landing status)

| Layer | Approach (inception design → landing status) |
|---|---|
| Front end (AST/lexer/parser) | zero changes. `Context3D` etc. are all ordinary builtin classes, going through `symbols.ts` modeling + `runtime.ts` helpers |
| Runtime state machine | `Context3D` is a pure state machine (blend/depth/stencil/cull/scissor/colorMask/fillMode + the currently bound buffer/program/texture/constants); a C struct suffices |
| GPU resources | it did **not** go into `metal_glue.mm` after all; instead three self-contained glues each expose the same `s3d_*` set: `vendor/stage3d_glue.mm` (`MTLBuffer`/`MTLTexture`/`MTLLibrary`/`MTLRenderPassDescriptor`/`MTLDepthStencilState`), `vendor/stage3d_webgl.cc` (WebGL2), `vendor/stage3d_d3d.cc` (D3D12) |
| On-screen compositing | Stage3D's offscreen target composites with the Skia 2D surface into the same window: on macOS Ganesh samples the same `MTLTexture`, on Windows Skia's D3D backend samples the same `ID3D12Resource`, and on web it goes through a CPU readback (stage eighty-nine / thirty); all three must **share one device/queue** with the 2D backend (§9.8, §10.4) |
| web | `vendor/stage3d_webgl.cc`: raw WebGL2, sharing the same WebGL2 context as Ganesh |
| Prerequisite classes | `Matrix3D` (perspective projection/append/recompose), `Vector3D` — pure logic, the same pattern as `Matrix` (landed in stage seventy-nine) |

(`AGALMiniAssembler` is covered by the note in §1: it is not a runtime but a pure AS3 utility class, compiled
along with user source and used for end-to-end acceptance.)

---

## 5. Build and Linking

Stage3D's landing reuses the "glue layer + build manifest" capability already present in stages thirty-six
through thirty-eight, doing only an **incremental extension** without introducing a new build paradigm:

| Concern | Note |
|---|---|
| Glue layer | the AGAL→MSL/GLSL/HLSL translator and GPU resource-management functions are **not** in `metal_glue.mm`/`web_glue.cc` but in three self-contained glues (`stage3d_glue.mm` / `stage3d_webgl.cc` / `stage3d_d3d.cc`), still exposing the **same** flat `s3d_*` C interface via `extern "C"` |
| Prerequisite classes | `Matrix3D`/`Vector3D` are pure AS3 logic classes, going through the existing `symbols.ts` builtin modeling, not touching the GPU (landed in stage seventy-nine) |
| Build manifest | macOS needs no new third-party library (Metal/Foundation are system frameworks, reusing the existing linking); web reuses Ganesh's WebGL2; Windows pushes `stage3d_d3d.cc` and links `d3d12`/`dxgi`/`d3dcompiler` |

> **Metal headers and frameworks**: `metal_glue.mm` already exists from stage seventy-five (the native Metal
> rendering backend), and the creation of `MTLDevice`/`MTLCommandQueue` and the Ganesh integration of
> `SkSurface::MakeFromBackendRenderTarget` have landed. What Stage3D reuses is the "**raw** Metal command buffer
> on the same `MTLDevice`", not going through Ganesh again — Ganesh is Skia's 2D abstraction, whereas Stage3D's
> triangle pipeline wants direct `MTLBuffer` + `MTLRenderPipelineDescriptor`; the two coexist on the same
> `MTLDevice`, submitted via the same `MTLCommandQueue`, and finally share one drawable for presentation.

> **Landing status (native macOS = stages eighty-two~eighty-three, web = stage eighty-nine / thirty, Windows =
> stages one-hundred-thirty-one~one-hundred-thirty-two)**: it was not put into `metal_glue.mm`/`web_glue.cc`, but
> into **three** separate self-contained glue files each exposing the **same flat `s3d_*` C signatures**:
>
> | Target | File | Shader | Build switch |
> |---|---|---|---|
> | native (macOS) | `vendor/stage3d_glue.mm` | raw Metal, AGAL→MSL | `ASC_RENDER_STAGE3D=1` (plus `ASC_RENDER_METAL` for the window layer) |
> | native (Windows) | `vendor/stage3d_d3d.cc` | Direct3D 12, AGAL→HLSL | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_HLSL=1`, links `d3d12`/`dxgi`/`d3dcompiler` |
> | web | `vendor/stage3d_webgl.cc` | WebGL2/GLES3, AGAL→GLSL ES | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_GLSL=1` (plus `ASC_RENDER_DEPTH_STENCIL=1` when `<depthAndStencil>` is present) |
>
> Therefore the `Context3D` state machine, the `as_s3d_*` wrappers, and the AGAL translator call sites in the
> generated C are **completely identical on all three ends**, and the shader language is chosen only by the
> build-time `ASC_AGAL_TARGET`. The web side's GL↔AS3 semantic differences (Y-axis flip, BGRA swap, per-register
> uniform, FBO/stencil, CPU-readback presentation and its cost) are in [`html5-web.md`](html5-web.md) §3.3; the
> Windows side's submission model/PSO cache/field-order rule/composite borrowing are in §10 of this document and
> [`win32.md`](win32.md) §3.4. Whether to mount a backend is auto-determined by `src/air-app.ts`'s
> `detectStage3D(files)` scanning the source (applicable to all three ends; the backend is then chosen by OS).

---

## 6. Phased Roadmap (inception proposal → all landed)

| Stage | Goal | Landing |
|---|---|---|
| **A prerequisite** | `Matrix3D` + `Vector3D` + completing `Vector.<Number/uint/float>` (pure logic, low risk) | ✅ stage seventy-nine |
| **B AGAL kernel** | AGAL bytecode parser (AGAL1/2/3) + validator + →MSL/GLSL translator (**the hardest step**, a stage of its own) | ✅ stage eighty (one target); stage one-hundred-thirty-one added the HLSL target |
| **C Context3D skeleton** | `Stage3D` + `Context3D` state machine + `VertexBuffer3D`/`IndexBuffer3D`/`Program3D`/`Texture`(BGRA/RGBA) + `drawTriangles`, `enableErrorChecking=false` taking the async path | ✅ stage eighty-one; stage eighty-seven added the Starling prerequisite methods |
| **D end-to-end** | Land the raw Metal pipeline, get a "colored triangle" demo running, then roll out blend/depth/stencil/cull/scissor/render-to-texture | ✅ stages eighty-two~eighty-three (plus stage one-hundred-four per-frame batching, one-hundred-fifteen frame-boundary commit-only) |
| **E alignment hardening** | `drawToBitmapData`, `setRenderToTexture`, CubeTexture/RectangleTexture, AGAL2/3 GPU-side end-to-end on-screen (MRT render pass / instancing) | ✅ stage eighty-three "instancing" on-screen; ✅ stage 261 closed `od`/`iid` on all three targets (the GLSL target refuses `iid`); ⚠️ **MRT is still HLSL-only** (see §3 and the `TODO.md` leftover table) |

**The kernel translator supports all three AGAL1/2/3 generations; `Context3D.profile` still reports a fixed
`"baseline"`** (`Context3D_get_profile` always returns `"baseline"`: AGAL1 capability + uncompressed 2D/cube
textures) — which exactly covers Stage3D's largest real consumer, **Starling** (a 2D-on-GPU framework).

### 6.1 Final Acceptance Demo: `examples/shmup-stage3d`

> This demo is the **final end-to-end acceptance target** of stages seventy-nine through eighty-three, and
> **stage eighty-four got it running** — this project compiled it from `.as` into a native executable and produced
> the correct picture. Three larger real projects serve as **generality cross-checks**:
> `examples/away3d-core/Basic_SkyBox.as` (§9), `examples/air-starling-demo` (127 source files + full Starling, all
> 12 web scenes correct), and `examples/Flappy-Starling`.

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
  done, it can be compiled and run, without waiting for stage eighty-three's MRT/instancing (which is exactly how
  it went: stage eighty-four got it running).
- It **does not depend on** AGAL2/3 features (no `ife`/`ddx`/MRT/`iid`), making it a precise probe of "is
  baseline closed"; stage eighty-three's AGAL2/3 capability (`drawTrianglesInstanced` instancing,
  `setProgramConstantsFromVector`) is covered separately by `examples/stage83.as`, and the cross-target
  differences in MRT/`od`/`iid` are in §3.
- `build-and-run.sh` compiles and runs with `mxmlc -swf-version=13` + `adl` (`renderMode=direct`), consistent with
  AGENTS.md §2.4's convention "use `mxmlc` as the reference compiler and cross-validate on the same `.as`" —
  when this project compiles it, that script's produced picture/behavior is the baseline comparison.

---

## 7. Risks and Landing Boundaries

| Item | Judgment |
|---|---|
| `VideoTexture` | ⚠️ **no decoder, but the class and object are complete**: `Context3D.createVideoTexture()` returns an empty `VideoTexture` (`videoWidth`/`videoHeight` constantly 0), `Context3D.supportsVideoTexture` is the constant `true`, and `attachCamera`/`attachNetStream` are **empty implementations** — the object exists so Starling's `ConcreteVideoTexture` can hold/attach a base; it draws nothing wrong, it just produces no video pixels |
| Compressed textures (ATF/DXT/PVRTC) | ⚠️ **partial** (stage eighty-nine / twenty-one): the ATF container's `format 3/5` (raw DXT1/DXT5) is implemented — at runtime `as_atf_decode_dxt` decodes to straight-alpha ARGB on the CPU and takes the ordinary texture-upload path (no premultiply, consistent with adl handing raw DXT5 to the GPU; mip 1+ is not decoded, only level 0 taken); ETC1/PVRTC, cubemap, and `format 0xc/0xd` (JPEG-XR lossy) still **error loudly** (`Error #3680`), not silently producing an empty image |
| Precise reporting of `driverInfo`/`totalGPUMemory`/`profile` | `driverInfo` reports four cases by **build-time backend macro**: `ASC_S3D_GLSL` → `"WebGL2 (Stage3D)"`, `ASC_S3D_HLSL` → `"Direct3D12 (Stage3D)"`, `ASC_RENDER_STAGE3D` → `"Metal (Stage3D)"`, otherwise `"Software (state machine)"`; the probe is `ASC_RENDER_STAGE3D` (**not** `ASC_RENDER_WINGPU`/`ASC_RENDER_METAL`, which denote only the window-compositing backend, see the comment on that function in `emit.ts`). `profile` is fixed to `"baseline"`; `totalGPUMemory` is implemented but is an **approximation** (stage eighty-nine / twenty-one: the back-buffer BGRA8 byte count plus the D32S8 byte count when depth-stencil is present) — it must exist because Starling's `StatsDisplay.supportsGpuMem` probes with `"totalGPUMemory" in context` and adds/removes a whole HUD row accordingly. The D3D12 string has no adl measurement yet (adl has no usable D3D backend), so it is an **honest placeholder**, filed in the leftover table |
| Synchronous throw on `enableErrorChecking=true` | **not implemented**: `Context3D.enableErrorChecking`'s setter is currently a no-op, so `true` does not produce AIR's synchronous validation throw (our draws batch-submit and retire once at the frame boundary, so there is no synchronous throw point anyway). Does not affect Starling/Away3D |
| AGAL2/AGAL3 GPU-side end-to-end on-screen (MRT/instancing) | **instancing is on-screen** (stage eighty-three: `drawTrianglesInstanced` → `instanceCount` on all three backends) and AGAL2 control flow/derivatives are translated on all three. Stage 261 closed **`od`** and **`iid`** on all three targets (MSL depth slot + `[[instance_id]]`, GLSL `gl_FragDepthEXT` + context-level `EXT_frag_depth`, GLSL target refuses `iid`). **What is not closed is only fragment MRT** (`oc1..oc3`), still HLSL-only (see the note at the end of §3; filed in `TODO.md`'s leftover table) |

---

## 8. Workload and Conclusion

- **Workload**: this is "small GPU runtime" scale, about the same magnitude as the entire existing "stages
  thirty-three through forty (events + display list + rendering + window)" block; the AGAL translator + validator
  is about 40%, the `Context3D` state machine and GPU resource management 40%, and the prerequisite classes plus
  end-to-end regression 20%. **Checked after the fact: the magnitude estimate was accurate** — it actually
  spanned stages seventy-nine~eighty-five, eighty-seven, one-hundred-four, one-hundred-twelve~one-hundred-seventeen,
  one-hundred-twenty-eight, and one-hundred-thirty-one~one-hundred-thirty-two.
- **Feasibility**: ✅ technically fully feasible, with no insurmountable obstacle; AGAL translation has mature
  references (Ruffle/open-source AGAL→GLSL), the raw Metal/WebGL2/D3D12 pipeline is a standard capability, and
  the project's existing GPU presentation foundation was indeed reused.
- **Decision and conclusion**: **we decided to invest, and delivered** — the only inception question was "is it
  worth the investment" (the project already has a complete 2D GPU rendering chain, and Stage3D's incremental
  value lies only in "running third-party engines built on Stage3D such as Starling/Away3D", not in drawing
  ordinary UI). The answer is **yes**: this project can now compile and run real Stage3D projects from `.as` on
  **macOS (Metal), Windows (D3D12), and the web (WebGL2)** (`shmup-stage3d`, away3d `Basic_SkyBox`,
  `air-starling-demo`, `Flappy-Starling`).

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

## 10. The Windows / Direct3D 12 Backend (landed, stage one-hundred-thirty-two)

The third backend, `vendor/stage3d_d3d.cc` (~2,290 lines), is **structurally isomorphic** to
`stage3d_glue.mm` (Metal): the same `s3d_*` ABI, the same frame-boundary batch submission model, the same
semantic trade-offs (§9.1–§9.13 ported one by one), with Metal objects swapped for D3D12 ones. It consumes
stage one-hundred-thirty-one's **AGAL → HLSL** translator (`ASC_S3D_HLSL` ⇒ `target 2`); the build-time wiring
is in [`win32.md`](win32.md) §3.4. Only the points that **differ from Metal or are D3D12-specific** are
recorded here.

### 10.1 Submission Model: Three Frame Slots + a Deferred-Release Queue

A Metal `MTLCommandBuffer` is inherently "submitting objectifies it"; on D3D12 everything has to be managed by
hand:

- **One command list per batch** (`s3d_batch_begin` → draw… → `s3d_batch_end`), then `Close()` and
  `ExecuteCommandLists(1, …)`. The **frame boundary** (`s3d_flush_async`) only submits the current batch and does
  not wait (the same line as §9.9).
- **Three frame slots** (`S3D_FRAMES_IN_FLIGHT = 3`): `c->slot` names the slot the **next** batch will use;
  `s3d_batch_begin` first calls `s3d_wait_slot(idx)` to wait for that slot's fence value, then `Reset`s that
  slot's command allocator; `s3d_batch_end` signals `fenceValues[idx] = ++fenceNext` and advances the slot
  number. Each slot has its own upload heap (UPLOAD heap), so with three frames in flight the CPU writing a
  constant buffer never trips "the buffer is still in use by the previous frame".
- **Constant buffer: regions versioned per draw** (stage one-hundred-seventy-three). **D3D12 reads constants
  when the GPU executes the command list** (at frame end), while the generated C re-uploads the whole register
  file before **every** `drawTriangles` ⇒ one constant buffer per frame slot makes every draw in that frame
  read the matrix uploaded **last**. Measured (`examples/air-starling-demo`): all 12 buttons were transformed
  by the last button's mvp, and only that last one stayed in place. Metal copies inline with `setVertexBytes`
  and is **immune by construction** ⇒ this only ever showed up on Windows. Now each upload gets its own 4096 B
  region (`S3D_CB_REGION` = 256 float4 = the largest cbuffer HLSL can declare, `S3D_CB_BYTES = S3D_CB_REGION * S3D_DRAWS_PER_FRAME`),
  and a draw binds **the region last uploaded for that stage**
  (`GetGPUVirtualAddress() + cbOffV/cbOffF`; 4096 alignment is exactly what makes a CBV legal). **The cursor is
  reset in `s3d_batch_end`, not in `batch_begin`**: a frame's **first** upload happens **before** the batch is
  opened (the generated C passes constants between the state setting and `drawTriangles`), so resetting at
  begin wipes the region it just wrote — measured as the **first two draws sharing region 0** (`cbV=0,0,4096,…`),
  with the background and the logo both vanishing from the picture. Likewise **`s3d_wait_slot` stays inside
  `s3d_upload_constants`** (the first upload has no `batch_begin` wait protecting it, and the rest are
  no-ops), otherwise the CPU may write UPLOAD memory the GPU is still reading. When the register file exceeds
  one region it is **rejected loudly** (`need > S3D_CB_REGION` returns 0 and prints, never truncating).
- **Deferred-release queue** (`S3DRelease rel[4096]`, each carrying a fence value; `s3d_defer_release` drains
  by `fence->GetCompletedValue()`) — D3D12 has no "command buffer drops its references on release", so every
  replaced resource must wait until the frame that last used it has really finished before `Release()`.
- **Descriptor heaps**: CBV_SRV_UAV is one big arena per frame slot (`S3D_DESCS_PER_FRAME = 512*8`), RTV (64),
  DSV (16). **The sampler heap is separate**: we first tried "one sampler arena per frame", but a D3D12
  sampler heap has a **2048-descriptor cap** (`12288` fails outright with `E_INVALIDARG`); so instead immutable
  blocks are cached per sampler-state vector (`S3D_MAX_SMPLCFG 256` × `S3D_MAX_TEX`), the same STATE set hits
  repeatedly, and the real occupancy is single-digit blocks.

### 10.2 PSO Cache: the Key Is the **Whole Draw State**

D3D12 has no Metal-style encoder that can change state on the fly: `ID3D12PipelineState` is **immutable**, and
every drawing state must be baked into it. So the cache key is a concatenation of every pipeline-affecting
field (`srcHash|writeMask|depthWrite|depthCompare|stencil*|dsNeeded|cullMode|blendOn|blendSource|blendDest|streamSig`),
at most `S3D_MAX_PSOVAR = 16` variants per program, `S3D_KEY_CAP 256` global, LRU eviction.
**The key has to be the *factor pair*, not just *is blending on***: blend factors are baked into the PSO, so
changing a pair means changing a PSO, and recording only `blendOn` lets the pair a program first used
(Starling's `normal`) be reused for every mode — symptoms and the settled fix are in §10.6. This is harder
than the Metal side (§9.13's DSS cache): `SetPipelineState` is a pure pointer binding, but **building a PSO is
expensive** (it compiles `vs_5_1`/`ps_5_1` bytecode).

### 10.3 A D3D12 Linkage Rule Only Measurement Could Teach: **Field Declaration Order Is the Register Number**

In HLSL's `VSOut`, `varyingN : TEXCOORDN` must be declared **before** `position : SV_Position`. fxc numbers a
stage struct's registers in **declaration order**, and D3D12's VS→PS matching looks at both the semantic
name+index **and** that register number; with `SV_Position` first, VS's `TEXCOORD0` lands at reg 1 while PS's
`TEXCOORD0` is at reg 0 ⇒ `CreateGraphicsPipelineState` reports "Signatures between stages are incompatible".
MSL/GLSL are insensitive to field order, so **only the HLSL target** needs this (nail:
`stage3d/agal-hlsl`'s "HLSL declares the varyings before SV_Position"). Two sibling D3D12 traps: ① the input
layout's `SemanticName` must be the **bare name** (`"TEXCOORD"`) with the index in `SemanticIndex` — writing
`"TEXCOORD0"` fails with `E_INVALIDARG`; ② `D3D12_RASTERIZER_DESC` has **no** `ScissorEnable` (unlike D3D11),
so a disabled scissor expands to the whole target rect at draw time and is clipped to the target bounds.

### 10.4 Compositing (Handing the 3D Frame to Skia to Draw into the Window)

- `s3d_get_render_target` returns a **raw `ID3D12Resource*`** (not an `S3DTexture*`), because its only consumer
  is `vendor/d3d_glue.cc`'s `sk_gpu_draw_texture`. The composite **borrows** that resource: ownership stays with
  the Stage3D context, and the composite only takes one extra temporary reference for the duration of its own
  call.
- **This "borrow" is the deepest trap in the D3D backend**: Skia's D3D backend has **no** Borrow/Adopt
  notion, `GrD3DTextureResourceInfo::fResource` is a `gr_cp<ID3D12Resource>`, and its **bare-pointer constructor
  "adopts" (does not AddRef) while the destructor Release()s**. Handing in your own only reference = giving
  away ownership (details, symptom, and the correct form are in [`win32.md`](win32.md) §2.9). Both the composite
  and the swapchain back buffer wrap sites now use `fResource.retain(...)`.
- The backend uses the **same** `ID3D12Device`/command queue (§3.4 of [`win32.md`](win32.md)), so
  `sk_gpu_draw_texture` needs no CPU-side wait; but the **ordering** is still "Stage3D's batch is already
  submitted, so its submission order precedes the composite".
- The target must be `R8G8B8A8`/`BGRA8` and non-multisampled, otherwise it is **loudly refused** and not drawn
  (`unsupported render target ...`, printed once).

### 10.5 Acceptance (done) and **Not Accepted** (no silence)

**Done (2026-10-10, local machine x86 `--air-app`)**:

- `examples/shmup-stage3d` (1000x600, `renderMode=direct`, `depthAndStencil=true`,
  `requestedDisplayResolution=high`) **opens a window and runs 281 frames / 5 s (~56 fps)**; every frame's
  `get_render_target` returned `desc(dim=3 fmt=87 1000x600)`, every `draw_texture` was accepted, **zero**
  `unsupported render target`, and the fence advanced monotonically.
- **Objective pixel evidence**: the **presented back buffer** exported with
  `ASC_GPU_DUMP=<path> ASC_GPU_DUMP_AT=40` (a 1500x900 BMP, 4,050,054 B) shows the demo's **Stage3D sprites**
  (the spritesheet's tiles in the upper right, HiDPI-scaled). — **Whether Stage3D reaches the screen can only be
  judged by this dump, not by screen capture**: a flip-model swapchain's contents cannot be captured through
  GDI/BitBlt (you get a stale/all-black frame).
- The development scaffolding (the `s3d_watch` family of lifetime probes) **has been removed from the product
  code**; `get_render_target`'s diagnostic line is kept but made **periodic** (`n++ % 120 == 0`), and it was
  exactly that which printed out the dangling-pointer root cause above.

**Also completed (stage one-hundred-seventy-three, 2026-10-16, local machine x86 `--air-app`)**:

- `examples/air-starling-demo` (127 source files + a complete Starling) **now runs on real hardware**: the
  window opens, resources finish loading, and **26 draws / 246 triangles** (12×9 nine-slice + 12 labels +
  background/logo/`infoText`, no geometry missing) all land. The **structural** defect fixed along the way is
  §10.1's "constant region versioned per draw" above (one constant buffer per frame slot ⇒ every draw in a
  frame read the last mvp uploaded).
- **Item-by-item comparison against `adl 51.4.1`** (same machine, same 150% scaling; the `adl` side captured
  the window's client area with `temp/win_shot.ps1`, our side used `ASC_GPU_DUMP`'s presented back buffer):
  the logo's red-pixel bounding box is **identically `x32..173 y10..196` in client coordinates**, the button
  pitch is identically **69 px** (= 46 pt × 1.5), and the two button columns' row/column offsets match the 12
  labels one by one.

**Not accepted (do not claim a wider scope)**:

- **Back-face culling / winding order**: `FrontCounterClockwise = FALSE` + a positive-height viewport (no Y
  flip) is a **paper inference** (consistent with §"D3D also has row 0 at the top"), with no culling A/B
  measurement. Likewise the DXGI **debug layer** was off this round (the PSO `E_INVALIDARG` was poked out with
  `temp/psoprobe.cc`'s InfoQueue; the product path does not enable it).
- **Mip-drop / cube maps**: these semantics were ported per §9 one by one and have text-level nails, but they
  **were not separately re-measured on D3D12** (`air-starling-demo` covers `setProgram` switching,
  depth/stencil, multi-stream `drawTriangles` and the texture atlas, but not cube maps). **Blend factors are
  now covered**: stage one-hundred-seventy-five compared all six factor pairs against `adl` with the Blend
  Modes scene (§10.6).
- `Context3D.drawTriangles`'s `firstIndex` **is ignored** (`(void)firstIndex;`, the index buffer is uploaded
  whole). Harmless for Starling (it always calls `drawTriangles(ib, 0, n)`), a potential divergence for other
  Stage3D apps — filed in the legacy table.

### 10.6 Blend modes (`Context3D.setBlendFactors`) alignment: three things have to be right at once (stage one-hundred-seventy-five)

In `examples/air-starling-demo`'s **Blend Modes** scene (`DisplayObject.blendMode` → `BlendMode.activate()` →
`context.setBlendFactors(sf, df)`) "switching has no effect" is **not** one defect but three stacked on top of
each other, each of a different kind. Every number below is that one scene compared pixel by pixel against
`adl 51.4.1` (same machine, same 150% scaling; the `adl` side captured the window's client area, our side the
client area too):

| Mode (Starling) | Factor pair (sf, df) | Before the fix vs adl | After the fix vs adl |
|---|---|---|---|
| normal | one / oneMinusSourceAlpha | 3.69% | 3.70% (control: correct to begin with) |
| multiply | destinationColor / oneMinusSourceAlpha | 13.68% | 3.54% |
| screen | one / oneMinusSourceColor | 10.59% | 2.00% |
| add | one / one | 10.22% | 1.71% |
| erase | zero / oneMinusSourceAlpha | 13.80% | 1.91% |
| none | one / zero | 12.93% | 3.75% |

(Percentages = share of differing pixels; the baseline is the **3.7% of the same scene's unaffected normal
mode**, which is the inherent font/anti-aliasing difference, not a blending defect. `erase`'s visible symptom is
the most direct: before the fix it was a **white** rocket silhouette where `adl` is **black**; `none`'s 12.93%
before the fix comes next.)

(Contract: our window's client area 480×870 and adl's 459×814 are aligned at **@0,0** and compared point by
point (every 2 px, counting a difference when `|ΔR|+|ΔG|+|ΔB| > 24`); the recomputation script is
`temp/pngdiff2.cjs`, and the alignment offset was found by search (the result being 0,0). Run-to-run
determinism is 0.02% ⇒ any difference ≥2% is a real one.)

1. **The PSO key has to contain the factor pair** (§10.2). The key originally held only a boolean "is blending
   on", so the factor pair a program first blended with (Starling's `normal`) was **reused** for every mode —
   measured, five presses of "Switch Mode" moved only 0.3% of the pixels, and all of those were the label.
   The Metal side's `stage3d_glue.mm` had been keying by factor pair all along (its file-header comment says
   exactly this).
2. **The alpha slot's factors have to be translated `*_COLOR → *_ALPHA`**. Stage3D has only **one pair** of
   factors (colour and alpha share it), and handing that same pair to two colour-attachment slots is legal in
   Metal but **not** in D3D12: a `*_COLOR` value in the alpha slot is an illegal enum, and
   `CreateGraphicsPipelineState` rejects the **whole** PSO as `E_INVALIDARG (0x80070057)`, the debug layer's
   exact words being
   `SrcBlendAlpha[0] is trying to use a D3D11_BLEND value (0x9) that manipulates color, which is invalid`
   (reproduced independently with `temp/blendprobe.cc` + the debug layer). No PSO ⇒ **every draw of that mode
   is silently dropped**, which is the direct cause of multiply/screen "having no effect at all". Translating
   to the alpha twin factor (`s3d_blend_factor_alpha`) is not just error avoidance: ERASE
   (`zero / oneMinusSourceAlpha`) only erases when the erased pixel's **alpha really reaches 0** (that is what
   Starling erases RenderTextures with).
3. **Compositing has to ignore the back buffer's alpha** (§10.4). When AIR presents the Stage3D back buffer it
   **does not look at alpha**: clearing the context to `(1, 0, 0, 0.25)` versus `(1, 0, 0, 1.0)` (with the
   stage colour set to opaque green) gives the **same `(255,0,0)`** for the same pixel in the adl window —
   green never shows through a semi-transparent back buffer. So all four compositing paths —
   `sk_gpu_draw_texture` (D3D12) / `sk_mtl_draw_texture` (Metal) / `sk_gl_draw_texture` (web GL) /
   `sk_canvas_draw_bgra` (CPU raster) — now use **`SkBlendMode::kSrc`** instead of the default `kSrcOver`:
   ERASE zeroes RGB **and** alpha, and `kSrcOver` would let the stage colour show through (a white silhouette),
   while `kSrc` yields adl's black. **This one only differs from the old behaviour when the back buffer has a
   pixel whose alpha is not 1**, so the other 12 scenes are essentially unchanged pixel-wise (measured:
   `BlendModes` / `RenderTexture` differ from before the fix by 0.06%).

**Nails**: the `stage3d/d3d-glue` group in `test/unit/stage3d.ts` (the key contains the factor pair, the alpha
slot's translation function and its two call sites, and all four compositing paths using `kSrc`).

## 11. Reference Links

- AIR SDK reference (`flash.display3D` package): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/package-detail.html>
- AIR SDK reference (`Context3D`): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html>
- AIR SDK reference (`Program3D`): <https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Program3D.html>
- Ruffle (AGAL → wgpu/WebGPU Stage3D implementation): <https://github.com/ruffle-rs/ruffle>
- AGAL bytecode format reference (official Flash): <https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/AGAL.html>