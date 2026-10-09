// stage94f.as — 阶段九十四·六（C 批·C1）：DisplayObject 几何与命中测试的 AIR 保真。
//
// 三条被实测推翻的旧假设（证据：temp/c1probe/ 的 4 个 adl 探针 + temp/c1probe/click/
// 的真鼠标点击探针，全部 adl 51.4.1）：
//   ① `width`/`height` 不是存储槽而是**派生值**：由内容包围盒经自身变换得到；
//   ② 给它赋值是**缩放**（`scaleX = scaleX * value / cur`），不是改尺寸；
//   ③ 命中测试是**变换感知**的（父链矩阵逐层折算），不是「同一个绝对 x/y 传给所有子对象」。
//
// 旧实现把 width/height 当存储字段、命中用 `x >= o->x && x <= o->x + o->width`，
// 于是「没画过东西的 Shape/Sprite 恒为 0×0 且点不中」「容器带 offset 时子对象一律点不中」
// 「旋转过的形状按未旋转的包围盒命中」。下面每一条断言都对应一处 adl 实测值。
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.MovieClip;
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.display.Stage;
import flash.text.TextField;
import flash.geom.Matrix;
import flash.events.MouseEvent;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// adl 把 x/y 量化到 1/20 px、分解中间量走单精度（见 temp/xformcmp/README.md），
// 几何断言一律带容差。
function near(a:Number, b:Number, msg:String):void {
	var d:Number = a - b;
	if (d < 0) d = -d;
	if (d > 0.02) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")");
}

function sized(o:flash.display.DisplayObject, w:Number, h:Number, label:String):void {
	near(o.width, w, label + " width");
	near(o.height, h, label + " height");
}

// ---- 1. width/height 由内容派生 -------------------------------------------
var a:Shape = new Shape();
a.graphics.beginFill(0xFF0000);
a.graphics.drawRect(0, 0, 50, 30);
a.graphics.endFill();
sized(a, 50, 30, "shape 50x30");

// 内容的偏移不进 width/height（getRect 才带偏移，而 getRect 本子集未实现）。
var c:Shape = new Shape();
c.graphics.beginFill(0xFF0000);
c.graphics.drawRect(10, 20, 30, 40);
c.graphics.endFill();
sized(c, 30, 40, "shape content at 10,20");

// 描边计入 width/height（实测 100 长的线 + 10px 描边 = 110x10）。
var d:Shape = new Shape();
d.graphics.lineStyle(10, 0x000000);
d.graphics.moveTo(0, 0);
d.graphics.lineTo(100, 0);
sized(d, 110, 10, "stroke-only line");

// 没画过 → 0x0；clear() 之后 → 0x0。
var e:Shape = new Shape();
sized(e, 0, 0, "never drawn");
var k:Shape = new Shape();
k.graphics.beginFill(0xFF0000);
k.graphics.drawRect(0, 0, 50, 30);
k.graphics.endFill();
k.graphics.clear();
sized(k, 0, 0, "after clear");

// 自身变换参与：旋转 90°（100x20 → 20x100）、旋转 45°（对角包围盒）、
// transform.matrix 缩放 3 倍、非等比 scale（0.5,3）。
var p:Shape = new Shape();
p.graphics.beginFill(0xFF0000);
p.graphics.drawRect(0, 0, 100, 20);
p.graphics.endFill();
p.rotation = 90;
sized(p, 20, 100, "rotated 90");

var kk:Shape = new Shape();
kk.graphics.beginFill(0xFF0000);
kk.graphics.drawRect(0, 0, 100, 20);
kk.graphics.endFill();
kk.rotation = 45;
sized(kk, 84.85, 84.85, "rotated 45");

var cc:Shape = new Shape();
cc.graphics.beginFill(0xFF0000);
cc.graphics.drawRect(0, 0, 50, 30);
cc.graphics.endFill();
var m3:Matrix = new Matrix();
m3.scale(3, 3);
cc.transform.matrix = m3;
sized(cc, 150, 90, "transform.matrix scale 3");

var w:Shape = new Shape();
w.graphics.beginFill(0xFF0000);
w.graphics.drawRect(0, 0, 40, 10);
w.graphics.endFill();
w.scaleX = 0.5;
w.scaleY = 3;
sized(w, 20, 30, "non-uniform scale");

