# E6 native shader passthrough · implementation plan (WBS)

> English mirror of [`docs/zh-cn/native-shader-plan.md`](../zh-cn/native-shader-plan.md); the Chinese file is
> canonical. This file is the **work breakdown** for [`native-shader.md`](native-shader.md) (the design doc):
> the design answers "why and what", this one answers "**who, in what order, which hunk of which file, and how it
> is accepted**".
> Basis: **E6** in [`enhancements.md`](enhancements.md) §3 (an enhancement, opt-in, AOT-only).
>
> Status: **started, four milestones landed**. The technical baseline in §3 was measured on device, not inferred.

---

## 0. Division of labour with the design doc

| Document | Answers |
|---|---|
| [`native-shader.md`](native-shader.md) | why the source language is GLSL ES 3.00, why this counts as an "enhancement", which **categories** change on the compiler side and the AS side, where the red lines are |
| **this file** | milestone split, **file-level** change list, **interface contracts** (entry names / binding conventions / GLSL subset), an **executable acceptance command** per step, the traps hit, and the decisions taken |

The design doc's §9 staging (P1 Metal / P2 Web / P3 D3D12 / P4 Ultra-Water) is expanded here into **M0–M7**, plus
the first thing the design doc did not say: **make the cross-compile chain a C component that can be verified on
its own**.

---

## 1. Baseline (verified 2026-11-02)

Each row was checked against the code before starting, so nothing already present gets rebuilt.

| Fact | Where | Consequences |
|---|---|---|
| **Layer 1 texture formats are already fixed** (six constants + `rgbaHalfFloat` + the `#2008`/`#3745`/`#3759` ordering) | `src/symbols.ts:7556-7567`, commit `4240be1` | the four deviations in design §6.1 layer 1 **no longer exist**; this milestone does not redo them, only guards "no regression" in the DoD |
| **`RGBA_HALF_FLOAT` render targets already work** | `vendor/stage3d_glue.mm:2100` (`MTLPixelFormatRGBA16Float`) + `s3d_compile`'s `isHalf` variant (`:1391`) | half-float RT is ready; E6 adds **full-precision 32F and single/dual channel** |
| **AGAL three-target translator** | `src/runtime.ts:15258` `as_agal_translate` (MSL/GLSL/HLSL) | the emission pipeline "source string → backend text → `s3d_compile`" **already exists**; E6 only changes the source language |
| **AGAL4 vertex texture fetch landed** | commit `5d92d93` (`tld`) | proves `[[texture(N)]]` works in the vertex stage; the native path's vertex texture fetch has no new hardware obstacle |
| **`s3d_compile(ctx, key, vs, fs, errbuf, cap)` takes text directly** | `vendor/stage3d_glue.mm:1540` | "native MSL compile" on Metal needs **zero new code**: feed SPIRV-Cross output to the same entry |
| **`IRenderer` seam** | `asaot3d/seam/asaot/three/IRenderer.as` (16 lines, `render`+`setSize`) | engine-side landing spot already fixed |
| **`--features` registry + upfront rejection** | `src/build.ts:999` `FEATURES`, `validateFeatures` | adding a switch copies the mature `tray`/`svg` shape |
| **Precedent for "class exists but behaviour is switch-gated"** | `SystemTrayIcon`: `src/emit.ts:11381` uses `#if ASC_HAS_TRAY` | **default identical to AIR verbatim, enhanced only when switched on** — E6's classes follow this shape rather than inventing one |
| **glslang / SPIRV-Cross are absent on this machine** | `build-tools/` has only skia/emsdk/curl | the first task of this milestone |

---

## 2. Scope and milestones

### 2.1 In scope

- Submit **native GLSL ES 3.00** vertex/fragment source and cross-compile to Metal (MSL), WebGL2 (passthrough),
  D3D12 (HLSL, M5).
- Float render targets (`RGBA_FLOAT`/`R32F`/`RG16F`/`R16F`/`RGBA_HALF_FLOAT`), **both directions** (attach and
  read).
- MRT (`layout(location=N) out`), Metal and WebGL2 first.
- Depth textures (sampleable + usable as an attachment) for design §6.4's depth-validated refraction.
- Ultra-Water's FFT ocean as the final acceptance load (GPU FFT).

### 2.2 Out of scope

- No generic Vulkan backend (`Context3D` has only Metal/D3D12/WebGL2 paths).
- No in-house cross-compiler (use the official Khronos chain, §3).
- Float formats do **not** go into `Context3DTextureFormat` (design §6.1 option B: a separate new class, keeping
  the default product isomorphic to AIR).
