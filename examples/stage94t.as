// stage94t.as — 阶段九十四·二十四（E9）：64 位整数 int64 / uint64（opt-in 增强）。
//
// 为什么算**增强**而不是「遗留」：AIR 压根没有这两个类型——`adl 51.4.1` 里
// `var x:int64` 连编译都过不去（`mxmlc` 报未知类型），所以**任何**用它们的源码都不可能是
// 一份 AIR 合法程序 ⇒ 接受这些类型不可能改写任何 AIR 已定义行为（AGENTS.md §1.5 的判据 a）。
// 增强的 opt-in 就是「你得把它写出来」：不写 `int64`/`uint64` 的源码，产物与从前逐字节同构。
//
// 语义契约（完整表见 docs/zh-cn/enhancements.md §4.7）：
//   * 类型：`int64`（有符号 64）/ `uint64`（无符号 64），C 侧是 `int64_t`/`uint64_t`；
//   * 字面量：`123L` → int64，`123UL`/`123LU` → uint64（**数字按源码原文发射**为
//     `INT64_C(123)`/`UINT64_C(123)`，不经 double，所以 2^53 以上也精确）；
//   * 转换函数：`int64(x)` / `uint64(x)`（与 `int()`/`uint()` 同族，**强制**转换）；
//     `x as int64` 是**类型检查**（tag 不符给 0，与 `x as int` 同规则）；
//   * 同型算术/位运算保持 64 位：`+ - * % & | ^ << >> >>> ~`，`++`/`--`；
//   * `/` 恒为 Number（与 AS3 的 `int/int` 同规则——除法结果不是整数）；
//   * 与 `int`/`uint`/`Boolean` 混合：对侧**精确**加宽进 64 位；
//     与 `Number`（或动态 `*`）混合：整式退化为 Number（>2^53 会舍入——这正是要 64 位的原因）；
//   * `int64` 与 `uint64` 之间：`+ - * %` 退化为 Number（无共同 C 类型），
//     位运算取无符号族，而 `< <= > >= == !=` 是**数学比较**（`as_cmp_i64u64`：
//     `int64(-1) < uint64(0)` 为 true，不是 C 的无符号重解释）；
//   * `%` 除数为 0 时给 0（C 的 `%` 是 UB；与 AS3 的 `int % 0` 同口径）；
//   * 移位量掩到 0..63（C 对 ≥ 位宽是 UB；AS3 的 32 位移位掩到 31，故此为忠实类比）；
//   * 装箱：独立 tag 8/9，值**原样**放 `as_value`（`num` 之外），故 `*`/Array/Dictionary
//     里的 64 位值不经过 double；`typeof` 报 `"number"`（AIR 无对应物，不可观测）；
//   * 已知边界（绝不静默，会**报编译错误**）：`Vector.<int64>` 未做单态化、
//     把 64 位值存进 `Object` 槽（那里按 double 装箱会舍入）——两者都有明确报错与替代方案。
//
// 与 C 的差异（AGENTS.md §2.4 红线）：C 的 `int64_t` 只是载体，**语义来自本契约**。
// 三个高危点已显式处理：`%` 的零除数 UB（`as_i64_rem`/`as_u64_rem`）、`<<`/`>>` 的移位量 UB
// （掩 63）、`double` ↔ `int64` 的转换（NaN/Inf 时 C 强转是 UB，走 `as_num_to_i64` 加守卫）；
// 另有一条 GC 红线：**tag 8/9 的 `ptr` 槽是整数字节，绝不是指针**，故 `gc_mark_value`/
// `gc_write_barrier_value` 用**显式 tag 表**而非范围判断（否则会把整数位当成堆引用去标记）。
import flash.utils.Dictionary;

class Holder {
	public var big:int64 = 5L;
	public var ub:uint64 = 7UL;
	public function Holder(n:int64) { this.big = n; }
	public function twice():int64 { return this.big * 2L; }
}

class S {
	public static var counter:int64 = 0L;
	public static function bump():void { S.counter += 1L; }
}

var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}
function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) {
		failCount++;
		trace("FAIL: " + msg + " — expected " + expected + ", got " + actual);
	}
}

// ---- A. 字面量与精确性（2^53 以上不经 double）----
var iMax:int64 = 9223372036854775807L;
eq(iMax, int64("9223372036854775807"), "int64 max literal round-trips exactly");
eq("" + iMax, "9223372036854775807", "the decimal text is exact");
var uMax:uint64 = 18446744073709551615UL;
eq("" + uMax, "18446744073709551615", "uint64 max is exact");
eq(int64("9007199254740993"), 9007199254740992L + 1L, "past 2^53 the L literal still adds exactly");
check(9007199254740992L + 1L != 9007199254740992L, "and the +1 is not lost");

