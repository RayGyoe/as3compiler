// frame.as — ENTER_FRAME broadcast semantics (stage 46).
//
// Stage.dispatchFrame() is the native-backend hook the SDL2 event loop calls
// once per rendered frame; it broadcasts ENTER_FRAME to every display object
// with a listener (depth-first, non-bubbling). Pinned here so the broadcast
// logic is covered by the pure-C regression run (no window needed).
var stage:Stage = new Stage();
var gotCount:int = 0;

function onFrame(e:Event):void {
  gotCount++;
}

stage.addEventListener(Event.ENTER_FRAME, onFrame);
stage.dispatchFrame();

if (gotCount != 1) throw new Error("enterFrame listener should fire once, got " + gotCount);

// A child object with its own listener is broadcast to as well.
var sp:Sprite = new Sprite();
var childCount:int = 0;
function onChildFrame(e:Event):void {
  childCount++;
}
sp.addEventListener(Event.ENTER_FRAME, onChildFrame);
stage.addChild(sp);

stage.dispatchFrame();
if (gotCount != 2) throw new Error("stage enterFrame should fire again, got " + gotCount);
if (childCount != 1) throw new Error("child enterFrame should fire, got " + childCount);

// A grandchild is reached depth-first through the child container.
var grand:Sprite = new Sprite();
var grandCount:int = 0;
function onGrandFrame(e:Event):void {
  grandCount++;
}
grand.addEventListener(Event.ENTER_FRAME, onGrandFrame);
sp.addChild(grand);

stage.dispatchFrame();
if (grandCount != 1) throw new Error("grandchild enterFrame should fire, got " + grandCount);

trace("frame: all assertions passed");
