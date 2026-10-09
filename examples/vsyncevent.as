// stage 129: flash.events.VsyncStateChangeAvailabilityEvent — AIR's event class
// plus our opt-in `refreshRate` extension — and Stage.vsyncEnabled.
//
// AIR exposes NO refresh-rate query anywhere: on mxmlc/adl 51.4.1 `Stage.refreshRate`,
// `Stage3D.refreshRate`, `Screen.refreshRate` and `Stage.vsyncStateChangeAvailability`
// are all "undefined", and the event's only own AIR property is the read-only
// `available:Boolean`. We keep `available` intact and add `refreshRate:Number` so a
// portable app can match `stage.frameRate` to the display it is actually on.
//
// This example is offscreen (no window backend), so the startup/on-change DISPATCH is
// covered by the windowed harness (temp/vsyncprobe) and the unit group; here we pin the
// API shape: the AIR constant string, the ctor (AIR's 4 args + our 5th), and the
// vsyncEnabled round-trip.
import flash.display.Stage;
import flash.events.Event;
import flash.events.VsyncStateChangeAvailabilityEvent;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function same(a:Number, b:Number, msg:String):void { if (a != b) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")"); }

var stage:Stage = new Stage();

// AIR's constant string (measured on adl 51.4.1: lowercase leading 'v').
var CONST:String = VsyncStateChangeAvailabilityEvent.VSYNC_STATE_CHANGE_AVAILABILITY;
trace("const", CONST);
check(CONST == "vSyncStateChangeAvailability", "constant string");

// AIR ctor: (type:String, bubbles=false, cancelable=false, available=false).
var e1:VsyncStateChangeAvailabilityEvent = new VsyncStateChangeAvailabilityEvent("t");
check(e1.type == "t", "type");
check(e1.bubbles == false && e1.cancelable == false, "default bubbles/cancelable");
check(e1.available == false, "default available");
same(e1.refreshRate, 0, "default refreshRate");

var e2:VsyncStateChangeAvailabilityEvent = new VsyncStateChangeAvailabilityEvent("t", true, true, true);
check(e2.bubbles == true && e2.cancelable == true && e2.available == true, "4-arg ctor");

// Our added 5th argument carries the real display refresh rate (Hz).
var e3:VsyncStateChangeAvailabilityEvent = new VsyncStateChangeAvailabilityEvent(CONST, false, false, false, 60);
check(e3.type == CONST, "ctor type from constant");
same(e3.refreshRate, 60, "refreshRate via ctor");
check(e3.available == false, "available stays false");

// It is a real Event subclass, so an Event-typed slot accepts it.
var ev:Event = e3;
check(ev is VsyncStateChangeAvailabilityEvent, "is VsyncStateChangeAvailabilityEvent");
check(ev is Event, "is Event");

// Stage.vsyncEnabled: AIR default true, writable.
check(stage.vsyncEnabled == true, "vsyncEnabled default true");
stage.vsyncEnabled = false;
check(stage.vsyncEnabled == false, "vsyncEnabled set false");
stage.vsyncEnabled = true;
check(stage.vsyncEnabled == true, "vsyncEnabled set true");

trace("vsyncevent OK");