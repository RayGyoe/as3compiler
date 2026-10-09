// Test module: the end-to-end example regression (compile -> link -> run every
// example under examples/) as one node:test case per unit.
//
// Moved out of test.ts in 阶段九十六·一. The per-example PASS/FAIL lines and the
// `-o temp/regress-out/<seq>-<label>` routing are unchanged; only the driver
// changed (node:test instead of a hand-rolled pass/failed counter), which is what
// makes `node --test --test-name-pattern=dyn-prop test/examples.ts` possible.
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import { root } from './harness.ts';

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
const SKIP_DIRS = new Set(['com', 'org', 'net', 'shmup-stage3d', 'air-starling-demo', 'Flappy-Starling', 'away3d-core']);
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
};
// Examples that need an input file absent from the tree. Skipped loudly so the
// suite never reports coverage it did not exercise.
const EXAMPLE_REQUIRES: Record<string, string> = {
  'swc-bitmap.as': join(root, '..', 'temp', 'skin.swc'),
  'swc-shape.as': join(root, '..', 'temp', 'skin.swc'),
};

// Run one example unit: compile -> link -> run. node:test turns a non-zero exit
// into a test failure, so this only surfaces the captured output and rethrows.
function runExample(label: string, args: string[], env?: Record<string, string>): void {
  try {
    execFileSync('node', ['src/index.ts', ...args, '-o', scratchOut(label), '--run'], { cwd: root, stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS, env: { ...process.env, ...env } });
    console.log(`PASS  ${label}`);
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; signal?: string };
    console.log(`FAIL  ${label}`);
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    if (e.signal === 'SIGTERM') console.log(`  (timed out after ${EXAMPLE_TIMEOUT_MS}ms)`);
    throw err;
  }
}

// One node:test case per example unit, so a single example can be re-run with
// e.g. `node --test --test-name-pattern=dyn-prop test/examples.ts`.
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
    test(`example: ${e.name}/ (dir unit)`, () => {
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
      runExample(`${e.name}/ (${names.join(', ')})`, subFiles);
      const after = readdirSync(subDir, { recursive: true }).sort();
      assert.deepStrictEqual(after, before,
        `[no-src-litter] ${e.name}/ wrote into its own source dir: ${after.filter((n) => !before.includes(n)).join(', ')}`);
    });
  } else if (e.name.endsWith('.as')) {
    const required = EXAMPLE_REQUIRES[e.name];
    test(`example: ${e.name}`, (t) => {
      if (required && !existsSync(required)) {
        console.log(`SKIP  ${e.name} (needs ${resolve(required)}, not present)`);
        t.skip(`needs ${resolve(required)}, not present`);
        return;
      }
      runExample(e.name, [join(dir, e.name), ...(EXAMPLE_ARGS[e.name] ?? [])], EXAMPLE_ENV[e.name]);
    });
  }
}

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
test('example: air-native (--air-app + renderMode=direct: compile+link only)', (t) => {
  const xml = join(dir, 'air-native', 'air-native-app.xml');
  const vendorLibs = ['skia', 'sdl2', 'curl'].map((v) => join(root, 'vendor', v));
  if (!existsSync(xml) || !vendorLibs.every((p) => existsSync(p))) {
    console.log('SKIP  air-native (--air-app: needs the native Skia/SDL2/curl vendor libs)');
    t.skip('needs vendor/skia, vendor/sdl2 and vendor/curl');
    return;
  }
  execFileSync('node', ['src/index.ts', '--air-app', xml, '--main-class', 'Main',
    '--target', 'native', '-o', scratchOut('air-native-app')],
    { cwd: root, stdio: 'pipe', timeout: 240_000 });
  console.log('PASS  air-native (--air-app)');
});
