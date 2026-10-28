// Unit checks: script-built macOS bundles and AIR release metadata (stage 306).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { appInfoPlist, createMacApp, macAppLayout, prepareMacIcon } from '../../src/app-bundle.ts';
import { applyManifest, defaultBuildConfig, type Manifest } from '../../src/build.ts';
import { parseAirApp } from '../../src/air-app.ts';
import { macAppSignCommands, nestedNativeImages, notaryAccepted, packageMacDmg, requireMacDmgCredentials } from '../../src/release.ts';
import { registerGroup, root } from '../harness.ts';

// Both groups below are macOS HOST tests: `macAppLayout` describes a .app bundle
// (`<name>.app/Contents/MacOS/<name>`, POSIX separators) and `--package dmg` REFUSES a
// non-macOS host outright ("requires --target native on a macOS host"). Run on
// Windows they would assert the separators of a layout that does not exist there
// and a command the CLI rejects by design, so the host says so loudly instead of
// going red on a correct product -- the same shape as the CoreFoundation probe in
// unit: platform/CapabilitiesLocale.
registerGroup('release/AppBundle', () => {
  if (process.platform !== 'darwin') {
    console.log('SKIP  [release] macOS-only .app layout (this host is ' + process.platform + ')');
    return [];
  }
  const bad: string[] = [];
  const check = (label: string, condition: boolean): void => {
    if (condition) console.log(`PASS  [release] ${label}`);
    else { bad.push(label); console.log(`FAIL  [release] ${label}`); }
  };
  const info = parseAirApp(`<application>
    <id>com.example.prune</id><versionNumber>1.2.3</versionNumber><versionLabel>42</versionLabel>
    <filename>Prune</filename><name>净扫</name>
    <icon><image16x16>assets/16.png</image16x16><image512x512>assets/512.png</image512x512></icon>
    <initialWindow><content>Prune.swf</content><title>Window title</title></initialWindow>
  </application>`);
  check('descriptor supplies bundle id', info.id === 'com.example.prune');
  check('display name prefers name over window title', info.name === '净扫');
  check('descriptor supplies release version', info.versionNumber === '1.2.3');
  check('descriptor supplies build version label', info.versionLabel === '42');
  check('display name falls back to filename, not window title', parseAirApp('<application><id>com.example.prune</id><filename>Prune</filename><initialWindow><title>Window</title></initialWindow></application>').name === 'Prune');
  check('descriptor icon paths survive parsing', info.icons['image512x512'] === 'assets/512.png');

  const manifestPath = join(root, 'temp', 'release-manifest.json');
  const cfg = applyManifest(defaultBuildConfig(), {
    'bundle-id': info.id,
    'display-name': info.name,
    version: info.versionNumber,
    'build-version': '42',
    'air-icons': info.icons,
  } as Manifest, manifestPath);
  check('manifest metadata reaches build config', cfg.bundleId === info.id && cfg.version === '1.2.3');
  check('AIR icon paths resolve relative to the manifest', cfg.airIcons['image16x16'] === join(root, 'temp', 'assets/16.png'));
  const overridden = applyManifest(defaultBuildConfig(), { version: '9.0.0', 'build-version': '9' } as Manifest, manifestPath);
  check('explicit manifest version wins over descriptor defaults', overridden.version === '9.0.0');

  const layout = macAppLayout({ ...cfg, buildVersion: '42' }, join(root, 'temp', 'release-app', 'Prune'));
  const plist = appInfoPlist({
    executable: layout.productName,
    bundleId: cfg.bundleId,
    displayName: 'A & <B>',
    version: cfg.version,
    buildVersion: '42',
    deploymentTarget: cfg.deploymentTarget,
    iconName: 'AppIcon',
  });
  check('bundle has a native executable path', layout.binaryPath.endsWith('Prune.app/Contents/MacOS/Prune'));
  check('plist carries short and build versions', plist.includes('<string>1.2.3</string>') && plist.includes('<string>42</string>'));
  check('plist escapes display-name XML', plist.includes('A &amp; &lt;B&gt;'));
  check('plist carries descriptor bundle id', plist.includes('com.example.prune'));

  const out = join(root, 'temp', 'unit-release-app');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const binary = join(out, 'input');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  const app = createMacApp({ ...cfg, airIcons: {} }, binary, join(out, 'Prune'));
  check('bundle creates executable', existsSync(app.binaryPath));
  check('bundle writes Info.plist', existsSync(app.plistPath));
  check('bundle leaves no fake icon', !existsSync(app.iconPath));
  check('written plist is concrete, not Xcode variables', !readFileSync(app.plistPath, 'utf8').includes('$(EXECUTABLE_NAME)'));
  const ane = join(app.appPath, 'Contents', 'MacOS', 'extensions', 'com.example.volume');
  mkdirSync(ane, { recursive: true });
  createMacApp({ ...cfg, airIcons: {} }, binary, join(out, 'Prune'));
  const anePlist = readFileSync(join(ane, 'Info.plist'), 'utf8');
  check('reverse-DNS ANE directory becomes a signable bundle', anePlist.includes('com.example.volume') && anePlist.includes('BNDL'));
  check('ANE bundle does not invent an executable', !anePlist.includes('CFBundleExecutable'));
  const freHost = join(app.contentsPath, 'MacOS', 'libasaot.dylib');
  writeFileSync(freHost, 'test fixture, not a loadable dylib');
  check('ad-hoc inventory includes the standalone FRE host dylib', nestedNativeImages(app.appPath).includes(freHost));
  const bundleSource = readFileSync(join(root, 'src', 'app-bundle.ts'), 'utf8');
  check('ad-hoc signing consumes the shared deepest-first native-image inventory',
    /adHocSignMacApp[\s\S]*?nestedNativeImages\(appPath\)/.test(bundleSource));

  const badPng = join(out, 'bad.png');
  writeFileSync(badPng, Buffer.alloc(24));
  let invalidPngRejected = false;
  try { prepareMacIcon({ ...cfg, airIcons: { image16x16: badPng } }, join(out, 'Bad'), false); }
  catch { invalidPngRejected = true; }
  check('non-PNG descriptor icons are rejected', invalidPngRejected);
  const mismatchPng = join(out, 'mismatch.png');
  const png = Buffer.alloc(24);
  png.write('89504e470d0a1a0a', 0, 'hex');
  png.writeUInt32BE(16, 16);
  png.writeUInt32BE(16, 20);
  writeFileSync(mismatchPng, png);
  let mismatchRejected = false;
  try { prepareMacIcon({ ...cfg, airIcons: { image32x32: mismatchPng } }, join(out, 'Mismatch'), false); }
  catch { mismatchRejected = true; }
  check('descriptor icon dimensions must match their element', mismatchRejected);
  return bad;
});

