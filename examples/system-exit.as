// examples/system-exit.as -- flash.system.System.exit(code:uint):void（阶段二百四十五）
//
// 这三行钉三件事：
//   1. `System.exit(0)` 能编能跑（此前报 `undefined variable 'System'`——把「成员缺失」
//      错报成「类不可见」，见 TODO.md 阶段二百四十五）；
//   2. 进程状态码就是传进去的 `code`（这里 0，也正是示例套件能跑它的原因：套件要求
//      每个示例 exit 0）。非 0 的那一半示例套件钉不了，由
//      `examples/system-exit-status.as` + `test/examples.ts` 里那条串行用例断言 `7`；
//   3. 收尾是**延后**的：调用点之后的语句仍然执行到本帧边界。这不是巧合，而是与
//      `NativeApplication.nativeApplication.exit()` 共用同一条收尾路径的结果
//      （见 src/runtime.ts 里 as_system_exit 的注释）。
trace("system-exit: before");
System.exit(0);
trace("system-exit: after");
trace("system-exit: ok");