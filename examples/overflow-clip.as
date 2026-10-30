// overflow-clip.as — 「把子树裁到盒子里」这件事，编译器侧到底给了没有。
//
// 背景（asaotui/compiler-gaps.md 的 G29）：UI 库的 `style` 字段 `overflow` 被接受、
// 被校验、也进了布局引擎（`As3LayoutEngine.setOverflow`），但两侧画笔都没有消费它
// —— `PaintKit` 里 grep 不到任何 clip。判 G29 是不是**编译器缺口**，唯一该问的是：
// 「库要用它的那天，编译器有没有一条**像素正确**的子树裁剪路径可达」。
//
// 本示例就是那个判据。全部数字来自 `adl 51.4.1` 双端实测（证据台 `temp/g29/`：
// `src/Main.as` … `src4/Main.as` 四份探针 + `ours.as` … `ours4.as` 镜像 + `air*.out`），
// 我们与 AIR **逐像素相同**：
//
//   A 不裁剪（对照）：120 宽父盒里 200 宽子件 → 着色像素 x = 20..219
//   B scrollRect (0,0,120,28)：同一几何 → x = 20..139，即**裁到第 120 个像素**
//   C mask（120×28 的形状）：与 B 逐像素相同（两条路径等价）
//   D 子树：孙件在 inner(x=50) 里，200 宽 → x = 70..139（**整棵子树**都进裁剪，
//     不是只裁直接子件）
//   E 滤镜：子件挂 BlurFilter(8,8)，模糊外溢被**裁掉**（px140 = 白），而 px120 仍有墨
//   F cacheAsBitmap：先烘焙再裁剪，边界不变
//   G 嵌套：外层 120、内层 x=70 宽 80 → x = 90..139（裁剪可嵌套，取交集）
//   H TextField 子件：300 宽的背景字段同样被裁到 120
//   I 跨界的描边：4px 描边画在 (2,2,196,24) → 只剩 x = 20..23（描边也裁）
//   J 半透明 mask：50% alpha 的绿遮罩**不**削弱内容（内容仍是纯红 0xFF0000）
//
// 也就是说：`overflow: hidden` 今天就能在纯 AS3 里做出来 —— 容器上
// `container.scrollRect = new Rectangle(0, 0, w, h)`（内容平移 0，等于只裁），
// 或 `child.mask = shape`（非矩形形状用它）。库侧缺的只是**消费**这一步。
//
// 已登记的小数残差见 TODO.md `### 遗留待开发`：裁剪边恰为 `.5` 且整数部分为偶数时
// AIR 十二舍零（银行家舍入）而我们半上入 ⇒ 多画 1 设备像素（`temp/g29/body3.as`
// 的 120.5 / 122.5 两格）。本示例只用整数几何，不去钉那条规则。
//
// 纯 C 构建没有光栅后端（as_skia_* 是空桩，draw() 不产生像素），此时跳过。
// 编译（Skia 模式）：
//   as-aot examples/overflow-clip.as --manifest examples/overflow-clip.build.json

import flash.display.*;
import flash.geom.*;
import flash.filters.*;
import flash.text.*;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var W:int = 400;
var BH:int = 40;                       // 每格 40 高，格子之间留白
var H:int = 20 + 10 * BH + 20;
var bmp:BitmapData = new BitmapData(W, H, false, 0xFFFFFF);
var root:Sprite = new Sprite();

function red(w:Number, h:Number, c:uint, a:Number):Shape {
  var s:Shape = new Shape();
  s.graphics.beginFill(c, a);
  s.graphics.drawRect(0, 0, w, h);
  s.graphics.endFill();
  return s;
}
var band:int = 0;
function nextY():int { var y:int = 20 + band * BH; band++; return y; }

// A —— 对照：不裁剪
var pa:Sprite = new Sprite(); pa.x = 20; pa.y = nextY();
pa.addChild(red(200, 28, 0xFF0000, 1.0));
root.addChild(pa);

// B —— scrollRect (0,0,120,28)
var pb:Sprite = new Sprite(); pb.x = 20; pb.y = nextY();
pb.addChild(red(200, 28, 0xFF0000, 1.0));
pb.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pb);

// C —— mask（同尺寸的矩形形状，位置与父盒对齐）
var pc:Sprite = new Sprite(); pc.x = 20; pc.y = nextY();
pc.addChild(red(200, 28, 0xFF0000, 1.0));
var msk:Shape = red(120, 28, 0x00FF00, 1.0);
msk.x = pc.x; msk.y = pc.y;
root.addChild(msk);
pc.mask = msk;
root.addChild(pc);

// D —— 子树：孙件在 inner(x=50) 里
var pd:Sprite = new Sprite(); pd.x = 20; pd.y = nextY();
var innerD:Sprite = new Sprite(); innerD.x = 50;
innerD.addChild(red(200, 28, 0xFF0000, 1.0));
pd.addChild(innerD);
pd.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pd);

// E —— 滤镜外溢
var pe:Sprite = new Sprite(); pe.x = 20; pe.y = nextY();
var ce:Shape = red(200, 28, 0xFF0000, 1.0);
ce.filters = [new BlurFilter(8, 8, 1)];
pe.addChild(ce);
pe.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pe);

// F —— cacheAsBitmap
var pf:Sprite = new Sprite(); pf.x = 20; pf.y = nextY();
pf.addChild(red(200, 28, 0xFF0000, 1.0));
pf.cacheAsBitmap = true;
pf.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pf);

