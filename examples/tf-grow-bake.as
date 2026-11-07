// tf-grow-bake.as — 文字变长后的**第一次重画**必须已经是完整的：烘焙面不能按上一段文字的宽度建。
//
// 背景：`tf.text = …` 只作废段落，`_fieldWidth` 仍然停在上一段文字的盒；把它更新成新盒的是
// `as_tf_apply_autosize`，而它原本只在**绘制**（TextField 的 draw 分支）与 `width`/`height`
// （as_do_extents）里被调用。两个**算盒**入口 —— `as_bounds_walk`（getBounds/getRect 与父级
// 并集）和 `as_render_bounds`（烘焙/滤镜表面尺寸）—— 都只读裸 `_fieldWidth` ⇒ 文字一变长，
// 保留面还是旧宽度，画进去的却是新文字，右端被裁掉；下一次重画（面按新盒重建）才补上。
// 真机表现就是「最后一截字晚一点才出现」：库只写 `.text` 并依赖 autoSize（AIR 允许这么做），
// 于是每次换文案都会踩到一帧。
//
// 本示例钉的是**像素**（源级结构钉在 test/unit/render.ts 的 render/TextFieldBoundsAutosize）：
//   ① 静置若干帧，让 auto-bake 就位；
//   ② 把文本从 "ab" 换成 26 个字符；
//   ③ 连续做两次整舞台 bd.draw，**中间不插帧** —— 修前第一次裁、第二次完整。
// 断言「第一次 == 第二次」，外加「第二次确实远宽于改前」，后者是防假绿的：烘焙若根本没生效，
// 两次都会是完整值，只比相等就会空过。
//
// 编译：as-aot examples/tf-grow-bake.as --manifest examples/tf-scale-metrics.build.json --run
// 断言的是像素，纯 C 构建没有光栅后端（draw 是空桩），故与 autobake-patch.as 一样链 Skia；
// 没有后端时示例自检后跳过（自检与断言走同一条代码路径）。

import flash.display.BitmapData;
import flash.display.Shape;
import flash.display.Sprite;
import flash.display.Stage;
import flash.display.TextField;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var W:int = 420;
var H:int = 120;
var FIELD_X:int = 20;
var FIELD_Y:int = 20;
// 22px 等宽粗体：每个字形都留下实心竖笔，任何右端裁切都会立刻体现在 ink.right 上。
var FONT_SIZE:int = 22;
var LONG:String = "abcdefghijklmnopqrstuvwxyz";

var stage:Stage = new Stage();
stage.stageWidth = W;
stage.stageHeight = H;

// 字段直接挂在 root 下：没有自身几何 ⇒ 这一层（以及 stage）的盒就是文字盒，
// 烘焙面尺寸等于文字宽度，正是「按旧宽度建面」会露出马脚的地方。
var root:Sprite = new Sprite();
var field:TextField = new TextField();
field.autoSize = "left";
field.wordWrap = false;
field.multiline = false;
var fmt:TextFormat = new TextFormat();
fmt.font = "_typewriter";
fmt.size = FONT_SIZE;
fmt.bold = true;
fmt.color = 0x000000;
field.defaultTextFormat = fmt;
field.text = "ab";
field.x = FIELD_X;
field.y = FIELD_Y;
root.addChild(field);
stage.addChild(root);

// 文字带上最右的非白列；y 只扫到文字行，避免别的东西（背景/光标）混进来。
function inkRight():int {
  var bd:BitmapData = new BitmapData(W, H, false, 0xFFFFFF);
  bd.draw(stage);
  var last:int = -1;
  for (var y:int = 0; y < 60; y++) {
    for (var x:int = 0; x < W; x++) {
      if ((bd.getPixel(x, y) & 0xFFFFFF) != 0xFFFFFF && x > last) last = x;
    }
  }
  return last;
}

// 后端自检：一个实心方块必须真的画出颜色，否则这个构建没有光栅后端。
function hasBackend():Boolean {
  var probe:Sprite = new Sprite();
  var box:Shape = new Shape();
  box.graphics.beginFill(0x000000);
  box.graphics.drawRect(0, 0, 8, 8);
  box.graphics.endFill();
  probe.addChild(box);
  var bd:BitmapData = new BitmapData(20, 20, false, 0xFFFFFF);
  bd.draw(probe);
  return (bd.getPixel(4, 4) & 0xFFFFFF) != 0xFFFFFF;
}

if (!hasBackend()) {
  trace("tf-grow-bake: skipped (no raster backend)");
} else {
  // 静置几帧：只有完整的一帧渲染才会清掉脏位，自动烘焙要「上一帧干净」才成立。
  for (var f:int = 0; f < 4; f++) stage.render(W, H, "temp/tf-grow-bake.png");

  var shortInk:int = inkRight();
  check(shortInk > 0, "the short two-letter run must rasterize (ink.right=" + String(shortInk) + ")");
  check(shortInk < FIELD_X + 60,
        "the short run must stay narrow, otherwise the wide run below proves nothing"
        + " (ink.right=" + String(shortInk) + ")");

  field.text = LONG;

  // 同一处代码里连做两次：中间没有任何一帧，所以第二次看到的仍然是同一次变更的结果，
  // 只是保留面已经按新盒重建过了。
  var first:int = inkRight();
  var second:int = inkRight();

  check(second > shortInk + 200,
        "the long run must actually render, not just measure"
        + " (short=" + String(shortInk) + " long=" + String(second) + ")");
  check(first == second,
        "the FIRST render after the text grew must already be complete: the retained"
        + " surface may not be sized from the previous text (first=" + String(first)
        + " second=" + String(second) + ")");
  trace("tf-grow-bake: PASS (short=" + String(shortInk) + " long=" + String(second) + ")");
}