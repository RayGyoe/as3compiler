# benchmarks — as3compiler 性能基准

对比四种实现同一算法时的性能：**C**、**JavaScript (Node)**、**as3compiler**（AS3 → C → cc）与
**原生 AS3 (AIR/mxmlc)**。每个子目录含 4 个源文件 + `report.md`：

```
benchmarks/<name>/
├── <name>.c            # C 实现（内部 clock_gettime 计时）
├── <name>.js           # JavaScript 实现（内部 hrtime 计时）
├── <name>.as           # as3compiler 版（纯 AS3，内部 Date.getTime 计时）
├── <name>_air.as       # 原生 AIR AS3 版（内部 getTimer 计时）
├── <name>_air-app.xml  # AIR 描述符（mxmlc/adl 运行所需）
└── report.md           # 该基准的结果与分析
```

## 运行

```bash
# 全部 8 个基准（编译四路 + 各跑 3 次取中位数 + 校验四路结果一致）
python3 benchmarks/run.py

# 只跑指定基准
python3 benchmarks/run.py fib nbody
```

依赖：Node ≥ 22.6、系统 `cc`/`clang`、AIR SDK（通过环境变量 `AIRSDK_HOME` 指向 SDK 根目录，
默认 `/Users/ray.lei/Documents/Software/AIRSDK/AIRSDK_51.3.4`）。

## 本次结果（编译器 v0.4.3，2026-09-27）

**三个独立批次**（每批四路各内部跑 3 次取中位数，再取三批的中位数），全部 8 项四路**输出结果一致**。
跑批全程源码哈希冻结（`runtime.ts` `3842aad5…`、`emit.ts` `1c5419ef…`、`symbols.ts` `f8e4dc35…`、
`parser.ts` `6ed580d6…`、`ast.ts` `944f3d37…`），四路编译产物由同一修订生成。

| benchmark | C (ms) | JS (ms) | as3compiler (ms) | 原生 AS3 (ms) | AOT vs C | AOT vs AIR |
|-----------|-------:|--------:|-----------------:|--------------:|---------:|-----------:|
| fib | 290 | 797 | 291 | 3615 | 1.00× | 12.42× 快 |
| nbody | 189 | 340 | 194 | 1301 | 1.03× | 6.71× |
| binarytrees | 73 | 30 | 97 | 345 | 1.33× | 3.56× |
| mandelbrot | 95 | 123 | 95 | 358 | 1.00× | 3.77× |
| strings | 80 | 99 | 229 | 894 | 2.86× | 3.90× |
| spectralnorm | 48 | 62 | 48 | 696 | 1.00× | 14.50× 快 |
| oop | 49 | 60 | 55 | 620 | 1.12× | 11.27× |
| array | 21 | 23 | 119 | 131 | 5.67× | 1.10× 快 |

### 与上一轮（v0.4.0）的逐项对比

| benchmark | v0.4.0 AOT | v0.4.3 AOT | 变化 | 判定 |
|-----------|-----------:|-----------:|-----:|------|
| fib | 288 | 291 | +1% | 持平 |
| nbody | 193 | 194 | +1% | 持平 |
| **binarytrees** | **293** | **97** | **−67%** | ✅ 修复（离屏回收下限，见 GC 专项） |
| mandelbrot | 94 | 95 | +1% | 持平 |
| **strings** | **272** | **229** | **−16%** | ✅ 修复（同上） |
| spectralnorm | 48 | 48 | 0% | 持平 |
| oop | 55 | 55 | 0% | 持平 |
| array | 119 | 119 | 0% | 持平 |

> 本轮唯一的行为变更是 **GC 触发策略**（阶段八十九·四十七）：上一轮登记为「待评估」的
> 「非 GUI 自动回收阈值下限偏低」已修复。它只影响**高分配量的离屏负载**，故只有
> `binarytrees`/`strings` 两项数字变化；其余 6 项（含全部零分配项）落在 ±1% 噪声内。

### 相对 C 的倍数（1.00 = 与 C 持平）

| benchmark | C | JS | as3compiler | 原生 AS3 |
|-----------|---:|----:|------------:|---------:|
| fib | 1.00 | 2.75 | 1.00 | 12.47 |
| nbody | 1.00 | 1.80 | 1.03 | 6.88 |
| binarytrees | 1.00 | 0.41 | 1.33 | 4.73 |
| mandelbrot | 1.00 | 1.29 | 1.00 | 3.77 |
| strings | 1.00 | 1.24 | 2.86 | 11.18 |
| spectralnorm | 1.00 | 1.29 | 1.00 | 14.50 |
| oop | 1.00 | 1.22 | 1.12 | 12.65 |
| array | 1.00 | 1.10 | 5.67 | 6.24 |

