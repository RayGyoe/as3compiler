# A native AOT compiler for ActionScript 3

把 ActionScript 3 源码**提前编译（AOT）成原生机器码**，生成原生可执行文件——同时保留你熟悉的 AS3 语法。

设计思路：编译器前端只负责
`词法 → 语法 → 生成可读的 C`，优化与机器码生成全部交给成熟的 C 编译器，不重复造轮子。

---

## 🎬 Video

<div align="center">
<video src="https://github.com/user-attachments/assets/2e41e471-b2f3-4274-9d41-748c4d529a62" controls width="100%"></video>
</div>

---

## 编译管线

```
ActionScript 源码 (.as)
        │  lexer.ts      词法分析（token）
        ▼
        │  parser.ts     递归下降解析（AST）
        ▼
        │  codegen.ts    语义 + C 代码生成
        ▼
       C 源码 (.c)
        │  构建编排 src/build.ts
        │  （构建清单 JSON + -I/-L/-l/-D + --target）
        ▼
  ┌──────┴───────┐
  │ native        │  cc/clang -O2 -lm            → 原生可执行（Mach-O / ELF / PE）
  │ wasm          │  clang --target=wasm32-wasip1  → WASI .wasm
  └──────────────┘
```

「生成单个可读 `.c`」是**默认形态**（构建简单、便于阅读），不是禁止链接第三方库的铁律：
实现图形（skia/cairo/SDL）等重活时，正确做法是把成熟库**链接**进来（`-lskia`），而不是自研光栅化。
参见「构建与链接」与 AGENTS.md §2.9。

生成的 C 里，**与宿主符号撞名的 AS3 顶层函数会自动改名**（只改 C 符号，AS3 侧可见名一字不动）：
`function log()` → `log__`（撞 `<math.h>`）、`function bind()` → `bind__`（撞 socket 的 `bind(2)`）、
`function max()` → `max__`（撞 Windows 的 `#define max(a,b)`）。判据表由 `scripts/gen-c-reserved.ts`
从**当前平台的头文件面**机器生成（`src/c-reserved.gen.ts`，与手写 seed 求并），所以漏举一个名字不会再变成
用户的编译错误；消歧用 `__` **后缀**而不是 `_` 前缀——前缀会被宿主的对象式宏吃掉（MSVC 的
`#define _stat _stat64i32`）。Windows 上还有一族**对象式宏**（`near`/`far`/`small`…）由运行时的 `#undef` 块处理。
完整判据与残留在 `docs/zh-cn/c-naming.md` §8。

## 运行

安装（得到 `as-aot` 命令）：`npm install -g as3compiler`（或本地开发 `npm link`）。

装到的命令是**已经转好的 JavaScript**（`dist/`），所以只要 Node ≥ 18 就能跑，不需要类型擦除。
在**源码 clone** 里的等价调用是 `node src/index.ts ...` / `npm run compile -- ...` —— 这条路径直接跑 `.ts`，
要求 Node ≥ 22.18（类型擦除默认开启的版本；22.6–22.17 需额外加 `--experimental-strip-types`）。

`dist/` 由 `scripts/build-dist.ts` 在发布前生成（挂在 `prepare` 钩子上，`npm pack` / `npm publish` 都会跑）——
用 Node 自带的 `module.stripTypeScriptTypes()` 把 `src/*.ts` 原样转成 `.js`，零第三方依赖（符合 AGENTS.md §3.1）。
**这不是可选项**：Node 拒绝对 `node_modules/` 下的文件擦类型（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，
是永久性的加载器限制而非版本门槛），`bin` 一旦指回 `src/index.ts`，**每一种安装方式**都会装完即崩。
转换是**等长空白替换**（行号与 `src/` 一一对应，堆栈仍指得到源码），生成的 C 与直接跑 `.ts` **逐字节相同**。

**npm 包只含编译器本体**（`dist/` + `docs/`，约 2 MB 压缩），**不含 `vendor/` 的第三方预编译库**
（Skia / SDL2 / curl / sqlite）——纯 C 与 WASI 目标并不需要它们，只有图形、窗口、音频、网络、Stage3D 等目标才要。
这些库随**源码 clone** 一起提供；缺什么由 `as-aot doctor` **逐条报明**（缺项 + 建议命令 + 修复指引），
重建/重新下载的配方在 [`vendor/provision/`](vendor/provision/README.md)，外部夹具见 [`examples/EXTERNAL-FIXTURES.md`](examples/EXTERNAL-FIXTURES.md)。

依赖：Node ≥ 18（跑发布的 `dist/`；从源码直接跑、或自行 `npm run build:dist` 则需 Node ≥ 22.18）、系统装有 `cc`/`clang`；
`--target wasm` 需 WASI SDK（`WASI_SDK_HOME` 指向 SDK 根，或自带 wasm32 后端的 LLVM clang），
且运行产物需支持异常处理提案的运行时（wasmtime/wasmer，见 `docs/zh-cn/compile.md` §2）；
`--target wasm --package web` 需 Emscripten SDK（`EMSDK_HOME` 指向 emsdk 根目录，见
`docs/zh-cn/html5-web.md`；**Windows 上用的是同目录的 `emcc.bat`**，经 `cmd.exe` 启动，`PATH` 用 `;` 拼——
POSIX 那份 `emcc` 是 `#!/bin/sh` 脚本，Windows 起不来）。

编不动时先跑 **`as-aot doctor`**：它把构建路径上所有「缺什么」的检查汇总成一份只读报告
（`--air-app app.xml` 按该应用真实触碰的功能裁剪，`--json` 给机器读，`--fix` 只做秒级幂等修复，
`--check-update` 只**只读地问一次 registry** 有没有新版本并打印升级命令、**从不自己安装**且不影响退出码），
且与编译**共用同一张检查表**——报告说什么，编译时就报什么。见 `docs/zh-cn/compile.md` §3.6。

版本用 **`as-aot --version`**（`-V` / `version` 子命令同义；`doctor` 报告头行也带它）——版本只有一个来源
（`package.json`），报 bug 时先带上它。

```bash
# 编译（默认输出到输入同名的无扩展名文件，并保留生成的 .c 便于阅读）
as-aot examples/hello.as

# 编译并运行
as-aot examples/fib.as --run

# 指定输出名 / 指定 C 编译器
as-aot examples/class.as -o build/class --cc clang --run

# 生成 macOS App 工程（--package xcode-project，交给 Xcode 打开/构建/调试，产物是 .app）
as-aot src/Main.as --target native --package xcode-project -o build/Main

# 生成浏览器 HTML5 渲染页面（--target wasm --package web，需 Emscripten SDK）
as-aot examples/web/hello-web.as --manifest examples/web/hello-web.build.json
```

## 构建与链接

> 完整编译说明（命令行参数、构建清单 JSON、多目标后端、WASI 工具链）见
> [`compile.md`](docs/zh-cn/compile.md)。

支持多目标与链接第三方库：

```bash
# WASI 目标（需装 WASI SDK 或自带 wasm32 后端的 clang）
as-aot examples/hello.as --target wasm

# 链接第三方库（skia/cairo/SDL 等）：include 路径 / 库路径 / 库 / 宏定义
as-aot app.as -I vendor/include -L vendor/lib -l skia -D USE_SKIA=1

# 嵌入 SWC 里的位图资源类与皮肤文本（阶段九十五 / 一百四十九）：命名资源变成 BitmapData 子类，
# 源码可直接 `new logo(0, 0)`，也可 getDefinitionByName("logo") 反射后 new；
# DefineEditText 文本字符烘成真 TextField（初始文本 + 字体/字号/颜色/对齐/缩进/leading 与各标志）
as-aot app.as --swc assets/skin.swc

# 构建清单（JSON，路径相对清单目录解析）
as-aot app.as --manifest examples/skia-link.build.example.json

# 用到 flash.text 才链文本排版栈；不画字的程序自动省掉整条 SkParagraph/HarfBuzz/ICU 链
# （实测 19.43 MB → 6.53 MB，阶段二百二十一；构建时打印 + / - 判定）
# 链接期固定带 -Wl,-dead_strip -Wl,-x（--debug-info 保留符号），ICU 数据只取 0.80 MB 那份：
# 不画字 3.55 MB / 画字 6.05 MB（阶段二百二十二）
# 链接了 metal_glue.mm 的构建再多一枚 -Wl,-exported_symbol,_sk_mtl_shared_queue（阶段二百八十八）：
# Stage3D 要靠 dlsym 按名字采纳 Skia 那条 MTLCommandQueue，不导出就会静默回落到两条队列，
# 合成读到半成品 ⇒ 画面闪烁（+8 KB）
as-aot notxt.as --manifest examples/draw-over.build.json

# 加载 AIR 原生扩展（ANE，阶段一百七十八）：宿主 FRE 运行时接进来，
# 重编版 ANE 与宿主库（asaot.dll / libasaot.dylib）会随构建落到 <exe 同目录>/extensions/<extID>/<平台>/
as-aot app.as --manifest app.build.json --ane lib/ANENDI.ane
as-aot app.as --manifest app.build.json --ane lib/ANENDI.ane --ane-platform Windows-x86-64

# AIR 项目：扩展不必手拼 --ane，描述符里的 <extensions> 说了算（阶段一百八十）
# 按 ID 从 <appDir>/ext-aot、<appDir>/lib、<appDir>/ext-folder 找包，解析结果写进 <filename>.build.json
as-aot --air-app app.xml
as-aot --air-app app.xml --extdir vendor/anes    # 换个地方找（可重复，顶掉上面三个默认）
# 声明了却找不到 ⇒ 硬错误（照 adl 的口径），不做静默少扩展
# 重编成 AOT 版的扩展放 <appDir>/ext-aot/<名>/（排在默认根最前，阶段一百八十二）——
# 它与 AIR 原版声明同一个 <extensionID>，靠根顺序而不是目录名排序定胜负；没重编的照旧从 lib/ 拿

# 一个类库被多个 AIR app 共用：把它作为额外的源码根，而不是往每个 src/ 里拷一份（阶段二百五十）
as-aot --air-app app.xml --as-class-path ../seam --as-class-path ../kit
# 编译面 = src/ 加上每个 --as-class-path 根；文件身份按「它自己那个根」算，
# 所以类名与 C 符号不随构建目录漂移；同一个全限定类出现在两个根 ⇒ 硬报错
# （迁移时忘了删 src/ 里的旧拷贝就是这样撞上的）

# 导出顶层函数给 JS 直调（默认 WASI 命令模块只导出 _start）
as-aot examples/wasm-native/fib.as --target wasm --export fib

# 声明式导出：用 [WasmExport] 元数据标记函数/静态方法，自动导出并生成 .exports.json
as-aot examples/wasm-native/export-meta.as --target wasm

# 生成浏览器 HTML5 渲染页面（--target wasm --package web，需 Emscripten SDK）
as-aot examples/web/hello-web.as --manifest examples/web/hello-web.build.json

# 只生成 C 并打印编译命令，不真正编译（无工具链时验证命令）
as-aot examples/hello.as --target wasm --dry

# 保留调试信息：三种后端均加 -g，且 wasm 默认的 DWARF 剥离被关掉（可用 DevTools 源码级调试）
as-aot examples/wasm-native/fib.as --target wasm --debug-info

# 窗口 GPU 后端（仅 Windows，且有 <renderMode>direct/gpu 的窗口）：auto（缺省）= D3D12，
# --gpu-backend gl 换成 WGL/OpenGL（系统自带的 opengl32，不依赖 d3d12.dll）。两者帧时相同，
# GL 省的是提交路径（约 1.1–1.3 ms/帧）；--gpu-backend auto 清掉已记在清单里的选择
as-aot --air-app app.xml --gpu-backend gl
```

**窗口 GPU 后端（`--gpu-backend`，阶段二百七十一）**：Windows 上并存两个窗口合成后端——缺省的 **D3D12**
（要求 Win10 1507 + WDDM 2.0，Win7 上无解）与新落地的 **WGL/OpenGL**（`opengl32.dll` 系统自带）。
`auto` 的回退顺序是 `D3D12 → GL → CPU`。这个选择**装不进 AIR 描述符**（`Descriptor.51.4.xsd` 的
`<windows>` 是 `xs:all` 只四个子元素、全 XSD 无 `xs:any`；`adt -package` 对 `<gpuBackend>` 报
error 103，而异命名空间的元素/属性四种写法**全部**报 103；`adl` 沉默不是 schema 接受），故走
**我们自己的生成清单**字段 `gpu-backend`，AIR 从不读它。它**不是**增强开关——`--features gl` 会按未知
名字报错，只是**存法**与 `features` 相同（同一个文件、两套独立开关）。优先级：
`--gpu-backend` > 上次清单里的值 > `ASC_GPU_BACKEND` 环境变量（原型期别名，输给钉住的值时会明确说）= `auto`。
五种无效组合（非 `--air-app`、web、非 Windows 宿主、描述符没编进 GPU 窗口、Stage3D）都是**构建期拒绝**，
不会「开了但什么都不变」。详见 [`compile.md`](docs/zh-cn/compile.md) §3.4.6 与
[`win32.md`](docs/zh-cn/win32.md) §3.1.1。**Win7 口径**（阶段二百七十二）：GL 构建的导入表已实测干净
（13 个 DLL / 408 个符号，无 `d3d12.dll`/`dxgi.dll`/`d3dcompiler_47.dll`，subsystem 6.0），用
`node scripts/win7-imports.ts <exe>` 可复核；**但这个结论只覆盖「加载器与导入面」，真机仍未跑过**，
清单与未测项见 [`win32.md`](docs/zh-cn/win32.md) §6。

**ANE 加载（阶段一百七十八）**：`--ane` / 清单 `ane-paths` 打开 `ASC_HAVE_FRE` 并接上宿主 FRE 运行时。
每一项可以是 `.ane` 包，也可以是**解包后的目录**（`extension.xml` + `<平台键>/<原生库>`，即 `adt` 的暂存布局）——
后者是重编给 AOT 用的那份产物的默认形态：其原生库导入宿主库（Windows `asaot.dll` / macOS
`libasaot.dylib`，转发进**生成程序自己的表**），
AIR 没有那张表，故**签不签名都载不进**，打包没有消费者；`.ane` 强制要求的 `library.swf` 也是死重量
（`DoABC` 不在编译器范围内，扩展的 AS3 类必须从 `.as` 源码编）。原版已签名 `.ane` 仍正常读（`META-INF/ANE/` 布局）。
宿主库 `lib/bin/<platform>/asaot.{dll,dylib,a}`（头文件 `lib/asaot.h`，与 AIR SDK 的 `FlashRuntimeExtensions.h`
**ABI 逐字节对齐**）是**薄转发器**：51 个 FRE 入口全部经 `AsaotHost` 函数表回到**生成程序自己**的实现，
故 AS3 语义只有一个堆、一个类注册表。`lib/` 只放**手写源**（`asaot.h` 契约、`asaot_host.c` 实现、
`build-asaot.bat` / `build-asaot.sh` 配方），构建产物按平台落在 `lib/bin/`（如 `lib/bin/windows-x64/`）：
`-I` 指向 `lib/`、`-L` 指向该平台子目录——头文件是所有平台共用的一份契约，导入库是某平台的产物。
平台目录名小写（`windows-x64`/`windows-x86`/`macos-x86-64`…），与 `vendor/sdl2/lib/windows-x64`、
`vendor/curl/lib/windows-x64` 同一口径；**不是** AIR 的平台键原文（那是 `extension.xml` 里 ZIP 子目录的名字，
由 `ane-platform` 单独处理）。macOS 那一格**跟着 AIR 的键拼写**走（`macos-x86-64`），因为 **macOS 的键
不编码架构**：SDK 的 macOS 运行时是一份 universal 二进制（`x86_64`+`arm64` 两个切片），两个切片里的
ANE 加载器键都是 `MacOS-x86-64` 一个（实测）——架构在 `.dylib` 里，所以 darwin 的两种架构推导出**同一个键**，
`MacOS-AOT` 不是 AIR 的键（全 SDK 0 命中），故不设该目录。
宿主库现出**两个平台**：Windows（`lib/bin/windows-{x86,x64}/asaot.dll` + `asaot.lib`）与
macOS（`lib/bin/macos-x86-64/libasaot.dylib`，**默认通用二进制** `x86_64`+`arm64` —— 因为
`MacOS-x86-64` 这个键**不编码架构**，AIR 自己的 macOS 运行时就是通用的）。
`lib/build-asaot.sh` 编 macOS 那份（`--platform native` 只出宿主架构，供改-编循环），它不只编译还**验产物**：
install name 必须是可重定位的 `@executable_path/libasaot.dylib`（且两个切片一致）、必须导出 `asaot_bind`、
导出数 53、不得依赖 `Adobe AIR` —— 因为「写成绝对路径」在作者机器上照常工作、在别的机器上加载失败，
而构建期**一句话都不说**。
仍未做的只有 **iOS**：它把扩展**静态链进应用镜像**、没有 `dlopen` 这一步，故不是一个可加载的宿主库；
`aneHostLibName()` 对它**直接抛错并说明原因**，不借 macOS 的名字。其余任何没有宿主库的平台，
构建都**直接报错并给出该路径**，不会去找一个没编过的东西。
`build-asaot.bat` **默认同时构建两个宽度**（`bin/windows-x86/` 与 `bin/windows-x64/`），
可用 `build-asaot.bat x86` / `x64` 只重编其中一个，未知参数**报错退出**（不静默跳过）；
取哪个宽度由 `--ane-platform` 决定，而扩展包自己声明平台，所以「只编本机那个宽度」底噪
就意味着 `--ane-platform Windows-x86` 会被拿 64 位宿主库顶替——它正是这个默认值要消掉的失败模式。
两个宽度只差一个 `--target` 三元组（`asaot_host.c` 是宽度无关的转发代码），脚本末尾用
`findstr` 核验导入库确以 `asaot.dll` 为模块名：该失败在构建期完全无声（`llvm-lib /DEF:` 出来的
导入库模块名是**空的**），只会在很久以后表现为「重编过的 ANE 仍然要 `Adobe AIR.dll`」。两个宽度都还要**验产物本身**（与 macOS 的 `build-asaot.sh` 同一组断言）：`asaot.dll` 必须导出 `asaot_bind`、PE 导出数**恰好 53**（51 个 FRE 入口 + `asaot_bind` + `asaot_is_bound`）、且**不得导入 `Adobe AIR.dll`**——名字对但内容错的宿主库照样编过、链接过，直到某个扩展被加载才炸。
**Windows ARM64 为什么不在里面**：AIR 没有 Windows ARM 运行时 —— AIR SDK 51.4.1 的每个 Windows 运行时
各只认**一个**平台键（`win/` 的 `Adobe AIR.dll` 只有 `Windows-x86`、`win64/` 的只有 `Windows-x86-64`，
合起来就是全部两个），SDK 也只带 `win/`、`win64/` 两个 Windows 运行时
（发布说明里的 arm64 只涉及 Linux/iOS/macOS）。于是没有扩展能声明 ARM64 的 Windows 切片，也没有运行时
会去找它：在 Windows-on-ARM 上 AIR 本身跑的就是 **x64 版**（模拟执行），用的仍是 x64 宿主库。
所以 `lib/bin/` 里**刻意没有** `windows-arm64`（一个谁也加载不了的库不是「支持」，是库存垃圾），
宿主宽度集合到此是**闭集**；`as-aot --ane` 在 Windows ARM64 上**直接报错**并告诉你传
`--ane-platform Windows-x86-64`（配 `architecture: "64"`），而不是去猜一个 AIR 从来不曾有过的键。
（依赖脚本 `vendor/provision/windows.ps1` 另有 `-Arch arm64`，那是给**非 AIR** 的 Windows-on-ARM
产物用的，不对应任何 ANE 平台键；`both` 仍只指 x64+x86。参见 [`docs/zh-cn/win32.md`](docs/zh-cn/win32.md) §2.11。）
加载协议完整实现在生成程序里：**编译期**解析 `extension.xml`
并定下平台条目 → **后链接阶段**把 ANE 的原生库与宿主库一起落到 `<exe 同目录>/extensions/<extID>/<平台>/` →
运行时按名字加载宿主库（Windows `LoadLibraryA` / macOS `dlopen`，install name 是 `@executable_path/` 所以
加载的正是旁边那一份）+ 取 `<initializer>` 符号 → 按 `FRENamedFunction[]` 分派。
关键前提：**ANE 必须是对着 `asaot` 重编过的版本**（其 FRE 导入必须解析到宿主库，而不是硬编码的
`Adobe AIR.dll`——后者是 AIR 自家导入库记录的模块名，不得用作我们的产物名）；不影响 adl 侧继续用
原版 ANE，两者互不干扰。
`ExtensionContext` 按 AIR 建模：`createExtensionContext` / `call` / `dispose` / `getExtensionDirectory` /
`actionScriptData` + `StatusEvent` 异步派发；AIR **没有** `extensionID` 属性（实测 `mxmlc` 拒绝、
`adl` 报 `Error #1069`），本运行时同样没有——不为了「看起来更完整」凭空多出一个属性。
渲染管线（`FREGetRenderMode` / `FRESetRenderSource` / `FREMediaBuffer*` / 原生窗口句柄）**本期不实现**：
只导出桩并在调用时**响亮报明**，绝不静默返回一个编造的渲染模式。

