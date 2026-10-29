// display-mask.as — DisplayObject.mask 必须把对象**裁剪成遮罩的形状**（阶段三百一十八）。
//
// AIR 语义（adl 51.4.1 实测，temp/mask/MaskProbe.as / MaskProbe2.as / MaskProbe3.as）：
//   * 遮罩 = **模板（stencil）**，不是 alpha 合成：遮罩的 alpha（0 / 0.25 / 0.5 / 0→1 渐变）
//     与 `visible` 一律被忽略，对象在被覆盖处**保持完全不透明**；
//   * 覆盖范围取遮罩**自己的**变换（与对象同在父级空间），遮罩对象本身**不绘制**、**不当命中目标**；
//   * 遮罩可以有子件（并集，洞保留）；遮罩**不在显示列表**也照样生效；
//   * 覆盖取遮罩**自身祖先链**的位置（把它挂到 x=100 的容器里，裁剪区就整体 +100）；
//   * 遮罩没有墨迹 ⇒ 什么都画不出来；
//   * `getBounds`/`width`/`height` **不受遮罩影响**，`hitTestPoint(x,y,true)` **受**它影响。
//
// 本示例把这些逐条钉住（BitmapData.draw 与屏幕渲染走同一条 as_render_object 路径）。
// 纯 C 构建没有光栅后端，此时整段跳过断言。
//
// 编译（Skia 模式）：
//   as-aot examples/display-mask.as --manifest examples/display-mask.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function hasSkia():Boolean {
  var bd:BitmapData = new BitmapData(4, 4, true, 0xFFFF0000);
  return (bd.getPixel32(1, 1) >>> 24) != 0;
}

function alphaAt(bd:BitmapData, x:int, y:int):uint { return bd.getPixel32(x, y) >>> 24; }

// 第一/最后一个非透明列（y 行），无覆盖返回 -1/-1。
function spanOf(bd:BitmapData, y:int):Array {
  var first:int = -1, last:int = -1;
  for (var x:int = 0; x < bd.width; x++) {
    if (alphaAt(bd, x, y) != 0) { if (first < 0) first = x; last = x; }
  }
  return [first, last];
}

function spanText(bd:BitmapData, y:int):String {
  var s:Array = spanOf(bd, y);
  return "span " + s[0] + ".." + s[1];
}

function makeBox(w:Number, h:Number, color:uint):Sprite {
  var sp:Sprite = new Sprite();
  sp.graphics.beginFill(color);
  sp.graphics.drawRect(0, 0, w, h);
  sp.graphics.endFill();
  return sp;
}

function makeMaskShape(x:Number, y:Number, w:Number, h:Number):Shape {
  var sh:Shape = new Shape();
  sh.graphics.beginFill(0x00FF00);
  sh.graphics.drawRect(0, 0, w, h);
  sh.graphics.endFill();
  sh.x = x;
  sh.y = y;
  return sh;
}

// ---- A: 基本裁剪（adl：span 50..59、(55,30) 实心红、(80,30)/(25,30) 透明）----
var container:Sprite = new Sprite();
var red:Sprite = makeBox(100, 100, 0xFF0000);
red.x = 50;
red.y = 10;
container.addChild(red);
var maskShape:Shape = makeMaskShape(20, 20, 40, 40);
container.addChild(maskShape);
red.mask = maskShape;

if (hasSkia()) {
  var bdA:BitmapData = new BitmapData(200, 200, true, 0);
  bdA.draw(container);
  var sA:Array = spanOf(bdA, 30);
  check(sA[0] == 50 && sA[1] == 59, "A row 30 must be clipped to 50..59, got " + spanText(bdA, 30));
  check(alphaAt(bdA, 55, 30) == 255, "A (55,30) must be the object's own opaque red");
  check((bdA.getPixel32(55, 30) & 0x00FFFFFF) == 0xFF0000, "A (55,30) must keep the OBJECT's colour, not the mask's");
  check(alphaAt(bdA, 80, 30) == 0, "A (80,30) object-only must be transparent");
  check(alphaAt(bdA, 25, 30) == 0, "A (25,30) mask-only must be transparent (the mask is never painted)");
  check(alphaAt(bdA, 45, 30) == 0, "A (45,30) must be transparent (the box starts at 50)");
  check(alphaAt(bdA, 55, 5) == 0, "A (55,5) above the mask must be transparent");

  // 遮罩的 alpha 与 visible 都被忽略（stencil，不是 alpha 合成）。
  maskShape.alpha = 0;
  var bdA2:BitmapData = new BitmapData(200, 200, true, 0);
  bdA2.draw(container);
  check(alphaAt(bdA2, 55, 30) == 255, "A mask alpha 0 must still clip at full opacity");
  maskShape.alpha = 1;
  maskShape.visible = false;
  var bdA3:BitmapData = new BitmapData(200, 200, true, 0);
  bdA3.draw(container);
  check(alphaAt(bdA3, 55, 30) == 255, "A invisible mask must still clip");
  maskShape.visible = true;
}

