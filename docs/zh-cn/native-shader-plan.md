# E6 原生着色器直通 · 实施立项（WBS）

> 本文是 [`native-shader.md`](native-shader.md)（设计）的**施工图**：设计回答「为什么、是什么」，
> 本文回答「**谁、按什么顺序、改哪个文件的哪一段、怎么验收**」。
> 立项依据：[`enhancements.md`](enhancements.md) §3 的 **E6**（判定为增强、opt-in、AOT-only）。
>
> 状态：**已开工**。已核实的技​术基线见 §3，**全部在真机跑过**，不是推测。

---

## 0. 与设计文档的分工

| 文档 | 回答 |
|---|---|
| [`native-shader.md`](native-shader.md) | 源语言为什么是 GLSL ES 3.00、判定为什么是「增强」、编译器侧/AS 侧**要动哪些类别**、红线在哪 |
| **本文** | 里程碑切分、**文件级**改动清单、**接口契约**（入口名/绑定约定/GLSL 子集）、每步的**可执行验收命令**、踩到的坑与决定 |

设计文档 §9 的分阶段（P1 Metal / P2 Web / P3 D3D12 / P4 Ultra-Water）在本文件展开为
**M0–M7**，并补上设计文档没写的第一件事：**先把交叉编译链做成能独立验证的 C 组件**。

---

## 1. 现状基线（已核实，2026-11-02）

开工前逐项核对代码，避免把「已经有了的」重做一遍。

| 事实 | 位置 | 对实施的意义 |
|---|---|---|
| **层 1 纹理格式已修完**（六常量 + `rgbaHalfFloat` + `#2008`/`#3745`/`#3759` 顺序） | `src/symbols.ts:7556-7567`，提交 `4240be1` | 设计文档 §6.1 层 1 的四处偏差**已不存在**，本阶段不重做；只需在 DoD 里守住「不回退」 |
| **`RGBA_HALF_FLOAT` 渲染目标已通** | `vendor/stage3d_glue.mm:2100`（`MTLPixelFormatRGBA16Float`）+ `s3d_compile` 的 `isHalf` 变体（`:1391`） | 半浮点 RT 是现成的；E6 要加的是**全精度 32F 与单/双通道**格式 |
| **AGAL 三向翻译器** | `src/runtime.ts:15258` `as_agal_translate`（MSL/GLSL/HLSL） | 「源码字符串 → 后端文本 → `s3d_compile` 编译」这条发射管线**已存在**，E6 只是换源语言 |
| **AGAL4 顶点纹理取值已落** | 提交 `5d92d93`（`tld`） | 证明 `[[texture(N)]]` 在顶点阶段可用，原生路径的 vertex texture fetch 无新硬件障碍 |
| **`s3d_compile(ctx, key, vs, fs, errbuf, cap)` 直接吃文本** | `vendor/stage3d_glue.mm:1540` | Metal 侧「原生 MSL 编译」**零新增**：把 SPIRV-Cross 的产物喂同一个入口即可 |
| **`IRenderer` 接缝** | `asaot3d/seam/asaot/three/IRenderer.as`（16 行，`render`+`setSize`） | 引擎侧落点已定 |
| **`--features` 注册表 + 前置拒绝** | `src/build.ts:999` `FEATURES`，`validateFeatures` | 新增开关是照抄 `tray`/`svg` 的成熟形态 |
| **内建类「存在但行为被开关门控」的先例** | `SystemTrayIcon`：`src/emit.ts:11381` 用 `#if ASC_HAS_TRAY` | **默认与 AIR 逐字同形、开开关才增强**——E6 的类沿用这个形态，不另发明 |
| **glslang / SPIRV-Cross 在本机不存在** | `build-tools/` 只有 skia/emsdk/curl | 本阶段第一件事 |

---

## 2. 范围与里程碑

### 2.1 范围（做）

- 提交**原生 GLSL ES 3.00** 顶点/片元源码并交叉编译到 Metal（MSL）、WebGL2（直通）、D3D12（HLSL，M5）。
- 浮点渲染目标（`RGBA_FLOAT`/`R32F`/`RG16F`/`R16F`/`RGBA_HALF_FLOAT`），含**读写双向**。
- MRT 多渲染目标（`layout(location=N) out`），Metal / WebGL2 先落。
- 深度纹理（可采样 + 可作 attachment），供 §6.4 的 depth-validated 折射。
- 以 Ultra-Water 的 FFT 海洋为终验负载（GPU FFT）。

### 2.2 范围（不做）

