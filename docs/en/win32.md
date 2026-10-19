# Windows Native Backend (Win32 + SDL2 + Skia D3D12)

> Stage one-hundred-twenty-six. This document covers: `<architecture>`'s bit-width semantics, building the
> Windows dependency libraries, the compiler-side manifest wiring, and a **first-run checklist for a Windows
> machine**.
>
> **The current state in one line**: the compiler side (descriptor parsing / build manifest / library names /
> backend seam / machine-independent verification of the dependency script) **has been verified offline on
> macOS**; the Windows branches of `vendor/d3d_glue.cc` and `window_glue.cc` **have never been compiled or run
> on real Windows** — this machine is macOS, so it cannot build static libraries with the MSVC ABI, nor build/run
> a D3D12 program (the same precedent as AGENTS.md §2.9). §5 lists every **unverified assumption** item by item;
> that list is also the acceptance script.

---

## 1. `<architecture>`: Bit Width Is a First-Class Parameter

In an AIR descriptor, what decides the bit width of the Windows carrier program is
`<application><architecture>`, **defaulting to `32`**:

```xml
<application xmlns="http://ns.adobe.com/air/application/51.4">
  <id>com.example.app</id>
  <architecture>32</architecture>   <!-- "32" | "64", default 32 -->
</application>
```

`src/air-app.ts`'s `parseAirApp` accepts only `"32"`/`"64"` (any other value **loudly** raises `AirAppError`;
`"16"` is measured to be rejected — never silently treated as 32). Via `airManifest(..., architecture)` it
decides:

| `<architecture>` | vendor directories | Target triple | x86/x64 |
|---|---|---|---|
| `32` (default) | `vendor/*/lib/windows-x86` | `i686-pc-windows-msvc` | — |
| `64` | `vendor/*/lib/windows-x64` | `x86_64-pc-windows-msvc` | — |
| `arm64` (**manifest field only**) | `vendor/*/lib/windows-arm64` | `aarch64-pc-windows-msvc` | see §2.11 |

`arm64` is **not among `<architecture>`'s accepted values** — it exists only as a build-manifest field
(`architecture`): AIR has no Windows ARM64 runtime (measurements in §2.11), so writing it in a descriptor has
no consumer, and `parseAirApp` therefore still takes only `"32"`/`"64"`. Each of the two validates its own value
domain, and an unknown value is always **reported loudly** (`src/build.ts`'s manifest validation does not fall
back to `x86_64`).

Three paths switch accordingly: `vendor/skia/lib/windows-xN`, `vendor/sdl2/{lib,include}/windows-xN`,
`vendor/curl/lib/windows-xN`. (`vendor/` is a **checked-in** directory; `build-tools/` is not checked in and is
re-downloaded on Windows.)

---

## 2. Building the Dependency Libraries: `vendor/build-windows-deps.ps1`

```powershell
pwsh vendor/build-windows-deps.ps1 -Arch x64    # produces vendor/*/lib/windows-x64
pwsh vendor/build-windows-deps.ps1 -Arch x86    # produces vendor/*/lib/windows-x86
pwsh vendor/build-windows-deps.ps1 -Arch arm64  # produces vendor/*/lib/windows-arm64 (needs the ARM64 toolset installed first, see §2.11)
```

Built from source: **Skia m124** (`build-tools/skia-src`, with `bin/gn` + ninja), **SDL2 2.32.10**,
**curl 8.11.1**, **zlib**, **nghttp2**. The toolchain is LLVM's **`clang-cl`** (MSVC ABI).

The three packages follow **one layout rule**: archives in `<pkg>/lib/<arch>/`, headers in
`<pkg>/include/` (Skia's `-I` is the package ROOT, since the glue spells its headers
`include/core/SkCanvas.h`) — **except SDL2, whose headers are split by arch too**
(`<pkg>/include/<arch>/SDL2/`), because its `SDL_config.h` is generated per platform by the build, whereas
Skia's and curl's headers are
byte-identical across platforms (sharing one copy is what keeps them from drifting apart). The macOS side
has the same shape (`vendor/sdl2/lib/macos-arm64`, `vendor/sdl2/include/macos-arm64`), with the arch key
carrying its OS prefix so it cannot be confused with Windows ARM64.

### 2.1 Three Hard Constraints (measured; do not try other routes)

1. **On Windows gn has only an MSVC toolchain**. In `gn/BUILDCONFIG.gn`,
   `if (is_win) set_default_toolchain("//gn/toolchain:msvc")`, and `cl.exe` is swapped for `clang-cl` +
   `lld-link` only when `clang_win` is non-empty. MinGW is a dead end.
2. **MSVC and GNU-ABI static libraries cannot be cross-linked** ⇒ SDL2 / curl must also use `clang-cl`. The
   program side may conventionally use `clang --target=x86_64-pc-windows-msvc` (GNU-style flags work, same ABI
   as those `.lib`s).
3. **The x86 flag is not `-m32`**. On the CMake side pass `--target=i686-pc-windows-msvc`: measured, the COFF
   machine field is `0x01c4` (**ARMNT**) for `-m32` on an arm64 host and `0xaa64` (ARM64) by default, and only
   `--target=i686-pc-windows-msvc` gives `0x014c` (I386). The script's `Assert-LibBitness` uses
   `dumpbin /headers` (or `llvm-readobj`) to recognize x64/x86/ARM64/ARM and **hard-fails on a mismatch** — no
   "happens to run".

### 2.2 Two MSVC-Specific Traps (handled)

- **zlib**: CMake unconditionally builds both `SHARED zlib` (producing an **import library** `zlib.lib`, which
  collides with the usual static-library name) and `STATIC zlibstatic` ⇒ delete the import library and pass
  `ZLIB_USE_STATIC_LIBS=ON`.
- **nghttp2**: must set `BUILD_SHARED_LIBS=OFF` (otherwise the library name becomes `nghttp2_static` and there
  is an import library), and curl finds it via `find_library`, without getting the `PUBLIC`
  `-DNGHTTP2_STATICLIB` ⇒ the script adds it explicitly.

### 2.3 Skia's x86 Wall and `skia_use_direct3d`

The x86 side also needs `Repair-SkiaX86Toolchain`: it auto-detects `$winSdk\bin\SetEnv.cmd` and applies one
**minimal** patch to the gn source (wrapping x86's `env_setup` in `if (clang_win == "")`, so it is not
overwritten once `clang_win` takes effect), with the idempotence marker `ASC-X86-CLANG-PATCH` and newline
normalization.

> Pitfall log: a PS 5.1 here-string **inherits the newlines of the script file itself**, and git defaults to
> `core.autocrlf=true` on Windows ⇒ with a CRLF checkout `$old` is CRLF too, so it can never match the
> LF-normalized text and the patch "fails to find its anchor" (the same script passes under an LF checkout).
> Both sides must therefore be normalized; any new patch that compares source text has to do the same.

`skia_use_direct3d = true` (turned on in stage one-hundred-twenty-six) has three consequences, none optional:
`SK_DIRECT3D` enters the public defines, the `third_party/d3d12allocator` archive is produced, and the
`d3d12`/`dxgi`/`d3dcompiler` system libraries are needed. **The manifest side must be synchronized** (see §3.2);
changing the gn parameter without changing the manifest equals an explosion at link time.

### 2.4 Four Build Breakers from the New Toolchain (clang 23 / MSVC STL 14.43) — handled

All four were found by actually building; none is related to AS3. The script heals each one and leaves a
minimal, marked patch in the touched source (re-entrant; it fails loudly if the source no longer matches):

- **LLVM 23's resource dir uses the major version only** (`lib/clang/23`, not `X.Y.Z`), while Skia m124's
  `gn/highest_version_dir.py` hard-codes the `X.Y.Z` regex ⇒ nothing matches, `IndexError`, and `gn gen`
  dies. The script asks `clang-cl -print-resource-dir` instead (keeping a fallback that enumerates
  `lib/clang` and picks the numerically-highest name) and writes `clang_win_version` straight into
  `args.gn`, bypassing that brittle probe.
- **clang 23 removed `__builtin_ia32_vcvtph2ps256`**, which the skcms copy shipped in m124 uses for its
  f16→f32 AVX2 fast path (`F_from_Half` in `modules/skcms/src/Transform_inl.h`) ⇒ mirror **upstream
  skcms's own** minimal fix (`_Float16` vector + `__builtin_convertvector`, available since `clang >= 15`).
  `VCVTPH2PS` is still emitted — **no downgrade, no slowdown**. Marker `ASC-CLANG23-SKCMS-PATCH`.
- **MSVC's STL removed `std::auto_ptr` under `/std:c++17`** (`yvals_core.h`: `_HAS_AUTO_PTR_ETC =
  !_HAS_CXX17`), and dng_sdk's `dng_pthread.cpp` (the Windows pthread emulation) still uses it ⇒ the
  script adds `_HAS_AUTO_PTR_ETC=1` to the `third_party/dng_sdk` target only, leaving **Adobe's source
  untouched** (`auto_ptr`'s ownership semantics stay exactly as written instead of being quietly swapped
  for `unique_ptr`). This has nothing to do with the clang version: it is a Windows + MSVC-STL-only
  guaranteed failure; upstream AOSP's dng_sdk still uses `auto_ptr` today (there is no upstream fix to
  copy). Marker `ASC-DNG-AUTOPTR-PATCH`.
- **Skia's own `src/gpu/ganesh/d3d/GrD3DUtil.h`** declares `std::wstring`/`std::string` but never includes
  `<string>` (it used to arrive transitively; newer MSVC STL no longer provides it) ⇒ add the explicit
  include (the IWYU answer; pure declaration visibility). Marker `ASC-D3DUTIL-STRING-PATCH`.

### 2.5 Windows `tar.exe` Cannot Create Symlinks (self-healed)

Windows' bundled `tar.exe` (bsdtar) cannot extract symlinks when "Developer Mode" is off / there is no
"create symbolic links" privilege, and SDL2's release tarball happens to contain two —
`SDL2-2.32.10/android-project-ant/{src,AndroidManifest.xml}`, pointing at the same source under
`android-project` and serving the obsolete Ant-based Android project template, unrelated to a Windows build —
so the whole extraction ends with exit 1.

The script **heals only that one failure**: it extracts normally first; on failure it scans tar's output line
by line and accepts only `<path in archive>: Can't create '...'` and
`tar.exe: Error exit delayed from previous errors`, treating any other line as a different problem and
throwing the raw output; it then deletes the half-written tree, retries with `--exclude` for each such entry,
and **lists every skipped entry** (no silent degradation, and what was skipped is never hidden).

---

### 2.6 Four Categories of MSVC Obstacles on the Program Side (the glue layer) (hit on real hardware 2026-10-10, fixed)

