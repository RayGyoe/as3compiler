# C Identifier Naming-Conflict Handling (Borrowed from Porffor)

> This document records the current state of AS3-identifier → C-identifier naming-conflict handling, the
> problems with it, and the plan to borrow the complete C reserved-word table from
> [Porffor](https://github.com/CanadaHonk/porffor) (another "dynamic-language source → readable C → native"
> AOT compiler whose architecture is almost isomorphic to as3compiler).
>
> Current code: `C_KEYWORDS` + `cIdent()` in `src/emit.ts`; `sanitizePkg()` / `qualifiedName()` in
> `src/symbols.ts`.
> **Implemented (stage seventy-six, v0.3.87)**: the complete reserved-word table was moved to `C_RESERVED` +
> `sanitizeCIdent()` in `src/symbols.ts` (prefix incrementally — `exit → _exit → __exit`), and `emit.ts` wires
> it in through `this.cIdent()` (with `usedCIdentifiers` deduplication), covering class names / methods / fields
> / local variables / parameters.
> §1 below records the pre-refactor state; §3/§4 are the plan and the reserved-word table.

---

## 1. Current State (Before the Stage Seventy-Six Refactor)

as3compiler currently defends only against **C language keywords**, and only covers **method names / field
names**:

```ts
// src/emit.ts:16-26
const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Bool', '_Complex', '_Imaginary',
]);

function cIdent(name: string): string {
  return C_KEYWORDS.has(name) ? name + '_' : name;
}
```

Coverage (call sites of `cIdent`, all in `src/emit.ts`):

| Call site | Scenario |
|---|---|
| `479` | Function name of the method thunk |
| `1007` | Bound method (`this.method` as a function value) dispatched via vtable |
| `5785` / `5807` / `5825` | Vtable method call (interface vt / vtable / this->vtable) |
| `5987` | Field access (`o.field`) |

Class names go through a different path (`src/symbols.ts`): `sanitizePkg()` turns package-name `.` into `_`,
`qualifiedName()` assembles the fully-qualified C identifier of the form `foo_bar_Baz`, **without any
reserved-word check**. Local variables / parameters / module variables are emitted directly under their raw
AS3 names (`declareVar` writes them verbatim), **also without a reserved-word check**.

Typical result: `Rectangle.union` → `union_` on the C side (already noted in README.md; the AS3-side
spelling is unchanged).

## 2. Problem: The Collision Surface Expands Dramatically After Linking Third-Party Libraries

The current `C_KEYWORDS` only defends against "C language keywords", **not** the symbols of libc / libm /
POSIX / SDL2 / Skia. Yet as3compiler, per the AGENTS.md §2.9 iron rule, **links** Skia (rasterization),
SDL2 (windowing), and libc/libm in as mature libraries, so the headers and symbols of those libraries all
enter the same link namespace. In AS3, `index`, `time`, `data`, `log`, `write`, and `close` are all extremely
common variable / method / field names; the moment they collide with a linked library's global symbol, at best
the compilation fails on a type mismatch, at worst they silently bind to the wrong symbol.

Real cases already encountered (stage sixty-eight):

- In an Xcode project, the generated C's bare type names `Point` / `Rectangle` collided with `Point` from the
  macOS SDK's `MacTypes.h`; `-fmodules` let the SDK's `Point` shadow the generated struct
  (`no member named 'x' in 'struct Point'`). The workaround at the time was the project-level
  `CLANG_ENABLE_MODULES = NO`, which **did not fix it at the naming layer**.

`index` is especially insidious: it is a legacy alias of `strchr` (`string.h` / `strings.h`), and in AS3
`index` is extremely common as a variable/method name (loop subscript, data index); once emitted as a bare
`index` it collides with libc.

## 3. Porffor's Approach

Porffor solves the same problem with a `cReservedNames` set **far beyond the C keywords** plus a "prefix
incrementally" `sanitize()` function:

```js
// compiler/render.js (Porffor)
const sanitize = str => {
  // 1) illegal chars → _hex (keep A-Za-z0-9_, others → `_xx`)
  // 2) empty name → 'anon'; digit-leading → prefix '_'
  // 3) hits a reserved word OR collides with an already-used name → loop-prefix '_' (exit → _exit → __exit ...)
  while (cReservedNames.has(out) || sanitizeUsed.has(out)) out = '_' + out;
  sanitizeUsed.add(out);
  return out;
};
```

Two key design points:

