# Stage3D（`flash.display3D`）对齐与落地

> 本文起于一次立项调研——**能否把 AIR SDK 的 `flash.display3D.*`（Stage3D）对齐到本项目、怎么落地**。
> 结论是**能，且不是架构推翻，而是对现有 GPU 基础设施的一次有边界的扩展**；它是本项目迄今最重的一块
> （等价于再造一个小型 3D 图形 API 运行时），核心难点是 **AGAL 字节码 → 原生着色器语言的翻译**。缺口
> 集中在「3D GPU 资源 + 状态机 + AGAL」这一整块，而非散点补齐。
>
> **现状（2026-10-13，v0.4.112，阶段一百四十一）**：立项当年的整块缺口**已全部闭合**，且比原计划多出一整个
> **Windows / Direct3D 12** 后端——AGAL 翻译器（三档 **MSL / GLSL ES / HLSL**）、`Matrix3D`/`Vector3D`、
> `Stage3D`/`Context3D` 状态机与资源类、以及三份自包含胶水（`vendor/stage3d_glue.mm` Metal /
> `vendor/stage3d_webgl.cc` WebGL2 / `vendor/stage3d_d3d.cc` D3D12，同一套 `s3d_*` ABI）均已落地。
> **本文按性质分两半**：§1–§8 是立项期的推理与分层设计（各节末尾附「落地现状」），**§9 起是逐阶段的落地
> 记录，也是当前口径的权威来源**（§9 纹理/采样器/程序缓存/状态对象，§10 Windows D3D12 后端）；逐阶段
> 流水见 `TODO.md`。
>
> 定位：Stage3D 之于本项目，等价于阶段三十六~三十八「链接 Skia 而非自研光栅化」的**同构扩展**——
> 它替换的是「可编程 GPU 三角形管线」那一层（裸 `MTLBuffer`/D3D12 命令列表/渲染通道/着色器编译），**不是**
> `flash.display.*` 的 2D 显示列表/事件那一层。显示列表层叠关系与事件流语义不变，Stage3D 只是新增一个
> 独立的 GPU 渲染通道，与 2D 表面在窗口合成阶段汇聚。

---

## 1. `flash.display3D`（Stage3D）是什么

它是 Flash Player 11 引入的**可编程 GPU 3D 管线**，官方描述「与 OpenGL ES 2 高度相似，但抽象成跨硬件兼容」。
**唯一几何图元是三角形**。它不是 `flash.display.*` 那套 2D 显示列表——Stage3D 独立于显示列表，层叠在
`StageVideo` 与显示列表之间。

完整 API 面（比 package-detail 页列的 19 个类还多一层依赖）：

| 类别 | 类 |
|---|---|
| 主机 | `flash.display.Stage3D`（`requestContext3D`/`context3D`/`x`/`y`/`visible`，发 `context3DCreate` 事件） |
| 上下文 | `Context3D`（约 30 个方法：`configureBackBuffer`/`clear`/`present`/`drawTriangles`/`drawTrianglesInstanced`/`setVertexBufferAt`/`setProgram`/`setTextureAt`/`setBlendFactors`/`setDepthTest`/`setCulling`/`setStencilActions`/`setRenderToTexture`/`setScissorRectangle`/`setProgramConstantsFrom*`/`setColorMask`/`drawToBitmapData` 等） |
| 资源 | `VertexBuffer3D`、`IndexBuffer3D`、`Program3D`（`upload(AGAL字节码)`） |
| 纹理 | `flash.display3D.textures.{Texture, CubeTexture, RectangleTexture, TextureBase, VideoTexture}` |
| 常量类 | 16 个：`BlendFactor`/`BufferUsage`/`ClearMask`/`CompareMode`/`CubeMapFace`/`FillMode`/`MipFilter`/`Profile`/`ProgramType`/`RenderMode`/`StencilAction`/`TextureFilter`/`TextureFormat`/`TriangleFace`/`VertexBufferFormat`/`WrapMode`（AS3 里均以 `Context3D` 前缀命名） |
| 隐式依赖 | `flash.geom.Matrix3D`、`flash.geom.Vector3D`、`Vector.<Number\|uint\|float>`、`ByteArray`（小端读） |

> 注意 `AGALMiniAssembler`（`com.adobe.utils.*`）**不是运行时**，是纯 AS3 工具类——只要编译器能编译它的
> 源码，它就作为用户代码跑（只做字符串解析 + 位打包，产出 `ByteArray`）。所以不需要特殊运行时支持，
> 但真实 Starling/Away3D 项目都依赖它，验收时要用它做端到端。
>
> **落地现状**：上表所有类均已实现——`Matrix3D`/`Vector3D`（阶段七十九）、`Stage3D`/`Context3D` 与资源/
> 纹理/常量类（阶段八十一~八十三、八十七、八十九·二十一、一百二十八）、`AGALMiniAssembler` 作为**用户代码**
> 编译（阶段八十四 在 `shmup-stage3d` 里端到端验证）。

---

## 2. 现状盘点

立项时（阶段七十九 之前）这里的结论是「除 2D 渲染闭环外全部缺失」。截至 v0.4.112（阶段一百四十一），
缺口已全部闭合，且比原计划多出一整个 **Windows / Direct3D 12** 后端：

| 项 | 现状 |
|---|---|
| 2D 渲染闭环 | ✅ Skia CPU raster + GPU（macOS `metal_glue.mm`、Windows `window_glue.cc`+`d3d_glue.cc`、web `web_glue.cc`）+ SDL2 窗口 |
| `ByteArray`（含 grow/compress/uncompress） | ✅ 已实现 |
| `Point`/`Rectangle`/`Matrix` | ✅ 已实现 |
| `Vector.<T>` 类型系统 | ✅ 已建模 |
| `Matrix3D` / `Vector3D` | ✅ 阶段七十九 |
| `Stage3D` / `Context3D` / `display3D.*` | ✅ 状态机 + 资源/纹理类 + 16 个常量类（阶段八十一~八十七、八十九·二十一、一百二十八） |
| AGAL 翻译器（**MSL / GLSL ES / HLSL** 三档） | ✅ 阶段八十（MSL/GLSL）、一百三十一（HLSL） |
| 原生 GPU 三角形管线 | ✅ 三份自包含胶水共用一套 `s3d_*` ABI：`stage3d_glue.mm`（Metal）/ `stage3d_webgl.cc`（WebGL2）/ `stage3d_d3d.cc`（D3D12） |

结论：立项时判定的「缺口集中在『3D GPU 资源 + 状态机 + AGAL』这一整块」**成立且已整块闭合**；
三份胶水结构同形，语义取舍（§9.1–§9.13）逐条移植到三个后端。

> **现状的权威来源是本文 §3/§5 的「落地现状」与 §9、§10 的落地记录**（§9 纹理/采样器/程序缓存/状态对象，
> §10 Windows D3D12 后端）；逐阶段流水与验收证据见 `TODO.md`。

---

## 3. 核心技术难点：AGAL 翻译（唯一真正「难」的点）

Stage3D 的着色器是 **AGAL（Adobe 图形汇编语言）二进制字节码**，不是 GLSL/HLSL/MSL。`Program3D.upload()`
收的是字节码，运行时负责把它翻译成目标平台的着色器语言。

- **结构**：magic `0xa0` + version + program type + shader type，之后是一串 **固定 24 字节/条**的槽
  （`[opcode:4][dest:4][src1:8][src2:8]`），≤200 指令/程序。
  **无目的寄存器的指令（`kil`/`ife`/`ine`/`ifg`/`ifl`）也占满这 24 字节**：
  `AGALMiniAssembler.as` 只把该指令的**操作数**写成槽里的 `src1`/`src2`，但**仍然写 4 字节 0 到
  `dest` 槽**（`if ( j == 0 ) { agalcode.writeUnsignedInt( 0 ); }`）——故解码器**必须无条件**跳过
  `dest` 槽，否则该指令的每个操作数都**早读 4 字节**。阶段一百一十五 前正是如此：
  away3d `EnvMapMethod` 的 `kil temp2.w`（「立方体采样 alpha < 0.5 就杀片元」）被解成
  `in.v0.xxxx`，判据变成**变换后法线 x < 0**——一个世界空间半平面，投影正好是**屏幕中心竖直线**，
  把 `Basic_SkyBox` 的环体左侧外表面成片丢掉，且随旋转角度变化（看起来像「转到某些角度环就缺失」）。
  钉子：`test/unit/stage3d.ts` 的 `stage3d/agal-operand-slots`。
- **寄存器模型**（按 version 分档，详见 AGALMiniAssembler `initregmap`）：`va`（attribute，v1/v2=7、v3=15）、
  `vc`（vertex constant，v1=127、v2/v3=249）、`vt`（temp，v1=7、v2/v3=25）、`op/oc`（output）、
  `v`（varying，v1=7、v2/v3=9）、`fc`（fragment constant，v1=27、v2=63、v3=199）、`ft`（v1=7、v2/v3=25）、
  `fo`（v1=0 仅 `oc`、v2/v3=3 即 MRT）、`fd`（v2/v3 深度输出）、`fs`（sampler）；AGAL3 独有 `iid`（实例化）、`vs`（顶点纹理采样）。
- **指令集**：约 28 条基础指令（`mov/add/sub/mul/div/rcp/min/max/frc/sqt/rsq/pow/log/exp/nrm/sin/cos/dp3/dp4/crs/m33/m34/m44/abs/neg/sat/kil/tex` 等），
  带 swizzle 与 write-mask；AGAL2 扩展控制流（`ife/ine/ifg/ifl/els/eif`）+ 导数（`ddx/ddy`）+ MRT；AGAL3 扩展实例化与顶点纹理采样。

**翻译方案是成熟且确定性的**（阶段八十 落地；阶段一百三十一 由单档扩为三档）：
- macOS native：AGAL → **MSL**（`vendor/stage3d_glue.mm` 里 `newLibraryWithSource:` 编译），寄存器映射为
  `float4`、`tex` 映射为 `texture2d.sample()`。
- web：AGAL → **GLSL ES**（`vendor/stage3d_webgl.cc`，WebGL2）。
- Windows native：AGAL → **HLSL**（shader model 4+，`vendor/stage3d_d3d.cc` 经真 `D3DCompile` 编出 `vs_5_1`/`ps_5_1`）。
- 三档由构建期 `ASC_AGAL_TARGET` 选择（**MSL=0 / GLSL=1 / HLSL=2**）；生成的 C 完全不变，由链接的胶水与构建清单决定。
  翻译器以纯静态内建桥 `AGALTranslator.translate(bytes:ByteArray, target:String):String` 暴露
  （`"msl"`/`"glsl"`/`"hlsl"`，非 AS3 运行时 API）。
