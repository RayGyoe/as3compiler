// textmetrics.as — TextField 派生度量往返（as3compiler 版，需要 Skia 文本后端）
//
// 被测形态：8 个 200 行、wordWrap=false 的字段，每轮读一遍
// `numLines` / `textWidth` / `textHeight` / `maxScrollH`。这正是「大文本字段」
// 在应用里的典型读法（布局算高、算横向溢出、算滚动上限），也是绘制路径每帧都会
// 触碰的那几个入口（maxScrollH 在 as_render_object 的 TextField 分支里无条件调用）。
//
// 本基准只有两路：C 与 JS 没有 Skia 排版，无从对照（见 report.md）。
// checksum 只累加**行数 + 截断后的 textWidth + maxScrollH**：文本度量是浮点，
// Shaping 结果逐个浮点相同是做不到的；而 `textHeight` 两端本就存在已登记的
// 口径差（同一夹具：我们 2600、AIR 2700，逐行 13 vs 13.5，见 report.md 与
// TODO 遗留表），所以它照旧参与**计时**、但单独作为诊断打印，不进 checksum——
// 否则这条差异会把「性能回退」和「已知口径差」混成一个失败。
import flash.text.TextField;
import flash.text.TextFormat;

var FIELDS:int = 8;
var LINES:int = 200;
var ITERS:int = 20000;

function mkLines(n:int):String {
  var a:Array = [];
  for (var i:int = 0; i < n; i++) a.push("the quick brown fox jumps over the lazy dog 0123456789");
  return a.join("\n");
}

var text:String = mkLines(LINES);
var fields:Array = [];
for (var f:int = 0; f < FIELDS; f++) {
  var tf:TextField = new TextField();
  var fmt:TextFormat = new TextFormat();
  fmt.font = "Arial";
  fmt.size = 12;
  fmt.color = 0x000000;
  tf.defaultTextFormat = fmt;
  tf.width = 200;
  tf.height = 300;
  tf.multiline = true;
  tf.wordWrap = false;
  tf.text = text;
  fields.push(tf);
}

// 一行诊断（不进 checksum）：让 report.md 能记下这台机器上的真实口径。
var probe:TextField = fields[0];
trace("metrics nl=" + probe.numLines + " tw=" + int(probe.textWidth) +
      " th=" + int(probe.textHeight) + " msh=" + probe.maxScrollH);

// 预热一遍且不计时：第一次读会触发**懒排版**（8 个段落 + 首次度量），那是「建字段」
// 的成本，不是「读度量」的成本。本基准量的是稳态读，故先把 8 个段落排出来（AIR 侧
// 同样先跑一遍）。阶段四百三十八之前 30 轮里这 3 ms 的首排成本占了九成，掩盖了读路径。
var warm:int = 0;
for (var w:int = 0; w < FIELDS; w++) {
  warm += fields[w].numLines + int(fields[w].textWidth) + int(fields[w].textHeight) + fields[w].maxScrollH;
}

var checksum:int = 0;
var thsum:int = 0;

var t0:Number = new Date().getTime();
for (var it:int = 0; it < ITERS; it++) {
  for (var k:int = 0; k < FIELDS; k++) {
    var g:TextField = fields[k];
    checksum += g.numLines;
    checksum += int(g.textWidth);
    checksum += g.maxScrollH;
    thsum += int(g.textHeight);
  }
}
var t1:Number = new Date().getTime();

trace("thsum=" + thsum + " (textHeight: timed, not checked)");

trace("result=" + checksum);
trace("time=" + int(t1 - t0));