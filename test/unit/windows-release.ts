// Unit checks: host-independent Windows ICO, resource, manifest and release
// command generation (阶段三百零八). These tests inspect bytes and argv only;
// they require neither a Windows SDK nor signing credentials.

import {
  DIGICERT_TIMESTAMP_URL,
  buildSigntoolSignCommand,
  buildSigntoolVerifyCommand,
  buildWindowsResourceCommand,
  formatWindowsCommand,
  generatePngIco,
  generateWindowsManifest,
  generateWindowsResourceScript,
  prepareWindowsResources,
  redactWindowsCommand,
} from '../../src/windows-release.ts';
import { defaultBuildConfig } from '../../src/build.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

function checkIco(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-ico] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-ico] ${label}`); }
  };
  const throws = (label: string, fn: () => void): void => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw);
  };

  const small = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const large = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const ico = generatePngIco([
    { width: 16, height: 32, data: small },
    { width: 256, height: 256, data: large },
  ]);

  check('ICONDIR is reserved=0, icon type=1 and a little-endian count',
    ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 2);
  check('the first entry retains both dimensions', ico[6] === 16 && ico[7] === 32);
  check('256 is represented by the format\'s zero dimension byte', ico[22] === 0 && ico[23] === 0);
  check('PNG entries have no palette and carry one plane / 32 bits',
    ico[8] === 0 && ico[9] === 0 && ico.readUInt16LE(10) === 1 && ico.readUInt16LE(12) === 32);
  check('entry sizes are little-endian PNG payload lengths',
    ico.readUInt32LE(14) === small.length && ico.readUInt32LE(30) === large.length);
  check('the first payload follows the complete directory', ico.readUInt32LE(18) === 6 + 2 * 16);
  check('the second payload follows the first exactly',
    ico.readUInt32LE(34) === 6 + 2 * 16 + small.length);
  check('PNG streams are copied verbatim at their declared offsets',
    ico.subarray(38, 38 + small.length).equals(Buffer.from(small)) &&
    ico.subarray(38 + small.length).equals(Buffer.from(large)));
  check('the output length is directory plus all payloads', ico.length === 38 + small.length + large.length);
  throws('an empty icon set is rejected', () => generatePngIco([]));
  throws('dimensions above 256 are rejected rather than truncated', () =>
    generatePngIco([{ width: 257, height: 16, data: small }]));
  throws('empty PNG payloads are rejected', () =>
    generatePngIco([{ width: 16, height: 16, data: new Uint8Array() }]));

  if (ok > 0) console.log(`[win-ico] ${ok} checks passed`);
  return bad;
}

function checkResources(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-rc] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-rc] ${label}`); }
  };
  const throws = (label: string, fn: () => void): void => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw);
  };

  const rc = generateWindowsResourceScript({
    displayName: 'Prune "Pro" \\ Edition',
    version: '1.2.3',
    companyName: 'A&B <Labs>',
    bundleId: 'com.example.prune',
    originalFilename: 'Prune.exe',
    iconPath: 'C:\\icons\\"prune".ico',
  });
  check('fixed file and product versions are padded to four numeric fields',
    rc.includes(' FILEVERSION 1,2,3,0\n') && rc.includes(' PRODUCTVERSION 1,2,3,0\n'));
  check('the display and company metadata reach StringFileInfo',
    rc.includes('VALUE "CompanyName", "A&B <Labs>"') &&
    rc.includes('VALUE "ProductVersion", "1.2.3"') &&
    rc.includes('VALUE "InternalName", "com.example.prune"'));
  check('RC quotes and path backslashes are escaped',
    rc.includes('Prune \\"Pro\\" \\\\ Edition') && rc.includes('C:\\\\icons\\\\\\"prune\\".ico'));
  check('the icon is an ICON resource', rc.includes('1 ICON DISCARDABLE'));
  check('the default application manifest is resource type 24', rc.includes('1 24 "app.manifest"'));
  check('a caller can omit a separately supplied manifest', !generateWindowsResourceScript({
    displayName: 'X', version: '1', manifestPath: null,
  }).includes('1 24 '));

  const xml = generateWindowsManifest({
    name: 'com.example.prune&"x"',
    version: '2.4',
    description: '<Prune & "Friends">',
  });
  check('manifest identity names are XML escaped', xml.includes('name="com.example.prune&amp;&quot;x&quot;"'));
  check('manifest descriptions escape markup and quotes', xml.includes('<description>&lt;Prune &amp; &quot;Friends&quot;&gt;</description>'));
  check('manifest versions use four dot-separated fields', xml.includes('version="2.4.0.0"'));
  check('DPI declarations select per-monitor v2 with the legacy fallback',
    xml.includes('>true/pm</dpiAware>') && xml.includes('>PerMonitorV2</dpiAwareness>'));
  check('the manifest requests ordinary asInvoker execution', xml.includes('level="asInvoker"'));
  check('the manifest opts into long paths and declares Windows 10 compatibility',
    xml.includes('>true</longPathAware>') && xml.includes('{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}'));
  throws('non-numeric VERSIONINFO input fails loudly', () => generateWindowsResourceScript({
    displayName: 'X', version: '1.2-beta',
  }));
  throws('XML-forbidden controls are not emitted as numeric entities', () => generateWindowsManifest({
    name: 'bad\u0000name', version: '1',
  }));

  if (ok > 0) console.log(`[win-rc] ${ok} checks passed`);
  return bad;
}

