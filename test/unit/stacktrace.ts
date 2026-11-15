// Unit checks: the AS3 shadow call stack behind Error.getStackTrace (阶段四百三十一).
// AIR captures the stack at Error CONSTRUCTION (adl 51.4.1, temp/stackprobe);
// the runtime keeps a per-thread frame stack that every generated AS3 function
// enters/leaves, and a longjmp out of a throw restores the depth at each catch.
// A pass/fail example run cannot see the balance invariants (a missing leave on
// one return path only shows up as a WRONG frame list much later), so they are
// pinned here on the emitted C, next to the runtime contract itself.
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

// One top-level C function: from its signature to the first closing brace at
// column 0 (emitted functions are not indented). Searches DEFINITIONS, not the
// forward prototypes (those end in ';' before any '{').
function funcBody(c: string, signature: string): string {
  const start = c.indexOf(signature);
  if (start < 0) return '';
  const end = c.indexOf('\n}', start);
  return end < 0 ? c.slice(start) : c.slice(start, end + 2);
}

function checkStackTrace(): string[] {
  const failed: string[] = [];
  const check = (label: string, ok: boolean): void => {
    if (!ok) failed.push(label);
  };

  // ---- the runtime shadow stack itself ----
  const rt = RUNTIME_PREAMBLE;
  check('the preamble defines the shadow-stack frame type',
    rt.includes('typedef struct { const char* cls; const char* meth; } as_aframe;'));
  check('the frame stack and depth are per-thread (ASC_TLS, like as_frame_jmp)',
    rt.includes('static ASC_TLS as_aframe as_astack[512];')
    && rt.includes('static ASC_TLS int as_astack_depth = 0;'));
  check('enter records cls/meth and keeps counting past the cap (leave stays balanced)',
    rt.includes('if (as_astack_depth < 512) { as_astack[as_astack_depth].cls = cls; as_astack[as_astack_depth].meth = meth; }'));
  check('leave never underflows', rt.includes('if (as_astack_depth > 0) as_astack_depth--;'));
  check('format answers NULL with no live frame (release-player "no stack")',
    /static char\* as_astack_format\(void\) \{\s*if \(as_astack_depth == 0\) return NULL;/.test(rt));
  check('format renders innermost-first (AIR frame order)',
    rt.includes('for (int i = n - 1; i >= 0; i--)'));
  check('format builds a GC string, not a malloc leak',
    /as_astack_format[\s\S]*?as_str_alloc\(total \+ 1\)/.test(rt));

  // ---- the emitted C for a small authored program ----
  const src = [
    'class Probe {',
    '  public function Probe() {}',
    '  public function boom():void { throw new Error("x"); }',
    '  public static function sm():void { throw new Error("y"); }',
    '  public function make():Error { return new Error("z"); }',
    '  public function voidRet():void { return fall(); }',
    '  public function voidRetTry():void { try { return fall(); } finally { } }',
    '}',
    'function freeFn():int { return 1; }',
    'function fall():void { trace(1); }',
    'var p:Probe = new Probe();',
    'try { p.boom(); } catch (e:Error) { trace(e.getStackTrace()); }',
  ].join('\n');
  const c = generateC(parse(src)).c.replace(/\r\n/g, '\n');

  // getStackTrace is real now: no unsupported report, NULL capture -> null.
  const gst = funcBody(c, 'char* Error_getStackTrace(void* _this) {');
  check('Error_getStackTrace has a real definition', gst !== '');
  check('Error_getStackTrace no longer reports itself unsupported',
    !c.includes('as_shell_unsupported((char*)"Error.getStackTrace")'));
  check('a NULL capture returns null (no-stack release-player answer)',
    gst.includes('if (e->_stacktrace == NULL) return NULL;'));
  check('the header is name + ": " + message, then the captured frames',
    gst.includes('parts[0] = nm; parts[1] = ": "; parts[2] = e->message;')
    && gst.includes('parts[4] = e->_stacktrace;'));
  check('an empty message keeps the name-alone header (Error_toString rule)',
    gst.includes('if (e->message == NULL || e->message[0] == 0)'));

  // Construction-time capture, in Error AND the hand-written subclass ctors.
  const ector = funcBody(c, 'void Error_ctor(Error* o, char* message, int id) {');
  check('Error_ctor captures the stack at construction',
    ector.includes('o->_stacktrace = as_astack_format();'));
  check('the capture is published to the incremental marker',
    ector.includes('gc_write_barrier((void*)o->_stacktrace);'));
  const tctor = funcBody(c, 'void TypeError_ctor(TypeError* o, char* message, int id) {');
  check('subclass ctors capture too (they do not call Error_ctor)',
    tctor.includes('o->_stacktrace = as_astack_format();'));

  // The field sits AFTER name so as_error_view's { vtable; message } offsets hold,
  // and it is private (vis=1 in the props table: GC scans it, JSON/AS3 do not).
  const structErr = funcBody(c, 'struct Error {');
  check('struct Error keeps message before name before _stacktrace',
    structErr.indexOf('char* message;') >= 0
    && structErr.indexOf('char* message;') < structErr.indexOf('char* name;')
    && structErr.indexOf('char* name;') < structErr.indexOf('char* _stacktrace;'));
  check('_stacktrace is in the props table as a private (vis=1) string slot',
    /\{ "_stacktrace", 3, offsetof\(Error, _stacktrace\), NULL, NULL, 1,/.test(c));

  // Frame enter sites: instance/static methods, ctor, free function, main.
  const boom = funcBody(c, 'void Probe_boom(void* _this) {');
  check('an instance method enters as "Cls/meth"', boom.includes('as_astack_enter("Probe", "boom");'));
  const sm = funcBody(c, 'void Probe_sm_static() {');
  check('a static method enters as "Cls$/meth"', sm.includes('as_astack_enter("Probe$", "sm");'));
  const pctor = funcBody(c, 'void Probe_ctor(Probe* o) {');
  check('a constructor enters with a NULL method (AIR prints "Cls()")',
    pctor.includes('as_astack_enter("Probe", NULL);'));
  check('a constructor leaves at its fall-through end',
    pctor.includes('as_astack_leave();'));
  const free = funcBody(c, 'int freeFn() {');
  check('a free function enters as "global/fn"', free.includes('as_astack_enter(NULL, "freeFn");'));
  const main = funcBody(c, 'int main(void) {');
  check('the top-level script runs in a frame of its own', main.includes('as_astack_enter(NULL, NULL);'));

  // Return paths: every return leaves, and the value is evaluated FIRST so a
  // `return new Error(...)` still sees the returning function's frame.
  check('a plain return leaves before returning',
    /as_astack_leave\(\);\s*return 1;/.test(free));
  const make = funcBody(c, 'Error* Probe_make(void* _this) {');
  check('return new Error(...) hoists the value, then leaves, then returns',
    /Error\* \w+ = Error_new\([\s\S]*?\);\s*as_astack_leave\(\);\s*return \w+;/.test(make));
  const fall = funcBody(c, 'void fall() {');
  check('a fall-through body leaves at the end', fall.includes('as_astack_leave();'));

  // A void function may `return voidCall();` (real-app RWebSocket.sendMessage /
  // TextField.appendText). The value-hoist must NOT create `void _ret = ...`
  // (incomplete type 'void'); it runs the call, leaves, and returns bare.
  const vr = funcBody(c, 'void Probe_voidRet(void* _this) {');
  check('void return voidCall() never hoists into a void temp',
    vr !== '' && !vr.includes('void _ret'));
  check('void return voidCall() runs the call, leaves, then returns bare',
    /fall\(\);\s*as_astack_leave\(\);\s*return;/.test(vr));
  const vrt = funcBody(c, 'void Probe_voidRetTry(void* _this) {');
  check('void return inside try/finally also avoids a void temp',
    vrt !== '' && !vrt.includes('void _ret'));
  check('a body ending in return does NOT double-leave',
    (free.match(/as_astack_leave\(\);/g) ?? []).length === 1);
  check('a body ending in throw has no fall-through leave (the catch restores)',
    !boom.includes('as_astack_leave();'));

  // try/catch: depth saved BEFORE setjmp, restored in the longjmp path.
  const saved = c.match(/int (\w+) = as_astack_depth;\s*jmp_buf \w+;\s*int \w+ = AS_SETJMP/);
  check('emitTry saves the depth before setjmp (pre-setjmp local, longjmp-safe)', saved !== null);
  const restores = [...c.matchAll(/as_jmp_pop\(\);\s*as_astack_depth = (\w+);/g)].map((m) => m[1]);
  check('the catch path restores the saved depth after as_jmp_pop',
    saved !== null && restores.includes(saved[1]));

  // Every frame-boundary guard resets the shadow stack with the dispatch depth.
  const guards = c.split('AS_SETJMP(as_frame_jmp)').length - 1;
  const resets = c.split('as_disp_depth = 0; as_astack_depth = 0;').length - 1;
  check('every frame-boundary guard resets as_astack_depth (' + resets + '/' + guards + ')',
    guards === 7 && resets === guards);

  if (failed.length !== 0) console.log('     [stacktrace] ' + failed.length + ' check(s) failed');
  return failed;
}

registerGroup('unit: runtime/StackTrace', checkStackTrace);
