// gc_strings.as — GC-2 string leak check (stage 57 sub-phase).
//
// High-frequency string concatenation must NOT grow totalMemory linearly. Each
// iteration overwrites the module-level 's' slot (the only root), so every prior
// string becomes unreachable. System.gc() must sweep the garbage strings back
// down toward the baseline — this is the ~0.55 KB/s arena leak from stage 56
// finally closed by moving strings onto the GC heap.

var s:String = "seed";
System.gc();
var base:Number = System.totalMemoryNumber;

// 100000 concatenations; each "+" builds an intermediate string, all discarded
// once the next iteration overwrites 's'.
for (var i:int = 0; i < 100000; i++) {
  s = "iteration-" + i + "-value-" + (i * 2);
}
var afterAlloc:Number = System.totalMemoryNumber;

// Force collection; the 99999 overwritten strings must be swept.
System.gc();
var afterGC:Number = System.totalMemoryNumber;

trace("burst allocated:", afterAlloc > base);
trace("gc reclaimed most:", afterGC < afterAlloc * 0.5);
trace("gc bounded:", afterGC < base + 4000000);
trace("final:", s);
