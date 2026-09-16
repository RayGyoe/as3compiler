# binarytrees — 递归二叉树分配/遍历（对象分配基准）

## 说明
按深度递归构造完全二叉树并遍历计数，测量对象分配与递归遍历性能。
`maxDepth = 14`（约 320 万节点），规模为原生 AS3 与无 GC 的 as3compiler 折中。

## 规模与结果
- `maxDepth = 14`；输出三部分：`stretch` 计数、循环 `sum`、`longLived` 计数
- 校验结果（四路一致）：`result=65535,3123888,32767`

## 性能（纯计算时间，3 次取中位数，越低越好）

| 实现 | 耗时 (ms) | 相对 C |
|------|----------:|-------:|
| C (cc -O2) | 72 | 1.00× |
| JavaScript (Node v24) | 31 | 0.43× |
| **as3compiler** (→ C → cc -O2) | 53 | 0.74× |
| 原生 AS3 (AIR/mxmlc) | 344 | 4.78× |

## 分析
- **JS（0.43×）与 as3compiler（0.74×）都快于 C**，但原因不同：
  - C 版含显式 `freeTree` 递归释放（算法完整性的一部分）；as3compiler 无 GC、不释放，
    省去了这段开销，故数值上更快——并非 as3compiler 的对象分配真的更优。
  - JS 依赖 JIT + 分代 GC，在分配密集型负载上本来就优于手动 `malloc/free`。
- **原生 AS3 4.78×**：AVM2 的对象分配 + 标记清除 GC 开销显著。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 原生 AIR 的 `adl` 启动开销（约 2.6s）不计入。
