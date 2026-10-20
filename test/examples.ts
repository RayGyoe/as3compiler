// Test module: the end-to-end example regression (compile -> link -> run every
// example under examples/) as one node:test case per unit.
//
// Moved out of test.ts in 阶段九十六·一. The per-example PASS/FAIL lines and the
// `-o temp/regress-out/<seq>-<label>` routing are unchanged; only the driver
// changed (node:test instead of a hand-rolled pass/failed counter), which is what
// makes `node --test --test-name-pattern=dyn-prop test/examples.ts` possible.
//
// 阶段一百五十一: the units now run CONCURRENTLY (bounded pool, see JOBS below).
// This layer is pure I/O — every unit waits on a `node src/index.ts … --run`
// child, which itself waits on `cc -O2` — so overlapping them is nearly free
// wall-clock. It is the whole reason `node test.ts` used to take minutes: the
// unit groups are in-process CPU work (~35 s serial, and JS is single-threaded
// so fanning them out would buy nothing), while these ~190 subprocess units were
// awaited one at a time.
import { execFile } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { root } from './harness.ts';
import { aneHostDirName, aneHostLibName, currentAnePlatform, readAne } from '../src/ane.ts';

const runAsync = promisify(execFile);

const dir = join(root, 'examples');
const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

// Example builds must not litter the source tree. With no `-o` the compiler
// derives the `.c` and executable paths from the FIRST input file's directory,
// so the air-native directory unit (whose sorted-first source is
// src/demo/ArrayDemos.as) wrote ArrayDemos.c (1.3 MB) and the ArrayDemos Mach-O
// binary straight into examples/air-native/src/demo/ on every run — files that
// no example references and that `git status` never shows (the tree-wide
// `*.c` / `examples/*` ignore rules hide them). Route every unit's output to a
// scratch directory under temp/ (gitignored) instead, so the build products are
// a deliberate, discoverable location rather than a side effect on the sources.
const SCRATCH = join(root, 'temp', 'regress-out');
mkdirSync(SCRATCH, { recursive: true });
let unitSeq = 0;
function scratchOut(label: string): string {
  unitSeq++;
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return join(SCRATCH, `${String(unitSeq).padStart(3, '0')}-${slug}`);
}