- 不做通用 Vulkan 后端（`Context3D` 只有 Metal/D3D12/WebGL2 三条路）。
- 不自研交叉编译器（用 Khronos 官方链，见 §3）。
- 不把浮点格式塞进 `Context3DTextureFormat`（设计 §6.1 方案 B：走独立新类，保持默认产物与 AIR 同构）。
- 不改 `AGAL` 路径的任何默认行为。

### 2.3 里程碑

| 里程碑 | 内容 | 验收（可执行） |
|---|---|---|
| **M0 立项** | 本文 + `enhancements.md` E6 状态 + `TODO.md` 阶段条目 | 文档落库，`node test.ts` 不变 |
| **M1 交叉编译链** | `build-tools/shader/` 建 glslang + SPIRV-Cross；`vendor/shader_compiler.cc` 的 C 接口；独立 C 测试程序 | `./temp/shc-test` 打印出正确 MSL（含反射表） |
| **M2 编译器侧** ✅ | `--features native-shader` 注册；`Context3DNative` 内建类 + 格式常量 + `uploadProgram`/绑定/draw；`ASC_HAS_NATIVE_SHADER` 门控 | `examples/native-shader-probe.as` 绿：MRT=2、反射 5 条、ES1.00/legacy 双双带行号拒绝 |
| **M3 Metal 后端** 🟡 | 浮点 RT 格式面、原生程序绑定（uniform/纹理/属性）、MRT、深度纹理 | **通路已真机验收，三项能力面未验**：`apps/shader-m30` 中心 `#804020` / 3-8 处 `#361b0e`，与 `uColor.rgb * vUV.x` 逐位相符（但它画的是**后台缓冲**）；**浮点 RT 读回、MRT 两附件分别读回、深度纹理采样均未验收**（格式创建面与 11 个 id 已落）。M7 开工前先补这三项（设计 §11 表） |
| **M4 Web 免费点** | `stage3d_webgl.cc` 直通 + `EXT_color_buffer_float` | `--target wasm` 同一份 `.as` 出同一画面，零交叉编译 |
| **M5 D3D12** | `stage3d_d3d.cc` 浮点 `DXGI_FORMAT` + 原生 HLSL | Windows 出图（CI/实机） |
| **M6 引擎侧** ✅ | `ShaderMaterial` + `NativeShaderRenderer` + `RendererFactory` + `extra-roots` 清单字段 | `apps/shader-m30` **15 项全 PASS**；`adl`/默认构建打印 NO-CHANNEL 并如实拒画（§8 红线）；引擎侧决策见 `asaot3d/three-api-design.md` §37 |
| **M7 Ultra-Water 对齐** | FFT 海洋 → caustics → 大气 → 水下 | 与 three.js 参考逐项对拍 |

---

## 3. 已核实的技术基线（真机跑过）

这一节是本立项最重要的部分：**所有结论都有命令与输出**，不是从文档抄的。

### 3.1 两个库能建

```
build-tools/shader/
  glslang-src      @ e7917c4 (main)
  glslang-build    -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_OPT=OFF -DBUILD_SHARED_LIBS=OFF
  spirv-cross-src  @ 65d7393
  spirv-build      -G Ninja -DCMAKE_BUILD_TYPE=Release -DSPIRV_CROSS_CLI=ON -DSPIRV_CROSS_STATIC=ON
```

产物（静态库，可整链接）：

| 库 | 归档 |
|---|---|
| glslang | `libglslang.a` `libSPIRV.a` `libMachineIndependent.a` `libGenericCodeGen.a` `libOSDependent.a` `libglslang-default-resource-limits.a` |
| SPIRV-Cross | `libspirv-cross-core.a` `-cpp.a` `-glsl.a` `-msl.a` `-hlsl.a` `-reflect.a` `-util.a` `-c.a` |

- `-DENABLE_OPT=OFF` 关掉 SPIRV-Tools（我们不做 SPIR-V 优化，省一整个子模块）。
- 两个库都是 **Apache-2.0**，按 AGENTS §2.9 以 C 静态库**链接**，不违反 §3.1（那条只禁 npm 依赖）。

### 3.2 GLSL ES 3.00 → MSL 的真实命令序列（三个坑）

```
glslang -S vert -G --target-env opengl --auto-map-locations  a.vert -o a.vert.spv
spirv-cross --msl --msl-version 20100 a.vert.spv
```

