// Unit checks: inline-degradation guards for the helper calls the emitter
// splices into hot loops.
//
// A recurring failure mode here (three times now): a small helper that a loop
// calls grows one more arm, crosses clang's inline cost budget, and from then on
// the loop pays an out-of-line call per iteration. The examples suite cannot see
// it -- the program still prints the right answer, just slower -- so the guard
// has to look at the compiler's own output.
//
// The three occurrences, for the record: as_req_obj (fixed with _Noreturn),
// as_v_int_cast (fixed by adding the cheap cast spelling), and 阶段一百三十四's
// as_v_to_number, which grew the tag==4 (object -> valueOf/toString) and tag 5/7
// (undefined/function -> NaN) arms. That pushed it to cost 250, past the 225
// budget, so as_add_v's calls to it turned into out-of-line calls and
// benchmarks/array's 20M-iteration `sum += a[j]` went 117 ms -> 193 ms (the
// ToNumber call was paid once per operand, 40M times). The fix gives as_add_v a
// tag 1/2 fast path (same shape as as_v_int_cast) so the statically-Number
// operand is folded and only the genuinely-dynamic one still calls out.
//
// emit/DynamicSlotCoercion pins the *source* shape (the fast path exists and
// delegates). This group adds the *assembly* half: build the hot loop at -O2 and
// assert the fold actually happened. The diagnostic when it does not:
//   cc -O2 -S -Rpass-missed=inline x.c 2>&1 | grep as_v_to_number
// (a clang upgrade can shift the cost/threshold numbers; the assertion below is
// deliberately on the emitted calls, not on the remark text).
//
//
// 阶段一百四十一 (2026-10-12) added two more of the same shape, both in the GC
// allocator (benchmarks/binarytrees +13%, benchmarks/strings +12%):
//
//   * gc_write_barrier. Its body was byte-identical to the v0.4.93 build, but
//     clang had begun inlining gc_in_heap (cost 135) into it, which pushed the
//     barrier to cost 275 -- past the 225 budget -- so all 584 of its call sites
//     paid an out-of-line call (make() alone went 0 -> 3, binarytrees 118 -> 112 ms
//     with the split). The fix keeps the expensive half in the out-of-line
//     gc_write_barrier_slow, reached through a volatile function pointer: a plain
//     gc_write_barrier_slow(p) call, or merely a second direct call site, both
//     pull the slow path back inline (its cost is inherited by the wrapper, and
//     the "last call to static" bonus evens out once only one site survives DCE).
//     An indirect call through a volatile pointer is immune to both.
//
//   * gc_audit_gate. Off by default, it was still *called* once per allocation and
//     once per free-list node visited; the calls alone cost ~7% of
//     benchmarks/strings and ~8% of benchmarks/binarytrees. Its call sites now
//     test the cached flag (gc_audit_mode_cache) themselves, so the off case is a
//     load and a branch. -1 still falls through to the gate, which resolves it.
//
//   node --test --test-name-pattern='inline/' test/unit/*.ts

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// The array benchmark's hot loop, verbatim in shape: `sum += a[j]` where a[j] is
// boxed (dynamic) and sum is int, so the emitter must route the + through
// as_add_v. The only dynamic operand is the array element, so exactly ONE
// out-of-line ToNumber call may survive in the loop body.
const HOT_LOOP_SRC = 'var N:int = 20000000;\n'
  + 'var a:Array = [];\n'
  + 'var i:int = 0;\n'
  + 'while (i < N) { a.push((i * 31) % 997); i++; }\n'
  + 'var sum:int = 0;\n'
  + 'var j:int = 0;\n'
  + 'while (j < N) { sum += a[j]; if (sum >= 1000000000) { sum -= 1000000000; } j++; }\n'
  + 'trace("result=" + sum);\n';

// Compile a generated C string to assembly, returning { asm, stderr } or null
// when the toolchain is missing or rejects the file. -S only: no link, so the
// vendored libs' -l/-I flags are not needed (the examples suite builds the real
// link line; here we only want clang's inlining decisions).
function compileToAsm(cSource: string, tag: string): { asm: string; stderr: string } | null {
  const scratch = join(root, 'temp', 'unit-inline');
  mkdirSync(scratch, { recursive: true });
  const cfile = join(scratch, `${tag}.c`);
  const sfile = join(scratch, `${tag}.s`);
  writeFileSync(cfile, cSource);
  const r = spawnSync('cc', ['-O2', '-S', '-o', sfile, cfile], { encoding: 'utf8', timeout: EXAMPLE_TIMEOUT_MS });
  if (r.error || r.status !== 0) return null;
  return { asm: readFileSync(sfile, 'utf8'), stderr: r.stderr ?? '' };
}

