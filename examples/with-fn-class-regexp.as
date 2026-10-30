// with-fn-class-regexp.as — `with` 的 Function / 类 / RegExp 三种接收者的成员面，
// 以及 with 体内对未声明名的赋值（隐式全局）。
//
// 阶段三百四十五 之前：`with (f2) { length }` 这类形态对 Function 接收者只支持
// 少数成员（toString/valueOf 等落到响亮报错），类接收者的静态面在 with 体内不可见，
// RegExp 的六个只读成员（source/global/ignoreCase/multiline/dotall/extended）
// 是字段形态、写入不报错；`with (KC) { noSuchStatic = 5 }` 编译失败。本示例把
// `adl 51.4.1` 实测的完整口径钉下来（证据台 `temp/with3/`：Main1..14 探针，
// ourall.as 双端输出逐字节相同）：
//
//   · Function 接收者：length=实参个数、toString()="function Function() {}"、
//     call/apply 绑定到接收者（缺参按接收者 arity 报 #1063）、valueOf() 是函数
//     本身、hasOwnProperty('length'/'prototype')=true、PIE=false、prototype 是
//     每函数独立的空 Object、未知名 #1065、length 写 #1074、方法写 #1037、
//     "call" in f2 = true；
//   · 类接收者：静态字段可读写、静态方法可调、const 写 #1074、方法写 #1037、
//     toString()="[class KC]"、valueOf() 是类本身、hasOwnProperty('toString')
//     =true、PIE=false、实例字段不可见（#1065）、delete 静态成员=false；
//   · RegExp 接收者：六个只读 getter（写 #1074）、lastIndex 可写、exec/test 的
//     lastIndex 状态连续（R8 后 R9 从 lastIndex=4 起）、toString()="/ab/gi"、
//     `flags` 不是成员（#1065）、方法写 #1037；
//   · 类/函数对象的 prototype 是独立的空 Object，同一函数的两次读取同一身份；
//   · `with (KC) { var t:Function = toString; t() }` → #1006（值形态不可调，
//     只有 with 体内调用形态是 "[class KC]"）；
//   · with 体内对未声明名的赋值 = 隐式全局（跨闭包可见，X10/with3n）；
//   · null Class 接收者 → #1009。
//
// 未在本示例断言的残余（mxmlc 自身不稳定或与全局作用域产物耦合，见
// temp/with3/README.md）：F14（`with (f2) { getQualifiedClassName(prototype) }`
// 在 Main2 抛 #1065、同形 P3 答 "Object"）、C14/P6/P15/P16/P20/P22（裸 `length`
// 恒 1 的 mxmlc 全局产物）、P29（实例字段经类接收者读到 9 的同文件产物）、
// W13（闭包内 `arguments`，未实现特性单独挂表）。
import flash.utils.getQualifiedClassName;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

function expectThrow(code:int, f:Function, msg:String):void {
	var caught:Boolean = false;
	try { f(); } catch (e:Error) { caught = (e.errorID == code); }
	if (!caught) throw new Error("FAIL: " + msg + " (expected #" + code + ")");
}

class KC {
  public static var sv:int = 5;
  public static function sm(x:int):int { return x + 1; }
  public static const sc:int = 7;
  public var iv:int = 9;
  public static var _ss:int = 0;
  public static function get sg():int { return 42; }
  public static function set ss(v:int):void { _ss = v; }
}
class KC2 {
  public static var _ss:int = 0;
}
function f2(a:Number, b:Number):Number { return a + b; }
function rec(f:Function):* {
  try { return f(); } catch (e:Error) { return "THROW:" + e.errorID; }
}
var lexFoo:String = "LEX";
var re:RegExp = /ab/gi;

// ---- Function 接收者 --------------------------------------------------
check(rec(function():* { with (f2) { return length; } }) == 2, "F1 fn length");
check(rec(function():* { with (f2) { return toString(); } }) == "function Function() {}", "F2 fn toString()");
check(rec(function():* { with (f2) { return hasOwnProperty("length"); } }) == true, "F3 fn hasOwnProperty('length')");
check(rec(function():* { with (f2) { return hasOwnProperty("prototype"); } }) == true, "F4 fn hasOwnProperty('prototype')");
check(rec(function():* { with (f2) { return propertyIsEnumerable("length"); } }) == false, "F5 fn PIE false");
check(rec(function():* { with (f2) { return call(null, 3, 4); } }) == 7, "F6 fn call");
check(rec(function():* { with (f2) { return apply(null, [5, 6]); } }) == 11, "F7 fn apply");
check(rec(function():* { with (f2) { return valueOf() == f2; } }) == true, "F8 fn valueOf identity");
check(rec(function():* { with (f2) { return prototype != null; } }) == true, "F9 fn prototype non-null");
check(rec(function():* { with (f2) { return lexFoo; } }) == "LEX", "F10 lexical fallback");
check(rec(function():* { with (f2) { return noSuchFnName; } }) == "THROW:1065", "F11 unknown -> #1065");
check(rec(function():* { with (f2) { length = 9; return f2.length; } }) == "THROW:1074", "F12 length write -> #1074");
check(rec(function():* { with (f2) { return call(); } }) == "THROW:1063", "F13 call() -> #1063");
check(rec(function():* { with (f2) { return ("call" in f2); } }) == true, "F20 'call' in f2");
check(rec(function():* { with (f2) { var c:Function = call; return c.call(null, 1, 2); } }) == "THROW:1063", "F18 call value then call -> #1063");
check(rec(function():* { with (f2) { call = null; return "ok"; } }) == "THROW:1037", "W1 fn call write -> #1037");
check(rec(function():* { with (f2) { return delete length; } }) == false, "F19 delete length = false");
check(rec(function():* { var p1:Object = f2.prototype; var p2:Object = f2.prototype; return p1 == p2; }) == true, "P2 fn proto identity");

