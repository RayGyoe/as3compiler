// gc_barrier.as — GC-4 direct field-write barrier stress: concrete-class fields
// (string + object) written across frames must survive incremental marking
// without dangling pointers.
class Box {
  public var tag:String;
  public var child:Box;
  public function Box(t:String) { this.tag = t; this.child = null; }
}

var stage:Stage = new Stage();
var roots:Array = [];
var n:int = 0;

function onFrame(e:Event):void {
  var head:Box = new Box("box" + n);
  var cur:Box = head;
  for (var i:int = 0; i < 50; i++) {
    cur.child = new Box("box" + n + "_" + i);   // direct field write (barrier)
    cur = cur.child;
  }
  roots.push(head);
  n++;
}

stage.addEventListener(Event.ENTER_FRAME, onFrame);
for (var f:int = 0; f < 200; f++) stage.dispatchFrame();

System.gc();
var count:int = 0;
for (var k:int = 0; k < roots.length; k++) {
  var b:Box = roots[k];
  while (b != null) { count++; b = b.child; }
}
trace("chains=", roots.length, "nodes=", count, "expected=", 200 * 51);
trace("intact=", count == 200 * 51);
