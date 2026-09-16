# as-aot 编译指南

> 本文说明 `as-aot`（as3compiler）的完整编译流程、命令行参数、构建清单与多目标后端。
> 面向想要**编译、链接、产出可执行文件（或 WASI `.wasm`）**的使用者与协作者。

## 安装

`as-aot` 作为 npm 包发布（包名 `as3compiler`），安装后命令 `as-aot` 自动加入 PATH：

```bash
# 从 npm registry 全局安装
npm install -g as3compiler

# 或本地开发：在项目目录建立全局符号链接（等价于全局安装）
npm link
```

安装后即可直接调用（本文所有示例均用 `as-aot` 命令）：

```bash
as-aot examples/hello.as --run
```

未安装时可用等价方式（两者等价；注意 npm script 传参需加 `--` 分隔符）：

```bash
node src/index.ts examples/hello.as --run
npm run compile -- examples/hello.as --run
```

## 1. 编译管线总览

`as-aot` 前端只做「翻译」，把 ActionScript 3 子集编译成**可读的 C**，优化与机器码生成
交给成熟的 C 编译器（`cc`/`clang -O2`），不重复造轮子（同 TypePHP 的思路）。

```
ActionScript 源码 (.as)
        │  lexer.ts      词法分析（token）
        ▼
        │  parser.ts     递归下降解析（AST）
        ▼
        │  codegen.ts    语义 + C 代码生成
        ▼
       C 源码 (.c)                    ← 保留在磁盘，便于阅读
        │  build.ts      构建编排（构建清单 JSON + -I/-L/-l/-D + --target）
        ▼
  ┌──────┴────────┐
  │ native          │  cc/clang -O2 -lm             → 原生可执行（Mach-O / ELF / PE）
  │ wasm            │  clang --target=wasm32-wasip1   → WASI .wasm
  └────────────────┘
```

关键分工（见 [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) §2.8）：

| 模块 | 职责 |
|---|---|
| `src/index.ts` | CLI 参数解析、流程编排、错误兜底 |
| `src/build.ts` | 构建编排：构建清单解析、链接配置、多目标编译命令生成 |
| `src/codegen.ts` + `src/emit.ts` + `src/runtime.ts` | 语义分析 + C 发射（前端，不接触链接） |

## 2. 环境依赖

- **Node ≥ 22.6**：原生 type-stripping 直接运行 `.ts` 源码，无需编译步骤。
- **C 编译器**：`cc` / `clang`（native 目标默认 `cc`，可用 `--cc` 覆盖）。
- **WASI 工具链**（仅 `--target wasm` 需要）：WASI SDK 或自带 `wasm32-wasip1` 后端的 LLVM clang。
  - 约定通过环境变量 `WASI_SDK_HOME` 指向 SDK 根目录，编译器位于 `$WASI_SDK_HOME/bin/clang`，
    sysroot 位于 `$WASI_SDK_HOME/share/wasi-sysroot`。
  - 未安装时，`--target wasm` 的实际编译会报出明确的「WASI 工具链缺失」提示（含安装指引），
    而非泄漏 clang 底层的 `'stdio.h' file not found`；`--dry` 仍可预览编译命令。
  - AS3 异常（`throw`/`try`/`catch`/`finally`）在生成 C 里映射为 `setjmp`/`longjmp`；WASI 默认
    不支持，因此 wasm 编译会附加 `-mllvm -wasm-enable-sjlj`（WebAssembly 异常处理提案）。
    运行产物需 wasmtime/wasmer 等支持异常处理的运行时，wasm3 不支持该提案。

## 3. 命令行用法

