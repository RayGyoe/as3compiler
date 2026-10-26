// tf-scale-metrics.as — TextField 被缩放时的度量与字形口径回归（阶段一百六十九）。
//
// 背景：TalkMED 的 AI 同传列表项把皮肤子件 `ctime` 的 `textHeight` 直接算进卡片高度
// （`bg.height = ctime.textHeight + ctime.y + title.y`），而 `ctime` 的 SWC placement
// 带 **scaleX = 1.2246**（scaleY = 1）。adl 51.4.1 报 `textHeight = 11.45`（= 12/1.2246），
// 我们当时报 14.00 ⇒ 卡片比 adl 高 2.5pt；同时我们的字形被 placement 的 scaleX **横向拉宽
// 22%**（adl 的字形宽度不受 scaleX 影响），两者肉眼可见。
//
// 判据来自 adl 51.4.1 双端同源探针（`temp/tfswc` case ⑯⑯b⑯c，同一份 Main.as 跑 adl 与 AOT，
// 数值读回 + 窗口截图量 ink 宽）。size 12 时名义值 textWidth 166.00 / textHeight 12.00：
//
//   (scaleX,scaleY) | adl textWidth | adl textHeight | adl 渲染 ink 宽
//   (1.0000,1.0000) |        166.00 |          12.00 |  165.0pt
//   (2.0000,1.0000) |         83.00 |           6.00 |  165.0pt
//   (1.0000,2.0000) |        332.00 |          24.00 |  329.5pt
//   (2.0000,2.0000) |        166.00 |          12.00 |  329.5pt
//   (0.5000,1.0000) |        332.00 |          24.00 |  165.0pt
//   (1.0000,0.5000) |         83.00 |           6.00 |   82.5pt
//   父容器 scaleX=2  |         83.00 |           6.00 |      —
//
// 归纳为两条口径：
//   ① `textWidth`/`textHeight` = **名义值 × scaleY / scaleX**，两个方向**同除 scaleX**
//      （不是各除自己那个轴的 scale），而且 scale 取的是**自己 + 全部祖先**的累积值；
//   ② 渲染出来的字形大小 = **名义值 × scaleY**，scaleX **不横向拉宽字形**（缩放后的
//      字段盒子仍然按 scaleX 变宽，`width` = 本地宽 × scaleX）。
//
// 本示例只跑我们自己的构建（examples 套件不跑 adl），故断言写成**相对关系**而不是
// 硬编码 adl 的数字，这样换字体也不会假红——绝对数值口径由 `temp/tfswc` 的双端探针钉。
// 纯 C 构建没有文本后端（`textWidth` 恒 0）⇒ 只证明「不炸」并 trace 跳过。
//
// 编译：
//   as-aot examples/tf-scale-metrics.as --manifest examples/tf-scale-metrics.build.json --run

import flash.display.BitmapData;
import flash.display.Sprite;
import flash.display.Stage;
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.text.TextFormat;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function fmt(v:Number):String { return v.toFixed(2); }

function near(actual:Number, want:Number, tol:Number, msg:String):void {
  if (!(Math.abs(actual - want) <= tol)) {
    throw new Error("FAIL: " + msg + " (want " + fmt(want) + " got " + fmt(actual) + ")");
  }
}

var TEXT:String = '开始时间: 2023-02-10 17:50:00';

function field(sx:Number, sy:Number):TextField {
  var fmt12:TextFormat = new TextFormat();
  fmt12.font = '_sans';
  fmt12.size = 12;
  fmt12.color = 0x111111;
  var f:TextField = new TextField();
  f.defaultTextFormat = fmt12;
  f.wordWrap = false;
  f.multiline = false;
  f.width = 400;
  f.height = 20;
  f.text = TEXT;
  f.scaleX = sx;
  f.scaleY = sy;
  return f;
}

// BitmapData 里「非透明像素」的着色包围盒宽度——用来量字形 ink 宽（口径 ②）。
function inkWidth(bd:BitmapData, w:int, h:int):Number {
  var minx:int = -1, maxx:int = -1;
  for (var x:int = 0; x < w; x++) {
    var hit:Boolean = false;
    for (var y:int = 0; y < h; y++) {
      if ((bd.getPixel32(x, y) >>> 24) > 40) { hit = true; break; }
    }
    if (hit) { if (minx < 0) minx = x; maxx = x; }
  }
  return (minx < 0) ? 0 : (maxx - minx + 1);
}

// 把字段放进「容器 → 中间 Sprite（带缩放）→ 字段」再 draw。缩放必须挂在**中间 Sprite** 上：
// AIR 的 `draw()` **忽略被画对象自身的 transform**（实测 temp/bakeprobe：一个 scaleX/scaleY=2 的
// 容器画出来是 1x），但子件的 transform 照常生效，所以只有经中间 Sprite 才能量到「缩放该不该
// 影响字形」。判据同 adl：链 (2,1) 的 ink 宽与 (1,1) **相同**，(1,2) 的 ink 宽**翻倍**。
function inkOfChain(sx:Number, sy:Number):Number {
  var cont:Sprite = new Sprite();
  var mid:Sprite = new Sprite();
  mid.scaleX = sx;
  mid.scaleY = sy;
  mid.addChild(field(1, 1));
  cont.addChild(mid);
  var bd:BitmapData = new BitmapData(1200, 120, true, 0x00FFFFFF);
  bd.draw(cont);
  return inkWidth(bd, 1200, 120);
}

