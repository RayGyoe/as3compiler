// stage94m.as — 阶段九十四·十四：TextField.restrict（用户输入字符过滤）。
//
// 触发：TODO.md 遗留行的「`restrict`/`displayAsPassword` 只存不生效」（阶段九十四·七
// 主动登记）。全部按 AGENTS.md §1.5 以 adl 51.4.1 实测为准（证据台
// temp/editprobe/src/Ed11.as..Ed14.as + drive_ed11.py..drive_ed14.py，日志
// adl_ed11.txt / adl_ed12*.txt / adl_ed13.txt / adl_ed14.txt）。
//
// 关键实测口径（本示例逐条钉住）：
//   * 模式 = **允许集**；`-` 是区间，`\` 转义下一个字符；**开头**的 `^` 把整个集
//     翻转成「排除集」。`null` = 不过滤，`""` = 什么都不允许（两者不同！）。
//   * 逐字符判定：允许则原样插入；否则若**大小写互换后**的字符被允许，就插入那一
//     个（"A-Z" 键入 'a' → 插入 "A"；"a-z" 键入 'Z' → 插入 "z"；"^a" 键入 'a' →
//     插入 "A"，因为被排除的只是小写形式）；两者都不允许就整字符丢弃。
//   * 过滤发生在 textInput **派发之后**：事件载荷永远是原始文本（监听器看到的是
//     未过滤的串，且可以 preventDefault 取消整次输入）。
//   * 过滤只作用于**用户输入**：程序化 `text = "..."` 赋值从不经过 restrict。
//   * 换行（CR/LF）**绕过**过滤：多行字段 restrict="0-9" 时 Return 仍插入换行。
//   * 全被丢弃的一次按键：插入 0 个字符 → 不发 change、光标不动；但**若当时有选区**，
//     选区照样被吞掉并发 change（与 maxChars 溢出同一条 splice 语义）。
import flash.display.*;
import flash.events.*;
import flash.text.*;

var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}
function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) { failCount++; trace("FAIL: " + msg + " (got " + actual + ", want " + expected + ")"); }
}

var stage:Stage = new Stage();

function mkInput(restrict:String, multiline:Boolean):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = 10; f.width = 300; f.height = multiline ? 70 : 30;
	f.text = "";
	f.type = TextFieldType.INPUT;
	f.multiline = multiline;
	f.restrict = restrict;
	stage.addChild(f);
	return f;
}
// adl 实测的「一次按键」序列：keyDown（可派发）→ textInput（带原始串）→ 插入 → change。
// keyDown 在真实后端由 SDL 产生；这里用 Stage.dispatchKey / dispatchText 两个测试钩子
// 把同一串事件喂进同一条生成代码路径。
function type(f:TextField, s:String, keyCode:int, charCode:int):void {
	stage.focus = f;
	stage.dispatchKey("keyDown", keyCode, charCode, 0);
	stage.dispatchText(s);
}
var changeCount:int = 0;
stage.addEventListener("change", function(ev:Event):void { changeCount++; });
var lastText:String = null;
stage.addEventListener("textInput", function(ev:TextEvent):void { lastText = ev.text; });

// ---- A. 默认值与往返 ----
// restrict 未设时是 AS3 的 null（不是空串）：字符串字段读到 C NULL 时由 as_v_str
// 归一到 null 字面量，与 stage94g 的默认值断言同一约定。
var f:TextField = new TextField();
check(f.restrict == null, "restrict defaults to null (no filter)");
f.restrict = "0-9";
eq(f.restrict, "0-9", "restrict round-trips");

// ---- B. 允许集：非集内字符被丢弃，集内字符插入 ----
var d:TextField = mkInput("0-9", false);
type(d, "a", 65, 97);
eq(d.text, "", "a char outside the allow set is dropped");
changeCount = 0;
type(d, "5", 53, 53);
eq(d.text, "5", "a char inside the allow set is inserted");
eq(changeCount, 1, "an accepted keystroke fires change");
// 被丢弃的一次按键：textInput 照样派发（载荷是原始文本），但不插入、不发 change。
lastText = null;
changeCount = 0;
type(d, "b", 66, 98);
eq(lastText, "b", "textInput is dispatched for a rejected keystroke too, with the raw text");
eq(d.text, "5", "the rejected keystroke inserts nothing");
eq(changeCount, 0, "and it fires no change");

// ---- C. 大小写互换回退 ----
var up:TextField = mkInput("A-Z", false);
type(up, "a", 65, 97);
eq(up.text, "A", "with \"A-Z\", a typed 'a' is inserted as 'A' (case is toggled, not dropped)");
type(up, "5", 53, 53);
eq(up.text, "A", "a digit has no other case, so it is dropped under \"A-Z\"");
var lo:TextField = mkInput("a-z", false);
type(lo, "Z", 90, 90);
eq(lo.text, "z", "with \"a-z\", a typed 'Z' is inserted as 'z'");