```text
Usage: as-aot <input.as> [more.as ...] [options]

Options:
  -o <path>      output path (native: executable; wasm: .wasm appended)
  --run          run the compiled output after building
  --cc <name>    C compiler to use (default: cc)
  --target <t>   native (default) | wasm (WASI)
  --manifest <f> build manifest JSON (extra sources / include / link libs)
  --air-app <xml> AIR app descriptor: generate bootstrap + build manifest
  --main-class <n> main class for --air-app (default: infer src/**/Main.as)
  -I <dir>       include path (repeatable)
  -L <dir>       library search path (repeatable)
  -l <lib>       link library (repeatable)
  -D <macro>     preprocessor define (repeatable)
  --export <name> export a C symbol into the .wasm export table (repeatable)
  --opt <flags>  optimization flags (default: -O2)
  --dry          emit C and print the compile command without compiling
  -h, --help     show this help
```

### 3.1 基本编译

```bash
# 编译：生成同名 .c 并产出可执行文件（默认输出 = 去掉 .as 后缀的路径）
as-aot examples/hello.as

# 编译并立即运行
as-aot examples/fib.as --run

# 指定输出名 / 指定 C 编译器
as-aot examples/class.as -o build/class --cc clang --run
```

每次编译都会在输入 `.as` 同目录留下同名 `.c` 文件（用 `-o` 时留下 `<输出名>.c`），
可直接阅读生成的 C 代码——这是本项目「生成可读 C」的核心卖点。

### 3.2 多文件编译

多个 `.as` 会被合并为**一个编译单元**（解析后合并 AST 再统一发射）：

```bash
as-aot a.as b.as -o prog --run
```

`package` / `import` 的命名空间隔离、跨文件符号解析由 codegen 处理。

### 3.3 WASM 目标

```bash
# 产出 .wasm（需装 WASI SDK，或自带 wasm32 后端的 clang）
as-aot examples/hello.as --target wasm

# 只打印编译命令、不真正编译（无工具链时验证命令是否正确）
as-aot examples/hello.as --target wasm --dry
```

`--run` 在 wasm 目标下会用 WASI 运行时运行产物，按 `wasmtime → wasmer → wasm3` 顺序探测，
一个都没装则报错退出。因 wasm 产物声明了异常处理特性（见 §2），需 wasmtime/wasmer 才能运行，
wasm3 不支持异常处理提案。

#### 导出函数给 JS 直调

默认 `--target wasm` 产出 **WASI 命令模块**，只导出 `memory` 与 `_start`（`_start` 执行一次后
调用 `proc_exit` 结束实例）。要让浏览器 JS 直接反复调用某个函数（对标 Emscripten 的 `cwrap`），
用 `--export <name>` 把对应的 C 符号加入导出表：

```bash
as-aot examples/wasm-native/fib.as --target wasm --export fib -o fib-export
```

顶层 AS3 函数 `function fib(n:int):int` 会生成同名 C 全局函数，`--export fib` 使其出现在
`instance.exports.fib`。JS 侧直接 `instance.exports.fib(40)` 调用，无需 `_start`、无需捕获 stdout、
且可反复调用（前提是该函数不依赖 `_start` 里 libc 构造器建立的全局状态——纯计算函数天然满足）。
示例页见 `examples/wasm-native/fib-export.html`。

**声明式导出 `[WasmExport]`**：跨多个库/命名空间时，手动拼长 C 符号名（如 `foo_bar_Baz_twice`）易错。
改用 AS3 metadata 在源码里声明，编译器自动收集并注入 `--export`，无需在命令行记符号名：

```as3
package mathlib {
    [WasmExport]                    // JS 用 C 符号名直接调用
    function add(a:int, b:int):int { return a + b; }

    [WasmExport("multiply")]        // JS 用别名 multiply 调用
    function mul(a:int, b:int):int { return a * b; }

    class Calc {
        [WasmExport("twice")]       // 静态方法导出为 twice（符号 mathlib_Calc_twice）
        public static function twice(a:int):int { return a * 2; }
    }
}
```

```bash
as-aot export-meta.as --target wasm
```

语义与限制：
- 只能标记**无 `this` 的函数**——顶层函数、静态方法；实例方法带 `void* _this`（且 JS 无法构造
  GC 堆上的类实例），getter/setter 签名特殊，标记后均在**编译期报错**而非静默忽略。
