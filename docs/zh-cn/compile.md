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

- **Node ≥ 18**：发布到 npm 的包是**已转好的 JavaScript**（`dist/`），不需要 type-stripping。
  **从源码跑**（`node src/index.ts`，即 clone 里的用法）才需要 **Node ≥ 22.18**（类型擦除默认开启的版本；
  22.6–22.17 需额外加 `--experimental-strip-types`），自行 `npm run build:dist` 亦然。
  `dist/` 由 `scripts/build-dist.ts` 生成（挂在 `prepare` 上，`npm pack` / `npm publish` 自动跑）——
  `bin` **不能**指回 `src/index.ts`：Node 拒绝对 `node_modules/` 下的 `.ts` 擦类型
  （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），那会让每一种安装方式装完即崩。
  转换是等长空白替换，行号与 `src/` 一一对应，生成的 C 与直接跑 `.ts` 逐字节相同；
  该形态由 `unit: npm-package/PublishForm`（19 钉）封住。
- **C 编译器**：`cc` / `clang`（native 目标默认 `cc`，可用 `--cc` 覆盖）。
- **预编译依赖库**：`vendor/` 里入库的是 **macos-arm64 / windows-x64 / windows-x86 / wasm** 四套。
  本机不在其中（Linux、Intel Mac）时，`--air-app` **响亮报错**并说明只有哪几套存在，
  而不是悄悄按 `macos-arm64` 去链一套 ARM64 归档 + Cocoa 框架。
  - 这些产物**怎么来的**在 `vendor/provision/`（`windows.ps1` / `macos.sh`；产物本身与胶水源码留在
    `vendor/` 下）；判定「本机缺什么」用 `as-aot doctor`（§3.6）。
- **WASI 工具链**（仅 `--target wasm` 需要）：WASI SDK 或自带 `wasm32-wasip1` 后端的 LLVM clang。
  - 约定通过环境变量 `WASI_SDK_HOME` 指向 SDK 根目录，编译器位于 `$WASI_SDK_HOME/bin/clang`，
    sysroot 位于 `$WASI_SDK_HOME/share/wasi-sysroot`。
  - 未安装时，`--target wasm` 的实际编译会报出明确的「WASI 工具链缺失」提示（含安装指引），
    而非泄漏 clang 底层的 `'stdio.h' file not found`；`--dry` 仍可预览编译命令。
  - AS3 异常（`throw`/`try`/`catch`/`finally`）在生成 C 里映射为 `setjmp`/`longjmp`，WASI 上这套要走
    WebAssembly 异常处理提案，因此 wasm 编译会附加三个开关：
    - `-mllvm -wasm-enable-sjlj`：让 LLVM 把 `setjmp`/`longjmp` 降到 `__wasm_setjmp`/`__wasm_longjmp`
      （`longjmp` 抛 tag，`setjmp` 所在帧 `catch` 回来）——wasip1 的 libc 里根本没有这两个符号；
    - `-mllvm -wasm-use-legacy-eh=false`：改用**标准** EH 指令（`try_table`）。该降级默认发旧版 `try`，
      wasmtime 默认特性下会拒编（`legacy_exceptions feature required for try instruction`），浏览器也从未实现旧版；
    - `-lsetjmp`（置于目标文件之后）：wasi-libc 把 `__wasm_setjmp`/`__wasm_longjmp`/`__wasm_setjmp_test`
      放在**单独的** `libsetjmp.a`（不在 libc.a 里）。
    后两项由构建层探测 sysroot 是否带 `lib/wasm32-wasip1/libsetjmp.a` 决定是否追加；缺库时不追加，
    真用到异常仍会**响亮报错**（`wasm-ld: undefined symbol __wasm_setjmp`）而非静默降级。
  - 运行产物需支持**标准**异常处理提案的运行时：wasmtime ≥ 24 开箱即用，浏览器 Chrome/Edge 119+、
    Firefox 131+、Safari 18.4+ 亦支持；wasm3 与只实现旧版 EH 的运行时跑不了带异常的程序
    （无异常的程序不受影响——见下）。
  - 无异常的程序与从前**逐字节等价**：`-lsetjmp` 是静态库，未被引用的成员不会进产物（`examples/hello.as`
    加开关前后 `.wasm` 代码段完全相同）。

## 3. 命令行用法

```text
Usage: as-aot <input.as> [more.as ...] [options]
       as-aot doctor [options]        report whether this machine can build what the flags ask
       as-aot version                 print the compiler version (same as --version / -V)

Options:
  -o <path>      output path (native: executable; wasm: .wasm appended); also the base
                 for every sibling artifact — the generated .c, the .o/.lib, icudtl.dat
                 and the staged extensions/ all land beside it, so `-o bin-aot/App.exe`
                 keeps the source tree free of build output
  --run          run the compiled output after building
  --cc <name>    C compiler to use (default: cc)
  --target <t>   native (default) | wasm (WASI)
  --package <p>  raw (default) | xcode-project (macOS .app) | android-project | web (browser)
  --manifest <f> build manifest JSON (extra sources / include / link libs)
  --air-app <xml> AIR app descriptor: generate bootstrap + build manifest
  --main-class <n> main class for --air-app (default: infer src/**/Main.as)
  --all-sources  --air-app: compile every .as under src/ instead of the main class
                 reachable closure (see §3.5; pre-阶段一百二十四 behaviour)
  -I <dir>       include path (repeatable)
  -L <dir>       library search path (repeatable)
  -l <lib>       link library (repeatable)
  -D <macro>     preprocessor define (repeatable)
  --framework <n> link a macOS framework (repeatable; distinct from clang -F, which is a search path)
  --source <f>   extra C/C++ source to compile and link (repeatable)
  --swc <f>      .swc library: bake its named bitmap resources, vector shapes and
                 display tree at compile time (repeatable; see docs/zh-cn/swc.md §5/§6/§9)
  --ane <f>      AIR native extension: load its native library through the FRE host
                 (repeatable; needs the host library from lib/build-asaot.bat on Windows /
                 lib/build-asaot.sh on macOS, and an
                 ANE recompiled against it — see docs/zh-cn/ane.md §4)
  --ane-platform <key> override the ANE platform entry, e.g. Windows-x86-64 |
                 Windows-x86 | MacOS-x86-64 | iPhone-ARM; also selects
                 which host-library width under lib/bin/ is used (default: this host;
                 Windows ARM64 has no AIR key: pass Windows-x86-64 + a 64-bit build)
  --extdir <dir> where the .ane packages an --air-app descriptor declares live
                 (repeatable; replaces the default <appDir>/ext-aot then
                 <appDir>/lib then <appDir>/ext-folder — see docs/zh-cn/ane.md §3.6)
  --as-class-path <dir> --air-app: an EXTRA source root compiled alongside src/, so a
                 library shared by several apps lives in one place (repeatable; paths
                 are cwd-relative; a class declared under two roots is an error, never
                 last-wins — see §3.5.2)
  --export <name> export a C symbol into the .wasm export table (repeatable)
  --opt <flags>  optimization flags (default: -O2)
  --cflag <f>    extra C compiler flag for every compile AND link step (repeatable;
                 passed through verbatim, e.g. --cflag -fno-strict-aliasing)
  -w             shorthand for --cflag -w (silence warnings)
  --debug-info   keep DWARF: add -g to every backend and stop stripping it from the
                 default wasm build (default: off — artifacts carry no debug info; see §4.3)
  --dry          emit C and print the compile command without compiling
  -V, --version  print the compiler version (read from package.json) and exit
  -h, --help     show this help
```

`as-aot --version`（或 `-V` / `version` 子命令）打印编译器版本——版本**只有一个来源**
（`package.json`，`doctor` 报告的头行也带它），报 bug 时请先把它带上。出错时 stderr 只印一行
错误信息；要连 Node 堆栈一起看（那是报**编译器自身**的 bug 时需要的）设 `AS3_TRACE=1`。

开关写错时，那一行会**给出下一步**而不只是重复你敲的名字：与某个真开关相近（`--versoin`、
`--feat`）直接提示 `did you mean --version?`；差得太远（`--sss`）则指向 `as-aot --help`。
开关没拿到值——`-o` 落在行尾、或 `-o --dry` 把下一个开关吃成了它的值——**报错而不是猜**；
而只是**以 `-` 开头**的值（`--opt -O3`、`-D FOO=-1`）仍算值。

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

#### 宿主桩需要提供的 WASI import

生成的 `.wasm` 是 WASI 模块，宿主（浏览器 / 自定义运行时）必须为它的**整份** import 集合提供函数，
否则 `WebAssembly.instantiate` 直接失败（浏览器实测报 `function import requires a callable`）。
当前运行时因为 GC/IO 的调试开关读 `getenv`、文件 job 用 `fopen`，每个 wasm 模块都会导入 **18** 个
`wasi_snapshot_preview1` 函数，其中包含 `environ_get`/`environ_sizes_get` 与文件系统一族
（`path_open`/`fd_read`/`fd_readdir`/`path_filestat_get`/`fd_fdstat_set_flags`）。在浏览器里跑一个**不碰文件/环境**
的程序时，这些桩可以如实返回「空环境 / `EBADF` / `ENOENT`」 —— 见 `examples/wasm-native/fib.html`、`index.html`
的**逐条显式桩**，或 `fib-export.html`、`export-meta.html` 的 **Proxy 通配桩**（后者对 import 集合变化免疫）。
列出某个 `.wasm` 的实际 import 集合：`node temp/regen/imports.mjs <file.wasm>`。

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

# macOS 系统框架（如 static curl 需要的 Security / SystemConfiguration）与附加 C 源
as-aot app.as -I vendor/curl/include -L vendor/curl/lib/macos-arm64 \
  -l curl -l nghttp2 -l z -D ASC_HAVE_CURL \
  --framework Security --framework SystemConfiguration --source vendor/sysproxy_glue.c

# 或走构建清单（推荐，可版本化复用）—— 一份清单同时服务 macOS 与 Windows
as-aot app.as --manifest examples/skia-link.build.example.json
```

命令行的 `-I/-L/-l` 是**字面量**（不展开占位符，§4.1.1）：手工写 Windows 那条就是
`-L vendor/curl/lib/windows-x64 -l curl ...` 不加 `--framework`，另加 `-l gdi32 -l ws2_32` 等导入库。

#### 3.4.1 `flash.net` 的网络后端是 **opt-in 宏**，不是默认行为

`http(s)://` 的传输后端**不默认链接**：不声明宏时构建仍是零依赖、自包含、无网络，
且远程 URL 会派**可区分**的诚实 `ioError`（与「文件不存在」不共用文案）。两个宏各管一目标：

| 目标 | 宏 | 额外需要 | 拿到的能力 |
|---|---|---|---|
| native | `ASC_HAVE_CURL` | `link-libs: ["curl"]`（系统 libcurl 或 §3.4.4 的静态 `vendor/curl`） | `URLLoader`/`URLStream` 真传输（HTTP/1.1 + TLS + 重定向），`navigateToURL` 拉起系统浏览器，`Socket`/`ServerSocket`/`XMLSocket`（`ASC_SOCK_POSIX`，默认开） |
| web（`--package web`） | `ASC_HAVE_FETCH` | 无（浏览器内置 `fetch`） | 同上（受 CORS/受限头/不透明重定向约束，见 [`html5-web.md`](html5-web.md) §6 第 10 条） |
| wasm32-wasip1 | —（无后端） | — | preview1 无 socket 原语，如实报 `ioError` |

> **`--air-app` 是自动挂载的例外。** 手写 `.as` 工程按上表显式 opt-in；而 AIR 项目走
> `--air-app` 时，网络依赖**从源码推断**——`src/air-app.ts` 的 `detectNetworking()` 扫
> `src/**/*.as` 是否出现 `URLRequest`（与 `detectStage3D` 同一形态，零配置），
> 命中即把 native 的 `-l curl -l nghttp2` + `vendor/curl/{include,lib}` 路径 +
> `Security`/`SystemConfiguration` + `ASC_HAVE_CURL=1` 写进生成的清单；web 目标改写
> `ASC_HAVE_FETCH=1`（浏览器里唯一可用的 HTTP 客户端就是页面自己的 `fetch()`）。原因是
> `--air-app` **每次运行都会重写 `<filename>.build.json`**，手改清单活不过下一次构建，
> 所以链接集必须由生成器给出（阶段八十九·五十五）。漏掉它的症状不是编译失败，而是
> 「编译过、跑得动，但每次请求都落可区分的诚实 `ioError`」（`AS_JOB_ERR_UNSUPPORTED`）。
> 不碰网络的 AIR 项目保持零依赖默认形态；native 下 `vendor/curl` 缺失时**立即报错**并
> 给出 `build-tools/curl-src/build-static.sh`，不静默退化。判据选 `URLRequest` 而**不是**
> `import flash.net.*`：该包还装着 `SharedObject`/`FileReference`/`LocalConnection` 这些
> 从不碰 HTTP 的类，按包名匹配会白白给 1.4 MB 静态 curl 进链接集，还会在本机没建
> `vendor/curl` 时把一个用本地存储的 app 卡在报错上。

同目标的**附加开关**（默认全关，逐项 opt-in）：

| 宏 | 默认 | 效果 |
|---|---|---|
| `ASC_HTTP2` | 关（钉 HTTP/1.1） | 允许 TLS 协商 h2。**默认关是保真选择**：h2 会规范化响应头名并省略连接级头，AS3 侧可见（AIR 的传输本就是 HTTP/1.1） |
| `ASC_SYSTEM_PROXY` | 关 | 读 macOS 系统代理（`SCDynamicStoreCopyProxies`）并交给 libcurl。**必须配 `--source vendor/sysproxy_glue.c`**：`<SystemConfiguration/SystemConfiguration.h>` 会牵入 `MacTypes.h` 的 `struct Point`，与生成 C 的 `flash.geom.Point` 结构体冲突，故该系统调用只能待在独立编译单元（生成 C 里只留 `extern` 声明） |
| `ASC_SOCK_POSIX` | **开**（POSIX 目标自动定义） | TCP 套接字底座（`Socket`/`ServerSocket`/`XMLSocket`）。无 POSIX socket 的目标（WASI/Web/Windows）自动退化：如实派 `ioError` |
| `ASC_HAVE_FETCH` | 关（web 目标） | 浏览器 `fetch` 后端 |

环境变量代理（`http_proxy`/`https_proxy`/`all_proxy`，大小写皆可）**无需宏**：libcurl 原生消费它们，
且 seam 会在检测到这些变量时跳过系统代理查询（避免两套代理设定互相覆盖）。

一份清单服务三目标用 `targets` 覆盖块（§4.1）：

```json
{
  "link-libs": ["curl"],
  "defines": ["ASC_HAVE_CURL"],
  "targets": {
    "wasm": { "link-libs": [], "defines": [] }
  }
}
```

