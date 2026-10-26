// parent-mouse.as — DisplayObject.parent 是 DisplayObjectContainer 类型的只读访问器（阶段二百九十四）。
//
// 现场：talkmed-meeting 设置窗里三个 i 图标的 tooltip 只闪不显。ToolTips.MyTip.onMouseMove 用
// `this.parent.mouseX/mouseY` 摆放提示框，而当时 DisplayObject.parent **没有**登记成访问器，
// 于是 `obj.parent` 命中的是 EventDispatcher 那个存显示树父指针的内部**字段**（静态类型 Object），
// 成员读退化成动态查表：as_dyn_get(stage, "mouseX") → null → NaN。tip 因此被摆到 (NaN,NaN)：
// visible=true、画不出来、也点不到（真机证据：bin-aot 生成的 MyTip_onMouseMove 就是那行 as_dyn_get）。
//
// AIR 的 parent 是 DisplayObjectContainer（只读），所以这里钉三件事：
//   ① parent 的值就是显示树父件（含「stage 的直接子件其 parent === stage」），离树后为 null；
//   ② parent 的静态类型是容器：parent.x / parent.mouseX 必须走静态访问器（不是动态查表）；
//   ③ mouseX/mouseY 是父件空间里的指针（Stage.dispatchMouse 灌点后逐值相等）。
import flash.display.Sprite;
import flash.display.Stage;
import flash.display.DisplayObjectContainer;

function check(what:String, ok:Boolean, detail:String = ""):void {
  if (!ok) throw new Error("parent-mouse: " + what + " failed: " + detail);
}

var st:Stage = new Stage();

var box:Sprite = new Sprite();
box.graphics.beginFill(0xff0000);
box.graphics.drawRect(0, 0, 40, 20);
box.graphics.endFill();
box.x = 7;
box.y = 9;
st.addChild(box);

var dot:Sprite = new Sprite();
dot.graphics.beginFill(0x00ff00);
dot.graphics.drawRect(0, 0, 10, 10);
dot.graphics.endFill();
box.addChild(dot);

st.dispatchMouse(11, 13, "mouseMove");

check("parent is the display parent (identity)", dot.parent === box);
check("parent.x reads the parent's own x", String(dot.parent.x) == "7", "got " + dot.parent.x);
// 这就是 MyTip 摆提示框的两个读数：父件空间里的指针 = (11-7, 13-9)。
check("parent.mouseX is the pointer in the parent's space", String(dot.parent.mouseX) == "4", "got " + dot.parent.mouseX);
check("parent.mouseY is the pointer in the parent's space", String(dot.parent.mouseY) == "4", "got " + dot.parent.mouseY);

// parent 的静态类型必须是 DisplayObjectContainer：赋给该类型的变量要原样传下来。
var asContainer:DisplayObjectContainer = dot.parent;
check("parent converts to DisplayObjectContainer", asContainer === box);

// 一个 tip 是 stage 的直接子件，它的 parent 就是 stage —— MyTip 的定位正是这么读的。
var tip:Sprite = new Sprite();
st.addChild(tip);
check("a stage child's parent is the Stage", tip.parent === st);
check("...and its parent.mouseX is the stage pointer", String(tip.parent.mouseX) == "11", "got " + tip.parent.mouseX);

// 不在显示列表里：AIR 报 null（不是任何 stage、也不是一个空容器）。
var orphan:Sprite = new Sprite();
check("an object off the display list has a null parent", orphan.parent == null);

trace("parent-mouse: ok");
