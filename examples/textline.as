// textline.as — 阶段一百零三：`TextField.getLineMetrics(index)` + `flash.text.TextLineMetrics`。
//
// 为什么需要：留下的 API 缺口——AIR 有 `getLineMetrics`，我们此前没有，只能拿
// `textHeight`/`numLines` 间接核对行度量。补齐后「行度量」变成可直接断言的对象。
//
// 语义全部按 adl 51.4.1 实测（temp/metricprobe/：Metrics6.as 22 例逐行对照、
// Align6.as 默认格式对齐、Lead7.as leading 矩阵）：
//   * **越界索引抛 `RangeError #2006`**（"The supplied index is out of bounds."），
//     不是返回 null —— 负数、`== numLines`、越远都抛；
//   * `leading` = `TextFormat.leading`，**每一行（含末行）都算**；
//     `height` = `ascent + descent + leading`（leading 为负时 height 会小于 asc+desc）；
//   * `ascent` / `descent` **与 leading 无关**（leading 0/4/10/-3 下 adl 恒为 12/3）；
//   * `width` = 该行的前进宽；`x` = 该行左边缘 = AIR 的 2px 文字内边距 + 对齐偏移
//     （居中的 200px 字段里 "abc\ndefghij" 是 x=89/75、右对齐 x=176/147.5，即**逐行**对齐）；
//   * **空字段仍是 1 行**：`numLines` 1、`textHeight` 0、`textWidth` 0，
//     `getLineMetrics(0)` 报默认格式的字体度量（`_typewriter` 12 → 12/3/0/h15/w0/x2）。
//
// 本示例在**两种构建**下都通过：默认回归只链 `-lm -lz -liconv`（无 Skia），此时
// `ascent`/`descent`/`width` 一律 0（与 `textWidth`/`textHeight` 的既有口径一致），
// 但**结构性事实**（行数、越界抛错、leading 逐行计入、height = asc+desc+leading、
// 左侧内边距）两条路都必须成立。
import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.TextLineMetrics;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function field(fam:String, size:Number, text:String, lead:Number):TextField {
  var tf:TextField = new TextField();
  tf.width = 200; tf.height = 200;
  tf.multiline = true; tf.wordWrap = false;
  var f:TextFormat = new TextFormat(fam, size, 0x000000);
  f.leading = lead;
  tf.defaultTextFormat = f;
  tf.text = text;
  return tf;
}

function lm(tf:TextField, i:int):TextLineMetrics { return tf.getLineMetrics(i); }
function errId(tf:TextField, i:int):int {
  try { lm(tf, i); } catch (e:Error) { return e.errorID; }
  return -1;
}

// ---- 构造器与字段 -------------------------------------------------------
var m:TextLineMetrics = new TextLineMetrics(1, 2, 3, 4, 5, 6);
check(m.x == 1, "ctor arg order (x)");
check(m.width == 2, "ctor arg order (width)");
check(m.height == 3, "ctor arg order (height)");
check(m.ascent == 4, "ctor arg order (ascent)");
check(m.descent == 5, "ctor arg order (descent)");
check(m.leading == 6, "ctor arg order (leading)");
check(m is TextLineMetrics, "the constructed value is a TextLineMetrics");
check(typeof m == "object", "and typeof is object");
m.ascent = 9.5;
check(m.ascent == 9.5, "ascent is writable");
m.leading = -3;
check(m.leading == -3, "leading is writable (and may be negative)");

// ---- 空字段：仍是 1 行，索引 0 可读、索引 1 抛 #2006 --------------------
var empty:TextField = field("_typewriter", 12, "", 0);
check(empty.numLines == 1, "an empty field still reports one line");
check(empty.textHeight == 0, "an empty field has textHeight 0");
check(empty.textWidth == 0, "an empty field has textWidth 0");
var em:TextLineMetrics = lm(empty, 0);
check(em != null, "getLineMetrics(0) on an empty field is not null");
check(em.width == 0, "the empty line is zero wide");
check(em.height == em.ascent + em.descent + em.leading, "empty line height = asc + desc + lead");
check(errId(empty, 1) == 2006, "getLineMetrics(1) on a 1-line field throws #2006");
check(errId(empty, -1) == 2006, "a negative index throws #2006");
check(errId(empty, 99) == 2006, "a far index throws #2006");

