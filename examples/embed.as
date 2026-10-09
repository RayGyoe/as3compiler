// embed.as -- `[Embed]` metadata (阶段一百一十二, v0.4.85): a class member typed
// `Class` whose value is a generated class wrapping an asset compiled into the
// binary. This is how an AIR app ships images/sounds/raw data, and it is what
// away3d's skybox demo (examples/away3d-core/Basic_SkyBox.as) needs to start.
//
// The asset bytes are embedded VERBATIM (the original file), and the generated
// class extends the built-in class AIR's compiler picks for that asset type:
//     image  (.png/.jpg/.jpeg/.gif/.bmp) -> flash.display.Bitmap   (bitmapData)
//     sound  (.mp3, or mimeType audio/mpeg) -> flash.media.Sound
//     binary (mimeType=application/octet-stream, any extension) -> flash.utils.ByteArray
// An explicit mimeType WINS over the extension (measured: a .png declared
// application/octet-stream yields a ByteArray, temp/embedprobe6).
//
// AIR alignment (measured on adl 51.4.1, temp/embedprobe7/adl.txt):
//   * the generated class name is `<file>_<ext>$<hash>`; ours is
//     `Embed_<Class>_<field>` (deterministic and traceable in the C -- the hash
//     is not reproducible), so only getQualifiedClassName() differs.
//   * the constructor takes ZERO arguments: `new C(1, 2)` is ArgumentError #1063
//     ("Expected 0, got 2"), not a silent extra-argument call.
//   * a Class value is not an instance of the class it names: `var x:* = pic;
//     x is Class` is true while `x is Bitmap` is FALSE (the instance is the
//     Bitmap). away3d's Cast.bitmapData() branches on exactly that pair.
//   * `getDefinitionByName(getQualifiedClassName(pic)) === pic` and
//     `Object(instance).constructor === pic` both hold -- one class object per
//     class, shared by every route to it.
//   * Sound.length of the embedded mp3 is 417.9591836734694 ms, bytesTotal 6686
//     (the file size) -- identical to adl's.
//
// Build: this example links the Skia and miniaudio backends through
// embed.build.json, because an embedded image is decoded through Skia and an
// embedded mp3 through the audio seam. Without those the assets still compile,
// but the pixel and length checks cannot run.
//
// Semi-transparent pixels are the one measured divergence: we decode straight
// ARGB, AIR runs its own (lossy) straight<->premultiplied pair, so an alpha-255
// pixel matches adl exactly while [255,0,0,128] reads 0x80ff0000 here and
// 0x80fd0000 on adl (docs/zh-cn/embed.md §4).

import flash.display.*;
import flash.media.Sound;
import flash.utils.ByteArray;
import flash.utils.getQualifiedClassName;
import flash.utils.getDefinitionByName;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Assets {
  [Embed(source="embed-assets/px.png")]
  public static const px:Class;
  [Embed(source="embed-assets/px.png", mimeType="application/octet-stream")]
  public static const pxAsBytes:Class;
  [Embed(source="embed-assets/blob.bin", mimeType="application/octet-stream")]
  public static const blob:Class;
  [Embed(source="embed-assets/flap.mp3")]
  public static const tone:Class;
  [Embed(source="embed-assets/flap.mp3", mimeType="audio/mpeg")]
  public static const toneByMime:Class;
  // A non-static field: the value is bound by the instance constructor instead of
  // the static initializer, so both init paths are covered.
  [Embed(source="embed-assets/px.png")]
  private var instPic:Class;
  public function instBitmap():BitmapData { return (new instPic() as Bitmap).bitmapData; }
  public function instClass():Class { return instPic; }
}

// --- away3d's Cast.bitmapData() shape (away3d-core/src/away3d/utils/Cast.as) ---
// The reason the Class-value identity rules above matter: this is the sanctioned
// way an Away3D texture is recovered from an embedded asset, and it takes a `*`.
function likeCast(data:*):BitmapData {
  if (data == null) return null;
  if (data is Class) {
    try { data = new data; } catch (e:ArgumentError) { data = new data(0, 0); }
  }
  if (data is BitmapData) return data as BitmapData;
  if (data is Bitmap) {
    if ((data as Bitmap).hasOwnProperty("bitmapData")) return (data as Bitmap).bitmapData;
  }
  return null;
}

// --- image: the generated class is a Bitmap carrying a decoded BitmapData ------
var pxCls:Class = Assets.px;
var asAny:* = pxCls;
check(asAny is Class, "a Class value boxed into `*` is still `is Class`");
check(!(asAny is Bitmap), "a Class value is NOT an instance of the class it names");
check(!(asAny is Sound), "a Class value is not any other kind of instance either");

var pxCtor:Bitmap = new pxCls() as Bitmap;
check(pxCtor != null, "new <asset class>() yields the asset object");
check(pxCtor.hasOwnProperty("bitmapData"), "the generated Bitmap owns bitmapData");
var bd:BitmapData = pxCtor.bitmapData;
check(bd != null, "bitmapData is populated by the constructor");
check(bd.width == 6 && bd.height == 4, "embedded image keeps its intrinsic size");
check(bd.transparent, "a PNG with alpha is transparent (adl: true)");