registerGroup('release/DmgPlan', () => {
  if (process.platform !== 'darwin') {
    console.log('SKIP  [dmg] macOS-only packaging (this host is ' + process.platform + ')');
    return [];
  }
  const bad: string[] = [];
  const check = (label: string, condition: boolean): void => {
    if (condition) console.log(`PASS  [dmg] ${label}`);
    else { bad.push(label); console.log(`FAIL  [dmg] ${label}`); }
  };
  let message = '';
  try { requireMacDmgCredentials(defaultBuildConfig()); } catch (error) { message = (error as Error).message; }
  check('missing signing identity is a loud error', message.includes('signing-identity'));
  check('missing notary profile names store-credentials', message.includes('store-credentials'));
  const cfg = {
    ...defaultBuildConfig(),
    package: 'dmg' as const,
    signingIdentity: 'Developer ID Application: Example (TEAM)',
    notaryProfile: 'release-profile',
    version: '1.2.3',
  };
  check('configured credentials satisfy preflight', requireMacDmgCredentials(cfg).profile === 'release-profile');
  const commands = macAppSignCommands(cfg, '/x/App.app', cfg.signingIdentity, ['/x/App.app/Contents/Frameworks/A.dylib']);
  check('nested native image signs before the app', commands[0].at(-1)?.endsWith('A.dylib') === true && commands[1].at(-1) === '/x/App.app');
  check('hardened runtime and timestamp are on', commands[1].includes('--options') && commands[1].includes('runtime') && commands[1].includes('--timestamp'));
  check('strict verification follows signing', commands.at(-1)?.includes('--strict') === true);
  check('JSON Accepted is the only accepted notary status', notaryAccepted('{"status":"Accepted"}') && !notaryAccepted('{"status":"Invalid"}'));
  check('malformed notary output is not accepted', !notaryAccepted('Processing complete') && !notaryAccepted(''));
  const layout = macAppLayout(cfg, join(root, 'temp', 'dry-dmg', 'Prune'));
  const output = packageMacDmg(cfg, join(root, 'temp', 'dry-dmg', 'Prune'), layout, true);
  check('dry-run names versioned DMG', output.endsWith('Prune-1.2.3.dmg'));

  // A release overlay is only useful if the REAL CLI applies it after --air-app
  // regenerates <filename>.build.json. Exercise that ordering, not just two
  // isolated applyManifest calls (the old CLI accepted --manifest and erased it).
  const fixture = join(root, 'temp', 'release-overlay');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'Main.as'),
    'package { import flash.display.Sprite; public class Main extends Sprite { public function Main() { } } }\n');
  writeFileSync(join(fixture, 'app.xml'), '<application><id>temp.release.overlay</id><versionNumber>1.2.3</versionNumber>'
    + '<filename>Overlay</filename><initialWindow><content>Main.swf</content><visible>false</visible></initialWindow></application>');
  writeFileSync(join(fixture, 'entitlements.plist'), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
  writeFileSync(join(fixture, 'release.json'), JSON.stringify({
    'signing-identity': 'Developer ID Application: Overlay (TEAM)',
    'notary-profile': 'overlay-profile',
    entitlements: 'entitlements.plist',
  }));
  const dry = spawnSync(process.execPath, [
    join(root, 'src', 'index.ts'), '--air-app', join(fixture, 'app.xml'),
    '--manifest', join(fixture, 'release.json'), '--main-class', 'Main',
    '--package', 'dmg', '--dry', '-o', join(fixture, 'out', 'Overlay'),
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ASC_SIGN_IDENTITY: '', ASC_NOTARY_PROFILE: '' } });
  const log = `${dry.stdout ?? ''}\n${dry.stderr ?? ''}`;
  check('AIR + explicit manifest dry-run succeeds', dry.status === 0);
  check('release overlay survives AIR manifest regeneration',
    log.includes('Developer ID Application: Overlay (TEAM)') && log.includes('--keychain-profile overlay-profile'));
  check('entitlements resolve from the explicit overlay, not the generated manifest',
    log.includes(`--entitlements ${join(fixture, 'entitlements.plist')}`));
  return bad;
});
