// child-index-errors.as — 阶段二百七十五（G24）：setChildIndex 的参数校验顺序。
//
// 症状（asaotui/compiler-gaps.md G24）：AIR 对 setChildIndex(child, index) 的三类坏参数
// 分别抛 #2007 / #2006 / #2025，而我们只做「把索引夹进合法区间 + 非孩子直接 return」，
// 于是把越界当成功、把非孩子当无事发生——真应用里表现为「本该炸出来的调用静默跑偏」。
//
// AIR 的判据顺序是反直觉的：**先判 null，再判索引范围，最后才判「是不是我的孩子」**。
// 判据来自 adl 51.4.1 实测（temp/g242526/air-sem.txt，探针 AirSem.as）：
//   * setChildIndex(null, 0)              -> TypeError  #2007 Parameter child must be non-null.
//   * setChildIndex(child, numChildren)   -> RangeError #2006 The supplied index is out of bounds.
//   * setChildIndex(child, -1)            -> RangeError #2006
//   * 空容器 + 任意索引                     -> RangeError #2006
//   * setChildIndex(nonchild, 0)          -> ArgumentError #2025 must be a child of the caller.
//   * setChildIndex(nonchild, 99)         -> RangeError #2006  ← 索引判定在前，本条是关键
// 被拒绝的调用不改动顺序，本示例逐条钉住这一点。
import flash.display.*;
import flash.errors.*;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var box:Sprite = new Sprite();
var a:Sprite = new Sprite(); a.name = "a";
var b:Sprite = new Sprite(); b.name = "b";
var c:Sprite = new Sprite(); c.name = "c";
box.addChild(a);
box.addChild(b);
box.addChild(c);

function order():String {
  var s:String = "";
  for (var i:int = 0; i < box.numChildren; i++) s += box.getChildAt(i).name;
  return s;
}

// 期望的错误：名字 + 错误号 + 文案（AIR 的原文），以及「被拒后顺序不变」。
function expectError(label:String, expectedName:String, expectedId:int, expectedMsg:String, fn:Function):void {
  var caught:Boolean = false;
  try {
    fn();
  } catch (e:Error) {
    caught = true;
    check(e.name == expectedName, label + ": name " + e.name + " != " + expectedName);
    check(e.errorID == expectedId, label + ": errorID " + e.errorID + " != " + expectedId);
    check(e.message == expectedMsg, label + ": message '" + e.message + "' != '" + expectedMsg + "'");
  }
  check(caught, label + ": expected a throw, none happened");
  check(order() == "abc", label + ": the rejected call changed the order to " + order());
}

expectError("null child", "TypeError", 2007, "Error #2007: Parameter child must be non-null.",
  function ():void { box.setChildIndex(null, 0); });
expectError("index == numChildren", "RangeError", 2006, "Error #2006: The supplied index is out of bounds.",
  function ():void { box.setChildIndex(a, box.numChildren); });
expectError("index > numChildren", "RangeError", 2006, "Error #2006: The supplied index is out of bounds.",
  function ():void { box.setChildIndex(a, 99); });
expectError("negative index", "RangeError", 2006, "Error #2006: The supplied index is out of bounds.",
  function ():void { box.setChildIndex(a, -1); });
expectError("non-child, in range", "ArgumentError", 2025, "Error #2025: The supplied DisplayObject must be a child of the caller.",
  function ():void { box.setChildIndex(new Sprite(), 0); });
// 关键一条：非孩子 + 越界索引报的是 #2006，说明索引判定排在孩子判定之前。
expectError("non-child, out of range", "RangeError", 2006, "Error #2006: The supplied index is out of bounds.",
  function ():void { box.setChildIndex(new Sprite(), 99); });

var empty:Sprite = new Sprite();
expectError("empty container", "RangeError", 2006, "Error #2006: The supplied index is out of bounds.",
  function ():void { empty.setChildIndex(new Sprite(), 0); });

// 合法移动仍然照做（含「往后挪」与「往前挪」两个方向）。
box.setChildIndex(a, 2);
check(order() == "bca", "move to the end: " + order());
box.setChildIndex(c, 0);
check(order() == "cba", "move to the front: " + order());
box.setChildIndex(b, 1);
check(order() == "cba", "a no-op move keeps the order: " + order());

trace("child-index-errors: OK");