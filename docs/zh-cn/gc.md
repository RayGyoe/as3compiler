# 自研精确 GC 设计方案（Mark-Sweep + Shadow Stack）

> 对应路线图 **阶段五十七**（目标 v0.3.57 → v0.3.58，最高优先级）。
> 本文是立项阶段的技术论证与设计草案；具体实现细节以 GC-1 ~ GC-4 各子阶段的落地为准。

---

## 1. 背景与目标

### 1.1 为什么需要 GC

阶段五十六把「每帧事件分发的临时分配」修掉了，泄露从 39 KB/s 降到 0.85 KB/s。剩余的 0.85 KB/s
**不是编译器 bug，而是「无 GC」的语言语义**：

- 动画每轮 `new TweenLite` + vars 字面量 + PropTween（`malloc`，~300 B/s）
- 用户代码字符串拼接（`Fps` 每秒 `text.text`、`TweenDemo` 每轮 `trace`，arena，~550 B/s）

这些对象在 AS3 里由 AVM2 的 GC 回收，AOT 下 arena（bump allocator，程序生命周期）与散落的
`malloc`（不回收）都永不清空。长时间运行（用户实测 10 小时）会持续增长。

### 1.2 目标

1. **彻底清零慢泄露**：动画临时对象（TweenLite/vars/PropTween/闭包）+ 字符串均可回收。
2. **native 与 WASI 双目标行为一致**（这是选型的关键约束，见 §2）。
3. **不破坏正确性**：宁可不回收，也不能误回收（误回收 = 悬空指针 = 随机崩溃，比泄漏危险得多）。

---

## 2. 技术选型：自研精确 GC 是唯一可行路径

### 2.1 Boehm bdwgc 直接出局（关键技术事实）

Boehm-Demers-Weiser GC 是最成熟的 C 保守式 GC，`-lgc` 链接、`malloc`→`GC_MALLOC`、`free` 变 no-op，
符合 AGENTS.md §2.9「重活链接成熟库」的铁律。**但它在 WASI 下物理上失效**：

> Boehm 的核心机制是**保守式栈扫描**——扫描 C 调用栈的字节，找「像指针」的值当根集合。
> 但 **WebAssembly 的调用栈在虚拟机管理的独立内存里，不在线性内存里**，C 代码根本看不到、也扫不到。

因此：
- `wasm32-wasip1` 目标下，Boehm 的栈扫描失效，无法找到任何根；
- bdwgc 的 wasm port 要么极不成熟，要么要求手写 shadow stack 喂根给它——一旦手写 shadow stack，
  就退化成半自研，还要背上保守式 GC 的误保留缺陷（false retention：栈上整数恰好像指针就不回收），
  两头不讨好。

### 2.2 精确 GC 的决胜优势

精确 GC（exact tracing）的根集合是**显式登记的**（shadow stack），**不依赖扫描调用栈**。
因此它在 native 和 WASI 上的行为**完全一致**——这正是「WASI 纳入目标」时精确 GC 的决定性优势。

| 方案 | 成熟度 | 精确度 | WASI 可行性 | 契合度 |
|---|---|---|---|---|
| Boehm bdwgc | ★★★★★ | 保守式 | ❌（栈扫描失效） | 高但被 WASI 排除 |
| Ravenbrook MPS | ★★★ | 可精确 | 需大幅移植 | 接口复杂，接入成本高 |
| **自研 mark-sweep** | — | **精确** | ✅（不依赖栈） | **唯一可行，且项目已备枚举基础** |

### 2.3 为什么自研在这里可行（关键）

精确 GC 的难点在于「如何精确枚举对象图里的指针」。项目**已经具备全部枚举基础设施**，自研门槛大幅降低：

| 已有基础 | 位置 | 对精确 GC 的作用 |
|---|---|---|
| `as_value` 干净 `tag + num + ptr` | `runtime.ts:208` | tag 3/4/6/7 精确指示 ptr 是否指针，**精确标记**（不是猜） |
| `as_prop` 反射表 `{name, type, offset}` | `emit.ts:411` | type 1~7 精确枚举用户类每个字段是值/引用/boxed，**精确遍历对象图** |
| `as_method` 反射表 + vtable super 链 | `runtime.ts:170/248` | 沿继承链 mark 父类字段 |
| 内建结构布局已知 | `runtime.ts` | as_array/as_object/as_dict/as_closure 的指针字段写死在代码里 |

### 2.4 V8 Orinoco 参照：可借鉴与不可借鉴（2019 trash-talk）

V8 的 Orinoco 项目把 stop-the-world GC 改造成 **parallel + incremental + concurrent**（外加 idle-time）。
对照本项目，先认清一个**决定性约束**，再谈借鉴：

> **WASI 单线程**：`wasm32-wasip1` 无 `pthread`，helper threads 不存在。

| V8 技术 | 依赖 | 本项目可行性 |
|---|---|---|
| **Parallel**（多线程分担 mark） | helper threads | ❌ WASI 无线程 |
| **Concurrent**（后台线程 GC） | helper threads | ❌ WASI 无线程 |
| **Incremental**（主线程分片 mark） | 仅主线程 | ✅ **唯一可行的消除卡顿正解** |
| **Idle-time GC**（帧余量做 GC） | embedder 帧循环 | ✅ 本项目有 `Stage_dispatchFrame`，天然结合 |

**结论**：WASI 单线程砍掉了 V8 的 parallel/concurrent，唯一可移植的是 **incremental（增量标记）**——这正
是 §5 GC-4 的方向，V8 印证了它的正确性，并补全了实现它的关键细节（三色标记 + write barrier，见 §6）。

**代际假设（generational hypothesis）的启示**：V8 依据「大多数对象短命」把堆分 young/old 两代，young 用
semi-space 复制 GC，只付「存活对象」成本。这条假设对本项目**同样成立**（动画临时对象 TweenLite/vars/PropTween
每轮 new、每轮死）。但 V8 的 semi-space 是 **moving GC**（复制存活对象、更新所有指针），对我们精确 GC + shadow
stack 是巨大成本（要更新 shadow stack 根、as_prop 反射字段、全局变量里的所有指针）。因此：

- **借鉴思想**：分代（年轻代小堆、高频快速扫描；老年代大堆、低频扫描），降低每次停顿的扫描量；
- **不照搬实现**：放弃 moving/semi-space，保留 **non-moving mark-sweep**（无需指针更新），年轻代也做
  mark-sweep，只是堆小、扫得快。这是「分代 + 非移动」的折中，牺牲了 semi-space 的「零碎片 + 只付存活成本」
  （复制 GC 的隐式压缩优势），换来「无需指针更新」的巨大工程简化。

---

## 3. 现有对象布局盘点（GC 迁移的输入）

当前运行时对象的分配方式与指针字段如下（行号指 `src/runtime.ts`）：

| 结构 | 定义行 | 分配方式 | 指针字段（需 mark） |
|---|---|---|---|
| `as_value`（box） | 208 | 值类型，随宿主存 | tag 3/4/6/7 的 `ptr` |
| 字符串 | — | **裸 `char*`**，arena | 无子指针（叶子） |
| `as_array` | 409 | `as_alloc`（arena） | `data`（`as_value*`，元素可能持指针）、`input`（`char*`） |
| `as_object`（record） | 680 | `malloc`（`as_heap_bytes` 计数） | `vtable`、`keys`（`char**`）、`vals`（`as_value*`） |
| `as_dict` | 878 | `malloc` | `keys`（`void**`，对象强引用）、`vals`（`as_value*`） |
| `as_closure` | 325 | `as_alloc`（arena） | `env`（`void*`，捕获环境） |
| `as_class` | 397 | 常量/静态 | `vtable`、`factory`（函数指针） |
| 用户类实例 | emit 生成 | `malloc` | vtable + 各字段（由 `as_prop` 反射表枚举） |
| `as_regex` | 1309 | `malloc` | 内部字节码/字符串 |

**关键观察**：字符串是**裸 `char*`，没有 header**；as_array/as_closure 走 arena（无 header）；as_object/as_dict/
用户类走 malloc。三者分配方式、header 布局各不相同——这是 GC 迁移必须统一的第一件事（见 §4.1）。

---

## 4. 缺的三样（自研完整工作量）

### 4.1 GC 堆 + Mark-Sweep 核心（`runtime.ts`）

