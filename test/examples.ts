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
import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { root } from './harness.ts';
import { aneHostDirName, aneHostLibName, currentAnePlatform, readAne } from '../src/ane.ts';

const runAsync = promisify(execFile);

// The throwaway HOME that `move-to-trash.as` runs against (see EXAMPLE_ENV).
const trashHome = join(root, 'temp', 'trash-home');
mkdirSync(trashHome, { recursive: true });

// The symlink fixture that `file-symlink.as` runs against (EXAMPLE_ENV points HOME here
// too). Git can store symlinks, but not a symlink to `.` reliably, and the tree has to be
// recreated from scratch anyway so a half-finished earlier run cannot leave it wrong: the
// example asserts exact counts, so it must never see leftovers. `fx/` holds a real dir, a
// real file, a link to each of those, a dangling link, and a link to `fx` itself -- the
// cycle that is the difference between a guarded walk and one that runs away.
const symHome = join(root, 'temp', 'sym-home');
const symFx = join(symHome, 'fx');
// WINDOWS ACCOUNT CAPABILITY, not a missing build step: creating a symlink needs
// Developer Mode or SeCreateSymbolicLinkPrivilege, and a plain (non-elevated, non-dev-mode)
// account gets `EPERM` on every call. This used to be fatal at MODULE LOAD, so one EPERM
// took all ~190 example units down with it -- the suite reported nothing about the other
// examples, which is a worse outcome than two loudly skipped units. The two units that
// read a tree of links now skip with the reason (see SYMLINK_NEEDS_FIXTURE below); every
// other unit is unaffected, and on any host that CAN create links (macOS CI, a Windows box
// with Developer Mode) nothing changes.
let symlinkSkipReason: string | null = null;
function tryLink(target: string, path: string): void {
  if (symlinkSkipReason !== null) return;
  try { symlinkSync(target, path); }
  catch (e) {
    const code = (e as { code?: string }).code || String(e);
    symlinkSkipReason = `this host's account cannot create symlinks (${code}): Windows needs Developer Mode
         or SeCreateSymbolicLinkPrivilege`;
    console.log('NOTE  unable to build the symlink fixture: ' + symlinkSkipReason);
  }
}
rmSync(symFx, { recursive: true, force: true });
mkdirSync(join(symFx, 'sub'), { recursive: true });
writeFileSync(join(symFx, 'real.txt'), 'hello');       // 5 bytes
writeFileSync(join(symFx, 'sub', 'inner.txt'), 'xyz'); // 3 bytes
tryLink('real.txt', join(symFx, 'link-file.txt'));
tryLink('sub', join(symFx, 'link-dir'));
tryLink('nope', join(symFx, 'dangling'));
tryLink('.', join(symFx, 'loop'));

// The example units whose assertions count entries in a tree of LINKS. They need the
// fixture above, so they are the only ones the capability gate below may skip.
const SYMLINK_NEEDS_FIXTURE = new Set(['file-symlink.as', 'file-listing-async.as', 'file-ops.as']);

// The fixture that `file-listing-async.as` runs against (EXAMPLE_ENV points HOME here for
// the same reason as file-symlink: the example reaches the tree through File.userDirectory).
// It is rebuilt from scratch every run because the example asserts exact counts. `noread/`
// is chmod 000 on purpose: an unreadable directory is the one odd shape that is NOT an
// error in AIR -- measured on adl 51.4.1, both the sync and the async listing answer an
// empty array -- so the example pins it, and it is the shape a real cleaner meets most.
// IMPORTANT: a 000 directory cannot be removed (`rm -rf` reports EACCES and leaves it),
// so the mode must not outlive the run. It is restored (a) here, which heals a leftover
// from a killed run, and (b) in the after() hook below, so an ordinary run leaves temp/
// removable. The directory is left EMPTY so that even a leftover is a one-rmdir fix.
const listingHome = join(root, 'temp', 'listing-home');
const listingFx = join(listingHome, 'fx');
const listingNoread = join(listingFx, 'noread');
try { chmodSync(listingNoread, 0o755); } catch { /* not there: first run */ }
rmSync(listingFx, { recursive: true, force: true });
mkdirSync(join(listingFx, 'sub'), { recursive: true });
mkdirSync(listingNoread, { recursive: true });
writeFileSync(join(listingFx, 'a.txt'), 'a');
writeFileSync(join(listingFx, 'b.txt'), 'bb');
writeFileSync(join(listingFx, 'sub', 'inner.txt'), 'xyz');
tryLink('a.txt', join(listingFx, 'link-file.txt'));
chmodSync(listingNoread, 0o000);
after(() => { try { chmodSync(listingNoread, 0o755); } catch { /* already gone */ } });

