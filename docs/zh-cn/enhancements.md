# AIR 之外的增强（保真之上的增益）

> 本文回答两件事：**什么算「对齐 AIR」、什么才算「增强」**（§1），以及**在「直接生成可读 C + 链接成熟生态」
> 这个架构下具体有哪些值得做的增强**（§3 清单、§4 重点项）。
>
> 结论先行：**对齐是底线，增强是增益。** `adl` 实测过的 AIR 语义逐字对齐；只有 AIR **未定义 / 明确不支持 /
> 根本没有对应物**的地方，才是增强的作用域。
>
> 相邻文档：[`as3-semantics.md`](as3-semantics.md) §4/§5（原则与分歧）、`TODO.md` 的 `### 增强待做`（排期）、
> `README-CN.md` 的「在 AIR 之外」。

---

## 1. 原则

### 1.1 两条底层原则

1. **保真是底线（不可让的）。** AIR 已定义的语义必须**逐字**对齐——错误号、错误文案、事件顺序与次数、
   边界值、API 形状，一律以 `$AIRSDK_HOME/bin/mxmlc` + `adl` 的**实测**为准（AGENTS.md §2.4）。
   增强**不得**改写任何 AIR 已定义的行为：同一份 `.as` 在 `adl` 下是什么样，在我们的产物里就必须是什么样。
2. **增强是增益（白名单，须论证）。** 只有在 AIR **未定义 / 明确不支持 / 没有对应物**的地方才允许增强，
   且**必须 opt-in**。不声明任何开关的默认产物，保持与 AIR 同构。

> 一句话：**我们不是「另一种 AIR 实现」，我们是「AIR 语义 + 原生 C 的执行红利」。**

### 1.2 增强的判定标准（五条全中才算）

| # | 标准 | 会被驳回的「伪增强」 |
|---|---|---|
| a | 落在 AIR 语义**之外**：AIR 从不接受该输入 / 从不提供该 API / 在这条路径上本来就报错 | 让 `Loader` 接受 AIR 会拒绝的输入并**改变**其返回语义——那是改语义，不是增强 |
| b | **绝不静默**：能力缺失时报明「本后端 / 本构建不支持 X」，不降级、不假装成功 | 不支持的输入回落成空对象 / `0×0`，形似成功 |
| c | **跨端能力差异必须显式列出**：native 有、web 无（或反之）时，文档与运行时报错文案都要说清「哪一端、缺什么、怎么开」 | 只写「不支持」，不说哪一端、为什么 |
| d | **opt-in 且不膨胀默认产物**：开关默认关；默认构建仍是零依赖、自包含（AGENTS.md §2.6/§2.9） | 为一个可选增强，让所有用户的默认二进制多链 1.4 MB |
| e | 过 DoD：`examples/*.as` + 断言回归 + 文档同步 + 版本递增 | 只写代码，不写示例与回归 |

### 1.3 为什么这里值得增强（架构红利）

AIR 的能力上限被 **AVM2 运行时 + Flash 沙箱**锁死——能做什么，取决于 Adobe 当年往运行时里编了哪些类。
而本项目的产物是**一份可读的 C，再交给 `clang -O2`**，于是多出四类 AIR 拿不到的红利：

- **链接成熟生态**：Skia（矢量 / 排版 / 滤镜 / 编解码）、libcurl + nghttp2（网络）、SQLite、… 用 `-l` 接进来，
  而不是自己重写一遍（AGENTS.md §2.9）。
- **吃编译器红利**：LTO / PGO / `static` 化 tree-shake，都是「生成 C」这条路的白送项。
- **与宿主 C 互调**：生成的 C 和宿主程序在同一编译单元里，可以直调宿主函数（FFI）——字节码解释器做不到。
- **跨出浏览器 / 桌面**：同一份 C 可编到 native / WASI / web，也能跑**无窗口的服务端出图**。

**这不是兼容性负债，是架构红利**——但前提是 §1.2 的五条守住了；否则「增强」会退化成「语义漂移」。

### 1.4 增强怎么开：具名开关（`--features`）

标准 (d) 要求增强 **opt-in**，而 opt-in 的具体形态在本项目里统一为**具名开关**：

```bash
as-aot app.as --air-app app.xml --features svg     # 等于 -D ASC_USE_SVG=1
```

清单侧同名字段（`"features": ["svg"]`）语义一致。为什么不直接让用户手写宏：

| | `-D ASC_USE_SVG=1` | `--features svg` |
|---|---|---|
| 可发现性 | 宏名只出现在文档正文里 | `--help` 列名字，报错也列出已知名字 |
| 打错字 | 静默无效（clang 不管未使用的宏）——**正是 (b) 禁止的** | `unknown feature 'sgg' (known: formats, raw, svg)` 并在生成代码前退出 |
| 跨端能力 | 要用户自己知道 web 编不出来 | `feature 'svg' is not available with --target wasm` 直报（标准 c） |
| 开了之后 | 不声不响 | 构建横幅点名 `== enhancements: svg (-D ASC_USE_SVG=1) ==`，再明说这是 AIR 超集 |
| 集合语义 | 只能追加 | `--features` **替换**整个集合（`-D` 才是追加），故「只留 X」可表达；`--features none` 清空 |

**只有真正端到端实现过的通道才会登记为名字**。登记一个没实现的开关，等于给用户一个「看着开了、
实际没编进去」的东西——比不提供开关更坏。故当前登记四个：`svg`（E1）、`formats`（E3）、`raw`（E4）、
`tray`（E19）；E2（Lottie）实现后才登记。下表是当前生效的名字与宏（`--help` 与报错文案都列它）：

| 名字 | 宏 | 可用的编译目标 | 开的通道 |
|---|---|---|---|
| `svg` | `ASC_USE_SVG=1` | native | E1：`Loader` 解码 SVG（web 无 svg/sksg/expat 归档） |
| `formats` | `ASC_ALLOW_EXTRA_FORMATS=1` | native / wasm | E3：额外图片格式 WebP / BMP / ICO |
| `raw` | `ASC_ALLOW_RAW_FORMATS=1` | native | E4：相机 RAW / DNG（web 无 piex/dng_sdk 归档） |
| `tray` | `ASC_USE_TRAY=1` | native（**且宿主须为 macOS**） | E19：`SystemTrayIcon` 背后是真 `NSStatusItem`（AIR 在 macOS 上根本没有托盘） |

**窗口 GPU 后端不是增强，也不在这张表里**：`--gpu-backend`（[`compile.md`](compile.md) §3.4.6）换的是
「同一套语义画在哪套原生 API 上」，不改变任何 API 行为、不解锁任何 AIR 拒绝的能力，因此不落在 §1.2 的
判定范围内。它是**独立开关**：`--features gl` 会报 `unknown feature 'gl' (known: formats, raw, svg, tray)`。

**默认拒绝（阶段九十四·二十五）**：E3/E4 的通道此前是「零代码可用」——我们的 Skia 本来就带这些
codec，于是**默认产物比 AIR 宽**：AIR 对 BMP/WebP/ICO/DNG 一律报 `#2124`，我们却解出来了。这违反
标准 (d)（默认产物须与 AIR 同构）与 §1.5，故两个通道改为**默认拒绝**：胶水层按魔数拦掉那几族
（PNG/JPG/GIF 不受影响），拦截后走的是原有的 `#2124` 失败路径——**报的错与 `adl` 逐字相同**。
打开开关才解码，且构建横幅点名（开了就绝不静默）。