> `JS` 列方差最大（如 `spectralnorm` 读数 54–62 ms），相对倍数仅供参考；
> 判断 AOT 是否退化应看**绝对耗时**与**相对原生的倍数**，而非对 C 基线敏感的比值。

## 结论

- **不分配堆的项仍贴着 C（1.00–1.03×）**：`fib`、`nbody`、`mandelbrot`、`spectralnorm`
  落在 1.00–1.03×。这再次验证「前端只翻译、优化交给 `cc -O2`」的路线在调用密集、浮点密集、
  向量索引密集三类负载上都不损失性能。
- **`spectralnorm`（1.00× C，14.50× 原生）是 AOT 相对原生差距最大的一项**：`Vector.<Number>`
  单态化为连续 `double` 数组，索引读写生成带边界检查的直接访存；AVM2 的 `Vector` 索引每次
  都要走方法分派，密集内层循环无法被有效优化。
- **`binarytrees` 从 4.07× 降到 1.33× C**：上一轮那 4.07× 有 3/4 是**离屏自动回收的 CPU 开销**
  （存活集 ~1 MB 却按 1 MiB 间隔回收了 154 次，光重新标记存活集就 166 ms），本轮把离屏下限抬到
  8 MiB 后只需 24 次、GC 总时间 247 → 50 ms（见 GC 专项）。剩余 1.33× 是基准自身 20 次显式
  `System.gc()` 的真实成本。相对原生 AS3 快 3.56×。
- **`strings`（2.86× C）**：主要仍是**装箱税**（`split/join` 的中间 `Array` 走 24 B `as_value`），
  离屏下限抬高后又省下约 43 ms。相对原生 AS3 快 3.90×。
- **`array`（5.67× C）是装箱税的纯净基准**：`as_value` 是 24 B tagged union（`int tag` +
  `double num` + `void* ptr`），而 C 版是 4 B 原生 `int`。20 M 元素的遍历分别搬运 ≈480 MB
  与 ≈80 MB，两者都跑在内存带宽上（≈4 GB/s），故耗时比（5.67×）≈ 体积比（6×）——
  **差距的根因是每元素体积，不是访存指令数**。反面参照 `oop`（同样走 `Array` 装箱，
  但工作集 4.6 KB 常驻 L1 → 1.12×）。结论：**数值密集代码用 `Vector.<T>`，动态异构集合才用 `Array`**。
- **`oop`（1.12× C，11.27× 原生）**：类继承被翻译为 C 结构体 + vtable，`override` 虚调用变成
  一次函数指针间接调用、字段访问变成一次直接内存访问。比 v0.3.128 的 1.04× 略慢，根因是
  **顶层脚本变量被正确提升为全局**（v0.3.130 的语义修复）；把热循环放进函数后即为 0.96× C。
- **原生 AS3 全程最慢（3.56–14.50×）**：AVM2 的动态分派、装箱与 `Vector` 索引开销。

---

## GC 回收策略专项（本轮重写，v0.4.3）

### 0. 本轮改动：离屏下限由 1 MiB 抬到 8 MiB + 触发判定缓存

上一轮（v0.4.0）把「非 GUI 自动回收阈值下限偏低」登记进 `TODO.md` 遗留表，本轮先做**计时分解**
再定方案（阶段八十九·四十七）。机制（`src/runtime.ts`）：

```c
// 非 GUI 触发：从未派发过帧 → 没有别的东西会调用 gc_step()，于是这里自己收。
if (!gc_frame_driven && gc_inc.state == GC_IDLE) {
    if (gc_trigger_next == 0) gc_trigger_next = gc_trigger();   // 缓存，仅在回收后失效
    if (gc_bytes_allocated >= gc_trigger_next) gc_collect();    // stop-the-world
}
...
size_t floor = gc_frame_driven ? gc_threshold : GC_NONGUI_FLOOR;  // 1 MiB vs 8 MiB
return adaptive > floor ? adaptive : floor;
```

两条路径的目标本就相反，此前却共用同一个下限：

| 路径 | 目标 | 合适下限 |
|---|---|---|
| 帧驱动（`gc_step`，Starling 等） | 每帧停顿有界、小堆要及时开始切片 | 1 MiB（**未改**） |
| 非 GUI（`gc_alloc` 的 stop-the-world） | 无帧时限，要摊薄**单次固定开销** | **8 MiB**（本轮改） |

