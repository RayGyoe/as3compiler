// Regression for the segment-release accounting (stage eighty-nine, second
// benchmark run SIGSEGV).
//
// gc_release_empty_segs hands a segment back to the OS when free_bytes == size,
// i.e. "every byte of this segment sits on a free list". That test is only a
// proof of emptiness while the counter is exact, and it was not: when a free
// block was handed out without being split -- the leftover was smaller than
// GC_MIN_BLOCK -- the allocator charged the *requested* size while the block
// kept its larger size, so free_bytes crept above the segment's true free
// space. Once those phantom bytes equal the live footprint, a segment full of
// live objects is freed, malloc reuses the chunk, and every pointer into it
// becomes garbage (Starling's MeshStyle vtable word and gc_all itself were both
// later seen holding the double 0.9872449040412903, the benchmark's
// _container.scale).
//
// The pattern below is exactly that case: a string's payload block is freed,
// then reused by a request a few bytes smaller. String payloads go through
// gc_alloc like every other GC object (as_str_alloc -> gc_alloc(GCT_STRING)),
// so the block sizes are directly controllable, and the loop keeps live objects
// alive in those same segments while the churn happens.
//
// test.ts runs this with ASC_GC_AUDIT_STRICT=1: the runtime re-derives every
// segment's footprint from the object list before each release pass and aborts
// on any disagreement, so the loop either prints gc-reap-ok or dies.

// A string of exactly n characters: its payload block is n + 1 bytes.
function payload(n:int):String {
  var s:String = "x";
  while (s.length < n) s += "x";
  return s;
}

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// Live canaries, kept reachable across every collection below.
var canary:Array = [];
for (var c:int = 0; c < 8; c++) canary.push(payload(300 + c * 37));

var checksum:int = 0;
for (var i:int = 0; i < 400; i++) {
  // 1. Allocate a block of payload p, then drop it.
  var p:int = 1500 + (i % 24);
  var a:String = payload(p - 1);
  checksum += a.length;
  a = null;

  // 2. Sweep it: a stop-the-world collect credits the block back to its segment
  //    and leaves it on a free list.
  System.gc();

  // 3. Take it back with a request 4 bytes smaller -- the leftover is below
  //    GC_MIN_BLOCK, so the split is skipped and the block keeps its size: the
  //    phantom-free-space case.
  var b:String = payload(p - 5);
  checksum += b.length;
  b = null;
  System.gc();
}

// The canaries must be intact. Under the bug their segments could be released
// while they were still live, and malloc then owns the memory their characters
// sit in.
var ok:Boolean = true;
for (var k:int = 0; k < canary.length; k++) {
  var s:String = canary[k] as String;
  if (s.length != 300 + k * 37) ok = false;
  for (var j:int = 0; j < s.length; j++) if (s.charCodeAt(j) != 120) ok = false;
}
trace("checksum=" + checksum + " canary=" + (ok ? "ok" : "CORRUPT"));
check(ok, "live canary strings survived the collection churn");
trace("gc-reap-ok");