// swc-mc-button.as — 阶段一百七十一：MovieClip 的三种按钮态（buttonMode + `_up`/`_over`/`_down`）。
//
// AIR 对「带 Flash 按钮标签的 MovieClip」有一个内建状态机：`buttonMode == true` 且时间轴上有
// `_up` / `_over` / `_down` 三个 FrameLabel 时，指针滚入/按下/滚出会把播放头**真的**移到对应
// 标签所在帧（`currentFrame`/`currentLabel` 都跟着变，该帧的帧脚本也会跑）。TalkMED 皮肤里
// 有 29 个这样的符号（首页两张卡片、登录按钮、九宫格图标按钮……），所以缺了这个状态机，全 App
// 的 hover/按下反馈都是死的（D42/R29）。
//
// 实测口径（adl 51.4.1，temp/btnprobe：Probe.as + p4~p7 截图；Aot.as 是本仓库侧的双端对照）：
//   · 门是 **buttonMode**，不是标签本身：同一个类把 buttonMode 置 false 后永远停在第 1 帧；
//     另一个「有标签但没脚本」（buttonMode 默认 false）的符号 `BtnRootResources_99复制_64`
//     悬停/按下也永远停在第 1 帧。
//   · 帧由**标签**决定，不是帧号：元件17_55 的 _over/_down 在 4/7 帧，
//     BtnRootResources_99复制_64 在 5/10 帧，各自落到自己标签那一帧。
//   · 移开 → `_up`；滚入 → `_over`；按下 → `_down`。
//   · 按压**锁在按下的对象上**：在别处按下再拖进来只有 `_over`；在这里按下再拖出去仍保持 `_down`。
//   · 松开：指针在内回到 `_over`，在外回到 `_up`。
//   · 离屏（没有任何鼠标事件，BitmapData.draw 之前）保持 `_up`。
//
// 阶段一百七十二（D43）在本示例末尾补了第 ⑪ 档：回退到 `_up` 时**未变子件必须复用**。
// 这条规则不是装饰：TalkMED 首页的卡片标题是 App 运行时写进皮肤 TextField 的，重建第 1 帧
// 会把它们变回皮肤原稿（悬停一次「快速入会」就变回「加入会议」）。adl 的实测口径是
// 「目标帧同一 (深度, 角色) → 复用原对象（含 App 写的文字/属性），否则换新对象」。
//
// 本示例还钉住一件与自动烘焙有关的事：状态在**指纹 pass**（`as_render_fp`）里结算，而不只在
// 绘制 pass（`as_render_object`）里。原因是祖先一旦被自动烘焙，绘制 pass 根本不会遍历到子件
// （它直接贴缓存图），只在绘制 pass 结算就会「帧变了、像素没变」——这正是首页卡片最初的表现
// （悬停只改了调试浮层的 306 像素，而 adl 改的是卡片上 15524 像素）。所以下面每一档状态都
// 先 `stage.render` 足够多帧（自动烘焙阈值是 3 帧）再断言，并且额外用像素差断言「真的变了」。
//
// 依赖样本皮肤 examples/embed-assets/skin.swc（与 swc-shape.as / swc-bitmap.as 同一份），缺席时该单元会被跳过：
//   as-aot examples/swc-mc-button.as --manifest examples/swc-bitmap.build.json --run

import flash.display.BitmapData;
import flash.display.DisplayObject;
import flash.display.DisplayObjectContainer;
import flash.display.InteractiveObject;
import flash.display.MovieClip;
import flash.display.Stage;
import flash.geom.Point;
import flash.text.TextField;
import flash.utils.getDefinitionByName;

var fails:int = 0;
function check(cond:Boolean, msg:String):void {
  if (!cond) { fails++; trace("FAIL: " + msg); }
}

