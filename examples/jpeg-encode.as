// jpeg-encode.as — BitmapData.encode JPEG contract (stage 422, plan A2).
//
// adl 51.4.1 measured (temp/jpegprobe/): JPEGEncoderOptions.quality is a UINT
// defaulting to 80 (not 50). The constructor does NOT range-check
// (new JPEGEncoderOptions(-5) reads back 4294967291); encode itself raises
// RangeError #2006 when quality > 100. encode writes at the ByteArray's CURRENT
// position (writeBytes semantics), null rect/compressor raise #2007, null
// byteArray is a silent no-op. JPEG has no alpha: AIR drops it by taking the
// PREMULTIPLIED-over-black RGB (0x80FF0000 -> rgb 0x800000, alpha 255). JPEG is
// lossy, so round-trip assertions use a small per-channel tolerance; a solid
// colour round-trips essentially exactly. The encoder drives the libjpeg-turbo C
// API directly (the vendored libjpeg.lib carries the compressor symbols even
// though Skia's SkJpegEncoder wrapper is disabled) -- no Skia rebuild needed.
import flash.display.BitmapData;
import flash.display.Bitmap;
import flash.display.Loader;
import flash.display.JPEGEncoderOptions;
import flash.geom.Rectangle;
import flash.utils.ByteArray;
import flash.events.Event;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function chan(v:uint, shift:int):int { return (v >>> shift) & 0xFF; }
function near(a:int, b:int, tol:int):Boolean { var d:int = a - b; return d >= -tol && d <= tol; }

// --- T1: default quality is 80 (uint) ---
check(new JPEGEncoderOptions().quality == 80, "T1 default quality == 80");

// --- T7: constructor does not range-check; quality is uint ---
check(new JPEGEncoderOptions(101).quality == 101, "T7 ctor accepts 101");
check(new JPEGEncoderOptions(-5).quality == 4294967291, "T7 ctor wraps -5 to uint");

// --- opaque solid source ---
var solid:BitmapData = new BitmapData(4, 4, false, 0xFF3366CC);

// --- T2: writes at current position, advances it, zero-fills the gap, FFD8 magic ---
var enc:ByteArray = new ByteArray();
enc.position = 3;
solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(90), enc);
check(enc.length == enc.position, "T2 length == position after encode");
check(enc.length > 8, "T2 produced a non-trivial JPEG");
enc.position = 0;
check(enc.readUnsignedByte() == 0 && enc.readUnsignedByte() == 0 && enc.readUnsignedByte() == 0, "T2 gap zero-filled");
check(enc.readUnsignedByte() == 0xFF && enc.readUnsignedByte() == 0xD8, "T2 JPEG magic FF D8");

// --- T3: quality changes the output size (noisy image) ---
var noisy:BitmapData = new BitmapData(16, 16, false, 0xFF000000);
for (var ny:int = 0; ny < 16; ny++) for (var nx:int = 0; nx < 16; nx++) noisy.setPixel32(nx, ny, 0xFF000000 | ((nx * 37 + ny * 91) & 0xFFFFFF));
var q10:ByteArray = new ByteArray(); noisy.encode(new Rectangle(0, 0, 16, 16), new JPEGEncoderOptions(10), q10);
var q90:ByteArray = new ByteArray(); noisy.encode(new Rectangle(0, 0, 16, 16), new JPEGEncoderOptions(90), q90);
check(q10.length != q90.length, "T3 quality changes encoded size");
check(q90.length > q10.length, "T3 higher quality is larger for a noisy image");

// --- T4: null compressor / null rect -> #2007 ---
var threwComp:Boolean = false;
try { solid.encode(new Rectangle(0, 0, 4, 4), null, new ByteArray()); } catch (e4:Error) { threwComp = (e4.errorID == 2007); }
check(threwComp, "T4 null compressor raises #2007");
var threwRect:Boolean = false;
try { solid.encode(null, new JPEGEncoderOptions(), new ByteArray()); } catch (e6:Error) { threwRect = (e6.errorID == 2007); }
check(threwRect, "T4 null rect raises #2007");

// --- T5: null byteArray is a silent no-op ---
solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(), null);

// --- T6: encode validates quality 0..100 (>100 -> #2006, uint wrap caught) ---
var q101ok:Boolean = false;
try { solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(101), new ByteArray()); } catch (e101:Error) { q101ok = (e101.errorID == 2006); }
check(q101ok, "T6 quality 101 raises #2006");
var qnegOk:Boolean = false;
try { solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(-5), new ByteArray()); } catch (en:Error) { qnegOk = (en.errorID == 2006); }
check(qnegOk, "T6 quality -5 (uint wrap) raises #2006");
var q100:ByteArray = new ByteArray(); solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(100), q100);
check(q100.length > 8, "T6 quality 100 accepted");
var q0:ByteArray = new ByteArray(); solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(0), q0);
check(q0.length > 8, "T6 quality 0 accepted");
var qmut:JPEGEncoderOptions = new JPEGEncoderOptions(50); qmut.quality = 101;
var qmutOk:Boolean = false;
try { solid.encode(new Rectangle(0, 0, 4, 4), qmut, new ByteArray()); } catch (em:Error) { qmutOk = (em.errorID == 2006); }
check(qmutOk, "T6 mutated quality 101 raises #2006");

// --- T8: opaque solid round-trip (JPEG lossy, small tolerance) ---
var rt:ByteArray = new ByteArray();
solid.encode(new Rectangle(0, 0, 4, 4), new JPEGEncoderOptions(100), rt);
rt.position = 0;
var loader:Loader = new Loader();
var done:Boolean = false;
var maxDiff:int = 0;
loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
  var bd:BitmapData = Bitmap(loader.content).bitmapData;
  check(bd.width == 4 && bd.height == 4, "T8 decoded dimensions");
  for (var yy:int = 0; yy < 4; yy++) for (var xx:int = 0; xx < 4; xx++) {
    var a:uint = solid.getPixel32(xx, yy), b:uint = bd.getPixel32(xx, yy);
    for (var s:int = 0; s <= 16; s += 8) { var d:int = chan(a, s) - chan(b, s); if (d < 0) d = -d; if (d > maxDiff) maxDiff = d; }
  }
  done = true;
});
loader.loadBytes(rt);
tickTimers();
check(done, "T8 decode completed");
check(maxDiff <= 2, "T8 opaque solid round-trip within tolerance (maxDiff=" + maxDiff + ")");

// --- T9: semi-transparent -> premultiplied-over-black RGB, alpha 255 ---
var semi:BitmapData = new BitmapData(2, 2, true, 0x80FF0000);
var sb:ByteArray = new ByteArray();
semi.encode(new Rectangle(0, 0, 2, 2), new JPEGEncoderOptions(100), sb);
sb.position = 0;
var loader2:Loader = new Loader();
var done2:Boolean = false;
var semiOk:Boolean = false;
loader2.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
  var bd:BitmapData = Bitmap(loader2.content).bitmapData;
  var p:uint = bd.getPixel32(0, 0);
  // alpha becomes opaque; red is premultiplied by 0x80/0xFF -> ~0x80, green/blue ~0
  semiOk = (chan(p, 24) == 255) && near(chan(p, 16), 0x80, 4) && near(chan(p, 8), 0, 4) && near(chan(p, 0), 0, 4);
  done2 = true;
});
loader2.loadBytes(sb);
tickTimers();
check(done2, "T9 decode completed");
check(semiOk, "T9 semi-transparent -> premul-over-black RGB, alpha 255");

trace("jpeg-encode ok");