- **权威参照**：Ruffle 已实现 Stage3D（AGAL → wgpu/WebGPU），社区有多个 AGAL → GLSL 开源实现，
  语义规则（swizzle/mask/寄存器约束/校验错误清单）在 `Program3D.upload` 的 40+ 条校验错误里被完整定义。

这一段是**纯 C/C++ 胶水层里自包含的确定性翻译器**，不碰前端「翻译 AS3→C」的主管线，符合 AGENTS.md §2.9
「重活走链接/胶水」铁律。真正的体力活在 AGAL 校验器（40+ 条错误）与 AGAL1/2/3 三代的扩展
（MRT、实例化、`iid` 寄存器、`fragment output index`）。

> **三档的覆盖差异（如实记录）**：片元 **MRT**（`oc1..oc3` → 多输出）目前只有 **HLSL 档**（`SV_TargetN`），
> MSL/GLSL 两档仍把片元折叠成**单一输出**（`oc` / `gl_FragColor`）；这一条仍在 `TODO.md` 的
> `### 遗留待开发`。
>
> **深度输出（`od`）与 AGAL3 `iid` 已于阶段二百六十一 修净**（原来只有 HLSL 档是对的）：`od` 在三档里
> 都是 `float4 od` **局部**（写掩码 `0xF` 走整寄存器赋值、`0x1` 走逐分量赋值，标量装不下），出口写目标
> 各自的深度槽 —— MSL `struct FSOut { … float depth [[depth(any)]]; }`、GLSL
> `gl_FragDepthEXT = od.x;`（**不是** `gl_FragDepth`：ES 1.00 源里只有扩展的名字，且 WebGL 还要求上下文
> 先 `getExtension('EXT_frag_depth')`，见 `vendor/stage3d_webgl.cc` 的 `s3d_create`）、HLSL
> `output.depth = od.x;`。`iid` 在 MSL/HLSL 走宿主系统值（`uint iid [[instance_id]]` /
> `SV_InstanceID`）并广播成 `float4`；**GLSL ES 1.00 没有 `gl_InstanceID`（那是 ES 3.00）**，故 GLSL 档
> **响亮拒绝**，片元程序读 `iid` 三档一律拒绝 —— 不再发未声明的 `r<num>`。空 `VSIn`/`FSIn` 也与 HLSL 一样
> 按实际使用抑制。**注意区分「实例化」本身**：`drawTrianglesInstanced` → `instanceCount` 三端**都已上屏**，
> 缺的只是着色器里读**每实例 ID 的寄存器**（GLSL 档至今给不出，故如实拒绝）。
> 验收：`xcrun metal` 真编译 7/7 过（旧形态两份都编不过），WebGL 真编译过，证据 `temp/metalshader/`。

---

## 4. 分层对齐方案（立项设计 + 落地现状）

| 层 | 方案（立项设计 → 落地现状） |
|---|---|
| 前端（AST/lexer/parser） | 零改动。`Context3D` 等全是普通内建类，走 `symbols.ts` 建模 + `runtime.ts` 助手 |
| 运行时状态机 | `Context3D` 是纯状态机（blend/depth/stencil/cull/scissor/colorMask/fillMode + 当前绑定的 buffer/program/texture/constants），C 结构即可 |
| GPU 资源 | 实际**没有**塞进 `metal_glue.mm`，而是三份自包含胶水各自暴露同一套 `s3d_*`：`vendor/stage3d_glue.mm`（`MTLBuffer`/`MTLTexture`/`MTLLibrary`/`MTLRenderPassDescriptor`/`MTLDepthStencilState`）、`vendor/stage3d_webgl.cc`（WebGL2）、`vendor/stage3d_d3d.cc`（D3D12） |
| 上屏合成 | Stage3D 的离屏目标与 Skia 2D 表面合成到同一窗口：macOS 经 Ganesh 采样同一 `MTLTexture`、Windows 经 Skia 的 D3D 后端采样同一 `ID3D12Resource`、web 经 CPU 回读（阶段八十九·三十）；三者都必须与 2D 后端**共用一条设备/队列**（§9.8、§10.4） |
| web | `vendor/stage3d_webgl.cc`：裸 WebGL2，与 Ganesh 共用同一个 WebGL2 上下文 |
| 前置类 | `Matrix3D`（透视投影/append/recompose）、`Vector3D` —— 纯逻辑，与 `Matrix` 同套路（阶段七十九 落地） |

（`AGALMiniAssembler` 见 §1 的说明：它不是运行时，是纯 AS3 工具类，随用户源码一起编译，验收时用它做端到端。）

---

## 5. 构建与链接

Stage3D 的落地复用阶段三十六~三十八已有的「胶水层 + 构建清单」能力，只做**增量扩展**，不新增构建范式：

| 关注点 | 说明 |
|---|---|
| 胶水层 | AGAL→MSL/GLSL/HLSL 翻译器与 GPU 资源管理函数**不在** `metal_glue.mm`/`web_glue.cc` 里，而在三份自包含胶水（`stage3d_glue.mm` / `stage3d_webgl.cc` / `stage3d_d3d.cc`），仍用 `extern "C"` 暴露**同一套**平坦 `s3d_*` C 接口 |
| 前置类 | `Matrix3D`/`Vector3D` 是纯 AS3 逻辑类，走现有 `symbols.ts` 内建建模，不碰 GPU（阶段七十九 落地） |
| 构建清单 | macOS 无需新增第三方库（Metal/Foundation 是系统框架，复用现有链接）；web 复用 Ganesh 的 WebGL2；Windows 推 `stage3d_d3d.cc` 并链 `d3d12`/`dxgi`/`d3dcompiler` |

> **Metal 头文件与框架**：`metal_glue.mm` 已存在于阶段七十五（native Metal 渲染后端），`MTLDevice`/`MTLCommandQueue`
> 的创建与 `SkSurface::MakeFromBackendRenderTarget` 的 Ganesh 集成已落地。Stage3D 复用的是「同一 `MTLDevice` 上的
> **裸** Metal 命令缓冲」，而非再走 Ganesh——Ganesh 是 Skia 的 2D 抽象，Stage3D 的三角形管线要直接 `MTLBuffer` +
> `MTLRenderPipelineDescriptor`，两者在同一 `MTLDevice` 上共存、经同一 `MTLCommandQueue` 提交，最后共享一个 drawable 上屏。

> **落地现状（native macOS = 阶段八十二~八十三，web = 阶段八十九·三十，Windows = 阶段一百三十一~一百三十二）**：
> 没有塞进 `metal_glue.mm`/`web_glue.cc`，而是**三份**各自独立的自包含胶水文件，暴露**同一套平坦 `s3d_*` C 签名**：
>
> | 目标 | 文件 | 着色器 | 构建开关 |
> |---|---|---|---|
> | native (macOS) | `vendor/stage3d_glue.mm` | 裸 Metal，AGAL→MSL | `ASC_RENDER_STAGE3D=1`（窗口层另加 `ASC_RENDER_METAL`） |
> | native (Windows) | `vendor/stage3d_d3d.cc` | Direct3D 12，AGAL→HLSL | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_HLSL=1`，链 `d3d12`/`dxgi`/`d3dcompiler` |
> | web | `vendor/stage3d_webgl.cc` | WebGL2/GLES3，AGAL→GLSL ES | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_GLSL=1`（有 `<depthAndStencil>` 时再加 `ASC_RENDER_DEPTH_STENCIL=1`） |
>
> 因此生成的 C 里的 `Context3D` 状态机、`as_s3d_*` 包装器、AGAL 翻译器调用点**三端完全相同**，
> 着色器语言只由构建期 `ASC_AGAL_TARGET` 选择。web 侧的 GL↔AS3 语义差异（Y 轴翻转、BGRA 交换、
> 逐寄存器 uniform、FBO/模板、CPU 读回上屏及其代价）见 [`html5-web.md`](html5-web.md) §3.3；
> Windows 侧的提交模型/PSO 缓存/字段顺序规则/合成借用见本文 §10 与 [`win32.md`](win32.md) §3.4。
> 是否挂载后端由 `src/air-app.ts` 的 `detectStage3D(files)` 扫源码自动判定（三端都适用，后端再按 OS 选）。

---

## 6. 分阶段路线（立项建议 → 均已落地）

| 阶段 | 目标 | 落地 |
|---|---|---|
| **A 前置** | `Matrix3D` + `Vector3D` + `Vector.<Number/uint/float>` 补全（纯逻辑，风险低） | ✅ 阶段七十九 |
| **B AGAL 内核** | AGAL 字节码解析器（AGAL1/2/3）+ 校验器 + →MSL/GLSL 翻译器（**最硬的一步**，单独一阶段） | ✅ 阶段八十（单档）；阶段一百三十一 补齐 HLSL 档 |
| **C Context3D 骨架** | `Stage3D` + `Context3D` 状态机 + `VertexBuffer3D`/`IndexBuffer3D`/`Program3D`/`Texture`(BGRA/RGBA) + `drawTriangles`，`enableErrorChecking=false` 走异步 | ✅ 阶段八十一；阶段八十七 补 Starling 前置方法 |
| **D 端到端** | Metal 裸管线落地，跑通「彩色三角形」demo，再铺开 blend/depth/stencil/cull/scissor/render-to-texture | ✅ 阶段八十二~八十三（另：阶段一百零四 按帧合批、一百一十五 帧边界 commit-only） |
| **E 对齐加固** | `drawToBitmapData`、`setRenderToTexture`、CubeTexture/RectangleTexture、AGAL2/3 的 GPU 端到端上屏（MRT render pass / 实例化） | ✅ 阶段八十三「实例化」上屏；✅ 阶段二百六十一 `od`/`iid` 三档收口（GLSL 档 `iid` 明确拒绝）；⚠️ **MRT 仍只有 HLSL 档**（见 §3 与 `TODO.md` 遗留表） |

**内核翻译器支持 AGAL1/2/3 三代；`Context3D.profile` 按后端真实能力分档上报**（阶段二百二十一）：后端能分配 4096×4096 的 2D 贴图 → `"baselineExtended"`；上限只有 2048 → `"baseline"`。判定与 `#3683` 报错用的是**同一个后端查询** `s3d_max_texture_size()`（D3D12/Metal 恒 16384，WebGL2 现查 `GL_MAX_TEXTURE_SIZE`，纯 C 状态机 4096），所以「对外承诺」与「实际强制」不可能漂移。

**为什么只上到 `baselineExtended` 而不是 `enhanced`**（`adl` 51.4.1 七档实测，`temp/adlprof/` 的 `caps:`/`edge:` 模式）：`enhanced` 不是「baseline + 顶点纹理取值」，它是 **`standard` 的超集**——

