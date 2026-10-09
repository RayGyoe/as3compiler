// stage94p.as — 阶段九十四·十七：输入法合成中态（marked text）建模。
//
// 触发：TODO.md 遗留行的「输入法（IME）的合成中态（marked text）无建模」（阶段
// 九十四·七 实测登记）。按 AGENTS.md §1.5 先做 adl 实测（证据台
// temp/editprobe/src/Ed17.as + drive_ed17.py），但**本机无法把真实输入法接到
// adl 上**（三处硬边界，见下），所以「合成期 AIR 的 `.text` 到底含不含合成串」
// 这一条**没有实测口径**，本阶段的选择与理由写在这里，并留了遗留行。
//
// adl 51.4.1 实测（Ed17，F1..F9 命令通道）——
//   * `IME.isSupported` = **true**，`IME.enabled` 初值 **true** 且可写（false→false，
//     写回 true 生效），`IME.conversionMode` = **"UNKNOWN"**。
//   * `IME.setCompositionString("nihao")` / `IME.doConversion()` /
//     `IME.compositionSelectionChanged(1,3)` 一律抛
//     **Error #2063**（`name="Error"`、`errorID=2063`、`message="Error #2063: Error
//     attempting to execute IME command."`、`is TypeError == false`）。
//   * `IME.compositionAbandoned()` **不抛**（no-op）。
//   * `IME.setConversionMode(...)` 抛 **Error #1006**（`name="TypeError"`、
//     `errorID=1006`，文案 `setConversionMode is not a function`）——即 macOS 上这个
//     方法**根本不存在**。
//   * `IMEConversionMode` 只有 **8** 个常量（值等于名字）：ALPHANUMERIC_FULL /
//     ALPHANUMERIC_HALF / CHINESE / JAPANESE_HIRAGANA / JAPANESE_KATAKANA_FULL /
//     JAPANESE_KATAKANA_HALF / KOREAN / UNKNOWN；已废弃的 FULL_WIDTH / HALF_WIDTH /
//     JAPANESE_KATAKANA / TO_FULL_WIDTH / TO_HALF_WIDTH / JAPANESE_KATAKANA_HIRAGANA
//     **读回 undefined**（mxmlc 也拒绝静态引用 TO_HALF_WIDTH ⇒ 确实不在 AIR 51 里）。
//   * **mxmlc 拒绝静态引用**这些成员（`IME.setConversionMode` / `IMEConversionMode.
//     TO_HALF_WIDTH` / `IME.addEventListener` 都报「可能未定义」）⇒ AS3 侧只能经
//     **动态引用**触达，TextField 路径上唯一可观测的口径就是**提交时的 TEXT_INPUT**，
//     与 AIR 文档一致（未设 `imeClient` 时运行时用 out-of-line 合成，把最终结果作为
//     `TextEvent.TEXT_INPUT` 送出）。
//
// 因此本阶段的实现口径（**已言明为选择而非实测**）：
//   * **合成串是「预览」，不是文本**：`SDL_TEXTEDITING` 的 marked text 存在字段的
//     预览槽里，`.text` / `caretIndex` / 选区 / 行数 / `textWidth` **一概不动**，
//     也不派发 change；绘制层在**光标处**画出合成串并加 1px 下划线。
//   * **提交走既有 textInput 通路**（`SDL_TEXTINPUT` → `TextEvent.TEXT_INPUT`）：
//     提交前先丢掉预览，所以「取消合成」（平台送空 marked text）不会留下残留下划线，
//     而 `restrict` 过滤、change 派发、光标推进全部沿用已实测的那条路径。
//   * 平台送**空** marked text = 合成结束（提交或取消），预览随之清除。
//   * 合成串的光标矩形会经 `SDL_SetTextInputRect` 交给平台，让候选窗贴住光标。
//   * 只有**可输入**字段（`as_tf_is_input`）参与合成；无焦点 / 动态字段一律 no-op。
//
// 本示例是**纯 C 回归**（无 Skia ⇒ 无排版器，也不该有真实输入法），故只钉
// 「AS3 可见」的那部分：预览不改任何 AS3 可见状态、提交恰好插一次、取消/无焦点/
// 动态字段 no-op。渲染（光标处合成串 + 下划线）与候选窗矩形在窗口 AOT 里核对，
// 见证据台 temp/editprobe/ 与本阶段 TODO 记录。
import flash.display.*;
import flash.events.*;
import flash.text.*;

var failCount:int = 0;
var nChanges:int = 0;
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
	f.defaultTextFormat = new TextFormat("_typewriter", 12, 0x000000);
	f.text = "";
	f.type = TextFieldType.INPUT;
	f.multiline = multiline;
	stage.addChild(f);
	return f;
}
function type(f:TextField, s:String, keyCode:int, charCode:int):void {
	stage.focus = f;
	stage.dispatchKey("keyDown", keyCode, charCode, 0);
	stage.dispatchText(s);
}