**统一 header（外部前置式）**：所有 GC 管理的对象在分配时于对象体**之前**预留一个 header，`gc_alloc` 返回
header 之后的地址。header 统一包含：

```c
typedef struct gc_header {
    int type;        // 类型标签，决定 mark 遍历方式（见 §4.1 表）
    int color;       // 三色标记状态：0 white / 1 grey / 2 black（增量标记用，见 §6）
    size_t size;     // 对象体字节数（sweep 时释放用）
    struct gc_header* next;   // 堆对象链表（sweep 遍历）
} gc_header;
```

**类型标签 → mark 遍历方式**：

| type | 对象 | mark 遍历 |
|---|---|---|
| `GCT_STRING` | 字符串 | 叶子，无子指针 |
| `GCT_ARRAY` | as_array | 遍历 `data[0..length)`，对每个 `as_value` 若 tag∈{3,4,6,7} 则 mark `ptr`；mark `input` |
| `GCT_OBJECT` | as_object(record) | mark 所有 `keys[i]`（字符串）+ `vals[i]`（as_value 递归） |
| `GCT_DICT` | as_dict | mark 所有 `keys[i]`（对象指针）+ `vals[i]`（as_value 递归） |
| `GCT_CLOSURE` | as_closure | mark `env` |
| `GCT_CLASS` | 用户类实例 | 读 `vtable` → `props` 反射表，对 type∈{3,6,7} 的字段 mark（type 6 ref 是裸指针，type 7 any 是 as_value，type 3 string 是 char*） |
| `GCT_VALUE_ARRAY` | as_array 的 `data` 缓冲 | 按 `as_value` 逐槽 `gc_mark_value` |
| `GCT_PTR_ARRAY` | 引用元素 `Vector.<T>` 的负载 `data` | 按 `void*` 逐项 `gc_mark_ptr` |
| `GCT_RAW` | 标量 / 装箱 / 接口元素 `Vector.<T>` 的负载 `data` | **叶子，不扫**（裸数值数组或 `{obj,vt}` 值结构体）；其中指向 GC 对象的引用（`Vector.<*>` 的装箱槽、接口元素的 `obj`）由该 Vector 的 `GCT_CUSTOM` 回调显式追踪 |
| `GCT_CUSTOM` | 单态化 `Vector.<T>` 结构体本身 | 调 `((as_vector_*)b)->mark(b)`，即生成的 `as_vector_*_mark`：先 `gc_mark_ptr(v->data)`，再按元素类型补 `*`/接口的逐元素追踪 |

**Mark-Sweep 流程**（三色视角）：
1. **Mark**：从根集合（shadow stack + 全局根，§4.2）出发，广度/深度遍历，对每个可达对象置 `color=black` 并递归其子指针；
2. **Sweep**：遍历堆对象链表，`color==white` 的对象释放（`free` 回堆），`color==black` 的复位 `color=white` 供下一轮。

> 非增量（stop-the-world）实现里三色是隐式的（标记完即全黑）；但 header 从设计之初就用 `color`（2 bit）
> 而非 `marked`（1 bit），是为 GC-4 增量标记直接复用同一套结构（见 §6），避免二次改动 header 布局。

**触发时机**：`gc_bytes_allocated` 累计超过阈值（如 1 MiB）时，在 `Stage_dispatchFrame` 帧循环的**安全点**触发。
安全点要求：**调用栈上所有持指针的局部都已登记在 shadow stack**（§4.2），否则触发时无法准确枚举根。

**停顿分析（stop-the-world 的本质代价）**：触发的那一帧，主线程停下渲染，跑完整个 mark + sweep 才恢复。
- 停顿时间 ∝ **堆中对象总数**（mark 遍历可达对象 + sweep 遍历整个对象链表），**不是** ∝ 垃圾量；
- 触发频率 = 分配速率 ÷ 阈值（**不是每帧 GC**，是周期性的单次卡顿）；
- demo 规模（阈值 1 MiB、几万对象）：一次约 1~10ms，16ms 帧预算下**掉 1 帧**，肉眼基本无感；
- 风险：阈值调大或常驻对象累积后，停顿可达几十~上百 ms，变成可见冻结。**这是 mark-sweep 的固有缺陷**，
  adl 不卡是因为 AVM2 用增量 + 分代 GC；消除停顿的唯一正解是**增量标记**（见 §6）。

> **落地补充（GC-1~GC-4 实现后）**：实际分配器未采用本节设想的「单链表遍历」，而是**分段堆 + free-list**
> （`GC_SEG_SIZE = 1 MiB` 每段，first-fit + 切分 + 合扇），活对象链 `gc_all` 与空闲链分开维护。由此引出一个
> **超大分配边界**：当单次请求 `size > GC_SEG_SIZE - sizeof(gc_header)`（约 1 MiB − 24 字节头）时，按固定段切分
> 永远满足不了请求，会导致 `gc_alloc` 无限递归、不停 `malloc(1 MiB)` 直到耗尽 VSZ——修复方案是镜像 `as_alloc`
> 的 oversized 分支：为 `size` 分配一个 `sizeof(gc_header) + size` 的专用段，下一次重试即命中 free-list
> （`benchmarks/array` 死循环即由此引发）。
>
> **触发时机补正**：帧边界安全点只存在于有 `Stage_dispatchFrame` 帧循环的程序；headless/控制台程序的 `main()`
> 从不进入帧循环，安全点永不触发，GC 沦为纯手动——用户代码不显式调 `System.gc()` 就只增不回收（静默泄漏而非崩溃）。
> 分配密集的控制台基准因此需在循环内周期性插 `System.gc()` 才能真正触发回收。

#### 4.1.1 段归还与分配器让步（阶段八十九·二十六）

分段堆的段一旦 `malloc` 就永不归还，于是**空闲块回到空闲链、RSS 却不回落**：实测 Starling Benchmark
30k 对象时活集 44 MB / `heaptotal` 61 MB，RSS 却停在 520 MB。两件事都要做，缺一不可：

- **空段释放（`gc_release_empty_segs`，限速 `GC_RELEASE_MS = 500`）**：`gc_seg` 加 `free_bytes` 在用字节
  计数（carve 置满、`gc_alloc` 命中减、sweep 释放加）+ `reap` 标记；到点后单遍扫两条空闲链，把
  「`free_bytes == size`」段的空闲块全部摘除（含合并块），再从 `gc_segs` / `gc_seg_range` 摘除并 `free`。
  称「死亡段」须先摘链再释放，否则链上留下悬空节点。调用点两处：`gc_finish_cycle`（轮末）与
  `gc_step` 的 `GC_IDLE` 分支——后者保证**停止分配后**（不再有新的 GC 轮）RSS 也会跟着活集回落。
- **分配器让步（`gc_trim_os`）**：`free()` 只把页还给 `malloc`，macOS 的 zone 会把它们留着不还给 OS
  （`heap` 实测：真正在用 167 MB 落在 388 MB 预留 zone 里，其中 263 MB 是 “empty” 且常驻）。故显式调
  `malloc_zone_pressure_relief(NULL, 0)`（`#ifdef __APPLE__`，系统内存压力下自己也会调），
  在段释放前后各一次。

> **为什么不让 GC 段自己走 `mmap`**：`GC_SMALL_SEG_SIZE = 64 KiB` 低于 macOS `malloc` 的 mmap 阈值，
> 段页归还本就依赖分配器让步；平台无关的赢法是「先摘链再 `free` + 让步」，而不是把段分配改成 `mmap`。
>
> **诊断旋钮 `ASC_FRAME_STATS=1`**：每 512 帧打印一行帧时分布（`p50/p95/p99/max`）与 GC 占比、
> RSS / `heaptotal` / `inuse` / 段数 / 空闲字节（环形缓冲 512）。定位「卡顿是 GC 还是场景本身」
> 只需看 `gcshare` 与 `over17ms`。配合 `ASC_GC_STATS`（逐轮明细）、`ASC_GC_BUDGET`/`ASC_GC_THRESHOLD`
> （预算/阈值绝对覆盖）使用。
>
> **诊断探针的 WASI 降级（阶段八十九·三十一）**：`ASC_GC_STATS` 的「巨大分配归因」用
> `dladdr()`（POSIX/Apple 专有，wasi-libc 有头文件但无 `Dl_info`/`dladdr`）+ `__builtin_return_address`
> （非 Emscripten wasm 上是**硬错误**，LLVM 未实现）。两者都只服务诊断、不参与程序可见行为，故按
> `__wasi__` 条件编译：`gc_dbg_sym` 退化为裸地址/`"?"`，返回地址宏 `ASC_RETURN_ADDRESS(n)` 退化为 `NULL`。
> 修前 `--target wasm` **连编译都过不去**（`hello.as` 同样失败），不是只有探针失效。

