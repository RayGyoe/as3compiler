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
| `32` (default) | `vendor/*/windows-x86` | `i686-pc-windows-msvc` | — |
| `64` | `vendor/*/windows-x64` | `x86_64-pc-windows-msvc` | — |

Three paths switch accordingly: `vendor/skia/lib/windows-xN`, `vendor/sdl2/windows-xN/{lib,include}`,
`vendor/curl/lib/windows-xN`. (`vendor/` is a **checked-in** directory; `build-tools/` is not checked in and is
re-downloaded on Windows.)

---

## 2. Building the Dependency Libraries: `vendor/build-windows-deps.ps1`

```powershell
pwsh vendor/build-windows-deps.ps1 -Arch x64    # produces vendor/*/windows-x64
pwsh vendor/build-windows-deps.ps1 -Arch x86    # produces vendor/*/windows-x86
```

Built from source: **Skia m124** (`build-tools/skia-src`, with `bin/gn` + ninja), **SDL2 2.32.10**,
**curl 8.11.1**, **zlib**, **nghttp2**. The toolchain is LLVM's **`clang-cl`** (MSVC ABI).

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
   (Windows `RemoveDirectoryA`, POSIX `rmdir`, isomorphic to `as_mkdir_one`'s `CreateDirectoryA`/`mkdir`), and
   `deleteDirectory` calls it.

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
- **Not verified**: `examples/air-starling-demo` **has not been run** on the Windows target yet; the culling
  state and winding order are still a paper decision (`FrontCounterClockwise=FALSE` + a positive viewport
  height, no Y flip) with no culling A/B measurement.

See also §2.9 for the Skia D3D `gr_cp` ownership contract that this composite had to satisfy (`retain()`
instead of the adopting bare-pointer constructor) — it is the deepest third-party-API trap this project has hit
so far.

---

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

- **Stage3D on Windows**: ✅ **done** (stage one-hundred-thirty-two) — `vendor/stage3d_d3d.cc` + the HLSL
  translator target + the `ASC_S3D_HLSL`/`d3d12`/`dxgi`/`d3dcompiler` wiring; `examples/shmup-stage3d` runs on
  D3D12 with its frames composited into the window. Remaining: run `examples/air-starling-demo` on the Windows
  target, and settle culling/winding with a real A/B measurement.
- **`sk_gpu_draw_texture`**: ✅ **implemented** (stage one-hundred-thirty-two) — the render target's
  `DXGI_FORMAT` and current `D3D12_RESOURCE_STATE` come from the Stage3D context (`s3d_get_render_target`
  returns the raw `ID3D12Resource*`; the composite takes a temporary `retain()`ed reference).