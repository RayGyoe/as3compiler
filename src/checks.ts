// Checks: the single source of truth for "can this machine do what was asked?".
//
// The knowledge used to live in four scattered places, and all four reported
// LATE -- after the user had already waited:
//
//   * the vendored curl tree, only once a build reached deep into --air-app;
//   * the WASI toolchain, only when a wasm compile was attempted;
//   * the Emscripten SDK, only inside the --package web branch;
//   * the ANE host library, only after a successful link.
//
// And one thing was never checked at all: a missing `icudtl.dat`. Its symptom is
// Skia's SkParagraph aborting to a `ud2` trap -- exit 132 with no message
// naming the missing file, on the first call that shapes text.
//
// `as-aot doctor` renders this table (src/doctor.ts). The build paths call
// `requireCheck()` so they fail with the SAME sentence the doctor prints, which
// is what keeps the two from drifting apart: there is one list, and doctor is
// its renderer rather than a parallel reimplementation.
//
// Scope note: which checks apply is decided from the BuildConfig itself (does
// it link skia? does it compile the audio glue? is the target wasm?) rather
// than from a separate "profile" the caller could get wrong. A plain
// `as-aot hello.as` links no vendor library and therefore answers NONE of the
// vendor checks -- correctly, since it needs none of them.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nonWindowsVendorKey, wasmToolchainError, webToolchainError, emccPath, windowsTargetTriple, type BuildConfig } from './build.ts';
import { aneHostDirName, aneHostLibName, anePlatformForBuild } from './ane.ts';

export type CheckKind = 'hard' | 'warn' | 'info';

export interface CheckOutcome {
  status: 'ok' | 'fail' | 'skip';
  // What was actually measured: a resolved path, a version string, a probe
  // result. Never a restatement of the check's title.
  detail: string;
  // A copy-pasteable remedy. Present exactly when status is 'fail'.
  fix?: string;
  // True when `--fix` handles it: fast, idempotent, no build, no network, and
  // no lasting change to the machine. Everything expensive (building a
  // dependency tree, installing a toolchain) is deliberately NOT fixable --
  // the doctor prints the command and the user runs it.
  fixable?: boolean;
}

// Hosts where vendor/audio_glue.c's miniaudio build has a backend that was
// actually measured to work. Stated once, here, because two callers need the
// same answer for different reasons: air-app.ts decides whether to put the glue
// on the link line at all, and the vendor.audio check decides how to explain the
// gap when it is not there. Two copies would eventually disagree, and the one
// that drifted would be the one saying "nothing will play."
//
// Windows is not a special case for the LINKER either -- miniaudio reaches all
// three of its Windows backends through LoadLibrary/GetProcAddress, so that link
// line needs no `-l` at all, while macOS needs its two Apple frameworks named
// (see air-app.ts's audio block). This list is thus "hosts where a backend was
// built AND measured", not "hosts where miniaudio could theoretically work".
export const AUDIO_GLUE_HOSTS: readonly string[] = ['darwin', 'win32'];

export interface CheckCtx {
  cfg: BuildConfig;
  // Absolute path to .../as3compiler/vendor
  vendorDir: string;
  // Absolute path to .../as3compiler (the git repository root and the npm
  // package root -- note that build-tools/ lives OUTSIDE it and is untracked).
  repoDir: string;
  // Where `--fix` may write (the directory of `-o`), or null when no output
  // path was given. Only the icudtl.dat deployment needs it.
  outDir: string | null;
  // Signals a caller knows but the BuildConfig cannot carry, because the
  // manifest is built FROM them. The audio case is the concrete one: the
  // manifest defines ASC_HAVE_AUDIO only when a backend is actually linked, so
  // "the app uses flash.media but this host has no backend" is not derivable
  // from the config -- air-app.ts knows it from its own source scan and says so
  // here. Absent means "not known", never "no".
  appUses?: { audio?: boolean };
}

export interface Check {
  id: string;
  title: string;
  kind: CheckKind;
  applies: (ctx: CheckCtx) => boolean;
  run: (ctx: CheckCtx) => CheckOutcome;
}

export interface CheckResult extends CheckOutcome {
  id: string;
  title: string;
  kind: CheckKind;
}