### 4.2 根集合 = Shadow Stack（`emit.ts` codegen，最大工作量 + 最大风险）

> **实现补正（阶段五十七~八十九）**：最终落地的是「**永久根 + 帧边界安全点**」，没有做
> shadow stack。回收只在 `Stage_dispatchFrame` 开头的安全点（`gc_step()`）发生——此刻所有
> 本帧回调都已返回，根集合仅剩永久根（静态字段、模块变量、`ASC_win_stage`、`ENTER_FRAME`
> 注册表、定时器、`as_exception`、**在飞的异步 IO job 目标**（阶段八十九·四十五）），故**不需要**枚举栈上局部。代价是安全点只存在于帧循环里，
> 且 `System.gc()`（`gc_collect()`）是用户可见的**手动采集点**，它会在任意位置触发。
> "**中帧采集的保守栈扫描**"（§4.2.1）就是为后者补上的根来源。
>
> **在飞 job 必须登记为根**（阶段八十九·四十五）：`gc_mark_internal_roots()` 里调
> `as_async_mark_roots()` 遍历 job 表，把每个 job 的 AS3 目标（`j->obj`）标为根——否则目标
> 在后台线程干活期间无人引用即被 sweeping 回收，finish thunk 再写就悬空。且**从入表到
> finish thunk 跑完之前都不能移出表**（已取中的 job 标 `AS_JOB_FINISHING` 但留在表内）：thunk
> 里会 `gc_alloc`（`BitmapData_new`/`Bitmap_new`），headless 无帧时走 `gc_alloc` 的分配阈值
> 停机采集，提前移出表会让未标记的目标被清零——实测 `Loader` 的 `contentLoaderInfo` 被清成
> NULL → `Loader__imageFinish+0x34` 写 `0x18` 报 `EXC_BAD_ACCESS`（崩溃报告
> `async-conc-*.ips`；反向对照：把选取的 job 提前出表，3/3 SIGSEGV）。

精确 GC 不扫描调用栈，改为**编译器显式登记**「每个函数当前可能持指针的局部变量/形参/临时值」。

**机制**：每个生成的函数，在入口登记一个栈帧到全局 shadow stack，出口注销：

```c
void Foo_method(Foo* this, as_value a) {
    gc_frame_enter(/* 持指针局部数组 */ ...);   // 入口登记
    ...
    gc_frame_leave();                              // 出口注销
}
```

`gc_frame` 记录一段「GC 可扫的内存区」，其中每个元素要么是 `as_value`（按 tag 判断是否指针），
要么是裸指针（直接当根）。GC 触发时遍历 shadow stack 的每一帧，mark 帧内所有指针。

**这是最大的工作量 + 最大的风险**：
- 编译器要给每个生成函数，在 codegen 阶段**精确枚举**「所有可能持指针的局部变量、形参、临时 as_value」；
- 变量在函数内不同区间可能「已死」（不再被使用），若不注销而一直留在 shadow stack，会造成误保留（不回收，
  但仍安全）；反之**漏登记 → 对象被过早回收 → 悬空指针 → 随机崩溃**（比泄漏危险得多）。

**缓解策略（宁可误保留、不可漏登记）**：
1. 保守起步：一个函数**整个生命周期**登记全部持指针局部（不做精细 liveness 分析），GC 只会误保留、不会误回收；
2. 用 `usesArguments*`（emit.ts 已有）同款 AST 预扫描，枚举一个函数内「出现过」的所有持指针变量；
3. 全局根（stage、display list、事件注册表、`as_timers`、静态字段、模块级 `g_*` 全局）单独登记为**永久根**，
   常驻对象本就不该被回收。

### 4.2.1 中帧采集的保守栈扫描（阶段八十九·二十二）

**问题**：`System.gc()` 是 AS3 语义里的显式采集点，Starling demo 的「返回主菜单」就调它
（`Game.showMainMenu` → `System.pauseForGCIfCollectionImminent` + `System.gc()`）。此时 C 调用栈上
还有活着的 AS3 帧，它们持有的对象**只存在于 C 局部变量里**（没有 shadow stack 就没有任何登记）。
实测后果：`EventDispatcher.dispatchEventWith` 里正在派发的 `Event*`（刚从 `Event.sEventPool` 弹出、
作为 C 参数持有）被全停顿 `gc_collect()` 扫掉，随后 `Event.toPool` 把**已释放**的 event 压回对象池，
下一次 `Event.fromPool` 弹出的 object 里 `vtable` 已变成垃圾（内存被复用为 `PTR_ARRAY`）
→ `_event->vtable->reset(...)` 跳到地址 0 → `EXC_BAD_ACCESS`（用户报「进 Sprite 3D 点 Back 崩溃」）。

**修法**：`gc_mark_roots()` 末尾追加一次**当前 C 调用栈的保守扫描**（`gc_mark_stack()`）。
- 窗口：`[SP, gc_stack_top)`。`gc_stack_top` 由 `GC_NOTE_STACK_BASE()` 锚定——`emit.ts` 在生成
  `main()` 的**首行**发出该宏，宏把当前局部变量的地址写进 `gc_stack_top`，因此锚点在 `main` 的
  栈帧上，扫描窗口覆盖整条活着的调用链。
- `setjmp` 先落盘 callee-saved 寄存器（只有寄存器活的局部因此也能被扫到），随后按
  `sizeof(void*)` 对齐逐字 `memcpy` 取出，按值当根。
- **只接受谈得上对象的字**（`gc_is_object()`）：地址落在 GC 段内 + 头里的 `type` 取值合法 +
  `color` 合法 + `size` 合理。不合格的字节（整数、浮点、中间的内部指针）直接跳过。
- **对象头合法性靠 magic tag**：`GCT_*` 常量全部偏移 `GCT_TAG_BASE 0x47430000`（`"GC"`），
  且**空闲块/新切分块的 `type` 显式写 0**（`gc_alloc` 的 split、新段 carve、`gc_sweep_step`）。
  于是任意一个「碰巧落在段内、对齐得像头」的栈字几乎不可能等于合法 tag，避免了把垃圾当成
  `GCT_CUSTOM` 头、进而把垃圾当函数指针调（`gc_scan` 的 `GCT_CUSTOM` 分支）。

**代价与边界**：保守扫描是「**宁可误保留，不可漏标**」——误保留的只是恰好被陈旧栈槽指向的对象，
存活到下一次采集；如果该位置不再被写回旧值，下一次采集就回收它。安全点采集（帧循环）里也跑
同一条 `gc_mark_roots()`：此时窗口内只剩 run-loop 链（`main` 持 `g_stage`/`g_app`（本就是永久根）、
`Stage_showWindow` 只持 `Stage*`），后果为零；死掉的回调帧在扫描帧**之下**（栈向低地址增长），
不在窗口内，所以不会把上一帧的垃圾留成长期根。

### 4.3 迁移分配点

| 对象 | 现状 | 迁移后 |
|---|---|---|
| as_array / as_closure | `as_alloc`（arena） | `gc_alloc(GCT_ARRAY/GCT_CLOSURE, size)` |
| as_object / as_dict / 用户类 / as_regex | `malloc` | `gc_alloc(GCT_*, size)` |
| 字符串 | arena bump | `gc_alloc(GCT_STRING, len+1)` |
| `Vector.<T>` 元素负载 | `realloc`（**永不回收**） | `gc_alloc(GCT_RAW/GCT_PTR_ARRAY, …)`（**阶段八十九·二十四**，见 §6.10） |
| 常驻对象（stage/显示列表/vtable/静态字段） | 各分配 | **保持不动或登记为永久根**（本就不回收） |

字符串纳入 GC 单独列为 **GC-2**（§5），因为字符串是裸 `char*` 无 header，且当前 `as_str_from_*`/
`as_str_concat` 等所有字符串构造都走 arena，改动面最大、回归风险最高，故拆成独立子阶段。