**坑 1：`#version 300 es` 不能直接进 SPIR-V。**
glslang 明确拒绝：`ERROR: #version: ES shaders for SPIR-V require version 310 or higher`。
⇒ 送 SPIR-V 前**必须把 `#version 300 es` 升级成 310 es**。ES 3.10 是 3.00 的超集，作者的 3.00 源码语义不变；
升级只发生在**内部**，作者仍按 3.00 写（Web 直通那一端保持 300 不变）。

**坑 2：Vulkan 环境不接受裸 uniform。**
`-V --target-env vulkan1.0` 报 `'non-opaque uniforms outside a block' : not allowed when using GLSL for Vulkan`。
⇒ 必须用 **`-G --target-env opengl`**（OpenGL 版 SPIR-V），它允许 `uniform float uT;` 这种三.js 风格写法。
代价：不能用 Vulkan 专属特性（push constant / descriptor set），我们也不需要。

**坑 3：需要 `--auto-map-locations`。**
SPIR-V 要求 in/out 有 location；不写 `layout(location=)` 的 varying 会报
`'location' : SPIR-V requires location for user input/output`。加这个旗标后 glslang 自动分配，
且与 SPIRV-Cross 的 `[[user(locnN)]]` 对齐。

### 3.3 产物形状（决定我们的绑定 API）

作者写（`tri.frag`）：

```glsl
#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 o0;   // MRT 两个附件
layout(location = 1) out vec4 o1;
uniform float uT;
uniform sampler2D uTex;
void main() { o0 = vec4(texture(uTex, vUV).rgb * uT, 1.0); o1 = vec4(vUV, 0.0, 1.0); }
```

SPIRV-Cross 产出的 MSL：

```metal
struct main0_out { float4 o0 [[color(0)]]; float4 o1 [[color(1)]]; };   // MRT 天然成立
struct main0_in  { float2 vUV [[user(locn0)]]; };
fragment main0_out main0(main0_in in [[stage_in]],
                         constant float& uT [[buffer(0)]],              // 每个 uniform 独立 buffer 槽
                         texture2d<float> uTex [[texture(0)]],
                         sampler uTexSmplr [[sampler(0)]])
{ out.o0 = float4(uTex.sample(uTexSmplr, in.vUV).xyz * uT, 1.0); ... }
```

顶点侧同理：`float2 aPos [[attribute(0)]]`（对应 AGAL 的 `va0`）、`constant float4x4& uMVP [[buffer(0)]]`。

**由此定下三条契约**（写进 §4）：

1. **uniform 按名字绑定**：SPIRV-Cross 给每个 uniform 一个独立 `[[buffer(N)]]`，反射表给出 `名字 → N`。
   我们的 API 因此是**按名字**的（`setUniform1f(prog, "uT", v)`），不是按寄存器号——这是 `ShaderMaterial`
   风格，也与 three.js 一致。**不需要**算对齐偏移。
2. **属性位置即顶点流号**：`layout(location=N) in` ↔ `s3d_upload_vertex(ctx, stream=N, ...)`，与现有
   `va0..va7` 一一对应，**顶点布局零改动**。
3. **纹理与采样器成对**（`[[texture(N)]]`/`[[sampler(N)]]` 同号），沿用 AGAL4 VTF 那一轮已经打通的
   `setFragmentTexture/setFragmentSamplerState` 配对逻辑。

**入口名要改**：SPIRV-Cross 用 `main0`，而 `s3d_compile` 找的是 `vs_main`/`fs_main`。两种做法：

- (a) SPIRV-Cross 的 `rename_entry_point("main", "vs_main")` API；
- (b) 文本后处理 `main0` → `vs_main`。

选 **(a)**：文本替换会误伤注释/标识符里的 `main0`，API 改名是帕累托最优。

### 3.4 本机的 Metal 离线编译器不可用（**影响验收方式**）

```
$ xcrun -sdk macosx metal -c tri.vert.msl -o tri.vert.air
error: cannot execute tool 'metal' due to missing Metal Toolchain; use: xcodebuild -downloadComponent MetalToolchain
```

⇒ **不能**用 `xcrun metal` 做验收。改用**运行期编译**：`newLibraryWithSource:` 用的是系统 Metal 框架
（不是离线工具链），`s3d_compile` 本来就走这条。所以 M3 的验收是「程序跑起来、MSL 被 `newLibraryWithSource:`
接受」，而不是「`xcrun metal` 返回 0」。设计文档 §9 写的 `xcrun metal` 验收方式在本文作废，理由如上。

---

## 4. 接口契约（必须先钉死，否则各端会漂）

### 4.1 GLSL 子集（作者可写什么）

