// swc-morph.as — DefineMorphShape（morph）烘焙后必须对齐 AIR 的显示盒契约。
//
// 背景：skin.swc 里有 6 个 DefineMorphShape/2，整个界面（进度遮罩、字幕条、
// 文件行高亮）都靠时间轴的 PlaceObject2 Ratio 字段驱动它们在「起始形」与「结束形」
// 之间插值。我们原来把这 6 个字符烘成空占位，运行时什么都画不出来。
//
// 在 adl 51.4.1 上实测（temp/morph/adl/run-adl.cjs，字符 #70 位于
// `skin_fla.元件77_50`，ratio 从 0 一路走到 64874）得到的最反直觉的一条：
//
//   MorphShape 的 width / height / getBounds / getRect **不随 ratio 变**。
//   F1 / F2 / F25 / F50 / F75 / F99 一律报 92.90x41.65 @ (-92.90, -10.00)，
//   也就是缓存在 MorphShape 上的「起始形包围盒」，而实际绘制几何在同一批帧里
//   从 x=-92.90 滑到 x=-4.05。
//
// 这条契约对本例是硬要求：布局代码用它居中/定位皮肤元素，盒子里跟着形变跳的话
// 界面会整体位移。所以示例逐帧钉死它（数值来自上面那次 adl 实测），并顺带钉住
// 「回退帧不会残留末帧 ratio」——as_swc_bind 既建帧 1 也是回退路径，它会复用
// 同 (depth, 字符) 的对象，帧 1 记录没有 Ratio 时必须按 0 处理。
//
// 本示例能观察到的只有显示盒；几何插值本身在 AIR 侧也没有 AS3 可读的出口
// （唯一出口是像素，而本库的 morph 全部是 clipDepth 遮罩，见 swc.md §10），
// 因此插值/清除/端点由 test/unit/render.ts 的发射形态断言兜底。

import flash.display.DisplayObject;
import flash.display.MovieClip;
import flash.geom.Rectangle;
import flash.utils.getDefinitionByName;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(actual:Number, expected:Number, msg:String):void {
  check(Math.abs(actual - expected) < 0.005, msg + " (got " + actual + ", want " + expected + ")");
}

var cls:Class = getDefinitionByName("skin_fla.元件77_50") as Class;
check(cls != null, "the morph's parent symbol is exported as a class");

var clip:MovieClip = new cls() as MovieClip;
check(clip.totalFrames == 100, "the symbol keeps its 100-frame morph timeline");
check(clip.numChildren == 4, "four children on frame 1 (two bars, the morph, its label)");

// 帧 1 是 morph 的 ratio 0；帧 2..99 由 Ratio 记录推进（662, 1324, ... 64874）。
var frames:Array = [1, 2, 25, 50, 75, 99];
for each (var f:int in frames) {
  clip.gotoAndStop(f);
  var m:DisplayObject = clip.getChildAt(1);
  near(m.width, 92.9, "F" + f + ": the display box keeps the START width");
  near(m.height, 41.65, "F" + f + ": the display box keeps the START height");
  var r:Rectangle = m.getRect(clip);
  near(r.x, -92.9, "F" + f + ": getRect keeps the START x");
  near(r.y, -10.0, "F" + f + ": getRect keeps the START y");
  near(r.width, 92.9, "F" + f + ": getRect keeps the START rect width");
  near(r.height, 41.65, "F" + f + ": getRect keeps the START rect height");
  var g:Rectangle = m.getBounds(clip);
  near(g.x, -92.9, "F" + f + ": getBounds agrees with getRect on the start box");
}

// 回退：帧 1 的 PlaceObject 没有 Ratio 字段，复用对象必须把 ratio 推回 0。
// （修复前这里是 -4.95 / 87.95 —— 末帧的几何留在了对象上。）
clip.gotoAndStop(99);
clip.gotoAndStop(1);
var back:DisplayObject = clip.getChildAt(1);
near(back.width, 92.9, "a rewind keeps the START box");
near(back.getRect(clip).x, -92.9, "a rewind restores the frame-1 geometry");

trace("swc-morph: OK");