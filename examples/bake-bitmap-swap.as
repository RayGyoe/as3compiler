// bake-bitmap-swap.as — 缓存指纹必须认得「换了一张 BitmapData」（阶段二百八十一）。
//
// 症状（真机，TalkMED 会议客户端）：中间那块 PPT 预览在**某些分辨率**下被自动烘焙以后，
// 翻页翻到第 N 页就再也不变了，必须把窗口恢复到「烘焙前那个尺寸」才恢复。
//
// 根因不是尺寸，是 as_render_fp 对 Bitmap 的哈希输入不够：
//   `if (bd != NULL) h = as_fp_ptr(h, bd->image);`
//   `if (bd != NULL) h = as_fp_u32(h, bd->_px_ver);`
// 应用里每一页幻灯片的 BitmapData 都是 `cn.edoctor.utils.ImageLoader` 造的
// —— `new BitmapData(w, h, true, 0)` 之后 `draw(loader)` 一次。于是**每一页**都是
// `image == NULL` + `_px_ver == 1`：换 bitmapData 不改变任何一个哈希输入，祖宗的
// 烘焙永不过期，画面永远停在烘焙那一刻那一页。尺寸一变，`pw/ph` 变了才会重建一次，
// 于是看上去「只有 resize 才能让它动」（用户描述里「必须恢复 cache 之前的大小」就是
// 这个重建的附带现象）。
//
// 修法：BitmapData 带一个单调的实例号 `_uid`（构造器里 `++as_bd_uid_next`），指纹里
// 一起哈希。地址做不到这件事——回收器会把同一个地址发给下一次分配。
//
// 判据（三条都要过）：
//   ① 静止 6 帧让祖先自动烘焙后，探针读到第一张图的颜色；
//   ② 把 `bitmap.bitmapData` 换成同尺寸、同样「ctor + 一次 draw」造出来的第二张图，
//      跑一帧指纹后探针必须变（旧烘焙失效）；
//   ③ 再静止若干帧重新烘焙，探针仍是新颜色（重烘焙抓到的是新图，不是「暂时对」）；
//   ④ 显式 `cacheAsBitmap = true` 的对象同样必须过期——AIR 的缓存是自动失效的，
//      只有 setter 驱动的话，`cacheAsBitmapAndMatrix()` 之后改内容就永久冻结。
//
// 编译：as-aot examples/bake-bitmap-swap.as --manifest examples/bake-bitmap-swap.build.json --run
// 断言的**是像素**，纯 C 构建没有光栅后端（draw 是空桩），故与 autobake-scrollrect.as
// 一样链 Skia；没有后端时示例自检后跳过（控制组与断言走同一条代码路径）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.display.DisplayObject;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 120;
stage.stageHeight = 60;

// 光栅后端自检：控制组是一个普通容器（与 root 同类、同在显示列表上），
// 「draw 是空桩」只会让它读到背景色，不会把别处的故障误判成「无后端」。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

// 与 ImageLoader 完全同形状的一张「幻灯片」：ctor 填透明底 + 一次 draw。
function slide(color:uint, w:int, h:int):BitmapData {
  var src:Shape = new Shape();
  src.graphics.beginFill(color);
  src.graphics.drawRect(0, 0, w, h);
  src.graphics.endFill();
  var bd:BitmapData = new BitmapData(w, h, true, 0x00000000);
  bd.draw(src);
  return bd;
}

// 会被自动烘焙的祖先：指纹递归包含子孙的一切（as_render_fp）。
var root:Sprite = new Sprite();
stage.addChild(root);

var bmp:Bitmap = new Bitmap(slide(0xFF0000, 10, 20));
root.addChild(bmp);

// 静止 6 帧（> ASC_AUTO_BAKE_FRAMES=3）⇒ root 被自动烘焙。
for (var f:int = 0; f < 6; f++) stage.render(120, 60, "temp/bake-bitmap-swap.png");

var probeBd:BitmapData = new BitmapData(10, 20, false, 0xFFFFFFFF);
function probe(obj:DisplayObject):uint {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(obj);
  return probeBd.getPixel(5, 5) & 0xFFFFFF;
}

if (probe(controlRoot) != 0xFF00FF) {
  trace("bake-bitmap-swap: skipped (no raster backend)");
} else {
  check(probe(root) == 0xFF0000,
        "the baked ancestor must paint the first bitmap, got 0x" + probe(root).toString(16));

  // 翻到「下一页」：换一张同尺寸、同样造法的 BitmapData。
  bmp.bitmapData = slide(0x00FF00, 10, 20);
  stage.render(120, 60, "temp/bake-bitmap-swap.png");   // 一帧指纹：烘焙必须失效
  var after:uint = probe(root);
  check(after == 0x00FF00,
        "swapping bitmapData must invalidate the ancestor's bake: probe reads 0x"
        + after.toString(16) + ", want the new bitmap (0xff00)");

  // 再静止几帧让它带着新图重新烘焙：必须是新图，而不是「暂时对」。
  for (var g:int = 0; g < 5; g++) stage.render(120, 60, "temp/bake-bitmap-swap.png");
  check(probe(root) == 0x00FF00,
        "the re-bake must capture the new bitmap, got 0x" + probe(root).toString(16));

  // 翻回去同样要是活的（用户正是「翻回来」时发现它还停在新的一页）。
  bmp.bitmapData = slide(0xFF0000, 10, 20);
  stage.render(120, 60, "temp/bake-bitmap-swap.png");
  check(probe(root) == 0xFF0000, "swapping back must repaint as well");

  // ④ 显式 cacheAsBitmap：内容变了也必须过期（AIR 的缓存会自动失效）。
  var box:Sprite = new Sprite();
  box.cacheAsBitmap = true;
  stage.addChild(box);
  var dot:Shape = new Shape();
  dot.graphics.beginFill(0x0000FF);
  dot.graphics.drawRect(0, 0, 10, 10);
  dot.graphics.endFill();
  box.addChild(dot);
  for (var e:int = 0; e < 4; e++) stage.render(120, 60, "temp/bake-bitmap-swap.png");
  check(probe(box) == 0x0000FF,
        "an explicit cacheAsBitmap starts baked, got 0x" + probe(box).toString(16));

  dot.graphics.clear();
  dot.graphics.beginFill(0xFFFF00);
  dot.graphics.drawRect(0, 0, 10, 10);
  dot.graphics.endFill();
  stage.render(120, 60, "temp/bake-bitmap-swap.png");
  check(probe(box) == 0xFFFF00,
        "an explicit cacheAsBitmap must expire when its content changes, got 0x"
        + probe(box).toString(16));

  trace("bake-bitmap-swap: bitmap swaps and explicit caches invalidate — assertions passed");
}