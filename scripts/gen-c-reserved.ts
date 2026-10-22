// Generate `src/c-reserved.gen.ts`: every C identifier the generated translation
// unit can inherit from a system header.
//
// Why this is machine-generated instead of a hand-written list: a top-level AS3
// function is emitted into C under its own name (see `Emitter.freeCName`), and C
// has ONE identifier namespace for functions. Any name the linked headers already
// declare -- `bind`, `socket`, `printf`, `stat` -- is therefore a hard compile
// error the moment a user writes a function with that name, even though the name
// is perfectly legal AS3 and `adl` runs it. A hand-written table was always one
// forgotten family away from that (measured: `bind` was missing while its
// neighbours `div`/`free`/`time` were present). The compiler already knows the
// full list, so ask it instead of guessing.
//
// TWO sources, because they fail differently:
//   * FunctionDecl from `-Xclang -ast-dump` -- the redeclaration conflict
//     ("conflicting types for 'bind'"). This is the one that was missing.
//   * Macro names from `-E -dM` -- argument-taking macros break the call site
//     ("too few arguments"), while object-like host macros such as `_stat`
//     (`#define _stat _stat64i32`) rewrite the identifier in the declaration
//     itself, which is why a `_`-PREFIXED rename cannot escape them.
//
// Scope of the emitted table is ONE platform's header surface (whichever machine
// ran it). `symbols.ts` unions it with a small hand-written seed that carries the
// POSIX names a Windows header sweep cannot see, so the shipped set is a superset
// of any single platform -- over-inclusion is harmless (a rename only happens on
// an exact match), under-inclusion is a compile error.
//
// Usage:
//   node scripts/gen-c-reserved.ts [--cc <path-to-cc>] [--out <file>]
// `--cc` defaults to $CC, then `clang`, then `cc`.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const cc = opt('--cc') ?? process.env.CC ?? 'clang';
const outPath = opt('--out') ?? join(root, 'src', 'c-reserved.gen.ts');

// The TU mirrors the header surface RUNTIME_PREAMBLE pulls in, with the same
// defines it sets (`_USE_MATH_DEFINES` for M_PI, `NOGDI` to keep GDI out of the
// Windows sweep). Any header the preamble adds later must be added here too,
// otherwise names from it silently fall back to the hand-written seed.
const COMMON_HEADERS = ['stdio.h', 'stdlib.h', 'string.h', 'stdbool.h', 'stddef.h',
  'stdint.h', 'errno.h', 'math.h', 'ctype.h', 'setjmp.h', 'time.h', 'sys/stat.h',
  'zlib.h', 'signal.h', 'fcntl.h'];
const WIN_HEADERS = ['io.h', 'process.h', 'windows.h', 'psapi.h', 'sys/time.h'];
const POSIX_HEADERS = ['unistd.h', 'dirent.h', 'sys/statvfs.h', 'sys/time.h',
  'sys/resource.h', 'sys/socket.h', 'netinet/in.h', 'netinet/tcp.h', 'netdb.h',
  'arpa/inet.h', 'poll.h', 'pthread.h'];

function buildTu(headers: string[], winHeaders: string[], posixHeaders: string[]): string {
  const inc = (hs: string[]) => hs.map((h) => `#include <${h}>\n`).join('');
  return `#define _USE_MATH_DEFINES\n#define NOGDI\n`
    + inc(headers)
    + `#if defined(_WIN32)\n` + inc(winHeaders) + `#else\n` + inc(posixHeaders) + `#endif\n`;
}

function run(args: string[]): string {
  return execFileSync(cc, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function runQuiet(args: string[]): { ok: boolean; stderr: string } {
  try {
    execFileSync(cc, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stderr: '' };
  } catch (e) {
    return { ok: false, stderr: String((e as { stderr?: string }).stderr ?? '') };
  }
}

// A header the platform does not ship (zlib on a bare clang, <dirent.h> on MSVC)
// must not abort the sweep: drop it and retry. Dropping a header only narrows the
// generated set, which the hand-written POSIX seed in symbols.ts backstops.
function makeTu(extraArgs: string[]): { text: string; dropped: string[] } {
  let headers = [...COMMON_HEADERS];
  let win = [...WIN_HEADERS];
  let posix = [...POSIX_HEADERS];
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    const text = buildTu(headers, win, posix);
    writeFileSync(tuPath, text);
    const probe = runQuiet(['-fsyntax-only', ...extraArgs, tuPath]);
    if (probe.ok) return { text, dropped };
    const missing = /fatal error: '([^']+)' file not found/.exec(probe.stderr);
    if (!missing) {
      throw new Error(`cannot build the header TU: ${probe.stderr.slice(0, 2000)}`);
    }
    const gone = missing[1];
    const before = headers.length + win.length + posix.length;
    headers = headers.filter((h) => h !== gone);
    win = win.filter((h) => h !== gone);
    posix = posix.filter((h) => h !== gone);
    if (headers.length + win.length + posix.length === before) {
      throw new Error(`header '${gone}' reported missing but is not in the TU list`);
    }
    dropped.push(gone);
  }
  throw new Error('gave up dropping missing headers');
}

