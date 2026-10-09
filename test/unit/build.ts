// Unit checks: build manifest, preload, perf/debug flags, features, wasm export.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='build/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp, parseAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// ---- build-manifest per-target layering (阶段八十九·五十) ----
// Checked separately from the example suite (its own counters) so the "N passed"
// summary keeps meaning "examples": a build manifest is pure build-layer data,
// and no AS3 program can exercise it. The assertions cover the contract that lets
// ONE manifest serve native + wasm, that CLI flags still beat a layer, and that
// typos fail loudly rather than being silently ignored (AGENTS.md §2.5).
function checkManifestLayering(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [manifest] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [manifest] ${label}`); }
  };
  const throws = (label: string, fn: () => void): void => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw);
  };
  const mpath = join(root, 'examples', 'flash-net-layered.build.example.json');
  const raw = (o: unknown): Manifest => o as Manifest;
  const merged = (m: Manifest, target: Target): BuildConfig =>
    applyManifestOverlay(applyManifest(defaultBuildConfig(), m, mpath), m, mpath, target);
  const argv = (c: BuildConfig): string => buildCompileCommand(c, 'x.c', 'x.out').join(' ');

  // 1) One manifest, two targets: native links curl; wasm must not see it at all.
  const layered = loadManifest(mpath);
  const nativeCfg = merged(layered, 'native');
  const wasmCfg = merged(layered, 'wasm');
  check('one manifest / native links curl', nativeCfg.linkLibs.includes('curl'));
  check('one manifest / native defines ASC_HAVE_CURL', nativeCfg.defines.includes('ASC_HAVE_CURL'));
  check('one manifest / wasm drops curl', !wasmCfg.linkLibs.includes('curl'));
  check('one manifest / wasm drops ASC_HAVE_CURL', !wasmCfg.defines.includes('ASC_HAVE_CURL'));
  check('native cc argv carries -l curl', argv(nativeCfg).includes('-l curl'));
  check('wasm cc argv carries no curl', !argv(wasmCfg).includes('curl'));

  // 2) Replace (not append) is what lets a target DROP a shared library.
  const repl: Manifest = { 'link-libs': ['common'], targets: { native: { 'link-libs': ['curl'] } } };
  check('layer replaces the shared list', merged(repl, 'native').linkLibs.join(',') === 'curl');
  const rem: Manifest = { 'link-libs': ['curl'], targets: { wasm: { 'link-libs': [] } } };
  check('layer can REMOVE a shared lib for one target', merged(rem, 'wasm').linkLibs.length === 0);
  check('the other target keeps the shared lib', merged(rem, 'native').linkLibs.join(',') === 'curl');

  // 3) CLI flags beat a layer: index.ts applies the overlay BEFORE the CLI
  //    overrides, so a CLI -l must survive. Simulate that ordering here.
  const afterCli = merged(repl, 'native');
  afterCli.linkLibs.push('extra');
  check('CLI additions survive the overlay', afterCli.linkLibs.join(',') === 'curl,extra');

  // 4) Layer path fields resolve from the manifest dir and never leak cross-target.
  const paths: Manifest = { targets: { native: { sources: ['a/b.cc'], 'link-paths': ['lib/arm64'] } } };
  const pNative = merged(paths, 'native');
  check('layer path fields resolve from the manifest dir',
    pNative.sources[0] === resolve(dirname(mpath), 'a/b.cc') &&
    pNative.linkPaths[0] === resolve(dirname(mpath), 'lib/arm64'));
  check('layer path fields do not leak to the other target', merged(paths, 'wasm').sources.length === 0);

  // 5) Typos in the block must fail loudly.
  throws('unknown target key in "targets" is rejected', () => merged(raw({ targets: { ios: {} } }), 'native'));
  throws('nested "targets" is rejected', () => merged(raw({ targets: { native: { targets: {} } } }), 'native'));
  throws('"target" inside a layer is rejected', () => merged(raw({ targets: { native: { target: 'wasm' } } }), 'native'));
  throws('unknown field inside a layer is rejected', () => merged(raw({ targets: { native: { 'link-library': ['x'] } } }), 'native'));

  if (ok > 0) console.log(`[manifest] ${ok} layering checks passed`);
  return bad;
}

// ---- preload set trimming (阶段八十九·五十八) ----
// A web build packs the app's data tree into `<base>.data`, and a font listed in
// `font-urls` is ALSO fetched over HTTP by the page (that fetch is what puts bytes
// into Skia's font manager; the FS copy is never read). So the preloaded copy is
// pure duplicate download — for the 7.9 MB CJK face url-test ships, the bulk of
// the payload. The fix is emcc's own exclusion pattern. Two layers are pinned:
// the generator must name exactly the fonts it also lists as `font-urls` (and
// escape them, since `--exclude-file` is an fnmatch pattern), and the build layer
// must forward the field to `--exclude-file` on the wasm link only.
function checkPreloadExcludes(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [preload] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [preload] ${label}`); }
  };
  const mpath = join(root, 'temp', 'preload-excludes-fixture.json');
  mkdirSync(dirname(mpath), { recursive: true });
  const cfgFor = (m: Manifest): BuildConfig => applyManifest(defaultBuildConfig(), m, mpath);

  // The build layer: a manifest entry is resolved against the manifest dir (it is
  // matched against the host path the preload walk yields, which is absolute
  // because preload srcs are) and reaches the wasm link as `--exclude-file`.
  const cfg = cfgFor({
    target: 'wasm',
    package: 'web',
    'preload-paths': ['assets'],
    'preload-excludes': ['assets/fonts/F.ttf'],
  });
  const linkArgs = buildWebCompileSteps(cfg, 'x.c', 'x')[1];
  check('an exclude resolves from the manifest dir',
    cfg.preloadExcludes[0] === resolve(dirname(mpath), 'assets/fonts/F.ttf'));
  check('the wasm link carries it as --exclude-file',
    linkArgs.join(' ').includes(`--exclude-file ${resolve(dirname(mpath), 'assets/fonts/F.ttf')}`));
  check('excludes come after the preload roots they punch holes in',
    linkArgs.indexOf('--exclude-file') > linkArgs.indexOf('--preload-file'));
  // Native must not see it: preloads are a browser-sandbox concern (`File`
  // resolves `applicationDirectory` to the real directory there).
  const nativeCfg = cfgFor({ target: 'native', 'preload-excludes': ['assets/fonts/F.ttf'] });
  check('the native cc argv never carries a preload or an exclude',
    !buildCompileCommand(nativeCfg, 'x.c', 'x.out').join(' ').match(/--(preload|exclude)-file/));
  check('a build with nothing to exclude emits no flag',
    !buildWebCompileSteps(cfgFor({ target: 'wasm', package: 'web' }), 'x.c', 'x')[1].includes('--exclude-file'));

  if (ok > 0) console.log(`[preload] ${ok} preload-exclude checks passed`);
  return bad;
}

