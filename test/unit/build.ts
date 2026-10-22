// Unit checks: build manifest, preload, perf/debug flags, features, wasm export.
// Moved verbatim out of the single-file test.ts (阶段九十六·一); each group
// still returns the list of failed labels and is registered as one node:test
// case, so it can be re-run alone with:
//   node --test --test-name-pattern='build/' test/unit/*.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { tmpdir, platform as osPlatform } from 'node:os';
import { lex } from '../../src/lexer.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures, windowsTargetTriple, hostVendorKey, linkTrimFlags, icuDataPaths, writeIcuAssembly, icuArchiveDataVersion, objectDir, cleanObjectScratch, ensureOutDir, deploySkiaIcuData } from '../../src/build.ts';
import type { BuildConfig, Target, Manifest } from '../../src/build.ts';
import { airManifest, prepareAirApp, parseAirApp } from '../../src/air-app.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';
import { generateXcodeProject } from '../../src/xcode-project.ts';
import { aneHostDirName, aneHostLibName, anePlatformForBuild, anePlatformHint, currentAnePlatform, parseExtensionXml, resolveAneDescriptors, resolveExtensionPackages } from '../../src/ane.ts';
import type { AneResolution } from '../../src/ane.ts';
import { ANE_COUNT_MAX } from '../../src/fre.ts';

// The executable bit a SCRIPT needs, asked in a way that works on every host.
//
// NTFS has no execute bit: Node reports 0o666 for every regular file, so
// `(statSync(p).mode & 0o111) !== 0` can never hold on Windows and the pin went
// red for a reason that had nothing to do with the scripts. The durable fact is
// the mode GIT records, because that is what a POSIX checkout (and the arm64
// macOS CI runner) materialises -- so on Windows ask the index instead. Returns
// null when this is not a git checkout at all, which is an environment fact to
// report rather than a pass or a failure.
function recordedExecutable(rel: string): boolean | null {
  if (process.platform !== 'win32') return (statSync(join(root, rel)).mode & 0o111) !== 0;
  const r = spawnSync('git', ['ls-files', '-s', '--', rel], { cwd: root, encoding: 'utf8' });
  const line = (r.stdout ?? '').trim();
  if (r.status !== 0 || line === '') return null;
  return line.startsWith('100755 ');
}

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

// ---- top-level manifest keys must be known (阶段二百五十二) ----
// The layer check above catches typos INSIDE a `targets.<name>` block; the top
// level had no such gate, so `"link-lib"` or `"as-class-path"` sitting at the
// root of a manifest was accepted and then simply never read (AGENTS.md §2.5).
// These assertions pin the three answers the gate must give: a real field loads
// untouched, a near-miss names the field it was meant to be, and a CLI-only key
// says so rather than guessing at a near-miss that would send the user in circles.
function checkManifestUnknownKeys(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [mfkey] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [mfkey] ${label}`); }
  };
  const tmp = join(root, 'temp', 'manifest-unknown-keys.json');
  mkdirSync(dirname(tmp), { recursive: true });
  // Returns the error message, or '' when the manifest loaded.
  const tryLoad = (body: Record<string, unknown>): string => {
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
    try { loadManifest(tmp); return ''; }
    catch (e) { return String((e as Error).message); }
  };

  // 1) A misspelling is refused, and the message is actionable.
  const typo = tryLoad({ 'link-lib': ['skia'] });
  check('a misspelled top-level key is an error, not a silent no-op', typo !== '');
  check('...the message names the key', typo.includes("'link-lib'"));
  check('...the message names the manifest', typo.includes('manifest-unknown-keys.json'));
  check('...and proposes the nearest real field', typo.includes("did you mean 'link-libs'?"));
  check('...and lists what IS accepted', typo.includes('known:') && typo.includes('link-libs'));
  check('the message is singular for one key', typo.includes('unknown field '));
  const plural = tryLoad({ 'link-lib': [], 'font-url': [] });
  check('several typos are reported in one message',
    plural.includes("'link-lib'") && plural.includes("'font-url'") && plural.includes('unknown fields '));
  // The suggestion has TWO paths. `link-lib` is a PREFIX of `link-libs`, so it is
  // answered by the "user stopped typing" rule; an underscore-for-dash slip is not
  // a prefix and only the edit-distance rule can find it. Without this case the
  // distance rule could be deleted outright and every assertion above still pass.
  const slip = tryLoad({ 'link_libs': ['skia'] });
  check('an underscore-for-dash slip is answered by edit distance',
    slip.includes("did you mean 'link-libs'?"));
  const far = tryLoad({ whatever: 1 });
  check('a key with no near-miss gets no bogus suggestion',
    far.includes("'whatever'") && !far.includes('did you mean'));

  // 2) A command-line option is named as such. `as-class-path` is the one that
  //    actually happened: it was written into a manifest to see whether it would
  //    take effect, and the only feedback available was "nothing changed".
  const cli = tryLoad({ 'as-class-path': ['../as-library'] });
  check('a CLI-only key in a manifest is refused', cli.includes("'as-class-path'"));
  check('...and is named as a command-line option', cli.includes('command-line option'));
  check('...with no misleading "did you mean" attached to it', !cli.includes('did you mean'));
  check('the AS-side flags with no manifest spelling are all caught',
    ['main-class', 'all-sources', 'include-third-party']
      .every((k) => tryLoad({ [k]: 'x' }).includes('command-line option')));

  // 3) `$`-prefixed metadata passes (a `$schema` must not make a manifest unusable).
  check('a $-prefixed metadata key is allowed', tryLoad({ $schema: 'https://example/x.json', target: 'native' }) === '');

  // 4) The gate is not accidentally narrow: every documented field must still
  //    load, or a legitimate build would be rejected for the wrong reason.
  const every: Record<string, unknown> = {
    target: 'native', package: 'raw', 'c-compiler': 'cc', opt: '-O2', 'debug-info': true,
    lto: true, pgo: 'use', 'pgo-dir': 'prof', sources: [], 'swc-paths': [], 'ane-paths': [],
    'ane-platform': 'windows-x64', 'include-paths': [], 'link-libs': [], 'link-paths': [],
    defines: [], 'c-flags': [], features: [], objects: [], frameworks: [], exports: [],
    'font-urls': [], 'preload-paths': [], 'preload-excludes': [], 'bundle-id': 'com.example.x',
    'display-name': 'X', icon: 'icon.ico', 'deployment-target': '13.0', architecture: '64',
    targets: { native: {} },
  };
  check('all 30 documented fields load', tryLoad(every) === '');

  // 5) Nothing already checked in may start failing. The gate exists to reject
  //    typos, not the manifests this repo ships -- the 29 example manifests
  //    (hand-written and `--air-app` snapshots alike) are the standing proof.
  const manifests: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.indexOf('.build.') >= 0 && e.name.endsWith('.json')) manifests.push(p);
    }
  };
  walk(join(root, 'examples'));
  const rejected: string[] = [];
  for (const f of manifests) {
    try { loadManifest(f); } catch (e) { rejected.push(`${basename(f)}: ${(e as Error).message}`); }
  }
  check(`${manifests.length} checked-in example manifests still load`,
    manifests.length >= 20 && rejected.length === 0);
  for (const r of rejected) console.log(`      rejected: ${r}`);

  if (ok > 0) console.log(`[mfkey] ${ok} manifest-key checks passed`);
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
  // mutating index.ts to pass `null` left checks 1-4 green). Pin the call sites --
  // ALL of them, not just the first: `doctor` calls prepareAirApp too, and a scan
  // that stops at the first match silently pinned whichever call happened to come
  // first in the file (which is how this went red the moment doctor was added).
  const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const callSites = [...indexSource.matchAll(/prepareAirApp\([^;]*?\);/gs)].map((m) => m[0]);
  check('the CLI hands -o to the adapter',
    callSites.length > 0 && callSites.every((c) => c.includes('opts.output')));
  check('...and still passes the resolved --features set',
    callSites.length > 0 && callSites.every((c) => c.includes('explicitFeatures') || c.includes('resolveFeatures(')));

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

// ---- ANE host-library layout (阶段一百七十八·三 / ·四） ----
// Properties that a green end-to-end run does NOT protect, because the host
// platform happens to be the only one that EXISTED at the time:
//   (a) the CLI --ane-platform override must actually REACH the config. It was
//       parsed and then dropped, so `--ane-platform Windows-x86` resolved, linked
//       and staged as x64 and exited 0 -- a silent wrong-architecture build.
//   (b) the include path and the link path must stay on DIFFERENT sides of the
//       lib/bin/<platform> split: asaot.h is one contract shared by all platforms,
//       the import library is that platform's product.
//   (c) the .gitignore whitelist that keeps lib/asaot_host.c (a hand-written build
//       input) out of the global `*.c` rule. Without it a fresh clone has no host
//       forwarder, no asaot.dll, and nothing in the checkout to explain why.
//   (d) build-asaot.bat must build BOTH widths by default. Which width a build
//       consumes is --ane-platform's job and an extension declares its own, so
//       "just build the width of this machine" is the same silent-substitution
//       bug as (a), one level down -- and it was exactly why (a) stayed invisible.
//   (e) the width set is closed at two, and no ARM64 host may appear: AIR has no
//       Windows ARM64 runtime, so such a library could never be loaded (see the
//       unit: build/WindowsArch group for the measurement and the other two
//       places the ARM axis can go wrong).
function checkAneHostLayout(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [anehost] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [anehost] ${label}`); }
  };
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

  check('index.ts applies the CLI --ane-platform override onto cfg',
    /cfg\.anePlatform = opts\.overrides\.anePlatform/.test(indexSrc));
  check('index.ts links the host library out of lib/bin/<platform>',
    /resolve\(libDir, 'bin', aneHostDirName\(platform\)\)/.test(indexSrc));
  check('index.ts keeps the header include path at lib/ itself',
    /cfg\.includePaths\.push\(libDir\)/.test(indexSrc));

  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  check('.gitignore re-includes the hand-written lib/*.c sources',
    /^!lib\/\*\.c$/m.test(gitignore));
  // 阶段二百一十: two per-machine snapshots stopped being tracked. The Xcode sidecar
  // holds ABSOLUTE paths and its merge REMOVES files it no longer recognises, so a
  // committed copy would delete other machines' entries; the xcuserdata tree is Xcode
  // IDE state with the developer's username in the directory name. Both are pinned as
  // ignore rules because "someone re-adds the file with git add -f" is otherwise silent.
  check('.gitignore ignores the generated Xcode sidecar (absolute paths, not an input)',
    /^examples\/\*\*\/\.as3aot-managed\.json$/m.test(gitignore));
  check('.gitignore ignores Xcode per-user IDE state',
    /^\*\*\/xcuserdata\/$/m.test(gitignore) && /^\*\.xcuserstate$/m.test(gitignore));

  // (d) build-asaot.bat must build BOTH widths by default. A build's host width is
  //     chosen by --ane-platform, not by the machine that happens to run the script,
  //     so "only the host of this box" is the same silent-substitution bug as (a),
  //     one level down. The paired triple is pinned together with the directory
  //     because a swap would quietly put a 64-bit DLL in bin/windows-x86/.
  const batPath = join(root, 'lib', 'build-asaot.bat');
  check('lib/build-asaot.bat exists', existsSync(batPath));
  if (existsSync(batPath)) {
    const bat = readFileSync(batPath, 'utf8');
    check('the bat builds BOTH widths when given no argument',
      /^if "%WHICH%"=="" set "WHICH=all"$/m.test(bat));
    check('the i686 triple is paired with bin\windows-x86',
      /call :build windows-x86 i686-pc-windows-msvc/.test(bat)
      && !/call :build windows-x86 x86_64/.test(bat));
    check('the x86_64 triple is paired with bin\windows-x64',
      /call :build windows-x64 x86_64-pc-windows-msvc/.test(bat)
      && !/call :build windows-x64 i686/.test(bat));
    check('both selectors (x86 / x64) are accepted',
      /if \/i "%WHICH%"=="x86"/.test(bat) && /if \/i "%WHICH%"=="x64"/.test(bat));
    check('an unrecognized argument fails instead of silently skipping a width',
      /unknown argument/.test(bat) && /^exit \/b 2$/m.test(bat));
    // The import library must name the forwarder module; the guard has to be a
    // real probe, and it has to be a probe that CAN match -- an ASCII findstr on
    // the archive is the only shape that works here (measured against a
    // llvm-lib /DEF: product, which really does come out with a blank module).
    check('the bat verifies the import library names asaot.dll',
      /findstr \/c:"asaot\.dll"/.test(bat));
    // (e) ARM64 is a decision, not an omission: AIR has no Windows ARM64 runtime,
    //     so a host library for it could never be loaded. Pinned as an inventory
    //     fact (no triple, no directory) rather than as prose in the script.
    check('the asaot script builds no ARM64 host library', !/aarch64/.test(bat));
    check('no lib/bin/ directory exists for a key AIR does not have',
      !existsSync(join(root, 'lib', 'bin', 'windows-arm64')));
    // CRLF is load-bearing: cmd.exe's `^` line continuation swallows characters
    // when the file has bare LF, and this script relies on it for the clang line.
    check('build-asaot.bat keeps CRLF line endings',
      bat.includes('\r\n') && !/(?<!\r)\n/.test(bat));
    // (f) The ARTIFACT guards (阶段二百一十). build-asaot.sh always asserted the
    //     artifact -- the entry point, the export count, and "no Adobe AIR" --
    //     while the .bat asserted only the import library. A host library with the
    //     right name but the wrong contents builds and links cleanly here and only
    //     explodes later, when some extension is loaded, so the .bat now runs the
    //     same three probes. Pinned one guard at a time rather than as "the two
    //     files look alike", because the failure mode is precisely one end going
    //     its own way.
    // (A `dumpbin` INVOCATION is what is pinned absent -- the header comment
      //  mentioning it while explaining why it is not used is fine, and matching
      //  the bare word here would fail on that comment.)
    check('the bat inspects the built DLL with llvm-objdump (no VS prompt needed)',
      /^llvm-objdump -p .*?asaot\.dll/m.test(bat) && !/^dumpbin/m.test(bat));
    check('the bat asserts the DLL exports asaot_bind',
      /findstr \/c:"asaot_bind"/.test(bat));
    check('the bat asserts the 53-export count (exactly, not "at least")',
      /if not "%EXPORTS%"=="53"/.test(bat));
    check('the bat asserts the DLL does NOT import Adobe AIR.dll',
      /findstr \/i \/c:"Adobe AIR\.dll"/.test(bat)
      && /still imports Adobe AIR\.dll/.test(bat));
  }

  // (e) A flag that parses but is absent from --help is a hole in the documented
  //     interface: --ane / --ane-platform worked and were missing from the usage
  //     text entirely. The check reads the usage() BODY, not the whole file -- the
  //     two names also occur in the parse chain and in the override block, so a
  //     whole-file search would still pass with the help lines deleted (a false pin).
  const usageStart = indexSrc.indexOf('function usage()');
  const usageEnd = indexSrc.indexOf(".join('\\n');", usageStart);
  check('the usage() body was located (precondition for the two pins below)',
    usageStart >= 0 && usageEnd > usageStart);
  const usageBody = usageStart >= 0 && usageEnd > usageStart ? indexSrc.slice(usageStart, usageEnd) : '';
  check('--ane <path> is listed in the --help text', usageBody.includes('--ane <f>'));
  check('--ane-platform is listed in the --help text', usageBody.includes('--ane-platform <key>'));

  // The offered keys and the mappable keys are two copies of ONE vocabulary, and a
  // divergence is a bug either way: an offered key throws when actually used, a
  // mappable key is undiscoverable. Read the usage() BODY (the interface), not the
  // file, and ask the product rather than a literal list -- `MacOS-AOT` was wrong in
  // all three places at once (offered, mapped, and returned by currentAnePlatform),
  // which is the shape a per-site text pin cannot see.
  const AIR_KEYS = ['Windows-x86-64', 'Windows-x86', 'MacOS-x86', 'MacOS-x86-64', 'MacOS-AOT', 'iPhone-ARM'];
  // Boundary-aware: 'MacOS-x86' is a substring of 'MacOS-x86-64', so a plain
  // `includes` would report a key as offered that the help text never lists.
  const offeredIn = (body: string, k: string): boolean =>
    new RegExp(`(^|[^\\w-])${k}(?![\\w-])`).test(body);
  const offered = AIR_KEYS.filter((k) => offeredIn(usageBody, k));
  const mappable = AIR_KEYS.filter((k) => {
    try { aneHostDirName(k); return true; } catch { return false; }
  });
  check('the keys --help offers and the keys with a lib/bin directory are the same set',
    offered.join(',') === mappable.join(','));

  // Behavioural half: the AIR platform key -> directory-name translation. The
  // unknown-key case must THROW rather than invent a directory, or a build would
  // go looking for a host library that was never built for that platform.
  const mapped: Array<[string, string]> = [
    ['Windows-x86-64', 'windows-x64'],
    ['Windows-x86', 'windows-x86'],
    ['MacOS-x86-64', 'macos-x86-64'],
    ['iPhone-ARM', 'ios-arm64'],
  ];
  check('every AIR platform key maps to its lowercase lib/bin directory',
    mapped.every(([key, expected]) => aneHostDirName(key) === expected));
  let threw = false;
  try { aneHostDirName('Android-ARM64'); } catch { threw = true; }
  check('an unmapped platform key throws instead of guessing a directory', threw);
  // `MacOS-AOT` was a row of the table above, mapped to macos-arm64. It is not an AIR
  // key anywhere in SDK 51.4.1 (0 hits in 2079 files), and its only producer --
  // currentAnePlatform on darwin/arm64 -- no longer answers it. So it has to throw like
  // any other unknown key: a surviving case would keep advertising a lib/bin directory
  // that nothing can ever ask for, and would let the wrong key come back unnoticed.
  let aotThrew = false;
  try { aneHostDirName('MacOS-AOT'); } catch { aotThrew = true; }
  check('MacOS-AOT, which AIR never emits, no longer names a host-library directory', aotThrew);

  console.log(`[anehost] ${ok} passed, ${bad.length} failed`);
  return bad;
}

