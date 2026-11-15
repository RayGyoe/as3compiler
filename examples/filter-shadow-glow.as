// BitmapData.applyFilter with DropShadowFilter and GlowFilter (stage 429 / A3):
// the source region is rasterized through the Skia image-filter seams (the same
// ones the DisplayObject.filters path uses) and blitted into the destination
// anchored at destPoint, with padding so the blur/shadow expands beyond the source
// rect as AIR does. BlurFilter keeps its CPU box-blur path; unknown filters no-op.
// Measured against adl (AIR 51.4.1): the shadow offset/blur, the glow halo and the
// hideObject shadow-only regime match; the glow fringe alpha agrees within blur
// tolerance. Run with --manifest filter-shadow-glow.build.json (Skia backend).
import flash.display.BitmapData;
import flash.filters.DropShadowFilter;
import flash.filters.GlowFilter;
import flash.filters.BlurFilter;
import flash.filters.BitmapFilter;
import flash.geom.Rectangle;
import flash.geom.Point;

function mkSrc():BitmapData {
  var s:BitmapData = new BitmapData(100, 100, true, 0x00000000);
  s.fillRect(new Rectangle(30, 30, 40, 40), 0xFFFF0000);
  return s;
}
function alpha(p:uint):int { return (p >>> 24) & 0xFF; }

// DropShadow: the source square lands at destPoint+(30,30)=(80,80); the shadow
// offsets to the bottom-right and blurs; far pixels stay transparent.
var dst:BitmapData = new BitmapData(200, 200, true, 0x00000000);
dst.applyFilter(mkSrc(), new Rectangle(0, 0, 100, 100), new Point(50, 50),
  new DropShadowFilter(10, 45, 0x000000, 1, 10, 10, 2, 1, false, false, false));
if (dst.getPixel32(100, 100) != 0xFFFF0000) throw new Error("DS source body must stay red");
if (dst.getPixel32(80, 80) != 0xFFFF0000) throw new Error("DS source top-left at destPoint+rect");
if (dst.getPixel32(160, 160) != 0) throw new Error("DS far field must stay transparent");
if (alpha(dst.getPixel32(128, 128)) == 0) throw new Error("DS shadow must extend past the square");

// Glow: a coloured halo surrounds the source body; the body itself stays red.
var dst2:BitmapData = new BitmapData(200, 200, true, 0x00000000);
dst2.applyFilter(mkSrc(), new Rectangle(0, 0, 100, 100), new Point(50, 50),
  new GlowFilter(0x00FF00, 1, 10, 10, 2, 1, false, false));
if (dst2.getPixel32(100, 100) != 0xFFFF0000) throw new Error("GL body must stay red");
var edge:uint = dst2.getPixel32(75, 100);
if (alpha(edge) == 0) throw new Error("GL halo must reach just outside the edge");
if ((edge & 0x00FF00) == 0) throw new Error("GL halo must carry the glow colour");
if (dst2.getPixel32(40, 100) != 0) throw new Error("GL far field must stay transparent");
// fringe alpha agrees with AIR (0x18) within blur tolerance
if (Math.abs(alpha(edge) - 0x18) > 12) throw new Error("GL fringe alpha out of tolerance: " + alpha(edge));

// hideObject: only the shadow is painted, no source body.
var dst3:BitmapData = new BitmapData(200, 200, true, 0x00000000);
dst3.applyFilter(mkSrc(), new Rectangle(0, 0, 100, 100), new Point(50, 50),
  new DropShadowFilter(10, 45, 0x000000, 1, 10, 10, 2, 1, false, false, true));
if (dst3.getPixel32(100, 100) != 0xFF000000) throw new Error("DS hideObject must paint shadow only");

// BlurFilter still works (CPU path) and an unknown filter is a value-only no-op.
var dst4:BitmapData = new BitmapData(200, 200, true, 0x00000000);
dst4.applyFilter(mkSrc(), new Rectangle(0, 0, 100, 100), new Point(50, 50), new BlurFilter(8, 8, 1));
if (alpha(dst4.getPixel32(100, 100)) == 0) throw new Error("BlurFilter must still blur the source");
var dst5:BitmapData = new BitmapData(200, 200, true, 0x00000000);
dst5.applyFilter(mkSrc(), new Rectangle(0, 0, 100, 100), new Point(50, 50), new BitmapFilter());
if (dst5.getPixel32(100, 100) != 0) throw new Error("unknown filter must be a no-op");

trace("filter-shadow-glow: pass");