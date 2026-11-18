// bigscan.as — 大 ASCII 文本上的 indexOf / charAt / lastIndexOf（as3compiler 版）
//
// 被测形态：一个 ≈180 KB 的纯 ASCII 文本（4000 行），每轮做 40 次带 startIndex 的
// `indexOf` 向后推进、1 次中段 `charAt`、1 次带 from 的 `lastIndexOf`——正是日志/JSON/CSV
// 解析里最常见的「逐命中推进」扫描。轮数 200。
//
// 这条基准盯的是**索引空间翻译**：String 的索引是 UTF-16 码元（G38），存放却是 UTF-8，
// 于是每次 indexOf/lastIndexOf/charAt 都要在「码元 ↔ 字节」之间翻译。ASCII 上两个空间
// 完全重合（阶段四百四十一的 `as_u16_prefix_ascii` 快路径），C 列的 byte 偏移就是这个
// 「翻译塌成恒等」的下界；AIR 的内部表示本身就是 UTF-16，不需要翻译。
//
// 校验和只累加位置与长度，不打印时间以外的诊断，四路应得同一个 result。
var line:String = "the quick brown fox jumps over the lazy dog";
var big:String = "";
for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }

var t0:Number = new Date().getTime();
var sum:int = 0;
for (var i:int = 0; i < 200; i++) {
  var p:int = -1;
  for (var j:int = 0; j < 40; j++) { p = big.indexOf("lazy", p + 1); sum += p; }
  sum += big.charAt(90000).length;
  sum += big.lastIndexOf("fox", 100000);
}
var t1:Number = new Date().getTime();

trace("result=" + sum);
trace("time=" + int(t1 - t0));
