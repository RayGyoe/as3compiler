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
| 打错字 | 静默无效（clang 不管未使用的宏）——**正是 (b) 禁止的** | `unknown feature 'sgg' (known: svg)` 并在生成代码前退出 |
| 跨端能力 | 要用户自己知道 web 编不出来 | `feature 'svg' is not available with --target wasm` 直报（标准 c） |
| 开了之后 | 不声不响 | 构建横幅点名 `== enhancements: svg (-D ASC_USE_SVG=1) ==`，再明说这是 AIR 超集 |
| 集合语义 | 只能追加 | `--features` **替换**整个集合（`-D` 才是追加），故「只留 X」可表达；`--features none` 清空 |

**只有真正端到端实现过的通道才会登记为名字**。登记一个没实现的开关，等于给用户一个「看着开了、
实际没编进去」的东西——比不提供开关更坏。故当前表里只有 `svg`（E1）；E2（Lottie）/E4（RAW-DNG）
实现后才登记。

**与 `--air-app` 的配合**：`--air-app` 每次运行都会整份重写生成的 `<filename>.build.json`，所以
选择必须能挺过重写——`--features svg` 会把它写进清单，**下次不带参数仍然生效**并打印 carry-over
提示（不静默）；`--features none` 关闭。只有 `features` 被继承，其它字段仍是描述符+源码的函数。

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

> 状态口径：**已有** = 现在就能用（可能只是没写文档/没写示例）；**半成品** = 库已在、缺 AS3 面；
> **待建** = 需要新胶水或改工具链。目标端里的「web 需重编」= 需要改 `build-tools/skia-src/out/wasm/args.gn`
> 并重建 wasm 版 Skia。

| # | 增强项 | AIR 现状 | 我们的现状 | 目标端 | 成本 |
|---|--------|---------|-----------|--------|------|
| E1 | **SVG 运行时解码**（`Loader.load("*.svg")` → `Bitmap`） | ✗ 从不支持（实测 `#2124`） | ✅ **native 已实现（opt-in）**：`--features svg`（= `ASC_USE_SVG=1`）时四条解码入口全部支持；web 无 svg/sksg/expat 库，**不支持** | native 已完成 / web 需重编 | native **已完成** |
| E2 | **Lottie 矢量动画**（Skottie 播放 `.json`） | ✗ 无对应物 | native：`libskottie.a` 已构建 + 已链接，缺播放器 API | native 现成 / web 需重编 | 中 |
| E3 | **多格式图片解码**（WebP / BMP / ICO） | 部分：仅 JPG / PNG / GIF（实测 `adl 51.4.1` 对 BMP/WebP/ICO 报 `#2124`） | ✅ **已具备、零代码**：两端实测**全部解码正确**（见 §4.3）；`QOI` **不在内**（未编入 `SkQoiCodec`） | 两端 | **已完成（实测确认）** |
| E4 | **相机 RAW / DNG 解码** | ✗ | native：`libpiex.a` / `libdng_sdk.a` 已构建（未链） | native 现成 / web 需重编 | 低-中 |
| E5 | **矢量图形直接上屏**（`Shape` 走 `SkPath`，无限分辨率） | ✗（`BitmapData` 只有位图） | Skia 已在，缺 AS3 面 | 两端 | 中 |
| E6 | **原生着色器直通**（MSL / GLSL ES） | ✗（只有 AGAL 寄存器语言） | AGAL→MSL/GLSL 翻译器已在（`ASC_AGAL_TARGET`），缺「提交原生 shader」的扩展 API | 两端 | 中 |
| E7 | **GPU 通用计算**（Metal compute / WebGL2 transform feedback） | ✗ | 需新胶水层 | 两端 | 高 |
| E8 | **无窗口 / 服务端出图** | 半（可离屏，但绑死 AIR 运行时） | **已具备**：headless 可跑，`stage.render()` 直接出 PNG | 两端 | 已有 |
| E9 | **64 位整数**（`int64` / `uint64`） | ✗（`int` / `uint` 都是 32 位） | C 原生类型 | 两端 | 中 |
| E10 | **`Vector.<Number>` 批量 SIMD**（NEON / SSE） | ✗ | C 原生 + `-O2` 自动向量化已部分生效，可显式化 | 两端 | 中-高 |
| E11 | **FFI：声明并直调宿主 C 函数** | ✗ | **「直接转 C」的独有红利**（与宿主同一编译单元） | native | 中 |
| E12 | **真并发 `Worker`（OS 线程）** | 部分（AIR Worker 受限、需 `flash.concurrent`） | 已有 4 worker 池（目前只服务异步 IO） | native | 中 |
| E13 | **LTO / PGO 构建开关** | — | ✅ **已实现**：清单 `lto`/`pgo`/`pgo-dir` + CLI `--lto`/`--pgo`/`--pgo-dir`，**默认全关**（见 §4.4） | 两端 | **已完成** |
| E14 | **帧录制 / 确定性重放** | ✗ | 运行时自持（帧边界、事件、随机源都在我们手里） | 两端 | 中 |
| E15 | **可读 C 作为一等交付物**（嵌入宿主工程 / 人工审改） | ✗ | **已承诺**（README：「保留 `.c` 便于阅读」） | 两端 | 已有 |

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

### 4.3 E3 — 多格式图片解码 —— ✅ **实测完成（零代码）**

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

**尚未做的一件事（需要你定）**：按 §1.5，增强应当 **opt-in**（默认产物与 AIR 同构）。当前这三种格式是
**被动**放行的——默认构建就接受 AIR 会拒绝的输入。两条路：**(a)** 保持现状（超集行为，只增不减，
对 AIR 上能跑的程序无影响），把「默认构建对图片格式是 AIR 的超集」明确写进文档；**(b)** 默认拒绝、
加显式开关才放行（严格同构，但要主动写代码去**降低**能力）。**已在文档中如实记为待定**，未擅自选择。

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

### 4.5 E11 — FFI：直调宿主 C 函数

这是「直接生成 C」**独有**的红利：产物与宿主程序在同一个编译单元里，用元数据声明 + 生成 `extern` 声明即可直调。
字节码解释器（含 AIR）结构上做不到这件事。属于典型增强，但**只在 native 成立**（web 受沙箱限制，
需按 §1.2c 明确报「本后端不支持 FFI」）。

---

## 5. 与排期 / 回归的关系

- **排期**：本清单的**待办视图**在 `TODO.md` 的 `### 增强待做`；本文负责「是什么、为什么、依赖什么」。
- **不做默认**：清单里任何一项在实现前都不改变默认产物；实现时必须 opt-in（§1.2d）。
- **入库条件**：每一项落地都要过 §1.2 的五条 + AGENTS.md §4 的 DoD（示例 + 断言回归 + 文档 + 版本）。
- **跨端差异**：凡 native / web / WASI 能力不等价，**必须在本文 §3 表里写明**，并在运行时报错文案里点名缺什么。