// Win7 import audit: reads a PE's import directory and reports every symbol that
// does not exist on Windows 7 SP1, plus the loader checks the image carries
// (subsystem version / OS version).
//
// Why a tool rather than a claim: "it uses Vista-era APIs" is a statement about
// source code, and the thing that actually decides whether Win7 runs the binary
// is the IMPORT TABLE — which the linker assembles out of whatever the whole
// program (including prebuilt Skia archives) ended up referencing. Reading it is
// cheap and exact; guessing from the source is neither.
//
// What it CANNOT see: everything resolved at runtime through GetProcAddress /
// LoadLibrary. Those are enumerated by the caller and degrade explicitly (see
// `sk_cap_os` and the `GetDpiForWindow` fallback in window_glue.cc), so the tool
// prints them separately when asked (`--dynamic`).
//
//   node scripts/win7-imports.ts <exe-or-dll> [more...]
//   node scripts/win7-imports.ts --json <exe>
//
// Exit code: 0 = Win7 SP1-compatible import surface, 1 = incompatibility found.

import { readFileSync } from 'node:fs';

interface Section {
  va: number;
  vsize: number;
  raw: number;
  rawSize: number;
}

export interface PeInfo {
  dlls: string[];
  funcs: Record<string, string[]>;
  subsystem: number;
  subVer: string;
  osVer: string;
  pe32plus: boolean;
  characteristics: number;
}

function peImports(file: string): PeInfo {
  const b = readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(file + ': not a PE (no MZ signature)');
  const peOff = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(peOff) !== 0x00004550) throw new Error(file + ': not a PE (no PE\0\0 signature)');
  const coff = peOff + 4;
  const numSections = b.readUInt16LE(coff + 2);
  const characteristics = b.readUInt16LE(coff + 18);
  const optSize = b.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = b.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const numDirs = b.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const dirBase = opt + (pe32plus ? 112 : 96);

  const sections: Section[] = [];
  const sec = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = sec + i * 40;
    sections.push({
      va: b.readUInt32LE(s + 12),
      vsize: b.readUInt32LE(s + 8),
      raw: b.readUInt32LE(s + 20),
      rawSize: b.readUInt32LE(s + 16),
    });
  }
  const off = (rva: number): number => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va);
    }
    return -1;
  };
  const readStr = (rva: number): string | null => {
    const o = off(rva);
    if (o < 0) return null;
    let e = o;
    while (e < b.length && b[e] !== 0) e++;
    return b.subarray(o, e).toString('latin1');
  };

  const dlls: string[] = [];
  const funcs: Record<string, string[]> = {};
  // Data directory 1 = imports. A DLL may have no imports at all (export-only).
  const impRva = numDirs >= 2 ? b.readUInt32LE(dirBase + 8) : 0;
  if (impRva) {
    let d = off(impRva);
    while (d > 0) {
      const nameRva = b.readUInt32LE(d + 12);
      if (!nameRva) break;
      const dllName = readStr(nameRva);
      if (!dllName) break;
      const thunkSize = pe32plus ? 8 : 4;
      const lookupRva = b.readUInt32LE(d + 0);
      const ftRva = b.readUInt32LE(d + 16);
      let t = off(lookupRva || ftRva);
      const names: string[] = [];
      while (t > 0) {
        const v = pe32plus ? b.readBigUInt64LE(t) : BigInt(b.readUInt32LE(t));
        if (v === 0n) break;
        const ordinalFlag = pe32plus ? 1n << 63n : 1n << 31n;
        if ((v & ordinalFlag) === 0n) {
          const n = readStr(Number(v & 0x7fffffffn) + 2);
          if (n) names.push(n);
        } else {
          names.push('#' + (v & 0xffffn).toString());
        }
        t += thunkSize;
      }
      dlls.push(dllName);
      funcs[dllName] = names;
      d += 20;
    }
  }

  const majorSub = b.readUInt16LE(opt + 48);
  const minorSub = b.readUInt16LE(opt + 50);
  const osMajor = b.readUInt16LE(opt + 40);
  const osMinor = b.readUInt16LE(opt + 42);
  return {
    dlls,
    funcs,
    subsystem: b.readUInt16LE(opt + 68),
    subVer: majorSub + '.' + minorSub,
    osVer: osMajor + '.' + osMinor,
    pe32plus,
    characteristics,
  };
}