// The web preload set is what the browser build packs into the wasm FS image, so
// anything swept in that the program never reads is pure payload, and anything
// swept in that IS the build's own output is recursive dead weight. The adapter
// excludes this compiler's artifacts by testing the descriptor's <filename>
// prefix at the app root, which cannot see into a subdirectory: a build rooted in
// `temp/` or `build/` inside the app dir (the common `-o temp/<x>` shape) would
// pack the executable being produced. Measured on examples/Flappy-Starling with
// -o temp/flappy-web: the root set went from 1.9 MB of assets to 36 MB, all of it
// the .c/.o/executable this same build writes.
function checkPreloadOutputDir(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [preload-dir] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [preload-dir] ${label}`); }
  };
  const d = join(root, 'temp', 'air-app-outdir');
  mkdirSync(join(d, 'src'), { recursive: true });
  mkdirSync(join(d, 'assets'), { recursive: true });
  mkdirSync(join(d, 'temp'), { recursive: true });
  writeFileSync(join(d, 'assets', 'atlas.png'), 'not-a-real-png');
  writeFileSync(join(d, 'temp', 'app.o'), 'not-a-real-object-file');
  writeFileSync(join(d, 'outdir-app.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `  <id>com.example.outdir</id>\n  <filename>outdir</filename>\n` +
    `  <initialWindow><content>main.swf</content><visible>true</visible>` +
    `<width>400</width><height>400</height></initialWindow>\n</application>\n`);
  writeFileSync(join(d, 'src', 'Main.as'),
    'package {\n  import flash.display.Sprite;\n' +
    '  public class Main extends Sprite {\n    public function Main() {}\n  }\n}\n');

  const appXml = join(d, 'outdir-app.xml');
  const vendorAbs = resolve(root, 'vendor');
  const preload = (appXmlPath: string, outputPath: string | null): string[] => {
    const prep = prepareAirApp(appXmlPath, 'Main', vendorAbs, true, null, outputPath);
    const m = JSON.parse(readFileSync(prep.manifestPath, 'utf8')) as Record<string, unknown>;
    return (m['preload-paths'] as string[]) ?? [];
  };

  // (1) The defect: the build writes into <app>/temp, so that dir is this
  // compiler's own output tree and must not enter the FS image.
  check('a build rooted in <app>/temp does not preload temp',
    !preload(appXml, join(d, 'temp', 'outdir-web')).includes('temp'));
  check('...while the app data is still preloaded',
    preload(appXml, join(d, 'temp', 'outdir-web')).includes('assets'));
  // (2) Reverse control: with no -o the adapter cannot know about temp, so it
  // must NOT drop it on a hunch - the exclusion is a fact about this build, not a
  // name blacklist. (Also the reason a `temp/` holding real app data is safe.)
  check('without -o nothing is dropped', preload(appXml, null).includes('temp'));
  // (3) An output outside the app dir means there is nothing of ours in there.
  check('an output outside the app dir drops nothing',
    preload(appXml, join(root, 'temp', 'elsewhere', 'outdir-web')).includes('temp'));
  // (4) The exclusion is the output *directory*, not the output stem: the desktop
  // `<filename>` prefix rule already covers `-o <app>/outdir` at the root.
  check('an output directly in the app dir keeps the app data',
    preload(appXml, join(d, 'outdir')).includes('assets'));
  // (5) Structural: everything above passes an output path in by hand, so none of
  // it would notice the CLI never handing `-o` over in the first place (measured:
  // mutating index.ts to pass `null` left checks 1-4 green). Pin the call site.
  const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const callSite = /prepareAirApp\([^;]*?\);/s.exec(indexSource)?.[0] ?? '';
  check('the CLI hands -o to the adapter', callSite.includes('opts.output'));
  check('...and still passes the resolved --features set',
    callSite.includes('explicitFeatures'));

  if (ok > 0) console.log(`[preload-dir] ${ok} preload output-dir checks passed`);
  return bad;
}

// ---- E12: LTO / PGO build switches ----
//
// These are build-level switches, so the assertions drive the real command
// builders instead of grepping the source: what matters is the argv a user's
// compiler actually receives, and whether the flags land on EVERY step (LTO on
// the link step only, or the compile step only, is a silently ineffective build
// rather than an error).
function checkPerfFlags(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [perf] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [perf] ${label}`); }
  };
  const has = (argv: string[], flag: string): boolean => argv.some((a) => a === flag || a.startsWith(flag + '='));
  const count = (argv: string[], flag: string): number => argv.filter((a) => a === flag || a.startsWith(flag + '=')).length;

  const base = defaultBuildConfig();
  // Off by default: without a manifest or flag the build must be exactly the
  // build it has always been, so nobody inherits LTO/PGO by upgrading.
  check('the default config declares neither LTO nor PGO', base.lto === false && base.pgo === '');
  const baseNative = buildCompileCommand(base, 'x.c', 'x');
  check('…and the default command carries no -flto / -fprofile-* flag',
    !has(baseNative, '-flto') && count(baseNative, '-fprofile') === 0);
  const baseWasm = buildCompileCommand({ ...base, target: 'wasm' }, 'x.c', 'x');
  check('…nor does the default wasm command',
    !has(baseWasm, '-flto') && count(baseWasm, '-fprofile') === 0);
  const baseWeb = buildWebCompileSteps({ ...base, target: 'wasm', package: 'web' }, 'x.c', 'x');
  check('…nor any step of the default web build',
    baseWeb.every((argv) => !has(argv, '-flto') && count(argv, '-fprofile') === 0));

  // LTO has to appear on every compile step AND the link step: -flto at compile
  // time emits bitcode, the link step is where cross-module inlining happens.
  const lto = { ...base, lto: true, sources: ['a.cc'] };
  const nativeSteps = buildCompileSteps(lto, 'x.c', 'x');
  check('native: -flto is on every step (C compile, C++ compile, link)',
    nativeSteps.length === 3 && nativeSteps.every((argv) => has(argv, '-flto')));
  check('native single-file path: -flto is present', has(buildCompileCommand(lto, 'x.c', 'x'), '-flto'));
  check('wasm: -flto is present', has(buildCompileCommand({ ...lto, target: 'wasm' }, 'x.c', 'x'), '-flto'));
  const webSteps = buildWebCompileSteps({ ...lto, target: 'wasm', package: 'web' }, 'x.c', 'x');
  check('web: -flto is on every step',
    webSteps.length > 0 && webSteps.every((argv) => has(argv, '-flto')));

  // The two PGO phases must name the same directory; clang reads
  // <dir>/default.profdata, so a phase that omits the path silently reads a
  // different profile (or none) than the instrumentation wrote.
  const gen = { ...base, pgo: 'generate' as const, pgoDir: 'prof' };
  const use = { ...base, pgo: 'use' as const, pgoDir: 'prof' };
  check('generate phase passes -fprofile-generate=<dir>', has(buildCompileCommand(gen, 'x.c', 'x'), '-fprofile-generate=prof'));
  check('use phase passes -fprofile-use=<dir>', has(buildCompileCommand(use, 'x.c', 'x'), '-fprofile-use=prof'));
  check('the two phases never emit each other\'s flag',
    !has(buildCompileCommand(gen, 'x.c', 'x'), '-fprofile-use')
    && !has(buildCompileCommand(use, 'x.c', 'x'), '-fprofile-generate'));
  check('PGO reaches the web steps too',
    buildWebCompileSteps({ ...use, target: 'wasm', package: 'web' }, 'x.c', 'x').every((argv) => has(argv, '-fprofile-use=prof')));
  // -fprofile-correction is a GCC flag: clang only warns "not supported" and
  // ignores it (-Wignored-optimization-argument), so emitting it would put
  // noise on every PGO build for no effect.
  check('no GCC-only -fprofile-correction is emitted',
    !has(buildCompileCommand(use, 'x.c', 'x'), '-fprofile-correction'));
  // LTO and PGO compose (PGO-in-LTO is the strongest combination).
  const both = { ...base, lto: true, pgo: 'use' as const, pgoDir: 'prof' };
  const bothArgv = buildCompileCommand(both, 'x.c', 'x');
  check('LTO and PGO compose in one command', has(bothArgv, '-flto') && has(bothArgv, '-fprofile-use=prof'));

  // Manifest + targets.<target> plumbing (the documented route).
  const m: Manifest = { lto: true, pgo: 'use', 'pgo-dir': 'prof' };
  const merged = applyManifest(defaultBuildConfig(), m, join(root, 'temp', 'perf', 'm.json'));
  check('manifest lto/pgo/pgo-dir reach the config', merged.lto === true && merged.pgo === 'use' && merged.pgoDir.endsWith(join('temp', 'perf', 'prof')));
  const layered = applyManifestOverlay(defaultBuildConfig(), { targets: { native: { lto: true, pgo: 'generate' } } }, join(root, 'temp', 'perf', 'm.json'), 'native');
  check('a targets.<target> block may set lto/pgo too', layered.lto === true && layered.pgo === 'generate');

  if (ok > 0) console.log(`[perf] ${ok} LTO/PGO build-switch checks passed`);
  return bad;
}

