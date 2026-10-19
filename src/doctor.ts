// Doctor: renders the checks in src/checks.ts as a report.
//
// This is a RENDERER, not a second opinion. `as-aot doctor` and the build paths
// read the same table, so "doctor says everything is fine but the build fails"
// should not be a reachable state -- if it were, the table would be missing a
// check, which is a bug in one place rather than a divergence between two.
//
// Exit codes are what make it usable from CI:
//   0  nothing that blocks the requested build
//   1  at least one hard check failed
//   2  only warnings (the build works, the output would be wrong)
//
// `--fix` is deliberately a whitelist, and today it holds exactly one entry:
// deploying icudtl.dat beside an output path. Everything else is either
// expensive (a 30-60 minute dependency build), a change to the machine
// (installing a toolchain), or both -- and a doctor that silently performs
// those has stopped reporting and started deciding. Those checks print a
// command to copy instead.
//
// `--check-update` is the one thing here that touches the network, and it keeps
// the same posture: it is opt-in, READ-ONLY (it prints the upgrade command and
// never installs anything), and it never moves the exit code -- 0/1/2 mean
// build-readiness, and a machine that merely cannot reach the registry is still
// one that can build. A failed check is a reported status, never a throw.

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildConfig } from './build.ts';
import { runChecks, vendorLibDir, type CheckCtx, type CheckResult } from './checks.ts';

export interface DoctorOptions {
  cfg: BuildConfig;
  // Absolute .../as3compiler
  repoDir: string;
  // Absolute .../as3compiler/vendor
  vendorDir: string;
  // `-o`'s directory, when one was given (only `--fix` needs it).
  outDir: string | null;
  json: boolean;
  fix: boolean;
  verbose: boolean;
  // The compiler's own version, read from package.json by index.ts -- this module
  // is a renderer and does not go looking for files. '' when it cannot be read.
  version: string;
  // `--check-update`'s outcome, or null when the flag was not given. Null and a
  // failed check are different states on purpose: "not asked" must not read as
  // "asked, could not reach the registry".
  update: UpdateStatus | null;
}

// What `--check-update` found. `latest`/`upToDate` are null on failure with
// `error` carrying the reason, because a check that cannot complete is a status
// to report rather than an exception to raise.
//
export interface UpdateStatus {
  current: string;
  latest: string | null;
  upToDate: boolean | null;
  error: string | null;
}

// Long enough for a slow registry, short enough that a machine with no route out
// is not left waiting: a report that hangs is worse than one that says it could
// not reach the registry.
const UPDATE_TIMEOUT_MS = 3000;

// Only x.y.z is ever published. A prerelease suffix (0.5.0-beta.1) must not read
// as newer than the release it precedes, so the suffix is dropped before
// comparing; ordering *within* a prerelease series is not something this check
// needs to know about.
//
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// undici reports every transport failure as a bare "fetch failed" and hangs the
// real reason on `cause` (ECONNREFUSED, ENOTFOUND, an aborted timeout). "fetch
// failed" on its own tells a user nothing about whether they are offline or
// behind a proxy that needs configuring, so the cause is what gets reported.
//
function fetchErrorReason(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return err instanceof Error && err.message !== '' ? err.message : String(err);
}

