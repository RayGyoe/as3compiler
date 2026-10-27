// scrollrect-clip.as — DisplayObject.scrollRect 的**裁切窗锚点**回归。
//
// 背景（差异项 D29，阶段一百六十二）：AIR 把 scrollRect 理解成「窗口大小 = 矩形的
// width/height，窗口**钉在对象自己的盒子上**（局部 0,0,w,h），只有内容按 -x/-y 平移」。
// 我们此前写成「先 translate(-r.x,-r.y) 再 clipRect(0,0,w,h)」，而 Skia 会把 clipRect
// 按当前 CTM 映射——于是**窗口跟着内容一起滑走**。TalkMED 文件列表
// （List + VScrollBar.scrollY = `list.scrollRect = new Rectangle(0, scrollY, w, h)`）
// 因此症状为：滚动后内容盖住固定表头、列表底部出现空白带、且滚动后列表顶部
// `scrollY` 那一段点击打不中（拾取窗口 as_pick_hit_m 镜像了同一个错矩形）。
//
// 本示例用一个「10pt 三色循环色条」盒子做判据：给定 `scrollRect=(20,30,100,80)`，
// adl 51.4.1（temp/scrollrect-probe）实测着色像素包围盒是 **(100,50)-(199,129)**
// ——正是盒子本身，且窗口左上角像素取到的是**对象 x=20 那根色条**（内容被平移了），
// 而我们修复前报的是 (80,20)-(179,99)（窗口被平移了）。
//
// 纯 C 构建没有光栅后端（as_skia_* 是空桩，draw() 不产生像素），此时跳过像素断言。
// 编译（Skia 模式）：
//   as-aot examples/scrollrect-clip.as --manifest examples/scrollrect-clip.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var root:Sprite = new Sprite();

// 白底画在**被绘制的那棵树里面**（而不是只靠 BitmapData 的填充色）：adl 的 oracle
// 就是这样测的（temp/scrollrect-probe/Main.as 的 bg Shape），逐位可比。
var bg:Shape = new Shape();
bg.graphics.beginFill(0xFFFFFF);
bg.graphics.drawRect(0, 0, 400, 300);
bg.graphics.endFill();
root.addChild(bg);

var box:Sprite = new Sprite();
box.x = 100;
box.y = 50;
for (var i:int = 0; i < 30; i++) {
  var cyc:int = i % 3;
  var c:uint = cyc == 0 ? 0xFF0000 : (cyc == 1 ? 0x00FF00 : 0x0000FF);
  var s:Shape = new Shape();
  s.graphics.beginFill(c);
  s.graphics.drawRect(i * 10, 0, 10, 200);
  s.graphics.endFill();
  box.addChild(s);
}
root.addChild(box);

// 设置 scrollRect 后、下一帧渲染**之前**，localToGlobal 仍读旧的串接矩阵
// （air 实测：盒子在 (100,50)、inner 在 (5,10)、scrollRect.y=30 时 inner(0,20)
// → (105,80)，即尚未减掉那 30）。下一帧才计入偏移的完整口径另见
// examples/scrollrect-coordinates.as；这里钉住的是不能被「提前生效」破坏的前半段。
var inner:Sprite = new Sprite();
inner.x = 5;
inner.y = 10;
var mark:Shape = new Shape();
mark.graphics.beginFill(0x00FFFF);
mark.graphics.drawRect(0, 0, 4, 4);
mark.graphics.endFill();
mark.y = 20;
inner.addChild(mark);
box.addChild(inner);
box.scrollRect = new Rectangle(0, 30, 100, 80);
var g:Point = inner.localToGlobal(new Point(0, 20));
check(Math.round(g.x) == 105 && Math.round(g.y) == 80,
      "localToGlobal must ignore scrollRect (got " + g.x + "," + g.y + ", want 105,80)");
var back:Point = box.globalToLocal(g);
check(Math.round(back.x) == 5 && Math.round(back.y) == 30,
      "globalToLocal must ignore scrollRect (got " + back.x + "," + back.y + ", want 5,30)");
box.removeChild(inner);

// 色条 i 覆盖对象 x∈[i*10,i*10+10)，i%3 → 红/绿/蓝。
function stripeColor(objX:Number):uint {
  var k:int = int(objX / 10);
  return k % 3 == 0 ? 0xFF0000 : (k % 3 == 1 ? 0x00FF00 : 0x0000FF);
}

// 逐例：(scrollRect, 期望包围盒, 期望窗口左上角像素 = 对象 x=矩形.x 那根色条)
var cases:Array = [
  { r: null,                            bx: 100, by: 50, bw: 300, bh: 200, tl: 0xFF0000 },
  { r: new Rectangle(20, 30, 100, 80),  bx: 100, by: 50, bw: 100, bh: 80,  tl: stripeColor(20) },
  { r: new Rectangle(20, 0, 100, 80),   bx: 100, by: 50, bw: 100, bh: 80,  tl: stripeColor(20) },
  { r: new Rectangle(0, 30, 100, 80),   bx: 100, by: 50, bw: 100, bh: 80,  tl: stripeColor(0) },
  { r: new Rectangle(0, 0, 100, 80),    bx: 100, by: 50, bw: 100, bh: 80,  tl: stripeColor(0) },
  { r: new Rectangle(200, 100, 100, 80), bx: 100, by: 50, bw: 100, bh: 80, tl: stripeColor(200) }
];

var drawn:int = 0;
for (var j:int = 0; j < cases.length; j++) {
  var cs:Object = cases[j];
  box.scrollRect = cs.r;
  var bd:BitmapData = new BitmapData(400, 300, false, 0xFFFFFF);
  bd.draw(root);
  var minX:int = 9999, minY:int = 9999, maxX:int = -1, maxY:int = -1;
  for (var y:int = 0; y < 300; y++) {
    for (var x:int = 0; x < 400; x++) {
      if ((bd.getPixel(x, y) & 0xFFFFFF) != 0xFFFFFF) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) continue;              // 无光栅后端
  drawn++;
  var label:String = cs.r ? ("rect(" + cs.r.x + "," + cs.r.y + "," + cs.r.width + "," + cs.r.height + ")") : "none";
  check(minX == cs.bx && minY == cs.by && maxX == cs.bx + cs.bw - 1 && maxY == cs.by + cs.bh - 1,
        "scrollRect " + label + " must clip to the object's own box: got ("
        + minX + "," + minY + ")-(" + maxX + "," + maxY + "), want ("
        + cs.bx + "," + cs.by + ")-(" + (cs.bx + cs.bw - 1) + "," + (cs.by + cs.bh - 1) + ")");
  if (cs.r) {
    var tl:uint = bd.getPixel(minX, minY) & 0xFFFFFF;
    check(tl == cs.tl, "scrollRect " + label + " must shift the CONTENT by -x/-y: window's"
          + " top-left pixel is 0x" + tl.toString(16) + ", want the stripe at object x="
          + cs.r.x + " = 0x" + cs.tl.toString(16));
  }
}

if (drawn == 0) {
  trace("scrollrect-clip: skipped (no raster backend)");
} else {
  trace("scrollrect-clip: all " + drawn + " scrollRect cases clip to the object's own box — assertions passed");
}
