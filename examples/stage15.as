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

// 4) 脚本作用域是整个顶层语句树（阶段八十九·三十四）：顶层块内 / `for` init 里写的
//    var 与顶层 var 共用同一个槽（AS3 把整个顶层树提升到唯一的脚本作用域），
//    块/循环结束后仍可见、可写。修复前它们只在块内可见，块外引用是
//    `undefined variable 'i' at top level`。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

for (var i:int = 0; i < 3; i++) { }
check(i == 3, "the top-level for-init var keeps its script-scope slot (got " + i + ")");
i = 10;                  // 循环后仍可写（同一个槽，而非块内局部）
check(i == 10, "the for-init var stays writable after the loop (got " + i + ")");

if (true) { var inBlock:int = 7; }
check(inBlock == 7, "a top-level block var is visible after the block (got " + inBlock + ")");
inBlock += 1;
check(inBlock == 8, "and it is writable through the same slot (got " + inBlock + ")");

var sum:int = 0;
for (var k:int = 0; k < 3; k++) { sum += k; }
check(sum == 3 && k == 3, "an untouched loop counter still reads its final value");

// 5) 块内声明的 var 仍受“同名一次”约束：同一个名字只对应一个 C 全局。
var dup:int = 1;
if (true) { var dup2:int = 2; }
check(dup + dup2 == 3, "distinct script-scope names stay distinct (got " + (dup + dup2) + ")");

// 6) 闭包看到的是脚本作用域的“同一个槽”而非值快照（修复前是快照）：三个闭包捕获同一
//    个顶层循环变量，循环结束后调用都应看到最终值。
var fns:Array = [];
for (var j:int = 0; j < 3; j++) {
  fns.push(function():int { return j; });
}
check(fns[0]() == 3 && fns[1]() == 3 && fns[2]() == 3,
      "closures share the script-scope slot, not per-iteration snapshots");
var blockVar:String = "";
if (true) { var captured:String = "z"; }
var readCaptured:Function = function():String { return captured + "!"; };
check(readCaptured() == "z!", "a closure reaches a block-declared script var (got '" + readCaptured() + "')");

// 7) 循环变量同样属于脚本作用域（AS3 的 var 是函数/脚本级的，不是块级的）:
//    `for (var k in o) {}` / `for each (var s in v) {}` 的变量在循环后仍可见。
//    其 C 类型当然不能写在源码里（for-in 看迭代对象而定），故由 collectScriptDecls /
//    emitModuleVars 用与发射点相同的规则（loopVarType）推出。
var obj:Object = { a: 1, b: 2, c: 3 };
var seen:int = 0;
var lastK:String = "";
for (var fk:String in obj) { seen++; lastK = fk; }
check(seen == 3, "for-in over an object runs 3 times (got " + seen + ")");
// 循环后 k 仍可见，持最后一轮的键。（AIR 实测：变量确实存活；但 AIR 的 for-in 遍历顺序
// 与本子集不同——AIR 在同一对象上给出 k=b，本子集给插入序 k=c——故只断言“是其中一个键”。）
check(fk == lastK, "the for-in var survives the loop (got " + fk + ")");
check(fk == "a" || fk == "b" || fk == "c", "and holds a real key (got " + fk + ")");
fk = "rewritten";
check(fk == "rewritten", "the loop var is writable through the same script-scope slot");

var arr2:Array = ["x", "y", "z"];
var idxSum:int = 0;
for (var aidx:int in arr2) { idxSum += aidx; }
check(aidx == 2 && idxSum == 3, "a top-level for-in index var is an int and survives (got " + aidx + ")");

var vec:Vector.<String> = new Vector.<String>();
vec.push("p");
vec.push("q");
for each (var el:String in vec) { }
check(el == "q", "a top-level for-each var keeps the element type and survives (got " + el + ")");

var dictObj:Object = { only: "one" };
for each (var dv:* in dictObj) { }
check(dv == "one", "a top-level for-each var over a dynamic object is boxed (got " + dv + ")");

// 函数体内的循环变量仍是块内局部（本子集既有约定，与函数体 var 提升规则一致）。
function loopVarInFunction():String {
  var o2:Object = { z: 9 };
  for (var kk:String in o2) { return kk; }
  return "?";
}
check(loopVarInFunction() == "z", "the in-function loop var still works inside its loop");

trace("stage15: module scope OK");
