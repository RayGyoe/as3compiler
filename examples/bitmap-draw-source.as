// bitmap-draw-source.as — BitmapData.draw(source:IBitmapDrawable) 实参类型回归。
//
// 背景：flash.display.IBitmapDrawable 在 AVM2 里只有两个实现者，而且它们**互不相关**：
// DisplayObject 和 BitmapData（BitmapData 不是 DisplayObject）。把 draw 的形参写成其中
// 任意一个，都会让另一边的调用抛 #1034——之前写成 BitmapData，于是所有「把显示对象
// 截图成位图」的路径全废：宿主应用 FilePreviewView 的
//   pBitmapData.draw(skinView.view, matrix, null, BlendMode.NORMAL, null, true)
// （view 是动态读出的子对象，实际是 MovieClip）每次截图都抛
//   Error #1034: Type Coercion failed: cannot convert [object MovieClip] to
//   flash.display.BitmapData.
// 分享文档/演示因此永远出不了帧。
//
// 修复：形参类型改为 flash.display.IBitmapDrawable（marker 接口，无成员），
// 方法体按 vtable 三分支（TextField / DisplayObject / BitmapData），动态实参在运行时
// 校验并只接受这两族，其余按 AIR 抛 #1034 并**指名接口**（不是 BitmapData）。
//
// 断言分两类：像素只有 BitmapData→BitmapData 一路在纯 C 构建里也成立（逐像素循环，
// 不依赖 raster 后端）；显示对象一路只断言「不抛异常」，纯 C 无 raster 后端时它是 no-op。
//
// 编译（Skia 模式）：as-aot examples/bitmap-draw-source.as --manifest examples/bitmap-draw-source.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 1. BitmapData -> BitmapData：仍然按像素拷贝（纯 C 也走这条）。
var src:BitmapData = new BitmapData(8, 8, true, 0x00000000);
src.fillRect(new Rectangle(0, 0, 8, 8), 0xFFFF0000);
var dst:BitmapData = new BitmapData(8, 8, true, 0x00000000);
dst.draw(src);
var p:uint = dst.getPixel32(3, 3);
check(p == 0xFFFF0000, "BitmapData source must be sampled (got 0x" + p.toString(16) + ")");
trace("draw: bitmapdata ok");

// 2. DisplayObject 家族：静态类型路径编译期直接通过，运行期走 DisplayObject 分支。
var sp:Sprite = new Sprite();
sp.graphics.beginFill(0xFFFF0000, 1);
sp.graphics.drawRect(0, 0, 8, 8);
sp.graphics.endFill();
var mc:MovieClip = new MovieClip();
mc.addChild(sp);

var bd2:BitmapData = new BitmapData(8, 8, true, 0x00000000);
try {
  bd2.draw(mc);                                   // 静态 MovieClip
  bd2.draw(sp, new Matrix());                     // 静态 Sprite + 矩阵
  trace("draw: displayobject ok");
} catch (e:Error) {
  throw new Error("FAIL: draw(MovieClip/Sprite) threw " + e.message);
}

// 3. 动态实参：装 DisplayObject 要通过，装数字要抛 #1034 且指名接口。
var anyDO:* = sp;
var bd3:BitmapData = new BitmapData(8, 8, true, 0x00000000);
try {
  bd3.draw(anyDO);
  trace("draw: dynamic displayobject ok");
} catch (e2:Error) {
  throw new Error("FAIL: draw(dynamic DisplayObject) threw " + e2.message);
}

var anyNum:* = 5;
var bd4:BitmapData = new BitmapData(8, 8, true, 0x00000000);
var thrown:Boolean = false;
try {
  bd4.draw(anyNum);
} catch (e3:Error) {
  thrown = true;
  check(e3.errorID == 1034, "the coercion error id must be 1034 (got " + e3.errorID + ")");
  check(e3.message.toLocaleLowerCase().indexOf("ibitmapdrawable") >= 0,
    "the message must name flash.display.IBitmapDrawable (got " + e3.message + ")");
  trace("draw: non-drawable " + e3.message);
}
check(thrown, "draw(<number>) must throw #1034");

// 4. null 是合法引用：不抛异常，也不画东西。
var bd5:BitmapData = new BitmapData(8, 8, true, 0x00000000);
try {
  bd5.draw(null);
  check(bd5.getPixel32(0, 0) == 0, "draw(null) must not paint anything");
  trace("draw: null ok");
} catch (e4:Error) {
  throw new Error("FAIL: draw(null) threw " + e4.message);
}

// 5. 接口本身必须可见：两族都是 IBitmapDrawable。
check(sp is IBitmapDrawable, "Sprite must be an IBitmapDrawable");
check(src is IBitmapDrawable, "BitmapData must be an IBitmapDrawable");
trace("draw: interface ok");

trace("bitmap-draw-source: ok");