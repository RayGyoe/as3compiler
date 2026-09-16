// window_click.as — SDL2 窗口内真实鼠标点击 -> AS3 事件分派 + 视觉反馈。
//
// 画一个蓝色矩形，点击它触发 mouseDown/mouseUp/click，控制台打印坐标，
// 切换矩形颜色（蓝 <-> 红），并验证事件从 box 冒泡到 stage。这打通了
// SDL 鼠标事件 -> Stage_dispatchMouse -> 命中测试 -> 冒泡 -> 重渲染 的
// 完整交互链路（阶段三十三~三十五的事件引擎 + 阶段三十九的窗口后端）。
//
// 编译（需要 arm64 SDL2，见 docs/zh-cn/compile.md §6）：
//   as-aot examples/window_click.as --manifest examples/window_click.build.example.json

import flash.display.Shape;
import flash.display.Sprite;
import flash.events.MouseEvent;
import flash.text.TextField;

var stage:Stage = new Stage();

// 可点击的矩形（Sprite 作为命中目标，Shape 只负责绘制）。
var box:Sprite = new Sprite();
box.x = 80; box.y = 80; box.width = 200; box.height = 150;

var g:Shape = new Shape();
g.graphics.beginFill(0x3366CC);
g.graphics.drawRect(0, 0, 200, 150);
g.graphics.endFill();
box.addChild(g);

var clicked:Boolean = false;

box.addEventListener("mouseDown", function(e:MouseEvent):void {
  trace("mouseDown at", e.localX, e.localY);
});
box.addEventListener("mouseUp", function(e:MouseEvent):void {
  trace("mouseUp at", e.localX, e.localY);
});
box.addEventListener("click", function(e:MouseEvent):void {
  trace("click at", e.localX, e.localY);
  clicked = !clicked;
  g.graphics.clear();
  g.graphics.beginFill(clicked ? 0xCC3333 : 0x3366CC);
  g.graphics.drawRect(0, 0, 200, 150);
  g.graphics.endFill();
});

// 冒泡验证：box 的 click 会 bubble 到 stage。
stage.addEventListener("click", function(e:MouseEvent):void {
  trace("stage bubbled click, target is box:", e.target == box);
});

var tf:TextField = new TextField();
tf.text = "Click the blue box";
tf.x = 80; tf.y = 260; tf.width = 400;
stage.addChild(tf);

stage.addChild(box);

stage.showWindow(720, 480, "AS3 Click Test");
trace("window closed");
