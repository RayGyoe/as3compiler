// Test entry — the documented full regression:
//   node test.ts        examples (compile -> link -> run) + every unit group
//   npm run test:unit   unit groups only, filterable with --test-name-pattern
//
// Both layers are node:test cases registered by the imported modules, and
// node:test exits non-zero on any failure. See test/harness.ts for the group
// adapter and test/unit/* for the moved checks.
//
// The example layer runs CONCURRENTLY (阶段一百五十一): test/examples.ts spawns
// its units asynchronously and hangs them off a suite with `concurrency: JOBS`,
// which is what makes this whole command minutes instead of tens of minutes.
// node:test's own top-level tests are strictly serial, so the unit groups below
// still run one at a time — that is deliberate, they are in-process CPU work and
// JS is single-threaded, so fanning them out would buy nothing.
// ASC_TEST_JOBS=1 restores the original fully serial example order.
import './test/examples.ts';
import './test/unit.ts';