| 请求档 | 4096 贴图 | `rgbaHalfFloat` | `setRenderToTexture(...,1)`（MRT） |
|---|---|---|---|
| `enhanced` / `standardExtended` / `standard` | ✅ | ✅ | ✅ |
| `baselineExtended` | ✅ | ❌ `#3759` | ❌ `#3779` |
| `baseline` | ❌ `#3683 (max is 2048x2048)` | ❌ `#3759` | ❌ `#3779` |

而 `baselineExtended` 相对 `baseline` 的**唯一**增量就是 4096 贴图（Adobe 文档与实测一致）。所以档位是逐级爬的：4096 → `baselineExtended`，MRT + 浮点纹理 → `standard`，VTF/AGAL4 → `enhanced`；在 MRT 与浮点纹理落地前上报 `enhanced` 就是谎报（Starling 会在回读值上分支）。

**纹理尺寸校验（阶段二百二十一，`adl` 51.4.1 `edge:` 模式实测）**——检查顺序本身是可观测行为：

| 调用 | 规则（按判定顺序） |
|---|---|
| `createTexture(w,h)` | 0/负数 → `#3681 Texture size is zero.`；非 2 的幂 → `#3682 Texture size not a power of two.`；超过档位上界（2048/4096）→ `#3683 Texture too big (max is 2048x2048 / 4096x4096).` |
| `createCubeTexture(n)` | 0/负数 → `#3681`；非 2 的幂 → `#3682`；**上限恒 1024**（与档位无关，`enhanced` 也是 1024）→ `#3705 Cubemap texture too big (max is 1024x1024).` |
| `createRectangleTexture(w,h)` | 0/负数 → `#3681`；**没有 2 的幂规则**（4097 报的是「too big」而非「not pow2」）；上限 = max(档位上界, 后台缓冲尺寸) → `#3766 RectangleTexture too big (max is the larger of 2048x2048 / 4096x4096 or the size of the backbuffer).` |

四个码都是 **`ArgumentError`**（不是 `Error`）。`#3683`/`#3766` 的文案引用的是**上限**而非请求值，且只有 2048/4096 两种，所以生成侧用两个字符串字面量——共用 `snprintf` 缓冲会被下一次抛错改写，而 `Error` 存的是指针，那会静默篡改一个仍然活着的错误对象。

**`requestContext3D` 的两参签名（阶段二百二十，对 `adl` 51.4.1 实测）**：AIR 声明 `requestContext3D(context3DRenderMode:String = "auto", profile:String = "baseline")`，两个参数都在**调用点上同步校验**（`ArgumentError #2008`，无异步 `ErrorEvent` 路径）：

| 参数 | 合法值 | 越界的报错文案 |
|---|---|---|
| `context3DRenderMode` | 只有 `"auto"` / `"software"`（**大小写敏感**；描述符里的 `gpu`/`cpu`/`direct` 在这里**不合法**） | `Error #2008: Parameter renderMode must be one of the accepted values.` |
| `profile` | `Context3DProfile` 的 7 个字符串（含 **`"enhanced"`**） | `Error #2008: Parameter profile must be one of the accepted values.` |

校验顺序是 **`renderMode` 先、`profile` 后**（`requestContext3D("direct","nonsense")` 报的是 renderMode 那条），抛错发生在创建 `Context3D` **之前**（故失败后 `stage3D.context3D` 仍为 `null`）。

走 `Function.apply`（Starling 的真实路径）多给一个参数时，AIR 报 `#1063 Argument count mismatch on flash.display::Stage3D/requestContext3D(). Expected 0, got 3.` —— 注意 `Expected` 是「无默认值的形参个数」（这里是 0），不是形参总数；我们生成的同一句文案已与之逐字相同（`adl` 51.4.1 实测）。

回读值与请求值的关系要分清：**AIR 能同时满足全部 7 档，所以原样回显请求值**（实测 7 档请求 7 档回显，从不降级）；我们**接受全部 7 个字符串、但上报的是本构建真正能兑现的最高档**（现为 `baselineExtended`，判据见上）。这正是 Starling 的降级阶梯（`enhanced → … → baselineConstrained`，靠 `try/catch` 驱动）能安全落地的前提：它读的是**回读值**（`context3D.profile`），据此选 2048 还是 4096 贴图、`RenderTexture` 开不开双缓冲。把 `enhanced` 原样回显会让它直接跳进 4096 + 双缓冲的 tier-B 路径，而后端还没有 MRT/浮点纹理/VTF —— 那不是对齐，是谎报。

历史缺陷（阶段二百二十 修掉）：`requestContext3D` 曾只声明 1 个形参，于是任何按 AIR 签名的两参调用**编译期**即报 `too many arguments (expected 1, got 2)`；Starling 走 `Function.apply` 的真实路径则在**运行期**报 `#1063 Argument count mismatch`，整条 profile 阶梯在第一级就断掉。同时 `Context3DProfile.ENHANCED` 常量缺失（只定义了 6 个）。

### 6.1 最终验收 demo：`examples/shmup-stage3d`

> 该 demo 是阶段七十九~八十三的**最终端到端验收目标**，**阶段八十四 已跑通**——本项目把它从 `.as`
> 编译为原生可执行文件并跑出了正确画面。另有三个更大的真实工程做**通用性对照**：
> `examples/away3d-core/Basic_SkyBox.as`（§9）、`examples/air-starling-demo`（127 源文件 + 完整 Starling，
> web 12 场景全对）、`examples/Flappy-Starling`。

**来源与结构**：Christer Kaitila 的「Stage3D Shoot-em-up Tutorial」（tutsplus 教程，Starling 前身的
批处理 sprite 引擎）。共约 1806 行 AS3：

| 文件 | 职责 |
|---|---|
| `Main.as` | 入口：`requestContext3D` → `CONTEXT3D_CREATE` → ENTER_FRAME 渲染循环 |
| `LiteSpriteStage.as` | Stage3D 渲染器：`configureBackBuffer` + `Matrix3D` 模型视图矩阵 + 批处理驱动 |
| `LiteSpriteBatch.as` | 单次 `drawTriangles` 批量绘制全部 sprite（每帧重传顶点） |
| `LiteSpriteSheet.as` | 图集纹理：`createTexture(BGRA)` + `uploadFromBitmapData` + 逐级 mipmap 生成 |
| `Entity.as` / `EntityManager.as` | 实体对象池（`Vector` splice 复用） |
| `GameGUI.as` | 2D GUI（`Sprite` 显示列表层，与 Stage3D 层并存） |
| `com/adobe/utils/AGALMiniAssembler.as` | 纯 AS3 工具类（818 行）：字符串 AGAL → 位打包 `ByteArray` |

**该 demo 覆盖的 Stage3D API 面**（即验收清单，缺一不可）：

- `Stage3D`：`requestContext3D(Context3DRenderMode.AUTO)`、`context3D`、`CONTEXT3D_CREATE` 事件、`x`/`y` 定位
- `Context3D`：`configureBackBuffer`、`clear`、`present`、`drawTriangles`、`setProgram`、
  `setBlendFactors(ONE, ONE_MINUS_SOURCE_ALPHA)`、`setProgramConstantsFromMatrix(VERTEX, transpose)`、
  `setTextureAt`、`setVertexBufferAt`（**多顶点流**：stream 0 = `FLOAT_3` 位置/alpha，stream 1 = `FLOAT_2` UV）、
  `createVertexBuffer`、`createIndexBuffer`、`createProgram`、`createTexture`
- `Program3D.upload`（vertex + fragment 两份 AGAL 字节码）
- `VertexBuffer3D` / `IndexBuffer3D.uploadFromVector`
- `Texture.uploadFromBitmapData`（BGRA + 多级 mipmap）
- `Matrix3D.appendTranslation` / `appendScale`
- **AGAL1 着色器**（`AGALMiniAssembler.assemble` 默认 `version=1`）：`dp4`/`mov`/`tex`/`mul` + swizzle + sampler options
- 隐式依赖：`Vector.<Number/uint/T>`、`Rectangle`/`Point`/`Matrix`、`BitmapData`、`getTimer`

**与阶段的对应关系**：

- 该 demo 的着色器是 **AGAL1**（`assemble` 未传 `version` 参数），**恰好落在 baseline 收敛范围内**——
  阶段七十九（`Matrix3D`/`Vector3D`）+ 八十（AGAL 内核，覆盖 AGAL1 指令）+ 八十一（`Context3D` 状态机）+
  八十二（Metal 端到端）全部完成后即可编译运行，无需等阶段八十三的 MRT/实例化（事实也正是如此：阶段八十四 跑通）。
- 它**不依赖** AGAL2/3 特性（无 `ife`/`ddx`/MRT/`iid`），因此是验证「baseline 是否闭环」的精确探针；
  阶段八十三 的 AGAL2/3 能力（`drawTrianglesInstanced` 实例化、`setProgramConstantsFromVector`）另行用
  `examples/stage83.as` 覆盖，MRT/`od`/`iid` 的跨档差异见 §3。
- `build-and-run.sh` 用 `mxmlc -swf-version=13` + `adl`（`renderMode=direct`）编译运行，
  符合 AGENTS.md §2.4 的「以 `mxmlc` 为参考编译器、同一份 `.as` 对照验证」约定——本项目编译它时，
  以该脚本产出的画面/行为为基准对照。

---

## 7. 风险与落地边界

