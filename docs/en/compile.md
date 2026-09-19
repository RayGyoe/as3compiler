# as-aot Compilation Guide

> This document explains the complete compilation pipeline, command-line arguments, build manifest, and
> multi-target backends of `as-aot` (as3compiler). It is aimed at users and collaborators who want to
> **compile, link, and produce an executable (or a WASI `.wasm`)**.

## Installation

`as-aot` is published as an npm package (package name `as3compiler`). After installation, the `as-aot`
command is automatically added to PATH:

```bash
# Install globally from the npm registry
npm install -g as3compiler

# Or local development: create a global symlink in the project directory (equivalent to global install)
npm link
```

After installation you can invoke it directly (all examples in this document use the `as-aot` command):

```bash
as-aot examples/hello.as --run
```

When not installed, use an equivalent form (the two are equivalent; note that npm script argument passing
requires a `--` separator):

```bash
node src/index.ts examples/hello.as --run
npm run compile -- examples/hello.as --run
```

## 1. Compilation Pipeline Overview

The `as-aot` frontend only does "translation": it compiles an ActionScript 3 subset into **readable C**, and
hands optimization and machine-code generation to a mature C compiler (`cc`/`clang -O2`), not reinventing the
wheel (same idea as TypePHP).

```
ActionScript source (.as)
        │  lexer.ts      lexical analysis (tokens)
        ▼
        │  parser.ts     recursive-descent parsing (AST)
        ▼
        │  codegen.ts    semantics + C code generation
        ▼
       C source (.c)                    ← kept on disk, for reading
        │  build.ts      build orchestration (build manifest JSON + -I/-L/-l/-D + --target)
        ▼
  ┌──────┴────────┐
  │ native          │  cc/clang -O2 -lm             → native executable (Mach-O / ELF / PE)
  │ wasm            │  clang --target=wasm32-wasip1   → WASI .wasm
  └────────────────┘
```

Key division of labor (see [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) §2.8):

| Module | Responsibility |
|---|---|
| `src/index.ts` | CLI argument parsing, pipeline orchestration, error handling |
| `src/build.ts` | Build orchestration: build-manifest parsing, link configuration, multi-target compile-command generation |
| `src/codegen.ts` + `src/emit.ts` + `src/runtime.ts` | Semantic analysis + C emission (frontend; does not touch linking) |

## 2. Environment Dependencies

- **Node ≥ 22.6**: native type-stripping runs `.ts` source directly, no compilation step required.
- **C compiler**: `cc` / `clang` (native target defaults to `cc`; override with `--cc`).
- **WASI toolchain** (only needed for `--target wasm`): WASI SDK or LLVM clang with a `wasm32-wasip1` backend.
  - By convention the environment variable `WASI_SDK_HOME` points to the SDK root; the compiler is at
    `$WASI_SDK_HOME/bin/clang`, and the sysroot at `$WASI_SDK_HOME/share/wasi-sysroot`.
  - When not installed, an actual `--target wasm` compile reports a clear "WASI toolchain missing" message
    (with install instructions) instead of leaking clang's low-level `'stdio.h' file not found`; `--dry` can
    still preview the compile command.
  - AS3 exceptions (`throw`/`try`/`catch`/`finally`) map to `setjmp`/`longjmp` in the generated C; WASI does
    not support them by default, so wasm compilation appends `-mllvm -wasm-enable-sjlj` (the WebAssembly
    exception-handling proposal). The resulting artifact requires an exception-handling-capable runtime such
    as wasmtime/wasmer; wasm3 does not support this proposal.

## 3. Command-line Usage

```text
Usage: as-aot <input.as> [more.as ...] [options]

Options:
  -o <path>      output path (native: executable; wasm: .wasm appended)
  --run          run the compiled output after building
  --cc <name>    C compiler to use (default: cc)
  --target <t>   native (default) | wasm (WASI)
  --package <p>  raw (default) | xcode-project (macOS .app) | android-project | web (browser)
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

### 3.1 Basic Compilation

```bash
# Compile: generate the same-named .c and produce an executable (default output = path with .as suffix removed)
as-aot examples/hello.as

# Compile and immediately run
as-aot examples/fib.as --run

# Specify output name / specify C compiler
as-aot examples/class.as -o build/class --cc clang --run
```

Every compilation leaves a same-named `.c` file next to the input `.as` (with `-o`, a `<output-name>.c` is
left), which can be read directly — this is the core selling point of "generating readable C".

### 3.2 Multi-file Compilation

Multiple `.as` files are merged into **one translation unit** (parsed, ASTs merged, then emitted together):

```bash
as-aot a.as b.as -o prog --run
```

`package` / `import` namespace isolation and cross-file symbol resolution are handled by codegen.

### 3.3 WASM Target

```bash
# Produce .wasm (requires WASI SDK, or clang with a wasm32 backend)
as-aot examples/hello.as --target wasm