**接受**：`#version 300 es`（内部升级 310 送 SPIR-V；web 原样）

| 类别 | 内容 |
|---|---|
| 类型 | `float/vec2..4/mat2..4/int/uint/bool/ivec*/uvec*/bvec*`、`sampler2D`、`samplerCube`、`sampler2DShadow` |
| 存储限定 | `const`、`in`/`out`（`layout(location=N)` 可选，自动分配兜底）、`uniform`、`flat`、`centroid` |
| 内建函数 | 全套 GLSL ES 3.00（`texture`/`textureLod`/`texelFetch`/`textureSize`/`dFdx`/`dFdy`/`inverse`/`transpose`…） |
| 精度 | `precision mediump/highp float` 声明**必需**（ES 规范要求片元有默认精度，否则 glslang 报错） |

**拒绝**（本节即「本后端不支持 X」的失败面，报错要说清）：
- `#version` 非 `300 es`（含 `310 es`/`330 core`/无版本）⇒ 报「only GLSL ES 3.00 is accepted」。
  内部升级是**单向**的，作者不得自己写 310。
- `attribute`/`varying`/`texture2D`（那是 ES 1.00 写法）⇒ 报「ES 1.00 syntax; use in/out/texture」。
- `geometry`/`tessellation`/`compute` 着色器（Stage3D 无对应阶段）⇒ 报「no such stage」。
- `#include`（GLSL 无此指令；three.js 的 chunk 拼接在 AS3 侧做）。

### 4.2 绑定契约

| 概念 | 作者侧（AS3） | Metal | WebGL2 | D3D12 |
|---|---|---|---|---|
| 顶点属性 | `layout(location=N) in` | `[[attribute(N)]]` ↔ 顶点流 N | `layout(location=N)` 原生 | `layout(location=N)`（HLSL 需转 `TEXCOORD N`，见 M5） |
| uniform 标量/向量/矩阵 | `setUniform(prog, "name", value)` | `[[buffer(N)]]` 按名反射 | `gl.getUniformLocation` 按名 | `bN` 按名反射 |
| 纹理 | `bindTexture(prog, "name", tex)` | `[[texture(N)]]` + `[[sampler(N)]]` | `glUniform1i` 到 unit | `tN`/`sN` |
| 渲染目标 | `setRenderTarget(color, depth)` | 多 color attachment | `drawBuffers` | `OMSetRenderTargets` |

**N 从哪来**：M1 的 C 接口做反射，返回
`{ name, kind, binding }` 三元组数组。运行时建一张 `name → binding` 表，`setUniform` 查表。

### 4.3 错误面

| 情形 | 行为 |
|---|---|
| GLSL 语法/类型错 | `uploadProgram` 抛 `Error`，`message` 是 glslang 的**原文**（带 `行:列`），不吞 |
| 链接错（varying 不匹配） | 同上，报 glslang link 日志 |
| MSL/HLSL 编译错 | 报后端原文（`newLibraryWithSource:` 的 `localizedDescription`） |
| `setUniform` 用了反射表里没有的名字 | 抛 `ArgumentError`（**不静默忽略**——静默会让作者以为生效） |
| 纹理格式在前端不可渲染 | 抛 `ArgumentError`，文案点名缺哪个扩展 |

---

## 5. WBS（文件级）

### 5.1 M1 · 交叉编译链

| 文件 | 动作 |
|---|---|
| `build-tools/shader/{glslang-src,spirv-cross-src}` | 源码（生产环境由 `tools/fetch-shader-libs.sh` 复现，见下） |
| `build-tools/shader/build.sh`（新增） | 一条命令从零建两个库 + 把归档与头文件装到 `as3compiler/vendor/shader/` |
| `as3compiler/vendor/shader/include/` | `spirv_cross/`、`glslang/` 头文件（链接期需要） |
| `as3compiler/vendor/shader/lib/<host>/*.a` | 静态归档 |
| **`as3compiler/vendor/shader_compiler.cc`（新增）** | C++ 垫片，唯一暴露纯 C 接口的翻译单元：glslang 编译 → SPIRV-Cross 跨编 → 反射 |
| `as3compiler/vendor/shader_compiler.h`（新增） | 纯 C 头：句柄结构 + 5 个函数 |
| `temp/shc-test/main.c`（新增，验收用） | 独立 C 程序，喂 §3.3 的双 RT 片元着色器，打印 MSL + 反射表 |

C 接口（草案，M2 定稿）：

