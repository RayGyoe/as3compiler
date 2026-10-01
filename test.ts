// Test runner: compile and run every example in examples/, reporting pass/fail.
// This is the stage-8 assertion-style regression suite for the whole compiler.
// Usage: node test.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { lex } from './src/lexer.ts';
import { RUNTIME_PREAMBLE } from './src/runtime.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileCommand, buildCompileSteps, buildWebCompileSteps, effectiveDefines, validateFeatures, knownFeatures } from './src/build.ts';
import type { BuildConfig } from './src/build.ts';
import type { BuildConfig, Target, Manifest } from './src/build.ts';
import { airManifest, prepareAirApp } from './src/air-app.ts';
import { parse } from './src/parser.ts';
import { generateC } from './src/codegen.ts';

const root = import.meta.dirname;
const dir = join(root, 'examples');
const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

let pass = 0;
const failed: string[] = [];

// GUI entry points that open a window are not part of the automated regression:
// a directory must have exactly one top-level entry, and boot-gui.as duplicates
// boot.as (offscreen). They still compile standalone in pure-C mode, but the
// directory unit already uses the offscreen entry.
// air-native's Main instantiates TweenDemo, which depends on the GreenSock core
// (a third-party library directory excluded by SKIP_DIRS below). Those specific
// sources are re-added explicitly for the air-native unit (see GREENSOCK_CORE).
const SKIP_FILES = new Set(['boot-gui.as']);
// Third-party library directories (e.g. com/greensock) ship with full AIR apps
// but depend on features outside this compiler's subset; they are not part of
// the regression suite's input. `shmup-stage3d` is the stage 79-83 end-to-end
// acceptance demo — it needs the full Stage3D/Context3D surface (plus the `package {}`
// no-name form) that lands across stages 80-83, so it is skipped until then.
// `air-starling-demo` is the full Starling framework (142 files) used as a
// read-only reference for API-surface research (e.g. the stage-86 reflection
// functions). It needs namespace/XML/E4X and the full Starling Stage3D surface —
// features that land in later stages — so it is skipped rather than treated as a
// passing regression unit.
// `Flappy-Starling` (Josh Tynjala's Starling game, cloned into examples/ on
// 2026-09-26) is the same kind of third-party, read-only reference. It now builds
// and runs end to end (stage 89·33 named function expressions, 89·36 the NULL
// factory, 89·40 SharedObject — its only flash API gap), so the skip is purely a
// suite-cost decision: 127 sources plus the full Metal/Stage3D link take minutes,
// far more than any other unit. The manual acceptance procedure and the two
// remaining rendering residuals (Stage3D layer at contentScaleFactor 2, and
// fullScreenWidth/Height having no `-screensize` equivalent) are recorded in
// examples/Flappy-Starling/AOT-NOTES.md and the TODO.md 遗留待开发 table.
const SKIP_DIRS = new Set(['com', 'org', 'net', 'shmup-stage3d', 'air-starling-demo', 'Flappy-Starling']);
// GreenSock core files that air-native's TweenDemo actually reaches. Only these
// are pulled in; the rest of com/greensock (easing/loading/other plugins) stays
// outside the subset and is not compiled.
const GREENSOCK_CORE = [
  'com/greensock/TweenLite.as',
  'com/greensock/core/TweenCore.as',
  'com/greensock/core/SimpleTimeline.as',
  'com/greensock/core/PropTween.as',
  'com/greensock/plugins/TweenPlugin.as',
  'com/greensock/easing/Quad.as',
  'com/greensock/easing/Cubic.as',
];

// Recursively collect .as files so nested multi-file projects (e.g.
// air-native/src/demo/*.as plus its boot.as entry) compile as one unit.
function collectAsFiles(path: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...collectAsFiles(full));
    }
    else if (e.name.endsWith('.as') && !SKIP_FILES.has(e.name)) out.push(full);
  }
  return out.sort();
}

// Per-example timeout (ms). A compiler regression that hangs (e.g. a parser
// infinite loop) must fail loudly instead of freezing the whole suite, so each
// example is killed after this budget.
const EXAMPLE_TIMEOUT_MS = 60_000;

// Examples that are meaningless without a runtime diagnostic knob. gc_seg_reap
// is the regression for the segment-release accounting: it only asserts the
// heap invariants while the runtime cross-checks every segment's free_bytes
// against the object list, and ASC_GC_AUDIT_STRICT makes a broken invariant a
// non-zero exit instead of a report line (see src/runtime.ts gc_audit_fail).
const EXAMPLE_ENV: Record<string, Record<string, string>> = {
  'gc_seg_reap.as': { ASC_GC_AUDIT_STRICT: '1' },
};

function runExample(label: string, args: string[], env?: Record<string, string>): void {
  try {
    execFileSync('node', ['src/index.ts', ...args, '--run'], { cwd: root, stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS, env: { ...process.env, ...env } });
    console.log(`PASS  ${label}`);
    pass++;
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; signal?: string };
    console.log(`FAIL  ${label}`);
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    if (e.signal === 'SIGTERM') console.log(`  (timed out after ${EXAMPLE_TIMEOUT_MS}ms)`);
    failed.push(label);
  }
}

for (const e of entries) {
  if (SKIP_DIRS.has(e.name)) continue;
  if (e.isDirectory()) {
    // Multi-file example: compile every .as in the subdirectory (recursively) as one unit.
    const subDir = join(dir, e.name);
    const subFiles = collectAsFiles(subDir);
    if (subFiles.length === 0) continue;
    if (e.name === 'air-native') {
      for (const g of GREENSOCK_CORE) subFiles.push(join(subDir, 'src', g));
    }
    const names = subFiles.map((f) => f.slice(subDir.length + 1));
    runExample(`${e.name}/ (${names.join(', ')})`, subFiles);
  } else if (e.name.endsWith('.as')) {
    runExample(e.name, [join(dir, e.name)], EXAMPLE_ENV[e.name]);
  }
}

