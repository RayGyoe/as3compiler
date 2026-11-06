# GPUI（Zed）Windows 后端：怎么画 UI、怎么加速（源码级调研）

> **状态：纯调研，未改任何代码、不改版本号。** 本文只回答「一个生产级 Rust GUI 框架在 Windows 上
> 用什么画、凭什么快」，供我们自己的 Windows 后端（Win32 + SDL2 + Skia D3D12，见 [`win32.md`](win32.md)）
> 做取舍参照。**不主张复刻它**——理由见 §10。
>
> **调研对象（两个 crate，不是一个仓库）**：
> - `gpui-pre-windows 0.3.11`——Zed 的 `crates/gpui_windows` 快照，元数据记 `zed@f816e1f`。
>   这是本文的**主要证据源**。
> - `gpui-fast-windows 0.1.13`——longbridge 的 `gpui-fast` 分支（Zed GPUI 的 fork），
>   Windows 侧增补见 §9。**与上游行为不同处本文一律标注**。
>
> 捕获方式（源码已解包在 `temp/gpui/`，属临时目录、不进仓库）：
>
> ```sh
> git clone --depth 1 https://github.com/longbridge/gpui-kit.git temp/gpui/gpui-kit
> curl -sL -o gpui-pre-windows.crate \
>   https://crates.io/api/v1/crates/gpui-pre-windows/0.3.11/download   # + 另三个 crate
> ```
>
> **行号口径**：下文 `file:line` 若无特别说明，一律相对
> `gpui-pre-windows-0.3.11/src/`；`gpui/` 前缀者是上游主 crate `gpui-pre-0.3.11/src/`。
> 行号只对上述快照有效——它是 pin 死的（`Cargo.toml` 用 `=0.3.11` 精确版本，见
> `gpui-kit/Cargo.toml` 注释），所以可复核。
>
> **与 [`rust-text-backend.md`](rust-text-backend.md) §13 的分工**：那一节谈的是**文本栈怎么切**
> （整形/字体/光栅分别交给谁，对象是更早的 `gpui 0.2.2` / `zed@5447804`）；本文谈的是
> **像素怎么出去**（渲染器、图集、批、合成、帧节奏）。文本只在 §5.2 讲"怎么变成 GPU 上的图集"
> 这一面，不重复整形/断行。

---

## 0. 结论速览

| 问题 | 结论 | 证据 |
|---|---|---|
| 用 Direct2D 画吗？ | **完全不用**。整个 crate 零 `D2D`/`Direct2D` 引用，`windows` feature 清单里也没有 `Win32_Graphics_Direct2D` | `Cargo.toml`；全 crate grep |
| 那用什么画？ | **D3D11**（自绘 primitive 管线）+ **DXGI flip 交换链** + **DirectComposition** + **DirectWrite**（只做字形光栅化，不绘制） | `directx_renderer.rs:1-22` |
| 一帧几次 draw call？ | 通常**个位到几十次**：整个 UI 压成 8 类 primitive，同类相邻批每个一次 `DrawInstanced(4, N)` | `directx_renderer.rs:373-395, 1214` |
| 文字怎么画？ | DirectWrite **离屏**光栅化成位图 → 三张图集（灰度/ClearType 3×1/彩色）→ 当 sprite 实例化贴 | `direct_write.rs:740-940` |
| 矢量怎么画？ | 三角化 → **整批一次**画进 4×MSAA 中间纹理 → resolve → 再当 sprite 贴上主目标 | `directx_renderer.rs:615-720` |
| 透明窗怎么实现？ | `WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition` + DComp visual，alpha 交给 DWM | `window.rs:516`、`directx_renderer.rs:1298` |
| 帧节奏？ | 独立线程 `DwmFlush()` 对齐合成时钟后 `RedrawWindow`；`Present(0,0)` **不阻塞** | `vsync.rs`、`platform.rs:446`、`directx_renderer.rs:245` |
| "120 FPS" 是什么？ | 官方文档明确降级为**帧预算话术**（120 Hz 屏上 8.33 ms/帧），不是"每秒重建 120 次" | `gpui-kit/website/docs/fps.md:28` |
| 可移植给我们的是什么？ | ① DComp 这条**透明窗/合成链**（正对我们 `<transparent>` 在 Windows 未实现的缺口）；② vsync 线程与非阻塞 Present 的**解耦思路**；③ 「文字/矢量必须批化」的结构约束。**不是**它的自绘管线 | §10 |