- No change to any default behaviour of the `AGAL` path.

### 2.3 Milestones

| Milestone | Content | Acceptance (executable) |
|---|---|---|
| **M0 kick-off** | this document + `enhancements.md` E6 status + the `TODO.md` stage entry | docs committed, `node test.ts` unchanged |
| **M1 cross-compile chain** | `build-tools/shader/` builds glslang + SPIRV-Cross; the C interface in `vendor/shader_compiler.cc`; a standalone C test program | `./temp/shc-test` prints correct MSL (with a reflection table) |
| **M2 compiler side** ✅ | `--features native-shader` registered; `Context3DNative` built-in class + format constants + `uploadProgram`/binding/draw; `ASC_HAS_NATIVE_SHADER` gating | `examples/native-shader-probe.as` green: MRT=2, 5 reflection entries, both ES1.00/legacy rejections carry line numbers |
| **M3 Metal backend** ✅ | float RT format surface, native program binding (uniform/texture/attribute), MRT, depth textures | **all green on device** (2026-11-02, `asaot3d/apps/shader-m31` 13 items PASS): 32F/16F targets render and half precision **really does lose bits**, the two MRT attachments read back **separately**, depth texture works as an attachment; `apps/shader-m30` still pins the path (centre `#804020` / 3-8 position `#361b0e`, bit-exact against `uColor.rgb * vUV.x`) |
| **M4 the free web point** ✅ | `stage3d_webgl.cc` passthrough + `EXT_color_buffer_float` (wasm consumes the ES 3.00 source verbatim and does **not** link SPIRV-Cross; reflection comes from the driver, see `native-shader.md` §6.11) | ✅ 2026-11-03 (stage 358): the same `.as` under `--target wasm` shows the same image with zero cross-compilation; all five demos (m30/m31/m33/ocean-m32/ocean-m34) green in a real browser |
| **M5 D3D12** | `stage3d_d3d.cc` float `DXGI_FORMAT` + native HLSL | on screen on Windows (CI / real machine) |
| **M6 engine side** ✅ | `ShaderMaterial` + `NativeShaderRenderer` + `RendererFactory` + the `extra-roots` manifest field | `apps/shader-m30` **15/15 PASS**; `adl`/default build prints `NO-CHANNEL` and refuses to draw (§8 red line); engine-side decisions in `asaot3d/three-api-design.md` §37 |
| **M7 Ultra-Water alignment** ✅ | FFT ocean → caustics → atmosphere → underwater | ✅ **landed (engine side)**: `apps/ocean-m34` does 86 passes/frame with 7 self-checks all PASS (`asaot3d/three-api-design.md` §39); residuals against the three.js reference (direct specular too bright, fog lift too weak) live in that document's §29.8 / §30.7 and are engine-side accounts |

---

## 3. Verified technical baseline (measured on device)

This section is the most important part of the plan: **every conclusion has a command and an output**, nothing is
copied from a document.

### 3.1 Both libraries build

```
build-tools/shader/
  glslang-src      @ e7917c4 (main)
  glslang-build    -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_OPT=OFF -DBUILD_SHARED_LIBS=OFF
  spirv-cross-src  @ 65d7393
  spirv-build      -G Ninja -DCMAKE_BUILD_TYPE=Release -DSPIRV_CROSS_CLI=ON -DSPIRV_CROSS_STATIC=ON
```

Artefacts (static archives, whole-archive linkable):

| Library | Archives |
|---|---|
| glslang | `libglslang.a` `libSPIRV.a` `libMachineIndependent.a` `libGenericCodeGen.a` `libOSDependent.a` `libglslang-default-resource-limits.a` |
| SPIRV-Cross | `libspirv-cross-core.a` `-cpp.a` `-glsl.a` `-msl.a` `-hlsl.a` `-reflect.a` `-util.a` `-c.a` |

- `-DENABLE_OPT=OFF` disables SPIRV-Tools (we do not optimise SPIR-V, saving a whole submodule).
- Both are **Apache-2.0**, **linked** as C static libraries per `AGENTS.md` §2.9; that does not violate §3.1
  (which only forbids npm dependencies).

### 3.2 The real GLSL ES 3.00 → MSL command sequence (three traps)

```
glslang -S vert -G --target-env opengl --auto-map-locations  a.vert -o a.vert.spv
spirv-cross --msl --msl-version 20100 a.vert.spv
```

