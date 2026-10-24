// settextformat-runs.as — TextField.setTextFormat() 对同一范围必须是**替换**而不是叠加（G20，阶段二百六十八）。
//
// 背景：AIR 文档（ActionScript 3.0 语言参考，TextField.setTextFormat）说的是「设置该范围内的格式」，
// 即**覆盖**该范围原有格式。我们过去每次都往 `TextField._runs` 里**追加**一条，而排版侧
// （`sk_textlayout_new_runs`）是拿着 run 表逐条 `addText(t+start, end-start)` 的 ⇒ 同一段字符被
// 排了 N 遍：一个「每帧重设一次格式」的字段，宽度随重绘次数线性增长。
// 用户看到的现象是「输入过的字被复制了一遍」（asaotui 的 `probes/widgets/typing` 变异 M3 抓到）。
//
// 判据来自 adl 51.4.1 双端同源探针（asaotui/probes/g20-settextformat，12 个**关系式**用例：
// 同一个进程里两个字段互比，不比绝对值 —— AIR 与我们的文本引擎不同，绝对宽度本来就不同）：
// 同一格式对 "1111" 施加 1/2/3 次，AIR 量到 52/52/52 px，修前的我们是 46.66/91.53/136.41。
//
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 只证明「不炸」并 trace 跳过，不假装验过。
//
// 编译：
//   as-aot examples/settextformat-runs.as --manifest examples/autosize-metrics.build.json --run

import flash.display.BitmapData;
import flash.text.TextField;
import flash.text.TextFieldAutoSize;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function mk(text:String):TextField {
  var f:TextField = new TextField();
  f.defaultTextFormat = new TextFormat('Arial', 20, 0x000000);
  f.autoSize = TextFieldAutoSize.LEFT;
  f.text = text;
  return f;
}

function fmt(size:Number, color:uint):TextFormat {
  return new TextFormat('Arial', size, color);
}

// 最右墨迹列 + 1（0 = 什么都没画）。重复排版在这里表现为墨迹越过一份字宽。
function ink(f:TextField):int {
  var bd:BitmapData = new BitmapData(400, 60, true, 0x00000000);
  bd.draw(f);
  var right:int = 0;
  for (var x:int = 0; x < 400; x++) {
    for (var y:int = 0; y < 60; y++) {
      if (((bd.getPixel32(x, y) >> 24) & 0xFF) > 0) { right = x + 1; break; }
    }
  }
  return right;
}

