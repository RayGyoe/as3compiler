#!/usr/bin/env node
// as-aot — a minimal ActionScript 3 subset compiler.
// Pipeline: AS source -> tokenize -> parse -> generate C -> clang -> native
// executable (or WASI .wasm with --target wasm).

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parser.ts';
import { generateC, type ExportedSymbol } from './codegen.ts';
import { aneHostDirName, anePlatformForBuild, anePlatformHint, resolveAneDescriptors, stageAneNatives, type AneResolution } from './ane.ts';
import { AS3_GAPS, collectScriptVars } from './emit.ts';
import { ctypeToString, qualifiedName } from './symbols.ts';
import type { Program, Stmt } from './ast.ts';
import { defaultBuildConfig, loadManifest, applyManifest, applyManifestOverlay, buildCompileSteps, runCompile, buildWebCompileSteps, webCompileStepsEnv, featureMacros, validateFeatures, knownFeatures, deploySkiaIcuData, type BuildConfig } from './build.ts';
import { checkFailure, requireCheck, type CheckCtx } from './checks.ts';
import type { BuildConfig, Target, Package, Manifest } from './build.ts';
import { generateBootstrap, prepareAirApp, airManifest } from './air-app.ts';
import { runDoctor, checkForUpdate } from './doctor.ts';
import { computeReachable, prepareReachFiles, type ReachFile } from './reach.ts';
import { generateXcodeProject } from './xcode-project.ts';
import {
  extractSwc,
  swcCompileInputs,
  swcBakePlan,
  type SwcResourceSpec,
  type SwcLibrary,
  type SwcCharacterClass,
  type SwcBake,
} from './swc.ts';
import { embedCompileInputs, type EmbedResourceSpec } from './embed.ts';

// The compiler's own version, read from package.json rather than duplicated as a
// constant: `version` is bumped in that one file once per stage (§2.7), and a
// second copy in the sources would drift from it silently. Both entry points sit
// one level below the package root -- src/index.ts and the published
// dist/index.js -- so the same relative URL resolves from either, and npm always
// ships package.json no matter what `files` says.
function compilerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    // A dist/index.js copied out of the package by hand has no package.json above
    // it. Reporting the version is the last thing that should take down the
    // compiler, so this degrades to a visible "(unknown)" instead of throwing.
    return '';
  }
}

// One line and no colour: `as-aot --version` is pasted into bug reports and read
// by scripts (`as-aot --version | awk '{print $NF}'`). The name is the package
// name, because that is what identifies a release to the registry.
function versionLine(): string {
  const v = compilerVersion();
  return `as3compiler ${v === '' ? '(unknown)' : v}`;
}