- 无参标记 `[WasmExport]` 用生成的 C 符号名导出；带参 `[WasmExport("alias")]` 额外生成一个同名
  转发 wrapper，JS 用 `alias` 调用。
- `--export` 命令行参数与 `[WasmExport]` 标记会**合并**（去重），可同时使用。
- 编译成功后在 `.wasm` 旁生成 `*.exports.json` 导出清单，逐项记录 `name`（JS 导出名）、`symbol`
  （C 符号）、`returnType`、`params`，供宿主读取调用契约。示例见 `examples/wasm-native/export-meta.as`。

### 3.4 链接第三方库

前端只翻译，图形（skia/cairo/SDL）、正则等重活通过**链接**引入，不内嵌进 `.c`：

```bash
# 命令行声明 include 路径 / 库路径 / 库 / 宏定义（均可重复）
as-aot app.as -I vendor/include -L vendor/lib -l skia -D USE_SKIA=1

# 或走构建清单（推荐，可版本化复用）
as-aot app.as --manifest examples/skia-link.build.example.json
```

### 3.5 AIR 应用描述符（--air-app）

解析 AIR `app.xml`，自动生成引导启动代码 + 构建清单，把纯 AS 的 AIR 项目一键迁移到 as-aot：

```bash
# 一条命令：解析 app.xml -> 生成 bootstrap + manifest -> 编链出窗口化可执行
as-aot --air-app examples/air-native/air-native-app.xml

# 显式指定主类（app.xml 不含 document class；缺省扫描 src/**/Main.as 推断）
as-aot --air-app examples/air-native/air-native-app.xml --main-class demo.Main
```

流程：解析 `<id>/<filename>/<initialWindow>`（`title`/`width`/`height`/`visible`/`resizable`/
`requestedDisplayResolution`）→
生成等价 `boot-gui.as` 的引导代码（`new Stage()` → 预设 `stageWidth/stageHeight` → `new Main()` →
`addChild` → `showWindow`；`visible=false` 时改用离屏 `render` 出 PNG）→ 递归扫描 `src/**/*.as`
（跳过反向域名第三方库目录 `com/org/net`，但显式回加 air-native demo 实际用到的 GreenSock 核心
`TweenLite/TweenCore/SimpleTimeline/PropTween/TweenPlugin`）→
在 app.xml 同目录写出 `<filename>.build.json`（链接 Skia + SDL2）→ 编链出 `<filename>` 可执行
（产物名可用 `-o` 覆盖）。

对齐 adl 的三个关键行为：
- `<resizable>false</resizable>` → 构建清单加 `ASC_WINDOW_FIXED=1`，窗口创建时不加
  `SDL_WINDOW_RESIZABLE`，得到与 adl 一致的固定尺寸窗口。
- `<requestedDisplayResolution>high</requestedDisplayResolution>` → 构建清单加 `ASC_DISPLAY_HIGH=1`，
  窗口开 `SDL_WINDOW_ALLOW_HIGHDPI` 且 surface 按设备倍率创建物理像素（Retina 不模糊）；`standard`
  或缺省保持 1x（与 adl 一致，会被合成器拉伸）。
- 引导代码在 `new Main()` **之前**预设 `stage.stageWidth/stageHeight`，使 document class 构造时
  `trace(stage.stageWidth, stage.stageHeight)` 返回窗口尺寸（如 `1000 680`），而非 adl 之外的 `0 0`。

## 4. 构建清单（build manifest）

JSON 文件，对标 TypePHP 的 `project.yml`，用于固定可复用、可版本化的构建配置。
选 JSON 而非 YAML 是为保持**零第三方依赖**（Node 原生解析 JSON）。字段名沿用 kebab-case。

