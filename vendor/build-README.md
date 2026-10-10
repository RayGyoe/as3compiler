# build-windows-deps.ps1

> 在 Windows 上把 as3compiler 的本地依赖库（**Skia / SDL2 / curl 三件套**）从源码编译出来，
> 产物直接落到 `as3compiler/vendor/<pkg>/`，供 `--air-app` 的 Windows 原生链接使用。

本 README **只**讲这一个脚本。脚本的完整设计背景、自愈点与版本 pin 写在脚本头部注释里（`<# ... #>` 块），
需要细节时以脚本头注释为准。

---

## 它做什么

- 一次产出 **x64 与 x86（win32）两套** 静态库，由 AIR 描述符 `<application><architecture>`（`"32"` / `"64"`，
  缺省 `32`）决定链接哪一套。
- 三个库**一律用 LLVM 的 `clang-cl` 编**（clang 前端 + **MSVC ABI**），产物是 `.lib`。
  这是硬约束：Skia 的 gn 在 Windows 上只有 MSVC toolchain，而 MSVC ABI 的静态库不能与 GNU/MinGW ABI 互链，
  所以 SDL2 / curl 也必须编成 MSVC ABI。程序本体之后用 `clang --target=<三元组>`（GNU 风格驱动、目标 ABI 同为 MSVC）
  编，与这些 `.lib` 直接互链。
- 自动处理 6 处「新工具链 / Windows 平台」障碍（见下方「自愈点」），并**核对产物真实位宽**，不静默出货。

---

## 前置需求（脚本会自检并报下载地址）

1. **Visual Studio 2022 生成工具**，工作负载勾「使用 C++ 的桌面开发」（MSVC x86/x64 工具集 + Windows SDK）。
2. **LLVM/clang**（含 `clang-cl.exe`）：<https://github.com/llvm/llvm-project/releases>
   安装时勾 "Add LLVM to the system PATH"，或设环境变量 `LLVM_HOME` 指向安装根目录。
3. **Git**（拉 Skia 源码）、**Python 3**（跑 Skia 的 `git-sync-deps` / `fetch-gn` / `fetch-ninja`）。
4. **CMake**（编 SDL2/curl）。Ninja 由脚本自动取（Skia 自带 `fetch-ninja`），也可自装。

---

## 快速开始

```powershell
cd as3compiler\vendor
powershell -ExecutionPolicy Bypass -File .\build-windows-deps.ps1
```

默认 `-Arch both`，两套位宽都产。首次会下载源码并全量编译。

---

## 参数

| 参数 | 说明 |
|---|---|
| `-Arch both\|x64\|x86` | 目标位宽，缺省 `both` |
| `-Only skia,sdl2,curl` | 只构建其中一部分（逗号分隔，可单个） |
| `-SkipSkia` / `-SkipSdl2` / `-SkipCurl` | 跳过对应包 |
| `-Clean` | 清掉构建输出目录（不动已下载源码，便于重编） |
| `-SkipDownload` | 源码已下好，跳过下载/解包 |
| `-LlvmHome 'C:\Program Files\LLVM'` | 指定 LLVM 安装根目录（含 `bin\clang-cl.exe`）；缺省取 `$env:LLVM_HOME` 或自动探测 |
| `-Jobs N` | 并行任务数，`0` = 按 CPU 核数 |

---

## 产物布局

```
vendor/skia/lib/windows-x64/*.lib        # skia.lib / skottie.lib / libpng.lib ...（无 lib 前缀）
vendor/skia/lib/windows-x86/*.lib
vendor/skia/lib/windows-<arch>/icudtl.dat   # Skia 的 ICU 数据（文本整形必需，见下）
vendor/sdl2/windows-x64/{include,lib}      # SDL2.lib / SDL2main.lib
vendor/sdl2/windows-x86/{include,lib}
vendor/curl/include/                        # 头文件（两套位宽共享）
vendor/curl/lib/windows-x64/                # curl.lib / nghttp2.lib / zlib.lib / z.lib
vendor/curl/lib/windows-x86/
```

