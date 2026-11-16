// Shared harness for the unit-check modules.
//
// test.ts grew into a 3904-line file holding both the example regression and 44
// `checkXxx(): string[]` groups. 阶段九十六·一 split it up: the groups keep their
// exact bodies (they print their own PASS/FAIL lines and return the labels that
// failed) and are registered here as node:test cases, so one group can be re-run
// with `node --test --test-name-pattern=<group> test/unit/*.ts`.
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// The package root. This file lives in <root>/test/, so the original
// `root = import.meta.dirname` (test.ts used to sit at the package root) is now
// one level up. Every moved check that resolves `join(root, 'examples'|'src'|...)`
// keeps working unchanged.
export const root = join(import.meta.dirname, '..');

// Two prelude constants that a few moved checks still close over: the examples
// directory (checks that read a sibling example's source for its golden strings)
// and the per-example timeout budget. Exported so the modules stay verbatim.
export const dir = join(root, 'examples');
export const EXAMPLE_TIMEOUT_MS = 60_000;

// Register one check group as a node:test case. A non-empty failure list becomes
// an assertion failure carrying the labels.
export function registerGroup(name: string, fn: () => string[]): void {
  test(name, () => {
    const bad = fn();
    assert.deepStrictEqual(bad, [], `${bad.length} check(s) failed in ${name}`);
  });
}

// Read a source file with line endings normalised to LF.
//
// .gitattributes only pins *.bat, so a Windows checkout is CRLF while CI (arm64
// macOS) is LF. Any pin whose regex spans lines (`...;\n  if (...)`,
// `\{\n ... glFlush();\n\}`) therefore passed on CI and failed here -- the pin
// was measuring the checkout, not the code. Normalise at the read, not by
// loosening every regex: `\r?` sprinkled around is easy to miss in one spot of
// a large alternation, and the miss is silent.
export function readNorm(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

// Flags every unit probe needs when it hands GENERATED C to `cc`.
//
// The generated translation unit includes <zlib.h> on every non-wasm target, and a
// bare MSVC toolchain has no zlib on its search path: the vendored curl tree carries
// the header and the import library, exactly what a real build's manifest names. On
// a Windows checkout every probe that compiled generated C therefore answered
// `fatal error: 'zlib.h' file not found` -- a TEST-HOST gap, not a codegen defect
// (the same C compiles fine through `as-aot`). Empty where zlib is a system header
// (macOS/Linux), so the probes keep testing the plain default toolchain there.
//
// Split into an INCLUDE list and a LINK list on purpose: Windows has no `m.lib`
// (`-lm` is a hard link error there) and its zlib is the vendored `z.lib`, while
// macOS/Linux link the system `-lz`/`-lm`. Mixing them also breaks the
// zero-warning pin -- `-fsyntax-only` with a `-L` on the line makes clang warn
// `argument unused during compilation`.
export const PROBE_ZLIB_FLAGS: string[] = (() => {
  const inc = join(root, 'vendor', 'curl', 'include');
  return existsSync(join(inc, 'zlib.h')) ? ['-I', inc] : [];
})();

export const PROBE_ZLIB_LINK_FLAGS: string[] = (() => {
  if (process.platform !== 'win32') return ['-lz', '-lm'];
  const lib = join(root, 'vendor', 'curl', 'lib', `windows-${process.arch === 'ia32' ? 'x86' : 'x64'}`);
  return existsSync(join(lib, 'z.lib')) ? ['-L', lib, '-lz'] : [];
})();

// And the platform imports the generated C's DESKTOP/platform paths call: the
// Win32 entry points (`SHFileOperationW` from <shell32>, the window/menu/drag
// entry points from <user32>/<ole32>) and, on macOS, the two Apple frameworks the
// runtime declares by hand because its headers cannot be included at all
// (CoreFoundation for Capabilities.language and the idle assertion's CFString,
// IOKit for IOPMAssertionCreateWithName). A real build gets them from the manifest
// or from platformFrameworks(); a `cc gen.c -o probe` one-liner has nothing to read
// that from, so the probe list carries them per host.
//
// Both macOS entries are load-bearing since 阶段四百三十五: the idle setter is a
// non-static emitted function, so the probe object references CFRelease /
// CFStringCreateWithCString / IOPMAssertion* even when the program never touches
// systemIdleMode (the linker, not -O2, decides whether to keep it). That is a
// probe-only failure — the real link line carries platformFrameworks() — but it is
// the majority of the desktop probe suite, so it is fixed here rather than there.
export const PROBE_SYSTEM_LINK_FLAGS: string[] = process.platform === 'win32'
  // ws2_32 is here because the flash.net socket seam is REAL on Windows now
  // (ASC_SOCK_WIN, not the old inert stub): any probe whose generated C instantiates
  // the socket state machine imports setsockopt/WSAGetLastError, and lld-link reports
  // them as undefined without it -- a probe-only link failure that a real build never
  // sees (it gets ws2_32 from the CLI/manifest). iphlpapi is here for the same
  // reason: NetworkInfo.findInterfaces (ASC_NET_WIN32) imports GetAdaptersAddresses.
  ? ['-lshell32', '-luser32', '-lole32', '-ladvapi32', '-lws2_32', '-liphlpapi']
  : process.platform === 'darwin'
    ? ['-framework', 'CoreFoundation', '-framework', 'IOKit']
    : [];

// The Skia glue is TWO translation units since stage 221: vendor/skia_glue.cc is
// the graphics half and vendor/skia_text_glue.cc the text engine (SkParagraph +
// HarfBuzz + ICU), split so that a build whose program draws no text can leave the
// second one out of the link entirely -- one object file is linked whole, so while
// they shared one .o every Skia build resolved skia::textlayout::* and dragged
// ~13 MB in (docs/zh-cn/rust-text-backend.md).
//
// Source-level pins about the glue ask "what does the glue do", not "which half
// does it in", so they read the pair. The split itself is pinned separately
// (unit: build/TextEngineSplit), which is what keeps the two statements honest.
export function readGlue(): string {
  // Line endings are normalized to LF before the pair is joined. A Windows checkout
  // materialises CRLF (the repo pins LF only for *.bat -- see .gitattributes), so a
  // multi-line pin written as `;\n}` reported a fake failure on a tree whose glue
  // was perfectly fine. The pins ask what the glue does, never which newline it uses.
  const half = (name: string): string =>
    readFileSync(join(root, 'vendor', name), 'utf8').replace(/\r\n/g, '\n');
  return half('skia_glue.cc') + '\n' + half('skia_text_glue.cc');
}
