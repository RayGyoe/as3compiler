# GPUI（Zed）Windows 后端：怎么画 UI、怎么加速（源码级调研）

> **状态：纯调研，未改任何代码、不改版本号。** 本文只回答「一个生产级 Rust GUI 框架在 Windows 上
> 用什么画、凭什么快」，供我们自己的 Windows 后端（Win32 + SDL2 + Skia D3D12，见 [`win32.md`](win32.md)）
> 做取舍参照。**不主张复刻它**——理由见 §10。
>
> **调研对象（两个来源，行号互不通用）**：
> - `gpui-pre-windows 0.3.11`——Zed 的 `crates/gpui_windows` crates.io 快照，元数据记
>   `zed@f816e1f`。**§2–§8 的证据源**。
> - **`gpui-fast`**——longbridge 对 Zed GPUI 的 fork（Retained Mode 实验）。**§9 的证据源**，
>   本机已有完整源码：`asaotui/gpui-fast-src/`，主干 `046a859`（2026-11-06，`fast: forget released
>   entities in a spliced view's dependencies (#106)`），基于 zed `7960b2a7`（见其 `UPSTREAM`）。
>   旧版 §9 用的是 crates.io 上 `gpui-fast-windows 0.1.13` 的打包快照，**路径与行号都已失效**，
>   本版重写为对 fork 主干的源码级分析。
>
> 捕获方式：
>
> ```sh
> # §2–§8：Windows 后端快照（解包在 temp/gpui/，临时目录、不进仓库）
> git clone --depth 1 https://github.com/longbridge/gpui-kit.git temp/gpui/gpui-kit
> curl -sL -o gpui-pre-windows.crate \
>   https://crates.io/api/v1/crates/gpui-pre-windows/0.3.11/download   # + 另三个 crate
>
> # §9：gpui-fast 主干（进 asaotui 工作区，已 .gitignore；取回命令同 asaotui/README「克隆后的准备」）
> git clone --depth 1 --filter=blob:none --sparse \
>   https://github.com/longbridge/gpui-fast.git asaotui/gpui-fast-src
> cd asaotui/gpui-fast-src
> git sparse-checkout set crates/gpui crates/gpui_windows crates/gpui_platform docs
> ```
>
> **行号口径**：§2–§8 的 `file:line` 相对 `gpui-pre-windows-0.3.11/src/`（`gpui/` 前缀者是上游主
> crate `gpui-pre-0.3.11/src/`），只对该 pin 死的快照有效，且**其快照已不在工作区，这些行号不再是
> 可当场复核的证据**（结论仍成立，要复核须先按上面第一段重新解包）。**§9 的 `file:line` 相对
> `asaotui/gpui-fast-src/crates/`**，本机可当场 `grep` 复核，§11 给了逐条命令与期望命中。
> 同一段 Windows 代码在两套源码里偏移几十行（例：`Present(0, DXGI_PRESENT(0))` 在 0.1.13 快照是
> `directx_renderer.rs:245`，在 fork 主干是 `:258`）——**不要把两边的行号混用**。
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
| 凭什么「快」？ | 上游的答案是「压批、少 draw call」；`gpui-fast` 的答案是「**整帧可以什么都不做**」——保留视图 + 保留布局节点 + 滚动层 tile。帧耗时与「这一帧窗口里变了多少」成正比，而不与「屏幕上有多少东西」成正比 | §9 |
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

## 9. `gpui-fast`：保留视图、滚动层，与 Windows 侧的按需帧

> **本节是重写。** 旧版只读了 `gpui-fast-windows 0.1.13` 的**打包快照**，看到的是 7 条互不相干的
> Windows 优化；fork 主干（`asaotui/gpui-fast-src`，`046a859`）是另一量级的东西：
> 一套 **Retained Mode**（保留视图 + 保留布局节点）+ 一套**滚动层**（tile 合成），
> Windows 侧的 D3D11 优化只是收尾。以下全部对主干源码复核过，行号口径见文首。

### 9.1 它怎么和上游共存（这决定我们能抄多少）

