// bytearray-index.as — 阶段一百零二：`ByteArray` 的下标形式读（含正越界）。
//
// 为什么需要：`ba[i]` 此前只在 `i` 落在 `[0, length)` 时给出字节，越界读被当成
// 其它 sealed 属性一样处理（静态读给出 0 / 动态读抛 #1069），而 AIR 的下标形式是
// **AVM2 index 语义**而非属性表查找 —— 越界读返回 `undefined`、负索引抛 #1069、
// 字符串键按键的**规范下标文本**决定走不走下标形式。
//
// 全部口径按 adl 51.4.1 实测（temp/baidxprobe/ba-result.txt，21 行逐行比对）：
//   * 区间内：`b[0]` = 65，`typeof` 为 `"number"`，`is int` / `is Number` 皆 true；
//   * **正越界返回 undefined**（不是 0、不抛错）：`b[3]`（len=3）与 `b[9]`、`b[1000000]`
//     一样是 `undefined`，`== null` true、`=== undefined` true，拼进字符串得 `"undefined|"`；
//   * **负索引抛 #1069**（属性查找 miss）——索引形式并未成为「数组式」访问；
//   * **字符串键按规范下标文本判定**：`"0"`/`"2"` 是下标（得 65/200），而 `"00"`、
//     `"1.5"`、`" 1"`、`"-1"`、`"zz"` **不是**下标（一律 #1069）；
//   * `*` 与 `Object` 接收者同语义（`d[3]` 也是 undefined，`d[-1]` 也抛 #1069）；
//   * 写：`b[5] = 7` 扩展 buffer 并零填充间隙（length 6、b5=7、b3=0）；动态写
//     `d[3] = 5` 同样扩展；动态**非下标键** `d.zz = 1` 抛 #1056（属性表语义）；
//   * 写入值走 AS3 的 ToNumber（含**装箱字符串**解析）：`ba[0] = "5"` 写 5、`300` 写 44、
//     `-1` 写 255、`true` 写 1、`null` 写 0、`1.7` 写 1、`"x"` 写 0；
//   * `in`：`"0" in b` true / `"9" in b` false（按**下标范围**判定，不是属性表）；
//   * `delete b[0]` = **false** 且不抛（静态与动态同）；
//   * `*` 接收者的 `.length` 仍是 buffer 长度（as_any_length 的 ByteArray 分支）。
//
// 已知未对齐项（已登记 TODO 遗留表，不在本示例断言内）：
//   * 动态值 `as <原始类型>`：AIR 对类型不符一律给 **null**（`b[9] as int` → null），
//     我方给出该原始类型的默认值（int → 0）；完整矩阵见 temp/baidxprobe/ca-result.txt。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function errId(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return -1;
}
function indexProbe(b:ByteArray, i:int):* { return b[i]; }
function indexWrite(b:ByteArray, i:int, v:*):void { b[i] = v; }

function fresh():ByteArray {
  var b:ByteArray = new ByteArray();
  b.writeByte(65); b.writeByte(66); b.writeByte(200);
  return b;
}

// ---- 区间内读：Number，且 is int / is Number -------------------------
var b:ByteArray = fresh();
check(b[0] == 65, "b[0] == 65");
check(b[2] == 200, "b[2] == 200 (a byte over 127 is unsigned)");
check(typeof b[0] == "number", "typeof b[0] == number");
check(b[0] is int, "b[0] is int");
check(b[0] is Number, "b[0] is Number");
check(b[0] + 1 == 66, "b[0] + 1 == 66 (boxed read participates in arithmetic)");
check(b.length == 3, "b.length == 3 (untouched by the index form)");
check(b["2"] == 200, "a canonical string key is an index too");
check(b["length"] == 3, "a non-canonical key still finds the real accessor");

// ---- 正越界读：undefined ----------------------------------------------
check(b[3] == undefined, "in-range end reads undefined");
check(b[9] == undefined, "far out of range reads undefined");
check(b[1000000] == undefined, "very far out of range reads undefined");
check(b[3] === undefined, "b[3] === undefined");
check(b[3] == null, "b[3] == null (undefined is null-ish)");
check(typeof b[3] == "undefined", "typeof b[3] == undefined");
check(b[3] + "|" == "undefined|", "concatenating an undefined read yields \"undefined|\"");
check(indexProbe(b, 4) == undefined, "a *-typed return path keeps undefined");

