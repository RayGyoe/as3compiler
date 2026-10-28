// Release packaging: command-line signing, notarization and disk-image steps.
// No AS3 semantics live here; every external tool receives an argv array, never
// a shell command assembled from manifest text.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BuildConfig } from './build.ts';
import type { MacAppLayout } from './app-bundle.ts';

export interface ReleaseCommandResult {
  stdout: string;
  stderr: string;
}

// One runner for every release tool so dry-run output, failures and timeouts
// have the same shape. Password-bearing Windows commands use their own runner
// in windows-release.ts, which redacts before calling this level's formatting.
export function formatCommand(argv: readonly string[]): string {
  return argv.map((a) => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' ');
}

export function runReleaseCommand(argv: readonly string[], dry = false, timeoutMs = 120_000): ReleaseCommandResult {
  console.log(`[release] ${dry ? 'dry-run ' : ''}${formatCommand(argv)}`);
  if (dry) return { stdout: '', stderr: '' };
  const res = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`release tool '${argv[0]}' could not run (${code}): ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`release tool failed (${res.status ?? 'signal'}): ${formatCommand(argv)}`);
  }
  return { stdout, stderr };
}

export function effectiveSigningIdentity(configured: string): string {
  return process.env.ASC_SIGN_IDENTITY || configured;
}

export function effectiveNotaryProfile(configured: string): string {
  return process.env.ASC_NOTARY_PROFILE || configured;
}

// Parse notarytool's JSON when available, while preserving Apple's own output
// verbatim on failure. An Accepted result is the only successful outcome.
export function notaryAccepted(output: string): boolean {
  try {
    const value = JSON.parse(output) as { status?: unknown };
    return value.status === 'Accepted';
  } catch {
    // We explicitly request --output-format json. A successful process exit with
    // missing/malformed JSON is not proof of Apple's Accepted status.
    return false;
  }
}

export interface MacDmgCredentials {
  identity: string;
  profile: string;
}

export function requireMacDmgCredentials(cfg: BuildConfig): MacDmgCredentials {
  const identity = effectiveSigningIdentity(cfg.signingIdentity);
  const profile = effectiveNotaryProfile(cfg.notaryProfile);
  const missing: string[] = [];
  if (!identity) missing.push("'signing-identity' (or ASC_SIGN_IDENTITY)");
  if (!profile) missing.push("'notary-profile' (or ASC_NOTARY_PROFILE)");
  if (missing.length > 0) {
    throw new Error(
      `--package dmg requires ${missing.join(' and ')}.\n` +
      "  use a Developer ID Application identity; store notarization credentials once with:\n" +
      '  xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific-password>'
    );
  }
  return { identity, profile };
}

// Native images nested in a bundle must be signed before their enclosing app.
// Sorted deepest-first so a nested framework/app never inherits a stale seal.
export function nestedNativeImages(appPath: string): string[] {
  const found: string[] = [];
  const suffix = /\.(dylib|so|framework|appex|xpc|app)$/i;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (suffix.test(entry.name) || basename(path) === 'extensions') found.push(child);
        walk(child);
      } else if (entry.isFile() && /\.(dylib|so)$/i.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk(appPath);
  return found.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length || a.localeCompare(b));
}

export function macAppSignCommands(cfg: BuildConfig, appPath: string, identity: string, nested: readonly string[] = []): string[][] {
  const commands: string[][] = [];
  for (const image of nested) {
    commands.push(['codesign', '--force', '--options', 'runtime', '--timestamp', '--sign', identity, image]);
  }
  const outer = ['codesign', '--force', '--options', 'runtime', '--timestamp'];
  if (cfg.entitlements) outer.push('--entitlements', cfg.entitlements);
  outer.push('--sign', identity, appPath);
  commands.push(outer);
  commands.push(['codesign', '--verify', '--deep', '--strict', '--verbose=2', appPath]);
  return commands;
}

function notarize(path: string, profile: string, dry: boolean): void {
  const result = runReleaseCommand([
    'xcrun', 'notarytool', 'submit', path,
    '--keychain-profile', profile, '--wait', '--output-format', 'json',
  ], dry, 30 * 60 * 1000);
  if (!dry && !notaryAccepted(result.stdout)) {
    throw new Error(`notarization was not Accepted for ${path}: ${result.stdout}`);
  }
}

function staple(path: string, dry: boolean): void {
  runReleaseCommand(['xcrun', 'stapler', 'staple', path], dry);
  runReleaseCommand(['xcrun', 'stapler', 'validate', path], dry);
}

// Full Developer-ID release path. The already-compiled executable lives inside
// layout.appPath; no compiler invocation is repeated here.
export function packageMacDmg(cfg: BuildConfig, base: string, layout: MacAppLayout, dry = false): string {
  const credentials = requireMacDmgCredentials(cfg);
  const version = layout.version;
  const dmgPath = `${base}-${version}.dmg`;
  const zipPath = `${base}-notary.zip`;
  const staging = `${base}.dmg-staging`;
  const mountPoint = `${base}.dmg-mount`;
  const nested = dry ? [] : nestedNativeImages(layout.appPath);
  for (const command of macAppSignCommands(cfg, layout.appPath, credentials.identity, nested)) {
    runReleaseCommand(command, dry);
  }

  runReleaseCommand(['ditto', '-c', '-k', '--keepParent', layout.appPath, zipPath], dry);
  notarize(zipPath, credentials.profile, dry);
  staple(layout.appPath, dry);

  if (dry) console.log(`[release] dry-run staging ${layout.appPath} + /Applications -> ${staging}`);
  else {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(layout.appPath, join(staging, `${layout.productName}.app`), { recursive: true });
    symlinkSync('/Applications', join(staging, 'Applications'));
  }
  runReleaseCommand([
    'hdiutil', 'create', '-volname', cfg.displayName || layout.productName,
    '-srcfolder', staging, '-ov', '-format', 'UDZO', dmgPath,
  ], dry);
  runReleaseCommand(['codesign', '--force', '--timestamp', '--sign', credentials.identity, dmgPath], dry);
  notarize(dmgPath, credentials.profile, dry);
  staple(dmgPath, dry);
  runReleaseCommand(['spctl', '-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmgPath], dry);

  if (dry) {
    runReleaseCommand(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath], true);
    runReleaseCommand(['spctl', '-a', '-t', 'exec', '-vv', join(mountPoint, `${layout.productName}.app`)], true);
    runReleaseCommand(['hdiutil', 'detach', mountPoint], true);
  } else {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(mountPoint)) throw new Error(`DMG verification mount point already exists: ${mountPoint}`);
    mkdirSync(mountPoint, { recursive: true });
    let attached = false;
    try {
      runReleaseCommand(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
      attached = true;
      runReleaseCommand(['spctl', '-a', '-t', 'exec', '-vv', join(mountPoint, `${layout.productName}.app`)]);
    } finally {
      if (attached) runReleaseCommand(['hdiutil', 'detach', mountPoint]);
      rmSync(mountPoint, { recursive: true, force: true });
    }
    rmSync(zipPath, { force: true });
  }
  return dmgPath;
}
