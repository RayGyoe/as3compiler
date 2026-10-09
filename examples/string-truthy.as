// string-truthy.as — AS3 里**空字符串是假值**；静态 String 的条件判定此前直接用
// `char*` 非空测试，把 `""`（非空指针）判成了真。
//
// 修复（阶段一百二十四·二）：`condExpr` 对静态 string 走新增的 `as_str_truthy`
// （`s != NULL && s[0] != 0`），与 boxed 路径 `as_v_truthy` 的 tag-3 分支一致；
// helper 取参保证 `if (f())` 只调用一次（不外扩成 `s != NULL && s[0] != 0`）。
// 修复前：`var s:String=""; s && "hi"` 得 `"hi"`（应为 `""`）；
// adl 51.4.1（temp/logicrepro/AirTruth2.as → adl-truth2.txt）：
//   `("" && "hi")` 长度为 0，`Boolean("")` 为 false。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var s:String = "";

// 1) if/else：空串走 else 分支。
var branch:String = "";
if (s) branch = "T"; else branch = "F";
check(branch == "F", "if (emptyString) takes the else branch (got '" + branch + "')");

// 2) `!` 与 `?:` 同样把空串当假值。
check(!s, "!emptyString is true");
check((s ? "T" : "F") == "F", "?: on an empty String takes the false branch");

// 3) while 条件不得进入循环体。
var n:int = 0;
while (s) { n++; if (n > 3) break; }
check(n == 0, "while (emptyString) never enters the body (got " + n + " iterations)");

// 4) 非空串仍然是真值（不得因修复而反向出错）。
var mut:String = "hi";
var n2:int = 0;
while (mut) { n2++; mut = ""; }
check(n2 == 1, "a non-empty String is still truthy (got " + n2 + " iterations)");
var hi:String = "hi";

// 5) `&&`：空串在左 → 结果就是那个空串；在右 → 右侧为空串时结果也是空串。
var r1:* = (s && "hi");
check((r1 as String).length == 0, "(\"\" && \"hi\") is \"\" (got '" + r1 + "')");
var r2:* = (hi && s);
check((r2 as String).length == 0, "(\"hi\" && \"\") is \"\" (got '" + r2 + "')");

// 6) `||`：空串为假 → 取右侧；非空串为真 → 取自身。
var r3:* = (s || "fb");
check(r3 == "fb", "(\"\" || \"fb\") is \"fb\" (got '" + r3 + "')");
var r4:* = (hi || "fb");
check(r4 == "hi", "(\"hi\" || \"fb\") is \"hi\" (got '" + r4 + "')");

// 7) 动态（boxed）空串的真值判定此前就是对的，这里一并钉住两条路径一致。
var arr:Array = [""];
var r5:* = (arr[0] || "fb");
check(r5 == "fb", "a boxed empty String is falsy through || (got '" + r5 + "')");
check(!arr[0], "!boxedEmptyString is true");
check(arr[0] === "", "a boxed empty String still === \"\"");
var cond:String = (arr[0] ? "T" : "F");
check(cond == "F", "?: on a boxed empty String takes the false branch");

// 8) String 值的条件只求值一次（helper 取参，不外扩表达式）。
var calls:int = 0;
function nextName():String { calls++; return ""; }
if (nextName()) { calls += 100; }
check(calls == 1, "a String-returning condition is evaluated exactly once (got " + calls + ")");

trace("string-truthy: all assertions passed");