fork 自缚两条规则（`README.md`）：**API 不变**（为上游 GPUI 写的代码原样编过）；**上游代码只加 hook**。
后者由 `script/check-upstream` 机械强制——一个 hunk 新增超过 **8** 行、一个文件超过 **40** 行、或新增行
不调用 `fast/`，就判失败（例外逐条记在 `script/upstream-allowlist`）。`docs/architecture.md` 记录当时
30 个上游文件有差异，其中 `crates/gpui/src` 的 20 个合计 **+609 / −776 行**——**删得比加得多**，因为若干
方法体整体换成了「一行转发」。

代码落点（**旧版写错了位置**）：

| 位置 | 内容 | 体量（本机实测） |
|---|---|---|
| `crates/gpui/src/fast/` | 引擎侧全部逻辑：保留子树、依赖记录、布局节点、文本携带、滚动层、圆角裁剪、多 surface 合成 | `mod.rs` 列 25 个模块 + `tests/`；73 个文件 / **1.7 MB** |
| `crates/gpui_windows/src/fast/` | Windows 平台侧：按需帧、设备恢复、绑定去重、跨帧缓冲、圆角 mask、DComp 合成 | **14** 个文件 |
| 其余上游文件 | 只有字段、一行调用、方法体转发 | 见上 |

（0.1.13 打包版把 `src/fast/` **复制进每个 crate**；主干按所在 crate 分置。所以旧版那句「fork 只允许
自己改一个子模块 `src/fast/`」在主干上要读成「每个 crate 各有一个 `fast/`」。）

一条判断（旧版这句仍成立，但覆盖面被低估）：**上游解决「画什么」和「怎么批」，fast 解决「什么时候画」
和「哪一帧可以什么都不做」。**「重复绑定」只是「什么都不做」之外最小的一块。

### 9.2 保留视图：一帧能不能什么都不做

一帧走三趟：`request_layout`（渲染视图并索取布局）/ `prepaint`（算布局并摆元素）/ `paint`（转成场景
交给 GPU）。上游每趟都从头做。fast 把**每一个视图**（`Entity<V: Render>` 或 `AnyView`，不必显式缓存）
当「保留子树」：只要它没变、且画在同一位置，就**不 render、不 layout、不 prepaint、不 paint**，
而是把上一帧的图元、hitbox、监听器、dispatch 节点原样搬过来（`fast/retained.rs` 83 KB、
`fast/dependencies.rs` 1326 行负责「变没变」）。

「变了」的判据是**依赖记录**，比「谁 notify 了我」宽得多：

| 依赖 | 怎么记 |
|---|---|
| 读过的 entity | 渲染/布局/prepaint/paint 期间每一次访问都记（不要求 `observe`） |
| 读过的 global | 每个 global 一个 generation 戳；只问「有没有设置」（`has_global`）只依赖那一点，写值不算变 |
| `ListState` / `ScrollHandle` | 这两者自己带版本号，移动了就变——哪怕没人 notify |
| 窗口输入态 | `mouse_position()` / `modifiers()` / `capslock()` 的读取一样入账 |
| 画在哪 | bounds、content mask、text style、hover/交互态 |

两条容易踩的语义，源码里明写：①「**没有 notify 的 update**」（如 `cx.subscribe` 的处理函数里更新自订阅
者）只对「在被 notify 的视图内部绘制」的视图算变；②应用自己在 GPUI 之外读的状态（`Rc<RefCell<..>>`、
时间、`window.modifiers()` 的缓存值）**必须自己 `cx.notify()`**——这一条被写进 README 的「Using it」，
是这套机制唯一的契约缺口，也是它敢上生产的前提（明说，不静默）。

**为什么不干脆留一棵持久视图树**（`docs/architecture.md` §Why not a persistent tree）：identity 已经存在
（`GlobalElementId` 给元素状态、帧内 index range 给复用输出），taffy 本身就是一个带逐节点缓存的持久
节点库；再造一棵并行树等于复制身份并要求重构 window 的绘制代码，直接和「易合并上游」这条约束对着干。

运行时开关：`GPUI_VIEW_RETENTION=0` 每帧从头画，用来二选一「这是不是保留的锅」。

### 9.3 保留布局节点与文本

