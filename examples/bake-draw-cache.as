// bake-draw-cache.as — BitmapData.draw 也是「一条渲染路径」：它必须像窗口绘制那样
// 先刷新指纹，否则烘焙在**这条路径里**永不过期（阶段二百八十二）。
//
// 症状（真机，TalkMED 会议客户端 presenter 模式）：中间那块幻灯片在翻页后不换图，
// 必须把窗口恢复成「烘焙前那个尺寸」才恢复一次；上一轮修好了显示列表侧（BitmapData
// 实例号进指纹），但真机上**依然冻住**。
//
// 根因（代码事实，见 src/emit.ts 的 BitmapData_draw）：窗口绘制路径与 Stage.render
// 都会在绘制前调用 as_render_fp(stage)，把「本帧内容指纹」推进一遍——烘焙的失效、
// 以及 _auto_still 计数，全部由那次遍历驱动。而 BitmapData.draw 直接
//   as_skia_canvas_scale / as_render_object(canvas, sdo)
// 就画了，**一次指纹都不算**。于是凡是只经由 draw 进入渲染的子树：
//   ① 自动烘焙永远不启动（_auto_baked 只由指纹遍历置位）——这一半恰好掩盖了问题；
//   ② 显式 cacheAsBitmap（_cache_flag）照烘不误，而它唯一的失效来源是 setter，
//      于是第一次 draw 烘出来的图被无限重放。
//
// 应用里正是这个形状：FilePreviewView.drawTimeEvent()（10 fps Timer）每帧
//   pBitmapData.draw(skinView.view, matrix, null, BlendMode.NORMAL, null, true);
//   previewPpt.Render(pBitmapData);            // 屏幕上的那块大图
// 而 skinView.view 是 com.vsdevelop.proxy.ViewControl，构造时就走
// cacheAsBitmapAndMatrix()，即 `cacheAsBitmap = true`。它烘一次，之后翻多少页都是
// 那第一张，除非 pw/ph 变化（= 用户口中的「必须恢复 cache 之前的窗口大小」）。
//
// 判据（都要过）：
//   ① 离屏子树（从没上过显示列表）带 cacheAsBitmap，draw 一次读到红；
//   ② 换一张同尺寸、同样「ctor + 一次 draw」造出来的 BitmapData 后，再一次 draw
//      必须读到绿——即 draw 路径有能力让烘焙过期；
//   ③ 离屏子树不带 cacheAsBitmap 时，draw 若干帧后仍要跟着换（自动烘焙若在这条
//      路径上启动，同样必须能过期）；
//   ④ 在显示列表上的子树（窗口路径每帧刷新指纹）照旧跟着换（回归）。
//
// 编译：as-aot examples/bake-draw-cache.as --manifest examples/bake-draw-cache.build.json --run
// 断言的**是像素**，纯 C 构建没有光栅后端，故与 bake-bitmap-swap.as 一样链 Skia；
// 没有后端时示例自检后跳过。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.geom.Matrix;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 120;
stage.stageHeight = 60;

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

// 光栅后端自检：控制组是一个普通容器（与别处同类），draw 是空桩时只会读到白底。
var controlBd:BitmapData = new BitmapData(40, 30, false, 0xFFFFFFFF);
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
controlBd.draw(controlRoot);
var controlOk:Boolean = (controlBd.getPixel(5, 5) & 0xFFFFFF) == 0xFF00FF;

// ---- ① ② 离屏 + 显式 cacheAsBitmap：draw 路径必须能过期 -------------------
var offView:Sprite = new Sprite();
offView.cacheAsBitmap = true;          // ViewControl.cacheAsBitmapAndMatrix()
var offBmp:Bitmap = new Bitmap(slide(0xFF0000, 10, 20));
offView.addChild(offBmp);

var canvas:BitmapData = new BitmapData(40, 30, false, 0xFFFFFFFF);
function capture(target:DisplayObject):uint {
  canvas.fillRect(canvas.rect, 0xFFFFFFFF);
  canvas.draw(target, null, null, null, null, true);
  return canvas.getPixel(5, 5) & 0xFFFFFF;
}

// ---- ③ 离屏 + 自动烘焙 ----------------------------------------------------
var autoView:Sprite = new Sprite();
var autoBmp:Bitmap = new Bitmap(slide(0xFF0000, 10, 20));
autoView.addChild(autoBmp);

// ---- ④ 在显示列表上（回归） ------------------------------------------------
var liveRoot:Sprite = new Sprite();
stage.addChild(liveRoot);
var liveBmp:Bitmap = new Bitmap(slide(0xFF0000, 10, 20));
liveRoot.addChild(liveBmp);

if (!controlOk) {
  trace("bake-draw-cache: skipped (no raster backend)");
} else {
  check(capture(offView) == 0xFF0000,
        "off-stage cacheAsBitmap: first draw must paint the first slide, got 0x"
        + capture(offView).toString(16));
  offBmp.bitmapData = slide(0x00FF00, 10, 20);
  var offAfter:uint = capture(offView);
  check(offAfter == 0x00FF00,
        "BitmapData.draw must re-render a cacheAsBitmap subtree after its content changed: reads 0x"
        + offAfter.toString(16) + ", want 0xff00 (frozen = the draw path never refreshes the fingerprint)");

  // ③ 离屏且没有 cacheAsBitmap：draw 若干帧后换图同样要跟上。
  for (var i:int = 0; i < 6; i++) capture(autoView);
  check(capture(autoView) == 0xFF0000, "off-stage auto-bake: first slide, got 0x" + capture(autoView).toString(16));
  autoBmp.bitmapData = slide(0x00FF00, 10, 20);
  var autoAfter:uint = capture(autoView);
  check(autoAfter == 0x00FF00,
        "off-stage subtree must re-render after a bitmap swap even once it is baked, got 0x"
        + autoAfter.toString(16));

  // ④ 显示列表上的老路径不能被这次改动弄坏。
  for (var f:int = 0; f < 4; f++) stage.render(120, 60, "temp/bake-draw-cache.png");
  check(capture(liveRoot) == 0xFF0000, "on-stage: first slide, got 0x" + capture(liveRoot).toString(16));
  liveBmp.bitmapData = slide(0x00FF00, 10, 20);
  stage.render(120, 60, "temp/bake-draw-cache.png");
  var liveAfter:uint = capture(liveRoot);
  check(liveAfter == 0x00FF00, "on-stage swap must still repaint, got 0x" + liveAfter.toString(16));

  trace("bake-draw-cache: BitmapData.draw refreshes the fingerprint — assertions passed");
}
