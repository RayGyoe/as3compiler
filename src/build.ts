// Build orchestration: turns the generated C plus optional extra sources,
// include paths and link libraries into a compiler invocation for a chosen
// target (native executable or WASI .wasm). Keeps the "single readable .c"
// pipeline as the default shape while allowing third-party libraries (skia,
// cairo, SDL, ...) to be linked in exactly the way TypePHP links GMP/MPFR/PHPX.
//
// The frontend still only translates AS -> C; everything here is *linking and
// targeting*, not optimization or machine-code generation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export type Target = 'native' | 'wasm';

export interface BuildConfig {
  target: Target;
  cCompiler: string;
  opt: string;
  // extra C/C++ source files compiled together with the generated .c
  sources: string[];
  includePaths: string[];
  linkLibs: string[];
  linkPaths: string[];
  defines: string[];
  // precompiled object files added directly to the link step
  objects: string[];
  // macOS frameworks passed to the linker as -framework X (Skia's CoreText/
  // CoreGraphics font/image backends pull these in)
  frameworks: string[];
  // C symbols to expose in the .wasm export table (--target wasm only), so the
  // host can call them directly via instance.exports.NAME. A top-level AS3
  // function `function fib(n:int):int` lowers to a same-named C global, which is
  // exported here — the AOT analogue of Emscripten's cwrap/ccall.
  exports: string[];
  dry: boolean;
}

export function defaultBuildConfig(): BuildConfig {
  return {
    target: 'native',
    cCompiler: 'cc',
    opt: '-O2',
    sources: [],
    includePaths: [],
    linkLibs: [],
    linkPaths: [],
    defines: [],
    objects: [],
    frameworks: [],
    exports: [],
    dry: false,
  };
}

// A build manifest (JSON) mirrors TypePHP's project.yml: a file that fixes
// reusable, version-controlled build settings. JSON is used instead of YAML to
// keep the zero-dependency constraint (Node parses it natively). Fields use the
// same kebab-case names as TypePHP where they overlap.
interface Manifest {
  target?: 'native' | 'wasm';
  'c-compiler'?: string;
  opt?: string;
  sources?: string[];
  'include-paths'?: string[];
  'link-libs'?: string[];
  'link-paths'?: string[];
  defines?: string[];
  objects?: string[];
  frameworks?: string[];
  exports?: string[];
}

export function loadManifest(path: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read build manifest: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in build manifest: ${path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`build manifest must be a JSON object: ${path}`);
  }
  return parsed as Manifest;
}

// Merge a manifest over the base config. CLI flags take precedence (they are
// applied after the manifest in index.ts), so this only fills in what the CLI
// has not already overridden — matching TypePHP's "CLI beats YAML" rule.
// Path-valued fields in the manifest are resolved relative to the manifest
// file's directory (TypePHP resolves YAML paths the same way).
export function applyManifest(cfg: BuildConfig, m: Manifest, manifestPath: string): BuildConfig {
  const next: BuildConfig = { ...cfg };
  if (m.target) next.target = m.target;
  if (m['c-compiler']) next.cCompiler = m['c-compiler'];
  if (m.opt) next.opt = m.opt;
  if (m.sources) next.sources = [...cfg.sources, ...m.sources.map((p) => resolveFromManifest(manifestPath, p))];
  if (m['include-paths']) next.includePaths = [...cfg.includePaths, ...m['include-paths'].map((p) => resolveFromManifest(manifestPath, p))];
  if (m['link-libs']) next.linkLibs = [...cfg.linkLibs, ...m['link-libs']];
  if (m['link-paths']) next.linkPaths = [...cfg.linkPaths, ...m['link-paths'].map((p) => resolveFromManifest(manifestPath, p))];
  if (m.defines) next.defines = [...cfg.defines, ...m.defines];
  if (m.objects) next.objects = [...cfg.objects, ...m.objects.map((p) => resolveFromManifest(manifestPath, p))];
  if (m.frameworks) next.frameworks = [...cfg.frameworks, ...m.frameworks];
  if (m.exports) next.exports = [...cfg.exports, ...m.exports];
  return next;
}

