// Build orchestration: turns the generated C plus optional extra sources,
// include paths and link libraries into a compiler invocation for a chosen
// target (native executable or WASI .wasm). Keeps the "single readable .c"
// pipeline as the default shape while allowing third-party libraries (skia,
// cairo, SDL, ...) to be linked in exactly the way TypePHP links GMP/MPFR/PHPX.
//
// The frontend still only translates AS -> C; everything here is *linking and
// targeting*, not optimization or machine-code generation.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

export type Target = 'native' | 'wasm';

// 分发形态（§6 设计）：编译后端产出裸产物之后，如何组织成工程/包。与
// `target`（机器码 ABI）正交——同一个 package 形态对所有 target 后端复用。
// 只服务 IDE 开发者，故只有工程生成器（raw 保持现状），没有 app/dmg 脚本路线。
// `web` 是浏览器页面（.wasm + .js 胶水 + index.html），与 `xcode-project`（macOS
// 工程）同层级，都只是「如何组织产物」；它要求 target=wasm（emcc 后端）。
export type Package = 'raw' | 'xcode-project' | 'android-project' | 'web';

export interface BuildConfig {
  target: Target;
  package: Package;
  cCompiler: string;
  opt: string;
  // Debug-info policy (stage 94·29). Off by default, and "off" means the same
  // thing on every target: the artifact carries no DWARF, exactly like `cc -O2`
  // on macOS (no __DWARF segment) and `emcc -O2` (measured: a trivial program is
  // 2010 B with zero custom sections, 28243 B with -g).
  //
  // The wasi backend is the only one that does NOT get this for free: wasi-sdk
  // 34's libc.a ships DWARF and wasm-ld keeps it by default, so even an empty
  // `int main(void){return 0;}` drags in ~19 KB and a printf program ~62 KB.
  // With debugInfo=false the wasm link therefore passes `-Wl,--strip-debug` to
  // restore parity (fib.wasm 421 KB -> 133 KB); the `name` section survives, so
  // traps still print a named stack — only source-line/variable info is lost.
  //
  // debugInfo=true is the opt-in (mirroring `-g` on clang/emcc): every backend
  // adds `-g`, and the wasm backend stops stripping so DevTools can step through
  // the AS3-lowered C.
  debugInfo: boolean;
  // E12: link-time optimization. Off by default so `--build` without a manifest
  // stays byte-for-byte the build it has always been; `-flto` has to be on BOTH
  // the compile and the link step (the compile step emits bitcode, the link step
  // is where the cross-TU inlining actually happens).
  lto: boolean;
  // E12: profile-guided optimization, as the two phases the toolchain requires.
  // `generate` builds an instrumented binary that writes profile data when run;
  // `use` rebuilds with those counts. Neither is a language feature - the
  // frontend still just translates AS to C (§1.1) - so this is a build-level
  // switch and belongs here, not in the emitter.
  pgo: 'generate' | 'use' | '';
  // Directory/profile-name handed to -fprofile-generate=/-fprofile-use=.
  pgoDir: string;
  // extra C/C++ source files compiled together with the generated .c
  sources: string[];
  // .swc libraries whose named bitmap resources are extracted at compile time
  // and embedded into the generated C (阶段九十五). Paths are resolved relative
  // to the manifest that declares them.
  swcPaths: string[];
  includePaths: string[];
  linkLibs: string[];
  linkPaths: string[];
  defines: string[];
  // Named enhancement switches (--features, manifest `features`).
  //
  // These are NOT defines the user spells out: a feature is an AIR-superset
  // capability the project has implemented behind an opt-in macro (§1.5), and
  // naming it by feature keeps the CLI honest about what it is turning on.
  // Empty by default, so the default artifact stays byte-for-byte the build
  // that matches `adl` — the invariant §1.5 protects and `test.ts` pins.
  //
  // A feature is resolved to its macro by `featureDefines()` below, which is
  // the ONLY place that mapping lives: an unrecognised name must be a hard
  // error, never a silent no-op (a `--features lottie` that quietly did nothing
  // would look enabled and be a no-op — exactly the failure mode §1.5 forbids).
  features: string[];
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
  // Font byte-stream URLs (--package web only): the browser fetches these at
  // runtime and injects them into Skia's custom FreeType font manager, since the
  // wasm sandbox has no system fonts to enumerate (§html5-web). Empty = render
  // text as nothing (no font) until the host supplies one.
  fontUrls: string[];
  // Resource preload specs for the wasm virtual filesystem (--package web only),
  // each `<abs-src>@<dest>`. The browser sandbox starts with an EMPTY in-memory
  // FS, so `File` / `FileStream` see nothing at all and an AIR app that reads its
  // own data files (asset folders, `.fnt` bitmap-font descriptors, atlases) hangs
  // at 0% on its load queue. Declaring the app's data root here packs it into
  // `<base>.data`, which Emscripten auto-mounts at <dest> before main() runs — the
  // browser-side equivalent of adl resolving `File.applicationDirectory` to the
  // app's install directory. `<dest>` is the manifest-relative path spelled in the
  // manifest (so `"assets"` mounts at `/assets`, which is what a program that
  // reads `assets/...` expects); writing `src@dest` in the manifest overrides it.
  // The src must be made explicit because emcc's default for an absolute source
  // is a path relative to the BUILD's CWD, which the page cannot resolve.
  preloadPaths: string[];
  // Host paths or fnmatch patterns REMOVED from the preload set above (--package
  // web only; emcc's `--exclude-file`, → file_packager `--exclude`). This is how a
  // file that a preload root sweeps in is kept out of `<base>.data` — emcc has no
  // per-file opt-out inside a directory preload, only these patterns. The match is
  // against the HOST path as walked (absolute, since preload srcs are resolved), so
  // entries are resolved against the manifest dir the same way. Two things every
  // caller must know (both measured against emcc 3.1.44):
  //   - a pattern with no wildcard is an EXACT host-path match, but it is still an
  //     fnmatch pattern, so a path that itself contains `*?[` mis-targets (`weird[1].png`
  //     excludes the unrelated `weird1.png` and spares the file it names) — escape
  //     literals as `[[]` `[]]` `[*]` `[?]` unless you mean a glob;
  //   - a pattern that matches nothing is silently ignored (no warning, no error),
  //     which is what makes it safe to emit unconditionally.
  // Excluded files leave no hole: their parent directories still exist, so
  // `opendir` on the containing directory keeps working.
  preloadExcludes: string[];
  // Application-bundle metadata (--package xcode-project, §6): these shape the
  // generated macOS .app's Info.plist / build settings. They are *project
  // configuration*, not CLI flags — carried by the build manifest.
  bundleId: string;          // e.g. com.example.app (fills CFBundleIdentifier)
  displayName: string;       // human-readable app name (fills CFBundleName)
  icon: string | null;       // .icns path (fills CFBundleIconFile); null = none
  deploymentTarget: string;  // macOS minimum version (fills LSMinimumSystemVersion)
  // AIR <architecture> bit width ("32" | "64" | ""), carried by --air-app. On a
  // Windows native build this is what selects the MSVC target triple (i686 vs
  // x86_64); it is inert on macOS/wasm. Empty for non-AIR builds (let clang pick
  // its host default).
  architecture: string;
  dry: boolean;
}

