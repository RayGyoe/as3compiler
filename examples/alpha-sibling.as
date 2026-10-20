// alpha-sibling.as — 半透明对象必须**只影响自己**：`as_render_object` 给 alpha<1
// 的对象开了一层 saveLayerAlpha，但漏掉了配对的 restore（阶段二百一十四）。
//
// 为什么这是致命错：Skia 的 save/restore 是一叠栈。子对象漏掉的那次 restore 会被
// **父对象的那次 restore 顶掉**，于是父对象自己那次 save（以及它在 save 之后施加的
// translate/rotate/scale）就一直留在栈上——**这一帧里之后画的所有东西都带着那个父
// 对象的位移**。真应用里的链条是：列表行（AiSubtitleRenderers）在 MOUSE_DOWN 时把
// 自己的 `skin.bg.alpha` 设成 0.5，一拖动列表滚动条就 `mouseChildren = false`，
// 行的 MOUSE_UP 永远收不到 ⇒ 那个 0.5 一直留着 ⇒ 该行之后的同级对象（尤其是 depth
// 更大的"创建同传"卡片）都被平移到该行的位置上（往下跳一大截），直到列表被重建
// （用户报的"拖动列表后点刷新，上面的按钮跳下来再恢复"）。
//
// 这个例子把整条链缩到最小：半透明的 inner 在 item 里，item 在 root 里，card 是
// item 之后的同级。断言的像素位置就是「card 有没有被 item 的 y 带跑」。
import flash.display.Sprite;
import flash.display.BitmapData;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var root:Sprite = new Sprite();

// item：先画。它自己的 alpha 是 1，但里面有一个 alpha 0.5 的子件。
var item:Sprite = new Sprite();
item.y = 100;
item.graphics.beginFill(0x00FF00);
item.graphics.drawRect(0, 0, 50, 20);
item.graphics.endFill();
var inner:Sprite = new Sprite();
inner.graphics.beginFill(0xFF0000);
inner.graphics.drawRect(0, 0, 50, 20);
inner.graphics.endFill();
inner.alpha = 0.5;
item.addChild(inner);
root.addChild(item);

// card：后画（同级、本身完全不透明、在 y=0）。
var card:Sprite = new Sprite();
card.graphics.beginFill(0x0000FF);
card.graphics.drawRect(0, 0, 50, 20);
card.graphics.endFill();
root.addChild(card);

var bd:BitmapData = new BitmapData(120, 160, false, 0xFFFFFF);
bd.draw(root);

var atCard:int = bd.getPixel(10, 10);
var atItem:int = bd.getPixel(10, 110);

// 1. card 必须留在自己的位置上（修前它被 item.y 带到了 y=100）。
check(atCard == 0x0000FF, "an opaque sibling after a translucent subtree keeps its own position (got 0x"
  + atCard.toString(16) + ", want 0xff)");

// 2. card 不能出现在 item 的位置上（那里是 50% 红，不是蓝）。
check(atItem != 0x0000FF, "the translucent row's spot is not painted with the later sibling's colour");

// 3. 半透明本身还是对的：50% 红压在 item 的绿底上，是既非纯红也非纯绿也非白的混色。
check(atItem != 0xFF0000 && atItem != 0x00FF00 && atItem != 0xFFFFFF,
  "the 0.5-alpha row still blends with the background (got 0x" + atItem.toString(16) + ")");

// 4. 画完以后状态要干净：同一个 BitmapData 再画一遍，结果必须逐像素相同
//    （漏掉的 save 会让第二遍叠加不同的变换）。
var bd2:BitmapData = new BitmapData(120, 160, false, 0xFFFFFF);
bd2.draw(root);
check(bd2.getPixel(10, 10) == atCard && bd2.getPixel(10, 110) == atItem,
  "a second pass renders identically (no transform left on the canvas)");

trace("alpha-sibling: ok");