// ---- Windows architecture axis: ARM64 must be a decision, never a default ----
// AIR has no Windows ARM64 runtime. Measured on AIR SDK 51.4.1: each Windows runtime
// carries exactly ONE platform key -- win/Adobe AIR.dll has Windows-x86, the win64 one
// has Windows-x86-64 -- so the closed set is those two, and neither is arm64. win/ and
// win64/ are the only Windows runtimes the SDK ships, and the 51.4.1 release notes name
// arm64 for Linux / iOS / macOS only. Windows ARM64 is wrong in
// four places, and each one failed differently -- or not at all:
//   (a) currentAnePlatform() ended the win32 branch in `arch === 'ia32' ? x86 : x64`,
//       so an arm64 host silently claimed the x64 key: the same silent-substitution
//       shape as the --ane-platform override bug, one level up. It returns '' now,
//       which makes index.ts demand an explicit key instead of guessing one.
//   (b) aneHostDirName() must have NO Windows-arm64 case: lib/bin/windows-arm64
//       would be a host library that no runtime could ever load (the same mistake
//       as a wasm/ directory), so the key falls through to the throw.
//   (c) the target triple: `arm64` is a MANIFEST-only value (AIR's <architecture>
//       takes 32/64 only) mapping to aarch64, so a Windows-on-ARM host cannot reach
//       the linker holding an x86_64 archive set while believing it built arm64.
//   (d) vendor/provision/windows.ps1 grew a real arm64 axis, plus the two properties that
//       keep it honest: `both` does NOT silently include arm64 (both means "the
//       widths an AIR descriptor can ask for"), and vcvarsall's exit code is not
//       trusted -- `vcvarsall arm64` exits 0 on this machine with no arm64 toolset
//       installed at all, so the check has to look at files.
function checkWindowsArch(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [winarch] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [winarch] ${label}`); }
  };

  // (a) the host-platform table, every row reachable because the parameters
  //     default to process.* but can be supplied (an x64 machine cannot otherwise
  //     exercise the arm64 row, and an untested branch is where this hid).
  const hosts: Array<[string, string, string]> = [
    ['win32', 'x64', 'Windows-x86-64'],
    ['win32', 'ia32', 'Windows-x86'],
    ['darwin', 'arm64', 'MacOS-x86-64'],
    ['darwin', 'x64', 'MacOS-x86-64'],
  ];
  check('each host/arch pair maps to its AIR platform key',
    hosts.every(([p, a, key]) => currentAnePlatform(p, a) === key));
  // The macOS key carries no architecture (measured: AIR's macOS runtime is one
  // universal x86_64+arm64 binary whose single 64-bit ANE key, MacOS-x86-64, sits in
  // both slices next to the ANE-loader strings). So the two macOS hosts must agree, and
  // an arm64 Mac must NOT be handed a key of its own -- `MacOS-AOT` was exactly that,
  // and it matched no .ane while `adl` on the same machine loaded MacOS-x86-64 fine.
  check('both macOS architectures yield the same key, and it is AIR\'s own',
    currentAnePlatform('darwin', 'arm64') === currentAnePlatform('darwin', 'x64') &&
    currentAnePlatform('darwin', 'arm64') === 'MacOS-x86-64' &&
    currentAnePlatform('darwin', 'arm64') !== 'MacOS-AOT');
  check('a Windows ARM64 host yields NO key (never a silent x64 claim)',
    currentAnePlatform('win32', 'arm64') === '' && currentAnePlatform('win32', 'arm64') !== 'Windows-x86-64');
  check('a host with no AIR key at all yields none (Linux)',
    currentAnePlatform('linux', 'x64') === '');

  // (b) no directory for a key AIR does not have.
  for (const key of ['Windows-arm64', 'Windows-ARM64', 'windows-arm64']) {
    let threw = false;
    try { aneHostDirName(key); } catch { threw = true; }
    check(`aneHostDirName('${key}') throws instead of naming a host library`, threw);
  }

  // (c) the triple, and the manifest gate in front of its default.
  check('manifest architecture 32/64/arm64 map to i686/x86_64/aarch64',
    windowsTargetTriple('32') === 'i686-pc-windows-msvc' &&
    windowsTargetTriple('64') === 'x86_64-pc-windows-msvc' &&
    windowsTargetTriple('arm64') === 'aarch64-pc-windows-msvc');
  const manifestPath = join(root, 'examples', 'windows-arch.pin.json');
  const withArch = (a: string): BuildConfig =>
    applyManifest(defaultBuildConfig(), { architecture: a } as Manifest, manifestPath);
  check('a manifest may ask for arm64', withArch('arm64').architecture === 'arm64');
  let badArchThrew = false;
  try { withArch('arm65'); } catch { badArchThrew = true; }
  check('an unknown manifest architecture fails instead of defaulting to x86_64', badArchThrew);
  // The gate that makes the triple reach every step: nativeTargetFlags and
  // deploySkiaIcuData both used to test `!== '32' && !== '64'`, which would have
  // left an arm64 build compiling with the host ABI and /MD against /MT archives.
  const buildSrc = readFileSync(join(root, 'src', 'build.ts'), 'utf8');
  const arm64Gates = buildSrc.match(/!== '64' && cfg\.architecture !== 'arm64'/g) ?? [];
  check('every architecture gate also accepts arm64', arm64Gates.length === 2);

  // (d) the dependency script's arm64 axis, and the guard that must not be a
  //     blanket reject: the self-check reads FILES, and it names the component.
  // The script lives under vendor/provision/ (provisioning = how the artifacts
  // were made; vendor/ itself is the artifacts), so this path is deliberately
  // two segments deep.
  const ps1 = readFileSync(join(root, 'vendor', 'provision', 'windows.ps1'), 'utf8');
  check('vendor/provision/windows.ps1 accepts -Arch arm64',
    /\[ValidateSet\('x64', 'x86', 'arm64', 'both'\)\]/.test(ps1));
  check('`both` still means the two AIR widths, not three',
    /if \(\$Arch -eq 'both'\) \{ \$Arches = @\('x64', 'x86'\) \}/.test(ps1));
  check('arm64 maps to the aarch64 CMake triple',
    /\$Arch -eq 'arm64'\) \{ \$archFlags = @\('--target=aarch64-pc-windows-msvc'\) \}/.test(ps1));
  check('arm64 pins the triple into Skia too (clang-cl defaults to the host arch)',
    /extra_cflags = \[ "--target=aarch64-pc-windows-msvc" \]/.test(ps1));
  check('the arm64 toolset is verified by reading files, not by the exit code',
    /vcvarsall\.bat \$arch 会照样返回 0/.test(ps1) &&
    /Get-ChildItem -Path \$libDir -Filter '\*\.lib'/.test(ps1));
  check('the missing-toolset failure names the component to install',
    /MSVC v143 - VS 2022 C\+\+ \$arch build tools/.test(ps1));
  check('the positive branch is a real check, not a collective reject',
    /\$arch 位宽工具集自检通过/.test(ps1) &&
    /\$clCmd\.Source -notmatch/.test(ps1));

  // The Windows ARM64 advice in the CLI error must name the x64 target, not a
  // nonexistent 'Windows-arm64' key.
  // The no-key error must send a Windows-on-ARM user to the x64 key, never to a
  // 'Windows-arm64' one. Pinned on the advice FUNCTION, not on the message text: a
  // text pin passes with the branch disabled (`(false ? ...)`) because the string is
  // still in the file -- a false pin. The call site is pinned separately so that
  // dropping the advice fails too.
  check('the Windows ARM64 hint names the x64 key and an x64 build',
    anePlatformHint('win32', 'arm64').includes('Windows-x86-64') &&
    anePlatformHint('win32', 'arm64').includes('architecture'));
  check('the hint stays silent where the plain instruction is enough',
    anePlatformHint('win32', 'x64') === '' && anePlatformHint('linux', 'x64') === '');
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  // The semantic half: the arch that LOST its key is the one the hint must cover.
  // This is what makes the call site below meaningful -- a hint that knows nothing
  // about the refused arch is advice nobody can act on.
  check('the arch the hint is consulted about is the arch whose key was refused',
    anePlatformHint('win32', 'arm64') !== '' &&
    anePlatformForBuild('arm64', 'native', 'win32', 'x64') === '');
  // The call-site half. Pinned LOOSELY on purpose: an exact argument-list pattern
  // has to be re-edited every time the expression grows (it did, twice, while this
  // branch was written) and a pin you keep editing is a pin that stops meaning
  // anything. What must not regress is narrower and stable: the host arch is still
  // asked, AND the target arch is a possible answer -- because on Windows the
  // build's own architecture can be what has no key, and a message that blames the
  // host sends the user to a flag that cannot help them.
  check('the no-key error consults that hint',
    /anePlatformHint\(process\.platform,/.test(indexSrc));
  check('…and can name the TARGET, not only the host, as the one with no key',
    /cfg\.architecture === 'arm64'/.test(indexSrc) && indexSrc.includes("'arm64'"));
  check('the offered key list holds only keys AIR actually has',
    /--ane-platform <Windows-x86-64\|Windows-x86\|MacOS-x86-64\|iPhone-ARM>/.test(indexSrc) &&
    !indexSrc.includes('MacOS-AOT'));

  console.log(`[winarch] ${ok} passed, ${bad.length} failed`);
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
  // The call site is pinned as a PREFIX through the export list on purpose: this
  // check is about the CLI --export list reaching codegen, not about generateC's
  // full arity. Pinning the whole argument list made it go red every time a
  // parameter was appended for an unrelated stage (the ANE descriptor list was
  // the one that did it), which is noise, not signal.
  check('index.ts threads the CLI export list into codegen',
    /generateC\(program, cfg\.exports, swcResources, swcBake, embedResources, embedFieldInits, appDescriptorXml[,)]/.test(readFileSync(join(root, 'src', 'index.ts'), 'utf8')));

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
    try {
      // Same directory rule as production: the object lands in this build's own scratch
      // under $TMPDIR, and the runner (not the builder) is what creates it.
      ensureOutDir(step);
      execFileSync(step[0], step.slice(1), { stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS });
    }
    catch (e) { firstError = String((e as { stderr?: Buffer }).stderr ?? e).split('\n')[0]; }
    check(`${s.name}: the generated C compiles under the manifest defines${firstError ? ` -- ${firstError}` : ''}`,
      firstError === '');
  }
  if (ok > 0) console.log(`[linkset] ${ok} documented-link-set checks passed`);
  return bad;
}

// ---- --package xcode-project flag parity (raw link == .app link) ----
//
// The generated .xcodeproj is a SECOND build of the same C: if it does not carry
// the exact flags the raw `cc` path carries, the same manifest compiles into two
// different programs with no warning (§1.5). Three are load-bearing and pinned
// here: -ffp-contract=off (SEMANTIC — one IEEE rounding per AS3 op, not a perf
// knob, so an .app built by Xcode must have it too), -liconv on macOS (the
// generated C references iconv_* unconditionally under AS_HAVE_ICONV), and the
// feature macros from effectiveDefines (--features svg -> ASC_USE_SVG=1).
function checkXcodeProjectParity(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [xcode] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [xcode] ${label}`); }
  };

  // Scratch dir under temp/ (gitignored): generate a real project from a tiny
  // stub .c and read back project.pbxproj, using the shipped generator rather
  // than grepping xcode-project.ts (what matters is the emitted project).
  const outDir = join(root, 'temp', 'unit-xcode-parity');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const cPath = join(outDir, 'Parity.c');
  writeFileSync(cPath, 'int main(void) { return 0; }\n');
  // --features svg is native-only, which is exactly the target xcode-project builds.
  const cfg: BuildConfig = { ...defaultBuildConfig(), package: 'xcode-project', features: ['svg'] };
  const proj = generateXcodeProject(cfg, cPath, outDir, 'Parity');
  const pbx = readFileSync(join(proj.projectPath, 'project.pbxproj'), 'utf8');

  // Read each build-setting block back so "present somewhere" cannot pass for
  // "present on the right surface": fpFlags must be on BOTH the compile
  // (OTHER_CFLAGS) and link (OTHER_LDFLAGS) lists, or the .app rounds differently
  // than the raw single-command build does. GCC_PREPROCESSOR_DEFINITIONS appears
  // twice (the project-wide "$(inherited)" block first, then the per-target one),
  // so join every occurrence rather than trusting the first.
  const blocksOf = (key: string): string =>
    [...pbx.matchAll(new RegExp(`${key} = \\(([\\s\\S]*?)\\);`, 'g'))].map((m) => m[1]).join('\n');
  const cflags = blocksOf('OTHER_CFLAGS');
  const ldflags = blocksOf('OTHER_LDFLAGS');
  const defines = blocksOf('GCC_PREPROCESSOR_DEFINITIONS');

  check('the raw compile surface is present (OTHER_CFLAGS is emitted)', pbx.includes('OTHER_CFLAGS = ('));
  check('the project disables FP contraction on the COMPILE step (-ffp-contract=off)',
    cflags.includes('"-ffp-contract=off"'));
  check('…and on the LINK step (OTHER_LDFLAGS), matching the raw single command',
    ldflags.includes('"-ffp-contract=off"'));
  if (process.platform === 'darwin') {
    check('macOS: the project links the runtime iconv (-liconv), like the raw link',
      ldflags.includes('"-liconv"'));
  }
  check('a --features macro reaches GCC_PREPROCESSOR_DEFINITIONS (ASC_USE_SVG=1)',
    defines.includes('"ASC_USE_SVG=1"'));

  if (ok > 0) console.log(`[xcode] ${ok} xcode-project parity checks passed`);
  return bad;
}

registerGroup('unit: build/ManifestLayering', checkManifestLayering);
registerGroup('unit: build/ManifestUnknownKeys', checkManifestUnknownKeys);
registerGroup('unit: build/PreloadExcludes', checkPreloadExcludes);
registerGroup('unit: build/PreloadOutputDir', checkPreloadOutputDir);
registerGroup('unit: build/PerfFlags', checkPerfFlags);