// ---- lexer diagnostics (阶段八十九·五十四) ----
// A block comment does NOT nest in AS3 (same as ES3/ES4): `/*` inside one is
// comment text, and the comment ends at the FIRST `*/`. Treating it as nesting
// once swallowed the rest of a real source file (a doc-comment containing
// `img/*.png`) and reported the error somewhere else entirely — a diagnosis
// pointed at the wrong line is the failure mode this pins. The unterminated case
// must fail loudly rather than silently swallow the rest of the file (§2.5).
// Checked at the lexer level, not as an example: the second case is a compile
// error, and the example suite only runs programs that must succeed.
function checkLexerDiagnostics(): string[] {
  const bad: string[] = [];
  const ok = (label: string, cond: boolean): void => {
    if (cond) console.log(`PASS  [lexer] ${label}`);
    else { bad.push(label); console.log(`FAIL  [lexer] ${label}`); }
  };
  const has = (src: string, name: string): boolean =>
    lex(src).some((t) => t.value === name && t.kind !== 'str');

  ok('a comment does not end at a bare *', has('/* a * b */ var kept:int = 1;', 'kept'));
  ok('a `/*` inside a block comment is comment text', has('/* img/*.png */ var kept:int = 1;', 'kept'));
  ok('a doc-comment with `/*` keeps every declaration after it',
    has('/** img/*.png */\nclass C {\n  private var a:int;\n}\nvar kept:int = 1;', 'kept'));
  ok('only the FIRST `*/` closes a block comment', has('/* one */ var a:int; /* two */ var kept:int;', 'kept'));
  ok('a `//` inside a block comment does not end it', has('/* // */ var kept:int = 1;', 'kept'));
  ok('a `/*` inside a line comment is inert', has('// /* var gone\nvar kept:int = 1;', 'kept'));
  ok('a `/*` inside a string literal is not a comment', has('var s:String = "/*"; var kept:int = 1;', 'kept'));
  ok('a `/*` inside a regex literal is not a comment', has('var r:RegExp = /a\\/*b/; var kept:int = 1;', 'kept'));

  let unterminated = false;
  try { lex('var x:int = 1; /* open'); } catch { unterminated = true; }
  ok('an unterminated block comment reports a LexError', unterminated);
  let lexThrew = false;
  try { lex('/* /* var x:int = 1;'); } catch { lexThrew = true; }
  ok('a nested-looking opener is still unterminated', lexThrew);

  if (bad.length === 0) console.log('[lexer] 10 diagnostics passed');
  return bad;
}

const lexerFailures = checkLexerDiagnostics();

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

const preloadOutputDirFailures = checkPreloadOutputDir();

