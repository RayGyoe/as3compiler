# Skia 渲染后端调研与集成方案

> 本文回答两个问题：**为什么用 Skia 实现 GUI**，以及 **Skia 与事件/视图系统的关系到底有多大**。
> 核心结论先行：Skia 是**纯 2D 光栅化库**，它只负责「把几何/位图/文字画成像素」；显示列表
> （`DisplayObject` 树）、事件流、命中测试这些 AS3 语义**不在 Skia 里，要我们自己用 C 运行时实现**
> （阶段三十三~三十五，Ruffle 作语义参照）。Skia 与我们自建的事件/视图系统是**正交**关系，二者唯一的
> **汇聚点**是 `DisplayObject.render()`——每个显示对象把自己的几何翻译成 Skia 的 `SkCanvas` 绘制调用。
>
> 定位：Skia 之于本项目，等价于「阶段二十九 GUI 方向规划」里说的「链接 skia/cairo 而非自研光栅化」，
> 它替换的是**像素输出**那一层，不是显示列表/事件那一层。

---

## 1. 为什么选 Skia（以及和 cairo 的取舍）

Skia 是 Google 开发维护的开源跨平台 2D 图形库，Chrome / Android / Flutter 的底层渲染引擎。

| 维度 | Skia | cairo |
|------|------|-------|
| 维护方 | Google（Chrome/Android/Flutter 背书） | GNOME 社区 |
| 语言 | **C++20** | C（有稳定 C ABI） |
| 后端 | CPU raster / GPU（Vulkan/Metal/GL/D3D）/ PDF/SVG | CPU raster / GL / PDF/PS/SVG |
| 文本 | SkFont/SkTextBlob + SkParagraph（完整排版） | Pango/Cairo toy API（需外挂排版） |
| 抗锯齿 | 高质 AA + analytic AA | 好 |
| 矢量 Path | 极强（含 pathops 布尔运算） | 强（有 path 布尔） |
| 协议 | **BSD-3-Clause**（宽松，可静态链接闭源） | LGPL/MPL |
| 体积/构建 | 重（GN/ninja，`libskia.a` 数十 MB） | 轻 |

**选 Skia 的理由**：AS3 的 `flash.display.Graphics`（矢量 `moveTo/lineTo/curveTo` + 渐变填充 + 描边）
本质上就是「Path + Paint」模型，Skia 的 `SkPath`/`SkPaint`/`SkShader` 与之**语义几乎一一对应**；加上
Flutter 生态大量依赖 Skia，社区成熟、跨平台一致性好。cairo 的优势是「有 C ABI、体量小」，但它的文本
排版要外挂 Pango，矢量渐变的 API 也比 Skia 繁琐。

**本项目决策**：主用 **Skia**，渲染层通过一个 **C++ 胶水层（glue）** 暴露 `extern "C"` 接口给生成的
`.c` 调用（见 §4）。cairo 作为「体量敏感场景」的备选后端保留在选项里，但默认不做。

---

## 2. Skia 核心概念（对应本项目要用的那部分）

Skia 的一切围绕 `SkCanvas`（画布）组织。绘制调用 `canvas->drawRect(rect, paint)` 分两部分：
**被画的东西**（`SkRect`/`SkPath`/`SkImage`/text）与**怎么画**（`SkPaint`：颜色、填充/描边、线宽、
着色器、混合模式）。

| 类 | 职责 | 对应 AS3 概念 |
|----|------|--------------|
| `SkCanvas` | 绘图入口，维护矩阵/裁剪栈（`save`/`restore`/`translate`/`rotate`/`scale`/`clip*`） | `Graphics` 的绘制目标 + `DisplayObject` 的 `x/y/rotation/scaleX/scaleY` 变换 |
| `SkPaint` | 颜色、填充/描边样式、线宽、抗锯齿、混合模式、shader/filter | `Graphics.lineStyle`/`beginFill`/`blendMode`/滤镜 |
| `SkPath` | 直线/贝塞尔/圆弧组成的几何路径 | `Graphics.moveTo/lineTo/curveTo` 的路径数据 |
| `SkSurface` | 像素承载者（CPU/GPU/PDF），`getCanvas()` 取画布 | Stage 的位图表面 / `BitmapData` 的像素缓冲 |
| `SkBitmap` / `SkImage` | 位图像素存储（`SkBitmap` 偏可写，`SkImage` 偏只读） | `BitmapData` / `Bitmap` |
| `SkImageInfo` | 宽高 + 颜色类型 + alpha 类型（如 `kN32_SkColorType` premul） | `BitmapData` 的像素格式（ARGB） |
| `SkMatrix` | 3×3 仿射变换矩阵 | `DisplayObject.transform.matrix` |
| `SkFont` / `SkTypeface` | 字体与字号 | `TextField` / `TextFormat` 的字体设置 |
| `SkTextBlob` | 排版好的字形 run | `TextField` 的文本内容（基础路径） |
| `SkShader`（`SkGradientShader`） | 渐变/图案填充 | `Graphics.beginGradientFill` |
| `SkBlendMode` | 像素混合运算 | `DisplayObject.blendMode` |
| `SkMaskFilter` / `SkImageFilter` | 模糊等滤镜 | `BlurFilter`/`DropShadowFilter` |

**坐标系**：Skia 原点在左上、**y 轴向下**——与 Flash 的显示坐标系一致，翻译时无需翻转。

### 2.1 像素字节序边界：`kN32` 因平台而异（务必显式指定）

`BitmapData.pixels` 在运行时里是 `uint32` 数组，存的是**数值** `0xAARRGGBB`（straight alpha）。而 Skia 的
「原生」格式 `kN32_SkColorType` 只是**平台相关**别名：

| 平台 | `SK_R32_SHIFT` | `kN32` 的内存字节序 |
|------|----------------|----------------------|
| Windows | 16 | B,G,R,A（`kBGRA_8888`） |
| macOS / Linux | 0 | R,G,B,A（`kRGBA_8888`） |

（依据 `include/core/SkTypes.h` 的 `SK_R32_SHIFT` + `SK_PMCOLOR_BYTE_ORDER(R,G,B,A)` 展开，与
`include/core/SkColorType.h` 的 `kN32_SkColorType` 定义。）

因此**生成的 C 绝不能假设 Skia surface / `SkBitmap` 的字节序**——「看起来像 BGRA」只在 Windows 成立。
所有「Skia ↔ 运行时」的读回都统一请求 `kBGRA_8888` + `kUnpremul`，端序解析收敛在 `skia_glue.cc` 一处：
小端主机上 B,G,R,A 的字节序列按 `uint32` 读出**已经就是** `0xAARRGGBB`，于是「显式指定」这一件事就把
通道序定死了、无需逐像素循环；`kUnpremul` 同时给出 AS3 的 straight alpha，省掉手工反预乘。只有大端主机
才需要显式重组（`__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__` 分支，当前无此目标）。

历史教训：`BitmapData.draw(TextField)` 的读回曾直接按 `q[0]=B, q[2]=R` 取通道（把 `kN32` 当成 BGRA），
在 macOS 上把红蓝互换（红背景 `TextField` 被读成蓝色）。回归：`examples/bitmapdraw-channel.as`。

同类边界还有两处，处理原则一致：

- **图像解码**（`sk_image_decode_argb` / `sk_image_decode_bytes_argb`）：`readPixels` 直接写进 ARGB 缓冲，
  不再经临时缓冲 + 逐像素 swizzle。
- **Stage3D 纹理上传**（`stage3d_glue.mm` 的 `s3d_upload_texture`）：目标是 `MTLPixelFormatBGRA8Unorm`，
  小端下与运行时缓冲字节序**天然一致**，直接 `replaceRegion` 即可（旧代码那次 malloc + swizzle 在小端上
  是逐字节空转）。

---

## 3. 关键决策：Skia 没有 C API，必须加 C++ 胶水层

这是本方案最重要的技术结论，也是此前文档里「链接 skia」没点破的一个细节：

- 当前 Skia `main` 的 `include/` 目录（android / codec / config / core / cpu / docs / effects / encode /
  gpu / pathops / ports / private / sksl / svg / third_party / utils）里**没有 `c/` 子目录**——早期用于
  PDFium/部分绑定的 C API（`sk_canvas.h` 等）已被移除，Skia 现在是**纯 C++20 接口**。
- 而我们的编译器产出的是 **C**（`as-aot` 生成 `.c`），C 无法直接链接 C++ 符号（名字修饰、`SkRefCnt`
  引用计数、`sk_sp<>` 智能指针、异常等）。
- 因此**必须**有一层手写的 C++ 胶水文件（`skia_glue.cc`），用 `extern "C"` 把要用的 Skia 能力包成
  平坦 C 函数，生成的 `.c` 只调用这些 `sk_*` C 函数。这正好落在阶段二十九的构建清单能力里：

```json
{
  "target": "native",
  "c-compiler": "clang",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia"],
  "link-libs": ["skia", "…"],
  "link-paths": ["../vendor/skia/lib/macos-arm64"],
  "defines": ["ASC_USE_SKIA=1"]
}
```

#### 3.1 胶水层是两个翻译单元：图形半边 + 文本半边（阶段二百二十一）

`skia_glue.cc` 从阶段二百二十一 起**拆成两个 `.cc`**，理由不是"文件太大"，而是**链接语义**：
**对象文件是整份参与链接的**。拆之前它同时装着图形与文本，只要文本段引用了
`skia::textlayout::*`，链接器就必须解析 `libskparagraph.a → libskunicode.a → libharfbuzz.a →
libicu.a → libicu.icudtl_dat.o`（那 10.19 MB 是**一个不可分的数据对象**）⇒ **一行字都不画的程序
也把整条整形栈拉进二进制**（实测 19.43 MB，与画字的程序**同尺寸**）。实测也排除了两条捷径：
`-ffunction-sections` 编胶水 + `-Wl,-dead_strip` 链接**仍然失败**（`Undefined symbols:
skia::textlayout::StrutStyle::StrutStyle()`），只给最终二进制加 `-dead_strip` 也救不了 ICU。

| 文件 | 内容 | 何时进链接 |
|---|---|---|
| `vendor/skia_glue.cc` | 图形半边（surface/canvas/paint/path/渐变/滤镜/位图/SVG/编解码）+ **平台字体管理器** | Skia 构建**总是** |
| `vendor/skia_text_glue.cc` | 文本半边（`sk_text_measure*`、`sk_canvas_draw_text*`、全部 `sk_textlayout_*`、AIR 行盒/strut 换算、设备字体别名） | 只有程序用到 `flash.text`（含 SWC 烘焙出的文本字符）时 |
| `vendor/skia_glue_internal.h` | 两半唯一的共享声明 `sk_platform_fontmgr()`（C++ 链接，**故意不 inline**） | 头文件 |

#### 3.2 链接期两刀 + ICU 数据只取 0.80 MB（阶段二百二十二）

拆完对象之后还剩两块纯浪费，都不改任何语义：**链进来但跑不到**的代码，和**链进来但读不到**的数据。

- **`-Wl,-dead_strip -Wl,-x`**（`src/build.ts::linkTrimFlags`）：前者让 ld64 先丢不可达块再解析块内引用，
  胶水 `.o` 里提到而程序没调用的 Skia API 不再拉成员进来；后者砍 `__LINKEDIT` 的局部符号表，
  全局符号不动。`--debug-info` 时只发 `-dead_strip`（那个构建要符号）。ELF/COFF 的 `--gc-sections`
  需要编译期 `-ffunction-sections -fdata-sections`（含预编译 archive）才有效，故**整族不发**；
  `-flto` 实测在这套 archive 上**反而大 13 KB**，维持 opt-in。
- **ICU 数据**：`libskunicode.a` 里那个单成员 `icudtl_dat.o` 是**整份桌面数据集**（10.19 MB）。
  构建期把 `vendor/skia/icu/icudtl_flutter.dat`（0.80 MB，Skia 自己给 wasm 用的那份）汇编成对象，
  **放在 `-l` 之前**定义了 `_icudt69_dat` ⇒ archive 成员**根本不会被读**，无需改 `vendor/` 里的任何 `.a`。
  汇编出的 `.s`/`.o` 与其它对象一样落在**本次构建独占**的临时目录（`$TMPDIR/as-aot-obj/<配置指纹>-<pid>/`），
  源树里只留被跟踪的 `.dat`（见 `docs/zh-cn/compile.md` §3.5 与 `rust-text-backend.md` §3.2）。
  断行规则、bidi 属性、NFKC 都在小份里；被裁掉的是 collation/locales/curr/region/rbnf/translit/转换表/unames。

| 构建 | 拆分后 | + 两刀 | + 小 ICU 数据 |
|---|---|---|---|
| 不画文字 | 6.53 MB | **3.55 MB** | 3.55 MB |
| 画文字 | 19.43 MB | 15.51 MB | **6.05 MB** |
| `--air-app` Skia app | — | 18.80 MB | **9.34 MB** |

已知缺口：**Windows** 的数据对象在 `skunicode.lib` 里且是 COFF，需在 Windows 上重编（本机无法验证）；
**Linux** 没有预编译树，且分节要编译期旗标。两者都记在 [`rust-text-backend.md`](rust-text-backend.md) §10。

**接缝不变**：生成的 C 仍只调那 15 个 `sk_*`（`runtime.ts:8763–8789`），搬的只是实现。
**字体管理器刻意留在图形半边**——SVG 的 `<text>` 要把它交给 `SkSVGDOM`，而 web 的字体注入
`sk_fontmgr_register_data` 改的是同一个缓存、且 `EXPORTED_FUNCTIONS` **无条件**导出它；
搬过去会让"不画字的 web 构建"链接失败。构建层的判定（`src/index.ts::usesTextEngine`）、运行时的
两态接缝（`ASC_HAVE_TEXT`，无引擎时**一次性 stderr 警告**）、实测与坑详见
[`rust-text-backend.md`](rust-text-backend.md) §2。