---

## 自愈点（脚本自动处理并响亮报明）

| 障碍 | 处理 |
|---|---|
| LLVM 23 的 clang resource dir 只用主版本号（`lib/clang/23`），Skia m124 的 `highest_version_dir.py` 正则写死 `X.Y.Z` → `gn gen` 崩 | 自己算出 `clang_win_version` 写进 `args.gn`，绕开脆弱探测 |
| clang 23 删 `__builtin_ia32_vcvtph2ps256`，m124 的 skcms 用它做 f16→f32 AVX2 快路径 | 照抄上游 skcms 最小修法（`_Float16` + `__builtin_convertvector`）打补丁 |
| dng_sdk 用 `std::auto_ptr`，MSVC STL 在 `/std:c++17` 下已移除 | 只给 dng_sdk 一个 target 加 `_HAS_AUTO_PTR_ETC=1`，Adobe 源码一字不改 |
| Skia `GrD3DUtil.h` 声明 `std::wstring/string` 却缺 `#include <string>` | 补一行显式 include |
| Windows `tar.exe`（bsdtar）解不了 SDL2 包里两条符号链接 → 整个解包失败 | 只对这种失败排除这些条目重解并逐条列出；其它解包错误照常抛错 |
| x86 上 Skia gn 强制要求 `SetEnv.cmd /x86`（新版 Windows Kits 常没有） | 对源码打一处最小工具链补丁（仅 `clang_win` 非空时跳过 env_setup），构建后核对产物真实位宽 |

---

## 常见坑

### 1. 只重编某一位宽，另一套仍是旧产物（CRT 混链 → lld-link 未解析符号）

三个开关（curl/nghttp2/zlib/SDL2 强制 **静态 CRT `/MT`**）是后来才加的。如果你早先只构建了 **x86**、
之后切到 **x64** 链接，x64 的 curl 栈可能还是更早的 `/MD` 旧产物，链接时报：

```
lld-link: error: undefined symbol: __declspec(dllimport) read / write / fgets / fdopen / _wassert / _fdopen
```

根因是 `/MT`（静态 CRT）与 `/MD`（动态 CRT）混链。**修法**：用当前开关把缺的那套位宽补编一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows-deps.ps1 -Arch x64 -Only curl -SkipDownload
```

判据：`llvm-nm -u` 看 `nghttp2.lib` 的 `_wassert` 是否还有 `__imp_`（dllimport）引用——清零即 `/MT` 已生效。

### 2. icudtl.dat 缺失 → 首跑文本整形时 SIGILL

脚本收产物时会把 `icudtl.dat` 与 Skia 的 `.lib` 一起拷到 `vendor/skia/lib/windows-<arch>/`（缺失则 `Fail`）。
编译侧（`src/build.ts` 的 `deploySkiaIcuData`）再把它拷到 exe 旁。两环缺一不可——缺了它，`SkParagraph` 首次
整形会读空 grapheme 表越界 `SK_ABORT`（`ud2`，exit 132）。

### 3. 编译耗时正常，不是卡死

Skia 编一次 30~60 分钟（几千个 C++ 文件）。两套位宽是两棵独立 out 目录，时间与磁盘大致翻倍。

---

## 注意事项

- 所有版本 pin 死（Skia `chrome/m124`@`03c4671c`、SDL2 `2.32.10`、curl `8.11.1`、nghttp2 `1.64.0`、
  zlib `1.3.1`），与 `build-tools/` 里既有的 macOS/wasm 构建同源，避免「头文件配另一份实现」的 ABI 漂移。
- 32 位与 64 位**不能混链**：`Capabilities.cpuAddressSize` / `supports32BitProcesses` 必须与所选三元组一致。
- 更完整的 Windows 原生后端说明见 `docs/zh-cn/win32.md`。