**Trap 1: `#version 300 es` cannot go straight to SPIR-V.**
glslang refuses outright: `ERROR: #version: ES shaders for SPIR-V require version 310 or higher`.
⇒ before emitting SPIR-V, `#version 300 es` **must be upgraded to 310 es**. ES 3.10 is a superset of 3.00, so the
author's 3.00 source keeps its semantics; the upgrade is **internal**, authors still write 3.00 (the Web
passthrough end stays at 300).

**Trap 2: the Vulkan environment rejects bare uniforms.**
`-V --target-env vulkan1.0` reports `'non-opaque uniforms outside a block' : not allowed when using GLSL for Vulkan`.
⇒ **`-G --target-env opengl`** is required (the OpenGL flavour of SPIR-V), which allows three.js-style
`uniform float uT;`. The price is no Vulkan-only features (push constants / descriptor sets) — which we do not need.

**Trap 3: `--auto-map-locations` is required.**
SPIR-V requires locations on in/out; a varying without `layout(location=)` reports
`'location' : SPIR-V requires location for user input/output`. With the flag, glslang assigns them automatically
and they line up with SPIRV-Cross's `[[user(locnN)]]`.

### 3.3 Shape of the output (it determines our binding API)

The author writes (`tri.frag`):

```glsl
#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 o0;   // two MRT attachments
layout(location = 1) out vec4 o1;
uniform float uT;
uniform sampler2D uTex;
void main() { o0 = vec4(texture(uTex, vUV).rgb * uT, 1.0); o1 = vec4(vUV, 0.0, 1.0); }
```

SPIRV-Cross emits this MSL:

```metal
struct main0_out { float4 o0 [[color(0)]]; float4 o1 [[color(1)]]; };   // MRT falls out naturally
struct main0_in  { float2 vUV [[user(locn0)]]; };
fragment main0_out main0(main0_in in [[stage_in]],
                         constant float& uT [[buffer(0)]],              // one buffer slot per uniform
                         texture2d<float> uTex [[texture(0)]],
                         sampler uTexSmplr [[sampler(0)]])
{ out.o0 = float4(uTex.sample(uTexSmplr, in.vUV).xyz * uT, 1.0); ... }
```