> 它用 D3D11、我们用 D3D12，这个差别**不是取向不同**：Skia m124 在 Windows 上只有 D3D12 一条
> Direct3D 后端，而我们又不肯丢掉与 Stage3D 共用的 device/queue。完整的机制对照、我们为 D3D12
> 手写掉的那部分、以及「什么条件下才该回头碰 D3D11」在 [`d3d11-vs-d3d12.md`](d3d11-vs-d3d12.md)。

---

## 1. 先定位：渲染器不在 `gpui-kit` 里

`gpui-kit` 只是上层（base / component / kit / shell），**一行渲染代码都没有**。GPUI 本体是锁定的上游
快照，Windows 后端更在**第三个 crate** 里：

| crate | 角色 | 是否有 Windows 绘制代码 |
|---|---|---|
| `gpui-kit` / `gpui-base` / `gpui-component` | 组件、行为、设计系统 | 无 |
| `gpui-pre`（包名，`use gpui::*`） | 引擎内核：Element / Scene / 布局 / 图集抽象 | 有 **平台无关**的 `Scene` 与 `PlatformAtlas`/`PlatformTextSystem` trait，无具体后端 |
| `gpui-pre-platform` | 20 KB 的**转发层**：`cfg_select!` 按目标把 `current_platform()` 接到具体后端 | 无（只有接线） |
| **`gpui-pre-windows`** | 真正的 HWND/D3D11/DWrite 实现 | **是**（13k 行，本文主体） |
| `gpui-pre-macos` / `gpui-pre-linux` / `gpui-pre-web` | 另三端 | — |

这层结构本身值得注意：**引擎只认 trait（`PlatformAtlas`、`PlatformTextSystem`、`PlatformWindow`），
每端一个完整后端**。`temp/gpui/` 里因此需要 4 个 crate 才能读到完整链路。

---

## 2. 不是 D2D：实际用的五个组件

`gpui-pre-windows/Cargo.toml` 给 `windows` crate 开的 feature 里，图形相关的全部是：

```toml
"Win32_Graphics_Direct3D11",        # 设备与绘制
"Win32_Graphics_Direct3D_Fxc",      # 运行期编 HLSL（debug 用）
"Win32_Graphics_DirectComposition", # 视觉树 / 与 DWM 合成
"Win32_Graphics_DirectManipulation",# 触控/触控板手势
"Win32_Graphics_DirectWrite",       # 字形光栅化 + 字体
"Win32_Graphics_Dwm",               # 暗色模式、背景材质、合成时钟
"Win32_Graphics_Dxgi_Common",
"Win32_Graphics_Hlsl",
```

**没有 `Win32_Graphics_Direct2D`**，且 `grep -ri 'd2d\|direct2d'` 在整个 crate 零命中。

| 组件 | 在 gpui 里的职责 | 它**不**做什么 |
|---|---|---|
| D3D11 | 全部像素输出：8 条自建管线、实例化绘制、MSAA resolve、Present | 不做几何生成（CPU 侧三角化后传结构化缓冲） |
| DXGI | flip-model 交换链（`FLIP_SEQUENTIAL`）、adapter 枚举 | — |
| DirectComposition | 把交换链挂成 visual，交给 DWM 用 premultiplied alpha 合成 | 不参与像素生成 |
| DirectWrite | **只做两件事**：字体枚举/整形，以及 `IDWriteGlyphRunAnalysis` 把**单个字形**光栅化成 alpha 位图 | **不画字**——没有 `DrawTextLayout` 上屏路径 |
| DWM | 合成时钟（`DwmFlush`）、刷新周期（`DwmGetCompositionTimingInfo`）、系统背景材质 | — |

### 为什么不用 D2D

D2D 的甜点是"**保留的几何对象 + 少量 Draw**"（GDI 替代品）：`ID2D1Geometry` 建一次、多次复用，
配合 `ID2D1CommandList` 录制。gpui 的模型正好相反：

1. **每帧重建 scene**（immediate 语法的元素树 → 扁平 primitive 数组），D2D 的 geometry realization
   缓存每次都要失效；
