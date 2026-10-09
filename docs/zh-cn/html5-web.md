# HTML5 / Web 渲染 — 实现与使用

> 本文回答：**如何把 AS3 程序编译成浏览器里的 HTML5 渲染视图，以及背后的实现约束。**
> 目标组合：`--target wasm --package web`。定位：`compile.md`（多目标构建）与
> `skia.md`（渲染后端）的浏览器化补充。
>
> 状态：**已实现并端到端验证通过**（蓝色矩形 + `TextField` 文字 + 运行时字体注入，
> 浏览器 canvas 内正常渲染，无运行期崩溃；完整 AIR demo 在 120 Hz 面板上实测
> **`FPS:120` / 单帧 0.11 ms（GPU 光栅，帧预算占用 1.35%）**，见 §3.2 与
> `temp/web-fps/EVIDENCE.md`）。**Stage3D 已落地**：`examples/air-starling-demo`（142 个 AS3
> 源、整套渲染都走 `Context3D`）编译到 web 后在浏览器里 12 个场景全部正常渲染，内容与 AIR
> `adl` 参考一致（web 版 Stage3D = WebGL2 后端，见 §3.3；120 fps / 0 丢弃 / 单帧 2.88 ms）。

---

## 1. 目标与产物

`--target` 定机器码 ABI，`--package` 定分发形态，二者正交。浏览器目标表述为
`--target wasm --package web`，用 Emscripten `emcc` 编译，产出三件套：

| 产物 | 说明 |
|---|---|
| `<base>.html` | 页面入口：`<canvas>` + 字体注入引导脚本（`index.ts` 生成，非 emcc 默认 shell） |
| `<base>.js` | Emscripten JS 胶水（加载 wasm、提供 `Module` 运行时） |
| `<base>.wasm` | wasm32 机器码（Skia CPU 光栅 + 生成的 C + web 胶水层） |

对比其他组合：

| target | package | 后端 | 产物 |
|---|---|---|---|
| wasm | raw（默认） | wasi clang `--target=wasm32-wasip1` | 裸 `.wasm`（WASI 命令行模块） |
| wasm | **web** | emcc（Emscripten） | `.wasm` + `.js` + `index.html` |
| native | raw | cc | 裸可执行文件 |
| native | xcode-project | 生成 Xcode 工程 | macOS `.app` 工程 |

`web` 硬性要求 `target=wasm`（`src/index.ts` 分派时校验）；`--target wasm --package raw`
保持现状（WASI 命令行模块，`examples/wasm-native/` 的 shim 即加载它）。

**产物是成套的（构建失败不会回滚已写出的中间产物）**：一次成功的 web 构建写出
`.html`/`.js`/`.wasm`（app 目录被预打包进 FS 时还有 `<base>.data`）**同一批**产物。若在**链接期**失败
（例如后端少一个 `s3d_*` 入口：`undefined symbol`），已写出的 `.c`/`.data` 会留在磁盘上，而 `.wasm`
仍是**上一次成功**的版本 ⇒ 页面就变成「素材全部解不开、白屏卡在加载」（旧 wasm 按新 `.data` 的偏移
读资源）。见到构建报错后请**重跑到成功**，不要继续用旧页面。另：**浏览器会静默复用旧的
`.js`/`.wasm`**（不重新校验）—— 核对新构建时换端口或加查询串，否则看到的可能是上个月的产物。

**相对资源 URL 以页面所在目录为基准**：`--air-app` 生成清单里的字体/素材条目（`assets/fonts/Ubuntu-R.ttf`、
`assets/textures/2x/…`）与 app 的 `File.applicationDirectory.resolvePath("assets/…")` 都按**页面所在目录**
解析，因此这类项目必须**就地**构建（`-o` 指向 app 目录）；产物挪到别处会素材/字体 404，典型现象是
「按钮皮肤在、文字全无」。`--air-app` 还会把 app 目录整体 `preload` 进 `<base>.data`（字体另经
`preload-excludes` 排除，见 §6.1）。

## 2. 快速开始

```bash
# 需要 Emscripten SDK（提供 emcc）+ wasm 版 Skia（vendor/skia/lib/wasm/）
export EMSDK_HOME=/path/to/emsdk

as-aot examples/web/hello-web.as \
  --manifest examples/web/hello-web.build.json
```

产物生成在 `examples/web/` 下：`hello-web.html` + `hello-web.js` + `hello-web.wasm`。
浏览器不能 `file://` 直接加载 wasm，需经 HTTP 服务（`python3 -m http.server` 等），
打开 `hello-web.html` 即可看到蓝色矩形 + `TextField` 文字。

> ⚠️ **服务端要把 `.wasm` 标为 `application/wasm`**（`python3 -m http.server` 3.9+ 已正确）。
> 标成 `application/octet-stream`（部分简易静态服务器，以及 AgentPilot 内置预览面板）时
> Chrome 会拒绝 `WebAssembly.instantiateStreaming`，控制台出现两行红色错误：
> `wasm streaming compile failed: … Incorrect response MIME type. Expected 'application/wasm'.`
> 与 `falling back to ArrayBuffer instantiation`。**这两行是良性的**——emscripten 随即回退到
> ArrayBuffer 编译，页面照常运行（两行日志下面紧接着就是应用自己的 `trace()` 输出）。
> 代价只是 wasm 被下载两遍、且失去边下边编。本仓库的验收服务器
> `temp/netprobe2_server.py` 显式设了该 MIME，故它的运行日志里没有这两行。

AIR 项目（`--air-app`）同样支持 web 目标，一条命令从 `app.xml` 编到浏览器，无需手写 manifest：

```bash
as-aot --air-app examples/air-native/air-native-app.xml --target wasm --package web
```

