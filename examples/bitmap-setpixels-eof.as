// bitmap-setpixels-eof.as — setPixels 的 ByteArray 游标 + 短数组语义（逐项对齐 adl）。
//
// 背景（真实应用在摄像头预览时直接崩溃）：
//   ANEVideo.as 每帧把 ANE 送来的 ARGB 帧写进位图：
//       try { videoBitmapData.setPixels(videoBitmapData.rect, VideoByteArray); }
//       catch (e:Error) { trace("setPixels Error:", ...); }
//   帧被截断时（宽高变了、ANE 还没吐满一帧、网络流末尾），ByteArray 里的字节
//   少于 rect.width*rect.height*4。AIR 的契约是「每个像素调用一次
//   ByteArray.readUnsignedInt()，能填多少填多少，然后抛 Error」，所以 catch 分支
//   就是这条路径唯一的护栏。我们原来的实现既不看 length 也不抛，直接按 rect
//   大小读下去——越界读走出 1080p 缓冲区，落在未映射页上（exe+0x91a41，READ
//   0x50d1c000），进程当场 0xc0000005，catch 分支永远没机会跑。
//
// 在 adl 51.4.1 上实测（temp/gdsetpixels/，2x2 位图）得到三条结论，本示例逐条钉死：
//   16 字节 @position 0 -> 填满 4 个像素，position 停在 16，不抛
//    6 字节 @position 0 -> 只填第 1 个像素，position 停在 4，抛 EOFError #2030
//   16 字节 @position 4 -> 填第 2..4 个像素，position 停在 16，抛 EOFError #2030
//    0 字节             -> 一个像素都不填，抛 EOFError #2030
// 也就是说：像素是从 ByteArray 的**游标**处读的（不是恒从 0 读），游标按每个像素
// 4 字节前进，且停在最后一个**完整**字上；不足时先填已经轮到的那部分，再抛
// EOFError #2030（name 仍是 "Error"，文案带句号），位图保持可用。

import flash.display.BitmapData;
import flash.utils.ByteArray;
import flash.utils.Endian;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:Object, expected:Object, msg:String):void {
  check(String(actual) == String(expected), msg + " (got '" + actual + "', want '" + expected + "')");
}
function threw(f:Function, id:int, msg:String):Error {
  try { f(); } catch (e:Error) { eq(e.errorID, id, msg); return e; }
  throw new Error("FAIL: " + msg + " (nothing thrown)");
}
function noThrow(f:Function, msg:String):void {
  try { f(); } catch (e:Error) { throw new Error("FAIL: " + msg + " (threw #" + e.errorID + ": " + e.message + ")"); }
}
function hex(v:uint):String {
  var s:String = v.toString(16).toUpperCase();
  while (s.length < 8) s = "0" + s;
  return "0x" + s;
}
// 四个 ARGB 字 → 大端字节数组（AIR 默认字节序：每个字在内存里是 A,R,G,B）。
function argbBytes(words:Array):ByteArray {
  var ba:ByteArray = new ByteArray();
  ba.endian = Endian.BIG_ENDIAN;
  for (var i:int = 0; i < words.length; i++) ba.writeUnsignedInt(uint(words[i]));
  ba.position = 0;
  return ba;
}

var A:uint = 0xFF112233;
var B:uint = 0xFF445566;
var C:uint = 0xFF778899;
var D:uint = 0xFFAABBCC;

// ---- 1. 数据刚好够：四个像素全部填入，游标走到 16，不抛异常 --------------------
var bd1:BitmapData = new BitmapData(2, 2, true, 0);
var ba1:ByteArray = argbBytes([A, B, C, D]);
noThrow(function():void { bd1.setPixels(bd1.rect, ba1); }, "a byte array that covers the rect is not an error");
eq(hex(bd1.getPixel32(0, 0)), hex(A), "px(0,0) comes from the first word");
eq(hex(bd1.getPixel32(1, 0)), hex(B), "px(1,0) comes from the second word");
eq(hex(bd1.getPixel32(0, 1)), hex(C), "px(0,1) comes from the third word");
eq(hex(bd1.getPixel32(1, 1)), hex(D), "px(1,1) comes from the fourth word");
eq(ba1.position, 16, "a full setPixels consumes one word per pixel and leaves the cursor at the end");