```c
typedef struct { const char* name; int kind; int binding; int size; } AscShaderUniform;
typedef struct {
  char* vertex_msl; char* fragment_msl;         // 调用方 free
  AscShaderUniform* uniforms; int uniform_count;
  AscShaderUniform* textures; int texture_count;
  AscShaderUniform* attributes; int attribute_count;
  char error[1024];                              // 非空 = 失败
} AscShaderProgram;

// target: 0=MSL  1=GLSL_ES3(passthrough, 只校验)  2=HLSL
int asc_shader_translate(const char* vs, const char* fs, int target, AscShaderProgram* out);
void asc_shader_program_free(AscShaderProgram* p);
```

### 5.2 M2 · 编译器侧

| 文件 | 动作 |
|---|---|
| `src/build.ts` | `FEATURES['native-shader'] = { macro:'ASC_USE_NATIVE_SHADER=1', targets:['native','wasm'], why:'' }`；`native-shader` 时给 native 目标注入 `vendor/shader_compiler.cc` 与 glslang/SPIRV-Cross 的 `-L/-l`（**wasm 不注入**，透传零依赖）；wasm 目标注入 `ASC_S3D_GLSL=1` 已在 |
| `src/index.ts` | 把 `cfg.features` 透传进 `generateC`（**新增参数**，目前 codegen 看不到 feature，见 §5.2 注） |
| `src/codegen.ts` | `generateC(..., features)` |
| `src/symbols.ts` | `native-shader` 时注册 `flash.display3D.Context3DNative`（含格式常量 + 方法签名）+ `flash.display3D.NativeProgram3D` |
| `src/runtime.ts` | `ASC_HAS_NATIVE_SHADER` 派生宏；`asc_shader_translate` 的 extern 声明与 `as_shader_translate` 包装；`as_s3d_*` 的 native 一族 |
| `src/emit.ts` | `Context3DNative` 的方法体（`uploadProgram`/`setUniform*`/`bindTexture`/`setRenderTarget`/`draw`/`getInfoLog`），默认（无开关）时**整个类不注册** ⇒ `getDefinitionByName` 抛 `#1065`，与 AIR 同形 |

> **落地情况（2026-11-02，阶段三百五十三）**：上表六项全部完成，且有两处按实测改了方案：
> 1. `FEATURES['native-shader'].targets` 收窄成 `['native']`。原计划含 `wasm`，但 wasm 侧那条路是
>    「作者 GLSL 原样喂 WebGL2」——它**不需要** `asc_shader_translate`，需要的是 M4 的
>    `stage3d_webgl.cc` 直通；在那之前把 `wasm` 打开只会让 web 构建连到不存在的 shim。
>    拒绝理由写进 `why`，`validateFeatures` 会照着报出来。
> 2. `uploadProgram` 编译失败**不抛异常**：返回 `ok=false` 且 `infoLog` 带 glslang 原文，
>    只有「用这个程序」（`useProgram`/`setUniform*`/`bindTexture`/`drawTriangles`）才抛。
>    理由是作者必须先能打印 `getInfoLog()`；这是 three.js 的形态，也是唯一能让人看懂错在哪的形状。
>
> **注：feature 与 codegen 的耦合是新增的。** 现在 `--features` 只影响 C 编译命令（`svg`/`tray` 都不改符号表），
> 而 E6 要让「类是否存在」随开关变。两条路：(a) 把 features 传进 codegen（本节选它，因为设计文档
> §6.1 方案 B 要求「默认产物与 AIR 同构」——类不能存在）；(b) 类恒在、行为全部抛错（`tray` 的形态）。
> 选 (a) 的理由：`(b)` 会让 `getDefinitionByName("flash.display3D.Context3DNative")` 在默认构建里**成功**，
> 于是 `RendererFactory` 的探测失去意义。

### 5.3 M3 · Metal 后端（`vendor/stage3d_glue.mm`）

| 动作 | 现状 → 目标 |
|---|---|
| 浮点格式面 | `s3d_create_render_texture_fmt(ctx,w,h,isHalf)` 的 `int isHalf` **过窄** → 改成 `int fmt` 枚举（`0=BGRA8 1=RGBA16F 2=RGBA32F 3=R32F 4=RG16F 5=R16F`），`isHalf` 保留为兼容薄壳 |
| 管线缓存 | `s3d_make_pso` 的 `isHalf` 键 → 键改为**附件格式枚举**（否则 32F 会命中 16F 的旧管线） |
| 原生程序 | 复用 `s3d_compile`（它已经吃文本）；新增 `s3d_native_bind_uniform(ctx, prog, bufferIndex, bytes, len)`、`s3d_native_bind_texture(ctx, prog, texIndex, tex)` |
| MRT | `s3d_set_render_targets(ctx, tex[], n, depth)`，`s3d_make_pso` 按 n 个附件配 `colorAttachments[i]` |
| 深度纹理 | `s3d_create_depth_texture(ctx,w,h,fmt)`，`MTLTextureUsageRenderTarget|ShaderRead` |
| 采样值语义 | 深度采样**不做**自动线性化（保持 ES 语义：拿到 NDC z），`linearDepth` 由 shader 侧算（设计 §6.4(b)） |

