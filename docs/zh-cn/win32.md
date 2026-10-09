# Windows 原生后端（Win32 + SDL2 + Skia D3D12）

> 阶段一百二十六。本文覆盖：`<architecture>` 的位宽语义、Windows 依赖库的构建、
> 编译器侧的清单接线、以及**首个 Windows 机器上的核对清单**。
>
> **现状一句话**：编译器侧（描述符解析 / 构建清单 / 库名 / 后端 seam / 依赖脚本的
> 去机器化验证）**已在 macOS 上离线验证**；`vendor/d3d_glue.cc` 与 `window_glue.cc`
> 的 Windows 分支**从未在真实 Windows 上编译或运行过**——本机是 macOS，无法用 MSVC
> ABI 编静态库，也无法编/跑 D3D12 程序（同 `AGENTS.md` §2.9 的既有先例）。§5 把每一处
> **未验证假设**逐条列出，那份清单也就是验收脚本。

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
`ASC-X86-CLANG-PATCH` 与 CRLF 归一。

`skia_use_direct3d = true`（阶段一百二十六 打开）带来三个后果，缺一不可：
`SK_DIRECT3D` 进入 public defines、产出 `third_party/d3d12allocator` 归档、并需要
`d3d12`/`dxgi`/`d3dcompiler` 系统库。**清单侧必须同步**（见 §3.2），改 gn 参数而不改清单等于链接期炸。

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

Stage3D 的窗口叠加层**刻意仍守 `ASC_RENDER_METAL`**（只改名 `is_gpu`）：Windows 的 Stage3D 在清单期就报错，
且 `ASC_stage3d_tex` 是 `MTLTexture`。Windows 上那条 `#else` 分支是**不可达**的（`ASC_stage3d_ready` 恒 false）。

### 3.4 Stage3D 在 Windows 上：构建期响亮失败

描述符或源码用到 `flash.display3D` 时，Windows 目标会抛 `AirAppError`——因为既没有
`stage3d_glue.mm` 的等价物，也没有 AGAL→HLSL 翻译器（`AGALTranslator.translate` 目前只出 MSL / GLSL ES）。
这**不是静默降级**，而是明确的能力边界（`AGENTS.md` §1.5）；后续立项见 `TODO.md` 阶段一百二十六
（`vendor/stage3d_d3d.cc` + `ASC_AGAL_TARGET=hlsl`）。因此 `examples/air-starling-demo` 在 Windows
目标上编译期失败。

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

`sk_gpu_draw_texture`（Stage3D 合成用）明确**未实现且出声**（打印一次说明，不静默画空）：其唯一调用者是
Stage3D 合成，而 Windows 的 Stage3D 不可达（§3.4）。

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

**逐条未验证假设**（编译期出错的都是这里）：

| # | 假设 | 出错时的症状 |
|---|---|---|
| 1 | `gr_cp<T>` 的 `operator&` 可用于 `IID_PPV_ARGS(&x)` | 编译错在取址处（Skia 自带参考同样这么写） |
| 2 | `GrD3DBackendContext` 可 `= {}` 后逐字段赋值（字段名 `fAdapter`/`fDevice`/`fQueue`/`fMemoryAllocator`/`fProtectedContext`） | 编译错在字段名 |
| 3 | `GrD3DTextureResourceInfo(resource, alloc, state, format, levelCount, sampleCount, protected)` 7 参构造 | 编译错在该行 |
| 4 | `SkSurfaces::WrapBackendRenderTarget` 能包住 swapchain back buffer，且 `kRGBA_8888_SkColorType` 与 `R8G8B8A8_UNORM` 配对正确 | 画面偏色/全黑 |
| 5 | `flush(kPresent)` 会让 Skia 做 PRESENT→RENDER_TARGET→PRESENT 的状态转换 | DXGI 调试层报 resource state 冲突 / 画面撕裂 |
| 6 | `Present(1,0)`（等 vsync）与 SDL 帧循环配合不造成额外节流 | 帧率被腰斩 |
| 7 | fence 协议正确（`buffer_index` 在 begin/flush 之间保持不变） | 偶发撕裂/黑带 |
| 8 | 最后关窗时拆进程级 context 不会撞上仍在飞的帧 | 退出时崩溃 |
| 9 | `SDL_GetWindowWMInfo` 给出 `SDL_SYSWM_WINDOWS` 与有效 HWND（SDL2 默认 win32 video driver） | `sk_attach_d3d` 响亮拒绝、窗口无 GPU |
| 10 | `clang --target=x86_64-pc-windows-msvc` 与 `clang-cl` 产的 `.lib` 互链成立 | 链接期大量未解析符号 |
| 11 | `skia_use_direct3d=true` 的 gn 参数集与 `d3d12allocator` 产出一致（macOS 侧已用 `gn gen` 验证参数集被接受） | 链接期缺 `d3d12allocator.lib` |
| 12 | x86 的 `Repair-SkiaX86Toolchain` 补丁在真实 `BUILD.gn` 上幂等命中（已在真实源上验证锚点与幂等） | gn 报 `clang_win` 未生效／x86 用 cl.exe 编出 ARM64 |

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

- **Stage3D on Windows**：`vendor/stage3d_d3d.cc` + `ASC_AGAL_TARGET=hlsl`（`AGALTranslator` 扩到 HLSL +
  D3D 侧 buffer/texture/pipeline/离屏 RT/混合状态缓存）。在此之前 Windows 上 Stage3D 一律构建期报错。
- **`sk_gpu_draw_texture`**：等 Stage3D 的 D3D 后端落地时一并实现（需要 render target 的 `DXGI_FORMAT` 与
  当前 `D3D12_RESOURCE_STATE`，两者只能来自 Stage3D 上下文，故不能凭猜实现）。
- 账目见 `TODO.md` 的 `### 遗留待开发`（本轮新登记 5 行）与阶段一百二十六 节。