function checkCommands(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win-cmd] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win-cmd] ${label}`); }
  };
  const throws = (label: string, fn: () => void): void => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(label, threw);
  };

  const llvm = buildWindowsResourceCommand({
    sourcePath: 'build/Prune.rc', outputPath: 'build/Prune.res',
  });
  check('llvm-rc is the cross-friendly default',
    llvm.command === 'llvm-rc' && llvm.args.join('|') === '/fo|build/Prune.res|build/Prune.rc');
  const msvc = buildWindowsResourceCommand({
    compiler: 'rc', sourcePath: 'Prune.rc', outputPath: 'Prune.res', includePaths: ['sdk/include'],
  });
  check('rc.exe gets its quiet flag, includes and the same output contract',
    msvc.command === 'rc.exe' &&
    msvc.args.join('|') === '/nologo|/I|sdk/include|/fo|Prune.res|Prune.rc');

  const subject = buildSigntoolSignCommand({
    executablePath: 'C:\\Program Files\\Prune\\Prune.exe',
    certificateSubject: 'CN=Prune, O=A&B',
  });
  check('subject signing uses /n and the required SHA-256 digest and timestamp switches',
    subject !== null && subject.command === 'signtool' &&
    subject.args.join('|') === `sign|/fd|sha256|/tr|${DIGICERT_TIMESTAMP_URL}|/td|sha256|/n|CN=Prune, O=A&B|C:\\Program Files\\Prune\\Prune.exe`);
  const thumb = buildSigntoolSignCommand({
    executablePath: 'Prune.exe', signingIdentity: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd',
  });
  check('a 40-hex signing identity is recognised as a thumbprint',
    thumb !== null && thumb.args.includes('/sha1') && thumb.args.includes('AABBCCDDEEFF00112233445566778899AABBCCDD'));
  check('verify uses Authenticode policy verification',
    buildSigntoolVerifyCommand({ executablePath: 'Prune.exe' }).args.join('|') === 'verify|/pa|Prune.exe');
  check('no configured credential means no signing command',
    buildSigntoolSignCommand({ executablePath: 'Prune.exe', env: {} }) === null);

  const secret = 'correct horse battery staple';
  const pfx = buildSigntoolSignCommand({
    executablePath: 'Prune.exe',
    env: { ASC_WIN_CERT_FILE: 'C:\\certs\\Prune.pfx', ASC_WIN_CERT_PASSWORD: secret },
  });
  check('PFX credentials come from the injected environment',
    pfx !== null && pfx.args.includes('/f') && pfx.args.includes('/p') && pfx.args.includes(secret));
  const shown = pfx === null ? '' : formatWindowsCommand(pfx);
  const redacted = pfx === null ? null : redactWindowsCommand(pfx);
  check('formatted dry-run output never contains the PFX password',
    shown.includes('/p ***') && !shown.includes(secret));
  check('explicit redaction does not mutate the executable argv',
    redacted !== null && pfx !== null && redacted.args.includes('***') && pfx.args.includes(secret));
  check('command display quotes Windows paths containing spaces',
    subject !== null && formatWindowsCommand(subject).includes('"C:\\Program Files\\Prune\\Prune.exe"'));
  throws('store and PFX selectors are rejected as ambiguous', () => buildSigntoolSignCommand({
    executablePath: 'Prune.exe', certificateSubject: 'CN=Prune', pfxPath: 'Prune.pfx',
  }));
  throws('malformed explicit thumbprints fail loudly', () => buildSigntoolSignCommand({
    executablePath: 'Prune.exe', certificateThumbprint: 'not-a-thumbprint',
  }));

  if (ok > 0) console.log(`[win-cmd] ${ok} checks passed`);
  return bad;
}

registerGroup('unit: windows-release/ico', checkIco);
registerGroup('unit: windows-release/resources', checkResources);
registerGroup('unit: windows-release/commands', checkCommands);

registerGroup('unit: windows-release/build-adapter', () => {
  const bad: string[] = [];
  const cfg = { ...defaultBuildConfig(), package: 'exe' as const, version: '1.2.3' };
  const base = join(root, 'temp', 'windows-dry', 'Prune');
  const prepared = prepareWindowsResources(cfg, base, true);
  if (prepared.objectPath !== `${base}.res`) bad.push('resource object feeds the link as a .res');
  if (existsSync(`${base}.rc`) || existsSync(`${base}.manifest`)) bad.push('dry-run writes no Windows resources');
  return bad;
});