| 字段 | 类型 | 说明 |
|---|---|---|
| `target` | `"native" \| "wasm"` | 目标平台，默认 `native` |
| `c-compiler` | string | C 编译器，默认 `cc` |
| `opt` | string | 优化标志，默认 `-O2` |
| `sources` | string[] | 额外 C/C++ 源文件（与生成的 `.c` 一起编译） |
| `include-paths` | string[] | 头文件搜索路径（→ `-I`） |
| `link-libs` | string[] | 链接库（→ `-l`） |
| `link-paths` | string[] | 库搜索路径（→ `-L`） |
| `defines` | string[] | 预处理宏（→ `-D`） |
| `objects` | string[] | 预编译 `.o` 直接加入链接 |
| `frameworks` | string[] | macOS 框架（→ `-framework X`，Skia 的 CoreText/CoreGraphics 后端需要） |

路径类字段（`sources` / `include-paths` / `link-paths` / `objects`）**相对清单文件所在目录解析**
（与 TypePHP 的 YAML 路径规则一致）。示例见
[`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json)：

```json
{
  "target": "native",
  "c-compiler": "clang",
  "opt": "-O2",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia"],
  "link-libs": ["skia", "skparagraph", "skshaper", "skunicode", "skottie",
    "sksg", "svg", "skresources", "bentleyottmann", "skcms", "wuffs",
    "png", "jpeg", "webp", "webp_sse41", "dng_sdk", "piex", "expat",
    "freetype2", "harfbuzz", "icu", "zlib", "z"],
  "link-paths": ["../vendor/skia/lib"],
  "frameworks": ["CoreFoundation", "CoreGraphics", "CoreText", "CoreServices",
    "ApplicationServices", "ImageIO", "Accelerate"],
  "defines": ["ASC_USE_SKIA=1"],
  "objects": []
}
```

**优先级**：CLI 参数覆盖清单同名字段（对标 TypePHP 的「CLI beats YAML」）。
合并顺序：默认配置 → 清单 → CLI 覆盖。

## 5. 多目标后端

| 目标 | 编译命令 | 产物 |
|---|---|---|
| `native`（默认） | `cc -O2 -lm -o <out> <c> [sources] -I... -D... [objects] -L... -l... [-framework X]` | Mach-O / ELF / PE 可执行 |
| `wasm` | `clang --target=wasm32-wasip1 [--sysroot=...] -mllvm -wasm-enable-sjlj -O2 -o <out>.wasm <c> ...` | WASI `.wasm` |

平台耦合点已隔离到 `runtime.ts` 的 `RUNTIME_PREAMBLE`，用 `#ifdef __wasi__` 条件编译。
当前唯一的平台差异是 `as_now_ms()`：

- native：`gettimeofday`，毫秒精度
- WASI：`time(NULL)`，退化为秒级精度（wasi-libc 折叠了 libm，也无需单独 `-lm`）

> 本机若为 Apple clang（无 `wasm32-wasip1` target）且未装 WASI SDK，则 wasm 只能 `--dry`
> 验证命令，实际编译需先装工具链（见 §2）。

## 6. 窗口化（SDL2 后端）

`--target native` 下有三种构建形态，由**源码 + 构建清单**共同决定（GUI 开关不在 `--target`，而在
源码里的 `Stage.showWindow(...)` 与清单里的 `ASC_USE_WINDOW=1` 宏）：

| 形态 | 编译命令 | 关键 `defines` | 关键 `sources` / `-l` |
|---|---|---|---|
| 纯命令行（无图形） | `as-aot examples/hello.as --run` | 无 | 无（默认 `cc -O2 -lm`） |
| 离屏渲染（Skia 出 PNG，无窗口） | `as-aot app.as --manifest examples/skia-link.build.example.json` | `ASC_USE_SKIA=1` | `skia_glue.cc` + `-l skia ...` |
| GUI 窗口（SDL2 上屏 + 事件循环） | `as-aot examples/window_click.as --manifest examples/window_click.build.example.json` | `ASC_USE_SKIA=1` + `ASC_USE_WINDOW=1` | `skia_glue.cc` + `window_glue.cc` + `-l SDL2 -l objc` |

核心机制：`ASC_USE_WINDOW=1` 决定 `Stage.showWindow(...)` 是「真正弹窗进入事件循环」还是「退化为
no-op」（见下文 `runtime.ts` 的条件编译）。因此同一个 `.as` 换 manifest 即可在「离屏 PNG」与「GUI
窗口」间切换，无需改源码。

`--target native` 默认产出的是**命令行可执行文件**（离屏 CPU raster → PNG 后退出）。要在 macOS
上弹出一个真正的原生窗口并进入事件循环，用 `Stage.showWindow(width, height, title)`，它把离屏
Skia surface 的像素经 `vendor/window_glue.cc` 上屏到 SDL2 窗口（事件循环处理 `SDL_QUIT`/重绘，并
把鼠标输入经函数指针回调转发回 AS3 事件系统，支持点击交互与事件后重渲染）。

**环境要求**：SDL2 必须是 **arm64** 架构（与 arm64 Skia 静态库一致）。本机若已有 x86_64 的
`brew install sdl2`（Intel Homebrew，装在 `/usr/local`），直接链接会报 `file built for
macOS-x86_64`；需用 arm64 Homebrew（`/opt/homebrew`）重装，或像本项目一样**源码编译 arm64 静态库**
放进 `vendor/sdl2/arm64/`（`include/` + `lib/`，`configure --host=arm64-apple-darwin --disable-shared`）。

编译（等价于下面的构建清单）：

```bash
as-aot examples/window.as --manifest examples/window.build.example.json
```

构建清单 [`examples/window.build.example.json`](../../examples/window.build.example.json) 在 Skia 基础上
额外声明：

- `sources` 追加 `../vendor/window_glue.cc`（SDL2 窗口 + 上屏 + 事件循环）；
- `include-paths` 追加 `../vendor/sdl2/arm64/include`，`link-paths` 追加 `../vendor/sdl2/arm64/lib`；
- `link-libs` 追加 `SDL2`、`objc`（SDL2 静态链接需 Objective-C 运行时）；
- `frameworks` 追加 `CoreVideo`/`Cocoa`/`Carbon`/`IOKit`/`Metal`/`QuartzCore`（SDL2 的 macOS 视频/Metal
  渲染后端依赖）；
- `defines` 追加 `ASC_USE_WINDOW=1`（`ASC_USE_SKIA=1` 仍必须）；Retina 高清再加 `ASC_DISPLAY_HIGH=1`。

Retina 高清渲染（`ASC_DISPLAY_HIGH=1`）：

- SDL2 默认不给窗口原生分辨率的 drawable（drawable == 逻辑尺寸），Skia 按逻辑点出的帧会被 macOS
  合成器拉伸 2x 上屏 → 文字发虚。这正是 AIR `standard` 的行为；`high` 需要主动开 `ALLOW_HIGHDPI`。
- `window_glue.cc` 的 `sk_window_probe_scale(w, h, highdpi, &pw, &ph)` 先开一个 hidden + `ALLOW_HIGHDPI`
  窗口，用 `SDL_GL_GetDrawableSize` 读出物理像素尺寸与倍率——因为 Skia surface 必须在窗口存在**之前**
  按物理像素创建。`Stage.render` 与 `Stage.showWindow` 都走 `as_window_device_scale()` 拿倍率，
  并在 canvas 上 `scale(scale, scale)` 后按逻辑坐标绘制，所以 AS3 代码里的坐标系不变。
- `Stage.contentsScaleFactor` 返回实测倍率（Retina 上 2.0，`standard` 下 1.0）。注意它只在
  `render`/`showWindow` 时写入，document class 构造期读到的是初始 `1.0`。
- 验证方法：`screencapture -x -o -l<windowid> out.png` 后看尺寸，2x 窗口应为逻辑尺寸的两倍
  （如 1000×712 窗口 → 2000×1424 图）。

关键实现点：

- `vendor/skia_glue.cc` 暴露 `sk_surface_peek_pixels`（CPU raster surface 的像素缓冲），`window_glue.cc`
  用 `SDL_CreateRGBSurfaceFrom` 直接包裹该缓冲（零拷贝），上屏走 `SDL_Texture` + `SDL_RenderCopy`。
- Skia `kN32` premul 在 little-endian macOS 内存序为 R,G,B,A（每像素 uint32 读作 0xAABBGGRR），因此
  SDL 通道掩码取 `R=0x000000FF`/`G=0x0000FF00`/`B=0x00FF0000`/`A=0xFF000000`（R/B 反序）；用 0xAARRGGBB
  顺序会交换红蓝。
- `window_glue.cc` 顶部 `#define SDL_MAIN_HANDLED`，避免 SDL 把生成的 `int main(void)` 重定义为 `SDL_main`。
- 未定义 `ASC_USE_WINDOW` 时 `Stage.showWindow` 退化为 no-op（纯 C 构建仍可编译运行，见 `runtime.ts`
  的 `as_skia_surface_show_window` 条件编译）。
- **鼠标事件桥接**：`sk_window_show` 新增 `on_mouse`/`on_redraw` 两个函数指针参数（胶水层是 C++ 编译、
  不知道生成的 C 函数名，故用回调解耦）。左键 `mouseDown`/`mouseUp`/`click` 经 `on_mouse` 转发
  （窗口相对坐标 + 事件类型字符串），`emit.ts` 发射的 `ASC_window_on_mouse` 路由到 `Stage_dispatchMouse`
  （命中测试 + 冒泡）；每个事件后调用 `on_redraw`（`ASC_window_on_redraw`）重新光栅化 display tree
  并重建 SDL 纹理上屏，让监听器驱动的改色等即时反映到窗口。示例见 `examples/window_click.as`。
- **窗口缩放控制（阶段四十五）**：`present_frame` 用显式 `SDL_Rect dst={0,0,w,h}` 而非 `dst=NULL`——
  后者会把纹理拉伸铺满渲染目标，窗口 resize 后目标尺寸变了而 surface 没变，内容就被非等比拉伸变形。
  事件循环处理 `SDL_WINDOWEVENT_SIZE_CHANGED`，重查逻辑/物理尺寸后调 `on_resize` 回调，由 AS3 侧
  重建物理像素 surface 并重渲染（surface 所有权在 AS3 侧，回调返回新指针）。`scaleMode`/`align` 落地为
  真实画布变换（`noScale` 内容固定、`showAll`/`noBorder` 等比、`exactFit` 非等比；align 八值分配剩余
  空间），`noScale` 下 `stageWidth/Height` 跟随真实窗口尺寸并派发 `Event.RESIZE`。鼠标/滚轮坐标需
  反变换 `(x-ox)/cx` 才能在缩放/偏移后正确命中。
- **鼠标滚轮（阶段四十五）**：`SDL_MOUSEWHEEL` 经 `on_wheel` 转发（`SDL_GetMouseState` 取坐标，因滚轮
  事件不带位置），`ASC_window_on_wheel` 路由到 `Stage_dispatchWheel`：命中 TextField 时自动滚动
  （adl 实测：1 delta = 1 行、`scrollV -= delta`、钳制 `[1,maxScrollV]`），再派发冒泡 `MouseEvent.MOUSE_WHEEL`。
  示例见 `examples/wheel.as`（纯 C 回归，用 `stage.dispatchWheel(...)` 直接驱动）。

> 窗口化产物仍是 Mach-O 可执行文件（可直接命令行运行并弹窗）；要“双击可运行”的 macOS `.app` 打包
> （`MyApp.app/Contents/MacOS/...` + `Info.plist`）是后续打包脚本层，不是编译器参数。

## 7. 相关文档

- [`README-CN.md`](../../README-CN.md) — 项目总览、支持的语言子集、类型映射、当前限制
- [`TODO.md`](../../TODO.md) — 分阶段路线图（阶段二十九为「构建清单 + 多目标后端」）
- [`as3-semantics.md`](as3-semantics.md) — AS3 语义保真红线与规范来源
- [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) — 开发规范（§2.9 构建与链接）
