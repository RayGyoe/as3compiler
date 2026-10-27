// scrollrect-coordinates.as — scrollRect 对坐标 API 的影响在**下一帧渲染**生效。
//
// adl 51.4.1 实测（temp/srtest/ProbeSpatial.as，同文件跑 AOT）：给自身或祖先设置
// scrollRect 后立刻 localToGlobal/globalToLocal/getBounds，仍得到设置前的答案；
// ENTER_FRAME 后再读，才把内容的 -scrollRect.x/-y 平移计入。TalkMED 国家列表的
// List.updateItemIndex 正是用 localToGlobal 判断首行是否滚出视口；少了这份帧后
// 位移就永不回收/补充行，列表底部出现灰带。

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}
function pt(p:Point, x:Number, y:Number, msg:String):void {
  check(Math.round(p.x) == x && Math.round(p.y) == y,
    msg + ": got " + p.x + "," + p.y + ", want " + x + "," + y);
}

var stage:Stage = new Stage();
stage.stageWidth = 500;
stage.stageHeight = 300;
var root:Sprite = new Sprite();
stage.addChild(root);

var mc:Sprite = new Sprite();
mc.x = 50;
mc.y = 60;
root.addChild(mc);
var box:Sprite = new Sprite();
box.y = 10;
box.graphics.beginFill(0xFF0000);
box.graphics.drawRect(0, 0, 20, 20);
box.graphics.endFill();
mc.addChild(box);

var outer:Sprite = new Sprite();
outer.x = 300;
outer.y = 60;
root.addChild(outer);
var inner:Sprite = new Sprite();
inner.y = 10;
outer.addChild(inner);
var leaf:Sprite = new Sprite();
leaf.y = 20;
inner.addChild(leaf);

mc.scrollRect = new Rectangle(0, 30, 100, 100);
outer.scrollRect = new Rectangle(0, 25, 200, 200);

// 当次赋值仍读旧的（未渲染）串接矩阵，自身和祖先都不提前计入。
pt(box.localToGlobal(new Point(0, 0)), 50, 70, "immediate child localToGlobal");
pt(mc.localToGlobal(new Point(0, 10)), 50, 70, "immediate self localToGlobal");
pt(leaf.localToGlobal(new Point(0, 0)), 300, 90, "immediate ancestor localToGlobal");
pt(mc.globalToLocal(new Point(60, 80)), 10, 20, "immediate globalToLocal");
var before:Rectangle = box.getBounds(root);
check(Math.round(before.x) == 50 && Math.round(before.y) == 70,
  "immediate getBounds keeps the pre-render position");

stage.render(500, 300, "temp/scrollrect-coordinates.png");

// 渲染一帧后：自身 -30、祖先 -25，边界和包围盒命中走同一份串接矩阵。
pt(box.localToGlobal(new Point(0, 0)), 50, 40, "rendered child localToGlobal");
pt(mc.localToGlobal(new Point(0, 10)), 50, 40, "rendered self localToGlobal");
pt(leaf.localToGlobal(new Point(0, 0)), 300, 65, "rendered ancestor localToGlobal");
pt(mc.globalToLocal(new Point(60, 80)), 10, 50, "rendered globalToLocal");
pt(leaf.globalToLocal(new Point(305, 95)), 5, 30, "rendered ancestor globalToLocal");
var after:Rectangle = box.getBounds(root);
check(Math.round(after.x) == 50 && Math.round(after.y) == 40,
  "rendered getBounds includes scrollRect");
var relative:Rectangle = box.getRect(mc);
check(Math.round(relative.x) == 0 && Math.round(relative.y) == 10,
  "getRect(parent) stays in the parent's unscrolled coordinate space");
check(box.hitTestPoint(60, 50, false), "bounds hit follows the rendered content");
check(!box.hitTestPoint(60, 80, false), "bounds hit leaves the old content position");

// 再次赋值仍等到下一帧；清掉 scrollRect 也遵守同一个帧边界。
mc.scrollRect = new Rectangle(0, 50, 100, 100);
pt(box.localToGlobal(new Point(0, 0)), 50, 40, "reassignment keeps last-rendered offset");
stage.render(500, 300, "temp/scrollrect-coordinates.png");
pt(box.localToGlobal(new Point(0, 0)), 50, 20, "reassignment applies next frame");
mc.scrollRect = null;
pt(box.localToGlobal(new Point(0, 0)), 50, 20, "clear keeps last-rendered offset");
stage.render(500, 300, "temp/scrollrect-coordinates.png");
pt(box.localToGlobal(new Point(0, 0)), 50, 70, "clear applies next frame");

trace("scrollrect-coordinates: rendered scroll offsets drive coordinate APIs — assertions passed");