**迁移一个现成 ANE 的完整流程**（双产物 + 重编换名、shim 头、三个工程属性、症状→病因对照表、
以及全部缺口清单）见 [`docs/zh-cn/ane.md`](docs/zh-cn/ane.md)；最小可跑闭环见
[`examples/ane/`](examples/ane)（46 条断言，命令行/清单直接指名包；**Windows 与 macOS 都真跑**，
macOS 侧加载的是经 `dlopen` 的真 `ProbeANE.dylib`）与
[`examples/ane-app/`](examples/ane-app)（8 条断言，走 `--air-app` + 描述符 `<extensions>`）。
重编产物是一棵**暂存目录树**（`extension.xml` + `<平台>/<库>`，不打包），放进 `<appDir>/ext-aot/<扩展 id>/`
就会被自动选中，所以 `adl` 侧继续用原版 ANE、两条路互不干扰。

构建清单（JSON）字段：`target`（`native`/`wasm`）、`package`（`raw`/`xcode-project`/`android-project`/`web`，
默认 `raw`，见 `compile.md` §6）、`c-compiler`、`opt`、`debug-info`（保留调试信息，默认 `false`，见下）、
`sources`（额外 C/C++ 源）、
`include-paths`、`link-libs`、`link-paths`、`defines`、`c-flags`（原样透传给 C 编译器的旗标，清单写法；CLI 是 `--cflag <f>` / `-w`，落在每个编译与链接步骤上）、`objects`（预编译 `.o`）、`exports`（导出到 .wasm 导出表的 C 符号）、
`ane-paths`（要加载的 `.ane` 路径清单，见上「ANE 加载」）、`ane-platform`（覆盖平台条目名，
默认按构建目标推导，如 `Windows-x86-64`）、
`swc-paths`（`.swc` 库清单；其中的**命名位图资源**在编译期提取、反预乘后重编码为 PNG 内嵌进产物，
`DefineBitsJPEG3` 的**独立 alpha 平面**同样在编译期解压、运行时与 JPEG 合成（否则透明区画出黑矩形）；
运行时由 Skia 解码；**矢量 shape 与显示树**（`DefineShape*`/`DefineSprite`/`PlaceObject*`）与**九宫格**
（`DefineScalingGrid`）、**按钮四态**（`DefineButton2`）同样在编译期烘焙为运行时绘制调用——
**符号自己的时间轴脚本（`DoABC` 帧脚本）也在编译期解码成 AST 后复用同一发射器**（`this.stop()` / `buttonMode` /
`addEventListener` + 闭包 `_self` / `gotoAndStop` 三元等；不支持的字节码形态**响亮报明**、不静默），
故 `agreebtn` 这类“勾选态写在皮肤里”的控件在 AOT 里也真的会切帧——
见 `docs/zh-cn/swc.md` §5/§6/§9）、
`font-urls`（`--package web` 的字体字节流 URL 列表，运行时注入 Skia），
以及 `xcode-project` 的应用元数据 `bundle-id`/`display-name`/`icon`/`deployment-target`（见 `compile.md` §6.4）。CLI 参数覆盖清单同名字段。
路径类字段相对清单文件所在目录解析。示例见
[`examples/skia-link.build.example.json`](examples/skia-link.build.example.json)。

**列表字段支持宿主占位符**，所以一份清单同时服务 macOS 与 Windows（`vendor/` 的四套依赖目录各自只有
一套归档）：`${host}` 展开成 `macos-arm64`/`windows-x64`/`windows-x86`/`wasm`、`${lib:png}` 在 Windows 展开成
`libpng`（归档名带 `lib` 前缀）、`${win:gdi32}`/`${mac:objc}` 是「整条只在那个宿主上存在」。`frameworks` 不需要
占位符——非 macOS 一律不发射。词表与拒绝规则见 `compile.md` §4.1.1。

**按目标分层链接（`targets`）**：顶层字段为公共默认；`targets.<native|wasm>` 块只对**匹配的目标**生效，
并把它声明的字段**整体替换**（replace，非追加）同名顶层值——使**一份清单**即可服务链接集互斥的多目标
（典型：native 链接 curl，而 WASI 无 socket、`-lcurl` 会让 `wasm-ld` 失败，需为 wasm 去掉它）。合并顺序：
默认配置 → 清单顶层 → 清单 `targets.<最终目标>` → CLI 覆盖。示例
[`examples/flash-net-layered.build.example.json`](examples/flash-net-layered.build.example.json)，详见 `compile.md` §4.1。

**调试信息（`--debug-info` / 清单 `debug-info`，默认关）**：默认产物在**三个后端都不带 DWARF**——native 在 `-O2`
下本来就没有；`emcc -O2` 自己就剥离；唯独 **wasi 后端**的 `libc.a` 自带 DWARF 且 `wasm-ld` 默认保留（即使一个空
`int main` 也拖进 ~19 KB），故 wasm 链接默认加 **`-Wl,--strip-debug`**（`fib.wasm` 421 KB → **133 KB**；只删
`.debug_*`，`name` 函数名段保留 ⇒ trap 仍打印符号化栈）。开 `--debug-info` 则三端均加 `-g` 且 wasm 不再剥离
（`fib.wasm` ~640 KB，含我们生成的 C 的行号 ⇒ 可在 DevTools 里源码级调试）。

**清单顶层键必须拼对（阶段二百五十二）**：`loadManifest` 逐个核对顶层键，不认识的名字**硬报错**并点名文件
（`targets.<目标>` 块从阶段八十九·五十 起就是这么做的，顶层一直漏着）。以前拼错一个键不会失败，只会**悄悄少做一件事**：
`link-lib` 少了 `s` ⇒ 库没进链接、之后才报一个无关的 `undefined symbol`；`define` ⇒ 宏没进来、C 照常编过而常量与分支是错的。
报错会尽量给出**近似名**（`link-lib` → `did you mean 'link-libs'?`），或指出它其实是**命令行选项**（`as-class-path` /
`main-class` / `all-sources` 这类没有清单写法的旗标），并附上全部合法键；`$` 前缀的元数据键（如 `$schema`）放行。
仓库自带的 31 份清单全部通过。详见 [`compile.md`](docs/zh-cn/compile.md) §4.4。


## 支持的语言子集

