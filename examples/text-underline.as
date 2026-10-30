// text-underline.as — TextFormat.underline / HTML `<u>` 真的要被**画出来**（G28，阶段三百四十二）。
//
// 背景：underline 一直是「设得上、读得回、复制得走」，但布局与绘制路径**没有一处读它** ——
// htmlText 的绘画分支第一句就是 `(void)underline;`。用户看到的现象是「文字位置/颜色/字号
// 全对，只是没有那条线」。因为下划线**不参与排版**（textWidth / textHeight / getLineMetrics
// 逐位相同），所有几何断言都是绿的，它才一直没被发现。
//
// 判据全部来自 adl 51.4.1 逐像素实测（as3compiler/temp/g28/，22 组字号×字面 + htmlText +
// 混排 + leading + 换行）。选 `_typewriter`（Monaco）是因为它的行盒我们与 AIR 逐值相同
// （12/3，h=15），所以这里的行号是**绝对断言**而不是关系式：
//   * 一行的线是**一条 1 设备像素**的横线，落在 floor(2 + ascent + descent/2)：12px 即 **15**，
//     48px 也仍然是 1 px（AIR 不用字体的 underline metrics，那会给出 3-4 px）；
//   * 横线覆盖该范围的**全部前进宽度**（含行尾空格），右端是半覆盖像素；
//   * 颜色取该 run 自己的 color；
//   * 每个**视觉行**一条（换行/自动换行各一行），leading 不移动它；
//   * 一行里只要有一处下划线，线就按**行盒**落（行盒取该行最高的 run），而不是按 run 字号。
//
// 纯 C 构建没有文本/光栅后端（textWidth 恒 0、draw 是空桩）⇒ trace 跳过后退出，不假装验过。
//
// 编译：
//   as-aot examples/text-underline.as --manifest examples/autosize-metrics.build.json --run

import flash.display.BitmapData;
import flash.display.Shape;
import flash.display.Sprite;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.TextLineMetrics;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var W:int = 320;
var H:int = 400;

var stage:Stage = new Stage();
var bg:Shape = new Shape();
bg.graphics.beginFill(0xFFFFFF);
bg.graphics.drawRect(0, 0, W, H);
bg.graphics.endFill();
stage.addChild(bg);

var yNext:Number = 4;

function mk(w:Number, h:Number, multi:Boolean, wrap:Boolean, ul:Boolean, color:uint):TextField {
  var tf:TextField = new TextField();
  tf.width = w; tf.height = h;
  tf.multiline = multi; tf.wordWrap = wrap;
  var f:TextFormat = new TextFormat();
  f.font = "_typewriter"; f.size = 12; f.color = color; f.underline = ul;
  tf.defaultTextFormat = f;
  tf.x = 6; tf.y = yNext;
  stage.addChild(tf);
  yNext += h + 4;
  return tf;
}

function sp(n:int):String {
  var s:String = "";
  for (var i:int = 0; i < n; i++) s += " ";
  return s;
}

// ---- 用例（顺序即 y 顺序，与 temp/g28 的 adl 探针同形）-------------------
var tfSp:TextField = mk(300, 20, false, false, true, 0x000000);     // t12sp8
tfSp.text = sp(8);
var tfPlain:TextField = mk(300, 20, false, false, false, 0x000000); // t12plain
tfPlain.text = "H    H";
var tfMulti:TextField = mk(300, 60, true, false, true, 0x000000);   // t12multi
tfMulti.text = "ab\ncd\nef";
var tfLead:TextField = mk(300, 20, false, false, true, 0x000000);    // t12lead4
var leadFmt:TextFormat = new TextFormat(); leadFmt.leading = 4;
tfLead.defaultTextFormat = leadFmt;
tfLead.text = "H    H";
var tfPart:TextField = mk(300, 20, false, false, false, 0x000000);  // t12part
tfPart.text = "AAAABBBB";
var partFmt:TextFormat = new TextFormat(); partFmt.underline = true;
tfPart.setTextFormat(partFmt, 0, 4);
var tfSplit:TextField = mk(300, 20, false, false, true, 0x000000);  // split
tfSplit.text = "abcdef";
var offFmt:TextFormat = new TextFormat(); offFmt.underline = false;
tfSplit.setTextFormat(offFmt, 2, 4);
var tfRed:TextField = mk(300, 20, false, false, true, 0xFF0000);    // t12red
tfRed.text = sp(8);
var tfHtml:TextField = mk(300, 40, true, false, false, 0x000000);   // htmlu
tfHtml.htmlText = "<u>abc</u> def";
var tfWrap:TextField = mk(70, 60, true, true, true, 0x000000);      // t12wrap
tfWrap.text = "aa bb cc dd ee";
// 行盒取该行**最高**的那个 run（adl：12px 与 24px 混排的行报 20/6 h=26，与 run 顺序无关）
// ⇒ 小字 run 的下划线按**行盒**落，不按自己的 12px 盒。
var tfMix:TextField = mk(300, 40, true, false, false, 0x000000);    // mix
tfMix.htmlText = "xxxxxxxx<font size=\"24\">  </font>";
var mixFmt:TextFormat = new TextFormat(); mixFmt.underline = true;
tfMix.setTextFormat(mixFmt, 0, 8);