The vertex side is the same: `float2 aPos [[attribute(0)]]` (AGAL's `va0`), `constant float4x4& uMVP [[buffer(0)]]`.

**Three contracts follow** (written into §4):

1. **Uniforms bind by name**: SPIRV-Cross gives each uniform its own `[[buffer(N)]]`, and the reflection table gives
   `name → N`. Our API is therefore **by name** (`setUniform1f(prog, "uT", v)`), not by register number — the
   `ShaderMaterial` style, also three.js's. No alignment offsets are computed.
2. **Attribute location == vertex stream number**: `layout(location=N) in` ↔ `s3d_upload_vertex(ctx, stream=N, ...)`,
   matching the existing `va0..va7` one to one, **zero change to the vertex layout**.
3. **Texture and sampler are paired** (`[[texture(N)]]`/`[[sampler(N)]]` share N), reusing the pairing already
   wired during the AGAL4 VTF round (`setFragmentTexture`/`setFragmentSamplerState`).

**The entry name must be renamed**: SPIRV-Cross emits `main0`, while `s3d_compile` looks for `vs_main`/`fs_main`.
Two options:

- (a) SPIRV-Cross's `rename_entry_point("main", "vs_main")` API;
- (b) textual post-processing `main0` → `vs_main`.

Chosen **(a)**: text replacement would hit `main0` inside comments and identifiers; the API rename is Pareto-optimal.

### 3.4 The offline Metal compiler is unavailable on this machine (**it affects acceptance**)

```
$ xcrun -sdk macosx metal -c tri.vert.msl -o tri.vert.air
error: cannot execute tool 'metal' due to missing Metal Toolchain; use: xcodebuild -downloadComponent MetalToolchain
```

⇒ `xcrun metal` **cannot** be used for acceptance. Runtime compilation is used instead: `newLibraryWithSource:`
goes through the system Metal framework (not the offline toolchain), which is what `s3d_compile` already does. So
M3's acceptance is "the program runs and `newLibraryWithSource:` accepts the MSL", not "`xcrun metal` exits 0". The
`xcrun metal` acceptance wording in design §9 is superseded by this section.

---

## 4. Interface contracts (nail these down first, or the ends drift)

### 4.1 GLSL subset (what authors may write)

**Accepted**: `#version 300 es` (upgraded internally to 310 for SPIR-V; verbatim for web)

| Category | Content |
|---|---|
| Types | `float/vec2..4/mat2..4/int/uint/bool/ivec*/uvec*/bvec*`, `sampler2D`, `samplerCube`, `sampler2DShadow` |
| Storage qualifiers | `const`, `in`/`out` (`layout(location=N)` optional, auto-assignment as fallback), `uniform`, `flat`, `centroid` |
| Built-ins | the full GLSL ES 3.00 set (`texture`/`textureLod`/`texelFetch`/`textureSize`/`dFdx`/`dFdy`/`inverse`/`transpose`…) |
| Precision | a `precision mediump/highp float` declaration is **required** (the ES spec wants a default fragment precision, otherwise glslang errors) |

**Rejected** (this list *is* the "this backend does not support X" failure surface; errors must be specific):

- `#version` other than `300 es` (including `310 es`/`330 core`/absent) ⇒ "only GLSL ES 3.00 is accepted". The
  internal upgrade is **one-way**; authors must not write 310 themselves.
- `attribute`/`varying`/`texture2D` (ES 1.00 spelling) ⇒ "ES 1.00 syntax; use in/out/texture".
- `geometry`/`tessellation`/`compute` shaders (no such stage in Stage3D) ⇒ "no such stage".
- `#include` (not a GLSL directive; three.js chunk assembly happens on the AS3 side).

### 4.2 Binding contract

| Concept | Author side (AS3) | Metal | WebGL2 | D3D12 |
|---|---|---|---|---|
| Vertex attributes | `layout(location=N) in` | `[[attribute(N)]]` ↔ vertex stream N | `layout(location=N)` native | `layout(location=N)` (HLSL needs `TEXCOORD N`; see M5) |
| Uniform scalar/vector/matrix | `setUniform(prog, "name", value)` | `[[buffer(N)]]`, reflected by name | `gl.getUniformLocation` by name | `bN`, reflected by name |
| Textures | `bindTexture(prog, "name", tex)` | `[[texture(N)]]` + `[[sampler(N)]]` | `glUniform1i` to a unit | `tN`/`sN` |
| Render targets | `setRenderTarget(color, depth)` | multiple colour attachments | `drawBuffers` | `OMSetRenderTargets` |

**Where N comes from**: M1's C interface performs reflection and returns an array of
`{ name, kind, binding }` triples. The runtime builds a `name → binding` table and `setUniform` looks it up.

### 4.3 Error surface

| Situation | Behaviour |
|---|---|
| GLSL syntax/type error | `uploadProgram` returns `ok=false` with glslang's **verbatim** text (with `line:col`); it is not swallowed. Using the program afterwards (`useProgram`/`setUniform*`/`drawTriangles`) throws with that text |
| Link error (varying mismatch) | same, with glslang's link log |
| MSL/HLSL compile error | the backend's verbatim text (`newLibraryWithSource:`'s `localizedDescription`) |
| `setUniform` with a name absent from the reflection table | **warn once and skip** (as-built). Rationale: glslang strips unused uniforms, so throwing would break the common habit of keeping a `uTime` around for later. An author **mis**typing a live uniform is caught by the pixel assertion instead |
| Texture format not renderable on the front end | throws, naming the missing extension |

> The last two rows are **as-built**, not the original plan (the plan said "throw `ArgumentError`"). The change is
> deliberate and is recorded here so the next reader does not "fix" it back.

---

## 5. WBS (file level)

### 5.1 M1 · cross-compile chain

| File | Action |
|---|---|
| `build-tools/shader/{glslang-src,spirv-cross-src}` | sources (reproducible from scratch via `tools/fetch-shader-libs.sh`, below) |
| `build-tools/shader/build.sh` (new) | one command builds both libraries and installs archives + headers into `as3compiler/vendor/shader/` |
| `as3compiler/vendor/shader/include/` | `spirv_cross/`, `glslang/` headers (needed at link time) |
| `as3compiler/vendor/shader/lib/<host>/*.a` | static archives (14 of them) |
| **`as3compiler/vendor/shader_compiler.cc` (new)** | C++ shim, the only translation unit exposing a pure C interface: glslang compile → SPIRV-Cross cross-compile → reflection |
| `as3compiler/vendor/shader_compiler.h` (new) | pure C header: handle structs + 5 functions |
| `temp/shc-test/main.c` (new, for acceptance) | standalone C program feeding §3.3's dual-RT fragment shader, printing MSL + the reflection table |

