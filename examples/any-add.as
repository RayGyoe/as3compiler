// any-add.as — 动态 `+`（任一侧静态类型为 `*`）的 AS3 语义回归。
// 修复（阶段八十九·三十四）：`a + b` 只要有一侧是 `*`，就**由运行时 tag 决定**
// 拼接还是数值相加（走新增的 `as_add_v`，对应 ES3 ToPrimitive：任一侧是 String
// 或会 stringify 的对象 → 拼接），而不是一律 `as_v_to_number(a) + as_v_to_number(b)`。
// 修复前：`var a:Array=["x","y"]; a[0]+a[1]` 得 `0`（应为 `"xy"`）；
// `var d:*="x"; d + 1` 得 `1`（应为 `"x1"`）。
// 顺带修掉：`null + 1` 此前直接发射 `(NULL + 1)` → **编译失败**，现按 AS3 得 `1`。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 1) 两侧都是 `*`，运行时是字符串 → 拼接（修复前为 0）。
var a:Array = ["x", "y"];
var s1:String = a[0] + a[1];
check(s1 == "xy", "any + any of runtime Strings concatenates (got '" + s1 + "')");
check((a[0] + a[1]).length == 2, "concatenated result carries String length");

// 2) 两侧都是 `*`，运行时是数字 → 数值相加（不得因修复而变成字符串 "12"）。
var n:Array = [1, 2];
var n1:Number = n[0] + n[1];
check(n1 == 3, "any + any of runtime Numbers still adds (got " + n1 + ")");

// 3) 一侧 `*` 且运行时是字符串 + 静态数字 → 拼接（修复前为 1）。
var d:* = "x";
var s2:String = d + 1;
check(s2 == "x1", "any(String) + int concatenates (got '" + s2 + "')");

// 4) 一侧 `*` 且运行时是数字 + 静态数字 → 数值相加。
var e:* = 5;
var n2:Number = e + 1;
check(n2 == 6, "any(Number) + int adds (got " + n2 + ")");

// 5) 混合链：静态 String 在最左侧时沿用 as_str_concat（既有路径不受影响）。
var s3:String = "a" + d + 1;
check(s3 == "ax1", "static String on the left still concatenates (got '" + s3 + "')");

// 6) null 参与 `+`：AS3 数值分支按 0 处理（修复前是 C 编译错误）。
var z:* = null;
var n3:Number = z + 1;
check(n3 == 1, "any(null) + 1 coerces null to 0 (got " + n3 + ")");
var n4:Number = null + 1;
check(n4 == 1, "the null literal + 1 also yields 1 (got " + n4 + ")");
var s4:String = "v=" + z;
check(s4 == "v=null", "static String + null renders \"null\" (got '" + s4 + "')");

// 7) 复合赋值同样走动态 `+`（`+=` 复用 emitBinary 的 `+`）。
var acc:* = "q";
acc += "r";
check(acc + "" == "qr", "any += String concatenates (got '" + acc + "')");
var ctr:* = 1;
ctr += 2;
var n5:Number = ctr;
check(n5 == 3, "any += Number adds (got " + n5 + ")");

trace("any-add: all assertions passed");