2. 它的着色需求是**自定义 shader 级的**：解析覆盖率抗锯齿（`ddx/ddy` 求二次曲线梯度）、
   SDF 圆角/阴影、ClearType 覆盖率的 gamma 仿真、亚像素 sprite 的双源混合、emoji COLR 图层合成。
   D2D 只在几个固定模式里给你选，够不到这些；
3. D2D 本身建在 D3D 之上，**多一层封装不多买任何东西**，反而丢掉直接控制实例缓冲/管线状态的能力。

对我们是同一个判断：**Skia 已经提供了"2D API 之上的一层"**，再套 D2D 是同一层叠两次。

---

## 3. 一帧的完整路径

```
 [VSyncProvider 线程]                              [UI 线程（WndProc 所在）]
 DwmFlush() ──阻塞到合成时钟
   └─► DwmGetCompositionTimingInfo 得刷新周期
   └─► 对每个可见未最小化窗口：
         frame_signal.record(t)
         RedrawWindow(RDW_INVALIDATE)
                              │  (WM_PAINT 入队)
                              ▼
                     handle_paint_msg → draw_window
                              │
                     DrawCoordinator::try_begin_draw()   ← 防重入：嵌套 paint 只 ValidateRect + 延后一帧
                              ▼
                     request_frame(RequestFrameOptions{
                         require_presentation: false, force_render, signal_at, signal_source })
                              ▼
                     gpui 核心：should_draw = invalidator.is_dirty() || force_render
                              │ 干净 ──► 连 present 都跳过（空转成本≈0）
                              ▼ 脏
                     window.draw()  →  Entity::render → Element 树 → 布局(taffy) → prepaint → paint
                              ▼
                     Scene { 8 个 primitive 数组 + paint_operations }
                              ▼
                     DirectXRenderer::render(scene)
                              ▼
                     upload_scene_buffers → 8 个批循环 → 每批一次 DrawInstanced(4,N)
                              ▼
                     Present(0, DXGI_PRESENT(0))   ← 不等待 vsync
```

关键事实：

- **绘制发生在 UI 线程**（`WndProc` 里），用 immediate context；Windows 后端只有一个额外线程
  （vsync / 设备恢复），见 §7。
- 入口门控是 `let should_draw = invalidator.is_dirty() || force_render;`（`gpui/window.rs:2022`）。
  **空闲真的空闲**——这一点比"每帧无条件重绘"的框架省掉整条重建链。
- 重入保护在 `events.rs:1354`：嵌套 `WM_PAINT` 不做第二次绘制，只 `ValidateRect` + 记一笔
  `force_render_pending`。否则嵌套消息泵会在"仍无效的区域"上忙循环。

---

## 4. `Scene`：整个 UI 压成 8 类 primitive

`gpui/scene.rs:36-47` 的 `Scene` 只有几个扁平 `Vec`：

| 字段 | 内容 |
|---|---|
| `shadows` | 阴影（圆角矩形 + blur 半径 + inset 标志） |
| `quads` | 实心/渐变矩形（含圆角、边框、四角半径、变换矩阵） |
| `paths` | 矢量路径（顶点 + 绘制顺序 + 裁剪 bounds） |
| `underlines` | 文字下划线/删除线等线段 |
| `monochrome_sprites` | 灰度图集贴图（含文字灰度字形、图标） |
| `subpixel_sprites` | ClearType 3×1 图集贴图 |
| `polychrome_sprites` | 彩色图集贴图（emoji、彩色图） |
| `surfaces` | 原生 surface 占位（**上游 Windows 不画**，见 §8） |
| `paint_operations` / `layer_stack` / `primitive_bounds` | 绘制顺序、嵌套图层、包围盒树 |

**批是怎么切的**（`gpui/scene.rs:172` 的 `Scene::batches()`）：按**类型 + 图集纹理 id + 相邻绘制顺序**
合并连续区间。也就是说：

- 相邻同类型的 element **合进一个实例缓冲区间**，渲染侧一次 `DrawInstanced` 全画完；
- 中间插进一个不同类型的（比如文字拆开两个 `div`），就**断成两批**——所以"少改 z 序交错"本身是性能手段。

