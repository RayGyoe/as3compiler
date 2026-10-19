# Windows 原生后端（Win32 + SDL2 + Skia D3D12）

> 阶段一百二十六。本文覆盖：`<architecture>` 的位宽语义、Windows 依赖库的构建、
> 编译器侧的清单接线、以及**首个 Windows 机器上的核对清单**。
>
> **现状一句话**：编译器侧（描述符解析 / 构建清单 / 库名 / 后端 seam / 依赖脚本的
> 去机器化验证）**已在 macOS 上离线验证**；**2026-10-10 在真实 Windows（clang 23.1.3 +
> `--target=i686-pc-windows-msvc`）上把生成的 `air-native.c` 与三个 C++ glue
> （`skia_glue.cc`/`window_glue.cc`/`d3d_glue.cc`）都编过了**（修掉四类 MSVC 障碍，
> 见 §2.6）；**链接**（40+ 个 `windows-x86` `.lib`）与**运行期**（D3D12 swapchain / 窗口 /
> GDI 字体枚举）**也已实机跑通**：`air-native` 全部 demo 断言通过、开两个 D3D12 窗口。
> 运行期另撞出三处 Windows 专属缺陷（缺 `icudtl.dat` 的 SIGILL、async FileStream 的
> `fopen("read")` 快失败、`deleteDirectory` 误用 `remove()`），均已修（见 §2.7）。
> §5 的核对清单按实测结果标注，已验项不再「假设」。

---

## 1. `<architecture>`：位宽是一等参数

AIR 描述符里决定 Windows 载体程序位宽的是 `<application><architecture>`，**默认 `32`**：

```xml
<application xmlns="http://ns.adobe.com/air/application/51.4">
  <id>com.example.app</id>
  <architecture>32</architecture>   <!-- "32" | "64"，缺省 32 -->
</application>
```

`src/air-app.ts` 的 `parseAirApp` 只接受 `"32"`/`"64"`（其他值**响亮**报 `AirAppError`，
`"16"` 实测被拒——绝不静默按 32 处理）。它经 `airManifest(..., architecture)` 决定：

| `<architecture>` | vendor 目录 | 目标 triple | x86/x64 |
|---|---|---|---|
| `32`（缺省） | `vendor/*/lib/windows-x86` | `i686-pc-windows-msvc` | — |
| `64` | `vendor/*/lib/windows-x64` | `x86_64-pc-windows-msvc` | — |
| `arm64`（**仅清单字段**） | `vendor/*/lib/windows-arm64` | `aarch64-pc-windows-msvc` | 见 §2.11 |

`arm64` **不在 `<architecture>` 的取值里**，只作构建清单字段（`architecture`）存在：AIR 没有 Windows
ARM64 运行时（量值见 §2.11），描述符里写它没有任何消费者，`parseAirApp` 因此仍只收 `"32"`/`"64"`。
两处各自校验自己的值域，未知值一律**响亮报错**（`src/build.ts` 的清单校验不回退 x86_64）。

三处路径随之切换：`vendor/skia/lib/windows-xN`、`vendor/sdl2/{lib,include}/windows-xN`、
`vendor/curl/lib/windows-xN`。（`vendor/` 是**入库**目录；`build-tools/` 不入库、在 Windows 上重新下载。）

---

## 2. 依赖库的构建：`vendor/build-windows-deps.ps1`

```powershell
pwsh vendor/build-windows-deps.ps1             # = -Arch both（缺省）：x64 + x86
pwsh vendor/build-windows-deps.ps1 -Arch x64    # 产出 vendor/*/lib/windows-x64
pwsh vendor/build-windows-deps.ps1 -Arch x86    # 产出 vendor/*/lib/windows-x86
pwsh vendor/build-windows-deps.ps1 -Arch arm64  # 产出 vendor/*/lib/windows-arm64（需先装 ARM64 工具集，见 §2.11）
```

从源码构建：**Skia m124**（`build-tools/skia-src`，含 `bin/gn` + ninja）、**SDL2 2.32.10**、
**curl 8.11.1**、**zlib**、**nghttp2**。工具链用 LLVM 的 **`clang-cl`**（MSVC ABI）。

产物布局三个库**一条规则**：库进 `<pkg>/lib/<arch>/`、头文件进 `<pkg>/include/`（Skia 的 `-I` 指包根
`vendor/skia`，因为胶水层写的是 `include/core/SkCanvas.h`）；**只有 SDL2 的头文件也分位宽**
（`<pkg>/include/<arch>/SDL2/`），因为它的 `SDL_config.h` 由构建逐平台生成，而 Skia/curl 的头跨平台
逐字节相同（共用一份才不会各自漂移）。macOS 侧同形（`vendor/sdl2/lib/macos-arm64`、
`vendor/sdl2/include/macos-arm64`），位宽键带 OS 前缀以免与 Windows ARM64 混淆。

### 2.1 三条硬约束（实测得出，别再试别的路）

1. **Windows 上 gn 只有 MSVC toolchain**。`gn/BUILDCONFIG.gn` 里 `if (is_win) set_default_toolchain("//gn/toolchain:msvc")`，且只有 `clang_win` 非空时才会把 `cl.exe` 换成 `clang-cl` + `lld-link`。MinGW 走不通。
2. **MSVC 与 GNU ABI 的静态库不能互链** ⇒ SDL2 / curl 也必须 `clang-cl`。程序侧则可按惯例用
   `clang --target=x86_64-pc-windows-msvc`（GNU 风格旗标可用，与这些 `.lib` 同 ABI）。
3. **x86 的旗标不是 `-m32`**。CMake 侧传 `--target=i686-pc-windows-msvc`：实测 COFF 机器字段
   `-m32` 在 arm64 主机上是 `0x01c4`(**ARMNT**)、默认是 `0xaa64`(ARM64)，只有
   `--target=i686-pc-windows-msvc` 才给 `0x014c`(I386)。脚本里 `Assert-LibBitness` 用
   `dumpbin /headers`（或 `llvm-readobj`）认 x64/x86/ARM64/ARM，**错位即硬失败**——不做「碰巧能跑」。

### 2.2 两个 MSVC 专属陷阱（已处理）

- **zlib**：CMake 无条件同时建 `SHARED zlib`（产出**导入库** `zlib.lib`，撞静态库惯用名）与
  `STATIC zlibstatic` ⇒ 删掉导入库 + 传 `ZLIB_USE_STATIC_LIBS=ON`。
- **nghttp2**：必须 `BUILD_SHARED_LIBS=OFF`（否则库名变 `nghttp2_static` 且有导入库），且 curl 用
  `find_library` 找它、拿不到 `PUBLIC` 的 `-DNGHTTP2_STATICLIB` ⇒ 脚本显式补上。

### 2.3 Skia 的 x86 墙与 `skia_use_direct3d`

x86 侧还需 `Repair-SkiaX86Toolchain`：自动探测 `$winSdk\bin\SetEnv.cmd`，并对 gn 源码打一处**最小**
补丁（把 x86 的 `env_setup` 包进 `if (clang_win == "")`，使 `clang_win` 生效时不被覆盖），带幂等标记
`ASC-X86-CLANG-PATCH` 与换行归一。

> 踩坑记：PS 5.1 的 here-string **沿用脚本文件自身的换行**，而 git 在 Windows 上默认 `core.autocrlf=true`
> ⇒ 脚本以 CRLF 检出时 `$old` 也是 CRLF，与归一化成 LF 的文本永远比不中，补丁就会「找不到锚点」
> 假失败（同一份脚本在 LF 检出下却能过）。所以这里**两边的换行都必须归一化**；新增任何「比对源码
> 文本」的补丁都要照此办理。

`skia_use_direct3d = true`（阶段一百二十六 打开）带来三个后果，缺一不可：
`SK_DIRECT3D` 进入 public defines、产出 `third_party/d3d12allocator` 归档、并需要
`d3d12`/`dxgi`/`d3dcompiler` 系统库。**清单侧必须同步**（见 §3.2），改 gn 参数而不改清单等于链接期炸。

### 2.4 新工具链（clang 23 / MSVC STL 14.43）带来的四处编不过（已处理）

都是**实测撞出来的**，与 AS3 无关；脚本逐个自愈，并在被改的源码里留下带标记的最小补丁（可重入，
与预期不符就响亮报错）：

- **LLVM 23 的 resource dir 只用主版本号**（`lib/clang/23`，不再是 `X.Y.Z`），而 Skia m124 的
  `gn/highest_version_dir.py` 把正则写死成 `X.Y.Z` ⇒ 扫不到就 `IndexError`，`gn gen` 整个挂掉。
  脚本改问 `clang-cl -print-resource-dir`（保留枚举 `lib/clang` 取数值最大版本的兜底），把
  `clang_win_version` 直接写进 `args.gn` 绕开那个脆弱探测。
- **clang 23 删掉了 `__builtin_ia32_vcvtph2ps256`**，而 m124 自带的 skcms 正拿它做 f16→f32 的 AVX2
  快速路径（`modules/skcms/src/Transform_inl.h` 的 `F_from_Half`）⇒ 照抄**上游 skcms 自己**的最小
  修法（`_Float16` 向量 + `__builtin_convertvector`，`clang >= 15` 起可用），仍编出 `VCVTPH2PS`，
  **不降级、不失速**。标记 `ASC-CLANG23-SKCMS-PATCH`。
- **MSVC STL 在 `/std:c++17` 下移除了 `std::auto_ptr`**（`yvals_core.h`: `_HAS_AUTO_PTR_ETC =
  !_HAS_CXX17`），而 dng_sdk 的 `dng_pthread.cpp`（Windows 的 pthread 仿真）还在用它 ⇒ 脚本只给
  `third_party/dng_sdk` 这一个 target 加 `_HAS_AUTO_PTR_ETC=1`，**Adobe 源码一字不改**（`auto_ptr`
  的所有权语义保持原样，不被换成 `unique_ptr` 而悄悄改行为）。这与 clang 版本无关，是 Windows +
  MSVC STL 独有的必失败；上游 AOSP 的 dng_sdk 至今也还在用 `auto_ptr`（没有上游修法可抄）。
  标记 `ASC-DNG-AUTOPTR-PATCH`。
- **Skia 自己的 `src/gpu/ganesh/d3d/GrD3DUtil.h`** 声明 `std::wstring`/`std::string` 却从不
  `#include <string>`（以前靠别的头间接带进来，新版 MSVC STL 不再提供）⇒ 补一行显式 include
  （IWYU 正解，纯声明可见性）。标记 `ASC-D3DUTIL-STRING-PATCH`。

### 2.5 Windows 的 `tar.exe` 建不了符号链接（已自愈）

Windows 自带的 `tar.exe`（bsdtar）在未开「开发者模式」/没有「创建符号链接」特权时解不了归档里的符号
链接，而 SDL2 的发布包正好有两条 —— `SDL2-2.32.10/android-project-ant/{src,AndroidManifest.xml}`，
指向 `android-project` 里同一份源码，是给已废弃的 Ant 版 Android 工程模板用的、与 Windows 构建无关 ——
于是整条解包以 exit 1 收尾。

