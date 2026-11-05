# BitmapData YUV 直渲 — 设计文档（已实现）

> 目标：给 `BitmapData` 增加一个超出 AIR 的增强方法 `setYuv420(rect, inputByteArray)`，让 ANE 视频帧
> **以 I420 YUV 原始字节直接进入渲染管线**，由 GPU 硬件完成 YUV→RGB 转换，而不是在 CPU 侧先转成 ARGB
> 再交给 `setPixels`。这是对齐 AIR 之外的**增强**（AIR 的 `BitmapData` 没有这个方法），按 §1.5 必须
> opt-in 语义清晰、缺能力响亮报明、跨端差异显式列出。

---

## 0. 实施状态

**已全部落地**（三阶段，阶段三百七十四）：

- **阶段 A / B**：`_yuv_data` 字段 + `setYuv420` 方法（`--features yuv420` 门控，默认构建无此成员）、
  四个后端 context getter（Metal `sk_metal_get_context` / D3D12 `sk_d3d_get_context` / WGL
  `sk_gl_get_context` / WebGL2 `sk_gr_get_context`）、`sk_image_from_yuv` glue、`as_bmd_live_image` YUV 分支；
- **阶段 C**：CPU 退化语义（无 context 警告一次 + 黑屏）+ 端到端验收；
- **落点**：`examples/yuv420-probe.as`（字节读入契约：游标推进 / 短包 `#2030` / 奇数与部分 rect `#2004` /
  无重叠静默）、`examples/yuv420-render.as`（Skia 链接 + CPU 黑屏 + 正对照红色）；
- **测试**：`test/unit/build.ts`（`yuv420` → `ASC_USE_YUV420=1`、默认无宏、native/wasm 可接受）、
  `test/unit/emit.ts`（`unit: emit/Yuv420`：默认无成员、feature 开时方法体/字段/YUV 分支齐全）；
- **待真机验色**：GPU 直渲的 BT.601 颜色正确性需 `--air-app` + `renderMode=gpu` 窗口产物（Metal）与
  WebGL2 浏览器页面验证，本节写时尚未做真机逐像素比对（见 §7）。

---

## 1. 背景与动机

### 1.1 现状：视频帧的 CPU 转换链路

ANE 相机/屏幕共享的视频帧，当前走的是「ANE 侧转 ARGB → `setPixels`」两条腿：

1. **ANE 侧（C++）**：libyuv `I420ToARGB` 把 YUV420 平面转成 32 位 BGRA，塞进一个 `ByteArray`；
2. **AS3 侧**：`videoByteArray.endian = LITTLE_ENDIAN` 后调 `BitmapData.setPixels(rect, ba)`；
3. **渲染侧**：`as_bmd_live_image` 用 `sk_image_from_argb` 把 `bd->pixels`（straight ARGB）再拷贝成一张
   CPU raster `SkImage`，画的时候才上传 GPU。

也就是每一帧在 CPU 上做了**一次 YUV→ARGB 转换（libyuv）+ 两次整帧拷贝（setPixels 写入 + sk_image_from_argb
建 SkImage）**。YUV420 本身只有 ARGB 的 3/2 字节，却在 ANE 边界就膨胀成 ARGB 再全链路搬运。

### 1.2 目标形态：YUV 直通到 GPU

`setYuv420` 的目标是砍掉第 1 步和第 2 步里的转换/膨胀：

- ANE 直接产出 **I420 平面字节**（这正是它解码出的原生形态，libyuv 的输入），**不做** `I420ToARGB`；
- AS3 调 `setYuv420(rect, ba)` 把三平面**原样存进** BitmapData；
- 渲染时用 Skia 的 GPU YUV 纹理入口（`SkImages::TextureFromYUVAPixmaps`）把 Y/U/V 平面直接变成一张
  **GPU 纹理**，由 GPU shader 按 BT.601 做 YUV→RGB，省掉 CPU 转换与整帧 ARGB 拷贝。

---

## 2. 目标与非目标

### 2.1 目标

- `BitmapData.setYuv420(rect:Rectangle, inputByteArray:ByteArray):void`：从 `ByteArray` 的 cursor 起读
  紧凑 I420 平面（Y `w×h`、U `w/2×h/2`、V `w/2×h/2`，总 `w×h×3/2` 字节），存入 BitmapData 的 YUV 缓冲；
