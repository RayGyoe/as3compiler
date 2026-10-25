// null-string.as — ES3 ToString(null) is the text "null", and that is also what
// must reach printf.
//
// On Windows ucrt a null pointer passed for "%s" is an INVALID PARAMETER: the CRT
// calls _invalid_parameter -> __fastfail, which terminates the process with
// 0xC0000409. Measured on a real AOT app: 388 thrown #1009 errors, then that exit
// code, no dump. The pointer came from the uncaught-error printer, but the same
// shape is reachable from trace() and from string concatenation, so every producer
// of a C string normalises to "null" instead of handing NULL on.
//
// Each block below is a different way the pointer can be null:
//   1. a String slot that was never assigned        (static type String -> C NULL)
//   2. the same value read through a '*' slot       (boxed, tag 3 with a null ptr)
//   3. an object whose toString() returns null      (user code, AIR renders "null")
//   4. the same object reached through a '*' slot   (as_obj_to_str)
//   5. null concatenated into a string              ("x" + null + "y" -> "xnully")
//
// Before the fix every one of these killed the process on Windows.
class NullStr {
    public function toString():String { return null; }
}

var s:String = null;
trace(s);

var anyNull:* = s;
trace(anyNull);

var n:NullStr = new NullStr();
trace(n);

var anyObj:* = n;
trace(anyObj);

trace("x" + s + "y");

// The same null String also has to survive the generic accessor used by trace's
// '*' branch, which is where a hand-built as_value would otherwise leak NULL.
if (String(null) != "null") throw new Error("String(null) must be \"null\"");

trace("null-string: all 5 null paths printed without a fatal");