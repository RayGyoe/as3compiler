// stage94s.as — 阶段九十四·二十二（④-D）：hitTestPoint(x, y, shapeFlag) 的命中区。
//
// 触发：遗留表里这条写着「`hitTestPoint(x,y,true)` 的像素级精确命中未实现」——
// 我们此前**两个 flag 都只做（且只按填充几何做）AABB**。本阶段先按 adl 51.4.1 把
// 命中区实测清楚（证据台 `temp/editprobe/app8..app10` + `hit25_adl.txt`），再实现。
//
// adl 实测口径（点一律在 stage 空间）——「内容」= 自己的 Graphics（填充 ∪ 描边）
// ∪ 子对象内容：
//   * `shapeFlag=false`（box）：点在内容的**含描边外框**内。当初的实测是「20x20 填充带 8px
//     描边时，x=5.75（描边外缘 6.0 之外 0.25px）仍算命中」——**那条 0.25px 后来被阶段
//     二百四十一 推翻**：adl 的边界不是「外缘外 0.25px 的容差」，而是**随绝对位置锯齿**的
//     光栅化相位（box 侧 −0.41…0.00px、周期约 0.5px，见 `docs/zh-cn/as3-semantics.md` §3.4）。
//     结论不变的是「框 = **画出来的**范围（含 width/2），不是 getRect 的几何」——那是本阶段
//     真正要钉的东西；模糊带那半边不复刻（H 节）。
//   * `shapeFlag=true`（region）：点在**内容区域**内：
//       - 矢量：填充区（**even-odd** —— 同一次 fill 里同向嵌套的两个子路径，内层是洞）
//         ∪ 描边带（默认圆头圆角，中心线两侧各 width/2；实测 4.5px 命中、5.5px 不中，
//         端点外 2px 仍命中）
//       - **位图：是它的矩形，不采样 alpha**（全透明的 BitmapData 在矩形内照样命中，
//         矩形内的透明像素也命中 ⇒ shapeFlag 对 Bitmap 不是像素测试）
//       - **TextField：是它的矩形**（有文本/无文本/有无边框都一样，shapeFlag 被忽略）
//       - 容器：子对象区域的并集（**缝里不命中**），且不因 `mouseChildren=false` 改变
//   * 两个 flag 都**忽略** `visible`、`mouseEnabled`、`mouseChildren` 与对象 alpha；
//     无内容的对象两个都不命中。
//
// 与 C 的差异（AGENTS.md §2.4 红线）：这里没有 C 语言层面的坑，但有一条**几何**红线 ——
// 命中区必须与**画出来的**区域是同一份几何（同一填充规则、同一描边宽度/端点），否则
// 「看得见却点不到 / 点得到却看不见」。因此生成侧把 Graphics 的路径填充规则统一设成
// even-odd（`as_skia_path_set_even_odd`），并在命中测试里用 `SkPath::contains` 与
// `SkStrokeRec::applyToPath` 的描边轮廓回答 —— 和渲染走同一条路径定义。
//
// 纯 C 回归的边界（本示例）：headless 套件无 Skia，矢量几何不保留（path 为 NULL），
// 故**矢量**的 region 退化成含描边外框（既定口径，见 test.ts 的结构钉子）；但
// **位图 / TextField / 容器的递归**完全不依赖 Skia，本示例钉的就是这三类 ——
// 它们恰好是「我们此前一律 AABB」与 adl 差得最明显的地方。矢量逐行对照在证据台。
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

function mkBD(w:int, h:int, argb:uint):BitmapData {
	var bd:BitmapData = new BitmapData(w, h, true, argb);
	return bd;
}

// ---- A. 容器的「缝」：AABB 命中、区域不命中（adl Ed24 §4/§5/§6） --------------
// 两个 10x10 位图放在 0 与 30（缝 10..30），容器放在 (200,60)。
var holder:Sprite = new Sprite();
holder.x = 200; holder.y = 60;
holder.addChild(mkBitmap(0, 0));
holder.addChild(mkBitmap(30, 0));
stage.addChild(holder);
function mkBitmap(bx:Number, by:Number):Bitmap {
	var bm:Bitmap = new Bitmap(mkBD(10, 10, 0xFF00FFFF));
	bm.x = bx; bm.y = by;
	return bm;
}
check(holder.hitTestPoint(205, 65, false), "A: the box hits the first child");
check(holder.hitTestPoint(205, 65, true), "A: the region hits the first child");
check(holder.hitTestPoint(235, 65, false), "A: the box hits the second child");
check(holder.hitTestPoint(235, 65, true), "A: the region hits the second child");
check(holder.hitTestPoint(220, 65, false), "A: the box spans the gap (measured on adl)");
check(!holder.hitTestPoint(220, 65, true), "A: the region misses the gap (measured on adl)");
check(!holder.hitTestPoint(260, 65, false), "A: both miss beyond the children");
check(!holder.hitTestPoint(260, 65, true), "A: both miss beyond the children (region)");