// ---- 负索引 / 非规范字符串键：抛 #1069 ---------------------------------
check(errId(function():void { var _x:int = b[-1]; }) == 1069, "a negative index throws #1069");
check(errId(function():void { var _x:int = b["00"]; }) == 1069, "\"00\" is not an index");
check(errId(function():void { var _x:int = b["1.5"]; }) == 1069, "\"1.5\" is not an index");
check(errId(function():void { var _x:int = b[" 1"]; }) == 1069, "\" 1\" (leading space) is not an index");
check(errId(function():void { var _x:int = b["-1"]; }) == 1069, "\"-1\" is not an index");
check(errId(function():void { var _x:int = b["zz"]; }) == 1069, "a non-numeric string key is not an index");
check(errId(function():void { var _x:* = b["zz"]; }) == 1069, "the same holds for a *-typed read");

// ---- 动态接收者（* / Object）同语义 ------------------------------------
var d:* = b;
check(d[0] == 65, "d[0] == 65 through a * receiver");
check(d[3] == undefined, "out of range through a * receiver reads undefined");
check(d["2"] == 200, "canonical string key through a * receiver");
check(errId(function():void { var _x:* = d[-1]; }) == 1069, "negative index through a * receiver throws");
check(errId(function():void { var _x:* = d["zz"]; }) == 1069, "non-index key through a * receiver throws");
var o:Object = b;
check(o[3] == undefined, "an Object-typed receiver also reads undefined (not #1069)");
check(d["length"] == 3, "a * receiver still resolves the real length accessor by name");
// A non-index string key is a property-table miss even for a * / Object receiver
// (measured on adl: o["zz"], o.zz and d["zz"] all throw #1069).
check(errId(function():void { var _z:* = o["zz"]; }) == 1069, "o[\"zz\"] throws #1069");
check(errId(function():void { var _z:* = o.zz; }) == 1069, "o.zz throws #1069");
check(errId(function():void { var _z:* = d["zz"]; }) == 1069, "d[\"zz\"] throws #1069");

// ---- 写：扩展 + 零填充 -------------------------------------------------
var w:ByteArray = new ByteArray();
w.writeByte(1); w.writeByte(2); w.writeByte(3);
w[5] = 7;
check(w.length == 6, "writing past the end extends the buffer");
check(w[5] == 7, "the written byte reads back");
check(w[3] == 0, "the gap is zero filled");
var wd:* = new ByteArray();
wd.writeByte(9);
wd[3] = 5;
check(wd.length == 4, "a dynamic write extends the buffer too");
check(wd[3] == 5, "the dynamically written byte reads back");
check(wd.length == 4, "* receiver .length still reports the buffer length");
check(errId(function():void { wd.zz = 1; }) == 1056, "a dynamic non-index key throws #1056");

// ---- 写入值的 ToNumber（含装箱字符串） --------------------------------
var vals:Array = ["5", 300, -1, true, null, 1.7, "x", 65];
var want:Array = [5, 44, 255, 1, 0, 1, 0, 65];
for (var i:int = 0; i < vals.length; i++) {
  var sb:ByteArray = new ByteArray(); sb.writeByte(0);
  var db:* = new ByteArray(); db.writeByte(0);
  var vv:* = vals[i];
  sb[0] = vv;
  db[0] = vv;
  check(sb[0] == want[i], "static write of " + vv + " -> " + want[i]);
  check(db[0] == want[i], "dynamic write of " + vv + " -> " + want[i]);
}

// ---- in：按下标范围 ---------------------------------------------------
check(("0" in b) == true, "\"0\" in b");
check(("2" in b) == true, "\"2\" in b");
check(("9" in b) == false, "\"9\" in b is false even though the property table is empty");
check(("0" in d) == true, "\"0\" in d (dynamic receiver)");
check(("5" in d) == false, "\"5\" in d is false");
check(("length" in b) == true, "\"length\" is a real property, so `in` finds it");

// ---- delete：恒 false，不抛 -------------------------------------------
check((delete b[0]) == false, "delete b[0] is false and does not throw");
check((delete d[0]) == false, "delete d[0] is false too");
check((delete d.zz) == false, "delete of a missing dynamic property is false");

// ---- 与属性访问器并存（不发散） ---------------------------------------
check(b.length == 3, "the buffer is unchanged after all of the above");
check(b.bytesAvailable == 0, "position was never moved by the index form");

trace("bytearray-index: all assertions passed; len=" + b.length + " b2=" + b[2]);