C interface (draft; finalised in M2):

```c
typedef struct { const char* name; int kind; int binding; int size; } AscShaderUniform;
typedef struct {
  char* vertex_msl; char* fragment_msl;         // caller frees
  AscShaderUniform* uniforms; int uniform_count;
  AscShaderUniform* textures; int texture_count;
  AscShaderUniform* attributes; int attribute_count;
  char error[1024];                              // non-empty = failure
} AscShaderProgram;

// target: 0=MSL  1=GLSL_ES3(passthrough, validate only)  2=HLSL
int asc_shader_translate(const char* vs, const char* fs, int target, AscShaderProgram* out);
void asc_shader_program_free(AscShaderProgram* p);
```

### 5.2 M2 · compiler side

| File | Action |
|---|---|
| `src/build.ts` | `FEATURES['native-shader'] = { macro:'ASC_USE_NATIVE_SHADER=1', targets:['native'], why:'' }`; for the native target inject `vendor/shader_compiler.cc` plus glslang/SPIRV-Cross `-L/-l` (**never for wasm**: passthrough needs zero dependencies) |
| `src/index.ts` | pass `cfg.features` into `generateC` (**new parameter**: codegen could not see features before) |
| `src/codegen.ts` | `generateC(..., features)` |
| `src/symbols.ts` | with `native-shader`, register `flash.display3D.Context3DNative` (format constants + method signatures) + `flash.display3D.NativeProgram3D`, both with `reflectFqn` |
| `src/runtime.ts` | the `ASC_HAS_NATIVE_SHADER` derived macro; the `asc_shader_translate` extern declaration and the `as_shader_translate` wrapper; the native family of `as_s3d_*` |
| `src/emit.ts` | `Context3DNative`'s method bodies (`uploadProgram`/`setUniform*`/`bindTexture`/`setRenderTarget`/`draw`/`getInfoLog`); with the switch off the class is **not registered at all** ⇒ `getDefinitionByName` throws `#1065`, same shape as AIR |

> **As-built (2026-11-02, stage three-hundred-fifty-three)**: all six rows are done, with two plan changes forced by
> measurement:
> 1. `FEATURES['native-shader'].targets` narrowed to `['native']`. The plan had `wasm`, but that path is "feed the
>    author's GLSL to WebGL2 verbatim" — it does **not** need `asc_shader_translate`, it needs M4's
>    `stage3d_webgl.cc` passthrough; turning `wasm` on before that only makes the web build link a shim that does
>    not exist. The reason is written into `why` and `validateFeatures` reports it.
> 2. `uploadProgram` does **not** throw on compile failure: it returns `ok=false` with `infoLog` carrying glslang's
>    text, and only *using* the program (`useProgram`/`setUniform*`/`bindTexture`/`drawTriangles`) throws. The
>    author must be able to print `getInfoLog()` first; this is three.js's shape and the only one that makes the
>    error legible.
>
> **Note: the feature↔codegen coupling is new.** Today `--features` only affects the C compile command (`svg`/`tray`
> do not change the symbol table), whereas E6 makes "does this class exist" switch-dependent. Two options: (a) pass
> features into codegen (chosen, because design §6.1 option B requires "default product isomorphic to AIR" — the
> class must not exist); (b) the class always exists and every behaviour throws (the `tray` shape). Chosen (a):
> under (b) `getDefinitionByName("flash.display3D.Context3DNative")` would **succeed** in a default build, making
> `RendererFactory`'s probe meaningless.

### 5.3 M3 · Metal backend (`vendor/stage3d_glue.mm`)

| Action | Now → target |
|---|---|
| Float format surface | `s3d_create_render_texture_fmt(ctx,w,h,isHalf)`'s `int isHalf` is **too narrow** → an `int fmt` enum (`0=BGRA8 1=RGBA16F 2=RGBA32F 3=R32F 4=RG16F 5=R16F`), keeping `isHalf` as a thin compatibility shell |
| Pipeline cache | `s3d_make_pso`'s `isHalf` key → keyed by **attachment format enum** (otherwise 32F hits 16F's old pipeline) |
| Native programs | reuse `s3d_compile` (it already takes text); add `s3d_native_bind_uniform(ctx, prog, bufferIndex, bytes, len)` and `s3d_native_bind_texture(ctx, prog, texIndex, tex)` |
| MRT | `s3d_set_render_targets(ctx, tex[], n, depth)`, `s3d_make_pso` configuring `colorAttachments[i]` for n attachments |
| Depth textures | `s3d_create_depth_texture(ctx,w,h,fmt)`, `MTLTextureUsageRenderTarget|ShaderRead` |
| Sampled depth semantics | **no** automatic linearisation (keep ES semantics: you get NDC z); `linearDepth` is computed in the shader (design §6.4(b)) |