const manifestFailures = checkManifestLayering();
// ---- ioError fidelity: AIR's NUMBER and sentence per failure (阶段八十九·五十九) ----
// The examples pin the two failures that can be produced offline (a missing local
// file -> Loader #2035 / URLLoader #2032, an undecodable local payload -> Loader
// #2124). The remaining two rows of AIR's matrix need a real network — a
// transport failure and a 4xx response — so they are pinned here, STRUCTURALLY,
// on the runtime preamble and the emitter. Every pair below was measured on adl
// 51.4.1 against the same input; the matrix is docs/zh-cn/flash-net.md §6.7.5.
// Before this stage every internally generated ioError carried errorID 0 and a
// hand-written sentence, which is untestable for a caller that switches on the
// number.
function checkIoErrorFidelity(): string[] {
  let ok = 0;
  const bad: string[] = [];
  // The emitter is read as text: the assertions below are about the shape of the
  // generated C, and no example can reach the two network-only failure kinds.
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [ioerror] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [ioerror] ${label}`); }
  };
  const p = RUNTIME_PREAMBLE;
  const slice = (from: string, to: string, fallback: number): string => {
    const i = p.indexOf(from);
    if (i < 0) return '';
    const j = p.indexOf(to, i + from.length);
    return p.slice(i, j < 0 ? i + fallback : j);
  };

  // The four measured sentences, verbatim. A typo here is a text a caller that
  // greps (instead of reading errorID) silently stops matching.
  check('the 2032 sentence is AIR verbatim', p.includes('case 2032: desc = "Stream Error";'));
  check('the 2035 sentence is AIR verbatim', p.includes('case 2035: desc = "URL Not Found";'));
  check('the 2036 sentence is AIR verbatim', p.includes('case 2036: desc = "Load Never Completed";'));
  check('the 2124 sentence is AIR verbatim',
    p.includes('case 2124: desc = "Loaded file is an unknown type";'));

  // AIR's text is the number's sentence plus the offending URL — both fields, in
  // that order, on one line. Dropping the URL would leave a failure with no
  // subject; dropping the number would make the text un-greppable.
  const fmt = slice('static char* as_ioerror_text', 'static int as_job_loader_ioerror_id', 2000);
  check('the text is "Error #N: <sentence>. URL: <url>"',
    fmt.includes('"Error #%d: %s. URL: %s"') && fmt.includes('id, desc, u'));

  // The Loader classifier is the part that cannot be derived from the job's error
  // kind: a 4xx body ALSO fails the decode, and AIR calls that "Load Never
  // Completed" (2036), not "unknown type" (2124). The status is what separates
  // them, so a classifier that ignored it would report 2124 for every 404 — the
  // exact defect this pins.
  const cls = slice('static int as_job_loader_ioerror_id', 'static void* as_job_pixels', 1200);
  check('a 4xx decode failure is 2036, not 2124 (the status decides)',
    /AS_JOB_ERR_DECODE\)\s*return\s*\(j->status >= 400\)\s*\?\s*2036\s*:\s*2124/.test(cls));
  check('a local read failure is 2035 and a remote one 2036',
    /as_job_is_remote_url\(j->path\)\s*\?\s*2036\s*:\s*2035/.test(cls));
  check('the build-level transport gap keeps no AIR number',
    /AS_JOB_ERR_UNSUPPORTED\)\s*return\s*0/.test(cls));

  // All three event-raising sites must WRITE the number: the constructor leaves
  // errorID 0 (correct for `new IOErrorEvent(...)`, wrong for a runtime-generated
  // one), so a site that forgets the assignment silently ships id 0 again.
  check('every dispatched ioError carries its number',
    (emitSource.match(/ev->errorID = eid;/g) ?? []).length === 3);
  check('…and each gets the number from the AIR classifier/constant',
    emitSource.includes('as_job_loader_ioerror_id(job)') &&
    (emitSource.match(/AS_JOB_ERR_UNSUPPORTED\) \? 0 : 2032;/g) ?? []).length === 2);

  if (ok > 0) console.log(`[ioerror] ${ok} ioError fidelity checks passed`);
  return bad;
}

const ioErrorFailures = checkIoErrorFidelity();

// ---- Non-2xx terminal state: the caller's HTTP_RESPONSE_STATUS listener decides
// (阶段八十九·六十二). The whole matrix was measured with a controlled probe — one
// server, one URL, and the listener as the ONLY variable — in
// temp/httpstatus-probe; the AOT probe (temp/httpstatus-aot) reproduces all 12
// cases byte-for-byte. What is pinned here is the shape of the emitted C, because
// no offline example can reach a 4xx without a server.
function checkHttpStatusTerminal(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [httpstatus] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [httpstatus] ${label}`); }
  };

  // Both terminals (URLLoader__finish and URLStream__finish) must make the same
  // decision; a rule applied to only one of them is the same class of defect as
  // the ioError number that was written on one site but not the others. The three
  // assertions are kept independent on purpose (who consults the listener; what
  // the threshold is; which direction the test goes), so one wrong mutation cannot
  // hide behind another.
  const consult = emitSource.match(/EventDispatcher_hasEventListener\(\(void\*\)o, \(char\*\)"httpResponseStatus"\)/g) ?? [];
  check('both terminals consult the caller\'s listener (URLLoader + URLStream)', consult.length === 2);

  // The threshold is >= 300, not >= 400: a 302 that is not followed splits the
  // same way (case F/G), so a 4xx-only test would silently complete a redirect
  // that AIR reports as an ioError.
  check('the threshold is >= 300 (an unfollowed 302 splits too)',
    (emitSource.match(/st >= 300/g) ?? []).length === 2);

  // The discriminator is the ABSENCE of the listener: with one registered the
  // error body completes (cases A/C/F), without one it ends in ioError (B/D/G).
  check('…and the branch is taken when the listener is ABSENT',
    (emitSource.match(/!EventDispatcher_hasEventListener\(\(void\*\)o, \(char\*\)"httpResponseStatus"\)/g) ?? []).length === 2);

  // The ioError it raises carries AIR's number AND sentence, through the same
  // formatter the rest of flash.net uses — a bare id or a hand-written sentence
  // would make the failure untestable for a caller that switches on the number.
  const errs = emitSource.match(/IOErrorEvent_new\(\(char\*\)"ioError", false, false, as_ioerror_text\(as_job_path\(job\), 2032, NULL\)\)/g) ?? [];
  check('the split dispatches AIR-verbatim #2032 (number + sentence + URL)', errs.length === 2);
  check('…and stamps the number on the event',
    (emitSource.match(/ev->errorID = 2032;/g) ?? []).length === 2);

  // Zero-length body: AIR dispatches no PROGRESS at all (cases I/J), so the
  // terminal progress needs a total > 0 guard on both terminals.
  check('a zero-length body emits no terminal PROGRESS',
    (emitSource.match(/if \(total > 0 && \(as_job_marks_sent\(job\) == 0/g) ?? []).length === 2);

  if (ok > 0) console.log(`[httpstatus] ${ok} non-2xx terminal checks passed`);
  return bad;
}

const httpStatusFailures = checkHttpStatusTerminal();

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

const perfFailures = checkPerfFlags();

// ---- E1: the opt-in SVG decode channel (+ the GC red line it exposed) ----
//
// SVG cannot be an examples/ unit: it needs a Skia link AND the ASC_USE_SVG
// define, while the example suite runs every entry manifest-free in pure-C mode.
// So this pins the two things a mutation could silently break -- the opt-in
// guard that keeps the default build AIR-isomorphic, and the GC rule that the
// channel's first successful decode exposed.
function checkSvgChannel(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [svg] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [svg] ${label}`); }
  };

  // Assert on what the emitter WRITES OUT, not on the raw file: comments in
  // emit.ts quote both the broken and the fixed form, so a substring search over
  // the source would count documentation as code.
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  // Stage 89-42 put `pixels` on the GC heap. free()ing it corrupts the GC free
  // list (the same rule BitmapData_dispose documents), and it abort()ed on the
  // first successful BitmapData.loadFile over a user-constructed bitmap -- which
  // no regression had ever exercised, because every probe fed loadFile a file
  // that failed to decode and left the adoption branch untaken.
  check('no generated statement free()s BitmapData.pixels (it is a GC buffer)',
    !emitted.includes('free(bd->pixels)'));
  check('both pixel-adoption sites keep the GC write barrier',
    (emitted.match(/gc_write_barrier\(bd->pixels\)/g) ?? []).length === 2);

  const glue = readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8');
  // Opt-in is the whole point (AIR has no SVG at all, so per §1.5 the default
  // build must stay byte-for-byte AIR). Split the file on the guards and require
  // that nothing SVG-flavoured survives outside one.
  let rest = glue;
  let guards = 0;
  for (;;) {
    const i = rest.indexOf('#ifdef ASC_USE_SVG');
    if (i < 0) break;
    guards++;
    const j = rest.indexOf('#endif', i);
    if (j < 0) break;
    rest = rest.slice(0, i) + rest.slice(j);
  }
  check('the SVG channel exists and is guarded', guards >= 5 && glue.includes('#endif  // ASC_USE_SVG'));
  // Comments are stripped before the test: the design rationale above the guard
  // legitimately NAMES SkSVGDOM, and a pin that flags prose teaches nothing. A
  // naive suppressor (no string-literal state) can only over-strip, which makes
  // this check weaker -- never falsely failing -- which is the safe direction.
  const uncommented = rest.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  check('no SVG reference escapes its #ifdef ASC_USE_SVG guard',
    !/SkSVGDOM|sk_svg_|SK_SVG_DEFAULT/.test(uncommented));
  // One fallback per decode entry point (file/bytes x SkImage/ARGB), plus the
  // forward declaration and the definition: 6 mentions. Fewer means some caller
  // still reports "unknown type" for an SVG while its sibling decodes it.
  check('every decode entry point tries SVG (file + bytes, both return shapes)',
    (glue.match(/sk_svg_header\(/g) ?? []).length === 6);
  // An SVG document with no absolute width/height has no intrinsic size; the
  // spec's replaced-element default is what we answer with.
  check('the no-intrinsic-size case falls back to the SVG spec default (300x150)',
    glue.includes('#define SK_SVG_DEFAULT_W 300') && glue.includes('#define SK_SVG_DEFAULT_H 150'));
  // Without setFontManager the DOM renders <text> as nothing at all -- measured:
  // 97 glyph pixels with it, 0 without.
  check('the SVGDOM builder gets the platform font manager (else <text> vanishes)',
    glue.includes('setFontManager(sk_platform_fontmgr())'));
  // The sniff runs only AFTER the codec path failed, and only then: trying a
  // parse first would make every "unknown type" payload pay for it.
  check('the SVG sniff runs as a codec fallback, never as a competing decoder',
    (glue.match(/if \(!image && sk_svg_header\(/g) ?? []).length === 4);

  if (ok > 0) console.log(`[svg] ${ok} opt-in SVG channel checks passed`);
  return bad;
}

const svgFailures = checkSvgChannel();

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
  check('the default config enables no enhancement',
    effectiveDefines(dflt).every((d) => !d.startsWith('ASC_USE_SVG')));
  check('a default native command carries no enhancement macro',
    !buildCompileCommand(dflt, 'x.c', 'x').includes('ASC_USE_SVG=1'));
  check('a default native build carries none on any step',
    buildCompileSteps(dflt, 'x.c', 'x').every((s) => !s.includes('ASC_USE_SVG=1')));
  check('a default web build carries none on any step',
    buildWebCompileSteps(dflt, 'x.c', 'x').every((s) => !s.includes('ASC_USE_SVG=1')));

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
    knownFeatures().join(',') === 'svg');

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

const featureFailures = checkFeatures();

// ---- ① TextField wordWrap usable width (AIR's 2px inset) ----
//
// Not an examples/ unit for the same reason as SVG: it needs a raster/paragraph
// backend (numLines comes from a real SkParagraph layout), while the suite runs
// every example manifest-free in pure-C mode where the as_skia_* calls are no-ops.
// The measurement lives in temp/tfwrap/ (Main.as = adl probe, tfwrap.as = ours).
function checkTextWrap(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [textwrap] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [textwrap] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  const emitted = [...emitSource.matchAll(/this\.line\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]).join('\n');
  // The wrap threshold must be computed against the inset width. Reverting to the
  // bare width changes an observable: a Verdana-24 line of ink 124.945px stops
  // wrapping at field width 125 instead of AIR's 129 -- one word late, exactly at
  // the boundary, which is what the 12-scenario Starling comparison caught.
  check('the wordWrap layout width subtracts AIR\'s 2px inset (width - 4)',
    emitted.includes('w = tf->width - 4.0;'));
  check('the wrap path no longer lays out against the bare field width',
    !emitted.includes("'double w = (tf->wordWrap && tf->width > 0.0) ? tf->width : 0.0;'"));
  // Without the floor a field narrower than its inset goes <= 0, and the glue reads
  // width <= 0 as "no wrapping" (1e9), silently converting wrap to overflow.
  check('a field narrower than its own inset is clamped, not passed through as <= 0',
    emitted.includes('if (w < 1.0) w = 1.0;'));
  if (ok > 0) console.log(`[textwrap] ${ok} wordWrap inset checks passed`);
  return bad;
}

const textWrapFailures = checkTextWrap();
// ---- --air-app transport auto-detection (阶段八十九·五十五) ----
// `--air-app` REGENERATES <filename>.build.json on every run, so "just edit the
// manifest to add curl" cannot survive a rebuild: the link set has to come from
// the generator. A remote URL with no transport backend still compiles and runs
// (the async job table reports AS_JOB_ERR_UNSUPPORTED) but every load ends in
// ioError — the "网络访问都是 ioError" symptom — so the detector is pinned here on
// the sources themselves. Fixtures live under temp/ (this suite's scratch dir):
// a descriptor + src/ is an *input to the adapter*, not an AS3 program, and
// putting it under examples/ would make the example suite compile and run it.
function checkAirAppTransport(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [air-app] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [air-app] ${label}`); }
  };
  const base = join(root, 'temp', 'air-app-transport');
  const descriptor = (filename: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `  <id>com.example.${filename}</id>\n  <filename>${filename}</filename>\n` +
    `  <initialWindow><content>main.swf</content><visible>true</visible>` +
    `<width>400</width><height>400</height></initialWindow>\n</application>\n`;
  // One app that touches the network (URLRequest is the marker every networked
  // path in the AS3 API takes) and one that cannot possibly do so while still
  // importing from `flash.net` — SharedObject lives in that package and never
  // touches the HTTP seam, so matching the package name instead of the class would
  // both over-link curl and hard-fail on a machine without vendor/curl.
  const apps: [string, string][] = [
    ['net', '  import flash.net.URLLoader;\n  import flash.net.URLRequest;\n' +
            '  public class Main extends Sprite {\n' +
            '    public function Main() { new URLLoader().load(new URLRequest("https://example.com/x.json")); }\n  }'],
    ['plain', '  import flash.net.SharedObject;\n' +
              '  public class Main extends Sprite {\n' +
              '    public function Main() { trace(SharedObject.getLocal("k")); }\n  }'],
  ];
  const manifestOf = (name: string, extra: string[]): Record<string, unknown> => {
    const dir = join(base, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, `${name}-app.xml`), descriptor(name));
    writeFileSync(join(dir, 'src', 'Main.as'),
      'package {\n  import flash.display.Sprite;\n' + apps.find((a) => a[0] === name)![1] + '\n}\n');
    execFileSync('node', ['src/index.ts', '--air-app', join(dir, `${name}-app.xml`),
      '--main-class', 'Main', ...extra, '--dry'], { cwd: root, stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS });
    return JSON.parse(readFileSync(join(dir, `${name}.build.json`), 'utf8')) as Record<string, unknown>;
  };
  const list = (m: Record<string, unknown>, k: string): string[] => (m[k] as string[]) ?? [];

  const netNative = manifestOf('net', ['--target', 'native']);
  check('a networked app links curl', list(netNative, 'link-libs').includes('curl'));
  check('a networked app links nghttp2 (curl\'s HTTP/2 framing)', list(netNative, 'link-libs').includes('nghttp2'));
  check('a networked app defines ASC_HAVE_CURL', list(netNative, 'defines').includes('ASC_HAVE_CURL=1'));
  check('a networked app adds curl\'s include path',
    list(netNative, 'include-paths').some((p) => p.endsWith('vendor/curl/include')));
  check('a networked app adds curl\'s static lib path',
    list(netNative, 'link-paths').some((p) => p.endsWith('vendor/curl/lib/macos-arm64')));
  check('a networked app links curl\'s TLS + proxy frameworks',
    list(netNative, 'frameworks').includes('Security') && list(netNative, 'frameworks').includes('SystemConfiguration'));

  const netWeb = airManifest('../../vendor', true, true, true, true, 'auto', false, false, [], [], [], [], true) as Record<string, unknown>;
  check('the web build defines ASC_HAVE_FETCH instead', list(netWeb, 'defines').includes('ASC_HAVE_FETCH=1'));
  check('the web build links no curl (wasm-ld cannot)',
    !list(netWeb, 'link-libs').includes('curl') && !list(netWeb, 'defines').includes('ASC_HAVE_CURL=1'));
  // The web manifest is asserted through the pure generator rather than the CLI:
  // `--package web` probes for emcc before the dry-run check, and pinning a local
  // emsdk path in the suite would hardcode one machine's SDK location.
  const plainWeb = airManifest('../../vendor', true, true, true, true, 'auto', false, false, [], [], [], [], false) as Record<string, unknown>;
  check('a non-networked web build gets no fetch backend', !list(plainWeb, 'defines').includes('ASC_HAVE_FETCH=1'));

  const plain = manifestOf('plain', ['--target', 'native']);
  check('a non-networked app is not given curl (even importing from flash.net)',
    !list(plain, 'link-libs').includes('curl') && !list(plain, 'defines').includes('ASC_HAVE_CURL=1'));

  if (ok > 0) console.log(`[air-app] ${ok} transport checks passed`);
  return bad;
}