// ---- D. 排除集 `^`：被排除的字符仍然走大小写回退 ----
var not:TextField = mkInput("^a", false);
type(not, "a", 65, 97);
eq(not.text, "A", "with \"^a\", only the lowercase 'a' is excluded, so 'a' becomes 'A'");
type(not, "b", 66, 98);
eq(not.text, "Ab", "a char outside the excluded set passes through unchanged");
var not5:TextField = mkInput("^5", false);
type(not5, "5", 53, 53);
eq(not5.text, "", "with \"^5\", a digit has no other case and is dropped");
type(not5, "6", 54, 54);
eq(not5.text, "6", "the rest of the digits pass");

// ---- E. 区间与转义 ----
var rng:TextField = mkInput("0-9\\-", false);
type(rng, "5", 53, 53);
eq(rng.text, "5", "a range accepts its members");
type(rng, "-", 27, 45);
eq(rng.text, "5-", "an escaped '-' is a literal member, not a range");
type(rng, "a", 65, 97);
eq(rng.text, "5-", "a char outside range+escape is dropped");
var car:TextField = mkInput("\\^", false);
type(car, "^", 54, 94);
eq(car.text, "^", "an escaped '^' is literal, so '^' is accepted");
type(car, "a", 65, 97);
eq(car.text, "^", "and the rest is rejected");

// ---- F. 空串 vs null ----
var empty:TextField = mkInput("", false);
type(empty, "a", 65, 97);
eq(empty.text, "", "restrict=\"\" rejects everything");
var none:TextField = mkInput(null, false);
type(none, "a", 65, 97);
eq(none.text, "a", "restrict=null lets everything through");

// ---- G. 只作用于用户输入：程序化赋值不经过滤 ----
var prog:TextField = mkInput("abc", false);
prog.text = "xyz9";
eq(prog.text, "xyz9", "a programmatic text assignment bypasses restrict entirely");
// 只断言 restrict 保证的部分：赋值本身不过滤，而**后续用户输入**照样过滤。
// （赋值后光标落在哪里是既有的文本模型问题，与 restrict 无关，故不在此断言。）
var beforeLen:int = prog.text.length;
type(prog, "c", 67, 99);
eq(prog.text.length, beforeLen + 1, "an allowed user char is still inserted into the assigned text");
type(prog, "e", 69, 101);
eq(prog.text.length, beforeLen + 1, "while a user char outside the set is still dropped");

// ---- H. 多字符载荷（粘贴走同一条 textInput 管道）：逐字符过滤 ----
var paste:TextField = mkInput("0-9\\-", false);
type(paste, "ab5", 0, 0);
eq(paste.text, "5", "a multi-char payload is filtered character by character");
var paste2:TextField = mkInput("A-Z", false);
type(paste2, "ab5", 0, 0);
eq(paste2.text, "AB", "and the case fallback applies per character too");

// ---- I. 换行绕过过滤（多行字段） ----
var ml:TextField = mkInput("0-9", true);
type(ml, "5", 53, 53);
// Return 只靠 keyDown 驱动：SDL2/Cocoa 从不为 Return 产生 SDL_TEXTINPUT（它的文本输入类
// 只实现 insertText:、没有 insertNewline:），所以生成代码在 keyDown(13) 上补一次提交。
// 这里**不**再补 dispatchText，正是为了钉住这条合成路径。
type(ml, "", 13, 13);
eq(ml.text, "5\r", "Return inserts a newline in a multiline field through the keyDown path alone");
eq(ml.multiline, true, "and the field really is multiline");
type(ml, "a", 65, 97);
eq(ml.text, "5\r", "the newline bypassed restrict while a plain char is still filtered");
type(ml, "7", 55, 55);
eq(ml.text, "5\r7", "and an allowed char still lands after it");
// 单行字段：Return 什么都不插（AIR 同理）。
var sl:TextField = mkInput("0-9", false);
type(sl, "5", 53, 53);
type(sl, "", 13, 13);
eq(sl.text, "5", "Return does nothing in a single-line field");

// ---- J. 全被丢弃的一次按键仍然吞掉选区（与 maxChars 同一条 splice 语义） ----
var sel:TextField = mkInput("^5", false);
sel.text = "xy";
sel.setSelection(1, 2);
changeCount = 0;
type(sel, "5", 53, 53);
eq(sel.text, "x", "a fully-rejected keystroke still consumes the selection");
eq(changeCount, 1, "and that deletion fires change");
sel.setSelection(0, 1);
changeCount = 0;
type(sel, "9", 57, 57);
eq(sel.text, "9", "an accepted keystroke replaces the selection");
eq(changeCount, 1, "with one change");

if (failCount == 0) trace("stage94m ok");