**与 `--air-app` 的配合**：`--air-app` 每次运行都会整份重写生成的 `<filename>.build.json`，所以
选择必须能挺过重写——`--features svg` 会把它写进清单，**下次不带参数仍然生效**并打印 carry-over
提示（不静默）；`--features none` 关闭。只有 `features` 与 `gpu-backend`（§3.4.6，**不是**增强开关）两个
字段会被继承，其它字段仍是描述符+源码的函数。

详细规则见 [`compile.md`](compile.md) §3.4.2；回归钉子见 `test.ts` 的 `[features]` 组（24 项，含 4 个
反向对照变异：开关不生效 / 默认被打开 / 持久化丢失 / 未知名字静默，全部被捕获）。

---

## 2. 与「遗留待开发」的区别

| | 性质 | 归属 | 一句话判据 |
|---|---|---|---|
| **遗留待开发** | **缺陷 / 未完成的对齐**——AIR 有、我们没有，或我们有但不忠实 | `TODO.md` 的 `### 遗留待开发` | 拿 `adl` 一跑就知道**差在哪** |
| **增强待做** | **超出 AIR 的增益**——AIR 没有，我们可以有 | 本文 §3 + `TODO.md` 的 `### 增强待做` | 拿 `adl` 一跑，AIR 那边**本来就报错 / 根本不存在** |

判据很硬：**同一份输入，`adl` 能跑出正确结果而我们跑不出 → 那是遗留缺陷；`adl` 对同一输入本来就报错
（或该 API 在 AIR 里压根不存在）→ 我们做出来才算增强。** 例：`Loader.load("*.svg")` 在 `adl 51.4.1` 下实测
就是 `Error #2124: Loaded file is an unknown type.`，所以「支持 SVG」是增强，不是补平差距。

---

## 3. 增强待做清单

> **已完成 8 项**：E1 SVG（native 半）、E3 多格式解码、E4 RAW/DNG（native 半）、E9 64 位整数、E13 LTO/PGO、E16 刷新率查询、E18 带状态码退出（`System.exit`）、E19 macOS 菜单栏状态项（`SystemTrayIcon`）。
> **另有 1 项现状即增强、无需开工**：E17（无 GPU 后端时 `Context3D.profile` 报 `baselineExtended`）——
> AIR 的 `software` 渲染模式在这里会直接 `#3702`，我们照常给上下文；详细实测见
> [`display3d.md`](display3d.md) §9.14。
>
> **另有 1 项已实测、明确不排期**：E10（`Vector.<Number>` 批量 SIMD）—— arm64 上 AArch64 NEON 的 `f64`
> 只有 **2 lane**，而 M 系列标量 FP 端口本来就宽：实测**手写 NEON 相对同形标量 C** 只差 0–8%（元素级 f64）、
> ≈0（`int32`，4 lane）、0–4%（L1 常驻的除法），而**归约**形状要 SIMD 就必须重结合，与 AS3「每步一次舍入」
> 冲突。实测表、出处与「真正的缺口在哪儿」见 **§4.9**。
>
> 状态口径：**已有** = 现在就能用（可能只是没写文档/没写示例）；**半成品** = 库已在、缺 AS3 面；
> **待建** = 需要新胶水或改工具链。目标端里的「web 需重编」= 需要改 `build-tools/skia-src/out/wasm/args.gn`
> 并重建 wasm 版 Skia。

| # | 增强项 | AIR 现状 | 我们的现状 | 目标端 | 成本 |
|---|--------|---------|-----------|--------|------|
| E1 | **SVG 运行时解码**（`Loader.load("*.svg")` → `Bitmap`） | ✗ 从不支持（实测 `#2124`） | ✅ **native 已实现（opt-in）**：`--features svg`（= `ASC_USE_SVG=1`）时四条解码入口全部支持；web 无 svg/sksg/expat 库，**不支持** | native 已完成 / web 需重编 | native **已完成** |
| E2 | **Lottie 矢量动画**（Skottie 播放 `.json`） | ✗ 无对应物 | native：`libskottie.a` 已构建 + 已链接，缺播放器 API | native 现成 / web 需重编 | 中 |
| E3 | **多格式图片解码**（WebP / BMP / ICO） | 部分：仅 JPG / PNG / GIF（实测 `adl 51.4.1` 对 BMP/WebP/ICO 报 `#2124`） | ✅ **已实现、opt-in 具名开关 `--features formats`**：默认构建**与 AIR 同报 `#2124`**，开关打开后两端实测**全部解码正确**（见 §4.3）；`QOI` **不在内**（未编入 `SkQoiCodec`） | 两端 | **已完成（默认拒绝 + 开关）** |
| E4 | **相机 RAW / DNG 解码** | ✗（实测 `adl 51.4.1` 对 `.dng` 报 `#2124`；`BitmapData.loadFile` 更是**不存在**，`#1069`） | ✅ **已实现、opt-in 具名开关 `--features raw`**：默认构建与 AIR 同报 `#2124`；开关打开后 native 四条解码入口全部解出 DNG 600×338（见 §4.5）；web 侧 wasm Skia **无** piex/dng_sdk 归档（`nm` 实测 0 个 `SkRawDecoder` 符号）⇒ 开关在 wasm 上被**前置拒绝**并点名缺哪个归档 | native 已完成 / web 与 AIR 同形 | **已完成（默认拒绝 + 开关）** |
| E5 | **矢量图形直接上屏**（`Shape` 走 `SkPath`，无限分辨率） | ✗（`BitmapData` 只有位图） | Skia 已在，缺 AS3 面 | 两端 | 中 |
| E6 | **原生着色器直通**（MSL / GLSL ES） | ✗（只有 AGAL 寄存器语言） | AGAL→MSL/GLSL 翻译器已在（`ASC_AGAL_TARGET`），缺「提交原生 shader」的扩展 API | 两端 | 中 |
| E7 | **GPU 通用计算**（Metal compute / WebGL2 transform feedback） | ✗ | 需新胶水层 | 两端 | 高 |
| E8 | **无窗口 / 服务端出图** | 半（可离屏，但绑死 AIR 运行时） | **已具备**：headless 可跑，`stage.render()` 直接出 PNG | 两端 | 已有 |
| E9 | **64 位整数**（`int64` / `uint64`） | ✗（`int` / `uint` 都是 32 位） | ✅ **已实现（opt-in，纯 C，两端同形）**：类型 + `L`/`UL` 字面量 + `int64()`/`uint64()` 转换 + 64 位算术/位运算/比较 + 独立装箱 tag（见 §4.7） | 两端（native / web / WASI 同一份 C） | **已完成** |
| E10 | **`Vector.<Number>` 批量 SIMD**（NEON / SSE） | ✗ | ⛔ **已实测：不排期** —— arm64 上手写 NEON 相对**同形标量 C** 只差 **0–8%**（元素级 f64）、**≈0**（int32）、**0–4%**（L1 常驻除法）；归约形状要 SIMD 必须重结合，与 AS3「每步一次舍入」冲突。真正慢的**不是算力**而是逐元素守卫（已另登记进 `TODO.md` 遗留表，且 `-O2` 自己就能向量化）。见 §4.9 | 两端 | **不排期（已实测）** |
| E11 | **FFI：声明并直调宿主 C 函数** | ✗ | **「直接转 C」的独有红利**（与宿主同一编译单元） | native | 中 |
| E12 | **真并发 `Worker`（OS 线程）** | 部分（AIR Worker 受限、需 `flash.concurrent`） | 已有 4 worker 池（目前只服务异步 IO） | native | 中 |
| E13 | **LTO / PGO 构建开关** | — | ✅ **已实现**：清单 `lto`/`pgo`/`pgo-dir` + CLI `--lto`/`--pgo`/`--pgo-dir`，**默认全关**（见 §4.4） | 两端 | **已完成** |
| E14 | **帧录制 / 确定性重放** | ✗ | 运行时自持（帧边界、事件、随机源都在我们手里） | 两端 | 中 |
| E15 | **可读 C 作为一等交付物**（嵌入宿主工程 / 人工审改） | ✗ | **已承诺**（README：「保留 `.c` 便于阅读」） | 两端 | 已有 |
| E16 | **显示器刷新率查询**（`VsyncStateChangeAvailabilityEvent.refreshRate`） | ✗ **无任何刷新率查询 API**（实测 `adl 51.4.1` 只派发 `vSyncStateChangeAvailability` 且只带只读的 `available=false`） | ✅ **已实现**：事件增加只读 `refreshRate:Number`（构造器第 5 个**可选**参数，缺省 `0`）；启动后首个已知帧 + 窗口落到不同速率显示器时各派发一次 | 两端（**web/离屏无对应物 ⇒ 如实不派发**，不伪造 `0`） | **已完成** |
| E17 | **无 GPU 后端时的 `Context3D.profile`**（纯 C 状态机报 `baselineExtended`） | ✗ AIR 的 `software` 渲染模式**锁死 `baseline`**：请求 `baselineExtended`/`enhanced` 异步抛 `#3702`，`createTexture(4096)` 报 `#3683 (max is 2048x2048)`、`maxBackBuffer` 只有 2048×2048 | ✅ **现状即增强**：未链接 Stage3D 后端时仍建上下文、报 `baselineExtended`、按 4096 校验（纹理只在 CPU 里，不占显存）；`driverInfo` 如实报 `"Software (state machine)"` | 两端（纯 C，无胶水依赖） | **已有（刻意保留，非开关）** |
| E18 | **带状态码的退出**（`flash.system.System.exit(code:uint)`） | ✗ **明确不支持**：`mxmlc` 认得这个签名，但 AIR **运行时**抛 `IllegalOperationError #2018`（`The System.exit() method is not supported.`，`adl 51.4.1` 未打包实测，见 `TODO.md` 阶段一百二十五）；AIR 里**没有任何**带状态码的退出 API（`NativeApplication.exit()` 无参） | ✅ **已实现（阶段二百四十五）**：记下 `code` 后走**与 `NativeApplication.exit()` 同一条**收尾路径（`as_window_request_exit()`），`main` 以它为**进程状态码**返回；`System` 的未知成员改报 `System has no member 'X'`（此前误报 `undefined variable 'System'`）。见 §4.10 | 两端（native：状态码即进程状态；WASI：crt 用 `main` 返回值 `__wasi_proc_exit`，实测 `WASI_EXIT=7`） | **已完成** |
| E19 | **macOS 菜单栏状态项**（`flash.desktop.SystemTrayIcon` 背后是真 `NSStatusItem`） | ✗ **这台机器上压根没有**：实测 `adl 51.4.1` / macOS 的 `NativeApplication.supportsSystemTrayIcon` 为 `false`，`new SystemTrayIcon()` 抛 `#2012` | ✅ **已实现、opt-in 具名开关 `--features tray`**：默认构建照旧 `supportsSystemTrayIcon=false` + `#2012`（与 AIR 逐字同形）；开开关后同一段 AS3 拿到一个真状态项，点击派发 `ScreenMouseEvent`（`click`/`rightClick`，带屏幕坐标与修饰键），`menu` 走与 App/Dock 菜单同一条 tag 通道（见 §4.11） | native / macOS 宿主 | **已完成（opt-in）** |