- **布局键**（`fast/layout_key.rs`）：从根往下的**路径 hash**（`LAYOUT_ROOT_SEED` @`:61`），元素在兄弟间
  移动时改用 `ElementId`；`root_index` 让 window root / prompt / drag / tooltip 几棵独立的树不撞键；
  prepaint 期另带一把 salt（`:66`）。
- **style 变没变**：**64 位指纹**。release 信任指纹，debug **全量比每个字段**——专门用来抓「指纹漏了
  某字段」（`docs/architecture.md` §Costs）。这一条对我们 `PaintKit.measureField` 是反向启发：字段只有
  11 个时全比即可（也才 11 次比较），字段一多才值得提指纹，并且**必须**保留一个 debug 期全比。
- **文本**（`fast/text.rs`）：已整形的行布局跨帧携带（宽度不变直接复用）；最近字形按 generation 记
  （`RECENT_GLYPHS_PER_GENERATION` @`:808`）。
- **数字整形**（`fast/number_shaping.rs`）：一个数字 = 逐字符 glyph+advance 加**相邻字符对的 kerning**，
  所以每个 font+size 只需平台整一次「单字符」与「字符对」，之后自己拼（字符集只有
  `0123456789.,+-%$KMBT`）。首 **32** 条与之后每 **256** 条仍交平台复核（`CHECKED_FIRST` @`:37`、
  `CHECKED_EVERY` @`:38`），不一致就永久退回平台。**这条正对我们的「流水数字每帧都是新字符串」**。
- **路径缓存** `path_cache.rs`：2048 条 / 16 MB（`:23`、`:29`）。**bounds 网格** `bounds_tree.rs`：
  64 px 单元（`:19`）、每轴最多 256 格。**字形原点量化** `glyphs.rs`：整像素滚动正好平移整像素。

### 9.4 滚动层：保留视图盖不住的那个缺口

保留视图只在**原位**复用。滚动一发生，容器里每个视图的位置都变了 ⇒ 全部重建；在 GPUI Kit 的组件画廊
里这约占一帧滚动成本的 **60%**。而「把输出搬个位置」不可行：输出里处处是窗口坐标（图元、hitbox、
监听器捕获的 bounds、元素状态），且上一帧视口外的东西**根本没画**，无从复制。

于是照 UIKit / Flutter / Chrome 做（`fast/layers/`，17 个文件约 340 KB）：容器的内容**画一次进 layer**，光栅化成
tile，只有 offset 变的帧按新 offset 合成 tile。每帧对每个滚动容器选三条路之一（`layers/policy.rs`）：

| 路 | 条件 | 发生什么 |
|---|---|---|
| **Composite** | 只有 offset 变，且视口仍在已画区域内 | 内容不 render/prepaint/paint；非场景记录整体搬过来，hitbox 平移；盖住视口的 tile 当 sprite 进场景 |
| **Repaint** | 内容变了，或滚到了已画区域边界 | 重画「视口 + 每个滚动方向 2 个视口」进 layer 自己的场景；**逐 tile 求 hash，只重烘 hash 变的 tile** |
| **Bypass** | 层无法保证结果（见下「同像素」） | 完全走今天这条路 |

关键常量（全部实测自源码）：`TILE_SIZE = 512`（`layers/paint.rs:42`）、`OVERSCAN_VIEWPORTS = 2`
（`paint.rs:862`）、tile 预算 **64 MB**（`policy.rs:55`）、连续滚 **2** 帧才给层
（`PROMOTE_AFTER_SCROLLED_FRAMES` @`:40`）、最近 16 帧里 **≥8** 帧内容变就降级（@`:43`）、稳定
**60** 帧后重提（@`:46`）、**120** 帧没被合成或窗口 resize/缩放就丢（@`:53`）。

tile hash 的定义是整个设计的枢纽（`layers/tiles.rs`）：hash 覆盖**够得到这块 tile 的图元**（含阴影的
blur、变换后的 sprite），按绘制序，搬到 tile 空间后计算；content mask 与 layer bounds 也**按 tile 裁剪
后再 hash**——否则新 offset 下「已画区域」整体平移，会把每一块都判脏（源码注释原话）。

**「必须同像素」的代价清单**（`docs/architecture.md` §The same pixels）——这才是把滚动层加进一个既有
渲染器的真实成本：

