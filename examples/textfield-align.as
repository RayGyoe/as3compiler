// textfield-align.as — TextField 水平对齐（TextFormat.align）回归。
//
// 背景：TextField 的文字用 SkParagraph 排版。SkParagraph 只能在「有排版宽度」时
// 做对齐，而 wordWrap=false 的字段排版宽度为 0（glue 会替换成 1e9），此时若仍把
// center/right 交给 SkParagraph，文字会被推到极右。原实现因此把 align 硬编码为 0
// （左对齐）——结果是 AIR 会居中、我们不居中。
//
// 这一点是硬性的：Starling 的 TrueTypeCompositor 正是靠原生 TextField 的居中来
// 摆字——它把字段画进一张按 textWidth 定尺的 BitmapData，再按
// (width - textWidth) / 2 - padding 平移取窗口。原生字段不居中，取窗口就会切掉
// 左半边文字（air-starling-demo 的按钮标签曾只剩尾巴）。
//
// 修复（阶段八十九·十七）：align 分流——有排版宽度时交给 SkParagraph；没有时由
// as_tf_align_dx 在绘制原点做整块平移，位移量按 AIR 的 2px 文字内边距计算：
// center → (width - 4 - textWidth) / 2，right → width - 4 - textWidth。
//
// 判据用「红字 + 透明底」：draw() 后 getPixel 只会返回 0（透明）或 0xFF0000（墨迹），
// 于是第一列墨迹的 x 就是文字的起始位置。纯 C 构建没有 raster 后端（as_skia_* 全是
// no-op），draw() 不产生像素，此时跳过断言。
//
// 编译（Skia 模式）：as-aot examples/textfield-align.as --manifest examples/bitmapdraw-channel.build.json

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 第一列有墨迹的 x，没有墨迹返回 -1。
function firstInkX(bd:BitmapData, w:int, h:int):int {
  for (var x:int = 0; x < w; x++) {
    for (var y:int = 0; y < h; y++) {
      if (bd.getPixel(x, y) != 0) return x;
    }
  }
  return -1;
}

// 画一张红字透明底的图，返回第一列墨迹的 x。
function inkX(align:String):int {
  var tf:TextField = new TextField();
  tf.width = 256;
  tf.height = 84;
  tf.background = false;
  tf.wordWrap = false;          // 无排版宽度 → 走 as_tf_align_dx 的整块平移
  tf.textColor = 0xFF0000;      // 红字，便于 getPixel 判定墨迹
  var fmt:TextFormat = new TextFormat("Verdana", 24, 0xFF0000);
  fmt.align = align;
  tf.defaultTextFormat = fmt;
  tf.text = "Multitouch";

  var bd:BitmapData = new BitmapData(256, 84, true, 0x00000000);
  bd.draw(tf);
  return firstInkX(bd, 256, 84);
}

var leftX:int = inkX("left");
trace("textfield-align: left inkX=" + leftX);

if (leftX < 0) {
  // 无 raster 后端（纯 C 构建）：draw() 是 no-op，无从判定对齐。
  trace("textfield-align: skipped (no raster backend)");
} else {
  var centerX:int = inkX("center");
  var rightX:int = inkX("right");
  trace("textfield-align: center inkX=" + centerX + " right inkX=" + rightX);

  // 左对齐：文字从 AIR 的 2px 内边距处开始。
  check(leftX <= 4, "left-aligned text must start at the 2px inset (got " + leftX + ")");
  // 居中对齐：整块平移，必须明显右移，且落在 (width - textWidth) / 2 附近。
  // textWidth 用同一格式量一次；墨迹起点与文字原点相差一个字形左边距（约 1px）。
  var tf:TextField = new TextField();
  tf.width = 256; tf.height = 84; tf.wordWrap = false; tf.textColor = 0xFF0000;
  var fmt:TextFormat = new TextFormat("Verdana", 24, 0xFF0000);
  fmt.align = "center";
  tf.defaultTextFormat = fmt;
  tf.text = "Multitouch";
  var textWidth:int = int(tf.textWidth);
  var expectedCenter:int = int((256 - textWidth) / 2);
  var expectedRight:int = 256 - 2 - textWidth;

  check(centerX > leftX + 30, "centered text must move right accordingly (left=" + leftX + " center=" + centerX + ")");
  check(centerX >= expectedCenter - 4 && centerX <= expectedCenter + 4,
        "centered text expected around " + expectedCenter + " (got " + centerX + ", textWidth=" + textWidth + ")");
  check(rightX > centerX + 30, "right-aligned text must move right accordingly (center=" + centerX + " right=" + rightX + ")");
  check(rightX >= expectedRight - 4 && rightX <= expectedRight + 4,
        "right-aligned text expected around " + expectedRight + " (got " + rightX + ", textWidth=" + textWidth + ")");
  trace("textfield-align: ok");
}