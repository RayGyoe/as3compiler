// stage15.as — 模块级作用域共享 + 无类型变量截断防护。

// 1) 模块级 const/var 对自由函数可见（文件级作用域共享）。
const N:int = 1000;
var counter:int = 0;

function readN():int {
  return N;              // 自由函数读取模块级 const
}

function nextCounter():int {
  counter = counter + 1; // 自由函数读写模块级 var
  return counter;
}

trace(readN());          // 1000
trace(nextCounter());    // 1
trace(nextCounter());    // 2
trace(counter);          // 2（main 看到自由函数对模块级 var 的修改）

// 2) 无类型变量：默认 int，赋同类型值合法。
var x;
x = 42;
trace(x);                // 42
x = 100;
trace(x);                // 100

// 3) 模块级 var 顺序初始化语义（b 依赖 a）。
var a:int = 5;
var b:int = a + 5;
trace(b);                // 10
