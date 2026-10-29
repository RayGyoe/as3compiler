// Unit checks: the FRE string boundary's byte-length contract.
//
// The AIR SDK header documents FREGetObjectAsUTF8's length as "The size, in
// bytes, of the string. Includes the null terminator." -- and that sentence is
// wrong about AIR itself. adl is the oracle, and AIR does NOT count it. Measured
// with adl 51.4.1 + ANEWebSocket (ext-aot A/B: one machine, one URL, one token,
// the same native source on both sides):
//
//   adl  -> param: platform=windows&timestamp=...&appversion=1.9.36
//   ours -> param: platform=windows&timestamp=...&appversion=1.9.36\0   (<- bug)
//
// The native side prints that line with `cout << "param: " + query`, and
// operator+ yields a std::string that writes size() bytes, so the NUL is the
// length AIR does not report rather than a print artefact. ANEUtils::getString
// builds the string from [val, val + length), so the byte became part of the URL
// and then of websocketpp's request line ("GET /node1?...1.9.36\0 HTTP/1.1"): the
// server closed without answering and every wss connect failed as status_code 0 +
// websocketpp.transport:7 (EOF), before any TLS handshake. Extensions that merely
// hand the pointer to a C string API (printf, strcmp) never noticed the byte;
// anything carrying an explicit length -- a std::string, a wire frame, a hash --
// did, which is why only WebSocket broke.
//
// A CJK probe settles "bytes or UTF-16 units": four CJK chars are 12 UTF-8 bytes
// but 4 units, and adl prints 12 of them (byte-identical to ours), so the count
// is bytes = strlen on our UTF-8 string representation.
//
// The reverse direction keeps the documented "+1": FRENewObjectFromUTF8's length
// DOES include the terminator, and both our fixture (examples/ane/ProbeANE.c) and
// real extensions (ANEWebSocket) pass strlen+1 -- so it must keep accepting the
// terminator without ever appending it to the string.
//
// No example can catch any of this: nothing in examples/ observes what the native
// side of FRE sees, and the defect is a length, not a value.
import { FRE_BODY } from '../../src/fre.ts';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup, root, readNorm } from '../harness.ts';
import { join } from 'node:path';

// One top-level C function: from its signature to the first closing brace that
// sits at column 0 (emitted functions are not indented).
function funcBody(c: string, signature: string): string {
  const start = c.indexOf(signature);
  if (start < 0) return '';
  const end = c.indexOf('\n}', start);
  return end < 0 ? c.slice(start) : c.slice(start, end + 2);
}

function checkFreUtf8Length(): string[] {
  const failed: string[] = [];
  const get = funcBody(FRE_BODY, 'FREResult FREGetObjectAsUTF8(');
  const make = funcBody(FRE_BODY, 'FREResult FRENewObjectFromUTF8(');

  if (get === '') {
    failed.push('FREGetObjectAsUTF8: not found in the FRE body');
  } else {
    if (!/\*length = \(uint32_t\)strlen\(s\);/.test(get)) {
      failed.push('FREGetObjectAsUTF8: length must be the byte count strlen(s)');
    }
    // The exact shape of the defect: any terminator added to the reported length
    // hands the extension a NUL it will put on the wire.
    if (/\*length\s*=[^;]*\+\s*1\b/.test(get)) {
      failed.push('FREGetObjectAsUTF8: length must not count the null terminator');
    }
    if (!/\*value = \(const uint8_t\*\)s;/.test(get)) {
      failed.push('FREGetObjectAsUTF8: must hand over the string itself');
    }
    // The buffer stays NUL-terminated for callers that read one byte past it.
    if (!/v\.tag != 3 \|\| v\.ptr == NULL/.test(get)) {
      failed.push('FREGetObjectAsUTF8: a non-String must stay FRE_TYPE_MISMATCH');
    }
  }

  if (make === '') {
    failed.push('FRENewObjectFromUTF8: not found in the FRE body');
  } else {
    // strlen+1 callers pass a terminator; it must be accepted...
    if (!/value\[n - 1\] == 0/.test(make)) {
      failed.push('FRENewObjectFromUTF8: must tolerate a caller-supplied terminator');
    }
    // ...and must not become part of the string, whichever idiom the caller used.
    if (!/memcpy\(s, value, n\);/.test(make) || !/s\[n\] = 0;/.test(make)) {
      failed.push('FRENewObjectFromUTF8: must copy the bytes without the terminator');
    }
  }

  return failed;
}