// ---- B. 位图的 region 是矩形而不是像素（adl Ed21 §A/§B、Ed22 §A、Ed23 §A） -----
var blank:Bitmap = new Bitmap(mkBD(16, 16, 0x00000000)); // 全透明
blank.x = 10; blank.y = 10;
stage.addChild(blank);
check(blank.hitTestPoint(20, 20, true), "B: a fully transparent bitmap still hits inside");
check(!blank.hitTestPoint(30, 20, true), "B: and misses outside its rect");
var half:Bitmap = new Bitmap(mkBD(16, 16, 0x00000000));
half.bitmapData.fillRect(new Rectangle(0, 0, 8, 8), 0xFFFF0000); // 只有左上半实心
half.x = 10; half.y = 40;
stage.addChild(half);
check(half.hitTestPoint(20, 50, true), "B: the opaque quadrant hits");
check(half.hitTestPoint(10 + 12, 40 + 12, true), "B: the transparent quadrant hits too (no alpha sampling)");

// ---- C. TextField 的 shapeFlag 被忽略（adl Ed18 §7/§8、Ed20 §H） --------------
var tf:TextField = new TextField();
tf.x = 10; tf.y = 100; tf.width = 200; tf.height = 30;
tf.defaultTextFormat = new TextFormat("_typewriter", 12, 0x000000);
tf.text = "IIIIIIIIII";
stage.addChild(tf);
check(tf.hitTestPoint(10 + 2, 100 + 8, true), "C: over a glyph hits");
check(tf.hitTestPoint(10 + 150, 100 + 8, true), "C: the blank right-hand area hits (shapeFlag ignored)");
check(tf.hitTestPoint(10 + 150, 100 + 28, true), "C: below the text line hits (shapeFlag ignored)");
check(!tf.hitTestPoint(10 - 5, 100 + 8, true), "C: outside the field misses");
var tf2:TextField = new TextField();
tf2.x = 10; tf2.y = 150; tf2.width = 100; tf2.height = 30;
tf2.border = true;
stage.addChild(tf2);
check(tf2.hitTestPoint(60, 165, true), "C: a border-only field hits in the middle");
check(!tf2.hitTestPoint(2, 165, true), "C: and misses 8px outside");

// ---- D. 两个 flag 都忽略 visible / mouseEnabled / mouseChildren（adl Ed24 §2..§5） ----
var hidden:Sprite = new Sprite();
hidden.x = 250; hidden.y = 150;
hidden.addChild(mkBitmap(0, 0));
hidden.visible = false;
stage.addChild(hidden);
check(hidden.hitTestPoint(255, 155, false), "D: an invisible object still answers the box test");
check(hidden.hitTestPoint(255, 155, true), "D: an invisible object still answers the region test");
var quiet:Sprite = new Sprite();
quiet.x = 250; quiet.y = 200;
quiet.addChild(mkBitmap(0, 0));
quiet.mouseEnabled = false;
quiet.mouseChildren = false;
stage.addChild(quiet);
check(quiet.hitTestPoint(255, 205, false), "D: mouseEnabled=false does not affect hitTestPoint");
check(quiet.hitTestPoint(255, 205, true), "D: mouseChildren=false does not affect the region test");

// ---- E. 无内容的对象两个都不命中（adl Ed24 §9） --------------------------------
var empty:Sprite = new Sprite();
empty.x = 100; empty.y = 220;
stage.addChild(empty);
check(!empty.hitTestPoint(100, 220, false), "E: an empty object misses the box test");
check(!empty.hitTestPoint(100, 220, true), "E: an empty object misses the region test");

// ---- F. 嵌套容器：区域测试递归（adl Ed24 §10） --------------------------------
var outer:Sprite = new Sprite();
outer.x = 10; outer.y = 200;
var inner:Sprite = new Sprite();
inner.addChild(mkBitmap(0, 0));
outer.addChild(inner);
stage.addChild(outer);
check(outer.hitTestPoint(15, 205, true), "F: the nested bitmap hits");
check(!outer.hitTestPoint(35, 205, true), "F: the gap beside it misses (recursion, not the outer box)");

// ---- G. 位图镜像后 region 仍跟矩形（adl Ed24 §8） ------------------------------
var mirrored:Bitmap = new Bitmap(mkBD(10, 10, 0xFF00FF00));
mirrored.x = 200; mirrored.y = 200;
mirrored.scaleX = -1;
stage.addChild(mirrored);
check(mirrored.hitTestPoint(195, 205, true), "G: a mirrored bitmap hits on the mirrored side");
check(!mirrored.hitTestPoint(205, 205, true), "G: and misses on the original side");