脚本**只自愈这一种失败**：先原样解包；失败后逐行筛查 tar 输出，只接受
`<归档内路径>: Can't create '...'` 与 `tar.exe: Error exit delayed from previous errors` 两种行，
出现任何别的行都说明是别的毛病，把原始输出整段抛出去；随后删掉半成品目录、用 `--exclude` 逐条排除
后重解，并把跳过的条目**逐一列出**（不静默降级，也不把「跳过了什么」藏起来）。

### 2.6 程序侧（glue 层）的四类 MSVC 障碍（2026-10-10 实机撞出，已修）

依赖库编得过后，**程序侧**（生成的 `air-native.c` + `skia_glue.cc`/`window_glue.cc`/
`d3d_glue.cc`）在 `clang --target=i686-pc-windows-msvc` 下仍有四类障碍——都是编译期
实撞出来的，与 AS3 语义无关，逐个修掉：

1. **字体后端**：`skia_glue.cc` 的 `#else`（非 `__EMSCRIPTEN__`）分支写死
   `#include "include/ports/SkFontMgr_mac_ct.h"`（CoreText-only），Windows 报
   `unknown type name 'CTFontCollectionRef'`。Windows 的 GDI/DirectWrite 字体管理器工厂
   不在独立头里，而在 `include/ports/SkTypeface_win.h`（`SK_BUILD_FOR_WIN`，由 `_WIN32` 经
   `SkFeatures.h` 推导）。改走 **`SkFontMgr_New_GDI()`**——它枚举 Windows 系统字体集合，
   `gdi32` 已在 SDL2 的链接清单里，故**不加新依赖**（DirectWrite 需要 `dwrite.lib`）。
2. **`window_glue.cc` 的 Cocoa 头**：`#include <objc/message.h>`/`<objc/runtime.h>` 无守卫，
   而 `objc_msgSend`/`SEL`/`sk_ns_msg_frame`/`sk_ns_msg_content_rect` 与 `sk_measure_borders`
   里的 `SDL_SYSWM_COCOA`/`info.info.cocoa` 分支只活在 macOS ⇒ 整块包进 `#if defined(__APPLE__)`；
   Windows 落到 SDL 自己的 `SDL_GetWindowBordersSize`（win32 driver 已实现）。
3. **SDL2 `_m_prefetch` 冲突**：clang 23 的 MSVC 模式把 `_m_prefetch` 声明为 builtin，而
   vendored `SDL_endian.h` 的旧 clang 兼容垫片又 `__inline__` 重定义它 ⇒ “definition of
   builtin function”。在 `#include <SDL2/SDL.h>` 之前预定义 `__PRFCHWINTRIN_H`（`<prfchwintrin.h>`
   的 include guard）跳过垫片——builtin 仍在，SDL 自己的 `_m_prefetch` 调用照常编译。
4. **`d3d_glue.cc` 三处类型错**：① `g_adapter = d3d_hardware_adapter(...)` 把裸
   `IDXGIAdapter1*` 赋给 `gr_cp<IDXGIAdapter1>`（`gr_cp` 无 `operator=(T*)`）⇒ 改
   `.reset(ptr)`（adopt，与 `EnumAdapters1` 的 +1 引用相符）；② `GrD3DTextureResourceInfo`
   的构造是 **8 参**（`resource, alloc, state, format, sampleCount, levelCount,
   sampleQualityLevel, protected`），旧代码按 7 参把 `GrProtected::kNo` 当成了第 7 个
   （`sampleQualityLevel`）⇒ 补 `0` 作 `sampleQualityLevel`（与 Skia 自带参考
   `D3D12WindowContext_win.cpp` 一致），`GrProtected::kNo` 作第 8 参；③ `GrBackendRenderTarget`
   的 D3D 包装含 `sk_sp<SkColorSpace>`，缺 `#include "include/core/SkColorSpace.h"` 会在
   `SkRefCnt.h` 报 “member access into incomplete type 'SkColorSpace'” ⇒ 补 include。

（这与 §2.4 的「Skia 源码层四处编不过」不同：那四处在 `build-windows-deps.ps1` 里对**源码**
打补丁自愈；这四类在**仓库内 glue 文件**里改，直接入库。）

### 2.7 运行期三处 Windows 专属缺陷（2026-10-10 实机首跑撞出，已修）

编译+链接过后 `air-native` 首跑仍逐个暴露三处**运行期**问题——前一处是崩溃，后两处是
`flash.filesystem` 在 Windows 上的语义缺口，都与 AS3 无关：

1. **缺 `icudtl.dat` → SIGILL（`ud2`）**。Skia 的 `SkParagraph`（`Cluster::Cluster` →
   `codeUnitHasProperty()`）依赖 ICU 填充 `fCodeUnitProperties`，而 Windows 上 `SkIcuLoader`
   从 **exe 目录**读 ICU 数据（stderr 打 `SkIcuLoader: datafile missing: icudtl.dat`）。缺文件时
   该表为空，`Cluster::Cluster` 索引越界触发 `SK_ABORT` 的 `ud2`（exit 132）。修法：构建期把
   `vendor/skia/lib/windows-x{N}/icudtl.dat`（10185008 字节）**自动部署到产物目录**——
   `src/build.ts` 新增 `deploySkiaIcuData(cfg, outPath)`（win32+native+链接 skia 时生效），
   `src/index.ts` 在 link 成功后调用（`[4/4] data icudtl.dat -> ...`）；`build-windows-deps.ps1`
   收产物时同步复制、缺失则 `Fail`。
2. **async FileStream `openAsync(…, FileMode.READ)` → `__fastfail`**。异步 `AS_JOB_FS_OPEN`
   的 mode 映射写成了 `mode = j->mode`（非空即原样透传），而 `FileMode.READ` 是字符串
   `"read"`——于是 `fopen(path, "read")`。POSIX 的 `fopen` 对非法 mode 只回 `NULL`（软失败，
   macOS 上因此**静默**成 IOError 而从未暴露）；MSVC CRT 的 `_invalid_parameter` 则对
   `"read"` 直接 `__fastfail`（0xc0000409）。同步路径 `FileStream_open` 是**对**的（默认
   `"rb"`、只把 `"write"/"append"/"update"` 换掉），异步路径漏了「`"read"` 落回 `"rb"`」
   ⇒ 改成与同步同口径：默认 `"rb"`，非空时才比较三种写模式。
3. **`File.deleteDirectory` 删不掉目录**。实现写的是 `remove(nativePath)`——POSIX 的 `remove()`
   对目录等价 `rmdir()`（能删空目录），MSVC 的 `remove()` 只是 `_unlink`（**只能删文件**），
   于是 `d.exists == false` 断言失败。修法：新增 `as_rmdir_one`（Windows 用 `RemoveDirectoryA`、
   POSIX 用 `remove`，与 `as_mkdir_one` 的 `CreateDirectoryA`/`mkdir` 同构），`deleteDirectory`
   改调它。
   > **2026-10-12 补**：非 Windows 分支从 `rmdir()` 改成 **`remove()`** —— `rmdir` 声明在
   > `<unistd.h>`，而该头**在 WASI 下被刻意跳过**（那里没有 `fork/exec`），于是**每个**
   > `--target wasm` 构建都死于 `call to undeclared function 'rmdir'`（ISO C99 起隐式声明是
   > 硬错误，`clang` 的新版本不再容忍）。`remove()` 在 `<stdio.h>`（恒在），POSIX 与 wasi-libc
   > 对目录都按 rmdir 处理，故一个调用同时覆盖两端；Windows 分支仍是 `RemoveDirectoryA`（MSVC
   > 的 `remove()` 只删文件，见上）。

### 2.8 高清模式与拖动/缩放三处缺陷（2026-10-10 实机第二跑撞出，已修）

`examples/air-native` 带 `<renderMode>direct</renderMode>` + `<requestedDisplayResolution>high</requestedDisplayResolution>`
在真机上跑起来后，暴露出三处**只在 `vendor/window_glue.cc` 一层**的问题。本机环境：3840x2560
物理屏、150% 缩放（`GetDpiForSystem`=144，而 DPI-unaware 进程只看到 2560x1707）。三处都与 AS3 语义无关。

1. **高清模式没生效（窗口发糊）**。Windows 上 `SDL_WINDOW_ALLOW_HIGHDPI` 是**空操作**：真正让高清
   生效的是**进程级** hint `SDL_HINT_WINDOWS_DPI_SCALING=1`，它 (a) 申请 per-monitor-v2 感知（进程不再
   被合成器位图拉伸），(b) 把 SDL 坐标系切到 DPI 缩放后的**逻辑点** —— 正是 macOS 侧一直在用的模型
   （`SDL_GetWindowSize` = 逻辑点、`SDL_GetWindowSizeInPixels` = 物理像素，两者之比即设备倍率）。
   实测（`temp/dpiprobe/probe.c`）：不设 hint → 逻辑 1000x680 / scale 1.000；设 `DPI_SCALING=1` →
   逻辑 1000x680、物理 **1500x1020**、scale **1.500**。
   修法：新增 `sk_video_init()` 作为**唯一**启动视频子系统的入口，在里面 latch 该 hint，并把文件里
   其余所有 `SDL_Init(SDL_INIT_VIDEO)` 调用点（show 三处、`sk_window_create`、
   `sk_window_get_display_size`）全部改走它 —— hint 只在**首次 init 之前**设置才有效，留一个裸
   `SDL_Init` 就等于随机漏掉它。
   **门在 `ASC_DISPLAY_HIGH`**：AIR 定义 `standard` = 「按 1x 渲染、交给 OS 放大」，而 DPI-unaware 进程
   本来就正是这个行为；若在 `standard` 下也点亮感知，就等于把 1x 画面塞进物理尺寸渲染目标的角落。
   故 `standard` 构建与 macOS/wasm **逐字节维持原行为**（预处理实测：`-U_WIN32` 后该字符串即消失）。
   产物实测：stderr 打 `d3d_glue: window 0 bound to 1500x1020 R8G8B8A8 swapchain`（修前 `1000x680`），
   而同一次运行 `trace(stageWidth, stageHeight)` 仍打 `1000 680` —— **逻辑尺寸不变**，符合 AIR 语义。

2. **拖动/缩放时刷新停住**。拖动/缩放跑在 OS 自己的**模态消息循环**里，而该循环是从 `SDL_PumpEvents`
   内部进入的 ⇒ 整个拖动期间主循环被阻塞（真模态循环探针：2.53 s 拖动内主循环只跑了 **1** 次迭代）。
   此时**唯一**能出帧的是 SDL 的 live-resize 事件监听器（`SDL_AddEventWatch`），而**主窗口从来没被
   挂上**它 —— 只有 `sk_window_show` 的 CPU 路径与 `sk_window_create` 挂了，两条 GPU 开窗路径漏了。
   修法：`sk_window_show_metal` 与 `sk_window_show_gpu` 的 D3D 分支都挂上同一个监听器。

3. **多窗口拖动/缩放互相影响帧率**。旧监听器**直接调 `on_frame` 并只重画被拖的那扇窗**，于是
   ① 应用帧被拉到 OS 消息速率（`Stage.frameRate` 形同虚设）；② 其它窗口一帧都不画、整个拖动期间冻住。
   修法：把循环的第 3–5 步抽成共享的 `sk_pump_frame()`（服务 resize + 选帧钟 + 按 `g_app_next` 节拍
   派发**一次**应用帧 + 把**所有**可见窗口标脏 + 只重画脏窗，带 `in_pump` 重入守卫），循环与监听器
   都只跑它，于是「拖动中的一帧」与「正常的一帧」逐字同义。