`--air-app` 适配器会自动切到 web 后端（`web_glue.cc` + wasm 版 Skia，去掉 SDL2/`objc`/Cocoa
framework）。字体来自 app.xml 的 `<embedFonts>`（读每个 `<font><fontPath>` 生成 `font-urls`，
缺省时回退到 `fonts/Arial.ttf`），产物为 `air-native.html` + `.js` + `.wasm`。

`<initialWindow><renderMode>` 控制 GPU/CPU 渲染分工（web 目标）：

| renderMode | 构建清单 define | 光栅化后端 | 呈现路径 |
|---|---|---|---|
| `auto`（缺省）| 无 | CPU（`SkSurfaces::Raster`） | `putImageData` |
| `cpu` | 无 | CPU（`SkSurfaces::Raster`） | `putImageData` |
| `direct` | `ASC_RENDER_GPU=1` | **GPU（Ganesh `GrDirectContext` + WebGL2）** | `GrDirectContext::flush` |
| `gpu` | `ASC_RENDER_GPU=1` | **GPU（Ganesh `GrDirectContext` + WebGL2）** | `GrDirectContext::flush` |

`direct`/`gpu` 均走完整 GPU 光栅化（效率优先，不对齐 AIR 官方「direct = CPU 合成 + GPU blit」
的分割）：Skia surface 由 `SkSurfaces::Raster` 换成 Ganesh 后端，直接渲染进 WebGL2 默认
framebuffer（FBO 0），整帧在 GPU 上合成（字形 atlas、渐变、滤镜全变 GPU 纹理/draw），
present 只是 `GrDirectContext::flush()`，不再有 CPU↔JS 逐像素拷贝。这去掉了 CPU 软件光栅化
瓶颈——之前该瓶颈把 web 锁在 ~60 fps。

示例 manifest（`examples/web/hello-web.build.json`）要点：

```json
{
  "target": "wasm",
  "package": "web",
  "sources": ["../../vendor/skia_glue.cc", "../../vendor/web_glue.cc"],
  "include-paths": ["../../vendor/skia"],
  "link-libs": ["skia", "skparagraph", "skshaper", "skunicode", "skcms",
    "wuffs", "png", "jpeg", "webp", "webp_sse41", "freetype2", "harfbuzz", "icu"],
  "link-paths": ["../../vendor/skia/lib/wasm"],
  "defines": ["ASC_USE_SKIA=1", "ASC_USE_WINDOW=1"],
  "font-urls": ["fonts/Arial.ttf"]
}
```

字段差异（对照 native 清单）：

- **不链接 `zlib`**：web 链接用 `-s USE_ZLIB=1`，Emscripten 同时提供 zlib 头文件与符号；
  显式 `-l zlib` 反而可能冲突。
- **新增 `font-urls`**：字体字节流 URL 列表，见 §4。

## 3. 实现架构

复用 `vendor/skia_glue.cc` 的 `extern "C"` 平坦接口（生成的 C 只调 `sk_*` 符号，渲染
像素逻辑与 native 完全一致）。浏览器侧的差异集中在两个胶水文件：

| 关注点 | native | web |
|---|---|---|
| 图形光栅化 | `SkSurfaces::Raster`（CPU 离屏） | 同左；`renderMode=direct/gpu` 时用 Ganesh（`GrDirectContext` + WebGL2） |
| 字体后端 | `SkFontMgr_New_CoreText()`（枚举 macOS 系统字体） | `SkFontMgr_New_Custom_Data()` + 运行时注入（§4） |
| 窗口 / 上屏 | SDL2 `SDL_PollEvent` 阻塞循环 | `vendor/web_glue.cc`：cpu 模式 `putImageData` blit；direct/gpu 模式 `GrDirectContext::flush` |
| 帧驱动 | SDL 事件循环（自走时，`SDL_Delay` 到截止期） | `emscripten_set_main_loop` + **rAF 整 tick 节拍**（§3.2） |
| 输入 | SDL 事件 | `emscripten_set_mousedown_callback`/`mouseup`/`wheel` |
| Stage3D | `vendor/stage3d_glue.mm`（Metal + MSL 着色器） | `vendor/stage3d_webgl.cc`（WebGL2 + GLSL ES 着色器，§3.3） |
| 网络（`flash.net`） | libcurl（opt-in `ASC_HAVE_CURL`） | 浏览器 `fetch`（opt-in `ASC_HAVE_FETCH`，见 §3.4）；无后端时诚实 `ioError` |

`vendor/web_glue.cc` 保持与 `window_glue.cc` 相同的 `extern "C"` 签名
（`sk_window_*` / `sk_surface_peek_pixels` 等），因此生成的 `.c` **无需任何改动**
即可在 native 与 web 两个后端间切换。

### 3.1 上屏：premultiplied alpha 直贴 canvas

`present_frame` 用 `EM_ASM` + `putImageData`，从 `sk_surface_peek_pixels` 取像素直接贴
canvas。像素是 premultiplied alpha：**不透明像素精确**；半透明像素有色差（canvas 语义
与 Skia 的 premultiplied 差异），是已知限制（§6）。

### 3.2 帧驱动与节拍（frame pacing）

浏览器没有 `SDL_PollEvent` 那种可以阻塞等待的事件循环，帧由
`emscripten_set_main_loop(main_loop, 0, 1)` 驱动，实际节拍来自 **requestAnimationFrame**。
三条与 native 后端不同的推论：

1. **rAF 跟随窗口所在面板的刷新率**。这是硬上限：50 Hz 屏上无论什么渲染后端都到不了 120 fps。
   多显示器且刷新率不同时（本机：内置 XDR 120 Hz + 外接 MateView 50 Hz），rAF 速率取决
   于窗口**当时在哪块屏上**，与代码无关。
2. **一次 rAF 回调 = 一个 vsync**。合成器只认 tick，不认时间戳。
3. **`sk_window_get_display_refresh()` 在 web 返回 0**（浏览器无 `SDL_GetDisplayMode` 对应物），
   所以刷新率由 `main_loop` 自己**实测**：连续回调间隔的**中位数**（16 槽环）。取中位数
   而非均值/EMA，是为了让一次长回调（GC 停顿、首帧字体光栅、切标签页、拖窗口）无法把
   估计值带偏——均值会被拽走一秒以上，从而整段时间选错除数。