const airAppFailures = checkAirAppTransport();

// ---- web-target transport gaps (阶段八十九·五十六) ----
// The suite cannot RUN a web build (that needs emcc and a browser, and pinning an
// emsdk path would hardcode one machine's SDK), so these two defects are pinned
// STRUCTURALLY, on the runtime preamble the generated C is assembled from. Both
// were silent -- the app compiled, ran, and reported a plausible but wrong
// failure -- and both are contracts rather than code shapes, so the assertions
// name the contract: a remote image must have a browser transport, and the
// browser must be told the request's content type.
function checkWebTransport(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [web] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [web] ${label}`); }
  };
  const p = RUNTIME_PREAMBLE;
  // Bounded slices: search from a stable anchor to the next landmark so an
  // assertion can never be satisfied by an unrelated occurrence elsewhere.
  const slice = (from: string, to: string, fallback: number): string => {
    const i = p.indexOf(from);
    if (i < 0) return '';
    const j = p.indexOf(to, i + from.length);
    return p.slice(i, j < 0 ? i + fallback : j);
  };

  // (1) A remote image must be STARTED by the web backend, not reported as a
  // missing transport. Before 八十九·五十六 the AS_JOB_IMAGE_URL case was
  // compiled for the curl backend only, so on web every remote Loader.load ended
  // in "network URLs are not supported in this build" -- the build HAS a
  // transport, it just never got to use it.
  const imageCase = slice('case AS_JOB_IMAGE_URL', '} else if (j->kind == AS_JOB_IMAGE)', 2000);
  check('a remote image load has a browser transport (not only curl)',
    /ASC_HTTP_WEB/.test(imageCase) && /as_http_run\(j\)/.test(imageCase));

  // (2) The browser must be given the request's content type. fetch invents none
  // for the Uint8Array body this backend passes, so without this
  // URLRequest.contentType never reaches the server (measured against the real
  // endpoint: the same JSON login POST is answered "platform ... is required"),
  // while the curl backend has always sent it as a header.
  const glue = slice('EM_JS(void, as_web_fetch_go', 'EM_JS(void, as_web_fetch_stop', 4000);
  check('the web fetch sends URLRequest.contentType as a Content-Type header',
    /headers\['Content-Type'\]/.test(glue) && /ctype/.test(glue));
  check('both transfer entry points (URLLoader and URLStream) declare it',
    (p.match(/as_http_effective_ctype\(j\),/g) ?? []).length === 2);

  // (3) A remote image's payload must be decoded before its thunk reads it. The
  // decode normally happens inside as_job_run, but on web that call only STARTS
  // the fetch, so the pump has to stage the pixels the thunk turns into a
  // BitmapData -- otherwise the load "completes" with an empty Bitmap.
  const pump = slice('static int as_web_fetch_pump', 'static void as_http_run', 6000);
  check('the web pump decodes a remote image payload before its thunk runs',
    /AS_JOB_IMAGE_URL/.test(pump) && /as_skia_image_decode_bytes_argb/.test(pump));

  if (ok > 0) console.log(`[web] ${ok} transport checks passed`);
  return bad;
}

const webFailures = checkWebTransport();

// ---- URLRequest.contentType is TWO different things (阶段八十九·六十九) ----
// adl returns NULL for a fresh URLRequest, while the AS3 reference prints
// "application/x-www-form-urlencoded" as its default value -- that string is the
// Content-Type adl puts on the WIRE for a request that carries a body and declared
// none (capture-server measurement in runtime.ts next to the helper). Stage 89·48
// took the documentation at face value and wrote the MIME string into the
// property; the property then disagreed with AIR, and examples/air-native -- the
// one example that RUNS the assertion rather than merely compiling it -- died in
// 53 ms on the mismatch, before its window was ever drawn. Hence two pins: the
// property default, and the fact that every "default" assertion in the examples
// agrees with it (the example the doc change had missed is exactly what a
// compiler-side pin must be able to see).
function checkRequestContentType(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [req-ctype] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [req-ctype] ${label}`); }
  };
  const emitSource = readFileSync(join(root, 'src', 'emit.ts'), 'utf8');
  check('a fresh URLRequest leaves contentType NULL (adl-measured)',
    /o->contentType = NULL;/.test(emitSource) &&
    !/o->contentType = \(char\*\)"application\/x-www-form-urlencoded";/.test(emitSource));

  // The wire rule, shared by both backends: a body-carrying request without an
  // explicit (non-empty) content type still goes out urlencoded.
  const eff = (() => {
    const p = RUNTIME_PREAMBLE;
    const i = p.indexOf('static const char* as_http_effective_ctype');
    if (i < 0) return '';
    const j = p.indexOf('\n}', i);
    return p.slice(i, j < 0 ? i + 900 : j);
  })();
  check('the URLRequest ctor keeps an explicitly empty string as-is',
    /if \(j->content_type != NULL && j->content_type\[0\] != '\\0'\) return j->content_type;/.test(eff));
  check('a body-carrying request defaults to urlencoded, a bodyless one sends none',
    /if \(j->body == NULL \|\| j->body_len == 0\) return NULL;/.test(eff) &&
    /return "application\/x-www-form-urlencoded";/.test(eff));
  check('the curl backend uses that rule instead of reading the raw field',
    /const char\* ctype = as_http_effective_ctype\(j\);/.test(RUNTIME_PREAMBLE));
  // libcurl invents a Content-Type for every POST, so a bodyless POST needs the
  // library default switched off to match adl's header-less request.
  check('the curl backend suppresses libcurl\'s invented Content-Type',
    /curl_slist_append\(hdrs, "Content-Type:"\)/.test(RUNTIME_PREAMBLE));

  // Every example assertion that names the DEFAULT must agree with the emission
  // above. Only examples/*.as is scanned: these are the files that both document
  // the behaviour and get run.
  const mismatched: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.as')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const m = /contentType\s*==\s*([^,;)]+)/.exec(line);
        if (!m) continue;
        if (!/default/i.test(line)) continue;
        if (m[1].trim() !== 'null') mismatched.push(`${full.replace(root + '/', '')}: ${line.trim()}`);
      }
    }
  };
  walk(join(root, 'examples'));
  check('every example that asserts contentType\'s default asserts null',
    mismatched.length === 0 || (console.log('       ' + mismatched.join('\n       ')), false));

  if (ok > 0) console.log(`[req-ctype] ${ok} request-default checks passed`);
  return bad;
}

