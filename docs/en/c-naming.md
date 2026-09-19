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