# Only print the compile command, don't actually compile (verify command correctness without a toolchain)
as-aot examples/hello.as --target wasm --dry
```

`--run` under the wasm target runs the artifact with a WASI runtime, probing in the order
`wasmtime → wasmer → wasm3`, and errors out if none is installed. Because the wasm artifact declares the
exception-handling feature (see §2), it requires wasmtime/wasmer to run; wasm3 does not support the
exception-handling proposal.

#### Exporting functions for direct JS calls

By default `--target wasm` produces a **WASI command module** that only exports `memory` and `_start`
(`_start` runs once, then calls `proc_exit` to end the instance). To let browser JS call a function
repeatedly (mirroring Emscripten's `cwrap`), use `--export <name>` to add the corresponding C symbol to the
export table:

```bash
as-aot examples/wasm-native/fib.as --target wasm --export fib -o fib-export
```

The top-level AS3 function `function fib(n:int):int` generates a same-named C global function, and
`--export fib` makes it appear in `instance.exports.fib`. JS directly calls `instance.exports.fib(40)`,
without needing `_start`, without capturing stdout, and can call it repeatedly (provided the function does
not depend on global state established by libc constructors in `_start` — pure computational functions
naturally satisfy this). See the example page `examples/wasm-native/fib-export.html`.

**Declarative export `[WasmExport]`**: when crossing multiple libraries/namespaces, manually spelling out the
long C symbol name (e.g. `foo_bar_Baz_twice`) is error-prone. Instead, declare it in source via AS3 metadata;
the compiler collects it automatically and injects `--export`, so you don't have to remember symbol names on
the command line:

```as3
package mathlib {
    [WasmExport]                    // JS calls it by the C symbol name
    function add(a:int, b:int):int { return a + b; }

    [WasmExport("multiply")]        // JS calls it by the alias multiply
    function mul(a:int, b:int):int { return a * b; }

    class Calc {
        [WasmExport("twice")]       // static method exported as twice (symbol mathlib_Calc_twice)
        public static function twice(a:int):int { return a * 2; }
    }
}
```

```bash
as-aot export-meta.as --target wasm
```

Semantics and limitations:
- Can only mark **functions with no `this`** — top-level functions and static methods; instance methods carry
  a `void* _this` (and JS cannot construct GC-heap class instances), and getter/setter signatures are special,
  so marking them is a **compile-time error** rather than silent ignoring.
- Marking `[WasmExport]` without arguments exports by the generated C symbol name; `[WasmExport("alias")]`
  additionally generates a same-named forwarding wrapper that JS calls by `alias`.
- The `--export` command-line argument and `[WasmExport]` marks are **merged** (deduplicated) and can be used
  together.
- On successful compilation, a `*.exports.json` export manifest is generated next to the `.wasm`, recording
  `name` (JS export name), `symbol` (C symbol), `returnType`, and `params` item by item, for the host to read
  the calling contract. See `examples/wasm-native/export-meta.as`.

### 3.4 Linking Third-party Libraries

The frontend only translates; heavy lifting like graphics (skia/cairo/SDL) and regex is brought in by
**linking**, not embedded into the `.c`:

```bash
# Declare include paths / library paths / libraries / macro defines on the command line (all repeatable)
as-aot app.as -I vendor/include -L vendor/lib -l skia -D USE_SKIA=1

# Or use a build manifest (recommended; versionable and reusable)
as-aot app.as --manifest examples/skia-link.build.example.json
```

### 3.5 AIR Application Descriptor (--air-app)

Parse an AIR `app.xml`, automatically generate bootstrap startup code + build manifest, and migrate a
pure-AS AIR project to as-aot in one step:

```bash
# One command: parse app.xml -> generate bootstrap + manifest -> compile/link into a windowed executable
as-aot --air-app examples/air-native/air-native-app.xml

# Explicitly specify the main class (app.xml has no document class; default scans src/**/Main.as to infer)
as-aot --air-app examples/air-native/air-native-app.xml --main-class demo.Main

