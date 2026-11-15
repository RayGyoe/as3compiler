// copypixels-alpha.as — BitmapData.copyPixels 的 alpha 遮罩与 mergeAlpha（阶段四百三十二，G51）。
// 契约对照 adl 51.4.1（temp/copyprobe）：
//  - alphaBitmapData 的 alpha 调制源 alpha：modA = maskA==255 ? srcA : (srcA*maskA)>>8；
//  - mergeAlpha=false：直拷源 RGB，调制后 alpha 替换目标 alpha；alpha=0 时整像素清零；
//  - mergeAlpha=true：调制后的源做 source-over 混合（premul /255）；
//  - alphaPoint 指定 alphaBitmapData 中对应 srcRect 左上角的采样点。
import flash.display.BitmapData;
import flash.geom.Rectangle;
import flash.geom.Point;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function hex(v:uint):String { var s:String = v.toString(16).toUpperCase(); while (s.length < 8) s = "0" + s; return "0x" + s; }
function solid(c:uint):BitmapData { return new BitmapData(2, 2, true, c); }
var R:Rectangle = new Rectangle(0, 0, 2, 2);
var O:Point = new Point(0, 0);

// 1) 无遮罩 mergeAlpha=false：源 alpha 替换目标 alpha，RGB 直拷。
var d1:BitmapData = solid(0xFF0000FF); d1.copyPixels(solid(0x80FF0000), R, O);
check(d1.getPixel32(0,0) == 0x80FF0000, "no-mask replace: " + hex(d1.getPixel32(0,0)));

// 2) 遮罩 mergeAlpha=false：alpha = (255*128)>>8 = 127，RGB 直拷。
var d2:BitmapData = solid(0xFF0000FF); d2.copyPixels(solid(0xFFFF0000), R, O, solid(0x80000000), O, false);
check(d2.getPixel32(0,0) == 0x7FFF0000, "mask modulate 127: " + hex(d2.getPixel32(0,0)));

// 3) 部分源 alpha + 遮罩：(128*128)>>8 = 64。
var d3:BitmapData = solid(0xFF0000FF); d3.copyPixels(solid(0x80FF0000), R, O, solid(0x80000000), O, false);
check(d3.getPixel32(0,0) == 0x40FF0000, "mask modulate 64: " + hex(d3.getPixel32(0,0)));

// 4) 全透明遮罩 mergeAlpha=false：整像素清零（AIR premul 内部表示）。
var d4:BitmapData = solid(0xFF0000FF); d4.copyPixels(solid(0xFFFF0000), R, O, solid(0x00000000), O, false);
check(d4.getPixel32(0,0) == 0x00000000, "transparent mask clears: " + hex(d4.getPixel32(0,0)));

// 5) 不透明遮罩 mergeAlpha=false：alpha 原样通过（m255 特例）。
var d5:BitmapData = solid(0xFF0000FF); d5.copyPixels(solid(0xFFFF0000), R, O, solid(0xFF000000), O, false);
check(d5.getPixel32(0,0) == 0xFFFF0000, "opaque mask passthrough: " + hex(d5.getPixel32(0,0)));

// 6) alphaPoint 偏移：4x4 遮罩左半透明右半不透明，alphaPoint=(2,0) 取右半。
var m6:BitmapData = new BitmapData(4, 4, true, 0x00000000); m6.fillRect(new Rectangle(2,0,2,4), 0xFF000000);
var d6a:BitmapData = solid(0xFF0000FF); d6a.copyPixels(solid(0xFFFF0000), R, O, m6, new Point(2,0), false);
check(d6a.getPixel32(0,0) == 0xFFFF0000, "alphaPoint right opaque: " + hex(d6a.getPixel32(0,0)));
var d6b:BitmapData = solid(0xFF0000FF); d6b.copyPixels(solid(0xFFFF0000), R, O, m6, new Point(0,0), false);
check(d6b.getPixel32(0,0) == 0x00000000, "alphaPoint left transparent: " + hex(d6b.getPixel32(0,0)));

// 7) 遮罩 mergeAlpha=true：调制 alpha=127 的源 source-over 到不透明蓝。
var d7:BitmapData = solid(0xFF0000FF); d7.copyPixels(solid(0xFFFF0000), R, O, solid(0x80000000), O, true);
check(d7.getPixel32(0,0) == 0xFF7F0080, "mask merge=true: " + hex(d7.getPixel32(0,0)));

// 8) 无遮罩 mergeAlpha=true：半透明红 source-over 不透明蓝。
var d8:BitmapData = solid(0xFF0000FF); d8.copyPixels(solid(0x80FF0000), R, O, null, null, true);
check(d8.getPixel32(0,0) == 0xFF80007F, "no-mask merge=true: " + hex(d8.getPixel32(0,0)));

// 9) 全透明遮罩 mergeAlpha=true：目标不变。
var d9:BitmapData = solid(0xFF0000FF); d9.copyPixels(solid(0xFFFF0000), R, O, solid(0x00000000), O, true);
check(d9.getPixel32(0,0) == 0xFF0000FF, "transparent mask merge=true keeps dest: " + hex(d9.getPixel32(0,0)));

// 10) 调制公式抽样（adl 扫描网格）：srcA=200 m16=12, m240=187, m255=200。
var R1:Rectangle = new Rectangle(0,0,1,1);
function modA(sa:int, ma:int):int {
  var src:BitmapData = new BitmapData(1,1,true,(sa<<24)|0xFF0000);
  var mask:BitmapData = new BitmapData(1,1,true,(ma<<24));
  var dd:BitmapData = new BitmapData(1,1,true,0xFF0000FF);
  dd.copyPixels(src, R1, O, mask, O, false);
  return (dd.getPixel32(0,0) >>> 24);
}
check(modA(200,16) == 12, "modA(200,16)=12 got " + modA(200,16));
check(modA(200,240) == 187, "modA(200,240)=187 got " + modA(200,240));
check(modA(200,255) == 200, "modA(200,255)=200 got " + modA(200,255));
check(modA(255,128) == 127, "modA(255,128)=127 got " + modA(255,128));

trace("PASS copypixels-alpha");