// autobake-patch.as — auto-bake 边界不再「丢掉重烘」，而是**原地修复**保留的表面（阶段三百八十一）。
//
// 背景：auto-bake 边界一旦被写脏，阶段 B/C 的做法是**整块失效** —— 当帧丢掉烘焙退回活态绘制，
// 下一帧再从头重建表面（重新分配 surface + 整块重新光栅化 + 快照 + 贴回）。一次内容变更因此
// 要光栅化两遍子树，还要分配一次表面。真机日志（335 秒、`ASC_BAKE_TRACE=1`）里 25 秒一次的
// 爆发就是这么来的：9~10 个边界同时被写脏，2.0~3.1 Mpx 的整块重烘。
//
// 阶段 C 早就实现了「有限脏矩形 + 保留 surface ⇒ 只重画那块矩形」（`bake_patch`），但只有显式
// `cacheAsBitmap` 走得到；auto-bake 分支把它整条跳过了。阶段三百八十一让 auto-bake 也走这条路，
// 但**只对零散变更**：`_cache_dirty_run` 记「连续多少帧脏」，只有「上一帧还是干净的」这种零散
// 变更才原地修复；每帧都脏的子树（动画/滚动）照旧退回活态，避免每帧多付一次快照 + 贴回。
//
// 本示例钉的是**像素**（源级结构钉在 test/unit/render.ts 的 render/AutoBakePatch 组）。判据用
// 「同一份内容的两个副本」：`card` 被自动烘焙后单点改色（追加一个小矩形 ⇒ 精确脏矩形 ⇒ 走修
// 复路径），`twin` 每步都**新建**一份同样内容的子树 —— 它的第一帧必然是「从零整块烘焙」，也就是
// 修复路径的正确答案。两者区域逐像素相同，才说明原地修复没有留下任何过期像素：
//   ① 零散改色后：修复过的 card 必须等于同一内容的整块新烘（过期像素会让两者不等）；
//   ② 连续 5 帧改色（模拟动画）：不许崩、不许停在旧画面，收尾后仍等于整块新烘；
//   ③ 收尾后再来一次零散改色：回到修复路径，仍然逐像素正确。
//
// 编译：as-aot examples/autobake-patch.as --manifest examples/autobake-patch.build.json --run
// 断言的是像素，纯 C 构建没有光栅后端（draw 是空桩），故与 autobake-move.as 一样链 Skia；
// 没有后端时示例自检后跳过（自检与断言走同一条代码路径）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Stage;
import flash.display.BitmapData;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var W:int = 460;
var H:int = 260;
var CW:int = 200;
var CH:int = 100;
var CARD_X:int = 10;
var CARD_Y:int = 10;
var TWIN_Y:int = 150;

// 反走样圆：半径落在半像素上，整块重画与「只画一块矩形」之间任何采样差异都会翻转像素。
function circles():Sprite {
  var s:Sprite = new Sprite();
  for (var i:int = 0; i < 3; i++) {
    var c:Shape = new Shape();
    c.graphics.beginFill(i % 3 == 1 ? 0x0088AA : 0xCC3366);
    c.graphics.drawCircle(6.5 + i * 16, 6.5, 6);
    c.graphics.endFill();
    s.addChild(c);
  }
  return s;
}

function cardBg():Shape {
  var bg:Shape = new Shape();
  bg.graphics.beginFill(0xDDDDEE);
  bg.graphics.drawRect(0, 0, CW, CH);
  bg.graphics.endFill();
  return bg;
}

var stage:Stage = new Stage();
stage.stageWidth = W;
stage.stageHeight = H;

var root:Sprite = new Sprite();
stage.addChild(root);

// 被修复的边界：背景 + 三个圆 + 一盏灯（灯是要改色的小块，8x8，位于本地 (30,30)）。
var card:Sprite = new Sprite();
card.addChild(cardBg());
card.addChild(circles());
var lamp:Shape = new Shape();
var colors:Array = [0xCC0000];
lamp.graphics.beginFill(0xCC0000);
lamp.graphics.drawRect(0, 0, 8, 8);
lamp.graphics.endFill();
lamp.x = 30;
lamp.y = 30;
card.addChild(lamp);
card.x = CARD_X;
card.y = CARD_Y;
root.addChild(card);

// 整块新烘的参照：内容由 colors 数组决定（同一盏灯按写入顺序叠加），每次重建。
function buildTwin():Sprite {
  var s:Sprite = new Sprite();
  s.addChild(cardBg());
  s.addChild(circles());
  var l:Shape = new Shape();
  for (var i:int = 0; i < colors.length; i++) {
    l.graphics.beginFill(colors[i]);
    l.graphics.drawRect(0, 0, 8, 8);
    l.graphics.endFill();
  }
  l.x = 30;
  l.y = 30;
  s.addChild(l);
  s.x = CARD_X;
  s.y = TWIN_Y;
  return s;
}

