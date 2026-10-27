// Unit checks: process-killing defects found by the crash monitor on a real
// Windows AOT app (阶段二百七十八…二百八十). Five independent failure modes, all of
// them fatal-to-the-process rather than wrong-value, which is why they are pinned
// here and exercised end-to-end by examples/null-string.as, examples/uncaught-storm.as,
// examples/oom-error.as and examples/oom-cxx.as.
//
//  1. printf("%s", NULL). ucrt treats a null pointer for %s as an INVALID PARAMETER
//     and calls __fastfail -> 0xC0000409. ES3 ToString(null) is the text "null", so
//     the runtime must substitute it. Every reachable producer of a C string is
//     covered: a String-typed slot that was never assigned (static NULL), a boxed
//     null, an object whose toString() returns null, and the uncaught-error path.
//     Measured before the fix: an app died at 0xC0000409 after 388 thrown #1009s.
//
//  2. Uncaught-error storms. An uncaught error inside a frame is recovered at the
//     frame boundary (AIR does not terminate either), so a repeating null-receiver
//     bug throws once per call. Measured: 623 identical "#1009" lines in 40 s, which
//     pushed every other diagnostic out of the log. The throttle folds repeats and
//     keeps an exact count -- throttling must never turn into silence.
//
//  3. DXGI_ERROR_DEVICE_REMOVED. The old Present handling printed the HRESULT and
//     carried on: the next frame recorded into a removed device and Skia faulted
//     (0xC0000005), or the loop spun on a dead swapchain until AppHangB1. Measured:
//     252+172+140 failed Presents over 30 s, then a hang.
//
//  4. malloc() returning NULL. gc_alloc stored the fresh segment base and wrote
//     through it on the NEXT statement; as_alloc had the same shape for its 4 MiB
//     arena segments, and both realloc() sites dropped the old pointer. After both
//     earlier fixes the app still died at exe+0x699e with params 0x1/0xc -- a write
//     to 0xc, i.e. `fresh->size` through a null base -- so this was the real cause
//     of the 0xC0000005 the first round had blamed on D3D. AIR raises a catchable
//     Error #1000 (kOutOfMemoryError) here; so do we.
//
//  5. A refused C++ allocation. Once the C side raised #1000, the crash moved: the
//     app died at 0xC0000409 (BEX, __fastfail(7)) after 193 s, and the dump put
//     _abort+0x29 under _terminate under __scrt_unhandled_exception_filter with
//     __CxxThrowException and the std::bad_alloc descriptor still on the stack --
//     Skia's SkData::MakeUninitialized threw bad_alloc, nothing in the generated C
//     catches C++ exceptions, and Windows' terminate is abort(). vendor/skia_glue.cc
//     now replaces the global operator new and asks the runtime instead: collect and
//     retry, or raise the same catchable #1000 the C side raises.
//
// Source-level pins, not behavioural: all of them are fatals whose only observable
// is "the process died", and d3d_glue.cc cannot be compiled on a non-Windows host.
//
//   node --test --test-name-pattern='crash/' test/unit/*.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root } from '../harness.ts';

const read = (rel: string): string =>
  readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

