// cacheAsBitmapMatrix (stage 428, D2). AIR caches the object AS IF transformed by this
// matrix, then blits the cache with the INVERSE -- so the final picture is unchanged
// (adl 51.4.1: identity/scale/translate matrices all pixel-identical to no matrix,
// temp/cabmprobe); only the cache RESOLUTION scales with the matrix (a 2x matrix bakes
// a 2x bitmap). It is a mobile/GPU-era feature; adl desktop CPU mode no-ops it (getter
// returns null). We honor the documented cache-resolution semantics and keep the
// getter round-trip. These assertions pin the picture-identity (the observable contract).
import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;
import flash.geom.Matrix;

function mk():Shape {
  var s:Shape = new Shape();
  s.graphics.beginFill(0xFF0000);
  s.graphics.drawRect(0, 0, 50, 50);
  s.graphics.endFill();
  s.graphics.beginFill(0x0000FF);
  s.graphics.drawRect(10, 10, 20, 20);
  s.graphics.endFill();
  return s;
}
function snap(o:Shape, w:int, h:int):BitmapData {
  var holder:Sprite = new Sprite();
  holder.addChild(o);
  var bd:BitmapData = new BitmapData(w, h, true, 0);
  bd.draw(holder);
  return bd;
}

// 1:1 -- a scale-2 cache matrix must not change the picture (inverse cancels).
var a:Shape = mk(); a.cacheAsBitmap = true;
var sa:BitmapData = snap(a, 60, 60);
var b:Shape = mk(); b.cacheAsBitmap = true;
b.cacheAsBitmapMatrix = new Matrix(2, 0, 0, 2, 0, 0);
var sb:BitmapData = snap(b, 60, 60);
if (sb.getPixel32(5, 5) != sa.getPixel32(5, 5)) throw new Error("scale matrix changed the picture at (5,5)");
if (sb.getPixel32(15, 15) != sa.getPixel32(15, 15)) throw new Error("scale matrix changed the picture at (15,15)");
if (sb.getPixel32(55, 55) != sa.getPixel32(55, 55)) throw new Error("scale matrix changed the picture at (55,55)");
if (sb.getPixel32(5, 5) != 0xFFFF0000) throw new Error("expected opaque red at (5,5)");
if (sb.getPixel32(15, 15) != 0xFF0000FF) throw new Error("expected opaque blue at (15,15)");

// getter round-trips what was set (our contract; adl desktop returns null).
var g:Matrix = b.cacheAsBitmapMatrix;
if (g == null || g.a != 2 || g.d != 2) throw new Error("cacheAsBitmapMatrix getter must round-trip the set matrix");

// scaled 2x -- with and without the matrix the picture is the same.
var c:Shape = mk(); c.scaleX = 2; c.scaleY = 2; c.cacheAsBitmap = true;
var sc:BitmapData = snap(c, 120, 120);
var d:Shape = mk(); d.scaleX = 2; d.scaleY = 2; d.cacheAsBitmap = true;
d.cacheAsBitmapMatrix = new Matrix(2, 0, 0, 2, 0, 0);
var sd:BitmapData = snap(d, 120, 120);
if (sd.getPixel32(30, 30) != sc.getPixel32(30, 30)) throw new Error("matrix changed the scaled picture at (30,30)");
if (sd.getPixel32(50, 50) != sc.getPixel32(50, 50)) throw new Error("matrix changed the scaled picture at (50,50)");
if (sd.getPixel32(110, 110) != sc.getPixel32(110, 110)) throw new Error("matrix changed the scaled picture at (110,110)");

// translation-only matrix also cancels.
var e:Shape = mk(); e.cacheAsBitmap = true;
e.cacheAsBitmapMatrix = new Matrix(1, 0, 0, 1, 5, 5);
var se:BitmapData = snap(e, 60, 60);
if (se.getPixel32(5, 5) != 0xFFFF0000) throw new Error("translation matrix changed the picture at (5,5)");
if (se.getPixel32(2, 2) != 0xFFFF0000) throw new Error("translation matrix changed the picture at (2,2)");

// identity matrix is the common case -- picture identical to no matrix.
var f:Shape = mk(); f.cacheAsBitmap = true;
f.cacheAsBitmapMatrix = new Matrix();
var sf:BitmapData = snap(f, 60, 60);
if (sf.getPixel32(15, 15) != 0xFF0000FF) throw new Error("identity matrix changed the picture");

trace("cache-matrix: picture identity (scale/translate/identity) + getter round-trip all correct");