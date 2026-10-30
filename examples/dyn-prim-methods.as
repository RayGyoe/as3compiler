// dyn-prim-methods.as — 动态接收者上的内建方法面（Number / Boolean / String / Function）。
//
// 背景：`var n:* = 1.5; n.toFixed(2)` 曾经**一律返回 null**（`Object` 槽里的
// `12.345` 则抛 #1069），而同样的值走静态类型完全正常。根因有两层，都是「同一个
// 值有两套表示」造成的：
//
//   1. 裸 box tag（`*`/数组槽里的数/布尔/字符串/闭包）在 `as_any_call` 里只有
//      tag 3（字符串）有出口，数字/布尔/函数直接进 `as_dyn_call(v.ptr, ...)`；
//      而 tag 1/2 的 ptr 槽是 NULL / 标志位，于是解成 null。
//   2. `Object` 槽里的是堆上的盒对象（`as_number_vt` 等），vtable 走的还是
//      `as_dyn_object_builtin` 的四件套（hasOwnProperty / propertyIsEnumerable /
//      valueOf / toString），Number 自己的 toFixed/toExponential/toPrecision/
//      toString(radix) 一个都没有 ⇒ #1069。
//
// 两者现在共用同一个 `as_prim_call`，所以**同一个值走 `*` 和走 `Object` 不可能
// 再分叉**。全部期望值来自 `adl 51.4.1` 实测（证据台 `temp/dynnum/`：`body.inc`
// 是 90 条断言的公共探针体，`mk.sh` 双端跑同一份源并 diff —— 输出**逐字节相同**）。
//
// 顺带钉住同族的其余口径（都曾与 AIR 不同）：
//   · Number.toString(radix)：radix 10 走最短往返文本（12.34 → "12.34"，不是 "12"），
//     非 10 走**截断**的整数部分（12.34 → "c"），且任意量级都不丢高位
//     （1e21 → "3635c9adc5dea00000"）；radix 出 2..36 是 RangeError #1003。
//   · toFixed/toExponential 的位数 0..20、toPrecision 1..21，越界**或缺失**都是
//     RangeError #1002（旧实现静默夹取，AIR 是直接抛）。
//   · toPrecision 必须补齐到指定位数（1.5 → "1.50"），旧实现走 %g 把尾零吃掉了。
//   · Function 的方法面（toString / length / call / apply / hasOwnProperty）在静态
//     Function 类型上也曾是 codegen 报错。
//   · `var u:*;` 是 **undefined**，不是 null（AIR：`u === undefined` 为 true）。
//   · 字符串方法缺参数时按文档默认值（charAt() → 首字符、substring() → 全串、
//     replace(x) 的第二参是文本 "undefined"），不是 null。
//
// 编译运行：as-aot examples/dyn-prim-methods.as --run

var failures:int = 0;
var checks:int = 0;
function eq(actual:String, expected:String, what:String):void {
  checks++;
  if (actual != expected) {
    failures++;
    trace("FAIL " + what + ": got [" + actual + "] want [" + expected + "]");
  }
}
function ok(cond:Boolean, what:String):void {
  checks++;
  if (!cond) { failures++; trace("FAIL " + what); }
}

function f2(a:int, b:int):int { return a + b; }

// ---- 动态（`*`）数字接收者 ----
var n:* = 1.5;
eq(n.toFixed(2), "1.50", "dyn number toFixed(2)");
eq(n.toFixed(), "2", "dyn number toFixed() defaults to 0 digits");
eq(n.toString(), "1.5", "dyn number toString()");
eq(n.toString(16), "1", "dyn number toString(16) truncates the fraction");
eq(n.toString(10), "1.5", "dyn number toString(10) keeps the fraction");
eq(n.toPrecision(3), "1.50", "dyn number toPrecision(3) pads");
eq(String(n.valueOf()), "1.5", "dyn number valueOf");
ok(!n.hasOwnProperty("x"), "dyn number hasOwnProperty is false");
ok(!n.propertyIsEnumerable("x"), "dyn number propertyIsEnumerable is false");

var i:* = 255;
eq(i.toString(16), "ff", "dyn int toString(16)");
eq(i.toFixed(1), "255.0", "dyn int toFixed(1)");
eq(i.toString(), "255", "dyn int toString()");

// 大数不丢高位：整数部分按 2^32 limb 精确换算，不经 64 位（1e21 > LLONG_MAX）
var big:* = 1e21;
eq(big.toString(), "1e+21", "1e21 toString");
eq(big.toFixed(2), "1000000000000000000000.00", "1e21 toFixed(2)");
eq(big.toString(16), "3635c9adc5dea00000", "1e21 toString(16) is exact");

// ---- 动态布尔 / 函数 ----
var b:* = true;
eq(b.toString(), "true", "dyn boolean toString");
ok(b.valueOf() == true, "dyn boolean valueOf");
ok(!b.hasOwnProperty("x"), "dyn boolean hasOwnProperty is false");

var fn:* = f2;
eq(fn.toString(), "function Function() {}", "dyn function toString");
eq(String(fn.length), "2", "dyn function length is the declared arity");
eq(String(fn.call(null, 3, 4)), "7", "dyn function call");
eq(String(fn.apply(null, [5, 6])), "11", "dyn function apply");
ok(fn.hasOwnProperty("prototype"), "dyn function owns prototype");
ok(!fn.hasOwnProperty("name"), "dyn function does not own name");
ok(!fn.propertyIsEnumerable("prototype"), "dyn function propertyIsEnumerable is false");

