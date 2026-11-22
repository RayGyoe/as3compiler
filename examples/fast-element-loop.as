// Stage 451 (#65): loop-versioned raw element access. A qualified numeric
// element loop runs a one-time pure pre-check, then a fast branch (C-local
// induction + hoisted data pointers, vectorized by -O2) while the slow branch
// keeps every per-element #1125/#1009 guard. This program pins the OBSERVABLE
// semantics of both branches: identical results, identical error timing, and
// the AS3 loop var still visible (function-scoped) after the loop.
function assert(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const N:int = 1000;

// Vector.<Number>: fill (write-only) + compute (read/write) fast paths.
var a:Vector.<Number> = new Vector.<Number>(N, true);
var b:Vector.<Number> = new Vector.<Number>(N, true);
var c:Vector.<Number> = new Vector.<Number>(N, true);
for (var i:int = 0; i < N; i++) { a[i] = i * 0.5; b[i] = i * 0.25; }
for (var j:int = 0; j < N; j++) c[j] = a[j] + b[j] * 1.5;
assert(c[N - 1] == (N - 1) * 0.5 + (N - 1) * 0.25 * 1.5, "vector number compute");
assert(j == N, "loop var visible after loop (function-scoped)");

// Vector.<int>: int fast path.
var ia:Vector.<int> = new Vector.<int>(N, true);
var ib:Vector.<int> = new Vector.<int>(N, true);
var ic:Vector.<int> = new Vector.<int>(N, true);
for (i = 0; i < N; i++) { ia[i] = i; ib[i] = i * 3; }
for (j = 0; j < N; j++) ic[j] = ia[j] + ib[j];
assert(ic[N - 1] == (N - 1) * 4, "vector int compute");

// Array numeric read (all-num pre-scan passes) + write-only fill.
var aa:Array = new Array(N);
var ba:Array = new Array(N);
for (i = 0; i < N; i++) { aa[i] = i * 0.5; ba[i] = i * 0.25; }
var ca:Array = new Array(N);
for (j = 0; j < N; j++) ca[j] = aa[j] + ba[j];
assert(ca[N - 1] == (N - 1) * 0.75, "array numeric compute");
var s:Number = 0;
for (j = 0; j < N; j++) s += aa[j];
assert(s == (N - 1) * N * 0.25, "array numeric read sum");

// Mixed Array (a null element): the all-num pre-scan fails at runtime, so the
// guarded slow branch runs and null coerces to 0 exactly as AIR.
var mixed:Array = [1, 2, null];
var ms:Number = 0;
for (j = 0; j < 3; j++) ms += mixed[j];
assert(ms == 3, "mixed array slow path coerces null to 0");

// Out-of-bounds on a fixed Vector: pre-check fails (bound > length), the slow
// branch throws RangeError #1125 at the first offending index.
var threw:int = 0;
try {
  for (j = 0; j < N + 50; j++) c[j] = j;
} catch (e:RangeError) {
  threw = e.errorID;
}
assert(threw == 1125, "fixed vector OOB still throws #1125");
assert(c[N - 1] == N - 1, "partial writes before the throw are kept");

// Negative start: the (start >= 0) gate fails, slow branch throws #1125 at the
// negative index rather than silently reading out of bounds.
threw = 0;
try {
  for (var k:int = -2; k < 3; k++) a[k] = k;
} catch (e2:RangeError) {
  threw = e2.errorID;
}
assert(threw == 1125, "negative index still throws #1125");

trace("OK fast-element-loop");