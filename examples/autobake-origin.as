// autobake-origin.as — 自动烘焙的**原点口径**：被烘焙的对象落在非整数坐标上时，烘焙位图必须与
// 同一帧的直接递归绘制**逐像素相同**（阶段一百九十一）。
//
// 背景：`as_render_cached` 把子树烘到一张位图，再以对象**自己的分数原点** (bl,bt) 贴回画布；
// 贴回走 `drawImageRect` 的默认采样（最近邻），一张落在分数目的地上的位图会被整体舍入到最近的
// 整数设备像素 ⇒ 烘焙态与活态整幅平移最多 1 设备像素。指纹一变就会丢掉烘焙（要再静置
// ASC_AUTO_BAKE_FRAMES 帧才重建），所以真机上每次 hover / 按下都会「跳一下又跳回来」——正是用户
// 报的「按钮鼠标悬停抖动」。窗口层逐帧捕获（temp/hover/）：悬停瞬间「创建会议」卡片标题那段是自身
// 的**精确 1 像素平移**（最佳整数位移 (1,1)、残差 0.00），恰好 3 帧，随后弹回；同一序列在
// `ASC_NO_AUTO_BAKE=1` 下重跑，位移恒为 (0,0)。
// 修法：把烘焙原点向**下**吸附到落点设备像素栅格（`floor(bl*tx)/tx`）。贴回于是成了 1:1 复制，
// 没有可舍入的余数；而贴回的落点 bxo 与烘焙内部的平移 -bxo 恰好相消，内容相位自动保持，
// 所以「烘焙 == 活态」是**逐像素**成立的（不是「差一个亚像素」）。
//
// 判据（`temp/bakeorigin/ab.cjs` 的两态实测把场景挑出来了）：
//   ① 分数原点上的**圆**是有判别力的内容 —— 圆有反走样边缘，相位一变像素就变。同一场景用硬边
//      矩形条**判别不出来**：硬边填充自身会吸附到整像素，活态与烘焙态恰好重合（探针实测
//      `hard`/`hard2`/`child`/`txt` 在修前修后都 same=true，只有 `circ` 修前 111≠112）；
//   ② 第 1 帧（还没烘焙）取一次签名，连跑 6 帧 `stage.render` 让它自动烘焙后再取一次；
//      两次必须完全相同。修前 `circ` 差 1 个像素（哈希随之翻转）。
// 同一场景里还有**整数**原点的同一个圆当控制组：它既做光栅后端的存在性自检，也是「整数原点本来
// 就相等」的对照 —— 证明本示例测的是原点吸附，而不是别的渲染差异。
//
// 编译：as-aot examples/autobake-origin.as --manifest examples/autobake-origin.build.json --run
// 断言的是**像素**，纯 C 构建没有光栅后端（draw 是空桩），故与 bakecrisp.as / autobake-scrollrect.as
// 一样链 Skia；没有后端时示例自检后跳过（自检与断言走同一条代码路径，不会把别的故障误判成「无后端」）。

import flash.display.Sprite;
import flash.display.Shape;
import flash.display.Stage;
import flash.display.BitmapData;
import flash.display.DisplayObject;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 一排反走样的圆：半径 6、圆心落在半像素上（6.5），所以边缘一定落在像素内部而不是格线上。
function circles():Sprite {
  var s:Sprite = new Sprite();
  for (var i:int = 0; i < 3; i++) {
    var c:Shape = new Shape();
    c.graphics.beginFill(i == 1 ? 0x0088AA : 0xCC3366);
    c.graphics.drawCircle(6.5 + i * 16, 6.5, 6);
    c.graphics.endFill();
    s.addChild(c);
  }
  return s;
}

// 硬边矩形条：只用来给「整数原点」的控制组当高对比内容。
function bars():Sprite {
  var s:Sprite = new Sprite();
  for (var i:int = 0; i < 5; i++) {
    var c:Shape = new Shape();
    c.graphics.beginFill(i % 2 == 0 ? 0xFF0000 : 0x0000FF);
    c.graphics.drawRect(i * 2, 0, 2, 10);
    c.graphics.endFill();
    s.addChild(c);
  }
  return s;
}

var stage:Stage = new Stage();
stage.stageWidth = 160;
stage.stageHeight = 80;

// 分数原点的两个容器：0.4 与 0.7 是两种不同的取整方向（0.4 向下、0.7 向上）。
var fracA:Sprite = circles();
fracA.x = 20.4;
fracA.y = 20.4;
stage.addChild(fracA);

var fracB:Sprite = circles();
fracB.x = 60.7;
fracB.y = 40.7;
stage.addChild(fracB);

// 控制组：整数原点。
var whole:Sprite = bars();
whole.x = 5;
whole.y = 5;
stage.addChild(whole);

// 单对象签名：把对象本身画进位图（活态与烘焙态都走这条绘制路径），返回
// 「非白像素数:滚动哈希」——哈希让任一像素变化都能翻掉签名，而失败信息又不会淹没日志。
function sig(o:DisplayObject):String {
  var bd:BitmapData = new BitmapData(160, 80, false, 0xFFFFFF);
  bd.draw(o);
  var n:int = 0;
  var h:uint = 2166136261;
  for (var y:int = 0; y < 80; y++) {
    for (var x:int = 0; x < 160; x++) {
      var p:uint = bd.getPixel(x, y) & 0xFFFFFF;
      if (p != 0xFFFFFF) n++;
      h = (h * 31 + p) % 4294967296;
    }
  }
  return String(n) + ":" + String(h);
}

// 后端自检：控制组必须真的画出红条（否则说明这个构建没有光栅后端）。
function hasBackend():Boolean {
  var bd:BitmapData = new BitmapData(40, 40, false, 0xFFFFFF);
  bd.draw(whole);
  return (bd.getPixel(1, 1) & 0xFFFFFF) == 0xFF0000;
}

// 第 1 帧：直接递归绘制（尚未烘焙）的签名。
stage.render(160, 80, "temp/autobake-origin.png");
var liveA:String = sig(fracA);
var liveB:String = sig(fracB);
var liveW:String = sig(whole);

// 连跑 6 帧：指纹不变 ⇒ 三个容器都被自动烘焙，之后的帧走贴回路径。
for (var f:int = 0; f < 6; f++) stage.render(160, 80, "temp/autobake-origin.png");

if (!hasBackend()) {
  trace("autobake-origin: skipped (no raster backend)");
} else {
  check(liveA == sig(fracA),
        "an anti-aliased container auto-baked at origin 20.4 must be pixel-identical to its live"
        + " rendering; live=" + liveA + " baked=" + sig(fracA));
  check(liveB == sig(fracB),
        "an anti-aliased container auto-baked at origin 60.7/40.7 must be pixel-identical to its live"
        + " rendering; live=" + liveB + " baked=" + sig(fracB));
  check(liveW == sig(whole), "the integral control must stay identical too");

  // 再静置几帧：缓存按内容重建（重烘焙）之后同样不许动。
  for (var g:int = 0; g < 4; g++) stage.render(160, 80, "temp/autobake-origin.png");
  check(liveA == sig(fracA) && liveB == sig(fracB),
        "re-baking must not move the picture; live=" + liveA + "/" + liveB);

  trace("autobake-origin: baked == live at fractional origins — assertions passed ("
        + liveA + " / " + liveB + ")");
}
