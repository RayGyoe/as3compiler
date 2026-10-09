// stage94c.as — 阶段九十四·三：flash.utils 的 getQualifiedSuperclassName 与
// setInterval / clearInterval。
//
// 参考行为（全部用 mxmlc + adl 51.4.1 实测；探针源码与原始输出在
// temp/qscnprobe/ 与 temp/intervalprobe/，见 TODO.md 阶段九十四·三）：
//
// getQualifiedSuperclassName(value):String —— 取「值的类的超类」的 AS3 限定名，
// 没有超类时返回 null（不是字符串 "null"）：
//   用户类/实例   -> 超类的 fqn（多层链逐层上推，Leaf -> Mid -> Base）
//   到 Object 层   -> "Object"（Base 的直接超类是 Object）
//   Object 本身/普通对象字面量 {} / 接口 / null / undefined -> null
//   装箱原始类型 / Array / Function -> "Object"（它们的类都 extends Object）
// 与 getQualifiedClassName 同口径：限定名用 "包::类"（无包类只有短名）。
//
// setInterval(closure, delay, ...args):uint —— 与 setTimeout 共用**同一张表、
// 同一个 id 计数器**（实测：连续调用拿到的 id 是 1,2,3…）；因此 clearInterval 能
// 取消 setTimeout 的 id、clearTimeout 也能取消 setInterval 的 id，未知/0 的 id 是
// 静默空操作。重复定时器**在回调结束后**再排下一次（实测：50ms 回调配 20ms 间隔，
// tick 间隔 ≈69ms 而非 ≈20ms），且每个 tick 至多触发一次；在自身回调里调用
// clearInterval 会停掉后续全部 tick。负延迟与 NaN 延迟抛 RangeError #2066（该次
// 调用不消耗 id）；null 闭包不报错、仍消耗一个 id、只是永远不回调。
// Headless：本示例用 tickTimers() 手动泵（等价于一帧），延迟 0 的间隔因此每泵一次。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function errId(fn:Function):int { try { fn(); } catch (e:Error) { return e.errorID; } return 0; }

class Base { }
class Mid extends Base { }
class Leaf extends Mid { }

package scenes {
  public class SceneBase { }
  public class SceneLeaf extends SceneBase { }
}

// ===== 1. 超类名：多层继承链（adl：Leaf->Mid->Base->Object->null）=====
check(getQualifiedSuperclassName(Leaf) == "Mid", "class Leaf -> Mid");
check(getQualifiedSuperclassName(Mid) == "Base", "class Mid -> Base");
check(getQualifiedSuperclassName(Base) == "Object", "class Base -> Object");
check(getQualifiedSuperclassName(new Leaf()) == "Mid", "instance Leaf -> Mid");
check(getQualifiedSuperclassName(new Mid()) == "Base", "instance Mid -> Base");

// ===== 2. 限定名口径与 getQualifiedClassName 一致（包::类）=====
check(getQualifiedClassName(Leaf) == "Leaf", "no-package class is its short name");
check(getQualifiedSuperclassName(Leaf) == "Mid", "the super name uses the same :: form");
check(getQualifiedClassName(SceneLeaf) == "scenes::SceneLeaf", "packaged class -> scenes::SceneLeaf");
check(getQualifiedSuperclassName(SceneLeaf) == "scenes::SceneBase", "packaged super -> scenes::SceneBase");
check(getQualifiedSuperclassName(new SceneLeaf()) == "scenes::SceneBase", "packaged instance -> its super");

// ===== 3. 没有超类的三类：普通对象 / null / undefined -> null =====
check(getQualifiedSuperclassName({}) == null, "plain object literal -> null");
check(getQualifiedSuperclassName(null) == null, "null -> null");
check(getQualifiedSuperclassName(undefined) == null, "undefined -> null");
check(getQualifiedSuperclassName(Base) != null, "a class with a real super is not null");

