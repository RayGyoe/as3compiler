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
  "opt": "-O2",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia/include"],
  "link-libs": ["skia", "skparagraph"],
  "link-paths": ["../vendor/skia/lib"],
  "defines": ["ASC_USE_SKIA=1"],
  "objects": []
}
```

> 注意：现有 `examples/skia-link.build.example.json` 里写的是 `skia_glue.c`。因为 Skia 是 C++，胶水层
> 实际应是 `.cc`（C++ 源），且编译命令需要用 `c++/clang++` 驱动（`-lstdc++` 隐式）。`build.ts` 需要在
> `sources` 里识别 `.cc/.cpp` 后缀并切换到 C++ 编译驱动——这是渲染阶段落地时要补的构建层能力。

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
| `Graphics.drawCircle/drawRect/drawRoundRect` | `SkCanvas::drawCircle/drawRect/drawRRect` | 快捷几何 |
| `Bitmap.bitmapData` / `BitmapData` | `SkBitmap`/`SkImage` + `drawImage` | `BitmapData` 是像素缓冲，`Bitmap` 是显示节点 |
| `BitmapData.setPixel/getPixel` | `SkBitmap::setPixel/getColor`（或 `SkPixmap`） | CPU 读写像素 |
| `BitmapData.draw(source)` | `SkCanvas::drawImage/drawSurface`（离屏 surface 合成） | 位图间拷贝/合成 |
| `TextField.text`（基础字形） | `SkFont` + `SkTextBlob` → `drawTextBlob` | 仅字形定位，无换行 |
| `TextField`（完整排版：换行/对齐/段落） | **SkParagraph**（`modules/skparagraph`）→ `SkParagraph::layout` + `paint` | AS3 的自动换行/多行需要 SkParagraph |
| `TextFormat.font/size/color/bold/italic` | `SkFont` + `SkTypeface` + `SkPaint` | 字体族/字号/加粗/斜体 |
| `filters.BlurFilter` | `SkImageFilters::Blur`（`saveLayer` 包裹子树） | 已落地（阶段六十一），`sigma ≈ blurX/3` |
| `filters.DropShadowFilter` | `SkImageFilters::DropShadow`（`saveLayer` + `SkImageFilter`） | 已落地（阶段六十一），外投影 |
| `filters.GlowFilter` | `SkColorFilters::Matrix`（alpha 轮廓着色）+ 模糊 + 叠本体 | 已落地（阶段六十一），外发光 |
| `DisplayObject.mask` | `canvas->saveLayer` + mask 绘制 + `SkBlendMode::kSrcIn` | AS3 遮罩语义 |
| `scrollRect` | `canvas->clipRect` | 裁剪可视区域 |

**坐标变换的正确姿势**（对应 Skia `SkCanvas` 的矩阵栈）：

```
渲染一个 DisplayObject 子树（递归）：
  canvas->save();
  canvas->translate(obj->x, obj->y);
  canvas->rotate(obj->rotation);
  canvas->scale(obj->scaleX, obj->scaleY);
  canvas->concat(obj->transform.matrix);     // 若有完整 matrix
  if (obj->scrollRect) canvas->clipRect(obj->scrollRect);
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

> **本项目实际落地方式（预编译）**：本机缺少 `gn`/`ninja` 且磁盘空间不足以从源码编译，故改用
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

---

## 7. 多目标：native 与 wasm

- **native**：Skia 静态链接 `libskia.a`（CPU raster 或 GPU），产出 Mach-O/ELF/PE。
- **wasm**：Skia 官方有 **CanvasKit**（`modules/canvaskit`，Skia + WebAssembly 的 JS 绑定产物），但那是
  JS 生态；我们要的是 C ABI，做法是**用 wasm32 工具链把 Skia + 我们的胶水层一起编成 WASI**。注意 Skia
  的 wasm 构建通常面向 emscripten（CanvasKit 路径），WASI 的适配成本高于 native——**首期只保证 native
  渲染链路跑通**，wasm 渲染延后（`--target wasm` 阶段仍只支持无 GUI 的程序）。这符合「分阶段、先跑通主链」。

---

## 8. 文本渲染的两档方案

`TextField` 是 AS3 GUI 里最复杂的一环，Skia 提供两档：

1. **基础字形（`SkFont` + `SkTextBlob`）**：给定字体/字号/颜色，把一串 UTF-8 画到指定基线位置。
   **不支持自动换行、对齐、段落**。适合「单行文本 / 简单 label」的首期实现。
2. **完整排版（SkParagraph，`modules/skparagraph`）**：支持换行、左右对齐、字间距、多段落、富文本样式。
   对应 AS3 `TextField` 的 `wordWrap`/`multiline`/`textWidth`/`textHeight`/`autoSize`/`htmlText`。

