// bitmap-setpixels-clip.as — setPixels 的矩形裁剪 + 大块拷贝路径（逐项对齐 adl）。
//
// 两条独立的结论，都在 adl 51.3.2 上实测（temp/vidcopy/，19 个 case 逐像素 + 游标比对）：
//
// 1) 裁剪先于读字节。AIR 只为「落在位图里的格子」消耗 ByteArray 的一个字：
//      64x48 位图 + rect(60,44,10,10)  ⇒ 只读 4x4=16 个字，游标停在 64
//      64x48 位图 + rect(-3,-3,10,10)  ⇒ 只读 7x7=49 个字，游标停在 196
//      完全在界外                      ⇒ 静默无操作，不抛 #2030
//    我们原来的实现是「每个矩形格子都推进游标，越界的格子跳过写入」，于是
//    越界矩形会把整帧的字节错位读取，而且会在 adl 能接受的帧上抛 #2030。
//    ANEVideo 每帧传的是 videoBitmapData.rect（不越界），所以这条在真实应用里
//    没有暴露；但任何「按裁剪区域传 rect」的调用都会踩到。
//
// 2) 大块拷贝路径。裁剪后的每一行在目标里连续、在源里也连续（每格 4 字节），
//    于是 LE 就是逐行 memcpy、BE 是同一批行逐字做字节交换。1080p 一帧：
//    逐格循环 7.2ms → 0.8ms（adl 1.5ms）。这是真实应用每路视频每帧的成本。
//    短包仍然回落到逐格路径，保留「先填能填的、再抛 #2030」的语义
//    （examples/bitmap-setpixels-eof.as 钉住）。

import flash.display.BitmapData;
import flash.geom.Rectangle;
import flash.utils.ByteArray;
import flash.utils.Endian;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:Object, expected:Object, msg:String):void {
  check(String(actual) == String(expected), msg + " (got '" + actual + "', want '" + expected + "')");
}
function hex(v:uint):String {
  var s:String = v.toString(16).toUpperCase();
  while (s.length < 8) s = "0" + s;
  return "0x" + s;
}
function threw(f:Function, id:int, msg:String):void {
  try { f(); } catch (e:Error) { eq(e.errorID, id, msg); return; }
  throw new Error("FAIL: " + msg + " (nothing thrown)");
}
function noThrow(f:Function, msg:String):void {
  try { f(); } catch (e:Error) { throw new Error("FAIL: " + msg + " (threw #" + e.errorID + ")"); }
}
// 每个像素一个可辨认的字：让「谁写到哪」一眼能看出来。
function pixels(n:int, base:uint):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.endian = Endian.BIG_ENDIAN;               // 内存 A,R,G,B
  for (var i:int = 0; i < n; i++) ba.writeUnsignedInt(base + i);
  ba.position = 0;
  return ba;
}

// ---- 1. 右边/下边越界：只读重叠的格子 ---------------------------------------
// 4x3 位图 + rect(3,2,2,2) ⇒ 重叠只有 (3,2) 一个像素。
var bd1:BitmapData = new BitmapData(4, 3, true, 0);
var ba1:ByteArray = pixels(4, 0xFF000001);
noThrow(function():void { bd1.setPixels(new Rectangle(3, 2, 2, 2), ba1); }, "an overhanging rect is not an error");
eq(ba1.position, 4, "only the 1x1 overlap consumes a word");
eq(hex(bd1.getPixel32(3, 2)), hex(0xFF000001), "the overlapping cell got the first word");
eq(hex(bd1.getPixel32(0, 0)), hex(0), "nothing outside the overlap was written");

// ---- 2. 左边/上边越界：正坐标部分照常写入 ------------------------------------
// rect(-1,-1,3,3) ⇒ 重叠 2x2=4 个格子，从 (0,0) 开始。
var bd2:BitmapData = new BitmapData(4, 3, true, 0);
var ba2:ByteArray = pixels(9, 0xFF000010);
noThrow(function():void { bd2.setPixels(new Rectangle(-1, -1, 3, 3), ba2); }, "a negative origin is not an error");
eq(ba2.position, 16, "a 2x2 overlap consumes 4 words");
eq(hex(bd2.getPixel32(0, 0)), hex(0xFF000010), "the first in-bounds cell takes the first word");
eq(hex(bd2.getPixel32(1, 1)), hex(0xFF000013), "cells walk the clipped rect row by row");
eq(hex(bd2.getPixel32(2, 1)), hex(0), "the 4th word does not spill to the next row");

// ---- 3. 完全在界外：静默无操作 ----------------------------------------------
var bd3:BitmapData = new BitmapData(4, 3, true, 0);
var ba3:ByteArray = pixels(4, 0xFF00AA00);
noThrow(function():void { bd3.setPixels(new Rectangle(10, 10, 2, 2), ba3); }, "a rect with no overlap is a no-op, not #2030");
eq(ba3.position, 0, "a rect with no overlap consumes nothing");
noThrow(function():void { bd3.setPixels(new Rectangle(-10, -10, 2, 2), ba3); }, "a fully negative rect is a no-op too");
eq(ba3.position, 0, "and still consumes nothing");

