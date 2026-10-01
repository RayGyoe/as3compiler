// compound.as — 复合成赋值（+= 等）作用于 getter/setter 属性与静态字段的语义回归，
// 以及 `%=` 全类型形态（int/uint/Number/getter-setter/静态字段/数组元素/动态 record）。
// 修复：`obj.prop += v` 必须读旧值再写回（set(obj, get(obj) OP v)），而非丢失旧值；
// `Class.field += v` 同理（Class.field = Class.field OP v）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(a:Number, b:Number, msg:String):void { if (Math.abs(a - b) > 1e-9) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")"); }

class Counter {
  var _n:Number;
  static var total:Number = 0;

  function get value():Number { return _n; }
  function set value(v:Number):void { _n = v; }
}

var c:Counter = new Counter();
c.value = 10;
c.value += 5;
near(c.value, 15, "getter/setter += folds old value");
c.value *= 2;
near(c.value, 30, "getter/setter *= folds old value");
c.value -= 3;
near(c.value, 27, "getter/setter -= folds old value");

Counter.total = 100;
Counter.total += 25;
near(Counter.total, 125, "static field += folds old value");
Counter.total /= 5;
near(Counter.total, 25, "static field /= folds old value");

// `%=` (v0.3.129): AS3 has the whole compound-assignment family, and `a %= b`
// is defined as `a = a % b`. `%` must keep the same zero-divisor behaviour as
// the plain operator (as_int_rem/as_uint_rem guards) — C's `%` would be UB.
var mi:int = 17;
mi %= 5;
near(mi, 2, "int %= folds");
mi %= 0;
near(mi, 0, "int %= 0 matches % 0 (guarded, no UB)");
var mz:int = 5 % 0;
near(mz, 0, "plain % 0 guarded value (same as %= 0)");
var mneg:int = -17;
mneg %= 5;
near(mneg, -2, "int %= truncates toward zero like %");
var mu:uint = 7;
mu %= 3;
near(mu, 1, "uint %= folds");
var mn:Number = 17.5;
mn %= 4;
near(mn, 1.5, "Number %= keeps the Number type (fmod semantics)");
c.value = 17;
c.value %= 5;
near(c.value, 2, "getter/setter %= folds old value");
Counter.total = 17;
Counter.total %= 5;
near(Counter.total, 2, "static field %= folds old value");
var mArr:Array = [17];
mArr[0] %= 5;
near(mArr[0], 2, "Array element %= folds");
var mDyn:Object = { n: 17 };
mDyn.n %= 5;
near(mDyn.n, 2, "dynamic record %= folds");

trace("compound: all compound-assignment assertions passed");
