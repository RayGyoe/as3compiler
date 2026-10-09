# strings — 字符串 split/join/indexOf/toUpperCase/lastIndexOf（字符串分配基准）

## 说明
对固定句子循环 300,000 次执行 `split(" ").join("-")`、`indexOf("fox")`、
`toUpperCase().length`、`split("quick").join("slow").lastIndexOf("o")` 并累加校验和。
测量字符串分配与常用字符串操作性能。

> 注：本基准需要「替换全部」语义；as3compiler 的字符串版 `String.replace` 只替换第一个匹配，
> 故四路统一用 `split().join()`（与原生 AS3 参考版一致）。

## 规模与结果
- 循环次数：300,000；每次迭代执行 3 组字符串操作
- 校验结果（四路一致）：`result=29700000`
- **每轮迭代约 16 次 GC 分配**（2 个 `Array` + 14 个 `String`，见 §1）

## 性能（纯计算时间，v0.4.93 轮单批 × 内部 3 次取中位数；越低越好）

| 实现 | 耗时 (ms) | 相对 C |
|------|----------:|-------:|
| C (cc -O2) | 81 | 1.00× |
| JavaScript (Node v24) | 99 | 1.22× |
| **as3compiler** (→ C → cc -O2) | **210** | **2.59×** |
| 原生 AS3 (AIR/mxmlc) | 888 | 10.96× |

> **v0.4.93 更新**：本项从 243 ms（v0.4.92）降到 **210 ms（−14%，同期 C 列 80→81 未漂）**——
> 归因与改动见 §3/§3b（**GC 空闲链按尺寸分级**，受控 A/B 实测 −15%）。相对 AVM2 的倍数
> 从 3.68× 抬到 **4.23×**。

## 分析

### 1. 差距 96% 是 **split/join 的分配**，不是字符串操作、不是 GC 回收

**变体归因**（同一份生成 C，按行区间切块替换；`temp/bench/invest/strings_attr2.py`）：

| 变体 | 耗时 | 结论 |
|---|---:|---|
| v0 原样 | 241 ms | 基线 |
| v1 去显式 `System.gc()`（6 次） | 232 ms | 显式 GC 仅 **~9 ms** |
| v4 零分配下限（只剩 `indexOf`/`strlen`/`lastIndexOf` 扫描） | **0 ms** | **字符串扫描本身免费** |
| v3 去 split/join（保留 `toUpperCase`） | 10 ms | `toUpperCase` 配一次分配 ≈ 10 ms |
| v6 只保留第一轮 split+join | 136 ms | 第一轮（`split(" ")`+`join("-")`）≈ 136 ms |

即 **~231/241 ms（96%）在 `split().join()`**，其中第一轮 11 次分配占 136 ms、第二轮 4 次分配
占 ~95 ms。字符串比较/查找（`indexOf`/`lastIndexOf`/`strlen`）**≈ 0 ms**。

### 2. 拆到分配器：GC 分配 ≈ 93 ms，GC 回收 ≈ 50 ms

**（a）GC 分配器每次调用的开销（~93 ms，38%）**
把 `as_str_alloc` 改走 arena bump 分配（同样的字节数、无 free-list、无 memset、无计数）：

| 变体 | 耗时 |
|---|---:|
| v0 字符串走 GC 堆 | 248 ms |
| v7 字符串走 **arena bump**（GC 仍在） | **152–159 ms** |

⇒ **~90 ms 是 GC 分配器的每次调用开销**。计数探针实测 **5,700,645 次 `gc_alloc`**
（`temp/bench/invest/strings_alloc.py`），其中字符串分配 ≈ 420 万次 ⇒ **≈ 21 ns/次**。

**（b）GC 回收本身（~50 ms，20%）**
给 `gc_collect` 加计时（`strings_gc.py`）：全程 **60 次回收、累计 49.8 ms**（≈0.83 ms/次）。
注意自动触发的回收（54 次）远多于源码里写死的 6 次显式 `System.gc()` —— 所以「本项受回收支配」
的说法要限定在**自动回收**上。

### 3. 为什么这 ~93 ms 值得单独看：**free-list first-fit 随表长线性退化**

