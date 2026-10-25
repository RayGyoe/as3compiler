// roll-over.as — 阶段二百七十五（G25）：rollOver / rollOut / mouseOver / mouseOut 的
// 派发顺序、接收者与冒泡。
//
// 症状（asaotui/compiler-gaps.md G25）：我们只在**窗口层**记了一个悬停门
// （每 Stage 的 `_mouse_in` + 拾取目标），从不派发对象级的 roll/mouse over/out 事件，
// 于是真应用里「鼠标进按钮变亮」这类监听器一个都不响——air-gallery 的 hover 只能靠
// MovieClip 按钮态的间接路径变亮，任何 `addEventListener(MouseEvent.MOUSE_OVER, ...)`
// 都收不到东西。
//
// AIR 的契约（adl 51.4.1 **真光标**实测，temp/g242526/mouse2-air.txt，探针 AirMouse2.as：
// 三层嵌套 bg > outer > inner > leaf + 兄弟 other）：
//   进入新对象：mouseOut(旧目标，冒泡) → rollOut(旧链上不再包含新指针者，自内向外，
//              不冒泡) → rollOver(新链上原本不包含旧目标者，自内向外，不冒泡)
//              → mouseOver(新目标，冒泡)；
//   同一个目标上继续移动：什么都不派发；
//   roll 对**不上舞台**（舞台只收到冒泡的 mouseOut/mouseOver）；
//   按住按键拖动：照样派发离开/进入（AIR 实测——「按住时不给离开」是不成立的）；
//   指针移出窗口：同一个离开对（stageX/stageY = -1,-1）后，才是舞台自己的 mouseLeave；
//   悬停中的子树被移除：下一拍在**已脱离显示树**的节点上补一次离开对，随后同一拍里
//   给新目标一个 mouseOver。
//
// 本示例逐点走过 adl 探针走过的同一条路径（坐标逐字相同），把每条事件压成
// "type t=… cur=… b=… p=…" 再整体比对：顺序错一位、接收者错一个都会红。
import flash.display.*;
import flash.events.*;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
var log:Array = [];

function nm(o:Object):String {
  if (o == null) return "null";
  if (o is DisplayObject) {
    var n:String = (o as DisplayObject).name;
    return (n == null || n == "") ? "<unnamed>" : n;
  }
  return String(o);
}

var TYPES:Array = [
  MouseEvent.MOUSE_OVER, MouseEvent.MOUSE_OUT, MouseEvent.ROLL_OVER, MouseEvent.ROLL_OUT,
  MouseEvent.MOUSE_DOWN, MouseEvent.MOUSE_UP
];
function onEv(e:Event):void {
  log.push(e.type + " t=" + nm(e.target) + " cur=" + nm(e.currentTarget)
    + " b=" + (e.bubbles ? 1 : 0) + " p=" + e.eventPhase);
}
function wire(d:EventDispatcher):void {
  for (var i:int = 0; i < TYPES.length; i++) d.addEventListener(TYPES[i], onEv);
}

// ---- 与 adl 探针同形的树：bg > outer > inner > leaf，另加兄弟 other ----
var root1:Sprite = new Sprite(); root1.name = "root1";
var bg:Sprite = new Sprite(); bg.name = "bg";
var bgf:Shape = new Shape();
bgf.graphics.beginFill(0xEEEEEE); bgf.graphics.drawRect(0, 0, 500, 375); bgf.graphics.endFill();
bg.addChild(bgf);
root1.addChild(bg);
wire(bg); wire(root1);

var outer:Sprite = new Sprite(); outer.name = "outer"; outer.x = 20; outer.y = 20;
var og:Shape = new Shape();
og.graphics.beginFill(0xCCDDEE); og.graphics.drawRect(0, 0, 200, 140); og.graphics.endFill();
outer.addChild(og);
root1.addChild(outer);
wire(outer);

var inner:Sprite = new Sprite(); inner.name = "inner"; inner.x = 20; inner.y = 20;
var ig:Shape = new Shape();
ig.graphics.beginFill(0xAACCEE); ig.graphics.drawRect(0, 0, 100, 60); ig.graphics.endFill();
inner.addChild(ig);
outer.addChild(inner);
wire(inner);

var leaf:Sprite = new Sprite(); leaf.name = "leaf"; leaf.x = 10; leaf.y = 10;
var lg:Shape = new Shape();
lg.graphics.beginFill(0x2266AA); lg.graphics.drawRect(0, 0, 30, 20); lg.graphics.endFill();
leaf.addChild(lg);
inner.addChild(leaf);
wire(leaf);

var other:Sprite = new Sprite(); other.name = "other"; other.x = 300; other.y = 20;
var xg:Shape = new Shape();
xg.graphics.beginFill(0xDDEECC); xg.graphics.drawRect(0, 0, 120, 100); xg.graphics.endFill();
other.addChild(xg);
root1.addChild(other);
wire(other);

stage.addChild(root1);

