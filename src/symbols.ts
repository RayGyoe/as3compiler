// Semantic symbols and types: registers classes/functions, maps AS3 source
// types to C types, flattens inheritance, and answers visibility queries.

import type { Program, ASType, Param, Expr, Visibility, Metadata } from './ast.ts';

// Semantic type representation used during code generation.
export type CType =
  | { kind: 'int' }
  | { kind: 'uint' }
  // 64-bit integers: an opt-in enhancement (AIR has no such types, so accepting
  // the names can never change how an AIR-valid program compiles). They are
  // Number subtypes for `is` purposes, like int/uint, but keep full 64-bit width
  // in their own arithmetic.
  | { kind: 'int64' }
  | { kind: 'uint64' }
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'null' }
  | { kind: 'object'; className: string }
  | { kind: 'interface'; name: string }
  | { kind: 'array' }
  | { kind: 'vector'; elem: CType }
  | { kind: 'record' }
  | { kind: 'any' }
  | { kind: 'function' }
  | { kind: 'class' }
  | { kind: 'dict' }
  | { kind: 'regexp' }
  | { kind: 'xml' }
  | { kind: 'xmllist' }
  | { kind: 'void' };

// `name` is the AS3 member name; `cName` is the C storage slot it occupies in
// the flattened struct. They differ only when a field shadows an inherited field
// of the same name: AS3 scopes a private member to its declaring class, so the
// two declarations are DISTINCT slots that must not be collapsed into one C
// member (see expandInheritance). `cName` is undefined until flattening runs for
// its class, since `name` alone cannot tell whether a collision will occur.
export interface FieldInfo { type: CType; init: Expr | null; visibility: Visibility; owner: string; isStatic: boolean; isConst: boolean; name?: string; cName?: string;
  // TRUE for a built-in property that AIR declares as an ACCESSOR PAIR (`get p` /
  // `set p`) even though our C representation stores it as a plain field (direct
  // member access is the faster, semantically-equivalent form). It matters only to
  // the interface-conformance check and the interface vtable: a class that
  // inherits e.g. `DisplayObject.y` DOES satisfy an interface's `get y`/`set y`,
  // while a USER `public var y` does not. Measured on adl 51.4.1 (temp/accprobe*):
  // `class T extends Sprite implements I{get/set x}` compiles, `extends Sprite`
  // with `name`/`visible`/`alpha`/`rotation`/`scaleX`/`scaleY`/`blendMode`/
  // `transform` all compile too, as do the `InteractiveObject` properties; but
  // `extends Point`/`extends Rectangle` (x is a var), `Event.bubbles`/
  // `cancelable`/`target` (vars, unlike `Event.type`) and a user `public var` are
  // all REJECTED by AIR.
  isAccessor?: boolean; }
export interface MethodInfo { returnType: CType; params: Param[]; owner: string; visibility: Visibility; isStatic: boolean; isFinal: boolean; isGetter: boolean; isSetter: boolean; metadata?: Metadata[]; isProxyNs?: boolean; ns?: string; }
export interface FuncInfo { returnType: CType; params: Param[]; metadata?: Metadata[]; }

// The ten interceptor methods of flash.utils.Proxy, which AIR declares in the
// `flash_proxy` namespace rather than the public one. They are still registered as
// methods (so `flash_proxy override function ...` passes override checking and
// fills a vtable slot) but they are NOT public traits: a public-namespace access on
// a proxy receiver is a MISS that goes through the proxy's own callProperty /
// getProperty instead (measured on adl 51.4.1: `p.getProperty("x")` on a subclass
// that overrides everything returns callProperty's value, while on a bare subclass
// it throws #2090 callProperty — NOT #2088 getProperty). The distinction is kept in
// the emitted code by storing these reflection-table entries under the mangled name
// `flash_proxy::<name>`, which as_proxy_invoke looks up but a public dynamic access
// (`p["getProperty"]`, `p.getProperty`) never matches.
export const PROXY_NS_METHODS = new Set<string>([
  'getProperty', 'setProperty', 'deleteProperty', 'hasProperty', 'callProperty',
  'getDescendants', 'nextNameIndex', 'nextName', 'nextValue', 'isAttribute',
]);

// A single ordered slot in a class vtable. Methods, getters, and setters share one
// flattened list so overrides replace an inherited slot in place and new members
// append — this keeps a subclass vtable layout-identical (prefix-stable) to its
// superclass vtable, which is what lets a base-typed reference (`Texture* t`)
// dispatch a virtual getter/setter to the runtime subclass implementation.
export interface VtableSlot { kind: 'method' | 'getter' | 'setter'; name: string; info: MethodInfo; }

// A function/method marked [WasmExport] that must be exposed in the .wasm export
// table. `symbol` is the generated C symbol name; `alias` is the optional
// [WasmExport("alias")] override for the JS-facing export name (a C wrapper with
// that name is emitted and exported). `returnType`/`params` carry the resolved C
// signature so the emitter can generate the alias wrapper and index.ts can write
// the export manifest.
export interface ExportedSymbol {
  symbol: string;
  alias: string | null;
  returnType: CType;
  params: { name: string; type: CType }[];
}
export interface ConstructorInfo { params: Param[]; }
export interface InterfaceInfo {
  // Plain methods only (public-namespace traits). Accessors live in their own maps
  // below: AS3 lets `get x` and `set x` coexist under the SAME name, and a single
  // name-keyed map let whichever came last in source silently overwrite the other
  // — `interface ISound3DDriver { function get sourceSound():Sound; function set
  // sourceSound(v:Sound):void; }` lost the getter, so every read of that property
  // through the interface threw "setter ... used as a value".
  methods: Map<string, MethodInfo>;
  getters: Map<string, MethodInfo>;
  setters: Map<string, MethodInfo>;
  importAlias?: Map<string, string>;
  // Parent interfaces of `interface I extends A, B`, resolved to FQNs. Recorded so
  // the method maps can be merged transitively and so a class implementing I is
  // also treated as an instance of every parent.
  extends?: string[];
  // AVM2-spelled interface name for user-visible messages (`foo.IFoo` ->
  // `foo::IFoo`, package-less -> `IFoo`), mirroring the `pkg::Class` shape AIR
  // prints for a method qname. The map KEY is the sanitized C identifier
  // (`foo_IFoo`), which must never leak into an error message; without this the
  // Function-value #1063 path printed `foo_IFoo/m()` instead of an AS3 name.
  reflectFqn?: string;
}
export interface ClassInfo {
  // Instance storage slots, keyed by C member name (see FieldInfo.cName). Exactly
  // one entry per DECLARATION, so a shadowing field appears under its own
  // mangled key next to the inherited slot it shadows. Use `fieldSlot()` to look
  // a slot up by AS3 name.
  fields: Map<string, FieldInfo>;
  // AS3 instance-field name → key into `fields`. Built by expandInheritance for
  // every class so a shadowed name resolves to the innermost declaration.
  fieldKeys?: Map<string, string>;
  methods: Map<string, MethodInfo>;
  staticFields: Map<string, FieldInfo>;
  staticMethods: Map<string, MethodInfo>;
  getters: Map<string, MethodInfo>;
  setters: Map<string, MethodInfo>;
  // Static getters/setters are kept separate from instance ones so a class may
  // declare `get context()` (instance) and `static get context()` together — AS3
  // allows the same name in both namespaces, but a single Map keyed by name
  // would let one silently overwrite the other.
  staticGetters?: Map<string, MethodInfo>;
  staticSetters?: Map<string, MethodInfo>;
  constructor: ConstructorInfo;
  superClass: string | null;
  isFinal: boolean;
  // Dynamic class: instances may gain arbitrary string-keyed properties at
  // runtime (AS3 `dynamic class`). The struct gets an extra `as_object* _dyn`
  // slot table and undeclared member access routes through as_dyn_get/set.
  isDynamic?: boolean;
  // Proxy subclass (`extends flash.utils.Proxy`). Dynamic property access on
  // such an instance is INTERCEPTED by the ten flash_proxy methods instead of
  // falling back to the `_dyn` slot table: a miss routes to getProperty /
  // setProperty / hasProperty / deleteProperty / callProperty, and enumeration
  // runs the nextNameIndex/nextName/nextValue protocol (measured on adl 51.4.1,
  // temp/proxyprobe/). The flag is INHERITED along the super chain like
  // `isDynamic` — AIR's base Proxy methods exist only to throw #2088..#2093 /
  // #2105..#2107, so a bare `extends Proxy` subclass is a proxy all the same.
  implements: string[];
  packageName: string | null;
  // AS3 fully-qualified class name (`包::类`, e.g. "starling.display::DisplayObject").
  // Filled at registration for user classes (so getQualifiedClassName can return
  // it without reverse-engineering the sanitized C name); undefined for built-ins
  // (which have no package, and are also excluded from the getDefinitionByName
  // registry). Doubles as the "user class" marker for that registry.
  fqn?: string;
  // The name AIR PRINTS for a class that is not a user class: the `flash.*`
  // built-ins (measured on adl 51.4.1, temp/pkgA/fqn-result.txt). It feeds the
  // vtable's reflectable fqn slot -- so TypeError #1034 / #1056 / #1069 messages,
  // getQualifiedClassName, getQualifiedSuperclassName, describeType and the
  // Vector element name all spell "flash.display::Sprite" the way AIR does --
  // while staying SEPARATE from `fqn`, which gates the class-VALUE machinery
  // (`_cls` objects + the getDefinitionByName registry): built-ins have no
  // constructor thunk, so marking them with `fqn` would emit `X_cls` objects that
  // reference a missing `X_new` and fail to link.
  reflectFqn?: string;
  // Import-aware short-name -> C class key resolution for THIS class's file.
  // Populated from the `import` statements preceding the class, so that
  // `flash.display.Sprite` and `starling.display.Sprite` can coexist across files
  // even though the global typeAlias short-name table can only hold one of them.
  importAlias?: Map<string, string>;
  // Source-file identifier (set in --air-app mode): a per-file anonymous-namespace
  // key used for same-file `internal` visibility.
  fileId?: string;
  // Unified ordered vtable slot list (methods + getters + setters), flattened
  // super-first in expandInheritance. Used by the emitter to declare vtable struct
  // function-pointer fields and to fill the static vtable instance in the same
  // order. See VtableSlot.
  vtableSlots?: VtableSlot[];
}

// Source position of the construct the semantic layer is CURRENTLY processing.
//
// AGENTS.md §2.5: every error must carry a line:col. The semantic layer throws
// from 150+ sites, most of which are deep inside a walk and have no token in hand.
// Rather than threading a position through all of them, the emitter/symbols layer
// publishes the position of the statement/member it is visiting (`setGenPos`,
// stamped by the parser onto those nodes) and `CodegenError` reads it as its
// default. A site that DOES know a better position can still pass one explicitly.
let genLine: number | undefined;
let genCol: number | undefined;

export function setGenPos(line?: number, col?: number): void {
  genLine = line;
  genCol = col;
}

// The message WITHOUT the `Codegen error at L:C: ` prefix. Callers that inspect or
// re-wrap a message (the `with` lexical fallback, the constructor-argument
// rethrow) must work on the bare text -- otherwise the prefix breaks their anchors
// or gets prepended twice.
export function codegenBareMessage(error: CodegenError): string {
  return error.message.replace(/^Codegen error at \d+:\d+: /, '');
}

export class CodegenError extends Error {
  line?: number;
  col?: number;
  constructor(message: string, line: number | undefined = genLine, col: number | undefined = genCol) {
    // Same shape as LexError/ParseError (`Lex error at 1:16: ...`), so the CLI's
    // top-level handler prints a locatable message for all three layers. A throw
    // from outside any stamped construct keeps the bare message rather than
    // inventing a position.
    super(line === undefined ? message : `Codegen error at ${line}:${col}: ${message}`);
    this.line = line;
    this.col = col;
  }
}

// AS3 source type -> C semantic type. `null` (untyped) defaults to `int`.
// Interface names resolve to `interface` (a reference = object pointer + vt).
// Namespaced types carry a package prefix: `foo.bar.Baz` -> C identifier `foo_bar_Baz`.
const interfaceNames = new Set<string>();
// short class/interface name -> sanitized fully-qualified name (C identifier).
const typeAlias = new Map<string, string>();

// Full C reserved-word table: C keywords plus libc/libm/POSIX/stdio/string.h/
// dirent/sys*/time.h/setjmp symbols that the generated C links against (Skia/
// SDL2/libc/libm). This is far wider than the C-keyword-only set the emitter
// previously guarded, so common AS3 identifiers like `index`/`time`/`log`/`data`
// (frequent variable/field/method names) can no longer collide with library
// symbols at file scope. See docs/zh-cn/c-naming.md §4.
export const C_RESERVED = new Set<string>([
  // C keywords + extensions
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Bool', '_Complex', '_Imaginary', 'asm', 'typeof', 'main',
  // Leading-underscore keyword aliases: MSVC also recognises `_restrict`, and both
  // GCC/Clang/MSVC recognise `__restrict` — so `restrict` (TextField.restrict) must
  // keep gaining underscores past both (→ `___restrict`) to be a valid field name
  // on every platform, not just on GCC/Clang where `_restrict` happens to be legal.
  '_restrict', '__restrict',
  // type names / macros
  'NULL', 'NAN', 'INFINITY', 'bool', 'true', 'false', 'unix', 'linux',
  // stdio
  'stdin', 'stdout', 'stderr', 'FILE', 'EOF', 'printf', 'fprintf', 'putchar',
  'puts', 'fputs', 'fgetc', 'fputc', 'getc', 'putc', 'getchar', 'scanf', 'sscanf',
  'fscanf', 'snprintf', 'sprintf', 'vsnprintf', 'vsprintf', 'vprintf', 'vfprintf',
  'fopen', 'freopen', 'fclose', 'fread', 'fwrite', 'fseek', 'fseeko', 'ftell',
  'ftello', 'rewind', 'perror', 'tmpfile', 'tmpnam', 'setbuf', 'setvbuf', 'fflush',
  'ungetc', 'feof', 'ferror', 'clearerr', 'fileno', 'fdopen', 'popen', 'pclose',
  // stdlib
  'exit', 'abort', 'atexit', 'getenv', 'calloc', 'malloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'strlen', 'memchr', 'memcmp', 'memccpy', 'swab',
  'random', 'srandom', 'rand', 'srand', 'system', 'abs', 'labs', 'div', 'ldiv',
  'qsort', 'bsearch', 'atoi', 'atol', 'atof', 'gets', 'remove', 'rename',
  'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtod', 'strtof', 'strtold',
  'mblen', 'mbtowc', 'wctomb', 'mbstowcs', 'wcstombs', 'realpath', 'mkstemp',
  'mkdtemp', 'mktemp', 'setenv', 'unsetenv', 'putenv', 'posix_memalign',
  'aligned_alloc', 'arc4random', 'valloc', 'alloca',
  // math / libm
  'log', 'log2', 'log10', 'log1p', 'pow', 'sqrt', 'cbrt', 'exp', 'exp2', 'expm1',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'fabs', 'floor', 'ceil', 'round', 'trunc', 'fmod', 'hypot', 'remainder',
  'acosh', 'asinh', 'atanh', 'erf', 'erfc', 'tgamma', 'lgamma', 'fmax', 'fmin',
  'fma', 'fdim', 'copysign', 'nearbyint', 'rint', 'lrint', 'llrint', 'lround',
  'llround', 'frexp', 'ldexp', 'modf', 'scalbn', 'scalbln', 'ilogb', 'logb',
  'nan', 'nanf', 'nextafter', 'nexttoward', 'remquo', 'j0', 'j1', 'jn', 'y0',
  'y1', 'yn', 'gamma', 'drem', 'finite', 'significand',
  // unistd / POSIX
  'fork', 'sleep', 'usleep', 'sync', '_exit', 'pipe', 'dup', 'dup2', 'pause',
  'alarm', 'getpid', 'getppid', 'open', 'link', 'unlink', 'access', 'kill',
  'raise', 'read', 'write', 'close', 'signal', 'time', 'lseek', 'chdir', 'fchdir',
  'getcwd', 'isatty', 'ttyname', 'execv', 'execve', 'execvp', 'execl', 'execlp',
  'execle', 'getuid', 'geteuid', 'getgid', 'getegid', 'setuid', 'setgid', 'seteuid',
  'setegid', 'getpgrp', 'setpgid', 'setsid', 'getsid', 'truncate', 'ftruncate',
  'rmdir', 'chown', 'fchown', 'lchown', 'readlink', 'symlink', 'nice', 'crypt',
  'encrypt', 'brk', 'sbrk', 'gethostname', 'sethostname', 'getlogin', 'fsync',
  'fdatasync', 'pread', 'pwrite', 'environ', 'getopt', 'optarg', 'optind', 'opterr',
  'optopt', 'confstr', 'pathconf', 'fpathconf', 'sysconf', 'chroot', 'vfork',
  'daemon', 'setgroups', 'getgroups',
  // string.h / strings.h (legacy BSD aliases)
  'index', 'rindex', 'bcopy', 'bzero', 'bcmp', 'ffs', 'ffsl', 'ffsll', 'fls',
  'flsl', 'flsll', 'strcasecmp', 'strncasecmp', 'strcpy', 'strncpy', 'strcat',
  'strncat', 'strcmp', 'strncmp', 'strchr', 'strrchr', 'strstr', 'strtok', 'strdup',
  'strndup', 'strerror', 'strspn', 'strcspn', 'strpbrk', 'strcoll', 'strxfrm',
  'strsep', 'stpcpy', 'stpncpy', 'strnlen', 'strlcpy', 'strlcat',
  // dirent / sys/mman / sys/stat / sys/wait / signal / setjmp
  'opendir', 'readdir', 'closedir', 'rewinddir', 'seekdir', 'telldir', 'scandir',
  'alphasort', 'dirfd', 'fdopendir', 'mmap', 'munmap', 'mprotect', 'madvise',
  'msync', 'mlock', 'munlock', 'mlockall', 'munlockall', 'mincore', 'shm_open',
  'shm_unlink', 'stat', 'fstat', 'lstat', 'fstatat', 'chmod', 'fchmod', 'fchmodat',
  'mkdir', 'mkdirat', 'mkfifo', 'mknod', 'umask', 'futimens', 'utimensat', 'wait',
  'waitpid', 'wait3', 'wait4', 'sigaction', 'sigaddset', 'sigdelset', 'sigemptyset',
  'sigfillset', 'sigismember', 'sigprocmask', 'sigsuspend', 'sigpending', 'sigwait',
  'killpg', 'psignal', 'setjmp', 'longjmp', '_setjmp', '_longjmp', 'sigsetjmp',
  'siglongjmp', 'errno',
  // time.h
  'clock', 'times', 'gmtime', 'localtime', 'mktime', 'ctime', 'asctime', 'strftime',
  'strptime', 'difftime', 'timegm', 'timelocal', 'tzset', 'daylight', 'timezone',
  'tzname', 'nanosleep', 'clock_gettime', 'clock_settime', 'clock_getres',
  'ctime_r', 'asctime_r', 'gmtime_r', 'localtime_r', 'gettimeofday',
]);

// Sanitize an AS3 identifier into a valid, collision-free C identifier. Prefixes
// `_` incrementally until the name is neither a C reserved word nor (when a
// `used` set is supplied) already emitted in this translation unit — Porffor's
// `exit -> _exit -> __exit` loop. The `used` set (P2) makes distinct AS3 names
// map to distinct C names even when the reserved table alone would alias them
// (e.g. `exit` and `_exit` both want `__exit`).
export function sanitizeCIdent(name: string, used?: Set<string>): string {
  // SWF `SymbolClass` linkage names routinely carry CJK identifiers (a
  // Chinese-authored FLA exports its auto-generated symbols as `元件1_3`). Raw
  // non-ASCII bytes in a C identifier are only a compiler extension, so escape
  // every code point above ASCII to `_uXXXX`. Pure-ASCII names — including AS3's
  // legal `$` — are left byte-identical, so existing output never changes.
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0) as number;
    out += cp > 0x7f ? '_u' + cp.toString(16) : ch;
  }
  while (C_RESERVED.has(out) || (used !== undefined && used.has(out))) out = '_' + out;
  if (used !== undefined) used.add(out);
  return out;
}

export function sanitizePkg(pkg: string): string {
  return pkg.replace(/\./g, '_');
}

// Fully-qualified C identifier for a namespaced type: `foo.bar.Baz` -> `foo_bar_Baz`.
// The result is sanitized so a package-less class named after a libc/libm symbol
// (e.g. `index`, `log`) cannot collide with the linked libraries. Package-prefixed
// names (`foo_bar_Baz`) are already collision-free.
export function qualifiedName(name: string, pkg: string | null): string {
  const base = pkg ? `${sanitizePkg(pkg)}_${name}` : name;
  return sanitizeCIdent(base);
}

// Human-readable name for a resolved C type, used in the export manifest so the
// JS-facing contract of an exported function is documented (AS3-flavoured names
// where a direct analogue exists; C struct identifiers otherwise).
export function ctypeToString(t: CType): string {
  switch (t.kind) {
    case 'int': return 'int';
    case 'uint': return 'uint';
    case 'int64': return 'int64';
    case 'uint64': return 'uint64';
    case 'number': return 'Number';
    case 'bool': return 'Boolean';
    case 'string': return 'String';
    case 'null': return 'void*';
    case 'object': return t.className;
    case 'interface': return t.name;
    case 'array': return 'Array';
    case 'vector': return `Vector.<${ctypeToString(t.elem)}>`;
    case 'record': return 'Object';
    case 'any': return '*';
    case 'function': return 'Function';
    case 'class': return 'Class';
    case 'dict': return 'Dictionary';
    case 'regexp': return 'RegExp';
    case 'xml': return 'XML';
    case 'xmllist': return 'XMLList';
    case 'void': return 'void';
  }
}

export function resolveType(t: ASType | null, importAlias?: Map<string, string> | null): CType {
  if (t === null) return { kind: 'int' };
  // Vector.<T> — type-safe generic array (encoded as the string "Vector.<T>").
  if (t.startsWith('Vector.<')) {
    const inner = t.slice('Vector.<'.length, -1);
    return { kind: 'vector', elem: resolveType(inner as ASType, importAlias) };
  }
  switch (t) {
    case 'int': return { kind: 'int' };
    case 'uint': return { kind: 'uint' };
    case 'int64': return { kind: 'int64' };
    case 'uint64': return { kind: 'uint64' };
    case 'Number': return { kind: 'number' };
    case 'Boolean': return { kind: 'bool' };
    case 'String': return { kind: 'string' };
    case 'void': return { kind: 'void' };
    case 'Array': return { kind: 'array' };
    case 'Function': return { kind: 'function' };
    case 'Class': return { kind: 'class' };
    case 'Dictionary': return { kind: 'dict' };
    case 'XML': return { kind: 'xml' };
    case 'XMLList': return { kind: 'xmllist' };
    case 'any': return { kind: 'any' };
    default: {
      // Import-aware resolution: a short name imported via `import a.b.C` (or
      // `a.b.*`) resolves to that specific class before the global short-name
      // alias table, so `flash.display.Sprite` and `starling.display.Sprite` can
      // coexist across files.
      let fqn = importAlias?.get(t) ?? typeAlias.get(t);
      if (fqn === undefined) {
        const dot = t.lastIndexOf('.');
        if (dot >= 0) {
          const pkg = t.slice(0, dot);
          const short = t.slice(dot + 1);
          // flash.* built-in classes are keyed by their SHORT name in classMap
          // ('Stage', not 'flash_display_Stage'); user classes are keyed by the
          // sanitized C FQN (dots -> underscores).
          fqn = pkg.startsWith('flash.') ? short : qualifiedName(short, pkg);
        } else {
          fqn = t;
        }
      }
      if (interfaceNames.has(fqn)) return { kind: 'interface', name: fqn };
      return { kind: 'object', className: fqn };
    }
  }
}

// 批次1c — reject a type ANNOTATION that names neither a class nor an interface.
//
// `resolveType` is a pure function with no symbol table, so for a name it cannot
// classify it must answer `{kind:'object', className}`. That used to sail all
// the way to `cc`, which failed with `error: unknown type name 'Nope'` — no AS3
// line:col, and no hint that the annotation itself was the problem (measured:
// `var x: NoSuchType = null;` on the pre-stage compiler). AIR rejects such a
// program outright, so this is a missing compile-time error, not an enhancement.
//
// Callers only pass genuine annotation sites (field/param/return/local/for-each/
// catch), never a name probe: `rt()` in emit.ts is also used to ask "is this name
// a class?" (e.g. the `Type(expr)` cast syntax), where an unknown name is legal.
// A `Vector.<T>` carries its element annotation inside the name, so it recurses
// to report the ELEMENT type (`Vector.<Nope>` must say `Nope`, not the whole name).
export function checkTypeAnnotation(
  t: ASType | null,
  importAlias: Map<string, string> | null | undefined,
  known: { hasClass(name: string): boolean; hasInterface(name: string): boolean },
): void {
  if (t === null) return;
  const ct = resolveType(t, importAlias);
  if (ct.kind === 'vector') {
    const inner = t.startsWith('Vector.<') ? t.slice('Vector.<'.length, -1) : null;
    if (inner !== null) checkTypeAnnotation(inner as ASType, importAlias, known);
    return;
  }
  if (ct.kind === 'object' && !known.hasClass(ct.className)) {
    throw new CodegenError(`unknown type '${t}'`);
  }
  if (ct.kind === 'interface' && !known.hasInterface(ct.name)) {
    throw new CodegenError(`unknown interface '${t}'`);
  }
}

// Build an import-aware short-name -> C class-key map for one file's `import`
// list. Handles `import a.b.C;` (short "C" -> C key of a.b.C) and
// `import a.b.*;` (every known class in package a.b). flash.* built-ins are keyed
// by their short name; user classes by their sanitized FQN.
function buildImportAlias(imports: string[], classMap: Map<string, ClassInfo>): Map<string, string> {
  const alias = new Map<string, string>();
  for (const imp of imports) {
    if (imp.endsWith('.*')) {
      const pkg = imp.slice(0, -2);
      for (const [cname, info] of classMap) {
        if (info.packageName === pkg && info.fqn) {
          alias.set(info.fqn.split('::').pop()!, cname);
        }
      }
      continue;
    }
    const dot = imp.lastIndexOf('.');
    const short = dot >= 0 ? imp.slice(dot + 1) : imp;
    const pkg = dot >= 0 ? imp.slice(0, dot) : '';
    // flash.* built-ins are keyed by short name; everything else by FQN.
    const cname = pkg.startsWith('flash.') ? short : qualifiedName(short, pkg);
    alias.set(short, cname);
  }
  return alias;
}

// Pass 1 of the generator: collect all class/function symbols so forward
// references resolve, then flatten inheritance for layout-compatible structs.
export class SymbolTable {
  private classMap = new Map<string, ClassInfo>();
  // ClassDecl starting position per FQN, so pass-2 walks that only see a class
  // NAME (expandInheritance) can still publish a CodegenError position.
  private classPos = new Map<string, { line?: number; col?: number }>();
  private funcMap = new Map<string, FuncInfo>();
  private interfaceMap = new Map<string, InterfaceInfo>();
  private exportList: ExportedSymbol[] = [];
  // `<class FQN>#<field>` -> generated class FQN, for `[Embed]` fields: an
  // embedded asset field is declared without an initializer, so its value is
  // supplied here as a synthetic Class-value reference (see collect).
  private embedFieldInits = new Map<string, string>();

  /**
   * The key an `[Embed]` field is looked up by: the declaring class's AS3 FQN
   * (`a.b::C`) plus the field name. `embed.ts` builds the map with the same key,
   * so the two cannot drift.
   */
  static embedFieldKey(ownerName: string, ownerPackage: string | null, field: string): string {
    return `${ownerPackage ? `${ownerPackage}::${ownerName}` : ownerName}#${field}`;
  }

  get classes(): ReadonlyMap<string, ClassInfo> { return this.classMap; }
  get funcs(): ReadonlyMap<string, FuncInfo> { return this.funcMap; }
  get interfaces(): ReadonlyMap<string, InterfaceInfo> { return this.interfaceMap; }
  get exports(): ReadonlyArray<ExportedSymbol> { return this.exportList; }