节拍按**整 tick** 表达：设刷新周期 `rp`（实测中位间隔）、目标帧间隔
`interval = 1000 / Stage.frameRate`，则

```c
skip = (int)(interval / rp + 0.5);   // 每 skip 个 vsync 呈现一帧
if (skip < 1) skip = 1;              // 目标高于刷新率 → 每个 vsync 都画
```

帧间隔因此恒为该面板刷新周期的整数倍；面板给不出的速率（如 60 Hz 屏上要 24 fps，需 2.5 个
vsync）取最近的可行除数，请求永不远于半个 vsync。与 native SDL2 后端一致（其 present 同样
受 vsync 约束，见 `emit.ts` 的 `ASC_window_on_frame_delay`：超过刷新率的 frameRate 被压到刷新率）。

> **不要**用「时间戳是否过截止期」来节拍（`if (now < next_tick) return;`）。rAF 时间戳在真实
> vsync 附近抖动——本机 120 Hz 面板实测 p50 8.30 ms / p95 9.30 ms，周期 8.333 ms。只要某次
> 回调早到几百微秒，判定就失败、这一 tick 被丢掉，而下一次回调在一个完整 vsync 之后（早已
> 过点）才被采用，于是丢/取交替、**速率减半**：实测 rAF 给 120 次/秒，pacer 只呈现 **66 fps**、
> 每秒丢弃 54.5 次回调（用户报的「FPS 无法达到 120」）。

**帧率诊断（编译期旋钮）**：浏览器里没有 env（native 的 `ASC_FRAME_STATS` 是运行时
`getenv` 旋钮），故 web 侧对应物是编译期 define，默认不编译进产物：

```bash
as-aot --air-app <app.xml> --target wasm --package web -D ASC_FRAME_STATS=1
```

开启后每秒把一段摘要发到 `window.__ascFrameStats`：`frames`（实际呈现帧数 = 达成 fps）、
`loopcalls`（收到的 rAF 回调数）、`skips`（pacer 主动丢弃数）、`renderMs`
（`on_frame + on_redraw + present` 耗时）、`rafPeriodMs`（实测刷新周期）、`skip`（选定除数）。
`loopcalls` / `frames` / `skips` 三者把「为什么没到目标」拆开：`loopcalls≈frames` → rAF 本身就
慢（刷新率上限）；`skips 大` → 节拍问题；`renderMs/frames` 逼近 `rafPeriodMs` → 真·渲染瓶颈。
配套测量脚本见 `temp/web-fps/fps_probe.mjs`（会把窗口钉到指定显示器再采样）。

### 3.3 Stage3D（WebGL2）后端

**为什么必须有**：Starling 的渲染**全部**经 `Context3D`（`drawTriangles` → 离屏 render target →
末道 `present` 把渲染目标贴到舞台）。没有 Stage3D 后端时，`as_s3d_*` 包装器全部退化为 no-op
（`ASC_RENDER_STAGE3D` 未定义），`Context3D_present` 贴出一张空图——页面一片空白但没有报错。
故「Starling demo 编译到 web」=「必须实现 web 版 Stage3D 后端」。

**文件与开关**：

| 关注点 | 说明 |
|---|---|
| 后端实现 | `vendor/stage3d_webgl.cc`（~700 行，WebGL2/GLES3），实现与 `stage3d_glue.mm` **完全相同的 `s3d_*` 平坦 C API** |
| 着色器语言 | 构建期由 `ASC_AGAL_TARGET` 选择：Metal 走 MSL（target 0），web 走 GLSL ES（target 1，`ASC_S3D_GLSL`） |
| 构建清单 | `ASC_RENDER_STAGE3D=1` + `ASC_S3D_GLSL=1`（链接 `vendor/stage3d_webgl.cc`）；应用描述符含 `<depthAndStencil>` 时再加 `ASC_RENDER_DEPTH_STENCIL=1` |
| 检测 | `src/air-app.ts` 的 `detectStage3D(files)` 扫源码，**native 与 web 两个目标**都据此决定是否挂后端 |
| 共享性 | 生成的 C 里的 `Context3D` 状态机、`as_s3d_*` 包装器、AGAL 翻译器调用点**两端完全相同**（后端差异只在这两个胶水文件） |

**WebGL 与 AS3/Metal 的语义差异（必须显式处理）**：

1. **Y 轴方向**：GL 的渲染目标行 0 在**下**，AS3/Metal/`BitmapData` 行 0 在**上**。修法是在
   GLSL 顶点阶段末尾统一 `gl_Position.y = -gl_Position.y;`——这样纹理采样仍保持 `v=0` = 顶部
   （与 AS3 一致），`glReadPixels` 读回的行序也直接与 Skia canvas 对齐。绕序随之翻转，故 GL
   保留默认的 `GL_CCW` 为正面（对应 AS3 的 `Clockwise`）。
2. **像素字节序**：AS3 的 `uint32` 像素字是 `0xAARRGGBB`（直通 alpha），GL 的 `RGBA8` 需要
   上传/读回时做 BGRA↔RGBA 交换。
3. **逐寄存器常量 uniform**：沿用既有 GLSL 翻译器的声明形态，`vc0..vcN`/`fc0..fcN` 各为一个
   `uniform vec4`，每帧按寄存器 `glUniform4fv` 上传。
4. **属性槽位**：链接前对 prog 逐个 `glBindAttribLocation(prog, i, "va<i>")`，使
   `setVertexBufferAt(stream i)` == GL 的 attribute i，无需查询。