Once the dependency libraries compiled, the **program side** (the generated `air-native.c` +
`skia_glue.cc`/`window_glue.cc`/`d3d_glue.cc`) still had four categories of obstacles under
`clang --target=i686-pc-windows-msvc` — all hit at compile time, all unrelated to AS3 semantics, each fixed:

1. **Font backend**: `skia_glue.cc`'s `#else` (non-`__EMSCRIPTEN__`) branch hard-coded
   `#include "include/ports/SkFontMgr_mac_ct.h"` (CoreText-only), and Windows reported
   `unknown type name 'CTFontCollectionRef'`. Windows' GDI/DirectWrite font-manager factory is not in a
   standalone header but in `include/ports/SkTypeface_win.h` (`SK_BUILD_FOR_WIN`, derived from `_WIN32` via
   `SkFeatures.h`). Switched to **`SkFontMgr_New_GDI()`** — it enumerates the Windows system font collection,
   and `gdi32` is already in SDL2's link list, so **no new dependency** (DirectWrite would need `dwrite.lib`).
2. **Cocoa headers in `window_glue.cc`**: `#include <objc/message.h>`/`<objc/runtime.h>` had no guard, and
   `objc_msgSend`/`SEL`/`sk_ns_msg_frame`/`sk_ns_msg_content_rect` plus the `SDL_SYSWM_COCOA`/`info.info.cocoa`
   branch inside `sk_measure_borders` only exist on macOS ⇒ the whole block was wrapped in `#if defined(__APPLE__)`;
   Windows falls to SDL's own `SDL_GetWindowBordersSize` (already implemented by the win32 driver).
3. **The SDL2 `_m_prefetch` conflict**: clang 23's MSVC mode declares `_m_prefetch` as a builtin, while the
   vendored `SDL_endian.h`'s old clang-compat shim `__inline__`-redefines it ⇒ "definition of builtin function".
   Predefine `__PRFCHWINTRIN_H` (the include guard of `<prfchwintrin.h>`) before `#include <SDL2/SDL.h>` to skip
   the shim — the builtin remains, and SDL's own `_m_prefetch` calls still compile.