渲染侧的批循环（`directx_renderer.rs:373`）对每个批做同一件事，只是管线不同：

```rust
device_context.DrawInstanced(4, instance_count, 0, 0);   // :1214
```

4 个顶点 = 一个 triangle strip quad，shader 里用 `float2(float(vertex_id & 1), 0.5 * float(vertex_id & 2))`
拼出 `(0,0)(1,0)(0,1)(1,1)` 单位方框，再用 `SV_InstanceID` **索引结构化缓冲**取本实例的
bounds/颜色/图集 tile：

```hlsl
StructuredBuffer<MonochromeSprite> mono_sprites: register(t1);
uint sprite_id = batch_start_index + instance_id;   // batch_start_index 走常量缓冲
```

实例数据**不进 input layout**，而是 `StructuredBuffer`（SRV）+ 一个记录批起点的常量缓冲
（只在变化时 `Map`）。这是整个设计的关键取舍：**顶点布局固定为 4 个空顶点，几何全在实例数据里**，
于是 8 条管线共享同一个顶点拓扑，改布局不需要改 IA。

---

## 5. 四个加速杠杆

### 5.1 批合并 + 实例化：CPU 侧 draw 数与元素数脱钩

普通界面（几百个 div、几千个字形）实测只有个位数到几十个 draw call。对比"每元素一次 draw"的
immediate 框架，这是第一个数量级。

缓冲策略（`directx_renderer.rs:1130-1161`）：

- 每个管线一个**动态实例缓冲**，`D3D11_MAP_WRITE_DISCARD` 整块重写（`:1644`）；
- 容量不足时按 `next_power_of_two` **翻倍重建**，上限 `MAX_INSTANCE_BUFFER_SIZE = 256 MB`（`:30`）；
- 因此缓冲跨帧复用，稳态下零分配。

### 5.2 文字：离屏光栅化 → 图集 → sprite（不要每帧 "draw text"）

> 整形/字体匹配/断行归 [`rust-text-backend.md`](rust-text-backend.md) §13。这里只讲**像素怎么进 GPU**。

`direct_write.rs:740` 起的字形光栅化，全程用 DirectWrite 的**离屏**接口，没有一个上屏绘制调用：

1. 造一个"单字形 run"（`glyphCount: 1`，advance/offset 置零），带 `DWRITE_MATRIX` 缩放；
2. `GetRecommendedRenderingMode` 取推荐模式；**`OUTLINE` 一律改成 `NATURAL_SYMMETRIC`**（`:795`）——
   因为 outline 模式意味着"交给系统按 hinting 画"，而我们要的是稳定可缓存的位图；
3. `IDWriteFactory::CreateGlyphRunAnalysis` → `GetAlphaTextureBounds` 取包围盒 →`CreateAlphaTexture` 取位图：
   - 灰度走 `DWRITE_TEXTURE_ALIASED_1x1`（1 通道）；
   - ClearType 走 `DWRITE_TEXTURE_CLEARTYPE_3x1`（RGB 三通道，即 3 倍亚像素相位信息）；
4. 位图写进图集（`directx_atlas.rs:1`，分配器 `etagere::BucketedAtlasAllocator`，三张图集
   **按像素格式分开**：mono / subpixel / poly）；
5. 绘制时只按图集 tile 贴 sprite（`shaders.hlsl:1184` / `:1194` / `:1256`）。

两个容易被忽略但很要紧的细节：

- **亚像素相位进缓存键**：`gpui/text_system.rs:50` 的 `SUBPIXEL_VARIANTS_X = 4`、`SUBPIXEL_VARIANTS_Y = 1`，
  即同一字形最多缓存 4 个水平亚像素位置。因为文字在动画里移动时 x 常常带小数，不量化相位就会
  每帧重光栅化。
- **ClearType 是"仿真"而非调用**：真正的硬件 ClearType 要求**不透明背景上的固定像素对齐**，一旦控件要
  透明/缩放/动画就废。gpui 的做法是——拿 DirectWrite 给的 3×1 覆盖率，在 fragment shader 里自己做
  gamma 与增强对比度校正：

```hlsl
float3 alpha_corrected = apply_contrast_and_gamma_correction3(
    sample, input.color.rgb, subpixel_enhanced_contrast, gamma_ratios);
```

