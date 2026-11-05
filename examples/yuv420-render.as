// yuv420-render.as — setYuv420 的渲染侧（E20，--features yuv420 + yuv420.build.json）。
//
// 在 CPU raster（有 Skia、无 GPU context）后端，setYuv420 存帧但渲染走
// as_bmd_live_image 的 YUV 分支：ctx == NULL → 警告一次 + 返回 NULL → 黑屏。本示例钉
// 这个「响亮失败」的可观测结果：setYuv420 之前 draw 到 probe 是 ARGB 旧值（红色），
// setYuv420 之后 draw 到 probe 是黑屏——不是 ARGB pixels 的旧值，也不是一个错的 YUV 色。
//
// GPU 直渲验色（--air-app + renderMode=gpu）需要真实窗口 + 截图，由
// docs/zh-cn/yuv-direct-render.md §验收 覆盖；本示例钉 CPU 黑屏这一端，同时证明
// vendor/skia_glue.cc 的 sk_image_from_yuv（含 TextureFromYUVAPixmaps）在 Skia 链接下
// 无未解析符号。

import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.geom.Rectangle;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function bytes(n:int):ByteArray {
  var ba:ByteArray = new ByteArray();
  for (var i:int = 0; i < n; i++) ba.writeByte(128);  // 中性灰 Y=128, U=V=128
  ba.position = 0;
  return ba;
}

var bd:BitmapData = new BitmapData(4, 4, false, 0xFF0000);  // ARGB 旧值是红色
var bmp:Bitmap = new Bitmap(bd);  // 通过显示对象走渲染路径（BitmapData.draw 的 BitmapData 源分支读 pixels，不走 YUV）

// 正对照：setYuv420 之前渲染 Bitmap 走 ARGB 路径，probe 得红色（证明 render 真的在执行，
// 而不是纯 C 空桩 —— 纯 C 空桩下这里会是透明 0）。
var before:BitmapData = new BitmapData(4, 4, true, 0);
before.draw(bmp);
check((before.getPixel32(1, 1) & 0xFFFFFF) == 0xFF0000,
  "before setYuv420 the ARGB pixels render red (got 0x" + before.getPixel32(1, 1).toString(16) + ")");

// setYuv420 存一帧中性灰 I420；之后渲染优先 YUV，CPU 后端无 GPU context → 黑屏。
var yuv:ByteArray = bytes(24);
bd.setYuv420(new Rectangle(0, 0, 4, 4), yuv);

var after:BitmapData = new BitmapData(4, 4, true, 0);
after.draw(bmp);
check((after.getPixel32(1, 1) & 0xFFFFFF) == 0,
  "after setYuv420 a CPU backend renders black, not a wrong colour (got 0x" + after.getPixel32(1, 1).toString(16) + ")");

trace("yuv420-render: OK");