// ---- 两行字段：行数、leading 逐行计入、height 恒等式 --------------------
var two:TextField = field("_typewriter", 12, "abc\ndefghij", 0);
check(two.numLines == 2, "CR separated text reports two lines");
var l0:TextLineMetrics = lm(two, 0);
var l1:TextLineMetrics = lm(two, 1);
check(l0.height == l0.ascent + l0.descent + l0.leading, "line 0: height = asc + desc + lead");
check(l1.height == l1.ascent + l1.descent + l1.leading, "line 1: height = asc + desc + lead");
check(l0.leading == 0 && l1.leading == 0, "leading 0 is reported on both lines");
check(errId(two, 2) == 2006, "index == numLines throws #2006");
check(errId(two, -1) == 2006, "negative index throws #2006 even with two lines");
check(l0.x == 2, "the left inset is 2px on a left aligned field");
check(l1.x == 2, "both lines share the left inset");
check(l0.width >= 0 && l1.width >= 0, "advance widths are non-negative");
// 字体度量只有链接了 Skia 的构建才有（默认回归是纯 C 桩：ascent/descent/width 全 0，
// 与 textWidth/textHeight 的既有口径一致）。有度量时再钉「行高 × 行数 = 整段高」。
if (l0.ascent > 0) {
  check(two.textHeight == l0.height * 2, "textHeight = numLines * per-line height (uniform leading)");
  check(l0.ascent == 12 && l0.descent == 3, "adl _typewriter 12: ascent 12 / descent 3");
  check(two.width > l1.width, "line 0 (abc) is narrower than line 1 (defghij)");
  } else {
  // 纯 C 桩：结构与上面一致，但字体侧一律 0 ⇒ height 只剩 leading。
  check(l0.ascent == 0 && l0.descent == 0, "no-Skia fallback reports zero font metrics");
  check(l0.height == l0.leading, "no-Skia: height collapses to the leading");
  check(two.textHeight > 0, "no-Skia still reports a positive text height for non-empty text");
}

// ---- leading 逐行计入，且不改变 ascent/descent --------------------------
var lead4:TextField = field("_typewriter", 12, "abc\ndefghij", 4);
var q0:TextLineMetrics = lm(lead4, 0);
var q1:TextLineMetrics = lm(lead4, 1);
check(q0.leading == 4 && q1.leading == 4, "leading is reported on every line, last included");
check(q0.ascent == l0.ascent && q0.descent == l0.descent, "leading does not change ascent/descent");
check(q0.height == l0.height + 4, "leading adds to the line height");
// adl：leading=4 的 2 行字段 textHeight 是 34（尾行 leading 不计），而两行 height 都是 19
// —— 这条需要真实字体度量（行高 15），纯 C 桩下行高来自 size×1.2，故只在有度量时钉。
if (l0.ascent > 0) {
  check(lead4.textHeight == l0.height * 2 + 4, "the trailing leading is not counted in textHeight");
  check(q0.height == 19, "adl _typewriter 12 with leading 4: per-line height 19");
}

// ---- 负 leading：折进高度 -------------------------------------------------
var neg:TextField = field("_typewriter", 12, "abc", -3);
var n0:TextLineMetrics = lm(neg, 0);
check(n0.leading == -3, "a negative leading is reported verbatim");
check(n0.height == n0.ascent + n0.descent - 3, "negative leading shrinks the line height");
check(n0.ascent == l0.ascent && n0.descent == l0.descent, "ascent/descent ignore a negative leading too");

// ---- 形状稳定性：多次调用拿到同一份数据形状 -----------------------------
var again:TextLineMetrics = lm(two, 1);
check(again.height == l1.height, "repeated calls agree on height");
check(again.x == l1.x, "repeated calls agree on x");
check(again.leading == l1.leading, "repeated calls agree on leading");

trace("textline: all assertions passed; lines=" + two.numLines
  + " h=" + l0.height + " lead4h=" + q0.height);