// ---- 2. 帧被截断（真实崩溃的形状）：先填能填的，再抛 EOFError #2030 ----------
var bd2:BitmapData = new BitmapData(2, 2, true, 0);
var ba2:ByteArray = argbBytes([A]);
// writeShort 写在 position 处（就地覆写），只会加长 length；所以要先把游标移到末尾
// 才是「追加半个像素」。这正是 AIR 的 ByteArray 语义，写错就变成覆写前两个字节。
ba2.position = ba2.length;
ba2.writeShort(0x4455);                 // 第二个像素只有一半的字节
ba2.position = 0;
var e2:Error = threw(function():void { bd2.setPixels(bd2.rect, ba2); }, 2030, "a truncated byte array is #2030, never an over-read");
eq(e2.name, "Error", "the VM-thrown EOFError still reports name 'Error'");
eq(e2.message, "Error #2030: End of file was encountered.", "AIR's exact message, final period included");
eq(ba2.position, 4, "the cursor stops on the last WHOLE pixel (6 bytes -> 4)");
eq(hex(bd2.getPixel32(0, 0)), hex(A), "the pixel it could fill is kept");
eq(hex(bd2.getPixel32(1, 0)), hex(0), "the rest of the rect is left untouched");

// ---- 3. 像素从游标处读：position 不是装饰 -------------------------------------
var bd3:BitmapData = new BitmapData(2, 2, true, 0);
var ba3:ByteArray = argbBytes([A, B, C, D]);
ba3.position = 4;                       // 四个字，但从第二个字开始读
threw(function():void { bd3.setPixels(bd3.rect, ba3); }, 2030, "a cursor 4 bytes in leaves only three words for four cells");
eq(hex(bd3.getPixel32(0, 0)), hex(B), "px(0,0) is the word at the cursor, not the first word");
eq(hex(bd3.getPixel32(1, 0)), hex(C), "px(1,0) is the next word");
eq(hex(bd3.getPixel32(0, 1)), hex(D), "px(0,1) is the last word");
eq(hex(bd3.getPixel32(1, 1)), hex(0), "px(1,1) has no data left");
eq(ba3.position, 16, "the cursor lands on the last whole word, not past the buffer");

// ---- 4. 空数组：一个像素都不填，照样抛 #2030 ---------------------------------
var bd4:BitmapData = new BitmapData(2, 2, true, 0);
var ba4:ByteArray = new ByteArray();
threw(function():void { bd4.setPixels(bd4.rect, ba4); }, 2030, "an empty byte array is #2030");
eq(hex(bd4.getPixel32(0, 0)), hex(0), "an empty array writes nothing");
eq(ba4.position, 0, "an empty array's cursor does not move");

// ---- 5. 调用点形状：截断帧被 catch 住后，位图与字节数组都还能继续用 -----------
// 4x4 需要 16 个字；先喂 12 个（三行），再喂完整 16 个。
var live:BitmapData = new BitmapData(4, 4, true, 0);
var partial:ByteArray = argbBytes([A, A, A, A, A, A, A, A, A, A, A, A]);
threw(function():void { live.setPixels(live.rect, partial); }, 2030, "a three-row frame is #2030 on a four-row bitmap");
eq(hex(live.getPixel32(3, 2)), hex(A), "the three complete rows are on screen");
eq(hex(live.getPixel32(0, 3)), hex(0), "the fourth row is still empty");

var full:Array = [];
for (var i:int = 0; i < 16; i++) full.push(0xFF00FF00);
var fullBa:ByteArray = argbBytes(full);
noThrow(function():void { live.setPixels(live.rect, fullBa); }, "a full frame after a caught #2030 still works");
eq(hex(live.getPixel32(3, 3)), hex(0xFF00FF00), "the next full frame fills the whole bitmap");
eq(fullBa.position, 64, "and consumes exactly 16 words");

trace("bitmap-setpixels-eof: OK");