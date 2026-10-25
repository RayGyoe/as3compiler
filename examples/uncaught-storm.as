// uncaught-storm.as — a repeating uncaught error must not flood the log, and must
// not lose its count either.
//
// The runtime recovers from an uncaught error at the frame boundary, exactly as AIR
// does (an error thrown inside an ENTER_FRAME handler does not terminate the
// player). That makes a null-receiver bug inside a frame handler repeat once per
// frame instead of crashing once — measured on a real AOT app: 623 identical
// "#1009" lines in 40 s, which pushed every other diagnostic out of the log window
// and buried the crash that followed.
//
// The throttle keeps the first occurrence of a message in full, folds repeats of
// the SAME message, and prints the folded count — so a storm is still visible as a
// number. Silence is never the answer (AGENTS.md §1.5): the count is replayed every
// 20 folded repeats and whatever is pending is printed at exit.
//
// 50 frames are dispatched here, i.e. 50 throws inside one second, which is the
// case the exit-flush exists for.
var stage:Stage = new Stage();
var bad:Object = null;
var frames:int = 0;

function onFrame(e:Event):void {
    frames++;
    bad.anything = 1;   // null receiver -> TypeError #1009, every frame
}

stage.addEventListener(Event.ENTER_FRAME, onFrame);
for (var i:int = 0; i < 50; i++) stage.dispatchFrame();

// Throttling changes reporting, never control flow: every frame must still have
// run, and each one must still have thrown.
if (frames != 50) throw new Error("expected 50 frames, got " + frames);
trace("uncaught-storm: 50 throws, reporting folded");