// The fixture `file-ops.as` runs against (阶段二百九十八): the link shapes its deletion
// assertions need. `linkdir` points at `dir`, which must still be there after the
// link is deleted -- that is the whole difference between deleting a link and
// following it. `work/` is NOT built here: the example creates and removes it on
// its own, and a fresh one every run keeps a half-finished previous run from
// making the assertions race.
const fileOpsHome = join(root, 'temp', 'fileops-home');
const fileOpsFx = join(fileOpsHome, 'fx');
rmSync(fileOpsFx, { recursive: true, force: true });
rmSync(join(fileOpsHome, 'work'), { recursive: true, force: true });
mkdirSync(join(fileOpsFx, 'dir'), { recursive: true });
writeFileSync(join(fileOpsFx, 'dir', 'inner.txt'), 'x');
tryLink('dir', join(fileOpsFx, 'linkdir'));
tryLink('nope', join(fileOpsFx, 'dangle'));

// The fixture `file-audit.as` runs against (阶段二百九十九): nothing but its own
// HOME. The example creates and removes `audit-work/` under it, and it must not be
// the repo's HOME or another unit's, because it copies trees around inside that
// tree. It is rebuilt from scratch every run so a killed previous run cannot leave
// a directory that makes `createDirectory()` throw #3003.
const auditHome = join(root, 'temp', 'audit-home');
rmSync(auditHome, { recursive: true, force: true });
mkdirSync(auditHome, { recursive: true });

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
// sources live in the shared root examples/as-library and are named by
// GREENSOCK_CORE; the app reaches them through `--as-class-path` when the build
// goes through --air-app, and as explicit file inputs in this pool.
// `entry-ui.as` is textfield's second entry: it is the same probe with the UI grid
// turned on (`new Main(true)`), which writes a 4 MB raw bitmap on top of the
// numeric report. The directory unit must keep the single numeric entry, so the
// UI variant is compiled only by examples/textfield/run-aot-ui.sh.
//
// `system-exit-status.as` is here for a third reason: the pool runs every example
// expecting status 0 (node:test turns a non-zero exit into a failure), and this
// example's whole point is that `System.exit(7)` makes the process exit 7. It is
// compiled and run by the serial case below instead (阶段二百四十五).
const SKIP_FILES = new Set(['boot-gui.as', 'entry-ui.as', 'system-exit-status.as']);
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
// The shared AS3 library root (阶段二百五十四). air-native used to VENDOR its
// third-party sources inside its own source root (examples/air-native/src/com,
// 352 tracked files), which made a library part of one app and forced this file
// to name seven of them by hand. They now live in examples/as-library and enter
// the build through `--as-class-path` -- the shared-source-root feature added in
// 阶段二百五十 -- so one copy serves every app.
const AS_LIBRARY = join(dir, 'as-library');
// GreenSock core files that air-native's TweenDemo actually reaches. Only these
// are pulled in; the rest of com/greensock (easing/loading/other plugins) stays
// outside the subset and is not compiled. Paths are relative to AS_LIBRARY.
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
  // File.moveToTrash needs a home whose Trash it may write to and then clean up.
  // The suite must not fill the developer's own Trash with one file per run, and
  // it must not depend on TCC: a terminal-launched process can stat a known name
  // inside the real ~/.Trash but cannot enumerate or remove it, so a real-HOME
  // run could not assert on its result or delete it afterwards. HOME therefore
  // points at a scratch directory under temp/ (same volume as the repo, which the
  // trash layout depends on), and the example creates its candidate file inside
  // that HOME so the two cannot land on different volumes.
  'move-to-trash.as': { HOME: trashHome },
  // File.isSymbolicLink needs a tree that actually contains links, and the example
  // reaches it through File.userDirectory (there is no environment API in AS3 to pass a
  // path in). Both HOME and USERPROFILE point at the fixture because that is the pair of
  // names `as_home_dir()` reads on POSIX and Windows respectively; on a Windows HOST the
  // key below is not what AIR's File.userDirectory reads, so there the example reports
  // itself skipped instead of asserting nothing (see the fixture check in the source).
  'file-symlink.as': { HOME: symHome, USERPROFILE: symHome },
  // Same shape of fixture problem as file-symlink (the example reaches its tree through
  // File.userDirectory, and a directory listing cannot be asserted on an empty one). This
  // one additionally needs a directory it cannot OPEN, since an unreadable directory is the
  // input that separates "empty listing" from "ioError" (see the fixture comment above).
  'file-listing-async.as': { HOME: listingHome, USERPROFILE: listingHome },
  // file-ops (阶段二百九十八) pins the DELETION rules, and the rule that needs a
  // fixture is the link one: AIR deletes the LINK, never its target, so a link to
  // a directory must survive as a target while the link itself goes away. The tree
  // is rebuilt from scratch every run for the same reason as the other two, and it
  // is its own home so the example's deletes cannot race another unit that walks
  // temp/ concurrently.
  'file-ops.as': { HOME: fileOpsHome, USERPROFILE: fileOpsHome },
  // file-audit (阶段二百九十九) pins the FileStream IDataInput/IDataOutput surface and
  // the File members that came with it, and it moves whole directory trees around;
  // it gets a home of its own for the same reason file-ops does.
  'file-audit.as': { HOME: auditHome, USERPROFILE: auditHome },
  // The out-of-memory path needs a 32-bit address space that has actually run out,
  // which no CI runner and no fresh test process has. Making the segment carve fail
  // on request is the only way this unit can assert the same thing everywhere.
  'oom-error.as': { ASC_FORCE_OOM_MIN: '4194304' },
  // The C++ half of the same wall (阶段二百八十): Skia and the STL answer a
  // refused allocation by throwing std::bad_alloc, which reached std::terminate
  // and aborted with 0xC0000409. Forcing the first operator new after startup to
  // fail is what makes that path assertable where memory is plentiful.
  'oom-cxx.as': { ASC_FORCE_CXX_OOM: '1' },
};