---

## 5. 四阶段拆解与验收标准

| 子阶段 | 目标 | 纳入回收的对象 | 验收 |
|---|---|---|---|
| **GC-1** | GC 堆 + Mark-Sweep + Shadow Stack 根，**native 先跑通** | array / object(record) / dict / closure / 用户类实例 | `examples/stage57.as` 长循环 `new` 大量对象后 `System.totalMemory` 不随轮次线性增长；窗口 demo 长时间运行 MEM 稳定；回归旧示例无破坏 |
| **GC-2** | 字符串纳入 GC | 字符串 | `trace`/`text.text` 高频拼接后内存稳定 |
| **GC-3** | WASI 目标验证 + 长时间运行回归 | （同上） | `--target wasm` 下同样回收；native+wasm 双目标长时间运行零悬空（本次验收一度只能用**异常机制被 `-O2` 消去**的示例复现：一旦 setjmp/longjmp 进入可达路径，sysroot 就缺 `__wasm_setjmp`/`__c_longjmp` 等符号而**链接失败**；**阶段八十九·三十五已修复**（wasm 目标链接 `libsetjmp.a` + 走标准 EH 提案 `try_table`），四例已全部复跑并与 native 一致，见 `docs/zh-cn/compile.md` §2 与 `temp/wasi-eh/check.sh`） |
| **GC-4** | 可选优化：代际 / write barrier + **增量标记** | — | 帧率无显著下降；堆增大后**停顿时间不随堆线性增长**（增量标记把 mark 分摊到多帧，每帧只做一小片，才是消除卡顿的正解，代际只降扫描量、不消除停顿） |

**MVP 边界（GC-1）**：舞台/显示列表/事件系统这些「常驻对象」本就是 GC 根（AS3 里从 stage 可达，
本来就不该回收），**只回收动画临时对象**（TweenLite/vars/PropTween/闭包），正好命中阶段五十六残留泄露的主体。

> **增量标记的完整技术路线见 §6**。本节只保留验收标准；三色状态机、mark stack、write barrier 的
> 具体代码、编译器注入点清单、边界情况、开销估算，都在 §6 一次性展开，不另留「后续再定」。

---

## 6. 增量标记完整设计（GC-4 落地）

> 本节是 GC-4 的**完整落地技术路线**，一次性展开，不另留「后续再定」。GC-1~GC-3 先交付
> stop-the-world 的 mark-sweep（§4.1），GC-4 在其上无缝叠加增量标记——header 的三色字段、
> mark stack、write barrier 都从 GC-1 起就预留，避免二次改动。

### 6.1 目标与原理

stop-the-world 的停顿 ∝ 堆中对象总数（§4.1 停顿分析），堆一大就成可见冻结。增量标记的解法是：

> **把 mark 工作分摊到多帧，每帧只推进固定预算（budget）的一小片**，主线程在 mark 间隙继续跑
> 渲染与用户代码。单帧停顿从 `O(堆)` 降到 `O(budget)`，堆再大也不会有长停顿。

代价是两处：① mark 必须改成「可暂停/可恢复」的状态机（不能再用递归 DFS）；② 增量期间主线程
会改写对象图，必须用 write barrier 维持三色不变式（否则漏标 → 误回收）。

### 6.2 数据结构：mark stack + 三色状态

三色抽象：对象分 **white**（未访问）/ **grey**（已访问、子节点未扫）/ **black**（子节点已扫）。
`gc_header.color`（§4.1）就是这三位状态。

增量标记不能再靠 C 递归栈（无法中途暂停），改用**显式 mark stack** 存灰色对象：

```c
// 全局增量标记状态（runtime.ts，GC-1 起即预留，IDLE 时零开销）
typedef struct {
    int state;                // 0 IDLE / 1 MARK / 2 SWEEP
    gc_header** grey_stack;   // 灰色对象工作栈（染灰即入栈）
    int grey_top;             // 栈顶（栈只增不减，直到标记完成）
    int grey_cap;             // 栈容量（按需 realloc，迁移注意 §8）
    size_t budget;            // 每帧预算（对象数）
} gc_inc;
```

### 6.3 状态机与分片调度

```
IDLE ──(gc_bytes_allocated > 阈值)──> MARK   // 所有根染灰、入栈
MARK ──(每帧 gc_step(budget): 弹灰对象扫其子指针)──> 持续
MARK ──(灰栈空)──> SWEEP                     // 标记完成
SWEEP ──(每帧扫一片，回收 white、black 复位 white)──> IDLE
```

**调度点**：`Stage_dispatchFrame` 每帧开头调用 `gc_step()`（在广播 ENTER_FRAME 之前）。budget
用「每帧最多扫 N 个对象」的**确定性预算**（比时间预算好：跨平台一致、不依赖 `clock`）。
没有帧的程序（纯脚本 / 服务端循环 / WASI）走不到这里，由 **`gc_alloc` 的分配阈值触发**兜底，
见 §6.13。

**预算与阈值必须随堆自适应，且切片需封顶（阶段八十九·二十五实测修正）**：固定 500 对象/帧只约束了
*停顿*，没有约束*吞吐*。十万对象级的活集（Starling Benchmark 约 8000 个对象时活集已 ~15 万节点）
走完一轮 MARK+SWEEP 需要数百帧，期间每帧还在产生 2~4 MB 垃圾 → 堆一路涨到 900 MB（实测
`total=917MB ｜ raw=881.8MB/889`，即 889 个未回收的 `GCT_RAW` 负载），随后收集器不得不做的
那一段工作又把帧率从 120 打到 75，基准测试的爬坡因此提前中止。修法：

- **切片自适应且封顶**：`budget = min(count/16 + 500, 8000)`（`count` = 堆内对象数，O(1) 计数器）。
  下限保住小堆的进度，上限保住*停顿*——不封顶时切片随堆线性增长，实测帧率从 120 一路滑到 47 fps。
- **触发阈值自适应**：`gc_threshold = max(1 MiB, inuse/8)`，垃圾约占堆 1/8 才开新轮，避免在大堆上
  「上一轮还没走完就又重启标记」。
- 两个旋钮都可用环境变量 `ASC_GC_BUDGET` / `ASC_GC_THRESHOLD` 绝对覆盖（调参用，默认走自适应）。

**单步伪代码**（每帧一次）：

```c
void gc_step(void) {
    if (gc_inc.state == GC_MARK) {
        size_t n = gc_inc.budget;
        while (n-- > 0 && gc_inc.grey_top > 0) {
            gc_header* g = gc_inc.grey_stack[--gc_inc.grey_top];
            gc_mark_children(g);   // 扫描 g 的子指针（§4.1 类型分派），white 子节点染灰入栈
            g->color = GC_BLACK;   // 子节点扫完，转黑
        }
        if (gc_inc.grey_top == 0) gc_inc.state = GC_SWEEP;  // 标记完成
    } else if (gc_inc.state == GC_SWEEP) {
        gc_sweep_step(gc_inc.budget);   // 每帧扫一片，回收 white
        if (扫完) gc_inc.state = GC_IDLE;
    }
}
```

### 6.4 write barrier（写屏障）完整实现

**为什么需要**：增量期间主线程会跑用户代码，一个 **black** 对象在 mark 间隙写入指向 **white**
对象的引用，那个 white 已不会被扫到（black 的子树已扫完）→ 漏标 → 被误回收。

**解法：Dijkstra 插入屏障**——每次「写引用」时，若被写的值是 white，把它**染灰入栈**，维持不变式：

> **标记期，black 对象不直接指向 white 对象。**

```c
// runtime.ts
static inline void gc_write_barrier(void* src) {
    if (gc_inc.state != GC_MARK) return;   // 非标记期零开销（一个 int 比较）
    if (src == NULL) return;
    if (!gc_in_heap(src)) return;          // 非 GC 堆对象（字符串字面量/静态数据）跳过
    gc_header* h = gc_hdr(src);
    if (h->color == GC_WHITE) {            // 被写的 white 引用，染灰
        h->color = GC_GREY;
        gc_grey_push(h);                   // 入灰栈，稍后被扫
    }
}
```

