# spectralnorm — 谱范数（Vector.<Number> 密集矩阵-向量乘基准）

## 说明
计算矩阵 `A(i,j) = 1/((i+j)(i+j+1)/2 + i + 1)` 的谱范数近似（幂迭代 10 轮）。
`N = 1000`，测量 `Vector.<Number>` 索引读写与 `double` 内积性能。

## 规模与结果
- `N = 1000`；幂迭代 10 轮（每轮 2 次矩阵-向量乘）
- 输出为谱范数的整数校验和（`floor(result × 1e6)`）
- 校验结果（四路一致）：`result=1274224`

## 性能（纯计算时间，3 次取中位数，越低越好）

| 实现 | 耗时 (ms) | 相对 C |
|------|----------:|-------:|
| C (cc -O2) | 47 | 1.00× |
| JavaScript (Node v24) | 55 | 1.17× |
| **as3compiler** (→ C → cc -O2) | 48 | 1.02× |
| 原生 AS3 (AIR/mxmlc) | 692 | 14.72× |

## 分析
- **as3compiler 1.02×**：`Vector.<Number>` 单态化为连续 `double` 数组，索引读写生成
  带边界检查的直接内存访问；与 C 数组几乎一致。
- **原生 AS3 14.72×** 是本集合中差距最大的一项：AVM2 的 `Vector` 索引每次都走
  方法分派 + 边界检查，密集内层循环无法被有效 JIT 优化。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 原生 AIR 的 `adl` 启动开销（约 2.6s）不计入。