| 项 | 判断 |
|---|---|
| `VideoTexture` | ⚠️ **无解码器，但类与对象齐备**：`Context3D.createVideoTexture()` 返回一个空的 `VideoTexture`（`videoWidth`/`videoHeight` 恒 0），`Context3D.supportsVideoTexture` 常量为 `true`，`attachCamera`/`attachNetStream` 是**空实现**——对象存在是为了让 Starling 的 `ConcreteVideoTexture` 能持有/挂接一个基底，不会画错、只是不出视频像素 |
| 压缩纹理（ATF/DXT/PVRTC） | ⚠️ **部分**（阶段八十九·二十一）：ATF 容器的 `format 3/5`（裸 DXT1/DXT5）已实现——运行时 `as_atf_decode_dxt` 在 CPU 解码为直通-alpha ARGB 后走普通纹理上传路径（不预乘，与 adl 把裸 DXT5 交给 GPU 一致；mip 1+ 未解码、只取 level 0）；ETC1/PVRTC、cubemap 与 `format 0xc/0xd`（JPEG-XR 有损）仍**响亮报错**（`Error #3680`），不静默出空图 |
| `driverInfo`/`totalGPUMemory`/`profile` 精确上报 | `driverInfo` 按**构建期后端宏**上报四档：`ASC_S3D_GLSL` → `"WebGL2 (Stage3D)"`、`ASC_S3D_HLSL` → `"Direct3D12 (Stage3D)"`、`ASC_RENDER_STAGE3D` → `"Metal (Stage3D)"`、否则 `"Software (state machine)"`；判定入口是 `ASC_RENDER_STAGE3D`（**不是**只表示窗口合成后端的 `ASC_RENDER_WINGPU`/`ASC_RENDER_METAL`，见 `emit.ts` 该函数上的注释）。`profile` 按后端能力分档（§6 末：`baselineExtended` / `baseline`），与 `#3683` 同源；**`context3DRenderMode="software"` 被接受但不改变后端**——AIR 在软件模式下会禁用硬件（实测 `driverInfo` 变成 `Software Hw_disabled=explicit`、`maxBackBuffer` 从 16384 掉到 2048），我们永远用**编译期选定的 Stage3D 后端**（Metal/D3D12/WebGL2/纯 C 状态机）绘制，`driverInfo`/`maxBackBufferWidth` 也不随该参数变化。这只影响「明明该走 CPU 光栅化」的极端场景（无可用 GPU），且我们的窗口后端本身就需要 GPU，故不单列欠账；`totalGPUMemory` 已实现但为**近似值**（阶段八十九·二十一：后台缓冲 BGRA8 字节数 + 有深度模板时再加 D32S8 字节数）——它必须存在，因为 Starling `StatsDisplay.supportsGpuMem` 用 `"totalGPUMemory" in context` 探测并据此增删整个 HUD 行。D3D12 那串标签尚无 adl 实测（adl 无可用 D3D 后端），是**诚实的占位**，已入遗留表 |
| `enableErrorChecking=true` 的同步抛错 | **未实现**：`Context3D.enableErrorChecking` 的 setter 目前是 no-op，`true` 时不产生 AIR 的同步校验抛错（我们的 draw 走批量提交、帧边界统一退休，本身没有可同步抛错的时机）。不影响 Starling/Away3D |
| AGAL2/AGAL3 的 GPU 端到端上屏（MRT/实例化） | **实例化已上屏**（阶段八十三：`drawTrianglesInstanced` → 三端的 `instanceCount`），AGAL2 控制流/导数三档都翻译。阶段二百六十一 把 **`od`** 与 **`iid`** 三档收口（MSL 深度槽 + `[[instance_id]]`、GLSL `gl_FragDepthEXT` + 上下文级 `EXT_frag_depth`、GLSL 档 `iid` 明确拒绝）。**未闭合的只剩片元 MRT**（`oc1..oc3`）只有 HLSL 档（详见 §3 末的差异说明，已入 `TODO.md` 遗留表） |

---

## 8. 工作量与结论

- **工作量**：这是「小型 GPU 运行时」级别，约相当于现有「阶段三十三~四十（事件+显示列表+渲染+窗口）」
  这一整段的量级，AGAL 翻译器 + 校验器约占 40%，`Context3D` 状态机与 GPU 资源管理占 40%，
  前置类与端到端回归占 20%。**事后核对：量级判断准确**——实际横跨阶段七十九~八十五、八十七、一百零四、
  一百一十二~一百一十七、一百二十八、一百三十一~一百三十二。
- **可行性**：✅ 技术完全可行，无不可逾越障碍；AGAL 翻译有成熟参照（Ruffle/开源 AGAL→GLSL），
  Metal/WebGL2/D3D12 裸管线是标准能力，项目已有的 GPU 呈现底子也确实被复用了。
- **决策与结论**：**已决定投入并交付**——立项时唯一的问题是「是否值得投入」（项目已有一条完整 2D GPU
  渲染链，Stage3D 的增量价值只在于「运行 Starling/Away3D 这类基于 Stage3D 的第三方引擎」，而非画普通 UI）。
  答案是**值得**：如今本项目能在 **macOS（Metal）、Windows（D3D12）、web（WebGL2）** 三端从 `.as`
  编译并跑起真实 Stage3D 工程（`shmup-stage3d`、away3d `Basic_SkyBox`、`air-starling-demo`、`Flappy-Starling`）。

---

## 9. 立方体贴图与纹理上传（阶段一百一十二 落地，一百一十三 修正 mip/采样器，一百一十四 定下共用队列，一百一十六 web 后端补齐，一百一十七 程序缓存，一百二十八 补齐 2D mip 链 + 无链丢弃 + 状态对象缓存）

`CubeTexture` 与 2D `Texture` 的**上传时机**、**mip 语义**、**立方体面**三件事都是在
把 headless `Basic_SkyBox`（away3d）跑起来的过程中实测定出来的，且它们**共同**决定
「3D 通道是否可见」——错了不会报错，只是纹理**静默**为空，窗口显示舞台背景
（Basic_SkyBox 曾因此**纯白**）。

### 9.1 上传是**同步**的（不是延迟到 draw）

AIR 的 `uploadFromBitmapData(source, …)` **当场**把像素交给 GPU；调用方随后
`source.dispose()` 是**合法且常见**的写法——away3d 的 `MipmapGenerator.generateMipMaps`
正是在上传完那张临时 `BitmapData` 的下一行 `mipmap.dispose()`。本运行时的
`BitmapData_dispose` 会把 `pixels` 置空，因此：

- 2D `Texture_uploadFromBitmapData`：命中的**立即**调用 `as_s3d_texture_from_pixels`
  （Starling 的文本框贴图同样「上传后立刻 dispose」，同一原因）。
- `CubeTexture_uploadFromBitmapData`：六个面无法一面一条 MTLTexture 地延迟上传，
  故**在 mip 0 把像素快照**成面自己的 `BitmapData`（写屏障同步），submit 时再建
  一张 `MTLTextureTypeCube`。

### 9.2 mip 链：立方体给完整链 + 2D 收应用上传的每一级（阶段一百一十三 修正，**阶段一百二十八 补齐 2D**）

**这是什么 bug**：环面的环境反射曾整片出现「细密网纹」（背景雪山从环身透出的高频噪声），
而天空盒正常。根因是**立方体贴图没有 mip 链**：AIR 的 `BitmapCubeTexture` 经
`MipmapGenerator.generateMipMaps` 把**每一级**都上传，away3d 的 AGAL 又写着
`<cube,linear,miplinear>`（§9.5）——于是 AIR 的环境反射是**逐级 mip 过滤**的；本运行时当年
为绕开延迟上传只留了 level 0，「被**放大**的天空盒看不出问题，被**缩小**的环面反射直接走样」。

- **`CubeTexture`**：现在按 `mipmapped:YES` 建 `MTLTextureTypeCube`，六个面先写 level 0，
  再用一次 blit（`generateMipmapsForTexture:`，同队列故排在当帧绘制批次之前，等其完成）
  生成 level 1..n。Metal 的盒式滤波与 CPU 侧 `MipmapGenerator` 产出同级内容，且**不依赖**
  延迟上传的顺序——这是比复刻 away3d 的软件 mip 生成更稳的做法。
- **2D `Texture`（阶段一百二十八 起）**：`uploadFromBitmapData(source, miplevel)` 的
  `miplevel != 0` 现在**按 AIR 的实测口径**真正上传该级（见 §9.12）——不再是「只收 level 0」
  的已知偏差。**一条如实记录**：away3d 的 `MipmapGenerator` 风格循环把**同一张** scratch
  位图逐级上传（`mipmap.draw(...)` 把缩小后的内容画回它自己），我们的区域规则会照搬 AIR
  读到的内容（左上 `lw×lh`、**按源的行距**读）——这正是 adl 的行为（`temp/mipprobe/` 的
  T5：逐级读回 `16/48/80/112`），所以 dot-for-dot 对齐，不额外「修正」应用自己写回的像素。
- **无链 + `miplinear` ⇒ 整 draw 丢弃**：`Texture.mips`（被任何 `miplevel > 0` 上传置位）
  是唯一判据，**不是** `createTexture` 的 `mipmapped` 标志（§9.12 T3/T4 实测）。

> 全量对照证据：`temp/ringdiag/`（修复前后逐张截图 + 与 AIR 参考的并排图）、
> `temp/ringdiag/mipfix-*.png`。

### 9.5 采样器状态来自 AGAL `tex` 标志位（阶段一百一十三 实测）

**为什么必须**：away3d 与 Starling **都从不调用** `setSamplerStateAt`（两棵树各 0 命中），
它们只写 AGAL 标志位：away3d 的环境贴图是 `<cube,linear,miplinear>`，天空盒
（`SkyBoxPass`）同样 `,miplinear`，Starling 是 `<2d,linear,nomip>` 一类。若运行时**忽略**这些位
（旧行为），滤/环绕/mip 就全凭自定的默认值——恰好与 away3d 的默认路径一致，**看着对**，
但 away3d 的 `useSmoothTextures = false` 分支要 `nearest`，会被静默渲染成双线性。

实测（AIR SDK 51.4.1；探针 `temp/sampprobe/`，13 例 × 2 次回读，逐例独立清屏色＋md5 版本戳）：

| 结论 | 证据 |
|---|---|
| **AGAL 标志位被执行** | 同一程序 `<2d,linear,nomip>` vs `<2d,nearest,nomip>`：2×2 纹理放大后中心呈**灰**（双线性平均）vs **纯色**（单纹素） |
| **`setSamplerStateAt` 覆盖标志位** | 例 A3/A4：setProgram 之后调，结果随显式调用 |
| **两者是「后写者胜」** | 例 A5：**先**调 `setSamplerStateAt`、再 setProgram → 结果随 AGAL 标志位 |
| **`miplinear` 真按 lod 选层** | uv 平铺 T=1/8/16/64（lod = log2(每像素纹素数) = log2(T/4)）→ 采到 level 0/1/2/4 的**各层专色**（红/绿/蓝/品红） |
| `nomip` / 显式 `MIPNONE` 不选层 | 例 B6/B7：同样平铺下仍为 level 0 |
| mip 过滤 + **无 mip 链**的纹理 → **整个 draw 被丢弃** | 例 A6：回读整片等于清屏色（AIR 视为无效组合）。**已落地**（阶段一百二十八，两端同条件；web 侧的丢弃点必须在 `glUseProgram` **之前**，否则 GL 采到不完整纹理读作**黑**而不是清屏色）——见 §9.12 |

实现：`as_agal_sampler_flags`（`runtime.ts`）在 `Program3D.upload` 时按 AGALMiniAssembler 的位域
（`filter` 28 / `mipmap` 24 / `repeat` 20 / `dim` 12）解出每个采样器寄存器的
`(filter, wrap, mip)`，打包进 `Program3D.samplerUsed/samplerFlags`；`Context3D_setProgram`
调 `as_s3d_apply_agal_sampler_state` 写进 GPU 的**同一份**每单元状态（`s3d_set_sampler_state_i`），
因此与显式 `setSamplerStateAt` 天然是「后写者胜」（AIR 语义）。注意 AGAL 的 filter 位
1 = linear，而 glue 的 `filter` 1 = nearest，跨界时取反。

