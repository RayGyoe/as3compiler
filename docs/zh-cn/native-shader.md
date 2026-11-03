# 原生着色器直通（E6：GLSL ES 3.00 源语言）

> 本文回答：**「原生着色器直通」这个增强到底是什么、为什么必要、要动 AS 侧哪些东西、要动编译器侧哪些东西、
> 怎么分阶段落地、红线在哪。** 它是 [`enhancements.md`](enhancements.md) §3 里 E6 的立项设计文档，
> 也是 [`display3d.md`](display3d.md) §3「AGAL 翻译」的**姊妹篇**——AGAL 翻译解决「对齐 AIR」，
> 本文解决「超出 AIR」。
>
> 结论先行：**源语言定 GLSL ES 3.00；Metal / D3D / Vulkan 用 glslang + SPIRV-Cross 交叉编译到
> MSL / HLSL / SPIR-V；Web 后端（WebGL2）直接透传，零交叉编译。MSL 只当 Metal 的编译目标，
> 不当源语言。** 这条链是 Flutter Impeller / Godot 4 已经在工业界走通的路。
>
> 相邻文档：[`enhancements.md`](enhancements.md)（增强判定与 `--features` 开关）、
> [`display3d.md`](display3d.md)（Stage3D 对齐与 AGAL 翻译）、[`compile.md`](compile.md)（构建清单与后端）、
> `asaot3d/three-api-design.md` §9（渲染接缝与 `NativeShaderRenderer`）。
>
> **进展（2026-11-02）**：M1 交叉编译链 / M2 编译器侧 / M3 Metal 后端 / M6 引擎侧 **已落地并真机验收**
> —— `asaot3d/apps/shader-m30` 用作者写的一对 GLSL ES 3.00 画四边形，`drawToBitmapData` 读回
> 中心 `#804020`（= `uColor.rgb * vUV.x`）与 3/8 处 `#361b0e`，同一份 `.as` 在默认构建/`adl` 下
> 打印 `NO-CHANNEL` 并退出 0（§8 红线）。**M4 Web 直通 / M5 D3D12 / M7 Ultra-Water 对齐未做**。
> 施工图与逐条 as-built（含落地时暴露的四个真缺陷）见 [`native-shader-plan.md`](native-shader-plan.md)。

---

## 1. 定位：E6 是什么、解决什么

### 1.1 一句话

Stage3D 的着色器语言是 **AGAL**（Adobe 图形汇编语言，二进制字节码），上限是 **ES 1.00 级别**的死规范。
E6 给出一条**绕过 AGAL、直接提交原生着色器源码**的路：作者手写 GLSL ES 3.00，运行时交叉编译到各后端。

### 1.2 触发场景