// Per-example extra CLI arguments. The SWC example needs a resource library on
// the command line (`--swc`); every other unit is driven by EXAMPLE_ENV or by a
// build manifest it names explicitly. The sample is the repo-TRACKED
// `examples/embed-assets/skin.swc` — an out-of-tree `../temp/skin.swc` would make
// every fresh clone (and CI) skip the three swc units silently, which is exactly
// the coverage shortfall the loud skip below exists to surface. If the fixture is
// absent the unit is skipped loudly rather than silently passing.
const EXAMPLE_ARGS: Record<string, string[]> = {
  'swc-bitmap.as': ['--swc', join(dir, 'embed-assets', 'skin.swc')],
  'swc-shape.as': ['--swc', join(dir, 'embed-assets', 'skin.swc')],
  // The audio backend is a build-layer choice: audio.build.json compiles
  // vendor/audio_glue.c (miniaudio) in and defines ASC_HAVE_AUDIO, which is what
  // turns the as_audio_* seam into a real device. Without it the example cannot
  // decode at all, and the run is about the no-backend report instead. A CI
  // runner links the same glue but has no device, so the example branches on
  // SoundMixer.areSoundsInaccessible() and passes either way.
  'audio.as': ['--manifest', join(dir, 'audio.build.json')],
  // The menu-bar status item only exists when the build asked for it
  // (`--features tray`, stage 二百六十): without that manifest the same AS3 must
  // fail exactly like AIR (#2012), which is the unit pin's job, not this example's.
  'status-item.as': ['--manifest', join(dir, 'status-item.build.json')],
  // [Embed]: an embedded image is decoded through Skia and an embedded mp3 through
  // the audio seam, so the example links both backends. It is about the AS3
  // contract of the generated classes (Kind, Class-value identity, decoded
  // pixels), which only exists once those seams are real.
  'embed.as': ['--manifest', join(dir, 'embed.build.json')],
  // 阶段一百二十八：bakecrisp 断言的**是像素**（`BitmapData.draw` 的 `getPixel32` 墨迹包围盒
  // /边框线宽/`pixdiff`），而纯 C 构建没有光栅后端（draw 是空桩 ⇒ 墨迹 0x0），故必须链 Skia。
  // 与 autobake.as 的区别正在此：那个只 trace、不做像素断言，三种构建下都能「过」。
  'bakecrisp.as': ['--manifest', join(dir, 'bakecrisp.build.json')],
  // oom-cxx.as needs a C++ allocation to refuse, i.e. the Skia glue -- the only
  // place C++ enters the link -- so it takes the same manifest shape as bakecrisp.
  'oom-cxx.as': ['--manifest', join(dir, 'oom-cxx.build.json')],
  // scrollrect-clip.as 断言的也是**像素**（scrollRect 窗口的着色包围盒与窗口左上角
  // 色条），纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as 一样链 Skia。
  'scrollrect-clip.as': ['--manifest', join(dir, 'scrollrect-clip.build.json')],
  // scrollrect-coordinates.as 必须真的执行 stage.render，坐标 API 才会读到 AIR 的
  // 「下一帧串接矩阵」；纯 C 的 surface 空桩会提前 return，故同链 Skia。
  'scrollrect-coordinates.as': ['--manifest', join(dir, 'scrollrect-coordinates.build.json')],
  // autobake-scrollrect.as 断言的是**自动烘焙失效**后的像素（祖先烘焙 → 改 scrollRect →
  // draw 必须变），而且它要靠 `stage.render` 跑每帧指纹 pass 才会真的进入烘焙态，
  // 两者都只在 Skia 构建下存在，故同样链 Skia。
  'autobake-scrollrect.as': ['--manifest', join(dir, 'autobake-scrollrect.build.json')],
  // autobake-origin.as（阶段一百九十一）断言的是**自动烘焙的原点口径**：分数坐标上的对象被烘焙
  // 后必须与活态逐像素相同（真机上这是用户报的「按钮鼠标悬停抖动」）。同 autobake-scrollrect 一样，
  // 它要靠 `stage.render` 跑每帧指纹 pass 才会真的进入烘焙态，而且断言是像素 —— 纯 C 构建没有
  // 光栅后端，故同样链 Skia。
  'autobake-origin.as': ['--manifest', join(dir, 'autobake-origin.build.json')],
  // bake-bitmap-swap.as（阶段二百八十一）断言的是**换 BitmapData 之后的像素**：祖先烘焙后把
  // bitmap.bitmapData 换成同尺寸、同造法的另一张图，探针必须变色（真机症状＝幻灯片停在第
  // 一页，只有 resize 才动）。断言是像素、且要靠 stage.render 跑指纹 pass，故同
  // autobake-origin.as 一样链 Skia。
  'bake-bitmap-swap.as': ['--manifest', join(dir, 'bake-bitmap-swap.build.json')],
  // bake-draw-cache.as（阶段二百八十二）钉的是**draw 这条渲染路径自己**：离屏子树只经由
  // `BitmapData.draw` 进入渲染时，窗口绘制的指纹遍历根本不覆盖它，于是显式 cacheAsBitmap
  // 烘一次就永远重放那张图（真机：presenter 模式下大图 = pBitmapData.draw(skinView.view) 的
  // 输出，翻页不换图）。断言是像素、且要链 Skia，故同 bake-bitmap-swap.as。
  'bake-draw-cache.as': ['--manifest', join(dir, 'bake-draw-cache.build.json')],
  // gc-image-free.as（阶段二百八十三）钉的是**被丢弃对象持有的 C++ 资源**：渲染路径给
  // BitmapData 缓存的 SkImage 视图（8.3 MB/页，1920x1080）不在 GC 堆里，对象被直接丢弃
  // （不 dispose，应用每页都这样）时没人释放它 —— 真机 39 页 × 8.3 MB 把 32 位地址空间
  // 推到 1.1 GB，下一页的 gc_alloc 在 Loader COMPLETE 里抛 #1000，于是「翻到最后一页就不
  // 换图」。断言是**进程常驻内存**（System.privateMemory），要有光栅后端才会真的建那张
  // 视图，故同 bake-draw-cache.as 一样链 Skia。ASC_NO_FINAL=1 可让这条断言变红（A/B）。
  'gc-image-free.as': ['--manifest', join(dir, 'gc-image-free.build.json')],
  // display-mask.as（阶段三百一十八）钉的是 DisplayObject.mask 的**像素**契约：遮罩对象是一块
  // 二值模板（alpha 与 visible 都被忽略），按它**自己的**祖先链落在父空间，遮罩本身不绘制、
  // 不参与命中，遮罩没有墨迹就什么都画不出来。adl 51.4.1 实测值（temp/mask/MaskProbe*.as）
  // 逐条比对，故与 draw-over.as 一样必须链 Skia。
  'display-mask.as': ['--manifest', join(dir, 'display-mask.build.json')],
  // draw-over.as 断言的也是**像素**（draw() 的 SourceOver 合成值），同样需要光栅后端。
  'draw-over.as': ['--manifest', join(dir, 'draw-over.build.json')],
  // roundrect.as（阶段二百六十七 · G19）断言的也是**像素**：drawRoundRect 的两个半径必须
  // 真的变成四条椭圆圆角（旧实现是 `(void)ew; (void)eh; drawRect(...)`）。纯 C 构建没有光栅
  // 后端，故与 draw-over.as 一样链 Skia。
  'roundrect.as': ['--manifest', join(dir, 'roundrect.build.json')],
  // alpha-sibling.as（阶段二百一十四）断言「半透明子件不能把父对象的位移留给同帧里
  // 之后画的东西」：Skia 的 save/restore 是一叠栈，漏一次 restore 会被父对象的 restore
  // 顶掉，于是半透明兄弟之后的**所有**内容都被平移到它的位置上。真应用里这是「拖列表
  // 后刷新，上面的卡片跳下来再恢复」。断言是像素（白色画布上蓝块的落点），纯 C 构建
  // 没有光栅后端（draw 是空桩），故与 draw-over.as 一样链 Skia。
  'alpha-sibling.as': ['--manifest', join(dir, 'alpha-sibling.build.json')],
  // autosize-metrics.as 断言的是**字体度量**（`textWidth`/`textHeight`/`numLines`）与
  // 「反复 `BitmapData.draw` 后字段宽度不得自噬」，两者都只在 Skia 文本后端下存在，
  // 故与 bakecrisp.as 一样链 Skia（阶段一百六十八的 autoSize/字族兜底回归）。
  'autosize-metrics.as': ['--manifest', join(dir, 'autosize-metrics.build.json')],
  // settextformat-runs.as（阶段二百六十八 · G20）断言的是 setTextFormat 对同一范围是**替换**
  // 而不是叠加：判据全是 Skia 文本后端下的关系式（textWidth / 墨迹宽），修前「每重绘一次就把
  // 字符排一遍」。故与 autosize-metrics.as 共用同一份 Skia 清单。
  'settextformat-runs.as': ['--manifest', join(dir, 'autosize-metrics.build.json')],
  // tf-scale-metrics.as 断言的是**字体度量 + 字形光栅**（缩放字段的 textWidth/textHeight 口径，
  // 以及「字形按 scaleY 整体缩放、scaleX 不拉宽」的 ink 宽），两者都只在 Skia 文本后端下存在，
  // 故与 bakecrisp.as 一样链 Skia（阶段一百六十九的缩放口径回归）。
  'tf-scale-metrics.as': ['--manifest', join(dir, 'tf-scale-metrics.build.json')],
  // tf-autosize-empty.as（阶段二百三十七）断言的是**空 autoSize 字段的文本度量**：Skia 对
  // 「没有 run 的空段落」把 longestLine 设成 FLT_MIN - FLT_MAX（-3.4028e38），autoSize 把它
  // 写进 _fieldWidth 后整个子树（含 Stage）的 getBounds 变成 +-3.4028235e38。度量只在 Skia
  // 文本后端下存在，故与 autosize-metrics.as 一样链 Skia。
  'tf-autosize-empty.as': ['--manifest', join(dir, 'tf-autosize-empty.build.json')],
  // sbtn-null-up.as 断言的也是**像素**（`upState==NULL` 时 `BitmapData.draw` 什么都不能画、
  // 有 up 态时画的正是 up 态），而纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as 一样链 Skia。
  'sbtn-null-up.as': ['--manifest', join(dir, 'sbtn-null-up.build.json')],
  // swc-mc-button.as（阶段一百七十一）是 MovieClip 按钮态的渲染层回归：状态在绘制 pass 里结算，
  // 必须真的走一帧（`stage.render`）才观察得到，而且要用像素差断言「状态真的画出来了」——两者都
  // 只在 Skia 构建下存在，故链 swc-bitmap.build.json（它已经带上了 examples/embed-assets/skin.swc，与 swc-shape.as
  // 的渲染层变体同一路子）。
  'swc-mc-button.as': ['--manifest', join(dir, 'swc-bitmap.build.json')],
  // swc-morph.as（阶段三百一十四）钉的是 morph（DefineMorphShape）烘焙后的**显示盒**契约：
  // AIR 把 MorphShape 的 width/height/getBounds/getRect 钉在 ratio 0 的起始形上（实测），
  // 而几何本身随 Ratio 插值。它同样要读 skin.swc，故与 swc-bitmap.as 用同一份清单。
  'swc-morph.as': ['--manifest', join(dir, 'swc-bitmap.build.json')],
  // bitmap-setpixels-endian.as（阶段二百一十六）断言两件事：setPixels 必须按
  // `ByteArray.endian` 解析 32 位字（真应用 ANEVideo 的摄像头帧是 libyuv 的
  // B,G,R,A，靠 littleEndian 声明），以及「`new BitmapData` + setPixels 填出来的
  // 位图在显示列表里必须真的画出像素、改像素后必须跟着变」。前半段是纯算术，
  // 后半段要像素 —— 纯 C 构建没有光栅后端（draw 是空桩），示例自带 TextField 探针
  // 判断后端是否存在并跳过显示列表段，故与 bakecrisp.as 一样链 Skia，保证 CI 真的
  // 跑到后半段。
  'bitmap-setpixels-endian.as': ['--manifest', join(dir, 'bitmap-setpixels-endian.build.json')],
  // bitmap-smoothing.as（阶段二百三十）断言的是 Bitmap.smoothing 的**采样结果**：
  // 16x1 黑白相间的位图按 0.25 缩到 4x1，最近邻只能取到纯 0x00/0xFF，双线性必然混出一个
  // 中间灰。这只有真的跑光栅后端才观察得到（纯 C 构建 draw() 是空桩），故与 bakecrisp.as
  // 一样链 Skia —— 否则这条 pin 在 CI 上会走「skipped」，等于没钉。
  'bitmap-smoothing.as': ['--manifest', join(dir, 'bitmap-smoothing.build.json')],
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
  'swc-bitmap.as': join(dir, 'embed-assets', 'skin.swc'),
  'swc-shape.as': join(dir, 'embed-assets', 'skin.swc'),
  'swc-mc-button.as': join(dir, 'embed-assets', 'skin.swc'),
  'swc-morph.as': join(dir, 'embed-assets', 'skin.swc'),
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
        for (const g of GREENSOCK_CORE) subFiles.push(join(AS_LIBRARY, g));
      }
      // The library files are NOT under subDir, so their label is written relative to
      // examples/ (e.g. `as-library/com/greensock/TweenLite.as`): the old
      // `slice(subDir.length + 1)` would have printed a truncated absolute path.
      const names = subFiles.map((f) => (f.startsWith(subDir) ? f.slice(subDir.length + 1) : relative(dir, f)));
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
    } else if (e.name.endsWith('.as') && !SKIP_FILES.has(e.name)) {
      const required = EXAMPLE_REQUIRES[e.name];
      const out = scratchOut(e.name);
      test(`example: ${e.name}`, async (t) => {
        if (SYMLINK_NEEDS_FIXTURE.has(e.name) && symlinkSkipReason !== null) {
          console.log(`SKIP  ${e.name} (${symlinkSkipReason})`);
          t.skip(symlinkSkipReason);
          return;
        }
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
  // `--as-class-path` is how the app reaches its library now (阶段二百五十四): the
  // GreenSock sources left examples/air-native/src/com for examples/as-library.
  // Without it the reach closure cannot resolve `Cubic` and codegen fails with
  // "undefined variable 'Cubic'" -- which is the correct, loud failure, not a SKIP:
  // a missing library must never quietly downgrade this case to a pass.
  await runAsync('node', ['src/index.ts', '--air-app', xml, '--main-class', 'Main',
    '--as-class-path', AS_LIBRARY,
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
// flash.system.System.exit(code:uint) -- the STATUS half (阶段二百四十五).
//
// The pool above runs `examples/system-exit.as`, which proves the ZERO-code case
// (and is only runnable at all because the status main() returns really is the
// recorded one). A non-zero code cannot live there -- node:test reads any
// non-zero exit as a failure -- so its twin is in SKIP_FILES and driven here,
// where the status is asserted directly. Without this, `return as_exit_status;`
// could regress to `return 0;` and every other test would still pass.
test('example: system-exit-status.as (process status = the System.exit code)', async () => {
  const out = scratchOut('system-exit-status');
  await runAsync('node', ['src/index.ts', join(dir, 'system-exit-status.as'), '-o', out],
    { cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  // Windows appends `.exe` to an extensionless -o (lld-link's output name); POSIX
  // has no such convention, so the executable is the path as given there.
  const exe = process.platform === 'win32' && !out.toLowerCase().endsWith('.exe') ? `${out}.exe` : out;
  // execFile RESOLVES only on status 0, so a non-zero exit arrives as a rejection
  // whose `code` is the status and whose `stdout` is what the program printed.
  let status = 0;
  let printed = '';
  try {
    const r = await runAsync(exe, [], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    printed = r.stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    status = typeof err.code === 'number' ? err.code : -1;
    printed = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  // The example's own output is checked BEFORE the status: a program that never
  // reached the call would also exit 0, and `before` is what proves it did.
  assert.match(printed, /system-exit-status: before/);
  assert.strictEqual(status, 7,
    `System.exit(7) must become the process status; got ${status} (stdout=${printed})`);
  // The teardown is DEFERRED to the frame boundary (same as NativeApplication.exit),
  // so the statements after the call still run -- a documented choice, not an
  // accident, and it is what makes `after` observable at all.
  assert.match(printed, /system-exit-status: after/);
  console.log('PASS  system-exit-status (status 7)');
});
