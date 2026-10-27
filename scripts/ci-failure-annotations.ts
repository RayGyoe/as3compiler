// Turn a failed regression log into GitHub workflow commands.
//
// Why this exists: the run logs are admin-only over the REST API, and node's
// `spec` reporter does not emit `::error::` for a failing test by itself, so a
// red CI run answered only "Process completed with exit code 1" -- 5000 lines of
// log we cannot read from outside and no way to name the test that broke. This
// parses the log we already wrote and re-emits each failure as an annotation,
// which IS readable anonymously from the check run.
//
// Usage: node scripts/ci-failure-annotations.ts <log-path>
// Emits nothing (exit 0) when the log holds no recognisable failure marker, so a
// flaky-infrastructure failure still surfaces the log tail below.

import { readFileSync } from 'node:fs';

const FAIL_MARK = /^(?:✖\s+(.*)|not ok\s+\d+\s+-\s+(.*))$/;
const SUMMARY = /^ℹ fail (\d+)$/;
const TAIL_LINES = 120;

/** Escape a value for a workflow command: `%`, CR and LF are the only ones GitHub parses. */
function esc(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/ci-failure-annotations.ts <log-path>');
    process.exit(2);
  }
  let log: string;
  try {
    log = readFileSync(path, 'utf8');
  } catch (e) {
    console.log(`::error::could not read the regression log at ${path}: ${(e as Error).message}`);
    return;
  }
  const lines = log.split('\n');

  // Failing test names, de-duplicated: the spec reporter prints a failing case
  // once in its suite tree and again in the summary block, and we want one
  // annotation per distinct test.
  const names: string[] = [];
  const seen = new Set<string>();
  let failCount = 0;
  for (const line of lines) {
    const s = SUMMARY.exec(line.trim());
    if (s) failCount = Number(s[1]);
    const m = FAIL_MARK.exec(line.trim());
    if (!m) continue;
    // `✖ name (12.3ms)` -- drop the duration, it is noise in an annotation title.
    const name = (m[1] ?? m[2] ?? '').replace(/\s+\(\d+(?:\.\d+)?ms\)$/, '').trim();
    // The spec reporter opens the summary block with a bare `✖ failing tests:`
    // header, which matches the same prefix. A real case name never ends in ':'.
    if (!name || name.endsWith(':') || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  for (const name of names.slice(0, 25)) {
    // No `file=` -- the failing unit is an example or a group, neither of which
    // maps to a line in the checkout, and a wrong path renders worse than none.
    console.log(`::error title=${esc(name)}::${esc(name)}`);
  }
  if (names.length > 25) {
    console.log(`::error::${names.length - 25} further failing case(s) omitted; see the test-log artifact`);
  }
  if (names.length === 0) {
    console.log(
      `::error::no failing test marker found in the log (fail count ${failCount}); ` +
        'the run died before the suite reported -- see the tail below and the test-log artifact',
    );
  }

  // The last lines carry the crash / link error that a marker-free failure
  // leaves behind (a segfaulting example, an `ld` OOM, a timeout).
  console.log('---- log tail ----');
  console.log(lines.slice(-TAIL_LINES).join('\n'));
}

main();