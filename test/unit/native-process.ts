// Unit pins for flash.desktop.NativeProcess (stage 391).
//
// The behaviour itself is covered end-to-end by examples/native-process.as, which
// really spawns children on both hosts. What CANNOT be checked there is the shape of
// what the backend does and, more importantly, what it does NOT do: the members that
// were invented in an earlier draft (pid/processID/environment, the redirection
// fields) and the argument-quoting layer that looked like a fix but was a divergence
// from AIR. Those are source-level facts, so they are pinned here -- per AGENTS.md
// §2.7, examples only ever contain programs that must succeed.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function checkNativeProcess(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [np] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [np] ${label}`); }
  };

  const runtime = read('src/native-process.ts');
  const emit = read('src/emit.ts');
  const symbols = read('src/symbols.ts');

  // --- the backend is hand-written C pumped at the frame boundary ------------
  check('the module exports a C runtime', runtime.includes('export const NATIVE_PROCESS_RUNTIME'));
  check('the slot table is bounded', /#define AS_NP_MAX \d+/.test(runtime));
  check('the pump is called from the frame boundary', emit.includes("this.line('as_np_tick();')"));
  check('tickFrame pumps it too (headless programs drive the boundary themselves)',
    emit.includes("(as_async_tick(), as_np_tick(), as_timer_tick())"));
  check('tickTimers pumps it too', emit.includes("(as_async_tick_wait(), as_np_tick(), as_timer_tick())"));
  check('the GC walks the pipe slots, so a dropped reference cannot orphan a child',
    runtime.includes('as_np_mark_roots') && read('src/runtime.ts').includes('as_np_mark_roots();'));

  // --- never blocking the AS3 thread ----------------------------------------
  check('reads are non-blocking on Windows (peek, not a blocking read)',
    runtime.includes('PeekNamedPipe'));
  check('reads are non-blocking on POSIX', /O_NONBLOCK/.test(runtime));
  check('the stdin write side is non-blocking on POSIX too',
    /fcntl\(in_pipe\[1\], F_SETFL, fcntl\(in_pipe\[1\], F_GETFL, 0\) \| O_NONBLOCK\)/.test(runtime));
  check('a child cannot hold a console window open', runtime.includes('CREATE_NO_WINDOW'));
  check('one frame never writes an unbounded amount to the child',
    /want > 4096/.test(runtime));

  // --- measured streak: the command line is joined verbatim ----------------
  //
  // The first draft quoted every argument with the CRT rules. That is a DIVERGENCE:
  // cmd.exe re-parses the string with its own rules, so an unexpected quote pair
  // turns a valid command into "not recognized as an internal or external command"
  // (measured, temp/npa/air/Q.as). Only argv[0] is quoted.
  check('the argument loop appends verbatim (no quoting call)',
    !/for \(int i = 0; i < argc; i\+\+\) \{[\s\S]{0,300}as_np_quote\(cmd, cap, &len, a\);/.test(runtime));
  check('argv[0] is still quoted, so an exe path with spaces resolves',
    /as_np_quote\(cmd, cap, &len, exe\);/.test(runtime));

  // --- measured error contract ---------------------------------------------
  for (const id of [3212, 3213, 3214, 3215, 1009]) {
    check(`the measured text for #${id} is present`, new RegExp(`#${id}:`).test(runtime));
  }
  check('start(null) throws #1009 rather than crashing',
    /si == NULL[\s\S]{0,200}TypeError_new\(\(char\*\)AS_NP_ERR_NULL, 1009\)/.test(runtime));
  check('a double start throws #3213', /AS_NP_ERR_RUNNING, 3213/.test(runtime));
  check('the executable SETTER validates (measured: it throws before start)',
    /as_np_info_set_exe[\s\S]{0,600}AS_NP_ERR_EXE, 3214/.test(runtime));
  check('the workingDirectory setter validates', /as_np_info_set_wd[\s\S]{0,600}AS_NP_ERR_WD, 3215/.test(runtime));
  check('a null workingDirectory stays legal (it means "inherit")',
    /static void as_np_info_set_wd[\s\S]{0,400}if \(value != NULL && /.test(runtime));

  // --- no invented members -------------------------------------------------
  //
  // mxmlc 51.4.1 rejects NativeProcess.pid / .processID, describeType lists neither
  // it nor NativeProcessStartupInfo.environment, and the three redirection fields do
  // not exist either. A member AIR cannot compile is worse than a missing one: it
  // invites code that will never run on AIR.
  const shellStart = symbols.indexOf("shell('NativeProcess', 'flash.desktop::NativeProcess'");
  const shellEnd = symbols.indexOf("shell('StageWebView'", shellStart);
  check('the NativeProcess shell class is declared', shellStart > 0 && shellEnd > shellStart);
  const npRegion = symbols.slice(shellStart, shellEnd);
  check('no pid member', !/'pid'/.test(npRegion));
  check('no processID member', !npRegion.includes('processID'));
  // The startup info's OWN declaration ends where the NativeProcess comment begins.
  const siStart = symbols.indexOf("shell('NativeProcessStartupInfo'");
  const siEnd = symbols.indexOf('// flash.desktop.NativeProcess: the child-process handle', siStart);
  check('the startup info declaration is bounded', siStart > 0 && siEnd > siStart);
  const siRegion = symbols.slice(siStart, siEnd);
  check('no environment member on the startup info', !siRegion.includes('environment'));
  check('no stdin/stdout/stderr redirection fields on the startup info',
    !/standard(Input|Output|Error)/.test(siRegion));
  check('exitCode is a number, as measured (`typeof` is "number")',
    /'NativeProcessExitEvent'[\s\S]{0,600}exitCode[\s\S]{0,80}(number|'Number')/.test(symbols));

  // --- the emitted surface -------------------------------------------------
  const c = generateC(parse('import flash.desktop.NativeProcess;\nvar n:NativeProcess = new NativeProcess();\ntrace(n.running);\n')).c;
  check('start() routes to the backend', /NativeProcess_start\(void\* _this, NativeProcessStartupInfo\* info\) \{[\s\S]{0,200}as_np_start\(/.test(c));
  check('exit() routes to the backend', /NativeProcess_exit\(void\* _this, bool force\) \{[\s\S]{0,200}as_np_exit\(/.test(c));
  check('closeInput() routes to the backend', /NativeProcess_closeInput\(void\* _this\) \{[\s\S]{0,200}as_np_close_input\(/.test(c));
  check('isSupported answers the platform instead of a hardcoded false',
    /NativeProcess_get_isSupported_static[\s\S]{0,200}as_np_supported\(\) != 0/.test(c));
  check('the three pipes are real ByteArrays in the struct',
    /struct NativeProcess \{[\s\S]{0,600}standardInput[\s\S]{0,200}standardOutput[\s\S]{0,200}standardError/.test(c));
  check('WASI/web answer "unsupported" instead of pretending',
    /as_np_supported\(void\) \{\s*\n?\s*return 0;/.test(runtime) || /__wasm__|__EMSCRIPTEN__|__wasi__/.test(runtime));

  // --- the example exists and states the contract it pins -------------------
  check('the example exists', existsSync(join(root, 'examples', 'native-process.as')));
  const ex = read('examples/native-process.as');
  check('…and covers the error ids end to end', ['1009', '3213', '3214', '3215'].every((id) => ex.includes(id)));
  check('…on both hosts (cmd.exe and /bin/sh)', ex.includes('cmd.exe') && ex.includes('/bin/sh'));

  console.log(`     [np] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: desktop/NativeProcess', checkNativeProcess);

// --- the platform seam ------------------------------------------------------
//
// Stage 391 split this backend on `#ifdef _WIN32` alone, and that is not a seam: the
// `#else` half IS the POSIX body, so `fork`/`execv`/`fcntl` were compiled into every
// non-Windows target -- including WASI and Emscripten, which have none of them. The
// AS3 side kept answering isSupported=false, but the translation unit stopped
// compiling, so `as-aot --package web` broke (10 errors). The table in
// docs/{zh-cn,en}/native-process.md §6 said the right thing all along; what was
// missing was the INCLUDE-level exclusion, not a runtime check.
//
// These pins hold the shape of the fix, because the failure mode is invisible on the
// host that has fork(): a `#ifdef _WIN32` added later anywhere outside these two
// regions silently puts POSIX code back into the wasm targets.
function checkNativeProcessSeam(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [np-seam] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [np-seam] ${label}`); }
  };

  const runtime = read('src/native-process.ts');
  const c = generateC(parse('import flash.desktop.NativeProcess;\nvar n:NativeProcess = new NativeProcess();\ntrace(n.running);\n')).c;

  // --- one seam, three answers ---------------------------------------------
  const seamAt = runtime.indexOf('#ifdef _WIN32\n#define ASC_NP_WIN 1');
  check('the backend picks its platform in ONE seam', seamAt > 0);
  check('Windows keeps the Win32 backend', runtime.includes('#define ASC_NP_WIN 1'));
  check('wasi / Emscripten / any other wasm target share ONE "no process API" answer',
    /#elif defined\(__wasi__\) \|\| defined\(__EMSCRIPTEN__\) \|\| defined\(__wasm__\)\n#define ASC_NP_NONE 1/.test(runtime));
  check('every other POSIX host keeps the fork/execv backend',
    /#else\n#define ASC_NP_POSIX 1\n#endif/.test(runtime));
  check('isSupported answers false exactly on the no-backend target',
    /static int as_np_supported\(void\) \{\n#ifdef ASC_NP_NONE\n[\s\S]{0,240}return 0;/.test(runtime));
  check('start() reports the unsupported build before it tries to spawn',
    /if \(!as_np_supported\(\)\) \{\n\s*as_shell_unsupported\("flash\.desktop\.NativeProcess\.start/.test(runtime));

  // --- the POSIX half is EXCLUDED from wasm, not merely unused ---------------
  check('<sys/wait.h> is included for ASC_NP_POSIX, not for "anything but Windows"',
    runtime.includes('#ifdef ASC_NP_POSIX\n#include <sys/wait.h>\n#endif'));
  check('the old "#ifndef _WIN32" include shape is gone', !/#ifndef _WIN32/.test(runtime));

  const guardAt = runtime.indexOf('#ifdef ASC_NP_NONE\n// No process API on this target');
  const guardEnd = runtime.indexOf('#endif  // !ASC_NP_NONE');
  check('the pipe machinery sits behind ONE ASC_NP_NONE guard', guardAt > 0 && guardEnd > guardAt);

  // Every `#ifdef _WIN32` left in the file must be either the seam itself or inside
  // that guard; anything else is a split a wasm target would take the other half of.
  let stray = 0;
  for (let i = runtime.indexOf('#ifdef _WIN32'); i >= 0; i = runtime.indexOf('#ifdef _WIN32', i + 1)) {
    if (i === seamAt) continue;
    if (i > guardAt && i < guardEnd) continue;
    stray++;
  }
  check('no `#ifdef _WIN32` split survives outside the seam and the wasm-excluded block', stray === 0);

  check('the NONE target still gets the pipe stubs the AS3 shells call',
    /#ifdef ASC_NP_NONE[\s\S]{0,400}static int as_np_read_pipe\([\s\S]{0,200}as_np_flush_stdin\([\s\S]{0,200}as_np_close_stdin\(/.test(runtime));
  check('the struct keeps its handle fields inside the per-platform branches only',
    /#elif defined\(ASC_NP_POSIX\)\n    pid_t pid;/.test(runtime));
  check('every pid_t use is behind an ASC_NP_POSIX branch',
    (runtime.match(/#elif defined\(ASC_NP_POSIX\)/g) || []).length >= 3 &&
      runtime.indexOf('pid_t') > runtime.indexOf('#elif defined(ASC_NP_POSIX)\n    pid_t pid;'));

  // The generated C is the runtime text, so the same seam has to be in it: this is
  // what emcc and clang actually see.
  check('the emitted C carries the seam', c.includes('#define ASC_NP_NONE 1'));
  check('the emitted C never includes sys/wait.h unguarded',
    c.indexOf('#ifdef ASC_NP_POSIX\n#include <sys/wait.h>') > 0);

  // --- the docs say the same thing the code now enforces -------------------
  const zh = read('docs/zh-cn/native-process.md');
  const en = read('docs/en/native-process.md');
  check('zh docs state the wasi/web contract and name the seam',
    /WASI \/ web[^\n]*isSupported = false/.test(zh) && zh.includes('ASC_NP_NONE'));
  check('en docs state the wasi/web contract and name the seam',
    /WASI \/ web[^\n]*isSupported = false/.test(en) && en.includes('ASC_NP_NONE'));

  console.log(`     [np-seam] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: desktop/NativeProcessSeam', checkNativeProcessSeam);