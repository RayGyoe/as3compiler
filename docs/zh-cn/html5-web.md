# HTML5 / Web 渲染 — 实现与使用

> 本文回答：**如何把 AS3 程序编译成浏览器里的 HTML5 渲染视图，以及背后的实现约束。**
> 目标组合：`--target wasm --package web`。定位：`compile.md`（多目标构建）与
> `skia.md`（渲染后端）的浏览器化补充。
>
> 状态：**已实现并端到端验证通过**（蓝色矩形 + `TextField` 文字 + 运行时字体注入，
> 浏览器 canvas 内正常渲染，无运行期崩溃）。

---

## 1. 目标与产物

`--target` 定机器码 ABI，`--package` 定分发形态，二者正交。浏览器目标表述为
`--target wasm --package web`，用 Emscripten `emcc` 编译，产出三件套：

| 产物 | 说明 |
|---|---|
| `<base>.html` | 页面入口：`<canvas>` + 字体注入引导脚本（`index.ts` 生成，非 emcc 默认 shell） |
| `<base>.js` | Emscripten JS 胶水（加载 wasm、提供 `Module` 运行时） |
| `<base>.wasm` | wasm32 机器码（Skia CPU 光栅 + 生成的 C + web 胶水层） |

对比其他组合：

| target | package | 后端 | 产物 |
|---|---|---|---|
| wasm | raw（默认） | wasi clang `--target=wasm32-wasip1` | 裸 `.wasm`（WASI 命令行模块） |
| wasm | **web** | emcc（Emscripten） | `.wasm` + `.js` + `index.html` |
| native | raw | cc | 裸可执行文件 |
| native | xcode-project | 生成 Xcode 工程 | macOS `.app` 工程 |

`web` 硬性要求 `target=wasm`（`src/index.ts` 分派时校验）；`--target wasm --package raw`
保持现状（WASI 命令行模块，`examples/wasm-native/` 的 shim 即加载它）。

## 2. 快速开始

```bash
# 需要 Emscripten SDK（提供 emcc）+ wasm 版 Skia（vendor/skia/lib/wasm/）
export EMSDK_HOME=/path/to/emsdk

as-aot examples/web/hello-web.as \
  --manifest examples/web/hello-web.build.json
```

产物生成在 `examples/web/` 下：`hello-web.html` + `hello-web.js` + `hello-web.wasm`。
浏览器不能 `file://` 直接加载 wasm，需经 HTTP 服务（`python3 -m http.server` 等），
打开 `hello-web.html` 即可看到蓝色矩形 + `TextField` 文字。

AIR 项目（`--air-app`）同样支持 web 目标，一条命令从 `app.xml` 编到浏览器，无需手写 manifest：

```bash
as-aot --air-app examples/air-native/air-native-app.xml --target wasm --package web
```

`--air-app` 适配器会自动切到 web 后端（`web_glue.cc` + wasm 版 Skia，去掉 SDL2/`objc`/Cocoa
framework）。字体来自 app.xml 的 `<embedFonts>`（读每个 `<font><fontPath>` 生成 `font-urls`，
缺省时回退到 `fonts/Arial.ttf`），产物为 `air-native.html` + `.js` + `.wasm`。

`<initialWindow><renderMode>` 控制 GPU/CPU 渲染分工（web 目标）：

| renderMode | 构建清单 define | 光栅化后端 | 呈现路径 |
|---|---|---|---|
| `auto`（缺省）| 无 | CPU（`SkSurfaces::Raster`） | `putImageData` |
| `cpu` | 无 | CPU（`SkSurfaces::Raster`） | `putImageData` |
| `direct` | `ASC_RENDER_GPU=1` | **GPU（Ganesh `GrDirectContext` + WebGL2）** | `GrDirectContext::flush` |
| `gpu` | `ASC_RENDER_GPU=1` | **GPU（Ganesh `GrDirectContext` + WebGL2）** | `GrDirectContext::flush` |

`direct`/`gpu` 均走完整 GPU 光栅化（效率优先，不对齐 AIR 官方「direct = CPU 合成 + GPU blit」
的分割）：Skia surface 由 `SkSurfaces::Raster` 换成 Ganesh 后端，直接渲染进 WebGL2 默认
framebuffer（FBO 0），整帧在 GPU 上合成（字形 atlas、渐变、滤镜全变 GPU 纹理/draw），
present 只是 `GrDirectContext::flush()`，不再有 CPU↔JS 逐像素拷贝。这去掉了 CPU 软件光栅化
瓶颈——之前该瓶颈把 web 锁在 ~60 fps。