- 渲染路径在 **GPU 后端**（native `ASC_RENDER_WINGPU` / web `ASC_RENDER_GPU`）走 YUV 纹理直渲；
- 色彩空间固定 **BT.601 视频范围**（Skia `kRec601_Limited_SkYUVColorSpace`，Y∈[16,235]、U/V∈[16,240]）；
- 命名 `setYuv420`：点明 4:2:0 子采样，不绑定 libyuv 术语，给未来 `setNv12`/`setYuv422` 留名；
- **opt-in 开关**：`--features yuv420`（清单 `"features": ["yuv420"]`）→ 宏 `ASC_USE_YUV420=1`，可用目标
  native / wasm；不开开关时 `BitmapData` 无 `setYuv420` 成员，与 AIR 逐字同形（报 `BitmapData has no member 'setYuv420'`）。

### 2.2 非目标（本期不做）

- **不做** CPU 手写 YUV→ARGB 转换：无 GPU 后端时**警告 + 黑屏**（响亮不静默），不偷偷转 ARGB；
- **不做** NV12 / YUY2 / 10-bit / 有 stride 的布局；不做平面分离的三参数形式；
- **不做** 运行时色彩空间切换（BT.709 / JPEG 全范围 / BT.2020）：固定 BT.601，未来需要再加参数；
- **不做** 原生 AIR 对齐——`setYuv420` 是增强，AIR 无对应物。

---

## 3. 现状盘点

### 3.1 BitmapData 的像素与渲染路径

- `BitmapData` 的 `pixels` 存 **straight ARGB**（`0xAARRGGBB`，`unsigned` 每像素），是 GC 堆 `GCT_BYTES` 缓冲；
- 显示树上的 `Bitmap` 通过 `as_bmd_visible_image(bd)` 拿 SkImage，未改动的解码图走零拷贝 `image`，写过像素
  的走 `as_bmd_live_image(bd)` → `sk_image_from_argb(bd->pixels, w, h)`（`vendor/skia_glue.cc`，
  `SkImages::RasterFromPixmapCopy`，CPU 拷贝建 raster SkImage）；
- `_live_image` + `_live_ver` 缓存 SkImage，版本号由每个 mutator 的 `as_bd_mark_dirty` 驱动重建。

### 3.2 GPU context 的分布（关键约束）

Skia 的 `TextureFromYUVAPixmaps` 是**后端无关**的（只吃 `GrRecordingContext*`），YUV 直渲对下面**四个 Ganesh
后端一律可用**——差别只在「context 怎么拿到」：

| 后端 | 宏 | GrDirectContext 位置 | 形态 |
|---|---|---|---|
| Metal（macOS） | `ASC_RENDER_METAL` | `vendor/metal_glue.mm` 的 `g_context`（`GrDirectContexts::MakeMetal`） | 进程级单 context |
| Direct3D12（Windows 默认） | `ASC_RENDER_D3D` | `vendor/d3d_glue.cc` 的 `g_context`（`GrDirectContext::MakeDirect3D`） | 进程级单 context |
| OpenGL/WGL（Windows Win7 兼容） | `ASC_RENDER_GL` | `vendor/gl_glue.cc` 的 `w->ctx`（`GrDirectContexts::MakeGL`） | **每窗口一个**（Skia 规则：一个 GL context 对应一个 GrDirectContext） |
| WebGL2（web） | `ASC_RENDER_GPU` | `vendor/skia_glue.cc` 的 `g_gr_context`（`__EMSCRIPTEN__`，`GrDirectContexts::MakeGL`） | 进程级单 context |
| CPU（native/web 默认） | 无上述宏 | **无** | `SkSurfaces::Raster` + SDL streaming texture / putImageData |

### 3.3 Skia 的 YUV 能力

- Skia **没有**「CPU raster 的 YUV SkImage」入口；YUV→RGB 只在 GPU 头里：
  `vendor/skia/include/gpu/ganesh/SkImageGanesh.h` → `SkImages::TextureFromYUVAPixmaps(GrRecordingContext*, const SkYUVAPixmaps&)`。
- 已 `nm` 确认该符号在 **macos-arm64 / wasm 的 libskia.a** 里都存在（native 4 个重载、wasm 2 个）。
- 色彩空间枚举在 `vendor/skia/include/core/SkImageInfo.h`：`kRec601_Limited_SkYUVColorSpace`（= legacy
  `kRec601_SkYUVColorSpace`）正是 BT.601 视频范围；`kJPEG_Full_SkYUVColorSpace` 是全范围。
- `SkYUVAPixmaps` 平面布局枚举在 `SkYUVAInfo.h`：`PlaneConfig::kY_U_V` + `Subsampling::k420`。

