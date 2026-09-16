// stage52.as — flash.system.System memory stats (v0.3.53).

// totalMemory (uint): runtime-managed heap in bytes, clamps to 0 above 4 GiB.
var t0:uint = System.totalMemory;
// totalMemoryNumber (Number): same quantity, no clamp.
var tn:Number = System.totalMemoryNumber;
// freeMemory (Number): arena requested-but-unused slack, always >= 0.
var fm:Number = System.freeMemory;
// privateMemory (Number): real OS process resident size, > 0 on native.
var pm:Number = System.privateMemory;

trace("totalMemory >= 0:", t0 >= 0);
trace("totalMemoryNumber >= totalMemory:", tn >= Number(t0));
trace("freeMemory >= 0:", fm >= 0);
trace("privateMemory > 0:", pm > 0);
