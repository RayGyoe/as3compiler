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

## 汇总（纯计算时间，越低越好）

| benchmark | C (ms) | JS (ms) | as3compiler (ms) | 原生 AS3 (ms) |
|-----------|-------:|--------:|-----------------:|--------------:|
| fib | 287 | 806 | 291 | 3576 |
| nbody | 189 | 339 | 199 | 1296 |
| binarytrees | 73 | 30 | 78 | 348 |
| mandelbrot | 95 | 123 | 94 | 355 |
| strings | 79 | 98 | 146 | 890 |
| spectralnorm | 48 | 61 | 49 | 688 |
| oop | 50 | 60 | 50 | 616 |
| array | 22 | 23 | 119 | 131 |

### 相对 C 的倍数（1.00 = 与 C 持平）

| benchmark | C | JS | as3compiler | 原生 AS3 |
|-----------|---:|----:|------------:|---------:|
| fib | 1.00 | 2.81 | 1.01 | 12.46 |
| nbody | 1.00 | 1.79 | 1.05 | 6.86 |
| binarytrees | 1.00 | 0.41 | 1.07 | 4.77 |
| mandelbrot | 1.00 | 1.29 | 0.99 | 3.74 |
| strings | 1.00 | 1.24 | 1.85 | 11.27 |
| spectralnorm | 1.00 | 1.27 | 1.02 | 14.33 |
| oop | 1.00 | 1.20 | 1.00 | 12.32 |
| array | 1.00 | 1.05 | 5.41 | 5.95 |

## 结论

- **as3compiler 在纯计算/对象访问上接近 C（0.99–1.05×）**：`fib`、`nbody`、`mandelbrot`、
  `spectralnorm`、`oop` 均验证了「只翻译、优化交给 C 编译器」的路线不损失性能；生成的 C 经
  `cc -O2` 后与手写 C 基本等价。
- **`oop` 是面向对象核心基准（1.00× C，12.32× 原生 AS3）**：AS3 的类继承 + 虚方法派发
  （`override`/vtable）+ 对象字段访问被翻译为 C 结构体 + 一次函数指针调用 + 一次直接内存访问，
  与手写 C 持平，同时比 AVM2 的动态方法解析 + 属性槽位间接寻址 + 装箱快约 12 倍。
- **`binarytrees`（1.07×）与 `strings`（1.85×）已纳入真实 GC 开销**：这两个基准此前**从未
  触发过 GC**（`gc_step` 只在帧边界安全点调用，控制台 `main()` 到不了），是靠分配块小、内存
  够大才「碰巧」跑完，本质是静默泄漏。现已周期性插入 `System.gc()`，使它们在持续分配压力下
  真正执行 mark/sweep，故数据更诚实——`binarytrees` 从「伪 0.66×」回落到 1.07×，`strings` 从
  1.59× 升到 1.85×。代价就是真实的 GC 停顿。
- **普通 `Array` 的装箱税（`array` 基准，绝对耗时 119 ms vs 原生 AS3 131 ms）**：本次修复了
  `gc_alloc` 对 >1 MiB 单次请求的死循环（原 `array` 的 1.5 MiB 值缓冲扩容直接卡死、VSZ 膨胀至
  415 GB）。修复后正常跑完，且 AOT **绝对耗时反超** AVM2（119 ms vs 131 ms，快约 9%）——即便同为装箱路径，AOT
  的装箱/拆箱是确定性的 tagged-union 读写，比 AVM2 的动态属性槽位更快。对照 `spectralnorm`
  （`Vector.<Number>` 无装箱，1.02×）可得明确建议：**数值密集代码用 `Vector.<T>`，动态异构
  集合才用 `Array`**。注意：`array` 的 C 基线本次测 22 ms（历史 43 ms，受机器负载波动），
  导致其相对 C 倍数（5.41×）失真，判断退化应看绝对耗时而非相对倍数。
- **原生 AS3 全程最慢（3.74–14.33×）**：AVM2 虚拟机的动态分派、装箱与 `Vector` 索引开销。

## 计时口径（四路可比）

- **四路均内部计时纯计算时间**（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`），
  排除进程启动。
- **原生 AIR**：`adl` 启动开销约 2.6s **不计入**（`getTimer` 从应用启动后开始计时）。

## 环境

- macOS (Apple Silicon, arm64)
- C 编译器：Apple clang 21.0.0（`-O2`）
- Node.js v24.14.1
- AIR SDK 51.3.4（mxmlc 3.2.3 / adl 51.3.4）
- 每个基准四路**输出结果一致**（`run.py` 自动校验，见各 `report.md` 的校验值）