// ---- 4. 零宽/零高：不动游标 --------------------------------------------------
var bd4:BitmapData = new BitmapData(4, 3, true, 0);
var ba4:ByteArray = pixels(4, 0xFF00FF00);
noThrow(function():void { bd4.setPixels(new Rectangle(1, 1, 0, 2), ba4); }, "a zero-width rect is a no-op");
noThrow(function():void { bd4.setPixels(new Rectangle(1, 1, 2, 0), ba4); }, "a zero-height rect is a no-op");
eq(ba4.position, 0, "zero-size rects consume nothing");

// ---- 5. 越界 + 短包：先填重叠部分，再抛 #2030 -------------------------------
// rect(2,1,4,4) on 4x3 ⇒ 重叠 2x2=4 个格子，需要 16 字节，只给 12。
var bd5:BitmapData = new BitmapData(4, 3, true, 0);
var ba5:ByteArray = pixels(4, 0xFF000020);
ba5.length = 12;
ba5.position = 0;
threw(function():void { bd5.setPixels(new Rectangle(2, 1, 4, 4), ba5); }, 2030, "an overlap that cannot be fed throws #2030");
eq(ba5.position, 12, "the cursor stops after the last whole word");
eq(hex(bd5.getPixel32(2, 1)), hex(0xFF000020), "the cells it could fill are kept");
eq(hex(bd5.getPixel32(3, 1)), hex(0xFF000021), "the second cell too");
eq(hex(bd5.getPixel32(2, 2)), hex(0xFF000022), "and the third");
eq(hex(bd5.getPixel32(3, 2)), hex(0), "the fourth has no data left");

// ---- 6. 快路径与慢路径必须给出同一批像素 -----------------------------------
// 同一段数据，一份正好够（走 bulk），一份多一个字节（也是 bulk），
// 再拿「逐格 setPixel32」当独立参照。
var W:int = 16, H:int = 8;
var src:ByteArray = new ByteArray();
src.endian = Endian.LITTLE_ENDIAN;             // 内存 B,G,R,A —— 与 ANE 帧一致
for (var i2:int = 0; i2 < W * H; i2++) {
  src.writeByte(i2 & 0xFF);
  src.writeByte((i2 * 3) & 0xFF);
  src.writeByte((i2 * 7) & 0xFF);
  src.writeByte(0xFF);
}
src.position = 0;

var bulk:BitmapData = new BitmapData(W, H, true, 0);
bulk.setPixels(new Rectangle(0, 0, W, H), src);
eq(src.position, W * H * 4, "a whole-bitmap setPixels consumes the frame");

var slow:BitmapData = new BitmapData(W, H, true, 0);
for (var y:int = 0; y < H; y++) {
  for (var x:int = 0; x < W; x++) {
    var k:int = y * W + x;
    slow.setPixel32(x, y, 0xFF000000 | ((k * 7 & 0xFF) << 16) | ((k * 3 & 0xFF) << 8) | (k & 0xFF));
  }
}
for (var y2:int = 0; y2 < H; y2++) {
  for (var x2:int = 0; x2 < W; x2++) {
    eq(hex(bulk.getPixel32(x2, y2)), hex(slow.getPixel32(x2, y2)),
      "bulk and per-cell writes agree at (" + x2 + "," + y2 + ")");
  }
}

// ---- 7. 子矩形（带 x 偏移）走 bulk 时行内不能串 ---------------------------------
var sub:BitmapData = new BitmapData(W, H, true, 0);
var subSrc:ByteArray = new ByteArray();
subSrc.endian = Endian.LITTLE_ENDIAN;
for (var i3:int = 0; i3 < 6 * 4; i3++) { subSrc.writeByte(i3 & 0xFF); subSrc.writeByte(0); subSrc.writeByte(0); subSrc.writeByte(0xFF); }
subSrc.position = 0;
sub.setPixels(new Rectangle(3, 2, 6, 4), subSrc);
eq(subSrc.position, 6 * 4 * 4, "a sub-rect consumes exactly its cells");
eq(hex(sub.getPixel32(2, 2)), hex(0), "the column left of the sub-rect is untouched");
eq(hex(sub.getPixel32(3, 2)), hex(0xFF000000), "the sub-rect's first cell is (3,2)");
eq(hex(sub.getPixel32(8, 2)), hex(0xFF000005), "and the last column of that row is the 6th word");
eq(hex(sub.getPixel32(8, 5)), hex(0xFF000017), "the last row's last cell is the 24th word");

trace("bitmap-setpixels-clip: OK");