// ---- 阶段二百四十六: raw C compiler flags (--cflag / -w / `c-flags`) ----
//
// A passthrough is only worth anything if the flag lands on the argv the user's
// compiler actually receives, on EVERY step: a `-w` that reaches the final link
// but not the compile steps silences nothing, and one that reaches the C steps
// but not the C++ glue layer misses the noise in `vendor/*.cc`. So this drives
// the real command builders, exactly like unit: build/PerfFlags does for LTO.
function checkCFlags(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [cflags] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [cflags] ${label}`); }
  };
  const has = (argv: string[], flag: string): boolean => argv.includes(flag);

  const base = defaultBuildConfig();
  // Off by default: no flag means the byte-for-byte build it always was (§1.5).
  check('the default config carries no C flags', Array.isArray(base.cFlags) && base.cFlags.length === 0);
  check('…and the default command has none either',
    !has(buildCompileCommand(base, 'x.c', 'x'), '-w'));

  const c = { ...base, cFlags: ['-w', '-fno-strict-aliasing'] };
  const native = buildCompileCommand(c, 'x.c', 'x');
  check('both flags reach the native compile+link command',
    has(native, '-w') && has(native, '-fno-strict-aliasing'));
  // Position matters on the LINK line: `-Wl,--as-needed` and friends are order
  // sensitive, so a user flag has to precede the objects and the -l libs.
  const linkOrder = buildCompileCommand({ ...c, objects: ['obj.o'], linkLibs: ['foo'] }, 'x.c', 'x');
  check('…before the objects and libraries on the link line',
    linkOrder.indexOf('-fno-strict-aliasing') < linkOrder.indexOf('obj.o')
    && linkOrder.indexOf('obj.o') < linkOrder.indexOf('foo'));
  check('…and the wasm command too', has(buildCompileCommand({ ...c, target: 'wasm' }, 'x.c', 'x'), '-w'));

  // The C++ path has three steps (C compile, C++ glue compile, link) and a flag
  // missing from any of them is a silently partial build.
  const steps = buildCompileSteps({ ...c, sources: ['a.cc'] }, 'x.c', 'x');
  check('native C++ build: every step (C compile, C++ compile, link) carries them',
    steps.length === 3 && steps.every((argv) => has(argv, '-w') && has(argv, '-fno-strict-aliasing')));
  const web = buildWebCompileSteps({ ...c, target: 'wasm', package: 'web', sources: ['a.cc'] }, 'x.c', 'x');
  check('web build: every step carries them',
    web.length > 0 && web.every((argv) => has(argv, '-w')));

  // Manifest plumbing: the top-level field APPENDS (so a CLI flag and a manifest
  // can coexist), while a targets.<target> block REPLACES (stage 89-50's rule).
  const m = { 'c-flags': ['-Wno-unused-parameter'] } as Manifest;
  const merged = applyManifest({ ...base, cFlags: ['-w'] }, m, join(root, 'temp', 'cflags', 'm.json'));
  check('a manifest c-flags APPENDS to the config (nothing is dropped)',
    merged.cFlags.length === 2 && merged.cFlags[0] === '-w' && merged.cFlags[1] === '-Wno-unused-parameter');
  const layered = applyManifestOverlay({ ...base, cFlags: ['-w'] },
    { targets: { native: { 'c-flags': ['-O0'] } } } as Manifest, join(root, 'temp', 'cflags', 'm.json'), 'native');
  check('a targets.<target> block REPLACES them (per-target layering rule)',
    layered.cFlags.length === 1 && layered.cFlags[0] === '-O0');

  // CLI surface, read from the argv a --dry run prints (no compiler involved).
  const scratch = join(root, 'temp', 'cflags');
  mkdirSync(scratch, { recursive: true });
  const cliDry = (extra: string[]): string => {
    const r = spawnSync(process.execPath, [join(root, 'src', 'index.ts'), join(dir, 'any-add.as'),
      '--dry', '-o', join(scratch, 'out'), ...extra], { cwd: root, encoding: 'utf8' });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  };
  const line = (out: string): string => out.split(/\r?\n/).find((l) => l.includes('-ffp-contract') || l.includes(' cc ') || l.includes('clang')) ?? '';
  const viaCflag = line(cliDry(['--cflag', '-w']));
  check('--cflag -w puts -w on the printed compile command', /(^| )-w( |$)/.test(viaCflag));
  // The sugar must produce the SAME command, not merely "also work".
  check('-w is exactly --cflag -w', line(cliDry(['-w'])) === viaCflag);
  // `-w` is itself a known CLI flag now, and the --cflag operand deliberately
  // skips the "this looks like a flag" guard -- the whole point is C-level flags.
  check('--cflag accepts an operand that is one of our own flags',
    viaCflag !== '' && !cliDry(['--cflag', '-w']).includes('expects a value'));
  check('--cflag with no operand left is refused, naming the flag',
    cliDry(['--cflag']).includes('--cflag: expects a value'));
  // Nothing is invented: a flag the user did not write never appears.
  const plain = line(cliDry([]));
  check('a run with no flag prints no extra flag', plain !== '' && !/(^| )-w( |$)/.test(plain));

  if (ok > 0) console.log(`[cflags] ${ok} C-flag passthrough checks passed`);
  return bad;
}
registerGroup('unit: build/CFlags', checkCFlags);
registerGroup('unit: build/DebugInfo', checkDebugInfo);
registerGroup('unit: build/Features', checkFeatures);
registerGroup('unit: build/WasmExport', checkWasmExport);
registerGroup('unit: build/AneHostLayout', checkAneHostLayout);
registerGroup('unit: build/WindowsArch', checkWindowsArch);
registerGroup('unit: build/DocumentedLinkSets', checkDocumentedLinkSets);
registerGroup('unit: build/XcodeProjectParity', checkXcodeProjectParity);
registerGroup('unit: air-app/DescriptorComments', checkAirAppDescriptorComments);

// --- ANE extension.xml: comments must not shadow (or invent) declarations -----
// The ANE-side twin of air-app/DescriptorComments above, and a real defect that was
// measured while writing examples/ane/: the descriptor reader was comment-blind, so
// an author who left a commented-out <platform name="..."> sample in extension.xml
// got a FAKE platform entry, and -- because `<platform ...>` / `</platform>` were
// paired by the scanner across the comment boundary -- the real declared platform
// was swallowed with it. The build then rejected a perfectly loadable .ane with
// "has no <platform name="Windows-x86-64"> entry", pointing the user at the one
// thing that was actually correct. Comments are stripped before any tag scanning,
// so the pins below are stated as behaviour (what parseExtensionXml returns), not
// as the presence of a strip call.
function checkAneExtensionXmlComments(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [anexml] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [anexml] ${label}`); }
  };

  // The measured shape: a commented-out platform sample placed ABOVE the live one.
  const d = parseExtensionXml(
    `<?xml version="1.0" encoding="utf-8" ?>\n` +
    `<extension xmlns="http://ns.adobe.com/air/extension/3.1">\n` +
    `  <id>com.example.probe</id>\n` +
    `  <name>Probe</name>\n` +
    `  <versionNumber>1.0.0</versionNumber>\n` +
    `  <platforms>\n` +
    `    <!-- <platform name="MacOS-x86-64"> -->\n` +
    `    <!--   <applicationDeployment> -->\n` +
    `    <!--     <nativeLibrary>ProbeANE.dylib</nativeLibrary> -->\n` +
    `    <!--   </applicationDeployment> -->\n` +
    `    <!-- </platform> -->\n` +
    `    <platform name="Windows-x86-64">\n` +
    `      <applicationDeployment>\n` +
    `        <nativeLibrary>ProbeANE.dll</nativeLibrary>\n` +
    `        <initializer>ProbeExtInitializer</initializer>\n` +
    `        <finalizer>ProbeExtFinalizer</finalizer>\n` +
    `      </applicationDeployment>\n` +
    `    </platform>\n` +
    `  </platforms>\n` +
    `  <!-- TODO: add a macOS entry once lib/bin/macos-x86-64/ ships -->\n` +
    `</extension>`,
    'commented.ane');

  check('the live platform survives a commented-out platform above it',
    d.platforms.some((p) => p.name === 'Windows-x86-64'));
  check('…with its native library intact',
    d.platforms.some((p) => p.name === 'Windows-x86-64' && p.nativeLibrary === 'ProbeANE.dll'));
  check('…and its initializer/finalizer intact',
    d.platforms.some((p) => p.name === 'Windows-x86-64'
      && p.initializer === 'ProbeExtInitializer' && p.finalizer === 'ProbeExtFinalizer'));
  check('a commented-out platform does NOT become a real entry',
    !d.platforms.some((p) => p.name === 'MacOS-x86-64'));
  check('exactly one platform is reported', d.platforms.length === 1);
  // The id/version live outside <platforms>, so they are a second chance for the
  // same bug on a different tag name.
  check('the extension id is read from the live <id>', d.extId === 'com.example.probe');
  check('the version is read from the live <versionNumber>', d.version === '1.0.0');
  // A commented-out sample must not become a DECLARATION, but it also must not make
  // the reader reject the package: the fixture descriptor in examples/ane/ (and its
  // byte-identical twin in examples/ane-app/) is written this way.
  check('a comment quoting a whole platform block is tolerated', d.platforms.length === 1);
  // An unterminated comment is malformed input, not a licence to scan into it: the
  // generated C would otherwise carry a platform nobody declared.
  const unterminated = (): boolean => {
    try {
      parseExtensionXml(
        `<extension><id>a.b</id><versionNumber>1</versionNumber>` +
        `<platforms><!-- <platform name="MacOS-x86-64"><applicationDeployment>` +
        `<nativeLibrary>x.dylib</nativeLibrary></applicationDeployment></platform>` +
        `<platform name="Windows-x86-64"><applicationDeployment>` +
        `<nativeLibrary>x.dll</nativeLibrary></applicationDeployment></platform>` +
        `</platforms></extension>`,
        'broken.ane');
      return false;
    } catch (e) { return /unterminated XML comment/.test(String(e)) && /broken\.ane/.test(String(e)); }
  };
  check('an unterminated comment is refused, naming the package', unterminated());

  console.log(`     [anexml] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: ane/ExtensionXmlComments', checkAneExtensionXmlComments);

// STORE-method ZIP writer: swc.ts's `unzip` walks the EOCD + central directory
// (it does not scan local headers), so a packed fixture needs both records. Shared
// by the two groups that need a REAL `.ane` on disk (the package-layout pins and
// air-app's extdir resolution) -- a hand-rolled "zipped" buffer that happens not to
// be a ZIP would let the reader's ZIP path go untested behind a green check.
function zipStore(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30 + n.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    n.copy(lh, 30);
    const ch = Buffer.alloc(46 + n.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    n.copy(ch, 46);
    parts.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// The example fixture as a PACKED package: same <id>, same platform, same library
// name as examples/ane/ext-aot/com.example.probe, but in the flat ZIP-root layout.
// It is built here rather than copied from the example because the example no longer
// commits a packed .ane at all -- §4.6 dropped `adt -package`, so the recompiled
// artifact IS the staging tree. The packed shape still has to be exercised (a
// descriptor declaring an ID must resolve out of `lib/` too, and telling the packed
// copy apart from the staging tree of the same ID is what makes ext-aot's priority
// observable), so the fixture is synthesized.
function probeAneZip(): Buffer {
  return zipStore([
    ['extension.xml', Buffer.from(
      `<extension xmlns="http://ns.adobe.com/air/extension/51.0"><id>com.example.probe</id>` +
      `<versionNumber>1.0</versionNumber><platforms>` +
      `<platform name="Windows-x86-64"><applicationDeployment><nativeLibrary>ProbeANE.dll</nativeLibrary>` +
      `<initializer>ProbeExtInitializer</initializer><finalizer>ProbeExtFinalizer</finalizer>` +
      `</applicationDeployment></platform></platforms></extension>`, 'utf8')],
    ['ProbeANE.dll', Buffer.from('MZ')],
  ]);
}

// --- ANE native library: the official package layout must resolve ---------------
// A second measured defect, found while packaging the recompiled WinCore extension:
// every ANE that `adt -package -target ane` produces is a SIGNED package whose real
// content lives under `META-INF/ANE/`, so the native library is at
// `META-INF/ANE/<platform>/<lib>` and never at the ZIP root. The reader only looked
// at the root, so it rejected the very package adl loads with "does not contain it"
// -- a §1.5 defect (adl gets it right, this build did not), which is also why the
// dual-artifact recipe had to re-ZIP a flat package instead of pointing at the
// official one. These pins are stated as behaviour on resolveAneDescriptors: which
// BYTES come out for a given platform, not which candidate string is listed first.
function checkAnePackageLayout(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [anepkg] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [anepkg] ${label}`); }
  };

  // The staged key IS the path the generated loader will use, so it belongs to the
  // pinned contract rather than being an implementation detail:
  // <extensionID>/<platform>/<nativeLibrary>, one directory per extension.
  const key = (platform: string, lib = 'Pkg.dll', extId = 'com.example.pkg'): string =>
    `${extId}/${platform}/${lib}`;

  // STORE-method ZIP writer: swc.ts's `unzip` walks the EOCD + central directory
  // (it does not scan local headers), so a fixture needs both records.
  const zip = zipStore;

  const EXT_XML = Buffer.from(
    `<extension xmlns="http://ns.adobe.com/air/extension/51.0"><id>com.example.pkg</id>` +
    `<versionNumber>1.0</versionNumber><platforms>` +
    `<platform name="Windows-x86"><applicationDeployment><nativeLibrary>Pkg.dll</nativeLibrary>` +
    `<initializer>PkgExtInitializer</initializer><finalizer>PkgExtFinalizer</finalizer>` +
    `</applicationDeployment></platform>` +
    `<platform name="Windows-x86-64"><applicationDeployment><nativeLibrary>Pkg.dll</nativeLibrary>` +
    `<initializer>PkgExtInitializer</initializer><finalizer>PkgExtFinalizer</finalizer>` +
    `</applicationDeployment></platform></platforms></extension>`, 'utf8');

  // A package with any extensionID and nativeLibrary, for the checks that need more
  // than one extension (the count limit, and two extensions sharing a file name).
  const extXml = (id: string, lib = 'Pkg.dll', platforms: string[] = ['Windows-x86-64']): Buffer =>
    Buffer.from(
      `<extension xmlns="http://ns.adobe.com/air/extension/51.0"><id>${id}</id>` +
      `<versionNumber>1.0</versionNumber><platforms>` +
      platforms.map((p) => `<platform name="${p}"><applicationDeployment><nativeLibrary>${lib}</nativeLibrary>` +
        `<initializer>ExtInitializer</initializer><finalizer>ExtFinalizer</finalizer></applicationDeployment></platform>`).join('') +
      `</platforms></extension>`, 'utf8');

  // Two DIFFERENT byte strings under one base name: the whole reason a base-name
  // scan is not an acceptable lookup.
  const X64 = Buffer.from('x64-slice-bytes');
  const X86 = Buffer.from('x86-slice-bytes');
  const d = join(root, 'temp', 'anepkg');
  mkdirSync(d, { recursive: true });
  const write = (name: string, buf: Buffer): string => {
    const p = join(d, name);
    writeFileSync(p, buf);
    return p;
  };

  // (a) The official adt layout, signed-package shape, extension.xml nested too.
  const official = write('official.ane', zip([
    ['mimetype', Buffer.from('application/vnd.adobe.air-application-extension')],
    ['META-INF/ANE/extension.xml', EXT_XML],
    ['META-INF/ANE/Windows-x86-64/Pkg.dll', X64],
    ['META-INF/ANE/Windows-x86/Pkg.dll', X86],
  ]));
  const resOfficial = (platform: string): Buffer | string => {
    try {
      const r = resolveAneDescriptors([official], platform);
      return r.staging.get(key(platform)) ?? 'staged-nothing';
    } catch (e) { return `threw: ${String(e)}`; }
  };
  check('an official (META-INF/ANE) package resolves instead of being rejected',
    resOfficial('Windows-x86-64') instanceof Buffer);
  check('…and the Windows-x86-64 slice is the one that comes out',
    String(resOfficial('Windows-x86-64')) === 'x64-slice-bytes');
  check('…targeting Windows-x86 yields the other slice from the SAME package',
    String(resOfficial('Windows-x86')) === 'x86-slice-bytes');
  check('the extensionID is read from the nested extension.xml',
    (() => { try { return resolveAneDescriptors([official], 'Windows-x86').descriptors[0]!.extId === 'com.example.pkg'; }
             catch { return false; } })());

  // (b) The flat layout (extension.xml + lib side by side at the root) still works:
  //     a package produced by a hand-rolled ZIP step is packed this way, and must
  //     keep resolving. (The example fixture used to be one; §4.6 replaced it with
  //     the staging tree, so this layout has no committed example left -- which is
  //     why the pins below synthesize all three shapes instead of borrowing one.)
  const flat = write('flat.ane', zip([['extension.xml', EXT_XML], ['Pkg.dll', X64]]));
  check('the flat package layout keeps resolving',
    (() => { try { return String(resolveAneDescriptors([flat], 'Windows-x86-64').staging.get(key('Windows-x86-64'))) === 'x64-slice-bytes'; }
             catch { return false; } })());

  // (c) The on-disk staging directory adt is fed (`-C Windows-x86-64 .`), in case a
  //     user zips that instead of running adt: <platform>/<lib> at the root.
  const staged = write('staged.ane', zip([['extension.xml', EXT_XML], ['Windows-x86-64/Pkg.dll', X64]]));
  check('a package holding the adt staging directory resolves',
    (() => { try { return String(resolveAneDescriptors([staged], 'Windows-x86-64').staging.get(key('Windows-x86-64'))) === 'x64-slice-bytes'; }
             catch { return false; } })());

  // (d) A package holding ONLY the other platform's slice must NOT resolve for this
  //     one. Falling back to a base-name hit here is how a 32-bit target silently
  //     loads a 64-bit library.
  const wrongOnly = write('wrongonly.ane', zip([
    ['extension.xml', EXT_XML], ['META-INF/ANE/Windows-x86/Pkg.dll', X86],
  ]));
  check('the other platform\'s slice is not silently borrowed',
    (() => { try { resolveAneDescriptors([wrongOnly], 'Windows-x86-64'); return false; }
             catch { return true; } })());

  // (e) When it really is missing, the error must name the paths that were looked
  //     for AND what the ZIP does hold: a wrong-case `META-INF/ANE/` prefix, a ZIP of
  //     only the staging directory, and an empty package are indistinguishable from
  //     "does not contain it" alone.
  const missing = write('missing.ane', zip([
    ['mimetype', Buffer.from('m')], ['META-INF/ANE/extension.xml', EXT_XML],
    ['META-INF/ANE/Windows-x86-64/Other.dll', X64],
  ]));
  const msg = ((): string => {
    try { resolveAneDescriptors([missing], 'Windows-x86-64'); return ''; } catch (e) { return String(e); }
  })();
  check('a missing native library is an error', msg !== '');
  check('…naming all three candidate paths it looked for',
    msg.includes("'Pkg.dll'") && msg.includes("'META-INF/ANE/Windows-x86-64/Pkg.dll'") &&
    msg.includes("'Windows-x86-64/Pkg.dll'"));
  check('…and listing what the package actually holds',
    msg.includes('META-INF/ANE/Windows-x86-64/Other.dll'));

  // (f) The UNPACKED DIRECTORY form, which is what a recompiled package is shipped
  //     as (see src/ane.ts readAne: such a library imports asaot.dll and so has no
  //     consumer AIR could satisfy, and the DoABC in a library.swf is out of scope
  //     anyway -- so the staging tree is the whole artifact and there is no ZIP to
  //     read). Two things are pinned beyond "it opens": the lookup is
  //     platform-scoped through this path too, and entry names are slash-separated,
  //     which on Windows is the difference between matching a candidate and never
  //     matching one (path.join would hand back `Windows-x86-64\Pkg.dll`).
  const dirstage = join(d, 'dirstage');
  const put = (dir: string, rel: string, buf: Buffer | string): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
  };
  put(dirstage, 'extension.xml', EXT_XML);
  put(dirstage, 'Windows-x86-64/Pkg.dll', X64);
  put(dirstage, 'Windows-x86/Pkg.dll', X86);
  const dirSlice = (platform: string): Buffer | string => {
    try { return resolveAneDescriptors([dirstage], platform).staging.get(key(platform)) ?? 'staged-nothing'; }
    catch (e) { return `threw: ${String(e)}`; }
  };
  check('a staging DIRECTORY resolves for Windows-x86-64', String(dirSlice('Windows-x86-64')) === 'x64-slice-bytes');
  check('…and targeting Windows-x86 yields the other slice from the same directory',
    String(dirSlice('Windows-x86')) === 'x86-slice-bytes');
  check('a directory is platform-scoped too: the other slice is not borrowed from it',
    (() => {
      const only = join(d, 'dirwrongonly');
      put(only, 'extension.xml', EXT_XML);
      put(only, 'Windows-x86/Pkg.dll', X86);
      try { resolveAneDescriptors([only], 'Windows-x86-64'); return false; } catch { return true; }
    })());
  // Recursion + slash-normalisation in one: an official package unzipped by hand
  // nests the library two levels down, so a flat readdir (or a backslash address)
  // finds nothing even though the tree is complete.
  check('a hand-unzipped META-INF/ANE tree resolves, so the walk is recursive',
    (() => {
      const nested = join(d, 'dirnested');
      put(nested, 'META-INF/ANE/extension.xml', EXT_XML);
      put(nested, 'META-INF/ANE/Windows-x86-64/Pkg.dll', X64);
      try { return String(resolveAneDescriptors([nested], 'Windows-x86-64').staging.get(key('Windows-x86-64'))) === 'x64-slice-bytes'; }
      catch { return false; }
    })());
  check('a directory with no extension.xml is refused by name',
    (() => {
      const bare = join(d, 'dirbare');
      put(bare, 'Windows-x86-64/Pkg.dll', X64);
      try { resolveAneDescriptors([bare], 'Windows-x86-64'); return false; }
      catch (e) { return /no extension.xml/.test(String(e)) && /dirbare/.test(String(e)); }
    })());
  // The message must be the ANE-prefixed one, not a bare ENOENT from readdirSync:
  // both would "mention it is missing", but only one names the ANE path in the form
  // every other ANE diagnostic uses, and the pin has to tell them apart.
  check('a path that is neither file nor directory says so, ANE-prefixed',
    (() => {
      try { resolveAneDescriptors([join(d, 'nope-ane')], 'Windows-x86-64'); return false; }
      catch (e) { return /ANE '.*nope-ane': no such file or directory/.test(String(e)); }
    })());

  // (g) THE LAYOUT: one directory per extension, two levels deep, named after the
  //     extensionID and the platform. Pinned on the DESCRIPTOR (what the emitted
  //     as_ane_descs[] row carries and the loader joins onto <exeDir>/extensions/)
  //     and on the staged map, because those two drifting apart is exactly the bug
  //     this replaced.
  const one = ((): { desc: string; keys: string[] } => {
    try { const r = resolveAneDescriptors([flat], 'Windows-x86-64'); return { desc: r.descriptors[0]?.nativeLib ?? '<none>', keys: [...r.staging.keys()] }; }
    catch (e) { return { desc: `threw: ${e}`, keys: [] }; }
  })();
  check('the descriptor names the library <extensionID>/<platform>/<lib>',
    one.desc === key('Windows-x86-64'));
  check('…and the staged map is keyed by that same path',
    one.keys.length === 1 && one.keys[0] === key('Windows-x86-64'));
  check('…so nothing is staged under the bare file name any more',
    !one.keys.includes('Pkg.dll'));

  // (h) Two extensions that ship a library of the SAME file name, which is the
  //     defect this layout exists for: before it, both descriptors pointed at one
  //     staged file (the second overwrote the first, and the summary read
  //     "2 extension(s)" beside "1 native library(ies)"), so the first extension
  //     loaded the second's library. AIR keeps them apart -- measured under adl,
  //     where a second package shipping a sentinel under the same file name left the
  //     first extension passing 13/13 -- so this build has to as well.
  const two = ((): AneResolution | string => {
    try {
      return resolveAneDescriptors([
        write('same-a.ane', zip([['extension.xml', extXml('com.example.a')], ['Pkg.dll', X64]])),
        write('same-b.ane', zip([['extension.xml', extXml('com.example.b')], ['Pkg.dll', X86]])),
      ], 'Windows-x86-64');
    } catch (e) { return `threw: ${e}`; }
  })();
  check('two extensions may ship a library of the same file name',
    typeof two !== 'string' && two.descriptors.length === 2);
  check('…each addressed by its own extension directory',
    typeof two !== 'string' &&
    two.descriptors[0]?.nativeLib === key('Windows-x86-64', 'Pkg.dll', 'com.example.a') &&
    two.descriptors[1]?.nativeLib === key('Windows-x86-64', 'Pkg.dll', 'com.example.b'));
  check('…so both libraries are staged, not one',
    typeof two !== 'string' && two.staging.size === 2);
  check('…and each holds its own bytes',
    typeof two !== 'string' &&
    String(two.staging.get(key('Windows-x86-64', 'Pkg.dll', 'com.example.a'))) === 'x64-slice-bytes' &&
    String(two.staging.get(key('Windows-x86-64', 'Pkg.dll', 'com.example.b'))) === 'x86-slice-bytes');

  // (i) A library declared in a SUBDIRECTORY keeps that relative path: flattening it
  //     onto a base name would recreate the collision above, and would rename a file
  //     the extension itself may look for (AIR keeps the declared relative path too).
  check('a library declared in a subdirectory keeps that subdirectory',
    (() => {
      try {
        const sub = resolveAneDescriptors([write('sub.ane', zip([
          ['extension.xml', extXml('com.example.sub', 'libs/Pkg.dll')], ['libs/Pkg.dll', X64],
        ]))], 'Windows-x86-64');
        return sub.descriptors[0]?.nativeLib === key('Windows-x86-64', 'libs/Pkg.dll', 'com.example.sub');
      } catch { return false; }
    })());

  // (j) The count is a HARD limit, not a hint. One descriptor row is one as_anes[]
  //     slot in the generated program (fre.ts ANE_COUNT_MAX), so a 33rd extension has
  //     to be refused while the build can still say so. Measured before this gate: 33
  //     packages compiled, linked, staged and exited 0 with no warning anywhere, and
  //     only failed as an out-of-bounds write on the first createExtensionContext for
  //     the 33rd.
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) =>
    write(`many-${i}.ane`, zip([['extension.xml', extXml(`com.example.many${i}`)], ['Pkg.dll', X64]])));
  const atLimit = ((): string => {
    try { return String(resolveAneDescriptors(many(ANE_COUNT_MAX), 'Windows-x86-64').descriptors.length); }
    catch (e) { return `threw: ${e}`; }
  })();
  check(`exactly ANE_COUNT_MAX (${ANE_COUNT_MAX}) extensions resolve`, atLimit === String(ANE_COUNT_MAX));
  const over = ((): string => {
    try { resolveAneDescriptors(many(ANE_COUNT_MAX + 1), 'Windows-x86-64'); return 'accepted'; }
    catch (e) { return String(e); }
  })();
  check('one more than ANE_COUNT_MAX is refused, not emitted', over !== 'accepted');
  check('…naming the limit, the count it would reach, and the constant to raise',
    /at most 32/.test(over) && /number 33/.test(over) && /ANE_COUNT_MAX in src\/fre\.ts/.test(over));

  console.log(`     [anepkg] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: ane/PackageLayout', checkAnePackageLayout);

// --- The ANE platform key must follow the TARGET, not the build host -----------
// Third measured defect, found while packaging the recompiled WinCore extension for
// both bitnesses: the key used to come from currentAnePlatform(), i.e. from
// process.arch. On an x64 host with `"architecture": "32"` that compiled i686
// objects, linked the x64 asaot.lib, staged the x64 slice of the ANE, and then
// failed at run time -- 64-bit DLL into a 32-bit process. AIR gives a 32-bit captive
// app the x86 runtime, so the key it would use is Windows-x86.
//
// The pins below are the mapping itself. The cross-module one is the important
// kind: the object triple and the ANE key are decided in two different files, and
// a bitness agreement between them is the invariant, not either answer alone.
function checkAnePlatformForBuild(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [aneplat] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [aneplat] ${label}`); }
  };

  const key = (architecture: string, target = 'native', host = 'win32', arch = 'x64') =>
    anePlatformForBuild(architecture, target, host, arch);

  // (a) The defect itself: the manifest's own architecture decides the slice.
  check('architecture "32" on an x64 Windows host resolves Windows-x86', key('32') === 'Windows-x86');
  check('architecture "64" resolves Windows-x86-64', key('64') === 'Windows-x86-64');
  // (b) A 32-bit host building 32-bit agrees with itself -- the branch that worked
  //     by luck before is not the only one that has to stay right.
  check('architecture "32" on an ia32 Windows host is also Windows-x86',
    key('32', 'native', 'win32', 'ia32') === 'Windows-x86');
  // (c) Unchanged defaults: "" means "let clang pick the host default", so the
  //     host's own answer has to survive, and so does the arm64 refusal (AIR has no
  //     Windows ARM64 runtime, so there is no key to invent).
  check('an empty architecture keeps the host answer', key('') === currentAnePlatform('win32', 'x64'));
  check('architecture "arm64" invents no Windows key', key('arm64') === '');
  // (d) `architecture` is inert off a Windows native build (exactly nativeTargetFlags'
  //     condition), which matters because AIR's descriptor default is "32": a macOS
  //     --air-app build carries architecture === '32' and must NOT become Windows-x86.
  check('architecture is inert for a wasm target', key('32', 'wasm') === currentAnePlatform('win32', 'x64'));
  check('architecture is inert on macOS, whose --air-app default is "32"',
    key('32', 'native', 'darwin', 'arm64') === 'MacOS-x86-64' &&
    key('32', 'native', 'darwin', 'x64') === 'MacOS-x86-64');
  check('the macOS arm64 host still gets one architecture-neutral key',
    key('', 'native', 'darwin', 'arm64') === 'MacOS-x86-64');
  check('an explicit override is still the caller\'s business (no key is unreachable)',
    key('64') === 'Windows-x86-64' && key('32') === 'Windows-x86');

  // (e) Cross-module: the same "32" must mean the same bitness in the ANE key and in
  //     the object triple the compiler emits. Two independent readings of one
  //     manifest field drifting apart is precisely how the x64-slice bug appeared.
  const is32 = (t: string) => /i686/.test(t);
  check('"32" gives i686 objects AND Windows-x86 (bitness agrees across modules)',
    key('32') === 'Windows-x86' && is32(windowsTargetTriple('32')));
  check('"64" gives x86_64 objects AND Windows-x86-64',
    key('64') === 'Windows-x86-64' && /x86_64/.test(windowsTargetTriple('64')));

  console.log(`     [aneplat] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: ane/PlatformForBuild', checkAnePlatformForBuild);

// --- the two extension examples share ONE fixture (阶段一百八十四) ---------------
// examples/ane/ and examples/ane-app/ reach the same extension by two different
// routes -- a manifest's `ane-paths` versus a descriptor's `<extensions>` -- and
// they are the before/after pair a reader compares. build-ane.bat compiles
// ProbeANE.c ONCE and copies the result into both trees, with a findstr guard on
// each descriptor, so the two cannot disagree about what com.example.probe is.
//
// Nothing in the build enforces that: they are two independent directories, and a
// fixture tree that lost its descriptor still compiles AND still links -- the only
// symptom is `as_ane_load` failing at run time, on one example, on one platform.
// The edit that will actually happen is one-sided too: adding a `MacOS-...
// <platform>` to make the example runnable on the arm64 CI runner, in one tree.
function checkAneExampleFixtureTrees(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [anefix] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [anefix] ${label}`); }
  };
  const trees = ['ane', 'ane-app'].map((e) => join(root, 'examples', e, 'ext-aot', 'com.example.probe'));
  const xmls = trees.map((t) => join(t, 'extension.xml'));
  const libs = trees.map((t) => join(t, 'Windows-x86-64', 'ProbeANE.dll'));
  const macLibs = trees.map((t) => join(t, 'MacOS-x86-64', 'ProbeANE.dylib'));
  check('both example fixture trees exist', trees.every((t) => existsSync(t)));
  if (!trees.every((t) => existsSync(t))) { return bad; }
  // Byte-identity rather than a semantic comparison: the point is that one compile
  // produced both, and a semantic diff would accept two descriptors that describe
  // subtly different platforms.
  const sameFile = (a: string, b: string): boolean =>
    existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
  check('the two descriptors are byte-identical', sameFile(xmls[0], xmls[1]));
  check('the two native libraries are byte-identical', sameFile(libs[0], libs[1]));
  // The macOS half (阶段二百零三): one compile of the same source by build-ane.sh,
  // staged into both trees just like the DLL. Both artifacts are pinned because both
  // are committed, and a tree that lost only its dylib still compiles and still links
  // on Windows -- the failure is a load error on macOS.
  check('the two macOS dylibs are byte-identical too', sameFile(macLibs[0], macLibs[1]));
  const xml = readFileSync(xmls[0], 'utf8');
  check('...and declare one id, one platform and one library',
    xml.includes('<id>com.example.probe</id>')
    && xml.includes('<platform name="Windows-x86-64">')
    && xml.includes('<nativeLibrary>ProbeANE.dll</nativeLibrary>'));
  check('...plus the macOS platform key and its dylib',
    xml.includes('<platform name="MacOS-x86-64">')
    && xml.includes('<nativeLibrary>ProbeANE.dylib</nativeLibrary>'));;
  // The wiring: each example must resolve to the SAME tree the identity checks
  // above just compared, or those two pins would be pinning a fixture that neither
  // example is built against. Both routes are driven here -- the resolver (what
  // --air-app does with a descriptor's IDs, over the app directory's ext-aot/) and
  // the manifest (what --ane reads) -- so a rename that satisfied only one of them
  // fails rather than half-works.
  const appRoot = join(root, 'examples', 'ane-app', 'ext-aot');
  const resolved = (() => {
    try { return resolveExtensionPackages([appRoot], ['com.example.probe']); }
    catch (e) { return String(e); }
  })();
  check('the descriptor id resolves to the staging tree under the app directory',
    typeof resolved !== 'string' && resolved.get('com.example.probe') === join(appRoot, 'com.example.probe'));
  const manifest = JSON.parse(readFileSync(join(root, 'examples', 'ane', 'ane.build.json'), 'utf8')) as Record<string, unknown>;
  check('ane.build.json points at the same tree',
    JSON.stringify(manifest['ane-paths']) === JSON.stringify(['ext-aot/com.example.probe']));
  const app = parseAirApp(readFileSync(join(root, 'examples', 'ane-app', 'ane-app.xml'), 'utf8'));
  check('the app descriptor declares that same id',
    app.extensionIDs.length === 1 && app.extensionIDs[0] === 'com.example.probe');
  console.log(`     [anefix] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: ane/ExampleFixtureTrees', checkAneExampleFixtureTrees);

// --- the FRE host library's NAME is one decision, not four (阶段二百零三) ---------
//
// Four places need to know what the host library is called: src/index.ts (it copies
// it beside the executable), src/checks.ts (doctor reports whether it is built),
// test/examples.ts (the ane/ane-app skip gate), and each platform's build script.
// They used to answer independently, which worked only because every one of them
// said 'asaot.dll' -- the macOS name is `libasaot.dylib`, and a single stale
// 'asaot.dll' left anywhere turns a runnable example into a SILENT skip (the gate)
// or a copy from a file that is not there (the build). The pins below hold the one
// shared answer together, and hold the C side's two macros in step with it.
function checkAneHostLibrary(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [anehost] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [anehost] ${label}`); }
  };
  const src = (p: string) => readFileSync(join(root, p), 'utf8');
  const throwsWith = (fn: () => unknown, needle: string): boolean => {
    try { fn(); return false; } catch (e) { return String(e).includes(needle); }
  };

  check('aneHostLibName: a Windows key gives the DLL',
    aneHostLibName('Windows-x86-64') === 'asaot.dll' && aneHostLibName('Windows-x86') === 'asaot.dll');
  check('aneHostLibName: the macOS key gives the dylib',
    aneHostLibName('MacOS-x86-64') === 'libasaot.dylib');
  // iOS is named and refused rather than lent the macOS name: lib/bin/ios-arm64/ would
  // hold an archive an application links INTO itself, which no dlopen could load.
  check('aneHostLibName: iOS is refused by name, not guessed at',
    throwsWith(() => aneHostLibName('iPhone-ARM'), 'statically'));
  check('aneHostLibName: an unknown key is refused',
    throwsWith(() => aneHostLibName('Solaris-sparc'), 'no lib/bin/ directory is defined'));
  check('aneHostLibName delegates the directory decision to aneHostDirName',
    throwsWith(() => aneHostLibName('iPhone-ARM'), 'ios-arm64'));

  // One source, four consumers. Each of these three is a place where the name is
  // DERIVED; a literal would pass a grep for the Windows name and then be wrong on
  // macOS, so the pins are on the call rather than on the absence of a literal.
  check('src/index.ts stages the file under the name from src/ane.ts',
    src('src/index.ts').includes('aneHostLibName(aneResolution.platform)')
    && src('src/index.ts').includes('copyFileSync(hostLib, join(dirname(resolve(outPath)), hostName))'));
  check('as-aot doctor probes that same name', src('src/checks.ts').includes('aneHostLibName(platform)'));
  check('the example suite\'s skip gate asks for that same name',
    src('test/examples.ts').includes('aneHostLibName(key)')
    && !src('test/examples.ts').includes('HOST_LIB_NAME'));

  // The C side has to agree with the TypeScript side, or the build copies
  // libasaot.dylib beside the executable and the runtime opens `asaot.dll`.
  const fre = src('src/fre.ts');
  check('the emitted runtime loads the dylib on macOS (macros agree with ane.ts)',
    fre.includes('"libasaot.dylib"') && fre.includes('"asaot.dll"') && fre.includes('"asaot.lib"'));

  // The header's POSIX branch needs the same three modes Windows has: the host TU
  // defines the 51 entry points and the size pass makes them `static`, so a
  // non-static declaration here is a hard error on clang/POSIX but only a warning on
  // Windows -- measured, and the reason the branch went unnoticed.
  const h = src('lib/asaot.h');
  check('asaot.h makes ASAOT_API `static` for the host on POSIX',
    h.includes('#define ASAOT_API static')
    && h.indexOf('#define ASAOT_API static') > h.indexOf('#if defined(_WIN32)'))
  check('asaot.h keeps the attribute for the dylib build on POSIX',
    h.includes('#define ASAOT_API __attribute__((visibility("default")))'));
  check('the measurement behind that branch is recorded, not implied',
    h.includes('follows non-static declaration'));

  // The build scripts, which are the only place a wrong name survives to run time.
  const dylibSh = join(root, 'lib', 'build-asaot.sh');
  const aniSh = join(root, 'examples', 'ane', 'build-ane.sh');
  const execCheck = (label: string, rel: string): void => {
    const exec = recordedExecutable(rel);
    if (exec === null) { console.log(`SKIP  [anehost] ${rel}: no git checkout to read the index mode from`); return; }
    check(label, exec);
  };
  execCheck('lib/build-asaot.sh exists and is executable', 'lib/build-asaot.sh');
  const d = existsSync(dylibSh) ? readFileSync(dylibSh, 'utf8') : '';
  // The install name is what makes the copy beside the executable the one dyld opens:
  // an absolute path baked in at build time would work here and nowhere else.
  check('it bakes the relocatable install name into the dylib',
    d.includes('-install_name @executable_path/libasaot.dylib'));
  check('...and asserts the artifact carries it, rather than trusting the flag',
    d.includes('otool -D') && d.includes('"$NAME" != "@executable_path/libasaot.dylib"'));
  check('it builds both slices (the macOS key encodes no architecture)',
    d.includes('-arch arm64 -arch x86_64') && d.includes('lipo -archs'));

  execCheck('examples/ane/build-ane.sh exists and is executable', 'examples/ane/build-ane.sh');
  const a = existsSync(aniSh) ? readFileSync(aniSh, 'utf8') : '';
  // The same three artifact guards the .bat has, in the macOS spelling: the recipe is
  // identical, and a dylib still importing Adobe AIR builds and links and then fails
  // to load, which is precisely what the guard is for.
  check('build-ane.sh keeps the import guard, the export guard and both trees',
    a.includes("grep -qi 'Adobe AIR'") && a.includes('_ProbeExtInitializer')
    && a.includes('"$EX/ext-aot" "$EX/../ane-app/ext-aot"'));
  check('...and refuses to stage unless the descriptor declares its platform key',
    a.includes(String.raw`<platform name=\"$PLAT\">`));

  // 阶段二百一十: the same two PRE-checks on the Windows recipe. The macOS .sh had
  // them first and the .bat had neither, so a descriptor missing its platform entry
  // was staged silently on Windows and only the packaging step complained. Both ends
  // are pinned here -- the cross-platform rule is "one fix, all branches", and a
  // guard that lives on one end only is exactly the defect shape it exists for.
  const aniBat = join(root, 'examples', 'ane', 'build-ane.bat');
  check('examples/ane/build-ane.bat exists', existsSync(aniBat));
  const nb = existsSync(aniBat) ? readFileSync(aniBat, 'utf8') : '';
  // Named failure, not a linker error: without the pre-check the message for a
  // missing asaot.lib is about a search path, not about the library nobody built.
  check('build-ane.bat pre-checks the host library before linking',
    nb.includes('asaot.lib is not built') && nb.includes('build-asaot.bat first'));
  check('...and its own copy of the descriptor platform-entry guard',
    /findstr \/r \/c:"<platform name=\.%PLAT%\."/.test(nb) && nb.includes('declares no'));
  check('...still staging into both fixture trees',
    nb.includes('"%EX%ext-aot" "%EX%..\\ane-app\\ext-aot"'));

  // Cross-recipe agreement on the one number both guards assert. Writing "53" into
  // two checks in THIS file would still pass with the two recipes disagreeing --
  // which is the very thing the guards exist to prevent -- so the counts are read
  // out of the shell and the batch file and compared to each other.
  const hostBat = readFileSync(join(root, 'lib', 'build-asaot.bat'), 'utf8');
  const shCount = (d.match(/"\$EXPORTS" -ne (\d+)/) || [])[1];
  const batCount = (hostBat.match(/if not "%EXPORTS%"=="(\d+)"/) || [])[1];
  check('both host-library recipes assert the SAME export count',
    shCount !== undefined && shCount === batCount);
  check('...and it is the FRE count (51 entry points + asaot_bind + asaot_is_bound)',
    shCount === '53');
  // Cross-file agreement on the names themselves: the descriptor, the script and the
  // runtime's own dir name all have to say MacOS-x86-64 / ProbeANE.dylib.
  check('the script, the descriptor and ane.ts agree on the macOS key and file',
    a.includes('PLAT="MacOS-x86-64"') && a.includes('LIB="ProbeANE.dylib"')
    && aneHostDirName('MacOS-x86-64') === 'macos-x86-64'
    && existsSync(join(root, 'lib', 'bin', 'macos-x86-64')));

  console.log(`     [anehost] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: ane/HostLibrary', checkAneHostLibrary);

// --- The descriptor's <extensions> block is what says an app NEEDS an extension ---
//
// Found by asking "how are multiple extensions supported?": --air-app read no
// `<extensions>` element at all, so a descriptor naming extensions built green
// with an extension table of zero and nothing on stderr. Measured under adl, the
// same descriptor with an extdir that cannot supply the ID is refused outright
// (`Requested extension com.… could not be found.`, exit 5) — so silence here is a
// §1.5 defect, not a gap to document.
//
// The three decisions these pins encode, each measured before it was chosen:
//   * the ID list comes from the descriptor and is resolved against an extdir —
//     AIR's own split (app.xml names IDs, `-extdir` names the packages);
//   * the search roots default to `ext-aot` then `lib` then `ext-folder`. `ext-aot`
//     is this build's own root for recompiled-for-AOT packages and it is FIRST
//     because an extension's AIR and AOT packages declare one and the SAME
//     <extensionID>, so which one a build uses is decided by root order alone;
//     `--extdir` replaces all three;
//   * resolution is by DECLARED ID, never by "whatever is in the directory" — on a
//     real project `lib/` carries 14 `.ane` files while the descriptor declares 5,
//     and sweeping all of them in aborts on a package the app never asked for.
function checkAirAppExtensions(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [airext] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [airext] ${label}`); }
  };

  // (a) The parser. The commented-out placeholder is the SDK template's own shape
  //     (`<!--<extensionID></extensionID>-->`), so a reader that ignores comments
  //     both invents an empty ID and resurrects an extension a user switched off.
  const ids = (body: string): string[] =>
    parseAirApp(
      `<?xml version="1.0"?>\n<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
        `<id>com.example.a</id><filename>a</filename>\n` +
        `<initialWindow><content>a.swf</content><width>10</width><height>10</height></initialWindow>\n` +
        body +
        `\n</application>\n`
    ).extensionIDs;
  check('a descriptor with no <extensions> declares none', ids('').length === 0);
  check('extensionIDs are read in descriptor order',
    JSON.stringify(ids('<extensions><extensionID>com.b</extensionID><extensionID>com.a</extensionID></extensions>')) ===
      JSON.stringify(['com.b', 'com.a']));
  check('a commented-out extensionID is not requested',
    JSON.stringify(ids('<extensions><!--<extensionID>com.off</extensionID>--><extensionID>com.on</extensionID></extensions>')) ===
      JSON.stringify(['com.on']));
  check('...and the empty placeholder yields no ID',
    JSON.stringify(ids('<extensions>\n<!--<extensionID></extensionID>-->\n<extensionID>com.on</extensionID>\n</extensions>')) ===
      JSON.stringify(['com.on']));
  // An UNcommented empty element is the other way a user clears an extension (a
  // template placeholder edited rather than deleted). Comment-stripping does not
  // reach it, so the empty-body rule has to stand on its own — without it the empty
  // ID is handed to the resolver and the build fails on an extension nobody named.
  check('an uncommented empty extensionID is not an extension either',
    JSON.stringify(ids('<extensions><extensionID></extensionID><extensionID>com.on</extensionID></extensions>')) ===
      JSON.stringify(['com.on']));

  // (b) Resolution. Three shapes are on disk for the same package: the packed `.ane`
  //     (what `adt -package -extdir` is fed), the unpacked tree (what `adl -extdir`
  //     is fed), and the staging tree (what `adt` is fed, and what this project's
  //     recompiled-for-AOT artifact IS). A project that ran its own unzip step has
  //     the first two at once, under the same ID — which is why root order is
  //     load-bearing rather than cosmetic.
  const d = join(root, 'temp', 'air-extdir');
  // Wiped first: this group builds several app directories under here, and a
  // leftover from the previous run would decide checks that mean to read the
  // defaults (a stale `ext-aot/` makes "resolved out of the default lib/" read the
  // package it no longer expects). Measured: without this the group passes once and
  // fails on every run after it.
  rmSync(d, { recursive: true, force: true });
  const rootA = join(d, 'rootA');
  const rootB = join(d, 'rootB');
  const rootC = join(d, 'rootC-absent'); // never created
  const rootD = join(d, 'rootD-staging');
  mkdirSync(rootA, { recursive: true });
  const extensionXml = (id: string): string =>
    `<extension xmlns="http://ns.adobe.com/air/extension/51.0"><id>${id}</id><versionNumber>1.0</versionNumber>` +
    `<platforms><platform name="Windows-x86-64"><applicationDeployment><nativeLibrary>P.dll</nativeLibrary>` +
    `<initializer>I</initializer><finalizer>F</finalizer></applicationDeployment></platform></platforms></extension>`;
  const unpack = (root: string, id: string): void => {
    const meta = join(root, `${id}.ane`, 'META-INF', 'ANE');
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'extension.xml'), extensionXml(id));
  };
  // The packed half is a real package, not a hand-rolled ZIP: probeAneZip() writes a
  // genuine STORE-method .ane with the example fixture's own id/platform/library, so
  // the checks below compare two real packages that declare the SAME extension.
  const probeAne = join(rootA, 'Probe.ane');
  writeFileSync(probeAne, probeAneZip());
  unpack(rootB, 'com.example.probe');
  unpack(rootB, 'com.example.other');
  // Not packages, and therefore not errors: the same directory legitimately holds
  // an unzip helper and documentation (measured: the SDK template's ext-folder
  // ships unzip.exe + unzipane.bat beside the trees).
  writeFileSync(join(rootB, 'unzip.exe'), 'not-a-package');
  writeFileSync(join(rootB, 'notes.txt'), 'not-a-package');

  const resolveIds = (roots: string[], idList: string[]): Map<string, string> | string => {
    try { return resolveExtensionPackages(roots, idList); } catch (e) { return `threw: ${String(e)}`; }
  };
  const one = resolveIds([rootA], ['com.example.probe']);
  check('a packed .ane in an extdir resolves', typeof one !== 'string' && one.get('com.example.probe') === join(rootA, 'Probe.ane'));
  const two = resolveIds([rootB], ['com.example.probe', 'com.example.other']);
  check('an unpacked META-INF/ANE tree in an extdir resolves',
    typeof two !== 'string' &&
    two.get('com.example.probe') === join(rootB, 'com.example.probe.ane') &&
    two.get('com.example.other') === join(rootB, 'com.example.other.ane'));
  // The third shape: the staging tree, `extension.xml` beside its `<platform>/`
  // directories. It has to resolve HERE too, not only through `--ane <tree>` — an
  // extension artifact that the scan cannot see is worse than not supporting it,
  // because the AIR package sitting beside it then wins without a word (measured:
  // the build stages the AIR library, the program loads it, and it dies on
  // `Win32 error 126 … must be recompiled against asaot.lib`).
  const stagedPkg = join(rootD, 'com.example.staged');
  mkdirSync(join(stagedPkg, 'Windows-x86-64'), { recursive: true });
  writeFileSync(join(stagedPkg, 'extension.xml'), extensionXml('com.example.staged'));
  writeFileSync(join(stagedPkg, 'Windows-x86-64', 'P.dll'), 'not-a-real-dll');
  const three = resolveIds([rootD], ['com.example.staged']);
  check('a staging tree (extension.xml beside <platform>/) in an extdir resolves',
    typeof three !== 'string' && three.get('com.example.staged') === stagedPkg);
  // A directory that is not a package still is not one, and is not an error: the
  // SDK template's ext-folder ships helper files (and a stray subdirectory is no
  // different) beside the trees. This is what stops the staging-tree rule above
  // from degenerating into "every directory in the extdir is a package".
  mkdirSync(join(rootD, 'not-a-package'), { recursive: true });
  writeFileSync(join(rootD, 'not-a-package', 'readme.txt'), 'not-a-package');
  const beside = resolveIds([rootD, rootB], ['com.example.staged', 'com.example.probe']);
  check('a non-package directory beside a package is skipped, not an error',
    typeof beside !== 'string' &&
    beside.get('com.example.staged') === stagedPkg &&
    beside.get('com.example.probe') === join(rootB, 'com.example.probe.ane'));
  const both = resolveIds([rootA, rootB], ['com.example.probe']);
  check('the first root wins when both hold the same ID',
    typeof both === 'string' ? false : both.get('com.example.probe') === join(rootA, 'Probe.ane'));
  const onlyB = resolveIds([rootA, rootB], ['com.example.other']);
  check('...and a later root still supplies an ID the first one lacks',
    typeof onlyB === 'string' ? false : onlyB.get('com.example.other') === join(rootB, 'com.example.other.ane'));

  // The directory-driven reading this refuses: `com.example.other` sits in the same
  // root and is NOT asked for, so it must not come back. Getting this wrong is the
  // measured real-project failure — its lib/ holds 14 `.ane` files beside a
  // descriptor that names 5, and sweeping them all in aborts on a package the app
  // never requested.
  const declaredOnly = resolveIds([rootB], ['com.example.probe']);
  check('a package the descriptor does not name is not returned',
    typeof declaredOnly !== 'string' && declaredOnly.size === 1);

  // The diagnosis. adl's own sentence, plus what was searched and what was there:
  // "could not be found" alone cannot distinguish a typo'd --extdir from an empty
  // directory from an ID that is simply misspelled in the descriptor.
  const miss = resolveIds([rootA, rootB, rootC], ['com.example.probe', 'com.example.absent']);
  check('a declared ID with no package is refused, not skipped', typeof miss === 'string');
  check('...in adl\'s own wording', typeof miss === 'string' && miss.includes('Requested extension com.example.absent could not be found.'));
  check('...naming every directory that was searched, and the absent one as absent',
    typeof miss === 'string' && miss.includes(rootA) && miss.includes(rootB) && miss.includes(`${rootC} (absent)`));
  check('...listing what those directories do offer',
    typeof miss === 'string' && miss.includes('com.example.probe <-') && miss.includes('com.example.other <-'));
  check('...and naming both ways out (drop the package in, or --extdir)',
    typeof miss === 'string' && miss.includes('--extdir <dir>'));
  // All THREE shapes readAne accepts, not the two the AIR SDK template ships. The
  // staging tree (`<dir>/extension.xml` beside its `<platform>/` libraries) is what
  // a recompiled-for-AOT extension IS (docs/zh-cn/ane.md §4.6), so a hint that
  // omits it stops naming the way out for exactly the user most likely to read it.
  check('...and naming all three package shapes, staging tree included',
    typeof miss === 'string'
    && miss.includes('<dir>/META-INF/ANE/extension.xml')
    && miss.includes('<dir>/extension.xml'));

  // (c) The adapter: the descriptor's IDs, the resolved paths, and the manifest.
  //     Driven through prepareAirApp rather than the helper alone, because the
  //     ordering and the manifest-relative spelling are decided there.
  const appDir = join(d, 'app');
  mkdirSync(join(appDir, 'src'), { recursive: true });
  mkdirSync(join(appDir, 'lib'), { recursive: true });
  writeFileSync(join(appDir, 'lib', 'Probe.ane'), probeAneZip());
  writeFileSync(join(appDir, 'src', 'Main.as'),
    'package {\n  import flash.display.Sprite;\n' +
    '  public class Main extends Sprite {\n    public function Main() {}\n  }\n}\n');
  const appXml = (extBlock: string): string => {
    const p = join(appDir, 'ext-app.xml');
    writeFileSync(p,
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<application xmlns="http://ns.adobe.com/air/application/51.3">\n` +
      `  <id>com.example.extapp</id><versionNumber>1.0</versionNumber>\n  <filename>extapp</filename>\n` +
      `  <architecture>64</architecture>\n` +
      `  <initialWindow><content>extapp.swf</content><visible>true</visible><width>400</width><height>300</height></initialWindow>\n` +
      extBlock + `\n</application>\n`);
    return p;
  };
  const vendorAbs = resolve(root, 'vendor');
  const manifestOf = (xmlPath: string, extDirs: string[] = []): Record<string, unknown> | string => {
    try {
      const prep = prepareAirApp(xmlPath, 'Main', vendorAbs, false, null, null, false, extDirs);
      return JSON.parse(readFileSync(prep.manifestPath, 'utf8')) as Record<string, unknown>;
    } catch (e) { return `threw: ${String(e)}`; }
  };

  const withExts = manifestOf(appXml('<extensions><extensionID>com.example.probe</extensionID></extensions>'));
  check('the adapter resolves the declared ID out of the default lib/',
    typeof withExts !== 'string' && JSON.stringify(withExts['ane-paths']) === JSON.stringify(['lib/Probe.ane']));
  // Manifest-relative, slash-separated: the manifest sits in the app directory, and
  // a Windows-style `lib\\Probe.ane` would not resolve on the path-join side.
  check('...written manifest-relative and slash-separated',
    typeof withExts === 'string' || !String((withExts['ane-paths'] as string[])[0]).includes('\\'));
  const noExts = manifestOf(appXml(''));
  check('a descriptor with no <extensions> gets no ane-paths key at all',
    typeof noExts !== 'string' && noExts['ane-paths'] === undefined);

  const missing = manifestOf(appXml('<extensions><extensionID>com.example.probe</extensionID><extensionID>com.example.absent</extensionID></extensions>'));
  check('--air-app refuses a declared extension it cannot locate (no silent empty table)',
    typeof missing === 'string' && missing.includes('Requested extension com.example.absent could not be found.'));

  // `ext-aot`, and why it is searched FIRST. An app that is being moved onto this
  // build has, for every migrated extension, an AIR package in `lib/` and a
  // recompiled one — and the two declare the SAME <extensionID>, on purpose: the app
  // must not need a source change to switch which build it runs under. So root order
  // is the entire selection mechanism, and it has to be an explicitly named
  // directory rather than a name-sort accident inside `lib/`. The AIR originals stay
  // untouched where `adl` and `adt` look for them.
  const aotDir = join(appDir, 'ext-aot');
  const aotPkg = join(aotDir, 'zz-probe-recompiled');
  mkdirSync(join(aotPkg, 'Windows-x86-64'), { recursive: true });
  writeFileSync(join(aotPkg, 'extension.xml'), extensionXml('com.example.probe'));
  writeFileSync(join(aotPkg, 'Windows-x86-64', 'ProbeANE.dll'), 'recompiled-for-aot');
  // The name sorts AFTER `Probe.ane`, so only root order can make this win — a
  // same-root name sort would hand the build the AIR package.
  const withAot = manifestOf(appXml('<extensions><extensionID>com.example.probe</extensionID></extensions>'));
  check('a staging tree in ext-aot wins over the AIR package of the same ID in lib/',
    typeof withAot !== 'string' && JSON.stringify(withAot['ane-paths']) === JSON.stringify(['ext-aot/zz-probe-recompiled']));
  unpack(aotDir, 'com.example.other');
  const mixAot = manifestOf(appXml('<extensions><extensionID>com.example.probe</extensionID><extensionID>com.example.other</extensionID></extensions>'));
  check('...while an ID ext-aot does not hold still comes from lib/, not from nowhere',
    typeof mixAot !== 'string' &&
    JSON.stringify(mixAot['ane-paths']) === JSON.stringify(['ext-aot/zz-probe-recompiled', 'ext-aot/com.example.other.ane']));

  // --extdir replaces the defaults outright rather than adding to them: a project
  // that keeps its packages elsewhere says so once, and a stale lib/ must not then
  // still be consulted.
  const elsewhere = join(d, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'Probe.ane'), probeAneZip());
  const byExtdir = manifestOf(appXml('<extensions><extensionID>com.example.probe</extensionID></extensions>'), [elsewhere]);
  check('--extdir is where the package is looked for',
    typeof byExtdir !== 'string' &&
    String((byExtdir['ane-paths'] as string[])[0]).includes('elsewhere') &&
    !String((byExtdir['ane-paths'] as string[])[0]).startsWith('lib/'));
  const extdirButNoExts = manifestOf(appXml(''), [elsewhere]);
  check('--extdir with a descriptor that declares no <extensions> is refused, not ignored',
    typeof extdirButNoExts === 'string' && extdirButNoExts.includes('declares no <extensions>'));

  // The ID list is the descriptor's, so the ORDER is too: the emitted as_ane_descs[]
  // table is built from this array, and a root-scan order would reorder an app's
  // extensions whenever a filename changed.
  writeFileSync(join(appDir, 'lib', 'Zzz.ane'), probeAneZip());
  const orderXml = appXml('<extensions><extensionID>com.example.other</extensionID><extensionID>com.example.probe</extensionID></extensions>');
  const ordered = manifestOf(orderXml, [rootB, join(appDir, 'lib')]);
  check('ane-paths follows descriptor order, not the scan order',
    typeof ordered !== 'string' &&
    String((ordered['ane-paths'] as string[])[0]).includes('com.example.other') &&
    String((ordered['ane-paths'] as string[])[1]).includes('com.example.probe'));

  // (d) Structural: everything above calls the adapter with an explicit --extdir
  //     list, so none of it would notice the CLI never handing one over, or
  //     accepting --extdir where it means nothing (--extdir names where a
  //     DESCRIPTOR's <extensions> packages live; without --air-app there is no
  //     descriptor, and accepting it would look honoured while contributing
  //     nothing).
  const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const callSite = /prepareAirApp\([^;]*?\);/s.exec(indexSource)?.[0] ?? '';
  check('the CLI hands the --extdir list to the adapter', callSite.includes('opts.extDirs'));
  // Behavioural, not a grep: the guard's own message survives any change to the
  // condition in front of it, so only running the CLI can tell whether the flag is
  // actually refused without --air-app. It fires in argument parsing — before any
  // input is read — so the input path below never has to be buildable.
  const cli = spawnSync(process.execPath,
    [join(root, 'src', 'index.ts'), join(root, 'examples', 'ane', 'driver.as'), '--extdir', elsewhere, '-o', join(d, 'cli-probe.exe')],
    { cwd: root, encoding: 'utf8', timeout: 60000 });
  const cliText = String(cli.stdout ?? '') + String(cli.stderr ?? '');
  check('--extdir without --air-app exits non-zero', cli.status !== 0);
  check('...naming where it does apply and what to use instead',
    cliText.includes('--extdir only applies to --air-app') && cliText.includes('--ane <package>'));

  console.log(`     [airext] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: air-app/Extensions', checkAirAppExtensions);

// --- the Windows OFFSCREEN link set (阶段一百八十四) ----------------------------
// A `<visible>false</visible>` app has no window, but it is not a smaller build:
// `skia_glue.cc` is compiled into EVERY native app, and the GDI font manager it
// registers is reached by `SkFontMgr::Factory()` before any pixel is drawn --
// CreateCompatibleDC / ExtTextOutW / GetGlyphOutlineW / GetFontUnicodeRanges
// (18 unresolved symbols, measured) live in gdi32, `SystemParametersInfoA` in
// user32, and the COM/registry calls behind the GDI fallback in ole32/advapi32.
// Those four sat in the `visible` branch, so the offscreen build failed to LINK on
// Windows while its macOS twin -- which reaches GDI nowhere and resolves the whole
// font stack through CoreText -- linked fine. No macOS CI run could see it, so the
// pin drives `airManifest` with `process.platform` faked, which is the only way to
// exercise the Windows branch from either host (the same lever build/VendorLayout
// uses, and the reason both defects were reachable only by running the real
// pipeline with the platform faked).
function checkAirAppOffscreenLinkSet(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [offscreen] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [offscreen] ${label}`); }
  };
  // visible=false, resizable/highDpi inert, no Stage3D, no fonts, no networking,
  // no audio, x64. Every argument is explicit so the assertion set below is the
  // whole manifest rather than a slice of it.
  //
  // `arch` is faked too, not only `platform`: air-app.ts resolves the vendor key
  // from BOTH (nonWindowsVendorKey), so a darwin platform on this x64 host used
  // to ask for `macos-x64` -- a tree vendor/ does not ship -- and threw
  // "no prebuilt dependency tree for this host" out of the group.
  const realPlatform = process.platform;
  const realArch = process.arch;
  const offscreen = (platform: string, arch: string): Record<string, unknown> => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: platform === 'darwin' ? 'arm64' : 'x64', configurable: true });
    try {
      return airManifest('vendor', false, true, false, false, 'auto', false, false,
        [], [], [], [], false, false, arch) as Record<string, unknown>;
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    }
  };
  const win = offscreen('win32', '64');
  const winLibs = win['link-libs'] as string[];
  const winSrc = win['sources'] as string[];
  const winDef = win['defines'] as string[];
  check('offscreen is still a Skia build (the rasterizer, not a window)',
    winSrc.indexOf('vendor/skia_glue.cc') >= 0 && winDef.indexOf('ASC_USE_SKIA=1') >= 0);
  check('...with no window and no GPU window backend compiled in',
    winDef.indexOf('ASC_USE_WINDOW=1') < 0 && winSrc.indexOf('vendor/window_glue.cc') < 0
    && winDef.indexOf('ASC_RENDER_WINGPU=1') < 0);
  check('...and it still links skia_glue.cc\'s GDI font manager (gdi32/user32)',
    winLibs.indexOf('gdi32') >= 0 && winLibs.indexOf('user32') >= 0);
  check('...plus the COM/registry entry points behind the GDI fallback',
    winLibs.indexOf('ole32') >= 0 && winLibs.indexOf('advapi32') >= 0);
  check('...and the Uniscribe shaper it shapes text with', winLibs.indexOf('usp10') >= 0);
  check('...and the Windows zlib our generated C calls, with no transport',
    winLibs.indexOf('z') >= 0 && winDef.indexOf('ASC_HAVE_CURL=1') < 0);
  // The window-only half must NOT be dragged in: a headless build that links SDL2
  // is a headless build that lied (and on Windows SDL2-static pulls a second,
  // unrequested Win32 import set).
  check('...and none of the window-only link set (SDL2/window/D3D)',
    ['SDL2', 'winmm', 'imm32', 'oleaut32', 'version', 'uuid', 'setupapi', 'shell32',
     'dinput8', 'd3d12', 'dxgi', 'd3dcompiler', 'd3d12allocator', 'curl', 'nghttp2']
      .every((l) => winLibs.indexOf(l) < 0));
  // The macOS twin: same shape, and GDI is not merely unused but absent -- a
  // `user32` here would be an lld-link "ignoring unknown argument" warning away
  // from a silent no-op.
  const mac = offscreen('darwin', '64');
  const macLibs = mac['link-libs'] as string[];
  check('the macOS offscreen build keeps its CoreText/CoreGraphics frameworks',
    (mac['frameworks'] as string[]).indexOf('CoreText') >= 0);
  check('...and carries none of the Windows system import libs',
    macLibs.indexOf('gdi32') < 0 && macLibs.indexOf('user32') < 0 && macLibs.indexOf('usp10') < 0);
  check('the platform fake was undone', process.platform === realPlatform && process.arch === realArch);
  console.log(`     [offscreen] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: air-app/OffscreenLinkSet', checkAirAppOffscreenLinkSet);
// --- vendor/skia 本地补丁的出处守卫（阶段一百六十七）------------------------
// The macOS arm64 libskia.a we ship is NOT the upstream prebuilt: it is compiled
// from build-tools/skia-src with the patch below applied. Nothing in this repo can
// verify a binary's internals, so what we pin is PROVENANCE — the patch file that
// documents the change must exist, must still carry both halves of the fix, must
// target the file it claims, and must be referenced by the doc that explains it.
// Losing that trail is how a future "rebuild skia from a clean tree" silently
// reintroduces the CoreText face switch.
function checkSkiaLocalPatch(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [skia-patch] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [skia-patch] ${label}`); }
  };
  const patchPath = join(root, 'vendor', 'skia', 'patches', 'skia-m124-ct-exact-copy-keep-face.patch');
  check('the local patch file exists', existsSync(patchPath));
  if (!existsSync(patchPath)) { return bad; }
  const patch = readFileSync(patchPath, 'utf8');
  // 1) Both halves of the fix: the file-identity helper and its use as the guard.
  check('the patch defines the file-identity helper', patch.includes('sk_fonts_share_file(CTFontRef a, CTFontRef b)'));
  check('the patch keeps the base face when the copy switched files',
    patch.includes('!sk_fonts_share_file(baseFont, copy.get())')
    && patch.includes('CTFontCreateCopyWithAttributes(baseFont, textSize, nullptr, nullptr)'));
  // 2) It must land on the CoreText per-size copy, not on the shaper (the bug is
  //    "the rasterizer's face changed", see docs/zh-cn/skia.md §6.9).
  check('the patch targets SkCTFontCreateExactCopy.cpp',
    patch.includes('a/src/utils/mac/SkCTFontCreateExactCopy.cpp'));
  check('the patch carries the stage marker', patch.includes('阶段一百六十七'));
  // 3) Doc/patch must not drift apart: the doc is the only place a human learns
  //    that this library needs a patch at all.
  const doc = readFileSync(join(root, 'docs', 'zh-cn', 'skia.md'), 'utf8');
  check('docs/zh-cn/skia.md points at the patch',
    doc.includes('skia-m124-ct-exact-copy-keep-face.patch'));
  console.log(`[skiapatch] ${ok} skia local-patch checks passed`);
  return bad;
}

