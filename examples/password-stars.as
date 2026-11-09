// password-stars.as — displayAsPassword 的星号个数按 UTF-16 码元（G38 之后的索引域）
//
// 背景：本运行时把 String 存成 UTF-8，但索引域（length/charCodeAt/indexOf、
// TextField 的选区换算）自 G38 起是 UTF-16 码元。密码框的「星号串」是唯一
// 还停在**字节域**的地方：以前一个 UTF-8 字节打一颗星，因此 "中文ab"（8 字节）
// 画 8 颗星；AIR 按码元画 4 颗。
//
// adl 51.4.1 实测（temp/pwd/air/AirPwd.as，_typewriter 12 号，textWidth 为星号串宽度）：
//   plain "中文ab"  w=38.00      （非密码，4 个真实字形）
//   pwd   "中文ab"  w=20.00      ← 与 "****" 完全相同 ⇒ 4 颗星
//   pwd   "****"    w=20.00
//   pwd   "************" w=60.00 （12 颗星，用于反证「不是按字节」）
//   pwd   "ab"      w=10.00
//   pwd   "😀"      w=10.00      ← 与 "**" 相同 ⇒ 星替码元（代理对 2 颗）
//   pwd   "**"      w=10.00
//   pwd   "a\r中"   lines=2, getLineText(0)="a"、getLineText(1)="中"（真实文本，不是星号）
//
// 本仓同一份源码修正前后（temp/pwd/T.as）：
//   修前 pwd-cjk w=40.00（8 颗）、pwd-emoji w=20.00（4 颗）
//   修后 pwd-cjk w=20.00（4 颗）、pwd-emoji w=10.00（2 颗）—— 与 AIR 逐值一致
//
// 断言写成关系式（与字族/字号无关：只比「同一字体的星号宽度」），因此纯 C 构建
// （无 Skia，度量是近似值）同样成立。
//
// 编译：as-aot examples/password-stars.as --manifest examples/autosize-metrics.build.json --run

import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.TextFieldAutoSize;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 一个 12 号默认格式的字段；autoSize 让 textWidth 反映布局结果。
function field(text:String, pwd:Boolean):TextField { return fieldML(text, pwd, false); }
function fieldML(text:String, pwd:Boolean, ml:Boolean):TextField {
  var tf:TextField = new TextField();
  var f:TextFormat = new TextFormat();
  f.font = "_typewriter";
  f.size = 12;
  tf.defaultTextFormat = f;
  tf.autoSize = TextFieldAutoSize.LEFT;
  tf.multiline = ml;
  tf.displayAsPassword = pwd;
  tf.text = text;
  return tf;
}

var probe:TextField = field("x", false);
if (probe.textWidth > 0) {
  // 参照物：星号宽度只取决于字体，1/2/4/8/12 颗星各自一个宽度。
  var one:Number = field("*", true).textWidth;
  var two:Number = field("**", true).textWidth;
  var four:Number = field("****", true).textWidth;
  var eight:Number = field("********", true).textWidth;
  var twelve:Number = field("************", true).textWidth;
  check(one > 0 && eight > four && four > two && two > one, 'star widths must be monotonic');

  // --- ① 中日韩：一颗星一个码元（不是一字节一颗） --------------------------
  var cjk:TextField = field("中文ab", true);
  check(cjk.textWidth == four, '"中文ab" masked must be 4 stars (adl 20.00), got ' + cjk.textWidth +
    ' (4 stars = ' + four + ', 8 stars = ' + eight + ')');
  check(cjk.textWidth != eight, '"中文ab" masked must NOT be byte-based (8 stars), got ' + cjk.textWidth);
  // 真实文本仍在 .text 里，且索引域是码元（G38）。
  check(cjk.text == "中文ab", 'masked field must keep the real text, got "' + cjk.text + '"');
  check(cjk.text.length == 4, '"中文ab".length must be 4 code units, got ' + cjk.text.length);

  // --- ② 星替码元：代理对（4 字节）是一颗星两颗星 ---------------------------
  var emoji:TextField = field("😀", true);
  check(emoji.textWidth == two, 'an astral character masked must be 2 stars (adl 10.00), got ' + emoji.textWidth);
  check(emoji.textWidth != four, 'an astral character masked must NOT be per byte (4 stars), got ' + emoji.textWidth);

  // --- ③ ASCII 不变：本来就是字节 == 码元 ---------------------------------
  check(field("ab", true).textWidth == two, 'ASCII "ab" masked must be 2 stars, got ' + field("ab", true).textWidth);
  check(field("********", true).textWidth == eight, 'ASCII stars are unaffected, got ' + field("********", true).textWidth);

  // --- ④ 换行照旧折行，且 getLineText 读到的是**真实文本** ----------------
  //    adl 51.4.1：masked CR 字段 l0=[a] l1=[中]，即星号只换字形，不动文本 API。
  //    （multiline=false 时 AIR 仍按 CR 折行、本运行时折叠成 1 行，是另一条已登记的
  //     遗留差异，与本例无关，所以这里用 multiline=true 让两端同口径。）
  var multi:TextField = fieldML("a\r中", true, true);
  check(multi.numLines == 2, 'a masked CR must still break the line, got ' + multi.numLines + ' lines');
  check(multi.getLineText(0) == "a", 'getLineText must read the real text (adl: [a]), got "' + multi.getLineText(0) + '"');
  check(multi.getLineText(1) == "中", 'getLineText must read the real text (adl: [中]), got "' + multi.getLineText(1) + '"');
  check(multi.textWidth == one, 'a 1-character masked line is 1 star wide, got ' + multi.textWidth + ' vs ' + one);

  // --- ⑤ 关掉 displayAsPassword 之后回到真实文本的度量 ---------------------
  var plain:TextField = field("中文ab", false);
  check(plain.textWidth > cjk.textWidth, 'unmasked CJK must be wider than 4 stars, got ' + plain.textWidth);
  check(twelve > eight, 'star widths grow with count, got ' + twelve + ' vs ' + eight);

  trace('password-stars: OK (1 star = ' + one + ', 4 = ' + four + ', 8 = ' + eight + ')');
} else {
  trace('password-stars: OK (no text backend: metrics skipped)');
}