// A refused allocation must raise Error #1000 and stay catchable -- never fault.
//
// The stage-二百七十八 crash dumps show the old behaviour: gc_alloc carved a segment,
// malloc() returned NULL (a 32-bit process ran out of address space while a 3.6 MB
// BitmapData buffer was being cached), and the very next statement wrote through
// the null base -- exe+0x699e, movl edi,0xc(eax) with eax == 0. AIR answers the
// same situation with a catchable Error #1000 (kOutOfMemoryError), so this unit
// pins exactly that: the raise, the id, the message, and a live process after it.
//
// ASC_FORCE_OOM_MIN is set for this unit by test/examples.ts, which makes any
// segment carve of 4 MB or more fail on purpose: the real 32-bit exhaustion cannot
// be reproduced on a 64-bit CI runner, and a test that only runs on the machine
// that crashed is not a regression test. Without the variable the allocation
// simply succeeds and the example takes the other branch.

var caught:Boolean = false;
var id:int = 0;
var msg:String = "";
try {
    var bytes:ByteArray = new ByteArray();
    bytes.length = 8 * 1024 * 1024;   // well above every small-allocation path
    bytes.length = 0;
} catch (e:Error) {
    caught = true;
    id = e.errorID;
    msg = e.message;
}
if (!caught) {
    trace("allocated 8 MB (no forced refusal)");
} else {
    trace("caught #" + id + ": " + msg);
    if (id != 1000) throw new Error("expected Error #1000, got #" + id);
    if (msg != "Error #1000: The system is out of memory.") throw new Error("unexpected message: " + msg);
}
trace("still running");