# Compile the same AIR project directly to the browser (--target wasm --package web): auto-switch to the web backend
as-aot --air-app examples/air-native/air-native-app.xml --target wasm --package web
```

Flow: parse `<id>/<filename>/<initialWindow>` (`title`/`width`/`height`/`visible`/`resizable`/
`requestedDisplayResolution`/`renderMode`) →
generate bootstrap code equivalent to `boot-gui.as` (`new Stage()` → preset `stageWidth/stageHeight` →
`new Main()` → `addChild` → `showWindow`; when `visible=false`, use offscreen `render` to output PNG) →
recursively scan `src/**/*.as` (skip reverse-domain third-party library directories `com/org/net`, but
explicitly re-add the GreenSock core `TweenLite/TweenCore/SimpleTimeline/PropTween/TweenPlugin` actually used
by the air-native demo) →
write `<filename>.build.json` in the same directory as app.xml (linking Skia + SDL2) →
compile/link into the `<filename>` executable (output name overridable with `-o`).

**Web target** (under `--air-app ... --target wasm --package web`): the `--air-app` adapter automatically
switches to the browser backend — the build manifest switches to `web_glue.cc` (replacing `window_glue.cc`)
+ the wasm build of Skia (`vendor/skia/lib/wasm`), drops the macOS frameworks SDL2/`objc`/Cocoa, and fonts are
provided by `app.xml`'s `<embedFonts>` (reads each `<font><fontPath>` to generate `font-urls` for runtime
injection, falling back to `fonts/Arial.ttf` when absent; the wasm sandbox has no system fonts, see
[`html5-web.md`](html5-web.md) §4). The rest of the flow (parsing app.xml, scanning src, generating bootstrap
code) is identical to native, and the artifacts are `<filename>.html` + `.js` + `.wasm`.

Four key behaviors aligned with adl:
- `<resizable>false</resizable>` → build manifest adds `ASC_WINDOW_FIXED=1`; window creation omits
  `SDL_WINDOW_RESIZABLE`, yielding a fixed-size window consistent with adl.
- `<requestedDisplayResolution>high</requestedDisplayResolution>` → build manifest adds `ASC_DISPLAY_HIGH=1`;
  the window opens `SDL_WINDOW_ALLOW_HIGHDPI` and the surface is created with physical pixels at device scale
  (Retina is not blurry); `standard` or omitted keeps 1x (consistent with adl, stretched by the compositor).
- `<renderMode>` controls the GPU/CPU rendering split: `direct`/`gpu` → the build manifest adds a GPU define,
  and the backend switches the Skia surface from `SkSurfaces::Raster` to Ganesh `GrDirectContext`, compositing
  the whole frame on the GPU (efficiency-first, not aligning with AIR's official "direct = CPU compositing +
  GPU blit" split). The web target goes through WebGL2, adding `ASC_RENDER_GPU=1`, and presentation is just
  `GrDirectContext::flush`; the native target goes through Metal (`GrDirectContext(Metal)` +
  `SDL_Metal_CreateView`/`CAMetalLayer`), adding `ASC_RENDER_METAL=1` and additionally linking
  `vendor/metal_glue.mm` (Objective-C++), taking a one-shot drawable from `CAMetalLayer` each frame, wrapping
  it into a `GrBackendRenderTarget` to render, and after `flushAndSubmit` doing `presentDrawable`+`commit`.
  `cpu`/`auto` (default) keep pure software raster (web uses `putImageData`, native uses an SDL streaming
  texture).
- The bootstrap code presets `stage.stageWidth/stageHeight` **before** `new Main()`, so that during document
  class construction `trace(stage.stageWidth, stage.stageHeight)` returns the window size (e.g. `1000 680`)
  rather than `0 0` outside adl.

## 4. Build Manifest

A JSON file, analogous to TypePHP's `project.yml`, used to fix reusable, versionable build configuration. JSON
was chosen over YAML to keep **zero third-party dependencies** (Node parses JSON natively). Field names use
kebab-case.

| Field | Type | Description |
|---|---|---|
| `target` | `"native" \| "wasm"` | Target platform, default `native` |
| `package` | `"raw" \| "xcode-project" \| "android-project" \| "web"` | Distribution form, default `raw` (§6); `web` requires `target=wasm`, producing browser artifacts (see [`html5-web.md`](html5-web.md)) |
| `c-compiler` | string | C compiler, default `cc` |
| `opt` | string | Optimization flags, default `-O2` |
| `sources` | string[] | Extra C/C++ source files (compiled together with the generated `.c`) |
| `include-paths` | string[] | Header search paths (→ `-I`) |
| `link-libs` | string[] | Libraries to link (→ `-l`) |
| `link-paths` | string[] | Library search paths (→ `-L`) |
| `defines` | string[] | Preprocessor macros (→ `-D`) |
| `objects` | string[] | Precompiled `.o` added directly to the link |
| `frameworks` | string[] | macOS frameworks (→ `-framework X`, needed for Skia's CoreText/CoreGraphics backend) |
| `font-urls` | string[] | Font byte-stream URL list (`--package web` writes it into `index.html`, network-loaded and injected into Skia at runtime; see [`html5-web.md`](html5-web.md) §4) |
| `bundle-id` | string | app identifier (`--package xcode-project` fills `Info.plist`'s `CFBundleIdentifier`, default `com.example.<product>`) |
| `display-name` | string | app display name (fills `CFBundleName`, default product name) |
| `icon` | string | `.icns` path (relative to manifest dir, copied into `Resources` + fills `CFBundleIconFile`) |
| `deployment-target` | string | macOS minimum version (fills `MACOSX_DEPLOYMENT_TARGET`, default `12.0`) |

Path-type fields (`sources` / `include-paths` / `link-paths` / `objects`) resolve **relative to the directory
containing the manifest file** (same as TypePHP's YAML path rule). See
[`examples/skia-link.build.example.json`](../../examples/skia-link.build.example.json):

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
  "link-paths": ["../vendor/skia/lib/macos-arm64"],
  "frameworks": ["CoreFoundation", "CoreGraphics", "CoreText", "CoreServices",
    "ApplicationServices", "ImageIO", "Accelerate"],
  "defines": ["ASC_USE_SKIA=1"],
  "objects": []
}
```

