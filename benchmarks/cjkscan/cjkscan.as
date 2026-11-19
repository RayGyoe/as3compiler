// cjkscan.as — 大 CJK 文本上的 indexOf / lastIndexOf / charCodeAt / substring（as3compiler 版）
//
// bigscan 的**非 ASCII 孪生**。同一套操作、同样的 44000 字节级文本，只换内容：每行 43 个
// 汉字 + "\n"（44 个 UTF-16 码元、130 字节），4000 行 ⇒ 176000 码元 / 516000 字节。
// 因此两个基准的**码元数完全相同**，唯一的自变量是「码元 ↔ 字节」是否可以塌成恒等。
//
// 四个相位分别盯一类调用：
//   A indexOf(needle, p+1) 单调推进 —— 游标能续走，理论上不该有差
//   B lastIndexOf(needle, from) 从大往小 —— 反向定位 + 命中处翻译
//   C charCodeAt((q*5003) % 170000) —— 升序跨步（21 次里 20 次游标能续走），最省的一种
//   D substring(o, o+20).length, o=(r*7919) % 170000 —— 两次定位 + 一次新串求长，同样是
//     升序跨步：它测的是「顺序切分」（分词器/行表的形状），**不是**随机访问
//     （真正随机访问的成本另记在 report.md §3，它是另一种形状，本夹具不覆盖）
//
// 校验和只累加位置/码值/长度，四路（C / JS / asc / AIR）应得同一个 result。
var line:String = "敏捷的棕色狐狸跳过了那只懒狗用它来测试中日韩文字的码元索引和字节偏移之间的翻译开销六字";
var big:String = "";
for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }

var t0:Number = new Date().getTime();
var sum:int = 0;
for (var i:int = 0; i < 100; i++) {
  var p:int = -1;
  for (var j:int = 0; j < 40; j++) { p = big.indexOf("懒狗", p + 1); sum += p; }
}
for (var b:int = 0; b < 100; b++) {
  for (var j2:int = 0; j2 < 40; j2++) { sum += big.lastIndexOf("狐狸", 120000 - j2); }
}
for (var q:int = 0; q < 20000; q++) { sum += big.charCodeAt((q * 5003) % 170000); }
for (var r:int = 0; r < 20000; r++) {
  var o:int = (r * 7919) % 170000;
  sum += big.substring(o, o + 20).length;
}
var t1:Number = new Date().getTime();

trace("result=" + sum);
trace("time=" + int(t1 - t0));