关掉回收会让本项 **慢 3×（733 ms）**，而不是变快。原因不是「回收有净收益」那么笼统：
关掉回收后空闲块不再被复用，`gc_alloc` 的**首次适配空闲链遍历长度随堆线性增长**，单次分配
成本被拉高（旧报告 §4 的 O(N²) 表格是同一现象的另一侧）。这说明单次分配成本的**主因是
free-list 遍历**，而它**可以**被改掉（按 size class 分级空闲链 / 分离小对象链），
属于运行时实现优化，**不触碰任何 AS3 语义、也不是前端做优化**（`AGENTS.md` §1 不适用）。

### 3b. 已落地：空闲链按尺寸分级（阶段一百二十，v0.4.93）⇒ **−15%**

按上面的判据重构 `gc_alloc`/`gc_free` 的空闲链：`gc_free_small[16]`（32 B 一级，上限 512 B）
+ `gc_free_mid` + `gc_free_big`，`gc_find_block` 从请求尺寸所属的类**向上爬**到第一个能放下的块；
**块尺寸不取整**（精确尺寸，`free_bytes` 段账目与 `gc_release_empty_segs` 的判定逐字不变）。

**受控 A/B（同一份生成的 C，只改分配器；`temp/sc/`，每行 ≥3 次读数）**：

| 变体 | strings (ms) |
|---|---:|
| 老的两分链（`free_small` + `free_big`） | 248 / 251 / 273 |
| **尺寸分级** | **211 / 211 / 212** |
| 反向实验：分级但**只搜精确类**（不爬类） | —（该变体在 `binarytrees` 上是 7m23s / 4300×，见 `binarytrees/report.md`） |

即 ~37 ms 直接从「单链 first-fit 的线性退化」里拿回来（570 万次分配 ⇒ 每次约省 6–7 ns）。
**这是 `AGENTS.md` §1.4 的「语义等价时选快的那条路」**：箱子语义、回收时机、`free_bytes`
账目全部不变，只换了空闲链的组织方式。

> 旧报告曾断言 3.01× 是「装箱税主导（固有）」、无合法头部空间。该结论**过于悲观**：
> `split()` 必须返回 `String` 数组（语义要求，无法「模式融合」消除），但**每次分配的成本**
> 是纯实现选择，上面 38% 就在这一项里 —— v0.4.93 已把其中一半拿回来（§3b）。

### 4. 其余组成（分级后的账）
分级后的 210 ms ≈ **split/join 本体 ~100 ms（48%）** + **分配 ~60 ms（29%）** +
**回收 ~50 ms（24%）**。本体部分是 `as_array_join` 两遍扫（先量长再拷贝，每个元素 2 次 `strlen`）、
`as_str_split` 的逐段 `strstr` + 拷贝、`as_array_push` 的按需扩容，与 C 参考版
（81 ms，3 次 `malloc`）同量级；回收部分（60 次、累计 49.8 ms）本轮**未动**。

### 5. 与原生 AS3 对比
AOT 210 ms vs AVM2 888 ms，快 **4.23×**。AVM2 每次字符串操作都产生新对象且同样有 GC 压力，
差距主要来自 AOT 侧更省的装箱/分配路径。

## 历史（GC 下限策略，仍有效）
本项与 `binarytrees` 一起受**离屏回收下限**支配：272 ms（v0.4.0，1 MiB 下限）→ **229 ms**
（v0.4.3，8 MiB 下限）→ 241 ms（v0.4.69）。相位分解显示本项**存活集≈0，`drain` 恒为 0**，
开销全在 `sweep`（∝ 垃圾量）与 `prep`，故其收益机制是「更少的次数 × 每次扫更多垃圾」。
`st_nogc` 下限扫描（去显式 `System.gc()`）：1 MiB 256 ms / **8 MiB 222 ms（9 MB RSS）** /
16 MiB 215 ms（17 MB RSS）/ 256 MiB 352 ms / 关闭 732 ms（453 MB）。选 8 MiB 是因只差
7 ms 而峰值 RSS 近乎翻倍。v0.4.92 的 243 与 v0.4.69 的 241 的差属批次波动；
**v0.4.93 的 210 ms 不是波动**（同 C 的受控 A/B 同期实测 −15%，见 §3b）。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 原生 AIR 的 `adl` 启动开销（约 2.6s）不计入。
- 基准本身的计时区域包含其源码中写入的 6 次显式 `System.gc()`。
- 变体归因脚本与产物留 `temp/bench/invest/`（`strings_attr2.py` / `strings_alloc.py` /
  `strings_gc.py`），测量后不随基准提交。