registerGroup('unit: build/SkiaLocalPatch', checkSkiaLocalPatch);

// ---- vendor layout: one path rule for every package (阶段一百八十) ----
// The vendor tree had exactly one exception: SDL2 kept its archives AND headers in
// `<pkg>/<platform>/{lib,include}`, and its macOS key was the bare, OS-less `arm64`,
// while Skia and curl were `<pkg>/lib/<platform>`. The asymmetry is invisible until
// someone builds on the other host — a stale path fails to link on ONE platform, on
// the machine of whoever pulls next — so it is pinned three ways: the tree on disk,
// the manifest `--air-app` emits (on both hosts), and every checked-in manifest.
//
// The rule a package must satisfy: its direct children are KIND directories, and a
// platform key only ever appears UNDER a kind — `lib/<platform>/`, or
// `include/<platform>/` when the headers are generated per platform (only SDL2:
// SDL_config.h names the host's subsystems, while Skia's and curl's headers are
// byte-identical across platforms, where a second copy could only drift).
function checkVendorLayout(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log('PASS  [vendorl] ' + label); }
    else { bad.push(label); console.log('FAIL  [vendorl] ' + label); }
  };
  const KINDS = ['lib', 'include', 'licenses', 'bin', 'share'];
  // True when a path mentions the package but does not go through a kind dir,
  // i.e. the retired `vendor/sdl2/<platform>/…` shape. String surgery rather than
  // a regex so the pin reads the same as the rule it encodes.
  const retired = (p: string): boolean => {
    const at = p.indexOf('vendor/sdl2/');
    if (at < 0) return false;
    const first = p.slice(at + 'vendor/sdl2/'.length).split('/')[0];
    return KINDS.indexOf(first) < 0;
  };

  const sdl2 = join(root, 'vendor', 'sdl2');
  const top = readdirSync(sdl2, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  check('vendor/sdl2 holds only kind directories, no platform one', top.every((e) => KINDS.indexOf(e) >= 0));
  const platforms = existsSync(join(sdl2, 'lib'))
    ? readdirSync(join(sdl2, 'lib'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  check('vendor/sdl2 still vendors at least one platform', platforms.length > 0);
  check('platform keys carry their OS prefix (never a bare "arm64")',
    platforms.every((p) => p.indexOf('windows-') === 0 || p.indexOf('macos-') === 0));
  check('every vendored platform has BOTH a lib/ and an include/ directory',
    platforms.every((p) => existsSync(join(sdl2, 'lib', p)) && existsSync(join(sdl2, 'include', p))));
  // Not vacuous: the archives and headers are really where the rule says.
  const archives = ['SDL2.lib', 'SDL2-static.lib', 'libSDL2.a', 'libSDL2main.a'];
  check('an SDL2 archive really sits in lib/<platform>/',
    platforms.some((p) => readdirSync(join(sdl2, 'lib', p)).some((f) => archives.indexOf(f) >= 0)));
  check('and its headers really sit in include/<platform>/SDL2/',
    platforms.every((p) => existsSync(join(sdl2, 'include', p, 'SDL2', 'SDL.h'))));
  check('the license is shared, not per platform',
    existsSync(join(sdl2, 'licenses', 'SDL2', 'LICENSE.txt')));

  // `--air-app` is the only consumer of these paths and it derives the platform key
  // from `process.platform`, so the key is faked to check BOTH hosts from one
  // machine: the key is precisely what used to differ, and leaving macOS unchecked
  // would pin nothing on a Windows box (and vice versa).
  const realPlatform = process.platform;
  const realHostArch = process.arch;
  const nativePaths = (arch: string): string[] => {
    const m = airManifest('vendor', true, true, true, false, 'auto', false, true,
      [], [], [], [], true, false, arch) as Record<string, unknown>;
    return [...(m['include-paths'] as string[]), ...(m['link-paths'] as string[])];
  };
  // The same call with `usesNetworking = false`, returning the INCLUDE list alone.
  // src/runtime.ts `#include <zlib.h>`s in EVERY native build, and on Windows
  // neither that header nor the unprefixed `z` exists outside curl's dependency
  // stack (`vendor/provision/windows.ps1` builds both into curl/); macOS reaches
  // the system <zlib.h> and needs neither. So on Windows the include dir belongs to
  // the build, not to the transport -- emitting only the `-L` (what this did until
  // 阶段一百八十四) left every non-networking Windows app failing at
  // `#include <zlib.h>` while the arm64 macOS CI runner, whose system header serves
  // it, stayed green.
  const nonNetIncludes = (arch: string): string[] => {
    const m = airManifest('vendor', true, true, true, false, 'auto', false, true,
      [], [], [], [], false, false, arch) as Record<string, unknown>;
    return m['include-paths'] as string[];
  };
  const expectHost = (host: string, platform: string, key: (arch: string) => string): void => {
    const realArch = process.arch;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    // The vendor key is derived from platform AND arch (build.ts
    // nonWindowsVendorKey), so an x64 build host faking `darwin` alone asks for
    // macos-x64 -- absent from vendor/ -- and throws instead of checking.
    Object.defineProperty(process, 'arch', { value: platform === 'darwin' ? 'arm64' : 'x64', configurable: true });
    try {
      for (const arch of ['64', '32']) {
        const k = key(arch);
        const p = nativePaths(arch);
        const tag = host + ' arch=' + arch;
        check(tag + ': SDL2 archives resolve under lib/<platform>', p.indexOf('vendor/sdl2/lib/' + k) >= 0);
        check(tag + ': SDL2 headers resolve under include/<platform>', p.indexOf('vendor/sdl2/include/' + k) >= 0);
        check(tag + ': Skia and curl use the same lib/<platform> shape',
          p.indexOf('vendor/skia/lib/' + k) >= 0 && p.indexOf('vendor/curl/lib/' + k) >= 0);
        check(tag + ': no retired <pkg>/<platform>/ path remains', !p.some(retired));
        // curl's lib dir is wanted for two INDEPENDENT reasons on Windows (the
        // standard zlib our generated C calls, and the network transport); the
        // emitted lists are sets, so it must appear once.
        check(tag + ': the path lists carry no duplicate entry', new Set(p).size === p.length);
        // The zlib half of the curl tree follows the HEADER, not the transport: on
        // Windows it is wanted with the network switched off (see nonNetIncludes),
        // and on macOS it must NOT be there -- pushing it would link the vendored
        // curl headers ahead of the system ones for an app that never asked for
        // curl, i.e. an unrequested toolchain swap.
        const inc = nonNetIncludes(arch);
        check(tag + ': the zlib include dir follows the header, not the transport',
          host === 'windows' ? inc.indexOf('vendor/curl/include') >= 0 : inc.indexOf('vendor/curl/include') < 0);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    }
  };
  expectHost('windows', 'win32', (a) => 'windows-' + (a === '32' ? 'x86' : 'x64'));
  expectHost('macos', 'darwin', () => 'macos-arm64');
  check('the platform fake was undone', process.platform === realPlatform && process.arch === realHostArch);

  // Checked-in manifests — hand-written examples and `--air-app` snapshots alike.
  const manifests: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(join(d, e.name)); }
      else if (e.name.indexOf('.build.') >= 0 && e.name.endsWith('.json')) manifests.push(join(d, e.name));
    }
  };
  walk(join(root, 'examples'));
  const offenders: string[] = [];
  const re = new RegExp('vendor/sdl2/([A-Za-z0-9_.-]+)', 'g');
  for (const f of manifests) {
    const text = readFileSync(f, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (KINDS.indexOf(m[1]) < 0) offenders.push(f.slice(root.length + 1) + ' -> ' + m[1]);
    }
  }
  check('all ' + manifests.length + ' example manifests use the kind-directory shape', offenders.length === 0);
  if (offenders.length > 0) console.log('  ' + offenders.join('\n  '));
  console.log('[vendorl] ' + ok + ' vendor-layout checks passed');
  return bad;
}

