// mandelbrot.as — Mandelbrot 集合计数（浮点内层循环基准，as3compiler 版）
var size:int = 1500;
var inside:int = 0;
var t0:Number = new Date().getTime();
for (var py:int = 0; py < size; py++) {
  var ci:Number = 2.0 * py / size - 1.0;
  for (var px:int = 0; px < size; px++) {
    var cr:Number = 2.0 * px / size - 1.5;
    var zr:Number = 0;
    var zi:Number = 0;
    var k:int = 0;
    while (k < 50 && zr * zr + zi * zi <= 4.0) {
      var t:Number = zr * zr - zi * zi + cr;
      zi = 2.0 * zr * zi + ci;
      zr = t;
      k++;
    }
    if (k == 50) { inside++; }
  }
}
var t1:Number = new Date().getTime();
trace("result=" + inside);
trace("time=" + int(t1 - t0));
