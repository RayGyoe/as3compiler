// displaylist-events.as — the display-list add/remove event contract.
//
// AIR dispatches, on the child (and on every descendant for the stage pair):
//   Event.ADDED ("added", bubbles)        -> before ADDED_TO_STAGE
//   Event.ADDED_TO_STAGE ("addedToStage", non-bubbling, one per descendant)
//   Event.REMOVED ("removed", bubbles)    -> while the child is STILL attached
//   Event.REMOVED_FROM_STAGE ("removedFromStage", non-bubbling, per descendant)
// Nothing is dispatched when the container is off the stage (no stage pair), and
// `childAdded`/`childRemoved` are never dispatched by the player.
//
// This is not cosmetic: the TalkMED app (com.vsdevelop.proxy.ViewControl) listens
// for Event.REMOVED and calls removeAt() from it — the hook that stops a
// WxScanView's Timer. With no "removed" at all that timer leaked forever.
//
// Every expected string below is the verbatim adl 51.4.1 output (temp/dlprobe/).
//
// Compile: as-aot examples/displaylist-events.as --run

import flash.display.DisplayObject;
import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;

var stage:Stage = new Stage();

var LOG:String = "";
var kid:Sprite = new Sprite();
var grand:Sprite = new Sprite();
var box:Sprite = new Sprite();
var c2:Sprite = new Sprite();
var off:Sprite = new Sprite();
var p2:Sprite = new Sprite();
var sub:Sprite = new Sprite();
var subsub:Sprite = new Sprite();

function tag(o:Object):String {
  if (o == kid) return "kid";
  if (o == grand) return "grand";
  if (o == c2) return "c2";
  if (o == box) return "box";
  if (o == off) return "off";
  if (o == p2) return "p2";
  if (o == sub) return "sub";
  if (o == subsub) return "subsub";
  return "?";
}
function h(e:Event):void {
  LOG += tag(e.target) + ":" + e.type + " b=" + (e.bubbles ? 1 : 0) + " p=" + e.eventPhase + " ";
}
function watch(o:DisplayObject):void {
  var ts:Array = ["added", "removed", "addedToStage", "removedFromStage", "childAdded", "childRemoved"];
  for (var i:int = 0; i < ts.length; i++) o.addEventListener(ts[i] as String, h);
}
function reset():void { LOG = ""; }
function check(tagName:String, want:String):void {
  if (LOG != want) throw new Error("FAIL " + tagName + "\n  want [" + want + "]\n  got  [" + LOG + "]");
  trace(tagName + " ok");
}

watch(box); watch(kid); watch(grand);
stage.addChild(box);

reset(); box.addChild(kid);
check("addChild", "kid:added b=1 p=2 kid:added b=1 p=3 kid:addedToStage b=0 p=2 ");

reset(); kid.addChild(grand);
check("nested addChild", "grand:added b=1 p=2 grand:added b=1 p=3 grand:added b=1 p=3 grand:addedToStage b=0 p=2 ");

reset(); kid.removeChild(grand);
check("nested removeChild", "grand:removed b=1 p=2 grand:removed b=1 p=3 grand:removed b=1 p=3 grand:removedFromStage b=0 p=2 ");

reset(); box.removeChild(kid);
check("removeChild", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 ");

box.addChild(kid); kid.addChild(grand); reset(); box.removeChildAt(0);
check("removeChildAt", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 grand:removedFromStage b=0 p=2 ");

watch(c2);
reset(); off.addChild(c2);
check("addChild off stage", "c2:added b=1 p=2 ");

reset(); off.removeChild(c2);
check("removeChild off stage", "c2:removed b=1 p=2 ");

box.addChild(kid); stage.addChild(p2); reset(); p2.addChild(kid);
check("re-parent", "kid:removed b=1 p=2 kid:removed b=1 p=3 kid:removedFromStage b=0 p=2 grand:removedFromStage b=0 p=2 kid:added b=1 p=2 kid:addedToStage b=0 p=2 grand:addedToStage b=0 p=2 ");

watch(sub); watch(subsub); sub.addChild(subsub); reset(); stage.addChild(sub);
check("subtree add", "sub:added b=1 p=2 sub:addedToStage b=0 p=2 subsub:addedToStage b=0 p=2 ");

reset(); stage.removeChild(sub);
check("subtree remove", "sub:removed b=1 p=2 sub:removedFromStage b=0 p=2 subsub:removedFromStage b=0 p=2 ");

trace("displaylist-events: all ok");
