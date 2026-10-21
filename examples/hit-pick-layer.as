// hit-pick-layer.as — 阶段二百三十三：鼠标拾取问的是「画出来的区域」，
// 不是子件包围盒的并集。
//
// 症状（真应用，TalkMED Meeting，ASC_MOUSE_TRACE=2 实测）：会议窗口 resize 之后
// 整片文档/视频面板都点不到——底部工具栏、标题栏按钮、面板里的控件全部无响应；
// 而同一个窗口最大化之后工具栏又能点。trace 里每个落点的 hit= 都是同一个
// com.vsdevelop.proxy::ViewControl：那是给弹层预留的**空**容器，自己不画任何东西，
// 却因为「所有子件包围盒的并集」盖住了整块面板，又按 z 序压在真控件之上，
// 于是把所有点击都吃掉了（它的子件里还有一个平时 visible=false 的弹层，旧判据连
// 不可见子树一起算）。
//
// AIR 的语义（= hitTestPoint(x, y, true) 的区域判据，本示例逐条钉住）：
//   * 自己不画的 Sprite 在任何位置都不是命中目标——这正是 Flash 里
//     「先画一块透明 fill 来吃掉点击」这个惯例的由来；
//   * 两个子件之间的**空隙**是 miss（虽然它落在父容器的包围盒内）；
//   * 不可见子树不是命中目标（弹层隐藏时整棵都不参与）；
//   * 透明 fill 仍然算命中区（形状判据不看 alpha）。
// 拾取比 hitTestPoint(…, true) 只多两条自己的规则：上面的 visible 门，以及
// 按钮问的是它的**命中态**（见 as_pick_hit_local 注释里那 29 个隐形点击靶）。
//
// 注：矢量图形「同一次 fill 里两个图形之间的缝」需要先保留绘制路径（Skia 后端），
// 纯 C 后端按画出来的外框退化回答；那条缝由 stage94s.as（子件之间）与
// test/unit/display.ts 的源级钉子覆盖，本示例只用两个后端都成立的判据。
import flash.display.*;
import flash.events.*;

function check(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var stage:Stage = new Stage();

// 舞台上的「最后落点」，dispatchMouse 之前清空。
var lastTarget:Object = null;
stage.addEventListener("mouseDown", function(e:MouseEvent):void { lastTarget = e.target; });
function pickAt(x:Number, y:Number):Object {
  lastTarget = null;
  stage.dispatchMouse(x, y, "mouseDown");
  return lastTarget;
}

// ---- A. 父容器的包围盒盖住空隙：缝里必须是 miss ----
var holder:Sprite = new Sprite();          // 自己什么都不画，只有两个子件
var left:Sprite = new Sprite();
left.graphics.beginFill(0xFF0000); left.graphics.drawRect(0, 0, 100, 100); left.graphics.endFill();
var right:Sprite = new Sprite();
right.x = 200;
right.graphics.beginFill(0x00FF00); right.graphics.drawRect(0, 0, 100, 100); right.graphics.endFill();
holder.addChild(left);
holder.addChild(right);
stage.addChild(holder);
check(pickAt(50, 50) == left, "a point on the first child picks that child");
check(pickAt(250, 50) == right, "a point on the second child picks that child");
check(pickAt(150, 50) == stage, "the gap between two children is a miss, though the parent's box spans it");
check(holder.hitTestPoint(150, 50, false), "the parent's BOX does span the gap (that is why the union box is wrong)");

// ---- B. 空容器 + 隐藏弹层：压在上面的空层不得吃掉下面的按钮 ----
var btn:Sprite = new Sprite();
btn.y = 200;
btn.graphics.beginFill(0x0000FF); btn.graphics.drawRect(0, 0, 100, 50); btn.graphics.endFill();
stage.addChild(btn);

var layer:Sprite = new Sprite();      // 应用里那个 ViewControl：为弹层预留的容器
var popup:Sprite = new Sprite();      // 弹层内容，平时隐藏
popup.graphics.beginFill(0x888888); popup.graphics.drawRect(0, 0, 300, 300); popup.graphics.endFill();
popup.visible = false;
layer.addChild(popup);
stage.addChild(layer);                // z 序在 btn 之上
check(layer.numChildren == 1, "the popup layer really does hold content (so its box is non-empty)");
check(pickAt(50, 220) == btn, "an empty layer whose hidden child covers the button does NOT swallow it");
check(pickAt(50, 220) != layer, "and the layer itself is never the target");

// 弹层可见时它就是真的目标（不看 alpha，只看画没画）——AIR 同此。
popup.visible = true;
check(pickAt(50, 220) == popup, "once the popup is visible its fill becomes the target");
popup.visible = false;

// 空容器（没有子件、没有图形）在任何位置都不是目标。
var emptySprite:Sprite = new Sprite();
stage.addChild(emptySprite);
check(pickAt(150, 190) == stage, "a point inside the layer's box but on nothing painted is a miss");

// ---- C. 透明 fill 仍然吃掉点击（Flash 惯例必须保住）----
var catcher:Sprite = new Sprite();
catcher.graphics.beginFill(0x000000, 0);       // alpha = 0
catcher.graphics.drawRect(0, 300, 400, 60);
catcher.graphics.endFill();
stage.addChild(catcher);
check(pickAt(200, 320) == catcher, "a transparent fill still catches the mouse (alpha is not consulted)");

// 但 mouseEnabled=false 的容器不吃；命中落到它下面的东西。
catcher.mouseEnabled = false;
check(pickAt(200, 320) == stage, "a mouseEnabled=false catcher passes the hit through");

trace("hit-pick-layer ok");