// Opaque rows: byte-exact against the file AND against adl (the fidelity check).
// Row 0 is opaque primaries + white + black, row 1 deliberately odd 8-bit values.
var row0:Array = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xffffffff, 0xff000000];
var row1:Array = [0xff070809, 0xff804020, 0xff010203, 0xffc86432, 0xff112233, 0xfffafbfc];
for (var i:int = 0; i < 6; i++) {
  check(bd.getPixel32(i, 0) == row0[i], "row 0 pixel " + i + " is " + bd.getPixel32(i, 0).toString(16));
  check(bd.getPixel32(i, 1) == row1[i], "row 1 pixel " + i + " is " + bd.getPixel32(i, 1).toString(16));
}
// Semi-transparent row: alpha survives; the RGB keeps the stored value (adl
// drifts by 2-4 on these three, see the header note).
check(bd.getPixel32(0, 2) == 0x80ff0000, "alpha 128 kept, got " + bd.getPixel32(0, 2).toString(16));
check(bd.getPixel32(1, 2) == 0x4000ff00, "alpha 64 kept, got " + bd.getPixel32(1, 2).toString(16));
check(bd.getPixel32(2, 2) == 0xc80000ff, "alpha 200 kept, got " + bd.getPixel32(2, 2).toString(16));
check(bd.getPixel32(3, 2) == 0xff090909, "opaque pixel inside the alpha row is exact");
check(bd.getPixel32(5, 2) == 0x80ffffff, "alpha 128 white kept, got " + bd.getPixel32(5, 2).toString(16));
// Fully transparent row: adl reads 0 for all six, and so do we.
for (var x:int = 0; x < 6; x++) {
  check(bd.getPixel32(x, 3) == 0, "transparent row " + x + " reads 0, got " + bd.getPixel32(x, 3).toString(16));
}
check(bd.getPixel(0, 0) == 0xff0000, "getPixel drops alpha: 0xff0000, got " + bd.getPixel(0, 0).toString(16));
check(bd.rect.width == 6 && bd.rect.height == 4, "rect is the image bounds");

// The away3d path, which is the regression this example exists for: a bit-exact
// copy of Cast.bitmapData() over an embedded asset.
var cast:BitmapData = likeCast(Assets.px);
check(cast != null, "Cast.bitmapData(embedded asset) must not return null");
check(cast.width == 6 && cast.height == 4, "Cast.bitmapData returns the decoded BitmapData");
check(cast.getPixel32(1, 0) == 0xff00ff00, "and it is the same decoded pixels");
check(likeCast(null) == null, "Cast.bitmapData(null) stays null");

// --- binary: a ByteArray subclass with the file's bytes -----------------------
var blobCtor:ByteArray = new Assets.blob() as ByteArray;
check(blobCtor != null, "the binary asset class extends ByteArray");
check(blobCtor.length == 256, "blob.bin embeds all 256 bytes, got " + blobCtor.length);
check(blobCtor[0] == 0 && blobCtor[255] == 255, "raw bytes are unmodified");
check(blobCtor.position == 0, "an embedded ByteArray opens at position 0");

// mimeType beats the extension: this is a .png declared as octet-stream.
var pngAsBytes:ByteArray = new Assets.pxAsBytes() as ByteArray;
check(pngAsBytes.length == 140, "px.png embedded as raw bytes is 140 bytes");
check(pngAsBytes[0] == 0x89 && pngAsBytes[1] == 0x50 && pngAsBytes[2] == 0x4e && pngAsBytes[3] == 0x47,
  "and it still starts with the PNG magic number");

// --- sound: a Sound subclass holding the compressed mp3 -----------------------
var toneCtor:Sound = new Assets.tone() as Sound;
check(toneCtor != null, "the sound asset class extends Sound");
check(toneCtor.bytesTotal == 6686, "bytesTotal is the file size, got " + toneCtor.bytesTotal);
// adl prints 417.9591836734694 for this file; the decoder's frame count, not a byte count.
check(toneCtor.length > 417.9 && toneCtor.length < 418.0, "decoded length, got " + toneCtor.length);
// extract() always writes 44100 Hz STEREO f32 (a mono source is written twice), at
// the target's current position, which then advances; it returns the sample count.
var audio:ByteArray = new ByteArray();
var extracted:Number = toneCtor.extract(audio, 1000);
check(audio.length == 8000, "extract(1000) writes 1000 stereo f32 = 8000 bytes, got " + audio.length);
check(audio.position == 8000, "extract advances the target position, got " + audio.position);
check(extracted == 1000, "extract returns the sample count, got " + extracted);
var toneByMime:Sound = new Assets.toneByMime() as Sound;
check(toneByMime is Sound && toneByMime.length == toneCtor.length, "mimeType=audio/mpeg agrees with the .mp3 path");

// --- the generated constructor is zero-argument (AIR #1063) -------------------
var arityThrew:Boolean = false;
try { var tooMany:* = new pxCls(1, 2); } catch (e:ArgumentError) { arityThrew = true; }
check(arityThrew, "new <asset class>(1, 2) must throw ArgumentError #1063");

// --- one class object per class, whichever route finds it ---------------------
check(getDefinitionByName(getQualifiedClassName(pxCls)) === Assets.px,
  "getDefinitionByName(qcn(pic)) is the same class object as pic");
check(Object(pxCtor).constructor === Assets.px,
  "Object(instance).constructor is the same class object as pic");
var dynamicCtor:* = pxCtor.constructor;
check(dynamicCtor === Assets.px, "the `.constructor` property agrees too");

// --- instance-field [Embed] (bound by the instance constructor) ---------------
var assets:Assets = new Assets();
check(assets.instClass() === Assets.px, "an instance field embeds the same asset class");
var instBd:BitmapData = assets.instBitmap();
check(instBd != null && instBd.width == 6, "and its BitmapData decodes identically");
check(instBd.getPixel32(4, 1) == 0xff112233, "instance-field pixels are the same bytes");
var instObj:* = assets.instClass();
check(instObj is Class, "an instance-field Class value is `is Class` too");

trace("embed: all assertions passed");