---

## 4. 重点项说明

### 4.1 E1 — SVG 运行时解码（旗舰项）—— ✅ **native 已完成（opt-in）**

**为什么算增强**：AIR 的 `Loader` 规范三处一致——类描述「load SWF files or image (JPG, PNG, or GIF)」、
`load()`「SWF, JPEG, progressive JPEG, unanimated GIF, or PNG」、`loadBytes()`「SWF, GIF, JPEG, or PNG」。
**SVG 从来不在 Loader 支持范围内**（Flash Pro 时代的 SVG 导入是**创作期**转换，不是运行时解码）。
本机 `adl 51.4.1` 实测同 URL 的 SVG 与 PNG：

```
AIR|IO_ERROR | crossplatform.svg | Error #2124: Loaded file is an unknown type. URL: …/crossplatform.svg
AIR|COMPLETE | ane-icon-black-border.png | 320x320 bytesTotal=8875
```

**为什么现在失败**：现有解码路径是 `SkImages::DeferredFromEncodedData` → `SkCodec`，而 **SVG 不是 SkCodec 格式**
（必然返回 null，落进 `AS_JOB_ERR_DECODE`）。SVG 的正确路径是另一条：

```
SkSVGDOM::Builder::make(SkStream)  →  SkSVGDOM::render(SkCanvas)  →  光栅化到 SkSurface  →  SkImage
```

即「解析 → 渲染 → 得图」，**是新解码通道，不是给现有通道加分支**；`<text>` 还需要 `SkFontMgr`，
外链 / `<use>` 还需要 `ResourceProvider`。

**两端能力不对称（§1.2c 的典型）**：

| | native | web |
|---|---|---|
| Skia 是否编了 SVG | ✅ `skia_enable_svg=true` + `skia_use_expat=true` → `libsvg.a`(439 KB) + `libsksg.a` **已构建** | ❌ `skia_use_expat=false`，svg 目标被 `if (skia_enable_svg && skia_use_expat)` 门住 → **无 `libsvg.a`** |
| 是否已链接 | ✅ `air-app.ts` 的 `linkLibs` 里就有 `svg`/`sksg`/`skottie`/`skresources` | ❌ wasm 库表里没有 |
| 要做的话 | 只差把 `SkSVGDOM` 接进解码路径（glue + runtime + emit） | 还要改 wasm `args.gn`（`skia_use_expat=true`）并补 **expat / skresources / svg / sksg** 四个库，**重编 wasm Skia** |

> 注：native 虽然「已链接」，但无人引用，静态库里这些目标被 `-O2` 的调用图分析**自动剥掉**
> （`nm` 查不到 `SkSVGDOM`）——这是 §2.6 `static` 化优化的正常结果，不是缺库。

**建议**：先做 **native 半**（lib 现成、成本只有胶水），web 半按需再动工具链；两端差异按 §1.2c 写进文档与报错文案。

#### 实现结果（阶段八十九·六十五）

**做了 native 半**，并按 §1.5 做成 **opt-in**（默认构建仍与 AIR 逐字同构）：

| 构建 | `Loader.load("x.svg")` |
|---|---|
| 默认（无增强开关） | `ioError #2124 Error #2124: Loaded file is an unknown type.` —与 `adl 51.4.1` **逐字相同** |
| `--features svg`（= `-D ASC_USE_SVG=1`） | 解码成功（尺寸/像素正确） |

**实现**（全在 `vendor/skia_glue.cc`，四个解码入口统一加「codec 失败后」的回退）：

```
sk_svg_header(data,len)                 // 廉价嗅探：跳过 BOM/空白后首字节是 '<'
SkSVGDOM::Builder()
    .setFontManager(sk_platform_fontmgr())   // 不设则 <text> 一个字都不画
    .make(SkMemoryStream)
→ setContainerSize(文档自身 width/height，缺省用规范默认 300×150)
→ SkSurfaces::Raster(N32/premul) + clear(TRANSPARENT) + dom.render(canvas)
→ makeImageSnapshot → (SkImage) 或 readPixels 成 straight-ARGB
```

覆盖的四条入口：`sk_image_from_file`/`sk_image_from_bytes`（Loader 的显示列表视图）与
`sk_image_decode_argb`/`sk_image_decode_bytes_argb`（BitmapData 的 CPU 像素）。实测
（`temp/codec-probe/svg-probe.as`，同一份源码编两遍）：

