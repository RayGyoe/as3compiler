// fib.as — 递归 Fibonacci（整数基准，as3compiler 版）
function fib(n:int):int {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}

var t0:Number = new Date().getTime();
var result:int = fib(40);
var t1:Number = new Date().getTime();

trace("result=" + result);
trace("time=" + int(t1 - t0));