> 此前 `miplinear` 曾退化为 level 0（`mipmapped:NO`）；现在立方体有链 + 采样器真的选层，
> 两者**缺一不可**——只补 mip 链而采样器仍是 `nomip`，环面依旧走样。

### 9.6 立方体贴图的 GPU 面

- 一张 `MTLTextureTypeCube`，六个面按 **AGAL/Stage3D 顺序 +X, −X, +Y, −Y, +Z, −Z**
  写入 —— 面是 texture **slice**，必须用带 `bytesPerImage` 的选择器
  （`replaceRegion:mipmapLevel:slice:withBytes:bytesPerRow:` 在立方体上**不存在**，
  发出去是 unrecognized selector，即硬崩，不是驱动的空操作）。
- **识别靠 vtable，先于任何形如 `Texture` 的字段读取**：`CubeTexture.face0` 与
  `Texture.gpu` 是**同一字偏移**，先读 `->gpu` 会把 `BitmapData*` 当 MTLTexture 用
  （Basic_SkyBox 早期就撞过 `objc_retain` 悬空指针）。
- AGAL 的 `<cube>` 维度把该采样器声明成 `texturecube<float>`（MSL）/ `samplerCube`
  （GLSL），坐标取 `.xyz`。

### 9.7 验收

`examples/away3d-core/Basic_SkyBox.as`（8 个 `[Embed]` 资源，含 6 张 512² JPEG
天空盒）headless 构建后渲染出**雪山天空盒 + 环境反射铬环**，与 adl 参照
（`temp/away3d/skybox-01-view.png`）同场景同构图；天空采样 (30,35,35) vs adl
(33,37,36)。环面的**反射清晰度**是阶段一百一十三 的验收点：修复前环身下半部是逐像素网纹，
修复后是与 AIR 同级的连续锐利镜像（`temp/ringdiag/ab-air-vs-ours.png`）。这些不变量
无法进 `examples/`（示例套件是纯 C、无 GPU），改由单元组 **`stage3d/texture-upload`**、
**`stage3d/mip-semantics`**、**`stage3d/dss-cache`**、**`stage3d/agal-sampler-flags`** 与
**`stage3d/gpu-queue-sharing`**（`test/unit/stage3d.ts`）钉在源级。阶段一百二十八 的三端验收
另有离屏 runnable 探针：`temp/mipprobe/`（mip 语义，18 行）与 `temp/bakeprobe/`（烘焙分辨率
与 `draw` 几何，20 行），两者 `adl == native(AOT) == web(AOT)` 逐行一致——见 §9.12、§9.13。

### 9.8 合成目标纹理**必须与 Skia 共用一条 `MTLCommandQueue`**（阶段一百一十四）

Stage3D 的离屏目标（`ASC_stage3d_tex`）是**同一帧内被先生后读**的：`ASC_window_render`
的顺序是 `as_s3d_flush_all()`（commit + `waitUntilCompleted`）→ 取 drawable →
`as_skia_mtl_draw_texture(canvas, ASC_stage3d_tex, …)`（Skia **采样**这张纹理）→
`as_skia_mtl_flush`（Ganesh `flushAndSubmit` + present）。**CPU 侧提交顺序**是对的，但
**GPU 侧的读与下一帧的写仍会重叠**，因为 Metal 的冒险跟踪（hazard tracking）**只在单条
队列内有效** —— 两条队列之间既无执行序保证、也无跨 command buffer 的冒险跟踪。

后果是一个很容易误判成「模型坏了」的画面：第 N 帧的合成读与第 N+1 帧的 Stage3D 写重叠，
**写胜出**，于是尚未被环形 pass 写到的 tile 停在该帧的天空盒（背景）上 ⇒ **物体沿垂直 tile
边界被直线切开、缺口处露出背景，而背景本身完好**。`Basic_SkyBox` 上 25 帧连拍命中 11 帧
（偶有一帧整幅画面的竖直接缝）。

**因此：`s3d_create` 必须采纳 Ganesh 那条队列**（`metal_glue.mm` 的进程级
`sk_mtl_shared_queue()`），而不是自建一条。要点：

- 该队列**持有到进程退出、永不释放**（`sk_mtl_destroy` 只置 `g_queue = nil`）：活着的
  Stage3D 上下文还在用它，且下一个窗口必须拿到**同一条**；
- `stage3d_glue.mm` 用 `__attribute__((weak_import))` 声明它 —— **headless Stage3D 构建会
  链接 `stage3d_glue.mm` 而不链 `metal_glue.mm`**（无窗口 ⇒ 无 Ganesh），此时符号不存在，
  上下文回落自建一条（恒 +1，与 `s3d_destroy` 的 release 配平）；
- 目标纹理本身无需改动：`MTLStorageModeShared` + `usage = RenderTarget|ShaderRead` + 默认
  `MTLHazardTrackingModeTracked`，正是同队列冒险跟踪生效的前提；
- **不要**用「提交时让 CPU 等 GPU」（Ganesh `GrSyncCpu::kYes`）代替共用队列：那会把每帧的
  CPU/GPU 串行化，正好吃掉阶段一百零四 用批量提交省下的 ~0.6 ms/帧。`MTLSharedEvent` 也不
  可行 —— 它需要一个「合成已读完」的可靠信号，而 Ganesh 给不出。

**验收**（`temp/ringdiag/cap.py`：窗口定位 + 光标预停窗口中心冻结相机 + 区域截屏连拍）：共用队列后
**390 帧零切割**（修复前 25 帧里 11 帧被切，`adl` 60 帧零撕裂）。

### 9.9 帧边界只 `commit`、**不** `waitUntilCompleted`（阶段一百一十五）

`s3d_flush` 分成两个风味，共用一条提交路径（`s3d_flush_impl(ctx, wait)`）：

| 风味 | 何时用 | 为什么 |
|---|---|---|
| `s3d_flush`（commit + wait） | `s3d_readback`、`s3d_readback_render`、`s3d_resize`、`s3d_destroy` | CPU 真的要**读**目标像素（AIR 的「读回拿到所画内容」契约） |
| `s3d_flush_async`（只 commit） | `Context3D.present`、`ASC_window_render` 合成前 | 只需让写在 **GPU 侧**合成之前落地 |

**关键是「CPU 可见」与「GPU 可见」不是一回事**：CPU 等待（`waitUntilCompleted`）只为了让写对
**CPU** 可见；而帧边界上真正要采样这张纹理的是 **GPU 侧的合成**，自 §9.8 起它与 Stage3D
**共用一条队列**，Metal 按提交序执行同一队列的 command buffer、并为默认 `Tracked` 的目标自动
插入依赖屏障 ⇒ 后提交的合成 buffer **不可能**在本批写落地前读到它。Ganesh 自己就是这么做的：
`sk_mtl_end_frame` 提交合成 buffer 时**完全不 wait**。若列表里有任何一条 **CPU 读回**，就必须
用带 wait 的那一支——`s3d_draw` 本身**从不** flush（批次只在帧边界退休一次）。

**实测**（`ASC_S3D_STATS=1`，`Basic_SkyBox`）：`gpu=0.13ms wait=0.00ms commit=0.01ms
per-batch draws/batch=2.0` —— 阶段一百零四 账上的 `wait≈0.93ms/帧`（整帧 GPU 只有 0.34ms、
120Hz 预算 8.33ms 的 ~11%）降到 `commit≈0.01ms/帧`；同轮重测阶段一百零四 的容量：Starling
`showStats` 惩罚 **−6.4%/−5.0% → 归零**（OFF 61238 / ON 61603 峰值对象数）。

**验收方法（参考无关）**：截屏域的逐像素掩码不可用——相机 yaw 是鼠标偏移的**累加和**（跨运行
姿态不可比）、天空盒的**云会动**、窗口服务器还会给截屏叠色彩管理抖动（一次运行内静态天空角落的
逐像素 max−min 达 103）。故改用**只认「贯穿环带的竖直线」的检测器**（每列
`V(x)=|I(x+1)-I(x)|` 的行均值，扣掉左右邻列与同列在整串里的时间中位数）：320 帧 max **15.96**
（median 5.34），而贴一条 10px 宽另一姿态竖条的灵敏度自检为 **24.88**；两处缺陷的缝都是这样的
竖直线（AGAL `kil` 的世界 x=0 半平面、跨队列撕裂的 tile 边界），真实环体轮廓是**曲线**
（任一一列上只有少数几行有边）。

### 9.10 web 后端（`vendor/stage3d_webgl.cc`）的三处对齐（阶段一百一十六）

阶段一百一十三 把「AGAL 采样器标志位」与「立方体整条 mip 链」先落在 Metal 侧，WebGL 胶水
**没跟上**——而 `s3d_*` 的签名是两端共用的**同一个 seam**（生成 C 零改动就换后端），于是
`away3d-core` 与 `air-starling-demo` 的 web 构建都在**链接期**倒在 `undefined symbol:
s3d_set_sampler_state_i / s3d_upload_cube_texture`。三处对齐：

1. **纹理 target 注册表**：GL **无法回答**「这个纹理对象的 target 是什么」（没有 `glGetTexParameter`
   式的查询），所以胶水自己记：`struct S3DTexTarget{GLuint id; int cube;}` + `texTarget[64]/texTargetN`
   注册表（`s3d_record_target`/`s3d_tex_gltarget`），上传时登记、draw 时**逐单元按登记的 target 绑定**、
   销毁时清理。**空单元必须同时清 `GL_TEXTURE_2D` 与 `GL_TEXTURE_CUBE_MAP`** —— 只清 2D 时，
   上一次留在该单元的 cube 绑定会被下一个 **2D** 采样器读到（实测的失效形态：不是「没绑定」）。
2. **cube 上传 + mip 链**：`s3d_upload_cube_texture` 逐面 `GL_TEXTURE_CUBE_MAP_POSITIVE_X + face`
   上传 level 0，随后 `glGenerateMipmap` 生成整链（选 GPU 生成而非复刻 away3d 的软件 mip，与
   §9.2 的 Metal 口径一致）；cube 另设 `GL_TEXTURE_WRAP_R`（3D 环绕轴，2D 无此参数）。
3. **清屏必须显式打开写掩码**：这是本轮唯一一个**只在 web 侧**的渲染 bug——**`glClear` 受 GL 写掩码
   管辖**（`glColorMask`/`glDepthMask`/`glStencilMask`），而 Metal 的 `loadAction=Clear` **不受**。
   某个 pass 的 `depthWrite=false` 会把 `GL_DEPTH_WRITEMASK` 留成 0，于是 `s3d_draw` 的**延迟深度清屏
   被静默跳过** ⇒ 上一帧的近深度挡住天空盒（z≈1.0）与之后所有绘制，`Basic_SkyBox` 的环体就变成
   **实心黑圆盘**（黑盘 = 各帧环体轮廓的并集，逐 draw 探针实测 RGB 恒 `(0,0,0,255)`）。修法：清屏前
   `glDepthMask(GL_TRUE); glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE); glStencilMask(0xFF);` 再 `glClear`；
   各 draw 自带掩码，故不会泄漏给后续 pass。