**As-built (2026-11-02)** — differences from the table above; the code is authoritative:

| Actual action | Note |
|---|---|
| `s3d_create_texture_fmt(ctx,w,h,fmtId,renderable)` | 11 ids: `0 BGRA8 / 1 RGBA32F / 2 R32F / 3 RG32F / 4 RGBA16F / 5 R16F / 6 RG16F / 7 RG11B10F / 8 R8 / 9 Depth32F / 10 Depth16`. The binary `isHalf` entry stays as-is for the legacy AIR layer |
| Pipeline key is now `fmtKey + ncolor` | `S3DBlendVariant` gained both fields and they take part in `s3d_select_pso`'s comparison; `s3d_make_pso` configures format and blend per attachment via `nativeNColor`, otherwise 32F hits 16F's pipeline and **Metal rejects the pass** |
| Uniforms go **per-buffer** | `setVertexBytes`/`setFragmentBytes`, indexed by SPIRV-Cross's reflected `[[buffer(N)]]`. **Payload cap 64 bytes** (enough for vec4/mat4; anything larger cannot be expressed by this API — `s3d_native_uniform` truncates rather than overrunning) |
| `nativeMode` disables vc/fc | AGAL packs all vertex constants into `buffer(0)`, and a native program's first uniform is also `buffer(0)` — only one may exist, otherwise the later write silently overwrites the former |
| MRT | attachment 0 comes from `nativeColor[0]` (falling back to `renderOverride`/drawable), 1..n-1 from `nativeColor[]` with `loadAction=Load` (Stage3D has a single clear colour, which belongs to attachment 0) |
| Depth textures | when `nativeDepth` is non-null it is force-attached (its whole reason for existing is later sampling), and the pipeline's depth format follows its `pixelFormat` |
| Textures/samplers | reuse units 0..7; without an explicit `setSamplerStateAt` they get linear+clamp, otherwise the state AGAL recorded is used |

### 5.4 M4 · Web