// The registry `npm_config_registry` names is the one this machine's npm would
// install from, so a corporate mirror (or an offline default in .npmrc) is
// honoured instead of us hard-coding npmjs in the source.
function registryBase(): string {
  return (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
}

interface Options {
  inputs: string[];
  output: string | null;
  run: boolean;
  manifest: string | null;
  airApp: string | null;
  mainClass: string | null;
  // `--all-sources`: compile every .as under src/ instead of the main class's
  // reachable closure (see reach.ts). The pre-阶段一百二十四 behaviour, kept as an
  // escape hatch for a project whose references the source-level walker cannot
  // see.
  allSources: boolean;
  // `--include-third-party`: --air-app only. Sweep the reverse-DNS source dirs
  // (com/org/net) the demo-oriented default skips, so a real app's own `com.*`
  // framework layer joins the reachability closure.
  includeThirdParty: boolean;
  // `--extdir <dir>`: --air-app only, repeatable. Where to look for the packages
  // the descriptor's <extensions> names, overriding air-app's DEFAULT_EXT_DIRS.
  // Not part of BuildConfig: it is consumed while the manifest is generated (the
  // descriptor names extensions by ID, and the IDs are resolved into the manifest's
  // `ane-paths`), not while the build runs.
  extDirs: string[];
  overrides: Partial<BuildConfig>;
  // `as-aot doctor` (below). The subcommand is recognised by its own name as the
  // FIRST argument, before the flag loop, because otherwise `doctor` would be
  // taken for an input file (every non-dash argument is one) and the run would
  // fail trying to read a file called "doctor".
  doctor: boolean;
  doctorJson: boolean;
  doctorFix: boolean;
  doctorVerbose: boolean;
  // `doctor --check-update`: ask the registry whether a newer release is out.
  // Read-only and opt-in (see doctor.ts); it rides along in Options like the
  // other doctor switches.
  doctorCheckUpdate: boolean;
}

// Every flag the parser accepts, in one list. Two things need to know what a
// flag IS -- the "did you mean" suggestion for an unknown one, and the check
// that a value-taking flag really got its value -- and a second hand-kept copy
// would drift from the parser's if/else chain the first time a flag is added
// (the `unit: cli/ArgErrors` group reads the chain and reddens if it does).
const KNOWN_FLAGS: readonly string[] = [
  '-o', '--run', '--dry', '--cc', '--target', '--package', '--manifest', '--air-app',
  '--main-class', '--all-sources', '--include-third-party', '--extdir', '--json', '--fix',
  '--check-update', '--verbose', '-v', '--opt', '--debug-info', '--lto', '--pgo', '--pgo-dir',
  '-I', '-L', '-l', '-D', '--features', '--framework', '--source', '--swc', '--ane',
  '--ane-platform', '--export', '--version', '-V', '--help', '-h',
];

// Plain Levenshtein, two rows of state (no dependency, no per-cell allocation).
function editDistance(a: string, b: string): number {
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

// The nearest known flag, or '' when nothing is close enough to be worth
// guessing. Two shapes are worth guessing at, and both happen: a misspelling of
// a long flag (`--versoin`), and a long flag typed short (`--feat`).
//
// Short flags are excluded on purpose: `-x` is one edit from EVERY other
// single-letter flag, so any guess there is noise rather than help -- a wrong
// "did you mean" costs more than no guess at all.
// Short flags need no separate rule: a two-character name admits only a
// zero-edit match, so the ratio below already keeps `-x` from being answered
// with a confident guess at `-I`.
function suggestFlag(arg: string): string {
  let best = '';
  let bestDist = 3; // 0..2; three edits away is a different word, not a slip
  for (const f of KNOWN_FLAGS) {
    const d = editDistance(arg, f);
    // ...and close RELATIVE to the name's own length, because an absolute
    // threshold lies about short names: `--sss` is two edits from `--swc`,
    // which is nothing like a typo of it, while `-x` is one edit from EVERY
    // other single-letter flag -- there a guess is a coin flip, and a confident
    // wrong guess costs more than no guess at all.
    if (d < bestDist && d * 3 <= arg.length) { bestDist = d; best = f; }
  }
  if (best !== '') return best;
  // Nothing near, but the user may simply have stopped typing: `--feat` is four
  // edits from `--features`, far enough that Levenshtein says no and a prefix
  // test says yes. Only when it is unambiguous -- two candidates means the
  // guess is a coin flip.
  const candidates = KNOWN_FLAGS.filter((f) => f.length > arg.length && f.startsWith(arg));
  return candidates.length === 1 ? candidates[0] : '';
}

function parseArgs(argv: string[], doctorMode = false): Options {
  const opts: Options = { inputs: [], output: null, run: false, manifest: null, airApp: null, mainClass: null, allSources: false, includeThirdParty: false, extDirs: [], overrides: {}, doctor: doctorMode, doctorJson: false, doctorFix: false, doctorVerbose: false, doctorCheckUpdate: false };
  const push = (key: 'includePaths' | 'linkLibs' | 'linkPaths' | 'defines' | 'features' | 'exports' | 'frameworks' | 'sources' | 'swcPaths' | 'anePaths', v: string): void => {
    (opts.overrides[key] ??= [] as string[]).push(v);
  };
  // Every value-taking flag reads its operand through here rather than inline
  // `argv[++i]`, which made two mistakes silent (阶段二百零二):
  //   * a flag at the very end of the command line -- `as-aot x.as -o` set the
  //     output to `undefined`, and the `?? default` downstream quietly built
  //     under the default name, as if -o had never been written;
  //   * a flag that ate the NEXT FLAG -- `-o --dry` named the output `--dry`,
  //     dropped the dry-run flag, and only surfaced later as clang rejecting
  //     `--dry.c`, an error with nothing to do with the user's mistake.
  // A value may legitimately start with a dash (`--opt -O3`, `-D FOO=-1`), so
  // the test is "is this operand itself a known flag", never "does it start
  // with a dash".
  let i = 0;
  const value = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) {
      throw new Error(`${flag}: expects a value, but it is the last argument (see \`as-aot --help\`)`);
    }
    if (KNOWN_FLAGS.includes(v)) {
      throw new Error(`${flag}: expects a value, but got the flag ${v} (see \`as-aot --help\`)`);
    }
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opts.output = value('-o');
    else if (a === '--run') opts.run = true;
    else if (a === '--dry') opts.overrides.dry = true;
    else if (a === '--cc') opts.overrides.cCompiler = value('--cc');
    else if (a === '--target') opts.overrides.target = value('--target') as Target;
    else if (a === '--package') opts.overrides.package = value('--package') as Package;
    else if (a === '--manifest') opts.manifest = value('--manifest');
    else if (a === '--air-app') opts.airApp = value('--air-app');
    else if (a === '--main-class') opts.mainClass = value('--main-class');
    else if (a === '--all-sources') opts.allSources = true;
    else if (a === '--include-third-party') opts.includeThirdParty = true;
    else if (a === '--extdir') opts.extDirs.push(value('--extdir'));
    else if (a === '--json') opts.doctorJson = true;
    else if (a === '--fix') opts.doctorFix = true;
    else if (a === '--check-update') opts.doctorCheckUpdate = true;
    else if (a === '--verbose' || a === '-v') opts.doctorVerbose = true;
    else if (a === '--opt') opts.overrides.opt = value('--opt');
    else if (a === '--debug-info') opts.overrides.debugInfo = true;
    else if (a === '--lto') opts.overrides.lto = true;
    else if (a === '--pgo') {
      const v = value('--pgo');
      if (v !== 'generate' && v !== 'use') {
        throw new Error(`--pgo expects 'generate' or 'use' (got '${v}')`);
      }
      opts.overrides.pgo = v;
    }
    else if (a === '--pgo-dir') opts.overrides.pgoDir = value('--pgo-dir');
    else if (a === '-I') push('includePaths', value('-I'));
    else if (a === '-L') push('linkPaths', value('-L'));
    else if (a === '-l') push('linkLibs', value('-l'));
    else if (a === '-D') push('defines', value('-D'));
    // --features <a,b>: named enhancement switches (AIR supersets, §1.5).
    // Repeatable and/or comma-separated; `none` clears. Stored raw here — the
    // `none`-vs-absent distinction is resolved in main(), because it decides
    // whether the generated manifest's persisted set is kept or wiped.
    else if (a === '--features') {
      // The list's own syntax (`svg,lottie`; `none` clears) lives in `--help`,
      // which the missing-value error points at, so it is not repeated here.
      const v = value('--features');
      for (const f of v.split(',').map((s) => s.trim()).filter((s) => s !== '')) push('features', f);
    }
    else if (a === '--framework') push('frameworks', value('--framework'));
    else if (a === '--source') push('sources', value('--source'));
    else if (a === '--swc') push('swcPaths', value('--swc'));
    else if (a === '--ane') push('anePaths', value('--ane'));
    else if (a === '--ane-platform') opts.overrides.anePlatform = value('--ane-platform');
    else if (a === '--export') push('exports', value('--export'));
    // -V, not -v: -v is doctor's --verbose and has been in the help text since
    // then, so taking it over would be a breaking change for anyone using it.
    else if (a === '--version' || a === '-V') {
      console.log(versionLine());
      process.exit(0);
    }
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (!a.startsWith('-')) {
      opts.inputs.push(a);
    } else {
      // Two shapes of mistake, two different next steps: a near miss of a known
      // flag is worth guessing at (that is the whole failure mode this exists
      // for), while a flag nothing resembles is better answered with where the
      // full list is than with a guess.
      const near = suggestFlag(a);
      throw new Error(near !== ''
        ? `unknown argument: ${a} (did you mean ${near}?)`
        : `unknown argument: ${a} (see \`as-aot --help\` for the full list)`);
    }
  }
  // Same reasoning as --extdir below: on a compile run this would look like it
  // had been honoured and quietly do nothing -- worse here, because the flag's
  // whole point is a side effect (the registry lookup) the user would expect to
  // have happened. Checked BEFORE the no-input banner, so `as-aot --check-update`
  // says what is wrong instead of printing usage.
  if (opts.doctorCheckUpdate && !opts.doctor) {
    throw new Error(`--check-update only applies to the doctor subcommand; use \`as-aot doctor --check-update\``);
  }
  if (opts.inputs.length === 0 && !opts.airApp && !opts.doctor) {
    console.error(usage());
    process.exit(1);
  }
  // --extdir names where the descriptor's <extensions> packages live, and only a
  // descriptor declares extensions. Accepting it without --air-app would look like
  // it had been honoured and quietly contribute nothing.
  if (opts.extDirs.length > 0 && !opts.airApp) {
    throw new Error(`--extdir only applies to --air-app (it locates the packages <extensions> names); use --ane <package> for an explicit extension`);
  }
  return opts;
}