**A/B 实测**（`temp/dpiprobe/probe8.c`：用 `WM_NCLBUTTONDOWN`+`HTCAPTION` 从辅助线程进入**真**模态
移动循环，两扇窗，两种监听器行为；两种模式下这次拖动都收到**同样 359 个事件**，即 `EXPOSED=260` +
`MOVED=99`）：

| 监听器 | 主循环 | 应用帧（2.53 s） | 被拖窗重画 | **另一窗重画** |
|---|---|---|---|---|
| 旧（修前） | 阻塞（`loopIters +1`） | **+359**（≈142 fps，随 OS 事件率） | +359 | **+0（冻住）** |
| 新（修后） | 阻塞（`loopIters +1`） | **+157**（≈62 fps，受 16 ms 节拍约束） | +157 | **+157（照常动）** |

其它几次实拖里旧模式的帧数为 1235 / 3262（≈494 / 1300 fps），正说明它**完全跟随 OS 事件率**而不是
`frameRate`。

**拖动期间谁在喂监听器**（两端同一个钩子，故修法对 macOS 是同向的）：Windows 由 SDL 在
`WM_ENTERSIZEMOVE` 里 `SetTimer(USER_TIMER_MINIMUM)` → `WM_TIMER` → `SDL_OnWindowLiveResizeUpdate` →
`SDL_WINDOWEVENT_EXPOSED`（实测 260 次），外加每一步 `WM_WINDOWPOSCHANGED` → `MOVED`+`RESIZED`
（实测 99 次，该分支在 SDL 里**无条件**发、不做变化检测）；macOS 由 live-resize 期间安装的 60 Hz
`NSTimer` 发同一条 `EXPOSED`（`src/video/cocoa/SDL_cocoawindow.m`）。两类事件互补，故即使某一路被
饿死，节拍也不会掉。

探针与脚本：`temp/dpiprobe/{probe.c,probe8.c,ab.mjs}`（合成鼠标注入有失败率，失败时模态循环立刻
退出，探针以 `moved=0` 报明，`ab.mjs` 会重跑到两次拖动都真的移动了窗口再取样）。源级钉子：
`test/unit/platform.ts` 的 `unit: platform/WindowFrame`（16 条；把这三处改动回退成修前形状后其中
**7 条当场变红**）。

### 2.9 Skia 的 D3D 后端**没有借出语义**：`gr_cp` 的「拥有」契约（2026-10-10 Stage3D 合成撞出，已修）

这是本项目目前踩过的**最深的一个第三方 API 陷阱**：它不报错、不崩溃，只在**并发时机**下偶发，而
50 行打印能把根因钉死。先把契约抄在这里（`include/gpu/d3d/GrD3DTypes.h`，Skia m124）：

> there is no notion of Borrowed or Adopted resources in the D3D backend, so Ganesh will ref
> `fResource` once it's asked to wrap it. **Clients are responsible for releasing their own ref**
> to avoid memory leaks.

`GrD3DTextureResourceInfo::fResource` 的类型是 `gr_cp<ID3D12Resource>`（不是裸指针），而 `gr_cp` 的语义是：

| 操作 | 是否 `AddRef` | 何时释 |
|---|---|---|
| `gr_cp(T* obj)` 构造函数（**裸指针形 8 参构造器走的就是这条**） | **❌ 不 AddRef**（「接管」） | `~gr_cp` **会** `Release()` |
| `gr_cp::retain(T* obj)` | ✅ +1 | |
| `gr_cp` 拷贝赋值 / 拷贝构造 | ✅ +1 | |

所以把**自己唯一的那一份引用**从裸指针构造器递进去 = 把所有权送了；函数一返回，`gr_cp` 析构就
`Release()` 掉那个资源，而调用方仍持有一个**悬空指针**。实测结果（`ASC_S3D_LIFE` + `get_render_target`
的周期性打印）：**第 1 帧合成正常**（`desc(dim=3 TEXTURE2D fmt=87 1000x600)`），**第 2 帧同一个指针
的 `GetDesc()` 变成一个 144 字节的顶点缓冲区**（`dim=1 fmt=0 w=144 h=1` —— 地址被下一次分配循环了），
于是 `sk_gpu_draw_texture` 以 `unsupported render target (dxgi format 0, 1 samples); nothing was drawn`
拒掉了它，**Stage3D 的帧再也不上屏**。看似「偶发」（约 25%）只是因为释放后的内存常常还能读到旧内容，
直到分配器把那块交给别人。

正确写法（Skia 自己的 `tools/window/win/D3D12WindowContext_win.cpp` 就是这么做的）：

```c
GrD3DTextureResourceInfo info(nullptr, nullptr, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                              rd.Format, 1, 1, 0, GrProtected::kNo);
info.fResource.retain(res);   /* 自己再多拿一份引用；析构时释放这一份 */
```

或直接 `info.fResource = otherGrCpRef;`（拷贝赋值会 AddRef）。`vendor/d3d_glue.cc` 的**两处**包装点都
已改成 `retain()`：`sk_gpu_draw_texture`（合成取临时引用）与 `d3d_setup_surfaces`（swapchain back buffer ——
这里**顺带修掉一个潜在的双重释放**：原先每次 `d3d_setup_surfaces` 都会从 swapchain 手里偷走一个 back buffer 引用，
堆两个窗口时必然出错）。源级钉子：`test/unit/stage3d.ts` 的 `stage3d/d3d-glue` 组（「never wraps a borrowed
resource with the adopting constructor」+「both wrap sites retain()」）。

**教训的普遍形式**：跨第三方 API 边界先确认三件事 —— 参数是**接管**还是**借用**、析构是否会替我释放、
以及我手里那一份引用是否还要用。这里的名字叫 `GrD3DTextureResourceInfo`，但同样的模糊在 C++ 里到处都是
（`std::unique_ptr` 的裸指针形、`CFRetain`/`Release` 对、以及 Android 的 `sp<>`）。

---

### 2.10 呈现必须 1:1，绝不能被 DXGI 拉伸（阶段一百三十三，**未在 Windows 实机复测**）

**与 macOS 同源的缺陷**（macOS 侧见 [`skia.md`](skia.md) §6.7）：`d3d_glue.cc` 创建 swapchain 时
**从未给 `DXGI_SWAP_CHAIN_DESC1.Scaling` 赋值**，而零初始化即 `DXGI_SCALING_STRETCH`（=0）——
同步地，DXGI 会把 back buffer **拉伸到客户区**。这正是 Metal 侧 `kCAGravityResize` 的 D3D 对偶：
live resize 期间我们提交的那帧 back buffer 与客户区**必然短暂不一致**（窗口在画完之后还在变大），
拉伸语义下这一帧就把整幅画面重采样一次 ⇒ 所见的重影/抖动；且 2 帧 flip 队列会把被拉伸的帧
多留一会儿，所以**放开鼠标后仍会抖**。

**修法**：`sd.Scaling = DXGI_SCALING_NONE;`。它既是 **flip 模型要求的取值**
（`DXGI_SCALING_STRETCH` 是给 bitblt 交换链的；flip 交换链要 `NONE`），也正是
`kCAGravityTopLeft` 的对偶语义：尺寸未跟上的那一帧**原尺寸**呈现，而不是被拉满客户区。
稳态（back buffer == 客户区）下两者呈现完全一致，故是纯收益。

**为何未复测**：本机现为 Windows，但本节只做了**源码级**改动与验证 —— ① 改动是单字段赋值，
枚举由已包含的 `<dxgi1_4.h>`（转引 `dxgi.h`）提供；② Metal 侧的同一缺陷已有 **15/93 vs 0/151** 的
**实机 A/B**（`temp/resizeprobe/fast.py`），D3D 侧按该缺陷类 + 文档要求修正；③ 真正的 Windows 实机
复验（真拖窗口看有无重影）**仍未做**，已入 §5 清单第 16 行，**不宣称已验收**。

**回归钉子**：`test/unit/platform.ts` 的 `unit: platform/PresentScale`（9 条，跨
`metal_glue.mm` / `d3d_glue.cc` 两个**互不可编译**的宿主文件 —— 正因如此才必须用源级钉子）。

---

### 2.11 ARM64：位宽轴的第三个值 —— 为什么缺省不含它，以及它为什么能自己响亮失败

#### 一、AIR 没有 Windows ARM64，这是量出来的

| 证据 | 实测结果 |
|---|---|
| 两个 Windows 运行时的平台键（逐个扫 DLL） | **各只一个**：`win/` → `Windows-x86`；`win64/` → `Windows-x86-64`。合起来就是全部（**无** `Windows-arm64`） |
| SDK 带的 Windows 运行时目录 | 只有 `win/`（其 `Adobe AIR.dll` 仅 `Windows-x86`）与 `win64/` |
| SDK 原生侧 `lib/` | `win`、`win64`、`android`、`linux_arm64`、`mac`… **无 win-arm64** |
| 51.4.1 发布说明里的 arm64 | 只涉及 Linux / iOS / macOS |
| SDK 全部 44 个 jar | 搜不到 `Windows-x86-64` 字面量 ⇒ 平台键词表不在 jar 里，**运行时 DLL 才是权威见证** |

三个后果，一个都绕不开：① 没有扩展能声明 ARM64 的 Windows 切片（`extension.xml` 的
`<platform name>` 只能写运行时认得的键）；② 没有运行时会去找它 —— 在 Windows-on-ARM 上 AIR 跑的
是 **x64 版**（模拟执行），取的仍是 x64 原生库；③ 于是 `lib/bin/` 里**刻意没有** `windows-arm64`：
一个谁也加载不了的宿主库不是「支持」，是库存垃圾。宿主宽度集合到此是**闭集**
（`windows-x86`/`windows-x64`），`as-aot --ane` 在 Windows ARM64 上**直接报错**并点名
`--ane-platform Windows-x86-64`（+"architecture": "64"），不去猜一个 AIR 从没有过的键。

#### 二、那为什么依赖脚本还是加了 `-Arch arm64`

因为「AIR 的 Windows 端不支持 ARM64」与「这个编译器没有 ARM64 能力」是两句不同的话。
Windows-on-ARM 上**非 AIR 的产物**（不走 `--air-app` 的普通 `as-aot` 构建）可以有 arm64 形态，
`windows-arm64` 的依赖前缀正是为它准备的。但**默认（`both`）仍然只有 x64+x86**：`both` 的含义是
「AIR 描述符可能要求的两个宽度」，悄悄变成三个会让「默认产物」不再对应任何可声明的目标。

#### 三、本机没有 ARM64 工具集 ⇒ 这条路必须能自己响亮失败

实测（本机 VS 2022 Community）：三个 MSVC 工具集（14.16 / 14.29 / 14.43）都**只有**
`bin/Hostx64/{x64,x86}` 与 `lib/{x64,x86}`，**没有 arm64**；Windows Kits 10.0.22621.0 倒是有
`Lib/<ver>/{um,ucrt}/arm64`。所以 `vcvarsall.bat arm64` 在本机**返回退出码 0 却什么都没准备** ——
只看退出码就会把「工具集不存在」误判成「环境就绪」，然后在下游编出一堆错位对象。
`Import-MsvcEnv` 因此改成**读文件**自检，任一条不满足就点名要装的组件
（`MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools`）并**在下载任何东西之前**退出 1：

