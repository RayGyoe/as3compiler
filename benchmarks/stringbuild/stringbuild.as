// stringbuild.as — 循环字符串累加（`s += "ab"`）基准（as3compiler 版）
//
// 被测形态：每轮从空串开始，向同一个串追加 2000 次两字节片段，收尾读 length 与
// indexOf。这条形态在真实程序里极常见（拼 JSON / CSV / HTML / 日志缓冲），而它
// 的成本由「`+` 是否拷贝」决定：拷贝实现是 O(n²)，惰性 cons（rope）实现是 O(n)。
//
// 本基准不写显式 System.gc()：AOT 侧按 8 MiB 阈值自动增量回收，AIR 侧走 AVM2
// 自己的 GC，两边都只承受「各自默认 GC 策略」的成本，避免把手工回收算进差异。
var N:int = 2000;
var ROUNDS:int = 2000;

var checksum:int = 0;

var t0:Number = new Date().getTime();
for (var r:int = 0; r < ROUNDS; r++) {
  var s:String = "";
  for (var i:int = 0; i < N; i++) s += "ab";
  checksum += s.length;
  checksum += s.indexOf("ba");
}
var t1:Number = new Date().getTime();

trace("result=" + checksum);
trace("time=" + int(t1 - t0));