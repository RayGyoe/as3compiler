// array.as — 装箱数值 Array 迭代与累加（as_value 装箱路径基准，as3compiler 版）
var N:int = 20000000;
var a:Array = [];
var i:int = 0;
while (i < N) {
  a.push((i * 31) % 997);
  i++;
}

var t0:Number = new Date().getTime();
var sum:int = 0;
var j:int = 0;
while (j < N) {
  sum += a[j];
  if (sum >= 1000000000) { sum -= 1000000000; }
  j++;
}
var t1:Number = new Date().getTime();

trace("result=" + sum);
trace("time=" + int(t1 - t0));
