// autobake-scrollrect.as — 自动烘焙（incremental redraw）的**失效判据**：被烘焙的子树里，
// 任何「渲染路径会读、却不改变对象自身变换」的状态变更，都必须让烘焙失效并重新栅格化。
// 本示例钉 `DisplayObject.scrollRect`（差异项 D34，阶段一百六十六）。
//
// 背景：TalkMED 首页菜单（HomeView.menuView + MWIOSScrollBar）的「回弹」被用户报为「不工作」。
// 实测（temp/tkmeet-mac 的 menuprobe.py + 生成 C 里 as_render_object/as_render_fp 的探针）：
// 回弹**算术上完全正确**——拖拽期间 scrollX 0→105，松手后 105→73.5→…→1.45→0 并触发
// ResizeScrollXY；坏的是渲染那一侧只看到 `scrollRect.x` = 0,10,15,20，之后再没更新，
// 画面永久停在 -40 设备像素（20pt）那一帧。同一拖拽在 `ASC_NO_AUTO_BAKE=1` 下重跑：
// 内容跟着手指走、松手精确回弹到原位（184..308 设备像素）。
// 即：**祖先把滚动容器连同它当时的 scrollRect 位移一起烘焙成了位图，而 scrollRect 不在
// 重绘指纹里 ⇒ 烘焙永不过期**（as_render_cached 只烘 as_render_object_content，裁切/平移
// 在烘焙之外，所以冻结发生在「祖先」那一层）。
//
// 判据：把带 scrollRect 的 holder 放进一个会静止 3 帧以上的祖先（root）里，
//   ① 祖先自动烘焙后，滚动窗左上角像素 = 对象 x=0 那格（红）；
//   ② `holder.scrollRect = new Rectangle(10,0,20,20)`（滚一格）；
//   ③ 再跑一帧指纹 → `BitmapData.draw(root)` 必须变绿（对象 x=10 那格）；
//   ④ 再静止 3 帧让祖先带着新位移重新烘焙，重烘焙后的像素同样必须是新的。
// 修复前 ③ 仍是红（画的是烘焙那一刻的位图）。
//
// 编译：as-aot examples/autobake-scrollrect.as --manifest examples/autobake-scrollrect.build.json --run
// 断言的**是像素**，纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as 一样链 Skia；
// 没有后端时示例自检后跳过（控制组与断言走同一条代码路径，不会把别的故障误判成「无后端」）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.DisplayObject;
import flash.display.BitmapData;
import flash.geom.Rectangle;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 120;
stage.stageHeight = 60;

// 光栅后端自检：控制组是一个普通容器（和 root 同类、同在显示列表上），
// 所以「draw 是空桩」只会让它读到背景色，而不是把别处的故障误判成「无后端」。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 40, 20);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

// 会被自动烘焙的祖先：它的指纹递归包含子孙的一切（as_render_fp）。
var root:Sprite = new Sprite();
stage.addChild(root);

// 滚动容器：40x20，四格 10pt 色条（红/绿/蓝/黄）。
var holder:Sprite = new Sprite();
root.addChild(holder);
for (var i:int = 0; i < 4; i++) {
  var c:uint = i == 0 ? 0xFF0000 : (i == 1 ? 0x00FF00 : (i == 2 ? 0x0000FF : 0xFFFF00));
  var cell:Shape = new Shape();
  cell.graphics.beginFill(c);
  cell.graphics.drawRect(i * 10, 0, 10, 20);
  cell.graphics.endFill();
  holder.addChild(cell);
}
// 滚动窗锚在对象自己的盒子上（D29 口径）：20pt 宽，显示对象 x∈[scrollRect.x, +20)。
holder.scrollRect = new Rectangle(0, 0, 20, 20);

// `stage.render` 是离屏下唯一会跑「每帧指纹 pass」的入口（窗口渲染之外），
// 连续 4 帧以上静止 ⇒ root 被自动烘焙。
for (var f:int = 0; f < 6; f++) stage.render(120, 60, "temp/autobake-scrollrect.png");

function probe(obj:DisplayObject):uint {
  var bd:BitmapData = new BitmapData(40, 20, false, 0xFFFFFF);
  bd.draw(obj);
  return bd.getPixel(5, 5) & 0xFFFFFF;
}

if (probe(controlRoot) != 0xFF00FF) {
  trace("autobake-scrollrect: skipped (no raster backend)");
} else {
  check(probe(root) == 0xFF0000,
        "a baked container must still paint the object x=0 cell, got 0x" + probe(root).toString(16));

  // 滚一格：窗口左上角应变成对象 x=10 那格（绿）。
  holder.scrollRect = new Rectangle(10, 0, 20, 20);
  stage.render(120, 60, "temp/autobake-scrollrect.png");   // 一帧指纹：烘焙必须失效
  var after:uint = probe(root);
  check(after == 0x00FF00,
        "a scrollRect change must invalidate the ancestor's bake: the window's first pixel is 0x"
        + after.toString(16) + ", want the object x=10 cell (0xff00)");

  // 回滚也必须是活的（回弹路径正是往小滚）。
  holder.scrollRect = new Rectangle(0, 0, 20, 20);
  stage.render(120, 60, "temp/autobake-scrollrect.png");
  check(probe(root) == 0xFF0000, "scrolling back must repaint as well");

  // 再静止 3 帧 ⇒ 祖先带着新位移重新烘焙；重烘焙必须抓到新位移（否则只是「暂时对」）。
  holder.scrollRect = new Rectangle(10, 0, 20, 20);
  for (var g:int = 0; g < 5; g++) stage.render(120, 60, "temp/autobake-scrollrect.png");
  check(probe(root) == 0x00FF00,
        "the re-bake must capture the scrolled offset, got 0x" + probe(root).toString(16));

  trace("autobake-scrollrect: scrollRect changes invalidate the auto-bake — assertions passed");
}
