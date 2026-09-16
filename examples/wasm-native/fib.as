// fib.as — 递归斐波那契，用作浏览器 WASM 性能基准。
// 与 index.html 的功能自检不同，本文件只做单一热点计算：递归 fib(40)，
// 供 fib.html 与原生 JavaScript 做同算法耗时对比。编译为 WASI .wasm 后，
// _start 内计算并打印结果，由页面的 WASI shim 捕获 stdout。

function fib(n:int):int {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

trace(fib(40));
