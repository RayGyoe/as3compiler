# ANE (AIR native extension) loading and migration

> This file answers one question: **how does an off-the-shelf AIR native extension (`.ane`) get running
> inside an AOT product, and where it cannot run, which gaps do we report faithfully**. The core
> conclusions first:
>
> * Our runtime **plays the AIR host**: `asaot.dll` exports all **51 FRE entry points**, each of which
>   forwards into the generated program's own table (one heap, one class registry). The FRE object
>   model, the extension loading protocol and `ExtensionContext`'s AS3 surface are all landed and
>   running end to end (the A/B/C faces below).
> * **The original `.ane` cannot be used directly**: it statically imports `Adobe AIR.dll` per AIR's ABI,
>   and that DLL does not exist here (nor should it). So we go with **two products**: the original `.ane`
>   stays for `adl`, and a second product **recompiled against `asaot.lib`** goes to AOT (by default **a
>   staging directory tree, not a `.ane`** — such a recompiled product cannot be loaded by AIR anyway,
>   so packaging it has no consumer, see §4.6). The two differ only in the import library and the import
>   name; **not one line of the ANE's own source tree changes**.
> * **Section 4 is the heart of this file**: the complete procedure from "you have a `.ane`" to "the
>   AOT product's `ctx.call` works", every verifiable checkpoint, and a **symptom → cause** table.
> * **Face D (render pipeline / native window handles / Context3D) is not implemented in this phase**:
>   all 11 entry points return `FRE_ILLEGAL_STATE` **and report themselves on stderr** — no silent
>   success, no fabricated descriptor.
>
> **Status (re-checked at v0.4.161)**: faces A/B/C are landed; the host platform is currently only
> **Windows x86 / x86-64** (two widths); there is **no** `macOS`/`iOS` host library (`--ane` on such a
> platform reports loudly and quotes the missing path, see §5). End-to-end evidence: `examples/ane/`
> (**all 43 assertions pass**) and `examples/ane-app/` (**8**, the descriptor route),
> `unit: ane/ExtensionContextSurface` in `test/unit/emit.ts`, and
> `unit: ane/ExtensionXmlComments` / `unit: ane/PackageLayout` / `unit: ane/PlatformForBuild` /
> `build/AneHostLayout` / `build/WindowsArch` in `test/unit/build.ts`.

---

## 1. The criterion: what "an ANE works" means

An AIR native extension consists of three things; understand the division of labour between them and
every design decision below follows from it:

| Part | What it is | Who handles it in AIR |
|---|---|---|
| `library.swf` | the **AS3 half**: the wrapper class that turns `ctx.call("foo")` into a friendly API | AIR's runtime loads it and executes the ABC bytecode inside |
| `<platform>` native library | the **C half**: the `.dll`/`.dylib` that implements `foo` and reads/writes AS3 values through FRE | AIR's runtime `LoadLibrary`s it and calls its Initializer |
| `extension.xml` | the **contract**: extensionID, the native library name per platform, the Initializer / Finalizer export names | AIR's runtime parses it (from the `extensions/` directory) |

Of the three, **the only thing AOT must make static is `library.swf`** — it has to be a pile of `.as`
sources so it can take part in compilation (AGENTS.md §1.1: the front end only translates; we do not
implement an AVM2 interpreter, so `DoABC` bytecode is out of scope). The native library and the
descriptor are both **run-time** things, and we handle them at run time following AIR's own protocol.

So the criterion is one sentence:

> **Same extensionID, same native sources: whatever `adl` gets right, the AOT product must get right
> too; whatever it does not, must be "reported loudly + logged as a leftover defect", never "silently
> returns a plausible-looking value".** (AGENTS.md §1.5)

---

## 2. The four faces: A / B / C / D

The feasibility assessment cut this chain into four faces, and the implementation follows that cut:

| Face | Content | This phase |
|---|---|---|
| **Face A** | the AS3 side, `flash.external.ExtensionContext` (`createExtensionContext` / `call` / `dispose` / `getExtensionDirectory` / `actionScriptData` + `StatusEvent`) | ✅ implemented |
| **Face B** | the FRE object model: `FREObject ↔ as_value`, a per-call arena, **51 entry points** | ✅ implemented |
| **Face C** | extension loading: the compile-time descriptor table, the platform loader, the `Initializer`/`ContextInitializer`/`Finalizer` protocol, function-table dispatch, `StatusEvent` delivery | ✅ implemented |
| **Face D** | the render pipeline and native handles: `FREGetRenderMode` / `FRESetRenderSource` / `FREMediaBufferLock\|Unlock` / `FREAcquire\|ReleaseBitmapData[2]` / `FREInvalidateBitmapDataRect` / `FREAcquire\|ReleaseNativeWindowHandle` / `FREGetNativeContext3DHandle` (**11 in total**) | ⛔ **not implemented this phase**, all `FRE_ILLEGAL_STATE` + self-report |

Why Face D is listed separately: it is not "forgotten", it is **deliberately deferred** — it requires
the runtime to really have a presentation pipeline that can receive foreign frame buffers, interoperate
with D3D/OpenGL and obtain a window HWND. That layer is not among this phase's goals, and **pretending
to succeed is the worse choice**: for a video-class ANE, `FRE_OK` would make the extension believe "the
picture has been presented", and the end phenomenon would be "a black screen with nobody reporting an
error". So those 11 entry points go through the same **rate-limited** self-report channel,
`[as3-aot] not implemented by this build: ...` (at most 5 lines per program, see
`src/runtime.ts:2664`; the cap exists so the gap stays **visible** instead of turning the log into a
running ledger).

---

## 3. What is implemented

### 3.1 Face A: the AS3 surface is modelled on AIR, not one member more or less

`ExtensionContext` is a **real built-in class** (registered in `src/symbols.ts` + emitted by
`src/emit.ts`), not "a same-named `.as` file dropped into the project". That has a hard reason: a
`package`d user class **cannot override** a `flash.*` built-in — measured (trying to use a user-side
same-named `.as` yields `undefined variable 'ExtensionContext'`).

| Member | Behaviour | Note |
|---|---|---|
| `createExtensionContext(id, ctxType)` | looks the extensionID up in the table → `LoadLibrary` → runs `Initializer` + `ContextInitializer` → returns the context | there is **no** third null case beyond AIR's two; every failure self-reports |
| `call(fn, ...args)` | goes through the function table the extension publishes; a name the extension never published → self-report + return `null` | a synchronous call, as in AIR |
| `dispose()` | runs `ContextFinalizer`, marks the context invalid, returns `true` | the native library is **not unloaded** (other contexts may share it) |
| `getExtensionDirectory()` | returns a **live `File` with no path**, and **self-reports** why it has no path | see §5 defect 4 |
| `actionScriptData` | a real property; reads/writes go through the same dynamic accessors as ordinary AS3 properties | FRE's `FREGet/SetContextActionScriptData` share that one storage |
| `StatusEvent` dispatch | native side `FREDispatchStatusEventAsync` → queue → pumped out **before the call returns** | `addEventListener(StatusEvent.STATUS, …)` must have already fired before the next statement |
| **the `extensionID` property** | **deliberately absent** | AIR does not have it (`mxmlc` rejects it, `adl` reports `Error #1069`); inventing one would only make this compiler accept programs `mxmlc` rejects |

The "deliberately absent" item deserves its own sentence: it looks like something that "should" exist —
the class was after all created from an id. But **aligning with AIR beats intuition**: the language
reference has only `actionScriptData` / `functions` / `knownExtensions`, and an extra property would
turn "input AIR rejects" into "input we accept", which is a divergence in the wrong direction.

### 3.2 Face B: the FRE object model (51 entry points)

* **A `FREObject` is just an opaque handle pointer**: our `FREObject` points at a **boxed `as_value`**.
  The two halves are therefore consistent by construction — the extension stores/returns handles and we
  read/return boxed values, and **no conversion is needed at the boundary**.
* **Lifetime is per call**: `as_ext_call` opens a scope, every entry point allocates its handles from
  it, and the whole block is freed when the call returns — exactly AIR's contract (arguments are valid
  for the duration of the call, and the runtime frees what `FRENewObjectFrom*` created). So as long as
  "the extension correctly does not cache handles", it **cannot** observe a dangling pointer.
* **One `malloc` per call, not per frame**: the per-call scratch area deliberately does **not** use the
  arena allocator — the arena is program-lifetime (AGENTS.md §2.4), and per-call scope is precisely the
  opposite of that.
* **Box tags are synchronised in four places**: a new tag must be added to `as_v_typeof` /
  `as_v_truthy` / `as_v_eq` / `as_v_str_val` (AGENTS.md §2.4 red line), plus `gc_mark_value` on the GC
  side.