示例 manifest（`examples/web/hello-web.build.json`）要点：

```json
{
  "target": "wasm",
  "package": "web",
  "sources": ["../../vendor/skia_glue.cc", "../../vendor/web_glue.cc"],
  "include-paths": ["../../vendor/skia"],
  "link-libs": ["skia", "skparagraph", "skshaper", "skunicode", "skcms",
    "wuffs", "png", "jpeg", "webp", "webp_sse41", "freetype2", "harfbuzz", "icu"],
  "link-paths": ["../../vendor/skia/lib/wasm"],
  "defines": ["ASC_USE_SKIA=1", "ASC_USE_WINDOW=1"],
  "font-urls": ["fonts/Arial.ttf"]
}
```

字段差异（对照 native 清单）：

- **不链接 `zlib`**：web 链接用 `-s USE_ZLIB=1`，Emscripten 同时提供 zlib 头文件与符号；
  显式 `-l zlib` 反而可能冲突。
- **新增 `font-urls`**：字体字节流 URL 列表，见 §4。

## 3. 实现架构

复用 `vendor/skia_glue.cc` 的 `extern "C"` 平坦接口（生成的 C 只调 `sk_*` 符号，渲染
像素逻辑与 native 完全一致）。浏览器侧的差异集中在两个胶水文件：

| 关注点 | native | web |
|---|---|---|
| 图形光栅化 | `SkSurfaces::Raster`（CPU 离屏） | 同左；`renderMode=direct/gpu` 时用 Ganesh（`GrDirectContext` + WebGL2） |
| 字体后端 | `SkFontMgr_New_CoreText()`（枚举 macOS 系统字体） | `SkFontMgr_New_Custom_Data()` + 运行时注入（§4） |
| 窗口 / 上屏 | SDL2 `SDL_PollEvent` 阻塞循环 | `vendor/web_glue.cc`：cpu 模式 `putImageData` blit；direct/gpu 模式 `GrDirectContext::flush` |
| 帧驱动 | SDL 事件循环 | `emscripten_set_main_loop`（内部 `emscripten_get_now` 节流） |
| 输入 | SDL 事件 | `emscripten_set_mousedown_callback`/`mouseup`/`wheel` |

`vendor/web_glue.cc` 保持与 `window_glue.cc` 相同的 `extern "C"` 签名
（`sk_window_*` / `sk_surface_peek_pixels` 等），因此生成的 `.c` **无需任何改动**
即可在 native 与 web 两个后端间切换。

### 3.1 上屏：premultiplied alpha 直贴 canvas

`present_frame` 用 `EM_ASM` + `putImageData`，从 `sk_surface_peek_pixels` 取像素直接贴
canvas。像素是 premultiplied alpha：**不透明像素精确**；半透明像素有色差（canvas 语义
与 Skia 的 premultiplied 差异），是已知限制（§6）。

## 4. 字体：网络加载 + 运行时注入

wasm 沙箱没有系统字体可枚举，`CoreText` 后端不可用。web 字体链路：

1. 页面 JS 在 `Module.onRuntimeInitialized` 里对 `font-urls` 逐个 `fetch` 字节流；
2. `Module._malloc` 分配 wasm 内存，`HEAPU8.set` 写入字节；
3. `Module._sk_fontmgr_register_data(ptr, len)` 注入 Skia；
4. 全部注入完成后才 `Module._main()`（首次渲染前字体必须就位）。

Skia 侧（`skia_glue.cc` 的 `#ifdef __EMSCRIPTEN__` 分支）：

- 全局 `g_font_datas` 累积注入的 `SkData`；`sk_fontmgr_register_data` 每次注入后清空
  `g_fontmgr_cache`，下次构造 manager 时重新扫描。
- `sk_platform_fontmgr()`：无字体 → `SkFontMgr_New_Custom_Empty()`；有字体 →
  `SkFontMgr_New_Custom_Data(g_font_datas)`，用 FreeType 扫描每份字体数据，构建
  family→typeface 表，`matchFamilyStyle` / SkParagraph 由此按名找到注入字体。
- `sk_fontmgr_register_data` 用 `EMSCRIPTEN_KEEPALIVE` 导出给 JS。

> 注入顺序约束：`sk_default_typeface()` / `sk_textlayout_collection()` 是函数局部 static
> 缓存，首次调用即固定。字体必须在其首次调用前注入——HTML 引导脚本保证了这一点
> （先注入、后 `_main()`）。