// ---- A. 合成是预览：不动 .text / 光标 / 选区 / 行结构，也不派 change ----
var a:TextField = mkInput(false);
a.addEventListener(Event.CHANGE, function(e:Event):void { nChanges++; });
a.text = "ab";
a.setSelection(1, 2);
var changes:int = nChanges;
stage.dispatchTextEditing("nihao");
eq(a.text, "ab", "a composition leaves .text alone (the marked text is a preview)");
eq(a.caretIndex, 2, "and the caret stays put");
eq(a.selectionBeginIndex, 1, "and the selection anchor stays put");
eq(a.selectionEndIndex, 2, "and the selection end stays put");
eq(nChanges, changes, "and no change is dispatched while composing");
eq(a.numLines, 1, "and the line structure is untouched");

// 长的合成串同样只是预览：不改行数、不改 textWidth。
var w:TextField = mkInput(true);
w.wordWrap = true;
w.text = "hello";
var wLines:int = w.numLines;
var wWidth:Number = w.textWidth;
stage.focus = w;
w.setSelection(5, 5);            // caret at the end of "hello"
stage.dispatchTextEditing("nihaoshijiezhongguoren", 3, 4);
eq(w.text, "hello", "a long composition is still only a preview");
eq(w.numLines, wLines, "and it does not add lines");
eq(w.textWidth, wWidth, "and it does not change textWidth");
eq(w.caretIndex, 5, "and the caret is where the next commit will land");

// ---- B. 提交：恰好插一次，change 恰好一次，光标推到末尾 ----
stage.focus = a;
stage.dispatchTextEditing("nihao");
var beforeCommit:int = nChanges;
stage.dispatchText("\u4f60\u597d");           // the platform's commit
eq(a.text, "a\u4f60\u597d", "the commit replaces the preview at the caret");
eq(nChanges, beforeCommit + 1, "the commit dispatches change exactly once");
// NOTE: our caret/selection indices are BYTE offsets (the documented UTF-8
// divergence), so "a" + a 6-byte commit puts the caret at 7, not at the 3 UTF-16
// code units AIR would report.
eq(a.caretIndex, 7, "and the caret lands after the committed text");
// 合成已被丢弃：紧接着的普通文本仍然正常插入（不是粘在预览后面）。
stage.dispatchText("!");
eq(a.text, "a\u4f60\u597d!", "a later keystroke inserts normally (the preview is gone)");

// ---- C. 取消合成（平台送空 marked text）= no-op ----
var c:TextField = mkInput(false);
c.text = "xy";
stage.focus = c;
c.setSelection(2, 2);            // caret at the end of "xy"
stage.dispatchTextEditing("wo");
stage.dispatchTextEditing("");
eq(c.text, "xy", "cancelling a composition changes nothing");
eq(c.caretIndex, 2, "and leaves the caret alone");
stage.dispatchText("z");
eq(c.text, "xyz", "and the next keystroke inserts normally");

// ---- D. 无焦点 / 动态字段：一律 no-op，且不崩 ----
var d:TextField = mkInput(false);
d.text = "keep";
stage.focus = null;
stage.dispatchTextEditing("nihao");
eq(d.text, "keep", "a composition with no focused field is a no-op");
stage.dispatchTextEditing("", -1, 0);
eq(d.text, "keep", "and an empty one with no focus is a no-op too");

var dyn:TextField = new TextField();
dyn.text = "static";
dyn.type = TextFieldType.DYNAMIC;   // not an input field
stage.addChild(dyn);
stage.focus = dyn;
stage.dispatchTextEditing("nihao");
eq(dyn.text, "static", "a composition on a non-input field is a no-op");

// ---- E. restrict 仍然管提交（预览不过滤），被拒的提交不留残留 ----
var r:TextField = mkInput(false);
r.restrict = "a-z";
r.text = "abc";
stage.focus = r;
r.setSelection(0, 3);
stage.dispatchTextEditing("shu");
eq(r.text, "abc", "the preview bypasses restrict (it is not text yet)");
stage.dispatchText("5");            // rejected by restrict: nothing is inserted
// The selection is still consumed (measured in 阶段九十四·十四: a rejected keystroke
// over a selection leaves the text SHORTER), so "abc" is replaced by the empty
// filtered result.
eq(r.text, "", "a rejected commit inserts nothing (and consumes the selection)");
eq(r.caretIndex, 0, "and the caret sits at the selection start");
stage.dispatchTextEditing("z");     // a later composition is unaffected
stage.dispatchText("z");
eq(r.text, "z", "and a later commit inserts normally");

// ---- F. 焦点搬家不会把预览变成文本 ----
var f1:TextField = mkInput(false);
var f2:TextField = mkInput(true);
f1.text = "one";
stage.focus = f1;
stage.dispatchTextEditing("ni");
stage.focus = f2;
eq(f1.text, "one", "moving focus away does not commit the preview");
eq(f2.text, "", "and the new field does not inherit it");
stage.dispatchText("o");
eq(f2.text, "o", "the new field types normally");
eq(f1.text, "one", "and the abandoned field keeps its own text");

if (failCount == 0) trace("stage94p ok");
else trace("stage94p FAILED: " + failCount);