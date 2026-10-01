// gc_alloc_threshold.as — 非 GUI 目标的分配阈值自动回收（阶段八十九·四十一）。
//
// GC 的推进点原本只有一处：`Stage_dispatchFrame` 帧边界的 `gc_step()`（增量、
// 每帧固定预算），外加 `System.gc()` 手动停机回收。没有帧的程序（纯脚本、
// 服务端循环、WASI 运行……）永远走不到那一处，于是「分配了多少就长多少」：
// 本例的循环若没有自动回收，`totalMemory` 会随迭代次数线性上涨。
//
// 修法见 `src/runtime.ts`：`gc_step()` 首次被调用即标记「本程序是帧驱动的」
// （它是 Stage_dispatchFrame 的唯一调用者）；在**从未派发过帧**之前，`gc_alloc`
// 自己按分配阈值（`gc_trigger()`；离屏下限为 `GC_NONGUI_FLOOR` = 8 MiB，详见
// src/runtime.ts 中的论证）做一次停机回收。
// 两个方向都必要：没有这个标志，GUI 构建会丢掉 GC-4 的每帧有界停顿；没有这个
// 触发，离屏构建则永远不回收。
//
// 本例**全程不调用 `System.gc()`、不派发帧**：唯一的回收来源就是分配阈值。
// 断言分两类：
//   ① 回收确实发生了 —— 循环中/循环后的 `totalMemory` 有界（只降不涨的锯齿），
//      而不是随分配总量线性上涨；
//   ② 回收没有伤到活对象 —— 阈值触发发生在**任意调用深度**（`gc_alloc` 内部），
//      所以「活着的 AS3 局部变量」必须靠保守栈扫描保住：跨多次回收长期持有的
//      对象图在循环结束后逐项核对，循环中写入的值也必须读回一致。

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

class Node {
  public var id:int;
  public var tag:String;
  public var child:Node;
  public function Node(id:int, tag:String) {
    this.id = id;
    this.tag = tag;
  }
}

// 长期持有：这棵链表跨整个分配循环存活（若保守栈扫描漏了活局部，节点会被回收，
// 结尾的复查就会读到 null/垃圾）。
var keepHead:Node = null;
var keepTail:Node = null;
var keepCount:int = 0;
var keepSum:int = 0;
function keepAppend(id:int):void {
  var n:Node = new Node(id, "node-" + id);
  if (keepHead == null) keepHead = n; else keepTail.child = n;
  keepTail = n;
  keepCount++;
  keepSum += id;
}

// 一段「只产生垃圾」的分配：数组 + record + 字符串各来一点，返回最后一次分配
// 的字符串（供调用方核对内容没被回收机制破坏）。
function churn(round:int):String {
  var acc:String = "churn-" + round;
  var arr:Array = [];
  for (var i:int = 0; i < 20; i++) {
    var o:Object = { r: round, i: i, s: "s" + round + "-" + i };
    arr.push(o);
    acc = acc + "/" + o.s;
  }
  return acc + "/" + arr.length;
}

System.gc();
var base:Number = System.totalMemoryNumber;
var peak:Number = base;
var late:Number = base;

// 每次 churn ~18 KB 垃圾；1000 次共约 17.8 MB（远高于下面 9 MiB 的界，所以「不回收」的实现
// 必然撞线）。阈值以离屏下限 8 MiB 为底（max(8 MiB, 在用堆/8)），于是循环中会反复触发
// 自动回收；每轮记录峰值，用于断言「没有随轮数线性上涨」。
var FLOOR_BOUND:Number = 8 * 1048576 + 1048576;   // 8 MiB 下限 + 一块余量
for (var r:int = 0; r < 100; r++) {
  for (var k:int = 0; k < 10; k++) {
    var s:String = churn(r * 10 + k);
    if (r == 99 && k == 9) late = System.totalMemoryNumber;
    if (k == 5) keepAppend(r * 10 + k);
  }
  var m:Number = System.totalMemoryNumber;
  if (m > peak) peak = m;
  // 每轮把「活着」的东西再摸一遍：触发回收可能就发生在上一次分配里。
  if (keepTail != null && keepTail.tag != "node-" + keepTail.id) {
    throw new Error("FAIL: live node corrupted during churn");
  }
}

var afterChurn:Number = System.totalMemoryNumber;