// `registryBase` is resolved by the caller from `npm_config_registry`, i.e. the
// registry this machine's npm would install from -- so a corporate mirror is
// honoured instead of us hard-coding npmjs (and it is what makes the check
// testable against a local server).
//
export async function checkForUpdate(current: string, registryBase: string): Promise<UpdateStatus> {
  const fail = (error: string): UpdateStatus => ({ current, latest: null, upToDate: null, error });
  if (current === '') return fail('this build reports no version');
  let res: Response;
  try {
    res = await fetch(`${registryBase}/as3compiler/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(fetchErrorReason(err));
  }
  if (!res.ok) return fail(`HTTP ${res.status} from ${registryBase}`);
  let latest = '';
  try {
    const body = (await res.json()) as { version?: unknown };
    latest = typeof body.version === 'string' ? body.version : '';
  } catch {
    return fail(`unreadable response from ${registryBase}`);
  }
  if (latest === '') return fail(`no version in the response from ${registryBase}`);
  return { current, latest, upToDate: compareVersions(latest, current) <= 0, error: null };
}

// Plain text on purpose (the caller picks the colour): a piped or --json report
// can be compared against these strings verbatim.
//
export function describeUpdate(s: UpdateStatus): string {
  const mine = s.current === '' ? 'this build' : s.current;
  if (s.latest === null) return `could not check for a newer release (${s.error})`;
  if (s.upToDate === true) return `up to date: ${mine} is the latest published release`;
  return `a newer release is available: ${mine} -> ${s.latest}; upgrade with: npm i -g as3compiler@latest`;
}

// Colour only when a human is watching: piping to a file or a test harness must
// not get escape codes. Matches how index.ts emits its warnings.
const tty = process.stderr.isTTY === true;
const paint = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

const GLYPH: Record<CheckResult['status'], string> = {
  ok: 'ok  ',
  fail: 'FAIL',
  skip: '... ',
};

function decorate(r: CheckResult): string {
  if (r.status === 'fail') return r.kind === 'warn' ? paint('33', GLYPH.fail) : paint('31', GLYPH.fail);
  if (r.status === 'ok') return paint('32', GLYPH.ok);
  return paint('90', GLYPH.skip);
}

// Column width for the id, so the detail column starts at the same place. Fixed
// rather than computed so the report does not reflow when a new check with a
// longer id is added.
const ID_W = 22;

function describeConfig(cfg: BuildConfig): string {
  const bits = [`target ${cfg.target}`, `package ${cfg.package}`];
  if (cfg.linkLibs.includes('skia')) bits.push('skia');
  if (cfg.defines.includes('ASC_USE_WINDOW=1')) bits.push('window');
  if (cfg.defines.includes('ASC_HAVE_CURL=1')) bits.push('transport');
  if (cfg.defines.includes('ASC_HAVE_FRE=1')) bits.push('ane');
  if (cfg.architecture !== '') bits.push(`arch ${cfg.architecture}`);
  return bits.join(' | ');
}

// The single `--fix` action. Guarded on the same directory the check resolved,
// so it cannot write somewhere the check did not look.
function fixIcuData(ctx: CheckCtx, outDir: string | null): string | null {
  const dir = vendorLibDir(ctx, 'skia');
  if (dir === '') return null;
  const src = join(dir, 'icudtl.dat');
  if (!existsSync(src)) return null;
  if (outDir === null) return null;
  const dest = join(outDir, 'icudtl.dat');
  copyFileSync(src, dest);
  return dest;
}

export function runDoctor(opts: DoctorOptions): number {
  const ctx: CheckCtx = { cfg: opts.cfg, vendorDir: opts.vendorDir, repoDir: opts.repoDir, outDir: opts.outDir };

  let results = runChecks(ctx);

  if (opts.fix) {
    const fails = results.filter((r) => r.status === 'fail');
    const before = fails.filter((r) => r.fixable);
    if (before.length === 0) {
      // Distinguish "everything passed" from "things failed but none of them are
      // mine to fix" -- the second is the interesting case and reads as a bug if
      // it looks like the first.
      if (!opts.json && fails.length > 0) {
        console.log(`nothing here is auto-fixable (${fails.length} failing check(s), all needing a command you run).`);
      }
    } else {
      for (const r of before) {
        if (r.id === 'vendor.skia.icu') {
          const dest = fixIcuData(ctx, opts.outDir);
          if (!opts.json) {
            console.log(dest === null
              ? paint('33', `  could not fix ${r.id}: no -o <path> given, or no icudtl.dat in vendor/`)
              : `  fixed ${r.id}: icudtl.dat -> ${dest}`);
          }
        } else if (!opts.json) {
          // Nothing else is whitelisted: say so rather than pretending.
          console.log(paint('33', `  ${r.id} is not in the --fix whitelist`));
        }
      }
      results = runChecks(ctx);
    }
  }

  const hardFails = results.filter((r) => r.status === 'fail' && r.kind === 'hard');
  const warns = results.filter((r) => r.status === 'fail' && r.kind === 'warn');
  const code = hardFails.length > 0 ? 1 : warns.length > 0 ? 2 : 0;

  if (opts.json) {
    // `--json` must stay ONE parseable object even with --check-update, so the
    // update result goes in here rather than as a line beside the JSON.
    const report: Record<string, unknown> = {
      compiler: { name: 'as3compiler', version: opts.version === '' ? null : opts.version },
      host: { platform: process.platform, arch: process.arch, node: process.version },
      config: opts.cfg,
      checks: results,
      summary: { hard: hardFails.length, warn: warns.length, ok: results.filter((r) => r.status === 'ok').length },
      exitCode: code,
    };
    // Present only when asked for: an absent key says "not checked", which a
    // consumer has to be able to tell apart from "checked, unreachable".
    if (opts.update !== null) report.update = opts.update;
    console.log(JSON.stringify(report, null, 2));
    return code;
  }

  console.log(`as-aot doctor -- ${opts.version === '' ? 'version unknown' : opts.version} ${process.platform}/${process.arch}, node ${process.version}`);
  console.log(paint('90', `config: ${describeConfig(opts.cfg)}`));
  if (opts.verbose) {
    // The resolved directories matter when the answer is surprising (e.g. "no
    // tree for this host"): they show what was actually probed.
    console.log(paint('90', `repoDir:   ${opts.repoDir}`));
    console.log(paint('90', `vendorDir: ${opts.vendorDir}`));
    console.log(paint('90', `outDir:    ${opts.outDir ?? '(none -- no -o given)'}`));
  }
  console.log('');

  if (results.length === 0) {
    console.log('no checks apply to this configuration.');
    return code;
  }

  for (const r of results) {
    console.log(`[${decorate(r)}] ${r.id.padEnd(ID_W)} ${r.detail}`);
    if (r.status === 'fail' && r.fix !== undefined) {
      // Indent the remedy under its check so a long fix text (several of these
      // are two lines) stays visually attached to what it fixes.
      for (const line of r.fix.split('\n')) console.log(`${' '.repeat(7)}${paint('90', line)}`);
    }
  }

  console.log('');
  if (code === 0) {
    console.log(paint('32', `all ${results.length} checks passed.`));
  } else if (code === 1) {
    console.log(paint('31', `${hardFails.length} hard check(s) failed`) + ' -- this build cannot succeed as asked.');
  } else {
    console.log(paint('33', `${warns.length} warning(s)`) + ' -- the build will succeed, but the output will be wrong.');
  }
  if (code !== 0) {
    console.log(paint('90', 'Constructs that need a toolchain or a dependency build are never run by --fix; ' +
      'the command to run is printed above each failure.'));
  }
  // Last, and deliberately outside the check table: whether a newer release
  // exists is not a build requirement, and it must not read as one.
  if (opts.update !== null) {
    const u = opts.update;
    console.log('');
    console.log(paint(u.upToDate === true ? '32' : u.upToDate === false ? '33' : '90', describeUpdate(u)));
  }
  return code;
}
