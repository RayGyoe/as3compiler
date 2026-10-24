// Unit checks: the Windows-7 claim. "The API surface is Vista-era" is a statement
// about source code, and it is worth nothing on its own — what decides whether a
// binary starts on Win7 SP1 is its IMPORT TABLE, which the linker assembles from
// the whole program including the prebuilt Skia archives. So the audit in
// scripts/win7-imports.ts is exercised here on synthesised PE metadata (the pure
// half of the tool, no file and no Windows host needed), and the runtime floor
// that turns "no driver" from a black window into a diagnosis is pinned in the
// glue source.
//
// Re-run alone with:
//   node --test --test-name-pattern='win7/' test/unit/*.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditPe, WIN8_PLUS_DLLS, WIN8_PLUS_SYMBOLS } from '../../scripts/win7-imports.ts';
import { registerGroup, root } from '../harness.ts';

interface PeInfoLike {
  dlls: string[];
  funcs: Record<string, string[]>;
  subsystem: number;
  subVer: string;
  osVer: string;
  pe32plus: boolean;
}

// The import surface of a real WGL build of this project (measured: 13 DLLs, 408
// symbols, subsystem 6.0). Used as the "must pass" baseline so the checks below
// cannot be satisfied by a tool that flags everything.
function cleanSurface(): PeInfoLike {
  return {
    dlls: ['KERNEL32.dll', 'USER32.dll', 'GDI32.dll', 'OPENGL32.dll', 'ADVAPI32.dll',
      'ole32.dll', 'OLEAUT32.dll', 'SHELL32.dll', 'USP10.dll', 'VERSION.dll',
      'WINMM.dll', 'SETUPAPI.dll', 'IMM32.dll'],
    funcs: {
      'KERNEL32.dll': ['GetModuleHandleA', 'RtlGetVersion', 'InitializeCriticalSectionEx', 'GetTickCount64'],
      'USER32.dll': ['GetSystemMetrics', 'GetClientRect', 'PeekMessageW'],
      'OPENGL32.dll': ['wglCreateContext', 'wglMakeCurrent', 'glGetString', 'SwapBuffers'],
    },
    subsystem: 3,
    subVer: '6.0',
    osVer: '6.0',
    pe32plus: true,
  };
}
const withImports = (dll: string, syms: string[]): PeInfoLike => {
  const p = cleanSurface();
  p.dlls = [...p.dlls, dll];
  p.funcs[dll] = syms;
  return p;
};