var probe:TextField = mk('x');
if (probe.textWidth <= 0) {
  trace('settextformat-runs: skipped (no text backend)');
} else {
  // ① 格式真的生效（否则下面所有等号都能被「一个 run 都没装上」蒙过去）
  var plain:TextField = mk('1111');
  var one:TextField = mk('1111');
  one.setTextFormat(fmt(24, 0xFF0000));
  var tw1:Number = one.textWidth;
  var ink1:int = ink(one);
  check(tw1 > plain.textWidth,
        '24px run 必须比 20px 默认字宽（plain=' + plain.textWidth + ', one=' + tw1 + '）');

  // ② 同一范围施加 1/2/3 次：宽度与墨迹都必须不变（AIR: 52/52/52）
  var twice:TextField = mk('1111');
  twice.setTextFormat(fmt(24, 0xFF0000));
  twice.setTextFormat(fmt(24, 0xFF0000));
  check(twice.textWidth == tw1,
        '施加两次 == 一次（once=' + tw1 + ', twice=' + twice.textWidth + '）');

  var thrice:TextField = mk('1111');
  thrice.setTextFormat(fmt(24, 0xFF0000));
  thrice.setTextFormat(fmt(24, 0xFF0000));
  thrice.setTextFormat(fmt(24, 0xFF0000));
  check(thrice.textWidth == tw1,
        '施加三次 == 一次（once=' + tw1 + ', thrice=' + thrice.textWidth + '）');
  check(ink(thrice) == ink1,
        '施加三次的墨迹 == 一次（once=' + ink1 + ', thrice=' + ink(thrice) + '）');
  check(thrice.text == '1111' && thrice.text.length == 4, 'setTextFormat 不改文本内容');

  // ③ 重绘路径（用户实际踩到的形状）：反复 draw 不得让字段自噬
  var repaint:TextField = mk('1111');
  var bd:BitmapData = new BitmapData(400, 60, true, 0x00000000);
  for (var i:int = 0; i < 5; i++) {
    repaint.setTextFormat(fmt(24, 0xFF0000));
    bd.draw(repaint);
  }
  check(repaint.textWidth == tw1,
        '重绘 5 次后宽度仍是 ' + tw1 + '，got ' + repaint.textWidth);

  // ④ 子范围同样不得叠加
  var sub1:TextField = mk('1111');
  sub1.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  var sub3:TextField = mk('1111');
  sub3.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  sub3.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  sub3.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  check(sub3.textWidth == sub1.textWidth,
        '子范围施加三次 == 一次（' + sub1.textWidth + ' vs ' + sub3.textWidth + '）');

  // ⑤ 全范围格式覆盖掉先前装的子范围格式
  var over:TextField = mk('1111');
  over.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  over.setTextFormat(fmt(20, 0x0000FF));
  var freshFull:TextField = mk('1111');
  freshFull.setTextFormat(fmt(20, 0x0000FF));
  check(over.textWidth == freshFull.textWidth,
        '全范围覆盖 == 干净字段（' + freshFull.textWidth + ' vs ' + over.textWidth + '）');

  // ⑥ 两个不相交范围与施加顺序无关
  var ab:TextField = mk('1111');
  ab.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  ab.setTextFormat(fmt(24, 0x00FF00), 2, 4);
  var ba:TextField = mk('1111');
  ba.setTextFormat(fmt(24, 0x00FF00), 2, 4);
  ba.setTextFormat(fmt(24, 0xFF0000), 0, 2);
  check(ab.textWidth == ba.textWidth, '不相交范围与顺序无关（' + ab.textWidth + ' vs ' + ba.textWidth + '）');

  // ⑦ 更窄的范围落在一条 run 内部时，必须把那一条**切开**并保住两侧
  //    （尾部：run 表必须按 start 有序，否则排版循环的 pos 游标会回头重排）
  var tail:TextField = mk('1111');
  tail.setTextFormat(fmt(24, 0xFF0000));
  tail.setTextFormat(fmt(12, 0x0000FF), 0, 2);
  var tailRef:TextField = mk('1111');
  tailRef.setTextFormat(fmt(12, 0x0000FF), 0, 2);
  tailRef.setTextFormat(fmt(24, 0xFF0000), 2, 4);
  check(tail.textWidth == tailRef.textWidth,
        '窄范围切尾 == 两段独立格式（' + tailRef.textWidth + ' vs ' + tail.textWidth + '）');

  var mid:TextField = mk('1111');
  mid.setTextFormat(fmt(24, 0xFF0000));
  mid.setTextFormat(fmt(12, 0x0000FF), 1, 3);
  var midRef:TextField = mk('1111');
  midRef.setTextFormat(fmt(24, 0xFF0000), 0, 1);
  midRef.setTextFormat(fmt(12, 0x0000FF), 1, 3);
  midRef.setTextFormat(fmt(24, 0xFF0000), 3, 4);
  check(mid.textWidth == midRef.textWidth,
        '窄范围切中间 == 三段独立格式（' + midRef.textWidth + ' vs ' + mid.textWidth + '）');

  // ⑧ 重赋 .text 仍是「整段替换」，会清掉 run（这条不是本次修复，防回归）
  var retext:TextField = mk('1111');
  retext.setTextFormat(fmt(24, 0xFF0000));
  retext.text = '1111';
  check(retext.textWidth == plain.textWidth,
        '重赋 .text 后回到默认格式（plain=' + plain.textWidth + ', got ' + retext.textWidth + '）');

  trace('settextformat-runs: setTextFormat 对同一范围是替换而非叠加（宽度/墨迹不随重绘增长、'
        + '窄范围切开长 run）— assertions passed');
}