**回归钉子**：`test/unit/stage3d.ts` 的 **`stage3d/webgl-abi`** 把「**运行时调用的每个 `s3d_*` 都必须
在 WebGL 胶水里定义**」钉成结构不变量（去注释后做「引用 ⊆ 定义」比对，并具名点出上面两个入口），
另钉 target 注册表、空单元清双 target、清屏前强制三掩码。（模拟把两个入口从胶水里删掉的 pre-fix
文本，该组会当场列出那两个符号。）

---

### 9.11 程序缓存：同一条程序是「绑定」，不是「重编译」（阶段一百一十七）

**为什么值得单列**：这是 `Basic_SkyBox` **62 MB/min 内存增长**的真根因，也是一个容易被「看着能跑」掩盖的类别——**画面完全正确**，只是驱动侧在不停地造对象。

**现象与定性**：窗口激活后 RSS 线性 +62.4 MB/min；`footprint` 差分显示增量 **100% 在 `MALLOC_SMALL`**（不是 GC 堆、不是 GPU/IOSurface）；`leaks` 只报 304 KB（全是系统 XPC）⇒ **对象仍有引用，不是不可达泄漏**；`heap` 在 44 s 时报 **10,790 个 `MTLVertexDescriptor`**（≈ 2/帧）与 68,706 个 `CFString`。

**根因**：发射侧的程序守卫是**深度 1** 的（`o->program != o->gpuProgram` = 「与**上一次**不同才重编」），而一个场景**逐 draw 交替两套材质**是常态（`Basic_SkyBox` 就是铬环 1600 三角 + 天空盒 12 三角相间）⇒ 守卫每 draw 都命中。计数探针一句话钉死：**`compile=7980, make_pso=7980`，draw 也是 7980**。每条 `MTLRenderPipelineState` 都带着新建的 `MTLVertexDescriptor` 交给 Metal，驱动**管线缓存长期持有它** ⇒ 永不回落。web 后端同形且更重（还多 512 次 `glGetUniformLocation`）。

**修法（两后端同形）**：`s3d_compile` 增加 **Program3D 身份**参数（`emit.ts` 传 `o->program`），胶水内维持 `S3DProgramCache progs[16]`（LRU）+ `s3d_prog_stash`/`s3d_prog_load`，**命中即绑定、绝不进驱动编译器**——语义就是 AIR 的 `Program3D.upload()` 编译一次 / `setProgram()` 只绑定。两个必须注意的点：

1. **槽位身份 = 指针 + 源码哈希**（FNV-1a 64 位）。同一个 `Program3D` 可以被**重新 `upload`** 新字节码，只比指针会静默复用过期管线。哈希类型必须 `unsigned long long`：**wasm32 的 `unsigned long` 是 32 位**，`ULL` 常量在那里溢出（且 `-Werror` 直接让 web 构建失败）。
2. **命中的判定必须早于第一次驱动编译**（Metal 早于 `newLibraryWithSource:`、WebGL 早于 `glCreateShader`）——只有顺序对了才叫修复；顺序错了照样每 draw 重编。

**复查探针（保留）**：`AS_S3D_TRACE=1` 每 60 draw 报一行计数器。判据是**比值**：`make_pso` 必须跟随**程序数**（本 demo = **2**），**绝不能**跟随 **draw 数**（修复前是 1:1）。`ASC_S3D_DUMP=1` 仍可逐 draw 看状态（本轮就是靠它确认环体/天空盒的 depth 状态相间，见遗留表「每 draw 重建 `MTLDepthStencilState`」一行）。

**回归钉子**：`stage3d/program-cache`（17 条，`test/unit/stage3d.ts`）。

---

### 9.12 2D mip 链与「无链丢弃」：三条 adl 实测定案（阶段一百二十八）

先补 adl 口径（探针 `temp/mipprobe/`：AGALMiniAssembler + 8×8 BGRA 贴图 + 256 px 视口，
`T` = uv 平铺数 ⇒ `lod = log2(T/32)`；每例独立清屏色，故「被丢弃」在回读里表现为清屏色）：

| 结论 | 证据（`temp/mipprobe/adl.txt`） |
|---|---|
| 丢弃的触发条件是**「从未上传过任何 level > 0」**，**不是** `createTexture(..., mipmapped=true)` | T1 `texN`（标志 false、只传 L0）`nomip` → **RED**（画了）；T2 同纹理 `miplinear` → 全 = 清屏色（**丢弃**）；T3 `texY`（标志 **true**、只传 L0）`miplinear` → **丢弃**；T4 同纹理 `nomip` → RED |
| 上传一级的口径是**区域规则**：取**源位图左上 `lw×lh`**（`lw = max(1, width>>level)`），**按源的行距**读 | T5 `texC`（把整幅 8×8 条带按 level 1/2/3 各传一次）`miplinear T64`：预期外随机色却在 y0..y3 读到 `16/48/80/112`，正是源位图第 0..3 行（行距 8 而非 4） |
| 正确尺度的各级读回**恰好等于上传值**，且 lod 只选一层 | T6 `texD`（L1 行 40/120/200/240、L2 70/210、L3 130）→ `y0..y3 = 40/120/200/240`；T7（lod −2）→ RED（level 0） |

**实现**（一份生成 C + 两端 glue）：

- `Texture`/`RectangleTexture` 增私有 `mips` 计数（任何 `miplevel > 0` 上传置 `1`，level 0
  上传清 `0` 并重建纹理）；`Texture_uploadFromBitmapData` 的 `miplevel != 0` 分支自
  `max(width,height)` 算层数、拒绝 `miplevel >= nlv`、取 `lw/lh = max(1, w>>miplevel)` 并
  **钳到源位图尺寸**，走新 seam `as_s3d_texture_upload_level(ctx, gpu, level, lw, lh, pixels, srcW)`。
- 绑定侧把「有无链」传下去（2D 传 `o->tex{i}->mips`、立方体传 `1`）：
  `s3d_bind_texture(gpu, unit, tex, hasChain)`。
- 丢弃规则两端**同一个条件**：`c->samplerStateSet[i] && c->samplerMip[i] != 0 &&
  c->texHasMips[i] == 0 && 纹理非空` ⇒ 整 draw 丢弃。Metal 侧走一个 `loadAction=Clear` 的
  空 pass **消费掉挂起的清屏色**（回读即清屏色）；WebGL 侧**必须放在 `glUseProgram` 之前**。
- 代价：Metal 的 2D 纹理一律 `mipmapped:YES`（~33% VRAM，换来「随时可上传任何一级」）；
  WebGL 只在真的上传了 level > 0 时才付这份显存。

**验收**：`temp/mipprobe/` 18 行 `adl == native == web` **逐位相同**，唯一差异是尾行
`END-OF-SCENE (sync)` vs `(frames)`（headless 构建无帧循环，同步跑完即结束）。

### 9.13 状态对象缓存与逐 draw 重建（阶段一百二十八）

away3d 的铬环与天空盒**逐 draw 交替**深度状态（`ASC_S3D_DUMP=1` 实测 `depth=(less,w=0)` 与
`depth=(lessEqual,w=1)` 相间），而 `s3d_rebuild_dss` 原来每次状态变化都**新建 + 释放**一个
`MTLDepthStencilState` ⇒ `dss=8039 / draw=8040`（**不泄漏，只是抖动**：每 draw 一次驱动对象
分配）。改为**按键值缓存**：`S3D_MAX_DSS 16` 个槽 + `S3DDssVariant`（键 = 状态字段快照，
`s3d_key_str` 把调用者的字符串**拷进槽内**，`depthCompare` 一并入键），`s3d_select_dss` 命中
复用、未命中才新建并 `asc_tr_dss++`（**计数器只统计创建**，故 `dss` 数直接读作「真实对象数」），
满 16 槽按 LRU 淘汰；生命周期按「槽持有 +1、`c->dss` 借用」整理。**实测（`Basic_SkyBox`，
1680 draws）**：`TRACE draw=1680 compile=1680 make_pso=2 pso_miss=0 dss=2 smp_miss=1
bindtex=1679 cube=1 uptex=0 mipbuild=0 mipdrop=0`，截图 204748/204800 像素非黑。

另记一处与浏览器/链接器有关的口径：`sk_mtl_shared_queue`（§9.8）在 `stage3d_glue.mm` 里原以
`__attribute__((weak_import))` 声明，而**现代 macOS 链接器仍把它当未定义符号** ⇒ headless
Stage3D 构建（链 `stage3d_glue` 而不链 `metal_glue`）会链接失败；阶段一百二十八 改成
`dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue")` 惰性查找（函数指针缓存，取不到用自有队列），
普通清单即可链接。钉子在 `stage3d/gpu-queue-sharing`。

### 9.14 纹理尺寸上限与 `Context3D.ignoreResourceLimits`（阶段二百二十七）

AIR 的纹理尺寸校验**不是一条规则，而是三条**，顺序也是可观测的：`#3681` 零尺寸 →
`#3682` 非 2 的幂 → `#3683` / `#3705` / `#3766` 超上限。全部是 `ArgumentError`，全部在
分配之前抛。数值来自 adl 51.4.1 实测（`temp/adlprof/`，`PROBE_MODE=edge`）：

| 入口 | 上限 | 上限随 profile 变？ |
|---|---|---|
| `createTexture` | 2048 / 4096 | ✅ `baseline` = 2048，`baselineExtended` 起 = 4096 |
| `createCubeTexture` | **恒 1024** | ❌ 七档全一样 |
| `createRectangleTexture` | 2048 / 4096，**且不小于 backbuffer** | ✅ 但**没有** 2 的幂规则（4097 报 `#3766` 不是 `#3682`） |

**上限与 `profile` 回读同源**，两者都取自 `as_s3d_max_texture_size()`：`>= 4096` ⇒ 报
`baselineExtended` 并按 4096 校验；只有 2048 ⇒ 报 `baseline` 并按 2048 校验。
**承诺与强制不会漂**——不会出现「报了 4096 却按 2048 拒绝」或反过来。
该查询由三后端各自回答：D3D12 / Metal 恒 16384（`D3D_FEATURE_LEVEL_11_0` / Apple GPU 家族下限），
WebGL2 现查 `GL_MAX_TEXTURE_SIZE`（`< 2048` 回落 2048），无渲染后端的纯 C 状态机给 4096。