var stage:Stage = new Stage();
// 自动烘焙阈值是 3 帧连续指纹相同；这里每次断言前都走 30 帧，确保祖先的自动烘焙一定会发生。
function paint(n:int):void { for (var i:int = 0; i < n; i++) stage.render(400, 700, "temp/swc-mc-button.png"); }
function st(o:MovieClip):String { return "" + o.currentFrame + ":" + o.currentLabel; }
function labelFrames(mc:MovieClip):String {
  var s:String = "";
  var labels:Array = mc.currentLabels;
  for (var i:int = 0; i < labels.length; i++) {
    if (i > 0) s += ",";
    s += labels[i].name + "@" + labels[i].frame;
  }
  return s;
}
// 逐像素比较两块画布：返回不同的像素个数（= 视觉真的变了）。
function inkDiff(a:BitmapData, b:BitmapData):int {
  var n:int = 0;
  for (var y:int = 0; y < a.height; y++) {
    for (var x:int = 0; x < a.width; x++) {
      if (a.getPixel32(x, y) != b.getPixel32(x, y)) n++;
    }
  }
  return n;
}
function snap(o:DisplayObject, w:int, h:int):BitmapData {
  var bd:BitmapData = new BitmapData(w, h, true, 0x00000000);
  bd.draw(o);
  return bd;
}
function findByName(o:DisplayObjectContainer, nm:String):DisplayObject {
  if (o.name == nm) return o;
  for (var i:int = 0; i < o.numChildren; i++) {
    var c:DisplayObjectContainer = o.getChildAt(i) as DisplayObjectContainer;
    if (c != null) { var r:DisplayObject = findByName(c, nm); if (r != null) return r; }
  }
  return null;
}

// ---- ① 符号本身：元件17_55（_up@1 / _over@4 / _down@7，自带脚本设 buttonMode）----
// 入库夹具里这个符号导出为 `skin_fla.元件17_55`（Animate 的 `_<符号id>` 后缀随库变化：
// 旧的 `_125`、`_362` 是同一批符号在另一份导出里的后缀）。**标签帧与行为逐条相同**，
// 所以下面所有断言（帧号、buttonMode 门、像素差）都直接沿用。
var clsA:Class = getDefinitionByName("skin_fla.\u5143\u4ef617_55") as Class;
check(clsA != null, "getDefinitionByName must resolve skin_fla.元件17_55");
var A:MovieClip = new clsA() as MovieClip;
check(A.totalFrames == 11, "元件17_55 has 11 frames, got " + A.totalFrames);
check(labelFrames(A) == "_up@1,_over@4,_down@7", "元件17_55 labels are _up@1,_over@4,_down@7, got " + labelFrames(A));
// 符号自身的 frame1 脚本（SWC 的 DoABC）在构造时就跑了，和 adl 一样把 buttonMode 打开。
check(A.buttonMode, "the symbol's own frame-1 script must set buttonMode (adl parity)");
A.x = 20; A.y = 20;
stage.addChild(A);

// 同一类的第二个实例做**门**的负例：buttonMode 关掉后状态机必须完全不动。
var B:MovieClip = new clsA() as MovieClip;
B.buttonMode = false;
B.x = 20; B.y = 160;
stage.addChild(B);

// ---- ② 有标签但没脚本的符号（buttonMode 默认 false）也要不动 ----
var clsC:Class = getDefinitionByName("skin_fla.BtnRootResources_99\u590d\u5236_64") as Class;
check(clsC != null, "getDefinitionByName must resolve BtnRootResources_99复制_64");
var C:MovieClip = new clsC() as MovieClip;
check(labelFrames(C) == "_up@1,_over@5,_down@10", "BtnRootResources_99复制_64 labels are _up@1,_over@5,_down@10, got " + labelFrames(C));
check(!C.buttonMode, "a symbol with no script keeps buttonMode at its default false");
C.x = 200; C.y = 20;
stage.addChild(C);

var hx:Number = A.x + A.width / 2;
var hy:Number = A.y + A.height / 2;
var outX:Number = 380;
var outY:Number = 190;

// ---- ③ 不在按钮上 → _up（离屏/无指针也是这一档）----
stage.dispatchMouse(outX, outY, "mouseMove");
paint(30);
check(st(A) == "1:_up", "away -> A at 1:_up, got " + st(A));
check(st(B) == "1:_up" && st(C) == "1:_up", "away -> B and C at 1:_up");
var bdUp:BitmapData = snap(A, 62, 24);

