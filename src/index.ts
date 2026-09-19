#!/usr/bin/env node
// as-aot — a minimal ActionScript 3 subset compiler.
// Pipeline: AS source -> tokenize -> parse -> generate C -> clang -> native
// executable (or WASI .wasm with --target wasm).

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parser.ts';
import { generateC, type ExportedSymbol } from './codegen.ts';
import { ctypeToString } from './symbols.ts';
import type { Program } from './ast.ts';
import { defaultBuildConfig, loadManifest, applyManifest, buildCompileSteps, runCompile, wasmToolchainError, buildWebCompileSteps, webToolchainError, webCompileStepsEnv } from './build.ts';
import type { BuildConfig, Target, Package } from './build.ts';
import { generateBootstrap, prepareAirApp } from './air-app.ts';
import { generateXcodeProject } from './xcode-project.ts';

interface Options {
  inputs: string[];
  output: string | null;
  run: boolean;
  manifest: string | null;
  airApp: string | null;
  mainClass: string | null;
  overrides: Partial<BuildConfig>;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { inputs: [], output: null, run: false, manifest: null, airApp: null, mainClass: null, overrides: {} };
  const push = (key: 'includePaths' | 'linkLibs' | 'linkPaths' | 'defines' | 'exports', v: string): void => {
    (opts.overrides[key] ??= [] as string[]).push(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opts.output = argv[++i];
    else if (a === '--run') opts.run = true;
    else if (a === '--dry') opts.overrides.dry = true;
    else if (a === '--cc') opts.overrides.cCompiler = argv[++i];
    else if (a === '--target') opts.overrides.target = argv[++i] as Target;
    else if (a === '--package') opts.overrides.package = argv[++i] as Package;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--air-app') opts.airApp = argv[++i];
    else if (a === '--main-class') opts.mainClass = argv[++i];
    else if (a === '--opt') opts.overrides.opt = argv[++i];
    else if (a === '-I') push('includePaths', argv[++i]);
    else if (a === '-L') push('linkPaths', argv[++i]);
    else if (a === '-l') push('linkLibs', argv[++i]);
    else if (a === '-D') push('defines', argv[++i]);
    else if (a === '--export') push('exports', argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (!a.startsWith('-')) {
      opts.inputs.push(a);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.inputs.length === 0 && !opts.airApp) {
    console.error(usage());
    process.exit(1);
  }
  return opts;
}

function usage(): string {
  return [
    'Usage: as-aot <input.as> [more.as ...] [options]',
    '',
    'Options:',
    '  -o <path>      output path (native: executable; wasm: .wasm appended)',
    '  --run          run the compiled output after building',
    '  --cc <name>    C compiler to use (default: cc)',
    '  --target <t>   native (default) | wasm (WASI)',
    '  --package <p>  raw (default) | xcode-project (macOS .app) | android-project | web (browser page, needs --target wasm)',
    '  --manifest <f> build manifest JSON (extra sources / include / link libs)',
    '  --air-app <xml> AIR app descriptor: generate bootstrap + build manifest',
    '  --main-class <n> main class for --air-app (default: infer src/**/Main.as)',
    '  -I <dir>       include path (repeatable)',
    '  -L <dir>       library search path (repeatable)',
    '  -l <lib>       link library (repeatable)',
    '  -D <macro>     preprocessor define (repeatable)',
    '  --export <name> export a C symbol into the .wasm export table (repeatable)',
    '  --opt <flags>  optimization flags (default: -O2)',
    '  --dry          emit C and print the compile command without compiling',
    '  -h, --help     show this help',
  ].join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  // Build config: manifest first, then CLI overrides win (TypePHP's rule).
  const cfg = defaultBuildConfig();
  if (opts.manifest) {
    const m = loadManifest(opts.manifest);
    Object.assign(cfg, applyManifest(cfg, m, opts.manifest));
  }

  // Read + parse all AS3 input. Two modes:
  //   --air-app <xml>: parse the AIR descriptor, synthesize a bootstrap plus a
  //                    build manifest, and collect every .as under src/.
  //   otherwise:       the explicit <input.as> list.
  let program: Program;
  let base: string;
  let cPath: string;
  let inputLabel: string;

  if (opts.airApp) {
    const vendorAbs = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');
    // --package web selects the browser backend for the generated manifest; the
    // window backend (SDL2/Cocoa) is native-only and cannot link under wasm-ld.
    const air = prepareAirApp(opts.airApp, opts.mainClass, vendorAbs, opts.overrides.package === 'web');
    const m = loadManifest(air.manifestPath);
    Object.assign(cfg, applyManifest(cfg, m, air.manifestPath));

    program = { body: [], imports: [] };
    const boot = parse(generateBootstrap(air.info, air.mainClass));
    program.body.push(...boot.body);
    program.imports.push(...boot.imports);
    for (const f of air.asFiles) {
      const p = parse(readFileSync(f, 'utf8'));
      program.body.push(...p.body);
      program.imports.push(...p.imports);
    }
    base = opts.output ?? resolve(dirname(opts.airApp), air.info.filename);
    cPath = `${base}.c`;
    inputLabel = `${opts.airApp} (main ${air.mainClass}, ${air.asFiles.length} sources)`;
  } else {
    program = { body: [], imports: [] };
    for (const input of opts.inputs) {
      const p = parse(readFileSync(input, 'utf8'));
      program.body.push(...p.body);
      program.imports.push(...p.imports);
    }
    const first = opts.inputs[0];
    base = opts.output ?? first.replace(/\.as$/i, '');
    cPath = opts.output ? `${opts.output}.c` : first.replace(/\.as$/i, '.c');
    inputLabel = opts.inputs.join(', ');
  }

  // CLI overrides win over the manifest (both --manifest and --air-app).
  if (opts.overrides.target) cfg.target = opts.overrides.target;
  if (opts.overrides.package) cfg.package = opts.overrides.package;
  if (opts.overrides.cCompiler) cfg.cCompiler = opts.overrides.cCompiler;
  if (opts.overrides.opt) cfg.opt = opts.overrides.opt;
  if (opts.overrides.dry) cfg.dry = true;
  for (const k of ['includePaths', 'linkLibs', 'linkPaths', 'defines', 'exports'] as const) {
    const extra = opts.overrides[k];
    if (extra) cfg[k].push(...extra);
  }

  // 校验 target/package 合法性：非法值（如 `--target .wasm` 多带了一个点）必须
  // 立即报错，而不是静默 fallback 到 native——那会产出「编译过但结果错」的产物，
  // 违反 §2.5「禁止静默吞错 / 禁止 fallback 到错误语义」红线。
  const VALID_TARGETS: readonly string[] = ['native', 'wasm'];
  const VALID_PACKAGES: readonly string[] = ['raw', 'xcode-project', 'android-project', 'web'];
  if (!VALID_TARGETS.includes(cfg.target)) {
    throw new Error(`unknown --target '${cfg.target}' (expected: native | wasm; write \`wasm\` without a dot)`);
  }
  if (!VALID_PACKAGES.includes(cfg.package)) {
    throw new Error(`unknown --package '${cfg.package}' (expected: raw | xcode-project | android-project | web)`);
  }

  console.log(`== as-aot: AS3 subset -> C -> ${cfg.target} ==`);
  console.log(`[1/4] read        ${inputLabel}`);
  console.log('[2/4] parse       tokenize + AST');
  console.log('[3/4] codegen     emit C source');
  const { c, exports } = generateC(program, { asAotVersion: readAsAotVersion() });
  writeFileSync(cPath, c);

  // [WasmExport] declarations are auto-exported: append their C symbols (or alias
  // wrapper names) to the link-time export list so they land in the .wasm export
  // table without the user spelling out long namespaced symbol names on the CLI.
  if (exports.length > 0) {
    for (const e of exports) {
      const exportName = e.alias ?? e.symbol;
      if (!cfg.exports.includes(exportName)) cfg.exports.push(exportName);
    }
  }

  const outPath = cfg.target === 'wasm' ? `${base}.wasm` : base;

  // 分发形态分派（§6）：--package xcode-project 是「生成工程」步骤，不做 cc
  // 调用，也不走 buildCompileSteps 的单次链接。当前产出 macOS application
  // 工程；平台由 --target 唯一承载（macOS 可立即构建，iOS/Android 待后续）。
  if (cfg.package === 'xcode-project') {
    if (cfg.target !== 'native') {
      throw new Error(`--package xcode-project currently produces a macOS application (--target native); --target ${cfg.target} is not yet supported`);
    }
    const project = generateXcodeProject(cfg, cPath, dirname(base) || '.', basename(base) || 'app');
    if (project.action === 'create') {
      console.log(`[4/4] generate    ${project.projectPath}`);
      console.log(`Generated Xcode project: ${project.projectPath}`);
    } else if (project.changed) {
      console.log(`[4/4] merge       ${project.projectPath} (source list updated; hand edits preserved)`);
      console.log(`Updated Xcode project (in place): ${project.projectPath}`);
    } else {
      console.log(`[4/4] merge       ${project.projectPath} (unchanged; hand edits preserved)`);
      console.log(`Xcode project unchanged (in place): ${project.projectPath}`);
    }
    console.log(`Build product (app bundle): ${project.appPath}`);
    console.log(`Open with: open ${project.projectPath}`);
    console.log(`Build with: xcodebuild -project ${project.projectPath} -scheme ${project.schemeName} -configuration Debug build`);
    console.log(`Run with: open ${project.appPath}`);
    console.log(`Generated C kept at: ${cPath}`);
    return;
  }
  if (cfg.package === 'android-project') {
    throw new Error('--package android-project is not yet implemented');
  }
  // --package web 分派（§html5-web）：与 xcode-project 对称，产出浏览器页面。
  // 要求 target=wasm（emcc 后端）；编译走 buildWebCompileSteps（emcc 而非 wasi
  // clang），再生成 index.html 脚手架（字体运行时注入 + 手动运行 main）。
  if (cfg.package === 'web') {
    if (cfg.target !== 'wasm') {
      throw new Error(`--package web produces a browser page (--target wasm); --target ${cfg.target} is not yet supported`);
    }
    const missing = webToolchainError();
    if (missing) {
      throw new Error(
        `cannot build for --package web: ${missing}\n` +
        '\n' +
        'Install an Emscripten SDK to produce browser output:\n' +
        '  - https://emscripten.org/docs/getting_started/downloads.html\n' +
        '    then set EMSDK_HOME=/path/to/emsdk\n' +
        '\n' +
        'Use --dry to preview the compile command without a toolchain.'
      );
    }
    const steps = buildWebCompileSteps(cfg, cPath, base);
    if (cfg.dry) {
      for (const s of steps) console.log(`[4/4] dry-run     ${s.join(' ')}`);
      console.log(`Generated C kept at: ${cPath}`);
      writeWebIndex(base, cfg.fontUrls);
      return;
    }
    const env = webCompileStepsEnv();
    for (const s of steps) {
      console.log(`[4/4] compile     ${s.join(' ')}`);
      if (!runCompile(s, env)) process.exit(1);
    }
    const htmlPath = writeWebIndex(base, cfg.fontUrls);
    console.log(`Build successful: ${base}.html (${basename(base)}.js + ${basename(base)}.wasm)`);
    console.log(`Generated C kept at: ${cPath}`);
    console.log(`Open: serve this directory over HTTP and visit ${basename(htmlPath)}`);
    return;
  }

  const steps = buildCompileSteps(cfg, cPath, outPath);

  if (cfg.dry) {
    for (const s of steps) console.log(`[4/4] dry-run     ${s.join(' ')}`);
    console.log(`Generated C kept at: ${cPath}`);
    writeExportManifest(base, exports);
    return;
  }

  if (cfg.target === 'wasm') {
    const missing = wasmToolchainError(cfg);
    if (missing) {
      throw new Error(
        `cannot build for --target wasm: ${missing}\n` +
        '\n' +
        'Install a WASI toolchain to produce .wasm output:\n' +
        '  - WASI SDK: https://github.com/WebAssembly/wasi-sdk/releases\n' +
        '    then set WASI_SDK_HOME=/path/to/wasi-sdk\n' +
        '  - Homebrew: brew install wasi-sdk\n' +
        '  - or use a clang with a wasm32-wasip1 backend + wasi-libc\n' +
        '\n' +
        'Use --dry to preview the compile command without a toolchain.'
      );
    }
  }
  for (const s of steps) {
    console.log(`[4/4] compile     ${s.join(' ')}`);
    if (!runCompile(s)) process.exit(1);
  }

  console.log(`Build successful: ${outPath}`);
  console.log(`Generated C kept at: ${cPath}`);

  if (cfg.target === 'wasm' && exports.length > 0) {
    const manifestPath = writeExportManifest(base, exports);
    console.log(`Export manifest: ${manifestPath}`);
  }

  if (opts.run) {
    console.log('--- output ---');
    if (cfg.target === 'wasm') runWasm(outPath);
    else {
      const runRes = spawnSync(outPath, [], { stdio: 'inherit' });
      if (runRes.status !== 0) process.exit(runRes.status ?? 1);
    }
  }
}

// Read the compiler's own version from package.json (single source of truth),
// injected at codegen time as Capabilities.version. Falls back to an empty string
// if the file is missing or unreadable, so library use never throws.
function readAsAotVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

// Run a .wasm under whatever WASI runtime is installed. There is no single
// blessed runtime the way there is for native binaries, so probe a shortlist.
function runWasm(wasmPath: string): void {
  for (const rt of ['wasmtime', 'wasmer', 'wasm3']) {
    const probe = spawnSync(rt, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) {
      const res = spawnSync(rt, [wasmPath], { stdio: 'inherit' });
      if (res.status !== 0) process.exit(res.status ?? 1);
      return;
    }
  }
  console.error(`no WASI runtime found (tried wasmtime/wasmer/wasm3); install one to --run wasm output`);
  process.exit(1);
}

// Write a JSON export manifest next to the .wasm, documenting every [WasmExport]
// function the host can call directly via `instance.exports.NAME`. The `name`
// field is the JS-facing export name (alias ?? C symbol); `symbol` is the
// underlying C symbol; returnType/params describe the JS calling contract.
function writeExportManifest(base: string, exports: ExportedSymbol[]): string {
  const manifest = {
    wasm: `${basename(base)}.wasm`,
    exports: exports.map((e) => ({
      name: e.alias ?? e.symbol,
      symbol: e.symbol,
      returnType: ctypeToString(e.returnType),
      params: e.params.map((p) => ({ name: p.name, type: ctypeToString(p.type) })),
    })),
  };
  const path = `${base}.exports.json`;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}

// Write the browser host page for `--package web`. Emscripten emits only the
// .js + .wasm sidecars (INVOKE_RUN=0), so this page supplies the <canvas>, wires
// Module.canvas, then — inside onRuntimeInitialized — fetches each configured
// font byte stream and injects it into Skia's custom font manager before finally
// running main(). The font fetch must precede the first render (there is no
// system font in the wasm sandbox); a failed fetch is logged, not fatal, so the
// page still renders whatever glyphs the remaining fonts cover.
function writeWebIndex(base: string, fontUrls: string[]): string {
  const jsName = `${basename(base)}.js`;
  const title = basename(base);
  const fontArray = JSON.stringify(fontUrls);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; background: #0f1115; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  canvas { background: #000; image-rendering: pixelated; }
</style>
</head>
<body>
<canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas>
<script>
// 字体字节流 URL（网络加载 + 全量覆盖）：wasm 沙箱无系统字体，这些字体在
// main() 运行前 fetch 并注入 Skia 的自定义 FreeType 字体管理器。
var FONT_URLS = ${fontArray};
var Module = {
  canvas: document.getElementById('canvas'),
  onRuntimeInitialized: async function() {
    for (var i = 0; i < FONT_URLS.length; i++) {
      try {
        var resp = await fetch(FONT_URLS[i]);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var bytes = new Uint8Array(await resp.arrayBuffer());
        var ptr = Module._malloc(bytes.length);
        Module.HEAPU8.set(bytes, ptr);
        Module._sk_fontmgr_register_data(ptr, bytes.length);
        Module._free(ptr);
      } catch (e) {
        console.warn('font load failed: ' + FONT_URLS[i], e);
      }
    }
    Module._main();
  }
};
</script>
<script src="${jsName}"></script>
</body>
</html>
`;
  const path = `${base}.html`;
  writeFileSync(path, html);
  return path;
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`);
  process.exit(1);
}
