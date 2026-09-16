// window.as — 自包含的 SDL2 窗口化示例。
//
// 演示完整链路：AS3 显示列表 -> 离屏 Skia CPU 光栅 -> SDL2 窗口上屏 -> 事件循环。
// 运行后弹出一个 720x480 窗口，绘制一个蓝色矩形和一行文字；关闭窗口后返回。
//
// 编译（需要 arm64 SDL2，见 docs/zh-cn/compile.md §6）：
//   as-aot examples/window.as --manifest examples/window.build.example.json

import flash.display.Shape;
import flash.text.TextField;

var stage:Stage = new Stage();

var box:Shape = new Shape();
box.graphics.beginFill(0x3366CC);
box.graphics.drawRect(60, 60, 300, 160);
box.graphics.endFill();
stage.addChild(box);

var tf:TextField = new TextField();
tf.text = "Hello from AS3 -> C -> SDL2 window";
tf.x = 80;
tf.y = 260;
tf.width = 500;
stage.addChild(tf);

// 阻塞在 SDL 事件循环，直到用户关闭窗口（SDL_QUIT）。
stage.showWindow(720, 480, "AS3 Native Window");

trace("window closed");
