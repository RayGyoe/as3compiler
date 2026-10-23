// Unit checks: an Array living in an `Object`-typed slot (阶段二百五十三 · G14).
//
// Why source-level pins here and behaviour in an example: the representative
// failure of this defect is a SEGFAULT (the array header's first word -- the
// element buffer -- read as a vtable header), so an example can only prove the
// crash is gone for the shapes it happens to contain. These checks pin the two
// invariants that make the whole family impossible:
//
//   1. a body whose first word is NOT a vtable is never followed as one
//      (as_has_vtable in as_is / as_iface_lookup; as_v_is_inst refusing tag 6);
//   2. an `Object`-typed receiver takes the SAME runtime dispatch an `*` receiver
//      already took, instead of the record/vtable assumption compiled into it.
//
// The behavioural matrix lives in examples/object-array-identity.as, whose every
// expected value was measured on adl 51.4.1 (temp/g14/ab.cjs: 55/55 rows
// byte-identical against the AIR arm).
//
//   node --test --test-name-pattern='object/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

// Call-site pins must look at the emitted MAIN BODY: the runtime preamble defines
// every helper unconditionally, so `c.includes('as_obj_is_array(')` would be true
// even for a program that never asks the question.
function mainOf(src: string): string {
  const c = generateC(parse(src)).c;
  return c.slice(c.indexOf('int main('));
}

// One program that touches every Object-slot operation the fix rerouted.
const OBJECT_SLOT_PROGRAM = [
  'var o:Object = [1, 2, 3];',
  'var b:Boolean = o is Array;',
  'var c:Array = o as Array;',
  'var n:int = o.length;',
  'o.push(4);',
  'delete o[0];',
  'var k:Class = o.constructor;',
  'for each (var v:* in o) { trace(v); }',
  'trace(b, n, c.length, k);',
  '',
].join('\n');