**Priority**: CLI arguments override same-named manifest fields (mirroring TypePHP's "CLI beats YAML").
Merge order: default config → manifest → CLI overrides.

## 5. Multi-target Backends

| Target | Compile command | Artifact |
|---|---|---|
| `native` (default) | `cc -O2 -lm -o <out> <c> [sources] -I... -D... [objects] -L... -l... [-framework X]` | Mach-O / ELF / PE executable |
| `wasm` | `clang --target=wasm32-wasip1 [--sysroot=...] -mllvm -wasm-enable-sjlj -O2 -o <out>.wasm <c> ...` | WASI `.wasm` |
| `native` + `--package xcode-project` | generates `.xcodeproj` (§6.5), driven by Xcode/xcodebuild | macOS `.app` bundle (`Contents/MacOS/<bin>` + `Info.plist`) |
| `wasm` + `--package web` | `emcc` (Emscripten, requires `EMSDK_HOME`) compiles C/C++ sources + links the wasm Skia, `INVOKE_RUN=0` | `.wasm` + `.js` + `index.html` (browser HTML5 rendering, see [`html5-web.md`](html5-web.md)) |

Platform coupling points are isolated in `runtime.ts`'s `RUNTIME_PREAMBLE`, using `#ifdef __wasi__`
conditional compilation. The only current platform difference is `as_now_ms()`:

- native: `gettimeofday`, millisecond precision
- WASI: `time(NULL)`, degraded to second precision (wasi-libc folds libm, so no separate `-lm` needed)

> If the local machine uses Apple clang (no `wasm32-wasip1` target) and WASI SDK is not installed, wasm can
> only `--dry` to verify the command; actual compilation requires installing the toolchain first (see §2).

## 6. Compile Backend vs Distribution Form

> This section answers: `--target native` already produces a bare executable, so how should `.app` /
> `.dmg` / Windows `.exe` / Xcode projects / Android projects be handled — by flattening them into more
> `--target` values, or by splitting them out? Conclusion: **split into two orthogonal dimensions**. The
> `xcode-project` form is implemented (as a macOS application target).

The current pipeline's mental model is "one AS → one readable C → one bare executable". Half of those
artifacts are "switching the compile backend"; the other half are "how to organize after compiling". These
should not be conflated in a single `--target`.

### 6.1 Two orthogonal dimensions

| Dimension | Argument | Governs | Underlying action |
|---|---|---|---|
| Compile backend | `--target` | Machine-code ABI: which clang triple, which sysroot/SDK | changes the `cc/clang` command |
| Distribution form | `--package` | How to organize after compiling (bundle, image, project file) | a **post-processing step** in the build layer |

**Dimension A: `--target` (compile backend)** keeps existing semantics, only extending values:

| Value | Meaning | Underlying |
|---|---|---|
| `native` (default) | host-system executable | existing `cc -O2 -lm -lz` |
| `wasm` | WASI `.wasm` | existing |
| `ios` (planned) | iOS / simulator | `clang --target=arm64-apple-ios / arm64-apple-ios-simulator` + iPhone SDK |
| `android` (planned) | Android | NDK clang `--target=aarch64-linux-android` + NDK sysroot |

**Dimension B: `--package` (distribution form)**:

| Value | Artifact | Description | Status |
|---|---|---|---|
| `raw` (default) | bare executable / bare `.wasm` | unchanged, zero behavior change (quick CLI verification, local debugging) | implemented |
| `xcode-project` | `.xcodeproj` (or CMake project) | generate a macOS application project skeleton + build script, handed to Xcode for build/debug/signing | **implemented (macOS application, §6.5)** |
| `android-project` | Gradle + NDK project | generate `build.gradle` + `CMakeLists.txt` + JNI/native-activity bridge | planned |
| `web` | `.wasm` + `.js` + `index.html` | use emcc to produce a browser HTML5 rendering page (`target=wasm`, see §6.6 and [`html5-web.md`](html5-web.md)) | **implemented (§6.6)** |

**Target audience: `xcode-project` / `android-project` serve IDE developers only**, so these two forms
provide **no `app` / `dmg`**; `web`, like `raw`, is a "one compile call + post-processing" (emcc compile +
`index.html` generation) that directly produces browser-loadable final artifacts.

- `app` / `dmg` is the **script route** — `build.ts` directly invokes `cc/clang` + `codesign` + `hdiutil` to
  produce the final artifact in one shot, aimed at CI / quick packaging / no human intervention; `xcode-project`
  is the **IDE route** — "generate a project, let Xcode drive", aimed at long-term development, breakpoint
  debugging, and signing for distribution. The two are **parallel routes** that both end at `.app`, but not an
  inclusion relationship where the "advanced form replaces the low-level form".
- Since they only serve IDE developers, the script route (`app` / `dmg`) is cut entirely, and the distribution
  forms converge to `raw` + two project generators + `web`.

**`xcode-project` currently produces a macOS application**: `--package xcode-project` only supports
`--target native` for now (macOS application); the iOS/Android project generators are not yet implemented.
When it later grows to multiplatform, the platform range moves into the manifest's `deployment-targets`,
selected by Xcode's destination, and `--target` no longer pins the platform for the project — but it is still
macOS-only today (the SDL2/Skia static libraries only have macOS arm64 builds).

### 6.2 Why split this way

1. **`xcode-project` / `android-project` are "generate project files", not "one cc invocation"**. The compile
   backend still produces Mach-O / ELF; the project generator organizes the compile command + dependencies +
   resources into an `.xcodeproj` / Gradle skeleton. So they are an independent generation step in the build
   layer, not compile arguments.
2. **Windows `.exe` needs no new argument**. `native` on Windows is already a PE executable; the only small
   gap is that `-o app` does not auto-append `.exe` (only the wasm branch appends a suffix).
3. **Project metadata goes into the manifest, not flattened into CLI flags**. The generator needs a lot of
   metadata — bundle id, icon, signing, min SDK, permissions, resources — these are *configuration*, not
   *arguments*, carried by the existing manifest (see §4).

### 6.3 Recommended CLI form

```bash
# unchanged behavior
as-aot examples/hello.as --run

# macOS application project (implemented)
as-aot src/Main.as --target native --package xcode-project --manifest macos.json

# iOS project (switch backend + generate project, complex metadata via manifest; planned)
as-aot src/Main.as --target ios     --package xcode-project --manifest ios.json

# Android project (planned)
as-aot src/Main.as --target android --package android-project --manifest android.json
```

### 6.4 manifest extension fields (partially implemented)

Complex project metadata is added to the §4 build manifest (kebab-case, path-type fields resolve relative to
the manifest directory). The four macOS application (`xcode-project`) fields are implemented and used in §6.5:

| Field | Description | Status |
|---|---|---|
| `bundle-id` | app identifier (fills `CFBundleIdentifier`, default `com.example.<product>`) | ✅ implemented |
| `display-name` | display name (fills `CFBundleName`, default product name) | ✅ implemented |
| `icon` | `.icns` path (copied into `Resources` + fills `CFBundleIconFile`) | ✅ implemented |
| `deployment-target` | macOS minimum version (fills `MACOSX_DEPLOYMENT_TARGET`, default `12.0`) | ✅ implemented |
| `permissions` | Android manifest permissions / iOS Info.plist usage descriptions | planned |
| `resources` | extra files to copy into the bundle / project resources | planned |
| `ndk-abi` | Android target ABI list (e.g. `arm64-v8a`) | planned |
| `signing-identity` | code-signing identity (currently ad-hoc `-`) | planned |

Landing order: `xcode-project` (macOS application) is done → next `android-project` (the heaviest project
generator) → then multiplatform destination and formal signing.

### 6.5 `xcode-project` (implemented, macOS application)

`--target native --package xcode-project` organizes the generated **readable C** plus the manifest's extra
sources, include paths, link libs, frameworks and defines into a macOS **application** `.xcodeproj` (the
artifact is an `.app` bundle) for an IDE developer to open, build, and debug — a "generate project" step, not
a single `cc` invocation:

```bash
as-aot src/Main.as --target native --package xcode-project -o build/Main
# generates build/Main.xcodeproj + build/Main/Info.plist + a shared scheme

open build/Main.xcodeproj                          # open the project
# or build from the command line (no need to open Xcode)
xcodebuild -project build/Main.xcodeproj -scheme Main -configuration Debug build
# the artifact is build/…/Debug/Main.app (Contents/MacOS/Main + Contents/Info.plist + resources)
open build/…/Debug/Main.app                        # launch the real App
```

Upgrading from "command-line tool" to "application" turns the artifact from a bare Mach-O into a real macOS
App with bundle identity, Dock icon, menu bar, and sign-for-distribution capability. The generated AS3 C is
still `int main(void)` — the SDL2 event loop (`ASC_USE_WINDOW=1`) runs from `main`; the bundle + `Info.plist`
only add an app identity, and runtime behavior is identical to raw.

Implementation notes (`src/xcode-project.ts`):

- **Target type**: `com.apple.product-type.application` (`wrapper.application`), `buildPhases` includes
  Sources + Frameworks + **Resources**; artifact `Contents/MacOS/<bin>` + `Contents/Info.plist`.
- **`Info.plist` generation**: writes `<outDir>/<product>/Info.plist`; `CFBundleIdentifier`/
  `CFBundleExecutable`/`LSMinimumSystemVersion` are injected via `$(PRODUCT_BUNDLE_IDENTIFIER)`/
  `$(EXECUTABLE_NAME)`/`$(MACOSX_DEPLOYMENT_TARGET)` to stay in sync with build settings; `CFBundleName` is
  filled with `display-name` (default product name); `CFBundleIconFile` is only written when the manifest
  provides `icon`.
- **App metadata from the manifest** (§6.4): `bundle-id`/`display-name`/`icon`/`deployment-target` fall into
  `PRODUCT_BUNDLE_IDENTIFIER`/`CFBundleName`/Resources phase + `CFBundleIconFile`/`MACOSX_DEPLOYMENT_TARGET`;
  `icon` (absolute-path file ref) is copied into `Contents/Resources/`.
- **Ad-hoc signing**: `CODE_SIGN_STYLE = Manual` + `CODE_SIGN_IDENTITY = "-"`, so `xcodebuild` produces a
  runnable `.app` with no provisioning profile or Apple ID (ad-hoc); formal distribution adds
  `signing-identity` in the manifest (§6.4, planned).
- **Compile config mirrors the raw link**: `OTHER_LDFLAGS` always contains `-lm -lz` then the manifest's
  `link-libs`/`objects`/`frameworks`; `HEADER_SEARCH_PATHS`/`LIBRARY_SEARCH_PATHS` mirror
  `include-paths`/`link-paths`; `GCC_PREPROCESSOR_DEFINITIONS` mirrors `defines`; `GCC_OPTIMIZATION_LEVEL` is
  mapped from `--opt`'s `-O{0,1,2,3,s}`. Path-type fields are written as absolute paths.
- **Disable `-fmodules` (critical)**: the generated C uses bare type names (`Point`/`Rectangle`…) that collide
  with macOS SDK types (e.g. `MacTypes.h`'s `Point`). Raw `cc` is fine because Apple clang does not enable
  `-fmodules` by default; Xcode does, and would let the SDK's `Point` shadow the generated struct (causing
  `no member named 'x' in 'struct Point'`). So the project explicitly sets `CLANG_ENABLE_MODULES = NO`.
- **C/C++ layering**: the generated `.c` stays C99 (`GCC_C_LANGUAGE_STANDARD = c99`); C++ glue layers
  (`skia_glue.cc` etc.) use C++17 (`CLANG_CXX_LANGUAGE_STANDARD = "c++17"` + `CLANG_CXX_LIBRARY = "libc++"`),
  dispatched by file extension.
- **Shared scheme**: generates `xcshareddata/xcschemes/<NAME>.xcscheme` (`BuildableName = <NAME>.app`) so
  `xcodebuild -scheme NAME` resolves without opening Xcode.

#### 6.5.1 Smart merge (preserving Xcode hand edits)

The generator does **not** overwrite an existing `.xcodeproj` by default. IDE developers hand-edit build
settings, schemes, and add files/resources inside Xcode; regenerating the whole project on every recompile
would clobber those edits. So the generator performs an **object-level smart merge**:

- **First run** (project absent): fully generate `.xcodeproj` + `Info.plist` + a shared scheme, and record the
  managed source set (the generated `.c` + manifest `sources`) into a `.as3aot-managed.json` sidecar inside
  the project.
- **Later runs** (project present): parse the existing `project.pbxproj` (`src/pbxproj.ts`) and **only add/remove
  the source files we manage** (diffing the sidecar's old set against the new set). Every other object — the
  developer's hand-edited build settings, schemes, self-added files/resources — is preserved as-is.
  - Source list unchanged → no file write; prints `unchanged; hand edits preserved`.
  - Source list changed (added/removed `.c` or manifest `sources`) → updated in place; prints
    `source list updated; hand edits preserved`.
- **Identification is by absolute path**: only `sourceTree = "<absolute>"` file refs are managed; user-added
  relative-path files are left alone. Xcode's `/* comments */` are dropped by the parser (pure readability
  hints, no semantic weight) and regenerated on Xcode's next save.
- The extra `.as3aot-managed.json` (recording the managed source set) is ignored by Xcode and does not affect
  the build.

To force a full regeneration, delete the `.xcodeproj` and re-run.

### 6.6 `web` (implemented, browser HTML5 rendering)

`--target wasm --package web` compiles the generated **readable C** + C++ glue layer with Emscripten `emcc`
into browser artifacts (`.wasm` + `.js` + `index.html`), running Skia CPU rasterization + the event loop
inside `<canvas>`:

```bash
export EMSDK_HOME=/path/to/emsdk   # emcc is at $EMSDK_HOME/upstream/emscripten/emcc

as-aot examples/web/hello-web.as \
  --manifest examples/web/hello-web.build.json
# artifacts: hello-web.html + hello-web.js + hello-web.wasm
```

Browsers cannot `file://`-load wasm directly; serve over HTTP (`python3 -m http.server`) and open the `.html`.

Differences from a native manifest (§4):

- **`package = "web"`** with `target = "wasm"` (`web` hard-requires wasm).
- **`font-urls`**: font byte-stream URL list, written into `index.html`'s bootstrap script, `fetch`-loaded and
  injected into Skia at runtime (the wasm sandbox has no system fonts; see [`html5-web.md`](html5-web.md) §4).
- **No `zlib`**: web linking uses `-s USE_ZLIB=1` (Emscripten provides zlib headers and symbols); an explicit
  `-l zlib` may conflict.

Implementation notes (`src/build.ts` `buildWebCompileSteps()` + `src/index.ts` `writeWebIndex()`):

- **emcc location**: `EMSDK_HOME` points at the emsdk root, emcc is its `upstream/emscripten/emcc`.
- **C/C++ split**: the generated `.c` goes through the C path; `skia_glue.cc`/`web_glue.cc` use `-std=c++17`.
- **`SK_TRIVIAL_ABI` matching**: the wasm `libskia.a` is built with `is_trivial_abi=true`, so the C++ glue
  must carry `-D SK_TRIVIAL_ABI=[[clang::trivial_abi]]` (added automatically by `build.ts`); otherwise a
  runtime `unreachable` crash occurs.
- **`EXPORTED_FUNCTIONS`**: explicitly exports `_main`/`_malloc`/`_free`/`_sk_fontmgr_register_data` (the font
  injection bootstrap depends on them; omitting them fails font injection or leaves main unstarted).
- **`INVOKE_RUN=0`**: JS calls `Module._main()` only after font injection completes.

Full architecture, font-injection flow, and known limitations are in [`html5-web.md`](html5-web.md).

## 7. Windowing (SDL2 backend)

Under `--target native` there are three build forms, jointly determined by **source + build manifest** (the
GUI switch is not in `--target`, but in `Stage.showWindow(...)` in source and the `ASC_USE_WINDOW=1` macro in
the manifest):

| Form | Compile command | Key `defines` | Key `sources` / `-l` |
|---|---|---|---|
| Pure command-line (no graphics) | `as-aot examples/hello.as --run` | none | none (default `cc -O2 -lm`) |
| Offscreen rendering (Skia outputs PNG, no window) | `as-aot app.as --manifest examples/skia-link.build.example.json` | `ASC_USE_SKIA=1` | `skia_glue.cc` + `-l skia ...` |
| GUI window (SDL2 blit + event loop) | `as-aot examples/window_click.as --manifest examples/window_click.build.example.json` | `ASC_USE_SKIA=1` + `ASC_USE_WINDOW=1` | `skia_glue.cc` + `window_glue.cc` + `-l SDL2 -l objc` |

Core mechanism: `ASC_USE_WINDOW=1` decides whether `Stage.showWindow(...)` actually pops a window and enters
the event loop, or degrades to a no-op (see the conditional compilation in `runtime.ts` below). So the same
`.as` can switch between "offscreen PNG" and "GUI window" simply by changing the manifest, without modifying
source.

`--target native` by default produces a **command-line executable** (offscreen CPU raster → PNG, then exit).
To pop a real native window on macOS and enter the event loop, use `Stage.showWindow(width, height, title)`;
it blits the offscreen Skia surface's pixels to an SDL2 window via `vendor/window_glue.cc` (the event loop
handles `SDL_QUIT`/redraw, and forwards mouse input via function-pointer callbacks back to the AS3 event
system, supporting click interaction and post-event re-rendering).

