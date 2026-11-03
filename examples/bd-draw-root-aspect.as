// bd-draw-root-aspect.as — `BitmapData.draw(displayObject)` 必须忽略**参数对象自己**的
// `visible` / `alpha`，但子对象照常生效（阶段三百六十一）。
//
// AIR 的实测口径（adl 51.4.1，逐像素统计 ink / alpha 和，见 temp/svgaprobe/VisProbe.as）：
//   * 根对象 visible=false        -> 1600 ink（照画），同一对象作为**子件**时 0 ink；
//   * 根对象 alpha=0 / 0.5        -> 1600 ink / alpha 和 408000（=1600*255，即全不透明），
//                                    而子件 alpha=0.5 的和是 203200、alpha=0 画 0；
//   * Bitmap 作为根、visible=false / alpha=0 -> 同样 400 ink 照画。
// 也就是说 draw() 只看对象内容，不看这个对象自己的外观状态；外观状态只在**后代**上生效。
//
// 真应用的链条：com.svgaplayer.Player.draw() 把整棵树放进 rootLayer，设
// `rootLayer.visible = false`，再用 `bitmapData.draw(rootLayer, ...)` 出图。修前 AOT 的
// `as_render_object` 开头就 `if (o == NULL || !o->visible) return;`，于是**每一帧都是空的**——
// 「高级礼物」既不报错也没有画面。
import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Bitmap;
import flash.display.BitmapData;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function ink(bd:BitmapData):int {
  var n:int = 0;
  for (var y:int = 0; y < bd.height; y++) {
    for (var x:int = 0; x < bd.width; x++) {
      if ((bd.getPixel32(x, y) >>> 24) != 0) n++;
    }
  }
  return n;
}

function sumA(bd:BitmapData):int {
  var n:int = 0;
  for (var y:int = 0; y < bd.height; y++) {
    for (var x:int = 0; x < bd.width; x++) {
      n += (bd.getPixel32(x, y) >>> 24);
    }
  }
  return n;
}

function render(o:Sprite, w:int, h:int):BitmapData {
  var bd:BitmapData = new BitmapData(w, h, true, 0);
  bd.draw(o, o.transform.matrix, null, null, null, true);
  return bd;
}

// ---- 1. 根不可见仍出图；同一对象作为子件时被跳过 ----
var root:Sprite = new Sprite();
var rect:Shape = new Shape();
rect.graphics.beginFill(0xFF0000);
rect.graphics.drawRect(0, 0, 40, 40);
rect.graphics.endFill();
root.addChild(rect);

check(ink(render(root, 40, 40)) == 1600, "a visible root rasterizes");
root.visible = false;
check(ink(render(root, 40, 40)) == 1600, "the ROOT's visible=false is ignored by draw()");

root.visible = true;
rect.visible = false;
check(ink(render(root, 40, 40)) == 0, "a CHILD's visible=false is still honoured");
rect.visible = true;

// ---- 2. 根 alpha 被忽略（全不透明），子件 alpha 生效 ----
root.alpha = 0;
check(ink(render(root, 40, 40)) == 1600 && sumA(render(root, 40, 40)) == 408000,
  "the ROOT's alpha=0 is ignored (drawn fully opaque)");
root.alpha = 0.5;
check(sumA(render(root, 40, 40)) == 408000, "the ROOT's alpha=0.5 is ignored as well");
root.alpha = 1;

rect.alpha = 0.5;
check(sumA(render(root, 40, 40)) == 203200, "a CHILD's alpha=0.5 still blends");
rect.alpha = 0;
check(ink(render(root, 40, 40)) == 0, "a CHILD's alpha=0 still paints nothing");
rect.alpha = 1;

// ---- 3. Bitmap 作为根同样忽略 visible / alpha ----
var bmd:BitmapData = new BitmapData(20, 20, true, 0xFF00FF00);
var bmp:Bitmap = new Bitmap(bmd);
bmp.visible = false;
var b1:BitmapData = new BitmapData(20, 20, true, 0);
b1.draw(bmp, bmp.transform.matrix, null, null, null, true);
check(ink(b1) == 400, "an invisible Bitmap root still rasterizes");
bmp.visible = true;
bmp.alpha = 0;
var b2:BitmapData = new BitmapData(20, 20, true, 0);
b2.draw(bmp, bmp.transform.matrix, null, null, null, true);
check(ink(b2) == 400, "a fully transparent Bitmap root is drawn opaque");

// ---- 4. draw() 之后对象状态必须原样还回去（raster 期间是临时改的）----
root.visible = false;
root.alpha = 0.25;
render(root, 40, 40);
check(root.visible == false && root.alpha == 0.25,
  "draw() restores the root's own visible/alpha afterwards");

trace("bd-draw-root-aspect: ok");