参数来自系统：`IDWriteRenderingParams1::GetGamma()` 与若干对比度（`directx_renderer.rs:353` 附近
`get_font_info`）；同时由 `get_system_subpixel_rendering()`（`direct_write.rs:1950`）读系统设置决定
是否启用亚像素。**结论：看起来像 ClearType，但仍然是常规 alpha 混合**，所以透明窗、动画、高 DPI 缩放
都不破功。——这和我们踩过的"ClearType 与透明背景不共存"是同一个问题的另一种解法。

彩色字形（emoji）：`TranslateColorGlyphRun`（`direct_write.rs:1004`）只请求 `COLR` 图层，每层
`CreateAlphaTexture` 成 1 通道位图，然后**在 GPU 上**由 `emoji_rasterization_fragment`
（`color_text_raster.hlsl:39`）按层的 `run_color` 合成成 RGBA，**结果缓存进彩色图集**——即合成只做一次，
不是每次绘制都叠层。

### 5.3 矢量：整批一次 pass，MSAA 只存在于路径批

`draw_paths_to_intermediate`（`directx_renderer.rs:615`）：

1. 把**这一批所有 path** 的三角形顶点拼成一个大数组，一次 `Draw` 画进一张 **4×MSAA 中间纹理**
   （`PATH_MULTISAMPLE_COUNT = 4`，`:26`；D3D11 feature level 10.1+ 保证可支持）；
2. fragment 用屏幕空间导数算覆盖率，而不是靠 MSAA 硬采（`shaders.hlsl:996`）：
   ```hlsl
   float2 dx = ddx(input.st_position);
   float2 dy = ddy(input.st_position);
   float2 gradient = 2.0 * input.st_position.xx * float2(dx.x, dy.x) - float2(dx.y, dy.y);
   float distance  = (st.x*st.x - st.y) / length(gradient);   // 二次曲线的解析距离
   alpha = saturate(0.5 - distance);
   ```
   4× MSAA 在这里只补**三角形边缘**（曲线内部由上面这段解析式管）；
3. `ResolveSubresource` 降采样到非 MSAA 纹理（`:640` 附近）；
4. 再作为 sprite 贴回主目标（`draw_paths_from_intermediate`，`:678`）——同绘制顺序则逐 path 贴自己的
   bounds，跨顺序则贴**最小包围矩形**一次（避免透明路径被复制两遍）。

于是：**矢量只为"有 path 的那一批"多付一次 render pass，MSAA 显存也只在那一处**。图标、边框、
圆环、图表这类 path 密集场景不会被 MSAA 拖死，也不需要 CPU 侧 tessellation cache。

### 5.4 圆角 / 阴影：纯 shader，零额外 pass

- 圆角：`quad_sdf()`（SDF 距离场）在颜色 fragment 里直接求值，**不生成 mask、不开 render target**；
- 阴影（`shaders.hlsl:913`）：`blur_radius == 0` 时退化成 SDF；否则沿 y 做 **4 次采样 × 高斯权重积分**，
  且 `start/end` 被 clamp 到 `±3σ`，"信号只在有限区间非零，别浪费采样"；
- `inset` 阴影取"模糊洞"的补集，再乘元素自身的 SDF 边缘。

所以阴影/圆角也只是一个实例化 quad——**没有 blur pass、没有离屏纹理**。

---

## 6. 呈现与合成：DirectComposition 这条链

窗口创建时（`window.rs:516`）：

```rust
if !disable_direct_composition {
    dwexstyle |= WS_EX_NOREDIRECTIONBITMAP;   // 不要 GDI 的窗口 redirection bitmap
}
```

交换链（`directx_renderer.rs:1298`，`CreateSwapChainForComposition`）：

| 参数 | 值 | 为什么 |
|---|---|---|
| `Format` | `B8G8R8A8_UNORM` | DComp/DWM 的原生格式 |
| `BufferCount` | **3**（`BUFFER_COUNT`，`:1695`） | 2 个在窗口被合成器搬动时会同时被扣住，导致提交卡顿（我们在 `win32.md` 也撞到同一类问题） |
| `SwapEffect` | `FLIP_SEQUENTIAL` | 组合交换链的取法 |
| `Scaling` | `DXGI_SCALING_STRETCH` | 注释明说：**组合交换链只支持这一个值**（HWND 路径才用 `NONE`） |
| `AlphaMode` | `PREMULTIPLIED` | 混合交给 DWM，必须预乘 |