registerGroup('unit: fre/Utf8LengthContract', checkFreUtf8Length);

// --- the host side of the FRE body on POSIX (阶段二百零三) ----------------------
//
// FRE_BODY was Windows-only INSIDE: LoadLibraryA, a CRITICAL_SECTION status-queue
// lock, CreateThread, GetModuleFileNameA. None of that is visible on Windows, and
// it is a compile error on macOS -- measured, in two rounds: first "static
// declaration of 'FREGetObjectType' follows non-static declaration" (asaot.h
// declaring the 51 entry points with external linkage while the size pass makes
// the host's definitions `static`; Windows only WARNS about the same mismatch,
// which is why the branch had gone unnoticed), then "use of undeclared identifier
// 'HMODULE'" once that was fixed. The repair and the regression look identical in
// a diff of the Windows branch, so the branch is what gets pinned.
//
// The rule is read off the PREPROCESSOR rather than off a list of function names:
// a Win32-only identifier is a defect exactly when it sits on a line macOS would
// COMPILE, i.e. outside the Windows branch of every enclosing `#if defined(_WIN32)`.
// A name list is only as complete as the day it was written; the branch test stays
// right the next time a Win32 API is reached for.
const WIN32_IDENT = /\b(HMODULE|HINSTANCE|DWORD|HANDLE|LPSTR|WINAPI|__declspec|GetModuleFileNameA|LoadLibraryA|GetProcAddress|GetLastError|CreateThread|OpenThread|WaitForSingleObject|CloseHandle|InitializeCriticalSection|EnterCriticalSection|TryEnterCriticalSection|LeaveCriticalSection|DeleteCriticalSection|GetCurrentThreadId|Sleep)\b/;

// The lines of `c` that macOS compiles AND that match `pattern`. Frames are the
// enclosing `#if`s; `win` marks a frame whose test mentions _WIN32 and `negated`
// whether the branch being read is the NEGATION of it (`#else`, or `#ifndef` /
// `!defined`). Nesting is why this is a stack: `#if !defined(_WIN32)` wrapped
// around `#if defined(__APPLE__)` must leave a macOS line looking like one.
//
// Comments are skipped. Naming GetModuleFileNameA in a sentence that explains why
// the POSIX side computes the same thing differently is prose, not a call -- and the
// two leaks this pin found on its first run were exactly that. Since FRE_BODY has no
// `/* */` comments (checked), skipping `//` and `*` lines cannot mis-frame the
// stack: no `#if` hides inside a comment here.
function macosCompiledLines(c: string, pattern: RegExp): string[] {
  const frames: Array<{ win: boolean; negated: boolean }> = [];
  const hits: string[] = [];
  for (const line of c.split('\n')) {
    const d = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
    if (d) {
      const kind = d[1];
      const rest = d[2];
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        const mentionsWin = /_WIN32/.test(rest);
        frames.push({ win: mentionsWin, negated: mentionsWin && (kind === 'ifndef' || /!\s*defined/.test(rest)) });
      } else if (kind === 'endif') {
        frames.pop();
      } else if (kind === 'else') {
        const top = frames[frames.length - 1];
        if (top) top.negated = !top.negated;
      } else {
        // `#elif`: the branch now being read is any branch but the one just closed,
        // so an `#elif !defined(_WIN32)` is the non-Windows one and an `#elif
        // defined(_WIN32)` is the Windows one. Only the former occurs today.
        const top = frames[frames.length - 1];
        if (top && top.win) top.negated = !/_WIN32/.test(rest) || /!\s*defined/.test(rest);
      }
      continue;
    }
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const onWindows = frames.some((f) => f.win && !f.negated);
    if (!onWindows && pattern.test(line)) hits.push(line.trim());
  }
  return hits;
}

