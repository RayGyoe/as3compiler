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
  "opt": "-O2",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia/include"],
  "link-libs": ["skia", "skparagraph"],
  "link-paths": ["../vendor/skia/lib/macos-arm64"],
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

### 6.4 版本选型结论（为什么 SDL 用 2.32、Skia 用 m124）

**SDL：2.32.10 就是当前 SDL2 主线，不旧。** 见 [`compile.md`](compile.md) §6（窗口后端）。项目 pin 的是
SDL2 而非 SDL3，理由：SDL3（2025-01 首发 3.2.0）太新，社区生态/教程/第三方绑定 90% 仍在 SDL2；对「单窗口
+ 把 Skia 表面 blit 上屏」的轻量场景无实质收益；且 SDL3 移除了 `SDL_CreateRGBSurface`、改了渲染器接口、
把 `SDL_Event` 改成 union，`window_glue.cc` 里的 `SDL_CreateRGBSurfaceFrom`/`SDL_RenderCopy`/
`SDL_GetWindowSizeInPixels`/`SDL_RenderSetVSync` 全都要重写。这些能力（尤其 `SDL_GetWindowSizeInPixels`，
SDL 2.26 才加入）正是修复跨屏倍率 bug 的依赖，说明 2.32 对本项目够用且恰好支持所需。我们是源码编译 arm64
静态库（`configure --host=arm64-apple-darwin --disable-shared`），版本自控，无需追一个刚满一年的新大版本。

**Skia：m124 确实旧（约 1.5 年），但有具体原因。** 根本原因是环境受限：本机缺 `gn`/`ninja` 且磁盘不足以
从源码编译，只能吃 Aseprite 官方钉死的预编译 milestone（§6.1）。次要原因：Skia 无稳定 API/ABI，milestone
每 4~6 周滚动、接口频繁变动，升级意味着重写整层 `skia_glue.cc`；而 m124 已含所需全部模块
（`SkParagraph`/`Skottie`/GPU 后端）。**升级触发条件**：只有当确需新 milestone 才有的特性（如某个新
`SkImageFilter`、新字体引擎行为）时，才补 `gn`/`ninja` 环境从源码自编译最新版，并重测整个胶水层。

---

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
  这个 4px 不是新约定：`autoSize`（`width = textWidth + 4`）与 `maxScrollH`（`over = textWidth + 4 - width`）
  早已按它写，**只有断行阈值一处漏减**。修复见阶段八十九·六十六，`test.ts` 有 `[textwrap]` 结构钉子。
  > 另注：`textWidth` 对带尾空格的文本，AIR 含尾空格（`"Multitouch "` = 133）、我们不含（恒 124.945）。
  > 这是**另一个**独立的口径差异，**不影响断行**（见上表），已按 §1.5 记入 `TODO.md` 遗留表。
- AIR 的 `maxScrollV`/`scrollV` 是「视口行」语义（`numLines - visibleLines + 1`，`scrollV = maxScrollV`
  让最新行贴底），仍由运行时层计算；SkParagraph 只负责「排」与「画」，符合 §2.9 铁律。
- 同样**没有自研光栅化**：shaping/断行/绘制全部交给 SkParagraph，自研的只有「缓存失效 key」这一层。

SkParagraph 的富文本能力（`htmlText`、多 `TextFormat` 区间样式、对齐/字间距/多段落）均已落地：`htmlText`
解析 `<font>`/`<b>`/`<i>`/`<u>`/`<p>`/`<br>` 子集并生成「字节区间 + `TextFormat`」run 列表，`setTextFormat`
以同样机制追加 run；`sk_textlayout_new_runs` 按 run 顺序 `pushStyle`/`addText`/`pop`，run 之间的间隙回落到
段落默认样式（= `runs[0]` 的字体/字号，颜色取自 `defaultTextFormat`）。`autoSize`/`hscroll`/`selectable`/`leading`
亦已落地，断言式回归见 `examples/textrich.as`（`examples/textflow.as` 为布局基线）。

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

---

## 9. 图片解码（`BitmapData.loadBytes` / `Loader`）

Skia 的 `SkCodec`（`include/codec`）+ `SkImage::MakeFromEncoded` 覆盖 PNG/JPEG/WebP/GIF 等格式解码，
对应 AS3 的 `Loader`/`BitmapData.loadBytes` 图像加载。解码依赖 libpng/libjpeg-turbo/libwebp（§6.2）。
`ByteArray` 二进制运行时（`flash.utils.ByteArray`）是前置依赖，尚未实现（阶段三十~三十二只补了纯逻辑
内建，`ByteArray` 仍在排除清单），故图片解码排在 ByteArray 之后。

### 9.1 实际支持面（实测）与 SVG 的独立通道

上面写的「PNG/JPEG/WebP/GIF 等」**实测面比预期宽**：两端 Skia 都编入了
`skia_use_libwebp_decode=true` + `skia_use_wuffs=true`，而 wuffs **同时**覆盖 BMP / ICO，
故 `Loader` 实际可解的编码格式是 **PNG / JPEG / GIF / BMP / WebP / ICO 六种**，全部走同一条
`SkImages::DeferredFromEncodedData` → `SkCodec`（阶段八十九·六十三实测，两端一致）。
**QOI 不在内**——`SkQoiCodec` 未编入（`args.gn` 无 `skia_use_qoi`）。

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
