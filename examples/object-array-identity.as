// object-array-identity.as — Array 落在**静态声明为 Object** 的槽位上（阶段二百五十三 · G14）
//
// AS3 的 `Object` 是普适槽：`Number` / `String` / `Boolean` / `Array` 都是它的合法值，
// 而 `is` / `as` / `length` / 成员调用回答的是**值**，不是槽的静态类型。
// 我们的 Object 槽对标量会装箱（as_number_new / as_string_new / as_boolean_new），
// 对 Array 却是**裸指针直塞**（`(Object*)(as_array_make(...))`）—— 而 as_array 的第一个字
// 是元素缓冲，不是 vtable。于是：
//   * `o is Array` 被**编译期常量折成 false**（静默错误）；
//   * `o is Marker` 落成 `as_is(o, &Marker_vt)`，把元素缓冲当 vtable 读 ⇒ SIGSEGV；
//   * `o as Array` 得 NULL、`o.length` 得 undefined、`o.push(..)` / `o.toString()` 崩。
// `*` 槽只有一半毛病（`is Array` 对，`is <用户类>` 崩）；`Array` 类型直声明全对。
// Number/String/Boolean 进 Object 槽全对 —— 缺口**专属 Array**（及 Dictionary/Vector 的
// `is <用户类>` 崩溃）。
//
// 修复（不改表示，只改分派）：Object 接收者现在走**与 `*` 接收者完全相同**的运行时通路
// （as_obj_is_array / as_obj_as_array / as_obj_class_of、as_dyn_call→as_arr_call、
// as_dyn_get→as_array_key_get、as_dyn_del、as_obj_to_str / as_obj_to_number、
// for-each 走 as_obj_to_value），再加两条不变量：as_is / as_iface_lookup 拒绝把
// 「首字不是 vtable」的对象当实例读（as_has_vtable）。
//
// 下面每一格的期望值都是 **adl 51.4.1 实测**（temp/g14/ab.cjs 双路比对：55/55 行逐字相同），
// 不是凭语义猜的。断言直接 throw：改坏任何一格，进程非 0 退出，示例套件当场红。

function check(name:String, got:*, want:*):void
{
  if (String(got) != String(want)) {
    throw new Error("object-array-identity: " + name + " got " + got + " want " + want);
  }
}

class Marker { public var tag:String = "M"; }

// 通过函数参数再走一遍 —— kit 里 `fromAny(o:Object)` 正是这个形状。
function viaObject(o:Object):String { return (o is Array) + "/" + (o is Marker); }

// ---- A) Object 槽装 Array：类型判定 ----
var a:Object = [1, 2, 3];
check("is Array", a is Array, true);
check("is Object", a is Object, true);
check("is Number", a is Number, false);
check("is String", a is String, false);
check("is Boolean", a is Boolean, false);
check("is Class", a is Class, false);
check("is Function", a is Function, false);
check("is Vector.<int>", a is Vector.<int>, false);
check("is Marker", a is Marker, false);          // 旧版在这里 SIGSEGV
check("as Array != null", (a as Array) != null, true);
check("as Array length", (a as Array).length, 3);
check("constructor==Array", a.constructor == Array, true);
check("constructor==Object", a.constructor == Object, false);
check("String(constructor)", String(a.constructor), "[class Array]");
check("typeof", typeof(a), "object");
check("getQualifiedClassName", getQualifiedClassName(a), "Array");

// ---- B) Object 槽装 Array：元素 / length / 成员 ----
check("length", a.length, 3);
check("a[0]", a[0], 1);
check("a[\"1\"]", a["1"], 2);
a[0] = 9;
check("a[0]=9", a[0], 9);
check("\"0\" in o", "0" in a, true);
check("\"9\" in o", "9" in a, false);
check("indexOf(2)", a.indexOf(2), 1);
a["length"] = 2;
check("o[\"length\"]=2", a.length, 2);

var del:Object = [1, 2, 3];
check("delete o[0]", delete del[0], true);
check("delete 后 o[0]", del[0], undefined);
check("delete 后 length", del.length, 3);        // 删除留洞，不改长度

// ---- C) Object 槽装 Array：方法调用（一律动态分派） ----
var mth:Object = ["x", "y"];
check("join(\"-\")", mth.join("-"), "x-y");
check("push", mth.push("z"), 3);
check("pop", mth.pop(), "z");
check("unshift", mth.unshift("w"), 3);
check("toString()", mth.toString(), "w,x,y");
check("valueOf()", mth.valueOf(), "w,x,y");
var srt:Object = [3, 2, 1];
srt.sort();
check("sort + join", srt.join(","), "1,2,3");
var sl:Object = [1, 2, 3];
check("slice(1).length", (sl.slice(1) as Array).length, 2);

