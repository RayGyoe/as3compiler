// fib.js — 递归 Fibonacci（整数基准）
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
const t0 = process.hrtime.bigint();
const result = fib(40);
const t1 = process.hrtime.bigint();
console.log(`result=${result}`);
console.log(`time=${Math.floor(Number(t1 - t0) / 1e6)}`);