5. **深度/模板**：离屏 FBO（RGBA8 颜色 + 可选 `DEPTH24_STENCIL8` renderbuffer）按需惰性创建
   （对应 Metal 侧的「只在需要时挂 D32S8」），模板按 `frontAndBack` 用
   `glStencilFuncSeparate`/`glStencilOpSeparate`。
6. **采样器状态**：GL 把过滤器/环绕状态存在**纹理对象**上，故按纹理对象缓存（键 = GL 纹理名）
   以避免每次绘制重复六次 `glTexParameteri`。
7. **与 Ganesh 共存**：**单一共享 WebGL2 上下文**（Emscripten 的 GL 调用都发往当前上下文），
   每个触碰 GL 的 `s3d_*` 入口调用 `sk_gr_reset_context()`（`resetContext()` 只是一个脏位标记，
   很便宜），否则 Ganesh 会复用被我们改过的 GL 状态。
8. **WebGL2 缺 `glGetTexLevelParameteriv`**：`GL_TEXTURE_WIDTH` 不可用，故渲染目标纹理尺寸
   由 `S3DRtTex{id,width,height}` 注册表自己记账（`s3d_destroy_texture` 同步摘除）。
9. **AGAL 比较指令的全掩码形态**（阶段八十九·三十二）：MSL 侧用 `select(float4(0.0), float4(1.0), a >= b)`，
   而 GLSL ES 1.00 没有 `select`，唯一可用的是 `mix(vec4(0.0), vec4(1.0), vec4(greaterThanEqual(a, b)))`——
   `mix(genType, genType, genType)` 是 ES 1.00 §8.3 的合法重载，`vec4(bvec4)`（逐分量 bool→float 构造）
   由 §5.4.2 明文允许；反之 `mix(vec4, vec4, bvec4)` 是 **ES 3.00 才有的重载**，在我们的 GLSL（不带
   `#version`，按 ES 1.00 编译）下编不过。⚠️ 实现上**不能**把两个目标写成「一个 `sprintf` + 三元格式串」：
   两支的 `%s` 个数不同（MSL 4 个、GLSL 5 个）而 varargs 是同一份固定列表，会静默错位成
   `v0(greaterThanEqual(v0, vec4))`（`vec4` 是裸标识符）→ `')' : syntax error`，四个 opcode
   （`sge`/`slt`/`seq`/`sne`）在 web 上全部失效（Starling 的「Switch Filter」崩溃即此，阶段八十九·三十二）；
   必须各写一个独立 `sprintf`。

**上屏路径（GPU 直连，阶段八十九·三十一）**：`Context3D_present` 在
`#if defined(ASC_RENDER_METAL) || defined(ASC_RENDER_GPU)` 下取渲染目标句柄
（`ASC_stage3d_tex = as_s3d_get_render_target`），Metal 走 `as_skia_mtl_draw_texture`，GL 走
`sk_gl_draw_texture(canvas, texId, w, h, dx, dy, dw, dh)`——后者用 `GrBackendTextures::MakeGL`
（`GL_TEXTURE_2D` / `kRGBA_8888`）把渲染目标的 GL 纹理包成 `GrBackendTexture`，
`SkImages::BorrowTextureFrom`（`kTopLeft_GrSurfaceOrigin` / `kPremul`）后 `drawImageRect` 直接画进
Skia canvas，**不再 `glReadPixels` 回内存**。读回路径（`as_s3d_readback_render` +
`as_skia_canvas_draw_bgra`）保留为 `ASC_RENDER_GPU` 未定义时的兜底。

一个必经的坑：**Ganesh 采样外部纹理时会重设该纹理对象上的采样器状态**，而 `stage3d_webgl.cc` 为了
避免每绘制重复六次 `glTexParameteri`，把过滤/环绕状态按纹理对象缓存。故 `skia_glue.cc` 暴露
`sk_gr_set_texture_dirty_hook`，在 `drawImageRect` 之后回调 `s3d_sampler_cache_invalidate()`
清空所有存活上下文的 `texStateN`/`samplerStateSet`——否则下一帧的绘制会以为「已经设过」而漏设 GL 参数。

**验证（`examples/air-starling-demo`）**：

```bash
EMSDK_HOME=<repo>/build-tools/emsdk node src/index.ts \
  --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo \
  --target wasm --package web          # 约 24 s

python3 -m http.server 8099 --directory examples/air-starling-demo
# 浏览 http://localhost:8099/Starling-Demo.html
```

- 页面控制台：`[Starling] Context ready. Display Driver: WebGL2 (Stage3D)`（非 Stage3D 构建下
  同一行会是 `Metal (Stage3D)` / `Software (state machine)`）。
- 12 个场景（Textures / Multitouch / TextFields / Animations / Custom hit-test / Movie Clip /
  Filters / Blend Modes / Render Texture / Benchmark / Masks / Sprite 3D）逐个进入并截图，
  内容与 AIR `adl` 参考一致；主菜单按钮几何与 ADL 逐像素一致（菜单按钮 device x 62..304
  （左列）/ 340..582（右列），内容占据 device (0,0)-(639,959)）——**demo 的白色区域是它自己的
  舞台底色，不是缺陷**。
- 交互坐标：stage 坐标 == canvas CSS 坐标 1:1（`noScale` + 无偏移），故合成点击用 stage 坐标即可
  （如 Back 按钮中心 = (160, 467)）。
- 驱动脚本：`temp/web-demo/cdp.mjs`（CDP：`reload`/`collect`/`shot`/`click`/`eval`）、
  `temp/web-demo/walk.sh`（全 12 场景走查 + 截图裁剪）、`temp/web-demo/rebuild_web.sh`
  （只重编 wasm 部分，约 19 s；`WEB_EXTRA_DEFS="-D ASC_FRAME_STATS=1"` 可临时带探针）。
