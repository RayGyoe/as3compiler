// int-cast.as -- int(x) / uint(x) are ES3 ToInt32 / ToUint32, NOT a C cast.
//
// C's `(int)` of a double is UNDEFINED BEHAVIOUR as soon as the value is NaN,
// infinite, or outside int32: the same expression printed 1, 1073741824,
// 2147483647 or a garbage negative depending only on the surrounding function
// (Apple clang -O2, arm64, see temp/d31probe/). AIR is TOTAL and WRAPS, exactly
// as ECMA-262 3rd ed. section 9.5 (ToInt32) / 9.6 (ToUint32) prescribe. Before
// this fix every `int(...)` / `uint(...)` call form emitted a bare cast, so a
// NaN or an out-of-range Number -- a perfectly ordinary thing to hand to a
// converter -- produced whatever the machine happened to do.
//
// Reference values below are the adl 51.4.1 oracle on the SAME source
// (temp/d31probe/adl-intcast.txt for the dynamic column, temp/d31probe/mine.as
// for the static one; the whole 26-row table is byte-identical to ours after the
// fix). Note the two spellings are deliberately all covered: a parameter hides
// the value from constant folding, a literal proves the folded case too.
//
// `int(NaN)` / `int(Infinity)` -> 0 and NOT a trap or a garbage value, because
// ToInt32 says NaN/Infinity map to +0. The wrap is modulo 2^32: int(2^31) is
// -2^31, int(2^32+5) is 5, uint(-1.5) is 4294967295.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// Parameters (opaque to -O2) -- the cases where a bare cast went wrong.
function iNum(n:Number):int { return int(n); }
function uNum(n:Number):uint { return uint(n); }
function iAny(v:*):int { return int(v); }
function uAny(v:*):uint { return uint(v); }
function iStr(s:String):int { return int(s); }

// --- 1. NaN / Infinity: +0, never undefined behaviour ------------------------
check(iNum(NaN) == 0, "int(NaN) is 0, got " + iNum(NaN));
check(uNum(NaN) == 0, "uint(NaN) is 0, got " + uNum(NaN));
check(iNum(Infinity) == 0, "int(Infinity) is 0, got " + iNum(Infinity));
check(iNum(-Infinity) == 0, "int(-Infinity) is 0, got " + iNum(-Infinity));
check(iNum(0 / 0) == 0, "int(0/0) is 0, got " + iNum(0 / 0));

// --- 2. wrap-around: modulo 2^32 ---------------------------------------------
check(iNum(1e10) == 1410065408, "int(1e10), got " + iNum(1e10));
check(uNum(1e10) == 1410065408, "uint(1e10), got " + uNum(1e10));
check(iNum(-1e10) == -1410065408, "int(-1e10), got " + iNum(-1e10));
check(uNum(-1e10) == 2884901888, "uint(-1e10), got " + uNum(-1e10));
check(iNum(2147483648) == -2147483648, "int(2^31), got " + iNum(2147483648));
check(uNum(4294967296) == 0, "uint(2^32), got " + uNum(4294967296));
check(iNum(4294967301) == 5, "int(2^32+5), got " + iNum(4294967301));
check(uNum(4294967301) == 5, "uint(2^32+5), got " + uNum(4294967301));

// --- 3. fractional and negative truncation -----------------------------------
// ToInt32 truncates TOWARD ZERO; ToUint32 truncates and then takes the modulus,
// so a negative fraction lands near the top of the unsigned range.
check(iNum(7.9) == 7 && uNum(7.9) == 7, "positive fraction truncates to 7");
check(iNum(-7.9) == -7, "int(-7.9) truncates toward zero, got " + iNum(-7.9));
check(uNum(-7.9) == 4294967289, "uint(-7.9), got " + uNum(-7.9));
check(iNum(0.5) == 0 && iNum(-0.5) == 0, "a fraction below 1 is 0 (both signs)");

// --- 4. the literal call form (what -O2 also has to fold correctly) ---------
check(int(NaN) == 0, "literal int(NaN) is 0");
check(int(1e10) == 1410065408, "literal int(1e10)");
check(uint(-1) == 4294967295, "literal uint(-1) is 0xFFFFFFFF");
check(int(3.5) == 3 && int(-3.5) == -3, "literal fractional truncation");

// --- 5. dynamic source: the box tag decides --------------------------------
check(iAny(NaN) == 0 && uAny(NaN) == 0, "int/uint of a `*` holding NaN is 0");
check(iAny(1e10) == 1410065408, "int of a `*` holding 1e10");
check(iAny(-3.5) == -3 && uAny(-3.5) == 4294967293, "a `*` holding a negative fraction");
check(iAny(null) == 0 && uAny(null) == 0, "int/uint of null is 0");
check(iAny(undefined) == 0, "int of undefined is 0");
check(iAny(true) == 1 && iAny(false) == 0, "a Boolean converts as 1/0");
check(iAny("10x") == 0, "an unparseable String is NaN -> 0, got " + iAny("10x"));
check(iAny(" 12 ") == 12, "a String with surrounding spaces parses");
check(iAny([]) == 0, "an empty Array stringifies to \"\" -> 0");

// --- 6. static String / Number sources are unchanged -------------------------
check(iStr("0x10") == 16, "a String source still honours the hex prefix");
check(iStr("") == 0, "an empty String is 0");
check(int("12.9") == 12, "a numeric String truncates, got " + int("12.9"));

// --- 7. the same conversions reached through a `new` / a Class value --------
// The dynamic core-class path (`new (ClassValue)(x)`) is a separate emitter
// string, and it carried the SAME bare cast: `new ci(1e10)` used to print
// 2147483647 (a saturating fold) where adl gives 1410065408
// (temp/d31probe/adl-newcore.txt).
var ci:Class = int;
var cu:Class = uint;
check(new ci(1e10) == 1410065408, "new (int Class)(1e10), got " + new ci(1e10));
check(new ci(-1e10) == -1410065408, "new (int Class)(-1e10), got " + new ci(-1e10));
check(new cu(-1e10) == 2884901888, "new (uint Class)(-1e10), got " + new cu(-1e10));
check(new ci(NaN) == 0, "new (int Class)(NaN) is 0, got " + new ci(NaN));
// `new Number()` is the constructor default 0, NOT the NaN that the bare
// conversion `Number()` yields (measured on adl 51.4.1).
check(new Number() == 0, "new Number() is 0, got " + new Number());
check(new Number(null) == 0 && new Number("7") == 7, "new Number(x) converts x");
// `new (Object Class)(x)` is the Object(x) CONVERSION: the value itself, except
// null/undefined which produce a fresh object (measured on adl 51.4.1).
var co:Class = Object;
var boxed:* = new co(5);
check(boxed === 5, "new (Object Class)(5) IS the number 5, got " + boxed + " (" + typeof boxed + ")");
var boxedStr:* = new co("x");
check(boxedStr === "x", "...and a String stays a String");
check(new co(null) != null, "new (Object Class)(null) is a fresh object");

check(int(3) == 3 && uint(3) == 3, "new int(3)/new uint(3) convert too");

trace("int-cast: int()/uint() ES3 ToInt32/ToUint32 OK");