**Environment requirement**: SDL2 must be **arm64** (matching the arm64 Skia static library). If the local
machine already has x86_64 `brew install sdl2` (Intel Homebrew, installed at `/usr/local`), linking directly
will report `file built for macOS-x86_64`; reinstall with arm64 Homebrew (`/opt/homebrew`), or, as this project
does, **compile an arm64 static library from source** into `vendor/sdl2/arm64/` (`include/` + `lib/`,
`configure --host=arm64-apple-darwin --disable-shared`).

Compile (equivalent to the build manifest below):

```bash
as-aot examples/window.as --manifest examples/window.build.example.json
```

The build manifest [`examples/window.build.example.json`](../../examples/window.build.example.json)
additionally declares, on top of Skia:

- `sources` adds `../vendor/window_glue.cc` (SDL2 window + blit + event loop);
- `include-paths` adds `../vendor/sdl2/arm64/include`, `link-paths` adds `../vendor/sdl2/arm64/lib`;
- `link-libs` adds `SDL2`, `objc` (SDL2 static linking needs the Objective-C runtime);
- `frameworks` adds `CoreVideo`/`Cocoa`/`Carbon`/`IOKit`/`Metal`/`QuartzCore` (SDL2's macOS video/Metal
  rendering backend dependencies);
- `defines` adds `ASC_USE_WINDOW=1` (`ASC_USE_SKIA=1` still required); Retina hi-DPI additionally adds
  `ASC_DISPLAY_HIGH=1`.

