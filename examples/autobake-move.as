// autobake-move.as — 位移不重烘：`x`/`y` 的写入只让**祖先**失效，被移动对象自己的烘焙必须留下来（阶段三百八十）。
//
// 背景：烘焙位图活在对象**自己的局部空间**里（表面带 translate(-bxo,-byo)，贴回时再套当前 CTM），
// 所以同一张位图在任意整数偏移下都是精确的 —— 位置一变，内容并没有变。阶段三百八十之前，
// `x`/`y` 的写点走 `as_mark_dirty`：被移动对象自己被标脏 ⇒ 缓存分支当帧丢掉烘焙、退回活态绘制，
// 下一帧指纹干净了又整块重烘。真机日志（335 秒、`ASC_BAKE_TRACE=1`）里一次小改动落在
// 354×841 的 auto-bake 边界内，就是 0.67 Mpx 的整块重烘；每帧都在动的子树（滚动/入场动画）
// 于是每两帧重烘一次，这正是「偶发卡一下」的来源。
//
// 现在 `x`/`y` 走 `as_mark_moved`：只把祖先链标脏（它在父的位图里换了位置，父的内容确实变了），
// 被移动对象保持 `_render_dirty = 0` 与 `_cache_valid = 1`，下一帧直接贴回旧位图。
//
// 本示例钉的是**像素**（源级结构钉在 test/unit/render.ts 的 render/MovedBake 组）。判据用
// 「同一份内容的两个副本」：`card` 会被自动烘焙并移走，`ref` 从一开始就静置在别处当**活态参照**，
// 两者内容完全相同 ⇒ 移动后的 card 区域必须与第 1 帧（尚未烘焙时）的 ref 区域逐像素相同。
//   ① 迁移到目标位置：贴回偏移必须正确（错贴会留在老位置或差一个像素）；
//   ② 老位置必须干净（不许留下没擦掉的旧位图）；
//   ③ 移回来同样相同 —— 缓存跨过两个方向的位移都不得带上旧偏移；
//   ④ 位移之后**内容**写入仍然要重画（`as_mark_moved` 不许吞掉真正的脏）：卡片里补一个绿方块，
//      该方块必须真的出现在画面上。
//
// 编译：as-aot examples/autobake-move.as --manifest examples/autobake-move.build.json --run
// 断言的是像素，纯 C 构建没有光栅后端（draw 是空桩），故与 autobake-origin.as 一样链 Skia；
// 没有后端时示例自检后跳过（自检与断言走同一条代码路径）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Stage;
import flash.display.BitmapData;
import flash.display.DisplayObject;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 一排反走样的圆：半径 6、圆心落在半像素上（6.5），边缘一定落在像素内部，
// 所以任何整体平移或重采样都会翻转像素（硬边矩形自身吸附到整像素，判别不出来）。
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

var W:int = 160;
var H:int = 80;
var stage:Stage = new Stage();
stage.stageWidth = W;
stage.stageHeight = H;

// root 只是给 bd.draw 一个绝对坐标的抓取口（x/y = 0）。
var root:Sprite = new Sprite();
stage.addChild(root);

// 被移动的卡片：内容 (0..45, 0..13)，起点 (10,10)。
var card:Sprite = new Sprite();
var art:Sprite = circles();
card.addChild(art);
card.x = 10;
card.y = 10;
root.addChild(card);

// 活态参照：同样的内容，静置在 (10,40)，永不移动。
var ref:Sprite = new Sprite();
var art2:Sprite = circles();
ref.addChild(art2);
ref.x = 10;
ref.y = 40;
root.addChild(ref);

// 卡片要搬去的位置（与 ref 错开，避免叠加时的半透明边缘混色）。
var DEST_X:int = 80;
var DEST_Y:int = 10;
var RW:int = 48;
var RH:int = 14;

function snap():BitmapData {
  var bd:BitmapData = new BitmapData(W, H, false, 0xFFFFFF);
  bd.draw(root);
  return bd;
}

// 区域签名：非白像素数 + 滚动哈希（哈希让任一像素变化都能翻掉它，失败信息又不会淹没日志）。
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

function sigAt(x0:int, y0:int):String {
  return hashRegion(snap(), x0, y0, RW, RH);
}

// 后端自检：参照物必须真的画出颜色（否则说明这个构建没有光栅后端）。
function hasBackend():Boolean {
  var bd:BitmapData = new BitmapData(20, 20, false, 0xFFFFFF);
  bd.draw(ref);
  return (bd.getPixel(6, 6) & 0xFFFFFF) != 0xFFFFFF;
}

// 第 1 帧：直接递归绘制（尚未烘焙）。三个区域都记下来。
stage.render(W, H, "temp/autobake-move.png");
var liveCard:String = sigAt(10, 10);
var liveRef:String = sigAt(10, 40);
var emptyDest:String = sigAt(DEST_X, DEST_Y);

// 连跑 6 帧：内容不变 ⇒ card / ref 都被自动烘焙，之后的帧走贴回路径。
for (var f:int = 0; f < 6; f++) stage.render(W, H, "temp/autobake-move.png");

if (!hasBackend()) {
  trace("autobake-move: skipped (no raster backend)");
} else {
  check(liveCard == liveRef, "the two copies must start identical; card=" + liveCard + " ref=" + liveRef);
  check(liveCard != emptyDest, "the destination region must start empty");
  check(sigAt(10, 10) == liveCard,
        "a settled card must still match its live rendering; live=" + liveCard + " baked=" + sigAt(10, 10));

  // ① 位移（整数像素：贴回相位不变，走的就是缓存贴回路径）。
  card.x = DEST_X;
  card.y = DEST_Y;
  stage.render(W, H, "temp/autobake-move.png");
  var moved:String = sigAt(DEST_X, DEST_Y);
  check(moved != emptyDest, "the card must actually move (otherwise the checks below are vacuous)");
  check(moved == liveRef,
        "a baked card moved by whole pixels must be pixel-identical to the same content painted live"
        + " at the destination; destination(live)=" + liveRef + " moved(baked)=" + moved);
  // ② 老位置必须干净：贴回是「画到新位置」，不是「再画一份」。
  check(sigAt(10, 10) == emptyDest, "the old position must be left empty; got " + sigAt(10, 10));

  // ③ 移回来：缓存必须跟着新偏移走，不能还贴着上一次的位置。
  card.x = 10;
  card.y = 10;
  stage.render(W, H, "temp/autobake-move.png");
  check(sigAt(10, 10) == liveCard, "moving back must restore the original picture; want=" + liveCard + " got=" + sigAt(10, 10));
  check(sigAt(DEST_X, DEST_Y) == emptyDest, "the destination must be empty again; got " + sigAt(DEST_X, DEST_Y));

  // ④ 位移之后内容仍然要重画：as_mark_moved 只放过「纯位移」，
  //    图形写入照旧标脏、照旧重画。补一个绿方块在卡片的局部 (0,0)：圆心离它 8.49 > 6，
  //    加点前这里是白的，加点后必须是绿的。
  art.graphics.beginFill(0x00CC00);
  art.graphics.drawRect(0, 0, 4, 4);
  art.graphics.endFill();
  stage.render(W, H, "temp/autobake-move.png");
  var got:uint = snap().getPixel(10, 10) & 0xFFFFFF;
  check(got == 0x00CC00,
        "a content write after a move must still repaint (green square missing); got 0x" + got.toString(16));

  trace("autobake-move: translation keeps the bake — assertions passed (" + liveCard + " / " + liveRef + ")");
}