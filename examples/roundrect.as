// roundrect.as — Graphics.drawRoundRect 的四个圆角必须真的按半径画出来（G19，阶段二百六十七）。

//

// 背景（缺口 G19，asaotui/compiler-gaps.md）：drawRoundRect 一直是

//   `{ (void)ellipseWidth; (void)ellipseHeight; drawRect(...); }`

// 也就是**静默丢掉两个半径参数**，把圆角矩形画成直角矩形。Skia 胶水层连图元都没有

// （只有 addRect/addCircle/addOval），所以这既是 emit 的桩，也是胶水层的缺口。

//

// 语义全部实测（adl 51.4.1，temp/g16g19g20/ab-round.cjs 两边跑同一份源码：

// Round.as 每行报一次左/右边缘，RoundArgs.as 报参数契约）：

//   * 圆角椭圆就是 ellipseWidth x ellipseHeight ⇒ 半径 (ew/2, eh/2)，且**两轴独立**：

//     40x40 上 ew=20/eh=10 的首行左边缘是 6，而 ew=eh=12（半径 6/6）是 4；

//   * 每个半径被夹到半个盒子：ew=eh=80 在 40x40 上等价于半径 20/20；

//   * ellipseHeight 省略或为 NaN 时取 ellipseWidth（AS3 默认值就是 NaN）；

//     ellipseWidth 为 NaN 是 ArgumentError #2004（实测，不是猜的）；

//   * 负的 ellipseWidth/Height：AIR 会把釉色溢到盒子外面 1~2 px（它自己的三次曲线自交），

//     我们按「直角」处理 —— 这是**唯一**与 AIR 不同的地方，登记在 compiler-gaps.md G19；

//   * w/h 为负是镜像盒子（与 drawEllipse 同口径）；w/h 为 0 什么都不画。

//

// 像素只有 Skia 构建才有（纯 C 构建 as_skia_* 是空桩），此时整段断言跳过。

// 编译：

//   as-aot examples/roundrect.as --manifest examples/roundrect.build.json



function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }



function fresh(w:int, h:int):BitmapData { return new BitmapData(w, h, true, 0x00000000); }



function fill(shape:Shape):void { shape.graphics.beginFill(0x3366CC, 1.0); }



// 画一个圆角矩形（左上角在 0,0），withEh=false 时走五参数重载。

function rrect(w:Number, h:Number, ew:Number, eh:Number, withEh:Boolean):BitmapData {

  var s:Shape = new Shape();

  fill(s);

  if (withEh) s.graphics.drawRoundRect(0, 0, w, h, ew, eh);

  else s.graphics.drawRoundRect(0, 0, w, h, ew);

  s.graphics.endFill();

  var bd:BitmapData = fresh(int(w > 0 ? w : 40), int(h > 0 ? h : 40));

  bd.draw(s);

  return bd;

}



// 画在 (x,y)、尺寸可以给负的圆角矩形，画布加上 +off 的平移，负尺寸溢出也看得见。

function rrectAt(x:Number, y:Number, w:Number, h:Number, ew:Number, eh:Number, off:Number):BitmapData {

  var s:Shape = new Shape();

  fill(s);

  s.graphics.drawRoundRect(x, y, w, h, ew, eh);

  s.graphics.endFill();

  var bd:BitmapData = fresh(int(off * 2 + 40), int(off * 2 + 40));

  var m:Matrix = new Matrix();

  m.translate(off, off);

  bd.draw(s, m);

  return bd;

}



// 某一行第一个 / 最后一个 alpha >= 128 的像素（-1 = 整行空）。

function leftOf(bd:BitmapData, y:int):int {

  var x:int = 0;

  while (x < bd.width) {

    if (((bd.getPixel32(x, y) >> 24) & 0xFF) >= 128) return x;

    x++;

  }

  return -1;

}



function rightOf(bd:BitmapData, y:int):int {

  var x:int = bd.width - 1;

  while (x >= 0) {

    if (((bd.getPixel32(x, y) >> 24) & 0xFF) >= 128) return x;

    x--;

  }

  return -1;

}



// ---- 判定有没有光栅后端：正中心必须被填上 -----------------------------------

var probe:BitmapData = rrect(40, 40, 12, 12, true);