export function defaultBuildConfig(): BuildConfig {
  return {
    target: 'native',
    package: 'raw',
    cCompiler: 'cc',
    opt: '-O2',
    debugInfo: false,
    lto: false,
    pgo: '',
    pgoDir: '',
    sources: [],
    swcPaths: [],
    includePaths: [],
    linkLibs: [],
    linkPaths: [],
    defines: [],
    features: [],
    objects: [],
    frameworks: [],
    exports: [],
    fontUrls: [],
    preloadPaths: [],
    preloadExcludes: [],
    bundleId: '',
    displayName: '',
    icon: null,
    deploymentTarget: '12.0',
    architecture: '',
    dry: false,
  };
}

// A build manifest (JSON) mirrors TypePHP's project.yml: a file that fixes
// reusable, version-controlled build settings. JSON is used instead of YAML to
// keep the zero-dependency constraint (Node parses it natively). Fields use the
// same kebab-case names as TypePHP where they overlap.
interface ManifestFields {
  target?: 'native' | 'wasm';
  package?: 'raw' | 'xcode-project' | 'android-project' | 'web';
  'c-compiler'?: string;
  opt?: string;
  'debug-info'?: boolean;
  lto?: boolean;
  pgo?: 'generate' | 'use';
  'pgo-dir'?: string;
  sources?: string[];
  'swc-paths'?: string[];
  'include-paths'?: string[];
  'link-libs'?: string[];
  'link-paths'?: string[];
  defines?: string[];
  features?: string[];
  objects?: string[];
  frameworks?: string[];
  exports?: string[];
  'font-urls'?: string[];
  'preload-paths'?: string[];
  'preload-excludes'?: string[];
  'bundle-id'?: string;
  'display-name'?: string;
  icon?: string;
  'deployment-target'?: string;
  architecture?: string;
}

// A per-target overlay block. `target`/`package` are deliberately excluded: the
// block is *selected by* the target, so it may not redefine which target it is
// (and `targets` itself cannot nest).
type TargetLayer = Omit<ManifestFields, 'target' | 'package'>;

interface Manifest extends ManifestFields {
  // Per-target overlay (stage 89·50). Top-level fields are the *shared* default;
  // a `targets.<name>` block REPLACES (does not append to) every field it
  // mentions when the effective target matches. This is what lets ONE manifest
  // drive several targets whose link sets are mutually incompatible — e.g. a
  // native build links curl (`"link-libs": ["curl"]`), while wasm cannot
  // (`wasm-ld: unable to find library -lcurl`) and declares `"link-libs": []` to
  // drop it. Replace semantics (rather than append) is deliberate: it can both
  // ADD a library for one target and REMOVE it for another, which append alone
  // cannot express.
  targets?: Partial<Record<Target, TargetLayer>>;
}

