// Pixel masking by a Bitmap/TextField's ALPHA (stage 427, D1). A vector mask is a
// clipPath, but a Bitmap/TextField has no outline -- its pixels are the stencil.
// AIR (adl 51.4.1) applies a pixel mask only when the masked object sets
// cacheAsBitmap: with cacheAsBitmap on the mask TOO it is a soft ALPHA mask, with
// cacheAsBitmap on the content ALONE it is a HARD binary stencil (any coverage ->
// full opacity). Without cacheAsBitmap on the content, draw() applies no pixel mask.
// The binary stencil is pinned exactly; the soft alpha is pinned as "clearly partial"
// (its exact value drifts by a rounding step between text/render backends).
import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.geom.Rectangle;

function alphaOf(p:uint):int { return (p >>> 24) & 0xFF; }

// A circle bitmap mask: opaque disk r=60 at (100,100), transparent elsewhere.
var bmd:BitmapData = new BitmapData(200, 200, true, 0x00000000);
var circ:Shape = new Shape();
circ.graphics.beginFill(0xFFFFFF);
circ.graphics.drawCircle(100, 100, 60);
circ.graphics.endFill();
bmd.draw(circ);

function redContent():Shape {
  var s:Shape = new Shape();
  s.graphics.beginFill(0xFF0000);
  s.graphics.drawRect(0, 0, 200, 200);
  s.graphics.endFill();
  return s;
}

// --- binary stencil: cacheAsBitmap on the content only ---
var content:Shape = redContent();
var holder:Sprite = new Sprite();
holder.addChild(content);
var maskBmp:Bitmap = new Bitmap(bmd);
holder.addChild(maskBmp);
content.cacheAsBitmap = true;
content.mask = maskBmp;
var shot:BitmapData = new BitmapData(200, 200, true, 0x00000000);
shot.draw(holder);
if (shot.getPixel32(100, 100) != 0xFFFF0000) throw new Error("binary mask: center should be opaque red");
if (shot.getPixel32(100, 60) != 0xFFFF0000) throw new Error("binary mask: inside disk should be opaque red");
if (alphaOf(shot.getPixel32(10, 10)) != 0) throw new Error("binary mask: outside disk should be transparent");
if (alphaOf(shot.getPixel32(100, 170)) != 0) throw new Error("binary mask: below disk should be transparent");

// --- half-alpha mask: left half alpha 128, right half opaque ---
var half:BitmapData = new BitmapData(200, 200, true, 0x00000000);
half.fillRect(new Rectangle(0, 0, 100, 200), 0x80FFFFFF);
half.fillRect(new Rectangle(100, 0, 100, 200), 0xFFFFFFFF);

// content-only cached => BINARY stencil: the half-alpha region becomes fully opaque.
var c2:Shape = redContent();
var h2:Sprite = new Sprite();
h2.addChild(c2);
var mb2:Bitmap = new Bitmap(half);
h2.addChild(mb2);
c2.cacheAsBitmap = true;
c2.mask = mb2;
var s2:BitmapData = new BitmapData(200, 200, true, 0x00000000);
s2.draw(h2);
if (s2.getPixel32(50, 100) != 0xFFFF0000) throw new Error("binary stencil: half-alpha mask region must be fully opaque");
if (s2.getPixel32(150, 100) != 0xFFFF0000) throw new Error("binary stencil: opaque mask region must be fully opaque");

// both cached => SOFT ALPHA mask: the half-alpha region keeps partial alpha.
var c3:Shape = redContent();
var h3:Sprite = new Sprite();
h3.addChild(c3);
var mb3:Bitmap = new Bitmap(half);
h3.addChild(mb3);
c3.cacheAsBitmap = true;
mb3.cacheAsBitmap = true;
c3.mask = mb3;
var s3:BitmapData = new BitmapData(200, 200, true, 0x00000000);
s3.draw(h3);
var ha:int = alphaOf(s3.getPixel32(50, 100));
if (ha < 64 || ha > 192) throw new Error("soft alpha mask: half region should be partial alpha, got " + ha);
if (s3.getPixel32(150, 100) != 0xFFFF0000) throw new Error("soft alpha mask: opaque region must be fully opaque");

// --- no cacheAsBitmap on the content => no pixel mask applied (full rectangle) ---
var c4:Shape = redContent();
var h4:Sprite = new Sprite();
h4.addChild(c4);
var mb4:Bitmap = new Bitmap(half);
h4.addChild(mb4);
c4.mask = mb4;
var s4:BitmapData = new BitmapData(200, 200, true, 0x00000000);
s4.draw(h4);
if (s4.getPixel32(50, 100) != 0xFFFF0000) throw new Error("no cacheAsBitmap: draw() must not apply a pixel mask");

trace("pixel-mask: binary stencil + soft alpha + no-cache gating all correct");