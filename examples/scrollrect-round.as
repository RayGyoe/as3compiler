// scrollrect-round.as — DisplayObject.scrollRect 的窗口**尺寸取整**与**小数位置**回归。
//
// 背景（阶段三百四十九）：AIR 的滚动窗口有两条口径，都是逐像素量出来的
// （temp/clipround，24 格双端对照）：
//
//  ① 窗口的 width/height 用**四舍六入五成双**（ties-to-even）量化，且量化发生在
//     **对象坐标系**里：w=100.5 → 画 100 列、101.5 → 102、119.5 → 120、
//     120.5 → 120、121.5 → 122、122.5 → 122、123.5 → 124；父件 scaleX=2 时
//     w=100.5 仍然只占 200 设备像素（= 2×100），可见 100 是**对象**坐标而不是
//     设备坐标。这不是 `(int)` 截断（120.5 → 121 是半上入），也不是 Skia 的
//     SkScalarRoundToInt（同样是半上入）。
//  ② 窗口自己的边按对象**当前的小数设备位置**做抗锯齿：对象在 x=20.25 时第一
//     列覆盖率 25%、x=20.5 时 50%、x=20.75 时 25%（反方向同比例）；整数位置的
//     对象不受影响 —— 这正是这个缺陷只在「小数布局」上现形的原因。
//
// 修前我们的裁剪走 `sk_canvas_clip_rect`（SkCanvas 的**矩形** clip 重载默认
// `doAntiAlias=false`），于是：w=100.5 画到第 121 列（多 1 列）、x=20.5 的窗口
// 整体右移 1 列（20.5 被半上入成 21，覆盖率丢失）、scaleX=2 时按设备空间量化成
// 201。三条都是 §1.5 意义上的**遗留缺陷**（`adl` 跑得对、我们跑不出），已在阶段
// 三百四十九 修净：窗口裁剪改走 `as_skia_canvas_clip_rect_window`
// （rint(w)/rint(h) + AA），整数对齐时仍走原来那条零开销的矩形 clip。
//
// 纯 C 构建没有光栅后端（as_skia_* 是空桩，draw() 不产生像素），此时跳过像素断言。
// 编译（Skia 模式）：
//   as-aot examples/scrollrect-round.as --manifest examples/scrollrect-clip.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// AIR 的口径就是 C 的 rint() / FE_TONEAREST。AS3 里没有「五成双」的取整，
// Math.round 是半上入，所以这里把规则显式写出来 —— 期望值不该由被测代码算。
function evenRound(v:Number):int {
  var f:Number = Math.floor(v);
  if (v - f == 0.5) {
    var fi:int = int(f);
    return (fi % 2 == 0) ? fi : fi + 1;
  }
  return int(Math.round(v));
}

function box(w:Number, h:Number, c:uint):Shape {
  var s:Shape = new Shape();
  s.graphics.beginFill(c);
  s.graphics.drawRect(0, 0, w, h);
  s.graphics.endFill();
  return s;
}

function hex(v:uint):String { var s:String = (v & 0xFFFFFF).toString(16); while (s.length < 6) s = "0" + s; return s; }

var drawn:int = 0;

// ---- ① 窗口宽度的取整表（x 为整数，隔离出「只看 width」这一项）----
function widthCase(w:Number):int {
  var root:Sprite = new Sprite();
  var p:Sprite = new Sprite(); p.x = 20; p.y = 10;
  p.addChild(box(250, 20, 0xFF0000));
  p.scrollRect = new Rectangle(0, 0, w, 20);
  root.addChild(p);
  var bd:BitmapData = new BitmapData(400, 40, false, 0xFFFFFF);
  bd.draw(root);
  var last:int = -1;
  for (var x:int = 0; x < 400; x++) if ((bd.getPixel(x, 20) & 0xFFFFFF) != 0xFFFFFF) last = x;
  if (last < 0) return -1;                        // 无光栅后端
  drawn++;
  var want:int = 20 + evenRound(w) - 1;
  check(last == want, "scrollRect w=" + w + " must paint columns 20.." + want
        + " (ties-to-even window width), got last painted column " + last);
  check((bd.getPixel(last + 1, 20) & 0xFFFFFF) == 0xFFFFFF,
        "scrollRect w=" + w + " must not paint column " + (last + 1) + " (got 0x"
        + hex(bd.getPixel(last + 1, 20)) + ")");
  return last;
}
var WS:Array = [100, 100.1, 100.25, 100.5, 100.9, 101, 101.5, 119.5, 120, 120.5, 121, 121.5, 122.5, 123.5];
for (var i:int = 0; i < WS.length; i++) widthCase(WS[i]);

