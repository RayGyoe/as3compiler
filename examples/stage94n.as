// stage94n.as — 阶段九十四·十五：PageUp/PageDown 与 wordWrap 的**视觉行**上下移动。
//
// 触发：TODO.md 遗留行的「`PageUp`/`PageDown` 只派发不改动」与「多行换行的 Up/Down
// X 列」（阶段九十四·七 主动登记）。全部按 AGENTS.md §1.5 以 adl 51.4.1 实测为准
// （证据台 temp/editprobe/src/Ed15.as + drive_ed15.py 第 1、2 轮，日志 adl_ed15.txt /
// adl_ed15b.txt；AOT 侧 aot_ed15b.txt 同序列对照）。
//
// 关键实测口径（本示例逐条钉住）：
//   * 上下的单位是**视觉行**（软换行也算一行），不是 CR 分隔的硬行。光标列在短行上
//     被钳到行尾，但**列位被记住**：再往下走到长行会回到原列。
//   * `PageUp`/`PageDown` 按**可见行数**移动、同样保留列位；越过首行钳到下标 `0`，
//     越过末行钳到**文本尾**（`text.length`）。箭头在首/末行**原地不动**（不钳）。
//   * 单行字段：箭头不动，但翻页键**会**动（`0` ↔ `text.length`），因为它的钳位对象
//     是文本两端而非相邻行。
//   * `Shift` + 上下/翻页 = 扩选（锚点留原处）。
//   * `scrollV` 跟随光标：向下移动后光标行成为视口**顶行**（`SV = line + 1`），向上
//     移动后成为**底行**（`SV = line - visible + 2`）；纯箭头只在光标要离开视口时才
//     滚动。全部钳在 `[1, maxScrollV]`。
//   * 翻页键不改文本，因此**不发 `change`**。
//
// 度量说明：`scrollV`/可见行数依赖行高，而我们的 `_typewriter` 命中字体比 AIR 的窄
// 高比不同（TODO.md 遗留行「字体度量偏小」）——纯 C 构建下桩行高 `size × 1.2` 恰好
// 等于 AIR 的 15/12 比值，故本示例（纯 C 回归）逐值等于 adl 实测值。Skia 构建下可见
// 行数会随真实行高变化，断言只钉不变式（见 G 段）。
import flash.display.*;
import flash.events.*;
import flash.text.*;

function hteq2(f:TextField, v:int, msg:String):void { eq(f.caretIndex, v, msg); }
var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}
function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) { failCount++; trace("FAIL: " + msg + " (got " + actual + ", want " + expected + ")"); }
}

var stage:Stage = new Stage();

// 6 条硬行，长度 10 / 2 / 14 / 1 / 9 / 1 → 行首偏移 0, 11, 14, 29, 31, 41，LEN = 42。
// 与 adl 探针 Ed15 的 h1 逐字相同，实测值可直接对照。
var H1:String = "0123456789" + "\r" + "AB" + "\r" + "cdefghijklmnop" + "\r" + "Q" + "\r" + "RSTUVWXYZ" + "\r" + "!";

function mkField(w:int, h:int, multiline:Boolean, wrap:Boolean):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = 10; f.width = w; f.height = h;
	f.defaultTextFormat = new TextFormat("_typewriter", 12, 0xE6E6E6);
	f.text = "";
	f.type = TextFieldType.INPUT;
	f.multiline = multiline;
	f.wordWrap = wrap;
	stage.addChild(f);
	return f;
}
// 真实后端由 SDL 产生 keyDown；这里用 Stage.dispatchKey 测试钩子把同一串事件喂进
// 同一条生成代码路径（与 stage94l/m 的约定一致）。mod 位：1=ctrl 2=alt 4=shift 8=cmd。
var SHIFT:int = 4;
function key(f:TextField, code:int, mod:int):void {
	stage.focus = f;
	stage.dispatchKey("keyDown", code, 0, mod);
	stage.dispatchKey("keyUp", code, 0, mod);
}
var changeCount:int = 0;
stage.addEventListener("change", function(ev:Event):void { changeCount++; });

