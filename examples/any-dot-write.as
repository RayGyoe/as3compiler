// any-dot-write.as — `*`（动态类型）接收者的**点写入**语义回归。
// 修复（阶段八十九·三十三）：`d.prop = v`（`d` 为 `*`）必须按运行时 box tag 分派，
// 即走 as_any_set —— 而不是把接收者强行当成匿名 record（as_object_set）。后者会把
// 类实例的 vtable 指针、数组的元素缓冲当成 props 表：密封类实例上 `d.unknown = 5`
// 直接 SIGSEGV，数组上 `d.bar = 8` 静默写坏内存（`d.length` 变成垃圾值）。
// 读取路径（as_any_get）与 `d["k"] = v`（as_any_set）本来就是这个约定，此处补齐点写入。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Sealed { public var x:int = 7; }

var s:Sealed = new Sealed();
var d:* = s;

// 1) 已知字段经 `*` 写入必须落到真实字段（as_dyn_set 沿 vtable 反射表查找）。
d.x = 42;
check(d.x == 42, "any dot write reaches a reflectable field");
check(s.x == 42, "the same field is visible through the static type");

// 2) 复合赋值经 `*` 同样要读旧值再写回。
d.x += 8;
check(s.x == 50, "any compound dot write (d.x += 8)");

// 3) 密封类的未知属性：AS3 抛 ReferenceError #1056。
var threw:Boolean = false;
try { d.unknown = 5; } catch (e:Error) { threw = (e.message.indexOf("1056") >= 0); }
check(threw, "sealed instance rejects an unknown-property write with #1056");
check(d.x == 50, "sealed instance survives an unknown-property write");
check(s.x == 50, "unknown-property write did not corrupt the instance");

// 4) 匿名对象（record）经 `*` 写入：新增/更新 record 槽。
var rec:* = { a: 1 };
rec.b = 2;
check(rec.b == 2, "any dot write adds a record slot");
rec.a += 10;
check(rec.a == 11, "any compound dot write on a record");

// 5) 数组经 `*`：不得写坏元素缓冲与 length。AS3 的 Array 是动态对象，`da.bar = 8` 存成
//    命名属性（AIR 实测：`arr.bar` 为 8、`arr.length` 仍为 3、`arr[0]` 仍为 1）。
var arr:Array = [1, 2, 3];
var da:* = arr;
da.bar = 8;
check(arr.length == 3, "array length survives an any dot write");
check(arr[0] == 1, "a non-numeric key must NOT be mapped to index 0");
check(arr[1] == 2 && arr[2] == 3, "other array elements untouched");
check(da.bar == 8, "non-numeric key is stored as a named property");

trace("any-dot-write: all assertions passed");