// Fields a `targets.<name>` block is allowed to override. Anything else is a
// typo and must fail loudly (AGENTS.md §2.5), not be silently ignored.
const TARGET_LAYER_FIELDS: ReadonlySet<string> = new Set([
  'c-compiler', 'opt', 'sources', 'include-paths', 'link-libs', 'link-paths',
  'defines', 'features', 'objects', 'frameworks', 'exports', 'font-urls',
  'preload-paths', 'preload-excludes',
  'debug-info', 'lto', 'pgo', 'pgo-dir',
  'swc-paths',
  'bundle-id', 'display-name', 'icon', 'deployment-target',
]);

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
  if (m.package) next.package = m.package;
  if (m['c-compiler']) next.cCompiler = m['c-compiler'];
  if (m.opt) next.opt = m.opt;
  if (m['debug-info'] !== undefined) next.debugInfo = m['debug-info'];
  if (m.lto !== undefined) next.lto = m.lto;
  if (m.pgo) next.pgo = m.pgo;
  if (m['pgo-dir']) next.pgoDir = resolveFromManifest(manifestPath, m['pgo-dir']);
  if (m.sources) next.sources = [...cfg.sources, ...m.sources.map((p) => resolveFromManifest(manifestPath, p))];
  if (m['swc-paths']) next.swcPaths = [...cfg.swcPaths, ...m['swc-paths'].map((p) => resolveFromManifest(manifestPath, p))];
  if (m['include-paths']) next.includePaths = [...cfg.includePaths, ...m['include-paths'].map((p) => resolveFromManifest(manifestPath, p))];
  if (m['link-libs']) next.linkLibs = [...cfg.linkLibs, ...m['link-libs']];
  if (m['link-paths']) next.linkPaths = [...cfg.linkPaths, ...m['link-paths'].map((p) => resolveFromManifest(manifestPath, p))];
  if (m.defines) next.defines = [...cfg.defines, ...m.defines];
  if (m.features) next.features = [...cfg.features, ...m.features];
  if (m.objects) next.objects = [...cfg.objects, ...m.objects.map((p) => resolveFromManifest(manifestPath, p))];
  if (m.frameworks) next.frameworks = [...cfg.frameworks, ...m.frameworks];
  if (m.exports) next.exports = [...cfg.exports, ...m.exports];
  if (m['font-urls']) next.fontUrls = [...cfg.fontUrls, ...m['font-urls']];
  if (m['preload-paths']) {
    next.preloadPaths = [
      ...cfg.preloadPaths,
      ...m['preload-paths'].map((p) => resolvePreloadSpec(manifestPath, p)),
    ];
  }
  if (m['preload-excludes']) {
    next.preloadExcludes = [
      ...cfg.preloadExcludes,
      ...m['preload-excludes'].map((p) => resolveFromManifest(manifestPath, p)),
    ];
  }
  if (m['bundle-id']) next.bundleId = m['bundle-id'];
  if (m['display-name']) next.displayName = m['display-name'];
  if (m.icon) next.icon = resolveFromManifest(manifestPath, m.icon);
  if (m['deployment-target']) next.deploymentTarget = m['deployment-target'];
  if (m.architecture) next.architecture = m.architecture;
  return next;
}

// Resolve one `src@dest` preload spec: the source path is relative to the
// manifest's directory, the destination is the (already-relative) in-FS mount
// point spelled in the manifest. Shared by applyManifest and applyManifestOverlay.
function resolvePreloadSpec(manifestPath: string, p: string): string {
  const at = p.lastIndexOf('@');
  const src = at >= 0 ? p.slice(0, at) : p;
  const dest = at >= 0 ? p.slice(at + 1) : p;
  return `${resolveFromManifest(manifestPath, src)}@${dest}`;
}

// Apply a manifest's `targets.<target>` overlay on top of an already-merged
// config. Called AFTER the base manifest merge and BEFORE the CLI overrides, so
// that (a) the layer is chosen by the *final* target — which the CLI `--target`
// can influence — and (b) CLI flags still beat everything (TypePHP's rule).
//
// Array-valued fields REPLACE the merged value (see the Manifest.targets comment
// for why); scalar fields likewise replace. Every field the layer omits is left
// untouched, so top-level values act as the shared default.
export function applyManifestOverlay(cfg: BuildConfig, m: Manifest, manifestPath: string, target: Target): BuildConfig {
  const layers = m.targets;
  if (!layers) return cfg;
  for (const k of Object.keys(layers)) {
    if (k !== 'native' && k !== 'wasm') {
      throw new Error(`build manifest: unknown target '${k}' in "targets" (expected: native | wasm) — ${manifestPath}`);
    }
  }
  const layer = layers[target];
  if (!layer) return cfg;
  for (const k of Object.keys(layer)) {
    if (!TARGET_LAYER_FIELDS.has(k)) {
      const hint = k === 'targets'
        ? ' (a targets block cannot be nested)'
        : k === 'target' || k === 'package'
          ? ' (target/package are top-level; a target block may not redefine them)'
          : '';
      throw new Error(`build manifest: field '${k}' is not allowed inside targets.${target}${hint} — ${manifestPath}`);
    }
  }
  const next: BuildConfig = { ...cfg };
  const L = layer;
  if (L['c-compiler']) next.cCompiler = L['c-compiler'];
  if (L.opt) next.opt = L.opt;
  if (L['debug-info'] !== undefined) next.debugInfo = L['debug-info'];
  if (L.lto !== undefined) next.lto = L.lto;
  if (L.pgo) next.pgo = L.pgo;
  if (L['pgo-dir']) next.pgoDir = resolveFromManifest(manifestPath, L['pgo-dir']);
  if (L.sources) next.sources = L.sources.map((p) => resolveFromManifest(manifestPath, p));
  if (L['swc-paths']) next.swcPaths = L['swc-paths'].map((p) => resolveFromManifest(manifestPath, p));
  if (L['include-paths']) next.includePaths = L['include-paths'].map((p) => resolveFromManifest(manifestPath, p));
  if (L['link-libs']) next.linkLibs = [...L['link-libs']];
  if (L['link-paths']) next.linkPaths = L['link-paths'].map((p) => resolveFromManifest(manifestPath, p));
  if (L.defines) next.defines = [...L.defines];
  if (L.features) next.features = [...L.features];
  if (L.objects) next.objects = L.objects.map((p) => resolveFromManifest(manifestPath, p));
  if (L.frameworks) next.frameworks = [...L.frameworks];
  if (L.exports) next.exports = [...L.exports];
  if (L['font-urls']) next.fontUrls = [...L['font-urls']];
  if (L['preload-paths']) next.preloadPaths = L['preload-paths'].map((p) => resolvePreloadSpec(manifestPath, p));
  if (L['preload-excludes']) next.preloadExcludes = L['preload-excludes'].map((p) => resolveFromManifest(manifestPath, p));
  if (L['bundle-id']) next.bundleId = L['bundle-id'];
  if (L['display-name']) next.displayName = L['display-name'];
  if (L.icon) next.icon = resolveFromManifest(manifestPath, L.icon);
  if (L['deployment-target']) next.deploymentTarget = L['deployment-target'];
  return next;
}

