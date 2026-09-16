// stage57.as — precise GC (mark-sweep) leak check (v0.3.58).
//
// Allocate a large burst of transient record+array objects, then force a
// collection. Every iteration overwrites 'o', so all but the last become
// unreachable. totalMemory must NOT grow linearly with the iteration count —
// System.gc() must sweep the garbage back down toward the baseline.

// Prime the heap and take a baseline after a full collection.
var keep:Object = { marker: 1 };
System.gc();
var base:Number = System.totalMemoryNumber;

// 50000 transient objects; each is unreachable once the next iteration overwrites
// the module-level 'o' slot (the only root referencing them).
for (var i:int = 0; i < 50000; i++) {
  var o:Object = { x: i, arr: [i, i + 1, i + 2] };
}
var afterAlloc:Number = System.totalMemoryNumber;

// Force collection; the 49999 overwritten objects must be swept.
System.gc();
var afterGC:Number = System.totalMemoryNumber;

trace("burst allocated:", afterAlloc > base);
trace("gc reclaimed most:", afterGC < afterAlloc * 0.5);
trace("gc bounded:", afterGC < base + 4000000);