| 类别 | 支持 |
|------|------|
| 类型 | `int`、`uint`、`Number`、`Boolean`、`String`、`void`、`Array`、`Vector.<T>`、`Function`、`RegExp`、`Class`（类引用）、`Dictionary`（对象引用键关联表）、`*`（无类型 → 动态 `any` 装箱）、类名（对象类型）、接口名 |
| 字面量 | 整型、浮点、十六进制（`0xFF`）、字符串（单/双引号）、`true`/`false`、`null`、`Infinity`/`NaN`、数组字面量 `[...]`、对象字面量 `{ ... }`（**键可为数字**：`{0: "a"}`，阶段一百零六）、**E4X XML 字面量** `<a b="1">…</a>`（嵌套/自闭合/属性/注释/CDATA，阶段一百零六；`{expr}` 插值**响亮拒绝**）、正则字面量 `/pattern/flags`、Vector 字面量 `new <T>[...]` |
| 表达式 | 算术 `+ - * / %`、比较 `== != < <= > >=`、逻辑 `&& \|\| !`、一元 `- + ! ~`、位运算 `& \| ^ << >> >>>`、自增 `++ --`（前后缀）、三元 `?:`、**null 合并 `??`**（最低优先级、短路，左侧仅在必要时提升为装箱临时量，阶段一百零六）、**逗号运算符** `(a, b)`（最低优先级、结果取右操作数，阶段一百零六）、**E4X 后代轴** `x..name` / `x..*`（前序、不含自身，阶段一百零六）、**E4X 计算名** `x.ns::[expr]`（孩子轴 ⇒ `XMLList`）与 `x.@[expr]`（属性轴 ⇒ `String`）（阶段一百零八；`ns` 限定词按「命名空间透明」折叠）、类型判断 `is` / 转换 `as`（支持点分全限定名）、强制转换语法 `Type(expr)`（**按类分流**：native Error 家族（`Error`/`TypeError`/…/`SecurityError`）、`RegExp`、`Namespace` 是**构造**（等价 `new`）；其余一切类（含 `flash.errors.*` 与用户 `Error` 子类）是**带运行时检查的强制转换** —— `null`/`undefined` → `null`、同类或子类实例 → 该实例、否则 `TypeError #1034`。**禁止**把它当 C 指针强转：修前 `Error("msg")` 会把字符串体当对象装箱，`catch (e:Error)` 读 vtable 即崩溃；阶段一百五十二）、`typeof`（**阶段一百六十四**：E4X 值有独立档 —— `typeof <a/>` / `typeof <a/><b/>` 是 `"xml"` 而非 `"object"`，静态折叠与 `Object`/`*` 两条运行时分派同一口径）、`delete`、成员存在 `in`、数组索引 `a[i]`、属性访问 `o.x`、复合赋值 `+= -= *= /= %= <<= >>= >>>= &= \|= ^=`、逻辑赋值 `\|\|= &&=` |
| 语句 | 变量声明（含多变量 `var a:T, b:T, c:*;`）、表达式语句、`if/else`、`while`、`do-while`、`for`、**`with (obj) stmt`**（对象成员作为最内层作用域）、`for-in`（数组索引 / 动态对象键 / `Dictionary` 对象引用键）、`for-each-in`（含省略 `var` 的裸标识符迭代形式）、`switch/case/default`、`break`、`continue`、标签语句 `label: while(...){ break label; }`、`return`、`throw`、`try/catch/finally`（**多分支 catch** `catch (e:A) … catch (e:B) …` 按源码顺序匹配、命中即清 `as_exception`、都不中重抛，阶段一百零六；**子句按声明类型过滤**——AIR 实测 `catch (e:Error)` **不**捕获 `throw "oops"`，须 `catch (e:*)`/`catch (e:String)` 才捕获；`catch (e:*)` 与无类型 `catch (e)` 均接受，绑定值**保身份**，阶段一百三十四）、块；`new C`（**省略参数列表**，等价 `new C()`）与 `a[i] \|\|= v` / `a[i] &&= v`（索引目标的短路赋值，接收者/索引须无副作用）；函数内 `arguments`（按需生成的形式参数数组） |
| 函数 | 带类型参数与返回类型的自由函数；**省略参数类型**（按规范默认 `*`，阶段一百零六）；可选参数与默认参数 `function f(a:int, b:int = 1)`；任意类型参数 `function f(message:* = "")`；rest 参数 `function f(...args:Array)`；`Function` 类型与函数值（匿名函数表达式、函数作参数/返回值）；闭包（匿名函数捕获外层局部变量，捕获变量堆分配逃逸） |
| 类 | 字段 + 方法 + 有参构造 + `new` + `this` + 继承 `extends` + `override` 重写（虚表派发） + `super` 调用（含无显式 `super` 时的隐式无参 `super()`）+ `super.property` 属性读·写（字段/getter/setter）+ 访问修饰符 `public/private/protected/internal` + `static` 字段/方法 + `const` 常量 + **一行声明多个字段** `private var a:T = 1, b:T = 2;`（每个声明符一个独立槽位，共享语句的修饰符，阶段一百零八）+ `get/set` 访问器 + `final` 类/方法 + 动态类（`dynamic class`，未声明属性路由到运行时槽表）+ 静态方法作为 `Function` 值（`ClassName.method` 或裸标识符）+ 动态类实例化 `new (expr as Class)()`（经类引用的无参工厂）+ 类体 **`{ ... }` 静态初始化块**与**类体裸语句**（阶段一百零六；顺序按 `adl` 实测：**先**静态字段初始化器按声明顺序、**再**按源码顺序跑类体块）+ 类体内 `import`（容忍并忽略）与多余 `;` + `get`/`set` 可作普通标识符（`var set:int`) |
| 接口 | `interface` 声明（含 **`extends A, B`** 多父接口，方法按父链**传递合并** + 环检测，阶段一百零六）+ `implements` 实现（含 **`implements A, B`**，接口 vtable 派发）+ `is`/`as` 接口类型检查（运行时 `as_iface_lookup`，静态可知为真时才折叠）+ **接口访问器**（`iface.getter`/`iface.setter = v`/`iface.getter()` 零实参的「作方法调用」形态均走接口 vtable 的 getter/setter 槽；带实参的访问器一律响亮报错；阶段一百一十 补齐赋值与作方法调用）+ **接口访问器可由「内建访问器型属性」满足**（阶段一百一十八：继承 `Sprite`/`InteractiveObject` 的 `x`/`y`/`visible`/`alpha`/`mouseEnabled`… 的类即便不写 getter 也满足 `get x():Number; set x(v:Number):void;`，与 AIR 一致——AIR 把这些声明为访问器对；用户的 `public var x` **仍被拒绝**，同样与 AIR 一致） |
| 内建接口 | marker 接口（无成员，签名里只有 `obj` 半边有意义）：`flash.display.IGraphicsData`；`flash.display.IBitmapDrawable` —— 它的两个实现者 `BitmapData` 与 `DisplayObject` 在 AVM2 里**互不继承**，所以 `BitmapData.draw(source:IBitmapDrawable, …)` 必须接受**两族**（阶段二百二十八：形参类型原先误写成 `BitmapData`，于是 `draw(某个 MovieClip)` 每次截图都抛 `#1034`，宿主应用「分享文档/演示」因此永远出不了帧）。静态实参直接过（对象半边就是它本身），动态 `*` 实参走 `as_v_req_drawable` 运行时校验：两族通过、其余抛 AIR 原文 `Error #1034: Type Coercion failed: cannot convert … to flash.display.IBitmapDrawable.`、`null` 合法（不画）；方法体按 vtable 三分支（`TextField` / `DisplayObject` / `BitmapData`），描述符里 `draw` 的第 1 参类型也是 `flash.display.IBitmapDrawable` |
| 包/模块 | 多文件编译（多个 `.as` 合并为一个编译单元）；`package` 命名空间隔离（C 标识符前缀）；`import` 跨文件/跨包短名解析；`internal` 同包可见（跨包拒绝）；自定义命名空间 `public namespace`/`use namespace`/`ns::member`（AOT 编译期透明化，无运行时可见性语义） |
| 根类 | `Object` 内置根类：所有类的隐式基类，`toString()` 返回运行时类名（**`Object` 类型槽按运行时值派发**，阶段二百五十三：槽里的 Array/Dictionary/Vector 都没有 vtable，`is`/`as`/`.length`/成员调用/`delete` 一律按堆种类走 `as_obj_is_array`/`as_obj_as_array`/`as_dyn_call`/`as_dyn_get`/`as_dyn_del`，`is <用户类>` 不再把数据首字当 vtable 读——此前这条是 SIGSEGV；`Object` 自有的 `toString`/`hasOwnProperty`/`propertyIsEnumerable`/`valueOf` 由 `as_dyn_object_builtin` 按种类回答）；`Error` 内置错误类型：`new Error(message, id)`（**无 `new` 的 `Error(message)` 同样构造**，阶段一百五十二）、`.message` 属性；内置错误子类 `TypeError`/`RangeError`/`ArgumentError`/`SyntaxError`/`ReferenceError`；内置 `Date` 类（毫秒时间戳 + 日历访问器）；`flash.events` 事件系统 `Event`/`EventDispatcher`/`MouseEvent`/`KeyboardEvent`/`FocusEvent`/`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent`（`addEventListener`/`dispatchEvent` 捕获→目标→冒泡三阶段、`preventDefault`/`stopPropagation`/`stopImmediatePropagation`；**两条 AIR 注册规则（阶段一百六十一，`adl 51.4.1` 实测）**：① 同一监听器（同函数 + 同接收者 + 同 `useCapture`）**重复注册是空操作**，`removeEventListener` 按同一三元组摘除一个条目；② **`AT_TARGET` 只跑非捕获表**——捕获阶段止于目标的**父节点**，注册在目标自身的 `useCapture` 监听器永不触发；`Event` 补全 `CANCEL`/`CLEAR`/`CLOSE`/`CONNECT`/`COPY`/`CUT`/`DEACTIVATE`/`EXIT_FRAME`/`FRAME_CONSTRUCTED`/`FULLSCREEN`/`ID3`/`INIT`/`MOUSE_LEAVE`/`OPEN`/`PASTE`/`RENDER`/`SCROLL`/`SELECT`/`SOUND_COMPLETE`/`TAB_*`/`UNLOAD` 常量，事件子类（阶段五十九）`TimerEvent`（`TIMER`/`TIMER_COMPLETE`）、`ProgressEvent`（`PROGRESS` + `bytesLoaded`/`bytesTotal`）、`ErrorEvent`（`ERROR` + `text`）、`IOErrorEvent`（`IO_ERROR`，继承 `text`）、`DataEvent`（`DATA` + `data`）、**`ScreenMouseEvent`**（阶段二百五十八：`MouseEvent` 子类，`adl 51.4.1` 实测 **11 参**构造 `(type, bubbles, cancelable, screenX, screenY, ctrlKey, altKey, shiftKey, buttonDown, commandKey, controlKey)` —— `buttonDown` 夹在 `shiftKey` 与 `commandKey` 之间、`localX`/`localY` **不是形参**且默认 `0`（裸 `MouseEvent` 是 `NaN`）；`screenX`/`screenY` **只读**、默认 `NaN`（静态写是编译错、动态写是 `#1074`）；六个常量 `CLICK`/`RIGHT_CLICK`/`MOUSE_DOWN`/`MOUSE_UP`/`RIGHT_MOUSE_DOWN`/`RIGHT_MOUSE_UP`；`clone()` 只带**构造级**字段（`localX`/`delta` 归零）、`toString()` 是 AIR 自己的形状（引号包 `type`、**无 `eventPhase`**）。**默认不派发它**：`adl` 上真实舞台鼠标事件 `is ScreenMouseEvent` 恒 `false`，它只由 `SystemTrayIcon` 派发，而 macOS 的 AIR 无系统托盘（`supportsSystemTrayIcon=false`、`new SystemTrayIcon()` 抛 `#2012`）⇒ 默认与 `TouchEvent` 同属「只由用户代码构造」的事件类；**`--features tray` 下由真实的菜单栏状态项派发** `click`/`rightClick`（带屏幕坐标与修饰键，见 [`enhancements.md`](docs/zh-cn/enhancements.md) §4.11））、**`VsyncStateChangeAvailabilityEvent`**（`VSYNC_STATE_CHANGE_AVAILABILITY` + 只读 `available`（AIR 面，实测恒 `false`）与**只读 `refreshRate`（增强面**：AIR 无任何刷新率 API，见「在 AIR 之外」与 [`enhancements.md`](docs/zh-cn/enhancements.md) §4.8 E16）））；`flash.display` 显示列表 `DisplayObject`/`InteractiveObject`/`DisplayObjectContainer`/`Stage`/`Sprite`/`Shape`/`Graphics`/`Bitmap`/`BitmapData`（层级/坐标/`addChild`/`removeChild`/命中测试/递归渲染（**增删事件与 AIR 逐字对齐**：`added`/`removed` 冒泡、`ADDED_TO_STAGE`/`REMOVED_FROM_STAGE` 对整棵子树先父后子各一次、离台容器只派非舞台事件、`addChild` 一个已有父的对象先经旧父派发 `removed` 再 `added` —— 阶段一百五十五）；**几何与命中（阶段九十四·六）**：`Shape`/`Sprite`/`MovieClip` **都有 `graphics`**（`Sprite`/`MovieClip` 为惰性 getter），`width`/`height` 是**派生访问器**（内容包围盒经自身变换；描边外扩计入，`TextField` 例外——它存真尺寸、getter 报「尺寸 × `scaleX`」），**给 `width`/`height` 赋值是缩放**（`scaleX = scaleX * value / cur`，空内容写 0）；命中测试**变换感知**（父链矩阵逐层折算到局部包围盒，`hitTestPoint` 收**舞台坐标**）；**几何/坐标 API 族（阶段九十四·九）**：`getRect`/`getBounds`（内容包围盒，前者不含、后者含描边；`targetCoordinateSpace == null` ⇒ 自身局部空间、`== self` ⇒ 短接得精确局部盒）、`localToGlobal`/`globalToLocal`（走完整祖先矩阵链、返回新 `Point`、`null` 点抛 `TypeError #2007`）、`hitTestObject`（两个**舞台空间**包围盒求交且含描边、空对象永不相交）与 `hitTestPoint` 均在 **`DisplayObject`** 上（`Shape` 因此也可用）；`MouseEvent.localX/localY` 与文本插入点索引走同一套折算，`as_render_object` 按 `is` 子类型链分派，用户 `Sprite` 子类可作容器、`cacheAsBitmap` 子树位图缓存（toggle 失效重烘焙，烘焙结果与直接递归渲染逐像素一致；增量重绘自动 cacheAsBitmap：静止子树指纹驱动自动烘焙）；`Stage` 舞台属性 `stageWidth`/`stageHeight`/`fullScreenWidth`/`fullScreenHeight`（后两个是**逻辑点（DIP）**，与 `Capabilities.screenResolutionX`/`Y` 同源；而 `flash.display.Screen.bounds` 按 AIR 是**物理像素**——AIR 确实混用两套空间、两套都要照搬，见 [`win32.md`](docs/zh-cn/win32.md) §3.5）/`displayState`/`quality`/`color`/`align`/`scaleMode`/`frameRate`/`vsyncEnabled` 与布尔开关，以及**读写 `focus`**（`InteractiveObject`；赋值即按 `adl` 语义派发 `focusOut`→`focusIn`，是复制的使能条件）（`frameRate` 按 AIR 是**整个应用一个值**：任一窗口/任一 `Stage` 写入即全局生效，帧循环每 tick 只派发**一个应用帧**，不随窗口数叠加——阶段八十九·七十三；`vsyncEnabled` 同为应用级单值、实测默认 `true`，为 `false` 时**去掉「显式 frameRate 高于面板刷新率就封顶」**——阶段一百二十九），常量类 `StageAlign`/`StageScaleMode`/`StageQuality`/`StageDisplayState`）；`flash.display.Screen`（阶段八十九·七十一）：`Screen.mainScreen`/`Screen.screens`/`Screen.getScreensForRectangle(rect)` + 实例 `bounds`/`visibleBounds`/`colorDepth`（静态属性 + 单参静态方法，无 `getScreens()`；`bounds` 是**完整显示模式**、`visibleBounds` 是**可用区**，两者是不同的量）；**每次访问都返回新的包装对象**（`Screen.screens[0] !== Screen.mainScreen`，实测 `adl`），缓存的 `Rectangle` 才是活对象；`new Screen()` 抛 `Error #2012`；`flash.display.NativeWindow` 家族（阶段八十九·七十一，**多窗口**）：`NativeWindow`/`NativeWindowInitOptions` + 常量类 `NativeWindowSystemChrome`/`NativeWindowType`/`NativeWindowRenderMode`/`NativeWindowDisplayState`/`NativeWindowResize`，`new NativeWindow(opts)` 立即开出自己的 OS 窗口（返回时 `visible=false`，默认框 400×232、客户区 400×200，边框大小取自 `NSWindow`）、**每个窗口有独立 `Stage`**（`scaleMode="showAll"`/`align=""`；`frameRate` 是**应用级**单值，新窗口继承当前值而非自带 24fps——阶段八十九·七十三）、`bounds`/`x`/`y`/`width`/`height` 为窗口几何代理、`close()` 走**帧边界延迟收尾**（调用当帧 `closed` 仍为 `false`）并派发 `Event.CLOSE`，另有 `activate`/`minimize`/`maximize`/`restore`/`orderToFront`/`orderToBack` 与 4 个静态 `isSupported`/`supportsTransparency`/`supportsMenu`/`supportsNotification`（**`supportsTransparency` 的后端已成立**，阶段二百五十七：`NativeWindowInitOptions.transparent` 与描述符 `<transparent>true</transparent>` 都真的得到透明窗——**合成步清成 alpha 0** 而不是舞台色（否则「没人画」的区域会被清成不透明的一整片），而 macOS 的呈现本身**不走 SDL 的渲染器**（阶段二百五十九：SDL 的 backing store 不透明，一份 14 行裸 SDL2 程序即可复现，属后端边界）——改为把内容视图做成 layer-hosting 并把每帧装成预乘 `CGImage` 交给宿主 layer，实测窗口 alpha 直方图分裂为 0/235、圆角外真透明；构建加 `-D ASC_WINDOW_VIBRANT` 则在同一 layer 下垫一块 `NSVisualEffectView`，未绘制像素显示**毛玻璃**而非原桌面（这是**刻意的已登记差异**，opt-in、默认关）；`adl 51.4.1` 实测口径是 `nw.transparent`=`true` 而 `stage.color` **仍报 `0xFFFFFFFF`**、未绘制的像素在屏幕上真透明。Windows 与其余后端**未实现**（要 `WS_EX_LAYERED` + 逐帧 alpha）⇒ **响亮报明一次**，不给假透明窗）；**窗口表反查面（阶段一百九十）**：`Stage.nativeWindow`、`NativeApplication.openedWindows`（`Array`，元素与各窗 `stage.nativeWindow` **恒等**）、`NativeApplication.exit()`（走 glue 的正常收尾，`Event.CLOSE` 的派发与顺序不变）、`NativeWindow.menu`（**恒回 `null` 且赋了也不生效**——`adl 51.4.1` 实测 macOS 上 `NativeWindow.supportsMenu`=`false`；`NativeApplication.menu` 是另一件事，见下方 `flash.desktop` 一条）、`orderInFrontOf(w)`/`orderInBackOf(w)`（回 `true`；`null`/自身/已收尾目标回 `false`）、`globalToScreen(point)`（= `bounds` 原点 + 非客户区边框）、`NativeWindowDisplayStateEvent`（`CHANGING`/`CHANGE` + 三个状态常量）；**窗口的几何限制面与事件族（阶段一百九十六，双端孪生探针 `temp/nwmac/` 逐项对 `adl 51.4.1`）**：`minSize`/`maxSize`（默认随 OS：macOS `78,32`/`136,39` Windows、上限恒 `107374182,107374182`；写入按 `[平台地板, 当前对侧上限]` **双向钳制**、getter 每次回**新** `Point`（`w.minSize === w.minSize` 为 `false`）、写下去**立刻改活窗口**）、`startMove()`/`startResize(edgeOrCorner)`（**真系统拖拽**，拖拽中按帧尺寸钳制；最大化/最小化或不可缩放窗口回 `false`）、`resizeToScreen(screen)`（1× 屏 = 该屏 `visibleBounds`；`null` 抛 `#1009`）、`listOwnedWindows()`（`Vector.<NativeWindow>`，元素即 owner 持有的那个窗口对象）、**以及整个窗口事件族**：`resize`/`move`（`NativeWindowBoundsEvent`，`before`/`after` 取**同一帧开始快照** ⇒ 一次同时移动+改尺寸时两条事件是同一对矩形，顺序 `RESIZE → MOVE`）、`displayStateChange`（`NativeWindowDisplayStateEvent`）、`activate`/`deactivate`、`closing`（**可取消**，`preventDefault()` 即不关；程序化 `close()` **不**派 `closing`）、`close`；事件在**帧边界统一结算**（每应用帧对**所有**活窗口各轮询一次，顺序 `deactivate → resize → displayStateChange → move → activate`，窗口管理器发起的关闭只登记请求、真到帧边界才派发）；`supportsMenu`/`supportsNotification` 按 OS 回值（macOS `false`/`false`、Windows·Linux `true`）；**按 AIR 继承 `EventDispatcher`**（阶段八十九·七十二）——故窗口可 `addEventListener`，`Event.CLOSE`/`ENTER_FRAME` 均能送达（这既是 API 形状也是**结构体布局契约**：`listeners`/`parent` 必须在 `_win` 之前，否则 `dispatchEvent` 会读到越界指针而崩溃）；`flash.text` 文本 `TextField`/`TextFormat`（SkParagraph 完整排版：HarfBuzz shaping + UAX#14 换行 + 真实行高，`multiline`/`wordWrap`/`scrollV`/`maxScrollV`/`numLines`/`textWidth`/`textHeight` + `background`/`backgroundColor` 背景填充 + `border`/`borderColor` 边框（默认 `false`/`0x000000`，四条约 1px 实线落在字段盒外沿像素 `x∈{0,width}`/`y∈{0,height}`，画在背景之上、随字段缩放、不计入 `textWidth`/`textHeight`；三个颜色属性都是 24 位 RGB、写入丢弃 alpha 字节——阶段九十四·八）；`TextFormat.align` 水平对齐 `left`/`center`/`right`/`justify` 已落地——有排版宽度时交给 SkParagraph 逐行对齐，`wordWrap=false`（无排版宽度）时按 AIR 的 2px 文字内边距在绘制原点做整块平移，与 AIR 一致地**不开换行也能居中/右对齐**；这正是 Starling `TrueTypeCompositor` 居中原生文字所依赖的行为）；`flash.utils.Dictionary`（`new Dictionary(weakKeys)`：按**对象引用**作键的关联表，支持 `in`/`delete`/`for-in`，弱引用参数接受但不建模，键强持有程序生命周期）；**`ByteArray` 的多字节 / 布尔 / AMF 面（阶段九十四·四）**：`readMultiByte(length, charSet)`/`writeMultiByte(value, charSet)`/`readBoolean`/`writeBoolean`/`readObject()`/`writeObject(object)` + `objectEncoding`（默认 `ObjectEncoding.AMF3`）+ **整数下标读写** `ba[i]`（读空隙为 0；写走 `ToUint32` 低字节、越界自动扩展并零填充、不影响 `position`）；`charSet` 走**系统 `iconv`**（native 构建链接 `-liconv`），`'unicode'`/`'utf-16'` **恒为 UTF-16LE 无 BOM 且 `endian` 属性无效**、`''`/未知字符集回落到 **OS 传统编码**（Apple 为 MacRoman、其余为 CP1252）、目标字符集表达不了的字符**手写 `'?'`**（不依赖 `//TRANSLIT`）、截断的多字节序列**有损解码为空串**、越界读抛 `EOFError #2030`；`writeBoolean` 写 **1 字节**、`readBoolean` **非零即真**；AMF3 对象图编解码器（写 + 读，逐字节对齐 `adl 51.4.1`）覆盖 null/undefined/bool/int（紧凑 U29 形态）/double/String（U29S 长度按 **UTF-8 字节**）/Date/ByteArray/Array（稠密段 + 关联段）/`Vector.<T>`（`0x0d`~`0x10`）/`Dictionary`/typed object（trait 表 + 引用表 + **自身字段先于超类字段**）；**整文件共用一张 AMF3 串表、起始为空，非空字符串值与动态属性名都进表，只有动态成员的结束标记与空字符串不进**（阶段一百五十八：reader 侧漏 intern「非空动态名」会让读真实 `.sol` 时越界丢条目、`refresh_token_timer` 读成 `undefined` 而每次启动都清掉登录会话；writer/reader 把**空串** intern 又会多占一槽，让 AIR 读我们的存档时 `"email":""` 解成 `"mobile"`、`companyList[i].title` 解成 `null` 而抛 `#2007`）；`flash.net.registerClassAlias`/`getClassByAlias` 已接线，别名**沿超类链生效**（实测：以基类名注册的别名会写进子类实例）；`readObject`/`writeObject` 在 `ByteArray` 与 `URLStream` 共用同一编解码器，**AMF0 尚未实现**（`objectEncoding = AMF0` 时**响亮抛错**，不静默按 AMF3 写）；`ByteArray.compress(algorithm)`/`uncompress(algorithm)` 走 zlib（`zlib`/`deflate` 之外的 `algorithm` **响亮抛错**），但 **WASI 目标上两者都响亮抛错**——wasi-sdk 不提供 zlib，`__wasi__` 分支改调 `as_throw_unsupported`，不再静默返回原字节（错的结果比响亮的错误更糟）；`flash.utils.Proxy`（阶段九十四·一）：`dynamic class X extends Proxy` 经 `flash_proxy` 命名空间的十个拦截器接管动态属性访问（`getProperty`/`setProperty`/`deleteProperty`/`hasProperty`/`callProperty`/`getDescendants`/`nextNameIndex`/`nextName`/`nextValue`/`isAttribute`），真槽优先、未覆盖的操作按 `adl` 实测抛 `#2088`…`#2107`；`flash.utils.Timer`（阶段六十）：重复定时器，继承 `EventDispatcher`，构造 `Timer(delay, repeatCount=0)`，`delay` setter 校验负值/非有限抛 `RangeError`；`repeatCount` setter 不校验（`int` 截断，负值保留、`NaN`→0）、`currentCount`/`running` 只读，`start`/`stop`/`reset`；每 interval 派发 `TimerEvent.TIMER`、`repeatCount>0` 耗尽派发 `TimerEvent.TIMER_COMPLETE`、`repeatCount=0` 无限重复；由帧循环 `as_timer_tick` 驱动（离屏用 `tickTimers()` 手动泵，WASI 秒级退化）；`flash.geom` 2D 几何（阶段五十八）`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform`（`Point` 静态 `distance`/`interpolate`/`polar` 与实例 `add`/`subtract`/`offset`/`normalize`/`setTo`/`copyFrom`/`clone`/`equals`/`toString`；`Rectangle` 只读 `top`/`bottom`/`left`/`right` 与 `intersection`/`union`/`contains`/`containsPoint`/`containsRect`/`intersects`/`equals`/`inflate`/`offset`/`clone`/`setEmpty`/`isEmpty`/`toString`；`Matrix` `identity`/`translate`/`scale`/`rotate`/`concat`/`invert`/`transformPoint`/`deltaTransformPoint`/`createBox`/`createGradientBox`；`ColorTransform` 8 通道 + `concat`；`Transform` 持恒等 `matrix`/`colorTransform`，已接线到 `DisplayObject.transform`（`Matrix` 作用于 Skia canvas 变换））；`Vector3D`/`Matrix3D`（阶段七十九，`flash.geom` 3D 几何，纯逻辑不碰 GPU）：`Vector3D` x/y/z/w 四分量（几何运算 `normalize`/`dotProduct`/`crossProduct`/`distance`/`angleBetween`/`length`/`lengthSquared` 仅用 xyz，w 为齐次坐标；`add`/`subtract`/`scaleBy`/`negate` 四分量；`equals(allFour)`、`toString` + 静态常量 `X_AXIS`/`Y_AXIS`/`Z_AXIS`）；`Matrix3D` 4×4 列主序（`rawData` 为 `Vector.<Number>` 列主序 16 元素，`identity`/`append`/`prepend`/`invert`（原位修改返回 `Boolean` 可逆性）/`transpose`/`transformVector`/`transformVectors`/`deltaTransformVector`/`pointAt`/`interpolate`/`recompose`/`decompose`/`copyFrom`/`clone` + 平移/缩放/旋转构造 + 静态 `identity`/`interpolate`，`decompose`/`recompose` 往返一致）；`AGALTranslator`（阶段八十，AGAL 字节码内核，`flash.display3D` 纯静态桥、非 AS3 运行时 API）：`translate(bytes:ByteArray, target:String):String` 把 AGAL1/2/3 字节码翻译成可读 MSL（`"msl"`）或 GLSL ES（`"glsl"`）源码——解析 7 字节头 + 变长指令 token（dest `[num:16][mask:8][type:8]`、source `[num:16][offset:8][swizzle:8][type:8][reltype:8][relsel:16]`、sampler `[num:16][lod:8][0:8][samplerbits:32]`），28 条基础指令带 swizzle/write-mask 展开 + AGAL2 控制流（`ife`/`ine`/`ifg`/`ifl`/`els`/`eif`）+ 导数（`ddx`/`ddy`）+ `tex` 采样；寄存器 type 为 shader 相对编码（`vc=fc=1`、`vt=ft=2`、`op=oc=3`、`fs=vs=5`）按 vertex/fragment 分派；基础校验（magic/version/opcode/截断/指令数）失败抛 `Error`）；`Stage3D`/`Context3D`（阶段八十一~八十三，`flash.display3D` CPU 状态机 + 可选 Metal GPU 后端）：`Stage.stage3Ds` 返回 `Vector.<Stage3D>`（单槽位），`Stage3D.requestContext3D(mode)` 懒创建 `Context3D` 并同步派发 `Event.CONTEXT3D_CREATE`、`context3D`/`x`/`y`/`visible` 读写；`Context3D` 状态机 `configureBackBuffer`/`setBlendFactors`/`setDepthTest`/`setCulling`/`setStencilActions`/`setScissorRectangle`/`setStencilReferenceValue`/`setProgram`/`setVertexBufferAt`/`setTextureAt`/`setProgramConstantsFromMatrix`（transposed=false 时列主序转置为行主序上传、true 时原样拷贝）/`setProgramConstantsFromVector`（AGAL3，`Vector.<Number>` 上传 vc/fc；`numRegisters` 缺省 `-1` 表示按 vector 长度取寄存器数——Starling 的 `BlurFilter`/`ColorMatrixFilter` 正是只传 vector，见阶段八十九·二十一）/`createVertexBuffer`/`createIndexBuffer`/`createProgram`/`createTexture`/`createCubeTexture`/`createRectangleTexture`/`setCubeTextureAt`/`setRectangleTextureAt`/`drawTriangles`/`drawTrianglesInstanced`（AGAL3 实例化）/`clear`/`present`/`drawToBitmapData`/`setRenderToTexture`/`setRenderToBackBuffer` + 只读 `driverInfo`/`profile`/`maxBackBufferWidth`/`maxBackBufferHeight`；资源类 `VertexBuffer3D`/`IndexBuffer3D`（`uploadFromVector`/`uploadFromByteArray` 记录 CPU 拷贝，后者读小端 float32/uint16 宽化进 vector）/`Program3D`（`upload` 记录字节码）/`Texture`/`TextureBase`（`uploadFromBitmapData` 记录源 `BitmapData` 并**同步上传** GPU 纹理，见下；`miplevel != 0` 时按 adl 实测的**区域规则**上传该级——取**源位图左上** `lw×lh`（`lw = max(1, width>>level)`，按**源的行距**读）、自 `max(width,height)` 算层数并拒绝超界级，同时置位该纹理的「有链」标记；阶段一百二十八）/`CubeTexture`（六面 `BitmapData` 描述符）/`RectangleTexture`（NPOT 单面描述符；`createRectangleTexture(..., optimizeForRenderToTexture=true)` 会真正分配可作渲染目标的 GPU 纹理——Starling `Texture.empty(...)` 的非压缩/非 mip 纹理全走此路径，滤镜离屏通道依赖它，见阶段八十九·二十一）；`Texture.uploadCompressedTextureFromByteArray`（阶段八十九·二十一）：ATF 容器里 `format 3/5`（裸 DXT1/DXT5）在 CPU 解码为**直通 alpha** 的 ARGB 后走普通纹理上传路径（不预乘，与 adl 把裸 DXT5 交给 GPU 一致），其余 format/立方图**响亮抛 `Error #3680`**（不静默出空图）；16 个常量类 `Context3DBlendFactor`/`Context3DBufferUsage`/`Context3DClearMask`/`Context3DCompareMode`/`Context3DCubeMapFace`（int）/`Context3DFillMode`/`Context3DMipFilter`/`Context3DProfile`/`Context3DProgramType`/`Context3DRenderMode`/`Context3DStencilAction`/`Context3DTextureFilter`/`Context3DTextureFormat`/`Context3DTriangleFace`/`Context3DVertexBufferFormat`/`Context3DWrapMode`；**GPU 后端（阶段八十二~八十三）**：构建清单定义 `ASC_RENDER_STAGE3D=1` + 链接 `vendor/stage3d_glue.mm`（裸 Metal：`MTLBuffer` 顶点/索引/常量、`MTLTexture` 2D、MSL 编译、离屏 render-to-texture）时，`drawTriangles`/`drawTrianglesInstanced` 作为唯一同步点延迟上传所有绑定资源并 `drawIndexedPrimitives` 上屏（实例化走 `instanceCount`）；**一帧的 draw 合批成一条 `MTLCommandBuffer`、帧边界只提交+等待一次**（阶段一百零四：原先每条 `drawTriangles` 都 `commit` + `waitUntilCompleted`，实测 `cpu=0.01ms/gpu=0.04ms` 而 `wait≈0.5ms` ⇒ 那 0.5ms 是纯往返延迟，Starling 开 fps 监控时每帧多 1.6 条 draw 就直接吃掉 0.8~1.0ms/帧；合批后 `draws/batch` 7~9、`wait` 0.93ms **每帧**，Benchmark 峰值对象数 **+39%**、开关 stats 的差距由 −14% 收窄到 −6%）；**混合状态（阶段八十九·二十二）**：Metal 把 blend state 烘进 `MTLRenderPipelineState`（无逐绘制设置接口），故 glue 保留已编译的 vertex/fragment 函数并**按 blend 因子对缓存管线**，每次编码绘制时按当前 `setBlendFactors` 选择（缺失则懒建，LRU 上限 12）；**深度/模板状态同样按键值 LRU 缓存**（`S3D_MAX_DSS` 槽 + `s3d_select_dss`，away3d 逐 draw 交替 depth 状态时不再每 draw 新建一个 `MTLDepthStencilState`——实测 `dss=2` over 1680 draws，阶段一百二十八）——同一 `Program3D` 上中途改混合模式由此真正生效（Starling `Blend Modes` 场景此前标签在变、图像不变）、`drawToBitmapData` 读回当前渲染目标像素（render override 优先，ARGB↔BGRA 转换），否则纯 C 模式仅为状态机（`as_s3d_*` no-op 包装保持 link-clean）；**web 目标（阶段八十九·三十）**：同一份生成 C 在浏览器里改链接 `vendor/stage3d_webgl.cc`（WebGL2/GLES3）+ 构建期 `ASC_S3D_GLSL=1`，着色器由同一个 AGAL 翻译器出 GLSL ES（`ASC_AGAL_TARGET` 构建期选 MSL/GLSL）——`s3d_*` 签名两端完全一致，故 `Context3D` 状态机与 `as_s3d_*` 包装器零改动；GL 侧的 Y 轴翻转（顶点阶段 `gl_Position.y = -gl_Position.y`，使纹理 `v=0` 与读回行序都与 AS3 一致）、BGRA↔RGBA 交换、逐寄存器 `uniform vec4 vcN/fcN`、`DEPTH24_STENCIL8` 离屏 FBO 与前后模板分离 API、按纹理对象缓存采样器状态、与 Ganesh 共享单一 WebGL2 上下文（每个触碰 GL 的 `s3d_*` 入口调 `sk_gr_reset_context()`）均在 `vendor/stage3d_webgl.cc` 内处理，`examples/air-starling-demo` 的 12 个场景在浏览器里逐场景渲染且与 AIR `adl` 参考一致（120 fps / 0 丢弃；见 `docs/zh-cn/html5-web.md` §3.3）；上屏当前走 CPU 读回（`as_s3d_readback_render` + `as_skia_canvas_draw_bgra`，实测占单帧 CPU 成本 ~98%），GPU 直连列为后续优化；**纹理上传时序（阶段八十九·十八）**：`uploadFromBitmapData` 在 AIR 里是**同步**上传，调用方随即 `BitmapData.dispose()` 是合法写法——故 AOT 也在 `uploadFromBitmapData` 里**立刻**建好 `MTLTexture`（`Texture` 记下 `Context3D` 的 glue 句柄，经 `s3d_texture_from_pixels` 创建但不绑定采样槽，`Context3D_submit` 再按槽位 `s3d_bind_texture`），而不是把上传推迟到下一次 `drawTriangles`（推迟会让 `dispose()` 后的 `pixels` 已被 free 而读空/读到超期数据：Starling 逐字光栅化即「draw → fromBitmapData → dispose」，曾因此让文字纹理根本没上传、采样槽残留上一次的图集内容而渲染成彩色乱码）；`flash.filters` 滤镜（阶段六十一）`BitmapFilter`（抽象基类，`clone()`）/`BlurFilter`（`blurX`/`blurY`/`quality` + `clone`）/`DropShadowFilter`（`distance`/`angle`/`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout`/`hideObject` + `clone`）/`GlowFilter`（`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout` + `clone`）+ 常量类 `BitmapFilterQuality`（`LOW`/`MEDIUM`/`HIGH`）；`DisplayObject.filters` 读写（`Array` 存取）；`BitmapData.applyFilter`（`BlurFilter` 经可分离盒式模糊落地，`DropShadowFilter`/`GlowFilter` 光栅化延后抛错）；`flash.display` 补齐（阶段六十二）`MovieClip`（`currentFrame`/`totalFrames` + `play`/`stop`/`gotoAndPlay`/`gotoAndStop`，帧循环驱动，`currentFrame` 越界回绕到 1，`totalFrames` 可写以模拟多帧时间轴；**SWC 皮肤的三种按钮态（阶段一百七十一，`adl 51.4.1` 实测）**：`buttonMode == true` **且**时间轴上有 `_up`/`_over`/`_down` 三个 `FrameLabel` 的 `MovieClip` 就是 AIR 内建的按钮 —— 滚入/按下/滚出把播放头**真的**移到对应标签帧（`currentFrame`/`currentLabel` 同步、帧脚本跟着跑），按压**锁在 `mouseDown` 的那个对象**上（在别处按下再拖进来只有 `_over`，在这里按下再拖出去仍 `_down`），松开按指针是否在内回 `_over`/`_up`；门是 `buttonMode`，只有标签不生效；状态在绘制/指纹 pass 结算，故离屏程序需走一帧 `stage.render`）/`SimpleButton`（`upState`/`overState`/`downState`/`hitTestState` 四状态引用；**`upState == NULL` 时什么都不画**且 `width`/`height`/`getRect` 全 `0`，命中也**不按包围盒**判定（`hitTestPoint(shapeFlag=true)` 在 AIR 对 `SimpleButton` 恒 `false`）——阶段一百五十 按 adl 实测校正；**鼠标拾取单独走 hit 态几何**（`hitTestState ?: upState` 的**区域**，与 hover 同一谓词）：只有 down + hit 两条记录的「隐形点击靶」按钮因此可点，而 `hitTestPoint(x, y, false)` 仍报包围盒（无 up 态就是 0×0）——阶段一百五十七）/`Loader`（`content`/`contentLoaderInfo` + `load(url)` 异步派发 INIT（同步）/COMPLETE（下一帧 tick）；`http(s)://` 的 URL **显式识别**并走与 `URLLoader` 同一条传输 seam——native + `ASC_HAVE_CURL` 在 worker 上 `as_http_perform` / web + `ASC_HAVE_FETCH` 启动 `fetch` 并在帧边界 pump 里解码（阶段八十九·五十六 接通 web 侧，此前 web 上这个分支只有 curl 实现，每个远程 `Loader.load` 都在**一次请求都没发**的情况下报「本构建没接 HTTP 后端」），无后端派**可区分**的诚实 `ioError`；跨源图片在浏览器里受**同源策略**约束：图片能*显示*但读不到像素，而 Skia 上屏需要像素，故 CDN 必须回 `Access-Control-Allow-Origin`，否则如实报 CORS `ioError`）/`LoaderInfo`（`bytesLoaded`/`bytesTotal`/`url` + `COMPLETE`/`INIT`/`OPEN`/`UNLOAD`/`PROGRESS`/`IO_ERROR` 常量）；`flash.net`/`flash.ui`（阶段六十三，API 面于阶段八十九·四十八 补齐；`http(s)://` 联网于八十九·四十九 **opt-in** 接入）`URLRequest`（**AIR 全属性面**：`url`（默认 `null`）/`method`（默认 `"GET"`，**按 AIR 不区分大小写**：属性保留写入时的拼写，上线动词规范成大写，且「`data` 折成 query 还是进 body」与它同一条大小写无关规则——阶段一百五十四；小写 `'get'` 曾原样发给服务端换来 405 ⇒ `#2032`）/`data`（`any`，默认 `null`）/`contentType`（**默认 `null`**，adl 实测；文档印的 `application/x-www-form-urlencoded` 是**发包默认**而非属性值——体非空的请求未声明时才发那个 MIME 串，无体请求一个都不发，阶段八十九·六十九）/`requestHeaders`（默认**空 `Array`**，可直接 `push`）/`authenticate`/`cacheResponse`/`followRedirects`/`manageCookies`/`useCache`（均默认 `true`）/`idleTimeout`（默认 `0`）/`userAgent`（按 OS 派生的 Flash/AIR 形态 UA 串）/`digest`；后 6 项按官方「initialized from the `URLRequestDefaults.X` property」在构造时从 `URLRequestDefaults` 读入 + 实例方法 `useRedirectedURL(sourceRequest, wholeURL=false, pattern=null, replace=null)`（先按 `wholeURL` 做域名/整段替换，再对结果做 `pattern`→`replace`，String 与 RegExp 两种 `pattern` 都支持））/`URLRequestMethod`（`GET`/`POST`/`PUT`/`DELETE`/`HEAD`/`OPTIONS` 六常量）/`URLRequestHeader`（`name`/`value`，构造器默认 `""`/`""`）/`URLRequestDefaults`（7 个静态属性 `authenticate`/`cacheResponse`/`followRedirects`/`idleTimeout`/`manageCookies`/`useCache`/`userAgent`，读写与 AIR 默认值一致；`setLoginCredentialsForHost` 延后——需认证型 HTTP 栈）/`URLLoader`（`data`/`dataFormat`/`bytesLoaded`/`bytesTotal` + `load(request)`/`close()`，继承 `EventDispatcher`，构造器 `URLLoader(request=null)` 传参即开始加载；异步（下一帧 tick）；`file://`/相对路径读本地文件，`http(s)://` 在 native + `ASC_HAVE_CURL`（构建清单 `link-libs: ["curl"]`）时**真联网**（GET/POST/状态码/HTTPS），无后端时派**可区分**的诚实 `ioError`；事件顺序 `open`（仅当请求到达传输）→ `progress` → `httpStatus`（**只带 `status`**；本地/无后端加载为 `0`）→ `complete`（失败：`httpStatus(0)` → `data` 空值 → `ioError`）；`data` 按 `dataFormat` 发布为 GC 跟踪字符串（text）/`ByteArray`（binary）/`URLVariables`（variables）；`bytesLoaded`/`bytesTotal` 在加载中恒 `0`、完成时置为字节数（AIR 口径）；`close()` **真中止**在飞加载（此后不再派任何终态事件），无流时抛 invalid stream error）/`URLVariables`（`dynamic class`，未声明字符串键属性写入运行时槽表，`toString()` 序列化为 query string——转义集**只有 `[A-Za-z0-9]`**（不是 `encodeURIComponent` 的口径：`-` `_` `.` `~` 也编码），**键与值两半都编码**，缓冲按**编码后**长度求和分配（阶段一百五十三 修掉的堆溢出正是因为按原始长度分配）；`decode(source)` 把 query string 解码进实例——这是 **form 解码**（`application/x-www-form-urlencoded`），`%XX` **与字面 `+`** 在**两半都解**，**键也解**（`"a%20b=c%20d"` 的往返只有键被解码才闭合——阶段一百五十四 adl 实测））/`Keyboard`（静态键码常量表 `A`~`Z`/`NUMBER_0`~`NUMBER_9`/`SPACE`/`ENTER`/`TAB`/`ESCAPE`/`BACKSPACE`/`DELETE`/`SHIFT`/`CONTROL`/`LEFT`/`RIGHT`/`UP`/`DOWN` + **静态方法** `isAccessible()`（实测经 `adl` 51.4.1：它是**方法**而非只读属性——`Keyboard.isAccessible` 不带括号得到的是 `Function`、`describeType` 报 `method`））/`Mouse`（静态 `hide`/`show` + 可写 `cursor`/只读 `supportsCursor`/`supportsNativeCursor`）；`flash.filesystem`（阶段六十四）`File`（`nativePath` + 只读属性 `url`（`file://` 形式）/`exists`/`isDirectory`（getter，经 `stat()`）/`isSymbolicLink`（getter，经 **`lstat()`** ——`File` 家族里**唯一不跟随链接**的谓词：`isDirectory` 回答**目标**、它回答**链接本身**，故「目录软链」两个都真、「悬空软链」`exists=false` 而它 `true`；Windows 走 `FILE_ATTRIBUTE_REPARSE_POINT`，因此 NTFS junction 同 AIR 也报 `true`；阶段二百六十二 补，见 [`filesystem.md`](docs/zh-cn/filesystem.md) §6）+ `resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory(recursive)`（**删除、移动、`size` 与路径归一化的口径逐条对 `adl 51.4.1` 实测**，阶段二百九十八：`deleteFile` 目标不存在 `#3003`、是真实目录 `#3006`；`deleteDirectory(false)` 非空 `#3010`、不递归时是文件 `#3007`、`(true)` 递归且**文件路径也能删**；`moveTo` 只有**两个**参数（AIR 不接受第三个）、`null` 目标抛 `TypeError #2007`、目标已存在且 `overwrite=false` 抛 `#3012`、**自动建父目录**、成功后 **`nativePath` 不变**；对软链只动**链接本身**（悬空链接可删）、递归**不跟随**链接；异步成员失败派 `ioError` 且 `errorID` 与同步一致、`#2037` 仍**同步抛出**；`size` 对缺失路径抛 `#3003`、**对目录回 `0`**；`nativePath` 有真 setter，相对路径/空串/URL 形式抛 `#2004`、`null` 抛 `#2007`；`as_path_norm` 是**词法**归一化且**两个平台都做**——折叠 `//`、丢弃 `.`、消去 `..` 并在根处夹紧、末尾分隔符丢弃（POSIX 下反斜杠是合法文件名字节）——见 [`filesystem.md`](docs/zh-cn/filesystem.md) §12） + **`getDirectoryListing`/`getDirectoryListingAsync`**（目录列举的**同步/异步两套口径**，阶段二百六十四 逐条对 `adl 51.4.1` 实测：异步成员**真异步**——枚举在作业池 worker 线程上跑、帧边界派发，2 万条目目录的调用 **0 ms** 返回（`adl` 事件约 **10.6 s** 后到）、**调用之后**注册的监听器照样收得到、`File.cancel()` 真的丢弃在飞的那一次；同步成员则**抛异常**——空 `File` `#2037`、路径不存在 `#3003`、存在但不是目录 **`#3007: Not a directory.`**；**唯一两边都不抛的形状是不可读目录（EACCES）**：都回**空表**（`adl` 实测如此，清理类程序不能把它当失败）。两者抵达顺序相同且**都不排序**。见 [`filesystem.md`](docs/zh-cn/filesystem.md) §7）+ **`moveToTrash`/`moveToTrashAsync`**（移入系统废纸篓，阶段二百四十三；语义逐条对 `adl 51.4.1` 实测：声明为 **`void`**（参考文档写的 `Boolean` 是错的——`f.moveToTrash().toString()` 在 `mxmlc` 编译期就报错、`adl` 求值是 `undefined`）、路径不存在抛 `#3003`、文件系统拒绝（EPERM）抛 `#2038`、空 `File` 抛 `#2037`、**成功后 `nativePath` 不变**而 `exists` 转 `false`、已在废纸篓里的项是成功 no-op、同名冲突按 macOS 口径变成 `原名 <HH-MM-SS-mmm><扩展名>`；`moveToTrashAsync` 把同样的失败派成 `ioError`（`errorID=3003`）而非抛异常；废纸篓目录按卷选择 `~/.Trash` / `<卷>/.Trashes/<uid>`，其他 POSIX 走 freedesktop 的 `Trash/{files,info}`，Windows 走回收站（`SHFileOperationW` + `FOF_ALLOWUNDO`，阶段二百四十四；wasm 无废纸篓概念、**响亮报明**）——见 [`filesystem.md`](docs/zh-cn/filesystem.md)）+ 静态只读 `applicationStorageDirectory`/`applicationDirectory`/`desktopDirectory`/`documentsDirectory`/`userDirectory`（后者经 `getenv("HOME")` 运行时解析）+ 静态只读 **`separator`/`lineEnding`**（**宿主**平台的路径分隔符与行尾：Windows `\` + CRLF、POSIX/WASI/浏览器 `/` + LF；值是目标平台的属性、故由运行时助手给出而非编译期折成字面量——阶段二百一十八），POSIX `stat`/`mkdir`/`remove`）/`FileStream`（`open`/`openAsync`（异步派发 `ProgressEvent.PROGRESS` + `COMPLETE`）/`close`/`readUTFBytes`/`writeUTFBytes` + 只读 `position`/`bytesAvailable`，`FILE*` 句柄为不透明 `void*` 非 GC 跟踪）/`FileMode`（`READ`/`WRITE`/`APPEND`/`UPDATE` 常量）；`flash.desktop` 图标族与原生菜单（阶段二百五十五，`adl 51.4.1` / macOS 逐项实测）：`Icon`（**可实例化**）/`InteractiveIcon`/`DockIcon`/`SystemTrayIcon`（后三者 `new` 抛 `#2012`；`bitmaps` 默认 `null`、赋非 `BitmapData` 抛 `#2005`、置 `null` 抛 `#2007`、getter 每次回**新** `Array`、`width`/`height` 取逐轴最大值且清空后保持旧值；`bounce(null)` 抛 `#2007`、未知优先级不抛；`SystemTrayIcon.MAX_TIP_LENGTH=63`）、`NativeApplication.icon`（**只读**、进程内单例）/`menu`（可整条替换；`= null` 在 `adl` 上**崩溃**，我方**报明并保持原状**）/`autoExit`（**真行为**：`false` 时无可见窗口也驻留，帧循环条件是 `sk_any_open() || !auto_exit`）与五个能力位（`supportsDockIcon`/`supportsMenu` 在 `ASC_USE_WINDOW && __APPLE__` 时为 `true`；`supportsSystemTrayIcon`/`supportsStartAtLogin`/`supportsDefaultApplication` **恒 `false`**（`supportsSystemTrayIcon` 在 `--features tray` 下为 `true`）——**刻意比 AIR 报得少**：能力位描述的是**本后端真有什么**，报 `true` 会让 `if (supportsX)` 变成静默 no-op）、`flash.display.NativeMenu`/`NativeMenuItem`（`isSupported` 是**静态**成员、实例读抛 `#1069`；重复 `addItem` 静默 no-op 而重复 `addItemAt` 抛 `#2004`、外来项 `removeItem` 与越界 `getItemAt` 抛 `#2006`、`null` 参抛 `#2007`、`getItemByName` **只认 `name`**、`items`/`bitmaps`/`keyEquivalentModifiers` 的 getter 全是拷贝、`keyEquivalentModifiers` 只留 `15..20` 升序去重、`clone()` 不复制 `data`、子菜单 `parent` 随 `addItem`/`removeItem` 变更；点击让 **item 与所属 menu 各收一次 `SELECT`**）。**macOS 接线**：菜单以**扁平 `sk_menu` 描述**穿过胶水边界（子菜单是下标），点击按 1 基 tag 回到 `as_menu_click_cb`；**生成代码绝不调 `+[NSApplication sharedApplication]`**（在 SDL 视频初始化之前调它会让进程活着但**一个窗口都不建**）⇒ 只读 `extern id NSApp`，拿不到就把安装**排队**到事件循环首轮；AppKit/SDL 会在 launch 后装自己的主菜单，故事件循环每帧 `sk_menu_ensure()` 做指针比较后重新 `setMainMenu:` / 重挂 `applicationDockMenu:`。**Dock 图标上屏（阶段二百五十六）**：`DockIcon.bitmaps` 真的会经 `-[NSApplication setApplicationIconImage:]` 画到 Dock 上，而「AIR 用哪张」是**实测**出来的（`temp/dockprobe/`：纯色位图 + 截屏取色）——`{32,96,256}→96`、`{16,512}→16`、`{160,64}→160`、`{127,129}→127`、`{129,127}→129`、`{128×400, 200×200}→200×200` 一致指向**取 `|max(width,height) − 128|` 最小的一张、并列取更早的那张**；重新赋值**立刻重绘**、`bitmaps = []` 恢复默认应用图标。像素以直通 ARGB 穿过边界，由 Cocoa 胶水**预乘**（不预乘会让透明像素画出自己的颜色）。**平台边界（各报明一次）**：`keyEquivalentModifiers` **未翻译成 `NSEventModifierFlags`**、`display()` 没有模态菜单后端（两者登记在 `TODO.md` 遗留表）；半透明像素只合成**一次**（正确），`adl` 实测会多乘一次 alpha（同一张 50% 蓝 `183.6` vs `adl` `122.3`，属**刻意不跟的已登记差异**，不透明像素逐字节相同）；另有 AppKit 的**主菜单第一项会被当作应用菜单并用应用名覆盖标题**（`adl` 不受影响只因它自己占着那个槽）。口径全文 [`desktop.md`](docs/zh-cn/desktop.md)；`flash.net.SharedObject`（阶段八十九·四十）：`SharedObject.getLocal(name, localPath?)` 返回**本地共享对象**（继承 `EventDispatcher`，`fqn` = `flash.net::SharedObject`，**非 dynamic**，与 AIR 一致地对未声明属性赋值抛 `ReferenceError #1056`），`data` 为只读 getter 的 `Object`（键值表，可 `data[k]` 读写/`delete`/`for-in`），`size` 返回将被持久化的表示的字节数、`flush()` 返回 `SharedObjectFlushStatus.FLUSHED`(`"flushed"`)/失败响亮抛错、`clear()` 清空数据**并删除磁盘文件**、`close()` 对本地对象无副作用（空实现）、`setDirty()` 空实现、`setProperty` 写 `data`；**同名 `getLocal` 返回同一实例**（进程内实例表，静态字段作永久 GC 根）；`defaultObjectEncoding`/`preventBackup`/`client`/`objectEncoding`/`fps` 访问器与 `ObjectEncoding`(`AMF0=0`/`AMF3=3`/`DEFAULT=3`)、`SharedObjectFlushStatus`(`FLUSHED`/`PENDING`) 常量类均按 AIR 实测值建模；**持久化**按 AIR 的原路径原格式写到 `<applicationStorageDirectory>/#SharedObjects/[<描述符 content>/][<localPath>/]<编码名>.sol`（应用域由描述符 `<id>` 限定：`ASC_APP_ID`/`ASC_SWF_PATH` 经 `--air-app` 注入），字节 = AIR 的 AMF3 容器（`00 BF`+`TCSO`），**两个运行时互相读得到对方的存档**（阶段一百五十 建立、阶段一百五十八 双向真机闭环：见 [`flash-net.md`](docs/zh-cn/flash-net.md) §6.9；名字编码按 AIR 实测规则「末 27 字符 + `.sol`，其余前缀从尾部按 30 切 `#` 目录」；`size` = `.sol` 序列化字节数、空表为 `0`），并在**应用退出时自动落盘**（`atexit` 钩子，对齐 AIR「关闭应用时写入本地共享对象」的行为——即使从未调用 `flush()`）；`getRemote`/`connect`/`send` 需要在Flash Media Server 上运行，本运行时**响亮抛错**（不静默假装成功） |
| 内建 | `trace(...)`；`Array` 方法 `push/pop/shift/unshift/splice/slice/indexOf/join/concat`、`.length`；`String` 方法 `charAt/charCodeAt/indexOf/lastIndexOf/substring/substr/slice/split/match/search/replace/toUpperCase/toLowerCase/concat/localeCompare/valueOf/toLocaleLowerCase/toLocaleUpperCase/startsWith/endsWith`（**动态接收者同表**，阶段二百一十七：`*`/`Object` 槽里的字符串走 `as_str_dyn_call`，且 `toLocaleLowerCase`/`toLocaleUpperCase` 必须与 `toLowerCase`/`toUpperCase` **同实现** —— AVM2 在 `core/String.as` 里就是把前者写成后者的别名；此前动态表漏了这两个别名，`d.name.toLocaleLowerCase()` 得 `null`、下一句 `indexOf` 抛 `#1009`，真应用的屏幕共享列表因此冻结）、静态 `String.fromCharCode`、`.length`；`Number`/`int`/`uint` 方法 `toFixed/toExponential/toPrecision/toString(radix)/valueOf`、`Number` 静态常量 `MAX_VALUE/MIN_VALUE/NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY`、`int`/`uint` 静态常量 `MAX_VALUE/MIN_VALUE`；`Math` 常量 `PI/E/LN10/LN2/LOG10E/LOG2E/SQRT1_2/SQRT2` 与方法 `abs/floor/ceil/round/sqrt/pow/min/max/random/sin/cos/tan/asin/acos/atan/atan2/exp/log`；全局函数 `parseInt/parseFloat/isNaN/isFinite`（`parseInt`/`parseFloat` 按 **ES3 前缀解析**：`parseInt(s, radix)` 支持 2~36 进制、`radix=0` 自动识别 `0x`/`0X`、前导零按十进制、坏 radix 或无数位得 `NaN`、返回 `Number`；`parseFloat` 取最长十进制前缀并忽略尾垃圾，`"Infinity"` 大小写敏感——阶段一百三十四）；`flash.utils.getTimer()`（自进程启动以来的毫秒数，非 Unix 时间戳，60Hz 帧循环计时用）；`flash.utils.setTimeout(closure, delay)` / `flash.utils.clearTimeout(id)`（调度/取消一次性函数回调，`delay` 毫秒后由帧循环触发，返回 `uint` 定时器 id；回调经函数值闭包绑定）；`flash.utils.setInterval(closure, delay, ...args):uint` / `flash.utils.clearInterval(id)`（阶段九十四·三）：与 `setTimeout`/`clearTimeout` **共用同一张表与同一个 id 计数器**（实测连续调用 id 为 `1,2,3…`），故两者**互为取消**（`clearInterval` 能取消 timeout 的 id、`clearTimeout` 能取消 interval 的 id），未知/0 的 id 是静默空操作；重复定时器**在回调结束后**再排下一次、每帧至多触发一次，在自身回调里 `clearInterval` 即停；负/NaN 延迟抛 `RangeError #2066`；`null` 闭包仍消耗 id 且永不回调；`flash.utils.getQualifiedClassName(value:*):String`（阶段八十六，反射：返回对象完全限定类名 `包::类`，原始类型返回 `"null"/"Number"/"Boolean"/"String"/"void"/"Array"/"Function"`）与 `flash.utils.getQualifiedSuperclassName(value:*):String`（阶段九十四·三：取值的类的**超类**限定名，多层链逐层上推，无超类时返回 **`null`**）与 `flash.utils.getDefinitionByName(name:String):Object`（按名返回类引用，与前者构成往返闭环，支持 `::`/`.` 两种分隔符；阶段一百二十七起**内建类也在注册表**（`getDefinitionByName("flash.display.BitmapData")` 可用），找不到抛 AIR 的 `Error #1065: Variable <末段> is not defined.`（`errorID` = 1065）；`describeType(value):XML` 返回按 `adl 51.4.1` 对齐的完整描述树（`<type>`/`<extendsClass>`/`<implementsInterface>`/`<variable>`/`<constant>`/`<accessor>`/`<method>`/`<parameter>`/`<factory>`；实例与类两态、`@name`/`@type` 用 `::`、只列 public 成员，阶段一百八十六已完整落地）；E4X `XML`/`XMLList`（极小 DOM 解析器；属性轴 `@attr`、孩子轴 `.child`、后代轴 `x..name`、过滤谓词 `.(@a=="v")`、计算名 `ns::[expr]`/`@[expr]`、`localName`/`length`/`is`/`as`、`toXMLString()`、`describeType` 的 XML 树）：`XML(value)` 接受 **String / XML / XMLList / ByteArray**（动态值分支实测对齐 `adl` —— `XML(byteArray)` 把字节按 UTF-8 解析，正是 `[Embed(mimeType="application/octet-stream")]` 资源类的惯用法，阶段一百四十三），`toString()` 取 E4X **字符串值**而非标记（无元素子节点的元素给其文本、有元素子节点给标记；`XMLList` 0 项给 `""`、1 项委托给该项、≥ 2 项给各项标记按换行连接 —— AIR 实测口径），**`toXMLString()` 取标记**且按 AIR **重新缩进**（**恰好一个**文本/CDATA 子节点才单行内联、否则每行一项 / 每层 2 空格 / 闭合标签回本层，剪掉纯白空格文本节点、属性一律双引号；`XMLList` 0 项给 `""`、否则各项标记按换行连接 —— `adl` 实测逐字一致，阶段一百九十三/二百零八）；**文本节点是一等节点**（`new XML("plaintext")` 不报错：`nodeKind()` 为 `"text"`、`localName()`/`name()` 为 `null`、`toString()`/`toXMLString()` 为其值、`text()` 为 `""`）、**混合内容按文档序交错**（`<a>a<b/>b</a>` → 三行；`children()`/`.*`/`..*` 含文本节点、`elements()` 不含）且**实体在解析期解码**（五个命名实体 + `&nbsp;`→**U+FFA0** + `&#DDD;`/`&#xHHH;`（仅 ≤ U+FFFF），未知实体与超 BMP 引用原样保留）、**序列化期按上下文转义**（文本 `&`/`<`/`>`；属性值另加 `"` 与 `&#x9;`/`&#xA;`/`&#xD;`，CDATA 内容字面量且仍以 CDATA 重发）—— 解析失败按 `adl` 分 `#1085`/`#1088`/`#1090` 三类（阶段二百零八），且**经动态槽**（`Object`/`*`/数组元素/`Dictionary` 值/动态属性/`Object` 形参）的 `XML`/`XMLList` 同样给字符串值而非 `[object XML]`（阶段一百四十四：真应用的登录页文案全经动态查表，曾**每一条**都渲染成 `[object XML]`）；`flash.system.System` 内存统计（`totalMemory`(`uint`)/`totalMemoryNumber`(`Number`)/`freeMemory`(`Number`)/`privateMemory`(`Number`) 四个纯静态只读属性：`totalMemory` 为运行时自管堆已用字节（超 4 GiB 返回 0），`totalMemoryNumber` 同值不 clamp，`freeMemory` 为 arena 已申请未用缝隙，`privateMemory` 为真实进程常驻内存（macOS `mach_task_basic_info`/Linux `getrusage`×1024/Windows `GetProcessMemoryInfo`/WASI 退化为 `totalMemory`）；**`System.exit(code:uint):void`**（阶段二百四十五：唯一形参 `code` **必填**——`mxmlc 51.4.1` 对 0 个实参报「参数个数不正确。需要 1 个」；语义 = 记下退出码后走**与 `NativeApplication.nativeApplication.exit()` 完全同一条**收尾路径（`as_window_request_exit()`），`main` 最后 `return` 该码作**进程状态码**，**调用点之后的语句仍跑到本帧边界**（同一延迟口径）；`Number`/`*` 实参按 ES3 `ToUint32` 归一（`as_to_uint32`/`as_v_uint_cast`，**不是** C 强转）；`System` 的**未知成员**现在报 `System has no member 'X'`——此前误报 `undefined variable 'System'`，把「类认得、成员没有」说成「类不存在」）；`flash.system.Capabilities`（阶段六十五）：`final` 静态只读类（与 `System` 同范式、无实例化类）—— `version`（固定 AIR 兼容 `"<平台前缀> 50,0,0,0"`，对齐 Adobe AIR 终版 major，AS-AOT 标记由 `manufacturer` 承担）、`os`（`Mac OS`/`Windows`/`WASI`/`Linux` 条件编译）、`cpuArchitecture`（`ARM`/`x86`）、`cpuAddressSize`（`32`/`64`）、`supports64BitProcesses`/`supports32BitProcesses`（由地址宽度推得）、`playerType`（`"Desktop"`）、`manufacturer`（`"AS-AOT"`）、`isDebugger`（`false`）、`touchscreenType`（`"none"`）、`language`/`languages`（系统 locale **归一化**后的「语言-地区」名称，如 `zh-Hans-CN` ⇒ `zh-CN`，与 AIR 实测一致）、`screenResolutionX`/`screenResolutionY`（**逻辑点（DIP）**口径的主屏尺寸——与 `Stage.fullScreenWidth`/`Height` 同源同值，headless 为 0；实测对齐 `adl 51.4.1`：3840×2560 桌面 @150% 缩放报 **2560×1707**，见 [`win32.md`](docs/zh-cn/win32.md) §3.5）、`screenDPI`（**平台基线而非面板实测 DPI**：Windows `96.0`、其余平台 `72.0`；实测 `adl` 在 150% 缩放下仍报 96，而 SDL 的 `DisplayDPI` 是 144）、`screenColor`（`"color"`）、`pixelAspectRatio`（`1.0`）、`hasAudio`（`true`）；`flash.system.IME`（阶段一百三十五）：`final` 静态类（**不可实例化** —— `new IME()` 抛 `#2012`），静态 `isSupported`（只读 `true`）/`enabled`（可写）、`conversionMode`（可写；`null` 抛 `#2007`、非七种可设模式（含只读 `UNKNOWN`）抛 `#2063`）与方法 `setCompositionString`/`doConversion`/`compositionSelectionChanged`/`compositionAbandoned`（**无聚焦可编辑 `TextField` 时抛 `#2063`**，与 `adl` 51.4.1 基准同口径；有则接已有的 marked-text 合成通道），`flash.system.IMEConversionMode` 的 **8** 个常量（`ALPHANUMERIC_HALF`/`ALPHANUMERIC_FULL`/`JAPANESE_HIRAGANA`/`JAPANESE_KATAKANA_FULL`/`JAPANESE_KATAKANA_HALF`/`CHINESE`/`KOREAN`/`UNKNOWN`；未知常量名是**编译期报错**）、`flash.events.IMEEvent`（`extends TextEvent`，`IME_COMPOSITION`/`IME_START_COMPOSITION` 常量 + 可读 `imeClient`；**运行时不由我们派发**）；类型转换 `String(x)/Number(x)/Boolean(x)/int(x)/uint(x)`（**阶段一百六十四**：`int(x)`/`uint(x)` 走 ES3 `ToInt32`/`ToUint32` —— NaN/±Infinity → 0、按 2^32 回绕、向零截断，**不是** C 强转（越界/NaN 是 UB）；静态路径与 `new (ClassValue)(x)` 两条路同一口径；`new Number()` 是构造器默认值 `0`）；内建构造器调用 `Array(...)/Object(...)/Vector.<T>(...)`（无 `new` 亦可，但 **`Vector.<T>(arrayLike)` 是「转换」而非「构造」**——与 `new Vector.<T>(length)` 语义不同，见下方类型映射表）；`Object(x)` 有参**恒等返回**（**唯** `null`/`undefined` 给**新的空 `Object`** —— 阶段一百六十四，真值 = `adl 51.4.1`；`new (Object Class)(5) === 5` 同样成立）、primitive 装箱为 `any`（**`Object` 槽内的原始值按 AIR 口径还原**，阶段一百四十四：真值判断用**原始值**的 ToBoolean——`false`/`""`/`0` 为假、`true`/非空串/对象/函数为真；`String(装箱 false)` 是 `"false"`；`String(函数值)` 是常量 `"function Function() {}"`、**空函数值是 `"null"`**；赋给 `Object` 槽的 `null` `String`/`Function` **就是 `null` 而非包装对象**）；URI 编解码 `encodeURI/decodeURI/encodeURIComponent/decodeURIComponent/escape/unescape`；`Boolean` 方法 `toString/valueOf`；`undefined` 全局常量；对象字面量 `{}`（字符串键关联数组）；顶层 `JSON` 类 `stringify`/`parse`（递归序列化/解析对象、数组与基础类型）；异常 `throw`/`try`/`catch`/`finally`（基于 `setjmp`/`longjmp`）；`Date` 类（构造器重载 `new Date()`/`new Date(ms)`/`new Date(year,month,day,...)`/`new Date(str)`，静态 `Date.parse(str)`，访问器 `getTime/getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds`，格式化 `toDateString()`/`toUTCString()`）；`RegExp` 类（正则字面量 `/pattern/flags` 与 `new RegExp(pattern, flags)`：`test`/`exec`/`source`/`global`/`ignoreCase`/`multiline`/`dotall`/`extended`/`lastIndex`，支持 `i/m/s/g/x` 五 flag；内嵌自研 ES3 回溯正则 VM：捕获/非捕获组、反向引用、前瞻、惰性/贪婪量词、字符类与 `\d\w\s` 转义；`String.match/search/replace` 正则版：`match` 返回捕获数组或 `null`、`search` 返回首匹配位置、`replace` 支持 `$1`~`$9`/`$&`/`$$` 替换及函数替换 `repl:Function`）；`Vector.<T>` 类型安全数组 `push/pop/join/indexOf/slice/concat/splice/forEach/map/filter/sort/reverse`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`、字面量 `new <T>[...]`、索引读写与越界检查；`Array.sortOn(field, options)`（按对象字段排序，支持 `Array.NUMERIC`(16)/`Array.DESCENDING`(2) 及 `NUMERIC \| DESCENDING` 组合）、`Array.concat` 接受动态元素；`Function.apply(thisArg, argsArray)`（从数组取参调用函数值）；动态方法调用（`Object` 类型或 `any` 接收者未命中静态签名时，经方法反射表 `as_dyn_call` 按名派发到类方法；**动态调用按声明签名校验实参个数**：少于必填参数或多于最大参数都抛 `ArgumentError #1063`，文案里的 `Expected` 是**第一个可选参数之前**的个数——实测 0 参**方法**不接受任何实参，与 0 参函数值（AIR 视为可变参）相反；`...rest` 抬高上界；调用方省略的可选参数取**声明默认值**，绝不越界读实参数组）；`flash.data` 本地数据库（阶段一百三十九，**引擎 = 官方 SQLite amalgamation**，程序引用 `flash.data`/`flash.events.SQL*` 时由编译器自动把 `vendor/sqlite{,_glue}.c` 加进构建清单并定义 `ASC_HAVE_SQLITE`+`SQLITE_ENABLE_COLUMN_METADATA`（wasm 另加 `SQLITE_THREADSAFE=0`）；未引用时**不链接**，此时 `SQLConnection.open` 走运行时**响亮桩**（报「本构建没接 SQLite 引擎」，绝不静默假装建库）：`SQLConnection`（`open(path, mode, autoCompact=false, pageSize=1024, encryptionKey=null)`/`close`/`begin`(`SQLTransactionLockType`)/`commit`/`rollback`/`setSavepoint`/`releaseSavepoint`/`rollbackToSavepoint`/`compact`/`analyze`/`deanalyze`/`attach`/`detach`/`loadSchema`/`getSchemaResult`/`cancel` + 只读 `connected`/`inTransaction`/`totalChanges`/`lastInsertRowID`/`pageSize`/`autoCompact` 与可写 `cacheSize`/`columnNameStyle`，静态 `isSupported=true`）、`SQLStatement`（`text`（初值**空串**，赋 `null` 抛 `TypeError #1009`）/`sqlConnection`/`itemClass`（初值是 **`Object` 类**，赋 `null` 被接受并读回 `Object`）/只读 `parameters`（活 `Object`，用 `clearParameters()` 清空）/`executing` + `execute(prefetch=-1, responder)`/`next(prefetch=-1, responder)`/`cancel`/`clearParameters`/`getResult`——**`prefetch` 不是「每次取多少行」**：`-1` 取完（`complete=true`）、`>0` 至多这么多（`complete=false`）、**`0` 或其它负数一行都不给**（`data=null`），`next()` 在 `complete` 后抛 `#3107`；`data` 空块恒为 `null` 而非空数组）、`SQLResult`（`data`/`complete`/`rowsAffected`/`lastInsertRowID`，`getResult()`/`getSchemaResult()` 均为 **FIFO 队列**、取过即 `null`）、模式族 `SQLSchema`/`SQLTableSchema`/`SQLViewSchema`（**`view is SQLTableSchema` 成立**）/`SQLIndexSchema`/`SQLTriggerSchema`/`SQLColumnSchema`/`SQLSchemaResult`（只列**用户创建**的对象：约束自动索引与 `sqlite_sequence`/`sqlite_stat1` 不列；`loadSchema` 一个都没命中是**报错** `#3115` + `detailID` 1007/1009/1010，`detailArguments` 分别为 `(name,type,db)`/`(type,db)`/`(db)`）、事件 `flash.events.SQLEvent`/`SQLUpdateEvent`/`SQLErrorEvent`与 `flash.errors.SQLError`（`details`/`detailID`/`detailArguments`/`operation`；`SQLUpdateEvent` 由 **`SQLConnection`** 对**每个受影响行**派发一条，早于 `result`），**错误族二分**：引擎失败是 `SQLError`（`#3115`/`#3125`/`#3131`），契约违规是**普通 `Error`/`ArgumentError`/`TypeError`**（`#3101`/`#3102`/`#3103`/`#3104`/`#3105`/`#3107`/`#3108`/`#3109`/`#3112`/`#2007`/`#2008`）；**加密不做**：任何非空 `encryptionKey`（含 `reencrypt`/带密钥的 `attach`）一律 `SQLError #3138`**响亮拒绝**，绝不静默写明文库） |
| 内建签名 | 形参表与 AIR 逐格对齐（阶段一百九十五）：每个内建方法/构造器的**每一个实参个数**都用 `mxmlc 51.4.1` 判定过接受性（4964 格）——AIR 接受的省略一律补上文档默认值（`ctx.drawTriangles(ib)`、`ctx.configureBackBuffer(1, 1, 0)`、`new NativeMenuItem()`、`w.loadString(t)`），AIR 拒绝的「我们发明的默认」一律改回必填（`g.moveTo(1)`、`m.rotate()`、`new ShaderData()` 现在是编译错误）；`Context3D.drawTrianglesInstanced` 的形参序改齐为 AIR 的 `(indexBuffer, numInstances, firstIndex = 0, numTriangles = -1)`（`numInstances` 在第二位）。残余（登记在 `TODO.md` 遗留表）：9 处我们多声明形参、27+ 处 AIR 接受更多实参、`BitmapData.floodFill`/`merge` 未实现 |
| 语义 | **未捕获异常不终止进程**（阶段二百一十七）：帧时钟、鼠标/滚轮/键盘回调与原生窗口事件（resize/move/activate/displayStateChange）这些**入口**都在同一处 `as_frame_jmp` 上恢复（每个线程只安一枚守卫、互不嵌套），报错后继续跑下一帧 —— 与 AIR 一致；仅当没有任何入口守卫（非 GUI 程序、首个窗口出现前）才 `exit(1)`。这不只是「对齐」：Windows 上 `exit` 会在 CRT/ANE DLL 卸载阶段死锁，进程不退出而窗口停在「(未响应)」，正是「点一下列表就卡死」的形态。**每个子表达式只求值一次**（阶段八十九·三十八）：AS3 的求值规则是「一个操作里的每个操作数按从左到右各求值一次」，而生成 C 的若干形态会把同一操作数内联到多处（成员写含写屏障、属性 getter 读要经 vtable、`as` 先判定后取值、接口 `==` 比两个字段、`Function` 值调用读闭包与其 env、正则参数读 `compiled`/`global`、`Boolean(str)` 读两遍串）——凡操作数可能带副作用（`isPureExpr` 判否）即先落临时变量（`hoistImpure`），故 `box.get().label = "Z"` 的 getter 只跑一次（修前 3 次）、`h.getFn()()` 与 `s.replace(h.mkRe(), …)` 只跑一次（修前各 2 次）；模块级 `var` 初始化（`emitTopLevel` 的另一条路径）与 `for` 的 init、`throw` 的值也补上了同一遍 `sequenceValueExpr`。**真值语义**（阶段八十九·三十八，AIR 51.4.1 实测对照）：`Boolean(x)`/`if (x)` 对**非空引用**（对象/数组/Vector/Dictionary/类实例/接口值/函数）恒为真（此前按 `ToNumber(x) != 0` 判，对任何对象都得假），对 **NaN** 恒为假（C 的 `if (d)` 会把 NaN 当真，故新增 `as_num_truthy(x) = x != 0 && !isnan(x)`，静态 `Number` 条件与 `any` 装箱路径同走此判定）；`/` 恒为 `Number`（AS3 语义）；`%` 的**零除数**按 AS3 语义有定义（`5 % 0` 得 `NaN`、`var r:int = 5 % 0` 得 `0`、`INT_MIN % -1` 得 `0`），按值走 `as_int_rem`/`as_uint_rem` 守卫（C 的整数 `%` 在零除数/`INT_MIN % -1` 上是 UB，wasm 下按规范 trap）；`+` 遇字符串自动拼接并装箱，且**动态（`*`）参与时由运行时值判定**（阶段八十九·三十四）：`emitBinary` 在有 `any` 参与时改为调用运行时助手 `as_add_v`，按 ES3 ToPrimitive —— 任一侧运行时是 String（或会 stringify 的对象）即拼接、否则数值相加，结果装箱为 `any`。实测 `var a:Array=["x","y"]; a[0]+a[1]` 得 `"xy"`（此前为 `0`）、`var d:*="x"; d + 1` 得 `"x1"`（此前为 `1`）、`null + 1` 得 `1`（此前 `(NULL + 1)` 直接 C 编译失败）。已知简化：对象/数组箱在拼接侧仍按 `as_v_str_val` 渲染，故 `[Array] + 1` 得 `[Array]1` 而非 AS3 的 `1,21`；`trace`/`String(Number)` 输出 IEEE-754 double 的**最短 17 位表示**（`trace(1/3)` → `0.3333333333333333`；**极值口径与 AIR 仍有残差**——denormal 与 `MAX_VALUE` 的位数、`Number(超长有效数字)` 的溢出/舍入，见 `TODO.md` 遗留表）；**对象/类实例的 `ToPrimitive`**（阶段一百三十四）：`Number(obj)` 与 `obj == 原始值` 按 ES3 number-hint——**先查 `valueOf`**（命中且回原始值即用）再 `toString`，故 `Number({})` 得 `NaN`、`Number(x)` 若 `valueOf` 返回 7 则得 `7`（胜过 `toString` 的 99）；**缺失读为 `undefined`**（阶段一百三十四）：`Array` 越界下标/已删键/空表 `pop()`·`shift()`、对象缺失动态属性一律 `undefined`（`=== undefined` 成立、`== null` 仍成立）；**`DisplayObject.name = null/undefined` 抛 `TypeError #2007`**（阶段一百三十四）：静态槽、`this.`/`super.`、动态 `*`/`Object` 接收者一律抛且**旧值保留**，`Error.name` 是普通槽故**不**抛；`Date.getTime()` 返回真实毫秒时间戳（`gettimeofday`）；`is`/`as` 基于 vtable 的 `super` 链做运行时类型检查；数组元素为动态类型（`as_value` 装箱），异构元素自动处理；异常经 `setjmp`/`longjmp` 跳转到最近的活跃 `catch` 处理，`finally` 始终执行（**wasm 目标同样可用**：阶段八十九·三十五打通了 EH 链接——`-lsetjmp` + 标准异常处理提案 `try_table`，9 个含 `try/catch` 的示例跨 native/wasm 输出逐字节一致）；位运算按 AS3 语义转换到 32 位整数（`>>>` 为无符号右移）；`Object`/`any` 类型的动态索引/属性访问经反射表（字段偏移 + 方法表）落到真实类实例，未命中时回退记录槽（`obj[key]`/`obj.prop`/`obj[key] = v`/`obj.prop = v`）；条件上下文（`if`/`while`/`?:`/`&&`/`\|\|`/`!`）对 `any` 值按 AS3 truthiness 判定（`null`/`undefined`/空串为假，非零数与非空对象为真）；**静态 `String` 同一口径**（空串为假，经 `as_str_truthy` 单次求值，阶段一百二十五）；**顶层脚本作用域是整个顶层语句树**（阶段八十九·三十四）：块 / `if` / `for` init / `switch` case / `try` 内写的 `var`/`const` 与顶层声明**共用同一个** C 文件作用域全局（`for (var i…` 的初始化直接发射成 `for (g_i = 0; …)`，循环后 `trace(i)` 读同一槽），闭包也直接读写该全局而非拿创建时刻的副本（同一循环变量的三个闭包调用都得终值）；顶层 `for-in`/`for-each` 的**循环变量**同样提升为脚本作用域全局（阶段八十九·三十七）：其 C 类型不在源码里（取决于可迭代对象——`Array` 得 `int` 下标、动态对象得 `char*` 键、`Dictionary`/动态对象值得装箱值、`Vector.<T>` 得元素类型、源码标注优先），由 `collectScriptDecls` 与 `emitModuleVars` 用**同一个** `loopVarType` 规则推出，故循环后 `trace(k)` 读到末轮的键（与 AIR 一致；AIR 实测变量确实存活）。函数体内的循环变量仍按本子集函数级提升惯例留块内局部；**`Object` 声明的槽位**里装的是**装箱标量**（`var o:Object = false` 落地为 `as_boolean_new(false)`）⇒ 条件上下文与 **`Boolean(o)` 都先 `as_obj_to_value` 解箱再按 AS3 truthiness 判定**（`false`/`0`/`NaN`/`""` 为假、真对象为真；阶段二百四十八，`adl 51.4.1` 26 格 A/B **0 差异**）—— 具体子类槽永远不装标量，仍是非空引用即真 |