> **As built (2026-11-03, stage 358)**: this section is the **design-time sketch**; for what actually landed see
> `native-shader.md` §6.11. Three differences from the four draft rows below: ① passthrough really is "hand the
> source to `glCompileShader`", but **reflection cannot be treated as mere automatic enumeration** — GLES3's
> `glGetActiveUniform` is program-level and name-addressed, so it must run on the linked program and every
> uniform must be attributed to a stage (§6.11 traps 1 and 2); ② **slots are numbered from 0 per (kind, stage)**,
> not consecutively across kinds (the first version therefore rendered the whole ocean black with
> `glError == 0`); ③ the draft does not mention that **front face has to be flipped** (`GL_CCW` is the AGAL
> arm's convention; a native program has no Y negation).

| Action | Note |
|---|---|
| Native shader passthrough | `s3d_compile` on the web side already takes GLSL text; `#version 300 es` goes straight to `compileShader` (WebGL2 accepts it) |
| Float RT | query `EXT_color_buffer_float`/`EXT_color_buffer_half_float` at startup; if missing, **degrade and say so** |
| Uniforms by name | `gl.getUniformLocation(prog, name)` — the web is name-based natively; the reflection table is only used for automatic enumeration |
| MRT | `gl.drawBuffers([COLOR_ATTACHMENT0, …])` |

### 5.5 M6 · engine side (`asaot3d`) ✅

| File | Action |
|---|---|
| `kit/asaot/three/materials/ShaderMaterial.as` (new) | `vertexShader`/`fragmentShader`/`uniforms`/`defines`, extends `Material`, **shared by both backends** (design §7.3); `setValues()` rejects unknown keys |
| `seam/asaot/three/NativeShaderRenderer.as` (new) | `extends AGALRenderer`, overriding only `_drawShaderMaterial`; `getDefinitionByName(Context3DNative).fromContext(ctx)` (**no** `import`, see below) |
| `seam/asaot/three/RendererFactory.as` (new) | `getDefinitionByName` + `try/catch` + `as Class` probing, falling back to `AGALRenderer` when absent (design §7.4) |
| `seam/asaot/three/AGALRenderer.as` | `_renderMesh` dispatches to `_drawShaderMaterial`; the base implementation **fails loudly** (design §7.6), no degradation into wrong semantics |
| `seam/asaot/three/app/Stage3DApp.as` | `_renderer = RendererFactory.create(_context)` (backend chosen at runtime; a compile-time constant cannot do it) |

**As-built corrections (three deviations from the plan above)**

1. The reachability hook is the **`extra-roots` manifest field** (design §6.7, user-selected), not `[WasmExport]`;
   the demo's `ShaderM30.build.json` carries `"extra-roots": ["asaot.three.NativeShaderRenderer"]`, and under the
   closure (65/123 sources) that class is still compiled — verified.
2. `NativeShaderRenderer` **must not** name `Context3DNative` in a type position: that source has to compile under
   mxmlc and run under `adl` (taking the "no channel" branch when the class is absent), and a type-position
   reference is `#1046`. Everything goes through `Class(getDefinitionByName(...))` + bracket calls.
3. `Context3DNative` **cannot** be `new (cls)(ctx)`: in this runtime, constructing a built-in class through a Class
   value is a **deliberate `#1063`** (the registry does not give built-in classes a uniform ctor). Hence the static
   factory `Context3DNative.fromContext(ctx)`.

### 5.6 The four real defects M6 exposed (all "compiles, wrong/blank result")

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | link fails with undefined `_asc_shader_translate` | the feature added only a macro, not the shim/archives; expressing the dependency in the demo manifest is not expressing it at all | `build.ts::applyFeatureDeps` — the feature carries its own sources/include/link and the 14 `.a` from `link-order.txt`; `index.ts` applies it after features are final |
| 2 | `getDefinitionByName("flash.display3D.Context3DNative")` misses → silently degrades to a default build | the registry is keyed by `reflectFqn` and the new class had none | `symbols.ts` gains `reflectFqn: 'flash.display3D::Context3DNative'` (and for `NativeProgram3D`) |
| 3 | pipeline creation fails: `Vertex attribute aPos(0) is missing from the vertex descriptor` | `s3d_native_use` created the pipeline immediately, but vertex streams are bound at draw time → a descriptor with 0 attributes | `nativePsoPending`: defer the pipeline to the first draw (what AGAL has always done) |
| 4 | the draw is encoded but **nothing is drawn**, no error at all | `Context3DNative_drawTriangles` called `as_s3d_draw` directly, skipping `Context3D_submit`'s vertex upload → `numStreams == 0` and a silent return | route through `Context3D_submit(context, ibo, n, 1)` (AGAL's own synchronisation point) |

Acceptance: `apps/shader-m30` (`ShaderMaterial` + a 640×480 quad, read back with `drawToBitmapData`) — **15/15
PASS**, the centre pixel `#804020` = `uColor.rgb * 0.5` exactly, and `#361b0e` at 3/8 proves the `vUV` gradient.

---

## 6. Acceptance commands per milestone

```bash
# M1 (no GPU)
bash build-tools/shader/build.sh
clang -O2 -I as3compiler/vendor/shader/include temp/shc-test/main.c \
  as3compiler/vendor/shader/lib/macos-arm64/*.a -lc++ -o temp/shc-test/shc-test
./temp/shc-test/shc-test          # prints MSL + reflection table; non-zero exit = failure

# M2 (compiler side, no GPU) -- note: --emit-c does not exist; use --dry to keep the C
node src/index.ts examples/native-shader-probe.as --features native-shader \
  --manifest examples/native-shader-probe.build.json -o temp/nsp/nsp && ./temp/nsp/nsp
#   → "native-shader-probe OK" / MRT 2 / 5 reflection entries / two rejections with line numbers
#   link: vendor/shader_compiler.cc + the 14 .a under vendor/shader/lib/<host>/
# unit pins ("the default build has no such class")
node --test --test-name-pattern='native-shader/' test/unit/*.ts

# M3 (Metal, on device)
node as3compiler/index.ts examples/native-shader-fft.as --features native-shader --run

# M6 (engine side, real pixels)
cd asaot3d && ./apps/shader-m30/build.sh aot && ./apps/shader-m30/ShaderM30
#   → 15 PASS + "pixel at 1/4 #361b0e, centre #804020"
# the "no channel" half (equivalent to adl / a default build): same .as, feature off
./apps/shader-m30/build.sh aot --features none   # or temporarily remove apps/shader-m30/features
./apps/shader-m30/ShaderM30
#   → "shader-m30 NO-CHANNEL: native channel=false ..." and exit 0
#     (§8 red line: the AIR side reports honestly and never draws an approximation. The base
#      AGALRenderer._drawShaderMaterial throws every frame, so the demo does not add the mesh to
#      the scene when there is no channel — otherwise it becomes an error flood)
# note: `./build.sh air` + adl only proves "the same source compiles under mxmlc"; adl's ENTER_FRAME
#       stalls while the window is not frontmost, so use the command above for scripted acceptance.

# M4 (Web)
node as3compiler/index.ts examples/native-shader-fft.as --features native-shader --target wasm --package web

# regression (once per stage, full run)
node test.ts > temp/node-test-full.log 2>&1
```