// ---- D) Object 槽装 Array：隐式转换 ----
var c1:Object = [1, 2, 3];
check("String(o) 拼接", "v=" + c1, "v=1,2,3");
check("== \"1,2,3\"", c1 == "1,2,3", true);
check("Number([1,2,3])", Number(c1), NaN);
var n5:Object = ["5"];
check("Number([\"5\"])", Number(n5), 5);
var nempty:Object = [];
check("Number([])", Number(nempty), 0);
var nested:Object = [[1]];
check("String([[1]])", String(nested), "1");

// ---- E) Object 槽装 Array：遍历 ----
var fe:Object = [1, 2, 3];
var sum:int = 0;
for each (var v:* in fe) sum += int(v);
check("for each sum", sum, 6);
var fi:Object = [1, 2, 3];
var keys:String = "";
for (var k:String in fi) keys += k + ",";
check("for-in keys", keys, "0,1,2,");

// ---- F) 参数位：Object 形参同样成立 ----
var pa:Object = [1, 2];
check("viaObject(array)", viaObject(pa), "true/false");

// ---- G) `*` 槽：is Array 本来就对，is <用户类> 不许崩 ----
var st:* = [1, 2, 3];
check("* is Array", st is Array, true);
check("* is Marker", st is Marker, false);
check("* constructor==Array", st.constructor == Array, true);

// ---- H) 反向：别的类型进 Object 槽不得被误判成 Array ----
var dict:Object = new Dictionary();
check("dict is Array", dict is Array, false);
check("dict is Marker", dict is Marker, false);
var vec:Object = new Vector.<int>(3);
check("vector is Array", vec is Array, false);
check("vector is Marker", vec is Marker, false);
check("vector length", vec.length, 3);
var rec:Object = { a: 1 };
check("record is Array", rec is Array, false);
check("record length", rec.length, undefined);
var nul:Object = null;
check("null is Array", nul is Array, false);
check("null is Marker", nul is Marker, false);

// ---- I) 反向：Number/String/Boolean/Marker 进 Object 槽的旧行为不许退化 ----
var num:Object = 3;
check("Number is Number", num is Number, true);
check("Number is Array", num is Array, false);
var str:Object = "x";
check("String is String", str is String, true);
check("String is Array", str is Array, false);
var marker:Object = new Marker();
check("Marker is Marker", marker is Marker, true);
check("Marker is Array", marker is Array, false);
check("Marker constructor==Marker", marker.constructor == Marker, true);

// ---- J) 直声明 Array 槽：永远正确的对照组 ----
var plain:Array = [1, 2, 3];
check("Array is Array", plain is Array, true);
check("Array is Marker", plain is Marker, false);
check("Array constructor==Array", plain.constructor == Array, true);

// ---- K) Object 自有的四个方法：没有 vtable 的堆种类也必须有答案 ----
// Dictionary / Vector 与 Array 一样“首字不是 vtable”，所以静态解析 Object 的
// toString 槽（`o->vtable->toString(o)`）同样会野读。运行时按堆种类回答
// （as_dyn_object_builtin）：record "[object Object]"、Dictionary
// "[object Dictionary]"、Vector 用 join(",")；hasOwnProperty /
// propertyIsEnumerable 走 as_dyn_has / as_dyn_enumerable；valueOf 返回自身。
// 以下期望值均为 adl 51.4.1 实测（temp/g14/DictAir.as）。
var rec2:Object = { z: 1 };
check("record toString", rec2.toString(), "[object Object]");
check("record hasOwnProperty(z)", rec2.hasOwnProperty("z"), true);
check("record hasOwnProperty(nope)", rec2.hasOwnProperty("nope"), false);
check("record valueOf()==rec", rec2.valueOf() == rec2, true);
var dict2:Object = new Dictionary();
dict2["k"] = 7;
check("dict toString", dict2.toString(), "[object Dictionary]");
check("dict hasOwnProperty(k)", dict2.hasOwnProperty("k"), true);
check("dict propertyIsEnumerable(k)", dict2.propertyIsEnumerable("k"), true);
check("String(dict)", String(dict2), "[object Dictionary]");
var vec2:Object = new Vector.<int>(3);
check("vector toString", vec2.toString(), "0,0,0");
check("array hasOwnProperty(0)", a.hasOwnProperty("0"), true);
check("array propertyIsEnumerable(0)", a.propertyIsEnumerable("0"), true);

// ---- L) 415 未变：Number/String/Boolean 进 Object 槽后调方法仍走静态派发 ----
var nb:Object = 5;
check("Number到Object 的 toString", nb.toString(), "5");
var sb:Object = "ab";
check("String到Object 的 toString", sb.toString(), "ab");
trace("object-array-identity: all assertions passed");