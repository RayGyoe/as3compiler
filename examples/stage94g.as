// stage94g.as — 阶段九十四·七（C 批·C2）：可编辑 TextField 与键盘/文本输入事件的 AIR 保真。
//
// 证据来自 temp/editprobe/ 的 adl ↔ AOT 双端对照台（探针应用 src/Ed2.as…Ed4.as +
// drive_*.py，全部 adl 51.4.1；结论表见该目录 README.md）。这一阶段把「键入一个字符」
// 拆成 AIR 真实的四段时序，并补齐编辑键、剪贴板加速键与 TextFieldType/TextEvent：
//
//   keyDown(cancelable) → preventDefault 抑制本次文本 → textInput(cancelable,冒泡,
//   **插入之前**) → 按 maxChars 截断后插入、光标落在插入串之后 → change
//
// 凡本示例能headless断言的部分（常量、默认值、选区模型、TextEvent 载荷、
// dispatchEvent 返回值=是否被取消）都在这里钉住；只能靠窗口驱动的部分（真实敲键、
// 双击选词、Cmd+X/V）由 temp/editprobe/ 的双端对照负责，缺口登记在 TODO.md。
import flash.display.Sprite;
import flash.events.Event;
import flash.events.EventDispatcher;
import flash.events.TextEvent;
import flash.text.TextField;
import flash.text.TextFieldType;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) throw new Error("FAIL: " + msg + " (got " + actual + ", want " + expected + ")");
}

// ---- 1. TextFieldType 常量（adl 实测） -----------------------------------
eq(TextFieldType.INPUT, "input", "TextFieldType.INPUT");
eq(TextFieldType.DYNAMIC, "dynamic", "TextFieldType.DYNAMIC");

// ---- 2. new TextField() 的默认值（adl 逐项实测，见 src/Def.as） -----------
// 注意 type 默认是 dynamic（不是 input）、tabEnabled 默认是 **false**：
// 之前把 tabEnabled 默认写成 true 是误读——探针 f1 的 true 来自它自己设了
// type = TextFieldType.INPUT（AIR 只在 type 真的变化时联动 tabEnabled）。
var f:TextField = new TextField();
eq(f.type, "dynamic", "default type");
eq(f.type, TextFieldType.DYNAMIC, "default type equals DYNAMIC");
eq(f.maxChars, 0, "default maxChars is unlimited");
eq(f.displayAsPassword, false, "default displayAsPassword");
// restrict 未设时是 AS3 的 **null**（不是空串）。字符串字段读到 C NULL 时由
// `as_v_str` 归一到 null 字面量（与 as_v_obj/as_v_arr/as_v_fn 同约定；adl 51.4.1
// 实测 `new TextField().restrict == null` 为 **true**）。
eq("" + f.restrict, "null", "default restrict prints as null (unset)");
check(f.restrict == null, "default restrict IS null, not a String with a NULL pointer");
check(!(f.restrict == ""), "null string field is not equal to the empty string");
eq(f.tabEnabled, false, "default tabEnabled (dynamic field is not tab-focusable)");
eq(f.tabIndex, -1, "default tabIndex");
eq(f.selectable, true, "default selectable");
eq(f.multiline, false, "default multiline");
eq(f.wordWrap, false, "default wordWrap");
eq(f.doubleClickEnabled, false, "default doubleClickEnabled");
eq(f.autoSize, "none", "default autoSize");
eq(f.background, false, "default background");
eq(f.textColor, 0, "default textColor");
eq(f.scrollV, 1, "default scrollV");
eq(f.text, "", "default text is empty string (never null)");
eq(f.text.length, 0, "default text length");
eq(f.caretIndex, 0, "default caretIndex");
eq(f.selectionBeginIndex, 0, "default selectionBeginIndex");
eq(f.selectionEndIndex, 0, "default selectionEndIndex");
eq(f.width, 100, "default width");
eq(f.height, 100, "default height");
eq(f.mouseEnabled, true, "default mouseEnabled");

// 舞台侧（tabChildren/tabEnabled）不在这里断言：`examples/` 的回归是无窗口运行，
// 脱离显示列表的字段 `stage == null`（与 AIR 一致），再往下取属性会碰到
// 「空对象属性访问」这个尚未实现的行为（AIR 抛 TypeError #1009，本子集是空指针
// 解引用）——已登记在 TODO.md。舞台默认值由 temp/editprobe/ 的窗口探针实测覆盖。