---

## 7. Risks and mitigations

| Risk | Level | Mitigation |
|---|---|---|
| glslang/SPIRV-Cross size (~8–12 MB of static archives combined) | medium | **opt-in**: linked only with `--features native-shader`; the default product grows by nothing (hard DoD metric) |
| Cross-compile semantic corners (precision qualifiers, `flat`, integer division, `discard`) | medium | official chain (not in-house); **one probe assertion per feature**, registered item by item |
| 32F RT not renderable on some Metal devices | low | query `MTLDevice` capabilities at runtime, degrade to `RGBA16F` and **say so** |
| Web lacking `EXT_color_buffer_float` | medium | query at startup; when missing, requesting `RGBA_FLOAT` fails naming the extension |
| Blast radius of the new codegen feature parameter | medium | parameter defaults to `[]`; existing call sites unchanged; a unit pin asserts "the default build contains no new classes" |
| No `xcrun metal` offline toolchain here | low | acceptance goes through runtime `newLibraryWithSource:` (§3.4) |
| Cross-end MRT format consistency (WebGL2 wants identical formats) | medium | registered in design §6.2(c); the web side validates up front and says so |

---

## 8. Open items

| # | Question | Status | Conclusion |
|---|---|---|---|
| 1 | Package path of `Context3DNative` | **settled** `flash.display3D.Context3DNative` | same package as `Context3D`, one import fewer for authors |
| 2 | How float formats are expressed on the AS3 side | **settled** `String` constants (`"rgba32f"`… nine of them) | same shape as `Context3DTextureFormat` (also Strings) |
| 3 | Whether to provide `RawShaderMaterial` (no injected preamble) | **not done** | M6 judged `ShaderMaterial` sufficient for three.js's `ShaderMaterial` usage |
| 4 | UBO (`layout(std140) uniform`) | **not done** | to be evaluated after M5; Ultra-Water does not need it. Current binding is **per-`[[buffer(N)]]` by name** and computes no `std140` offsets at all |
| 5 | Build-time precompiled shaders for AOT binaries | **not done** | runtime is the main path (design §5.4); revisit when there is "startup cost" data |
| 6 | How float targets / depth textures are verified (tolerance) | **pending** | the first task of M3's remainder; suggested: **1e-5 relative** for 32F round trips, **1e-3** for 16F, bit-exact for shape/attachment counts |
| 7 | FFT ownership (GPU or CPU) | **pending** | decides M7's shape; settle before starting (design §12) |

---

## 9. Changelog

| Date | Content |
|---|---|
| 2026-11-02 | **M6 engine side + M3 path accepted**: `asaot3d/apps/shader-m30` 15/15 PASS (centre `#804020`, 3/8 `#361b0e`), default build/`adl` prints `NO-CHANNEL` and exits 0; the four "compiles, wrong/blank" defects fixed (§5.6); the `extra-roots` manifest field + `--extra-roots` CLI landed; **and the docs were corrected to match**: M3 downgraded to 🟡 (float RT / MRT readback / depth textures **unverified**), M6 item count 13 → 15, §8 items 1–5 closed |
| 2026-11-02 | **M2 complete + M3 code landed**: `--features native-shader` (native only), the built-in `Context3DNative`/`NativeProgram3D`, `asc_shader_translate` wiring, Metal-side `s3d_native_*` and MRT pipelines; `examples/native-shader-probe.as` green; `test/unit/native-shader.ts` pins the gating |
| 2026-11-02 | **doc correction**: §8 item 4's wording fixed — the current binding does not merely "not need UB0 offsets", it **computes no `std140` offsets at all** (one buffer per uniform, addressed by name) |