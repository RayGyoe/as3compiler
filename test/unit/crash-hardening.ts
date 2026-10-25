// Unit checks: process-killing defects found by the crash monitor on a real
// Windows AOT app (阶段二百七十八). Three independent failure modes, all of them
// fatal-to-the-process rather than wrong-value, which is why they are pinned here
// and exercised end-to-end by examples/null-string.as and examples/uncaught-storm.as.
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
// Source-level pins, not behavioural: all three are fatals whose only observable is
// "the process died", and d3d_glue.cc cannot be compiled on a non-Windows host.
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
    /if \(d3d_hr_is_device_lost\(phr\)\) \{ d3d_mark_lost\("Present", phr\); return; \}/.test(d3d));
  check('the Ganesh context is abandoned, not reset (a removed device cannot be freed normally)',
    /g_context->abandonContext\(\);/.test(d3d) &&
    !/g_context->reset\(\);\s*\n\s*g_context\.reset\(\);/.test(d3d));
  check('one swapchain builder serves init and rebuild',
    /static int d3d_create_swapchain\(/.test(d3d) &&
    (d3d.match(/CreateSwapChainForHwnd\(/g) ?? []).length === 1);
  check('rebuild retries back off instead of spinning on D3D12CreateDevice every frame',
    /g_d3d_retry_ms = g_d3d_retry_ms \* 2 > 4000 \? 4000 : g_d3d_retry_ms \* 2;/.test(d3d));

  if (ok > 0) console.log(`[crash] ${ok} crash-hardening checks passed`);
  return bad;
}
registerGroup('unit: crash/hardening', checkCrashHardening);