- **背景**：亚像素文字要知道自己压在什么上 ⇒ 只有视口整个落在**单色不透明 quad** 上才用层，把该颜色
  **烘进每块 tile**；渐变、半透明窗口、视口内有圆角 ⇒ Bypass。
- **像素网格**：滚动 offset 一律吸附到设备像素（有无层都一样），两条路才落同一网格。
- **裁剪**：layer 绘制期按**已画区域**裁剪，不是视口——否则 overscan 里的内容不会被画出来。
- **path 永不进 tile**：path 的 AA 取决于像素在 2×2 方阵里怎么配对，奇数像素位移会差一级灰度；
  所以 path 只在「没东西盖住它」时直接画在 tile 之上，否则 Bypass。

**渲染器契约**（`layers/scene.rs`，唯一对外的扩展）：核心只交两样东西——① 每块可见 tile 是**普通
polychrome sprite**，纹理 id 落在 atlas 永不分配的区间（`LAYER_TILE_TEXTURE_BASE = 0xF000_0000` @`:26`），
于是排序/裁剪/合批全归场景自己管；② `Scene.layers` 交出每层的 content scene、generation 与 dirty tiles。
渲染器负责留纹理、按 dirty 重烘（`LayerFrame::tile_scene`）、遇到 tile sprite 时绑那一块的纹理，
**没有任何东西回流到核心**。`layers/mod.rs:32` 的 `COMPILED` 只在这三个平台为真：Linux(wgpu)、
macOS(Metal)、Windows(D3D11)。

### 9.5 Windows 侧：`crates/gpui_windows/src/fast/`

| 文件 | 做什么 | 要点 |
|---|---|---|
| `frame_schedule.rs`（323 行） | **按需帧** | `FrameRequest{pending: AtomicBool}` + `FrameWake{mutex, condvar}`；`take_request()` 决定本窗口这一帧画不画，worker 线程 `DwmFlush` 对齐合成时钟后**只重画请求过的窗口** |
| `device_wake.rs`（93 行） | 不轮询地等设备丢失 | `RegisterWaitForSingleObject` 挂在 D3D11 设备移除事件上，醒来就 `notify` 调度线程 |
| `device_recovery.rs`（164 行） | 现场崩溃的两条路 | 上游把任何 resize 失败都当「丢设备」、重建再失败就 panic。fast 分流：`E_OUTOFMEMORY` ⇒ **下帧重试 resize**（设备好的）；`DXGI_ERROR_DEVICE_RESET` ⇒ 向平台要**新**设备，最多 **5** 次（`MAX_FAILED_RECOVERIES` @`:23`）；都没有时**跳过绘制**，不 unwrap |
| `draw_state.rs`（131 行） | 绑定去重 | 记 shader/blend/topology/SRV/sampler/常量缓冲，只绑变化；**每帧开头 `forget()`**，因为 DirectWrite 光栅化会在同一个 context 上改状态 |
| `frame.rs`（442 行） | 跨帧缓冲 | path 顶点与 sprite 的 `Vec` 留在 `FrameState`（同处还有 globals、`TileCache`、`rounded_masks`）；有 PIX 附加时仍走上游循环，保住每批的 label |
| `rounded_clip.rs`（272 行） | 圆角 scope 免 mask | 圆角 padding 边的几何写进 `D3D11_USAGE_IMMUTABLE` 的 `R32G32B32A32_FLOAT` 纹理，颜色 shader 直接求值；**不需要 mask render target、也不需要额外 pass** |
| `composition.rs`（24 KB）+ 引擎侧 `fast/composition.rs`（2379 行） | 多 surface | 一个窗口可有多个有序 surface，原生视图（WebView2/WKWebView/子面）夹在 GPUI base 与 overlay 之间；D3D11 侧每个 surface 一条 swap chain + 一个 visual 挂 DComp 根下。默认两条 surface（`DEFAULT_SURFACES = 2` @`:760`），是 opt-in（`enable_window_composition`） |
| `native_tests.rs`（20 KB） | 真窗口回归 | 一进程一 case（`GPUI_NATIVE_CASE=paint_race\|input_restore\|recovery`，`GPUI_NATIVE_DCOMP=0\|1`），用 `SendInput` + `GetUpdateRect` 断言；recovery 还要显式 `GPUI_TEST_ALLOW_GPU_RESET=1` |

