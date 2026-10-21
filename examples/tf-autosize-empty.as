// tf-autosize-empty.as — 空 autoSize 字段不得报出负的 3.4e38 宽度（阶段二百三十七）。
//
// 背景：Skia `Paragraph::getLongestLine()` 对「一个文本 run 都没产生」的段落
// （空文本，见 `ParagraphImpl::layout` 里 `fLongestLine = FLT_MIN - FLT_MAX`）返回
// **-3.4028235e38**，而 `as_tf_apply_autosize` 里 `_fieldWidth = tw + 4` 直接把它写进了
// `TextField._fieldWidth`。后果不止是宽度荒唐：`as_bounds_walk` 的 TextField 分支拿
// `[0 .. _fieldWidth]` 当局部盒子，于是这个字段的包围盒是 **反的**（l=0、r=-3.4e38），
// 一旦被父容器并集吸收，父容器的 l 就变成 -3.4028235e38 —— 实测在真实 TalkMED 会议
// 客户端里，`cn.edoctor.view.meeting.videoplayer::VideoPlayer` 的 `getBounds` 是
// `[-3.4028235e38 .. 1490]`，一路传染到 `MediaLayoutView` / `MeetingView` / `Stage`：
//
//     berr-bb1.log: flash.text::TextField own=0,0 -3.40282e+38x15
//                   cn.edoctor.view.meeting::MeetingView l=-3.40282e+38 t=-78 r=1770 b=982
//
// 修复点只有一处：`as_tf_longest_line()` 把 Skia 的哨兵值夹到 0（AS3 从不报负的文本
// 尺寸），autoSize / 对齐 dx / textWidth / maxScrollH / 光标下划线五处统一读它。
//
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 本示例自动跳过，不假装验过；有 Skia 时
// 断言「空字段 textWidth=0 且尺寸有限」「有文字的字段照常测量」。
//
// 编译：
//   as-aot examples/tf-autosize-empty.as --manifest examples/tf-autosize-empty.build.json --run

import flash.text.TextField;
import flash.text.TextFieldAutoSize;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth <= 0) {
  trace('tf-autosize-empty: skipped (no text backend)');
} else {
  // ① 空文本 + autoSize：textWidth 必须是 0（AIR 实测口径），宽度/高度必须有限。
  var empty:TextField = new TextField();
  empty.autoSize = TextFieldAutoSize.LEFT;
  check(empty.textWidth == 0, 'empty textWidth=' + empty.textWidth);
  check(empty.textHeight == 0, 'empty textHeight=' + empty.textHeight);
  check(empty.width >= 0 && empty.width < 4096, 'empty width=' + empty.width);
  check(empty.height >= 0 && empty.height < 4096, 'empty height=' + empty.height);

  // ② 把它放进容器：getBounds 不能被反包围盒拖成天文数字。
  var holder:Sprite = new Sprite();
  holder.addChild(empty);
  var r:Rectangle = holder.getBounds(holder);
  check(r.width > -4096 && r.width < 4096 && r.height > -4096 && r.height < 4096,
        'holder bounds ' + r.width + 'x' + r.height);

  // ③ 夹取只针对哨兵：有文字的字段必须照常量出正宽度。
  var filled:TextField = new TextField();
  filled.autoSize = TextFieldAutoSize.LEFT;
  filled.defaultTextFormat = new TextFormat('Arial', 12);
  filled.text = 'Hello';
  check(filled.textWidth > 10 && filled.textWidth < 500, 'filled textWidth=' + filled.textWidth);
  check(filled.width > 10 && filled.width < 500, 'filled width=' + filled.width);

  trace('tf-autosize-empty: empty=' + empty.width + 'x' + empty.height
        + ' holder=' + r.width + 'x' + r.height
        + ' filled=' + filled.textWidth.toFixed(2) + '/' + filled.width.toFixed(2));
}
trace('tf-autosize-empty ok');