// ---- B. 同型算术 / 位运算保持 64 位（含回绕与掩码移位）----
eq(iMax + 1L, int64("-9223372036854775808"), "int64 wraps two's-complement on overflow");
eq(iMax * 2L, int64("-2"), "multiplication wraps in 64 bits");
eq(uMax + 1UL, uint64(0), "uint64 wraps to 0");
eq(uint64(0) - 1UL, uMax, "uint64 underflow gives the max");
eq((int64(5) / int64(2)) + 0, 2.5, "/ is Number, not integer division");
eq(int64(-7) % int64(3), int64(-1), "% truncates toward zero");
eq(int64(5) % int64(0), int64(0), "% by zero is 0, not a trap");
eq(int64(1) << 40L, 1099511627776L, "shift up to 63 bits stays in the value");
eq(int64(1) << 64L, int64(1), "the shift count masks to 0..63");
eq(int64(6) & int64(3), int64(2), "& keeps all 64 bits");
eq(int64(-8) >> 1L, int64(-4), ">> is arithmetic for int64");
eq(int64(-1) >>> 63L, uint64(1), ">>> is a logical shift and yields uint64");
eq(~int64(0), int64(-1), "~ complements all 64 bits");
eq(uint64(1) << 63L, 9223372036854775808UL, "bit 63 is reachable");

// ---- C. 混合类型：加宽精确、与 Number 混合退化为 Number ----
var n:int = 5;
eq(int64(n) * 2L, int64(10), "int widens exactly into int64");
var half:Number = 0.5;
eq(int64(3) + half + 0, 3.5, "with Number the expression is Number");
eq(int64(-1) < uint64(0), true, "int64/uint64 compare mathematically, not by C's unsigned conversion");
eq(int64(5) == uint64(5), true, "loose equality spans the two families");
check(int64(-1) != uint64(18446744073709551615UL), "int64(-1) is not uint64 max");

// ---- D. 转换族与 `is`/`as` ----
eq(int64(3.99), int64(3), "int64() truncates toward zero");
eq(uint64("18446744073709551615"), uMax, "uint64(String) parses the exact decimal");
eq(int64("garbage"), int64(0), "unparseable text gives 0, like int()");
eq(Number(int64(9)) + 0.5, 9.5, "Number() widens");
eq(String(int64(-42)), "-42", "String() prints the exact decimal");
eq(int(int64(1) << 40L), 0, "int() keeps the low 32 bits (ToInt32)");
eq(Boolean(int64(0)), false, "Boolean() tests non-zero");
var d:* = int64(7);
check(d is int64, "a boxed 64-bit value answers `is int64`");
check(!(d is uint64), "and not `is uint64`");
check(d is Number, "the 64-bit types are Number subtypes");
eq(d as int64, int64(7), "`as int64` passes the value through");
eq(int64(1) is int64, true, "a static int64 is an int64");
check(!(int64(1) is int), "but it is not a 32-bit int");

// ---- E. 容器与装箱：`*` / Array / Dictionary 原样保留 64 位 ----
var arr:Array = [iMax, uMax, 3];
eq(arr[0], iMax, "an Array element keeps the full 64-bit value");
eq("" + arr[1], "18446744073709551615", "including the unsigned max");
var dict:Dictionary = new Dictionary();
dict["big"] = uMax;
eq("" + dict["big"], "18446744073709551615", "a Dictionary value keeps it too");
var dyn:Array = [];
for (var i:int = 0; i < 100; i++) { dyn.push(int64(i) << 40L); }
System.gc();
eq("" + dyn[99], "" + (99L << 40L), "boxed 64-bit values survive a GC (no pointer chasing)");

// ---- F. 类字段 / 构造参数 / 静态字段 / 复合赋值 ----
S.counter = 0L;
S.bump(); S.bump();
eq(S.counter, int64(2), "a static int64 field accumulates");
var h:Holder = new Holder(21L);
eq(h.twice(), int64(42), "a method can take and return int64");
h.big += 100L;
eq(h.big, int64(121), "compound assignment stays 64-bit");
eq(h["ub"], uint64(7), "reflective access reads the exact width");
h["ub"] = 9UL;
eq(h.ub, uint64(9), "and reflective writing coerces back");

// ---- G. 条件 / 三元 / switch（switch 对非 int/uint 取 if-else 链，无 fall-through）----
var flag:int64 = 0L;
if (int64(0) << 3L) { flag = 1L; } else { flag = 2L; }
eq(flag, int64(2), "a zero 64-bit value is falsy");
var pick:int64 = h.big > 0L ? int64(9) : int64(8);
eq(pick, int64(9), "a ternary with two int64 branches stays int64");
var hit:String = "none";
switch (h.big) { case 121L: hit = "big"; break; case 1L: hit = "one"; break; default: hit = "other"; }
eq(hit, "big", "an int64 switch discriminant compares with 64-bit equality");

// ---- 报告 ----
if (failCount == 0) trace("stage94t: all 64-bit integer checks passed");
else trace("stage94t: " + failCount + " check(s) FAILED");