// ---- 动态字符串：缺参数走文档默认值 ----
var s:* = "abc";
eq(String(s.length), "3", "dyn string length");
eq(s.charAt(), "a", "dyn string charAt() defaults to index 0");
eq(String(s.indexOf()), "-1", "dyn string indexOf() searches \"undefined\"");
eq(s.substring(), "abc", "dyn string substring() keeps the whole string");
eq(s.substr(), "abc", "dyn string substr() keeps the whole string");
eq(s.slice(), "abc", "dyn string slice() keeps the whole string");
eq(String(s.split().length), "1", "dyn string split() yields one part");
eq(s.replace("a"), "undefinedbc", "dyn string replace(x) inserts \"undefined\"");
eq(String(s.charCodeAt()), "97", "dyn string charCodeAt() defaults to index 0");
ok(s.hasOwnProperty("length"), "dyn string owns length");
ok(!s.hasOwnProperty("0"), "dyn string does not own a character index");

// ---- Object 槽里的盒对象：同一套方法面 ----
var no:Object = 12.345;
eq(no.toFixed(2), "12.35", "Object-slot number toFixed(2)");
eq(no.toFixed(), "12", "Object-slot number toFixed()");
eq(no.toExponential(2), "1.23e+1", "Object-slot number toExponential(2)");
eq(no.toPrecision(3), "12.3", "Object-slot number toPrecision(3)");
eq(no.toString(16), "c", "Object-slot number toString(16) truncates");
eq(no.toString(), "12.345", "Object-slot number toString()");
ok(no.valueOf() is Number, "Object-slot number valueOf stays a Number");
ok(!no.hasOwnProperty("valueOf"), "Object-slot number does not own valueOf");

var so:Object = "abc";
eq(String(so.length), "3", "Object-slot string length");
eq(so.toUpperCase(), "ABC", "Object-slot string toUpperCase");
eq(so.charAt(1), "b", "Object-slot string charAt(1)");
ok(so.hasOwnProperty("length"), "Object-slot string owns length");
ok(!so.propertyIsEnumerable(0), "Object-slot string propertyIsEnumerable is false");

var bo:Object = true;
eq(bo.toString(), "true", "Object-slot boolean toString");
ok(bo.valueOf() is Boolean, "Object-slot boolean valueOf stays a Boolean");

var fo:Object = f2;
eq(String(fo.length), "2", "Object-slot function length");
eq(String(fo.call(null, 3, 4)), "7", "Object-slot function call");
eq(fo.toString(), "function Function() {}", "Object-slot function toString");

// ---- 静态类型接收者：radix / 位数契约 ----
var tn:Number = 12.34;
eq(tn.toString(10), "12.34", "typed Number toString(10) keeps the fraction");
eq(tn.toString(16), "c", "typed Number toString(16) truncates");
eq((1.5).toPrecision(3), "1.50", "typed toPrecision pads to the asked digits");
eq((1.5).toPrecision(5), "1.5000", "typed toPrecision(5) pads");
eq((9.99).toPrecision(2), "10.0", "typed toPrecision rounds up into a new exponent");
eq((12345).toPrecision(5), "12345", "typed toPrecision(5) needs no padding");
eq((12345).toPrecision(3), "1.23e+4", "typed toPrecision switches to exponent at e >= p");
eq((0.000123).toPrecision(2), "0.00012", "typed toPrecision stays fixed when small");
ok(tn.hasOwnProperty("x") == false, "typed Number hasOwnProperty is false");
ok(tn.propertyIsEnumerable("x") == false, "typed Number propertyIsEnumerable is false");

var ti:int = 12;
eq(ti.toString(16), "c", "typed int toString(16)");
var tu:uint = 4000000000;
eq(tu.toString(), "4000000000", "typed uint toString()");
eq(tu.toString(16), "ee6b2800", "typed uint toString(16)");

// ---- 错参：RangeError #1003（radix）/ #1002（位数），缺失参数也算越界 ----
function errId(f:Function, arg:*):String {
  try { f(arg); } catch (e:Error) { return e.errorID + ""; }
  return "none";
}
eq(errId(function(r:*):String { return tn.toString(r); }, 1), "1003", "toString(1) is RangeError #1003");
eq(errId(function(r:*):String { return tn.toString(r); }, 37), "1003", "toString(37) is RangeError #1003");
eq(errId(function(r:*):String { return ti.toString(r); }, 1), "1003", "int toString(1) is RangeError #1003");
eq(errId(function(r:*):String { return tn.toFixed(r); }, 21), "1002", "toFixed(21) is RangeError #1002");
eq(errId(function(r:*):String { return tn.toPrecision(r); }, 0), "1002", "toPrecision(0) is RangeError #1002");
eq(errId(function():String { return tn.toPrecision(); }, null), "1002", "an absent precision is RangeError #1002");
eq(errId(function(r:*):String { return tn.toString(r); }, 0), "1003", "toString(0) is RangeError #1003");
eq((255).toString(36), "73", "radix 36 is accepted");
eq(errId(function(r:*):String { return n.toFixed(r); }, 21), "1002", "dynamic toFixed(21) is RangeError #1002");

// ---- 未初始化与空接收者 ----
var unset:*;
ok(unset === undefined, "an uninitialized * variable is undefined, not null");
var unsetObj:Object;
ok(unsetObj === null, "an uninitialized Object variable is null");
eq(errId(function(x:*):String { return x.toFixed(2); }, null), "1009", "a null receiver is TypeError #1009");
eq(errId(function(x:*):String { return x.toString(); }, undefined), "1010", "an undefined receiver is TypeError #1010");

if (failures > 0) {
  throw new Error(failures + " of " + checks + " checks failed");
}
trace("dyn-prim-methods: " + checks + " checks passed");