- 回归：`node test.ts` **104 passed / 0 failed**（阶段八十九·三十一新增 `examples/int-rem-zero.as`）；
  GLSL 目标的形态由 `examples/stage80.as` 断言守住
  （`precision highp float;`、`gl_Position.y = -gl_Position.y;`、顶点/片元 varying 声明一致、
  `m44/m34/m33` 逐行声明 `vcN`、`od` 按需打开 `GL_EXT_frag_depth`、**`sge/slt/seq/sne` 的全掩码形态
  `ft5 = mix(vec4(0.0), vec4(1.0), vec4(greaterThanEqual(v0, v0)));` 与部分掩码的分量三元形态**）——把 mark-use
  修复还原后该示例必然 FAIL，故 §3.3 里那两个缺陷不会静默复现；阶段八十九·三十二同样用「还原成三元
  `sprintf` 必 FAIL」的反向对照证明了比较指令那条回归有效。
  ⚠️ 截图对比前先确认 canvas 的 CSS 位置是**整数**：落在半像素（如 x=272.5）上时合成器会把 canvas
  重采样进截图，同一份代码的两次走查会出现 ~9~13 mean 的「伪差异」（`walk.sh` 已从页面读 canvas 矩形）。

**性能（同一 `-D ASC_FRAME_STATS=1` 口径）**：120 Hz 面板上呈现 **120 fps / 0 丢弃**。
把「读回 + 上传上屏」整段临时摘掉后同一场景只剩 **0.047 ms/帧**（5.7 ms / 120 帧）——即
**CPU 读回 + 上传曾占约 98% 的帧成本**（渲染目标 640×960 ⇒ 每帧读回 2.4 MB）。
**改为 GPU 直连后（阶段八十九·三十一，同会话 A/B）**：单帧 `renderMs` **3.21 ms → 0.12~0.15 ms
（约 23×）**，且与读回路径在 `showStats` 覆盖层 `(0,0,180,82)` 之外**逐像素 0 差异**。
（`Benchmark` 场景在 web 上「对象数停在 0」仍是 demo 自身逻辑：该场景要求实测 fps ≥ 目标帧率的
99% 才加对象，与渲染后端无关。）

### 3.4 `flash.net` 的 web 后端：`fetch` + 帧边界 pump

GL 后端放在 `vendor/`，网络后端不——它整个在 `src/runtime.ts` 的 `RUNTIME_PREAMBLE` 里
（`ASC_HAVE_FETCH` 分支，EM_JS/EM_ASM 胶水），因为它是**运行时行为**而非渲染库。

形状是**拉取/轮询**而非回调：`as_web_fetch_go`（EM_JS）启动 `fetch()` 并把条目推入
`globalThis.__ascHttpQ`；`as_web_fetch_pump()` 在 **`as_async_tick` 顶部**排空队列。
选这个形状是因为它不需要改 `EXPORTED_FUNCTIONS`、也不需要 C 侧回调导出，而 ≤1 帧的延迟
**不可观测**——`flash.net` 的终态事件本来就必须延迟到帧边界派发。

队列是**单一有序队列**（chunk < done < error），保证体分块总在终态之前落地；
job 身份是 **`(指针, 序号)`**（`as_job_find`）——malloc 地址会被重用（ABA），只用指针会把
旧条目送到新 loader 手里。每次已结束的 fetch 也算一份 `progress` 水位，供本地重放。

反过来说，**web 上不能用阻塞自旋等结果**（`tickTimers()` 那套会饿死浏览器 promise，`fetch`
永远不 resolve）：AS3 代码必须事件驱动，让 `main()` 返回、把控制权交给 rAF 帧循环。

两条**要与 native 逐字对齐**的契约（阶段八十九·五十六 补上，此前两端不一致）：

- **`URLRequest.contentType` 必须真的作为 `Content-Type` 请求头发出去**。native 侧
  `as_http_perform` 一直如此；web 侧必须显式设置——`fetch` 只为 `string`/`Blob` 体自动补
  Content-Type，**对本后端传的 `Uint8Array` 一律不补**。漏掉它的症状是「服务器抱怨请求体
  缺字段」：实测同一个 JSON 登录体，无此头时被答 `{"code":200002,"message":"platform
  字段是必须的"}`，加上后返回 accessToken——失败得**很像应用自己的 bug**，而其实是传输层
  少了一个头。作用条件与 native 一致（请求带体时），且 `requestHeaders` 里的同名头优先。
  **阶段八十九·六十九 起两端共用同一个规则**（`as_http_effective_ctype(j)`，`runtime.ts`）：体为空
  就不发，体非空而未声明（或声明为 `""`）则发 urlencoded —— 注意这是**发包**默认，
  `req.contentType` 本身在 adl 上恒为 `null`（见 `flash-net.md` §6.7.7）；native 侧还需关掉 libcurl
  给每个 POST 自补的同名头。
- **远程图片（`Loader.load(http(s)://…)`）也走这条 seam**：JS 侧只 `fetch` 到字节，解码放在
  帧边界 pump 里（浏览器没有 worker 线程可藏，代价是单帧几毫秒、每 job 一张图），产出的
  像素与编码字节与 native 的 curl 分支**逐项相同**。

### 3.5 页面调试通道：`window.__ascStdout` / `__ascStderr` / `__ascErrors`

wasm 页面没有 stdout——`trace()` 的输出、以及加载/运行期的 JS 异常，若只进控制台，
人不可读（与画面不在一屏）、自动化也拿不到。故生成的 `index.html` 开场就把两者接到全局量：

```js
window.__ascStdout = [];   // Module.print  → 每条 trace() 一行
window.__ascStderr = [];   // Module.printErr
window.__ascErrors = [];   // window 'error' + 'unhandledrejection'
```

三者对使用者与自动化是同一份数据（`temp/run_webprobe.sh` 就靠 `__ascStdout` 读 web 构建
的断言结果，因为页面跑在浏览器里，harness 无法直接读它的终端）。

### 3.6 把 wasm trap 定位到源函数：带名重编 + 脚本装载前的 error 钩子