function wasiSdkHome(): string | null {
  return process.env.WASI_SDK_HOME || null;
}

// E12: translate the LTO/PGO build switches into compiler flags. Kept as one
// helper so the four command builders cannot drift apart: `-flto` is only
// meaningful if it is on every compile step AND the link step, and a PGO cycle
// is only valid if both phases use the same profile path.
//
// These are pure `cc -O2` concerns (§1.1): the frontend still only translates
// AS to C and does no optimization of its own, so nothing here belongs in the
// emitter.
export function perfFlags(cfg: BuildConfig): string[] {
  const out: string[] = [];
  if (cfg.pgo === 'generate') {
    out.push(cfg.pgoDir ? `-fprofile-generate=${cfg.pgoDir}` : '-fprofile-generate');
  } else if (cfg.pgo === 'use') {
    // Clang reads `<dir>/default.profdata` from the directory form, so the two
    // phases only line up if both name the same `pgo-dir`. That file is what
    // `llvm-profdata merge -o <dir>/default.profdata <dir>/*.profraw` produces
    // from an instrumented run.
    //
    // No -fprofile-correction here: that is a *GCC* flag for tolerating
    // inconsistent counts. Clang accepts it only to warn "not supported" and
    // ignore it (-Wignored-optimization-argument), and clang's own profile
    // reader already merges counts from the profraw set, so emitting it would
    // buy nothing and print a warning on every PGO build.
    out.push(cfg.pgoDir ? `-fprofile-use=${cfg.pgoDir}` : '-fprofile-use');
  }
  if (cfg.lto) out.push('-flto');
  return out;
}

// FP flags (stage 96). `-ffp-contract=off` is not an optimisation knob, it is a
// semantic one: AS3 arithmetic is IEEE double with one rounding per operation,
// while clang's default (-ffp-contract=on) fuses `a*b+c` into a single
// multiply-add. Measured consequence: AIR's SoundTransform.pan getter computes
// `1 - ltl*ltl` and reports 0.2604000000000001 for ltl=0.86; the fused form
// rounds once and reports 0.2604. The difference is one ULP, but it is a
// difference in *observable AS3 results*, so the generated C must not be
// contracted — same reasoning as never passing -ffast-math. It goes on every
// compile step and the link step of all four builders, like perfFlags.
export function fpFlags(cfg: BuildConfig): string[] {
  return ['-ffp-contract=off'];
}

// Debug-info policy -> compiler flags (stage 94·29). Split by direction so the
// four command builders cannot drift apart:
//
//   `-g` goes on every *compile* step whenever debugInfo is on, so the DWARF
//   covers our own generated C and not just the prebuilt SDK archives.
//
//   `-Wl,--strip-debug` goes on the wasm *link* whenever it is off. This is the
//   one backend that needs it: wasi-sdk's libc.a ships DWARF and wasm-ld keeps
//   it by default (measured: an empty program 19 KB, a printf program 62 KB of
//   debug custom sections). Native keeps no DWARF at -O2 anyway, and emcc -O2
//   strips by itself, so those two need no counter-flag — only the wasm side.
//   `--strip-debug` (not `--strip-all`) is deliberate: the `name` section
//   survives, so traps still print a named stack; only source-line/variable
//   info is dropped.
export function debugInfoFlags(cfg: BuildConfig): string[] {
  return cfg.debugInfo ? ['-g'] : [];
}

export function wasmStripFlags(cfg: BuildConfig): string[] {
  return cfg.target === 'wasm' && !cfg.debugInfo ? ['-Wl,--strip-debug'] : [];
}

// The named enhancement switches and the opt-in macro each one turns on.
//
// Every entry here is an AIR-superset capability (§1.5): `adl` errors or has no
// such feature, and the macro is what makes the glue take the extra channel. A
// name only belongs in this table once the channel actually EXISTS end to end -
// listing E2 (`lottie`) now would hand the user a switch that silently does
// nothing, which is worse than no switch at all.
//
// `formats`/`raw` (E3/E4) are the DEFAULT-DENY pair: our Skia carries those
// codecs, but AIR reports #2124 for them, so the glue refuses the families by
// magic byte unless the macro is defined. The switch is therefore load-bearing
// in both directions - the build banner names it, and without it the runtime
// behaves exactly like adl.
//
// `svg` (E1): teaches the four image-decode entry points in vendor/skia_glue.cc
// to fall back to SkSVGDOM after every SkCodec format fails. The libraries it
// needs (-lsvg -lsksg -lexpat) are already on the native link line, so the macro
// is the only thing separating "AIR-identical #2124" from "decodes".
// `targets` is the set of backends where the channel can actually LINK. Web Skia
// is configured with skia_use_expat=false, so the whole svg target is absent and
// there is no -lsvg/-lsksg/-lexpat to resolve SkSVGDOM against. Declaring a
// feature on a backend that cannot carry it is rejected up front rather than
// surfacing as a wall of `undefined symbol: sk_svg_*` from the linker — same
// fact, but stated in the project's own words (§1.5: name the cross-backend gap).
const FEATURES: Readonly<Record<string, { macro: string; targets: readonly Target[]; why: string }>> = {
  svg: {
    macro: 'ASC_USE_SVG=1',
    targets: ['native'],
    why: 'the wasm Skia is built with skia_use_expat=false (no svg/sksg/expat archives to link)',
  },
  // `formats` (E3): WebP / BMP / ICO. Our Skia carries those codecs on BOTH
  // backends, but AIR decodes only JPG/PNG/GIF (adl 51.4.1 answers #2124 for the
  // other three), so the default build refuses them by magic byte and the switch
  // opens the channel. No extra library is involved, hence both targets.
  formats: {
    macro: 'ASC_ALLOW_EXTRA_FORMATS=1',
    targets: ['native', 'wasm'],
    why: '',
  },
  // `raw` (E4): camera RAW / DNG via SkRawCodec (piex + dng_sdk). Native only --
  // the wasm Skia ships no piex/dng_sdk archive at all (nm: zero SkRawDecoder
  // symbols), so a web build that asked for it would fail at link time. Naming
  // the missing archive is the point (§1.5: state the cross-backend gap).
  raw: {
    macro: 'ASC_ALLOW_RAW_FORMATS=1',
    targets: ['native'],
    why: 'the wasm Skia has no piex/dng_sdk archive (zero SkRawDecoder symbols), so camera RAW/DNG cannot be linked there',
  },
};