| 路径 | 默认 | `--features svg`（= `ASC_USE_SVG=1`） |
|---|---|---|
| `Loader.load("t.svg")`（文件） | `ioError #2124` | ok 37×23 `tl=ff0000` |
| `Loader.loadBytes(svg 字节)` | `ioError #2124` | ok 37×23 |
| `BitmapData.loadFile("t.svg")` | 未改动（1×1） | ok 37×23 |
| 只有相对单位（`width="100%"`）的文档 | `ioError #2124` | ok **300×150**，内容色正确 |
| 含 `<text>` 的文档 | `ioError #2124` | ok 120×30，文字区**暗像素 97 个**（不设 font manager 时为 **0**，已反向对照） |
| `t.png`（反向对照） | ok 37×23 | ok 37×23（仍走 codec，不被 SVG 路径截胡） |

**顺带修掉一个被它暴露的既存缺陷**：`BitmapData.loadFile` 在成功解码时会
`free(bd->pixels)`，而 `pixels` 自阶段八十九·四十二起就在 **GC 堆**上——`free` 一个 GC 缓冲会砸坏
GC 空闲链（正是 `BitmapData_dispose` 早已注明的规则）。**实测 `abort()`**，且**与 SVG 无关**：
默认构建里对一张**普通 PNG** 调 `loadFile` 同样崩。之所以一直没被发现，是因为没有任何回归跑过
**成功**的 `loadFile`（探针喂的都是解不出来的文件，走不到那一支），而 `Loader__imageFinish` 的同款
`free(bd->pixels)` 是 `free(NULL)`（它的 BitmapData 建成 0×0，构造函数把 pixels 留成 NULL）而被掩盖。
两处均已改为「丢引用、不 free」，并加了回归钉子（见 `test.ts` 的 `[svg]` 组）。

**web 端不做**：`vendor/skia/lib/wasm` 里**根本没有** `libsvg.a`/`libsksg.a`/`libexpat.a`（`args.gn` 的
`skia_use_expat=false` 把 svg 目标整体门掉），定义 `ASC_USE_SVG` 会在**链接期**失败——是显式报错，
不是静默降级。要支持须改 wasm `args.gn` + 补四个库 + **重编 wasm Skia**，属独立工程。

**为什么不是 `examples/` 单元**：它需要 Skia 链接 **且**需要 `ASC_USE_SVG` 宏，而回归套件的每个
examples 条目都是**裸清单（纯 C 模式）**运行的，故覆盖落在 `temp/codec-probe/svg-probe.as`（证据）
+ `test.ts` 的 `[svg]` 8 项结构钉子（含 4 个反向对照变异，全部被捕获）。

### 4.2 E2 — Lottie 矢量动画

AIR 完全没有对应物（`flash.display` 里没有矢量动画播放器）。Skia 的 Skottie（`libskottie.a` + `libskresources.a`）
在 native 已构建且已在链接表，缺的只是一个 AS3 面（例如一个 `LottieSprite extends DisplayObject` 或让
`Loader.load("*.json")` 识别 Lottie）。同样是「AIR 之外」的增强，同样存在 native / web 不对称（web 需重编）。

### 4.3 E3 — 多格式图片解码 —— ✅ **已完成（默认拒绝 + `--features formats`）**

现有解码走 `SkCodec`，而 Skia 的编解码器**已经在两端编入** `libwebp_decode=true` 与 `wuffs=true`。
实测结论：**WebP / BMP / ICO 现在就能解码，不需要写一行代码**——与 SVG 不同，它们**是** SkCodec 格式，
走的就是现有那条通道。探针 `temp/codec-probe/codec-probe.as`（同一份源码分别用 native 清单与
web 清单构建），每格都核对**尺寸与像素**（左上应为 `ff0000` 红、右下 `ffff00` 黄）：

| 格式 | AIR（`mxmlc` + `adl 51.4.1`） | 本项目 native | 本项目 web |
|---|---|---|---|
| PNG（对照） | ok 37×23 | ok 37×23 `ff0000` | ok 37×23 `ff0000` |
| JPG（对照） | ok 37×23 | ok 37×23 `fe0000` | ok 37×23 `fe0000` |
| GIF（对照） | ok 37×23 | ok 37×23 `ff0000` | ok 37×23 `ff0000` |
| **BMP** | **`ioError #2124` unknown type** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| **WebP** | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| **ICO** | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |

- AIR 侧是**权威判据**（AGENTS.md §1.5）：`#2124` 说明这三种**确实是 AIR 之外**，故本条是**增强**而非欠账。
- web 侧由无头 Chrome 跑同一个页面取得（`ascErrors` 为空），与 native **逐格一致**。
- **QOI 不在支持面**：`SkQoiCodec` 未编入（`args.gn` 无 `skia_use_qoi`）。要支持须开该开关并**重编两端 Skia**，
  属另一件工程（与 SVG/Lottie 的 web 侧同型，见 §1.2c）。
- 附带发现：`SkRawCodec` 在 native 侧**已编入**（13 个符号），是 E4（相机 RAW/DNG）的现成通道。

**已定案（阶段九十四·二十五）：取 (b)，默认拒绝。** 按 §1.5/§1.2d，增强必须 opt-in——默认产物要与
AIR 同构，而这三种格式此前是**被动**放行的（默认构建接受 AIR 会拒绝的输入）。现在胶水层
（`vendor/skia_glue.cc` 的 `sk_extra_format_refused`）按魔数拦掉 WebP（`RIFF....WEBP`）/BMP（`BM`）/
ICO（`00 00 01 00`，CUR 同族）三族，拦下就走原有的解码失败路径 ⇒ 报 `#2124`，**文案与 `adl` 逐字相同**；
PNG/JPG/GIF 的魔数与之不可能撞车（`89 50 4E 47` / `FF D8` / `GIF8`），故不受影响。打开方式：

```bash
as-aot app.as --air-app app.xml --features formats     # 等于 -D ASC_ALLOW_EXTRA_FORMATS=1
```

实测（`temp/codec-probe/codec-probe.as`，同一份源码三次构建；`bash temp/codec-probe/run.sh` 一把复现）：
默认 → BMP/WebP/ICO 全部 `ioError #2124 Error #2124: Loaded file is an unknown type.`；
`--features formats` → 三者 `ok 37×23 tl=ff0000 br=ffff00`（与上表同值）；PNG/JPG/GIF 三次构建都正常。
**两端都实测过**：web 侧用 `codec-web.build.json` 构建同一份源码，在无头浏览器里读
`window.__ascStdout`——默认构建逐行与 native/`adl` 相同（BMP/WebP/ICO 全 `#2124`），
`--features formats` 三者同样 `ok 37×23 tl=ff0000`，SVG 两次都仍 `#2124`（各开各的开关）。**WBMP 故意不拦**：`SkWbmpCodec` 编入了，但它的头部是
裸多字节类型字段、没有可靠魔数，宁可如实记在这里（见 §4.3 末），也不去猜一个可能误伤真格式的判据。
`QOI` 仍不在支持面，须重编两端 Skia（见上）。

### 4.4 E13 — LTO / PGO 构建开关 —— ✅ **已完成**

「增强」在最纯的形态：这不是语言特性，而是把**成熟的编译器能力**（`-flto`、剖析数据）接到使用者手上，
一行优化都不手写（§1.1）。清单 `lto`/`pgo`/`pgo-dir` 与 CLI `--lto`/`--pgo`/`--pgo-dir` 两条路等价，
**默认全关**——不设时产物与以前逐字节相同，故不违反「默认产物保持与 AIR 同构」。