**一条刻意的跨端差异：无后端路径 ≠ AIR 的 `software` 模式。** adl 51.4.1 实测
（`temp/adlprof/run-caps.js`，`PROBE_MODE=caps`）：AIR 的 `requestContext3D("software", p)` 只在
`p == "baseline"` 时交出上下文，`baselineExtended` / `enhanced` **一律异步**抛
`ErrorEvent #3702: Context3D not available.`；而拿到上下文的那一档也锁在 baseline——
`createTexture(4096)` 报 `#3683 (max is 2048x2048)`、`rgbaHalfFloat` 报 `#3759`、MRT 5 参报 `#3779`，
`maxBackBuffer` 也只有 2048×2048。**我们未链接 Stage3D 后端的纯 C 状态机则照常建上下文、
报 `baselineExtended`、按 4096 校验**——理由是此时纹理只存在于 CPU 状态机里，4096 的两维边界
不占一分显存。这条差异**不静默**（`driverInfo` 如实报 `"Software (state machine)"`），并已按
AGENTS.md §1.5 登记为增强（`TODO.md`「增强待做」与该文件的 E17），刻意保留、不随 AIR 收紧。

#### `ignoreResourceLimits`（AIR 50.0+，默认 `false`）实际做了什么

文档只说「忽略 profile 关联的**软**资源上限」，没说什么算软。逐项实测（`PROBE_MODE=ign`，
`baseline` / `baselineExtended` / `enhanced` 三档结论一致）：

| 检查 | 旗标关闭 | 旗标打开 |
|---|---|---|
| 零尺寸 | `#3681` ArgumentError | `#3681` ArgumentError（**不变**） |
| 2 的幂 | `#3682` ArgumentError | `#3682` ArgumentError（**不变**） |
| 2D 上限 | `#3683` ArgumentError | 跳过 → 真分配 → 超硬上限报 `#3684` |
| cube 1024 | `#3705` ArgumentError | 跳过 → **仍然** 1024，报 `#3684` |
| rect 上限 | `#3766` ArgumentError | 跳过 → 一路放到**设备上限 16384** |
| 对象个数（4096） | 实测 4300 个仍可建（约束是内存不是计数） | 同左 |

两件容易踩的事：① **错误类型会变**（`ArgumentError` → `Error`），`catch (e:ArgumentError)`
再也接不到；② AIR **自己**在旁路之后 2D 仍然卡在 profile 上限——`baseline` 下即使打开旗标，
`createTexture(4096,1)` 也报 `#3684`，`enhanced` 下 `8192` 同样报 `#3684`。也就是说这个开关
在 AIR 上**并没有真正把 2D 纹理放大**，只是把错误从参数错误换成了分配失败。

#### 我们的取舍：默认与 AIR 逐字一致，打开旗标后放到设备上限

`ignoreResourceLimits = false`（默认）：与 AIR 完全一致，包括三个错误号、文案与判定顺序。
`= true`：`#3681`/`#3682` 照旧，`#3683`/`#3766` 跳过，**上限改为设备上限**
（`as_s3d_max_texture_size()`，D3D12/Metal 为 16384）而不是 AIR 的 profile 上限，超出时报
`Error #3684: Texture creation failed. Internal error.`。这是**唯一的刻意分歧**，且是
**双重 opt-in**（AIR 合法属性 + 默认关），默认产物仍与 AIR 同构。

**cube 刻意不放大**：保持 1024，旗标打开时只把错误号换成 `#3684`（与 AIR 同）。理由是
16384 的立方体贴图 = 6 GB 纹理内存，现实中零需求，而放大它只会把「明确报错」变成「后端分配失败」。
若将来真要放开，改 `as_tex_check_cube` 一处即可。

**未闭合（不静默）**：旗标打开后，我们只按**设备上限**放行，并不预检像素总量；
2D/rect 的 GPU 分配是**惰性**的（`optimizeForRenderToTexture=false` 时 `gpu` 留空，等上传时再建），
后端分配失败目前不会立刻变成 `#3684`。该缺口已在 `TODO.md` 遗留表登记。

**验收**：`examples/stage3d-profile.as` 67 条断言（含旗标默认值、`#3681`/`#3682` 不受影响、
`#3683` → `#3684` 的类型变化、复位后恢复）；`test/unit/stage3d.ts` 的
`stage3d/texture-size-limits` 10 条源级钉子（含「零/幂次检查必须在旗标分支之前」）。

## 10. Windows / Direct3D 12 后端（阶段一百三十二 落地）

