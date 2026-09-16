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

### 4.2 根集合 = Shadow Stack（`emit.ts` codegen，最大工作量 + 最大风险）

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

### 4.3 迁移分配点

| 对象 | 现状 | 迁移后 |
|---|---|---|
| as_array / as_closure | `as_alloc`（arena） | `gc_alloc(GCT_ARRAY/GCT_CLOSURE, size)` |
| as_object / as_dict / 用户类 / as_regex | `malloc` | `gc_alloc(GCT_*, size)` |
| 字符串 | arena bump | `gc_alloc(GCT_STRING, len+1)` |
| 常驻对象（stage/显示列表/vtable/静态字段） | 各分配 | **保持不动或登记为永久根**（本就不回收） |

字符串纳入 GC 单独列为 **GC-2**（§5），因为字符串是裸 `char*` 无 header，且当前 `as_str_from_*`/
`as_str_concat` 等所有字符串构造都走 arena，改动面最大、回归风险最高，故拆成独立子阶段。

---

## 5. 四阶段拆解与验收标准

| 子阶段 | 目标 | 纳入回收的对象 | 验收 |
|---|---|---|---|
| **GC-1** | GC 堆 + Mark-Sweep + Shadow Stack 根，**native 先跑通** | array / object(record) / dict / closure / 用户类实例 | `examples/stage57.as` 长循环 `new` 大量对象后 `System.totalMemory` 不随轮次线性增长；窗口 demo 长时间运行 MEM 稳定；回归旧示例无破坏 |
| **GC-2** | 字符串纳入 GC | 字符串 | `trace`/`text.text` 高频拼接后内存稳定 |
| **GC-3** | WASI 目标验证 + 长时间运行回归 | （同上） | `--target wasm` 下同样回收；native+wasm 双目标长时间运行零悬空 |
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
用「每帧最多扫 N 个对象」的**确定性预算**（比时间预算好：跨平台一致、不依赖 `clock`）。N 可调，
典型值 100~500，保证每帧 GC 耗时 < 1ms。

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

---

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
| GC 触发点非安全点 | 栈上局部未登记就被回收 | 只在 `Stage_dispatchFrame` 安全点触发（此时所有帧函数已返回，shadow stack 仅剩永久根） |
| `realloc` 迁移数组的悬空指针 | `as_dict`/`as_timers` 等 `realloc` 时旧指针失效 | GC 只扫登记在 shadow stack/全局根的指针；`realloc` 后必须更新引用（现有代码已注意此点） |
| **stop-the-world 停顿** | 触发帧主线程阻塞，堆大时可见卡顿 | 安全点触发 + 阈值控制频率；堆增大后必须引入**增量标记**（GC-4）才能真正消除，否则停顿随堆线性增长 |
| WASI 无 `getrusage` 等 | 内存统计退化 | `privateMemory` 已退化到 `totalMemory`（阶段五十二），GC 不影响 |

---

## 9. 参考

- AGENTS.md §2.4「内存管理红线」：禁止热路径 arena 临时分配（GC 落地后此红线可放宽为「临时对象走 GC」）
- `TODO.md` 阶段五十六（泄露定位）+ 阶段五十七（本文对应立项）
- AS3/AVM2 精确 GC 语义参照：avmplus `GCObject` / Ruffle `gc_arena`（`Gc<'gc>`），仅借语义、不移植
- V8 Orinoco 设计（trash-talk, 2019）：https://v8.dev/blog/trash-talk —— parallel/concurrent 因 WASI 单线程不可
  移植，incremental + 代际思想可借鉴（见 §2.4 / §6）