// Resolve feature names to their macros, failing loudly on anything unknown.
// Unknown must throw (not warn): the whole point of naming a feature is that the
// user believes it is on, so `--features sgg`/`--features lottie` silently
// producing an unenhanced build is the exact "compiles but is not what you asked
// for" outcome §1.5/§2.5 rule out. De-duplicated so `--features svg --features
// svg` and a manifest that repeats one can't emit `-D` twice.
export function featureMacros(features: readonly string[]): string[] {
  return featureDefines(features);
}

// The feature names this build knows, for `--help` and error text.
export function knownFeatures(): string[] {
  return Object.keys(FEATURES).sort();
}

// Reject a feature the chosen backend cannot actually build, before any compile
// runs. Without this the build does fail — but as an unresolved-symbol dump, which
// reads as a broken toolchain rather than "this is a native-only channel".
// Throws for a name that is not a feature at all. Shared by validation and macro
// resolution so both spell the same list the same way.
function featureSpec(f: string): { macro: string; targets: readonly Target[]; why: string } {
  const spec = FEATURES[f];
  if (!spec) {
    throw new Error(
      `unknown feature '${f}' (known: ${knownFeatures().join(', ')})\n` +
      `  a feature name turns on an AIR-superset capability; list them with --features <a,b>`
    );
  }
  return spec;
}

export function validateFeatures(features: readonly string[], target: Target): void {
  for (const f of features) {
    if (f === '') continue;
    // Unknown names fail here too, not at command-build time: by then codegen has
    // already written the .c, so a typo would leave a half-finished build behind.
    const spec = featureSpec(f);
    if (!spec.targets.includes(target)) {
      throw new Error(
        `feature '${f}' is not available with --target ${target}: ${spec.why}\n` +
        `  supported targets: ${spec.targets.join(', ')}; run without --features to get the AIR-identical default`
      );
    }
  }
}

function featureDefines(features: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of features) {
    if (f === '') continue;
    const spec = featureSpec(f);
    if (!out.includes(spec.macro)) out.push(spec.macro);
  }
  return out;
}

// Feature names back to a printable list (for the build banner: an enhancement
// that is ON must never be silent — §1.5).
export function featureNames(features: readonly string[]): string[] {
  return [...features].filter((f) => f !== '');
}

// Every define the build should see: the ones spelled out plus those implied by
// the enabled features. One helper, like perfFlags, so no command builder can
// take a different feature set than the others.
export function effectiveDefines(cfg: BuildConfig): string[] {
  return [...cfg.defines, ...featureDefines(cfg.features)];
}

// The MSVC target triple for a Windows native build. clang on Windows must name
// the ABI explicitly: the archives build-windows-deps.ps1 produces are MSVC-ABI,
// and an AIR app whose <architecture> is "32" needs the i686 triple on every
// compile AND link step — otherwise clang emits x86_64 objects that cannot link
// against the windows-x86 archives. The triple is spelled out for "64" too so the
// MSVC ABI (not a stray MinGW default) is pinned, and it is inert on non-Windows
// hosts and non-native targets.
function windowsTargetTriple(architecture: string): string {
  return architecture === '32' ? 'i686-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
}

// Extra flags every native step (C compile, C++ compile, link) needs on Windows
// so all three drivers agree on the same ABI; empty elsewhere and for non-AIR
// builds (architecture === ''), which keep clang's host default.
function nativeTargetFlags(cfg: BuildConfig): string[] {
  if (process.platform !== 'win32' || cfg.target !== 'native') return [];
  if (cfg.architecture !== '32' && cfg.architecture !== '64') return [];
  // Static CRT (/MT). The archives build-windows-deps.ps1 ships are all /MT
  // (Skia's is_official_build, SDL2's CMakeLists, and the curl/nghttp2/zlib stack
  // via -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded / nghttp2 -DENABLE_STATIC_CRT).
  // clang's default for an MSVC triple is the *dynamic* CRT (/MD): it compiles
  // every std call as __declspec(dllimport) (__imp_foo) and links msvcrt.lib +
  // ucrt.lib. Mixing that with /MT archives leaves __except_handler4_common and
  // __imp__wassert undefined. -fms-runtime-lib=static flips both compile (defines
  // _MT instead of _DLL) and link (libcmt.lib + libucrt.lib instead of the import
  // libs) to the static side, matching the archives.
  return [`--target=${windowsTargetTriple(cfg.architecture)}`, '-fms-runtime-lib=static'];
}

