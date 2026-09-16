// stage14.as — 数值输出精度（17 位 double）与 Date 毫秒时钟。

// 1) trace / String(Number) 精度：应输出 17 位有效数字的 double 最短表示。
trace(1/3);                    // 0.3333333333333333
trace(String(1/3));            // 0.3333333333333333
trace(0.1 + 0.2);              // 0.30000000000000004
trace(1.0);                    // 1
trace(1.5);                    // 1.5
trace(0.1);                    // 0.1
trace(1000000);                // 1000000
trace(-1.5);                   // -1.5
trace(1e21);                   // 1e+21
trace(0.000001);               // 0.000001 (fixed notation; |v| >= 1e-6)

// 2) Date.getTime() 毫秒精度：同一秒内连续两次应得到不同毫秒值。
var a:Number = (new Date()).getTime();
var b:Number = a;
var loops:int = 0;
while (b == a && loops < 1000000) {
  b = (new Date()).getTime();
  loops = loops + 1;
}
trace("elapsed_ms: " + (b - a));   // 应 >= 1（旧实现恒为 0）
trace("loops: " + loops);          // 应远小于 1000000

var d:Date = new Date();
trace("year: " + d.getFullYear()); // 当前年份