## 类型 → C 映射

| AS3 | C |
|-----|---|
| `int` | `int` |
| `uint` | `unsigned int` |
| `Number` | `double` |
| `int64` | `int64_t`（**opt-in 增强**：类型名在 AIR 里不存在，写出来才生效；字面量 `123L`、转换 `int64(x)`） |
| `uint64` | `uint64_t`（同上；字面量 `123UL`/`123LU`、转换 `uint64(x)`） |
| `Boolean` | `bool` |
| `String` | `char*`（拼接/装箱走 `as_str_*` 运行时助手） |
| `Array` | `as_array*`（动态扩容、异构元素装箱为 `as_value`；元素类型为动态 `*`） |
| `Vector.<T>` | `as_vector_<T>*`（按元素类型 `T` 单态化：连续元素数组 `T* data` + `length`/`capacity`；索引越界抛 `RangeError #1125`；编译期强制元素类型；`push/pop/join/indexOf/slice/concat/splice/forEach/map/filter/sort/reverse`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`、字面量 `new <T>[...]`）。`T` 可为 **`*`**（阶段九十八·一：元素是 `as_value` 装箱）与 **`Class`/`Dictionary`**（阶段一百零九：`Class` 早已是 `as_class*`，`Dictionary` 早已有反射名，补上单态化判定即可 ⇒ **away3d 的 `Vector.<Class>` 7 处调用的墙已清**，元素槽按 `GCT_PTR_ARRAY` + 写屏障）；**`*`/`Object` 接收者的动态访问**（`.length` 读写、整数下标读写、16 个方法）自**阶段九十八·二** 起可用（越界/负下标 `#1125`），并与静态路径转调同一批单态化助手。**两种调用形态语义不同**（阶段一百零九，逐项对 `adl 51.4.1`）：`Vector.<T>(arrayLike)` 是**转换**（逐元素转换拷贝，`length` 按 array-like 协议动态读，标量/`null` 抛 `TypeError #1034`、零参抛 `ArgumentError #1112`、密封实例按 `ReferenceError #1069`）；`new Vector.<T>(length)` 是**构造**（参数须 `uint`，否则 `ArgumentError #2005`；`fixed` 形参接受但本子集未强制） |
| `Function` | `as_fn`（指向闭包记录 `{ thunk, env }` 的指针；每个被用作值的函数生成一个 thunk，把装箱参数列表解箱、调用带类型的实现、再把结果装箱回 `as_value`；捕获外层局部变量的闭包额外生成环境 struct + 堆分配构造器，env 指向该环境） |
| 对象字面量 `{}` | `as_object*`（字符串键关联数组，属性值装箱为 `as_value`） |
| `RegExp` | `RegExp*`（`{ vtable; as_regex* compiled; source; flags; lastIndex; global/ignoreCase/multiline/dotall/extended }`；`compiled` 为内嵌回溯 VM 的编译产物，构造时编译；**编译失败不抛异常**（对齐 AVM2：`RegExpObject::completeInitialization` 把 PCRE2 的报错丢掉，对象存下来但永不匹配 —— `exec`→`null`、`test`→`false`、`replace`/`match`/`search` 视作无匹配）） |
| 类 `Foo` | `struct Foo` + `Foo*`；首成员为 `Foo_vtable*`（虚表：`super` 链 + 方法/getter/setter 函数指针，统一扁平槽列表保证子类 vtable 与父类前缀布局兼容）；字段平铺（父类字段在前）；方法编译为 `Ret Foo_method(void* this, ...)`，调用走 `obj->vtable->method(obj, ...)`；实例 getter/setter 同为虚派发（`obj->vtable->get_prop(obj)` / `obj->vtable->set_prop(obj, v)`），静态访问器与 `super.property` 仍静态直调；命名空间内的类用包前缀命名（`foo.bar.Baz` → `foo_bar_Baz`） |
| 接口 `I` | `struct I`（引用对：`void* obj` + `I_vtable* vt`）；方法派发走 `ref.vt->method(ref.obj, ...)`；每个实现类生成接口 vtable 实例 `Class_I_vt` |
| `Error` / 异常 | `struct Error`（`vtable` + `message`）；`throw` 归一化为 `as_throw(Error*)`，异常状态存于全局 `as_exception`，跳转栈用 `setjmp`/`longjmp`；`TypeError`/`RangeError`/`ArgumentError` 为 `Error` 子类（同布局、独立 vtable），`catch (e:Type)` 用 `as_is` 沿 `super` 链精确匹配（**原始值抛出物只在匹配的声明下被捕获**：`catch (e:Error)` 不捕获 `throw "oops"`，阶段一百三十四） |
| `static` 成员 | 类级字段/方法：文件作用域全局 `Class_field` / `Class_method(...)`（无 `this` 接收者）。静态成员的接收者**短名与点分全限定名同义**（`File.x` ≡ `flash.filesystem.File.x`，阶段二百一十七：读/写/调用一律走同一份静态 traits，不再因写法不同退化成动态查表） |
| `trace` | 按类型生成 `printf` 格式串；对象打印为类名（`as_obj_to_str` 读 vtable 的 `name`） |

