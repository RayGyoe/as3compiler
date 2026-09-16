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
| C (cc -O2) | 81 | 1.00× |
| JavaScript (Node v24) | 101 | 1.25× |
| **as3compiler** (→ C → cc -O2) | 162 | 2.00× |
| 原生 AS3 (AIR/mxmlc) | 921 | 11.37× |

## 分析
- **as3compiler 2.00× C**，是本集合中相对 C 最弱的一项，差距由两部分构成：
  1. **`split().join()` 的装箱税（固有，不可消）**：`split` 产生中间 `Array`（元素经
     `as_value` 装箱）再 `join` 遍历拼接，这层装箱是 AS3 语义固有，除非做模式融合窥孔
     优化（违反前端不优化铁律）。
  2. **真实 GC 开销（本次新增）**：现已周期性调用 `System.gc()`（每 5 万次迭代），在
     30 万次迭代的海量临时字符串/数组压力下真正执行 mark/sweep。此前版本**从不触发 GC**
     （控制台 `main()` 到不了帧边界安全点），本质是静默泄漏；纳入真实回收后从 1.67×
     升到 2.00×，这是诚实的数据点。
- **原生 AS3 11.37×**：AVM2 每次字符串操作都产生新对象 + GC 压力。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 原生 AIR 的 `adl` 启动开销（约 2.6s）不计入。
