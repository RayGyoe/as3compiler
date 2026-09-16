// gc_incremental.as — GC-4 incremental marking leak check (bounded heap).
var stage:Stage = new Stage();
var total:int = 0;
function onFrame(e:Event):void {
  // ~250 GC objects/frame (record + array + value-array each), below the
  // per-frame sweep budget so the incremental collector can keep pace.
  for (var i:int = 0; i < 50; i++) {
    var o:Object = { x: i, arr: [i, i + 1] };
    total += 1;
  }
}
stage.addEventListener(Event.ENTER_FRAME, onFrame);
System.gc();
var base:Number = System.totalMemoryNumber;
for (var f:int = 0; f < 400; f++) stage.dispatchFrame();
var mid:Number = System.totalMemoryNumber;
for (var f2:int = 0; f2 < 400; f2++) stage.dispatchFrame();
var late:Number = System.totalMemoryNumber;
System.gc();
var after:Number = System.totalMemoryNumber;
trace("total=", total, "base=", base, "mid=", mid, "late=", late, "after=", after);
trace("bounded=", late < 4000000, "reclaimed=", after < 10000);