## 语义权威来源

实现新特性前，先查权威规范确认真实 AS3 语义，杜绝凭记忆或 C 行为反推。完整的分级清单、
红线对照与决策分歧见 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md)。核心来源：

- **ES4 draft 规范**（语法/类型系统/强制转换正典）：`http://archives.ecma-international.org/2006/misc/es4lang-Jan06.pdf`
- **AVM2 Overview**（对象模型 trait/slot/分派语义，只借语义不生成 ABC）：`http://hackipedia.org/raw/File%20formats/Containers/F4V,%20Flash%20Video/ActionScript%20Virtual%20Machine%202%20(AVM2)%20Overview%20by%20Adobe%20(2007-05).pdf`
- **avmplus 源码**（规范含糊时的裁决）：`https://github.com/adobe/avmplus`
- **AS3 语言参考**（标准库 surface）：`https://airsdk.dev/reference/actionscript/3.0/`
- **ECMA-262 第 3 版**（数值转换 `ToInt32`/`NaN`/`Infinity` 出处）

## 在 AIR 之外（增强，非对齐）

我们的产物是一份可读 C 再交给 `clang -O2`，能链 Skia/libcurl/SQLite、吃 LTO/PGO、与宿主 C 互调、
编到 native/WASI/web，故可在 AIR **未定义 / 不支持 / 没有对应物**的地方做增强（增强必须 opt-in、
绝不静默）。判据：同一输入 `adl` 能跑对我们跑不出 ⇒ 遗留缺陷；`adl` 本来就报错或 API 不存在 ⇒ 才是增强。