无 `-g` 时，emscripten 对 trap 只给 `Uncaught RuntimeError: null function` 加一串裸偏移
（`at 01a3921a:0x4ff0aa`）——地址无法对应回 C 函数，等于没有栈。两条都要做：

1. **带名重编**：`-g` 必须进 emcc。注意 **`--opt` 只接一个参数**（`--opt "-O2 -g"` 会被
   当成单个参数 `-O2 -g` 交给 emcc，报 `invalid optimization level: -O2 -g`），故把
   `EMSDK_HOME` 指向一个在 `upstream/emscripten/emcc` 位置追加 `-g` 的包装器
   （`upstream/bin` 软链回真 SDK）即可，不必改 `build.ts`。构建时会看到
   `warning: running limited binaryen optimizations because DWARF info requested` —— 这是
   `-g` 的预期代价。
2. **钩子必须装在页面脚本之前**：trap 发生在 `main()` 之后的主循环里，而生成的
   `__ascErrors` 只存 `ev.message`。用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`
   （`temp/dbg_stack.sh`，内部走 `temp/cdp_eval.mjs --pre=`）先装一个把 `ev.error.stack`
   收下来的 listener，才拿得到完整符号化栈；事后补装已经太晚。

读法：`null function` 与 `table index is out of bounds` 是同一件事（`call_indirect` 的索引非法）。
常见来源是**经对象里存的函数指针做间接调用**（`FILE` 的 `close`、Skia 的 GL 函数表、
我们自己的 vtable/thunk）。若栈顶落在一个看似毫不相干的 libc 函数上（阶段八十九·七十 的
`fclose`），那通常不是 libc 的问题，而是**传进去的对象已被释放或损坏** —— 
当时正是 `as_job_retire` 对着一个已被 AS3 `close()` 关掉的 `FILE*` 再关一次。

## 4. 字体：网络加载 + 运行时注入

wasm 沙箱没有系统字体可枚举，`CoreText` 后端不可用。web 字体链路：

1. 页面 JS 在 `Module.onRuntimeInitialized` 里对 `font-urls` 逐个 `fetch` 字节流；
2. `Module._malloc` 分配 wasm 内存，`HEAPU8.set` 写入字节；
3. `Module._sk_fontmgr_register_data(ptr, len)` 注入 Skia；
4. 全部注入完成后才 `Module._main()`（首次渲染前字体必须就位）。

Skia 侧（`skia_glue.cc` 的 `#ifdef __EMSCRIPTEN__` 分支）：

- 全局 `g_font_datas` 累积注入的 `SkData`；`sk_fontmgr_register_data` 每次注入后清空
  `g_fontmgr_cache`，下次构造 manager 时重新扫描。
- `sk_platform_fontmgr()`：无字体 → `SkFontMgr_New_Custom_Empty()`；有字体 →
  `SkFontMgr_New_Custom_Data(g_font_datas)`，用 FreeType 扫描每份字体数据，构建
  family→typeface 表，`matchFamilyStyle` / SkParagraph 由此按名找到注入字体。
- `sk_fontmgr_register_data` 用 `EMSCRIPTEN_KEEPALIVE` 导出给 JS。

> 注入顺序约束：`sk_default_typeface()` / `sk_textlayout_collection()` 是函数局部 static
> 缓存，首次调用即固定。字体必须在其首次调用前注入——HTML 引导脚本保证了这一点
> （先注入、后 `_main()`）。

> **失败形态：没有字体 = 文字静默全部消失**。沙箱里没有任何可枚举的系统字体，`font-urls`
> 为空时链路第 3 步不会发生，`sk_platform_fontmgr()` 停在 `SkFontMgr_New_Custom_Empty()`，
> `drawString` 一个字形都画不出。表现为 TextField 的**背景照常绘制、字形全部缺失**——看着像
> 「布局在、字没了」，而编译与运行都成功，所以是一条**静默错误**。`--air-app` 会自动把 app
> 目录下的 `.ttf/.otf/.ttc` 扫进 `font-urls`（`air-app.ts` 的 `findAppFonts`，无需改描述符）；
> 若 app 用了 `flash.text` 却一个字体都解析不到，`--air-app` 会打印一条警告，点明症状与两种
> 修法（自己放一个字体，或用描述符的 `<embedFonts>` 指定）。**native/adl 不受影响**
> （CoreText 枚举已安装字体），所以这是 **web 独有**的坑：同一个 `url-test` 在 adl/native 下
> 文字正常，只有 web 预览是空白框（实测见 §6 第 1 条）。

## 5. 关键实现约束（编译期/链接期）

这些是「链接 wasm 版 Skia」的固有要求，已固化进 `build.ts` 的 web 编译逻辑，用户无需手写：

### 5.1 `SK_TRIVIAL_ABI` 必须与 libskia.a 匹配

wasm 版 `libskia.a` 以 `is_trivial_abi=true` 编译（`gn/BUILDCONFIG.gn` 默认），`sk_sp`
带 `[[clang::trivial_abi]]`。C++ 胶水层（`skia_glue.cc`/`web_glue.cc`）编译时必须带同一
define `-D SK_TRIVIAL_ABI=[[clang::trivial_abi]]`，否则每个 Skia 调用 ABI 不匹配——
wasm-ld 会报 `function signature mismatch` 警告，且**运行期 `unreachable` 崩溃，编译期不报错**。
`build.ts` 已对 C++ 源自动加该 define。

### 5.2 `EXPORTED_FUNCTIONS` 导出字体注入入口

页面 JS 需要调用 `_malloc`/`_free`/`_sk_fontmgr_register_data`/`_main`。Emscripten 默认只
导出 `_main` 与 `EMSCRIPTEN_KEEPALIVE` 符号，`_malloc`/`_free` 不在内；一旦显式写
`EXPORTED_FUNCTIONS` 又会**覆盖**默认导出（`_main` 消失）。故 `build.ts` 一次性导出：