// GUI entry points that open a window are not part of the automated regression:
// a directory must have exactly one top-level entry, and boot-gui.as duplicates
// boot.as (offscreen). They still compile standalone in pure-C mode, but the
// directory unit already uses the offscreen entry.
// air-native's Main instantiates TweenDemo, which depends on the GreenSock core
// (a third-party library directory excluded by SKIP_DIRS below). Those specific
// sources are re-added explicitly for the air-native unit (see GREENSOCK_CORE).
// `entry-ui.as` is textfield's second entry: it is the same probe with the UI grid
// turned on (`new Main(true)`), which writes a 4 MB raw bitmap on top of the
// numeric report. The directory unit must keep the single numeric entry, so the
// UI variant is compiled only by examples/textfield/run-aot-ui.sh.
const SKIP_FILES = new Set(['boot-gui.as', 'entry-ui.as']);
// Third-party library directories (e.g. com/greensock) ship with full AIR apps
// but depend on features outside this compiler's subset; they are not part of
// the regression suite's input. `shmup-stage3d` is the stage 79-83 end-to-end
// acceptance demo — it needs the full Stage3D/Context3D surface (plus the `package {}`
// no-name form) that lands across stages 80-83, so it is skipped until then.
// `air-starling-demo` is the full Starling framework (142 files) used as a
// read-only reference for API-surface research (e.g. the stage-86 reflection
// functions). It needs namespace/XML/E4X and the full Starling Stage3D surface —
// features that land in later stages — so it is skipped rather than treated as a
// passing regression unit. As of 阶段一百九十八 the directory is an external,
// untracked clone like Flappy-Starling (.gitignore `examples/air-starling-demo`);
// see examples/EXTERNAL-FIXTURES.md.
// `Flappy-Starling` (Josh Tynjala's Starling game, cloned into examples/ on
// 2026-09-26) is the same kind of third-party, read-only reference. It now builds
// and runs end to end (stage 89·33 named function expressions, 89·36 the NULL
// factory, 89·40 SharedObject — its only flash API gap), so the skip is purely a
// suite-cost decision: 127 sources plus the full Metal/Stage3D link take minutes,
// far more than any other unit. The manual acceptance procedure and the two
// remaining rendering residuals (Stage3D layer at contentScaleFactor 2, and
// fullScreenWidth/Height having no `-screensize` equivalent) are recorded in
// examples/Flappy-Starling/AOT-NOTES.md and the TODO.md 遗留待开发 table.
// `away3d-core` is the away3d-core-fp11 engine itself (479 .as files, the
// 2017-02-07 snapshot, Apache-2.0), dropped in on 2026-10-07 as the *adl
// reference* for the Stage3D / native-shader work (enhancement E6): its
// build-and-run.sh compiles a demo with mxmlc and runs it under AIR, which is
// the "what AIR actually renders" baseline our AOT Stage3D output is measured
// against. It is not regression input — the engine's own sources use language
// features outside the subset, so compiling all 479 files as one dir unit fails.
// As of 阶段一百零八 the whole tree *parses* (479/479, after the class-body
// multi-declarator and E4X computed-name fixes) and the wall has moved into
// codegen: `Vector.<Class>` (AssetLibrary.enableParsers), a type-model gap, not
// a language one. Like air-starling-demo / Flappy-Starling
// this is a third-party read-only reference, skipped rather than treated as a
// passing unit. The directory is gitignored (.gitignore `examples/away3d-core`).
// `ane-app` is here rather than in the pool because it is not an ordinary native
// build: its whole point is an AIR descriptor's <extensions>, which only --air-app
// reads, so compiling its .as files the way this pool does would produce a program
// whose createExtensionContext() answers null for the very id under test. Its own
// serial case is registered after the pool (see "example: ane-app" below), the same
// arrangement air-native has.
//
// `url-test` is here because it is an EXTERNAL, gitignored probe app
// (.gitignore `examples/url-test`), like the third-party trees above. It is listed
// even though its two sources compile fine, because listing it is what makes the
// corpus deterministic: without the entry, a local clone WAS compiled as a
// directory unit (`example: url-test/ (dir unit)`) while a fresh clone / CI never
// ran it -- so one `node test.ts` tested different things on different machines.
// A gitignored directory must not silently be a regression input; see
// examples/EXTERNAL-FIXTURES.md.
//
// `audio` is here for the same reason as `ane-app`, one step weaker: its single
// entry (`AudioPlayer.as`) is a WINDOWED program (it prints its self-check from
// inside a real window, because SoundChannel's soundComplete is dispatched at the
// frame boundary -- see src/runtime.ts as_audio_tick), so running it as a
// directory unit would open a window and sit there until the 60 s budget killed
// it. Compile+link is what matters for the suite -- the case is registered after
// the pool as "example: audio/ (windowed: compile+link only)". Note this is NOT
// the same as examples/audio.as (a top-level file, run normally): that one drives
// synthesized PCM through loadPCMFromByteArray with no window at all.
const SKIP_DIRS = new Set(['com', 'org', 'net', 'shmup-stage3d', 'air-starling-demo', 'Flappy-Starling', 'away3d-core', 'url-test', 'ane-app', 'audio']);
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

