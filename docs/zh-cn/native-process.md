# `flash.desktop.NativeProcess` 实测口径与实现

> 本文回答一个问题：**启动子进程、读它的 stdout/stderr、给它写 stdin、等它的退出码，
> 这套 AIR 面在我们的 AOT 产物里到底怎么表现**。
>
> 口径来源是 `adl 51.4.1` 的实测：类形状用 `mxmlc 51.4.1` 编译 + `adl` 的 `describeType`
> 探针确认（`temp/npa/air/T.as`），运行期行为与错误文案用真起子进程的探针确认
> （`temp/npa/air/NP.as`、`NP2.as`、`Q.as`）。后端实现是 `src/native-process.ts`
> （手写 C，Windows 走 `CreateProcessW` + 命名/匿名管道，POSIX 走 `fork`/`execv`/`pipe`）；
> 它在帧边界被泵一次，和 socket、异步 IO、定时器同一条路径。
>
> 一句话结论：**形状、错误号与文案、事件顺序都按实测对齐；三处无法对齐的地方如实列在 §7，
> 没有一处是靠「碰巧能跑」掩盖过去的**。

---

## 1. 类形状（实测，不是照抄 SDK 元数据）

`describeType` + `mxmlc` 双向确认的结果：

| 成员 | 实测形状 | 备注 |
|---|---|---|
| `NativeProcess.isSupported` | 静态只读 `Boolean` | 桌面后端 `true`；WASI/web `false` |
| `NativeProcess.running` | 只读 `Boolean` | `start()` 后**同一行**即为 `true` |
| `NativeProcess.standardInput` | `IDataOutput` | 实测对象是匿名 `OutboundPipe`（形状见 §7.1） |
| `NativeProcess.standardOutput` / `standardError` | `IDataInput` | 匿名 `InboundPipe` |
| `NativeProcess.start(info)` | `void` | 参数为 `null` 抛 `#1009` |
| `NativeProcess.exit(force = false)` | `void` | 未启动时**静默 no-op** |
| `NativeProcess.closeInput()` | `void` | 未启动时**静默 no-op** |
| `NativeProcessStartupInfo.executable` | 读写 `File` | 赋值时即校验 |
| `NativeProcessStartupInfo.workingDirectory` | 读写 `File` | 赋值时即校验 |
| `NativeProcessStartupInfo.arguments` | `Vector.<String>` | 默认空 Vector |
| `NativeProcessExitEvent.EXIT` | 常量 `"exit"` | |
| `NativeProcessExitEvent.exitCode` | **`number`**（实测 `typeof` 为 `"number"`） | 不是 `uint` |

**实测中不存在、因此实现里也没有**（曾有早期版本凭想象加过，已删除）：

- `NativeProcess.pid` / `NativeProcess.processID` —— `mxmlc` 直接报未定义；
- `NativeProcessStartupInfo.environment`；
- `NativeProcessStartupInfo.standardInput` / `standardOutput` / `standardError`（重定向字段）；
- `NativeProcessExitEvent.process`。

> 判据：`mxmlc` 能编译 + `adl describeType` 能列出，才算 AIR 成员。少一个就是我们的
> 缺陷，多一个就是**非法增强**（会诱导用户写出 AIR 编不过的代码）。

---

## 2. 错误契约（错误号、文案、抛出点都按实测）

| 场景 | 错误 | 文案 |
|---|---|---|
| `start(null)` | `TypeError #1009` | `Cannot access a property or method of a null object reference.` |
| `executable` 为空/不存在/是目录（**赋值时**） | `ArgumentError #3214` | `NativeProcessStartupInfo.executable does not specify a valid executable file.` |
| `start()` 时 `executable` 仍为空 | `ArgumentError #3214` | 同上 |
| `workingDirectory` 不存在/不是目录（**赋值时**） | `ArgumentError #3215` | `NativeProcessStartupInfo.workingDirectory does not specify a valid directory.` |
| 已运行时再 `start()` | `Error #3213` | `Cannot perform operation on a NativeProcess that is already running.` |
| 子进程已退出后写 stdin | `IOError #3212` | 见 §7.1（本后端不发生，故不抛） |

两个要点：

1. **校验在 setter，不在 `start()`**。`si.executable = new File("不存在")` 当场抛 `#3214`；
   `start()` 再校验只是因为字段可能压根没被赋值。
2. `workingDirectory = null` 是**合法**的（继承启动者目录），不抛 `#3215`。

---

## 3. 生命周期与事件顺序

```
new NativeProcess()          -> running=false，三条管道已存在且为空
start(info)                  -> running 立刻 = true（同一行可读）
     [帧边界泵]               -> standardOutputData / standardErrorData（有数据才发）
                               -> exit（子进程真的走了）
```

