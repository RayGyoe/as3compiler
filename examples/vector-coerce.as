// vector-coerce.as — 阶段一百零九：`Vector.<T>(arrayLike)` 是**转换**，
// `new Vector.<T>(length)` 是**构造**——两者语义不同，不是同一个操作的两种写法。
//
// 全部期望值取自 adl 51.4.1 实测（temp/vecconv/，见 adl.txt）：
//   Vector.<int>([1,2,3])      -> len 3，元素逐个拷贝
//   Vector.<int>(someVector)   -> 逐元素转换（Number 1.5 -> int 1）
//   Vector.<int>({a:1})        -> len 0（按 array-like 读 `length`）
//   Vector.<int>(3)            -> TypeError #1034（标量不能转成 Vector）
//   Vector.<int>()             -> ArgumentError #1112（须恰好 1 个实参）
//   new Vector.<int>(3)        -> len 3，填 0
//   new Vector.<int>([1,2,3])  -> ArgumentError #2005（构造器参数须 uint）
//
// 本示例同时覆盖当初挡住 away3d 编译的 `Vector.<Class>` 元素类型。

class ParserA {}
class ParserB {}

function errID(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return 0;
}
function errMsg(fn:Function):String {
  try { fn(); } catch (e:Error) { return e.message; }
  return "";
}

// --- Vector.<Class>：away3d Parsers.ALL_BUNDLED / enableParsers 的写法 ---
var parsers:Vector.<Class> = Vector.<Class>([ParserA, ParserB]);
trace(parsers.length == 2);                    // true
trace(parsers[0] == ParserA);                  // true (元素就是类对象本身)
trace(parsers[1] == ParserB);                  // true

// for each 遍历（SingleFileLoader.enableParsers 的写法）
var n:int = 0;
for each (var pc:Class in parsers) n++;
trace(n == 2);                                 // true
trace(parsers.indexOf(ParserB) == 1);          // true

// --- Vector.<Dictionary> 元素类型 ---
var dicts:Vector.<Dictionary> = Vector.<Dictionary>([new Dictionary(), new Dictionary()]);
trace(dicts.length == 2);                       // true
dicts[0]["k"] = 7;
trace(dicts[0]["k"] == 7);                      // true

// --- 转换：Array -> Vector（元素逐个拷贝）---
var ints:Vector.<int> = Vector.<int>([1, 2, 3]);
trace(ints.length == 3);                        // true
trace(ints.join(",") == "1,2,3");               // true

var nums:Vector.<Number> = Vector.<Number>([1, 2]);
trace(nums.length == 2);                        // true
trace(nums.join(",") == "1,2");                 // true

var strs:Vector.<String> = Vector.<String>(["x", "y"]);
trace(strs.length == 2);                        // true
trace(strs.join("") == "xy");                   // true

var empty:Vector.<int> = Vector.<int>([]);
trace(empty.length == 0);                       // true

// --- 转换：Vector -> Vector（逐元素转换，1.5 -> 1）---
var fromNums:Vector.<int> = Vector.<int>(nums);
trace(fromNums.length == 2);                    // true
trace(fromNums[1] == 2);                        // true
var widened:Vector.<Number> = Vector.<Number>(ints);
trace(widened.length == 3);                     // true
trace(widened[2] == 3);                         // true
var halved:Vector.<int> = Vector.<int>(Vector.<Number>([1.5, 2.5]));
trace(halved.join(",") == "1,2");               // true

// --- 转换：按 array-like 的 `length` 读普通对象 ---
var like:Object = { length: 2, 0: 7, 1: 8 };
var fromObj:Vector.<int> = Vector.<int>(like);
trace(fromObj.length == 2);                     // true
trace(fromObj.join(",") == "7,8");              // true
var noLen:Vector.<int> = Vector.<int>({ a: 1 });
trace(noLen.length == 0);                       // true

// --- 转换：动态 `*` 接收者 ---
var anyArr:* = [4, 5];
var fromAny:Vector.<int> = Vector.<int>(anyArr);
trace(fromAny.join(",") == "4,5");              // true
var anyVec:* = Vector.<Number>([1.5, 2.5]);
trace(Vector.<int>(anyVec).join(",") == "1,2"); // true

// --- 转换的失败路径（AIR 的报错号与文案）---
trace(errID(function():void { Vector.<int>(3); }) == 1034);            // true
trace(errID(function():void { Vector.<int>(null); }) == 1034);         // true
trace(errID(function():void { Vector.<String>("ab"); }) == 1034);      // true
trace(errID(function():void { Vector.<int>(); }) == 1112);             // true
trace(errMsg(function():void { Vector.<int>(3); }) ==
      'Error #1034: Type Coercion failed: cannot convert 3 to __AS3__.vec.Vector.<int>.'); // true
trace(errMsg(function():void { Vector.<String>("ab"); }) ==
      'Error #1034: Type Coercion failed: cannot convert "ab" to __AS3__.vec.Vector.<String>.'); // true
trace(errMsg(function():void { Vector.<int>(); }) ==
      'Error #1112: Argument count mismatch on class coercion.  Expected 1, got 0.'); // true

// --- 构造：new Vector.<T>(length) ---
var sized:Vector.<int> = new Vector.<int>(3);
trace(sized.length == 3);                       // true
trace(sized.join(",") == "0,0,0");              // true
var sizedNum:Vector.<Number> = new Vector.<Number>(2);
trace(sizedNum.length == 2);                    // true
trace(sizedNum[0] == 0);                        // true (填 0，不是 NaN)
var sizedF:Vector.<int> = new Vector.<int>(2, true);
trace(sizedF.length == 2);                      // true

// --- 构造的失败路径：参数须为 uint ---
trace(errID(function():void { new Vector.<int>([1, 2]); }) == 2005);   // true
trace(errID(function():void { new Vector.<int>("3"); }) == 2005);      // true
trace(errID(function():void { new Vector.<int>(null); }) == 2005);     // true
trace(errMsg(function():void { new Vector.<int>([1, 2]); }) ==
      'Error #2005: Parameter 0 is of the incorrect type. Should be type uint.'); // true