function step(x:Number, y:Number, type:String = "mouseMove"):String {
  log = [];
  stage.dispatchMouse(x, y, type);
  return log.join(" | ");
}

// ---- A. 首次进入 bg：旧目标为空，只有 rollOver 链 + mouseOver 冒泡 ----
// 链到 root1 为止（roll 对不上舞台）。
var s:String = step(5, 5);
check(s == "rollOver t=bg cur=bg b=0 p=2 | rollOver t=root1 cur=root1 b=0 p=2"
  + " | mouseOver t=bg cur=bg b=1 p=2 | mouseOver t=bg cur=root1 b=1 p=3",
  "A first enter: " + s);

// ---- B. 进入兄弟子树：离开对 + 进入对；祖先 root1 两边都免 ----
s = step(30, 30);
check(s == "mouseOut t=bg cur=bg b=1 p=2 | mouseOut t=bg cur=root1 b=1 p=3"
  + " | rollOut t=bg cur=bg b=0 p=2 | rollOver t=outer cur=outer b=0 p=2"
  + " | mouseOver t=outer cur=outer b=1 p=2 | mouseOver t=outer cur=root1 b=1 p=3",
  "B bg -> outer: " + s);

// ---- C. 钻进仍在其中的对象：只补新的一层 rollOver ----
s = step(45, 45);
check(s == "mouseOut t=outer cur=outer b=1 p=2 | mouseOut t=outer cur=root1 b=1 p=3"
  + " | rollOver t=inner cur=inner b=0 p=2"
  + " | mouseOver t=inner cur=inner b=1 p=2 | mouseOver t=inner cur=outer b=1 p=3"
  + " | mouseOver t=inner cur=root1 b=1 p=3",
  "C outer -> inner: " + s);

// ---- D. 再钻进 leaf：同样只补一层 ----
s = step(60, 60);
check(s == "mouseOut t=inner cur=inner b=1 p=2 | mouseOut t=inner cur=outer b=1 p=3"
  + " | mouseOut t=inner cur=root1 b=1 p=3"
  + " | rollOver t=leaf cur=leaf b=0 p=2"
  + " | mouseOver t=leaf cur=leaf b=1 p=2 | mouseOver t=leaf cur=inner b=1 p=3"
  + " | mouseOver t=leaf cur=outer b=1 p=3 | mouseOver t=leaf cur=root1 b=1 p=3",
  "D inner -> leaf: " + s);

// ---- E. 同一个目标上继续移动：一条事件都没有 ----
s = step(62, 62);
check(s == "", "E same target must dispatch nothing: " + s);

// ---- F. 退出一层：只有最深一层 rollOut，祖先不重进 ----
s = step(45, 45);
check(s == "mouseOut t=leaf cur=leaf b=1 p=2 | mouseOut t=leaf cur=inner b=1 p=3"
  + " | mouseOut t=leaf cur=outer b=1 p=3 | mouseOut t=leaf cur=root1 b=1 p=3"
  + " | rollOut t=leaf cur=leaf b=0 p=2"
  + " | mouseOver t=inner cur=inner b=1 p=2 | mouseOver t=inner cur=outer b=1 p=3"
  + " | mouseOver t=inner cur=root1 b=1 p=3",
  "F leaf -> inner: " + s);

// ---- G. 再退一层：同理 ----
s = step(30, 30);
check(s == "mouseOut t=inner cur=inner b=1 p=2 | mouseOut t=inner cur=outer b=1 p=3"
  + " | mouseOut t=inner cur=root1 b=1 p=3"
  + " | rollOut t=inner cur=inner b=0 p=2"
  + " | mouseOver t=outer cur=outer b=1 p=2 | mouseOver t=outer cur=root1 b=1 p=3",
  "G inner -> outer: " + s);

// ---- H. 退回空背景：离开对所有层都发 ----
s = step(5, 5);
check(s == "mouseOut t=outer cur=outer b=1 p=2 | mouseOut t=outer cur=root1 b=1 p=3"
  + " | rollOut t=outer cur=outer b=0 p=2 | rollOver t=bg cur=bg b=0 p=2"
  + " | mouseOver t=bg cur=bg b=1 p=2 | mouseOver t=bg cur=root1 b=1 p=3",
  "H outer -> bg: " + s);

// ---- I. 换到兄弟 other，再回 bg ----
s = step(350, 60);
check(s == "mouseOut t=bg cur=bg b=1 p=2 | mouseOut t=bg cur=root1 b=1 p=3"
  + " | rollOut t=bg cur=bg b=0 p=2 | rollOver t=other cur=other b=0 p=2"
  + " | mouseOver t=other cur=other b=1 p=2 | mouseOver t=other cur=root1 b=1 p=3",
  "I bg -> other: " + s);

s = step(5, 5);
check(s == "mouseOut t=other cur=other b=1 p=2 | mouseOut t=other cur=root1 b=1 p=3"
  + " | rollOut t=other cur=other b=0 p=2 | rollOver t=bg cur=bg b=0 p=2"
  + " | mouseOver t=bg cur=bg b=1 p=2 | mouseOver t=bg cur=root1 b=1 p=3",
  "I other -> bg: " + s);

