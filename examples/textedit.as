// textedit.as — 阶段一百三十五：可编辑 TextField 的输入口径（本轮先钉 Return 的 textInput 载荷）。
//
// 触发：TODO.md 遗留行「多行 `Return` 的 `textInput` **载荷**是 `"\r"`（`adl` 是 `"\n"`）」（L8155）。
//
// adl 51.4.1 实测口径（本示例逐条钉住）：
//   * 多行可编辑字段按 Return ⇒ `keyDown` 可派发 → `textInput`，**载荷是 `"\n"`**（LF），
//     而字段自己的 `.text` 里**插入的是 CR**（实测文本 `5\r\r7`）；随后发 `change`。
//     即「一次 Return = 一个事件、两个不同字符串」。
//   * 单行字段没有这条合成路径（`Return` 只派发 `keyDown`，不产生文本）。
//
// 触发方式：真实后端里 keyDown 由 SDL 产生，这里用 `Stage.dispatchKey` /
// `Stage.dispatchText` 两个测试钩子把同一串事件喂进**同一条生成代码路径**（与
// stage94l/m/n/o 的约定一致）。mod 位：1=ctrl 2=alt 4=shift 8=cmd。
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

var lastText:String = null;
var textInputCount:int = 0;
var changeCount:int = 0;
stage.addEventListener("textInput", function(ev:TextEvent):void { lastText = ev.text; textInputCount++; });
stage.addEventListener("change", function(ev:Event):void { changeCount++; });

function mkField(multiline:Boolean):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = 10; f.width = 200; f.height = 60;
	f.defaultTextFormat = new TextFormat("_typewriter", 12, 0xE6E6E6);
	f.text = "";
	f.type = TextFieldType.INPUT;
	f.multiline = multiline;
	stage.addChild(f);
	return f;
}
// 一次按键：keyDown（可派发）→（后端合成）textInput → 插入 → change。
function key(f:TextField, code:int):void {
	stage.focus = f;
	stage.dispatchKey("keyDown", code, 0, 0);
	stage.dispatchKey("keyUp", code, 0, 0);
}
// 一次文本提交（真实后端由 SDL_TEXTINPUT 产生）。
function typeText(f:TextField, s:String):void {
	stage.focus = f;
	stage.dispatchText(s);
}

// ---- A. 多行字段：Return 的载荷是 LF，插入的是 CR ----
var m:TextField = mkField(true);
typeText(m, "5");
lastText = null;
changeCount = 0;
key(m, 13);
eq(lastText, "\n", "a multiline Return dispatches textInput with \"\\n\" (adl)");
eq(m.text, "5\r", "and inserts a CR into the text");
eq(changeCount, 1, "the Return fires change");
eq(textInputCount, 2, "the Return really went through the textInput pipeline (2 events so far)");

key(m, 13);
eq(lastText, "\n", "the payload stays \"\\n\" on the next Return too");
typeText(m, "7");
// 与 adl 探针逐字相同的观测文本（阶段九十四·十四 实测）。
eq(m.text, "5\r\r7", "the text matches adl byte for byte (5 CR CR 7)");
eq(m.text.length, 4, "which is four code units here as well (CR is one byte)");

// ---- B. 单行字段：Return 不产生文本，也不发 textInput ----
var s1:TextField = mkField(false);
s1.text = "ab";
lastText = null;
textInputCount = 0;
changeCount = 0;
key(s1, 13);
eq(s1.text, "ab", "a single-line Return inserts nothing");
eq(textInputCount, 0, "and dispatches no textInput");
eq(changeCount, 0, "and fires no change");

// ---- C. 返回载荷可被 preventDefault 取消（与其它文本提交同一条管道）----
var c:TextField = mkField(true);
c.text = "x";
stage.addEventListener("textInput", function(ev:TextEvent):void { if (ev.text == "\n") ev.preventDefault(); });
key(c, 13);
eq(c.text, "x", "a cancelled Return inserts nothing");
eq(c.text.indexOf("\r"), -1, "no CR either");

if (failCount == 0) trace("stage135 textedit: all checks passed");
else throw new Error(failCount + " check(s) failed");
