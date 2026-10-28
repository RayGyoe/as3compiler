// macOS .app bundle construction shared by script packaging and release tests.
// The Xcode generator deliberately keeps its build-setting-based Info.plist.

import { basename, join } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { BuildConfig } from './build.ts';
import { nestedNativeImages, runReleaseCommand } from './release.ts';

export interface MacAppLayout {
  productName: string;
  appPath: string;
  contentsPath: string;
  binaryPath: string;
  resourcesPath: string;
  plistPath: string;
  iconPath: string;
  version: string;
  buildVersion: string;
}

export interface MacPlistOptions {
  executable: string | null;
  bundleId: string;
  displayName: string;
  version: string;
  buildVersion: string;
  deploymentTarget: string;
  iconName: string | null;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Concrete values, unlike xcode-project's $(EXECUTABLE_NAME) placeholders: a
// script-built bundle has no Xcode build-settings pass to substitute them.
export function appInfoPlist(options: MacPlistOptions): string {
  const entries: Array<[string, string]> = [
    ['CFBundleDevelopmentRegion', 'en'],
    ['CFBundleIdentifier', options.bundleId],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', options.displayName],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', options.version],
    ['CFBundleVersion', options.buildVersion],
  ];
  if (options.executable !== null) entries.splice(1, 0, ['CFBundleExecutable', options.executable]);
  if (options.deploymentTarget) entries.push(['LSMinimumSystemVersion', options.deploymentTarget]);
  if (options.iconName !== null) entries.push(['CFBundleIconFile', options.iconName]);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
  ];
  for (const [key, value] of entries) lines.push(`\t<key>${key}</key>`, `\t<string>${xml(value)}</string>`);
  lines.push('\t<key>NSHighResolutionCapable</key>', '\t<true/>', '</dict>', '</plist>', '');
  return lines.join('\n');
}

export function macAppLayout(cfg: BuildConfig, base: string): MacAppLayout {
  const productName = basename(base).replace(/\.(app|dmg|exe)$/i, '') || 'app';
  const appPath = `${base}.app`;
  const contentsPath = join(appPath, 'Contents');
  return {
    productName,
    appPath,
    contentsPath,
    binaryPath: join(contentsPath, 'MacOS', productName),
    resourcesPath: join(contentsPath, 'Resources'),
    plistPath: join(contentsPath, 'Info.plist'),
    iconPath: join(contentsPath, 'Resources', 'AppIcon.icns'),
    version: cfg.version || '0.0.0',
    buildVersion: cfg.buildVersion || cfg.version || '0.0.0',
  };
}

const ICON_BASE_SIZES = new Set([16, 32, 128, 256, 512]);

function validateAirPng(source: string, key: string, expected: number): void {
  if (!existsSync(source)) throw new Error(`AIR icon file not found: ${source}`);
  const data = readFileSync(source);
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`AIR icon ${key} is not a PNG file: ${source}`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== expected || height !== expected) {
    throw new Error(`AIR icon ${key} dimensions do not match ${source} (${width}x${height})`);
  }
}

// Return the finished .icns to copy into Resources. Descriptor PNGs are staged
// under the output base, never in the AIR source tree.
export function prepareMacIcon(cfg: BuildConfig, base: string, dry: boolean): string | null {
  if (cfg.icon) {
    if (!/\.icns$/i.test(cfg.icon)) throw new Error(`macOS packaging icon must be an .icns file: ${cfg.icon}`);
    return cfg.icon;
  }
  const entries = Object.entries(cfg.airIcons);
  if (entries.length === 0) return null;
  const iconset = `${base}.iconset`;
  const output = `${base}.icns`;
  if (dry) {
    console.log(`[release] dry-run create ${iconset} from AIR <icon>`);
    runReleaseCommand(['iconutil', '-c', 'icns', iconset, '-o', output], true);
    return output;
  }
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const ignored: string[] = [];
  for (const [key, source] of entries) {
    const match = /^image(\d+)x(\d+)$/.exec(key);
    if (!match || match[1] !== match[2]) throw new Error(`unsupported AIR icon element <${key}>`);
    const size = Number(match[1]);
    validateAirPng(source, key, size);
    if (ICON_BASE_SIZES.has(size)) {
      copyFileSync(source, join(iconset, `icon_${size}x${size}.png`));
      if (size >= 32) copyFileSync(source, join(iconset, `icon_${size / 2}x${size / 2}@2x.png`));
    } else if (size === 1024) {
      copyFileSync(source, join(iconset, 'icon_512x512@2x.png'));
    } else {
      ignored.push(key);
    }
  }
  if (ignored.length > 0) {
    console.warn(`warning: AIR icon sizes not used by macOS iconutil: ${ignored.join(', ')}`);
  }
  runReleaseCommand(['iconutil', '-c', 'icns', iconset, '-o', output]);
  return output;
}