// ---- J. 一次跳进最深处：rollOver 链自内向外补齐（root1 不补，它一直包含指针） ----
s = step(60, 60);
check(s == "mouseOut t=bg cur=bg b=1 p=2 | mouseOut t=bg cur=root1 b=1 p=3"
  + " | rollOut t=bg cur=bg b=0 p=2"
  + " | rollOver t=leaf cur=leaf b=0 p=2 | rollOver t=inner cur=inner b=0 p=2"
  + " | rollOver t=outer cur=outer b=0 p=2"
  + " | mouseOver t=leaf cur=leaf b=1 p=2 | mouseOver t=leaf cur=inner b=1 p=3"
  + " | mouseOver t=leaf cur=outer b=1 p=3 | mouseOver t=leaf cur=root1 b=1 p=3",
  "J bg -> leaf: " + s);

// ---- K. 按住按键拖动：AIR 只多发一条 mouseDown/mouseUp，悬停照旧跟着走 ----
s = step(60, 60, "mouseDown");
check(s == "mouseDown t=leaf cur=leaf b=1 p=2 | mouseDown t=leaf cur=inner b=1 p=3"
  + " | mouseDown t=leaf cur=outer b=1 p=3 | mouseDown t=leaf cur=root1 b=1 p=3",
  "K mouseDown on the same target re-fires no roll pair: " + s);

s = step(45, 45);
check(s == "mouseOut t=leaf cur=leaf b=1 p=2 | mouseOut t=leaf cur=inner b=1 p=3"
  + " | mouseOut t=leaf cur=outer b=1 p=3 | mouseOut t=leaf cur=root1 b=1 p=3"
  + " | rollOut t=leaf cur=leaf b=0 p=2"
  + " | mouseOver t=inner cur=inner b=1 p=2 | mouseOver t=inner cur=outer b=1 p=3"
  + " | mouseOver t=inner cur=root1 b=1 p=3",
  "K drag away while held still delivers the leave pair: " + s);

// 走回 leaf 上方（adl 探针就是在指针停在 leaf 上时移除的），中间这些步不再单独断言。
step(30, 30);
step(5, 5);
step(5, 5, "mouseUp");
step(60, 60);

// ---- L. 悬停中的子树被移除：下一拍在脱离的节点上补离开对，同一拍给新目标 mouseOver ----
inner.parent.removeChild(inner);
log = [];
stage.dispatchFrame();
s = log.join(" | ");
check(s == "mouseOut t=leaf cur=leaf b=1 p=2 | mouseOut t=leaf cur=inner b=1 p=3"
  + " | rollOut t=leaf cur=leaf b=0 p=2 | rollOut t=inner cur=inner b=0 p=2"
  + " | mouseOver t=outer cur=outer b=1 p=2 | mouseOver t=outer cur=root1 b=1 p=3",
  "L removed hovered subtree: " + s);

// ---- M. 指针离开窗口：离开对（坐标 -1,-1）+ 舞台自己的 mouseLeave ----
// 坐标只能从对象级的 mouseOut 上读：AIR 的 mouseLeave 是普通 Event（没有 stageX/Y），
// 带 -1,-1 坐标的是那个离开对。
var outX:Number = 12345;
var outY:Number = 12345;
function onOut(e:Event):void {
  var m:MouseEvent = e as MouseEvent;
  outX = m.stageX;
  outY = m.stageY;
}
outer.addEventListener(MouseEvent.MOUSE_OUT, onOut);
stage.addEventListener("mouseLeave", function(e:Event):void {
  log.push(e.type + " t=" + nm(e.target) + " cur=" + nm(e.currentTarget)
    + " b=" + (e.bubbles ? 1 : 0) + " p=" + e.eventPhase);
});
log = [];
stage.dispatchMouse(0, 0, "mouseLeave");
s = log.join(" | ");
check(s == "mouseOut t=outer cur=outer b=1 p=2 | mouseOut t=outer cur=root1 b=1 p=3"
  + " | rollOut t=outer cur=outer b=0 p=2 | rollOut t=root1 cur=root1 b=0 p=2"
  + " | mouseLeave t=<unnamed> cur=<unnamed> b=0 p=2",
  "M window leave: " + s);
check(outX == -1 && outY == -1, "M the leave pair reports -1,-1 (AIR): " + outX + "," + outY);
outer.removeEventListener(MouseEvent.MOUSE_OUT, onOut);

// 离开之后指针再进来：从零开始，整条链重新 rollOver。
s = step(5, 5);
check(s == "rollOver t=bg cur=bg b=0 p=2 | rollOver t=root1 cur=root1 b=0 p=2"
  + " | mouseOver t=bg cur=bg b=1 p=2 | mouseOver t=bg cur=root1 b=1 p=3",
  "N re-enter after a window leave: " + s);

trace("roll-over: OK");