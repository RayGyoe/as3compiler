// stage94l.as — 阶段九十四·十三：Tab / Shift+Tab 焦点遍历。
//
// 触发：TODO.md 遗留行的「Tab 焦点遍历未实现」（阶段九十四·七 C2 登记，Ed2 全回合
// 唯一未对齐点）。全部按 AGENTS.md §1.5 以 adl 51.4.1 实测为准（证据台
// temp/editprobe/src/Ed10.as + drive_ed10.py；adl 与 AOT 逐行一致，见
// temp/editprobe/adl_ed10.txt 与 aot_ed10.txt）。
//
// 关键实测口径（本示例逐条钉住）：
//   * 环 = 显示列表**先序**遍历中所有 tabEnabled==true 的 InteractiveObject；
//     tabEnabled==false 的对象（动态文本、普通 Sprite）被跳过。
//   * 两个方向都 wrap：Tab 越过最后一个 → 第一个；Shift+Tab 在第一个之前 → 最后一个。
//   * 焦点为 null 时：Tab → 第一个可聚焦对象，Shift+Tab → 最后一个。
//   * 移动发生在**未被 preventDefault 抑制**的 Tab keyDown 上（派发之后）；同一次
//     按键的 keyUp 派发给**新**焦点。
//   * focusOut(old, rel=new) → focusIn(new, rel=old)，均冒泡。
//   * 锚点规则：焦点为 null（例如刚点了空白处）时，从「最后一次由**鼠标按下**聚焦的
//     对象」的显示位置之后继续；从未点过任何字段则从头/尾开始。遍历本身不移动锚点。
import flash.display.*;
import flash.events.*;
import flash.text.*;

var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}

function mkField(s:String, y:Number):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = y; f.width = 300; f.height = 30;
	f.background = true; f.backgroundColor = 0x1E1E1E;
	f.text = s;
	f.type = TextFieldType.INPUT;
	return f;
}

var stage:Stage = new Stage();

var a:TextField = mkField("aaaa", 10);
var b:TextField = mkField("bbbb", 50);
var c:TextField = mkField("cccc", 90);
var d:TextField = mkField("dddd", 130);
var e:TextField = mkField("eeee", 170);
// 后续分组（H）才加入显示列表，避免改变前面分组的环顺序。
var f3:TextField = mkField("ffff", 250);   // 之后改回动态文本（非 tabbable）
var f4:TextField = mkField("gggg", 290);

stage.addChild(a);
stage.addChild(b);
stage.addChild(c);
stage.addChild(d);
stage.addChild(e);

var box:Sprite = new Sprite();          // 非 tabbable 的落点（点它 = 焦点清空）
box.x = 10; box.y = 210;
box.graphics.beginFill(0x335533); box.graphics.drawRect(0, 0, 300, 30); box.graphics.endFill();
stage.addChild(box);

var gate:Boolean = false;
var lastKeyUpTarget:Object = null;
stage.addEventListener("keyDown", function(ev:KeyboardEvent):void {
	if (gate && ev.keyCode == 9) ev.preventDefault();
});
stage.addEventListener("keyUp", function(ev:KeyboardEvent):void {
	lastKeyUpTarget = ev.target;
});

function focusName():String {
	var f:Object = stage.focus;
	if (f == null) return "null";
	if (f == a) return "a"; if (f == b) return "b"; if (f == c) return "c";
	if (f == d) return "d"; if (f == e) return "e";
	if (f == f3) return "f3"; if (f == f4) return "f4";
	return "other";
}
// mod 位掩码与运行时 ASC_MOD_* 一致：1=ctrl, 2=alt, 4=shift, 8=cmd。
function pressTab(shift:Boolean):void {
	var mod:int = shift ? 4 : 0;
	stage.dispatchKey("keyDown", 9, 9, mod);
	stage.dispatchKey("keyUp", 9, 9, mod);
}

// ---- A. tabEnabled 默认值 ----
check(a.tabEnabled, "an INPUT TextField is tabbable by default");
check(!box.tabEnabled, "a plain Sprite is not tabbable by default");
b.tabEnabled = false;
check(!b.tabEnabled, "tabEnabled can be turned off");

// ---- B. Tab 前进 + 跳过 tabEnabled=false + wrap ----
stage.focus = a;
check(focusName() == "a", "stage.focus = a takes effect");
pressTab(false);
check(focusName() == "c", "Tab from a skips the tabEnabled=false b and lands on c");
pressTab(false);
check(focusName() == "d", "Tab from c lands on d");
pressTab(false);
check(focusName() == "e", "Tab from d lands on e");
pressTab(false);
check(focusName() == "a", "Tab from the last tabbable wraps to the first");

// ---- C. Shift+Tab 反向 + wrap ----
pressTab(true);
check(focusName() == "e", "Shift+Tab from the first wraps to the last");
stage.focus = c;
pressTab(true);
check(focusName() == "a", "Shift+Tab from c falls back to a (skipping b)");

// ---- D. 焦点为 null 且从未点过字段：从头/尾开始 ----
stage.focus = null;
check(focusName() == "null", "stage.focus = null clears the focus");
pressTab(false);
check(focusName() == "a", "Tab with nothing focused lands on the first tabbable");
stage.focus = null;
pressTab(true);
check(focusName() == "e", "Shift+Tab with nothing focused lands on the last tabbable");

// ---- E. 锚点：鼠标按下过 a 之后清空焦点，Tab 从 a 之后继续 ----
stage.dispatchMouse(150, 25, "mouseDown");
check(focusName() == "a", "a mouseDown on a TextField focuses it");
stage.focus = null;
pressTab(false);
check(focusName() == "c", "Tab with a null focus resumes after the last mouse-focused field (a -> c)");

// ---- F. preventDefault 抑制移动；焦点不变时 keyUp 仍发往原焦点 ----
stage.focus = a;
lastKeyUpTarget = null;
gate = true;
pressTab(false);
check(focusName() == "a", "preventDefault() on the Tab keyDown suppresses the move entirely");
check(lastKeyUpTarget == a, "the suppressed keystroke's keyUp still goes to the old focus");
gate = false;
pressTab(false);
check(focusName() == "c", "with the gate off Tab moves again");

// ---- G. keyUp 派发给新焦点 ----
lastKeyUpTarget = null;
pressTab(false);
check(lastKeyUpTarget == d, "the keyUp of a moving Tab is delivered to the NEW focus");

// ---- H. 焦点落在非 tabbable 对象上时，它仍作为锚点参与定位 ----
f3.type = TextFieldType.DYNAMIC;   // 非 tabbable、不参与环
check(!f3.tabEnabled, "a dynamic TextField is not tabbable");
check(f4.tabEnabled, "the following INPUT field is tabbable");
stage.addChild(f3);
stage.addChild(f4);
stage.focus = f3;
pressTab(false);
check(stage.focus == f4, "Tab from a focused non-tabbable object moves to the next tabbable");
check(focusName() == "f4", "and it is the very next tabbable after that object's display position");

if (failCount == 0) trace("stage94l ok");