| 自检 | 判据 |
|---|---|
| MSVC 库目录非空 | `…\VC\Tools\MSVC\<ver>\lib\arm64\` 下至少一个 `*.lib` |
| `cl.exe` 真属于该架构 | `Get-Command cl` 的 `.Source` 必须匹配 `\arm64\cl.exe` |
| Windows SDK 有该架构 | `…\Windows Kits\10\Lib\<ver>\um\arm64\` 存在 |

**实测两态**：`-Arch arm64 -Only curl` → **退出 1**、文案点名缺失的 `lib\arm64` 与要装的组件、
**且未发生任何下载**；`-Arch x86 -Only curl` → 打印 `[ok] x86 位宽工具集自检通过（…HostX86\x86\cl.exe）`
⇒ 这是**真判据**而非一律拒绝的挡箭牌。`-Arch arm32` → `ValidateSet` 报错并列出合法取值。

#### 四、Skia 的 clang-cl 会默认用宿主架构 —— arm64 必须把三元组钉进去

`build-tools/skia-src/gn/toolchain/BUILD.gn` 里 win 分支**只为 x86 传 `-m32`**，arm64 分支
**不传任何架构旗标**（只把 `HostX64\x64` 追加进 `PATH`），`bin` 路径更是写死 `HostX64`：在 x64 宿主上
用 `target_cpu=arm64` 跑，clang-cl 会**静默产出 x64 对象**。故 arm64 时给 gn 加
`extra_cflags = [ "--target=aarch64-pc-windows-msvc" ]`（该 arg 由 `gn/skia/BUILD.gn` 声明）。
产物身份由构建后的 `Assert-LibBitness` 复核（读 COFF 机器字段，**不是**信 clang 的退出码）。

#### 五、如实报明：这条路径本机没跑完

本机没有 ARM64 工具集，所以「`-Arch arm64` 能产出正确的 arm64 依赖」**没有被验证过**；已验证的是它的
**守卫**（上表三条 + 构建后的位宽复核）与**失败路径**（退出 1 + 指名组件）。已入 `TODO.md` 的
`### 遗留待开发`。macOS 运行时侧那条**同类观察已在后续一轮修掉**：该 SDK 的 macOS 运行时里只有
`MacOS-x86-64`/`MacOS-x86` 两个 ANE 键（`Adobe AIR` 是 universal 二进制，两个切片里都是 `MacOS-x86-64`；
`MacOS-AOT` 全 SDK 0 命中），而 `currentAnePlatform()` 原来在 darwin/arm64 上返回 `MacOS-AOT` ⇒
真 macOS ANE 在 Apple Silicon 上**匹配不上**（假阴性）。现 darwin 两种架构统一返回 `MacOS-x86-64`；
证据与钉子见 `TODO.md` 阶段一百七十八·六；平台键与 `lib/bin/` 目录的完整对照表、以及
**把一个现成 ANE 迁进 AOT 的逐步流程**见 [`ane.md`](ane.md)（§3.4 / §4）。

---

## 3. 编译器侧接线

### 3.1 `<renderMode>` 在 Windows 上的两个分支

| 描述符 | 宏 | 额外源 | 额外链接 | 语义 |
|---|---|---|---|---|
| `direct` / `gpu` | `ASC_RENDER_WINGPU=1` `ASC_RENDER_D3D=1` | `d3d_glue.cc` | `d3d12` `dxgi` `d3dcompiler` `d3d12allocator` | 每帧整帧 GPU 合成（D3D12） |
| `cpu` / `auto` | — | — | — | CPU 光栅 + SDL streaming texture blit |

macOS 专属的 `metal_glue.mm` / `objc` / Cocoa `framework` 项在 Windows 上全部去掉；
`src/build.ts` 的 `-lm`/`-lz` 在 win32 归零（`m.lib`/`z.lib` 在 Windows 不存在）；
`AS_HAVE_ICONV=0`（`<iconv.h>` 不在 CRT 里，非 UTF 字符集**响亮**抛错，与 wasm 口径一致）。

### 3.2 `-l` 名：Windows 归档**没有** `lib` 前缀

gn 的 Windows `tool("alink")` 无 `output_prefix`（POSIX 有）⇒ 归档名是 `<target>.lib`。
该结论来自在 macOS 上直接 `gn gen`（`target_os="win" target_cpu="x64"`，假 `C:/fake/...` 目录置于 out 下
即可——gn 不重定位绝对路径）读出的**真实** `build.ninja`（`Done. Made 91 targets`）。因此：

- 一般目标（`skia`/`zlib`/`expat`/`freetype2`/`harfbuzz`/`icu`/`dng_sdk`/`piex`/`sksg`/`skottie`/`svg`/
  `skresources`/`skparagraph`/`skshaper`/`skunicode`/`skcms`/`wuffs`/`bentleyottmann`）⇒ `-l<name>`。
- **字面名为 `lib*` 的四个目标**（`libpng`/`libjpeg`/`libwebp`/`libwebp_sse41`）⇒ `-llibpng` …
  `air-app.ts` 用 `winLib()` 统一处理。
- `third_party/d3d12allocator` ⇒ `-ld3d12allocator`（Ganesh 的 D3D 后端在 `fMemoryAllocator` 为空时
  **自建** `GrD3DAMDMemoryAllocator`，见 `src/gpu/ganesh/d3d/GrD3DGpu.cpp` 的 `GrD3DGpu::Make` ⇒
  这个归档必须在线）。同理 `-lskia -lskia` 之外的 `-lfreetype2` 等依实测表。

实测（arch=32）的完整 `link-libs`：
`skia … wuffs, **libpng, libjpeg, libwebp, libwebp_sse41**, dng_sdk, piex, expat, freetype2, harfbuzz,
icu, zlib, d3d12, dxgi, d3dcompiler, d3d12allocator, SDL2, user32, gdi32, winmm, imm32, ole32, oleaut32,
version, uuid, advapi32, setupapi, shell32, dinput8, curl, nghttp2, crypt32, ws2_32, secur32, bcrypt,
iphlpapi`；`frameworks: []`；`defines:` `ASC_USE_SKIA=1, ASC_USE_WINDOW=1, ASC_DISPLAY_HIGH=1,
ASC_RENDER_WINGPU=1, ASC_RENDER_D3D=1, ASC_HAVE_CURL=1`。64 位只换三处 vendor 路径。

### 3.3 后端中立的 GPU seam

`ASC_RENDER_WINGPU` 的含义是**「本窗口的 Skia 合成跑在 GPU 上」**，具体后端由
`ASC_RENDER_METAL`(macOS) / `ASC_RENDER_D3D`(Windows) 指名（`ASC_RENDER_GPU` 已被 web 的 Ganesh 路径占用）。
生成 C 与 runtime 只用中性名：`sk_gpu_init` / `sk_gpu_destroy` / `sk_gpu_begin_frame` / `sk_gpu_flush` /
`sk_gpu_draw_texture`、`sk_window_show_gpu`、`as_skia_gpu_*`、`w->is_gpu`。**唯一**出现后端分支的地方是
`vendor/window_glue.cc`（`sk_attach_gpu` 按宏分派、`sk_window_show_gpu` 按宏实现），所以同一条 AS3
源码在两端只差构建清单。

Stage3D 的窗口合成层**已三端统一**：条件由 `ASC_RENDER_METAL` 扩成
`ASC_RENDER_METAL || ASC_RENDER_D3D`（**不含** `ASC_RENDER_GPU`，后者的 `ASC_stage3d_tex` 是 CPU 像素缓冲，
走同处的 `#elif` 支）。两臂传的句柄不同：Metal 侧是 `MTLTexture`，D3D 侧是 `ID3D12Resource*`，
由 `sk_gpu_draw_texture` 按各自后端的宏分别解。

### 3.4 Stage3D 在 Windows 上：D3D12 后端（阶段一百三十二 落地）

描述符或源码用到 `flash.display3D` 时，Windows 目标现在**真的链接 D3D12 后端**，不再是一个 `AirAppError`：

- **构建期接线**（`src/air-app.ts`）：`sources` 推入 `vendor/stage3d_d3d.cc`；`defines` 加
  `ASC_S3D_HLSL=1`（选中阶段一百三十一 的 HLSL 档 `target 2`）与 `ASC_RENDER_STAGE3D=1`
  （`<depthAndStencil>true</depthAndStencil>` 时再加 `ASC_RENDER_DEPTH_STENCIL=1`）；`linkLibs` 加
  `d3d12`/`dxgi`/`d3dcompiler`（后者是 `D3DCompile` = fxc 的入口，必须是运行期整份 DLL，不是 .lib 里的 stub）。
  **不**推 `stage3d_glue.mm`、**不**加 `Metal`/`Foundation`。原先那条「Windows 上拒绝」的 `throw` 已删。
- **与 2D 共用设备/队列**（这是「合成能看见 3D」的前提）：`vendor/d3d_glue.cc` 以
  `__declspec(dllexport)` 导出 `sk_d3d_shared_device()` / `sk_d3d_shared_queue()`；`stage3d_d3d.cc` 在
  主模块上 `GetProcAddress` **按名**取（不硬链——只有 Stage3D 的构建可以不包含窗口 glue，硬链会变成未解析符号）。
  取不到就退化为自建 `ID3D12Device` + 队列，并**响亮警告**「像素不会到达窗口」（不静默出黑屏）。
- **同一条队列 ⇒ 无需 CPU 等待**：Stage3D 提交的批与 Skia 的 `sk_gpu_flush` 在同一 `ID3D12CommandQueue`
  上按提交序执行，故帧边界的 `s3d_flush_async` 只需 `Close()`+`ExecuteCommandLists()`（commit），
  **不** `wait` fence。与 Metal 侧 `stage3d_glue.mm` 的口径逐条一致（§9.8/§9.9 of `display3d.md`）。
- **验收证据**（见 §5 的新增行）：`examples/shmup-stage3d` 在本机跑到 **281 帧 / 5 s**（~56 fps），
  3600+ 次 draw 零错误，且 `ASC_GPU_DUMP` 导出的 **presented back buffer** 里能读到 demo 的 Stage3D 精灵。
- **`examples/air-starling-demo` 已实机跑通**（阶段一百七十三，127 源文件 + 完整 Starling）：开窗、资源加载
  完成、**26 个 draw / 246 个三角形**（12×9 九宫格 + 12 条标签 + 背景/logo/`infoText`，几何一个不少）全部就位。
  其间修掉一个**结构性**缺陷：**常量缓冲原先每帧槽只有一份**，而 D3D12 在 GPU **执行**命令列表时才读常量
  ⇒ 该帧**所有** draw 都读到**最后一次**上传的 mvp（实测 12 个按钮全被最后一个按钮的矩阵变换）；Metal 用
  `setVertexBytes` 内联拷贝、天生免疫 —— 这正是「只有 Windows 坏」的原因。改为**按 draw 版本化的常量区域**
  （`S3D_CB_REGION` 4096 B/次上传、游标在 `s3d_batch_end` 归零、`s3d_wait_slot` 留在 `s3d_upload_constants`
  里）—— 细节与三条实测定案见 `docs/zh-cn/display3d.md` §10.1。