// ---- 2. 赋值 = 缩放 ------------------------------------------------------
// 实测：50 宽的图形 width=100 → scaleX 2（几何本身没变）；空对象 → scaleX 0。
var b:Shape = new Shape();
b.graphics.beginFill(0xFF0000);
b.graphics.drawRect(0, 0, 50, 30);
b.graphics.endFill();
b.width = 100;
sized(b, 100, 30, "width=100");
near(b.scaleX, 2, "width=100 scales scaleX");

var s:Shape = new Shape();
s.width = 50;
sized(s, 0, 0, "width on empty content");
near(s.scaleX, 0, "width on empty content collapses scaleX");

// clear() 保留 scaleX：重画 50x30 之后又变回 100x30。
var t:Shape = new Shape();
t.graphics.beginFill(0xFF0000);
t.graphics.drawRect(0, 0, 50, 30);
t.graphics.endFill();
t.width = 100;
t.graphics.clear();
sized(t, 0, 0, "clear keeps nothing to measure");
t.graphics.beginFill(0xFF0000);
t.graphics.drawRect(0, 0, 50, 30);
t.graphics.endFill();
sized(t, 100, 30, "clear keeps scaleX");

// ---- 3. 容器 = 自身图形 ∪ 子对象（各自变换后） ---------------------------
// Sprite.graphics（C1-1）：AIR 里 Sprite/MovieClip 有自己的 graphics，之前本子集没有。
var sp:Sprite = new Sprite();
check(sp.graphics != null, "Sprite.graphics is never null (AIR contract)");
sp.graphics.beginFill(0x3366CC);
sp.graphics.drawRect(0, 0, 50, 30);
sp.graphics.endFill();
sized(sp, 50, 30, "sprite own graphics");

var ch:Shape = new Shape();
ch.graphics.beginFill(0x66CC33);
ch.graphics.drawRect(0, 0, 40, 10);
ch.graphics.endFill();
ch.x = 100; ch.y = 5;
sp.addChild(ch);
sized(sp, 140, 30, "sprite own graphics + child");

// 只有子对象时容器尺寸来自子对象；此时 width=100 在 50 宽的子对象上 → scaleX 2。
var ff:Sprite = new Sprite();
var ffch:Shape = new Shape();
ffch.graphics.beginFill(0x66CC33);
ffch.graphics.drawRect(0, 0, 50, 20);
ffch.graphics.endFill();
ff.addChild(ffch);
sized(ff, 50, 20, "child-only container");
ff.width = 100;
sized(ff, 100, 20, "child-only container width=100");
near(ff.scaleX, 2, "child-only container scales");

// 负坐标、不可见子对象、旋转子对象、嵌套容器都按 AIR 计入。
var i2:Sprite = new Sprite();
var ich:Shape = new Shape();
ich.graphics.beginFill(0x66CC33);
ich.graphics.drawRect(0, 0, 20, 20);
ich.graphics.endFill();
ich.x = -10; ich.y = -10;
i2.addChild(ich);
sized(i2, 20, 20, "child at negative offset");

var r:Sprite = new Sprite();
var rch:Shape = new Shape();
rch.graphics.beginFill(0x66CC33);
rch.graphics.drawRect(0, 0, 30, 30);
rch.graphics.endFill();
rch.visible = false;
r.addChild(rch);
sized(r, 30, 30, "invisible child still counts");

var q:Sprite = new Sprite();
var qch:Shape = new Shape();
qch.graphics.beginFill(0x66CC33);
qch.graphics.drawRect(0, 0, 100, 20);
qch.graphics.endFill();
qch.rotation = 90;
q.addChild(qch);
sized(q, 20, 100, "rotated child");

var outer:Sprite = new Sprite();
var mid:Sprite = new Sprite();
mid.x = 100; mid.y = 0;
var leaf:Shape = new Shape();
leaf.graphics.beginFill(0x66CC33);
leaf.graphics.drawRect(0, 0, 20, 20);
leaf.graphics.endFill();
leaf.x = 5;
mid.addChild(leaf);
outer.addChild(mid);
sized(outer, 20, 20, "nested container");

// MovieClip 同样有 graphics；自己的变换与子对象一起算。
var mc:MovieClip = new MovieClip();
check(mc.graphics != null, "MovieClip.graphics is never null");
mc.graphics.beginFill(0xFF9900);
mc.graphics.drawRect(0, 0, 12, 8);
mc.graphics.endFill();
sized(mc, 12, 8, "movieclip own graphics");