1. **The reserved set is not just C keywords**, but also covers the symbols of libc / libm / POSIX / unistd /
   stdio / string.h / dirent / sys/mman / sys/stat / sys/wait / time.h / setjmp (see the complete list in §4).
2. **Incremental prefixing**: appending a single `_` can itself collide again (`exit` → `_exit`, where `_exit`
   is also a POSIX symbol), so it loops prefixing until there is no conflict; and `sanitizeUsed` guarantees the
   produced results are **pairwise distinct** within this compilation.

## 4. Complete Reserved-Word Table (Categorized, Taken from Porffor's `cReservedNames`)

Annotated by priority relative to as3compiler's current link surface (Skia / SDL2 / libc / libm / POSIX).
★ = extremely common AS3 identifier, highest collision risk, recommended for the first batch.

### 4.1 C Language Keywords + Extensions (★ Already Covered)

```
auto break case char const continue default do double else enum extern float
for goto if inline int long register restrict return short signed sizeof
static struct switch typedef union unsigned void volatile while
asm typeof main
_Bool _Complex _Imaginary
```

### 4.2 Type Names / Builtin Constants / Predefined Macros

```
i8 u8 i16 u16 i32 u32 i64 u64 f32 f64        // Porffor's builtin type names (as3compiler uses int/uint/double, no need to copy this group)
NULL NAN INFINITY                            // libc macros
bool true false                              // C23 / stdbool.h
unix linux                                   // predefined macros
```

### 4.3 stdio (★ `data`-related concentrated in FILE/EOF)

```
stdin stdout stderr FILE EOF
printf fprintf putchar puts fputs fgetc fputc getc putc getchar
scanf sscanf fscanf snprintf sprintf vsnprintf vsprintf vprintf vfprintf
fopen freopen fclose fread fwrite fseek fseeko ftell ftello rewind
perror tmpfile tmpnam setbuf setvbuf fflush ungetc feof ferror clearerr
fileno fdopen popen pclose
```

### 4.4 stdlib (★ `index`/`time`/`exit`/`free`, etc.)

```
exit abort atexit getenv                                    // ★ exit
calloc malloc realloc free                                  // ★ free
memcpy memmove memset strlen memchr memcmp memccpy swab
random srandom rand srand system abs labs div ldiv qsort bsearch
atoi atol atof gets remove rename
strtol strtoul strtoll strtoull strtod strtof strtold
mblen mbtowc wctomb mbstowcs wcstombs realpath mkstemp mkdtemp mktemp
setenv unsetenv putenv posix_memalign aligned_alloc arc4random valloc alloca
```

### 4.5 math / libm (★ `log`/`sin`/`cos`, etc.)

```
log2 log10 log1p pow sqrt cbrt exp exp2 expm1                  // ★ log / pow / sqrt
sin cos tan asin acos atan atan2 sinh cosh tanh               // ★ sin / cos / tan
fabs floor ceil round trunc fmod hypot remainder
acosh asinh atanh erf erfc tgamma lgamma fmax fmin fma fdim
copysign nearbyint rint lrint llrint lround llround frexp ldexp modf
scalbn scalbln ilogb logb nan nanf nextafter nexttoward remquo
j0 j1 jn y0 y1 yn gamma drem finite significand
```

### 4.6 unistd / POSIX (★ `read`/`write`/`close`/`open`, etc.)

```
fork sleep usleep sync _exit pipe dup dup2 pause alarm getpid getppid
open link unlink access kill raise                           // ★ open / close / read / write
log read write close signal time                             // ★ read / write / close / time
lseek chdir fchdir getcwd isatty ttyname execv execve execvp execl execlp execle
getuid geteuid getgid getegid setuid setgid seteuid setegid getpgrp setpgid setsid getsid
truncate ftruncate rmdir chown fchown lchown readlink symlink nice crypt encrypt brk sbrk
gethostname sethostname getlogin fsync fdatasync pread pwrite environ getopt optarg optind opterr optopt
confstr pathconf fpathconf sysconf chroot vfork daemon setgroups getgroups
```

### 4.7 string.h / strings.h (★ `index`/`rindex` and other legacy aliases)

```
index rindex bcopy bzero bcmp ffs ffsl ffsll fls flsl flsll      // ★ index
strcasecmp strncasecmp strcpy strncpy strcat strncat strcmp strncmp
strchr strrchr strstr strtok strdup strndup strerror strspn strcspn
strpbrk strcoll strxfrm strsep stpcpy stpncpy strnlen strlcpy strlcat
```