// Skia's SkParagraph/SkUnicode (text shaping) needs the ICU data file
// `icudtl.dat` at runtime. On Windows the native build is a static exe with no
// DLL directory to fall back to, so SkLoadICU() (third_party/icu/SkLoadICU.cpp)
// looks for icudtl.dat *beside the executable*. Without it the first text-shaping
// call crashes with SIGILL: SkParagraph::Cluster::Cluster reads an out-of-bounds
// index into the empty grapheme-property table and SK_ABORT()s to a `ud2` trap.
// `build-windows-deps.ps1` already copies icudtl.dat next to the skia .lib; here
// we mirror it next to the freshly linked exe (SkLoadICU only probes the exe and
// library directories, so shipping it beside the .lib is not enough). Returns
// true when a copy happened.
export function deploySkiaIcuData(cfg: BuildConfig, outPath: string): boolean {
  if (process.platform !== 'win32' || cfg.target !== 'native') return false;
  if (cfg.architecture !== '32' && cfg.architecture !== '64') return false;
  if (!cfg.linkLibs.includes('skia')) return false;
  for (const p of cfg.linkPaths) {
    const src = join(p, 'icudtl.dat');
    if (existsSync(src)) {
      copyFileSync(src, join(dirname(resolve(outPath)), 'icudtl.dat'));
      return true;
    }
  }
  return false;
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
    // AS3's throw/try/catch maps to setjmp/longjmp in RUNTIME_PREAMBLE, and
    // wasi-libc implements those on top of the WebAssembly exception-handling
    // proposal, in a separate archive. Three things must line up:
    //
    //   1. `-mllvm -wasm-enable-sjlj` — LLVM's SjLj lowering rewrites
    //      setjmp/longjmp into the `__wasm_setjmp`/`__wasm_longjmp` intrinsics
    //      (longjmp throws a tag; the frame that called setjmp catches it and
    //      restores the saved frame). Without it clang emits plain calls to
    //      libc's `setjmp`/`longjmp`, which wasip1 does not define at all.
    //   2. `-mllvm -wasm-use-legacy-eh=false` — that lowering defaults to the
    //      *legacy* EH instructions (`try`/`catch`), which no shipping engine
    //      enables by default: wasmtime reports "legacy_exceptions feature
    //      required for try instruction" and browsers never shipped them. The
    //      standard proposal (`try_table`) runs on wasmtime ≥ 24 unchanged and
    //      in Chrome 119+/Edge 119+/Firefox/Safari 18.4+.
    //   3. `-lsetjmp` — the archive providing __wasm_setjmp/__wasm_longjmp/
    //      __wasm_setjmp_test. Placed after the objects (see the tail of this
    //      function) because static archives resolve in command-line order.
    //
    // A program that never throws never reaches these symbols and `-O2` deletes
    // them, which is why a plain wasm build linked fine before this existed.
    args.push('-mllvm', '-wasm-enable-sjlj', cfg.opt);
    for (const f of perfFlags(cfg)) args.push(f);
    for (const f of fpFlags(cfg)) args.push(f);
    for (const f of debugInfoFlags(cfg)) args.push(f);
    const setjmpLib = wasiSetjmpLib();
    if (setjmpLib) args.push('-mllvm', '-wasm-use-legacy-eh=false');
    // Export the requested C symbols so the host calls them directly (no
    // _start / stdout round-trip). Exported functions remain callable and
    // re-entrant for the instance lifetime as long as they do not depend on
    // libc state that _start's ctors would have set up.
    for (const e of cfg.exports) args.push(`-Wl,--export=${e}`);
    // Strip the SDK libc's DWARF unless the user opted into debug info (see
    // wasmStripFlags). Placed on the link side, after every object/export flag.
    for (const f of wasmStripFlags(cfg)) args.push(f);
    args.push('-o', outPath);
  } else {
    args.push(...nativeTargetFlags(cfg), cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg));
    for (const l of posixLinkLibs()) args.push(l);
    for (const l of platformLinkLibs()) args.push('-l', l);
    args.push('-o', outPath);
  }

  args.push(cPath);
  for (const s of cfg.sources) args.push(s);
  for (const p of cfg.includePaths) args.push('-I', p);
  for (const d of effectiveDefines(cfg)) args.push('-D', d);
  for (const o of cfg.objects) args.push(o);
  for (const p of cfg.linkPaths) args.push('-L', p);
  for (const l of cfg.linkLibs) args.push('-l', l);
  for (const f of cfg.frameworks) args.push('-framework', f);
  // Static-archive order: libraries must follow the objects that reference
  // them, hence -lsetjmp here rather than in the wasm branch above.
  if (cfg.target === 'wasm' && wasiSetjmpLib()) args.push('-lsetjmp');

  return [cc, ...args];
}

// -lm (libm) and -lz (zlib) are POSIX library NAMES: clang translates `-lm` into
// the input `m.lib` on the MSVC target, and neither m.lib nor a system z.lib
// exists on Windows. Math comes from the CRT there (linked by default) and zlib
// from Skia's own bundled `zlib` target, which the manifest already lists. So the
// pair is emitted only on the POSIX targets. Order is preserved relative to the
// rest of the line: these still land after the flags and before -L/-l.
function posixLinkLibs(): string[] {
  if (process.platform === 'win32') return [];
  return ['-lm', '-lz'];
}

// Extra platform link libraries for the NATIVE targets. iconv is what the
// multi-byte charset codec (stage 94-4) needs: macOS keeps it in a separate
// libiconv (so the linker needs -liconv), Linux/BSD ship it inside libc (no
// flag), and the wasm backends have none at all -- there the generated C drops
// the iconv path entirely via AS_HAVE_ICONV, and adding -liconv would fail the
// link, so this list is deliberately empty for wasm/web. Windows is in the same
// boat as wasm (no <iconv.h> in the CRT, and no libiconv in vendor/), so it takes
// no flag here either -- see AS_HAVE_ICONV in runtime.ts, which is what makes the
// Windows build report the unsupported charsets loudly instead of mis-encoding.
function platformLinkLibs(): string[] {
  if (process.platform !== 'darwin') return [];
  return ['iconv'];
}