* **`asaot.dll` is a pure forwarder**: it **holds no AS3 state at all**; `asaot_bind(&host)` installs
  the 51 implementations from the generated program into its table. So everything an extension does
  lands on the executable's own heap and class registry — which is why "an object an extension `new`s
  can be tested with `is` from the AS3 side and is collected correctly by the GC".
* **The ABI is byte-for-byte swappable**: `lib/asaot.h` and the AIR SDK's `FlashRuntimeExtensions.h`
  agree on struct layout, enum values, typedef targets and all 51 signatures (without copying the SDK
  header's body). That is the premise that makes the "recompile and rename" route possible.
* **An AS3 exception thrown by the extension propagates across the boundary**: caught with
  `setjmp`/`as_jmp_stack` and rethrown to the caller as an AS3 exception (AIR's `thrownException`
  semantics). Measured: a native-side `FRESetObjectProperty` on a sealed object gives the AS3 side the
  `prim=3 sealed=4` classification result.

### 3.3 Face C: extension loading

| Step | How AIR does it | How we do it | Why |
|---|---|---|---|
| finding the extension | parses every `extension.xml` under `extensions/` at run time | parses the `.ane` package **or the unpacked directory** given to `--ane` at **compile time** and emits it as C data `as_ane_descs[]` | the runtime carries no XML engine, and we do not want it to (§1.1) |
| extension ID → descriptor | string lookup | `as_ane_index()` linear table scan (cap `ASC_ANE_COUNT_MAX = 32`) | the table is static; scanning 32 rows costs nothing |
| loading the native library | `<app>/extensions/<id>/<nativeLibrary>` | `<exe directory>/extensions/<extID>/<platform>/<nativeLibrary>` | resolved relative to the executable (`as_ext_dir()` uses `GetModuleFileNameA`), so the product is **relocatable as a whole**. **One directory per extension** is not decoration: several extensions' same-named libraries in one directory become the same file (§5.1), while AIR puts each extension's library at **that extension's own path** |
| initialization | `Initializer(&data, &ctxInit, &ctxFinal)` then `ctxInit(...)` | the same | identical protocol |
| calling a function | look up by name in the extension's published `FRENamedFunction[]` | the same, with `functionData` passed as the extension gave it | no invented context slot |
| failure | `createExtensionContext` returns null | returns null **and** self-reports on stderr, saying whether it is "no such ID", "the library will not load" or "no Initializer" | a silent null leaves the app unable to tell those apart — and that is the one thing the app needs |

**The two consequences of compile-time-ification must be spelled out:**

1. **The set of usable extensions is fixed at build time.** AIR can load extensions the app never
   declared; here an extensionID that is not in the descriptor table is self-reported and answered
   `null` — which is exactly AIR's answer for "no such ID", not a silent success.
2. Conversely, **an entry that is in the descriptor table but whose library is missing is an error,
   not a degradation** (the post-link stage checks that `extensions/<extID>/<platform>/<nativeLibrary>`
   was really written, and prints a line for each).

### 3.4 Platform keys and directory names (two vocabularies, do not mix them)

AIR's platform keys are a **closed set**, and **not every key has a matching host library**:

| AIR platform key | `lib/bin/<directory>` | Host library | Note |
|---|---|---|---|
| `Windows-x86` | `windows-x86` | ✅ `asaot.dll` + `asaot.lib` | 32-bit |
| `Windows-x86-64` | `windows-x64` | ✅ `asaot.dll` + `asaot.lib` | 64-bit |
| `MacOS-x86-64` | `macos-x86-64` | ❌ | the key is right, the host library is **not built** (§5 defect 2) |
| `iPhone-ARM` | `ios-arm64` | ❌ | as above |
| `MacOS-x86` | — | — | a key AIR really has, but we have no host library ⇒ `aneHostDirName()` **throws**, it does not guess a directory |

Two easy pitfalls, both **measured**:

* **macOS's key does not encode the architecture.** AIR SDK 51.4.1's
  `Adobe AIR.framework/.../Adobe AIR` is a **universal binary** (x86_64 + arm64 slices), and the
  ANE-loader string table has `MacOS-x86-64` in **both** slices. So Apple Silicon looks for
  `MacOS-x86-64` too — the architecture lives in the `.dylib`, not in the key. (We once returned a
  `MacOS-AOT` for darwin/arm64; that key has 0 hits across the SDK's 2079 files. Fixed.)
* **Windows' key is the width**, and AIR **has no Windows ARM64 runtime** (51.4.1's two Windows
  runtimes each carry exactly one key). So on Windows ARM64 `--ane` **refuses to guess** and requires
  an explicit `--ane-platform Windows-x86-64` **plus a 64-bit build** (which is how AIR itself runs
  there: x64 under emulation).

**Why `macos-x86-64` rather than `macos-arm64`**: that directory name is **not** a product-slice name,
it is AIR's macOS key (a key that is architecture-neutral and cannot tell macOS's two architectures
apart). `windows-x64`, by contrast, *is* a product-slice name, because AIR's Windows key carries the
width itself. The difference between the two vocabularies is **informative** here, not a typo.

### 3.5 What happens at compile time and what at post-link time

A build with `--ane` does these extra things (all in one place, `src/index.ts:440-472`; **a build
without `--ane` is byte-for-byte identical to before these changes**: no `-DASC_HAVE_FRE`, no
`asaot.lib`, no extra include path):

```
compile time:  -D ASC_HAVE_FRE=1
               include path += <repo>/lib            (the one contract header for asaot.h / shim)
               link path    += <repo>/lib/bin/windows-x64
               link library += asaot
post-link:     copy asaot.dll to <exe directory>
               write <exe directory>/extensions/<extID>/<platform>/<nativeLibrary> (one per --ane)
```