// Per-example extra CLI arguments. The SWC example needs a resource library on
// the command line (`--swc`); every other unit is driven by EXAMPLE_ENV or by a
// build manifest it names explicitly. `../temp/skin.swc` (the repo-root temp/, as
// swc.md §11 names it) is the sample the doc's measurements are written against;
// without it the unit is skipped (see below) rather than silently passing.
const EXAMPLE_ARGS: Record<string, string[]> = {
  'swc-bitmap.as': ['--swc', join(root, '..', 'temp', 'skin.swc')],
  'swc-shape.as': ['--swc', join(root, '..', 'temp', 'skin.swc')],
  // The audio backend is a build-layer choice: audio.build.json compiles
  // vendor/audio_glue.c (miniaudio) in and defines ASC_HAVE_AUDIO, which is what
  // turns the as_audio_* seam into a real device. Without it the example cannot
  // decode at all, and the run is about the no-backend report instead. A CI
  // runner links the same glue but has no device, so the example branches on
  // SoundMixer.areSoundsInaccessible() and passes either way.
  'audio.as': ['--manifest', join(dir, 'audio.build.json')],
  // [Embed]: an embedded image is decoded through Skia and an embedded mp3 through
  // the audio seam, so the example links both backends. It is about the AS3
  // contract of the generated classes (Kind, Class-value identity, decoded
  // pixels), which only exists once those seams are real.
  'embed.as': ['--manifest', join(dir, 'embed.build.json')],
  // 阶段一百二十八：bakecrisp 断言的**是像素**（`BitmapData.draw` 的 `getPixel32` 墨迹包围盒
  // /边框线宽/`pixdiff`），而纯 C 构建没有光栅后端（draw 是空桩 ⇒ 墨迹 0x0），故必须链 Skia。
  // 与 autobake.as 的区别正在此：那个只 trace、不做像素断言，三种构建下都能「过」。
  'bakecrisp.as': ['--manifest', join(dir, 'bakecrisp.build.json')],
  // scrollrect-clip.as 断言的也是**像素**（scrollRect 窗口的着色包围盒与窗口左上角
  // 色条），纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as 一样链 Skia。
  'scrollrect-clip.as': ['--manifest', join(dir, 'scrollrect-clip.build.json')],
  // autobake-scrollrect.as 断言的是**自动烘焙失效**后的像素（祖先烘焙 → 改 scrollRect →
  // draw 必须变），而且它要靠 `stage.render` 跑每帧指纹 pass 才会真的进入烘焙态，
  // 两者都只在 Skia 构建下存在，故同样链 Skia。
  'autobake-scrollrect.as': ['--manifest', join(dir, 'autobake-scrollrect.build.json')],
  // autobake-origin.as（阶段一百九十一）断言的是**自动烘焙的原点口径**：分数坐标上的对象被烘焙
  // 后必须与活态逐像素相同（真机上这是用户报的「按钮鼠标悬停抖动」）。同 autobake-scrollrect 一样，
  // 它要靠 `stage.render` 跑每帧指纹 pass 才会真的进入烘焙态，而且断言是像素 —— 纯 C 构建没有
  // 光栅后端，故同样链 Skia。
  'autobake-origin.as': ['--manifest', join(dir, 'autobake-origin.build.json')],
  // draw-over.as 断言的也是**像素**（draw() 的 SourceOver 合成值），同样需要光栅后端。
  'draw-over.as': ['--manifest', join(dir, 'draw-over.build.json')],
  // autosize-metrics.as 断言的是**字体度量**（`textWidth`/`textHeight`/`numLines`）与
  // 「反复 `BitmapData.draw` 后字段宽度不得自噬」，两者都只在 Skia 文本后端下存在，
  // 故与 bakecrisp.as 一样链 Skia（阶段一百六十八的 autoSize/字族兜底回归）。
  'autosize-metrics.as': ['--manifest', join(dir, 'autosize-metrics.build.json')],
  // tf-scale-metrics.as 断言的是**字体度量 + 字形光栅**（缩放字段的 textWidth/textHeight 口径，
  // 以及「字形按 scaleY 整体缩放、scaleX 不拉宽」的 ink 宽），两者都只在 Skia 文本后端下存在，
  // 故与 bakecrisp.as 一样链 Skia（阶段一百六十九的缩放口径回归）。
  'tf-scale-metrics.as': ['--manifest', join(dir, 'tf-scale-metrics.build.json')],
  // sbtn-null-up.as 断言的也是**像素**（`upState==NULL` 时 `BitmapData.draw` 什么都不能画、
  // 有 up 态时画的正是 up 态），而纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as 一样链 Skia。
  'sbtn-null-up.as': ['--manifest', join(dir, 'sbtn-null-up.build.json')],
  // swc-mc-button.as（阶段一百七十一）是 MovieClip 按钮态的渲染层回归：状态在绘制 pass 里结算，
  // 必须真的走一帧（`stage.render`）才观察得到，而且要用像素差断言「状态真的画出来了」——两者都
  // 只在 Skia 构建下存在，故链 swc-bitmap.build.json（它已经带上了 temp/skin.swc，与 swc-shape.as
  // 的渲染层变体同一路子）。
  'swc-mc-button.as': ['--manifest', join(dir, 'swc-bitmap.build.json')],
  // examples/textfield/ 是 TextField 显示矩阵探针（docs/zh-cn/flash-text.md §3）：它报的
  // `textWidth`/`textHeight`/`getLineMetrics` 只有在 Skia 文本后端下才存在，故目录单元
  // 与 bakecrisp.as 一样链 Skia。键带尾部 `/` 以区分目录单元与同名 .as。
  'textfield/': ['--manifest', join(dir, 'textfield', 'textfield.build.json')],
  // ane/ is the FRE host end-to-end: a real ExtensionContext.call() crossing into a
  // native extension and back (docs/zh-cn/ane.md). The manifest is what turns --ane
  // on, and what it points at is a STAGING TREE (ext-aot/com.example.probe), not a
  // packed .ane -- §4.6's default shape. Without either, the build is an ordinary
  // native build and createExtensionContext correctly answers null. The unit is
  // SKIPPED loudly on hosts that cannot load a native extension at all (see
  // aneHostSkipReason). Its --air-app twin is examples/ane-app/, whose own case is
  // registered below the pool.
  'ane/': ['--manifest', join(dir, 'ane', 'ane.build.json')],
};
// Examples that need an input file absent from the tree. Skipped loudly so the
// suite never reports coverage it did not exercise.
const EXAMPLE_REQUIRES: Record<string, string> = {
  'swc-bitmap.as': join(root, '..', 'temp', 'skin.swc'),
  'swc-shape.as': join(root, '..', 'temp', 'skin.swc'),
  'swc-mc-button.as': join(root, '..', 'temp', 'skin.swc'),
};

