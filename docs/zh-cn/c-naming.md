# C 标识符命名冲突处理（借鉴 Porffor）

> 本文记录 AS3 标识符 → C 标识符的命名冲突处理现状、问题，以及借鉴
> [Porffor](https://github.com/CanadaHonk/porffor)（另一个「动态语言源码 → 可读 C → 原生」AOT 编译器，
> 架构与 as3compiler 几乎同构）完整 C 保留字表的方案。
>
> 现状代码：`src/emit.ts` 的 `C_KEYWORDS` + `cIdent()`；`src/symbols.ts` 的 `sanitizePkg()` / `qualifiedName()`。
> **已实现（阶段七十六，v0.3.87）**：完整保留字表迁至 `src/symbols.ts` 的 `C_RESERVED` + `sanitizeCIdent()`（逐级加前缀
> `exit → _exit → __exit`），`emit.ts` 经 `this.cIdent()`（带 `usedCIdentifiers` 去重）统一接入，覆盖类名/方法/字段/局部变量/形参。
> 下述 §1 记录改造前状态，§3/§4 为方案与保留字表。

---

## 1. 现状（阶段七十六改造前）

as3compiler 目前只防御 **C 语言关键字**，且只覆盖**方法名 / 字段名**：

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

覆盖范围（`cIdent` 的调用点，均在 `src/emit.ts`）：

| 调用点 | 场景 |
|---|---|
| `479` | 方法 thunk 的函数名 |
| `1007` | 绑定方法（`this.method` 作函数值）经 vtable 派发 |
| `5785` / `5807` / `5825` | 虚表方法调用（接口 vt / vtable / this->vtable） |
| `5987` | 字段访问（`o.field`） |

类名走另一条路径（`src/symbols.ts`）：`sanitizePkg()` 把包名 `.` → `_`，
`qualifiedName()` 拼出 `foo_bar_Baz` 形式的全限定 C 标识符，**不做保留字检查**。
局部变量 / 形参 / 模块变量直接按原 AS3 名 emit（`declareVar` 原样写入），**同样不做保留字检查**。

典型结果：`Rectangle.union` → C 侧 `union_`（README-CN.md 已注明，AS3 侧拼写不变）。

## 2. 问题：链接第三方库后冲突面大幅扩大

当前 `C_KEYWORDS` 只防「C 语言关键字」，**不防 libc / libm / POSIX / SDL2 / Skia 的符号**。
而 as3compiler 依据 AGENTS.md §2.9 铁律，把 Skia（光栅化）、SDL2（窗口）、libc/libm 作为成熟库**链接**进来，
生成 C 里这些库的头文件与符号全部进入同一链接命名空间。AS3 里 `index`、`time`、`data`、`log`、`write`、`close`
都是极常见的变量 / 方法 / 字段名，一旦撞上链接库的全局符号，轻则类型不匹配编译报错，重则静默绑定到错误符号。

已实际遇到过的真实案例（阶段六十八）：

- Xcode 工程里，生成 C 的裸类型名 `Point` / `Rectangle` 与 macOS SDK `MacTypes.h` 的 `Point` 冲突，
  `-fmodules` 让 SDK `Point` 遮蔽生成 struct（`no member named 'x' in 'struct Point'`）。
  当时的处理是工程级 `CLANG_ENABLE_MODULES = NO` 规避，**没有从命名层根治**。

`index` 尤其隐蔽：它是 `strchr` 的 legacy 别名（`string.h` / `strings.h`），AS3 里
`index` 作为变量/方法名极其常见（循环下标、数据索引），一旦 emit 成裸 `index` 就会与 libc 冲突。

## 3. Porffor 的做法

Porffor 用一张**远超 C 关键字**的 `cReservedNames` 集合 + 一个「逐级加前缀」的 `sanitize()` 函数解决同一问题：

```js
// compiler/render.js（Porffor）
const sanitize = str => {
  // 1) 非法字符 → _hex（保留 A-Za-z0-9_，其余转 `_xx`）
  // 2) 空名 → 'anon'；数字开头 → 前加 '_'
  // 3) 命中保留字 或 与已用名冲突 → 循环前加 '_'（exit → _exit → __exit ...）
  while (cReservedNames.has(out) || sanitizeUsed.has(out)) out = '_' + out;
  sanitizeUsed.add(out);
  return out;
};
```

两个关键设计：

1. **保留字集合不止 C 关键字**，还覆盖 libc / libm / POSIX / unistd / stdio / string.h / dirent /
   sys/mman / sys/stat / sys/wait / time.h / setjmp 的符号（见 §4 完整清单）。
2. **逐级加前缀**：追加单个 `_` 本身可能再次冲突（`exit` → `_exit`，而 `_exit` 也是 POSIX 符号），
   所以循环加前缀直到不冲突；并用 `sanitizeUsed` 保证生成结果在本次编译内**两两不重名**。

## 4. 完整保留字表（分类，取自 Porffor `cReservedNames`）

按「与 as3compiler 当前链接面（Skia / SDL2 / libc / libm / POSIX）的冲突风险」标注优先级。
★ = 极常见 AS3 标识符，冲突风险最高，建议首批纳入。

### 4.1 C 语言关键字 + 扩展（★ 已覆盖）

```
auto break case char const continue default do double else enum extern float
for goto if inline int long register restrict return short signed sizeof
static struct switch typedef union unsigned void volatile while
asm typeof main
_Bool _Complex _Imaginary
```

### 4.2 类型名 / 内建常量 / 预定义宏

```
i8 u8 i16 u16 i32 u32 i64 u64 f32 f64        // Porffor 内建类型名（as3compiler 用 int/uint/double，此组不必照搬）
NULL NAN INFINITY                            // libc 宏
bool true false                              // C23 / stdbool.h
unix linux                                   // 预定义宏
```

### 4.3 stdio（★ `data` 相关集中在 FILE/EOF）

```
stdin stdout stderr FILE EOF
printf fprintf putchar puts fputs fgetc fputc getc putc getchar
scanf sscanf fscanf snprintf sprintf vsnprintf vsprintf vprintf vfprintf
fopen freopen fclose fread fwrite fseek fseeko ftell ftello rewind
perror tmpfile tmpnam setbuf setvbuf fflush ungetc feof ferror clearerr
fileno fdopen popen pclose
```

### 4.4 stdlib（★ `index`/`time`/`exit`/`free` 等）

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

### 4.5 math / libm（★ `log`/`sin`/`cos` 等）

```
log2 log10 log1p pow sqrt cbrt exp exp2 expm1                  // ★ log / pow / sqrt
sin cos tan asin acos atan atan2 sinh cosh tanh               // ★ sin / cos / tan
fabs floor ceil round trunc fmod hypot remainder
acosh asinh atanh erf erfc tgamma lgamma fmax fmin fma fdim
copysign nearbyint rint lrint llrint lround llround frexp ldexp modf
scalbn scalbln ilogb logb nan nanf nextafter nexttoward remquo
j0 j1 jn y0 y1 yn gamma drem finite significand
```

### 4.6 unistd / POSIX（★ `read`/`write`/`close`/`open` 等）

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

### 4.7 string.h / strings.h（★ `index`/`rindex` 等 legacy 别名）

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

## 5. 借鉴落地分档

> 本分档对应 `../TODO.md` 阶段七十六（v0.3.87，P0–P2 已全部落地），DoD 见 AGENTS.md §2.7 / §4。

| 档 | 内容 | 理由 |
|---|---|---|
| **P0** | 把 `C_KEYWORDS` 扩展为完整保留字表（至少覆盖 §4 里 ★ 标出的 libc/libm/POSIX 高频符号，重点是 `index`/`time`/`exit`/`free`/`read`/`write`/`close`/`open`/`log`/`sin`/`cos` 等），`cIdent` 改为「逐级加前缀」而非单次追加 `_` | 直接消除链接 Skia/SDL2/libc 后的符号冲突隐患，改动局部（`emit.ts`） |
| **P1** | 把 sanitize 从「仅方法/字段名」扩展到**类名、局部变量、形参、模块变量**：`symbols.ts` 的 `qualifiedName`/`sanitizePkg` 与 `emit.ts` 的 `declareVar` 统一走同一套 `sanitize` | 现状类名（如 `Point`，阶段六十八 Xcode 冲突）与局部变量（如 `var index`）未受保护，是真实缺口 |
| **P2** | 引入 `sanitizeUsed` 已用名集合，保证编译产物内 C 标识符**两两不重名**；对 `_Bool`/`_Complex`/`_Imaginary` 及 C23 `bool`/`true`/`false` 一并处理 | 防「追加 `_` 后自身再次冲突」（`exit → _exit` 仍是 POSIX 符号）与重名 |

### 落地注意

- **保留 AS3 侧拼写不变**：sanitize 只作用于 C 标识符发射层，源码、符号表、反射表（`as_prop.name` 存的字符串）
  仍用原始 AS3 名——这与现状 `union → union_` 的「AS3 侧拼写不变」约定一致，不能把 sanitize 后的名字写进 props 反射表，
  否则 `o.union` / `for-in` 遍历 key / `toString` 输出的字段名会漂移。
- **`index` 是最高优先级的坑**：它既是 C `string.h` legacy 别名、又是 AS3 高频变量名，且历史代码里如果已有 `index` 字段
  会在引入完整表后**改变生成的 C**——需回归 `examples/` 全量 + `benchmarks/` 确认无破坏。
- **不必照搬 Porffor 的全部**：§4.2 的 `i8`/`u8`/`i32`/`jsval` 是 Porffor 自己的类型名，as3compiler 用
  `int`/`uint`/`double`/`as_value`，可跳过；§4.8 的 `mmap`/`mprotect`/`sigaction` 等仅当未来接入相应后端时才相关，
  但一次性纳入保留字表成本极低、收益是「永远不会踩」，建议整体纳入而非按需追加。

## 6. 与其他模块的关系

- **`src/symbols.ts`**：`sanitizePkg`（`.`→`_`）与 `qualifiedName` 是类/接口的 C 标识符入口，P1 需在此接 sanitize。
- **`src/emit.ts`**：`cIdent` 是方法/字段名的 sanitize 入口，P0 在此扩展表；`declareVar` 是局部/形参入口，P1 在此接。
- **`docs/zh-cn/compile.md`**：多目标链接（Skia/SDL2/WASI）说明，命名冲突是链接面的直接后果，本文补充其前端防御。
- **`docs/zh-cn/gc.md`**：GC 靠 `gc_in_heap()` 段表地址范围检查跳过非堆指针；命名 sanitize 不影响该机制（sanitize 只改标识符文本，不改指针布局）。