**关键细节**：`gc_in_heap(src)` 是堆地址范围判断。精确 GC 下 `as_value` 的 `ptr` 都指向 GC 堆，但
运行时存在**非堆指针**（`"true"`/`"false"`/`"null"` 等字符串字面量、静态 vtable、静态字符串），必须
用地址范围快速排除，否则会误把字面量当 GC 头去读 `color` 字段。

### 6.5 增量期间的分配（allocation barrier）

标记期新分配的对象若初始化为 white，会在本次 sweep 被误收（它还没被标记过）。标准解法：**增量期间
分配的对象直接初始化为 black**：

```c
void* gc_alloc(int type, size_t size) {
    gc_header* h = ...;
    h->color = (gc_inc.state == GC_MARK) ? GC_BLACK : GC_WHITE;  // 标记期新对象直接 black
    ...
}
```

安全性论证：新对象刚分配、尚未被 black 对象引用，设 black 不会被 sweep 误收；若用户随后把它写进某
black 对象的字段，write barrier（§6.4）会保护那条边，不破坏不变式。

### 6.5.1 推论：写入「新鲜 GC 块」的指针必须显式重新置灰

§6.5 的论证有一个**反直觉的缺口**：allocation barrier 保护的是「别人指向新对象」的边，**不保护
「新对象指向别人」的边**——因为新块生在 black，本次周期内不会再被 `gc_scan` 扫描，其内部的指针字段
（连同它 `memcpy` 复制进来的内容）都**不会**被标记。因此：

> **不变式（全项目适用）**：任何**指针**被写进一个「本次周期中新分配（= 生而 black）的 GC 块」时，
> 必须在该写点显式调用 `gc_write_barrier` / `gc_write_barrier_value` 把值重新置灰，否则目标对象若仍是
> white，会在本次 sweep 被静默回收、留下悬空指针。

最容易漏掉的一类是**缓冲区扩容**：grow 时 `gc_alloc` 出新块 → `memcpy` 旧内容 → 旧内容的每个指针
都欠一次置灰。已按此规则修复的站点（阶段八十九·十九）：

| 站点 | 位置 |
|---|---|
| Array 扩容 | `as_array_ensure` |
| XML 解析缓冲扩容 | `as_xml_buf_push` |
| record/对象属性表扩容 | `as_object_set`（props 增长分支） |
| Dictionary 桶扩容 | `as_dict_set` |
| Vector 扩容（push / unshift / setLength / ensure 四条分支） | 生成 C 的 `as_vector_*_grow(v, cap)` 单一汇点（`emit.ts`）：`gc_alloc(GCT_RAW/GCT_PTR_ARRAY)` + `memcpy` + `gc_write_barrier((void*)v->data)`；引用元素再逐元素 `gc_write_barrier`，`elem.kind == 'any'` 时由 mark 回调逐元素 `gc_mark_value` |

判据很简单：**凡是「新 GC 块 + 从别处搬进来的指针」的组合，就要补屏障**，与它是不是「插入元素」无关。

### 6.6 编译器注入点清单（emit.ts）

write barrier 有两种落点，分工如下：

| 写入类型 | 落点 | 是否需编译器注入 |
|---|---|---|
| 动态写入 `a[i]=v` / `d[k]=v` / `o.k=v` / `o[k]=v`（反射） | `as_array_set` / `as_dict_set` / `as_object_set` / `as_dyn_set` | **否**——barrier 内建进这 4 个 setter 函数（运行时统一处理，编译器零改动） |
| **直接字段写** `o.field = v`（C 直接赋值，不走函数） | `emitAssign` 的 Member 分支 | **是**——codegen 在赋值后补一行 `gc_write_barrier(...)` |
| 局部/形参 `as_value` 赋值（`var x:* = ref`） | 变量声明/赋值 | **否**——局部在 shadow stack（§4.2）里，本就被扫，无需 barrier |

**只有「直接字段写」需要编译器注入**，且只在字段 type 是 3/6/7（string/ref/any，即持指针）时注入，
type 1/2/4/5（number/bool/int/uint）是值、无指针、跳过。注入形式：

```c
// AS3: this.target = otherObj;   （field type 是 6 ref 或 7 any）
this->target = otherObj;
gc_write_barrier(otherObj);       // codegen 追加
```

> 之所以把 barrier 内建进 4 个动态 setter 而非全部靠 codegen，是因为动态 setter 是「所有动态写入的
> 唯一汇点」，在运行时加一次 `gc_write_barrier` 就覆盖全部调用点，比在 codegen 几十处 `emitAssign`
> 分支逐个加更内聚、更不易漏。直接字段写没有函数汇点（是 C 直接赋值），才需要 codegen 显式注入。

### 6.7 边界情况与不变式

| 情况 | 处理 |
|---|---|
| **三色不变式** | 标记期 black 不直接指向 white；write barrier 维持 |
| **灰栈溢出** | 栈只增不减直到标记完成，容量按需 `realloc`；迁移后更新引用（同 §8 `realloc` 项） |
| **灰栈空 = 标记完成** | grey 对象必在栈里（染灰即入栈），栈空即无灰色 → 转 SWEEP |
| **sweep 期间的写** | sweep 阶段无 mark 进行，barrier 不生效（正确：颜色已定型，sweep 只回收 white） |
| **非堆指针误判** | `gc_in_heap` 地址范围检查排除字面量/静态数据（§6.4） |
| **budget 用尽中途返回** | mark 栈/游标持久化在 `gc_inc` 里，下帧从断点续跑，无重算 |

### 6.8 开销估算

- **非标记期**：每个动态 setter + 每次直接字段写多一个 `gc_inc.state != GC_MARK` 的 int 比较（几纳秒），
  几乎不可测。
- **标记期**：mark 总工作量与 stop-the-world **相同**（只是分摊），额外付出是 write barrier 在「black 写
  white」时多一次染灰入栈——动画场景该比例极低。
- **净效果**：单帧停顿 `O(budget)`，彻底消除「堆增大 → 长冻结」的线性退化，对齐 AVM2 的无感 GC 体验。

### 6.9 与 GC-1~GC-3 的关系

GC-1~GC-3 交付 stop-the-world mark-sweep，**但 header 用 `color`（三色）而非 `marked`（单色）、
并预留 `gc_inc` 结构**，因此 GC-4 的增量标记是「加一个状态机 + mark stack + write barrier」，
不需要回改 header 布局或 shadow stack 机制。GC-4 只影响触发时机（`Stage_dispatchFrame` 每帧
`gc_step()` 替代一次性 `gc_collect()`）与写屏障注入，其余全复用。

### 6.10 Vector 元素负载纳入 GC（阶段八十九·二十四）

**背景（用户报「Benchmark 测试时内存泄露」）**：Benchmark 场景跑到 13279 objects 时 Activity
Monitor 显示 **14.17 GB** 常驻内存；实测 `temp/hidpi/mem.py "btn:9,at:160:60"` 复现
**255 MB → 14298 MB / 23 s**，随后在 14.3 GB 处平顶。

**深因**：`as_vector_*` 结构体本身走 `gc_alloc(GCT_CUSTOM)`，但**标量/装箱/接口**元素
（`vectorElemIsPtr() == false`：number/int/uint/bool/any/interface/…）的负载一直是裸
`realloc`/`malloc`，**在 GC 堆之外、永远不回收**——每次扩容都丢掉旧缓冲（“每个 Vector 都永远泄漏”）。
放大器：`VertexBuffer3D_uploadFromByteArray` 每次调用都新建两个全尺寸 `as_vector_number`，
而 Starling 的 `Effect.uploadVertexData → uploadToVertexBuffer → uploadFromByteArray` 在**顶点变化的
每一帧**都跑（Benchmark 的容器一直在旋转）→ 每帧丢几 MB。`leaks` 证据：
`ROOT LEAK: <realloc in as_vector_number_setLength>`（471 例 / 375 MB）+ `as_vector_uint_setLength`（222 例 / 30 MB）。

**修法（两部分）**：
1. **负载上 GC 堆**：新增叶子类型 `GCT_RAW`（`gc_alloc` + `memcpy` 替代 `realloc`），
   标量/装箱/接口元素的负载走它，引用元素走 `GCT_PTR_ARRAY`；四个旧扩容分支
   （push/unshift/setLength/ensure）收敛为单一助手 `as_vector_*_grow`，其中 `v->data` 的改写
   补 `gc_write_barrier((void*)nd)`（§6.5.1 不变式）。孤立的旧负载从此可被回收。
   多于一个段的负载（如多 MB 的 `Vector.<Number>`）由 `gc_alloc` 的超大段分支承接，
   故 `gc_is_object` 的 size 上界从 `GC_SEG_SIZE` 放宽到 `1u << 30`。