Windows 渲染器本体（上游文件，未改逻辑）的可复核事实：`BUFFER_COUNT = 3`
（`directx_renderer.rs:1713`）、`CreateSwapChainForComposition` + `FLIP_SEQUENTIAL`（`:1339`/`:1335`）、
`Present(0, DXGI_PRESENT(0))`（`:258`，**不阻塞**）、`WS_EX_NOREDIRECTIONBITMAP`
（`window.rs:520`）、vsync 线程 `DwmFlush()`（`vsync.rs:37`）。

### 9.6 正确性怎么证明（这一节最该抄）

保留式 UI 的失效方式是「漏记一个依赖 ⇒ 该重建没重建」，定点测试抓不到。它的答案是**两条臂 + 同一部
随机史**：

- **oracle**（`fast/tests/oracle.rs`，1070 行）：两个窗口跑同一份随机变更历史，一个增量、一个**每帧
  忘光**。每帧比**完整场景**（quad/阴影/下划线/三色 sprite/path + 每个 hitbox 的 bounds、content mask、
  behavior）。还额外断言「增量那个**确实复用到了**」——否则它可以靠「什么都不保留」通过。
- **layers oracle**（`fast/tests/layers_oracle.rs`）：随机滚轮（含小数 delta 与小数缩放）、程序滚动、
  hover、点击、按键、内容变化；每帧把每层的 tile **展开成图元**再和「没有层」那臂比，另比随机点
  hit test 与监听器观测到的坐标。
- **渲染器像素门**：把 tile 的光栅化/合成结果与「直接画」在**真设备**上逐字节比（wgpu/Metal/D3D11 各自 CI）。
- **`gpui_perf --headless --verify`**：同一场景开/关保留**锁步**跑，逐帧比 quad、文字、图标、图片、
  下划线（不比 path 与阴影，那归 oracle）。
- 运行时开关：`GPUI_VIEW_RETENTION=0`、`GPUI_SCROLL_LAYERS=0` 分别关掉两层。

这套方法能证明的是「在这些状态变更序列上，保留输出 = 从头画的输出」；它**证明不了**应用在 GPUI 之外
读的隐藏状态（README 明说）。这个边界划得很干净，值得照抄进我们的门禁设计。

### 9.7 数据、代价，与两处「文档与代码不一致」

**保留视图**（Linux release、headless、`retained_bench`，60 个面板 × 每面板 64 个标签）：

| 每帧被 notify 的面板数 | 从头画 | 保留 | 出处 |
|---|---|---|---|
| 0 | 10.43 ms | **0.25 ms**（−98%） | `README.md` |
| 1 | 11.58 ms | 1.35 ms（−88%） | `README.md` |
| 6 | 13.06 ms | 3.86 ms（−70%） | `README.md` |
| 60（全变） | 18.25 ms | 14.57 ms（−20%） | `README.md` |

`docs/architecture.md` §Results 里有同一实验的**另一组绝对值**（3.31→0.19、6.72→0.71、7.27→1.46、
10.33→7.38 ms），百分比一致、量级不同——**两处显然是不同机器/不同日期的两次跑**。转述时必须带出处，
不要把它们拼成一张表。

**滚动层**（`gpui_perf --headless`，真实滚轮事件，两栏都开着保留视图）：24 节按钮的页面
0.618 → **0.068 ms**（−89%）；同一页由滚动视图自己画 0.599 → 0.226 ms（−62%）。GPUI Kit 组件画廊滚
Button story @145 Hz：只开保留视图占 27–28% 一个核，加滚动层 **18–20%**（每帧 1.53–1.63 ms →
0.92–1.02 ms）。

**代价（照抄时必须一起抄）**：hook 平均 +**0.85%** 指令数（最坏 +2.7%）；重画一帧 layer 要画 **5 个
视口**（5–6.5 ms，对照无层 0.6 ms），每滚两屏发生一次；tile 上限 64 MB；每保留子树每帧一条记录 +
taffy 节点常驻。

**两处不一致（本机实测，照实记）**：