**已实现（8 / 19）**：

- **显示器刷新率查询** — `VsyncStateChangeAvailabilityEvent` 增加只读 `refreshRate:Number`（AIR 无任何刷新率 API，只读 `available` 实测恒 `false`）
- **多格式图片解码** — WebP / BMP / ICO（`--features formats`；默认与 AIR 同报 `#2124`）
- **相机 RAW / DNG** — `Loader.load("*.dng")` 直接出图（`--features raw`，native）
- **SVG 运行时解码** — `Loader.load("*.svg")` → `Bitmap`（`--features svg`，native）
- **64 位整数** — `int64` / `uint64`（AIR 无此类型名）
- **LTO / PGO 构建开关** — 清单 `lto`/`pgo`、CLI `--lto`/`--pgo`
- **带状态码的退出** — `System.exit(code)`（AIR 运行时抛 `#2018`）
- **macOS 菜单栏状态项** — `SystemTrayIcon` 背后是真 `NSStatusItem`（`--features tray`；AIR 在 macOS 上 `supportsSystemTrayIcon=false`、构造抛 `#2012`）

完整 19 项清单（余 Lottie、原生着色器、FFI、服务端出图…）与五条判定标准见
[`docs/zh-cn/enhancements.md`](docs/zh-cn/enhancements.md)。