const ok = (detail: string): CheckOutcome => ({ status: 'ok', detail });
const fail = (detail: string, fix: string, fixable = false): CheckOutcome => ({ status: 'fail', detail, fix, fixable });
const skip = (detail: string): CheckOutcome => ({ status: 'skip', detail });

// ---------------------------------------------------------------------------
// Signals read out of the BuildConfig. Each of these is set by the manifest
// generator (air-app.ts::airManifest) or by index.ts, so it states what this
// particular build actually needs -- no guessing from a coarse "profile".

const linksSkia = (c: CheckCtx): boolean => c.cfg.linkLibs.includes('skia');
const opensWindow = (c: CheckCtx): boolean => c.cfg.defines.includes('ASC_USE_WINDOW=1');
// flash.net / URLRequest: the manifest defines ASC_HAVE_CURL and links curl.
const usesTransport = (c: CheckCtx): boolean => c.cfg.defines.includes('ASC_HAVE_CURL=1');
const compilesSource = (c: CheckCtx, file: string): boolean => c.cfg.sources.some((s) => s.endsWith(`/${file}`) || s === file);
// --ane: the three FRE flags are added together (see index.ts).
const loadsExtension = (c: CheckCtx): boolean => c.cfg.defines.includes('ASC_HAVE_FRE=1');

const isNative = (c: CheckCtx): boolean => c.cfg.target === 'native';
const onWindows = (): boolean => process.platform === 'win32';

// The vendor key this HOST can link, for the non-Windows side. Windows follows
// the descriptor's <architecture> instead (the archives must match the target
// ABI), which air-app.ts computes itself; build.ts::nonWindowsVendorKey owns
// the non-Windows half so both callers and the pins read the same rule.
function hostVendorKey(): string {
  return nonWindowsVendorKey(process.platform, process.arch);
}

// `vendor/<pkg>/lib/<key>` for the current host+config, or '' when this host
// has no prebuilt tree at all. Exported because doctor's `--fix` has to resolve
// the same directory the checks did -- the alternative is a second copy of the
// rule, which is how the two would drift.
export function vendorLibDir(ctx: CheckCtx, pkg: string): string {
  const key = onWindows()
    ? (ctx.cfg.architecture === '32' ? 'windows-x86' : 'windows-x64')
    : hostVendorKey();
  return key === '' ? '' : join(ctx.vendorDir, pkg, 'lib', key);
}

// A one-line description of what the missing tree would have been, used by every
// vendor check so a host with no artifacts says the same thing three times
// rather than three different things.
const NO_TREE = `${process.platform}/${process.arch} has no prebuilt dependency tree in vendor/ `
  + `(only macos-arm64, windows-x64, windows-x86 and wasm exist)`;

// Which provision script actually produces this host's archives -- named in the
// fix text so the remedy is runnable rather than merely descriptive.
const provisionHint = ((): string => {
  if (onWindows()) return 'vendor/provision/windows.ps1';
  if (process.platform === 'darwin') return 'vendor/provision/macos.sh';
  return '';
})();

// MSVC's vectorised algorithms live in libcpmt.lib, not in the headers. A
// prebuilt Skia can therefore compile cleanly and fail only at lld-link when
// the SELECTED toolset is older than the one that produced the archive. Probe
// the archive's actual imports rather than imposing a version-number floor:
// a Skia rebuilt with the older local toolset need not import these symbols.
const SKIA_MSVC_STL_IMPORTS = [
  '__std_find_last_trivial_1',
  '__std_find_last_trivial_2',
  '__std_max_element_f',
  '__std_min_element_f',
  '__std_minmax_element_f',
  '__std_search_1',
] as const;

interface MsvcToolchainProbe {
  dir: string;
  version: string;
  error: string;
}