2. **缓冲复用**：`VertexBuffer3D`/`IndexBuffer3D` 的 `uploadFromByteArray` 改为**按绝对顶点/索引
   下标就地写**（负载 Vector 不够长才 `setLength`；阶段八十九·二十六 起顶点负载合并为单份
   `Vector.<uint>` 32 位字缓冲，见下节），`Context3D_submit` 与生成 C 的读取
   路径一致按 `startVertex`/`startIndex` 定位（`as_s3d_upload_vertex/index` 只需传入 `data + startIndex`
   与 `numIndices`）；`IndexBuffer3D_uploadFromVector` 同时改为**拷贝**而不是别名调用者的 Vector
   （AS3 语义是拷贝，别名会让后续就地上传改掉调用者的对象）。
3. **附带修一个既存崩溃（非本泄漏引入）**：`gc_in_heap` 原来只判 `p >= base`，而所有调用者都要读
   `p - sizeof(gc_header)` 处的头字段；一个落在**段首**的栈字（保守栈扫描会持段基址）会让该读取落到
   段前未映射页 → `SIGBUS`（`stage57.as` 在 `-O2` 下必现，`-O0` 下恰好不现）。改为要求头自身落在段内。

**验收**：`temp/hidpi/mem.py "btn:9,at:160:60"` → 271 MB → **1219 MB / 4 s 后逐秒完全持平**
（修前 14298 MB）；连做 6 轮「Start benchmark」→ 1651.3 MB 后 0.00 MB/s（收敛，无逐轮递增），
`leaks` 由 2478 例 / 407 MB 降至 **399 例 / 68 KB**；中途截图确认烘焙场景渲染正确（蛋形/贴图/
深度排序正常）；`demo_all2.py` 12 场景零崩溃；`node test.ts` 101 passed / 0 failed。

---

### 6.11 分配器的尺寸类与「大负载」复用（阶段八十九·二十五）

首适（first-fit）单链 + 切分在**尺寸漂移的重复大请求**上会碎掉整块内存：

- 现象（实测）：`resv=1127MB segs=1031 freeblk=40693 freeb=1060MB` —— 预留 1.1 GB、其中
  1 GB 挂在空闲链上**却一个都用不上**。原因是一条链上 freed 的多 MB 负载会被紧随其后的小对象
  按首适规则**蚕食切碎**（每次切一小块），等到下一个多 MB 请求到来时，链上已没有够大的块 →
  直接开新段。`Effect.uploadVertexData` 每帧重建一个多 MB 的 `VertexBuffer3D`（Starling 自身
  语义：`vertexData.size > _vertexBufferSize` 就 purge+新建），于是「每帧一个新段」= RSS 高水位。
- 修法（`src/runtime.ts`）：
  1. **两条空闲链**：`gc_free`（< `GC_BIG_CLASS` = 256 KiB）与 `gc_free_big`（≥ 256 KiB）。
     申请与回收都按自身尺寸归类（`gc_free_for(size)`），大请求不必再逐块跳过小对象。
     （注：曾用「单链 + 跳过异类块」实现，结果大请求每帧要扫过数万个小块，`example/gc_barrier.as`
     直接 O(n²) 超时 —— 分类链表才是正解。）
  2. **新段按请求类选尺寸**：小请求开 `GC_SMALL_SEG_SIZE`（64 KiB）段。若小请求也开 1 MiB 段，
     切走请求后剩下的余块属「大」类，小链永远空 → 每次小分配都新开一个段（实测 `segs=26995`）。
  3. **大负载容量上取整到 2 的幂**（`as_vector_*_grow`，仅当 `cap*sizeof(elem) ≥ 256 KiB`）：
     帧与帧之间的元素数只漂移几百（`need = startVertex*stride + count`），上取整后落回同一尺寸类，
     上一帧释放的块这一帧就能原样复用；小负载保持精确尺寸（取整只会白占内存）。
  4. 新段切分后**先按请求尺寸切开再重试**（新段本身是大块，小请求会永远跳过它 → 无限递归）。

---

### 6.12 段归还计数的精确性（阶段八十九·二十七）

**背景**：段归还（§4.1.1）判定「这个段里什么都没有」的依据是 `s->free_bytes == s->size`，即
「段内每个字节都在空闲链上」。这个判定**只有在计数器精确时才等价于「空」**。

**缺陷（第二次跑 benchmark 崩溃的真根因）**：分配器从空闲链取块时，如果剩余部分小于
`GC_MIN_BLOCK`（32 B）就不切分，块**保持原尺寸**交给调用方 —— 但计费却按**请求尺寸**扣除：

```c
size_t remain = h->size - size;
if (remain >= GC_MIN_BLOCK) { /* 切开，h->size = size */ }
free_bytes -= sizeof(gc_header) + size;   // ← 未切分时少扣了 (h->size - size)
```

于是该段 `free_bytes` 比真实空闲**偏大**，且偏差会**永久累积**（每次未切分分配 +≤31 B）。
当偏差恰好等于段内活对象的占用时，`free_bytes == size` 成立 → 这个**装满了活对象的段被
`free(s->base)` 还给 OS** → malloc 立刻复用它（实测给 arena/`ByteArray.data`）→ 段内所有对象
变成别人的内存：

- 用户报的崩溃：`BatchProcessor_addMesh + 360`，坏地址 `0x3fef9782a0000150` —— 一个 `MeshStyle`
  的 vtable 字变成了 double；
- 复现的崩溃：`BenchmarkScene_onEnterFrame + 1572`，`ldr x12, [x10, #0x10]`，`x10` 取自全局
  `gc_all`（0x1013b15c0）—— **对象链表头本身变成了 double**。
- 两处坏值的基址都是 `0x3fef9782a0000000` = double `0.9872449040412903` = benchmark 里
  `_container.scale`（`scale *= 0.99` / `/= 0.9993720513` 累乘的产物）→ 同一个「double 落在指针位」
  的破绽，且能解释为什么「第二次跑才崩」（第一次被释放的块内容还没被覆写）。

**修法**：计费搬到切分**之后**，按块的**实际尺寸**扣除：

```c
/* 切分 */
free_bytes -= sizeof(gc_header) + h->size;   // 切分后 h->size 恰为真实占用
```

这样 `free_bytes` 与「空闲链上各块 (header + size) 之和」严格相等，`free_bytes == size`
重新等价于「段真空」。（原先未切分的余量不入任何空闲链，因此不计入 free_bytes —— 它属于
「被过度分配的块」，而不是「空闲空间」。）

**验收与回归**：

- `examples/gc_seg_reap.as`：循环「分配 payload p 的字符串 → 丢弃 → `System.gc()` → 以 p-4 取回」
  （余量 4 B < 32 B → 未切分），同时保持 8 个活字符串 canary；`test.ts` 以
  `ASC_GC_AUDIT_STRICT=1` 运行它。修前该示例**必现**
  `free_bytes DRIFT seg=… free_bytes=65552 size=65536 delta=16` 并 `abort()`（rc=134）；修后输出
  `gc-reap-ok`。
- 整机回归：`bench2.py 480`（Starling benchmark 连跑 10 轮）无崩溃、`gc-audit` 报告为 **0 行**
  （修前同一 harness 在第 3~5 轮 `rc=-11`，并伴随 8 行 DRIFT / 多行 RELEASING）。
- `node test.ts`：103 passed / 0 failed。

**诊断旋钮**（`ASC_GC_AUDIT` 系列，默认全关，生产路径零开销）：

| 变量 | 作用 |
|---|---|
| `ASC_GC_AUDIT=1` | 每次段归还前用活对象链重算各段实际占用，与 `free_bytes` 对账：`DRIFT`（计数器不精确）、`GHOST`（`gc_all` 里挂着已释放块）、`RELEASING … with N LIVE bytes`（正要释放仍活着的段）；并在标记时检测悬空引用（指向已清扫块）。健康程序**零输出** —— 有输出即缺陷。 |
| `ASC_GC_AUDIT_STRICT=1` | 同上，但首个违例直接 `abort()`（供 `test.ts` 断言，见 `gc_audit_fail`）。 |
| `ASC_GC_RELEASE=0` | 关闭段归还（A/B：隔离「归还」相关的崩溃）。 |