设计上唯一有内容的一点：`-flto` 必须**同时**在编译步与链接步上。只加一侧不会报错，只会**静默地不生效**，
这正是 §1.5「绝不静默」针对的那类失效；故标志由单一 `perfFlags()` 供给四个命令构造器，回归对
native/web 的**每一步**都有断言，并做了反向对照（漏任一步 → 测试立刻失败，实测 4 个变异全部被捕获）。
`-fprofile-correction` 被**特意不发**：那是 GCC 标志，clang 只警告 `not supported` 后忽略。

实测（`temp/perf/`，900k 次调用密集循环，五次取中位）：`-O2` ~30.6 ms → `-O2 -flto` ~25.6 ms（约 16%），
叠 PGO 无可测增益；三者校验和完全一致（只提速、不改语义）。**不宣称 PGO 是普适提速**——本负载分支简单，
PGO 的收益面是分支多/间接调用多的程序。详见 [`compile.md`](compile.md) §4.2。

### 4.5 E4 — 相机 RAW / DNG 解码 —— ✅ **已完成（默认拒绝 + `--features raw`）**

与 E3 同型的一次「以为要写代码、实测发现通道早就通了」。相机 RAW（DNG/CR2/NEF/ARW…）**不是** AIR 支持的
格式：`adl 51.4.1` 对一份真实 DNG 逐条实测为

| 入口 | AIR（`adl 51.4.1`） |
|---|---|
| `Loader.load(new URLRequest("file://…/sample_1mp.dng"))` | `ioError #2124 Error #2124: Loaded file is an unknown type.` |
| `Loader.loadBytes(ByteArray)`（同一份字节） | `ioError #2124` |
| `BitmapData.loadFile(...)` | **方法不存在**：`#1069 Property loadFile not found on flash.display.BitmapData and there is no default value.`（动态访问才编得过；mxmlc 对静态引用直接报「可能未定义」） |
| `t.png`（对照） | `ok 37×23 tl=ff0000` |

而本项目的 native 构建（阶段九十四·二十五起**默认拒绝**，见下）：

| 入口 | 本项目 native（默认） | 本项目 native（`--features raw`） | 本项目 web（任何情况） |
|---|---|---|---|
| `Loader.load` | **`ioError #2124`**（与 AIR 逐字相同） | **`ok 600×338`** | 与 AIR 同报 `#2124` |
| `Loader.loadBytes` | **`ioError #2124`** | **`ok 600×338`** | — |
| `BitmapData.loadFile`（我们自己的 String 通道） | 失败（仍 1×1） | **`ok 600×338`** | — |
| `BitmapData.draw` 另一份 DNG（`dng_with_preview.dng`） | **`ioError #2124`** | **`ok 600×338`** | — |
| `t.png`（对照，防 RAW 通道截胡） | `ok 37×23 tl=ff0000` | `ok 37×23 tl=ff0000` | `ok` |
| `t.svg`（非 RAW，仍走既有规则） | `ioError #2124` | `ioError #2124` | `ioError #2124` |

默认拒绝的实现：`sk_extra_format_refused` 认 TIFF 头（`II*\0`/`MM\0*`——DNG/CR2/NEF/ARW/ORF/RW2 等
全部 TIFF 系 RAW 的公共头）与 `FUJIFILMCCD-RAW`（RAF），命中即返回 NULL，走上层既有的
`#2124` 路径。开关：

```bash
as-aot app.as --air-app app.xml --features raw     # 等于 -D ASC_ALLOW_RAW_FORMATS=1
```

**为什么当初零代码**（现在被默认拒绝闸门挡住，见上）：RAW 在 Skia 里是 `SkRawDecoder`（`include/codec/SkRawDecoder.h`），它由
`skia_use_dng_sdk` + `skia_use_piex` 打开，本机的 native Skia 正是这么编的（`nm` 实测
`SkRawDecoder::Decode`/`IsRaw` 三个符号在 `libskia.a` 里），且它**已在 Skia 的默认编解码器表里**
（`SkRawDecoder::IsRaw` 恒真、注释明说「always checked last」）——所以 `DeferredFromEncodedData`
那条既有通道**本来就会**把 DNG 交给它。native 侧的 `libpiex.a`/`libdng_sdk.a` 早已在链接表里。

**web 侧是天然的诚实缺口**：`vendor/skia/lib/wasm/libskia.a` 里 **0 个** `SkRawDecoder` 符号，且
`vendor/skia/lib/wasm/` 里没有 `libpiex.a`/`libdng_sdk.a`（wasm 的 `args.gn` 没开这两个开关）⇒
web 构建对 DNG 与 AIR **逐字相同**地报 `#2124`，不会静默降级（§1.2c）。要支持须重编 wasm Skia，属独立工程。

**已实测的边界**：只验了 **DNG**（Skia 源码树里的 `resources/images/*.dng` 三份现成样本）。
`.cr2`/`.nef`/`.arw` 等其它 RAW 家族走的是同一条 piex 通道，但**本机没有样本，未实测**——
按 §1.5 记为「未验证」而不是「已支持」。

**覆盖安排**：与 E1/E3 一样不进 `examples/` 回归（它需要 Skia 链接），证据落在
`temp/codec-probe/raw-probe.as`（我们侧，四条入口 + 反向对照）与 `temp/codec-probe/RawAdl.as`（AIR 侧
基线，`adl 51.4.1` 逐条输出），清单 `temp/codec-probe/codec-raw.build.json`。

**与 E3 的同一条项，已同样定案（阶段九十四·二十五：默认拒绝 + `--features raw`）**。web 侧无须开关也
无法开关：`--features raw --target wasm` 会被**前置拒绝**并直说缺哪个归档
（`the wasm Skia has no piex/dng_sdk archive ...`），而不是抛一屏 `undefined symbol`（§1.5 跨端差异显式列出）。

### 4.6 E11 — FFI：直调宿主 C 函数

这是「直接生成 C」**独有**的红利：产物与宿主程序在同一个编译单元里，用元数据声明 + 生成 `extern` 声明即可直调。
字节码解释器（含 AIR）结构上做不到这件事。属于典型增强，但**只在 native 成立**（web 受沙箱限制，
需按 §1.2c 明确报「本后端不支持 FFI」）。

### 4.7 E9 — 64 位整数 `int64` / `uint64` —— ✅ **已完成（opt-in）**

**为什么算增强**：AIR 的数值只有 `Number`（double）与 `int`/`uint`（32 位），**没有** 64 位整数类型——
`mxmlc` 对 `var x:int64` 直接报未知类型，`adl` 永远跑不到这样的代码。因此接受这两个类型名**不可能**
改写任何 AIR 已定义行为（§1.2a），而收益是实打实的：C 的 `int64_t`/`uint64_t` 是原生类型，产物里
就是一条 64 位加法（依 §1.2d，不写这两个类型的源码，产物与从前逐字节同构）。

**怎么用**（完整契约见 `examples/stage94t.as` 的注释与 `test.ts` 的 `[int64]` 钉子）：

```as3
var a:int64  = 9223372036854775807L;        // L 后缀 ⇒ int64 字面量（数字按源码原文发射）
var u:uint64 = 18446744073709551615UL;      // UL / LU ⇒ uint64
var exact:*  = int64("9007199254740993");   // 动态值也原样保留（不经 double）
trace(a - 1L, u + 1UL, exact, a is int64);
```

