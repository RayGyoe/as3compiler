// What the `doctor` tool's check table has to guarantee, and what makes that
// table worth having: the BUILD path and the report must read the same rules.
//
// The temptation this pins against is duplication. Every requirement here --
// the curl tree, the audio backend, an ANE host library, a wasi/emcc toolchain --
// used to be a hand-written `throw` in index.ts or air-app.ts, with wording that
// could (and did) drift from what `as-aot doctor` says about the same machine.
// The single-source group asserts the throws are gone and the checks are actually
// called; the behaviour group drives the checks directly, against an empty vendor
// tree, so those assertions are about what the code DOES rather than how it reads.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, registerGroup } from '../harness.ts';
import { AUDIO_GLUE_HOSTS, checkFailure, requireCheck, type CheckCtx } from '../../src/checks.ts';
import { defaultBuildConfig, type BuildConfig } from '../../src/build.ts';

const readSrc = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

// A directory with nothing in it. Tests that need "the check fires" get their
// evidence from here rather than from a real missing dependency, so they cannot
// start passing by accident on a machine that happens to have (or lack) something.
const emptyDir = (): string => mkdtempSync(join(tmpdir(), 'asc-doctor-'));

function ctxWith(
  cfg: Partial<BuildConfig>,
  opts: { vendorDir?: string; repoDir?: string; appUses?: CheckCtx['appUses'] } = {},
): CheckCtx {
  return {
    cfg: { ...defaultBuildConfig(), ...cfg },
    vendorDir: opts.vendorDir ?? emptyDir(),
    repoDir: opts.repoDir ?? emptyDir(),
    outDir: null,
    appUses: opts.appUses,
  };
}