**落地情况（2026-11-02）**——与上表的差异，按实际代码为准：

| 实际动作 | 说明 |
|---|---|
| `s3d_create_texture_fmt(ctx,w,h,fmtId,renderable)` | 11 个 id：`0 BGRA8 / 1 RGBA32F / 2 R32F / 3 RG32F / 4 RGBA16F / 5 R16F / 6 RG16F / 7 RG11B10F / 8 R8 / 9 Depth32F / 10 Depth16`。`isHalf` 那个二值入口保留原样（AIR 遗留层继续用它） |
| 管线键改为 `fmtKey + ncolor` | `S3DBlendVariant` 加了这两个字段并参与 `s3d_select_pso` 的比较；`s3d_make_pso` 按 `nativeNColor` 逐附件配格式与 blend，否则 32F 会命中 16F 的旧管线（Metal 直接拒绝该 pass） |
| uniform 走**逐条 buffer** | `setVertexBytes/setFragmentBytes`，索引即 SPIRV-Cross 反射出的 `[[buffer(N)]]`。**payload 上限 64 字节**（vec4/mat4 足够；超出的 uniform 这个 API 表达不了，`s3d_native_uniform` 截断而不是越界） |
| `nativeMode` 关掉 vc/fc | AGAL 把所有顶点常量打包进 `buffer(0)`，原生程序的第一条 uniform 也在 `buffer(0)`——两者只能留一个，否则后写的静默覆盖前者 |
| MRT | 附件 0 来自 `nativeColor[0]`（回落到 `renderOverride`/drawable），1..n-1 来自 `nativeColor[]` 且 `loadAction=Load`（Stage3D 只有一个清屏色，属于附件 0） |
| 深度纹理 | `nativeDepth` 非空时强制挂附件（存在的理由就是之后要采样），管线深度格式跟随它的 `pixelFormat` |
| 纹理/采样器 | 复用 0..7 单元；未显式 `setSamplerStateAt` 时给 linear+clamp，否则沿用 AGAL 记下的状态 |

### 5.4 M4 · Web

| 动作 | 说明 |
|---|---|
| 原生 shader 直通 | `s3d_compile` 在 web 侧本来就吃 GLSL 文本；`#version 300 es` 直接进 `compileShader`（WebGL2 接受） |
| 浮点 RT | 启动时查 `EXT_color_buffer_float`/`EXT_color_buffer_half_float`，缺失则**降级并报明** |
| uniform 按名 | `gl.getUniformLocation(prog, name)` —— WebGL 天然按名，反射表只用来自动枚举 |
| MRT | `gl.drawBuffers([COLOR_ATTACHMENT0, …])` |

### 5.5 M6 · 引擎侧（`asaot3d`）✅

| 文件 | 动作 |
|---|---|
| `kit/asaot/three/materials/ShaderMaterial.as`（新增） | `vertexShader`/`fragmentShader`/`uniforms`/`defines`/`lights`，继承 `Material`，**双后端共享**（设计 §7.3）；`setValues()` 拒绝未知键 |
| `seam/asaot/three/NativeShaderRenderer.as`（新增） | `extends AGALRenderer`，只覆写 `_drawShaderMaterial`；`getDefinitionByName(Context3DNative).fromContext(ctx)`（**不** `import`，见下） |
| `seam/asaot/three/RendererFactory.as`（新增） | `getDefinitionByName` + `try/catch` + `as Class` 探测，缺失回退 `AGALRenderer`（设计 §7.4） |
| `seam/asaot/three/AGALRenderer.as` | `_renderMesh` 分派到 `_drawShaderMaterial`；基类实现**如实报错**（设计 §7.6），不降级成错误语义 |
| `seam/asaot/three/app/Stage3DApp.as` | `_renderer = RendererFactory.create(_context)`（运行期选后端，编译期常量做不到） |

**as-built 修正（与上表原计划的三处偏差）**