registerGroup('unit: build/VendorLayout', checkVendorLayout);

// ---- the two-half Skia glue: graphics vs text engine (阶段二百二十一) ----
// The split is not cosmetic: it is the ONLY way a build can drop the shaping stack.
// An object file is linked whole, so while both halves shared vendor/skia_glue.o,
// every Skia program resolved skia::textlayout::* and therefore pulled
// libskparagraph -> libskunicode -> libharfbuzz -> libicu, whose data is a single
// 9.71 MB object. Measured before/after on the same no-text program:
// 19.43 MB -> 6.53 MB. These pins keep the two halves from drifting back together
// and keep the source/define decisions from separating (either one alone is a lie:
// glue without the define = dead weight, define without the glue = undefined symbol).
function checkTextEngineSplit(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [textsplit] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [textsplit] ${label}`); }
  };
  const gfx = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  const txt = readFileSync(join(root, 'vendor', 'skia_text_glue.cc'), 'utf8');
  const hdr = readFileSync(join(root, 'vendor', 'skia_glue_internal.h'), 'utf8');

  // (1) The invariant that makes the split worth anything: the graphics half must
  // reference NOTHING from SkParagraph. A single include or a single
  // skia::textlayout:: use puts the whole shaping stack back into every build.
  check('the graphics half includes no skparagraph header',
    !gfx.includes('modules/skparagraph'));
  // ...and only the file COMMENT may name it (it explains the split); no code.
  const gfxCode = gfx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('the graphics half uses no skparagraph type',
    !/skia::textlayout::/.test(gfxCode));

  // (2) Every seam entry point lives in the text half -- the 15-function seam the
  // generated C calls (docs/zh-cn/rust-text-backend.md §1.1) plus the two direct
  // draw paths that bypass the paragraph.
  const seam = [
    'sk_text_measure', 'sk_text_measure_n',
    'sk_textlayout_new', 'sk_textlayout_new_leading', 'sk_textlayout_new_runs',
    'sk_textlayout_height', 'sk_textlayout_max_width', 'sk_textlayout_line_metrics',
    'sk_textlayout_line_box', 'sk_textlayout_line_count', 'sk_textlayout_paint',
    'sk_textlayout_delete', 'sk_textlayout_glyph_position_at',
    'sk_textlayout_rects_for_range', 'sk_textlayout_caret_rect',
    'sk_canvas_draw_text', 'sk_canvas_draw_text_n',
  ];
  const missing = seam.filter((n) => !new RegExp(`^(void|double|int)\\*?\\s+${n}\\(`, 'm').test(txt));
  check('the text half defines all 16 text seam entry points', missing.length === 0);
  if (missing.length > 0) console.log('  missing: ' + missing.join(', '));

  // (3) The one symbol BOTH halves need stays in the graphics half: the SVG
  // rasterizer hands the platform font manager to SkSVGDOM, and the web build's
  // EXPORTED_FUNCTIONS always names _sk_fontmgr_register_data (which mutates the
  // same cache) -- a no-text web build must still link. Declared in the header
  // with C++ linkage because the return type is sk_sp<SkFontMgr>.
  check('the shared platform font manager stays in the graphics half',
    gfx.includes('sk_sp<SkFontMgr> sk_platform_fontmgr() {') &&
    !txt.includes('sk_sp<SkFontMgr> sk_platform_fontmgr() {'));
  check('...and is declared once for the text half', hdr.includes('sk_sp<SkFontMgr> sk_platform_fontmgr();'));
  check('the web font-injection entry point stays in the graphics half',
    gfx.includes('int sk_fontmgr_register_data(const void* data, int len)') &&
    buildWebCompileSteps({ ...defaultBuildConfig(), target: 'wasm', package: 'web' }, 'x.c', 'x')
      .some((s) => s.some((a) => a.includes('_sk_fontmgr_register_data'))));

  // (4) The seam has exactly two implementations, chosen by ASC_HAVE_TEXT.
  check('the runtime seam is gated on ASC_HAVE_TEXT',
    RUNTIME_PREAMBLE.includes('#ifdef ASC_HAVE_TEXT') && RUNTIME_PREAMBLE.includes('#else'));
  check('the no-engine arm is a no-op that warns instead of failing silently',
    RUNTIME_PREAMBLE.includes('static inline void as_text_engine_absent(void)') &&
    RUNTIME_PREAMBLE.includes('flash.text is not linked into this build'));
  check('the real arm is the only place the seam calls the glue',
    !/#ifndef ASC_HAVE_TEXT[\s\S]{0,4000}sk_textlayout_new\(/.test(RUNTIME_PREAMBLE.split('#else')[0]));

  // (5) index.ts decides the source and the define together, and says which way.
  const idx = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  check('the build adds the text glue AND its define in the same branch',
    /if \(manifestWantsText \|\| programUsesText\) \{[\s\S]{0,600}?cfg\.sources\.push\(resolve\(vendorDir, 'skia_text_glue\.cc'\)\)[\s\S]{0,300}?cfg\.defines\.push\('ASC_HAVE_TEXT'\)/.test(idx));
  check('the decision is reported, not silent', idx.includes('flash.text: text engine linked') &&
    idx.includes('flash.text: no text in this program'));
  check('a manifest that names the text glue always wins',
    idx.includes("const manifestWantsText = cfg.sources.some((p) => nameOf(p) === 'skia_text_glue.cc');"));
  check('the SWC bake counts as a text user (its text characters are real TextFields)',
    idx.includes("(swcBake?.characters ?? []).filter((c) => c.kind === 'text').length"));

  console.log(`     [textsplit] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: build/TextEngineSplit', checkTextEngineSplit);

// ---- link-time trimming + the small ICU data set (阶段二百二十二) ----------------
// Two levers that shave what a Skia build ends up carrying WITHOUT touching text
// semantics (docs/zh-cn/rust-text-backend.md §3 L1/L2a). Both are measured, and
// both have a failure mode that is invisible at compile time, hence the pins:
//
//   L1 (`-Wl,-dead_strip -Wl,-x`) is only worth anything if it reaches the link
//   command, and it must NOT reach it when the user asked for symbols.
//
//   L2a works by DEFINING `_icudtNN_dat` in our own object so the archive member
//   holding the 10.19 MB default data set is never pulled. Two things must hold
//   or the build silently pays the 9.4 MB again: the object has to precede the -l
//   flags, and the .o has to be the small data set (the vendored .dat is the pin).
function checkLinkTrim(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [trim] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [trim] ${label}`); }
  };
  const darwin = process.platform === 'darwin';
  const text = (): BuildConfig => ({
    ...defaultBuildConfig(),
    cCompiler: 'clang',
    sources: [join(root, 'vendor', 'skia_glue.cc'), join(root, 'vendor', 'skia_text_glue.cc')],
    defines: ['ASC_USE_SKIA=1', 'ASC_HAVE_TEXT'],
    linkLibs: ['skia', 'skunicode', 'icu'],
  });
  const linkStep = (cfg: BuildConfig): string[] => {
    const steps = buildCompileSteps(cfg, 'x.c', 'x.out');
    return steps[steps.length - 1];
  };

  // (1) The flags themselves. Both sides are asserted, not just the macOS one:
  // the flags are Mach-O ld flags (see build.ts), so a non-darwin link must get
  // NONE of them -- emitting them there is a hard linker error, and "we are not on
  // macOS so we cannot check" is how that shipped once already.
  check(`link trimming is ${darwin ? 'applied on Mach-O' : 'OFF on this host (its ld does not know -dead_strip)'}`,
    JSON.stringify(linkTrimFlags({ ...defaultBuildConfig() })) ===
      JSON.stringify(darwin ? ['-Wl,-dead_strip', '-Wl,-x'] : []));
  check('--debug-info keeps its local symbols (dead_strip still applies)',
    JSON.stringify(linkTrimFlags({ ...defaultBuildConfig(), debugInfo: true })) ===
      JSON.stringify(darwin ? ['-Wl,-dead_strip'] : []));
  check('wasm links are untouched (its own --strip-debug covers it)',
    JSON.stringify(linkTrimFlags({ ...defaultBuildConfig(), target: 'wasm' })) === JSON.stringify([]));

  // (2) They actually reach the command, and the ICU object lands before every -l.
  const link = linkStep(text());
  check('the trim flags reach the real link command',
    !darwin || (link.includes('-Wl,-dead_strip') && link.includes('-Wl,-x')));
  // The ICU data object only exists on a Mach-O link (it is Mach-O assembly
  // defining `_icudtNN_dat`), so on any other host the invariant is the mirror
  // image: the link carries no such object at all instead of half of the scheme.
  const objAt = link.findIndex((a) => a.endsWith('icudtl_flutter.o'));
  const firstL = link.findIndex((a) => a === '-l');
  check(darwin ? 'the ICU data object precedes the archive flags'
               : 'no Mach-O ICU data object on a non-Mach-O link',
    darwin ? objAt > 0 && firstL > objAt : objAt < 0);
  check('the single-command (pure C) path trims too',
    !darwin || buildCompileCommand({ ...defaultBuildConfig(), target: 'native' }, 'x.c', 'x.out').includes('-Wl,-dead_strip'));

  // (3) The object is only built when something consumes it. The gate is
  // ASC_HAVE_TEXT, NOT "the manifest lists -l icu": the data member travels inside
  // libskunicode.a too, so a manifest that links skia and forgets `icu` still shapes
  // text -- and with the old gate it silently shipped the 10.19 MB set again
  // (measured: examples/tf-scale-metrics.as at 15,510,408 B instead of 6,049,032 B,
  // exit 0, not one word of output).
  check('no text engine -> no ICU data object', icuDataPaths({ ...defaultBuildConfig(), linkLibs: ['icu'] }) === null);
  check('wasm never assembles it (Skia wasm already ships flutter data)',
    icuDataPaths({ ...text(), target: 'wasm' }) === null);
  check('a text build assembles it even when the manifest omits -l icu',
    darwin ? icuDataPaths({ ...text(), linkLibs: ['skia'] }) !== null
           : icuDataPaths({ ...text(), linkLibs: ['skia'] }) === null);

  // (4) The vendored blob is the small one, and its symbol is derived, not guessed.
  const dat = join(root, 'vendor', 'skia', 'icu', 'icudtl_flutter.dat');
  check('the flutter ICU data set is vendored', existsSync(dat));
  if (existsSync(dat)) {
    const size = statSync(dat).size;
    check('...and it is the small one (<1 MB, not the 10.19 MB desktop set)', size > 0 && size < 1_000_000);
    const blob = readFileSync(dat);
    const major = blob.subarray(blob.indexOf('icudt') + 5, blob.indexOf('icudt') + 7).toString('latin1');
    check('...with a version marker', /^[0-9]{2}$/.test(major));
    // Same split as above: the substitute is a Mach-O-only scheme, so on another
    // host the fact to pin is that nothing is injected.
    const obj = icuDataPaths(text());
    check(darwin ? 'a text build resolves the object' : 'a non-Mach-O build takes no substitute',
      darwin ? obj !== null : obj === null);
    if (obj) {
      // 阶段二百二十三：the blob is an object like any other -- in this build's own
      // scratch, never next to the tracked input (a shared path here is what let a
      // sibling build's link read an empty file; see the ObjectPaths group below).
      check('...built into this build\'s scratch, not the source tree',
        obj.source.startsWith(tmpdir()) && !obj.source.startsWith(root) && obj.object.endsWith('icudtl_flutter.o'));
      check('...materialised by the runner (the builder writes nothing)',
        writeIcuAssembly(text(), obj.source) && existsSync(obj.source));
      const asm = readFileSync(obj.source, 'utf8');
      check(`...defining the symbol the archives use (_icudt${major}_dat)`,
        asm.includes(`.globl _icudt${major}_dat`) && asm.includes(`_icudt${major}_dat:`));
      check('...and carrying exactly the vendored bytes',
        asm.split('\n').filter((l) => l.startsWith('\t.long ')).length * 4 >= statSync(dat).size);
      check('...and reporting the version it defines', obj.version === major);
    }

    // (5) The substitute is checked as a PAIR (our blob + the archive that donates
    // the member). A Skia upgrade to another ICU major would make the substitute
    // unusable while both files still look perfectly fine -- the symptom is 9.46 MB
    // reappearing with no other trace, so it must be a reported condition.
    const realTree: BuildConfig = { ...text(), linkPaths: [join(root, 'vendor', 'skia', 'lib', 'macos-arm64')] };
    check('the canary reads the version the linked archive expects',
      !darwin || icuArchiveDataVersion(realTree) === major);
    check('...which today matches the vendored blob (nothing to warn about)',
      !darwin || icuArchiveDataVersion(realTree) === icuDataPaths(text())?.version);
    check('an unreachable archive is "unknown", not a mismatch',
      icuArchiveDataVersion({ ...text(), linkPaths: ['/nonexistent-archive-pin'] }) === null);
  }

  console.log(`     [trim] ${ok} check(s) passed`);
  sweepOwnScratch();
  return bad;
}

registerGroup('unit: build/LinkTrim', checkLinkTrim);

// ---- per-config object paths (阶段二百二十三) ----------------------------------
// Two faces of one defect. The first is silent: two builds that disagree on a flag
// write the SAME object path, both succeed, and one links the other's code -- gaining a
// channel its manifest never asked for, or failing with `Undefined symbols:
// _sk_window_show_gpu` (seen when relinking leftover vendor objects by hand). Measured on
// the real sources, vendor/window_glue.cc is 29,216 bytes without ASC_RENDER_METAL and
// 30,896 with it, and the suite runs configs that use both at once.
//
// The second face is loud, and it is the one that actually cost us a red suite run: the
// ICU data object was deliberately shared by every build ("identical bytes, so sharing is
// free") while `clang -c` truncated it on every text build. Identical CONTENT does not
// make a non-atomic overwrite safe -- a sibling link reads an empty file:
// `ld: file is empty in .../icudtl_flutter.o`. So the rule pinned below is not "key the
// path by config", it is stronger: the path is private to the build process.
function checkObjectPaths(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [objpath] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [objpath] ${label}`); }
  };
  const base = (over: Partial<BuildConfig> = {}): BuildConfig => ({
    ...defaultBuildConfig(),
    cCompiler: 'clang',
    sources: [join(root, 'vendor', 'skia_glue.cc')],
    ...over,
  });
  // Every object a config produces (the compile steps) and the object the link
  // step consumes, read out of the real command lines rather than recomputed.
  const producedObjs = (cfg: BuildConfig): string[] =>
    buildCompileSteps(cfg, 'x.c', 'x.out').slice(0, -1)
      .map((s) => s[s.indexOf('-o') + 1])
      .filter((p) => p.endsWith('.o'));

  // (1) Two configs that disagree on anything that changes the bytes get different
  // directories; the same config stays put.
  const plain = producedObjs(base());
  const svg = producedObjs(base({ defines: ['ASC_USE_SKIA=1', 'ASC_USE_SVG=1'] }));
  check('two define sets never share an object', plain.every((p) => !svg.includes(p)) && svg.length > 0);
  check('...while each keeps the readable source name',
    plain.some((p) => p.endsWith('-skia_glue.o')) && svg.some((p) => p.endsWith('-skia_glue.o')));
  check('the same config resolves to the same paths',
    JSON.stringify(producedObjs(base())) === JSON.stringify(plain));
  check('native and wasm never share a directory',
    objectDir(base()) !== objectDir({ ...base(), target: 'wasm' }));
  // -O and the include set are part of the key too; include ORDER is deliberately
  // NOT normalized away, because -I order decides which header wins.
  check('the optimisation level is part of the key', objectDir(base()) !== objectDir({ ...base(), opt: '-O0' }));
  check('include PATHS are part of the key',
    objectDir(base({ includePaths: ['/a'] })) !== objectDir(base({ includePaths: ['/b'] })));
  check('...and so is their order (it picks which header wins)',
    objectDir(base({ includePaths: ['/a', '/b'] })) !== objectDir(base({ includePaths: ['/b', '/a'] })));

  // (2) The shared vendor path is gone. `vendor/skia_glue.o` was the whole bug.
  check('no object lands next to the source any more',
    plain.every((p) => !p.startsWith(join(root, 'vendor')) && p.startsWith(tmpdir())));
  check('the generated C is compiled out of tree as well',
    producedObjs(base()).every((p) => !p.startsWith(join(root, 'examples'))));

  // (3) Two same-named sources from different directories cannot collide: the
  // source PATH is hashed into the name, not just its basename.
  const twins = producedObjs(base({
    sources: [join(root, 'vendor', 'skia_glue.cc'), join(root, 'temp', 'pin', 'skia_glue.cc')],
  }));
  check('two same-named sources in different directories get different objects',
    new Set(twins).size === twins.length && twins.length >= 3);

  // (4) The compile half and the link half cannot drift apart: every object the
  // steps produce is the exact path the link step consumes. A mismatch here is
  // what makes a build link a stale object and pass.
  const steps = buildCompileSteps(base(), 'x.c', 'x.out');
  const produced = steps.slice(0, -1).map((s) => s[s.indexOf('-o') + 1]);
  check('the link line consumes exactly the objects the compile steps produce',
    produced.length > 0 && produced.every((p) => steps[steps.length - 1].includes(p)));

  // (5) Composing a command line must not touch the filesystem: the output directory
  // belongs to the runner (runCompile creates it), which is why `--dry` needs no special
  // case and why the test layer leaves no scratch behind. The unique include path keeps
  // this config's directory provably fresh for the whole process.
  const probe = base({ includePaths: [`/nonexistent-objpath-pin-${process.pid}-${Date.now()}`] });
  const probeDir = objectDir(probe);
  const drySteps = buildCompileSteps({ ...probe, dry: true }, 'x.c', 'x.out');
  check('--dry prints the object paths but creates nothing',
    drySteps.length > 1 && !existsSync(probeDir));
  check('...and neither does a real build, until it actually runs',
    buildCompileSteps(probe, 'x.c', 'x.out').length === drySteps.length && !existsSync(probeDir));

  // (6) Every object is private to the PROCESS that compiles it, which is what makes the
  // write race impossible rather than unlikely: two builds cannot even name the same file.
  // Reproduced on the old behaviour with temp/pitfall/stress-shared-obj.sh (120 concurrent
  // builds sharing one config): 9 links died with `ld: file is empty in
  // .../icudtl_flutter.o`, 0 after. The ICU data object below was the one the example
  // suite actually hit, twice in three runs.
  // Separator-agnostic: the same path is `…-1234\x.o` on Windows and `…-1234/x.o`
  // elsewhere, and the invariant is about the directory, not the slash.
  const slashed = (p: string): string => p.replace(/\\/g, '/');
  check('every object path is namespaced by the owning pid',
    plain.length > 0 && producedObjs(base()).every((p) => slashed(p).includes(`-${process.pid}/`)));
  const t1 = base({ defines: ['ASC_USE_SKIA=1', 'ASC_HAVE_TEXT'] });
  const t2 = base({ opt: '-O0', defines: ['ASC_USE_SKIA=1', 'ASC_HAVE_TEXT'] });
  const i1 = icuDataPaths(t1);
  const i2 = icuDataPaths(t2);
  check('the ICU data object is private as well (it was the shared one)',
    process.platform !== 'darwin' ||
      (i1 !== null && i2 !== null && i1.object !== i2.object && slashed(i1.object).includes(`-${process.pid}/`)));

  // (7) The scratch belongs to one build, and it ends with that build: a successful link
  // takes its objects with it (~3 MB for a text example), so repeated builds cannot pile
  // up in the temp dir. A FAILED build keeps them on purpose -- that is the state a
  // post-mortem wants -- which is why the call lives at the index.ts call site.
  const swept = objectDir(base());
  mkdirSync(swept, { recursive: true });
  check('the scratch exists while the build is running', existsSync(swept));
  cleanObjectScratch(base());
  check('...and a successful build takes it away', !existsSync(swept));

  // (8) Nothing is written into the source tree any more, not even the ICU assembler
  // source (it used to be generated next to the tracked .dat, which is why .gitignore
  // carried an entry for it). Build output belongs in the scratch.
  const vendorIcu = join(root, 'vendor', 'skia', 'icu');
  check('no build output lands in the vendored tree',
    !existsSync(join(vendorIcu, 'icudtl_flutter.s')) && !existsSync(join(vendorIcu, 'icudtl_flutter.o')));

  // Leave nothing behind: these checks drive the real command builder and materialise
  // real inputs, so they name real directories. Sweeping by pid also exercises the
  // naming rule itself.
  sweepOwnScratch();

  console.log(`     [objpath] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: build/ObjectPaths', checkObjectPaths);

// ---- host templates in build manifests (阶段二百二十七) ----
//
// `targets.<name>` layers by TARGET, and macOS/Windows are both `native`, so one
// manifest could not describe both hosts: the 15 Skia examples spelled
// `vendor/skia/lib/macos-arm64`, listed `png`/`jpeg`/`webp` under their macOS
// archive names, and asked lld-link for `-framework CoreAudio`. The template
// vocabulary (${host} / ${lib:} / ${win:} / ${mac:}) is what closes that, and these
// pins exist because every failure mode of it is SILENT: an empty ${host} produces
// a plausible directory, `${lib:}` forgotten yields `-lpng` which lld resolves to
// nothing, and a dropped `${win:}` entry yields a link error hundreds of lines
// away. Both directions are exercised from one machine by faking the platform (the
// same trick build/VendorLayout uses).
function checkHostTemplates(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [hosttmpl] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [hosttmpl] ${label}`); }
  };
  const fake = (platform: string, arch: string, fn: () => void): void => {
    const rp = process.platform;
    const ra = process.arch;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    try { fn(); } finally {
      Object.defineProperty(process, 'platform', { value: rp, configurable: true });
      Object.defineProperty(process, 'arch', { value: ra, configurable: true });
    }
  };
  // A throw helper: the message matters, because a silently-empty expansion is the
  // failure this whole mechanism has to avoid.
  const throwsWith = (fn: () => void, frag: string): boolean => {
    try { fn(); return false; } catch (e) { return String((e as Error).message).includes(frag); }
  };
  const expand = (entries: string[]): BuildConfig => applyManifest(
    defaultBuildConfig(), { target: 'native', architecture: '64', 'link-libs': entries } as Manifest, 'x.build.json');

  // (1) The vendor key itself, every row, from any host.
  check('win32/x64 with architecture "64" -> windows-x64',
    hostVendorKey('native', 'win32', 'x64', '64') === 'windows-x64');
  check('win32/x64 with architecture "32" -> windows-x86 (the AIR 32-bit build)',
    hostVendorKey('native', 'win32', 'x64', '32') === 'windows-x86');
  check('an unset architecture follows the HOST width, not always x64',
    hostVendorKey('native', 'win32', 'ia32', '') === 'windows-x86');
  check('darwin/arm64 -> macos-arm64', hostVendorKey('native', 'darwin', 'arm64', '') === 'macos-arm64');
  check('wasm -> wasm regardless of the build host',
    hostVendorKey('wasm', 'win32', 'x64', '') === 'wasm' && hostVendorKey('wasm', 'darwin', 'arm64', '') === 'wasm');
  check('a host with no prebuilt tree answers EMPTY, so the caller has to say so',
    hostVendorKey('native', 'linux', 'x64', '') === '' && hostVendorKey('native', 'win32', 'x64', 'arm64') === '');

  // (2) ${host} expands, and an empty key is a hard error rather than an empty path.
  fake('win32', 'x64', () => {
    const c = applyManifest(defaultBuildConfig(),
      { target: 'native', architecture: '64', 'link-paths': ['../vendor/skia/lib/${host}'] } as Manifest, 'x.build.json');
    check('win32: link-paths/${host} names the windows tree',
      c.linkPaths.length === 1 && c.linkPaths[0].endsWith(join('skia', 'lib', 'windows-x64')));
    check('a ${host} with no tree is an ERROR naming the host, never an empty path',
      throwsWith(() => applyManifest({ ...defaultBuildConfig(), architecture: 'arm64' },
        { target: 'native', 'link-paths': ['../vendor/skia/lib/${host}'] } as Manifest, 'x.build.json'),
      'no prebuilt vendor tree'));
  });
  fake('darwin', 'arm64', () => {
    const c = applyManifest(defaultBuildConfig(),
      { target: 'native', 'link-paths': ['../vendor/skia/lib/${host}'] } as Manifest, 'x.build.json');
    check('darwin: link-paths/${host} names the macos tree', c.linkPaths[0].endsWith(join('skia', 'lib', 'macos-arm64')));
  });

  // (3) ${lib:} follows the Windows `lib` prefix, which is the ONLY reason -lpng
  //     can be spelled once (Skia's BUILD.gn names those targets libpng/libjpeg/...).
  fake('win32', 'x64', () => {
    check('win32: ${lib:png} -> libpng', expand(['${lib:png}']).linkLibs.join() === 'libpng');
  });
  fake('darwin', 'arm64', () => {
    check('darwin: ${lib:png} -> png', expand(['${lib:png}']).linkLibs.join() === 'png');
  });

  // (4) ${win:}/${mac:} drop the WHOLE entry on the other host.
  fake('win32', 'x64', () => {
    const c = expand(['z', '${win:usp10}', '${mac:objc}', '${win:../vendor/curl/lib/${host}}']);
    check('win32 keeps the ${win:} entries and drops ${mac:}',
      c.linkLibs.join() === 'z,usp10,../vendor/curl/lib/windows-x64');
  });
  fake('darwin', 'arm64', () => {
    const c = expand(['z', '${win:usp10}', '${mac:objc}', '${win:../vendor/curl/lib/${host}}']);
    check('darwin keeps ${mac:} and drops every ${win:} entry (no -framework illusion left behind)',
      c.linkLibs.join() === 'z,objc');
  });
  // A wasm build is neither win nor mac: both conditionals must vanish, or a
  // cross target starts asking for Windows import libs.
  check('a wasm build drops both ${win:} and ${mac:} entries',
    applyManifest({ ...defaultBuildConfig(), target: 'wasm' },
      { 'link-libs': ['skia', '${win:usp10}', '${mac:objc}'] } as Manifest, 'x.build.json')
      .linkLibs.join() === 'skia');

  // (5) The spellings that must be REJECTED (AGENTS §2.5: a typo can never become
  //     a silent no-op).
  check('an unknown placeholder is an error, not a literal path',
    throwsWith(() => expand(['${nope}']), 'unknown template placeholder'));
  check('${win:} mixed into a longer string is an error ("drop part of a string" has no meaning)',
    throwsWith(() => expand(['${win:usp10}${mac:objc}']), 'must be a whole entry'));
  check('${host} takes no argument', throwsWith(() => expand(['${host:1}']), 'takes no argument'));
  check('${lib:} with no name is an error', throwsWith(() => expand(['${lib:}']), 'needs a library name'));
  check('an unterminated placeholder is an error',
    throwsWith(() => expand(['${host']), 'unterminated template placeholder'));

  // (6) `-framework` exists only on an Apple link. This is the third field that kept
  //     one manifest from describing both hosts; lld-link does not reject the flag,
  //     it treats the framework NAME as an input file (`could not open 'Cocoa'`).
  const fwCfg: BuildConfig = { ...defaultBuildConfig(), frameworks: ['Cocoa', 'Metal'] };
  fake('win32', 'x64', () => {
    check('win32: a manifest listing Cocoa/Metal emits no -framework at all',
      !buildCompileCommand(fwCfg, 'x.c', 'x').includes('-framework'));
    check('win32: ...and the frameworks are still recorded in the config (they describe the APPLE build)',
      fwCfg.frameworks.length === 2);
  });
  fake('darwin', 'arm64', () => {
    const cc = buildCompileCommand(fwCfg, 'x.c', 'x');
    check('darwin: the same manifest does emit -framework Cocoa/Metal',
      cc.includes('-framework') && cc.includes('Cocoa') && cc.includes('Metal'));
  });

  check('the platform fake was undone', process.platform === osPlatform());
  console.log(`     [hosttmpl] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: build/HostTemplates', checkHostTemplates);

// ---- every checked-in example manifest resolves on THIS host (阶段二百二十七) ----
//
// The template mechanism is only worth anything if the manifests that use it
// actually point at files that exist. That is not a compile-time property of the
// template code, it is a property of the 20-odd JSON files, so it is pinned here:
// expand each one for the host that is running the test and check every link dir,
// every -l archive and every source. On macOS this is what the examples already
// did implicitly; on Windows it is the only place the windows-x64 tree is walked
// without linking 20 MB of static libraries.
function checkExampleManifestHosts(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [manihost] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [manihost] ${label}`); }
  };
  const files: string[] = [];
  // Import/system libraries the OS supplies -- no -L dir holds them.
  const OS_PROVIDED = new Set([
    // Windows SDK
    'usp10', 'user32', 'gdi32', 'ole32', 'advapi32', 'winmm', 'imm32', 'oleaut32',
    'version', 'uuid', 'setupapi', 'shell32', 'dinput8',
    'd3d12', 'dxgi', 'd3dcompiler',
    'crypt32', 'ws2_32', 'secur32', 'bcrypt', 'iphlpapi',
    // POSIX / Apple system libs (posixLinkLibs, platformLinkLibs, the C++ runtime)
    'z', 'iconv', 'objc', 'm', 'c', 'pthread', 'dl', 'stdc++',
  ]);
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!['node_modules', 'com', 'org', 'net'].includes(e.name)) walk(join(d, e.name)); }
      else if (e.name.indexOf('.build.') >= 0 && e.name.endsWith('.json')) files.push(join(d, e.name));
    }
  };
  walk(join(root, 'examples'));

  // Only manifests for THIS host are expandable at all. Two kinds are not, and
  // both are skipped by CONTENT rather than by a name list, so nothing can rot:
  //
  //   * `target: wasm` / `package: web` — a different machine entirely.
  //   * a manifest that spells a platform key LITERALLY (air-native's D3D build
  //     names windows-x64 because it also names ASC_RENDER_D3D: the host is a
  //     consequence of the backend there, not an oversight). Those are counted and
  //     reported, so "we migrated everything" stays a checkable claim.
  const leftovers: string[] = [];
  const missingPaths: string[] = [];
  const missingArchives: string[] = [];
  const hostSpecific: string[] = [];
  let checked = 0;
  for (const f of files) {
    const cfg = applyManifest(defaultBuildConfig(), loadManifest(f), f);
    if (cfg.target !== 'native') continue;
    const raw = readFileSync(f, 'utf8');
    if (/(macos-arm64|windows-x64|windows-x86)/.test(raw)) {
      hostSpecific.push(f.slice(root.length + 1));
      continue;
    }
    checked++;
    const rel = f.slice(root.length + 1);
    for (const v of [...cfg.sources, ...cfg.includePaths, ...cfg.linkPaths, ...cfg.objects, ...cfg.anePaths]) {
      if (v.includes('${')) leftovers.push(`${rel} -> ${v}`);
      if (!existsSync(v)) missingPaths.push(`${rel} -> ${v}`);
    }
    // -lNAME resolves to libNAME.a / NAME.lib / NAME.a inside a -L dir, OR it is an
    // OS-provided import/system library that no manifest supplies (the Windows SDK's
    // user32/gdi32 family, and on POSIX the system z/iconv/objc that the link layer
    // adds itself). The allowlist also makes a NEW vendored archive name fail here
    // until someone decides which of the two it is.
    for (const l of cfg.linkLibs) {
      if (l.includes('${')) { leftovers.push(`${rel} -l -> ${l}`); continue; }
      if (OS_PROVIDED.has(l)) continue;
      const hit = cfg.linkPaths.some((p) => ['lib' + l + '.a', l + '.lib', l + '.a'].some((n) => existsSync(join(p, n))));
      if (!hit) missingArchives.push(`${rel} -> -l${l}`);
    }
  }
  check(`${checked} native example manifests expand with no ${'${'}...} placeholder left over`, leftovers.length === 0);
  if (leftovers.length > 0) console.log('  ' + leftovers.join('\n  '));
  check('every source / include / link path they name exists on this host', missingPaths.length === 0);
  if (missingPaths.length > 0) console.log('  ' + missingPaths.join('\n  '));
  check('every -lNAME they name resolves to an archive in one of their -L dirs', missingArchives.length === 0);
  if (missingArchives.length > 0) console.log('  ' + missingArchives.join('\n  '));
  // Visible, not silent: these still cannot be built on a second host, and that is
  // a per-file decision someone has to make (air-native's is tied to the D3D
  // backend, not to a forgotten placeholder).
  console.log(`     [manihost] ${hostSpecific.length} native manifest(s) still spell a platform key literally: `
    + hostSpecific.join(', '));
  console.log(`     [manihost] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: build/ExampleManifestHosts', checkExampleManifestHosts);

// `deploySkiaIcuData` copies icudtl.dat beside the exe, and several builds share one
// output directory in practice (`node test.ts` links every Skia example into the same
// temp/regress-out/ under a 6-wide pool). The copy therefore has to survive a
// destination that already holds the file -- and that a *running* Skia example has it
// open, which on Windows turns CopyFile into `UNKNOWN: unknown error, copyfile`.
// Pinned from any host by faking win32, since the function is Windows-only.
function checkIcuDataDeploy(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [icudat] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [icudat] ${label}`); }
  };
  const rp = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'as-aot-icu-'));
    const libDir = join(dir, 'lib');
    const outDir = join(dir, 'out');
    mkdirSync(libDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const src = join(libDir, 'icudtl.dat');
    writeFileSync(src, 'a'.repeat(64));
    const dst = join(outDir, 'icudtl.dat');
    const cfg = { ...defaultBuildConfig(), target: 'native', architecture: '64',
      linkLibs: ['skia'], linkPaths: [libDir] } as BuildConfig;

    check('first build copies the data beside the exe',
      deploySkiaIcuData(cfg, join(outDir, 'app.exe')) && readFileSync(dst, 'utf8').length === 64);

    // The point: a second build in the SAME output dir is a no-op, not a second
    // CopyFile. Same size + not-older-than-source is the up-to-date test, so the
    // probe stamps a future mtime and then checks it survived.
    //
    // Compare the mtime BEFORE and AFTER the call, never against `futures` itself:
    // APFS stores mtime in 1/1024 ms ticks, so a rounded-back read is X.999 and
    // `mtimeMs === futures.getTime()` went red at random (2 of 4 runs) while the
    // file had in fact been left alone. Both sides of this comparison come from the
    // filesystem, and a real rewrite would stamp "now" (60 s away), so it still
    // catches the bug the probe is about.
    const futures = new Date(Date.now() + 60_000);
    utimesSync(dst, futures, futures);
    const stamped = statSync(dst).mtimeMs;
    deploySkiaIcuData(cfg, join(outDir, 'app.exe'));
    check('a second build does not rewrite an up-to-date file', statSync(dst).mtimeMs === stamped);

    // A stale/truncated destination IS replaced, otherwise a crashed build would
    // poison the directory forever.
    writeFileSync(dst, 'stale');
    utimesSync(dst, futures, futures);
    deploySkiaIcuData(cfg, join(outDir, 'app.exe'));
    check('a destination with the wrong size is overwritten', readFileSync(dst, 'utf8').length === 64);

    // No icudtl.dat in any -L dir (Skia absent, or a macOS-style tree) -> false, so
    // the caller prints nothing and a non-Skia build is untouched.
    const emptyLib = join(dir, 'nolib');
    mkdirSync(emptyLib, { recursive: true });
    check('no icudtl.dat in the link dirs answers false',
      deploySkiaIcuData({ ...cfg, linkPaths: [emptyLib] }, join(outDir, 'app.exe')) === false);
    check('a build that does not link skia is skipped',
      deploySkiaIcuData({ ...cfg, linkLibs: [] }, join(outDir, 'app.exe')) === false);

    rmSync(dir, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', { value: rp, configurable: true });
  }
  console.log(`     [icudat] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: build/IcuDataDeploy', checkIcuDataDeploy);

// Remove every scratch directory this test process created under $TMPDIR/as-aot-obj.
// The checks drive the real command builder, so they name real directories; the build
// cleans up after a successful link, but a process that only *composes* commands has
// nothing of its own to clean, hence this sweep. Matching on the pid suffix is also what
// keeps the naming rule honest: if a future change stops namespacing by pid, this stops
// matching and the directories pile up visibly instead of being silently shared.
function sweepOwnScratch(): void {
  const baseDir = join(tmpdir(), 'as-aot-obj');
  if (!existsSync(baseDir)) return;
  for (const e of readdirSync(baseDir)) {
    if (e.endsWith(`-${process.pid}`)) rmSync(join(baseDir, e), { recursive: true, force: true });
  }
}