| 规则 | 口径 | 理由 |
|---|---|---|
| 字面量 | `123L` → int64；`123UL`/`123LU` → uint64 | 数字**按源码原文**发射为 `INT64_C(...)`/`UINT64_C(...)`；若走 double，2^53 以上已经舍入，64 位就白错了 |
| 转换函数 | `int64(x)` / `uint64(x)` | 与 `int()`/`uint()` 同族：**强制**转换（String 解析十进制、Number 向零截断、Boolean→1/0、null→0） |
| 类型检查 | `x as int64` | tag 不符给 0，与 `x as int` 同规则；**强制**转换请用 `int64(x)` |
| 同型运算 | `+ - * % & \| ^ << >> >>> ~ ++ --` | 保持 64 位（这就是这个类型的意义） |
| 除法 | `/` 恒为 Number | 与 AS3 的 `int/int → Number` 同规则——除法结果不是整数 |
| 与 `int`/`uint`/`Boolean` 混合 | 对侧**精确**加宽进 64 位 | 无损，且比退化成 double 更好 |
| 与 `Number` / 动态 `*` 混合 | 整式退化为 Number | AS3 的数值提升规则；>2^53 会舍入（**这正是需要 64 位类型的原因**） |
| `int64` ↔ `uint64` | `+ - * %` 退化为 Number；位运算取无符号族；`< <= > >= == !=` 是**数学比较** | 无共同 C 类型；`int64(-1) < uint64(0)` 为 true（不是 C 的无符号重解释） |
| 装箱 | 独立 tag 8/9，值原样放 `as_value` | `*` / Array / Dictionary 里的 64 位值不经 double；`typeof` 报 `"number"`（AIR 无对应物，不可观测） |
| `%` 零除数 | 给 0 | C 的 `%` 是 UB；与 AS3 的 `int % 0` 同口径 |
| 移位量 | 掩到 0..63 | C 对 ≥ 位宽是 UB；AS3 的 32 位移位掩到 31，故此为忠实类比 |
| GC | tag 8/9 的 `ptr` 槽是**整数字节** | `gc_mark_value`/`gc_write_barrier_value` 用**显式 tag 表**：范围判断会把整数位当堆引用去标记 |

**明确的边界（绝不静默，均为编译期报错并附替代方案）**：`Vector.<int64>` 未做单态化（用 `Array` 或
动态槽）；把 64 位值存进 `Object` 槽（那里按 double 装箱会舍入——用 `*` 或 `int64`/`uint64` 槽）。

**跨端**：纯 C 特性，native / web(wasm) / WASI **同一份代码、同一个行为**（无胶水、无 Skia 依赖）；
`number` 的显示/解析（`as_i64_to_str`/`as_str_to_i64`）是自带的定点十进制实现，不依赖 libc 的
`printf` 变参格式（避免 `%lld` 的可移移植性问题）。

**验收**：`examples/stage94t.as`（A~G 七组、50+ 条断言，纯 C 构建 ⇒ 天然覆盖两端）；`test.ts`
的 `[int64]` 10 条结构钉子（词法后缀 / 原文发射 / 类型映射 / 转换函数 / 装箱 tag / 四个值助手 /
GC 显式 tag 表 / 三处 C 未定义边界的守卫 / 两处"响亮拒绝" / 示例金标）。

---

### 4.8 E16 — 显示器刷新率查询（`VsyncStateChangeAvailabilityEvent.refreshRate`）—— ✅ **已完成**

**为什么算增强**：AIR **没有任何查询屏幕刷新率的 API**。最容易想到的 `flash.display.Screen` 只有
`bounds`/`visibleBounds`/`colorDepth`——没有任何刷新率字段；而唯一与刷新率沾边的事件
`flash.events.VsyncStateChangeAvailabilityEvent` 在 `adl 51.4.1` 上实测**只有两个成员**：常量
`VSYNC_STATE_CHANGE_AVAILABILITY`（= `"vSyncStateChangeAvailability"`）与**只读** `available:Boolean`。
实测（`mxmlc` + `adl`）：构造器签名恰为 `(type:String, bubbles=false, cancelable=false, available=false)`
——**加第 5 个实参 `mxmlc` 直接拒绝**（"不超过 4 个"）；事件在 `ADDED_TO_STAGE` 之后**只派发一次**，
且 `available` 实测为 **`false`**。即：AIR 里这个事件连"屏幕支持 vsync 状态切换"都报不出来，
更报不出速率。

**增强内容**：在**完全保留 AIR 已定义面**的前提下，给该事件加一个**只读** `refreshRate:Number`：

| 面对 | AIR 口径 | 我们 | 是否改写 AIR 行为 |
|---|---|---|---|
| 常量串 | `"vSyncStateChangeAvailability"` | 同 | 否 |
| 构造器 | `(type, bubbles=false, cancelable=false, available=false)` | **同 4 参可用**，第 5 参 `refreshRate=0` **可选** | 否（纯追加） |
| `available` | 只读，实测 `false` | 同 | 否 |
| `refreshRate` | **不存在** | 只读 `Number`，= 窗口所在显示器的实测刷新率 | 是（**新增字段**，AIR 代码读不到它） |
| 派发时机 | 启动后一次 | 启动后一次 **+ 窗口落到不同速率的显示器时再一次** | 是（**新增派发点**，但监听器按 AIR 写法只关心 `available` 时行为不变） |

**为什么不需要 `--features` 开关**（与 §1.2d「opt-in」的关系）：opt-in 的目的是「不改默认产物的
可观测行为」。这里 AIR 形状的代码（4 参构造、读 `available`、按常量监听）**行为逐位不变**，
新增的字段与新增的派发点在 AIR 侧**根本读取不到**（AIR 编译器不允许那个实参、AIR 的类没有那个属性），
故不存在"默认产物偏离 AIR"的可能——这与 E9（`int64` 类型名 AIR 里不存在）同理。**跨端差异显式**：
web 与离屏（headless）后端**查不到**面板刷新率 ⇒ `refreshRate` 派发**直接不发生**（`rr <= 0` 即返回），
**不派发一个伪造的 `0`**——监听器在 web 上收不到事件，这正是"缺能力就报明"的形态。

**用法**（可移植地把逻辑帧率对齐真实面板）：

```as3
stage.addEventListener(VsyncStateChangeAvailabilityEvent.VSYNC_STATE_CHANGE_AVAILABILITY, onVsync);
function onVsync(e:VsyncStateChangeAvailabilityEvent):void {
    if (e.refreshRate > 0) stage.frameRate = e.refreshRate;   // native：跟面板走
}                                                              // web：收不到事件，帧率维持原值
```

**配套的 AIR 面**：`Stage.vsyncEnabled`（AIR **有**此开关，可写；实测默认 `true`）已接线为**应用级**
单值（与 `Stage.frameRate` 同为"整个应用一个值"，见 `as3-semantics.md` §2）。它为 `true`（默认）时
代码路径与从前逐字节相同；为 `false` 时**去掉"显式 frameRate 高于面板刷新率就封顶"**这条规则
（AIR："the player does not wait for the display's vertical refresh"）——即那段长期存在的
"维持现状"注记（见 `as3-semantics.md` §2 帧率口径行）现在有了 AIR 自带的退出阀。

**验收**：`examples/vsyncevent.as`（离屏，两端同形；断言构造器两形态、`available` 只读、常量串、
`vsyncEnabled` 读写与默认值、`refreshRate` 缺省 `0`）；`test/unit/vsync.ts` 的结构钉子；窗口探针
`temp/vsyncwin/`（native 真机：`VSYNC available=false refreshRate=120` → 移到 60 Hz 外接屏派发
`refreshRate=60` → 移回 120 Hz 再派发 `120`，`stage.frameRate` 同步跟随）；Starling demo 已改为
监听该事件并 `stage.frameRate = e.refreshRate`，基准场景峰值无退化（`front` 59280 / 旧基线带 61.4k–66.2k）。