## 示例
- `examples/hello.as` — 表达式、字符串拼接、`trace`、`if/else`
- `examples/fib.as` — 函数、`while`、`for`、递归边界
- `examples/class.as` — 类、字段、方法、`new`、`this`
- `examples/features.as` — 除法/取模、比较、逻辑、自增、字符串相等
- `examples/syntax.as` — `uint`、十六进制、`do-while`、`switch`、三元、`break`/`continue`、`Infinity`/`NaN`
- `examples/ctor.as` — 有参构造函数、`new` 传参
- `examples/inherit.as` — 继承 `extends`、字段/方法继承
- `examples/override.as` — `override` 方法重写、多态动态派发
- `examples/super.as` — 构造函数 `super(...)`、方法 `super.method(...)`
- `examples/visibility.as` — 访问修饰符 `public/private/protected`
- `examples/isas.as` — `is` / `as` 类型判断与转换
- `examples/array.as` — 数组字面量/索引/`push`/`pop`/`splice`/`for-in`/多维数组/异构元素
- `examples/object.as` — 对象字面量 `{}`（关联数组）、属性读写、嵌套对象
- `examples/any-add.as` — 动态 `+`（任一侧为 `*`）：运行时判定拼接/相加、`null` 参与、`+=`
- `examples/any-dot-write.as` — `*` 接收者的点写入（已知字段、密封类未知属性、record 槽、数组元素缓冲）
- `examples/stdlib.as` — `String` 方法、`Math`、全局函数、类型转换、对象可读 `trace`
- `examples/oop2.as` — `const`/`static` 字段与方法、`get`/`set` 访问器
- `examples/interface.as` — `interface`/`implements`、接口 `is`/`as`、接口方法派发
- `examples/stage4.as` — 接口 + 静态成员 + 访问器 + `final` + `Object.toString` + `Number` 默认 `NaN`
- `examples/stage5.as` — 默认参数、rest 参数、`Function` 值与匿名函数
- `examples/stage6.as` — `package`/`import` 语法兼容层（命名空间扁平化）
- `examples/stage7.as` — `throw`/`try`/`catch`/`finally`、内建 `Error`、异常重抛与嵌套
- `examples/stage8.as` — 位运算 `& | ^ ~ << >> >>>` 及复合赋值、标签语句
- `examples/stage9.as` — `Error` 子类精确 `catch` 与冒泡、`Date` 日历访问器
- `examples/stage12/` — `package foo` 跨文件定义类、`import` 后实例化、同包 `internal` 可见
- `examples/stage10.as` — `Vector.<T>` 类型安全数组与越界 `RangeError`
- `examples/stage11.as` — 闭包（捕获外层局部变量、逃逸、独立计数、带参）
- `examples/stage13.as` — `null` 装箱语义、字符串 arena 分配压力测试
- `examples/stage14.as` — `trace`/`String(Number)` 17 位最短表示、`Date.getTime()`
- `examples/stage15.as` — 模块级 `const`/`var` 对自由函数可见、无类型变量截断防护、顺序初始化
- `examples/stage16.as` — `String.replace`（字符串版）、`Number.toFixed`/`toExponential`/`toPrecision`
- `examples/stage17.as` — `Vector.<T>` 的 `join`/`indexOf`/`.length` 赋值/带参构造
- `examples/stage18.as` — 基本类型 `is`/`as`（编译期求值 + `any` 运行时 tag 判定）
- `examples/stage19.as` — `Array`/`Vector` join 优化、有意简化项验证
- `examples/stage21.as` — `Number`/`int`/`uint` 的 `toString(radix)`（2~36）、`valueOf`、静态常量
- `examples/stage22.as` — `String` 的 `concat`/`fromCharCode`/`localeCompare`/大小写/`startsWith`/`endsWith`
- `examples/stage23.as` — `Boolean.toString`/`valueOf`、`undefined`、URI 编解码
- `examples/regexp.as` — 正则字面量/`new RegExp`、`test`/`exec`/捕获组/`lastIndex`、`String.match/search/replace` 正则版、字符类/量词/反向引用/前瞻、`i/m/s/x` flag
- `examples/stage28.as` — `Array()`/`Object()` 构造器形式（含无 `new`）、`Vector.<T>` 的 `new`＝构造 vs 无 `new`＝转换
- `examples/stage33.as` — `Event`/`EventDispatcher` 事件三阶段分发
- `examples/stage34.as` — 显示列表 `DisplayObject`/`DisplayObjectContainer`/`Stage`/`Sprite`
- `examples/stage35.as` — 交互事件与命中测试（inside-out 分发、`mouseChildren`/`visible`、鼠标/键盘/焦点）
- `examples/stage36.as` — Skia 最小闭环（`Shape` → `Stage.render` 离屏 PNG）
- `examples/stage37.as` — `Shape`/`Graphics` 绘制、`Bitmap`/`BitmapData` 像素读写、嵌套 `Sprite` 渲染
- `examples/stage38.as` — `TextField`/`TextFormat` 文本渲染、`textWidth`/`textHeight`
- `examples/air-native/` — 多文件 Air 式文档类 demo（`addedToStage` 驱动 + 各内建类演示），链 Skia 输出 `air-native.png`
- `examples/as-library/` — **共享 AS3 类库根**（GreenSock 核心）：不放在任何 app 的 `src/` 里，编译时用
  `--air-app … --as-class-path examples/as-library` 加进编译面（§3.5.2）；AIR 对照路径（`examples/air-native/build-and-run.sh`
  的 `mxmlc`）用同一条 `-source-path`
- `examples/air-starling-demo/` — Starling 2.x 端到端 demo（`flash.display3D` 渲染管线、着色器、事件、补间），窗口化运行（**外部夹具，不在库内**：见 [`examples/EXTERNAL-FIXTURES.md`](examples/EXTERNAL-FIXTURES.md)；缺席即跳过、不算失败）
- `examples/window.as` — `Stage.showWindow` 窗口化（离屏 Skia → SDL2 上屏 + 事件循环）
- `examples/window_click.as` — 窗口内真实鼠标点击 → AS3 事件分派（`mouseDown`/`mouseUp`/`click` + 冒泡 + 重渲染）
- `examples/textflow.as` — `TextField` 排版断言（`numLines`/`maxScrollV`/`scrollV`、`wordWrap`、`appendText`/`textHeight`）
- `examples/textrich.as` — 富文本：`StyleSheet` 规则（**未知标签有规则即成块级**、`display:inline`/`none`、选择器大小写与拷贝语义）
  + `htmlText`/`setTextFormat`/`autoSize`/`scrollH`+`maxScrollH`（打字自动滚动）/`leading` 断言
- `examples/autosize-metrics.as` — `TextField.autoSize` 的大小口径（`wordWrap=true` 只改高度、宽度保持用户值；
  `wordWrap=false` 才 `width = textWidth + 4` 且两向收放；几何读取即刷新）与**未安装字族**回落到平台默认脸的行盒
- `examples/gettextformat.as` — `TextField.getTextFormat()` 读回该区间**生效的**格式（阶段二百七十，G21）：单 run / gap 用默认格式 / 跨边界与反序答**全 null 空格式** / `#2006` 越界 / `-1` 表示未提供 / 返回**副本**
- `examples/tf-scale-metrics.as` — 被缩放的 `TextField` 口径：`textWidth`/`textHeight` = 名义 extents 乘**累积 `scaleY / scaleX`**
  （两个方向同除 `scaleX`、含祖先链），而**字形**只按累积 `scaleY` 整体缩放、`scaleX` 不拉宽（`BitmapData.draw()` 忽略被画对象自身的
  transform，故像素断言挂在中间那层被缩放的 `Sprite` 上）
- `examples/swc-mc-button.as` — **MovieClip 的三种按钮态**（阶段一百七十一，`adl 51.4.1` 实测）：`buttonMode == true` **且**时间轴上有
  `_up`/`_over`/`_down` 三个 `FrameLabel` 时，滚入/按下/滚出把播放头**真的**移到对应标签帧（`skin_fla.元件17_55`——旧导出里叫 `元件17_125`——`_up@1`→`_over@4`→`_down@7`、
  首页卡片 `_up@1`→`_over@5`→`_down@11`）；按压锁在 `mouseDown` 的那个对象上；`buttonMode=false` 与「只有标签」两个负例恒 `1:_up`；
  并断言三种状态画出来的**像素确实不同**（钉住「祖先被自动烘焙时状态照样生效」这条口径）。**阶段一百七十二**追加第 ⑪ 档：
  回到旧帧（`_over`/`_down` → `_up`）时**复用**同一 `(深度, 角色)` 的子件 —— App 写进卡片 `TextField` 的文字全程保留、
  回退后的画面与悬停前**逐位相同**（`inkDiff == 0`）、子件数不增不减，而角色真的变了的那一层（深度 1：524 → 518）确实换新对象。
- `examples/wheel.as` — 鼠标滚轮语义（1 delta = 1 行、`scrollV` 钳制、未命中不派发）
- `examples/frame.as` — `ENTER_FRAME` 广播语义（深度优先派发）
- `examples/stage41.as` — `Stage` 属性读回（`stageWidth`/`stageHeight`/`color`/`quality`/`frameRate` 等）+ 常量类
- `examples/stage67.as` — `DisplayObject.cacheAsBitmap`（默认 false、读写、继承、toggle 失效安全）
- `examples/cacheasbitmap.as` — `cacheAsBitmap` 渲染验证（开关两态逐像素一致）
- `examples/autobake.as` — 增量重绘自动 `cacheAsBitmap`（静止触发烘焙、移动失效重烘焙）
- `examples/autobake-origin.as` — 烘焙原点对齐设备像素栅格（抗锯齿圆在小数原点：修前与实时绘制差 1 物理像素、修后逐位相同；需 `examples/autobake-origin.build.json` 链 Skia）
- `examples/bake-bitmap-swap.as` — 烘焙指纹必须认得「换了一张 `BitmapData`」（阶段二百八十一）：真机症状是
  幻灯片预览被自动烘焙后在某个分辨率下**翻页不再更新**，只有把窗口改回烘焙前那个尺寸才刷新。根因是
  `as_render_fp` 的 Bitmap 分支只哈希 `image` + `_px_ver`，而应用里每一页都是 `new BitmapData(w,h,true,0)`
  加一次 `draw` ⇒ 两值逐页相同 ⇒ 祖宗烘焙永不过期；resize 只是让 `_cache_w/_cache_h` 不匹配、顺带重建一次。
  修法是 `BitmapData._uid`（构造器单调自增）参与哈希，并让显式 `cacheAsBitmap` 与自动烘焙走同一条失效判据
  （内容一变即过期，AIR 行为）。需 `examples/bake-bitmap-swap.build.json` 链 Skia
- `examples/bake-draw-cache.as` — `BitmapData.draw` 也是一条渲染路径（阶段二百八十二）：窗口绘制与
  `Stage.render` 都会在画之前刷新渲染指纹，而 `draw` 曾经直接画 —— 于是只经由 `draw` 进入渲染的子树
  （离屏、从未上过显示列表）烘一次就永远重放那张图。真机形状：`FilePreviewView.drawTimeEvent()` 用
  10 fps 把 `skinView.view`（`ViewControl`，即 `cacheAsBitmap`）画进 1280x720 的 `BitmapData` 再显示，
  翻页因此不换图。修法是 draw 前先 `as_render_fp(src)`（在临时的源变换归零之前调用，两条路径必须
  哈希同一组字段）。需 `examples/bake-draw-cache.build.json` 链 Skia
- `examples/gc-image-free.as` — 被丢弃对象必须归还它持有的 C++ 资源（阶段二百八十三）：渲染路径给
  `BitmapData` 缓存的 SkImage 视图（1920x1080 = 8.3 MB）**不在 GC 堆里**，只在 `dispose()`／换图时
  才删；应用每页 `new BitmapData(...)` 再换掉 `bitmap.bitmapData`（从不 `dispose`），于是每页漏一张。
  真机 39 页 ≈ +325 MB，32 位进程爬到 1.1 GB 后下一页的 `gc_alloc` 在 `Loader` COMPLETE 里抛
  `Error #1000`（真机那条 `malloc failed for 8294416 bytes`），表现就是「翻到最后一页就不换图」。
  修法是 GC 的清扫在回收不可达块之前调用终结器 `as_final_on_free()`，把登记在该块地址上的 SkImage
  释放掉（`BitmapData.image`／`_live_image`／`DisplayObject._cache_image` 三处登记，重建/dispose 先
  `as_final_release` 再删，避免二次释放）。`ASC_NO_FINAL=1` 关掉终结器即可在同一份产物上复现泄漏
  （实测 +341 MB；修好 +42 MB）。需 `examples/gc-image-free.build.json` 链 Skia（无后端时会自检跳过）
- `examples/bakecrisp.as` — 烘焙分辨率与 `BitmapData.draw` 几何口径（对齐 `adl`）
- `examples/bitmap-smoothing.as` — `Bitmap.smoothing` 采样模式（阶段二百三十）：默认 `false` 是最近邻、`true` 是双线性；
  同一张 16x1 黑白位图按 0.25 缩到 4x1，最近邻只会给出纯 0x00/0xFF、双线性必然混出中间灰。此前渲染分支恒用
  Skia 的默认采样（最近邻）而把该属性丢掉了（需 `examples/bitmap-smoothing.build.json` 链 Skia）
- `examples/bitmap-setpixels-endian.as` — `BitmapData.setPixels` 按 `ByteArray.endian` 解析 32 位字（`bigEndian` = 内存 `A,R,G,B`、
  `littleEndian` = 内存 `B,G,R,A`，真应用 ANE 摄像头帧正是后者），以及「`new BitmapData` + `setPixels` 填出来的位图在显示列表里
  必须真的画出像素、改像素后跟着变」（纯 C 构建用 `TextField` 探针判断有无光栅后端，无则跳过显示列表段；需
  `examples/bitmap-setpixels-endian.build.json` 链 Skia）