> 上面只画**形态**（`link-libs` 实际有二十余项，整段抄进文档只会过期——本文件早先的版本就是这样把
> `skia_glue.c` 与 `include-paths: ["../vendor/skia/include"]` 写错的）。**唯一权威是
> [`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json)**，
> 文档里的命令一律 `--manifest` 引用它，不另抄一份。Skia 是 C++：胶水层是 `.cc`，`build.ts` 认
> `sources` 里的 `.cc/.cpp` 并自动切到 C++ 驱动（`clang++`，隐式链 `libstdc++`），链接同样由 C++
> 驱动收尾——这些在阶段三十六 就已实装。回归守卫：`test/unit/build.ts` 的
> `build/DocumentedLinkSets` 用**真实清单**的 `defines` 编译一次生成的 C，任何一条文档清单定义的
> 后端组合编不过都会红（2026-10-06 就是离屏那条分支缺 `AS_CURSOR_*` 而静默失效）。

**胶水层设计原则**（遵守 AGENTS.md §2.9）：

1. 只暴露**平坦 C 函数**，签名全部 `extern "C"`，参数只含 POD（`int/float/double/const char*/指针`），
   不暴露 `sk_sp`/`SkString`/STL 容器。
2. 所有 Skia 对象用**不透明指针**（`void*` / `sk_handle`）进出，生命周期由胶水层内部管理（引用计数），
   对应 AS3 侧的 `as_skia_*` 运行时助手。
3. 平台耦合（窗口/表面创建）集中在胶水层，生成的 `.c` 不直接碰任何 Skia 头文件——`#ifdef __wasi__`
   仍收在 `RUNTIME_PREAMBLE` 里（native 用 CPU raster / SDL，WASI 用离屏 raster 输出 `SkImage`）。

---

## 4. `flash.display.*` → Skia 映射表（核心）

这是「用 Skia 实现 GUI」的实际翻译对照。**记住一条主线**：显示列表（谁是谁的父、深度序、命中测试）
由阶段三十四/三十五的 C 结构实现；Skia 只在**叶子渲染**处接手，把几何画进 `SkCanvas`。

| AS3（`flash.display` / `flash.filters`） | Skia 翻译 | 备注 |
|-----------------------------------------|-----------|------|
| `DisplayObject.x/y/rotation/scaleX/scaleY` | `canvas->translate(x,y)` + `rotate` + `scale`（在 `save`/`restore` 内） | 对应 AS3 的矩阵变换 |
| `DisplayObject.alpha` | `SkPaint::setAlpha` 或 `saveLayerAlpha` | 子对象整体透明用 `saveLayerAlpha` |
| `DisplayObject.visible=false` | 跳过该子树渲染 | 纯显示列表判断，不涉及 Skia |
| `DisplayObject.blendMode` | `SkPaint::setBlendMode`（`SkBlendMode::k*`） | AS3 `BlendMode` 枚举 → Skia 枚举映射 |
| `Shape.graphics.moveTo/lineTo/curveTo` | `SkPath::moveTo/lineTo/cubicTo/quadTo` | `curveTo` 是二次贝塞尔 → `quadTo` |
| `Graphics.beginFill(color, alpha)` | `SkPaint` fill 风格 + `setColor`/`setAlpha` | `endFill` 后 `drawPath(path, paint)` |
| `Graphics.lineStyle(thickness, color, alpha)` | `SkPaint` stroke 风格 + `setStrokeWidth` + `setStrokeMiter/Cap/Join` | 描边属性逐项对齐 |
| `Graphics.beginGradientFill(...)` | `SkGradientShader::MakeLinear/MakeRadial` → `SkPaint::setShader` | linear/radial 两类 |
| `Graphics.drawCircle/drawRect/drawRoundRect` | `SkCanvas::drawCircle/drawRect/drawRRect` | 快捷几何（`drawRoundRect` 的两个半径按 AIR 口径折成 `SkRRect` 椭圆角，见阶段二百六十七） |
| `Bitmap.bitmapData` / `BitmapData` | `SkBitmap`/`SkImage` + `drawImage` | `BitmapData` 是像素缓冲，`Bitmap` 是显示节点 |
| `BitmapData.setPixel/getPixel` | `SkBitmap::setPixel/getColor`（或 `SkPixmap`） | CPU 读写像素 |
| `BitmapData.draw(source)` | `SkCanvas::drawImage/drawSurface`（离屏 surface 合成） | 位图间拷贝/合成 |
| `TextField.text`（基础字形） | `SkFont` + `SkTextBlob` → `drawTextBlob` | 仅字形定位，无换行 |
| `TextField`（完整排版：换行/对齐/段落） | **SkParagraph**（`modules/skparagraph`）→ `SkParagraph::layout` + `paint` | AS3 的自动换行/多行需要 SkParagraph |
| `TextFormat.font/size/color/bold/italic` | `SkFont` + `SkTypeface` + `SkPaint` | 字体族/字号/加粗/斜体 |
| `filters.BlurFilter` | `SkImageFilters::Blur`（`saveLayer` 包裹子树） | 已落地（阶段六十一），`sigma = blur * sqrt(quality) / sqrt(12)` —— 按 AIR 的「直径 = `blurX` 的 box 重复 `quality` 次」做**方差匹配**（阶段九十五·七实测钉定，取代早先的经验值 `blurX/3`）。剖面仍是高斯近似：中部更陡、尾部更薄 |
| `filters.DropShadowFilter` | `SkImageFilters::DropShadow` / `DropShadowOnly`（`saveLayer` + `SkImageFilter`） | 已落地（阶段六十一），外投影。阶段九十五·七补 `strength`（模糊**之后**乘，`min(1, 剪影 × alpha × strength)`，对齐 adl 实测）与 `hideObject`；注意 `DropShadow` 工厂本身已把**源**合成进去，`strength` 绝不能套在它的输出上（会把整个对象打薄 —— 见 `swc.md` §9.2 F4 的 137/255 事故） |
| `filters.GlowFilter` | `SkColorFilters::Matrix`（alpha 轮廓着色）+ 模糊 + 叠本体 | 已落地（阶段六十一），外发光。阶段九十五·七补 `strength`（同 DropShadow，且在模糊后乘：前置 alpha 因子因剪影不透明会饱和，实测 `strength 1` 与 `2` 会一模一样）|
| `DisplayObject.mask` | `canvas->saveLayer` + mask 绘制 + `SkBlendMode::kSrcIn` | AS3 遮罩语义 |
| `scrollRect` | `canvas->clipRect(0,0,w,h)` **再** `translate(-x,-y)` | 窗口钉在对象自己的盒上、只有**内容**平移（阶段一百六十二实测，见下方「坐标变换」与 D29）|

**坐标变换的正确姿势**（对应 Skia `SkCanvas` 的矩阵栈）：

```
渲染一个 DisplayObject 子树（递归）：
  canvas->save();
  canvas->translate(obj->x, obj->y);
  canvas->rotate(obj->rotation);
  canvas->scale(obj->scaleX, obj->scaleY);
  canvas->concat(obj->transform.matrix);     // 若有完整 matrix
  // if (obj->scrollRect) { clipRect(0,0,w,h); translate(-x,-y); }
  //   ↑ 顺序不能颠倒：Skia 的 clipRect 按**调用时**的 CTM 映射，先 translate 再 clip
  //     会把窗口本身挪到 (x,y,w,h)（窗口跟着内容滑）—— 阶段一百六十二的 D29 就是这个错。
  // 1) 先画自身：obj->render_self(canvas)   （Shape 画 path、Bitmap 画 image、TextField 画 textBlob）
  // 2) 再按深度序画子对象：for child in children: render(child)
  canvas->restore();
```

> **深度序**：`DisplayObjectContainer` 的渲染顺序 = 深度序（低 depth 先画，高 depth 后画覆盖在上）。
> 这与阶段三十五「鼠标命中逆序、键盘正序」是同一份 children 数组，两个视角。**渲染用正序，鼠标命中用逆序**。

---

## 5. Skia 与事件系统：正交，而非「高度相关」

这是直接回答「是否和事件视图高度相关」的部分：

- **Skia 完全不提供**：显示列表/场景图、事件分发（capture/bubble）、命中测试、焦点、窗口管理、
  输入设备抽象。这些正是阶段三十三~三十五要自建的东西，语义参照 Ruffle。
- **事件系统不依赖 Skia**：`hitTestPoint(x, y)` 判断「鼠标点在哪个对象上」，用的是**显示列表的几何
  （坐标变换 + 形状）**，不是 Skia 的像素。Ruffle 的 `interactive.rs` 命中三态机（`Avm2MousePick`）
  遍历的是 `DisplayObject` 树，与渲染后端完全解耦。
- **二者的唯一汇聚点是 `render()`**：事件系统决定「谁先响应、谁被命中」，渲染系统决定「最终画成什么样」。
  一个对象先被命中（阶段三十五的几何命中），再被渲染（本文件的 Skia 翻译）。两者共享同一份
  `DisplayObject` 树，但职责正交。

**可选复用**：Skia 的 `SkPath::contains(x, y)` / `SkRegion` 可以**辅助**实现 `hitTestPoint` 的「点在
形状内」判定（尤其是复杂矢量形状）。但这只是锦上添花——AS3 的 `hitTestPoint(shapeFlag=false)` 默认
用包围盒（bounding box，几何判定），只有 `shapeFlag=true` 才做形状级命中。**首期用包围盒即可**，
SkPath 命中留到需要精确形状命中时再接。

> 一句话：**Skia 管「画」，事件/视图管「谁在上面、谁先响应」**。两者通过 `DisplayObject.render()`
> 这个接口在叶子节点汇合，而不是「高度耦合」。

---

## 6. 构建与链接（落地要点）

### 6.1 获取与编译 Skia

> **本项目实际落地方式（动手改 `vendor/skia/` 之前必读）**：`vendor/skia/include` 来自上游预编译包，但
> **`vendor/skia/lib/macos-arm64/libskia.a` 是从源码自编的**（源码树 `build-tools/skia-src`），并带回一份
> **本地补丁**（见 §6.9 与 `vendor/skia/patches/README.md`）。**切勿用上游预编译包覆盖它**——那个补丁修的
> 是 CoreText 会在「同族同 PS 名」的两个字体文件之间换脸（阶段一百六十七）。wasm / Windows 两份库**未打**
> 该补丁（改动只在 macOS/iOS 分支）。
>
> 历史情况：本机当初缺 `gn`/`ninja` 且磁盘空间不足，故曾用
> [Aseprite 官方预编译 Skia](https://github.com/aseprite/skia/releases) **m124**
> （`Skia-macOS-Release-arm64.zip`）。该包自带头文件（`include/`）与全套静态库（`out/Release-arm64/*.a`），
> 已解压为 `vendor/skia/{include,lib}/`，并连同 PNG/JPEG/WebP/freetype/harfbuzz/icu/zlib 等传递依赖
> 一起接入构建清单（见 `examples/skia-link.build.example.json`）。**若需自行从源码编译，走下面流程**。

Skia 用 **GN/ninja** 构建，需 C++20 编译器（官方强烈建议 **clang**，软件光栅化/图像解码用 clang 才能
触发最优路径，其他编译器性能明显下降）。

```bash
git clone https://skia.googlesource.com/skia.git
cd skia
python3 tools/git-sync-deps        # 拉第三方依赖（libpng/libjpeg-turbo/libwebp 等）
python3 bin/fetch-ninja

# 产出静态库 libskia.a（is_official_build=true 表示 release、动态链接系统依赖）
bin/gn gen out/Static --args='is_official_build=true'
ninja -C out/Static skia           # 目标名 skia → out/Static/libskia.a

# 若需要 SkParagraph（TextField 完整排版）
bin/gn gen out/Static --args='is_official_build=true skia_use_skparagraph=true'
ninja -C out/Static skia skparagraph
```

产物布局（假设装到 `vendor/skia/`）：

```
vendor/skia/
  include/   ← 头文件（include/core, include/effects, include/codec, ...）
  lib/       ← libskia.a（+ libskparagraph.a 等）
```

### 6.2 构建清单如何接

阶段二十九的 `build.ts` 已支持 `sources`/`include-paths`/`link-libs`/`link-paths`。渲染阶段需要补两点：

1. **C++ 胶水层编译驱动**：`sources` 里出现 `.cc/.cpp` 时，用 `clang++`（而非 `cc`）驱动，并保证
   链接 `-lstdc++`（macOS 的 `clang++` 隐式带上）。
2. **Skia 的传递依赖**：`libskia.a` 依赖 libpng/libjpeg-turbo/libwebp/fontconfig/freetype/zlib 等。
   `is_official_build=true` 时这些走系统动态库，链接行需补齐 `-lpng -ljpeg -lwebp -lz ...`（或直接
   链接 Skia 自带的 `skia_public` 描述）。**首期建议**：用 `is_official_build=false` 把所有依赖静态
   打进 `libskia.a`，链接行最干净，代价是编译更久、库更大。

### 6.3 渲染后端选择（首期建议 CPU raster）

| 后端 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| **CPU raster**（`SkSurface::MakeRaster` / `SkBitmapDevice`） | 零窗口系统依赖、零 GPU 驱动、可离屏输出、易测 | 大画布慢 | **首期**：离屏渲染 → 输出 PNG/位图，或交给 SDL 上屏 |
| GPU（Vulkan/Metal/GL/D3D） | 快、动画流畅 | 依赖图形 API + 窗口上下文 | 后期做真实桌面窗口时再接 |
| PDF/SVG（`SkDocument`） | 矢量输出 | 非交互 | 可选：`BitmapData` 导出 |

**推荐落地顺序**：先做**离屏 CPU raster**（`SkSurface::MakeRaster` → `SkCanvas` → `makeImageSnapshot`
→ `SkImage::encodeToData(SkEncodedImageFormat::kPNG)`），这样 `as-aot --run` 能直接产出位图文件、
可回归断言像素，且完全不碰窗口系统。真实桌面窗口已落地（阶段三十九：SDL2 上屏 + 事件循环；阶段四十：鼠标输入桥接回 AS3 事件系统，见 [`compile.md`](compile.md) §6）。

> 这正是本项目「前端只翻译、优化交给成熟库」铁律的延续：**我们连窗口和像素都不用自研**，Skia 负责像素，
> SDL2 负责窗口与输入（已落地：阶段三十九窗口上屏 + 阶段四十鼠标事件桥接，见 [`compile.md`](compile.md) §6），我们只负责把 AS3 语义翻译过去。

### 6.4 版本选型结论（为什么 SDL 用 2.32、Skia 用 m124）

**SDL：2.32.10 就是当前 SDL2 主线，不旧。** 见 [`compile.md`](compile.md) §6（窗口后端）。项目 pin 的是
SDL2 而非 SDL3，理由：SDL3（2025-01 首发 3.2.0）太新，社区生态/教程/第三方绑定 90% 仍在 SDL2；对「单窗口
+ 把 Skia 表面 blit 上屏」的轻量场景无实质收益；且 SDL3 移除了 `SDL_CreateRGBSurface`、改了渲染器接口、
把 `SDL_Event` 改成 union，`window_glue.cc` 里的 `SDL_CreateRGBSurfaceFrom`/`SDL_RenderCopy`/
`SDL_GetWindowSizeInPixels`/`SDL_RenderSetVSync` 全都要重写。这些能力（尤其 `SDL_GetWindowSizeInPixels`，
SDL 2.26 才加入）正是修复跨屏倍率 bug 的依赖，说明 2.32 对本项目够用且恰好支持所需。我们是源码编译 arm64
静态库（`configure --host=arm64-apple-darwin --disable-shared`），版本自控，无需追一个刚满一年的新大版本。

**Skia：m124 确实旧（约 2.5 年，m124 ≈ 2024-04），但有具体原因。** 注意「环境受限」那一层**已不再是**原因——
它是**历史情况**，§6.1 的「本项目实际落地方式」已如此标注：仓库根 `build-tools/skia-src` 现在就是完整 m124
源码树（含 `bin/gn` + `third_party`），`vendor/skia/lib/macos-arm64/libskia.a` 正是从它**自编**、并带回一份本地
补丁（`vendor/skia/patches/`）。真实原因三条：① Skia 无稳定 API/ABI，milestone 每 4 周滚动、接口频繁变动，
升级意味着重写整层 `skia_glue.cc`；② 四份平台库（`macos-arm64`/`wasm`/`windows-x64`/`windows-x86`）与 vendored
头必须**同批换**，本地补丁要重打、`[skia-abi]` 的逐字节钉子要重跑——§6.5 记过「同一个 milestone 内部」上游改
`kMaxSubclassSize` 就够砸坏寄存器（`x28`）的事故，跨 milestone 只会更大；③ m124 已含所需全部模块
（`SkParagraph`/`Skottie`/GPU 后端）。**升级触发条件**：只有当确需新 milestone 才有的特性（如某个新
`SkImageFilter`、新字体引擎行为）时，才从 `build-tools/skia-src` 换上对应 milestone 重编（**无需**再补
`gn`/`ninja` 环境），并重测整个胶水层。

> **2026-10-19 复核（v0.4.179）**：`skia-canvas` **4.0.0**（2026-10-12 发布）捆 **Skia m153**（`skia-safe`
> 0.99.0），但它是 **Node.js 的 N-API 绑定**、走运行时 JS Canvas 调用，与本项目「**编译期**把 Skia C++ 静态链进
> 原生产物 / wasm」**不在同一层**，无接入路径（本项目 npm 依赖恒为空，§3.1）。4.0 的修复清单里也没有可捡的：
> 唯一的跨端项（macOS Metal 导出器缺 autorelease pool ⇒ 原生缓冲泄漏）我们早已有（`metal_glue.mm` /
> `stage3d_glue.mm` 的 `@autoreleasepool`）。**未因此重开「升 milestone」决策，触发条件不变。**

### 6.5 vendored 头必须与预编译库**同版本**（这是 ABI，不是文档）

`vendor/skia` 里是**预编译库 + 一份头文件拷贝**。两份东西一旦不同步，症状不是「画错」而是**内存/寄存器被写坏**：
阶段八十九·七十四 实测到 `vendor/skia/include/gpu/GrBackendSurface.h` 停在**旧一版 m124**，`kMaxSubclassSize`
为 `64/160/160`，而编出 `vendor/skia/lib/libskia.a` 的那棵树（`build-tools/skia-src`）是 `80/176/176`。
后果是**栈上的 `GrBackendRenderTarget` 我们按 160 字节留位、库按 176 字节写**——库的构造器越界写 16 字节，
正好砸在 `sk_mtl_begin_frame` 自己保存 `x28`/`x27` 的栈槽上（clang 的 canary 就在旁边 `sp+0x138`）。
表现：`-O2` 的 `examples/air-native` 启动约 1 秒即 SIGSEGV，而 `-O0` 完全正常、**任何加打印/加计数的扰动构建都会掩盖它**
（因为扰动改变了帧布局与寄存器分配）。

- **判据**：`diff -rq vendor/skia/include build-tools/skia-src/include` 必须为空。
- **同 milestone 不代表布局一致**：m124 内部上游也改过 `kMaxSubclassSize`（并且 `VulkanTypes.h` 也补过字段），
  所以「都是 m124」不足以安心——要**逐字节比对**。
- **回归钉子**：`node test.ts` 的 `[skia-abi]` 组（3 项）钉住 `kMaxSubclassSize` 的具体值、`VulkanTypes.h` 的字段，
  并在 `build-tools/skia-src` 存在时要求两份头**逐字节一致**（不存在时打 `SKIP` 并保留字面值钉子）。
- **升级流程**：任何「换 vendor/skia」的操作都要**头 + 库一起换**，并跑 `[skia-abi]`；只换库会立刻回落到上述状态。

### 6.6 Metal 后端的窗口状态是**按窗口**的（阶段八十九·七十五）

`metal_glue.mm` 最初是**进程级单例**（一份 `CAMetalLayer` + `GrDirectContext` + drawable + surface），只服务一个窗口。
后果不是「第二个窗口画慢」，而是**运行期 `new NativeWindow()` 一律拿不到 Metal**，落回 CPU 光栅 +
整帧 `SDL_UpdateTexture` 上传（600×410 @2x = 3.9 MB/帧/窗口，116 fps 下 ~470 MB/s），且成本**随开窗数线性叠加**
（实测每窗 +12~14% CPU，三窗 44%）。现在：

| 状态 | 归属 | 说明 |
|---|---|---|
| `MTLDevice` / `MTLCommandQueue` / `GrDirectContext` | **全进程共享** | Skia 要求它们比 context 活得久；第一个 GPU 窗口惰性创建，最后一个槽释放时拆掉 |
| `CAMetalLayer` | **每窗口**（槽 `g_mtl[id]`） | 由该窗口的 `SDL_MetalView` 提供，只是借用：必须在销毁 view **之前**释放 |
| 一次性 `CAMetalDrawable` + 包它的 `SkSurface` | **每窗口** | `sk_mtl_begin_frame(id, …)` 取、`sk_mtl_flush(id)` present 并释放 |

- **id 就是全链路那把钥匙**：`ASC_wins[]`（生成 C）/ `WinCtx[]`（window_glue.cc）/ `g_mtl[]`（metal_glue.mm）
  三张表同索引，容量常量 `ASC_MAX_WINDOWS` = `SK_MAX_WINDOWS` = `SK_MTL_MAX_WINDOWS` = 16 必须一致。
- **哪些窗口走 GPU**：`ASC_RENDER_METAL` 构建下，主窗口恒走 Metal；运行期 `NativeWindow` 默认也走
  （AIR 的 `NativeWindowRenderMode.AUTO` 就是「有 GPU 就用 GPU」），只有显式 `renderMode = "cpu"` 才落回软件光栅。
  同一份二进制只改这一行的实测对照（两个副窗口）：**32.8% → 14.0% CPU 平均**。
- **反向对照必须留在代码里**：`#ifndef ASC_RENDER_METAL gpu = 0;` 保证「没有 Metal 后端的构建」不会凭空
  产生一个自称 Metal 的窗口；`renderMode="cpu"` 则是同一构建内的反向对照（`temp/gpuprobe/`）。
- **踩坑（Objective-C++）**：`.mm` 里的参数**不能叫 `id`**——那会遮蔽 `id` 这个**类型关键字**，函数体内所有
  `id<CAMetalDrawable>` 会被解析成比较表达式，整文件编译失败。参数名统一用 `win_id`。
- **语义边界**：cpu 模式窗口在 Metal 构建里**不合成 Stage3D/StageVideo**——AIR 文档明确「软件窗口不支持
  StageVideo/Stage3D 合成」，且 Metal 构建下本就没有 CPU 回读缓冲（暴露渲染目标纹理正是为了省掉每次回读）。
  这不是静默降级，是 AIR 已定义行为。
- **回归钉子**：`node test.ts` 的 `[native-window]` 组新增 15 项（Metal 唯表分槽、容量一致、每种入口带 id、
  ObjC++ `id` 关键字、attach/释放顺序、`renderMode` 选后端、渲染/on_resize 分流、纯 C stub 与 Skia 版同形、
  示例必须走默认路径）。

---

### 6.7 画面必须 1:1 呈现，绝不能被合成器缩放（阶段一百三十三）

**症状**：`examples/air-native`（`scaleMode=NO_SCALE` + `align=TOP_LEFT`，Metal 合成）拖动窗口做
resize 时，**整个画面剧烈抖动** —— 不是撕裂、不是内容重排，而是整幅图在每一帧之间被放大/缩小一点点。

**根因**：`CAMetalLayer` 的 `contentsGravity` **默认是 `kCAGravityResize`**（`metal_glue.mm` 里此前
从未设置过它，注释里却写着「top-left gravity」）。于是合成器把 drawable **拉伸到铺满 layer 的
bounds**。而 live resize 期间我们提交的那帧 drawable 与合成器此刻使用的 bounds **必然短暂不一致**：
窗口在我们画完那一帧之后还在继续变大，所以**无论我们在绘制时刻取哪个尺寸都不可能同时满足**
（`SDL_GetWindowSizeInPixels` 与 layer bounds 都来自 Cocoa，但合成器用的是更晚的几何）。
Resize 语义下这一帧就把**整幅画面**按 `bounds/drawable` 重采样一次 —— 即所见的抖动。

**修法**：`l.contentsGravity = kCAGravityTopLeft;`。这正是 AIR `scaleMode=NO_SCALE` 的语义
（内容尺寸固定、左上锚定）：尺寸还没跟上的那一帧**原尺寸**显示、新露出的区域留背景，等下一帧补上，
**永不重采样**。稳态（`drawableSize == bounds*contentsScale`）下两种 gravity 逐像素等价，故是纯收益。

**实测**（`temp/resizeprobe/fast.py`：`CGWindowListCreateImage` 进程内取帧 ~68 次/s，与
Quartz 合成的快拖并发）：

- **量尺要选对（踩过一次坑）**：最初拿 demo 里固定的红色「open window」方块（100x50 逻辑 ⇒
  2x 下应恰好 200x100 px）当尺子 —— **不行**。另有一个 100x100 的红方块会**动画漂移**到它旁边，
  二者在 4 连通下**合并成一个分量**，读出「尺寸变了」的假象（一度被当成残留缺陷）。改用
  **完全孤立**的 `identity` 中灰方块（44x44 逻辑 ⇒ **88x88 px** @(1120,1020)）后度量才可信。
- **结果**（拖一次 500 px / 0.3 s）：

| `contentsGravity` | 被重采样（尺寸不对）的帧 | 实测样本 |
|---|---|---|
| `kCAGravityResize`（修前默认） | **15 / 93**（4 次拖拽：2/24、5/23、4/23、4/23） | 83x84@(1063,981)、86x86@(1111,1014)、85x85@(1084,994)… |
| `kCAGravityTopLeft`（修后） | **0 / 151**（6 次拖拽，且无任何异常帧） | —— |

- **样本自证是「整幅重采样」而非局部扰动**：83x84@(1063,981) 的 83/88 = 0.943、
  1063/1120 = 0.949、981/1020 = 0.962 —— **两维与原点偏移同比缩小 ~0.94**，即关于原点
  的均匀缩放，比例逐帧在 0.94~0.98 之间变化（正是拖动中窗口尺寸在变）。
- **不破「未绘制残留」**：修后拖拽中的瞬时帧在右下角（新露出区）**只有 2 种颜色**、与稳态帧同区域
  一致（无接缝、无垃圾像素）—— 即新露出区显示的就是舞台背景，1:1 呈现的代价只是「背景多露一条」，
  而不是花屏。

**注意**：慢速脚本拖拽（每步 ~2 px）**看不出**这个缺陷 —— 每步的缩放比只有 ~0.3%，必须用**用户速度**
的快拖复现（本 harness 的 `[px] [ms/step]` 参数）。早期用 `screencapture` + 慢拖取样「看起来一切正常」，
正是这个原因。

**回归钉子**：`test/unit/platform.ts` 的 `unit: platform/PresentScale`（9 条，跨两个宿主文件）；
把两处改动回退成修前形状后其中 **5 条当场变红**。探针：`temp/resizeprobe/{fast.py,fastdump.py,measure.py,drive.py,drag.py}`。
Windows 侧同源缺陷见 [`win32.md`](win32.md) §2.10。

#### 6.7.1 透明窗是另一条呈现路径，同一行也必须钉（阶段二百八十七）

**背景**：上面钉的是 `CAMetalLayer`。但 **透明窗口根本不走 Metal** —— `window_glue.cc` 的
`present_frame()` 在 `c->transparent` 时直接调 `sk_mac_present_layer()`，把这一帧做成 `CGImage`
交给一个 layer-hosting `NSView` 的 `CALayer`（`setContents:`）。那块 layer **不是** Metal 那块，
阶段一百三十三的钉子**从未覆盖它**，而 `CALayer` 的 `contentsGravity` **默认同样是 `kCAGravityResize`**。

**症状**（TalkMED 桌面端的形态：透明圆角面板随内容长高/拉宽）：**每次窗口几何先动、下一帧还没到**
时，上一帧被**拉伸铺满新的 bounds** —— 而且因为拉伸不看宽高比，画面会**横向拉长/压扁**（比 Metal 那条
更难看）。live resize 时每个拖动帧都会命中。

**实测**（`temp/transjitter/`，探针自缩放：透明窗 400↔700 pt 每 300 ms 切换，`requestedDisplayResolution=high`，
2x 屏；量尺是 40x40 逻辑 = **80x80 设备像素**的红方块）：

| 形状 | 采样 | 方块实测尺寸 | 被重采样帧 |
|---|---|---|---|
| `contentsGravity = resize`（默认，修前） | 151 帧 | `(80,80)`×136、`(45,80)`×8、`(140,80)`×7 | **15 / 151** |
| `contentsGravity = topLeft`（修后） | 155 帧 | `(80,80)`×155 | **0 / 155** |

- `140/80 = 1.75`（窗宽 700 显示 400 宽的旧帧）、`45/80 = 0.5625`（窗宽 400 显示 700 宽的旧帧），
  **纵向恒 80** ⇒ 确认是「整幅按 bounds 拉伸、纵横比不管」而非局部扰动。
- 修后新露出的区域（窗口比这一帧大时）显示的是**透明**而不是被拉伸的内容，与 AIR 的 `NO_SCALE`
  一致：内容保持自身尺寸、锚在左上，**宁可裁/留白，绝不重采样**。
- 采样手法：`CGWindowListCreateImage` 忽略窗口图形但**读合成后的结果**，所以量到的是「合成器看到
  什么」——这正是这条缺陷的可观测面（读进程内 buffer 会漏掉它）。

**修法**：`sk_mac_ensure_transparent()` 建 host layer 时加一行
`SK_SET_OBJ(hl, "setContentsGravity:", sk_nsstring("topLeft"));`（与 Metal 那条对称）。
**回归钉子**：`unit: platform/PresentScale` 新增 4 条（钉住「确实设了 gravity」「是 topLeft 且只有一处」
「设在 host layer 上且在第一帧之前」「图像仍按 surface 自身尺寸构建，代码里没有缩放」）。

**顺带确认（本机实机，同日）**：**普通（不透明）窗口路径未复现抖动** —— 重建 `examples/air-native`
后按其 §6.7 的同一套快拖 harness 采样：marker 恒 `88x88`、原点恒 `(1120,1020)`，**0 帧被重采样**；
`ASC_FRAME_STATS=1` 四个拖拽循环 `p50 = 8.17~8.30 ms`（约 120 fps）、`over17ms = 0~5`、`worstgc = 0.00`。
即 macOS 的 `CAMetalLayer` 与设备倍率两条主路径**已经修好**，剩下的未覆盖面只有透明窗这一条。

#### 6.7.2 跨屏时透明窗的 layer **不会**自己换 backing scale（阶段二百九十八）

**背景**：6.7.1 修的是「同一块屏上、几何先动」的拉伸。跨屏还有第二件事：**倍率本身变了**。
`sk_mac_ensure_transparent()` 为了拿到 alpha，把内容视图做成 **layer-hosting**（`[contentView setLayer:]`），
而 layer-hosting 的定义就是「AppKit 不再管理它的 backing」—— 于是 `-viewDidChangeBackingProperties`
那一套**不会**传导进来，这块 layer 及其子 layer 永远停在**窗口创建时那块屏**的 `contentsScale` 上。

**症状**（净扫面板，2x 内建屏 1800x1169 + 1x 外接屏 2560x1440）：窗口在 Retina 屏上创建（`contentsScale = 2.0`），
拖到 1x 屏上打开 —— **整块面板缩到窗口左上角四分之一，其余全是空白**。

**为什么可以断定是「倍率过期」而不是「帧尺寸过期」**：帧是**对的**。`do_resize` 已经从
`SDL_GetWindowSizeInPixels` 拿到 340x440 设备像素并报给 AS3，`CGImageCreate` 也照这个尺寸建图。
如果帧是 680x880 而 layer 没缩放，观感会相反 —— 左上四分之一露出**放大的**局部（只有标题栏和半个列表）；
实测看到的是**整块面板（含底部按钮）缩成一半**，那只可能是 340x440 px 被按 2.0 当成 170x220 **point** 画。
重新上传帧没用：错的不是帧，是那个数。

**实测**（`prune` 面板，同一份二进制，两屏各点一次菜单栏图标）：

| 屏 | 面板逻辑尺寸 | 窗口 bounds | 捕获 png | 修前内容占位 | 修后内容占位 |
|---|---|---|---|---|---|
| 主屏 2x | 340x440 | `1448,45 340x440` | 680x880 | 满幅 | 满幅 |
| 副屏 1x | 340x440 | `2208,-1404 340x440` | 340x440 | **170x220（左上四分之一）** | 满幅 |
| 副屏 1x（展开） | 340x619 | `2208,-1404 340x619` | 340x619 | — | 满幅 |
| 主屏 2x（展开） | 340x619 | `1448,45 340x619` | 680x1238 | — | 满幅 |

**修法**：`sk_mac_present_layer()` 在 `setContents:` **之前**调 `sk_mac_sync_layer_scales(c)`：
读一次 `NSWindow.backingScaleFactor`（`sk_window_live_scale`，与 `sk_window_device_scale` 同源、活查），
对内容视图 / 毛玻璃背板 / 帧宿主三块 layer 逐个 `setContentsScale:`（值不同才写）。
**必须每帧查**而不是「切屏时设一次」：没有可靠的跨屏回调可用（layer-hosting 已经把系统那条路切了），
而一帧一次 objc 取值的代价远小于一次全帧 memcpy —— 本函数本来就在拷整帧。

**回归钉子**：`unit: platform/PresentScale` 新增 3 条（同步调用在 `setContents:` **之前**；倍率是**活查**的
`sk_window_backing_scale` 且真的发了 `setContentsScale:`；三块 layer 一个不漏）。

---

### 6.8 drawable 必须允许被当作纹理采样（高级混合模式，阶段一百六十）

**症状**：TalkMED 桌面端（`talkmed-meeting`）AOT 版首页**大面积洋红**（`(255,0,255)` 及其被遮罩压暗后的
`(117,20,124)`）：工具栏下方整块背景、卡片之间的空隙全是洋红，而卡片、图标、文字本身正常；鼠标在窗口内
移动时**每帧都出现**。窗口未激活时同样出现（只是被合成的暗化叠加压暗）。`adl` 完全没有这个现象。

**根因**：AS3 的 `DisplayObject.blendMode` 会变成 Skia 的 paint 混合模式（`skia_glue.cc` 的
`sk_paint_set_blend`；由生成的 `as_skia_canvas_save_layer_paint(canvas, bp)` 施加，见 `emit.ts`）。
其中 **`add`（`kPlus`）与 `layer`（`kSrcOver`）以外**的模式 —— `darken`/`multiply`/`screen`/`lighten`/
`difference`/`overlay`/`hardlight` —— 都是 Skia 的**高级混合模式（advanced blend mode）**：固定功能混合
表达不了，Ganesh 必须**把目标当作纹理读回来**在着色器里混合。Metal 后端的目标就是我们 wrap 的那张
**CAMetalLayer drawable**，而 `CAMetalLayer` 的 drawable **默认 `framebufferOnly = YES`** —— 这是一种
「只写」存储模式，**禁止被当作着色器输入采样**；强行采样时 Apple GPU 返回的是**未初始化显存**。
TalkMED 首页皮肤里带一个 `BlendMode.DARKEN`（SWC `PlaceObject3` 的 BlendMode 标签烘进来的 ⇒ 运行时的
`SkBlendMode::kDarken`），该层的裁剪域覆盖整个画布，于是它把「读回来」的垃圾（洋红）以 SrcOver 语义**铺满整个窗口**，其后再绘制的内容
（卡片、图标、对话框）自然盖在上面 —— 正是现象的 L 形/碎块外形。

**修法**：`l.framebufferOnly = NO;`（`metal_glue.mm` 的 `sk_mtl_init`，紧挨 `pixelFormat`/`colorspace`）。
代价只是 drawable 的分配略慢（不是逐帧代价），换来「这个渲染目标可以被当作纹理读」这一正确声明 ——
这正是所有「读目标」渲染通道的文档要求。

**为何必须钉死**：它不是「多余配置」——删掉它不会编译失败、也不会让任何单测变红，只会让**任何**用到
`darken`/`multiply`/`screen`/`overlay` 等 7 个模式的应用整屏洋红（`add`/`layer` 因为不需要读目标而幸免，
这也解释了为什么此前历次验收都没发现：Starling demo 与各 `examples/` 从未用过这些模式）。

**实测**（`temp/tkmeet-mac/`，diff D26）：

| 步骤 | 结果 |
|---|---|
| 首页截图（产品二进制，修前） | 背景 `(117,20,124)`（被暗化遮罩压暗的洋红）；逐帧稳定复现 |
| 只把 `framebufferOnly = NO` 加上（不碰任何绘制代码） | 同一次启动态、同一张对话框遮罩下，该像素变 `(128,128,128)`（压暗后的白） |
| 严格判据（`min(r,b)>70 && 2g<min(r,b)`）全窗口扫描（**排除应用自带的 FPS/MEM/MAX 浮层**——它的 `MAX:` 本来就是粉字，设备像素 x 296..404 / y 70..150） | 修前逐帧命中；修后 **0 px** |
| 15 点悬停扫掠（激活窗口 → 逐点移动光标 → `screencapture -l`） | 修后 **0/15 帧含洋红** |
| 定位手法 | 先按 `saveLayer` 的 paint **混合模式**二分：把高级混合层的 `saveLayer` 退化成 `save`（`ASC_DEBUG_NO_BM_LAYER`）后洋红消失、普通 `kSrcOver` 层（颜色矩阵/滤镜）保留 ⇒ 只有「需要读目标」的层是触发点；再由旧有的 `ASC_MTL_READBACK` 读回 drawable 证实洋红就在 drawable 里（不是窗口服务器合成出来的） |

**回归钉子**：`test/unit/platform.ts` 的 `unit: platform/DrawableReadable`。**Windows 侧是否有同源缺陷
未验证**（本机无 Windows；D3D12 的翻转模型交换链缓冲如何被 Skia 读回未实测），登记见 `TODO.md`。

### 6.9 本地补丁：CoreText 会在「同族同 PS 名」的两个字体文件之间换脸（阶段一百六十七）

> **一句话**：`vendor/skia/lib/macos-arm64/libskia.a` **不是**上游预编译产物，而是从
> `build-tools/skia-src`（完整 m124 源码树）自编、并带回
> `vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` 的产物。换机器/换 CI 复现时
> 必须先打这个补丁，否则「微软雅黑」之类的同族双字体上会静默换脸（见下）。补丁清单与重编步骤见
> `vendor/skia/patches/README.md`。

**现象**（TalkMED 首页「创建同传」）：同一份源码 `adl 51.4.1` 画 `创建同传`，我们画 `初开名伤`；
**ASCII/Latin 完全正常，其它 CJK 字族（PingFang SC、华文细黑）也完全正常**——只有字族 `微软雅黑`
（且只有该机安装的那一对文件）中招。

**根因**（逐层排除后的结论，证据见 `temp/tfswc/` 的 `ctprobe*.mm` / `skgl.mm` / `skdata.mm`）：

1. 本机 `~/Library/Fonts/` 同时有 `微软雅黑.ttf`（Regular）与 `微软雅黑粗体.ttf`（Bold），
   **两个文件都声明** family `Microsoft YaHei`/`微软雅黑`、PS 名 `MicrosoftYaHei`，字形数都是 29126
   ——但**字形序在 index 110 处分叉**（`sfthyphen` vs `uni00AD`），于是 Regular 的
   `创=1259 / 建=1679 / 同=1379 / 传=1134` 在 Bold 里整体**下移一位**成 `1258/1678/1378/1133`；
   而 ASCII 的 gid 两边完全一致（space=3、`A`=39、`C`=41、`a`=71）。
   ⇒ 这就是「**CJK 全糊、拉丁毫发无损**」的由来：拿错脸之后，每个 CJK gid 都画成了**下一个字**。
2. 取形（shaping）与 cmap 并没错：`SkTypeface::textToGlyphs`、HarfBuzz（无论吃文件字节还是吃
   CoreText 表）、`SkShaper` 三方给出的 gid 都是正确的 `1259 1679 1379 1134`。
3. **错在光栅化**：`SkScalerContext_mac` 为每个尺寸重建 CTFont 时走
   `src/ports/SkScalerContext_mac_ct.cpp` 的 `SkCTFontCreateExactCopy(baseFont, size, opsz)`，
   而它用的是**只有属性、没有字体文件的** descriptor（`CTFontDescriptorCreateWithAttributes`）。
   **`CTFontCreateCopyWithAttributes` 一旦拿到非 NULL descriptor，CoreText 就按「字族」重新解析脸**
   ——两个文件同族同 PS 名时它挑了**另一个文件**（实测：`kCTFontURLAttribute` 变成 `微软雅黑粗体.ttf`，
   而 `descriptor == NULL` 的拷贝仍是 Regular）。补属性（`NSCTFontOpticalSizeAttribute`、
   `NSCTFontUnscaledTrackingAttribute`、甚至把 base 自己的属性合进去）**都不能钉住脸**。
4. 佐证：裸 Skia 探针里 `SkFont::getPath(1259)` 的宽度等于 **Bold 的脸**（`Bold 1259 = 0.23/14.80`），
   而直接从**文件字节**建脸（`SkFontMgr::makeFromData(微软雅黑.ttf)`）画得完全正确（`14.578`）
   ——数据支撑的脸不怕这次拷贝。

**修法**（约 20 行，`SkCTFontCreateExactCopy.cpp`）：拷贝后比较 `kCTFontURLAttribute`，
**若换了文件就丢掉 descriptor 重拷一次**（保留 base 的脸）：

```cpp
static bool sk_fonts_share_file(CTFontRef a, CTFontRef b) {          // 取不到 URL 视为「同一个」，不介入
    SkUniqueCFRef<CFTypeRef> ua(CTFontCopyAttribute(a, kCTFontURLAttribute));
    SkUniqueCFRef<CFTypeRef> ub(CTFontCopyAttribute(b, kCTFontURLAttribute));
    if (!ua || !ub) return true;
    return CFEqual(ua.get(), ub.get());
}
...
SkUniqueCFRef<CTFontRef> copy(CTFontCreateCopyWithAttributes(baseFont, textSize, nullptr, desc.get()));
if (copy && !sk_fonts_share_file(baseFont, copy.get()))
    return SkUniqueCFRef<CTFontRef>(CTFontCreateCopyWithAttributes(baseFont, textSize, nullptr, nullptr));
```

**为什么钉在 Skia 而不是胶水层**：同一份字体在多条路径上取脸——`SkParagraph` 的
`FontCollection::matchTypeface/findTypefaces`、间距度量（`sk_air_line_metrics`）、
旧的 `drawString` 路径。在胶水层拦（`sk_match_typeface` 里 `makeFromData`、或包一层 `SkFontMgr`）
要么盖不住 paragraph 的二次解析，要么要写上百行代理类；钉在 `SkScalerContext` 这一层，**一次修全**。

**修法边界**：

- 只对 **macOS/iOS**（`SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS`）生效，**wasm/Windows 库不受影响**；
- 只在「确实换了文件」时介入，同族同文件的字（Helvetica、PingFang SC 实测）行为**逐字节不变**；
- 代价：该字族丢掉 `tracking/opsz` 属性（有 `trak` 表的字才会感知），换来的是**脸不变**。

**验证口径**（本机，双端同源探针 `temp/tfswc/`：`BitmapData.draw()` + `getPixels()` 出裸 ARGB，
同一份 `Main.as` 分别用我们与 `adl` 跑）：

| 用例 | 字族 | 墨掩码 IoU（vs `adl`） |
|---|---|---|
| 纯 `TextField` 16px | 微软雅黑 | **100.00%**（修前是错字） |
| 纯 `TextField` 16px | Microsoft YaHei | **100.00%** |
| 纯 `TextField` 16px | 华文细黑 | **100.00%** |
| 纯 `TextField` 16px | PingFang SC | 97.24%（抗锯齿覆盖率差异，非错字） |
| SWC 皮肤文本（`aisubtitlehomeskin…label1`） | 微软雅黑 | 字形正确（`创建同传`）；像素差来自该子件的 dump 原点口径 |

**回归钉子**：`test/unit/build.ts` 的 `unit: build/SkiaLocalPatch`（守**出处**：补丁文件存在、
两半修法齐全、落在 `SkCTFontCreateExactCopy.cpp`、且被本文档引用——二进制内部无法断言，故只钉
「补丁没被悄悄弄丢」）。**该缺陷的复现依赖本机装了那一对同族同 PS 名的字体**（CI 机器没有），
故不设 examples 断言，实测记录留在 `temp/tfswc/`。

---

### 6.10 帧边界必须复位画布状态（阶段一百八十二 → 一百八十五，一个真应用的「画面变大」）

窗口合成用的画布**跨帧存活**（GPU 路径下是每个后缓冲一份、被反复复用的 `SkCanvas`），而
`ASC_window_render` 的写法是 `save()` → `scale(w->scale)` → … → `restore()`。**AS3 抛异常时，
longjmp 会穿过渲染器跳过这些 C 层的 `restore`**，于是「一次 save + 一次设备缩放」就留在画布上；
下一帧在已缩放的画布上再乘一次，**逐帧累积**。这不是理论担忧，是在真应用上量出来的：

| 帧首读数（`getSaveCount()` / `getTotalMatrix()`） | 基矩阵缩放 | 内容实际缩放 |
|---|---|---|
| 干净态 | `depth=1` / 1.0 | 1.5（仅设备缩放，正确）|
| 启动抛过异常后 | `depth=2` / 1.5 | 2.25 |
| 再抛一次后 | `depth=3` / 2.25 | **3.375 = 1.5³** |

像素口径（`Fps` HUD 正好画 70×100 DIP，可当尺子）：正常 105×150 px，故障 236×337 px（≈2.25×）；
故障时**整个窗口**（HUD、SWC 皮肤、登录页）一起变大——这与「显示列表某一层被缩放」完全不同，
所以排查时先把显示列表排除：`scaleX/scaleY` 与 `transform.matrix` 全是 1（`self`/`LoginView`/
`stageView`/`Stage`/`skin` 逐层 dump），`w->scale` 恒 1.5，逐对象进入/退出 CTM 比对 **0 次失配**。
三者同时成立还看到放大，就说明**放大发生在画布状态本身**。

修法：`sk_canvas_reset()` = `restoreToCount(1)` + `resetMatrix()`，插在 `ASC_window_render` 的
`ASC_window_apply_stage_size` 之后、**本帧自己的 `save()` 与设备缩放之前**。顺序是全部要点——
放在缩放之后会把设备缩放一起丢掉。帧内 save/restore 本来是配平的，所以干净帧上它是一次 no-op；
它保证的是「**任何一帧都不被上一帧的残留污染**」。异常本身仍只毁掉它出现的那一帧（与 AIR 一致：
未捕获异常中止该帧余下的工作），下一帧即恢复。修复落在**发射代码**里，因此**与后端无关**
（Metal / GL / D3D12 / raster 走同一处；没有画布 API 的构建里包一层 no-op 桩）。
源级钉子：`unit: render/FrameCanvasHygiene`。

> 排查方法的教训：**凡是「内容整体按同一倍数变大」的故障，先怀疑画布/表面状态而不是显示列表**；
> 而验证「有没有泄漏」不能只看进入/退出的净差（那对本帧内的 save 不配对天然免疫），要看
> **帧边界的 `getSaveCount()` 与基矩阵**。

### 6.11 每个对象自己开的图层必须自己关（阶段二百一十四，一个「卡片往下跳」）

§6.10 的帧边界复位只保证**跨帧**不串味；**帧内**的 save/restore 必须由每段代码自己配平。
`as_render_object` 里给 `alpha < 1` 的对象开了一层 `saveLayerAlpha`，却漏了配对的 restore：

```c
as_skia_canvas_save(canvas);                       // 对象自己的 save
if (o->alpha < 1.0) as_skia_canvas_save_layer_alpha(canvas, o->alpha);  // ← 曾经没有配对 restore
as_skia_canvas_translate(canvas, o->x, o->y);      // 在这之后施加的位移
...
if (scroll_on) as_skia_canvas_restore(canvas);
if (ct_on)     as_skia_canvas_restore(canvas);
if (blend_on)  as_skia_canvas_restore(canvas);
as_skia_canvas_restore(canvas);                    // 只够关掉「对象自己的 save」
```

栈差一格并不报错，但它会**逐层顶替**：子件漏掉的那次 restore 被父对象的那次 restore 吃掉，
于是父对象自己的 save（以及它 save 之后施加的 `translate/rotate/scale` 与图层 alpha）**继续
留在画布上**，这一帧之后画的**所有**东西都带着那个父对象的位移。真应用里的链条很短：列表行
（`AiSubtitleRenderers`）在 `MOUSE_DOWN` 时把 `skin.bg.alpha` 置为 0.5；一拖动列表，滚动条就把
`viewContainer.mouseChildren = false`，行的 `MOUSE_UP` 再也收不到 ⇒ 那个 0.5 一直留着 ⇒ 该行之后
的同级（depth 更大的「创建同传」大卡片）全被平移到该行的 y（往下跳一大截），直到列表重建才恢复
——用户报的「只要拖动过下面的列表，点刷新上面的卡片会跳下来再恢复」。

修法：条件开图层就**记住条件**，在 blend/ct/scrollRect 之后、对象自己的 restore 之前补一次
`if (alpha_on) as_skia_canvas_restore(canvas);`（restore 顺序必须是 save 的逆序）。发射侧改动，
与后端无关；`save_layer_paint`/`save_layer_paint_bounds`/`scrollRect` 的配对位置已逐处复核。
源级钉子：`unit: render/AlphaLayerBalance`（顺带钉住「渲染器里 push 与 pop 数量相等」）；
像素钉子：`examples/alpha-sibling.as`（半透明子件之后的同级必须留在自己的位置，且第二遍 `draw`
逐像素相同）。

### 6.12 烘焙面必须落在**落点画布**的设备像素栅格上（阶段二百七十四，一次「悬停抖动」）

自动烘焙（`ASC_AUTO_BAKE_FRAMES` 帧指纹不变就把子树烘到一张 `SkImage`）本身是**优化**，
它的承诺是「烘焙态 == 活态，逐像素」。这条承诺在 150% DPI 的真应用里长期只做到一半，用户
看到的是「**部分 UI 刷新时明显抖动**」——最容易复现的是底部按钮切换 hover：指纹一变就丢
烘焙、跑 3 帧活态、再烘回来，于是那 3 帧和它前后各是一次 ±1 设备像素的整块平移。

根因是**烘焙原点的吸附口径**。贴回是一张整幅 `drawImageRect`（最近邻），落在分数设备位置
的位图会被整体舍入到整数像素，而位图**内部**的内容是按未舍入的原点光栅化的 ⇒ 烘焙态与活态
整幅错 1 像素。阶段一百九十一的修法把原点吸到**局部坐标**栅格（`floor(bl*tx)/tx`），它只回答
「一个逻辑单位是几个设备像素」，不回答「局部 0 落在哪个设备像素」：落点位置是
`tx*原点 + otx`（`otx` 是画布自己的设备平移），只有 `otx` 是整数时局部吸附才等价于设备吸附。
顶层恰好成立，而**嵌在另一个烘焙面里、或父级在分数位置**时 `otx` 普遍是小数（150% DPI 下
多半是 .5/.25/.75），误差还逐层累加。实测（`temp/jitter/probe.as`，600x450 物理、scale 1.5、
卡片在 20.5/30.5）：修前烘焙态与活态差 **4423 px（1.638%）**，最佳整数位移 (0,1)、残差 0；
卡片边框、标题、行条整体挪一行。真应用侧同样可测：`ASC_BAKE_TRACE` 记 315 个被烘对象，其中
**47 个的落点平移是小数、41 个在 ~.5**（如 `oty=277.5`/`1111.5`/`1507.5`），这些正是每次
重烘焙都会跳一下的那些块。

修法两条，都在发射侧（`as_render_cached`）：

1. **在设备空间吸附**：`bxo = (floor(bl*tx + otx) - otx)/tx`（`byo` 同理），读的是画布的
   `total_scale` **与** `total_translate`（新增胶水 `sk_canvas_total_translate`）。落点于是
   恒为整数，贴回是 1:1 复制，没有可舍入的余数；内容相位由「贴回 bxo」与「烘焙内部 translate
   -bxo」自动相消，所以「烘焙 == 活态」是逐像素成立，与对象停在哪儿、被谁包着都无关。
   实测 4423 → **17 px（0.006%）**，`on-live vs on-baked` 直接 IDENTICAL。
2. **烘焙面覆盖描边**：`as_render_bounds` 的 Shape/自身-graphics 分支此前用纯路径包围盒
   （`as_graphics_bound`），而描边是**沿路径居中**的，一半在路径外 ⇒ 面按路径尺寸开就会切掉
   半个描边（1.5 设备栅格下 0.5 局部单位 = 0.75 设备像素），烘焙态边框比活态细。新增
   `as_paint_bound`（`_max_sw/2` 外扩，`_clip` 的 SWC 声明框保持原样）。注意这条**不是**
   那 17 px 的原因：把它单独改回原样，17 px 一个不少。

还有一条**缓存有效性**的配套：设备吸附把位图锚在**烘焙它的那块画布**的栅格上，换一块画布
（`BitmapData.draw` 会把源对象自身变换清零、第二个窗口、滤镜 pass）时 `otx` 的小数部分不同，
再贴回去就又错一个分数像素。所以缓存多存一对**相位** `_cache_phx/_cache_phy = frac(bl*tx+otx)`，
相位不符就**走活态**（不是重烘：那是一张「本帧必然不同」的图，重烘只会一直烧 CPU）。
这条是被 `examples/autobake-origin.as` 抓出来的：容器 x=20.4 在舞台上烘焙（相位 .9）后又被
`bd.draw` 到 160x80 位图（相位 .5），反走样圆多了 9 个像素（333 → 342）。

**已知残余（量过，没藏）**：1px 非反走样描边正好落在 .5 设备相位上时（= 150% DPI 下的
`lineStyle(1)`，1.5 设备像素宽），烘焙面里向外舍、活态里向内舍，即**一条 1px 边的一条边**
差 1 设备像素（`temp/jitter` 里 600x450 帧的 17 px，集中在 icon 顶边第 2 设备行 7 列）。
同一场景的填充、字形、行条、卡片边框逐像素相同；把描边改成 `lineStyle(2)`（3 设备像素，
不再卡在半像素）剩 **2 px**。这是半像素平局本身，不是放置或缩放口径错。

**2026-10-25 复测（阶段二百七十五 打开 Graphics 抗锯齿之后）**：`node cmpq.cjs off-live.png off-baked.png` 仍是 **17 px / 0.006%，bbox 56,67-72,67，worst=394，与 AA 之前逐值相同**。
（AA 改的是 `as_skia_paint_fill`/`as_skia_paint_stroke` 的 `setAntiAlias`，而这一行像素两侧
都是**整数覆盖**——live 全蓝、baked 全白，没有中间值可被 AA 变成部分覆盖。）⇒ 这条残余与
抗锯齿无关，归因不作改动。

验收：

- 真应用（`asaotui/ui-demo/air-gallery`，1500x1050）在**开烘焙**与 `ASC_NO_AUTO_BAKE=1` 两种
  跑法下 8 页 PNG **逐字节相同**（烘焙 == 活态）；
- `ASC_BAKE_TRACE` 复核 325 次重烘焙，原点 `bxo*1.5+otx` 全部是整数（最大偏差 1e-5，只来自
  `%.5f` 打印精度）；
- 源级钉子 `unit: render/BakeResolution`（13 项：设备吸附公式、相位键、描边包围盒、胶水三态）；
- 像素钉子 `examples/autobake-origin.as`（分数原点上的反走样容器，烘焙前后签名必须相同）。

### 6.13 Graphics 的填充与描边必须开抗锯齿（阶段二百七十五）

`SkPaint` 的抗锯齿**默认是关的**。运行时里凡是自建 `SkPaint` 的地方都显式 `setAntiAlias`
（位图填充、渐变、SWC 烘焙面），唯独 `as_skia_paint_fill` / `as_skia_paint_stroke` 两个
`beginFill` / `lineStyle` 用的构造器漏了——于是**所有矢量图形的斜边都成了阶梯，所有细斜描边
都比 AIR 细一截**。它不是布局或几何问题，所以逐点对照表上的偏差一直被当成「光栅化风格」看待。

发现方式：G26 的像素探针 `temp/g242526/Pix8.as`（同一条曲线，AIR 填充 293240、我们 296310）
在剖面里露了馅——AIR 的三角形斜边上带 **44 个部分覆盖像素**，我们是 **0 个**。

| 场景 | 关 AA | 开 AA | AIR |
|---|---|---|---|
| Pix8 `[MOVE,LINE,LINE]` 未闭合三角形（斜边） | 241230 | **246862** | 248226（−0.55%） |
| Pix6 平 API 圆角三角形填充 | 410805 | 410718 | 413264（−0.6%） |
| Pix6 曲线描边 `lineStyle(2)` | 43860 | 44215 | 47510（−6.9%） |

斜边那格从 **−2.8% 收到 −0.55%**，其余各格不动（说明原来的偏差里只有斜边那部分来自 AA）。
描边那 6.9% 的缺口**不是** AA：曲线的平顶处两侧都精确量到 **2.00 设备像素宽**，缺口全部
出现在陡峭段的逐列剖面上（Flash 的 AA 会把细斜描边略微「喂胖」），属光栅器风格差，已登记。

钉子：`unit: render/GfxAntialias`（两个构造器都必须 `sk_paint_set_antialias(p, 1)`，且胶水
确实暴露 `setAntiAlias`）。回归面：打开后 `node test.ts` 全量只剩 4 条基线红，
`asaotui/ui-demo/run-gallery.cjs` 8 页仍 PASS（PNG 字节数变大，符合「边缘多了部分覆盖」）。

### 6.14 对象 alpha 应折进画笔，而不是每个对象开一层（阶段三百一十五）

§6.11 修的是「开了图层要记得关」；这一节修的是**根本不该开**。`as_render_object` 原本对
`alpha < 1.0` 的对象一律 `saveLayerAlpha`，而 **AIR 没有对象级 alpha 图层**：它把 alpha 乘进
每一次绘制。差别在真实应用里是数量级：`ChatItemRenderers.as:53` 给每条聊天记录放了一个
`alpha = 0.1` 的 `Shape`（就一个 `drawRect`），于是**每条记录每帧付一次离屏 pass**。

实测（`output/perf/chat/`，192 行，进程 CPU/帧，同机配对）：同一形状只改 `alpha`，
带图层 **14.5 µs/项**，折叠后 **2.0 µs/项**；而 AIR 0.7。图层成本**与面积无关**（340×56 与
34×56 同价），也不看画的是什么（路径或图元同价）——这正是「per-layer 而非 per-fill」的判据。

规则（`as_single_primitive()`，`src/emit.ts`）：**子树只画一个图元**时折叠，否则仍开图层。
排除项各有实测理由：`filters` 本来就要隔离层；`_mask_object` 没有自己的像素；
`opaqueBackground` 会多画一块不透明底（第二个图元）；`TextField` 的字形 run 内部 AA 覆盖会重叠；
未知叶子（`Video` 等）按「会画 2 个」处理，因为它们的绘制入口还没接进折叠通道。

两个必须写下来的细节：

1. **乘的是画笔的拷贝**。`Graphics` 的填充/描边 `SkPaint` 是 AS3 对象里的**共享**对象，
   就地 `setAlphaf` 会让一个 `alpha=0.1` 的形状之后一直保持暗淡。胶水层因此只在栈上
   `SkPaint p = *(const SkPaint*)paint;` 之后改 `p`。
2. **必须量化到 8 位**。`setAlphaf(0.5)` 让 Skia 四舍五入到 **128**，而 AIR 的覆盖度是**截断**
   到 **127** —— 所有半透明填充会比 `adl` 亮一档。折叠前先算 `(int)(mul*255)/255` 再乘。
   这条是像素 oracle 抓出来的，肉眼与逐项 A/B 都看不见：`temp/alphafold/` 同一份 `.as`
   分别跑 `adl` 与 AOT，`BitmapData.draw` 整棵树后逐点取样，红块 `alpha=0.5` 修前
   `ff800000`、`adl` `ff7f0000`，`0.5×0.5` 嵌套修前 `0x40`、`adl` `0x3f`。

**顺带修的两条每帧实错**（同一阶段，都在 `as_render_fp`）：

- `getenv("ASC_NO_AUTO_BAKE")` / `getenv("ASC_BAKE_TRACE")` 写在**每对象每帧**的闸门里。
  `getenv` 是整个环境块的线性扫描（本机 ≈1.9 µs/次），192 项的夹具里就是 **2.60 → 0.996 ms/帧**，
  同一场景、同一批绘制、同一批烘烤决定，唯一差别是把它提到静态量。这条对**所有** AOT 应用生效。
- 自动烘焙对**单图元节点**是净亏：烘焙把 N 次绘制换成 1 次 blit，N == 1 时只多了「拍快照 + 贴回」
  与缓存路径自己的记账；GPU 画布上贴一张 CPU-raster 快照尤其贵。闸门改为要求
  `as_draw_count(o) > 1`，实测 `panel_bmp_192`（192 行 = Sprite 包一张 Bitmap）**2.92 → 0.93 ms/帧**。
  **显式 `cacheAsBitmap` 仍然照烘**——那是应用自己要的，不是我们的优化。

验收（同机配对，3 reps）：`panel_192` **4.54 → 1.331**、`panel_384` **8.50 → 1.736**、
`panel_shape_192` **3.33 → 1.184**、`panel_text_192` **3.99 → 1.271** ms/帧；斜率
`(panel_384 − panel_empty_192)/384` 从 **20.0 → 2.56 µs/项**（AIR 1.85），交叉点从 ≈46 项推到 >1100 项。
钉子：`unit: render/AlphaFold`（16 项）＋改写保留原意的 `unit: render/AlphaLayerBalance`；
像素 oracle：`temp/alphafold/`（adl 与 AOT 逐点对照，10 个采样点里 9 个逐位相同）。

**已知残余（量过，没藏）**：容器里 **≥2 个重叠图元**且 `alpha<1` 时，我们仍开图层隔离、AIR 逐图元
相乘，重叠处差一格（`ff7f7f00` vs `ff7f7f3f`）。要整体切到「逐图元乘 alpha」得先把
`draw_circle`、九宫格、文本、Stage3D 的绘制入口都接进折叠通道——漏一个就是整块不透明，
所以本轮只做「单图元」这一档，其余留给后续阶段（已入 `TODO.md` 遗留表）。


## 7. 多目标：native 与 wasm

- **native**：Skia 静态链接 `libskia.a`（CPU raster），产出 Mach-O/ELF/PE。
- **wasm（浏览器，`--target wasm --package web`）**：用 Emscripten 把 Skia + 胶水层一起编成
  wasm32 静态库（`vendor/skia/lib/wasm/`），经 emcc 链接产出 `.wasm` + `.js` + `index.html`。
  字体后端由 CoreText 切换为 `SkFontMgr_New_Custom_Data()`（运行时注入字体数据），窗口层由 SDL2
  切换为 canvas + `requestAnimationFrame`。实现与约束详见 [`html5-web.md`](html5-web.md)。
- **wasm（WASI，`--target wasm --package raw`）**：仍是无 GUI 的命令行 `.wasm`，不含渲染。

> 曾评估「用 WASI 工具链适配 Skia」的路径（Skia 官方 wasm 面向 emscripten/CanvasKit，WASI 适配
> 成本高）。现已改用 emscripten 直接产出浏览器产物，绕开 WASI 适配：`--package web` 已端到端验证
> 通过（蓝色矩形 + `TextField` 文字 + 运行时字体注入，无运行期崩溃）。

---

## 8. 文本渲染的两档方案

`TextField` 是 AS3 GUI 里最复杂的一环，Skia 提供两档：

1. **基础字形（`SkFont` + `SkTextBlob`）**：给定字体/字号/颜色，把一串 UTF-8 画到指定基线位置。
   **不支持自动换行、对齐、段落**。适合「单行文本 / 简单 label」的首期实现。
2. **完整排版（SkParagraph，`modules/skparagraph`）**：支持换行、左右对齐、字间距、多段落、富文本样式。
   对应 AS3 `TextField` 的 `wordWrap`/`multiline`/`textWidth`/`textHeight`/`autoSize`/`htmlText`。

**决策修正（阶段三十八 → v0.3.73 升级）**：阶段三十八最初用 **`SkFont` 测量 + 自研贪心换行**
（`runtime.ts` 的 `as_text_wrap`）跑通多行，理由是 SkParagraph 的 UAX#14 换行与 AIR `wordWrap` 语义漂移。
后于 v0.3.73 升级为 **SkParagraph（`modules/skparagraph`）完整排版**，理由：

- 自研贪心换行逐 word `SkFont` 测量、每帧重算无缓存，性能与正确性（行高近似 `size × 1.2`、无 shaping）
  都受限制；SkParagraph 由 HarfBuzz 一次 shaping + UAX#14 断行，`getHeight()`/`getLongestLine()` 提供真实
  行高与 textWidth，段落级对齐/字间距天然可用。
- 语义漂移收敛为两个边缘情况：SkParagraph 会在超长单词/连字符处断行，AIR `wordWrap` 仅空格断行、
  超长单词整词溢出；CJK 逐字断行两者一致。已在注释/文档记录为已知限制。
- **第三处漂移（阶段八十九·二十八发现，阶段八十九·六十六修复）——断行阈值少减 4px 内边距**：字号/字体一致时
  两者**逐词墨迹宽度完全相同**（Starling demo `TextFields` 场景第三字段实测：`... or centered. Embedded fonts`
  五个词的墨迹宽度 AOT/AIR 均为 25/32/154/178/81 px、词间距也一致），差异只在**断点本身**：Skia 侧 6 词行宽
  591 px（按字段 600 px 排版）故把 `are` 留在第一行，AIR 却在 5 词处换行。
  当时把它归因于「AIR 把**行尾空格**算进候选宽度」——**这个归因是错的**。阶段八十九·六十六做了受控扫描
  （`temp/tfwrap/`，同一组 TextField 只扫字段宽度，读 `numLines`，第一个 `numLines == 1` 的宽度即阈值）：

  | 文本 | AIR 阈值 | 修前 | 修后 |
  |---|---|---|---|
  | `"Multitouch"`（无空格） | 129 | 125 | **129** |
  | `"Multitouch "`（1 个尾空格） | 129 | 125 | **129** |
  | `"Multi touch"`（词间空格） | 138 | 134 | **138** |
  | `"Multitouch  "`（2 个尾空格） | 129 | 125 | **129** |
  | `"Multitouch Multitouch"` | 263 | 259 | **263** |
  | `"Multitouch  Multitouch"` | 271 | 267 | **271** |

  尾空格的有无/多少**完全不影响 AIR 的阈值**（三档 0/1/2 个尾空格都是 129），所以「行尾空格」不是原因。
  真因是**可用宽度要减掉 AIR 的 2px 内边距**：阈值恒为 `ceil(ink + 4)`——`124.945+4→129`、`133.383+4→138`、
  `258.328+4→263`、`266.766+4→271`，六项**逐值命中**。修前我们按未减内边距的字段宽度排版，故边界上晚一个词。
  这个 4px 不是新约定：`autoSize`（**仅当 `wordWrap=false`** 时 `width = textWidth + 4`；`wordWrap=true`
  时宽度不动、只改高度，见 §8.2）与 `maxScrollH`（`over = textWidth + 4 - width`）
  早已按它写，**只有断行阈值一处漏减**。修复见阶段八十九·六十六，`test.ts` 有 `[textwrap]` 结构钉子。
  > 另注：`textWidth` 对带尾空格的文本，AIR 含尾空格（`"Multitouch "` = 133）、我们不含（恒 124.945）。
  > 这是**另一个**独立的口径差异，**不影响断行**（见上表），已按 §1.5 记入 `TODO.md` 遗留表。
- AIR 的 `maxScrollV`/`scrollV` 是「视口行」语义（`numLines - visibleLines + 1`，`scrollV = maxScrollV`
  让最新行贴底），仍由运行时层计算；SkParagraph 只负责「排」与「画」，符合 §2.9 铁律。
- 同样**没有自研光栅化**：shaping/断行/绘制全部交给 SkParagraph，自研的只有「缓存失效 key」这一层。

SkParagraph 的富文本能力（`htmlText`、多 `TextFormat` 区间样式、对齐/字间距/多段落）均已落地：`htmlText`
解析 `<font>`/`<b>`/`<i>`/`<u>`/`<p>`/`<br>` 子集并生成「字节区间 + `TextFormat`」run 列表，`setTextFormat`
写的是**同一张 run 表但按「替换该区间」的语义**（阶段二百六十八，见 §8.5）；`sk_textlayout_new_runs` 按 run
顺序 `pushStyle`/`addText`/`pop`，run 之间的间隙回落到
段落默认样式（= `runs[0]` 的字体/字号，颜色取自 `defaultTextFormat`）。`autoSize`/`scrollH`+`maxScrollH`（AIR 没有 `hscroll` 开关，见 `flash-text.md` §11）/`selectable`/`leading`
亦已落地，断言式回归见 `examples/textrich.as`（`examples/textflow.as` 为布局基线）。

### 8.2 `autoSize` 的大小口径与「装不上的字族」的兜底脸（阶段一百六十八）

两条都在 `vendor/skia_text_glue.cc` / `src/emit.ts` 的文本层，判据来自 `adl 51.4.1` 双端同源探针
（`temp/tfswc` 的 case ⑥⑦⑧⑨⑩；修后 AOT 侧与 `adl` 的报告**逐字相同**）。

**① `autoSize != "none"` 时宽度只在 `wordWrap=false` 才跟文本走。** 实测：`wordWrap=true` 时
`width` 保持用户给的值（290 对短串与 3 行串都不变），只有 `height := textHeight + 4` 变；
`wordWrap=false` 时 `width := textWidth + 4` **两个方向**都收/放（290→28、「中文」；100→523.5、超长串）。
旧实现无条件用「已换行排版的最长行」+ 4 去写宽度，于是自己造出一个**自噬回路**：宽度一收 ⇒ 同一段
文本的可用宽正好等于文本宽 ⇒ 下次排版又断行、最长行更短 ⇒ 每绘制一次再收一圈
（实测 290 → 64.66 → 50.66 → 36.66 → 32），TalkMED AI 同传列表项的 `title` 因此被断成三行、压住 `ctime`。
另一个可观测点：`adl` 在**赋值后不画就能读到**新盒（`autoSize=LEFT` 后立刻 `h=18`），
所以生成 C 的 `as_do_extents`（`width`/`height` 两个读取都落在这里）也调 `as_tf_apply_autosize`。

**② 装不上的字族 = 平台默认脸的行盒，不是「哪个 CJK 脸供字形就用哪个的行盒」。** `adl` 对
`MiSans Regular`（本机没有；只在 app 包里，而 **AIR 不注册 app 自带字体**）与 `宋体` 量到的 16px 行盒
都是 **16px**，正是 Helvetica 的盒；而 `SkFontMgr::matchFamilyStyle` 对这两个名字返回 **NULL**，
SkParagraph 遂按供字形的 CJK 层取行盒（PingFang/Songti SC 1.4em → 16px 字号下 22px）。
`sk_family_alias` 因此先查该字族**是否装得上**，装不上就替换成 `matchFamilyStyle(nullptr)` 的族名
（macOS = Helvetica），并缓存；该替换同时影响 strut 与 run，保证行盒与字形落在同一条路径上。
> 这是**用户可见**的：列表项比 `adl` 高 6px，`ctime.y` 被推下去。注意它**不是**「该注册 app 字体」的
> 证据——`adl` 也看不见那个 `MiSans-Regular.ttf`，我们若注册反而与 oracle 分道扬镳。

回归：`examples/autosize-metrics.as`（行为断言，链 Skia）+ `unit: display/AutoSizeMetrics`
（生成 C / glue 结构钉，含反向 mutation 验证）。

### 8.3 字段被缩放时的度量与字形归一化（阶段一百六十九）

字段的 CTM 里带**非均匀** scale（SWC placement 常见，例如 TalkMED 字幕皮肤子件 `ctime` 是
`scaleX = 1.2246, scaleY = 1`）时，`adl` 的口径与我们修前**两处都不同**，判据来自 `adl 51.4.1`
双端同源探针（`temp/tfswc` case ⑯⑯b⑯c⑰b，size 12 名义 `166.00/12.00`）：

| (scaleX,scaleY) | adl textWidth | adl textHeight | adl 渲染 ink 宽 |
|---|---|---|---|
| (1.0000,1.0000) | 166.00 | 12.00 | 165.0pt |
| (2.0000,1.0000) | 83.00 | 6.00 | 165.0pt |
| (1.0000,2.0000) | 332.00 | 24.00 | 329.5pt |
| (2.0000,2.0000) | 166.00 | 12.00 | 329.5pt |
| (0.5000,1.0000) | 332.00 | 24.00 | 165.0pt |
| (1.0000,0.5000) | 83.00 | 6.00 | 82.5pt |
| 父容器 scaleX=2 | 83.00 | 6.00 | — |

**① 度量：`textWidth`/`textHeight` = 名义 × scaleY/scaleX，两个方向都除 `scaleX`。** 不是「宽度除
scaleX、高度除 scaleY」——`scaleY=2` 时高度也**翻倍**（`24.00`），而它并没有被 scaleX 除。scale 取的是
**自己 + 全部祖先的累积值**（父容器 scaleX=2 ⇒ 子字段的值减半）。生成 C 里由 `as_disp_chain_scale`
沿 `parent` 链累乘线性部分（顺序同为 `T·R·S·transform.matrix`，与 `as_bounds_xform`/`as_render_object`
一致；平移不改基向量长度故不影响）得到 `(sx, sy)`，`as_tf_scale_ratio` 返回 `sy/sx`。

**② 渲染：字形只按累积 `scaleY` **整体**缩放，`scaleX` 不拉宽字形（也不拉宽字距）。** 所以同一个字段
在 `scaleX=2` 下的 ink 宽与 `scaleX=1` **逐像素同宽**（165.0pt），而它的**盒子**照旧按 scaleX 变宽
（`width` = 本地宽 × scaleX）。实现是在 TextField 绘制的字形 pass 里把 CTM 后乘 `scale(sy/sx, 1)`：
非均匀 CTM `M = R(θ)·S(sx,sy)·…` 后乘 `S(sy/sx,1)` 恰好得到 `R(θ)·S(sy,sy)·…`，即「同一旋转、均匀
scaleY」。**必须夹在 `clipRect` 之后**：Skia 的 `clipRect` 按调用时的 CTM 映射，而可见盒是**要**跟着
scaleX 走的（阶段一百六十二的 D29 就是栽在这个映射上）。

**比值必须取「画布的实际缩放」`as_skia_canvas_total_scale(canvas)`，不能取 `ASC_bake_ctm_*`
（烘焙落点 CTM —— 那是 1px 边框与插入光标的口径）。** 理由：烘焙时的 canvas 就是离屏表面，它的
逐轴分辨率**本身就是落点缩放**，而落点缩放里**已经含字段自身的 `scaleX`**，拿它当除数等于把这条
归一化要消除的拉伸原样留下。实测（阶段二百九十一，TalkMED 登录页两个页签：SWC placement
`scaleX = 0.9594`、dpr 1.5 ⇒ canvas `1.439072 × 1.5`，`ASC_TF_TRACE` 逐 pass 打印）：

| 渲染态 | canvas | `ASC_bake_ctm_*` | 旧比值 | 旧字形 x 缩放 | ink 宽 |
|---|---|---|---|---|---|
| live（无烘焙） | 1.439072×1.5 | 0（退回 canvas） | 1.0423 | 1.5 ✓ | 124 |
| 字段自己的 bake | 1.439072×1.5 | 1.439072×1.5 | **1.0** | **1.439072（窄 4%）** | 119 |
| 嵌套 bake（祖先已烘） | 1.439072×1.5 | 1.5×1.5 | **0.96** | **1.3815（窄 8%）** | — |

于是「烘焙态」与「活态」差 4%，而**每次切换输入焦点**都会掉掉祖先烘焙一帧（输入框的 `_sel_*` 进
`as_render_fp` 指纹）⇒ 那一帧回到正确宽度，两个页签右跳 3-4 px 再回来（用户报的「抖动」）。
改成画布缩放后两遍渲染是**同一个数**（烘焙被封顶时两轴同乘 `f`，比值不变），121 帧逐帧同一签名。

- 正常窗口 pass / `cacheAsBitmap`/过滤器烘焙 / 嵌套烘焙：画布缩放在三处同值 ⇒ live 与 bake 一致；
- `BitmapData.draw(字段)`：这一路是**本地空间**重栅格，且 `adl` 实测 `draw()` **忽略被画对象自身的
transform**（scaleY=2 的字段画出来与未缩放**逐字节相同**）⇒ canvas 均匀、比值 1，正是该路要的。

**两个轴各管一件事**：可见盒（含 `clipRect`）跟着 `scaleX`，字形只跟 `scaleY`；1px 边框与光标仍取
`ASC_bake_ctm_*`，因为它们要的是「落到**目标**画布的 1 个设备像素」，被放大的是落点而不是表面。

回归：`examples/tf-scale-metrics.as`（度量 6 组相对断言 + `draw(容器)` 的 ink 宽 3 组 +
**父容器 `cacheAsBitmap`、缩放挂在字段自身的烘焙 4 组**，链 Skia；后者对着旧代码必红：
`want 168.00 got 336.00`）+`unit: display/TfScaleMetrics`（10 钉，含反向 mutation，其中一条是
`!emitted.includes('double tsx = ASC_bake_ctm_x')`）。

### 8.4 Windows 的逐字符字体回退：GDI 主语 + DirectWrite 兜底（阶段一百九十一）

**GDI 的字体管理器根本没有逐字符回退**——`SkFontMgrGDI::onMatchFamilyStyleCharacter` 是无条件
`return nullptr`（`build-tools/skia-src/src/ports/SkFontHost_win.cpp` ~2267），Windows 也没有 macOS
CoreText 那样的系统级级联。而 SkParagraph 对**每一个**本 run 字脸不映射的码点都要向管理器要一张回退脸：
于是当字段的字族是 GDI 家族表里**匹配不上**的名字时，解析出的脸是拉丁默认脸，**整个字段**都画成
`.notdef`——一片相同的方框，不是零星几个。

实测（`temp/fntface/`，8 行 TextField，size 18，文本 `创建会议 abc 0123`，`Stage.render` 出图 + trace）：

| 字族 | 修前 textWidth/Height | 修后 | 修前像素 |
|---|---|---|---|
| `微软雅黑` | 153/16 | 153/16 | **4 个 `.notdef`** |
| `MiSans Regular` | 153.532/18 | 153.532/18 | 正常（app 自己注册了 MiSans） |
| `Microsoft YaHei` | 157/20 | 157/20 | 正常 |
| `SimSun` | 153/18 | 153/18 | 正常 |
| `Arial` | 135/17 | 151/17 | 正常 |
| `NoSuchFamilyXYZ` | 153/16 | 153/16 | **4 个 `.notdef`** |
| `""` | 127/16 | 143/16 | **4 个 `.notdef`** |

关键在「**同名不同文**」：本机 `Get-WinSystemLocale = zh-CN` 但 **UI 语言是 en-US**，GDI+ 枚举出的
874 个字族**只有英文名**——有 `Microsoft YaHei`，**没有 `微软雅黑`**。而 SWC 里的 tag-37 文本字符
（`createaisubtitleskin.title` / `stime` / `sourcetxt` / `targettxt` / `typetxt` 等）声明的字族正是
`微软雅黑`。用户看到的乱码就是它：AI 同传窗口卡片首行的「创建同传」被画成 4 个 `.notdef`；
修后同一个窗口同一位置正常显示「创建同传」（其余字段用 MiSans/其它族，本来就不乱）。

**修法：`vendor/skia_glue.cc` 的 Windows 分支改成 `SkAirFontMgr : public SkFontMgr`（阶段二百二十一 起该字体管理器属**图形半边**，理由见 §3.1），GDI 作
`fPrimary`、DirectWrite 作 `fFallback`；`onMatchFamilyStyleCharacter` 无条件过桥**（GDI 这一路对每个码点
都答 `nullptr`），**族名查询只在 GDI 匹配不上时才过桥，且只当「本地化名 → 英文名」的翻译器**（见
§8.4.1）。`countFamilies` / `getFamilyName` / `createStyleSet` / `makeFromData` /
`makeFromStream{Index,Args}` / `makeFromFile` / `legacyMakeTypeface` 这 8 个查询逐字转给 GDI——
所以**今天能解析的字族换脸为零**（上表 `MiSans Regular` / `Microsoft YaHei` / `SimSun` 三行修前修后
逐字相同）；DirectWrite 侧走它自己的 `IDWriteFontFallback::MapCharacters` 级联（DirectWrite 系浏览器
用的同一条），只在「字脸缺码点」这一条查询上回答。`Arial` 与空字族的宽度修后变大，正是过去画不出
的 CJK 现在画出来了。

**为什么不是整体换 DirectWrite、也不是 `SkOrderedFontMgr`：** 有序管理器会把**结构化**（族/样式）查询
也交给 DirectWrite，而一张 DirectWrite 脸走到 SkParagraph 的结构化路径时，我们那套 AIR strut / 高度
覆盖机制就失效——实测该行 `textHeight = -Infinity`、**整行不画**。GDI 作主语同时保证了「已能解析的
字族逐字节不变」。

**无新增链接依赖**：Skia 通过 `LoadLibraryW("dwrite.dll")` + `GetProcAddress("DWriteCreateFactory")`
访问 DirectWrite（`build-tools/skia-src/src/utils/win/SkDWrite.cpp`），所以任何 `.build.json` 都**不需要**
加 `dwrite`，构建清单未改。该分支在 `#if defined(_WIN32)` 内，macOS/wasm 不受影响；Windows 侧的这次
改动**不在 CI 覆盖内**（CI 是 macOS），本机像素 A/B 是唯一验证。

回归：`unit: platform/FontFallback`（16 钉：字符查询单点无条件过桥 / 名字查询先用 GDI、只在 GDI 全失手后
才取 DirectWrite 脸 / 两个名字查询都走翻译器 / `<族> <样式词>` 基名重拼 / 未安装族 → Times（macOS 仍问
CoreText）/ 8 处原样委托 / 工厂与降级 / macOS 分支未动 / 反向排除 `SkOrderedFontMgr` / 两处文档镜像）。

#### 8.4.1 本地化族名：DirectWrite 只当名字翻译器（阶段二百一十二）

上节的过桥只解决了「码点回退」，度量仍是错的，而且错得更显眼：`微软雅黑` 依然解析不到脸，于是落到 GDI
的**默认脸**——Windows/GDI 的默认脸是**等宽**的。实测（adl 51.4.1 + `temp/fontprobe`，size 12，
10×`W` / 10×`i` / 10×`m` 的前进宽）：

| 字族 | adl | 修前 | 修后 |
|---|---|---|---|
| `微软雅黑` | 120/30/110 | 80/80/80（等宽） | 120/30/110 |
| `微软雅黑 Light` | 120/30/110 | 80/80/80 | 120/30/110 |
| `Microsoft YaHei`（含 Light） | 120/30/110 | 120/30/110 | 120/30/110 |
| 未安装族 `NoSuchFaceXYZ` | 110/30/90 | 80/80/80 | 110/30/90 |

两处根因：

1. **GDI 的家族表按英文名匹配、只把本地化名报回来**，所以 `微软雅黑` 在 en-US UI 语言下永远匹配不上。
   DirectWrite 的 `IDWriteFontCollection::FindFamilyName` **能**匹配本地化名，但它的度量未 hint：同一台
   机上 DirectWrite 的 `Microsoft YaHei` 是 `122.109/31.934/112.441`，而 GDI（= AIR）是 `120/30/110`。
   所以 DirectWrite **只当名字翻译器**：在它那儿解析出字脸、读出英文族名（Skia 返回字体 name 表第 0
   条，系统字体即 en-US），**再拿英文名回去问 GDI**——度量因此始终是 GDI 的。
2. `微软雅黑 Light` 需要多一步：本机 Windows **没有**这个 DirectWrite 家族（Light 脸注册在
   `Microsoft YaHei` 家族**内**），它是 GDI 侧的独立家族 `Microsoft YaHei Light`。所以先翻译基名、再把
   样式词拼回去问 GDI（基名作最后一试）。AIR 对 Light 与 Regular 报同一组度量，所以「退到基名」观测
   等价，先试带样式词只是因为它正是皮肤点名的字脸。

顺带把**未安装族**的落点写死：AIR 在 Windows 上的默认脸是 Times 档（`110/30/90`，正好等于空字族那行）。
过去我们什么都不问就交给平台默认脸——Windows 上那是等宽脸（`80/80/80`），于是「皮肤写了一个本机没装的
族」整块变成打字机。现在 `sk_family_alias` 的 `_WIN32` 分支把未安装族解析成 Times；macOS 仍取 CoreText
的默认脸（那里平台默认**就是** AIR 的默认，见 `temp/tfswc` case 6/9）。

**`onMatchFamily` 也必须翻译**：SkParagraph 解析 `TextStyle` 的族名走的是
`FontCollection::matchTypeface`（先 `matchFamily` 拿 styleset、再 `matchStyle`），**不是**
`matchFamilyStyle`。只改后者的结果是段落根本不用这个族、直接以默认脸排版——第一次修就是这么翻车的：
`微软雅黑` 量出 DirectWrite 的 `122.109`，`微软雅黑 Light` 量出 `60/60/60`。

回归：上面的 16 钉已含本节四项（字族名的翻译与回问 GDI 的**顺序**、`<族> <样式词>` 基名重拼、
未安装族 → Times、macOS 仍问 CoreText）。像素级验证：`temp/fontprobe` 10 行与 adl 逐格相同。

### 8.5 `setTextFormat` 是「替换该区间」，不是「再叠一条 run」（阶段二百六十八）

AIR 文档（ActionScript 3.0 语言参考，`TextField.setTextFormat`）的语义是**设置该范围内的格式**：同一区间
施加两次 == 施加一次，把全区间格式施加在已存在的子区间格式上会**覆盖**它。我们此前每次都往 `_runs` 后面
**追加**一条三元组（`begin`/`end`/`TextFormat`），而 `sk_textlayout_new_runs` 的循环是「按 run 顺序把
`text[start..end)` 各拷一遍」——于是同一段字符被排了 N 遍：一个在重绘路径里重设格式的字段，宽度随重绘次数
**线性增长**（应用侧看到的就是「输入过的字被复制了一遍」，`asaotui/probes/widgets/typing` 变异 M3 抓到）。

修法（`src/emit.ts` 的 `TextField_setTextFormat`）：重建整张 run 表——完全落在新区间之前的 run 原样保留、
横跨边界的 run **切成两半**、被覆盖的部分丢弃，新 run 插在「第一条触及 `begin` 的 run」的位置（这样表始终
按 `start` 有序；排版循环的 `pos` 游标只会前进，乱序会让同一段文字被再排一次）；空区间与 `format == null`
为 no-op。新表整体换上去并盖 `gc_write_barrier`，段落缓存照旧失效。

判据：`adl 51.4.1` 与我们的**关系式**双端对照（`asaotui/probes/g20-settextformat/`，12 格：不比绝对值，
因为两端文本引擎不同；同一格式对 `1111` 施加 1/2/3 次，AIR 量到 52/52/52 px，修前我们是 46.66/91.53/136.41）。
回归：`examples/settextformat-runs.as`（12 条断言，含「反复 `BitmapData.draw` 宽度不变」与「窄区间切开长 run」）、
`unit: text/settextformat`（15 条源级钉子，含「插入点在两半之间」这条有序性钉子）。

> **相邻偏差已修（阶段二百七十）**：`TextField.getTextFormat()` 曾经恒返回 `defaultTextFormat`、不读 run 表
> （AIR 返回该区间**生效的**格式）。现在按 adl 51.4.1 实测的 30 格口径实现：区间内格式一致则回答该格式（**副本**），
> 跨 run 边界 / 反序 / 空区间回答**全 `null` 的空 TextFormat**，`(0,0)` / 空文本 / 越界抛 `RangeError #2006`，
> 端点 `-1` 表示「未提供」。结构前提是 `TextFormat` 的 `Object` 字段改为装箱（否则「未设置」无法表达）。
> 于是同一探针的 case 10/11 从**已登记偏差**转为正式断言，`expect.json` 的 `known` 豁免已删除。
> 回归：`asaotui/probes/g21-gettextformat/`（30 格双 runtime，0 分歧；`mutation.cjs` 5/5）、
> `examples/gettextformat.as`（11 组断言）、`unit: text/getTextFormat`（31 条）。

### 8.1 `flash.text.StyleSheet` 与 HTML 的**块级**模型（阶段一百四十八）



`StyleSheet` 在阶段一百四十八从「只报不做的空壳」升级为**真类**（`superClass: EventDispatcher`、
反射名 `flash.text::StyleSheet`），`setStyle`/`getStyle`/`clear`/`styleNames` 全部落地，并成为
`htmlText` 排版的**规则来源**。促成这次开工的是 talkmed-meeting 的 FPS 浮层（`com.vsdevelop.controls.Fps.as`）：
它给一个 `multiline` 保持默认 `false` 的 `TextField` 赋 `htmlText` 与 `styleSheet`，在 AIR 里显示**四行**
（FPS / MS / MEM / MAX），我们却把四个值挤成一行。

**根因是块级判定，不是 `<br>`。** 用 `adl 51.4.1` 逐项实测（证据台 `temp/ssprobe/`、`temp/blockprobe/`、
`temp/mlprobe/`、`temp/fpsprobe2/`）得到 AIR 的模型，逐条实现：

| 观测 | AIR 行为 |
|---|---|
| 无规则的未知标签（`<x>`、`<fps>`、`<memmax>`…） | **内联**（当作无样式文本，不出现在 `text` 里） |
| **有规则**的未知标签 | **块级**：断行发生在**其闭合标签之后**（break-after），且**与 `multiline` 无关** |
| AIR 有内联渲染的标签（`span`/`p`/`b`/`i`/`u`/`font`/`a`/`li`/`br`/`img`/`textformat`） | **永不**成块——即使规则里写 `display:block` 也无事 |
| `display:inline` | 把未知标签**降级**回内联 |
| `display:none` | 元素（含其文本）**隐藏** |
| `<br>`、`</p>` | 只在 `multiline == true` 时断行 |
| 选择器 | **大小写不敏感**匹配；`styleNames` 报出的是**小写化**后的名字 |
| `setStyle` / `getStyle` | 双方都**拷贝**：改传进去的对象不影响规则表，改 `getStyle` 的返回也不影响；`setStyle(name, null)` 是**删除** |

实现要点：

- 标签名先**小写化**再查规则（`as_ss_lookup`，键为小写）；`as_str_ieq` 做**零分配**的 ASCII
  大小写不敏感比较，避免每标签都 `toLower` 分配。
- 状态**入栈**（`st_face/st_size/st_color/st_bold/st_italic/st_under/st_block`，深 32），闭合标签恢复上层，
  与 AIR 的「样式有作用域」一致。
- 断行「在闭合之后」意味着块内文本先输出、再补 `\n`，并置 `tf->_html_block = true`。这是为了让
  **单行字段**也认这个换行：Skia 排版会把单行字段里的 `\n` 折成空格（`collapseNewlines`），而 AIR 对
  规则驱动的块级换行**在单行字段里照断**。故 `as_tf_paragraph` 用
  `collapse = (tf->multiline || tf->_html_block) ? 0 : 1`——**原始 `\n` 在单行字段仍折行**（实测），
  只有规则块的换行豁免。`_html_block` 是 C 侧 `bool`，无 GC 指针，故**不进**反射表。
- 声明值经 `as_ss_str`（CSS 数值取数字部分、颜色只认 `#RRGGBB`）喂给既有 run 机制：`color`/`fontSize`/
  `fontFamily`/`fontWeight`/`fontStyle`/`textDecoration`。注意 `as_ss_str` 复用**静态缓冲**，所以
  `display` 派生的 `hidden`/`noinline` 必须在其它 `as_ss_str` 调用**之前**读出来。
- FPS 浮层没有 `defaultTextFormat`，故 `as_tf_paragraph` 在缺省时补一个隐式 `TextFormat`（`_sans`/12/黑）。

**已实测但未对齐的部分**（见 `TODO.md` 遗留表，未美化）：多行 run 的**行高**偏大约 1.5×（同一段
htmlText 我们报 `h=45`、AIR 报 `30.1`，行数与宽度逐值吻合）；`leading` 来自规则时未按 run 生效；
`numLines` 的语义（AIR 计入尾部空行）仍按我们的口径。`StyleSheet.parseCSS` / `transform` **刻意未实现**，
调用处是**响亮**的 `undefined method` 编译错误（不静默接受 AIR 能解析的 CSS）。


**两条与 AIR 对齐的语义细节（阶段八十九·二十八修复）**：

1. **`.text = ...` 替换整段内容**：AIR 的 `.text` 赋值会丢弃此前 `htmlText`/`setTextFormat` 装入的 run，新文本
   仅按 `defaultTextFormat` 排版。AOT 早期把 `text` 建模为裸字段（直接结构体写），run 列表得以残留——而 Starling
   `TrueTypeCompositor` **复用同一个静态原生 `TextField`**（`sNativeTextField`），于是某个字段用过 HTML 富文本后，
   后续**所有**纯文本排版都会重放那些 run（实测 demo 按钮标签 `Back` 从 29 px 高变 38 px 高、切换场景后仍不复原）。
   现改为 `text` 保留字段槽（读仍是 `tf->text`）**同时**注册 setter：`TextField_set_text` 清空 `_runs`、释放
   `_para` 排版缓存后再写入（见 `src/symbols.ts` 的 `TextField` setters、`src/emit.ts` 的 `TextField_set_text`）。
2. **属性值单/双引号等价**：AIR HTML 子集允许 `color='#ff0000'` 与 `color="#ff0000"` 两种引号。早期解析只认 `"`，
   于是单引号值**从引号本身开始**取值：`size='30'` 被 `atof` 读成 0 后落到 1.0 下限、`color='#208080'` 被
   `as_tf_html_parse_hex` 当成 `2080` 读成错误的深蓝（Starling demo 里 `basic` 显示为绿、`HTML` 显示为青）。
   现由 `as_tf_html_attr_value(s, out, cap)` 按「开引号种类」定界（并支持无引号裸值）。

**字体与行高对齐 AIR（阶段九十四·二十）**：`textWidth`/`textHeight`/`numLines`/光标几何全部由
SkParagraph 的布局结果导出，所以「用哪个字面」和「行盒多高」两件事直接决定所有排版数值。二者修前都与 AIR 不一致，
现按 `adl 51.4.1` 实测逐值对齐（证据台 `temp/metricprobe/`，输入矩阵与两侧输出都在里面）。

**(1) 三个设备字体别名必须翻译成真实字面。** AS3 的 `_sans`/`_serif`/`_typewriter` 不是字体族名，是 Flash
运行时要**自己解析**的通用别名；CoreText 不认识 `_typewriter`，原样透传给 SkParagraph 会**静默回落到系统默认
比例字体**——一个 `_typewriter` 字段量 10 个 `W` 得 113.26 px 而不是 72（等宽体被渲染成比例体，字宽差 40%）。
按 adl 实测的**字宽**选定字面（下表 10 字符墨迹宽度，adl / 我们）：

| family | 10×W | 10×i | 10×* | 10×空格 | adl 行高 / 我们 |
|---|---|---|---|---|---|
| `_typewriter` | 72 / 72.01 | 72 / 72.01 | 72 / 72.01 | 72 / 72.01 | **15 / 15** ✓ |
| `_sans` | 113 / 113.26 | 26.5 / 26.66 | 46.5 / 46.70 | 33 / 33.17 | 15.5 / 12 ✗ |
| `_serif` | 113 / 113.26 | 33 / 33.34 | 60 / 60 | 30 / 30 | 15 / 13 ✗ |
| *(空字符串)* | 113 / 113.26 | 33 / 33.34 | 60 / 60 | 30 / 30 | **12 / 12** ✓ |
| Courier / Courier New | 72 / 72.01 | — | — | — | **12 / 12**、13.5 / 14 |
| Menlo / Monaco | 72 / 72.25、72.01 | — | — | — | **14 / 14**、**15 / 15** |
| Helvetica / Arial | 113 / 113.26 | 26.5 / 26.66 | 46.5 / 46.70 | 33 / 33.17 | **12 / 12**、13.5 / 13 |
| Times New Roman / Geneva | 113 / 113.26、113.5 / 113.61 | 33、28 | 60、60.5 | 30、40 | **13 / 13**、**15 / 15** |

映射表：`_typewriter` → `Monaco`、`_sans` → `Helvetica`、`_serif` → `Times New Roman`、空/`null` → `Times`
（AIR 把空字体族读回成 `"Times Roman"`，且其中线高 12 与 Times 的 12 逐值一致，不是 Times New Roman 的 14）。
具名字体一律**原样透传**——它们本来就已经逐值对上（表内加粗项）。别名的翻译与字面查找都在胶水里做
（`sk_family_alias()` / `sk_match_typeface()`，后者按 `(family, bold, italic)` 缓存，避免每段都重跑 CoreText
的族表扫描），且**每条** `setFontFamilies` 通路（平铺字段、带 `TextFormat.leading` 的字段、htmlText 多 run）
都走它，`test.ts` 的 `[fontmetrics]` 有「不留任何未翻译透传」的反向钉子。

**(2) 行盒高度按 AIR 的模型强制。** AIR 把行盒的上下两半**各自四舍五入到 0.5**、且**完全不用字体自带的
line gap**；Skia 报的是 `ceil 型(ascent + descent + lineGap)`。Monaco 的 gap 是 1.002 px，于是同一个 12 px
行 AIR 说 15、Skia 说 16。我们对齐 adl 的模型是：

```
行高 h      = round_half(ascent) + round_half(descent) + leading      (leading 以 px 计)
字段 textHeight = numLines × h − leading            (numLines ≥ 2)
              = h                                   (numLines = 1)
```

第二条是 AIR 的**尾行怪癖**（实测：`TextFormat.leading = 4`、行盒步长 19 px 时，1/2/3/4 行分别报
19 / 34 / 53 / 72——**最后一行的 leading 不计**，行间 leading 照常）。实现上不能靠 Skia 自己的行高：
`sk_set_air_strut()` 给每段装一个 **height override 的 strut**，让 Skia 按该因子缩放字面的 ascent/descent 到
AIR 的盒子；这里有个反直觉点——Skia 的因子分母是 `ascent + descent + lineGap`（`rawFull`）而盒子里**不含**
gap，所以高度必须**预乘 `rawFull / rawSum`**，否则每个强制行盒都正好短一个 line gap（实测 14 而非 15）。
负 leading 另走一条：Skia 把 `StrutStyle::leading < 0` **钳成 0**，所以 `leading = -3`（AIR 盒子 15 → 12）
折进 height，正 leading 才是 leading，`test.ts` 对这两条各有钉子。

**(3) `TextFormat.leading` 的单位是 px。** 修前 `leading` 被当作 em 倍数传给 Skia（`setLeading(leading)`
× fontSize ⇒ 12 px 的值被放大 12 倍，一个 1 行的字段报出 60+ px）。现在 px 值原样进模型，12 px 字号
`leading = 4` 的四档（1..4 行）我们与 adl **12 个数值逐值相同**（19/34/53/72 与负值 12/27/39/51）。

**仍存的偏差（如实记录，未美化）**：`_sans` / `_serif` 两个**通用别名**的行高仍对不上（我们按别名字面算 12 / 13，
AIR 报 15.5 / 15）。原因是 AIR 对通用别名用**自己的设备字体度量表**，且该表**非线性**（实测 12 px 时
`_sans` = 12.5+3、20 px 时 19.5+4.5；`_serif` 12 px = 12+3、20 px = 17.5+5；`_typewriter` 在 12 px 恰好等于
Monaco 的 12+3、但 14 px 起就与 Monaco 分道）——没有一个可解析的字面能复现它。我们**不做**按测量点插值的硬编码
表（那会把未测尺寸的数值也说成「实测」），只把 9 档尺寸的实测值留在证据台，并在 `TODO.md` 登记为遗留项。
同理 `Courier New` / `Arial` 的行高各有 0.5 px 残差（Skia 内部对半像素的取整方向），也一并记录。

> **想换掉这套排版引擎？先读 [`rust-text-backend.md`](rust-text-backend.md)**——那篇逐端评估了
> 「把 SkParagraph 换成 cosmic-text + swash 静态库」的优劣、实测体积账（ICU 数据原本是**一个不可分的
> 10.19 MB 对象**：阶段二百二十一之后它只跟着**画文字**的构建走，阶段二百二十二又把这份数据换成 Skia
> 自己给 wasm 用的 0.80 MB 那份）⇒ 换引擎如今最多再省约 2.5 MB，只在移动端 + 体积硬约束时才值得。

---

## 9. 图片解码（`BitmapData.loadBytes` / `Loader`）

Skia 的 `SkCodec`（`include/codec`）+ `SkImage::MakeFromEncoded` 覆盖 PNG/JPEG/WebP/GIF 等格式解码，
对应 AS3 的 `Loader`/`BitmapData.loadBytes` 图像加载。解码依赖 libpng/libjpeg-turbo/libwebp（§6.2）。
`ByteArray` 二进制运行时（`flash.utils.ByteArray`）是前置依赖，尚未实现（阶段三十~三十二只补了纯逻辑
内建，`ByteArray` 仍在排除清单），故图片解码排在 ByteArray 之后。

### 9.1 实际支持面（实测）与 SVG 的独立通道

上面写的「PNG/JPEG/WebP/GIF 等」**实测面比预期宽**：两端 Skia 都编入了
`skia_use_libwebp_decode=true` + `skia_use_wuffs=true`，而 wuffs **同时**覆盖 BMP / ICO，
故 `SkCodec` 能力上是 **PNG / JPEG / GIF / BMP / WebP / ICO 六种**，全部走同一条
`SkImages::DeferredFromEncodedData` → `SkCodec`（阶段八十九·六十三实测，两端一致）。
**QOI 不在内**——`SkQoiCodec` 未编入（`args.gn` 无 `skia_use_qoi`）。

**但 `Loader` 默认只解 AIR 支持的那三种**（阶段九十四·二十五起）：BMP/WebP/ICO 是 AIR 之外的格式
（`adl` 报 `#2124`），故默认构建在**胶水层按魔数拦掉**它们（连同 TIFF 系相机 RAW/DNG）——
拦截后走上层原有的 `#2124` 失败路径，报错与 `adl` 逐字相同。要放行须显式开 `--features formats`
（BMP/WebP/ICO，两端可用）或 `--features raw`（相机 RAW/DNG，仅 native）——见
[`compile.md`](compile.md) §3.4.3.1 与 [`enhancements.md`](enhancements.md) §4.3/§4.5。
`WBMP`（`SkWbmpCodec` 编入了）**故意不拦**：头部是裸多字节类型字段、无可靠魔数。

**SVG 是唯一的例外，它有自己的一条通道**（阶段八十九·六十五，native，opt-in；开启方式为具名开关
`--features svg`，即定义 `ASC_USE_SVG`，见 [`compile.md`](compile.md) §3.4.2）：
SVG **不是 `SkCodec` 格式**，`DeferredFromEncodedData` 对它必然返回 null，所以它在四个解码入口
（`sk_image_from_file` / `sk_image_from_bytes` / `sk_image_decode_argb` / `sk_image_decode_bytes_argb`）
里都是**「codec 失败之后」的回退**：

```
SkSVGDOM::Builder().setFontManager(sk_platform_fontmgr()).make(stream)
→ setContainerSize(文档自身尺寸，缺省用规范默认 300×150)
→ SkSurfaces::Raster(N32/premul) + clear(TRANSPARENT) + render → SkImage / ARGB
```

两个要点：**`setFontManager` 不设则 `<text>` 一个字都不画**（实测字形像素 97 → 0）；
**wasm 侧无 `libsvg.a`/`libsksg.a`/`libexpat.a`**（`skia_use_expat=false` 把 svg 目标整体门掉），
故 web 不支持 SVG，定义宏即链接期报错。默认构建不含该宏，行为与 AIR 逐字同构（`#2124`）。

### 9.2 显示用的 SkImage 与「解码用的字节」是同一条命（阶段一百五十四）

显示列表里的 `Bitmap` **只从 `bd->image`（SkImage 视图）画**，`bd->pixels`（CPU 缓冲）不参与绘制。
而 `Loader.loadBytes` 这条路上，`bd->image` 是用**同一个 job 里的编码字节**现建的
（`as_skia_image_from_bytes(as_job_bytes(job), as_job_len(job))`）——它不是从文件按名重开，
也没有 URL 可退。于是 job 的 `AS_JOB_DECODE` 分支一旦在解码后把载荷 `free` 掉并把 `bytes/len`
置空（注释当时写的是「只用于解码」），`bd->image` 就恒为 `NULL`：`bitmapData.width/height`
与 `getPixel32` **全都对**（像素确实解出来了），**画面却什么都不画**，且不会报任何错。

TalkMED 登录页的图形验证码正是这条路（服务端返回 `data:image/jpeg;base64,...` → 应用
`Base64.decodeToByteArray` → `Loader.loadBytes`）：请求成功后验证码格仍是空白，而 `adl`
同格显示出图形码。定位手法是**在应用里临时打点**（`content=[object Bitmap]`、
`bitmapData 100x50`、`bitmapData.getPixel32(1,1)` 非零、`numChildren=1`、`parent/onStage` 均真），
把「取到了图」与「画出来了」这两件事分开，才落到 job 载荷的所有权上。

**规则**：`AS_JOB_IMAGE_URL`（http 取回的图）与 `AS_JOB_DECODE`（`loadBytes` 的载荷）
**都必须把编码字节留到 `as_job_retire`**；只有 `AS_JOB_IMAGE`（本地文件）可以在解码后立刻释放——
它的显示视图是按**文件名**重开的（`as_skia_image_from_file`）。单元钉见
`unit: transport/JobOwnership`（三条），所有权表见 [`gc.md`](gc.md) §「从 arena 到 GC 的迁移」。


---

## 10. 与 TODO.md 阶段的关系 + 建议新增渲染阶段

现有规划（阶段三十三~三十五）是「事件 + 显示列表 + 命中」，渲染一直是占位。本文件补齐的是**像素渲染**
那一段。建议在阶段三十五之后新增：

| 建议阶段 | 目标 | 内容 |
|---------|------|------|
| **阶段三十六** | v0.3.36 | **Skia 胶水层 + 构建集成**：`vendor/skia` 引入、`skia_glue.cc` 最小 `extern "C"` 面（surface/canvas/paint/path/color/matrix）、`build.ts` 支持 `.cc` 编译驱动与 `-lskia` 链接、`as_skia_*` 运行时助手、离屏 CPU raster 输出 PNG 的端到端 demo |
| **阶段三十七** | v0.3.37 | **`flash.display` 渲染落地**：`Shape`/`Graphics` → `SkPath`+`SkPaint`（fill/stroke/渐变）、`Bitmap`/`BitmapData` → `SkImage`（含 `setPixel/getPixel/draw`）、`DisplayObject` 变换（translate/rotate/scale/alpha/blendMode）、递归渲染 + 深度序 |
| **阶段三十八** | v0.3.38 → v0.3.73 | **`TextField` 文本渲染**：单行 `SkFont` + `drawString` 直绘、`TextFormat` 样式（font/size/color/bold/italic）；多行排版先自研贪心换行（v0.3.45）后升级 SkParagraph（v0.3.73，`sk_textlayout_*` 桥接，HarfBuzz shaping + UAX#14 断行 + 真实行高 + 缓存）、`clip` 裁剪、`numLines`/`maxScrollV`/`scrollV` 视口数学；修复 `sk_font()` 每次重建 CoreText FontMgr 导致的多行首帧卡死 |
| **阶段四十四** | v0.3.45 | **Retina 高清渲染**：`ASC_DISPLAY_HIGH` 走 `ALLOW_HIGHDPI` + drawable probe，surface 按物理像素创建、纹理 1:1 上屏不再重采样 |

> 阶段三十六是「接 Skia」的关键卡点，它验证「生成的 C 能通过胶水层调用 Skia 并产出正确像素」。
> 建议先把它做成**最小可行闭环**（画一个 `Shape` 的矩形 → 输出 PNG → 断言像素），再铺开阶段三十七/三十八。

---

## 11. 风险与边界

| 风险 | 说明 | 应对 |
|------|------|------|
| **构建复杂度** | Skia 用 GN/ninja，体量大、编译久（全量数十 MB 库） | 用 `is_official_build` + 只编 `skia` 目标；文档固定编译步骤，可考虑预编译产物随仓库/CI 分发 |
| **C++20 要求** | 需 clang，且本机 Apple clang 版本要够新 | 文档写明最低版本；`build.ts` 检测 C++ 编译器 |
| **无 C API** | 必须维护胶水层，Skia API 升级会牵动 glue | glue 只暴露最小面；按需加函数，不做全面封装 |
| **体积/启动** | 静态链接后二进制明显变大 | 教学编译器可接受；GPU 后端可减少 CPU 光栅化成本 |
| **wasm 适配** | Skia 的 wasm 面向 emscripten，WASI 适配成本高 | 改用 emscripten 直接产出浏览器产物（`--package web`），已端到端验证；见 [`html5-web.md`](html5-web.md) |
| **文本排版** | SkParagraph 是独立库，体量与复杂度都不小，且其 UAX#14 换行与 AIR `wordWrap`（仅按空格断行）在超长单词/连字符处语义漂移 | 阶段三十八先自研贪心换行，v0.3.73 升级 SkParagraph（漂移收敛为两个边缘情况，已记录为已知限制）；富文本 `htmlText`/多 `TextFormat` 区间样式留后续 |

**边界声明（与项目哲学一致）**：Skia 只解决「画」，**不解决** AS3 显示列表层级、事件捕获/冒泡、命中
三态机、焦点、tab 序——这些仍是阶段三十三~三十五的 C 运行时职责（Ruffle 语义参照）。Skia 不是
「GUI 框架」，是「光栅化后端」；GUI 的骨架（显示列表 + 事件 + 命中）是我们自己翻译的 AS3 语义。

---

## 12. 参考链接

- 官方文档：<https://skia.org/docs/>
- API 索引（Doxygen）：<https://api.skia.org>
- 构建指南：<https://skia.org/docs/user/build/>
- 下载指南：<https://skia.org/docs/user/download/>
- SkCanvas 概览：<https://skia.org/docs/user/api/skcanvas_overview/>
- 坐标系统：<https://skia.org/docs/user/coordinates/>
- 源码（GitHub 镜像）：<https://github.com/google/skia>（主仓 <https://skia.googlesource.com/skia>）
- 协议：BSD-3-Clause（`LICENSE`，Copyright 2011 Google Inc.）