function usage(): string {
  return [
    'Usage: as-aot <input.as> [more.as ...] [options]',
    '       as-aot doctor [options]        report whether this machine can build what the flags ask',
    '       as-aot version                 print the compiler version (same as --version / -V)',
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
    '  --include-third-party  --air-app: also sweep src/com, src/org, src/net (a real app\n                 keeps its own framework layer there; skipped by default)',
    '  --extdir <dir> --air-app: where the <extensions> packages live (repeatable;\n                 default: ext-aot then lib then ext-folder). Each extensionID the\n                 descriptor names is resolved to a package there, so no --ane is needed\n                 per extension',
    '  --all-sources  --air-app: compile every .as under src/ instead of the main class\n                 reachable closure (pre-阶段一百二十四 behaviour; see reach.ts)',
    '  -I <dir>       include path (repeatable)',
    '  -L <dir>       library search path (repeatable)',
    '  -l <lib>       link library (repeatable)',
    '  -D <macro>     preprocessor define (repeatable)',
  '  --features <list> enable an AIR-superset enhancement (comma-separated, repeatable;',
  '                 `none` clears). Default builds stay AIR-identical.',
  `                 known: ${knownFeatures().join(', ')} (see docs/zh-cn/enhancements.md)`,
  '  --framework <n> link a macOS framework (repeatable; distinct from clang -F, which is a search path)',
    '  --source <f>   extra C/C++ source to compile and link (repeatable)',
  '  --swc <f>      .swc library: bake bitmap resources, vector shapes and the display tree at',
  '                 compile time (repeatable; see docs/zh-cn/swc.md §5/§6/§9)',
    '  --export <name> export a C symbol into the .wasm export table (repeatable)',
    '  --ane <f>      AIR native extension: load its native library through the FRE host',
    '                 (<f> may be an .ane package or an unpacked directory: extension.xml',
    '                 beside <platform>/<nativeLibrary>)',
    '                 (repeatable; needs the host library from lib/build-asaot.bat, and an',
    '                 ANE recompiled against it — see docs/zh-cn/ane.md §4)',
    '  --ane-platform <key> override the ANE platform entry, e.g. Windows-x86-64 |',
    '                 Windows-x86 | MacOS-x86-64 | iPhone-ARM; also selects',
    '                 which host-library width under lib/bin/ is used (default: this host;',
    '                 Windows ARM64 has no AIR key: pass Windows-x86-64 + a 64-bit build)',
    '  --opt <flags>  optimization flags (default: -O2)',
    '  --debug-info   keep DWARF: add -g to every backend and stop stripping it from the',
    '                 default wasm build (default: off — artifacts carry no debug info)',
    '  --lto          add -flto to every compile step and the link step (E12)',
    '  --pgo <phase>  profile-guided optimization: generate | use (E12; pair with --pgo-dir)',
    '  --pgo-dir <d>  profile directory for --pgo (the two phases must name the same one)',
    '  --dry          emit C and print the compile command without compiling',
    '  -V, --version  print the compiler version (read from package.json) and exit',
    '  -h, --help     show this help',
    '',
    'doctor options (only with the `doctor` subcommand):',
    '  --json         machine-readable report (one JSON object on stdout)',
    '  --fix          perform the safe, instant fixes; never builds a dependency or',
    '                 installs a toolchain -- those checks print the command instead',
    '  -v, --verbose  also print the resolved repo/vendor/output directories',
    '  --check-update ask the registry `npm_config_registry` names (npmjs by default)',
    '                 whether a newer release is published, and print the upgrade',
    '                 command. Read-only: it never installs anything, and a registry',
    '                 it cannot reach is reported rather than fatal -- the exit code',
    '                 still means build-readiness and nothing else',
    '',
    'doctor judges against a real build configuration: `--manifest <f>` reads one,',
    '`--air-app <xml>` generates one (writing <filename>.build.json, the same file a',
    'build writes), and with neither it assumes the standard native desktop app.',
    'Exit codes: 0 ready, 1 a hard requirement is missing, 2 warnings only (the build',
    'would succeed but the output would be wrong).',
  ].join('\n');
}

// --features resolution. The three outcomes are deliberately distinct:
//   null → the flag was absent, so the manifest's persisted set stands (this is
//          what makes a once-chosen feature stick across --air-app runs);
//   []   → `--features none`, i.e. wipe the persisted set;
//   set  → exactly these features, replacing the persisted one (not appending —
//          a feature is a set membership, and append would make "svg was on, I
//          want only lottie" inexpressible).
// Duplicates are dropped: `--features svg --features svg` or a comma-list that
// repeats a name must not emit its macro twice.
function resolveFeatures(raw: string[] | undefined): string[] | null {
  if (!raw) return null;
  const hasNone = raw.includes('none');
  if (hasNone && raw.length > 1) {
    throw new Error(
      `--features 'none' cannot be combined with other names (got '${raw.join(',')}'): 'none' clears every feature`
    );
  }
  return hasNone ? [] : [...new Set(raw)];
}

// Does this program touch flash.data (or a flash.events.SQL* event)? This decides
// whether the build links the SQLite engine. The test is deliberately
// over-inclusive: a false positive costs ~7 s of extra compile time, while a
// false NEGATIVE is still loud — the runtime preamble's stub open() throws an
// explicit "the SQLite backend was not linked into this build" SQLError rather
// than silently faking a database (AGENTS.md 1.5). Matches both an import/
// qualified use (`flash.data.`) and the bare class names, so
// getDefinitionByName("flash.data.SQLConnection") is caught too.
function usesFlashData(texts: string[]): boolean {
  const re = /flash\.data\.|flash\.events\.SQL|(?:^|[^A-Za-z0-9_.$])(?:SQLConnection|SQLStatement|SQLResult|SQLMode|SQLSchema|SQLSchemaResult|SQLTableSchema|SQLViewSchema|SQLIndexSchema|SQLTriggerSchema|SQLColumnSchema|SQLColumnNameStyle|SQLTransactionLockType|SQLCollationType|SQLEvent|SQLUpdateEvent|SQLErrorEvent)(?![A-Za-z0-9_])/;
  for (const t of texts) if (re.test(t)) return true;
  return false;
}

// `as-aot doctor`. The check table lives in src/checks.ts and the rendering in
// src/doctor.ts; what belongs HERE is the one decision neither of them can make:
// *which build is being asked about*. That answer is a real BuildConfig rather
// than a hand-written summary of one, because the checks key off the same fields
// a build keys off (linkLibs, defines, sources). A parallel description of "what
// this needs" would be a second source of truth, i.e. exactly what this design
// sets out to avoid.
//
// Three ways to say what is being built:
//   --manifest <f>   read that manifest (no side effects);
//   --air-app <xml>  generate the manifest a real build would and read it back --
//                    this DOES write <filename>.build.json, because that is the
//                    only way to know what the app actually pulls in; the report
//                    says so on stderr;
//   neither          the standard native desktop app, synthesised through
//                    airManifest (the same function the --air-app path uses) so
//                    no file is written and no rule is duplicated.
// The two directories every build-relevant check needs. Derived from this file's
// own URL (so a relocated checkout still resolves them) and stated once, so that
// `doctor` and the build path cannot disagree about where `vendor/` lives.
function repoPaths(): { repoDir: string; vendorDir: string } {
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return { repoDir, vendorDir: resolve(repoDir, 'vendor') };
}

// The context the check table reads on the build path. `outDir` is null: only the
// icudtl.dat deployment (a `doctor --fix` action) needs an output directory, and
// a compile never invokes it.
function buildCheckCtx(cfg: BuildConfig, appUses?: CheckCtx['appUses']): CheckCtx {
  return { ...repoPaths(), cfg, outDir: null, appUses };
}