const requestContentTypeFailures = checkRequestContentType();

// ---- who owns a staged job result (阶段八十九·七十) ----
// The async job table has TWO ownership rules and they are opposites, so the
// wrong one is invisible until a resource is destroyed twice:
//
//   HANDLE (AS_JOB_FS_OPEN)  the FILE* becomes the AS3 FileStream's. The thunk
//                            must TAKE it out of the job, because as_job_retire
//                            closes whatever the job still holds and the app
//                            closes the stream itself (air-native's FileDemos
//                            does it from its own COMPLETE listener).
//   BYTES/PIXELS             the thunk COPIES into the GC heap; the job keeps
//                            its malloc'd buffer and releases it on retire.
//
// The defect was the first rule done as the second: `o->_handle =
// as_job_handle(job)` handed AS3 a COPY and left the job pointing at the same
// FILE*, so retire fclose()d an already-closed stream. The browser reported it
// (`Uncaught RuntimeError: table index is out of bounds`, symbolised as
// `fclose <- as_job_retire <- Stage_dispatchFrame` -- emscripten's fclose ends
// in an indirect call through the stream's own function pointer, and the freed
// stream no longer holds a valid table index); native corrupts the heap in
// silence, so no example run can catch it. Pinned on the GENERATED C rather than
// on the emitter's source text: a getter and a take read the same at a glance.
function checkJobOwnership(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [job-owner] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [job-owner] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.filesystem.File;\n' +
    'import flash.filesystem.FileStream;\n' +
    'import flash.filesystem.FileMode;\n' +
    'var s:FileStream = new FileStream();\n' +
    's.openAsync(File.applicationStorageDirectory.resolvePath("x.txt"), FileMode.READ);\n'
  )).c;

  check('an openAsync program emits the file-open thunk', c.includes('FileStream__openFinish'));
  check('that thunk TAKES the handle out of the job (one owner for the FILE*)',
    c.includes('o->_handle = as_job_take_handle(job);'));
  check('no copying getter for the job handle exists to fall back to',
    !c.includes('as_job_handle('));
  check('the take clears the field, so retire cannot close it a second time',
    /static void\* as_job_take_handle\(void\* job\) \{\s*as_job\* j = \(as_job\*\)job;\s*void\* h = j->handle;\s*j->handle = NULL;\s*return h;/.test(
      RUNTIME_PREAMBLE.replace(/\r\n/g, '\n')));

  // The other half of the mechanism must stay: a job whose thunk never ran (a
  // superseded openAsync) still owns its handle, and retire is the only thing
  // left to close it. Removing that would leak a descriptor per superseded open.
  check('retire still closes a handle the job kept for itself',
    /if \(j->kind == AS_JOB_FS_OPEN && j->handle != NULL\) \{\s*fclose\(\(FILE\*\)j->handle\);/.test(
      RUNTIME_PREAMBLE.replace(/\r\n/g, '\n')));

  // ...and the OPPOSITE rule for decoded images must not be "fixed" into the
  // same shape: bytes/pixels are copied, the job releases its own buffer.
  const retired = (() => {
    const i = RUNTIME_PREAMBLE.indexOf('static void as_job_retire(as_job* j) {');
    if (i < 0) return '';
    const j = RUNTIME_PREAMBLE.indexOf('\n}', i);
    return RUNTIME_PREAMBLE.slice(i, j < 0 ? i + 900 : j);
  })();
  check('a decoded bitmap is still COPIED, not handed over',
    c.includes('memcpy(gcpx, px,') && !c.includes('bd->pixels = (void*)px;'));
  check('the job still owns and frees its staged buffers',
    /free\(\(void\*\)j->bytes\);/.test(retired) && /free\(j->pixels\);/.test(retired));

  // The example that reproduced the crash must keep reproducing it: it is the
  // close() from the app's own COMPLETE listener that makes the second fclose a
  // double close. Without it the pin above passes on a build that cannot fail.
  const demos = readFileSync(join(root, 'examples', 'air-native', 'src', 'demo', 'FileDemos.as'), 'utf8');
  const complete = (() => {
    const i = demos.indexOf('function onAsyncComplete');
    return i < 0 ? '' : demos.slice(i, i + 400);
  })();
  check('the reproducing example opens asynchronously', /openAsync\(af, FileMode\.READ\)/.test(demos));
  check('...and closes the stream itself when COMPLETE arrives',
    /asyncStream\.close\(\)/.test(complete));

  if (ok > 0) console.log(`[job-owner] ${ok} job-ownership checks passed`);
  return bad;
}

const jobOwnershipFailures = checkJobOwnership();

// ---- web builds whose text has no font (阶段八十九·五十七) ----
// A browser sandbox has NO system fonts: the page injects the bytes and Skia
// builds its font manager from them, so with nothing injected every TextField
// draws its background and none of its glyphs. That is SILENT -- the build
// succeeds and the page runs -- and it is web-only (native/adl enumerate the
// installed families through CoreText), which is exactly the shape the user hit:
// `air-starling-demo` previewed fine because it ships assets/fonts/Ubuntu-R.ttf,
// while `url-test` shipped no font at all and showed empty boxes. Pinned on the
// adapter's own report (prepareAirApp.warnings + the manifest it writes), since
// what matters is the diagnosis the user gets, not the code shape. Fixtures live
// under temp/ for the same reason as the transport ones: a descriptor + src/ is
// an *input to the adapter*, not an AS3 program.
function checkAirAppFonts(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [air-app-font] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [air-app-font] ${label}`); }
  };
  const base = join(root, 'temp', 'air-app-font');
  const vendorAbs = resolve(root, 'vendor');

  // A fixture app that draws text (flash.text is the marker), optionally shipping
  // a font. The "font" is arbitrary bytes: findAppFonts matches by extension and
  // nothing in the manifest path opens the file, so the bytes never matter.
  const fixture = (name: string, body: string, shipFont: boolean, fontName = 'Fixture.ttf'): string => {
    const d = join(base, name);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, `${name}-app.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
      `  <id>com.example.${name}</id>\n  <filename>${name}</filename>\n` +
      `  <initialWindow><content>main.swf</content><visible>true</visible>` +
      `<width>400</width><height>400</height></initialWindow>\n</application>\n`);
    writeFileSync(join(d, 'src', 'Main.as'),
      `package {\n  import flash.display.Sprite;\n${body}\n}\n`);
    if (shipFont) {
      mkdirSync(join(d, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(d, 'assets', 'fonts', fontName), 'not-a-real-font');
    }
    return join(d, `${name}-app.xml`);
  };

  const textBody =
    '  import flash.text.TextField;\n' +
    '  public class Main extends Sprite {\n' +
    '    public function Main() { var t:TextField = new TextField(); t.text = "hi"; addChild(t); }\n  }';
  const plainBody =
    '  import flash.display.Bitmap;\n' +
    '  public class Main extends Sprite {\n' +
    '    public function Main() { addChild(new Bitmap()); }\n  }';

  const prep = (appXml: string, web: boolean) => prepareAirApp(appXml, 'Main', vendorAbs, web);
  const warningsText = (w: string[]): string => w.join('\n');

  // (1) The defect: text on web, no font anywhere in the app.
  const noFont = prep(fixture('text-nofont', textBody, false), true);
  const noFontManifest = JSON.parse(readFileSync(noFont.manifestPath, 'utf8')) as Record<string, unknown>;
  check('a text-drawing web app with no font resolves no font',
    ((noFontManifest['font-urls'] as string[]) ?? []).length === 0);
  check('...and is told its TextFields will render blank',
    /render blank/.test(warningsText(noFont.warnings)));
  check('...and is told the two ways to fix it',
    /\.ttf/.test(warningsText(noFont.warnings)) && /embedFonts/.test(warningsText(noFont.warnings)));

  // (2) The fix: the same app shipping one font. Reverse control for (1) -- if the
  // detector or the empty-list test were wrong this would keep warning.
  const withFont = prep(fixture('text-font', textBody, true), true);
  const withFontManifest = JSON.parse(readFileSync(withFont.manifestPath, 'utf8')) as Record<string, unknown>;
  check('shipping a font is picked up automatically (no descriptor edit)',
    ((withFontManifest['font-urls'] as string[]) ?? []).some((u) => u.endsWith('Fixture.ttf')));
  check('a web app that ships a font is not warned about', withFont.warnings.length === 0);
  // ...and that font must not also be packed into the FS image: the page fetches
  // it over HTTP and injects the bytes into Skia, so the preloaded copy is never
  // read and would ship the file twice. The generator names exactly the fonts it
  // also lists as font-urls, and nothing else (a bitmap `.fnt` + atlas that the
  // app opens through File is not a font-url and must stay).
  const withFontExcludes = (withFontManifest['preload-excludes'] as string[]) ?? [];
  const withFontUrls = (withFontManifest['font-urls'] as string[]) ?? [];
  check('the font the page fetches is excluded from the preload set',
    withFontExcludes.length === withFontUrls.length &&
    withFontUrls.every((u) => withFontExcludes.includes(u)) &&
    withFontExcludes.every((e) => e.endsWith('Fixture.ttf')));
  check('...and the rest of the app tree is still preloaded',
    ((withFontManifest['preload-paths'] as string[]) ?? []).includes('assets'));
  check('a native build excludes nothing (it reads the real directory)',
    ((JSON.parse(readFileSync(prep(fixture('text-font', textBody, true), false).manifestPath, 'utf8')) as Record<string, unknown>)['preload-excludes']) === undefined);

  // (2b) `--exclude-file` is an fnmatch pattern, so a path that itself contains a
  // metacharacter must be escaped or it silently mis-targets: passed verbatim,
  // `My[bold].ttf` is a character class that excludes a sibling `Myb.ttf` while
  // sparing the file it names (measured against emcc 3.1.44).
  const meta = JSON.parse(readFileSync(prep(fixture('text-font-meta', textBody, true, 'My[bold].ttf'), true).manifestPath, 'utf8')) as Record<string, unknown>;
  check('a metacharacter in a font name is escaped for fnmatch',
    ((meta['preload-excludes'] as string[]) ?? [])[0] === 'assets/fonts/My[[]bold[]].ttf');

  // (3) Native is immune: CoreText enumerates the installed families, so the same
  // no-font app must NOT be warned about there (the check is web-only).
  check('the same app built for native is not warned about',
    prep(fixture('text-nofont', textBody, false), false).warnings.length === 0);

  // (4) The detector stays scoped: an app that never imports flash.text is silent
  // even with no font, so the warning still means something when it appears.
  check('an app that draws no text is not warned about',
    prep(fixture('plain-web', plainBody, false), true).warnings.length === 0);

  if (ok > 0) console.log(`[air-app-font] ${ok} font checks passed`);
  return bad;
}

