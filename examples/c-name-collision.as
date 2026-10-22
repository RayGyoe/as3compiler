// examples/c-name-collision.as -- 用户符号名与 C 系统符号重名（阶段二百四十七 · G8）
//
// 顶层 `function foo` 在我们生成的 C 里**原样**当文件作用域函数名用，而 C 的文件
// 作用域只有**一个**标识符命名空间：系统头里已经声明/宏定义的任何名字都会立刻变成
// 硬编译错误。下面这些名字在 AS3 里全部合法、`adl` 全都能跑，所以编译器必须**改 C
// 符号名**而不是拒绝程序。
//
// 两类失败模式，本示例各钉一半：
//   * `bind`/`socket`/`stat`/`printf`/`listen` —— 头文件里的**函数声明**
//     （`conflicting types for 'bind'`，对 <winsock.h> 或 <sys/socket.h>）；
//   * `min`/`isnan` —— 头文件里的**函数式宏**（调用点被改写成 `too few arguments`）；
//     以及 `stat` 的第二种：MSVC <sys/stat.h> 有 `#define _stat _stat64i32`，
//     所以旧策略「加 `_` 前缀」把它改成 `_stat` 反而**更准地**撞进宏里，这就是改用
//     `__` **后缀**的原因。
//
// 类名走同一条路（`qualifiedName`）：`class close` 若不改名就是
// `typedef struct close close;` 与 `close(2)` 冲突。
//
// 断言直接 throw：改坏任何一处，进程以非 0 退出，示例套件当场红。
function bind(a:int, b:int):int { return a + b; }          // <sys/socket.h>
function socket(x:int):int { return x * 2; }               // <sys/socket.h>
function stat(x:int):int { return x + 100; }               // <sys/stat.h> 且 `_stat` 是宏
function printf(x:int):int { return x - 1; }               // <stdio.h>
function listen(x:int):int { return x + 1; }               // <sys/socket.h>
function min(a:int, b:int):int { return a < b ? a : b; }   // <windef.h> 函数式宏
function isnan(x:int):int { return x; }                    // <math.h> 函数式宏

class close {
  public var v:int = 5;
}

function check(name:String, got:int, want:int):void {
  if (got != want) throw new Error("c-name-collision: " + name + " got " + got + " want " + want);
  trace("c-name-collision: " + name + " = " + got);
}

check("bind", bind(1, 2), 3);
check("socket", socket(4), 8);
check("stat", stat(1), 101);
check("printf", printf(10), 9);
check("listen", listen(1), 2);
check("min", min(2, 3), 2);
check("isnan", isnan(42), 42);
check("class close", new close().v, 5);
trace("c-name-collision: ok");