// Bitmap 尺寸来自 bitmapData（scaleX 也计入）。
var bd:BitmapData = new BitmapData(64, 32, false, 0xFF00FF00);
var bmp:Bitmap = new Bitmap(bd);
sized(bmp, 64, 32, "bitmap from bitmapData");
bmp.scaleX = 2;
sized(bmp, 128, 32, "bitmap scaleX=2");

// 子 TextField 的字段尺寸也算，且子对象自己的 scaleX 计入。
var dd:Sprite = new Sprite();
var dtf:TextField = new TextField();
dtf.width = 40; dtf.height = 10;
dtf.scaleX = 2;
dd.addChild(dtf);
sized(dd, 80, 10, "sprite with scaled TextField child");

// 子对象的描边同样放大父容器（10px 描边的 0..60 线 → 70）。
var v:Sprite = new Sprite();
var vch:Shape = new Shape();
vch.graphics.lineStyle(10, 0x000000);
vch.graphics.moveTo(0, 0);
vch.graphics.lineTo(60, 0);
v.addChild(vch);
sized(v, 70, 10, "child stroke widens parent");

// ---- 4. TextField 覆写 width/height --------------------------------------
// 字段尺寸是真存储：取值 = 字段 × scaleX，赋值写字段（不缩放），默认 100x100。
var tf:TextField = new TextField();
sized(tf, 100, 100, "TextField default");
tf.width = 123;
sized(tf, 123, 100, "TextField width=123");
near(tf.scaleX, 1, "TextField width assignment does not scale");
tf.scaleX = 2;
sized(tf, 246, 100, "TextField width = field * scaleX");
tf.width = 200;
sized(tf, 400, 100, "TextField width setter writes the field");
near(tf.scaleX, 2, "TextField width setter keeps scaleX");

// ---- 5. 命中测试：变换感知 + 子对象按自身包围盒 --------------------------
// 数据全部来自 temp/c1probe/click/ 的真鼠标点击探针（adl 51.4.1）：窗口
// systemChrome=none 位于 (300,200)，脚本按「屏幕 = 窗口原点 + 舞台点」点击。
var stage:Stage = new Stage();

var box:Sprite = new Sprite();
box.x = 100; box.y = 50;
box.graphics.beginFill(0xFF0000);
box.graphics.drawRect(0, 0, 60, 40);
box.graphics.endFill();
stage.addChild(box);
sized(box, 60, 40, "hit target box");

var boxLocalX:Number = -1;
var boxLocalY:Number = -1;
var boxTargetOk:Boolean = false;
box.addEventListener("click", function(e:MouseEvent):void {
	boxLocalX = e.localX; boxLocalY = e.localY; boxTargetOk = (e.target == box);
});
stage.dispatchMouse(130, 70, "click");
check(boxTargetOk, "a click inside an offset container's child targets the child");
near(boxLocalX, 30, "MouseEvent.localX is target-local (adl: 30)");
near(boxLocalY, 20, "MouseEvent.localY is target-local (adl: 20)");

// 旋转 45° 的容器：命中按旋转后的图形，不按未旋转的包围盒。
// 实测 (380,105) 落在未旋转包围盒内、旋转后的图形外 → adl 不命中（事件落到 stage）。
var rot:Sprite = new Sprite();
rot.x = 300; rot.y = 100; rot.rotation = 45;
rot.graphics.beginFill(0x00FF00);
rot.graphics.drawRect(0, 0, 100, 20);
rot.graphics.endFill();
stage.addChild(rot);
var rotHits:int = 0;
var rotLocalX:Number = -1;
var rotLocalY:Number = -1;
rot.addEventListener("click", function(e:MouseEvent):void { rotHits++; rotLocalX = e.localX; rotLocalY = e.localY; });
// 取图形内部的点（本地约 (49.5,9.9)）而不是 (310,110)：后者本地是 (14.13,-0.021)，
// 正好压在 y=0 这条边上 —— 实测 adl 报的 localY 也是 -0.021，命中与否完全由 ±0.02px
// 的浮点/量化误差决定（adl 命中，严格几何会判在外面）。边界行为不做断言。
stage.dispatchMouse(328, 142, "click");
check(rotHits == 1, "a click inside the rotated shape hits it");
near(rotLocalX, 49.5, "rotated target localX through the inverse matrix (adl: 49.49)");
near(rotLocalY, 9.9, "rotated target localY (adl: 9.88)");
stage.dispatchMouse(380, 105, "click");
check(rotHits == 1, "a click outside the rotated shape must miss even if it is inside the AABB");

