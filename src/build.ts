// Build orchestration: turns the generated C plus optional extra sources,
// include paths and link libraries into a compiler invocation for a chosen
// target (native executable or WASI .wasm). Keeps the "single readable .c"
// pipeline as the default shape while allowing third-party libraries (skia,
// cairo, SDL, ...) to be linked in exactly the way TypePHP links GMP/MPFR/PHPX.
//
// The frontend still only translates AS -> C; everything here is *linking and
// targeting*, not optimization or machine-code generation.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, copyFileSync, writeFileSync, mkdirSync, rmSync, statSync, renameSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname, join, basename, delimiter, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export type Target = 'native' | 'wasm';

// 分发形态（§6 设计）：编译后端产出裸产物之后，如何组织成工程/包。与
// `target`（机器码 ABI）正交——同一个 package 形态对所有 target 后端复用。
// `app`/`dmg`/`exe` 是一键脚本发布路线，`xcode-project` 保留给 IDE 调试。
// `web` 是浏览器页面（.wasm + .js 胶水 + index.html），与其他形态同层级，
// 都只是「如何组织产物」；它要求 target=wasm（emcc 后端）。
export type Package = 'raw' | 'xcode-project' | 'android-project' | 'web' | 'app' | 'dmg' | 'exe';

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
  // .ane native-extension packages whose extension.xml is resolved at compile
  // time into the descriptor table the generated executable carries (阶段一百七十二).
  // Paths are resolved relative to the manifest that declares them.
  anePaths: string[];
  // AIR platform key to read out of each .ane's extension.xml. Empty means "the
  // platform this build is running on" (see currentAnePlatform); it is only ever
  // set for a cross-build, where the answer is not the build machine.
  anePlatform: string;
  includePaths: string[];
  linkLibs: string[];
  linkPaths: string[];
  defines: string[];
  // Raw flags forwarded verbatim to the C/C++ compiler (and the link line) on
  // EVERY step of the build -- `--cflag <flag>` / `-w` on the CLI, `c-flags` in
  // a manifest (阶段二百四十六).
  //
  // The motivating case is `-w`: the Windows CRT marks `getenv`/`fopen` as
  // deprecated, and every generated build prints that noise with no way to turn
  // it off (`-Wno-deprecated-declarations` did not exist either, and patching the
  // preamble to use `_dupenv_s` would fork the POSIX path). This is a passthrough,
  // not a curated flag list: what the compiler understands is the user's business,
  // and a flag the compiler rejects must fail the build loudly (that is the proof
  // it really reached the compiler -- pinned in `unit: build/CFlags`).
  //
  // Empty by default, so a build that names no flag is byte-for-byte the build it
  // was before (§1.5's default-artifact rule).
  cFlags: string[];
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
  icon: string | null;       // finished .icns/.ico path; null = use AIR icons or none
  // AIR <icon> PNG files, keyed by their element name (image16x16, ...).
  // Kept separate from `icon`: that field is an already-finished platform icon,
  // while this set is converted by the packager selected for the current host.
  airIcons: Record<string, string>;
  deploymentTarget: string;  // macOS minimum version (fills LSMinimumSystemVersion)
  version: string;
  buildVersion: string;
  signingIdentity: string;
  notaryProfile: string;
  entitlements: string | null;
  timestampServer: string;
  // AIR <architecture> bit width ("32" | "64"), carried by --air-app; a plain
  // manifest may also spell "arm64" for a Windows ARM64 native build. On a Windows
  // native build this is what selects the MSVC target triple (i686 vs x86_64 vs
  // aarch64); it is inert on macOS/wasm. Empty for non-AIR builds (let clang pick
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
    anePaths: [],
    anePlatform: '',
    includePaths: [],
    linkLibs: [],
    linkPaths: [],
    defines: [],
    cFlags: [],
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
    airIcons: {},
    deploymentTarget: '12.0',
    version: '',
    buildVersion: '',
    signingIdentity: '',
    notaryProfile: '',
    entitlements: null,
    timestampServer: 'http://timestamp.digicert.com',
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
  package?: 'raw' | 'xcode-project' | 'android-project' | 'web' | 'app' | 'dmg' | 'exe';
  'c-compiler'?: string;
  opt?: string;
  'debug-info'?: boolean;
  lto?: boolean;
  pgo?: 'generate' | 'use';
  'pgo-dir'?: string;
  sources?: string[];
  'swc-paths'?: string[];
  'ane-paths'?: string[];
  'ane-platform'?: string;
  'include-paths'?: string[];
  'link-libs'?: string[];
  'link-paths'?: string[];
  defines?: string[];
  'c-flags'?: string[];
  features?: string[];
  // GPU window backend name, recorded by `--air-app` from `--gpu-backend`. Not a
  // switch: air-app.ts already turned it into `defines`/`sources`/`link-libs`,
  // which is what the compiler reads, so this field is (a) how the choice
  // survives manifest regeneration and (b) a consistency claim that applyManifest
  // verifies against those defines. Top-level only (deliberately absent from
  // TARGET_LAYER_FIELDS): the backend decides which glue file and which import
  // library are linked, and a per-target overlay could only desynchronise that
  // from the defines emitted for the shared default.
  'gpu-backend'?: 'auto' | 'd3d12' | 'gl';
  objects?: string[];
  frameworks?: string[];
  exports?: string[];
  'font-urls'?: string[];
  'preload-paths'?: string[];
  'preload-excludes'?: string[];
  'bundle-id'?: string;
  'display-name'?: string;
  icon?: string;
  'air-icons'?: Record<string, string>;
  'deployment-target'?: string;
  version?: string;
  'build-version'?: string;
  'signing-identity'?: string;
  'notary-profile'?: string;
  entitlements?: string;
  'timestamp-server'?: string;
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

// Every key a TOP-LEVEL manifest object may carry. The `Record<..., true>` type is
// the drift guard, not decoration: adding a field to ManifestFields without
// listing it here (or misspelling it here) fails to compile, so this list cannot
// rot into a stale second copy of the interface. `targets` is listed even though
// it is not a ManifestFields member -- the overlay block IS a top-level key.
//
// loadManifest rejects anything missing from it. Without that check a typo is a
// silent no-op: `"link-lib": ["skia"]` (one `s` short) dropped the library and
// surfaced much later as an unrelated `undefined symbol`, while `"define"` left
// the macro out of the compile and the build still reported success -- exactly the
// "compiles, but wrong" outcome AGENTS.md §2.5 forbids. It is the same rule
// TARGET_LAYER_FIELDS has enforced one level down since 阶段八十九·五十; the top
// level simply never got it.
const MANIFEST_FIELD_NAMES: Record<keyof ManifestFields | 'targets', true> = {
  target: true,
  package: true,
  'c-compiler': true,
  opt: true,
  'debug-info': true,
  lto: true,
  pgo: true,
  'pgo-dir': true,
  sources: true,
  'swc-paths': true,
  'ane-paths': true,
  'ane-platform': true,
  'include-paths': true,
  'link-libs': true,
  'link-paths': true,
  defines: true,
  'c-flags': true,
  features: true,
  'gpu-backend': true,
  objects: true,
  frameworks: true,
  exports: true,
  'font-urls': true,
  'preload-paths': true,
  'preload-excludes': true,
  'bundle-id': true,
  'display-name': true,
  icon: true,
  'air-icons': true,
  'deployment-target': true,
  version: true,
  'build-version': true,
  'signing-identity': true,
  'notary-profile': true,
  entitlements: true,
  'timestamp-server': true,
  architecture: true,
  targets: true,
};
const MANIFEST_FIELDS: ReadonlySet<string> = new Set(Object.keys(MANIFEST_FIELD_NAMES));

// Keys that are command-line options with no manifest spelling. A user who writes
// one has not made a typo, they have put it on the wrong side of the tool, and the
// error should say so instead of guessing at a near-miss field: `as-class-path` is
// an AS-side input (docs/zh-cn/compile.md §3.5.2) that the build layer never
// reads, so a manifest entry for it could only ever be ignored.
// Names that ARE one edit from a real field (`source` -> `sources`, `swc` ->
// `swc-paths`, `cflag` -> `c-flags`) are deliberately absent here: the near-miss
// suggestion is the better answer for those, and it is tried first.
const CLI_ONLY_KEYS: ReadonlySet<string> = new Set([
  'main-class', 'all-sources', 'include-third-party', 'as-class-path',
  'air-app', 'manifest', 'run', 'dry', 'json', 'fix', 'verbose', 'version',
  'help', 'check-update', 'extdir', 'output', 'ane',
]);

// Fields a `targets.<name>` block is allowed to override. Anything else is a
// typo and must fail loudly (AGENTS.md §2.5), not be silently ignored.
const TARGET_LAYER_FIELDS: ReadonlySet<string> = new Set([
  'c-compiler', 'opt', 'sources', 'include-paths', 'link-libs', 'link-paths',
  'defines', 'features', 'objects', 'frameworks', 'exports', 'font-urls',
  'preload-paths', 'preload-excludes', 'c-flags',
  'debug-info', 'lto', 'pgo', 'pgo-dir',
  'swc-paths',
  'ane-paths', 'ane-platform',
  'bundle-id', 'display-name', 'icon', 'air-icons', 'deployment-target',
  'version', 'build-version', 'signing-identity', 'notary-profile',
  'entitlements', 'timestamp-server',
]);