**判定原则**（本阶段踩过的坑）：报告预算必须**按类别分开**（`gc_audit_reports` / `drift` /
`release`），否则海量信息型报告（DRIFT）会把决定性的 `RELEASING`/`DANGLING` 挤掉，直接导致
首次诊断跑偏；另外**地址区间历史类判据不可用**：`malloc` 会立刻复用刚释放的段地址（arena/`ByteArray.data`
正在其中），「指针落在曾释放的段区间内」必然产生大量假阳性（实测 32 条全部是 `ByteArray.data`），
已于本阶段删除。

### 6.13 非 GUI 目标的分配阈值触发（阶段八十九·四十一）

**背景**：GC 的推进点只有一处——`Stage_dispatchFrame` 帧边界的 `gc_step()`（外加 `System.gc()`
手动触发）。没有帧的程序永远走不到那一处，于是「分配了多少就长多少」：`gc_bytes_allocated`
一直涨、`gc_inc.state` 一直是 `GC_IDLE`，堆不回收。

**修法（两个方向都必要，缺一不可）**：

| 机制 | 位置 | 作用 |
|---|---|---|
| 帧驱动标志 | `gc_step()` 开头 `gc_frame_driven = true` | `gc_step()` 的唯一调用者就是发射出的 `Stage_dispatchFrame`，所以「进过 `gc_step`」⇔「本程序有帧安全点」。有帧的程序继续走 GC-4 的**增量分片**（保住每帧有界停顿） |
| 分配阈值触发 | `gc_alloc` 入口：`if (!gc_frame_driven && state == GC_IDLE && gc_bytes_allocated >= gc_trigger()) gc_collect();` | 从未派发过帧之前，分配自己按阈值（`max(1 MiB, 在用堆/8)`，§6.3）做**停机回收** |

**为什么是停机回收**：这条路径上没有帧截止时间要保护，总工作量也一样，切片只会给一条
「必须从任意调用点都正确」的路径引入状态机。它和已被支持的 `System.gc()`（可以在活着的 AS3
帧内触发）是同一类操作：`gc_mark_roots` 照常跑**保守栈扫描**（setjmp 把 callee-saved 寄存器
落到栈上再逐字扫，§4.2.1），因此调用链上每一层的活局部都还是根。触发点放在 `gc_alloc` 的
**最前面**（新对象还不存在），所以清扫永远不会把「正在分配的那个对象」当成不可达垃圾。

**不变式**：`main` 的第一条语句就是 `GC_NOTE_STACK_BASE()`（早于任何 AS3 语句），所以从
`gc_alloc` 触发时栈扫描一定拿得到栈底。

**验收**：

- `examples/gc_alloc_threshold.as`：全程不调 `System.gc()`、不派发帧，100 轮约 5 MB 垃圾的
  峰值被压在 ~1 MB（阈值下限），断言「峰值有界」（`peak < base + 1.5 MB`）、「活对象没被误收」
  （模块级链表 100 节点逐项核对；**函数局部**数组在收集点下层存活——模块变量是 C 全局、天然
  永久根，测不到栈，必须用局部）；
- **反向对照 1**（把触发条件改成 `if (0)`）：必 FAIL —— `FAIL: peak stays bounded without any
  System.gc() (peak=17772328 base=0)`（不回收时峰值 ≈17 MB，线性上涨）；
- **反向对照 2**（把 `gc_mark_stack` 的保守栈扫描关掉）：必 FAIL —— `FAIL: the local burst
  returned its own length`（活局部被回收，证明栈扫描是这条路径的**承重**条件）；
- `node test.ts`：112 passed / 0 failed（含全部 GC 断言示例）。

**已知权衡（有意保留）**：一旦派发过帧，分配阈值触发就**让位**给帧边界的增量回收——这是为了
不牺牲 GC-4 的每帧有界停顿。此后若帧完全停摆，行为与本阶段之前一致（靠 `System.gc()` 兜底）。

### 6.14 字节缓冲纳入 GC（阶段八十九·四十二）

**背景**：`ByteArray.data`（grow / compress / uncompress）与 `BitmapData.pixels` 一直走
arena / `malloc`。它们挂在 **GC 可见的字段**上（`ByteArray_props` / `BitmapData_props` 的
条目 type 6），可达性判断一直是对的，但内存本身不在 GC 堆里——`System.gc()` 扫到它们只会
`gc_mark_ptr` 一次「非堆指针，安全跳过」（§6.4），**永不回收**。

**这个泄漏长期隐形的原因**：`malloc` / arena 的块不在 `System.totalMemoryNumber` 的账目里
（那三项是 arena + 少量 runtime 自己的 malloc + GC 堆），所以反复建/丢 `ByteArray` 的程序
账目**完全不涨**。实测同一段 churn（40 轮 × 1 MB）：迁移前账目 0 MB、RSS **+40 MB 且不回落**；
迁移后账目 0 MB、RSS 峰值 3.6 MB（段被复用）。可见内存的「泄漏」要看 RSS，账目只能看 GC 堆。

**修法**：新增叶子类型 `GCT_BYTES`（`GCT_TAG_BASE + 16`），把两类缓冲改为
`gc_alloc(GCT_BYTES, n)`：

| 位置 | 原实现 | 现实现 |
|---|---|---|
| `ByteArray_set_length` / `as_ba_grow` / `as_ba_grow_pos` | `as_alloc(cap)` + `memcpy`，旧块丢弃（arena 不回收） | `gc_alloc(GCT_BYTES, cap)`，旧块成为 GC 垃圾 |
| `ByteArray.compress` / `uncompress` | `as_alloc(dst)`（zlib 目标缓冲） | `gc_alloc(GCT_BYTES, dst)`；uncompress 每次重试的失败块也是 GC 垃圾 |
| `URLLoader` 二进制读（`ba->data`） | `as_alloc(sz)` | `gc_alloc(GCT_BYTES, sz)` |
| `BitmapData` 构造 | `malloc(w*h*4)` | `gc_alloc(GCT_BYTES, w*h*4)`（`gc_alloc` 自带清零，填充循环随后覆盖） |
| 图片解码落 `BitmapData.pixels`（`Loader.loadBytes` / `BitmapData.loadFile`） | 直接 adopt glue `malloc` 的 ARGB 缓冲 | `memcpy` 进 GC 缓冲 + `free` glue 缓冲（glue 是 C++，调不到 GC；所有权因此单一：`pixels` 只在 GC 堆上） |
| `BitmapData.dispose()` | `free(bd->pixels)` | `bd->pixels = NULL`（**丢引用**：`free` 一个 GC 缓冲会砸坏 GC 的空闲链） |

**为什么不必扫字节**：`GCT_BYTES` 是叶子（`gc_scan` 的 case 直接 `break`）。字节里没有指针
可跟——它**可达**只因为某个类字段指向它，而那个字段的反射表条目（type 6）已经在 GCT_CLASS
的扫描里被跟过（§6.4 / §7）。与 `GCT_RAW`（Vector 元素负载）分开是为了 `ASC_GC_STATS` 的
类型账目能区分「每帧的 Vector 载荷」和「可能漏掉的字节缓冲」——这正是泄漏排查需要的信息。

**写屏障**：写这些字段的位置全部补 `gc_write_barrier`（grow / set_length / compress /
uncompress / URL 读 / BitmapData 构造与两条 adopt）。理由同 §6.5.1：增量标记期对象可能是
BLACK，而刚 `gc_alloc` 出来的缓冲是 WHITE。

**非移动堆是这批改动的前提**：`gc_alloc` 不移动对象，交给 Skia / Metal 的缓冲指针在调用期间
一直有效；且两边**都是拷贝语义**（`SkImages::RasterFromPixmapCopy`、
`[tex replaceRegion:...withBytes:]`），不存在「库留着我方缓冲」的悬垂风险。

