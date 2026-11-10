// weak-listener.as — useWeakReference, aligned with AIR's own asymmetry.
//
// Measured on adl 51.4.1 (temp/weakprobe, registration isolated in its own method so
// no caller stack slot keeps the closure alive):
//
//   1. A nested inner function registered weakly IS collected, and dispatch then
//      silently skips it (cases A, X: alive=0 and no handler ran).
//   2. A class-level member function (obj.method) registered weakly is NOT
//      collected -- AIR never collects class-level functions, so the handler keeps
//      running (cases C, Z2: receiver alive=1, handler fired).
//   3. A weak registration whose closure also has a strong reference elsewhere
//      keeps firing (case B).
//   4. removeEventListener still detaches a weak registration.
//
// Our implementation reproduces 1-4: as_lentry carries the weak bit, the GC marks a
// weak slot's closure only when it is strong, and as_closure.is_method (set for the
// __bound thunks that materialise method values) downgrades weak to strong.
//
// Compile: as-aot examples/weak-listener.as --run
import flash.events.Event;
import flash.events.EventDispatcher;
import flash.display.Sprite;
import flash.system.System;

var log:Array = [];
var defecit:Array = [];

function rec(s:String):void { log.push(s); }
function reset():void { log = []; }
function check(label:String, got:String, want:String):void {
  if (got != want) defecit.push("FAIL " + label + ": got [" + got + "] want [" + want + "]");
  else trace("ok   " + label + " = [" + got + "]");
}

class Holder extends Sprite {
  public function onEv(e:Event):void { rec("method"); }
}

// Churn the C stack so a returned frame cannot keep the probe closure alive through
// the conservative stack scan; AIR has no such scan, but we do.
function churn():void {
  var junk:Array = [];
  for (var i:int = 0; i < 64; i++) junk.push("pad-" + i + "-" + (i * 7919));
  if (junk.length < 0) trace("never");
}

// --- A: weak + nested closure -> collected, handler never runs -------------
//
// -O2 inlines regWeakAnon into main(), so the closure's spilled pointer slots land
// in main()'s own frame; a separate churn() call has its frame below main() and
// cannot reach them, which is why case A scrubs inline (in main()'s frame) below.
// The string concat temporaries overwrite those dead slots so the conservative
// stack scan (gc_mark_stack) does not falsely pin the weak closure. AIR's GC is
// exact and needs no scrub.
function regWeakAnon(d:EventDispatcher):void {
  d.addEventListener("e", function (ev:Event):void { rec("weak-anon"); }, false, 0, true);
}
var dA:EventDispatcher = new EventDispatcher();
regWeakAnon(dA);
for (var sa:int = 0; sa < 64; sa++) log.push("scrub-" + sa + "-" + (sa * 7919));
System.gc();
reset();
dA.dispatchEvent(new Event("e"));
check("A weak nested closure is collected", log.join(","), "");

// --- B: weak + a strong reference elsewhere -> still runs ------------------
function regWeakHeld(d:EventDispatcher):Function {
  var keep:Function = function (ev:Event):void { rec("weak-held"); };
  d.addEventListener("e", keep, false, 0, true);
  return keep;
}
var dB:EventDispatcher = new EventDispatcher();
var keepB:Function = regWeakHeld(dB);
churn();
System.gc();
reset();
dB.dispatchEvent(new Event("e"));
check("B weak with strong ref still runs", log.join(","), "weak-held");

// --- C: weak + obj.method -> AIR never collects it, so it keeps running ----
function regWeakMethod(d:EventDispatcher):void {
  var h:Holder = new Holder();
  d.addEventListener("e", h.onEv, false, 0, true);
}
var dC:EventDispatcher = new EventDispatcher();
regWeakMethod(dC);
churn();
System.gc();
reset();
dC.dispatchEvent(new Event("e"));
check("C weak method value still runs", log.join(","), "method");

// --- D: strong + nested closure -> still runs -----------------------------
function regStrongAnon(d:EventDispatcher):void {
  d.addEventListener("e", function (ev:Event):void { rec("strong-anon"); }, false, 0, false);
}
var dD:EventDispatcher = new EventDispatcher();
regStrongAnon(dD);
churn();
System.gc();
reset();
dD.dispatchEvent(new Event("e"));
check("D strong nested closure still runs", log.join(","), "strong-anon");