## 5. 关键实现约束（编译期/链接期）

这些是「链接 wasm 版 Skia」的固有要求，已固化进 `build.ts` 的 web 编译逻辑，用户无需手写：

### 5.1 `SK_TRIVIAL_ABI` 必须与 libskia.a 匹配

wasm 版 `libskia.a` 以 `is_trivial_abi=true` 编译（`gn/BUILDCONFIG.gn` 默认），`sk_sp`
带 `[[clang::trivial_abi]]`。C++ 胶水层（`skia_glue.cc`/`web_glue.cc`）编译时必须带同一
define `-D SK_TRIVIAL_ABI=[[clang::trivial_abi]]`，否则每个 Skia 调用 ABI 不匹配——
wasm-ld 会报 `function signature mismatch` 警告，且**运行期 `unreachable` 崩溃，编译期不报错**。
`build.ts` 已对 C++ 源自动加该 define。

### 5.2 `EXPORTED_FUNCTIONS` 导出字体注入入口

页面 JS 需要调用 `_malloc`/`_free`/`_sk_fontmgr_register_data`/`_main`。Emscripten 默认只
导出 `_main` 与 `EMSCRIPTEN_KEEPALIVE` 符号，`_malloc`/`_free` 不在内；一旦显式写
`EXPORTED_FUNCTIONS` 又会**覆盖**默认导出（`_main` 消失）。故 `build.ts` 一次性导出：

```
-s EXPORTED_FUNCTIONS=["_main","_malloc","_free","_sk_fontmgr_register_data"]
```

漏掉 `_malloc`/`_free` 会让字体注入静默失败（`Module._malloc is not a function`），文字
渲染为空；漏掉 `_main` 则 `INVOKE_RUN=0` 下无人启动 main。

### 5.3 Number→int 强制转换必须走 `as_to_int32`（wasm 下 `(int)NaN` 会 trap）

AS3 的 `int(x)` 与隐式 `Number→int` 强制转换是 ECMA-262 §9.5 的 `ToInt32`：`NaN`/`±Infinity`
映射为 0，有限值截断并回绕 32 位。直接生成 C 的 `(int)x` 对 `NaN`/`Infinity` 是**未定义行为**——
native（x86）碰巧给出垃圾值（如 `-16`），wasm 下则触发 `unreachable` trap 使整个程序崩溃
（`air-native` 完整 demo 的 `Timer.repeatCount = NaN` 断言即因此崩溃）。

修复：`runtime.ts` 提供 `as_to_int32(double)` / `as_to_uint32(double)` 助手（`isnan`/`isinf` → 0，
`fmod` 回绕 2^32），`emit.ts` 的 `convert`/`toInt32Expr`/`toUint32Expr` 对 `number` 源一律改用
这两个助手，替换所有 `(int)`/`(unsigned int)` 强制转换。这保证 native/wasm/web 三个后端对同一份
AS3 的 `Number→int` 结果一致（如 `t.repeatCount = NaN` 统一存为 0）。

## 6. 已知限制

1. **依赖网络与字体体积**：字体运行时 `fetch`，离线/内网不可用；整包 CJK 字体体积大，
   首次渲染前需等待下载 + FreeType 扫描完成（大 `.ttc` 集合扫描较慢，示例用 773KB 的
   Arial 演示英文，CJK 场景建议按需替换更小的字集）。
2. **半透明上屏有色差**：premultiplied alpha 直贴 canvas，不透明精确、半透明有色差（§3.1）。
3. **`emscripten_set_main_loop` 阻塞**：与 SDL 事件循环同理，帧循环由浏览器驱动，程序
   在页面关闭前不会从 `stage.showWindow` 返回。
4. **WASI 组合未变**：`--target wasm --package raw` 仍是 WASI 命令行模块，不含渲染；
   浏览器渲染只经 `--package web`。

## 7. 工具链复用

`build-tools/` 下已就绪且保留不清理：`emsdk/`（Emscripten 3.1.44）、`skia-src/`
（chrome/m124 源码 + 依赖，GN args 见 `out/wasm/args.gn`）、`out/wasm/`（wasm32 编译产物，
已拷贝至 `vendor/skia/lib/wasm/`）。复现 wasm 版 Skia 见 `skia.md` §7 与
`build-tools/skia-src/out/wasm/args.gn` 内注释。
