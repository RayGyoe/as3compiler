// tf-metrics-cache.as — TextField 派生度量缓存的失效回归（阶段四百三十八）。
//
// 背景：`textWidth` / `textHeight` / `maxScrollH` 过去每次读都重算
// （`benchmarks/textmetrics` 对 200 行字段量到 31.6 µs / 727 µs / 31.6 µs，AIR 是
// 0.1 / ≈0 / 4.4），而这三个入口每帧都在绘制路径上（`as_render_object` 的 TextField
// 分支无条件调 `maxScrollH`）。现在它们随段落一起缓存，只在段落**重建**时刷新。
//
// 缓存最容易出的错不是算错，而是**算旧了**：某条改动路径让段落重建、或干脆没让段落
// 重建，而 `_m_*` 还留着上一段文字的值。本示例就钉这条不变量：
//
//   对任何一次改动，「改动的字段」的四个度量必须与「按最终状态新建的孪生字段」**逐项相等**。
//
// 这个判据与后端无关（孪生字段走同一条代码路径），也不依赖具体字体数值，所以它对
// 「缓存漏失效」「缓存刷新时机不对」都成立；纯 C 构建没有文本后端（`textWidth` 恒 0）
// 时两条都恒 0、相等无意义，故直接 skip。
//
// 编译：
//   as-aot examples/tf-metrics-cache.as --manifest examples/autosize-metrics.build.json --run

import flash.text.TextField;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function mkTf(txt:String, w:Number, wrap:Boolean, size:Number):TextField {
  var tf:TextField = new TextField();
  var fmt:TextFormat = new TextFormat();
  fmt.font = "Arial";
  fmt.size = size;
  fmt.color = 0x000000;
  tf.defaultTextFormat = fmt;
  tf.width = w;
  tf.height = 300;
  tf.multiline = true;
  tf.wordWrap = wrap;
  tf.text = txt;
  return tf;
}

function near(a:Number, b:Number):Boolean { return Math.abs(a - b) < 0.01; }

function snap(tf:TextField):String {
  return 'tw=' + tf.textWidth.toFixed(2) + ' th=' + tf.textHeight.toFixed(2)
    + ' msh=' + tf.maxScrollH + ' nl=' + tf.numLines;
}

