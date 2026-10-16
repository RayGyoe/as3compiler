// autosize-metrics.as — TextField.autoSize 的宽度/高度口径回归（差异项 D36/D37，阶段一百六十八）。
//
// 背景：TalkMED 的 AI 同传列表项（`cn.edoctor.view.renderers.AiSubtitleRenderers.updateView`）
// 把皮肤里的 `title` 字段（字体 **MiSans Regular**、wordWrap=true）按
// `skin.title.autoSize = TextFieldAutoSize.LEFT; skin.title.text = ...` 的顺序赋值后，
// **画出来被断成三行、压住了同一子件里的 ctime**，而 adl 51.4.1 只有一行。
// 根因两条，都是我们对 adl 实测口径的偏离：
//
//   ① autoSize 的宽度适配用了「**已换行排版**的最长行宽」：`_fieldWidth = maxLineWidth + 4`。
//      宽度一收，同一段文字的可用宽度就正好等于文本宽 ⇒ 下一次排版又断行、最长行更短 ⇒
//      每绘制一次再收一圈（`temp/tfswc` 实测 290 → 64.66 → 50.66 → 36.66 → 32，逐帧自噬）。
//      adl 的口径：wordWrap=true 时 autoSize **只改高度**（height = textHeight + 4），宽度保持
//      用户给的值；只有 wordWrap=false 才 width = textWidth + 4（**两个方向**都收/放：
//      290→28、"中文"；100→523.5、超长串）。
//   ② 字族装不上时，我们让 Skia 兜底到「哪个 CJK 脸供字形就用哪个的行盒」（PingFang/Songti SC，
//      1.4 em），而 AIR 用**平台默认脸**的行盒：adl 对 `MiSans Regular` / `宋体`（本机都装不上，
//      前者只在 app 包里，而 **AIR 不注册 app 自带字体**）量到的 16px 行盒正是 Helvetica 的 16px。
//      这正是列表项比 adl 高 6px、`ctime.y` 被推下去的直接原因。
//
// 判据来自 adl 51.4.1 双端同源探针（`temp/tfswc` 的 case ⑥⑦⑧⑨⑩，修后 AOT 侧与 adl 逐字相同）。
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 只证明「不炸」并 trace 跳过，不假装验过。
//
// 编译：
//   as-aot examples/autosize-metrics.as --manifest examples/autosize-metrics.build.json --run

import flash.display.BitmapData;
import flash.text.TextField;
import flash.text.TextFieldAutoSize;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function fmt(v:Number):String { return v.toFixed(2); }

var backend:TextField = new TextField();
backend.text = 'x';
if (backend.textWidth <= 0) {
  trace('autosize-metrics: skipped (no text backend)');
} else {
  var fmt12:TextFormat = new TextFormat();
  fmt12.font = '_sans';
  fmt12.size = 12;
  fmt12.color = 0x202020;

  // ① wordWrap=true：autoSize 只适配高度，宽度必须原样不动
  var w1:TextField = new TextField();
  w1.defaultTextFormat = fmt12;
  w1.width = 290;
  w1.height = 30;
  w1.wordWrap = true;
  w1.autoSize = TextFieldAutoSize.LEFT;
  w1.text = '中文-英文';
  check(w1.width == 290, 'wordWrap=true 时 autoSize 不得改宽度（adl: 290），got ' + fmt(w1.width));
  check(w1.numLines == 1, 'wordWrap=true + 宽 290 时 5 个字不得断行，got nl=' + w1.numLines);

  // ② 绘制才是我们应用 autoSize 的时点（`BitmapData.draw` 与渲染路径同一条），
  //    也是 app 里真实触发自噬的地方：反复 draw 不得把宽度收窄。
  //    注：adl 在**赋值后立刻**刷新 height（实测 adl 的 `asLeft` h=18 在任何绘制之前），
  //    我们目前只在这两条路径刷新 ⇒ `height` 的可见值要等一次绘制。
  //    该项记为残差（见 talkmed-meeting-aot-vs-adl-diff.md），本示例只钉宽度/行数/高度口径。
  var bd:BitmapData = new BitmapData(320, 60, true, 0x00FFFFFF);
  for (var i:int = 0; i < 3; i++) bd.draw(w1);
  check(w1.width == 290 && w1.numLines == 1,
        '反复绘制后宽度/行数不得自噬，got w=' + fmt(w1.width) + ' nl=' + w1.numLines);
  check(Math.abs(w1.height - (w1.textHeight + 4)) < 0.01,
        'autoSize 的高度 = textHeight + 4，got h=' + fmt(w1.height) + ' th=' + fmt(w1.textHeight));

  // ③ wordWrap=false：autoSize 把宽度收/放到 textWidth + 4（两个方向）
  var w2:TextField = new TextField();
  w2.defaultTextFormat = fmt12;
  w2.wordWrap = false;
  w2.multiline = true;
  w2.width = 290;
  w2.height = 30;
  w2.autoSize = TextFieldAutoSize.LEFT;
  w2.text = '中文-英文';
  check(Math.abs(w2.width - (w2.textWidth + 4)) < 0.01,
        'wordWrap=false 时宽度收成 textWidth + 4，got w=' + fmt(w2.width) + ' tw=' + fmt(w2.textWidth));
  var before:Number = w2.width;
  w2.text = '中文-英文中文-英文中文-英文中文-英文中文-英文中文-英文中文-英文中文-英文中文-英文中文-英文';
  check(w2.width > before && Math.abs(w2.width - (w2.textWidth + 4)) < 0.01,
        'wordWrap=false 时宽度放大到 textWidth + 4，got w=' + fmt(w2.width) + ' tw=' + fmt(w2.textWidth));

  // ④ 装不上的字族 = 平台默认脸（Helvetica）的度量，不是 CJK 兜底脸的行盒
  var fmtUn:TextFormat = new TextFormat();
  fmtUn.font = 'NoSuchFamilyXYZ12345';
  fmtUn.size = 16;
  var w3:TextField = new TextField();
  w3.defaultTextFormat = fmtUn;
  w3.wordWrap = false;
  w3.multiline = true;
  w3.width = 290;
  w3.height = 30;
  w3.text = '中文-英文';
  var fmtHv:TextFormat = new TextFormat();
  fmtHv.font = 'Helvetica';
  fmtHv.size = 16;
  var w4:TextField = new TextField();
  w4.defaultTextFormat = fmtHv;
  w4.wordWrap = false;
  w4.multiline = true;
  w4.width = 290;
  w4.height = 30;
  w4.text = '中文-英文';
  check(w3.textWidth == w4.textWidth && w3.textHeight == w4.textHeight,
        '装不上的字族必须用平台默认脸的行盒：unknown(' + fmt(w3.textWidth) + ',' + fmt(w3.textHeight)
        + ') vs Helvetica(' + fmt(w4.textWidth) + ',' + fmt(w4.textHeight) + ')');

  trace('autosize-metrics: autoSize 只改高度(wordWrap=true)/改宽度(textWidth+4, wordWrap=false)、'
        + '未知字族回落平台默认脸 — assertions passed');
}