var bd:BitmapData = new BitmapData(W, H, false, 0xFFFFFFFF);
bd.draw(stage);

// 某一行上「非白像素」的左右边界；没墨迹时返回 null
function row(y:int):Object {
  var lo:int = -1, hi:int = -1;
  for (var x:int = 0; x < 300; x++) {
    var v:uint = bd.getPixel32(6 + x, y);
    if (((v >> 16) & 0xFF) != 255 || ((v >> 8) & 0xFF) != 255 || (v & 0xFF) != 255) {
      if (lo < 0) lo = x;
      hi = x;
    }
  }
  return (lo < 0) ? null : { lo: lo, hi: hi };
}

// 行号一律相对字段顶部（AIR 的落脚点就是相对字段的），下面换算成绝对 y。
function rowDy(tf:TextField, dy:int):Object { return row(int(tf.y) + dy); }
function inkDy(tf:TextField, dy:int):Boolean { return rowDy(tf, dy) != null; }
function pixelDy(tf:TextField, dy:int, x:int):uint { return bd.getPixel32(6 + x, int(tf.y) + dy); }

var probe:TextField = mk(300, 20, false, false, false, 0x000000);
probe.text = "x";
if (probe.textWidth <= 0) {
  trace('text-underline: skipped (no text backend)');
} else {
  probe.visible = false;

  // ① 布局不受影响（这是它长期隐身的原因，也必须钉住）：同一个字段加/不加下划线，
  //    textWidth / textHeight / 每行 getLineMetrics 全部逐值相同（adl 实测）。
  var a:TextField = new TextField();
  a.width = 300; a.height = 20;
  var af:TextFormat = new TextFormat(); af.font = "_typewriter"; af.size = 12; af.color = 0;
  a.defaultTextFormat = af; a.text = "        ";
  var b:TextField = new TextField();
  b.width = 300; b.height = 20;
  var bf:TextFormat = new TextFormat(); bf.font = "_typewriter"; bf.size = 12; bf.color = 0; bf.underline = true;
  b.defaultTextFormat = bf; b.text = "        ";
  check(a.textWidth == b.textWidth, "underline must not change textWidth (" + a.textWidth + " vs " + b.textWidth + ")");
  check(a.textHeight == b.textHeight, "underline must not change textHeight");
  var la:TextLineMetrics = a.getLineMetrics(0);
  var lb:TextLineMetrics = b.getLineMetrics(0);
  check(la.ascent == lb.ascent && la.descent == lb.descent && la.height == lb.height,
        "underline must not change getLineMetrics");
  check(la.width == lb.width, "underline must not change getLineMetrics().width");

  // ② 一条 1 px 线，落在 y = 2 + ascent + descent/2 = 15（12px _typewriter）；左右边界
  //    覆盖整个前进宽度（8 个空格 = 57.6 px ⇒ 2..59，右端半覆盖像素算在内）。
  var r:Object = rowDy(tfSp, 15);
  check(r != null, "underline row missing at y=15");
  check(r.lo == 2, "underline must start at the 2 px inset, got x=" + r.lo);
  check(r.hi == 59, "underline must span the run's advance (to x=59), got " + r.hi);
  check(!inkDy(tfSp, 14) && !inkDy(tfSp, 16), "underline must be exactly one device pixel tall");
  check(tfSp.textWidth > 50 && tfSp.textWidth < 62, "the space run must be ~57.6 px wide");

  // ③ 没有下划线就什么都不画（负例：防止「每行都画」的假实现蒙过去）。
  check(!inkDy(tfPlain, 15), "a field without underline must paint no row");

  // ④ 每个视觉行一条：3 行 ⇒ 15 / 30 / 45（行盒 15 px 步进）。
  var m0:Object = rowDy(tfMulti, 15);
  var m1:Object = rowDy(tfMulti, 30);
  var m2:Object = rowDy(tfMulti, 45);
  check(m0 != null && m1 != null && m2 != null,
        "each visual line of a 3-line field must get its own row");
  check(m0.lo == 2 && m0.hi <= 17 && m1.lo == 2 && m2.lo == 2,
        "each row must cover its own line's two characters");

  // ④b 自动换行的每一行同样各一条。
  check(inkDy(tfWrap, 15) && inkDy(tfWrap, 30), "wrapped lines must each get a row");
  check(!inkDy(tfWrap, 45), "a wrapping field has exactly two rows for this text");

  // ⑤ leading 不移动它（AIR：lead4 仍在 15）。
  check(inkDy(tfLead, 15), "leading must not move the row");
  check(!inkDy(tfLead, 19), "leading must not add a second row");

  // ⑥ 局部范围只画那一段：前 4 个字符（2..30），不是整行 2..59。
  var rp:Object = rowDy(tfPart, 15);
  check(rp != null && rp.lo == 2 && rp.hi >= 29 && rp.hi <= 31,
        "setTextFormat(underline, 0, 4) must underline only the first 4 characters, got " +
        (rp == null ? "nothing" : (rp.lo + ".." + rp.hi)));

  // ⑦ 下划线 base + underline=false 的 run ⇒ 线在那一段**断开**（AIR 的 htmlText 读回
  //    "<U>ab</U>cd<U>ef</U>"，行上因此有两个线段）。
  var rs:Object = rowDy(tfSplit, 15);
  check(rs != null, "a split underline must still paint its two segments");
  check(rs.lo == 2 && rs.hi >= 44, "the split row must reach the end of 'ef'");
  var gap:uint = pixelDy(tfSplit, 15, 28);   // 'cd' 中间（字符宽 7.2，第 4 个字符在 23..29）
  check(((gap >> 16) & 0xFF) == 255 && ((gap >> 8) & 0xFF) == 255 && (gap & 0xFF) == 255,
        "the underline must break across an underline=false run");

  // ⑧ 颜色取 run 自己的：red 字段的线是纯红。
  var rr:Object = rowDy(tfRed, 15);
  check(rr != null, "red field must paint a row");
  var rc:uint = pixelDy(tfRed, 15, 10);
  check(((rc >> 16) & 0xFF) == 0xFF && ((rc >> 8) & 0xFF) == 0 && (rc & 0xFF) == 0,
        "underline must use the run's color, got " + rc.toString(16));

  // ⑨ htmlText 的 <u> 走同一条路：base 没有下划线时只画 <u> 那三个字符（2..23）。
  var rh:Object = rowDy(tfHtml, 15);
  check(rh != null && rh.lo == 2 && rh.hi >= 22 && rh.hi <= 24,
        "htmlText <u> must underline just its own run, got " +
        (rh == null ? "nothing" : (rh.lo + ".." + rh.hi)));

  // ⑩ 混排行：线落在**行盒**（24px 那个 run 撑起来的盒）的 descent 中点，不是小字的 15。
  //    24px run 用两个空格 ⇒ 那一带没有任何字形墨迹，行上的像素只可能是这条线。
  var mixLine:TextLineMetrics = tfMix.getLineMetrics(0);
  check(mixLine.height > 20, "the mixed line's box must be the 24px one, got " + mixLine.height);
  var mixDy:int = int(2 + mixLine.ascent + mixLine.descent / 2);
  var rm:Object = rowDy(tfMix, mixDy);
  check(rm != null, "the mixed line's row must sit at the line box's mid-descent (" + mixDy + ")");
  check(rm.lo == 2 && rm.hi >= 58 && rm.hi <= 61,
        "the row must cover the underlined 12px run's advance only, got " + rm.lo + ".." + rm.hi);

  trace('text-underline: ok (row y=15, 1px, run advance, per line, leading-free, split, colored, html <u>)');
}