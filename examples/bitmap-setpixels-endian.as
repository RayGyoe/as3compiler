// bitmap-setpixels-endian.as — BitmapData.setPixels() 的字节序 + 显示列表取像素回归。
//
// 背景（真实应用 ANEVideo 摄像头预览画面全黑）：
//
// 1) setPixels 的字节序。AIR 的契约是「inputByteArray 里是 32 位 ARGB 像素值」，
//    也就是按 32 位**字**读。于是 ByteArray.endian 决定四个字节里谁是 alpha：
//      bigEndian（默认） 字 = b0<<24|b1<<16|b2<<8|b3  ⇒ 内存字节序 A,R,G,B
//      littleEndian      字 = b3<<24|b2<<16|b1<<8|b0  ⇒ 内存字节序 B,G,R,A
//    ANE 用 libyuv 的 I420ToARGB 解出的是内存 B,G,R,A，因此 AS3 侧在 setPixels 前
//    显式写 `VideoByteArray.endian = Endian.LITTLE_ENDIAN`。我们原来只认
//    bigEndian 一种序，于是 alpha 位读到的是蓝通道（多半为 0）→ 整帧透明/发黑，
//    R/B 也被互换。
//
// 2) 显示列表取像素。`new BitmapData(w,h)` 造出来的位图从来没有解码得来的
//    SkImage，而 as_render_object_content 的 Bitmap 分支只在 image != NULL 时
//    才画，于是「自己填像素的位图」在屏幕上什么都不画——摄像头预览正是
//    `new BitmapData(360,201)` + 每帧 setPixels，所以画面一直空白，而叠在上面
//    的 FPS 文本照常刷新。现在 pixels 有了自己的缓存视图（_px_ver 版本号驱动
//    重建），cacheAsBitmap 指纹也把 _px_ver 纳入，避免冻结在第一帧。
//
// 纯 C 构建没有 raster 后端（as_skia_* 是 no-op），draw() 不产生像素：此时用
// 一个 TextField 探针先判断后端是否存在，无后端则跳过显示列表段（字节序段仍钉）。
//
// 编译（Skia 模式）：as-aot examples/bitmap-setpixels-endian.as --manifest examples/bitmap-setpixels-endian.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function hex(v:uint):String {
  var s:String = v.toString(16).toUpperCase();
  while (s.length < 8) s = "0" + s;
  return "0x" + s;
}

// ---- 1. littleEndian：内存 B,G,R,A ⇒ 0xAARRGGBB（alpha 在最后） ----------------
var leBd:BitmapData = new BitmapData(2, 2, false, 0);
var leBa:ByteArray = new ByteArray();
leBa.endian = Endian.LITTLE_ENDIAN;
for (var i:int = 0; i < 4; i++) {
  leBa.writeByte(0x30);   // B
  leBa.writeByte(0x20);   // G
  leBa.writeByte(0x10);   // R
  leBa.writeByte(0xFF);   // A
}
leBa.position = 0;
leBd.setPixels(leBd.rect, leBa);
var lePix:uint = leBd.getPixel32(1, 1);
trace("bitmap-setpixels-endian: littleEndian -> " + hex(lePix));
check(lePix == 0xFF102030, "littleEndian B,G,R,A must read back as 0xFF102030 (got " + hex(lePix) + ")");

// ---- 2. bigEndian（默认）：内存 A,R,G,B ⇒ 同一个字 ----------------------------
var beBd:BitmapData = new BitmapData(2, 2, false, 0);
var beBa:ByteArray = new ByteArray();
beBa.endian = Endian.BIG_ENDIAN;
for (var j:int = 0; j < 4; j++) {
  beBa.writeByte(0xFF);   // A
  beBa.writeByte(0x10);   // R
  beBa.writeByte(0x20);   // G
  beBa.writeByte(0x30);   // B
}
beBa.position = 0;
beBd.setPixels(beBd.rect, beBa);
var bePix:uint = beBd.getPixel32(1, 1);
trace("bitmap-setpixels-endian: bigEndian -> " + hex(bePix));
check(bePix == 0xFF102030, "bigEndian A,R,G,B must read back as 0xFF102030 (got " + hex(bePix) + ")");

// 两种序必须落到同一个像素值：这正是「同一帧数据的两种写法」。
check(lePix == bePix, "the two endian orders describe the same pixel word");

// ---- 3. 显示列表：Bitmap + 运行时填的位图必须真的画出像素 ---------------------
var probeBd:BitmapData = new BitmapData(8, 8, true, 0);
var probeTf:TextField = new TextField();
probeTf.text = "";
probeTf.width = 8;
probeTf.height = 8;
probeTf.background = true;
probeTf.backgroundColor = 0xFF0000;
probeBd.draw(probeTf);
var hasRaster:Boolean = probeBd.getPixel(4, 4) != 0;

if (!hasRaster) {
  trace("bitmap-setpixels-endian: display-list section skipped (no raster backend)");
} else {
  var bmp:Bitmap = new Bitmap(leBd);
  var snap:BitmapData = new BitmapData(2, 2, false, 0xFF000000);

  snap.draw(bmp);
  var drawn:uint = snap.getPixel32(0, 0);
  trace("bitmap-setpixels-endian: draw(bitmap) -> " + hex(drawn));
  check(drawn == 0xFF102030, "a Bitmap over a setPixels bitmap must paint those pixels (got " + hex(drawn) + ")");

  // 改像素后必须跟着变（缓存视图靠 _px_ver 失效）。
  leBd.fillRect(leBd.rect, 0xFF00FF00);
  snap.fillRect(snap.rect, 0xFF000000);
  snap.draw(bmp);
  var afterFill:uint = snap.getPixel32(0, 0);
  trace("bitmap-setpixels-endian: after fillRect -> " + hex(afterFill));
  check(afterFill == 0xFF00FF00, "fillRect on the source must reach the screen (got " + hex(afterFill) + ")");

  leBd.setPixel32(0, 0, 0xFF0000FF);
  snap.fillRect(snap.rect, 0xFF000000);
  snap.draw(bmp);
  var afterSet:uint = snap.getPixel32(0, 0);
  trace("bitmap-setpixels-endian: after setPixel32 -> " + hex(afterSet));
  check(afterSet == 0xFF0000FF, "setPixel32 on the source must reach the screen (got " + hex(afterSet) + ")");

  // 每帧重填（摄像头预览的真实节奏）：第二次写入的像素也要画出来。
  var frame:ByteArray = new ByteArray();
  frame.endian = Endian.LITTLE_ENDIAN;
  for (var k:int = 0; k < 4; k++) {
    frame.writeByte(0xAA); frame.writeByte(0xBB); frame.writeByte(0xCC); frame.writeByte(0xFF);
  }
  frame.position = 0;
  leBd.setPixels(leBd.rect, frame);
  snap.fillRect(snap.rect, 0xFF000000);
  snap.draw(bmp);
  var frame2:uint = snap.getPixel32(1, 1);
  trace("bitmap-setpixels-endian: second frame -> " + hex(frame2));
  check(frame2 == 0xFFCCBBAA, "a per-frame setPixels must repaint (got " + hex(frame2) + ")");
}

trace("bitmap-setpixels-endian: OK");