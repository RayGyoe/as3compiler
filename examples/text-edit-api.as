// text-edit-api.as — TextField 的替换/选择 API 与「赋 .text 重置光标」（阶段三百三十七）
//
// 三条口径全部按 adl 51.4.1 双端实测（`temp/maxsh/` 的 Main6/Main7/Main8/Main9.as）：
//
//   ① `replaceText(b, e, s)` / `replaceSelectedText(s)` **不动**选区与光标：
//        sel [1,2) + replaceSelectedText("XY") → "aXYc"，sel 仍 [1,2)，caret 2
//        sel [2,4) + replaceSelectedText("")   → "Qac"， sel 被钳成 [2,3)（文本变短）
//        sel [4,5) + replaceText(2,3,"ZZ")     → "abZZdef"，sel 仍 [4,5)
//   ② 赋 `.text` 一律把选区与光标**重置为 0**（同串、更长、更短、空串、INPUT 字段都是 0,0），
//      不是「钳到新长度」。
//   ③ `setSelection(0, 0)` 与其它写法一样收缩到 0——阶段九十四 曾记成「空操作」，
//      阶段三百三十七 用六种前态复测后证伪（见 TextField_setSelection 的注释）。
//
// 与字体无关，两种构建（Skia / 纯 C 桩）断言完全相同。

function eq(actual:Object, expected:Object, what:String):void {
  if (actual != expected) throw new Error(what + ": expected " + expected + ", got " + actual);
}

// --- ① replaceText：区间替换、选区不动 ---------------------------------------
var t:TextField = new TextField();
t.text = "abcdef";
t.setSelection(4, 5);
t.replaceText(2, 3, "ZZ");
eq(t.text, "abZZdef", "replaceText splices [2,3)");
eq(t.selectionBeginIndex, 4, "replaceText leaves the selection begin");
eq(t.selectionEndIndex, 5, "replaceText leaves the selection end");
eq(t.caretIndex, 5, "replaceText leaves the caret");

// 参数口径（adl 51.4.1，temp/maxsh/MainA.as / MainB.as）：
//   反向区间与负下标是**静默无操作**，越界端点**钳到文本长度**（可以借此追加）。
t.setSelection(0, 0);
t.replaceText(3, 1, "Q");
eq(t.text, "abZZdef", "an inverted range is a silent no-op");
t.replaceText(-5, -1, "R");
eq(t.text, "abZZdef", "negative indices are a silent no-op");
t.replaceText(t.text.length, 999, "!");
eq(t.text, "abZZdef!", "an out-of-range end clamps to the text length");
t.replaceText(999, 1000, "?");
eq(t.text, "abZZdef!?", "a begin past the text appends at the end");

// null 文本不是「空串」：AIR 抛 TypeError #2007。
var nulled:int = 0;
try { t.replaceText(1, 2, null); } catch (e0:Error) { nulled = e0.errorID; }
eq(nulled, 2007, "replaceText(..., null) throws #2007");

// --- ② replaceSelectedText：替换选区，选区不动 / 只钳长度 ---------------------
var r:TextField = new TextField();
r.text = "abc";
r.setSelection(1, 2);
r.replaceSelectedText("XY");
eq(r.text, "aXYc", "replaceSelectedText replaces [1,2)");
eq(r.selectionBeginIndex, 1, "the selection begin survives the insert");
eq(r.selectionEndIndex, 2, "the selection end survives the insert");
eq(r.caretIndex, 2, "the caret survives the insert");

var cut:TextField = new TextField();
cut.text = "abcdef";
cut.setSelection(2, 4);
cut.replaceSelectedText("");
eq(cut.text, "abef", "an empty replacement deletes the range");
eq(cut.selectionBeginIndex, 2, "the selection begin is kept");
eq(cut.selectionEndIndex, 4, "the selection end stays at 4 when the text still has 4 bytes");

var shrunk:TextField = new TextField();
shrunk.text = "abcdef";
shrunk.setSelection(4, 6);
shrunk.replaceSelectedText("");
eq(shrunk.text, "abcd", "deleting the tail shortens the text");
eq(shrunk.selectionBeginIndex, 4, "begin clamps to the new length");
eq(shrunk.selectionEndIndex, 4, "end clamps to the new length");

// --- ③ 赋 .text 重置选区与光标 ----------------------------------------------
var reset:TextField = new TextField();
reset.text = "abcdef";
reset.setSelection(2, 4);
eq(reset.caretIndex, 4, "selection before the reassignment");
reset.text = "abcdefgh";                       // 更长：仍然回到 0
eq(reset.selectionBeginIndex, 0, "a longer .text resets the selection begin");
eq(reset.selectionEndIndex, 0, "a longer .text resets the selection end");
eq(reset.caretIndex, 0, "a longer .text resets the caret");
reset.setSelection(3, 3);
reset.text = "abcdefgh";                       // 同串：同样回到 0
eq(reset.caretIndex, 0, "even the same .text resets the caret");

// --- ④ setSelection(0, 0) 就是收缩 ------------------------------------------
var col:TextField = new TextField();
col.text = "hello world";
col.setSelection(3, 9);
col.setSelection(0, 0);
eq(col.selectionBeginIndex, 0, "setSelection(0,0) collapses begin");
eq(col.selectionEndIndex, 0, "setSelection(0,0) collapses end");
eq(col.caretIndex, 0, "setSelection(0,0) moves the caret");

trace("text-edit-api: replaceText/replaceSelectedText/selection OK");