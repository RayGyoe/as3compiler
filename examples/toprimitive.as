// Object ToPrimitive: Number/int/uint of an object, and a loose `==` between a
// class instance and a primitive, run the ES3 ToPrimitive protocol (valueOf
// first, then toString) instead of a raw C pointer/number comparison. Also
// covers Number(undefined) == NaN. Every expectation below is measured on
// adl 51.4.1 (temp/qfix/gcadl/numMain.as -> result5.txt).
class Plain {
  public function toString():String { return "PLAIN-TOSTR"; }
}
class WithNum {
  public function toString():String { return "42"; }
}
class WithValueOf {
  public function valueOf():Object { return 7; }
  public function toString():String { return "99"; }
}

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function run():void {
  // undefined is NaN, null is 0 (ES3 9.3).
  check(isNaN(Number(undefined)), "Number(undefined) is NaN");
  check(Number(null) == 0, "Number(null) is 0");

  // An object goes through ToPrimitive; the default Object.toString gives
  // "[object Object]", which is not a number.
  var o:Object = {};
  check(isNaN(Number(o)), "Number({}) is NaN");
  check(isNaN(Number(new Plain())), "Number of a non-numeric toString is NaN");

  // A class override wins: toString String -> the number, valueOf beats toString.
  check(Number(new WithNum()) == 42, "Number honors a class toString");
  check(Number(new WithValueOf()) == 7, "valueOf wins over toString");
  check(int(new WithNum()) == 42, "int honors a class toString");
  check(int(o) == 0, "int({}) is 0 (ToInt32(NaN))");
  check(uint(o) == 0, "uint({}) is 0");

  // Loose equality against a primitive runs the same ToPrimitive.
  check(new WithNum() == 42, "loose == runs ToPrimitive (number)");
  check(o == "[object Object]", "loose == runs ToPrimitive (string)");
  check(!(o == 0), "({}) == 0 is false");
  check("" + new WithNum() == "42", "string concat honors a class toString");

  // Identity and null checks are unaffected (no ToPrimitive).
  var a:WithNum = new WithNum();
  var b:WithNum = new WithNum();
  var a2:WithNum = a;
  check(a == a2, "same reference is equal");
  check(!(a == b), "distinct references are not equal");
  check(!(a == null), "an instance is never == null");

  trace("toprimitive: all checks passed");
}

run();
