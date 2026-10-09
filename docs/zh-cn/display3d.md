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
| 隐式依赖 | `flash.geom.Matrix3D`、`flash.geom.Vector3D`、`Vector.<Number\|uint\|float>`、`ByteArray`（小端读） |

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

## 10. 参考链接

- AIR SDK 参考（`flash.display3D` 包）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/package-detail.html>
- AIR SDK 参考（`Context3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html>
- AIR SDK 参考（`Program3D`）：<https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Program3D.html>
- Ruffle（AGAL → wgpu/WebGPU Stage3D 实现）：<https://github.com/ruffle-rs/ruffle>
- AGAL 字节码格式参考（Flash 官方）：<https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/AGAL.html>