// A name a user could plausibly write in AS3. C reserves `__`-prefixed and
// `_[A-Z]`-prefixed identifiers outright, so renaming those would protect a name
// nobody writes at the cost of a table twice the size.
function plausible(name: string): boolean {
  if (name.startsWith('__')) return false;
  if (/^_[A-Z]/.test(name)) return false;
  return true;
}

// ALL_CAPS object-like macros are Win32/POSIX constants (`ABE_TOP`, `TRUE`,
// `MAX_PATH`). They are emitted as `g_`-prefixed or member-scoped C names, never
// as a bare file-scope function, so they cannot collide with a user function --
// and there are ~24k of them. Function-like macros are kept in any casing: an
// argument-taking macro breaks the CALL SITE, which is exactly the free-function
// path.
function keepMacro(name: string, functionLike: boolean): boolean {
  if (!plausible(name)) return false;
  if (functionLike) return true;
  return !/^[A-Z][A-Z0-9_]*$/.test(name);
}

const tuPath = join(root, 'temp', 'gen-c-reserved.tu.c');
const { dropped } = makeTu([]);

const macroText = run(['-E', '-dM', tuPath]);
const astText = run(['-fsyntax-only', '-Xclang', '-ast-dump', tuPath]);

const names = new Set<string>();
let macroCount = 0;
for (const line of macroText.split('\n')) {
  const m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)(\()?/.exec(line);
  if (!m) continue;
  if (!keepMacro(m[1], m[2] === '(')) continue;
  names.add(m[1]);
  macroCount++;
}
let fnCount = 0;
for (const m of astText.matchAll(/FunctionDecl[^\n]*?\s([A-Za-z_][A-Za-z0-9_]*)\s+'/g)) {
  if (!plausible(m[1])) continue;
  names.add(m[1]);
  fnCount++;
}

const sorted = [...names].sort();
const version = run(['--version']).split('\n')[0].trim();
const lines: string[] = [
  '// GENERATED FILE -- do not edit by hand.',
  '//',
  '// Every C identifier the generated translation unit can inherit from a system',
  '// header (declared function or defined macro), minus the names C reserves for the',
  '// implementation. This is the table `Emitter.freeCName` / `qualifiedName` rename',
  '// against; `symbols.ts` unions it with a hand-written POSIX seed, so the shipped',
  '// set is a superset of any one platform.',
  '//',
  '// Regenerate: node scripts/gen-c-reserved.ts [--cc <clang>]',
  `// Platform of record: ${process.platform} ${process.arch}`,
  `// Compiler: ${version.replace(/\s+/g, ' ')}`,
  `// Entries: ${sorted.length} (${macroCount} macros, ${fnCount} functions, before dedupe)`,
  `// Headers unavailable on this platform (dropped): ${dropped.length === 0 ? 'none' : dropped.join(', ')}`,
  '//',
  '// Over-inclusion is harmless: a name is only rewritten when it matches exactly.',
  '// Under-inclusion is a hard compile error, measured as `conflicting types for',
  "// 'bind'` against <winsock.h> (see asaotui/compiler-gaps.md G8).",
  'export const C_RESERVED_HEADERS = new Set<string>(',
  '  `',
];

// 8 per line: one long line would be unreviewable, one-per-line would be ~7000.
const CHUNK = 8;
for (let i = 0; i < sorted.length; i += CHUNK) {
  lines.push('    ' + sorted.slice(i, i + CHUNK).join(' '));
}
lines.push('  `.split(/\\s+/).filter((s) => s.length > 0),');
lines.push(');');
lines.push('');

writeFileSync(outPath, lines.join('\r\n'));
console.log(`wrote ${outPath}: ${sorted.length} names `
  + `(${macroCount} macro hits, ${fnCount} function hits)`);