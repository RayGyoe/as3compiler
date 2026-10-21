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
import { readFileSync } from 'node:fs';

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
  return (
    readFileSync(join(root, 'vendor', 'skia_glue.cc'), 'utf8') +
    '\n' +
    readFileSync(join(root, 'vendor', 'skia_text_glue.cc'), 'utf8')
  );
}