1. 可达性钩子用 **`extra-roots` 清单字段**（设计 §6.7 用户选定），不是 `[WasmExport]`；demo 的
   `ShaderM30.build.json` 写 `"extra-roots": ["asaot.three.NativeShaderRenderer"]`，闭包路径
   （65/123 sources）下该类仍被编译，已验证。
2. `NativeShaderRenderer` **不得**在类型位置写 `Context3DNative`：那份源码要能被 mxmlc 编译、
   被 `adl` 运行（缺类时走「无通道」分支），类型位置引用是 `#1046`。全部改走
   `Class(getDefinitionByName(...))` + 方括号调用。
3. `Context3DNative` **不能** `new (cls)(ctx)`：本运行时里内建类经 Class 值构造是**故意的
   #1063**（注册表不给内建类统一 ctor）。因此有静态工厂 `Context3DNative.fromContext(ctx)`。

### 5.6 M6 落地时暴露的四个真缺陷（都在「编译过、结果错/空」那一类）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 链接报 `_asc_shader_translate` 未定义 | feature 只加宏，不加 shim/档案；依赖写在 demo manifest 里等于没写 | `build.ts::applyFeatureDeps` —— feature 自带 sources/include/link/`link-order.txt` 里的 14 个 .a，`index.ts` 在 feature 定稿后应用 |
| 2 | `getDefinitionByName("flash.display3D.Context3DNative")` 落空 → 静默退化成默认构建 | 注册表按 `reflectFqn` 建键，新类没给 | `symbols.ts` 补 `reflectFqn: 'flash.display3D::Context3DNative'`（与 `NativeProgram3D`） |
| 3 | 管线创建失败 `Vertex attribute aPos(0) is missing from the vertex descriptor` | `s3d_native_use` 立刻建 pipeline，而顶点流要到 draw 才绑定 → 描述符 0 属性 | `nativePsoPending`：管线延到首次 draw（AGAL 一直是这么做的） |
| 4 | draw 编码了但**什么都没画**，无任何报错 | `Context3DNative_drawTriangles` 直接 `as_s3d_draw`，跳过 `Context3D_submit` 的顶点上传 → `numStreams == 0` 静默 return | 改走 `Context3D_submit(context, ibo, n, 1)`（AGAL 同一个同步点） |

验收：`apps/shader-m30`（`ShaderMaterial` + 640×480 四边形，`drawToBitmapData` 读回）
13 项全 PASS，中心像素 `#804020` = `uColor.rgb * 0.5` 精确命中，3/8 处 `#361b0e` 证明 `vUV` 梯度。

---

## 6. 里程碑验收命令

```bash
# M1（无 GPU）
bash build-tools/shader/build.sh
clang -O2 -I as3compiler/vendor/shader/include temp/shc-test/main.c \
  as3compiler/vendor/shader/lib/macos-arm64/*.a -lc++ -o temp/shc-test/shc-test
./temp/shc-test/shc-test          # 打印 MSL + 反射表；非 0 退出即失败

# M2（编译器侧，无 GPU）——注意 --emit-c 并不存在，保留 C 用 --dry
node src/index.ts examples/native-shader-probe.as --features native-shader \
  --manifest examples/native-shader-probe.build.json -o temp/nsp/nsp && ./temp/nsp/nsp
#   → "native-shader-probe OK" / MRT 2 / 反射 5 条 / 两条拒绝理由带行号
#   链接：vendor/shader_compiler.cc + vendor/shader/lib/<host>/ 的 14 个 .a
# 单测（钉「默认构建没有这个类」）
node --test --test-name-pattern='native-shader/' test/unit/*.ts

# M3（Metal 真机）
node as3compiler/index.ts examples/native-shader-fft.as --features native-shader --run

# M6（引擎侧，真机像素）
cd asaot3d && ./apps/shader-m30/build.sh aot && ./apps/shader-m30/ShaderM30
#   → 13 项 PASS + "pixel at 1/4 #361b0e, centre #804020"
# 「无通道」那半（等价于 adl / 默认构建）：同一份 .as，关掉 feature
./apps/shader-m30/build.sh aot --features none   # 或临时停用 apps/shader-m30/features
./apps/shader-m30/ShaderM30
#   → "shader-m30 NO-CHANNEL: native channel=false ..." 并退出 0
#     （§8 红线：AIR 侧如实报明，不画近似图。基类 AGALRenderer._drawShaderMaterial
#      会每帧抛错拒绝——demo 因此在无通道时不把网格加进场景，避免变成报错洪水）
# 注：`./build.sh air` + adl 只验证「同一份源码能被 mxmlc 编译」，adl 的 ENTER_FRAME
#     在窗口未被激活(前台)时会停摆，脚本化验收请用上面那条。

# M4（Web）
node as3compiler/index.ts examples/native-shader-fft.as --features native-shader --target wasm --package web

# 回归（每阶段收尾，全量一次）
node test.ts > temp/node-test-full.log 2>&1
```

