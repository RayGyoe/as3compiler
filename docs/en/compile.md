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
```

Flow: parse `<id>/<filename>/<initialWindow>` (`title`/`width`/`height`/`visible`/`resizable`/
`requestedDisplayResolution`) →
generate bootstrap code equivalent to `boot-gui.as` (`new Stage()` → preset `stageWidth/stageHeight` →
`new Main()` → `addChild` → `showWindow`; when `visible=false`, use offscreen `render` to output PNG) →
recursively scan `src/**/*.as` (skip reverse-domain third-party library directories `com/org/net`, but
explicitly re-add the GreenSock core `TweenLite/TweenCore/SimpleTimeline/PropTween/TweenPlugin` actually used
by the air-native demo) →
write `<filename>.build.json` in the same directory as app.xml (linking Skia + SDL2) →
compile/link into the `<filename>` executable (output name overridable with `-o`).

Three key behaviors aligned with adl:
- `<resizable>false</resizable>` → build manifest adds `ASC_WINDOW_FIXED=1`; window creation omits
  `SDL_WINDOW_RESIZABLE`, yielding a fixed-size window consistent with adl.
- `<requestedDisplayResolution>high</requestedDisplayResolution>` → build manifest adds `ASC_DISPLAY_HIGH=1`;
  the window opens `SDL_WINDOW_ALLOW_HIGHDPI` and the surface is created with physical pixels at device scale
  (Retina is not blurry); `standard` or omitted keeps 1x (consistent with adl, stretched by the compositor).
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
| `c-compiler` | string | C compiler, default `cc` |
| `opt` | string | Optimization flags, default `-O2` |
| `sources` | string[] | Extra C/C++ source files (compiled together with the generated `.c`) |
| `include-paths` | string[] | Header search paths (→ `-I`) |
| `link-libs` | string[] | Libraries to link (→ `-l`) |
| `link-paths` | string[] | Library search paths (→ `-L`) |
| `defines` | string[] | Preprocessor macros (→ `-D`) |
| `objects` | string[] | Precompiled `.o` added directly to the link |
| `frameworks` | string[] | macOS frameworks (→ `-framework X`, needed for Skia's CoreText/CoreGraphics backend) |

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
  "link-paths": ["../vendor/skia/lib"],
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

Platform coupling points are isolated in `runtime.ts`'s `RUNTIME_PREAMBLE`, using `#ifdef __wasi__`
conditional compilation. The only current platform difference is `as_now_ms()`:

- native: `gettimeofday`, millisecond precision
- WASI: `time(NULL)`, degraded to second precision (wasi-libc folds libm, so no separate `-lm` needed)

> If the local machine uses Apple clang (no `wasm32-wasip1` target) and WASI SDK is not installed, wasm can
> only `--dry` to verify the command; actual compilation requires installing the toolchain first (see §2).

## 6. Windowing (SDL2 backend)

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

> The windowed artifact is still a Mach-O executable (runnable from the command line and pops a window);
> packaging a "double-click-to-run" macOS `.app` (`MyApp.app/Contents/MacOS/...` + `Info.plist`) is a
> follow-up packaging-script layer, not a compiler argument.

## 7. Related Documents

- [`README.md`](../../README.md) — project overview, supported language subset, type mapping, current
  limitations
- [`TODO.md`](../../TODO.md) — staged roadmap (stage twenty-nine is "build manifest + multi-target backend")
- [`as3-semantics.md`](as3-semantics.md) — AS3 semantic-fidelity red lines and specification sources
- [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) — development conventions (§2.9 build & link)