```
-s EXPORTED_FUNCTIONS=["_main","_malloc","_free","_sk_fontmgr_register_data"]
```

漏掉 `_malloc`/`_free` 会让字体注入静默失败（`Module._malloc is not a function`），文字
渲染为空；漏掉 `_main` 则 `INVOKE_RUN=0` 下无人启动 main。

### 5.3 Number→int 强制转换必须走 `as_to_int32`（wasm 下 `(int)NaN` 会 trap）

AS3 的 `int(x)` 与隐式 `Number→int` 强制转换是 ECMA-262 §9.5 的 `ToInt32`：`NaN`/`±Infinity`
映射为 0，有限值截断并回绕 32 位。直接生成 C 的 `(int)x` 对 `NaN`/`Infinity` 是**未定义行为**——
native（x86）碰巧给出垃圾值（如 `-16`），wasm 下则触发 `unreachable` trap 使整个程序崩溃
（`air-native` 完整 demo 的 `Timer.repeatCount = NaN` 断言即因此崩溃）。

修复：`runtime.ts` 提供 `as_to_int32(double)` / `as_to_uint32(double)` 助手（`isnan`/`isinf` → 0，
`fmod` 回绕 2^32），`emit.ts` 的 `convert`/`toInt32Expr`/`toUint32Expr` 对 `number` 源一律改用
这两个助手，替换所有 `(int)`/`(unsigned int)` 强制转换。这保证 native/wasm/web 三个后端对同一份
AS3 的 `Number→int` 结果一致（如 `t.repeatCount = NaN` 统一存为 0）。

### 5.4 生成的页面必须吞掉 `emscripten_set_main_loop` 的 `'unwind'` 哨兵

`main()` 末尾是 `emscripten_set_main_loop(main_loop, 0, 1)`（`simulateInfiniteLoop=1`），
它靠**抛出一个字符串 `'unwind'`** 来展开 wasm 栈（Emscripten 内部把「不返回」表达成异常）。
Emscripten 自己的 `run()`/`callMain()` 会吞掉这个哨兵，而生成的页面在
`async function onRuntimeInitialized()` 里直接调 `Module._main()`，于是它浮到顶层变成
`Uncaught (in promise) unwind` ——每个 web 构建的控制台都会多一条假错误。
故 `src/index.ts` 的 `writeWebIndex` 把调用包成：

```js
try { Module._main(); } catch (e) { if (e !== 'unwind') throw e; }
```

（只吞这一个哨兵，其余照抛，真实错误仍可见。注意 `_emscripten_throw_longjmp` 抛的是
`Infinity` 而非 `'unwind'`，不是同一回事。）

**同一事实的推论（容易踩）**：既然 `main()` 是被**拔栈**的，那么**写在 `showWindow(...)`
之后的 AS3 语句永远不会执行**。启动链（注册监听器、发请求）必须写在 `showWindow` 之前，
把 `showWindow` 放在最后一句。这看似反直觉（native 上 `showWindow` 返回后还会继续执行下面的语句），
但它就是「帧循环由浏览器驱动」的直接后果。

## 6. 已知限制

1. **依赖网络与字体体积**：字体运行时 `fetch`，离线/内网不可用；整包 CJK 字体体积大，
   首次渲染前需等待下载 + FreeType 扫描完成（大 `.ttc` 集合扫描较慢，示例用 773KB 的
   Arial 演示英文，CJK 场景建议按需替换更小的字集）。
   - **字体覆盖范围 = 能显示的文字范围**：字形缺失是逐个字符的，不报错。`url-test` 会把登录
     响应的 JSON 原样打进 TextField，里面有中文（`住友制药`/`视频通话`/`我的会议`…），所以它带的是
     7.9 MB 的 `MiSans-Regular.ttf`（实测 Arial 与 Ubuntu-R 的 cmap 对这几个字命中 0/8，MiSans 8/8）。
     只带西文字体时那些汉字会渲染成 ▯，**不报错**。
   - **字体只下载一次（阶段八十九·五十八 起）**：字体的实际来源是页面 `fetch` +
     `_sk_fontmgr_register_data` 注入，wasm FS 里那份副本从不被读取（实测：把一个页面的 `.data`
     换成不含字体的版本、字体仅走 HTTP，文字照样渲染）。但 `--air-app` 的 `preload-paths` 会把 app
     目录整体打包，于是 `assets/fonts/*.ttf` 曾经同时进了 `.data`——`url-test` 因此 `.data` 由
     4.5 KB 涨到 7.9 MB，页面总下载量约翻倍。现在生成器会把这些字体同样列进 `preload-excludes`
     （→ 链接期 `emcc --exclude-file`），**只**排字体、不排别的：位图字体（`.fnt` + 图集）要由
     app 通过 `File` 读，仍留在 FS 里。实测 `url-test.data` 回到 4572 B、Starling 恰好减
     `Ubuntu-R.ttf` 的 359668 B，而两端的文字与资源加载均无变化。
2. **半透明上屏有色差**：premultiplied alpha 直贴 canvas，不透明精确、半透明有色差（§3.1）。
3. **帧率上限 = 窗口所在面板的刷新率**：rAF 跟随显示器刷新率，软件层无法越过——50 Hz 屏上
   就是 50 fps。要 120 fps 必须让窗口落在 120 Hz 面板上（多显示器且刷新率不同时尤其要确认，
   见 §3.2 与 `temp/web-fps/fps_probe.mjs`）。
4. **帧率量化为刷新率的整数分之一**：节拍按整 vsync 表达（§3.2），帧间隔只能是刷新周期的
   `skip` 倍。例如 60 Hz 屏上 `frameRate=24` 只有 30/20 两个候选，取最近的 20 fps（native 走
   `SDL_Delay` + vsync 也受同一约束，故两端一致）。
5. **`emscripten_set_main_loop` 阻塞**：与 SDL 事件循环同理，帧循环由浏览器驱动，程序
   在页面关闭前不会从 `stage.showWindow` 返回。