---

### 4.9 E10 — `Vector.<Number>` 批量 SIMD —— ⛔ **已实测：不排期**

**为什么当初列进来**：`Vector.<Number>` 单态化成连续 `double` 数组（`spectralnorm` 0.80× C 就是这个形态），
看上去「只差显式向量化」。**实测结论：不差。** arm64 上这笔收益不存在，而真正 5.4×/12× 的缺口在**别处**
（逐元素守卫，已另登记进 `TODO.md` 的 `### 遗留待开发`）。

**实测口径**（`temp/simdprobe/`，Apple M2 Max / arm64，`24 × 1M` 元素，`-O2 -ffp-contract=off`；
C 侧 `hand.c`/`hand_small.c` 与 AS3 侧 `saxpy.as`/`saxpy_fn.as` **同规模同形状**；手写 NEON 与裸标量 C
**都用局部指针、无全局**，故可比）：

| 形状 | 裸标量 C | 我们（现状） | 现状**去掉**逐元素守卫 | 手写 NEON | **显式 SIMD 的增量** |
|---|---:|---:|---:|---:|---:|
| `c[j]=a[j]+b[j]*1.5`（f64 元素级） | 6.3–6.8 ms | **38–47 ms** | **7 ms** | 6.1–6.2 ms（2 lane） | **0–8%（多在噪声内）** |
| `ic[j]=ia[j]+ib[j]`（int32 元素级） | 2.9–4.0 ms | **34–36 ms** | **3 ms** | 2.9 ms（4 lane） | **≈0** |
| `s+=a[j]*b[j]`（归约） | 22.3 ms | 21–22 ms | 22–23 ms | —— | **语义上不能用** |
| `c=a/(b+1)`（L1 常驻，82 M 元素） | 13.1–14.8 ms | —— | —— | 13.0–13.7 ms | **0–4%** |

**三条原因**（都可复现，不靠推断）：

1. **AArch64 的 NEON `f64` 只有 2 lane**，而 M 系列标量 FP 端口本来就宽 —— 元素级与 L1 常驻的除法
   实测 2-lane 与标量**同吞吐**；`int32`（4 lane）同样为 0，因为它是「2 读 1 写」的**访存**形状。
2. **归约形状被语义挡住**：要 SIMD 就必须重结合，与 AS3「每步一次舍入」冲突（`-ffp-contract=off` 连 FMA
   收缩都关了）。而这恰恰是**已经与 C 持平**的那一类（21–22 vs 22.3 ms），本来也没有可赚的。
3. **代价面**：生成 C 里出现 `<arm_neon.h>`/`<immintrin.h>` 直接撞 AGENTS.md §2.6「不写平台耦合写法」，
   并把「native / web / WASI 同一份 C」这条性质拆成两端分叉（web 还要额外开 wasm `simd128` 工具链）。

**顺带量出来、真正的那个缺口（不属 E10）**：把 `c[j]=a[j]+b[j]*1.5` 的逐元素访问换成裸 `->data[j]`
（**其余一字不动**）⇒ **38→7 ms**；`-Rpass` 同时显示 clang **自动**给出 `vectorization width: 2`（f64）、
**`width: 4`（int32）** 且 `interleaved count: 4`——**与手写 NEON 同形**。即「显式化 SIMD」这件事 `-O2`
已经在做，挡住它的是**逐元素守卫**（循环体里有 `set` ⇒ 与输入 `Vector` 别名 ⇒ `v->length` 不能证明
循环不变）。该优化**不需要 intrinsics**，两端同形。

**语义反证（已验）**：我们那条归约的校验和 `-302163170` 与 C 里 `volatile` 串行加法**逐位相同**
⇒ clang 没有重结合我们的浮点循环，红线未破。（另一个可观测项：顶层脚本变量落内存值 ~21%，
同三个循环放进**函数**即 38→30 ms。）

**口径与未测面（如实报明）**：探针是**合成**形状（覆盖「元素级 + 归约」两类基本面），不是某个真应用的
负载画像；未测 x86/Windows（本机 arm64 无法测）与 wasm 的 `simd128`；`-O3 -march=native` 重编我们的
生成 C 与 `-O2` 无差别（⇒ 瓶颈不在优化等级）。`Array`（**非** `Vector`）那个 5.4× 是另一码事
（`int`↔`double` 往返依赖链），E10 不覆盖。

**出处**：`temp/simdprobe/{saxpy.as,saxpy_fn.as,hand.c,hand_small.c,serial.c}`；证据含 `-Rpass` 报告与
`main` 的反汇编（每元素 **3** 个 `cbz` 空指针守卫 + **4** 次 `length` 比较 + 5 个分支）。

---
### 4.10 E18 — `System.exit(code:uint)` 带状态码退出 —— ✅ **已完成（阶段二百四十五）**

- **判定**（AGENTS §1.5 硬判据）：`adl` 对 `System.exit()` **报错**（`#2018`）⇒ AIR 明确不支持 ⇒ 属**增强**，不是遗留欠账。
  AIR 侧也确实没有等价物：`NativeApplication.exit()` 无参，没有任何 API 能把状态码交给宿主操作系统。
- **跨端差异（显式列出）**：同一行 `System.exit(7)` 在 `adl` 上抛 `#2018`，在我们这里**以 7 退出**。这是有意的分歧，
  且只有**显式调用**它的程序才会看到——未调用者与 AIR 逐字同形，故不设 `--features` 开关（开关的本意是「默认与 AIR 同形」，
  而照抄 AIR 的行为等于把这个 API 变成不可用）。
- **编译面按 AIR 对齐**（`mxmlc 51.4.1` 实测口径）：实参个数**严格 1**（`System.exit()` 报「参数个数不正确。需要 1 个」），
  类型 `uint`；`int`/`uint` 字面量直接强转、`Number` 走 `as_to_uint32`、`*` 走 `as_v_uint_cast`。**不用 C 强转**：
  `(unsigned)double` 在越界/NaN/±Infinity 上是 UB，而 AS3 的 `ToUint32` 有定义（→ 0 或按 2^32 回绕）。
- **延迟**：**不是立即终止**，与 `NativeApplication.exit()` 同一延迟（本帧收尾完才退出），调用点之后的语句仍会执行。
- **顺带修掉的诊断缺陷**：`System` 的任何未知成员此前报 `undefined variable 'System'`（把人引向「少写 import」），
  现在报 `System has no member 'X'`。
- **证据**：`examples/system-exit.as`（池内，exit 0）+ `examples/system-exit-status.as`（`SKIP_FILES`）+
  `test/examples.ts` 的串行用例（断言进程**真的以 `7` 退出**，且 `before`/`after` 都打印）；`unit: emit/SystemExit` 7 条；
  `unit: diagnostics/Codegen` 2 条；变异 3/3 全部被抓（`return as_exit_status;`→`return 0;`、窗口臂去掉
  `as_window_request_exit()`、arity 文案改串）。
- **已知比 AIR 宽松的一处**：`System.exit(true)` 我们接受（`(unsigned)true`），`mxmlc` 在编译期拒绝（`Boolean` 无隐式转换到
  `uint`）。这是「`uint` 形参一律按数值转换」的既有全局口径，未为单个 API 特殊化。

### 4.11 E19 — macOS 菜单栏状态项（`SystemTrayIcon`）—— ✅ **已完成（opt-in）**

