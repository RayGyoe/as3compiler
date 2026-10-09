// stage94k.as — 阶段九十四·十二：null 接收者的成员访问应抛 TypeError #1009（而非段错误）。
//
// 触发：TODO.md 遗留行的「空对象（null）的属性/方法访问是段错误而非 AIR 的
// TypeError #1009」。此前 `f.stage.tabChildren`（f.stage 为 null）与
// `var x:* = f.restrict; x.length` 会直接 SIGSEGV。
//
// 全部按 AGENTS.md §1.5 以 adl 51.4.1 实测为准（证据台 temp/nullprobe/NullMain.as，
// 逐行输出在 temp/nullprobe/adl_null.txt）。关键实测口径：
//   * 对 null 的**任何**成员访问——读、写、方法调用、容器下标（`a[0]`/`a.length`）
//     ——都抛 `TypeError #1009: Cannot access a property or method of a null
//     object reference.`，与静态类型无关（Sprite / Object / Array / String / `*`）。
//   * 对 null 的**函数值调用**抛 `TypeError #1006: value is not a function.`（#1006 而非 #1009）。
//   * 对 `undefined`（`*` 未赋值）抛 #1010，但本子集没有独立的 undefined 值。
import flash.display.Sprite;
import flash.text.TextField;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// 断言某个闭包调用抛出指定 errorID 的 TypeError（消息逐字对齐 adl）。
function expectErr(id:int, msg:String, fn:Function):void {
	try {
		fn();
		throw new Error("FAIL: " + msg + " (no throw)");
	} catch (e:Error) {
		check(e.errorID == id, msg + " (id=" + e.errorID + ", want " + id + ")");
		if (id == 1009) {
			check(e.message == "Error #1009: Cannot access a property or method of a null object reference.",
				msg + " (message mismatch: " + e.message + ")");
		} else if (id == 1006) {
			check(e.message == "Error #1006: value is not a function.", msg + " (message mismatch: " + e.message + ")");
		}
	}
}

// ---- A. 类型化类实例（Sprite）：读 / 写 / 方法调用 ----
var s:Sprite = null;
expectErr(1009, "read nullable Sprite.x", function():void { var r:* = s.x; });
expectErr(1009, "write nullable Sprite.x", function():void { s.x = 5; });
expectErr(1009, "call method on nullable Sprite", function():void { s.getBounds(null); });

// ---- B. 根 Object（动态接收者） ----
var o:Object = null;
expectErr(1009, "read null Object.x", function():void { var r:* = o.x; });
expectErr(1009, "write null Object.x", function():void { o.x = 5; });

// ---- C. 容器下标读 / 写 ----
var a:Array = null;
expectErr(1009, "read null Array[0]", function():void { var r:* = a[0]; });
expectErr(1009, "read null Array.length", function():void { var r:* = a.length; });
expectErr(1009, "write null Array[0]", function():void { a[0] = 1; });

// ---- D. 字符串字段读到 C NULL ----
var st:String = null;
expectErr(1009, "read null String.length", function():void { var r:* = st.length; });
expectErr(1009, "call method on null String", function():void { st.charAt(0); });

// ---- E. 另一个内建类（Date） ----
var d:Date = null;
expectErr(1009, "read null Date.time", function():void { var r:* = d.time; });

// ---- F. null 函数值调用是 #1006（不是 #1009） ----
var f:Function = null;
expectErr(1006, "call null Function", function():void { f(); });

// ---- G. 无回归：非 null 接收者照常工作（守卫不能误报） ----
var live:Sprite = new Sprite();
live.x = 42; live.y = 7;
check(live.x == 42, "non-null receiver read still works");
live.x = 43;
check(live.x == 43, "non-null receiver write still works");
var arr:Array = [10, 20, 30];
check(arr[1] == 20, "non-null Array index read works");
arr[1] = 21;
check(arr[1] == 21, "non-null Array index write works");
var ss:String = "hello";
check(ss.length == 5, "non-null String.length works");
check(ss.charAt(1) == "e", "non-null String method works");
// 一个 null 结果本身是合法的：返回 null 再与 null 比较不抛。
var tf:TextField = new TextField();
var nullable:* = tf.restrict;
check(nullable == null, "a nullable string field reads as AS3 null (not a crash)");

trace("stage94k ok");