**结论**：直渲 YUV = GPU 专属，必须有 GrDirectContext；默认 CPU 构建只能「警告 + 黑屏」。

---

## 4. 核心设计

### 4.1 API 形状

```as3
// 超出 AIR 的增强。I420 planar，BT.601 视频范围，紧凑无 stride、无 endian。
function setYuv420(rect:Rectangle, inputByteArray:ByteArray):void;
```

读取语义**对齐 `setPixels`**：从 `inputByteArray.position` 起读，`position` 逐字节推进；rect 越界部分裁剪
（像素落在 BitmapData 外则跳过）；缓冲不足时**保留已写入部分并抛 `EOFError #2030`**（`as_throw_eof`），
与 `setPixels` 的短缓冲契约一致（`temp/gdsetpixels/` 实测口径）。

### 4.2 数据结构

`BitmapData` 新增一个 GC 堆 YUV 缓冲（`GCT_BYTES`），复用现有 `pixels` 同款所有权的字段模式：

```c
// BitmapData 新增字段（与 pixels 并列，非替代）：
unsigned char* _yuv_data;   // 紧凑 I420：Y[w*h] | U[w*h/4] | V[w*h/4]，总 w*h*3/2
```

- **存的是 YUV，不是 ARGB**：`_yuv_data` 与 `pixels` 互斥使用——`setYuv420` 写 `_yuv_data`，普通 mutator
  （`setPixel`/`fillRect`/`setPixels`/`draw`…）继续写 `pixels`；两者并存时**渲染以 YUV 优先**，一旦有普通
  mutator 写 `pixels`，`_yuv_data` 释放并让位。
- 三平面由同一块连续缓冲 + 已知 `w/h` 推导偏移（Y=`_yuv_data`，U=`+w*h`，V=`+w*h*5/4`），**不拆三个指针**。

### 4.3 Skia YUV 转换（`vendor/skia_glue.cc`）

新增一个跨后端统一的入口，由调用方传入已拿到的 GrDirectContext：

```cpp
// skia_glue.cc —— 把紧凑 I420 三平面交给 Ganesh，得到一张 GPU-backed SkImage。
// TextureFromYUVAPixmaps 会在返回前把 YUV 拷进 GPU 纹理（SkYUVAPixmaps 调用后即可释放）。
void* sk_image_from_yuv(void* gr_ctx, const void* y, const void* u, const void* v, int w, int h) {
  if (gr_ctx == nullptr || y == nullptr || u == nullptr || v == nullptr || w <= 0 || h <= 0) return nullptr;
  SkYUVAInfo info = SkYUVAInfo::Make(SkISize::Make(w, h),
                                     SkYUVAInfo::PlaneConfig::kY_U_V,
                                     SkYUVAInfo::Subsampling::k420,
                                     kRec601_Limited_SkYUVColorSpace);
  const void* planes[3] = { y, u, v };
  auto pixmaps = SkYUVAPixmaps::FromExternalMemory(info, planes);   // 借用，不拷贝
  if (!pixmaps.isValid()) return nullptr;
  auto img = SkImages::TextureFromYUVAPixmaps((GrRecordingContext*)gr_ctx, pixmaps,
                                              SkBudgeted::kYes, nullptr);
  return img.release();   // 调用方持有一 ref（或 NULL 失败）
}
```

配套一个 context getter 的统一收口（见 4.4），避免 emit 的 C 去关心后端差异。

### 4.4 渲染分支与 context 收口

`as_bmd_live_image` 增加 YUV 分支，**只在有 YUV 数据时**替换 ARGB 路径：

```c
static void* as_bmd_live_image(BitmapData* bd) {
  // ... 现有 ARGB 缓存判断不变 ...
  if (bd->_yuv_data != NULL) {
    // YUV 直渲：拿到后端 GrDirectContext（无则返回 NULL → 黑屏 + 一次警告，见 4.5）
    void* ctx = as_skia_gr_context();       // runtime 辅助：按后端宏分派到 Metal/D3D/GL getter，web 用 g_gr_context
    if (ctx == NULL) { as_yuv_cpu_warn(bd); return NULL; }
    void* img = as_skia_image_from_yuv(ctx, bd->_yuv_data, bd->_yuv_data + w*h, bd->_yuv_data + w*h*5/4, w, h);
    // finalizer 注册 img（对齐 _live_image），返回 img
  }
  return as_skia_image_from_argb(bd->pixels, bd->width, bd->height);
}
```

context 收口放在 glue 层，不泄漏进 emit 的 C：

