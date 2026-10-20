// Unit checks: describeType (the reflection XML a generic model mapper runs on),
// reflective property boxing, and the frame-boundary recovery of uncaught errors.
//
// These are source-level structural pins: the behaviour itself is covered by
// examples/describe-type.as, but the examples suite can only catch a program that
// fails to RUN, and both crashes fixed here (a childless describeType, an Array
// field boxed as an object) are silent wrong answers rather than hard failures.
//   node --test --test-name-pattern='reflect/' test/unit/*.ts

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root } from '../harness.ts';

// ---- describeType: the AIR-aligned reflection XML ------------------------
//
// AIR's describeType is what a generic model mapper's `BaseModel.fromJSON` walks to populate a
// model from JSON. The runtime used to emit a CHILDLESS <type name="fqn"/>
// element, so '..variable' was always empty, every field kept its AS3 default,
// and a nested model left NULL became an uncaught #1009 on the next read (which
// is what froze the app on the "test2" meeting).
//
// The XML shape itself is emitted from the generated reflection tables (props /
// methods / vtables), so the pins below cover the three things that can silently
// break it again: the table fields it reads, the Object-layer skip, and the
// safety gate that keeps a non-class box (Array/Dictionary/Vector) from being
// read as a class instance.
function checkDescribeType(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [describeType] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [describeType] ${label}`); }
  };
  const src = [
    'class Cfg { public var n:int; }',
    'class R {',
    '  public var id:Number;',
    '  public var tags:Array;',
    '  public var cfg:Cfg;',
    '  public const K:int = 1;',
    '  private var _hidden:int;',
    '  public function get rw():String { return "x"; }',
    '  public function set rw(v:String):void { }',
    '  public function m(a:int, b:String = "q", ...rest):void { }',
    '}',
    'var v:int = 1;',
    '',
  ].join('\n');
  const c = generateC(parse(src)).c;

  // 1) the reflection tables carry what describeType has to report
  check('as_prop records whether a field is an accessor',
    RUNTIME_PREAMBLE.includes('int is_accessor;'));
  check('as_prop records whether a field is a constant (a <constant>, not a <variable>)',
    RUNTIME_PREAMBLE.includes('int is_const;'));
  check('as_method carries its signature (returnType + parameters)',
    RUNTIME_PREAMBLE.includes('const char* sig;'));
  check('the vtable header carries isDynamic/isFinal for the <type> attributes',
    RUNTIME_PREAMBLE.includes('int is_proxy; int is_dynamic; int is_final;'));
  check('...so every hand-written box vtable must have been widened too',
    !/as_object_vt = \{[^}]*is_proxy, toString/.test(RUNTIME_PREAMBLE));

  // 2) the per-class vtable in the generated C carries the two flags
  check('a generated class vtable is emitted', c.includes('cls_fqn'));
  check('the generated vtable struct has an isDynamic slot', c.includes('cls_is_dynamic'));
  check('the generated vtable struct has an isFinal slot', c.includes('cls_is_final'));
  check('the generated prop rows are read through as_prop (name/type/offset/vis/accessor/const)',
    c.includes('ps[i].is_accessor') && c.includes('ps[i].is_const'));
  check('the generated method rows carry a signature string',
    c.includes('as_dt_method_sig('));

  // 3) the XML builder itself
  check('the reflection XML builder is emitted into the program',
    c.includes('as_dt_shape(') && c.includes('as_dt_traits('));
  check('a class instance is recognised without dereferencing the candidate',
    c.includes('as_dt_class_of('));
  check('non-class GC bodies (Array/Dictionary/Vector) are gated out before any vtable read',
    c.includes('as_dyn_kind(v.ptr) != 0'));
  check('Object\'s own traits are skipped in the accessor walk',
    c.includes('if (c->name != NULL && strcmp(c->name, "Object") == 0) break;'));
  check('...and in the method walk as well (never listed, for a subclass or a plain object)',
    c.split('if (c->name != NULL && strcmp(c->name, "Object") == 0) break;').length - 1 === 2);
  check('an interface name is resolved through a side table (an interface vtable has no fqn slot)',
    c.includes('as_dt_iface_name') && c.includes('as_dt_iface_names[]'));
  check('a constructor signature is resolved through a side table',
    c.includes('as_dt_ctor_sig('));

  // 4) the behaviour-level regression guard exists as a runnable example
  const ex = join(root, 'examples', 'describe-type.as');
  check('examples/describe-type.as exists', existsSync(ex));
  if (existsSync(ex)) {
    const s = readFileSync(ex, 'utf8');
    check('...and drives the fromJSON pattern that used to crash',
      s.includes('describeType(this)..variable') && s.includes('fromJSON'));
    check('...and asserts, so a wrong answer fails the example run',
      s.includes('throw new Error("FAIL: '));
  }

  console.log(`[describeType] ${ok} reflection checks passed`);
  return bad;
}

// ---- reflective field reads: an Array field must box as an Array ----------
//
// as_prop_read dispatches on the field's reflection type tag. Tag 10 is "the
// declared type is Array"; boxing such a value as an OBJECT puts the array's data
// pointer where every reflective consumer expects a vtable, so String(x),
// `x is Array` and any dynamic access walked a data pointer as a vtable and
// faulted. Measured while fixing the test2 crash (a dynamic read of an Array
// field was the last stderr line before the fault).
function checkPropBoxing(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [propbox] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [propbox] ${label}`); }
  };
  const arr = 'case 10: return as_v_arr(*(void**)((char*)base + p->offset));';
  check('an Array-typed field boxes as an Array (tag 6)',
    RUNTIME_PREAMBLE.includes(arr));
  check('the object-boxing branch no longer swallows tag 10',
    !RUNTIME_PREAMBLE.includes('case 10: case 11: case 12: return as_v_obj'));
  check('a reference/Object-typed field still boxes as an object',
    RUNTIME_PREAMBLE.includes('case 6: case 11: case 12: return as_v_obj'));
  check('tag 10 is handled exactly once in the table',
    RUNTIME_PREAMBLE.split('case 10: return as_v_arr').length - 1 === 1);

  // The XML string value is the other reflection-adjacent rule that bit us: an
  // element with attributes but no children must still reduce to its TEXT, or
  // every localised constant parsed from an embedded XML file comes back as its
  // raw '<label name=...>' template (Language.init).
  // 阶段二百零八: the test is "no ELEMENT child" rather than "child_count == 0" --
  // an element whose content is a single text run now HAS a child (the text node),
  // and it must still reduce to that text.
  check('an element with only text content reduces to its text (the JSX rule AIR uses)',
    RUNTIME_PREAMBLE.includes('if (!has_elem) return as_str_dup(n->text ? n->text : "");'));
  check('an empty element yields the empty string, not a markup form',
    RUNTIME_PREAMBLE.includes('if (!n->name) return as_str_dup(n->text ? n->text : "");'));
  check('an element WITH children still serialises as markup',
    RUNTIME_PREAMBLE.includes('return as_xml_to_string(n);'));

  console.log(`[propbox] ${ok} reflective boxing checks passed`);
  return bad;
}