6. **WASI 组合未变**：`--target wasm --package raw` 仍是 WASI 命令行模块，不含渲染；
   浏览器渲染只经 `--package web`。
7. **Stage3D 上屏已是 GPU 直连**（§3.3，阶段八十九·三十一）：`sk_gl_draw_texture` 把渲染目标的
   GL 纹理包成 `GrBackendTexture` 直接画进 canvas，**不再每帧 `glReadPixels` 回内存**。实测单帧
   `renderMs` 由 3.21 ms 降到 0.12~0.15 ms（**约 23×**），代价不再随目标面积线性增长（此前的
   1280×2160 `Canvas3D` = 11 MB/帧 ≈ 13 ms 已不是问题）。读回路径仍作为 `ASC_RENDER_GPU` 未定义时
   的兜底保留（两端逐像素一致，只差一个 `showStats` 叠加层）。
   ⚠️ 唯一必守的配套：Ganesh 采样外部纹理会改采样器状态，故 `sk_gr_set_texture_dirty_hook` 必须在
   绘制后失效 `stage3d_webgl.cc` 的按纹理采样器缓存（否则漏设过滤/环绕）。
8. **AGAL 翻译的未支持指令在两端一致**：`sgn`/`tld` 仍为响亮错误（**不静默出空图**）；
   翻译失败经 `as_throw(Error_new(info_log))` 抛出，故着色器问题会出现在页面控制台。
9. **需要浏览器支持 WebGL2**：构建固定 `-s MAX_WEBGL_VERSION=2`（NPOT 纹理、`DEPTH24_STENCIL8`、
   `glBindAttribLocation` 前置、模板分离 API 都依赖 WebGL2）；不支持 WebGL2 的浏览器上
   `getContext('webgl2')` 失败 → 上下文创建报错，而不是静默降级。
10. **`flash.net` 的 web 后端受浏览器沙箱约束**（`ASC_HAVE_FETCH` 时生效，细节见
    [`flash-net.md`](flash-net.md) §5-E/§6.5）：
    - **CORS**：跨源请求需对方回 `Access-Control-Allow-Origin`；被拒时抛诚实 `ioError`，
      文案指名浏览器失败与 CORS（**不假装成功**）。
    - **图片同样受 CORS 约束，且必须是对方放行**：跨源图片在浏览器里可以**显示**
      （`<img>` 不需要 CORS），但**读不到像素**（canvas 会被 taint、`getImageData` 抛错）——
      而 Skia 上屏正需要像素，故远程 `Loader.load` 本质上等价于一次需要 CORS 的读取。
      实测 `https://meeting.talkmed.com/img/*.png` 的响应**没有**
      `Access-Control-Allow-Origin`（只有 `timing-allow-origin: *`），于是这两个 URL 在 web 上
      只能得到一个诚实的 CORS `ioError`，而 native/`adl` 侧正常（curl 不受同源策略约束）。
      要让它显示，必须由 CDN 加 `Access-Control-Allow-Origin`，或让页面从**同源代理**取图。
    - **受限请求头**：浏览器自己管 `User-Agent`/`Cookie`/`Origin` 等，自定义值的可控范围
      小于 native。
    - **`followRedirects=false` 时重定向不可观测**：`fetch(redirect:'manual')` 得到的是
      **不透明重定向**（状态 0、头体不可读），故如实报一条「被重定向但无法跟随」的错误，
      而不伪造状态码 0 的成功。
    - **响应头键名被规范化为小写**（浏览器行为），`responseHeaders` 如实反映。
    - **无 `file://`**：web 沙箱下相对/文件路径无对应物，非 http 的 URL 直接诚实报错。
11. **`navigateToURL` 在 web 上只能制 `window.open`**：不是系统浏览器进程，弹窗拦截策略
    由浏览器决定；无启动器的 WASI 目标如实报 `Error #2032`（见 `flash-net.md` §6.6）。
12. **web 渲染后端固定为 WebGL2，未使用 WebGPU**（2026-10-08 复核，结论维持）。wasm 版 Skia
    只编了 Ganesh/WebGL（`out/wasm/args.gn`：`skia_use_webgpu=false`、`skia_enable_graphite=false`、
    `skia_use_dawn=false`、`skia_use_webgl=true`），且 `vendor/skia/lib/wasm/libskia.a` 里
    **Dawn 符号为 0**；Stage3D 后端是 `stage3d_webgl.cc`（WebGL2 + GLSL ES），构建固定
    `-s MAX_WEBGL_VERSION=2`。**这不是性能妥协**：瓶颈是 rAF / 面板刷新率，GPU 路径单帧仅占
    帧预算 **1.35%**（余量 ≈74×；Stage3D 上屏 GPU 直连后 `renderMs` 0.12~0.15 ms），换 WebGPU
    换不到 fps。真要上须换 Skia 引擎（Ganesh **无** WebGPU 后端 ⇒ 迁 **Graphite + Dawn**）+ 为
    wasm32 拉 Dawn 重编 + 升级 Emscripten（现 3.1.44）+ 新增第三个 Stage3D 后端；且 WebGPU 用
    **WGSL**，与原生着色器直通在 web 侧的目标 GLSL ES 不同路。判定依据与重启的量化触发条件
    见 `TODO.md` 阶段八十九·二十九（WebGPU 判定复核）。

## 7. 工具链复用

`build-tools/` 下已就绪且保留不清理：`emsdk/`（Emscripten 3.1.44）、`skia-src/`
（chrome/m124 源码 + 依赖，GN args 见 `out/wasm/args.gn`）、`out/wasm/`（wasm32 编译产物，
已拷贝至 `vendor/skia/lib/wasm/`）。复现 wasm 版 Skia 见 `skia.md` §7 与
`build-tools/skia-src/out/wasm/args.gn` 内注释。
