// examples/system-exit-status.as -- `System.exit(code)` 的**状态码**那一半（阶段二百四十五）
//
// 为什么单独一个文件：示例套件（test/examples.ts 的池）只跑「必须 exit 0」的程序，
// 所以带非 0 状态码的程序进去就是一条永远红。这个文件因此在 SKIP_FILES 里，
// 由 test/examples.ts 末尾那条串行用例单独编译、单独运行，并断言进程真的以 7 退出
// ——真正验证的是 `main` 的 `return as_exit_status;` 与 `as_system_exit` 的记录。
trace("system-exit-status: before");
System.exit(7);
trace("system-exit-status: after");