function checkFrePlatformSplit(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [freplat] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [freplat] ${label}`); }
  };
  const c = FRE_BODY;

  const leaks = macosCompiledLines(c, WIN32_IDENT);
  check('no Win32-only call survives outside a `#if defined(_WIN32)` branch',
    leaks.length === 0);
  for (const l of leaks.slice(0, 5)) console.log(`      leak: ${l}`);

  // The POSIX half has to exist, not merely be free of Windows names: an empty
  // `#else` would pass the check above while failing to compile.
  const posix = [
    ['the dynamic loader', '#include <dlfcn.h>', 'dlopen(', 'dlsym('],
    ['the executable\'s own directory', '_NSGetExecutablePath', '/proc/self/exe'],
    ['a recursive lock for the status queue', 'pthread_mutexattr_settype', 'PTHREAD_MUTEX_RECURSIVE'],
    ['threads', 'pthread_create', 'pthread_detach'],
  ] as const;
  for (const [what, ...needles] of posix) {
    check(`POSIX ${what} is implemented, not stubbed out`,
      needles.every((n) => c.includes(n)));
  }

  // The two macros are what keep the library's NAME from being hardcoded at the
  // five call sites that mention it, and the names differ per platform on purpose
  // (see ane.ts aneHostLibName).
  check('the runtime library name is one macro with both spellings',
    /#define AS_FRE_LIB_NAME\s+"asaot\.dll"/.test(c)
    && /#define AS_FRE_LIB_NAME\s+"libasaot\.dylib"/.test(c));
  check('the extension LINKS against a distinct link name on Windows only',
    /#define AS_FRE_LINK_NAME\s+"asaot\.lib"/.test(c)
    && /#define AS_FRE_LINK_NAME\s+"libasaot\.dylib"/.test(c));

  // One lock for every context's status queue, reached through the macros only: a
  // bare `EnterCriticalSection(&as_fre_qcs)` on a POSIX build names a type that does
  // not exist there, and the two used to be mixed (the macro's own definition IS a
  // Windows-branch line, which is why this goes through the same branch test rather
  // than being grepped for the identifier).
  check('every status-queue critical section goes through the lock macros',
    macosCompiledLines(c, /(Enter|Leave|TryEnter)CriticalSection\s*\(\s*&as_fre_qcs/).length === 0
    && c.includes('#define AS_FRE_Q_LOCK()') && c.includes('#define AS_FRE_Q_UNLOCK()'));

  console.log(`     [freplat] ${ok} check(s) passed`);
  return bad;
}
registerGroup('unit: fre/PlatformSplit', checkFrePlatformSplit);

// --- native window handles: the one D-face pair that is NOT deferred (阶段三百零九) ---
//
// The claim being protected is not "a pointer comes back". It is the shape of the
// answer at both ends of the capability range: with a window backend an extension
// gets the REAL platform object, and without one it gets a reported
// FRE_ILLEGAL_STATE. A fabricated pointer passes the first half and crashes inside
// the extension, which is the failure mode AGENTS.md 1.5 exists for -- so the
// refusal half is what gets pinned hardest here. The end-to-end half lives in
// examples/ane (headless: refusal) and examples/ane-app (windowed: real HWND).
function checkFreNativeWindowHandle(): string[] {
  const failed: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) console.log('PASS  [frenwh] ' + label);
    else { failed.push(label); console.log('FAIL  [frenwh] ' + label); }
  };

  const acquire = funcBody(FRE_BODY, 'FREResult FREAcquireNativeWindowHandle(');
  const release = funcBody(FRE_BODY, 'FREReleaseNativeWindowHandle(');

  check('acquire exists in the FRE body', acquire !== '');
  check('release exists in the FRE body', release !== '');
  // The stub this replaces: answering FRE_ILLEGAL_STATE from these two would
  // silently restore "native window handles are out of scope".
  check('acquire no longer reports itself as unimplemented',
    acquire !== '' && !acquire.includes('not implemented by this build: FREAcquireNativeWindowHandle'));
  check('release no longer reports itself as unimplemented',
    release !== '' && !release.includes('as_shell_unsupported'));

  // A null OUT pointer is a caller bug, not an AS3 error.
  check('acquire rejects a null out pointer with FRE_INVALID_ARGUMENT',
    acquire.includes('if (handle == NULL) return FRE_INVALID_ARGUMENT;'));
  // The operand contract: null/undefined is INVALID_OBJECT, anything else that is
  // not a NativeWindow is a TYPE error (the same reading asaot.h takes).
  check('acquire separates null (INVALID_OBJECT) from a wrong type (TYPE_MISMATCH)',
    acquire.includes('if (v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;')
    && acquire.includes('if (!as_native_window_id_of(v, &id)) return FRE_TYPE_MISMATCH;'));
  // A CLOSED window's slot is recycled, so answering it would hand out the NEXT
  // window's handle -- the one case where "no answer" is the only right answer.
  check('acquire refuses a closed window (recycled slot) with FRE_ILLEGAL_STATE',
    acquire.includes('if (id < 0) return FRE_ILLEGAL_STATE;'));
  // The handle comes from the seam, never from a Win32/Cocoa call made here: the
  // platform split lives in window_glue, and this file must stay portable.
  check('acquire takes the handle from the window seam',
    acquire.includes('void* h = as_window_native_handle(id);'));
  // No window backend at all (web) => report, do not return a pointer.
  check('acquire reports a missing window backend instead of fabricating a handle',
    acquire.includes('if (h == NULL) {')
    && acquire.includes('as_shell_unsupported("FREAcquireNativeWindowHandle')
    && acquire.includes('return FRE_ILLEGAL_STATE;'));
  check('acquire hands back the seam pointer as FRE_OK',
    acquire.includes('*handle = (FRENativeWindow)h;') && acquire.includes('return FRE_OK;'));
  // Release is balanced against an acquire that retains nothing, but it still
  // validates its operand -- silently accepting a Point would hide a caller bug.
  check('release validates its operand and answers FRE_OK',
    release.includes('if (v.tag == 0 || v.tag == 5) return FRE_INVALID_OBJECT;')
    && release.includes('if (!as_native_window_id_of(v, &id)) return FRE_TYPE_MISMATCH;')
    && release.includes('return FRE_OK;'));

  // --- the hook emit.ts emits next to the NativeWindow class ---------------
  const c = generateC(parse('var x:int = 1;\n')).c;
  const hook = funcBody(c, 'static int as_native_window_id_of(as_value v, int* out) {');
  check('a program emits the NativeWindow -> slot hook', hook !== '');
  // as_v_is_inst, not as_is: a CLASS value carries the same vtable word and would
  // otherwise be read as an instance, whose _win is not a window slot.
  check('the hook rejects a NativeWindow CLASS value (as_v_is_inst)',
    hook.includes('if (!as_v_is_inst(v, &NativeWindow_vt)) return 0;'));
  check('the hook answers the slot from the object',
    hook.includes('*out = ((NativeWindow*)as_v_obj_val(v))->_win;'));

  // --- the window seam: BOTH branches, or a headless build stops compiling --
  const preamble = readNorm(join(root, 'src', 'runtime.ts'));
  check('the seam is declared for the window backend',
    preamble.includes('extern void* sk_window_native_handle(int id);'));
  const seam = [
    'static inline void* as_window_native_handle(int id) {',
    '#ifdef ASC_USE_WINDOW',
    '    return sk_window_native_handle(id);',
    '#else',
    '    (void)id; return NULL;',
    '#endif',
    '}',
  ].join('\n');
  check('the seam forwards to the glue when a window backend exists', preamble.includes(seam));
  // Both branches live in the SAME helper: a headless build reaches the FRE entry
  // point too, so a missing stub is a compile error there and nowhere else.
  check('the seam has a no-window stub as well (headless/web builds)',
    preamble.includes('static inline void* as_window_native_handle(int id) { (void)id; return NULL; }'));

  // --- the glue: one platform object per platform, and NULL for "no window" --
  const glue = readNorm(join(root, 'vendor', 'window_glue.cc'));
  const gl = funcBody(glue, 'void* sk_window_native_handle(int id) {');
  check('the glue answers NULL for an unknown or unpublished slot',
    gl.includes('if (c == NULL || c->win == NULL) return NULL;'));
  check('the glue asks SDL for the platform object',
    gl.includes('SDL_GetWindowWMInfo(c->win, &info)'));
  check('the glue answers the HWND on Windows',
    gl.includes('return (void*)info.info.win.window;'));
  check('the glue answers the NSWindow on macOS',
    gl.includes('return (void*)info.info.cocoa.window;'));

  if (failed.length !== 0) console.log('     [frenwh] ' + failed.length + ' check(s) failed');
  return failed;
}
registerGroup('unit: fre/NativeWindowHandle', checkFreNativeWindowHandle);