// Why the extension-bearing example units (`ane/`, `ane-app/`) are skipped instead
// of run on some hosts.
//
// Loading a native extension needs THREE things to agree at once, and all three
// are host-specific: an AIR platform key for this host (currentAnePlatform), a
// built FRE host library for that key's directory (lib/bin/<dir>/asaot.*), and a
// package that actually declares that key. On the arm64 macOS CI runner the second
// one is missing -- only the Windows host library is built today -- and on a
// Windows x86 host the third one is (the fixture ships a Windows-x64 DLL).
// Returning the reason here, rather than hardcoding 'skip on darwin', keeps the
// gate derived from the SAME three decisions the build itself makes: a host that
// can build the example is a host the build would not reject.
//
// `pkg` is whatever the build would be handed as `--ane`: either a package or, for
// a staging tree, the directory holding extension.xml. Both examples share ONE
// fixture tree (examples/ane/build-ane.{bat,sh} writes both copies), so they answer this
// question identically -- but the path is a parameter rather than a constant so a
// future example cannot silently reuse another's answer.
//
// Names the same file the BUILD names when it decides a host library is present
// (src/index.ts stages `asaot.dll` next to the executable and errors if it is not
// in lib/bin/<dir>/), so the gate cannot disagree with the build. Deliberately
// not `asaot.lib`: that is the IMPORT library for linking, not the runtime the
// executable loads.
//
// The NAME is no longer a constant here: it comes from aneHostLibName, the same
// place src/index.ts and `as-aot doctor` get it, so a host whose library is called
// something else (`libasaot.dylib` on macOS) cannot be gated on the Windows name
// and skipped for a file that is right there. The Windows/macOS split is in
// docs/zh-cn/ane.md §3.5.
function aneHostSkipReason(pkg: string): string | null {
  const key = currentAnePlatform();
  if (key === '') return 'this host has no AIR platform key (see docs/zh-cn/ane.md §3.4)';
  const dirName = aneHostDirName(key);
  let hostLib: string;
  try {
    hostLib = join(root, 'lib', 'bin', dirName, aneHostLibName(key));
  } catch (e) {
    // A key that exists but has no host library (iOS links its extensions into the
    // application image) is a host fact, not a missing build step, so it skips with
    // the header's own wording instead of "build it first".
    return String((e as Error).message);
  }
  if (!existsSync(hostLib)) return `the FRE host library (lib/bin/${dirName}/${basename(hostLib)}) is not built for this host`;
  let declares = false;
  try {
    declares = readAne(pkg).platforms.some((p) => p.name === key);
  } catch {
    return 'the ANE fixture could not be read';
  }
  if (!declares) return `the ANE fixture declares no <platform name="${key}"> entry`;
  return null;
}
// The fixture both extension examples are built against. Named once so the two
// units cannot drift onto different trees.
const ANE_FIXTURE = 'com.example.probe';

