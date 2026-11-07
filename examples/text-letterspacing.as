// text-letterspacing.as — TextFormat.letterSpacing 必须真的参与排版（G32，阶段三百八十六）。
//
// 背景：`TextFormat.letterSpacing` 一直**存得下、比得出、却读不进排版** ——
// `as_tf_paragraph` 只把 size/bold/italic/leading/color/font 交给 shim，字距被静默忽略。
// 这不是「AIR 没有」的边界：`adl` 上它生效，我们这边设了等于没设（违反 AGENTS §1.5）。
//
// adl 51.4.1 与 AOT 双端同源实测（`asaotui/temp/g31w/`，Arial 12，`autoSize = LEFT`）：
//   "abcd"   ls0 31 / ls2 39 / ls4 47      —— 每字符 +2 / +4
//   "abcdefgh" ls0 55 / ls2 71 / ls4 87    —— 8 字符，同样每字符 +2 / +4
// 两臂逐项相等，且增量只跟字符数走，不跟字形走。
//
// 断言写成**关系式**（`Δ = n × letterSpacing`），与字族和平台字体无关。
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 只证明「不炸」并 trace 跳过。
//
// 编译：
//   as-aot examples/text-letterspacing.as --manifest examples/autosize-metrics.build.json --run

import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.TextFieldAutoSize;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function near(a:Number, b:Number, eps:Number):Boolean { return (a > b ? a - b : b - a) <= eps; }

// Width of `s` laid out with the given tracking, through the SAME field shape the
// measurement path uses (autoSize LEFT, so width = textWidth + 4).
function widthWith(s:String, ls:Number):Number {
  var f:TextField = new TextField();
  var fmt:TextFormat = new TextFormat();
  fmt.font = "Arial";
  fmt.size = 12;
  fmt.letterSpacing = ls;
  f.defaultTextFormat = fmt;
  f.multiline = false;
  f.wordWrap = false;
  f.autoSize = TextFieldAutoSize.LEFT;
  f.text = s;
  return f.width;
}

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth <= 0) {
  trace('text-letterspacing: skipped (no text backend)');
} else {
  var pairs:Array = ['abcd', 'abcdefgh'];
  for (var p:int = 0; p < pairs.length; p++) {
    var s:String = String(pairs[p]);
    var base:Number = widthWith(s, 0);

    // --- ① 零值不改变任何东西（现有产物像素不变）---------------------------
    check(near(widthWith(s, 0), base, 0.02), 'letterSpacing 0 must be a no-op for "' + s + '"');

    // --- ② 正字距按「每个字符一份」加宽 -------------------------------------
    // SkParagraph adds the value to every cluster advance (Run::addSpacesEvenly),
    // and AIR's TextFormat.letterSpacing is the same px-per-character quantity.
    var w2:Number = widthWith(s, 2);
    var w4:Number = widthWith(s, 4);
    var n:Number = s.length;
    check(w2 > base, 'letterSpacing 2 must widen "' + s + '", got ' + w2 + ' vs ' + base);
    check(near(w2 - base, n * 2, 0.05),
      'letterSpacing 2 must add 2 px per character to "' + s + '", got +' + (w2 - base) + ' vs ' + (n * 2));
    check(near(w4 - base, n * 4, 0.05),
      'letterSpacing 4 must add 4 px per character to "' + s + '", got +' + (w4 - base) + ' vs ' + (n * 4));

    // --- ③ 单调：字距越大越宽 -----------------------------------------------
    check(w4 > w2 && w2 > base, 'tracking must be monotonic for "' + s + '"');
  }

  // --- ④ 段落缓存必须跟着格式走 ---------------------------------------------
  // One field, one TextFormat object, mutated between measurements: if the cache
  // key ignored letterSpacing the second read would return the first layout.
  var live:TextField = new TextField();
  var lf:TextFormat = new TextFormat();
  lf.font = "Arial";
  lf.size = 12;
  lf.letterSpacing = 0;
  live.defaultTextFormat = lf;
  live.multiline = false;
  live.wordWrap = false;
  live.autoSize = TextFieldAutoSize.LEFT;
  live.text = 'abcd';
  var before:Number = live.width;
  lf.letterSpacing = 3;
  live.defaultTextFormat = lf;
  // AIR applies defaultTextFormat to text inserted AFTER the assignment, so the
  // field has to be re-filled; that is exactly the path a live edit takes and it
  // must come out with the new tracking (a stale paragraph cache would not).
  live.text = 'abcd';
  var after:Number = live.width;
  check(near(after - before, 4 * 3, 0.05),
    'editing letterSpacing on a live field must re-lay out, got +' + (after - before) + ' vs 12');

  trace('text-letterspacing: OK');
}