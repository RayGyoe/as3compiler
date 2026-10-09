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
overwritten once `clang_win` takes effect), with the idempotence marker `ASC-X86-CLANG-PATCH` and CRLF
normalization.

`skia_use_direct3d = true` (turned on in stage one-hundred-twenty-six) has three consequences, none optional:
`SK_DIRECT3D` enters the public defines, the `third_party/d3d12allocator` archive is produced, and the
`d3d12`/`dxgi`/`d3dcompiler` system libraries are needed. **The manifest side must be synchronized** (see §3.2);
changing the gn parameter without changing the manifest equals an explosion at link time.

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

Stage3D's window overlay layer **deliberately still guards on `ASC_RENDER_METAL`** (only renaming `is_gpu`):
Windows' Stage3D errors at manifest time, and `ASC_stage3d_tex` is an `MTLTexture`. On Windows that `#else`
branch is **unreachable** (`ASC_stage3d_ready` is always false).

### 3.4 Stage3D on Windows: Loud Failure at Build Time

When the descriptor or source uses `flash.display3D`, the Windows target raises `AirAppError` — because there is
neither an equivalent of `stage3d_glue.mm` nor an AGAL→HLSL translator (`AGALTranslator.translate` currently
emits only MSL / GLSL ES). This is **not a silent downgrade** but an explicit capability boundary
(AGENTS.md §1.5); the follow-up project is in `TODO.md` stage one-hundred-twenty-six (`vendor/stage3d_d3d.cc` +
`ASC_AGAL_TARGET=hlsl`). Therefore `examples/air-starling-demo` fails at compile time on the Windows target.

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

`sk_gpu_draw_texture` (for Stage3D compositing) is explicitly **unimplemented and vocal** (prints an
explanation once, rather than silently drawing nothing): its only caller is Stage3D compositing, and on Windows
Stage3D is unreachable (§3.4).

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

**Unverified assumptions, item by item** (all of them fail at compile time):

| # | Assumption | Symptom on failure |
|---|---|---|
| 1 | `gr_cp<T>`'s `operator&` is usable in `IID_PPV_ARGS(&x)` | compile error at the address-of (Skia's own reference writes it the same way) |
| 2 | `GrD3DBackendContext` can be `= {}`-initialized and then assigned field by field (field names `fAdapter`/`fDevice`/`fQueue`/`fMemoryAllocator`/`fProtectedContext`) | compile error at the field name |
| 3 | `GrD3DTextureResourceInfo(resource, alloc, state, format, levelCount, sampleCount, protected)` 7-arg constructor | compile error on that line |
| 4 | `SkSurfaces::WrapBackendRenderTarget` can wrap the swapchain back buffer, and `kRGBA_8888_SkColorType` pairs correctly with `R8G8B8A8_UNORM` | color shift / all-black image |
| 5 | `flush(kPresent)` makes Skia do the PRESENT→RENDER_TARGET→PRESENT state transition | DXGI debug layer reports a resource-state conflict / tearing |
| 6 | `Present(1,0)` (wait for vsync) combined with SDL's frame loop causes no extra throttling | frame rate halved |
| 7 | The fence protocol is correct (`buffer_index` stays constant between begin/flush) | occasional tearing / black bands |
| 8 | Tearing down the process-level context at the last window close does not collide with still-in-flight frames | crash on exit |
| 9 | `SDL_GetWindowWMInfo` gives `SDL_SYSWM_WINDOWS` and a valid HWND (SDL2's default win32 video driver) | `sk_attach_d3d` refuses loudly, window has no GPU |
| 10 | `.lib`s produced by `clang --target=x86_64-pc-windows-msvc` and `clang-cl` cross-link successfully | many unresolved symbols at link time |
| 11 | `skia_use_direct3d=true`'s gn parameter set is consistent with the `d3d12allocator` output (the parameter set was verified as accepted on the macOS side via `gn gen`) | `d3d12allocator.lib` missing at link time |
| 12 | x86's `Repair-SkiaX86Toolchain` patch hits idempotently on the real `BUILD.gn` (the anchor and idempotence were verified on the real source) | gn reports `clang_win` not in effect / x86 built as ARM64 with cl.exe |

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

- **Stage3D on Windows**: `vendor/stage3d_d3d.cc` + `ASC_AGAL_TARGET=hlsl` (extending `AGALTranslator` to HLSL +
  the D3D-side buffer/texture/pipeline/offscreen RT/blend-state cache). Until then, Stage3D on Windows always
  errors at build time.
- **`sk_gpu_draw_texture`**: implement it when Stage3D's D3D backend lands (it needs the render target's
  `DXGI_FORMAT` and the current `D3D12_RESOURCE_STATE`, which can only come from the Stage3D context, so it
  cannot be implemented by guessing).