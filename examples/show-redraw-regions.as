// show-redraw-regions.as — RepaintBoundary 阶段 C：showRedrawRegions 真画出脏矩形描边。
//
// 启用 showRedrawRegions(true, 0x00FF00) 后，cacheAsBitmap 边界每次重绘都在刚重绘的
// 矩形外画 1px 绿色描边：整边界重建（bake_rebuild）画整个边界，边界内增量重烘
// （bake_patch）只画脏矩形。这里边界比脏矩形大（右下角多一个静态子对象），所以能
// 从像素上区分两者。用 BitmapData.draw 直接触发重烘（不经过 stage.render），描边落在
// 采样的那张位图上：首次 draw 触发整边界重建（右边缘有描边），改图形后再次 draw
// 触发增量重烘（右边缘不再有描边，只剩脏矩形的描边）。
//
// 编译：as-aot examples/show-redraw-regions.as --manifest examples/show-redraw-regions.build.json --run
// 与 cache-patch.as 一样链 Skia（断言的是像素）；无后端时自检后跳过。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 400;
stage.stageHeight = 300;

// 光栅后端自检（同 cache-patch.as）：控制组画品红，读不到就说明 draw 是空桩。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

// 边界：container 左上角是 box（可变图形），右下角是 corner（静态子对象，扩大边界）。
// container 不设 x/y，局部坐标 = BitmapData 坐标，便于采样。
var container:Sprite = new Sprite();
var box:Shape = new Shape();
box.graphics.beginFill(0x3366CC);
box.graphics.drawRect(0, 0, 120, 90);
box.graphics.endFill();
container.addChild(box);
var corner:Shape = new Shape();
corner.graphics.beginFill(0xFF00FF); // 品红，区别于描边的绿
corner.graphics.drawRect(200, 200, 20, 20);
corner.graphics.endFill();
container.addChild(corner);
stage.addChild(container);
container.cacheAsBitmap = true;

// 启用脏矩形描边（绿色 0x00FF00）。
showRedrawRegions(true, 0x00FF00);

var probeBd:BitmapData = new BitmapData(300, 300, false, 0xFFFFFFFF);
function probe():void {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(container);
}
// 绿色分量显著（描边 0x00FF00 的 g 通道同时高于 r 与 b；抗锯齿半覆盖也成立）。
function isGreen(x:int, y:int):Boolean {
  var c:uint = probeBd.getPixel(x, y);
  var r:int = (c >> 16) & 0xFF;
  var g:int = (c >> 8) & 0xFF;
  var b:int = c & 0xFF;
  return g > r && g > b;
}

var probeBd2:BitmapData = new BitmapData(10, 10, false, 0xFFFFFFFF);
probeBd2.fillRect(probeBd2.rect, 0xFFFFFFFF);
probeBd2.draw(controlRoot);
if (probeBd2.getPixel(5, 5) != 0xFF00FF) {
  trace("show-redraw-regions: skipped (no raster backend)");
} else {
  // 第一次 draw：cacheAsBitmap 尚未烘焙，触发整边界重建，描边覆盖整个边界右边缘。
  probe();
  check(isGreen(219, 100), "first (rebuild) render must outline the whole boundary's right edge");

  // 只改左上角 box（同 bounds 追加一个矩形），触发增量重烘，脏矩形 = box(0,0,120,90)。
  box.graphics.beginFill(0xFF0000);
  box.graphics.drawRect(10, 10, 30, 20);
  box.graphics.endFill();

  // 第二次 draw：增量重烘，描边只覆盖脏矩形 box，右边缘 x=220 不再有描边。
  probe();
  check(!isGreen(219, 100), "incremental re-bake must NOT outline the static right edge");
  check(isGreen(119, 45), "incremental re-bake must outline the dirty rect's right edge");

  trace("show-redraw-regions: dirty-rect outline verified");
}
