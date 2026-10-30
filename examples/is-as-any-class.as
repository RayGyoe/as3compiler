// is-as-any-class.as — `is`/`as` 的右操作数是 `*` 型变量（运行期 Class 值）。
//
// 阶段三百四十四 之前：`var ca:* = Sprite; x is ca` 是 `Codegen error: unknown
// type 'ca'`（`lookupClassVar` 只认 `Class` 型变量），而 AIR 把它解析成运行期
// 子类型测试。本示例把 `adl 51.4.1` 实测的完整口径钉下来（证据台 `temp/isany/`，
// 双端输出逐字节相同）：
//
//   · `*` 槽里的 Class 值：正常子类型测试（含内建接口、`Vector.<T>` 的 Class 值）；
//   · undefined 右操作数 → `TypeError #1010`（"A term is undefined and has no
//     properties."），null / 数字 / 字符串等非 Class 值 → `TypeError #1009`
//     （"Cannot access a property or method of a null object reference."）——
//     连 null 也报 #1009，不是「不匹配即 false」；
//   · 左操作数**先**求值、再校验右操作数（A5/A6：抛错前副作用已发生）；
//   · `as` 的失败面是 `null`（`bad as ca`），非 Class 右操作数同样抛 #1009/#1010；
//   · `Object` 型右操作数在 `mxmlc` 里是编译期「隐式强制转换」错误，我们同样
//     在编译期拒绝（`implicit coercion of a value of type Object to a possibly
//     unrelated type Class`）。
//
// 未在本示例断言的一处（编译期负例，钉在 unit: reflection/ClassValues）：
// `var co:Object = Sprite; x is co` 的隐式强制转换编译错误。
import flash.display.Sprite;
import flash.events.IEventDispatcher;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

function expectThrow(code:int, f:Function, msg:String):void {
	var caught:Boolean = false;
	try { f(); } catch (e:Error) { caught = (e.errorID == code); }
	if (!caught) throw new Error("FAIL: " + msg + " (expected #" + code + ")");
}

var cc:Class = Sprite; var ca:* = cc;
var cieC:Class = IEventDispatcher; var cie:* = cieC;
var cvC:Class = Vector.<int>; var cv:* = cvC;
var cnumC:Class = Number; var cnum:* = cnumC;
var cstrC:Class = String; var cstr:* = cstrC;
var cfC:Class = Function; var cf:* = cfC;
var bad:* = 5;
var nul:* = null;
var str:* = "hello";
var und:* = undefined;

// ---- 1. * 槽里的 Class 值：正常子类型测试 -------------------------------
check(new Sprite() is ca, "Sprite is ca");
check(!(5 is ca), "5 is ca false");
check(new Sprite() is cie, "Sprite is <IEventDispatcher class value>");
check(!(({} as Object) is cie), "{} is <IEventDispatcher class value> false");
check(new Vector.<int>() is cv, "Vector.<int> is cv");
check(!(new Vector.<String>() is cv), "Vector.<String> is cv false");
check(!([] is cv), "[] is cv false");
check(5 is cnum, "5 is <Number class value>");
check(!(true is cstr), "true is <String class value> false");
check(!(true is cf), "true is <Function class value> false");
check("x" is cstr, "'x' is <String class value>");
check(!(null is ca), "null is ca false");

// ---- 2. `as` 通过 * 槽里的 Class 值 -------------------------------
check(new Sprite() as ca != null, "Sprite as ca non-null");
check(new Sprite() as cie != null, "Sprite as <IEventDispatcher class value> non-null");
check(new Vector.<int>() as cv != null, "Vector.<int> as cv non-null");
check(new Vector.<String>() as cv == null, "Vector.<String> as cv null");
check(bad as ca == null, "bad as ca null");
check("x" as cstr == "x", "'x' as <String class value> keeps the value");

// ---- 3. 非 Class 右操作数：undefined → #1010，其余一律 #1009 -------------
expectThrow(1010, function():void { var r:Boolean = new Sprite() is und; }, "is undefined -> #1010");
expectThrow(1010, function():void { var r:* = new Sprite() as und; }, "as undefined -> #1010");
expectThrow(1010, function():void { var r:* = 5 as und; }, "5 as undefined -> #1010");
expectThrow(1010, function():void { var r:* = bad as und; }, "bad as undefined -> #1010");
expectThrow(1009, function():void { var r:Boolean = new Sprite() is bad; }, "is 5 -> #1009");
expectThrow(1009, function():void { var r:Boolean = new Sprite() is nul; }, "is null -> #1009");
expectThrow(1009, function():void { var r:Boolean = new Sprite() is str; }, "is 'hello' -> #1009");
expectThrow(1009, function():void { var r:Boolean = 5 is bad; }, "5 is 5 -> #1009");
expectThrow(1009, function():void { var r:* = new Sprite() as bad; }, "as 5 -> #1009");
expectThrow(1009, function():void { var r:* = 5 as bad; }, "5 as 5 -> #1009");
expectThrow(1009, function():void { var r:* = new Sprite() as nul; }, "as null -> #1009");
expectThrow(1009, function():void { var r:* = null as nul; }, "null as null -> #1009");
expectThrow(1009, function():void { var r:* = bad as str; }, "bad as 'hello' -> #1009");
expectThrow(1009, function():void { var r:Boolean = bad is nul; }, "bad is null -> #1009");
expectThrow(1009, function():void { var r:Boolean = bad is str; }, "bad is 'hello' -> #1009");

// ---- 4. 求值顺序：左操作数先于右操作数的校验（adl A5/A6） -----------------
var counter:int = 0;
function tick():Sprite { counter++; return new Sprite(); }
counter = 0;
try { var r1:Boolean = tick() is bad; } catch (e:Error) { check(counter == 1, "is: left side evaluated before the RHS throws"); }
counter = 0;
try { var r2:* = tick() as bad; } catch (e:Error) { check(counter == 1, "as: left side evaluated before the RHS throws"); }

// ---- 5. Class 型变量不受影响（回归既有路径） ------------------------------
var c2:Class = Sprite;
check(new Sprite() is c2, "Class-typed variable still works");
check(5 as c2 == null, "Class-typed as still null on mismatch");

trace("is-as-any-class: all checks passed");