- **与 `adl 51.4.1` 逐项对照**（同机、同 150% 缩放；adl 侧 `temp/win_shot.ps1` 抓窗口客户区，我们侧
  `ASC_GPU_DUMP` 的 presented 后缓冲）：logo 红像素包围盒在**客户端坐标下同为 `x32..173 y10..196`**、
  按钮节距同为 **69 px**（= 46 pt × 1.5）、两列按钮的行/列偏移与 12 条标签逐一对应。
- **未验收**：背面剔除与绕序仍是纸面决定（`FrontCounterClockwise=FALSE` + 正高度 viewport、不做 Y 翻转），
  无剔除对照实测；`Context3D.drawTriangles` 的 `firstIndex` 目前**被忽略**（`(void)firstIndex;`，索引缓冲整段
  上传）—— 对 Starling（恒 `drawTriangles(ib, 0, n)`）无影响，对别的 Stage3D 应用是潜在偏离（已入遗留表）。

### 3.5 显示度量：**逻辑点 vs 物理像素**（阶段一百七十三）

AIR 在同一次运行里混用两套显示空间，**两套都要是它那一套**（同机 `adl 51.4.1` / 3840×2560 桌面 / 150% 缩放实测）：

| 量 | `adl` 报的值 | 空间 |
|---|---|---|
| `Stage.fullScreenWidth`/`Height` | 2560×1707 | **逻辑点（DIP）** |
| `Capabilities.screenResolutionX`/`Y` | 2560×1707 | **逻辑点（DIP）** |
| `flash.display.Screen.mainScreen.bounds` | 3840×2560（`visibleBounds` 3840×2488） | **物理像素** |
| `Capabilities.screenDPI` | 96 | 平台基线（**不是**面板 DPI：SDL 同机报 144） |
| `Stage.contentsScaleFactor` | 1.5 | 窗口物理/逻辑比 |

我们原先用 `SDL_GetCurrentDisplayMode` 回答 `fullScreen*` —— 那是**物理**模式（3840×2560）⇒ 依赖
`fullScreenWidth` 定 viewport 的 Stage3D 应用（`air-starling-demo` 的 Starling 投影）拿到的舞台坐标系是
adl 的 1.5 倍。修法是**换查询**而不是乘除：`SDL_GetDisplayBounds`（在 `SDL_HINT_WINDOWS_DPI_SCALING` 下）
返回的就是逻辑点空间，与 `adl` **逐值相同**；`Screen.bounds` 那条路（`sk_display_bounds`）**刻意保持原样**，
它与窗口居中同在 SDL 逻辑空间，改成物理会同时打坏居中。

`Capabilities.screenDPI` 同理是**常量基线**而非读取：Windows 96、其余平台 72（macOS 也是 72）。回答真实
面板 DPI（144）会在**每一台** HiDPI 桌面上静默偏离。**残留偏离**：`Screen.bounds`/`visibleBounds` 按 AIR
应是物理像素而我们仍报逻辑值（`sk_display_pixel_bounds` 未实装），已在 `TODO.md` 的 `遗留待开发` 登记。

### 3.6 Stage3D 资源的**延迟释放**必须绑到**下一次提交**（阶段一百七十四）

D3D12 的释放队列里，**释放时机本身就是正确性的一部分**：`fence` 已经 signal 只说明**那一次提交完成了**，
与「这个资源是否还被人读」无关。原实现在 `s3d_defer_release` 里一律记 `c->fenceNext`（**最后一次已 signal** 的
值）；若资源是在**批次还在录制**时被销毁（`c->listOpen == 1`），它**已经被该批次更早的 draw 绑进了命令列表**，
而那次提交**尚未发生** ⇒ 资源在 GPU 读它之前就被释放，显存被 D3D12 立刻交给**下一张纹理**。实测（临时
`ASC_S3D_LIFE` 埋点，`examples/air-starling-demo` 切场景）：**171 次释放里 171 次都发生在 `listOpen=1`**，典型
一行 `defer 1B242EB0 fence=31` → `RELEASE 1B242EB0 rel_fence=31 done=32 next=32 listOpen=1`（记录时**已完成**）。

这是一个根因、**两个症状**：① 画面错乱 —— 旧描述符采到**别人的像素**（TextScene 的 `colorTF` 方框里画出放大的
"Back"，背景与返回按钮消失）；② `DXGI_ERROR_DEVICE_REMOVED` —— 通过 SRV **仍在采样**一个已销毁的资源，
`Present` 报 `0x887a0005`（`vendor/d3d_glue.cc`；Stage3D 经 `sk_d3d_shared_device()` **借用**同一个 `ID3D12Device`，
所以 Stage3D 侧的非法操作由合成层的 `Present` 报出来）。

修法（三处，缺一条就复现）：

1. `s3d_defer_release` 在**批次打开时把条目停在 fence 0**（`c->listOpen ? 0 : c->fenceNext`）—— 0 的含义是
   「挂到**下一次**提交上」。
2. 两处 drain（`s3d_defer_release` 的有界回收 + `s3d_drain_releases`）都跳 `fence == 0` 的条目，且**保留**它们
   （不是丢弃，否则等于提前释放）。
3. `s3d_batch_end` 在 `Signal` 之后把本批所有停在 0 的条目**盖上本次提交的 fence 值**。

**验收**：清掉全部埋点后重建，从菜单点进 12 个场景、每个再退回菜单，**连做 3 轮（36 次切换）零 `Present`
失败、零 `0x887A0005`**；TextScene 的渲染目标 dump 与 `ASC_GPU_DUMP` 的窗口 dump 均与同机 `adl 51.4.1` 对照一致。
埋点期对照：修前 `RELEASE ... listOpen=1` 计 **171/171**，修后 **156 次释放全部 `listOpen=0` 且 `rel_fence == done`**。

---

### 3.7 音频后端：**WASAPI**（阶段一百七十六）



音频后端（`vendor/audio_glue.c`，miniaudio）**与渲染后端无关**，是**同一个翻译单元覆盖所有桌面 OS**：

`as_audio_pick_backends()` 对 `_WIN32` 给 `wasapi, dsound, winmm`（按序回退）、Apple 给 `coreaudio`。

Windows 侧**额外的链接项是零**：三个后端全走 `LoadLibrary/GetProcAddress`（ole32 / dsound / winmm / avrt），

实测该文件在本机编译出的对象**除 kernel32 与 CRT 外没有任何未定义导入**。



阶段一百七十六 之前 Windows 上「没声音」**不是**缺后端，而是 `src/air-app.ts` 的构建层把后端 gate 掉了

（闸门写死 darwin）+ 无条件往 `frameworks` 塞 `CoreAudio`/`AudioToolbox`（`-framework` 在 Windows 上不是 clang

参数）：前者让接缝退回「无声卡」桩并打一条我们的警告，后者即使放开前者也会让链接失败。现在 Windows 的清单是

**源 + define 两项**，`frameworks` **必须为空**。逐层取证（后端名 / 环回录制 / demo 帧音效 / 负对照）与手工清单

写法见 [`audio.md`](audio.md) **§15**。

---

### 3.8 窗口拖动「一顿一顿」：flip 交换链的 acquire 停顿（阶段一百七十七）

**症状**：拖动 AOT 产物窗口的标题栏挪位置，窗口按 ~15 Hz 一格一格地跳；同一份程序在 `adl` 下顺滑。

**测量口径**：真按下的拖动（`SendInput` 移到标题栏、按下、按像素移动、抬起），逐次 `GetWindowRect`，
只记录变化、算变化间隔的分位数。harness 在 `temp/dragtrace/`（`dragtrace2.exe` + `run2.cjs`）。
程序 stdout/stderr **必须落文件**：拖动期间 `run2.cjs` 的主线程卡在 `spawnSync`，管道读端不被消费，
写端一阻塞就会让「app 还在出帧」被误读成「app 冻结」（这个坑踩过一次，结论已改写）。

| 目标 | 位置变化次数 | 间隔 p50 | >20 ms 的次数 | 拖动期 CPU |
|---|---|---|---|---|
| 纯 Win32 控件窗（`dumbwin.exe`） | 1745 | 1.8 ms | 0 | 1–6% |
| 同一 glue 的 **CPU 软渲染** SDL 窗（`win_cpu.exe`） | 1462 | 3.0 ms | 1 | — |
| `adl`（AIR 参考实现，同一程序） | 1174 | 3.0 ms | 0 | 13% |
| **AOT demo（D3D12 flip，`SK_D3D_NUM_FRAMES 2`）** | 87–120 | **66.4–66.6 ms** | **58–88** | 1–3% |

**逐层取证（每一步都否掉一个假设）**：

1. 不是「app 被模态移动循环饿死」：拖动期间 app **仍在出帧**（`live_resize_watch` 被 WM_PAINT/MOVED 触发
   30 次/秒、每次 ~33 ms），`SendMessage(WM_NULL)` 到窗口线程的延迟 1.2 ms ⇒ 线程既不忙死也不冻结。
2. 不是 `Present` 的 vsync 等待：把 `Present(1,0)` 换成 `Present(0,0)`，每次 redraw 仍是 33.3 ms。
3. 在 `vendor/d3d_glue.cc` 里分相计时（fence acquire / flush / submit / present / signal）才定位到：拖动期间
   **`sk_gpu_begin_frame` 的 fence acquire 等待 = 470 ms / 500 ms（≈31 ms/帧）**，而 flush 1.0 ms、submit 1.7 ms、
   present 2.6 ms 全部可忽略；同一段 redraw 空闲时只要 **0.37 ms**。
4. 机理：`BufferCount=2` 时，DXGI 的呈现队列在窗口被合成器搬动期间会**同时扣住两个 back buffer**，
   于是拿不到可写缓冲，acquire 干等**两个 vblank（33.3 ms）**。而我们的帧恰好可以跑在 **OS 模态移动循环的
   dispatch 里**（`live_resize_watch -> sk_pump_frame`），这 33 ms 就是移动循环拿不到的时间 ⇒ 窗口「一帧一格」；
   `MOVED` 与 `EXPOSED` 各触发一次时正好翻倍成 66.6 ms（= 4 个 vblank）。

**修复**：`vendor/d3d_glue.cc` 的 `SK_D3D_NUM_FRAMES` **2 → 3**（多留一个空闲 back buffer）。实测 acquire 等待
31 ms → **0.0 ms**，拖动间隔 p50 66.5 ms → **3.1–4.4 ms**（max 14 ms，>20 ms 零次），拖动期间 app 照常出帧
（CPU 9–17%），与 `adl` 同级。代价：多一个 back buffer（480×870 约 1.7 MB）与约一帧的额外延迟。

**归属**：只改 `d3d_glue.cc`（Windows 专属文件）⇒ Metal / WASM 路径按构造不受影响；`window_glue.cc` 的
live-resize watch 语义**一行未动**（拖动期间动画照常）。对照实验证明 **flip 模型本身不是问题**：
`temp/dragtrace/gputest.cc`（纯 Win32 + D3D12 flip、2 缓冲、每帧 clear+Present）拖动 p50 = **4.9 ms**，
同程序走 D3D11 bitblt 是 4.5 ms ⇒ 只有「2 缓冲 **且** 帧在模态循环里跑」这个组合才会卡。
### 3.9 拖右下角缩放**挂死**：`ResizeBuffers` 打乱了 fence 账本（阶段一百七十七·一）

