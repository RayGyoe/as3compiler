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
import { registerGroup } from '../harness.ts';

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
