// Main.as — TextField 显示矩阵探针（立项文档 docs/zh-cn/flash-text.md §3）。
//
// 「对齐 TextField 这座大山」前先要一把**尺子**：同一份程序在两端跑，把每一格
// TextField 显示自由度的**可观测数值**写进同一格式的报告，逐行 diff。
//
//   AOT : node src/index.ts examples/textfield/Main.as examples/textfield/entry.as -o <out> --run
//   adl : examples/textfield/run-adl.sh          （mxmlc 编 SWF → adl）
//
// 报告落点：各自的 File.applicationStorageDirectory/textfield-report.txt
//   AIR : ~/Library/Application Support/<app-id>/Local Store/
//   AOT : ~/Library/Application Support/as3aot/Local Store/
// 由 run-adl.sh / run-aot.sh 收集到 temp/textfield-oracle/{adl,aot}.txt 再 diff。
//
// 第二条通道（可选，`new Main(true)`）：把一部分用例铺成一张网格图，写
// textfield-grid.raw。报告只覆盖**数值**，看不见颜色/粗斜下划线的形状/字形本身，
// 这张图补的就是那一半——见下方「UI 网格」一节与 grid.py。
//
// 口径：本例是**观测器**，不是断言器——AIR 的真值由 adl 侧提供，差异回填
// flash-text.md §2 的表。这里只断言**自洽不变量**（度量非负、逐行度量可读、
// 空文本 textWidth 为 0），这些在两端都必须成立；一旦不成立说明运行时出错，
// 应当以非零退出响亮失败（AGENTS §2.5）。
package {
import flash.display.Sprite;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.text.StyleSheet;
import flash.text.TextFieldAutoSize;
import flash.text.TextFieldType;
import flash.text.TextLineMetrics;
import flash.display.BitmapData;
import flash.display.Shape;
import flash.geom.Matrix;
import flash.geom.Rectangle;
import flash.utils.ByteArray;
import flash.filesystem.File;
import flash.filesystem.FileMode;
import flash.filesystem.FileStream;

public class Main extends Sprite {
  private static var rep:String = "";
  private static var cases:int = 0;
  private static var bad:int = 0;
  // 每个用例的 (label, TextField) 留档，供 UI 网格挑一部分铺图（见 buildGrid）。
  private static var gridLabels:Array = [];
  private static var gridTfs:Array = [];

  // ui=false 是**回归口径**：目录单元跑的就是 `new Main()`，不该每次多写一个 4 MB 位图。
  public function Main(ui:Boolean = false) {
    run();
    if (ui) buildGrid();
  }

  private static function run():void {
    rep = "";
    cases = 0;
    bad = 0;
    note("# textfield-probe v1");

    // ---- 1. 空字段 / 基本 ----
    simple("empty", "");
    simple("one-word", "Book");

    // ---- 2. 字体家族（含通用别名与 NULL 默认） ----
    fontCase("font-null", null);
    fontCase("font-sans", "_sans");
    fontCase("font-serif", "_serif");
    fontCase("font-typewriter", "_typewriter");
    fontCase("font-arial", "Arial");
    fontCase("font-helvetica", "Helvetica");
    fontCase("font-timesnewroman", "Times New Roman");
    fontCase("font-courier", "Courier");
    fontCase("font-unknown", "NoSuchFontXYZ");

    // ---- 3. 字号 ----
    sizeCase("size08", 8);
    sizeCase("size10", 10);
    sizeCase("size12", 12);
    sizeCase("size14", 14);
    sizeCase("size16", 16);
    sizeCase("size24", 24);
    sizeCase("size32", 32);

    // ---- 4. 粗细/斜体/下划线/字距/字间距 ----
    styleCase("bold", true, false, false, 0, 0);
    styleCase("italic", false, true, false, 0, 0);
    styleCase("underline", false, false, true, 0, 0);
    styleCase("letterspacing2", false, false, false, 2, 0);
    styleCase("kerning", false, false, false, 0, 0);
    styleCase("bolditalic", true, true, false, 0, 0);

    // ---- 5. leading ----
    leadingCase("lead0", 0);
    leadingCase("lead4", 4);
    leadingCase("lead8", 8);

    // ---- 6. 对齐（有/无排版宽度） ----
    alignCase("align-left-ww", "left", true);
    alignCase("align-center-ww", "center", true);
    alignCase("align-right-ww", "right", true);
    alignCase("align-justify-ww", "justify", true);
    alignCase("align-left-noww", "left", false);
    alignCase("align-center-noww", "center", false);
    alignCase("align-right-noww", "right", false);

    // ---- 7. 文本内容（行尾空格 / 行首空格 / tab / CJK / emoji / 混排） ----
    simple("trail-space1", "Book ");
    simple("trail-space3", "Book   ");
    simple("lead-space", "   Book");
    simple("embedded-tab", "a\tb");
    simple("cjk", "中文测试");
    simple("cjk-mixed", "ab你好cd");
    simple("emoji", "aZ");
    simple("punct", "W.,;:!?");

    // ---- 8. 多行 / 软换行 ----
    multiCase("ml-lf", "alpha\nbeta\ngamma", false, 200, 90);
    multiCase("ml-cr", "alpha\rbeta", false, 200, 90);
    multiCase("ml-crlf", "alpha\r\nbeta", false, 200, 90);
    multiCase("ml-wrap-off", "the quick brown fox jumps over the lazy dog", false, 120, 120);
    multiCase("ml-wrap-on", "the quick brown fox jumps over the lazy dog", true, 120, 120);
    multiCase("ml-wrap-wrap-cjk", "中文换行测试中文换行测试中文换行测试", true, 80, 120);
    multiCase("ml-align-center", "aa\nbbbbbb\ncc", false, 200, 90);

    // ---- 9. autoSize ----
    autoSizeCase("auto-left", TextFieldAutoSize.LEFT);
    autoSizeCase("auto-center", TextFieldAutoSize.CENTER);
    autoSizeCase("auto-right", TextFieldAutoSize.RIGHT);

    // ---- 10. 密码掩码（ASCII / CJK；D-T6） ----
    simple("plain-W", "WWWWWW");
    simple("plain-i", "iiiiii");
    passwordCase("pwd-ascii", "secret");
    passwordCase("pwd-cjk", "中文ab");
    passwordCase("pwd-cjk-only", "中");
    passwordCase("pwd-ml", "ab\ncd");
    // 掩码的**设置顺序**：先 text 后 displayAsPassword vs 先 displayAsPassword 后 text。
    // AIR 的 textWidth 是哪一种（星号驱动 / 明文驱动）由这里的 W/i 对照定案。
    passwordOrderCase("pwd-after-W", "WWWWWW", false);
    passwordOrderCase("pwd-before-W", "WWWWWW", true);
    passwordOrderCase("pwd-after-i", "iiiiii", false);
    passwordOrderCase("pwd-before-i", "iiiiii", true);

    // ---- 11. maxChars / appendText ----
    maxCharsCase("maxchars3", "abcdef", 3);
    appendCase("append", "one", "+two");

    // ---- 12. 富文本 htmlText ----
    htmlCase("html-bold", "<b>Bold</b> normal");
    htmlCase("html-font-color", "<font color='#ff0000'>red</font> blue");
    htmlCase("html-br", "a<br>b");
    htmlCase("html-p-block", "<p>one</p><p>two</p>");
    htmlCase("html-condense", "  a   b  ");
    htmlCase("html-span-size", "<span class='big'>Big</span> small");
    htmlCase("html-underline", "<u>u</u> plain");
    // Character references: AIR decodes the named set and the numeric forms when
    // htmlText is set, and `text` reports the DECODED character (talkmed's footer
    // line depends on this -- it is a run of &nbsp; before the domain).
    htmlCase("html-entity-nbsp", "a&nbsp;&nbsp;b");
    htmlCase("html-entity-named", "&lt;x&gt; &amp; &quot;q&quot; &apos;");
    htmlCase("html-entity-numeric", "&#65;&#x4e2d;&#22269;");

    // ---- 13. setTextFormat 区间 ----
    rangeCase("range");

    // ---- 14. 盒装饰 ----
    decorCase("border-bg");

    // ---- 15. 可编辑 ----
    inputCase("input-single", false);
    inputCase("input-multiline", true);

    // ---- 16. 滚动 ----
    scrollCase("scroll-clamp");

    note("summary cases=" + cases + " fails=" + bad);
    writeReport(rep);
    if (bad > 0) {
      throw new Error(bad + " self-consistency assertion(s) failed (see textfield-report.txt)");
    }
  }

  // ---------------------------------------------------------------- builders

  private static function mk(text:String, font:String, size:Number, w:Number, h:Number):TextField {
    var tf:TextField = new TextField();
    tf.width = w;
    tf.height = h;
    tf.defaultTextFormat = new TextFormat(font, size, 0x000000);
    tf.text = text;
    return tf;
  }

  private static function simple(label:String, text:String):void {
    rec(label, mk(text, "_sans", 12, 240, 60));
  }

  private static function fontCase(label:String, font:String):void {
    rec(label, mk("Wag il1", font, 12, 240, 40));
  }

  private static function sizeCase(label:String, size:Number):void {
    rec(label, mk("Wag il1", "_sans", size, 240, 60));
  }

  private static function styleCase(label:String, bold:Boolean, italic:Boolean, underline:Boolean, ls:Number, kern:Number):void {
    var tf:TextField = mk("Wag il1", "_sans", 12, 300, 50);
    var f:TextFormat = new TextFormat("_sans", 12, 0x000000);
    f.bold = bold;
    f.italic = italic;
    f.underline = underline;
    f.letterSpacing = ls;
    f.kerning = kern == 1;
    tf.defaultTextFormat = f;
    tf.text = "Wag il1";
    rec(label, tf);
  }

  private static function leadingCase(label:String, lead:Number):void {
    var tf:TextField = new TextField();
    tf.width = 240; tf.height = 90;
    tf.multiline = true; tf.wordWrap = true;
    var f:TextFormat = new TextFormat("_sans", 12, 0x000000);
    f.leading = lead;
    tf.defaultTextFormat = f;
    tf.text = "aa\nbb\ncc";
    rec(label, tf);
  }

  private static function alignCase(label:String, align:String, withLayout:Boolean):void {
    var tf:TextField = new TextField();
    tf.width = 200; tf.height = 60;
    tf.wordWrap = withLayout;
    var f:TextFormat = new TextFormat("_sans", 12, 0x000000);
    f.align = align;
    tf.defaultTextFormat = f;
    tf.text = "Wag il1";
    rec(label, tf);
  }

  private static function multiCase(label:String, text:String, wrap:Boolean, w:Number, h:Number):void {
    var tf:TextField = new TextField();
    tf.width = w; tf.height = h;
    tf.multiline = true; tf.wordWrap = wrap;
    tf.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
    tf.text = text;
    rec(label, tf);
  }

  private static function autoSizeCase(label:String, mode:String):void {
    var tf:TextField = new TextField();
    tf.autoSize = mode;
    tf.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
    tf.text = "AutoSize";
    rec(label, tf);
  }

  private static function passwordCase(label:String, text:String):void {
    var tf:TextField = mk(text, "_sans", 12, 200, 60);
    tf.displayAsPassword = true;
    rec(label, tf);
  }

  // 掩码设置顺序：before=true 时先设 displayAsPassword 再设 text。
  private static function passwordOrderCase(label:String, text:String, before:Boolean):void {
    var tf:TextField = new TextField();
    tf.width = 200; tf.height = 60;
    tf.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
    if (before) {
      tf.displayAsPassword = true;
      tf.text = text;
    } else {
      tf.text = text;
      tf.displayAsPassword = true;
    }
    rec(label, tf);
  }

  private static function maxCharsCase(label:String, text:String, mc:int):void {
    var tf:TextField = mk(text, "_sans", 12, 200, 40);
    tf.maxChars = mc;
    rec(label, tf);
  }

  private static function appendCase(label:String, first:String, more:String):void {
    var tf:TextField = mk(first, "_sans", 12, 240, 40);
    tf.appendText(more);
    rec(label, tf);
  }

  private static function htmlCase(label:String, html:String):void {
    var tf:TextField = new TextField();
    tf.width = 240; tf.height = 90;
    tf.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
    if (label == "html-condense") tf.condenseWhite = true;
    if (label == "html-span-size") {
      var ss:StyleSheet = new StyleSheet();
      ss.setStyle(".big", { fontSize: 24, color: "#ff0000" });
      tf.styleSheet = ss;
    }
    tf.htmlText = html;
    rec(label, tf);
  }

  private static function rangeCase(label:String):void {
    var tf:TextField = mk("Hello World", "_sans", 12, 300, 40);
    var f:TextFormat = new TextFormat("_sans", 12, 0x000000);
    f.bold = true;
    f.size = 20;
    tf.setTextFormat(f, 0, 5);
    rec(label, tf);
  }

  private static function decorCase(label:String):void {
    var tf:TextField = mk("Border", "_sans", 12, 120, 40);
    tf.border = true;
    tf.borderColor = 0x336699;
    tf.background = true;
    tf.backgroundColor = 0xeeeeee;
    rec(label, tf);
  }

  private static function inputCase(label:String, multiline:Boolean):void {
    var tf:TextField = mk("input text", "_sans", 12, 200, 60);
    tf.type = TextFieldType.INPUT;
    tf.multiline = multiline;
    rec(label, tf);
  }

  private static function scrollCase(label:String):void {
    var tf:TextField = new TextField();
    tf.width = 200; tf.height = 40;
    tf.multiline = true; tf.wordWrap = true;
    tf.defaultTextFormat = new TextFormat("_sans", 12, 0x000000);
    tf.text = "l1\nl2\nl3\nl4\nl5\nl6";
    tf.scrollV = 999;
    rec(label, tf);
  }

  // ---------------------------------------------------------------- recorder

  private static function rec(label:String, tf:TextField):void {
    var f:TextFormat = tf.defaultTextFormat;
    var fname:String = f.font == null ? "null" : f.font;
    var al:String = f.align == null ? "null" : f.align;
    cases++;
    note("case=" + label
      + " type=" + tf.type
      + " ml=" + b2i(tf.multiline)
      + " ww=" + b2i(tf.wordWrap)
      + " as=" + tf.autoSize
      + " align=" + al
      + " font=" + fname
      + " size=" + num(Number(f.size))
      + " bold=" + b2i(Boolean(f.bold))
      + " italic=" + b2i(Boolean(f.italic))
      + " pw=" + b2i(tf.displayAsPassword)
      + " tw=" + num(tf.textWidth)
      + " th=" + num(tf.textHeight)
      + " nl=" + int(tf.numLines)
      + " msv=" + int(tf.maxScrollV)
      + " fw=" + num(tf.width)
      + " fh=" + num(tf.height));

    var n:int = int(tf.numLines);
    var i:int = 0;
    while (i < n) {
      var m:TextLineMetrics = tf.getLineMetrics(i);
      note("line=" + label + " i=" + i
        + " asc=" + num(m.ascent)
        + " desc=" + num(m.descent)
        + " lead=" + num(m.leading)
        + " w=" + num(m.width)
        + " h=" + num(m.height)
        + " x=" + num(m.x));
      i++;
    }

    // 自洽不变量（两端都必须成立）。
    if (!(tf.textWidth >= 0)) fail(label + ": textWidth not >= 0");
    if (!(tf.textHeight >= 0)) fail(label + ": textHeight not >= 0");
    if (tf.text != null && tf.text.length == 0 && tf.textWidth != 0) {
      fail(label + ": empty text must have textWidth 0");
    }
    if (n < 1) fail(label + ": numLines must be >= 1");

    gridLabels.push(label);
    gridTfs.push(tf);
  }

  // ---------------------------------------------------------------- UI 网格
  //
  // 报告是**数值**尺子——它看得见宽度、行高、行数，看不见**颜色**（`textColor` /
  // `<font color>` / `borderColor` / `backgroundColor` 一个都没进报告）、看不见
  // 粗/斜/下划线的形状，也看不见字形本身（衬线 vs 无衬线、CJK 回退、emoji）。把同样
  // 这些用例铺成一张带标签的网格图，那些就只能用眼睛验收的东西才看得见。
  //
  // 口径：**两端跑同一段 AS3**，唯一差别是光栅器（AIR 自带 vs Skia）。所以不用开窗口、
  // 不用截图、不用管进程：`BitmapData.draw(this)` 光栅化到离屏位图，`getPixels` 取原始
  // 像素，连同 12 字节 ASCII 头写成 textfield-grid.raw（每像素 A,R,G,B 四字节），
  // 由 grid.py 转 PNG 并并排拼成 adl|AOT 对照图。
  //
  // 只铺一部分（UI_LABELS）：报告覆盖 70 例，全铺出来一张图看不完。挑的是每个维度
  // 最有诊断性的那几个。标签下那根细框就是**字段声明盒**——`autoSize` 把盒子改小没有
  // （N3）就靠这根框一眼看出。

  private static const UI_LABELS:String =
    "|empty|one-word"
    + "|font-null|font-sans|font-serif|font-typewriter|font-timesnewroman|font-unknown"
    + "|size08|size10|size12|size24"
    + "|bold|italic|underline|letterspacing2"
    + "|lead0|lead8"
    + "|align-left-ww|align-center-ww|align-right-ww|align-left-noww|align-center-noww"
    + "|trail-space3|embedded-tab|cjk|cjk-mixed|emoji"
    + "|ml-wrap-on|ml-wrap-wrap-cjk"
    + "|auto-left|auto-center"
    + "|pwd-ascii|pwd-cjk-only"
    + "|html-bold|html-font-color|html-entity-nbsp"
    + "|border-bg|input-single|range|scroll-clamp|maxchars3|";

  private static const GRID_MARGIN:int = 8;
  private static const GRID_COL_W:int = 300;
  private static const GRID_COL_GAP:int = 8;
  private static const GRID_COLS:int = 4;
  private static const GRID_LABEL_H:int = 12;
  private static const GRID_CELL_H:int = 8;
  // autoSize 用例的**声明盒**：AIR 新建字段的默认尺寸。autoSize 会把字段盒改小，
  // 而两端改多少并不一致（N3）——那是**要看的差异**，不是布局参数。若拿改动后的
  // height 做装箱，两端的列切分就会跑到不同的地方，图就对不齐了。所以格位高度一律
  // 取「声明盒」（autoSize 用例固定回 100×100）。
  private static const GRID_DEFAULT_BOX:Number = 100;
  private static const GRID_W:int = GRID_MARGIN * 2 + GRID_COLS * GRID_COL_W
                                    + (GRID_COLS - 1) * GRID_COL_GAP;

  private function buildGrid():void {
    // 1. 挑用例（保持报告里的顺序）。
    var labels:Array = [];
    var tfs:Array = [];
    var i:int = 0;
    while (i < gridLabels.length) {
      var lb:String = gridLabels[i] as String;
      if (UI_LABELS.indexOf("|" + lb + "|") >= 0) {
        labels.push(lb);
        tfs.push(gridTfs[i] as TextField);
      }
      i++;
    }
    var n:int = labels.length;

    // 2. 每格高度 = 标签行 + **声明盒** + 间隙。声明盒与两端都无关（见 GRID_DEFAULT_BOX）。
    var cellH:Array = [];
    var total:Number = 0;
    i = 0;
    while (i < n) {
      var cell:TextField = tfs[i] as TextField;
      var sh:Number = cell.height;
      if (cell.autoSize != "none") sh = GRID_DEFAULT_BOX;
      var h:Number = GRID_LABEL_H + sh + GRID_CELL_H;
      if (h < GRID_LABEL_H + GRID_CELL_H) h = GRID_LABEL_H + GRID_CELL_H;
      cellH.push(h);
      total += h;
      i++;
    }

    // 3. 顺序装箱：列满（累计高度够了均分额）就换列，列内保持报告顺序 ⇒
    //    整张图左→右、上→下就是报告的顺序。
    var per:Number = total / GRID_COLS;
    var asg:Array = [];
    var c:int = 0;
    var acc:Number = 0;
    i = 0;
    while (i < n) {
      if (c < GRID_COLS - 1 && acc >= per && acc > 0) { c++; acc = 0; }
      asg.push(c);
      acc += cellH[i] as Number;
      i++;
    }

    // 4. 落子：标签 + 声明盒细框 + 字段本体。
    var cur:Array = [GRID_MARGIN, GRID_MARGIN, GRID_MARGIN, GRID_MARGIN];
    i = 0;
    while (i < n) {
      var col:int = asg[i] as int;
      var x:Number = GRID_MARGIN + col * (GRID_COL_W + GRID_COL_GAP);
      var y:Number = cur[col] as Number;
      var tf:TextField = tfs[i] as TextField;

      var lab:TextField = new TextField();
      lab.width = GRID_COL_W;
      lab.height = GRID_LABEL_H;
      lab.selectable = false;
      lab.mouseEnabled = false;
      lab.defaultTextFormat = new TextFormat("_sans", 9, 0x555555);
      lab.text = labels[i] as String;
      lab.x = x;
      lab.y = y;

      var box:Shape = new Shape();
      // 粗细 1 而不是 0：AIR 的 lineStyle(0) 是 hairline（画得出来），我们把它当
      // 「无描边」（hasStroke = thickness > 0）——那是另一条待修的口径，不在这里混进来。
      box.graphics.lineStyle(1, 0xD8D8D8, 1);
      box.graphics.drawRect(x, y + GRID_LABEL_H, tf.width, tf.height);

      tf.x = x;
      tf.y = y + GRID_LABEL_H;
      addChild(box);
      addChild(lab);
      addChild(tf);
      cur[col] = y + (cellH[i] as Number);
      i++;
    }

    var gh:int = GRID_MARGIN;
    c = 0;
    while (c < GRID_COLS) {
      if ((cur[c] as Number) > gh) gh = int(cur[c] as Number);
      c++;
    }
    gh += GRID_MARGIN;

    // 5. 离屏光栅化 + 取原始像素 + 写文件。
    var bd:BitmapData = new BitmapData(GRID_W, gh, false, 0xFFFFFFFF);
    bd.draw(this);
    var ba:ByteArray = bd.getPixels(new Rectangle(0, 0, GRID_W, gh));
    var f:File = File.applicationStorageDirectory.resolvePath("textfield-grid.raw");
    var fs:FileStream = new FileStream();
    fs.open(f, FileMode.WRITE);
    fs.writeUTFBytes("TFGRID 1 " + GRID_W + " " + gh + "\n");
    fs.writeBytes(ba);
    fs.close();

    note("grid cells=" + n + " size=" + GRID_W + "x" + gh);
    writeReport(rep);
  }

  // ---------------------------------------------------------------- helpers

  private static function b2i(b:Boolean):int { return b ? 1 : 0; }

  // Fixed 2-decimal formatting without toFixed (the subset has none). Both ends
  // must produce byte-identical text, so NaN/Infinity get explicit spellings too.
  private static function num(v:Number):String {
    if (v != v) return "nan";
    if (v == 1.0 / 0.0) return "inf";
    if (v == -1.0 / 0.0) return "-inf";
    var neg:Boolean = v < 0;
    var a:Number = neg ? -v : v;
    var scaled:Number = Math.round(a * 100.0);
    var ip:int = int(scaled / 100.0);
    var fp:int = int(scaled - ip * 100.0);
    var s:String = String(ip) + ".";
    if (fp < 10) s += "0";
    s += String(fp);
    if (neg && (ip != 0 || fp != 0)) s = "-" + s;
    return s;
  }

  private static function fail(msg:String):void {
    bad++;
    note("FAIL " + msg);
  }

  private static function note(s:String):void {
    rep += s + "\n";
  }

  private static function writeReport(text:String):void {
    var f:File = File.applicationStorageDirectory.resolvePath("textfield-report.txt");
    var fs:FileStream = new FileStream();
    fs.open(f, FileMode.WRITE);
    fs.writeUTFBytes(text);
    fs.close();
  }
}
}
