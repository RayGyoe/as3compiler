// Stage 453: transferring semi-transparent content into an OPAQUE BitmapData
// (transparent=false). AIR stores pixels premultiplied and un-premultiplies on
// getPixel32; an opaque bitmap's alpha is FF so that read is identity, leaving the
// RGB darkened by the source alpha. Measured on adl 51.4.1 (temp/review86 premul
// sweep): copyPixels mergeAlpha=false premultiplies RGB round-half-up + forces FF;
// copyChannel of ALPHA into opaque is a no-op (alpha immutable FF). draw and
// mergeAlpha=true already composite premultiplied. Any mismatch throws (non-zero exit).
function expect(actual:uint, expected:uint, label:String):void {
  if (actual != expected) {
    throw new Error(label + ": got 0x" + actual.toString(16) + " want 0x" + expected.toString(16));
  }
  trace("ok " + label + " = 0x" + actual.toString(16));
}
var r:Rectangle = new Rectangle(0, 0, 1, 1);
var p:Point = new Point(0, 0);

// copyPixels mergeAlpha=false: source 0x80FF0000 -> opaque dest reads 0xFF800000
// (red FF premultiplied by alpha 0x80 -> 0x80, alpha forced FF).
var src:BitmapData = new BitmapData(1, 1, true, 0);
src.setPixel32(0, 0, 0x80FF0000);
var od:BitmapData = new BitmapData(1, 1, false, 0);
od.copyPixels(src, r, p);
expect(od.getPixel32(0, 0), 0xFF800000, "copyPixels opaque premul");

// round-half-up: source R=3, alpha 0x80 -> (3*128+127)/255 = 2.
var s3:BitmapData = new BitmapData(1, 1, true, 0);
s3.setPixel32(0, 0, (0x80 << 24) | (3 << 16));
var o3:BitmapData = new BitmapData(1, 1, false, 0);
o3.copyPixels(s3, r, p);
expect(o3.getPixel32(0, 0), 0xFF020000, "copyPixels opaque round-half-up");

// alphaBitmapData modulates the source alpha first (0x80*0x80>>8 = 0x40), then premul.
var mask:BitmapData = new BitmapData(1, 1, true, 0);
mask.setPixel32(0, 0, 0x80FFFFFF);
var om:BitmapData = new BitmapData(1, 1, false, 0);
om.copyPixels(src, r, p, mask, p, false);
expect(om.getPixel32(0, 0), 0xFF400000, "copyPixels opaque alphaBmp");

// A TRANSPARENT dest keeps the straight round-trip (no darkening).
var td:BitmapData = new BitmapData(1, 1, true, 0);
td.copyPixels(src, r, p);
expect(td.getPixel32(0, 0), 0x80FF0000, "copyPixels transparent keeps straight");

// mergeAlpha=true onto opaque blue: premultiplied source-over (R=0x80, B=0x7F).
var md:BitmapData = new BitmapData(1, 1, false, 0xFF0000FF);
md.copyPixels(src, r, p, null, null, true);
expect(md.getPixel32(0, 0), 0xFF80007F, "copyPixels opaque mergeAlpha");

// draw onto opaque also premultiplies.
var dd:BitmapData = new BitmapData(1, 1, false, 0);
dd.draw(src);
expect(dd.getPixel32(0, 0), 0xFF800000, "draw opaque premul");

// copyChannel ALPHA into opaque is a no-op: alpha stays FF (blue unchanged).
var cd:BitmapData = new BitmapData(1, 1, false, 0xFF0000FF);
cd.copyChannel(src, r, p, 8, 8);
expect(cd.getPixel32(0, 0), 0xFF0000FF, "copyChannel ALPHA opaque immutable");

trace("ALL OK");