// ---------------------------------------------------------------------------
// Knowledge tables. Both are deliberately explicit rather than pattern-matched:
// a false positive here blocks a release, and a false negative ships an image
// that dies on the customer's machine with "is not a valid Win32 application".
// ---------------------------------------------------------------------------

// DLLs that do not exist on a stock Windows 7 SP1 install. Win7 DOES have:
// dxgi.dll, d2d1.dll, d3d10*.dll, d3d11.dll (plus Platform Update), dwrite.dll,
// opengl32.dll, shlwapi.dll, usp10.dll, imm32.dll, dinput8.dll, version.dll.
export const WIN8_PLUS_DLLS = new Set([
  'd3d12.dll',            // Win10 1507 (the D3D12 runtime)
  'd3dcompiler_47.dll',   // ships app-local via the SDK, never as a system DLL on Win7
  'dxcompiler.dll',       // DXC, Win10
  'dcomp.dll',            // DirectComposition, Win8
  'shcore.dll',           // Win8.1 (SetProcessDpiAwareness / GetDpiForMonitor)
  'combase.dll',          // Win8 (RoInitialize & friends)
  'windows.storage.dll',  // Win8
  'ucrtbase.dll',         // Win10; Win7 needs KB2999226 to have it
  'vcruntime140.dll',     // not a system DLL on Win7
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'api-ms-win-core-path-l1-1-0.dll', // Win8
]);

// NB: dwmapi.dll is deliberately NOT in the set above — Win7 SP1 has it. Its Win8+
// entry points are covered by the symbol table below.

// Per-DLL symbols that a Win7 SP1 system DLL does not export. Names are matched
// case-sensitively, exactly as they appear in the import table.
export const WIN8_PLUS_SYMBOLS: Record<string, Set<string>> = {
  'kernel32.dll': new Set([
    'CreateFile2', 'CopyFile2', 'GetSystemTimePreciseAsFileTime',
    'SetThreadDescription', 'GetThreadDescription',
    'WaitOnAddress', 'WakeByAddressSingle', 'WakeByAddressAll',
    'InitializeSynchronizationBarrier', 'EnterSynchronizationBarrier', 'DeleteSynchronizationBarrier',
    'GetSystemCpuSetInformation', 'SetThreadInformation', 'GetThreadInformation',
    'PrefetchVirtualMemory', 'GetProcessMitigationPolicy', 'SetProcessMitigationPolicy',
    'SetDefaultDllDirectories', 'AddDllDirectory', 'RemoveDllDirectory',
    'LoadPackagedLibrary', 'GetCurrentPackageFullName', 'GetCurrentPackageId', 'GetPackageFamilyName',
    'GetOverlappedResultEx', 'CreateFileMappingFromApp', 'MapViewOfFileFromApp',
    'GetFileVersionInfoExW', 'GetFileVersionInfoSizeExW', 'VerQueryValueW',
  ]),
  'user32.dll': new Set([
    'GetDpiForWindow', 'GetDpiForSystem', 'GetDpiForMonitor',
    'GetSystemMetricsForDpi', 'AdjustWindowRectExForDpi', 'SystemParametersInfoForDpi',
    'SetProcessDpiAwarenessContext', 'GetThreadDpiAwarenessContext', 'SetThreadDpiAwarenessContext',
    'GetWindowDpiAwarenessContext', 'AreDpiAwarenessContextsEqual', 'IsValidDpiAwarenessContext',
    'EnableNonClientDpiScaling', 'EnableMouseInPointer',
    'GetPointerType', 'GetPointerInfo', 'GetPointerPenInfo', 'GetPointerDevices',
    'RegisterPointerInputTarget', 'SkipPointerFrameMessages',
    'LogicalToPhysicalPointForPerMonitorDPI', 'PhysicalToLogicalPointForPerMonitorDPI',
    'SetProcessDpiAwarenessContextInternal',
  ]),
  'kernelbase.dll': new Set(['*']), // kernelbase is itself Win8-era for most binaries
  'advapi32.dll': new Set(['EventSetInformation', 'RegisterWaitUntilOOBECompleted']),
  'ole32.dll': new Set([
    'RoInitialize', 'RoUninitialize', 'RoGetActivationFactory', 'RoActivateInstance',
    'WindowsCreateString', 'WindowsCreateStringReference', 'WindowsDeleteString',
    'WindowsGetStringRawBuffer', 'WindowsDuplicateString', 'WindowsIsStringEmpty',
    'WindowsCompareStrings', 'WindowsDeleteStringBuffer', 'WindowsPreallocateStringBuffer',
  ]),
  'shcore.dll': new Set(['*']),
};