- **数据先、`exit` 后**：帧边界先把两条管道读空，再查存活；子进程退出前写的最后一行也在
  `exit` 之前投递，取输出的调用方不会丢末尾。
- `ProgressEvent.bytesLoaded` = 本帧读到的**字节数**；`bytesTotal` = **`0`**——管道不预告长度，
  这是实测值，不是省略。
- `running` 在 `exit(true)` 调用的**同一行仍为 `true`**，由 `exit` 事件清掉。实测如此，
  故不能把 `exit()` 当成同步停止。
- 同一个 `NativeProcess` 对象在 `exit` 之后**可以再 `start()`**，退出码按新子进程重新报。
- 事件处理器里异常照常沿下面的 `try/catch` 上抛，不会把泵打断（与其它异步通道一致）。

---

## 4. 三条管道怎么泵

- 泵点是 `tickFrame()` / `tickTimers()` / `Stage_dispatchFrame()` —— 与 socket、异步 IO、
  定时器**同一个边界**。带窗口构建每帧一次，无窗口构建由 AS3 自己调 `tickFrame()`。
- 读是**非阻塞**的：Windows 用 `PeekNamedPipe` + `ReadFile`，POSIX 用 `O_NONBLOCK` 的 `read`，
  `EAGAIN`/`ERROR_NO_DATA` 一律当「本帧没有」。
- 写 stdin 也是**非阻塞**的，且每帧最多 4096 字节；子进程不读 stdin 也不会卡住 AS3 线程。
- `closeInput()` 先冲掉尚未发出的字节，再关写端——`more`/`cat` 这类子进程靠这个 EOF 退出。
- `exit(force)` 只发信号/终止，**不当场回收**：回收仍在帧边界，好让已在管道里的数据先投递。

---

## 5. Windows 命令行：AIR 是「原样拼接」，我们照抄

这是最容易写错、也最容易「好意办坏事」的一处。实测（`temp/npa/air/Q.as`）：

| 传入 `arguments` | 子进程 `cmd.exe` 收到并打印 |
|---|---|
| `["/c", "echo one two"]` | `one two` |
| `["/c", "echo \"one two\""]` | `"one two"`（**引号原样保留**） |

结论：**AIR 在 Windows 上只给 argv[0] 加引号，其余参数一律原样、单空格拼接**。所以我们
**不做** CRT 那套「转义反斜杠 + 包引号」的规范化——那不是修复而是**制造不一致**：`cmd.exe`
按自己的一套规则重解析这个字符串，多出来的一对引号会把一条合法命令变成
`'xxx' 不是内部或外部命令`（本轮实现第一版就踩了这个坑，实测输出可见 `temp/npa/aot/P3.as` 早期日志）。

因此「参数里带空格的路径」在 Windows 上必须由**调用方自己加引号**，与 AIR 一致。
POSIX 不存在这个问题：`execv` 的 argv 是分开的数组，原样传。

---

## 6. 平台边界

| 平台 | 行为 |
|---|---|
| Windows | `CreateProcessW` + `CREATE_NO_WINDOW`（子进程不弹控制台；它自己的窗口是它的事）、`PeekNamedPipe`、`TerminateProcess` |
| macOS / Linux | `pipe` + `fork` + `execv`；读端 `O_NONBLOCK`；`exit(force)` 为 `SIGKILL`、否则 `SIGTERM`；退出码取 `WEXITSTATUS`，被信号杀死按 shell 惯例报 `128 + 信号` |
| WASI / web | `isSupported = false`；`start()` **报明不支持**，不伪造成功 |

三个后端共用**一个 seam**：`ASC_NP_WIN` / `ASC_NP_POSIX` / `ASC_NP_NONE`（`src/native-process.ts`
顶部按 `_WIN32`、`__wasi__ || __EMSCRIPTEN__ || __wasm__`、其余三档选出）：

- 只有 Windows 与 POSIX 原生目标编**真身**。wasm 那两个目标上 `fork`/`execv`/`fcntl` **压根不存在**，
  所以 spawn 与管道实体是**整段不参与编译**，不是「编进去但运行时不调用」；
- `ASC_NP_NONE` 下 `as_np_spawn`/`as_np_read_pipe`/`as_np_flush_stdin`/`as_np_close_stdin` 退化成
  「起不来 / 无数据 / 空操作」的桩，槽位永远进不了 running ⇒ `start()` 在到达 spawn 之前就已按上表报明不支持；
- 上一版只按 `#ifdef _WIN32` 分支，`--package web` 把 POSIX 实体编进 emscripten，
  `fork`/`execv`/`fcntl` 报 10 个错误、直接编不过。`unit: desktop/NativeProcessSeam` 钉住这条：
  文件里任何 `#ifdef _WIN32` 只要落在「seam 本身」与「`#ifdef ASC_NP_NONE` 区块」之外，测试就红——
  因为这类回退在**有 `fork()` 的宿主上完全看不出来**。