- 各后端 glue 各导出 `extern "C"` getter：`sk_metal_get_context()` / `sk_d3d_get_context()` /
  `sk_gl_get_context()`（web 由 `skia_glue.cc` 内的 `g_gr_context` 直接给出）——统一返回「当前窗口」的
  GrDirectContext；
- `src/runtime.ts` 加 `as_skia_gr_context()`：按 `#ifdef ASC_RENDER_METAL / ASC_RENDER_D3D / ASC_RENDER_GL /
  ASC_RENDER_GPU` 分派到对应 getter（CPU 分支返回 NULL）；`as_skia_image_from_yuv()` 为 inline wrapper
  （Skia 分支 + 无 Skia no-op stub），使生成的 C 不直接摸 glue 内部 static；
- **GL 后端的额外注意**：`w->ctx` 是每窗口一个，`sk_gl_get_context()` 必须返回**当前渲染窗口**的 ctx，不能
  只缓存进程级单例（gl_glue 已有窗口激活追踪，getter 复用同一份「当前窗口」）。

### 4.5 CPU 后端退化（响亮不静默）

无 GrDirectContext（默认 CPU 构建）时，`setYuv420` **照常存 YUV**，但渲染时 `as_skia_gr_context()` 返回 NULL：

- 输出**一次**警告（按 BitmapData 去重，非每帧刷屏）：`warning: setYuv420 needs a GPU backend (ASC_RENDER_WINGPU/ASC_RENDER_GPU); rendering black`；
- 返回 NULL → 该 Bitmap 渲染为黑/透明，**不静默画错色**。

这是 §1.5 的「缺能力报明」：宁可黑屏 + 警告，也不在 CPU 上偷偷手写 YUV→ARGB（那会推翻「直渲」的前提）。

### 4.6 生命周期

- `_yuv_data` 是 GC 堆 `GCT_BYTES`，`dispose()` / 析构 / 下一次 `setYuv420` / 任一普通 mutator 写 `pixels` 时释放；
- 产出的 GPU SkImage 与现有 `_live_image` 同款走 finalizer（`as_final_register`），避免「BitmapData 被替换/回收但
  SkImage 悬挂」——`TextureFromYUVAPixmaps` 已把 YUV 拷进 GPU 纹理，所以 `_yuv_data` 可复用，但 SkImage 必须随
  BitmapData 释放（按 kind 区分 `SkImage` 删除，复用现有 finalizer 表）。

---

## 5. 分阶段实施

> **状态：三阶段均已落地**（阶段三百七十四）。下面保留分阶段施工口径，实际落点见 §0。

### 阶段 A：数据结构 + `setYuv420` 存字段（纯加法，先不读）

- `src/symbols.ts` 注册 `setYuv420`（两参，返回 `void`），受**内部宏 `ASC_USE_YUV420` 门控**（未开时
  `BitmapData` 无该成员，报 `no member 'setYuv420'`）；本阶段**暂不**登记 `--features yuv420`（等 Stage C 端到端
  验收后才暴露名字）；
- `src/emit.ts`：`BitmapData` 加 `_yuv_data` 字段（ctor 初始化 NULL）；`BitmapData_setYuv420` 从 ByteArray
  cursor 读 `w*h*3/2` 字节存 `_yuv_data`，`as_bd_mark_dirty`，短缓冲 `EOFError #2030`，越界裁剪；`dispose`/普通
  mutator 释放 `_yuv_data`；
- 本阶段**渲染仍走 ARGB**（`_yuv_data` 写了不读），保证纯加法、不破坏现有 623 例回归。

### 阶段 B：Skia glue + context 收口 + 渲染分支（核心）

- 各后端 glue 各导出 getter：`metal_glue.mm` 加 `sk_metal_get_context()`、`d3d_glue.cc` 加
  `sk_d3d_get_context()`、`gl_glue.cc` 加 `sk_gl_get_context()`；`skia_glue.cc` 加 `sk_image_from_yuv`；
- `src/runtime.ts` 加 `as_skia_gr_context()` / `as_skia_image_from_yuv()` wrapper 与 no-op stub；
- `src/emit.ts` 的 `as_bmd_live_image` 加 YUV 分支（有 `_yuv_data` 走 GPU 直渲，无 context 警告黑屏）；
- 单元钉子：emitted C 里存在 YUV 分支、`sk_image_from_yuv` 调用、`kRec601_Limited`、`as_yuv_cpu_warn` 分支。

### 阶段 C：CPU 退化语义 + 端到端验收