// ---- debug-info policy (stage 94·29) ----
//
// One axis, three backends. `debugInfo=false` (the default) must leave every
// artifact free of DWARF: native keeps none at -O2 anyway, emcc -O2 strips by
// itself, and the wasm backend is the odd one out whose toolchain (wasi-sdk's
// libc.a) ships DWARF that wasm-ld keeps — hence the one counter-flag. The pins
// below hold both ends of that bargain, and specifically that the wasm strip is
// `--strip-debug` (name section survives, traps stay symbolic) not `--strip-all`.
function checkDebugInfo(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [debuginfo] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [debuginfo] ${label}`); }
  };
  const has = (argv: string[], flag: string): boolean => argv.some((a) => a === flag || a.startsWith(flag + '='));

  const base = defaultBuildConfig();
  check('the default config carries no debug info', base.debugInfo === false);

  // Default wasm: stripped, and specifically with --strip-debug.
  const wasmDefault = buildCompileCommand({ ...base, target: 'wasm' }, 'x.c', 'x');
  check('default wasm command strips DWARF (-Wl,--strip-debug)', has(wasmDefault, '-Wl,--strip-debug'));
  check('default wasm command adds no -g', !has(wasmDefault, '-g'));
  check('the strip is --strip-debug, never --strip-all (keep the name section)',
    !has(wasmDefault, '-Wl,--strip-all'));

  // Native/web need no strip flag: their toolchains already produce no DWARF.
  check('native command carries neither -g nor a strip flag by default',
    !has(buildCompileCommand(base, 'x.c', 'x'), '-g') && !has(buildCompileCommand(base, 'x.c', 'x'), '-Wl,--strip-debug'));
  const webDefault = buildWebCompileSteps({ ...base, target: 'wasm', package: 'web' }, 'x.c', 'x');
  check('web steps carry no -g and no strip flag by default',
    webDefault.every((argv) => !has(argv, '-g') && !has(argv, '-Wl,--strip-debug')));

  // Opt-in: -g everywhere, and the wasm strip stops.
  const dbg = { ...base, debugInfo: true };
  const wasmDbg = buildCompileCommand({ ...dbg, target: 'wasm' }, 'x.c', 'x');
  check('wasm --debug-info adds -g', has(wasmDbg, '-g'));
  check('wasm --debug-info does not strip', !has(wasmDbg, '-Wl,--strip-debug'));
  check('native --debug-info adds -g', has(buildCompileCommand(dbg, 'x.c', 'x'), '-g'));
  check('web --debug-info adds -g on every step',
    buildWebCompileSteps({ ...dbg, target: 'wasm', package: 'web' }, 'x.c', 'x').every((argv) => has(argv, '-g')));
  // The C++ path must agree with the single-file path, or a Skia build would
  // silently drop debug info while a pure-C build kept it.
  const cppSteps = buildCompileSteps({ ...dbg, sources: ['a.cc'] }, 'x.c', 'x');
  check('native C++ path: -g is on every step (C, C++, link)',
    cppSteps.length === 3 && cppSteps.every((argv) => has(argv, '-g')));

  // Manifest + targets.<target> plumbing.
  const mp = join(root, 'temp', 'debuginfo', 'm.json');
  const merged = applyManifest(defaultBuildConfig(), { 'debug-info': true }, mp);
  check('manifest debug-info reaches the config', merged.debugInfo === true);
  const layered = applyManifestOverlay(
    applyManifest(defaultBuildConfig(), { 'debug-info': true }, mp),
    { targets: { native: { 'debug-info': false } } }, mp, 'native');
  check('a targets.<target> block may override debug-info', layered.debugInfo === false);

  if (ok > 0) console.log(`[debuginfo] ${ok} debug-info policy checks passed`);
  return bad;
}

// ---- named enhancement switches (--features / manifest `features`) ----
//
// A feature is an AIR-superset channel behind an opt-in macro (§1.5). Two things
// can silently go wrong and both are pinned here: the DEFAULT must stay
// macro-free (or every build quietly stops matching `adl`), and a chosen feature
// must reach every command builder (or the flag looks accepted and does nothing --
// the failure mode §1.5 exists to prevent).
function checkFeatures(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [features] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [features] ${label}`); }
  };

  const dflt = defaultBuildConfig();
  const withSvg: BuildConfig = { ...dflt, features: ['svg'], linkLibs: ['svg'], linkPaths: ['/tmp'] };
  const count = (hay: string[], needle: string): number => hay.filter((x) => x === needle).length;

  // (1) The default artifact must be byte-for-byte what it was before the switch
  // existed: no feature macro anywhere, on any of the builders.
  // Every enhancement macro, not just svg: the E3/E4 default-deny pair works by
  // the ABSENCE of its macro, so a default build that leaked one would silently
  // stop matching adl (BMP/WebP/ICO/DNG would decode when AIR says #2124).
  const ALL_MACROS = ['ASC_USE_SVG=1', 'ASC_ALLOW_EXTRA_FORMATS=1', 'ASC_ALLOW_RAW_FORMATS=1'];
  check('the default config enables no enhancement',
    effectiveDefines(dflt).every((d) => !ALL_MACROS.includes(d)));
  check('a default native command carries no enhancement macro',
    ALL_MACROS.every((m) => !buildCompileCommand(dflt, 'x.c', 'x').includes(m)));
  check('a default native build carries none on any step',
    buildCompileSteps(dflt, 'x.c', 'x').every((s) => ALL_MACROS.every((m) => !s.includes(m))));
  check('a default web build carries none on any step',
    buildWebCompileSteps(dflt, 'x.c', 'x').every((s) => ALL_MACROS.every((m) => !s.includes(m))));

  // (2) The switch must actually reach the command line -- every builder, or the
  // user pays for a feature that is not compiled in.
  check('feature svg resolves to its macro', effectiveDefines(withSvg).includes('ASC_USE_SVG=1'));
  check('the native single-shot command carries the feature macro',
    count(buildCompileCommand(withSvg, 'x.c', 'x'), 'ASC_USE_SVG=1') === 1);
  check('the native multi-step compile carries it (and only once)',
    buildCompileSteps(withSvg, 'x.c', 'x').reduce((n, s) => n + count(s, 'ASC_USE_SVG=1'), 0) === 1);
  // ...and the macro must be there as a define, not as a stray argument that
  // clang would read as an input file.
  check('the macro is emitted as -D <macro>', (() => {
    const a = buildCompileCommand(withSvg, 'x.c', 'x');
    const i = a.indexOf('ASC_USE_SVG=1');
    return i > 0 && a[i - 1] === '-D';
  })());

  // (3) The web backend cannot link the channel, so the pair must be rejected up
  // front -- not left to surface as `undefined symbol: sk_svg_*` from wasm-ld.
  check('svg is rejected on a backend that cannot link it', (() => {
    try { validateFeatures(['svg'], 'wasm'); return false; } catch { return true; }
  })());
  check('svg is accepted on the backend that can', (() => {
    try { validateFeatures(['svg'], 'native'); return true; } catch { return false; }
  })());
  // A feature nobody implemented must fail loudly. Listing it and doing nothing
  // would hand the user a switch that reports success and changes no artifact.
  check('an unknown feature throws and names the known ones', (() => {
    try { validateFeatures(['lottie'], 'native'); return false; }
    catch (e) { return String(e).includes("unknown feature 'lottie'") && String(e).includes(knownFeatures().join(', ')); }
  })());
  check('only implemented channels are offered as features',
    knownFeatures().join(',') === 'formats,raw,svg');

  // (3b) E3/E4: the default-deny pair. Two claims, and the second is the whole
  // reason the pair exists -- our Skia CAN decode these, so only the missing macro
  // keeps the default artifact AIR-isomorphic. Pinned on both sides: the switches
  // resolve to their macros and reach the builders, and the glue refuses the
  // families unless the macro is defined.
  const withFormats: BuildConfig = { ...dflt, features: ['formats'] };
  const withRaw: BuildConfig = { ...dflt, features: ['raw'] };
  check('feature formats resolves to its macro',
    effectiveDefines(withFormats).includes('ASC_ALLOW_EXTRA_FORMATS=1'));
  check('feature raw resolves to its macro',
    effectiveDefines(withRaw).includes('ASC_ALLOW_RAW_FORMATS=1'));
  check('formats is available on both backends (no extra library is involved)',
    (() => { try { validateFeatures(['formats'], 'wasm'); validateFeatures(['formats'], 'native'); return true; }
              catch { return false; } })());
  check('formats reaches a web build too, not just native',
    buildWebCompileSteps(withFormats, 'x.c', 'x').some((s) => s.includes('ASC_ALLOW_EXTRA_FORMATS=1')));
  check('raw is native-only, and says which archive is missing', (() => {
    try { validateFeatures(['raw'], 'wasm'); return false; }
    catch (e) { return String(e).includes('piex/dng_sdk'); }
  })());
  check('raw is accepted on native', (() => {
    try { validateFeatures(['raw'], 'native'); return true; } catch { return false; }
  })());
  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  check('the glue gate refuses each family by magic byte',
    glue.includes('static bool sk_extra_format_refused(')
    && glue.includes("p[8] == 'W' && p[9] == 'E' && p[10] == 'B' && p[11] == 'P'")   // WebP
    && glue.includes("p[0] == 'B' && p[1] == 'M'")                                   // BMP
    && glue.includes('p[2] == 1 && p[3] == 0')                                       // ICO
    && glue.includes('p[2] == 42 && p[3] == 0')                                      // TIFF family
    && glue.includes('"FUJIFILMCCD-RAW"'));
  check('the refusal is compiled OUT only when the matching switch is on',
    glue.includes('#ifndef ASC_ALLOW_EXTRA_FORMATS')
    && glue.includes('#ifndef ASC_ALLOW_RAW_FORMATS'));
  check('all four decode entry points consult the gate',
    (glue.match(/sk_extra_format_refused\(/g) ?? []).length === 5);   // 1 def + 4 calls
  // The measured behaviour, pinned as text: default -> adl's own error, switch ->
  // decodes. (The probes need the Skia link table, so they live in temp/ and are
  // re-run by hand; these strings are what the run recorded.)
  const codecDoc = readFileSync(join(root, 'docs', 'zh-cn', 'enhancements.md'), 'utf8');
  const compileDoc = readFileSync(join(root, 'docs', 'zh-cn', 'compile.md'), 'utf8');
  check('the docs state the default-deny posture and both switches',
    codecDoc.includes('ASC_ALLOW_EXTRA_FORMATS=1') && codecDoc.includes('ASC_ALLOW_RAW_FORMATS=1')
    && codecDoc.includes('默认拒绝') && compileDoc.includes('3.4.3.1'));
  check('the docs keep the measured #2124 / ok pair',
    codecDoc.includes('Loaded file is an unknown type') && codecDoc.includes('ok 600×338'));

  // (4) Repeats must not double the define: `--features svg --features svg` and a
  // manifest that repeats a name both collapse.
  check('a repeated feature emits its macro once',
    effectiveDefines({ ...dflt, features: ['svg', 'svg'] }).filter((d) => d === 'ASC_USE_SVG=1').length === 1);

  // (5) Manifest plumbing: read, and REPLACE (not append) in a target layer --
  // a layer must be able to turn a feature back OFF for one target.
  const mPath = join(root, 'temp', 'features-manifest.json');
  writeFileSync(mPath, JSON.stringify({
    features: ['svg'],
    'link-libs': ['svg'],
    targets: { wasm: { features: [], 'link-libs': [] } },
  }));
  const m = loadManifest(mPath);
  const fromManifest = applyManifest(dflt, m, mPath);
  check('a manifest enables a feature', fromManifest.features.includes('svg'));
  const wasmLayer = applyManifestOverlay(fromManifest, m, mPath, 'wasm');
  check('a target layer can turn a feature back off (replace, not append)',
    wasmLayer.features.length === 0);
  check('the same layer leaves the native build alone',
    applyManifestOverlay(fromManifest, m, mPath, 'native').features.includes('svg'));

  // (6) The --air-app adapter regenerates its manifest in full on every run, so a
  // chosen feature has to survive that rewrite -- otherwise "turn SVG on" is
  // impossible to express except by repeating the flag forever (the reported bug).
  const dir = join(root, 'temp', 'feature-persist');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const appName = 'feat';
  writeFileSync(join(dir, `${appName}-app.xml`),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<application xmlns="http://ns.adobe.com/air/application/51.0">\n' +
    `  <id>com.example.${appName}</id>\n  <filename>${appName}</filename>\n` +
    '  <initialWindow><content>main.swf</content><visible>true</visible>' +
    '<width>400</width><height>400</height></initialWindow>\n</application>\n');
  writeFileSync(join(dir, 'src', 'Main.as'),
    'package {\n  import flash.display.Sprite;\n' +
    '  public class Main extends Sprite {\n    public function Main() { trace("x"); }\n  }\n}\n');
  const manifestPath = join(dir, `${appName}.build.json`);
  // spawnSync, not execFileSync: the carry-over notice is a warning and goes to
  // stderr, which execFileSync drops. Both streams are captured because the two
  // claims being pinned live in different ones ("not silent" is stderr, the
  // compile line is stdout).
  const runAir = (...extra: string[]): Record<string, unknown> => {
    const r = spawnSync('node', ['src/index.ts', '--air-app', join(dir, `${appName}-app.xml`),
      '--main-class', 'Main', '--target', 'native', ...extra, '--dry'],
      { cwd: root, encoding: 'utf8', timeout: EXAMPLE_TIMEOUT_MS });
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    mf.__out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0) mf.__failed = true;
    return mf;
  };
  const feats = (mf: Record<string, unknown>): string[] => (mf.features as string[]) ?? [];

  check('--air-app persists a chosen feature into the generated manifest',
    feats(runAir('--features', 'svg')).join(',') === 'svg');
  const carried = runAir();
  check('a later run without the flag keeps it (the manifest no longer eats it)',
    feats(carried).join(',') === 'svg');
  check('the carried-over build still compiles the macro in',
    String(carried.__out).includes('ASC_USE_SVG=1'));
  check('the carry-over is announced, not silent',
    String(carried.__out).includes('carried over'));
  check('--features none clears it', feats(runAir('--features', 'none')).length === 0);
  check('the clear is sticky too', feats(runAir()).length === 0);
  check('a cleared build is macro-free again',
    !String(runAir().__out).includes('ASC_USE_SVG=1'));
  check('an unknown feature fails the build (nonzero exit)',
    runAir('--features', 'lottie').__failed === true);

  if (ok > 0) console.log(`[features] ${ok} enhancement-switch checks passed`);
  return bad;
}