### 1. 计时分解：一次回收的开销由「重新标记存活集」主导，与累积了多少垃圾无关

方法：临时在 `gc_collect()` 内按相位计时（`prep` = `gc_new` 归位 + `gc_all` 全链置白、
`internal`/`user`/`stack` = 三类根、`drain` = `gc_mark_drain`、`sweep`、`finish`），
`ASC_GC_STATS` 门控 + `atexit` 汇总；用 `ASC_GC_THRESHOLD` 扫不同回收间隔（**测完即删**）。

**binarytrees**：

| 相位 / 单次 | 1 MiB | 4 MiB | 16 MiB | 64 MiB |
|---|---:|---:|---:|---:|
| 回收次数 | 154 | 45 | 24 | 20 |
| `drain`（标记） | **1.08 ms** | 1.04 | 1.02 | 1.03 |
| `sweep` | 0.34 | 0.51 | 0.75 | 0.85 |
| `prep` | 0.20 | 0.25 | 0.34 | 0.37 |
| `stack`（保守栈扫描）**总计** | **0.3 ms / 154 次** | 0.1 | 0.1 | 0.0 |
| **GC 总计** | 247–258 ms | 81 | 50 | 45 |

三点结论：

1. **`drain` 单次开销恒定（≈1.05 ms）**：它 ∝ 存活集（~1 MB，不随间隔变化），与「上次回收后
   累积了多少垃圾」无关。所以**总 GC 时间 ≈ 次数 × 常数**，唯一杠杆是「少收」。
2. **`sweep`/`prep` 只随间隔缓涨**：空闲块会被复用，`gc_all` 长度约等于存活集，故这两项也近似
   ∝ 存活集（不是 ∝ 垃圾量），只是间隔越大保留的块越多。
3. **保守栈扫描完全不是瓶颈**：154 次 `gc_mark_stack` 合计仅 0.3 ms（0.3%），此前怀疑的
   「深栈逐字扫描」被排除。

`strings` 是另一副形状：存活集≈0 ⇒ `drain` = 0，开销全在 `sweep`（∝ 垃圾量），所以它的收益随
间隔增长得**更缓**（1 MiB → 74 ms，16 MiB → 46 ms，256 MiB → 29 ms），但方向一致。

### 2. 修法一：下限按路径二分（`GC_NONGUI_FLOOR` = 8 MiB）

| 离屏下限 | binarytrees | strings | bt 峰值 RSS |
|---|---:|---:|---:|
| **1 MiB（改前）** | 287 ms | 258 ms | 9 MB |
| 4 MiB | 120 ms | 232 ms | 12 MB |
| **8 MiB（选定）** | **97 ms** | **229 ms** | **15 MB** |
| 12 MiB | 88 ms | 236 ms | 19 MB |
| 16 MiB | 88 ms | 218 ms | 23 MB |
| 24 MiB | 82 ms | 239 ms | 30 MB |

- `binarytrees` 在 **12 MiB 后饱和**（88 ms），8 MiB 已拿到 96% 的可得收益，而内存开销只有
  16 MiB 方案的一半；`strings` 曲线非单调（218–239 ms 波动），8 MiB 与 16 MiB 无实质差别。
- **代价**是离屏程序最多多驻留一块下限的垃圾（峰值 RSS 9 → 15 MB）；内存断言最严的
  `examples/gc_bytes.as` 在 8 MiB 下**原界即通过**。
- 12 MiB 以上不再有收益，是因为离屏触发此时已退化到与「基准自身的显式 `System.gc()`」同频。

### 3. 修法二：触发阈值缓存（`gc_trigger_next`）

`gc_trigger()` 需要汇总 24 个 `gc_dbg_type_*` 计数，而 `gc_alloc` **每次分配**都要判定一次。
用 `ASC_GC_THRESHOLD`（`override_threshold` 短路该求和）与默认路径交错对比，稳定差
**87/88 ms vs 98 ms**——也就是说**上一轮报告里被当成「批次波动」的 293 vs 277 ms 其实是这个开销**。
现在把阈值缓存进 `gc_trigger_next`，只在 `gc_finish_cycle`（存活集刚变）失效重算，
每次分配退回一次整数比较。

### 4. 一个硬上限：floor 不能 ≥ 回归测试的总 churn