#### 3.4.2 具名增强开关（`--features` / 清单 `features`）

比 `-D` 高一层：把「一个 AIR 超集能力」当作**具名开关**打开，而不是让用户手写它背后的宏。
名字只声明它是什么（增强、非 AIR 行为），宏由编译器解析。

```bash
as-aot app.as --air-app app.xml --features svg      # 等于 -D ASC_USE_SVG=1
as-aot app.as --air-app app.xml --features none     # 清空（见下：会把持久化的选择一并清掉）
```

| 名字 | 宏 | 可用目标 | 说明 |
|---|---|---|---|
| `svg` | `ASC_USE_SVG=1` | 仅 `native` | 见 §3.4.3 |
| `formats` | `ASC_ALLOW_EXTRA_FORMATS=1` | `native` / `wasm` | 额外图片格式 WebP / BMP / ICO（AIR 对它们报 `#2124`，故**默认拒绝**——见 §3.4.3.1） |
| `raw` | `ASC_ALLOW_RAW_FORMATS=1` | 仅 `native` | 相机 RAW / DNG（默认拒绝——见 §3.4.3.1；web 侧 Skia 无 piex/dng_sdk 归档，故目标不支持时就报错） |
| `tray` | `ASC_USE_TRAY=1` | 仅 `native`，**且宿主须为 macOS** | `SystemTrayIcon` 背后是真 `NSStatusItem`（见 §3.4.5）。AIR 在 macOS 上根本没有托盘（`supportsSystemTrayIcon=false`、`#2012`），故默认关闭 |

清单里同名字段是一份**字符串数组**，语义与 CLI 一致：

```json
{ "features": ["svg"] }
```

规则（三条都是为了**不静默**，AGENTS.md §1.5）：

- **默认全关**：不开时产物与以前**逐字节相同**，与 `adl` 同构。开了会打印一行
  `== enhancements: svg (-D ASC_USE_SVG=1) ==`，并在提示里写明它是 AIR 超集。
- **未知名字报错**，不静默忽略：`--features lottie` 会报 `unknown feature 'lottie' (known: formats, raw, svg, tray)`
  并在**生成任何代码之前**退出（清单里也已实现的能力才会被登记，登记了却没实现的开关
  等于给用户一个「看着开了、实际没编进去」的东西）。`--features none` 不能与其它名字同用。
- **目标不支持就报错**：`--target wasm --features svg` 直接报
  `feature 'svg' is not available with --target wasm`，而不是把 `undefined symbol: sk_svg_*` 留给链接器。
  `native` 编的是**本机**可执行文件，所以宿主相关的通道还能再收紧一层：`--features tray` 在非 macOS 宿主上
  直接报 `feature 'tray' needs a darwin host: ...`（否则用户会拿到一个「开了、但那个平台上是空桩」的开关）。

`--features` 与 `-D` 的区别：`-D` 是**追加**一条宏，`--features` 是**替换**整个增强集合——
「本来开着 svg、我只想要别的」这种话只有替换语义能表达。

#### 3.4.2.1 `--air-app` 会**持久化**增强选择

`--air-app` 每次运行都会**整份重写**生成的 `<filename>.build.json`（它是从 app.xml + src 扫描
推导出的构建产物）。所以一个被选中的增强必须能挺过这次重写，否则「打开 SVG」只能靠每次都在
命令行重复——这正是本开关存在的理由。

- `--features svg` 会把 `"features": ["svg"]` 写进生成的清单；**下次不带参数运行仍然生效**，
  并打印 `enhancements carried over from ...: svg`（**不是静默**）。
- 要关掉：`--features none`（清空并同样持久）。
- 只有 `features` 会被继承：其它字段都是描述符与源码的函数，复活一个过期的生成值
  （一个已被去掉的宏、一个旧的链接库）就是一次静默的错误构建。

#### 3.4.3 图片解码的 SVG 通道也是 opt-in 宏（`ASC_USE_SVG`）

编码图片里 **只有 PNG/JPEG/GIF 无需宏**——它们是 AIR 支持的格式（`adl` 解得出来）。BMP/WebP/ICO 两端
Skia 虽编入了对应 codec，但 AIR 对它们报 `#2124`，故**默认拒绝、须显式开关**（`--features formats`，
见 §3.4.3.1）。
**SVG 不同**：它不是 `SkCodec` 格式，走的是独立通道（`SkSVGDOM` 解析 → `SkSurface` 光栅化），
且 AIR 的 `Loader` **从不支持 SVG**，故按 §1.5 做成 **opt-in**：

```bash
# native：一条命令（libsvg/libsksg/libexpat 已在清单的 link-libs 里）
as-aot app.as --air-app app.xml --features svg

# 等价写法（具名开关只是替你把这条宏解析出来）
as-aot app.as --air-app app.xml -D ASC_USE_SVG=1
```

| 构建 | `Loader.load("x.svg")` |
|---|---|
| 默认 | `ioError #2124 Error #2124: Loaded file is an unknown type.` —与 `adl` 逐字相同 |
| `--features svg`（= `-D ASC_USE_SVG=1`） | 解码成功（`<text>` 经 `SkFontMgr` 正常出字；无绝对尺寸的文档按规范默认 300×150） |

**web 不支持**：`vendor/skia/lib/wasm` 里没有 `libsvg.a`/`libsksg.a`/`libexpat.a`（wasm `args.gn` 的
`skia_use_expat=false` 把 svg 目标整体门掉），定义该宏会在**链接期**失败——显式报错，不静默降级。
要支持须改 wasm `args.gn` 并**重编 wasm Skia**。详见 [`enhancements.md`](enhancements.md) §4.1 与
[`skia.md`](skia.md) §9.1。

#### 3.4.3.1 图片格式与相机 RAW 的**默认拒绝**（`formats` / `raw`）

同一个道理的另外两处：我们的 Skia 带的 codec 比 AIR 多，而「多」必须 opt-in（AGENTS.md §1.5）——
否则默认产物就**比 AIR 宽**：`adl` 会拒绝的输入我们却接受了，这正是标准 (d) 禁止的形态。

| 输入 | 默认构建 | 开关 |
|---|---|---|
| PNG / JPEG / GIF | 正常解码（AIR 同） | 不需要 |
| **BMP / WebP / ICO** | `ioError #2124 Error #2124: Loaded file is an unknown type.`（与 `adl` 逐字相同） | `--features formats`（= `-D ASC_ALLOW_EXTRA_FORMATS=1`，两端可用） |
| **相机 RAW / DNG / CR2 / NEF / ARW / ORF / RW2… / RAF** | 同上 `#2124` | `--features raw`（= `-D ASC_ALLOW_RAW_FORMATS=1`，**仅 native**） |
| SVG | 同上 `#2124` | `--features svg`（§3.4.3） |

实现是胶水层的**魔数拦截**（`vendor/skia_glue.cc` 的 `sk_extra_format_refused`，四条解码入口都查）：
`RIFF....WEBP`、`BM`、`ICO/CUR`、TIFF 头（`II*\0`/`MM\0*`，DNG/CR2/NEF/ARW/ORF/RW2 等 TIFF 系 RAW 的
公共头）、`FUJIFILMCCD-RAW`（RAF）。命中即当作解码失败，于是**自动**走上层既有的 `#2124` 路径——报的错
与 `adl` 无需另行维护就保持一致。命中失败（不认识的头）仍照旧交给 Skia，行为与从前一样。

`--features raw --target wasm` 会被**前置拒绝**（`the wasm Skia has no piex/dng_sdk archive ...`）；
`--features formats` 在两端都可用。`WBMP`（`SkWbmpCodec` 编入了）**故意不拦**：它的头部是裸多字节
类型字段、没有可靠魔数，与其猜一个可能误伤真格式的判据，不如如实记在这里。

#### 3.4.4 静态自包含（`vendor/curl`）

`link-libs: ["curl"]` 会**动态链接系统 libcurl**（macOS 上是 `/usr/lib/libcurl.4.dylib`），产物不再是
单文件自包含。要自包含：`build-tools/curl-src/build-static.sh` 从源码编出 `libcurl.a`/`libnghttp2.a`/`libz.a`
落 `vendor/curl/{include,lib/macos-arm64}`，清单指过去即可（[`examples/flash-net-layered.build.example.json`](../../examples/flash-net-layered.build.example.json)
就是这种形态）：

```json
{
  "target": "native",
  "targets": {
    "native": {
      "link-libs": ["curl", "nghttp2", "z"],
      "link-paths": ["../vendor/curl/lib/macos-arm64"],
      "include-paths": ["../vendor/curl/include"],
      "frameworks": ["CoreFoundation", "CoreServices", "Security", "SystemConfiguration"],
      "defines": ["ASC_HAVE_CURL"]
    }
  }
}
```

> `frameworks` 字段等价于 CLI 的 `--framework`（链接 `-framework <名>`）。`libz.a` 与系统 `libz`
> 同名，靠**库搜索路径顺序**保证静态命中（可能看到 `ld: warning: ignoring duplicate libraries: '-lz'`
> 的提示，无副作用）。验收口径：`otool -L` 的输出里**不应**出现 `libcurl.4.dylib`/`libz.dylib`。
> **默认构建（不声明这些宏/库）完全不受影响**。

#### 3.4.5 菜单栏状态项（`tray` / `ASC_USE_TRAY`）

`flash.desktop.SystemTrayIcon` 在 **macOS 的 AIR 上不存在**：`adl 51.4.1` 实测
`NativeApplication.supportsSystemTrayIcon == false`、`new SystemTrayIcon()` 抛
`Error #2012: SystemTrayIcon$ class cannot be instantiated.`。所以这条通道是**超集增强**（见
[`enhancements.md`](enhancements.md) §4.11），默认关闭，且**默认产物与 AIR 逐字同形**。

```bash
# 默认：menu bar 里什么都不出现，supportsSystemTrayIcon 为 false，构造照旧 #2012
as-aot app.as --air-app app.xml

# 打开：同一段 AS3 拿到一个真的 NSStatusItem
as-aot app.as --air-app app.xml --features tray
```

| 构建 | `NativeApplication.supportsSystemTrayIcon` | `new SystemTrayIcon()` |
|---|---|---|
| 默认 | `false`（与 `adl` 相同） | `#2012`（与 `adl` 相同） |
| `--features tray` | `true` | 构造成功，出现菜单栏图标 |

**可用条件**：`--target native` 且**宿主是 macOS**。两个条件都在**生成代码之前**校验：
`--target wasm --features tray` 报 `feature 'tray' is not available with --target wasm`；
在 Windows 宿主上报 `feature 'tray' needs a darwin host: the status item is an NSStatusItem (AppKit), so the channel only exists on macOS`。
理由与 `raw`/`svg` 同一条：给用户一个「开了但编不进去」的开关比不给开关更坏。

**打开之后的行为**（细节与实测证据见 [`enhancements.md`](enhancements.md) §4.11）：

- `bitmaps` 的第一张有效 `BitmapData` 作为图标（ARGB 直通，胶水层预乘一次）；`tooltip` 原样上屏；
  `menu` 展平成 `NSMenu` 挂到状态项，菜单项点击与 App / Dock 菜单**走同一条 tag 通道**（`Event.SELECT`）。
- 点击派发 `flash.events.ScreenMouseEvent`：左键 `MouseEvent.CLICK`、右键 `MouseEvent.RIGHT_CLICK`，
  `screenX`/`screenY` 是**点击点**的屏幕坐标（左上原点、point；多显示器时按**主显示器**高度翻转 y ——
  `[NSScreen mainScreen]` 是「键盘焦点所在屏」，用它会在副屏上算错）。
- **一个进程一个状态项**：再 `new` 一个复用同一槽位，最后构造的那个拥有它（AIR 无 macOS 行为可抄，故固定并写明）。

清单里同名字段：`{ "features": ["tray"] }`；`examples/status-item.as` + `examples/status-item.build.json`
是最小可用例子。

#### 3.4.6 窗口 GPU 后端（`--gpu-backend`，Windows）

Windows 上有**两个**窗口合成后端：默认的 **D3D12**（`vendor/d3d_glue.cc`，阶段一百二十六）和
**WGL/OpenGL**（`vendor/gl_glue.cc`）。两者都是「Skia 直接画进交换链」，区别只在把画面交给合成器的那一层。

```bash
# 默认 auto：Windows 上就是 D3D12，macOS 上是 Metal
as-aot --air-app app.xml

# 显式指定（与 auto 产物逐字相同，只是把选择写进清单）
as-aot --air-app app.xml --gpu-backend d3d12

# 换 WGL：同一份源码、同一棵 Skia，走 opengl32
as-aot --air-app app.xml --gpu-backend gl
```

| 取值 | Windows | macOS | 说明 |
|---|---|---|---|
| `auto`（缺省） | D3D12 | Metal | 与引入本开关之前**逐字节相同** |
| `d3d12` | D3D12 | — | 显式钉住，`auto` 的含义将来变了也不跟着漂 |
| `gl` | WGL / OpenGL | — | 见本节全部约束 |

##### 为什么它不在 `app.xml` 里（实测，不是判断）

AIR 描述符的 `<windows>` 里确实有同类先例 —— `<maxD3D>` 选择 D3D 版本。但**描述符装不下第三方后端名**，
这是量出来的：

- `Descriptor.51.4.xsd` 里 `<windows>` 是 `xs:all`，子元素只有 `UseWebView2` / `maxD3D` / `localAppData` /
  `useDirectDrawFonts` 四个；**整份 XSD 没有任何 `xs:any`**，即不存在扩展点。
- 拿 `adt -package` 实测（夹具 `temp/descext/`，自签 `test.p12`）：加 `<gpuBackend>` 报
  `FAIL(12): error 103: application.windows.gpuBackend is an unexpected element/attribute`；
  换成**异命名空间**的元素（`<windows>` 内、顶层各一例）与 `<application>` 上的异命名空间**属性**，
  四种写法**全部 error 103**。
- `adl` 对上述四种写法都**沉默**，但这**不是** schema 接受 —— `adl` 只做手写的子集检查，它同样接受
  `<maxD3D>abc</maxD3D>`（`adt` 会拒绝）。`adl` 的退出码 0/6/7/8 只覆盖「找不到描述符 / 缺 `content` /
  缺 `initialWindow`」三件事，不构成「描述符合法」的证据。

所以选择走**我们自己的生成清单**（`gpu-backend` 字段，§4），AIR 从不读它 —— 与 `features` 的存法
（§3.4.2.1）是同一条路。

##### 优先级与持久化

```
--gpu-backend（本次调用）> 上次生成的清单里的 gpu-backend > ASC_GPU_BACKEND 环境变量 > auto
```