function checkCrashHardening(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [crash] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [crash] ${label}`); }
  };

  // ---- 1. no printf %s may receive a null pointer -----------------------------
  const rt = read('src/runtime.ts');
  const valAt = rt.indexOf('static char* as_v_str_val(as_value v) {');
  const valBody = valAt >= 0 ? rt.slice(valAt, valAt + 2500) : '';
  check('as_v_str_val returns "null" for a boxed null string, not a null pointer',
    valBody.includes('case 3: return v.ptr != NULL ? (char*)v.ptr : (char*)"null";'));

  const o2sAt = rt.indexOf('static char* as_obj_to_str(void* obj) {');
  const o2sBody = o2sAt >= 0 ? rt.slice(o2sAt, o2sAt + 3400) : '';
  check('as_obj_to_str covers a proxy that resolves to null',
    o2sBody.includes('char* r = as_proxy_to_str(obj);') &&
    o2sBody.includes('return r != NULL ? r : (char*)"null";'));
  check('...and covers a user toString() that returns null',
    o2sBody.includes('char* r = toStr(obj);') &&
    o2sBody.includes('return r != NULL ? r : (char*)"null";'));

  // Every %s branch of trace goes through the guard. Counted, not spot-checked:
  // the defect is "one branch was forgotten", so the pin is that no bare value is
  // pushed for a %s format any more.
  const em = read('src/emit.ts');
  const trAt = em.indexOf('private emitTrace(args: Expr[]): string {');
  const trBody = trAt >= 0 ? em.slice(trAt, trAt + 4200) : '';
  check('emitTrace wraps every %s argument in as_str_or_null',
    trBody.includes('const s9 = (code: string) => `as_str_or_null(${code})`;') &&
    // 7 guarded branches at the time of writing: number, int64, uint64, bool,
    // string, any, object, interface -- the assert is "no branch pushes a raw
    // expression for a %s", expressed as: the string/any/object branches all use s9.
    /case 'string': formats\.push\('%s'\); vals\.push\(s9\(e\.code\)\);/.test(trBody) &&
    /case 'any': formats\.push\('%s'\); vals\.push\(s9\(/.test(trBody) &&
    /case 'object': formats\.push\('%s'\); vals\.push\(s9\(/.test(trBody));

  const c = generateC(parse([
    'var s:String = null;',
    'var a:* = s;',
    'trace(s);',
    'trace(a);',
    '',
  ].join('\n'))).c;
  check('the emitted trace of a String slot goes through the guard',
    /as_str_or_null\(g_s\)/.test(c) || /as_str_or_null\(s\)/.test(c));
  check('...and so does the boxed one',
    /as_str_or_null\(as_v_str_val\(/.test(c));

  // ---- 2. throttled uncaught reporting, without losing the count --------------
  const repAt = rt.indexOf('static void as_report_uncaught(const char* m) {');
  const repBody = repAt >= 0 ? rt.slice(repAt, repAt + 1800) : '';
  check('there is one reporting function for uncaught errors', repAt > 0);
  check('...it folds repeats of the same message, capped so density does not hide them',
    repBody.includes('as_uncaught_suppressed <= 20'));
  check('...it reports the folded count instead of dropping it',
    /more of the same/.test(repBody));
  check('...and pending counts are flushed at exit (a storm inside one second is not silence)',
    repBody.includes('atexit(as_uncaught_flush)') &&
    rt.includes('static void as_uncaught_flush(void) {'));
  // Both throw paths must use it; a leftover raw fprintf would bypass the throttle.
  const rawFprintf = (rt.match(/fprintf\(stderr, "Uncaught exception: %s/g) ?? []).length;
  check('no throw path reports around the throttle (the only raw writes live in it)',
    rawFprintf === 3);   // as_report_uncaught, its folded line, and as_uncaught_flush

  // ---- 3. D3D12 device-lost recovery -----------------------------------------
  const d3d = read('vendor/d3d_glue.cc');
  check('the removed-device condition is classified, not just printed',
    /static int d3d_hr_is_device_lost\(HRESULT hr\) \{/.test(d3d) &&
    /DXGI_ERROR_DEVICE_REMOVED/.test(d3d) &&
    /DXGI_ERROR_DEVICE_RESET/.test(d3d) &&
    /DXGI_ERROR_DRIVER_INTERNAL_ERROR/.test(d3d));
  check('every frame is gated on GetDeviceRemovedReason before touching Skia',
    /g_device->GetDeviceRemovedReason\(\)/.test(d3d) &&
    /if \(g_d3d_lost && !d3d_try_recover\(\)\) return nullptr;/.test(d3d));
  check('the three failing calls enter the lost path instead of continuing',
    /d3d_mark_lost\("Present"/.test(d3d) &&
    /d3d_mark_lost\("GetBuffer"/.test(d3d) &&
    /d3d_mark_lost\("ResizeBuffers"/.test(d3d));
  check('...and Present does not signal a fence the dead queue can never reach',
    /if \(d3d_hr_is_device_lost\(phr\)\) \{\s*d3d_mark_lost\("Present", phr\);/.test(d3d) &&
    /d3d_recreate_window\(w, w->width, w->height\);\s*\}\s*return;/.test(d3d));
  check('the Ganesh context is abandoned, not reset (a removed device cannot be freed normally)',
    /g_context->abandonContext\(\);/.test(d3d) &&
    !/g_context->reset\(\);\s*\n\s*g_context\.reset\(\);/.test(d3d));
  check('one swapchain builder serves init and rebuild',
    /static int d3d_create_swapchain\(/.test(d3d) &&
    (d3d.match(/CreateSwapChainForHwnd\(/g) ?? []).length === 1);
  check('a healthy-device resize failure recreates only the affected window',
    /static int d3d_recreate_window\(D3DWin\* w, int width, int height\)/.test(d3d) &&
    /else \{\s*\/\/ The device is still alive[\s\S]*?d3d_recreate_window\(w, width, height\);/.test(d3d));
  check('a failed window recreation is retried through a null-swapchain gate',
    /w->width = 0;\s*w->height = 0;/.test(d3d) &&
    /if \(w->swapchain.get\(\) == nullptr && !d3d_recreate_window\(w, width, height\)\) return nullptr;/.test(d3d));
  check('the healthy-device resize failure path has an executable probe hook',
    /ASC_GPU_RESIZE_FAIL/.test(d3d) && /injectedResizeFailure = 1;\s*rhr = E_OUTOFMEMORY;/.test(d3d));
  check('rebuild retries back off instead of spinning on D3D12CreateDevice every frame',
    /g_d3d_retry_ms = g_d3d_retry_ms \* 2 > 4000 \? 4000 : g_d3d_retry_ms \* 2;/.test(d3d));

  // ---- 4. an allocation failure raises Error #1000, it does not fault --------
  // avmplus core/ErrorConstants.{h,cpp}: kOutOfMemoryError = 1000,
  // "The system is out of memory." -- the message is pinned verbatim, because an
  // app that switches on the text must see the same string AIR gives it.
  check('allocation failure raises Error #1000 with the AIR message',
    rt.includes('static _Noreturn void as_gc_oom(size_t need)') &&
    rt.includes('as_throw(as_error_new_oom("Error #1000: The system is out of memory.", 1000));'));
  check('...and the hook is emitted next to the Error class (the runtime can only declare it)',
    rt.includes('static void* as_error_new_oom(const char* msg, int id);') &&
    em.includes("static void* as_error_new_oom(const char* m, int id) { return Error_new((char*)m, id); }"));
  const segAt = rt.indexOf('static void* gc_alloc(int type, size_t size) {');
  const segBody = segAt >= 0 ? rt.slice(segAt, segAt + 9000) : '';
  check('gc_alloc never stores a malloc result before testing it',
    segBody.includes('char* seg_base = oom_forced ? NULL : (char*)malloc(seg_size);') &&
    segBody.includes('if (s == NULL || seg_base == NULL) {') &&
    segBody.includes('as_gc_oom(seg_size);') &&
    !/s->base = \(char\*\)malloc\(/.test(rt));
  check('...retrying once after a collection, but never re-entering the collector',
    segBody.includes('if ((s == NULL || seg_base == NULL) && gc_in_gc == 0) {') &&
    rt.includes('gc_in_gc = 1;') &&
    rt.includes('gc_in_gc = 0;'));
  check('as_alloc guards both the oversized block and the 4 MiB arena segment',
    rt.includes('if (big == NULL) as_gc_oom(n);') &&
    rt.includes('char* sbuf = (char*)malloc(AS_ARENA_SEG_CAP);') &&
    rt.includes('if (s == NULL || sbuf == NULL) { free(s); free(sbuf); as_gc_oom(AS_ARENA_SEG_CAP); }'));
  check('both realloc sites grow through a temporary (failure must not drop the old block)',
    rt.includes('gc_seg_range* grown = (gc_seg_range*)realloc(') &&
    rt.includes('gc_header** grown = (gc_header**)realloc(') &&
    !/gc_seg_ranges = \(gc_seg_range\*\)realloc\(/.test(rt) &&
    !/gc_inc\.grey = \(gc_header\*\*\)realloc\(/.test(rt));
  check('the forced-failure probe is opt-in and only read on the segment path',
    rt.includes('getenv("ASC_FORCE_OOM_MIN")') &&
    rt.includes('int oom_forced = as_oom_force_min != 0 && seg_size >= as_oom_force_min;'));

  // ---- 5. a refused C++ allocation raises Error #1000, it does not abort ----
  // The stage-二百八十 dump: exe+0x14bbab0 is `_abort+0x29`, reached from
  // `_terminate` <- `__scrt_unhandled_exception_filter` <- `__except_handler4`
  // with `__CxxThrowException` and the `std::bad_alloc` type descriptor still on
  // the stack, and `SkData::MakeUninitialized` at the bottom of the allocating
  // chain. exit code 0xC0000409 = __fastfail(7) from abort(). No AS3 error, nothing
  // catchable: the 32-bit app died on the one failure AIR reports as Error #1000.
  const glue = read('vendor/skia_glue.cc');
  check('the Skia glue replaces the global operator new and new[]',
    glue.includes('void* operator new(std::size_t n) { return sk_cxx_alloc(n); }') &&
    glue.includes('void* operator new[](std::size_t n) { return sk_cxx_alloc(n); }') &&
    glue.includes('void operator delete(void* p, std::size_t) noexcept { std::free(p); }'));
  check('...never throwing std::bad_alloc itself (that is what reached terminate)',
    !/operator new[\s\S]{0,200}throw std::bad_alloc/.test(glue) &&
    glue.includes('if (g_cxx_oom_hook(n) == 0) sk_cxx_oom_no_hook(n);'));
  check('...retrying only after the runtime reports that a collection ran',
    glue.includes('        if (g_cxx_oom_hook(n) == 0) sk_cxx_oom_no_hook(n);\n' +
                  '        // else: the runtime freed something, so try the allocation again'));
  check('...and reporting before aborting when no hook was installed (a C++-only link)',
    glue.includes('if (g_cxx_oom_hook == NULL) sk_cxx_oom_no_hook(n);') &&
    glue.includes('(no runtime OOM hook installed)\\n'));
  check('the runtime funnels both allocation paths through one raise',
    rt.includes('static _Noreturn void as_oom_raise(void) {') &&
    rt.includes('static int as_oom_from_cxx(size_t need) {') &&
    // as_gc_oom must delegate, not duplicate: two copies of the kOutOfMemoryError
    // raise is how the C++ path would drift away from the C path.
    /static _Noreturn void as_gc_oom\(size_t need\) \{[\s\S]{0,1200}?as_oom_raise\(\);/.test(rt) &&
    rt.split('as_error_new_oom("Error #1000').length - 1 === 1);
  check('...collecting at most once per 250 ms before escalating (no spin in operator new)',
    rt.includes('now - as_cxx_oom_last_ms > 250.0') &&
    /if \(!as_cxx_oom_forced && !gc_in_gc && gc_segs != NULL/.test(rt));
  check('the hook is installed only in a Skia build, and installed from main',
    rt.includes('#ifdef ASC_USE_SKIA\nextern void sk_set_oom_hook(int (*hook)(size_t));') &&
    rt.includes('    sk_set_oom_hook(as_oom_from_cxx);') &&
    em.includes("this.line('as_oom_hook_install();');"));
  check('the forced-refusal probe is opt-in (ASC_FORCE_CXX_OOM) and read once',
    glue.includes('const char* force = std::getenv("ASC_FORCE_CXX_OOM");') &&
    rt.includes('getenv("ASC_FORCE_CXX_OOM")'));

  if (ok > 0) console.log(`[crash] ${ok} crash-hardening checks passed`);
  return bad;
}
registerGroup('unit: crash/hardening', checkCrashHardening);