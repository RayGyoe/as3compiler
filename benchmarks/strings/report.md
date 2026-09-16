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

## 性能（纯计算时间，3 次取中位数，越低越好）

| 实现 | 耗时 (ms) | 相对 C |
|------|----------:|-------:|
| C (cc -O2) | 79 | 1.00× |
| JavaScript (Node v24) | 97 | 1.23× |
| **as3compiler** (→ C → cc -O2) | 132 | 1.67× |
| 原生 AS3 (AIR/mxmlc) | 884 | 11.19× |

## 分析
- **as3compiler 1.67×** 仍是本集合中相对 C 最弱的一项，但已从 2.44× 显著收窄：
  `split` 产生中间 `Array`（装箱 `as_value`）再 `join` 遍历拼接，这层装箱开销
  是 AS3 语义固有、无法消除的（除非做 `split().join()` 模式融合窥孔优化，违反
  前端不优化铁律）。剩余差距主要来自此装箱，而非分配器本身。
- **原生 AS3 11.19×**：AVM2 每次字符串操作都产生新对象 + GC 压力。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 原生 AIR 的 `adl` 启动开销（约 2.6s）不计入。