- CPU 构建（无 GPU）`setYuv420` → 渲染黑屏 + 一次警告的端到端钉子；
- GPU 构建（`ASC_RENDER_WINGPU`）固定 YUV 帧（纯红/灰/蓝）→ `getPixel32` 验色，与 libyuv/公式对照；
- **登记 `yuv420` → `ASC_USE_YUV420=1` 到 `build.ts` 的 FEATURES 注册表**（暴露 `--features yuv420`，可用
  native / wasm；`--help` 与报错文案同步列出）；
- 双语文档、`TODO.md` 阶段记录、版本 bump、commit/push。

---

## 6. 风险与边界（如实报明）

1. **跨文件 / 多后端 context 收口**：native 的 GrDirectContext 分布在三个 glue（`metal_glue.mm`、`d3d_glue.cc`、
   `gl_glue.cc`），需各自经 `extern "C"` 导出 getter、由 `src/runtime.ts` 按后端宏分派——GPU 构建本就会链对应
   后端 glue，无新增链接负担；但 **GL 是每窗口一个 context**，getter 必须绑定「当前渲染窗口」，这是
   Metal/D3D 进程级单例所没有的额外状态。
2. **CPU 后端黑屏**：默认 CPU 构建下 `setYuv420` 只存不渲染（警告 + 黑屏）。这是**刻意**的 §1.5 取舍，但意味着
   该增强在「开箱即用」的默认构建里没有视觉输出，只有 GPU 构建才生效——验收必须分两态，不能拿 CPU 构建证明正确。
3. **YUV 纹理生命周期**：`TextureFromYUVAPixmaps` 把 YUV 拷进 GPU 纹理，SkImage 必须进 finalizer；`_yuv_data`
   与 `pixels` 互斥，任一普通 mutator 写 `pixels` 必须释放 `_yuv_data` 并让 SkImage 版本失效，否则出现「YUV 帧
   之后 fillRect 不生效」的冻结。
4. **色彩空间固定 BT.601**：不提供运行时切换，BT.709 / JPEG 全范围 / BT.2020 输入会偏色。这是本期明确的非目标，
   文档与 `enhancements.md` 显式列出。
5. **验证后端覆盖**：GPU 直渲需要 `ASC_RENDER_WINGPU`（Metal）真机窗口验证；web 的 `ASC_RENDER_GPU` 需要浏览器
   WebGL2 页面验证。纯 C 无 raster 后端时 `setYuv420` 不触发渲染，不能据此证明 GPU 直渲等价。

---

## 7. 验收与回归总纲

- 单元钉子（已落地）：`unit: build/Features`（`yuv420` 宏映射、默认无宏、native/wasm 可接受）、
  `unit: emit/Yuv420`（默认构建无 `setYuv420` 成员；feature 开时方法体/字段/`as_bmd_live_image` YUV 分支齐全）。
- 端到端示例（已落地）：`examples/yuv420-probe.as`（字节读入契约，纯 C 无光栅可跑）、
  `examples/yuv420-render.as`（Skia 链接 + CPU 黑屏 + 正对照红色）。
- 全量回归 `node test.ts` 保持绿；`setYuv420` 不得破坏现有 `setPixels`/`fillRect`/`draw` 的 ARGB 路径。
- **仍待真机验色**：GPU 构建（`ASC_RENDER_WINGPU`）固定 YUV 帧（纯红/灰/蓝）→ `getPixel32` 与 libyuv/公式
  逐像素比对；WebGL2 浏览器页面验证。纯 C 无 raster 后端时 `setYuv420` 不触发渲染，不能据此证明 GPU 直渲等价。

---

## 8. 参考

- Skia Ganesh YUV：`vendor/skia/include/gpu/ganesh/SkImageGanesh.h`、`vendor/skia/include/core/SkYUVAPixmaps.h`、
  `SkYUVAInfo.h`、`SkImageInfo.h`（`SkYUVColorSpace` 枚举）。
- 现有渲染路径：`src/emit.ts` 的 `as_bmd_live_image`/`as_bmd_visible_image`、`BitmapData_setPixels`；
  `vendor/skia_glue.cc` 的 `sk_image_from_argb`；`vendor/metal_glue.mm` / `d3d_glue.cc` 的 `g_context` 与 `gl_glue.cc` 的 `w->ctx`。
- 增强口径：`docs/zh-cn/enhancements.md`（§1.5 的 opt-in / 响亮报明 / 跨端差异）。
- 短缓冲 EOF 契约：`temp/gdsetpixels/` 实测（`setPixels` 注释已录）。