// ---- 类接收者 ---------------------------------------------------------
check(rec(function():* { with (KC) { return sv; } }) == 5, "C1 static field read");
check(rec(function():* { with (KC) { return sc; } }) == 7, "C2 static const read");
check(rec(function():* { with (KC) { return sm(10); } }) == 11, "C3 static method call");
check(rec(function():* { with (KC) { sv = 12; return KC.sv; } }) == 12, "C4 static field write");
check(rec(function():* { with (KC) { return iv; } }) == "THROW:1065", "C5 instance field invisible");
check(rec(function():* { with (KC) { return noSuchClsName; } }) == "THROW:1065", "C6 unknown -> #1065");
check(rec(function():* { with (KC) { return toString(); } }) == "[class KC]", "C7 class toString()");
check(rec(function():* { with (KC) { return sm is Function; } }) == true, "C8 static method is Function");
check(rec(function():* { with (KC) { sc = 9; return KC.sc; } }) == "THROW:1074", "C9 const write -> #1074");
check(rec(function():* { with (KC) { sm = f2; return "ok"; } }) == "THROW:1037", "C10 method write -> #1037");
check(rec(function():* { with (KC) { return sg; } }) == 42, "C11 static getter");
check(rec(function():* { with (KC) { ss = 4; return KC2._ss; } }) == 0, "C12 static setter (writes KC._ss, KC2 unchanged)");
check(rec(function():* { with (KC) { ss = 5; return KC._ss; } }) == 5, "W7 static setter effect");
check(rec(function():* { with (KC) { return prototype != null; } }) == true, "C13 class prototype non-null");
check(rec(function():* { with (KC) { return hasOwnProperty("toString"); } }) == true, "X4 hasOwnProperty('toString')");
check(rec(function():* { with (KC) { return hasOwnProperty("sv"); } }) == true, "P25 hasOwnProperty('sv') on statics");
check(rec(function():* { with (KC) { return propertyIsEnumerable("sv"); } }) == false, "X5 PIE false");
check(rec(function():* { with (KC) { return valueOf() === KC; } }) == true, "P24 class valueOf identity");
check(rec(function():* { with (KC) { return delete sm; } }) == false, "W8 delete static method = false");
check(rec(function():* { with (KC) { return delete sv; } }) == false, "W9 delete static field = false");
check(rec(function():* { var c:Class = null; with (c) { return "ok"; } }) == "THROW:1009", "X8 null class -> #1009");
check(rec(function():* { with (KC) { var t:Function = toString; return t(); } }) == "THROW:1006", "X13 toString value is not callable");
check(rec(function():* { return getQualifiedClassName(KC.prototype); }) == "Object", "P7 KC.prototype qcn");

// ---- RegExp 接收者 ----------------------------------------------------
check(rec(function():* { with (re) { return source; } }) == "ab", "R1 source");
check(rec(function():* { with (re) { return global; } }) == true, "R2 global");
check(rec(function():* { with (re) { return ignoreCase; } }) == true, "R3 ignoreCase");
check(rec(function():* { with (re) { return multiline; } }) == false, "R4 multiline");
check(rec(function():* { with (re) { return dotall; } }) == false, "R6 dotall");
check(rec(function():* { with (re) { return extended; } }) == false, "R7 extended");
check(rec(function():* { with (re) { return lastIndex; } }) == 0, "R5 lastIndex");
check(rec(function():* { with (re) { var a:Array = exec("xxabxx"); return a != null && a[0] == "ab"; } }) == true, "R8 exec");
check(rec(function():* { with (re) { return test("xxabxx"); } }) == false, "R9 test continues from lastIndex");
check(rec(function():* { with (re) { lastIndex = 2; return re.lastIndex; } }) == 2, "R10 lastIndex write");
check(rec(function():* { with (re) { return noSuchReName; } }) == "THROW:1065", "R11 unknown -> #1065");
check(rec(function():* { with (re) { return toString(); } }) == "/ab/gi", "R12 regexp toString()");
check(rec(function():* { with (re) { return flags; } }) == "THROW:1065", "R13 flags is not a member");
check(rec(function():* { with (re) { return delete lastIndex; } }) == false, "R16 delete lastIndex = false");
check(rec(function():* { with (re) { source = "zz"; return re.source; } }) == "THROW:1074", "R17 source write -> #1074");
check(rec(function():* { with (re) { exec = null; return "ok"; } }) == "THROW:1037", "W10 exec write -> #1037");
check(rec(function():* { with (re) { return valueOf() === re; } }) == true, "P27 regexp valueOf identity");
check(rec(function():* { var r5:RegExp = /cd/; return r5.toString(); }) == "/cd/", "X12 no-flag toString keeps the slash");
check(rec(function():* { var r5:RegExp = new RegExp("cd", "m"); return r5.toString(); }) == "/cd/m", "D2 flag toString");

// ---- with 体内隐式全局 --------------------------------------------------
check(rec(function():* { with (KC) { noSuchStatic = 5; return "ok"; } }) == "ok", "X10 unknown write no-throw");
check(rec(function():* { with (KC) { with (f2) { globalViaWith = 7; return globalViaWith; } } }) == 7, "with3n A same-closure read-back");
check(rec(function():* { with (KC) { return noSuchStatic; } }) == 5, "with3n C cross-closure visibility");

trace("with-fn-class-regexp: all checks passed");