// Async for exactly one reason: `--check-update` waits on the registry. Every
// other path through here stays synchronous.
async function runDoctorMode(opts: Options): Promise<number> {
  const { repoDir, vendorDir } = repoPaths();
  const cfg = defaultBuildConfig();

  // CLI overrides are applied LAST, after any manifest merge -- the same
  // "manifest first, CLI wins" rule main() follows. Applying them first is a
  // real bug rather than a style choice: the generated manifest carries
  // `target: native`, so `--target wasm` would be silently undone.
  const overrides = opts.overrides;

  if (opts.airApp) {
    const air = prepareAirApp(
      opts.airApp, opts.mainClass, vendorDir,
      overrides.package === 'web', resolveFeatures(overrides.features),
      opts.output, opts.includeThirdParty, opts.extDirs,
    );
    process.stderr.write(`doctor: judged against the manifest generated from ${opts.airApp}\n`);
    Object.assign(cfg, applyManifest(cfg, loadManifest(air.manifestPath), air.manifestPath));
  } else if (opts.manifest) {
    Object.assign(cfg, applyManifest(cfg, loadManifest(opts.manifest), opts.manifest));
  } else {
    // No configuration was named. Synthesise the standard desktop app through
    // airManifest -- the same function the --air-app path uses, so no rule is
    // duplicated -- but only where that is the right shape. A `--target wasm`
    // --package raw build is a bare WASI module that links no vendor libraries
    // at all, so synthesising SDL2 + Cocoa into it would report requirements
    // the build will never have.
    Object.assign(cfg, overrides);
    // Synthesise only for a NATIVE target. Two reasons, one of them a real bug:
    //   1. native is the shape the vendor checks exist for;
    //   2. airManifest pins `target` itself. Letting it run for a wasm request
    //      overwrites the user's --target, and worse, it silently REPAIRS a
    //      `--package web` that is missing `--target wasm` -- which the real
    //      build rejects (index.ts). A doctor that disagrees with the build is
    //      the one thing it must never do, so the web branch is simply not
    //      synthesised here and `build.package-target` gets to report it.
    if (cfg.target === 'native') {
      // `vendor` + a repoDir anchor: the generator emits paths relative to the
      // `vendorRel` it is handed, and resolving them against the repo root is
      // what makes them point at the real tree. The path below is never written
      // -- applyManifest only uses it as a resolution anchor.
      const m = airManifest('vendor', true, true, false, false, 'auto', false, true,
        [], [], [], [], false, false, cfg.architecture, cfg.features);
      Object.assign(cfg, applyManifest(cfg, m as Manifest, join(repoDir, 'doctor.json')));
    }
  }

  // "CLI beats manifest" stated exactly once, covering every branch: the
  // synthesised path above had to merge early only to know WHICH shape to
  // synthesise, and that merge must not be the last word either.
  Object.assign(cfg, overrides);

  // The version is read from package.json in exactly one place (up there):
  // doctor.ts is a renderer and is handed what to print.
  const version = compilerVersion();
  // The ONE network call in this CLI: opt-in, read-only, bounded, and reported
  // rather than thrown. It cannot move the exit code -- a machine that simply
  // cannot reach the registry is still a machine that can build.
  const update = opts.doctorCheckUpdate ? await checkForUpdate(version, registryBase()) : null;

  return runDoctor({
    cfg,
    repoDir,
    vendorDir,
    outDir: opts.output === null ? null : dirname(resolve(opts.output)),
    json: opts.doctorJson,
    fix: opts.doctorFix,
    verbose: opts.doctorVerbose,
    version,
    update,
  });
}

