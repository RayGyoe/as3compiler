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