### 4.8 dirent / sys/mman / sys/stat / sys/wait / signal / setjmp

```
opendir readdir closedir rewinddir seekdir telldir scandir alphasort dirfd fdopendir
mmap munmap mprotect madvise msync mlock munlock mlockall munlockall mincore shm_open shm_unlink
stat fstat lstat fstatat chmod fchmod fchmodat mkdir mkdirat mkfifo mknod umask futimens utimensat
wait waitpid wait3 wait4
sigaction sigaddset sigdelset sigemptyset sigfillset sigismember sigprocmask sigsuspend sigpending sigwait killpg psignal
setjmp longjmp _setjmp _longjmp sigsetjmp siglongjmp errno
```

### 4.9 time.h

```
clock times gmtime localtime mktime ctime asctime strftime strptime difftime timegm timelocal
tzset daylight timezone tzname nanosleep clock_gettime clock_settime clock_getres
ctime_r asctime_r gmtime_r localtime_r gettimeofday
```

## 5. Borrowed Rollout Tiers

> These tiers correspond to stage seventy-six in `../TODO.md` (v0.3.87; P0–P2 all landed); DoD per AGENTS.md
> §2.7 / §4.

| Tier | Content | Rationale |
|---|---|---|
| **P0** | Extend `C_KEYWORDS` into the complete reserved-word table (at least the ★-marked libc/libm/POSIX high-frequency symbols in §4 — especially `index`/`time`/`exit`/`free`/`read`/`write`/`close`/`open`/`log`/`sin`/`cos`), and change `cIdent` to "prefix incrementally" instead of a single `_` append | Directly eliminates the symbol-collision hazard after linking Skia/SDL2/libc; the change is local (`emit.ts`) |
| **P1** | Extend sanitize from "method/field names only" to **class names, local variables, parameters, module variables**: `qualifiedName`/`sanitizePkg` in `symbols.ts` and `declareVar` in `emit.ts` all route through the same `sanitize` | Currently class names (e.g. `Point`, the stage sixty-eight Xcode collision) and local variables (e.g. `var index`) are unprotected — a real gap |
| **P2** | Introduce a `sanitizeUsed` used-names set to guarantee that C identifiers in the compiled output are **pairwise distinct**; also handle `_Bool`/`_Complex`/`_Imaginary` and the C23 `bool`/`true`/`false` | Prevents "self-collision after appending `_`" (`exit → _exit` is still a POSIX symbol) and duplicate names |

### Rollout Notes

- **Keep AS3-side spelling unchanged**: sanitize only acts on the C identifier emission layer; source code, the
  symbol table, and the reflection table (the string stored in `as_prop.name`) still use the raw AS3 names —
  consistent with the existing "AS3-side spelling unchanged" convention of `union → union_`. Do **not** write
  the sanitized names into the props reflection table, otherwise `o.union` / `for-in` key iteration / `toString`
  output field names would drift.
- **`index` is the highest-priority pitfall**: it is both a C `string.h` legacy alias and a high-frequency AS3
  variable name, and if historical code already has an `index` field, introducing the complete table will
  **change the generated C** — requiring a full regression over `examples/` + `benchmarks/` to confirm no
  breakage.
- **No need to copy all of Porffor verbatim**: the `i8`/`u8`/`i32`/`jsval` in §4.2 are Porffor's own type names;
  as3compiler uses `int`/`uint`/`double`/`as_value`, so they can be skipped. The `mmap`/`mprotect`/`sigaction`
  in §4.8 are only relevant when the corresponding backend is wired in later, but adding them to the reserved
  table once costs almost nothing and yields "never step on them", so it is recommended to include the whole
  thing rather than add on demand.

## 6. Relationship to Other Modules

- **`src/symbols.ts`**: `sanitizePkg` (`.`→`_`) and `qualifiedName` are the C-identifier entry points for
  classes/interfaces; P1 wires sanitize here.
- **`src/emit.ts`**: `cIdent` is the sanitize entry point for method/field names (P0 extends the table here);
  `declareVar` is the local/parameter entry point (P1 wires sanitize here).
- **`compile.md`**: multi-target linking (Skia/SDL2/WASI) documentation; naming conflicts are a
  direct consequence of the link surface, and this document supplements the front-end defense for it.
