// cache-patch.as — RepaintBoundary 阶段 C 第三步：边界内增量重烘。
//
// 把 container 设成 cacheAsBitmap 边界后，第一次 render 全量重建（bake_rebuild）；
// 随后只追加一个**同 bounds** 的 drawRect（只改色、不改边界尺寸，携带精确脏矩形），
// 第二次 render 必须走边界内增量重烘（bake_patch），而不是整边界重建。判据是像素：
// 第一次中心是蓝（0x3366CC），第二次中心变红（0xFF0000）。
//
// 用 ASC_BAKE_TRACE=1 运行时，stderr 会依次出现 bake_rebuild 与 bake_patch 两行。
//
// 编译：as-aot examples/cache-patch.as --manifest examples/cache-patch.build.json --run
// 断言的**是像素**，纯 C 构建没有光栅后端（draw 是空桩），故与 bake-bitmap-swap.as
// 一样链 Skia；没有后端时示例自检后跳过（控制组与断言走同一条代码路径）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;
import flash.display.DisplayObject;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 400;
stage.stageHeight = 300;

// 光栅后端自检：控制组是一个普通容器（与 root 同类、同在显示列表上），
// 「draw 是空桩」只会让它读到背景色，不会把别处的故障误判成「无后端」。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

var container:Sprite = new Sprite();
container.x = 40;
container.y = 40;
var box:Shape = new Shape();
box.graphics.beginFill(0x3366CC);
box.graphics.drawRect(0, 0, 120, 90);
box.graphics.endFill();
container.addChild(box);
stage.addChild(container);
container.cacheAsBitmap = true;

// 第一次 render：整边界重建（bake_rebuild），画蓝色。
stage.render(400, 300, "temp/cache-patch.png");

var probeBd:BitmapData = new BitmapData(120, 90, false, 0xFFFFFFFF);
function center():uint {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(container);
  return probeBd.getPixel(60, 45) & 0xFFFFFF;
}
function controlColor():uint {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(controlRoot);
  return probeBd.getPixel(5, 5) & 0xFFFFFF;
}

if (controlColor() != 0xFF00FF) {
  trace("cache-patch: skipped (no raster backend)");
} else {
  check(center() == 0x3366CC,
        "first render must paint blue, got 0x" + center().toString(16));

  // 追加一个同 bounds 的矩形（只改色、不改边界尺寸），只带精确脏矩形。
  box.graphics.beginFill(0xFF0000);
  box.graphics.drawRect(0, 0, 120, 90);
  box.graphics.endFill();

  // 第二次 render：边界内增量重烘（bake_patch），中心必须变红。
  stage.render(400, 300, "temp/cache-patch.png");
  check(center() == 0xFF0000,
        "incremental re-bake must paint red, got 0x" + center().toString(16));

  trace("cache-patch: incremental re-bake verified");
}
