// bakecrisp.as — 阶段一百二十八：烘焙分辨率 + `BitmapData.draw` 几何口径（批次 D）。
//
// 全部期望值来自 `adl 51.4.1` 的**离屏**实测（证据台 temp/bakeprobe/：20 行三端
// adl == native == web 逐行一致），三条判据各自对应一行 adl 输出：
//   · 缓存开 vs 关**逐像素相同**（adl 在 k=1/2/3 与「祖先缩放」两态 pixdiff=0 maxdiff=0）
//     —— 这是 row 7927 的验收口径（烘焙面必须按目标画布总缩放取，回贴才 1:1）；
//   · `bd.draw(field, scale(k))` 的墨迹 = width*k + 1 × height*k + 1，边框**恒 1 位图像素**
//     （adl: k=1 41x21 / k=2 81x41 / k=3 121x61，line=1）—— 源矩形的 +1 是位图像素，
//     且对象按矩阵缩放**重新栅格化**（不是把 1× 栅格放大）；
//   · `bd.draw(container)` **忽略容器自身变换**（adl: cont.scale=2 仍是 41x21；再加
//     mat=3 是 121x61，即只吃矩阵、两者不相乘）。
//
// 编译：as-aot examples/bakecrisp.as --manifest examples/bakecrisp.build.json --run
//
// 离屏（不进显示列表、不上屏），故 harness 里不需要窗口；需要 Skia 才有像素。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.geom.Matrix;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var BW:int = 240;   // 目标位图尺寸（够放下 k=3 的 121x61）
var FW:int = 40;    // 字段逻辑尺寸
var FH:int = 20;

function newField():TextField {
  var tf:TextField = new TextField();
  tf.text = "Xx";
  tf.width = FW;
  tf.height = FH;
  tf.border = true;
  tf.borderColor = 0x000000;
  tf.background = false;
  tf.defaultTextFormat = new TextFormat("_typewriter", 12, 0x000000);
  return tf;
}

