// listener_identity.as — listener registration identity and the AT_TARGET phase.
//
// Two rules of AIR's EventDispatcher that a naive "append every addEventListener"
// model gets wrong, both measured on adl 51.4.1 (temp/dupprobe/Main.as, cases A-I,
// diffed against our own build in temp/dupprobe/result.txt):
//
//   1. Registering the same listener twice is a NO-OP. "The same listener" means
//      the same function *and* the same receiver *and* the same useCapture: the very
//      same closure added twice runs once, a bound method added twice (two distinct
//      closures over one method+receiver, which is why the identity test is fn+env)
//      also runs once, and add-twice-then-remove-once leaves NOTHING behind.
//   2. AT_TARGET consults only the non-capture list. The capture phase walks from
//      the root down to the target's PARENT, so a useCapture listener registered on
//      the target itself never runs -- on a bare dispatcher a capture-only listener
//      fires zero times, and on a p->c chain a dispatch from `c` gives
//      p.cap@1, c.bub@2, p.bub@3 with c.cap absent.
//
// Rule 1 is not academic: com.vsdevelop.proxy.ViewControl re-registers MOUSE_DOWN
// from a subclassed ADDED_TO_STAGE hook (MHIOSScrollBar/MWIOSScrollBar) that does
// not remove the base one, so the drag installed TWO stage mouseMove/mouseUp pairs,
// one mouseUp removed only one of them, and the leftover pair kept running the app's
// drag code for the rest of the session -- which leaves the scrolled container with
// mouseEnabled=false and kills the flick's bounce (TalkMED home page / file list).
//
// Compile: as-aot examples/listener_identity.as --run

import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.events.MouseEvent;

var stage:Stage = new Stage();
var defecit:Array = [];

function note(tag:String):Function {
  return function (e:Event):void { log += tag + "@" + e.eventPhase + " "; };
}

var log:String = "";
function reset():void { log = ""; }
function check(label:String, got:String, want:String):void {
  if (got != want) defecit.push("FAIL " + label + "\n  want [" + want + "]\n  got  [" + got + "]");
  else trace(label + " ok");
}

function plain(e:Event):void { log += "plain@"; }

// --- A: the very same closure registered twice runs once -------------------
reset();
var d1:Sprite = new Sprite();
d1.addEventListener("hit", plain);
d1.addEventListener("hit", plain);
d1.dispatchEvent(new Event("hit"));
check("A same function twice runs once", log, "plain@");

// --- B: a bound method registered twice runs once --------------------------
class Counter extends Sprite {
  public var n:int = 0;
  public function bump(e:Event):void { n++; }
}
reset();
var d2:Counter = new Counter();
d2.addEventListener("hit", d2.bump);
d2.addEventListener("hit", d2.bump);
d2.dispatchEvent(new Event("hit"));
check("B bound method twice runs once", String(d2.n), "1");

// --- C: add twice + remove once leaves no listener behind ------------------
reset();
d2.n = 0;
d2.addEventListener("hit", d2.bump);
d2.removeEventListener("hit", d2.bump);
d2.dispatchEvent(new Event("hit"));
check("C add x2 remove x1 detaches", String(d2.n), "0");

// --- D: a capture listener on the TARGET never runs ------------------------
reset();
var d3:Sprite = new Sprite();
d3.addEventListener("hit", note("d3.cap"), true);
d3.dispatchEvent(new Event("hit"));
check("D capture-only target listener is silent", log, "");

// --- E/F: the target runs its bubble list; ancestors run capture then bubble -
reset();
var p:Sprite = new Sprite();
var c:Sprite = new Sprite();
p.addChild(c);
c.addEventListener("hit", note("c.cap"), true);
c.addEventListener("hit", note("c.bub"), false);
p.addEventListener("hit", note("p.cap"), true);
p.addEventListener("hit", note("p.bub"), false);
c.dispatchEvent(new Event("hit", true));
check("F chain order is capture-descend then bubble-ascend", log, "p.cap@1 c.bub@2 p.bub@3 ");

// --- G: the same, with the real Stage at the top of the ancestor chain ------
reset();
var p2:Sprite = new Sprite();
var c2:Sprite = new Sprite();
p2.addChild(c2);
stage.addChild(p2);
c2.addEventListener("hit", note("c2.cap"), true);
c2.addEventListener("hit", note("c2.bub"), false);
p2.addEventListener("hit", note("p2.cap"), true);
p2.addEventListener("hit", note("p2.bub"), false);
stage.addEventListener("hit", note("stage.bub"), false);
c2.dispatchEvent(new Event("hit", true));
check("G stage chain keeps the same target-phase rule",
  log, "p2.cap@1 c2.bub@2 p2.bub@3 stage.bub@3 ");

// --- H: removeEventListener is sensitive to useCapture ---------------------
// A capture listener on the PARENT (where the capture phase really runs) must
// survive a removal spelled with useCapture=false.
reset();
var p3:Sprite = new Sprite();
var c3:Sprite = new Sprite();
p3.addChild(c3);
p3.addEventListener("hit", note("p3.cap"), true);
p3.removeEventListener("hit", note("p3.cap"), false);
c3.dispatchEvent(new Event("hit", true));
check("H remove with the wrong useCapture does not detach", log, "p3.cap@1 ");

// --- I: hasEventListener still reports the live registration ----------------
if (!d1.hasEventListener("hit")) defecit.push("FAIL hasEventListener after the dedup add");
else trace("hasEventListener ok");

if (defecit.length > 0) throw new Error(defecit.join("\n"));
trace("listener_identity: all assertions passed");
