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
| fib | 288 | 798 | 289 | 3594 |
| nbody | 189 | 344 | 202 | 1304 |
| binarytrees | 73 | 32 | 48 | 338 |
| mandelbrot | 98 | 126 | 97 | 355 |
| strings | 81 | 100 | 129 | 891 |
| spectralnorm | 47 | 63 | 47 | 691 |
| oop | 49 | 60 | 49 | 595 |
| array | 19 | 23 | 149 | 135 |

### 相对 C 的倍数（1.00 = 与 C 持平）

| benchmark | C | JS | as3compiler | 原生 AS3 |
|-----------|---:|----:|------------:|---------:|
| fib | 1.00 | 2.77 | 1.00 | 12.48 |
| nbody | 1.00 | 1.82 | 1.07 | 6.90 |
| binarytrees | 1.00 | 0.44 | 0.66 | 4.63 |
| mandelbrot | 1.00 | 1.29 | 0.99 | 3.62 |
| strings | 1.00 | 1.23 | 1.59 | 11.00 |
| spectralnorm | 1.00 | 1.34 | 1.00 | 14.70 |
| oop | 1.00 | 1.22 | 1.00 | 12.14 |
| array | 1.00 | 1.21 | 7.84 | 7.11 |

## 结论

- **as3compiler 在纯计算/对象访问上接近 C（0.66–1.07×）**：`fib`、`nbody`、`mandelbrot`、
  `spectralnorm`、`oop` 均验证了「只翻译、优化交给 C 编译器」的路线不损失性能；生成的 C 经
  `cc -O2` 后与手写 C 基本等价。
- **`oop` 是新增的面向对象核心基准（1.00× C，12.14× 原生 AS3）**：AS3 的类继承 + 虚方法派发
  （`override`/vtable）+ 对象字段访问被翻译为 C 结构体 + 一次函数指针调用 + 一次直接内存访问，
  与手写 C 持平，同时比 AVM2 的动态方法解析 + 属性槽位间接寻址 + 装箱快约 12 倍——这是此前
  6 个过程式/纯计算基准唯一未覆盖的类别。
- **字符串操作是 as3compiler 相对最弱的点（1.59×，已从 2.44× 收窄）**：剩余差距主要来自
  `split` 产生中间 `Array`（装箱 `as_value`）这一 AS3 语义固有开销，无法在不做窥孔优化的
  前提下消除。
- **普通 `Array` 的装箱税（`array` 基准，7.84×）**：数值密集时若用普通 `Array`（元素经
  `as_value` 装箱）而非 `Vector.<T>`，AOT 与 AVM2 均需逐元素装箱/拆箱，二者持平（7.84× vs 7.11×）。
  对照 `spectralnorm`（`Vector.<Number>` 无装箱，1.00×）可得明确使用建议：**数值密集代码用
  `Vector.<T>`，动态异构集合才用 `Array`**。
- **`binarytrees` 中 as3compiler（0.66×）与 JS（0.44×）快于 C**，但 C 版含显式 `freeTree`
  释放、as3compiler 无 GC 不释放，并非对象分配本身更优，详见该目录 `report.md`。
- **原生 AS3 全程最慢（3.62–14.70×）**：AVM2 虚拟机的动态分派、装箱与 `Vector` 索引开销。

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