**决策修正（阶段四十四实际落地）**：原计划用 SkParagraph，实际落地是 **`SkFont` 测量 + 自研贪心换行**
（`runtime.ts` 的 `as_text_wrap`），理由与阶段二十四~二十七自研正则引擎同源——**语义漂移**：

- AS3 `wordWrap` 只在**空格**处断行，超宽的单字整词溢出（不拆分）；SkParagraph 走 UAX#14 Unicode
  换行算法，可在任意字符边界（连字符/CJK 字间）断行，直接拿来与 AIR 行为不一致。
- AIR 的 `maxScrollV`/`scrollV` 是「视口行」语义（`numLines - visibleLines + 1`，`scrollV = maxScrollV`
  让最新行贴底），属于显示列表/裁剪层逻辑，SkParagraph 不提供。
- 重要的是**没有自研光栅化**：字形测量（`sk_text_measure_n`）与绘制（`sk_canvas_draw_text_n` →
  `drawSimpleText`）仍全部交给 Skia，自研的只是「在哪断行」这一层 AS3 语义，符合 §2.9 铁律。

SkParagraph 仍留给真正的富文本需求（`htmlText`、多 `TextFormat` 区间样式、对齐/字间距/多段落），
列为后续子阶段。当前未做：`autoSize`/`hscroll`/`selectable`/`leading`，行高用 `size × 1.2` 近似而非字体
metrics 表；排版无缓存（每帧重算，demo 规模无碍）。断言式回归见 `examples/textflow.as`。

---

## 9. 图片解码（`BitmapData.loadBytes` / `Loader`）

Skia 的 `SkCodec`（`include/codec`）+ `SkImage::MakeFromEncoded` 覆盖 PNG/JPEG/WebP/GIF 等格式解码，
对应 AS3 的 `Loader`/`BitmapData.loadBytes` 图像加载。解码依赖 libpng/libjpeg-turbo/libwebp（§6.2）。
`ByteArray` 二进制运行时（`flash.utils.ByteArray`）是前置依赖，尚未实现（阶段三十~三十二只补了纯逻辑
内建，`ByteArray` 仍在排除清单），故图片解码排在 ByteArray 之后。

---

## 10. 与 TODO.md 阶段的关系 + 建议新增渲染阶段

现有规划（阶段三十三~三十五）是「事件 + 显示列表 + 命中」，渲染一直是占位。本文件补齐的是**像素渲染**
那一段。建议在阶段三十五之后新增：

| 建议阶段 | 目标 | 内容 |
|---------|------|------|
| **阶段三十六** | v0.3.36 | **Skia 胶水层 + 构建集成**：`vendor/skia` 引入、`skia_glue.cc` 最小 `extern "C"` 面（surface/canvas/paint/path/color/matrix）、`build.ts` 支持 `.cc` 编译驱动与 `-lskia` 链接、`as_skia_*` 运行时助手、离屏 CPU raster 输出 PNG 的端到端 demo |
| **阶段三十七** | v0.3.37 | **`flash.display` 渲染落地**：`Shape`/`Graphics` → `SkPath`+`SkPaint`（fill/stroke/渐变）、`Bitmap`/`BitmapData` → `SkImage`（含 `setPixel/getPixel/draw`）、`DisplayObject` 变换（translate/rotate/scale/alpha/blendMode）、递归渲染 + 深度序 |
| **阶段三十八** | v0.3.38 | **`TextField` 文本渲染**：`SkFont` + `drawString` 单行直绘，`TextFormat` 样式（font/size/color/bold/italic），背景矩形；多行排版当时未做 |
| **阶段四十四** | v0.3.45 | **`TextField` 多行排版 + Retina 高清**：`as_text_wrap` 硬换行/`wordWrap` 贪心软换行（Skia 实测宽度）、`clip` 裁剪、`numLines`/`maxScrollV`/`scrollV` 视口数学；`sk_canvas_draw_text_n`/`sk_text_measure_n` 按长度接口；`ASC_DISPLAY_HIGH` 走 `ALLOW_HIGHDPI` + drawable probe；修复 `sk_font()` 每次重建 CoreText FontMgr 导致的多行首帧卡死 |

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
| **wasm 适配** | Skia 的 wasm 面向 emscripten，WASI 适配成本高 | 首期只做 native 渲染，wasm GUI 延后 |
| **文本排版** | SkParagraph 是独立库，体量与复杂度都不小，且其 UAX#14 换行与 AIR `wordWrap`（仅按空格断行）语义漂移 | 阶段四十四用 `SkFont` 测量 + 自研贪心换行覆盖 `multiline`/`wordWrap`/`scrollV`；SkParagraph 留给 `htmlText`/富文本 |

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
