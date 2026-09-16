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
| fib | 292 | 803 | 297 | 3627 |
| nbody | 191 | 346 | 221 | 1300 |
| binarytrees | 73 | 32 | 81 | 353 |
| mandelbrot | 97 | 127 | 97 | 353 |
| strings | 81 | 101 | 162 | 921 |
| spectralnorm | 47 | 55 | 48 | 692 |
| oop | 48 | 60 | 50 | 623 |
| array | 43 | 24 | 123 | 151 |

### 相对 C 的倍数（1.00 = 与 C 持平）

| benchmark | C | JS | as3compiler | 原生 AS3 |
|-----------|---:|----:|------------:|---------:|
| fib | 1.00 | 2.75 | 1.02 | 12.42 |
| nbody | 1.00 | 1.81 | 1.16 | 6.81 |
| binarytrees | 1.00 | 0.44 | 1.11 | 4.84 |
| mandelbrot | 1.00 | 1.31 | 1.00 | 3.64 |
| strings | 1.00 | 1.25 | 2.00 | 11.37 |
| spectralnorm | 1.00 | 1.17 | 1.02 | 14.72 |
| oop | 1.00 | 1.25 | 1.04 | 12.98 |
| array | 1.00 | 0.56 | 2.86 | 3.51 |

## 结论

- **as3compiler 在纯计算/对象访问上接近 C（1.00–1.16×）**：`fib`、`nbody`、`mandelbrot`、
  `spectralnorm`、`oop` 均验证了「只翻译、优化交给 C 编译器」的路线不损失性能；生成的 C 经
  `cc -O2` 后与手写 C 基本等价。
- **`oop` 是面向对象核心基准（1.04× C，12.98× 原生 AS3）**：AS3 的类继承 + 虚方法派发
  （`override`/vtable）+ 对象字段访问被翻译为 C 结构体 + 一次函数指针调用 + 一次直接内存访问，
  与手写 C 持平，同时比 AVM2 的动态方法解析 + 属性槽位间接寻址 + 装箱快约 13 倍。
- **`binarytrees`（1.11×）与 `strings`（2.00×）已纳入真实 GC 开销**：这两个基准此前**从未
  触发过 GC**（`gc_step` 只在帧边界安全点调用，控制台 `main()` 到不了），是靠分配块小、内存
  够大才「碰巧」跑完，本质是静默泄漏。现已周期性插入 `System.gc()`，使它们在持续分配压力下
  真正执行 mark/sweep，故数据更诚实——`binarytrees` 从「伪 0.66×」回落到 1.11×，`strings` 从
  1.59× 升到 2.00×。代价就是真实的 GC 停顿。
- **普通 `Array` 的装箱税（`array` 基准，2.86×，已从 7.84× 大幅收窄）**：本次修复了
  `gc_alloc` 对 >1 MiB 单次请求的死循环（原 `array` 的 1.5 MiB 值缓冲扩容直接卡死、VSZ 膨胀至
  415 GB）。修复后正常跑完，且 AOT（2.86×）**反超** AVM2（3.51×）——即便同为装箱路径，AOT
  的装箱/拆箱是确定性的 tagged-union 读写，比 AVM2 的动态属性槽位更快。对照 `spectralnorm`
  （`Vector.<Number>` 无装箱，1.02×）可得明确建议：**数值密集代码用 `Vector.<T>`，动态异构
  集合才用 `Array`**。
- **原生 AS3 全程最慢（3.51–14.72×）**：AVM2 虚拟机的动态分派、装箱与 `Vector` 索引开销。

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
