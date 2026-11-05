# yuv420-gpu — setYuv420 GPU 直渲 BT.601 逐像素验色（E20）

`BitmapData.setYuv420`（E20，`--features yuv420`）的 GPU 直渲验色。构造已知 I420 纯色帧，
`setYuv420` 后通过 `Bitmap` 显示对象 `draw` 采样，断言颜色 = BT.601 视频范围公式（容差 ±2）。

对应文档：[docs/zh-cn/yuv-direct-render.md](../../docs/zh-cn/yuv-direct-render.md) §验收。

## 构建

```sh
node src/index.ts --air-app examples/yuv420-gpu/app.xml --main-class Main \
  --features yuv420 --target native -o temp/yuv420-gpu
```

要求 macOS + Metal（`app.xml` 的 `<renderMode>direct</renderMode>`）+ vendor/skia、sdl2。
`--features yuv420` 映射 `-D ASC_USE_YUV420=1`，与 `renderMode=direct` 映射的
`-D ASC_RENDER_METAL=1` 叠加，`as_skia_gr_context()` 走 `sk_metal_get_context()`。

## 运行与判定

```sh
./temp/yuv420-gpu
```

验色在窗口创建后的首帧执行，结束后 `System.exit(0/1)` 退出。判定口径：

- **PASS**：每个 BT.601 颜色采样 RGB ≈ 期望（每分量 ±2），输出 `yuv420-gpu: OK`，退出码 0。
- **FAIL**：CPU 后端（无 Metal context）时 `as_bmd_live_image` 返回 NULL → 黑屏，非黑颜色
  采样为 0，非黑断言失败（退出码 1）。这正是要区分的「GPU 直渲」与「CPU 黑屏」两态。

## 实测（2026-11-06，macOS arm64 + Metal）

```
metal_glue: window 0 layer bounds=200x200 contentsScale=2 gravity=topleft
yuv420-gpu: sampling BT.601 colours through the GPU YUV path
  black   YUV(16,128,128) -> RGB(0,0,0) expected (0,0,0): PASS
  white   YUV(235,128,128) -> RGB(255,255,255) expected (255,255,255): PASS
  grey    YUV(128,128,128) -> RGB(130,130,130) expected (130,130,130): PASS
  red     YUV(81,90,240) -> RGB(255,0,0) expected (254,0,0): PASS
  green   YUV(145,54,34) -> RGB(0,255,1) expected (0,255,1): PASS
  blue    YUV(41,240,110) -> RGB(0,0,255) expected (0,0,255): PASS
yuv420-gpu: OK (GPU BT.601 direct render verified)
```

红色采样 255 vs 期望 254 是 GPU shader 的 8-bit 量化舍入（±1 LSB），在 ±2 容差内，属预期。
中性灰恰好 130，证明亮度映射（`1.164×112=130.4→130`）与 BT.601 系数精度对齐。