// ---- 3. type 是可读写的 String，切换不影响文本；且有实测到的 tabEnabled 联动 ----
// AIR 的 type setter 有一个 getter 看不出的副作用（adl 51.4.1 实测，
// temp/editprobe/src/Def2.as 四步）：**值真的变化**时 tabEnabled 跟到
// (type == "input")；把同一个值再赋一次**不动**手改过的 tabEnabled。
// 本子集把 type 保留为字段（读是普通 load），只把写挂到 setter 上承载这个联动。
var g:TextField = new TextField();
g.text = "abc";
eq(g.type, "dynamic", "g starts dynamic");
eq(g.tabEnabled, false, "A: dynamic field starts non-tabbable");
g.type = TextFieldType.INPUT;
eq(g.type, "input", "g becomes input");
eq(g.tabEnabled, true, "B: switching to input flips tabEnabled on");
eq(g.text, "abc", "switching to input keeps the text");
g.type = TextFieldType.DYNAMIC;
eq(g.type, "dynamic", "g becomes dynamic again");
eq(g.tabEnabled, false, "C: switching back flips tabEnabled off");
eq(g.text, "abc", "switching back to dynamic keeps the text");
// D：同值重赋不覆盖手工设置的值（先切到 input 让联动置 true，再手工 false）。
g.type = TextFieldType.INPUT;
g.tabEnabled = false;
g.type = TextFieldType.INPUT;
eq(g.type, "input", "D: re-assigning the same value");
eq(g.tabEnabled, false, "D: re-assigning the SAME type leaves tabEnabled alone");
// type 是 String，可以直接赋字符串字面量（AIR 接受任意字符串，只比较是否等于 INPUT）。
g.type = "input";
eq(g.type, "input", "type accepts a plain string");

// ---- 4. maxChars 读写 ----------------------------------------------------
var h:TextField = new TextField();
h.maxChars = 5;
eq(h.maxChars, 5, "maxChars round-trip");
h.maxChars = 0;
eq(h.maxChars, 0, "maxChars 0 means unlimited");

// ---- 5. 选区模型（编辑键与鼠标都改写这三个值） ----------------------------
// adl 实测：selectionBeginIndex <= selectionEndIndex（永远规范化），caretIndex 是
// 「正在移动的那一端」；点/拖/方向键都只通过这两个量表达。
var s:TextField = new TextField();
s.text = "hello world";
eq(s.selectionBeginIndex, 0, "new text resets selection start");
eq(s.selectionEndIndex, 0, "new text resets selection end");
s.setSelection(6, 11);
eq(s.selectionBeginIndex, 6, "setSelection(6,11) begin");
eq(s.selectionEndIndex, 11, "setSelection(6,11) end");
eq(s.caretIndex, 11, "setSelection(6,11) caret at the moving end");
s.setSelection(9, 3);
// AIR 把反向选区规范化成 (3,9)，caret 仍在 9（本次调用给定的端）。
eq(s.selectionBeginIndex, 3, "reversed setSelection normalises begin");
eq(s.selectionEndIndex, 9, "reversed setSelection normalises end");
// 反直觉但实测 4/4 的quirk：setSelection(0, 0) 是**空操作**，不会把光标collapse
// 到 0（证据：temp/xformcmp/seldir round 8，四种前态都一致）。
s.setSelection(0, 0);
eq(s.selectionBeginIndex, 3, "setSelection(0,0) is a no-op: begin unchanged");
eq(s.selectionEndIndex, 9, "setSelection(0,0) is a no-op: end unchanged");
// (n,n) 的其它写法正常收缩（实测 (3,3) 正常）。
s.setSelection(4, 4);
eq(s.selectionBeginIndex, 4, "collapsed selection begin");
eq(s.selectionEndIndex, 4, "collapsed selection end");
eq(s.caretIndex, 4, "collapsed selection caret");
eq(s.text, "hello world", "selection changes never touch the text");

// ---- 6. TextEvent：常量、载荷、默认值、继承 ------------------------------
eq(TextEvent.TEXT_INPUT, "textInput", "TextEvent.TEXT_INPUT constant");
eq(Event.CHANGE, "change", "Event.CHANGE constant");
var te:TextEvent = new TextEvent(TextEvent.TEXT_INPUT, true, true, "x");
eq(te.type, "textInput", "TextEvent type");
eq(te.text, "x", "TextEvent text payload");
eq(te.bubbles, true, "TextEvent bubbles argument");
eq(te.cancelable, true, "TextEvent cancelable argument");
check(te is Event, "TextEvent extends Event");
// 默认参数：bubbles=true, cancelable=false, text="".
var td:TextEvent = new TextEvent(TextEvent.TEXT_INPUT);
eq(td.bubbles, true, "TextEvent default bubbles");
eq(td.cancelable, false, "TextEvent default cancelable");
eq(td.text, "", "TextEvent default text");
check(td is TextEvent, "TextEvent default instance type");

// ---- 7. dispatchEvent 的返回值 = 事件未被取消 ----------------------------
// preventDefault 只在 cancelable 为 true 时生效（Event.preventDefault 的判据），
// 这正是「监听器取消 textInput / change 之后是否还要继续插入」所依赖的语义。
function cancelIt(e:Event):void {
	e.preventDefault();
}
var disp:EventDispatcher = new EventDispatcher();
disp.addEventListener("change", cancelIt);
eq(disp.dispatchEvent(new Event("change", true, true)), false, "cancelable + preventDefault -> false");
eq(disp.dispatchEvent(new Event("change", true, false)), true, "non-cancelable + preventDefault -> true");
eq(disp.dispatchEvent(new Event("nothing", true, true)), true, "no listener -> true");

// 事件确实到达了监听器（上一条的 false 不是「没派发」造成的）。
var reached:int = 0;
function countIt(e:Event):void {
	reached = reached + 1;
}
var d2:EventDispatcher = new EventDispatcher();
d2.addEventListener("change", countIt);
d2.addEventListener("change", cancelIt);
eq(d2.dispatchEvent(new Event("change", true, true)), false, "two listeners, one cancels");
eq(reached, 1, "listener ran once");

trace("stage94g ok");