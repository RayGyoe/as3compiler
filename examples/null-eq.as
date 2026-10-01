// null-eq.as — AS3 只有**一个** null：任何求值为 null 的 `*`/Object 槽都必须
// 与 `null` 字面量相等（阶段八十九·四十三）。
//
// 生成 C 里指针型的 box 助手（as_v_obj/as_v_arr/as_v_fn）拿到的可能是一个 NULL
// 指针，此时必须回落到 tag 0 的 null 字面量。否则会出现「`*` 里的 null 不等于
// null」这种静默语义错误，最典型的后果就是 AS3 的经典写法
//
//   while ((v = src.next()) != null) { ... }
//
// **永不终止**（tag 4/NULL 与 tag 0/NULL 在 as_v_eq 下不相等）——这也正是本阶段
// 在循环条件用例里踩到的死循环。
//
// 期望值全部取自 AIR 51.4.1 实测（temp/refcheck/NullEq.as，见 TODO.md 阶段条目）：
//   ternaryNull == null  true      ternaryNull != null   false
//   ternaryNull === null true      ternaryNull !== null  false
//   typeof ternaryNull   object    truthy                F
//   ternaryNull is Object false    null is Object        false
//   f(Function=null) == null true  typeof f              object
//   a(Array=null) == null    true  typeof a              object
//   u(*) = undefined        u == null true, u === null false
//   while ((v = next()) != null) 正常终止

class Src {
  public static var calls:int = 0;
  private var _left:int;
  public function Src(left:int) { _left = left; }
  // 三元表达式的两支分别是 object 与 null —— 联结类型是 `*`
  public static function mk(left:int):* {
    return left > 0 ? new Src(left) : null;
  }
  public static function next():* {
    calls++;
    return calls <= 3 ? new Src(calls) : null;
  }
}

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

function reset():void { Src.calls = 0; }

// ---------- 1) 三元联结出的 `*` null ----------

var v:* = Src.mk(0);
expect(v == null, "an object/null ternary boxes null as the null literal");
expect(!(v != null), "and is not unequal to null");
expect(v === null, "strict equality holds too");
expect(!(v !== null), "and strict inequality does not");
expect(typeof v == "object", "typeof a null value is 'object' (ES3 quirk, AIR agrees)");
expect(!(v ? true : false), "a null value is falsy");
expect(!(v is Object), "null is not an Object (AIR: false)");

var nn:* = Src.mk(7);
expect(!(nn == null), "a non-null ternary result is not null");
expect(nn != null, "and is unequal to null");
expect(nn is Object, "it is an Object");
expect(typeof nn == "object", "and its typeof is 'object'");

// ---------- 2) 引用类型槽里的 null ----------

var f:Function = null;
expect(f == null, "a null Function slot equals null");
expect(typeof f == "object", "typeof a null Function is 'object', not 'function' (AIR agrees)");

var a:Array = null;
expect(a == null, "a null Array slot equals null");
expect(!(a != null), "Array null is not unequal to null");

var o:Object = null;
expect(o == null, "a null Object slot equals null");
var o2:* = new Object();
expect(o2 != null, "a live Object is not null");
expect(o2 is Object, "a live Object is an Object");

// 两个不同的对象永远不相等；同一个对象与自身相等
var p1:* = Src.mk(1);
var p2:* = Src.mk(1);
expect(p1 != p2, "distinct instances are not equal");
expect(p1 == p1, "an instance equals itself");

// ---------- 3) null 与 undefined 的宽松/严格差异（回归保护） ----------

var u:* = undefined;
expect(u == null, "undefined == null is true (loose equality)");
expect(!(u === null), "undefined === null is false (strict)");
expect(u == undefined, "undefined equals itself");
expect(v == null && v === null, "null compares equal to null both ways");
expect(!(null != null), "null != null is false");

// ---------- 4) 经典写法：读流直到 null 必须终止 ----------

reset();
var cur:* = null;
var got:int = 0;
while ((cur = Src.next()) != null) { got++; }
expect(got == 3, "while ((v = next()) != null) consumes until null (got " + got + ")");
expect(Src.calls == 4, "and next() ran exactly once per test (got " + Src.calls + ")");

// 同写法放在 for 的 init/cond/update 三个位置
reset();
var got2:int = 0;
for (var c:* = Src.next(); c != null; c = Src.next()) { got2++; }
expect(got2 == 3, "the for-condition/update variant consumes until null (got " + got2 + ")");
expect(Src.calls == 4, "one call in the init plus three in the update (got " + Src.calls + ")");

// do-while 形态：先跑体，再测条件
reset();
var got3:int = 0;
do { got3 = got3 + 0; } while ((cur = Src.next()) != null && got3 < 9);
expect(got3 == 0, "do-while with a null-terminated condition still runs its body once");

// ---------- 5) 真值判断不受影响 ----------

var t:* = Src.mk(1);
var falsy:* = Src.mk(0);
expect(t ? true : false, "a non-null value is truthy");
expect(!(falsy ? true : false), "a null value is falsy");
expect(falsy == null && t != null, "and the boxed equality agrees with truthiness");

trace("null-eq: all assertions passed");