1. `crates/gpui/src/fast/layers/lists.rs:78` 是 `LIST_LAYERS = true`，而 `docs/architecture.md` §Lists 仍
   写「列表的层是关的」。**代码为准**：列表层已开（行级记录、overscan、prepaint 期预判 hover 只重建
   hover 变了的行）。这正好提醒我们：它自己的文档会漂，引用数字/开关时先 `grep` 代码。
2. 上面两张表的绝对值不一致（见上）。


---

## 10. 对我们（Win32 + SDL2 + Skia D3D12）的取舍

现状见 [`win32.md`](win32.md)：`CreateSwapChainForHwnd`（`FLIP_DISCARD` + `R8G8B8A8_UNORM` +
`Scaling = NONE`）→ `SkSurfaces::WrapBackendRenderTarget` → Ganesh D3D12 → `Present(1, 0)`。

| 结论 | 内容 | 理由 |
|---|---|---|
| **该借** | **DirectComposition 这条链**：`WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition`（`PREMULTIPLIED`）+ visual 挂根 | 它直接填掉我们 `win32.md` 核对表第 24 行那个缺口：**`<transparent>` 在 Windows 未实现**。旧思路（`WS_EX_LAYERED` + 逐帧 `UpdateLayeredWindow` alpha）要 CPU 回读或额外 D3D 目标，而 DComp 让 DWM 用 GPU 合成，且顺带解决圆角窗（`DWMWA_WINDOW_CORNER_PREFERENCE`）/阴影边界。**这是本文对我们最高价值的单点** |
| **该借（需评估）** | Present 解耦：独立 `DwmFlush` 线程 + `Present(0,0)` | 我们 `Present(1,0)` 把 UI 线程锁在 vblank 上；拖动/resize 时 `win32.md` §2.8 已经证明帧只能靠 SDL event watch 驱动。解耦能否改善帧时间分布，需实测（`ASC_GPU_STATS=1` 现成口径）。风险是 tearing 与一帧延迟，而 AIR 的 `frameRate` 语义是**应用自己的节拍**，未必需要跟合成器锁死——这一点得先确认 `adl` 行为再动 |
| **该借（轻）** | 3 个 back buffer | 我们 `win32.md` §2.x 已记录 `BufferCount=2` 在合成器搬窗时会同时扣住两个 buffer → 提交卡顿。gpui 用 3 |
| **该借（新，本轮最便宜）** | **oracle 式回归**：同一份输入跑两条臂（保留 / 每帧强制全忘），逐帧比完整结果，并断言「保留臂确实复用到了」 | 我们的 CheckUi 37 项是**定点钉子**，只能证明「我想到的那条路对」；保留式 UI 真正的失效模式是「漏记一个依赖 ⇒ 该重建没重建」，只有随机史抓得到（§9.6）。落到 asaotui 上：同一棵描述树跑两遍 reconcile，比 UiNode 树形 / rect / 绘制序；主动臂还要断言「确实没重建」——否则会靠「全重建」通过。现成的 `probes/frame` 加一个 env 开关就能做 |
| **该借（性能，kit 侧，可当场量化）** | **保留布局**：布局节点各自保留缓存（样式指纹 + 子尺寸 + 可用尺寸），只重算脏路径与它的祖先。我们 `seam/asaot/ui/as3/As3LayoutEngine.as:449-450` 自己写着「The subset recomputes on every calculate, so dirty tracking is a no-op」——`grep -n "recomputes on every calculate"` 可当场复核 | 实测 `text:1000`（1000 行只改一行）solve **1.29 ms/帧**，其中 999 行完全不该重算；taffy 的 per-node cache 省掉的正是这一块。`idle` 的 17 ms 是 vsync 地板，所以这 1.29 ms 是**叠在地板上的纯增量** |
| **该借（性能，kit 侧，最大一档）** | **保留视图**：读过的依赖没变、画在同一位置 ⇒ 整个子树跳过 render / prepaint / paint。我们缺的是「哪些行没变」的**来源**——它靠 entity 读追踪自动拿到，我们只能要求 widget 声明依赖键（ListState 版本、选中项、hover） | 实测 `text:1000`：render 0.66 + reconcile **2.50** = **3.16 ms/帧**花在 999 个没变的行上，这就是它那 −98% 的来源。**代价要一起看**：它自己的「全变」档只 −20%（10.33→7.38 ms），所以 `all:1000` 的 51 ms 不能指望这一招 |
| **该借（编译器侧，最值钱）** | 把同一套 oracle 移给 **auto-bake 增量**：一条臂走 patch、另一条每帧全量 `rebuild`，同一份随机变更史逐像素比，并断言「patch 臂确实 patch 了」 | 真机日志（335 秒：`bake_patch=0` / `bake_rebuild=5263`；180 秒复采：`patch=0` / `rebuild=52`，中间 125 秒零事件）。但 `bake_patch` 恒为 0 是**结构性**的、不是没测到：`as_render_cached` 里 auto-bake 一旦脏就清 `_cache_surface` 落到 live，只有显式 `cacheAsBitmap`（`_cache_flag`）才保留 surface 走 patch（`repaint-boundary.md` §5 阶段 B/C 的取舍）。所以这条 oracle 的前置是「让 auto-bake 也保留 surface」（阶段三百八十一候选）。没有这条门，漏记一个依赖的代价就是静默花屏 |
| **已具备（原写成缺口，2026-11-07 逐行复核后修正）** | `device_recovery` 的四条规则，我们**已有三条半**：① `E_OUTOFMEMORY` 不按设备丢失处理——`vendor/d3d_glue.cc:591-600` 的注释与 `:882-899` 的 `d3d_hr_is_device_lost()` 分支，只重建**本窗口**的 swapchain 并按 250 ms 节流重试（`ASC_GPU_RESIZE_FAIL=1` 可注入，`:878`）；② 丢失期间跳帧不画——`d3d_mark_lost()` 之后 `sk_gpu_begin_frame` 返回 `nullptr`（`:833`）；③ 无设备时退避重试而非 panic——250→4000 ms 指数退避（`:661`）；④ 三 back buffer——`SK_D3D_NUM_FRAMES 3`（`:174`） | 唯一真差异是它「最多 5 次」有硬上限，我们无限退避且不 panic，**语义上更安全，不需要改**。这一行原先写的是「我们只有 `DXGI_ERROR_DEVICE_RESET` 一条路」——那是把 `win32.md` §3.13 当成了全量清单，实际代码早就把两条路分开了 |
| **该借（评估，成本最高）** | **滚动层**（tile + 三条路 + 渲染器契约） | 这是「列表滚动掉帧」在**渲染层**的正解，但它不是「加个缓存」：单色背景、path 不进 tile、offset 吸附设备像素、裁剪按已画区域——四条全是渲染器契约（§9.4）。kit 侧的每帧固定成本已压到 1.0 ms（`asaotui/STATUS.md` §3.21），**剩下的大头就是「大面积重画」本身**，正好是它解的；但落点在 `as3compiler` 渲染层（L1），不在 kit |
| **记一笔（可直接用）** | `number_shaping.rs`：一个数字 = 逐字符 glyph/advance + 相邻字符对 kerning，自己拼；首 32 条与之后每 256 条回平台复核 | 我们的流水数字（价格/倒计时/礼物计数）每帧都是新字符串 ⇒ 每帧重新整形。我们不涉 ligature，但**平台复核那一步不能省**，否则字距漂移会静默错 |
| **记一笔** | 按需帧：我们的等价物是 `wantsPaint` 门 + 静态窗口跳 raster/Present；它多出来的一层是「UI 线程完全睡（`FrameRequest` + condvar），只在有人请求时醒」 | 两者同向且都不降逻辑帧率。它的版本在「窗口存在但没人要帧」时能把 CPU 降到近零，而我们的比较像素法得先跑一遍判定。是否要学它把门提到「驱动层」，得先实测 idle 帧 CPU 与 `ASC_FRAME_STATS` 的 p99，不是白拿 |
| **不借** | `DrawState` 这种「绑定去重」 | 我们不下到 D3D11 绑定层，状态由 Skia Ganesh 管，同状态相邻批次它自己就会合并。这一条只有自己写 primitive 管线的人才能省到 |
| **不借** | 自建 primitive 管线（8 类 primitive、实例缓冲、结构化缓冲、自写 AA） | Skia 已经在 Ganesh 里做了批合并、字形图集、analytic AA、SDF；复刻等于把 Skia 拆掉重写。gpui 之所以自建，是因为它**不背 Skia 那样的通用 2D API 义务**，可以只做 8 种图元 |
| **不借** | DirectWrite 字形光栅化的**具体实现** | 我们的文本栈已经外包给 Skia（含字形缓存/图集），重复实现一套只会带来第二个校准口径。但它的**两个约束值得记**：① 字形位图必须按像素格式分图集（灰度 vs 3×1 vs RGBA）；② 亚像素相位必须进缓存键 |
| **不借** | GPU adapter 选择策略 | 它"取第一个可用 adapter、无 WARP 回退"，在混合显卡机器上会落 iGPU——我们 `win32.md` 的枚举+D3D12 探针选型更稳 |
| **记一笔** | ClearType 仿真路线 | 若将来我们要在透明窗/动画上做亚像素文字，正确形态是"覆盖率位图 + shader 内 gamma/对比度校正"，不是调用系统 ClearType |