然后把交换链挂进视觉树（`:1016-1031`）：

```rust
let comp_device = DCompositionCreateDevice(&dxgi_device)?;
let comp_target  = comp_device.CreateTargetForHwnd(hwnd, true)?;
let comp_visual  = comp_device.CreateVisual()?;
comp_visual.SetContent(&swap_chain)?;
comp_target.SetRoot(&comp_visual)?;
comp_device.Commit()?;
```

收益：**帧的 alpha 混合由 DWM 用 premultiplied 做**，所以透明窗、圆角/阴影边缘、高 DPI 缩放都由合成器
高质量处理，且 resize 不会出现 GDI 那套闪烁/撕裂。**这也是我们 `<transparent>` 在 Windows 上的正解**
（见 §10）。

排障用开关：环境变量 `GPUI_DISABLE_DIRECT_COMPOSITION` 让整条链回落到
`CreateSwapChainForHwnd`（`Scaling = NONE`、`AlphaMode = IGNORE`、`SWAP_EFFECT_FLIP_SEQUENTIAL`）。

---

## 7. 帧节奏：`DwmFlush` 线程 + 非阻塞 Present

**上游的做法**（`vsync.rs` + `platform.rs:446`）：

1. 起一个名为 `VSyncProvider` 的线程（进程级，不是每窗口）；
2. `VSyncProvider::new()` 用 `DwmGetCompositionTimingInfo` 取真实刷新周期
   （`qpcRefreshPeriod`；对"29 µs"这种不可能的坏值退化到 `rateRefresh`；再不行用 16.666 ms 兜底）；
3. 循环里 **`DwmFlush()` 阻塞到 DWM 合成时钟**，醒来后对**每个可见且未最小化**窗口
   `RedrawWindow(..., RDW_INVALIDATE)`；顺带在这条线程上做 device-lost 检测；
4. 绘制侧 `Present(0, DXGI_PRESENT(0))`——**不带任何等待标志**，不在 Present 里等 vsync。

**一个真实的坑，注释写得很清楚**：显示器睡眠、窗口被完全遮挡时合成器没东西可做，`DwmFlush`
会**立刻返回**。若不加判断就会退化成忙循环。代码用 **1 ms 阈值**判"等待过短"，是就
`std::thread::sleep(interval)` 补偿，并把帧信号源标成 `LocalSchedule`（而非 `NativeCallback`）。
这个区分还能让上层知道"这一帧不是合成器给的"。

**"120 FPS"的真身**：`gpui-kit/website/docs/fps.md:28` 专门辟了一节
「120 Hz is a frame budget, not a refresh promise」——它指的是 120 Hz 屏幕上单帧 8.33 ms 的**预算**，
不是"空闲时每秒重建 120 次元素树"。配合 §3 的 `is_dirty` 门控，空闲态**既不重建也不 present**。

**与我们当前实现的差异**：我们的 D3D12 后端是 `swapchain->Present(1, 0)`（`vendor/d3d_glue.cc:1118`），
即 **sync interval 1 = 在 Present 里阻塞到下一次 vblank**。后果是我们把 UI 线程和 vsync 绑死了：
一帧超过 16.67 ms 就没有第二次机会，且拖动/resize 期间表现依赖 SDL 的 pump 节奏。gpui 的
"独立 DwmFlush 线程 + Present(0,0)" 把**节拍**与**提交**拆开，是另一种取舍（代价是出现 tearing 风险
由 DWM 合成吸收，以及多一帧延迟的可能）。

---

## 8. 其它工程细节

