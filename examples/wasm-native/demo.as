// demo.as — 浏览器 wasm 功能可用性自检程序。
// 编译为 WASI .wasm 后由 index.html 加载运行，输出即「功能可用性」证据。
// 刻意覆盖多类特性：基础类型 / 字符串拼接 / 除法语义 / 控制流 / 数组 /
// Vector / 数学函数 / 类与继承 / 闭包 / 异常。不含任何 GUI 或文件 I/O，
// 以便在纯 WASI（无窗口、无文件系统）环境下运行。

trace("== as-aot wasm self-test ==");

// 1. 基础类型与 trace
var name:String = "wasm";
var n:int = 6 * 7;
var pi:Number = 3.14159;
var ok:Boolean = true;
trace("hello", name);
trace("6 * 7 =", n);
trace("pi ~=", pi);
trace("ok =", ok);

// 2. 字符串拼接（自动装箱）
var s:String = name + " rocks " + n + " times";
trace("concat:", s);

// 3. 除法恒为 Number（int/int 也是浮点）
trace("10 / 4 =", 10 / 4);           // 2.5，而非 C 的整数截断
trace("7 % 4 =", 7 % 4);             // 3

// 4. 控制流
if (n > 40) {
  trace("n is big");
} else {
  trace("n is small");
}
var sum:int = 0;
for (var k:int = 0; k < 5; k++) {
  sum += k;
}
trace("sum 0..4 =", sum);            // 10

// 5. 数组
var a:Array = [10, 20, 30];
a.push(40);
trace("array len:", a.length);       // 4
trace("array join:", a.join("-"));   // 10-20-30-40
trace("a[1]:", a[1]);                // 20

// 6. Vector.<T>（类型安全数组）
var v:Vector.<int> = new Vector.<int>();
v.push(5);
v.push(6);
trace("vector len:", v.length);      // 2
trace("vector join:", v.join(","));  // 5,6

// 7. 数学函数
trace("sqrt(16) =", Math.sqrt(16));  // 4
trace("pow(2,10) =", Math.pow(2, 10)); // 1024
trace("floor(3.7) =", Math.floor(3.7)); // 3
trace("round(3.5) =", Math.round(3.5)); // 4
trace("abs(-5) =", Math.abs(-5));    // 5

// 8. 类、继承与虚方法派发
class Animal {
  var name:String;
  function Animal(nm:String) { name = nm; }
  function speak():String { return "..." ; }
}
class Dog extends Animal {
  function Dog(nm:String) { super(nm); }
  override function speak():String { return name + " says woof"; }
}
var d:Dog = new Dog("Rex");
trace(d.speak());                    // Rex says woof

// 9. 闭包捕获外层变量
function makeAdder(x:int):Function {
  return function(y:int):int { return x + y; };
}
var add5:Function = makeAdder(5);
trace("add5(7) =", add5(7));         // 12

// 注：throw/try/catch 依赖 setjmp/longjmp，WASI 目标下需要异常处理提案
// 支持的 compiler-rt，当前 wasi-sdk 尚未就绪，故此处不包含异常特性。

trace("== done ==");