- `--gpu-backend gl` 会把选择**写进 `<filename>.build.json`**，之后不带 flag 重跑仍然生效（否则每次
  增量构建都要记住一个 flag）。
- `--gpu-backend auto` **显式清除**清单里的字段 —— 「字段不存在」就是 `auto`，因此不会有陈旧值残留。
- `ASC_GPU_BACKEND` 是原型期的临时开关，**保留**作最低优先级别名（现有脚本不至于一夜失效），但它输给
  任何被钉住的值时会打印黄字说明谁赢了，**不会**静默让步。

##### 五种情况会被**拒绝**，而不是「开了但什么都不变」

按 [`../AGENTS.md`](../../../AGENTS.md) §1.5/§2.5：一个看起来生效、实际没生效的开关比没有开关更糟。

| 情况 | 报错要点 |
|---|---|
| `--gpu-backend` 不带 `--air-app` | `only applies to --air-app`（裸 `.as` 构建没有描述符可读，后端由 `-D` 决定） |
| `--target wasm --package web` | `a web build has no window backend to choose`（浏览器只有 WebGL2） |
| 宿主不是 Windows | `Windows-only`；并指出 macOS 对应物是 `metal_glue.mm` |
| 描述符没编进 GPU 窗口（`<renderMode>` 为 `auto`/`cpu` 或 `visible=false`） | `does not ask for one`，并指出要 `renderMode>direct` |
| `--gpu-backend gl` + Stage3D | `no Stage3D backend`（`vendor/stage3d_d3d.cc` 是 HLSL/`vs_5_1`，GL 上跑不了；拒绝而不是链进去变成黑色舞台） |

清单里的 `gpu-backend` 与 `defines` 由 `applyManifest` **交叉校验**，不重新推导：`gl` 必须带
`ASC_RENDER_GL=1`、`d3d12` 必须带 `ASC_RENDER_D3D=1`，两个宏同时出现直接报
`one binary links one window GPU backend`。这样手改清单的人不会以为改了一行就换了后端。

##### 实测：换后端**不提帧率**

同一个 `GalleryApp`（1500×1050 @150% DPI，Win11 26200，RTX 4090 D），`ASC_GPU_STATS=1` 读「每帧图形
工作耗时」（已排除 vsync 阻塞）：

| 后端 | 帧时 | fps | 图形工作 | 自动烘焙关闭后 |
|---|---|---|---|---|
| `cpu`（CPU 光栅 + `SDL_UpdateTexture`） | 42.00 ms | 23.8 | — | — |
| `d3d12` | 42.00 ms | 24.0 | 1.28 ms | 2.30 ms |
| `gl` | 42.00 ms | 24.1 | **0.55 ms** | 1.00 ms |

结论要照实说：**帧时三者相同**，瓶颈在 AS3/布局侧（图形只占 1.3–5.5%）；GL 省下的是**提交路径**
（约 1.1–1.3 ms/帧），不是总帧时。像素等价性也量过：同帧对比差 1026 px（0.067%），且全部落在 y=84..92
一条 9–10px 横带内 —— 同一个 exe 连跑两次在同一带内也差 114 px（示例动画的时序抖动），故不是后端差异。

##### 已知边界（未测项照实列）

- **present 模型不同**：D3D12 走 `FLIP_DISCARD`（Win10+ 唯一能进 independent flip 的交换模型），WGL 的
  `SwapBuffers` 是 blt 模型，窗口模式**必经 DWM 合成**。实测帧时没差，但合成延迟没测（需抓帧工具）。
- **只在 Win11 26200 + RTX 4090 D + 单显示器上跑过**。Intel/AMD 老驱动、远程桌面、虚拟机下的 WGL 行为，
  以及 compat profile 下 `glTexStorage2D` 之类快路径的可用性，**均未测**。
- Stage3D 与 GL 的组合是**构建期拒绝**（上表最后一行），不是「跑起来差一点」。
- 链接期仍需 `d3d12`/`dxgi`/`d3dcompiler` 三个导入库：`vendor/skia/lib/windows-x64/skia.lib` 是按
  `skia_use_direct3d=true` 编的，`GrDirectContexts::MakeGL` 与 `MakeDirect3D` 在同一个 TU。
  `/OPT:REF` 之后产物导入表是干净的（实测只有 `OPENGL32` + 系统 DLL，**不含** `d3d12.dll`/`dxgi.dll`/
  `d3dcompiler_47.dll`），这本身就是要报明的一条：**链接期依赖 ≠ 运行期依赖**。
- 上下文**刻意建 compat profile**：AGAL→GLSL 生成器输出的是 ES 1.00（`attribute`/`varying`/`texture2D`），
  升到 core profile 要动 web 共用的那份生成器，回归面更大。

平台侧的取舍与 Windows 专属细节见 [`win32.md`](win32.md) §3.1.1。

### 3.5 AIR 应用描述符（--air-app）

解析 AIR `app.xml`，自动生成引导启动代码 + 构建清单，把纯 AS 的 AIR 项目一键迁移到 as-aot：

```bash
# 一条命令：解析 app.xml -> 生成 bootstrap + manifest -> 编链出窗口化可执行
as-aot --air-app examples/air-native/air-native-app.xml

# 显式指定主类（app.xml 不含 document class；缺省扫描 src/**/Main.as 推断）
as-aot --air-app examples/air-native/air-native-app.xml --main-class demo.Main

# 共享类库作为额外源码根（阶段二百五十）：air-native 的 GreenSock 在 examples/as-library，
# 往 src/ 里拷一份已经不是必需（见 §3.5.2）
as-aot --air-app examples/air-native/air-native-app.xml --main-class Main --as-class-path examples/as-library

# 同一 AIR 项目直接编到浏览器（--target wasm --package web）：自动切到 web 后端
as-aot --air-app examples/air-native/air-native-app.xml --target wasm --package web
```

流程：解析 `<id>/<filename>/<initialWindow>`（`title`/`width`/`height`/`visible`/`resizable`/
`requestedDisplayResolution`/`renderMode`/`maximizable`/`minimizable`/`systemChrome`/`transparent`/`x`/`y`/`minSize`/`maxSize`）→
生成等价 `boot-gui.as` 的引导代码（`new Stage()` → 预设 `stageWidth/stageHeight` → `new Main()` →
`addChild` → `showWindow`；`visible=false` 时改用离屏 `render` 出 PNG）→ 递归扫描 `src/**/*.as`
（跳过反向域名第三方库目录 `com/org/net`；共享类库改用 `--as-class-path <库根>` 加入编译面，
见 §3.5.2——air-native 的 GreenSock 核心就在 `examples/as-library`，不再往 `src/` 里拷一份）→
在 app.xml 同目录写出 `<filename>.build.json`（链接 Skia + SDL2）→ 编链出 `<filename>` 可执行
（**产物名与全部产物的落点**都可用 `-o` 覆盖：`-o` 决定 `base`，故生成的 `.c`、
`icudtl.dat`、暂存的 `extensions/` 与 `asaot.dll` 全跟着走 —— `-o bin-aot/App.exe` 即可让源码树
零产物。`.o` 例外：它是**中间产物**而非发行物，自阶段二百二十三 起落在**本次构建独占**的临时目录
（`$TMPDIR/as-aot-obj/<配置指纹>-<构建进程 pid>/`，`--dry` 会打印真实路径），链接成功后整个目录
被回收（失败则刻意保留，那才是事后分析想要的现场）。两道闸各自堵一类静默：对象内容是编译旗标
的函数，两条配置不同的构建共用一条路径会互相串；而**即使内容完全相同**，`cc -o` 也是就地截断
再写，两个构建共写一条路径会让**正在链接的一方读到空文件**（实测：示例套件并发六路文本构建，
`ld: file is empty in .../icudtl_flutter.o`，三轮里红两轮）。运行期 `File.applicationDirectory` 与 `extensions/` 按
**exe 所在目录**解析，产物可整体搬走）。

#### 3.5.0 原生扩展从描述符来（不用拼 `--ane`）

描述符里的 `<extensions><extensionID>` 会被读进来，按 ID 从 `<appDir>/ext-aot`、`<appDir>/lib`、
`<appDir>/ext-folder`（或 `--extdir <dir>`，可重复且**顶掉**这三个默认）解析成包路径，写进
`<filename>.build.json` 的 `ane-paths`：

```bash
as-aot --air-app app.xml                        # 扩展包从 <appDir>/ext-aot、lib、ext-folder 找
as-aot --air-app app.xml --extdir vendor/anes   # 换个地方找（写了就不再扫上面三个）
```

四条硬口径（全文见 [`ane.md`](ane.md) §3.6 / §3.7）：

1. **按声明解析，不扫目录**——目录里有什么不算数。实测一个真项目：`lib/` 里 14 个 `.ane`，描述符
   只要 5 个，其余 9 个（Android 专用包、工具包、共享依赖包）不该进来。
2. **多根先命中先赢**——同一个扩展在 `lib/`（打包形态）与 `ext-folder/`（解包树）都有是常态
   （前者是 `adt -package -extdir` 吃的，后者是 `adl -extdir` 吃的）。
3. **重编成 AOT 版的那个放 `<appDir>/ext-aot/`，排在默认根最前**——它与 AIR 原版声明同一个
   `<extensionID>`，所以「用哪个」完全由根顺序决定；这必须是个点名的目录，不能靠同目录里的名字
   排序撞运气（实测：同一个根里 `ANEWinCore-aot` 赢、改叫 `WinCore-aot` 就轮到 AIR 原件赢）。
   `ext-aot` 里没有的 ID 照旧从 `lib/` 来，迁移可以一个扩展一个扩展地推。
4. **声明了却找不到 ⇒ 硬错误**，照 `adl` 的口径列出找过的目录与目录里有什么。**没有逃生口**：
   `adl` 遇到同样情况直接拒绝启动（实测 exit 5），静默少一个扩展比报错更坏。

`--extdir` 单独给（不带 `--air-app`）会被拒绝——它说的是「描述符声明的包在哪」，没有描述符就
无可解。仍然想手写清单或命令行时，`--ane <包>` 照旧可用。

#### 3.5.1 编译面 = 主类的传递闭包（阶段一百二十四）

`--air-app` 编译**哪些** `.as` 由**从主类出发的类引用闭包**决定（`src/reach.ts`），与 `mxmlc`/`adl`
的链接行为一致：AIR 只链从文档类可达的传递闭包——`mxmlc -link-report` 实测 away3d 的六个 demo 各
只链 **158/162/171/171/175/246** 个 def，而 `src/` 有 **485** 个文件、其中 **198** 个不被任何一个
demo 触及。此前 `--air-app` 一律编译整包，是**过度近似**，代价有二：别的 demo 的 `[Embed]` 被打包
且**存活进产物**，以及**不可达**类里的坏 `[Embed]` 让我们编译期失败（`adl` 无恙）。

闭包的边 = 源码里出现的**类名引用**：`new X`、类型标注（含 `Vector.<T>` 的元素类型）、
`extends`/`implements`、`is`/`as` 的目标、`catch (e:T)`、参数/返回类型，以及**裸标识符**
（覆盖 `X.staticM()` 这类静态成员访问）。解析**刻意过度近似**——未解析的短名映射到**全部**同名
候选，因此我们的闭包 **⊇** AIR 的闭包（否则剪枝本身就成了新的保真缺口）。另外这些**总是保留**：
主类、`[WasmExport]` 标记的类（无 AS3 引用的 JS 入口）、以及带**非类顶层语句**（模块语句/自由
函数）的文件——那些代码是整程序发射的，无法按类剪。

**只被 `getDefinitionByName("…")` 字符串引用的类**不会被保留，这与 AIR 一致（`mxmlc` 同样解析不出
字符串）。**类注册表 `as_class_registry[]` 保持 eager**（它同时服务 `is Class`、`new x()`、
`getDefinitionByName` 与 GC 根）——收的是**发射面**，不是运行时表。

**强制文件的引用同样要展开**（阶段二百四十九）：上面「总是保留」的那类文件是**先种进队列、再排空**
——它声明的类与它非类代码命中的类都会**入队并继续展开**。此前这两趟跑在排空循环**之后**，只把类标进
可达集却不展开，于是「唯一入口是自由函数」的类（UI kit 的每个控件都是 `chip.as → ChipNode` 这种工厂
进场的）会被发射、而它的父类与被引用类被裁掉，构建报 `unknown superclass 'Control' of …`。
`--all-sources` 曾把这个缺陷盖成「正常工作」，现已不再需要；回归钉为单元组 `unit: reach/forced`，
复现探针在 `asaotui/probes/reach-freefn/`（闭包 5/5 + 两个面都构建运行 + 两个变异各自证明钉子有牙）。

要切回旧的「整包编译」口径：

```bash
as-aot --air-app app.xml --all-sources     # 编译 src/ 下全部 .as（阶段一百二十四 之前的行为）
```

实测（away3d `Basic_SkyBox`，同一份源码，`--all-sources` vs 默认）：源文件 **485 → 165**、
`[Embed]` **40 → 6**、生成的 `.c` **31,324,486 → 9,105,166 B（−71%）**、二进制
**34,134,472 → 25,456,904 B（−25%）**、整链构建 **37.03 → 15.94 s（−57%）**。
构建日志会报出收面结果：`(main Basic_SkyBox, 165/485 sources reachable from Basic_SkyBox)`；
逐 demo 的嵌资源数与 AIR **逐个相等**（6/2/0/2/1/27）。设计、健全性论证与逐机制来源见
`src/reach.ts` 头注与单元组 `unit: reach/*`。

**web 目标**（`--air-app ... --target wasm --package web`）下，`--air-app` 适配器自动切换到
浏览器后端：构建清单改用 `web_glue.cc`（替换 `window_glue.cc`）+ wasm 版 Skia
（`vendor/skia/lib/wasm`），去掉 SDL2/`objc`/Cocoa 等 macOS 框架，字体由 app.xml 的
`<embedFonts>` 提供（读每个 `<font><fontPath>` 生成 `font-urls` 运行时注入；没写
`<embedFonts>` 时自动扫 app 目录下的 `.ttf/.otf/.ttc`，`findAppFonts()`，无需改描述符）。
其余流程（解析 app.xml、扫描 src、生成引导代码）与 native 一致，产物为 `<filename>.html`
+ `.js` + `.wasm`。

**字体告警（与网络自动挂载同理，因为失败是静默的）**：wasm 沙箱没有可枚举的系统字体，
只认页面注入的字体；一个用了 `flash.text` 却在 app 目录里一个字体都找不到的 app，
`font-urls` 会是空列表，于是 TextField 的**背景照画、字形全无**——编译成功、页面能跑，
只是文字不见（native/adl 用 CoreText 枚举已装字体，不受影响，所以这是 web 独有的坑）。
适配器扫 `src/**/*.as` 里的 `flash.text`（`detectText()`）判定该 app 是否画字，命中且
`font-urls` 为空时打一条黄字警告到 stderr，点明症状与两种修法（自己放一个字体，或写
`<embedFonts>`）。不抛错：其余部分（布局、位图）预览正常，且拦下构建并不会让字体出现。
详见 [`html5-web.md`](html5-web.md) §4 与 §6 第 1 条。

