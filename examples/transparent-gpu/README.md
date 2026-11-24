# transparent-gpu — GPU 透明窗（阶段四百五十八 macOS / 四百五十九 Windows）

`<transparent>true</transparent>` + `<renderMode>direct</renderMode>`：让未画区域真正透出桌面。
macOS 走 Metal（§6.19），Windows 走 D3D12 离屏渲染目标 + 读回 → `UpdateLayeredWindow`（§6.20）。
**AIR 支持这个组合**（`adl 51.4.1` 实测），所以它是对齐项而不是增强。

对应文档：[docs/zh-cn/skia.md](../../docs/zh-cn/skia.md) §6.19（macOS）/ §6.20（Windows）。

## 构建

```sh
node src/index.ts --air-app examples/transparent-gpu/app.xml --main-class Main \
  --target native -o temp/transparent-gpu
```

要求 macOS + Metal + vendor/skia、sdl2。生成的 `transparent-gpu.build.json` 已入 `.gitignore`
（`--air-app` 每次重写它，见 `docs/zh-cn/compile.md` §4 的「撞名」告知）。

回归里本例只做**编译 + 链接**：GPU 窗口不能无头跑，判定要真窗口抓图。

## 运行与判定

```sh
./temp/transparent-gpu &                 # 窗口固定在 (120,120)，300x200 点
python3 temp/transgpu/probe.py ./temp/transparent-gpu temp/transgpu/cap.png
```

抓图用 `screencapture -x -o -l <windowid>`（窗口自己的内容，带 alpha；窗口 id 由
`CGWindowListCopyWindowInfo` 按 pid 找）。判定看**整幅图的 alpha 直方图**，而不是某个采样点：

| 区域 | 期望 |
|---|---|
| 左 1/3（不透明红） | alpha 255 |
| 中 1/3（50% 蓝） | alpha 127 |
| 右 1/3（未画） | **alpha 0** |

`requestedDisplayResolution=high` 下 300x200 点 = 600x400  device px，三带各 200x400：

```
alpha values: [(0, 80000), (127, 80000), (255, 80000)]
```

**修好之前**实测是 `[(255, 240000)]`——整幅不透明，未画区 `(0,0,0,255)` 纯黑，50% 蓝被合成到
黑底上变成 `(0,0,122,255)`。`adl 51.4.1` 同一份描述符给出的就是上面那组 80000/80000/80000。

> RGB 数值会与 adl 差一截（我们 `(234,51,35)` vs adl `(255,0,0)`）：抓图落在显示器的 P3 空间，
> 而我们给 layer 打了 sRGB 标签、adl 没打。那是既有的色彩空间口径（`metal_glue.mm` 的 Ed26
> 注记），**不在本例判定内**——本例只判 alpha。

## 两条缺一不可的平台步骤

见 `vendor/window_glue.cc::sk_mac_apply_gpu_transparent`：① Metal 视图建好**之后**重跑一次
`sk_window_apply_transparent`（否则 `SDL_cocoametalview` 的 `-isOpaque` 没被 swizzle）；
② contentView 改成 layer-hosting + 非 opaque 容器层（SDL 的 SDLView 每帧把 backing 刷成不透明黑）。
四态 A/B 实测：只做其中任何一条都仍是全不透明。

## Windows（D3D12，阶段四百五十九）

Windows 的根因与 macOS 不同：**flip-model 交换链的 `Present` 装的不透明 DirectComposition 子视觉
会压倒分层窗的 ULW 图像**（实测 ULW 返回 TRUE、读回像素 alpha 正确，屏幕却是不透明黑）；而跳过
`Present` 又挂设备（`DXGI_ERROR_DEVICE_HUNG`）。修法是透明 GPU 窗渲染到**离屏渲染目标**、交换链闲置
不 Present，每帧读回成预乘 BGRA 交给 CPU 路径同一套 ULW（`vendor/d3d_glue.cc::d3d_present_transparent`
+ `window_glue.cc::sk_window_present_layered_pixels`）。详见 §6.20。

Windows 抓图不能用 macOS 的 `screencapture -l`（flip-model 交换链内容 GDI 不可截，但修好后走 ULW
的分层窗**可以** GDI 截）：用固定坐标 `CopyFromScreen`（窗口固定在逻辑 (120,120)，150% DPI 下物理
(180,180)、450x300）。判定同样是三带 alpha：左红 255 / 中蓝 127（桌面文字透过蓝带可见）/ 右未画 0
（桌面直接透出）。**不透明 GPU 零回归**（仍走交换链 Present）；**读回开销可忽略**（透明与不透明帧率
在 24/60 fps 下相等）。钉：`unit: platform/TransparentGpuWin` 16。