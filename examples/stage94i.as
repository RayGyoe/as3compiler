// stage94i.as — 阶段九十四·九：DisplayObject 几何/坐标 API 族。
//
// 触发：TODO.md 遗留行的「几何/坐标 API 族未实现」（getBounds/getRect/
// localToGlobal/globalToLocal/hitTestObject，以及 AIR 把 hitTestPoint 放在
// DisplayObject 而本子集只挂在 Sprite 上）。全部按 AGENTS.md §1.5 以
// adl 51.4.1 实测为准（证据台 temp/geoprobe/GeoMain.as，逐值输出在
// temp/geoprobe/adl_geo.txt）。
//
// 关键实测口径（本示例逐条钉住）：
//   * getRect/getBounds(target) = 内容包围盒在 **target 坐标系** 中的轴对齐矩形；
//     getBounds 含描边（±线宽/2），getRect 不含；target == null 表示对象自身的
//     局部空间（== getRect(self)，不是父空间）。
//   * localToGlobal/globalToLocal 走完整祖先矩阵链，返回**新** Point、不改实参；
//     null 点抛 TypeError #2007。
//   * hitTestObject 用两个**舞台空间**包围盒求交，且**含描边**（getBounds 口径：
//     仅靠 20px 描边擦到的两个图形也判 true）；空对象永不相交（对自己也是 false）。
//   * hitTestPoint 的点是**舞台坐标**，且属于 DisplayObject（Shape 也有）。
//   * 祖先旋转时矩阵合成必须正确（局部->舞台的乘法不能用别名输入，见 emit.ts 注释）。
import flash.display.*;
import flash.geom.Point;
import flash.geom.Rectangle;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

function rectEq(r:Rectangle, x:Number, y:Number, w:Number, h:Number, msg:String):void {
	if (r.x != x || r.y != y || r.width != w || r.height != h) {
		throw new Error("FAIL: " + msg + " (got " + r.x + "," + r.y + "," + r.width + "," + r.height + ")");
	}
}

function ptEq(p:Point, x:Number, y:Number, msg:String):void {
	if (p.x != x || p.y != y) throw new Error("FAIL: " + msg + " (got " + p.x + "," + p.y + ")");
}

// 无窗口回归：以 root Sprite 当坐标系原点（headless 无 stage）。
var root:Sprite = new Sprite();

var box:Sprite = new Sprite();
box.x = 100; box.y = 50;
root.addChild(box);

var sh:Shape = new Shape();
sh.graphics.lineStyle(10, 0x000000);
sh.graphics.beginFill(0xff0000);
sh.graphics.drawRect(0, 0, 30, 40);   // 路径 0,0,30,40；描边外扩 5
sh.x = 10; sh.y = 20;
box.addChild(sh);

// ---- A. getRect / getBounds 的坐标系与描边口径（== adl adl_geo.txt A 段） ----
rectEq(sh.getRect(sh), 0, 0, 30, 40, "getRect(self) is the bare path");
rectEq(sh.getBounds(sh), -5, -5, 40, 50, "getBounds(self) adds the stroke half");
rectEq(sh.getRect(box), 10, 20, 30, 40, "getRect(parent) shifts by the child's x/y");
rectEq(sh.getRect(root), 110, 70, 30, 40, "getRect(root) is the stage space");
rectEq(sh.getBounds(root), 105, 65, 40, 50, "getBounds(root) keeps the stroke");
rectEq(box.getRect(box), 10, 20, 30, 40, "container getRect(self) is the child content");
rectEq(box.getBounds(box), 5, 15, 40, 50, "container getBounds(self) includes the stroke");
rectEq(sh.getRect(null), 0, 0, 30, 40, "getRect(null) means the object's own local space");

var h3:Shape = new Shape();
h3.graphics.beginFill(0x222222);
h3.graphics.drawRect(0, 0, 40, 40);
h3.x = 100; h3.y = 100;
root.addChild(h3);
rectEq(sh.getRect(h3), 10, -30, 30, 40, "getRect(unrelated target) still maps through the stage");

// ---- B. localToGlobal / globalToLocal（== B 段） ----
ptEq(sh.localToGlobal(new Point(0, 0)), 110, 70, "localToGlobal(0,0)");
ptEq(sh.globalToLocal(new Point(110, 70)), 0, 0, "globalToLocal(110,70)");
ptEq(box.localToGlobal(new Point(0, 0)), 100, 50, "box.localToGlobal(0,0)");

var arg:Point = new Point(0, 0);
var outPt:Point = sh.localToGlobal(arg);
check(arg.x == 0 && arg.y == 0, "localToGlobal never mutates its argument");
check(outPt != arg, "localToGlobal returns a fresh Point");
check(sh.getRect(sh) != sh.getRect(sh), "each getRect call returns a fresh Rectangle");

var threw:Boolean = false;
try { sh.localToGlobal(null); } catch (e:Error) { threw = true; }
check(threw, "localToGlobal(null) throws TypeError #2007");

// ---- C. 旋转（== C 段） ----
var rot:Sprite = new Sprite();
rot.x = 200; rot.y = 0; rot.rotation = 90;
rot.graphics.beginFill(0x00ff00);
rot.graphics.drawRect(0, 0, 100, 20);
root.addChild(rot);
ptEq(rot.localToGlobal(new Point(0, 0)), 200, 0, "rot.localToGlobal(0,0)");
ptEq(rot.localToGlobal(new Point(100, 0)), 200, 100, "rot.localToGlobal(100,0)");
ptEq(rot.globalToLocal(new Point(200, 0)), 0, 0, "rot.globalToLocal(200,0)");
rectEq(rot.getRect(root), 180, 0, 20, 100, "rot.getRect(root) is the rotated AABB");
rectEq(rot.getRect(rot), 0, 0, 100, 20, "rot.getRect(self) is the unrotated local box");

