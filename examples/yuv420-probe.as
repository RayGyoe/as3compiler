// yuv420-probe.as — BitmapData.setYuv420（E20 / 阶段三百七十四，--features yuv420）的
// AS3 契约断言。本示例只钉「字节读入」这层纯 CPU 可断言的一半：setYuv420 把一段紧凑
// I420 平面帧（Y | U | V，共 w*h*3/2 字节）读进位图，并沿用 setPixels 的游标/裁剪/短包
// 语义。渲染侧（GPU 直渲 / CPU 黑屏）需要光栅后端，由 yuv420.build.json 的 Skia 构建覆盖；
// 本示例在纯 C（无光栅）后端下也能跑，因为存储与报错不依赖 Skia。
//
//   * 偶数整帧 rect：读入 w*h*3/2 字节并推进游标；
//   * 越界整帧 rect：裁剪到整帧后照常读入；
//   * 短包：保留已写字节再抛 EOFError #2030；
//   * 奇数 w/h：抛 ArgumentError #2004（I420 的 U/V 2x2 子采样要求偶数尺寸）；
//   * 部分 rect：抛 ArgumentError #2004（子矩形在 I420 里没有无歧义的平面布局）；
//   * 完全在界外：静默无操作（对齐 setPixels 的无重叠语义）。
//
// 错误号与 setPixels 的短包（#2030）同源，参数错误（#2004）是 AIR ArgumentError 的
// 标准号——setYuv420 本身是 AIR 没有的增强，所以这里没有 adl 对照，语义取自 setPixels
// （temp/gdsetpixels/ 实测）与 I420 的数学约束。

import flash.display.BitmapData;
import flash.geom.Rectangle;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:Object, expected:Object, msg:String):void {
  check(String(actual) == String(expected), msg + " (got '" + actual + "', want '" + expected + "')");
}
function threw(f:Function, id:int, msg:String):void {
  try { f(); } catch (e:Error) { eq(e.errorID, id, msg); return; }
  throw new Error("FAIL: " + msg + " (nothing thrown)");
}
function bytes(n:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  for (var i:int = 0; i < n; i++) ba.writeByte(i & 0xFF);
  ba.position = 0;
  return ba;
}

// ---- 1. 4x4 整帧：Y(16) + U(4) + V(4) = 24 字节，一次读入并推进游标 ----------
var bd:BitmapData = new BitmapData(4, 4, false, 0);
var full:ByteArray = bytes(24);
bd.setYuv420(new Rectangle(0, 0, 4, 4), full);
eq(full.position, 24, "an even full-frame rect consumes w*h*3/2 bytes");

// ---- 2. 越界的整帧 rect 裁剪到整帧后照常读入 ------------------------------
// rect(-1,-1,6,6) 裁剪到 4x4 后仍是整帧，读入 24 字节。
var bd2:BitmapData = new BitmapData(4, 4, false, 0);
var over:ByteArray = bytes(24);
bd2.setYuv420(new Rectangle(-1, -1, 6, 6), over);
eq(over.position, 24, "an overhanging rect clips down to the full frame and reads it");

// ---- 3. 短包：保留已写字节再抛 #2030 --------------------------------------
var bd3:BitmapData = new BitmapData(4, 4, false, 0);
var short:ByteArray = bytes(10);
threw(function():void { bd3.setYuv420(new Rectangle(0, 0, 4, 4), short); }, 2030,
  "a short buffer throws EOFError #2030");
eq(short.position, 10, "the short cursor stops after the bytes it could read");

// ---- 4. 奇数尺寸：抛 ArgumentError #2004 ----------------------------------
var odd:BitmapData = new BitmapData(3, 3, false, 0);
var baOdd:ByteArray = bytes(14);
threw(function():void { odd.setYuv420(new Rectangle(0, 0, 3, 3), baOdd); }, 2004,
  "an odd-dimension bitmap throws ArgumentError #2004");

// ---- 5. 部分 rect：抛 ArgumentError #2004 ---------------------------------
var bd5:BitmapData = new BitmapData(4, 4, false, 0);
var part:ByteArray = bytes(8);
threw(function():void { bd5.setYuv420(new Rectangle(0, 0, 2, 2), part); }, 2004,
  "a partial rect throws ArgumentError #2004 (I420 planes are full-frame only)");

// ---- 6. 完全在界外的 rect：静默无操作（对齐 setPixels 的无重叠语义） ----------
var bd6:BitmapData = new BitmapData(4, 4, false, 0);
var none:ByteArray = bytes(24);
bd6.setYuv420(new Rectangle(10, 10, 2, 2), none);
eq(none.position, 0, "a rect with no overlap consumes nothing");

trace("yuv420-probe: OK");