**网络传输自动挂载**：AIR 项目不需要手写 curl 参数。适配器扫 `src/**/*.as` 里的 `URLRequest`
判定该 app 是否联网（`detectNetworking()`，与 `detectStage3D` 同形），命中即把静态
`vendor/curl` 的 `-I/-L` 路径 + `-l curl -l nghttp2` + `Security`/`SystemConfiguration` 写进
native 清单并定义 `ASC_HAVE_CURL=1`；web 目标则定义 `ASC_HAVE_FETCH=1`。这是必需的自动化而非便利：
清单每次构建都会重新生成，手改不可能保留。不碰网络的 app 不受影响（仍为零依赖默认形态）。
（`ASC_HAVE_CURL` 本身仍是 opt-in 宏，设计理由见 §3.4.1。）

对齐 adl 的四个关键行为：
- `<resizable>false</resizable>` → 构建清单加 `ASC_WINDOW_FIXED=1`，窗口创建时不加
  `SDL_WINDOW_RESIZABLE`，得到与 adl 一致的固定尺寸窗口。**只作用于描述符所描述的「第一扇窗」**：
  程序自己 `new NativeWindow(NativeWindowInitOptions)` 建的窗按它自己的 `resizable` 决定，构建级 define
  不外溢（`ASC_WINDOW_NOT_MAXIMIZABLE` / `ASC_WINDOW_NOT_MINIMIZABLE` / `ASC_WINDOW_NOCHROME` 同理）。
- `<maximizable>` / `<minimizable>` / `<systemChrome>` / `<x>` / `<y>` / `<minSize>` / `<maxSize>` →
  同样是**构建 define + 主窗专属**：前三者决定 win32 的 `WS_MAXIMIZEBOX`/`WS_MINIMIZEBOX` 与有无非客户区，
  后四者分别是初始窗的左上角（`xs:int`，可为负）与尺寸上下限（`BoundsSizeType`：空白分隔的两个无符号整数，
  少一个就**报错**而不是取默认）。`WS_MAXIMIZEBOX` 不是摆设：它决定最大化后是铺**可用区**还是盖住任务栏的
  **整块显示器**（见 `win32.md` §5 第 21 条）。
- `<transparent>true</transparent>` → 构建清单加 `ASC_WINDOW_TRANSPARENT=1`，**两半都要动**（阶段二百五十七，宏观路径见阶段二百五十九）：
  ① 胶水把原生窗做成非不透明；② **合成步清成 alpha 0 而不是舞台色**
  （`as_skia_canvas_clear_transparent`），否则那块「没人画」的区域会被清成不透明的一整片。`adl 51.4.1` 实测
  口径：`<transparent>true</transparent>` 的窗口 `nativeWindow.transparent` 为 `true`、`stage.color` **仍报
  `0xFFFFFFFF`**（即 `color` 是舞台属性、与窗口是否透传无关），没画的像素在屏幕上是**真透明**。**只作用于
  描述符那扇主窗**：程序自己 `new NativeWindow(opts)` 建的窗按 `opts.transparent` 决定（走
  `sk_window_set_transparent`），面板类浮层因此也是这条路。
- **macOS 的透明窗不走 SDL 的呈现路径**（阶段二百五十九）。量出来的事实：把 `NSWindow.opaque`、视图与
  layer 的 `-isOpaque` 全部清掉、alpha 0 的像素也确实送达 `present_frame`，屏幕上**仍是不透明黑**；一份
  **14 行、零 as3compiler 符号**的裸 SDL2 程序在 Metal 与 OpenGL 两个渲染器上都能复现 ⇒ 这是后端属性
  （AGENTS.md §1.5 第二类），不是我们的语义错。证据 `temp/transprobe/FINDINGS.md`、`temp/sdltrans.cc`、
  `temp/sdltrans2.cc`。
  因此透明窗改走 CALayer：把内容视图做成 **layer-hosting**（`[contentView setLayer:]`，不是 `wantsLayer`），
  `SDLView` 就不再往自己的 backing store 里铺不透明黑；每帧的像素装成预乘 `CGImage` 交给宿主 layer 的
  `contents`，并把渲染器自己的视图 `setHidden:YES`。实测窗口 alpha 直方图分裂为 0 / 235、圆角外真透明
  （`temp/sdl_layer.cc`）。
  **构建加 `-D ASC_WINDOW_VIBRANT` 则再往前一步**：宿住 layer 下面垫一块 `NSVisualEffectView`
  （material = popover、blending = behindWindow、state = active，圆角 12），未绘制的像素显示的是**毛玻璃
  （糊过的桌面）**而不是原样桌面 —— 这是**刻意的、已登记的后端差异**（AIR 显示原桌面），所以 **opt-in、
  默认关**，浮层面板类产品自己开。实测对照：同一个 50% 蓝矩形，开毛玻璃呈 `(31,29,152)`、不开呈
  `(104,104,228)`（原桌面透出）。证据 `temp/sdl_layer2.cc`、`temp/aottrans/`（`vib_crop.png` / `plain_crop.png`）。
  **平台面**：以上仅 macOS；Windows 与其它后端**没有实现**（要 `WS_EX_LAYERED` + 逐帧 alpha），故
  **响亮报明一次**而不是给一扇不透明的假透明窗；wasm 无桌面合成器，同为空桩。
- `<requestedDisplayResolution>high</requestedDisplayResolution>` → 构建清单加 `ASC_DISPLAY_HIGH=1`，
  窗口开 `SDL_WINDOW_ALLOW_HIGHDPI` 且 surface 按设备倍率创建物理像素（Retina 不模糊）；`standard`
  或缺省保持 1x（与 adl 一致，会被合成器拉伸）。
- `<renderMode>` 控制 GPU/CPU 渲染分工：`direct`/`gpu` → 构建清单加 GPU define，后端把 Skia
  surface 从 `SkSurfaces::Raster` 换成 Ganesh `GrDirectContext`，整帧在 GPU 上合成（效率优先，不对齐
  AIR 官方「direct = CPU 合成 + GPU blit」的分割）。web 目标走 WebGL2，加 `ASC_RENDER_GPU=1`，present
  仅为 `GrDirectContext::flush`；native 目标走 Metal（`GrDirectContext(Metal)` + `SDL_Metal_CreateView`
  /`CAMetalLayer`），加 `ASC_RENDER_METAL=1` 并额外链接 `vendor/metal_glue.mm`（Objective-C++），每帧从
  `CAMetalLayer` 取一次性 drawable、包成 `GrBackendRenderTarget` 渲染、`flushAndSubmit` 后
  `presentDrawable`+`commit`。`cpu`/`auto`（缺省）保持纯软件 raster（web 用 `putImageData`，native 用
  SDL streaming texture）。
  - **`ASC_RENDER_METAL` 对**所有**窗口生效**（阶段八十九·七十五）：主窗口恒走 Metal；运行期
    `new NativeWindow()` 也默认走 Metal——AIR 的 `NativeWindowRenderMode.AUTO` 就是「有 GPU 就用 GPU」。
    后端状态（layer/drawable/surface）**按窗口分槽**，只共享 `MTLDevice`/`MTLCommandQueue`/`GrDirectContext`；
    开 N 个窗口就是 N 次 per-window Metal 初始化（日志 `metal_glue: window <id> layer bounds=…`）。
  - 同一构建内要软件窗口，把 `NativeWindowInitOptions.renderMode = "cpu"` （主窗口无此旋钮，它由 app.xml 定）。
    实测（两个副窗口）：同一份二进制只改这一行，CPU 平均 **32.8% → 14.0%**。
  - **Stage3D/StageVideo 只在 Metal 窗口里合成**：AIR 文档明确软件窗口不支持 StageVideo/Stage3D 合成，
    且 Metal 构建下没有 CPU 回读缓冲（暴露渲染目标纹理正是为了省掉每次回读）——按 AIR 行为处理，非静默降级。
- 引导代码在 `new Main()` **之前**预设 `stage.stageWidth/stageHeight`，使 document class 构造时
  `trace(stage.stageWidth, stage.stageHeight)` 返回窗口尺寸（如 `1000 680`），而非 adl 之外的 `0 0`。

#### 3.5.2 多个源码根：`--as-class-path`（阶段二百五十）

`--air-app` 收集 `.as` 的默认范围是**一个**目录：`<appDir>/src`。被多个 app 共用的类库因此只能**拷进去**
——`asaotui/ui-demo` 的三个 demo 曾各自持有一份**逐字节相同**的 91 文件 UI kit（`src/asaot/`，三份 md5 聚合值
一致），由 `stage-air.cjs` 每次构建前重新复制。在 `src/` 下挂 junction 不是绕法：目录遍历把符号链接当普通条目
跳过（实测，见 `CONTRIBUTING-widget.md` §4）。

`--as-class-path <dir>`（可重复，**只对 `--air-app` 有效**）把额外的源码目录加进**同一份编译面**：`src/`
**加上**每个被点名的根。三份拷贝随之消失：`kit/` 与 `seam/` 只有一份，就地编译。

```bash
as-aot --air-app app.xml --as-class-path ../seam --as-class-path ../kit
```

- 路径**相对当前工作目录**解析，必须是**已存在的目录**；指向 `.as` 文件、目录不存在、或等于 `<appDir>/src`
  都直接报错并点出这个旗标。
- 它与 `--source` 无关：`--source` 加的是 **C/C++** 源文件；`.as` 文件本身仍是位置参数。
- 没有 `--air-app` 时传它会报错——没有闭包可拓宽，多文件直接用位置参数。

**文件身份**（`src/reach.ts` 头注「MULTIPLE SOURCE ROOTS」）——共享根必须让类名与 C 符号**不随构建目录漂移**：

| 规则 | 为什么 |
|---|---|
| 文件属于**最深**的、包含它的根 | 同时声明 `src/` 与 `src/shared` 时，`src/shared/X.as` 按**内层**根命名；用 `relative` 判断而不是字符串前缀，`…/src2/x.as` 不会被误判成 `…/src` 的成员 |
| `fileId` = 相对**它自己那个根**的路径 | `kit/ui/Chip.as` 在任何 app 目录下都得到同一个 id ⇒ 同一个匿名命名空间键、同一个 C 符号 |
| 同一相对路径出现在两个根 ⇒ 加 `_2`/`_3` 后缀 | 两个根各有一个**无包名**的 `Control.as` 时，它们的匿名命名空间才不会撞车 |
| 同一个全限定类出现在**两个根** ⇒ **硬报错**，点名两个文件 | 这是**迁移陷阱**：加了 `--as-class-path ../kit` 却忘了删 `src/asaot` 里的旧拷贝时，walk 顺序会静默决定谁赢（§2.5 禁止）；同一根内的重名仍是既有的 last-wins 行为 |

**迁移配方**：① 把类库移出 app 的 `src/`；② 构建命令加 `--as-class-path <库根>`；③ **删掉 `src/` 里的旧拷贝**
（不删就撞上面那条硬报错）；④ 重跑。

**`[Embed]` 的相对路径**仍按**声明它的文件所在目录**解析（AIR 的实测规则，见 [`embed.md`](embed.md)）；
带前导 `/` 的 `source` 仍相对 `<appDir>/src`——共享根里的类若写 `/` 开头的 `source`，那个 `/` 指的是 app 的
`src/`，不是该共享根。

**它不是 G13 的解药**：闭包不展开「强制文件发现的类」是**另一件事**，已在阶段二百四十九单独修掉。先修闭包再加根，
否则共享根进来的类会走**同一条**不展开的通路。

**验收（实测）**：`asaotui/ui-demo` 三个 demo 的 `src/` 从 **97 个 `.as`**（91 拷贝 + 6 自有）降到 **6 个**，
`kit/`+`seam/` 就地编译；gallery（`--air-app` 默认面）闭包 **94/97**、四页 tour `RESULT: PASS`，登录 demo
`RESULT: PASS`（8 项断言）；`node tools/reach-dump.cjs ui-demo/air-gallery/src demo.GalleryMain seam kit` 复算
`kept 94/97 edges 68`，与编译器自报一致。钉子：`unit: reach/as-class-path`（14 项，身份规则 + 硬报错文案）与
`unit: reach/as-class-path-cli`（8 项，**真编真跑**：无旗标编不过、加旗标编得过且共享根的类出现在 `.c` 里、`.as`
文件当根被拒、无 `--air-app` 时拒绝该旗标、共享根里的 `Chart3DMain.as` 不干扰主类推断、真有两个 `Main.as` 时
点名两份、被 shell 吃掉反斜杠的路径带引号提示）；四个变异各自被咬住。

**根要小，而且要是「包树根」**（阶段二百五十一的两条实测口径）：

- **主类推断看基名，不看后缀**：`src/` 里恰好一个 `Main.as` 时，共享根里再多一个 `Chart3DMain.as`
  （`com/fiCharts/charts/chart3D/Chart3DMain.as` 这类库在真实工程里就有）**不影响**推断；真有两个 `Main.as`
  才报错，并且**两份都点名**。这与 `src/**/Main.as` 唯一即主类的约定是同一件事，别指望它去猜 `Chart3DMain`。
- **别把「源码堆」当根**：旗标点名的根会被**整棵扫**（刻意如此，见上），所以指向一个 2000+ 文件、
  混着 `-examples/`、`com.rar`、`starling`、多份 greensock 副本的老库仓库时，其中**带模块级语句/自由函数**的
  文件会成为「强制保留文件」种子（本机实测命中 `away3d/debug/Debug.as`、`com/ObjectPool/construct.as`、
  `io/asnetty/.../DefaultMessageSizeEstimator.as` 与 `InternalLoggerFactory.as`），闭包随之扩散到无关类——
  其中一个 `io/asnetty/util/TraceLogger.as` 引用 `flash.globalization.DateTimeFormatter`（本后端未实现）⇒
  **硬报 `unknown type`**。正确做法是给它一个**只含所需包树**的小根，把散落的十几个文件归到一个小根下，
  而不是把整个库根塞进来。

### 3.6 构建环境自检（`as-aot doctor`）

编不动的时候，第一件事是问「这台机器到底缺什么」。`doctor` 把散落在构建路径各处的缺失检查
汇总成**一份只读报告**，并且**与构建路径共用同一张检查表**（`src/checks.ts`）——报告说什么，
编译时就报什么，不会出现「doctor 说没事、一编就炸」。