`examples/gc_alloc_threshold.as` 的总垃圾量实测 **17.8 MB**（1000 次 `churn`）。floor 一旦 ≥ 该值，
该测试里**永远不会触发自动回收**、断言随之失去意义（32 MiB 时实测 `afterChurn` = 17.77 MB，
即完全没回收）。所以本旋钮的可用区间是 **≤ 16 MiB**，8 MiB 落在安全侧。该测试的峰值界已同步改为
`FLOOR_BOUND`（8 MiB 下限 + 一块余量），注释里的过期数字（「1 MiB 下限 / 每轮 50 KB / 共 5 MB」）
也按实测更正；`gc_bytes.as` 不改。

### 5. GUI / 帧路径零影响（论证）

唯一改动是下限选择：`gc_frame_driven` 为真时仍取 `gc_threshold`（1 MiB，与改前相同）；
`gc_trigger_next` 只被非 GUI 分支读取，帧路径仍每帧直接调用 `gc_trigger()`。因此 Starling 等
帧驱动程序的每帧回收频率与内存目标不变（`test.ts` 全部 GUI/离屏示例通过）。唯一可观测差异在
**首帧派发之前**的窗口（GUI 程序启动瞬时也走离屏分支），其阈值由 1 MiB 变为 8 MiB。

---

## 计时口径（四路可比）

- **四路均内部计时纯计算时间**（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`），
  排除进程启动。
- **原生 AIR**：`adl` 启动开销约 2.6s **不计入**（`getTimer` 从应用启动后开始计时）。
- `array` 的填充阶段（`push` 2000 万次）不计入计时，仅累加遍历计入。
- 阈值扫描、回收计数与 `st_nogc` 对照由**临时变体/临时补丁**测得（改 `ASC_GC_THRESHOLD`
  环境变量或注入计数器后重编），测量后即删，不随基准提交。基准本身的计时区域包含其源码中
  写入的显式 `System.gc()` 调用。

## 环境与版本

- 编译器：**as3compiler v0.4.3**（跑批三批期间 `src/` 哈希冻结：
  `runtime.ts` `3842aad5…`、`emit.ts` `1c5419ef…`、`symbols.ts` `f8e4dc35…`、`parser.ts` `6ed580d6…`、`ast.ts` `944f3d37…`）
- macOS (Apple Silicon, arm64)
- C 编译器：Apple clang 21.0.0（`-O2`）
- Node.js v24.14.1
- AIR SDK 51.3.4（mxmlc 3.2.3 / adl 51.3.4）
- 每个基准四路**输出结果一致**（`run.py` 自动校验，见各 `report.md` 的校验值）

> **关于本次重跑**：v0.4.0 → v0.4.3 只有一项源码变更——**GC 离屏触发策略**（阶段八十九·四十七：
> `GC_NONGUI_FLOOR` + `gc_trigger_next`）。它只触及高分配量离屏负载，故只有 `binarytrees`
> （293 → 97 ms）与 `strings`（272 → 229 ms）变化，其余 6 项在 ±1% 噪声内。同期
> `%=`/AGAL/渲染/网络调研等改动均不触及控制台负载的热路径。

### 历史修正

- **「多出的耗时就是 GC 停顿」是按相位分解后才看清的错误归因**（v0.4.0 报告仍未纠正）：
  当时对 `binarytrees`/`strings` 的默认值 272/293 ms 只归因于「真实 GC 停顿」，把**因果搞反**了——
  按相位分解，其中绝大部分是「每次回收都要重新标记存活集」的固定成本**乘以过大的次数**。
  本轮把次数降下来，两项同时变快，`strings` 的内存也一并下降（完全关闭自动回收是 712 ms / 453 MB）。
- 上一轮把 `binarytrees` 的 **293 vs 277 ms** 记为「批次波动」，**实为 `gc_trigger()` 逐次汇总
  24 个计数的开销**，本轮已由 `gc_trigger_next` 消除。
- `array` 的 **C 基线曾误记为 43 ms**：那次测量发生在 `array_asc` 因 `gc_alloc` 超大分配死循环
  而占用 ~415 GB 虚拟地址空间的同一时段，整机内存压力污染了所有读数。该死循环已修复
  （现为超大请求分配专用段），C 基线稳定在 21–22 ms。
- `strings`/`binarytrees` 的 **187 / 80 ms（v0.3.128 记录）现仅对应「关闭自动回收」**；
  272 / 293 ms 对应 **1 MiB 下限**（v0.3.137–v0.4.0）；v0.4.3 起为 **229 / 97 ms**（8 MiB 下限）。
  三者不是同一配置，不可直接比较。