function wasiSdkHome(): string | null {
  return process.env.WASI_SDK_HOME || null;
}

// Build the full argv for the C compiler. Pure data -> string[] so the caller
// can print it (--dry) or run it.
export function buildCompileCommand(cfg: BuildConfig, cPath: string, outPath: string): string[] {
  const cc = cfg.target === 'wasm' ? wasiCc() : cfg.cCompiler;
  const args: string[] = [];

  if (cfg.target === 'wasm') {
    // wasm32-wasip1 is the WASI Preview 1 triple; the older wasm32-wasi alias
    // is deprecated. Newer WASI SDKs also moved sysroot headers under
    // include/<triple>/, so the legacy alias no longer resolves <stdio.h>.
    args.push('--target=wasm32-wasip1');
    const sysroot = wasiSysroot();
    if (sysroot) args.push(`--sysroot=${sysroot}`);
    // wasi-libc folds math into libc; there is no separate libm to link.
    // AS3's throw/try/catch maps to setjmp/longjmp in RUNTIME_PREAMBLE. WASI
    // does not support setjmp out of the box, so lower it via the WebAssembly
    // exception-handling proposal (wasm-enable-sjlj); running such .wasm needs
    // an EH-capable runtime (wasmtime / wasmer).
    args.push('-mllvm', '-wasm-enable-sjlj', cfg.opt);
    // Export the requested C symbols so the host calls them directly (no
    // _start / stdout round-trip). Exported functions remain callable and
    // re-entrant for the instance lifetime as long as they do not depend on
    // libc state that _start's ctors would have set up.
    for (const e of cfg.exports) args.push(`-Wl,--export=${e}`);
    args.push('-o', outPath);
  } else {
    args.push(cfg.opt, '-lm', '-lz', '-o', outPath);
  }

  args.push(cPath);
  for (const s of cfg.sources) args.push(s);
  for (const p of cfg.includePaths) args.push('-I', p);
  for (const d of cfg.defines) args.push('-D', d);
  for (const o of cfg.objects) args.push(o);
  for (const p of cfg.linkPaths) args.push('-L', p);
  for (const l of cfg.linkLibs) args.push('-l', l);
  for (const f of cfg.frameworks) args.push('-framework', f);

  return [cc, ...args];
}

// A source file compiled as C++ (Skia glue layer, etc.).
function isCppSource(path: string): boolean {
  return /\.(cc|cpp|cxx)$/i.test(path);
}

// Derive the C++ driver from the configured C compiler (cc -> c++, clang ->
// clang++, gcc -> g++). Linking with the C++ driver auto-links libstdc++, which
// is what a C++ glue layer (skia_glue.cc) needs without an explicit -lstdc++.
function cxxCompiler(cfg: BuildConfig): string {
  if (cfg.cCompiler === 'cc') return 'c++';
  if (cfg.cCompiler === 'clang') return 'clang++';
  if (cfg.cCompiler === 'gcc') return 'g++';
  if (cfg.cCompiler.endsWith('++')) return cfg.cCompiler;
  return `${cfg.cCompiler}++`;
}