const airAppFontFailures = checkAirAppFonts();
const preloadExcludeFailures = checkPreloadExcludes();

console.log(`\n${pass} passed, ${failed.length} failed, ${pass + failed.length} total`);
if (failed.length > 0) {
  console.log('Failed examples:');
  for (const f of failed) console.log(`  ${f}`);
}
if (manifestFailures.length > 0) {
  console.log('Failed manifest checks:');
  for (const f of manifestFailures) console.log(`  ${f}`);
}
if (airAppFailures.length > 0) {
  console.log('Failed air-app transport checks:');
  for (const f of airAppFailures) console.log(`  ${f}`);
}
if (webFailures.length > 0) {
  console.log('Failed web transport checks:');
  for (const f of webFailures) console.log(`  ${f}`);
}
if (requestContentTypeFailures.length > 0) {
  console.log('\n[req-ctype] failures:');
  for (const f of requestContentTypeFailures) console.log(`  ${f}`);
}
if (airAppFontFailures.length > 0) {
  console.log('Failed air-app font checks:');
  for (const f of airAppFontFailures) console.log(`  ${f}`);
}
if (preloadExcludeFailures.length > 0) {
  console.log('Failed preload-exclude checks:');
  for (const f of preloadExcludeFailures) console.log(`  ${f}`);
}
if (preloadOutputDirFailures.length > 0) {
  console.log('Failed preload output-dir checks:');
  for (const f of preloadOutputDirFailures) console.log(`  ${f}`);
}
if (httpStatusFailures.length > 0) {
  console.log('\n[httpstatus] failures:');
  for (const f of httpStatusFailures) console.log(`  ${f}`);
}
if (perfFailures.length > 0) {
  console.log('\n[perf] failures:');
  for (const f of perfFailures) console.log(`  ${f}`);
}
if (svgFailures.length > 0) {
  console.log('\n[svg] failures:');
  for (const f of svgFailures) console.log(`  ${f}`);
}
if (featureFailures.length > 0) {
  console.log('\n[features] failures:');
  for (const f of featureFailures) console.log(`  ${f}`);
}
if (textWrapFailures.length > 0) {
  console.log('\n[textwrap] failures:');
  for (const f of textWrapFailures) console.log(`  ${f}`);
}
if (ioErrorFailures.length > 0) {
  console.log('Failed ioError fidelity checks:');
  for (const f of ioErrorFailures) console.log(`  ${f}`);
}
if (jobOwnershipFailures.length > 0) {
  console.log('\n[job-owner] failures:');
  for (const f of jobOwnershipFailures) console.log(`  ${f}`);
}
if (failed.length > 0 || manifestFailures.length > 0 || lexerFailures.length > 0 || airAppFailures.length > 0 || webFailures.length > 0 || airAppFontFailures.length > 0 || preloadExcludeFailures.length > 0 || preloadOutputDirFailures.length > 0 || ioErrorFailures.length > 0 || httpStatusFailures.length > 0 || perfFailures.length > 0 || svgFailures.length > 0 ||
  textWrapFailures.length > 0 || featureFailures.length > 0 || requestContentTypeFailures.length > 0 ||
  jobOwnershipFailures.length > 0) process.exit(1);
