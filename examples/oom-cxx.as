// A refused C++ allocation must raise Error #1000 and stay catchable.
//
// This is the C++ face of the same 32-bit wall tests/.. the stage-二百八十 dumps
// show: an unsatisfied `operator new` threw std::bad_alloc, nothing in the
// generated C could catch it, and the exception reached std::terminate -> abort(),
// i.e. exit code 0xC0000409 with no AS3 error at all. vendor/skia_glue.cc now
// overrides the global operator new and hands the refusal to the runtime, which
// answers with a collection-and-retry or with AIR's catchable Error #1000
// (avmplus kOutOfMemoryError).
//
// ASC_FORCE_CXX_OOM makes the first C++ allocation after startup fail on purpose
// (test/examples.ts sets it for this unit): a 64-bit CI runner cannot exhaust its
// address space, and a test that only runs on the machine that crashed is not a
// regression test. The drawn rect is what forces the allocation -- every paint and
// path on the way to a bitmap is a C++ object.
//
// Without the variable the same code simply succeeds, so this example is also its
// own control: one branch asserts the raise, the other asserts the normal path.

var caught:Boolean = false;
var id:int = 0;
var msg:String = "";

try {
    var bd:BitmapData = new BitmapData(32, 32, false, 0x000000);
    var sh:Shape = new Shape();
    sh.graphics.beginFill(0xFF0000);
    sh.graphics.drawRect(0, 0, 32, 32);
    sh.graphics.endFill();
    bd.draw(sh);
    bd.dispose();
} catch (e:Error) {
    caught = true;
    id = e.errorID;
    msg = e.message;
}

if (!caught) {
    trace("drew 32x32 (no forced refusal)");
} else {
    trace("caught #" + id + ": " + msg);
    if (id != 1000) throw new Error("expected Error #1000, got #" + id);
    if (msg != "Error #1000: The system is out of memory.") throw new Error("unexpected message: " + msg);
}
trace("still running");