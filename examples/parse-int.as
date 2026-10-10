// parseInt / parseFloat follow the ES3 grammar with AVM2's measured deviations,
// and parseInt returns a Number (so it can be NaN). Every expectation below is
// measured on adl 51.4.1 (temp/qfix/gcadl/pMain.as, p2Main.as, p3Main.as,
// p4Main.as -> 82 paired lines, 0 diff): the radix is honored, a 0x/0X prefix is
// auto-detected at radix 0 and stripped at explicit radix 16, leading zeros are
// decimal, trailing junk is ignored, and a bad radix / digitless string is NaN.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function run():void {
  // radix is honored, including a dynamic radix
  check(parseInt("ff", 16) == 255, "parseInt(ff,16)");
  check(parseInt("11", 2) == 3, "parseInt(11,2)");
  check(parseInt("17", 8) == 15, "parseInt(17,8)");
  check(parseInt("z", 36) == 35, "parseInt(z,36)");
  var d:* = "ff";
  check(parseInt(d, 16) == 255, "dynamic radix");
  check(parseInt("-ff", 16) == -255, "signed radix parse");

  // 0x / 0X: auto-detected at radix 0, stripped at explicit radix 16, but not
  // otherwise; leading zeros stay decimal (no octal).
  check(parseInt("0xff") == 255, "parseInt(0xff)");
  check(parseInt("0X1F") == 31, "parseInt(0X1F)");
  check(parseInt("0xB", 16) == 11, "0x stripped at radix 16");
  check(parseInt("0x10", 10) == 0, "0x NOT stripped at radix 10");
  check(isNaN(parseInt("0X", 16)), "0x with no digits is NaN");
  check(parseInt("08") == 8, "leading zero is decimal (no octal)");
  check(parseInt("010") == 10, "010 is 10, not 8");

  // NaN results: parseInt returns a Number, so these are NaN and not 0.
  check(isNaN(parseInt("abc")), "parseInt(abc) is NaN");
  check(isNaN(parseInt("")), "parseInt('') is NaN");
  check(isNaN(parseInt("z", 1)), "invalid radix 1 is NaN");
  check(isNaN(parseInt("ff", 37)), "radix 37 is NaN");
  check(isNaN(parseInt(null)), "parseInt(null) is NaN");
  check(isNaN(parseInt(undefined)), "parseInt(undefined) is NaN");

  // Trailing junk is ignored; conversion stops at the first invalid digit.
  check(parseInt("  12abc") == 12, "leading space + trailing junk");
  check(parseInt("-12") == -12, "negative");
  check(parseInt("   -12.9  ") == -12, "sign, spaces, fraction stops the scan");
  check(parseInt("5x", 10) == 5, "trailing junk");
  check(parseInt("12", 2) == 1, "digit out of radix stops the scan");
  check(parseInt("1e3") == 1, "'e' is not a digit");

  // parseFloat: longest decimal prefix, trailing junk ignored, Infinity handled.
  check(parseFloat("1.5e3") == 1500, "parseFloat exponent");
  check(parseFloat("3.14") == 3.14, "parseFloat fraction");
  check(parseFloat(".5") == 0.5, "leading dot");
  check(parseFloat("1.") == 1, "trailing dot");
  check(parseFloat("5e3junk") == 5000, "parseFloat ignores trailing junk");
  check(parseFloat("0x10") == 0, "parseFloat is decimal only");
  check(parseFloat("Infinity") == Number.POSITIVE_INFINITY, "Infinity");
  check(parseFloat("-Infinity") == Number.NEGATIVE_INFINITY, "-Infinity");
  check(parseFloat("+.5e1") == 5, "signed fraction + exponent");
  check(isNaN(parseFloat("")), "parseFloat('') is NaN");
  check(isNaN(parseFloat("NaN")), "parseFloat('NaN') is NaN");
  check(isNaN(parseFloat("infinity")), "Infinity is case-sensitive");
  check(isNaN(parseFloat(".")), "a lone dot is NaN");

  // AVM2's exponent-marker quirk: 'e' with no digits rewinds, except a bare '-'.
  check(parseFloat("5e") == 5, "5e rewinds to 5");
  check(parseFloat("5e+") == 5, "5e+ rewinds to 5");
  check(isNaN(parseFloat("5e-")), "5e- is NaN");
  check(parseFloat("5e-3") == 0.005, "5e-3 is a valid negative exponent");

  // typeof confirms the Number return type.
  check(typeof parseInt("5") == "number", "parseInt returns a Number");

  trace("parse-int: all checks passed");
}

run();