// ---- uncaught errors are recovered at every ENTRY POINT ------------------
//
// AIR reports an uncaught error and keeps running; the runtime called exit(1)
// instead, which tore down 50+ threads through CEF and the ANE DLLs and left the
// process hung (0% CPU, no window) -- the first uncaught #1009 froze the whole
// app. The guard is planted by the OUTERMOST frame AND by the input/native
// entry points, because those run AS3 with no frame above them: SDL delivers a
// mouse click from its own event loop, so a #1009 raised in a click handler had
// as_frame_guard == 0 and reached exit(1) -- measured: ShareWindowView's screen
// list froze the window on click. Planting is per thread and never nested (a
// nested setjmp would re-arm the buffer the outer frame still needs).
// With nothing armed (console programs, --run) the historical exit(1) path is
// unchanged, so the non-GUI test behaviour is byte-for-byte the same.
function checkFrameErrorRecovery(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [frameguard] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [frameguard] ${label}`); }
  };
  // Thread-local, like the unwind stack: the buffer lives on the stack of the
  // thread that planted it, so a worker thread recovering from an uncaught
  // error must not longjmp into the dispatching thread's frame.
  check('the runtime keeps one frame-level jump buffer, per thread',
    RUNTIME_PREAMBLE.includes('static ASC_TLS jmp_buf as_frame_jmp;'));
  check('...and a guard saying whether a frame owns it, per thread',
    RUNTIME_PREAMBLE.includes('static ASC_TLS int as_frame_guard = 0;'));
  check('an uncaught error longjmps to the frame instead of exiting',
    RUNTIME_PREAMBLE.includes('longjmp(as_frame_jmp, 1)'));
  check('...from both throw entry points (value and boxed)',
    RUNTIME_PREAMBLE.split('longjmp(as_frame_jmp, 1)').length - 1 === 2);
  check('the non-GUI path still exits, so --run semantics are untouched',
    RUNTIME_PREAMBLE.includes('exit(1);'));

  const c = generateC(parse('var v:int = 1;\n')).c;
  const head = 'static void Stage_dispatchFrame(void* _this) {';
  const at = c.indexOf(head);
  check('the frame dispatcher is emitted', at >= 0);
  const body = at >= 0 ? c.slice(at, c.indexOf('\n}', at)) : '';
  check('the outermost frame plants the buffer', body.includes('setjmp(as_frame_jmp)'));
  check('...only when no frame is already active',
    /if \(as_frame_guard == 0\) \{\s*if \(setjmp\(as_frame_jmp\) != 0\)/.test(body));
  // The recovery path also restores the dispatch nesting depth: a listener that
  // threw unwound a dispatchEvent that could not decrement it itself (as_disp_arr
  // picks its snapshot buffer by depth, so a stale value would corrupt later walks).
  check('...and clears the guard (and the dispatch depth) on the recovery path',
    body.includes('as_frame_guard = 0; as_disp_depth = 0; return;'));
  check('the frame releases the buffer when it returns normally',
    body.includes('if (_fguard) as_frame_guard = 0;'));
  // One plant per ENTRY POINT, and none inside the event machinery: a setjmp in
  // as_dispatchEvent would be per dispatch (defeating the frame's single
  // recovery point) and would unwind out of a listener rather than out of the
  // frame. So the count is exactly 1 (Stage_dispatchFrame) + 6 (mouse, wheel,
  // key, frame clock, resize, close -- every callback the native layer can call
  // back into AS3 through).
  check('the buffer is planted once per entry point, not per dispatch',
    c.split('setjmp(as_frame_jmp)').length - 1 === 7);
  check('...and never inside the event-dispatch machinery',
    !/static void as_dispatchEvent[\s\S]{0,4000}setjmp\(as_frame_jmp\)/.test(c));

  console.log(`[frameguard] ${ok} frame-error recovery checks passed`);
  return bad;
}

registerGroup('unit: reflect/DescribeType', checkDescribeType);
registerGroup('unit: reflect/PropBoxing', checkPropBoxing);
registerGroup('unit: reflect/FrameErrorRecovery', checkFrameErrorRecovery);