// ① 自动回收确实发生：1000 次 churn 共分配约 17.8 MB 垃圾，结束时在用堆必须远小于
//    该值，且峰值不会随轮数持续抬高（否则就是「只涨不落」）。峰值界取「8 MiB 离屏下限
//    + 一块余量」，对应「垃圾累积到下限就被收掉」——这正是本阶段实现的语义。
expect(peak < base + FLOOR_BOUND, "peak stays bounded by the offscreen floor without any System.gc() (peak=" + peak + " base=" + base + ")");
expect(afterChurn < base + 1200000, "the adaptive trigger reclaimed the churn garbage (after=" + afterChurn + " base=" + base + ")");
expect(late < base + 1200000, "in-loop reading is bounded too (late=" + late + " base=" + base + ")");

// ② 活对象没被回收：链表节点数与内容、循环里写入的字符串都要完好。
expect(keepCount == 100, "the long-lived list kept all 100 appended nodes (got " + keepCount + ")");
var walk:Node = keepHead;
var walked:int = 0;
var sum:int = 0;
while (walk != null) {
  expect(walk.tag == "node-" + walk.id, "node content survived collection (id=" + walk.id + " tag=" + walk.tag + ")");
  sum += walk.id;
  walked++;
  walk = walk.child;
}
expect(walked == keepCount, "the list is still linked end to end (walked=" + walked + ")");
expect(sum == keepSum, "the summed ids match what the loop accumulated (got " + sum + ")");
var built:String = churn(9999);
var parts:Array = built.split("/");
expect(parts[0] == "churn-9999", "string built after the collections starts correctly (got " + parts[0] + ")");
expect(parts.length == 22, "string built after the collections has every piece (got " + parts.length + ")");
expect(parts[1] == "s9999-0", "first appended record field survived (got " + parts[1] + ")");
expect(parts[20] == "s9999-19", "last appended record field survived (got " + parts[20] + ")");
expect(parts[21] == "20", "the array length appended last survived (got " + parts[21] + ")");

// ③ 回收后依然可分配、可回收：阈值是自适应的（跟着在用堆走），一轮大分配后
//    再来一轮，仍然有界（防「触发一次就再也不触发」的实现）。
System.gc();
var base2:Number = System.totalMemoryNumber;
var peak2:Number = base2;
for (var r2:int = 0; r2 < 100; r2++) {
  for (var k2:int = 0; k2 < 10; k2++) {
    churn(10000 + r2 * 10 + k2);
  }
  var m2:Number = System.totalMemoryNumber;
  if (m2 > peak2) peak2 = m2;
}
expect(peak2 < base2 + FLOOR_BOUND, "a second allocation burst is bounded too (peak2=" + peak2 + " base2=" + base2 + ")");
expect(keepCount == 100 && keepSum == sum, "the live set is still intact after the second burst");

// ④ 触发点发生在**任意调用深度**，所以「活着的 C 局部」必须靠保守栈扫描保住：
//    这里的 `live` 是函数局部（不是模块变量——模块变量是 C 全局，天然是永久根，
//    测不到栈），而收集是在 `churn → as_str_concat → gc_alloc` 里触发的，
//    即发生在持有 `live` 的那个帧的**下层**。栈扫描若漏了它，下面的回读就是读已
//    回收内存（垃圾值/崩溃）——这是本改动最需要守住的一条。
function survivorBurst():int {
  var live:Array = [];
  for (var i:int = 0; i < 40; i++) {
    live.push({ i: i, s: "live-" + i });
  }
  var acc:String = "";
  for (var r:int = 0; r < 100; r++) {
    acc = churn(20000 + r); // 每次都会分配（并可能触发回收）
  }
  // 回读：逐个核对内容，任何被提前回收的槽都会在这里现形。
  var bad:int = 0;
  for (var j:int = 0; j < live.length; j++) {
    var oo:Object = live[j];
    if (int(oo.i) != j || oo.s != "live-" + j) bad++;
  }
  expect(bad == 0, "a function-local array survived collections triggered below its frame (bad=" + bad + ")");
  expect(acc.indexOf("churn-20099/") == 0, "the churn result is intact (got " + acc.substr(0, 16) + ")");
  return live.length;
}

expect(survivorBurst() == 40, "the local burst returned its own length");

trace("gc_alloc_threshold: base=" + base + " peak=" + peak + " afterChurn=" + afterChurn + " peak2=" + peak2);
trace("gc_alloc_threshold: all assertions passed");