// ---- ② 高度同一套规则 ----
function heightCase(h:Number):void {
  var root:Sprite = new Sprite();
  var p:Sprite = new Sprite(); p.y = 30;
  p.addChild(box(20, 250, 0x0000AA));
  p.scrollRect = new Rectangle(0, 0, 20, h);
  root.addChild(p);
  var bd:BitmapData = new BitmapData(40, 400, false, 0xFFFFFF);
  bd.draw(root);
  var last:int = -1;
  for (var y:int = 0; y < 400; y++) if ((bd.getPixel(10, y) & 0xFFFFFF) != 0xFFFFFF) last = y;
  if (last < 0) return;
  var want:int = 30 + evenRound(h) - 1;
  check(last == want, "scrollRect h=" + h + " must paint rows 30.." + want + ", got last row " + last);
}
heightCase(100.5);
heightCase(101.5);
heightCase(120.5);

// ---- ③ 量化在对象坐标里做：scaleX=2 的父件仍应是 rint(w)*2 个设备像素 ----
function scaledCase(w:Number, scale:Number, wantDevice:Number):void {
  var root:Sprite = new Sprite();
  var p:Sprite = new Sprite(); p.x = 20; p.y = 10; p.scaleX = scale; p.scaleY = scale;
  p.addChild(box(250, 20, 0x007700));
  p.scrollRect = new Rectangle(0, 0, w, 20);
  root.addChild(p);
  var bd:BitmapData = new BitmapData(600, 60, false, 0xFFFFFF);
  bd.draw(root);
  var last:int = -1;
  for (var x:int = 0; x < 600; x++) if ((bd.getPixel(x, 30) & 0xFFFFFF) != 0xFFFFFF) last = x;
  if (last < 0) return;
  check(last == 20 + wantDevice - 1, "scrollRect w=" + w + " under scale " + scale
        + " must span " + wantDevice + " device px (rounding happens in OBJECT space), got "
        + (last - 20 + 1));
}
scaledCase(100.5, 2, 200);
scaledCase(101.5, 2, 204);
scaledCase(100, 2, 200);

// ---- ④ 小数位置：窗口不整体右移，边列是**部分覆盖** ----
function fracCase(px:Number, wantFirst:int, wantLast:int):void {
  var root:Sprite = new Sprite();
  var p:Sprite = new Sprite(); p.x = px; p.y = 10;
  p.addChild(box(250, 20, 0xFF0000));
  p.scrollRect = new Rectangle(0, 0, 100, 20);
  root.addChild(p);
  var bd:BitmapData = new BitmapData(400, 40, false, 0xFFFFFF);
  bd.draw(root);
  var first:int = -1, last:int = -1;
  for (var x:int = 0; x < 400; x++) {
    if ((bd.getPixel(x, 20) & 0xFFFFFF) != 0xFFFFFF) { if (first < 0) first = x; last = x; }
  }
  if (first < 0) return;
  check(first == wantFirst && last == wantLast, "scrollRect at x=" + px
        + " must paint columns " + wantFirst + ".." + wantLast + ", got " + first + ".." + last);
  var a:uint = bd.getPixel(first, 20) & 0xFFFFFF;
  check(a != 0xFF0000 && a != 0xFFFFFF,
        "scrollRect at x=" + px + " must give the first column PARTIAL coverage (got 0x" + hex(a) + ")");
}
fracCase(20.5, 20, 120);
fracCase(20.75, 20, 120);

if (drawn == 0) {
  trace("scrollrect-round: skipped (no raster backend)");
} else {
  trace("scrollrect-round: window sizes round ties-to-even in object space and fractional origins keep partial edge columns — assertions passed");
}