复刻 [Ultra-Water](https://github.com/Humpalumps/Ultra-Water)（一个 three.js/WebGL2 的 Tessendorf FFT
海洋演示）暴露了 AGAL 的硬天花板：它的整条「FFT 仿真 + HDR 管线 + caustics + 大气 LUT + 水下」都建立在
**浮点渲染目标 + MRT + `texelFetch` + 整数类型** 之上，而这些 Stage3D 的 `Context3D` 标准 profile 一律不提供。

E6 的作用域**不只是 Ultra-Water**：任何 three.js `ShaderMaterial` 风格的负载（GPU 粒子、流体、体积雾、
屏幕空间反射、计算型后处理）都受同一个 AGAL 天花板限制，E6 是一次性把「作者手写 shader」这条路铺通。

---

## 2. 现状盘点：我们手上已经有什么

先摆事实，避免把「已经有的」重复造一遍。

| 已有能力 | 出处 | 对 E6 的价值 |
|---|---|---|
| **AGAL 三向翻译器** `as_agal_translate` | `src/runtime.ts`（AGAL 字节码 → MSL / GLSL ES / HLSL），`ASC_AGAL_TARGET` 三态（MSL=0 / GLSL=1 / HLSL=2） | 证明「着色器源码字符串 → 各后端文本 → 胶水编译」这条**发射管线**已经存在，E6 只需换掉**源语言**（AGAL → GLSL ES 3.00）与**编译方式**（手写翻译 → glslang+SPIRV-Cross） |
| **三份自包含 GPU 胶水** | `vendor/stage3d_glue.mm`（Metal）/ `stage3d_webgl.cc`（WebGL2）/ `stage3d_d3d.cc`（D3D12），同一套 `s3d_*` 接口 | E6 的新能力（float RT / MRT / 原生 shader 提交）落在这三层，不改前端管线 |
| **`Context3DTextureFormat` 与 AIR 有 4 处偏差** | `src/symbols.ts:7556`：漏 `RGBA_HALF_FLOAT`、多了 `RGBA`、`BGR_PACKED`/`BGRA_PACKED` 值写错 | 这是**遗留欠账**（与 E6 无关，必修）；E6 的增强超集（`RGBA_FLOAT`/`R32F`…）另走 `Context3DNative`，见 §6.1 三层 |
| **渲染接缝 `IRenderer`** | `asaot3d/seam/asaot/three/IRenderer.as`：`render(scene,camera)` + `setSize(w,h)` 两个窄接口 | E6 的引擎侧落点就是第二个实现：`NativeShaderRenderer` |
| **`AGALRenderer`**（默认后端） | `asaot3d/seam/asaot/three/AGALRenderer.as`，机器生成 AGAL 的 PBR（GGX/IBL/阴影/tone map） | 保真对照物 + 复杂负载的兜底；E6 不与它抢默认，是 opt-in 的旁路 |
| **E6 已在设计文档占位** | `three-api-design.md` §9 表格：`NativeShaderRenderer`，绕过 AGAL，E6 opt-in 后续 | 接口形状已定，缺实现 |
| **E6 已在增强清单登记** | `enhancements.md` §3 表 / `TODO.md` `### 增强待做`：成本「中」 | 本文把状态从「未排期」推进到「进行中」——**现为「进行中」**（阶段三百五十三，通路已真机验收，余项见 §9/§11） |

---

## 3. 判定：这是「增强」，不是「遗留欠账」

按 [`enhancements.md`](enhancements.md) §1.2 五条判定，E6 **全中**：

| # | 标准 | E6 的对应 |
|---|---|---|
| a | 落在 AIR 语义之外 | `adl` 的 `Context3D` **从来没有**浮点 RT / MRT / `texelFetch` / 原生 shader 提交 API。同一份 `.as` 在 `adl` 下要么报错、要么压根没有这个 API 形状 |
| b | 绝不静默 | AIR 侧（adl）不支持时**如实报明**，不给「看着成功、实际黑屏」的降级 |
| c | 跨端差异显式列出 | §9：**AOT-only**，AIR 侧黑屏或给 AGAL 降级版，文档与运行时报错都说清 |
| d | opt-in 且不膨胀默认 | 走具名开关 `--features native-shader`；默认构建**不链** glslang/SPIRV-Cross（那两个静态库合计 MB 级，见 §6.3） |
| e | 过 DoD | §12：`examples/*.as` + 断言回归 + 文档 + 版本递增 |

**关键区分**（不能混淆的两件事）：

- 「**adl 能跑对、我们跑不出**」⇒ 那是**遗留欠账**，进 `TODO.md` 的 `### 遗留待开发`。
- 「**adl 本来就报错 / 压根没这 API**」⇒ 才是**增强**，进 `### 增强待做`。

E6 属于后者：Adobe 的 Stage3D 从设计上就**没有**浮点渲染目标与原生 shader 直通，这不是我们的实现缺一块，
是 AIR 的能力边界。所以 E6 落地是**增益**，不是补平。

---

## 4. 源语言选型：GLSL ES 3.00，MSL 只当目标

### 4.1 行业事实（Flutter / Unity / Godot / Web 用什么）

| 平台 / 引擎 | 源语言（作者手写） | 落到各后端的机制 |
|---|---|---|
| **Unity** | **HLSL**（ShaderLab 包裹） | HLSL → GLSL / MSL / SPIR-V（自家交叉编译链） |
| **Flutter (Impeller)** | **GLSL / SkSL** | glslang（GLSL→SPIR-V）+ SPIRV-Cross（SPIR-V→MSL/SPIR-V） |
| **Godot 4** | **GLSL 方言** | 同一条 SPIRV-Cross 链到 GLSL/HLSL/MSL/SPIR-V |
| **Web (WebGL2)** | **GLSL ES 3.00** | WebGL 唯一语言，天然直跑 |
| 桌面原生 | — | Metal=MSL、D3D12=HLSL、Vulkan=SPIR-V、GL=GLSL |

规律一致：**没人拿 MSL 当「源语言」。** MSL 是 Metal 的「目标语言」，是交叉编译链的**终点**，不是起点。

### 4.2 为什么是 GLSL ES 3.00 而不是 MSL

1. **MSL 是 Apple 单厂商语言，当源 = 自绝于跨平台。** Android(Vulkan/GLES)、Windows(D3D)、Web 都得写
   「MSL → X」编译器，而 MSL 作为输入**没有成熟工具链**（SPIRV-Cross 是 SPIR-V 进、MSL 出，反过来没人做）。
2. **GLSL 是最大公约数源头**：GLSL → SPIR-V → {MSL / HLSL / GLSL / SPIR-V} 四个方向都有 Khronos 官方工具。
3. **Ultra-Water 本来就是 GLSL3**：十几条 shader 直接抄，零重写成本——这是决定性的一票。
4. **Web 后端免费**：我们 `--target wasm`(emcc) 走 WebGL2，原生吃 GLSL ES 3.00，这一路**零交叉编译**。

### 4.3 为什么是 ES 3.00 而不是 ES 1.00

现有 AGAL 翻译器的 GLSL 档**自阶段三百五十七起输出 ES 3.00**（`#version 300 es` + `in`/`out`/`texture`，
之前是 ES 1.00，原因见 [`display3d.md`](display3d.md) §3）。但 E6 需要的还有一批 ES 3.00 独有特性，
AGAL 的强类型寄存器模型表达不了：

| 特性 | ES 1.00 | ES 3.00 | Ultra-Water 依赖 |
|---|---|---|---|
| `texelFetch` | 无 | 有 | `OceanSim.js` FFT 索引、`UnderwaterPass.js`、`WaterQuery.js` |
| 整数类型 `uint`/位运算 | 无 | 有 | PCG 哈希、FFT 索引 |
| 显式 `textureLod` | 无 | 有 | `OceanSurface.js` 顶点 band-limited 位移、caustics、大气 LUT |
| `layout(location=N) out`（MRT） | 无 | 有 | `OceanSim.js` 每级 FFT 一 draw 写两 RT |
| `gl_InstanceID` | 无（`runtime.ts` 为此**响亮拒绝**） | 有 | `terrain.js` 实例化 |
| 顶点纹理采样（vertex texture fetch） | 可选扩展 | 核心 | `OceanSurface.js` 顶点 `textureLod` 位移 |
| `sampler2DShadow`（阴影比较） | 无 | 有 | `OceanSurface.js`、`UnderwaterPass.js` 阴影 |

所以 E6 的源语言**必须**是 ES 3.00，不能复用 AGAL→GLSL 的产物（那一档虽然也是 ES 3.00，但它是**十六进制
字节码**的翻译器，作者写的 GLSL 根本进不去）。

---

## 5. 交叉编译链：glslang + SPIRV-Cross（链接 C 库，不是 npm 依赖）

### 5.1 链的构成

```
GLSL ES 3.00 (作者手写)
      │  glslang（Khronos）
      ▼
    SPIR-V（中间表示）
      │  SPIRV-Cross（Khronos）
      ├──────────────┬──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
    MSL           HLSL          GLSL(ES3)      SPIR-V
 (Metal)       (D3D12)        (WebGL2 直通)   (Vulkan)
```

### 5.2 为什么这是对的（纠正一条常见误读）

§3.1 的「零第三方依赖」**只禁 `package.json` 的 npm/TS 依赖**，**不禁** §2.9 的「链接 C 库」——skia、
SDL、libcurl 都是这么进来的。glslang 与 SPIRV-Cross 都是 **Apache-2.0** 的 Khronos 官方库，作为 C/C++
静态库链接，完全合规。**不需要自研交叉编译器**——那才是真正要命的工作量，而这条路 Flutter Impeller
已经在生产里跑通了。

### 5.3 落到我们各后端的映射

| 后端 | 源 | 编译链 | 产物 | 新增依赖 |
|---|---|---|---|---|
| **Metal (macOS/iOS)** | GLSL ES 3.00 | glslang → SPIR-V → SPIRV-Cross → **MSL** | MSL 字符串 → `id<MTLLibrary>`（复用现有 `newLibraryWithSource:`） | glslang + SPIRV-Cross |
| **D3D12 (Windows)** | GLSL ES 3.00 | 同链 → **HLSL** | HLSL → `D3DCompile`（复用现有） | 同链 |
| **Vulkan / GL**（未来） | GLSL ES 3.00 | 同链 → SPIR-V / GLSL | 直接 | 同链 |
| **Web (WASM+emcc)** | GLSL ES 3.00 | **直通**（WebGL2 原生） | 原样提交 `compileShader` | **零** |

> **Web 是第一个免费点**：`vendor/stage3d_webgl.cc` 已固定在 `-s MAX_WEBGL_VERSION=2`，WebGL2 同时接受
> ES 1.00 与 ES 3.00 源码，所以原生 shader 在 web 上**不需要** glslang/SPIRV-Cross，直接把作者源码交给
> `compileShader` 即可。唯一要补的是浮点 RT 的 WebGL2 扩展启用（`EXT_color_buffer_float` /
> `EXT_color_buffer_half_float`）。

### 5.4 编译时机：运行时（对齐 three.js）

three.js 的 `ShaderMaterial` 是**运行时**编译：作者源码在 AS3 里是字符串字面量 → 编译进 C 的字符串常量 →
运行期交给后端编译。E6 同形：**glslang + SPIRV-Cross 作为运行时库链进产物**，第一次用到某条 shader 时
交叉编译并缓存（与现有 `AGALTranslator` 的程序缓存同思路，[`display3d.md`](display3d.md) §9.11）。

> 备选（build-time 预编译成 MSL/HLSL 字符串再内嵌）在「作者 shader 是静态常量」的场景更省运行时体积，
> 但与 three.js 的「uniform/define 动态拼接 shader chunk」模型冲突，故**主路定为运行时**，build-time 作为
> 后续 PGO 型优化再评估。

---

## 6. 编译器侧（as3compiler）要动的清单

编译器侧是「管道」，把原生 shader 提交 + 浮点 RT + MRT 这些底层能力暴露成 AS3 API，并接到三份胶水。

### 6.1 纹理格式全景（三层：AIR 对齐 → E6 增强 → 三端映射）

原版 §6.1 只列了「为 Ultra-Water 挑的几个浮点格式」，既漏了 AIR 已有的、也没说清哪些是**欠账**、哪些是
**增强**。核实 AIR 官方 `Context3DTextureFormat` 权威全集
（[airsdk.dev](https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3DTextureFormat.html)）后，
格式这件事必须拆成**三层**，否则会把「遗留欠账」和「E6 增强」混在一张表里。

#### 层 1 —— AIR 对齐层（遗留欠账，与 E6 无关，必修）

AIR 官方全集是 **6 个常量**。我们 `src/symbols.ts:7556` 的现状有 **4 处偏差**：

| 常量 | AIR 权威值（Runtime） | 我们 `symbols.ts:7556` | 判定 |
|---|---|---|---|
| `BGRA` | `"bgra"`（AIR 3） | `"bgra"` | ✅ |
| `BGR_PACKED` | `"bgrPacked565"`（AIR 3.7） | `"bgrPacked"` | ❌ 值错（少了 `565`） |
| `BGRA_PACKED` | `"bgraPacked4444"`（AIR 3.7） | `"bgraPacked"` | ❌ 值错（少了 `4444`） |
| `COMPRESSED` | `"compressed"`（AIR 3） | `"compressed"` | ✅ |
| `COMPRESSED_ALPHA` | `"compressedAlpha"`（AIR 3.4） | `"compressedAlpha"` | ✅ |
| `RGBA_HALF_FLOAT` | `"rgbaHalfFloat"`（AIR 14） | **缺失** | ❌ 漏了 |
| （AIR 无此常量） | — | `RGBA: "rgba"` | ❌ 多了 |

这 4 处是「`adl` 跑得对、我们跑错/跑不出」⇒ 按 §1.5 是**遗留欠账**，进 `TODO.md` `### 遗留待开发`，与 E6
**无关、必修**。配套的 C 运行时同样残缺：`emit.ts` 的 `Texture_uploadFromByteArray` 只认 `"bgra"`/`"rgba"`，
其余格式直接 `as_shell_unsupported`。`RGBA_HALF_FLOAT` 的缺失此前已在 TODO 登记过（阶段二百二十六），
本表把其余三处（多了 `RGBA`、两个 packed 值错）一起补全。

#### 层 2 —— E6 增强层（AIR 超集，opt-in，走 `Context3DNative`）

**先纠正一个归属错误**：Ultra-Water 大量使用的 `RGBA16F`（`RGBAFormat` + `HalfFloatType`，HDR 管线主力）
就是 AIR 14 已有的 `RGBA_HALF_FLOAT`（层 1），**不是 E6 增强**——它的缺失是遗留欠账，修层 1 即可。
E6 的层 2 只新增 AIR **没有**的格式：全精度浮点、非四通道半浮点、整数、SNORM、深度/模板。

下面是 GLSL ES 3.00 的**完整可渲染纹理格式面**，按「通道 × 精度」系统化。`★` = Ultra-Water 实际用到，
未标 `★` 的是 E6 作为完整能力面应一并支持、但 Ultra-Water 没碰到的。

**(a) 浮点格式**（color-renderable 需运行时扩展）：

| 格式 | 通道 × 精度 | Metal `MTLPixelFormat` | WebGL2（扩展） | D3D12 `DXGI_FORMAT` | Ultra-Water |
|---|---|---|---|---|---|
| `RGBA_FLOAT` | RGBA32F | `RGBA32Float` | `EXT_color_buffer_float` | `R32G32B32A32_FLOAT` | ★ OceanSim FFT 输出 / WaterQuery |
| `R32F` | R32F | `R32Float` | `EXT_color_buffer_float` | `R32_FLOAT` | ★ caustics / shoreMap / terrain / floaterShadow |
| `RG32F` | RG32F | `RG32Float` | `EXT_color_buffer_float` | `R32G32_FLOAT` | —（能力面） |
| `R16F` | R16F | `R16Float` | `EXT_color_buffer_half_float` | `R16_FLOAT` | —（能力面） |
| `RG16F` | RG16F | `RG16Float` | `EXT_color_buffer_half_float` | `R16G16_FLOAT` | ★ caustics（位移 + 斜率双分量） |
| `R11G11B10F` | RGB10F | `RG11B10Float` | `EXT_color_buffer_float` | `R11G11B10_FLOAT` | —（能力面，低开销 HDR 颜色） |
| `R8` | R8 UNorm | `R8Unorm` | `R8`（核心，无需扩展） | `R8_UNORM` | —（能力面，单通道打包） |

> 注意：`RGBA16F`（= `RGBA_HALF_FLOAT`）**不在此表**——它在层 1，AIR 14 已有。全精度 `RGBA_FLOAT` 才在
> 层 2，AIR 没有。二者常被混为一谈，这里显式分开。

**(b) 整数格式**（`uint`/`int` 类型 + `texelFetch` 整数索引需要；Ultra-Water 的 PCG 哈希虽在 shader 内算、
输出到浮点 RT，但 E6 作为完整能力面应支持整数纹理）：

| 格式 | Metal | WebGL2 | D3D12 |
|---|---|---|---|
| `R8I` / `R8UI` | `R8Sint` / `R8Uint` | `R8I` / `R8UI` | `R8_SINT` / `R8_UINT` |
| `R16I` / `R16UI` | `R16Sint` / `R16Uint` | `R16I` / `R16UI` | `R16_SINT` / `R16_UINT` |
| `R32I` / `R32UI` | `R32Sint` / `R32Uint` | `R32I` / `R32UI` | `R32_SINT` / `R32_UINT` |
| `RG32I` / `RG32UI` / `RGBA32I` / `RGBA32UI` | 对应 `Sint`/`Uint` | 对应 | 对应 |

**(c) 规范化整数（SNORM）**（`-1..1` 定点，比 `UNORM` 少一档精度损失；能力面，可选）：

| 格式 | Metal | WebGL2 | D3D12 |
|---|---|---|---|
| `R8_SNORM` / `RG8_SNORM` / `RGBA8_SNORM` | `R8Snorm` / `RG8Snorm` / `RGBA8Snorm` | 同名 | `R8_SNORM` / `R8G8_SNORM` / `R8G8B8A8_SNORM` |
| `R16_SNORM` / `RG16_SNORM` / `RGBA16_SNORM` | `R16Snorm` / `RG16Snorm` / `RGBA16Snorm` | 同名 | `R16_SNORM` / `R16G16_SNORM` / `R16G16B16A16_SNORM` |

**(d) 深度 / 模板格式**（深度纹理 + 阴影比较采样，§6.4；Ultra-Water 用 `FloatType` 深度即 `DEPTH_COMPONENT32F`）：

| 格式 | Metal | WebGL2 | D3D12 | Ultra-Water |
|---|---|---|---|---|
| `DEPTH_COMPONENT16` / `24` / `32F` | `Depth16Unorm` /（无 24）/ `Depth32Float` | `DEPTH_COMPONENT16` / `24` / `32F` | `D16_UNORM` / `D24_UNORM_S8_UINT` / `D32_FLOAT` | ★ `32F`（main.js:117 / floaterShadow.js:22） |
| `DEPTH24_STENCIL8` / `DEPTH32F_STENCIL8` | `Depth24Unorm_Stencil8` / `Depth32Float_Stencil8` | `DEPTH24_STENCIL8` / `DEPTH32F_STENCIL8` | `D24_UNORM_S8_UINT` / `D32_FLOAT_S8X24_UINT` | —（能力面） |

> **建模提醒**：这里「格式面」分两层能力——「可渲染」（当 RT 附件）+「可采样」（当纹理绑到 shader）。
> GLES 3.0 里不是所有格式两者都行（如整数格式可渲染但只能用整数采样器采），三端胶水要按 WebGL2 的
> `color-renderable` / `texture-filterable` 两张表分别放行，不能只查「格式名存在」。

#### 层 3 —— 三端映射层

层 1 + 层 2 的**全集**要落到三份胶水里（`vendor/stage3d_glue.mm` 的 `MTLPixelFormat` 选择、
`vendor/stage3d_d3d.cc` 的 `DXGI_FORMAT` 选择、`stage3d_webgl.cc` 的 `internalformat`），而不是像现在三端
都只建 `BGRA8`。上面 (a)~(d) 四张表的 Metal/WebGL2/D3D12 列合起来就是这张映射的清单。

**建模要点**（与 §7.5 拍板的「方案 B」一致）：层 1 是**修正**（把 `Context3DTextureFormat` 本身对齐到 AIR
六常量），层 2 的增强格式**不能**塞进 `Context3DTextureFormat`——那会让默认产物比 AIR 多出 AIR 没有的常量，
破坏 §1.5「默认产物与 AIR 同构」。因此：

- **(A) 条件符号 —— 与「运行时探测」路线不兼容，弃用。** `Context3DTextureFormat.RGBA_FLOAT` 是**常量引用**，
  而 AS3 没有「常量是否存在」的运行时探测（`describeType` 能查，但依赖 XML/E4X，项目已延后，见 TODO.md
  阶段八十六）。作者要么硬写（AIR 运行抛 `#1065`）、要么无法探测——做不到优雅降级。
- **(B) 新类 `Context3DNative` —— 采纳。** 层 2 的浮点/深度格式、MRT（§6.2）、原生 shader 提交（§6.3）、
  深度纹理（§6.4）**全部**收进这一个 AOT-only 新类，作者用 `getDefinitionByName` 探测它是否存在（§7.4 同款
  工厂模式）。`Context3DTextureFormat` 本身只做**层 1 的对齐**（对齐后仍是 AIR 六常量，不多不少）。

### 6.2 渲染目标：MRT（第二个洞）

现有 MRT（`fo0..fo3`）**只有 HLSL 档**实现（[`display3d.md`](display3d.md) §3 明说 MSL/GLSL 两档折叠成单一
输出）。E6 的原生 shader 路径要**三档都**支持 `layout(location=N) out`（OceanSim.js FFT 每级「一个 pass
写两个 RT」的直接依赖）。完整语义包括：

**a. 附件数量上限**（三端不一致，须运行时查询）：

- Metal：`MTLFeatureSet` 无固定上限（现代硬件 ≥ 8）。
- WebGL2：**规范保证 ≥ 4**（`MAX_DRAW_BUFFERS`），超出需查询；Ultra-Water 用 2（`location=0/1`），安全。
- D3D12：`SV_Target0..7`（≥ 8）。

**b. 各附件独立 blend**：ES 3.00 支持逐附件混合状态（`glBlendEquationi` / `glBlendFunci`），Metal 是
`MTLRenderPipelineColorAttachmentDescriptor` 逐附件配、D3D12 是 `D3D12_BLEND_DESC` 的 `RenderTarget[N]`。
E6 提交 MRT 时要**逐附件**传 blend，不能只给一个全局 blend。

**c. WebGL2 的格式一致性硬约束**（最易踩的坑）：WebGL2 规范要求 MRT 所有 color attachment **格式必须一致**
（不只是尺寸一致）；宽高也必须一致。Metal/D3D 无此限制（可异格式 MRT）。Ultra-Water 的 FFT 两级
`out0`/`out1` 写的格式**相同**（同一 cascade 的位移/斜率分量），所以三端都成立；但 E6 作为通用能力要把
这条差异显式登记，不能让作者以为「任意两种浮点格式都能混在一个 MRT 里」。

**d. 附件格式可渲染性**：每个附件格式都必须 color-renderable（§6.1 层 2 的「建模提醒」），整数格式附件
不能用浮点采样器读、浮点附件不能用整数采样器读，shader 的 `out` 类型必须与附件格式匹配。

**e. 折叠到单输出的降级**：MSL/GLSL 两档现有实现把 `fo0..fo3` 折叠成单一输出——E6 之前的 AGAL 路径保持
这个行为；E6 原生路径**不再折叠**，`layout(location=N)` 直接映射到多附件。

### 6.3 原生 shader 提交 API（核心新增）

现在 `Program3D.upload()` 收 AGAL 字节码。E6 加一条收**源码**的入口，**归入 §6.1 方案 B 的
`Context3DNative`**（新类，可被 `getDefinitionByName` 探测，探测模式见 §7.4）。

它内部走与 `as_agal_translate` 平行的一条路径：
`GLSL ES 3.00 源码 →（native）glslang+SPIRV-Cross → MSL/HLSL → 胶水编译；→（web）直通 compileShader`。

**完整的 API 面**（不只是「提交源码」一件事，还差这些，否则 shader 跑不起来）：

**a. 程序生命周期 + 错误日志**：`uploadProgram(vertexSource, fragmentSource)` 之后要有 `link()` 与
**编译/链接错误日志**（`getProgramInfoLog` / `getShaderInfoLog` 的等价物）。GLSL ES 3.00 语法严格，作者
第一次写几乎必报错，拿不到 info log 等于「盲调」。错误日志必须回抛到 AS3 侧（`Error` + 日志原文），
不能吞进 C 层。

**b. uniform 绑定**：three.js `ShaderMaterial` 的 `uniforms` 要映射到 GLSL uniform。三类：

- 标量/向量/矩阵（`float/int/bool` 及 `vec*`/`mat*`）：直接 `setUniform`。
- 采样器（`sampler2D`/`samplerCube`/`sampler2DShadow`…）：绑定**纹理单元号**（`setUniform1i` 到 texture unit），
  纹理对象单独 `bindTexture(unit, texture)`。
- uniform 数组（`uImpact[8]`，OceanSurface.js）：逐元素 set，不能只 set 单个。

**c. 顶点属性布局**：GLSL ES 3.00 用 `layout(location=N) in` 或运行时 `bindAttribLocation`。E6 要暴露
「属性名/位置 → 顶点缓冲 + 步长 + 偏移」的绑定（对应 three.js `BufferGeometry` 的 attribute）。与 AGAL 的
`va0..va7` 寄存器不同，原生 shader 的属性位置是**作者源码里声明的**，E6 不能假设固定的寄存器编号。

**d. uniform buffer object（UBO，可选）**：ES 3.00 支持 `layout(std140) uniform`，把大量 uniform 打包成
一块 buffer。Ultra-Water 没用（它 uniform 少），但 E6 作为完整能力面应支持，否则未来 shader 遇到
「uniform 超上限」时无路可走。

**e. 程序缓存**：交叉编译 + 后端编译有开销，第一次编译后按「vertexSource + fragmentSource + defines
哈希」缓存程序对象，复用现有 `AGALTranslator` 程序缓存思路（[`display3d.md`](display3d.md) §9.11）。

示意（补全版，非最终 API 形状，§12 待拍板）：

```as3
var nat:Object = RendererFactory.nativeContext();   // 内部 getDefinitionByName + try/catch，§7.4
if (nat != null) {
    var prog:Object = nat.uploadProgram(vertexSource, fragmentSource);  // 编译 + 链接
    if (nat.hasError(prog)) throw new Error(nat.getInfoLog(prog));      // 错误日志回抛
    nat.bindAttribute(prog, "position", vbo, stride, offset);           // 顶点布局
    nat.setUniform1i(prog, "uDisp0", 0);  nat.bindTexture(0, dispTex);  // 采样器
    nat.setUniform4fv(prog, "uImpact", impactArray);                    // uniform 数组
    nat.draw(prog, triCount);                                           // draw
}
```

**as-built 的 `Context3DNative` 方法面**（阶段三百五十三 + 三百五十五，`src/symbols.ts`）：

| 方法 | 用途 | 来源 |
|---|---|---|
| `uploadProgram(vs, fs)` / `dispose` | 交叉编译 + 链接（运行期，`newLibraryWithSource:`） | M2 |
| `setUniform1f` … `setUniform4f` | ≤4 个 float 分量 | M2 |
| `setUniformFloats(prog, name, Vector.<Number>)` | **>4** 个 float 字（`vec4 uSpecA[2]` 是 8 个字） | M3 |
| `setUniformInts(prog, name, Vector.<int>)` | `int`/`uint`/`bool`（**不能**用 float 入口，见 §6.9 #3） | M3 |
| `setUniformMatrix4` | 16 字矩阵 | M2 |
| `createTexture(w, h, format, renderable, mipmapped = false)` | 11 个格式 id；`renderable` = 可做渲染目标 | M2 / M3（`mipmapped`） |
| `createDepthTexture(w, h, format)` | `DEPTH_32F` / `DEPTH_16`（只作附件，见 §6.4f） | M3 |
| `generateMipmaps(tex)` | Metal blit 编码器生成 mip 链 | M3 |
| `setRenderTargets(colors, depth)` / `setBackBuffer()` | MRT；**空目标集非法**（§6.9 #4） | M2 |
| `setRenderTargetSamples(tex, samples)` | 给**单个**离屏目标挂一张 multisample companion（`1/2/4/8`；返回是否真的生效，见 §6.10） | M34 |
| `bindTexture(prog, name, tex)` / `bindAttribute(...)` / `drawTriangles(...)` | 绑定与绘制 | M2 |

`NativeProgram3D` 暴露反射结果：`uniformNames` / `bindingNames` +（M3 新增）`bindingComponents`、
`bindingBaseTypes`、`bindingSizes`。引擎侧按这三张表决定走哪个上传入口——这是 #3 那条缺陷的修法，
不是可选的便利。

### 6.4 深度纹理

`OceanSurface.js` 的 depth-validated 折射（`main.js:117` 的 `uSceneDepth`）要采样场景深度纹理。Stage3D 无
深度纹理读回。E6 补全，完整语义包括：

**a. 深度格式 + 绑定**：`createTexture(DEPTH_COMPONENT16/24/32F)` + 作为 depth attachment 绑定（§6.1 层 2
(d) 表）。Metal `Depth32Float` / WebGL2 `DEPTH_COMPONENT*` / D3D12 `D32_FLOAT`。

**b. 深度纹理采样值语义**：采样深度纹理得到的是**非归一化深度**（ndc `z ∈ [0,1]`），要用
`linearDepth(z, near, far)` 反解回视图空间距离——OceanSurface.js:414 的 `linearDepth(textureLod(...).r)`
正是这个。E6 不能直接把采样值当「距离」用，要暴露 near/far 到 uniform。

**c. 深度比较采样 `sampler2DShadow`**（阴影映射需要，Ultra-Water 两处用）：OceanSurface.js:271、
UnderwaterPass.js:17 声明 `precision highp sampler2DShadow`，配合 `uShadowMap`（main.js:401 的
`sunLight.shadow.map.depthTexture`）。这是 ES 3.00 专属：比较采样在**采样时**做 `depth <= ref` 的硬件比较，
返回 0/1，替代 ES 1.00 的 `texture2DProj` 手动比较。Metal 对应 `MipmapFilter` + `CompareFunction`、D3D12
对应 `D3D12_COMPARISON_FUNC`，都要在纹理采样器状态里配。

**d. 深度 + 颜色同绑定的 framebuffer**：`main.js:116-117` 的 HDR RT 同时挂 color attachment（`RGBA16F`）
和 depth attachment（`DepthTexture`），渲染后 color 和 depth 都能被后续 pass 采样。E6 的 `Context3DNative`
要支持「一个 RT 同时产出可采样的颜色 + 深度」——这是 depth-validated 折射、阴影、SSR 的共同底座。

**e. 深度纹理的采样器区分**：深度纹理必须用 `sampler2D`（浮点读）或 `sampler2DShadow`（比较读）采样，
WebGL2 里深度纹理的 `texture-filterable` 有限制、Metal/D3D 也有对应约束，不能用普通颜色纹理的采样方式
直接对待。

**f. 真机结论（M3 补验，2026-11-02）——深度只当附件，别当采样器**：SPIRV-Cross 把 GLSL 的 `sampler2D`
静态映射成 `texture2d<float>`，它**不知道**绑定的是深度资源；Metal 里深度纹理是 `depth2d<float>`，
两个类型对不上，于是采样恒读 0（不报错，只是全黑）。所以：

- 现阶段的契约是**深度纹理 = 渲染附件**（遮挡/消隐正确），`sampler2D` 读深度**不支持**；
- 要读线性深度就把深度写进一张彩色浮点 RT（`oDepth = vec4(viewZ)`），这条在 M3 已验；
- 真要做比较采样（阴影）必须让作者显式写 `sampler2DShadow`，并在绑定时把 sampler 配上
  `CompareFunction`——那是后续阶段的事，不在当前通道里。

**g. 深度附件与模板槽必须同时清空**：金属校验会直接拒掉「`depthAttachmentPixelFormat` 是
`Depth32Float`、`stencilAttachmentPixelFormat` 还是默认值」的管线描述子
（`stencilAttachmentPixelFormat MTLPixelFormatDepth32Float is not stencil renderable`）。反之，
管线过了但 render pass 仍给 `stencilAttachment.texture` 赋值，Metal 会把**整条深度附件**静默忽略：
几何遮挡失效、画面看起来「深度没起作用」。`s3d_pass` 现在按「深度纹理的像素格式是不是打包的
`Depth32Float_Stencil8`」双向对齐，只在打包格式时才挂 stencil。

### 6.5 构建层（build.ts + build-tools）

1. **glslang + SPIRV-Cross 入 `build-tools/`**（与 `skia-src/`、`emsdk/` 同层），编出 native 静态库。
2. **注册具名开关**：`--features native-shader` → `ASC_USE_NATIVE_SHADER=1`，加入 `build.ts` 的 FEATURES
   注册表（[`enhancements.md`](enhancements.md) §1.4）。**可用目标**：native（Metal/D3D）+ web（透传）；
   **AIR 不支持**（§9）。
3. **清单字段**：`link-libs`/`link-paths` 增 glslang/SPIRV-Cross 的路径（native only）；web 目标**不链**
   （透传零依赖）。
4. **横幅点名**：开启时构建横幅 `== enhancements: native-shader (-D ASC_USE_NATIVE_SHADER=1) ==`，
   并明说这是 AIR 超集（[`enhancements.md`](enhancements.md) §1.4 的固定动作）。

### 6.6 运行时胶水（vendor/stage3d_*.cc）

- **Metal（第一批）**：`stage3d_glue.mm` 增 float RT 的 `MTLPixelFormat` 分支、MRT 多 color attachment、
  深度纹理、`[[instance_id]]`（已有，AGAL `iid` 就在用）；新增「原生 MSL 直接编译」入口（绕过 AGAL 翻译，
  直接把 SPIRV-Cross 产出的 MSL 喂给 `newLibraryWithSource:`）。
- **WebGL2（第二个免费点）**：`stage3d_webgl.cc` 增 `EXT_color_buffer_float` / `EXT_color_buffer_half_float`
  启用与查询；原生 shader 直通 `compileShader`（无交叉编译）。
- **D3D12（第三批）**：`stage3d_d3d.cc` 增 float `DXGI_FORMAT`、MRT（已有 `SV_TargetN`）、原生 HLSL 编译入口。

> **注意：`ASC_AGAL_TARGET` 与 E6 是两套东西。** `ASC_AGAL_TARGET` 选的是「AGAL 翻译到哪个目标语言」，
> E6 选的是「原生 GLSL ES 3.00 交叉编译到哪个目标语言」。二者**目标语言集合相同**（MSL/GLSL/HLSL），
> 但**源语言不同**（AGAL vs GLSL ES 3.00）。不要混在一个宏里。

### 6.7 运行时探测的编译面可达性（关键前置）

§7.4 拍板「运行时探测」，但 `getDefinitionByName` 在 as-aot 的实现（`emit.ts:3170` 的
`as_class_registry[]`）**只收进了编译面的类**；而 `getDefinitionByName("…NativeShaderRenderer")` 的参数是
**字符串字面量**，不在 `reach.ts` 的 AST 引用边里 ⇒ `--features native-shader` 开了，这个类也**进不了编译面**，
注册表里没有，探测照样抛 `#1065`。这与 `AGALTranslator` 的先例**本质不同**——后者是 as-aot 内建类，常驻编译面。

**已拍板（§12 ⑤）：选方案 2**——构建清单字段 `extra-roots: ["asaot.three.NativeShaderRenderer"]`
（+ CLI `--extra-roots a.b.C,d.E`，因为 `--air-app` 每次重写 `<Main>.build.json`，只存在于清单里的字段
在构建脚本里用不了）。不用 `[WasmExport]`：那个注解会被迫兼管两件事（JS 导出 / 闭包根），语义不单一。

as-built：`computeReachable(parsedFiles, mainClass, [...swcBaseRoots, ...cfg.extraRoots])`；只把名字塞进
根集合、**不解析路径**；去重；同名类不存在时**忽略不报错**（清单要能跨构建复用）。实测：`shader-m30` 的
`extra-roots` 文件里那一行确实把 `NativeShaderRenderer` 拉进闭包（65/123 sources）；单元组 `unit: reach/*`
三条断言（复活一个无引用类 / 只复活它自己 / 未声明类名被忽略）钉住。

### 6.8 着色器语言特性补齐（AGAL 表达不了、原生路径天然支持）

§4.3 列了 ES 3.00 独有特性，但没落到「功能」层面。这些是 GLSL ES 3.00 有、AGAL 没有、Ultra-Water 实际
用到的语言特性，E6 原生路径**天然支持**（直接把作者 GLSL ES 3.00 源码交给后端），但要在文档里列全，
避免「以为支持了、实际漏了」：

| 特性 | Ultra-Water 出处 | AGAL | E6 原生路径 |
|---|---|---|---|
| **实例化**（`gl_InstanceID` / `instanceMatrix`） | terrain.js:256 `InstancedMesh`、terrain.js:170/175 `instanceMatrix` | 无（GLSL 档对 `iid` 响亮拒绝：`gl_InstanceID` 是 `int`，AGAL 的 `iid` 是 `float4` 广播，GL 侧尚未接） | Metal `[[instance_id]]`（已有）、WebGL2 原生、D3D12 `SV_InstanceID` |
| **顶点纹理采样**（vertex texture fetch） | OceanSurface.js:223-225 顶点里 `textureLod` 位移 | 有（AGAL4 `tld` → `textureLod`，顶点阶段） | ES 3.00 核心特性，三端原生 |
| **阴影比较采样** `sampler2DShadow` | OceanSurface.js:271、UnderwaterPass.js:17 | 无（AGAL 没有比较采样器：只能 `texture()` 后手写比较） | §6.4(c) |
| **整数类型 + 位运算** `uint`/`uvec2`/`^`/`>>` | OceanSim.js:38/41/51 PCG 哈希 | 无（AGAL 无整数） | ES 3.00 核心，三端原生 |
| **整数坐标采样** `texelFetch` | OceanSim.js:132/163/164、UnderwaterPass.js:127 | 无（只有归一化 `tex`） | ES 3.00 核心 |
| **显式 LOD** `textureLod` | 遍布 OceanSurface/Caustics/atmosphere/UnderwaterPass | 无（`tex` 隐式 LOD） | ES 3.00 核心 |
| **立方体贴图** `samplerCube` | OceanSurface.js:278、UnderwaterPass.js:101 | 有（M25 已做 cube map） | 已有，无需新增 |

**注意顶点纹理采样的精度坑**：ES 3.00 里顶点纹理采样的 LOD 是**恒定 LOD**（`textureLod` 显式指定），
OceanSurface.js 正是用 `textureLod(uDisp0, xz/uLength.x, max(lod.x,0.0))` 显式 LOD 做 band-limited 位移。
Metal/D3D 的顶点阶段采样无此限制，但 WebGL2 有 `MAX_VERTEX_TEXTURE_IMAGE_UNITS`（≥ 16）要查询，且顶点
采样不参与 mipmap 自动选择（必须显式 LOD）——这与片元采样语义不同，E6 不能把片元采样器的状态照搬到
顶点采样器。

**结论**：E6 的价值不只是「换掉 AGAL」，而是**解锁这 7 类 AGAL 表达不了的语言特性**。它们不需要新的
后端 API（底层 GPU 都有），只需要 E6 的「GLSL ES 3.00 直通」把它们从「AGAL 死规范」里放出来。

### 6.9 通道约束清单（M3 + FFT 海洋实测倒推，2026-11-02）

这五条都不是「没实现」而是「这么写就错」——都由 `apps/shader-m31` / `apps/ocean-m32` 的实际崩溃或
静默黑屏逼出来，写进契约，别再踩：

| # | 约束 | 症状（看到的） | 正确写法 |
|---|---|---|---|
| 1 | **顶点属性必须给 `layout(location = N)`** | `MSL(vertex) compile failed: invalid type 'vs_main_in' of input declaration with attribute 'stage_in'` / `field with missing attribute 'attribute'` | `layout(location = 0) in vec3 aPos;`，按 0..n 连续编号 |
| 2 | **读 `uniform` 的 GLSL 辅助函数不翻译** | `cannot bind reference in address space 'constant' to object in default address space` | 内联；或先把 uniform 抄进局部 `vec3 w = uFoo;` 再传给函数（局部量在 `thread` 地址空间） |
| 3 | **整数 uniform 不能走 `setUniform1f`** | 值 2 传进去，shader 里读到 `1073741824`（`2.0` 的 IEEE 位模式） | `Context3DNative.setUniformInts(program, name, values)`；绑定反射里 `base_type` 决定派发，`components`/`size` 决定是 `setUniform1f..4f` / `setUniformFloats` / `setUniformMatrix4` |
| 4 | **不能给「空」渲染目标集提交绘制** | Metal 绘制中止、进程崩在 `MTLResourceListAddResource` 附近 | 读后台缓冲用 `setBackBuffer()`（或 `setRenderToBackBuffer()`），不要 `setRenderTargets([], null)` |
| 5 | **`drawToBitmapData` 的目标位图可以比后台缓冲小**（本次修的编译器缺陷） | 读回结果对，但**下一帧**崩在 Metal 内部（method cache corrupted），像「Metal 的 bug」 | 拷贝按**目标位图**尺寸裁剪（`min(bb, dest)`）；以前按后台缓冲全量写，64×64 探针写穿 256 KB 堆缓冲 |

第 5 条是 `Context3D.drawToBitmapData` 的**语义缺陷**而不是通道问题：AIR 的 `drawToBitmapData` 要求目标位图
不小于后台缓冲，我们放宽成「重叠区拷、其余保持原值」，但**绝不越界写**。这条缺陷从第一个读回探针起就在，
只是探针紧接着退出、堆损坏没来得及显形——被 34 pass/帧的海洋抓住。

### 6.10 离屏 MSAA：`setRenderTargetSamples`（M34，enhancement）

默认（`ASC_S3D_MSAA`）只多重采样**drawable**；离屏目标在 M10 被钉死 1 采样（D54/D55）。离屏链的
应用（ocean-m34）确实需要边缘抗锯齿，所以 M34 补一个**逐目标**旋钮：

```as3
var ok:Boolean = ctxNative.setRenderTargetSamples(waterTex, 4);   // 1/2/4/8
```

**语义**：为这个目标分配一张同尺寸、同格式的 multisample companion（`dirty` 标记是否还有未解析的
样本）；之后的 pass 如果**所有附件采样数一致**就画进 companion，否则退回 1 采样（不报错、不退性能）；
resolve 是**惰性**的，在「采样绑定 / `bindTexture` / `get_render_target` / `generateMipmaps` / 帧 flush」
五处入口之前做，所以应用读到的永远是单样本目标，不需要知道 companion 存在。

**为什么逐目标而不是全局**：全屏数据 pass（FFT 图集、测光网格、bloom 金字塔）由全屏 quad 覆盖，
每个样本拿到 bit-identical 的值，多采样只多花显存与一次 resolve。**为什么必须连深度一起挂**：
Metal 要求一次 pass 的所有附件采样数相同。**为什么 `generateMipmaps` 要改成编进当前批次**：
以前它自己提交一个 immediate command buffer，MSAA 下会与前面的绘制**乱序**（mip 链从空目标生成）。

**实测判据**（ocean-m34，冻结时间 + 同一相机）：off vs 4x 差 1.58% 像素、均值 0.185，
92.5% 的差异落在强边缘；Breakers 视图 1.12%、硬台阶像素 -1.8%。差异落在平面上就说明挂错了东西。

**边界**：`setRenderTargetSamples` 不改 drawable（那个仍归 `ASC_S3D_MSAA`）；`renderOverride` 的 pass
（阴影 prepass、`drawToBitmapData`）永远 1 采样（D54）；目标重建后 companion 会丢，调用方要重推一次。

---

## 7. AS 侧（asaot3d）要动的清单

AS 侧是「引擎」，把编译器暴露的管道接成 three.js 风格的作者 API。本节先回答文档此前**没说清**的一件事：
这些 AOT-only 的符号，同一份 `.as` 源码交给 `mxmlc`/`adl` 时会怎样？「adl 能编译」和「运行时降级」是
**两个正交问题**，必须分开保证。

### 7.1 两条铁律：编译期可达 ≠ 运行期可达

AS3 编译器区分「编译期可达」和「运行期可达」，且 mxmlc 对「类型位置」和「表达式位置」处理**完全不同**
（`three-api-design.md:2360-2365`）：

| 位置 | 例子 | mxmlc 行为 | 找不到时 |
|---|---|---|---|
| **类型位置** | `var m:ShaderMaterial`、`function f():Context3DNative` | 编译期强制解析到真实定义 | **`#1046` 编译失败** |
| **表达式位置** | `new ShaderMaterial()`、`AGALTranslator.translate(...)` | `strict=false` 下退化成运行时名字链查找 | **`#1065` 运行失败** |

关键：`import` 本身不强制解析类，是**使用点**才强制。所以 `import flash.display3D.AGALTranslator` 能编过，
一旦 `AGALTranslator` 出现在表达式位置，mxmlc non-strict 下不报错、运行时才炸 `#1065`。

**项目已验证的标准解法**就在 `AGALRenderer.as:5596-5611`——静态引用「能编译但运行抛 #1065」，故改成
运行时 `getDefinitionByName` + `try/catch` 探测，缺失即降级：

```as3
private static function translatorClass():Object {
    try { return getDefinitionByName("flash.display3D.AGALTranslator"); }
    catch (e:Error) { return null; }   // AIR 侧没有这个类 → 降级
}
```

### 7.2 三层存在性：E6 新增符号的编译期命运

E6 要新增的东西，编译期命运**各不相同**。按「是否进入 mxmlc 编译面」拆成三层：

| 符号 | 存在性 | mxmlc 编译 | adl 运行 | 隔离手段 |
|---|---|---|---|---|
| `ShaderMaterial` | **双后端共享**（§7.3） | 通过（纯数据，无 AIR 缺失 API） | 能 `new`；`AGALRenderer` 渲染到它时报明 | 不需要隔离 |
| `NativeShaderRenderer` | **AOT-only，opt-in**（§7.4） | 通过（作者不直接 `new`，只走字符串探测） | 探测不到 → 回退 `AGALRenderer` | `getDefinitionByName` + 工厂 |
| `Context3DNative`（浮点格式/MRT/原生 shader/深度纹理） | **AOT-only，opt-in**（§7.5） | 通过（作者只走 `getDefinitionByName`，不让它进类型位置） | 探测不到 → 降级 CPU 路径 | `getDefinitionByName` + 工厂 |

**铁律**：任何 AOT-only 符号**不得**出现在作者代码的**类型位置**（否则 mxmlc 直接 `#1046`）；表达式位置
也只能通过 `getDefinitionByName` 的**字符串**间接引用（否则运行 `#1065` 且无法降级）。

### 7.3 `ShaderMaterial`：双后端共享（已拍板）

`ShaderMaterial` 只继承 `Material`，存 `vertexShader:String`、`fragmentShader:String`、`uniforms:Object`、
`defines:Object`——**这些字段 AS3 全表达得了，没有任何 AIR 缺失的 API**。所以放 `asaot3d` 共享源码，
mxmlc 编译过、AIR 下也能 `new`（类型位置引用也安全）。

```as3
class ShaderMaterial extends Material {
  var vertexShader:String;      // GLSL ES 3.00 源码
  var fragmentShader:String;
  var uniforms:Object;          // { uTime:Number, uDisplacement:Texture, ... }
  var defines:Object;           // 可选：编译期宏，拼进 shader 前导
  // 语义对照 three.js r187 ShaderMaterial（three-src/src/materials/ShaderMaterial.js）
}
```

AIR 下的真正边界在**渲染器**：`AGALRenderer` 遇到 `ShaderMaterial` 时**不认识手写 GLSL**，必须**如实报明**
「AGAL 后端不支持 ShaderMaterial」，而**不能**降级成 `MeshBasicMaterial` 之类——那是错误语义（§0 红线）。
语义对照 `three-api-design.md` §9 表格里 E6 的「three.js `ShaderMaterial` 风格」。

### 7.4 `NativeShaderRenderer` + 工厂：运行时探测（已拍板）

`three-api-design.md` §9 已定接口形状，E6 落地就是第二个 `IRenderer` 实现。但它**不能**被作者直接
`new`——AOT-only 能力类，AIR 下没有。作者只通过一个**双后端共享的工厂**：

```as3
// RendererFactory（双后端共享，mxmlc 也编它）
public static function create(context:Context3D):IRenderer {
    var cls:Class = null;
    try { cls = getDefinitionByName("asaot.three.NativeShaderRenderer") as Class; }
    catch (e:Error) { cls = null; }
    if (cls != null) return new cls(context) as IRenderer;   // as IRenderer 安全：接口双端共享
    return new AGALRenderer(context);                        // AIR / 默认 as-aot → 回退
}
```

三个要点：

1. **`as Class` 而不是 `as NativeShaderRenderer`**：`Class` 是内建类型，`as Class` 安全；`as NativeShaderRenderer`
   会把 AOT-only 类名放进类型位置，mxmlc 直接 `#1046`。`getDefinitionByName(...) as Class` 是项目
   `emit.ts:39042` 已支持的解箱路径。
2. **探测抛错不是返回 null**：`getDefinitionByName` 找不到时抛 `ReferenceError #1065`（`emit.ts:3864`），
   与 AIR 同号同语义，所以必须 `try/catch`，不能 `as Class` 判 null。
3. **`IRenderer` 接缝已存在**（`IRenderer.as` 注释就写明了「future NativeShaderRenderer will implement the
   same interface」），回退目标 `AGALRenderer` 就是现成的默认后端。

`NativeShaderRenderer` 本身（与 `AGALRenderer` 对称）遍历场景图 → 每个 `ShaderMaterial` 绑定其 GLSL ES 3.00
程序 → 上传 uniforms / 属性 / 纹理 → draw。

### 7.5 浮点格式 / 原生 shader / 深度纹理：`Context3DNative`（方案 B，被运行时探测锁定）

§6.1 层 2 的增强浮点/深度格式、§6.3 的原生 shader 提交、§6.4 的深度纹理，**全部收进一个新类 `Context3DNative`**（包名
待定，§12）。这是「运行时探测」路线下的**唯一选择**：

- 方案 A（条件符号扩展 `Context3D`）的 `Context3DTextureFormat.RGBA_FLOAT` 是**常量引用**，AS3 没有
  「常量是否存在」的运行时探测（`describeType` 能查但依赖 XML/E4X，项目已延后）⇒ 无法优雅降级，弃用。
- 方案 B 的新类**可被 `getDefinitionByName` 探测**，与 §7.4 工厂同款模式；`Context3DTextureFormat` 本身只做
  **层 1 的对齐**（对齐后仍是 AIR 六常量），层 2 的增强格式**不进**它（默认产物与 AIR 同构）。

作者用法（工厂封装探测，作者代码零类型位置引用 AOT-only 类）：

```as3
var nat:Object = RendererFactory.nativeContext();   // 内部 getDefinitionByName("...Context3DNative") + try/catch
if (nat != null) {
    var rt:* = nat.createTexture(w, h, "rgbaFloat", false);   // 浮点 RT，格式常量待定 §12
    // ... FFT 走 GPU
} else {
    // AIR / 默认 as-aot：浮点 RT 不可用 → 走 CPU FFT（§7.8 降级）
}
```

### 7.6 错误 vs 降级：运行期的两种表现边界

两个策略不是二选一，是**按能力缺失的语义后果分**（红线 `README.md:178`：降级必须显式——有探测、有测试、
有文档；AGENTS.md §1.5：绝不静默、绝不降级成错误语义）：

| 场景 | 策略 | 理由 |
|---|---|---|
| `NativeShaderRenderer` 缺失 | **降级** → 回退 `AGALRenderer` | 有等价替代路径，`IRenderer` 接缝已存在 |
| 浮点 RT 缺失 | **降级** → FFT 走 CPU（M25 同款模式） | 有等价替代路径（CPU FFT 保真） |
| `ShaderMaterial` 在 AIR 下被渲染 | **如实报错** | 无等价替代：假装成 `MeshBasicMaterial` 是错误语义 |
| 作者显式开 `--features native-shader` 但跑在 AIR | **如实报错**（启动即报） | 硬依赖缺失，无可降级 |

### 7.7 浮点 / 整数 / 深度纹理的 AS3 面

`Texture` / `DataTexture` 要能承载浮点数据（FFT 位移/频谱），对应编译器侧 §6.1 的新格式。现有 `Texture`
的 8 位 `BitmapData` 载荷模型要扩展出三类旁路：

- **浮点载荷**：`Vector.<Number>`（float32）或 `ByteArray`（半浮点打包），对应 §6.1 层 2 (a) 浮点格式。
- **整数载荷**：`Vector.<uint>` / `Vector.<int>`，对应 §6.1 层 2 (b) 整数格式（整数纹理不能用浮点采样器读，
  AS3 侧要能标注「这是整数纹理」）。
- **深度载荷**：`DEPTH_COMPONENT*` 深度纹理，对应 §6.4——它既作 depth attachment 又作可采样纹理，
  与普通颜色纹理的创建/绑定路径不同。

并且「纹理」要区分两种角色：**可采样**（绑到 shader 当 sampler）与**可渲染**（当 RT 附件）。§6.1 层 2 的
「建模提醒」说清了不是所有格式两者都行，AS3 侧 `Texture` 的创建 API 要能同时表达这两种用途（对齐
three.js 的 `WebGLRenderTarget`（可渲染）vs `Texture`（可采样）分工），不能只有一个 `createTexture`。

### 7.8 Ultra-Water 复刻的形态切换（关键决策点）

E6 落地后，**FFT 的归属从「被迫 CPU」翻转为「可以 GPU」**：

| 路线 | 之前（无 E6） | 之后（有 E6） |
|---|---|---|
| **CPU FFT**（保真） | 唯一可行（M25 HDR 就是「float panorama → CPU 预滤波 → 8bit cube」的同款模式） | 仍是兜底；float RT 不可用的降级 |
| **GPU FFT**（Tessendorf） | 不可行（无 float RT / texelFetch / MRT） | **解锁**：`OceanSim.js` 的 FFT 直接搬，位移/斜率/雅可比/泡沫都在 GPU 算 |

**Ultra-Water 的「神」在 GPU FFT**——复刻它应该走 GPU FFT，这才是 E6 存在的意义；CPU FFT 是「绕行」，
不是目标（AGENTS.md §0「不绕行」）。

### 7.9 引擎侧工作量切分

- **第一批（验证路径）**：`NativeShaderRenderer` + `ShaderMaterial` + 一个最小 FFT 海洋（Tessendorf 单级
  FFT + 位移 + 一个 float RT），在 AOT-Metal 上出画面。
- **第二批（web 免费点）**：同一套 `ShaderMaterial` 在 `--target wasm` 上直通，验证 GLSL ES 3.00 不经
  交叉编译直接跑。
- **第三批（对齐 Ultra-Water 全家桶）**：caustics / 大气 LUT / 水下 / 泡沫 / 漂浮物浮力（CPU 采样水面
  高度），逐一搬。

---

## 8. 红线：AOT-only，AIR 侧如实报明

**这条链 AIR（adl）走不了**——Adobe 的 `Context3D` 既没有浮点 RT，也没有 GLSL3 直通。所以：

- **AOT 侧**：`--features native-shader` 开启后，浮点 RT / MRT / 原生 shader 全部可用（native 走 Metal/D3D，
  web 走 WebGL2）。
- **AIR 侧**：同一份 `.as` 在 `adl` 下**本来就**没有这些 API ⇒ 按 §1.5 是增强，不是欠账；AIR 侧要么黑屏、
  要么给 AGAL 降级版，**必须如实报明**，不静默。
- **跨端差异显式列出**（§1.2 标准 c）：
  - native（Metal/D3D）：完整。
  - web（WebGL2）：完整（透传 + float 扩展），但 float RT 依赖 `EXT_color_buffer_float`，需运行时查询；
    老 GPU 可能只有 half float，`RGBA_FLOAT` 降级到 `RGBA_HALF_FLOAT` 要**显式**报。
  - AIR（adl）：**不支持**，`NativeShaderRenderer` / `Context3DNative` 等类在 `airglobal.swc` 里不存在，静态引用即
    `#1065`；作者走 §7.4 工厂探测时优雅回退 `AGALRenderer`（与现有 `AGALTranslator` 在 AIR 上缺失同形，
    `AGALRenderer.as` 头部注释已记录这个坑）。

**这一条已拍板并落地**（§12）：E6 按**增强**放行、AOT-only，AIR 侧**抛错报明**而不是静默黑屏。
落地的具体形态比本文原设想更硬：

- **默认构建零字节变化**——`Context3DNative` / `NativeProgram3D` 在默认构建的符号表里**不存在**，
  `getDefinitionByName` 与 `adl` 同形抛 `#1065`；`examples/native-shader-probe.as` 与
  `test/unit/native-shader.ts` 双向钉住（含「默认构建的 C 里没有 native 方法体」与
  `#define ASC_HAS_NATIVE_SHADER 0`）。
- **引擎侧不画近似图**——`ShaderMaterial` 在拿不到 native 通道时
  `AGALRenderer._drawShaderMaterial` **直接抛错**并报出材质名与开关（`asaot3d` §37.4）。
  用 AGAL 冒充作者的 GLSL 会是「穿着合理外衣的错误答案」（AGENTS.md §0）。
- 代价已写入 `enhancements.md` §3 的 E6 行：这是**增强**，不是遗留欠账，不入「遗留待开发」。

---

## 9. 分阶段路线

| 阶段 | 内容 | 验收 | 后端 | 状态 |
|---|---|---|---|---|
| **P1 · Metal 单后端起步** | glslang+SPIRV-Cross 入 `build-tools/`；`--features native-shader` 注册；`stage3d_glue.mm` 增 float RT + MRT + 原生 MSL 编译；`NativeShaderRenderer` + `ShaderMaterial` | AOT-macOS 出画面，float RT 可渲可读，MSL **真编译** | Metal | ✅ **M3 + M6 已验收**：`shader-m30` 15 项 PASS、像素 `#804020`/`#361b0e`。验收方式从 `xcrun metal` 改运行期 `newLibraryWithSource:`（§3.4：本机无离线工具链） |
| **P2 · Web 免费点** | `stage3d_webgl.cc` 直通 GLSL ES 3.00 + `EXT_color_buffer_float`；同一套 `ShaderMaterial` 跑 `--target wasm` | 浏览器出同一画面，零交叉编译 | WebGL2 | ❌ 未做（现在 `--features native-shader` 只声明 `native` 目标） |
| **P3 · D3D12** | `stage3d_d3d.cc` 增 float `DXGI_FORMAT` + 原生 HLSL 编译 | Windows 出画面 | D3D12 | ❌ 未做（SPIRV-Cross 的 HLSL 半边库已链好） |
| **P4 · Ultra-Water 对齐** | caustics / 大气 LUT / 水下 / 泡沫 / 漂浮物浮力，逐项搬 + 对拍 | 与 three.js 参考逐项接近 | 三端 | 🟡 **第一阶段已落**：`asaot3d/apps/ocean-m32` = Tessendorf FFT 海洋（256²×2 cascade、34 pass/帧、顶点纹理取值位移、MRT 位移+法线、高度读回 ±1.6 m）。**未做**：caustics / 水下 pass / 喷雾 / 4 cascade / 平面反射 / 天空梯度 |

**第一批只落 Metal** 的理由成立：本机 macOS + Metal，MSL 与 GLSL ES 3.00 语法接近，先把
「E6 + float RT + MRT + texelFetch」的最小闭环钉死，再铺开。

> 原 P1 验收写的是「出 Tessendorf 位移水面」——**实际第一版验收是一张 2×2 四边形**。
> 这是故意的：海洋会把「通路错」和「FFT 算错」两种错缠在一起，而四边形的像素能逐位对上
> `uColor.rgb * vUV.x`。FFT 归 M7。

---

## 10. 风险与工作量

| 风险 | 说明 | 缓解 |
|---|---|---|
| **glslang+SPIRV-Cross 引入体积** | 两个静态库 MB 级，违反 §1.2(d) 若默认链 | **opt-in**：`--features native-shader` 才链，默认构建零增长 |
| **交叉编译语义坑** | GLSL ES 3.00 的 `uint`/`texelFetch`/MRT 到 MSL/HLSL 的映射有边角（精度修饰符、`flat` 插值、整数除法） | 用 Khronos 官方链（非自研），边角坑已在 Flutter/Godot 生产验证过；每个特性配单元钉 |
| **MSL/HLSL 语义差异** | 三端行为不完全一致（如 float RT 精度、MRT 数量上限） | 沿 `display3d.md` §10.5「未验收不静默」口径，逐端实测登记 |
| **运行时交叉编译耗时** | 首次编译某 shader 有 glslang+SPIRV-Cross 开销 | 程序缓存（[`display3d.md`](display3d.md) §9.11 同思路）；build-time 预编译作后续优化 |
| **AOT-only 红线争议** | AIR 侧跑不了，可能被当成「欠账」 | §8 说清：AIR 从来没有这 API，是增强不是欠账；先拍板 |
| **工作量** | 编译器侧（格式+MRT+胶水）+ 引擎侧（renderer+material）+ 交叉编译链，跨三端 | 分四阶段，P1 Metal 先跑通，逐阶段验收 |

---

## 11. 验收标准（DoD）

E6 一个阶段「做完」须同时满足（对齐 AGENTS.md §4）。**下表按「已验收 / 未验收」分开**，
避免把「代码落了」当成「验收过了」：

| # | 标准 | 状态 |
|---|---|---|
| 1 | `--features native-shader` 开启后，`Context3DNative`（§6.3）能提交 GLSL ES 3.00 源码并正确编译到目标后端 | ✅ **已验收**——但不是 `xcrun metal`（本机无离线工具链，§3.4），而是运行期 `newLibraryWithSource:`；`shader-m30` 的 15 项里前 12 项就是这个通路（含顶点译文里的 `[[buffer(n)]]` 与 `main0` 入口、ES1.00/legacy 拒绝带行号） |
| 2 | float RT（至少 `RGBA_HALF_FLOAT` / `RGBA_FLOAT` / `R32F`）读写正确，读回数值在容差内 | ❌ **未验收**——`shader-m30` 画到**后台缓冲**再 `drawToBitmapData` 读回，没碰浮点目标；格式创建面（11 个 id）代码已落 |
| 3 | MRT 至少两附件，`layout(location=0/1) out` 落对 | 🟡 **部分**——反射已验（`examples/native-shader-probe.as` 报 `colorAttachments == 2`）， **两张附件分别读回像素未验** |
| 4 | `examples/*.as` 有最小示例，`as-aot --features native-shader examples/x.as --run` 跑通 | ✅ **已验收**——`examples/native-shader-probe.as`（编译器侧）+ `asaot3d/apps/shader-m30`（引擎侧）。**不是「FFT 海洋」**：原 DoD 写的是海洋，实际改成四边形，理由见 §9 |
| 5 | 默认构建（不带 `--features native-shader`）**逐字节不变**，`Context3DTextureFormat` 与 AIR 六常量逐字对齐 | ✅ **已验收**——`test/unit/native-shader.ts` 双向钉（默认构建无 native 方法体 + `#define ASC_HAS_NATIVE_SHADER 0`） |
| 6 | AIR 侧如实报明（不静默黑屏） | ✅ **已验收**——默认构建/`adl` 下 `shader-m30` 打印 `NO-CHANNEL` 并退出 0，`ShaderMaterial` 直接抛错 |
| 7 | `test/unit/` 有源级钉子（新格式枚举、MRT、`--features` 注册、负例「AIR 不支持」） | ✅ `test/unit/native-shader.ts` |
| 8 | `enhancements.md` §3 E6 状态更新、`README-CN.md`/`README.md` 同步、版本号递增 | ✅ v0.4.314 立项+M2、v0.4.316 M3 通路 + M6 |

> **1/2/3 的区别很重要**：通路（源码 → MSL → 管线 → draw → 像素）已经端到端跑通，但**浮点目标与 MRT 的读回**没验。
> 所以「浮点渲染目标可用」这句话今天只能说到「API 在、格式建得出来」，不能说到「数值对」。这正是 M7（FFT 需要两张浮点图）开工前必须补的第一件事。

---

## 12. 拍板记录

**已拍板（本轮实现即结论）**：

- **源语言**：GLSL ES 3.00（§4）。
- **`ShaderMaterial` 存在性**：双后端共享（§7.3）。
- **AOT-only 能力隔离机制**：运行时探测（§7.4 / §7.5）。
- **浮点格式 API 形状**：方案 B「新类 `Context3DNative`」（被「运行时探测」锁定，§7.5）。
- **① AOT-only 红线**：按**增强**放行（§8），且落地比设想更硬：默认构建零字节变化 + 引擎侧抛错报明。
- **② 编译时机**：**运行时**（three.js 同形）——`uploadProgram` 返回 `ok=false` + `infoLog`，不抛。
  build-time 预编译维持 §8 的「未做」登记。
- **④ 命名**：`flash.display3D.Context3DNative` / `flash.display3D.NativeProgram3D` /
  `asaot.three.NativeShaderRenderer` / `asaot.three.RendererFactory` / `asaot.three.ShaderMaterial`；
  格式常量是 `String`（`"rgba32f"` 等 9 个，与 `Context3DTextureFormat` 同形）。
- **⑤ 可达性钩子**：选**清单字段 `extra-roots`**（+ CLI `--extra-roots`），不用 `[WasmExport]`——
  那个注解会被迫兼管两件事（JS 导出 / 闭包根），语义不单一。
- **⑥ 离屏 MSAA**：逐目标 `setRenderTargetSamples(tex, n)`，默认 1（§6.10）。不把它做成 `Context3D`
  的全局开关：全局开关会逼全屏数据 pass 一起多采样，纯浪费。

**仍待拍板**：

1. **FFT 归属**：E6 解锁后走 GPU FFT（§7.8 推荐，不绕行）还是保留 CPU FFT 兜底？——它直接决定 M7 的形状，
   开工前定。
2. **浮点目标的验证口径**：容差怎么定（逐位 / 相对误差 1e-5 / 只比形状）？M3 余项要拿它写断言。

---

## 13. 参考链接

- [Ultra-Water](https://github.com/Humpalumps/Ultra-Water)（three.js/WebGL2 海洋演示，E6 的触发场景）
- [Flutter Impeller](https://docs.flutter.dev/perf/impeller)（glslang + SPIRV-Cross 链的工业参照）
- [glslang](https://github.com/KhronosGroup/glslang)（Khronos，GLSL → SPIR-V，Apache-2.0）
- [SPIRV-Cross](https://github.com/KhronosGroup/SPIRV-Cross)（Khronos，SPIR-V → MSL/HLSL/GLSL，Apache-2.0）
- [three.js r187 ShaderMaterial](https://threejs.org/docs/#api/en/materials/ShaderMaterial)
- 本文引用的仓内事实：`src/symbols.ts:7556`（纹理格式）、`src/runtime.ts`（AGAL 翻译器）、
  `vendor/stage3d_{glue.mm,webgl.cc,d3d.cc}`（三端胶水）、`asaot3d/seam/asaot/three/{IRenderer,AGALRenderer}.as`。
