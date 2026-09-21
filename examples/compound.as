// compound.as — 复合成赋值（+= 等）作用于 getter/setter 属性与静态字段的语义回归。
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

trace("compound: all compound-assignment assertions passed");
