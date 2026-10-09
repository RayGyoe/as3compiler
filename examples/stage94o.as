// stage94o.as — 阶段九十四·十六：TextField.displayAsPassword 的圆点遮罩。
//
// 触发：TODO.md 遗留行的「`displayAsPassword` 只存不生效（渲染成圆点）」（阶段
// 九十四·七 主动登记、阶段九十四·十四 收窄——`restrict` 那半已完成）。全部按
// AGENTS.md §1.5 以 adl 51.4.1 实测为准（证据台 temp/editprobe/src/Ed16.as +
// drive_ed16.py；双端日志与真窗口截图 snap_ed16_{adl,aot}_*.png）。
//
// 关键实测口径（本示例逐条钉住）：
//   * 遮罩字符是 **`*`（星号）**，不是圆点。
//   * 遮罩**参与排版**：AIR 把「一个字符一个 `*`」的串交给排版器，`textWidth` /
//     `textHeight` / `numLines` / 点击落点 / 光标与选区的几何**全部按星号串度量**。
//     实测判据（比例字体才看得出来）：`_sans 12` 的 `"WWWWWWWWWW"` 明文 `textWidth`
//     是 113、加遮罩后 **46.5**，而同字体同字号的 `"iiiiiiiiii"` 加遮罩后**也是
//     46.5** —— 两个字段量的是**同一个** 10 星号串，不是各自的明文。
//   * `type='dynamic'` 的字段同样遮罩（截图实证）。
//   * 换行（CR/LF）**保留**：多行字段仍是两条视觉行（每行 20 个星号），所以遮罩
//     只换「可见字符」不换「断行」。
//   * `.text` 里存的始终是**明文**（键入/程序化赋值都一样），`.text.length` 不变。
//   * 遮罩字段**拒绝复制与剪切**：`Cmd+A` 仍能选中（SEL=0,3），但 `Cmd+C` 让剪贴板
//     保持**空**（对照的非遮罩字段复制出 `abcdefghij`）；`Cmd+X` 同样被拒——文本
//     原封不动、剪贴板仍空。
//   * 程序化 `text = ...` 赋值会把**光标与选区钳到新长度**（实测：光标在 7 时赋值
//     `"zz"`，读回 caretIndex **2**、selectionBegin/End **2,2**）。
//
// 本示例是**纯 C 回归**（无 Skia ⇒ 无排版器），故只能钉「AS3 可见」的那部分：
// 明文存储、长度不变、CR 仍是硬换行、遮罩开关不改文本、以及上面那条「赋值钳光标」。
// **排版层面的度量与遮罩渲染**在窗口 AOT（链接 Skia）里逐项核对，见证据台。
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

function mkInput(multiline:Boolean):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = 10; f.width = 300; f.height = multiline ? 60 : 30;
	f.defaultTextFormat = new TextFormat("_typewriter", 12, 0xE6E6E6);
	f.text = "";
	f.type = TextFieldType.INPUT;
	f.multiline = multiline;
	stage.addChild(f);
	return f;
}
// 与 stage94m 同一约定：真实后端由 SDL 产生 keyDown/textInput，这里用测试钩子把
// 同一串事件喂进同一条生成代码路径。
function type(f:TextField, s:String, keyCode:int, charCode:int):void {
	stage.focus = f;
	stage.dispatchKey("keyDown", keyCode, charCode, 0);
	stage.dispatchText(s);
}

// ---- A. 默认值与往返 ----
var f:TextField = new TextField();
eq(f.displayAsPassword, false, "displayAsPassword defaults to false");
f.displayAsPassword = true;
eq(f.displayAsPassword, true, "displayAsPassword round-trips");

// ---- B. 遮罩不改文本：明文存储、长度不变 ----
var a:TextField = mkInput(false);
a.displayAsPassword = true;
a.text = "abcdefghij";
eq(a.text, "abcdefghij", "the masked field still stores the plaintext");
eq(a.text.length, 10, "and .text.length is the plaintext length");
type(a, "X", 88, 88);
eq(a.text, "Xabcdefghij", "typing into a masked field inserts the RAW character");
eq(a.text.length, 11, "the inserted character counts towards .text.length too");
eq(a.caretIndex, 1, "and the caret sits after the inserted character");

// ---- C. 遮罩开关本身不改文本，也不改行结构 ----
var m:TextField = mkInput(true);
m.text = "ab\rcd";
var plainLines:int = m.numLines;
var plainHeight:Number = m.textHeight;
m.displayAsPassword = true;
eq(m.text, "ab\rcd", "turning the mask on leaves .text alone");
eq(m.numLines, plainLines, "CR is still a HARD break under the mask (line count unchanged)");
eq(m.textHeight, plainHeight, "and the text height is unchanged too (the break bytes survive)");
m.displayAsPassword = false;
eq(m.text, "ab\rcd", "turning it back off leaves .text alone as well");

// ---- D. 赋值把光标与选区钳到新长度（adl 实测口径）----
var c:TextField = mkInput(false);
c.displayAsPassword = true;
c.text = "0123456789";
c.setSelection(7, 7);
eq(c.caretIndex, 7, "caret placed at 7 for the clamp test");
c.text = "zz";
eq(c.text, "zz", "the shorter text is stored");
eq(c.caretIndex, 2, "text=... clamps the caret to the new length (not 0, not the stale 7)");
eq(c.selectionBeginIndex, 2, "selectionBeginIndex is clamped too");
eq(c.selectionEndIndex, 2, "selectionEndIndex is clamped too");
c.setSelection(1, 1);
c.text = "0123456789";
eq(c.caretIndex, 1, "a caret INSIDE the new length is left where it was");

// ---- E. 遮罩与 restrict 正交 ----
var r:TextField = mkInput(false);
r.displayAsPassword = true;
r.restrict = "0-9";
type(r, "5", 53, 53);
eq(r.text, "5", "restrict still filters typed characters while masked");
type(r, "a", 65, 97);
eq(r.text, "5", "and still drops them");
eq(r.displayAsPassword, true, "the mask flag is untouched by the typing path");

// ---- F. 多行遮罩字段的行/光标一致性 ----
var ml:TextField = mkInput(true);
ml.text = "0123456789\rAB\rcdefghijklmnop";
ml.displayAsPassword = true;
eq(ml.numLines, 3, "three CR lines stay three lines while masked");
eq(ml.text.length, 28, "the plaintext length is what .text reports");
ml.setSelection(4, 4);
stage.focus = ml;
stage.dispatchKey("keyDown", 40, 0, 0);   // Down: onto the 2-char line, column clamps
eq(ml.caretIndex, 13, "vertical movement still works on the masked field (column clamps)");
stage.dispatchKey("keyDown", 40, 0, 0);   // Down again: the goal column comes back
eq(ml.caretIndex, 18, "and the remembered column resumes on the next long line (14 + 4)");

if (failCount == 0) {
	trace("stage94o ok");
} else {
	trace("stage94o FAILED: " + failCount);
}