// Plain Levenshtein, two rows of state (no dependency, no per-cell allocation).
// Exported because the CLI's `--flag` suggester in index.ts needs the same
// distance: two copies would drift the first time either threshold is retuned,
// and index.ts already imports from here (so this direction adds no cycle).
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Same two shapes suggestFlag() guesses at -- a misspelling of a long name, and a
// name the user stopped typing halfway -- and the same reluctance to guess: a
// confident wrong suggestion costs more than none, so closeness is measured
// relative to the key's own length rather than with an absolute threshold.
function suggestManifestField(key: string): string {
  let best = '';
  let bestDist = 3;
  for (const f of MANIFEST_FIELDS) {
    const d = editDistance(key, f);
    if (d < bestDist && d * 3 <= key.length) { bestDist = d; best = f; }
  }
  if (best !== '') return best;
  // Nothing near, but the user may simply have stopped typing: `swc` is five
  // edits from `swc-paths`, far enough that Levenshtein says no and a prefix test
  // says yes. Only when it is unambiguous -- two candidates means a coin flip.
  const candidates = [...MANIFEST_FIELDS].filter((f) => f.length > key.length && f.startsWith(key));
  return candidates.length === 1 ? candidates[0] : '';
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
  const obj = parsed as Record<string, unknown>;
  // `$`-prefixed keys are metadata rather than build settings (`$schema` being the
  // usual one), so letting them through avoids pushing people into
  // JSON-with-pseudo-comments hacks.
  const unknown = Object.keys(obj).filter((k) => !MANIFEST_FIELDS.has(k) && !k.startsWith('$'));
  if (unknown.length > 0) {
    const named = unknown.map((k) => {
      const near = suggestManifestField(k);
      if (near !== '') return `'${k}' (did you mean '${near}'?)`;
      if (CLI_ONLY_KEYS.has(k)) return `'${k}' (a command-line option -- set it there, not in a manifest)`;
      return `'${k}'`;
    });
    throw new Error(
      `build manifest: unknown ${unknown.length === 1 ? 'field' : 'fields'} ${named.join(', ')} ` +
      `(known: ${[...MANIFEST_FIELDS].join(', ')}) — ${path}`,
    );
  }
  return obj as Manifest;
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
  // `architecture` is resolved HERE, before any list is templated, because
  // ${host} needs it: on Windows it is what picks windows-x64 vs windows-x86, and
  // a template expanded against the wrong one produces a plausible, wrong -L path
  // (see the host-template block below). It is a top-level-only field (not in
  // TARGET_LAYER_FIELDS), so no later step can change it out from under us.
  if (m.architecture) {
    // "32"/"64" are AIR's own values (parseAirApp rejects anything else in a
    // descriptor). `arm64` is a manifest-only extension naming a Windows ARM64
    // native build — AIR has no Windows ARM64 runtime, so it can never appear in
    // an air-app.xml, but a plain as3compiler manifest may target it. Rejecting
    // anything else here is what keeps windowsTargetTriple's default from
    // silently turning a typo into an x86_64 build.
    if (m.architecture !== '32' && m.architecture !== '64' && m.architecture !== 'arm64') {
      throw new Error(`manifest 'architecture' must be "32", "64" or "arm64" (got "${m.architecture}")`);
    }
    next.architecture = m.architecture;
  }
  const ht = hostTemplate(next.target, next.architecture);
  const T = (list: string[]): string[] => expandTemplateList(list, ht, manifestPath);
  if (m['c-compiler']) next.cCompiler = m['c-compiler'];
  if (m.opt) next.opt = m.opt;
  if (m['debug-info'] !== undefined) next.debugInfo = m['debug-info'];
  if (m.lto !== undefined) next.lto = m.lto;
  if (m.pgo) next.pgo = m.pgo;
  if (m['pgo-dir']) next.pgoDir = resolveFromManifest(manifestPath, m['pgo-dir']);
  if (m.sources) next.sources = [...cfg.sources, ...T(m.sources).map((p) => resolveFromManifest(manifestPath, p))];
  if (m['swc-paths']) next.swcPaths = [...cfg.swcPaths, ...T(m['swc-paths']).map((p) => resolveFromManifest(manifestPath, p))];
  if (m['ane-paths']) {
    // Appended to the CLI's --ane list (a manifest adds packages), but never the
    // same package twice. An --air-app build now DERIVES ane-paths from the
    // descriptor's <extensions> (see air-app.ts), so a user mid-migration who still
    // passes the package with --ane would hand one package in twice and get "two
    // ANEs declare the same extensionID" -- a wrong-cause diagnosis for a list that
    // simply names one package more than once (§2.5). Compared as resolved paths,
    // because the CLI's are cwd-relative and the manifest's are manifest-relative.
    const have = new Set(cfg.anePaths.map((p) => resolve(p)));
    next.anePaths = [...cfg.anePaths];
    for (const p of T(m['ane-paths']).map((q) => resolveFromManifest(manifestPath, q))) {
      if (have.has(resolve(p))) continue;
      have.add(resolve(p));
      next.anePaths.push(p);
    }
  }
  if (m['ane-platform']) next.anePlatform = m['ane-platform'];
  if (m['include-paths']) next.includePaths = [...cfg.includePaths, ...T(m['include-paths']).map((p) => resolveFromManifest(manifestPath, p))];
  if (m['link-libs']) next.linkLibs = [...cfg.linkLibs, ...T(m['link-libs'])];
  if (m['link-paths']) next.linkPaths = [...cfg.linkPaths, ...T(m['link-paths']).map((p) => resolveFromManifest(manifestPath, p))];
  if (m.defines) next.defines = [...cfg.defines, ...T(m.defines)];
  // GPU window backend: VERIFIED against the defines, never re-derived. The
  // backend is already fully expressed by `defines` + `sources` + `link-libs`
  // (air-app.ts emits all three together), so deriving it again here would be a
  // second implementation of the same rule — the thing this project keeps
  // refusing. What the check buys is the hand edit: a manifest whose `gpu-backend`
  // names one backend while its defines compile another would otherwise be
  // accepted, with the defines silently winning (§2.5).
  if (m['gpu-backend'] !== undefined) {
    const b = m['gpu-backend'];
    if (b !== 'auto' && b !== 'd3d12' && b !== 'gl') {
      throw new Error(`manifest 'gpu-backend' must be "auto", "d3d12" or "gl" (got ${JSON.stringify(b)}) — ${manifestPath}`);
    }
    const macros = new Set(next.defines.map((d) => d.split('=')[0].trim()));
    const want = b === 'gl' ? 'ASC_RENDER_GL' : b === 'd3d12' ? 'ASC_RENDER_D3D' : null;
    const other = b === 'gl' ? 'ASC_RENDER_D3D' : b === 'd3d12' ? 'ASC_RENDER_GL' : null;
    if (want !== null && !macros.has(want)) {
      throw new Error(
        `manifest 'gpu-backend' is "${b}" but 'defines' does not carry ${want} — ${manifestPath}\n` +
        `  a backend is applied through its define + glue source + import library, so this field\n` +
        `  cannot switch anything on its own: regenerate with --gpu-backend ${b} (via --air-app),\n` +
        `  or add "${want}=1" to 'defines' yourself`
      );
    }
    if (other !== null && macros.has(other)) {
      throw new Error(
        `manifest 'gpu-backend' is "${b}" but 'defines' also carries ${other} — ${manifestPath}\n` +
        `  one binary links one window GPU backend; drop one of the two`
      );
    }
  }
  // Flags have no path semantics, so they are passed through verbatim -- a
  // `-Wl,-rpath,/x` or `-fuse-ld=` would be mangled by any "resolve" step.
  if (m['c-flags']) next.cFlags = [...cfg.cFlags, ...T(m['c-flags'])];
  if (m.features) next.features = [...cfg.features, ...T(m.features)];
  if (m.objects) next.objects = [...cfg.objects, ...T(m.objects).map((p) => resolveFromManifest(manifestPath, p))];
  if (m.frameworks) next.frameworks = [...cfg.frameworks, ...T(m.frameworks)];
  if (m.exports) next.exports = [...cfg.exports, ...T(m.exports)];
  if (m['font-urls']) next.fontUrls = [...cfg.fontUrls, ...T(m['font-urls'])];
  if (m['preload-paths']) {
    next.preloadPaths = [
      ...cfg.preloadPaths,
      ...T(m['preload-paths']).map((p) => resolvePreloadSpec(manifestPath, p)),
    ];
  }
  if (m['preload-excludes']) {
    next.preloadExcludes = [
      ...cfg.preloadExcludes,
      ...T(m['preload-excludes']).map((p) => resolveFromManifest(manifestPath, p)),
    ];
  }
  if (m['bundle-id']) next.bundleId = m['bundle-id'];
  if (m['display-name']) next.displayName = m['display-name'];
  if (m.icon) next.icon = resolveFromManifest(manifestPath, expandTemplateText(m.icon, ht, manifestPath));
  if (m['air-icons']) {
    next.airIcons = Object.fromEntries(Object.entries(m['air-icons']).map(([k, p]) => [k, resolveFromManifest(manifestPath, p)]));
  }
  if (m['deployment-target']) next.deploymentTarget = m['deployment-target'];
  if (m.version) next.version = m.version;
  if (m['build-version']) next.buildVersion = m['build-version'];
  if (m['signing-identity']) next.signingIdentity = m['signing-identity'];
  if (m['notary-profile']) next.notaryProfile = m['notary-profile'];
  if (m.entitlements) next.entitlements = resolveFromManifest(manifestPath, m.entitlements);
  if (m['timestamp-server']) next.timestampServer = m['timestamp-server'];
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
  const ht = hostTemplate(target, cfg.architecture);
  const T = (list: string[]): string[] => expandTemplateList(list, ht, manifestPath);
  if (L['c-compiler']) next.cCompiler = L['c-compiler'];
  if (L.opt) next.opt = L.opt;
  if (L['debug-info'] !== undefined) next.debugInfo = L['debug-info'];
  if (L.lto !== undefined) next.lto = L.lto;
  if (L.pgo) next.pgo = L.pgo;
  if (L['pgo-dir']) next.pgoDir = resolveFromManifest(manifestPath, L['pgo-dir']);
  if (L.sources) next.sources = T(L.sources).map((p) => resolveFromManifest(manifestPath, p));
  if (L['swc-paths']) next.swcPaths = T(L['swc-paths']).map((p) => resolveFromManifest(manifestPath, p));
  if (L['ane-paths']) next.anePaths = T(L['ane-paths']).map((p) => resolveFromManifest(manifestPath, p));
  if (L['ane-platform']) next.anePlatform = L['ane-platform'];
  if (L['include-paths']) next.includePaths = T(L['include-paths']).map((p) => resolveFromManifest(manifestPath, p));
  if (L['link-libs']) next.linkLibs = T(L['link-libs']);
  if (L['link-paths']) next.linkPaths = T(L['link-paths']).map((p) => resolveFromManifest(manifestPath, p));
  if (L.defines) next.defines = T(L.defines);
  if (L['c-flags']) next.cFlags = T(L['c-flags']);
  if (L.features) next.features = T(L.features);
  if (L.objects) next.objects = T(L.objects).map((p) => resolveFromManifest(manifestPath, p));
  if (L.frameworks) next.frameworks = T(L.frameworks);
  if (L.exports) next.exports = T(L.exports);
  if (L['font-urls']) next.fontUrls = T(L['font-urls']);
  if (L['preload-paths']) next.preloadPaths = T(L['preload-paths']).map((p) => resolvePreloadSpec(manifestPath, p));
  if (L['preload-excludes']) next.preloadExcludes = T(L['preload-excludes']).map((p) => resolveFromManifest(manifestPath, p));
  if (L['bundle-id']) next.bundleId = L['bundle-id'];
  if (L['display-name']) next.displayName = L['display-name'];
  if (L.icon) next.icon = resolveFromManifest(manifestPath, expandTemplateText(L.icon, ht, manifestPath));
  if (L['air-icons']) {
    next.airIcons = Object.fromEntries(Object.entries(L['air-icons']).map(([k, p]) => [k, resolveFromManifest(manifestPath, p)]));
  }
  if (L['deployment-target']) next.deploymentTarget = L['deployment-target'];
  if (L.version) next.version = L.version;
  if (L['build-version']) next.buildVersion = L['build-version'];
  if (L['signing-identity']) next.signingIdentity = L['signing-identity'];
  if (L['notary-profile']) next.notaryProfile = L['notary-profile'];
  if (L.entitlements) next.entitlements = resolveFromManifest(manifestPath, L.entitlements);
  if (L['timestamp-server']) next.timestampServer = L['timestamp-server'];
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

// Link-time trimming (阶段二百二十二). Unlike every flag above, this is a LINKER
// decision, and it is the only remaining lever that changes what a Skia build
// drags in now that the text engine is a separate object file (阶段二百二十一):
//
//   -dead_strip  ld64 drops unreachable code/data blocks BEFORE resolving the
//                references inside them, so a glue .o that mentions a Skia API
//                the program never calls no longer pulls that archive member in.
//                It also makes the ICU data object below droppable when nothing
//                references it, which is what keeps text-free builds at 3.55 MB.
//   -x           drops the local symbols from the __LINKEDIT symbol table. Global
//                text symbols survive, so a dlopen'd extension's entry points
//                still resolve.
//
// Measured on examples/tf-scale-metrics.as (text build, our 0.80 MB data set in
// place): 9,985,352 B with NO trim -> 7,224,000 B with -dead_strip -> 6,049,032 B
// with both. The 1.17 MB step is the local symbol table, so the two flags are
// worth emitting as a pair rather than just the first one.
//
// Deliberately NOT applied here:
//   * LTO stays the opt-in `--lto` (E12) and is not part of this set: measured on
//     the split artifact it produces 3,567,592 bytes against 3,554,632 -- 13 KB
//     LARGER, because Skia's archives carry no bitcode, so -flto can only
//     optimize our own two TUs.
//   * --gc-sections on ELF / COFF: it needs -ffunction-sections/-fdata-sections at
//     COMPILE time (including inside every prebuilt archive) before it saves a
//     byte. Emitting it now would buy a flag that looks like it works and does
//     nothing, so the whole family stays off rather than silently ineffective.
//   * `-x` under --debug-info: that build asked for symbols.
export function linkTrimFlags(cfg: BuildConfig): string[] {
  if (cfg.target !== 'native' || process.platform !== 'darwin') return [];
  const flags = ['-Wl,-dead_strip'];
  if (!cfg.debugInfo) flags.push('-Wl,-x');
  return flags;
}

// 32-bit Windows builds opt into the 4 GB user address space
// (`/LARGEADDRESSAWARE`). This is the same choice AIR itself makes, not a
// micro-optimisation: the AIRSDK 51.4.1 `adl.exe` is x86 *with* the LAA bit set,
// and so is the Chromium `libcef.dll` such a program usually embeds. Without the
// bit a 32-bit process gets 2 GB of user address space no matter how much RAM the
// machine has, and "out of memory" then arrives as a failed `malloc` while the
// AS3 heap is still small.
//
// Measured on the TalkMED client (7 ANEs incl. CEF/RTC, D3D12 + Skia): it died at
// `malloc failed for 8294416 bytes (gc heap 83.0 MB in 276 segments, 23.6 MB free,
// arena 0.0 MB)` -- 8294416 is exactly one 1920x1080 RGBA frame plus the GC
// header, and 83 MB is the whole AS3 heap. lld-link sets the bit only on request:
// the PE characteristics word of the produced exe read 0x0102 (no 0x0020) before
// this existed, i.e. a hard 2 GB ceiling for a program that maps CEF, D3D12 and
// the Skia GPU backend.
//
// Link-only, and 32-bit-only: a compile step has no use for it, and x86_64 /
// arm64 images are large-address-aware by definition.
export function windowsLinkFlags(cfg: BuildConfig): string[] {
  if (process.platform !== 'win32' || cfg.target !== 'native') return [];
  if (cfg.architecture !== '32') return [];
  return ['-Wl,/LARGEADDRESSAWARE'];
}

// Export ONE symbol into the executable's DYNAMIC symbol table, so that
// dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue") finds it at runtime (阶段二百八十八).
//
// This is not cosmetic. Stage3D's Metal glue adopts the very MTLCommandQueue that
// Skia's Ganesh context submits its canvas work on, and it finds that queue by
// NAME (vendor/stage3d_glue.mm's sk_mtl_shared_queue_lookup): the same file also
// links into a headless build that has no metal_glue at all, so the accessor
// cannot be a direct reference. Metal only tracks resource hazards within ONE
// queue, so when the lookup fails and Stage3D silently falls back to a private
// queue, the 2D composite (which samples the Stage3D render target) reads it
// while the 3D pass writes it. Measured on examples/air-starling-demo: 51 of 82
// benchmark frames composited a target that held only its background pass --
// sky and 2D overlay, no objects, the user's "画面闪烁消失" -- and 0 of 148 once
// the queues were actually one. A main executable's globals are NOT in the
// dynamic symbol table unless the link names them, so the lookup failed in
// *windowed* builds too, no matter how the glue was written.
//
// Named rather than broad because `-export_dynamic` exports every global: on that
// demo it pushed Skia/ICU symbols into the table and grew the artifact
// 11,319,104 B -> 12,202,688 B, while naming this one costs 8 KB.
export function exportDynamicFlags(cfg: BuildConfig): string[] {
  if (cfg.target === 'wasm') return [];
  if (process.platform === 'win32') return [];  // a PE exports by dllexport (see d3d_glue.cc)
  // The gate is "does this build link the Metal glue", not "is Stage3D enabled":
  // -exported_symbol names a symbol, so a headless Stage3D build
  // (examples/stage83.build.json links stage3d_glue.mm alone) has nothing there
  // and fails to link outright ("Undefined symbols: _sk_mtl_shared_queue").
  const defines = effectiveDefines(cfg);
  if (!defines.some((d) => d === 'ASC_RENDER_STAGE3D' || d === 'ASC_RENDER_STAGE3D=1')) return [];
  if (!cfg.sources.some((s) => /(^|[/\\])metal_glue\.mm$/.test(s))) return [];
  if (process.platform === 'darwin') return ['-Wl,-exported_symbol,_sk_mtl_shared_queue'];
  // ELF's mirror image would be --export-dynamic-symbol, but that only exists in
  // GNU ld >= 2.35 / lld and this host cannot tell which linker a user has, so
  // the universal broad flag stays.
  return ['-Wl,--export-dynamic'];
}

// ---- ICU data: link the 0.80 MB blob, not the 10.19 MB default ---------------
//
// vendor/skia/lib/macos-arm64/{libskunicode.a,libicu.a} each carry a one-member
// `icudtl_dat.o` holding the WHOLE desktop ICU data set (`_icudt69_dat`, 10.19 MB).
// Only one of the two ever gets linked -- the skunicode one, because `-l skunicode`
// precedes `-l icu` -- and the choice is pure DATA, not code: Skia itself already
// ships a filtered data set for wasm (third_party/icu/BUILD.gn sends wasm to
// `flutter/icudtl.dat`, 0.80 MB). The desktop `common` data set pays 9.4 MB for
// resources this pipeline never opens (collation, locales, currency, region, rbnf,
// transliteration, converters, unames); what it needs -- UAX#14 line-break rules,
// bidi properties, NFKC, grapheme/word/char breakers -- is in the small one.
//
// Defining the symbol in OUR OWN object is what makes the archive member moot: an
// archive member is only pulled when one of its symbols is still undefined, so the
// 10.19 MB object is never even read. That keeps this a per-build decision against a
// STOCK vendor tree (no archive surgery, nothing to re-provision); the price is that
// the object must precede the -l flags, which is where cfg.objects already lands.
//
// Only the text engine consumes this data, so a build without ASC_HAVE_TEXT skips
// the step entirely (and would anyway: -dead_strip drops an unreferenced blob).
//
// The gate is ASC_HAVE_TEXT ALONE -- deliberately NOT "the manifest lists -l icu"
// (阶段二百二十三). Gating on the link library looked equivalent and was not: a
// manifest that links skia but happens to omit `icu` still shapes text, because
// libskunicode.a carries its own copy of the data member, so the old gate skipped
// the substitution and the build silently shipped the 10.19 MB data set again.
// Measured on examples/tf-scale-metrics.as with `icu` removed from link-libs:
// 15,510,408 B instead of 6,049,032 B, exit code 0, not one word of output. The
// object is harmless when nothing consumes it (it is one blob; -dead_strip drops
// it), so the wider gate is also the safer direction.
const ICU_FLUTTER_DAT = '../vendor/skia/icu/icudtl_flutter.dat';

// The ICU data version the LINKED archives expect, read out of the archive that
// actually donates the member (libskunicode.a -- `-l skunicode` precedes `-l icu`,
// which is why replacing libicu.a alone changed nothing). The data symbol is
// version-tagged (`_icudt69_dat`), so a mismatch cannot corrupt a build: the
// wrong-version blob is simply never referenced and both data sets end up linked.
// It is a SIZE canary, not a correctness guard -- which is exactly why it has to
// be reported: the symptom is 9.46 MB that reappears with no other trace.
// Returns null when no such archive is reachable, which is not a mismatch.
export function icuArchiveDataVersion(cfg: BuildConfig): string | null {
  for (const dir of cfg.linkPaths) {
    const archive = join(dir, 'libskunicode.a');
    if (!existsSync(archive)) continue;
    const res = spawnSync('nm', ['-g', archive], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    if (res.status !== 0 || !res.stdout) return null;
    // A definition line looks like `0000000000000000 S _icudt69_dat`; an
    // undefined one (`U`) is a reference, not a data set, so require a letter
    // other than U.
    const m = res.stdout.match(/^[0-9a-f]+\s+(?!U\b)[A-Za-z?]\s+_icudt(\d\d)_dat$/m);
    return m ? m[1] : null;
  }
  return null;
}

let icuWarned = false;
function icuWarn(msg: string): void {
  if (icuWarned) return;
  icuWarned = true;
  process.stderr.write(`warning: ${msg}\n`);
}

// The vendored data blob this build would substitute, or null when the substitute
// does not apply: only a macOS native link can take an externally supplied data
// object. `version` is the `icudtNN` marker the blob actually carries. Internal: the
// two public entry points below are what callers want (paths / materialise).
function icuBlob(cfg: BuildConfig): { dat: string; version: string } | null {
  if (cfg.target !== 'native' || process.platform !== 'darwin') return null;
  if (!cfg.defines.some((d) => d === 'ASC_HAVE_TEXT' || d.startsWith('ASC_HAVE_TEXT='))) return null;
  const dat = resolve(dirname(fileURLToPath(import.meta.url)), ICU_FLUTTER_DAT);
  if (!existsSync(dat)) {
    icuWarn(
      `the vendored ICU data set is missing (${dat}), so the linked Skia will carry its ` +
      `own 10.19 MB desktop data set instead of the 0.80 MB one (size only; text layout is unaffected).`,
    );
    return null;
  }
  const version = readIcuVersion(dat);
  if (!version) {
    throw new Error(`${dat} is not an ICU data package (no 'icudt' version marker)`);
  }
  // The substitute is only usable if it matches the ARCHIVE that donates the data
  // member; checking the pair here covers every caller (CLI link and Xcode project).
  warnOnIcuVersion(cfg, version);
  return { dat, version };
}

// Write the Mach-O assembly that defines _icudtNN_dat for a blob. Same shape as
// ICU's own scripts/make_data_assembly.py --mac: the blob is a little-endian data
// package, so each .long is written from its bytes reversed. Returns false when this
// build takes no substitute at all (text-free manifest, non-native target, or no
// vendored blob), in which case nothing is written and the caller adds no source.
//
// This is a build INPUT, materialised by the runner before the steps that consume it
// -- the command builder itself stays free of side effects (see runCompile).
export function writeIcuAssembly(cfg: BuildConfig, dest: string): boolean {
  const blob = icuBlob(cfg);
  if (!blob) return false;
  const bytes = readFileSync(blob.dat);
  const lines = [
    `.globl _icudt${blob.version}_dat`,
    '#ifdef U_HIDE_DATA_SYMBOL',
    `\t.private_extern _icudt${blob.version}_dat`,
    '#endif',
    '\t.data',
    '\t.const',
    '\t.align 4',
    `_icudt${blob.version}_dat:`,
  ];
  for (let i = 0; i < bytes.length; i += 4) {
    const word = bytes.subarray(i, Math.min(i + 4, bytes.length));
    let value = 0;
    for (let b = word.length - 1; b >= 0; b--) value = value * 256 + word[b];
    lines.push(`\t.long 0x${value.toString(16).toUpperCase()}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${lines.join('\n')}\n`);
  return true;
}

// Where this build's ICU data object and its assembler source live, or null when the
// substitute does not apply. Pure: it names the paths, the runner materialises them.
//
// Both are inside THIS build's scratch like every other object. They used to live next
// to the .dat and be assembled once (the same 800 KB for every build, so sharing looked
// free) -- but the compile step ran on every text build regardless, and `clang -c`
// truncates its output at open time, so a sibling build linking the same path read an
// empty file: `ld: file is empty in .../icudtl_flutter.o`, hit twice in three runs of
// the example suite. Assembling per build costs 0.2 s (measured: 45 ms to write 3.4 MB
// of hex, 155 ms to assemble) and removes the shared write entirely.
export function icuDataPaths(cfg: BuildConfig): { source: string; object: string; version: string } | null {
  const blob = icuBlob(cfg);
  if (!blob) return null;
  const dir = objectDir(cfg);
  return {
    source: join(dir, 'icudtl_flutter.s'),
    object: join(dir, 'icudtl_flutter.o'),
    version: blob.version,
  };
}

// The `icudtNN` marker in a data package's header (offset 308 in the vendored
// blob, well inside the first page, which is why the canary can read a slice).
// Single source of truth for the version: the assembly step and the archive
// canary must never disagree about which symbol this blob defines.
function icuVersionOf(bytes: Buffer): string {
  const at = bytes.indexOf('icudt');
  return at < 0 ? '' : bytes.subarray(at + 5, at + 7).toString('latin1');
}

// The version of the vendored blob, read from its first page.
function readIcuVersion(dat: string): string {
  return icuVersionOf(readFileSync(dat).subarray(0, 4096));
}

// Report the one combination that silently costs 9.46 MB: our blob defines
// `_icudtNN_dat` but the linked archive wants a different NN.
function warnOnIcuVersion(cfg: BuildConfig, mine: string): void {
  const theirs = icuArchiveDataVersion(cfg);
  if (!mine || !theirs || mine === theirs) return;
  icuWarn(
    `the vendored ICU data set is icudt${mine} but the linked libskunicode.a expects icudt${theirs}, ` +
    `so its 10.19 MB desktop data set will be linked as well (0.80 MB substitute unusable; size only, no behavioural change).`,
  );
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
const FEATURES: Readonly<Record<string, {
  macro: string;
  targets: readonly Target[];
  why: string;
  // The host the channel codes against. `--target native` builds for THIS machine,
  // so a Cocoa-only channel has to be refused up front on any other host rather
  // than linking to glue that is a stub there (阶段二百六十).
  host?: 'darwin';
}>> = {
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
  // `tray` (E19): a real macOS menu-bar status item (NSStatusItem) behind AIR's own
  // `flash.desktop.SystemTrayIcon`. On macOS `adl` reports
  // `supportsSystemTrayIcon == false` and `new SystemTrayIcon()` throws #2012, so
  // this is an AIR-SUPERSET enhancement: without the macro the runtime keeps that
  // exact refusal, with it the same AS3 code owns a live status item. Cocoa only,
  // and the compiler builds for the host, hence the `host` guard.
  tray: {
    macro: 'ASC_USE_TRAY=1',
    targets: ['native'],
    host: 'darwin',
    why: 'the status item is an NSStatusItem (AppKit), so the channel only exists on macOS',
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
function featureSpec(f: string): { macro: string; targets: readonly Target[]; why: string; host?: 'darwin' } {
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
    // A native build targets THIS machine, so a host-specific channel can be
    // checked exactly: on a non-macOS host the glue is a compiled-out stub, and
    // letting the build go ahead would hand the user a switch that silently does
    // nothing on the one machine it was meant for.
    if (spec.host !== undefined && process.platform !== spec.host) {
      throw new Error(
        `feature '${f}' needs a ${spec.host} host: ${spec.why}\n` +
        `  this machine is ${process.platform}; run without --features to get the AIR-identical default`
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
// the ABI explicitly: the archives vendor/provision/windows.ps1 produces are MSVC-ABI,
// and an AIR app whose <architecture> is "32" needs the i686 triple on every
// compile AND link step — otherwise clang emits x86_64 objects that cannot link
// against the windows-x86 archives. The triple is spelled out for "64" too so the
// MSVC ABI (not a stray MinGW default) is pinned, and it is inert on non-Windows
// hosts and non-native targets.
//
// `arm64` is deliberately NOT an AIR value — parseAirApp allows only "32"/"64",
// because AIR's Windows runtimes are x86/x64 only. It is the manifest-only name
// for a Windows ARM64 native build, and it exists so that a Windows-on-ARM host
// gets a *chosen* target instead of clang's host default (aarch64) reaching the
// linker with an x86_64 archive set, or — worse — an x64 build silently standing
// in for the arm64 one that was asked for.
//
// Exported so the whole mapping is pinnable on any host: an x64 machine cannot
// otherwise exercise the arm64 or i686 rows.
export function windowsTargetTriple(architecture: string): string {
  if (architecture === '32') return 'i686-pc-windows-msvc';
  if (architecture === 'arm64') return 'aarch64-pc-windows-msvc';
  return 'x86_64-pc-windows-msvc';
}

// The vendor/<pkg>/lib/<key> directory a NON-Windows host links against.
//
// macOS arm64 is the only non-Windows host with a prebuilt tree (vendor/*/lib/
// holds macos-arm64, windows-x64, windows-x86 and wasm). Until now air-app.ts
// spelled this as a bare `'macos-arm64'` fallback, which meant EVERY non-Windows
// host -- Linux, and an Intel Mac -- was handed an ARM64 archive set plus Cocoa/
// Metal frameworks. That does not fail early and it does not say why: it is a
// silent wrong answer that only surfaces at link time, which is exactly the
// class of failure §1.5 forbids. Returning '' means "this host has no tree",
// and the caller has to say so instead of guessing one.
//
// Exported (and parameterised) so both rows are pinnable from any machine: a
// darwin/arm64 box cannot otherwise exercise the Linux row.
export function nonWindowsVendorKey(platform: string, hostArch: string): string {
  return platform === 'darwin' && hostArch === 'arm64' ? 'macos-arm64' : '';
}

// ---------------------------------------------------------------------------
// Host templates in build manifests (阶段二百二十七)
//
// A manifest used to be able to describe exactly ONE host: every
// `examples/*.build.json` spelled `../vendor/skia/lib/macos-arm64`, listed
// `png`/`jpeg`/`webp` under the names macOS archives them as, and asked for
// CoreFoundation/Cocoa frameworks. On Windows the same file therefore died at
// `#include <zlib.h>` (no curl include tree in the -I list), and the ones that got
// past that handed lld-link `-framework CoreAudio` ("could not open 'CoreAudio'").
// The manifests were not wrong, they were mac-only -- and 15 examples' worth of
// build coverage did not exist on any other host.
//
// The fix is a deliberately tiny template vocabulary rather than one manifest per
// host: `targets.<name>` cannot express this, because it layers by TARGET and
// macOS/Windows are both `native`.
//
//   ${host}       the vendor platform key for THIS build
//                 (macos-arm64 | windows-x64 | windows-x86 | wasm)
//   ${lib:NAME}   `libNAME` on Windows, `NAME` elsewhere -- the four Skia
//                 third-party targets (png/jpeg/webp/webp_sse41) are literally
//                 named `lib*` in Skia's BUILD.gn, so the Windows archive is
//                 libpng.lib while macOS/wasm carry libpng.a
//   ${win:TOKEN}  TOKEN on a Windows native build, the ENTRY IS DROPPED elsewhere
//   ${mac:TOKEN}  TOKEN on a macOS native build, the ENTRY IS DROPPED elsewhere
//
// `${win:}`/`${mac:}` must be the whole entry: "drop part of a string" has no
// meaning, and expanding to "" instead would produce a plausible-but-wrong
// spelling (`vendor/skia/lib/${host}` with an empty host is a real, wrong
// directory rather than a visible mistake). For the same reason ${host} on a host
// with no vendor tree is a hard error, never an empty expansion.
//
// `frameworks` deliberately gets NO placeholder: it is emitted only for a darwin
// native link (see buildCompileCommand), since `-framework` is an Apple-linker
// concept. A shared manifest can therefore list Cocoa/Metal unconditionally.
// ---------------------------------------------------------------------------

// The vendor platform key for a build described by (target, architecture). ''
// means "this build has no prebuilt tree", which a `${host}` template must report
// rather than paper over.
//
// Exported and fully parameterised so every row is pinnable from any machine: a
// windows/x64 box cannot otherwise exercise the macos-arm64 or windows-x86 row.
export function hostVendorKey(target: Target, platform: string, hostArch: string, architecture: string): string {
  if (target === 'wasm') return 'wasm';
  if (platform === 'win32') {
    // No Windows ARM64 archive set exists (air-app.ts refuses that combination
    // for the same reason), so a manifest that asks for one has to say so itself.
    if (architecture === 'arm64') return '';
    if (architecture === '32') return 'windows-x86';
    if (architecture === '64') return 'windows-x64';
    return hostArch === 'ia32' ? 'windows-x86' : 'windows-x64';
  }
  return nonWindowsVendorKey(platform, hostArch);
}

// Windows zlib: 生成的 C 无条件 `#include <zlib.h>` 并链接 z（ByteArray 的
// compress/uncompress 后端，在 RUNTIME_PREAMBLE 里）。macOS/Linux 走系统 zlib
// （posixLinkLibs 的 -lz + SDK 的 <zlib.h>）；Windows 没有系统 zlib，头文件与
// 库都只能从 vendor/curl 的静态树取——curl 依赖栈构建的是 unprefixed 的 z.lib
// + curl/include/zlib.h，而 Skia 自带的 bundled zlib 是 Chromium 的 prefixed
// fork（_Cr_z_compress 等），不暴露生成的 C 调用的那些名字（见 air-app.ts::
// airManifest 的 zlib 块）。这是每个 Windows native 构建的 runtime 依赖，不是
// manifest 可选项；--air-app 的 manifest 已在 linkLibs 列 z（去重跳过），无
// manifest 的直接编译（--package exe/raw、--run）此前漏了，在 `#include
// <zlib.h>` 处报 fatal error——CI windows-exe smoke 的真因。
export function windowsZlibArgs(cfg: BuildConfig): string[] {
  if (process.platform !== 'win32' || cfg.target !== 'native') return [];
  if (cfg.linkLibs.includes('z')) return [];
  const vendor = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
  const libDir = hostVendorKey('native', 'win32', process.arch, cfg.architecture);
  return [
    '-I', resolve(vendor, 'curl', 'include'),
    '-L', resolve(vendor, 'curl', 'lib', libDir),
    '-l', 'z',
  ];
}

interface HostTemplate {
  key: string;
  win: boolean;
  mac: boolean;
}

function hostTemplate(target: Target, architecture: string): HostTemplate {
  const native = target === 'native';
  return {
    key: hostVendorKey(target, process.platform, process.arch, architecture),
    win: native && process.platform === 'win32',
    mac: native && process.platform === 'darwin',
  };
}

// Read one `${name}` / `${name:arg}` starting at `s[i]`. Nesting is honoured so
// `${win:../vendor/curl/lib/${host}}` keeps its inner placeholder for the second
// pass instead of ending the token at the first `}`.
function readTemplateAt(s: string, i: number): { name: string; arg: string | null; end: number } | null {
  if (s[i] !== '$' || s[i + 1] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '$' && s[j + 1] === '{') { depth++; j++; continue; }
    if (s[j] === '}') {
      depth--;
      if (depth === 0) {
        const body = s.slice(i + 2, j);
        const colon = body.indexOf(':');
        return colon < 0
          ? { name: body, arg: null, end: j + 1 }
          : { name: body.slice(0, colon), arg: body.slice(colon + 1), end: j + 1 };
      }
    }
  }
  return null;
}

const TEMPLATE_NAMES = ['host', 'lib', 'win', 'mac'];

function expandTemplateToken(
  t: { name: string; arg: string | null },
  ht: HostTemplate,
  manifestPath: string,
  whole: string,
): string {
  switch (t.name) {
    case 'host':
      if (t.arg !== null) {
        throw new Error(`build manifest: \${host} takes no argument (got "${whole}") — ${manifestPath}`);
      }
      if (ht.key === '') {
        throw new Error(
          `build manifest: \${host} has no prebuilt vendor tree for this build ` +
          `(${process.platform}/${process.arch}` +
          `${process.platform === 'win32' ? ', architecture "arm64" has no Windows archive set' : ''}) — ${manifestPath}`);
      }
      return ht.key;
    case 'lib':
      if (t.arg === null || t.arg === '') {
        throw new Error(`build manifest: \${lib:...} needs a library name — ${manifestPath}`);
      }
      return ht.win ? `lib${t.arg}` : t.arg;
    case 'win':
    case 'mac':
      // Only reachable when the conditional is not the whole entry; the whole-entry
      // form is consumed by expandTemplateEntry before this runs.
      throw new Error(
        `build manifest: \${${t.name}:...} must be a whole entry, not part of "${whole}" — ${manifestPath}`);
    default:
      throw new Error(
        `build manifest: unknown template placeholder \${${t.name}...} in "${whole}" ` +
        `(supported: ${TEMPLATE_NAMES.map((n) => `\${${n}}`).join(', ')}) — ${manifestPath}`);
  }
}

function expandTemplateText(s: string, ht: HostTemplate, manifestPath: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      const t = readTemplateAt(s, i);
      if (t === null) {
        throw new Error(`build manifest: unterminated template placeholder in "${s.slice(i)}" — ${manifestPath}`);
      }
      out += expandTemplateToken(t, ht, manifestPath, s);
      i = t.end;
      continue;
    }
    out += s[i++];
  }
  return out;
}

// One manifest entry -> zero (dropped conditional) or one fully expanded string.
function expandTemplateEntry(raw: string, ht: HostTemplate, manifestPath: string): string | null {
  const whole = readTemplateAt(raw, 0);
  if (whole !== null && whole.end === raw.length && (whole.name === 'win' || whole.name === 'mac')) {
    const keep = whole.name === 'win' ? ht.win : ht.mac;
    if (!keep) return null;
    if (whole.arg === null || whole.arg === '') {
      throw new Error(`build manifest: \${${whole.name}:...} needs a value — ${manifestPath}`);
    }
    // The token's own argument may carry further placeholders (for example
    // `${win:../vendor/curl/lib/${host}}`), so it still takes the inline pass.
    return expandTemplateText(whole.arg, ht, manifestPath);
  }
  return expandTemplateText(raw, ht, manifestPath);
}

function expandTemplateList(list: readonly string[], ht: HostTemplate, manifestPath: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = expandTemplateEntry(raw, ht, manifestPath);
    if (v !== null) out.push(v);
  }
  return out;
}

// Extra flags every native step (C compile, C++ compile, link) needs on Windows
// so all three drivers agree on the same ABI; empty elsewhere and for non-AIR
// builds (architecture === ''), which keep clang's host default.
function nativeTargetFlags(cfg: BuildConfig): string[] {
  if (process.platform !== 'win32' || cfg.target !== 'native') return [];
  if (cfg.architecture !== '32' && cfg.architecture !== '64' && cfg.architecture !== 'arm64') return [];
  // Static CRT (/MT). The archives vendor/provision/windows.ps1 ships are all /MT
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

// Skia's SkParagraph/SkUnicode (text shaping) needs an ICU data file at runtime.
// On Windows the native build is a static exe with no DLL directory to fall back
// to, so the data has to sit beside the executable. Without it the first
// text-shaping call crashes with SIGILL: SkParagraph::Cluster::Cluster reads an
// out-of-bounds index into the empty grapheme-property table and SK_ABORT()s to a
// `ud2` trap (measured: 0xC000001D, with `SkIcuLoader: no ICU data in <dir>` on
// stderr). `vendor/provision/windows.ps1` already copies the data next to the skia
// .lib; here we mirror it next to the freshly linked exe (the loader probes the exe
// and library directories, so shipping it beside the .lib is not enough).
//
// Several builds CAN share one output directory (`node test.ts` links every Skia
// example into the same temp/regress-out/ under a 6-wide pool), so this copy is
// not exclusive: on Windows a plain CopyFile onto a destination another process
// has open fails with `UNKNOWN: unknown error, copyfile ...` — and a running Skia
// example *is* holding that file open to read it. Hence: compare first (the
// overwhelmingly common case is "already deployed", costing one stat), and write
// through a pid-suffixed temp name so a half-written file is never observable.
//
// THE FILE NAME IS OURS: `aot-icudtl.dat`, not `icudtl.dat`. `icudtl.dat` beside
// the exe is a shared name — any Chromium-based runtime the program stages there
// (a browser control's CEF, whose renderer subprocess maps that very path for its
// own, older ICU) reads it too, and one file cannot serve two ICU generations.
// Measured on this host against CEF 3.2987:
//
//   * Skia's ICU 69 data under the shared name -> every CEF renderer subprocess
//     aborts ~250 ms after start (libcef+0x404d7c, FATAL "unreachable code",
//     raised by a failed `NumberFormat::createInstance`), web view blank forever;
//   * CEF's ICU 5x data under the shared name -> CEF renders, but OUR text loses
//     glyph runs (the app's FPS overlay drew its first line and dropped the rest).
//
// Both symptoms are silent at build time, which is why the two data sets must not
// share a path at all. vendor/skia_text_glue.cc defines SkLoadICU() itself and
// reads `aot-icudtl.dat` (falling back to `icudtl.dat` for trees built before this
// change), so nothing is ever overwritten in either direction.
export type IcuDeployment =
  | 'deployed' // copied Skia's data set beside the exe, under our own name
  | 'up-to-date' // the file there already is ours, byte for byte
  | 'absent'; // not a Windows native Skia build, or no data set to copy

// The name our loader reads first (vendor/skia_text_glue.cc::SkLoadICU). Nothing
// else on the platform uses it, which is the entire point: the shared `icudtl.dat`
// stays available for another runtime staged beside the same exe.
export const ICU_DATA_NAME = 'aot-icudtl.dat';

// Bytes of UDataInfo that identify "an ICU common data package of our data format".
// Only used for the cheap "already deployed" test: Skia's ICU 69 package and a
// Chromium ICU 5x package agree on all 16 (measured: 9000da27 14000000 00000200
// 436d6e44), so the header can never stand in for a real comparison.
const ICU_HEADER_PROBE = 16;

function readHead(path: string, n: number): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(n);
      const got = readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Same size AND same leading bytes: the cheap "we already deployed this" test.
function sameIcuBytes(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
  } catch {
    return false;
  }
  const ha = readHead(a, ICU_HEADER_PROBE);
  const hb = readHead(b, ICU_HEADER_PROBE);
  return ha !== null && hb !== null && ha.equals(hb);
}

export function deploySkiaIcuData(cfg: BuildConfig, outPath: string): IcuDeployment {
  if (process.platform !== 'win32' || cfg.target !== 'native') return 'absent';
  if (cfg.architecture !== '32' && cfg.architecture !== '64' && cfg.architecture !== 'arm64') return 'absent';
  if (!cfg.linkLibs.includes('skia')) return 'absent';
  const dst = join(dirname(resolve(outPath)), ICU_DATA_NAME);
  for (const p of cfg.linkPaths) {
    const src = join(p, 'icudtl.dat');
    if (!existsSync(src)) continue;
    if (existsSync(dst) && sameIcuBytes(src, dst)) return 'up-to-date';
    copyIcuData(src, dst);
    return 'deployed';
  }
  return 'absent';
}

// Same bytes, or "built from the same vendor tree": size + not-older-than-source
// is enough for a data file that only changes when ICU is upgraded. Only the
// lost-the-race path below needs it -- deploySkiaIcuData has already decided that a
// copy is wanted before calling copyIcuData.
function icuDataUpToDate(src: string, dst: string): boolean {
  try {
    const a = statSync(src);
    const b = statSync(dst);
    return a.size === b.size && b.mtimeMs >= a.mtimeMs;
  } catch {
    return false;
  }
}

function copyIcuData(src: string, dst: string): void {
  const tmp = `${dst}.${process.pid}.tmp`;
  copyFileSync(src, tmp);
  try {
    renameSync(tmp, dst);
  } catch (e) {
    rmSync(tmp, { force: true });
    // Lost the race against a process that loaded the file between our stat and
    // our rename. If the destination ended up with the right bytes anyway, the
    // build's requirement ("our ICU data beside the exe") is met, so this is not an
    // error; a genuinely different file must still fail loudly.
    if (!icuDataUpToDate(src, dst)) throw e;
  }
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
    args.push(
      ...nativeTargetFlags(cfg),
      cfg.opt,
      ...perfFlags(cfg),
      ...fpFlags(cfg),
      ...debugInfoFlags(cfg),
      ...linkTrimFlags(cfg),
      ...exportDynamicFlags(cfg),
      ...windowsLinkFlags(cfg)
    );
    for (const l of posixLinkLibs()) args.push(l);
    for (const l of platformLinkLibs()) args.push('-l', l);
    args.push('-o', outPath);
  }

  args.push(cPath);
  for (const s of cfg.sources) args.push(s);
  for (const p of cfg.includePaths) args.push('-I', p);
  for (const d of effectiveDefines(cfg)) args.push('-D', d);
  // User flags go after the curated ones and before the sources/objects/libs, so
  // a `-Wl,…` here still precedes the archives it refers to; a duplicate flag is
  // the compiler's to resolve (last one wins for clang).
  for (const f of cfg.cFlags) args.push(f);
  for (const o of cfg.objects) args.push(o);
  for (const p of cfg.linkPaths) args.push('-L', p);
  args.push(...windowsZlibArgs(cfg));
  for (const l of cfg.linkLibs) args.push('-l', l);
  args.push(...frameworkFlags(cfg));
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
// link, so this list is deliberately empty for wasm/web. Windows has no <iconv.h> in
// the CRT and no libiconv in vendor/, so it takes no flag for THAT -- see AS_HAVE_ICONV
// in runtime.ts, which is what makes the Windows build report the unsupported charsets
// loudly instead of mis-encoding. Windows is not empty outright, though: shell32 is
// the import library its runtime arm resolves SHFileOperationW through (the Recycle
// Bin behind File.moveToTrash) and ShellExecuteA (as_open_external, i.e.
// navigateToURL). Without it the MSVC target's linker rejects both symbols, which is
// how urlstream-api.as failed with "undefined symbol: ShellExecuteA" until now.
export function platformLinkLibs(): string[] {
  if (process.platform === 'win32') return ['shell32'];
  if (process.platform !== 'darwin') return [];
  return ['iconv'];
}

// macOS frameworks the RUNTIME platform layer itself needs, as opposed to the
// ones a manifest asks for (Skia's CoreText/CoreGraphics, SDL2's Cocoa, ...).
// CoreFoundation is what Capabilities.language/languages read the system locale
// through: the generated C cannot include the Apple headers (MacTypes.h defines
// `struct Point`, which is what flash.geom.Point compiles to — see the CF block in
// runtime.ts), so the handful of CF entry points are declared by hand there and
// resolved here. Like -liconv above this is an OS-provided detail rather than a
// third-party dependency, so it is added for every darwin native link instead of
// being opt-in: a build that omitted it would fail to link, and one that silently
// fell back to LANG would report the wrong language (AGENTS 1.5).
export function platformFrameworks(cfg: BuildConfig): string[] {
  if (process.platform !== 'darwin' || cfg.target !== 'native') return [];
  return ['CoreFoundation'].filter((f) => !cfg.frameworks.includes(f));
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

// ---- Per-config object paths (阶段二百二十三) --------------------------------
//
// An object file is linked WHOLE (阶段二百二十一), and its CONTENTS depend on the
// flags it was compiled with -- so "one path per source name" is only correct
// while every build agrees on those flags, and they do not agree. The example
// suite compiles vendor/window_glue.cc from `examples/swc-bitmap.build.json`
// (ASC_USE_WINDOW, no GPU backend) and from the away3d / air-native manifests
// (+ASC_RENDER_METAL) *concurrently* (test/examples.ts, jobs=min(cores,6)), and
// both wrote vendor/window_glue.o. Measured: those two define sets produce
// 29,216 vs 30,896 byte objects, so whichever build finished last silently
// decided what the other one linked -- either handing it a channel its manifest
// never asked for, or (as when relinking leftover objects by hand) failing with
// `Undefined symbols: _sk_window_show_gpu`.
//
// A leftover object is the same defect one build later, and stage 89-32 fixed
// one face of it already (native `.o` vs web `.wasm.o`, because the two targets
// clobbered each other). This is the general form of that fix: objects live in
// one directory per CONFIG, named by a hash of everything that can change their
// bytes (compiler, target, -O, perf/fp/debug flags, defines, include paths --
// NOT sorted, because -I order changes which header wins), plus a hash of the
// source path so two same-named sources cannot collide.
//
// Nothing is cached: every source is still recompiled on every build, exactly as
// before. This changes where the output lands, never how often it is produced,
// so it costs no time -- it only stops one build from answering for another.
// The ICU data object is deliberately NOT part of this: its bytes are the same
// for every config, so sharing it (mtime-cached, next to the vendored .dat) is
// correct.
function objectConfigKey(cfg: BuildConfig): string {
  const parts: string[] = [
    `target=${cfg.target}`,
    `cc=${cfg.cCompiler}`,
    `opt=${cfg.opt}`,
    `dbg=${cfg.debugInfo ? '1' : '0'}`,
    ...nativeTargetFlags(cfg),
    ...perfFlags(cfg),
    ...fpFlags(cfg),
    ...effectiveDefines(cfg).map((d) => `-D${d}`),
    ...cfg.includePaths.map((p) => `-I${p}`),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

// The directory holding the objects of ONE build. Under the OS temp dir on
// purpose: these are pure intermediates, and a compiler should not drop a `temp/`
// tree into whatever project it was pointed at. `--dry` prints the real paths (so
// they stay discoverable) but creates nothing.
//
// The PID is load-bearing, not decoration: objects must be private to the process
// that compiles them. `cc -o` writes in place (truncate, then write), so two builds
// sharing a path let a concurrent link read a truncated file -- not theory, it cost a
// real failure: the example suite runs six text builds at once, and one of them died
// with `ld: file is empty in .../icudtl_flutter.o`. "The bytes are identical anyway"
// is exactly what made a shared path look safe; identical content does not make a
// non-atomic overwrite safe, only a private path does. The config hash stays in the
// name so a mid-build `ld` line (or `--dry`) still says which configuration wrote it.
export function objectDir(cfg: BuildConfig): string {
  return join(tmpdir(), 'as-aot-obj', `${objectConfigKey(cfg)}-${process.pid}`);
}

// Drop one build's scratch once it has linked: the objects are intermediates, and
// they are the biggest thing this compiler writes (~3 MB for a text example). Called
// on success only -- a FAILED build deliberately keeps its objects, because that is
// the state a post-mortem wants.
export function cleanObjectScratch(cfg: BuildConfig): void {
  rmSync(objectDir(cfg), { recursive: true, force: true });
}

// The object for one source inside that config's directory.
function objectPathFor(cfg: BuildConfig, src: string, suffix: string): string {
  const tag = createHash('sha256').update(src).digest('hex').slice(0, 12);
  return join(objectDir(cfg), `${tag}-${basename(src).replace(/\.[^.]+$/, '')}${suffix}`);
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
  // Per-config objects (see objectPathFor): the stage-89-32 target suffix is kept
  // on top of that as a second, human-readable guard, since the config key
  // already separates the targets. The scratch directory is created by runCompile.
  const objOf = (src: string): string => objectPathFor(cfg, src, '.o');
  const compileCommon: string[] = [...nativeTargetFlags(cfg), cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg)];
  for (const d of effectiveDefines(cfg)) compileCommon.push('-D', d);
  for (const p of cfg.includePaths) compileCommon.push('-I', p);
  for (const f of cfg.cFlags) compileCommon.push(f);

  const steps: string[][] = [];
  // 0) ICU data blob (text builds only): assemble the vendored 0.80 MB data set
  //    into the object that defines _icudtNN_dat (see icuDataPaths). Assembling
  //    needs no -I/-D and takes ~0.2 s; it is an object like any other, so it lives
  //    in this build's own scratch and never in a path another build writes. The
  //    source itself is materialised by the runner, not here (this stays pure).
  const icuData = icuDataPaths(cfg);
  if (icuData) {
    steps.push([cfg.cCompiler, '-c', ...nativeTargetFlags(cfg), icuData.source, '-o', icuData.object]);
  }
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
  const linkArgs: string[] = [
    cxx,
    ...nativeTargetFlags(cfg),
    cfg.opt,
    ...perfFlags(cfg),
    ...fpFlags(cfg),
    ...debugInfoFlags(cfg),
    ...linkTrimFlags(cfg),
    ...exportDynamicFlags(cfg),
    ...windowsLinkFlags(cfg),
    '-o',
    outPath,
  ];
  for (const f of cfg.cFlags) linkArgs.push(f);
  for (const f of cFiles) linkArgs.push(objOf(f));
  for (const f of cppFiles) linkArgs.push(objOf(f));
  // Before the -l flags: this is what keeps the archives' 10.19 MB ICU data
  // member unreadable-by-necessity rather than merely unread.
  if (icuData) linkArgs.push(icuData.object);
  for (const o of cfg.objects) linkArgs.push(o);
  for (const p of cfg.linkPaths) linkArgs.push('-L', p);
  for (const l of cfg.linkLibs) linkArgs.push('-l', l);
  linkArgs.push(...posixLinkLibs());
  for (const l of platformLinkLibs()) linkArgs.push('-l', l);
  linkArgs.push(...frameworkFlags(cfg));
  steps.push(linkArgs);

  return steps;
}

// macOS frameworks on the link line — the manifest's own list plus the ones the
// runtime platform layer needs (see platformFrameworks).
//
// `-framework` is an Apple-linker spelling: GNU ld has no such switch and lld-link
// does not even fail on it — it treats the FRAMEWORK NAME as an input file, so a
// shared manifest that lists Cocoa produced `lld-link: error: could not open
// 'Cocoa'`, a message naming the wrong problem entirely. Gated HERE rather than in
// the manifests so that one `frameworks` list can honestly describe the Apple
// build and be inert on every other host (this is the third of the three fields
// that stopped a single manifest from describing macOS and Windows at once -- the
// other two are the vendor platform key and the Skia archive names, see the host
// template block above).
//
// Shared by both link builders (buildCompileCommand for the C-only path and
// buildCompileSteps for the C++ one) so the two cannot drift apart.
function frameworkFlags(cfg: BuildConfig): string[] {
  if (process.platform !== 'darwin' || cfg.target !== 'native') return [];
  const out: string[] = [];
  for (const f of cfg.frameworks) out.push('-framework', f);
  for (const f of platformFrameworks(cfg)) out.push('-framework', f);
  return out;
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

// Create the directory a compiler invocation writes into. The output directory belongs
// to the RUNNER, not to the command builder: composing a command line must not touch the
// filesystem (that is what made `--dry` need a special case, and what left scratch
// directories behind from purely structural checks). Exported so a caller that drives the
// compiler itself reaches the same place production does.
export function ensureOutDir(argv: string[]): void {
  const outAt = argv.indexOf('-o');
  if (outAt >= 0 && argv[outAt + 1]) mkdirSync(dirname(argv[outAt + 1]), { recursive: true });
}

// A batch file cannot be handed to CreateProcess: Node surfaces EINVAL and
// nothing runs. The Emscripten SDK's Windows entry point is exactly that
// (`emcc.bat`), so those are launched THROUGH cmd.exe — the same thing a user's
// shell does, and the only way to run them without reimplementing the driver.
//
// `/d` skips AutoRun, `/s` makes cmd strip the single outer quote pair we add,
// and `windowsVerbatimArguments` stops Node from re-quoting a command line whose
// arguments already carry their own quotes (double quoting breaks paths with
// spaces). Known limit shared with the SDK's own .bat: cmd expands `%NAME%`
// inside an argument. Compiler flags and file paths contain no `%`.
function isBatchFile(p: string): boolean {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(p);
}

function winQuoteArg(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? '"' + a.split('"').join('\\"') + '"' : a;
}

// The single place a toolchain program is spawned. Everything else (native cc,
// wasi clang, adl probes) goes through here too, so the Windows batch-file
// handling lives in one branch rather than at each call site.
function spawnTool(argv: string[], env: NodeJS.ProcessEnv | Record<string, string> | undefined) {
  if (!isBatchFile(argv[0])) return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env });
  const line = argv.map(winQuoteArg).join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], {
    encoding: 'utf8',
    env,
    windowsVerbatimArguments: true,
  });
}

// Run the compiler and propagate failure. Returns true on success. `extraEnv`
// (e.g. the Emscripten toolchain's PATH) is merged over the inherited
// environment rather than replacing it, so unrelated env vars survive.
export function runCompile(argv: string[], extraEnv?: Record<string, string>): boolean {
  ensureOutDir(argv);
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const res = spawnTool(argv, env);
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

// The SDK ships both entry points side by side: `upstream/emscripten/emcc` is a
// `#!/bin/sh` wrapper (POSIX only) and `emcc.bat` is the Windows one. The sh
// script cannot be started on Windows at all — measured on emsdk 3.1.44:
// spawnSync(emcc) => ENOENT, spawnSync(emcc.bat) => EINVAL, spawnSync(emcc.py)
// => EFTYPE, while `cmd /c emcc.bat --version` prints `emcc 3.1.44`. Asking for
// the POSIX name there used to fail with "emcc not found", pointing the reader at
// the path instead of at the missing shell.
export function emccPath(): string {
  const home = emsdkHome();
  const exe = process.platform === 'win32' ? 'emcc.bat' : 'emcc';
  return home ? join(home, 'upstream', 'emscripten', exe) : exe;
}

// emcc.bat runs `%EMSDK_PYTHON%` and falls back to a bare `python` lookup —
// which on Windows often resolves to the Microsoft Store stub rather than an
// interpreter. Point it at the SDK's own bundled python when there is exactly
// one (emsdk installs one per version, so that is the normal case); an ambiguous
// layout is left to the SDK's own default instead of guessed at.
function emsdkPython(home: string): string | null {
  const dir = join(home, 'python');
  try {
    const found = readdirSync(dir).filter((v) => existsSync(join(dir, v, 'python.exe')));
    return found.length === 1 ? join(dir, found[0], 'python.exe') : null;
  } catch {
    return null;
  }
}

// emcc is a Python driver that shells out to clang/node; those live in the
// emsdk's bin dir, so prepend it (and the emscripten dir) to PATH for the child
// process. Returns undefined when no SDK is configured (then emcc must already
// be on PATH).
//
// Two Windows-specific corrections, both measured:
//   1. PATH is joined with `path.delimiter`. A ':'-joined PATH is ONE unparsable
//      entry on Windows (the drive colon splits it), so every emcc child ran with
//      no usable PATH.
//   2. The inherited environment is KEPT. Handing over `{ PATH }` alone dropped
//      SystemRoot (cmd.exe needs it to start) and USERPROFILE (emcc's cache lives
//      in ~/.emscripten_cache), so even a correctly launched driver would fail.
//      Any pre-existing PATH spelling is dropped first: Windows env names are
//      case-insensitive but a JS object is not, and two PATH keys in one block is
//      undefined behaviour.
function webCompileEnv(): Record<string, string> | undefined {
  const home = emsdkHome();
  if (!home) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^path$/i.test(key)) env[key] = value;
  }
  const emccDir = join(home, 'upstream', 'emscripten');
  const binDir = join(home, 'upstream', 'bin');
  env.PATH = [emccDir, binDir, process.env.PATH || ''].join(delimiter);
  const python = emsdkPython(home);
  if (python) env.EMSDK_PYTHON = python;
  const config = join(home, '.emscripten');
  if (existsSync(config)) env.EM_CONFIG = config;
  return env;
}

// Probe whether the Emscripten toolchain is usable: emcc must exist and be able
// to run its version check (which fails without a working node/python driver).
export function webToolchainError(): string | null {
  const cc = emccPath();
  // An absolute program that is not there needs no spawn to diagnose. On Windows
  // emcc is a batch file, so cmd.exe reports a missing path as the generic "The
  // system cannot find the path specified." with a nonzero exit, which used to be
  // read as "emcc not usable" -- i.e. as if the SDK were present but broken.
  if (isAbsolute(cc) && !existsSync(cc)) return `emcc not found: ${cc}`;
  const res = spawnTool([cc, '--version'], webCompileEnv());
  if (res.error) {
    // Two different situations used to share one sentence. "not found" sends the
    // reader to the path; "present but could not be launched" is a permissions
    // problem or, on Windows, the POSIX wrapper (ENOENT/EINVAL/EFTYPE).
    const code = (res.error as NodeJS.ErrnoException).code || 'unknown';
    if (code === 'ENOENT') return `emcc not found: ${cc}`;
    return `emcc could not be launched (${code}): ${cc}`;
  }
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
  //
  // 阶段二百二十三 moved both sets into a per-config directory (objectPathFor),
  // which already separates the targets by the config key; the suffix is kept as
  // a readable second guard, not as the mechanism.
  const objSuffix = cfg.target === 'wasm' ? '.wasm.o' : '.o';
  const objOf = (src: string): string => objectPathFor(cfg, src, objSuffix);

  const compileCommon: string[] = [cfg.opt, ...perfFlags(cfg), ...fpFlags(cfg), ...debugInfoFlags(cfg)];
  for (const d of effectiveDefines(cfg)) compileCommon.push('-D', d);
  for (const p of cfg.includePaths) compileCommon.push('-I', p);
  for (const f of cfg.cFlags) compileCommon.push(f);
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
  for (const f of cfg.cFlags) linkArgs.push(f);
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