// 子对象按自身包围盒命中：父容器自身只画了 10x10 在 (0,300)，子对象在父内 (60,20)
// 画 40x40。实测点 (70,330) → target 是子对象（父自身包围盒并不包含该点）。
var holder:Sprite = new Sprite();
holder.x = 0; holder.y = 300;
holder.graphics.beginFill(0x0000FF);
holder.graphics.drawRect(0, 0, 10, 10);
holder.graphics.endFill();
stage.addChild(holder);
var deep:Sprite = new Sprite();
deep.x = 60; deep.y = 20;
deep.graphics.beginFill(0xFF00FF);
deep.graphics.drawRect(0, 0, 40, 40);
deep.graphics.endFill();
holder.addChild(deep);
var deepLocalX:Number = -1;
var deepLocalY:Number = -1;
var deepTargetOk:Boolean = false;
var holderBubbled:Boolean = false;
deep.addEventListener("click", function(e:MouseEvent):void {
	deepLocalX = e.localX; deepLocalY = e.localY; deepTargetOk = (e.target == deep);
});
holder.addEventListener("click", function(e:MouseEvent):void { holderBubbled = true; });
stage.dispatchMouse(70, 330, "click");
check(deepTargetOk, "a child is hit on its own bounds (parent bbox not required)");
near(deepLocalX, 10, "deep target localX (adl: 10)");
near(deepLocalY, 10, "deep target localY (adl: 10)");
check(holderBubbled, "the hit bubbles from the child to the container");

// 空白处：AIR 把事件派发给 stage 自己（实测 target=stage，localX/localY = 舞台坐标）。
var stageTargetOk:Boolean = false;
var stageLocalX:Number = -1;
stage.addEventListener("click", function(e:MouseEvent):void {
	if (e.target == stage) { stageTargetOk = true; stageLocalX = e.localX; }
});
stage.dispatchMouse(350, 350, "click");
check(stageTargetOk, "a click on empty space falls back to the stage (adl)");
near(stageLocalX, 350, "stage-local coordinates on the fallback path");

// mouseChildren=false：父容器吸收命中（沿用 stage35 的口径，走的是新的
// 累计矩阵递归）。
var absorbParent:Sprite = new Sprite();
absorbParent.graphics.beginFill(0x3366CC);
absorbParent.graphics.drawRect(0, 0, 100, 100);
absorbParent.graphics.endFill();
absorbParent.mouseChildren = false;
stage.addChild(absorbParent);
var absorbChild:Sprite = new Sprite();
absorbChild.x = 10; absorbChild.y = 10;
absorbChild.graphics.beginFill(0x66CC33);
absorbChild.graphics.drawRect(0, 0, 50, 50);
absorbChild.graphics.endFill();
absorbParent.addChild(absorbChild);
var childFired:Boolean = false;
var parentFired:Boolean = false;
absorbChild.addEventListener("click", function(e:MouseEvent):void { childFired = true; });
absorbParent.addEventListener("click", function(e:MouseEvent):void { if (e.target == absorbParent) parentFired = true; });
stage.dispatchMouse(20, 20, "click");
check(!childFired, "mouseChildren=false keeps the child out of the hit test");
check(parentFired, "mouseChildren=false makes the parent absorb the hit");

// hitTestPoint 取**舞台坐标**（AIR 文档口径）：deep 在舞台 (60,20)+holder(0,300) 处。
check(deep.hitTestPoint(70, 330, true), "hitTestPoint(70,330) is inside deep");
check(!deep.hitTestPoint(10, 10, true), "hitTestPoint(10,10) is outside deep");
check(box.hitTestPoint(130, 70, true), "hitTestPoint(130,70) is inside box");
check(!box.hitTestPoint(10, 10, true), "hitTestPoint(10,10) is outside box");

trace("stage94f: DisplayObject geometry + transform-aware hit test (C1) OK");