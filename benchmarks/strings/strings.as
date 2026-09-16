// strings.as — 字符串 split/join/indexOf/toUpperCase/lastIndexOf（字符串分配基准，as3compiler 版）
// 注：本基准需要「替换全部」语义；as3compiler 的字符串版 replace 只替换第一个匹配，
// 故四路统一用 split().join()（与原生 AS3 参考版一致）。
var text:String = "the quick brown fox jumps over the lazy dog";
var checksum:int = 0;

var t0:Number = new Date().getTime();
for (var i:int = 0; i < 300000; i++) {
  var joined:String = text.split(" ").join("-");
  checksum += joined.indexOf("fox");
  checksum += joined.toUpperCase().length;
  checksum += joined.split("quick").join("slow").lastIndexOf("o");
}
var t1:Number = new Date().getTime();

trace("result=" + checksum);
trace("time=" + int(t1 - t0));
