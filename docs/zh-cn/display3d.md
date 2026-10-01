# Stage3D（`flash.display3D`）对齐调研与集成方案

> 本文回答一个问题：**是否可以把 AIR SDK 的 `flash.display3D.*`（Stage3D）对齐到本项目**，如果能，怎么落地。
> 核心结论先行：**可以实现，且不是架构推翻，而是对现有 GPU 基础设施的一次有边界的扩展**；但它是本项目迄今
> 最重的一块（等价于再造一个小型 3D 图形 API 运行时），核心难点是 **AGAL 字节码 → 原生着色器语言
> （MSL/GLSL）的翻译**。缺口集中在「3D GPU 资源 + 状态机 + AGAL」这一整块，而非散点补齐。
>
> 定位：Stage3D 之于本项目，等价于阶段三十六~三十八「链接 Skia 而非自研光栅化」的**同构扩展**——
> 它替换的是「可编程 GPU 三角形管线」那一层（裸 MTLBuffer/渲染通道/MSL），**不是** `flash.display.*` 的
> 2D 显示列表/事件那一层。显示列表层叠关系与事件流语义不变，Stage3D 只是新增一个独立的 GPU 渲染通道，
> 与 2D 表面在窗口合成阶段汇聚。

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
| 常量类 | 15 个：`BlendFactor`/`BufferUsage`/`ClearMask`/`CompareMode`/`FillMode`/`MipFilter`/`Profile`/`ProgramType`/`RenderMode`/`StencilAction`/`TextureFilter`/`TextureFormat`/`TriangleFace`/`VertexBufferFormat`/`WrapMode` |
| 隐式依赖 | `flash.geom.Matrix3D`、`flash.geom.Vector3D`、`Vector.<Number|uint|float>`、`ByteArray`（小端读） |

> 注意 `AGALMiniAssembler`（`com.adobe.utils.*`）**不是运行时**，是纯 AS3 工具类——只要编译器能编译它的
> 源码，它就作为用户代码跑（只做字符串解析 + 位打包，产出 `ByteArray`）。所以不需要特殊运行时支持，
> 但真实 Starling/Away3D 项目都依赖它，验收时要用它做端到端。

---

## 2. 现状盘点（已具备 vs 缺失）

| 项 | 状态 |
|---|---|
| 2D 渲染闭环 | ✅ Skia CPU raster + GPU（native **Metal** `metal_glue.mm`、web **WebGL2** `web_glue.cc`）+ SDL2 窗口 |
| `ByteArray`（含 grow/compress/uncompress） | ✅ 已实现 |
| `Point`/`Rectangle`/`Matrix` | ✅ 已实现 |
| `Vector.<T>` 类型系统 | ✅ 已建模 |
| `Stage3D` / `Context3D` / `display3D.*` | ❌ 完全未实现（`TODO.md` 明确 `stage3Ds` 属未建模类型） |
| `Matrix3D` / `Vector3D` | ❌ 未实现 |
| **原生 GPU 三角形管线** | ❌ 现有 Metal 后端只是「Skia Ganesh → Metal + flush」，**没有**裸 `MTLBuffer`/渲染通道/MSL 编译能力 |

结论：**缺口集中在「3D GPU 资源 + 状态机 + AGAL」这一整块**，而非散点补齐。

---

## 3. 核心技术难点：AGAL 翻译（唯一真正「难」的点）

Stage3D 的着色器是 **AGAL（Adobe 图形汇编语言）二进制字节码**，不是 GLSL/HLSL/MSL。`Program3D.upload()`
收的是字节码，运行时负责把它翻译成目标平台的着色器语言。

- **结构**：magic `0xa0` + version + program type + shader type，之后是一串 32-bit token
  （`opcode | dest | src1 | src2 | swizzle/mask`），≤200 指令/程序。