```bash
as-aot doctor                                   # 判断「这个仓库默认形态能不能编」
as-aot doctor --air-app path/to/app.xml         # 判断「这个应用能不能编」（按它真实触碰的功能裁剪）
as-aot doctor --manifest hello.build.json       # 判断「这份构建清单能不能编」
as-aot doctor --json                            # 机器可读输出
as-aot doctor --fix                             # 只做秒级幂等修复（如补齐 icudtl.dat）
as-aot doctor --check-update                    # 只读地问一次 registry 有没有新版本（不安装任何东西）
```

要点：

- **不传配置时合成的是「默认桌面应用」**：与 `--air-app` 走同一个 `airManifest`，所以规则只有一份。
  只有 `--target native` 才合成——`--target wasm --package raw` 是裸 WASI 模块、一个 vendor 库都不链，
  给它报 SDL2/Cocoa 就全是噪声。
- **CLI 覆盖清单**（与编译时同规则）：`doctor --air-app app.xml --target wasm` 判的是 wasm 那份。
- **检查项分三档**：`ok` / `warn`（能编但产物是错的，例如 web 构建里的文本没有字体可画）/
  `fail`（编不过）。`--fix` 只处理秒级幂等项；依赖库本身怎么建，报告里直接给命令。
- **`--air-app` 会写清单**（`<app>/<filename>.build.json`，与编译时同一个文件、同一次生成）——
  `doctor` 读回它再判断，所以「被检查的配置」就是「会被构建的配置」。
- **报告头行带编译器版本**（`as-aot doctor -- <version> darwin/arm64, node v24.14.1`），`--json` 里在
  `compiler: { name, version }`——同一个来源（`package.json`），故不会与 `as-aot --version` 不一致。
- **`--check-update` 是只读的、且默认不做**：它向 `npm_config_registry` 指定的 registry（默认 npmjs，
  故企业镜像会被尊重）查一次 `as3compiler/latest`，只打印升级命令
  （`npm i -g as3compiler@latest`），**从不自己安装**——换掉用户装的编译器是硬不可逆动作，那该是用户
  的，不是工具的。查不到（离线 / 镜像不可达 / HTTP 错误）**如实报明**而不是失败，且**从不影响退出码**
  （0/1/2 只表示「能不能编」，连不上 registry 的机器照样能编）。该检查**只在给了这个 flag 时才发生**，
  所以默认路径一次网络请求都不发。`--json` 下它落在 `update` 键里（不给该 flag 时这个键**不存在**
  = 「没查」，与「查了但连不上」区分）。

## 4. 构建清单（build manifest）

JSON 文件，对标 TypePHP 的 `project.yml`，用于固定可复用、可版本化的构建配置。
选 JSON 而非 YAML 是为保持**零第三方依赖**（Node 原生解析 JSON）。字段名沿用 kebab-case。

| 字段 | 类型 | 说明 |
|---|---|---|
| `target` | `"native" \| "wasm"` | 目标平台，默认 `native` |
| `package` | `"raw" \| "xcode-project" \| "android-project" \| "web"` | 分发形态，默认 `raw`（§6）；`web` 要求 `target=wasm`，产出浏览器产物（见 [`html5-web.md`](html5-web.md)） |
| `architecture` | `"32" \| "64" \| "arm64"` | 目标位宽（Windows 专属，缺省按宿主）。决定依赖目录（`vendor/*/windows-xN`）与目标三元组（`i686-` / `x86_64-` / `aarch64-pc-windows-msvc`）；未知值**响亮报错**而不回退 x86_64。同时决定 `${host}` 展开成哪个依赖目录（§4.1.1）：`"32"` ⇒ `windows-x86`，`"64"`/`arm64` 或未设 ⇒ 按宿主。**`arm64` 只服务非 AIR 的 Windows-on-ARM 产物**：AIR 没有 Windows ARM64 运行时，故 `--air-app` 描述符的 `<architecture>` 仍只接受 `32`/`64`（见 [`win32.md`](win32.md) §1/§2.11） |
| `c-compiler` | string | C 编译器，默认 `cc` |
| `opt` | string | 优化标志，默认 `-O2` |
| `debug-info` | boolean | 是否保留调试信息，默认 `false`。默认产物在三个后端都**不带 DWARF**（wasm 链接因此加 `-Wl,--strip-debug`，见 §4.3）；设 `true` 则三端均加 `-g` 且 wasm 不再剥离（CLI `--debug-info`） |
| `lto` | boolean | 布尔，默认 `false`。为 `true` 时向**每个编译步骤与链接步骤**都加 `-flto`（见 §4.2）；不设时命令行与产物与以前**逐字节相同** |
| `pgo` | `"generate" \| "use"` | 分阶段优化（PGO）的阶段，默认不启用。`generate` 构建**插桩**产物（运行后会写剖析数据），`use` 用同一目录的剖析数据重编（见 §4.2） |
| `pgo-dir` | string | `pgo` 两阶段共用的剖析目录（相对清单目录解析）。clang 从该目录读 `<dir>/default.profdata`，故两阶段**必须同名** |
| `sources` | string[] | 额外 C/C++ 源文件（与生成的 `.c` 一起编译） |
| `swc-paths` | string[] | `.swc` 库（路径相对清单目录解析）。两半都在**编译期**处理：**命名位图资源**被提取（`DefineBitsLossless/2` 反预乘后重编码为 PNG，`DefineBitsJPEG2/3` 原字节直搬）并合成为 `dynamic class X extends BitmapData`（构造器 `(width, height)` 但**实参被忽略**），**矢量 shape 与显示树**（`DefineShape*`/`DefineSprite`/`PlaceObject*`、`clipDepth` 遮罩、`PlaceObject3` 可见性、**九宫格** `DefineScalingGrid`、**按钮四态** `DefineButton2`）烘焙为运行时绘制调用，导出符号合成为 AST 类。于是 `new logo(0, 0)` 与 `getDefinitionByName("logo")` 两条引用路都可用；资源字节内嵌进生成的 `.c`，运行时由 Skia 解码（矢量侧零新增运行时 API）。实现与实测见 [`swc.md`](swc.md) §5/§6/§9；语义/限制见 [`swc.md`](swc.md) §10 |
| `ane-paths` | string[] | AIR 原生扩展 `.ane`（路径相对清单目录解析）。打开后生成程序变成 **FRE 宿主**（`ASC_HAVE_FRE`），并在**编译期**从每个 ANE 的 `extension.xml` 定下平台条目、**后链接阶段**把原生库与宿主库 `asaot` 一起落到 `<exe 同目录>/extensions/<extensionID>/<平台>/`（**一扩展一目录**：多个扩展各带一个同名库时不会合并成一个文件）。**`--air-app` 时一般不用手填**：描述符里的 `<extensions><extensionID>` 会驱动解析——从 `<appDir>/ext-aot`、`<appDir>/lib`、`<appDir>/ext-folder`（或 `--extdir <dir>`）找到包，把**相对清单目录的路径**按描述符顺序写进这个字段（声明了却找不到 ⇒ 硬错误，照 `adl` 的口径，见 `ane.md` §3.6；重编成 AOT 版的扩展放哪个根、以及为什么它必须排在前面，见 §3.7）。**前提**：宿主库得先构建 —— Windows 走 `as3compiler/lib/build-asaot.bat`（默认产出 `lib/bin/windows-x86`/`windows-x64` 两个位宽）、macOS 走 `as3compiler/lib/build-asaot.sh`（产出 `lib/bin/macos-x86-64/libasaot.dylib`，默认通用二进制），且 **ANE 必须是对着宿主库重编过的版本**（其 FRE 导入要解析到 `asaot.dll` / `libasaot.dylib`，而不是硬编码的 `Adobe AIR.dll`）。不设该字段的构建**逐字节不受影响**。完整口径见 [`ane.md`](ane.md)（迁移流程 + 缺口清单）；概览见 [`../README-CN.md`](../README-CN.md) 的「ANE 加载」 |
| `ane-platform` | string | 覆盖 ANE 平台条目名（`Windows-x86-64` / `Windows-x86` / `MacOS-x86-64` / `iPhone-ARM`），默认按构建宿主推导。它同时决定**取哪个位宽的宿主库**（`lib/bin/<小写目录名>/`），未知键**报错**而不猜；指定的条目该 ANE 未声明时同样报错并列出它实际声明的平台。**Windows ARM64 宿主没有键**（AIR 无 Windows ARM 运行时），该值在那种机器上要显式传 `Windows-x86-64` + 64 位构建。**macOS 的键不编码架构**：运行时是 universal 二进制、两个切片里的 ANE 键都是 `MacOS-x86-64`（实测），故 darwin 的 arm64/x64 **返回同一个键**、架构由 ANE 的 `.dylib` 决定；`MacOS-AOT` 不是 AIR 的键。**平台键与 `lib/bin/` 目录是两套词汇**（前者是 `.ane` 内的 ZIP 子目录、后者是宿主库产物），对照表见 [`ane.md`](ane.md) §3.4 |
| `include-paths` | string[] | 头文件搜索路径（→ `-I`） |
| `link-libs` | string[] | 链接库（→ `-l`） |
| `link-paths` | string[] | 库搜索路径（→ `-L`） |
| `defines` | string[] | 预处理宏（→ `-D`） |
| `c-flags` | string[] | **原样透传**给 C/C++ 编译器的旗标（`--cflag <f>` / `-w` 的清单写法）。落在**每一个**编译步骤与链接步骤上（C 源、C++ 胶水层、链接），位置在对象与 `-l` 库**之前**（`-Wl,--as-needed` 这类链接旗标对顺序敏感）。**不做白名单**：编译器不认的旗标必须让构建**响亮的失败**——那正是「旗标真的到了编译器」的唯一证据。默认空 ⇒ 不写就与以前的产物逐字节相同。顶层 append（CLI 与清单可并存）、`targets.<目标>` 块 replace（按 §4.1 的规则） |
| `features` | string[] | **具名增强开关**（§3.4.2），如 `["svg"]`。默认空。未知名字报错；开了会在构建横幅里点名，不开则产物与 `adl` 同构。`--features` 在 CLI 侧是**替换**整个集合（`-D` 才是追加） |
| `gpu-backend` | `"auto" \| "d3d12" \| "gl"` | Windows 的**窗口 GPU 后端**（§3.4.6），缺省不写 = `auto`（D3D12）。由 `--air-app --gpu-backend` 写入，**只允许出现在顶层**（写进 `targets.<目标>` 块报错：后端由描述符与宿主共同决定，不是按目标分层的量）。不写该字段的构建**逐字节不变**。它与 `defines` **交叉校验**：`gl` 必须带 `ASC_RENDER_GL=1`、`d3d12` 必须带 `ASC_RENDER_D3D=1`，两个宏同时出现直接报错 |
| `objects` | string[] | 预编译 `.o` 直接加入链接 |
| `frameworks` | string[] | macOS 框架（→ `-framework X`，Skia 的 CoreText/CoreGraphics 后端需要）。**只在 `darwin` + `target=native` 上发射**：其他宿主静默丢弃（不报错），因此同一份清单可以同时写着 `Cocoa`/`Metal` 与 `gdi32`（后者走 `link-libs` 的 `${win:}`，见 §4.1.1）；以前在 Windows 上它们会被当成**输入文件**丢给链接器，报 `lld-link: could not open 'Cocoa'` |
| `font-urls` | string[] | 字体字节流 URL 列表（`--package web` 时写入 `index.html`，运行时网络加载注入 Skia；见 [`html5-web.md`](html5-web.md) §4） |
| `preload-paths` | string[] | 打进 wasm FS 镜像的数据根，`src@dest` 或裸路径（`--package web` 专属；浏览器沙箱初始 FS 为空，`File`/`FileStream` 会一文件都看不到） |
| `preload-excludes` | string[] | 从上述镜像里**排除**的宿主路径或 fnmatch 模式（→ `emcc --exclude-file`，同样是 `--package web` 专属）。emcc 的目录 preload 没有逐文件开关，只能反向命名要排除的文件；模式匹配的是 preload 遍历产出的**宿主路径**（绝对），故同样相对清单目录解析。**路径里含 `*?[` 时它是模式而非字面量**（`weird[1].png` 会排掉无关的 `weird1.png`），要按字面排除需转义为 `[[]` `[]]` `[*]` `[?]`；无命中的模式静默忽略。`--air-app` 用它把已由页面 `fetch` 的字体撤出 FS（见 [`html5-web.md`](html5-web.md) §6），并自动排除 `-o` 指向的**本次构建输出目录**——否则 `-o temp/<x>` 会把正在写的 `.c`/`.o`/产物自己也 preload 进镜像（Flappy-Starling 实测 1.9 MB → 36 MB）；未指定 `-o` 时不做任何猜测 |
| `bundle-id` | string | 应用标识（`--package xcode-project` 填 `Info.plist` 的 `CFBundleIdentifier`，缺省 `com.example.<product>`） |
| `display-name` | string | 应用显示名（填 `CFBundleName`，缺省取产物名） |
| `icon` | string | 图标 `.icns` 路径（相对清单目录解析，拷入 `Resources` + 填 `CFBundleIconFile`） |
| `deployment-target` | string | macOS 最低系统版本（填 `MACOSX_DEPLOYMENT_TARGET`，默认 `12.0`） |
| `targets` | `{ native?, wasm? }` | **按目标覆盖块**（§4.1）：顶层字段为公共默认，`targets.<目标>` 块对**匹配的目标**整体替换其声明的字段，使一份清单可服务链接集互斥的多目标 |

路径类字段（`sources` / `swc-paths` / `include-paths` / `link-paths` / `objects` / `preload-excludes`）**相对清单文件所在目录解析**
（与 TypePHP 的 YAML 路径规则一致）。示例见
[`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json)：

```json
{
  "target": "native",
  "c-compiler": "clang",
  "opt": "-O2",
  "architecture": "64",
  "sources": ["../vendor/skia_glue.cc"],
  "include-paths": ["../vendor/skia", "${win:../vendor/curl/include}"],
  "link-libs": ["skia", "skparagraph", "skshaper", "skunicode", "skottie",
    "sksg", "svg", "skresources", "bentleyottmann", "skcms", "wuffs",
    "${lib:png}", "${lib:jpeg}", "${lib:webp}", "${lib:webp_sse41}",
    "dng_sdk", "piex", "expat", "freetype2", "harfbuzz", "icu", "zlib", "z",
    "${win:usp10}", "${win:user32}", "${win:gdi32}", "${win:ole32}", "${win:advapi32}"],
  "link-paths": ["../vendor/skia/lib/${host}", "${win:../vendor/curl/lib/${host}}"],
  "frameworks": ["CoreFoundation", "CoreGraphics", "CoreText", "CoreServices",
    "ApplicationServices", "ImageIO", "Accelerate"],
  "defines": ["ASC_USE_SKIA=1"],
  "objects": []
}
```

（这就是 [`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json) 的当前内容：一份清单同时描述 macOS 与 Windows，`${...}` 的含义见 §4.1.1。）