**症状**：用户报「右下角拉窗口 resize 直接崩溃」。实测**不是崩溃，是永久挂起** —— 窗口停在某个中间尺寸，
`SendMessage(WM_NULL)` 3–5 s 不应答、`IsHungAppWindow=1`、标题仍可读，且**1 s 内 CPU 0%** ⇒ 阻塞在一个
**等不到的等待**上（不是自旋、也不是访问违例崩溃）；尺寸只推进 3 步（约 93 ms）就冻在 526×950。

**口径**（`temp/dragtrace/resizetrace.c` + `runresize.cjs` 单跑 + `rzloop.cjs` 连跑）：真 `SendInput` 按
`HTBOTTOMRIGHT`（用 `WM_NCHITTEST` 命中判据；**不用 `SetCursorPos`** —— 它绕开输入队列、不进模态缩放循环，
同 §3.8 的拖动 harness），逐像素外拖、每步记窗口尺寸；拖后投 `WM_NULL` 量应答时间、查 `IsHungAppWindow`、
量 1 s 内的进程 CPU 时间差，并用 `OpenProcess(SYNCHRONIZE)` 判存活。**对照**：`dumbwin.exe` 的
`WM_NCLBUTTONDOWN` 路径拿不到 `hwndCapture`（**不能**当缩放对照），可用的是 `gputest.exe`（纯 Win32 + D3D12
flip）与 `adl`（两者缩放都顺滑）。

**根因**：`d3d_glue.cc` 的 fence 账本被打乱。`fence_values[i]` 是「第 i 个 back buffer 上最后一次提交的序号」，
`sk_gpu_begin_frame` 的读取期等待就是「等这个值被达到」。而 `begin_frame` 是**先**
`current = w->fence_values[w->buffer_index]`（拿**旧**槽的值当计数器）、**再**用 `GetCurrentBackBufferIndex()`
覆盖 `buffer_index`。修前我们在 `ResizeBuffers` 之后多写了一句

```c
w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();
```

于是这一句把「计数器的来源槽」提前指到**重建后恰好落在的那个** back buffer（不是刚 Present 的那个），可能是
**更旧**的槽 ⇒ `fence_values[新] = current + 1` 算出一个 **fence 早已越过的值**。fence **永不后退**，
`Signal()` 一个已越过的值时是**空操作**：那个 buffer 就此**丢掉「GPU 已经不用我了」这块牌子**，而**下一次**
resize 的排水（要等**每一个**槽）就会停在一个**再也不会被达到**的值上 —— `WaitForSingleObjectEx(…, INFINITE)`
永不返回。它的**间歇性**正来自「索引恰好落在哪个槽」。

**量化**：`ASC_RZ_TRACE=1` 的台账（`rz[<seq>] FLUSH signalled V=… completed=…`）修前 1 次拖动 72 个尺寸变化里
**34 次** signal 是空操作（`V ≤ 已 completed`），另一个进程在第 2 次 resize 就挂死；修后 4 次拖动共
**298 个尺寸变化、0 次**（`fix1..fix4` 全绿）。

**为什么 `SK_D3D_NUM_FRAMES 2 → 3`（§3.8）之后才炸**（**推断**，未做单变量 A/B）：2 缓冲时 acquire 的 ~31 ms
等待本身就在**当节流阀** —— 每个 watch 事件只出一帧、帧间还隔两个 vblank，`ResizeBuffers` 几乎不会与「在飞的帧」
重叠；多留一个空闲 buffer 后帧真的跑起来了，这条潜伏已久的账本错才第一次咬人。

**修复**（`vendor/d3d_glue.cc`，三处）：

1. **删掉** resize 分支里的 `w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();` —— 下一次
   `begin_frame` 本来就会读它，提前读破坏了「每次赋的值严格大于此前所有已 signal 的值」这条不变式（那是每个等待
   可达的前提）。Skia 自己的参考实现
   （`build-tools/skia-src/tools/window/win/D3D12WindowContext_win.cpp` 的 `resize()`）**同样不在 resize 里重读索引**。
2. 排水**加界**：新增 `#define SK_D3D_DRAIN_MS 250`，resize 前「等每个槽的 GPU 释放」逐槽最多等 250 ms
   （原来是无界 `INFINITE`）。resize 期间 `Present`/队列确实可能停住（fence 就冻结在 `completed=10576`、
   而 10577 已入队）⇒ 修完账本仍需一个界，否则一次合成器迟滞就会让主线程永久卡在 resize 里。
3. 超界时**什么都不释放**：`drained = 0` ⇒ 只打**一次**诚实的 stderr 说明，然后 `return nullptr` **跳过这一帧**
   （交换链与所有 surface 一个不动，下一帧重试）；`surfaces[i]`/`buffers[i]` 的释放挪到**排水成功之后**的独立循环。

**验收**（Windows 实机 x64，干净重编）：3/3 次真右下角拖动（502×926 → 2101×2497、70 次尺寸变化）**全部存活**、
拖后 `WM_NULL` 7.7–11.3 ms 应答、`IsHungAppWindow=0`、退出码 0。**未回归**：同一条 6 s 真标题栏拖动
p50 **3.0 ms** / p95 4.6 / p99 4.9 / max 8.9 / **>20 ms 零次**、跟住光标 1799/1800 px ⇒ §3.8 的拖动修复完好。
缩放后画面与 `adl` 结构一致（固定尺寸的 stage 之外留白）：`temp/dragtrace/after_resize.png` 对 `adl_after_resize.png`。

**归属**：只改 `d3d_glue.cc`（Windows 专属文件）⇒ Metal / WASM 路径按构造不受影响；`window_glue.cc`
的 live-resize watch **一行未改**（拖动/缩放期间动画照常）。

### 3.10 顶点/索引上传的**逐次重建**是 Windows 帧成本的大头（阶段一百七十九）

**症状**：`examples/air-starling-demo` 的性能基准（`BenchmarkScene`）在 Windows 上只走到 **6.1w 对象**，而在 macOS
的记录是 **12w**。该基准每帧都在长对象（`addTestObjects(16)`），到 **6.6w** 对象时帧时间从 0.2 ms 跳到 **~17 ms**，
恰好吃掉整个 16.67 ms 预算 ⇒ 收敛判据（`measuredFps < 0.985 × 60`）连续失败 100 次 ⇒ 平台期停在 6.6–6.8w。

**口径**：`temp/benchperf/runbench.cjs`（`bench-auto` 直接进 `BenchmarkScene`；`System.output` 的 `BENCH` 记录**没有
换行**，峰值只能按 `/obj=(\d+)/g` 从整条日志取）+ `ASC_VB_PROBE` 埋点（已回退）+ `ASC_FRAME_STATS=1`。
证据：**静态帧**（同 6.58w 对象、不加对象）`tick p50 = 0.203 ms` / `present 0.431 ms` / `period 16.894` / `fps 59.2`；
**变更帧**（每帧加 16 个对象）`tick p50 = 15.6 → 17.2 ms`。这 17 ms **不是 GC**（`FRAME` 埋点 `gcmax=0.00 gcavg=0.00`），
**也不是显示列表 API**（微探针 `temp/benchhot/addcost.as`：6 万个 Sprite 的 `addChild` 合计 287 ms，属性写入 2–9 ns）
—— 成本在 Starling 的 quad-batch 重建 **加上我们的顶点上传**这条路上。

**根因**：`vendor/stage3d_d3d.cc` 的 `s3d_make_upload` **每调用一次就建一个新的 committed 资源**
（`CreateCommittedResource` + `Map` + `memcpy` + `Unmap`，旧 buffer 走延迟释放）。实测固定开销 **~100 µs/次且与尺寸无关**
（启动期 64 次 0.5 KiB 上传 = 7.55 ms）；到 6.6w 对象时 **每帧 20–27 次上传、4–5 MB、`make_ms` 4.4–6.5 ms**（≥ 1/3 个
帧），而标量转换循环本身只有 ~0.16 ms/帧（`-O2` 已向量化）。Metal 从不为这条路付钱 —— 它的上传是往**常驻** buffer 里
`replaceRegion`。

**修法**（`vendor/stage3d_d3d.cc`，上传堆池）：

1. `s3d_ubuf_new` 建**永久映射**（UPLOAD 堆允许）的 committed buffer，容量取 2 的幂、下限 4 KiB；池上限
   `S3D_UBUF_MAX = 1024`，满了**响亮报明**，绝不静默丢掉一个上传。
2. `s3d_acquire_upload` 取**能装下的最小空闲条目**：候选须 `pending == 0`、`fence == 0 || fence <= GetCompletedValue()`、
   且**当前没有被绑到任何 stream 或索引级**（`s3d_ubuf_bound`）；没有候选才新建；池满时先 `s3d_wait_idle` 再淘汰一个
   装不下的小条目 ⇒ 池**有界且自清理**（否则容量涨过一档之后会一直占着死容量）。
3. `s3d_upload_vertex` **直接往 `b->map` 转换**（去掉每次的 `malloc` + `memcpy`），`s3d_upload_index` 直接 memcpy 进去。
4. 「这块 buffer 可以再用了」**永远由提交时打的 fence**（`s3d_stamp_uploads`）判定，而不是纯 CPU 记账 —— GPU 可能还在读
   的内容绝不覆盖。批仍在录制时被**替换**掉的 buffer 会重新标回 `pending`（`s3d_mark_batch_ref`），因为打开中的批次已经
   拿着它的 GPU 虚拟地址了。
5. `s3d_destroy` 改成释放池；stream/index 的 buffer 是**借来的**，在那里再 Release 会双释放。

**踩坑（单独记一条）**：`s3d_stamp_uploads` 必须在**批次打开时直接返回**。第一版没有这条守卫 —— 纹理上传走的
immediate list 在批还在录制时把 `pending` 全清了，于是第一帧里 12 个按钮的顶点上传**全落进了同一个 buffer**，
菜单 **11 个按钮永久消失**（Starling 不会重传未变更的 QuadBatch，所以坏 buffer 会活到整个进程结束：
`ASC_GPU_DUMP` 在帧 60 与帧 300 导出的图**逐位相同**）。**渲染回归比性能回归隐蔽得多** —— 当时基准数字很好看
（150,992）。修法一行：`if (c->listOpen) return;`（批没提交就**没有**任何 fence 值能证明 GPU 已经不用它了）。

**验收**（Windows 实机 x64，干净重编）：

- 峰值 **67,728 → 147,488 对象（2.18×）**（无守卫版 150,992，守卫的保守代价 ~2%）。
- **画面**：`temp/verify_tour.cjs` 跑完 **13 个场景**（`temp/verify_ub/`）—— 静态菜单与修前**逐位相同**（差异像素 **0**），
  其余场景的差异全落在动画区与底部 `Fps` 文本上（Sprite3D 3.85% = 旋转的立方体，Masks 1.14% = 旋转的遮罩，
  Textures/Animations/TextFields 各 0.042% = 同一小块动态文字）；日志 38 行、error-ish **0**。
- 全量 `node test.ts`：**tests 349 / pass 323 / fail 23**，与基线逐项相同（`stage3d/flush-policy` 修前修后**同红**，
  属既有失败，非本条引入）。