- **寄存器模型**（按 version 分档，详见 AGALMiniAssembler `initregmap`）：`va`（attribute，v1/v2=7、v3=15）、
  `vc`（vertex constant，v1=127、v2/v3=249）、`vt`（temp，v1=7、v2/v3=25）、`op/oc`（output）、
  `v`（varying，v1=7、v2/v3=9）、`fc`（fragment constant，v1=27、v2=63、v3=199）、`ft`（v1=7、v2/v3=25）、
  `fo`（v1=0 仅 `oc`、v2/v3=3 即 MRT）、`fd`（v2/v3 深度输出）、`fs`（sampler）；AGAL3 独有 `iid`（实例化）、`vs`（顶点纹理采样）。
- **指令集**：约 28 条基础指令（`mov/add/sub/mul/div/rcp/min/max/frc/sqt/rsq/pow/log/exp/nrm/sin/cos/dp3/dp4/crs/m33/m34/m44/abs/neg/sat/kil/tex` 等），
  带 swizzle 与 write-mask；AGAL2 扩展控制流（`ife/ine/ifg/ifl/els/eif`）+ 导数（`ddx/ddy`）+ MRT；AGAL3 扩展实例化与顶点纹理采样。

**翻译方案是成熟且确定性的**：
- native：AGAL → **MSL**（`newLibraryWithSource` 编译），寄存器映射为 `float4`、`tex` 映射为 `texture2d.sample()`。
- web：AGAL → **GLSL ES**（WebGL2）。
- **权威参照**：Ruffle 已实现 Stage3D（AGAL → wgpu/WebGPU），社区有多个 AGAL → GLSL 开源实现，
  语义规则（swizzle/mask/寄存器约束/校验错误清单）在 `Program3D.upload` 的 40+ 条校验错误里被完整定义。

这一段是**纯 C/C++ 胶水层里自包含的确定性翻译器**，不碰前端「翻译 AS3→C」的主管线，符合 AGENTS.md §2.9
「重活走链接/胶水」铁律。真正的体力活在 AGAL 校验器（40+ 条错误）与 AGAL1/2/3 三代的扩展
（MRT、实例化、`iid` 寄存器、`fragment output index`）。

---

## 4. 分层对齐方案（关键：能复用已有东西）

| 层 | 方案 |
|---|---|
| 前端（AST/lexer/parser） | 零改动。`Context3D` 等全是普通内建类，走 `symbols.ts` 建模 + `runtime.ts` 助手 |
| 运行时状态机 | `Context3D` 是纯状态机（blend/depth/stencil/cull/scissor/colorMask/fillMode + 当前绑定的 buffer/program/texture/constants），C 结构即可 |
| GPU 资源 | `metal_glue.mm` 扩展：`MTLBuffer`（顶点/索引）、`MTLTexture`（2D/cube/rect）、`MTLLibrary`（MSL）、`MTLRenderPassDescriptor`（render-to-texture）、`MTLDepthStencilState` |
| 上屏合成 | Stage3D 的 back buffer 与 Skia 2D 表面合成到同一窗口（display3D 层在显示列表之上/之下），复用现有 SDL2/Metal 呈现路径 |
| web | `web_glue.cc` 扩展裸 WebGL2（`createBuffer`/`shaderSource`/`drawElements`），或复用现有 Ganesh 上下文 |
| 前置类 | `Matrix3D`（透视投影/append/recompose）、`Vector3D` —— 纯逻辑，与 `Matrix` 同套路 |

`AGALMiniAssembler`（`com.adobe.utils.*`）**不是运行时**，是纯 AS3 工具类——只要编译器能编译它的源码，
它就作为用户代码跑（只做字符串解析 + 位打包，产出 `ByteArray`）。所以不需要特殊运行时支持，但真实
Starling/Away3D 项目都依赖它，验收时要用它做端到端。

---

## 5. 构建与链接

Stage3D 的落地复用阶段三十六~三十八已有的「胶水层 + 构建清单」能力，只做**增量扩展**，不新增构建范式：

| 关注点 | 说明 |
|---|---|
| 胶水层 | 在 `metal_glue.mm`（native）/ `web_glue.cc`（web）里新增 AGAL→MSL/GLSL 翻译器 + GPU 资源管理函数，仍用 `extern "C"` 暴露平坦 C 接口 |
| 前置类 | `Matrix3D`/`Vector3D` 是纯 AS3 逻辑类，走现有 `symbols.ts` 内建建模，不碰 GPU |
| 构建清单 | 无需新增第三方库——Metal（macOS 系统框架）与 WebGL2（浏览器内建）均无需额外 `-l`；复用现有 `metal_glue.mm` 的 `-framework Metal -framework QuartzCore` 链接 |