// Subsystem version the Win7 loader accepts (6.1 = Win7, 6.0 = Vista). Anything
// above is rejected outright with "not a valid Win32 application", before any of
// the code above runs — which is why the ANGLE/Chromium M110 floor is fatal there.
const MAX_WIN7_SUBSYSTEM = 6.1;

export function auditPe(p: PeInfo): string[] {
  const bad: string[] = [];
  for (const dll of p.dlls) {
    const key = dll.toLowerCase();
    if (WIN8_PLUS_DLLS.has(key)) bad.push(`imports ${dll} (not present on Windows 7 SP1)`);
    const deny = WIN8_PLUS_SYMBOLS[key];
    if (!deny) continue;
    for (const sym of p.funcs[dll] || []) {
      if (deny.has('*') || deny.has(sym)) bad.push(`${dll}!${sym} (Win8+ entry point)`);
    }
  }
  const [maj, min] = p.subVer.split('.').map(Number);
  if (maj + min / 10 > MAX_WIN7_SUBSYSTEM) {
    bad.push(`subsystem version ${p.subVer} > ${MAX_WIN7_SUBSYSTEM} (Win7 loader refuses the image)`);
  }
  if (p.subsystem !== 2 && p.subsystem !== 3) {
    bad.push(`subsystem ${p.subsystem} is neither GUI (2) nor console (3)`);
  }
  return bad;
}

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stderr.write('usage: node scripts/win7-imports.ts [--json] <exe-or-dll> [more...]\n');
    return 2;
  }
  let failed = false;
  const report: unknown[] = [];
  for (const file of files) {
    const p = peImports(file);
    const bad = auditPe(p);
    if (bad.length) failed = true;
    if (json) {
      report.push({ file, subsystem: p.subsystem, subVer: p.subVer, osVer: p.osVer, pe32plus: p.pe32plus, dlls: p.dlls, funcs: p.funcs, problems: bad });
      continue;
    }
    const total = Object.values(p.funcs).reduce((n, f) => n + f.length, 0);
    process.stdout.write(`${file}\n`);
    process.stdout.write(`  ${p.pe32plus ? 'PE32+' : 'PE32'} subsystem ${p.subsystem} subVer ${p.subVer} osVer ${p.osVer}\n`);
    process.stdout.write(`  ${p.dlls.length} DLLs, ${total} imported symbols\n`);
    if (bad.length) {
      for (const msg of bad) process.stdout.write(`  FAIL ${msg}\n`);
    } else {
      process.stdout.write(`  PASS no Win8+/Win10+ import; loader checks pass\n`);
    }
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return failed ? 1 : 0;
}

// Run only when invoked as a program: test/unit/win7.ts imports the pure parts
// (`auditPe` and the tables) and must not trigger a verdict on its own argv.
const invoked = (process.argv[1] ?? '').endsWith('win7-imports.ts');
if (invoked) process.exit(main(process.argv.slice(2)));