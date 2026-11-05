// scroll-header-pin.as — RepaintBoundary 阶段 C 验收：滚动列表只重绘滚动内容，固定 header
// 一帧不动（BitmapData.draw 前后签名比对）。
//
// header 是列表容器之外的独立对象；滚动只改 list.scrollRect（列表容器自己的 render-input 写点），
// 脏只冒泡到 list 及其祖先，不会经过 header。所以滚动后 header 的像素逐点不变，滚动窗里的内容
// 像素随 scrollRect 位移变化。判据是像素，故与 cache-patch.as 一样链 Skia；无后端时自检后跳过。
//
// 编译：as-aot examples/scroll-header-pin.as --manifest examples/scroll-header-pin.build.json --run

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;
import flash.geom.Rectangle;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 300;
stage.stageHeight = 200;

// 光栅后端自检（同 cache-patch.as）。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

// 固定 header：列表容器之外的独立对象，滚动不会触碰它。
var header:Shape = new Shape();
header.graphics.beginFill(0x3366CC);
header.graphics.drawRect(0, 0, 200, 30);
header.graphics.endFill();
stage.addChild(header);

// 列表容器（scrollRect 裁剪窗口 200×60），内容是三段 200×30 的色块（红/绿/蓝）。
var list:Sprite = new Sprite();
list.y = 30;
var content:Sprite = new Sprite();
content.graphics.beginFill(0xFF0000);
content.graphics.drawRect(0, 0, 200, 30);
content.graphics.endFill();
content.graphics.beginFill(0x00FF00);
content.graphics.drawRect(0, 30, 200, 30);
content.graphics.endFill();
content.graphics.beginFill(0x0000FF);
content.graphics.drawRect(0, 60, 200, 30);
content.graphics.endFill();
list.addChild(content);
list.scrollRect = new Rectangle(0, 0, 200, 60);
stage.addChild(list);
list.cacheAsBitmap = true;

var probeBd:BitmapData = new BitmapData(300, 200, false, 0xFFFFFFFF);
function probe():void {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(stage);
}
// header 采样点（y=15，header 内）；滚动窗顶部采样点（y=45，对应 list 局部 y=15，scrollRect 内容内）。
function headerColor():uint {
  return probeBd.getPixel(100, 15) & 0xFFFFFF;
}
function contentColor():uint {
  return probeBd.getPixel(100, 45) & 0xFFFFFF;
}

var probeBd2:BitmapData = new BitmapData(10, 10, false, 0xFFFFFFFF);
probeBd2.fillRect(probeBd2.rect, 0xFFFFFFFF);
probeBd2.draw(controlRoot);
if (probeBd2.getPixel(5, 5) != 0xFF00FF) {
  trace("scroll-header-pin: skipped (no raster backend)");
} else {
  // 第一帧：header 蓝；滚动窗顶部 = 内容第一段（红）。
  stage.render(300, 200, "temp/scroll-header-pin.png");
  probe();
  check(headerColor() == 0x3366CC, "header must paint blue on the first frame");
  check(contentColor() == 0xFF0000, "scroll window top must paint the first (red) segment");

  // 滚一格：scrollRect.y = 30，滚动窗顶部切到内容第二段（绿）。
  list.scrollRect = new Rectangle(0, 30, 200, 60);

  // 第二帧：header 逐点不变；滚动窗顶部变成绿。
  stage.render(300, 200, "temp/scroll-header-pin.png");
  probe();
  check(headerColor() == 0x3366CC, "header must NOT move across frames");
  check(contentColor() == 0x00FF00, "scroll window top must update to the second (green) segment");

  trace("scroll-header-pin: header pinned while content scrolls");
}