**顺带（同一行的另一半）**：`Context3D_submit` 每帧每个绑定流原本 `malloc`/`free` 一份
`nv*comp*8` 的顶点反交织临时缓冲（Benchmark 场景批次大时每帧数 MB 瞬时分配）。
`as_s3d_upload_vertex` 是同步拷贝，指针不出调用，因此改为**缓存复用**
（`s3d_submit_scratch_get`：容量不够才 `free`+`malloc`），每帧零 malloc/free。
`ASC_stage3d_pixels`（像素读回缓冲）仍是 `malloc`/`free`，读回是显式调用、不在帧循环里。

**验收**：

- `examples/gc_bytes.as`：① 40 轮 × 1 MB `ByteArray` churn 两轮 → `System.gc()` 后
  `totalMemoryNumber` 有界（实测 0 / 360 B）、RSS 不随轮数线性上涨（`privateMemory`
  1.4 → 3.6 MB 且第二轮持平）；② zlib compress/uncompress 缓冲可回收；③ 40 张 512×512
  `BitmapData`（不 `dispose`）可回收；④ `dispose()` 后可回收；⑤ 活着的 `ByteArray`/`BitmapData`
  跨 20 轮「**同尺寸**分配 + 收集」逐项核对（同尺寸是刻意的：逼出空闲链复用，否则松掉的
  标记测不出来）。
- **反向对照 1**（9 处 `gc_alloc(GCT_BYTES, …)` 还原成 `malloc`）：必 FAIL ——
  `FAIL: RSS did not grow by the churn size (privateMemory 1409024 → 42254336)`。
- **反向对照 2**（把 `data` / `pixels` 的反射表条目改成 type 4「标量、不跟」）：必 FAIL ——
  `FAIL: a live ByteArray keeps its first word across collections (got 0)`（缓冲被回收 + 复用清零）。
- `node test.ts`：113 passed / 0 failed；`examples/stage83.as --manifest`（Metal 真 GPU）通过。

**遗留（本阶段实测更正了此前的归因）**：Starling demo 逐轮 RSS 上涨**不是**这条字节缓冲泄漏。
在同一台机器、同一个 `temp/hidpi/cycle.py` harness 上，迁移前 175→206 MB（12 轮）、迁移后
175→202 MB，**斜率不变**；同期 `ASC_GC_STATS` 的 `as_big`（arena ≥1 MB 请求）**0 条**、
`leaks` 只有 **288 B**（18 × 16 B）、活动 malloc 16.7 → 17.1 MB 基本不变、GC 堆平（16 MB /
276 段）。也就是说 RSS 增长来自**分配器高水位**（`vmmap` 里 `MALLOC_MEDIUM/LARGE (empty)`
空区 10~60 MB 反复涨落，约每 8~10 轮返回一次），而不是可回收的活对象，也不是我们的字节缓冲。
注意当前 harness 的菜单点击落不到按钮上（窗口 640×1112 而渲染面 1800×1169，即已知的
`csf==2` Stage3D 缩放缺陷），因此上面这条曲线其实**不含**场景进出——它只是帧循环的高水位。

## 7. 与现有反射表的关系（复用，不重造）

| 现有设施 | GC 用途 |
|---|---|
| `as_prop` 反射表（`emit.ts:411` `propTypeTag`） | 用户类实例的**精确字段枚举**：type 6 ref / 7 any / 3 string 是引用要 mark，1 number/2 bool/4 int/5 uint 是值跳过 |
| `as_vtable_header` super 链 | 沿继承链 mark 父类字段（offset 在 struct 平铺继承下一致，`offsetof` 已成立） |
| `as_value` tag | 判断一个 `as_value` 是否持指针（3/4/6/7）及指针指向何类结构 |
| `as_method` 表 | 无关（方法不持对象图引用，闭包的 `env` 才是根） |

---

## 8. 核心风险清单

| 风险 | 后果 | 缓解 |
|---|---|---|
| **Shadow Stack 漏登记一个根** | 对象过早回收 → 悬空指针 → **随机崩溃** | 保守起步：全函数生命周期登记全部持指针局部；AST 预扫描穷尽；永久根单独登记 |
| 误保留（false retention） | 该回收的没回收，泄露残留 | 可接受（比崩溃安全）；后续可做 liveness 优化 |
| GC 触发点非安全点 | 栈上局部未登记就被回收 | 帧边界安全点（`Stage_dispatchFrame` 的 `gc_step()`，此时所有帧回调已返回，只剩永久根）+ 任意位置触发时的**保守 C 栈扫描**（`System.gc()`、中帧采集 §4.2.1、非 GUI 的分配阈值触发 §6.13） |
| **`System.gc()` 在任意位置触发（非安全点）** | 只有 C 局部持有的对象被扫掉 → 悬空指针 → `SIGSEGV`（阶段八十九·二十二：`Event` 池弹出后被回收再压回） | `gc_mark_roots()` 末尾做一次**保守栈扫描**（§4.2.1）：`[SP, main 锚点)` 逐字验证对象头（magic tag + 段内地址）后当根 mark；误保留只持续到下一次采集 |
| **段归还计数不精确（`free_bytes` 偏大）** | `free_bytes == size` 不再等价于「段空」→ 释放**仍有活对象**的段 → malloc 复用该地址 → 段内对象（含 `gc_all` 链表头、类实例 vtable 字）变成别人的数据 → 随机 `SIGSEGV`（阶段八十九·二十七：第二次跑 benchmark 崩溃，`gc_all` 被写成 double `0.9872449040412903`） | 分配计费按块的**实际尺寸**、且在切分之后扣除（§6.12），使 `free_bytes` 严格等于空闲链之和；`ASC_GC_AUDIT` 用活对象链对账（`DRIFT`/`RELEASING`），`examples/gc_seg_reap.as` 作常驻回归 |
| 保守栈扫描把垃圾当对象头（误标/调垃圾函数指针） | `gc_scan` 的 `GCT_CUSTOM` 会把垃圾当头里的函数指针调 | `GCT_*` 全部偏移 `GCT_TAG_BASE`，空闲/新切分块 `type=0`（任意位模式都不可能等于合法 tag）；`gc_is_object` 还要求 color/size 合法 |
| 保守栈扫描的栈字落在**段首** | 调用方读 `p - sizeof(gc_header)` 处的头字段落到段前未映射页 → `SIGBUS`（阶段八十九·二十四在 `stage57.as` `-O2` 下现形） | `gc_in_heap` 要求 `p >= base + sizeof(gc_header)`（首个对象体正在此位置，不会误拒合法对象） |
| `realloc` 迁移数组的悬空指针 | `as_dict`/`as_timers` 等 `realloc` 时旧指针失效 | GC 只扫登记在 shadow stack/全局根的指针；`realloc` 后必须更新引用（现有代码已注意此点） |
| **stop-the-world 停顿** | 触发帧主线程阻塞，堆大时可见卡顿 | 安全点触发 + 阈值控制频率；堆增大后必须引入**增量标记**（GC-4）才能真正消除，否则停顿随堆线性增长 |
| WASI 无 `getrusage` 等 | 内存统计退化 | `privateMemory` 已退化到 `totalMemory`（阶段五十二），GC 不影响 |
| **同一字段混用 GC 缓冲与 `malloc` 缓冲** | 对 GC 缓冲调 `free()` 会把它链进 malloc 的空闲链、砸坏 GC 的空闲链 → 随机崩溃；`malloc` 缓冲则永不回收 | 所有权单一：`ByteArray.data` / `BitmapData.pixels` 只能由 `gc_alloc(GCT_BYTES)` 产生（glue 的 `malloc` 结果一律 `memcpy` 进 GC 缓冲后 `free`）；新增/改动这些写点必须同时补 `gc_write_barrier`（§6.14） |

---

## 9. 参考

- AGENTS.md §2.4「内存管理红线」：禁止热路径 arena 临时分配（GC 落地后此红线可放宽为「临时对象走 GC」）
- `TODO.md` 阶段五十六（泄露定位）+ 阶段五十七（本文对应立项）
- AS3/AVM2 精确 GC 语义参照：avmplus `GCObject` / Ruffle `gc_arena`（`Gc<'gc>`），仅借语义、不移植
- V8 Orinoco 设计（trash-talk, 2019）：https://v8.dev/blog/trash-talk —— parallel/concurrent 因 WASI 单线程不可
  移植，incremental + 代际思想可借鉴（见 §2.4 / §6）