// The body of one function label, from `_name:` to the next top-level label.
// Mach-O prefixes C symbols with '_' (ELF does not), and both emit local labels
// that start with 'L' (LBB0_8:) or '.L' -- neither is a function boundary.
function functionBody(asm: string, symbol: string): string | null {
  const lines = asm.split('\n');
  const header = new RegExp(`^_?${symbol}:`);
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  const fnLabel = /^(?!\.?L)[_A-Za-z][A-Za-z0-9_]*:$/;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) { if (fnLabel.test(lines[j])) { end = j; break; } }
  return lines.slice(start, end).join('\n');
}

// Out-of-line calls to a helper, matched across the assembler spellings:
// arm64 `bl`, x86-64 `call`/`callq`, plus the tail-call `b`. A call inside a
// loop body is what costs; an inlined helper leaves no mnemonic at all.
function callCount(body: string, symbol: string): number {
  const re = new RegExp(`^\\s*(?:bl|b|callq?)\\s+_?${symbol}\\b`, 'm');
  return body.split('\n').filter((l) => re.test(l)).length;
}

function checkInlineHotPath(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [inline] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [inline] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

  // 1. The source fast path must exist. Reverting as_add_v to a bare
  //    `as_v_to_number(a) + as_v_to_number(b)` is precisely the 阶段一百三十四
  //    regression, and it is invisible to every other test.
  check('as_add_v folds the tag 1/2 operands instead of calling ToNumber on them',
    /double na = \(a\.tag == 1 \|\| a\.tag == 2\) \? a\.num : as_v_to_number\(a\);/.test(pre)
    && /double nb = \(b\.tag == 1 \|\| b\.tag == 2\) \? b\.num : as_v_to_number\(b\);/.test(pre));
  check('as_add_v still delegates every other tag to as_v_to_number',
    /static as_value as_add_v\(as_value a, as_value b\) \{/.test(pre));
  // The sibling spellings must keep their fast paths too -- same trap, and the
  // emitter emits them at every dynamic->int/uint coercion site.
  check('as_v_int_cast/as_v_uint_cast keep their tag 1/2 fast paths',
    pre.includes('if (v.tag == 1 || v.tag == 2) return as_to_int32(v.num);')
    && pre.includes('if (v.tag == 1 || v.tag == 2) return as_to_uint32(v.num);'));

  // 2. The generated C must actually route this loop through as_add_v, otherwise
  //    the assembly assertions below would pass vacuously.
  const c = generateC(parse(HOT_LOOP_SRC)).c;
  check('the hot loop routes the dynamic + through as_add_v (non-vacuous guard)',
    c.includes('as_add_v(') && c.includes('as_array_get('));

  // 3. The assembly half: build it and read back clang's decisions.
  const built = compileToAsm(c, 'hotloop');
  check('the hot-loop C compiles to assembly with cc -O2 -S', built !== null);
  if (built) {
    const main = functionBody(built.asm, 'main');
    check('main is emitted (the top-level loop is not a separate function)', main !== null);
    if (main) {
      // as_add_v itself must be inlined into the loop, not called.
      check('as_add_v is inlined into main (no out-of-line as_add_v call)',
        callCount(main, 'as_add_v') === 0);
      // And its numeric fast path must have folded the statically-Number operand:
      // one surviving ToNumber call (the dynamic array element), not two (one per
      // operand -- the pre-fix shape that cost 117 ms -> 193 ms).
      const calls = callCount(main, 'as_v_to_number');
      check(`main pays at most one out-of-line ToNumber call (the dynamic operand), got ${calls}`,
        calls <= 1);
    }
  }

  console.log(`     [inline] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: inline/HotPath', checkInlineHotPath);

// The allocation-write shape that made binarytrees regress: a class whose fields
// are object references, so every field write goes through gc_write_barrier. 247
// such call sites in the generated C is enough to see whether clang inlined them.
const WB_PROBE_SRC = 'class Node {\n'
  + '  public var left:Node;\n'
  + '  public var right:Node;\n'
  + '  public var value:int;\n'
  + '  public function Node(l:Node, r:Node, v:int) { this.left = l; this.right = r; this.value = v; }\n'
  + '}\n'
  + 'var root:Node = null;\n'
  + 'var i:int = 0;\n'
  + 'while (i < 2000) { root = new Node(root, null, i); i++; }\n'
  + 'trace("ok=" + (root != null));\n';

function checkWriteBarrierInline(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [inline] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [inline] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

  // 1. The structural split: the expensive half out of line, reached only through
  //    a volatile function pointer (volatile so clang cannot devirtualise it, and
  //    the address escaping stops the unary-call-site inlining bonus).
  check('gc_write_barrier_slow holds the whole slow path (the segment check)',
    /static void gc_write_barrier_slow\(void\* p\) \{\s*if \(p == NULL \|\| !gc_in_heap\(p\)\) return;/.test(pre));
  check('the slow path is taken through a volatile function pointer',
    pre.includes('static void (*volatile gc_write_barrier_slow_fn)(void*) = gc_write_barrier_slow;'));
  check('gc_write_barrier is a two-line wrapper: state test, then indirect call',
    /static void gc_write_barrier\(void\* p\) \{\s*if \(gc_inc\.state != GC_MARK\) return;\s*gc_write_barrier_slow_fn\(p\);\s*\}/.test(pre));
  // The wrapper must NOT carry the slow path itself -- that is the 275-cost shape.
  const wrapper = pre.slice(pre.indexOf('static void gc_write_barrier(void* p) {'));
  check('the wrapper does not inline gc_in_heap (the shape that reached cost 275)',
    !wrapper.slice(0, wrapper.indexOf('}')).includes('gc_in_heap'));

  // 2. Non-vacuity: this program really does write GC pointers through the
  //    barrier, so the assembly assertion below cannot pass by having no call
  //    sites at all.
  const c = generateC(parse(WB_PROBE_SRC)).c;
  const cSites = (c.match(/gc_write_barrier\(/g) ?? []).length;
  check(`the probe emits gc_write_barrier at many call sites (got ${cSites})`, cSites >= 100);

  // 3. The assembly half: clang must fold the barrier everywhere. Reverse check
  //    on this same file with the wrapper reverted to its pre-fix body: 274
  //    out-of-line calls (0 with the split).
  const built = compileToAsm(c, 'writebarrier');
  check('the write-barrier probe compiles to assembly with cc -O2 -S', built !== null);
  if (built) {
    const calls = callCount(built.asm, 'gc_write_barrier');
    check(`every gc_write_barrier call site is inlined (out-of-line calls: ${calls})`, calls === 0);
    // Mach-O prefixes C symbols with '_'; COFF and ELF do not. The invariant is
    // "the inlined form still reaches the slow path through the pointer", which
    // is a reference to the symbol wherever the assembler names it.
    const slowRefs = (built.asm.match(/(?:^|[^\w])_?gc_write_barrier_slow_fn\b/g) ?? []).length;
    check(`the inlined form reaches the slow path via the pointer (refs: ${slowRefs})`, slowRefs > 0);
    // The slow path itself must stay out of line: if it were inlined everywhere
    // the pointer indirection would just be a detour.
    check('gc_write_barrier_slow is not inlined (it stays one function)',
      functionBody(built.asm, 'gc_write_barrier_slow') !== null);
  }

  console.log(`     [inline] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: inline/WriteBarrier', checkWriteBarrierInline);

// The other half of the same round: a diagnostic that must cost nothing while it
// is off (the default). Its call sites -- once per allocation, once per free-list
// node visited, once per swept object -- each test the cached mode flag first.
// Deleting one of those guards is invisible to every other test: the program still
// runs and prints the same answer, just ~7-8% slower.
function checkAuditGateGuard(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [inline] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [inline] ${label}`); }
  };
  const pre = RUNTIME_PREAMBLE.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

  // The flag has to be defined before the allocation path uses it (were it
  // declared down with the audit code, the C would not even compile).
  const flagAt = pre.indexOf('static int gc_audit_mode_cache = -1;');
  const allocAt = pre.indexOf('static void* gc_alloc(int type, size_t size) {');
  check('gc_audit_mode_cache is defined above gc_alloc', flagAt >= 0 && allocAt > flagAt);

  // Every gate call must be preceded by the inline flag test. -1 (unresolved)
  // also calls through, so the audit still resolves and reports when it is on.
  const sites = pre.match(/[^;]*gc_audit_gate\("[^"]+", [^;]+;/g) ?? [];
  check(`found the gate call sites (${sites.length})`, sites.length >= 3);
  const guarded = sites.filter((s) => s.includes('if (gc_audit_mode_cache != 0) '));
  check(`every gc_audit_gate call site tests the cached flag first (${guarded.length}/${sites.length})`,
    sites.length >= 3 && guarded.length === sites.length);
  // ... and the flag test is what the gate itself re-checks, so an unresolved
  // cache (-1) must not be treated as "off".
  check('gc_audit_on resolves the cache from the environment',
    pre.includes('gc_audit_mode_cache = ((e != NULL && e[0] != \'0\') || (s != NULL && s[0] != \'0\')) ? 1 : 0;'));

  console.log(`     [inline] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: inline/AuditGate', checkAuditGateGuard);
