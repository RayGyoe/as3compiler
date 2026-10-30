// textwidth-trailing.as — TextField.textWidth / getLineMetrics().width 的「行尾空白」口径
// （差异项 D-T22，阶段三百三十六）。
//
// 背景：阶段八十九·六十六修断行阈值（`width - 4`）时顺带发现、当时登记未修的一项：
// 对带尾空格的文本，`adl` 的 `textWidth` 是**含**尾空格的，我们恒等于不含（Skia 的
// `getLongestLine()` / `LineMetrics::fWidth` 会把行尾空白簇减掉）。它不影响断行
// （尾空格本来就不能成为新行起点），但它是 **AIR 可观测的属性**：Starling 的
// `TrueTypeCompositor` 正是用 `textWidth` 定尺建 `BitmapData`，宽度少一个空格就会被裁掉。
//
// adl 51.4.1 双端同源实测（`temp/tfw2/Main.as`，12px `_sans`）：
//   `"Multitouch"` 53  → `"Multitouch "` 56 → `"Multitouch  "` 59（每个空格 +3）
//   `"a"` 5 → `"a "` 8；`"  "` 6、`"   "` 9（纯空白行：textWidth 含空格，但
//   `getLineMetrics(0).width` 仍是 **0**）
//   `"ab\ncd"` 11；`"ab  \ncd"` 17（第 0 行 11+6）、`"ab\ncd  "` 17
//   24px 同理：`"ab"` 26.5 → `"ab "` 33
//
// 断言全部写成**关系式**（与字族无关）：两端的字面值依赖平台字体，关系不依赖。
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 只证明「不炸」并 trace 跳过。
//
// 编译：
//   as-aot examples/textwidth-trailing.as --manifest examples/autosize-metrics.build.json --run

import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.TextFieldAutoSize;
import flash.text.TextLineMetrics;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(a:Number, b:Number, eps:Number):Boolean { return (a > b ? a - b : b - a) <= eps; }

function tw(s:String):Number {
  var f:TextField = new TextField();
  f.text = s;
  return f.textWidth;
}
function lineWidth(s:String, i:int):Number {
  var f:TextField = new TextField();
  f.text = s;
  return f.getLineMetrics(i).width;
}

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth <= 0) {
  trace('textwidth-trailing: skipped (no text backend)');
} else {
  // --- ① 单个空格就是「一个空格的前进宽」-----------------------------------
  var space:Number = tw(' ');
  check(space > 0, 'a lone space must measure wider than 0, got ' + space);
  var wA:Number = tw('a');
  var wA1:Number = tw('a ');
  var wA2:Number = tw('a  ');
  check(wA1 > wA, 'trailing space must count: "a " (' + wA1 + ') vs "a" (' + wA + ')');
  check(near(wA1 - wA, space, 0.02),
    'one trailing space must add exactly one space advance, got +' + (wA1 - wA) + ' vs ' + space);
  check(near(wA2 - wA, 2 * space, 0.02),
    'two trailing spaces must add two advances, got +' + (wA2 - wA) + ' vs ' + (2 * space));

  // --- ② 纯空白串：textWidth 含空格，但行宽仍是 0（adl 口径）----------------
  check(tw('  ') > 0, 'a blanks-only field must still report a textWidth, got ' + tw('  '));
  check(lineWidth('  ', 0) == 0, 'a blanks-only LINE reports width 0 (adl), got ' + lineWidth('  ', 0));

  // --- ③ getLineMetrics().width 与 textWidth 同口径 ------------------------
  check(near(lineWidth('ab ', 0), tw('ab '), 0.02),
    'line width must include trailing blanks like textWidth, got ' + lineWidth('ab ', 0) + ' vs ' + tw('ab '));
  // multiline is set explicitly: whether a NON-multiline field honours '\n' is a
  // separate open question (both fields measure the same on adl, but our layout
  // currently folds '\n' in a single-line field), so this example keeps that
  // variable out of the way.
  var two:TextField = new TextField();
  two.multiline = true;
  two.text = 'ab \ncd';
  check(near(two.getLineMetrics(0).width, tw('ab '), 0.02),
    'line 0 of "ab \\ncd" must measure like the standalone "ab , got ' + two.getLineMetrics(0).width);
  check(near(two.getLineMetrics(1).width, tw('cd'), 0.02),
    'line 1 must NOT inherit line 0 blanks, got ' + two.getLineMetrics(1).width + ' vs ' + tw('cd'));

  // --- ④ 最长行口径：尾空格参与「最长行」的比较 ----------------------------
  var trailingLonger:TextField = new TextField();
  trailingLonger.multiline = true;
  trailingLonger.text = 'ab\ncd  ';
  check(near(trailingLonger.textWidth, tw('cd  '), 0.02),
    'a blank-padded SHORT line can become the longest one, got ' + trailingLonger.textWidth);

  // --- ⑤ autoSize 消费同一口径（width = textWidth + 4）----------------------
  var auto:TextField = new TextField();
  var fmt:TextFormat = new TextFormat(null, 12, 0x000000);
  auto.defaultTextFormat = fmt;
  auto.autoSize = TextFieldAutoSize.LEFT;
  auto.text = 'ab ';
  check(near(auto.width, tw('ab ') + 4, 0.02),
    'autoSize width must follow the trailing-blank textWidth, got ' + auto.width + ' vs ' + (tw('ab ') + 4));

  trace('textwidth-trailing: OK (space=' + space + ')');
}