// --- E: removeEventListener detaches a weak registration -------------------
function regWeakForRemove(d:EventDispatcher):Function {
  var keep:Function = function (ev:Event):void { rec("weak-removed"); };
  d.addEventListener("e", keep, false, 0, true);
  return keep;
}
var dE:EventDispatcher = new EventDispatcher();
var keepE:Function = regWeakForRemove(dE);
dE.removeEventListener("e", keepE);
churn();
System.gc();
reset();
dE.dispatchEvent(new Event("e"));
check("E weak registration removed", log.join(","), "");

// --- F: a batch of weak closures dies, the dispatcher itself survives -----
//
// One of them may survive: our collector marks from a CONSERVATIVE C stack scan
// (docs: the root set is exact for the object graph but not for raw stack words),
// so a returned frame that still holds a stale closure pointer keeps that closure
// alive. AIR has an exact GC and would drop it. The contract we can hold is "at
// most one stray from this frame", which still proves the weak slots stopped
// pinning the whole batch.
function regWeakOne(d:EventDispatcher, t:String):void {
  d.addEventListener(t, function (ev:Event):void { rec("batch"); }, false, 0, true);
}
var dF:EventDispatcher = new EventDispatcher();
// One dispatcher-level listener that must survive the collection (strong).
dF.addEventListener("keep", function (ev:Event):void { rec("keep"); }, false, 0, false);
for (var fb:int = 0; fb < 40; fb++) regWeakOne(dF, "batch" + fb);
churn();
System.gc();
churn();
System.gc();
reset();
dF.dispatchEvent(new Event("keep"));
var fired:int = log.length;
reset();
for (var fq:int = 0; fq < 40; fq++) dF.dispatchEvent(new Event("batch" + fq));
check("F strong survives, weak batch released", fired + ":" + (log.length <= 1), "1:true");

// --- G: a slot the collector closed stays closed on every later dispatch ---
// batch0 was never reconstructed, so once it is closed it must stay silent.
reset();
for (var g:int = 0; g < 3; g++) {
  System.gc();
  dF.dispatchEvent(new Event("batch0"));
}
check("G closed weak slot stays silent", log.join(","), "");

// --- H: a weak registration of a STATIC method still runs ----------------
//
// This is the shape that broke the real app: TweenLite does
//   addEventListener(Event.ENTER_FRAME, updateAll, false, 0, true)
// where updateAll is a static method of the same class. AIR never collects a
// class-level member function, so the tween engine keeps ticking; treating that
// closure as weakly-held collected it on the first GC and every Tween -- and with
// them the whole UI refresh -- stopped.
class StaticDriver {
  public static var hits:int = 0;
  public static function onTick(e:Event):void { hits++; }
  public static function install(d:EventDispatcher):void {
    d.addEventListener("e", onTick, false, 0, true);   // bare name, same class
  }
}
var dH:EventDispatcher = new EventDispatcher();
StaticDriver.install(dH);
churn();
System.gc();
StaticDriver.hits = 0;
dH.dispatchEvent(new Event("e"));
check("H weak static method (bare name) still runs", String(StaticDriver.hits), "1");

// --- I: the dotted spelling of the same thing ----------------------------
var dI:EventDispatcher = new EventDispatcher();
dI.addEventListener("e", StaticDriver.onTick, false, 0, true);
churn();
System.gc();
StaticDriver.hits = 0;
dI.dispatchEvent(new Event("e"));
check("I weak static method (Class.name) still runs", String(StaticDriver.hits), "1");

// --- J: a module-level free function registered weakly still runs --------
// AIR holds top-level functions through the global object, so they are not
// collectable either; only nested inner functions are.
function freeHandler(e:Event):void { rec("free"); }
var dJ:EventDispatcher = new EventDispatcher();
dJ.addEventListener("e", freeHandler, false, 0, true);
churn();
System.gc();
reset();
dJ.dispatchEvent(new Event("e"));
check("J weak module-level function still runs", log.join(","), "free");

if (defecit.length > 0) throw new Error(defecit.join("\n"));
trace("weak_listener: all assertions passed");