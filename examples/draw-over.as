// draw-over.as — BitmapData.draw() 必须把源**合成在**目标之上（SourceOver），而不是替换目标。
//
// 背景（差异项 D30，阶段一百六十三）：我们的 draw() 采样循环直接 `dp[...] = 源像素`，并且在源
// 无覆盖处写 0 —— 于是「往一张**已有内容**的位图上画」会把目标擦掉。AIR 是 SourceOver：
// 画不到的地方**原样保留**。adl 51.4.1 数值 oracle（temp/drawprobe/，两边跑同一份源码）：
//
//   A 目标绿(00ff00) + draw(带覆盖的源)   (10,10)=ff0000（画上的）   (110,60)=00ff00（**保留**）
//   B draw(空 Sprite) 盖在蓝目标上        (8,8)=0000ff（**原地不动**）
//   C 50% 红盖在不透明蓝上                (5,5)=7f0080（正是 SourceOver）
//
// 我们修前：A 的 (110,60)=000000、B=000000（整张被清空）、C=ff0000（alpha 被丢）。
// 只往**新建的透明**位图上画（应用里绝大多数烘焙）两态本来就是同一个像素，故一直没暴露。
//
// 纯 C 构建没有光栅后端（as_skia_* 是空桩，draw() 不产生像素），此时跳过断言。
// 编译（Skia 模式）：
//   as-aot examples/draw-over.as --manifest examples/draw-over.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// A：目标先填空绿，再画一个只覆盖左上角 (0,0)-(8,8) 的源。
var bd:BitmapData = new BitmapData(64, 32, false, 0x00FF00);
var box:Sprite = new Sprite();
box.x = 100;                        // draw() 忽略源自身的变换（adl 实测），给个非 0 值做对照
box.y = 50;
var sq:Shape = new Shape();
sq.graphics.beginFill(0xFF0000);
sq.graphics.drawRect(0, 0, 8, 8);
sq.graphics.endFill();
box.addChild(sq);
bd.draw(box);

// B：往蓝目标上画一个**空** Sprite —— 什么都不该变。
var bd2:BitmapData = new BitmapData(16, 16, false, 0x0000FF);
bd2.draw(new Sprite());

// C：半透明源盖在不透明目标上 —— SourceOver 的混合值。
var half:Shape = new Shape();
half.graphics.beginFill(0xFF0000, 0.5);
half.graphics.drawRect(0, 0, 10, 10);
half.graphics.endFill();
var bd3:BitmapData = new BitmapData(16, 16, false, 0x0000FF);
bd3.draw(half);

var painted:uint = bd.getPixel(2, 2) & 0xFFFFFF;
if (painted == 0x00FF00) {
  // 没有光栅后端：draw() 是 no-op，三张位图都还是初始填充色。
  trace("draw-over: skipped (no raster backend)");
} else {
  check(painted == 0xFF0000,
        "the source must be painted where it has coverage (got 0x" + painted.toString(16) + ", want 0xff0000)");
  var kept:uint = bd.getPixel(40, 20) & 0xFFFFFF;
  check(kept == 0x00FF00,
        "the destination must be KEPT where the source has no coverage: draw() composites, it does not"
        + " replace the bitmap (got 0x" + kept.toString(16) + ", want 0x00ff00)");
  var emptyKept:uint = bd2.getPixel(8, 8) & 0xFFFFFF;
  check(emptyKept == 0x0000FF,
        "drawing an empty source must leave the destination untouched (got 0x" + emptyKept.toString(16) + ", want 0x0000ff)");
  var mixed:uint = bd3.getPixel(5, 5) & 0xFFFFFF;
  check(mixed == 0x7F0080,
        "a 50% source over an opaque destination must blend SourceOver (got 0x" + mixed.toString(16) + ", want 0x7f0080)");
  trace("draw-over: draw() composites over the destination — all assertions passed");
}
