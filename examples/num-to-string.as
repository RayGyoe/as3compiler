// Stage 328: Number -> String must READ BACK, and an integer literal is typed by
// its VALUE.
//
// Both halves were measured on adl 51.4.1 (temp/rtprobe2/: Main.as + Lit.as, the
// reference readings are rt2-out.txt and lit-out.txt).
//
// ① Fixed notation needs more DECIMALS than the 17 significant digits a double
//    can need, because the leading zeros after the point eat into them: 1.2e-4
//    round-trips only at 20 places. Our search was capped at 17, so it printed
//    "0.00012000000000000" -- a string that parses to a DIFFERENT double, silently.
//    AIR prints 0.00012000000000000002 and round-trips; we now match it verbatim.
//
// ② The extremes stay deliberately DIFFERENT from AIR: AIR prints a fixed digit
//    count and breaks its OWN round-trip in three of these five cases, so copying
//    it would mean copying a bug (see docs/zh-cn/as3-semantics.md §2).
//
// ③ A digit-only literal is typed by its value: <= 2147483647 is int,
//    2147483648..4294967295 is uint (and `is int` is false), 4294967296 and above
//    is Number. Declaring every digit-only literal an `int` made 3000000000 a
//    NEGATIVE int and printed 123456789012345680000 as a C integer constant that
//    no C type can hold -- a hard compile error on valid AS3.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function rt(v:Number, label:String):void {
  var s:String = String(v);
  check(Number(s) == v, label + ": String() must read back, got \"" + s + "\"");
}

function run():void {
  // ① the measured round-trip set (every one of these parses back to itself).
  rt(5e-324, "the smallest denormal");
  rt(12345678901234567890, "an integer past 2^53");
  rt(Number.MAX_VALUE, "Number.MAX_VALUE");
  rt(1e+100, "1e+100");
  rt(0.00001 * 12, "1.2e-4 (the fixed-notation case that used to break)");
  rt(1.0000000000000002e-5, "1.0000000000000002e-5");
  rt(Number.MIN_VALUE, "Number.MIN_VALUE");
  rt(1e-7, "1e-7");
  rt(123456789012345680000, "a 21-digit integer");

  // The one string where AIR and we agree word for word (fixed notation, 20
  // decimals): this is the defect the headroom fixes.
  check(String(0.00001 * 12) == "0.00012000000000000002",
    "1.2e-4 prints 20 decimals, got: " + String(0.00001 * 12));
  // The scientific gate is untouched: 1e-7 stays scientific, 1e-6 stays fixed.
  check(String(1e-7) == "1e-7", "1e-7 stays scientific, got: " + String(1e-7));
  check(String(1e-6) == "0.000001", "1e-6 stays fixed, got: " + String(1e-6));

  // ③ integer literal typing (measured in Lit.as).
  check(2147483647 is int, "2147483647 is int");
  check(2147483647 is uint, "2147483647 is uint too (AIR answers true for both)");
  check(2147483648 is uint, "2147483648 is uint");
  check(!(2147483648 is int), "2147483648 is NOT int");
  check(4294967295 is uint, "4294967295 is uint");
  var big:Number = 4294967296;
  check(big == 4294967296, "4294967296 is a Number and keeps its value");
  var huge:Number = 123456789012345680000;
  check(huge > 1.2e20 && huge < 1.3e20, "a 21-digit literal keeps its magnitude, got " + huge);
  // The value must not wrap through a 32-bit int any more.
  var three:Number = 3000000000;
  check(three > 0, "3000000000 stays positive, got " + three);
  check(String(three) == "3000000000", "3000000000 prints as itself, got " + String(three));

  trace("num-to-string: OK");
}

run();