// ---- D. 缩放（== D 段） ----
var sc:Sprite = new Sprite();
sc.scaleX = 2; sc.scaleY = 3;
sc.graphics.beginFill(0x0000ff);
sc.graphics.drawRect(0, 0, 10, 10);
root.addChild(sc);
ptEq(sc.localToGlobal(new Point(10, 10)), 20, 30, "sc.localToGlobal(10,10)");
ptEq(sc.globalToLocal(new Point(20, 30)), 10, 10, "sc.globalToLocal(20,30)");
rectEq(sc.getRect(root), 0, 0, 20, 30, "sc.getRect(root) is scaled");
rectEq(sc.getRect(sc), 0, 0, 10, 10, "sc.getRect(self) is unscaled");

// ---- E. 空内容 / 未上列表（== E 段） ----
var e1:Shape = new Shape();
rectEq(e1.getRect(e1), 0, 0, 0, 0, "empty getRect is 0,0,0,0");
rectEq(e1.getBounds(e1), 0, 0, 0, 0, "empty getBounds is 0,0,0,0");
var off:Shape = new Shape();
off.x = 7; off.y = 9;
off.graphics.beginFill(0x123456);
off.graphics.drawRect(0, 0, 5, 5);
rectEq(off.getRect(off), 0, 0, 5, 5, "off-list getRect(self)");
ptEq(off.localToGlobal(new Point(0, 0)), 7, 9, "off-list localToGlobal applies its own transform");
check(off.stage == null, "off-list object has no stage");

// ---- F. 祖先旋转时的矩阵合成（== K 段；直接钉住 emit.ts 的别名输入修复） ----
var pv:Sprite = new Sprite();
pv.x = 300; pv.y = 300; pv.rotation = 90;
pv.graphics.beginFill(0x000000);
pv.graphics.drawRect(0, 0, 10, 10);
root.addChild(pv);
var cv:Shape = new Shape();
cv.graphics.beginFill(0x000000);
cv.graphics.drawRect(0, 0, 10, 10);
cv.x = 50; cv.y = 0;
pv.addChild(cv);
ptEq(cv.localToGlobal(new Point(0, 0)), 300, 350, "rotated-ancestor localToGlobal");
ptEq(cv.localToGlobal(new Point(10, 0)), 300, 360, "rotated-ancestor localToGlobal(10,0)");
ptEq(cv.globalToLocal(new Point(300, 350)), 0, 0, "rotated-ancestor globalToLocal");
rectEq(cv.getRect(root), 290, 350, 10, 10, "rotated-ancestor getRect(root)");

// ---- G. hitTestObject（== G / J 段：舞台包围盒、含描边） ----
var sa:Shape = new Shape();
sa.graphics.lineStyle(20, 0x000000);
sa.graphics.beginFill(0x000000);
sa.graphics.drawRect(0, 0, 20, 20);   // 路径 0..20，描边 -10..30
sa.x = 0; sa.y = 0;
root.addChild(sa);
var sb:Shape = new Shape();
sb.graphics.beginFill(0x000000);
sb.graphics.drawRect(0, 0, 10, 10);   // 25..35
sb.x = 25; sb.y = 0;
root.addChild(sb);
check(sa.hitTestObject(sb), "hitTestObject is stroke-inclusive (bare paths miss, strokes touch)");
check(sa.hitTestObject(sa), "an object intersects itself");
var empty2:Shape = new Shape();
check(!sa.hitTestObject(empty2), "an empty object never intersects");
check(!empty2.hitTestObject(empty2), "empty vs empty is false");

// 不同父但舞台重叠 -> 相交（== G 段 cross-parent）
var pa:Sprite = new Sprite(); pa.x = 0; pa.y = 200; root.addChild(pa);
var pb:Sprite = new Sprite(); pb.x = 20; pb.y = 210; root.addChild(pb);
var qa:Shape = new Shape(); qa.graphics.beginFill(0x111111); qa.graphics.drawRect(0, 0, 50, 50); pa.addChild(qa);
var qb:Shape = new Shape(); qb.graphics.beginFill(0x222222); qb.graphics.drawRect(0, 0, 50, 50); pb.addChild(qb);
check(qa.hitTestObject(qb), "hitTestObject works across different parents");

// ---- H. hitTestPoint 属于 DisplayObject（Shape 可用）、点取舞台坐标（== H 段） ----
var hp:Shape = new Shape();
hp.graphics.beginFill(0x111111);
hp.graphics.drawRect(0, 0, 40, 40);
hp.x = 0; hp.y = 0;
root.addChild(hp);
check(hp.hitTestPoint(10, 10), "hitTestPoint inside (on a Shape, not just Sprite)");
check(!hp.hitTestPoint(50, 50), "hitTestPoint outside");
check(!hp.hitTestPoint(-1, -1), "hitTestPoint negative");
check(hp.hitTestPoint(200, 0) == false, "hitTestPoint uses STAGE coordinates (rot at 200,0 does not catch it)");

trace("stage94i ok");