- **判定**（AGENTS §1.5 硬判据）：`adl 51.4.1` 在 **macOS** 上 `NativeApplication.supportsSystemTrayIcon == false`、
  `new SystemTrayIcon()` 抛 `Error #2012: SystemTrayIcon$ class cannot be instantiated.` ⇒ AIR 在本平台**没有对应物**
  ⇒ 做出来是**增强**，不是补平差距（同一份 AS3 在 Windows 的 AIR 上是有托盘的，所以这不是「AIR 不支持」，而是
  「AIR 在 macOS 不支持」——这也正是它必须是 opt-in 的原因：默认产物要与本平台的 AIR 同形）。
- **开关**：`--features tray`（= `-D ASC_USE_TRAY=1`）。可用目标是 `native`，**且要求宿主就是 macOS**——`native` 编的
  是本机可执行文件，所以这条能前置校验；在别的宿主上直接报
  `feature 'tray' needs a darwin host`（而不是给一个什么都不做的开关）。
- **默认（不开开关）**：`supportsSystemTrayIcon` 仍为 `false`，`new SystemTrayIcon()` 仍抛 `#2012`，**菜单栏不出现任何东西**。
  钉在 `unit: emit/SystemTrayIcon`（39 条）。
- **开了之后的行为**（全部为实测，证据见本节末尾）：
  - 构造即安装一个 `NSStatusItem`（`NSVariableStatusItemLength`），**`bitmaps` 里的每一张有效位图都是一个
    `NSImage` representation**（最多 4 张；**直通 ARGB、由胶水层预乘一次**，与 Dock 图标同一条规则），`tooltip`
    原样上屏，`menu` 展平成 `NSMenu` 挂在状态项上。
  - **多档位图 = 多分辨率**：AIR 对 `SystemTrayIcon.bitmaps` 的说明就是「放不同尺寸以适配不同显示分辨率」，而
    macOS 上尺寸只能意味着密度（菜单栏恒 22pt）：22px 高的位图是 1x、44px 的是 2x，由 AppKit 按状态项所在的
    那块屏自己挑。**只给 2x 是错的**——非 Retina 屏上就只剩 AppKit 的一次降采样，15pt 的图里 1.5pt 的描边会被
    平均成雾（本机 2560×1440 副屏实测如此，`temp/` 与 `prune` 侧的截图对照）。
    每张 representation 还必须**显式声明自己的 point 尺寸**（`setSize:`，= 图元尺寸 / 密度）：不声明的位图在
    AppKit 眼里一律是「1 像素 == 1 point」，2x 那张就被当成「比 NSImage 大一倍、需要缩回去」的图，而 1x 那张
    永远不会被当成 1x 变体选中 —— 结果是**两块屏上都糊**（实测：2x 主屏上 SVG 直译的扫把读成一根斜棒，1x 副屏
    上整张图被重采样，连 11.5pt 的数字都发虚）。同一台机器、同一份代码，加上 `setSize:` 后两屏都回到 1:1 像素。
    钉在 `unit: emit/SystemTrayIcon` 的「every tray rep declares the point size that fixes its scale」。
  - **点击派发 `ScreenMouseEvent`**：左键 `MouseEvent.CLICK`、右键 `MouseEvent.RIGHT_CLICK`，`screenX/screenY` 是
    **点击点**的屏幕坐标（左上原点、point），`commandKey/controlKey/altKey/shiftKey` 取自当时的修饰键，`isRelatedObjectInaccessible=false`。
  - **菜单只在右键弹出**：状态项挂了 `menu` 之后，AppKit 的常规做法是左右键都弹菜单；那样左键就永远不能表示
    别的东西了。这里的选择是**左键留给应用**（派发 `click` 给 AS3）、**右键弹菜单**，且**先派发事件再弹**——
    AS3 在回调里刷新勾选状态，用户看到的就是刷新后的那份。
  - **菜单项点击**走 `as_menu_click_cb`，即与 App 菜单 / Dock 菜单**同一条 tag 通道**：`NativeMenuItem` 与其所在
    `NativeMenu` 各收一次 `Event.SELECT`。三个安装目标共用一张 tag 表，托盘的那段从 `appItems + dockItems` 之后开始。
- **跨端差异（显式列出）**：同一段 AS3 在 `adl`（macOS）上抛 `#2012`，在本构建上拿到真状态项 —— 这是**有意的分歧**，
  且只有显式打开开关的程序才看得到。web/WASI 目标上这个开关被前置拒绝。
- **已知边界（如实登记，不假装完备）**：
  - **一个进程一个状态项**：第二次 `new SystemTrayIcon()` 复用同一个菜单栏槽位（胶水层 `g_tray_created` 早返回），
    即「最后构造的那个图标拥有它」。AIR 在 macOS 上没有行为可抄，Windows 侧未实测，故按最保守的语义固定并文档化。
  - **`icon.menu` 的键盘等价键（`keyEquivalent`）未映射修饰键**：与 App/Dock 菜单同一条既有口径，见 `TODO.md` 遗留表。
  - **不显示 Windows 那种气泡通知**（`SystemTrayIcon` 的 balloon 系列 AIR 本来就没有）。
  - **图标不做彩色**：`NSImage` 被标成 **template image**，由系统按当前菜单栏的明暗用标签色重绘（白色图标在浅色
    菜单栏上会消失，反之亦然）。所以位图的 RGB 只贡献 alpha —— 需要彩色图标的场景在本通道上做不到，明说而不是静默丢色。
  - **位图是「像素」而不是「矢量」**：本通道只收 ARGB 像素（`BitmapData`），所以同一个图形必须在每种密度上**各画一次**、
    而不是由系统重绘矢量。由此引出一条只能靠看图发现的限制：**15pt 上放不下的细节就是没有**。产品的扫把图标因此
    有意偏离了设计稿的路径转写（设计稿里"头"与手柄等宽共线，15pt 上并成一根斜棒；改成"细手柄 + 张开的三片刷毛"，
    姿态/位置/单色都照旧），1x 那张再把笔画加粗 25%（1px 的 45° 斜线被抗锯齿稀释后只剩一半的墨）。
    这条属**美术适配**、不是语义分歧，但既然是"与设计稿不一致"，就写在这里而不是留给人猜。
  - **左键不弹菜单**（见上一条）：这是与 AppKit 惯例的有意分歧，理由是左键在真实产品里另有含义；`menu` 仍然在，
    只是入口是右键。
- **证据**：真机验收 —— 状态项出现在菜单栏（`menubar.png`）、`ScreenMouseEvent` 的 `screenX/screenY` 与 AX 报告的
  状态项位置逐点吻合（AX `(1110,7) 40×24` vs 点击 `(1130,19)`）、右键 `rightClick`、菜单项点击收到 `Event.SELECT`
  （`temp/trayprobe/live-log.txt`：`CLICK` / `RIGHT_CLICK` / `MENU SELECT from Open Panel`）；
  示例 `examples/status-item.as`（23 断言，带 `features: ["tray"]` 清单）；单元 `unit: emit/SystemTrayIcon`（39 条）
  与 `[features]` 组的 8 条（含「默认构建不链 `statusitem_glue.cc`」「非 macOS 宿主拒绝」两个反向对照）。

---
## 5. 与排期 / 回归的关系

- **排期**：本清单的**待办视图**在 `TODO.md` 的 `### 增强待做`；本文负责「是什么、为什么、依赖什么」。
- **不做默认**：清单里任何一项在实现前都不改变默认产物；实现时必须 opt-in（§1.2d）。
- **入库条件**：每一项落地都要过 §1.2 的五条 + AGENTS.md §4 的 DoD（示例 + 断言回归 + 文档 + 版本）。
- **跨端差异**：凡 native / web / WASI 能力不等价，**必须在本文 §3 表里写明**，并在运行时报错文案里点名缺什么。