// gc-image-free.as — GC 回收对象时必须释放它持有的 C++ 资源（阶段二百八十三）。
//
// 症状（真机，TalkMED 会议客户端）：幻灯片预览翻到**第 39 页**（这一副 pptx 的最后一页）
// 画面就不再换了，此前每一页都正常；同时进程常驻内存爬到 1.1 GB，日志里有
//   out of memory: malloc failed for 8294416 bytes (gc heap 115.2 MB, 181 segments)
// 而 8294416 = 1920 * 1080 * 4 再往上取整到段尺寸 —— 就是**下一页的像素缓冲**。
//
// 根因（代码事实，见 src/runtime.ts 的 as_final_register / as_final_on_free）：
// 渲染路径会给 BitmapData 缓存一个 SkImage 视图（as_bmd_live_image → _live_image），
// 那是 malloc/C++ 内存，**不在 GC 堆里**。它只在 dispose()/换图时被 as_skia_image_delete，
// 而 BitmapData 被「直接丢弃」（应用每页 new 一张、换掉 bitmap.bitmapData）时，
// GC 只回收 GC 块，对这张 8.3 MB 的图一无所知 —— 每页漏一张，39 页 ≈ 325 MB，
// 加上动画/其它泄漏，32 位地址空间见底，下一页的 gc_alloc 抛 Error #1000（在 Loader
// COMPLETE 里抛出，页就停在上一张），表现出来就是「翻到最后一页不动了」。
//
// 修法：被清扫（= 已不可达）的 GC 块会在回收前调用 as_final_on_free()，把挂在该块
// 地址上登记的 SkImage 释放掉。断言分两条：
//   ① 泄漏量：39 页 × 8.3 MB 的图在 System.gc() 后不许留在进程里；
//   ② 正确性：**活着的** BitmapData 的视图不许被误放（放错 = 读到垃圾/崩溃）。
//
// A/B：ASC_NO_FINAL=1 关掉终结器，① 立刻红（+325 MB），② 仍绿 —— 泄漏与正确性分离。
//
// 编译：as-aot examples/gc-image-free.as --manifest examples/gc-image-free.build.json --run

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Bitmap;
import flash.display.BitmapData;

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

const W:int = 1920;
const H:int = 1080;
const PAGES:int = 39;                    // 真机这一副 pptx 就是 39 页
const IMAGE_BYTES:int = 8294400;         // W * H * 4，与真机那条 malloc 失败对齐

var stage:Stage = new Stage();
stage.stageWidth = 320;
stage.stageHeight = 240;

var holder:Sprite = new Sprite();
stage.addChild(holder);
var probe:BitmapData = new BitmapData(24, 24, false, 0xFFFFFFFF);

// 读 holder 左上角那个像素。走的是 BitmapData.draw → as_render_object →
// as_bmd_live_image，也就是**读 _live_image 的那条路径**：视图若被误放，这里就露馅。
function probePixel():uint {
  probe.fillRect(probe.rect, 0xFFFFFFFF);
  probe.draw(holder, null, null, null, null, true);
  return probe.getPixel(2, 2) & 0xFFFFFF;
}

function showPage(bd:BitmapData):void {
  while (holder.numChildren > 0) holder.removeChildAt(0);
  holder.addChild(new Bitmap(bd));
  stage.render(320, 240, "temp/gc-image-free.png");
}

// 一页幻灯片：ctor + 一次绘制，与应用里 ImageLoader.loadImageProgress 造 BitmapData 同形。
function page(color:uint):BitmapData {
  var bd:BitmapData = new BitmapData(W, H, true, color);
  var src:Sprite = new Sprite();
  src.graphics.beginFill(color);
  src.graphics.drawRect(0, 0, 8, 8);
  src.graphics.endFill();
  bd.draw(src);
  return bd;
}

// 光栅后端自检：没有后端时 _live_image 根本不会被创建，这个例子就失去意义。
var control:BitmapData = new BitmapData(24, 24, false, 0xFFFFFFFF);
var controlRoot:Sprite = new Sprite();
var controlShape:Shape = new Shape();
controlShape.graphics.beginFill(0xFF00FF);
controlShape.graphics.drawRect(0, 0, 10, 10);
controlShape.graphics.endFill();
controlRoot.addChild(controlShape);
control.draw(controlRoot);
if ((control.getPixel(5, 5) & 0xFFFFFF) != 0xFF00FF) {
  trace("gc-image-free: skipped (no raster backend)");
} else {
  // 基线：一页活着的幻灯片能被读出来。
  var first:BitmapData = page(0xFF0000);
  showPage(first);
  expect(probePixel() == 0xFF0000, "live slide renders (got 0x" + probePixel().toString(16) + ")");

  System.gc();
  var p0:Number = System.privateMemory;

  // ① 翻 PAGES 页，每页都把上一页的 BitmapData 整个丢掉（不 dispose —— 应用也不 dispose）。
  for (var i:int = 0; i < PAGES; i++) showPage(page(0x102030));
  System.gc();
  var p1:Number = System.privateMemory;
  // 判据取「远小于泄漏量」：39 张 × 8.3 MB = 325 MB，修好后只剩工作集（几张）。
  expect(p1 - p0 < 100 * 1024 * 1024,
         "the dropped pages' SkImages were released (RSS +" + Math.round((p1 - p0) / 1048576)
         + " MB over " + PAGES + " pages; without the finalizer this is +"
         + Math.round(PAGES * IMAGE_BYTES / 1048576) + " MB)");

  // ② 还活着的那一页必须还能正确渲染（终结器不许碰活对象）。
  expect(probePixel() == 0x102030,
         "the live slide still paints after the collections (got 0x" + probePixel().toString(16) + ")");

  // ③ 第二轮：段被复用后**不许**再涨一个 churn 的量（「不是一次性巧合」）。
  for (var j:int = 0; j < PAGES; j++) showPage(page(0x405060));
  System.gc();
  var p2:Number = System.privateMemory;
  expect(p2 - p0 < 120 * 1024 * 1024,
         "a second deck does not ramp RSS further (+" + Math.round((p2 - p0) / 1048576) + " MB)");
  expect(probePixel() == 0x405060, "second deck's live page paints (got 0x" + probePixel().toString(16) + ")");

  // ④ dispose() 路径：显式释放之后 GC 再站起来，两条路不许互相踩（重复删同一个图会崩）。
  var disposed:BitmapData = page(0x0000FF);
  showPage(disposed);
  expect(probePixel() == 0x0000FF, "page to dispose paints first");
  disposed.dispose();
  disposed = null;
  System.gc();
  var p3:Number = System.privateMemory;
  expect(p3 - p0 < 120 * 1024 * 1024,
         "dispose() plus the collection releases the image exactly once (+" + Math.round((p3 - p0) / 1048576) + " MB)");

  trace("gc-image-free: p0=" + p0 + " p1=" + p1 + " p2=" + p2 + " p3=" + p3);
  trace("gc-image-free: collected pages give their SkImages back — assertions passed");
}