// 遮罩不影响 getBounds/width/height（adl：getBounds=(50,10,100,100) wh=100x100）。
var gb:Rectangle = red.getBounds(container);
check(gb.x == 50 && gb.y == 10 && gb.width == 100 && gb.height == 100,
  "A getBounds must ignore the mask, got " + gb.toString());
check(red.width == 100 && red.height == 100, "A width/height must ignore the mask, got " + red.width + "x" + red.height);

// 遮罩参与 shapeFlag 命中测试（adl：(55,30)=true (80,30)=false (25,30)=false）。
check(red.hitTestPoint(55, 30, true), "A hitTestPoint(55,30,true) inside both must be true");
check(!red.hitTestPoint(80, 30, true), "A hitTestPoint(80,30,true) object-only must be false");
check(!red.hitTestPoint(25, 30, true), "A hitTestPoint(25,30,true) mask-only must be false");

// ---- B: 遮罩可以有子件：两个 20 宽的子矩形（x=0、x=60），中间是洞 ----
var contB:Sprite = new Sprite();
var redB:Sprite = makeBox(100, 20, 0x0000FF);
contB.addChild(redB);
var spriteMask:Sprite = new Sprite();
spriteMask.addChild(makeMaskShape(0, 0, 20, 20));
spriteMask.addChild(makeMaskShape(60, 0, 20, 20));
contB.addChild(spriteMask);
redB.mask = spriteMask;
if (hasSkia()) {
  var bdB:BitmapData = new BitmapData(120, 30, true, 0);
  bdB.draw(contB);
  check(alphaAt(bdB, 10, 5) == 255, "B (10,5) first child rect must show");
  check(alphaAt(bdB, 40, 5) == 0, "B (40,5) the gap between the mask's children must be transparent");
  check(alphaAt(bdB, 70, 5) == 255, "B (70,5) second child rect must show");
}

// ---- C: 遮罩不在显示列表也生效（adl：off-list 照常裁剪）----
var contC:Sprite = new Sprite();
var redC:Sprite = makeBox(100, 20, 0xFF00FF);
contC.addChild(redC);
var offList:Shape = makeMaskShape(0, 0, 40, 20);
redC.mask = offList;
if (hasSkia()) {
  var bdC:BitmapData = new BitmapData(120, 30, true, 0);
  bdC.draw(contC);
  check(spanText(bdC, 5) == "span 0..39", "C off-list mask must clip to 0..39, got " + spanText(bdC, 5));
}

// ---- D: 覆盖取遮罩自己的祖先链（挂到 x=100 的容器里 ⇒ 裁剪区整体 +100）----
var contD:Sprite = new Sprite();
var redD:Sprite = makeBox(100, 20, 0x00FFFF);
redD.x = 50;
contD.addChild(redD);
var holder:Sprite = new Sprite();
holder.x = 100;
contD.addChild(holder);
var heldMask:Shape = makeMaskShape(0, 0, 40, 20);
holder.addChild(heldMask);
redD.mask = heldMask;
if (hasSkia()) {
  var bdD:BitmapData = new BitmapData(300, 30, true, 0);
  bdD.draw(contD);
  var sD:Array = spanOf(bdD, 5);
  check(sD[0] == 100 && sD[1] == 139, "D stencil must follow the mask's own chain (100..139), got " + spanText(bdD, 5));
}

// ---- E: mask = null 复原，遮罩对象作为普通子件重新出现 ----
red.mask = null;
check(red.mask == null, "E mask must read back null");
if (hasSkia()) {
  var bdE:BitmapData = new BitmapData(200, 200, true, 0);
  bdE.draw(container);
  check(alphaAt(bdE, 80, 30) == 255, "E after mask=null (80,30) must be opaque again");
  check(alphaAt(bdE, 25, 30) != 0, "E after mask=null the mask child must be painted again");
  check((bdE.getPixel32(25, 30) & 0x00FFFFFF) == 0x00FF00, "E the released mask must paint its own colour");
}

// ---- F: 没有墨迹的遮罩 ⇒ 什么都画不出来 ----
var contF:Sprite = new Sprite();
var redF:Sprite = makeBox(100, 20, 0xFFFF00);
contF.addChild(redF);
var emptyMask:Shape = new Shape();
contF.addChild(emptyMask);
redF.mask = emptyMask;
if (hasSkia()) {
  var bdF:BitmapData = new BitmapData(120, 30, true, 0);
  bdF.draw(contF);
  check(spanText(bdF, 5) == "span -1..-1", "F an ink-less mask must clip everything away, got " + spanText(bdF, 5));
}

trace("display-mask: OK");