// ===== 4. 装箱原始类型 / Array / Function -> Object =====
check(getQualifiedSuperclassName(1) == "Object", "int -> Object");
check(getQualifiedSuperclassName(1.5) == "Object", "Number -> Object");
check(getQualifiedSuperclassName("x") == "Object", "String -> Object");
check(getQualifiedSuperclassName(true) == "Object", "Boolean -> Object");
check(getQualifiedSuperclassName([1, 2]) == "Object", "Array -> Object");
check(getQualifiedSuperclassName(function():void { }) == "Object", "function -> Object");

// ===== 5. id 空间：setTimeout 与 setInterval 共用（adl：1,2,3…）=====
var toId:uint = setTimeout(function():void { }, 100000);
var ivId:uint = setInterval(function():void { }, 100000);
check(ivId == toId + 1, "setTimeout and setInterval share one id counter (" + toId + "," + ivId + ")");
clearTimeout(toId);
clearInterval(ivId);

// ===== 6. 互相取消：clearInterval 取消 setTimeout，clearTimeout 取消 setInterval =====
var fired1:int = 0;
var toId2:uint = setTimeout(function():void { fired1++; }, 0);
clearInterval(toId2);
tickTimers();
check(fired1 == 0, "clearInterval cancels a setTimeout id");

var fired2:int = 0;
var ivId2:uint = setInterval(function():void { fired2++; }, 0);
clearTimeout(ivId2);
tickTimers();
tickTimers();
check(fired2 == 0, "clearTimeout cancels a setInterval id");

// ===== 7. 重复语义：固定 tick 序列下每泵至多一次，自停后不再回调 =====
var seq:String = "";
var n:int = 0;
var selfId:uint = setInterval(function():void { n++; seq += n; if (n >= 3) clearInterval(selfId); }, 0);
tickTimers();
check(seq == "1", "tick 1 fires exactly once");
tickTimers();
check(seq == "12", "tick 2 fires exactly once more");
tickTimers();
check(seq == "123", "tick 3 fires, then clears itself from inside the callback");
tickTimers();
tickTimers();
check(seq == "123" && n == 3, "after clearInterval the interval stays stopped (got " + seq + ")");

// ===== 8. 参数透传 + 与 setTimeout 混用 =====
var got:String = "";
var argId:uint = setInterval(function(a:String, b:int):void { got = a + "/" + b; clearInterval(argId); }, 0, "argA", 7);
tickTimers();
check(got == "argA/7", "interval args are passed through");
var mix:String = "";
setTimeout(function():void { mix += "T"; }, 0);
setInterval(function():void { mix += "I"; }, 0);
tickTimers();
check(mix == "TI", "a timeout and an interval due in the same pump both fire, in id order");

// ===== 9. 失败路径：负/NaN 延迟 -> RangeError #2066（且不消耗 id）=====
check(errId(function():* { setInterval(function():void { }, -1); return 0; }) == 2066, "setInterval(-1) -> #2066");
check(errId(function():* { setInterval(function():void { }, NaN); return 0; }) == 2066, "setInterval(NaN) -> #2066");
check(errId(function():* { setTimeout(function():void { }, -5); return 0; }) == 2066, "setTimeout(-5) -> #2066");
var beforeId:uint = setTimeout(function():void { }, 100000);
check(beforeId > 0, "a valid id is still handed out after the throwing calls");
clearTimeout(beforeId);

// ===== 10. null 闭包：不报错、仍消耗 id、永不回调 =====
var nullId:uint = setTimeout(null, 0);
check(nullId > 0, "a null closure still consumes an id (adl: setTimeout(null,100) -> 1)");
tickTimers();
tickTimers();
check(nullId > 0, "and pumping the queue with a null closure does not crash");

// ===== 11. clearInterval/clearTimeout 对未知 id 是静默空操作 =====
clearInterval(999999);
clearTimeout(999999);
check(true, "unknown ids are silent no-ops");

trace("stage94c: all checks passed");