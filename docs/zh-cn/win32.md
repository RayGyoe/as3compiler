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
| `32`（缺省） | `vendor/*/windows-x86` | `i686-pc-windows-msvc` | — |
| `64` | `vendor/*/windows-x64` | `x86_64-pc-windows-msvc` | — |

三处路径随之切换：`vendor/skia/lib/windows-xN`、`vendor/sdl2/windows-xN/{lib,include}`、
`vendor/curl/lib/windows-xN`。（`vendor/` 是**入库**目录；`build-tools/` 不入库、在 Windows 上重新下载。）

---

## 2. 依赖库的构建：`vendor/build-windows-deps.ps1`

```powershell
pwsh vendor/build-windows-deps.ps1 -Arch x64    # 产出 vendor/*/windows-x64
pwsh vendor/build-windows-deps.ps1 -Arch x86    # 产出 vendor/*/windows-x86
```

从源码构建：**Skia m124**（`build-tools/skia-src`，含 `bin/gn` + ninja）、**SDL2 2.32.10**、
**curl 8.11.1**、**zlib**、**nghttp2**。工具链用 LLVM 的 **`clang-cl`**（MSVC ABI）。

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
   POSIX 用 `rmdir`，与 `as_mkdir_one` 的 `CreateDirectoryA`/`mkdir` 同构），`deleteDirectory`
   改调它。

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
- **未验收**：`examples/air-starling-demo`（外部依赖最多的那个）**尚未在 Windows 目标上跑过**；背面剔除机与绕序
  仍是纸面决定（`FrontCounterClockwise=FALSE` + 正高度 viewport、不做 Y 翻转），无剔除对照实测。

---

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