// Unit checks: the setjmp/longjmp pair every recovery point and the FRE entry
// points go through.
//
// Measured on arm64 Darwin (temp/frebench/sj4.c, 2M iterations):
//
//   setjmp           225.8 ns      <- one sigprocmask syscall
//   sigsetjmp(env,1) 222.8 ns
//   sigsetjmp(env,0)   2.5 ns
//   _setjmp            2.4 ns
//
// setjmp() saves and restores the signal mask; nothing in this runtime installs a
// handler whose mask would need restoring, so the mask half is pure cost. It sat
// on two hot paths -- every FREDispatchStatusEventAsync and every
// ExtensionContext.call -- so the runtime now goes through AS_SETJMP/AS_LONGJMP,
// which is the mask-free pair on Darwin/Linux and the plain pair on Windows and
// the two wasm targets (whose libc never touched the mask).
//
// Two things a pass/fail run cannot see, hence a pin:
//
//   1. The PAIRING. `_setjmp` resumed by `longjmp` (or the reverse) links fine and
//      usually still works, so a single careless edit reintroduces the syscall or
//      a mismatched restore with no symptom except 220 ns.
//   2. The register-spill site. gc_mark_stack uses setjmp ONLY to spill
//      callee-saved registers onto the stack for the conservative scan and never
//      resumes from it; if it were quietly turned into something that saves fewer
//      registers (or deleted), GC would silently lose roots. Verified on arm64
//      Darwin that _setjmp writes the same x19/x20/x28 slots as setjmp
//      (temp/frebench/jb.c), which is what makes that substitution safe.
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

// One top-level C function: from its signature to the first closing brace at
// column 0 (emitted functions are not indented).
function funcBody(c: string, signature: string): string {
  const start = c.indexOf(signature);
  if (start < 0) return '';
  const end = c.indexOf('\n}', start);
  return end < 0 ? c.slice(start) : c.slice(start, end + 2);
}

// Everything that is not a preprocessor line and not a comment. The macro
// DEFINITIONS legitimately spell the plain names (`#define AS_SETJMP(e)
// setjmp(e)` on Windows), so they must be excluded from the "no bare call" scan.
function callSites(c: string): string {
  return c
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*\/\//.test(l))
    .join('\n');
}

function checkSetjmpPair(): string[] {
  const failed: string[] = [];
  const check = (label: string, ok: boolean): void => {
    if (!ok) failed.push(label);
  };

  // ---- the macros themselves ----
  check('the preamble defines both halves of the pair',
    /#define AS_SETJMP\(e\)/.test(RUNTIME_PREAMBLE)
    && /#define AS_LONGJMP\(e, v\)/.test(RUNTIME_PREAMBLE));
  // The split is the whole point: mask-free where the mask save costs a syscall,
  // plain where it never did (so the BSD extension is not a new dependency).
  check('POSIX takes the mask-free pair',
    /#else\s*\n#define AS_SETJMP\(e\)\s+_setjmp\(e\)\s*\n#define AS_LONGJMP\(e, v\)\s+_longjmp\(e, v\)/
      .test(RUNTIME_PREAMBLE));
  check('Windows and the wasm targets keep the plain pair',
    /#define AS_SETJMP\(e\)\s+setjmp\(e\)\s*\n#define AS_LONGJMP\(e, v\)\s+longjmp\(e, v\)/
      .test(RUNTIME_PREAMBLE));
  check('...and that branch is the one gated on _WIN32/__EMSCRIPTEN__/__wasi__',
    /#if defined\(_WIN32\) \|\| defined\(__EMSCRIPTEN__\) \|\| defined\(__wasi__\)\s*\n#define AS_SETJMP/.test(RUNTIME_PREAMBLE));

  // ---- the throw path: every resume uses the matching half ----
  const throwVal = funcBody(RUNTIME_PREAMBLE, 'static _Noreturn void as_throw_val(as_value v) {');
  const throwObj = funcBody(RUNTIME_PREAMBLE, 'static _Noreturn void as_throw(void* e) {');
  check('as_throw_val is found', throwVal !== '');
  check('as_throw is found', throwObj !== '');
  for (const [name, body] of [['as_throw_val', throwVal], ['as_throw', throwObj]] as const) {
    check(`${name}: resumes through AS_LONGJMP`,
      body.includes('AS_LONGJMP(as_frame_jmp, 1);')
      && body.includes('AS_LONGJMP(*as_jmp_stack[as_jmp_depth - 1], 1);'));
    check(`${name}: never calls bare longjmp`,
      !/(^|[^_A-Z])longjmp\(/.test(callSites(body)));
  }

  // ---- the spill site: it is not a recovery point at all ----
  const stack = funcBody(RUNTIME_PREAMBLE, 'static void gc_mark_stack(void) {');
  check('gc_mark_stack is found', stack !== '');
  check('gc_mark_stack saves registers through AS_SETJMP (never resumed)',
    stack.includes('AS_SETJMP(jb);') && !stack.includes('AS_LONGJMP'));
  check('...and still walks the live stack region it spilled onto',
    stack.includes('for (char* p = lo; p < gc_stack_top; p += sizeof(void*))'));

  // ---- nothing anywhere in the preamble still calls the plain pair ----
  // Comments are exempt (they quote the measurement); preprocessor lines are
  // exempt (they are the definitions).
  const bare = callSites(RUNTIME_PREAMBLE).match(/(^|[^_A-Z])(setjmp|longjmp)\(/g);
  check('the preamble has no bare setjmp/longjmp call left'
    + (bare === null ? '' : ` (found ${bare.length})`), bare === null);

  // ---- the same holds for emitted code ----
  // try/catch is the emitted recovery point, and the frame callbacks
  // (mouse/wheel/key/frame/resize/close) each plant one.
  const c = generateC(parse('try { trace(1); } catch (e:Error) { trace(2); }')).c;
  const emitted = callSites(c);
  check('emitted C has no bare setjmp either', !/(^|[^_A-Z])setjmp\(/.test(emitted));
  check('emitted try/catch resumes a buffer the macro saved',
    /int \w+ = AS_SETJMP\(\w+\);/.test(c));
  check('the frame entry points plant through the macro',
    c.split('AS_SETJMP(as_frame_jmp)').length - 1 === 7);

  if (failed.length !== 0) console.log('     [setjmp] ' + failed.length + ' check(s) failed');
  return failed;
}

registerGroup('unit: runtime/SetjmpPair', checkSetjmpPair);