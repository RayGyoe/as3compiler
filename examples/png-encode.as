// png-encode.as — BitmapData.encode PNG contract (stage 421, plan A1).
//
// adl 51.4.1 measured (temp/pngprobe/): encode has exactly THREE parameters
// (rect, compressor, byteArray=null) -- there is NO byteArrayOffset. It writes the
// encoded bytes at the ByteArray's CURRENT position, advancing position and
// auto-extending length (writeBytes semantics, overwriting existing bytes). Null
// rect/compressor raise TypeError #2007; a null byteArray is a silent no-op (it is
// optional). PNG is lossless for OPAQUE pixels; semi-transparent pixels go through
// a premultiply round-trip in BOTH AIR and this build's Skia encoder, so the exact
// RGB of low-alpha pixels is not preserved (AIR's own getPixel32 is premultiplied
// and lossy too). This example therefore asserts exact round-trip on opaque pixels
// (the real app's snapshot case) and alpha preservation on semi-transparent ones.
import flash.display.BitmapData;
import flash.display.Bitmap;
import flash.display.Loader;
import flash.display.PNGEncoderOptions;
import flash.geom.Rectangle;
import flash.utils.ByteArray;
import flash.events.Event;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- opaque source: exact round-trip ---
var orig:BitmapData = new BitmapData(4, 3, true, 0xFF000000);
var cols:Array = [0xFFFF0000, 0xFF00FF00, 0xFF0000FF, 0xFFFFFF00,
                  0xFFABCDEF, 0xFF123456, 0xFF000000, 0xFFFFFFFF,
                  0xFF808080, 0xFF010203, 0xFFFEFDFC, 0xFF7F7F7F];
for (var y:int = 0; y < 3; y++) for (var x:int = 0; x < 4; x++) orig.setPixel32(x, y, cols[y * 4 + x]);

// --- T1: writes at current position, advances it, zero-fills the gap ---
var enc:ByteArray = new ByteArray();
enc.position = 3;
orig.encode(new Rectangle(0, 0, 4, 3), new PNGEncoderOptions(), enc);
check(enc.length == enc.position, "T1 length == position after encode");
check(enc.length > 8, "T1 produced a non-trivial PNG");
enc.position = 0;
check(enc.readUnsignedByte() == 0 && enc.readUnsignedByte() == 0 && enc.readUnsignedByte() == 0, "T1 gap before position zero-filled");
check(enc.readUnsignedByte() == 0x89 && enc.readUnsignedByte() == 0x50 && enc.readUnsignedByte() == 0x4E && enc.readUnsignedByte() == 0x47, "T1 PNG magic 89 50 4E 47");

// --- T2: overwrites at position over a prefill ---
var ba2:ByteArray = new ByteArray();
ba2.writeUnsignedInt(0xAAAAAAAA); ba2.writeByte(0xBB);
ba2.position = 2;
orig.encode(new Rectangle(0, 0, 4, 3), new PNGEncoderOptions(), ba2);
check(ba2.length == ba2.position, "T2 length == position");
ba2.position = 0;
check(ba2.readUnsignedByte() == 0xAA && ba2.readUnsignedByte() == 0xAA, "T2 bytes before position preserved");
check(ba2.readUnsignedByte() == 0x89 && ba2.readUnsignedByte() == 0x50, "T2 PNG magic at position 2");

// --- T3: partial rect encodes a smaller image ---
var ba3:ByteArray = new ByteArray();
orig.encode(new Rectangle(1, 1, 2, 2), new PNGEncoderOptions(), ba3);
check(ba3.length > 8 && ba3.length < enc.length, "T3 partial rect smaller than full");

// --- T4/T6: null compressor / null rect -> TypeError #2007 ---
var ba4:ByteArray = new ByteArray();
var threwComp:Boolean = false;
try { orig.encode(new Rectangle(0, 0, 4, 3), null, ba4); } catch (e4:Error) { threwComp = (e4.errorID == 2007); }
check(threwComp, "T4 null compressor raises #2007");
var ba6:ByteArray = new ByteArray();
var threwRect:Boolean = false;
try { orig.encode(null, new PNGEncoderOptions(), ba6); } catch (e6:Error) { threwRect = (e6.errorID == 2007); }
check(threwRect, "T6 null rect raises #2007");

// --- T5: null byteArray is a silent no-op ---
orig.encode(new Rectangle(0, 0, 4, 3), new PNGEncoderOptions(), null);

// --- round-trip: opaque pixels exact ---
var rt:ByteArray = new ByteArray();
orig.encode(new Rectangle(0, 0, 4, 3), new PNGEncoderOptions(), rt);
rt.position = 0;
var loader:Loader = new Loader();
var done:Boolean = false;
var mism:int = 0;
loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
  var bd:BitmapData = Bitmap(loader.content).bitmapData;
  check(bd.width == 4 && bd.height == 3, "RT decoded dimensions");
  for (var yy:int = 0; yy < 3; yy++) for (var xx:int = 0; xx < 4; xx++) {
    if (orig.getPixel32(xx, yy) != bd.getPixel32(xx, yy)) mism++;
  }
  done = true;
});
loader.loadBytes(rt);
tickTimers();
check(done, "RT decode completed");
check(mism == 0, "RT opaque pixels round-trip exactly (mism=" + mism + ")");

// --- semi-transparent: alpha preserved (RGB premultiply rounding is expected) ---
var semi:BitmapData = new BitmapData(2, 1, true, 0x00000000);
semi.setPixel32(0, 0, 0x80FF0000);
semi.setPixel32(1, 0, 0x4000FF00);
var sb:ByteArray = new ByteArray();
semi.encode(new Rectangle(0, 0, 2, 1), new PNGEncoderOptions(), sb);
sb.position = 0;
var loader2:Loader = new Loader();
var done2:Boolean = false;
var alphaOk:Boolean = true;
loader2.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
  var bd:BitmapData = Bitmap(loader2.content).bitmapData;
  if ((bd.getPixel32(0, 0) >>> 24) != 0x80) alphaOk = false;
  if ((bd.getPixel32(1, 0) >>> 24) != 0x40) alphaOk = false;
  done2 = true;
});
loader2.loadBytes(sb);
tickTimers();
check(done2, "semi decode completed");
check(alphaOk, "semi-transparent alpha channel preserved");

trace("png-encode ok");