function checkObjectSlotArray(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [objarr] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [objarr] ${label}`); }
  };

  // Source is CRLF on disk; the pins below look at code shape, not line endings.
  const preamble = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  const c = mainOf(OBJECT_SLOT_PROGRAM);

  // ---- invariant 1: never follow a non-vtable first word ----
  const hasVtableAt = preamble.indexOf('static bool as_has_vtable(void* obj) {');
  check('as_has_vtable exists (the one vtable-or-not test)', hasVtableAt >= 0);
  check('it whitelists the vtable-bearing kinds, so GCT_ARRAY/GCT_DICT/GCT_CUSTOM/GCT_STRING are excluded',
    preamble.includes('case GCT_OBJECT: case GCT_CLASS: case GCT_XML: case GCT_XML_LIST:')
    && preamble.includes('case GCT_NUMBER: case GCT_STRING_OBJ: case GCT_BOOLEAN: case GCT_FUNCTION_OBJ:'));
  // The guard must sit inside as_is, BEFORE the read it protects.
  const isAt = preamble.indexOf('static bool as_is(void* obj, void* target_vt) {');
  const isGuardAt = preamble.indexOf('if (!as_has_vtable(obj)) return false;', isAt);
  const isReadAt = preamble.indexOf('void* vt = ((as_object_header*)obj)->vtable;', isAt);
  check('as_is refuses a vtable-less body BEFORE reading its first word',
    isAt >= 0 && isGuardAt > isAt && isReadAt > isGuardAt);
  check('as_iface_lookup is guarded too (it reads the same first word)',
    preamble.includes('static void* as_iface_lookup(void* obj, const char* name) {\n    if (!as_has_vtable(obj)) return NULL;'));
  // A tag-6 box (an Array held as `*`) carries no vtable, so it can never be an
  // instance of a class -- the old code waved it through into as_is.
  const visAt = preamble.indexOf('static bool as_v_is_inst(as_value v, void* target_vt) {');
  const visBody = visAt >= 0 ? preamble.slice(visAt, visAt + 400) : '';
  check('as_v_is_inst does not hand a tag-6 box to as_is',
    visBody.includes('if (v.tag != 4) return false;') && !visBody.includes('v.tag != 6'));

  // ---- invariant 2: an Object receiver dispatches at runtime, like a `*` ----
  const dcAt = preamble.indexOf('static as_value as_dyn_call(void* obj, const char* name, as_value* args, int argc) {');
  const dkAt = preamble.indexOf('int dk = as_dyn_kind(obj);', dcAt);
  const arrCallAt = preamble.indexOf('if (dk == 2) return as_arr_call(obj, name, args, argc);', dcAt);
  const dcWalkAt = preamble.indexOf('void* vt = ((as_object_header*)obj)->vtable;', dcAt);
  check('as_dyn_call detours an Array to as_arr_call before walking a vtable',
    dcAt >= 0 && dkAt > dcAt && arrCallAt > dkAt && dcWalkAt > arrCallAt);
  check('as_arr_call takes the receiver as void* so the early forward declaration needs no as_array',
    preamble.includes('static as_value as_arr_call(void* av, const char* name, as_value* args, int argc) {\n    as_array* a = (as_array*)av;'));
  check('as_dyn_get answers an Array with the keyed accessor (indices + length + named props)',
    preamble.includes('return as_array_key_get((as_array*)obj, key);')
    && preamble.includes('if (strcmp(key, "constructor") == 0) return as_v_class_of(as_v_arr(obj));'));
  check('as_any_get case 6 uses the same accessor (a["length"] / a["0"] on a `*` receiver)',
    preamble.includes('            return as_array_key_get(arr, key);'));
  check('as_obj_to_str joins an Array instead of calling a vtable slot',
    preamble.includes('if (gc_in_heap(obj) && gc_hdr(obj)->type == GCT_ARRAY) return as_arr_to_str(obj);'));
  check('as_obj_to_number runs the array join (Number(["5"]) is 5)',
    preamble.includes('return as_str_to_number(as_arr_to_str(obj));'));
  check('as_obj_is_array / as_obj_as_array / as_obj_class_of exist',
    preamble.includes('static bool as_obj_is_array(void* obj) {')
    && preamble.includes('static as_array* as_obj_as_array(void* obj) {')
    && preamble.includes('static as_value as_obj_class_of(void* obj) {'));

  // ---- the emitted side: no Object-typed operation may assume a record/vtable ----
  check('`o is Array` on an Object slot is a runtime test, not a folded false',
    c.includes('as_obj_is_array((void*)(g_o))'));
  check('`o as Array` recovers the array at runtime',
    c.includes('as_obj_as_array((void*)(g_o))'));
  check('`o.length` goes through the dynamic reader',
    c.includes('as_dyn_get((void*)(((Object*)as_req_obj((void*)(g_o)))), "length")'));
  check('`o.push(4)` goes through the dynamic caller',
    c.includes('as_dyn_call(((Object*)as_req_obj((void*)(g_o))), "push"'));
  check('an Object-typed method call never compiles to a vtable slot call',
    !c.includes('->vtable->toString('));
  check('`delete o[0]` goes through the dynamic deleter (record semantics silently did nothing)',
    c.includes('as_dyn_del((void*)(g_o), as_str_from_int(0))'));
  check('`for each` over an Object slot boxes the collection and uses the shared enumerator',
    c.includes('as_foreach_next(as_obj_to_value((void*)(_coll0)), &_i1, &_v2)'));
  check('`.constructor` asks the runtime instead of reading the array header as a vtable',
    c.includes('as_obj_class_of((void*)(((Object*)as_req_obj((void*)(g_o))))'));

  // ---- the negative controls the fix must NOT have touched ----
  check('a `*`-slot `is Array` still uses the box tag',
    mainOf('var u:* = [1];\nvar b:Boolean = u is Array;\ntrace(b);\n').includes('as_v_is_array('));
  // An Array-typed operand is still decided at compile time: the answer reaches the
  // printf through a hoisted `bool _onceN = true`, and no runtime check is emitted.
  const arrIs = mainOf('var a:Array = [1];\ntrace(a is Array);\n');
  check('an Array-typed `is Array` is still folded (no as_obj_is_array emitted)',
    !arrIs.includes('as_obj_is_array') && /bool _once\d+ = true;/.test(arrIs));
  check('Number/String/Boolean in an Object slot keep their specialized tests',
    mainOf('var n:Object = 1;\ntrace(n is Number);\n').includes('as_is_number_obj(')
    && mainOf('var s:Object = "x";\ntrace(s is String);\n').includes('as_is_string_obj('));

  if (ok > 0) console.log(`[objarr] ${ok} Object-slot Array checks passed`);
  return bad;
}
registerGroup('unit: object/array-identity', checkObjectSlotArray);