Retina hi-DPI rendering (`ASC_DISPLAY_HIGH=1`):

- SDL2 by default does not give the window a native-resolution drawable (drawable == logical size), so Skia
  frames drawn at logical points get stretched 2x by the macOS compositor → blurry text. This is exactly AIR's
  `standard` behavior; `high` requires actively enabling `ALLOW_HIGHDPI`.
- `window_glue.cc`'s `sk_window_probe_scale(w, h, highdpi, &pw, &ph)` first opens a hidden +
  `ALLOW_HIGHDPI` window and reads the physical pixel size and scale via `SDL_GL_GetDrawableSize` — because
  the Skia surface must be created with physical pixels **before** the window exists. Both `Stage.render` and
  `Stage.showWindow` get the scale via `as_window_device_scale()`, and draw in logical coordinates after
  `scale(scale, scale)` on the canvas, so the coordinate system in AS3 code is unchanged.
- `Stage.contentsScaleFactor` returns the measured scale (2.0 on Retina, 1.0 under `standard`). Note it is
  only written during `render`/`showWindow`; the document class reads the initial `1.0` during construction.
- Verification: `screencapture -x -o -l<windowid> out.png` then check the size; a 2x window should be twice
  the logical size (e.g. a 1000×712 window → 2000×1424 image).

