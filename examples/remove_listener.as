// remove_listener.as — removeEventListener semantics.
//
// Pins the fix that made removeEventListener actually detach a listener whose
// reference was created by a fresh bound-method thunk. AS3 removes by *function
// identity* (same implementation + same bound receiver), not by closure-pointer
// identity, so comparing `fn`+`env` is what makes `removeEventListener(type,
// this.handler)` work. A top-level named function is used here because this
// subset captures closure variables by value.
var stage:Stage = new Stage();
var gotCount:int = 0;

function onFrame(e:Event):void {
  gotCount++;
}

stage.addEventListener(Event.ENTER_FRAME, onFrame);
stage.dispatchFrame();
if (gotCount != 1) throw new Error("listener should fire before removal, got " + gotCount);

stage.removeEventListener(Event.ENTER_FRAME, onFrame);
stage.dispatchFrame();
if (gotCount != 1) throw new Error("listener should NOT fire after removal, got " + gotCount);

// hasEventListener must also reflect the removal.
if (stage.hasEventListener(Event.ENTER_FRAME)) {
  throw new Error("hasEventListener should be false after removal");
}

// A bound method listener (this.handler) must be removable by the same spelling.
// Because each `this.method` reference allocates a fresh thunk, this exercises
// the fn+env identity comparison directly. This mirrors Main.as's
// `removeEventListener(Event.ADDED_TO_STAGE, onAddedToStage)`.
class Listener extends Sprite {
  public var count:int = 0;
  public function Listener() { addEventListener(Event.ENTER_FRAME, bump); }
  public function bump(e:Event):void { this.count++; }
  public function detach():void { removeEventListener(Event.ENTER_FRAME, bump); }
}

var obj:Listener = new Listener();
obj.dispatchEvent(new Event(Event.ENTER_FRAME));
if (obj.count != 1) throw new Error("bound method should fire before removal, got " + obj.count);

obj.detach();
obj.dispatchEvent(new Event(Event.ENTER_FRAME));
if (obj.count != 1) throw new Error("bound method should NOT fire after removal, got " + obj.count);

trace("remove_listener: all assertions passed");