第三份后端 `vendor/stage3d_d3d.cc`（~2,290 行）与 `stage3d_glue.mm`（Metal）/**结构同形**：同一套 `s3d_*` ABI、
同一个「帧边界批量提交」模型、同一套语义取舍（§9.1–§9.13 的每一条都逐条移植），只是把 Metal 对象换成 D3D12 对象。
它消费的是阶段一百三十一 的 **AGAL → HLSL** 翻译器（`ASC_S3D_HLSL` ⇒ `target 2`），构建期接线见
`docs/zh-cn/win32.md` §3.4。下面只记**与 Metal 不同、或 D3D12 特有**的口径。

### 10.1 提交模型：三缓冲槽位 + 延迟释放队列

Metal 的 `MTLCommandBuffer` 天然是「提交即对象化」，D3D12 那边一切都要自己管：

- **每条批一条命令列表**（`s3d_batch_begin` → draw… → `s3d_batch_end`），`Close()` 后
  `ExecuteCommandLists(1, …)`。**帧边界**（`s3d_flush_async`）只提交当前批，不等待（与 §9.9 同口径）。
- **三缓冲帧槽**（`S3D_FRAMES_IN_FLIGHT = 3`）：`c->slot` 指名**下一批**用哪个槽；`s3d_batch_begin` 先
  `s3d_wait_slot(idx)` 等该槽的 fence 值走完、再 `Reset` 该槽的命令分配器；`s3d_batch_end` 信号
  `fenceValues[idx] = ++fenceNext` 并推进槽号。每槽各有一份上传堆（UPLOAD heap），故三帧并行时 CPU
  写常量缓冲不会触发为上一帧缓冲区已在使用中。
- **常量缓冲：区域按 draw 版本化**（阶段一百七十三）。**D3D12 在 GPU 执行命令列表时才读常量**（帧末），
  而生成的 C 在**每次** `drawTriangles` 前重传整个寄存器文件 ⇒ 每帧槽一份常量缓冲会让该帧**所有** draw 都读到
  **最后一次**上传的矩阵。实测（`examples/air-starling-demo`）：12 个按钮**全部**被最后一个按钮的 mvp 变换，
  只有最后一个落在原位。Metal 用 `setVertexBytes` 内联拷贝，**天生免疫** ⇒ 只在 Windows 暴露。
  现改为每次上传独占一个 4096 B 区域（`S3D_CB_REGION` = 256 float4 = HLSL 能声明的最大 cbuffer，
  `S3D_CB_BYTES = S3D_CB_REGION * S3D_DRAWS_PER_FRAME`），draw 绑定**该 stage 最后一次上传的区域**
  （`GetGPUVirtualAddress() + cbOffV/cbOffF`，4096 对齐即 CBV 合法）。**游标在 `s3d_batch_end` 归零**，
  **不在 `batch_begin`**：一帧的**首次**上传发生在批次打开**之前**（生成 C 在状态设置与 `drawTriangles` 之间
  传常量），在 begin 归零会抹掉它刚写的区域 —— 实测表现为**前两个 draw 共用区域 0**（`cbV=0,0,4096,…`），
  画面上背景与 logo 一起消失。同理 **`s3d_wait_slot` 留在 `s3d_upload_constants` 内**（首次上传没有
  `batch_begin` 的等待保护，其余上传是空操作），否则 CPU 可能写一块正被 GPU 读的 UPLOAD 内存。
  寄存器文件超过一个区域时**响亮拒绝**（`need > S3D_CB_REGION` 直接返回 0 并打印，绝不截断）。
- **延迟释放队列**（`S3DRelease rel[4096]`，每条带一个 fence 值；`s3d_defer_release` 按
  `fence->GetCompletedValue()` 排空）——D3D12 没有"命令缓冲释放时自动降引用"这回事，任何换掉的
  资源都必须等其最后一帧真的跑完再 `Release()`。
- **描述符堆**：CBV_SRV_UAV 按帧槽一个大 arena（`S3D_DESCS_PER_FRAME = 512*8`）、RTV（64）、DSV（16）。
  **采样器堆另算**：一开始想做"每帧一个采样器 arena"，但 D3D12 的采样器堆**上限 2048 个描述符**
  （`12288` 直接 `E_INVALIDARG`）；改为**按采样器状态向量缓存不可变块**（`S3D_MAX_SMPLCFG 256` × `S3D_MAX_TEX`），
  同一组 STATE 重复命中，故实际占用是个位数块。

### 10.2 PSO 缓存：键是**整个绘制状态**

D3D12 没有 Metal 那种"随时能改状态"的 encoder，`ID3D12PipelineState` 是**不可变**的，一切可绘状态都必须
烘进 PSO。故缓存键是所有影响管线的字段的拼接（`srcHash|writeMask|depthWrite|depthCompare|stencil*|dsNeeded|cullMode|blendOn|blendSource|blendDest|streamSig`），
每条程序最多 `S3D_MAX_PSOVAR = 16` 个变体、全局 `S3D_KEY_CAP 256`、LRU 淘汰。
**键里必须是「因子对」，不能只是「开不开混合」**：混合因子烘进 PSO，换一对因子就要换一条 PSO，
只记 `blendOn` 会让第一次用的那对因子（Starling 的 `normal`）被复用到所有模式 —— 症状与定案见 §10.6。这比 Metal 侧（§9.13 的 DSS 缓存）
更硬：`SetPipelineState` 是纯指针绑定，但**建 PSO 很贵**（需编译 vs_5_1/ps_5_1 字节码）。

### 10.3 一个只能实测发现的 D3D12 链接规则：**字段声明顺序即寄存器号**

HLSL 的 `VSOut` 里 `varyingN : TEXCOORDN` 必须排在 `position : SV_Position` **之前**。fxc 按**声明顺序**给
stage 结构体编号，D3D12 的 VS→PS 匹配同时看语义名+索引**和该寄存器号**；`SV_Position` 放第一位时，
VS 侧的 `TEXCOORD0` 在 reg 1、PS 侧的 `TEXCOORD0` 在 reg 0 ⇒
`CreateGraphicsPipelineState` 报「Signatures between stages are incompatible」。MSL/GLSL 对字段顺序不敏感，
故**只有 HLSL 档**需要这条（钉子：`stage3d/agal-hlsl` 的「HLSL declares the varyings before SV_Position」）。
同族的两个 D3D12 陷阱：① 输入布局的 `SemanticName` 必须是**裸名**（`"TEXCOORD"`）而索引放 `SemanticIndex`——
写成 `"TEXCOORD0"` 会 `E_INVALIDARG`；② `D3D12_RASTERIZER_DESC` **没有** `ScissorEnable`（与 D3D11 不同），
关闭的剪刀在 draw 时展开成整目标矩形并按目标边界夹取。

### 10.4 合成（把 3D 的帧交给 Skia 画到窗口里）

- `s3d_get_render_target` 返回**裸 `ID3D12Resource*`**（不是 `S3DTexture*`），因为它唯一的消费者是
  `vendor/d3d_glue.cc` 的 `sk_gpu_draw_texture`。合成**借用**该资源：所有权仍在 Stage3D 上下文，
  合成只在自己那次调用里临时多拿一份引用。
- **这里的"借用"是 D3D 后端最深的陷阱**：Skia 的 D3D 后端**没有** Borrow/Adopt 的概念，
  `GrD3DTextureResourceInfo::fResource` 是 `gr_cp<ID3D12Resource>`，而它的**裸指针形构造器是"接管"
  （不 AddRef）而析构会 Release**。把自己唯一的那份引用递进去 = 送出所有权（细节、症状与正确写法见
  `docs/zh-cn/win32.md` §2.9）。合成与 swapchain back buffer 两处包装点都已改用 `fResource.retain(...)`。
- 后端用**同一条** `ID3D12Device`/命令队列（§3.4 of `win32.md`），故 `sk_gpu_draw_texture` 不需要任何
  CPU 侧等待；但**优先级**仍是 "Stage3D 的批已提交、提交序在合成之前"。
- 目标必须是 `R8G8B8A8`/`BGRA8` 且非多重采样，否则**响亮拒绝**且不画（`unsupported render target ...`，
  只打一次）。
- 合成用 **`SkBlendMode::kSrc`**（不是默认的 `kSrcOver`）：AIR 呈现 Stage3D 后缓冲时**忽略其 alpha**，
  四条合成路径（D3D12 / Metal / web-GL / CPU 光栅）都必须如此，理由与 adl 实测见 §10.6。

### 10.5 验收（已做）与**未验收**（不静默）

**已做（2026-10-10 本机 x86 `--air-app`）**：

- `examples/shmup-stage3d`（1000x600、`renderMode=direct`、`depthAndStencil=true`、`requestedDisplayResolution=high`）
  **开窗、跑到 281 帧 / 5 s（~56 fps）**，逐帧 `get_render_target` 都拿到 `desc(dim=3 fmt=87 1000x600)`、
  每次 `draw_texture` 都被接受，**零** `unsupported render target`；fence 单调推进。
- **客观像素证据**：`ASC_GPU_DUMP=<路径> ASC_GPU_DUMP_AT=40` 导出的 **presented back buffer**
  （1500x900 BMP，4,050,054 B）里能看到 demo 的 **Stage3D 精灵**（spritesheet 分块在右上、HiDPI 缩放）。
  ——**判定 Stage3D 是否上屏只能靠这个 dump，不能靠屏幕截图**：flip-model swapchain 的内容取不到
  GDI/BitBlt（截到的是陈旧/全黑）。
- 开发期的脚手架（`s3d_watch` 一族生命周期探针）**已从产品代码移除**；`get_render_target` 的诊断行保留
  但改成**周期性**（`n++ % 120 == 0`），正是它把上面那个悬空指针的根因印了出来。

**已补做（阶段一百七十三，2026-10-16 本机 x86 `--air-app`）**：

- `examples/air-starling-demo`（127 个源文件 + 完整 Starling）**已实机跑通**：开窗、资源加载完成、
  **26 个 draw / 246 个三角形**（12×9 九宫格 + 12 条标签 + 背景/logo/`infoText`，几何一个不少）全部就位。
  期间修掉的**结构性**缺陷 = 上面 §10.1 的「常量区域按 draw 版本化」（每帧槽一份常量缓冲 ⇒ 一帧内所有
  draw 都读最后一次上传的 mvp）。
- **与 `adl 51.4.1` 逐项对照**（同机、同 150% 缩放；adl 侧用 `temp/win_shot.ps1` 抓窗口客户区，我们侧用
  `ASC_GPU_DUMP` 的 presented 后缓冲）：logo 的红像素包围盒在**客户端坐标下同为 `x32..173 y10..196`**、
  按钮节距同为 **69 px**（= 46 pt × 1.5）、两列按钮的行/列偏移与 12 条标签逐一对应。

**未验收（不得宣称更大范围）**：
- **背面剔除/绕序**：`FrontCounterClockwise = FALSE` + 正高度 viewport（不 Y 翻转）是**纸面推论**
  （与 §关于 D3D 也是行 0 在顶一致），未做剔除的 A/B 实测。同理：DXGI **调试层**本轮未开（PSO 的
  `E_INVALIDARG` 靠 `temp/psoprobe.cc` 的 InfoQueue 戳出来的，产品路径未开）。
- **Mip-drop / 立方体贴图**这些语义已按 §9 逐条移植且有文本级钉子，但**未在 D3D12 上单独复测**
  （`air-starling-demo` 覆盖了 `setProgram` 切换、深度/模具、多流 `drawTriangles` 与纹理图集，
  但没覆盖立方体贴图）。**混合因子已补齐**：阶段一百七十五 用 Blend Modes 场景把 6 对因子逐一对过 adl（§10.6）。
- `Context3D.drawTriangles` 的 `firstIndex` **被忽略**（`(void)firstIndex;`，索引缓冲整段上传）。
  对 Starling（恒 `drawTriangles(ib, 0, n)`）无影响，对别的 Stage3D 应用是潜在偏离 —— 放入遗留表。

### 10.6 混合模式（`Context3D.setBlendFactors`）对齐：三处必须同时正确（阶段一百七十五）

`examples/air-starling-demo` 的 **Blend Modes** 场景（`DisplayObject.blendMode` → `BlendMode.activate()` →
`context.setBlendFactors(sf, df)`）里「切换没有效果」**不是**一个缺陷，而是三个叠在一起、各管一类的缺陷。
所有数字都是同一场景逐像素对 adl 51.4.1（同机、同 150% 缩放；adl 侧抓窗口客户区，我们侧抓客户区）：

| 模式（Starling） | 因子对 (sf, df) | 修复前 vs adl | 修复后 vs adl |
|---|---|---|---|
| normal | one / oneMinusSourceAlpha | 3.69% | 3.70%（对照：本就正确） |
| multiply | destinationColor / oneMinusSourceAlpha | 13.68% | 3.54% |
| screen | one / oneMinusSourceColor | 10.59% | 2.00% |
| add | one / one | 10.22% | 1.71% |
| erase | zero / oneMinusSourceAlpha | 13.80% | 1.91% |
| none | one / zero | 12.93% | 3.75% |

（百分比 = 差异像素占比；基准是**同一场景未受影响的 normal 模式的 3.7%**，那 3.7% 是字体/抗锯齿层面的固有差异，
不是混合缺陷。`erase` 的可见症状最直观：修复前是**白色**火箭剪影、adl 是**黑色**；`none` 修复前的 12.93% 次之。）

（口径：我们的窗口客户区 480×870 与 adl 的 459×814 裁剪在 **@0,0** 对齐后逐点比（隔 2 px、`|ΔR|+|ΔG|+|ΔB| > 24` 记一次差异）；
复算脚本 `temp/pngdiff2.cjs`，对齐偏移由搜索得出（结果就是 0,0）。运行间确定性 0.02% ⇒ ≥2% 的差异都是真差异。）

1. **PSO 键必须含因子对**（§10.2）。键里原本只有「是否开混合」这一个布尔，于是程序第一次混合用的因子对
   （Starling 的 `normal`）被**复用**到所有模式 —— 实测 5 次「Switch Mode」只动了 0.3% 的像素，动的全是标签。
   Metal 侧的 `stage3d_glue.mm` 早就按因子对建键（它的文件头注释写的就是这条症状）。
2. **alpha 槽的因子必须做 `*_COLOR → *_ALPHA` 翻译**。Stage3D 只有**一对**因子（色彩与 alpha 共用同一对），
   Metal 把同一对交给两个色彩附件 slot 是合法的，D3D12 **不是**：alpha 槽里出现 `*_COLOR` 是非法枚举，
   `CreateGraphicsPipelineState` 把**整条** PSO 判成 `E_INVALIDARG (0x80070057)`，调试层原话
   `SrcBlendAlpha[0] is trying to use a D3D11_BLEND value (0x9) that manipulates color, which is invalid`
   （用 `temp/blendprobe.cc` + 调试层独立复现）。建不出 PSO ⇒ 该模式**每一次 draw 都被静默丢掉**，
   这正是 multiply/screen 「完全没效果」的直接原因。翻译到 alpha 孪生因子（`s3d_blend_factor_alpha`）不只是绕开报错：
   ERASE (`zero / oneMinusSourceAlpha`) 只有在被擦像素的 **alpha 真的到 0** 时才算擦掉
   （Starling 就是靠它擦 RenderTexture）。
3. **合成必须忽略后缓冲的 alpha**（§10.4）。AIR 呈现 Stage3D 后缓冲时**不看 alpha**：把上下文清成
   `(1, 0, 0, 0.25)` 与 `(1, 0, 0, 1.0)`（stage 颜色设成不透明绿），adl 窗口里同一像素**都是 `(255,0,0)`** ——
   绿色从不透过半透明后缓冲。故 `sk_gpu_draw_texture`（D3D12）/ `sk_mtl_draw_texture`（Metal）/
   `sk_gl_draw_texture`（web GL）/ `sk_canvas_draw_bgra`（CPU 光栅）四条合成路径都改用 **`SkBlendMode::kSrc`**，
   而非默认的 `kSrcOver`：ERASE 把 RGB **和** alpha 一起清零，`kSrcOver` 会让 stage 颜色透出来（白色剪影），
   `kSrc` 才得到 adl 的黑色。**这一条只在「后缓冲有像素的 alpha 不为 1」时才与旧行为不同**，
   故其余 12 个场景逐像素基本不变（实测 `BlendModes` / `RenderTexture` 与修复前差异 0.06%）。

**钉子**：`test/unit/stage3d.ts` 的 `stage3d/d3d-glue` 组（键含因子对、alpha 槽翻译函数及其两处使用、
四条合成路径都 `kSrc`）。

## 11. 参考链接

- AIR SDK 参考（`flash.display3D` 包）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/package-detail.html>
- AIR SDK 参考（`Context3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html>
- AIR SDK 参考（`Program3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Program3D.html>
- Ruffle（AGAL → wgpu/WebGPU Stage3D 实现）：<https://github.com/ruffle-rs/ruffle>
- AGAL 字节码格式参考（Flash 官方）：<https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/AGAL.html>