Key implementation points:

- `vendor/skia_glue.cc` exposes `sk_surface_peek_pixels` (the pixel buffer of a CPU raster surface);
  `window_glue.cc` wraps that buffer directly with `SDL_CreateRGBSurfaceFrom` (zero-copy), and blits via
  `SDL_Texture` + `SDL_RenderCopy`.
- Skia's `kN32` premul in little-endian macOS memory order is R,G,B,A (each uint32 pixel reads as
  0xAABBGGRR), so the SDL channel masks are `R=0x000000FF`/`G=0x0000FF00`/`B=0x00FF0000`/`A=0xFF000000`
  (R/B reversed); using 0xAARRGGBB order would swap red and blue.
- `window_glue.cc`'s top has `#define SDL_MAIN_HANDLED` to prevent SDL from redefining the generated
  `int main(void)` as `SDL_main`.
- When `ASC_USE_WINDOW` is not defined, `Stage.showWindow` degrades to a no-op (pure-C builds still compile
  and run; see `as_skia_surface_show_window` conditional compilation in `runtime.ts`).
- **Mouse event bridging**: `sk_window_show` adds two function-pointer parameters `on_mouse`/`on_redraw` (the
  glue layer is compiled as C++ and doesn't know the generated C function names, so callbacks decouple them).
  Left-button `mouseDown`/`mouseUp`/`click` are forwarded via `on_mouse` (window-relative coordinates + event
  type string); `ASC_window_on_mouse` emitted by `emit.ts` routes to `Stage_dispatchMouse` (hit testing +
  bubbling); after each event `on_redraw` (`ASC_window_on_redraw`) re-rasterizes the display tree and rebuilds
  the SDL texture for blitting, so listener-driven color changes reflect immediately in the window. See
  `examples/window_click.as`.
- **Window resize control (stage forty-five)**: `present_frame` uses an explicit `SDL_Rect dst={0,0,w,h}`
  rather than `dst=NULL` — the latter stretches the texture to fill the render target, so after a window
  resize the target size changes while the surface doesn't, distorting content non-uniformly. The event loop
  handles `SDL_WINDOWEVENT_SIZE_CHANGED`, re-queries logical/physical sizes, then calls the `on_resize`
  callback, and the AS3 side rebuilds the physical-pixel surface and re-renders (surface ownership is on the
  AS3 side, and the callback returns the new pointer). `scaleMode`/`align` are implemented as real canvas
  transforms (`noScale` fixes content, `showAll`/`noBorder` scale uniformly, `exactFit` scales non-uniformly;
  align's eight values allocate leftover space); under `noScale`, `stageWidth/Height` track the real window
  size and dispatch `Event.RESIZE`. Mouse/wheel coordinates need the inverse transform `(x-ox)/cx` to hit
  correctly after scaling/offsetting.
- **Mouse wheel (stage forty-five)**: `SDL_MOUSEWHEEL` is forwarded via `on_wheel` (`SDL_GetMouseState`
  fetches coordinates, because wheel events carry no position); `ASC_window_on_wheel` routes to
  `Stage_dispatchWheel`: when a TextField is hit, it auto-scrolls (measured in adl: 1 delta = 1 line,
  `scrollV -= delta`, clamped to `[1,maxScrollV]`), then dispatches a bubbling `MouseEvent.MOUSE_WHEEL`. See
  `examples/wheel.as` (pure-C regression, driven directly by `stage.dispatchWheel(...)`).

> The windowed artifact in `raw` form is still a Mach-O executable (runnable from the command line and pops a
> window); for a "double-click-to-run" macOS `.app` (`MyApp.app/Contents/MacOS/...` + `Info.plist`), use
> `--package xcode-project` to generate an application project (§6.5), and Xcode builds the `.app` bundle.

## 8. Related Documents

- [`README.md`](../../README.md) — project overview, supported language subset, type mapping, current
  limitations
- [`TODO.md`](../../TODO.md) — staged roadmap (stage twenty-nine is "build manifest + multi-target backend")
- [`as3-semantics.md`](as3-semantics.md) — AS3 semantic-fidelity red lines and specification sources
- [`html5-web.md`](html5-web.md) — browser rendering target (`--target wasm --package web`) implementation and usage
- [`skia.md`](skia.md) — rendering backend (Skia rasterization + wasm font injection)
- [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) — development conventions (§2.9 build & link)