---

## 7. 风险与对策

| 风险 | 级别 | 对策 |
|---|---|---|
| glslang/SPIRV-Cross 体积（合计约 8–12 MB 静态库） | 中 | **opt-in**：只在 `--features native-shader` 时链接；默认产物零增长（DoD 硬指标） |
| 交叉编译语义边角（精度限定符、`flat`、整数除法、`discard`） | 中 | 用官方链（非自研）；**每个特性配一个 probe 断言**，逐项登记 |
| 32F RT 在部分 Metal 设备不可渲染 | 低 | 运行时查 `MTLDevice` 特性，缺失则降到 `RGBA16F` 并**报明**（不静默） |
| Web 的 `EXT_color_buffer_float` 缺失 | 中 | 启动查询；缺失时 `Context3DNative.isAvailable` 仍为真但 `RGBA_FLOAT` 请求失败并报扩展名 |
| codegen 新增 feature 参数波及面 | 中 | 参数缺省 `[]`，现有调用点行为不变；单测钉「默认构建不含新类」 |
| 本机无 `xcrun metal` 离线工具链 | 低 | 验收改走运行期 `newLibraryWithSource:`（§3.4） |
| 三端 MRT 格式一致性（WebGL2 要求同格式） | 中 | 设计 §6.2(c) 已登记；Web 侧建 MRT 时前置校验并报明 |

---

## 8. 待定项

| # | 问题 | 现状 | 结论 |
|---|---|---|---|
| 1 | `Context3DNative` 的包路径 | **已定** `flash.display3D.Context3DNative` | 与 `Context3D` 同包，作者少一个 import |
| 2 | 浮点格式在 AS3 侧的表达 | **已定** `String` 常量（`"rgba32f"`…共 9 个） | 与 `Context3DTextureFormat` 同形（那也是 String） |
| 3 | 是否提供 `RawShaderMaterial`（不注入任何前导） | **未做** | M6 评估过：`ShaderMaterial` 已足够覆盖 three.js 的 `ShaderMaterial` 用法，暂不做 |
| 4 | UBO（`layout(std140) uniform`） | **未做** | M5 后评估，Ultra-Water 不需要；现在的绑定是**逐条 `[[buffer(N)]]` 名字绑定**，压根不算 `std140` 偏移 |
| 5 | 是否为 AOT 二进制预编译 shader（build-time） | **未做** | 运行时为主（设计 §5.4）；等有「启动耗时」数据再评估 |
| 6 | 浮点目标/深度纹理的真机验证口径（容差怎么定） | **待定** | M3 余项第一件事；建议：格式往返用**相对误差 1e-5**（32F）与 **1e-3**（16F），形状/附件数用逐位 |
| 7 | FFT 归属（GPU 还是 CPU） | **待定** | 直接决定 M7 形状，开工前定（设计 §12） |

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-11-02 | **M6 引擎侧验收 + M3 通路验收**：`asaot3d/apps/shader-m30` 15 项 PASS（中心 `#804020`、3/8 `#361b0e`），默认构建/`adl` 打印 `NO-CHANNEL` 并退出 0；修掉四个「编译过、结果错/空」缺陷（§5.6）；`extra-roots` 清单字段 + `--extra-roots` CLI 落地；**同时修正文档口径**：M3 降为 🟡（浮点 RT / MRT 读回 / 深度纹理**未验收**）、M6 项数 13 → 15、§8 待定项 1/2/3/4/5 结案 |
| 2026-11-02 | **M2 完成 + M3 代码落地**：`--features native-shader`（仅 native）、`Context3DNative`/`NativeProgram3D` 金标内建、`asc_shader_translate` 接线、Metal 侧 `s3d_native_*` 与 MRT 管线；`examples/native-shader-probe.as` 绿；`test/unit/native-shader.ts` 钉门控 |
| 2026-11-02 | 立项；M1 交叉编译链在真机跑通（glslang@e7917c4 + SPIRV-Cross@65d7393，GLSL 300es→MSL 20100 全链路）；钉下 §4 契约 |