// Exported so the quoted Windows command-line shape is testable off Windows.
export function msvcToolDirFromClangOutput(output: string): string {
  const include = output.match(/["']-internal-isystem["']\s+["']([^"']*[\\/]VC[\\/]Tools[\\/]MSVC[\\/][^\\/"']+[\\/]include)["']/i)?.[1];
  if (include === undefined) return '';
  return include.slice(0, include.length - 'include'.length).replace(/[\\/]+$/, '');
}

function selectedMsvcToolchain(cfg: BuildConfig): MsvcToolchainProbe {
  const envDir = (process.env.VCToolsInstallDir ?? '').trim().replace(/[\\/]+$/, '');
  const dirVersion = (dir: string): string => dir.match(/[\\/]MSVC[\\/]([^\\/]+)$/)?.[1] ?? '';
  if (envDir !== '') return { dir: envDir, version: dirVersion(envDir), error: '' };

  // A plain Windows terminal has no vcvars environment. Ask the very compiler
  // the build will run which MSVC include tree it selected; this also handles
  // multiple installed 14.x toolsets without guessing that the newest on disk
  // is the one clang will use.
  const probe = spawnSync(cfg.cCompiler, [
    '-###', '-x', 'c++', '-',
    `--target=${windowsTargetTriple(cfg.architecture)}`,
    '-fms-runtime-lib=static',
  ], { encoding: 'utf8' });
  if (probe.error) return { dir: '', version: '', error: `'${cfg.cCompiler}' is not runnable (${probe.error.message})` };
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const dir = msvcToolDirFromClangOutput(output);
  if (dir === '') {
    return {
      dir: '', version: '',
      error: `could not determine the MSVC toolset selected by '${cfg.cCompiler}'`,
    };
  }
  return { dir, version: dirVersion(dir), error: '' };
}

// ---------------------------------------------------------------------------
// The checks.

export const CHECKS: Check[] = [
  // ---- host -------------------------------------------------------------
  {
    id: 'host.cc',
    title: 'C compiler',
    kind: 'hard',
    // The wasm target uses the WASI SDK's clang instead (see wasi.sdk), so the
    // configured compiler is not what a wasm build runs.
    applies: (c) => isNative(c),
    run: ({ cfg }) => {
      const r = spawnSync(cfg.cCompiler, ['--version'], { encoding: 'utf8' });
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code ?? r.error.message;
        return fail(
          `'${cfg.cCompiler}' is not runnable (${code})`,
          'Install a C toolchain -- macOS: `xcode-select --install`; Debian/Ubuntu: '
          + '`apt install build-essential`; or name an existing one with `--cc <name>`.',
        );
      }
      const first = (r.stdout || r.stderr || '').trim().split('\n')[0] ?? '';
      return ok(`${cfg.cCompiler} -- ${first}`);
    },
  },

  {
    id: 'host.vendor-key',
    title: 'host -> vendor key',
    kind: 'hard',
    // Only a build that links vendor archives cares. A plain `as-aot x.as`
    // compiles a self-contained C file and needs none of them.
    applies: (c) => isNative(c) && (linksSkia(c) || opensWindow(c) || usesTransport(c)),
    run: (ctx) => {
      if (onWindows()) {
        return ok(`windows-${ctx.cfg.architecture === '32' ? 'x86' : 'x64'} (from <architecture>)`);
      }
      const key = hostVendorKey();
      if (key === '') return fail(NO_TREE, 'Build the dependency tree for this host, or run on a host that has one.');
      return ok(key);
    },
  },

  // ---- vendored artifacts ----------------------------------------------
  {
    id: 'vendor.skia',
    title: 'Skia archives',
    kind: 'hard',
    applies: (c) => isNative(c) && linksSkia(c),
    run: (ctx) => {
      const dir = vendorLibDir(ctx, 'skia');
      if (dir === '') return skip(NO_TREE);
      const probe = join(dir, onWindows() ? 'skia.lib' : 'libskia.a');
      if (!existsSync(probe)) {
        return fail(
          `missing ${probe}`,
          provisionHint === ''
            ? 'This host has no provision recipe; the archive must be supplied some other way.'
            : `Run \`${provisionHint}\` to build it.`,
        );
      }
      return ok(probe);
    },
  },

  {
    id: 'host.msvc-stl',
    title: 'MSVC STL / Skia compatibility',
    kind: 'hard',
    applies: (c) => isNative(c) && onWindows() && linksSkia(c),
    run: (ctx) => {
      const skiaDir = vendorLibDir(ctx, 'skia');
      const skiaLib = join(skiaDir, 'skia.lib');
      if (skiaDir === '' || !existsSync(skiaLib)) {
        return skip('skia.lib is absent; vendor.skia reports that prerequisite');
      }

      const tool = selectedMsvcToolchain(ctx.cfg);
      if (tool.error !== '') {
        return fail(
          tool.error,
          'Install Visual Studio 2022 Build Tools with the MSVC v143 C++ toolset, or run from a '
          + 'Developer Command Prompt so VCToolsInstallDir names the selected toolset.',
        );
      }
      const libArch = ctx.cfg.architecture === '32' ? 'x86' : ctx.cfg.architecture === 'arm64' ? 'arm64' : 'x64';
      const libcpmt = join(tool.dir, 'lib', libArch, 'libcpmt.lib');
      const toolName = tool.version === '' ? tool.dir : `MSVC ${tool.version}`;
      if (!existsSync(libcpmt)) {
        return fail(
          `missing ${libcpmt} (${toolName})`,
          `Install the MSVC v143 C++ ${libArch} build tools in Visual Studio Installer, then rerun doctor.`,
        );
      }

      // COFF decoration differs between x86 (___std_search_1@16) and x64
      // (__std_search_1), so match the undecorated ASCII substring in both
      // archives. Buffer.includes does the byte search without a UTF-8 decode.
      const skiaBytes = readFileSync(skiaLib);
      const crtBytes = readFileSync(libcpmt);
      const required = SKIA_MSVC_STL_IMPORTS.filter((s) => skiaBytes.includes(s));
      const missing = required.filter((s) => !crtBytes.includes(s));
      if (missing.length > 0) {
        return fail(
          `${toolName} cannot satisfy skia.lib; ${libcpmt} lacks ${missing.join(', ')}`,
          'Update Visual Studio 2022 and install the latest MSVC v143 C++ x64/x86 build tools, '
          + `or rebuild the vendored dependencies with this toolset: \`vendor/provision/windows.ps1 -Arch ${libArch}\`.`,
        );
      }
      return ok(`${toolName}: ${libcpmt} satisfies ${required.length} Skia STL import(s)`);
    },
  },

  {
    id: 'vendor.skia.icu',
    title: 'Skia ICU data (icudtl.dat)',
    kind: 'hard',
    // Windows-only: on macOS ICU is reached through the vendored libicu.a, in
    // the same archive as everything else. A static Windows exe has no DLL
    // directory to fall back to, so SkLoadICU() probes the exe's own directory.
    applies: (c) => isNative(c) && onWindows() && linksSkia(c),
    run: (ctx) => {
      const dir = vendorLibDir(ctx, 'skia');
      if (dir === '') return skip(NO_TREE);
      const src = join(dir, 'icudtl.dat');
      if (!existsSync(src)) {
        return fail(
          `missing ${src}`,
          'Re-run `vendor/provision/windows.ps1 -Only skia` -- it copies icudtl.dat next to the '
          + 'Skia archives, and the compile-time step then deploys it beside the exe (build.ts::deploySkiaIcuData).',
        );
      }
      if (ctx.outDir === null) {
        // Present in vendor/, so the build-time deployment will work; the only
        // thing `--fix` could add is the copy next to an exe we were not told
        // the path of.
        return ok(`${src} (deployed beside the exe at build time)`);
      }
      const dest = join(ctx.outDir, 'icudtl.dat');
      if (!existsSync(dest)) {
        return fail(
          `present in vendor/, but not yet beside the output: ${dest}`,
          `Run \`as-aot doctor --fix\` to copy it, or just build -- the link step deploys it automatically.`,
          true,
        );
      }
      return ok(dest);
    },
  },

  {
    id: 'vendor.sdl2',
    title: 'SDL2 archives + headers',
    kind: 'hard',
    applies: (c) => isNative(c) && opensWindow(c),
    run: (ctx) => {
      const dir = vendorLibDir(ctx, 'sdl2');
      if (dir === '') return skip(NO_TREE);
      // Headers are per-platform too: SDL_config.h is generated per build.
      const key = onWindows() ? `windows-${ctx.cfg.architecture === '32' ? 'x86' : 'x64'}` : hostVendorKey();
      const lib = join(dir, onWindows() ? 'SDL2.lib' : 'libSDL2.a');
      const inc = join(ctx.vendorDir, 'sdl2', 'include', key, 'SDL2', 'SDL.h');
      const missing = [lib, inc].filter((p) => !existsSync(p));
      if (missing.length > 0) {
        return fail(
          `missing ${missing.join(', ')}`,
          provisionHint === ''
            ? 'This host has no provision recipe for SDL2.'
            : `Run \`${provisionHint}\` (the macOS recipe reports SDL2 as unbuildable -- its source tree is not kept).`,
        );
      }
      return ok(`${lib} + ${inc}`);
    },
  },

  {
    id: 'vendor.curl',
    title: 'curl stack (curl/nghttp2/zlib)',
    kind: 'hard',
    // Two independent reasons, which is why the trigger is not just "uses
    // flash.net": on Windows EVERY native build needs this tree, because
    // Windows has no system zlib while the generated C unconditionally
    // `#include <zlib.h>`s and links `-lz`.
    applies: (c) => isNative(c) && (usesTransport(c) || onWindows()),
    run: (ctx) => {
      const dir = vendorLibDir(ctx, 'curl');
      if (dir === '') return skip(NO_TREE);
      const header = join(ctx.vendorDir, 'curl', 'include', 'curl', 'curl.h');
      if (!existsSync(header)) {
        // Say WHY, not just what. The two triggers are unrelated -- a transport
        // needs the HTTP client, while a Windows build needs the very same tree
        // for zlib -- and a bare "missing curl.h" reads as a mistake when the
        // app never touched flash.net. Both can hold at once (a networked Windows
        // app), and then BOTH belong in the sentence: reporting only the zlib
        // half hides that the transport is what asked for the tree in the first
        // place, which is the one an app author can act on.
        const why = [
          ...(usesTransport(ctx)
            ? ['this app uses flash.net / URLRequest, so its build must link the HTTP transport']
            : []),
          ...(onWindows()
            ? ['a Windows native build takes zlib from the static curl tree (Windows has no system zlib, and the generated C includes <zlib.h> in every native build)']
            : []),
        ].join('; and ');
        return fail(
          `missing ${header} -- ${why}`,
          provisionHint === ''
            ? 'Build the curl stack for this host.'
            : (onWindows()
              ? `Run \`${provisionHint} -Only curl\` (it builds curl + nghttp2 + zlib together).`
              : 'Run `sh build-tools/curl-src/build-static.sh`, then deploy prefix/{include,lib} into vendor/curl/ '
                + '(vendor/provision/macos.sh does both).'),
        );
      }
      return ok(header);
    },
  },

  {
    id: 'vendor.audio',
    title: 'audio backend glue',
    kind: 'warn',
    // "The app uses flash.media" is the trigger, and it is exactly the signal the
    // config cannot state: the manifest only defines ASC_HAVE_AUDIO once a
    // backend IS linked, so a host with no backend would otherwise make this
    // check disappear -- the silent-drop failure mode, in the check table itself.
    applies: (c) => isNative(c) && (c.appUses?.audio === true || c.cfg.defines.includes('ASC_HAVE_AUDIO=1')),
    run: (ctx) => {
      const glue = join(ctx.vendorDir, 'audio_glue.c');
      const linked = ctx.cfg.defines.includes('ASC_HAVE_AUDIO=1');
      if (linked) {
        const backend = process.platform === 'darwin'
          ? 'CoreAudio'
          : process.platform === 'win32'
            ? 'WASAPI/DirectSound/WinMM'
            : 'whichever backend the glue was built with';
        return ok(`${glue} (backend: ${backend})`);
      }
      // Not linked, and the app wants audio. Three distinct reasons, and they
      // need three distinct answers: the glue is absent, the glue cannot serve
      // this host, or the glue is fine and the build simply never named it.
      if (!existsSync(glue)) {
        return fail(
          `missing ${glue}`,
          'The app uses flash.media; without the glue nothing plays (play() returns null, '
          + 'matching AIR\'s no-sound-card result). See docs/zh-cn/audio.md.',
        );
      }
      if (!AUDIO_GLUE_HOSTS.includes(process.platform)) {
        // A warning, not a hard failure: the build links and runs, the seam just
        // answers honestly. AIR itself returns null with no sound card.
        return fail(
          `${glue} exists, but it carries a backend for ${AUDIO_GLUE_HOSTS.join('/')} only, and this host is ${process.platform}`,
          'Provide a backend for this platform (docs/zh-cn/audio.md). Nothing will play until then.',
        );
      }
      // The glue is there and this host is one it was measured on: the manifest
      // just does not name it. Both halves are needed -- the source is what
      // carries MINIAUDIO_IMPLEMENTATION, the define is what turns the as_audio_*
      // seam into a real device (a source without the define still answers
      // honestly, which is why this is a warning rather than an error).
      return fail(
        `${glue} is available for this host, but this build does not link it`,
        `Add it to the manifest's sources and \`ASC_HAVE_AUDIO=1\` to its defines`
        + (process.platform === 'darwin' ? ', plus `CoreAudio`/`AudioToolbox` to frameworks' : '')
        + ' (docs/zh-cn/audio.md).',
      );
    },
  },

  {
    id: 'vendor.sqlite',
    title: 'SQLite engine',
    kind: 'hard',
    applies: (c) => isNative(c) && compilesSource(c, 'sqlite3.c'),
    run: (ctx) => {
      const engine = join(ctx.vendorDir, 'sqlite', 'sqlite3.c');
      const glue = join(ctx.vendorDir, 'sqlite_glue.c');
      const missing = [engine, glue].filter((p) => !existsSync(p));
      if (missing.length > 0) return fail(`missing ${missing.join(', ')}`, 'Both are tracked build inputs; restore them from git.');
      return ok(`${engine} + ${glue}`);
    },
  },

  {
    id: 'ane.hostlib',
    title: 'ANE host library (asaot)',
    kind: 'hard',
    applies: (c) => loadsExtension(c),
    run: (ctx) => {
      const platform = ctx.cfg.anePlatform !== '' ? ctx.cfg.anePlatform : anePlatformForBuild(ctx.cfg.architecture, ctx.cfg.target);
      if (platform === '') {
        return fail(
          `no AIR platform key for ${process.platform}/${process.arch}`,
          'Pass `--ane-platform <Windows-x86-64|Windows-x86|MacOS-x86-64|iPhone-ARM>` to name the target.',
        );
      }
      let dir: string;
      let hostName: string;
      try {
        dir = join(ctx.repoDir, 'lib', 'bin', aneHostDirName(platform));
        hostName = aneHostLibName(platform);
      } catch (e) {
        return fail(`no lib/bin/ host library for AIR platform '${platform}'`, String((e as Error).message));
      }
      // The name comes from the SAME function the build stages the file under, so
      // this check cannot disagree with what src/index.ts will look for. (It used to
      // probe three candidate names, which let a Windows key be satisfied by a
      // libasaot.so sitting in its directory -- a file no Windows loader can open.)
      const hostLib = join(dir, hostName);
      if (!existsSync(hostLib)) {
        return fail(
          `missing ${hostLib}`,
          'Build it first: `lib/build-asaot.bat` on Windows or `lib/build-asaot.sh` on macOS '
          + '(both need clang; the source is lib/asaot_host.c). A platform key whose host library has '
          + 'not been built has no host side to load, so --ane cannot work for it.',
        );
      }
      return ok(hostLib);
    },
  },

  // ---- configuration coherence ------------------------------------------
  {
    id: 'build.package-target',
    title: 'package / target pairing',
    kind: 'hard',
    // A configuration mistake rather than an environment one, but it is exactly
    // the kind of thing worth catching before a compile starts: the build would
    // report it anyway (index.ts), and both now say it from here.
    applies: () => true,
    run: ({ cfg }) => {
      if (cfg.package === 'web' && cfg.target !== 'wasm') {
        return fail(
          `--package web needs --target wasm (got --target ${cfg.target})`, 'A browser page is produced by emcc, which is a wasm backend. Add `--target wasm`.',
        );
      }
      if (cfg.package === 'xcode-project' && cfg.target !== 'native') {
        return fail(
          `--package xcode-project needs --target native (got --target ${cfg.target})`,
          'An .xcodeproj describes a native macOS .app; wasm has no Xcode target.',
        );
      }
      return ok(`${cfg.package} / ${cfg.target}`);
    },
  },

  // ---- toolchains, by target/package ------------------------------------
  {
    id: 'wasi.sdk',
    title: 'WASI toolchain',
    kind: 'hard',
    applies: (c) => c.cfg.target === 'wasm' && c.cfg.package !== 'web',
    run: ({ cfg }) => {
      const err = wasmToolchainError(cfg);
      if (err !== null) {
        return fail(
          err,
          'Install a WASI toolchain: WASI SDK (https://github.com/WebAssembly/wasi-sdk/releases) + '
          + '`WASI_SDK_HOME=/path/to/wasi-sdk`, or `brew install wasi-sdk`, or any clang with a '
          + 'wasm32-wasip1 backend and wasi-libc. `--dry` previews the command without one.',
        );
      }
      const home = process.env.WASI_SDK_HOME;
      return ok(home ? `${home}/bin/clang` : 'clang on PATH (no WASI_SDK_HOME set)');
    },
  },

  {
    id: 'wasi.libsetjmp',
    title: 'wasi-libc libsetjmp.a',
    kind: 'info',
    // Informational on purpose: its ABSENCE is not a failure. wasi-libc puts
    // setjmp/longjmp in a separate archive, so the build only adds -lsetjmp
    // when the sysroot has it; without it, a program that really throws still
    // fails loudly at link time (undefined __wasm_setjmp).
    applies: (c) => c.cfg.target === 'wasm',
    run: () => {
      const home = process.env.WASI_SDK_HOME;
      const p = home ? `${home}/share/wasi-sysroot/lib/wasm32-wasip1/libsetjmp.a` : '';
      if (p !== '' && existsSync(p)) return ok(p);
      return ok('not found -- -lsetjmp will not be added; a program using try/catch will fail at link time');
    },
  },

  {
    id: 'web.emsdk',
    title: 'Emscripten SDK',
    kind: 'hard',
    applies: (c) => c.cfg.package === 'web',
    run: () => {
      const err = webToolchainError();
      if (err !== null) {
        return fail(
          err,
          'Install an Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html) and set '
          + '`EMSDK_HOME=/path/to/emsdk`. `--dry` previews the command without one.',
        );
      }
      const home = process.env.EMSDK_HOME || process.env.EMSDK;
      return ok(home ? emccPath() : `${emccPath()} on PATH (no EMSDK_HOME set)`);
    },
  },

  // ---- release packaging -------------------------------------------------
  {
    id: 'release.mac-tools',
    title: 'macOS release tools',
    kind: 'hard',
    applies: (c) => (c.cfg.package === 'app' || c.cfg.package === 'dmg') && process.platform === 'darwin',
    run: ({ cfg }) => {
      const missing: string[] = [];
      for (const tool of ['codesign', ...(cfg.package === 'dmg' ? ['hdiutil'] : []), ...(Object.keys(cfg.airIcons).length > 0 ? ['iconutil'] : [])]) {
        const probe = spawnSync(tool, ['-h'], { encoding: 'utf8' });
        if (probe.error) missing.push(tool);
      }
      if (cfg.package === 'dmg') {
        const notary = spawnSync('xcrun', ['--find', 'notarytool'], { encoding: 'utf8' });
        if (notary.error || notary.status !== 0) missing.push('xcrun notarytool');
      }
      return missing.length === 0
        ? ok('codesign' + (cfg.package === 'dmg' ? ', hdiutil, notarytool' : '') + ' available')
        : fail(`missing release tools: ${missing.join(', ')}`, 'Install Xcode or the Command Line Tools (`xcode-select --install`).');
    },
  },
  {
    id: 'release.identity',
    title: 'Developer ID signing identity',
    kind: 'hard',
    applies: (c) => c.cfg.package === 'dmg' && process.platform === 'darwin',
    run: ({ cfg }) => {
      const identity = process.env.ASC_SIGN_IDENTITY || cfg.signingIdentity;
      if (!identity) return fail('no signing-identity configured', 'Set manifest signing-identity or ASC_SIGN_IDENTITY to a Developer ID Application identity.');
      const probe = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0 || !(probe.stdout || '').includes(identity)) {
        return fail(`identity not found in the login keychain: ${identity}`, 'Install the Developer ID Application certificate and its private key, or select another identity.');
      }
      return ok(identity);
    },
  },
  {
    id: 'release.notary-profile',
    title: 'notarytool keychain profile',
    kind: 'hard',
    applies: (c) => c.cfg.package === 'dmg' && process.platform === 'darwin',
    run: ({ cfg }) => {
      const profile = process.env.ASC_NOTARY_PROFILE || cfg.notaryProfile;
      if (!profile) return fail('no notary-profile configured', 'Run `xcrun notarytool store-credentials <profile> ...`, then set manifest notary-profile or ASC_NOTARY_PROFILE.');
      // Offline keychain query; `notarytool history` would contact Apple and is
      // deliberately not part of doctor's default, no-network checks.
      const probe = spawnSync('security', ['find-generic-password', '-a', profile, '-s', 'com.apple.gke.notary.tool'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) {
        return fail(`keychain profile not found: ${profile}`, 'Run `xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific-password>`.');
      }
      return ok(`keychain profile ${profile}`);
    },
  },
  {
    id: 'release.windows-tools',
    title: 'Windows resource/signing tools',
    kind: 'hard',
    applies: (c) => c.cfg.package === 'exe' && process.platform === 'win32',
    run: ({ cfg }) => {
      const rc = spawnSync('llvm-rc', ['--version'], { encoding: 'utf8' });
      if (rc.error) return fail('llvm-rc not found on PATH', 'Install LLVM (or add its bin directory to PATH).');
      if (cfg.signingIdentity || process.env.ASC_SIGN_IDENTITY || process.env.ASC_WIN_CERT_FILE) {
        const sign = spawnSync('where', ['signtool'], { encoding: 'utf8' });
        if (sign.error || sign.status !== 0) return fail('signtool not found on PATH', 'Install the Windows SDK and add its bin directory to PATH.');
      }
      return ok('llvm-rc available' + ((cfg.signingIdentity || process.env.ASC_WIN_CERT_FILE) ? ', signtool available' : ''));
    },
  },

  // ---- optional reference tools -----------------------------------------
  {
    id: 'airsdk.adl',
    title: 'AIR SDK reference runtime (adl)',
    kind: 'info',
    // Not needed to build anything: adl is the oracle we measure AIR semantics
    // against, so its absence changes what a developer can VERIFY, not what
    // they can build.
    applies: () => true,
    run: () => {
      const home = process.env.AIRSDK_HOME;
      if (!home) return ok('AIRSDK_HOME is not set (only needed to compare behaviour against adl)');
      const adl = `${home}/bin/adl`;
      const mxmlc = `${home}/bin/mxmlc`;
      return ok([adl, mxmlc].map((p) => `${p}${existsSync(p) ? '' : ' (missing)'}`).join(', '));
    },
  },
];

