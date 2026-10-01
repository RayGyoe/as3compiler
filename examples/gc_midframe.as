// gc_midframe.as — System.gc() called from *inside* a live frame.
//
// System.gc() is AS3's explicit collection point, and Starling's demo calls it
// while AS3 frames are still on the C stack (Game.showMainMenu -> System.gc()).
// At that moment the objects those frames work with live ONLY in C locals: the
// in-flight Event that EventDispatcher holds while dispatching it, and the
// caller's own locals. Frames are registered nowhere (there is no shadow stack,
// and the frame-boundary safe point never runs mid-frame), so a plain
// stop-the-world collection swept them. In the demo the pooled Starling Event
// was freed, pushed back into Event.sEventPool, and the next pop() read a
// garbage vtable (`_event->vtable->reset(...)`, pc = 0 -> EXC_BAD_ACCESS:
// "enter Sprite 3D, hit Back, crash").
//
// This example pins that semantics down: a listener collects mid-dispatch,
// churns the heap so any freed block is reused before it is read again, then
// re-reads the event it is receiving; the caller afterwards checks its own
// locals (the payload) survived. Both only hold if gc_mark_roots() also scans
// the live C stack conservatively.
class Payload {
  public var tag:String;
  public var nums:Array;
  public function Payload(t:String) { this.tag = t; this.nums = []; }
}

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var dispatcher:EventDispatcher = new EventDispatcher();
var delivered:int = 0;   // listener invocations (also the current round number)
var bad:int = 0;         // invocations that could not re-read the in-flight event
var gcRuns:int = 0;

function onPing(e:Event):void {
  System.gc();           // full stop-the-world collection, mid-dispatch
  gcRuns++;
  // Churn the heap while the in-flight event is still needed, so a freed block
  // gets reused before it is read again (the demo did the same by pushing the
  // freed event back into the pool).
  var junk:Array = [];
  for (var i:int = 0; i < 64; i++) junk.push({ n: i, s: "junk" + i });
  // `e` reached this function as an argument only: it is referenced by a C local
  // and by nothing the collector knows about, so it must be found on the stack.
  if (e.type != "ping") bad++;
  delivered++;
  junk = null;
}

dispatcher.addEventListener("ping", onPing);

var rounds:int = 200;
for (var round:int = 0; round < rounds; round++) {
  var p:Payload = new Payload("p" + round);
  for (var k:int = 0; k < 100; k++) p.nums.push(k);
  var ev:Event = new Event("ping");
  dispatcher.dispatchEvent(ev);
  // `ev` and `p` are referenced only by this frame's locals while the collection
  // above ran: they must still be the same intact objects afterwards.
  check(ev.type == "ping", "dispatched event survived mid-frame gc (round " + round + ")");
  check(p.tag == "p" + round, "payload tag survived mid-frame gc (round " + round + ")");
  check(p.nums.length == 100 && p.nums[99] == 99, "payload contents survived mid-frame gc (round " + round + ")");
}

trace("rounds=", delivered, "bad=", bad, "gcRuns=", gcRuns);
check(gcRuns == rounds, "System.gc() ran once per dispatch");
check(delivered == rounds, "every dispatch was delivered");
check(bad == 0, "in-flight event readable after mid-frame System.gc() (bad=" + bad + ")");
trace("midframe-ok");