// A source file compiled as C++ (Skia glue layer, etc.). Objective-C++ (.mm)
// is included so the native Metal backend (metal_glue.mm) can mix C++ Skia
// calls with CAMetalLayer/MTLDevice ObjC objects under clang++.
function isCppSource(path: string): boolean {
  return /\.(cc|cpp|cxx|mm)$/i.test(path);
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
  // Native objects stay `<name>.o`. `objOf` used to be target-agnostic, so this
  // path and the Emscripten web path wrote the *same* `vendor/*.o` file — a
  // later incremental rebuild that reused the other target's object died in
  // wasm-ld with "unknown file type" (stage 89-32). The web path now suffixes
  // `.wasm.o` (see buildWebCompileSteps) so both sets coexist.
  const objOf = (src: string): string => src.replace(/\.[^.]+$/, '.o');
  const compileCommon: string[] = [...nativeTargetFlags(cfg), cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg)];
  for (const d of effectiveDefines(cfg)) compileCommon.push('-D', d);
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
  const linkArgs: string[] = [cxx, ...nativeTargetFlags(cfg), cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg), '-o', outPath];
  for (const f of cFiles) linkArgs.push(objOf(f));
  for (const f of cppFiles) linkArgs.push(objOf(f));
  for (const o of cfg.objects) linkArgs.push(o);
  for (const p of cfg.linkPaths) linkArgs.push('-L', p);
  for (const l of cfg.linkLibs) linkArgs.push('-l', l);
  linkArgs.push(...posixLinkLibs());
  for (const l of platformLinkLibs()) linkArgs.push('-l', l);
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

// wasi-libc ships setjmp/longjmp in a *separate* archive (libsetjmp.a, not
// libc.a) because they can only be implemented on top of the WebAssembly
// exception-handling proposal. Return its path when the sysroot has it — older
// sysroots (or a plain LLVM clang with no wasi-libc) do not, and then we keep
// the historical flags and let the link fail loudly if the program really needs
// exceptions (see buildCompileCommand).
function wasiSetjmpLib(): string | null {
  const sysroot = wasiSysroot();
  if (!sysroot) return null;
  const p = `${sysroot}/lib/wasm32-wasip1/libsetjmp.a`;
  return existsSync(p) ? p : null;
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

// Run the compiler and propagate failure. Returns true on success. `extraEnv`
// (e.g. the Emscripten toolchain's PATH) is merged over the inherited
// environment rather than replacing it, so unrelated env vars survive.
export function runCompile(argv: string[], extraEnv?: Record<string, string>): boolean {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env });
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      process.stderr.write(
        `compiler not found: '${argv[0]}' is not on PATH.\n` +
        `Install the toolchain (or add its bin directory to PATH) and retry.\n`,
      );
    } else {
      process.stderr.write(`failed to run '${argv[0]}': ${res.error.message}\n`);
    }
    return false;
  }
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

// ---------- web target (Emscripten) ----------
//
// `--target wasm --package web` produces a browser page (.wasm + .js glue +
// index.html) instead of the WASI command module that `--target wasm` (raw)
// produces. The frontend still only translates AS -> C; Emscripten is the
// browser host's compile backend, exactly as wasi clang is the WASI backend and
// cc/clang is the native backend (§2.9). The toolchain is located the same way
// as the WASI SDK: an EMSDK_HOME env var pointing at an Emscripten SDK root
// (which contains upstream/emscripten/emcc).

function emsdkHome(): string | null {
  return process.env.EMSDK_HOME || process.env.EMSDK || null;
}

function emccPath(): string {
  const home = emsdkHome();
  return home ? `${home}/upstream/emscripten/emcc` : 'emcc';
}

// emcc is a Python driver that shells out to clang/node; those live in the
// emsdk's bin dir, so prepend it (and the emscripten dir) to PATH for the
// child process. Returns undefined when no SDK is configured (then emcc must
// already be on PATH).
function webCompileEnv(): Record<string, string> | undefined {
  const home = emsdkHome();
  if (!home) return undefined;
  const emccDir = `${home}/upstream/emscripten`;
  const binDir = `${home}/upstream/bin`;
  return { PATH: `${emccDir}:${binDir}:${process.env.PATH || ''}` };
}

// Probe whether the Emscripten toolchain is usable: emcc must exist and be able
// to run its version check (which fails without a working node/python driver).
export function webToolchainError(): string | null {
  const cc = emccPath();
  const res = spawnSync(cc, ['--version'], { encoding: 'utf8', env: webCompileEnv() });
  if (res.error) return `emcc not found: ${cc}`;
  if (res.status !== 0) {
    const first = (res.stderr || '').trim().split('\n')[0];
    return `emcc not usable${first ? ` — ${first}` : ''}`;
  }
  return null;
}

// The env (PATH) handed to every emcc child process for a web build.
export function webCompileStepsEnv(): Record<string, string> | undefined {
  return webCompileEnv();
}