async function main(): Promise<void> {
  if (process.env.AS3_MEMBERGAPS) {
    process.on('exit', () => {
      console.error('\n=== AS3_GAPS ===\n' + [...new Set(AS3_GAPS)].sort().join('\n') + '\n=== /AS3_GAPS ===');
    });
  }
  // `version` is a subcommand, positional like `doctor`, and it is recognised
  // before parseArgs for the same reason doctor is: every non-dash argument is an
  // input file, so `as-aot version` would otherwise die trying to read a file
  // called "version".
  if (process.argv[2] === 'version') {
    console.log(versionLine());
    process.exit(0);
  }
  const opts = parseArgs(process.argv.slice(2), process.argv[2] === 'doctor');
  if (opts.doctor) {
    process.exit(await runDoctorMode(opts));
  }

  // Resolve --features to the explicit set for THIS invocation, keeping "absent"
  // (null → keep whatever the manifest persists) distinct from "clear" ([] →
  // `--features none`). Runs before --air-app below, because the adapter writes
  // the set into the generated manifest: if it read a stale set it would undo the
  // user's choice on the very next run.
  const explicitFeatures = resolveFeatures(opts.overrides.features);

  // Build config: manifest first, then CLI overrides win (TypePHP's rule).
  // `loadedManifest`/`loadedManifestPath` are kept past the base merge so the
  // per-target overlay can be applied once the effective target is known.
  const cfg = defaultBuildConfig();
  let loadedManifest: Manifest | null = null;
  let loadedManifestPath: string | null = null;
  if (opts.manifest) {
    loadedManifest = loadManifest(opts.manifest);
    loadedManifestPath = opts.manifest;
    Object.assign(cfg, applyManifest(cfg, loadedManifest, opts.manifest));
  }

  // Read + parse all AS3 input. Two modes:
  //   --air-app <xml>: parse the AIR descriptor, synthesize a bootstrap plus a
  //                    build manifest, and collect every .as under src/.
  //   otherwise:       the explicit <input.as> list.
  let program: Program;
  let base: string;
  let cPath: string;
  let inputLabel: string;

  // `[Embed]` assets (阶段一百一十二): collected per file while the DECLARING
  // FILE's directory is still known, because a relative `source` resolves against
  // it (AIR's rule, measured on adl) — a fact the flattened program no longer
  // carries. A leading '/' resolves against `sourceRoot` instead.
  const embedResources: EmbedResourceSpec[] = [];
  const embedDecls: Stmt[] = [];
  const embedFieldInits = new Map<string, string>();
  // Source texts of every participating .as file, kept only to decide whether this
  // program touches flash.data (below). See `usesFlashData`.
  const sqliteScanTexts: string[] = [];
  const sourceRoot = opts.airApp
    ? resolve(dirname(opts.airApp), 'src')
    : dirname(resolve(opts.inputs[0]));
  const collectEmbeds = (body: Stmt[], fileDir: string): void => {
    const emb = embedCompileInputs(body, { fileDir, sourceRoot });
    embedResources.push(...emb.resources);
    embedDecls.push(...emb.decls);
    for (const [k, v] of emb.fieldInits) embedFieldInits.set(k, v);
  };

  // SWC libraries are extracted ONCE, up here, for two reasons: the reachability
  // closure below needs the superclass of every symbol class as an extra root (an SWC
  // symbol bound to a class the project compiles from source drags that class's
  // source into the build — see reach.ts::computeReachable), and the SWC block
  // further down must not parse the same 700 KB library twice.
  const swcLibs = new Map<string, SwcLibrary>();
  const swcLib = (path: string): SwcLibrary => {
    let l = swcLibs.get(path);
    if (l === undefined) { l = extractSwc(path); swcLibs.set(path, l); }
    return l;
  };

  if (opts.airApp) {
    const vendorAbs = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');
    // --package web selects the browser backend for the generated manifest; the
    // window backend (SDL2/Cocoa) is native-only and cannot link under wasm-ld.
    // `opts.output` reaches the adapter because the web preload set must not sweep
    // this build's own output dir into the page's FS image (see findPreloadPaths).
    const air = prepareAirApp(opts.airApp, opts.mainClass, vendorAbs, opts.overrides.package === 'web', explicitFeatures, opts.output, opts.includeThirdParty, opts.extDirs);
    // The adapter reports what it can see but must not silently ship (e.g. a web
    // build whose text has no font to draw with). Yellow, not red: the build is
    // still usable, but the output would be wrong in a way the user cannot guess.
    for (const w of air.warnings) process.stderr.write(`\x1b[33mwarning: ${w}\x1b[0m\n`);
    loadedManifest = loadManifest(air.manifestPath);
    loadedManifestPath = air.manifestPath;
    Object.assign(cfg, applyManifest(cfg, loadedManifest, air.manifestPath));

    program = { body: [], imports: [] };
    const bootSrc = generateBootstrap(air.info, air.mainClass);
    sqliteScanTexts.push(bootSrc);
    const boot = parse(bootSrc);
    program.body.push(...boot.body);
    program.imports.push(...boot.imports);
    // The document class's [SWF(frameRate=...)] is the last word on the cadence: the
    // bootstrap has none, and an app's own file is merged below only if it declares
    // one (the boot file is deliberately skipped there, see the loop).
    if (boot.swfFrameRate !== undefined) program.swfFrameRate = boot.swfFrameRate;
    const srcDir = resolve(dirname(opts.airApp), 'src');
    // Pass 1: read + parse + rewrite EVERY source, so the reachability closure can
    // see the whole tree. The rewrite (file-scoped package for an
    // anonymous-namespace class, same-file imports) must run first: it is what
    // gives each declaration the identity the closure resolves against, and what
    // the real build's symbols will carry. See reach.ts::prepareReachFiles.
    const parsedFiles: ReachFile[] = prepareReachFiles(air.asFiles, srcDir);
    // Pass 2: the compile face. AIR's own linker keeps only the transitive class
    // closure from the document class (`mxmlc -link-report` on the away3d demos:
    // 158–246 classes each, vs the 485 `.as` files a whole-src compile pulls in),
    // so compiling everything over-approximates AIR — bloating the emitted C with
    // other demos' `[Embed]` assets and turning a broken embed in an unreachable
    // class into a build failure `adl` never sees. See reach.ts for the soundness
    // argument; `--all-sources` restores the whole-tree face.
    let keptFiles = parsedFiles;
    const fileLevelDecls = new Map<string, string>();
    const fileLevelCollisions = new Set<string>();
    let reachNote = `${air.asFiles.length} sources`;
    if (!opts.allSources) {
      // Roots the AS3 source cannot name: a symbol class's base class that the SWC
      // links to (see the swcLib cache above). Only project-declared FQNs matter
      // (`computeReachable` ignores the rest), and the stock display classes are
      // skipped so an artwork-only library adds nothing.
      //
      // The CLI's `--swc` flags are merged into cfg.swcPaths further down (after this
      // branch, with the rest of the CLI overrides), so reading cfg alone would miss a
      // library named only on the command line — which is exactly how the app itself is
      // built (`--swc lib/skin.swc`).
      const swcBaseRoots: string[] = [];
      for (const p of [...cfg.swcPaths, ...(opts.overrides.swcPaths ?? [])]) {
        for (const base of swcLib(p).bases.values()) {
          if (base.baseName.length > 0 && !base.baseName.startsWith('flash.')) swcBaseRoots.push(base.baseName);
        }
      }
      const reach = computeReachable(parsedFiles, air.mainClass, swcBaseRoots);
      const keep = new Set(reach.kept);
      keptFiles = parsedFiles.filter((f) => keep.has(f.path));
      reachNote = reach.dropped.length > 0
        ? `${reach.kept.length}/${air.asFiles.length} sources reachable from ${air.mainClass}`
        : `${air.asFiles.length} sources`;
    }
    for (const f of keptFiles) {
      sqliteScanTexts.push(readFileSync(f.path, 'utf8'));
      program.body.push(...f.body);
      program.imports.push(...f.imports);
      // [SWF(frameRate=...)] rides along with the file that declares it (the merged
      // program is what codegen sees; the metadata itself is not a declaration).
      if (f.swfFrameRate !== undefined && program.swfFrameRate === undefined) program.swfFrameRate = f.swfFrameRate;
      // Collect this file's file-level (script) declaration names so a name
      // declared in TWO kept files can be reported. (`--air-app` merges every file
      // into one script, so the two declarations would alias onto one global while
      // AIR scopes them per file -- a divergence the user must see, not discover.)
      for (const n of collectScriptVars(f.body)) {
        const prev = fileLevelDecls.get(n);
        if (prev === undefined) fileLevelDecls.set(n, f.path);
        else if (!fileLevelCollisions.has(n)) {
          fileLevelCollisions.add(n);
          process.stderr.write(`\x1b[33mwarning: file-level declaration '${n}' appears in both ${basename(prev)} and ${basename(f.path)}; AIR scopes file-level declarations per file, but this build merges every source into one script and shares one global\x1b[0m\n`);
        }
      }
      // Runs AFTER the anonymous-namespace rewrite above, so the declaring class's
      // name+package are the ones symbol collection will see (the `[Embed]` field
      // lookup key is built from exactly these two strings).
      collectEmbeds(f.body, dirname(f.path));
    }
    base = opts.output ?? resolve(dirname(opts.airApp), air.info.filename);
    cPath = `${base}.c`;
    inputLabel = `${opts.airApp} (main ${air.mainClass}, ${reachNote})`;
  } else {
    program = { body: [], imports: [] };
    for (const input of opts.inputs) {
      const text = readFileSync(input, 'utf8');
      sqliteScanTexts.push(text);
      const p = parse(text);
      program.body.push(...p.body);
      program.imports.push(...p.imports);
      if (p.swfFrameRate !== undefined && program.swfFrameRate === undefined) program.swfFrameRate = p.swfFrameRate;
      collectEmbeds(p.body, dirname(resolve(input)));
    }
    const first = opts.inputs[0];
    base = opts.output ?? first.replace(/\.as$/i, '');
    cPath = opts.output ? `${opts.output}.c` : first.replace(/\.as$/i, '.c');
    inputLabel = opts.inputs.join(', ');
  }

  // Per-target overlay (阶段八十九·五十): a single manifest may declare
  // `targets.<name>` blocks that REPLACE the shared top-level build fields for
  // one target — e.g. link curl natively but drop it for wasm. Applied here,
  // after the base manifest merge but before the CLI overrides, so the block is
  // selected by the *final* target (`--target` can change it) while CLI flags
  // still beat both the base manifest and any layer (TypePHP's rule).
  if (loadedManifest && loadedManifestPath) {
    const effectiveTarget = (opts.overrides.target ?? cfg.target) as Target;
    Object.assign(cfg, applyManifestOverlay(cfg, loadedManifest, loadedManifestPath, effectiveTarget));
  }

  // CLI overrides win over the manifest (both --manifest and --air-app).
  if (opts.overrides.target) cfg.target = opts.overrides.target;
  if (opts.overrides.package) cfg.package = opts.overrides.package;
  if (opts.overrides.cCompiler) cfg.cCompiler = opts.overrides.cCompiler;
  if (opts.overrides.opt) cfg.opt = opts.overrides.opt;
  if (opts.overrides.debugInfo !== undefined) cfg.debugInfo = opts.overrides.debugInfo;
  if (opts.overrides.lto !== undefined) cfg.lto = opts.overrides.lto;
  if (opts.overrides.pgo) cfg.pgo = opts.overrides.pgo;
  if (opts.overrides.pgoDir) cfg.pgoDir = opts.overrides.pgoDir;
  if (opts.overrides.dry) cfg.dry = true;
  // --ane-platform had no line here until 阶段一百七十八·三: the flag was parsed
  // into opts.overrides and then dropped, so a build that named Windows-x86 was
  // resolved, linked and staged as whatever the HOST is -- silently, with a
  // success exit code. The default happens to equal the host platform, which is
  // exactly why nothing caught it until a cross-width build was attempted.
  if (opts.overrides.anePlatform) cfg.anePlatform = opts.overrides.anePlatform;
  // Unlike -D (which appends to the manifest's defines), --features REPLACES the
  // set: see resolveFeatures for why.
  if (explicitFeatures) cfg.features = explicitFeatures;
  for (const k of ['includePaths', 'linkLibs', 'linkPaths', 'defines', 'exports', 'frameworks', 'sources', 'swcPaths', 'anePaths'] as const) {
    const extra = opts.overrides[k];
    if (extra) cfg[k].push(...extra);
  }

  // SWC resources (阶段九十五): extract named bitmaps at compile time and turn
  // them into ordinary class declarations plus embedded-byte specs. This runs
  // BEFORE codegen so the synthesized `ClassDecl`s participate in symbol
  // collection, type resolution, vtables and the reflection registry.
  const swcResources: SwcResourceSpec[] = [];
  const swcChars: SwcCharacterClass[] = [];
  const swcLibraries: SwcLibrary[] = [];
  if (cfg.swcPaths.length > 0) {
    const declared = new Set<string>();
    // The same set in AS3 spelling (`com.example.controls.ComBoBox`), because that is
    // how the library's `DoABC` names a base class. A symbol binds to its project base
    // only when that base is one of THESE sources -- the library's own copy of the
    // class is not compiled (swc.md §3.3), so a base missing here would not even be
    // declarable (see availableProjectBase in swc.ts).
    const declaredFqn = new Set<string>();
    for (const s of program.body) {
      if (s.kind !== 'ClassDecl') continue;
      declared.add(qualifiedName(s.name, s.packageName));
      declaredFqn.add(s.packageName ? `${s.packageName}.${s.name}` : s.name);
    }
    for (const libPath of cfg.swcPaths) {
      const lib = swcLib(libPath);
      const inputs = swcCompileInputs(lib, (fqn) => declaredFqn.has(fqn));
      for (const spec of inputs.specs) {
        if (declared.has(spec.cname)) {
          throw new Error(
            `SWC '${libPath}' exports class '${spec.className}', but the AS3 source already declares a class with the same name`
          );
        }
        declared.add(spec.cname);
      }
      for (const ch of inputs.chars) {
        if (declared.has(ch.cname)) {
          throw new Error(
            `SWC '${libPath}' exports display class '${ch.cname}', but the AS3 source already declares a class with the same name`
          );
        }
        declared.add(ch.cname);
      }
      program.body.push(...inputs.decls);
      swcResources.push(...inputs.specs);
      swcChars.push(...inputs.chars);
      swcLibraries.push(lib);
    }
  }

  // The synthesized `[Embed]` asset classes join the program here, before codegen,
  // so they take part in symbol collection, type resolution, vtables and the
  // reflection registry exactly like the SWC resource classes do.
  program.body.push(...embedDecls);

  // 校验 target/package 合法性：非法值（如 `--target .wasm` 多带了一个点）必须
  // 立即报错，而不是静默 fallback 到 native——那会产出「编译过但结果错」的产物，
  // 违反 §2.5「禁止静默吞错 / 禁止 fallback 到错误语义」红线。
  const VALID_TARGETS: readonly string[] = ['native', 'wasm'];
  const VALID_PACKAGES: readonly string[] = ['raw', 'xcode-project', 'android-project', 'web'];
  if (!VALID_TARGETS.includes(cfg.target)) {
    throw new Error(`unknown --target '${cfg.target}' (expected: native | wasm; write \`wasm\` without a dot)`);
  }
  // A feature the backend cannot link must fail here, in the project's own words,
  // not as an unresolved-symbol dump from the linker.
  validateFeatures(cfg.features, cfg.target);
  if (!VALID_PACKAGES.includes(cfg.package)) {
    throw new Error(`unknown --package '${cfg.package}' (expected: raw | xcode-project | android-project | web)`);
  }

  // Native extensions (阶段一百七十二). Each .ane is resolved to the native library
  // THIS platform loads, out of its own extension.xml, at compile time — and the
  // three flags it takes to make the generated C a FRE host are added here, in
  // one place, ONLY when a build asked for an extension. A build with no --ane
  // stays byte-identical to what it produced before this stage: no -DASC_HAVE_FRE,
  // no asaot.lib, no extra include path.
  let aneResolution: AneResolution | undefined;
  if (cfg.anePaths.length > 0) {
    // The key follows the TARGET this build produces, not the host that runs the
    // compiler: `architecture` "32" means a 32-bit program, and AIR would give it
    // the x86 runtime's slice (see anePlatformForBuild).
    const platform = cfg.anePlatform !== '' ? cfg.anePlatform : anePlatformForBuild(cfg.architecture, cfg.target);
    if (platform === '') {
      // Two hosts land here and the advice differs: Linux has an AIR runtime but no
      // asaot build, while Windows ARM64 has no AIR key at all — where naming a
      // nonexistent 'Windows-arm64' is exactly the wrong way out (measured: in AIR SDK
      // 51.4.1 each Windows runtime carries exactly ONE platform key -- win/Adobe AIR.dll
      // has Windows-x86, the win64 one has Windows-x86-64 -- so the whole closed set is
      // those two). The
      // sentence itself lives in ane.ts with the rest of the platform-key knowledge,
      // so it is testable without a Windows-on-ARM machine.
      // The host is what usually decides this, but a Windows build can also be told
      // to produce a bitness that has no key of its own (see anePlatformForBuild).
      // Say WHICH of the two lost the key: pointing at a host that still has its
      // own key is how someone ends up passing --ane-platform to "fix" a problem
      // that the flag does not describe.
      const targetLostKey = process.platform === 'win32' && cfg.architecture === 'arm64';
      throw new Error(
        `--ane for this ${targetLostKey ? 'target (architecture "arm64")' : `host (${process.platform}/${process.arch})`} ` +
          'has no AIR platform key; pass --ane-platform <Windows-x86-64|Windows-x86|MacOS-x86-64|iPhone-ARM> to name the target' +
          anePlatformHint(process.platform, targetLostKey ? 'arm64' : process.arch)
      );
    }
    aneResolution = resolveAneDescriptors(cfg.anePaths, platform);
    // The include path points at lib/ itself (the shim header every recompiled ANE
    // is given resolves `#include "asaot.h"` from there), while the LINK path points
    // at the platform's own subdirectory: the header is one contract shared by all
    // platforms, the import library is that platform's build product.
    const libDir = resolve(dirname(fileURLToPath(import.meta.url)), '../lib');
    cfg.includePaths.push(libDir);
    cfg.linkPaths.push(resolve(libDir, 'bin', aneHostDirName(platform)));
    cfg.defines.push('ASC_HAVE_FRE=1');
    // asaot.lib is the import library of asaot.dll, generated by the linker
    // (/IMPLIB:) from lib/build-asaot.bat — one source of truth, the DLL.
    cfg.linkLibs.push('asaot');
  }

  console.log(`== as-aot: AS3 subset -> C -> ${cfg.target} ==`);
  // An enhancement that is ON must never be silent (§1.5): it is what separates
  // this artifact from what `adl` would do with the same input, so name it and
  // show the macro that carries it.
  if (cfg.features.length > 0) {
    const macros = featureMacros(cfg.features);
    console.log(`== enhancements: ${cfg.features.join(', ')} (${macros.map((m) => `-D ${m}`).join(' ')}) ==`);
    console.log('   ^ AIR superset: adl rejects these inputs; a default build stays AIR-identical');
  }
  console.log(`[1/4] read        ${inputLabel}`);
  console.log('[2/4] parse       tokenize + AST');
  if (cfg.swcPaths.length > 0) {
    console.log(`      swc         ${cfg.swcPaths.length} library(ies): ${swcResources.length} embedded resource(s)`);
  }
  if (aneResolution) {
    // Every resolved extension, by id and by the file that has to be beside the
    // executable. An extension whose native library went missing is otherwise a
    // runtime null from createExtensionContext with nothing to explain it.
    console.log(`      ane         ${aneResolution.descriptors.length} extension(s)`);
    for (const d of aneResolution.descriptors) {
      console.log(`                  ${d.extId} <- extensions/${d.nativeLib} (${d.initializer})`);
    }
  }
  if (embedResources.length > 0) {
    // Which asset KIND each `[Embed]` became, and from which file: `mimeType`
    // overrides the extension, so this is the only place that mistake is visible
    // before something renders wrong (§1.5 — never silently).
    console.log(`      embed       ${embedResources.length} asset(s)`);
    for (const r of embedResources) {
      console.log(`                  ${r.kind.padEnd(7)} ${r.declaredAt} <- ${r.source} (${r.encoded.length} bytes)`);
    }
  }
  console.log('[3/4] codegen     emit C source');
  // Bake the display trees of every exported symbol (swc.md §9 E-3). Character
  // ids are only unique WITHIN one library, and the baked factories are keyed by
  // that raw id, so two libraries would need a global id remap. Refuse loudly
  // rather than emitting a factory that resolves the wrong character.
  let swcBake: SwcBake | undefined;
  if (swcLibraries.length === 1) {
    swcBake = swcBakePlan(swcLibraries[0], swcResources, swcChars);
    // A baked symbol that needs a text/font/morph character loses that part of its
    // artwork (swc.md §3.3 — those tags are deliberately not rendered). Say so
    // loudly and name the tags, rather than producing a quietly incomplete skin.
    if (swcBake.unsupported.length > 0) {
      const named = [...new Set(swcBake.unsupported.map((u) => u.kind))].sort().join(', ');
      console.warn(
        `warning: ${swcBake.unsupported.length} character(s) in the baked display trees are ${named}; ` +
          'they are not rendered (text/font/morph rendering is out of scope — see docs/zh-cn/swc.md §3.3); ' +
          'the exported symbols that use them will be missing that artwork'
      );
    }
    // Non-character fidelity gaps: a PlaceObject3 attribute the baker cannot
    // express (a filter kind we do not render, a blend mode with no equivalent).
    // AIR applies these, so they are named rather than silently rendered as if
    // the SWF had not asked for them (swc.md §9.2 F4).
    for (const note of swcBake.notes) {
      console.warn(`warning: ${note} (docs/zh-cn/swc.md)`);
    }
  } else if (swcLibraries.length > 1) {
    console.warn(
      `warning: ${swcLibraries.length} .swc libraries given — display trees are only baked for a single library ` +
        '(character ids are library-local); the exported classes still type-check and their named bitmaps still embed'
    );
  }
  // `--air-app` builds carry the descriptor into the generated program so
  // `NativeApplication.applicationDescriptor` can hand the program the very
  // document that described this build (AIR guarantees readability there).
  let appDescriptorXml: string | undefined;
  if (opts.airApp) {
    try { appDescriptorXml = readFileSync(opts.airApp, 'utf8'); } catch { appDescriptorXml = undefined; }
  }
  const { c, exports } = generateC(program, cfg.exports, swcResources, swcBake, embedResources, embedFieldInits, appDescriptorXml, aneResolution?.descriptors ?? []);
  writeFileSync(cPath, c);

  // ---- flash.data / SQLite engine wiring ----------------------------------
  // The AS3 flash.data layer is emitted for every build (its engine ABI stubs live
  // in the runtime preamble), but the ENGINE -- the official SQLite amalgamation
  // plus the as_sql_* glue -- is added ONLY when the program touches flash.data,
  // because compiling the 9 MB amalgamation costs ~7 s and must not be paid by
  // every unrelated example or test. The amalgamation is the exact-semantics
  // choice: AIR's PLAINTEXT databases ARE standard SQLite files.
  if (usesFlashData(sqliteScanTexts)) {
    const vendorDir = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');
    cfg.sources.push(resolve(vendorDir, 'sqlite_glue.c'), resolve(vendorDir, 'sqlite', 'sqlite3.c'));
    cfg.includePaths.push(resolve(vendorDir, 'sqlite'));
    cfg.defines.push('ASC_HAVE_SQLITE', 'SQLITE_ENABLE_COLUMN_METADATA');
    // wasi/wasm-ld has no pthread, so SQLite's default (multi-thread) mode would
    // not compile there; our compiler and runtime are single-threaded anyway.
    if (cfg.target === 'wasm') cfg.defines.push('SQLITE_THREADSAFE=0');
    console.log('   + flash.data: linking the SQLite engine (vendor/sqlite)');
  }

  // [WasmExport] declarations are auto-exported: append their C symbols (or alias
  // wrapper names) to the link-time export list so they land in the .wasm export
  // table without the user spelling out long namespaced symbol names on the CLI.
  if (exports.length > 0) {
    for (const e of exports) {
      const exportName = e.alias ?? e.symbol;
      if (!cfg.exports.includes(exportName)) cfg.exports.push(exportName);
    }
  }

  // Native executables carry an `.exe` suffix on Windows (lld-link's standard
  // output name; Node's spawnSync/execve equivalent — CreateProcessW — only tries
  // the `.exe`/`.cmd`/`.bat`/`.com` extension sequence, so an extensionless PE
  // file is ENOENT to it even though the same file runs fine from a shell). On
  // POSIX there is no extension convention: the Mach-O/ELF runs via execve no
  // matter its name, so `base` is left as-is.
  const outPath =
    cfg.target === 'wasm'
      ? `${base}.wasm`
      : process.platform === 'win32' && !base.toLowerCase().endsWith('.exe')
        ? `${base}.exe`
        : base;

  // Audio (flash.media) is delivered by a backend the build layer links, not by
  // the frontend: without it every playback entry point keeps answering honestly
  // — play() returns null, SoundMixer.areSoundsInaccessible() is true — instead
  // of pretending to play. That is the right behaviour, but it is invisible from
  // the AS3 source, so say it once here (§1.5). --air-app wires it automatically
  // (no warning: the define is already in the manifest); a hand-written
  // --manifest or a plain build does not.
  // `defines` entries may carry a value (`ASC_HAVE_AUDIO=1`), so match the macro
  // name, not the whole string.
  const audioLinked = cfg.defines.some((d) => d === 'ASC_HAVE_AUDIO' || d.startsWith('ASC_HAVE_AUDIO='));
  if (!audioLinked && program.imports.some((i) => i === 'flash.media' || i.startsWith('flash.media.'))) {
    // The native wording (and the fix) comes from the check table, so `doctor`
    // and a build say the same sentence. The browser case is a separate
    // requirement -- there is no glue to add, the backend simply does not exist
    // yet -- so it keeps a line of its own rather than being forced into that
    // check's "add this file" shape.
    const how = cfg.target === 'wasm'
      ? `the browser build has no audio backend yet, so nothing will play (docs/zh-cn/audio.md)`
      : checkFailure('vendor.audio', buildCheckCtx(cfg, { audio: true }));
    if (how !== null) {
      console.warn(
        `warning: this program uses flash.media, but this build links no audio backend: play() returns null and ` +
          `SoundMixer.areSoundsInaccessible() is true.\n` +
          `  ${how}`
      );
    }
  }

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
    // Both of these are enforced by the same table `as-aot doctor` renders, so
    // there is one sentence per requirement rather than two that can drift
    // (see requireCheck in checks.ts).
    const badTarget = requireCheck('build.package-target', buildCheckCtx(cfg));
    if (badTarget !== null) throw new Error(`cannot build for --package web: ${badTarget}`);
    const missing = requireCheck('web.emsdk', buildCheckCtx(cfg));
    if (missing !== null) {
      throw new Error(`cannot build for --package web: ${missing}`);
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
    const missing = requireCheck('wasi.sdk', buildCheckCtx(cfg));
    if (missing !== null) {
      throw new Error(`cannot build for --target wasm: ${missing}`);
    }
  }
  for (const s of steps) {
    console.log(`[4/4] compile     ${s.join(' ')}`);
    if (!runCompile(s)) process.exit(1);
  }

  // Skia text shaping on a Windows native build needs icudtl.dat beside the exe
  // (see deploySkiaIcuData). Deploy it after a successful link; a missing file
  // would otherwise surface later as a SIGILL on the first text-shaping call.
  if (deploySkiaIcuData(cfg, outPath)) {
    console.log(`[4/4] data        icudtl.dat -> ${dirname(resolve(outPath))}`);
  }

  // The recompiled ANE native libraries and the FRE host DLL go next to the
  // executable, which is where as_ext_dir()/LoadLibraryA look. Staged rather
  // than referenced in place so the build directory is self-contained: copy the
  // exe somewhere else and its extensions still load.
  if (aneResolution) {
    const written = stageAneNatives(aneResolution, outPath);
    const hostDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../lib',
      'bin',
      aneHostDirName(aneResolution.platform)
    );
    const dll = resolve(hostDir, 'asaot.dll');
    const noHost = requireCheck('ane.hostlib', buildCheckCtx(cfg));
    if (noHost !== null) throw new Error(noHost);
    copyFileSync(dll, join(dirname(resolve(outPath)), 'asaot.dll'));
    console.log(`[4/4] ane         asaot.dll + ${written.length} native library(ies) -> ${join(dirname(resolve(outPath)), 'extensions')}`);
    for (const w of written) console.log(`                  extensions/${w}`);
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
// 页面级错误收集：wasm 加载失败、Promise 抛错都会落到这里，供人和自动化读取
// （window.__ascErrors）。运行期错误如果只出现在控制台，自动化验收就看不见。
window.__ascErrors = [];
window.addEventListener('error', function (ev) { window.__ascErrors.push('error: ' + String(ev.message || ev.error)); });
window.addEventListener('unhandledrejection', function (ev) { window.__ascErrors.push('unhandled rejection: ' + String(ev.reason)); });
// 字体字节流 URL（网络加载 + 全量覆盖）：wasm 沙箱无系统字体，这些字体在
// main() 运行前 fetch 并注入 Skia 的自定义 FreeType 字体管理器。
var FONT_URLS = ${fontArray};
var Module = {
  canvas: document.getElementById('canvas'),
  // trace() reaches stdout as printf, and these hooks keep it two ways: the
  // browser console for a human, and window.__ascStdout for automation (the web
  // verification harness reads assertions from there — a wasm page has no stdout).
  print: function(line) {
    (window.__ascStdout || (window.__ascStdout = [])).push(line);
    console.log(line);
  },
  printErr: function(line) {
    (window.__ascStderr || (window.__ascStderr = [])).push(line);
    console.error(line);
  },
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
    // main() ends by calling emscripten_set_main_loop(..., simulateInfiniteLoop=1),
    // which hands control back to the browser's rAF loop by unwinding the wasm
    // stack -- its JS implementation returns by throwing the sentinel string
    // 'unwind'. Emscripten's own run()/callMain() swallows that sentinel, but
    // this page calls _main() directly from an async function, so an unswallowed
    // 'unwind' shows up as a bogus "Uncaught (in promise)" in the console (and
    // would mask any real throw from main()). Swallow exactly that sentinel;
    // rethrow everything else so genuine failures stay visible.
    try {
      Module._main();
    } catch (e) {
      if (e !== 'unwind') throw e;
    }
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
  await main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`);
  // The stack is for us, not for the user: it used to print unconditionally, so a
  // mistyped flag arrived buried under Node internals and read as a crash rather
  // than as "I do not know that flag". AS3_TRACE=1 brings it back -- that, plus
  // `as-aot --version`, is what a bug report should carry.
  const trace = process.env.AS3_TRACE;
  if (trace !== undefined && trace !== '' && trace !== '0' && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
}
