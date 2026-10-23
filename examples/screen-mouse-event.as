// 阶段二百五十八: flash.events.ScreenMouseEvent -- AIR's mouse event that also
// carries the pointer position in SCREEN space.
//
// Every assertion below was measured on adl 51.4.1 / macOS (temp/smeprobe/):
//   * the 11-argument constructor, in AIR's own order -- buttonDown sits BETWEEN
//     shiftKey and commandKey, and localX/localY are not parameters at all;
//   * screenX/screenY default to NaN and are READ-ONLY (the write is rejected at
//     compile time here, and dynamically with ReferenceError #1074);
//   * clone() returns a ScreenMouseEvent carrying the ctor-level fields only, and
//     toString() prints AIR's own shape (quoted type, no eventPhase).
//
// On this backend nothing DISPATCHES it: AIR only emits ScreenMouseEvent from
// SystemTrayIcon, which macOS does not provide (supportsSystemTrayIcon=false), and
// real stage mouse events are plain MouseEvent (measured `is ScreenMouseEvent` is
// false for mouseMove/mouseDown/mouseUp/click). Instances therefore only ever come
// from user code, like TouchEvent.
import flash.events.Event;
import flash.events.ScreenMouseEvent;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function same(a:Number, b:Number, msg:String):void { if (a != b) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")"); }
function sameStr(a:String, b:String, msg:String):void { if (a != b) throw new Error("FAIL: " + msg + " (got " + a + ", want " + b + ")"); }

// ---- defaults ----
var d:ScreenMouseEvent = new ScreenMouseEvent("x");
sameStr(d.type, "x", "type");
check(d.bubbles == false && d.cancelable == false, "default bubbles/cancelable");
check(isNaN(d.screenX) && isNaN(d.screenY), "screenX/screenY default to NaN");
// Measured: a plain MouseEvent leaves localX/localY NaN, while ScreenMouseEvent
// hands 0 to the base.
same(d.localX, 0, "localX default");
same(d.localY, 0, "localY default");
same(d.stageX, 0, "stageX default");
check(d.buttonDown == false && d.ctrlKey == false && d.altKey == false, "modifier defaults");
check(d.shiftKey == false && d.commandKey == false && d.controlKey == false, "modifier defaults (2)");

// ---- the 11-argument constructor, positional ----
var e:ScreenMouseEvent = new ScreenMouseEvent("t", true, true, 11, 22, true, false, true, true, false, true);
same(e.screenX, 11, "4th argument is screenX");
same(e.screenY, 22, "5th argument is screenY");
check(e.ctrlKey == true && e.altKey == false && e.shiftKey == true, "ctrlKey/altKey/shiftKey at 6..8");
// AIR's order is (… shiftKey, buttonDown, commandKey, controlKey): one-hot probing
// turned argument 9 into buttonDown and 10/11 into commandKey/controlKey.
check(e.buttonDown == true, "9th argument is buttonDown");
check(e.commandKey == false && e.controlKey == true, "10th/11th are commandKey/controlKey");

// A non-Boolean value in a Boolean parameter coerces by TRUTHINESS, as in AIR
// (measured: passing 33/44 in the modifier slots yields true/true).
var one:int = 1;
var zero:int = 0;
var t:ScreenMouseEvent = new ScreenMouseEvent("t", false, false, 1, 2, one, zero, true, false, false, false);
check(t.ctrlKey == true && t.altKey == false && t.shiftKey == true, "Boolean parameters coerce");

// ---- constants (read at runtime on adl) ----
sameStr(ScreenMouseEvent.CLICK, "click", "CLICK");
sameStr(ScreenMouseEvent.RIGHT_CLICK, "rightClick", "RIGHT_CLICK");
sameStr(ScreenMouseEvent.MOUSE_DOWN, "mouseDown", "MOUSE_DOWN");
sameStr(ScreenMouseEvent.MOUSE_UP, "mouseUp", "MOUSE_UP");
sameStr(ScreenMouseEvent.RIGHT_MOUSE_DOWN, "rightMouseDown", "RIGHT_MOUSE_DOWN");
sameStr(ScreenMouseEvent.RIGHT_MOUSE_UP, "rightMouseUp", "RIGHT_MOUSE_UP");

// ---- clone(): ctor-level state only ----
e.localX = 5;
e.localY = 6;
e.delta = 3;
var cl:ScreenMouseEvent = e.clone() as ScreenMouseEvent;
check(cl !== e, "clone is a new object");
same(cl.screenX, 11, "clone keeps screenX");
same(cl.screenY, 22, "clone keeps screenY");
same(cl.localX, 0, "clone RESETS localX (measured)");
same(cl.localY, 0, "clone RESETS localY (measured)");
same(cl.delta, 0, "clone RESETS delta (measured)");
check(cl.buttonDown == true && cl.commandKey == false && cl.controlKey == true, "clone keeps the flags");

// An Event-typed clone is still a ScreenMouseEvent (vtable slot, not a static call).
var asEvent:Event = e;
var cl2:Event = asEvent.clone();
check(cl2 is ScreenMouseEvent, "clone through Event keeps the runtime type");
check(cl2 is Event, "clone is an Event");

// ---- toString(): AIR's shape, no eventPhase ----
var s:String = new ScreenMouseEvent("t", true, true, 11, 22, true, false, true, true, false, true).toString();
sameStr(s, "[ScreenMouseEvent type=\"t\" bubbles=true cancelable=true screenX=11 screenY=22 ctrlKey=true altKey=false shiftKey=true buttonDown=true commandKey=false controlKey=true]", "toString");
var s2:String = d.toString();
sameStr(s2, "[ScreenMouseEvent type=\"x\" bubbles=false cancelable=false screenX=NaN screenY=NaN ctrlKey=false altKey=false shiftKey=false buttonDown=false commandKey=false controlKey=false]", "toString NaN form");

// ---- type relation ----
check(d is Event, "is Event");
sameStr(d.toString().substr(1, 17), "ScreenMouseEvent ", "qualified name in toString");

trace("screen-mouse-event OK");