// The check ids a source file names, in call order. Two one-line helpers rather
// than one parameterised by the call name: the regex literals differ, and a
// four-link `.concat` chain inside a return-annotated arrow trips Node's
// type-stripper ("Expected a semicolon", measured on node v24.14.1) -- not worth
// keeping in a test.
const idsRequireCheck = (src: string): string[] => [...src.matchAll(/requireCheck\('([^']+)'/g)].map((m) => m[1]);
const idsCheckFailure = (src: string): string[] => [...src.matchAll(/checkFailure\('([^']+)'/g)].map((m) => m[1]);

function checkSingleSourceOfTruth(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [doctor] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [doctor] ${label}`); }
  };
  const airApp = readSrc('src/air-app.ts');
  const index = readSrc('src/index.ts');
  const checksSrc = readSrc('src/checks.ts');

  // The four messages now live in ONE place. Each of these greps is the exact
  // shape the duplicate used to have, so reintroducing it turns this red.
  check('air-app no longer hand-writes the curl error',
    !airApp.includes('so its build must link the HTTP transport')
    && !/if \(needsCurlTree && !existsSync\(curlHeader\)\)/.test(airApp));
  check('air-app no longer hand-writes the audio no-backend warning',
    !airApp.includes('this native build has no audio backend available'));
  check('air-app reads the requirement from the check table instead',
    idsRequireCheck(airApp).includes('vendor.curl') && idsCheckFailure(airApp).includes('vendor.audio'));
  check('air-app judges the config it will actually consume (not a second description of it)',
    /applyManifest\(defaultBuildConfig\(\), generated as Manifest/.test(airApp));

  check('index.ts no longer hand-writes the wasi / emcc / ANE errors',
    !index.includes('Install a WASI toolchain to produce .wasm output')
    && !index.includes('Install an Emscripten SDK to produce browser output')
    && !index.includes('asaot.dll is missing from'));
  check('index.ts imports no dead toolchain-error helpers',
    !/import \{[^}]*\bwasmToolchainError\b/.test(index)
    && !/import \{[^}]*\bwebToolchainError\b/.test(index));
  check('index.ts enforces them through the same table',
    ['wasi.sdk', 'web.emsdk', 'ane.hostlib', 'build.package-target']
      .every((id) => idsRequireCheck(index).includes(id)));
  check('...and the CLI-level flash.media hint borrows the check\'s wording too',
    idsCheckFailure(index).includes('vendor.audio'));

  // `buildCheckCtx` is the seam that keeps the two callers pointing at the same
  // vendor/ tree. Two derivations of that path is how a doctor ends up judging a
  // different tree than the build reads.
  check('one place derives repoDir/vendorDir for the build path',
    /function repoPaths\(\)/.test(index)
    && (index.match(/resolve\(repoDir, 'vendor'\)/g) ?? []).length === 1);

  const usedIds = [
    ...idsRequireCheck(index), ...idsRequireCheck(airApp),
    ...idsCheckFailure(airApp), ...idsCheckFailure(index),
  ];
  const knownIds = [...checksSrc.matchAll(/^ {4}id: '([^']+)',$/gm)].map((m) => m[1]);
  check('the check ids the build path names all exist in the table',
    usedIds.length >= 6 && usedIds.every((id) => knownIds.includes(id)));
  check('the build path enforces exactly the absorbed requirements, no more and no fewer',
    [...new Set(usedIds)].sort().join(',')
      === 'ane.hostlib,build.package-target,vendor.audio,vendor.curl,wasi.sdk,web.emsdk');

  // `doctor --fix` must not claim "nothing is auto-fixable" on a run where
  // nothing failed -- that reads as "there is a problem and I cannot fix it",
  // which is the opposite of "all N checks passed".
  check('the --fix message distinguishes "all passed" from "failed, none fixable"',
    /if \(!opts\.json && fails\.length > 0\)/.test(readSrc('src/doctor.ts'))
    && readSrc('src/doctor.ts').includes('nothing here is auto-fixable (${fails.length} failing check(s)'));

  if (ok > 0) console.log(`[doctor] ${ok} single-source-of-truth checks passed`);
  return bad;
}

function checkCheckBehaviour(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [doctor] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [doctor] ${label}`); }
  };

  // ---- vendor.curl -------------------------------------------------------
  // Fires for a networking native build, and says WHY: the transport is the
  // reason, not "curl is nice to have".
  const noCurlNet = requireCheck('vendor.curl', ctxWith({ defines: ['ASC_HAVE_CURL=1'] }));
  check('a networking native build without the curl tree is refused, naming the transport',
    noCurlNet !== null && noCurlNet.includes('flash.net') && noCurlNet.includes('curl.h'));
  // A plain build asks for the tree only where the host has no system zlib: on
  // macOS it must NOT fire (pushing curl's headers and -L would link a vendored
  // curl into an app that never asked for one -- over-firing is what makes the
  // check useless), while on Windows it deliberately DOES fire (see the zlib
  // reason below). One check, two hosts, both asserted.
  check(process.platform === 'win32'
    ? 'a plain Windows build IS asked for the tree, for zlib only'
    : 'a plain macOS build is not asked for curl at all',
    process.platform === 'win32'
      ? (requireCheck('vendor.curl', ctxWith({})) ?? '').includes('zlib')
      : requireCheck('vendor.curl', ctxWith({})) === null);
  // The Windows reason is zlib, not networking -- a different sentence for the
  // same missing file, which is exactly why the message is assembled at run time.
  const winReason = requireCheck('vendor.curl', ctxWith({})) ?? '';
  check('the Windows reason is zlib (a build-time need, not an app request)',
    process.platform !== 'win32' || winReason.includes('zlib'));
  // ...and a networked Windows build carries BOTH reasons: only the zlib half was
  // reported before, which hid the one an app author can act on.
  check('a networked Windows build names zlib AND the transport',
    process.platform !== 'win32'
      || ((noCurlNet ?? '').includes('zlib') && (noCurlNet ?? '').includes('flash.net')));

  // ---- vendor.audio ------------------------------------------------------
  // warn-kind, so it must never reach requireCheck: a missing backend is a build
  // that links and runs, not one to refuse.
  const audioUsed = { appUses: { audio: true } };
  check('the audio gap is a warning, never a hard failure',
    requireCheck('vendor.audio', ctxWith({}, audioUsed)) === null);
  // The signal the manifest CANNOT carry: it defines ASC_HAVE_AUDIO only once a
  // backend is linked, so without appUses the check would silently vanish for the
  // exact case it exists for. The REAL vendor dir here on purpose -- this branch
  // is "the glue is there and this host can use it, the build just never named
  // it", which an empty tree cannot reach (that is the "missing glue" branch).
  const gap = checkFailure('vendor.audio', ctxWith({}, { ...audioUsed, vendorDir: join(root, 'vendor') }));
  check('the gap is reported when the app uses audio and no backend is linked',
    gap !== null && gap.includes('link it'));
  check('...and is NOT reported when nothing says the app uses audio',
    checkFailure('vendor.audio', ctxWith({})) === null);
  check('a linked backend is reported as ok (no gap) with its backend named',
    checkFailure('vendor.audio', ctxWith({ defines: ['ASC_HAVE_AUDIO=1'] })) === null
    && readSrc('src/checks.ts').includes("'CoreAudio'"));
  check('the host list is one exported constant, shared with air-app',
    AUDIO_GLUE_HOSTS.length === 2 && AUDIO_GLUE_HOSTS.join(',') === 'darwin,win32'
    && readSrc('src/air-app.ts').includes('AUDIO_GLUE_HOSTS.includes(process.platform)'));

  // ---- ane.hostlib -------------------------------------------------------
  const aneCfg = { defines: ['ASC_HAVE_FRE=1'], anePlatform: 'Windows-x86-64' };
  const noHost = requireCheck('ane.hostlib', ctxWith(aneCfg)) ?? '';
  check('loading an extension with no host library in the tree is refused',
    noHost.includes('asaot'));
  check('...with the documented build command, not just the missing path',
    noHost.includes('lib/build-asaot.bat'));
  check('a build that loads no extension is not asked for a host library',
    requireCheck('ane.hostlib', ctxWith({ anePlatform: 'Windows-x86-64' })) === null);

  // ---- build.package-target ---------------------------------------------
  const badPair = requireCheck('build.package-target', ctxWith({ package: 'web', target: 'native' })) ?? '';
  check('--package web without --target wasm is refused, naming both halves',
    badPair.includes('--target wasm'));
  check('the matching pair is clean',
    requireCheck('build.package-target', ctxWith({ package: 'web', target: 'wasm' })) === null);

  // ---- doctor's own honesty ---------------------------------------------
  let threw = false;
  try { requireCheck('no.such.check', ctxWith({})); } catch { threw = true; }
  check('an unknown check id throws instead of passing silently', threw);
  // A vendor.skia check against an empty tree: the required archive is absent,
  // which must arrive as a failure naming the file, never as a silent pass.
  const noSkia = requireCheck('vendor.skia', ctxWith({ linkLibs: ['skia'] })) ?? '';
  check('a genuinely missing dependency is a failure that names the file',
    // The archive name is per host (vendor/provision ships skia.lib for MSVC and
    // libskia.a elsewhere, see src/checks.ts's own onWindows() split).
    noSkia.includes(process.platform === 'win32' ? 'skia.lib' : 'libskia.a'));
  // ...and it does not fire for a build that links no Skia at all, which is what
  // keeps it usable as a gate rather than as noise on every offscreen build.
  check('a build that links no Skia is not asked for the archives',
    requireCheck('vendor.skia', ctxWith({})) === null);

  if (ok > 0) console.log(`[doctor] ${ok} check-behaviour checks passed`);
  return bad;
}

registerGroup('unit: doctor/SingleSourceOfTruth', checkSingleSourceOfTruth);
registerGroup('unit: doctor/CheckBehaviour', checkCheckBehaviour);
