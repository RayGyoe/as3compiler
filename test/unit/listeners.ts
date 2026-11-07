// Unit checks: EventDispatcher listener priority and useWeakReference (stage 385).
//
// Both facts were measured on adl 51.4.1 before any code was written
// (temp/weakprobe). The source-level pins here exist because the example suite
// only proves "the program works": these pin the shape that makes it work, and
// in particular the two asymmetries a later refactor could quietly undo --
//
//   1. weak must be downgraded to strong for method values. AIR never collects a
//      class-level member function, so a weak obj.method listener keeps firing;
//      marking such a closure weakly would silently drop live handlers in the
//      real app (1537 addEventListener sites, 120 of them pass true).
//   2. a weak slot must never be dereferenced to decide whether its closure is
//      alive. Stage 384 crashed by treating a GC-segment address as proof of
//      liveness; this stage only compares addresses, and the sweep hook records
//      them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

const runtime = readFileSync(join(root, 'src/runtime.ts'), 'utf8');
const emit = readFileSync(join(root, 'src/emit.ts'), 'utf8');

// The generated sources are CRLF on a Windows checkout, so the terminator probe
// runs on a normalised copy: a bare linefeed-brace-linefeed never matches there.
function fnBody(src: string, signature: string): string {
  const text = src.split('\r\n').join('\n');
  const at = text.indexOf(signature);
  if (at < 0) return '';
  const end = text.indexOf('\n}\n', at);
  return end < 0 ? '' : text.slice(at, end + 3);
}

registerGroup('listeners', () => {
  const bad: string[] = [];
  function check(label: string, ok: boolean): void {
    if (!ok) bad.push('listeners/' + label);
  }

  // --- priority -----------------------------------------------------------
  const add = fnBody(emit, 'void EventDispatcher_addEventListener(void* _this, char* type, as_fn listener, bool useCapture, int priority, bool useWeakReference) {');
  check('addEventListener body present', add.length > 200);
  check('priority is no longer discarded', !add.includes('(void)priority'));
  check('insertion keeps descending priority order', add.includes('pe->priority < priority'));
  check('insertion is stable (shifting the tail, no sort at dispatch)', add.includes('arr->data[i] = arr->data[i - 1]'));
  check('the inserted slot gets a write barrier', add.includes('gc_write_barrier_value(arr->data[at_i]);'));

  // --- weak downgrade for method values -----------------------------------
  check('weak is downgraded to strong for method values',
    add.includes('useWeakReference && !listener->is_method'));
  check('method values are built through as_fn_make_method',
    runtime.includes('static as_fn as_fn_make_method(as_fn_impl fn, void* env, int arity) {'));
  const boundMk = (emit.match(/as_fn_make\([^,()]*__bound,/g) || []).length;
  check('every __bound thunk goes through as_fn_make_method', boundMk === 0);
  const boundMethod = (emit.match(/as_fn_make_method\([^,()]*__bound,/g) || []).length;
  check('there are exactly three method-value sites', boundMethod === 3);
  check('plain closures stay non-method', runtime.includes('f->is_method = 0;'));

  // Static methods, module-level functions and builtin values are class-level
  // member functions in AIR's sense: never collected. A miss here is not a
  // cosmetic difference -- TweenLite registers its static updateAll with
  // useWeakReference=true, and collecting that closure froze every tween and
  // with them the whole application UI.
  const staticSites = (emit.match(/as_fn_make_method\(\$\{sm\.owner\}_/g) || []).length;
  check('class static method values are non-collectable', staticSites === 4);
  check('module-level free function values are non-collectable',
    emit.includes('as_fn_make_method(${this.freeCName(name)}__call, NULL'));
  check('builtin function values are non-collectable',
    emit.includes('as_fn_make_method(${name}__call, NULL, ${bArity}'));
  check('function expressions stay collectable',
    emit.includes('as_fn_make(${name}__call, NULL, ${arity})'));
  check('nested closure cells stay collectable',
    emit.includes('as_fn_make(${m}__call, (void*)e,'));

  // --- GC side ------------------------------------------------------------
  check('as_lentry carries priority and the weak bit',
    runtime.includes('} as_lentry;') && runtime.includes('int priority;') && runtime.includes('unsigned char weak;'));
  check('lentry registers its closure in the weak set',
    runtime.includes('if (e->weak) as_weak_watch((void*)fn);'));
  const scan = fnBody(runtime, '    case GCT_LENTRY: {');
  check('the lentry scan branch is present', scan.length > 0);
  check('a weak slot does not mark its closure', scan.includes('if (!e->weak) gc_mark_ptr(e->fn);'));
  check('GCT_LENTRY is inside the recognised type range',
    runtime.includes('h->type >= GCT_STRING && h->type <= GCT_LENTRY'));
  check('sweep records freed closures',
    runtime.includes('as_weak_on_free((char*)h + sizeof(gc_header));'));
  check('a recycled address is revived, not left marked dead',
    runtime.includes('if (as_weak_get(o) == 2) as_weak_set(o, 1);') &&
    runtime.includes('as_weak_revive((void*)f);'));

  // --- dispatch never dereferences a possibly-freed pointer ---------------
  const disp = fnBody(emit, 'static bool as_disp_arr(as_array* arr, Event* evt) {');
  check('dispatch body present', disp.length > 200);
  check('dispatch skips a closed weak slot',
    disp.includes('as_weak_dead((void*)le->fn)') && disp.includes('le->fn = NULL;'));
  check('dispatch null-checks the slot before reading it', disp.includes('if (le->fn == NULL) continue;'));
  check('dispatch closes the slot only before invoking, never after',
    disp.indexOf('as_weak_dead') < disp.indexOf('fn->fn(fn->env'));

  const rem = fnBody(emit, 'void EventDispatcher_removeEventListener(void* _this, char* type, as_fn listener, bool useCapture) {');
  check('removeEventListener goes through the lentry', rem.includes('as_lentry* a = (as_lentry*)as_v_obj_val(arr->data[i]);'));
  check('removeEventListener tolerates a closed weak slot', rem.includes('a->fn != NULL'));

  return bad;
});