// tofixed-round.as — Number.toFixed 的 AIR 舍入契约（阶段四百一十九）。
//
// 背景：`as_num_toFixed` 曾经直接 `snprintf("%.*f")`，那是 C 的**半偶**（half-to-even）
// 舍入；AIR（avmplus MathUtils::convertDoubleToString，DTOSTR_FIXED）用 D2A 数字生成器
// 对**精确二进制展开**做**半上入**（half-up），并带一个兼容性怪癖（bugzilla513039）。
// 两条规则的全部实测依据在 temp/tofixed3（693 格双端矩阵，adl 51.4.1 逐格一致）：
//
//   1) 半上入：`(2.5).toFixed(0)` 是 "3" 不是 "2"；`(0.125).toFixed(2)` 是 "0.13"。
//      舍入作用在 double 的**精确**十进制展开上，不是十进制字面量：`2.675` 的真值是
//      2.67499999…，故 `(2.675).toFixed(2)` 是 "2.67" 而非 "2.68"。
//   2) 前导零截断：|v|<1 且所请求的每一位小数都是前导零时，**关闭舍入**、纯截断——
//      `(0.5).toFixed(0)` 是 "0"、`(0.005).toFixed(2)` 是 "0.00"、`(0.05).toFixed(1)`
//      是 "0.0"（尽管真值 0.05000000000000000277… 在平局之上）。
//
// 符号：负值舍入到零仍带负号（`(-0.05).toFixed(1)` = "-0.0"），但 -0 本身打印无符号。
// 大数（如 Number.MAX_VALUE）的有效位截断是另一条独立的 D2A 停止边界行为，见 TODO 遗留表。
//
// 编译运行：as-aot examples/tofixed-round.as --run

var failures:int = 0;
var checks:int = 0;
function eq(actual:String, expected:String, what:String):void {
  checks++;
  if (actual != expected) {
    failures++;
    trace("FAIL " + what + ": got [" + actual + "] want [" + expected + "]");
  }
}

// ---- 1) 半上入平局（核心缺陷：旧半偶会把这些舍成偶数）----
eq((2.5).toFixed(0), "3", "2.5 -> 3 (half-up, not half-even)");
eq((4.5).toFixed(0), "5", "4.5 -> 5");
eq((10.5).toFixed(0), "11", "10.5 -> 11");
eq((100.5).toFixed(0), "101", "100.5 -> 101");
eq((-2.5).toFixed(0), "-3", "-2.5 -> -3 (away from zero)");
eq((0.25).toFixed(1), "0.3", "0.25 -> 0.3");
eq((0.75).toFixed(1), "0.8", "0.75 -> 0.8");
eq((0.125).toFixed(2), "0.13", "0.125 -> 0.13");

// ---- 2) 舍入作用在精确二进制展开，而非十进制字面量 ----
eq((2.675).toFixed(2), "2.67", "2.675 true value is below the tie");
eq((1.255).toFixed(2), "1.25", "1.255 true value is below the tie");
eq((9.995).toFixed(2), "9.99", "9.995 true value is below the tie");
eq((99.995).toFixed(2), "100.00", "99.995 rounds up across the carry");
eq((0.05).toFixed(2), "0.05", "0.05 with enough places is exact");

// ---- 3) 前导零截断（bugzilla513039）：|v|<1 且请求位全为前导零 ----
eq((0.5).toFixed(0), "0", "0.5 -> 0 (truncation, not 1)");
eq((0.55).toFixed(0), "0", "0.55 -> 0");
eq((0.999).toFixed(0), "0", "0.999 -> 0");
eq((0.50000000000000001).toFixed(0), "0", "just above 0.5 still truncates");
eq((0.05).toFixed(1), "0.0", "0.05 -> 0.0 (leading zero eats the place)");
eq((0.005).toFixed(2), "0.00", "0.005 -> 0.00");
eq((0.0005).toFixed(3), "0.000", "0.0005 -> 0.000");

// ---- 4) 位数足够时舍入重新启用 ----
eq((0.005).toFixed(3), "0.005", "0.005 with 3 places keeps the 5");
eq((0.125).toFixed(1), "0.1", "0.125 -> 0.1 (first discarded digit is 2)");

// ---- 5) 符号：负值归零带号，-0 本身无号 ----
eq((-0.05).toFixed(1), "-0.0", "negative round-to-zero keeps the sign");
eq((-0.0001).toFixed(2), "-0.00", "-0.0001 -> -0.00");
eq((0 * -1.0).toFixed(2), "0.00", "-0 input prints unsigned");

// ---- 6) 进位传播 ----
eq((0.999).toFixed(2), "1.00", "0.999 carries into the integer part");
eq((0.9999999999999999).toFixed(16), "0.9999999999999999", "1-2^-53 exact expansion, no spurious carry to 1");

// ---- 7) 大数 / 高精度 / 次正规 ----
eq((1e21).toFixed(2), "1000000000000000000000.00", "1e21 keeps all integer digits");
eq((1234.5678).toFixed(0), "1235", "1234.5678 -> 1235");
eq((0.1).toFixed(20), "0.10000000000000000555", "0.1 exact expansion to 20 places");
eq((5e-324).toFixed(20), "0.00000000000000000000", "Number.MIN_VALUE truncates to zero");

// ---- 8) 特殊值 ----
eq(Number.NaN.toFixed(2), "NaN", "NaN");
eq(Number.POSITIVE_INFINITY.toFixed(0), "Infinity", "+Infinity");
eq(Number.NEGATIVE_INFINITY.toFixed(0), "-Infinity", "-Infinity");

// ---- 9) 动态接收者（* 与 Object 槽）走同一助手 ----
var d:* = 2.5;
eq(d.toFixed(0), "3", "dyn * half-up");
var d2:* = 0.05;
eq(d2.toFixed(1), "0.0", "dyn * leading-zero truncation");
var o:Object = 0.125;
eq(o.toFixed(2), "0.13", "Object-slot half-up");
var od:Object = 0.5;
eq(od.toFixed(0), "0", "Object-slot truncation");

if (failures > 0) {
  throw new Error(failures + " of " + checks + " checks failed");
}
trace("tofixed-round: " + checks + " checks passed");
