// Test entry — the documented full regression:
//   node test.ts        examples (compile -> link -> run) + every unit group
//   npm run test:unit   unit groups only, filterable with --test-name-pattern
//
// Both layers are node:test cases registered by the imported modules; node:test
// runs them one at a time in registration order and exits non-zero on any failure.
// See test/harness.ts for the group adapter and test/unit/* for the moved checks.
import './test/examples.ts';
import './test/unit.ts';
