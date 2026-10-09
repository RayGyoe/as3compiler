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
  - AS3 exceptions (`throw`/`try`/`catch`/`finally`) map to `setjmp`/`longjmp` in the generated C, and on
    WASI that machinery rides on the WebAssembly exception-handling proposal, so a wasm compile appends three
    switches:
    - `-mllvm -wasm-enable-sjlj` — LLVM lowers `setjmp`/`longjmp` to `__wasm_setjmp`/`__wasm_longjmp`
      (`longjmp` throws a tag; the frame that called `setjmp` catches it). wasip1's libc has no such symbols;
    - `-mllvm -wasm-use-legacy-eh=false` — use the **standard** EH instructions (`try_table`). The lowering
      defaults to the legacy `try`, which wasmtime rejects by default (`legacy_exceptions feature required
      for try instruction`) and which browsers never implemented;
    - `-lsetjmp`, placed after the objects — wasi-libc keeps `__wasm_setjmp`/`__wasm_longjmp`/
      `__wasm_setjmp_test` in a **separate** `libsetjmp.a`, not in libc.a.
    The latter two are added only when the build layer finds `lib/wasm32-wasip1/libsetjmp.a` in the sysroot;
    without it the historical flags are kept and a program that really needs exceptions still fails **loudly**
    (`wasm-ld: undefined symbol __wasm_setjmp`) rather than degrading silently.
  - The artifact needs a runtime with the **standard** exception-handling proposal: wasmtime ≥ 24 works out of
    the box, as do Chrome/Edge 119+, Firefox 131+ and Safari 18.4+; wasm3 and legacy-EH-only runtimes cannot
    run programs with exceptions (programs without exceptions are unaffected — see below).
  - Programs without exceptions are **byte-for-byte** as before: `-lsetjmp` is a static archive, so unreferenced
    members never enter the artifact (`examples/hello.as` produces an identical code section with or without
    the new switches).

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
  --export <name> export a C symbol into the .wasm export table (repeatable)
  --opt <flags>  optimization flags (default: -O2)
  --debug-info   keep DWARF: add -g to every backend and stop stripping it from the
                 default wasm build (default: off — artifacts carry no debug info; see §4.3)
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

#### WASI imports the host stub must provide

The generated `.wasm` is a WASI module, so the host (browser / custom runtime) must provide functions for its
**entire** import set, otherwise `WebAssembly.instantiate` fails outright (measured in a browser as
`function import requires a callable`). The current runtime reads `getenv` for GC/IO debug switches and uses
`fopen` for file jobs, so every wasm module imports **18** `wasi_snapshot_preview1` functions, including
`environ_get`/`environ_sizes_get` and the filesystem family
(`path_open`/`fd_read`/`fd_readdir`/`path_filestat_get`/`fd_fdstat_set_flags`). When running a program in the
browser that **does not touch files/environment**, these stubs may honestly return "empty environment /
`EBADF` / `ENOENT`" — see the **per-entry explicit stubs** in `examples/wasm-native/fib.html` and
`index.html`, or the **Proxy wildcard stub** in `fib-export.html` and `export-meta.html` (the latter is immune
to changes in the import set). To list a given `.wasm`'s actual import set:
`node temp/regen/imports.mjs <file.wasm>`.

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

# macOS system frameworks (e.g. Security / SystemConfiguration needed by static curl) and extra C sources
as-aot app.as -I vendor/curl/include -L vendor/curl/lib/macos-arm64 \
  -l curl -l nghttp2 -l z -D ASC_HAVE_CURL \
  --framework Security --framework SystemConfiguration --source vendor/sysproxy_glue.c

# Or use a build manifest (recommended; versionable and reusable)
as-aot app.as --manifest examples/skia-link.build.example.json
```

#### 3.4.1 The `flash.net` network backend is an **opt-in macro**, not the default

The transport backend for `http(s)://` is **not linked by default**: without declaring the macro the build
remains zero-dependency, self-contained and network-free, and a remote URL dispatches a **distinguishable**
honest `ioError` (sharing no wording with "file does not exist"). The two macros each govern one target:

