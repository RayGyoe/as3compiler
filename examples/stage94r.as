// stage94r.as — 阶段九十四·二十（④-C）：TextField 边框是**屏幕空间 1px 线**。
//
// 触发（阶段九十四·八 登记为遗留）：`border=true` 的 `TextField` 在 `scale != 1`
// 时边框线宽随对象缩放。window AOT 实测（`temp/editprobe/src/Ed7.as` +
// `drive_ed7.py` 的窗口像素扫描）：
//   * `adl 51.4.1`：60x20 字段在 `scaleX=scaleY=2`、`scaleX=2/scaleY=1`、
//     `scale=0.5` 三种情形下，**每条边都仍是 1 px**（`row xruns=[0-0,120-120]`、
//     `col yruns=[0-0,20-20]`），即**两个轴各自**保持 1 px，不随缩放变粗。
//   * 我们（修前）：线宽 = 1 局部单位 × 对象缩放 ⇒ `scale=2` 时是 2 逻辑 px
//     （Retina 截图 4 物理 px），与 `scale=1` 的字段不再是同一条线。
//
// 修法：线宽改成**屏幕空间**——`厚度(局部) = ASC_render_scale / 当前画布总缩放`，
// 于是「对象缩放」在任何倍数下都被除掉（`scale=1`、`dpr=1` 时恰好退化为原来的
// 1.0 局部单位）；`ASC_render_scale` 是本次渲染的物理像素比，故结果是**1 逻辑 px**
// （与 AIR 的 1 px 语义一致：AIR 在 1× 显示器上画的也是 1 逻辑 px；本机 Retina
// 窗口下 = 2 物理 px，与 adl 窗口被系统 2× 放大后的观感一致）。
//
// 另一处必须一起改的地方（本阶段实测发现的连带缺陷）：`cacheAsBitmap`/自动烘焙
// 的对象是在**离屏面**里重画内容的，那个画布的缩放是「烘焙分辨率」而不是屏幕的
// 缩放，而回贴时又被对象自己的 scale 放大一次 —— 若按烘焙画布量线宽，`scale=2`
// 的字段边框会厚 `scale` 倍（实测 4 物理 px 而不是 2）。所以烘焙通道会把**目标**
// 画布的总缩放发布到 `ASC_bake_ctm_*`，边框据此度量。
//
// 本示例是**纯 C 回归**（headless 套件无 Skia）——像素级不变式只能在窗口里观测，
// 证据台在 `temp/editprobe/`（Ed7 + 双端截图）。这里钉住的是本次改动**不得破坏**的
// 那半边：边框与缩放都不得污染**局部**度量与几何换算。
import flash.display.*;
import flash.geom.*;
import flash.text.*;

var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}
function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) { failCount++; trace("FAIL: " + msg + " (got " + actual + ", want " + expected + ")"); }
}

var stage:Stage = new Stage();

function mk(w:Number, h:Number, border:Boolean):TextField {
	var f:TextField = new TextField();
	f.x = 10; f.y = 10; f.width = w; f.height = h;
	f.defaultTextFormat = new TextFormat("_typewriter", 12, 0x000000);
	f.text = "ABCDEFGHIJ";
	f.border = border;
	f.borderColor = 0xFF00FF;
	stage.addChild(f);
	return f;
}

// A：边框是**屏幕空间**装饰，不进局部量 —— 开/关边框、加/不加缩放，
//    `width`/`height` 都必须是同一组值（修前的实现也不会差，但这正是本次改动的
//    前提：线宽只能在渲染时算，不能写回对象自己的尺寸）。
var plain:TextField = mk(100, 30, false);
var framed:TextField = mk(100, 30, true);
eq(framed.width, 100, "A: border does not inflate width");
eq(framed.height, 30, "A: border does not inflate height");
eq(framed.width, plain.width, "A: bordered and plain report the same width");
eq(framed.height, plain.height, "A: bordered and plain report the same height");

// B：`width`/`height` 是**变换后的**包围盒（阶段九十四·六 已实测：赋值即缩放，
//    读回的是「局部框 × 自身缩放」），边框不得悄悄改这一口径 —— 线宽只在渲染时算。
framed.scaleX = 2; framed.scaleY = 2;
eq(framed.width, 200, "B: width follows scaleX");
eq(framed.height, 60, "B: height follows scaleY");
eq(plain.scaleX, 1, "B: an unrelated field keeps its own scale");
framed.scaleX = 2; framed.scaleY = 1;
eq(framed.width, 200, "B: non-uniform scaleX keeps its own extent");
eq(framed.height, 30, "B: non-uniform scaleY keeps its own extent");
framed.scaleX = 0.5; framed.scaleY = 0.5;
eq(framed.width, 50, "B: a half-scale object reports half the extent");
// 边框只是屏幕空间的一条线：开/关它，`width` 逐值不变。
var before:Number = framed.width;
framed.border = false;
eq(framed.width, before, "B: turning the border off does not move width");
framed.border = true;
eq(framed.width, before, "B: turning the border on does not move width");

// C：非等比缩放下的坐标换算仍是**逐轴**的（边框线宽两轴各自 1 px，正是同一套
//    「按轴」处理方式；若谁把线宽改成按单一因子算，两个轴的几何就会分道）。
framed.scaleX = 2; framed.scaleY = 1;
var p:Point = framed.localToGlobal(new Point(100, 30));
var back:Point = framed.globalToLocal(p);
eq(p.x, 10 + 200, "C: localToGlobal scales x by scaleX");
eq(p.y, 10 + 30, "C: localToGlobal scales y by scaleY");
check(back.x > 99.99 && back.x < 100.01, "C: globalToLocal round-trips x");
check(back.y > 29.99 && back.y < 30.01, "C: globalToLocal round-trips y");

// D：命中测试用同一组「按轴」缩放（边框改动只碰渲染分支，几何分支必须原样）。
check(framed.hitTestPoint(10 + 199, 10 + 29), "D: a point inside the scaled box hits");
check(!framed.hitTestPoint(10 + 201, 10 + 29), "D: a point past the scaled box misses");
check(!framed.hitTestPoint(10 + 199, 10 + 31), "D: a point below the scaled box misses");

// E：边框色与边框开关的往返（回归 stage94h 已实测的口径：写入丢 alpha、读出 RGB）。
framed.borderColor = 0x8000FF00;
eq(framed.borderColor, 0x0000FF00, "E: borderColor write drops the alpha byte");
framed.border = false;
eq(framed.border, false, "E: border can be turned off again");
framed.border = true;
eq(framed.border, true, "E: border can be turned back on");

if (failCount == 0) trace("stage94r ok");
else trace("stage94r FAILED: " + failCount);