function sameAs(label:String, got:TextField, want:TextField):void {
  var g:String = snap(got), w:String = snap(want);
  check(near(got.textWidth, want.textWidth), label + ': textWidth 未跟上改动 (' + g + ' vs ' + w + ')');
  check(near(got.textHeight, want.textHeight), label + ': textHeight 未跟上改动 (' + g + ' vs ' + w + ')');
  check(got.maxScrollH == want.maxScrollH, label + ': maxScrollH 未跟上改动 (' + g + ' vs ' + w + ')');
  check(got.numLines == want.numLines, label + ': numLines 未跟上改动 (' + g + ' vs ' + w + ')');
}

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth <= 0) {
  trace('tf-metrics-cache: skipped (no text backend)');
} else {
  var L1:String = 'the quick brown fox jumps over the lazy dog';
  var L2:String = '0123456789 0123456789 0123456789 0123456789';
  var L3:String = 'short';

  // ① 基准：三行、不换行、宽 200 —— maxScrollH 为正（这一档才有横向溢出量）。
  var f:TextField = mkTf(L1 + '\n' + L2 + '\n' + L3, 200, false, 12);
  check(f.numLines == 3, '三行文本必须报 numLines=3，got ' + f.numLines);
  check(f.maxScrollH > 0, '宽 200 的三行长文本必须有横向溢出，got msh=' + f.maxScrollH);
  sameAs('① 初始', f, mkTf(L1 + '\n' + L2 + '\n' + L3, 200, false, 12));

  // ② 读一次之后改文本（新串 ⇒ 段落重建 ⇒ 缓存必须跟着刷新）。
  var t0:Number = f.textWidth;
  f.text = L3;
  sameAs('② 文本变短', f, mkTf(L3, 200, false, 12));
  check(f.textWidth < t0, '文本变短后 textWidth 必须减小，' + f.textWidth + ' vs ' + t0);
  check(f.maxScrollH == 0, '单行短文本在宽 200 下不再溢出，got msh=' + f.maxScrollH);

  // ③ appendText：文字变长，行数增加（这条路径在编辑后显式丢段落）。
  f.appendText('\n' + L2 + '\n' + L2);
  sameAs('③ appendText', f, mkTf(L3 + '\n' + L2 + '\n' + L2, 200, false, 12));

  // ④ 原地改 defaultTextFormat 的属性。**不能**拿孪生字段比：adl 51.4.1 实测
  //    （temp/dtfprobe/Main.as）原地改 `defaultTextFormat.size` 对**已经排好**的文本
  //    没有任何影响（tw 276.5 不动），而且 `defaultTextFormat` 的 getter 返回的是
  //    **副本**（`a.defaultTextFormat === a.defaultTextFormat` 为 false），所以连
  //    「读出来改完再赋回去」也不动已排好的文本；只有重新赋 `.text` 才用上新格式
  //    （tw 276.5 → 461.5）。我们的口径必须一致，否则用户改格式会看到文本当场跳变。
  var twBefore:Number = f.textWidth;
  var thBefore:Number = f.textHeight;
  f.defaultTextFormat.size = 20;
  check(near(f.textWidth, twBefore) && near(f.textHeight, thBefore),
        '④a 原地改 defaultTextFormat 不得影响已排文本 (tw ' + f.textWidth + ' vs ' + twBefore + ')');
  //    getter 返回副本，所以真要让新格式生效得「读出来改完再赋回去」——adl 51.4.1 实测
  //    赋回去这一步本身也**不动**已排好的文本（仍 276.5），只有重新赋 `.text` 才用上。
  var d:TextFormat = f.defaultTextFormat;
  d.size = 20;
  f.defaultTextFormat = d;
  check(near(f.textWidth, twBefore),
        '④b 重新赋 defaultTextFormat 也不得重排已排文本 (tw ' + f.textWidth + ' vs ' + twBefore + ')');
  // ...重新赋 .text 之后才生效（此时才该与「用新尺寸新建的孪生字段」相等）。
  var kept:String = L3 + '\n' + L2 + '\n' + L2;
  f.text = kept;
  sameAs('④c retext 后用上新尺寸', f, mkTf(kept, 200, false, 20));
  check(f.textWidth > twBefore, '④c retext 后 textWidth 必须随 20px 变大，' + f.textWidth + ' vs ' + twBefore);

  // ⑤ 宽度变化（wordWrap=true 时宽度是排版输入，段落重建）。
  var w1:TextField = mkTf(L2, 400, true, 12);
  w1.width = 100;
  check(w1.numLines > 1, '宽 100 + wordWrap 必须断行，got nl=' + w1.numLines);
  sameAs('⑤ 宽度变窄', w1, mkTf(L2, 100, true, 12));

  // ⑥ 掩码切换：布局串从明文变成星号串（不同指针 + 不同宽度）。
  var p:TextField = mkTf('abcdefghij', 200, false, 12);
  p.displayAsPassword = true;
  var pw:TextField = mkTf('abcdefghij', 200, false, 12);
  pw.displayAsPassword = true;
  sameAs('⑥ displayAsPassword', p, pw);

  // ⑦ 清空：空字段 textWidth/textHeight 都是 0、numLines 是 1（AIR 口径）。
  f.text = '';
  check(f.textWidth == 0 && f.textHeight == 0, '空字段度量必须归零，got ' + snap(f));
  check(f.numLines == 1, '空字段仍报 1 行，got nl=' + f.numLines);

  // ⑧ 再从空回到有内容（清空路径把缓存也清了，最容易在这里读到 0）。
  // 注意尺寸：④ 已经把 defaultTextFormat 改成 20，重新赋文本用的是 20。
  f.text = L3;
  sameAs('⑧ 清空后重新赋值', f, mkTf(L3, 200, false, 20));

  // ⑨ 反复读不得改变任何东西（缓存是读，不是算）：读 100 次再与孪生比。
  for (var i:int = 0; i < 100; i++) { f.textWidth; f.textHeight; f.maxScrollH; f.numLines; }
  sameAs('⑨ 反复读之后', f, mkTf(L3, 200, false, 20));

  trace('tf-metrics-cache: 度量缓存随段落重建刷新、读不改值 — assertions passed'
        + ' (' + snap(f) + ')');
}