- 单元钉：`stage3d/d3d-glue` 新增 9 条（池的每条不变式 + 「批打开时不许 stamp」+ 文档口径），`28 → 37` 条；
  **9 个变异 9/9 全被抓**（去掉 stamp 守卫 / 去掉 fence 可用性判据 / `pending` 反过来写 / 直写 `b->map` 改成偏移 /
  `memcpy` 长度改掉 / `s3d_ubuf_bound` 恒真 / 池释放循环不跑 / 饱和文案改名 / 文档数字改掉）。

**对照与排除**：

- 同一台机器、同一个 demo 走 `adl 51.4.1` 只到 **16,610–16,896 对象** ⇒ 我们的 Windows AOT 修前就已快它约 **4×**，
  「Windows AOT 慢」不成立。
- `ASC_FORCE_REFRESH=30`（33.3 ms 预算）平台期 **148,384 = 2.19×** ⇒ 停止点随帧预算**线性**变化，不是吞吐天花板；
  修复后的 147,488 已把这条「预算×2 才拿得到的名次」在 16.67 ms 预算内拿到。
- **「显示驱动 `4090d`」不是我们打的**：`driverInfo` 是编译期占位 `Direct3D12 (Stage3D)`，exe / 生成的 C / `Demo-app.xml`
  里 `4090|RTX|GeForce` **0 命中**；那行字来自 `adl` 那次运行或某个系统工具。

**观察（未修，不入遗留表）**：默认 pacer 落在 **16.947 ms（59.0 fps）**（`SDL_GetTicks` 的整毫秒 + `SDL_Delay` 过冲，
每帧晚 ~0.28 ms）；QPC + 混合睡眠的精确 pacer 能回到 16.667 ms / 60.0 fps，但**不改变平台期**（67,488）⇒ 是独立的精度
问题，不是本条的成因。`adl` 的帧间隔本机**未测**，故不按 §1.5 的硬判据记欠账。

**归属**：只改 `vendor/stage3d_d3d.cc`（**只在** Windows/D3D12 构建里编译）⇒ Metal / WASM 按构造不受影响。

### 3.11 `Capabilities.language` / `languages`：来源是**系统 UI 语言**，且 `language` 是**闭集**（阶段一百八十七）

**症状**：真应用整站英文 —— 应用侧判断 `Capabilities.language == "zh-CN"` 不成立。

**根因**：`as_cap_language()` 的 Windows 分支只读进程环境变量 `LANG`/`LC_ALL`。Windows 上它平时没设
（资源管理器启动），从 git-bash 启动时又恰好是 `en_US.UTF-8` ⇒ 恒 `"en"`；而 `adl 51.4.1` 在同一台机器上
返回 `zh-CN`。

**`adl` 实测（三态实验，机器状态：区域格式 `zh-CN`、显示语言 `en-US`）**

| 机器改动 | `GetUserDefaultLocaleName` | `adl` `language` / `languages` |
|---|---|---|
| — | `zh-CN` | `zh-CN` / `["zh-CN","en-US"]` |
| `Set-Culture de-DE` | `de-DE` | 仍 `zh-CN` / `["zh-CN","en-US"]` |
| `Set-WinUserLanguageList de-DE,zh-Hans-CN,en-US` | `zh-CN` | 仍 `zh-CN` / `["zh-CN","en-US"]` |

⇒ 既不是用户区域、也不是注册表语言表，而是**生效的 UI 语言**；与参考文档一致（Windows：「returns the user
interface (UI) language…used for all menus, dialog boxes, error messages, and help files」）。

**口径**：`language` 是**闭集** —— 小写 ISO 639-1 两字母码，**只有中文**追加 ISO 3166 地区（`zh-CN`/`zh-TW`），
表外一律 `"xu"`；`languages` 是 RFC 4646 标签、**保留地区**、按偏好降序；两者只在**主语言**上一致
（"generally has the same primary language ID"，**不是相等**：en-US 机器上 `language=="en"` 而
`languages[0]=="en-US"`）。

**双端来源**

| 目标 | `language` | `languages` |
|---|---|---|
| macOS | `CFLocaleCopyCurrent()` 归一化 | 同源 |
| Windows | `GetUserDefaultUILanguage()` → `MAKELCID` → `LOCALE_SISO639LANGNAME` + `LOCALE_SISO3166CTRYNAME` | `GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, …)` |
| 其他 POSIX | 进程 `LANG`/`LC_ALL`（**最后的兜底**） | 同源 |

标签拿到后一律过 `as_cap_language_from_tag()`：中文按地区分 CN/TW（`zh-HK`/`zh-MO` 归 TW），其余查 AIR 表
（`as_cap_air_langs[]`，逐项抄写）命中取码、不中 `"xu"`；`languages` 的各项走 `as_cap_lang_normalize()`
（保留「语言-地区」形态）。探针/断言见 `unit: platform/CapabilitiesLocale`（30 条：行为表由**切片真实源码**
编译驱动 ⇒ 任何宿主都跑，宿主真值只在 darwin 跑）与 `examples/capabilities.as`。

### 3.12 `Capabilities.os`：**家族名 + 版本**，裸家族名让下游字段与设备指纹一起静默（阶段一百八十九）

**症状**：扩展侧一条 Windows 门禁 `Capabilities.os.search('Windows') > -1` 恒 `false`，该扩展在 AOT 下不可用，
而同一台机器上 `adl` 里为 `true`。（该门禁原先读 `manufacturer` —— 那是本项目的**有意偏差** `"AS-AOT"`，
见 `TODO.md` 的 `manufacturer` 行；应用侧改读 `os` 之后才暴露出这里。）

**根因**：`as_cap_os()` 的 Windows 分支只返回裸家族名 `"Windows"`，而 AIR 返回 **`"Windows 11"`**。
差别不止于门禁：应用会**从字符串里取版本** —— 设备信息字段取 `Capabilities.os.split(" ")[1]`
（裸名下恒 `undefined`），并把整串哈希进**设备指纹**（字符串一变，指纹就变）。

**`adl 51.4.1` 与本机实测（Windows 11，build 26200）**

| `Capabilities.*` | AOT（改前） | AOT（改后） | `adl 51.4.1` |
|---|---|---|---|
| `os` | `Windows` | **`Windows 11`** | `Windows 11` |
| `manufacturer` | `AS-AOT` | `AS-AOT`（有意偏差） | `Adobe Windows` |
| `version` | `WIN 50,0,0,0` | `WIN 50,0,0,0` | `WIN 51,4,1,1` |

门禁表达式在 AOT 产物上实测（括号内为 `adl`）：`os.search('Windows') > -1` = **true**（true）、
`os.search('Android') > -1` = `false`（false）、`os.indexOf('Windows') == 0` = **true**（true，Starling 用这条）。

**名字表是从 AIR 自己的二进制里量出来的**，不是猜的
（`runtimes/air/win64/Adobe AIR/Versions/1.0/Adobe AIR.dll`）：一张 22 项的表（`Windows 95` … `Windows 11 Server`，
默认回落 `"Windows"`），由 `VerifyVersionInfoW` + `VER_EQUAL` 逐版本**精确**比对产出。三条关键口径：

1. **Windows 11 不是新主版本**，而是 `10.0` 上叠加 `build >= 22000`（`0x55F0`）的**提升** ——
   `VerifyVersionInfoW(11,0)` 永不命中，由构建号决定；
2. 服务器 SKU 只由 `wProductType != VER_NT_WORKSTATION` 区分（`Windows 11` vs `Windows 11 Server`）；
3. `5.2` 内再靠 `SM_SERVERR2`(89) 与 `VER_SUITE_WH_SERVER`(0x8000) 分出 `Windows Server 2003 R2` /
   `Windows Home Server` / `Windows XP 64`。

**版本来源换成 `ntdll!RtlGetVersion`（本阶段唯一有意偏离 AIR 的实现处）** —— 实测口径（本机、**无清单**的原生
可执行文件，正是我们产物的形态）：

| 查询 | 结果 |
|---|---|
| `VerifyVersionInfoW(==10.0)` | `0`（`GetLastError = 1150` `ERROR_OLD_WIN_VERSION`） |
| `GetVersionExW` | `6.2 build 9200` ← **清单版本谎报** |
| `ntdll!RtlGetVersion` | `10.0 build 26200`（真值） |

⇒ AIR 依赖**自己 `app.xml` 的清单**才拿到真值；照抄它的查询会把 Windows 11 报成 **Windows 8**。
`GetSystemMetrics(89)` 与 `RtlGetVersion` **都经 `GetProcAddress` 动态解析**：该助手编入**每一个**构建，
而 headless 构建**不链接 user32**，静态引用会直接链接失败（`undefined symbol: GetSystemMetrics`）。

**未对齐（如实报明）**：macOS / Linux / WASI 仍是裸家族名（`"Mac OS"` / `"Linux"` / `"WASI"`）。AIR 在那里
同样带版本，但本机是 Windows，没有可核对的 Darwin/Linux「版本→名字」表，故**不臆造**；缺口写在代码注释里，
而不是猜一个值填上。

钉子：`unit: platform/CapabilitiesOs`（18 个可返回名齐备 / `build >= 22000` 提升 / `wProductType` 分流 /
**不含 user32 静态依赖** / 理由留档）+ `examples/stage65.as`（Windows 上断言 `os` 能 `split(" ")` 出非空版本号，
macOS 自动跳过）。

## 4. 运行形态（D3D12 直连）

`vendor/d3d_glue.cc` 与 `vendor/metal_glue.mm` **结构同形**（一帧的目标是一次性资源，只有 begin/draw/present
循环），差别只在「一次性资源」是什么：

- **进程级**（首次 GPU 窗口时建、最后一个窗口关时拆）：`IDXGIAdapter1`（枚举 + `D3D12CreateDevice` 探针选
  硬件适配器）→ `ID3D12Device` → `ID3D12CommandQueue(DIRECT)` → `GrDirectContext::MakeDirect3D`。
  `GrD3DBackendContext::fMemoryAllocator` **留空**（Skia 自建 AMD 分配器；与 Skia 自带参考一致）。
- **窗口级**（`sk_gpu_init`）：`CreateSwapChainForHwnd`（`FLIP_DISCARD` + `R8G8B8A8_UNORM`）→ 两条 back buffer
  各包成 `GrBackendRenderTarget`/`SkSurface` → `ID3D12Fence` 帧同步。
- **每帧**：`sk_gpu_begin_frame(w,h)` 处理尺寸变化（`ResizeBuffers`）与 back buffer 等待；
  `sk_gpu_flush` 先 `flush(kPresent)` **再** `submit` **再** `Present(1,0)`，然后 `Signal` 该帧的 fence 值。
  **两半都不能省**——只 flush 不 submit 会上屏**旧** back buffer。

`sk_gpu_draw_texture`（Stage3D 合成用）**已实现**：把 Stage3D 的离屏渲染目标包成
`GrBackendTexture` → `SkImages::BorrowTextureFrom` → `SkCanvas::drawImageRect`（dst-only 重载 +
`SkSamplingOptions(kLinear,kNone)`，因为 HiDPI 下源是设备尺寸而目标是逻辑尺寸）。目标必须是 `R8G8B8A8`/`BGRA8`
且非多重采样，否则**响亮拒绝**（`unsupported render target (dxgi format %d, %u samples); nothing was drawn`，只打一次）。
包装时必须 `retain()` 而不是走裸指针构造器——**这是本项目踩过的最深的一个 Skia D3D 陷阱，单独记在 §2.9**。

---

## 5. Windows 首跑核对清单（**未验证假设**逐条）