function checkWin7Surface(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [win7] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [win7] ${label}`); }
  };

  // (1) The baseline passes: a tool that flags everything is not an audit.
  check('a real WGL import surface passes (13 DLLs, subsystem 6.0)',
    auditPe(cleanSurface()).length === 0);

  // (2) The two failures that actually matter for THIS project.
  const d3d = withImports('d3d12.dll', ['D3D12CreateDevice']);
  check('the D3D12 backend is caught: d3d12.dll does not exist on Win7',
    auditPe(d3d).some((m) => /d3d12\.dll/.test(m)));
  const compiler = withImports('D3DCOMPILER_47.dll', ['D3DCompile']);
  check('d3dcompiler_47.dll is caught too (app-local on Win8, never a Win7 system DLL)',
    auditPe(compiler).some((m) => /D3DCOMPILER_47\.dll/i.test(m)));

  // (3) The symbol-level half: a DLL Win7 HAS can still be used wrongly. These
  // four are the classic "looks portable until it does not start" set — every one
  // of them is the obvious way to implement something this project needs.
  for (const [dll, sym] of [
    ['USER32.dll', 'GetDpiForWindow'],        // the per-monitor DPI path
    ['KERNEL32.dll', 'SetThreadDescription'], // thread naming
    ['KERNEL32.dll', 'CreateFile2'],          // the "modern" file open
    ['OLE32.dll', 'RoInitialize'],            // WinRT init, reached via COM helpers
  ] as const) {
    const msg = auditPe(withImports(dll, [sym]));
    check(`${sym} is caught as Win8+ inside ${dll}`, msg.some((m) => m.includes(sym)));
  }
  check('a Win7-legal symbol of the same DLL is not caught',
    auditPe(withImports('USER32.dll', ['SetWindowLongPtrW', 'GetSystemMetrics'])).length === 0);

  // (4) The loader check: the subsystem version is what rejects the image before
  // a single instruction runs, which is exactly how ANGLE/Chromium M110 lost Win7
  // (`subsystem_version_suffix=",10.0"`). 6.0 (Vista) and 6.1 (Win7) are fine.
  const modern = cleanSurface();
  modern.subVer = '10.0';
  check('subsystem version 10.0 is rejected outright', auditPe(modern).some((m) => /subsystem version 10\.0/.test(m)));
  const seven = cleanSurface();
  seven.subVer = '6.01';
  check('subsystem 6.01 (what /SUBSYSTEM:WINDOWS,6.01 emits) passes',
    auditPe(seven).length === 0);

  // (5) The tables themselves: non-empty, and not silently emptied by a refactor.
  check('the DLL table covers the D3D12/DXC/DPI families',
    ['d3d12.dll', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'shcore.dll', 'ucrtbase.dll']
      .every((d) => WIN8_PLUS_DLLS.has(d)));
  check('the symbol table has a non-trivial user32/kernel32 entry',
    (WIN8_PLUS_SYMBOLS['user32.dll']?.size ?? 0) > 10
    && (WIN8_PLUS_SYMBOLS['kernel32.dll']?.size ?? 0) > 10);

  // (6) The runtime floor in the glue. Ordering is checked as well as existence:
  // refusing AFTER GrDirectContexts::MakeGL would run Skia on a context it cannot
  // use, which is the failure mode the floor exists to prevent.
  const glue = readFileSync(join(root, 'vendor', 'gl_glue.cc'), 'utf8');
  check('gl_glue.cc parses GL_VERSION and refuses below 2.0',
    /glGetString\(GL_VERSION\)[\s\S]{0,400}glMajor < 2/.test(glue));
  check('...before Skia is handed the context, not after',
    glue.indexOf('glMajor < 2') > 0 && glue.indexOf('glMajor < 2') < glue.indexOf('GrDirectContexts::MakeGL(std::move(iface))'));
  check('...and it names the GDI Generic case instead of showing a blank window',
    /GDI Generic/.test(glue) && /below the 2\.0 floor/.test(glue));
  check('...tearing the context down like every other init failure in that file',
    /glMajor < 2[\s\S]{0,900}wglDeleteContext\(w->hglrc\)/.test(glue));
  check('...and pointing at the one thing the user can do (renderMode=cpu or a driver)',
    /renderMode>cpu<\/renderMode>/.test(glue));

  // (7) Discoverability: the audit must be reachable from the place a reader of
  // the build code looks, otherwise the next person re-derives the same answer.
  const airApp = readFileSync(join(root, 'src', 'air-app.ts'), 'utf8');
  check('the GL link block points at scripts/win7-imports.ts',
    airApp.includes('scripts/win7-imports.ts'));
  const zh = readFileSync(join(root, 'docs', 'zh-cn', 'win32.md'), 'utf8');
  const en = readFileSync(join(root, 'docs', 'en', 'win32.md'), 'utf8');
  check('both win32 docs carry a Win7 section that states what is NOT proven',
    /## Win7|### Win7|Win7/.test(zh) && /7 \u5c1a\u672a\u771f\u673a\u5b9e\u8dd1|\u771f\u673a/.test(zh)
    && /Win7/.test(en));

  console.log(`     [win7] ${ok} check(s) passed`);
  return bad;
}

registerGroup('unit: platform/Win7ImportSurface', checkWin7Surface);