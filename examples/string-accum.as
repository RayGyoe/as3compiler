// string-accum.as — 局部/脚本级字符串累加器（阶段四百四十二）
//
// `s += x` 过去一律发成 `as_str_concat(s, x)`：右边要新分配一次**精确长度**的块，
// 并把左操作数整个重拷一遍，于是长度 n 的累积串第 i 次追加要拷 Σi·2B（O(n²)；
// benchmarks/stringbuild 的 4000 字符档是 AIR 的 11 倍）。阶段四百四十二把「只被
// `+=` 和整体赋值写过的 String 局部/脚本变量」改成一个**可增长缓冲区**：
//
//   · 缓冲区是私有的：两次 append 之间 C 变量**故意是陈旧的**，只有读点
//     （`as_sb_read`）才把字节暴露出来；
//   · 一旦暴露过（handed），下一次 append 就另开一块新块、不再原地写 —— 所以
//     `var t:String = s;` 之后 `s += ...` 绝不会改到 `t`；
//   · 追加时按 2 倍扩容，因此连续追加是均摊 O(1)、整轮 O(n)。
//
// 这属于 AGENTS.md §1「翻译形态不变、只换实现」：结果、错误、顺序一律不变。所以
// 本示例钉的不是性能，而是**变量陈旧/缓冲区私有**这条契约的边界语义——下面的期望
// 值全部是 `adl 51.4.1` 跑同一份程序读出来的（temp/sb/air，16 行逐行一致）。
//
// 覆盖到的边界：
//   · 循环追加 + 读；别名的值**不得**随后续追加改变（缓冲区私有的核心断言）
//   · 整体赋值重置缓冲区（`s = "reset"` 之后再追加）
//   · 非 String 右值的 ToString（`s += 3`）
//   · 每一轮都读的形态（`t += "z"; trace(t)`）：每轮读都冻结一次，仍然逐轮正确
//   · `null` 追加：ES3 的 ToString(null) = "null"（AIR 打 nulln，不是 n）
//   · 3000 字节增长（多次扩容，跨 32→64→…→4096）
//   · 只做过整体赋值的串（`p = p + "b"`）保持原样路径
//   · 被闭包捕获的串**不**走累加器（闭包走共享 cell，陈旧变量会读错）
//   · 值位形态 `q += "y"`：表达式值是追加后的新串，且变量也被更新
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var s:String = "";
for (var i:int = 0; i < 5; i++) s += "ab";
check(s == "ababababab", "loop append: " + s);

// 别名：读点把缓冲区交出去，之后再次追加必须另开新块（旧块冻结）。
var alias:String = s;
s += "X";
check(alias == "ababababab", "alias frozen: " + alias);
check(s == "abababababX", "append after alias: " + s);

// 整体赋值重置缓冲区。
s = "reset";
s += "!";
check(s == "reset!", "reset then append: " + s);

// 非 String 右值走 ToString。
s += 3;
check(s == "reset!3", "append int: " + s);

// 每轮都读：读点冻结缓冲区，下一轮追加另开新块，逐轮值仍正确。
var t:String = "";
var expect:String = "";
for (var k:int = 0; k < 4; k++) {
  t += "z";
  expect += "z";
  check(t == expect, "read every round: " + t);
}
check(t == "zzzz", "read every round end: " + t);

// null 追加：ES3 ToString(null) = "null"。
var u:String = null;
u += "n";
check(u == "nulln", "null append: " + u);

// 多次扩容。
var w:String = "";
for (var j:int = 0; j < 300; j++) w += "0123456789";
check(w.length == 3000, "grown length: " + w.length);
check(w.charAt(0) == "0" && w.charAt(2999) == "9", "grown edges: " + w.charAt(0) + w.charAt(2999));
var wc:int = 0;
for (var m:int = 0; m < w.length; m++) if (w.charCodeAt(m) == 48 + (m % 10)) wc++;
check(wc == 3000, "grown content: " + wc);

// `s = s + x` 与 `s += x` 等价（左操作数就是变量本身）；顺序相反的
// `s = x + s` 不是追加，仍按整体赋值处理。
var sa:String = "a";
sa = sa + "b";
sa = sa + "c";
check(sa == "abc", "self append: " + sa);
var sr:String = "a";
sr = "c" + sr;
check(sr == "ca", "reversed concat: " + sr);

// 只做过整体赋值：保持原来的 concat 路径。
var p:String = "a";
p = p + "b";
check(p == "ab", "plain concat: " + p);

// 被闭包捕获：走共享 cell，不参与累加器。
var cap:String = "";
var f:Function = function():void { cap += "c"; };
f();
f();
check(cap == "cc", "captured append: " + cap);

// 值位形态：表达式值与变量都被更新。
var q:String = "x";
var r:String = (q += "y");
check(r == "xy", "value form result: " + r);
check(q == "xy", "value form variable: " + q);

// 追加后再整体赋值，两者互不残留。
var z:String = "";
z += "a";
z = "b";
z += "c";
check(z == "bc", "assign between appends: " + z);

// 脚本级（模块）累加器走同一条契约：本文件顶层的 s 就是模块变量。
check(s == "reset!3", "script-scope accumulator: " + s);

trace("string-accum: all checks passed");