// Windows release helpers: generate PNG-backed ICO files, PE resources and
// Authenticode/resource-compiler command lines without touching the filesystem.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { BuildConfig } from './build.ts';

export const DIGICERT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

export interface PngIconImage {
  width: number;
  height: number;
  data: Uint8Array;
}

// PNG-compressed icon entries are complete PNG byte streams. No image decode or
// re-encode is needed: Windows Vista and later consume this ICO representation
// directly, and the directory is small enough to assemble explicitly.
export function generatePngIco(images: readonly PngIconImage[]): Buffer {
  if (images.length === 0) throw new Error('a Windows ICO needs at least one PNG image');
  if (images.length > 0xffff) throw new Error('a Windows ICO cannot contain more than 65535 images');

  const directorySize = 6 + images.length * 16;
  const out = Buffer.alloc(directorySize);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2); // ICONDIR type: 1 = icon, 2 = cursor.
  out.writeUInt16LE(images.length, 4);

  const payloads: Buffer[] = [];
  let offset = directorySize;
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!Number.isInteger(image.width) || image.width < 1 || image.width > 256 ||
        !Number.isInteger(image.height) || image.height < 1 || image.height > 256) {
      throw new Error(`ICO image ${i + 1} dimensions must be integers between 1 and 256`);
    }
    if (image.data.length === 0) throw new Error(`ICO image ${i + 1} has no PNG data`);
    if (image.data.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error('Windows ICO exceeds the 32-bit resource offset range');
    }

    const entry = 6 + i * 16;
    // The one-byte dimension fields encode 256 as zero (the ICONDIR format's
    // long-standing convention), not as a truncated 16-bit value.
    out.writeUInt8(image.width === 256 ? 0 : image.width, entry);
    out.writeUInt8(image.height === 256 ? 0 : image.height, entry + 1);
    out.writeUInt8(0, entry + 2); // No palette in a PNG-compressed entry.
    out.writeUInt8(0, entry + 3);
    out.writeUInt16LE(1, entry + 4); // Colour planes.
    out.writeUInt16LE(32, entry + 6); // RGBA, the usual PNG icon depth.
    out.writeUInt32LE(image.data.length, entry + 8);
    out.writeUInt32LE(offset, entry + 12);
    const payload = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    payloads.push(payload);
    offset += payload.length;
  }
  return Buffer.concat([out, ...payloads], offset);
}

export interface WindowsManifestOptions {
  name: string;
  version: string;
  description?: string;
}

export interface WindowsResourceOptions {
  displayName: string;
  version: string;
  companyName?: string;
  bundleId?: string;
  fileDescription?: string;
  productName?: string;
  originalFilename?: string;
  iconPath?: string;
  // Defaults to app.manifest. Pass null only when the caller deliberately
  // supplies the DPI declaration through another resource.
  manifestPath?: string | null;
}

export interface WindowsCommand {
  command: string;
  args: string[];
}

export type WindowsResourceCompiler = 'llvm-rc' | 'rc';

export interface WindowsResourceCommandOptions {
  sourcePath: string;
  outputPath: string;
  compiler?: WindowsResourceCompiler;
  compilerPath?: string;
  includePaths?: readonly string[];
}

export interface WindowsSignOptions {
  executablePath: string;
  signtoolPath?: string;
  signingIdentity?: string;
  certificateSubject?: string;
  certificateThumbprint?: string;
  pfxPath?: string;
  pfxPassword?: string;
  // Deliberately injected rather than read from process.env, keeping command
  // generation deterministic. The build adapter can pass process.env directly.
  env?: Readonly<Record<string, string | undefined>>;
  timestampUrl?: string;
}

export interface WindowsVerifyOptions {
  executablePath: string;
  signtoolPath?: string;
}

function fixedVersion(version: string, separator: '.' | ','): string {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error(`Windows VERSIONINFO needs one to four numeric version components (got "${version}")`);
  }
  const parts = version.split('.').map((part) => Number(part));
  while (parts.length < 4) parts.push(0);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 0xffff)) {
    throw new Error(`Windows VERSIONINFO components must be between 0 and 65535 (got "${version}")`);
  }
  return parts.join(separator);
}

function xmlEscape(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) {
    throw new Error('Windows manifest metadata contains a character forbidden by XML 1.0');
  }
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

function rcEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default:
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          throw new Error('Windows resource metadata contains an unsupported control character');
        }
        out += ch;
    }
  }
  return out;
}

function rcValue(key: string, value: string): string {
  return `      VALUE "${key}", "${rcEscape(value)}"`;
}

