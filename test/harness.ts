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