**优先级**：CLI 参数覆盖清单同名字段（对标 TypePHP 的「CLI beats YAML」）。
合并顺序：默认配置 → 清单顶层 → 清单 `targets.<最终目标>`（§4.1）→ CLI 覆盖。

> **`sources` 里没写也可能被加进来**：`skia_glue.cc` 是**图形半边**，`vendor/skia_text_glue.cc` 是
> **文本半边**。清单只写前者时，构建层会按「程序是否用到 `flash.text`」**自动补上后者**并同时加
> `ASC_HAVE_TEXT`（阶段二百二十一，见 [`rust-text-backend.md`](rust-text-backend.md) §2）——
> 用不到文本的程序因此**根本不链** SkParagraph/HarfBuzz/ICU（实测 19.43 MB → 6.53 MB）。
> 反过来，清单**显式**写了 `skia_text_glue.cc` 就一律链（此时清单说了算）。构建时会打印判定：
> `+ flash.text: text engine linked (...)` 或 `- flash.text: no text in this program -- ...`。

### 4.1 按目标分层（`targets`）

顶层字段是**公共默认**；`targets.<目标>` 块只对**匹配的目标**生效，并把块内声明的字段**整体替换**（replace，而非追加）同名顶层值。这样**一份清单**就能服务链接集互斥的多目标——典型场景是 `flash.net` 的 HTTP 后端：native 链接 curl，而 WASI preview1 没有 socket/TLS，`-lcurl` 会让 `wasm-ld` 直接失败（`unable to find library -lcurl`），必须为 wasm 去掉它。

示例 [`examples/flash-net-layered.build.example.json`](../../examples/flash-net-layered.build.example.json)
（当前形态：native 指静态 `vendor/curl`，wasm 无块故不加任何 curl 相关字段）：

```json
{
  "target": "native",
  "opt": "-O2",
  "targets": {
    "native": {
      "link-libs": ["curl", "nghttp2", "z",
        "${win:crypt32}", "${win:ws2_32}", "${win:secur32}", "${win:bcrypt}", "${win:iphlpapi}"],
      "link-paths": ["../vendor/curl/lib/${host}"],
      "include-paths": ["../vendor/curl/include"],
      "frameworks": ["CoreFoundation", "CoreServices", "Security", "SystemConfiguration"],
      "defines": ["ASC_HAVE_CURL"]
    }
  }
}
```

- `as-aot app.as --manifest m.json`（默认 native）→ 链接 `-l curl -l nghttp2 -l z -D ASC_HAVE_CURL` + 四个 `-framework`；
- `as-aot app.as --manifest m.json --target wasm`（wasm）→ **两者都不加**（无 `native` 块匹配）。
- 同一份 `native` 块在 Windows 上自动换成 `windows-x64` 目录 + 五个系统导入库（TLS 需要），八个 `-framework` 一个都不发（§4.1.1）。

规则：

- 块内**省略**的字段沿用顶层默认；要**去掉**一个顶层共享库，就在该目标块里写 `"link-libs": []`——**replace 语义才能「减」**（append 只能「加」，无法剔除）。
- 块可选择的目标只有 `native` / `wasm`，**未知目标名报错**；块内**不允许** `target`/`package`（目标由选择它的块决定，不可在块内重定义）或嵌套 `targets`；块内**未知字段报错**（AGENTS.md §2.5，防拼写错误被静默忽略）。
- 块内路径类字段（`sources`/`include-paths`/`link-paths`/`objects`/`icon`）与顶层一样**相对清单目录解析**。
- 覆盖块由**最终目标**（含 CLI `--target` 的影响）选择，且**先于** CLI 覆盖应用，故 CLI 的 `-l/-I/-L/-D` 仍叠加在分层结果之上——「CLI beats 清单」不变。

### 4.1.1 宿主占位符（一份清单同时描述 macOS 与 Windows）

`targets` 只能按**目标**（`native`/`wasm`）分层，而 macOS 与 Windows 是**同一个目标、不同的依赖目录与系统库**。若靠两个文件解决，示例清单（同时也是文档里的标准例子）就会一半在另一半宿主上编译失败——事实上在引入这一节之前，`examples/` 下的 21 份手写清单都写着 `lib/macos-arm64`、`CoreText`、`png`（macOS 的归档名没有 `lib` 前缀），在 Windows 上**全部**死在 `#include <zlib.h>` 或 `could not open 'Cocoa'`。

因此列表字段里的字符串支持四个占位符（**只在构建清单里**，CLI 的 `-I/-L/-l` 不收）：

| 占位符 | 展开为 | 说明 |
|---|---|---|
| `${host}` | `windows-x64` / `windows-x86` / `macos-arm64` / `wasm` | 依赖目录名（`vendor/*/lib/<host>`）。由**最终目标 + `architecture` + 宿主**算出；算不出（如 Linux 宿主没有预编译树）时**硬报错**而不是给一个空路径 |
| `${lib:NAME}` | `NAME` / `libNAME` | 同一个库在两边归档文件名不同：Windows 的 Skia 归档带 `lib` 前缀（`libpng.lib`），macOS 是 `libpng.a` ⇒ `-lpng` 找得到，Windows 的 `-lpng` 则找不到 `png.lib`。只该用于**文件名有此差异**的库 |
| `${win:TOKEN}` | `TOKEN`（Windows）/ 整条**丢弃**（其他宿主） | 只属于一个宿主的条目：Windows 系统导入库（`gdi32`/`usp10`/`winmm`…）、`../vendor/curl/lib/${host}` 这类只有 Windows 才需要的路径 |
| `${mac:TOKEN}` | `TOKEN`（macOS）/ 整条**丢弃**（其他宿主） | 同上，如 `objc`（`window_glue.cc` 的 NSWindow 边框垫片需要；Windows 上没有这个库） |

规则：

- `${win:}` / `${mac:}` **必须是整条**（`"${win:gdi32}"`），不能拼在字符串中间——拼进去意味着这条东西在另一个宿主上变成半截字符串，而半截路径不会报错、只会链错。
- `${lib:}` 后面为空、占位符未闭合、写了 `${host:xxx}` 这类不认识的形态，都以**带上清单文件名**的错误报出（AGENTS.md §2.5：宁可 `throw`，也不产出「编过但结果错」的 C/链接命令行）。
- 展开发生在**解析时**，且 `architecture` 的合法性校验提前到展开之前（否则 `${host}` 会按一个非法位宽去查目录）；`targets.<目标>` 块与顶层字段走**同一套**展开。
- `frameworks` **没有**占位符：它由发射端按宿主门控（非 darwin 一律不发），所以一份清单可以同时列着 `Cocoa`/`Metal` 与 `${win:gdi32}`，两边各取所需。

