// htmltext-metrics.as — getLineText、htmlText 块级行高、规则 leading（阶段三百三十六，D-T23/D-T24）
//
// 背景：阶段一百四十八建 `StyleSheet` 块级模型时登记了三项未修（TODO 遗留表）：
//   ① `htmlText` 多行 run 的**行高**偏大约 1.5×（行数与宽度早已逐值吻合）；
//   ② 规则里的 `leading` 没有折进 run（我们只折 color/fontSize/fontFamily/fontWeight/
//      fontStyle/textDecoration）；
//   ③ `TextField.getLineText` 未实现（响亮 undefined method）。
// 另外本轮顺带量清：**尾部空行不计入 textHeight，但计入 numLines**（air 与 2006 边界）。
//
// adl 51.4.1 双端同源实测（`temp/htmlprobe/Main.as` / `Main2.as`，12px 默认格式）：
//   getLineText: "ab\ncd" → 'ab' / 'cd'；"ab\n" → 'ab' / ''；越界（-1、2、3）→ RangeError #2006
//   "ab\n"          → n=2  th=12（尾部空行不加高）
//   htmlText 两个 <p> → n=3  th=24（两行 12px 盒 + 尾部空行）
//   同一 htmlText + 规则 leading:6px → n=3  th=30，每行 lm = h18/asc9/desc3/lead6，
//                                     尾部空行仍是 h12/asc9/desc3/lead0
//   "1\n2\n…\n10" = 10 行 th=120；appendText("appended\n") 后 n=11、th 仍 120
//
// 断言写成关系式（与字族无关）。纯 C 构建没有 Skia ⇒ getLineText 仍成立（走 CR/LF 行表），
// 但行高是 size×1.2 的近似 ⇒ 与 htmlText 行高相关的断言在该档下跳过。
//
// 编译：
//   as-aot examples/htmltext-metrics.as --manifest examples/autosize-metrics.build.json --run

import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.StyleSheet;
import flash.text.TextLineMetrics;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(a:Number, b:Number, eps:Number):Boolean { return (a > b ? a - b : b - a) <= eps; }

// --- ① getLineText：行文本、尾部空行、越界 2006 ------------------------------
var t:TextField = new TextField();
t.multiline = true;
t.text = 'ab\ncd';
check(t.numLines == 2, 'expected 2 lines, got ' + t.numLines);
check(t.getLineText(0) == 'ab', 'line 0 must be "ab", got "' + t.getLineText(0) + '"');
check(t.getLineText(1) == 'cd', 'line 1 must be "cd", got "' + t.getLineText(1) + '"');

var trailing:TextField = new TextField();
trailing.multiline = true;
trailing.text = 'ab\n';
check(trailing.numLines == 2, 'a trailing newline opens an empty line, got ' + trailing.numLines);
check(trailing.getLineText(0) == 'ab', 'line 0 of "ab\\n", got "' + trailing.getLineText(0) + '"');
check(trailing.getLineText(1) == '', 'the trailing empty line is "" (adl), got "' + trailing.getLineText(1) + '"');

var bad:int = 0;
try { t.getLineText(2); } catch (e:Error) { bad = e.errorID; }
check(bad == 2006, 'getLineText(numLines) must throw #2006, got ' + bad);
bad = 0;
try { t.getLineText(-1); } catch (e2:Error) { bad = e2.errorID; }
check(bad == 2006, 'getLineText(-1) must throw #2006, got ' + bad);

// --- ② 尾部空行不计入 textHeight ----------------------------------------------
var plain:TextField = new TextField();
plain.multiline = true;
plain.text = 'ab\ncd';
var oneBox:Number = plain.textHeight / 2;
check(oneBox > 0, 'a line box must be positive, got ' + oneBox);
check(near(plain.textHeight, 2 * oneBox, 0.01), 'two lines are two boxes, got ' + plain.textHeight);
check(near(trailing.textHeight, oneBox, 0.01),
  'a trailing empty line must not add height (adl: 12), got ' + trailing.textHeight + ' vs box ' + oneBox);

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth > 0) {
  // --- ③ htmlText 块级行高：两个 <p> = 两行盒 + 尾部空行 ---------------------
  var ss:StyleSheet = new StyleSheet();
  var rule:Object = { fontSize: 12 };
  ss.setStyle('p', rule);
  var h:TextField = new TextField();
  h.multiline = true;
  h.wordWrap = false;
  h.styleSheet = ss;
  h.htmlText = '<p>ab</p><p>cd</p>';
  check(h.numLines == 3, 'two <p> elements are 3 lines (last empty), got ' + h.numLines);
  check(near(h.textHeight, 2 * oneBox, 0.5),
    'two <p> lines must be two 12px boxes (adl: 24), got ' + h.textHeight + ' vs box ' + oneBox);
  check(near(h.getLineMetrics(0).height, oneBox, 0.5),
    'an htmlText line box must match a plain line box (was ~1.5x too tall), got ' + h.getLineMetrics(0).height);

  // --- ④ 规则 leading 折进 run ------------------------------------------------
  var ss2:StyleSheet = new StyleSheet();
  var rule2:Object = { fontSize: 12, leading: 6 };
  ss2.setStyle('p', rule2);
  var h2:TextField = new TextField();
  h2.multiline = true;
  h2.wordWrap = false;
  h2.styleSheet = ss2;
  h2.htmlText = '<p>ab</p><p>cd</p>';
  var lm0:TextLineMetrics = h2.getLineMetrics(0);
  check(near(lm0.leading, 6, 0.01), 'a rule leading:6px must be reported by getLineMetrics, got ' + lm0.leading);
  check(near(lm0.height, oneBox + 6, 0.5),
    'the rule leading must grow the line box by 6 (adl: 18), got ' + lm0.height);
  check(near(lm0.ascent + lm0.descent + lm0.leading, lm0.height, 0.01),
    'ascent + descent + leading == height, got ' + lm0.ascent + '+' + lm0.descent + '+' + lm0.leading + ' vs ' + lm0.height);
  check(near(h2.textHeight, 2 * (oneBox + 6) - 6, 0.5),
    'textHeight drops ONE trailing leading (adl: 30), got ' + h2.textHeight);
  var lmLast:TextLineMetrics = h2.getLineMetrics(2);
  check(near(lmLast.height, oneBox, 0.5),
    'the trailing empty line keeps the default box (adl: 12), got ' + lmLast.height);
  check(lmLast.leading == 0, 'the trailing empty line has no rule leading, got ' + lmLast.leading);

  trace('htmltext-metrics: OK (box=' + oneBox + ')');
} else {
  trace('htmltext-metrics: OK (no text backend: htmlText line heights skipped)');
}