if (leftOf(probe, 20) < 0) {

  trace("roundrect: no raster backend (as_skia_* are stubs) -- assertions skipped");

} else {

  // ---- A) 半径 6/6：首行左边缘 4，第 4 行才归零（adl 实测，两边逐字节相同） ----

  check(leftOf(probe, 0) == 4, "ew=eh=12 row 0 left edge should be 4, got " + leftOf(probe, 0));

  check(rightOf(probe, 0) == 35, "ew=eh=12 row 0 right edge should be 35, got " + rightOf(probe, 0));

  check(leftOf(probe, 1) == 2, "row 1 left edge should be 2, got " + leftOf(probe, 1));

  check(leftOf(probe, 2) == 1, "row 2 left edge should be 1, got " + leftOf(probe, 2));

  check(leftOf(probe, 3) == 1, "row 3 left edge should be 1, got " + leftOf(probe, 3));

  check(leftOf(probe, 4) == 0, "row 4 left edge should be 0 (corner over), got " + leftOf(probe, 4));

  check(leftOf(probe, 20) == 0 && rightOf(probe, 20) == 39, "the middle row must be full width");

  // 角是空的：直角矩形会填 (0,0)。

  check((probe.getPixel32(0, 0) >> 24 & 0xFF) == 0, "the corner pixel (0,0) must stay empty");



  // ---- B) 两轴独立：ew=20/eh=10 是半径 10/5，首行左边缘 6 而不是 4 ----------

  //     半径两轴独立这一条由首行 6（vs 半径 6/6 的 4）证明；2、3 两行 AIR 报 2 和 0，

  //     我们报 1 和 1 —— 那两行的理想边缘在 1.34px / 0.46px 处，正好压在 alpha 50%

  //     阈值的两侧，两个光栅器的取整不同（temp/g16g19g20/ab-round.cjs 的解析判据里

  //     这两行我们距理想椭圆 0.66px、AIR 也 0.66px，各自都在 1px 内）。

  var indep:BitmapData = rrect(40, 40, 20, 10, true);

  check(leftOf(indep, 0) == 6, "ew=20 row 0 left edge should be 6 (radius 10), got " + leftOf(indep, 0));

  check(leftOf(indep, 1) == 3, "ew=20 row 1 left edge should be 3, got " + leftOf(indep, 1));

  check(leftOf(indep, 2) == 1, "ew=20 row 2 left edge should be 1, got " + leftOf(indep, 2));

  check(leftOf(indep, 4) == 0, "eh=10 row 4 left edge should be 0 (radius 5 over), got " + leftOf(indep, 4));



  // ---- C) 半径夹到半个盒子：80x80 与 40x40（半径 20/20）逐像素相同 ----------

  var huge:BitmapData = rrect(40, 40, 80, 80, true);

  var clampRef:BitmapData = rrect(40, 40, 40, 40, true);

  var sameClamp:Boolean = true;

  var cx:int = 0;

  while (cx < 40) {

    var cy:int = 0;

    while (cy < 40) {

      if (huge.getPixel32(cx, cy) != clampRef.getPixel32(cx, cy)) sameClamp = false;

      cy++;

    }

    cx++;

  }

  check(sameClamp, "ew=eh=80 must be clamped to radius 20 (identical to ew=eh=40)");

  check(leftOf(huge, 0) == 16, "radius 20 row 0 left edge should be 16, got " + leftOf(huge, 0));



  // ---- D) 0 半径就是直角矩形；负半径也是直角（我们与 AIR 唯一的差异，见文件头）

  var square:BitmapData = rrect(40, 40, 0, 0, true);

  check(leftOf(square, 0) == 0 && rightOf(square, 0) == 39, "ew=eh=0 must be a plain rectangle");

  var negative:BitmapData = rrect(40, 40, -8, -8, true);

  check(leftOf(negative, 0) == 0, "a negative radius draws a plain rectangle here");



  // ---- E) 省略 ellipseHeight（AS3 默认 NaN）等价于 ellipseHeight = ellipseWidth

  var five:BitmapData = rrect(40, 40, 12, 12, false);

  var sameFive:Boolean = true;

  cx = 0;

  while (cx < 40) {

    var cy2:int = 0;

    while (cy2 < 40) {

      if (five.getPixel32(cx, cy2) != probe.getPixel32(cx, cy2)) sameFive = false;

      cy2++;

    }

    cx++;

  }

  check(sameFive, "drawRoundRect(x, y, w, h, 12) must equal drawRoundRect(x, y, w, h, 12, 12)");

  var nanEh:BitmapData = rrect(40, 40, 12, Math.sqrt(-1), true);

  var sameNaN:Boolean = true;

  cx = 0;

  while (cx < 40) {

    var cy3:int = 0;

    while (cy3 < 40) {

      if (nanEh.getPixel32(cx, cy3) != probe.getPixel32(cx, cy3)) sameNaN = false;

      cy3++;

    }

    cx++;

  }

  check(sameNaN, "an explicit NaN ellipseHeight must fall back to ellipseWidth");



  // ---- F) ellipseWidth 是 NaN ⇒ ArgumentError #2004（adl 实测） --------

  var threw:int = 0;

  var s2:Shape = new Shape();

  try {

    s2.graphics.drawRoundRect(0, 0, 40, 40, Math.sqrt(-1), 12);

  } catch (e:ArgumentError) {

    threw = e.errorID;

  }

  check(threw == 2004, "a NaN ellipseWidth must throw ArgumentError #2004, got " + threw);



  // ---- G) 负的 w/h 是镜像盒子；w 或 h 为 0 什么都不画 -----------------------

  var mirrored:BitmapData = rrectAt(40, 40, -30, -30, 12, 12, 10);

  check(leftOf(mirrored, 30) == 20 && rightOf(mirrored, 30) == 49, "a -30x-30 rect at (40,40) must mirror to (10,10)-(40,40), got " + leftOf(mirrored, 30) + ".." + rightOf(mirrored, 30));
  check(leftOf(mirrored, 20) == 24, "the mirrored box's top row starts one radius in, got " + leftOf(mirrored, 20));

  var degenerate:BitmapData = rrectAt(0, 0, 0, 40, 12, 12, 10);

  check(leftOf(degenerate, 20) == -1, "a zero-width round rect must not paint anything");

  trace("roundrect: all assertions passed");

}