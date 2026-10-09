// logical-value.as — `&&`/`||` 返回操作数的**值**（不是 C bool），且短路透传的
// 操作数**不得被统一到另一侧的静态类型上**。
//
// 修复（阶段一百二十四·一）：`emit.ts` 的 `compatible` 判定原先把「有一侧是 `*`」
// 也算作可统一，于是 `unifyType(any, Array)` 取了**较窄**的 `Array`，把短路透传的
// 左操作数解箱并做运行时类型检查。TweenLite.as:399 的
//   `_overwrite > 1 && this.cachedPT1 && siblings && siblings.length > 1`
// 在 `_overwrite = 0` 时发出 `as_v_req_array(as_v_bool(false), "Array")`，
// 抛 `#1034: cannot convert false to Array` —— examples/air-native 的 TweenDemo
// 因此在第一个 tween 完成时整个中断（修复前日志止于 1 行 TweenDemo + 该异常）。
//
// adl 51.4.1 真值表（temp/logicrepro/AirTruth.as → adl-truth.txt）：
//   r1=false(boolean) r2=true(boolean) r3len=0(object) r4same=true(object) r5same=true(object)
// 即：假操作数**原样透传**，绝不被强制转换。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var siblings:Array = ["a", "b"];

// 1) 原 TweenLite 链：左侧为假 → 结果是 Boolean false 本身，不是 Array。
var ow:uint = 0;
var cachedPT1:Object = null;
var r1:* = (ow > 1 && cachedPT1 && siblings && siblings.length > 1);
check(r1 === false, "a falsy operand passes through as Boolean false (got '" + r1 + "')");
check((typeof r1) == "boolean", "the pass-through keeps the operand's own type (got " + (typeof r1) + ")");

// 2) 全为真 → 结果是最右操作数的值（Boolean true）。
var ow2:uint = 3;
var cachedPT2:Object = { v: 1 };
var r2:* = (ow2 > 1 && cachedPT2 && siblings && siblings.length > 1);
check(r2 === true, "an all-truthy chain yields the last operand (got '" + r2 + "')");
check((typeof r2) == "boolean", "the all-truthy result is also a Boolean (got " + (typeof r2) + ")");

// 3) 箱装数组作为透传值 → 得到那个数组对象本身（同一性 + 类型）。
var empty:Array = [];
var r3:* = (siblings && empty);
check(r3 === empty, "an Array operand passes through by identity");
check((r3 as Array).length == 0, "the passed-through Array is the empty one");

// 4) 对象同一性透传。
var obj:Object = { tag: "T" };
var r4:* = (1 > 0 && obj);
check(r4 === obj, "an object operand passes through by identity");

// 5) `||` 镜像：第一个真操作数即结果。
var z:uint = 0;
var r5:* = (z || siblings);
check(r5 === siblings, "`||` yields the first TRUTHY operand by identity");

// 6) 透传值可以是「另一侧静态类型之外」的类型：`any(0) && Array` → 数字 0。
//    这正是修复前抛 #1034 的形状（动态假值 vs 具体指针类型）。
var arr:Array = [0];
var r6:* = (arr[0] && siblings);
check(r6 === 0, "a falsy dynamic operand passes through as the number 0 (got '" + r6 + "')");
check((typeof r6) == "number", "the number keeps its dynamic type (got " + (typeof r6) + ")");

// 7) 动态真值 → 右侧操作数，且保持同一性。
var arr2:Array = [7];
var r7:* = (arr2[0] && obj);
check(r7 === obj, "a truthy dynamic operand yields the right operand by identity");

// 8) 嵌套：`(any || Array) && Object`。
var arr3:Array = [0];
var r8:* = ((arr3[0] || siblings) && obj);
check(r8 === obj, "nesting still passes the operand through");

// 9) 左操作数只求值一次（短路链不得重复求值）。
var calls:int = 0;
function bump():int { calls++; return 0; }
var r9:* = (bump() && siblings);
check(calls == 1, "the left operand is evaluated exactly once (got " + calls + ")");
check(r9 === 0, "the once-evaluated falsy left is passed through (got '" + r9 + "')");

// 10) `null` 透传。
var o:Object = null;
var r10:* = (o && siblings);
check(r10 === null, "a null operand passes through as null");

trace("logical-value: all assertions passed");