// The concurrency the example suite actually runs at.
//
// node:test executes TOP-LEVEL tests strictly serially (each is awaited before
// the next one starts), so a per-test `concurrency` option cannot help here —
// the lever is a parent suite, hence the `describe(…, { concurrency })` below.
// Measured on 24 spread-out examples: 91.8 s at jobs=1 vs 13.6 s at jobs=8.
//
// Cap at 6 rather than the core count: each child is a `cc -O2` link over up to
// ~20 MB of static libraries (Skia/SDL2/curl), so unbounded fan-out trades wall
// time for memory pressure on the linker. `ASC_TEST_JOBS=1` restores the exact
// original fully serial order (the fallback to reach for if a future red is ever
// suspected of being concurrency-induced); any other positive integer overrides.
const JOBS = (() => {
  const raw = process.env.ASC_TEST_JOBS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return Math.min(availableParallelism(), 6);
})();

// Run one example unit: compile -> link -> run. node:test turns a non-zero exit
// into a test failure, so this only surfaces the captured output and rethrows.
//
// The spawn must be ASYNC (`execFile`, not `execFileSync`). A synchronous spawn
// pins the single JS thread for the child's whole lifetime, which is what kept
// this file serial no matter what concurrency the runner was given: with the
// sync form the pool below would still run one unit at a time. `out` is passed
// in (rather than computed here) so the `temp/regress-out/<seq>-<label>` paths
// stay deterministic under concurrency — they are numbered in registration
// order, not completion order.
async function runExample(label: string, args: string[], out: string, env?: Record<string, string>): Promise<void> {
  try {
    await runAsync('node', ['src/index.ts', ...args, '-o', out, '--run'], {
      cwd: root,
      timeout: EXAMPLE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    console.log(`PASS  ${label}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; signal?: string | null };
    console.log(`FAIL  ${label}`);
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.signal === 'SIGTERM') console.log(`  (timed out after ${EXAMPLE_TIMEOUT_MS}ms)`);
    throw err;
  }
}

// One node:test case per example unit, so a single example can be re-run with
// e.g. `node --test --test-name-pattern=dyn-prop test/examples.ts`. The wrapper
// suite only adds a `describe` level to the report; the case names are unchanged,
// so `--test-name-pattern` still matches them directly.
describe(`examples (jobs=${JOBS})`, { concurrency: JOBS }, () => {
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
      const label = `${e.name}/ (${names.join(', ')})`;
      const out = scratchOut(label);
      test(`example: ${e.name}/ (dir unit)`, async (t) => {
        if (e.name === 'ane') {
          const why = aneHostSkipReason(join(subDir, 'ext-aot', ANE_FIXTURE));
          if (why) {
            console.log(`SKIP  ${label} (needs a platform that can load a native extension: ${why})`);
            t.skip(why);
            return;
          }
        }
        // Live guard: the directory unit must leave its source tree untouched.
        // Snapshot before/after so the assertion covers whatever the compiler
        // happens to write (a future `-o` default change would show up here, not in
        // a structural grep of this file).
        //
        // The snapshot MUST be recursive: the litter that motivated this guard
        // landed in a NESTED directory (air-native's sorted-first source is
        // src/demo/ArrayDemos.as, so with no `-o` the default output path put
        // ArrayDemos.c + the ArrayDemos binary into examples/air-native/src/demo/).
        // A top-level-only readdir would have watched the one directory the bug
        // never touched and reported PASS.
        const before = readdirSync(subDir, { recursive: true }).sort();
        await runExample(label, [...subFiles, ...(EXAMPLE_ARGS[`${e.name}/`] ?? [])], out);
        const after = readdirSync(subDir, { recursive: true }).sort();
        assert.deepStrictEqual(after, before,
          `[no-src-litter] ${e.name}/ wrote into its own source dir: ${after.filter((n) => !before.includes(n)).join(', ')}`);
      });
    } else if (e.name.endsWith('.as')) {
      const required = EXAMPLE_REQUIRES[e.name];
      const out = scratchOut(e.name);
      test(`example: ${e.name}`, async (t) => {
        if (required && !existsSync(required)) {
          console.log(`SKIP  ${e.name} (needs ${resolve(required)}, not present)`);
          t.skip(`needs ${resolve(required)}, not present`);
          return;
        }
        await runExample(e.name, [join(dir, e.name), ...(EXAMPLE_ARGS[e.name] ?? [])], out, EXAMPLE_ENV[e.name]);
      });
    }
  }
});

// The AIR-app GPU window path (阶段一百二十六). The directory unit above compiles
// air-native's .as files WITHOUT --air-app, so ASC_RENDER_WINGPU is never defined
// there — which means the whole GPU-window code path (the sk_gpu_* seam and the
// metal_glue.mm / d3d_glue.cc backends behind it) was compiled by NO test at all.
// That blindness is not theoretical: on 2026-10-09 the backend-neutral seam was
// implemented on D3D12 only, so every macOS AIR app failed to LINK
// (`_sk_gpu_begin_frame` / `_sk_gpu_flush`, referenced from _ASC_window_render)
// while the whole suite stayed green.
// This case builds the demo the way a user does and checks only that it COMPILES
// AND LINKS: --run would open a real window and never return (and the smoke run is
// covered by the air-native directory unit above, which is the same program).
// It carries its own timeout: this is the only case that compiles Skia, SDL2 and
// curl glue from source and links ~20 MB of static libraries.
test('example: air-native (--air-app + renderMode=direct: compile+link only)', async (t) => {
  const xml = join(dir, 'air-native', 'air-native-app.xml');
  const vendorLibs = ['skia', 'sdl2', 'curl'].map((v) => join(root, 'vendor', v));
  if (!existsSync(xml) || !vendorLibs.every((p) => existsSync(p))) {
    console.log('SKIP  air-native (--air-app: needs the native Skia/SDL2/curl vendor libs)');
    t.skip('needs vendor/skia, vendor/sdl2 and vendor/curl');
    return;
  }
  // Deliberately OUTSIDE the concurrent suite above (it is registered after it,
  // and top-level tests are serial): this one compiles Skia/SDL2/curl glue from
  // source and links ~20 MB of static libraries, so it wants the machine to
  // itself rather than one of the six pool slots.
  await runAsync('node', ['src/index.ts', '--air-app', xml, '--main-class', 'Main',
    '--target', 'native', '-o', scratchOut('air-native-app')],
    { cwd: root, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  console.log('PASS  air-native (--air-app)');
});

test('example: native-window.as (windowed: compile+link only)', async (t) => {
  // A windowed program is not part of the run suite -- native-window.as opens a real
  // window, ticks on the application frame clock and only returns when
  // nativeApplication.exit() is reached -- but it is where every NativeWindow pin in
  // test/unit/platform.ts is read from, so it has to keep COMPILING and LINKING.
  // (Manual run: `node src/index.ts examples/native-window.as
  //  --manifest examples/window.build.example.json --run`.)
  const manifest = join(dir, 'window.build.example.json');
  const vendorLibs = ['skia', 'sdl2'].map((v) => join(root, 'vendor', v));
  if (!existsSync(manifest) || !vendorLibs.every((p) => existsSync(p))) {
    console.log('SKIP  native-window (needs the native Skia/SDL2 vendor libs)');
    t.skip('needs vendor/skia and vendor/sdl2');
    return;
  }
  // Serial, like the air-native case above: it links ~20 MB of static libraries.
  await runAsync('node', ['src/index.ts', 'examples/native-window.as',
    '--manifest', manifest, '-o', scratchOut('native-window')],
    { cwd: root, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  console.log('PASS  native-window (compile+link)');
});

// The encoded-audio path: Sound.load(URLRequest) over a real .mp3 fixture, then
// SoundChannel playback and soundComplete.
//
// Neither existing audio example covers it. `examples/audio.as` feeds synthesized
// PCM to loadPCMFromByteArray and `examples/embed.as` decodes an mp3 embedded at
// compile time -- so the whole FILE-loading route (bytesLoaded/bytesTotal/url/id3
// after an asynchronous load) had no regression input at all, and the three pins
// that used to assert it were reading a THIRD-PARTY Starling sample's AssetManager
// (deleted with the external fixtures in 阶段一百九十八). This one is self-owned.
//
// It is WINDOWED and therefore compile+link only: soundComplete is dispatched by
// as_audio_tick() from the window frame loop, so the example must run inside a real
// window -- which is also why `audio/` is in SKIP_DIRS above. The 23 self-checks run
// on a manual windowed launch (`--run`, see the source header for the command).
// Serial like the two cases above: it compiles the Skia/SDL2/miniaudio glue from
// source and links ~20 MB of static libraries.
test('example: audio/ (windowed: compile+link only)', async (t) => {
  const entry = join(dir, 'audio', 'AudioPlayer.as');
  const manifest = join(dir, 'audio', 'player.build.json');
  const fixture = join(dir, 'audio', 'clip.mp3');
  const vendorLibs = ['skia', 'sdl2'].map((v) => join(root, 'vendor', v));
  if (!existsSync(entry) || !existsSync(manifest) || !existsSync(fixture)
      || !vendorLibs.every((p) => existsSync(p))) {
    console.log('SKIP  audio/ (needs the native Skia/SDL2 vendor libs and examples/audio/clip.mp3)');
    t.skip('needs vendor/skia, vendor/sdl2 and examples/audio/{AudioPlayer.as,player.build.json,clip.mp3}');
    return;
  }
  await runAsync('node', ['src/index.ts', entry,
    '--manifest', manifest, '-o', scratchOut('audio-player')],
    { cwd: root, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  console.log('PASS  audio/ (compile+link)');
});

// The DESCRIPTOR-to-extension chain, end to end: an app whose app.xml declares
// `<extensions><extensionID>` and knows no path at all.
//
// Four separate mechanisms have to agree, and each one is invisible to every other
// test in this file:
//   1. parseAirApp() reads the <extensions> id out of the descriptor.
//   2. --air-app resolves that id over the app directory's ext-aot/ (then lib/, then
//      ext-folder/) -- unit: air-app/Extensions pins the resolution itself, but only
//      against temp directories it writes.
//   3. the resolved path reaches the MANIFEST as `ane-paths`, which is what turns
//      --ane on and makes the generated C carry as_ane_descs[].
//   4. the build stages the library as <out>/extensions/<id>/<platform>/ and the
//      program actually loads it -- the only step that proves a real tree rather
//      than a well-shaped path.
//
// Unlike air-native's case directly above, this one CAN run: the descriptor is
// <visible>false</visible>, so the program renders one frame offscreen and exits
// instead of opening a window that never returns. That is what makes the assertions
// inside examples/ane-app/src/Main.as (a context for the declared id, native code
// answering, a native status event, dispose) part of the coverage rather than prose.
//
// Serial, and gated three ways, all of which are host facts rather than
// preferences: the native Skia vendor libs (this compiles skia_glue.cc and links
// ~20 MB of static libraries -- and `needs a real GDI` is what the two src/air-app.ts
// link-set defects above were), the FRE host library, and a fixture that declares
// this host's AIR platform key. On the arm64 macOS CI runner the last two fail, so
// the case SKIPS loudly there instead of pretending to have covered it.
test('example: ane-app (--air-app + "<extensions>" id -> ext-aot: build+stage+run)', async (t) => {
  const appDir = join(dir, 'ane-app');
  const xml = join(appDir, 'ane-app.xml');
  const vendorLibs = ['skia', 'sdl2', 'curl'].map((v) => join(root, 'vendor', v));
  if (!existsSync(xml) || !vendorLibs.every((p) => existsSync(p))) {
    console.log('SKIP  ane-app (--air-app: needs the native Skia/SDL2/curl vendor libs)');
    t.skip('needs vendor/skia, vendor/sdl2 and vendor/curl');
    return;
  }
  const fixture = join(appDir, 'ext-aot', ANE_FIXTURE);
  const why = aneHostSkipReason(fixture);
  if (why) {
    console.log(`SKIP  ane-app (needs a platform that can load a native extension: ${why})`);
    t.skip(why);
    return;
  }
  const out = scratchOut('ane-app');
  await runAsync('node', ['src/index.ts', '--air-app', xml, '--main-class', 'aneapp.Main',
    '--target', 'native', '-o', out, '--run'],
    { cwd: root, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });

  // The two artifacts of step 3/4 above, asserted where they land. The run already
  // proves the library loaded (a null context throws no Error but fails an assertion
  // -- see Main.as), so these two exist to catch the quieter shape of the same
  // failure: a manifest that records the path but a `load` that resolves somewhere
  // else (the runtime resolves `extensions/` next to the EXECUTABLE, so an -o that
  // puts the executable outside the build directory is a real trap).
  const manifest = JSON.parse(readFileSync(join(appDir, 'ane-app.build.json'), 'utf8')) as Record<string, unknown>;
  assert.deepStrictEqual(manifest['ane-paths'], [`ext-aot/${ANE_FIXTURE}`],
    'the descriptor id must resolve to the ext-aot staging tree');
  // Next to the EXECUTABLE, which on Windows means the same directory with a `.exe`
  // appended to the basename -- so the directory is `dirname(out)`, not `out`.
  const staged = join(dirname(out), 'extensions', ANE_FIXTURE);
  assert.ok(existsSync(staged), `the extension was not staged beside the executable: ${staged}`);
  console.log('PASS  ane-app (--air-app)');
});