var twin:Sprite = buildTwin();
root.addChild(twin);

function snap():BitmapData {
  var bd:BitmapData = new BitmapData(W, H, false, 0xFFFFFF);
  bd.draw(root);
  return bd;
}

function hashRegion(bd:BitmapData, x0:int, y0:int, w:int, h:int):String {
  var n:int = 0;
  var acc:uint = 2166136261;
  for (var y:int = y0; y < y0 + h; y++) {
    for (var x:int = x0; x < x0 + w; x++) {
      var p:uint = bd.getPixel(x, y) & 0xFFFFFF;
      if (p != 0xFFFFFF) n++;
      acc = (acc * 31 + p) % 4294967296;
    }
  }
  return String(n) + ":" + String(acc);
}

// 后端自检：参照物必须真的画出颜色（否则说明这个构建没有光栅后端）。
function hasBackend():Boolean {
  var bd:BitmapData = new BitmapData(40, 40, false, 0xFFFFFF);
  bd.draw(cardBg());
  return (bd.getPixel(10, 10) & 0xFFFFFF) != 0xFFFFFF;
}

// 把灯再刷一层颜色：beginFill 会 flush 上一组几何并标出**精确矩形**，
// 所以这一步给 card 带的是一个有限脏矩形，而不是 _dirty_full。
function repaintLamp(c:uint):void {
  colors.push(c);
  lamp.graphics.beginFill(c);
  lamp.graphics.drawRect(0, 0, 8, 8);
  lamp.graphics.endFill();
}

function rebuildTwin():void {
  root.removeChild(twin);
  twin = buildTwin();
  root.addChild(twin);
}

// 一帧：card 与 twin 在同一帧里各自出图（card 修复它的保留表面、twin 从零整块烘焙），
// 然后比两块区域。任何过期像素、任何少画/多画都会让两个签名不相等。
function renderAndCompare(label:String):void {
  stage.render(W, H, "temp/autobake-patch.png");
  var a:String = hashRegion(snap(), CARD_X, CARD_Y, CW, CH);
  var b:String = hashRegion(snap(), CARD_X, TWIN_Y, CW, CH);
  check(a == b,
        label + ": the repaired boundary must be pixel-identical to a from-scratch bake of the"
        + " same content; repaired=" + a + " fresh=" + b);
}

// 第 1 帧：两者都还是活态/首次烘焙，作为「非空」基线。
stage.render(W, H, "temp/autobake-patch.png");

if (!hasBackend()) {
  trace("autobake-patch: skipped (no raster backend)");
} else {
  var base:String = hashRegion(snap(), CARD_X, CARD_Y, CW, CH);
  check(base == hashRegion(snap(), CARD_X, TWIN_Y, CW, CH), "the two copies must start identical");

  // 再跑 3 帧：card 静置 ⇒ 自动烘焙成立（后面的改色才会走修复路径）。
  for (var f:int = 0; f < 3; f++) stage.render(W, H, "temp/autobake-patch.png");
  check(hashRegion(snap(), CARD_X, CARD_Y, CW, CH) == base,
        "a settled card must still match its live rendering");

  // ① 零散改色：card 走「保留表面 + 有限脏矩形」的原地修复。
  repaintLamp(0x00CC00);
  rebuildTwin();
  renderAndCompare("sporadic patch");
  // 改的确实是那盏灯（否则上面的比较可能两边都没变，是空断言）。
  var lampPx:uint = snap().getPixel(CARD_X + 34, CARD_Y + 34) & 0xFFFFFF;
  check(lampPx == 0x00CC00, "the patched rect must show the new colour; got 0x" + lampPx.toString(16));

  // ② 连续 5 帧改色（模拟每帧都在变的子树）：第 2 帧起退回活态，画面不许停、不许花。
  for (var i:int = 0; i < 5; i++) {
    repaintLamp(i % 2 == 0 ? 0x3366FF : 0xFFAA00);
    rebuildTwin();
    renderAndCompare("continuous change #" + i);
  }

  // ③ 收尾后再来一次零散改色：回到修复路径，仍然逐像素正确。
  repaintLamp(0xFFFFFF);
  rebuildTwin();
  renderAndCompare("sporadic patch after churn");
  var last:uint = snap().getPixel(CARD_X + 34, CARD_Y + 34) & 0xFFFFFF;
  check(last == 0xFFFFFF, "the final colour must win; got 0x" + last.toString(16));

  trace("autobake-patch: retained-surface repair verified (" + base + ")");
}