- `examples/stage83.as` — Stage3D 对齐加固（CubeTexture/RectangleTexture、render-to-texture 像素断言、实例化绘制）
- `examples/stage3d-profile.as` — `Stage3D.requestContext3D(context3DRenderMode, profile)` 两参签名与 7 个 `Context3DProfile`
  常量（含 `ENHANCED`）；非法 `renderMode`/`profile` 是**同步** `#2008`（AIR 文案逐字，且 `renderMode` 先于 `profile`
  校验）；回读 `profile` 报本构建真正能兑现的最高档（现为 `"baselineExtended"`），外加 `createTexture`/
  `createCubeTexture`/`createRectangleTexture` 的尺寸校验（`#3681` 零尺寸 → `#3682` 非 2 的幂 → `#3683`/`#3705`/`#3766` 超上限，
  AIR 文案逐字；对 `adl` 51.4.1 实测）；`Context3D.ignoreResourceLimits`（AIR 50.0+）关时与 AIR 逐字一致、
  开时放开到**设备上限**（D3D12/Metal 16384），超限改报 `Error #3684`，而 `#3681`/`#3682` 仍照旧。
  **未链接 Stage3D 后端的构建**（纯 C 状态机）也报 `"baselineExtended"`：AIR 的 `software` 渲染模式在这里会直接
  异步抛 `#3702`（它锁死在 `baseline`），这是我们刻意保留的差异，登记为增强 E17，见 `docs/zh-cn/display3d.md` §9.14
- `examples/stage86.as` — `flash.utils` 反射（`getQualifiedClassName`/`getDefinitionByName`/动态实例化）
- `examples/stage87.as` — `Context3D` 骨架补方法（stencil/scissor/缓冲上传读回/`drawTriangles`）
- `examples/stage88.as` — AS3 语言特性缺口补齐（对象字面量字符串键、逻辑赋值、`for each`、命名空间等）
- `examples/stage89.as` — AS3 语言特性缺口第二批（严格相等、泛型默认参数、`for` 多变量声明等）
- `examples/shmup-stage3d/` — Stage3D 射击 demo（`test/examples.ts` 的 `SKIP_DIRS` 列出，需整层 Stage3D/Context3D 与 `package {}` 支持），macOS（Metal）与 **Windows（Direct3D 12，阶段一百三十二）** 均实机跑通：与 2D 显示列表合成到同一窗口
- `examples/system-exit.as` — `flash.system.System.exit(code:uint)`（调用点之后的语句仍执行到帧边界、进程状态码即 `code`）；状态码那一半在 `examples/system-exit-status.as`（位于 `SKIP_FILES`，因为示例池要求每个示例 exit 0）+ `test/examples.ts` 的串行用例里断言**真的以 7 退出**（阶段二百四十五）
- `examples/stage82.as` — Metal 端到端彩色三角形（AGAL→MSL 翻译 + `Context3D` 全链路 + 像素读回）
- `examples/stage81.as` — `Stage3D` + `Context3D` 骨架（`stage3Ds`/`requestContext3D`/状态机 + 常量断言）
- `examples/stage80.as` — AGAL 字节码内核（MSL/GLSL/**HLSL** 三档翻译、寄存器映射、swizzle/write-mask、比较指令、三档各自的寄存器与内建名断言、非法 opcode 与 `tld` 的响亮拒绝）
- `examples/stage79.as` — Stage3D 前置几何类（`Vector3D` + `Matrix3D` 运算与 `decompose`/`recompose`）
- `examples/stage66.as` — `Vector.<T>` 高阶/序列方法（`slice`/`concat`/`splice`/`forEach`/`map`/`filter`/`sort`/`reverse`）
- `examples/stage65.as` — `flash.system.Capabilities` 环境能力查询（`os` 在 Windows 上按 AIR 的表返回**家族名 + 版本**，如 `"Windows 11"`）
- `examples/move-to-trash.as` — `File.moveToTrash`/`moveToTrashAsync`（同步/异步两条路径 + 三条失败号 `#3003`/`#2038`/`#2037`、同名冲突的二次投递、目录整体搬移、`nativePath` 不变）+ `File.spaceAvailable` 的作用域（普通文件/目录作答、不存在路径与设备回 `0`），断言目标项确实出现在废纸篓目录里（Windows 上则断言它进了回收站：按 `$I` 副档里的原路径找到该记录、载荷内容读回一致、跑完自行清理**并断言清干净**）；`test/examples.ts` 用 `EXAMPLE_ENV` 把 `HOME` 指到 `temp/trash-home`，测试不会污染开发机的废纸篓（阶段二百四十三；Windows 分支与 `spaceAvailable` 的卷根映射为阶段二百四十四）
- `examples/file-symlink.as` — `File.isSymbolicLink`：与 `exists`/`isDirectory`（`stat`，跟随链接）**并列**的 `lstat` 谓词（软链→目录两个都为真、悬空软链 `exists=false` 而它为 `true`），并以一棵带环的软链夹具把「跟随软链的遍历会把 4 个真节点数成 264 个」量出来（阶段二百六十二）
- `examples/file-listing-async.as` — 目录列举的同步/异步两套口径（`adl 51.4.1` 实测，阶段二百六十四）：调用返回时**事件还没到**、调用之后注册的监听器仍收得到、事件形状与 `files`/`target`、**异步序 == 同步序**、缺失路径 `ioError #3003`、文件路径回**空表**且同步版对同一输入抛 `#3007`、不可读目录两边都回空表、`cancel()` 真取消、在飞时再调抛 `#2037`、空 `File` 抛 `#2037`；夹具里带一条软链与一个 `chmod 000` 的目录
- `examples/file-url.as` — `File.url` 的形状与「URL 当路径用」（阶段二百八十四，`adl 51.4.1` 实测）：两个 app 根各自成 scheme（`app-storage:/`、`app:/`），其余绝对路径是 `file:///` + 百分号编码（空格 `%20`、CJK 走 UTF-8 三元组）；`new File(url)` 能把 URL 解回原生路径、`nativePath` 是宿主拼写（Windows 全反斜杠）；并且真的**把 URL 当句柄**写/读一个文件（这正是 TalkMED 礼物图标「下载成功却显示空白」的根因：旧的 `file://` + 未编码原生路径被当字面路径 `fopen`，`Loader.load` 报 `#2035`）；相对路径保留为文档化偏差（AIR 在构造器抛 `#2004`）
- `examples/stage64.as` — `flash.filesystem`（`File` 路径/目录操作 + `File.separator`/`File.lineEnding` 宿主常量、`FileStream` 异步读写、`FileMode`）
- `examples/sqlite-basic.as` — `flash.data` 最小闭环（`open`/`execute`/`SELECT→SQLResult`/`close`，产物与 AIR / 宿主机 `sqlite3` 字节对拍）
- `examples/sqlite-phase-b.as` — `flash.data` 事务与契约（保存点/`attach`/`columnNameStyle`/`compact`/`analyze`/错误族二分）
- `examples/sqlite-phase-c.as` — `flash.data` 结果集（`prefetch`/`next`/`cancel`/`executing`/`itemClass` + 逐行 `SQLUpdateEvent`）
- `examples/sqlite-phase-d.as` — `flash.data` 模式对象（`loadSchema`/`getSchemaResult`/四个 `*Schema`/三态「没找到」错误）
- `examples/class-static-member.as` — 经 `Class` 值的静态成员（getter/var/const/方法四条路，`flash.data` 的前置修复）
- `examples/fqn-static/` — 类引用的**全限定名**与短名同义（静态字段/常量/getter/方法/函数值字段/写/复合赋值/setter，含内置 `File`/`System`/`Capabilities`/`NativeApplication`；阶段二百一十七）
- `examples/stage63.as` — `flash.net`/`flash.ui`（`URLRequest`/`URLLoader` 异步读本地文件/`URLVariables`/`Keyboard`/`Mouse`）
- `examples/http-request-api.as` — `flash.net` 语义面（`URLRequest` 属性默认值、`URLRequestDefaults`、`URLVariables.decode`、`useRedirectedURL`）
- `examples/loader-url.as` — `Loader.load` 的来源分流与错误号（`#2124`/`#2035`，远程走传输 seam）
- `examples/urlloader-contract.as` — `URLLoader` 契约（事件顺序、`close()`、`dataFormat`、失败错误号 `#2032`）
- `examples/urlloader-network-unsupported.as` — 远程 URL 在无后端构建下的诚实失败
- `examples/stage62.as` — `flash.display` 补齐（`MovieClip` 时间轴、`SimpleButton` 四态、`Loader`/`LoaderInfo`）
- `examples/stage61.as` — `flash.filters` 滤镜（默认值/构造/`clone`/`DisplayObject.filters`/`applyFilter`）
- `examples/stage60.as` — `flash.utils.Timer`（重复触发/`TIMER_COMPLETE`/`stop`/`reset`/`delay` 校验）
- `examples/stage59.as` — `flash.events` 事件子类（`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent`）
- `examples/stage58.as` — `flash.geom` 2D 几何（`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform`）
- `examples/stage57.as` — 精确 GC 泄漏断言（临时 record/array 对象 `System.gc()` 回收归零）
- `examples/gc_strings.as` — 字符串纳入 GC 堆的泄漏断言
- `examples/gc_incremental.as` — 增量标记内存有界断言
- `examples/gc_barrier.as` — 写屏障压力断言
- `examples/gc_midframe.as` — 中帧 `System.gc()` 断言（守护保守栈扫描根来源）
- `examples/closure_const.as` — 类型化 `const` 被闭包捕获的断言
- `examples/closure-statics.as` — **闭包内**读静态字段（阶段二百六十九，G22）：静态初始化先于第一次静态读，闭包读与普通方法读同口径；运行时初始化的标量与**静态数组/对象**（修前 `NAMES[0]` 抛 `#1009`）、只含字面量的类不生成 `_cinit`
- `examples/sharedobject.as` — `flash.net.SharedObject` 本地存储（读写/`flush`/磁盘回读/`size`/`clear`；**手写 AIR `.sol` 字节流再读回**两处：① 容器头/路径编码 + 「非空动态属性名进串表、其后条目不丢」；② 「空字符串不占槽」（两处**裸字节**断言把 AIR 的两条串表规则钉死）；③ 名字即相对路径（`#` 前缀、去一层前导 `/` 或 `./`）与 `localPath` 的接受集/拒绝集（第 55 格逐格实测自 `adl 51.4.1`，含 `#2134` 与 `null` 名字的 `#2007`））
- `examples/gc_alloc_threshold.as` — 非 GUI 目标的分配阈值自动回收
- `examples/gc_bytes.as` — `ByteArray`/`BitmapData` 字节缓冲纳入 GC
- `examples/loop-once.as` — 循环条件与 `for` update 每轮只求值一次
- `examples/field-shadow.as` — 同名字段遮蔽各占一个 C 槽 + 容器元素自增 + 分支内副作用不外泄
- `examples/null-eq.as` — null 只有一种表示（`==`/`!=`/`===`/`!==`/`typeof`/真值/`is Object`）
- `examples/async-io.as` — 异步 IO 契约（终态事件前 `data` 为 `null`、`PROGRESS` 先于 `COMPLETE`、并发请求）；
  阶段二百三十起 **Windows 与 POSIX 一样跑 4 个工作线程**：此前 Windows 没有线程后端，传输全内联在 AS3
  线程上，`load()` 本身阻塞整个往返（实测 150 ms 的服务端延迟 ⇒ `load()` 阻塞 154 ms），而「每收到
  `COMPLETE` 再取下一张」的胶片条（真应用的文档预览 32 页）会把 UI 卡住几秒；现在 `load()` 返回 1 ms、
  4 个 400 ms 并发请求 417 ms 全部完成（内联需 ~1600 ms）。锁/唤醒走 `SRWLOCK` + `CONDITION_VARIABLE`
  薄包层，POSIX 仍是 pthread，两侧共用同一份池循环（`test/unit/async-workers.ts` 钉住两侧形态）
- `examples/socket.as` — `flash.net` 套接字层（`Socket`/`ServerSocket`/`XMLSocket` 环回断言）
- `examples/proxy.as` — `flash.utils.Proxy` / `flash_proxy` 拦截
- `examples/with.as` — `with` 语句
- `examples/stage94c.as` — `getQualifiedSuperclassName` + `setInterval`/`clearInterval`
- `examples/stage94d.as` — `ByteArray` 多字节/布尔/下标读写/AMF3 对象读写
- `examples/stage94e.as` — A 批遗留攻坚（`as Object`、Function 值成员调用、反射、AMF3 trait）
- `examples/stage94f.as` — `DisplayObject` 几何与变换感知命中测试
- `examples/stage94g.as` — 可编辑 `TextField` 的模型与默认值
- `examples/stage94h.as` — `TextField.border`/`borderColor` 与颜色属性的 24 位口径
- `examples/stage94i.as` — `DisplayObject` 几何/坐标 API 族（`getRect`/`getBounds`/`localToGlobal`/`hitTestObject`）
- `examples/stage94j.as` — `MouseEvent.DOUBLE_CLICK` 的派发语义
- `examples/stage94k.as` — 空接收者成员访问的 `#1009`/`#1006` 语义
- `examples/stage94l.as` — `Tab`/`Shift+Tab` 焦点遍历
- `examples/stage94m.as` — `TextField.restrict` 与多行 `Return`
- `examples/stage94n.as` — 视觉行导航（`PageUp`/`PageDown` + 软换行 `Up`/`Down`）
- `examples/stage94o.as` — `displayAsPassword` 遮罩
- `examples/stage94p.as` — IME 合成中态（marked text）预览
- `examples/textedit.as` — 多行 `Return` 的 `textInput` 载荷（`"\n"`）与插入文本（CR）分离 + `preventDefault` 可拦
- `examples/ime.as` — `flash.system.IME` / `IMEConversionMode` / `IMEEvent`（类骨架、`#2007`/`#2063`/`#2012` 口径、四方法接合成通道）
- `examples/stage94q.as` — 字符串字面量的转义解码
- `examples/stage94r.as` — `TextField` 边框是屏幕空间 1px 线（不污染局部度量）
- `examples/stage94s.as` — `hitTestPoint` 的 `true` 分支是内容区域（非包围盒）
- `examples/stage94t.as` — `int64`/`uint64` 64 位整数（增强，见 `docs/zh-cn/enhancements.md` §4.7）
- `examples/textline.as` — `TextField.getLineMetrics` / `TextLineMetrics`
- `examples/bytearray-index.as` — `ByteArray` 下标形式的完整语义
- `examples/vector-coerce.as` — `Vector.<T>(arrayLike)` 是转换、`new Vector.<T>(length)` 是构造
- `examples/vector-dynamic.as` — `Vector.<*>` 与 `*` 接收者的动态访问
- `examples/embed.as` — `[Embed]` 资源（图片/字节/音频 → `Bitmap`/`ByteArray`/`Sound` 子类）
- `examples/audio/` — 带 UI 的音频播放器：`Sound.load` 的**编码文件加载** + `SoundChannel` + `soundComplete`（需 Skia/SDL2/miniaudio，见 `docs/zh-cn/audio.md` §13.5）
- `examples/strcoerce.as` — 对象 → 字符串的隐式强转
- `examples/flash-net-layered.build.example.json` — 构建清单按目标分层的最小示例（非 `.as`，供构建层断言）
- `examples/builtin-class.as` — 内建类注册表 & Class 值 + `in`/`delete`/下标
- `examples/wasm-native/` — `--target wasm`（WASI）产物，含 `--export` 与 `[WasmExport]` 导出面
- `examples/vsyncevent.as` — `VsyncStateChangeAvailabilityEvent`（AIR 面 + `refreshRate` 增强面）与 `Stage.vsyncEnabled`
- `examples/screen-mouse-event.as` — `flash.events.ScreenMouseEvent`（实测 11 参构造、只读 `screenX`/`screenY`、`clone` 只带构造级状态，以及动态写的 `#1074`/`#1037` 错误面）
- `examples/error-call.as` — 无 `new` 的 `Error(msg)` 是**构造**、其余类名调用是**运行时强转**（`#1034`），与 `catch (e:Error)` 的交互
每个示例编译后会在旁边留下同名 `.c` 文件，可直接阅读编译器生成的 C 代码。

## 鸣谢

本项目站在以下项目与第三方库的肩膀上，谨此致谢：

- **[TypePHP](https://github.com/swoole/typephp)**（[官网](https://swoole.com/aot/)）——把 PHP 编译成原生二进制的 AOT 编译器。「编译器前端只负责翻译、优化与机器码生成交给成熟 C 编译器、不重复造轮子」的整体思路，以及构建清单（`project.yml`）与多目标后端设计，均借鉴自它。
- **[Ruffle](https://github.com/ruffle-rs/ruffle)**（[官网](https://ruffle.rs/)）——Adobe Flash 的开源 Rust 重实现。其 AS3/AVM2 的 `flash.events.*` 事件流、`flash.display.*` 显示列表与交互命中测试实现，是本项目 GUI/事件系统语义的权威参照。
- **[Skia](https://github.com/google/skia)**（[官网](https://skia.org/)）——2D 图形库，渲染后端。本项目经 C++ 胶水层链接 Skia 实现光栅化（采用 [Aseprite 预编译静态库](https://github.com/aseprite/skia/releases) m124）。
- **[SDL](https://github.com/libsdl-org/SDL)**（[官网](https://www.libsdl.org/)）——跨平台窗口/输入库，窗口化后端（`Stage.showWindow`）经 SDL2 上屏与事件循环。
- **[miniaudio](https://github.com/mackron/miniaudio)**（v0.11.25）——单头文件音频库，`flash.media` 的音频后端（`vendor/audio_glue.c` 独立编译单元，`Sound`/`SoundChannel`/`SoundMixer`/`SoundTransform` 等由它驱动 **Core Audio（macOS）/ WASAPI·DirectSound·WinMM（Windows）**；web 端落到 Web Audio，WASI 无后端则如实报明）。
- **[libcurl](https://github.com/curl/curl)**（[官网](https://curl.haxx.se/)）——`flash.net` 的 HTTP/HTTPS 客户端。native 构建以**静态**归档链接 `vendor/curl/`（curl 8.11.1 + [nghttp2](https://github.com/nghttp2/nghttp2) 1.64.0 提供 HTTP/2 + [zlib](https://zlib.net/) 1.3.1 解码 gzip/deflate，TLS 走系统 SecureTransport），产物不残留 `libcurl.4.dylib` 动态依赖。
- **[Emscripten](https://emscripten.org/)**（[官网](https://emscripten.org/)，3.1.44）——`--target wasm --package web` 浏览器产物的工具链（`build-tools/emsdk`），经 `emcc` 编译链接 wasm 版 Skia；web 音频后端也用其随附的 `emscripten/webaudio.h`（AudioWorklet）。
- **[HarfBuzz](https://github.com/harfbuzz/harfbuzz)**——文本 shaping 引擎，随 Skia 的预编译静态库一同引入，`flash.text` 的 `TextField`/`TextFormat` 排版（SkParagraph + HarfBuzz shaping + UAX#14 换行）由它完成。