// ---------------------------------------------------------------------------
// Running them.

export function runChecks(ctx: CheckCtx, only?: readonly string[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const c of CHECKS) {
    if (only !== undefined && only.length > 0 && !only.includes(c.id)) continue;
    if (!c.applies(ctx)) continue;
    let outcome: CheckOutcome;
    try {
      outcome = c.run(ctx);
    } catch (e) {
      // A probe that throws is a failed check, not a crashed doctor: the whole
      // point is to report, so an exception here would defeat it.
      outcome = { status: 'fail', detail: `probe threw: ${(e as Error).message}` };
    }
    out.push({ id: c.id, title: c.title, kind: c.kind, ...outcome });
  }
  return out;
}

// Does one build-relevant check pass? Used by the build path so a missing
// dependency fails with the same sentence `as-aot doctor` prints, instead of a
// second hand-written message that can drift from it.
//
// Returns null when the check passed or does not apply, otherwise the message
// to throw. `kind: 'warn'` checks never make this fire -- they describe output
// that is wrong but buildable, and index.ts prints them as warnings.
export function requireCheck(id: string, ctx: CheckCtx): string | null {
  const r = outcomeFor(id, ctx);
  if (r === null) return null;
  if (r.outcome.status !== 'fail' || r.def.kind !== 'hard') return null;
  return r.outcome.fix === undefined ? r.outcome.detail : `${r.outcome.detail}\n\n${r.outcome.fix}`;
}

// The same failure text for a check of ANY kind, for callers that collect
// warnings instead of throwing (air-app.ts returns its advisories rather than
// failing the build -- the seam answers honestly, the output is just incomplete).
export function checkFailure(id: string, ctx: CheckCtx): string | null {
  const r = outcomeFor(id, ctx);
  if (r === null || r.outcome.status !== 'fail') return null;
  return r.outcome.fix === undefined ? r.outcome.detail : `${r.outcome.detail}\n${r.outcome.fix}`;
}

function outcomeFor(id: string, ctx: CheckCtx): { def: Check; outcome: CheckOutcome } | null {
  const def = CHECKS.find((c) => c.id === id);
  if (def === undefined) throw new Error(`no such check: ${id}`);
  if (!def.applies(ctx)) return null;
  try {
    return { def, outcome: def.run(ctx) };
  } catch (e) {
    return { def, outcome: { status: 'fail', detail: `probe threw: ${(e as Error).message}` } };
  }
}