// ---- ④ 滚入 → _over（真导航到标签帧，且自动烘焙的祖先不能把它冻住）----
stage.dispatchMouse(hx, hy, "mouseMove");
paint(30);
check(st(A) == "4:_over", "roll-over -> A at 4:_over, got " + st(A));
check(A.currentFrameLabel == "_over", "currentFrameLabel follows the state, got " + A.currentFrameLabel);
check(st(B) == "1:_up", "buttonMode=false: B stays at 1:_up on roll-over, got " + st(B));
check(st(C) == "1:_up", "labels without buttonMode: C stays at 1:_up, got " + st(C));
var bdOver:BitmapData = snap(A, 62, 24);

// ---- ⑤ 按下 → _down ----
stage.dispatchMouse(hx, hy, "mouseDown");
paint(30);
check(st(A) == "7:_down", "press -> A at 7:_down, got " + st(A));
var bdDown:BitmapData = snap(A, 62, 24);

// 「UI 真的变了」这件事的像素断言。注意这个符号的 `_down` 画面与 `_up` 是**同一张图**
// （量出来的 up/down 像素差为 0，只有 `_over` 是另一张），所以只钉 up≠over 与 over≠down；
// 下面首页卡片那一档三种状态两两不同，会把三对都断言一遍。
check(inkDiff(bdUp, bdOver) > 0, "the over state must differ from the up state on screen");
check(inkDiff(bdOver, bdDown) > 0, "the down state must differ from the over state on screen");

// ---- ⑥ 按住拖出去 → 仍 _down（按压锁在按下的对象上）----
stage.dispatchMouse(outX, outY, "mouseMove");
paint(30);
check(st(A) == "7:_down", "drag off while held keeps 7:_down, got " + st(A));

// ---- ⑦ 在外面松开 → _up ----
stage.dispatchMouse(outX, outY, "mouseUp");
paint(30);
check(st(A) == "1:_up", "release outside -> 1:_up, got " + st(A));

// ---- ⑧ 滚入后原地松开 → 回到 _over ----
stage.dispatchMouse(hx, hy, "mouseMove");
paint(5);
check(st(A) == "4:_over", "roll-over again -> 4:_over, got " + st(A));
stage.dispatchMouse(hx, hy, "mouseDown");
paint(5);
stage.dispatchMouse(hx, hy, "mouseUp");
paint(30);
check(st(A) == "4:_over", "release inside -> back to 4:_over, got " + st(A));

// ---- ⑨ 在别处按下、再拖进来 → 只有 _over ----
stage.dispatchMouse(outX, outY, "mouseMove");
stage.dispatchMouse(outX, outY, "mouseDown");
paint(5);
stage.dispatchMouse(hx, hy, "mouseMove");
paint(30);
check(st(A) == "4:_over", "a press that started elsewhere shows _over, not _down, got " + st(A));
stage.dispatchMouse(outX, outY, "mouseUp");
paint(5);

// ---- ⑩ 首页卡片：homeskin.joinmeeting（_up@1 / _over@5 / _down@11）----
// 这一档是自动烘焙的真回归：卡片在 homeskin 里面，而 homeskin 很快就会被自动烘焙，
// 只有「指纹 pass 里结算状态」才能让 1 → 5 → 11 的迁移照常发生并让缓存失效。
var clsH:Class = getDefinitionByName("homeskin") as Class;
check(clsH != null, "getDefinitionByName must resolve homeskin");
var H:MovieClip = new clsH() as MovieClip;
stage.addChild(H);
var card:MovieClip = findByName(H, "joinmeeting") as MovieClip;
check(card != null, "homeskin must expose the joinmeeting card by name");
check(card.buttonMode, "the home card's own script sets buttonMode");
check(card.totalFrames == 18, "the home card has 18 frames, got " + card.totalFrames);

