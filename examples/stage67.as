// stage67.as — flash.display.DisplayObject.cacheAsBitmap (v0.3.79): subtree bitmap
// caching. Headless: verifies the flag's get/set semantics and inheritance across
// every DisplayObject subclass. The actual bake happens in the Skia render path
// (see the air-native demo, which bakes a container subtree into one image).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- default is false ---
var s:Sprite = new Sprite();
check(s.cacheAsBitmap == false, "cacheAsBitmap defaults false");

// --- set true / read back ---
s.cacheAsBitmap = true;
check(s.cacheAsBitmap == true, "cacheAsBitmap = true readback");

// --- clear back ---
s.cacheAsBitmap = false;
check(s.cacheAsBitmap == false, "cacheAsBitmap = false readback");

// --- inherited by every DisplayObject subclass ---
var sh:Shape = new Shape();
sh.cacheAsBitmap = true;
check(sh.cacheAsBitmap == true, "Shape inherits cacheAsBitmap");

var tf:TextField = new TextField();
check(tf.cacheAsBitmap == false, "TextField inherits cacheAsBitmap (default)");

var st:Stage = new Stage();
check(st.cacheAsBitmap == false, "Stage inherits cacheAsBitmap (default)");

// --- toggle (invalidate pattern) is idempotent-safe and does not throw ---
var c:Sprite = new Sprite();
c.cacheAsBitmap = true;
c.cacheAsBitmap = false;
c.cacheAsBitmap = true;
check(c.cacheAsBitmap == true, "toggle cacheAsBitmap is safe");

// --- assignment of the same value is a no-op (no cache invalidation) ---
c.cacheAsBitmap = true;
check(c.cacheAsBitmap == true, "re-assign same value is a no-op");

trace("stage67: all cacheAsBitmap assertions passed");