> **Metal 头文件与框架**：`metal_glue.mm` 已存在于阶段七十五（native Metal 渲染后端），`MTLDevice`/`MTLCommandQueue`
> 的创建与 `SkSurface::MakeFromBackendRenderTarget` 的 Ganesh 集成已落地。Stage3D 复用的是「同一 `MTLDevice` 上的
> **裸** Metal 命令缓冲」，而非再走 Ganesh——Ganesh 是 Skia 的 2D 抽象，Stage3D 的三角形管线要直接 `MTLBuffer` +
> `MTLRenderPipelineDescriptor`，两者在同一 `MTLDevice` 上共存、经同一 `MTLCommandQueue` 提交，最后共享一个 drawable 上屏。

> **落地现状（native = 阶段八十二~八十三，web = 阶段八十九·三十）**：没有塞进 `metal_glue.mm`/`web_glue.cc`，
> 而是各自独立的自包含胶水文件，暴露**同一套平坦 `s3d_*` C 签名**：
>
> | 目标 | 文件 | 着色器 | 构建开关 |
> |---|---|---|---|
> | native (macOS) | `vendor/stage3d_glue.mm` | 裸 Metal，AGAL→MSL | `ASC_RENDER_STAGE3D=1` |
> | web | `vendor/stage3d_webgl.cc` | WebGL2/GLES3，AGAL→GLSL ES | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_GLSL=1`（有 `<depthAndStencil>` 时再加 `ASC_RENDER_DEPTH_STENCIL=1`） |
>
> 因此生成的 C 里的 `Context3D` 状态机、`as_s3d_*` 包装器、AGAL 翻译器调用点**两端完全相同**，
> 着色器语言只由构建期 `ASC_AGAL_TARGET` 选择。web 侧的 GL↔AS3 语义差异（Y 轴翻转、BGRA 交换、
> 逐寄存器 uniform、FBO/模板、CPU 读回上屏及其代价）见 [`html5-web.md`](html5-web.md) §3.3。
> 是否挂载后端由 `src/air-app.ts` 的 `detectStage3D(files)` 扫源码自动判定（native 与 web 都适用）。

---

## 6. 建议的分阶段路线（对应现有「阶段XX」约定）

| 阶段 | 目标 |
|---|---|
| **A 前置** | `Matrix3D` + `Vector3D` + `Vector.<Number/uint/float>` 补全（纯逻辑，风险低） |
| **B AGAL 内核** | AGAL 字节码解析器（AGAL1/2/3）+ 校验器 + →MSL/GLSL 翻译器（**最硬的一步**，单独一阶段） |
| **C Context3D 骨架** | `Stage3D` + `Context3D` 状态机 + `VertexBuffer3D`/`IndexBuffer3D`/`Program3D`/`Texture`(BGRA/RGBA) + `drawTriangles`，`enableErrorChecking=false` 走异步 |
| **D 端到端** | Metal 裸管线落地，跑通「彩色三角形」demo，再铺开 blend/depth/stencil/cull/scissor/render-to-texture |
| **E 对齐加固** | `drawToBitmapData`、`setRenderToTexture`、CubeTexture/RectangleTexture、AGAL2/3 的 GPU 端到端上屏（MRT render pass / 实例化） |

**内核翻译器支持 AGAL1/2/3 三代；首期 `Context3D.profile` 收敛到 baseline（AGAL1 能力 + 非压缩 2D/cube 纹理 + 无实例化/MRT）**——这正好覆盖 Stage3D 的最大
真实消费者 **Starling**（2D-on-GPU 框架）。

### 6.1 最终验收 demo：`examples/shmup-stage3d`

> 该 demo 是阶段七十九~八十三的**最终端到端验收目标**——全部落地后，本项目应能把它从 `.as`
> 编译为原生可执行文件并跑出与 `mxmlc + adl` 一致的画面。

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
  八十二（Metal 端到端）全部完成后即可编译运行，无需等阶段八十三的 MRT/实例化。
- 它**不依赖** AGAL2/3 特性（无 `ife`/`ddx`/MRT/`iid`），因此是验证「baseline 是否闭环」的精确探针；
  阶段八十三（AGAL2/3 上屏）的验收另行用专门 demo 覆盖。
- `build-and-run.sh` 用 `mxmlc -swf-version=13` + `adl`（`renderMode=direct`）编译运行，
  符合 AGENTS.md §2.4 的「以 `mxmlc` 为参考编译器、同一份 `.as` 对照验证」约定——本项目编译它时，
  以该脚本产出的画面/行为为基准对照。

---

## 7. 风险与「明确不建议对齐」的边界

| 项 | 判断 |
|---|---|
| `VideoTexture` | ❌ 依赖 `NetStream`/`Camera`（视频解码），**排除**，返回 null |
| 压缩纹理（ATF/DXT/PVRTC） | ⚠️ **部分**（阶段八十九·二十一）：ATF 容器的 `format 3/5`（裸 DXT1/DXT5）已实现——运行时 `as_atf_decode_dxt` 在 CPU 解码为直通-alpha ARGB 后走普通纹理上传路径（不预乘，与 adl 把裸 DXT5 交给 GPU 一致；mip 1+ 未解码、只取 level 0）；ETC1/PVRTC、cubemap 与 `format 0xc/0xd`（JPEG-XR 有损）仍**响亮报错**（`Error #3680`），不静默出空图 |
| `driverInfo`/`totalGPUMemory`/`profile` 精确上报 | `driverInfo` 已按「上下文级后端」上报：链接了 `stage3d_glue.mm`（`ASC_RENDER_STAGE3D`）即 `"Metal (Stage3D)"`，否则 `"Software (state machine)"`（**不看**只表示窗口合成后端的 `ASC_RENDER_METAL`）；`profile` 固定 `"baseline"`；`totalGPUMemory` 已实现但为**近似值**（阶段八十九·二十一：后台缓冲 BGRA8 字节数 + 有深度模板时再加 D32S8 字节数）——它必须存在，因为 Starling `StatsDisplay.supportsGpuMem` 用 `"totalGPUMemory" in context` 探测并据此增删整个 HUD 行 |
| `enableErrorChecking=true` 的同步抛错 | 可选，先只做 `false` 异步路径 |
| AGAL2/AGAL3 的 GPU 端到端上屏（MRT/实例化） | 翻译在内核阶段（阶段八十）已覆盖；Metal 侧的 MRT `[[color(i)]]`、AGAL3 `iid` → `[[instance_id]]` 上屏延后到阶段八十三 |

