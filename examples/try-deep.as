// try-deep.as — 异常展开栈必须「每线程 + 可增长」（阶段二百零八）。
//
// 旧实现把展开栈放成进程级 `jmp_buf*[64]`，push 无边界检查：
//     as_jmp_stack[as_jmp_depth++] = &jb;
// 两个事实叠在一起就爆：
//  ① 嵌套超过 64 层时，第 65 次写落在 `as_jmp_depth` 自己身上（深度计数器被写成栈地址），
//     此后每次 push 都按「野深度」写向 .data 深处——把紧邻的 as_fre_zero_byte / FRE hooks /
//     as_fre_qcs 静默改坏。Windows AOT 现场那一族崩溃都是它的下游症状：ntdll 里
//     EnterCriticalSection 对「从未初始化」的 CS 崩（DebugInfo=NULL，写 NULL+0x14）、
//     0xc0000409 (incorrect stack)、以及堆地址上的 DEP 执行违规。
//  ② 计数器还是全进程共享，ANE 工作线程（FRESetObjectProperty 等回调）与主线程各压自己的帧，
//     抛异常时 longjmp 会跳进**另一个线程的栈**。
//
// 断言刻意「先反后正」：修好之前第一条（200 层嵌套后仍能正确捕获/重抛）就会崩或给出错值。
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 1) 深层嵌套：进入 201 层 try 后在最里层抛，逐层 catch 记录并重抛，最后由外层接住。
var deepest:int = -1;
var rethrows:int = 0;

function dive(n:int):void {
  try {
    if (n > 0) {
      dive(n - 1);
    } else {
      throw new Error("bottom");
    }
  } catch (e:Error) {
    if (deepest < 0) deepest = n;   // 最内层第一次捕获
    rethrows++;                     // 每层都重抛，一路回到外层 try
    throw e;
  }
}

var caught:String = "";
try {
  dive(200);
} catch (e:Error) {
  caught = e.message;
}
check(deepest == 0, "the innermost catch sees depth 0 (got " + deepest + ")");
check(rethrows == 201, "every level re-throws (got " + rethrows + ")");
check(caught == "bottom", "the outer try sees the original message (got " + caught + ")");

// 2) 反复进出：`return` 从 try 里出去走的也是弹栈路径，300 轮 81 层必须账目对齐。
function deepSum(n:int):int {
  try {
    if (n == 0) return 0;
    return n + deepSum(n - 1);
  } catch (e:Error) {
    return -1;
  }
}
var sum:int = 0;
for (var i:int = 0; i < 300; i++) sum += deepSum(80);
check(sum == 300 * (80 * 81 / 2), "300 rounds of 81-deep try/catch nest cleanly (got " + sum + ")");

// 3) 展开之后栈必须回到起点：紧接着的 try 仍要接到自己的帧。
var catches:int = 0;
try { dive(150); } catch (e:Error) { catches++; }
try { throw new Error("still aligned"); } catch (e:Error) {
  check(e.message == "still aligned", "the next try sees its own frame");
  catches++;
}
check(catches == 2, "both catches ran, in order");

// 4) 深层嵌套里的 finally：每层只弹一次（多弹一次就会把上一层 try 的帧弹掉）。
var fin:int = 0;
function withFinally(n:int):void {
  try {
    try {
      if (n > 0) withFinally(n - 1); else throw new Error("x");
    } finally {
      fin++;
    }
  } catch (e:Error) {
    throw e;
  }
}
try {
  withFinally(100);
} catch (e:Error) {
  check(e.message == "x", "finally + nested catch keep the thrown value");
}
check(fin == 101, "each finally ran exactly once (got " + fin + ")");

trace("try-deep: all checks passed");