4. **Three type errors in `d3d_glue.cc`**: ① `g_adapter = d3d_hardware_adapter(...)` assigned a raw
   `IDXGIAdapter1*` to a `gr_cp<IDXGIAdapter1>` (`gr_cp` has no `operator=(T*)`) ⇒ changed to `.reset(ptr)`
   (adopt, matching `EnumAdapters1`'s +1 reference); ② `GrD3DTextureResourceInfo`'s constructor takes **8
   arguments** (`resource, alloc, state, format, sampleCount, levelCount, sampleQualityLevel, protected`), and
   the old code passed 7, treating `GrProtected::kNo` as the 7th (`sampleQualityLevel`) ⇒ added `0` for
   `sampleQualityLevel` (matching Skia's own reference `D3D12WindowContext_win.cpp`) and `GrProtected::kNo` as
   the 8th; ③ `GrBackendRenderTarget`'s D3D wrapper contains an `sk_sp<SkColorSpace>`, so a missing
   `#include "include/core/SkColorSpace.h"` reports "member access into incomplete type 'SkColorSpace'" in
   `SkRefCnt.h` ⇒ added the include.

(This differs from §2.4's "four things that would not compile in Skia's source": those four self-heal by
patching the **source** inside `build-windows-deps.ps1`; these four are fixed in the **in-repo glue files** and
committed directly.)

### 2.7 Three Windows-Specific Runtime Defects (hit on the real-machine first run 2026-10-10, fixed)

After compiling and linking, the first run of `air-native` still exposed three **runtime** problems one by one —
the first a crash, the last two semantic gaps in `flash.filesystem` on Windows, all unrelated to AS3:

1. **Missing `icudtl.dat` → SIGILL (`ud2`)**. Skia's `SkParagraph` (`Cluster::Cluster` →
   `codeUnitHasProperty()`) relies on ICU to fill `fCodeUnitProperties`, and on Windows `SkIcuLoader` reads the
   ICU data from the **exe directory** (stderr prints `SkIcuLoader: datafile missing: icudtl.dat`). With the
   file missing that table is empty, `Cluster::Cluster` indexes out of bounds and triggers `SK_ABORT`'s `ud2`
   (exit 132). Fix: at build time **deploy `vendor/skia/lib/windows-x{N}/icudtl.dat` (10185008 bytes) into the
   output directory automatically** — `src/build.ts` gained `deploySkiaIcuData(cfg, outPath)` (active for
   win32+native+linked-against-skia), and `src/index.ts` calls it after a successful link
   (`[4/4] data icudtl.dat -> ...`); `build-windows-deps.ps1` copies it alongside the artifacts too and
   `Fail`s if missing.
2. **async FileStream `openAsync(…, FileMode.READ)` → `__fastfail`**. The async `AS_JOB_FS_OPEN` mode mapping
   was written as `mode = j->mode` (pass through whatever is non-empty), and `FileMode.READ` is the string
   `"read"` — so `fopen(path, "read")`. POSIX `fopen` merely returns `NULL` for an invalid mode (a soft
   failure, so on macOS it silently became an IOError and was never exposed); the MSVC CRT's `_invalid_parameter`
   instead `__fastfail`s on `"read"` (0xc0000409). The synchronous path `FileStream_open` is **correct** (defaults
   to `"rb"`, only swapping `"write"/"append"/"update"`), and the async path missed the "`"read"` falls back to
   `"rb"`" rule ⇒ changed to the same contract as the sync path: default `"rb"`, and only compare the three
   write modes when non-empty.
3. **`File.deleteDirectory` cannot delete a directory**. The implementation called `remove(nativePath)` — POSIX
   `remove()` is equivalent to `rmdir()` for a directory (deletes an empty directory), but MSVC `remove()` is
   just `_unlink` (**files only**), so the `d.exists == false` assertion failed. Fix: added `as_rmdir_one`
   (Windows `RemoveDirectoryA`, POSIX `remove`, isomorphic to `as_mkdir_one`'s `CreateDirectoryA`/`mkdir`), and
   `deleteDirectory` calls it.
   > **2026-10-12 addendum**: the non-Windows branch moved from `rmdir()` to **`remove()`** — `rmdir` is declared
   > in `<unistd.h>`, and that header is **deliberately skipped under WASI** (there is no `fork/exec` there), so
   > **every** `--target wasm` build died on `call to undeclared function 'rmdir'` (implicit declaration has been
   > a hard error since ISO C99, and newer `clang` no longer tolerates it). `remove()` is in `<stdio.h>` (always
   > present), and both POSIX and wasi-libc treat a directory as rmdir, so one call covers both ends; the Windows
   > branch is still `RemoveDirectoryA` (MSVC's `remove()` deletes files only, as above).

### 2.8 High-DPI Mode and Three Drag/Resize Defects (hit on the real-machine second run 2026-10-10, fixed)

Once `examples/air-native` with `<renderMode>direct</renderMode>` +
`<requestedDisplayResolution>high</requestedDisplayResolution>` was actually run on real hardware, it exposed
three problems **confined to the single layer `vendor/window_glue.cc`**. Machine here: a 3840x2560 physical
display at 150% scaling (`GetDpiForSystem`=144, while a DPI-unaware process only sees 2560x1707). All three are
unrelated to AS3 semantics.

1. **High-DPI mode did not take effect (blurry window)**. On Windows `SDL_WINDOW_ALLOW_HIGHDPI` is a **no-op**:
   what actually enables high DPI is the **process-level** hint `SDL_HINT_WINDOWS_DPI_SCALING=1`, which
   (a) requests per-monitor-v2 awareness (the process is no longer bitmap-stretched by the compositor) and
   (b) switches SDL's coordinate system to DPI-scaled **logical points** — exactly the model macOS has always
   used (`SDL_GetWindowSize` = logical points, `SDL_GetWindowSizeInPixels` = physical pixels, whose ratio is
   the device scale). Measured (`temp/dpiprobe/probe.c`): without the hint → logical 1000x680 / scale 1.000;
   with `DPI_SCALING=1` → logical 1000x680, physical **1500x1020**, scale **1.500**.
   Fix: added `sk_video_init()` as the **single** entry point for starting the video subsystem, latching the
   hint inside it, and routed every other `SDL_Init(SDL_INIT_VIDEO)` call site in the file (three in show,
   `sk_window_create`, `sk_window_get_display_size`) through it — the hint is only effective if set **before
   the first init**, so leaving one bare `SDL_Init` behind is as good as randomly missing it.
   **The gate is `ASC_DISPLAY_HIGH`**: AIR defines `standard` as "render at 1x, let the OS upscale", and a
   DPI-unaware process already behaves exactly that way; lighting up awareness under `standard` too would be
   cramming a 1x picture into the corner of a physical-size render target. So `standard` builds and macOS/wasm
   **keep their behavior byte for byte** (preprocess check: after `-U_WIN32` that string vanishes).
   Artifact measurement: stderr prints `d3d_glue: window 0 bound to 1500x1020 R8G8B8A8 swapchain` (pre-fix
   `1000x680`), while the same run's `trace(stageWidth, stageHeight)` still prints `1000 680` — **the logical
   size is unchanged**, matching AIR semantics.

2. **Refreshing freezes during drag/resize**. Dragging/resizing runs inside the OS's own **modal message loop**,
   and that loop is entered from inside `SDL_PumpEvents` ⇒ the whole drag blocks the main loop (real modal-loop
   probe: during a 2.53 s drag the main loop ran only **1** iteration). The **only** thing that can emit frames
   then is SDL's live-resize event watcher (`SDL_AddEventWatch`), and the **main window had never been attached
   to it** — only `sk_window_show`'s CPU path and `sk_window_create` had it; the two GPU window-show paths
   missed it. Fix: both `sk_window_show_metal` and `sk_window_show_gpu`'s D3D branch attach the same watcher.

3. **Multiple windows affect each other's frame rate during drag/resize**. The old watcher **called `on_frame`
   directly and redrew only the dragged window**, so ① the application frame was pulled up to the OS message
   rate (`Stage.frameRate` was effectively ignored); ② the other windows did not draw a single frame and froze
   for the whole drag. Fix: extracted steps 3–5 of the loop into a shared `sk_pump_frame()` (service resize +
   pick the frame clock + dispatch **one** application frame on the `g_app_next` beat + mark **all** visible
   windows dirty + redraw only the dirty ones, with an `in_pump` re-entrancy guard), and both the loop and the
   watcher run only that, so "a frame during a drag" and "a normal frame" are word-for-word identical.

**A/B measurement** (`temp/dpiprobe/probe8.c`: using `WM_NCLBUTTONDOWN`+`HTCAPTION` from a helper thread to
enter the **real** modal move loop, two windows, two watcher behaviors; in both modes this drag received **the
same 359 events**, i.e. `EXPOSED=260` + `MOVED=99`):

| Watcher | Main loop | Application frames (2.53 s) | Dragged window redraws | **Other window redraws** |
|---|---|---|---|---|
| old (pre-fix) | blocked (`loopIters +1`) | **+359** (≈142 fps, following the OS event rate) | +359 | **+0 (frozen)** |
| new (post-fix) | blocked (`loopIters +1`) | **+157** (≈62 fps, bounded by the 16 ms beat) | +157 | **+157 (keeps animating)** |

In other real drags the old mode's frame counts were 1235 / 3262 (≈494 / 1300 fps), which shows it **follows
the OS event rate** entirely rather than `frameRate`.

**Who feeds the watcher during a drag** (the same hook on both platforms, so the fix is uni-directional for
macOS too): on Windows SDL does `SetTimer(USER_TIMER_MINIMUM)` inside `WM_ENTERSIZEMOVE` → `WM_TIMER` →
`SDL_OnWindowLiveResizeUpdate` → `SDL_WINDOWEVENT_EXPOSED` (measured 260 times), plus a
`WM_WINDOWPOSCHANGED` → `MOVED`+`RESIZED` on every step (measured 99 times; that branch is fired
**unconditionally** in SDL with no change detection); on macOS a 60 Hz `NSTimer` installed during live-resize
emits the same `EXPOSED` (`src/video/cocoa/SDL_cocoawindow.m`). The two event classes are complementary, so
even if one path is starved the beat does not drop.

Probes and script: `temp/dpiprobe/{probe.c,probe8.c,ab.mjs}` (synthetic mouse injection has a failure rate; on
failure the modal loop exits immediately, the probe reports `moved=0`, and `ab.mjs` retries until both drags
actually moved the window before sampling). Source-level nail: `test/unit/platform.ts`'s
`unit: platform/WindowFrame` (16 checks; reverting these three fixes to their pre-fix shape turns **7 of them
red on the spot**).

### 2.9 Skia's D3D Backend Has **No Borrow Semantics**: `gr_cp`'s "Owning" Contract (hit by Stage3D compositing 2026-10-10, fixed)

This is the **deepest third-party API trap** this project has hit so far: it does not error, does not crash,
and only happens intermittently under **concurrent timing**, yet 50 lines of printing can nail the root cause.
First, the contract, copied here (`include/gpu/d3d/GrD3DTypes.h`, Skia m124):

> there is no notion of Borrowed or Adopted resources in the D3D backend, so Ganesh will ref
> `fResource` once it's asked to wrap it. **Clients are responsible for releasing their own ref**
> to avoid memory leaks.

`GrD3DTextureResourceInfo::fResource` is of type `gr_cp<ID3D12Resource>` (not a raw pointer), and `gr_cp`'s
semantics are:

| Operation | `AddRef`? | Release when |
|---|---|---|
| `gr_cp(T* obj)` constructor (**the raw-pointer form of the 8-arg constructor goes through this**) | **❌ no AddRef** ("adopts") | `~gr_cp` **does** `Release()` |
| `gr_cp::retain(T* obj)` | ✅ +1 | |
| `gr_cp` copy assignment / copy construction | ✅ +1 | |

So handing in **your own only reference** through the raw-pointer constructor = giving away ownership; as soon
as the function returns, `gr_cp`'s destructor `Release()`s that resource while the caller still holds a
**dangling pointer**. Measured result (`ASC_S3D_LIFE` + `get_render_target`'s periodic print): **frame 1
composites fine** (`desc(dim=3 TEXTURE2D fmt=87 1000x600)`), and on **frame 2 the same pointer's `GetDesc()`
is a 144-byte vertex buffer** (`dim=1 fmt=0 w=144 h=1` — the address was recycled by the next allocation), so
`sk_gpu_draw_texture` rejects it with `unsupported render target (dxgi format 0, 1 samples); nothing was drawn`
and **Stage3D's frames never reach the screen again**. It looked "intermittent" (~25%) only because freed
memory often still reads back the old contents until the allocator hands that block to someone else.

The correct form (this is exactly what Skia's own `tools/window/win/D3D12WindowContext_win.cpp` does):

```c
GrD3DTextureResourceInfo info(nullptr, nullptr, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                              rd.Format, 1, 1, 0, GrProtected::kNo);
info.fResource.retain(res);   /* take one more reference of our own; the destructor releases this one */
```

or just `info.fResource = otherGrCpRef;` (copy assignment AddRefs). **Both** wrap sites in
`vendor/d3d_glue.cc` were changed to `retain()`: `sk_gpu_draw_texture` (compositing takes a temporary
reference) and `d3d_setup_surfaces` (the swapchain back buffer — this **also fixes a latent double free**:
previously every `d3d_setup_surfaces` call stole a back-buffer reference from the swapchain, which is bound to
go wrong with two windows). Source-level nail: `test/unit/stage3d.ts`'s `stage3d/d3d-glue` group ("never wraps
a borrowed resource with the adopting constructor" + "both wrap sites retain()").

**The general form of the lesson**: before crossing a third-party API boundary, confirm three things — whether
the parameter is **adopted** or **borrowed**, whether the destructor will release on your behalf, and whether
the reference you hold is still needed. The name here is `GrD3DTextureResourceInfo`, but the same ambiguity is
everywhere in C++ (the raw-pointer form of `std::unique_ptr`, the `CFRetain`/`Release` pair, and Android's
`sp<>`).

---

### 2.10 Presentation Must Be 1:1, Never Stretched by DXGI (stage one-hundred-thirty-three, **not re-tested on real Windows hardware**)

**A defect of the same family as macOS's** (macOS side in [`skia.md`](skia.md) §6.7): when `d3d_glue.cc`
creates the swapchain it **never assigns `DXGI_SWAP_CHAIN_DESC1.Scaling`**, and zero-initialised that is
`DXGI_SCALING_STRETCH` (=0) — so DXGI likewise **stretches the back buffer to the client rect**. This is
exactly the D3D counterpart of the Metal side's `kCAGravityResize`: during a live resize the back buffer we
submit and the client rect are **necessarily transiently inconsistent** (the window keeps growing after the
frame was drawn), and under stretch semantics that frame rescales the whole picture once ⇒ the ghosting/jitter
observed; and a 2-frame flip queue keeps the stretched frame around a while longer, so it **keeps jittering
after the mouse is released**.

**Fix**: `sd.Scaling = DXGI_SCALING_NONE;`. It is both **the value the flip model requires**
(`DXGI_SCALING_STRETCH` is for bitblt swapchains; flip swapchains need `NONE`) and the exact counterpart
semantics of `kCAGravityTopLeft`: a frame whose size has not caught up is presented at its **original size**
rather than stretched to fill the client area. In the steady state (back buffer == client rect) the two present
identically, so this is a pure win.

**Why it was not re-tested**: this machine is currently Windows, but this section only made and verified a
**source-level** change — ① the change is a single field assignment, and the enum comes from the already
included `<dxgi1_4.h>` (which pulls in `dxgi.h`); ② the same defect on the Metal side already has a
**real-hardware A/B** of **15/93 vs 0/151** (`temp/resizeprobe/fast.py`), and the D3D side is fixed per that
defect class + the documented requirement; ③ the actual real-Windows re-verification (really dragging the
window and looking for ghosting) **is still not done**, it is on §5's checklist row 16, and **no acceptance is
claimed**.

**Regression nail**: `test/unit/platform.ts`'s `unit: platform/PresentScale` (9 checks, spanning
`metal_glue.mm` / `d3d_glue.cc`, two **mutually uncompilable** host files — which is precisely why source-level
nails are required).

---

### 2.11 ARM64: the Third Value on the Width Axis — Why It Is Not a Default, and Why It Can Fail Loudly on Its Own

#### 1. AIR Has No Windows ARM64, and That Was Measured

| Evidence | Measured result |
|---|---|
| The platform keys of the two Windows runtimes (scanning the DLLs one by one) | **Exactly one each**: `win/` → `Windows-x86`; `win64/` → `Windows-x86-64`. Together that is the whole set (**no** `Windows-arm64`) |
| The Windows runtime directories the SDK ships | Only `win/` (whose `Adobe AIR.dll` carries only `Windows-x86`) and `win64/` |
| The SDK's native side, `lib/` | `win`, `win64`, `android`, `linux_arm64`, `mac`… **no win-arm64** |
| arm64 in the 51.4.1 release notes | Only Linux / iOS / macOS |
| All 44 jars in the SDK | No `Windows-x86-64` literal anywhere ⇒ the platform-key vocabulary is not in the jars; **the runtime DLLs are the authoritative witness** |

Three consequences, none of them avoidable: ① no extension can declare an ARM64 Windows slice (the
`<platform name>` in `extension.xml` can only be written with a key the runtime recognizes); ② no runtime will
look for one — on Windows-on-ARM AIR runs the **x64 build** (under emulation) and still loads x64 native
libraries; ③ so `lib/bin/` **deliberately has no** `windows-arm64`: a host library nothing can load is not
"support", it is inventory. The host-width set is a **closed set** at this point
(`windows-x86`/`windows-x64`), and on Windows ARM64 `as-aot --ane` **errors out** directly, naming
`--ane-platform Windows-x86-64` (plus `"architecture": "64"`), rather than guessing at a key AIR has never had.

#### 2. So Why Does the Dependency Script Still Take `-Arch arm64`

Because "AIR's Windows side does not support ARM64" and "this compiler has no ARM64 capability" are two
different statements. On Windows-on-ARM **non-AIR artifacts** (an ordinary `as-aot` build that does not go
through `--air-app`) can have an arm64 form, and the `windows-arm64` dependency prefix exists precisely for
that. But the **default (`both`) still means x64+x86 only**: `both` means "the two widths an AIR descriptor can
ask for", and quietly turning it into three would make the "default artifact" correspond to no declarable
target.

#### 3. There Is No ARM64 Toolset on This Machine ⇒ This Path Must Be Able to Fail Loudly on Its Own

Measured (this machine's VS 2022 Community): all three MSVC toolsets (14.16 / 14.29 / 14.43) have **only**
`bin/Hostx64/{x64,x86}` and `lib/{x64,x86}`, **no arm64**; Windows Kits 10.0.22621.0 does have
`Lib/<ver>/{um,ucrt}/arm64`. So `vcvarsall.bat arm64` on this machine **returns exit code 0 while preparing
nothing** — judging by the exit code alone would mistake "the toolset does not exist" for "the environment is
ready", and then compile a pile of mis-architected objects downstream. `Import-MsvcEnv` therefore became a
**file-reading** self-check that names the component to install
(`MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools`) whenever any one check fails, and exits 1 **before
downloading anything**:

| Self-check | Criterion |
|---|---|
| The MSVC library directory is non-empty | at least one `*.lib` under `…\VC\Tools\MSVC\<ver>\lib\arm64\` |
| `cl.exe` really belongs to that architecture | `Get-Command cl`'s `.Source` must match `\arm64\cl.exe` |
| The Windows SDK has that architecture | `…\Windows Kits\10\Lib\<ver>\um\arm64\` exists |

**Both states measured**: `-Arch arm64 -Only curl` → **exit 1**, the message naming the missing `lib\arm64` and
the component to install, **and no download having taken place**; `-Arch x86 -Only curl` → prints
`[ok] … the x86-width toolset self-check passed (…HostX86\x86\cl.exe)` ⇒ this is a **real criterion**, not a
blanket refusal. `-Arch arm32` → `ValidateSet` errors out and lists the legal values.

#### 4. Skia's clang-cl Defaults to the Host Architecture — arm64 Must Pin the Triple In

The win branch in `build-tools/skia-src/gn/toolchain/BUILD.gn` passes `-m32` **for x86 only**, and the arm64
branch passes **no architecture flag at all** (it only appends `HostX64\x64` to `PATH`), with the `bin` path
hard-coded to `HostX64`: running `target_cpu=arm64` on an x64 host makes clang-cl **silently produce x64
objects**. So for arm64 we add `extra_cflags = [ "--target=aarch64-pc-windows-msvc" ]` to gn (that arg is
declared by `gn/skia/BUILD.gn`). The product's identity is then re-checked after the build by
`Assert-LibBitness` (reading the COFF machine field, **not** trusting clang's exit code).

#### 5. Stated Plainly: This Path Was Not Run to Completion on This Machine

This machine has no ARM64 toolset, so "`-Arch arm64` produces correct arm64 dependencies" **has not been
verified**; what has been verified is its **guard** (the three checks above plus the post-build bitness
re-check) and its **failure path** (exit 1 + naming the component). It is logged under `TODO.md`'s
`### 遗留待开发`. The macOS runtime-side instance of the **same class of observation was fixed in a later
round**: that SDK's macOS runtime carries only the two ANE keys `MacOS-x86-64`/`MacOS-x86` (`Adobe AIR` is a
universal binary and both slices contain `MacOS-x86-64`; `MacOS-AOT` has 0 hits across the whole SDK), while
`currentAnePlatform()` used to return `MacOS-AOT` on darwin/arm64 ⇒ a real macOS ANE could **not be matched** on
Apple Silicon (a false negative). Now both darwin architectures return `MacOS-x86-64`; the evidence and the nail
are in `TODO.md` stage one-hundred-seventy-eight · six; the complete platform-key-to-`lib/bin/`-directory table
and the **step-by-step procedure for migrating an existing ANE into AOT** are in [`ane.md`](ane.md)
(§3.4 / §4).

---

## 3. Compiler-Side Wiring

### 3.1 `<renderMode>`'s Two Branches on Windows

| Descriptor | Macros | Extra source | Extra link | Semantics |
|---|---|---|---|---|
| `direct` / `gpu` | `ASC_RENDER_WINGPU=1` `ASC_RENDER_D3D=1` | `d3d_glue.cc` | `d3d12` `dxgi` `d3dcompiler` `d3d12allocator` | full-frame GPU compositing per frame (D3D12) |
| `cpu` / `auto` | — | — | — | CPU raster + SDL streaming texture blit |

The macOS-only `metal_glue.mm` / `objc` / Cocoa `framework` entries are all dropped on Windows; `src/build.ts`'s
`-lm`/`-lz` go to zero on win32 (`m.lib`/`z.lib` do not exist on Windows); `AS_HAVE_ICONV=0` (`<iconv.h>` is
not in the CRT, so non-UTF charsets **loudly** throw, the same contract as wasm).

### 3.2 `-l` Names: Windows Archives Have **No** `lib` Prefix

gn's Windows `tool("alink")` has no `output_prefix` (POSIX does) ⇒ the archive name is `<target>.lib`.
This conclusion comes from reading the **real** `build.ninja` produced by running `gn gen` directly on macOS
(`target_os="win" target_cpu="x64"`, with a fake `C:/fake/...` directory placed under out — gn does not
relocate absolute paths) (`Done. Made 91 targets`). Therefore:

- General targets (`skia`/`zlib`/`expat`/`freetype2`/`harfbuzz`/`icu`/`dng_sdk`/`piex`/`sksg`/`skottie`/`svg`/
  `skresources`/`skparagraph`/`skshaper`/`skunicode`/`skcms`/`wuffs`/`bentleyottmann`) ⇒ `-l<name>`.
- **The four targets literally named `lib*`** (`libpng`/`libjpeg`/`libwebp`/`libwebp_sse41`) ⇒ `-llibpng` …
  `air-app.ts` handles them uniformly via `winLib()`.
- `third_party/d3d12allocator` ⇒ `-ld3d12allocator` (Ganesh's D3D backend, when `fMemoryAllocator` is empty,
  **builds its own** `GrD3DAMDMemoryAllocator`, see `GrD3DGpu::Make` in `src/gpu/ganesh/d3d/GrD3DGpu.cpp` ⇒ this
  archive must be in the link). Likewise `-lfreetype2` etc. beyond `-lskia -lskia`, per the measured table.

The complete `link-libs` measured (arch=32):
`skia … wuffs, **libpng, libjpeg, libwebp, libwebp_sse41**, dng_sdk, piex, expat, freetype2, harfbuzz,
icu, zlib, d3d12, dxgi, d3dcompiler, d3d12allocator, SDL2, user32, gdi32, winmm, imm32, ole32, oleaut32,
version, uuid, advapi32, setupapi, shell32, dinput8, curl, nghttp2, crypt32, ws2_32, secur32, bcrypt,
iphlpapi`; `frameworks: []`; `defines:` `ASC_USE_SKIA=1, ASC_USE_WINDOW=1, ASC_DISPLAY_HIGH=1,
ASC_RENDER_WINGPU=1, ASC_RENDER_D3D=1, ASC_HAVE_CURL=1`. For 64-bit, only three vendor paths change.

### 3.3 The Backend-Neutral GPU Seam

`ASC_RENDER_WINGPU` means **"this window's Skia compositing runs on the GPU"**, and the concrete backend is
named by `ASC_RENDER_METAL` (macOS) / `ASC_RENDER_D3D` (Windows) (`ASC_RENDER_GPU` is already taken by web's
Ganesh path). The generated C and runtime use only neutral names: `sk_gpu_init` / `sk_gpu_destroy` /
`sk_gpu_begin_frame` / `sk_gpu_flush` / `sk_gpu_draw_texture`, `sk_window_show_gpu`, `as_skia_gpu_*`, `w->is_gpu`.
The **only** place a backend branch appears is `vendor/window_glue.cc` (`sk_attach_gpu` dispatches by macro, and
`sk_window_show_gpu` is implemented by macro), so the same AS3 source differs between the two ends only in the
build manifest.

Stage3D's window overlay layer is **now unified across all three ends**: the condition widened from
`ASC_RENDER_METAL` to `ASC_RENDER_METAL || ASC_RENDER_D3D` (**excluding** `ASC_RENDER_GPU`, whose
`ASC_stage3d_tex` is a CPU pixel buffer and takes the `#elif` arm at the same site). The two arms pass
different handles: an `MTLTexture` on Metal, an `ID3D12Resource*` on D3D, each decoded under its own backend
macro by `sk_gpu_draw_texture`.

### 3.4 Stage3D on Windows: the D3D12 Backend (landed, stage one-hundred-thirty-two)

When the descriptor or source uses `flash.display3D`, the Windows target now **really links a D3D12 backend**
rather than raising an `AirAppError`:

- **Build-time wiring** (`src/air-app.ts`): `sources` gets `vendor/stage3d_d3d.cc`; `defines` gets
  `ASC_S3D_HLSL=1` (selects stage one-hundred-thirty-one's HLSL target, `target 2`) and `ASC_RENDER_STAGE3D=1`
  (plus `ASC_RENDER_DEPTH_STENCIL=1` for `<depthAndStencil>true</depthAndStencil>`); `linkLibs` gets
  `d3d12`/`dxgi`/`d3dcompiler` (the last is the `D3DCompile` = fxc entry point, which must be the real runtime
  DLL, not a .lib stub). It does **not** push `stage3d_glue.mm` and does **not** add `Metal`/`Foundation`.
  The old Windows `throw` is gone.
- **Shared device/queue** (the prerequisite for "compositing can see the 3D"): `vendor/d3d_glue.cc` exports
  `sk_d3d_shared_device()` / `sk_d3d_shared_queue()` via `__declspec(dllexport)`; `stage3d_d3d.cc` looks them
  up on the main module with `GetProcAddress` **by name** (not a hard link — a Stage3D-only build may not
  contain the window glue at all, and a hard reference would become an unresolved symbol there). If the lookup
  fails it falls back to a private `ID3D12Device` + queue and **loudly warns** that the pixels will never
  reach the window (no silent black screen).
- **One queue ⇒ no CPU wait**: Stage3D's batches and Skia's `sk_gpu_flush` execute in submission order on the
  same `ID3D12CommandQueue`, so the frame-boundary `s3d_flush_async` only needs `Close()` +
  `ExecuteCommandLists()` (commit) and **not** a fence wait — the same line stage one-hundred-fourteen drew on
  the Metal side.
- **Evidence**: `examples/shmup-stage3d` reached **281 frames / 5 s** (~56 fps) with zero PSO or compositing
  errors, and the **presented back buffer** exported through `ASC_GPU_DUMP` (a 1500x900 BMP) contains the
  demo's Stage3D sprites.
- **`examples/air-starling-demo` now runs for real** (stage one-hundred-seventy-three, 127 source files + the
  full Starling): the window opens, resources finish loading, and all **26 draws / 246 triangles** (the 12×9
  nine-slice + 12 labels + background/logo/`infoText`) are in place, not a single piece of geometry missing.
  Along the way one **structural** defect was fixed: **the constant buffer used to be one per frame slot**, and
  D3D12 reads constants when the GPU **executes** the command list ⇒ **every** draw in that frame read the mvp
  uploaded **last** (measured: all 12 buttons transformed by the last button's matrix); Metal copies inline with
  `setVertexBytes` and is immune by construction — which is exactly why **only Windows** was broken. Changed to
  **constant regions versioned per draw** (`S3D_CB_REGION` 4096 B per upload, the cursor reset in
  `s3d_batch_end`, `s3d_wait_slot` kept inside `s3d_upload_constants`) — the details and the three measurements
  that settled it are in [`display3d.md`](display3d.md) §10.1.
- **Item-by-item comparison with `adl 51.4.1`** (same machine, same 150% scaling; the adl side captured the
  window's client area with `temp/win_shot.ps1`, ours is `ASC_GPU_DUMP`'s presented back buffer): the logo's red
  pixel bounding box is **the same `x32..173 y10..196` in client coordinates**, the button pitch is the same
  **69 px** (= 46 pt × 1.5), and the two button columns' row/column offsets line up with the 12 labels one by one.
- **Not accepted**: back-face culling and winding order are still a paper decision
  (`FrontCounterClockwise=FALSE` + a positive viewport height, no Y flip), with no culling A/B measurement;
  `Context3D.drawTriangles`'s `firstIndex` is currently **ignored** (`(void)firstIndex;`, the whole index buffer
  is uploaded) — harmless for Starling (which always calls `drawTriangles(ib, 0, n)`), but a potential deviation
  for other Stage3D apps (logged in `TODO.md`'s leftover list).

See also §2.9 for the Skia D3D `gr_cp` ownership contract that this composite had to satisfy (`retain()`
instead of the adopting bare-pointer constructor) — it is the deepest third-party-API trap this project has hit
so far.

---

### 3.5 Display Metrics: **Logical Points vs Physical Pixels** (stage one-hundred-seventy-three)

Within one run AIR mixes two display spaces, and **both have to be its two** (measured on the same machine with
`adl 51.4.1` / a 3840×2560 desktop / 150% scaling):

| Quantity | Value `adl` reports | Space |
|---|---|---|
| `Stage.fullScreenWidth`/`Height` | 2560×1707 | **logical points (DIP)** |
| `Capabilities.screenResolutionX`/`Y` | 2560×1707 | **logical points (DIP)** |
| `flash.display.Screen.mainScreen.bounds` | 3840×2560 (`visibleBounds` 3840×2488) | **physical pixels** |
| `Capabilities.screenDPI` | 96 | a platform baseline (**not** the panel DPI: SDL reports 144 on the same machine) |
| `Stage.contentsScaleFactor` | 1.5 | window physical/logical ratio |

We used to answer `fullScreen*` with `SDL_GetCurrentDisplayMode` — that is the **physical** mode (3840×2560) ⇒
a Stage3D app that sizes its viewport from `fullScreenWidth` (the Starling projection in
`air-starling-demo`) got a stage coordinate system 1.5× adl's. The fix is to **change the query**, not to
multiply/divide: `SDL_GetDisplayBounds` (under `SDL_HINT_WINDOWS_DPI_SCALING`) already returns logical-point
space, **value-for-value identical** to `adl`; the `Screen.bounds` route (`sk_display_bounds`) is
**deliberately left as-is**, because it shares SDL's logical space with window centering, and switching it to
physical would break centering at the same time.

`Capabilities.screenDPI` is likewise a **constant baseline** rather than a reading: 96 on Windows, 72
elsewhere (macOS is 72 as well). Reporting the real panel DPI (144) would silently deviate on **every** HiDPI
desktop. **Residual deviation**: per AIR, `Screen.bounds`/`visibleBounds` should be physical pixels while we
still report logical values (`sk_display_pixel_bounds` is unimplemented), and that is logged in `TODO.md`'s
`遗留待开发`.

### 3.6 Stage3D Resource **Deferred Release** Must Be Bound to the **Next Submission** (stage one-hundred-seventy-four)

In D3D12's release queue **the release timing is itself part of correctness**: a signalled `fence` only means
**that submission finished**, and says nothing about "is anyone still reading this resource". The original
implementation had `s3d_defer_release` always record `c->fenceNext` (**the last signaled** value); if a resource
is destroyed while the **batch is still being recorded** (`c->listOpen == 1`), it **has already been bound into
the command list by an earlier draw in that batch**, while that submission **has not happened yet** ⇒ the
resource is freed before the GPU reads it, and D3D12 immediately hands the memory to the **next texture**.
Measured (temporary `ASC_S3D_LIFE` instrumentation, `examples/air-starling-demo` changing scenes): **all 171 of
171 releases happened at `listOpen=1`**, a typical line being
`defer 1B242EB0 fence=31` → `RELEASE 1B242EB0 rel_fence=31 done=32 next=32 listOpen=1` (already **completed** at
record time).

This is one root cause with **two symptoms**: ① scrambled picture — an old descriptor samples **someone else's
pixels** (the `colorTF` box in TextScene drew an enlarged "Back", and the background and back button
vanished); ② `DXGI_ERROR_DEVICE_REMOVED` — `Present` reports `0x887a0005` for **still sampling** a destroyed
resource through an SRV (`vendor/d3d_glue.cc`; Stage3D **borrows** the same `ID3D12Device` via
`sk_d3d_shared_device()`, so an illegal operation on the Stage3D side is reported by the composite layer's
`Present`).

The fix (three places; missing any one reproduces it):

1. `s3d_defer_release` parks an entry **at fence 0** while the batch is open (`c->listOpen ? 0 : c->fenceNext`)
   — 0 means "attach it to the **next** submission".
2. Both drains (the bounded reclaim in `s3d_defer_release` plus `s3d_drain_releases`) skip entries with
   `fence == 0` and **keep** them (not discard — discarding would amount to releasing early).
3. `s3d_batch_end` stamps every entry parked at 0 with this submission's fence value, after `Signal`.

**Acceptance**: after stripping all instrumentation and rebuilding, entering all 12 scenes from the menu and
backing out of each to the menu, **3 rounds in a row (36 switches) with zero `Present` failures and zero
`0x887A0005`**; TextScene's render-target dump and the `ASC_GPU_DUMP` window dump both match `adl 51.4.1` on the
same machine. Instrumented comparison: before the fix `RELEASE … listOpen=1` counted **171/171**; after the fix
**all 156 releases had `listOpen=0` and `rel_fence == done`**.

---

### 3.7 The Audio Backend: **WASAPI** (stage one-hundred-seventy-six)

The audio backend (`vendor/audio_glue.c`, miniaudio) is **independent of the rendering backend** — one
translation unit covers every desktop OS: `as_audio_pick_backends()` yields `wasapi, dsound, winmm` (in
fallback order) for `_WIN32`, and `coreaudio` for Apple. On the Windows side **the extra link items are zero**:
all three backends go through `LoadLibrary`/`GetProcAddress` (ole32 / dsound / winmm / avrt), and the object
this file compiles to on this machine measured **no undefined imports beyond kernel32 and the CRT**.

Before stage one-hundred-seventy-six, "no sound" on Windows was **not** a missing backend: the build layer in
`src/air-app.ts` gated the backend off (the gate was hard-coded to darwin) and unconditionally stuffed
`CoreAudio`/`AudioToolbox` into `frameworks` (`-framework` is not a clang argument on Windows). The former made
the seam fall back to a "no sound card" stub and print one of our warnings; the latter would have broken the
link even if the former were lifted. A Windows manifest is now **two entries, source + define**, and
`frameworks` **must be empty**. The layer-by-layer evidence (backend name / loopback recording / demo frame
sounds / negative controls) and how to write the manifest by hand are in [`audio.md`](audio.md) **§15**.

---

### 3.8 Drag Stutter: the Flip-Model Acquire Stall (stage one-hundred-seventy-seven)

Dragging an AOT-built window by its caption moved it in ~15 Hz steps, where the same program under `adl`
glides. Measured with a real pressed drag (`temp/dragtrace/dragtrace2.exe` + `run2.cjs`; `GetWindowRect` at
every step, recording only the changes and computing gap quantiles; the app's
stdout/stderr must go to FILES — the harness blocks in `spawnSync` while dragging, so a pipe stops being
drained and a writer that blocks makes a still-animating app look frozen):

| target | position changes | gap p50 | gaps > 20 ms | CPU while dragging |
|---|---|---|---|---|
| plain Win32 control window (`dumbwin.exe`) | 1745 | 1.8 ms | 0 | 1-6% |
| same glue, **CPU-rendered** SDL window (`win_cpu.exe`) | 1462 | 3.0 ms | 1 | - |
| `adl` (AIR reference, same program) | 1174 | 3.0 ms | 0 | 13% |
| **AOT demo (D3D12 flip, `SK_D3D_NUM_FRAMES 2`)** | 87-120 | **66.4-66.6 ms** | **58-88** | 1-3% |

**Piece-by-piece forensics (each step ruled out one hypothesis)**:

1. Not "the app is starved by the modal move loop": during the drag the app **is still producing frames**
   (`live_resize_watch` is triggered about 30 times a second by WM_PAINT/MOVED, ~33 ms each), and a
   `SendMessage(WM_NULL)` to the window thread answers in 1.2 ms ⇒ the thread is neither busy-dead nor frozen.
2. Not the vsync wait inside `Present`: switching `Present(1,0)` to `Present(0,0)` still leaves every redraw at 33.3 ms.
3. Only phase timing inside `vendor/d3d_glue.cc` (fence acquire / flush / submit / present / signal) localised it:
   during the drag the fence acquire in `sk_gpu_begin_frame` waits **470 ms out of every 500 ms** (~31 ms per frame),
   while flush 1.0 ms, submit 1.7 ms and present 2.6 ms are all negligible; the same redraw costs
   **0.37 ms** when idle.
4. Mechanism: with `BufferCount=2`, DXGI's presentation queue **holds both back buffers** while the compositor is
   moving the window, so no writable buffer is available and acquire waits out **two vblanks (33.3 ms)**. And our
   frames happen to be able to run inside the **OS modal move loop's dispatch**
   (`live_resize_watch -> sk_pump_frame`), so that 33 ms is time the move loop never gets ⇒ the window advances
   one frame per step; when `MOVED` and `EXPOSED` each trigger a pump it doubles to exactly 66.6 ms (= 4 vblanks).

**Fix**: `SK_D3D_NUM_FRAMES` **2 -> 3** (one spare back buffer). The acquire wait drops to 0.0 ms and the drag
to 3.1-4.4 ms steps (max 14 ms, zero gaps over 20 ms) with the app still animating through the drag. Cost: one
extra back buffer (~1.7 MB for 480x870) and about one frame of latency. Only `d3d_glue.cc` (a Windows-only
file) changes, so Metal/WASM are unaffected by construction. A minimal control (`temp/dragtrace/gputest.cc`:
raw Win32 + D3D12 flip, 2 buffers, clear+Present per frame) drags at 4.9 ms and its D3D11 bitblt variant at
4.5 ms, so the flip model itself is not the problem — only "2 buffers AND frames running inside the modal
loop" is.
### 3.9 Resizing by the Bottom-Right Corner **Wedges**: `ResizeBuffers` Corrupted the Fence Ledger (stage one-hundred-seventy-seven · one)

**Symptom**: reported as "dragging the bottom-right corner to resize crashes it". It is **not a crash — it is a
permanent hang**: the window freezes at some intermediate size, `SendMessage(WM_NULL)` goes unanswered for 3-5 s,
`IsHungAppWindow` is 1, the title is still readable, and the process burns **0% CPU over one second** — so it is
blocked on a wait that will never be signalled (not a spin, not an access violation). It froze at 526x950 after
only 3 size changes (~93 ms in).

**Harness** (`temp/dragtrace/resizetrace.c`, `runresize.cjs`, `rzloop.cjs`): a real `SendInput` press on
`HTBOTTOMRIGHT` (found via `WM_NCHITTEST`; **not** `SetCursorPos`, which bypasses the input queue and never enters
the modal resize loop) dragged outward pixel by pixel while the window size is sampled; afterwards it times a
`WM_NULL` round trip, checks `IsHungAppWindow`, measures the process CPU time delta over 1 s and probes liveness
with `OpenProcess(SYNCHRONIZE)`. `dumbwin.exe` is **not** a usable resize control (its `WM_NCLBUTTONDOWN` path
yields `hwndCapture == 0`); `gputest.exe` (raw Win32 + D3D12 flip) and `adl` are — both resize smoothly.

**Root cause**: the fence ledger in `d3d_glue.cc` got corrupted. `fence_values[i]` is "the last submission on back
buffer i"; `sk_gpu_begin_frame`'s acquire wait means "wait until that value is reached". But `begin_frame` first
takes `current = w->fence_values[w->buffer_index]` (an OLD slot's value, used as the counter) and only then
overwrites `buffer_index` from `GetCurrentBackBufferIndex()`. Before the fix we also wrote

```c
w->buffer_index = w->swapchain->GetCurrentBackBufferIndex();
```

right after `ResizeBuffers`, which pointed the counter's source slot at whichever buffer the rebuilt swapchain
happened to land on — possibly an **older** slot — so `fence_values[new] = current + 1` became a value the fence
had **already passed**. A fence never moves backwards, so `Signal()` on a passed value is a **no-op**: that buffer
loses the "the GPU is done with me" marker, and the **next** resize (whose drain waits for **every** slot) blocks
forever on a value that will never be reached. The intermittency comes from which slot the index lands on.

**Quantified** (`ASC_RZ_TRACE=1` ledger): before the fix, 34 of 72 size changes produced a no-op signal
(`V <= completed`); one process wedged on its 2nd resize. After the fix: **0 of 298** across four drags.

**Why the `SK_D3D_NUM_FRAMES 2 -> 3` fix (§3.8) is what detonated it** (**inference**, no single-variable A/B
was run): with two buffers the ~31 ms acquire wait was itself a throttle — one frame per watch event, two vblanks
apart — so `ResizeBuffers` practically never overlapped an in-flight frame. With a spare buffer the frames really
run, and this latent ledger bug bit for the first time.

**Fix** (`vendor/d3d_glue.cc`, three places): (1) **delete** that post-`ResizeBuffers` index re-read — the next
`begin_frame` reads it anyway, and reading it early breaks the invariant "every value assigned is strictly greater
than every value already signalled", which is what makes each wait reachable; Skia's own reference
(`build-tools/skia-src/tools/window/win/D3D12WindowContext_win.cpp`, `resize()`) likewise does not re-read the
index there. (2) **bound the drain**: `#define SK_D3D_DRAIN_MS 250`, so the pre-resize "wait for the GPU to
release each slot" waits at most 250 ms per slot instead of an unbounded `INFINITE` (the queue/Present really can
stall during a resize). (3) on timeout **release nothing**: skip the frame (`return nullptr`) after a one-time
honest stderr note, leaving the swapchain and every surface untouched so the next frame retries; the
`surfaces[i]`/`buffers[i]` releases moved into a separate loop after a successful drain.

**Verified** (clean rebuild, Windows x64): 3/3 real corner drags (502x926 -> 2101x2497, 70 size changes)
**survived**, all responsive (`WM_NULL` answered in 7.7-11.3 ms, `IsHungAppWindow` 0, exit code 0). **No
regression**: the same 6 s caption drag measures p50 **3.0 ms** / p95 4.6 / p99 4.9 / max 8.9 with **zero gaps
over 20 ms**, tracking 1799 of 1800 cursor pixels ⇒ §3.8's drag fix is intact. The post-resize picture matches
`adl` structurally (blank margin beyond the fixed-size stage): `temp/dragtrace/after_resize.png` against
`adl_after_resize.png`. Only `d3d_glue.cc` (a Windows-only file) changes, so Metal/WASM are
unaffected by construction, and the `window_glue.cc` live-resize watch is untouched.

### 3.10 Rebuilding the Vertex/Index Upload Every Call Was the Bulk of a Windows Frame (stage one-hundred-seventy-nine)

**Symptom**: `examples/air-starling-demo`'s benchmark scene (`BenchmarkScene`) only reached **61k objects** on Windows,
while the macOS record is **120k**. The benchmark adds objects every frame (`addTestObjects(16)`); at **66k** objects the
frame time jumps from 0.2 ms to **~17 ms**, which eats the entire 16.67 ms budget, so its convergence criterion
(`measuredFps < 0.985 * 60`) fails 100 times in a row and the ramp plateaus at 66-68k.

**Harness**: `temp/benchperf/runbench.cjs` (the `bench-auto` marker drives straight into `BenchmarkScene`; `System.output`
concatenates `BENCH` records with **no newline**, so the peak can only be read with `/obj=(\d+)/g` over the whole log),
plus the `ASC_VB_PROBE` probe (reverted) and `ASC_FRAME_STATS=1`. Evidence: a **static frame** (same 65.8k objects, no
additions) measures `tick p50 = 0.203 ms` / `present 0.431 ms` / `period 16.894` / `fps 59.2`, while a **mutating frame**
measures `tick p50 = 15.6 -> 17.2 ms`. Those 17 ms are **not GC** (`FRAME` probe: `gcmax=0.00 gcavg=0.00`) and **not the
display-list API** (micro-probe `temp/benchhot/addcost.as`: 60k Sprites' `addChild` totals 287 ms, property writes cost
2-9 ns) -- the cost lives on Starling's quad-batch rebuild **plus our vertex upload**.

**Root cause**: `s3d_make_upload` in `vendor/stage3d_d3d.cc` **built a fresh committed resource on every call**
(`CreateCommittedResource` + `Map` + `memcpy` + `Unmap`, with the old buffer deferred-released). Measured fixed overhead
is **~100 us per call, independent of size** (64 boot-time 0.5 KiB uploads = 7.55 ms); at 66k objects a frame does
**20-27 uploads / 4-5 MB / `make_ms` 4.4-6.5 ms** (a third of the frame or more), whereas the scalar conversion loop
itself is only ~0.16 ms/frame (`-O2` vectorizes it). Metal never pays this: its upload is a `replaceRegion` into a
**persistent** buffer.

**Fix** (`vendor/stage3d_d3d.cc`, an upload-heap pool):

1. `s3d_ubuf_new` creates a **permanently mapped** committed buffer (legal for an UPLOAD heap) with a power-of-two
   capacity floored at 4 KiB; the pool is bounded by `S3D_UBUF_MAX = 1024` and says so **loudly** when full instead of
   silently dropping an upload.
2. `s3d_acquire_upload` hands out the **smallest free entry that fits** -- a candidate must have `pending == 0`,
   `fence == 0 || fence <= GetCompletedValue()`, and must not currently be bound to any stream or the index stage
   (`s3d_ubuf_bound`) -- and only creates a new buffer when nothing fits. When saturated it calls `s3d_wait_idle` and then
   evicts a too-small entry, so the pool is **bounded but self-cleaning** (otherwise capacity that outgrew an older class
   would sit dead for the rest of the run).
3. `s3d_upload_vertex` **converts straight into `b->map`** (dropping the per-call `malloc` + `memcpy`), and
   `s3d_upload_index` memcpy's straight into it.
4. "This buffer may be reused" is **always decided by the fence a submission stamped** (`s3d_stamp_uploads`), never by
   CPU bookkeeping alone: memory the GPU may still be reading is never overwritten. A buffer **replaced** while a batch is
   open is re-marked `pending` (`s3d_mark_batch_ref`), because the open batch already holds its GPU virtual address.
5. `s3d_destroy` releases the pool; the stream/index buffers are **borrowed**, so releasing them there would double-free.

**Trap worth recording on its own**: `s3d_stamp_uploads` must **return immediately while a batch is open**. The first
version lacked that guard -- the immediate list (texture uploads) cleared every `pending` flag mid-batch, so the 12 menu
buttons' vertex uploads on the first frame **all landed in ONE buffer** and **11 of the 12 buttons vanished for good**
(Starling never re-uploads an unchanged QuadBatch, so the corrupted buffers survived the whole process: `ASC_GPU_DUMP`
pictures at frame 60 and frame 300 are bit-identical). **A rendering regression is far more discreet than a performance
one** -- the benchmark number looked great (150,992) at the time. The fix is one line: `if (c->listOpen) return;` (with a
batch unsubmitted, **no** fence value can prove the GPU is finished with the buffer).

**Verified** (clean rebuild, Windows x64):

- Peak **67,728 -> 147,488 objects (2.18x)** (the unguarded version gave 150,992; the guard costs ~2% in reuse).
- **Pixels**: `temp/verify_tour.cjs` drove all **13 scenes** (`temp/verify_ub/`) -- the static menu is **bit-identical** to
  the pre-fix build (**0** differing pixels), and every other scene's difference falls in an animated region or the bottom
  `Fps` text (Sprite3D 3.85% = the spinning cube, Masks 1.14% = the rotating mask, Textures/Animations/TextFields 0.042%
  each = the same small dynamic text). 38 log lines, **0** error-ish.
- Full `node test.ts`: **tests 349 / pass 323 / fail 23**, item-for-item the baseline (`stage3d/flush-policy` is red both
  before and after, i.e. a pre-existing failure, not this change).
- Unit pins: 9 new checks in `stage3d/d3d-glue` (each pool invariant, "no stamping while a batch is open", and the doc),
  taking that group from 28 to 37; **9 of 9 mutations were caught** (drop the stamp guard, drop the fence-usability test,
invert `pending`, offset the direct write into `b->map`, change the `memcpy` length, make `s3d_ubuf_bound` always
true, skip the pool release loop, rename the saturation message, change the doc's number).

**Controls and exclusions**:

- The same demo under `adl 51.4.1` on the same machine reaches only **16,610-16,896 objects** -- our Windows AOT was
  already ~**4x** faster before the fix, so "Windows AOT is slow" does not hold.
- `ASC_FORCE_REFRESH=30` (a 33.3 ms budget) plateaus at **148,384 = 2.19x**, so the stop point scales **linearly** with the
  frame budget: it is not a throughput ceiling. The fix now reaches that "double-budget" rank inside the 16.67 ms budget.
- The **"4090d" display-driver text is not ours**: `driverInfo` is the compile-time placeholder `Direct3D12 (Stage3D)` and
  `4090|RTX|GeForce` has **0 hits** in the exe, the generated C and `Demo-app.xml`; that text comes from the `adl` run or
  from some system tool.

**Observation (not fixed, not entered in the remaining-work table)**: the stock pacer lands at **16.947 ms (59.0 fps)**
(`SDL_GetTicks`' whole milliseconds plus `SDL_Delay` overshoot, ~0.28 ms late per frame); a QPC + hybrid-sleep pacer
restores 16.667 ms / 60.0 fps but does **not** move the plateau (67,488), so it is an independent precision issue and not
the cause here. `adl`'s frame interval was **not** measured on this machine, so the hard criterion of S1.5 is not met and no
debt is registered.

**Scope**: only `vendor/stage3d_d3d.cc` changes, and it compiles **only** into Windows/D3D12 builds, so Metal and WASM are
unaffected by construction.

### 3.11 `Capabilities.language` / `languages`: the source is the **system UI language**, and `language` is a **closed set** (stage one-hundred-eighty-seven)

**Symptom**: a real application came up entirely in English — its test `Capabilities.language == "zh-CN"` was false.

**Root cause**: the Windows branch of `as_cap_language()` read only the process environment (`LANG`/`LC_ALL`).
On Windows that is normally unset (started from Explorer) and, when started from git-bash, happens to be
`en_US.UTF-8` — so it always answered `"en"`, while `adl 51.4.1` on the same machine answers `zh-CN`.

**Measured with `adl` (three-state experiment; machine: region format `zh-CN`, display language `en-US`)**

| Change to the machine | `GetUserDefaultLocaleName` | `adl` `language` / `languages` |
|---|---|---|
| — | `zh-CN` | `zh-CN` / `["zh-CN","en-US"]` |
| `Set-Culture de-DE` | `de-DE` | still `zh-CN` / `["zh-CN","en-US"]` |
| `Set-WinUserLanguageList de-DE,zh-Hans-CN,en-US` | `zh-CN` | still `zh-CN` / `["zh-CN","en-US"]` |

⇒ It is neither the user locale nor the registry language list but the **effective UI language**, matching the
reference (“returns the user interface (UI) language … used for all menus, dialog boxes, error messages, and
help files”).

**The contract**: `language` is a **closed set** — a lowercase ISO 639-1 two-letter code, with an ISO 3166 region
appended for **Chinese only** (`zh-CN`/`zh-TW`), and `"xu"` for anything outside AIR's table. `languages` is the
list of RFC 4646 tags (**region kept**) in preference order. The two agree on the **primary language** only
(“generally has the same primary language ID”, not equality: on an en-US machine `language == "en"` while
`languages[0] == "en-US"`).

**Where each target reads it**

| Target | `language` | `languages` |
|---|---|---|
| macOS | `CFLocaleCopyCurrent()`, normalized | same source |
| Windows | `GetUserDefaultUILanguage()` → `MAKELCID` → `LOCALE_SISO639LANGNAME` + `LOCALE_SISO3166CTRYNAME` | `GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, …)` |
| other POSIX | process `LANG`/`LC_ALL` (**last resort**) | same source |

The tag then goes through `as_cap_language_from_tag()`: Chinese is split into CN/TW by region (`zh-HK`/`zh-MO`
count as TW), every other language is looked up in AIR's table (`as_cap_air_langs[]`, transcribed entry by entry)
and collapses to `"xu"` when absent; the entries of `languages` go through `as_cap_lang_normalize()` (which keeps
the language-region shape). Probes and assertions: `unit: platform/CapabilitiesLocale` (30 checks — the behaviour
table is compiled from the **real sliced source text**, so it runs on any host, while the host value only runs on
darwin) and `examples/capabilities.as`.

### 3.12 `Capabilities.os`: a **family name plus a version** — the bare family name blanked downstream fields and the device fingerprint too (stage one-hundred-eighty-nine)

**Symptom**: an extension's Windows gate `Capabilities.os.search('Windows') > -1` was permanently `false`, so the
extension was unusable under AOT while `adl` answered `true` on the same machine. (The gate used to read
`manufacturer`, which this project deliberately reports as `"AS-AOT"` — see the `manufacturer` row in `TODO.md`;
switching the application side to `os` is what exposed this.)

**Root cause**: the Windows branch of `as_cap_os()` returned the bare family name `"Windows"`, while AIR returns
**`"Windows 11"`**. It is not only about the gate: applications read the version back **out of the string** — a
device-info field takes `Capabilities.os.split(" ")[1]` (permanently `undefined` under a bare name) and hashes the
whole string into a **device fingerprint** (change the string, change the fingerprint).

**Measured against `adl 51.4.1` (Windows 11, build 26200)**

| `Capabilities.*` | AOT (before) | AOT (after) | `adl 51.4.1` |
|---|---|---|---|
| `os` | `Windows` | **`Windows 11`** | `Windows 11` |
| `manufacturer` | `AS-AOT` | `AS-AOT` (deliberate) | `Adobe Windows` |
| `version` | `WIN 50,0,0,0` | `WIN 50,0,0,0` | `WIN 51,4,1,1` |

Gate expressions measured on the AOT build (`adl` in parentheses): `os.search('Windows') > -1` = **true** (true),
`os.search('Android') > -1` = `false` (false), `os.indexOf('Windows') == 0` = **true** (true — this is the one
Starling uses).

**The name table was recovered from AIR's own binary**, not guessed
(`runtimes/air/win64/Adobe AIR/Versions/1.0/Adobe AIR.dll`): a 22-entry table (`Windows 95` … `Windows 11 Server`,
defaulting to `"Windows"`) produced by exact `VerifyVersionInfoW` + `VER_EQUAL` comparisons. Three facts matter:

1. **Windows 11 is not a new major version** — it is a promotion applied on top of `10.0` when `build >= 22000`
   (`0x55F0`), so `VerifyVersionInfoW(11,0)` never matches and the build number decides;
2. server SKUs differ only by `wProductType != VER_NT_WORKSTATION` (`Windows 11` vs `Windows 11 Server`);
3. within `5.2`, `SM_SERVERR2` (89) and `VER_SUITE_WH_SERVER` (0x8000) separate `Windows Server 2003 R2` /
   `Windows Home Server` / `Windows XP 64`.

**The version source is `ntdll!RtlGetVersion` — the one deliberate deviation from AIR in this stage.** Measured here
with a **manifest-less** native executable (exactly what we produce):

| Query | Result |
|---|---|
| `VerifyVersionInfoW(==10.0)` | `0` (`GetLastError = 1150` `ERROR_OLD_WIN_VERSION`) |
| `GetVersionExW` | `6.2 build 9200` ← **the manifest version lie** |
| `ntdll!RtlGetVersion` | `10.0 build 26200` (the truth) |

⇒ AIR only gets the truth because of its own `app.xml` manifest; copying its query verbatim would report Windows 11
as **Windows 8**. Both `GetSystemMetrics(89)` and `RtlGetVersion` are resolved through `GetProcAddress`: this helper
is compiled into **every** build, and headless builds do **not** link user32, so a static reference breaks the link
outright (`undefined symbol: GetSystemMetrics`).

**Left unaligned (stated, not guessed)**: macOS / Linux / WASI still report the bare family name
(`"Mac OS"` / `"Linux"` / `"WASI"`). AIR appends a version there too, but this host is Windows and no Darwin/Linux
release→name table can be verified from it, so nothing is invented; the gap is written down in the code comment
instead of being filled with a plausible-looking value.

Pins: `unit: platform/CapabilitiesOs` (all 18 returnable names present / the `build >= 22000` promotion / the
`wProductType` split / **no static user32 dependency** / the rationale on record) and `examples/stage65.as` (on
Windows it asserts `os` splits into a non-empty version token; macOS skips it automatically).

## 4. Runtime Form (D3D12 Direct)

`vendor/d3d_glue.cc` and `vendor/metal_glue.mm` are **structurally isomorphic** (a frame's target is one-shot
resources, with only a begin/draw/present loop); the difference is only in what the "one-shot resources" are:

- **Process-level** (created at the first GPU window, torn down when the last window closes): `IDXGIAdapter1`
  (enumerate + a `D3D12CreateDevice` probe to pick a hardware adapter) → `ID3D12Device` →
  `ID3D12CommandQueue(DIRECT)` → `GrDirectContext::MakeDirect3D`. `GrD3DBackendContext::fMemoryAllocator` is
  **left empty** (Skia builds its own AMD allocator; consistent with Skia's own reference).
- **Window-level** (`sk_gpu_init`): `CreateSwapChainForHwnd` (`FLIP_DISCARD` + `R8G8B8A8_UNORM`) → each of two
  back buffers wrapped as a `GrBackendRenderTarget`/`SkSurface` → `ID3D12Fence` frame sync.
- **Per frame**: `sk_gpu_begin_frame(w,h)` handles size changes (`ResizeBuffers`) and back-buffer waiting;
  `sk_gpu_flush` first `flush(kPresent)`, **then** `submit`, **then** `Present(1,0)`, then `Signal`s the fence
  value for that frame. **Neither half can be omitted** — flushing without submitting presents the **old** back
  buffer.

`sk_gpu_draw_texture` (for Stage3D compositing) is **implemented**: it wraps Stage3D's offscreen render target
into a `GrBackendTexture` → `SkImages::BorrowTextureFrom` → `SkCanvas::drawImageRect` (the dst-only overload
with `SkSamplingOptions(kLinear, kNone)`, because under HiDPI the source is device-size while the destination is
logical-size). The target must be `R8G8B8A8`/`BGRA8` and non-multisampled, otherwise it is **loudly refused**
(`unsupported render target (dxgi format %d, %u samples); nothing was drawn`, printed once). When wrapping, the
resource must be `retain()`ed rather than passed through the bare-pointer constructor — **the deepest Skia D3D
trap this project has hit; see §2.9.**

---

## 5. Windows First-Run Checklist (**unverified assumptions**, item by item)

On a Windows x64 machine, in order:

1. `pwsh vendor/build-windows-deps.ps1 -Arch x64` (then optionally `-Arch x86`). **Verify**: the ps1's
   `SetEnv.cmd` detection under real PowerShell, `Invoke-CmakeBuild`'s `-Arch` passing, and that
   `Assert-LibBitness` does not false-positive (on the macOS side we only achieved "portable pwsh parses the AST
   + `gn format` passes + the patch hits the real source and is idempotent").
2. Compile a `<renderMode>direct</renderMode>` `--air-app` project. **Verify**: `m.lib`/`z.lib`/`objc`/`framework`
   no longer appear at link time, and the four `lib*` archive names resolve successfully as `-llibpng`.
3. On the first run watch **stderr**: the `d3d_glue:`-prefixed text distinguishes the failure point
   (`CreateDXGIFactory1` / no available adapter / `D3D12CreateDevice` / `CreateCommandQueue` / `MakeDirect3D` /
   `CreateSwapChainForHwnd` / `WrapBackendRenderTarget`). A black window with no sound = rendering succeeded but
   drew no content; check the AS3 side.
4. **Manually re-verify drag/resize and high DPI** (these two can only be judged by eye; see §2.8):
   - Drag the main window's title bar and pull its bottom-right corner to resize: the animation should **keep
     going** (neither freezing nor speeding up), and the `Fps` counter should sit near `Stage.frameRate`; after
     clicking the red block to open a second NativeWindow, dragging the main window should leave **the second
     window animating as usual**.
   - On a 150%-scaled display: `d3d_glue:` should print **physical** pixels (1500x1020 on the machine here),
     while `trace(stageWidth, stageHeight)` still prints the **logical** size (`1000 680`); with a `standard`
     build (`<requestedDisplayResolution>standard</requestedDisplayResolution>`) the two should be **equal** and
     the process should stay DPI-unaware (the picture is upscaled by the OS, which is AIR's definition of that
     tier).

**Item-by-item results** (2026-10-10 real machine x86 + `direct` run-through: compile 1–3, link 10–12, run
4/9/11 all confirmed; 5–8 open a window with no error, but "tearing / frame rate / exit" need eyeball
re-verification; **stage one-hundred-thirty-two added 13/14 confirmed, 15 not accepted**):

| # | Assumption | Symptom on failure |
|---|---|---|
| 1 | ✅ `gr_cp<T>`'s `operator&` is usable in `IID_PPV_ARGS(&x)` | (confirmed on real hardware: the glue layer compiles) |
| 2 | ✅ `GrD3DBackendContext` can be `= {}`-initialized and then assigned field by field (field names `fAdapter`/`fDevice`/`fQueue`/`fMemoryAllocator`/`fProtectedContext`) | (confirmed on real hardware: field names correct) |
| 3 | ✅ `GrD3DTextureResourceInfo(resource, alloc, state, format, sampleCount, levelCount, sampleQualityLevel, protected)` **8-arg** constructor (older docs wrongly said 7 args; corrected per Skia's reference, `sampleQualityLevel=0`) | (confirmed on real hardware: compiles) |
| 4 | ✅ `SkSurfaces::WrapBackendRenderTarget` can wrap the swapchain back buffer (stderr prints `window N bound to WxH R8G8B8A8 swapchain`); whether `kRGBA_8888_SkColorType` paired with `R8G8B8A8_UNORM` **shifts color still awaits eyeballs** | color shift / all-black image |
| 5 | ⚠ `flush(kPresent)` makes Skia do the PRESENT→RENDER_TARGET→PRESENT state transition (window opens, no DXGI error; tearing awaits eyeballs) | DXGI debug layer reports a resource-state conflict / tearing |
| 6 | ⚠ `Present(1,0)` (wait for vsync) combined with SDL's frame loop causes no extra throttling (frame rate awaits eyeballs) | frame rate halved |
| 7 | ⚠ the fence protocol is correct (`buffer_index` stays constant between begin/flush; two windows opened back-to-back with no error; black bands await eyeballs) | occasional tearing / black bands |
| 8 | ⚠ tearing down the process-level context at the last window close does not collide with still-in-flight frames (headless runs never close a window, so the exit path is not covered) | crash on exit |
| 9 | ✅ `SDL_GetWindowWMInfo` gives `SDL_SYSWM_WINDOWS` and a valid HWND (SDL2's default win32 video driver; window bound successfully) | `sk_attach_d3d` refuses loudly, window has no GPU |
| 10 | ✅ `.lib`s produced by `clang --target=i686-pc-windows-msvc` and `clang-cl` cross-link successfully (40+ `.lib`s linked) | many unresolved symbols at link time |
| 11 | ✅ `skia_use_direct3d=true`'s gn parameter set is consistent with the `d3d12allocator` output (links, `d3d12allocator.lib` present) | `d3d12allocator.lib` missing at link time |
| 12 | ✅ x86's `Repair-SkiaX86Toolchain` patch hits idempotently on the real `BUILD.gn` (x86 `.lib`s produced on real hardware and linked) | gn reports `clang_win` not in effect / x86 built as ARM64 with cl.exe |
| 13 | ✅ **Stage3D really reaches the screen on D3D12** (stage one-hundred-thirty-two): `examples/shmup-stage3d` runs **281 frames / 5 s** (~56 fps) with zero PSO/composite errors, and the **presented back buffer (1500x900 BMP, 4,050,054 B)** exported by `ASC_GPU_DUMP` shows the demo's Stage3D sprites | Stage3D layer empty / gradient black / no sprites (compositing not landed) |
| 14 | ✅ queue sharing works: `stage3d_d3d:` prints `context 1000x600 ready (Direct3D 12)` and there is **no** loud "no shared D3D12 device"-class warning | a loud warning appears ⇒ Stage3D built its own device and pixels never reach the window (black but no error) |
| 15 | ⚠ complete compile/link/run of `examples/air-starling-demo` on the Windows target (the demo with the widest external-dependency surface) | not run; still unaccepted |
| 16 | ⚠ **the picture is not stretched while dragging to resize** (stage one-hundred-thirty-three): whether `sd.Scaling = DXGI_SCALING_NONE` really removes the whole-picture rescale on the D3D12 side (any ghosting/jitter left, and whether it stops after the mouse is released), and whether 1:1 presentation leaves an uncovered strip at the edges | still ghosting/jittering (DXGI did not honour `Scaling`); or a new 1 px uncovered strip. **Criterion**: really drag the window (user speed, not a slow scripted drag) and compare by eye; the scripted criterion for the same defect class on this macOS machine is the 15/93 vs 0/151 in [`skia.md`](skia.md) §6.7 |
| 17 | ⚠ **the arm64 dependency prefix really builds** (§2.11): on a machine with `MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools` installed, run `-Arch arm64` and have the COFF machine field that `Assert-LibBitness` reads out of the artifact be **ARM64** (`0xaa64`) rather than x64 (`0x8664`) | right now it is **guard verified, product unverified**: this machine has no such toolset, so all that is proven is that `-Arch arm64` **exits 1 and names the missing component**, and that the positive branch of the x86 path really passes the self-check |

**How to verify Stage3D reaches the screen (important)**: **do not** judge by screen capture — a flip-model
swapchain's contents cannot be captured through GDI/BitBlt (you get a stale or all-black frame). The only
objective criterion is the **back-buffer BMP** exported via `ASC_GPU_DUMP=<path> ASC_GPU_DUMP_AT=<frame>`
(note the environment variable's value is a **file path**, not a switch), then eyeballing/byte-checking that it
contains 3D content. Note the dump goes through `d3d_dump_backbuffer`, which prints an `ASC_GPU_DUMP: <reason>`
line on every early return, so there is no such thing as a "silent non-export".

**Parts already verified on macOS** (no need to re-verify): `<architecture>` parsing and rejection behavior;
under win32 emulation both the 32/64 manifests are correct field by field (no `z` / no `objc` / `frameworks: []` /
paths switch with bit width / `sources` includes `d3d_glue.cc`); `-l` names taken from the real Windows
`build.ninja`; the relationship between the COFF machine field and the x86 flag; the ps1's AST parsing, patch
anchor/idempotence/`gn format`; the backend-neutral seam being zero-regression on macOS (final `npm test`
**258/258 green**; though at the start of this stage the same suite reported 3 different reds and a rerun was
all-green — the gate's nondeterminism is registered separately in `TODO.md`'s `### 遗留待开发`).

**And the GPU window path is now covered by tests**: `node src/index.ts --air-app examples/air-native/air-native-app.xml
--main-class Main --target native` (i.e. the user-command form) now runs automatically in `test/examples.ts` as
`example: air-native (--air-app + renderMode=direct: compile+link only)` (verifying only compile+link, since
`--run` would open a real window and not return; explicitly SKIPped when the vendor library is missing). This
one is **necessary**: before it, no test had ever compiled that path (the directory-type air-native unit does
not carry `--air-app`, and the `--air-app` precedents in `test/unit/build.ts` all carry `--dry`), so defects
like "the neutral seam is implemented only on the D3D12 side, so every macOS GPU build fails to link" could slip
past with the **whole suite green** (measured 2026-10-09). Two additional source-level nails pin that both
backend files must implement the five neutral names (`unit: backendparity`).

---

## 6. Follow-ups

- **A new window-creation path must install the listener + run `sk_pump_frame`** (§2.8): during a drag/resize the
  loop is blocked, so frames can only be driven by the `SDL_AddEventWatch` listener — and it must call the shared
  pump rather than tick once itself, otherwise "multiple windows" and "`frameRate` is not rewritten by dragging"
  each regress. The 16 pins in `unit: platform/WindowFrame` pin exactly this (including "the whole app has exactly
  **one** `on_frame`"); look there first when adding a backend or a window-creation path.
- **Stage3D on Windows**: ✅ **both halves are done** — stage one-hundred-thirty-one's AGAL→HLSL translator (a single
  `target` grown from two tiers to three) + stage one-hundred-thirty-two's `vendor/stage3d_d3d.cc` (the D3D12 side's
  buffer/texture/pipeline/offscreen RT/blend-state cache) + the build wiring
  (`ASC_S3D_HLSL`/`d3d12`/`dxgi`/`d3dcompiler`). **What remains is verification**: a full run of
  `examples/air-starling-demo` on the Windows target, and a real A/B measurement of back-face culling / winding.
- **`sk_gpu_draw_texture`**: ✅ **implemented** (stage one-hundred-thirty-two) — the render target's
  `DXGI_FORMAT` and current `D3D12_RESOURCE_STATE` come from the Stage3D context (`s3d_get_render_target`
  returns the raw `ID3D12Resource*`; the composite takes a temporary `retain()`ed reference). Wrapping it MUST
  `retain()` and **must not** go through `gr_cp`'s raw-pointer constructor — see §2.9.
- The ledger is in `TODO.md`'s `### 遗留待开发` (5 rows registered this round) and the stage
  one-hundred-twenty-six section.