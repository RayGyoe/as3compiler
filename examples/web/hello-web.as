// hello-web.as — 自包含的 HTML5 <canvas> 渲染示例（--target wasm --package web）。
//
// 演示完整链路：AS3 显示列表 -> 离屏 Skia CPU 光栅 -> Emscripten -> 浏览器
// canvas -> requestAnimationFrame 事件循环。打开生成的 index.html 后显示一个
// 蓝色矩形和一行文字；文字字体在运行时从网络加载（见 hello-web.build.json 的
// font-urls）。
//
// 示例字体用 Arial.ttf（英文验证）；如需 CJK，把 font-urls 换成 CJK 字体（如
// STHeiti/MiSans）并将文本换成中文。
//
// 编译（需 Emscripten SDK + wasm 版 Skia，见 docs/zh-cn/html5-web.md）：
//   as-aot examples/web/hello-web.as --manifest examples/web/hello-web.build.json

import flash.display.Shape;
import flash.text.TextField;

var stage:Stage = new Stage();

var box:Shape = new Shape();
box.graphics.beginFill(0x3366CC);
box.graphics.drawRect(60, 60, 300, 160);
box.graphics.endFill();
stage.addChild(box);

var tf:TextField = new TextField();
tf.text = "Hello AS3 -> Web";
tf.x = 80;
tf.y = 260;
tf.width = 500;
stage.addChild(tf);

// 在浏览器里启动 requestAnimationFrame 帧循环，直到页面关闭。
stage.showWindow(720, 480, "AS3 Web");