// Build the full set of Emscripten compiler invocations for `--package web`.
// Structure mirrors buildCompileSteps: compile the generated .c (C99 compound
// literals, so it must stay on the C path) and any C++ glue sources separately,
// then link everything with emcc (which auto-links libc++). The output is
// `<base>.html` plus Emscripten's `<base>.js` + `<base>.wasm` sidecars.
//
// Emscripten link flags:
//   -s ALLOW_MEMORY_GROWTH=1  — Skia raster needs more than the default 16 MB;
//   -s USE_ZLIB=1             — RUNTIME_PREAMBLE uses <zlib.h> (ByteArray);
//   (SUPPORT_LONGJMP is left at its default: Emscripten 3.x emulates
//   setjmp/longjmp for AS3 throw/try/catch without extra flags.)
export function buildWebCompileSteps(cfg: BuildConfig, cPath: string, base: string): string[][] {
  const emcc = emccPath();
  const cppFiles = cfg.sources.filter(isCppSource);
  const cFiles = [cPath, ...cfg.sources.filter((s) => !isCppSource(s))];
  // Target-tagged intermediates: the same source (vendor/skia_glue.cc, …) is
  // compiled by clang for native and by emcc here, and both used to write
  // `x.o` — whichever target ran last clobbered the other's object, so an
  // incremental rebuild (reusing existing objects) failed in wasm-ld with
  // "unknown file type: skia_glue.o" (stage 89-32). Emscripten objects get
  // `.wasm.o` so the native and web object sets can coexist.
  const objSuffix = cfg.target === 'wasm' ? '.wasm.o' : '.o';
  const objOf = (src: string): string => src.replace(/\.[^.]+$/, objSuffix);

  const compileCommon: string[] = [cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg)];
  for (const d of effectiveDefines(cfg)) compileCommon.push('-D', d);
  for (const p of cfg.includePaths) compileCommon.push('-I', p);
  // USE_ZLIB must be on the *compile* steps too (not just the link): the
  // generated .c's RUNTIME_PREAMBLE does `#include <zlib.h>` and emcc only
  // adds that header's include path when USE_ZLIB is set.
  compileCommon.push('-s', 'USE_ZLIB=1');

  const steps: string[][] = [];
  for (const f of cFiles) {
    steps.push([emcc, '-c', ...compileCommon, f, '-o', objOf(f)]);
  }
  // Skia is a C++17 codebase; pin the level for the glue layer exactly as the
  // native build does. The generated .c above stays C and must not see -std=c++17.
  // SK_TRIVIAL_ABI must match the wasm libskia.a's build: the wasm build sets
  // is_trivial_abi=true (gn/BUILDCONFIG.gn default for non-official builds), which
  // compiles sk_sp with [[clang::trivial_abi]]. If the glue layer omits it, every
  // Skia call has an ABI mismatch (wasm-ld warns, and it *crashes* at runtime,
  // not compile time) — see docs/zh-cn/html5-web.md §3.4.
  for (const f of cppFiles) {
    steps.push([emcc, '-c', '-std=c++17', ...compileCommon, '-D', 'SK_TRIVIAL_ABI=[[clang::trivial_abi]]', f, '-o', objOf(f)]);
  }

  const linkArgs: string[] = [emcc, cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg)];
  for (const f of cFiles) linkArgs.push(objOf(f));
  for (const f of cppFiles) linkArgs.push(objOf(f));
  for (const o of cfg.objects) linkArgs.push(o);
  for (const p of cfg.linkPaths) linkArgs.push('-L', p);
  for (const l of cfg.linkLibs) linkArgs.push('-l', l);
  linkArgs.push('-s', 'ALLOW_MEMORY_GROWTH=1');
  linkArgs.push('-s', 'USE_ZLIB=1');
  // MAX_WEBGL_VERSION=2 enables WebGL2 support in Emscripten's generated JS glue.
  // The Ganesh GPU backend (GrGLInterfaces::MakeWebGL) links against the WebGL2
  // function pointers Emscripten exposes under <GLES3/gl32.h>; without this flag
  // those symbols are undefined at link time and the renderMode=gpu path cannot
  // build. It is harmless for the cpu path (the JS glue simply never requests a
  // WebGL2 context unless the app asks for one).
  linkArgs.push('-s', 'MAX_WEBGL_VERSION=2');
  // Export the runtime entry points the generated index.html calls from JS:
  // _malloc/_free to copy fetched font bytes into wasm memory before injecting
  // them, and _sk_fontmgr_register_data (already EMSCRIPTEN_KEEPALIVE, listed
  // here for clarity). _main is always exported. Without _malloc/_free the
  // font-injection code in index.html fails with "Module._malloc is not a
  // function" and text renders as nothing.
  linkArgs.push('-s', 'EXPORTED_FUNCTIONS=["_main","_malloc","_free","_sk_fontmgr_register_data"]');
  // Resource preloads -> one packed FS image. `--preload-file src@dest` packs host
  // src into the image at /dest, and the generated JS mounts it into MEMFS as a
  // run dependency: `doRun()` (which fires onRuntimeInitialized) only runs once
  // the package data has been fetched and written. That ordering is what makes the
  // HTML bootstrap's font injection see a populated FS, and what makes the app's
  // own `fopen`/`opendir` on 'assets/...' work — the wasm sandbox otherwise starts
  // with an empty FS and the load queue stalls at 0%. A directory preloads
  // recursively; the `.data` sidecar is fetched over HTTP, so the page must be
  // served (as it already must be for the .wasm). The dest is always explicit:
  // emcc's default dest for an absolute source is relative to the build's CWD,
  // which the served page knows nothing about.
  for (const spec of cfg.preloadPaths) linkArgs.push('--preload-file', spec);
  // Sparse holes in the preload set (see BuildConfig.preloadExcludes). emcc has no
  // "everything under this root except X" form, so a file that must not ship in
  // the FS image is named here instead — measured: `--exclude-file <abs path>`
  // drops exactly that file (`.data` shrinks by its size) while every sibling,
  // including names containing `@`, stays put.
  for (const pattern of cfg.preloadExcludes) linkArgs.push('--exclude-file', pattern);
  if (cfg.preloadPaths.length > 0) linkArgs.push('-s', 'FORCE_FILESYSTEM=1');
  // Defer running main() so the host can fetch fonts and inject them before the
  // first render (see the generated index.html's onRuntimeInitialized). The
  // index.html is generated by index.ts, not emcc, so emit the JS+wasm sidecars
  // only (-o base.js) and skip emcc's default HTML shell.
  linkArgs.push('-s', 'INVOKE_RUN=0');
  linkArgs.push('-o', `${base}.js`);
  steps.push(linkArgs);

  return steps;
}