| Target | Macro | Also needs | Capability gained |
|---|---|---|---|
| native | `ASC_HAVE_CURL` | `link-libs: ["curl"]` (system libcurl or the static `vendor/curl` of §3.4.4) | real transport for `URLLoader`/`URLStream` (HTTP/1.1 + TLS + redirects), `navigateToURL` launches the system browser, `Socket`/`ServerSocket`/`XMLSocket` (`ASC_SOCK_POSIX`, on by default) |
| web (`--package web`) | `ASC_HAVE_FETCH` | none (the browser's built-in `fetch`) | as above (subject to CORS/forbidden headers/opaque redirects, see [`html5-web.md`](html5-web.md) §6 item 10) |
| wasm32-wasip1 | — (no backend) | — | preview1 has no socket primitives; honestly reports `ioError` |

> **`--air-app` is the auto-mounted exception.** A hand-written `.as` project opts in explicitly per the
> table above; but for an AIR project going through `--air-app`, the network dependency is **inferred from
> source** — `src/air-app.ts`'s `detectNetworking()` scans whether `src/**/*.as` mentions `URLRequest` (the
> same shape as `detectStage3D`, zero configuration), and on a hit writes the native
> `-l curl -l nghttp2` + `vendor/curl/{include,lib}` paths + `Security`/`SystemConfiguration` +
> `ASC_HAVE_CURL=1` into the generated manifest; for the web target it writes `ASC_HAVE_FETCH=1` (the only
> usable HTTP client in a browser is the page's own `fetch()`). The reason is that `--air-app` **rewrites
> `<filename>.build.json` on every run**, so a hand-edited manifest does not survive the next build, and the
> link set must therefore come from the generator (stage eighty-nine / fifty-five). The symptom of missing it
> is not a compile failure but "it compiles and runs, yet every request lands the distinguishable honest
> `ioError`" (`AS_JOB_ERR_UNSUPPORTED`). An AIR project that does not touch the network keeps the
> zero-dependency default form; under native, a missing `vendor/curl` **errors out immediately** and points
> to `build-tools/curl-src/build-static.sh`, rather than degrading silently. The criterion is `URLRequest`
> and **not** `import flash.net.*`: that package also holds `SharedObject`/`FileReference`/`LocalConnection`
> and other classes that never touch HTTP, so matching by package name would needlessly pull 1.4 MB of
> static curl into the link set, and would also stall an app that uses local storage on an error when
> `vendor/curl` has not been built locally.

**Per-target extra switches** (all off by default, opted in item by item):

| Macro | Default | Effect |
|---|---|---|
| `ASC_HTTP2` | off (pinned to HTTP/1.1) | allows TLS to negotiate h2. **Off by default is the fidelity choice**: h2 normalizes response header names and omits connection-level headers, both visible on the AS3 side (AIR's transport is HTTP/1.1 to begin with) |
| `ASC_SYSTEM_PROXY` | off | reads the macOS system proxy (`SCDynamicStoreCopyProxies`) and hands it to libcurl. **Must be paired with `--source vendor/sysproxy_glue.c`**: `<SystemConfiguration/SystemConfiguration.h>` drags in `MacTypes.h`'s `struct Point`, which conflicts with the generated C's `flash.geom.Point` struct, so that system call can only live in a separate translation unit (the generated C keeps only an `extern` declaration) |
| `ASC_SOCK_POSIX` | **on** (auto-defined for POSIX targets) | the TCP socket base (`Socket`/`ServerSocket`/`XMLSocket`). Targets without POSIX sockets (WASI/Web/Windows) degrade automatically: honestly dispatching `ioError` |
| `ASC_HAVE_FETCH` | off (web target) | the browser `fetch` backend |

Environment-variable proxies (`http_proxy`/`https_proxy`/`all_proxy`, either case) need **no macro**: libcurl
consumes them natively, and the seam skips the system-proxy query when these variables are detected (avoiding
two proxy configurations overriding each other).

To serve three targets with one manifest, use the `targets` override block (§4.1):

```json
{
  "link-libs": ["curl"],
  "defines": ["ASC_HAVE_CURL"],
  "targets": {
    "wasm": { "link-libs": [], "defines": [] }
  }
}
```

#### 3.4.2 Named enhancement switches (`--features` / manifest `features`)

One level above `-D`: it turns on an **AIR-superset capability** by name instead of making the user
hand-write the macro behind it. The name only declares what it is (an enhancement, non-AIR behavior); the
macro is resolved by the compiler.

```bash
as-aot app.as --air-app app.xml --features svg      # equivalent to -D ASC_USE_SVG=1
as-aot app.as --air-app app.xml --features none     # clear (see below: this clears the persisted choice too)
```

| Name | Macro | Available targets | Description |
|---|---|---|---|
| `svg` | `ASC_USE_SVG=1` | `native` only | see §3.4.3 |
| `formats` | `ASC_ALLOW_EXTRA_FORMATS=1` | `native` / `wasm` | extra image formats WebP / BMP / ICO (AIR reports `#2124` for them, hence **denied by default** — see §3.4.3.1) |
| `raw` | `ASC_ALLOW_RAW_FORMATS=1` | `native` only | camera RAW / DNG (denied by default — see §3.4.3.1; the web-side Skia has no piex/dng_sdk archive, so it errors when the target is unsupported) |

The same-named field in the manifest is a **string array** with CLI-identical semantics:

```json
{ "features": ["svg"] }
```

Rules (all three exist to **not be silent**, AGENTS.md §1.5):

- **All off by default**: when not enabled the artifact is **byte-for-byte identical** to before and
  isomorphic with `adl`. When enabled it prints a line
  `== enhancements: svg (-D ASC_USE_SVG=1) ==` and states in the hint that it is an AIR superset.
- **An unknown name errors**, not silently ignored: `--features lottie` reports
  `unknown feature 'lottie' (known: formats, raw, svg)` and exits **before generating any code** (only
  capabilities already implemented in the manifest are registered; a registered-but-unimplemented switch
  would give the user something that "looks enabled but was never compiled in"). `--features none` cannot be
  combined with other names.
- **An unsupported target errors**: `--target wasm --features svg` directly reports
  `feature 'svg' is not available with --target wasm`, rather than leaving `undefined symbol: sk_svg_*` to the
  linker.

The difference between `--features` and `-D`: `-D` **appends** one macro, while `--features` **replaces** the
whole enhancement set — only replace semantics can express "svg was on, but I want only something else".

#### 3.4.2.1 `--air-app` **persists** the enhancement choice

`--air-app` **rewrites in full** the generated `<filename>.build.json` on every run (it is a build artifact
derived from app.xml + a src scan). So a chosen enhancement must survive that rewrite, otherwise "turn on SVG"
could only be repeated on the command line every time — exactly the reason this switch exists.

- `--features svg` writes `"features": ["svg"]` into the generated manifest; **the next run without the flag
  still takes effect**, and prints `enhancements carried over from ...: svg` (**not silent**).
- To turn it off: `--features none` (clears and persists likewise).
- Only `features` is inherited: the other fields are functions of the descriptor and the source, and
  reviving a stale generated value (a macro that has been removed, an old link library) would be a silent
  incorrect build.

#### 3.4.3 Image decoding's SVG channel is also an opt-in macro (`ASC_USE_SVG`)

Of encoded images, **only PNG/JPEG/GIF need no macro** — they are formats AIR supports (`adl` decodes them).
For BMP/WebP/ICO, both sides' Skia has the corresponding codec compiled in, but AIR reports `#2124` for them,
hence **denied by default, requiring an explicit switch** (`--features formats`, see §3.4.3.1).
**SVG is different**: it is not a `SkCodec` format but goes through an independent channel (`SkSVGDOM` parse →
`SkSurface` rasterize), and AIR's `Loader` **never supported SVG**, so by §1.5 it is made **opt-in**:

```bash
# native: one command (libsvg/libsksg/libexpat are already in the manifest's link-libs)
as-aot app.as --air-app app.xml --features svg

# equivalent spelling (the named switch is just resolving this macro for you)
as-aot app.as --air-app app.xml -D ASC_USE_SVG=1
```

| Build | `Loader.load("x.svg")` |
|---|---|
| default | `ioError #2124 Error #2124: Loaded file is an unknown type.` — word-for-word identical to `adl` |
| `--features svg` (= `-D ASC_USE_SVG=1`) | decodes successfully (`<text>` renders normally via `SkFontMgr`; a document with no absolute size defaults to 300×150 per spec) |

**Not supported on web**: `vendor/skia/lib/wasm` has no `libsvg.a`/`libsksg.a`/`libexpat.a` (the wasm
`args.gn`'s `skia_use_expat=false` gates the whole svg target out), so defining the macro fails at **link
time** — an explicit error, not a silent degradation. Supporting it would require changing the wasm
`args.gn` and **rebuilding wasm Skia**. See [`enhancements.md`](enhancements.md) §4.1 and
[`skia.md`](skia.md) §9.1.

#### 3.4.3.1 Image formats and camera RAW are **denied by default** (`formats` / `raw`)

Two more instances of the same reasoning: our Skia ships more codecs than AIR, and "more" must be opt-in
(AGENTS.md §1.5) — otherwise the default artifact would be **broader than AIR**: inputs `adl` would reject
would be accepted by us, exactly the shape forbidden by criterion (d).

| Input | Default build | Switch |
|---|---|---|
| PNG / JPEG / GIF | decodes normally (same as AIR) | not needed |
| **BMP / WebP / ICO** | `ioError #2124 Error #2124: Loaded file is an unknown type.` (word-for-word identical to `adl`) | `--features formats` (= `-D ASC_ALLOW_EXTRA_FORMATS=1`, available on both targets) |
| **camera RAW / DNG / CR2 / NEF / ARW / ORF / RW2… / RAF** | same `#2124` | `--features raw` (= `-D ASC_ALLOW_RAW_FORMATS=1`, **native only**) |
| SVG | same `#2124` | `--features svg` (§3.4.3) |

The implementation is a **magic-number interception** in the glue layer (`vendor/skia_glue.cc`'s
`sk_extra_format_refused`, checked by all four decode entry points): `RIFF....WEBP`, `BM`, `ICO/CUR`, a TIFF
header (`II*\0`/`MM\0*`, the common header of TIFF-family RAW such as DNG/CR2/NEF/ARW/ORF/RW2), and
`FUJIFILMCCD-RAW` (RAF). On a hit it is treated as a decode failure, so it **automatically** takes the
existing `#2124` path at the layer above — the error reported stays consistent with `adl` without separate
maintenance. On a miss (an unrecognized header) it is still handed to Skia as before, with the same behavior
as always.

`--features raw --target wasm` is **rejected up front** (`the wasm Skia has no piex/dng_sdk archive ...`);
`--features formats` is available on both targets. `WBMP` (`SkWbmpCodec` is compiled in) is **deliberately
not intercepted**: its header is a bare multi-byte type field with no reliable magic number, and rather than
guess a criterion that might hit real formats by mistake, it is recorded here honestly.

#### 3.4.4 Static self-containment (`vendor/curl`)

`link-libs: ["curl"]` **dynamically links the system libcurl** (on macOS `/usr/lib/libcurl.4.dylib`), so the
artifact is no longer a single self-contained file. For self-containment,
`build-tools/curl-src/build-static.sh` builds `libcurl.a`/`libnghttp2.a`/`libz.a` from source into
`vendor/curl/{include,lib/macos-arm64}`, and the manifest just points there
([`examples/flash-net-layered.build.example.json`](../../examples/flash-net-layered.build.example.json) is
exactly this shape):

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

> The `frameworks` field is equivalent to the CLI's `--framework` (links `-framework <name>`). `libz.a` has
> the same name as the system `libz`, and a static hit is ensured by **library search-path order** (you may
> see a `ld: warning: ignoring duplicate libraries: '-lz'` notice, with no side effects). Acceptance
> criterion: the output of `otool -L` **should not** contain `libcurl.4.dylib`/`libz.dylib`.
> **The default build (not declaring these macros/libraries) is entirely unaffected.**

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

#### 3.5.1 Compile face = the main class's transitive closure (阶段一百二十四)

Which `.as` files `--air-app` compiles is decided by the **class-reference closure from the main class**
(`src/reach.ts`), matching `mxmlc`/`adl`: AIR links only the transitive closure reachable from the
document class — `mxmlc -link-report` measures **158/162/171/171/175/246** defs for the six away3d
demos, while `src/` holds **485** files of which **198** are reached by no demo. `--air-app` used to
compile the whole tree, over-approximating AIR: other demos' `[Embed]` assets were bundled **and
survived into the binary**, and a broken `[Embed]` in an unreachable class failed our build where
`adl` was fine.

Closure edges are the **class-name references** in the source: `new X`, type annotations (including a
`Vector.<T>` element type), `extends`/`implements`, `is`/`as` targets, `catch (e:T)`, parameter and
return types, and **bare identifiers** (which covers `X.staticM()`). Resolution **deliberately
over-approximates** — an unresolved short name maps to **every** candidate of that name — so our
closure is a superset of AIR's (otherwise pruning would itself be a new fidelity gap). Always kept:
the main class, `[WasmExport]`-marked classes (JS entry points with no AS3 reference), and files
carrying **non-class top-level statements** (module statements / free functions), which are emitted
for the whole program and cannot be pruned per class.

Classes referenced **only by a `getDefinitionByName("…")` string** are not kept, matching AIR (mxmlc
cannot resolve the string either). The class registry `as_class_registry[]` stays eager (it also
serves `is Class`, `new x()`, `getDefinitionByName` and the GC roots) — what shrinks is the
**emission** face, not the runtime table.

To restore the old whole-tree face:

```bash
as-aot --air-app app.xml --all-sources     # compile every .as under src/ (pre-阶段一百二十四 behaviour)
```

Measured (away3d `Basic_SkyBox`, same sources, `--all-sources` vs default): sources **485 → 165**,
`[Embed]` assets **40 → 6**, generated `.c` **31,324,486 → 9,105,166 B (−71%)**, binary
**34,134,472 → 25,456,904 B (−25%)**, full build **37.03 → 15.94 s (−57%)**. The build log reports the
result: `(main Basic_SkyBox, 165/485 sources reachable from Basic_SkyBox)`, and the per-demo asset
count equals AIR's **for every demo** (6/2/0/2/1/27). Design, soundness argument and per-mechanism
evidence: `src/reach.ts` header and the `unit: reach/*` groups.

**Web target** (under `--air-app ... --target wasm --package web`): the `--air-app` adapter automatically
switches to the browser backend — the build manifest switches to `web_glue.cc` (replacing `window_glue.cc`)
+ the wasm build of Skia (`vendor/skia/lib/wasm`), drops the macOS frameworks SDL2/`objc`/Cocoa, and fonts are
provided by `app.xml`'s `<embedFonts>` (reads each `<font><fontPath>` to generate `font-urls` for runtime
injection; when no `<embedFonts>` is written it automatically scans the app directory for `.ttf/.otf/.ttc`,
`findAppFonts()`, with no descriptor change needed). The rest of the flow (parsing app.xml, scanning src,
generating bootstrap code) is identical to native, and the artifacts are `<filename>.html` + `.js` + `.wasm`.

**Font warning (same reasoning as the network auto-mount: the failure is silent)**: the wasm sandbox has no
enumerable system fonts and only recognizes fonts injected by the page; an app that uses `flash.text` but has
no font at all in its app directory will get an empty `font-urls` list, so the TextField's **background is
still drawn while every glyph is missing** — it compiles and the page runs, only the text is invisible
(native/adl enumerate installed fonts via CoreText and are unaffected, so this is a web-only pitfall). The
adapter scans `src/**/*.as` for `flash.text` (`detectText()`) to decide whether the app draws text, and on a
hit with an empty `font-urls` prints a yellow warning to stderr, naming the symptom and the two fixes (drop
in a font yourself, or write `<embedFonts>`). It does not throw: the rest (layout, bitmaps) previews fine, and
blocking the build would not make the font appear. See [`html5-web.md`](html5-web.md) §4 and §6 item 1.

**Network transport auto-mount**: an AIR project does not need hand-written curl arguments. The adapter scans
`src/**/*.as` for `URLRequest` to decide whether the app uses the network (`detectNetworking()`, the same
shape as `detectStage3D`), and on a hit writes the static `vendor/curl`'s `-I/-L` paths +
`-l curl -l nghttp2` + `Security`/`SystemConfiguration` into the native manifest and defines
`ASC_HAVE_CURL=1`; the web target defines `ASC_HAVE_FETCH=1` instead. This is required automation rather than
convenience: the manifest is regenerated on every build, so a hand edit cannot survive. An app that does not
touch the network is unaffected (still the zero-dependency default form).
(`ASC_HAVE_CURL` itself is still an opt-in macro; the design rationale is in §3.4.1.)

Three key behaviors aligned with adl:
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
  - **`ASC_RENDER_METAL` applies to every window** (stage eighty-nine / seventy-five): the main window
    always goes through Metal; at runtime `new NativeWindow()` also defaults to Metal — AIR's
    `NativeWindowRenderMode.AUTO` is exactly "use the GPU when there is one". Backend state
    (layer/drawable/surface) is **slotted per window**, sharing only
    `MTLDevice`/`MTLCommandQueue`/`GrDirectContext`; opening N windows means N per-window Metal
    initializations (log `metal_glue: window <id> layer bounds=…`).
  - To get a software window in the same build, set `NativeWindowInitOptions.renderMode = "cpu"` (the main
    window has no such knob; it is fixed by app.xml). Measured (two secondary windows): changing only this
    one line in the same binary took CPU from an average **32.8% → 14.0%**.
  - **Stage3D/StageVideo only composite inside Metal windows**: AIR's documentation explicitly says software
    windows do not support StageVideo/Stage3D compositing, and under a Metal build there is no CPU readback
    buffer (exposing the render-target texture is precisely to save the per-frame readback) — handled as AIR
    behaves, not a silent degradation.
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
| `debug-info` | boolean | Whether to keep debug info, default `false`. By default artifacts carry **no DWARF** on any of the three backends (the wasm link therefore adds `-Wl,--strip-debug`, see §4.3); setting `true` adds `-g` to all three and stops stripping wasm (CLI `--debug-info`) |
| `lto` | boolean | Default `false`. When `true`, adds `-flto` to **every compile step and the link step** (see §4.2); leaving it unset keeps the command and the artifact byte-for-byte what they were |
| `pgo` | `"generate" \| "use"` | Phase of profile-guided optimization, off by default. `generate` builds an **instrumented** binary (running it writes profile data); `use` rebuilds with the data from the same directory (see §4.2) |
| `pgo-dir` | string | Profile directory shared by the two `pgo` phases (relative to the manifest dir). Clang reads `<dir>/default.profdata`, so both phases **must name the same one** |
| `sources` | string[] | Extra C/C++ source files (compiled together with the generated `.c`) |
| `swc-paths` | string[] | `.swc` libraries (paths resolve relative to the manifest dir). Both halves are processed at **compile time**: **named bitmap resources** are extracted (`DefineBitsLossless/2` de-premultiplied and re-encoded as PNG, `DefineBitsJPEG2/3` copied byte-for-byte) and synthesized as `dynamic class X extends BitmapData` (constructor `(width, height)` but the **arguments are ignored**), while the **vector shapes and display tree** (`DefineShape*`/`DefineSprite`/`PlaceObject*`, `clipDepth` masks, `PlaceObject3` visibility, the **nine-slice** `DefineScalingGrid`, the **button four states** `DefineButton2`) are baked into runtime drawing calls and their exported symbols synthesized as AST classes. Thus both reference paths work — `new logo(0, 0)` and `getDefinitionByName("logo")`; the asset bytes are embedded into the generated `.c` and decoded by Skia at runtime (zero new runtime API on the vector side). Implementation and measurements: [`swc.md`](swc.md) §5/§6/§9; semantics/limits: [`swc.md`](swc.md) §10 |
| `include-paths` | string[] | Header search paths (→ `-I`) |
| `link-libs` | string[] | Libraries to link (→ `-l`) |
| `link-paths` | string[] | Library search paths (→ `-L`) |
| `defines` | string[] | Preprocessor macros (→ `-D`) |
| `features` | string[] | **Named enhancement switches** (§3.4.2), e.g. `["svg"]`. Empty by default. An unknown name is an error; when on, the build banner names it, and when off the artifact matches `adl`. On the CLI `--features` **replaces** the whole set (`-D` is the one that appends) |
| `objects` | string[] | Precompiled `.o` added directly to the link |
| `frameworks` | string[] | macOS frameworks (→ `-framework X`, needed for Skia's CoreText/CoreGraphics backend) |
| `font-urls` | string[] | Font byte-stream URL list (`--package web` writes it into `index.html`, network-loaded and injected into Skia at runtime; see [`html5-web.md`](html5-web.md) §4) |
| `preload-paths` | string[] | Data roots packed into the wasm FS image, `src@dest` or a bare path (`--package web` only; the browser sandbox starts with an empty FS, so `File`/`FileStream` would see nothing at all) |
| `preload-excludes` | string[] | Host paths or fnmatch patterns **removed** from that image (→ `emcc --exclude-file`; also `--package web` only). A directory preload has no per-file opt-out, so files that must not ship are named here instead; patterns match the **host path** the preload walk yields (absolute), so they resolve relative to the manifest dir too. A path containing `*?[` is a PATTERN, not a literal (`weird[1].png` drops the unrelated `weird1.png`); escape it as `[[]` `[]]` `[*]` `[?]` to match literally. A pattern that matches nothing is silently ignored. `--air-app` uses it to pull the page-fetched fonts back out of the FS (see [`html5-web.md`](html5-web.md) §6), and automatically excludes the **current build's output directory** pointed to by `-o` — otherwise `-o temp/<x>` would preload the very `.c`/`.o`/artifact being written into the image (measured on Flappy-Starling: 1.9 MB → 36 MB); with no `-o` specified it makes no guesses at all |
| `bundle-id` | string | app identifier (`--package xcode-project` fills `Info.plist`'s `CFBundleIdentifier`, default `com.example.<product>`) |
| `display-name` | string | app display name (fills `CFBundleName`, default product name) |
| `icon` | string | `.icns` path (relative to manifest dir, copied into `Resources` + fills `CFBundleIconFile`) |
| `deployment-target` | string | macOS minimum version (fills `MACOSX_DEPLOYMENT_TARGET`, default `12.0`) |
| `targets` | `{ native?, wasm? }` | **Per-target override block** (§4.1): top-level fields are the shared default, and the `targets.<target>` block **replaces wholesale** the fields it declares for the **matching target**, letting one manifest serve multiple targets with mutually exclusive link sets |

Path-type fields (`sources` / `swc-paths` / `include-paths` / `link-paths` / `objects` / `preload-excludes`)
resolve **relative to the directory containing the manifest file** (same as TypePHP's YAML path rule). See
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
Merge order: default config → manifest top level → manifest `targets.<final target>` (§4.1) → CLI overrides.

### 4.1 Per-target layering (`targets`)

Top-level fields are the **shared default**; the `targets.<target>` block takes effect only for the
**matching target** and **replaces wholesale** (replace, not append) the same-named top-level values. This
lets **one manifest** serve multiple targets with mutually exclusive link sets — the typical scenario being
`flash.net`'s HTTP backend: native links curl, whereas WASI preview1 has no socket/TLS and `-lcurl` would make
`wasm-ld` fail outright (`unable to find library -lcurl`), so it must be removed for wasm.

Example [`examples/flash-net-layered.build.example.json`](../../examples/flash-net-layered.build.example.json)
(current shape: native points at the static `vendor/curl`; wasm has no block so no curl-related field is
added):

```json
{
  "target": "native",
  "opt": "-O2",
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

- `as-aot app.as --manifest m.json` (native by default) → links `-l curl -l nghttp2 -l z -D ASC_HAVE_CURL` +
  the four `-framework`;
- `as-aot app.as --manifest m.json --target wasm` (wasm) → **neither is added** (no `native` block matches).

Rules:

- Fields **omitted** in the block fall back to the top-level default; to **remove** a top-level shared library,
  write `"link-libs": []` in that target's block — **only replace semantics can "subtract"** (append can only
  "add", never drop).
- The only selectable targets are `native` / `wasm`, and **an unknown target name errors**; inside the block
  **`target`/`package` are not allowed** (the target is decided by the block selecting it, and cannot be
  redefined inside) nor nested `targets`; **an unknown field inside the block errors** (AGENTS.md §2.5, to
  keep typos from being silently ignored).
- Path-type fields inside the block (`sources`/`include-paths`/`link-paths`/`objects`/`icon`) resolve
  **relative to the manifest dir**, like the top level.
- The override block is selected by the **final target** (including the effect of CLI `--target`) and is
  applied **before** the CLI overrides, so the CLI's `-l/-I/-L/-D` still stack on top of the layered result —
  "CLI beats manifest" is unchanged.

### 4.2 Link-time and profile-guided optimization (`lto` / `pgo`)

These two are **build-level switches, not language features**: the frontend still only translates AS into
readable C and hand-writes no optimization at all (§1.1); `-flto` and the profile data are consumed by the
system `cc/clang -O2 -flto`. They therefore sit at the same layer as `opt` and are settable both from the
manifest and from the CLI (`--lto` / `--pgo` / `--pgo-dir`). **Both default to off** — unset, the artifact is
exactly what it was.

```bash
# LTO only (one command)
as-aot Main.as --air-app app.xml --lto

# PGO: instrument -> run to collect -> merge -> rebuild with the profile
as-aot bench.as --pgo generate --pgo-dir prof -o bench.gen
./bench.gen                                    # run writes prof/default_*.profraw
llvm-profdata merge -o prof/default.profdata prof/*.profraw
as-aot bench.as --lto --pgo use --pgo-dir prof -o bench
```

The manifest spelling is equivalent:

```json
{ "opt": "-O2", "lto": true, "pgo": "use", "pgo-dir": "prof" }
```

Points that matter:

- **`-flto` must be on the compile steps AND the link step**: the compile step emits bitcode, and the
  cross-module inlining happens at link time. Emitting it on only one side does not error — it just
  **silently does nothing** — so `perfFlags()` is the single source and all four command builders take it from
  there, with per-step assertions plus a reverse control (drop any step and the suite fails immediately).
- **Both phases must name the same `pgo-dir`**: clang's directory form reads `<dir>/default.profdata`. A
  missing profile is a **hard build error** (`Error in reading profile ...: No such file or directory`), never a
  silent fallback to an unprofiled build.
- **No `-fprofile-correction` is emitted**: that is a GCC flag; clang only warns
  `not supported [-Wignored-optimization-argument]` and ignores it, so emitting it would add noise to every
  PGO build for nothing.
- **Valid on both backends**: native (`cc`/`clang`) and web (`emcc`) both accept `-flto`, and the suite
  asserts it on **every step** of each. The `--target wasm` (raw WASI) path passes the flags through as well,
  but **no WASI SDK is installed on this machine, so it is untested there**.

Measured (`temp/perf/`, a call-heavy 900k-iteration loop, median of five runs):

| Build | Checksum | Wall time | Artifact |
|---|---|---|---|
| `-O2` (default) | −1664902176 | ~30.6 ms | 33464 B |
| `-O2 -flto` | −1664902176 | ~25.6 ms | 33456 B |
| `-O2 -flto -fprofile-use` | −1664902176 | ~25.5 ms | 33464 B |

All three checksums are **identical** (faster, not different), and `-flto` is about 16% faster on this
single-translation-unit call-heavy workload. Layering PGO on top showed no measurable gain here (within
noise) — this workload's branches are simple, and PGO pays off on programs with **many branches / indirect
calls**; it should not be sold as a general speedup.

### 4.3 Debug info (`debug-info`)

Also a **build-level switch** orthogonal to `opt`/`lto`/`pgo`, but pointing the other way: it governs
**whether the artifact carries a debug section**. It defaults to `false`, meaning "no DWARF on any of the
three backends", consistent with C-toolchain convention:

| Backend | DWARF by default? | Why |
|---|---|---|
| native (`cc -O2`) | no | clang emits no `.debug_*` without `-g` (the executable has only a regular symbol table) |
| web (`emcc -O2`) | no | emcc strips on its own under `-O2` (a trivial program measures 2010 B with 0 custom sections; only with `-g` does it reach 28243 B) |
| wasm (WASI raw) | **yes, hence explicitly stripped by default** | wasi-sdk's `libc.a` **ships DWARF** and `wasm-ld` keeps it by default — a trivial `printf` drags in ~62 KB of debug section |

So with `debugInfo=false`, **only the wasm link** needs the mirror-image `-Wl,--strip-debug` (native/web need
no compensating flag). Using `--strip-debug` rather than `--strip-all` is deliberate: it removes only
`.debug_*` and keeps the `name` section (function names) ⇒ even without debug info, a trap still prints a
**symbolized stack**, losing only source line numbers / variable-level info.

```bash
# default: wasm artifact 133 KB (fib.wasm, with 288 KB of debug section stripped)
as-aot examples/wasm-native/fib.as --target wasm

# keep debug info: -g on all three, wasm no longer stripped (fib.wasm ~640 KB)
as-aot examples/wasm-native/fib.as --target wasm --debug-info
```

With `debugInfo=true`, `-g` is added to **every compile step** (not just the link), so DWARF covers the `.c`
we generated ourselves — browser DevTools can source-step through the C that the AS3 lowered to
(`llvm-dwarfdump --debug-line` will show the file name of our generated `.c`).
Manifest spelling: `{ "debug-info": true }`, overridable per target by `targets.<target>` (§4.1).

> The default behavior of not emitting `-g` on native/web is **completely unchanged**; the suite has an
> assertion for the **default command** of each of the three backends (`[debuginfo]`), and a reverse control
> proves they really pin down this policy.

## 5. Multi-target Backends

| Target | Compile command | Artifact |
|---|---|---|
| `native` (default, `--package raw`) | `cc -O2 -lm -lz -o <out> <c> [sources] -I... -D... [objects] -L... -l... [-framework X]` | Mach-O / ELF / PE executable |
| `wasm` (`--package raw`) | `clang --target=wasm32-wasip1 [--sysroot=...] -mllvm -wasm-enable-sjlj -O2 [-g] -mllvm -wasm-use-legacy-eh=false [-Wl,--strip-debug] -o <out>.wasm <c> ... -lsetjmp` | WASI `.wasm` (debug section stripped by default; `--debug-info` removes `-Wl,--strip-debug` and adds `-g`, see §4.3) |
| `native` + `--package xcode-project` | generates `.xcodeproj` (§6.5), driven by Xcode/xcodebuild | macOS `.app` bundle (`Contents/MacOS/<bin>` + `Info.plist`) |
| `wasm` + `--package web` | `emcc` (Emscripten, requires `EMSDK_HOME`) compiles C/C++ sources + links the wasm Skia, `INVOKE_RUN=0` | `.wasm` + `.js` + `index.html` (browser HTML5 rendering, see [`html5-web.md`](html5-web.md)) |

> When link libraries/macros must differ per target (e.g. native links curl while wasm cannot), use the
> manifest's `targets` block (§4.1) — one manifest then covers several backends from the table above, with no
> need to maintain one manifest per target.

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
> `xcode-project` form is implemented (§6.5); the rest are planned.

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
   layer, rather than being stuffed into `cc/clang`'s compile arguments.
2. **Windows `.exe` needs no new argument at all**. `native` on Windows is already a PE executable; the only
   small gap is that `-o app` does not auto-append `.exe` (`index.ts` only appends a suffix in the wasm
   branch). Appending the default extension by host OS is enough; it is not a new form.
3. **Project metadata goes into the manifest, not flattened into CLI flags**. The generator needs a lot of
   metadata: bundle id, icon, signing identity, min SDK, permissions, resource directory… these are **not
   arguments, they are project configuration**. The project already has a manifest mechanism analogous to
   TypePHP's `project.yml` (see §4), which should be extended to carry these fields rather than flattening
   them into a pile of CLI flags.

### 6.3 Recommended CLI form

```bash
# unchanged behavior
as-aot examples/hello.as --run

# macOS application project (compile backend native + generate .xcodeproj; implemented)
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
| `permissions` | Android `AndroidManifest.xml` permissions / iOS `Info.plist` usage descriptions | planned |
| `resources` | extra files to copy into the bundle / project resource directory | planned |
| `ndk-abi` | Android target ABI list (e.g. `arm64-v8a`) | planned |
| `signing-identity` | code-signing identity (`codesign` for macOS/iOS; currently ad-hoc `-`) | planned |

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
open build/…/Debug/Main.app                        # double-click / command-line launch
```

Upgrading from "command-line tool" to "application" turns the artifact from a bare Mach-O into a real macOS
App with bundle identity, Dock icon, menu bar, and sign-for-distribution capability. The generated AS3 C is
still `int main(void)` — the SDL2 event loop (`ASC_USE_WINDOW=1`) runs from `main`, and the bundle +
`Info.plist` only add an app identity, with runtime behavior identical to raw.

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
  `icon` (absolute-path file ref) is added to the Resources phase and copied into `Contents/Resources/` at
  build time.
- **Ad-hoc signing**: `CODE_SIGN_STYLE = Manual` + `CODE_SIGN_IDENTITY = "-"`, so `xcodebuild` produces a
  runnable `.app` with no provisioning profile or Apple ID (ad-hoc); formal distribution adds
  `signing-identity` in the manifest (§6.4, planned).
- **Compile config mirrors the raw link**: `OTHER_LDFLAGS` always contains `-lm -lz` then the manifest's
  `link-libs`/`objects`/`frameworks`; `HEADER_SEARCH_PATHS`/`LIBRARY_SEARCH_PATHS` mirror
  `include-paths`/`link-paths`; `GCC_PREPROCESSOR_DEFINITIONS` mirrors `defines`; `GCC_OPTIMIZATION_LEVEL` is
  mapped from `--opt`'s `-O{0,1,2,3,s}`. Path-type fields are written as absolute paths so Xcode resolves them
  from any working directory.
- **Disable `-fmodules` (critical)**: the generated C uses bare type names (`Point`/`Rectangle`…) that collide
  with macOS SDK types (e.g. `MacTypes.h`'s `Point`). Raw `cc` is fine because `-fmodules` is off by default;
  Xcode enables it by default and would let the SDK's `Point` shadow the generated struct, causing
  `no member named 'x' in 'struct Point'`. So the project explicitly sets `CLANG_ENABLE_MODULES = NO` to
  guarantee semantics identical to the command-line build.
- **C/C++ layering**: the generated `.c` stays C99 (`GCC_C_LANGUAGE_STANDARD = c99`); C++ glue layers
  (`skia_glue.cc` etc.) use C++17 (`CLANG_CXX_LANGUAGE_STANDARD = "c++17"` + `CLANG_CXX_LIBRARY = "libc++"`),
  with the compiler dispatched by file extension.
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

> **The offscreen row links Skia only**: no `window_glue.cc` in `sources`, no `SDL2` in `link-libs`, and no
> SDL2 include/library path (with `ASC_USE_WINDOW` undefined, `Stage.showWindow()` degrades to a no-op).
> Both documented manifests are backed by `build/DocumentedLinkSets` in `test/unit/build.ts`, which compiles
> the generated C once using the manifest's **own `defines`**: if a combination the docs advertise stops
> compiling, the suite goes red (which is exactly what happened on 2026-10-06, when the offscreen row lacked
> `AS_CURSOR_*` and failed silently — now fixed by defining those kinds once, outside every backend branch).

> **The two GPU macros must not be mixed up** (mixing them misjudges `Context3D.driverInfo`'s backend):
>
> | Macro | Meaning | Defined by |
> |---|---|---|
> | `ASC_RENDER_METAL` | **window compositing** goes through Metal: `metal_glue.mm`'s `CAMetalLayer` + Ganesh, compositing the whole frame on the GPU (for 2D on-screen). **One state per window** (slotted by window id, sharing only device/queue/context); both the main window and a runtime `NativeWindow` use it (the latter unless `renderMode="cpu"`) | `air-app.ts` adds it under `<renderMode>direct/gpu` + a visible window |
> | `ASC_RENDER_STAGE3D` | **Stage3D's `Context3D` connected to the real GPU**: links `stage3d_glue.mm`, and the `as_s3d_*` wrappers change from no-ops to real Metal calls | the build manifest (`air-app.ts` adds it when `usesStage3D`) |
>
> The two are **mutually independent**: defining only the former leaves `Context3D` a pure C state machine
> (`driverInfo` returns `"Software (state machine)"`); defining only the latter leaves the window on CPU
> raster (e.g. `examples/stage82.build.json`). A project that is both a GPU window and uses Stage3D (Starling,
> shmup) needs both.

**Frame-rate diagnostic knobs** (appended with `-D`, not compiled into the artifact by default):

| Knob | Target | Form | Description |
|---|---|---|---|
| `ASC_FRAME_STATS` | native | runtime env (`getenv`) | every 512 frames prints frame-time `p50/p95/p99/max` + GC share + RSS/segment count (see [`gc.md`](gc.md)) |
| `ASC_FRAME_STATS` | **web** | **compile-time define** (`-D ASC_FRAME_STATS=1`) | browsers have no env; every second it posts `frames`/`loopcalls`/`skips`/`renderMs`/`rafPeriodMs`/`skip` to `window.__ascFrameStats` (see [`html5-web.md`](html5-web.md) §3.2) |

On the web side, the difference between `loopcalls` and `frames` directly distinguishes "rAF itself is slow
(refresh-rate ceiling)" from "a cadence defect": the latter is the root cause of only reaching 66 fps on a
120 Hz screen (a timestamp-deadline cadence dropping/gaining alternately under rAF jitter, halving the rate),
now fixed as a whole-tick cadence ([`html5-web.md`](html5-web.md) §3.2).

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

- [`README-CN.md`](../../README-CN.md) — project overview, supported language subset, type mapping
- [`TODO.md`](../../TODO.md) — staged roadmap (stage twenty-nine is "build manifest + multi-target backend")
- [`as3-semantics.md`](as3-semantics.md) — AS3 semantic-fidelity red lines and specification sources
- [`html5-web.md`](html5-web.md) — browser rendering target (`--target wasm --package web`) implementation and usage
- [`win32.md`](win32.md) — Windows native backend (`<architecture>` bit width, `vendor/build-windows-deps.ps1`, Skia D3D12 direct GPU, first-run checklist)
- [`skia.md`](skia.md) — rendering backend (Skia rasterization + wasm font injection)
- [`AGENTS.md`](../../../.talkmed-agentpilot/AGENTS.md) — development conventions (§2.9 build & link)