// 同一判据必须也在 cacheAsBitmap 烘焙路径下成立（阶段二百九十一），而且**缩放要挂在字段
// 自己身上**：bake 发布的是「容器」的落点 CTM，里面**不含**字段自身的 scaleX（TalkMED 登录页
// 两个页签正是 SWC placement 给文本子件 scaleX 0.9594、父皮肤被烘焙）。曾经的归一化除数取
// 那个落点 CTM ⇒ 比值恒 1 ⇒ 字形被自己的 scaleX 拉宽/压窄，live 与 bake 差 4%，每次焦点切换
// 祖先 bake 掉一帧，肉眼就是「页签文字抖一下再回来」。
function inkOfBakedField(sx:Number, sy:Number):Number {
  var cont:Sprite = new Sprite();
  var mid:Sprite = new Sprite();
  mid.cacheAsBitmap = true;
  mid.addChild(field(sx, sy));
  cont.addChild(mid);
  var bd:BitmapData = new BitmapData(1200, 120, true, 0x00FFFFFF);
  bd.draw(cont);
  return inkWidth(bd, 1200, 120);
}

var probe:TextField = new TextField();
probe.text = 'x';
if (probe.textWidth <= 0) {
  trace('tf-scale-metrics: skipped (no text backend)');
} else {
  var base:TextField = field(1, 1);
  var tw0:Number = base.textWidth;
  var th0:Number = base.textHeight;
  check(tw0 > 0 && th0 > 0, '基准字段必须有正的 textWidth/textHeight');

  // ① 度量：textWidth/textHeight = 名义 × scaleY / scaleX（两个方向同除 scaleX）
  var wide:TextField = field(2, 1);
  near(wide.textWidth, tw0 / 2, 0.05, 'scaleX=2 时 textWidth 减半');
  near(wide.textHeight, th0 / 2, 0.05, 'scaleX=2 时 textHeight 也减半（同除 scaleX）');
  near(wide.width, 400 * 2, 0.01, 'scaleX=2 时字段盒子宽 = 本地宽 × 2');

  var tall:TextField = field(1, 2);
  near(tall.textWidth, tw0 * 2, 0.05, 'scaleY=2 时 textWidth 翻倍');
  near(tall.textHeight, th0 * 2, 0.05, 'scaleY=2 时 textHeight 翻倍');
  near(tall.height, 20 * 2, 0.01, 'scaleY=2 时字段盒子高 = 本地高 × 2');

  var both:TextField = field(2, 2);
  near(both.textWidth, tw0, 0.05, 'scaleX=scaleY=2 时 textWidth 回到名义值');
  near(both.textHeight, th0, 0.05, 'scaleX=scaleY=2 时 textHeight 回到名义值');

  var narrow:TextField = field(0.5, 1);
  near(narrow.textWidth, tw0 * 2, 0.05, 'scaleX=0.5 时 textWidth 翻倍');
  near(narrow.textHeight, th0 * 2, 0.05, 'scaleX=0.5 时 textHeight 翻倍');

  var squat:TextField = field(1, 0.5);
  near(squat.textWidth, tw0 / 2, 0.05, 'scaleY=0.5 时 textWidth 减半');
  near(squat.textHeight, th0 / 2, 0.05, 'scaleY=0.5 时 textHeight 减半');

  // 祖先的 scale 一样算进累积值（adl 实测：父容器 scaleX=2 时子字段 textWidth 减半）
  var holder:Sprite = new Sprite();
  holder.scaleX = 2;
  var inner:TextField = field(1, 1);
  holder.addChild(inner);
  near(inner.textWidth, tw0 / 2, 0.05, '父容器 scaleX=2 时子字段 textWidth 减半');
  near(inner.textHeight, th0 / 2, 0.05, '父容器 scaleX=2 时子字段 textHeight 减半');

  // ② 渲染：字形大小 = 名义 × scaleY，scaleX 不拉宽字形。
  //    （`draw(字段)` 与 `draw(容器)` 都**不应用被画对象自身的 transform**——adl 实测
  //    scaleY=2 的字段 draw 出来与未缩放的**逐字节相同**——所以缩放只能挂在中间 Sprite 上。）
  var w11:Number = inkOfChain(1, 1);
  var w21:Number = inkOfChain(2, 1);
  var w12:Number = inkOfChain(1, 2);
  var w051:Number = inkOfChain(0.5, 1);
  check(w11 > 0, 'ink 宽必须量得到（文本后端没画字）');
  near(w21, w11, 2, 'scaleX=2 不得把字形横向拉宽（ink 宽应与 scale 1 相同）');
  near(w051, w11, 2, 'scaleX=0.5 不得把字形压窄（ink 宽应与 scale 1 相同）');
  near(w12, w11 * 2, 3, 'scaleY=2 时字形整体放大一倍（ink 宽翻倍）');

  // ②b 烘焙路径与 live 必须同口径：父容器 cacheAsBitmap、字段自带 scaleX。
  var wb11:Number = inkOfBakedField(1, 1);
  var wb21:Number = inkOfBakedField(2, 1);
  var wb051:Number = inkOfBakedField(0.5, 1);
  var wb12:Number = inkOfBakedField(1, 2);
  check(wb11 > 0, '烘焙路径的 ink 宽也必须量得到');
  near(wb11, w11, 2, 'cacheAsBitmap 不得改变 scale 1 的字形（烘焙与 live 同口径）');
  near(wb21, w11, 2, '烘焙下字段自身 scaleX=2 也不得拉宽字形（曾用 bake 落点 CTM 归一，宽了一倍）');
  near(wb051, w11, 2, '烘焙下字段自身 scaleX=0.5 也不得压窄字形');
  near(wb12, w11 * 2, 3, '烘焙下字段自身 scaleY=2 仍要整体放大一倍');

  // ③ 打字时字段自动滚动（阶段二百四十二）。adl 51.4.1 实测：wordWrap=false 的
  //    字段一旦溢出就有正的 maxScrollH（trunc(textWidth + 4 - width)），打字把字符推到
  //    右边界外时按「内宽四分之一」的步长平移 scrollH；中文/英文都一样。AIR **没有**
  //    `hscroll` 开关（赋它会抛 #1056），所以这条对任何 AIR 程序都成立。
  //    纵向：打字越过可见行后 scrollV 跟着往下走（光标的行贴到底部）。
  var st:Stage = new Stage();
  var typed:TextField = new TextField();
  typed.width = 200; typed.height = 24;
  typed.background = true; typed.border = true;
  typed.defaultTextFormat = new TextFormat('_typewriter', 12, 0x000000);
  typed.type = TextFieldType.INPUT;
  typed.multiline = false; typed.wordWrap = false;
  st.addChild(typed);
  check(typed.maxScrollH == 0, '空字段的 maxScrollH 必须是 0');

  st.focus = typed;
  var i:int;
  for (i = 0; i < 40; i++) st.dispatchText('0');
  check(typed.text.length == 40, '40 个字符要全部进到 .text 里');
  check(typed.maxScrollH > 0, '溢出的单行字段必须报正的 maxScrollH（我们曾错误地跟着 hscroll 报 0）');
  check(typed.scrollH > 0, '打字推到右边界外必须自动左移（scrollH > 0）');
  check(typed.scrollH <= typed.maxScrollH, 'scrollH 不得越过 maxScrollH');
  // 渐进：第一次平移发生在 textWidth 超过内宽之后，之后随字符增加继续增大。
  var seen:Array = [];
  var prev:int = typed.scrollH;
  for (i = 0; i < 20; i++) {
    st.dispatchText('0');
    check(typed.scrollH >= prev, 'scrollH 只增不减（逐字符打字）');
    if (typed.scrollH != prev) seen.push(typed.scrollH);
    prev = typed.scrollH;
  }
  check(seen.length > 0, '继续打字必须继续平移（不只第一次）');
  // scrollH 仍然是可写且被夹在 [0, maxScrollH] 的公有状态。
  typed.scrollH = 100000;
  check(typed.scrollH == typed.maxScrollH, 'scrollH 赋值必须夹到 maxScrollH');
  typed.scrollH = 0;
  check(typed.scrollH == 0, 'scrollH 可以回到 0');

  // 换行字段不横向平移，但纵向跟着光标走。
  var wrapped:TextField = new TextField();
  wrapped.width = 120; wrapped.height = 40;
  wrapped.defaultTextFormat = new TextFormat('_typewriter', 12, 0x000000);
  wrapped.type = TextFieldType.INPUT;
  wrapped.multiline = true; wrapped.wordWrap = true;
  st.addChild(wrapped);
  st.focus = wrapped;
  for (i = 0; i < 80; i++) st.dispatchText('0');
  check(wrapped.maxScrollH == 0, 'wordWrap=true 的字段不得横向平移（maxScrollH 恒 0）');
  check(wrapped.scrollH == 0, 'wordWrap=true 的字段 scrollH 恒 0');
  check(wrapped.numLines > 2, '80 个字符在 120px 宽里必须折成多行');
  check(wrapped.scrollV > 1, '打字越过可见行后 scrollV 必须跟着走（我们曾一直停在 1）');

  trace('tf-scale-metrics: textWidth/textHeight = 名义 × scaleY/scaleX（含祖先）、'
        + '字形按 scaleY 整体缩放而 scaleX 不拉宽、打字自动横向/纵向滚动 — assertions passed');
}