// ---- A. 多行字段的视觉行结构（CR 是硬换行）----
var h:TextField = mkField(300, 36, true, false);
h.text = H1;
eq(h.text.length, 42, "the six-line probe text is 42 bytes");
eq(h.numLines, 6, "six CR-separated lines are six visual lines");
// 可见行数 = floor(36 / 行高) = 2（纯 C 桩行高 = 12 × 1.2 = 14.4）⇒ maxScrollV = 6-2+1 = 5。
eq(h.maxScrollV, 5, "a 36px box over 6 lines scrolls through 5 positions");

// ---- B. PageDown / PageUp 的整段实测序列 ----
h.setSelection(0, 0);
eq(h.caretIndex, 0, "caret starts at the text start");
key(h, 34, 0);                       // PageDown
eq(h.caretIndex, 14, "PageDown lands on the first line of the new page (col 0)");
eq(h.scrollV, 3, "PageDown puts the caret line at the top of the view");
key(h, 34, 0);
eq(h.caretIndex, 31, "PageDown again: line 4 start");
eq(h.scrollV, 5, "scrollV keeps following the caret");
key(h, 34, 0);
eq(h.caretIndex, 42, "PageDown past the last line clamps to the END of the text");
eq(h.scrollV, 5, "scrollV clamps at maxScrollV");
key(h, 33, 0);                       // PageUp
eq(h.caretIndex, 30, "PageUp lands on the last line of the new page, column kept (col 1)");
eq(h.scrollV, 3, "PageUp puts the caret line at the bottom of the view");
key(h, 33, 0);
eq(h.caretIndex, 12, "PageUp again: line 1 start + the kept column");
eq(h.scrollV, 1, "scrollV stops at 1");
key(h, 33, 0);
eq(h.caretIndex, 0, "PageUp above the first line clamps to index 0");
eq(h.scrollV, 1, "and leaves scrollV at 1");

// ---- C. 列位保留（翻页同样保留）----
h.setSelection(4, 4);                // 行 0 第 4 列
key(h, 34, 0);
eq(h.caretIndex, 18, "PageDown keeps the column (14 + 4)");
key(h, 34, 0);
eq(h.caretIndex, 35, "PageDown again keeps it on line 4 (31 + 4)");

// ---- D. 短行钳位 + 列位记忆（箭头）----
// setSelection(0, 0) 在 adl 上是**no-op**（实测口径，见 TextField_setSelection），所以
// 这里用 Home/End 把光标放到文本两端。
h.setSelection(9, 9);                // 行 0 第 9 列
key(h, 40, 0);                       // Down
hteq2(h, 13, "Down onto the 2-char line clamps the caret to its end");
key(h, 40, 0);
hteq2(h, 23, "Down again resumes the remembered column on a long line (14 + 9)");
key(h, 40, 0);
hteq2(h, 30, "a one-character line clamps to its end index (never onto the CR)");
key(h, 40, 0);
hteq2(h, 40, "and the column is still remembered on the 9-char line");
key(h, 38, 0);                       // Up
hteq2(h, 30, "Up walks back onto the one-character line");
key(h, 38, 0);
hteq2(h, 23, "Up keeps the remembered column");
key(h, 38, 0);
hteq2(h, 13, "Up onto the 2-char line clamps again");
key(h, 38, 0);
hteq2(h, 9, "Up onto the first line resumes the remembered column");
key(h, 38, 0);
hteq2(h, 9, "Up on the first line does not move at all");
key(h, 36, 0);                       // Home
hteq2(h, 0, "Home still goes to the start of the TEXT in a multiline field");
key(h, 38, 0);
hteq2(h, 0, "Up at index 0 is a no-op");
h.setSelection(42, 42);
key(h, 40, 0);
hteq2(h, 42, "Down on the last line does not move either");