Manifest fields (`src/build.ts`, kebab-case): `ane-paths` (array), `ane-platform` (string). CLI beats
manifest (TypePHP's "CLI beats YAML"). `--ane` is repeatable.

### 3.6 The app declares extensions: descriptor-driven (`--air-app`)

A real AIR app's extensions are not written on the command line, they are written in **its own descriptor**:

```xml
<extensions>
  <!--<extensionID></extensionID>-->          <!-- the empty placeholder the SDK template
                                                   leaves behind, commented out -->
  <extensionID>com.example.wincore</extensionID>
  <extensionID>com.example.rtc</extensionID>
</extensions>
```

`--air-app <app.xml>` now reads that block and turns it into the manifest's `ane-paths` — **no `--ane`
needs to be spelled out on the command line**:

```
--air-app <appDir>/application.xml            # packages are looked up under <appDir>/ext-aot, <appDir>/lib, <appDir>/ext-folder
--air-app <appDir>/application.xml --extdir <dir>   # --extdir is repeatable; giving it overrides the three defaults above
```

Three rules, each settled by measurement first:

1. **Resolve by declaration, not by directory contents.** `<extensionID>` is the only basis; what and
   how many packages sit in a directory plays no part. Measured (a real project): `lib/` held **14**
   `.ane` files while the descriptor declared only **5** — among the other 9 were Android-specific
   packages as well as tool and shared-dependency packages. Scanning the directory instead would fail
   the build on packages this app **never asked for** (whereas AIR would not: both `adt`/`adl` only
   honour the IDs in app.xml).
2. **Roots are ordered; first hit wins.** Defaults `ext-aot` → `lib` → `ext-folder`; the same extension
   existing in two places is the normal case (`lib/` is the packaged form `adt -package -extdir` eats,
   `ext-folder/` is the unpacked tree `adl -extdir` eats, and a project that has ever run unpacked has
   both), and once taken no later root is consulted. Entries inside a directory are enumerated **sorted
   by name** — `readdir`'s order depends on the filesystem, and "which of these two packages wins"
   should not be decided by it.

   `ext-aot` is ordered **first**, because an extension's AIR original and its AOT rebuild **declare the
   same `<extensionID>`** (an app should not change a line of source just to switch build mode), so
   "which one is used" is decided purely by root order. That must be a **named** directory rather than
   a coincidence of name sorting inside one directory — measured: with the staging tree `WinCore-aot`
   and the packaged original `WinCore.ane` in the same root, the former wins (`-` is code point 0x2D,
   less than `.`'s 0x2E); but sorting looks at the directory name's **first letter** — once it sorts
   *after* `WinCore` (measured by renaming it to `ZZWinCore-aot`), the AIR original wins instead. The
   original packages stay put in `lib/`/`ext-folder/` and `adl` and `adt` are unaffected. The recipe is
   in §3.7.
3. **Declared but not found ⇒ hard error**, following `adl`'s own wording:

   ```
   Requested extension com.example.wincore could not be found.
     looked in:
       <appDir>/lib
       <appDir>/ext-folder
     those directories offer: com.example.rtc <- <appDir>/lib/RTCExt.ane
   ```

   Only with "which directories were searched" (absent ones marked `(absent)`) and "what those
   directories offer" can one tell whether it is a typo in `--extdir`, an unfilled directory, or a
   wrong ID in the descriptor. There is **no** escape hatch such as `--no-extensions`: `adl` refuses to
   start in the same situation (measured exit 5), and silently dropping one extension would turn every
   `createExtensionContext` into null with not a word on stderr (§1.5 defect).

What gets written into the manifest is a **resolved path snapshot** (relative to the manifest
directory, in descriptor order):

```json
"ane-paths": ["lib/WinCore.ane", "lib/RTCExt.ane"]
```

A path snapshot rather than a list of IDs, so that the manifest itself is reproducible: the next build,
even without `--air-app`, has `ane-paths` pointing at something definite. `--ane` is still available
(and is the only entry point that does not depend on a descriptor); `--extdir` given **without**
`--air-app` is rejected — it says "where the packages the descriptor declares live", and with no
descriptor there is nothing to resolve. **The platform key is still decided by `--ane-platform` / the
descriptor's `<architecture>`**, independently of the choice in section 4.

### 3.7 Where a rebuilt extension goes (`ext-aot/`)

The product §4 rebuilds is a **staging directory tree** (`extension.xml` + `<platform>/<library>`).
Dropping it in `<appDir>/ext-aot/<extension id>/` is all the placing it needs; `--air-app` picks it up
automatically — **nothing has to be added on the command line**:

```
<appDir>\ext-aot\com.example.wincore\
  extension.xml                        ← byte-for-byte the same as the one inside the AIR original
  Windows-x86\Wincore.dll              ← the rebuilt one (imports asaot.dll)
  Windows-x86-64\Wincore.dll
```

**The directory name convention is the extension id** (`--air-app` does not require it, but it is a
good convention): it mirrors the runtime on-disk layout `extensions/<extension id>/<platform>/`, so
"one id, one tree" is visible, and placing several extensions side by side later needs no second naming
scheme. `<any name>` is accepted too, but then "what this directory holds" is visible only from the
descriptor.

```json
"ane-paths": ["ext-aot/WinCore", "lib/RTCExt.ane", "lib/CefExt.ane", "…"]
```

Rebuilt extensions go through `ext-aot/`, everything else still comes from `lib/` — **pushed one
extension at a time**, and an ID that `ext-aot` does not contain falls through to the next root rather
than erroring just because the directory has not been created yet. Four things to note:

1. **Do not** copy the extension's own AS3 wrapper sources along with it. The app's `src/` already has
   a copy, and that is the copy it should be compiling (measured: a real extension's 6 wrapper classes
   are **byte-for-byte identical** in the app's `src/` and in the rebuilt product's `src/`).
2. **Do not** put it in `lib/` or `ext-folder/`. Overwriting `ext-folder/<extension>.ane/` would make
   `adl` load the AOT-version library (that is the directory `RunDesktop.bat` reads); and putting a
   staging tree **beside** the original is worse — both forms count as packages, so "which wins" falls
   back to directory-name sorting (measured, see §3.6 rule 2), a rename swaps the library, and the
   build says nothing.
3. **A missing package is not an error**: when `ext-aot` does not exist at all, the scan marks it
   `(absent)` and keeps looking, without erroring.
4. Whether the rebuilt product is a staging tree, an unpacked tree or a `.ane` package, the scan
   **accepts all three** (the same forms `--ane` accepts); `ane-paths` may also hold an absolute path
   to the rebuilt product directly (e.g. `E:/…/aot-ane`), at the cost of the manifest no longer being
   self-contained.

---

## 4. The ANE → AOT migration procedure (the heart of this file)

### 4.0 The big picture

```
        ┌──────────────────── the original .ane (not one character changed) ────────────────────┐
        │  library.swf (AS3)            <platform>/native.dll                    extension.xml  │
        └──────────────────────────────────────────────────────────────────────────────────────┘
                 │                                    │
        ① take the AS3 sources                  ② take the native sources
        (mandatory! see §4.7)                   (the premise for recompiling, see §4.1)
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  shim header        │  FlashRuntimeExtensions.h
                 │                          │  (forwards to       │  ← add only, delete nothing
                 │                          │   asaot.h)          │
                 │                          └─────────┬──────────┘
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  recompile + swap   │  asaot.lib, not
                 │                          │  the import library │  FlashRuntimeExtensions.lib
                 │                          │  → new.dll          │
                 │                          └─────────┬──────────┘
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  emit a staging     │  the same extensionID
                 │                          │  directory tree     │  the compiler reads the
                 │                          │  (no packaging,§4.6)│  directory directly
                 │                          └─────────┬──────────┘
                 ▼                                    ▼
        ┌───────────────── as-aot --ane <directory> (also accepts .ane packages) ───────────────┐
        │  the generated C carries the FRE host + the descriptor table → exe                     │
        │  product directory: exe + asaot.dll + extensions\<extID>\<platform>\new.dll            │
        └───────────────────────────────────────────────────────────────────────────────────────┘
```

**Two products, one set of sources**: the original `.ane` keeps serving `adl` (it is the baseline the
regression comparison runs against) and the rebuilt one serves AOT. That way the same driver and the
same `.as` can be A/B-run on both hosts at any time.

### 4.1 Why the original `.ane` cannot be used directly (two hard constraints)

| Constraint | Concrete phenomenon | Source |
|---|---|---|
| **it imports `Adobe AIR.dll`** | the original native library hard-codes `Adobe AIR.dll` as its import module name. AIR installs that file at run time; we **do not produce** it (producing it would mean forging an AIR runtime inside the product directory — colliding by name with a real AIR install and making behaviour depend on DLL search order) | `src/fre.ts:921-` `as_fre_install()`; `lib/asaot_host.c` |
| **the ABI must be byte-for-byte equivalent** | otherwise a struct layout / enum value / signature mismatch shows up as memory corruption rather than an error | `lib/asaot.h` |

One **rejected** alternative route, recorded here so nobody re-invents it (**not implemented, not
measured**): build a forwarder named `Adobe AIR.dll` so the original ANE needs no recompiling. It was
rejected for the "forging the AIR runtime's file name" reason itself: it collides by name with a real
AIR installation and wagers correctness on DLL search order. So the route chosen is "if the sources are
available, recompile and rename".

### 4.2 Step 1: prepare the host library first (once is enough)

```bat
cd as3compiler\lib
build-asaot.bat            :: no argument = build both widths (windows-x86 + windows-x64)
```

Products: `lib\bin\windows-x64\asaot.dll` + `asaot.lib` (and the same for `windows-x86`). **This is our
side's product in "one set of sources, two products"**; building it once serves every extension.

Checkpoint: the module name recorded in `asaot.lib` must be `asaot.dll` (`build-asaot.bat` asserts this
itself with `findstr`). **That check is not decoration**: an import library with no module name is
**completely silent** at build time and only much later shows up as "even the recompiled ANE still
wants `Adobe AIR.dll`".

### 4.3 Step 2: add a shim header (3 lines)

An ANE's native sources say `#include "FlashRuntimeExtensions.h"` — that is the name the SDK ships, and
an extension has never known about any other. **The rule is not to modify the ANE's source tree.** So
put a same-named file **first** on the include path, forwarding to our contract header:

```c
/* <your project>\shim\FlashRuntimeExtensions.h */
#ifndef ASC_FRE_SHIM_INCLUDED
#define ASC_FRE_SHIM_INCLUDED
#include "asaot.h"
#endif
```

Three lines of cost buys "zero changes to the extension's sources" + "one include name, two ABIs". See
the comment at the top of `lib/asaot.h` and this repo's
`examples/ane/shim/FlashRuntimeExtensions.h`.

### 4.4 Step 3: recompile + swap the import library

> **Read §4.10 first**: the baseline for recompiling is **committed-state** sources and dependencies,
> not the working tree. A real project's working tree is often in the middle of a half-finished
> dependency upgrade, and building from it turns "working-tree drift" into a false report of "this
> extension needs patching".

**Command line (clang-cl / a small project)** — this repo's example takes this route:

```bat
clang-cl /nologo /LD /O2 /MD /EHsc /W3 -Wno-invalid-source-encoding ^
  /I "<your project>\shim" /I "<repo>\as3compiler\lib" ^
  "<your project>\MyExt.c" ^
  /Fo:<project>\build\ /Fe:<project>\build\MyExt.dll ^
  /link /INCREMENTAL:NO /MACHINE:X64 ^
  /LIBPATH:"<repo>\as3compiler\lib\bin\windows-x64" asaot.lib
```

**VS project (`.vcxproj`, which is what real projects use)** — change three places only; everything
else (toolset, `/MD`, macro definitions) stays **completely untouched**:

| Project property | From | To |
|---|---|---|
| Additional include directories | (the SDK's include) | **the `shim` directory first**, then `<repo>\as3compiler\lib` |
| Additional dependencies | `FlashRuntimeExtensions.lib` | `asaot.lib` |
| Additional library directories | (the SDK's lib directory) | `<repo>\as3compiler\lib\bin\windows-x64` |

Four measured pitfalls, all of the "looks right, turns out wrong" kind:

1. **`-I shim` must come first.** Otherwise `#include "FlashRuntimeExtensions.h"` hits the SDK's header
   and the product still imports `Adobe AIR.dll` — **it compiles, it links, and it fails to load at the
   end**.
2. **Keep the extension's original toolset and CRT** (one measured real project used VS2015 v140 +
   `/MD`). Changing the toolset changes the ABI and the CRT version, which has nothing to do with this
   migration and is self-inflicted trouble.
3. **Non-ASCII sources must be silenced explicitly**: an old project's sources are often GBK and `cl`
   reports C4819; `-Wno-invalid-source-encoding` / `/wd4819` is enough (**not** re-encoding the sources,
   which would amount to modifying the ANE's source tree).
4. **Do not quote the paths after `/Fo:` `/Fe:`**, especially when they end in `\`: a backslash before
   the closing quote is parsed as an escape by the command line and **swallows every following line
   into one argument**, with the symptom `unable to open output file`.

### 4.5 Step 4: verify the rebuilt product (skip this and you find out one step too late)

```bat
llvm-objdump -p build\MyExt.dll | findstr /I /C:"DLL Name" /C:"ExtInitializer" /C:"ExtFinalizer"
:: the VS-environment equivalent: dumpbin /dependents /exports build\MyExt.dll
```

All of the following must hold at once:

* **the import table contains `asaot.dll`** (measured output for `examples/ane`: `asaot.dll` +
  `KERNEL32.dll` + VCRUNTIME…);
* **the import table does not contain `Adobe AIR.dll`**;
* **the export table contains `<Name>ExtInitializer` and `<Name>ExtFinalizer`**, spelled exactly as in
  `extension.xml` (both AIR and we `GetProcAddress` **by name**).

One aside: recompiling does not change the extension's own **system** requirements (a certain real
project still imports `MFPlat.dll` / `MFReadWrite.dll` / the VC runtime, for instance). Those are
requirements the extension always had, and `adl` has them too when it runs it.

**Verify the copy that will actually be loaded, once more.** What was verified above is the build
output; and inside a package (or a directory tree) **two platform slices share a name**, so mistakes
like "built the wrong width" or "copied the original slice in" produce something that is **perfectly
resolved at compile time and explodes at run time**, with an error message that misleads towards "the
extension was not recompiled". So what really matters is verifying the **staged copy** again, with one
more check than the width: **the import table must contain `asaot.dll` and must not contain
`Adobe AIR.dll`** — that is the one property separating an "AOT version" from an "original" (in the
migration example it is `aot-ane\check-ane.cjs` that does this).

### 4.6 Step 5: write `extension.xml` + emit the staging directory tree (**no need to package a `.ane`**)

```xml
<?xml version="1.0" encoding="utf-8"?>
<extension xmlns="http://ns.adobe.com/air/extension/51.0">
  <id>com.example.myext</id>                    <!-- the same id the AS3 side passes to createExtensionContext -->
  <versionNumber>1.0</versionNumber>
  <platforms>
    <!-- write only the platform you are building; entries for other platforms do no harm, but are never used -->
    <platform name="Windows-x86-64">
      <applicationDeployment>
        <nativeLibrary>MyExt.dll</nativeLibrary>          <!-- the recompiled one -->
        <initializer>MyExtExtInitializer</initializer>
        <finalizer>MyExtExtFinalizer</finalizer>
      </applicationDeployment>
    </platform>
  </platforms>
</extension>
```

Directory structure: `extension.xml` at the root, the native library in a **directory named after the
AIR platform key** (packaging a `.ane` is also fine, with `extension.xml` either at the ZIP root or
under `META-INF/ANE/` — **both are accepted**; `library.swf` is **not needed** — the AS3 half travels
as sources, not as bytecode):

```
<your output directory>\
  extension.xml
  Windows-x86-64\MyExt.dll
  Windows-x86\MyExt.dll
```

**Why we no longer package.** A package rebuilt for AOT has exactly one consumer — as3compiler. Its
library imports `asaot.dll`, and `asaot.dll` forwards into **the generated program's own table**, which
AIR simply does not have ⇒ **AIR structurally cannot load this library, signed or not** (so this is not
"not needed yet"). Add to that the `library.swf` an `.ane` mandates being dead weight here (it carries
`DoABC`, which is outside this project's scope, so an extension's AS3 classes must be compiled from
`.as` sources either way, see §4.7), and `adt -package` also wants a signing certificate — **handing
that directory tree straight to `--ane` is a net win**. The measured migration example (§6) does
exactly that, end to end, in both widths.

The native library's path is found under **all three layouts**, matched in order:

| Order | Path | Produced by |
|---|---|---|
| 1 | `<nativeLibrary>` | a hand-made flat package (**no longer the route in the example**: since §4.6 the rebuilt product comes out as a staging tree, but this form was packaged historically and external tools still produce it, so the candidate list keeps it) |
| 2 | `META-INF/ANE/<platform key>/<nativeLibrary>` | **`adt -package`'s official layout** — what real projects almost always are |
| 3 | `<platform key>/<nativeLibrary>` | `adt`'s **staging directory** layout; this is precisely "step 4's product tree" and "a directory-form `--ane`" |

This one was a real defect once: `readAne` only looked for the native library at the root, so
**official packages were rejected outright** (reporting "this package has no such native library" while
`adl` loaded the very same package fine — the error pointed at the only correct line). All three
layouts are recognised now, and when none is found it **lists all three candidate paths plus what the
package actually contains** (up to 12 entries), instead of leaving you guessing at an empty pointer.
Pinned by `unit: ane/PackageLayout` (16 checks, 8/8 caught by mutation testing).

> **Directory input is an enhancement, not alignment.** Per §1.5, plainly: AIR never loads a staging
> directory, so **no AIR-defined behaviour is rewritten**; and the ZIP path did not change by a single
> byte. The two share **one candidate table** (names inside a directory are normalised to `/`
> separators, so readings agree across platforms), which incidentally means a **manually unzipped
> official package** just works too (via candidate 2).

> **Comments in the descriptor are perfectly writable.** This was once a real defect: a
> `<platform name="...">` appearing inside a comment would pair with the **real entry's** `</platform>`,
> inventing a platform entry out of thin air and **swallowing the real one**, so the build reported back
> "this ANE has no `Windows-x86-64` entry", pointing at the only correct line. Comments are now
> stripped before parsing; an unterminated comment is **rejected by name of the package** (rather than
> being left to pollute the scan). Pinned by `unit: ane/ExtensionXmlComments`.

If you do still want a `.ane` (for archiving, say), any packaging tool will do — **`adt` is not
required**. This repo used to carry two pieces of scaffolding for that (a zero-dependency STORE-packing
`mkzip.cjs`, and a packaged 9,223-byte fixture), but both **retired along with** the example's move to
a staging tree (§4.6): the delivery form no longer includes a `.ane`. The package form itself is still
pinned by `unit: ane/PackageLayout` and `unit: air-app/Extensions` — those two synthesise real ZIPs on
the spot rather than borrowing an unmaintained binary fixture.

### 4.7 Step 6: how the AS3 side gets compiled (**this step decides success or failure**)

**Key constraint: the extension's AS3 wrapper classes must have `.as` sources.** AIR loads
`library.swf` **at run time** and executes the ABC bytecode in it; AOT **statically links** classes, so
it must have the definitions. The `DoABC` inside `library.swf` is outside this project's scope (that
would need a decompiler or an AVM2 interpreter) — this is the **biggest practical obstacle** to ANE
migration, see §5 defect 5.

Two ways to provide the input:

```bat
:: (a) command line: pass the driver + the extension's AS3 sources as inputs
node src\index.ts driver.as ^
  path\to\ext\MyExt.as path\to\ext\Helper.as ^
  --manifest my.build.json -o build\driver.exe

:: (b) --air-app: the extension's AS3 sources must live under src\ (--air-app currently only walks
::     the single src\ beside application.xml; there is no extra source-root argument)
node src\index.ts --air-app app.xml -o build\myapp.exe
```

Add `ane-paths` to the manifest:

Each `ane-paths` entry may be a `.ane` package, an **unpacked directory**, or the rebuilt product's
**staging tree** — the three are equivalent:

```json
{ "target": "native", "ane-paths": [ "path/to/aot-ane" ] }
```

When rebuilding per application, the route in §3.7 is less work: copy the product into
`<appDir>/ext-aot/<name>/`, let `--air-app` find it by the declared ID, and the manifest then holds
only relative paths.

**How the width is chosen (this was once a defect)**: for a native Windows build the platform key
**follows the manifest's `architecture`**, not the machine the compiler runs on — `"architecture": "64"`
→ `Windows-x86-64`, `"32"` → `Windows-x86`, and only an absent value falls back to the host platform.
The reason comes from AIR's own policy: what AIR gives a 32-bit captive app is the x86 runtime, so an
`"architecture": "32"` build should get the **x86 slice**. Taking the key from the host means a 32-bit
build links the x64 `asaot.lib` and stages the x64 slice, compiling and linking all the way through and
**exploding only at run time** (see diagnosis 193 in §4.8). Pinned by `unit: ane/PlatformForBuild`
(11 checks, including a cross-module pin that "the width reads the same in two modules"; mutation 4/4).

`--ane-platform` remains the explicit override (also used for cross builds, e.g. building a macOS
target on Windows), and it decides which width of host library under `lib/bin/` is used.
`"architecture": "arm64"` on Windows **is rejected unless overridden explicitly**: AIR has no Windows
ARM64 runtime, and an arm64 process cannot load the x64 `asaot.dll` either, so the error message names
the **target** as having no key (not the host) and asks for a 64-bit build. This is especially worth
noting with `--air-app`: an AIR descriptor's `<architecture>` **defaults to `32`**, so on Windows an
`--air-app` build without `<architecture>64</architecture>` now rightly takes the x86 slice.

With `--air-app`, the application descriptor also needs
`<supportedProfiles>extendedDesktop</supportedProfiles>` — that is AIR's own requirement (`adl` wants
it too).

### 4.8 Step 7: running it, and the "symptom → cause" table

The product directory looks like this (**relocatable as a whole**; paths resolve relative to the
executable):

```
build\
  myapp.exe
  asaot.dll                                   ← the FRE host forwarder
  extensions\
    com.example.myext\Windows-x86-64\MyExt.dll  ← the recompiled native library (one directory per extension)
```

Two extensions each carrying a same-named `MyExt.dll` is safe too: they land under their own `<extID>\`
(the defect fixed in §5.1), and this layout is isomorphic to the separate directory AIR gives each
extension.

Every AOT-side problem goes to stderr on **the same rate-limited self-report channel**, prefixed
`[as3-aot] not implemented by this build: ...`. Look yours up by symptom:

| Symptom (stderr / phenomenon) | Cause | What to do |
|---|---|---|
| `asaot.dll could not be loaded from beside the executable (Win32 error 193; 193 = wrong bitness, 126 = not found)` | **width mismatch**: the exe is 32-bit while an x64 `asaot.dll` sits beside it (or the reverse) | make the manifest's `architecture` agree with the product's width (§4.7); this should have been settled at compile time |
| the same, but the code is `126` | the file really is not there | re-run the build (the post-link stage copies it automatically); or copy it by hand |
| `asaot.dll does not export asaot_bind (stale or foreign build)` | the `asaot.dll` is from some other version | re-run `lib\build-asaot.bat` |
| `asaot.dll was built against a different ABI version` | `asaot.h` changed but the DLL was not rebuilt | as above |
| `asaot.dll is missing from <path>...Build it first: run lib/build-asaot.bat` | the host library is missing **at build time** | run `lib\build-asaot.bat` |
| `no native extension with this ID is part of the build: <id>` | that id is not in the `--ane` list (**the extension set is fixed at compile time**) | add its `.ane` to `--ane` / `ane-paths` |
| `extension native library not loadable: <lib> (Win32 error 193; ...; an ANE that still imports Adobe AIR.dll must be recompiled against asaot.lib)` | **two cases, now separable**: `193` = the staged slice's width does not match the product (go to §4.7); `126` = the library or one of its dependencies was not found. Using the original `.ane`, or getting the `-I` order wrong when recompiling, also lands here | read the code first: 193 → §4.7, otherwise back to §4.4 and check the import table with §4.5 |
| `extension exports no Initializer named <Name>` | the export name disagrees with `extension.xml` | match it up against `dumpbin /exports` |
| `extension Initializer set no ContextInitializer: <Name>` | the extension's Initializer did not set `ctxInit` | an extension implementation problem (AIR would be null here too) |
| `the extension publishes no function named <fn>` | the name is misspelled, or the function is not in the published function table | match it up against the extension's `FRENamedFunction[]` |
| `the extension published no function table` | `ContextInitializer` returned with `numFunctions=0` | an extension implementation problem |
| `FREGetRenderMode (the render pipeline is out of scope for this build)` and the other 10 | you hit **Face D** | see §5 defect 1; video/presentation functionality does not exist this phase |
| `ExtensionContext.getExtensionDirectory (this build stages only the native library, under extensions/<extensionID>/<platform>; the rest of the package is not unpacked)` | the extension is looking for a resource file it ships with | see §5 defect 4 |
| the whole program runs without an error but `createExtensionContext` returns null | **should not happen** — if it does it is a defect; please report it together with the stderr | —— |

### 4.9 The smallest runnable example: `examples/ane/` (two routes, one fixture)

This repo has a complete, reproducibly generated minimal loop (all 43 assertions pass). **The rebuilt
product is a staging directory tree, not a `.ane`** (§4.6 no longer packages), so the example
directory's shape is the shape of the run-time `extensions/` directory —
`<extension id>/<platform>/<library>`:

| File | Role |
|---|---|
| `examples/ane/ProbeANE.c` | the extension's **native half**, 21 KB, covering integers/floats/UTF8/booleans/arrays/byte arrays/object properties/method calls/native data/status events/threads and mutexes/throwing/the **FRE string length contract** (`stringInfo`) |
| `examples/ane/shim/FlashRuntimeExtensions.h` | the §4.3 shim, and it **deliberately makes `ProbeANE.c` use AIR's include name** so the shim is really exercised |
| `examples/ane/build-ane.bat` | the §4.4 recompile recipe (clang-cl); after building it automatically runs the §4.5 import-table check and installs the result into **two** staging trees |
| `examples/ane/ext-aot/com.example.probe/extension.xml` | the §4.6 descriptor (directory name = extension id) |
| `examples/ane/ext-aot/com.example.probe/Windows-x86-64/ProbeANE.dll` | the rebuilt product (19,456 bytes, imports `asaot.dll`) |
| `examples/ane/driver.as` | the AS3 driver, where **every line is an assertion**, ending with `RESULT passed=N failed=0` |
| `examples/ane/ane.build.json` | the build manifest (`ane-paths` pointing at that staging tree) |
| `examples/ane-app/` | §4.9.1: the same fixture going through `--air-app` + the descriptor's `<extensions>` |

How to run:

```bat
node test.ts                              :: the full regression includes both examples (one case each)
:: or individually:
node --test --test-name-pattern='example: ane' test/examples.ts
```

**The example is a "must succeed" program**, so it doubles as a regression net: break FRE semantics and
its assertions go red immediately. On a machine with no host library (CI's macOS runner, say) it
**skips loudly** rather than pretending to pass.

### 4.9.1 The second route: `examples/ane-app/` (declared in the descriptor → resolved automatically)

`examples/ane/` takes the "name the package on the command line / in the manifest" route, with **no
descriptor**. A real project takes the other one: `application.xml`'s
`<extensions><extensionID>` declares what it wants and `--air-app` looks it up in
`ext-aot` → `lib` → `ext-folder` (§3.7, §4.6). The two routes are different code, so each needs its own
example:

| File | Role |
|---|---|
| `examples/ane-app/ane-app.xml` | the descriptor: `<extensions>` declaring **one** id; `<visible>false</visible>` (offscreen, so after building you can `--run` and exit) |
| `examples/ane-app/src/Main.as` | the AS3 entry point (`extends Sprite`), 8 assertions: an undeclared id resolves to null, a declared one builds a context, `ping`/`addInt`/native data/`truthy('')`/`StatusEvent`/`dispose` |
| `examples/ane-app/ext-aot/com.example.probe/` | **byte-for-byte identical** to `examples/ane/`'s staging tree (the same `build-ane.bat` writes both, and a pin holds that identity) |
| `examples/ane-app/ane-app.build.json` | a by-product that `--air-app` **rewrites on every run** (`ane-paths` = `["ext-aot/com.example.probe"]`), so it is **not committed** |

How to run (`--air-app` writes `ane-paths` into the manifest and the loader then drops the library into
`<exeDir>/extensions/<extension id>/<platform>/`):

```bat
node src/index.ts --air-app examples/ane-app/ane-app.xml --main-class aneapp.Main --target native -o out/ane-app.exe --run
```

The 8th assertion (an unknown id) prints the build-time self-report verbatim — `not implemented by this
build: no native extension with this ID … com.example.nope` — **which is the behaviour §1.5
requires**: a missing capability is named out loud, never a silent null.

### 4.10 Step 0 (addendum): the baseline for recompiling is the **committed state**, not the working tree

§4.4 assumes something: that the extension's sources "just build". In real projects that often does not
hold, but **work out whose problem it is before touching anything** — in one measured case (a CEF-class
extension) the working tree's sources did not build, while the same file built from `git HEAD` with
**not a single patch**. Patching first would have turned "one uncommitted broken edit" into the
conclusion "upstream is defective".

**Run these three criteria before talking about "defective sources":**

1. **If `git -C <extension repo> status --porcelain -- <source dir>` shows `M`, read the diff first.**
   The working tree is a moving target. In that measured case the edits left sources that **would not
   build in any version**: an entire access-specifier block macro had a return type prepended, one API
   was redirected to a host object that **never had it**, GBK comments were re-encoded into U+FFFD, and
   one header was rewritten wholesale with LF.
2. **Take the dependency version from the library the app actually ships**, not from whatever sits in
   the project's `Dependencies/`. Method: look for a version string inside that `.dll` (for CEF it is
   `x.y.z.g<sha>` plus `chromium-<ver>`). Measured: the app shipped `3.2987.1601` / Chromium 57 while
   the project had a half-finished upgrade to 109. **CEF validates API hashes at run time, so the
   wrapper library must be compiled against that same version**; new headers against an old runtime is
   a run-time explosion waiting to happen.
3. **When the working tree has deleted the dependency directory** (very common mid-upgrade), **do not
   rewrite someone else's tree**: extract the subtree from a commit
   (`git ls-tree -r --name-only <rev> -- <dir>` to list it + `git cat-file --batch` to read all the
   blobs in one go) into your own staging directory. That makes "which commit can this product be
   rebuilt from" answerable. Measured: 237 include headers + two `.lib` files extracted in one go, and
   the artifact was then produced entirely from the committed state.

**Three pitfalls on old native sources — their common feature is that "the line the error points at is
not the root-cause line":**

| Phenomenon | Mechanism | Handling |
|---|---|---|
| `error C2059: syntax error: "{"`, with the line number pointing at the first line of some function body | the line **above** it is a non-ASCII comment whose last byte happens to be a DBCS **lead byte**, while the newline is a **bare LF**: `cl` treats that LF as the trail byte of the character under the current code page, so the comment swallows the next line | normalise that file's EOL to CRLF (with `0xBD 0x0D` paired, the LF still ends the line). Do **not** read this as "the file ought to be CRLF": EOLs may differ line by line within one file; only the dangerous lines need normalising. The normalisation is a whitespace-only change and must be done **byte-wise** (mirror the file as latin1, never decode as UTF-8) |
| the error lands inside a macro expansion and the root cause cannot be found at the reported line | a macro like `IMPLEMENT_LOCKING(name)` expands into a **whole access-specifier block** (`public: class AutoLock{…}; void Lock(); void Unlock(); private: base::Lock lock_;`), and prepending a return type to it explodes dozens of lines later | go back to the use site and ask "is this macro a block macro?", rather than fixing the reported line |
| it builds, but the comments are all mojibake / the behaviour is suspicious | an editor with UTF-8 decoding was used to bulk-edit sources containing GBK comments: the bytes became U+FFFD and it **still builds** — silent semantic damage | do not bulk re-encode; if you must change something, change it byte-wise |

**Verification must "really load each one"**: `as_ane_load` is **lazy** (only the first
`createExtensionContext` calls `LoadLibrary`), so "run the app" proves only the extensions it
**happened to use**. To prove all N are fine, have the probe **build one context per id declared in the
descriptor**, printing one conclusion line per id and a count on the last line (measured `E2E DONE
7/7`). Static checks alone (import table, width, export names) prove only "it was installed right",
never "it loads".

---

## 5. Defects and gaps (reported faithfully)

Per AGENTS.md §1.5: **`adl` gets it right and we do not ⇒ a leftover defect**; only what AIR itself does
not support is an enhancement. Everything in the table below is the former, and **every row is "reported
loudly + logged"** — not one of them is a silent degradation.

| # | Gap | Phenomenon | Self-reported? | Path to landing it |
|---|---|---|---|---|
| 1 | **Face D render pipeline** (11 entry points) | a video/presentation-class extension gets no render mode, no media buffer, no window handle | ✅ `FRE_ILLEGAL_STATE` + self-report | needs a real presentation backend (Skia/D3D interop + exposing the window HWND), a separate project |
| 2 | **no host library for macOS / iOS** | `lib/bin/macos-x86-64/`, `ios-arm64/` do not exist, so `--ane` on macOS always fails | ✅ build-time error quoting that path | `lib/asaot_host.c` is a width-independent thin forwarder; the macOS side needs a `dlopen`/`dlsym` branch + a `build-asaot.sh`. **The platform key is already fixed** (§3.4); the library is what is missing |
| 3 | **Windows ARM64 unverified** | guards exist (refuses to guess a key, demands an explicit 64-bit build), but the arm64 dependency chain has never been built (no MSVC arm64 toolset on this machine) | ✅ refuses and advises | needs an arm64 Windows machine + toolset |
| 4 | **the extension is only partially unpacked** | each extension now has its own directory `<exe directory>/extensions/<extID>/<platform>/` (new here, §3.3), but **only the native library** is in it: the extension's other packaged files (data files, auxiliary DLLs) are not. So `getExtensionDirectory()` still only **self-reports** and does not return that directory | ✅ self-report | drop the **whole package** into `extensions/<extID>/` (half the layout work is done; the rest is unpacking all entries), after which `getExtensionDirectory()` can return a real directory |
| 5 | **an ANE class without `.as` sources cannot be AOT'd** | when the extension's AS3 wrapper classes exist only in `library.swf`'s `DoABC`, the extension is unusable | ✅ undeclared class = compile-time error | needs a decompiler or an AVM2 interpreter, outside this project's scope (the §3.3 conclusion) |
| 6 | **AIR 50 members of `ExtensionContext` are not modelled** | `functions` / `knownExtensions` / `getExtensionInfo` / `loadExtension` do not exist | ✅ undefined ⇒ error | the first three are a read-only reflection surface; `loadExtension` is **not a small change**: it is **lazy loading** (`LoadLibrary` + Initializer at the first `call`), requiring face C's load timing to move from "at construction" to "at first call" plus caching |
| 7 | **`File.applicationDirectory` is missing** | real AIR apps use it to locate packaged resources (and it is also the basis of the `extensions/` layout) | ✅ undefined ⇒ error | land it with the `url`/`nativePath` measured on `adl` |
| 8 | **the descriptor table caps at 32** | the 33rd extension is rejected **at compile time**. **This gate is new here**: previously 33 extensions would compile, link and stage **all green, exit 0, with not a word of warning**, until the 33rd `createExtensionContext` at run time wrote past `as_anes[32]` (measured) | ✅ compile-time error with the way out | raise `ANE_COUNT_MAX` in `src/fre.ts` (the `FRE_HEAD`'s `ASC_ANE_COUNT_MAX` is interpolated from it — one source of truth); the current value is simply a deliberate bound |
| 9 | **face C is Windows-only** | `LoadLibraryA` / `CRITICAL_SECTION` / `GetModuleFileNameA` / `Sleep` are all Win32 | —— | the two halves of the same thing as defect 2: the host library and face C's POSIX branch must be done together |

### 5.1 Fixed defects (kept as lessons)

All six are of the "**`adl` gets it right, we do not**" kind, and all were measured while migrating a
real third-party ANE; all are fixed now and have behavioural pins. Their value in being listed here is
their common shape: **every one of them "looks right and turns out wrong"**.

| Defect | Symptom | Fix | Pin (checks) |
|---|---|---|---|
| **the descriptor's `<extensions>` was ignored entirely** | an app declared extensions in `application.xml` and we read none of it: the build was all green, the extension table was 0, every `createExtensionContext` returned null and stderr said **not a word**; `adl` **refuses to start** in the same situation (measured exit 5, `Requested extension … could not be found.`). Spelling out `--ane` by hand worked around it, but the app's own declaration is the real source | `--air-app` reads `<extensions>` (stripping comments first; an empty `<extensionID>` does not count — the SDK template has one such placeholder), resolves the declared IDs from `lib`/`ext-folder` (or `--extdir`) into `ane-paths` written to the manifest; declared but not found ⇒ hard error listing the directories searched and what they offer, in `adl`'s own wording. **Resolve by declaration, not by scanning the directory**: a real project's `lib/` had 14 `.ane` files and its descriptor wanted 5 | `unit: air-app/Extensions` (25; mutation 14/14 all caught) |
| `extension.xml` parsing did not understand comments | a comment containing a `<platform name="...">` invented a platform and **swallowed the real one**, so the build reported back "this ANE has no `Windows-x86-64` entry" | strip `<!-- -->` before parsing; an unterminated comment is **rejected by package name** | `unit: ane/ExtensionXmlComments` (9) |
| `readAne` only understood the flat layout | official `adt` packages (`META-INF/ANE/<platform>/<lib>`) were rejected outright while `adl` loaded the same package fine | recognise all three layouts (plus **unpacked directories** — an enhancement, not alignment, see §4.6); on failure, list every candidate path and the real entries | `unit: ane/PackageLayout` (27) |
| every extension's native library crammed into **one directory**, keyed by **file name** | with two ANEs each carrying a same-named `Shared.dll`, the second **silently overwrote** the first: the summary read "2 extension(s)" next to "1 native library(ies)", exit 0; so one extension loaded the other's library and reported "no XXXInitializer in the exports", which **points in the wrong direction**. AIR does not do this (measured on `adl`: with the second package putting a same-named sentinel library under **another extensionID**, the first extension still passed 13/13) | changed to `<extID>/<platform>/<library>` (one directory per extension, isomorphic to AIR); **the path carried in the descriptor and the on-disk key are generated from the same line**, not assembled separately | `unit: ane/PackageLayout` (as above; mutation 5/5 all caught) |
| the ANE platform key came from the **host** rather than the **build target** | a 32-bit build linked the x64 host library and staged the x64 slice: compiling and linking all green, exploding **at run time** | for a win32 native build the key = the width of `architecture`; an arm64 target has no key (refused, naming the target) | `unit: ane/PlatformForBuild` (11) |

| **the FRE string length counted one byte too many** | our `FREGetObjectAsUTF8` returned `strlen+1` (written from the SDK header's own sentence, "Includes the null terminator") while `adl` was measured to return the byte count **without** it. An extension that **carries the length** — `ANEUtils::getString` is exactly `std::string(val, val + length)` — gets one extra NUL byte appended to every string it reads; when that string is embedded verbatim in a protocol frame (a WebSocket URL in an HTTP request line) it becomes `GET /node1?...\0 HTTP/1.1`, and the server closes without answering. Every **wss** connect in the host app's AOT build failed as `status_code 0` + `websocketpp.transport:7` (EOF), while on **the same machine** `adl` loaded the same native library with the same URL and the same token, got `101` and received application frames. Extensions that only hand the pointer to `printf`/`strcmp` never noticed the byte; anything carrying its own length (`std::string`, a protocol frame, a hash) did | changed to `strlen(s)`, matching the `adl` measurement, with the "**the header sentence and the measurement disagree**" fact written into the comment together with the evidence, so nobody "fixes" it back to `+1` from the documentation; the reverse direction, `FRENewObjectFromUTF8`, keeps accepting a caller-supplied terminator (callers spelling `strlen+1` are everywhere) | `unit: fre/Utf8LengthContract` (8; mutation 7/7 all caught) + the native echo assertions in `examples/ane/`'s `stringInfo` (3: 6 ASCII bytes, four CJK chars as 12 bytes, the empty string as 0 bytes, `extra` must be 0 — putting `src/fre.ts` back to `+1` turns this red) |

One accompanying diagnostic improvement: the two load-failure self-reports now **carry the Win32 error
code** (`193` = width mismatch, `126` = not found). Previously they blamed "the library was not
recompiled" unconditionally — and when a pure width problem is labelled "you recompiled it wrong",
people fix things in the wrong direction for a long time.

**Two observations that "are not our defects, but are recorded faithfully"**:

* An original `.ane`'s native implementation may return a `NULL FREObject` while its AS3 wrapper
  declares `:String` — that is **vendor-side** behaviour (the same under `adl`), and all we guarantee is
  not to crash because of it. It has **not been compared against AIR word for word**, so per §1.5 it is
  recorded as-is, counted neither as a defect nor as an enhancement.
* AIR's exact error text when `ExtensionContext.call` names a function the extension **never
  published** **has not been measured** (never observed on a real ANE). We chose to self-report and
  return null rather than invent an error code — inventing an error code is worse than declaring the gap.

---

## 6. Verification and evidence

| Evidence | Content | How to reproduce |
|---|---|---|
| `examples/ane/` | the end-to-end example, **all 46 assertions pass**, last line `RESULT passed=46 failed=0` | `node --test --test-name-pattern='example: ane' test/examples.ts` |
| `examples/ane-app/` | the end-to-end example, **the descriptor half**: `--air-app` resolves the descriptor's `<extensions>` into `ane-paths`, drops the library into `extensions/<extension id>/<platform>/` and runs it; **all 8 assertions pass**, last line `RESULT passed=8 failed=0` (plus one line of the undeclared-id self-report verbatim) | as above |
| `test/unit/emit.ts` → `unit: ane/ExtensionContextSurface` | 9 checks: in the **emitted C**, `getExtensionDirectory` must self-report, must still return a live `File`, and the self-report must **name this build's layout** and say that the directory does **not** hold the whole package; `actionScriptData` is a real member while `extensionID` **is not**; `call`'s "extension never loaded" self-report must be named | `node --test --test-name-pattern='ane/ExtensionContextSurface' test/unit/emit.ts` |
| `test/unit/fre.ts` → `unit: fre/Utf8LengthContract` (8) | both directions of the FRE string boundary: `FREGetObjectAsUTF8`'s `length` must be `strlen` (**not** plus the terminator, and not some other count), `value` must be the string itself, and a non-String must stay `FRE_TYPE_MISMATCH`; in the reverse direction `FRENewObjectFromUTF8` must tolerate a caller-supplied terminator and must not count it as part of the string. Mutation 7/7 (`+1u`, `+1`, swap the `value` pointer, loosen the tag check, drop the tolerance, copy the terminator into the string, omit the terminating 0) | `node --test --test-name-pattern='fre/' test/unit.ts` |
| `test/unit/build.ts` → `unit: ane/ExtensionXmlComments` | 9 checks: a comment must not invent a platform entry, must not swallow the real entry, and an unterminated comment must be rejected by package name | as above, with `test/unit/build.ts` |
| `test/unit/build.ts` → `unit: ane/PackageLayout` (27) | the official `adt` layout, the flat layout and `adt`'s staging layout are all accepted; **unpacked directories** are accepted too (including the two cases of recursion and `/`-separated names, so a manually unzipped `META-INF/ANE` tree is readable); the directory form likewise takes its slice by platform and never borrows another platform's; on failure it must not merely say "no", it must list the candidate paths; **the on-disk path must be `<extID>/<platform>/<library>`** (both in the descriptor and in the staging key, with no bare file name left anywhere); **two extensions may each carry a same-named library and each keep its own bytes**; a library declared in a subdirectory **keeps that subdirectory**; **the extension count cap is a hard gate** (exactly 32 passes, 33 is rejected with the count and the constant name) | as above with `test/unit/build.ts` |
| `test/unit/build.ts` → `unit: ane/PlatformForBuild` (11) | the platform key follows `architecture`; an absent value keeps the host's answer; on wasm/darwin `architecture` has no effect (an AIR descriptor defaults to `32`, which must not become `Windows-x86`); an arm64 target does not invent a key; **the width reads the same in the ANE key and in the target triple** | as above |
| `test/unit/build.ts` → `unit: air-app/Extensions` (30) | **the descriptor-driven half**: `<extensions>` is read in descriptor order, **an ID inside a comment does not count** (the SDK template leaves exactly that placeholder), and **an uncommented empty `<extensionID>` does not count either**; packaged `.ane`, unpacked trees and **staging trees** are all accepted, while an unrelated package directory is still skipped (not an error); with several roots **first hit wins** and later roots still fill in IDs the earlier one lacks; `ext-aot` is ordered **ahead of the default roots**, so a rebuilt package with the same ID beats the AIR original in `lib/`, while an ID absent from `ext-aot` still comes from `lib/`; **packages in the directory do not count — only what the descriptor asks for is returned**; declared but not found is refused (AIR's own wording, the directories looked at, `(absent)` markers, what they offer, **three ways out**); `--extdir` overrides the defaults and is refused without `--air-app`; the written manifest holds **`/`-separated paths relative to the manifest directory**, and with no declaration **not a single key is written**. Mutation 5/5 (drop the staging-tree form / resolve the wrong path / treat every directory as a package / put `lib` before `ext-aot` / drop `ext-aot` entirely) | as above |
| `test/unit/build.ts` → `unit: ane/ExampleFixtureTrees` (7) | the very fact that the two examples share **one fixture** needs pinning: both staging trees exist; `extension.xml` and `Windows-x86-64/ProbeANE.dll` are **byte-for-byte identical** (`readFileSync(a).equals(b)`); both declare one id / one platform / one library; running `resolveExtensionPackages` over that app directory with the real descriptor resolves to that tree; the manifest's `ane-paths` points at it; the app descriptor declares the same id. With this group in place, "the two examples are actually running different things" cannot happen silently | as above |
| `test/unit/build.ts` → `unit: air-app/OffscreenLinkSet` (10) | the link set of a Windows **offscreen** build (`<visible>false</visible>` has no window, but is not "a smaller build": `skia_glue.cc` compiles into every native product and its GDI font manager is reached by `SkFontMgr::Factory()` before any pixel is drawn); with `process.platform` faked to win32 it asserts that `gdi32/user32/ole32/advapi32/usp10` and `z` are in while `SDL2/winmm/imm32/oleaut32/version/uuid/setupapi/shell32/dinput8/d3d12*` and `curl` are **not**; `defines` has `ASC_USE_SKIA=1` but no `ASC_USE_WINDOW=1`; `sources` is only `skia_glue.cc`; the macOS branch still goes through CoreText. Mutation 2/2 (move the four libraries back into the `visible` branch ⇒ 2 red) | as above |
| `test/unit/build.ts` → `build/AneHostLayout` (21) / `build/WindowsArch` (24) | the key set `--help` offers ≡ the key set that really has a `lib/bin/` directory; every key maps to a unique directory; an unknown key throws; the key `MacOS-AOT`, which AIR never emits, no longer points at any directory | as above |
| mutation testing (`temp/`, scaffolding, not a deliverable) | inject breakage into each of the above groups **check by check** (delete the self-report, add `extensionID` back, drop comment stripping, make the regex greedy…), confirming **each one goes red**; the control group stays green; then **restore byte-for-byte** and verify the hash | —— |
| a real third-party ANE, end to end (`temp/` scaffolding) | a real project (7 `.cpp` + VS2015 v140 toolset) starting from the original signed `.ane`: recompile (both widths, x64 **and** x86) → **emit a staging directory tree, no packaging** (§4.6) → it runs. **Both widths' result tables are 22 lines each and line-for-line identical**; against `adl` **21/22 match**, the only difference being the deliberately deferred Face D `renderMode` (AOT `-1` / `adl` `1`), and both widths self-report `FREGetRenderMode` on stderr. The slice actually loaded is **sha256-identical** to the corresponding file in the directory, and each host library is its own width (116224 B / 83456 B). The same round also measured both of `check-ane.cjs`'s criteria (width + the import table must have `asaot.dll` and not `Adobe AIR.dll`), and confirmed that the extension's own AS3 wrapper sources took part in compilation in full (6 files, end to end `exit 0`) | —— |
| a real third-party ANE, **the nested-layout round** (`temp/ane-wincore/nest-*.cjs`) | the same two widths rerun, **verifying the product after the load path moved to `<extID>/<platform>/`**: both rounds `exit 0`, result tables **22 lines each and line-for-line identical**, **21/22** against `adl` (again only `renderMode`, self-reported in both widths); the files on disk are **sha256-identical** to the source slices (x64 `877dffc8…` / x86 `09e1f8e9…`); it also asserts that the **old flat `extensions/WinCore.dll` does not exist**. This one was necessary: Windows accepts `/` as a separator, but that is "should work", not "was tried" | —— |
| a real project's descriptor, **the multi-extension round** (`temp/air-extdir/real-stage/`) | a real app's `application.xml` (`<architecture>32</architecture>`) goes through the whole chain: the descriptor declares **5** IDs → **5/5** found in the default `lib/` (with **9** undeclared `.ane` files sitting in the same directory, none of which got in) → the 5 descriptors' `initializer`s each name themselves → on disk `extensions/<extID>/Windows-x86/<lib>`: **5 directories, 5 libraries, no flat leftovers**. This round is also the measured basis for "why the directory must not be scanned" | —— |
| a real project, installation round (`temp/aot-place/verify-installed.cjs`) | the rebuilt product is copied per §3.7 into a real app's `ext-aot/<name>/` (three items: `extension.xml` + two platform directories), then (a) `prepareAirApp` runs with the **real descriptor + the real `lib/`** (i.e. the `--air-app` code path, **no `--ane`, no `--extdir`**): **7** declared IDs → `ane-paths` is exactly `["ext-aot/WinCore", "lib/RTCExt.ane", …]`, i.e. **the rebuilt one comes from `ext-aot` and the other 6 from `lib/`**, with the undeclared Android-specific package not scanned in; (b) building and running the driver **from that installed location** (rather than in place under `aot-ane/`): `exit 0`, and of the 48 output lines every one is **identical line-for-line** to the in-place read except the driver's own memory reading, with the on-disk library **sha256-identical** to the installed one and importing `asaot.dll` but not `Adobe AIR.dll`. That memory line had its noise floor measured separately: the same binary run 5 times jumps between `13.9961M`–`14.0195M`, and the two binaries' values overlap completely. **That round used the staging directory's short name `WinCore`; the next round moved everything to extension-id naming** | —— |
| a real project, **six extensions fully rebuilt + per-extension run-time loading** (`temp/ext-aot/`) | one real app's extension list has **7** extensions, 6 of which were rebuilt for AOT per §4 (the 7th being the both-widths one finished in the previous round): every library **imports `asaot.dll`, contains no `Adobe AIR.dll`**, and its export names match its descriptor, with **the width identical item by item to the slice the original package actually ships** (for one of them the descriptor declares `Windows-x86-64` while the original package only ships x86 — the original package wins, no extra width is invented). After installing per §3.7 under `ext-aot/<extension id>/<platform>/`, `--air-app` is driven with the **real descriptor**: 7 declared IDs → `ane-paths` is exactly **7 `ext-aot/<id>` entries in descriptor order**; then a probe that **builds one context per id** (§4.10's last paragraph) is compiled and run: `exit 0`, 7 `E2E OK` lines, last line `E2E DONE 7/7`, and one extension's Initializer even prints its own version banner — proof that native code really **executed**, not just that "the files are there and nothing errored". The CEF one was built from `git HEAD`'s **committed sources + the committed 3.2987.1601 dependencies**, with **zero patches** (the process and the three pitfalls are in §4.10) | —— |


**The CI policy needs stating**: `.github/workflows/test.yml` runs on a **macOS arm64** runner, which has
no Windows host library, so `examples/ane/` and `examples/ane-app/` **skip loudly** there (not pass, not
fail); what really runs on CI is the structural pins in `test/unit/`. In other words, "the examples
pass" has so far only been measured on Windows.

---

## 7. File index

| File | Responsibility |
|---|---|
| `lib/asaot.h` | the FRE ABI contract header (byte-for-byte swappable with the SDK's `FlashRuntimeExtensions.h`) |
| `lib/asaot_host.c` | the source of `asaot.dll`: a **thin forwarder** for the 51 entry points, all forwarding into the table `asaot_bind` installs |
| `lib/build-asaot.bat` | builds the host library (both widths by default); carries its own "the import library records `asaot.dll`" assertion |
| `lib/bin/windows-{x86,x64}/` | the host library products (`asaot.dll` + `asaot.lib`) |
| `src/ane.ts` | compile-time `.ane` parsing: `extension.xml` (comments stripped first), platform keys, directory names, descriptor resolution, native-library staging (**one directory per extension** `<extID>/<platform>/`, honouring `ANE_COUNT_MAX`). **Accepts both ZIPs and unpacked directories** (§4.6) |
| `src/fre.ts` | the FRE host: `FRE_HEAD` / the descriptor block / `FRE_BODY` (51 entry points + the loader + dispatch) / `FRE_STUBS` (the empty implementation for builds without FRE). `ANE_COUNT_MAX` (the single source of truth for the descriptor table cap) lives here too |
| `src/emit.ts` | emission of the descriptor table and the hook bodies, `ExtensionContext`'s AS3 half, `as_fre_pump` |
| `src/symbols.ts` | the AIR member tables of `ExtensionContext` / `StatusEvent` |
| `src/air-app.ts` | AIR descriptor adaptation: read `<extensions>` (comments stripped first) → resolve the declared IDs into package paths from `lib`/`ext-folder` (or `--extdir`) → write them into the manifest's `ane-paths` |
| `src/index.ts` | `--ane` / `--ane-platform` / `--extdir`, plus the three injections (`-D`/include/link) and the post-link staging |
| `src/build.ts` | the manifest fields `ane-paths` / `ane-platform` (`ane-paths` is deduplicated by absolute path before being appended) |
| `examples/ane/` | the end-to-end minimal loop (§4.9) |
| `examples/ane-app/` | the **descriptor route** over the same fixture (§4.9.1) |
| `docs/en/compile.md` | the complete list of CLI arguments and manifest fields |
| `README.md` | the "ANE loading" section (an overview) |