---

## 11. 复核方法

§9 的每一条都能在本机**当场**复核（源码已在本工作区，不必构建 Rust）：

```sh
cd asaotui/gpui-fast-src        # 046a859；取回命令见文首

# —— 引擎侧：保留、滚动层、文本 ——
grep -n 'pub(crate) const COMPILED'      crates/gpui/src/fast/layers/mod.rs            # 期望 :32，仅 linux/macos/windows
grep -n 'TILE_SIZE: u32\|OVERSCAN_VIEWPORTS' crates/gpui/src/fast/layers/paint.rs      # 期望 512 / 2.
grep -n 'TILE_BUDGET_BYTES\|PROMOTE_AFTER\|DEMOTE_AFTER\|DROP_AFTER' crates/gpui/src/fast/layers/policy.rs
grep -n 'LAYER_TILE_TEXTURE_BASE'        crates/gpui/src/fast/layers/scene.rs            # 期望 0xF000_0000
grep -n 'const LIST_LAYERS'              crates/gpui/src/fast/layers/lists.rs            # 期望 true（其 architecture.md 还写 off）
grep -n 'CHECKED_FIRST\|CHECKED_EVERY'    crates/gpui/src/fast/number_shaping.rs         # 期望 32 / 256
grep -n 'KEPT_BYTES'                     crates/gpui/src/fast/path_cache.rs              # 期望 16 MiB

# —— Windows 侧 ——
grep -n 'take_request'                   crates/gpui_windows/src/fast/frame_schedule.rs
grep -n 'MAX_FAILED_RECOVERIES'           crates/gpui_windows/src/fast/device_recovery.rs  # 期望 5
grep -n 'D3D11_USAGE_IMMUTABLE'           crates/gpui_windows/src/fast/rounded_clip.rs
grep -n 'BUFFER_COUNT'                   crates/gpui_windows/src/directx_renderer.rs     # 期望 3（:1713）
grep -n 'Present(0'                      crates/gpui_windows/src/directx_renderer.rs     # 期望 :258
grep -n 'NOREDIRECTIONBITMAP'             crates/gpui_windows/src/window.rs               # 期望 :520
grep -rn 'D2D\|Direct2D'                 crates/gpui_windows/src                          # 期望：零命中
```

**§2–§8 的行号当前不可复核**（那份 `0.1.13` / `0.3.11` 快照已不在工作区）：结论仍然成立，但要逐行核对得
先按文首第一段重新解包。

想验证「保留 = 从头画」这套保证，不必开窗口：`cargo test -p gpui fast::tests::oracle`（需 Rust 工具链，
本机**没跑**——本文的数字全部转自其 `README.md` / `docs/architecture.md`，已逐处标注出处，没有一条是
我们自己测出来的）。

要真机看行为，最小的观察点仍是两条：`GPUI_DISABLE_DIRECT_COMPOSITION=1` 前后窗口透明/缩放表现差异；
以及 PIX 抓一帧看批量（`ID3DUserDefinedAnnotation` 的 label 会显示成每批一个事件）。另外三个运行时开关
值得先知道：`GPUI_VIEW_RETENTION=0`、`GPUI_SCROLL_LAYERS=0`、`GPUI_NATIVE_CASE=paint_race|input_restore|recovery`。
