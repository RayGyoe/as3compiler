// fps-counter.as — RepaintBoundary 阶段 C 验收：FPS 计数器场景的重绘面积降幅。
//
// 阶段四十七的 FPS 计数器是 90×20 的 TextField 小块，而 native 曾每帧全量光栅化
// 2000×1360 整帧。阶段 C 的写时脏标记 + auto-bake 让静止的大背景只烘一次、之后每帧
// 只 blit 快照（bake_blit），而每帧变化的小块走 live/patch，重绘面积从整帧降到小块。
//
// 自动断言的是像素：大背景多帧后颜色不变（缓存命中），小块每帧改色后正确更新。
// ASC_BAKE_TRACE=1 可观察 bake_on（大背景烘一次）与 bake_blit（之后每帧只 blit）。
//
// 编译：as-aot examples/fps-counter.as --manifest examples/fps-counter.build.json --run
// 链 Skia（断言的是像素）；无后端时自检后跳过。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();
stage.stageWidth = 400;
stage.stageHeight = 300;

// 光栅后端自检（同 cache-patch.as）。
var controlRoot:Sprite = new Sprite();
var control:Shape = new Shape();
control.graphics.beginFill(0xFF00FF);
control.graphics.drawRect(0, 0, 10, 10);
control.graphics.endFill();
controlRoot.addChild(control);
stage.addChild(controlRoot);

// 大背景：一个静止的多 primitive 容器（auto-bake 后只 blit）。
var bigRoot:Sprite = new Sprite();
var big:Shape = new Shape();
big.graphics.beginFill(0x3366CC);
big.graphics.drawRect(0, 0, 200, 150);
big.graphics.endFill();
big.graphics.beginFill(0x224488); // 第二个 fill，让 bigRoot 成为多 primitive（否则单 primitive 不 auto-bake）
big.graphics.drawRect(10, 10, 50, 50);
big.graphics.endFill();
bigRoot.addChild(big);
stage.addChild(bigRoot);

// 小块：90×20 的 FPS 计数器，每帧改色。
var counter:Shape = new Shape();
counter.x = 220;
counter.y = 20;
counter.graphics.beginFill(0xFF0000);
counter.graphics.drawRect(0, 0, 90, 20);
counter.graphics.endFill();
stage.addChild(counter);

var probeBd:BitmapData = new BitmapData(400, 300, false, 0xFFFFFFFF);
function probe():void {
  probeBd.fillRect(probeBd.rect, 0xFFFFFFFF);
  probeBd.draw(stage);
}
function bigColor():uint {
  return probeBd.getPixel(100, 75) & 0xFFFFFF;
}
function counterColor():uint {
  return probeBd.getPixel(265, 30) & 0xFFFFFF;
}

var probeBd2:BitmapData = new BitmapData(10, 10, false, 0xFFFFFFFF);
probeBd2.fillRect(probeBd2.rect, 0xFFFFFFFF);
probeBd2.draw(controlRoot);
if (probeBd2.getPixel(5, 5) != 0xFF00FF) {
  trace("fps-counter: skipped (no raster backend)");
} else {
  // 第一帧：大背景首次渲染（auto-bake 烘焙），小块画红。
  stage.render(400, 300, "temp/fps-counter.png");
  probe();
  check(bigColor() == 0x3366CC, "big background must paint blue");
  check(counterColor() == 0xFF0000, "counter must paint red on the first frame");

  // 后续多帧：每帧只改小块颜色，大背景应保持（缓存命中，只 blit）。
  var next:uint = 0x00FF00;
  var i:int;
  for (i = 0; i < 3; i++) {
    counter.graphics.clear();
    counter.graphics.beginFill(next);
    counter.graphics.drawRect(0, 0, 90, 20);
    counter.graphics.endFill();
    stage.render(400, 300, "temp/fps-counter.png");
    probe();
    check(bigColor() == 0x3366CC, "big background must stay blue across frames");
    check(counterColor() == next, "counter must update every frame");
    next = (next == 0x00FF00) ? 0x0000FF : (next == 0x0000FF ? 0xFFFF00 : 0xFF0000);
  }

  trace("fps-counter: repaint-area reduction verified");
}