  collect(program: Program, embedFieldInits?: ReadonlyMap<string, string>): void {
    this.embedFieldInits = new Map(embedFieldInits ?? []);
    // pass -1: build the short-name -> FQN alias table so type references can
    // resolve across namespaces, and reset module-level resolution state.
    const fqn = (name: string, pkg: string | null) => qualifiedName(name, pkg);
    interfaceNames.clear();
    typeAlias.clear();
    this.classPos.clear();
    for (const stmt of program.body) {
      if (stmt.kind === 'InterfaceDecl' || stmt.kind === 'ClassDecl') {
        setGenPos(stmt.line, stmt.col);
        typeAlias.set(stmt.name, fqn(stmt.name, stmt.packageName));
        if (stmt.kind === 'ClassDecl') this.classPos.set(fqn(stmt.name, stmt.packageName), { line: stmt.line, col: stmt.col });
      }
    }
    // pass 0: register interfaces. Two loops on purpose: ALL interface names are
    // published before any interface's member types are resolved. AS3 allows a
    // same-package type to be referenced without an import, and resolveType only
    // recognizes an interface through `interfaceNames` -- resolving inline meant a
    // file processed before its sibling (away3d.paths.IPath before IPathSegment)
    // resolved the sibling to an unknown OBJECT, emitting `IPathSegment*` in the
    // vtable slot while the implementation returns the interface struct by value.
    for (const stmt of program.body) {
      if (stmt.kind === 'InterfaceDecl') interfaceNames.add(fqn(stmt.name, stmt.packageName));
    }
    for (const stmt of program.body) {
      setGenPos(stmt.line, stmt.col);
      if (stmt.kind === 'InterfaceDecl') {
        const iname = fqn(stmt.name, stmt.packageName);
        const importAlias = buildImportAlias(stmt.imports, this.classMap);
        const methods = new Map<string, MethodInfo>();
        const getters = new Map<string, MethodInfo>();
        const setters = new Map<string, MethodInfo>();
        for (const m of stmt.methods) {
          // NOTE: annotations are NOT validated here — see "pass 2.1" below. At this
          // point no user class shell exists yet (pass 1 registers those), so a legal
          // interface method naming a user class (starling's `getTexture(): Texture`)
          // would be falsely rejected. Registration is what pass 0 is for; validation
          // waits until every class/interface is known.
          const mi: MethodInfo = { returnType: resolveType(m.returnType, importAlias), params: m.params, owner: iname, visibility: 'public', isStatic: false, isFinal: false, isGetter: m.isGetter, isSetter: m.isSetter };
          if (m.isGetter) getters.set(m.name, mi);
          else if (m.isSetter) setters.set(m.name, mi);
          else methods.set(m.name, mi);
        }
        // `interface I extends A, B` — resolve parents with this file's import
        // context, same as a class's `implements` list.
        const parents = stmt.extendsList.map((i) => {
          const t = resolveType(i, importAlias);
          return t.kind === 'interface' ? t.name : (t.kind === 'object' ? t.className : i);
        });
        const reflectFqn = stmt.packageName ? `${stmt.packageName}::${stmt.name}` : stmt.name;
        this.interfaceMap.set(iname, { methods, getters, setters, importAlias, extends: parents, reflectFqn });
      }
    }
    // pass 0.5: inject the built-in Object root class (every class's implicit base).
    this.classMap.set('Object', {
      fields: new Map(),
      methods: new Map([
        ['toString', { returnType: { kind: 'string' }, params: [], owner: 'Object', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['hasOwnProperty', { returnType: { kind: 'bool' }, params: [{ name: 'name', type: 'String', defaultValue: null, isRest: false }], owner: 'Object', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: null,
      isFinal: false,
      implements: [],
    });
    // flash.utils.Proxy (stage 94a): the AVM2 property-interception base class.
    // The ten flash_proxy methods are registered with their real signatures so
    // subclass overrides (`flash_proxy override function getProperty(...)`) match
    // a vtable slot; the base implementations are NOT emitted — calling one that
    // a subclass did not override throws AIR's error (see as_proxy_throw in
    // emit.ts). Signatures per airglobal.abc's describeType(Proxy) dump (measured:
    // temp/proxyprobe/proxy-traits.txt), which is authoritative over the docs —
    // it lists getDescendants, NOT the widely-documented getPropertyKeys.
    {
      const pm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Proxy', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false, isProxyNs: true, ns: 'flash_proxy' });
      // '*' is the AS3 untyped type; the parser normalizes source-level `*` to
      // 'any', so the built-in signatures must use the same spelling (a raw '*'
      // would resolve to the CType for a class literally named '*').
      const pName: Param = { name: 'name', type: 'any', defaultValue: null, isRest: false };
      const pIdx: Param = { name: 'index', type: 'int', defaultValue: null, isRest: false };
      this.classMap.set('Proxy', {
        fields: new Map(),
        methods: new Map([
          ['getProperty', pm({ kind: 'any' }, [pName])],
          ['setProperty', pm({ kind: 'void' }, [pName, { name: 'value', type: 'any', defaultValue: null, isRest: false }])],
          ['deleteProperty', pm({ kind: 'bool' }, [pName])],
          ['hasProperty', pm({ kind: 'bool' }, [pName])],
          ['callProperty', pm({ kind: 'any' }, [pName, { name: 'rest', type: 'Array', defaultValue: null, isRest: true }])],
          ['getDescendants', pm({ kind: 'any' }, [pName])],
          ['nextNameIndex', pm({ kind: 'int' }, [pIdx])],
          ['nextName', pm({ kind: 'string' }, [pIdx])],
          ['nextValue', pm({ kind: 'any' }, [pIdx])],
          ['isAttribute', pm({ kind: 'bool' }, [pName])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        isProxy: true,
        implements: [],
      });
    }
    // flash.display graphics-data classes (stage 93): Starling's Canvas legacy
    // drawGraphicsData path. Modeled as plain value bundles + an empty marker
    // interface; only the field reads/writes Canvas performs are needed.
    interfaceNames.add('IGraphicsData');
    this.interfaceMap.set('IGraphicsData', { methods: new Map(), getters: new Map(), setters: new Map(), reflectFqn: 'flash.display::IGraphicsData' });
    const gsff = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'GraphicsSolidFill', isStatic: false, isConst: false });
    this.classMap.set('GraphicsSolidFill', {
      fields: new Map([
        ['color', gsff({ kind: 'uint' })],
        ['alpha', gsff({ kind: 'number' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: ['IGraphicsData'],
    });
    const gpathf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'GraphicsPath', isStatic: false, isConst: false });
    this.classMap.set('GraphicsPath', {
      fields: new Map([
        ['commands', gpathf({ kind: 'vector', elem: { kind: 'int' } })],
        ['data', gpathf({ kind: 'vector', elem: { kind: 'number' } })],
        ['winding', gpathf({ kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'commands', type: 'Vector.<int>', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'data', type: 'Vector.<Number>', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'winding', type: 'String', defaultValue: { kind: 'Str', value: 'evenOdd' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: ['IGraphicsData'],
    });
    this.classMap.set('GraphicsEndFill', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: ['IGraphicsData'],
    });
    this.classMap.set('GraphicsPathCommand', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['MOVE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 1, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
        ['LINE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 2, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
        ['CURVE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 3, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
        ['WIDE_MOVE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 4, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
        ['WIDE_LINE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 5, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
        ['CUBIC_CURVE_TO', { type: { kind: 'int' }, init: { kind: 'Num', value: 6, isInt: true }, visibility: 'public', owner: 'GraphicsPathCommand', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // inject the built-in Error class (used by throw/catch).
    this.classMap.set('Error', {
      fields: new Map([
        ['message', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Error', isStatic: false, isConst: false }],
        ['errorID', { type: { kind: 'int' }, init: null, visibility: 'public', owner: 'Error', isStatic: false, isConst: false }],
        // AIR's Error also exposes `name` (read/write, default "Error"); every
        // subclass except flash.errors.IOError/EOFError/IllegalOperationError
        // overrides it with its own class name. Measured on adl 51.4.1 in
        // temp/errprobe. Appended LAST so the { vtable; message } view the
        // uncaught-exception printer uses (as_error_view) keeps its offsets.
        ['name', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Error', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        // Error overrides Object.toString: the name alone when the message is
        // empty, "name: message" otherwise (`new Error()` -> "Error",
        // `new Error("boom")` -> "Error: boom"; measured).
        ['toString', { returnType: { kind: 'string' }, params: [], owner: 'Error', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        // AIR's default message is the EMPTY string, not "Error" (`new Error()`
        // reports message "" and toString() "Error"; measured).
        { name: 'message', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
        { name: 'id', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in Error subclasses: share Error's { vtable; message } layout, but
    // each has its own vtable so `catch (e:TypeError)` can match precisely.
    for (const sub of ['TypeError', 'RangeError', 'ArgumentError', 'SyntaxError', 'ReferenceError', 'DefinitionError', 'VerifyError', 'EvalError', 'URIError', 'UninitializedError', 'IllegalOperationError', 'IllegalArgumentError', 'SecurityError', 'EOFError', 'IOError']) {
      this.classMap.set(sub, {
        fields: new Map(),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [
          // Both defaults are AIR's: the message is empty and the id 0, and the
          // class NAME is not the message (`new TypeError()` -> message "", name
          // "TypeError"; measured in temp/errprobe).
          { name: 'message', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
          { name: 'id', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ] },
        superClass: 'Error',
        isFinal: false,
        implements: [],
      });
    }
    // built-in Date class: wraps a millisecond timestamp and exposes calendar accessors.
    const dm = (ret: CType): MethodInfo => ({
      returnType: ret, params: [], owner: 'Date', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false,
    });
    this.classMap.set('Date', {
      fields: new Map([['time', { type: { kind: 'number' }, init: null, visibility: 'public', owner: 'Date', isStatic: false, isConst: false }]]),
      methods: new Map([
        ['getTime', dm({ kind: 'number' })],
        ['getFullYear', dm({ kind: 'int' })],
        ['getMonth', dm({ kind: 'int' })],
        ['getDate', dm({ kind: 'int' })],
        ['getDay', dm({ kind: 'int' })],
        ['getHours', dm({ kind: 'int' })],
        ['getMinutes', dm({ kind: 'int' })],
        ['getSeconds', dm({ kind: 'int' })],
        ['toDateString', dm({ kind: 'string' })],
        ['toUTCString', dm({ kind: 'string' })],
      ]),
      staticFields: new Map(),
      staticMethods: new Map([
        ['parse', { returnType: { kind: 'number' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'Date', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in RegExp class: wraps a compiled regex program plus source/flags
    // metadata. `exec` returns an Array (or null) and `test` a Boolean; both take
    // the subject string. `lastIndex` is writable and drives `g` matching.
    const rf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'RegExp', isStatic: false, isConst: false });
    this.classMap.set('RegExp', {
      fields: new Map([
        ['compiled', rf({ kind: 'regexp' })],
        ['source', rf({ kind: 'string' })],
        ['flags', rf({ kind: 'string' })],
        ['lastIndex', rf({ kind: 'int' })],
        ['global', rf({ kind: 'bool' })],
        ['ignoreCase', rf({ kind: 'bool' })],
        ['multiline', rf({ kind: 'bool' })],
        ['dotall', rf({ kind: 'bool' })],
        ['extended', rf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['exec', { returnType: { kind: 'array' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'RegExp', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['test', { returnType: { kind: 'bool' }, params: [{ name: 's', type: 'String', defaultValue: null, isRest: false }], owner: 'RegExp', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'pattern', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
        { name: 'flags', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in Event class (flash.events.Event): the base event object. The AS3
    // read-only properties (type/bubbles/cancelable/target/currentTarget/eventPhase)
    // are modeled as fields; three extra internal flags (cancelled/propStopped/
    // immStopped) drive preventDefault/stopPropagation/stopImmediatePropagation.
    // target/currentTarget are Object* (any dispatcher or display object).
    const evf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Event', isStatic: false, isConst: false });
    const evm = (ret: CType, params: Param[] = []): MethodInfo => ({ returnType: ret, params, owner: 'Event', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const evc = (value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner: 'Event', isStatic: true, isConst: true });
    this.classMap.set('Event', {
      fields: new Map([
        ['type', evf({ kind: 'string' })],
        ['bubbles', evf({ kind: 'bool' })],
        ['cancelable', evf({ kind: 'bool' })],
        ['target', evf({ kind: 'object', className: 'Object' })],
        ['currentTarget', evf({ kind: 'object', className: 'Object' })],
        ['eventPhase', evf({ kind: 'int' })],
        ['cancelled', evf({ kind: 'bool' })],
        ['propStopped', evf({ kind: 'bool' })],
        ['immStopped', evf({ kind: 'bool' })],
      ]),
      methods: new Map([
        ['toString', evm({ kind: 'string' })],
        ['clone', evm({ kind: 'object', className: 'Event' })],
        ['preventDefault', evm({ kind: 'void' })],
        // AIR reports the prevented state through isDefaultPrevented() (there is
        // NO `defaultPrevented` property: assigning it throws #1056; measured in
        // temp/evtdefprobe). The state itself lives in the `cancelled` slot, which
        // preventDefault only sets when the event is cancelable.
        ['isDefaultPrevented', evm({ kind: 'bool' })],
        ['stopPropagation', evm({ kind: 'void' })],
        ['stopImmediatePropagation', evm({ kind: 'void' })],
      ]),
      staticFields: new Map([
        ['ACTIVATE', evc('activate')],
        ['ADDED', evc('added')],
        ['ADDED_TO_STAGE', evc('addedToStage')],
        ['REMOVED', evc('removed')],
        ['REMOVED_FROM_STAGE', evc('removedFromStage')],
        ['ENTER_FRAME', evc('enterFrame')],
        ['EXIT_FRAME', evc('exitFrame')],
        ['COMPLETE', evc('complete')],
        ['CHANGE', evc('change')],
        ['RESIZE', evc('resize')],
        ['CANCEL', evc('cancel')],
        ['CLEAR', evc('clear')],
        ['CLOSE', evc('close')],
        ['CONNECT', evc('connect')],
        ['COPY', evc('copy')],
        ['CUT', evc('cut')],
        ['DEACTIVATE', evc('deactivate')],
        ['FRAME_CONSTRUCTED', evc('frameConstructed')],
        ['FULLSCREEN', evc('fullScreen')],
        ['ID3', evc('id3')],
        ['INIT', evc('init')],
        ['MOUSE_LEAVE', evc('mouseLeave')],
        ['OPEN', evc('open')],
        ['PASTE', evc('paste')],
        ['RENDER', evc('render')],
        ['SCROLL', evc('scroll')],
        ['SELECT', evc('select')],
        ['SOUND_COMPLETE', evc('soundComplete')],
        ['TAB_CHILDREN_CHANGE', evc('tabChildrenChange')],
        ['TAB_ENABLED_CHANGE', evc('tabEnabledChange')],
        ['TAB_INDEX_CHANGE', evc('tabIndexChange')],
        ['UNLOAD', evc('unload')],
        ['BROWSER_ZOOM_CHANGE', evc('browserZoomChange')],
        ['CONTEXT3D_CREATE', evc('context3DCreate')],
        ['TEXTURE_READY', evc('textureReady')],
        ['TEXTURES_RESTORED', evc('texturesRestored')],
        ['CONTEXT', evc('context')],
        ['ERROR', evc('error')],
        ['FATAL_ERROR', evc('fatalError')],
        ['IO_ERROR', evc('ioError')],
        ['KEY_DOWN', evc('keyDown')],
        ['KEY_UP', evc('keyUp')],
        ['MOUSE_DOWN', evc('mouseDown')],
        ['MOUSE_MOVE', evc('mouseMove')],
        ['MOUSE_UP', evc('mouseUp')],
        ['PARSE_ERROR', evc('parseError')],
        ['PROGRESS', evc('progress')],
        ['RENDER_COMPLETE', evc('renderComplete')],
        ['SECURITY_ERROR', evc('securityError')],
        ['TIMER', evc('timer')],
        ['TOUCH', evc('touch')],
        ['TOUCH_BEGIN', evc('touchBegin')],
        ['TOUCH_END', evc('touchEnd')],
        ['TOUCH_MOVE', evc('touchMove')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        { name: 'bubbles', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'cancelable', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // built-in EventDispatcher (flash.events.EventDispatcher): holds a listener
    // table (as_object: "type#cap"/"type#bub" -> as_array of as_fn) plus a parent
    // pointer (used by the display list in later stages to walk the ancestor chain).
    const dpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'EventDispatcher', isStatic: false, isConst: false });
    const dpm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'EventDispatcher', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('EventDispatcher', {
      fields: new Map([
        ['listeners', dpf({ kind: 'record' })],
        ['parent', dpf({ kind: 'object', className: 'Object' })],
        // AIR's `new EventDispatcher(target)`: the object that becomes event.target
        // for events dispatched through this dispatcher (null = the dispatcher).
        ['_evtarget', { type: { kind: 'object', className: 'Object' }, init: null, visibility: 'private', owner: 'EventDispatcher', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['addEventListener', dpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
          { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'priority', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'useWeakReference', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['removeEventListener', dpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
          { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['hasEventListener', dpm({ kind: 'bool' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['willTrigger', dpm({ kind: 'bool' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['dispatchEvent', dpm({ kind: 'bool' }, [
          { name: 'event', type: 'Event', defaultValue: null, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      // AIR signature: EventDispatcher(target:IEventDispatcher = null). The single
      // optional argument is what `new EventDispatcher(this)` passes; being
      // optional keeps the implicit `super()` of every subclass legal.
      constructor: { params: [{ name: 'target', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false }] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.events.IEventDispatcher (AIR): the interface EventDispatcher
    // implements, and the declared parent of user interfaces
    // (`interface ILoader extends IEventDispatcher`). Registered with its five
    // real AIR signatures — the same ones the built-in EventDispatcher carries —
    // so a class that extends EventDispatcher (or any dispatcher) satisfies an
    // `implements`/`extends` check against it. Without this, a perfectly legal
    // `interface X extends IEventDispatcher` was rejected at the NEW
    // interface-extends resolution (the parse error used to hide it).
    {
      const ied = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'IEventDispatcher', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      interfaceNames.add('IEventDispatcher');
      this.interfaceMap.set('IEventDispatcher', {
        // IEventDispatcher is an event bus with no accessors, but the empty maps
        // keep the InterfaceInfo shape uniform (see the accessor split in pass 0).
        reflectFqn: 'flash.events::IEventDispatcher',
        getters: new Map(),
        setters: new Map(),
        methods: new Map([
          ['addEventListener', ied({ kind: 'void' }, [
            { name: 'type', type: 'String', defaultValue: null, isRest: false },
            { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
            { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
            { name: 'priority', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'useWeakReference', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          ['removeEventListener', ied({ kind: 'void' }, [
            { name: 'type', type: 'String', defaultValue: null, isRest: false },
            { name: 'listener', type: 'Function', defaultValue: null, isRest: false },
            { name: 'useCapture', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          ['hasEventListener', ied({ kind: 'bool' }, [{ name: 'type', type: 'String', defaultValue: null, isRest: false }])],
          ['willTrigger', ied({ kind: 'bool' }, [{ name: 'type', type: 'String', defaultValue: null, isRest: false }])],
          ['dispatchEvent', ied({ kind: 'bool' }, [{ name: 'event', type: 'Event', defaultValue: null, isRest: false }])],
        ]),
      });
    }
    // flash.desktop.NativeApplication: AIR's native-application singleton (window
    // activate/deactivate notifications). AOT keeps one global instance reachable
    // through the static `nativeApplication` getter; it inherits the EventDispatcher
    // listener table so addEventListener works for ACTIVATE/DEACTIVATE.
    this.classMap.set('NativeApplication', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      staticGetters: new Map([
        ['nativeApplication', { returnType: { kind: 'object', className: 'NativeApplication' }, params: [], owner: 'NativeApplication', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // built-in display list (flash.display). DisplayObject extends EventDispatcher,
    // so the parent link and listener table are inherited; it adds the transform
    // properties (name/x/y/width/height/visible/alpha/rotation/scaleX/scaleY).
    //
    // width/height are ACCESSORS, not fields (stage 94·5, measured on adl 51.4.1):
    // AIR derives them from the content bounds transformed by the object's own
    // matrix (§ examples/stage94f.as). A stored field would make every "draw and
    // never assign width" object 0x0 (which is what the old code did, and it also
    // broke hit testing). Measured rules:
    //   get: AABB(contentBoundsInLocalSpace, ownMatrix) size -- so rotation and
    //        both scales participate (100x20 rotated 45deg -> 84.85 x 84.85,
    //        scaleX=2 -> double the content width).
    //   set: scaleX = scaleX * value / currentWidth (0 when the content is empty,
    //        measured: setting width=50 on an empty Shape leaves scaleX=0), which
    //        is why `width` is a property and not a slot.
    // TextField is the one class that overrides both accessors: it keeps real
    // stored width/height fields and the setter writes the field (measured:
    // scaleX=2 + width=200 -> field 200, scaleX stays 2, reported width 400).
    const dof = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'DisplayObject', isStatic: false, isConst: false, isAccessor: true });
    const dog = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'DisplayObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const dos = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'DisplayObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    const dom = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'DisplayObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    // The geometry/coordinate family (stage 94·9, measured on adl 51.4.1
    // temp/geoprobe/). ALL of them live on DisplayObject (so Shape gets them too,
    // which is where AIR puts them):
    //   * getRect(target)/getBounds(target) — content AABB in TARGET's coordinate
    //     space; getBounds adds the stroke half-thickness, getRect does not;
    //     target == null means the object's own (local) space (measured).
    //   * localToGlobal/globalToLocal(point) — Stage <-> local, via the full
    //     ancestor matrix chain; return a NEW Point, never mutate the argument;
    //     a null point throws TypeError #2007.
    //   * hitTestObject(obj) — intersection of the two STAGE AABBs (stroke
    //     inclusive, i.e. getBounds-like: measured a stroked shape overlapping an
    //     unstroked one only through its stroke still returns true).
    const tfTarget = (): Param => ({ name: 'targetCoordinateSpace', type: 'DisplayObject', defaultValue: null, isRest: false });
    const ptParam = (): Param => ({ name: 'point', type: 'Point', defaultValue: null, isRest: false });
    this.classMap.set('DisplayObject', {
      fields: new Map([
        ['name', dof({ kind: 'string' })],
        ['x', dof({ kind: 'number' })],
        ['y', dof({ kind: 'number' })],
        ['visible', dof({ kind: 'bool' })],
        ['alpha', dof({ kind: 'number' })],
        ['rotation', dof({ kind: 'number' })],
        ['scaleX', dof({ kind: 'number' })],
        ['scaleY', dof({ kind: 'number' })],
        ['filters', dof({ kind: 'array' })],
        // BlendMode name (flash.display.BlendMode constants). A plain String slot,
        // like AIR's property; default "normal" (measured on adl 51.4.1, see
        // docs/zh-cn/swc.md §9.2 F4). The renderer reads it in as_render_object.
        ['blendMode', dof({ kind: 'string' })],
        ['transform', dof({ kind: 'object', className: 'Transform' })],
        // Nine-slice grid, AS3-visible since stage 101. AIR truncates the four
        // numbers toward zero on store, hands back a FRESH Rectangle on every read
        // (never the assigned instance) and validates the grid against the object's
        // current bounds -- anything not STRICTLY inside throws #2004, though the
        // truncated value stays stored (all measured on adl 51.4.1, temp/s9probe/).
        // The rect is kept in the private `_s9*` C slots the renderer already
        // consumes (DefineScalingGrid path), so `scale9Grid` is an accessor pair
        // backed by those private C slots (emitted literally in emitStructs), not an
        // AS3 field -- adding one here would emit a DUPLICATE `double _s9x`.
        // NOT a public slot: AIR's cacheAsBitmap getter reports true for any
        // object with filters (measured, temp/attrsprobe), so a plain field read
        // would diverge. The backing flag is private (C-runtime + accessor only),
        // exactly like Sprite._graphics, so `c.cacheAsBitmap` resolves to the
        // DisplayObject_get_cacheAsBitmap accessor instead of the slot.
        ['_cache_flag', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'DisplayObject', isStatic: false, isConst: false }],
        // clipDepth mask object (SWC): AIR keeps the mask in the display list but
        // never paints it, so this C-runtime-only flag carries "child, not a
        // painter" to as_render_object / as_pick_hit_m. Private like _cache_flag so
        // an AS3 `visible` read still sees AIR's value (true). (_mask_src was taken
        // by TextField's cached-mask source text.)
        ['_mask_object', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'DisplayObject', isStatic: false, isConst: false }],
        // The Flash DEPTH a baked SWC timeline child sits at (item ③): 0 = the
        // object was not placed by a timeline (a user-added child), so the timeline
        // ops never address it and `as_swc_tl_clear` leaves it alone. A plain int,
        // so no GC write barrier is involved.
        ['_tl_depth', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'DisplayObject', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['getBounds', dom({ kind: 'object', className: 'Rectangle' }, [tfTarget()])],
        ['getRect', dom({ kind: 'object', className: 'Rectangle' }, [tfTarget()])],
        ['localToGlobal', dom({ kind: 'object', className: 'Point' }, [ptParam()])],
        ['globalToLocal', dom({ kind: 'object', className: 'Point' }, [ptParam()])],
        ['hitTestObject', dom({ kind: 'bool' }, [{ name: 'obj', type: 'DisplayObject', defaultValue: null, isRest: false }])],
        ['hitTestPoint', dom({ kind: 'bool' }, [
          { name: 'x', type: 'Number', defaultValue: null, isRest: false },
          { name: 'y', type: 'Number', defaultValue: null, isRest: false },
          { name: 'shapeFlag', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['root', dog({ kind: 'object', className: 'DisplayObject' })],
        ['stage', dog({ kind: 'object', className: 'Stage' })],
        ['filters', dog({ kind: 'array' })],
        ['cacheAsBitmap', dog({ kind: 'bool' })],
        ['scale9Grid', dog({ kind: 'object', className: 'Rectangle' })],
        ['width', dog({ kind: 'number' })],
        ['height', dog({ kind: 'number' })],
      ]),
      setters: new Map([
        ['filters', dos('Array')],
        ['cacheAsBitmap', dos('Boolean')],
        ['scale9Grid', dos('Rectangle')],
        ['width', dos('Number')],
        ['height', dos('Number')],
      ]),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // InteractiveObject adds mouse/focus interaction flags (mouseEnabled/mouseChildren
    // drive the hit-test three-state machine, mouseChildren=false makes a parent
    // absorb its children's clicks).
    const iof = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'InteractiveObject', isStatic: false, isConst: false, isAccessor: true });
    // `contextMenu` is an accessor pair on InteractiveObject (AIR shape) backed by
    // a private slot; measured on adl 51.4.1 (temp/constprobe): a fresh display
    // object reports null and a stored ContextMenu round-trips by identity.
    const iog = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'InteractiveObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const ios = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'InteractiveObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('InteractiveObject', {
      fields: new Map([
        ['mouseEnabled', iof({ kind: 'bool' })],
        ['mouseChildren', iof({ kind: 'bool' })],
        // AIR: `buttonMode` (default false) turns the object into a "button" for
        // cursor purposes and `useHandCursor` (default TRUE) is the switch that
        // actually selects the hand shape. The hand shows only when both are set
        // (documented rule, applied by ASC_window_update_cursor).
        ['buttonMode', iof({ kind: 'bool' })],
        ['useHandCursor', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'InteractiveObject', isStatic: false, isConst: false }],
        ['doubleClickEnabled', iof({ kind: 'bool' })],
        ['tabEnabled', iof({ kind: 'bool' })],
        ['tabIndex', iof({ kind: 'int' })],
        ['focusRect', iof({ kind: 'bool' })],
        ['hasFocus', iof({ kind: 'bool' })],
        ['_contextMenu', { type: { kind: 'object', className: 'ContextMenu' }, init: null, visibility: 'private', owner: 'InteractiveObject', isStatic: false, isConst: false }],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['contextMenu', iog({ kind: 'object', className: 'ContextMenu' })],
        // AIR's live pointer position relative to this object. The runtime tracks the
        // pointer in STAGE coordinates (ASC_mouse_x/y, fed by the window glue and by
        // the Stage.dispatchMouse test hook); the getters push that point through the
        // object's transform chain with as_local_point.
        ['mouseX', iog({ kind: 'number' })],
        ['mouseY', iog({ kind: 'number' })],
      ]),
      setters: new Map([
        ['contextMenu', ios('ContextMenu')],
      ]),
      constructor: { params: [] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    // DisplayObjectContainer holds the child list (render order = depth order).
    const dcf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'DisplayObjectContainer', isStatic: false, isConst: false });
    const dcm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'DisplayObjectContainer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const dcChild = (name: string): Param => ({ name, type: 'DisplayObject', defaultValue: null, isRest: false });
    this.classMap.set('DisplayObjectContainer', {
      fields: new Map([
        ['children', dcf({ kind: 'array' })],
      ]),
      methods: new Map([
        ['addChild', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child')])],
        ['addChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child'), { name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['removeChild', dcm({ kind: 'object', className: 'DisplayObject' }, [dcChild('child')])],
        ['removeChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['getChildAt', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['getChildByName', dcm({ kind: 'object', className: 'DisplayObject' }, [{ name: 'name', type: 'String', defaultValue: null, isRest: false }])],
        ['contains', dcm({ kind: 'bool' }, [dcChild('child')])],
        ['setChildIndex', dcm({ kind: 'void' }, [dcChild('child'), { name: 'index', type: 'int', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['numChildren', { returnType: { kind: 'int' }, params: [], owner: 'DisplayObjectContainer', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // Stage is the outermost container (root of the display tree). It also
    // exposes a non-standard dispatchMouse(x, y, type) test hook that runs the
    // inside-out hit test + dispatch (no window system in this subset). Stage 41
    // adds the desktop AIR stage properties (size/fullscreen/quality/color/align/
    // scaleMode/frameRate) as plain fields with getter/setter accessors.
    const stgf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Stage', isStatic: false, isConst: false });
    const stgg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const stgs = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('Stage', {
      fields: new Map([
        ['stage_w', stgf({ kind: 'int' })],
        ['stage_h', stgf({ kind: 'int' })],
        ['stage_color', stgf({ kind: 'uint' })],
        ['quality', stgf({ kind: 'string' })],
        ['align', stgf({ kind: 'string' })],
        ['scale_mode', stgf({ kind: 'string' })],
        // NOTE: no `frame_rate` field — in AIR the frame rate is APPLICATION-wide,
        // not per-Stage. It lives in the generated C as the single static
        // ASC_app_frame_rate that every Stage's frameRate getter/setter proxies.
        // See emit.ts's Stage accessors.
        ['stage_scale', stgf({ kind: 'number' })],
        ['display_state', stgf({ kind: 'string' })],
        ['stage_focus_rect', stgf({ kind: 'bool' })],
        ['show_default_context_menu', stgf({ kind: 'bool' })],
        ['tab_children', stgf({ kind: 'bool' })],
        ['stage3ds', stgf({ kind: 'vector', elem: { kind: 'object', className: 'Stage3D' } })],
      ]),
      methods: new Map([
        ['dispatchMouse', { returnType: { kind: 'void' }, params: [
          { name: 'x', type: 'Number', defaultValue: null, isRest: false },
          { name: 'y', type: 'Number', defaultValue: null, isRest: false },
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: feeds a key event through the same path the SDL2
        // event loop uses. `mod` is the ASC_MOD_* bit mask (1=ctrl, 2=alt,
        // 4=shift, 8=cmd), the same one Stage_dispatchKey receives from the glue.
        // Not part of AIR's Stage API; exposed so tests can drive the keyboard
        // (and, via Tab, focus traversal) the same way dispatchMouse drives clicks.
        ['dispatchKey', { returnType: { kind: 'void' }, params: [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'keyCode', type: 'int', defaultValue: null, isRest: false },
          { name: 'charCode', type: 'int', defaultValue: null, isRest: false },
          { name: 'mod', type: 'int', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: feeds a committed character string through the same
        // path SDL_TEXTINPUT uses (AIR's TextEvent.TEXT_INPUT pipeline: dispatch
        // textInput, then insert unless cancelled). Not part of AIR's Stage API;
        // exposed so tests can drive typing the same way dispatchKey drives keys.
        ['dispatchText', { returnType: { kind: 'void' }, params: [
          { name: 'text', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: feeds an IME COMPOSITION (marked text) into the
        // focused editable TextField through the same path SDL_TEXTEDITING uses.
        // The marked text is a PREVIEW: it is not committed (`.text`, the caret and
        // the selection stay put and no change fires) and is painted at the caret
        // with an underline; the commit arrives as a plain textInput. An empty
        // `text` ends the composition. `start`/`length` are the IME's selection
        // inside the composition (-1/0 when it has none) and only feed the
        // candidate-window placement. Not part of AIR's Stage API -- and on adl
        // 51.4.1 the composition cannot be driven from AS3 at all
        // (IME.setCompositionString throws Error #2063), so this hook is the only
        // way to exercise the state.
        ['dispatchTextEditing', { returnType: { kind: 'void' }, params: [
          { name: 'text', type: 'String', defaultValue: null, isRest: false },
          { name: 'start', type: 'int', defaultValue: { kind: 'Num', value: -1, isInt: true }, isRest: false },
          { name: 'length', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: feeds a wheel notch into the TextField under (x,y)
        // and dispatches a bubbling MouseEvent.MOUSE_WHEEL. Not part of AIR's Stage
        // API (there the player does this internally); exposed so tests and the SDL2
        // event loop can drive scrolling the same way dispatchMouse drives clicks.
        ['dispatchWheel', { returnType: { kind: 'void' }, params: [
          { name: 'x', type: 'Number', defaultValue: null, isRest: false },
          { name: 'y', type: 'Number', defaultValue: null, isRest: false },
          { name: 'delta', type: 'Number', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // Native-backend hook: broadcasts the ENTER_FRAME event to every display
        // object once per rendered frame. Not part of AIR's Stage API (there the
        // player drives the frame loop internally); exposed so the SDL2 event loop
        // can advance the frame clock the same way dispatchMouse drives clicks.
        ['dispatchFrame', { returnType: { kind: 'void' }, params: [
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['render', { returnType: { kind: 'void' }, params: [
          { name: 'width', type: 'Number', defaultValue: null, isRest: false },
          { name: 'height', type: 'Number', defaultValue: null, isRest: false },
          { name: 'path', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['showWindow', { returnType: { kind: 'void' }, params: [
          { name: 'width', type: 'Number', defaultValue: null, isRest: false },
          { name: 'height', type: 'Number', defaultValue: null, isRest: false },
          { name: 'title', type: 'String', defaultValue: null, isRest: false },
        ], owner: 'Stage', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['stageWidth', stgg({ kind: 'int' })],
        ['stageHeight', stgg({ kind: 'int' })],
        ['fullScreenWidth', stgg({ kind: 'uint' })],
        ['fullScreenHeight', stgg({ kind: 'uint' })],
        ['displayState', stgg({ kind: 'string' })],
        ['quality', stgg({ kind: 'string' })],
        ['color', stgg({ kind: 'uint' })],
        ['align', stgg({ kind: 'string' })],
        ['scaleMode', stgg({ kind: 'string' })],
        ['frameRate', stgg({ kind: 'number' })],
        ['stageFocusRect', stgg({ kind: 'bool' })],
        ['showDefaultContextMenu', stgg({ kind: 'bool' })],
        ['tabChildren', stgg({ kind: 'bool' })],
        ['allowsFullScreen', stgg({ kind: 'bool' })],
        ['allowsFullScreenInteractive', stgg({ kind: 'bool' })],
        ['contentsScaleFactor', stgg({ kind: 'number' })],
        ['browserZoomFactor', stgg({ kind: 'number' })],
        // Stage.vsyncEnabled (AIR): whether the player synchronizes frame
        // presentation to the display's vertical refresh. Application-wide like
        // frameRate (one clock for the whole app), backed by the generated
        // ASC_app_vsync_enabled; default true, exactly as adl 51.4.1 reports.
        ['vsyncEnabled', stgg({ kind: 'bool' })],
        ['stage3Ds', stgg({ kind: 'vector', elem: { kind: 'object', className: 'Stage3D' } })],
        // Stage.focus: the InteractiveObject that currently has the keyboard focus,
        // or null. Backed by the generated as_focus_obj rather than a struct field,
        // because a focus change also dispatches FocusEvent.FOCUS_OUT/FOCUS_IN.
        ['focus', stgg({ kind: 'object', className: 'InteractiveObject' })],
      ]),
      setters: new Map([
        ['stageWidth', stgs('int')],
        ['stageHeight', stgs('int')],
        ['displayState', stgs('String')],
        ['quality', stgs('String')],
        ['color', stgs('uint')],
        ['align', stgs('String')],
        ['scaleMode', stgs('String')],
        ['frameRate', stgs('Number')],
        ['stageFocusRect', stgs('Boolean')],
        ['showDefaultContextMenu', stgs('Boolean')],
        ['tabChildren', stgs('Boolean')],
        ['vsyncEnabled', stgs('Boolean')],
        ['focus', stgs('InteractiveObject')],
      ]),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // flash.display.Screen (stage 89·71): read-only display enumeration. AIR hands
    // out a FRESH wrapper on every access — measured on adl 51.4.1,
    // `Screen.mainScreen === Screen.mainScreen` is false and
    // `Screen.screens[0] === Screen.mainScreen` is false — so both static getters
    // allocate. `bounds` (full display rectangle) and `visibleBounds` (usable area,
    // menu bar and Dock excluded) are two DIFFERENT quantities on the same display,
    // which is why they are separate queries rather than one size. The Rectangle a
    // getter returns is the Screen's own live object, not a copy: mutating the value
    // read from `s.bounds` is visible on the next `s.bounds` (also measured), so the
    // runtime caches one Rectangle per Screen instead of rebuilding it per call.
    // Screen has no public constructor: `new Screen()` throws Error #2012 in AIR.
    {
      const scrg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Screen', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const scrgstatic = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Screen', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false });
      this.classMap.set('Screen', {
        fields: new Map(),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map([
          // AIR's shape is a static method taking ONE Rectangle — there is no
          // `getScreens()` (mxmlc rejects it as undefined).
          ['getScreensForRectangle', { returnType: { kind: 'array' }, params: [
            { name: 'rect', type: 'Rectangle', defaultValue: null, isRest: false },
          ], owner: 'Screen', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ]),
        getters: new Map([
          ['bounds', scrg({ kind: 'object', className: 'Rectangle' })],
          ['visibleBounds', scrg({ kind: 'object', className: 'Rectangle' })],
          ['colorDepth', scrg({ kind: 'int' })],
        ]),
        staticGetters: new Map([
          ['mainScreen', scrgstatic({ kind: 'object', className: 'Screen' })],
          ['screens', scrgstatic({ kind: 'array' })],
        ]),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // ---- flash.display.NativeWindow family (阶段八十九·七十一) ----
    // AIR's multi-window API. Every default and constant below was read off
    // adl 51.4.1 (temp/nw-probe/), not guessed: the init-option defaults are
    // standard/normal/auto/transparent=false/maximizable=true/minimizable=true/
    // resizable=true/owner=null, and NativeWindowResize.NONE really is the EMPTY
    // STRING (the other members are the same "T"/"BR" codes StageAlign uses).
    // The token classes (NativeWindowType etc.) are registered with the other
    // const classes further down, where constClass() is defined.
    {
      // The per-window AS3 state lives in the generated C's ASC_wins[] table,
      // indexed by the glue window id stored in the object's single `_win` slot
      // (a plain int, so no props-table/GC entry is needed for it). Everything
      // else about a window is a query into that table.
      const nwField = (owner: string, t: CType, init: Expr | null): FieldInfo => ({ type: t, init, visibility: 'public', owner, isStatic: false, isConst: false });
      const nwMethod = (owner: string, ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      const nwGet = (owner: string, ret: CType): MethodInfo => ({ returnType: ret, params: [], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const nwSet = (owner: string, pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });

      // NativeWindowInitOptions: a plain data bag whose defaults are the adl ones.
      const opt = (t: CType, init: Expr): FieldInfo => nwField('NativeWindowInitOptions', t, init);
      this.classMap.set('NativeWindowInitOptions', {
        fields: new Map<string, FieldInfo>([
          ['systemChrome', opt({ kind: 'string' }, { kind: 'Str', value: 'standard' })],
          ['type', opt({ kind: 'string' }, { kind: 'Str', value: 'normal' })],
          ['renderMode', opt({ kind: 'string' }, { kind: 'Str', value: 'auto' })],
          ['transparent', opt({ kind: 'bool' }, { kind: 'Bool', value: false })],
          ['maximizable', opt({ kind: 'bool' }, { kind: 'Bool', value: true })],
          ['minimizable', opt({ kind: 'bool' }, { kind: 'Bool', value: true })],
          ['resizable', opt({ kind: 'bool' }, { kind: 'Bool', value: true })],
          ['owner', opt({ kind: 'object', className: 'NativeWindow' }, { kind: 'Null' })],
        ]),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });

      this.classMap.set('NativeWindow', {
        fields: new Map<string, FieldInfo>(),
        methods: new Map<string, MethodInfo>([
          // close() only REQUESTS teardown; the window is retired at the next
          // frame boundary, which is why `closed` is still false for the rest of
          // the call that invoked it (measured against adl).
          ['close', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['activate', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['minimize', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['maximize', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['restore', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['orderToFront', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['orderToBack', nwMethod('NativeWindow', { kind: 'void' }, [])],
          ['toString', nwMethod('NativeWindow', { kind: 'string' }, [])],
        ]),
        staticFields: new Map<string, FieldInfo>([
          ['isSupported', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'NativeWindow', isStatic: true, isConst: true }],
          ['supportsTransparency', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'NativeWindow', isStatic: true, isConst: true }],
          ['supportsMenu', { type: { kind: 'bool' }, init: { kind: 'Bool', value: false }, visibility: 'public', owner: 'NativeWindow', isStatic: true, isConst: true }],
          ['supportsNotification', { type: { kind: 'bool' }, init: { kind: 'Bool', value: false }, visibility: 'public', owner: 'NativeWindow', isStatic: true, isConst: true }],
        ]),
        staticMethods: new Map(),
        getters: new Map<string, MethodInfo>([
          ['stage', nwGet('NativeWindow', { kind: 'object', className: 'Stage' })],
          ['bounds', nwGet('NativeWindow', { kind: 'object', className: 'Rectangle' })],
          ['x', nwGet('NativeWindow', { kind: 'number' })],
          ['y', nwGet('NativeWindow', { kind: 'number' })],
          ['width', nwGet('NativeWindow', { kind: 'number' })],
          ['height', nwGet('NativeWindow', { kind: 'number' })],
          ['title', nwGet('NativeWindow', { kind: 'string' })],
          ['visible', nwGet('NativeWindow', { kind: 'bool' })],
          ['closed', nwGet('NativeWindow', { kind: 'bool' })],
          ['active', nwGet('NativeWindow', { kind: 'bool' })],
          ['displayState', nwGet('NativeWindow', { kind: 'string' })],
          ['alwaysInFront', nwGet('NativeWindow', { kind: 'bool' })],
          ['resizable', nwGet('NativeWindow', { kind: 'bool' })],
          ['maximizable', nwGet('NativeWindow', { kind: 'bool' })],
          ['minimizable', nwGet('NativeWindow', { kind: 'bool' })],
          ['systemChrome', nwGet('NativeWindow', { kind: 'string' })],
          ['type', nwGet('NativeWindow', { kind: 'string' })],
          ['renderMode', nwGet('NativeWindow', { kind: 'string' })],
          ['transparent', nwGet('NativeWindow', { kind: 'bool' })],
          ['owner', nwGet('NativeWindow', { kind: 'object', className: 'NativeWindow' })],
        ]),
        setters: new Map<string, MethodInfo>([
          // x/y/width/height write straight through to bounds (measured: setting
          // x=100 moved bounds.x to 100 and left y/width/height alone).
          ['bounds', nwSet('NativeWindow', 'Rectangle')],
          ['x', nwSet('NativeWindow', 'Number')],
          ['y', nwSet('NativeWindow', 'Number')],
          ['width', nwSet('NativeWindow', 'Number')],
          ['height', nwSet('NativeWindow', 'Number')],
          ['title', nwSet('NativeWindow', 'String')],
          ['visible', nwSet('NativeWindow', 'Boolean')],
          ['displayState', nwSet('NativeWindow', 'String')],
          ['alwaysInFront', nwSet('NativeWindow', 'Boolean')],
        ]),
        constructor: { params: [{ name: 'options', type: 'NativeWindowInitOptions', defaultValue: null, isRest: false }] },
        // AIR: flash.display.NativeWindow extends EventDispatcher (it dispatches
        // Event.CLOSE / ACTIVATE / DEACTIVATE). This is not cosmetic: the
        // superclass fixes the STRUCT layout. With Object as the super, the
        // generated struct was { vtable; int _win; } and EventDispatcher's
        // listeners/parent fields were absent — so dispatchEvent() read the
        // pointer at offset 8 (which was really `_win`, an int) as a listener
        // table and read `parent` at offset 16, past the end of the 16-byte
        // allocation. Closing a NativeWindow therefore crashed with SIGSEGV.
        superClass: 'EventDispatcher',
        isFinal: false,
        implements: [],
        isDynamic: false,
      });
    }

    // Sprite is a drawable container. Its Graphics is stored PRIVATE and handed
    // out by the public `graphics` getter, which creates it on first use: AIR
    // semantics (never null) at the cost of one NULL pointer per untouched
    // container (a Starling-scale tree allocates thousands of Sprites). Letting
    // the accessor be a getter instead of a slot also keeps `s.graphics` working
    // through the inherited member lookup, and Shape keeps its eager field.
    this.classMap.set('Sprite', {
      fields: new Map([
        ['_graphics', { type: { kind: 'object', className: 'Graphics' }, init: null, visibility: 'private', owner: 'Sprite', isStatic: false, isConst: false }],
      ]),
      // hitTestPoint lives on DisplayObject (AIR's owner); Sprite keeps only the
      // lazy `graphics` accessor of its own.
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['graphics', { returnType: { kind: 'object', className: 'Graphics' }, params: [], owner: 'Sprite', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // flash.display additions (stage 62): MovieClip / SimpleButton / Loader / LoaderInfo.
    //
    // MovieClip: a frame timeline. currentFrame/totalFrames are the timeline
    // position/length; play/stop/gotoAndPlay/gotoAndStop drive an internal
    // `playing` flag. Playing clips are advanced one frame per frame tick by the
    // runtime's as_mc_* pool (see runtime.ts), wrapping currentFrame back to 1
    // when it passes totalFrames. There is no symbol-timeline system in this
    // subset, so `totalFrames` is writable (default 1) to let examples model a
    // multi-frame clip — a documented deviation from AIR's read-only totalFrames.
    const mcf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'MovieClip', isStatic: false, isConst: false });
    const mcm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const mcg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const mcs = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'MovieClip', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('MovieClip', {
      fields: new Map([
        ['currentFrame', mcf({ kind: 'int' })],
        ['totalFrames', mcf({ kind: 'int' })],
        // Private: AIR's MovieClip exposes `isPlaying`, not `playing` (measured on
        // adl 51.4.1, temp/tlprobe), so the flag must not be a readable field.
        ['_playing', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'MovieClip', isStatic: false, isConst: false }],
        // The baked SWC timeline this clip runs, as a character id: 0 = none (a
        // hand-made `new MovieClip()`, which keeps the frameless behaviour). It is
        // an int, not a function pointer, because every timeline entry point is an
        // emitted `as_swc_tl_*(int charId, ...)` switch over the baked characters.
        ['_tl_char', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'MovieClip', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['play', mcm({ kind: 'void' }, [])],
        ['stop', mcm({ kind: 'void' }, [])],
        // AIR's signatures take `frame:Object` because a FrameLabel name is just as
        // valid as a frame number: `gotoAndStop("_over")` is the whole point of the
        // rollover skins in this library (measured, temp/tlprobe).
        ['gotoAndPlay', mcm({ kind: 'void' }, [{ name: 'frame', type: 'any', defaultValue: null, isRest: false }])],
        ['gotoAndStop', mcm({ kind: 'void' }, [{ name: 'frame', type: 'any', defaultValue: null, isRest: false }])],
        ['nextFrame', mcm({ kind: 'void' }, [])],
        ['prevFrame', mcm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['currentFrame', mcg({ kind: 'int' })],
        ['totalFrames', mcg({ kind: 'int' })],
        ['isPlaying', mcg({ kind: 'bool' })],
        ['currentLabel', mcg({ kind: 'string' })],
        ['currentFrameLabel', mcg({ kind: 'string' })],
        ['currentLabels', mcg({ kind: 'array' })],
      ]),
      setters: new Map([
        ['totalFrames', mcs('int')],
      ]),
      constructor: { params: [] },
      superClass: 'Sprite',
      isDynamic: true,
      isFinal: false,
      implements: [],
    });
    // FrameLabel: the `name`/`frame` pair AIR hands back from
    // `MovieClip.currentLabels` (measured, temp/tlprobe: `currentLabels[i].name` /
    // `.frame`). AIR does not expose a public constructor for it, but the class is
    // created on demand by the getter, so a plain two-field class is enough.
    this.classMap.set('FrameLabel', {
      fields: new Map([
        ['name', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'FrameLabel', isStatic: false, isConst: false }],
        ['frame', { type: { kind: 'int' }, init: null, visibility: 'public', owner: 'FrameLabel', isStatic: false, isConst: false }],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [{ name: 'name', type: 'String', defaultValue: null, isRest: false }, { name: 'frame', type: 'int', defaultValue: null, isRest: false }] },
      superClass: 'Object',
      isDynamic: false,
      isFinal: false,
      implements: [],
    });
    // SimpleButton: an InteractiveObject whose visual is four DisplayObject state
    // references (upState/overState/downState/hitTestState). Visual state switching
    // on mouse events is deferred; the class models the state bundle and is
    // hit-tested via its own bounds (as_pick_hit treats non-containers as leaves).
    const sbf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'SimpleButton', isStatic: false, isConst: false });
    this.classMap.set('SimpleButton', {
      fields: new Map([
        ['upState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['overState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['downState', sbf({ kind: 'object', className: 'DisplayObject' })],
        ['hitTestState', sbf({ kind: 'object', className: 'DisplayObject' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'upState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'overState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'downState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'hitTestState', type: 'DisplayObject', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // LoaderInfo: load metadata + event constants. bytesLoaded/bytesTotal/url are
    // plain fields; COMPLETE/INIT/OPEN/UNLOAD mirror Event, PROGRESS/IO_ERROR mirror
    // ProgressEvent/IOErrorEvent (same string values).
    const lif = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'LoaderInfo', isStatic: false, isConst: false });
    const lig = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'LoaderInfo', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const lic = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    this.classMap.set('LoaderInfo', {
      fields: new Map([
        ['bytesLoaded', lif({ kind: 'uint' })],
        ['bytesTotal', lif({ kind: 'uint' })],
        ['url', lif({ kind: 'string' })],
        // Back-reference to the owning Loader (AS3 LoaderInfo.loader). Set by
        // Loader_ctor; NULL when the LoaderInfo is constructed standalone. Stored
        // as a field (not a getter) so e.currentTarget.loader's dynamic access
        // (as_dyn_get) finds it in the props reflection table.
        ['loader', lif({ kind: 'object', className: 'Loader' })],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['COMPLETE', lic('LoaderInfo', 'complete')],
        ['INIT', lic('LoaderInfo', 'init')],
        ['OPEN', lic('LoaderInfo', 'open')],
        ['UNLOAD', lic('LoaderInfo', 'unload')],
        ['PROGRESS', lic('LoaderInfo', 'progress')],
        ['IO_ERROR', lic('LoaderInfo', 'ioError')],
      ]),
      staticMethods: new Map(),
      getters: new Map([
        // AS3 LoaderInfo.content returns the loaded content (a DisplayObject — for
        // image loads, a Bitmap). The content is stored on the owning Loader and
        // reached via the back-reference set in Loader_ctor.
        ['content', lig({ kind: 'object', className: 'DisplayObject' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // Loader: a DisplayObjectContainer that holds loaded content. load(url) is a
    // synchronous simulation: it builds a LoaderInfo, records the URL, and dispatches
    // INIT then COMPLETE. Real asynchronous loading (URLRequest/URLLoader) is stage 63.
    const ldf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Loader', isStatic: false, isConst: false });
    const ldg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    this.classMap.set('Loader', {
      fields: new Map([
        ['content', ldf({ kind: 'object', className: 'DisplayObject' })],
        ['contentLoaderInfo', ldf({ kind: 'object', className: 'LoaderInfo' })],
      ]),
      methods: new Map([
        ['load', { returnType: { kind: 'void' }, params: [{ name: 'request', type: 'URLRequest', defaultValue: null, isRest: false }], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['loadBytes', { returnType: { kind: 'void' }, params: [{ name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false }, { name: 'context', type: 'LoaderContext', defaultValue: { kind: 'Null' }, isRest: false }], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['unload', { returnType: { kind: 'void' }, params: [], owner: 'Loader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['content', ldg({ kind: 'object', className: 'DisplayObject' })],
        ['contentLoaderInfo', ldg({ kind: 'object', className: 'LoaderInfo' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObjectContainer',
      isFinal: false,
      implements: [],
    });
    // flash.media (阶段九十六): Sound / SoundChannel / SoundTransform /
    // SoundMixer / SoundLoaderContext / ID3Info / AudioPlaybackMode.
    // Stage 93 left five compiling stubs (play() returned a silent channel); this
    // is the real surface backed by vendor/audio_glue.c through the as_audio_*
    // seam. AIR 51.4.1 measurements are in docs/zh-cn/audio.md §13; the numbers
    // quoted below are from temp/audioprobe (adl1/2/3.txt).
    //
    // Storage shape, measured rather than guessed:
    //   * SoundTransform stores the four channel gains and derives `pan` from
    //     them: pan = 1 - leftToLeft*leftToLeft when both cross terms are 0,
    //     else 0 (setting any gain directly drops the pan shorthand). That is
    //     why AIR reports `new SoundTransform(0.5, 0.25).pan` as
    //     0.2500000000000001 and not 0.25 -- the drift is the derivation.
    //   * A SoundChannel's transform holds the gains the MIXER uses, which AIR
    //     quantizes to 2 decimals (play(0,0,new SoundTransform(1,0.6)) reads
    //     back leftToLeft = 0.63, not 0.6324555320336759).
    //   * soundTransform getters return a fresh object each call (measured:
    //     `c.soundTransform == c.soundTransform` is false).
    const stGain = (owner: string, name: string): [string, FieldInfo] => [name, { type: { kind: 'number' }, init: null, visibility: 'private', owner, isStatic: false, isConst: false }];
    const stG = (ret: CType, name: string): [string, MethodInfo] => [name, { returnType: ret, params: [], owner: 'SoundTransform', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }];
    const stS = (name: string, pt: ASType): [string, MethodInfo] => [name, { returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'SoundTransform', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }];
    const numT: CType = { kind: 'number' };
    this.classMap.set('SoundTransform', {
      fields: new Map([
        stGain('SoundTransform', '_st_volume'),
        stGain('SoundTransform', '_st_ltl'),
        stGain('SoundTransform', '_st_ltr'),
        stGain('SoundTransform', '_st_rtl'),
        stGain('SoundTransform', '_st_rtr'),
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        stG(numT, 'volume'), stG(numT, 'pan'), stG(numT, 'leftToLeft'),
        stG(numT, 'leftToRight'), stG(numT, 'rightToLeft'), stG(numT, 'rightToRight'),
      ]),
      setters: new Map([
        stS('volume', 'Number'), stS('pan', 'Number'), stS('leftToLeft', 'Number'),
        stS('leftToRight', 'Number'), stS('rightToLeft', 'Number'), stS('rightToRight', 'Number'),
      ]),
      constructor: { params: [
        { name: 'volume', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: false }, isRest: false },
        { name: 'pan', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    const sndm = (ret: CType, params: Param[] = []): MethodInfo => ({ returnType: ret, params, owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const sndF = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'private', owner: 'Sound', isStatic: false, isConst: false });
    const sndG = (name: string, ret: CType): [string, MethodInfo] => [name, { returnType: ret, params: [], owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }];
    this.classMap.set('Sound', {
      fields: new Map<string, FieldInfo>([
        ['_snd_buf', sndF({ kind: 'int' })],      // backend buffer id, -1 = no data
        ['_snd_bytesTotal', sndF({ kind: 'uint' })],
        ['_snd_bytesLoaded', sndF({ kind: 'uint' })],
        ['_snd_url', sndF({ kind: 'string' })],
        // The URL the caller asked for, kept only to fill _snd_url for a local
        // read (an HTTP transfer records its own final/redirected URL). Measured:
        // adl's url is "the final, absolute URL" and becomes non-null with the
        // open event.
        ['_snd_requrl', sndF({ kind: 'string' })],
        ['_snd_id3', sndF({ kind: 'object', className: 'ID3Info' })],
        ['_snd_buffering', sndF({ kind: 'bool' })],
        ['_snd_inaccessible', sndF({ kind: 'bool' })],
        // extract()'s cursor: its default startPosition=-1 means "continue where
        // the last extract() stopped" (language reference), so the Sound carries
        // the position. Counted in samples, like length/startPosition.
        ['_snd_xpos', sndF({ kind: 'int' })],
      ]),
      methods: new Map([
        ['play', sndm({ kind: 'object', className: 'SoundChannel' }, [
          { name: 'startTime', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
          { name: 'loops', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'sndTransform', type: 'SoundTransform', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
        ['close', sndm({ kind: 'void' })],
        ['load', sndm({ kind: 'void' }, [
          { name: 'stream', type: 'URLRequest', defaultValue: null, isRest: false },
          { name: 'context', type: 'SoundLoaderContext', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
        ['loadCompressedDataFromByteArray', sndm({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'length', type: 'uint', defaultValue: null, isRest: false },
        ])],
        ['loadPCMFromByteArray', sndm({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'samples', type: 'uint', defaultValue: null, isRest: false },
          { name: 'format', type: 'String', defaultValue: { kind: 'Str', value: 'float' }, isRest: false },
          { name: 'stereo', type: 'Boolean', defaultValue: { kind: 'Bool', value: true }, isRest: false },
          { name: 'sampleRate', type: 'Number', defaultValue: { kind: 'Num', value: 44100, isInt: false }, isRest: false },
        ])],
        ['extract', sndm(numT, [
          { name: 'target', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'length', type: 'Number', defaultValue: null, isRest: false },
          { name: 'startPosition', type: 'Number', defaultValue: { kind: 'Num', value: -1, isInt: false }, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map<string, MethodInfo>([
        sndG('length', numT),
        ['isBuffering', { returnType: { kind: 'bool' }, params: [], owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['bytesTotal', { returnType: { kind: 'uint' }, params: [], owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['bytesLoaded', { returnType: { kind: 'uint' }, params: [], owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        sndG('url', { kind: 'string' }),
        sndG('id3', { kind: 'object', className: 'ID3Info' }),
        ['isURLInaccessible', { returnType: { kind: 'bool' }, params: [], owner: 'Sound', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [
        // AIR's Sound(stream, context) constructor LOADS the stream when one is
        // given ("If you pass a valid URLRequest object to the Sound constructor,
        // the constructor automatically calls the load() function"); measured on
        // adl: new Sound(new URLRequest(badPath)) dispatches ioError by itself.
        { name: 'stream', type: 'URLRequest', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'context', type: 'SoundLoaderContext', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    const sctm = (ret: CType, params: Param[] = []): MethodInfo => ({ returnType: ret, params, owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const schF = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'private', owner: 'SoundChannel', isStatic: false, isConst: false });
    this.classMap.set('SoundChannel', {
      fields: new Map<string, FieldInfo>([
        // Backend voice id; -1 once the channel has stopped, is finished, or was
        // replaced by SoundMixer.stopAll(). The five gains are what AIR's mixer
        // holds (quantized to 2 decimals), not the SoundTransform object passed
        // to play(): the getter rebuilds a fresh object from them.
        ['_ch_voice', schF({ kind: 'int' })],
        ['_ch_pos', schF({ kind: 'number' })],
        ['_ch_vol', schF({ kind: 'number' })],
        ['_ch_ltl', schF({ kind: 'number' })],
        ['_ch_ltr', schF({ kind: 'number' })],
        ['_ch_rtl', schF({ kind: 'number' })],
        ['_ch_rtr', schF({ kind: 'number' })],
      ]),
      methods: new Map([
        ['stop', sctm({ kind: 'void' })],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map<string, MethodInfo>([
        ['position', { returnType: numT, params: [], owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['leftPeak', { returnType: numT, params: [], owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['rightPeak', { returnType: numT, params: [], owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['soundTransform', { returnType: { kind: 'object', className: 'SoundTransform' }, params: [], owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map<string, MethodInfo>([
        ['soundTransform', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'SoundTransform', defaultValue: null, isRest: false }], owner: 'SoundChannel', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
      ]),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // SoundMixer: all-static facade over the process-wide mixer. bufferTime and
    // audioPlaybackMode are plain writable statics (AIR defaults 5 and "media",
    // measured); the transform is the same derived-gain shape as a channel's.
    const smG = (name: string, ret: CType): [string, MethodInfo] => [name, { returnType: ret, params: [], owner: 'SoundMixer', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false }];
    this.classMap.set('SoundMixer', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map<string, FieldInfo>([
        ['bufferTime', { type: { kind: 'int' }, init: { kind: 'Num', value: 5, isInt: true }, visibility: 'public', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['audioPlaybackMode', { type: { kind: 'string' }, init: { kind: 'Str', value: 'media' }, visibility: 'public', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['_mix_vol', { type: numT, init: { kind: 'Num', value: 1, isInt: false }, visibility: 'private', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['_mix_ltl', { type: numT, init: { kind: 'Num', value: 1, isInt: false }, visibility: 'private', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['_mix_ltr', { type: numT, init: { kind: 'Num', value: 0, isInt: false }, visibility: 'private', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['_mix_rtl', { type: numT, init: { kind: 'Num', value: 0, isInt: false }, visibility: 'private', owner: 'SoundMixer', isStatic: true, isConst: false }],
        ['_mix_rtr', { type: numT, init: { kind: 'Num', value: 1, isInt: false }, visibility: 'private', owner: 'SoundMixer', isStatic: true, isConst: false }],
      ]),
      staticMethods: new Map([
        ['stopAll', { returnType: { kind: 'void' }, params: [], owner: 'SoundMixer', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ['computeSpectrum', { returnType: { kind: 'void' }, params: [
          { name: 'outputArray', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'FFTMode', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'stretchFactor', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ], owner: 'SoundMixer', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ['areSoundsInaccessible', { returnType: { kind: 'bool' }, params: [], owner: 'SoundMixer', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      staticGetters: new Map<string, MethodInfo>([
        smG('soundTransform', { kind: 'object', className: 'SoundTransform' }),
      ]),
      staticSetters: new Map<string, MethodInfo>([
        ['soundTransform', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'SoundTransform', defaultValue: null, isRest: false }], owner: 'SoundMixer', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: true }],
      ]),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('SoundLoaderContext', {
      fields: new Map<string, FieldInfo>([
        ['bufferTime', { type: numT, init: null, visibility: 'public', owner: 'SoundLoaderContext', isStatic: false, isConst: false }],
        ['checkPolicyFile', { type: { kind: 'bool' }, init: null, visibility: 'public', owner: 'SoundLoaderContext', isStatic: false, isConst: false }],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'bufferTime', type: 'Number', defaultValue: { kind: 'Num', value: 1000, isInt: false }, isRest: false },
        { name: 'checkPolicyFile', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // ID3Info: AIR always exposes an object (Sound.id3 is never null, measured)
    // whose fields stay null until an ID3v2 tag is present.
    const id3f = (): FieldInfo => ({ type: { kind: 'string' }, init: null, visibility: 'public', owner: 'ID3Info', isStatic: false, isConst: false });
    this.classMap.set('ID3Info', {
      fields: new Map<string, FieldInfo>([
        ['songName', id3f()], ['artist', id3f()], ['album', id3f()], ['genre', id3f()],
        ['track', id3f()], ['year', id3f()], ['comment', id3f()],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // AudioPlaybackMode: the two String constants AIR exposes for
    // SoundMixer.audioPlaybackMode (the class itself is only a holder).
    this.classMap.set('AudioPlaybackMode', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map<string, FieldInfo>([
        ['MEDIA', stMatch('AudioPlaybackMode', 'media')],
        ['VOICE', stMatch('AudioPlaybackMode', 'voice')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    function stMatch(owner: string, value: string): FieldInfo {
      return { type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true };
    }
    // flash.media.Camera: Starling's Texture.fromCamera / ConcreteTexture.attachCamera
    // reference it as a type (and Camera.getCamera() as a factory). No camera backend
    // in this subset — the object exists so those signatures compile; getCamera is a
    // no-op returning NULL (the demo never triggers the camera path).
    this.classMap.set('Camera', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map([
        ['getCamera', { returnType: { kind: 'object', className: 'Camera' }, params: [{ name: 'name', type: 'String', defaultValue: { kind: 'Null' }, isRest: false }], owner: 'Camera', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.system (stage 93): LoaderContext / ImageDecodingPolicy. Starling
    // passes a LoaderContext to Loader.loadBytes to request on-load decoding;
    // these are modeled as a plain value bundle + string constants (no actual
    // policy engine — the demo only reads/writes the fields).
    const lcf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'LoaderContext', isStatic: false, isConst: false });
    this.classMap.set('LoaderContext', {
      fields: new Map([
        ['checkPolicyFile', lcf({ kind: 'bool' })],
        ['imageDecodingPolicy', lcf({ kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'checkPolicyFile', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ImageDecodingPolicy', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['ON_LOAD', { type: { kind: 'string' }, init: { kind: 'Str', value: 'onLoad' }, visibility: 'public', owner: 'ImageDecodingPolicy', isStatic: true, isConst: true }],
        ['ON_DEMAND', { type: { kind: 'string' }, init: { kind: 'Str', value: 'onDemand' }, visibility: 'public', owner: 'ImageDecodingPolicy', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.net / flash.ui (stage 63, extended in stage 89·48): URLRequest /
    // URLLoader / Keyboard / Mouse.
    //
    // URLRequest is "all of the information in a single HTTP request" (AIR). The
    // stage-63 subset declared only url/method/data/contentType and treated
    // method/data/contentType as write-only decorations; stage 89·48 declares the
    // FULL documented property surface so the values are real instance state (and
    // so a later HTTP client has something to read).
    //
    // Defaults are the adl-measured ones: method = "GET", contentType = NULL, and
    // data = NULL. contentType is the trap -- the AS3 reference lists its default
    // as "application/x-www-form-urlencoded", but that string describes what adl
    // sends on the WIRE for a body-carrying request, not what the getter returns
    // (a local capture server, adl 51.3.4: POST with an unset contentType goes out
    // application/x-www-form-urlencoded while `req.contentType` reads NULL; a POST
    // with no body sends no Content-Type at all). requestHeaders = an empty Array
    // (Adobe's own example calls `request.requestHeaders.push(header)` on a fresh
    // object), and the six properties that URLRequestDefaults mirrors are
    // "initialized from the URLRequestDefaults.<name> property" per the official
    // docs (they default to that class's defaults, so the observable result is the
    // AIR one unless the app changes the defaults). data is `any` (boxed as_value).
    const rqf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLRequest', isStatic: false, isConst: false });
    const rqm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'URLRequest', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('URLRequest', {
      fields: new Map([
        ['url', rqf({ kind: 'string' })],
        ['method', rqf({ kind: 'string' })],
        ['data', rqf({ kind: 'any' })],
        ['contentType', rqf({ kind: 'string' })],
        // AIR-only properties (application security sandbox).
        ['requestHeaders', rqf({ kind: 'array' })],
        ['authenticate', rqf({ kind: 'bool' })],
        ['cacheResponse', rqf({ kind: 'bool' })],
        ['followRedirects', rqf({ kind: 'bool' })],
        ['idleTimeout', rqf({ kind: 'number' })],
        ['manageCookies', rqf({ kind: 'bool' })],
        ['useCache', rqf({ kind: 'bool' })],
        ['userAgent', rqf({ kind: 'string' })],
        // SWZ digest for the Flash Player cache; kept as inert state (this runtime
        // has no signed-file cache and does not implement SWZ loading).
        ['digest', rqf({ kind: 'string' })],
      ]),
      methods: new Map([
        // AIR 3.8. `pattern` is `*` because AIR accepts a String or a RegExp.
        ['useRedirectedURL', rqm({ kind: 'void' }, [
          { name: 'sourceRequest', type: 'URLRequest', defaultValue: null, isRest: false },
          { name: 'wholeURL', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'pattern', type: 'any', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'replace', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'url', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // URLLoader: an EventDispatcher that asynchronously reads a local file (the
    // URL treated as a filesystem path) and dispatches COMPLETE (or IO_ERROR on
    // failure). data is the file text; dataFormat defaults to "text". Real async
    // HTTP/Socket loading is deferred (see docs/zh-cn/flash-net.md).
    //
    // Stage 89·48 completes the documented contract around that local read:
    //   * bytesLoaded/bytesTotal exist (0 = "in progress", populated at complete);
    //   * the constructor takes an optional URLRequest and begins the load
    //     immediately when one is given (AIR: "If specified, the load operation
    //     begins immediately");
    //   * dataFormat = VARIABLES decodes the payload into a URLVariables object.
    const ulf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLLoader', isStatic: false, isConst: false });
    const ulm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'URLLoader', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('URLLoader', {
      fields: new Map([
        ['data', ulf({ kind: 'any' })],
        ['dataFormat', ulf({ kind: 'string' })],
        ['bytesLoaded', ulf({ kind: 'uint' })],
        ['bytesTotal', ulf({ kind: 'uint' })],
      ]),
      methods: new Map([
        ['load', ulm({ kind: 'void' }, [{ name: 'request', type: 'URLRequest', defaultValue: null, isRest: false }])],
        ['close', ulm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'request', type: 'URLRequest', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // URLStream: the streaming counterpart of URLLoader (IDataInput read side).
    // `endian`/`objectEncoding` are the interface's read-write properties, kept as
    // plain fields marked `isAccessor` (AIR declares them `get`/`set` pairs; a
    // field is the C model of the same slot — the convention DisplayObject.x
    // uses, and what pass 4 accepts for a built-in accessor).
    // `bytesAvailable`/`connected` are read-only and go through getters (the
    // latter is URLStream's own; `bytesAvailable` is IDataInput's).
    const usf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLStream', isStatic: false, isConst: false });
    const usm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'URLStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const usg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'URLStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const u_byte = (ret: CType): MethodInfo => usm(ret, []);
    const u_len = (name: string): Param => ({ name, type: 'uint', defaultValue: null, isRest: false });
    this.classMap.set('URLStream', {
      fields: new Map([
        ['endian', { ...usf({ kind: 'string' }), isAccessor: true }],
        ['objectEncoding', { ...usf({ kind: 'uint' }), isAccessor: true }],
      ]),
      methods: new Map([
        ['load', usm({ kind: 'void' }, [{ name: 'request', type: 'URLRequest', defaultValue: null, isRest: false }])],
        ['close', usm({ kind: 'void' }, [])],
        ['readBoolean', u_byte({ kind: 'bool' })],
        ['readByte', u_byte({ kind: 'int' })],
        ['readUnsignedByte', u_byte({ kind: 'uint' })],
        ['readShort', u_byte({ kind: 'int' })],
        ['readUnsignedShort', u_byte({ kind: 'uint' })],
        ['readInt', u_byte({ kind: 'int' })],
        ['readUnsignedInt', u_byte({ kind: 'uint' })],
        ['readFloat', u_byte({ kind: 'number' })],
        ['readDouble', u_byte({ kind: 'number' })],
        ['readUTF', u_byte({ kind: 'string' })],
        ['readUTFBytes', usm({ kind: 'string' }, [u_len('length')])],
        ['readMultiByte', usm({ kind: 'string' }, [u_len('length'), { name: 'charSet', type: 'String', defaultValue: null, isRest: false }])],
        ['readObject', usm({ kind: 'any' }, [])],
        ['readBytes', usm({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'offset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'length', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bytesAvailable', usg({ kind: 'uint' })],
        ['connected', usg({ kind: 'bool' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: ['IDataInput'],
    });
    // flash.utils.IDataInput / IDataOutput (AIR): the two byte-stream interfaces
    // (measured on the installed SDK: airglobal's catalog declares them as
    // `flash.utils:IDataInput`/`flash.utils:IDataOutput` — NOT flash.net, which is
    // where the paper docs used to list them; mxmlc rejects the flash.net path).
    // ByteArray and Socket implement (URLStream implements IDataInput only — it
    // is read-only). Registered by hand with AIR's FULL member list, so that a
    // user class which restates them — the real-world case being a TLSSocket
    // that `extends Socket implements IDataInput, IDataOutput` — passes the
    // pass-4 conformance check instead of being rejected for members it cannot
    // (and must not) redeclare.
    //
    // Member shapes follow the reference: `bytesAvailable` is read-only, while
    // `endian`/`objectEncoding` are read-write PROPERTIES (not methods) — which
    // is why the implementors keep them as `isAccessor` fields. pass 4 compares
    // NAME and KIND (getter/setter/method), never signatures, so an overload
    // mismatch cannot slip through this table.
    //
    // `readObject`/`writeObject` ARE in the list: ByteArray and URLStream have
    // had the AMF3 pair since stage 94-4, and Socket got one too (see
    // Socket_writeObject/Socket_readObject in emit.ts). Leaving them out would
    // make the interface laxer than AIR (accepting a class that omits them),
    // which is a silent hole; a loud "unsupported" on Socket's read side is the
    // honest alternative.
    {
      const idin = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'IDataInput', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      const iding = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'IDataInput', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const idins = (type: string): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type, defaultValue: null, isRest: false }], owner: 'IDataInput', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
      const baP = (name: string): Param => ({ name, type: 'ByteArray', defaultValue: null, isRest: false });
      const uintP = (name: string): Param => ({ name, type: 'uint', defaultValue: null, isRest: false });
      interfaceNames.add('IDataInput');
      this.interfaceMap.set('IDataInput', {
        reflectFqn: 'flash.utils::IDataInput',
        getters: new Map([
          ['bytesAvailable', iding({ kind: 'uint' })],
          ['endian', iding({ kind: 'string' })],
          ['objectEncoding', iding({ kind: 'uint' })],
        ]),
        setters: new Map([
          ['endian', idins('String')],
          ['objectEncoding', idins('uint')],
        ]),
        methods: new Map([
          ['readBoolean', idin({ kind: 'bool' }, [])],
          ['readByte', idin({ kind: 'int' }, [])],
          ['readBytes', idin({ kind: 'void' }, [baP('bytes'), uintP('offset'), uintP('length')])],
          ['readDouble', idin({ kind: 'number' }, [])],
          ['readFloat', idin({ kind: 'number' }, [])],
          ['readInt', idin({ kind: 'int' }, [])],
          ['readMultiByte', idin({ kind: 'string' }, [uintP('length'), { name: 'charSet', type: 'String', defaultValue: null, isRest: false }])],
          ['readObject', idin({ kind: 'any' }, [])],
          ['readShort', idin({ kind: 'int' }, [])],
          ['readUnsignedByte', idin({ kind: 'uint' }, [])],
          ['readUnsignedInt', idin({ kind: 'uint' }, [])],
          ['readUnsignedShort', idin({ kind: 'uint' }, [])],
          ['readUTF', idin({ kind: 'string' }, [])],
          ['readUTFBytes', idin({ kind: 'string' }, [uintP('length')])],
        ]),
      });
      const idout = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'IDataOutput', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      const idoutg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'IDataOutput', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const idouts = (type: string): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type, defaultValue: null, isRest: false }], owner: 'IDataOutput', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
      const valP = (type: string): Param => ({ name: 'value', type, defaultValue: null, isRest: false });
      interfaceNames.add('IDataOutput');
      this.interfaceMap.set('IDataOutput', {
        reflectFqn: 'flash.utils::IDataOutput',
        getters: new Map([
          ['endian', idoutg({ kind: 'string' })],
          ['objectEncoding', idoutg({ kind: 'uint' })],
        ]),
        setters: new Map([
          ['endian', idouts('String')],
          ['objectEncoding', idouts('uint')],
        ]),
        methods: new Map([
          ['writeBoolean', idout({ kind: 'void' }, [valP('Boolean')])],
          ['writeByte', idout({ kind: 'void' }, [valP('int')])],
          ['writeBytes', idout({ kind: 'void' }, [baP('bytes'), uintP('offset'), uintP('length')])],
          ['writeDouble', idout({ kind: 'void' }, [valP('Number')])],
          ['writeFloat', idout({ kind: 'void' }, [valP('Number')])],
          ['writeInt', idout({ kind: 'void' }, [valP('int')])],
          ['writeMultiByte', idout({ kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }, { name: 'charSet', type: 'String', defaultValue: null, isRest: false }])],
          ['writeObject', idout({ kind: 'void' }, [{ name: 'object', type: 'any', defaultValue: null, isRest: false }])],
          ['writeShort', idout({ kind: 'void' }, [valP('int')])],
          ['writeUnsignedInt', idout({ kind: 'void' }, [valP('uint')])],
          ['writeUTF', idout({ kind: 'void' }, [valP('String')])],
          ['writeUTFBytes', idout({ kind: 'void' }, [valP('String')])],
        ]),
      });
    }
    // ---- flash.net.Socket / ServerSocket / XMLSocket / SecureSocket (stage 89·54) ----
    //
    // The member list follows the ActionScript 3.0 reference class-for-class.
    // Socket implements IDataInput/IDataOutput, so its typed read side is the
    // same set URLStream exposes and its write side the same set ByteArray
    // exposes — a Socket that could write but not read (or vice versa) would be
    // useless for every documented echo pattern. The one deliberate gap is
    // readObject/writeObject: this subset has no AMF codec (ByteArray lacks the
    // pair too), and inventing one would be a silent semantic lie. See
    // docs/zh-cn/flash-net.md §7.
    //
    // `endian`/`objectEncoding`/`tcpNoDelay`/`timeout` are plain settable
    // properties (that is how the reference declares them), so they stay fields;
    // everything read-only is a getter, matching URIStream and the reference.
    // mef/mec/meBool are declared further down collect() and a `const` arrow is in
    // its temporal dead zone here, so the socket block spells its literals out.
    const skf = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const skc = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    const skBool = (name: string, def: boolean): Param => ({ name, type: 'Boolean', defaultValue: { kind: 'Bool', value: def }, isRest: false });
    const skm = (owner: string, ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const skg = (owner: string, ret: CType): MethodInfo => ({ returnType: ret, params: [], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const sk_byte = (owner: string, ret: CType): MethodInfo => skm(owner, ret, []);
    const sk_len = (name: string): Param => ({ name, type: 'uint', defaultValue: null, isRest: false });
    const sk_num = (name: string): Param => ({ name, type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false });
    const sk_readMethods = (owner: string): Map<string, MethodInfo> => new Map([
      ['readBoolean', sk_byte(owner, { kind: 'bool' })],
      ['readByte', sk_byte(owner, { kind: 'int' })],
      ['readUnsignedByte', sk_byte(owner, { kind: 'uint' })],
      ['readShort', sk_byte(owner, { kind: 'int' })],
      ['readUnsignedShort', sk_byte(owner, { kind: 'uint' })],
      ['readInt', sk_byte(owner, { kind: 'int' })],
      ['readUnsignedInt', sk_byte(owner, { kind: 'uint' })],
      ['readFloat', sk_byte(owner, { kind: 'number' })],
      ['readDouble', sk_byte(owner, { kind: 'number' })],
      ['readUTF', sk_byte(owner, { kind: 'string' })],
      ['readUTFBytes', skm(owner, { kind: 'string' }, [sk_len('length')])],
      ['readMultiByte', skm(owner, { kind: 'string' }, [sk_len('length'), { name: 'charSet', type: 'String', defaultValue: null, isRest: false }])],
      ['readBytes', skm(owner, { kind: 'void' }, [
        { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
        sk_num('offset'),
        sk_num('length'),
      ])],
    ]);
    this.classMap.set('Socket', {
      fields: new Map([
        // IDataInput/IDataOutput declare endian/objectEncoding as read-write
        // accessors; AIR stores them as slots here, marked `isAccessor` so pass 4
        // accepts the field as the accessor pair (DisplayObject.x convention).
        ['endian', { ...skf({ kind: 'string' }, 'Socket'), isAccessor: true }],
        ['objectEncoding', { ...skf({ kind: 'uint' }, 'Socket'), isAccessor: true }],
        ['timeout', skf({ kind: 'int' }, 'Socket')],
        ['tcpNoDelay', skf({ kind: 'bool' }, 'Socket')],
      ]),
      methods: new Map([
        ['connect', skm('Socket', { kind: 'void' }, [
          { name: 'host', type: 'String', defaultValue: null, isRest: false },
          { name: 'port', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['close', skm('Socket', { kind: 'void' }, [])],
        ['flush', skm('Socket', { kind: 'void' }, [])],
        ...sk_readMethods('Socket'),
        ['writeBoolean', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'Boolean', defaultValue: null, isRest: false }])],
        ['writeByte', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'int', defaultValue: null, isRest: false }])],
        ['writeShort', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'int', defaultValue: null, isRest: false }])],
        ['writeInt', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'int', defaultValue: null, isRest: false }])],
        ['writeUnsignedInt', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'uint', defaultValue: null, isRest: false }])],
        ['writeFloat', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'Number', defaultValue: null, isRest: false }])],
        ['writeDouble', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'Number', defaultValue: null, isRest: false }])],
        ['writeUTF', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }])],
        ['writeUTFBytes', skm('Socket', { kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }])],
        ['writeMultiByte', skm('Socket', { kind: 'void' }, [
          { name: 'value', type: 'String', defaultValue: null, isRest: false },
          { name: 'charSet', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['writeBytes', skm('Socket', { kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          sk_num('offset'),
          sk_num('length'),
        ])],
        // The AMF3 pair IDataInput/IDataOutput declare. writeObject is exact
        // (serialize, then hand the buffer to the socket's write sink).
        // readObject is the one member this subset cannot model: an AMF3 value
        // may span several packets and our socket read side consumes bytes
        // destructively (there is no push-back), so it fails loudly instead of
        // silently mis-parsing a stream — see Socket_readObject in emit.ts.
        ['writeObject', skm('Socket', { kind: 'void' }, [{ name: 'object', type: 'any', defaultValue: null, isRest: false }])],
        ['readObject', skm('Socket', { kind: 'any' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bytesAvailable', skg('Socket', { kind: 'uint' })],
        ['bytesPending', skg('Socket', { kind: 'uint' })],
        ['connected', skg('Socket', { kind: 'bool' })],
        ['localAddress', skg('Socket', { kind: 'string' })],
        ['localPort', skg('Socket', { kind: 'int' })],
        ['remoteAddress', skg('Socket', { kind: 'string' })],
        ['remotePort', skg('Socket', { kind: 'int' })],
      ]),
      setters: new Map(),
      // Socket() and Socket(host, port) are both documented, and AIR's ctor with a
      // host connects immediately. The port is required once the host is given.
      // Socket implements both byte-stream interfaces, so its members are the
      // IDataInput/IDataOutput list (see the block above).
      constructor: { params: [
        { name: 'host', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'port', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: ['IDataInput', 'IDataOutput'],
    });
    // SecureSocket: TLS on top of Socket. The TLS half is not implemented yet,
    // and the class reports that honestly (isSupported = false, connect()
    // dispatches the socket ioError) rather than falling back to a plaintext
    // connection behind the app's back.
    this.classMap.set('SecureSocket', {
      fields: new Map(),
      methods: new Map([
        ['connect', skm('SecureSocket', { kind: 'void' }, [
          { name: 'host', type: 'String', defaultValue: null, isRest: false },
          { name: 'port', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['addBinaryChainBuildingCertificate', skm('SecureSocket', { kind: 'void' }, [
          { name: 'certificate', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'trusted', type: 'Boolean', defaultValue: null, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['serverCertificateStatus', skg('SecureSocket', { kind: 'string' })],
      ]),
      setters: new Map(),
      staticGetters: new Map([
        ['isSupported', { returnType: { kind: 'bool' }, params: [], owner: 'SecureSocket', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      constructor: { params: [] },
      superClass: 'Socket',
      isFinal: false,
      implements: [],
    });
    // XMLSocket: NUL-terminated messages over the same transport. `connected` and
    // `timeout` are its only state; everything else is connect/close/send.
    this.classMap.set('XMLSocket', {
      fields: new Map([
        ['timeout', skf({ kind: 'int' }, 'XMLSocket')],
      ]),
      methods: new Map([
        ['connect', skm('XMLSocket', { kind: 'void' }, [
          { name: 'host', type: 'String', defaultValue: null, isRest: false },
          { name: 'port', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['close', skm('XMLSocket', { kind: 'void' }, [])],
        // `send(object:Object)` in the reference; the runtime accepts a String or
        // an XML value (and stringifies anything else, measured), so the slot is
        // dynamic rather than a String — a String slot would reject an XML
        // argument the reference accepts.
        ['send', skm('XMLSocket', { kind: 'void' }, [{ name: 'object', type: 'any', defaultValue: null, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['connected', skg('XMLSocket', { kind: 'bool' })],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'host', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'port', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // ServerSocket: the listening side. Its ctor takes nothing, bind() chooses the
    // address, listen() starts accepting; the reference has no accept() method —
    // a connection is delivered as ServerSocketConnectEvent.CONNECT whose `socket`
    // property is the connected Socket.
    this.classMap.set('ServerSocket', {
      fields: new Map(),
      methods: new Map([
        ['bind', skm('ServerSocket', { kind: 'void' }, [
          { name: 'localPort', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'localAddress', type: 'String', defaultValue: { kind: 'Str', value: '0.0.0.0' }, isRest: false },
        ])],
        ['listen', skm('ServerSocket', { kind: 'void' }, [
          { name: 'backlog', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
        ['close', skm('ServerSocket', { kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bound', skg('ServerSocket', { kind: 'bool' })],
        ['listening', skg('ServerSocket', { kind: 'bool' })],
        ['localAddress', skg('ServerSocket', { kind: 'string' })],
        ['localPort', skg('ServerSocket', { kind: 'int' })],
      ]),
      setters: new Map(),
      staticGetters: new Map([
        ['isSupported', { returnType: { kind: 'bool' }, params: [], owner: 'ServerSocket', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.events.ServerSocketConnectEvent / OutputProgressEvent. Both extend
    // Event; the first carries the accepted Socket, the second the socket's
    // remaining write backlog.
    this.classMap.set('ServerSocketConnectEvent', {
      fields: new Map([
        ['socket', skf({ kind: 'object', className: 'Socket' }, 'ServerSocketConnectEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['CONNECT', skc('ServerSocketConnectEvent', 'connect')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        skBool('bubbles', false),
        skBool('cancelable', false),
        { name: 'socket', type: 'Socket', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('OutputProgressEvent', {
      fields: new Map([
        ['bytesPending', skf({ kind: 'number' }, 'OutputProgressEvent')],
        ['bytesTotal', skf({ kind: 'number' }, 'OutputProgressEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['OUTPUT_PROGRESS', skc('OutputProgressEvent', 'outputProgress')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        skBool('bubbles', false),
        skBool('cancelable', false),
        { name: 'bytesPending', type: 'Number', defaultValue: { kind: 'Num', value: 0 }, isRest: false },
        { name: 'bytesTotal', type: 'Number', defaultValue: { kind: 'Num', value: 0 }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // URLRequestMethod: the six documented HTTP method constants (final class,
    // pure String holders). Without it there was no way to spell "POST" besides a
    // raw string literal — the single most misleading gap for the old dead
    // URLRequest.method field. Built inline rather than via the `constClass`
    // helper below: that helper is declared later in collect() and a `const`
    // arrow function is in its temporal dead zone here.
    const urmsf = new Map<string, FieldInfo>();
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      urmsf.set(m, { type: { kind: 'string' }, init: { kind: 'Str', value: m }, visibility: 'public', owner: 'URLRequestMethod', isStatic: true, isConst: true });
    }
    this.classMap.set('URLRequestMethod', {
      fields: new Map(), methods: new Map(), staticFields: urmsf, staticMethods: new Map(),
      getters: new Map(), setters: new Map(), constructor: { params: [] },
      superClass: 'Object', isFinal: false, implements: [],
    });
    // URLRequestHeader: one name/value HTTP request header (AIR: `public var`
    // fields, constructor defaults to ""/""). AIR's restricted-header list and the
    // cumulative length limit only apply OUTSIDE the application security sandbox,
    // which this desktop runtime is equivalent to, so no runtime check is made and
    // arbitrary headers are accepted (see docs/zh-cn/flash-net.md section 4.4).
    const urhf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'URLRequestHeader', isStatic: false, isConst: false });
    this.classMap.set('URLRequestHeader', {
      fields: new Map([
        ['name', urhf({ kind: 'string' })],
        ['value', urhf({ kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'name', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
        { name: 'value', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // URLRequestDefaults: static defaults for URLRequest properties (AIR 1.0).
    // Modeled as static getters/setters backed by C globals (the SharedObject
    // `defaultObjectEncoding` pattern) rather than static fields: a declared
    // static field with a literal initializer would be emitted as a plain C
    // initializer carrying the value, but its AS3 read would also route through
    // the lazy `<Class>_cinit()` guard — and URLRequest_ctor has to read these
    // default values reliably at (C-level) construction time. Hand-written
    // accessors keep the defaults observable with no initialization ordering.
    // `userAgent` is the one member whose setter can store a GC string, so its
    // backing global is registered as a permanent GC root (see emitGCRoots).
    // Deferred: setLoginCredentialsForHost (needs an authenticating HTTP stack).
    const urdsg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'URLRequestDefaults', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false });
    const urdss = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'URLRequestDefaults', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: true });
    const urdGet = new Map<string, MethodInfo>([
      ['authenticate', urdsg({ kind: 'bool' })],
      ['cacheResponse', urdsg({ kind: 'bool' })],
      ['followRedirects', urdsg({ kind: 'bool' })],
      ['idleTimeout', urdsg({ kind: 'number' })],
      ['manageCookies', urdsg({ kind: 'bool' })],
      ['useCache', urdsg({ kind: 'bool' })],
      ['userAgent', urdsg({ kind: 'string' })],
    ]);
    const urdSet = new Map<string, MethodInfo>([
      ['authenticate', urdss('Boolean')],
      ['cacheResponse', urdss('Boolean')],
      ['followRedirects', urdss('Boolean')],
      ['idleTimeout', urdss('Number')],
      ['manageCookies', urdss('Boolean')],
      ['useCache', urdss('Boolean')],
      ['userAgent', urdss('String')],
    ]);
    this.classMap.set('URLRequestDefaults', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      staticGetters: urdGet,
      staticSetters: urdSet,
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });

    // URLLoaderDataFormat: string constants describing URLLoader.dataFormat.
    this.classMap.set('URLLoaderDataFormat', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['TEXT', { type: { kind: 'string' }, init: { kind: 'Str', value: 'text' }, visibility: 'public', owner: 'URLLoaderDataFormat', isStatic: true, isConst: true }],
        ['BINARY', { type: { kind: 'string' }, init: { kind: 'Str', value: 'binary' }, visibility: 'public', owner: 'URLLoaderDataFormat', isStatic: true, isConst: true }],
        ['VARIABLES', { type: { kind: 'string' }, init: { kind: 'Str', value: 'variables' }, visibility: 'public', owner: 'URLLoaderDataFormat', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // URLVariables: a dynamic class (AS3 `dynamic class URLVariables extends
    // Object`). Arbitrary string-keyed properties are stored in a runtime
    // `as_object* _dyn` slot table (see the dynamic-class mechanism: isDynamic
    // + vtable dyn_offset + as_dyn_get/set fallback), and toString() serializes
    // them as a URL-encoded query string (key=value&...).
    this.classMap.set('URLVariables', {
      fields: new Map(),
      methods: new Map([
        ['toString', { returnType: { kind: 'string' }, params: [], owner: 'URLVariables', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        // URLVariables.decode(source): split a URL-encoded query string into
        // dynamic properties. The constructor already calls it for a non-null
        // argument; exposing it lets a caller re-decode into an existing instance.
        // AIR throws Error when a name/value pair is not URL-encoded; this subset
        // decodes leniently instead (documented in docs/zh-cn/flash-net.md §3.1).
        ['decode', { returnType: { kind: 'void' }, params: [{ name: 'source', type: 'String', defaultValue: null, isRest: false }], owner: 'URLVariables', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [{ name: 'source', type: 'String', defaultValue: { kind: 'Null' }, isRest: false }] },
      superClass: 'Object',
      isFinal: false,
      isDynamic: true,
      implements: [],
    });
    // Keyboard: a class of static key-code constants (uint, matching AIR's Keyboard
    // constants) plus a read-only isAccessible flag. Only a representative subset of
    // the full AIR key-code table is mapped.
    const kbd = (owner: string, value: number): FieldInfo => ({ type: { kind: 'uint' }, init: { kind: 'Num', value, isInt: true }, visibility: 'public', owner, isStatic: true, isConst: true });
    const kbdStatic: [string, number][] = [
      ['A', 65], ['B', 66], ['C', 67], ['D', 68], ['E', 69], ['F', 70], ['G', 71], ['H', 72],
      ['I', 73], ['J', 74], ['K', 75], ['L', 76], ['M', 77], ['N', 78], ['O', 79], ['P', 80],
      ['Q', 81], ['R', 82], ['S', 83], ['T', 84], ['U', 85], ['V', 86], ['W', 87], ['X', 88],
      ['Y', 89], ['Z', 90],
      ['NUMBER_0', 48], ['NUMBER_1', 49], ['NUMBER_2', 50], ['NUMBER_3', 51], ['NUMBER_4', 52],
      ['NUMBER_5', 53], ['NUMBER_6', 54], ['NUMBER_7', 55], ['NUMBER_8', 56], ['NUMBER_9', 57],
      ['SPACE', 32], ['ENTER', 13], ['TAB', 9], ['ESCAPE', 27], ['BACKSPACE', 8], ['DELETE', 46],
      ['SHIFT', 16], ['CONTROL', 17], ['LEFT', 37], ['RIGHT', 39], ['UP', 38], ['DOWN', 40],
    ];
    const kbdFields = new Map<string, FieldInfo>();
    kbdFields.set('isAccessible', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Keyboard', isStatic: true, isConst: true });
    for (const [k, v] of kbdStatic) kbdFields.set(k, kbd('Keyboard', v));
    this.classMap.set('Keyboard', {
      fields: new Map(),
      methods: new Map(),
      staticFields: kbdFields,
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Mouse: static hide()/show() toggle a runtime visibility flag; cursor is a
    // writable static String (AS3 `public static var cursor:String = "auto"`).
    this.classMap.set('Mouse', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['cursor', { type: { kind: 'string' }, init: { kind: 'Str', value: 'auto' }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: false }],
        ['supportsCursor', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: true }],
        ['supportsNativeCursor', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Mouse', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map([
        ['hide', { returnType: { kind: 'void' }, params: [], owner: 'Mouse', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ['show', { returnType: { kind: 'void' }, params: [], owner: 'Mouse', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.ui.Multitouch / MultitouchInputMode (AIR input-mode constants). The
    // inputMode getter/setter wrap a global string (default "none") so
    // `Multitouch.inputMode == MultitouchInputMode.TOUCH_POINT` behaves.
    this.classMap.set('MultitouchInputMode', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['NONE', { type: { kind: 'string' }, init: { kind: 'Str', value: 'none' }, visibility: 'public', owner: 'MultitouchInputMode', isStatic: true, isConst: true }],
        ['TOUCH_POINT', { type: { kind: 'string' }, init: { kind: 'Str', value: 'touchPoint' }, visibility: 'public', owner: 'MultitouchInputMode', isStatic: true, isConst: true }],
        ['GESTURE', { type: { kind: 'string' }, init: { kind: 'Str', value: 'gesture' }, visibility: 'public', owner: 'MultitouchInputMode', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('Multitouch', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      staticGetters: new Map([
        ['inputMode', { returnType: { kind: 'string' }, params: [], owner: 'Multitouch', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      staticSetters: new Map([
        ['inputMode', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'String', defaultValue: null, isRest: false }], owner: 'Multitouch', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: true }],
      ]),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.filesystem (stage 64): File / FileStream / FileMode. NativeWindow and
    // SQLConnection/SQLStatement are deferred (native multi-window management and
    // SQLite linking, respectively).
    //
    // File: a filesystem path object. nativePath holds the raw path; url is the
    // "file://" form. exists/isDirectory are read-only *properties* (real AIR:
    // getter access f.exists, not f.exists()) probing via stat(); createDirectory
    // runs mkdir; deleteFile/deleteDirectory run remove(); resolvePath joins a
    // child. applicationStorageDirectory (handled at codegen time like the other
    // File static directory shortcuts) resolves a writable per-app storage dir.
    const filefld = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'File', isStatic: false, isConst: false });
    const filegetr = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'File', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const filemeth = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'File', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('File', {
      fields: new Map([
        ['nativePath', filefld({ kind: 'string' })],
      ]),
      methods: new Map([
        ['resolvePath', filemeth({ kind: 'object', className: 'File' }, [{ name: 'path', type: 'String', defaultValue: null, isRest: false }])],
        ['createDirectory', filemeth({ kind: 'void' }, [])],
        ['deleteFile', filemeth({ kind: 'void' }, [])],
        ['deleteDirectory', filemeth({ kind: 'void' }, [])],
        ['getDirectoryListing', filemeth({ kind: 'array' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['url', filegetr({ kind: 'string' })],
        ['exists', filegetr({ kind: 'bool' })],
        ['isDirectory', filegetr({ kind: 'bool' })],
        ['isHidden', filegetr({ kind: 'bool' })],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'path', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
      // flash.filesystem::File must round-trip getQualifiedClassName so the
      // Starling AssetManager can distinguish it from unsupported asset types.
      fqn: 'flash.filesystem::File',
    });
    // FileStream: a POSIX FILE* wrapper. open() maps an AIR FileMode string
    // ("read"/"write"/"append"/"update") to a C fopen mode and keeps the handle
    // (opaque void*, not GC-tracked). readUTFBytes/writeUTFBytes transfer UTF-8.
    const fsfld = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'FileStream', isStatic: false, isConst: false });
    const fsgetr = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'FileStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const fsmeth = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'FileStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('FileStream', {
      fields: new Map([
        ['_handle', fsfld({ kind: 'null' })],
      ]),
      methods: new Map([
        ['open', fsmeth({ kind: 'void' }, [
          { name: 'file', type: 'File', defaultValue: null, isRest: false },
          { name: 'fileMode', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['openAsync', fsmeth({ kind: 'void' }, [
          { name: 'file', type: 'File', defaultValue: null, isRest: false },
          { name: 'fileMode', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['close', fsmeth({ kind: 'void' }, [])],
        ['readUTFBytes', fsmeth({ kind: 'string' }, [{ name: 'length', type: 'uint', defaultValue: null, isRest: false }])],
        ['writeUTFBytes', fsmeth({ kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }])],
        ['readBytes', fsmeth({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'offset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'length', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
        ['writeBytes', fsmeth({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'offset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'length', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['bytesAvailable', fsgetr({ kind: 'uint' })],
        ['position', fsgetr({ kind: 'uint' })],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // FileMode: constant strings passed to FileStream.open.
    const fmodec = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    this.classMap.set('FileMode', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['READ', fmodec('FileMode', 'read')],
        ['WRITE', fmodec('FileMode', 'write')],
        ['APPEND', fmodec('FileMode', 'append')],
        ['UPDATE', fmodec('FileMode', 'update')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Stage 41 constant classes: pure static String constants (zero runtime
    // dependency), mirroring the AIR SDK values verbatim.
    const stgc = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    const constClass = (name: string, consts: Record<string, string>): void => {
      const sf = new Map<string, FieldInfo>();
      for (const [k, v] of Object.entries(consts)) sf.set(k, stgc(name, v));
      this.classMap.set(name, {
        fields: new Map(), methods: new Map(), staticFields: sf, staticMethods: new Map(),
        getters: new Map(), setters: new Map(), constructor: { params: [] },
        superClass: 'Object', isFinal: false, implements: [],
      });
    };
    const intConstClass = (name: string, consts: Record<string, number>): void => {
      const sf = new Map<string, FieldInfo>();
      for (const [k, v] of Object.entries(consts)) sf.set(k, { type: { kind: 'int' }, init: { kind: 'Num', value: v, isInt: true }, visibility: 'public', owner: name, isStatic: true, isConst: true });
      this.classMap.set(name, {
        fields: new Map(), methods: new Map(), staticFields: sf, staticMethods: new Map(),
        getters: new Map(), setters: new Map(), constructor: { params: [] },
        superClass: 'Object', isFinal: false, implements: [],
      });
    };
    constClass('StageAlign', { TOP: 'T', BOTTOM: 'B', LEFT: 'L', RIGHT: 'R', TOP_LEFT: 'TL', TOP_RIGHT: 'TR', BOTTOM_LEFT: 'BL', BOTTOM_RIGHT: 'BR' });
    // NativeWindow token classes (阶段八十九·七十一). Values measured on adl:
    // Resize.NONE is the empty string, and the resize codes reuse the same
    // T/B/L/R/"BR" letters as StageAlign.
    constClass('NativeWindowSystemChrome', { STANDARD: 'standard', NONE: 'none', ALTERNATE: 'alternate' });
    constClass('NativeWindowType', { NORMAL: 'normal', UTILITY: 'utility', LIGHTWEIGHT: 'lightweight' });
    constClass('NativeWindowRenderMode', { AUTO: 'auto', DIRECT: 'direct', CPU: 'cpu', GPU: 'gpu' });
    constClass('NativeWindowDisplayState', { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized' });
    constClass('NativeWindowResize', { NONE: '', TOP: 'T', BOTTOM: 'B', LEFT: 'L', RIGHT: 'R', TOP_LEFT: 'TL', TOP_RIGHT: 'TR', BOTTOM_LEFT: 'BL', BOTTOM_RIGHT: 'BR' });
    constClass('StageScaleMode', { EXACT_FIT: 'exactFit', SHOW_ALL: 'showAll', NO_BORDER: 'noBorder', NO_SCALE: 'noScale' });
    // flash.display.BlendMode: one String constant per mix operator (the values are
    // the operator names themselves, so no mapping table is needed here or in user
    // code). AIR's LAYER is group isolation rather than an operator.
    constClass('BlendMode', {
      NORMAL: 'normal', LAYER: 'layer', MULTIPLY: 'multiply', SCREEN: 'screen',
      LIGHTEN: 'lighten', DARKEN: 'darken', DIFFERENCE: 'difference', ADD: 'add',
      SUBTRACT: 'subtract', INVERT: 'invert', ALPHA: 'alpha', ERASE: 'erase',
      OVERLAY: 'overlay', HARDLIGHT: 'hardlight', SHADER: 'shader',
    });
    constClass('StageQuality', { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', BEST: 'best' });
    constClass('StageDisplayState', { NORMAL: 'normal', FULL_SCREEN: 'fullScreen', FULL_SCREEN_INTERACTIVE: 'fullScreenInteractive' });
    constClass('TextFieldAutoSize', { NONE: 'none', LEFT: 'left', RIGHT: 'right', CENTER: 'center' });
    // flash.text.TextFieldType (stage 94·7). Values measured on adl 51.4.1
    // (temp/editprobe): TextFieldType.INPUT == "input" and DYNAMIC == "dynamic",
    // and a fresh TextField reports type == "dynamic".
    constClass('TextFieldType', { DYNAMIC: 'dynamic', INPUT: 'input' });
    constClass('AntiAliasType', { NORMAL: 'normal', ADVANCED: 'advanced' });
    constClass('TextFormatAlign', { LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFY: 'justify' });
    constClass('TouchPhase', { BEGAN: 'began', MOVED: 'moved', ENDED: 'ended', STATIONARY: 'stationary', HOVER: 'hover' });
    constClass('MouseCursor', { AUTO: 'auto', ARROW: 'arrow', BUTTON: 'button', HAND: 'hand', IBEAM: 'ibeam' });
    // Stage 110 (away3d-core walls): drawing-style / culling / orientation /
    // shader-precision constant classes. Every value measured on adl 51.4.1
    // (temp/constprobe/adl.txt), e.g. CapsStyle.NONE == "none".
    constClass('CapsStyle', { NONE: 'none', ROUND: 'round', SQUARE: 'square' });
    constClass('LineScaleMode', { NONE: 'none', NORMAL: 'normal', VERTICAL: 'vertical', HORIZONTAL: 'horizontal' });
    constClass('TriangleCulling', { NONE: 'none', POSITIVE: 'positive', NEGATIVE: 'negative' });
    // flash.geom.Orientation3D: the strings Matrix3D.decompose/recompose accept.
    constClass('Orientation3D', { AXIS_ANGLE: 'axisAngle', EULER_ANGLES: 'eulerAngles', QUATERNION: 'quaternion' });
    constClass('ShaderPrecision', { FAST: 'fast', FULL: 'full' });
    // ---- flash.net.SharedObject (stage 89·40) ----
    // Local shared objects persisted under applicationStorageDirectory. AIR's own
    // container is an AMF3 ".sol" file; this subset persists JSON through the
    // existing JSON codec, so the byte format differs while the AS3 semantics
    // (data / flush / clear / size / instance identity) are preserved. Only the
    // local half is implemented: getRemote/connect/send need a Flash Media
    // Server, so they fail loudly instead of silently pretending (see emit.ts).
    // AIR values confirmed with adl 51.4.1: ObjectEncoding.AMF0=0, AMF3=3,
    // DEFAULT=3, defaultObjectEncoding=3, preventBackup=false, and
    // SharedObjectFlushStatus.FLUSHED="flushed" / PENDING="pending".
    intConstClass('ObjectEncoding', { AMF0: 0, AMF3: 3, DEFAULT: 3 });
    constClass('SharedObjectFlushStatus', { FLUSHED: 'flushed', PENDING: 'pending' });
    const sog = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'SharedObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const sos = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'SharedObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    const som = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'SharedObject', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const sosm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'SharedObject', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false });
    const sosg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'SharedObject', visibility: 'public', isStatic: true, isFinal: false, isGetter: true, isSetter: false });
    const soss = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'SharedObject', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('SharedObject', {
      // No AS3-visible instance fields: data/size/client/objectEncoding are
      // accessors and the persisted table lives in a C-runtime-only slot that the
      // props reflection table marks for the GC (see emit.ts emitPropTables).
      fields: new Map(),
      methods: new Map([
        ['flush', som({ kind: 'string' }, [{ name: 'minDiskSpace', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false }])],
        ['clear', som({ kind: 'void' }, [])],
        ['close', som({ kind: 'void' }, [])],
        // connect/send target a remote object; the C bodies throw. Parameters are
        // typed '*' because NetConnection is not part of the subset.
        ['connect', som({ kind: 'void' }, [
          { name: 'myConnection', type: 'any', defaultValue: null, isRest: false },
          { name: 'params', type: 'any', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
        // send's rest parameter is typed Array so the typed call path (which
        // materialises the trailing arguments with as_array_make) and the C
        // signature agree; the body throws.
        ['send', som({ kind: 'void' }, [{ name: 'arguments', type: 'Array', defaultValue: null, isRest: true }])],
        ['setDirty', som({ kind: 'void' }, [{ name: 'propertyName', type: 'String', defaultValue: null, isRest: false }])],
        ['setProperty', som({ kind: 'void' }, [
          { name: 'propertyName', type: 'String', defaultValue: null, isRest: false },
          { name: 'value', type: 'any', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
      ]),
      // _cache holds the already-handed-out instances so repeated getLocal() calls
      // for one name return the SAME object (AIR behaviour, adl-verified). As a
      // declared static field it is a GC permanent root, so a cached object can
      // never be collected while the process still hands it out.
      staticFields: new Map([
        ['_cache', { type: { kind: 'array' }, init: null, visibility: 'private', owner: 'SharedObject', isStatic: true, isConst: false }],
      ]),
      staticMethods: new Map([
        ['getLocal', sosm({ kind: 'object', className: 'SharedObject' }, [
          { name: 'name', type: 'String', defaultValue: null, isRest: false },
          { name: 'localPath', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'secure', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['getRemote', sosm({ kind: 'object', className: 'SharedObject' }, [
          { name: 'name', type: 'String', defaultValue: null, isRest: false },
          { name: 'remotePath', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'persistence', type: 'any', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'secure', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
      ]),
      getters: new Map([
        ['data', sog({ kind: 'object', className: 'Object' })],
        ['size', sog({ kind: 'uint' })],
        ['client', sog({ kind: 'object', className: 'Object' })],
        ['objectEncoding', sog({ kind: 'uint' })],
      ]),
      // data is read-only in AIR (mxmlc rejects `so.data = x`), so it has no
      // setter here either. fps is write-only (it only throttles uploads to a
      // server, which does not exist for a local object).
      setters: new Map([
        ['client', sos('Object')],
        ['objectEncoding', sos('uint')],
        ['fps', sos('Number')],
      ]),
      staticGetters: new Map([
        ['defaultObjectEncoding', sosg({ kind: 'uint' })],
        ['preventBackup', sosg({ kind: 'bool' })],
      ]),
      staticSetters: new Map([
        ['defaultObjectEncoding', soss('uint')],
        ['preventBackup', soss('Boolean')],
      ]),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
      // AIR reports flash.net::SharedObject, and the sealed-property error message
      // for an undeclared property (ReferenceError #1056) quotes this form.
      fqn: 'flash.net::SharedObject',
    });
    // built-in mouse/keyboard/focus event types (flash.events). Each extends Event,
    // so the base fields (type/bubbles/cancelable/target/...) are inherited.
    const mef = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const mec = (owner: string, value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner, isStatic: true, isConst: true });
    const meBool = (name: string, def: boolean): Param => ({ name, type: 'Boolean', defaultValue: { kind: 'Bool', value: def }, isRest: false });
    this.classMap.set('MouseEvent', {
      fields: new Map([
        ['localX', mef({ kind: 'number' }, 'MouseEvent')],
        ['localY', mef({ kind: 'number' }, 'MouseEvent')],
        ['stageX', mef({ kind: 'number' }, 'MouseEvent')],
        ['stageY', mef({ kind: 'number' }, 'MouseEvent')],
        ['relatedObject', mef({ kind: 'object', className: 'Object' }, 'MouseEvent')],
        ['ctrlKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['altKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['shiftKey', mef({ kind: 'bool' }, 'MouseEvent')],
        ['buttonDown', mef({ kind: 'bool' }, 'MouseEvent')],
        ['delta', mef({ kind: 'number' }, 'MouseEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['MOUSE_DOWN', mec('MouseEvent', 'mouseDown')],
        ['MOUSE_UP', mec('MouseEvent', 'mouseUp')],
        ['CLICK', mec('MouseEvent', 'click')],
        ['MOUSE_MOVE', mec('MouseEvent', 'mouseMove')],
        ['MOUSE_OVER', mec('MouseEvent', 'mouseOver')],
        ['MOUSE_OUT', mec('MouseEvent', 'mouseOut')],
        ['ROLL_OVER', mec('MouseEvent', 'rollOver')],
        ['ROLL_OUT', mec('MouseEvent', 'rollOut')],
        ['DOUBLE_CLICK', mec('MouseEvent', 'doubleClick')],
        ['MOUSE_WHEEL', mec('MouseEvent', 'mouseWheel')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'localX', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
        { name: 'localY', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
        { name: 'relatedObject', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('ctrlKey', false),
        meBool('altKey', false),
        meBool('shiftKey', false),
        meBool('buttonDown', false),
        { name: 'delta', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events.TouchEvent (stage 93; full AIR shape filled in while clearing
    // away3d-core walls): multi-touch input. Field set and constructor parameter
    // order come from the AIR 3.0 class reference --
    // TouchEvent(type, bubbles, cancelable, touchPointID, isPrimaryTouchPoint,
    //           localX, localY, sizeX, sizeY, pressure, relatedObject, ctrlKey,
    //           altKey, shiftKey, commandKey, controlKey, timestamp, touchIntent,
    //           samples, isTouchPointCanceled)
    // Note the 11th parameter is relatedObject: there is no 16-argument shape, and
    // passing a Boolean there is the mxmlc coercion error the probe hit (measured:
    // temp/tevtprobe/). localX/localY are plain fields whose NaN default comes
    // from the constructor arguments, while stageX/stageY are READ-ONLY DERIVED
    // getters: AIR calculates them when localX/localY is set, and with no stage
    // transform in this compiler that value is 0.0 (measured: adl,
    // `new TouchEvent("touchMove")` -> stageX NaN while localX is NaN, but 0 once
    // localX is set -- and writing stageX is rejected, matching mxmlc's
    // "property stageX is read-only"). `samples` is accepted by the constructor
    // but not stored: AIR exposes no `samples` property and getSamples() reports 0
    // because no sample buffer exists. Touch input itself is not implemented (our
    // Stage never dispatches TouchEvent), so these objects only ever come from
    // user code -- same standing gap as the native touch backends.
    const tef = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'TouchEvent', isStatic: false, isConst: false });
    const tec = (value: string): FieldInfo => ({ type: { kind: 'string' }, init: { kind: 'Str', value }, visibility: 'public', owner: 'TouchEvent', isStatic: true, isConst: true });
    const teNum = (name: string): Param => ({ name, type: 'Number', defaultValue: { kind: 'Num', value: NaN, isInt: false }, isRest: false });
    this.classMap.set('TouchEvent', {
      fields: new Map([
        ['localX', tef({ kind: 'number' })],
        ['localY', tef({ kind: 'number' })],
        ['sizeX', tef({ kind: 'number' })],
        ['sizeY', tef({ kind: 'number' })],
        ['pressure', tef({ kind: 'number' })],
        ['timestamp', tef({ kind: 'number' })],
        ['touchPointID', tef({ kind: 'int' })],
        ['relatedObject', tef({ kind: 'object', className: 'InteractiveObject' })],
        ['isPrimaryTouchPoint', tef({ kind: 'bool' })],
        ['isRelatedObjectInaccessible', tef({ kind: 'bool' })],
        ['isTouchPointCanceled', tef({ kind: 'bool' })],
        ['ctrlKey', tef({ kind: 'bool' })],
        ['altKey', tef({ kind: 'bool' })],
        ['shiftKey', tef({ kind: 'bool' })],
        ['commandKey', tef({ kind: 'bool' })],
        ['controlKey', tef({ kind: 'bool' })],
        ['touchIntent', { type: { kind: 'string' }, init: { kind: 'Str', value: 'unknown' }, visibility: 'public', owner: 'TouchEvent', isStatic: false, isConst: false }],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['TOUCH_BEGIN', tec('touchBegin')],
        ['TOUCH_MOVE', tec('touchMove')],
        ['TOUCH_END', tec('touchEnd')],
        ['TOUCH_OVER', tec('touchOver')],
        ['TOUCH_OUT', tec('touchOut')],
        ['TOUCH_ROLL_OVER', tec('touchRollOver')],
        ['TOUCH_ROLL_OUT', tec('touchRollOut')],
        ['TOUCH_TAP', tec('touchTap')],
        ['PROXIMITY_BEGIN', tec('proximityBegin')],
        ['PROXIMITY_MOVE', tec('proximityMove')],
        ['PROXIMITY_END', tec('proximityEnd')],
        ['PROXIMITY_OVER', tec('proximityOver')],
        ['PROXIMITY_OUT', tec('proximityOut')],
        ['PROXIMITY_ROLL_OVER', tec('proximityRollOver')],
        ['PROXIMITY_ROLL_OUT', tec('proximityRollOut')],
      ]),
      staticMethods: new Map(),
      // stageX/stageY are derived, not stored -- see the class comment above.
      getters: new Map([
        ['stageX', { returnType: { kind: 'number' }, params: [], owner: 'TouchEvent', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ['stageY', { returnType: { kind: 'number' }, params: [], owner: 'TouchEvent', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'touchPointID', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        meBool('isPrimaryTouchPoint', false),
        teNum('localX'),
        teNum('localY'),
        teNum('sizeX'),
        teNum('sizeY'),
        teNum('pressure'),
        { name: 'relatedObject', type: 'InteractiveObject', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('ctrlKey', false),
        meBool('altKey', false),
        meBool('shiftKey', false),
        meBool('commandKey', false),
        meBool('controlKey', false),
        teNum('timestamp'),
        { name: 'touchIntent', type: 'String', defaultValue: { kind: 'Str', value: 'unknown' }, isRest: false },
        { name: 'samples', type: 'ByteArray', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('isTouchPointCanceled', false),
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('KeyboardEvent', {
      fields: new Map([
        ['keyCode', mef({ kind: 'int' }, 'KeyboardEvent')],
        ['charCode', mef({ kind: 'int' }, 'KeyboardEvent')],
        ['keyLocation', mef({ kind: 'int' }, 'KeyboardEvent')],
        ['ctrlKey', mef({ kind: 'bool' }, 'KeyboardEvent')],
        ['altKey', mef({ kind: 'bool' }, 'KeyboardEvent')],
        ['shiftKey', mef({ kind: 'bool' }, 'KeyboardEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['KEY_DOWN', mec('KeyboardEvent', 'keyDown')],
        ['KEY_UP', mec('KeyboardEvent', 'keyUp')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'charCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'keyCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events.TextEvent (stage 94·7): the text-input event an editable
    // TextField dispatches before it applies a typed/pasted character. Measured on
    // adl 51.4.1 (temp/editprobe): TEXT_INPUT == "textInput", bubbles == true,
    // cancelable == true, and the payload is the text about to be inserted (the
    // whole pasted string for a paste, one character per keystroke). A canceling
    // listener (preventDefault) stops the insertion and the change event; rewriting
    // `text` only changes what later listeners see — the insertion still uses the
    // text the field received (measured: rewriting "Y" to "Z" still inserted "Y").
    this.classMap.set('TextEvent', {
      fields: new Map([
        ['text', mef({ kind: 'string' }, 'TextEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['TEXT_INPUT', mec('TextEvent', 'textInput')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('FocusEvent', {
      fields: new Map([
        ['keyCode', mef({ kind: 'int' }, 'FocusEvent')],
        ['relatedObject', mef({ kind: 'object', className: 'Object' }, 'FocusEvent')],
        ['shiftKey', mef({ kind: 'bool' }, 'FocusEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['FOCUS_IN', mec('FocusEvent', 'focusIn')],
        ['FOCUS_OUT', mec('FocusEvent', 'focusOut')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', true),
        meBool('cancelable', false),
        { name: 'relatedObject', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        meBool('shiftKey', false),
        { name: 'keyCode', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events event subclasses (stage 59): TimerEvent / ProgressEvent /
    // ErrorEvent / IOErrorEvent / DataEvent. Pure constant classes + a few fields;
    // bubbles/cancelable defaults differ per class (TimerEvent both false), so each
    // has its own constructor. clone()/toString() follow the existing MouseEvent
    // simplification (not overridden; Event.clone() returns a base Event).
    this.classMap.set('TimerEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['TIMER', mec('TimerEvent', 'timer')],
        ['TIMER_COMPLETE', mec('TimerEvent', 'timerComplete')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ProgressEvent', {
      fields: new Map([
        ['bytesLoaded', mef({ kind: 'uint' }, 'ProgressEvent')],
        ['bytesTotal', mef({ kind: 'uint' }, 'ProgressEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['PROGRESS', mec('ProgressEvent', 'progress')],
        // flash.net.Socket raises this, not PROGRESS: see the socket section in
        // emit.ts. Same shape, different type string.
        ['SOCKET_DATA', mec('ProgressEvent', 'socketData')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'bytesLoaded', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'bytesTotal', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ErrorEvent', {
      fields: new Map([
        ['text', mef({ kind: 'string' }, 'ErrorEvent')],
        ['errorID', mef({ kind: 'int' }, 'ErrorEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['ERROR', mec('ErrorEvent', 'error')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('IOErrorEvent', {
      // `errorID` is inherited from ErrorEvent (already registered above), which is
      // also the field AIR's asynchronous socket failures report the number in.
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['IO_ERROR', mec('IOErrorEvent', 'ioError')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'ErrorEvent',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('DataEvent', {
      fields: new Map([
        ['data', mef({ kind: 'string' }, 'DataEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['DATA', mec('DataEvent', 'data')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'data', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events.VsyncStateChangeAvailabilityEvent — an ENHANCED builtin (stage
    // 一百二十九). AIR defines the event but exposes NO refresh-rate query anywhere
    // (measured on mxmlc/adl 51.4.1: Stage.vsyncEnabled exists, but Stage.refreshRate,
    // Stage3D.refreshRate, Screen.refreshRate and Stage.vsyncStateChangeAvailability
    // are all rejected as undefined, and the event's only own AIR property is the
    // read-only `available:Boolean`). We keep `available` exactly as AIR defines it —
    // same field, same value adl reports — and ADD a `refreshRate:Number` field that
    // carries the real refresh rate (Hz) of the display the window occupies, so a
    // portable app can match `stage.frameRate` to the panel instead of guessing.
    // The addition is opt-in and additive: AIR's ctor (max 4 args, verified with
    // mxmlc's "不超过 4 个" argument-count error) stays valid, and AIR programs never
    // pass the 5th. See docs/zh-cn/enhancements.md.
    this.classMap.set('VsyncStateChangeAvailabilityEvent', {
      fields: new Map([
        ['available', mef({ kind: 'bool' }, 'VsyncStateChangeAvailabilityEvent')],
        ['refreshRate', mef({ kind: 'number' }, 'VsyncStateChangeAvailabilityEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['VSYNC_STATE_CHANGE_AVAILABILITY', mec('VsyncStateChangeAvailabilityEvent', 'vSyncStateChangeAvailability')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        meBool('available', false),
        { name: 'refreshRate', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.events.HTTPStatusEvent / SecurityErrorEvent (AIR): HTTPStatusEvent adds
    // status/responseURL/responseHeaders; SecurityErrorEvent only adds a constant
    // (text is inherited from ErrorEvent).
    this.classMap.set('HTTPStatusEvent', {
      fields: new Map([
        ['status', mef({ kind: 'int' }, 'HTTPStatusEvent')],
        ['responseURL', mef({ kind: 'string' }, 'HTTPStatusEvent')],
        ['responseHeaders', mef({ kind: 'array' }, 'HTTPStatusEvent')],
        ['redirected', mef({ kind: 'bool' }, 'HTTPStatusEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['HTTP_STATUS', mec('HTTPStatusEvent', 'httpStatus')],
        ['HTTP_RESPONSE_STATUS', mec('HTTPStatusEvent', 'httpResponseStatus')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'status', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('SecurityErrorEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['SECURITY_ERROR', mec('SecurityErrorEvent', 'securityError')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'ErrorEvent',
      isFinal: false,
      implements: [],
    });
    // flash.events.NetStatusEvent / AsyncErrorEvent / ContextMenuEvent (stage 110,
    // away3d-core walls). Only what the tree touches is modelled: the event
    // constants plus NetStatusEvent.info, which a handler indexes as
    // event.info["code"] (String keys measured on adl 51.4.1, temp/constprobe).
    this.classMap.set('NetStatusEvent', {
      fields: new Map([
        ['info', mef({ kind: 'object', className: 'Object' }, 'NetStatusEvent')],
      ]),
      methods: new Map(),
      staticFields: new Map([
        ['NET_STATUS', mec('NetStatusEvent', 'netStatus')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'info', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // AsyncErrorEvent: the asynchronous counterpart of ErrorEvent. AIR's payload is
    // the thrown Error itself (inherited `text` is unused by the tree).
    this.classMap.set('AsyncErrorEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['ASYNC_ERROR', mec('AsyncErrorEvent', 'asyncError')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'text', type: 'String', defaultValue: { kind: 'Str', value: '' }, isRest: false },
      ] },
      superClass: 'ErrorEvent',
      isFinal: false,
      implements: [],
    });
    // ContextMenuEvent: MENU_SELECT fires on the display object, MENU_ITEM_SELECT on
    // a ContextMenuItem. This subset never shows a native menu, so neither is ever
    // dispatched (documented gap); the class exists so handlers and
    // addEventListener calls type-check and link.
    this.classMap.set('ContextMenuEvent', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['MENU_ITEM_SELECT', mec('ContextMenuEvent', 'menuItemSelect')],
        ['MENU_SELECT', mec('ContextMenuEvent', 'menuSelect')],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'type', type: 'String', defaultValue: null, isRest: false },
        meBool('bubbles', false),
        meBool('cancelable', false),
        { name: 'mouseTarget', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'contextMenuOwner', type: 'InteractiveObject', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Event',
      isFinal: false,
      implements: [],
    });
    // flash.ui.ContextMenu / ContextMenuItem / ContextMenuBuiltInItems (stage 110).
    // The data model is faithful (measured with adl 51.4.1, temp/constprobe): a
    // fresh ContextMenu owns an empty customItems array and a
    // ContextMenuBuiltInItems object, and `new ContextMenuItem(caption,
    // separatorBefore, enabled, visible)` copies its four arguments verbatim
    // (caption "Cap\tx" round-trips). ContextMenuItem is an EventDispatcher because
    // MENU_ITEM_SELECT listeners are attached to it. ContextMenuBuiltInItems'
    // individual flags are NOT modelled (the tree never reads them).
    const cmiF = (owner: string, t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const cmiM = (owner: string, ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const cmiP = (name: string, t: ASType, def: Extract<Expr, { kind: 'Bool' }> | Extract<Expr, { kind: 'Str' }> | null): Param => ({ name, type: t, defaultValue: def, isRest: false });
    this.classMap.set('ContextMenuBuiltInItems', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ContextMenuItem', {
      fields: new Map([
        ['caption', cmiF('ContextMenuItem', { kind: 'string' })],
        ['separatorBefore', cmiF('ContextMenuItem', { kind: 'bool' })],
        ['enabled', cmiF('ContextMenuItem', { kind: 'bool' })],
        ['visible', cmiF('ContextMenuItem', { kind: 'bool' })],
        ['isSeparator', cmiF('ContextMenuItem', { kind: 'bool' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        cmiP('caption', 'String', { kind: 'Str', value: '' }),
        cmiP('separatorBefore', 'Boolean', { kind: 'Bool', value: false }),
        cmiP('enabled', 'Boolean', { kind: 'Bool', value: true }),
        cmiP('visible', 'Boolean', { kind: 'Bool', value: true }),
        cmiP('isSeparator', 'Boolean', { kind: 'Bool', value: false }),
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ContextMenu', {
      fields: new Map([
        ['customItems', cmiF('ContextMenu', { kind: 'array' })],
        ['builtInItems', cmiF('ContextMenu', { kind: 'object', className: 'ContextMenuBuiltInItems' })],
      ]),
      methods: new Map([
        ['hideBuiltInItems', cmiM('ContextMenu', { kind: 'void' }, [])],
        ['addItem', cmiM('ContextMenu', { kind: 'void' }, [{ name: 'item', type: 'ContextMenuItem', defaultValue: null, isRest: false }])],
        ['removeItem', cmiM('ContextMenu', { kind: 'void' }, [{ name: 'item', type: 'ContextMenuItem', defaultValue: null, isRest: false }])],
        ['containsItem', cmiM('ContextMenu', { kind: 'bool' }, [{ name: 'item', type: 'ContextMenuItem', defaultValue: null, isRest: false }])],
        ['clone', cmiM('ContextMenu', { kind: 'object', className: 'ContextMenu' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.display.Shader / ShaderData / ShaderJob (stage 110). A Pixel Bender
    // kernel cannot be interpreted by an AOT subset, so `new Shader(bytes)` with
    // non-null bytecode fails loudly instead of pretending (the AIR validity error
    // for empty bytecode, ArgumentError #2004, is matched first). `new Shader(null)`
    // is legal in AIR and yields data == null — both measured on adl 51.4.1
    // (temp/shaderprobe). ShaderData is dynamic: kernels are addressed by the
    // parameter names baked into the PBJ metadata, which this subset does not
    // parse, so `data.<name>` resolves through the dynamic slot table.
    const shF = (owner: string, t: CType): FieldInfo => ({ type: t, init: null, visibility: 'private', owner, isStatic: false, isConst: false });
    const shG = (owner: string, t: CType): MethodInfo => ({ returnType: t, params: [], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const shS = (owner: string, pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('ShaderData', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      isDynamic: true,
      implements: [],
    });
    this.classMap.set('Shader', {
      fields: new Map([
        ['_code', shF('Shader', { kind: 'object', className: 'ByteArray' })],
        ['_data', shF('Shader', { kind: 'object', className: 'ShaderData' })],
        ['_precisionHint', shF('Shader', { kind: 'string' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['data', shG('Shader', { kind: 'object', className: 'ShaderData' })],
        ['precisionHint', shG('Shader', { kind: 'string' })],
      ]),
      setters: new Map([
        ['precisionHint', shS('Shader', 'String')],
        // AIR exposes byteCode as write-only; a read is a compile error here (the
        // same loud failure as any setter-only accessor).
        ['byteCode', shS('Shader', 'ByteArray')],
      ]),
      constructor: { params: [
        { name: 'code', type: 'ByteArray', defaultValue: { kind: 'Null' }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('ShaderJob', {
      fields: new Map([
        ['_shader', shF('ShaderJob', { kind: 'object', className: 'Shader' })],
        ['_target', shF('ShaderJob', { kind: 'object', className: 'Object' })],
        ['_width', shF('ShaderJob', { kind: 'int' })],
        ['_height', shF('ShaderJob', { kind: 'int' })],
        ['_progress', shF('ShaderJob', { kind: 'number' })],
      ]),
      methods: new Map([
        ['start', cmiM('ShaderJob', { kind: 'void' }, [cmiP('waitForCompletion', 'Boolean', { kind: 'Bool', value: false })])],
        ['cancel', cmiM('ShaderJob', { kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['shader', shG('ShaderJob', { kind: 'object', className: 'Shader' })],
        ['target', shG('ShaderJob', { kind: 'object', className: 'Object' })],
        ['width', shG('ShaderJob', { kind: 'int' })],
        ['height', shG('ShaderJob', { kind: 'int' })],
        ['progress', shG('ShaderJob', { kind: 'number' })],
      ]),
      setters: new Map([
        ['shader', shS('ShaderJob', 'Shader')],
        ['target', shS('ShaderJob', 'Object')],
        ['width', shS('ShaderJob', 'int')],
        ['height', shS('ShaderJob', 'int')],
      ]),
      constructor: { params: [
        { name: 'shader', type: 'Shader', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'target', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'width', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'height', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.utils.Timer (stage 60): repeating timer extending EventDispatcher.
    // delay/repeatCount are getter/setter pairs (setter validates range); the
    // backing fields store the values. currentCount/running are read-only. The
    // repeating-timer pool and tick live in runtime.ts (as_rep_timer_*), driven by
    // as_timer_tick() from the frame loop; Timer_start registers, Timer__on_tick
    // fires/dispatches/re-arms.
    const tmr = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const tmg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const tms = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Timer', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('Timer', {
      fields: new Map([
        ['delay', mef({ kind: 'number' }, 'Timer')],
        ['repeatCount', mef({ kind: 'int' }, 'Timer')],
        ['currentCount', mef({ kind: 'int' }, 'Timer')],
        ['running', mef({ kind: 'bool' }, 'Timer')],
      ]),
      methods: new Map([
        ['start', tmr({ kind: 'void' }, [])],
        ['stop', tmr({ kind: 'void' }, [])],
        ['reset', tmr({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['delay', tmg({ kind: 'number' })],
        ['repeatCount', tmg({ kind: 'int' })],
        ['currentCount', tmg({ kind: 'int' })],
        ['running', tmg({ kind: 'bool' })],
      ]),
      setters: new Map([
        ['delay', tms('Number')],
        ['repeatCount', tms('int')],
      ]),
      constructor: { params: [
        { name: 'delay', type: 'Number', defaultValue: null, isRest: false },
        { name: 'repeatCount', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
      ] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // built-in drawing API (flash.display) — stage 37.
    // Graphics accumulates a single SkPath plus current fill/stroke paints; the
    // render() replay (emit.ts as_graphics_render) draws the accumulated path
    // with whichever paint(s) are set. The opaque Skia pointers cross the C
    // boundary as `void*` (`kind: 'null'`), so AS3 never sees their layout.
    const gpf = (): FieldInfo => ({ type: { kind: 'null' }, init: null, visibility: 'public', owner: 'Graphics', isStatic: false, isConst: false });
    const gpm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Graphics', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const gpf2 = (): FieldInfo => ({ type: { kind: 'number' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false });
    const gnum = (name: string, def: number): Param => ({ name, type: 'Number', defaultValue: { kind: 'Num', value: def, isInt: false }, isRest: false });
    const guint = (name: string, def: number): Param => ({ name, type: 'uint', defaultValue: { kind: 'Num', value: def, isInt: true }, isRest: false });
    this.classMap.set('Graphics', {
      fields: new Map([
        ['path', gpf()],
        ['fill', gpf()],
        ['stroke', gpf()],
        // Line thickness of the CURRENT stroke. Not an AIR-visible property: it
        // exists so DisplayObject width/height can add the stroke extent, which
        // adl reports (a 0..100 line with a 10px stroke measures 110x10) while
        // getRect stays 0,0,100,0.
        ['strokeWidth', { type: { kind: 'number' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        // Widest stroke ever set on this Graphics, never reset by a flush: the
        // stroke-inclusive bound must cover groups that were already closed.
        ['_max_sw', { type: { kind: 'number' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        // CPU-side bounding box of the accumulated path (_bl.._bb + _has_b),
        // maintained by every path mutation. It mirrors SkPath::getBounds() (which
        // includes curve control points) and exists so DisplayObject width/height
        // and the hit test stay measurable in a PURE-C build too, where every Skia
        // stub returns no geometry at all — and it avoids paying an Skia call on
        // every width read on the hot path.
        ['_bl', gpf2()], ['_bt', gpf2()], ['_br', gpf2()], ['_bb', gpf2()],
        ['_has_b', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        // Ordered draw groups (swc.md §9 E): the current group is (path, fill,
        // stroke); `draws`/`draw_tail` are the already-closed ones. `_cur_has`
        // says whether the current group holds any geometry (so an empty group is
        // never appended), `_cur_open`/`_lastx`/`_lasty` carry the current pen
        // position so a style change mid-path resumes the stroke where it left
        // off instead of dropping the segment.
        ['draws', gpf()], ['draw_tail', gpf()],
        ['_lastx', gpf2()], ['_lasty', gpf2()],
        ['_cur_open', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        ['_cur_has', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        // 1 = even-odd (AIR's Graphics default: two same-direction nested drawRect
        // subpaths leave the inner rect hollow, measured temp/editprobe/Ed21 §E).
        // Baked `DefineShape4` geometry that sets UsesFillWindingRule uses even_odd
        // = 0 instead, and every new group re-applies the rule (swc.md §9 E).
        ['_even_odd', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        // Rasterisation clip (swc.md §9 E): AIR clips a DefineShape to its own
        // ShapeBounds, so a subpath that reaches past them is CUT at the bound.
        // Measured on skin.swc shape #319: its third subpath runs out to x=176.35
        // px while ShapeBounds ends at 124.45 — adl paints nothing beyond 124.45,
        // we painted the whole rect (the "extra block" in the cmp renders).
        // `_clip` = 0 for every Graphics built through the AS3 API.
        ['_clip', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Graphics', isStatic: false, isConst: false }],
        ['_clx', gpf2()], ['_cly', gpf2()], ['_clw', gpf2()], ['_clh', gpf2()],
      ]),
      methods: new Map([
        ['moveTo', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0)])],
        ['lineTo', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0)])],
        ['curveTo', gpm({ kind: 'void' }, [gnum('controlX', 0), gnum('controlY', 0), gnum('anchorX', 0), gnum('anchorY', 0)])],
        ['beginFill', gpm({ kind: 'void' }, [guint('color', 0), gnum('alpha', 1)])],
        // AIR: beginBitmapFill(bitmap:BitmapData, matrix:Matrix = null,
        // repeat:Boolean = true, smooth:Boolean = false). A null matrix is the
        // identity, i.e. the bitmap's own pixel rect at the shape's origin.
        ['beginBitmapFill', gpm({ kind: 'void' }, [
          { name: 'bitmap', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'matrix', type: 'Matrix', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'repeat', type: 'Boolean', defaultValue: { kind: 'Bool', value: true }, isRest: false },
          { name: 'smooth', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['endFill', gpm({ kind: 'void' }, [])],
        ['lineStyle', gpm({ kind: 'void' }, [
          gnum('thickness', 0), guint('color', 0), gnum('alpha', 1),
          // AIR's full parameter list (stage 98, clearing the away3d wall at
          // AwayStats.as:384): pixelHinting/scaleMode/caps/joints/miterLimit.
          // caps/joints/miterLimit are applied to the Skia stroke; pixelHinting
          // has no Skia equivalent and scaleMode only models "normal" (both are
          // accepted and documented in README's limitations).
          { name: 'pixelHinting', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          { name: 'scaleMode', type: 'String', defaultValue: { kind: 'Str', value: 'normal' }, isRest: false },
          { name: 'caps', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'joints', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
          gnum('miterLimit', 3),
        ])],
        ['beginGradientFill', gpm({ kind: 'void' }, [
          { name: 'type', type: 'String', defaultValue: null, isRest: false },
          { name: 'colors', type: 'Array', defaultValue: null, isRest: false },
          { name: 'alphas', type: 'Array', defaultValue: null, isRest: false },
          { name: 'ratios', type: 'Array', defaultValue: null, isRest: false },
          { name: 'matrix', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false },
        ])],
        ['drawRect', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0), gnum('width', 0), gnum('height', 0)])],
        ['drawRoundRect', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0), gnum('width', 0), gnum('height', 0), gnum('ellipseWidth', 0), gnum('ellipseHeight', 0)])],
        ['drawCircle', gpm({ kind: 'void' }, [gnum('x', 0), gnum('y', 0), gnum('radius', 0)])],
        // AIR: drawTriangles(vertices:Vector.<Number>, indices:Vector.<int> = null,
        // uvtData:Vector.<Number> = null, culling:String = "none"). Note the vertices
        // come FIRST here, unlike Context3D.drawTriangles (WireframeMapGenerator calls
        // g.drawTriangles(uvPositions, indexClone, null, TriangleCulling.NONE)).
        ['drawTriangles', gpm({ kind: 'void' }, [
          { name: 'vertices', type: 'Vector.<Number>', defaultValue: null, isRest: false },
          { name: 'indices', type: 'Vector.<int>', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'uvtData', type: 'Vector.<Number>', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'culling', type: 'String', defaultValue: { kind: 'Str', value: 'none' }, isRest: false },
        ])],
        ['clear', gpm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // Shape is a leaf drawable (not a container): one Graphics instance.
    const shpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Shape', isStatic: false, isConst: false });
    this.classMap.set('Shape', {
      fields: new Map([['graphics', shpf({ kind: 'object', className: 'Graphics' })]]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    // Bitmap draws a BitmapData; BitmapData holds raw RGBA pixels (getPixel/
    // setPixel) plus an optional decoded SkImage (loaded via the non-standard
    // loadFile hook) used by render().
    const bmpf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Bitmap', isStatic: false, isConst: false });
    this.classMap.set('Bitmap', {
      fields: new Map([['bitmapData', bmpf({ kind: 'object', className: 'BitmapData' })], ['smoothing', bmpf({ kind: 'bool' })]]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [{ name: 'bitmapData', type: 'BitmapData', defaultValue: { kind: 'Null' }, isRest: false }] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    const bdf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'BitmapData', isStatic: false, isConst: false });
    const bdm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'BitmapData', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('BitmapData', {
      fields: new Map([
        ['width', bdf({ kind: 'int' })],
        ['height', bdf({ kind: 'int' })],
        ['transparent', bdf({ kind: 'bool' })],
        ['pixels', bdf({ kind: 'null' })],
        ['image', bdf({ kind: 'null' })],
      ]),
      methods: new Map([
        ['getPixel', bdm({ kind: 'uint' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['setPixel', bdm({ kind: 'void' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
          { name: 'color', type: 'uint', defaultValue: null, isRest: false },
        ])],
        // getPixel32/setPixel32: the ARGB (alpha-inclusive) counterparts of
        // getPixel/setPixel. `pixels` stores straight ARGB 0xAARRGGBB, which is
        // exactly what these return/take (see the ARGB contract note in TODO.md
        // and swc.md §3.2). setPixel32 honors alpha only for a transparent
        // BitmapData, like AIR.
        ['getPixel32', bdm({ kind: 'uint' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['setPixel32', bdm({ kind: 'void' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
          { name: 'color', type: 'uint', defaultValue: null, isRest: false },
        ])],
        ['loadFile', bdm({ kind: 'void' }, [{ name: 'path', type: 'String', defaultValue: null, isRest: false }])],
        ['fillRect', bdm({ kind: 'void' }, [
          { name: 'rect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'color', type: 'uint', defaultValue: null, isRest: false },
        ])],
        ['draw', bdm({ kind: 'void' }, [
          { name: 'source', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'matrix', type: 'Matrix', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'colorTransform', type: 'ColorTransform', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'blendMode', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'clipRect', type: 'Rectangle', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'smoothing', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        ['applyFilter', bdm({ kind: 'void' }, [
          { name: 'sourceBitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'sourceRect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'destPoint', type: 'Point', defaultValue: null, isRest: false },
          { name: 'filter', type: 'BitmapFilter', defaultValue: null, isRest: false },
        ])],
        ['perlinNoise', bdm({ kind: 'void' }, [
          { name: 'baseX', type: 'Number', defaultValue: null, isRest: false },
          { name: 'baseY', type: 'Number', defaultValue: null, isRest: false },
          { name: 'numOctaves', type: 'uint', defaultValue: null, isRest: false },
          { name: 'randomSeed', type: 'int', defaultValue: null, isRest: false },
          { name: 'stitch', type: 'Boolean', defaultValue: null, isRest: false },
          { name: 'fractalNoise', type: 'Boolean', defaultValue: null, isRest: false },
        ])],
        ['dispose', bdm({ kind: 'void' }, [])],
        ['setPixels', bdm({ kind: 'void' }, [
          { name: 'rect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'inputByteArray', type: 'ByteArray', defaultValue: null, isRest: false },
        ])],
        ['copyPixels', bdm({ kind: 'void' }, [
          { name: 'sourceBitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'sourceRect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'destPoint', type: 'Point', defaultValue: null, isRest: false },
          { name: 'alphaBitmapData', type: 'BitmapData', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'alphaPoint', type: 'Point', defaultValue: { kind: 'Null' }, isRest: false },
          { name: 'mergeAlpha', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        ])],
        // copyChannel (stage 110, away3d SplatBlendBitmapTexture): straight 8-bit
        // channel transfer between two ARGB buffers. AIR's channel selectors are
        // BitmapDataChannel.RED/GREEN/BLUE/ALPHA == 1/2/4/8.
        ['copyChannel', bdm({ kind: 'void' }, [
          { name: 'sourceBitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
          { name: 'sourceRect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'destPoint', type: 'Point', defaultValue: null, isRest: false },
          { name: 'sourceChannel', type: 'uint', defaultValue: null, isRest: false },
          { name: 'destChannel', type: 'uint', defaultValue: null, isRest: false },
        ])],
        // clone/scroll/setVector/lock/unlock (stage 111, away3d walls: `BitmapData
        // has no method 'clone'` in SplatBlendBitmapTexture and `'scroll'` in
        // AwayStats). Signatures are AIR's: scroll(x:int, y:int), setVector(rect,
        // inputVector:Vector.<uint>), clone():BitmapData. lock/unlock exist in AIR
        // (deprecated there) and are accepted as a no-op: our pixel buffer is
        // always live, so there is nothing to stage or flush.
        ['clone', bdm({ kind: 'object', className: 'BitmapData' }, [])],
        ['scroll', bdm({ kind: 'void' }, [
          { name: 'x', type: 'int', defaultValue: null, isRest: false },
          { name: 'y', type: 'int', defaultValue: null, isRest: false },
        ])],
        ['setVector', bdm({ kind: 'void' }, [
          { name: 'rect', type: 'Rectangle', defaultValue: null, isRest: false },
          { name: 'inputVector', type: 'Vector.<uint>', defaultValue: null, isRest: false },
        ])],
        ['getVector', bdm({ kind: 'vector', elem: { kind: 'uint' } }, [
          { name: 'rect', type: 'Rectangle', defaultValue: null, isRest: false },
        ])],
        ['lock', bdm({ kind: 'void' }, [])],
        ['unlock', bdm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['rect', { returnType: { kind: 'object', className: 'Rectangle' }, params: [], owner: 'BitmapData', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [
        { name: 'width', type: 'int', defaultValue: null, isRest: false },
        { name: 'height', type: 'int', defaultValue: null, isRest: false },
        { name: 'transparent', type: 'Boolean', defaultValue: { kind: 'Bool', value: true }, isRest: false },
        { name: 'fillColor', type: 'uint', defaultValue: { kind: 'Num', value: 4294967295, isInt: true }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.display.BitmapDataChannel: uint channel selectors used by
    // BitmapData.copyChannel / DisplacementMapFilter componentX/Y.
    const bdc = (value: number): FieldInfo => ({ type: { kind: 'uint' }, init: { kind: 'Num', value, isInt: true }, visibility: 'public', owner: 'BitmapDataChannel', isStatic: true, isConst: true });
    this.classMap.set('BitmapDataChannel', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['RED', bdc(1)],
        ['GREEN', bdc(2)],
        ['BLUE', bdc(4)],
        ['ALPHA', bdc(8)],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.filters (stage 61): BitmapFilter abstract base + concrete filters.
    // These are value bundles (numeric fields); rasterization happens in
    // BitmapData_applyFilter via a separable repeated box blur (BlurFilter).
    const flf = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const flm = (ret: CType, params: Param[], owner: string): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('BitmapFilter', {
      fields: new Map(),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'BitmapFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('BlurFilter', {
      fields: new Map([
        ['blurX', flf({ kind: 'number' }, 'BlurFilter')],
        ['blurY', flf({ kind: 'number' }, 'BlurFilter')],
        ['quality', flf({ kind: 'int' }, 'BlurFilter')],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'BlurFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('DropShadowFilter', {
      fields: new Map([
        ['distance', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['angle', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['color', flf({ kind: 'uint' }, 'DropShadowFilter')],
        ['alpha', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['blurX', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['blurY', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['strength', flf({ kind: 'number' }, 'DropShadowFilter')],
        ['quality', flf({ kind: 'int' }, 'DropShadowFilter')],
        ['inner', flf({ kind: 'bool' }, 'DropShadowFilter')],
        ['knockout', flf({ kind: 'bool' }, 'DropShadowFilter')],
        ['hideObject', flf({ kind: 'bool' }, 'DropShadowFilter')],
        // C-runtime-only: skip painting the source under the shadow. Mirrors AS3's
        // hideObject, and carries the SWC CompositeSource bit for the same purpose.
        ['_shadow_only', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'DropShadowFilter', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'DropShadowFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'distance', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'angle', type: 'Number', defaultValue: { kind: 'Num', value: 45, isInt: true }, isRest: false },
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 4, isInt: true }, isRest: false },
        { name: 'strength', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'inner', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'knockout', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'hideObject', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('GlowFilter', {
      fields: new Map([
        ['color', flf({ kind: 'uint' }, 'GlowFilter')],
        ['alpha', flf({ kind: 'number' }, 'GlowFilter')],
        ['blurX', flf({ kind: 'number' }, 'GlowFilter')],
        ['blurY', flf({ kind: 'number' }, 'GlowFilter')],
        ['strength', flf({ kind: 'number' }, 'GlowFilter')],
        ['quality', flf({ kind: 'int' }, 'GlowFilter')],
        ['inner', flf({ kind: 'bool' }, 'GlowFilter')],
        ['knockout', flf({ kind: 'bool' }, 'GlowFilter')],
        // Draw the halo WITHOUT the source on top. AS3 has no such flag on a glow;
        // the SWC `FILTERLIST`'s CompositeSource bit does (swc.md §9.2 F4), and it
        // reaches the rasterizer through this C-runtime-only field (never visible
        // to AS3 name resolution, exactly like Sprite._graphics).
        ['_shadow_only', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'GlowFilter', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['clone', flm({ kind: 'object', className: 'BitmapFilter' }, [], 'GlowFilter')],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 16711680, isInt: true }, isRest: false },
        { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'blurX', type: 'Number', defaultValue: { kind: 'Num', value: 6, isInt: true }, isRest: false },
        { name: 'blurY', type: 'Number', defaultValue: { kind: 'Num', value: 6, isInt: true }, isRest: false },
        { name: 'strength', type: 'Number', defaultValue: { kind: 'Num', value: 2, isInt: true }, isRest: false },
        { name: 'quality', type: 'int', defaultValue: { kind: 'Num', value: 1, isInt: true }, isRest: false },
        { name: 'inner', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'knockout', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
      ] },
      superClass: 'BitmapFilter',
      isFinal: false,
      implements: [],
    });
    this.classMap.set('BitmapFilterQuality', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map([
        ['LOW', { type: { kind: 'int' }, init: { kind: 'Num', value: 1, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
        ['MEDIUM', { type: { kind: 'int' }, init: { kind: 'Num', value: 2, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
        ['HIGH', { type: { kind: 'int' }, init: { kind: 'Num', value: 3, isInt: true }, visibility: 'public', owner: 'BitmapFilterQuality', isStatic: true, isConst: true }],
      ]),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.utils.ByteArray — growable big-endian byte buffer with read/write
    // primitives and zlib compress/uncompress (stage 36 runtime support). `data`
    // is the raw byte buffer; `length`/`position` are AS3-visible; `capacity` is
    // internal. `bytesAvailable` is a read-only getter (length - position).
    const bayf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'ByteArray', isStatic: false, isConst: false });
    const bayg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'ByteArray', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const baym = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'ByteArray', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('ByteArray', {
      fields: new Map([
        ['data', bayf({ kind: 'null' })],
        // `length` stays a physical slot (the generated struct needs it) but is
        // resolved through the accessor pair below, exactly like
        // DisplayObject.cacheAsBitmap.
        ['length', bayf({ kind: 'int' })],
        ['capacity', bayf({ kind: 'int' })],
        ['position', bayf({ kind: 'int' })],
        // endian/objectEncoding are IDataInput/IDataOutput accessors in AIR;
        // `isAccessor` marks the C slot as that accessor pair for pass 4.
        ['endian', { ...bayf({ kind: 'string' }), isAccessor: true }],
        // ObjectEncoding.AMF3 is the documented (and measured) default for both
        // ByteArray and URLStream; readObject/writeObject consult it.
        ['objectEncoding', { ...bayf({ kind: 'uint' }), isAccessor: true }],
      ]),
      methods: new Map([
        ['writeByte', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeShort', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeInt', baym({ kind: 'void' }, [{ name: 'v', type: 'int', defaultValue: null, isRest: false }])],
        ['writeUnsignedInt', baym({ kind: 'void' }, [{ name: 'v', type: 'uint', defaultValue: null, isRest: false }])],
        ['writeFloat', baym({ kind: 'void' }, [{ name: 'v', type: 'Number', defaultValue: null, isRest: false }])],
        // IDataOutput declares writeDouble alongside writeFloat; readDouble has
        // been here since stage 36, so the asymmetric half was an omission.
        ['writeDouble', baym({ kind: 'void' }, [{ name: 'v', type: 'Number', defaultValue: null, isRest: false }])],
        ['writeUTFBytes', baym({ kind: 'void' }, [{ name: 's', type: 'String', defaultValue: null, isRest: false }])],
        ['writeUTF', baym({ kind: 'void' }, [{ name: 'value', type: 'String', defaultValue: null, isRest: false }])],
        ['writeBytes', baym({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'offset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'length', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
        ['readByte', baym({ kind: 'int' }, [])],
        ['readUnsignedByte', baym({ kind: 'uint' }, [])],
        ['readShort', baym({ kind: 'int' }, [])],
        ['readUnsignedShort', baym({ kind: 'uint' }, [])],
        ['readInt', baym({ kind: 'int' }, [])],
        ['readUnsignedInt', baym({ kind: 'uint' }, [])],
        ['readFloat', baym({ kind: 'number' }, [])],
        ['readDouble', baym({ kind: 'number' }, [])],
        ['readUTF', baym({ kind: 'string' }, [])],
        ['readUTFBytes', baym({ kind: 'string' }, [{ name: 'length', type: 'uint', defaultValue: null, isRest: false }])],
        // IDataInput/IDataOutput multi-byte + boolean (stage 94-4). readMultiByte
        // decodes with the named charset (utf-8 / unicode / gbk / system code
        // pages), writeMultiByte encodes into it; both honour `endian` for the
        // UTF-16 family. readBoolean treats any non-zero byte as true and
        // writeBoolean emits one byte, both measured on adl 51.4.1.
        ['readMultiByte', baym({ kind: 'string' }, [
          { name: 'length', type: 'uint', defaultValue: null, isRest: false },
          { name: 'charSet', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['writeMultiByte', baym({ kind: 'void' }, [
          { name: 'value', type: 'String', defaultValue: null, isRest: false },
          { name: 'charSet', type: 'String', defaultValue: null, isRest: false },
        ])],
        ['readBoolean', baym({ kind: 'bool' }, [])],
        ['writeBoolean', baym({ kind: 'void' }, [{ name: 'value', type: 'Boolean', defaultValue: null, isRest: false }])],
        // AMF3 object serialization (stage 94-4). readObject/writeObject are
        // driven by `objectEncoding` (AMF3 only; AMF0 throws -- registered).
        ['readObject', baym({ kind: 'any' }, [])],
        ['writeObject', baym({ kind: 'void' }, [{ name: 'object', type: 'any', defaultValue: null, isRest: false }])],
        ['readBytes', baym({ kind: 'void' }, [
          { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
          { name: 'offset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          { name: 'length', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        ])],
        // AIR's algorithm parameter: "zlib" (the default; "deflate" is accepted as
        // the same thing) or "lzma". The lzma codec is not implemented by this
        // subset: it fails loudly at runtime instead of silently producing zlib
        // output (AWD2Parser passes COMPRESSIONMODE_LZMA).
        ['compress', baym({ kind: 'void' }, [{ name: 'algorithm', type: 'String', defaultValue: { kind: 'Str', value: 'zlib' }, isRest: false }])],
        ['uncompress', baym({ kind: 'void' }, [{ name: 'algorithm', type: 'String', defaultValue: { kind: 'Str', value: 'zlib' }, isRest: false }])],
        ['clear', baym({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        // bytesAvailable is declared uint on IDataInput (and the C getter returns
        // unsigned), unlike `length`, which AIR types as int.
        ['bytesAvailable', bayg({ kind: 'uint' })],
        // `length` is an accessor on ByteArray: reading it is trivial, assigning
        // it must resize the backing buffer (see ByteArray_set_length).
        ['length', bayg({ kind: 'int' })],
      ]),
      setters: new Map([
        ['length', baym({ kind: 'void' }, [{ name: 'value', type: 'uint', defaultValue: null, isRest: false }])],
      ]),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: ['IDataInput', 'IDataOutput'],
    });
    // flash.utils.Endian — string constants for ByteArray.endian.
    constClass('Endian', { BIG_ENDIAN: 'bigEndian', LITTLE_ENDIAN: 'littleEndian' });
    // flash.text — stage 38.
    const tff = (t: CType, owner: string): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    this.classMap.set('TextFormat', {
      fields: new Map([
        ['font', tff({ kind: 'string' }, 'TextFormat')],
        ['size', tff({ kind: 'number' }, 'TextFormat')],
        ['color', tff({ kind: 'uint' }, 'TextFormat')],
        ['bold', tff({ kind: 'bool' }, 'TextFormat')],
        ['italic', tff({ kind: 'bool' }, 'TextFormat')],
        ['underline', tff({ kind: 'bool' }, 'TextFormat')],
        ['leading', tff({ kind: 'number' }, 'TextFormat')],
        ['align', tff({ kind: 'string' }, 'TextFormat')],
        ['kerning', tff({ kind: 'bool' }, 'TextFormat')],
        ['letterSpacing', tff({ kind: 'number' }, 'TextFormat')],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'font', type: 'String', defaultValue: { kind: 'Null' }, isRest: false },
        { name: 'size', type: 'Number', defaultValue: { kind: 'Num', value: 12, isInt: false }, isRest: false },
        { name: 'color', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
        { name: 'bold', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'italic', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
        { name: 'leading', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.text.StyleSheet: Starling only passes it through as a nullable value
    // (no CSS parsing is exercised), so it is modeled as a bare Object subclass.
    this.classMap.set('StyleSheet', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.net.NetStream (stage 110): the dynamic `client` slot (Starling injects
    // an onMetaData handler through it) plus the playback surface away3d's
    // SimpleVideoPlayer drives. Construction semantics measured on adl 51.4.1
    // (temp/videoprobe): a null connection is ArgumentError #2007, an unconnected
    // one Error #2126, and `client` defaults to the stream itself.
    const nsm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'NetStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const nsv = (name: string, t: ASType): Param => ({ name, type: t, defaultValue: { kind: 'Null' }, isRest: false });
    const nsf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'private', owner: 'NetStream', isStatic: false, isConst: false });
    this.classMap.set('NetStream', {
      fields: new Map([
        ['client', { type: { kind: 'object', className: 'Object' }, init: null, visibility: 'public', owner: 'NetStream', isStatic: false, isConst: false }],
        ['checkPolicyFile', { type: { kind: 'bool' }, init: { kind: 'Bool', value: false }, visibility: 'public', owner: 'NetStream', isStatic: false, isConst: false }],
        // The stream's own SoundTransform (volume 1 / pan 0 until assigned), the
        // value AIR reports for a freshly built stream (measured).
        ['_snd', nsf({ kind: 'object', className: 'SoundTransform' })],
      ]),
      methods: new Map([
        // play() is where this subset's missing media transport becomes
        // observable, so it fails loudly instead of pretending to play (emit.ts).
        ['play', nsm({ kind: 'void' }, [nsv('url', 'String')])],
        ['pause', nsm({ kind: 'void' }, [])],
        ['resume', nsm({ kind: 'void' }, [])],
        ['togglePause', nsm({ kind: 'void' }, [])],
        ['seek', nsm({ kind: 'void' }, [{ name: 'offset', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false }])],
        ['close', nsm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['soundTransform', { returnType: { kind: 'object', className: 'SoundTransform' }, params: [], owner: 'NetStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        // time: seconds of decoded playback. Nothing is ever decoded here, so this
        // stays 0 — which is also what AIR reports for a stream that has not
        // started (seek() alone does not move the playhead; measured).
        ['time', { returnType: { kind: 'number' }, params: [], owner: 'NetStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map([
        ['soundTransform', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'SoundTransform', defaultValue: null, isRest: false }], owner: 'NetStream', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
      ]),
      // AIR requires the connection argument (`new NetStream(nc)`); keeping it
      // required makes the argument-count error surface at compile time, and the
      // constructor body applies AIR's null/not-connected rejections.
      constructor: { params: [{ name: 'connection', type: 'NetConnection', defaultValue: null, isRest: false }] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.net.NetConnection (stage 110): SimpleVideoPlayer opens a null (local)
    // connection and listens for status/security/io/async events. There is no media
    // transport in this subset, so connect(null) only marks the connection as
    // connected (AIR's local case: connected == true, uri == null — both measured
    // with temp/videoprobe) while connect(url) stays unconnected and no
    // NetStatusEvent ever arrives (reported as a gap, not silently faked).
    const ncm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'NetConnection', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('NetConnection', {
      fields: new Map([
        ['client', { type: { kind: 'object', className: 'Object' }, init: null, visibility: 'public', owner: 'NetConnection', isStatic: false, isConst: false }],
        ['uri', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'NetConnection', isStatic: false, isConst: false }],
        ['_connected', { type: { kind: 'bool' }, init: null, visibility: 'private', owner: 'NetConnection', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['connect', ncm({ kind: 'void' }, [nsv('command', 'String')])],
        ['close', ncm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['connected', { returnType: { kind: 'bool' }, params: [], owner: 'NetConnection', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
      ]),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'EventDispatcher',
      isFinal: false,
      implements: [],
    });
    // flash.media.Video (stage 110): a display object whose surface receives a
    // NetStream or Camera feed. Measured on adl 51.4.1 (temp/videoprobe):
    // `new Video()` is 320x240, the constructor arguments are the surface size,
    // and width/height are that stored rect (assigning one leaves the other)
    // while videoWidth/videoHeight stay 0 until real frames arrive. Since this
    // subset never decodes frames, videoWidth/videoHeight are always 0 and the
    // surface stays empty (the same documented gap as NetStream.play).
    const vdm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Video', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const vdg = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Video', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const vds = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Video', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    this.classMap.set('Video', {
      fields: new Map([
        ['deblocking', { type: { kind: 'int' }, init: { kind: 'Num', value: 0, isInt: true }, visibility: 'public', owner: 'Video', isStatic: false, isConst: false }],
        ['smoothing', { type: { kind: 'bool' }, init: { kind: 'Bool', value: false }, visibility: 'public', owner: 'Video', isStatic: false, isConst: false }],
        ['_videoW', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Video', isStatic: false, isConst: false }],
        ['_videoH', { type: { kind: 'int' }, init: null, visibility: 'private', owner: 'Video', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['attachNetStream', vdm({ kind: 'void' }, [nsv('netStream', 'NetStream')])],
        ['attachCamera', vdm({ kind: 'void' }, [nsv('camera', 'Object')])],
        ['clear', vdm({ kind: 'void' }, [])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        // Video OWNS width/height (it overrides DisplayObject's bounds-derived
        // pair): AIR's Video rect is a stored size that does not scale content.
        ['width', vdg({ kind: 'number' })],
        ['height', vdg({ kind: 'number' })],
        ['videoWidth', vdg({ kind: 'int' })],
        ['videoHeight', vdg({ kind: 'int' })],
      ]),
      setters: new Map([
        ['width', vds('Number')],
        ['height', vds('Number')],
      ]),
      constructor: { params: [
        { name: 'width', type: 'int', defaultValue: { kind: 'Num', value: 320, isInt: true }, isRest: false },
        { name: 'height', type: 'int', defaultValue: { kind: 'Num', value: 240, isInt: true }, isRest: false },
      ] },
      superClass: 'DisplayObject',
      isFinal: false,
      implements: [],
    });
    // flash.xml.Namespace: E4X namespace objects are transparent in the AOT
    // translation (`ns::member` qualifiers are dropped), so Namespace is modeled
    // as a bare Object subclass whose value is never meaningfully read.
    this.classMap.set('Namespace', {
      fields: new Map(),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    // flash.text.Font: only enumerateFonts() and the per-font string metadata are
    // exercised (Starling's SystemUtil.isEmbeddedFont probes the device font list).
    this.classMap.set('Font', {
      fields: new Map([
        ['fontName', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Font', isStatic: false, isConst: false }],
        ['fontStyle', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Font', isStatic: false, isConst: false }],
        ['fontType', { type: { kind: 'string' }, init: null, visibility: 'public', owner: 'Font', isStatic: false, isConst: false }],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map([
        ['enumerateFonts', { returnType: { kind: 'array' }, params: [{ name: 'enumerateDeviceFonts', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false }], owner: 'Font', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });
    constClass('FontStyle', { REGULAR: 'regular', BOLD: 'bold', ITALIC: 'italic', BOLD_ITALIC: 'boldItalic' });
    constClass('GradientType', { LINEAR: 'linear', RADIAL: 'radial' });
    const txf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'TextField', isStatic: false, isConst: false });
    const txg = (ret: CType, name: string): MethodInfo => ({ returnType: ret, params: [], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const txm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    this.classMap.set('TextField', {
      fields: new Map([
        // TextField is the one DisplayObject that overrides width/height: AIR keeps
        // a real field size there (setting `width` resizes the field instead of
        // scaling, and the reported width is fieldSize * scaleX). Since stage 94·5
        // DisplayObject.width/height are accessors, so the raw field size needs its
        // own storage; it stays PRIVATE because AS3 sees the accessors only.
        ['_fieldWidth', { type: { kind: 'number' }, init: null, visibility: 'private', owner: 'TextField', isStatic: false, isConst: false }],
        ['_fieldHeight', { type: { kind: 'number' }, init: null, visibility: 'private', owner: 'TextField', isStatic: false, isConst: false }],
        ['text', txf({ kind: 'string' })],
        // type/maxChars back AIR's editable-text model (stage 94·7). `type` holds
        // TextFieldType.DYNAMIC ("dynamic") by default, so nothing is editable
        // until the app opts in; `maxChars` 0 means "no limit". Both are plain
        // fields: adl keeps text and selection untouched across a `type`
        // assignment, which a field write reproduces exactly (measured).
        ['type', txf({ kind: 'string' })],
        ['maxChars', txf({ kind: 'int' })],
        // displayAsPassword / restrict exist so the AIR-visible surface matches adl
        // (measured defaults: false / null). `restrict` filtering is implemented in
        // the edit path (阶段九十四·十四, see as_tf_restrict_char in emit.ts); password
        // MASKING is still unimplemented — a password field renders its text in the
        // clear — and is registered in TODO.md 遗留 rather than silently ignored.
        // `tabEnabled` is NOT
        // redeclared here: it comes from InteractiveObject (a duplicate would be
        // mangled into a second slot), and TextField's ctor just flips the inherited
        // field to AIR's TextField default (true, measured).
        ['displayAsPassword', txf({ kind: 'bool' })],
        ['restrict', txf({ kind: 'string' })],
        ['defaultTextFormat', txf({ kind: 'object', className: 'TextFormat' })],
        ['multiline', txf({ kind: 'bool' })],
        ['wordWrap', txf({ kind: 'bool' })],
        ['background', txf({ kind: 'bool' })],
        ['backgroundColor', txf({ kind: 'uint' })],
        // border/borderColor outline the field box. Measured on adl 51.4.1
        // (temp/editprobe/src/Ed6.as, pixel-scanned via BitmapData.draw): defaults
        // are false / 0x000000, the outline is FOUR crisp 1px lines on the OUTER
        // edge of (0,0,width,height) -- i.e. pixels x in {0,width}, y in {0,height}
        // -- drawn over the background and scaled with the field. The colour is
        // 24-bit RGB (the alpha byte is DROPPED on write -- see the setters map).
        // See as_render_object_content in emit.ts for the drawing and
        // as_render_bounds for why the bake box grows by one pixel.
        ['border', txf({ kind: 'bool' })],
        ['borderColor', txf({ kind: 'uint' })],
        ['scrollV', txf({ kind: 'int' })],
        ['hscroll', txf({ kind: 'bool' })],
        ['selectable', txf({ kind: 'bool' })],
        ['autoSize', txf({ kind: 'string' })],
        ['textColor', txf({ kind: 'uint' })],
        ['embedFonts', txf({ kind: 'bool' })],
        ['antiAliasType', txf({ kind: 'string' })],
        ['styleSheet', txf({ kind: 'object', className: 'StyleSheet' })],
      ]),
      methods: new Map([
        // getLineMetrics(index) returns a fresh flash.text.TextLineMetrics; an
        // out-of-range index throws RangeError #2006 (measured on adl 51.4.1,
        // temp/metricprobe/Metrics6.as).
        ['getLineMetrics', txm({ kind: 'object', className: 'TextLineMetrics' }, [{ name: 'index', type: 'int', defaultValue: null, isRest: false }])],
        ['appendText', txm({ kind: 'void' }, [{ name: 's', type: 'String', defaultValue: null, isRest: false }])],
        ['setSelection', txm({ kind: 'void' }, [{ name: 'begin', type: 'int', defaultValue: null, isRest: false }, { name: 'end', type: 'int', defaultValue: null, isRest: false }])],
        ['setTextFormat', txm({ kind: 'void' }, [{ name: 'format', type: 'TextFormat', defaultValue: null, isRest: false }, { name: 'begin', type: 'int', defaultValue: { kind: 'Num', value: -1, isInt: true }, isRest: false }, { name: 'end', type: 'int', defaultValue: { kind: 'Num', value: -1, isInt: true }, isRest: false }])],
      ]),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map([
        ['textWidth', txg({ kind: 'number' }, 'textWidth')],
        ['textHeight', txg({ kind: 'number' }, 'textHeight')],
        ['maxScrollV', txg({ kind: 'int' }, 'maxScrollV')],
        ['numLines', txg({ kind: 'int' }, 'numLines')],
        ['maxScrollH', txg({ kind: 'int' }, 'maxScrollH')],
        ['scrollH', txg({ kind: 'int' }, 'scrollH')],
        ['selectionBeginIndex', txg({ kind: 'int' }, 'selectionBeginIndex')],
        ['selectionEndIndex', txg({ kind: 'int' }, 'selectionEndIndex')],
        ['caretIndex', txg({ kind: 'int' }, 'caretIndex')],
        ['htmlText', txg({ kind: 'string' }, 'htmlText')],
      ]),
      setters: new Map([
        // `text` stays a FIELD so reads stay a plain `tf->text` load, but writes go
        // through a setter: AIR's `.text = ...` replaces the whole content, dropping
        // any rich-text runs a previous htmlText / setTextFormat installed. As a raw
        // field write it silently kept replaying them (see emit.ts TextField_set_text).
        ['text', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'String', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ['htmlText', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'String', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ['scrollH', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'int', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        // `type` also stays a FIELD (reads are a plain load) with a setter, because
        // AIR's type setter has a SIDE EFFECT: when the value actually changes it
        // refreshes tabEnabled to (type == "input") — measured on adl 51.4.1
        // (temp/editprobe/src/Def2.as: dynamic -> false, type=INPUT -> true, back to
        // dynamic -> false, and re-assigning the SAME value leaves a manually set
        // tabEnabled alone). See emit.ts TextField_set_type.
        ['type', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'String', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        // The colour properties stay FIELDS (reads are a plain load) with setters
        // that DROP the alpha byte — AIR keeps only 24 bits of RGB, so the top byte
        // is gone from the read-back as well. Measured on adl 51.4.1
        // (temp/editprobe/tracesrc/Ed8.as): 0x8000FF00 -> 0xff00 for backgroundColor
        // and textColor, 0xFFFFFFFF -> 0xffffff for borderColor. See
        // TextField_set_borderColor / _set_backgroundColor / _set_textColor.
        ['borderColor', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'uint', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ['backgroundColor', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'uint', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ['textColor', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'uint', defaultValue: null, isRest: false }], owner: 'TextField', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
      ]),
      constructor: { params: [] },
      superClass: 'InteractiveObject',
      isFinal: false,
      implements: [],
    });
    // flash.text.TextLineMetrics — the six-Number value type returned by
    // TextField.getLineMetrics. AIR's ctor takes all six in the documented order
    // (x, width, height, ascent, descent, leading); measured on adl 51.4.1
    // (temp/metricprobe/Metrics6.as): `new TextLineMetrics(1,2,3,4,5,6)` reads back
    // x=1 w=2 h=3 asc=4 desc=5 lead=6, and the fields are writable.
    const tlmf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'TextLineMetrics', isStatic: false, isConst: false });
    this.classMap.set('TextLineMetrics', {
      fields: new Map([
        ['x', tlmf({ kind: 'number' })],
        ['width', tlmf({ kind: 'number' })],
        ['height', tlmf({ kind: 'number' })],
        ['ascent', tlmf({ kind: 'number' })],
        ['descent', tlmf({ kind: 'number' })],
        ['leading', tlmf({ kind: 'number' })],
      ]),
      methods: new Map(),
      staticFields: new Map(),
      staticMethods: new Map(),
      getters: new Map(),
      setters: new Map(),
      constructor: { params: [
        { name: 'x', type: 'Number', defaultValue: null, isRest: false },
        { name: 'width', type: 'Number', defaultValue: null, isRest: false },
        { name: 'height', type: 'Number', defaultValue: null, isRest: false },
        { name: 'ascent', type: 'Number', defaultValue: null, isRest: false },
        { name: 'descent', type: 'Number', defaultValue: null, isRest: false },
        { name: 'leading', type: 'Number', defaultValue: null, isRest: false },
      ] },
      superClass: 'Object',
      isFinal: false,
      implements: [],
    });

    // flash.geom (stage 58): pure 2D value/reference types. Point/Rectangle/
    // Matrix/ColorTransform hold only Number fields (no GC pointers), so their
    // structs are plain `double` bundles. Transform holds Matrix/ColorTransform
    // object references and participates in GC marking via its prop table.
    const gegnum = (name: string, def: number): Param => ({ name, type: 'Number', defaultValue: { kind: 'Num', value: def, isInt: false }, isRest: false });
    const gefield = (owner: string) => (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner, isStatic: false, isConst: false });
    const gemethod = (owner: string) => (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
    const gegetter = (owner: string) => (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
    const gesetter = (owner: string) => (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner, visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
    const gestatic = (owner: string) => (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner, visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false });
    const geptParam = (name: string): Param => ({ name, type: 'Point', defaultValue: null, isRest: false });
    // Point: x/y Number, `length` read-only, static distance/interpolate/polar.
    // add/subtract/clone return NEW points; offset/normalize/setTo/copyFrom mutate.
    {
      const pf = gefield('Point');
      const pm = gemethod('Point');
      const pg = gegetter('Point');
      const ps = gestatic('Point');
      this.classMap.set('Point', {
        fields: new Map([['x', pf({ kind: 'number' })], ['y', pf({ kind: 'number' })]]),
        methods: new Map([
          ['add', pm({ kind: 'object', className: 'Point' }, [geptParam('v')])],
          ['subtract', pm({ kind: 'object', className: 'Point' }, [geptParam('v')])],
          ['offset', pm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['normalize', pm({ kind: 'void' }, [gegnum('thickness', 0)])],
          ['setTo', pm({ kind: 'void' }, [gegnum('xa', 0), gegnum('ya', 0)])],
          ['copyFrom', pm({ kind: 'void' }, [geptParam('sourcePoint')])],
          ['clone', pm({ kind: 'object', className: 'Point' }, [])],
          ['equals', pm({ kind: 'bool' }, [geptParam('toCompare')])],
          ['toString', pm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map([
          ['distance', ps({ kind: 'number' }, [geptParam('pt1'), geptParam('pt2')])],
          ['interpolate', ps({ kind: 'object', className: 'Point' }, [geptParam('pt1'), geptParam('pt2'), gegnum('f', 0)])],
          ['polar', ps({ kind: 'object', className: 'Point' }, [gegnum('len', 0), gegnum('angle', 0)])],
        ]),
        getters: new Map([['length', pg({ kind: 'number' })]]),
        setters: new Map(),
        constructor: { params: [gegnum('x', 0), gegnum('y', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Rectangle: x/y/width/height; top/bottom/left/right are read-only getters.
    // intersection/union/clone return NEW rectangles; inflate/offset mutate.
    {
      const rf = gefield('Rectangle');
      const rm = gemethod('Rectangle');
      const rg = gegetter('Rectangle');
      const rs = gesetter('Rectangle');
      const rp = (name: string): Param => ({ name, type: 'Rectangle', defaultValue: null, isRest: false });
      this.classMap.set('Rectangle', {
        fields: new Map([['x', rf({ kind: 'number' })], ['y', rf({ kind: 'number' })], ['width', rf({ kind: 'number' })], ['height', rf({ kind: 'number' })]]),
        methods: new Map([
          ['intersection', rm({ kind: 'object', className: 'Rectangle' }, [rp('toIntersect')])],
          ['union', rm({ kind: 'object', className: 'Rectangle' }, [rp('toUnion')])],
          ['contains', rm({ kind: 'bool' }, [gegnum('x', 0), gegnum('y', 0)])],
          ['containsPoint', rm({ kind: 'bool' }, [geptParam('point')])],
          ['containsRect', rm({ kind: 'bool' }, [rp('rect')])],
          ['intersects', rm({ kind: 'bool' }, [rp('toIntersect')])],
          ['equals', rm({ kind: 'bool' }, [rp('toCompare')])],
          ['inflate', rm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['offset', rm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['clone', rm({ kind: 'object', className: 'Rectangle' }, [])],
          ['copyFrom', rm({ kind: 'void' }, [rp('sourceRect')])],
          ['setTo', rm({ kind: 'void' }, [gegnum('x', 0), gegnum('y', 0), gegnum('width', 0), gegnum('height', 0)])],
          ['setEmpty', rm({ kind: 'void' }, [])],
          ['isEmpty', rm({ kind: 'bool' }, [])],
          ['toString', rm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map([
          ['top', rg({ kind: 'number' })],
          ['bottom', rg({ kind: 'number' })],
          ['left', rg({ kind: 'number' })],
          ['right', rg({ kind: 'number' })],
        ]),
        // flash.geom.Rectangle exposes top/bottom/left/right as getter/setter
        // pairs: `left`/`top` move the origin, `right`/`bottom` resize the span.
        setters: new Map([
          ['top', rs('Number')],
          ['bottom', rs('Number')],
          ['left', rs('Number')],
          ['right', rs('Number')],
        ]),
        constructor: { params: [gegnum('x', 0), gegnum('y', 0), gegnum('width', 0), gegnum('height', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Matrix: a/b/c/d/tx/ty 2D affine transform; concat/invert/identity/translate/
    // scale/rotate mutate `this`; transformPoint returns a new Point.
    {
      const mf = gefield('Matrix');
      const mm = gemethod('Matrix');
      const mp = (name: string): Param => ({ name, type: 'Matrix', defaultValue: null, isRest: false });
      this.classMap.set('Matrix', {
        fields: new Map([['a', mf({ kind: 'number' })], ['b', mf({ kind: 'number' })], ['c', mf({ kind: 'number' })], ['d', mf({ kind: 'number' })], ['tx', mf({ kind: 'number' })], ['ty', mf({ kind: 'number' })]]),
        methods: new Map([
          ['identity', mm({ kind: 'void' }, [])],
          ['translate', mm({ kind: 'void' }, [gegnum('dx', 0), gegnum('dy', 0)])],
          ['scale', mm({ kind: 'void' }, [gegnum('sx', 0), gegnum('sy', 0)])],
          ['rotate', mm({ kind: 'void' }, [gegnum('angle', 0)])],
          ['concat', mm({ kind: 'void' }, [mp('m')])],
          ['invert', mm({ kind: 'void' }, [])],
          ['transformPoint', mm({ kind: 'object', className: 'Point' }, [geptParam('point')])],
          ['deltaTransformPoint', mm({ kind: 'object', className: 'Point' }, [geptParam('point')])],
          ['createBox', mm({ kind: 'void' }, [gegnum('scaleX', 0), gegnum('scaleY', 0), gegnum('rotation', 0), gegnum('tx', 0), gegnum('ty', 0)])],
          ['createGradientBox', mm({ kind: 'void' }, [gegnum('width', 0), gegnum('height', 0), gegnum('rotation', 0), gegnum('tx', 0), gegnum('ty', 0)])],
          ['clone', mm({ kind: 'object', className: 'Matrix' }, [])],
          ['copyFrom', mm({ kind: 'void' }, [mp('sourceMatrix')])],
          ['setTo', mm({ kind: 'void' }, [gegnum('a', 0), gegnum('b', 0), gegnum('c', 0), gegnum('d', 0), gegnum('tx', 0), gegnum('ty', 0)])],
          ['toString', mm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [gegnum('a', 1), gegnum('b', 0), gegnum('c', 0), gegnum('d', 1), gegnum('tx', 0), gegnum('ty', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // ColorTransform: 8 Number channels (4 multipliers default 1, 4 offsets
    // default 0); concat composes `this = this * second`.
    {
      const cf = gefield('ColorTransform');
      const cm = gemethod('ColorTransform');
      const cp = (name: string): Param => ({ name, type: 'ColorTransform', defaultValue: null, isRest: false });
      this.classMap.set('ColorTransform', {
        fields: new Map([
          ['redMultiplier', cf({ kind: 'number' })], ['greenMultiplier', cf({ kind: 'number' })], ['blueMultiplier', cf({ kind: 'number' })], ['alphaMultiplier', cf({ kind: 'number' })],
          ['redOffset', cf({ kind: 'number' })], ['greenOffset', cf({ kind: 'number' })], ['blueOffset', cf({ kind: 'number' })], ['alphaOffset', cf({ kind: 'number' })],
        ]),
        methods: new Map([
          ['concat', cm({ kind: 'void' }, [cp('second')])],
          ['toString', cm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [gegnum('redMultiplier', 1), gegnum('greenMultiplier', 1), gegnum('blueMultiplier', 1), gegnum('alphaMultiplier', 1), gegnum('redOffset', 0), gegnum('greenOffset', 0), gegnum('blueOffset', 0), gegnum('alphaOffset', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Transform: holds a Matrix and ColorTransform (identity by default). Wiring
    // to DisplayObject.transform (applying Matrix to the Skia canvas) is deferred
    // to a later stage; this provides the value/reference accessor surface.
    {
      const tf = gefield('Transform');
      this.classMap.set('Transform', {
        fields: new Map([
          ['matrix', tf({ kind: 'object', className: 'Matrix' })],
          ['colorTransform', tf({ kind: 'object', className: 'ColorTransform' })],
        ]),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map(),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Vector3D (flash.geom): a 4-component vector, a pure double bundle like Point.
    // add/subtract/crossProduct/clone return NEW vectors; scaleBy/negate/normalize
    // mutate `this`; normalize returns the pre-normalization length.
    {
      const vf = gefield('Vector3D');
      const vm = gemethod('Vector3D');
      const vg = gegetter('Vector3D');
      const vs = gestatic('Vector3D');
      const v3 = (name: string): Param => ({ name, type: 'Vector3D', defaultValue: null, isRest: false });
      const v3num = (v: number): Expr => ({ kind: 'Num', value: v, isInt: true });
      const v3axis = (x: number, y: number, z: number): Expr => ({ kind: 'New', className: 'Vector3D', args: [v3num(x), v3num(y), v3num(z), v3num(0)] });
      const v3static = (x: number, y: number, z: number): FieldInfo => ({ type: { kind: 'object', className: 'Vector3D' }, init: v3axis(x, y, z), visibility: 'public', owner: 'Vector3D', isStatic: true, isConst: false });
      this.classMap.set('Vector3D', {
        fields: new Map([
          ['x', vf({ kind: 'number' })], ['y', vf({ kind: 'number' })], ['z', vf({ kind: 'number' })], ['w', vf({ kind: 'number' })],
        ]),
        methods: new Map([
          ['add', vm({ kind: 'object', className: 'Vector3D' }, [v3('a')])],
          ['subtract', vm({ kind: 'object', className: 'Vector3D' }, [v3('a')])],
          ['scaleBy', vm({ kind: 'void' }, [gegnum('s', 0)])],
          ['negate', vm({ kind: 'void' }, [])],
          ['normalize', vm({ kind: 'number' }, [])],
          ['dotProduct', vm({ kind: 'number' }, [v3('a')])],
          ['crossProduct', vm({ kind: 'object', className: 'Vector3D' }, [v3('a')])],
          ['clone', vm({ kind: 'object', className: 'Vector3D' }, [])],
          ['copyFrom', vm({ kind: 'void' }, [v3('sourceVector3D')])],
          ['setTo', vm({ kind: 'void' }, [gegnum('x', 0), gegnum('y', 0), gegnum('z', 0)])],
          ['project', vm({ kind: 'void' }, [])],
          ['equals', vm({ kind: 'bool' }, [v3('toCompare'), { name: 'allFour', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false }])],
          ['toString', vm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map([
          ['X_AXIS', v3static(1, 0, 0)],
          ['Y_AXIS', v3static(0, 1, 0)],
          ['Z_AXIS', v3static(0, 0, 1)],
        ]),
        staticMethods: new Map([
          ['distance', vs({ kind: 'number' }, [v3('pt1'), v3('pt2')])],
          ['angleBetween', vs({ kind: 'number' }, [v3('a'), v3('b')])],
        ]),
        getters: new Map([
          ['length', vg({ kind: 'number' })],
          ['lengthSquared', vg({ kind: 'number' })],
        ]),
        setters: new Map(),
        constructor: { params: [gegnum('x', 0), gegnum('y', 0), gegnum('z', 0), gegnum('w', 0)] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // Matrix3D (flash.geom): a 4x4 column-major matrix. The 16 doubles live in a
    // C-runtime-only `_m[16]` array (emitted by emitStructs for name === 'Matrix3D');
    // `rawData` is the only AS3-visible accessor and materializes a Vector.<Number>
    // on read (a copy, matching the AVM2 rawData getter).
    {
      const mm = gemethod('Matrix3D');
      const ms = gestatic('Matrix3D');
      const m3 = (name: string): Param => ({ name, type: 'Matrix3D', defaultValue: null, isRest: false });
      const v3p = (name: string): Param => ({ name, type: 'Vector3D', defaultValue: null, isRest: false });
      const vnum = (): CType => ({ kind: 'vector', elem: { kind: 'number' } });
      const vv3 = (): CType => ({ kind: 'vector', elem: { kind: 'object', className: 'Vector3D' } });
      const orient = { name: 'orientation', type: 'String' as ASType, defaultValue: { kind: 'Str', value: 'eulerAngles' } as Expr, isRest: false };
      this.classMap.set('Matrix3D', {
        fields: new Map(),
        methods: new Map([
          ['identity', mm({ kind: 'void' }, [])],
          ['append', mm({ kind: 'void' }, [m3('lhs')])],
          ['prepend', mm({ kind: 'void' }, [m3('rhs')])],
          ['invert', mm({ kind: 'bool' }, [])],
          ['transpose', mm({ kind: 'void' }, [])],
          ['transformVector', mm({ kind: 'object', className: 'Vector3D' }, [v3p('v')])],
          ['transformVectors', mm({ kind: 'void' }, [{ name: 'vin', type: 'Vector.<Number>', defaultValue: null, isRest: false }, { name: 'vout', type: 'Vector.<Number>', defaultValue: null, isRest: false }])],
          ['deltaTransformVector', mm({ kind: 'object', className: 'Vector3D' }, [v3p('v')])],
          ['pointAt', mm({ kind: 'void' }, [v3p('pos'), v3p('at'), v3p('up')])],
          ['interpolate', mm({ kind: 'void' }, [m3('thisMat'), m3('toMat'), gegnum('percent', 0)])],
          ['recompose', mm({ kind: 'bool' }, [{ name: 'components', type: 'Vector.<Vector3D>', defaultValue: null, isRest: false }, orient])],
          ['decompose', mm(vv3(), [orient])],
          ['copyFrom', mm({ kind: 'void' }, [m3('sourceMatrix3D')])],
          ['copyColumnFrom', mm({ kind: 'void' }, [{ name: 'column', type: 'uint', defaultValue: null, isRest: false }, v3p('vector3D')])],
          ['copyColumnTo', mm({ kind: 'void' }, [{ name: 'column', type: 'uint', defaultValue: null, isRest: false }, v3p('vector3D')])],
          ['copyRowFrom', mm({ kind: 'void' }, [{ name: 'row', type: 'uint', defaultValue: null, isRest: false }, v3p('vector3D')])],
          ['copyRowTo', mm({ kind: 'void' }, [{ name: 'row', type: 'uint', defaultValue: null, isRest: false }, v3p('vector3D')])],
          ['copyRawDataTo', mm({ kind: 'void' }, [
            { name: 'vector', type: 'Vector.<Number>', defaultValue: null, isRest: false },
            { name: 'index', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'transpose', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          ['copyRawDataFrom', mm({ kind: 'void' }, [
            { name: 'vector', type: 'Vector.<Number>', defaultValue: null, isRest: false },
            { name: 'index', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'transpose', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          ['clone', mm({ kind: 'object', className: 'Matrix3D' }, [])],
          ['appendTranslation', mm({ kind: 'void' }, [gegnum('x', 0), gegnum('y', 0), gegnum('z', 0)])],
          ['prependTranslation', mm({ kind: 'void' }, [gegnum('x', 0), gegnum('y', 0), gegnum('z', 0)])],
          ['appendScale', mm({ kind: 'void' }, [gegnum('xScale', 0), gegnum('yScale', 0), gegnum('zScale', 0)])],
          ['prependScale', mm({ kind: 'void' }, [gegnum('xScale', 0), gegnum('yScale', 0), gegnum('zScale', 0)])],
          ['appendRotation', mm({ kind: 'void' }, [gegnum('degrees', 0), v3p('axis'), { name: 'pivotPoint', type: 'Vector3D', defaultValue: { kind: 'Null' }, isRest: false }])],
          ['prependRotation', mm({ kind: 'void' }, [gegnum('degrees', 0), v3p('axis'), { name: 'pivotPoint', type: 'Vector3D', defaultValue: { kind: 'Null' }, isRest: false }])],
          ['toString', mm({ kind: 'string' }, [])],
        ]),
        staticFields: new Map(),
        staticMethods: new Map([
          ['interpolate', ms({ kind: 'object', className: 'Matrix3D' }, [m3('thisMat'), m3('toMat'), gegnum('percent', 0)])],
          ['identity', ms({ kind: 'object', className: 'Matrix3D' }, [])],
        ]),
        getters: new Map([
          ['rawData', { returnType: vnum(), params: [], owner: 'Matrix3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
          // position: a fresh Vector3D view of the translation column (w = 0), and a
          // setter that copies x/y/z into it. Measured on adl 51.4.1: the getter
          // never returns the same object twice and mutating it does NOT write
          // back; assigning null is ignored (temp/matposprobe).
          ['position', { returnType: { kind: 'object', className: 'Vector3D' }, params: [], owner: 'Matrix3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false }],
        ]),
        setters: new Map([
          ['rawData', { returnType: { kind: 'void' }, params: [{ name: 'v', type: 'Vector.<Number>', defaultValue: null, isRest: false }], owner: 'Matrix3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
          ['position', { returnType: { kind: 'void' }, params: [{ name: 'v', type: 'Vector3D', defaultValue: null, isRest: false }], owner: 'Matrix3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ]),
        constructor: { params: [{ name: 'v', type: 'Vector.<Number>', defaultValue: { kind: 'Null' }, isRest: false }] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // flash.display3D.AGALTranslator (stage 80): a pure-static bridge over the
    // runtime AGAL bytecode -> MSL/GLSL translator. Not part of the AS3 runtime
    // surface — it is the compiler's test/verification hook for the AGAL kernel,
    // reused later by Program3D.upload (stage 81).
    {
      this.classMap.set('AGALTranslator', {
        fields: new Map(),
        methods: new Map(),
        staticFields: new Map(),
        staticMethods: new Map([
          ['translate', { returnType: { kind: 'string' }, params: [
            { name: 'bytes', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'target', type: 'String', defaultValue: null, isRest: false },
          ], owner: 'AGALTranslator', visibility: 'public', isStatic: true, isFinal: false, isGetter: false, isSetter: false }],
        ]),
        getters: new Map(),
        setters: new Map(),
        constructor: { params: [] },
        superClass: 'Object',
        isFinal: false,
        implements: [],
      });
    }
    // ===== flash.display3D (stage 81): Stage3D + Context3D skeleton + resource
    // classes + 15 constant classes. Pure CPU-side state machine and containers
    // (no GPU); the Metal/WebGL upload + draw are wired in stage 82. =====

    // --- 15 constant classes: pure static-String holders, never instantiated. ---
    constClass('Context3DBlendFactor', { ONE: 'one', ZERO: 'zero', SOURCE_ALPHA: 'sourceAlpha', SOURCE_COLOR: 'sourceColor', ONE_MINUS_SOURCE_ALPHA: 'oneMinusSourceAlpha', ONE_MINUS_SOURCE_COLOR: 'oneMinusSourceColor', DESTINATION_ALPHA: 'destinationAlpha', DESTINATION_COLOR: 'destinationColor', ONE_MINUS_DESTINATION_ALPHA: 'oneMinusDestinationAlpha', ONE_MINUS_DESTINATION_COLOR: 'oneMinusDestinationColor' });
    constClass('Context3DBufferUsage', { STATIC_DRAW: 'staticDraw', DYNAMIC_DRAW: 'dynamicDraw' });
    // AIR's Context3DClearMask is a uint bitfield (verified against adl:
    // COLOR=1, DEPTH=2, STENCIL=4, ALL=7) — clear(r,g,b,a,depth,stencil,mask)
    // takes those bits. Modelling them as strings made the mask argument coerce
    // to garbage, so the clear-mask semantics were silently lost.
    intConstClass('Context3DClearMask', { COLOR: 1, DEPTH: 2, STENCIL: 4, ALL: 7 });
    constClass('Context3DCompareMode', { ALWAYS: 'always', NEVER: 'never', LESS: 'less', LESS_EQUAL: 'lessEqual', EQUAL: 'equal', GREATER_EQUAL: 'greaterEqual', GREATER: 'greater', NOT_EQUAL: 'notEqual' });
    constClass('Context3DFillMode', { NONE: 'none', SOLID: 'solid' });
    constClass('Context3DMipFilter', { MIPNONE: 'mipnone', MIPNEAREST: 'mipnearest', MIPLINEAR: 'miplinear' });
    constClass('Context3DProfile', { BASELINE: 'baseline', BASELINE_EXTENDED: 'baselineExtended', BASELINE_CONSTRAINED: 'baselineConstrained', STANDARD: 'standard', STANDARD_CONSTRAINED: 'standardConstrained', STANDARD_EXTENDED: 'standardExtended' });
    constClass('Context3DProgramType', { VERTEX: 'vertex', FRAGMENT: 'fragment' });
    constClass('Context3DRenderMode', { AUTO: 'auto', SOFTWARE: 'software' });
    constClass('Context3DStencilAction', { KEEP: 'keep', DECREMENT_SATURATE: 'decrementSaturate', DECREMENT_WRAP: 'decrementWrap', INCREMENT_SATURATE: 'incrementSaturate', INCREMENT_WRAP: 'incrementWrap', INVERT: 'invert', REPLACE: 'replace', SET: 'set', ZERO: 'zero' });
    constClass('Context3DTextureFilter', { NEAREST: 'nearest', LINEAR: 'linear' });
    constClass('Context3DTextureFormat', { BGRA: 'bgra', RGBA: 'rgba', COMPRESSED: 'compressed', COMPRESSED_ALPHA: 'compressedAlpha', BGR_PACKED: 'bgrPacked', BGRA_PACKED: 'bgraPacked' });
    constClass('Context3DTriangleFace', { BACK: 'back', FRONT: 'front', FRONT_AND_BACK: 'frontAndBack', NONE: 'none' });
    constClass('Context3DVertexBufferFormat', { BYTES_4: 'bytes4', FLOAT_1: 'float1', FLOAT_2: 'float2', FLOAT_3: 'float3', FLOAT_4: 'float4' });
    constClass('Context3DWrapMode', { CLAMP: 'clamp', REPEAT: 'repeat' });
    intConstClass('Context3DCubeMapFace', { POSITIVE_X: 0, NEGATIVE_X: 1, POSITIVE_Y: 2, NEGATIVE_Y: 3, POSITIVE_Z: 4, NEGATIVE_Z: 5 });

    // --- resource classes: CPU copies of uploaded data; GPU objects in stage 82. ---
    {
      const vbf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'VertexBuffer3D', isStatic: false, isConst: false });
      const vbm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'VertexBuffer3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('VertexBuffer3D', {
        fields: new Map([
          ['numVertices', vbf({ kind: 'int' })],
          ['data32PerVertex', vbf({ kind: 'int' })],
          // Vertex payload as raw 32-bit GPU words (Vector.<uint>), one per
          // component. A vertex buffer is bytes on the GPU: the attribute format
          // chosen at setVertexBufferAt decides how a word is read (floatN ->
          // float32, bytes4 -> four normalized bytes). Keeping the words
          // themselves is both smaller and more honest than the previous pair of
          // Vector.<Number> (one holding the widened float VALUE, one its bit
          // pattern as a double): 16 bytes per component of information that
          // fits in 4, and 96% of the benchmark's live heap was those buffers.
          ['raw', vbf({ kind: 'vector', elem: { kind: 'uint' } })],
          ['startVertex', vbf({ kind: 'int' })],
        ]),
        methods: new Map([
          ['uploadFromVector', vbm({ kind: 'void' }, [
            { name: 'data', type: 'Vector.<Number>', defaultValue: null, isRest: false },
            { name: 'startVertex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numVertices', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['uploadFromByteArray', vbm({ kind: 'void' }, [
            { name: 'data', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'byteArrayOffset', type: 'uint', defaultValue: null, isRest: false },
            { name: 'startVertex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numVertices', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['dispose', vbm({ kind: 'void' }, [])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'Object', isFinal: false, implements: [],
      });
    }
    {
      const ibf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'IndexBuffer3D', isStatic: false, isConst: false });
      const ibm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'IndexBuffer3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('IndexBuffer3D', {
        fields: new Map([
          ['numIndices', ibf({ kind: 'int' })],
          ['data', ibf({ kind: 'vector', elem: { kind: 'uint' } })],
          ['startIndex', ibf({ kind: 'int' })],
        ]),
        methods: new Map([
          ['uploadFromVector', ibm({ kind: 'void' }, [
            { name: 'data', type: 'Vector.<uint>', defaultValue: null, isRest: false },
            { name: 'startIndex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numIndices', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['uploadFromByteArray', ibm({ kind: 'void' }, [
            { name: 'data', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'byteArrayOffset', type: 'uint', defaultValue: null, isRest: false },
            { name: 'startIndex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numIndices', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['dispose', ibm({ kind: 'void' }, [])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'Object', isFinal: false, implements: [],
      });
    }
    {
      const prf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Program3D', isStatic: false, isConst: false });
      const prm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Program3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('Program3D', {
        fields: new Map([
          ['vertexProgram', prf({ kind: 'object', className: 'ByteArray' })],
          ['fragmentProgram', prf({ kind: 'object', className: 'ByteArray' })],
          // AGAL sampler state the fragment program declares, decoded from its
          // `tex`/`tld` sampler flags at upload time (see as_agal_sampler_flags).
          // `samplerUsed` is a bitmask of the sampler registers the program
          // samples; `samplerFlags` is that register's packed
          // (filter | wrap<<1 | mip<<2), 4 bits per register. Context3D_setProgram
          // applies them to the GPU unit state -- Stage3D honours the AGAL flags
          // (measured on AIR 51.4.1, temp/sampprobe) and they are the only
          // sampler state away3d and Starling ever set.
          ['samplerUsed', prf({ kind: 'int' })],
          ['samplerFlags', prf({ kind: 'int' })],
        ]),
        methods: new Map([
          ['upload', prm({ kind: 'void' }, [
            { name: 'vertexProgram', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'fragmentProgram', type: 'ByteArray', defaultValue: null, isRest: false },
          ])],
          ['dispose', prm({ kind: 'void' }, [])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'Object', isFinal: false, implements: [],
      });
    }
    this.classMap.set('TextureBase', {
      fields: new Map(),
      methods: new Map([['dispose', { returnType: { kind: 'void' }, params: [], owner: 'TextureBase', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }]]),
      staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
      constructor: { params: [] }, superClass: 'EventDispatcher', isFinal: false, implements: [],
    });
    // flash.display3D.textures.VideoTexture: a video-backed base texture. Its
    // videoWidth/videoHeight expose the decoded frame size (read-only in AIR; the
    // AOT subset models them as plain int fields defaulting to 0).
    this.classMap.set('VideoTexture', {
      fields: new Map([
        ['videoWidth', { type: { kind: 'int' }, init: null, visibility: 'public', owner: 'VideoTexture', isStatic: false, isConst: false }],
        ['videoHeight', { type: { kind: 'int' }, init: null, visibility: 'public', owner: 'VideoTexture', isStatic: false, isConst: false }],
      ]),
      methods: new Map([
        ['dispose', { returnType: { kind: 'void' }, params: [], owner: 'VideoTexture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['attachCamera', { returnType: { kind: 'void' }, params: [{ name: 'camera', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false }], owner: 'VideoTexture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
        ['attachNetStream', { returnType: { kind: 'void' }, params: [{ name: 'netStream', type: 'Object', defaultValue: { kind: 'Null' }, isRest: false }], owner: 'VideoTexture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false }],
      ]),
      staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
      constructor: { params: [] }, superClass: 'TextureBase', isFinal: false, implements: [],
    });
    {
      const txf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Texture', isStatic: false, isConst: false });
      const txm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Texture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('Texture', {
        fields: new Map([
          ['width', txf({ kind: 'int' })],
          ['height', txf({ kind: 'int' })],
          ['format', txf({ kind: 'string' })],
          // Source BitmapData retained for the GPU upload (s3d_upload_texture).
          // Pure-C builds keep it as a plain reference (no pixels are copied).
          ['bitmapData', txf({ kind: 'object', className: 'BitmapData' })],
          // Opaque MTLTexture handle for render-to-texture (optimizeForRenderToTexture).
          // NULL for sampler-only textures (uploadFromBitmapData).
          ['gpu', txf({ kind: 'null' })],
          // Opaque S3DContext handle, set by Context3D_createTexture. uploadBitmapData
          // needs it to upload EAGERLY (see Texture_uploadFromBitmapData) -- AIR's
          // uploadFromBitmapData is synchronous, so the caller is free to dispose the
          // source BitmapData right after; deferring the upload to the next
          // Context3D_submit would then read a freed pixel buffer.
          ['ctx', txf({ kind: 'null' })],
          // Mip-chain flag (trailing, layout-identical to RectangleTexture).
          // Set when the app supplies a mip level > 0 (away3d's MipmapGenerator
          // uploads level 0..N of one bitmap); cleared by a level-0 re-upload.
          // Context3D_submit hands it to s3d_bind_texture so the backend can
          // reproduce AIR's rule that a mip-filtered sampler on a texture with
          // NO chain drops the whole draw (measured: temp/sampprobe A6).
          ['mips', txf({ kind: 'int' })],
        ]),
        methods: new Map([
          ['uploadFromBitmapData', txm({ kind: 'void' }, [
            { name: 'bitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
            { name: 'miplevel', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          ])],
          ['uploadCompressedTextureFromByteArray', txm({ kind: 'void' }, [
            { name: 'data', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'byteArrayOffset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'async', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          ['dispose', txm({ kind: 'void' }, [])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'TextureBase', isFinal: false, implements: [],
      });

      // CubeTexture (stage 83): six square faces sharing one size. width/height +
      // per-face BitmapData sources, plus the GPU cube map handle (stage 113 --
      // the six faces are uploaded as one MTLTextureTypeCube and bound in place of
      // a 2D texture; the field lives OUTSIDE the face slots, so `->gpu` never
      // aliases face0 the way a Texture-shaped read would).
      const cuf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'CubeTexture', isStatic: false, isConst: false });
      const cum = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'CubeTexture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('CubeTexture', {
        fields: new Map([
          ['width', cuf({ kind: 'int' })],
          ['height', cuf({ kind: 'int' })],
          ['format', cuf({ kind: 'string' })],
          ['face0', cuf({ kind: 'object', className: 'BitmapData' })],
          ['face1', cuf({ kind: 'object', className: 'BitmapData' })],
          ['face2', cuf({ kind: 'object', className: 'BitmapData' })],
          ['face3', cuf({ kind: 'object', className: 'BitmapData' })],
          ['face4', cuf({ kind: 'object', className: 'BitmapData' })],
          ['face5', cuf({ kind: 'object', className: 'BitmapData' })],
          ['gpu', cuf({ kind: 'null' })],
        ]),
        methods: new Map([
          ['uploadFromBitmapData', cum({ kind: 'void' }, [
            { name: 'bitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
            { name: 'side', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'miplevel', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          ])],
          ['dispose', cum({ kind: 'void' }, [])],
          // Declared on TextureBase in AIR; added here (owner CubeTexture) because our
          // built-in inheritance is per-class C bodies -- a CubeTexture must not run
          // Texture's body, whose struct layout it does not share.
          ['uploadCompressedTextureFromByteArray', cum({ kind: 'void' }, [
            { name: 'data', type: 'ByteArray', defaultValue: null, isRest: false },
            { name: 'byteArrayOffset', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'async', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'TextureBase', isFinal: false, implements: [],
      });

      // RectangleTexture (stage 83): non-power-of-two 2D texture, clamp-only,
      // no mipmaps. CPU descriptor mirroring Texture (uploadFromBitmapData).
      const rtf = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'RectangleTexture', isStatic: false, isConst: false });
      const rtm = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'RectangleTexture', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      this.classMap.set('RectangleTexture', {
        fields: new Map([
          ['width', rtf({ kind: 'int' })],
          ['height', rtf({ kind: 'int' })],
          ['format', rtf({ kind: 'string' })],
          ['bitmapData', rtf({ kind: 'object', className: 'BitmapData' })],
          // Opaque MTLTexture handle, mirroring Texture. NPOT atlas/background
          // textures are RectangleTexture; Starling binds their `base` through
          // setTextureAt (typed Texture*), so this field MUST sit at the same
          // trailing offset as Texture.gpu — otherwise Context3D_submit reads
          // past the RectangleTexture struct and binds garbage to Metal
          // (SIGSEGV in setFragmentTexture). Layout-identical to Texture.
          ['gpu', rtf({ kind: 'null' })],
          // Same eager-upload context handle as Texture (layout-identical).
          ['ctx', rtf({ kind: 'null' })],
          // Same trailing mip-chain flag as Texture (layout-identical): a
          // RectangleTexture is NPOT and Stage3D forbids mipmaps on NPOT, so it
          // stays 0 -- the field exists only to keep the two structs the same
          // shape, which Context3D_submit relies on when it reads a RectangleTexture
          // through a Texture*.
          ['mips', rtf({ kind: 'int' })],
        ]),
        methods: new Map([
          ['uploadFromBitmapData', rtm({ kind: 'void' }, [
            { name: 'bitmapData', type: 'BitmapData', defaultValue: null, isRest: false },
          ])],
          ['dispose', rtm({ kind: 'void' }, [])],
        ]),
        staticFields: new Map(), staticMethods: new Map(), getters: new Map(), setters: new Map(),
        constructor: { params: [] }, superClass: 'TextureBase', isFinal: false, implements: [],
      });
    }

    // --- Context3D: pure state machine (blend/depth/cull + bound resources). ---
    {
      const c3f = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Context3D', isStatic: false, isConst: false });
      const c3m = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Context3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      const c3g = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Context3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const c3fields = new Map<string, FieldInfo>([
        ['backBufferWidth', c3f({ kind: 'int' })],
        ['backBufferHeight', c3f({ kind: 'int' })],
        ['antiAlias', c3f({ kind: 'int' })],
        ['enableDepthAndStencil', c3f({ kind: 'bool' })],
        ['blendSource', c3f({ kind: 'string' })],
        ['blendDest', c3f({ kind: 'string' })],
        ['depthTestOn', c3f({ kind: 'bool' })],
        ['depthCompare', c3f({ kind: 'string' })],
        ['cullMode', c3f({ kind: 'string' })],
        ['program', c3f({ kind: 'object', className: 'Program3D' })],
        ['indexBuffer', c3f({ kind: 'object', className: 'IndexBuffer3D' })],
        ['vc', c3f({ kind: 'vector', elem: { kind: 'number' } })],
        ['fc', c3f({ kind: 'vector', elem: { kind: 'number' } })],
        // Opaque S3DContext* handle (nil in pure-C builds). The generated C never
        // dereferences it — it is passed back verbatim to every as_s3d_* call.
        ['gpu', c3f({ kind: 'null' })],
        // Last Program3D compiled to a Metal pipeline (drawTriangles caches on
        // the pointer so the MSL compile runs once per program, not per frame).
        ['gpuProgram', c3f({ kind: 'object', className: 'Program3D' })],
        ['clearR', c3f({ kind: 'number' })],
        ['clearG', c3f({ kind: 'number' })],
        ['clearB', c3f({ kind: 'number' })],
        ['clearA', c3f({ kind: 'number' })],
        // Stencil/scissor state (stage 87): recorded by setStencilActions /
        // setStencilReferenceValue / setScissorRectangle for the CPU state
        // machine. Like setDepthTest/setCulling, these are NOT yet propagated to
        // the offscreen Metal pipeline (which has no depth/stencil attachment).
        ['stencilFace', c3f({ kind: 'string' })],
        ['stencilCompare', c3f({ kind: 'string' })],
        ['stencilBothPass', c3f({ kind: 'string' })],
        ['stencilDepthFail', c3f({ kind: 'string' })],
        ['stencilDepthPassStencilFail', c3f({ kind: 'string' })],
        ['stencilRefValue', c3f({ kind: 'int' })],
        ['scissorOn', c3f({ kind: 'bool' })],
        ['scissorX', c3f({ kind: 'number' })],
        ['scissorY', c3f({ kind: 'number' })],
        ['scissorW', c3f({ kind: 'number' })],
        ['scissorH', c3f({ kind: 'number' })],
        // System back-buffer size limit (AIR 64-bit desktop = 16384). Returns the
        // platform limit; configureBackBuffer clamps to this upper bound.
        ['maxBackBufferWidth', c3f({ kind: 'int' })],
        ['maxBackBufferHeight', c3f({ kind: 'int' })],
      ]);
      for (let i = 0; i < 8; i++) {
        c3fields.set(`vb${i}`, c3f({ kind: 'object', className: 'VertexBuffer3D' }));
        c3fields.set(`vbOff${i}`, c3f({ kind: 'int' }));
        c3fields.set(`vbFmt${i}`, c3f({ kind: 'string' }));
        c3fields.set(`tex${i}`, c3f({ kind: 'object', className: 'Texture' }));
      }
      this.classMap.set('Context3D', {
        fields: c3fields,
        methods: new Map([
          ['configureBackBuffer', c3m({ kind: 'void' }, [
            { name: 'width', type: 'uint', defaultValue: null, isRest: false },
            { name: 'height', type: 'uint', defaultValue: null, isRest: false },
            { name: 'antiAlias', type: 'uint', defaultValue: null, isRest: false },
            { name: 'enableDepthAndStencil', type: 'Boolean', defaultValue: null, isRest: false },
            { name: 'wantsBestResolution', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
            { name: 'wantsBestResolutionOnBrowserZoom', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
          ])],
          // AIR's declaration gives every parameter a default:
          // clear(red=0, green=0, blue=0, alpha=1, depth=1, stencil=0, mask=0xFFFFFFFF).
          // SingleObjectDepthPass calls context.clear(1.0, 1.0, 1.0).
          ['clear', c3m({ kind: 'void' }, [
            { name: 'red', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
            { name: 'green', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
            { name: 'blue', type: 'Number', defaultValue: { kind: 'Num', value: 0, isInt: false }, isRest: false },
            { name: 'alpha', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: false }, isRest: false },
            { name: 'depth', type: 'Number', defaultValue: { kind: 'Num', value: 1, isInt: false }, isRest: false },
            { name: 'stencil', type: 'uint', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'mask', type: 'uint', defaultValue: { kind: 'Num', value: 4294967295, isInt: true }, isRest: false },
          ])],
          ['present', c3m({ kind: 'void' }, [])],
          ['drawTriangles', c3m({ kind: 'void' }, [
            { name: 'indexBuffer', type: 'IndexBuffer3D', defaultValue: null, isRest: false },
            { name: 'firstIndex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numTriangles', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['setProgram', c3m({ kind: 'void' }, [{ name: 'program', type: 'Program3D', defaultValue: null, isRest: false }])],
          ['setBlendFactors', c3m({ kind: 'void' }, [
            { name: 'sourceFactor', type: 'String', defaultValue: null, isRest: false },
            { name: 'destinationFactor', type: 'String', defaultValue: null, isRest: false },
          ])],
          ['setProgramConstantsFromMatrix', c3m({ kind: 'void' }, [
            { name: 'programType', type: 'String', defaultValue: null, isRest: false },
            { name: 'firstRegister', type: 'int', defaultValue: null, isRest: false },
            { name: 'matrix', type: 'Matrix3D', defaultValue: null, isRest: false },
            { name: 'transposedMatrix', type: 'Boolean', defaultValue: null, isRest: false },
          ])],
          ['setTextureAt', c3m({ kind: 'void' }, [
            { name: 'first', type: 'int', defaultValue: null, isRest: false },
            { name: 'texture', type: 'Texture', defaultValue: null, isRest: false },
          ])],
          ['setSamplerStateAt', c3m({ kind: 'void' }, [
            { name: 'sampler', type: 'int', defaultValue: null, isRest: false },
            { name: 'wrap', type: 'String', defaultValue: null, isRest: false },
            { name: 'filter', type: 'String', defaultValue: null, isRest: false },
            { name: 'mipfilter', type: 'String', defaultValue: null, isRest: false },
          ])],
          ['setVertexBufferAt', c3m({ kind: 'void' }, [
            { name: 'index', type: 'int', defaultValue: null, isRest: false },
            { name: 'buffer', type: 'VertexBuffer3D', defaultValue: null, isRest: false },
            { name: 'bufferOffset', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'format', type: 'String', defaultValue: { kind: 'Str', value: 'float4' }, isRest: false },
          ])],
          ['createVertexBuffer', c3m({ kind: 'object', className: 'VertexBuffer3D' }, [
            { name: 'numVertices', type: 'int', defaultValue: null, isRest: false },
            { name: 'data32PerVertex', type: 'int', defaultValue: null, isRest: false },
            { name: 'bufferUsage', type: 'String', defaultValue: { kind: 'Str', value: 'staticDraw' }, isRest: false },
          ])],
          ['createIndexBuffer', c3m({ kind: 'object', className: 'IndexBuffer3D' }, [
            { name: 'numIndices', type: 'int', defaultValue: null, isRest: false },
            { name: 'bufferUsage', type: 'String', defaultValue: { kind: 'Str', value: 'staticDraw' }, isRest: false },
          ])],
          ['createProgram', c3m({ kind: 'object', className: 'Program3D' }, [])],
          ['createTexture', c3m({ kind: 'object', className: 'Texture' }, [
            { name: 'width', type: 'int', defaultValue: null, isRest: false },
            { name: 'height', type: 'int', defaultValue: null, isRest: false },
            { name: 'format', type: 'String', defaultValue: null, isRest: false },
            { name: 'optimizeForRenderToTexture', type: 'Boolean', defaultValue: null, isRest: false },
          ])],
          ['createCubeTexture', c3m({ kind: 'object', className: 'CubeTexture' }, [
            { name: 'size', type: 'int', defaultValue: null, isRest: false },
            { name: 'format', type: 'String', defaultValue: null, isRest: false },
            { name: 'optimizeForRenderToTexture', type: 'Boolean', defaultValue: null, isRest: false },
          ])],
          ['createRectangleTexture', c3m({ kind: 'object', className: 'RectangleTexture' }, [
            { name: 'width', type: 'int', defaultValue: null, isRest: false },
            { name: 'height', type: 'int', defaultValue: null, isRest: false },
            { name: 'format', type: 'String', defaultValue: null, isRest: false },
            { name: 'optimizeForRenderToTexture', type: 'Boolean', defaultValue: null, isRest: false },
          ])],
          ['createVideoTexture', c3m({ kind: 'object', className: 'VideoTexture' }, [])],
          ['setCubeTextureAt', c3m({ kind: 'void' }, [
            { name: 'first', type: 'int', defaultValue: null, isRest: false },
            { name: 'texture', type: 'CubeTexture', defaultValue: null, isRest: false },
          ])],
          ['setRectangleTextureAt', c3m({ kind: 'void' }, [
            { name: 'first', type: 'int', defaultValue: null, isRest: false },
            { name: 'texture', type: 'RectangleTexture', defaultValue: null, isRest: false },
          ])],
          ['drawTrianglesInstanced', c3m({ kind: 'void' }, [
            { name: 'indexBuffer', type: 'IndexBuffer3D', defaultValue: null, isRest: false },
            { name: 'firstIndex', type: 'int', defaultValue: null, isRest: false },
            { name: 'numTriangles', type: 'int', defaultValue: null, isRest: false },
            { name: 'numInstances', type: 'int', defaultValue: null, isRest: false },
          ])],
          ['setProgramConstantsFromVector', c3m({ kind: 'void' }, [
            { name: 'programType', type: 'String', defaultValue: null, isRest: false },
            { name: 'firstRegister', type: 'int', defaultValue: null, isRest: false },
            { name: 'data', type: 'Vector.<Number>', defaultValue: null, isRest: false },
            { name: 'numRegisters', type: 'int', defaultValue: { kind: 'Num', value: -1, isInt: true }, isRest: false },
          ])],
          ['setDepthTest', c3m({ kind: 'void' }, [
            { name: 'depthMask', type: 'Boolean', defaultValue: null, isRest: false },
            { name: 'passCompareMode', type: 'String', defaultValue: null, isRest: false },
          ])],
          ['setCulling', c3m({ kind: 'void' }, [{ name: 'triangleFaceToCull', type: 'String', defaultValue: null, isRest: false }])],
          // setColorMask(red, green, blue, alpha): per-channel color writes for the
          // following draws (away3d's DepthRenderer turns them all off for its
          // depth-only prepass). All four parameters are required in AIR.
          ['setColorMask', c3m({ kind: 'void' }, [
            { name: 'red', type: 'Boolean', defaultValue: null, isRest: false },
            { name: 'green', type: 'Boolean', defaultValue: null, isRest: false },
            { name: 'blue', type: 'Boolean', defaultValue: null, isRest: false },
            { name: 'alpha', type: 'Boolean', defaultValue: null, isRest: false },
          ])],
          ['dispose', c3m({ kind: 'void' }, [
            { name: 'recreate', type: 'Boolean', defaultValue: { kind: 'Bool', value: true }, isRest: false },
          ])],
          ['drawToBitmapData', c3m({ kind: 'void' }, [
            { name: 'destination', type: 'BitmapData', defaultValue: null, isRest: false },
          ])],
          ['setRenderToTexture', c3m({ kind: 'void' }, [
            { name: 'texture', type: 'Texture', defaultValue: null, isRest: false },
            { name: 'enableDepthAndStencil', type: 'Boolean', defaultValue: { kind: 'Bool', value: false }, isRest: false },
            { name: 'antiAlias', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
            { name: 'surfaceSelector', type: 'int', defaultValue: { kind: 'Num', value: 0, isInt: true }, isRest: false },
          ])],
          ['setRenderToBackBuffer', c3m({ kind: 'void' }, [])],
          // setStencilActions: 5 params, all trailing three default to "keep"
          // (AIR semantics; Starling's Painter calls with 2-3 args).
          ['setStencilActions', c3m({ kind: 'void' }, [
            { name: 'triangleFace', type: 'String', defaultValue: { kind: 'Str', value: 'frontAndBack' }, isRest: false },
            { name: 'compareMode', type: 'String', defaultValue: { kind: 'Str', value: 'always' }, isRest: false },
            { name: 'actionOnBothPass', type: 'String', defaultValue: { kind: 'Str', value: 'keep' }, isRest: false },
            { name: 'actionOnDepthFail', type: 'String', defaultValue: { kind: 'Str', value: 'keep' }, isRest: false },
            { name: 'actionOnDepthPassStencilFail', type: 'String', defaultValue: { kind: 'Str', value: 'keep' }, isRest: false },
          ])],
          // setScissorRectangle(null) disables scissoring.
          ['setScissorRectangle', c3m({ kind: 'void' }, [
            { name: 'rectangle', type: 'Rectangle', defaultValue: { kind: 'Null' }, isRest: false },
          ])],
          ['setStencilReferenceValue', c3m({ kind: 'void' }, [
            { name: 'referenceValue', type: 'uint', defaultValue: null, isRest: false },
            { name: 'readMask', type: 'uint', defaultValue: { kind: 'Num', value: 255, isInt: true }, isRest: false },
            { name: 'writeMask', type: 'uint', defaultValue: { kind: 'Num', value: 255, isInt: true }, isRest: false },
          ])],
        ]),
        staticFields: new Map([
          ['supportsVideoTexture', { type: { kind: 'bool' }, init: { kind: 'Bool', value: true }, visibility: 'public', owner: 'Context3D', isStatic: true, isConst: true }],
        ]), staticMethods: new Map(),
        getters: new Map([
          ['driverInfo', c3g({ kind: 'string' })],
          ['profile', c3g({ kind: 'string' })],
          // AIR exposes CL_totalGPUMemory as a read-only Number; Starling's
          // StatsDisplay probes it with `"totalGPUMemory" in context` and drops
          // the whole "gpu memory" row when the probe fails, so the property must
          // exist (an approximation is fine, a missing property is not).
          ['totalGPUMemory', c3g({ kind: 'number' })],
          ['maxBackBufferWidth', c3g({ kind: 'int' })],
          ['maxBackBufferHeight', c3g({ kind: 'int' })],
        ]),
        setters: new Map([
          ['enableErrorChecking', { returnType: { kind: 'void' }, params: [{ name: 'value', type: 'Boolean', defaultValue: null, isRest: false }], owner: 'Context3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true }],
        ]),
        constructor: { params: [] }, superClass: 'Object', isFinal: false, implements: [],
      });
    }

    // --- Stage3D: per-display slot; lazily creates a Context3D on request. ---
    {
      const s3f = (t: CType): FieldInfo => ({ type: t, init: null, visibility: 'public', owner: 'Stage3D', isStatic: false, isConst: false });
      const s3m = (ret: CType, params: Param[]): MethodInfo => ({ returnType: ret, params, owner: 'Stage3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: false });
      const s3g = (ret: CType): MethodInfo => ({ returnType: ret, params: [], owner: 'Stage3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: true, isSetter: false });
      const s3s = (pt: ASType): MethodInfo => ({ returnType: { kind: 'void' }, params: [{ name: 'value', type: pt, defaultValue: null, isRest: false }], owner: 'Stage3D', visibility: 'public', isStatic: false, isFinal: false, isGetter: false, isSetter: true });
      this.classMap.set('Stage3D', {
        fields: new Map([
          ['x', s3f({ kind: 'number' })],
          ['y', s3f({ kind: 'number' })],
          ['visible', s3f({ kind: 'bool' })],
          ['context3d', s3f({ kind: 'object', className: 'Context3D' })],
          ['renderMode', s3f({ kind: 'string' })],
        ]),
        methods: new Map([
          ['requestContext3D', s3m({ kind: 'void' }, [{ name: 'renderMode', type: 'String', defaultValue: null, isRest: false }])],
        ]),
        staticFields: new Map(), staticMethods: new Map(),
        getters: new Map([
          ['context3D', s3g({ kind: 'object', className: 'Context3D' })],
        ]),
        setters: new Map([
          ['x', s3s('Number')],
          ['y', s3s('Number')],
          ['visible', s3s('Boolean')],
        ]),
        constructor: { params: [] }, superClass: 'EventDispatcher', isFinal: false, implements: [],
      });
    }
    // flash.* built-in classes are keyed by their SHORT name and carry no source
    // import list, so their method parameter types ('Event', 'Rectangle', ...) must
    // resolve to the built-in short name — NOT the global typeAlias entry, which a
    // same-named user class (e.g. starling.events.Event) overrides. Give each
    // built-in an import alias mapping every built-in short name to itself so
    // emit-time param resolution (paramDecls) picks the built-in type.
    const builtinAlias = new Map<string, string>();
    for (const n of this.classMap.keys()) if (this.classMap.get(n)!.packageName === undefined) builtinAlias.set(n, n);
    for (const n of builtinAlias.keys()) this.classMap.get(n)!.importAlias = builtinAlias;
    // Fully-qualified names of the built-in classes, MEASURED on adl 51.4.1
    // (temp/pkgA/fqn-result.txt: getDefinitionByName over candidate packages,
    // then getQualifiedClassName on the resolved Class) -- never guessed from
    // memory. AIR identifies a class by its "pkg::Name" fqn everywhere it names
    // one: TypeError #1034 / ReferenceError #1056 / #1069 messages (through
    // as_fqn_dotted), getQualifiedClassName, getQualifiedSuperclassName and
    // describeType. Built-ins previously carried no fqn, so the vtable slot fell
    // back to the bare C name and `var d:Object = sprite; d.transform = 5`
    // reported "cannot convert 5 to Transform." instead of AIR's
    // "...to flash.geom.Transform.". Top-level classes (Object/Array/String/
    // Number/int/uint/Boolean/Function/Class/XML/XMLList/Date/RegExp/Error and
    // the error family/Namespace) keep their short name, exactly as measured.
    const BUILTIN_FQN: Record<string, string> = {
      // top-level
      Object: 'Object', Array: 'Array', String: 'String', Number: 'Number',
      Boolean: 'Boolean', Function: 'Function', Class: 'Class', Date: 'Date',
      RegExp: 'RegExp', Error: 'Error', Namespace: 'Namespace', XML: 'XML', XMLList: 'XMLList',
      TypeError: 'TypeError', ArgumentError: 'ArgumentError', RangeError: 'RangeError',
      ReferenceError: 'ReferenceError', SecurityError: 'SecurityError', VerifyError: 'VerifyError',
      DefinitionError: 'DefinitionError', EvalError: 'EvalError', URIError: 'URIError',
      // flash.display
      Sprite: 'flash.display::Sprite', Shape: 'flash.display::Shape',
      MovieClip: 'flash.display::MovieClip', Bitmap: 'flash.display::Bitmap',
      BitmapData: 'flash.display::BitmapData', Loader: 'flash.display::Loader',
      LoaderInfo: 'flash.display::LoaderInfo', DisplayObject: 'flash.display::DisplayObject',
      DisplayObjectContainer: 'flash.display::DisplayObjectContainer',
      InteractiveObject: 'flash.display::InteractiveObject',
      SimpleButton: 'flash.display::SimpleButton', Stage: 'flash.display::Stage',
      Stage3D: 'flash.display::Stage3D', Scene: 'flash.display::Scene',
      FrameLabel: 'flash.display::FrameLabel', Graphics: 'flash.display::Graphics',
      GraphicsPath: 'flash.display::GraphicsPath', GraphicsSolidFill: 'flash.display::GraphicsSolidFill',
      GraphicsEndFill: 'flash.display::GraphicsEndFill',
      GraphicsPathCommand: 'flash.display::GraphicsPathCommand',
      Shader: 'flash.display::Shader', ShaderData: 'flash.display::ShaderData',
      ShaderJob: 'flash.display::ShaderJob', ShaderParameter: 'flash.display::ShaderParameter',
      ShaderPrecision: 'flash.display::ShaderPrecision', ShaderInput: 'flash.display::ShaderInput',
      NativeWindow: 'flash.display::NativeWindow',
      NativeWindowInitOptions: 'flash.display::NativeWindowInitOptions',
      Screen: 'flash.display::Screen', NativeMenu: 'flash.display::NativeMenu',
      NativeMenuItem: 'flash.display::NativeMenuItem',
      NativeWindowDisplayState: 'flash.display::NativeWindowDisplayState',
      NativeWindowType: 'flash.display::NativeWindowType',
      NativeWindowSystemChrome: 'flash.display::NativeWindowSystemChrome',
      NativeWindowRenderMode: 'flash.display::NativeWindowRenderMode',
      BitmapDataChannel: 'flash.display::BitmapDataChannel',
      // flash.text
      TextField: 'flash.text::TextField', TextFormat: 'flash.text::TextFormat',
      TextLineMetrics: 'flash.text::TextLineMetrics', StyleSheet: 'flash.text::StyleSheet',
      Font: 'flash.text::Font',
      // flash.utils / flash.system / flash.filesystem / flash.desktop / flash.ui
      ByteArray: 'flash.utils::ByteArray', Dictionary: 'flash.utils::Dictionary',
      Timer: 'flash.utils::Timer', Proxy: 'flash.utils::Proxy',
      Capabilities: 'flash.system::Capabilities', System: 'flash.system::System',
      ApplicationDomain: 'flash.system::ApplicationDomain', IME: 'flash.system::IME',
      Security: 'flash.system::Security', LoaderContext: 'flash.system::LoaderContext',
      File: 'flash.filesystem::File', FileStream: 'flash.filesystem::FileStream',
      FileMode: 'flash.filesystem::FileMode',
      Clipboard: 'flash.desktop::Clipboard', NativeApplication: 'flash.desktop::NativeApplication',
      Mouse: 'flash.ui::Mouse', MouseCursor: 'flash.ui::MouseCursor', Keyboard: 'flash.ui::Keyboard',
      Multitouch: 'flash.ui::Multitouch', MultitouchInputMode: 'flash.ui::MultitouchInputMode',
      ContextMenu: 'flash.ui::ContextMenu', ContextMenuItem: 'flash.ui::ContextMenuItem',
      ContextMenuBuiltInItems: 'flash.ui::ContextMenuBuiltInItems',
      // flash.geom
      Transform: 'flash.geom::Transform', Matrix: 'flash.geom::Matrix', Matrix3D: 'flash.geom::Matrix3D',
      Point: 'flash.geom::Point', Rectangle: 'flash.geom::Rectangle',
      ColorTransform: 'flash.geom::ColorTransform', Vector3D: 'flash.geom::Vector3D',
      PerspectiveProjection: 'flash.geom::PerspectiveProjection',
      // flash.events
      Event: 'flash.events::Event', EventDispatcher: 'flash.events::EventDispatcher',
      MouseEvent: 'flash.events::MouseEvent', KeyboardEvent: 'flash.events::KeyboardEvent',
      TextEvent: 'flash.events::TextEvent', TimerEvent: 'flash.events::TimerEvent',
      ProgressEvent: 'flash.events::ProgressEvent', ErrorEvent: 'flash.events::ErrorEvent',
      VsyncStateChangeAvailabilityEvent: 'flash.events::VsyncStateChangeAvailabilityEvent',
      IOErrorEvent: 'flash.events::IOErrorEvent', FocusEvent: 'flash.events::FocusEvent',
      NetStatusEvent: 'flash.events::NetStatusEvent', DataEvent: 'flash.events::DataEvent',
      HTTPStatusEvent: 'flash.events::HTTPStatusEvent', ContextMenuEvent: 'flash.events::ContextMenuEvent',
      TouchEvent: 'flash.events::TouchEvent', AsyncErrorEvent: 'flash.events::AsyncErrorEvent',
      OutputProgressEvent: 'flash.events::OutputProgressEvent',
      ServerSocketConnectEvent: 'flash.events::ServerSocketConnectEvent',
      SecurityErrorEvent: 'flash.events::SecurityErrorEvent',
      // flash.net / flash.media / flash.filters / flash.display3D
      URLRequest: 'flash.net::URLRequest', URLVariables: 'flash.net::URLVariables',
      URLLoader: 'flash.net::URLLoader', URLStream: 'flash.net::URLStream',
      URLRequestHeader: 'flash.net::URLRequestHeader', URLRequestMethod: 'flash.net::URLRequestMethod',
      URLRequestDefaults: 'flash.net::URLRequestDefaults', Socket: 'flash.net::Socket',
      XMLSocket: 'flash.net::XMLSocket', NetConnection: 'flash.net::NetConnection',
      NetStream: 'flash.net::NetStream', SharedObject: 'flash.net::SharedObject',
      URLLoaderDataFormat: 'flash.net::URLLoaderDataFormat', ServerSocket: 'flash.net::ServerSocket',
      SecureSocket: 'flash.net::SecureSocket',
      Sound: 'flash.media::Sound', SoundChannel: 'flash.media::SoundChannel',
      SoundTransform: 'flash.media::SoundTransform', SoundMixer: 'flash.media::SoundMixer',
      SoundLoaderContext: 'flash.media::SoundLoaderContext', Video: 'flash.media::Video',
      Camera: 'flash.media::Camera', ID3Info: 'flash.media::ID3Info',
      AudioPlaybackMode: 'flash.media::AudioPlaybackMode',
      BitmapFilter: 'flash.filters::BitmapFilter', BlurFilter: 'flash.filters::BlurFilter',
      GlowFilter: 'flash.filters::GlowFilter', DropShadowFilter: 'flash.filters::DropShadowFilter',
      BitmapFilterQuality: 'flash.filters::BitmapFilterQuality',
      Context3D: 'flash.display3D::Context3D', Program3D: 'flash.display3D::Program3D',
      IndexBuffer3D: 'flash.display3D::IndexBuffer3D', VertexBuffer3D: 'flash.display3D::VertexBuffer3D',
      Texture: 'flash.display3D.textures::Texture', TextureBase: 'flash.display3D.textures::TextureBase',
      CubeTexture: 'flash.display3D.textures::CubeTexture',
      RectangleTexture: 'flash.display3D.textures::RectangleTexture',
      VideoTexture: 'flash.display3D.textures::VideoTexture',
      ImageDecodingPolicy: 'flash.system::ImageDecodingPolicy',
    };
    for (const [n, info] of this.classMap) {
      if (info.packageName !== undefined || info.fqn !== undefined || info.reflectFqn !== undefined) continue;
      const f = BUILTIN_FQN[n];
      if (f !== undefined) info.reflectFqn = f;
    }
    // pass 1: register class shells. superclass/implements are deferred to pass 1.5
    // (after every class is registered) so wildcard imports can expand against the
    // full classMap and per-file import context resolves short-name clashes.
    for (const stmt of program.body) {
      setGenPos(stmt.line, stmt.col);
      if (stmt.kind === 'ClassDecl') {
        const cname = fqn(stmt.name, stmt.packageName);
        const info: ClassInfo = {
          fields: new Map(),
          methods: new Map(),
          staticFields: new Map(),
          staticMethods: new Map(),
          getters: new Map(),
          setters: new Map(),
          constructor: { params: [] },
          superClass: 'Object',
          isFinal: stmt.isFinal,
          isDynamic: stmt.isDynamic,
          implements: [],
          packageName: stmt.packageName,
          fqn: stmt.packageName ? `${stmt.packageName}::${stmt.name}` : stmt.name,
          fileId: stmt.fileId ?? undefined,
        };
        this.classMap.set(cname, info);
      }
    }
    // pass 1.5: resolve superclass + implements with per-file import context.
    for (const stmt of program.body) {
      setGenPos(stmt.line, stmt.col);
      if (stmt.kind === 'ClassDecl') {
        const cname = fqn(stmt.name, stmt.packageName);
        const info = this.classMap.get(cname)!;
        const importAlias = buildImportAlias(stmt.imports, this.classMap);
        info.importAlias = importAlias;
        if (stmt.superClass) {
          const st = resolveType(stmt.superClass, importAlias);
          // `resolveType` maps the type-only built-ins (Array/String/Number/...)
          // to non-class CTypes that carry NO `className`, so reading `.className`
          // blindly made `class X extends Array` report a superclass literally
          // named "undefined" — an error far from the real cause. Name the actual
          // limitation instead. AIR accepts `extends Array` (2 files in the
          // talkmed-meeting closure use it: com.hurlant.util.der.Sequence,
          // com.fiCharts.utils.graphic.StyleManager), so this remains a LOUD,
          // honest gap rather than a misleading one.
          if (st.kind === 'interface') {
            throw new CodegenError(`class '${cname}' cannot extend interface '${stmt.superClass}'`);
          }
          if (st.kind !== 'object') {
            throw new CodegenError(`unsupported superclass '${stmt.superClass}' of '${cname}': subclassing built-in types is not implemented`);
          }
          info.superClass = st.className;
        }
        info.implements = stmt.implements.map((i) => {
          const t = resolveType(i, importAlias);
          return t.kind === 'interface' ? t.name : (t.kind === 'object' ? t.className : i);
        });
      }
    }
    // pass 1.6: a class extending a dynamic class is itself dynamic in AS3 (the
    // trait is inherited, not just declared), so propagate it along the super
    // chain to a fixpoint. This runs for built-ins too, which is what makes a
    // user subclass of `MovieClip` (a `dynamic class`) dynamic as AIR has it.
    for (let changed = true; changed; ) {
      changed = false;
      for (const info of this.classMap.values()) {
        if (info.isDynamic) continue;
        if (this.classMap.get(info.superClass)?.isDynamic) {
          info.isDynamic = true;
          changed = true;
        }
      }
    }
    // pass 1.7: same inheritance rule for the Proxy interceptor flag (a subclass
    // of a Proxy subclass is still a Proxy). The flag is also stamped onto the ten
    // flash_proxy-namespaced interceptor methods, so a subclass override of them is
    // kept out of the public member namespace exactly like Proxy's own (the parser
    // drops the `flash_proxy` qualifier, so the name is the only signal).
    for (let changed = true; changed; ) {
      changed = false;
      for (const info of this.classMap.values()) {
        if (info.isProxy) continue;
        if (this.classMap.get(info.superClass)?.isProxy) {
          info.isProxy = true;
          changed = true;
        }
      }
    }
    // pass 2: direct fields / constructor / methods.
    for (const stmt of program.body) {
      setGenPos(stmt.line, stmt.col);
      if (stmt.kind === 'ClassDecl') {
        const cname = fqn(stmt.name, stmt.packageName);
        const info = this.classMap.get(cname)!;
        for (const m of stmt.members) {
          // A semantic error inside a member signature/`[WasmExport]` belongs to
          // the member, not to the whole class.
          setGenPos(m.line ?? stmt.line, m.col ?? stmt.col);
          if (m.kind === 'Field') {
            // An `[Embed]` field has no source-level initializer; its value is the
            // generated asset class, injected as a Class-value reference (a bare
            // class name, which emit resolves to `&<cname>_cls`). This is the ONE
            // place a field's initializer is decided, so the static (`_cinit`) and
            // instance (constructor) paths both pick it up unchanged.
            const embedClass = this.embedFieldInits.get(SymbolTable.embedFieldKey(stmt.name, stmt.packageName, m.name));
            const init: Expr | null =
              embedClass !== undefined ? { kind: 'Var', name: embedClass } : m.init;
            // A class field with NO type annotation is `*` (dynamic) in AIR, NOT
            // `int`: `public var u;` defaults to null and accepts a String or a
            // Number, and `public var v = 5;` is still dynamic (measured on
            // adl 51.4.1, temp/qfix/gcadl/Untyped.as). AGENTS.md §2.4's `var x; ->
            // int` convention is for FUNCTION-scope declarations and does not
            // apply to class members, so only this field path maps null to `any`.
            const ftype: CType = m.type === null ? { kind: 'any' } : resolveType(m.type, info.importAlias);
            const f: FieldInfo = { name: m.name, type: ftype, init, visibility: m.visibility, owner: cname, isStatic: m.isStatic, isConst: m.isConst };
            checkTypeAnnotation(m.type, info.importAlias, this);
            // Only `static` makes a field class-level in AS3. A bare `const` is an
            // instance constant (each instance carries its own immutable value),
            // e.g. `private const _textures:Vector.<Texture>`.
            if (m.isStatic) info.staticFields.set(m.name, f);
            else info.fields.set(m.name, f);
          } else if (m.kind === 'Constructor') {
            for (const p of m.params) checkTypeAnnotation(p.type, info.importAlias, this);
            info.constructor = { params: m.params };
          }
        }
        for (const m of stmt.members) {
          setGenPos(m.line ?? stmt.line, m.col ?? stmt.col);
          if (m.kind === 'Method') {
            checkTypeAnnotation(m.returnType, info.importAlias, this);
            for (const p of m.params) checkTypeAnnotation(p.type, info.importAlias, this);
            const mi: MethodInfo = { returnType: resolveType(m.returnType, info.importAlias), params: m.params, owner: cname, visibility: m.visibility, isStatic: m.isStatic, isFinal: m.isFinal, isGetter: m.isGetter, isSetter: m.isSetter, metadata: m.metadata, ns: m.ns };
            // [WasmExport] on a method: only static methods lower to a `this`-free
            // C function callable from JS. Instance methods carry a leading
            // `void* _this` (plus GC-heap construction JS cannot perform) and
            // getters/setters have distinct signatures — all rejected at compile
            // time rather than silently mis-exported.
            const we = m.metadata.find((md) => md.name === 'WasmExport');
            if (we) {
              if (!m.isStatic) throw new CodegenError(`[WasmExport] cannot be applied to instance method '${cname}.${m.name}': only static methods (and top-level functions) are callable from JS`);
              if (m.isGetter || m.isSetter) throw new CodegenError(`[WasmExport] cannot be applied to getter/setter '${cname}.${m.name}'`);
              this.exportList.push({
                symbol: `${cname}_${m.name}_static`,
                alias: we.args[0] ?? null,
                returnType: resolveType(m.returnType, info.importAlias),
                params: m.params.map((p) => ({ name: p.name, type: resolveType(p.type, info.importAlias) })),
              });
            }
            if (m.isGetter && m.isStatic) (info.staticGetters ??= new Map()).set(m.name, mi);
            else if (m.isGetter) info.getters.set(m.name, mi);
            else if (m.isSetter && m.isStatic) (info.staticSetters ??= new Map()).set(m.name, mi);
            else if (m.isSetter) info.setters.set(m.name, mi);
            else if (m.isStatic) info.staticMethods.set(m.name, mi);
            else info.methods.set(m.name, mi);
          }
        }
      } else if (stmt.kind === 'FuncDecl') {
        checkTypeAnnotation(stmt.returnType, null, this);
        for (const p of stmt.params) checkTypeAnnotation(p.type, null, this);
        this.funcMap.set(stmt.name, { returnType: resolveType(stmt.returnType), params: stmt.params, metadata: stmt.metadata });
        // [WasmExport] on a top-level function: it lowers to a same-named, `this`-free
        // C global, directly callable from JS.
        const we = stmt.metadata.find((md) => md.name === 'WasmExport');
        if (we) {
          this.exportList.push({
            symbol: stmt.name,
            alias: we.args[0] ?? null,
            returnType: resolveType(stmt.returnType),
            params: stmt.params.map((p) => ({ name: p.name, type: resolveType(p.type) })),
          });
        }
      }
    }
    // pass 2.1: validate interface-METHOD annotations. This deliberately cannot run in
    // pass 0: `hasClass` there sees only the built-ins (pass 1 registers user class
    // shells), so an interface method naming a user class was reported as
    // `unknown type 'X'` — measured on examples/air-starling-demo (IFilterHelper's
    // `getTexture(): Texture`). Interfaces are still registered in pass 0; only this
    // check is deferred until the full symbol table exists.
    for (const stmt of program.body) {
      if (stmt.kind !== 'InterfaceDecl') continue;
      setGenPos(stmt.line, stmt.col);
      const iface = this.interfaceMap.get(fqn(stmt.name, stmt.packageName));
      if (iface === undefined) continue;
      for (const m of stmt.methods) {
        checkTypeAnnotation(m.returnType, iface.importAlias, this);
        for (const p of m.params) checkTypeAnnotation(p.type, iface.importAlias, this);
      }
    }
    // pass 2.5: stamp the flash_proxy-namespaced interceptor methods. This must
    // run AFTER pass 2 has registered the user classes' members. Only a method
    // that actually carries the `flash_proxy` qualifier is an interceptor: on
    // adl 51.4.1 a PUBLIC-namespace `getProperty` on a Proxy subclass is an
    // ordinary method and dynamic access still hits the base Proxy's #2088.
    for (const info of this.classMap.values()) {
      if (!info.isProxy) continue;
      for (const [n, m] of info.methods) if (PROXY_NS_METHODS.has(n) && m.ns === 'flash_proxy') m.isProxyNs = true;
    }
    // pass 0.2: merge inherited interface methods (interface I extends A). An
    // interface inherits every method of its parents, so a class implementing I
    // must implement them too. Parents may be declared after the child, hence the
    // recursion with a memo; a cycle is a compile-time error.
    {
      const memo = new Set<string>();
      const merge = (iname: string, visiting: Set<string>): void => {
        if (memo.has(iname)) return;
        const info = this.interfaceMap.get(iname);
        if (!info || !info.extends || info.extends.length === 0) { memo.add(iname); return; }
        if (visiting.has(iname)) throw new CodegenError(`circular interface inheritance involving '${iname}'`);
        visiting.add(iname);
        for (const p of info.extends) {
          if (!this.interfaceMap.has(p)) throw new CodegenError(`unknown parent interface '${p}' of '${iname}'`);
          merge(p, visiting);
          const pInfo = this.interfaceMap.get(p)!;
          for (const [m, mi] of pInfo.methods) if (!info.methods.has(m)) info.methods.set(m, mi);
          for (const [m, mi] of pInfo.getters) if (!info.getters.has(m)) info.getters.set(m, mi);
          for (const [m, mi] of pInfo.setters) if (!info.setters.has(m)) info.setters.set(m, mi);
        }
        visiting.delete(iname);
        memo.add(iname);
      };
      for (const iname of [...this.interfaceMap.keys()]) merge(iname, new Set());
    }
    // pass 3: flatten inherited members into each subclass.
    for (const name of this.classMap.keys()) {
      this.expandInheritance(name);
    }
    // pass 4: verify each class implements every method of its interfaces.
    for (const [name, info] of this.classMap) {
      const cpos = this.classPos.get(name);
      setGenPos(cpos?.line, cpos?.col);
      for (const iname of info.implements) {
        const intf = this.interfaceMap.get(iname);
        if (!intf) throw new CodegenError(`unknown interface '${iname}'`);
        for (const [mname, im] of [...intf.methods, ...intf.getters, ...intf.setters]) {
          const impl = im.isGetter ? info.getters.get(mname) : im.isSetter ? info.setters.get(mname) : info.methods.get(mname);
          if (impl) continue;
          // AS3 requires an ACCESSOR to satisfy an interface accessor: a plain
          // `public var` does NOT (measured on adl 51.4.1 — mxmlc rejects
          // `class C implements I{get/set y} { public var y:Number; }`). But a
          // BUILT-IN property is an accessor pair in AIR even though our C model
          // stores it as a field, so inheriting e.g. `DisplayObject.y` DOES satisfy
          // it (measured: `class T extends Sprite implements I{get/set y}` compiles).
          // `isAccessor` marks exactly those built-in fields; fields are flattened
          // by expandInheritance, so an inherited one is found here too.
          const slot = info.fieldKeys?.get(mname);
          const f = slot !== undefined ? info.fields.get(slot) : undefined;
          if (!(f && f.isAccessor)) {
            throw new CodegenError(`class '${name}' does not implement method '${mname}' of interface '${iname}'`);
          }
        }
      }
    }
  }

  getClass(name: string): ClassInfo | undefined { return this.classMap.get(name); }
  getFunc(name: string): FuncInfo | undefined { return this.funcMap.get(name); }
  hasClass(name: string): boolean { return this.classMap.has(name); }
  hasInterface(name: string): boolean { return this.interfaceMap.has(name); }

  // Walk the superclass chain looking for a method/field/getter declared on the
  // class or any ancestor (AS3 dispatches through the vtable, so an inherited
  // method is still callable via `obj.method()` even when the receiver's static
  // class does not declare it — e.g. `tween.hasOwnProperty(name)` inherited from
  // Object). Returns the owning ClassInfo + the member, or undefined.
  findMethod(cls: string, name: string): { owner: string; m: MethodInfo } | undefined {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (info) {
        const m = info.methods.get(name);
        if (m) return { owner: cur, m };
        cur = info.superClass;
      } else break;
    }
    return undefined;
  }
  // Same super-chain walk for an instance getter. Needed when a class receiver
  // names an accessor as a method (`obj.prop()`): AIR reads the property and then
  // calls the resulting value, so codegen must find the (possibly inherited)
  // getter before concluding the method is undefined.
  findGetter(cls: string, name: string): { owner: string; g: MethodInfo } | undefined {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (info) {
        const g = info.getters.get(name);
        if (g) return { owner: cur, g };
        cur = info.superClass;
      } else break;
    }
    return undefined;
  }
  // Look up an instance field's storage slot by AS3 name in one class's flattened
  // map. The map is keyed by C slot name, so a name that shadows an inherited
  // field (which owns a mangled slot) is translated through `fieldKeys` first.
  fieldSlot(cls: string, name: string): FieldInfo | undefined {
    const info = this.classMap.get(cls);
    if (!info) return undefined;
    const key = info.fieldKeys?.get(name);
    if (key !== undefined) return info.fields.get(key);
    return info.fields.get(name);
  }

  findField(cls: string, name: string): { owner: string; f: FieldInfo } | undefined {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (info) {
        const f = this.fieldSlot(cur, name);
        if (f) return { owner: cur, f };
        cur = info.superClass;
      } else break;
    }
    return undefined;
  }

  // AS3 settles an instance-member reference by the NEAREST declaration in the
  // superclass chain, and a level's OWN declaration shadows EVERY inherited member
  // of that name whatever kind the inherited one has. The flattened maps cannot
  // express that on their own: `info.fields` is flattened and keyed by C slot (so a
  // subclass's own field of a colliding name wins through `fieldKeys`), but an
  // ANCESTOR's field is still what `fieldSlot()` returns -- and the read paths
  // consult fields before getters. away3d hits exactly that seam:
  // `away3d.containers.ObjectContainer3D` declares `get parent():ObjectContainer3D`
  // while our built-in `EventDispatcher` carries the display-list ancestor link in
  // a slot also named `parent` (AIR's EventDispatcher has no `parent` at all, so
  // the two never meet there). The inherited slot won, `parent` read NULL, and
  // Intermediate_MD5Animation died in updateMouseChildren with #1009.
  //
  // Answers "does the class (or any level between it and `fieldOwner`) declare
  // `name` itself as a GETTER or METHOD?" -- i.e. must an inherited field be
  // skipped when the name is READ? Walks level by level, so an accessor declared on
  // an intermediate class counts too. The field slot (and the method/getter maps)
  // are flattened, so an own accessor of a colliding name owns `owner === level`.
  //
  // SETTERS are deliberately NOT counted here, and this is the whole reason the
  // helper is read-specific: our built-in classes keep AIR's accessor PAIRS as
  // stored fields (`DisplayObject.x` is a field marked `isAccessor`), so a subclass
  // that overrides only the setter -- away3d's `View3D` does `override set x`, then
  // its setter body reads `x` -- has an own setter but no own getter to fall back
  // to. Counting it would make the read of `x` vanish (measured: `Codegen error at
  // 510:4: undefined variable 'x' in class away3d_containers_View3D`), whereas AIR
  // reads the inherited base getter. A nearer setter only governs WRITES, and the
  // write paths resolve setters ahead of the field on their own.
  shadowedForRead(cls: string, fieldOwner: string, name: string): boolean {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && cur !== fieldOwner && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (!info) return false;
      const g = info.getters.get(name);
      if (g && g.owner === cur) return true;
      // A namespace-proxy stub is not a real trait (`isProxyNs`), so it must not
      // shadow an inherited field any more than it can serve a `obj.name` read.
      const m = info.methods.get(name);
      if (m && m.owner === cur && !m.isProxyNs) return true;
      cur = info.superClass;
    }
    return false;
  }

  // The C member name of a field slot: `cName` once flattening named it, else the
  // AS3 name itself (unshadowed fields are stored under their own name).
  static fieldCName(f: FieldInfo, fallback: string): string { return f.cName ?? fallback; }
  findGetter(cls: string, name: string): { owner: string; g: MethodInfo } | undefined {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (info) {
        const g = info.getters.get(name);
        if (g) return { owner: cur, g };
        cur = info.superClass;
      } else break;
    }
    return undefined;
  }

  // Same walk for the write side: an accessor pair declared on a superclass
  // (`Mesh.colorTransform`) must be found through the chain, exactly like reads
  // already are (`vtable->get_x` is flattened).
  findSetter(cls: string, name: string): { owner: string; s: MethodInfo } | undefined {
    let cur: string | null = cls;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const info = this.classMap.get(cur);
      if (info) {
        const s = info.setters.get(name);
        if (s) return { owner: cur, s };
        cur = info.superClass;
      } else break;
    }
    return undefined;
  }

  isSubclassOf(cls: string, base: string): boolean {
    let cur: string | null = cls;
    while (cur !== null) {
      if (cur === base) return true;
      cur = this.classMap.get(cur)?.superClass ?? null;
    }
    return false;
  }

  isAccessible(visibility: Visibility, owner: string, from: string | null): boolean {
    if (visibility === 'public') return true;
    if (from === null) return false; // top-level code has no class context
    if (visibility === 'private') return owner === from;
    if (visibility === 'internal') {
      // visible within the same package (both top-level => null package).
      const ownerInfo = this.classMap.get(owner);
      const fromInfo = this.classMap.get(from);
      const ownerPkg = ownerInfo?.packageName ?? null;
      const fromPkg = fromInfo?.packageName ?? null;
      // Same file (--air-app mode): a file's members see each other's internal
      // members even across a package-block boundary (Starling puts helper classes
      // like `AssetPostProcessor` after the `package { }` block of the same file).
      if (ownerInfo?.fileId && ownerInfo.fileId === fromInfo?.fileId) return true;
      // AS3 §5.1 places top-level definitions OUTSIDE any `package { ... }` block
      // (e.g. Starling's `class AssetPostProcessor` after the AssetManager package
      // block) into a per-file anonymous namespace visible only within that file.
      // We don't track file boundaries in single-file mode, so a null-package
      // owner's internal member is treated as visible everywhere: in practice these
      // are in-file helper classes whose sole consumer is the same file's
      // named-package class.
      if (ownerPkg === null) return true;
      return ownerPkg === fromPkg;
    }
    // protected: accessible within the declaring class or a subclass
    return this.isSubclassOf(from, owner);
  }

  private expandInheritance(name: string, visiting: Set<string> = new Set()): void {
    const info = this.classMap.get(name)!;
    const pos = this.classPos.get(name);
    setGenPos(pos?.line, pos?.col);
    if (info.superClass === null) {
      // Base class (Object): the vtable slot list is just its own members.
      info.vtableSlots = this.buildVtableSlots([], info.methods, info.getters, info.setters);
      return;
    }
    if (visiting.has(name)) throw new CodegenError(`circular inheritance involving '${name}'`);
    const superInfo = this.classMap.get(info.superClass);
    if (!superInfo) throw new CodegenError(`unknown superclass '${info.superClass}' of '${name}'`);
    if (superInfo.isFinal) throw new CodegenError(`cannot inherit from final class '${info.superClass}'`);
    // Capture own members BEFORE flattening: expandInheritance overwrites
    // info.methods/getters/setters with the flattened (super-first) maps below,
    // but the vtable slot merge needs only the OWN members so overrides replace
    // an inherited slot in place and new members append.
    const ownMethods = info.methods;
    const ownGetters = info.getters;
    const ownSetters = info.setters;
    visiting.add(name);
    this.expandInheritance(info.superClass, visiting);
    visiting.delete(name);
    const superInfo2 = this.classMap.get(info.superClass)!;
    // Flatten inherited members into this class's maps (super-first order; own
    // members override in place via Map.set preserving insertion position).
    //
    // Fields are the exception: their map is keyed by C SLOT name, and a field
    // whose name collides with an inherited field gets its own mangled slot
    // instead of overwriting the inherited entry. AS3 scopes a private member to
    // its declaring class, so `private var _mask` in a subclass and `_mask` in
    // its superclass are two distinct slots: methods of the base see the base's
    // (reached through a base-typed pointer, hence the inherited slot must keep
    // its name and offset in every subclass struct), while methods of the
    // subclass see their own. Collapsing both onto one C member silently aliased
    // them — a scene's own `_mask` became the stage mask of its DisplayObject
    // base and stencil-clipped every sibling drawn after it.
    const fields = new Map<string, FieldInfo>();
    for (const [k, v] of superInfo2.fields) fields.set(k, v);
    const fieldKeys = new Map<string, string>(superInfo2.fieldKeys ?? []);
    for (const [k, v] of info.fields) {
      // `f.owner === name` selects THIS class's own declarations: on a repeated
      // flatten of an already-flattened class (expandInheritance has no memo) the
      // iteration also sees inherited entries, which must not be re-processed.
      if (v.owner !== name) continue;
      const as3 = v.name ?? k;
      let slot = v.cName;
      if (slot === undefined) {
        slot = fieldKeys.has(as3) ? `${as3}__${name.replace(/[^A-Za-z0-9_]/g, '_')}` : as3;
        v.cName = slot;
      }
      fields.set(slot, v);
      fieldKeys.set(as3, slot);
    }
    info.fields = fields;
    info.fieldKeys = fieldKeys;

    const methods = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.methods) methods.set(m, v);
    for (const [m, v] of ownMethods) {
      const overridden = methods.get(m);
      if (overridden && overridden.isFinal) {
        throw new CodegenError(`cannot override final method '${m}' of '${overridden.owner}'`);
      }
      methods.set(m, v);
    }
    info.methods = methods;

    const staticFields = new Map<string, FieldInfo>();
    for (const [f, v] of superInfo2.staticFields) staticFields.set(f, v);
    for (const [f, v] of info.staticFields) staticFields.set(f, v);
    info.staticFields = staticFields;

    const staticMethods = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.staticMethods) staticMethods.set(m, v);
    for (const [m, v] of info.staticMethods) staticMethods.set(m, v);
    info.staticMethods = staticMethods;

    const getters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.getters) getters.set(m, v);
    for (const [m, v] of ownGetters) getters.set(m, v);
    info.getters = getters;

    const setters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.setters) setters.set(m, v);
    for (const [m, v] of ownSetters) setters.set(m, v);
    info.setters = setters;

    const staticGetters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.staticGetters ?? []) staticGetters.set(m, v);
    for (const [m, v] of info.staticGetters ?? []) staticGetters.set(m, v);
    info.staticGetters = staticGetters;

    const staticSetters = new Map<string, MethodInfo>();
    for (const [m, v] of superInfo2.staticSetters ?? []) staticSetters.set(m, v);
    for (const [m, v] of info.staticSetters ?? []) staticSetters.set(m, v);
    info.staticSetters = staticSetters;

    // interfaces are inherited: a subclass implements its superclass's interfaces too.
    info.implements = [...new Set([...superInfo2.implements, ...info.implements])];
    // ... and an interface's PARENTS are interfaces of the class as well
    // (`class C implements IChild` where `interface IChild extends IParent` means C
    // is also an IParent). Recorded transitively here so emitInterfaceVtables builds
    // a per-class vtable for every parent, which is what a runtime `x as IParent`
    // looks up through as_iface_lookup.
    {
      const seen = new Set<string>();
      const add = (n: string): void => {
        if (seen.has(n)) return;
        seen.add(n);
        for (const p of this.interfaceMap.get(n)?.extends ?? []) add(p);
      };
      for (const n of info.implements) add(n);
      info.implements = [...seen];
    }

    // Unified vtable slot list: start from the superclass's (already flattened)
    // slots so inherited members keep their byte offset, then merge own members
    // (override in place, append new) in the same kind order (method -> getter ->
    // setter). This guarantees prefix-stable vtable layout across the chain.
    info.vtableSlots = this.buildVtableSlots(superInfo2.vtableSlots ?? [], ownMethods, ownGetters, ownSetters);
  }

  // Build a prefix-stable vtable slot list: superclass slots first, then OWN
  // members merged in place (an own member with the same kind+name as an inherited
  // slot replaces it; anything new appends). ownMethods/getters/setters must be
  // the OWN (pre-flattening) member maps of the class being built.
  private buildVtableSlots(superSlots: VtableSlot[], ownMethods: Map<string, MethodInfo>, ownGetters: Map<string, MethodInfo>, ownSetters: Map<string, MethodInfo>): VtableSlot[] {
    const slots: VtableSlot[] = [...superSlots];
    const merge = (kind: VtableSlot['kind'], map: Map<string, MethodInfo>): void => {
      for (const [mname, m] of map) {
        const idx = slots.findIndex((s) => s.kind === kind && s.name === mname);
        if (idx >= 0) slots[idx] = { kind, name: mname, info: m };
        else slots.push({ kind, name: mname, info: m });
      }
    };
    merge('method', ownMethods);
    merge('getter', ownGetters);
    merge('setter', ownSetters);
    return slots;
  }
}