| 细节 | 做法 | 出处 |
|---|---|---|
| HLSL 编译 | **release**：`build.rs` 找 `fxc.exe` 编 8 个 module，DXBC 直接内嵌；**debug**：`D3DCompileFromFile` 运行期编译，可热改 shader | `build.rs`、`directx_renderer.rs:1703/1842` |
| 设备丢失 | `try_to_recover_from_device_lost`：**5 次重试**（100 ms 起递增）；恢复后 `skip_draws = true` **故意丢掉第一帧**——图集里的 tile 引用还指向旧 device 的纹理，此时画会 panic | `directx_devices.rs:24-38`、`directx_renderer.rs:270/339` |
| GPU 选择 | 遍历 adapter，取**第一个**能建 D3D11 且支持 `StructuredBuffer`（SM4.x `ComputeShaders_Plus_RawAndStructuredBuffers_Via_Shader_4_x`）的；**无 WARP 软件回退**，也没用 `EnumAdapterByGpuPreference` | `directx_devices.rs:110-193` |
| 帧内重入 | `DrawCoordinator::try_begin_draw()`；嵌套 paint 只 `ValidateRect` + `force_render_pending`，最多晚一帧 | `events.rs:55/1354` |
| 原生 surface | **上游 `draw_surfaces` 是空实现**（`:816`）——WebView2 这类原生 surface 上游 Windows 后端根本不画 | `directx_renderer.rs:816` |
| 后台任务 | 线程池回调跑在 `THREAD_PRIORITY_TIME_CRITICAL`，并在执行期间 `timeBeginPeriod(1)` 抬到 1 ms 定时精度 | `dispatcher.rs:155-171` |
| 输入 | 触控/触控板走 `IDirectManipulationManager` 的 viewport（**只做手势识别，不输出画面**），事件在 `draw_window` 入口统一 drain | `direct_manipulation.rs`、`events.rs:1361` |
| 系统背景材质 | `DWMWA_SYSTEMBACKDROP_TYPE`（22H2+），旧系统回落 `SetWindowCompositionAttribute` | `window.rs:1610-1651` |
| 调试标注 | `ID3DUserDefinedAnnotation::BeginEvent/EndEvent` 给 GPU 调试器（PIX）分标签 | `directx_renderer.rs:106-117` |

---

## 9. `gpui-fast` 分支：第二层加速

longbridge 的 fork 只允许自己改一个子模块（`src/fast/`），上游文件只加"一行转发"，以便持续合并上游。
Windows 侧新增（**与 D2D 无关，也与平台无关——mac/linux/web 各有对应实现**）：

| 优化 | 上游行为 | fast 行为 | 出处 |
|---|---|---|---|
| **按需帧** | 每个 vsync **无条件** `RedrawWindow` 所有可见窗口，UI 线程必然被唤醒走一趟 WndProc | `FrameRequest` 门闩：没请求就不失效、不惊动 UI 线程 | `fast/frame_schedule.rs:118` |
| **绑定去重** | 每个批**全量重绑**管线/采样器/纹理/常量缓冲 | `DrawState` 记录当前绑定，跳过重复设置 | `fast/draw_state.rs` |
| **路径缓冲复用** | 每个批新建 `Vec` 收顶点与 sprite | 顶点/sprite 缓冲跨帧保留 | `fast/frame.rs` |
| **滚动层 tile 缓存** | 滚动时整层重画 | 按 tile 缓存、只重合成变化的 tile | `fast/layers/` |
| **圆角 scope 免 mask** | — | 圆角几何写进一张**不可变**纹理，颜色 shader 里直接求值，不需要 mask render target | `fast/rounded_clip.rs` |
| **多 surface 合成** | 一个窗口一个交换链一个 visual | 每个 GPUI surface（含 WebView2 原生 surface）各一条交换链 + 一个 visual，按序挂在 DComp 树根下；原生 surface 用矩形裁剪 + opacity 隐藏 | `fast/composition.rs` |
| **提交线程化** | vsync 线程只做失效 | 升级为带 device recovery 的 worker，帧请求走 condvar 唤醒 | `fast/frame_schedule.rs` |

另外 fork 在**引擎侧**还做了 app 层加速（保留式 scene、增量布局、`layout_key`、`path_cache`、
`line_break` 等，见 `gpui-fast/src/fast/`），这与平台后端正交。

一条判断：**上游已经解决了"画什么"和"怎么批"，fast 解决的是"什么时候画"和"重复绑定"**。
后者对我们有参照价值（我们的 `sk_pump_frame` 每次都要重新设管线状态吗？值得量一次）。

---

## 10. 对我们（Win32 + SDL2 + Skia D3D12）的取舍