- **同时最多 8 个子进程**（`AS_NP_MAX`）。第 9 个 `start()` 走「报明不支持」通道，不静默丢。
- 进程对象由 GC 根表保住：AS3 侧丢掉引用后，管道数据与 `exit` 事件**仍会投递**，
  不会因为一次 GC 把子进程变成孤儿事件。
- 退出码宽度按平台：Windows 保留完整 32 位；POSIX wait status 只有低 8 位，
  同一条 `exit 300` 在 POSIX 上观测为 `44`。这是宿主给的值，AIR 也一样，不是我们的取舍。

---

## 7. 如实报明的差异（三处）

### 7.1 `standardInput` 是 `ByteArray`，不是 AIR 的 `OutboundPipe`

AIR 的写端是 `OutboundPipe`（`IDataOutput`），写入**立即**落到管道；我们的 `standardInput`
是 `ByteArray`，字节先攒在缓冲区，**在帧边界**真正写进管道。可观测后果：

1. 子进程已退出后写入**不会**抛 `#3212`（AIR 会），因为写入点不经过管道状态检查；
   表里仍登记该错误号，供 API 形状对照；
2. 写入是**追加语义**：`in_sent` 记录已发送偏移，`position`/`clear()` 不改变「哪些字节已发出」；
3. `bytesAvailable`/`length` 在 AIR 的写端上无对应物（我们多给了一个 ByteArray 的读面）。

选择理由：AS3 侧 `standardInput.writeUTFBytes(...)` 是**普通 ByteArray 方法**，若要在这类
方法里拦写入，就得让 `standardInput` 变成带拦截器的自定义类——那会引入一个 AIR 没有的
类型，且比缓冲模型更容易出错。缓冲模型的代价是「写过就发出」晚一帧，而 AIR 的调用方
普遍在 `start()` 后写、在后续帧继续写，晚一帧不可观测。

### 7.2 被强杀的子进程退出码

`adl 51.4.1` 在 Windows 上对 `exit(true)` 杀掉的子进程报 `exitCode = NaN`。我们报平台等待状态
（Windows `TerminateProcess(..., 0)` → `0`；POSIX → `128 + 信号`）。**不伪造 `NaN`**：
`NaN` 在这里没有信息量，而真实终止码对「进程是被杀的还是自己退的」是可判定的。
`examples/native-process.as` 因此只断言「有退出码」，不钉具体值。

### 7.3 Windows 上 `exit(false)` 也是终止

AIR 的 `force=false` 语义是「请求子进程自己关闭」（GUI 子进程走消息循环）。控制台子进程
没有消息循环可走，本后端在 Windows 上不区分 `force`，一律 `TerminateProcess`；POSIX 上
`force=false` 发 `SIGTERM`（可被捕获/忽略），`true` 才 `SIGKILL`。

---

## 8. 验收

| 项 | 内容 |
|---|---|
| 示例 | `examples/native-process.as`：16 组断言，覆盖形状、错误号/文案、事件顺序、`bytesLoaded/bytesTotal`、stdin 往返 + EOF、`#3213`、强杀、重启、`workingDirectory` 生效。子进程按宿主选（Windows `cmd.exe`，其余 `/bin/sh`），同一份脚本覆盖两端；但**本阶段只在 Windows 上实测**，POSIX 分支（`fork`/`execv`、`O_NONBLOCK`、`waitpid`）在本机**没跑过**——要等 macOS arm64 的 CI 跑同一份示例才算数，在那之前 POSIX 侧的口径是「写了、未测」 |
| 单元钉 | `unit: desktop/NativeProcess`：钉模块形状（槽位数、帧边界泵、非阻塞读、`CREATE_NO_WINDOW`、POSIX `O_NONBLOCK`、错误文案常量、`standardInput` 缓冲冲写点）、钉示例存在 |
| `adl` 证据 | `temp/npa/air/T.as`（形状）、`NP.as`/`NP2.as`（错误与事件）、`Q.as`（命令行拼接） |
| web 目标 | `node src/index.ts examples/web/hello-web.as --manifest examples/web/hello-web.build.json`（emcc 3.1.44，`-O2`） | **Build successful**（19.4 s）：`fork`/`execv`/`fcntl` 的 10 个错误消失，`isSupported` 在该目标上为 `false`。WASI **未在本机跑通**——本机没有可调用的 WASI SDK（`wasiCc()` 在 Windows 上给出不带 `.exe` 的路径，`WASI_SDK_HOME` 也没有配），但 WASI 与 web **共用同一个 `ASC_NP_NONE` 分支**，`unit: desktop/NativeProcessSeam` 钉死两者不可被拆开 |
| 回归 | 见 `TODO.md` 阶段三百九十一的全量结果行 |