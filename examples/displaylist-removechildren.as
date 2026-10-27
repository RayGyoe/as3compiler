// displaylist-removechildren.as — DisplayObjectContainer.removeChildren() 的口径。
//
// AIR（adl 51.4.1 实测，temp/dlorder/：Xcheck.as 与 Xcheck-app.xml，日志 xcheck-air.txt）
// 的 removeChildren(beginIndex = 0, endIndex = 0x7FFFFFFF) 是：
//   ① **从 beginIndex 往上**逐个摘（不是从 endIndex 往下），每摘一个后面的索引就前移；
//   ② endIndex **含**在范围内（0,2 摘三个）。
//   四子件 A,B,C,D 的实测：
//     removeChildren()     -> 摘 A B C D，剩 ""
//     removeChildren(0,2)  -> 摘 A B C，  剩 "D"
//     removeChildren(1,3)  -> 摘 B C D，  剩 "A"
//     removeChildren(0,0)  -> 摘 A，      剩 "BCD"
//     removeChildren(2,2)  -> 摘 C，      剩 "ABD"
//
// 顺序不是细节：真应用从「降序」实现上翻车过——MeetingView 关闭时
// ViewControl.removeChildall() 走 removeChildren()，而 VideoRootView.removeStage()
// 在 REMOVED_FROM_STAGE 里做 upBtn.parent.removeChild(upBtn)，upBtn 是同一个父容器的
// **后加兄弟**。降序先把 upBtn 摘掉，等视图自己的 handler 跑时 upBtn.parent 已是 null，
// #1009 中断整条关闭链（diag.log 里紧接 websocket close 就抛）。
//
// 另外命中区也一并钉住：scrollRect 只裁剪**鼠标**命中区，hitTestPoint(x, y, true)
// 在 AIR 里**不裁剪**（同一个 adl 探针：100x300 的子件挂在 (0,0,100,100) 的 scrollRect 下，
// stage y=250 / y=390 仍答 true）。鼠标侧见 test/unit/display.ts 的结构钉 + temp/pickclip。
//
// Compile: as-aot examples/displaylist-removechildren.as --run

import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.geom.Rectangle;

var stage:Stage = new Stage();

var LOG:String = "";
function note(e:Event):void { LOG += e.currentTarget.name + " "; }

function kids(names:Array):Sprite {
  var box:Sprite = new Sprite();
  for (var i:int = 0; i < names.length; i++) {
    var k:Sprite = new Sprite();
    k.name = names[i] as String;
    k.addEventListener(Event.REMOVED, note);
    box.addChild(k);
  }
  return box;
}
function rest(box:Sprite):String {
  var s:String = "";
  for (var i:int = 0; i < box.numChildren; i++) s += box.getChildAt(i).name;
  return s;
}
function check(tag:String, want:String):void {
  if (LOG != want) throw new Error("FAIL " + tag + "\n  want [" + want + "]\n  got  [" + LOG + "]");
  trace(tag + " ok");
  LOG = "";
}

// ---- ① 五种区间 ----
var b1:Sprite = kids(["A", "B", "C", "D"]);
b1.removeChildren();
check("removeChildren()", "A B C D ");
trace("  rest=[" + rest(b1) + "]");

var b2:Sprite = kids(["A", "B", "C", "D"]);
b2.removeChildren(0, 2);
check("removeChildren(0, 2)", "A B C ");
if (rest(b2) != "D") throw new Error("FAIL removeChildren(0, 2) rest [" + rest(b2) + "]");

var b3:Sprite = kids(["A", "B", "C", "D"]);
b3.removeChildren(1, 3);
check("removeChildren(1, 3)", "B C D ");
if (rest(b3) != "A") throw new Error("FAIL removeChildren(1, 3) rest [" + rest(b3) + "]");

var b4:Sprite = kids(["A", "B", "C", "D"]);
b4.removeChildren(0, 0);
check("removeChildren(0, 0)", "A ");
if (rest(b4) != "BCD") throw new Error("FAIL removeChildren(0, 0) rest [" + rest(b4) + "]");

var b5:Sprite = kids(["A", "B", "C", "D"]);
b5.removeChildren(2, 2);
check("removeChildren(2, 2)", "C ");
if (rest(b5) != "ABD") throw new Error("FAIL removeChildren(2, 2) rest [" + rest(b5) + "]");

// ---- ② 关闭路径的形状：后加兄弟在 handler 里还挂在父上 ----
var box3:Sprite = new Sprite();
stage.addChild(box3);
var V:Sprite = new Sprite(); V.name = "V";
var W:Sprite = new Sprite(); W.name = "W";
var U:Sprite = new Sprite(); U.name = "U";
var Dn:Sprite = new Sprite(); Dn.name = "Dn";
V.addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
  LOG += "n=" + box3.numChildren + " W.parent=" + (W.parent != null) + " ";
  box3.removeChild(U);
  LOG += "n=" + box3.numChildren + " ";
  box3.removeChild(Dn);
  LOG += "n=" + box3.numChildren + " ";
});
box3.addChild(V);
box3.addChild(W);
box3.addChild(U);
box3.addChild(Dn);
box3.removeChildren();
check("re-entrant removeChildren", "n=4 W.parent=true n=3 n=2 ");
if (box3.numChildren != 0) throw new Error("FAIL re-entrant rest n=" + box3.numChildren);

// ---- ③ hitTestPoint(shapeFlag=true) 不看 scrollRect ----
var holder:Sprite = new Sprite();
stage.addChild(holder);
var clip:Sprite = new Sprite();
clip.x = 100;
clip.y = 100;
var tall:Sprite = new Sprite();
tall.graphics.beginFill(0xFF0000);
tall.graphics.drawRect(0, 0, 100, 300);
tall.graphics.endFill();
clip.addChild(tall);
holder.addChild(clip);
clip.scrollRect = new Rectangle(0, 0, 100, 100);
if (!clip.hitTestPoint(150, 150, true)) throw new Error("FAIL scroll: inside(150,150)");
if (!clip.hitTestPoint(150, 190, true)) throw new Error("FAIL scroll: inside(150,190)");
// 裁剪窗外仍是 true：AIR 的 shapeFlag 命中区不裁剪（只裁鼠标）
if (!clip.hitTestPoint(150, 250, true)) throw new Error("FAIL scroll: belowClip(150,250)");
if (!clip.hitTestPoint(150, 390, true)) throw new Error("FAIL scroll: belowClip(150,390)");
if (clip.hitTestPoint(90, 150, true)) throw new Error("FAIL scroll: left(90,150)");
if (!clip.hitTestPoint(150, 250, false)) throw new Error("FAIL scroll: boxFlag(150,250)");
trace("scrollRect clips the MOUSE region only ok");

trace("displaylist-removechildren ok");