// G —— 嵌套裁剪
var pg:Sprite = new Sprite(); pg.x = 20; pg.y = nextY();
var innerG:Sprite = new Sprite(); innerG.x = 70;
innerG.addChild(red(200, 28, 0xFF0000, 1.0));
innerG.scrollRect = new Rectangle(0, 0, 80, 28);
pg.addChild(innerG);
pg.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pg);

// H —— TextField 子件
var ph2:Sprite = new Sprite(); ph2.x = 20; ph2.y = nextY();
var tf:TextField = new TextField();
tf.width = 300; tf.height = 28;
tf.background = true; tf.backgroundColor = 0xFF0000;
ph2.addChild(tf);
ph2.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(ph2);

// I —— 跨界描边（lineStyle(4) 画 (2,2,196,24) ⇒ 左侧 4px 描边落在对象 x=0..4）
var pi2:Sprite = new Sprite(); pi2.x = 20; pi2.y = nextY();
var ci:Shape = new Shape();
ci.graphics.lineStyle(4, 0x0000FF);
ci.graphics.drawRect(2, 2, 196, 24);
pi2.addChild(ci);
pi2.scrollRect = new Rectangle(0, 0, 120, 28);
root.addChild(pi2);

// J —— 半透明 mask 不削弱内容
var pj:Sprite = new Sprite(); pj.x = 20; pj.y = nextY();
pj.addChild(red(200, 28, 0xFF0000, 1.0));
var half:Shape = red(120, 28, 0x00FF00, 0.5);
half.x = pj.x; half.y = pj.y;
root.addChild(half);
pj.mask = half;
root.addChild(pj);

bmp.draw(root);

// ---- 取样 ---------------------------------------------------------------
function spanAt(y:int):Object {
  var mn:int = -1, mx:int = -1, x:int;
  for (x = 0; x < W; x++) {
    if ((bmp.getPixel(x, y) & 0xFFFFFF) != 0xFFFFFF) { if (mn < 0) mn = x; mx = x; }
  }
  return { mn: mn, mx: mx };
}
function pxAt(x:int, y:int):uint { return bmp.getPixel(x, y) & 0xFFFFFF; }

var rows:Array = [];
var i:int;
for (i = 0; i < band; i++) rows.push(20 + i * BH + 14);

var probe:Object = spanAt(rows[0]);
if (probe.mx < 0) {
  trace("overflow-clip: skipped (no raster backend)");
} else {
  var s:Object;

  // A：不裁剪
  s = spanAt(rows[0]);
  check(s.mn == 20 && s.mx == 219, "A visible: span " + s.mn + ".." + s.mx + ", want 20..219");

  // B：scrollRect 裁到 120
  s = spanAt(rows[1]);
  check(s.mn == 20 && s.mx == 139, "B scrollRect: span " + s.mn + ".." + s.mx + ", want 20..139");
  check(pxAt(139, rows[1]) == 0xFF0000, "B: the 120th pixel is inside the clip");
  check(pxAt(140, rows[1]) == 0xFFFFFF, "B: the 121st pixel is outside the clip");

  // C：mask 等价
  s = spanAt(rows[2]);
  check(s.mn == 20 && s.mx == 139, "C mask: span " + s.mn + ".." + s.mx + ", want 20..139");
  check(pxAt(140, rows[2]) == 0xFFFFFF, "C mask: the boundary is the same as scrollRect");

  // D：整棵子树都裁
  s = spanAt(rows[3]);
  check(s.mn == 70 && s.mx == 139, "D subtree: span " + s.mn + ".." + s.mx + ", want 70..139 (grandchild clipped too)");

  // E：滤镜外溢被裁
  s = spanAt(rows[4]);
  check(s.mn == 20 && s.mx == 139, "E blur: span " + s.mn + ".." + s.mx + ", want 20..139 (the spill is clipped)");
  check(pxAt(140, rows[4]) == 0xFFFFFF, "E blur: no spill outside the clip");

  // F：cacheAsBitmap 之后仍裁
  s = spanAt(rows[5]);
  check(s.mn == 20 && s.mx == 139, "F cacheAsBitmap: span " + s.mn + ".." + s.mx + ", want 20..139");

  // G：嵌套取交集
  s = spanAt(rows[6]);
  check(s.mn == 90 && s.mx == 139, "G nested: span " + s.mn + ".." + s.mx + ", want 90..139");

  // H：TextField 子件
  s = spanAt(rows[7]);
  check(s.mn == 20 && s.mx == 139, "H textfield: span " + s.mn + ".." + s.mx + ", want 20..139");

  // I：描边也裁（4px 描边 ⇒ 20..23）
  s = spanAt(rows[8]);
  check(s.mn == 20 && s.mx == 23, "I stroke: span " + s.mn + ".." + s.mx + ", want 20..23 (only the left stroke)");

  // J：半透明 mask 不削弱内容
  s = spanAt(rows[9]);
  check(s.mn == 20 && s.mx == 139, "J half-alpha mask: span " + s.mn + ".." + s.mx + ", want 20..139");
  check(pxAt(100, rows[9]) == 0xFF0000,
        "J half-alpha mask does not attenuate the content: 0x" + pxAt(100, rows[9]).toString(16) + ", want 0xff0000");

  trace("overflow-clip: ok (subtree clipped by scrollRect and mask — grandchild, stroke, blur spill,"
        + " cacheAsBitmap, nested clips, TextField child; half-alpha mask does not attenuate)");
}