在 Windows x64 机器上，按顺序做：

1. `pwsh vendor/build-windows-deps.ps1 -Arch x64`（可再跑 `-Arch x86`）。**核对**：ps1 在真实
   PowerShell 下的 `SetEnv.cmd` 探测、`Invoke-CmakeBuild` 的 `-Arch` 传递、以及 `Assert-LibBitness`
   不误报（macOS 侧只做到「便携 pwsh 解析 AST 通过 + `gn format` 通过 + 补丁对真实源命中且幂等」）。
2. 编一个 `<renderMode>direct</renderMode>` 的 `--air-app` 项目。**核对**：链接期不再出现
   `m.lib`/`z.lib`/`objc`/`framework`，四个 `lib*` 归档名以 `-llibpng` 形态解析成功。
3. 首跑看 **stderr**：`d3d_glue:` 前缀的文案区分了失败点（`CreateDXGIFactory1` / 无可用适配器 /
   `D3D12CreateDevice` / `CreateCommandQueue` / `MakeDirect3D` / `CreateSwapChainForHwnd` /
   `WrapBackendRenderTarget`）。黑窗而无声 = 渲染成功但没画内容，应查 AS3 侧。
4. **手动复验拖动/缩放与高清**（这两条只能人工看，见 §2.8）：
   - 拖主窗的标题栏、拉右下角缩放：动画应**继续**（既不冻住、也不变快），`Fps` 计数条应稳在
     `Stage.frameRate` 附近；点红块开第二个 NativeWindow 后，拖主窗时**第二扇窗照常动**。
   - 在 150% 缩放的屏上：`d3d_glue:` 应打**物理**像素（本机 `1500x1020`），而 `trace(stageWidth,
     stageHeight)` 仍打**逻辑**尺寸（`1000 680`）；用 `standard` 构建（`<requestedDisplayResolution>
     standard</requestedDisplayResolution>`）时两者应**相等**且进程保持 DPI-unaware（画面被 OS 放大，
     这是 AIR 对该档的定义）。

**逐条核对结果**（2026-10-10 实机 x86+`direct` 跑通：编译 1–3、链接 10–12、运行 4/9/11 均已确认；
5–8 已开窗无错、但「撕裂/帧率/退出」需肉眼复验；**阶段一百三十二 补 13/14 已确认、15 未验收**）：

| # | 假设 | 出错时的症状 |
|---|---|---|
| 1 | ✅ `gr_cp<T>` 的 `operator&` 可用于 `IID_PPV_ARGS(&x)` | （已实机确认：glue 层编译通过） |
| 2 | ✅ `GrD3DBackendContext` 可 `= {}` 后逐字段赋值（字段名 `fAdapter`/`fDevice`/`fQueue`/`fMemoryAllocator`/`fProtectedContext`） | （已实机确认：字段名无误） |
| 3 | ✅ `GrD3DTextureResourceInfo(resource, alloc, state, format, sampleCount, levelCount, sampleQualityLevel, protected)` **8 参**构造（旧文档误作 7 参，已按 Skia 参考修正，`sampleQualityLevel=0`） | （已实机确认：编译通过） |
| 4 | ✅ `SkSurfaces::WrapBackendRenderTarget` 能包住 swapchain back buffer（stderr 打出 `window N bound to WxH R8G8B8A8 swapchain`）；`kRGBA_8888_SkColorType` 与 `R8G8B8A8_UNORM` 配对**是否偏色仍待肉眼** | 画面偏色/全黑 |
| 5 | ⚠ `flush(kPresent)` 会让 Skia 做 PRESENT→RENDER_TARGET→PRESENT 的状态转换（已开窗，无 DXGI 报错；撕裂待肉眼） | DXGI 调试层报 resource state 冲突 / 画面撕裂 |
| 6 | ⚠ `Present(1,0)`（等 vsync）与 SDL 帧循环配合不造成额外节流（帧率待肉眼） | 帧率被腰斩 |
| 7 | ⚠ fence 协议正确（`buffer_index` 在 begin/flush 之间保持不变，已连续开两窗无错；黑带待肉眼） | 偶发撕裂/黑带 |
| 8 | ⚠ 最后关窗时拆进程级 context 不会撞上仍在飞的帧（headless 跑未关窗，退出路径未覆盖） | 退出时崩溃 |
| 9 | ✅ `SDL_GetWindowWMInfo` 给出 `SDL_SYSWM_WINDOWS` 与有效 HWND（SDL2 默认 win32 video driver，已成功绑窗） | `sk_attach_d3d` 响亮拒绝、窗口无 GPU |
| 10 | ✅ `clang --target=i686-pc-windows-msvc` 与 `clang-cl` 产的 `.lib` 互链成立（40+ 个 .lib 链接通过） | 链接期大量未解析符号 |
| 11 | ✅ `skia_use_direct3d=true` 的 gn 参数集与 `d3d12allocator` 产出一致（链接通过，`d3d12allocator.lib` 在线） | 链接期缺 `d3d12allocator.lib` |
| 12 | ✅ x86 的 `Repair-SkiaX86Toolchain` 补丁在真实 `BUILD.gn` 上幂等命中（已实机产出 x86 .lib 并链接） | gn 报 `clang_win` 未生效／x86 用 cl.exe 编出 ARM64 |
| 13 | ✅ **Stage3D 在 D3D12 上真的上屏**（阶段一百三十二）：`examples/shmup-stage3d` 跑到 **281 帧 / 5 s**（~56 fps）、零 PSO/合成错误，`ASC_GPU_DUMP` 导出的 **presented back buffer（1500x900 BMP，4,050,054 B）** 里能看到 demo 的 Stage3D 精灵 | Stage3D 层为空／渐变黑／无精灵（合成未落地） |
| 14 | ✅ 队列共享生效：`stage3d_d3d:` 打 `context 1000x600 ready (Direct3D 12)` 且**没有**「no shared D3D12 device」类的响亮告警 | 出现响亮告警 ⇒ Stage3D 自建设备、像素到不了窗口（黑屏但无错） |
| 15 | ⚠ `examples/air-starling-demo` 在 Windows 目标上的完整编译/链接/运行（外部依赖面最广的那个 demo） | 未跑；仍属未验收 |
| 16 | ⚠ **拖动缩放时画面不被拉伸**（阶段一百三十三）：`sd.Scaling = DXGI_SCALING_NONE` 是否真的去掉了 D3D12 侧的整幅重采样（是否还有重影/抖动，放开鼠标后是否停），以及 1:1 呈现时边上是否会露出未覆盖条 | 仍见重影/抖动（`Scaling` 未被 DXGI 采纳）；或新出现 1 px 未覆盖条。**判据**：真拖窗口（用户速度，非脚本慢拖）并肉眼比对；本 macOS 机上同一缺陷类的脚本判据见 [`skia.md`](skia.md) §6.7 的 15/93 vs 0/151 |
| 17 | ⚠ **arm64 依赖前缀真的能建出来**（§2.11）：在一台装了 `MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools` 的机器上跑 `-Arch arm64`，产物经 `Assert-LibBitness` 读出的 COFF 机器字段是 **ARM64**（`0xaa64`）而非 x64（`0x8664`） | 现在是**守卫已验证、产出未验证**：本机没有该工具集，故只证明了 `-Arch arm64` 会**退出 1 并指名缺失组件**、以及 x86 路径的正向分支真的通过自检 |

**Stage3D 上屏的验证口径（重要）**：**不得**用屏幕截图判定——flip-model swapchain 的内容取不到
GDI/BitBlt（截到的是陈旧或全黑画面）。唯一客观判据是 `ASC_GPU_DUMP=<路径> ASC_GPU_DUMP_AT=<帧号>`
导出的 **back buffer BMP**（注意该环境变量的值是**文件路径**，不是开关），再肉眼/逐字节核对其中有 3D 内容。
注：该 dump 走 `d3d_dump_backbuffer`，每次提前返回都会打一行 `ASC_GPU_DUMP: <原因>`，故不存在「静默没导出」。

**已在 macOS 上验证过的部分**（不必重验）：`<architecture>` 解析与拒绝行为；win32 仿真下 32/64 两套清单
逐字段正确（无 `z`/无 `objc`/`frameworks: []`/路径随位宽切换/`sources` 含 `d3d_glue.cc`）；`-l` 名取自真实
Windows `build.ninja`；COFF 机器字段与 x86 旗标的关系；ps1 的 AST 解析、补丁锚点/幂等/`gn format`；后端中立
seam 在 macOS 上零回归（最终 `npm test` **258/258 全绿**；但本阶段开头同一套件曾报出 3 个不同的红、重跑全绿——
门禁不确定性已单独登记入 `TODO.md` 的 `### 遗留待开发`）。

**并且 GPU 窗口路径现已入测试**：`node src/index.ts --air-app examples/air-native/air-native-app.xml
--main-class Main --target native`（即用户命令形态）已在 `test/examples.ts` 里作为
`example: air-native (--air-app + renderMode=direct: compile+link only)` 自动跑（只验证编译+链接，
因为带 `--run` 会开真窗口不返回；vendor 库缺失时显式 SKIP）。这一条是**必要**的：在此之前没有任何测试
编译过该路径（目录型 air-native 单元不带 `--air-app`，`test/unit/build.ts` 的 `--air-app` 先例全带 `--dry`），
于是「中性 seam 只在 D3D12 侧实现、macOS 每个 GPU 构建都链不起来」这类缺陷能在**全套测试全绿**下溜过去
（2026-10-09 实测）。另有两道源级钉子钉住两个后端文件都必须实现中性五名（`unit: backendparity`）。

---

## 6. 后续

- **新开窗路径必须挂监听器 + 跑 `sk_pump_frame`**（§2.8）：拖动/缩放期间循环是被阻塞的，帧只能由
  `SDL_AddEventWatch` 的监听器驱动，而它必须调用共享 pump 而不是自己 tick 一次 —— 否则「多窗口」与
  「`frameRate` 不被拖动改写」两条会各自退化。`unit: platform/WindowFrame` 的 16 条钉子就是钉这个的
  （含「全应用只有**一处** `on_frame`」），加后端/加开窗路径时先看它。
- **Stage3D on Windows**：✅ **两段均已完成** —— **阶段一百三十一** 的 AGAL→HLSL 翻译器（单一 `target` 从两档扩到三档）
  + **阶段一百三十二** 的 `vendor/stage3d_d3d.cc`（D3D12 侧 buffer/texture/pipeline/离屏 RT/混合状态缓存）
  + 构建期接线（`ASC_S3D_HLSL`/`d3d12`/`dxgi`/`d3dcompiler`）。**剩下的是验证**：
  `examples/air-starling-demo` 在 Windows 目标上的完整运行，以及背面剔除/绕序的 A/B 实测。
- **`sk_gpu_draw_texture`**：✅ **已实现**（阶段一百三十二）—— render target 的 `DXGI_FORMAT` 与当前
  `D3D12_RESOURCE_STATE` 由 Stage3D 上下文提供（`s3d_get_render_target` 返回裸 `ID3D12Resource*`；
  合成临时 `retain()` 一份引用）。包装时必须 `retain()`，**不得**走 `gr_cp` 的裸指针构造器——见 §2.9。
- 账目见 `TODO.md` 的 `### 遗留待开发`（本轮新登记 5 行）与阶段一百二十六 节。