// ---- E. 翻页键的触顶/触底钳位不受 scrollV 影响 ----
h.scrollV = 1;
h.setSelection(42, 42);
key(h, 34, 0);
eq(h.caretIndex, 42, "PageDown at the text end keeps the caret there");
eq(h.scrollV, 5, "scrollV still follows the caret line (clamped to maxScrollV)");
changeCount = 0;
key(h, 33, 0);
key(h, 34, 0);
eq(changeCount, 0, "the page keys never change the text, so change never fires");

// ---- F. Shift + 翻页 = 扩选 ----
key(h, 35, 0);                       // End → 42
key(h, 33, SHIFT);
eq(h.caretIndex, 30, "Shift+PageUp moves the caret like PageUp");
eq(h.selectionBeginIndex, 30, "and extends the selection from the anchor");
eq(h.selectionEndIndex, 42, "up to the old caret");
key(h, 36, 0);                       // Home → 0
key(h, 34, SHIFT);
eq(h.caretIndex, 14, "Shift+PageDown moves the caret like PageDown");
eq(h.selectionBeginIndex, 0, "the anchor stays where it was");
eq(h.selectionEndIndex, 14, "and the selection grows to the new caret");
key(h, 36, 0);                       // Home → 0
key(h, 40, SHIFT);
eq(h.selectionBeginIndex, 0, "Shift+Down extends by one visual line too");
eq(h.selectionEndIndex, 11, "onto the next line's start");

// ---- G. 单行字段：箭头不动、翻页钳到文本两端 ----
var s:TextField = mkField(300, 30, false, false);
s.text = "single line here";         // len 16
eq(s.numLines, 1, "a single-line field is one line");
key(s, 36, 0);                       // Home → 0
hteq2(s, 0, "caret at the text start");
key(s, 40, 0);
hteq2(s, 0, "Down does nothing in a single-line field ... ");
key(s, 35, 0);                       // End → 16
key(s, 38, 0);
hteq2(s, 16, "... and so does Up");
key(s, 36, 0);
key(s, 34, 0);
hteq2(s, 16, "PageDown in a single-line field clamps to the text end");
eq(s.scrollV, 1, "a single-line field cannot scroll");
key(s, 33, 0);
hteq2(s, 0, "PageUp clamps back to index 0");

// ---- H. wordWrap：上下按视觉行走（只钉两种构建都成立的形状）----
// 文本自带 CR，所以纯 C（无软换行）下也是多行；Skia 下每个 20 字词还会各自软换行，
// 故这里只断言方向与连续性，不断言具体行号。
var w:TextField = mkField(120, 60, true, true);
w.text = "aaaaaaaaaaaaaaaaaaaa" + "\r" + "bbbbbbbbbbbbbbbbbbbb" + "\r" + "cccccccccccccccccccc";
key(w, 36, 0);
key(w, 40, 0);
check(w.caretIndex > 0, "Down moves the caret forward in a wrapped field");
var deepDown:int = w.caretIndex;
var i:int = 0;
while (i < 8) { key(w, 38, 0); i++; }
eq(w.caretIndex, 0, "enough Ups reach index 0");
key(w, 38, 0);
eq(w.caretIndex, 0, "Up at the first visual line is a no-op");
key(w, 35, 0);                       // End
key(w, 40, 0);
eq(w.caretIndex, w.text.length, "Down on the last visual line is a no-op");
key(w, 36, 0);
key(w, 34, 0);
check(w.caretIndex > deepDown, "PageDown covers more lines than a single Down");
var pageDown:int = w.caretIndex;
key(w, 33, 0);
check(w.caretIndex < pageDown, "PageUp moves the caret back up the same page");

if (failCount == 0) {
	trace("stage94n ok");
} else {
	trace("stage94n FAILED: " + failCount);
}