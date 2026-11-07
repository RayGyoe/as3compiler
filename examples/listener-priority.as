// listener-priority.as — addEventListener priority ordering.
//
// Measured on adl 51.4.1 (temp/weakprobe cases E/F/G/H):
//
//   1. Dispatch order is DESCENDING priority, independent of registration order
//      (E: registered p10, p0, p20, p-5; AIR ran p20 -> p10 -> p0 -> p-5).
//   2. Equal priorities keep registration order (F: three p7 ran 1, 2, 3).
//   3. A repeat addEventListener of the same listener is a complete no-op: it does
//      not add a second entry and does NOT update the stored priority (G: `f`
//      added at 0 then at 50 still ran after the p5 listener).
//   4. removeEventListener followed by addEventListener does reposition, because
//      that is a fresh entry (H).
//   5. The capture and bubble lists sort independently (each phase walks its own
//      array), so a capture listener always precedes every bubble listener again.
//
// Compile: as-aot examples/listener-priority.as --run
import flash.events.Event;
import flash.events.EventDispatcher;
import flash.display.Sprite;

var log:Array = [];
var defecit:Array = [];

function rec(s:String):void { log.push(s); }
function reset():void { log = []; }
function check(label:String, got:String, want:String):void {
  if (got != want) defecit.push("FAIL " + label + ": got [" + got + "] want [" + want + "]");
  else trace("ok   " + label + " = " + got);
}

// --- A: descending order over four priorities ------------------------------
var d:EventDispatcher = new EventDispatcher();
d.addEventListener("e", function (ev:Event):void { rec("p10"); }, false, 10);
d.addEventListener("e", function (ev:Event):void { rec("p0"); }, false, 0);
d.addEventListener("e", function (ev:Event):void { rec("p20"); }, false, 20);
d.addEventListener("e", function (ev:Event):void { rec("pneg"); }, false, -5);
reset();
d.dispatchEvent(new Event("e"));
check("A descending priority", log.join(","), "p20,p10,p0,pneg");

// --- B: equal priority keeps registration order ----------------------------
var d2:EventDispatcher = new EventDispatcher();
d2.addEventListener("e", function (ev:Event):void { rec("1"); }, false, 7);
d2.addEventListener("e", function (ev:Event):void { rec("2"); }, false, 7);
d2.addEventListener("e", function (ev:Event):void { rec("3"); }, false, 7);
reset();
d2.dispatchEvent(new Event("e"));
check("B equal priority keeps order", log.join(","), "1,2,3");

// --- C: a repeat add neither duplicates nor re-prioritises ------------------
var d3:EventDispatcher = new EventDispatcher();
var f:Function = function (ev:Event):void { rec("f"); };
d3.addEventListener("e", function (ev:Event):void { rec("mid"); }, false, 5);
d3.addEventListener("e", f, false, 0);
d3.addEventListener("e", f, false, 50);
reset();
d3.dispatchEvent(new Event("e"));
check("C repeat add is a no-op", log.join(","), "mid,f");

// --- D: remove then add does reposition ------------------------------------
var d4:EventDispatcher = new EventDispatcher();
var g:Function = function (ev:Event):void { rec("g"); };
d4.addEventListener("e", function (ev:Event):void { rec("mid"); }, false, 5);
d4.addEventListener("e", g, false, 50);
d4.removeEventListener("e", g);
d4.addEventListener("e", g, false, 0);
reset();
d4.dispatchEvent(new Event("e"));
check("D remove+add repositions", log.join(","), "mid,g");

// --- E: priority ordering survives removal in the middle -------------------
var d5:EventDispatcher = new EventDispatcher();
var a5:Function = function (ev:Event):void { rec("a5"); };
var b5:Function = function (ev:Event):void { rec("b5"); };
var c5:Function = function (ev:Event):void { rec("c5"); };
d5.addEventListener("e", b5, false, 5);
d5.addEventListener("e", a5, false, 9);
d5.addEventListener("e", c5, false, 1);
d5.removeEventListener("e", a5);
reset();
d5.dispatchEvent(new Event("e"));
check("E middle removal keeps order", log.join(","), "b5,c5");

// --- F: capture and bubble lists sort independently -------------------------
var root:Sprite = new Sprite();
var child:Sprite = new Sprite();
root.addChild(child);
root.addEventListener("e", function (ev:Event):void { rec("root-bub-p0"); }, false, 0);
root.addEventListener("e", function (ev:Event):void { rec("root-bub-p9"); }, false, 9);
root.addEventListener("e", function (ev:Event):void { rec("root-cap-p0"); }, true, 0);
root.addEventListener("e", function (ev:Event):void { rec("root-cap-p9"); }, true, 9);
reset();
child.dispatchEvent(new Event("e", true));
check("F capture,bubble sorted per phase", log.join(","),
  "root-cap-p9,root-cap-p0,root-bub-p9,root-bub-p0");

if (defecit.length > 0) throw new Error(defecit.join("\n"));
trace("listener_priority: all assertions passed");