// 卡片在桌面上的位置（homeskin 自身在原点，卡片是它的直接子件）。
var gp:Point = card.localToGlobal(new Point(card.width / 2, card.height / 2));
stage.dispatchMouse(5, 5, "mouseMove");
paint(30);
check(st(card) == "1:_up", "home card idle -> 1:_up, got " + st(card));
var cardUp:BitmapData = snap(card, 340, 90);
stage.dispatchMouse(gp.x, gp.y, "mouseMove");
paint(30);
check(st(card) == "5:_over", "home card roll-over -> 5:_over, got " + st(card));
var cardOver:BitmapData = snap(card, 340, 90);
stage.dispatchMouse(gp.x, gp.y, "mouseDown");
paint(30);
check(st(card) == "11:_down", "home card press -> 11:_down, got " + st(card));
var cardDown:BitmapData = snap(card, 340, 90);
check(inkDiff(cardUp, cardOver) > 0, "the home card's over state must be visible (auto-bake must not freeze it)");
check(inkDiff(cardOver, cardDown) > 0, "the home card's down state must be visible");
stage.dispatchMouse(gp.x, gp.y, "mouseUp");
paint(30);
check(st(card) == "5:_over", "home card release -> 5:_over, got " + st(card));
stage.dispatchMouse(5, 5, "mouseMove");
paint(30);
check(st(card) == "1:_up", "home card roll-out -> 1:_up, got " + st(card));

// ---- ⑪ D43：回退到 `_up` 必须**复用**未变的子件（AIR 实测口径），而不是重建整个第 1 帧 ----
// 症状（TalkMED 首页卡片）：App 往卡片里写了自己的标题（快速入会 / Join quickly），悬停一次
// 再移开，标题就被皮肤原稿（加入会议）覆盖了。根因是回退路径 `as_swc_tl_clear + as_swc_bind`
// 把第 1 帧的**全部**子件重建一遍，App 写进 TextField 的文字随旧对象一起被丢掉。
// adl 51.4.1 实测（temp/btnprobe/Rewind2.as，输出 rewind2-out.txt）：从 _over(5) 退回 _up(1)
// 时 label1/label2 是**同一批对象**（#1/#2 不变）且文字保留；只有「目标帧的（深度, 角色）
// 与当前不同」的那个深度上才换新对象（深度 1 从 524 换回 518，实例名 instance8 → instance28）。
var tf1:TextField = card.getChildAt(1) as TextField;
var tf2:TextField = card.getChildAt(2) as TextField;
check(tf1 != null && tf2 != null, "the home card carries its two label TextFields at depths 2/3");
tf1.text = "MARK0";
tf2.text = "MARK1";
var d1:DisplayObject = card.getChildAt(0);   // 第 1 帧深度 1 的角色，会在 _over/_down 被替换
// 先走一帧再取基准：TextField 的排版/缓存要一次绘制 pass 才落到卡片自己的缓存里，
// 否则比的是「刚写完 text、还没重排」的中间态。
paint(30);
var cardUpMark:BitmapData = snap(card, 340, 90);
var n0:int = card.numChildren;
stage.dispatchMouse(gp.x, gp.y, "mouseMove");
paint(30);
check(st(card) == "5:_over", "label probe: roll-over -> 5:_over, got " + st(card));
check(tf1.text == "MARK0" && tf2.text == "MARK1", "a forward state change keeps the app-written labels");
stage.dispatchMouse(gp.x, gp.y, "mouseDown");
paint(30);
stage.dispatchMouse(gp.x, gp.y, "mouseUp");
paint(30);
stage.dispatchMouse(outX, outY, "mouseMove");
paint(30);
check(st(card) == "1:_up", "label probe: roll-out -> 1:_up (a backward timeline move), got " + st(card));
check(card.getChildAt(1) == tf1 && card.getChildAt(2) == tf2,
  "backward navigation must REUSE the unchanged (depth,character) children, not rebuild frame 1");
check(tf1.text == "MARK0" && tf2.text == "MARK1",
  "backward navigation must keep what the app wrote into the labels (D43)");
check(card.getChildAt(0) != d1,
  "the depth-1 character differs between _up and _over, so that child is still replaced (adl does the same)");
paint(30);
check(inkDiff(cardUpMark, snap(card, 340, 90)) == 0,
  "the reconstructed _up state is pixel-identical to the pre-hover state (app text included)");
check(card.numChildren == n0,
  "the rewind neither duplicates nor drops a child (" + n0 + " -> " + card.numChildren + ")");

if (fails == 0) trace("swc-mc-button ok");
else { trace("swc-mc-button FAILED: " + fails); throw new Error("swc-mc-button: " + fails + " checks failed"); }
