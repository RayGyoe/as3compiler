// stage89.as — AS3 语言特性缺口第二批（Starling 编译阻塞续，stage 89）。
//
// 覆盖：=== / !== 严格相等 / 泛型默认参数 Vector.<T>=null（>= 误合并）/
// for 多变量声明 var i:int=0, len:int=... / const 多声明 / package 块自由函数 /
// as Vector.<T> 泛型 as 目标 / get·set 与同名方法冲突 + 接口 getter。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. 严格相等 === / !== ---
var n:Number = 0.0;
check(n === 0.0, "=== number equality");
check(!(n === 1.0), "=== number inequality");
check(n !== 1.0, "!== number");
check(!(n !== 0.0), "!== number negated");
var s:String = "abc";
check(s === "abc", "=== string equality");
check(s !== "abd", "!== string");

// --- 2. 泛型默认参数（Vector.<T>=null 的 >= 不能误合并）---
var v:Vector.<String> = takeStrings();
check(v == null, "Vector.<String>=null default null");
var v2:Vector.<String> = takeStrings(new <String>["a"]);
check(v2.length == 1 && v2[0] == "a", "Vector.<String> explicit arg");

// --- 3. for 多变量声明 ---
var total:int = 0;
for (var i:int = 0, len:int = 5; i < len; ++i) { total += i; }
check(total == 10, "for multi-declarator var i, len");

// --- 4. const 多声明 ---
const p:int = 3, q:int = 4;
check(p + q == 7, "const multi-declarator");

// --- 5. package 块自由函数 ---
check(deg2radF(180.0) == Math.PI, "package-level free function");

// --- 6. as Vector.<T> 泛型目标 ---
var mixed:Array = [1, 2, 3];
var cast:Vector.<int> = mixed as Vector.<int>;
check(cast == null, "as Vector.<int> (mismatched -> null)");
var okV:Vector.<int> = new <int>[1];
var cast2:Vector.<int> = okV as Vector.<int>;
check(cast2 != null, "as Vector.<int> (matched)");

// --- 7. get 作为方法名（与访问器关键字冲突）+ 接口 getter ---
check(new Bucket().get(5) == 5, "method named get()");
var helper:IHelper = new Helper();
// An accessor named as a method is READ-THEN-CALL in AIR: the getter's value is
// read and then invoked, so `helper.targetBounds()` throws TypeError #1006
// ("value is not a function.") -- the property read itself is fine. Measured on
// adl 51.4.1 (temp/qfix/gcadl).
check(helper.targetBounds == 100, "interface getter read");
var getterCallErr:int = 0;
try { helper.targetBounds(); } catch (e:*) { getterCallErr = e.errorID; }
check(getterCallErr == 1006, "interface getter-as-method throws #1006");

trace("stage89 OK");

// --- 支撑声明 ---

function takeStrings(out:Vector.<String> = null):Vector.<String> {
  return out;
}

package demo89 {
  public function deg2radF(deg:Number):Number {
    return deg / 180.0 * Math.PI;
  }
}

class Bucket {
  public function get(v:int):int { return v; }
}

interface IHelper {
  function get targetBounds():int;
}

class Helper implements IHelper {
  public function get targetBounds():int { return 100; }
}
