// stage61.as — flash.filters (v0.3.62): BitmapFilter abstract base + BlurFilter /
// DropShadowFilter / GlowFilter value bundles + BitmapFilterQuality constants +
// DisplayObject.filters accessor + BitmapData.applyFilter (BlurFilter box blur).
//
// These are reference types modeled in C as gc_alloc'd structs; clone() returns a
// NEW instance copying every field. BlurFilter rasterization is a separable
// repeated box blur; DropShadow/GlowFilter rasterization via applyFilter is
// deferred (applyFilter throws). DisplayObject.filters is a plain Array accessor,
// and render() now applies Blur/DropShadow/outer-Glow filters to a DisplayObject's
// subtree through Skia image filters (see emit.ts as_render_filtered).

function near(a:Number, b:Number):Boolean { return Math.abs(a - b) < 0.000001; }
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- BlurFilter: defaults + custom + clone ---
var bf:BlurFilter = new BlurFilter();
check(near(bf.blurX, 4) && near(bf.blurY, 4) && bf.quality == 1, "BlurFilter defaults (4,4,1)");
check(bf is BlurFilter && bf is BitmapFilter && bf is Object, "BlurFilter is BlurFilter/BitmapFilter/Object");

var bf2:BlurFilter = new BlurFilter(8, 6, 2);
check(near(bf2.blurX, 8) && near(bf2.blurY, 6) && bf2.quality == 2, "BlurFilter custom ctor");

var bc:BlurFilter = bf2.clone() as BlurFilter;
check(near(bc.blurX, 8) && near(bc.blurY, 6) && bc.quality == 2, "BlurFilter.clone copies fields");
check(bc != bf2, "BlurFilter.clone returns a new object");

// --- DropShadowFilter: defaults + custom + clone ---
var ds:DropShadowFilter = new DropShadowFilter();
check(near(ds.distance, 4) && near(ds.angle, 45), "DropShadowFilter distance/angle defaults");
check(ds.color == 0 && near(ds.alpha, 1), "DropShadowFilter color/alpha defaults");
check(near(ds.blurX, 4) && near(ds.blurY, 4) && near(ds.strength, 1) && ds.quality == 1, "DropShadowFilter blur/strength/quality defaults");
check(ds.inner == false && ds.knockout == false && ds.hideObject == false, "DropShadowFilter bool defaults false");
check(ds is DropShadowFilter && ds is BitmapFilter, "DropShadowFilter is BitmapFilter");

var ds2:DropShadowFilter = new DropShadowFilter(10, 90, 0xFF0000, 0.5, 8, 8, 2, 3, true, false, true);
check(near(ds2.distance, 10) && near(ds2.angle, 90) && ds2.color == 0xFF0000, "DropShadowFilter custom ctor (num)");
check(ds2.inner == true && ds2.hideObject == true && ds2.knockout == false, "DropShadowFilter custom ctor (bool)");

var dc:DropShadowFilter = ds2.clone() as DropShadowFilter;
check(near(dc.distance, 10) && dc.color == 0xFF0000 && dc.inner == true && dc.hideObject == true, "DropShadowFilter.clone copies fields");

// --- GlowFilter: defaults + clone ---
var gf:GlowFilter = new GlowFilter();
check(gf.color == 0xFF0000 && near(gf.alpha, 1), "GlowFilter color/alpha defaults");
check(near(gf.blurX, 6) && near(gf.blurY, 6) && near(gf.strength, 2) && gf.quality == 1, "GlowFilter blur/strength/quality defaults");
check(gf.inner == false && gf.knockout == false, "GlowFilter bool defaults false");

var gc2:GlowFilter = new GlowFilter(0x00FF00, 0.75, 3, 3, 1, 2, true, true);
var gc:GlowFilter = gc2.clone() as GlowFilter;
// Real AIR quantizes filter alpha to 8-bit fixed point (floor(alpha*255)/255),
// so 0.75 reads back as 191/255 == 0.7490196078431373.
check(gc.color == 0x00FF00 && near(gc.alpha, 191.0 / 255.0) && gc.inner == true && gc.knockout == true, "GlowFilter custom ctor + clone");

// --- BitmapFilterQuality constants ---
check(BitmapFilterQuality.LOW == 1 && BitmapFilterQuality.MEDIUM == 2 && BitmapFilterQuality.HIGH == 3, "BitmapFilterQuality constants");

// --- DisplayObject.filters accessor (faithful Array roundtrip) ---
var sp:Sprite = new Sprite();
var list:Array = [bf2, ds];
sp.filters = list;
var got:Array = sp.filters;
check(got != null && got.length == 2, "DisplayObject.filters roundtrip length");
check(got[0] is BlurFilter, "filters[0] is the BlurFilter we stored");
check(got[1] is DropShadowFilter, "filters[1] is the DropShadowFilter we stored");
sp.filters = [];
check(sp.filters.length == 0, "filters = [] clears the list");

// --- BitmapData.applyFilter (BlurFilter box blur) ---
// A uniform fill is invariant under a box blur, so a solid-color source stays
// solid after blurring — a deterministic, headless-safe assertion.
var src:BitmapData = new BitmapData(16, 16, false, 0x336699);
var dst:BitmapData = new BitmapData(16, 16, false, 0x000000);
var blur:BlurFilter = new BlurFilter(4, 4, 2);
dst.applyFilter(src, new Rectangle(0, 0, 16, 16), new Point(0, 0), blur);
check(dst.getPixel(7, 7) == 0x336699, "applyFilter BlurFilter preserves uniform color");

// DropShadow/GlowFilter rasterization is deferred: applyFilter throws.
var threw:Boolean = false;
try {
  dst.applyFilter(src, new Rectangle(0, 0, 4, 4), new Point(0, 0), new DropShadowFilter());
} catch (e:Error) { threw = true; }
check(threw, "applyFilter DropShadowFilter throws (deferred)");

trace("stage61: all flash.filters assertions passed");