export function generateWindowsManifest(options: WindowsManifestOptions): string {
  const version = fixedVersion(options.version, '.');
  const description = options.description ?? options.name;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="${xmlEscape(options.name)}" version="${version}" processorArchitecture="*"/>
  <description>${xmlEscape(description)}</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 and later: without this GUID Windows reports version 6.2. -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>
`;
}

export function generateWindowsResourceScript(options: WindowsResourceOptions): string {
  const numericVersion = fixedVersion(options.version, ',');
  const displayName = options.displayName;
  const internalName = options.bundleId ?? displayName;
  const lines = [
    '#include <winver.h>',
    '',
    '1 VERSIONINFO',
    ` FILEVERSION ${numericVersion}`,
    ` PRODUCTVERSION ${numericVersion}`,
    ' FILEFLAGSMASK 0x3fL',
    ' FILEFLAGS 0x0L',
    ' FILEOS 0x40004L',
    ' FILETYPE 0x1L',
    ' FILESUBTYPE 0x0L',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',
    '    BEGIN',
    rcValue('CompanyName', options.companyName ?? ''),
    rcValue('FileDescription', options.fileDescription ?? displayName),
    rcValue('FileVersion', options.version),
    rcValue('InternalName', internalName),
    rcValue('OriginalFilename', options.originalFilename ?? `${displayName}.exe`),
    rcValue('ProductName', options.productName ?? displayName),
    rcValue('ProductVersion', options.version),
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
  ];
  if (options.iconPath) lines.push('', `1 ICON DISCARDABLE "${rcEscape(options.iconPath)}"`);
  const manifestPath = options.manifestPath === undefined ? 'app.manifest' : options.manifestPath;
  if (manifestPath !== null && manifestPath !== '') {
    // 24 is RT_MANIFEST. Using its number avoids depending on another SDK header.
    lines.push('', `1 24 "${rcEscape(manifestPath)}"`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildWindowsResourceCommand(options: WindowsResourceCommandOptions): WindowsCommand {
  const compiler = options.compiler ?? 'llvm-rc';
  const command = options.compilerPath ?? (compiler === 'rc' ? 'rc.exe' : 'llvm-rc');
  const args: string[] = [];
  if (compiler === 'rc') args.push('/nologo');
  for (const path of options.includePaths ?? []) args.push('/I', path);
  args.push('/fo', options.outputPath, options.sourcePath);
  return { command, args };
}

function normalThumbprint(value: string): string | null {
  const compact = value.replace(/[\s:-]/g, '');
  return /^[0-9a-fA-F]{40}$/.test(compact) ? compact.toUpperCase() : null;
}

export function buildSigntoolSignCommand(options: WindowsSignOptions): WindowsCommand | null {
  const env = options.env ?? {};
  const identity = options.signingIdentity ?? env.ASC_SIGN_IDENTITY ?? '';
  const subject = options.certificateSubject ?? '';
  const thumbprint = options.certificateThumbprint ?? '';
  const pfxPath = options.pfxPath ?? env.ASC_WIN_CERT_FILE ?? '';
  const pfxPassword = options.pfxPassword ?? env.ASC_WIN_CERT_PASSWORD;
  const storeSelectors = [identity, subject, thumbprint].filter((value) => value !== '').length;
  if (pfxPath !== '' && storeSelectors > 0) {
    throw new Error('Windows signing is ambiguous: choose a certificate-store identity or a PFX file, not both');
  }
  if (storeSelectors > 1) {
    throw new Error('Windows signing is ambiguous: specify only one subject, thumbprint or signing identity');
  }
  if (pfxPath === '' && storeSelectors === 0) return null;

  const args = [
    'sign', '/fd', 'sha256',
    '/tr', options.timestampUrl ?? DIGICERT_TIMESTAMP_URL, '/td', 'sha256',
  ];
  if (pfxPath !== '') {
    args.push('/f', pfxPath);
    if (pfxPassword !== undefined) args.push('/p', pfxPassword);
  } else if (thumbprint !== '') {
    const normalized = normalThumbprint(thumbprint);
    if (normalized === null) throw new Error('Windows certificate thumbprint must contain exactly 40 hexadecimal digits');
    args.push('/sha1', normalized);
  } else {
    const selected = subject !== '' ? subject : identity;
    const normalized = normalThumbprint(selected);
    if (normalized !== null) args.push('/sha1', normalized);
    else args.push('/n', selected);
  }
  args.push(options.executablePath);
  return { command: options.signtoolPath ?? 'signtool', args };
}

export function buildSigntoolVerifyCommand(options: WindowsVerifyOptions): WindowsCommand {
  return {
    command: options.signtoolPath ?? 'signtool',
    args: ['verify', '/pa', options.executablePath],
  };
}

// Return a copy suitable for dry-run output, diagnostics and doctor logs. The
// real command retains the password because spawn needs it; every display path
// in this module goes through this redaction first.
export function redactWindowsCommand(command: WindowsCommand): WindowsCommand {
  const args = [...command.args];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i].toLowerCase() === '/p') args[i + 1] = '***';
  }
  return { command: command.command, args };
}

function quoteWindowsArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes++;
    } else if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      out += '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
  }
  out += '\\'.repeat(slashes * 2) + '"';
  return out;
}

// Formatting is display-only and always redacts secrets; execution should use
// the command/args pair directly with spawn, never this shell-looking string.
export function formatWindowsCommand(command: WindowsCommand): string {
  const safe = redactWindowsCommand(command);
  return [safe.command, ...safe.args].map(quoteWindowsArg).join(' ');
}

export interface WindowsResourcePreparation {
  objectPath: string;
  resourceCommand: WindowsCommand;
}

function pngSize(data: Uint8Array, path: string): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 24 || !signature.every((value, index) => data[index] === value)) {
    throw new Error(`AIR icon is not a PNG file: ${path}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function runWindowsCommand(command: WindowsCommand, dry = false): void {
  console.log(`[release] ${dry ? 'dry-run ' : ''}${formatWindowsCommand(command)}`);
  if (dry) return;
  const result = spawnSync(command.command, command.args, { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`release tool '${command.command}' could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`release tool failed (${result.status ?? 'signal'}): ${formatWindowsCommand(command)}`);
  }
}

// Materialise the .res consumed by the otherwise unchanged native link line.
// In dry-run mode only commands are printed; no resource files are written.
export function prepareWindowsResources(cfg: BuildConfig, base: string, dry = false): WindowsResourcePreparation {
  const productName = basename(base).replace(/\.exe$/i, '') || 'app';
  const displayName = cfg.displayName || productName;
  const version = cfg.version || '0.0.0';
  if (!cfg.version) console.warn(`warning: no AIR <versionNumber> or manifest 'version'; using ${version}`);
  const manifestPath = `${base}.manifest`;
  const sourcePath = `${base}.rc`;
  const objectPath = `${base}.res`;
  let iconPath: string | undefined;
  if (cfg.icon) {
    if (!/\.ico$/i.test(cfg.icon)) throw new Error(`Windows packaging icon must be an .ico file: ${cfg.icon}`);
    iconPath = cfg.icon;
  } else if (Object.keys(cfg.airIcons).length > 0) {
    const images: PngIconImage[] = [];
    const skipped: string[] = [];
    for (const [key, path] of Object.entries(cfg.airIcons)) {
      const match = /^image(\d+)x(\d+)$/.exec(key);
      if (!match || match[1] !== match[2]) throw new Error(`unsupported AIR icon element <${key}>`);
      const data = readFileSync(path);
      const size = pngSize(data, path);
      if (size.width !== Number(match[1]) || size.height !== Number(match[2])) {
        throw new Error(`AIR icon ${key} dimensions do not match ${path} (${size.width}x${size.height})`);
      }
      if (size.width > 256 || size.height > 256) { skipped.push(key); continue; }
      images.push({ ...size, data });
    }
    if (skipped.length > 0) console.warn(`warning: AIR icon sizes above the ICO 256px limit were not embedded: ${skipped.join(', ')}`);
    if (images.length === 0) throw new Error('AIR <icon> has no PNG at or below 256px; supply a finished .ico in manifest icon');
    images.sort((a, b) => a.width - b.width);
    iconPath = `${base}.ico`;
    if (!dry) writeFileSync(iconPath, generatePngIco(images));
  }
  const manifest = generateWindowsManifest({ name: cfg.bundleId || displayName, version, description: displayName });
  const script = generateWindowsResourceScript({
    displayName,
    version,
    bundleId: cfg.bundleId || undefined,
    originalFilename: `${productName}.exe`,
    iconPath,
    manifestPath,
  });
  if (dry) console.log(`[release] dry-run write ${sourcePath}, ${manifestPath}${iconPath ? `, ${iconPath}` : ''}`);
  else {
    writeFileSync(manifestPath, manifest);
    writeFileSync(sourcePath, script);
  }
  const resourceCommand = buildWindowsResourceCommand({ sourcePath, outputPath: objectPath });
  runWindowsCommand(resourceCommand, dry);
  return { objectPath, resourceCommand };
}

export function signWindowsExe(cfg: BuildConfig, executablePath: string, dry = false): boolean {
  const sign = buildSigntoolSignCommand({
    executablePath,
    signingIdentity: cfg.signingIdentity,
    env: process.env,
    timestampUrl: cfg.timestampServer,
  });
  if (sign === null) {
    console.warn('warning: this exe is UNSIGNED; SmartScreen may block it (configure signing-identity or ASC_WIN_CERT_FILE)');
    return false;
  }
  runWindowsCommand(sign, dry);
  runWindowsCommand(buildSigntoolVerifyCommand({ executablePath }), dry);
  return true;
}