// ---- H. 边的松紧：严格几何 + 闭区间（阶段二百四十一 · 三组探针实测） -----------
// 遗留表曾把这里写成「adl 在描边外缘外 0.25px / 盒外 0.05px 仍算命中，我们更紧」。阶段
// 二百四十一 用 temp/hitprobe3 把它量透：adl 的边界确实比几何边松，但**不是一个容差**——
//   * 幅度随**绝对位置**锯齿（box 侧 −0.41…0.00px、region 侧 −0.11…+0.31px、周期约 0.5px）；
//     把 20x20 填充的左边缘按 1 twip 滑 6 步（getBounds 逐次证实边缘真的动了），adl 报出的
//     左边界**六次完全相同** ⇒ 边界钉在绝对网格上，不跟着对象走；
//   * 是**纯函数**（重复问 / 正反扫 / 两趟 / 换序 / 中间插问邻居全一致）⇒ 不是可修的缓存 bug；
//   * stage 缩放 1.6 与 1:1 量到同一量级 ⇒ 不是缩放/设备像素伪影。
// 复刻它要一张绝对网格表，且会把「贴边未中」变成「贴边中」的假阳性 ⇒ 我们维持**严格几何 +
// 闭区间**；可见口径差只有半像素，且只在边界那条**测度为零**的带上（docs/zh-cn/as3-semantics.md
// §3.4）。本节把这条规则钉住，防止后人在不知情下把判定改成模糊的。
// 注：box 判据是纯算术，**可以**在边界上断言；region 判据在 Skia 后端经 `SkPath::contains`
// （半开），故 region 的正/负例各留 0.05px 余量，两个后端才都成立。
var box2:Sprite = new Sprite();
box2.x = 100; box2.y = 250;
box2.graphics.beginFill(0xFFFF00); box2.graphics.drawRect(0, 0, 20, 20); box2.graphics.endFill();
stage.addChild(box2);
check(box2.hitTestPoint(100.00, 260, false), "H: the box test includes the left edge exactly");
check(box2.hitTestPoint(120.00, 260, false), "H: ...and the right edge exactly");
check(box2.hitTestPoint(110, 250.00, false), "H: ...and the top edge exactly");
check(box2.hitTestPoint(110, 270.00, false), "H: ...and the bottom edge exactly");
check(!box2.hitTestPoint(99.99, 260, false), "H: 0.01px outside the left edge misses (no fuzz)");
check(!box2.hitTestPoint(120.01, 260, false), "H: 0.01px outside the right edge misses");
check(!box2.hitTestPoint(110, 249.99, false), "H: 0.01px above the top edge misses");
check(!box2.hitTestPoint(110, 270.01, false), "H: 0.01px below the bottom edge misses");
check(box2.hitTestPoint(100.05, 260, true), "H: the region hits just inside the fill edge");
check(!box2.hitTestPoint(99.95, 260, true), "H: ...and misses just outside it");

// 描边：框是「画出来的范围」（中心线两侧各 width/2），区域同此。
var line:Sprite = new Sprite();
line.x = 200; line.y = 250;
line.graphics.lineStyle(4, 0x000000);
line.graphics.moveTo(0, 0);
line.graphics.lineTo(40, 0);
stage.addChild(line);
check(line.hitTestPoint(220, 248.00, false), "H: the box includes the stroke band (centre line 250, width 4)");
check(!line.hitTestPoint(220, 247.99, false), "H: ...and stops at its outer edge");
check(line.hitTestPoint(220, 248.05, true), "H: the region includes the stroked band too");
check(!line.hitTestPoint(220, 247.95, true), "H: ...and stops just outside it");

// 变换下的严格性：盒是**变换后**的盒，点仍按严格几何判定。
var scaled:Sprite = new Sprite();
scaled.x = 300; scaled.y = 250;
scaled.graphics.beginFill(0x00FFFF); scaled.graphics.drawRect(0, 0, 20, 20); scaled.graphics.endFill();
scaled.scaleX = 0.5; scaled.scaleY = 0.5;
stage.addChild(scaled);
check(scaled.hitTestPoint(310, 255, false), "H: a scaled object hits inside its transformed box");
check(scaled.hitTestPoint(309.99, 255, false), "H: ...right up to its transformed left edge");
check(!scaled.hitTestPoint(299.99, 255, false), "H: ...and misses 0.01px outside of it");

if (failCount == 0) trace("stage94s ok");
else trace("stage94s FAILED: " + failCount);