示例清单 [`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json) 与 [`examples/window_click.build.example.json`](../../examples/window_click.build.example.json) 就是这种形态；`node test.ts` 的 `build/HostTemplates` 把每个占位符、每条拒绝路径都钉了一遍，`build/ExampleManifestHosts` 则把**每一份**示例清单在当前宿主上展开，并断言每个路径真的存在、每个 `-lNAME` 真能在它的 `-L` 目录里找到归档（少了这条钉子，清单只在「CI 的宿主」上被验证过）。

> **不是每个宿主都有预编译树**：Linux 宿主上 `${host}` 直接报错，这是刻意的——`vendor/` 只有 macos-arm64 / windows-x64 / windows-x86 / wasm 四套，静默退回 `windows-x64` 会去链一套 COFF 归档并报一堆无关的符号错误。

### 4.2 链接时优化与分阶段优化（`lto` / `pgo`）

这两项是**构建层开关，不是语言特性**：前端仍然只把 AS 翻译成可读的 C，一行优化都不手写（§1.1）；
`-flto` 与剖析数据都由系统的 `cc/clang -O2 -flto` 消费。故它们与 `opt` 同层，两处都可
由构建清单或 CLI（`--lto` / `--pgo` / `--pgo-dir`）指定，**默认全关**——不设时产物与以前完全一致。

```bash
# 只开 LTO（一条命令）
as-aot Main.as --air-app app.xml --lto

# PGO：先插桩 → 运行以采集 → 合并剖析 → 用剖析重编
as-aot bench.as --pgo generate --pgo-dir prof -o bench.gen
./bench.gen                                    # 运行写入 prof/default_*.profraw
llvm-profdata merge -o prof/default.profdata prof/*.profraw
as-aot bench.as --lto --pgo use --pgo-dir prof -o bench
```

清单写法等价：

```json
{ "opt": "-O2", "lto": true, "pgo": "use", "pgo-dir": "prof" }
```

要点：

- **`-flto` 必须同时在编译步与链接步上**：编译步产出 bitcode，跨模块内联发生在链接步。只加一侧
  不会报错，只会**静默地不生效**——所以 `perfFlags()` 是单一来源，四个命令构造器都从它取，
  回归里有逐步骤断言 + 反向对照（把任一步漏掉，测试立刻失败）。
- **两阶段必须同名 `pgo-dir`**：clang 的目录形式读 `<dir>/default.profdata`。剖析文件不存在时
  构建**硬报错**（`Error in reading profile ...: No such file or directory`），不会静默退回无剖析构建。
- **不发 `-fprofile-correction`**：那是 GCC 的标志；clang 收到只会警告
  `not supported [-Wignored-optimization-argument]` 然后忽略，发了等于每次 PGO 构建都多一条噪声。
- **两端都有效**：native（`cc`/`clang`）与 web（`emcc`）都接受 `-flto`，回归对两侧的**每一步**都有断言。
  `--target wasm`（WASI 裸产物）路径同样把标志送进命令，但**本机未安装 WASI SDK，未实测**。

实测（`temp/perf/`，调用密集的 900k 次循环，五次取中位）：

| 构建 | 校验和 | 墙钟 | 产物 |
|---|---|---|---|
| `-O2`（默认） | −1664902176 | ~30.6 ms | 33464 B |
| `-O2 -flto` | −1664902176 | ~25.6 ms | 33456 B |
| `-O2 -flto -fprofile-use` | −1664902176 | ~25.5 ms | 33464 B |

三者校验和**完全相同**（只提速、不改语义），`-flto` 在这一单编译单元的调用密集负载上约快 16%；
再叠 PGO 在本例无可测增益（已在噪声内）——本负载分支简单，PGO 的收益面是**分支多 / 间接调用多**的程序，
不宜把它当普适提升。

### 4.3 调试信息（`debug-info`）

同样是与 `opt`/`lto`/`pgo` 正交的**构建层开关**，但方向相反：它管的是**产物要不要带调试段**。
默认 `false`，含义是「三个后端都不带 DWARF」，与 C 工具链的惯例一致：

| 后端 | 默认是否带 DWARF | 为什么 |
|---|---|---|
| native（`cc -O2`） | 否 | clang 不加 `-g` 就不发 `.debug_*`（可执行文件只有一个常规符号表） |
| web（`emcc -O2`） | 否 | emcc 在 `-O2` 下自行剥离（实测 trivial 程序 2010 B、0 个 custom section；加 `-g` 才 28243 B） |
| wasm（WASI raw） | **是，故默认显式剥离** | wasi-sdk 的 `libc.a` **自带 DWARF** 且 `wasm-ld` 默认保留——一个 trivial `printf` 就拖进 ~62 KB 调试段 |

所以 `debugInfo=false` 时，**只有 wasm 链接**需要一枚反向的 `-Wl,--strip-debug`（native/web 无需任何补偿标志）。
用 `--strip-debug` 而非 `--strip-all` 是有意的：它只删 `.debug_*`，保留 `name` 段（函数名）⇒ 即使不带调试信息，
trap 仍打印**符号化的栈**，只丢源码行号/变量级信息。

```bash
# 默认：wasm 产物 133 KB（fib.wasm，剥离 288 KB 调试段）
as-aot examples/wasm-native/fib.as --target wasm

# 保留调试信息：三端均加 -g，wasm 不再剥离（fib.wasm ~640 KB）
as-aot examples/wasm-native/fib.as --target wasm --debug-info
```

`debugInfo=true` 时 `-g` 会加在**每一个编译步**上（不只是链接），所以 DWARF 覆盖我们生成的 `.c` 本身——
浏览器 DevTools 可对 AS3 降级出的 C 做源码级单步（`llvm-dwarfdump --debug-line` 会看到我们生成的 `.c` 文件名）。
清单写法：`{ "debug-info": true }`，可被 `targets.<目标>` 分层覆盖（§4.1）。

> 不发 `-g` 的 native/web 默认行为**完全未变**；回归里对三个后端的**默认命令**各自有断言
> （`[debuginfo]`），反向对照证明它们真的钉住了这条策略。

### 4.4 未知字段 = 硬报错（阶段二百五十二）

清单的**顶层键**必须拼对：`loadManifest` 读入后逐个核对，不认识的名字**直接报错**并点名文件，
不再「读到了、但没人管」。`targets.<目标>` 块从阶段八十九·五十 起就在执行这条规则（`TARGET_LAYER_FIELDS`，§4.1），
本轮只是把**顶层**补齐——此前它恰恰是最松的一层。

```text
$ as-aot examples/hello.as --manifest bad.json
build manifest: unknown field 'link-lib' (did you mean 'link-libs'?)
  (known: target, package, c-compiler, …, architecture, targets) — bad.json
```

值得为它单列一节的理由：**拼错一个键不会让构建失败，只会让构建悄悄少做一件事**。

| 写错的键 | 以前的结果 |
|---|---|
| `"link-lib": ["skia"]`（少个 `s`） | 库没进链接 → 之后才报 `undefined symbol`，错误信息与「你拼错了」毫无关系 |
| `"define": ["ASC_USE_SKIA=1"]` | 宏没进来 → C 照常编过、常量与分支是错的（AGENTS.md §2.5 明令禁止的「编译过但结果错」） |
| `"preload-path"` / `"font-url"` | 资源/字体没打进产物 → 运行期才找不到 |
| `"as-class-path"` | 它就是不会被读，且没有任何反馈（它属于 AS 侧编译面，见 §3.5.2） |

报错按三种情况给附注，优先级从高到低：

1. **近似名**：`link-lib` → `did you mean 'link-libs'?`。距离阈值按名字长度**相对**计算，且「以它开头的唯一候选」
   也算——只差一个字符或以它开头才猜，宁可不猜也不乱猜；
2. **命令行选项**：`as-class-path` / `main-class` / `all-sources` / `include-third-party` 这类**没有清单写法**的旗标，
   会被告知「这是命令行选项，请在命令行上给」；
3. 其余只点名键本身，消息末尾附上**全部合法键**，省一次翻文档。

两处刻意留开的缝：`$` 前缀的键（`$schema` 之类元数据）直接放行；`targets.<目标>` 内部仍按 §4.1 的
`TARGET_LAYER_FIELDS` 校验（那里更窄，连 `target`/`package` 都不许写）。

> 这条只保证**键名认识**，不保证「这个键在当前形态下有用」：`font-urls` 在 `target=native` 里本就无效，
> 不会被拒。仓库内 31 份自带清单（手写示例与 `--air-app` 快照）全部通过，钉子见 `unit: build/ManifestUnknownKeys`。

## 5. 多目标后端

| 目标 | 编译命令 | 产物 |
|---|---|---|
| `native`（默认，`--package raw`） | `cc -O2 -lm -lz -o <out> <c> [sources] -I... -D... [objects] -L... -l... [-framework X]` | Mach-O / ELF / PE 可执行 |
| `wasm`（`--package raw`） | `clang --target=wasm32-wasip1 [--sysroot=...] -mllvm -wasm-enable-sjlj -O2 [-g] -mllvm -wasm-use-legacy-eh=false [-Wl,--strip-debug] -o <out>.wasm <c> ... -lsetjmp` | WASI `.wasm`（默认剥调试段；`--debug-info` 则去掉 `-Wl,--strip-debug` 并加 `-g`，见 §4.3） |
| `native` + `--package xcode-project` | 生成 `.xcodeproj`（§6.5），由 Xcode/xcodebuild 驱动 | macOS `.app` bundle（`Contents/MacOS/<bin>` + `Info.plist`） |
| `wasm` + `--package web` | `emcc`（Emscripten，需 `EMSDK_HOME`）编译 C/C++ 源 + 链接 wasm 版 Skia，`INVOKE_RUN=0` | `.wasm` + `.js` + `index.html`（浏览器 HTML5 渲染，见 [`html5-web.md`](html5-web.md)） |

> 需要按目标区分链接库/宏（如 native 链接 curl、wasm 不能）时，用清单的 `targets` 块
> （§4.1）——一份清单即可覆盖上表多个后端，不必为每个目标维护一份清单。

平台耦合点已隔离到 `runtime.ts` 的 `RUNTIME_PREAMBLE`，用 `#ifdef __wasi__` 条件编译。
当前唯一的平台差异是 `as_now_ms()`：

- native：`gettimeofday`，毫秒精度
- WASI：`time(NULL)`，退化为秒级精度（wasi-libc 折叠了 libm，也无需单独 `-lm`）

> 本机若为 Apple clang（无 `wasm32-wasip1` target）且未装 WASI SDK，则 wasm 只能 `--dry`
> 验证命令，实际编译需先装工具链（见 §2）。

## 6. 编译后端与分发形态

> 本节回答一个问题：`--target native` 已经能产出裸可执行文件，那 `.app` / `.dmg` /
> Windows `.exe` / Xcode 工程 / Android 工程该怎么做——是继续平铺成 `--target` 的一堆取值，
> 还是拆开？结论：**拆成两个正交维度**。其中 `xcode-project` 已实现（§6.5），其余为规划。

现有管线的心智模型是「一份 AS → 一份可读 C → 一个裸可执行文件」。这些产物里，一半是
「换编译后端」，另一半是「编译完之后怎么组织」，两者不应混在同一个 `--target` 里。

### 6.1 两个正交维度

| 维度 | 参数 | 管什么 | 底层动作 |
|---|---|---|---|
| 编译后端 | `--target` | 机器码 ABI：用哪个 clang triple、链接哪个 sysroot/SDK | 改变 `cc/clang` 的编译命令 |
| 分发形态 | `--package` | 编译结果之后如何组织（bundle、镜像、工程文件） | build 层的**后处理步骤** |

**维度 A：`--target`（编译后端）**，保留现有语义，只扩取值：

| 取值 | 含义 | 底层 |
|---|---|---|
| `native`（默认） | 宿主系统可执行 | 现有 `cc -O2 -lm -lz` |
| `wasm` | WASI `.wasm` | 现有 |
| `ios`（规划） | iOS / 模拟器 | `clang --target=arm64-apple-ios / arm64-apple-ios-simulator` + iPhone SDK |
| `android`（规划） | Android | NDK clang `--target=aarch64-linux-android` + NDK sysroot |

**维度 B：`--package`（分发形态）**：

| 取值 | 产物 | 说明 | 状态 |
|---|---|---|---|
| `raw`（默认） | 裸可执行 / 裸 `.wasm` | 保持现状，零行为变化（CLI 快速验证、本地调试用） | 已实现 |
| `xcode-project` | `.xcodeproj`（或 CMake 工程） | 生成 macOS application 工程骨架 + 构建脚本，交给 Xcode 构建/调试/签名 | **已实现（macOS application，§6.5）** |
| `android-project` | Gradle + NDK 工程 | 生成 `build.gradle` + `CMakeLists.txt` + JNI/native-activity 桥 | 规划 |
| `web` | `.wasm` + `.js` + `index.html` | 用 emcc 产出浏览器 HTML5 渲染页面（`target=wasm`，见 §6.6 与 [`html5-web.md`](html5-web.md)） | **已实现（§6.6）** |

**目标用户定位：`xcode-project` / `android-project` 只服务 IDE 开发者**，因此这两个形态
**不提供 `app` / `dmg`**；`web` 与 `raw` 一样是「一次编译调用 + 后处理」（emcc 编译 + 生成
`index.html`），面向直接产出浏览器可加载的最终产物。

- `app` / `dmg` 走的是「`build.ts` 直接调 `cc/clang` + `codesign` + `hdiutil` 一键产出最终产物」的
  **脚本路线**，面向 CI / 快速出包 / 无人工介入；`xcode-project` 走的是「生成工程，让 Xcode 驱动」
  的 **IDE 路线**，面向长期开发、断点调试、签名上架。两者是**并列的两条路**，最终都通向 `.app`，
  但不是「高级形态取代低级形态」的包含关系。
- 既然只服务 IDE 开发者，脚本路线（`app` / `dmg`）整体砍掉，分发形态收敛为 `raw` + 两个工程生成器 + `web`。

**`xcode-project` 当前产出 macOS application**：`--package xcode-project` 现阶段只支持
`--target native`（macOS application）；iOS/Android 的工程生成器尚未实现。将来升到 multiplatform 时，
平台范围交给 manifest 的 `deployment-targets`、由 Xcode 的 destination 选择，`--target` 不再为工程定死
平台——但目前仍停在 macOS-only（SDL2/Skia 静态库仅有 macOS arm64 构建）。

### 6.2 为什么这么分

1. **`xcode-project` / `android-project` 不是「一次 cc 调用」，而是「生成工程文件」**。编译后端仍
   产出 Mach-O / ELF，工程生成器负责把编译命令 + 依赖库 + 资源组织成 `.xcodeproj` / Gradle 工程
   骨架。因此它们应作为 build 层**独立于编译命令的生成步骤**，而不是塞进 `cc/clang` 的编译参数。
2. **Windows `.exe` 连新参数都不需要**。native 在 Windows 本来就是 PE 可执行文件，唯一的小坑是
   曾经 `-o app` 不自动补 `.exe` 扩展名——已按 host OS 补默认扩展名（`process.platform === 'win32'` 时
   native 产物自动带 `.exe` 后缀、POSIX 不补）。这不只是命名规范：Windows 的 `CreateProcessW` 只按
   `.exe`/`.cmd`/`.bat`/`.com` 扩展名序列查找可执行文件，无扩展名的 PE 文件对 `spawnSync` 而言是
   `ENOENT`，所以 `--run` 在 macOS 能启动、在 Windows 却静默起不来——补 `.exe` 后两者一致。不是新形态。
3. **工程元数据走 manifest，不平铺 CLI flag**。工程生成器需要大量元数据：bundle id、图标、
   签名证书、min SDK、权限、资源目录……这些**不是参数，是工程配置**。项目里已有对标 TypePHP
   `project.yml` 的 manifest 机制（见 §4），应扩展 manifest 承载这些字段，而非平铺成一堆 CLI flag。

### 6.3 推荐的 CLI 形态

```bash
# 现有行为不变
as-aot examples/hello.as --run

# macOS 工程（编译后端 native + 生成 .xcodeproj，已实现）
as-aot src/Main.as --target native --package xcode-project --manifest macos.json

# iOS 工程（换后端 + 生成工程，复杂元数据走 manifest；规划中）
as-aot src/Main.as --target ios     --package xcode-project --manifest ios.json

# Android 工程（规划中）
as-aot src/Main.as --target android --package android-project --manifest android.json
```

### 6.4 manifest 扩展字段（部分已实现）

复杂工程元数据在 `§4` 构建清单上追加（kebab-case，路径类字段相对清单目录解析）。macOS application
（`xcode-project`）相关的四个字段已实现并用于 §6.5：

| 字段 | 说明 | 状态 |
|---|---|---|
| `bundle-id` | 应用标识（填 `CFBundleIdentifier`，缺省 `com.example.<product>`） | ✅ 已实现 |
| `display-name` | 应用显示名（填 `CFBundleName`，缺省取产物名） | ✅ 已实现 |
| `icon` | 图标 `.icns` 路径（拷入 `Resources` + 填 `CFBundleIconFile`） | ✅ 已实现 |
| `deployment-target` | macOS 最低系统版本（填 `MACOSX_DEPLOYMENT_TARGET`，默认 `12.0`） | ✅ 已实现 |
| `permissions` | Android `AndroidManifest.xml` 权限 / iOS `Info.plist` 用途描述 | 规划 |
| `resources` | 需拷贝进 bundle / 工程资源目录的额外文件 | 规划 |
| `ndk-abi` | Android 目标 ABI 列表（如 `arm64-v8a`） | 规划 |
| `signing-identity` | 代码签名证书（macOS/iOS 的 `codesign`，当前用 ad-hoc `-`） | 规划 |

落地顺序：`xcode-project`（macOS application）已完成 → 下一步 `android-project`（工程生成器最重）→
再补 multiplatform destination 与正式签名。

### 6.5 `xcode-project`（已实现，macOS application）

`--target native --package xcode-project` 把生成的**可读 C** + 构建清单里的额外源、头文件路径、
链接库、framework、宏定义组织成一个 macOS **application** `.xcodeproj`（产物是 `.app` bundle），交给
IDE 开发者打开、构建、断点调试——是「生成工程」步骤，而非一次 `cc` 调用：

```bash
as-aot src/Main.as --target native --package xcode-project -o build/Main
# 生成 build/Main.xcodeproj + build/Main/Info.plist + 共享 scheme

open build/Main.xcodeproj                          # 打开工程
# 或命令行构建（无需打开 Xcode）
xcodebuild -project build/Main.xcodeproj -scheme Main -configuration Debug build
# 产物是 build/…/Debug/Main.app（Contents/MacOS/Main + Contents/Info.plist + 资源）
open build/…/Debug/Main.app                        # 双击/命令行启动正式 App
```

从「命令行工具」到「application」的升级，让产物从「裸 Mach-O」变成有 bundle 身份、Dock 图标、菜单栏、
可签名上架的正式 macOS App。生成的 AS3 C 仍是 `int main(void)`——SDL2 事件循环（`ASC_USE_WINDOW=1`）
从 `main` 里跑，bundle + `Info.plist` 只给进程加上 App 身份，运行行为与 raw 一致。

实现要点（`src/xcode-project.ts`）：

- **目标类型**：`com.apple.product-type.application`（`wrapper.application`），`buildPhases` 含
  Sources + Frameworks + **Resources** 三段；产物 `Contents/MacOS/<bin>` + `Contents/Info.plist`。
- **`Info.plist` 生成**：写 `<outDir>/<product>/Info.plist`，`CFBundleIdentifier`/`CFBundleExecutable`/
  `LSMinimumSystemVersion` 用 `$(PRODUCT_BUNDLE_IDENTIFIER)`/`$(EXECUTABLE_NAME)`/
  `$(MACOSX_DEPLOYMENT_TARGET)` 注入，与构建设置保持同步；`CFBundleName` 填 `display-name`（缺省产物名），
  `CFBundleIconFile` 只在 manifest 提供 `icon` 时写出。
- **应用元数据从 manifest 读**（§6.4）：`bundle-id`/`display-name`/`icon`/`deployment-target` 四个字段
  分别落入 `PRODUCT_BUNDLE_IDENTIFIER`/`CFBundleName`/Resources phase + `CFBundleIconFile`/
  `MACOSX_DEPLOYMENT_TARGET`；`icon` 为绝对路径 file ref 加入 Resources phase，构建时拷入
  `Contents/Resources/`。
- **ad-hoc 签名**：`CODE_SIGN_STYLE = Manual` + `CODE_SIGN_IDENTITY = "-"`，让 `xcodebuild` 无需
  provisioning profile 或 Apple ID 即可产出可运行的 `.app`（ad-hoc 签名）；正式上架再在 manifest 加
  `signing-identity`（§6.4 规划）。
- **编译配置镜像 raw 链接**：`OTHER_LDFLAGS` 恒含 `-lm -lz` + 平台自带库（macOS 上即
  `platformLinkLibs()` 的 `-liconv`；少了它，任何字符集路径过了 `-O2` 仍存活的 app 都会
  `Undefined symbol: _iconv`），再拼 manifest 的 `link-libs`/`objects`/`frameworks` 与
  `platformFrameworks`；编译侧 flags（`perfFlags`/`fpFlags`/`debugInfoFlags`）**同时**落在
  `OTHER_CFLAGS` 与 `OTHER_LDFLAGS` 上，与 raw 的「一条命令既编译又链接」对齐。其中
  `-ffp-contract=off` 是**语义**旗标而非性能旋钮：AS3 每个运算只一次 IEEE 舍入，clang 默认的
  contraction 会改变可观测结果（AIR 的 `SoundTransform.pan` 算 `1 - ltl*ltl` 给
  `0.2604000000000001`，contraction 后成 `0.2604`）。`HEADER_SEARCH_PATHS`/`LIBRARY_SEARCH_PATHS`
  镜像 `include-paths`/`link-paths`；`GCC_PREPROCESSOR_DEFINITIONS` 镜像 `effectiveDefines`（含
  `--features` 的宏，如 `svg`→`ASC_USE_SVG=1`，不再静默丢失）；`GCC_OPTIMIZATION_LEVEL` 从 `--opt`
  的 `-O{0,1,2,3,s}` 映射。路径类字段按绝对路径写入，保证 Xcode 从任意工作目录都能解析。
- **关闭 `-fmodules`（关键）**：生成的 C 使用裸类型名（`Point`/`Rectangle`…），会与 macOS SDK 的
  `MacTypes.h` 里的 `Point` 冲突。raw `cc` 默认不启用 `-fmodules` 所以没事；Xcode 默认启用，会让 SDK
  的 `Point` 遮蔽生成的 struct，导致 `no member named 'x' in 'struct Point'`。因此工程里显式
  `CLANG_ENABLE_MODULES = NO`，保证与命令行构建语义一致。
- **C/C++ 分层**：生成 `.c` 保持 C99（`GCC_C_LANGUAGE_STANDARD = c99`），C++ 胶水层（`skia_glue.cc` 等）
  用 C++17（`CLANG_CXX_LANGUAGE_STANDARD = "c++17"` + `CLANG_CXX_LIBRARY = "libc++"`），由文件扩展名
  自动分派编译器。
- **共享 scheme**：生成 `xcshareddata/xcschemes/<NAME>.xcscheme`（`BuildableName = <NAME>.app`），使
  `xcodebuild -scheme NAME` 无需打开 Xcode 即可解析。

#### 6.5.1 智能合并（保护 Xcode 手改）

工程生成器默认**不覆盖**已存在的 `.xcodeproj`。IDE 开发者会在 Xcode 里手改 build settings、scheme、
添加文件/资源；重新编译代码时若整个工程被重建，这些手改就会丢失。因此采用**对象级智能合并**：

- **第一次运行**（工程不存在）：完整生成 `.xcodeproj` + `Info.plist` + 共享 scheme，并把「我们管理的
  源文件集合」（生成的 `.c` + manifest 的 `sources`）记录进工程内的 `.as3aot-managed.json` sidecar。
- **后续运行**（工程已存在）：解析现有 `project.pbxproj`（`src/pbxproj.ts`），**只增删我们管理的源文件**
  （对比 sidecar 里的旧集合与本次新集合），其余对象——用户手改的 build settings、scheme、自己加的
  文件/资源——原样保留。
  - 源文件列表未变 → 完全不写文件，打印 `unchanged; hand edits preserved`。
  - 源文件列表变了（新增/删除了 `.c` 或 manifest `sources`）→ 就地更新，打印
    `source list updated; hand edits preserved`。
- **识别依据是绝对路径**：只有 `sourceTree = "<absolute>"` 的 file ref 才会被管理；用户手加的
  相对路径文件不受影响。Xcode 的 `/* 注释 */` 会被解析器丢弃（纯可读性提示，不参与语义），下次
  Xcode 保存时自动重新生成。
- 工程里额外生成 `.as3aot-managed.json`（记录受管源文件集合），Xcode 忽略该文件，不会影响构建。它是**生成产物**
  （每次创建/合并都会写出），**不进仓库**；当它不存在时（刚 clone、或工程是手建的），合并只**新增**受管源文件，
  **绝不删除任何**现有源文件。

若用户确需整体重建工程，删除 `.xcodeproj` 后重跑即可。

### 6.6 `web`（已实现，浏览器 HTML5 渲染）

`--target wasm --package web` 把生成的**可读 C** + C++ 胶水层用 Emscripten `emcc` 编成浏览器
产物（`.wasm` + `.js` + `index.html`），在 `<canvas>` 里跑 Skia CPU 光栅 + 事件循环：

```bash
export EMSDK_HOME=/path/to/emsdk   # emcc 位于 $EMSDK_HOME/upstream/emscripten/emcc

as-aot examples/web/hello-web.as \
  --manifest examples/web/hello-web.build.json
# 产物：hello-web.html + hello-web.js + hello-web.wasm
```

浏览器不能 `file://` 直接加载 wasm，需经 HTTP 服务（`python3 -m http.server`）打开 `.html`。

与 native 清单（§4）的差异：

- **`package = "web"`** 且 `target = "wasm"`（`web` 硬性要求 wasm）。
- **新增 `font-urls`**：字体字节流 URL 列表，写入 `index.html` 的引导脚本，运行时 `fetch` + 注入
  Skia（wasm 沙箱无系统字体，见 [`html5-web.md`](html5-web.md) §4）。
- **不链接 `zlib`**：web 链接加 `-s USE_ZLIB=1`，Emscripten 同时提供 zlib 头文件与符号；显式
  `-l zlib` 反而可能冲突。

实现要点（`src/build.ts` 的 `buildWebCompileSteps()` + `src/index.ts` 的 `writeWebIndex()`）：

- **emcc 定位**：`EMSDK_HOME` 指向 emsdk 根目录，emcc 为其 `upstream/emscripten/emcc`。
- **C/C++ 分层**：生成的 `.c` 走 C 路径；`skia_glue.cc`/`web_glue.cc` 走 `-std=c++17`。
- **`SK_TRIVIAL_ABI` 匹配**：wasm 版 `libskia.a` 以 `is_trivial_abi=true` 编译，C++ 胶水层必须带
  `-D SK_TRIVIAL_ABI=[[clang::trivial_abi]]`，否则运行期 `unreachable` 崩溃（`build.ts` 已自动加）。
- **`EXPORTED_FUNCTIONS`**：显式导出 `_main`/`_malloc`/`_free`/`_sk_fontmgr_register_data`（字体
  注入引导脚本依赖；漏掉会让字体注入静默失败或无人启动 main）。
- **`INVOKE_RUN=0`**：JS 在字体注入完成后才调 `Module._main()`。

完整架构、字体注入流程与已知限制见 [`html5-web.md`](html5-web.md)。

## 7. 窗口化（SDL2 后端）

`--target native` 下有三种构建形态，由**源码 + 构建清单**共同决定（GUI 开关不在 `--target`，而在
源码里的 `Stage.showWindow(...)` 与清单里的 `ASC_USE_WINDOW=1` 宏）：

| 形态 | 编译命令 | 关键 `defines` | 关键 `sources` / `-l` |
|---|---|---|---|
| 纯命令行（无图形） | `as-aot examples/hello.as --run` | 无 | 无（默认 `cc -O2 -lm`） |
| 离屏渲染（Skia 出 PNG，无窗口） | `as-aot app.as --manifest examples/skia-link.build.example.json` | `ASC_USE_SKIA=1` | `skia_glue.cc` +（用到 `flash.text` 时自动加 `skia_text_glue.cc`）+ `-l skia ...` |
| GUI 窗口（SDL2 上屏 + 事件循环） | `as-aot examples/window_click.as --manifest examples/window_click.build.example.json` | `ASC_USE_SKIA=1` + `ASC_USE_WINDOW=1` | `skia_glue.cc` +（同上）+ `window_glue.cc` + `-l SDL2 -l objc` |

核心机制：`ASC_USE_WINDOW=1` 决定 `Stage.showWindow(...)` 是「真正弹窗进入事件循环」还是「退化为
no-op」（见下文 `runtime.ts` 的条件编译）。因此同一个 `.as` 换 manifest 即可在「离屏 PNG」与「GUI
窗口」间切换，无需改源码。

> **「离屏」那条只链 Skia**：`sources` 里没有 `window_glue.cc`、`link-libs` 里没有 `SDL2`，也不需要
> SDL2 的头/库路径（`ASC_USE_WINDOW` 未定义时 `Stage.showWindow()` 退化为 no-op）。这两条文档清单
> 都由 `test/unit/build.ts` 的 `build/DocumentedLinkSets` 用**清单自己的 `defines`** 编译一次生成的 C
> 兜底：任一条组合编不过就红（2026-10-06 离屏那条缺 `AS_CURSOR_*` 而静默失效即此类，已修为
> 「枚举在所有后端分支之外单处定义」）。

> **两个 GPU 宏不可混用**（混用会误判 `Context3D.driverInfo` 的后端）：
>
> | 宏 | 含义 | 由谁定义 |
> |---|---|---|
> | `ASC_RENDER_METAL` | **窗口合成**走 Metal：`metal_glue.mm` 的 `CAMetalLayer` + Ganesh，整帧在 GPU 上合成（2D 上屏用）。**每个窗口一份状态**（按窗口 id 分槽，只共享 device/queue/context），主窗口与运行期 `NativeWindow` 都走它（后者除非 `renderMode="cpu"`） | `air-app.ts` 在 `<renderMode>direct/gpu` + 可见窗口时加入 |
> | `ASC_RENDER_WINGPU` | **Windows 的窗口合成**，一个**后端中立**的开关：只说「这扇窗走 GPU」，不说哪一套。`window_glue.cc` 据此调 `sk_attach_gpu()`，后者再按具体宏分派到 `d3d_glue.cc`（`ASC_RENDER_D3D`）或 `gl_glue.cc`（`ASC_RENDER_GL`） | `air-app.ts` 在同上条件且宿主为 Windows 时加入 |
> | `ASC_RENDER_STAGE3D` | **Stage3D 的 `Context3D` 接到真实 GPU**：链接 `stage3d_glue.mm`，`as_s3d_*` 包装器从 no-op 变为真实 Metal 调用 | 构建清单（`usesStage3D` 时由 `air-app.ts` 加入） |
>
> 二者**互相独立**：只定义前者时 `Context3D` 仍是纯 C 状态机（`driverInfo` 返回 `"Software (state machine)"`）；
> 只定义后者时窗口仍走 CPU raster（如 `examples/stage82.build.json`）。既是 GPU 窗口又用 Stage3D 的工程
> （Starling、shmup）两个都要给。

> **Windows 的具体后端由 `--gpu-backend` 决定**（§3.4.6）：`ASC_RENDER_D3D` 与 `ASC_RENDER_GL` **互斥**，
> 同时出现会在**构建期**报 `one binary links one window GPU backend`——而不是让链接器/预处理器替你选一个。
> 没定义 `ASC_RENDER_WINGPU` 时两个都不加，窗口回去走 CPU 光栅（与阶段一百二十六 之前的产物一致）。

**帧率诊断旋钮**（用 `-D` 追加，默认不编译进产物）：

| 旋钮 | 目标 | 形态 | 说明 |
|---|---|---|---|
| `ASC_FRAME_STATS` | native | 运行时 env（`getenv`） | 每 512 帧打印帧时 `p50/p95/p99/max` + GC 占比 + RSS/段数（见 [`gc.md`](gc.md)） |
| `ASC_FRAME_STATS` | **web** | **编译期 define**（`-D ASC_FRAME_STATS=1`） | 浏览器无 env；每秒把 `frames`/`loopcalls`/`skips`/`renderMs`/`rafPeriodMs`/`skip` 发到 `window.__ascFrameStats`（见 [`html5-web.md`](html5-web.md) §3.2） |

web 侧的 `loopcalls` 与 `frames` 之差直接区分「rAF 本身慢（刷新率上限）」与「节拍缺陷」：
后者是 120 Hz 屏上只跑 66 fps 的根因（时间戳截止期节拍在 rAF 抖动下丢/取交替、速率减半），
已修为整 tick 节拍（[`html5-web.md`](html5-web.md) §3.2）。

`--target native` 默认产出的是**命令行可执行文件**（离屏 CPU raster → PNG 后退出）。要在 macOS
上弹出一个真正的原生窗口并进入事件循环，用 `Stage.showWindow(width, height, title)`，它把离屏
Skia surface 的像素经 `vendor/window_glue.cc` 上屏到 SDL2 窗口（事件循环处理 `SDL_QUIT`/重绘，并
把鼠标输入经函数指针回调转发回 AS3 事件系统，支持点击交互与事件后重渲染）。

**环境要求**：SDL2 必须是 **arm64** 架构（与 arm64 Skia 静态库一致）。本机若已有 x86_64 的
`brew install sdl2`（Intel Homebrew，装在 `/usr/local`），直接链接会报 `file built for
macOS-x86_64`；需用 arm64 Homebrew（`/opt/homebrew`）重装，或像本项目一样**源码编译 arm64 静态库**
放进 `vendor/sdl2/{include,lib}/macos-arm64/`（`configure --host=arm64-apple-darwin --disable-shared`）。

编译（等价于下面的构建清单）：

```bash
as-aot examples/window.as --manifest examples/window.build.example.json
```

构建清单 [`examples/window.build.example.json`](../../examples/window.build.example.json) 在 Skia 基础上
额外声明：

- `sources` 追加 `../vendor/window_glue.cc`（SDL2 窗口 + 上屏 + 事件循环）；
- `include-paths` 追加 `../vendor/sdl2/include/macos-arm64`，`link-paths` 追加 `../vendor/sdl2/lib/macos-arm64`；
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
- `Stage.contentsScaleFactor` 返回实测倍率（Retina 上 2.0，`standard` 下 1.0），值取自**窗口所在
  显示器的 backing scale**（macOS 直接问 NSWindow 的 `backingScaleFactor`），所以窗口创建后立刻可读，
  document class 构造期就是 2.0 —— 与 `adl` 一致。**不要**用“物理像素 / 逻辑点”现算：拖动窗口时 SDL 的
  像素尺寸（现场问 Cocoa）与逻辑尺寸（SDL 缓存、由 resize 事件写入）会差一档，商给出 2.006–2.0625 这类
  假倍率，画布与舞台同源同错 ⇒ 整幅画面被放大 ~3%，拖起来一胀一缩地“呼吸”（阶段二百二十四）。
- `Stage.nativeWindow` 在 document class 构造期**已非 `null`**（对齐 AIR 的「OS 窗口先于文档类存在」）：
  我们的窗口本要到 `showWindow` 才建，故 `Stage_get_nativeWindow` 在根 Stage 尚未绑定窗口槽位时
  **惰性绑定** `ASC_wins[0]`（`ASC_win_claim_main` 相应改为非摧毁式占用），此后 `showWindow` 再认领
  同一槽位不丢绑定；构造期对 `nativeWindow` 的读是真实 wrapper（`nativeWindow === nativeWindow` 恒等），
  此时尚未存在的 OS 窗口上的写（`bounds`/`title`）在胶水层是安全 no-op。
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

> 窗口化产物在 `raw` 形态下仍是 Mach-O 可执行文件（可直接命令行运行并弹窗）；要“双击可运行”的
> macOS `.app` 打包（`MyApp.app/Contents/MacOS/...` + `Info.plist`）用 `--package xcode-project`
> 生成 application 工程（§6.5），由 Xcode 构建出 `.app` bundle。

## 8. 相关文档

- [`README-CN.md`](../../README-CN.md) — 项目总览、支持的语言子集、类型映射
- [`TODO.md`](../../TODO.md) — 分阶段路线图（阶段二十九为「构建清单 + 多目标后端」）
- [`as3-semantics.md`](as3-semantics.md) — AS3 语义保真红线与规范来源
- [`html5-web.md`](html5-web.md) — 浏览器渲染目标（`--target wasm --package web`）的实现与使用
- [`win32.md`](win32.md) — Windows 原生后端（`<architecture>` 位宽、`vendor/provision/windows.ps1`、Skia D3D12 直连 GPU、首跑核对清单）
- [`skia.md`](skia.md) — 渲染后端（Skia 光栅化 + wasm 字体注入）
- [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) — 开发规范（§2.9 构建与链接）