// Build the full set of compiler invocations. Pure-C builds are a single command
// (unchanged); when the manifest adds C++ sources (.cc/.cpp), we compile C and
// C++ separately and link with the C++ driver so libstdc++ is pulled in. The
// generated .c uses C99 compound literals that C++ does not accept, so it must
// stay on the C compiler — only the glue layer and final link go through c++.
export function buildCompileSteps(cfg: BuildConfig, cPath: string, outPath: string): string[][] {
  const cppFiles = cfg.sources.filter(isCppSource);
  if (cppFiles.length === 0) {
    return [buildCompileCommand(cfg, cPath, outPath)];
  }
  if (cfg.target === 'wasm') {
    throw new Error('C++ sources with --target wasm are not yet supported (use native + a C++ toolchain)');
  }

  const cxx = cxxCompiler(cfg);
  const cFiles = [cPath, ...cfg.sources.filter((s) => !isCppSource(s))];
  const objOf = (src: string): string => src.replace(/\.[^.]+$/, '.o');
  const compileCommon: string[] = [cfg.opt];
  for (const d of cfg.defines) compileCommon.push('-D', d);
  for (const p of cfg.includePaths) compileCommon.push('-I', p);

  const steps: string[][] = [];
  // 1) C sources (including the generated .c) -> .o on the C compiler.
  for (const f of cFiles) {
    steps.push([cfg.cCompiler, '-c', ...compileCommon, f, '-o', objOf(f)]);
  }
  // 2) C++ glue layer -> .o on the C++ compiler. Skia is a C++17 codebase
  //    (std::optional / std::data / std::is_same_v), so pin the language level;
  //    the generated .c above stays C99 and must not see -std=c++17.
  for (const f of cppFiles) {
    steps.push([cxx, '-c', '-std=c++17', ...compileCommon, f, '-o', objOf(f)]);
  }
  // 3) link everything with the C++ driver (pulls in libstdc++).
  const linkArgs: string[] = [cxx, cfg.opt, '-o', outPath];
  for (const f of cFiles) linkArgs.push(objOf(f));
  for (const f of cppFiles) linkArgs.push(objOf(f));
  for (const o of cfg.objects) linkArgs.push(o);
  for (const p of cfg.linkPaths) linkArgs.push('-L', p);
  for (const l of cfg.linkLibs) linkArgs.push('-l', l);
  linkArgs.push('-lm');
  linkArgs.push('-lz');
  for (const f of cfg.frameworks) linkArgs.push('-framework', f);
  steps.push(linkArgs);

  return steps;
}

// The compiler for a wasm build: WASI_SDK_HOME/bin/clang when the SDK is
// installed, otherwise fall back to the configured compiler (which must itself
// carry a wasm32 backend, e.g. an LLVM-built clang).
function wasiCc(): string {
  const home = wasiSdkHome();
  return home ? `${home}/bin/clang` : 'clang';
}

function wasiSysroot(): string | null {
  const home = wasiSdkHome();
  return home ? `${home}/share/wasi-sysroot` : null;
}

// Probe whether the WASI toolchain is actually usable. A wasm build needs more
// than a clang that accepts --target=wasm32-wasip1: it also needs a wasi-libc
// sysroot so <stdio.h> resolves. Apple clang ships neither, so without a WASI
// SDK the preprocessor probe fails here and we surface a clear message instead
// of leaking clang's cryptic "'stdio.h' file not found". Returns null when the
// toolchain is ready, otherwise a human-readable reason.
export function wasmToolchainError(cfg: BuildConfig): string | null {
  const cc = wasiCc();
  const args = ['--target=wasm32-wasip1'];
  const sysroot = wasiSysroot();
  if (sysroot) args.push(`--sysroot=${sysroot}`);
  args.push('-E', '-x', 'c', '-');
  const res = spawnSync(cc, args, { input: '#include <stdio.h>\n', encoding: 'utf8' });
  if (res.error) return `compiler not found: ${cc}`;
  if (res.status !== 0) {
    const first = (res.stderr || '').trim().split('\n')[0];
    return `cannot compile for wasm32-wasip1 (missing wasi-libc sysroot?)${first ? ` — ${first}` : ''}`;
  }
  return null;
}

// Run the compiler and propagate failure. Returns true on success.
export function runCompile(argv: string[]): boolean {
  const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    if (!res.stderr) process.stderr.write(`compilation failed: ${argv.join(' ')}\n`);
    return false;
  }
  return true;
}

// Resolve a path relative to the manifest's directory (mirrors TypePHP's rule
// that YAML paths are relative to the YAML file location).
export function resolveFromManifest(manifestPath: string, p: string): string {
  return resolve(dirname(manifestPath), p);
}