---

## 8. 工作量与结论

- **工作量**：这是「小型 GPU 运行时」级别，粗估相当于现有「阶段三十三~四十（事件+显示列表+渲染+窗口）」
  这一整段的量级，AGAL 翻译器 + 校验器约占 40%，`Context3D` 状态机与 Metal/WebGL 资源管理占 40%，
  前置类与端到端回归占 20%。
- **可行性**：✅ 技术上完全可行，无不可逾越障碍；AGAL 翻译有成熟参照（Ruffle/开源 AGAL→GLSL），
  Metal/WebGL 裸管线是标准能力，且项目已有 Metal/WebGL2/GPU 呈现的底子可复用。
- **唯一要决策的**：是否值得投入——因为项目已有一条完整 2D GPU 渲染链，Stage3D 的增量价值只在于
  「运行 Starling/Away3D 这类基于 Stage3D 的第三方引擎」，而非画普通 UI。

---

## 9. 参考链接

- AIR SDK 参考（`flash.display3D` 包）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/package-detail.html>
- AIR SDK 参考（`Context3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html>
- AIR SDK 参考（`Program3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Program3D.html>
- Ruffle（AGAL → wgpu/WebGPU Stage3D 实现）：<https://github.com/ruffle-rs/ruffle>
- AGAL 字节码格式参考（Flash 官方）：<https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/AGAL.html>