现状见 [`win32.md`](win32.md)：`CreateSwapChainForHwnd`（`FLIP_DISCARD` + `R8G8B8A8_UNORM` +
`Scaling = NONE`）→ `SkSurfaces::WrapBackendRenderTarget` → Ganesh D3D12 → `Present(1, 0)`。

| 结论 | 内容 | 理由 |
|---|---|---|
| **该借** | **DirectComposition 这条链**：`WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition`（`PREMULTIPLIED`）+ visual 挂根 | 它直接填掉我们 `win32.md` 核对表第 24 行那个缺口：**`<transparent>` 在 Windows 未实现**。旧思路（`WS_EX_LAYERED` + 逐帧 `UpdateLayeredWindow` alpha）要 CPU 回读或额外 D3D 目标，而 DComp 让 DWM 用 GPU 合成，且顺带解决圆角窗（`DWMWA_WINDOW_CORNER_PREFERENCE`）/阴影边界。**这是本文对我们最高价值的单点** |
| **该借（需评估）** | Present 解耦：独立 `DwmFlush` 线程 + `Present(0,0)` | 我们 `Present(1,0)` 把 UI 线程锁在 vblank 上；拖动/resize 时 `win32.md` §2.8 已经证明帧只能靠 SDL event watch 驱动。解耦能否改善帧时间分布，需实测（`ASC_GPU_STATS=1` 现成口径）。风险是 tearing 与一帧延迟，而 AIR 的 `frameRate` 语义是**应用自己的节拍**，未必需要跟合成器锁死——这一点得先确认 `adl` 行为再动 |
| **该借（轻）** | 3 个 back buffer | 我们 `win32.md` §2.x 已记录 `BufferCount=2` 在合成器搬窗时会同时扣住两个 buffer → 提交卡顿。gpui 用 3 |
| **不借** | 自建 primitive 管线（8 类 primitive、实例缓冲、结构化缓冲、自写 AA） | Skia 已经在 Ganesh 里做了批合并、字形图集、analytic AA、SDF；复刻等于把 Skia 拆掉重写。gpui 之所以自建，是因为它**不背 Skia 那样的通用 2D API 义务**，可以只做 8 种图元 |
| **不借** | DirectWrite 字形光栅化的**具体实现** | 我们的文本栈已经外包给 Skia（含字形缓存/图集），重复实现一套只会带来第二个校准口径。但它的**两个约束值得记**：① 字形位图必须按像素格式分图集（灰度 vs 3×1 vs RGBA）；② 亚像素相位必须进缓存键 |
| **不借** | GPU adapter 选择策略 | 它"取第一个可用 adapter、无 WARP 回退"，在混合显卡机器上会落 iGPU——我们 `win32.md` 的枚举+D3D12 探针选型更稳 |
| **记一笔** | ClearType 仿真路线 | 若将来我们要在透明窗/动画上做亚像素文字，正确形态是"覆盖率位图 + shader 内 gamma/对比度校正"，不是调用系统 ClearType |

---

## 11. 复核方法

想验证本文任何结论，不必构建 Zed（需要 Windows + MSVC + 完整 Cargo 依赖图），直接读源码即可：

```sh
cd temp/gpui/crates/gpui-pre-windows-0.3.11/src

grep -rn 'D2D\|Direct2D' .                 # 期望：零命中
grep -n 'CreateSwapChainFor' directx_renderer.rs
grep -n 'DrawInstanced' directx_renderer.rs      # 期望：2 处，均 (4, N)
grep -n 'Present(' directx_renderer.rs           # 期望：Present(0, DXGI_PRESENT(0))
grep -n 'CreateAlphaTexture\|CreateGlyphRunAnalysis' direct_write.rs
grep -n 'SUBPIXEL_VARIANTS' ../../gpui-pre-0.3.11/src/text_system.rs
grep -n 'RDW_INVALIDATE' platform.rs      # 每 vsync 无条件失效（上游）
grep -n 'take_request' ../gpui-fast-windows-0.1.13/src/fast/frame_schedule.rs   # fast 的门闩
```

要真机看行为，最小的观察点是两条：`GPUI_DISABLE_DIRECT_COMPOSITION=1` 前后窗口透明/缩放表现差异；
以及 PIX 抓一帧看批量（`ID3DUserDefinedAnnotation` 的 label 会显示成每批一个事件）。