// --- BitmapData direct pixel access: the four entry points a video ANE is built on
//
// The contract being protected is NOT "a pointer comes back". It is:
//
//   * the pointer is the BitmapData's OWN `pixels` buffer (a copy would look right
//     to `getPixel32` and be invisible to the renderer);
//   * a write through it becomes VISIBLE, which in this runtime means the version
//     counter as_bmd_live_image caches on must move -- an extension's write is not a
//     call through BitmapData's own mutators, so nothing else will move it;
//   * the two descriptor versions stay distinguishable (v2 inserts isInvertedY
//     before bits32), so a shared struct copy would hand a v1 client the pointer
//     where it reads stride;
//   * a bad operand is a FREResult and never a crash -- including a DISPOSED
//     BitmapData, whose `pixels` is NULL.
//
// The behaviour itself is pinned end-to-end by examples/ane (write-through, both
// descriptor versions, the error codes) and examples/ane-app (two frames through a
// real Bitmap: the second must replace the first). These checks exist because the
// example suite only runs builds that must SUCCEED -- it cannot see a hook that
// silently stops invalidating.
function checkFreBitmapDataAcquire(): string[] {
  const failed: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) console.log('PASS  [frebmd] ' + label);
    else { failed.push(label); console.log('FAIL  [frebmd] ' + label); }
  };

  const describe = funcBody(FRE_BODY, 'static FREResult as_fre_bmd_describe(');
  const acq = funcBody(FRE_BODY, 'static FREResult FREAcquireBitmapData(');
  const acq2 = funcBody(FRE_BODY, 'static FREResult FREAcquireBitmapData2(');
  const inv = funcBody(FRE_BODY, 'static FREResult FREInvalidateBitmapDataRect(');
  const rel = funcBody(FRE_BODY, 'static FREResult FREReleaseBitmapData(');

  check('all four entry points exist in the FRE body',
    describe !== '' && acq !== '' && acq2 !== '' && inv !== '' && rel !== '');
  // The stubs this replaces: FRE_ILLEGAL_STATE here is what makes an extension's
  // acquire fail on every frame, which is the state RENDMODEL=BITMAPDATA must not
  // fall back to.
  check('none of the four reports itself as unimplemented',
    !acq.includes('as_shell_unsupported') && !acq2.includes('as_shell_unsupported')
    && !inv.includes('as_shell_unsupported') && !rel.includes('as_shell_unsupported'));

  // A null OUT pointer is a caller bug, not an AS3 error.
  check('acquire (v1) rejects a null out pointer with FRE_INVALID_ARGUMENT',
    acq.includes('if (descriptorToSet == NULL) return FRE_INVALID_ARGUMENT;'));
  check('acquire (v2) rejects a null out pointer with FRE_INVALID_ARGUMENT',
    acq2.includes('if (descriptorToSet == NULL) return FRE_INVALID_ARGUMENT;'));

  // v1 vs v2: the layouts diverge in the middle, so the v1 answer is assembled
  // field by field. A memcpy between them is the defect this pins.
  check('acquire (v1) copies the fields instead of memcpy-ing the v2 struct',
    acq.includes('descriptorToSet->bits32 = d.bits32;') && !acq.includes('memcpy(descriptorToSet'));
  // The v1 descriptor has no isInvertedY field at all, so no assignment may target
  // one (the function's own comment mentions the field by name, hence the
  // assignment shape rather than a bare word search).
  check('acquire (v1) never writes isInvertedY (a v1 client has no such field)',
    !/descriptorToSet->isInvertedY\s*=/.test(acq));

  // The operand split: AS3 null/undefined is a missing object, a primitive or an
  // object of the wrong class is a type error, a disposed bitmap is a missing object.
  check('describe separates null (INVALID_OBJECT) from a wrong class (TYPE_MISMATCH)',
    describe.includes('if (v.tag != 4 || v.ptr == NULL) return FRE_INVALID_OBJECT;')
    && describe.includes('if (st == 0) return FRE_TYPE_MISMATCH;'));
  check('describe reports a disposed BitmapData as FRE_INVALID_OBJECT (not a type error)',
    describe.includes('if (st < 0) return FRE_INVALID_OBJECT;'));
  // A build whose BitmapData is not part of it must REPORT the gap, never deref a
  // NULL hook (the same reading as AGENTS.md 1.5).
  check('describe reports a missing BitmapData class instead of calling a null hook',
    describe.includes('if (as_fre_bmd_desc_hook == NULL) {')
    && describe.includes('as_shell_unsupported("FREAcquireBitmapData')
    && describe.includes('return FRE_ILLEGAL_STATE;'));

  // The invalidation half. This is the check that keeps a video frame from freezing
  // on frame 1: both "I am done writing" and "this rect changed" must go through the
  // dirty hook, because an extension's write does not pass through BitmapData's own
  // mutators and therefore moves no version counter by itself.
  check('release marks the surface dirty', rel.includes('as_fre_bmd_dirty_hook('));
  check('invalidate marks the surface dirty', inv.includes('as_fre_bmd_dirty_hook('));
  check('invalidate/release still answer FRE_OK after a valid describe',
    rel.includes('if (r != FRE_OK) return r;') && rel.includes('return FRE_OK;')
    && inv.includes('if (r != FRE_OK) return r;') && inv.includes('return FRE_OK;'));

  // Both hooks are null-initialised in the body: a build that instantiates no
  // BitmapData must reach the report above, not a jump through NULL.
  check('the descriptor hook is declared and null-initialised',
    /static int\s+\(\*as_fre_bmd_desc_hook\)\(void\* bd, FREBitmapData2\* out\) = NULL;/.test(FRE_BODY));
  check('the dirty hook is declared and null-initialised',
    /static void \(\*as_fre_bmd_dirty_hook\)\(void\* bd\) = NULL;/.test(FRE_BODY));

  // --- the emitter half: the hooks, and what the descriptor actually says -------
  const c = generateC(parse('var x:int = 1;\n')).c;
  const desc = funcBody(c, 'static int as_fre_bmd_desc_impl(void* p, FREBitmapData2* out) {');
  const dirty = funcBody(c, 'static void as_fre_bmd_dirty_impl(void* p) {');
  const live = funcBody(c, 'static void* as_bmd_live_image(BitmapData* bd) {');

  check('a program emits the BitmapData -> descriptor hook', desc !== '');
  check('a program emits the BitmapData -> dirty hook', dirty !== '');
  // as_is, not a tag test: a BitmapData SUBCLASS is one too, and a Bitmap is not.
  check('the descriptor hook identifies a BitmapData by vtable', desc.includes('!as_is(p, &BitmapData_vt)'));
  check('the descriptor hook answers 0 (not a BitmapData) instead of a descriptor',
    desc.includes('return 0;'));
  // Disposed: still a BitmapData, no pixels. -1 is the "missing object" answer.
  check('the descriptor hook answers -1 for a disposed bitmap',
    desc.includes('if (bd->pixels == NULL) return -1;'));
  // The pointer IS the live buffer, and nothing else: a copy here would make the
  // write visible to getPixel32 and invisible to the renderer.
  check('the descriptor points at the bitmap own pixel buffer',
    desc.includes('out->bits32 = (uint32_t*)bd->pixels;'));
  check('the descriptor reports the true geometry and a tight stride',
    desc.includes('out->width = (uint32_t)bd->width;')
    && desc.includes('out->height = (uint32_t)bd->height;')
    && desc.includes('out->lineStride32 = (uint32_t)bd->width;')
    && desc.includes('out->isInvertedY = 0u;'));
  // `pixels` holds STRAIGHT 0xAARRGGBB (sk_image_from_argb makes the SkImage with
  // kUnpremul), and hasAlpha follows the AS3 `transparent` flag.
  check('the descriptor says straight alpha, and takes hasAlpha from transparent',
    desc.includes('out->isPremultiplied = 0u;')
    && desc.includes('out->hasAlpha = bd->transparent ? 1u : 0u;'));
  // Cross-file invariant: the counter the dirty hook moves must be the one the
  // image cache watches. If either side renames or re-keys, a video frame stops
  // being re-snapshotted and the picture freezes with no error at all.
  check('the dirty hook moves the version counter the image cache watches',
    dirty.includes('bd->_px_ver++;')
    && live.includes('bd->_live_ver == bd->_px_ver'));
  check('the dirty hook ignores a bitmap with no pixels left',
    dirty.includes('if (bd == NULL || bd->pixels == NULL) return;'));
  check('both hooks are wired at startup',
    c.includes('as_fre_bmd_desc_hook = as_fre_bmd_desc_impl;')
    && c.includes('as_fre_bmd_dirty_hook = as_fre_bmd_dirty_impl;'));

  if (failed.length !== 0) console.log('     [frebmd] ' + failed.length + ' check(s) failed');
  return failed;
}
registerGroup('unit: fre/BitmapDataAcquire', checkFreBitmapDataAcquire);
