// examples/string-indexof.as — String.indexOf / lastIndexOf with the optional
// startIndex.
//
// Regression for a real defect (fixed in stage 89·53): the codegen emitted both
// methods with a single argument, so a second argument was SILENTLY DROPPED —
// `s.indexOf("\n", i)` returned the first newline instead of the next one, which
// is a wrong answer rather than a missing feature (the HTTP/2 probe hit it while
// walking a response body line by line).
//
// Every expected value below is measured from adl (the reference runtime), not
// derived from the docs — see temp/air-probe/Probe10.as and its result file. The
// interesting cases are exactly the ones that distinguish the plausible
// implementations from AIR's:
//   * startIndex is CLAMPED into [0, len] for indexOf (so 99 is not an error)
//   * an empty needle matches AT the clamped position
//   * lastIndexOf treats a NEGATIVE startIndex as -1 outright, it does not clamp
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var s:String = "abcabc";

// --- indexOf ---------------------------------------------------------------
check(s.indexOf("bc") == 1, "indexOf(bc) = 1");
check(s.indexOf("bc", 2) == 4, "indexOf(bc,2) = 4 (the whole point: search starts at 2)");
check(s.indexOf("bc", 4) == 4, "indexOf(bc,4) = 4");
check(s.indexOf("bc", 5) == -1, "indexOf(bc,5) = -1");
check(s.indexOf("bc", 6) == -1, "indexOf(bc,6) = -1");
check(s.indexOf("bc", 99) == -1, "indexOf(bc,99) = -1 (clamped, not an error)");
check(s.indexOf("bc", -3) == 1, "indexOf(bc,-3) = 1 (negative clamps to 0)");
check(s.indexOf("z", 2) == -1, "indexOf(z,2) = -1");
check(s.indexOf("") == 0, "indexOf('') = 0");
check(s.indexOf("", 2) == 2, "indexOf('',2) = 2");
check(s.indexOf("", 9) == 6, "indexOf('',9) = 6 (clamped to len)");
check(s.indexOf("", -2) == 0, "indexOf('',-2) = 0");

// --- lastIndexOf -----------------------------------------------------------
check(s.lastIndexOf("bc") == 4, "lastIndexOf(bc) = 4");
check(s.lastIndexOf("bc", 3) == 1, "lastIndexOf(bc,3) = 1");
check(s.lastIndexOf("bc", 4) == 4, "lastIndexOf(bc,4) = 4");
check(s.lastIndexOf("bc", 99) == 4, "lastIndexOf(bc,99) = 4");
check(s.lastIndexOf("bc", -1) == -1, "lastIndexOf(bc,-1) = -1");
check(s.lastIndexOf("a", -1) == -1, "lastIndexOf(a,-1) = -1 (negative is NOT clamped to 0)");
check(s.lastIndexOf("z") == -1, "lastIndexOf(z) = -1");
check(s.lastIndexOf("") == 6, "lastIndexOf('') = 6");
check(s.lastIndexOf("", 2) == 2, "lastIndexOf('',2) = 2");

// The pattern the defect broke: walking every line of a body.
var body:String = "one\ntwo\nthree";
var lines:int = 1;
var at:int = body.indexOf("\n");
while (at >= 0) {
  lines++;
  at = body.indexOf("\n", at + 1);
}
check(lines == 3, "line walk counts 3 lines, got " + lines);

trace("string-indexof: assertions passed");