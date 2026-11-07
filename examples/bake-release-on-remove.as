// bake-release-on-remove.as — 自动烘焙缓存必须在对象离开显示列表后归还（阶段三百八十四）。
//
// 症状（真机，TalkMED 会议客户端）：反复开关「系统设置」窗口，进程私有内存每轮 +10.5 MB，
// 一小时到 1 GB。AIR 下同一操作**不涨**。
//
// 根因（temp/leakhunt 的探针实测）：auto-bake 是**我们自造的缓存**（AS3 没有对应物），
// 每个被烘焙的节点持有一张 pw*ph*4 字节的 Skia surface。它的生命周期原先只绑在
// 「owner 被 GC 回收」上 —— 于是设置窗口关掉后，虽然 removeChildren() 已把整棵
// setupskin 子树摘离显示列表（探针实测：18 轮 = 18 个孤儿 setupskin 根，每个带 49 个
// 烘焙节点），但子树仍被别处引用，GC 永不到来，49 张 surface 每轮 +7.8 MB。
// AIR 没有这一层，所以同样的输入在 AIR 下不涨 —— 这是**遗留缺陷**，不是增强空间。
//
// 修法：removeChild 时登记「移除前在舞台上」的子树，下一帧开头检查它是否仍在舞台外；
// 是则释放它的 _cache_image/_cache_surface 并置 _cache_valid=0（下一帧按已有重建路径
// 重烘）。延迟一帧是刻意的：虚拟列表每帧 remove+add 同一项，立即释放会每帧重烘。
//
// A/B：ASC_NO_BAKE_RELEASE=1 关掉这条通路，① 立刻红（+约 24 MB）。
//
// 编译：as-aot examples/bake-release-on-remove.as --manifest examples/bake-release-on-remove.build.json --run

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.BitmapData;
import flash.display.Stage;
import flash.system.System;

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

const ROUNDS:int = 20;      // 模拟 20 次开关窗口
const PER:int = 20;         // 每个容器 20 个烘焙节点
const NODE_W:int = 200;     // 每个节点的 bounds 200x75 ⇒ 60 KB/surface
const NODE_H:int = 75;
const BYTES_PER_ROUND:int = PER * NODE_W * NODE_H * 4;   // ≈ 1.2 MB

var stage:Stage = new Stage();
stage.stageWidth = 480;
stage.stageHeight = 320;

// 模拟「被单例钉住」：每轮的容器摘下来后仍然可达，GC 永远收不走它。
var kept:Array = [];

// 一个可烘焙节点：两个图元（单个图元的对象不走 auto-bake）。
function makeNode():Shape {
  var s:Shape = new Shape();
  s.graphics.beginFill(0x336699);
  s.graphics.drawRect(0, 0, NODE_W / 2, NODE_H);
  s.graphics.endFill();
  s.graphics.beginFill(0x99CC33);
  s.graphics.drawRect(NODE_W / 2, 0, NODE_W / 2, NODE_H);
  s.graphics.endFill();
  return s;
}

function makeRound():Sprite {
  var c:Sprite = new Sprite();
  for (var i:int = 0; i < PER; i++) {
    var s:Shape = makeNode();
    s.x = (i % 5) * 4;
    s.y = Math.floor(i / 5) * 4;
    c.addChild(s);
  }
  return c;
}

// 光栅后端自检：没有后端时根本不会分配 surface，这个例子就失去意义。
var control:BitmapData = new BitmapData(8, 8, false, 0xFFFFFFFF);
var probeRoot:Sprite = new Sprite();
var probeShape:Shape = makeNode();
probeRoot.addChild(probeShape);
control.draw(probeRoot);
if ((control.getPixel(5, 5) & 0xFFFFFF) != 0x336699) {
  trace("bake-release-on-remove: skipped (no raster backend)");
} else {
  // 基线：先完整走一轮，让工作集（Skia 进程级缓存、字体等）稳定下来。
  var warm:Sprite = makeRound();
  stage.addChild(warm);
  // 第一帧只是清 dirty：auto-bake 要求 !_render_dirty，第二帧才真正烘焙。
  stage.render(480, 320, "temp/bake-release-on-remove.png");
  stage.render(480, 320, "temp/bake-release-on-remove.png");
  stage.removeChild(warm);
  stage.render(480, 320, "temp/bake-release-on-remove.png");
  System.gc();
  var p0:Number = System.privateMemory;

  for (var r:int = 0; r < ROUNDS; r++) {
    var c:Sprite = makeRound();
    stage.addChild(c);
    // 第一帧清 dirty，第二帧才 auto-bake（每个节点分配一张 60 KB 的 surface）。
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    stage.removeChild(c);
    // 下一帧：修好后在这里归还 surface。
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    kept.push(c);          // 钉住容器本身 —— 对象仍泄漏，但缓存不该跟着泄漏
    System.gc();
  }

  var p1:Number = System.privateMemory;
  var leakedMB:Number = (p1 - p0) / 1048576;
  var wouldMB:Number = ROUNDS * BYTES_PER_ROUND / 1048576;
  // 判据：远小于 20 轮的缓存量（≈24 MB）。修好后只剩 20 个 Sprite/40 个图元对象本身。
  expect(leakedMB < wouldMB * 0.4,
         "detached subtrees gave their bake surfaces back (RSS +" + Math.round(leakedMB)
         + " MB over " + ROUNDS + " rounds; without the release this is +"
         + Math.round(wouldMB) + " MB)");

  // ② 正确性：被释放过缓存的那一轮重新上舞台，画面必须逐像素不变。
  var revived:Sprite = kept[kept.length - 1] as Sprite;
  stage.addChild(revived);
  stage.render(480, 320, "temp/bake-release-on-remove.png");
  var shot:BitmapData = new BitmapData(NODE_W, NODE_H, false, 0x000000);
  var probe2:BitmapData = new BitmapData(NODE_W, NODE_H, false, 0x000000);
  probe2.draw(revived);
  expect((probe2.getPixel(NODE_W / 4, NODE_H / 2) & 0xFFFFFF) == 0x336699,
         "the left half still paints 0x336699 (got 0x"
         + (probe2.getPixel(NODE_W / 4, NODE_H / 2) & 0xFFFFFF).toString(16) + ")");
  expect((probe2.getPixel(NODE_W * 3 / 4, NODE_H / 2) & 0xFFFFFF) == 0x99CC33,
         "the right half still paints 0x99CC33 (got 0x"
         + (probe2.getPixel(NODE_W * 3 / 4, NODE_H / 2) & 0xFFFFFF).toString(16) + ")");
  shot.dispose();
  stage.removeChild(revived);

  // ③ 第二轮：同量 churn 后再看一次，确认不是「一次性巧合」。
  for (var r2:int = 0; r2 < ROUNDS; r2++) {
    var c2:Sprite = makeRound();
    stage.addChild(c2);
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    stage.removeChild(c2);
    stage.render(480, 320, "temp/bake-release-on-remove.png");
    kept.push(c2);
    System.gc();
  }
  var p2:Number = System.privateMemory;
  expect((p2 - p0) / 1048576 < wouldMB * 0.8,
         "a second sweep of rounds does not ramp RSS further (+"
         + Math.round((p2 - p0) / 1048576) + " MB)");

  trace("bake-release-on-remove: p0=" + p0 + " p1=" + p1 + " p2=" + p2
        + " rounds=" + ROUNDS + " per-round-cache=" + BYTES_PER_ROUND + "B");
  trace("bake-release-on-remove: detached subtrees release their bake surfaces — assertions passed");
}