- **`gc.md`**: the GC uses `gc_in_heap()` segment-table address-range checks to skip non-heap
  pointers; naming sanitize does not affect that mechanism (sanitize only changes identifier text, not pointer
  layout).

## 7. The Opposite Direction: Names the Emitter Plants Itself (stage 165, v0.4.136)

§1–§5 solve one direction of collision (AS3 name → C name hitting a C keyword/libc/type name). There is a
mirror-image class: identifiers the emitter writes **verbatim inside a function body**, which AS3 source is
equally free to use.

| Generated name | Where it appears | clang when it collides |
|---|---|---|
| `o` | the receiver parameter of a **constructor** (`Widget_ctor(Widget* o, ...)`, and `Widget_new`'s local) | `error: redefinition of 'o' with a different type: 'Object *' vs 'Widget *'` |
| `_this` | the receiver parameter of **every instance method** (`Widget_add(void* _this, ...)`) | `error: redefinition of parameter '_this'` |
| `_<word><N>` | `tmpName()` temporaries (`_once0`/`_i3`/`_ret1`, ...) and the closure-cell env tag `_cell0` | duplicate-definition error (and **silent** clobbering when the types match) |

Minimal repro (`temp/d31probe/ocollide2.as`, a 7-line AIR app class that `adl` runs fine):

```as
class Widget {
  public var v:int;
  public function Widget() { var o:Object = { a: 1 }; v = o.a; }
}
```

**Fix** (`cIdent` in `src/emit.ts`): the spellings above join the "never hand this to an AS3 identifier" set
(the same loop that already avoids `reservedTypeNames`); `cIdent` prefixes `_` until three tests are all clear:
**type name / generated name / already-used name**. The last one is only checked for the *post-prefix*
candidate (`sanitizeCIdent` has already registered the first one), otherwise the loop would never terminate.
So `var o:Object` becomes `Object* _o`, a parameter `_this` becomes `__this`, `_once0` becomes `__once0` — while
the receivers stay literally `o`/`_this` (they are emitted raw and never go through `cIdent`).

**Red line: only the C spelling changes; the AS3 side must not move at all.** The reflection table
(`as_prop.name`, the AMF member list, `for-in` keys) stores the **original string**, so `w["o"]`,
serialization and `describeType` must still see `o` — that is the invariant pinned by
`examples/ident-collide.as` + `unit: emit/GeneratedNameReservation` (reverting the reservation turns 5 of its 8
checks red and the example's C stops compiling).

**Known residual (reported, not fixed)**: the closure-cell **pointer** local `cell<N>` (`cell0`/`cell1`, ... from
the global `anonSeq` counter) is still emitted raw, so `var cell1` together with a closure **in the same
function** collides — `error: duplicate member 'cell1'` (a **loud** failure, never silent corruption). Repro:
`temp/d31probe/cellres{0,1,2}.as` (`cell0`/`cell2` green, `cell1` red). The cause is an **inconsistent emission
convention** for that one name: six of its seven emission sites spell it raw and one (`emitActivationCell`'s
declaration) goes through `cIdent`, so any spelling-level reservation would split declaration from use. Closing
it requires routing every closure-cell emission through one mapping (touches `cellLocal`/`captures`/
`closureCellEnv`) — a separate project.

## 4.10 Top-Level **Free Function** Name Deconfliction (stage 240, v0.4.205)

The table in §4 has covered **class / method / field / local / parameter / module variable** names since
stage seventy-six, and `main` has had its own rename (`asc_user_main`, see `examples/user-main.as`) for just as
long. **Top-level free functions** were the one class left out: their C symbol was the raw AS3 name, so four
kinds of collision really happened (each measured on the generated C, while `adl`/`mxmlc` run the very same
source fine => a **legacy defect** by the §1.5 criterion):

| AS3 top-level function | Collides with | clang says |
|---|---|---|
| `function log(x:Number)` | `<math.h>`'s `log(double)` | `static declaration of 'log' follows non-static declaration` |
| `function index(s:String)` | `<string.h>`/`strings.h` legacy alias | same |
| `function Sprite():int` | a C **type name** (the class typedef `Sprite`) | `redefinition of 'Sprite' as different kind of symbol`, then `unexpected type name 'Sprite': expected expression` at the call |
| `function max(a,b)` (Windows) | `<windef.h>`'s `#define max(a,b)` | `expected identifier or '('` |

The fix routes `emit.ts`'s `freeCName()` — which used to special-case only `main` — through the same tests as
`cIdent` (`C_RESERVED` + **type names** + **used set**, prepending `_` step by step), and splits the
**function-like host macros** into their own `C_FN_MACRO_RESERVED` set. All five emission sites (prototype,
definition, direct call, Function value, `__call` thunk) go through it, so only the C symbol is renamed and
**not a single character of the AS3 side moves** (`var f:Function = log` still calls the same function, and the
`[WasmExport]` JS-facing name is unaffected).

### Why function-like and object-like macros cannot share one fix

- An **object-like macro** (`near`/`far`/`small`/`_timezone`/`_daylight`/`_tzname`, ...) rewrites **every
  occurrence** of the identifier — struct members included (the generated C puts every AS3 field name verbatim
  inside the struct). Renaming a *function* cannot fix the field half, so that class is handled by the `#undef`
  block inside `RUNTIME_PREAMBLE`'s `#if defined(_WIN32)`. This stage widened that block from the six measured
  names to the rest of the same documented family (`huge`/`_huge`/`pascal`/`_pascal`/`_near`/`_far`/`_small`/
  `NEAR`/`FAR`/`PASCAL`/`IN`/`OUT`/`OPTIONAL`). **That widening is safe by construction**: `#undef` of an
  undefined name is a no-op, and every added name was grep-verified unused by the preamble and the emitted C.
  `CALLBACK` is deliberately absent — the Win32 path really calls `InitOnceExecuteOnce` through a
  `BOOL CALLBACK` function.
- A **function-like macro** rewrites only a **bare call** `name(...)`. The only bare calls in the generated C
  are file-scope free functions (instance methods are `Class_method(...)`, a Function value goes through
  `as_fn`), so the right place for this class is "rename free functions only" — renaming locals/fields would buy
  nothing and would needlessly churn a lot of generated text.

`C_FN_MACRO_RESERVED`'s list is **measured**, not copied: `clang -dM -E` over the link-surface headers
(`<math.h>`/`<string.h>`/`<stdlib.h>`/`<stdio.h>`/`<time.h>`/`<zlib.h>`/`<sys/types.h>`) yields the names that
really are function-like macros (`isnan`/`isinf`/`isfinite`/`isnormal`/`signbit`/`fpclassify`/`isgreater*`/
`isless*`/`isunordered`/`offsetof`/`major`/`minor`); Windows `<windef.h>`'s `min`/`max` are added on top.

### Acceptance

- `examples/ident-free-fn.as`: 13 assertions covering the four classes above plus `min`/`max`/`isnan`, the
  `log`/`_log` deconfliction pair, every function still callable as a Function value, and the user `main()`
  still callable.
- `unit: emit/FreeFunctionNameReservation` (11 pins): each C spelling (`_log`/`_index`/`_Sprite`/`_max`/
  `_isnan`/`__log`) plus proof that **all five emission sites** are renamed (including
  `as_fn_make(_log__call, …)`).
- The Windows `#define max(a,b)` mechanism is **verified by contrast** in `temp/freeres/macro_probe.c`: the old
  spelling under that macro fails with `error: expected identifier or '('`, the new one compiles and returns
  the right answer. **Stated honestly**: that is mechanism-level verification, not Windows runtime verification
  (the dev machine is macOS); the object-like half relies on the `#undef` block (`unit:
  emit/FreeFunctionNameReservation` pins that block's text and that it must NOT undef `CALLBACK`, and
  `examples/ident-free-fn.as` carries the runtime half on Windows), and was likewise only checked at source
  level.

### A larger family in the same mould, deliberately **out of scope** here (now registered)

This stage covers top-level free functions only. The same "names the emitter plants itself" idea has a wider
family at **class-member** granularity: a member's C name is `<Owner>_<member>` and the emitter plants a fixed
set of `<Owner>_<suffix>` symbols per class, so **any** member whose name equals one of those suffixes collides.
Measured locally (rc=1, clang reports a redefinition): `cls` (`<Owner>_cls`, the class-registry variable), `vt`,
`ctor`, `props` and `amf_members` all fail to compile; the `o`/`_this` batch (stage 165) sits at **function
local** granularity and is already covered by `cIdent`. Closing it means routing the 22 sites that build
`${owner}_${member}` through one "look up this owner's planted suffixes" mapping — the same kind of work as the
closure-cell residual at the end of §7 — so it is a **separate project**, registered as its own TODO row
(stage 240).
