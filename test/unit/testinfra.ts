// Unit group: the regression driver's own structural invariants.
//
// The example layer is the entire cost of `node test.ts`: ~190 compile -> link ->
// run subprocess units. It only overlaps because of two facts that are invisible
// from a green run and trivially undone by accident:
//   1. the spawn is ASYNC (`execFile`) — the synchronous form pins the single JS
//      thread for the child's whole lifetime, so the pool degenerates to running
//      one unit at a time;
//   2. the cases sit under a suite with `concurrency > 1` — `node:test` runs
//      TOP-LEVEL tests strictly serially (each is awaited before the next starts),
//      so a per-test option cannot help; a parent suite is the only lever.
// Reverting either one turns the suite from ~3 min back into ~13 min with every
// assertion still passing — precisely the silent regression that AGENTS.md §2.7
// says has to be pinned in test/unit/ rather than left to the example suite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

function checkExampleDriverConcurrency(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [testinfra] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [testinfra] ${label}`); }
  };
  const src = readFileSync(join(root, 'test', 'examples.ts'), 'utf8');
  // The async spawn is the whole mechanism: with the sync form the pool's awaits
  // never get a chance to interleave, so the run stays one unit at a time.
  check('the example driver spawns asynchronously (execFile, not the sync form)',
    /import \{ execFile \} from 'node:child_process'/.test(src) && !/\bexecFileSync\s*\(/.test(src));
  // …and the concurrency has to be a SUITE option, because top-level tests are
  // serial: `describe(…, { concurrency: JOBS }, …)` is what makes siblings overlap.
  check('the example cases hang off a suite with concurrency: JOBS',
    /concurrency:\s*JOBS/.test(src));
  // The default must stay bounded by the core count — each child is a `cc -O2`
  // link over ~20 MB of static libraries, so unbounded fan-out is a memory bet.
  check('the default job count is min(availableParallelism(), 6)',
    /Math\.min\(availableParallelism\(\), 6\)/.test(src));
  // The escape hatch is load-bearing for diagnosis: it is how a red suspected of
  // being concurrency-induced gets re-run against the exact pre-change order.
  check('the job count is overridable via ASC_TEST_JOBS (1 = original serial order)',
    src.includes('ASC_TEST_JOBS'));
  if (ok > 0) console.log(`[testinfra] ${ok} example-driver concurrency checks passed`);
  return bad;
}

registerGroup('unit: testinfra/ExampleDriver', checkExampleDriverConcurrency);
