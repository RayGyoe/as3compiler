// wheel.as — mouse-wheel scrolling semantics (stage 45).
//
// Stage.dispatchWheel(x, y, delta) is the native-backend hook the SDL2 event loop
// calls for every wheel notch; it both auto-scrolls the TextField under the
// pointer and dispatches a bubbling MouseEvent.MOUSE_WHEEL. Both halves are
// asserted here so the behaviour is pinned in the pure-C regression run (no
// window needed) as well as in a real window.
//
// Semantics measured against the Adobe AIR launcher (adl):
//   * one delta unit moves exactly one line;
//   * scrollV DECREASES as the wheel turns up (scrollV -= delta);
//   * scrollV is clamped to [1, maxScrollV].
//
// Note: the listener is a *named top-level function*, not a closure — this
// subset's lambdas capture their free variables by value, so a closure could
// not report back through these globals.

var stage:Stage = new Stage();

var gotCount:int = 0;
var gotDelta:Number = 0;
var gotTarget:Object = null;

function onWheel(e:MouseEvent):void {
  gotCount++;
  gotDelta = e.delta;
  gotTarget = e.target;
}

var tf:TextField = new TextField();
tf.multiline = true;
tf.wordWrap = false;
tf.defaultTextFormat = new TextFormat(null, 12, 0x000000, false, false);
tf.width = 200;
tf.height = 60;                       // 4 visible lines at 14.4 line height
tf.text = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
tf.addEventListener(MouseEvent.MOUSE_WHEEL, onWheel);
stage.addChild(tf);

if (tf.maxScrollV != 7) throw new Error("expected maxScrollV 7, got " + tf.maxScrollV);

// --- auto-scroll: one delta unit == one line ---------------------------------
tf.scrollV = tf.maxScrollV;           // 7, the log-tailing position
stage.dispatchWheel(50, 30, 1);       // wheel up one notch
if (tf.scrollV != 6) throw new Error("one notch should move one line, scrollV=" + tf.scrollV);
if (gotCount != 1) throw new Error("mouseWheel listener should fire once, got " + gotCount);
if (gotDelta != 1) throw new Error("event.delta should be 1, got " + gotDelta);
if (gotTarget != tf) throw new Error("event.target should be the field");

stage.dispatchWheel(50, 30, 3);       // a larger notch moves more lines
if (tf.scrollV != 3) throw new Error("delta 3 should move three lines, scrollV=" + tf.scrollV);

stage.dispatchWheel(50, 30, -2);      // wheel down scrolls the other way
if (tf.scrollV != 5) throw new Error("negative delta should scroll down, scrollV=" + tf.scrollV);

// --- clamping to [1, maxScrollV] --------------------------------------------
stage.dispatchWheel(50, 30, 100);     // far past the top
if (tf.scrollV != 1) throw new Error("scrollV must clamp at 1, got " + tf.scrollV);
stage.dispatchWheel(50, 30, -100);    // far past the bottom
if (tf.scrollV != 7) throw new Error("scrollV must clamp at maxScrollV, got " + tf.scrollV);

// --- a miss does nothing -----------------------------------------------------
var before:int = tf.scrollV;
stage.dispatchWheel(500, 500, 1);     // outside the field
if (tf.scrollV != before) throw new Error("wheel outside the field must not scroll");
if (gotCount != 5) throw new Error("a miss must not dispatch, got " + gotCount);

trace("wheel: all assertions passed");