// Build an unsigned bundle. Signing is a separate release concern: app uses an
// ad-hoc signature, dmg signs every nested native image before the outer bundle.
export function createMacApp(cfg: BuildConfig, compiledBinary: string, base: string, dry = false): MacAppLayout {
  const layout = macAppLayout(cfg, base);
  if (!cfg.version) console.warn(`warning: no AIR <versionNumber> or manifest 'version'; using ${layout.version}`);
  const icon = prepareMacIcon(cfg, base, dry);
  if (dry) {
    console.log(`[release] dry-run bundle ${compiledBinary} -> ${layout.binaryPath}`);
    return layout;
  }
  mkdirSync(join(layout.contentsPath, 'MacOS'), { recursive: true });
  mkdirSync(layout.resourcesPath, { recursive: true });
  if (compiledBinary !== layout.binaryPath) copyFileSync(compiledBinary, layout.binaryPath);
  chmodSync(layout.binaryPath, 0o755);
  if (icon) copyFileSync(icon, layout.iconPath);
  else rmSync(layout.iconPath, { force: true });
  writeFileSync(layout.plistPath, appInfoPlist({
    executable: layout.productName,
    bundleId: cfg.bundleId || `com.example.${layout.productName}`,
    displayName: cfg.displayName || layout.productName,
    version: layout.version,
    buildVersion: layout.buildVersion,
    deploymentTarget: cfg.deploymentTarget,
    iconName: icon ? 'AppIcon' : null,
  }));
  prepareAneBundles(layout.appPath);
  return layout;
}

// Reverse-DNS ANE directories are legal runtime paths but codesign treats
// every dotted directory below Contents/MacOS as a nested bundle. Give each one
// the minimal bundle identity it requires; without this, even an ad-hoc outer
// signature fails with "bundle format unrecognized" (measured on Prune).
export function aneBundleRoots(appPath: string): string[] {
  const root = join(appPath, 'Contents', 'MacOS', 'extensions');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

function prepareAneBundles(appPath: string): void {
  for (const root of aneBundleRoots(appPath)) {
    const id = basename(root);
    const path = join(root, 'Info.plist');
    if (existsSync(path)) continue;
    writeFileSync(path, appInfoPlist({
      executable: null,
      bundleId: id,
      displayName: id,
      version: '1.0.0',
      buildVersion: '1',
      deploymentTarget: '',
      iconName: null,
    }).replace('<string>APPL</string>', '<string>BNDL</string>'));
  }
}

export function adHocSignMacApp(appPath: string, dry = false): void {
  // Do NOT use --deep: sign every nested native image explicitly, then the app.
  // This must include the FRE host dylib BESIDE the executable, not only ANE
  // bundles: macOS rejects the outer signature when libasaot.dylib has no seal.
  // Share the release path's deepest-first inventory so the two cannot drift.
  for (const image of dry ? [] : nestedNativeImages(appPath)) {
    runReleaseCommand(['codesign', '--sign', '-', '--force', image], dry);
  }
  runReleaseCommand(['codesign', '--sign', '-', '--force', appPath], dry);
  runReleaseCommand(['codesign', '--verify', '--verbose=2', appPath], dry);
}