// 墨迹包围盒（alpha>8 的像素范围），返回 "WxH"，与原探针的 scan() 同口径。
function inkSize(bd:BitmapData):String {
  var x0:int = -1, y0:int = -1, x1:int = -1, y1:int = -1;
  for (var y:int = 0; y < BW; y++) {
    for (var x:int = 0; x < BW; x++) {
      if (((bd.getPixel32(x, y) >>> 24) & 0xFF) > 8) {
        if (x0 < 0 || x < x0) x0 = x;
        if (y0 < 0 || y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x0 < 0) return "0x0";
  return (x1 - x0 + 1) + "x" + (y1 - y0 + 1);
}

// 左边界线宽：在墨迹**竖直中点**那一行，从最左墨迹列起连续 alpha>128 的长度（位图像素）。
// 与原探针 scan() 的 `line>128` 同口径（adl: 任何 k 下都是 1）。
function borderThickness(bd:BitmapData):int {
  var minX:int = -1, minY:int = -1, maxY:int = -1;
  for (var y:int = 0; y < BW; y++) {
    for (var x:int = 0; x < BW; x++) {
      if (((bd.getPixel32(x, y) >>> 24) & 0xFF) > 8) {
        if (minX < 0 || x < minX) minX = x;
        if (minY < 0) minY = y;
        maxY = y;
      }
    }
  }
  if (minX < 0) return 0;
  var my:int = int((minY + maxY) / 2);
  var n:int = 0;
  var p:int = minX;
  while (p < BW && (((bd.getPixel32(p, my) >>> 24) & 0xFF) > 128)) { n++; p++; }
  return n;
}

function diffCount(a:BitmapData, b:BitmapData):int {
  var n:int = 0;
  for (var y:int = 0; y < BW; y++) {
    for (var x:int = 0; x < BW; x++) {
      if (a.getPixel32(x, y) != b.getPixel32(x, y)) n++;
    }
  }
  return n;
}

function drawInto(src:DisplayObject, m:Matrix):BitmapData {
  var bd:BitmapData = new BitmapData(BW, BW, true, 0x00000000);
  bd.draw(src, m);
  return bd;
}

// ---- 1. TextField 分支：源矩形 = width*k+1 × height*k+1，边框恒 1 位图像素 ----
var tf:TextField = newField();
check(inkSize(drawInto(tf, new Matrix(1, 0, 0, 1, 0, 0))) == "41x21", "tf mat1 ink 41x21");
check(inkSize(drawInto(tf, new Matrix(2, 0, 0, 2, 0, 0))) == "81x41", "tf mat2 ink 81x41");
check(inkSize(drawInto(tf, new Matrix(3, 0, 0, 3, 0, 0))) == "121x61", "tf mat3 ink 121x61");
check(borderThickness(drawInto(tf, new Matrix(2, 0, 0, 2, 0, 0))) == 1, "tf mat2 border 1px");
check(borderThickness(drawInto(tf, new Matrix(3, 0, 0, 3, 0, 0))) == 1, "tf mat3 border 1px");

// ---- 2. 忽略 source 自身变换：容器缩放到 2 仍然按 1x 出墨 ----
var cont:Sprite = new Sprite();
cont.addChild(tf);
cont.scaleX = 2; cont.scaleY = 2;
check(inkSize(drawInto(cont, new Matrix(1, 0, 0, 1, 0, 0))) == "41x21", "cont scale2 ignored (41x21)");
check(inkSize(drawInto(cont, new Matrix(3, 0, 0, 3, 0, 0))) == "121x61", "cont scale2 + mat3 = matrix only");
cont.scaleX = 1; cont.scaleY = 1;

// ---- 3. 烘焙分辨率：缓存开 vs 关逐像素相同（含祖先缩放 2） ----
var outer:Sprite = new Sprite();
var inner:Sprite = new Sprite();
inner.addChild(tf);
outer.addChild(inner);

function bakePair(label:String):void {
  tf.cacheAsBitmap = false;
  var direct:BitmapData = drawInto(outer, new Matrix(1, 0, 0, 1, 0, 0));
  tf.cacheAsBitmap = true;
  var baked:BitmapData = drawInto(outer, new Matrix(1, 0, 0, 1, 0, 0));
  var d:int = diffCount(direct, baked);
  trace("bakecrisp " + label + ": ink=" + inkSize(baked) + " border=" + borderThickness(baked) + " pixdiff=" + d);
  check(d == 0, label + ": cached render must be pixel-identical to the direct one");
  tf.cacheAsBitmap = false;
}

var k:int;
for (k = 1; k <= 3; k++) {
  inner.scaleX = k; inner.scaleY = k;
  bakePair("ancestor scale " + k);
  // 祖先缩放 k 下墨迹 = width*k+1（边框仍是 1 位图像素，adl 口径）
  check(borderThickness(drawInto(outer, new Matrix(1, 0, 0, 1, 0, 0))) == 1, "ancestor scale " + k + ": border 1px");
}
inner.scaleX = 1; inner.scaleY = 1;

// ---- 4. 几何内容（非文本）在 scale=2 下的烘焙保真 ----
var sh:Shape = new Shape();
sh.graphics.beginFill(0x000000, 1.0);
sh.graphics.drawRect(0, 0, 1, 20);
sh.graphics.drawRect(10, 0, 21, 1);
sh.graphics.drawRect(4, 4, 3, 3);
sh.graphics.endFill();
var shapeHolder:Sprite = new Sprite();
shapeHolder.addChild(sh);
sh.scaleX = 2; sh.scaleY = 2;

sh.cacheAsBitmap = false;
var s1:BitmapData = drawInto(shapeHolder, new Matrix(1, 0, 0, 1, 0, 0));
sh.cacheAsBitmap = true;
var s2:BitmapData = drawInto(shapeHolder, new Matrix(1, 0, 0, 1, 0, 0));
trace("bakecrisp shape scale2: ink=" + inkSize(s2) + " pixdiff=" + diffCount(s1, s2));
check(diffCount(s1, s2) == 0, "shape scale2: cached render must match the direct one");
check(inkSize(s2) == "62x40", "shape scale2 ink 62x40");

trace("bakecrisp: all checks passed");