// ---- wasm export path: CLI --export and package-level [WasmExport] ----
//
// Two silent breaks here — both compile (or parse) "fine" until something
// downstream notices, so only a structural pin catches them before wasm-ld / the
// browser does:
//   1. 阶段七十八 static 化 marked every non-[WasmExport] file-scope function
//      `static`; a CLI `--export <sym>` target was collateral, so wasm-ld failed
//      with "symbol exported via --export not found".
//   2. the package-body parser consumed `[WasmExport]` as throwaway [SWF]-style
//      metadata BEFORE the declaration, so `package p { [WasmExport] function f… }`
//      silently lost the export.
function checkWasmExport(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [wasmexport] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [wasmexport] ${label}`); }
  };

  // (1) A CLI --export C symbol must survive static 化 (stay global).
  const fibSrc = 'function fib(n:int):int { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\ntrace(fib(10));';
  const withKeep = generateC(parse(fibSrc), ['fib']).c;
  const withoutKeep = generateC(parse(fibSrc)).c;
  check('a CLI --export C symbol is emitted global, not static',
    /^int fib\(int n\);$/m.test(withKeep) && !/^static int fib\(/m.test(withKeep));
  // Negative control: without the CLI name it IS static — that is precisely what
  // broke `--export fib`, so the two cases must differ.
  check('the same function is static without --export (negative control)',
    /^static int fib\(int n\);/m.test(withoutKeep));
  check('index.ts threads the CLI export list into codegen',
    /generateC\(program, cfg\.exports, swcResources, swcBake, embedResources, embedFieldInits\)/.test(readFileSync(join(root, 'src', 'index.ts'), 'utf8')));

  // (2) [WasmExport] on a packaged top-level function must be collected.
  const pkgSrc = [
    'package mathlib {',
    '  [WasmExport] function add(a:int, b:int):int { return a + b; }',
    '  [WasmExport("multiply")] function mul(a:int, b:int):int { return a * b; }',
    '}',
    'trace(add(1, 2));',
  ].join('\n');
  const pkgExports = generateC(parse(pkgSrc)).exports;
  check('package-level [WasmExport] on a function is collected, not discarded as [SWF]',
    pkgExports.some((e) => e.symbol === 'add') &&
    pkgExports.some((e) => e.symbol === 'mul' && e.alias === 'multiply'));
  // The throwaway-metadata path must survive: a real [SWF]/[Frame] at package
  // level (with or without a following declaration) must still parse.
  const parses = (src: string): boolean => { try { parse(src); return true; } catch { return false; } };
  check('package-level non-declaration metadata is still discarded, not a parse error',
    parses('package p { [SWF(width = "1")] }') &&
    parses('package p { [SWF(width = "1")] class C {} }'));
  check('the package parser rewinds and keeps declaration metadata',
    /METADATA_DECL\.has\(nxt\.value\)\) \{\s*this\.pos = save;\s*body\.push\(this\.parseStatement\(\)\);/.test(
      readFileSync(join(root, 'src', 'parser.ts'), 'utf8')));

  if (ok > 0) console.log(`[wasmexport] ${ok} wasm export-path checks passed`);
  return bad;
}

// ---- AIR descriptor parsing vs XML comments (阶段一百零七) ----
// The --air-app adapter reads app.xml with a plain-regex extractor, and XML
// comments are legal in a descriptor. The AIR SDK's own descriptor template
// comments whole element examples out (<!-- <width></width> -->,
// <!-- <visible></visible> -->, <!-- <renderMode></renderMode> --> …), so a
// descriptor copied from that template used to hand the extractor a *commented*
// empty <width>, which parses to NaN and tripped the width/height check: a
// descriptor AIR accepts verbatim was rejected here. These pins use the
// template's shape (comment first, live element later).
function checkAirAppDescriptorComments(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [air-app-xml] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [air-app-xml] ${label}`); }
  };

  const info = parseAirApp(
    `<?xml version="1.0" encoding="utf-8" standalone="no" ?>\n` +
    `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `    <!-- <name></name> -->\n` +
    `    <id>demo.as3.descriptor</id>\n` +
    `    <!-- <filename>Commented.swf</filename> -->\n` +
    `    <filename>live-demo</filename>\n` +
    `    <versionNumber>1.0</versionNumber>\n` +
    `    <initialWindow>\n` +
    `        <!-- <title></title> -->\n` +
    `        <!-- <visible></visible> -->\n` +
    `        <!-- <width></width> -->\n` +
    `        <!-- <height></height> -->\n` +
    `        <!-- <renderMode></renderMode> -->\n` +
    `        <!-- <depthAndStencil></depthAndStencil> -->\n` +
    `        <!-- <content>Commented.swf</content> -->\n` +
    `        <visible>false</visible>\n` +
    `        <width>640</width>\n` +
    `        <height>480</height>\n` +
    `        <renderMode>direct</renderMode>\n` +
    `        <depthAndStencil>true</depthAndStencil>\n` +
    `        <content>Live.swf</content>\n` +
    `    </initialWindow>\n` +
    `</application>`);

  check('a commented <filename> does not shadow the live one', info.filename === 'live-demo');
  check('a commented <content> does not shadow the live one', info.content === 'Live.swf');
  check('a commented empty <visible> does not shadow the live one', info.visible === false);
  check('a commented empty <width> does not shadow the live one', info.width === 640);
  check('a commented empty <height> does not shadow the live one', info.height === 480);
  check('a commented empty <renderMode> does not shadow the live one', info.renderMode === 'direct');
  check('a commented empty <depthAndStencil> does not shadow the live one', info.depthAndStencil === true);
  check('no live <title> still falls back to <filename>', info.title === 'live-demo');

  // The raw template case: width/height exist ONLY inside comments. Before the
  // comment strip this threw ("width/height must be positive integers"), while
  // AIR treats the commented tags as absent and applies its defaults.
  const defaults = parseAirApp(
    `<application xmlns="http://ns.adobe.com/air/application/51.0">` +
    `<id>demo.as3.descriptor</id><filename>live-demo</filename>` +
    `<initialWindow><!-- <width></width> --><!-- <height></height> -->` +
    `<content>Live.swf</content></initialWindow>` +
    `</application>`);
  check('a fully commented-out width/height falls back to the 800x600 defaults',
    defaults.width === 800 && defaults.height === 600);

  if (ok > 0) console.log(`[air-app-xml] ${ok} descriptor-comment checks passed`);
  return bad;
}

// ---- the documented backend link sets must actually compile (阶段一百一十一) ----
// The docs name two example manifests as THE way to reach each non-default backend:
// examples/skia-link.build.example.json (Skia, no window -> offscreen PNG) and
// examples/window_click.build.example.json (Skia + SDL2 -> a real window and its
// event loop). Nothing here used to touch either — test/examples.ts builds every
// example as plain C (no manifest), so both define sets went unexercised and the
// offscreen one rotted silently: the generated cursor sampler references
// AS_CURSOR_*, and the runtime branch that manifest selects had no copy of the
// enum, so `as-aot examples/hello.as --manifest examples/skia-link.build.example.json`
// died with 10 x "use of undeclared identifier" (2026-10-06).
//
// This group closes the hole where the failure actually happened: COMPILE the
// generated C under exactly the defines the manifest declares. It needs no Skia
// link — the generated .c only ever sees flat `extern` declarations, never a Skia
// header — so the guard costs well under a second per set instead of pulling 97 MB
// of static Skia into CI. That is deliberate: the failure mode was a C compile
// error, and a C compile error is what this catches.
function checkDocumentedLinkSets(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [linkset] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [linkset] ${label}`); }
  };
  // Scratch dir for the generated C + its object; temp/ is outside the repo's
  // tracked files (and gitignored), so the guard leaves no litter behind.
  const scratch = join(root, 'temp', 'unit-linkset');
  mkdirSync(scratch, { recursive: true });
  // The manifest's own documented command line is `--manifest …` on hello.as, and
  // the cursor sampler is emitted for every program (not only ones that render),
  // so the smallest example is also the faithful one.
  const cSource = generateC(parse(readFileSync(join(dir, 'hello.as'), 'utf8'))).c;
  // Self-validation: if the cursor sampler ever stops being emitted by default,
  // the compile checks below would pass vacuously. Pin the premise instead.
  check('the generated C references the cursor kinds (the premise of this guard)',
    cSource.includes('AS_CURSOR_IBEAM') && cSource.includes('ASC_cursor_kind_of_name'));
  const sets = [
    { name: 'offscreen', manifest: 'skia-link.build.example.json', needsWindow: false },
    { name: 'window', manifest: 'window_click.build.example.json', needsWindow: true },
  ];
  for (const s of sets) {
    const mpath = join(dir, s.manifest);
    const cfg = applyManifest(defaultBuildConfig(), loadManifest(mpath), mpath);
    const defines = effectiveDefines(cfg);
    // 1) The manifest must be what the doc table claims it is. The two sets have to
    //    stay distinct — folding the window defines into the offscreen manifest is
    //    the "fix" that would silently turn the minimal offscreen example into a
    //    windowed build.
    check(`${s.name}: manifest declares ASC_USE_SKIA`, defines.includes('ASC_USE_SKIA=1'));
    check(`${s.name}: manifest ASC_USE_WINDOW is ${s.needsWindow ? 'set' : 'absent'}`,
      defines.some((d) => d.startsWith('ASC_USE_WINDOW')) === s.needsWindow);
    check(`${s.name}: manifest links the skia glue`,
      cfg.sources.some((p) => p.endsWith('skia_glue.cc')) && cfg.linkLibs.includes('skia'));
    check(`${s.name}: manifest window glue/SDL2 follows ASC_USE_WINDOW`,
      cfg.sources.some((p) => p.endsWith('window_glue.cc')) === s.needsWindow
      && cfg.linkLibs.includes('SDL2') === s.needsWindow);
    // 2) The generated C must survive that exact define set — the assertion that
    //    would have failed on 2026-10-06. buildCompileSteps()[0] is the manifest's
    //    own C compile step (its defines and include paths included).
    const cfile = join(scratch, `${s.name}.c`);
    writeFileSync(cfile, cSource);
    const step = buildCompileSteps(cfg, cfile, join(scratch, s.name))[0];
    let firstError = '';
    try { execFileSync(step[0], step.slice(1), { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS }); }
    catch (e) { firstError = String((e as { stderr?: Buffer }).stderr ?? e).split('\n')[0]; }
    check(`${s.name}: the generated C compiles under the manifest defines${firstError ? ` -- ${firstError}` : ''}`,
      firstError === '');
  }
  if (ok > 0) console.log(`[linkset] ${ok} documented-link-set checks passed`);
  return bad;
}

registerGroup('unit: build/ManifestLayering', checkManifestLayering);
registerGroup('unit: build/PreloadExcludes', checkPreloadExcludes);
registerGroup('unit: build/PreloadOutputDir', checkPreloadOutputDir);
registerGroup('unit: build/PerfFlags', checkPerfFlags);
registerGroup('unit: build/DebugInfo', checkDebugInfo);
registerGroup('unit: build/Features', checkFeatures);
registerGroup('unit: build/WasmExport', checkWasmExport);
registerGroup('unit: build/DocumentedLinkSets', checkDocumentedLinkSets);
registerGroup('unit: air-app/DescriptorComments', checkAirAppDescriptorComments);
