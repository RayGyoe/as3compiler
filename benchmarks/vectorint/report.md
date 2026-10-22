# vectorint — 静态类型整型向量 `Vector.<int>` 迭代与累加（无装箱路径基准）

## 说明
填充 2000 万个整数到 **`Vector.<int>`**（静态元素类型，4 字节裸整型、无 `as_value` 装箱），
循环读下标累加有界校验和。测量 **`Vector.<int>` 索引访问 + 整型累加** 这一「数值密集且类型已知」
的最快路径。

与另两项互为对照，共同标定数值容器的三个档位：

| 基准 | 容器 | 元素表示 | AOT vs C |
|---|---|---|---:|
| `spectralnorm` | `Vector.<Number>` | 8 B 裸 `double` | **0.73× 快** |
| **`vectorint`** | **`Vector.<int>`** | **4 B 裸 `int`** | **0.82× 快** |
| `array` | 动态 `Array`（`*` 元素） | 24 B `as_value`（装箱） | 5.57× |

## 规模与结果
- 规模：2000 万元素（`(i * 31) % 997`），一次全量遍历累加
- 校验结果（四路一致）：`result=959996015`

## 性能（纯计算时间，v0.4.204 轮三批中位数 × 内部 3 次取中位数；越低越好）

| 实现 | 耗时 (ms) | 相对 C |
|------|----------:|-------:|
| C (`cc -O2`，`int*`) | 22 | 1.00× |
| JavaScript (Node v24，`Int32Array`) | 24 | 1.09× |
| **as3compiler** (→ C → cc -O2) | **18** | **0.82× 快** |
| 原生 AS3 (AIR/mxmlc，`Vector.<int>`) | 54 | 2.45× |

> 本项为 **v0.4.204 新增**。扩容前在 `temp/vecbench/` 做过 5 路对齐验证（含把 JS 侧换成普通 `Array`
> 的对照组），结论与上表一致；四路 `result` 全等才纳入套件。
> `Vector.<int>` 路径**不回退**：用 v0.4.143 的编译器在 `wt143` worktree 里同机实测，旧 18 ms vs 新 18 ms。

## 分析

### 1. AOT 追平 C，是因为这里终于没有「语义税」

热循环只有一句 `sum += a[j]`，生成 C 是：

```c
g_sum = (g_sum + as_vector_int_get(((as_vector_int*)as_req_obj((void*)(g_a))), g_j));
//   as_vector_int_get: return v->data[i];     /* int*，4 字节，零装箱 */
```

裸 `int` 加、裸 `int*` 索引，`as_vector_int_get` / `as_req_obj` 都被 `-O2` 内联掉。

对照 `array` 的同一句 `sum += a[j]`（元素静态类型是 `*`）：

```c
g_sum = as_v_int_cast(as_add_v(as_v_num((double)(g_sum)),
                               as_array_get(as_req_obj((void*)g_a), g_j)));
```

差别**全在元素类型是否静态已知**：`Vector.<int>` 让 `a[j]` 直接落到 `int`，于是
`int → double → 动态加法 → ToInt32` 这条往返链根本不存在。`array` 报告 §1 已用同一份生成 C
的变体归因证明：那条往返链就是 5.57× 的全部（去掉它即 21 ms，与 C 持平）。

### 2. 为什么不是「带宽/依赖链」问题

累加器 `sum` 仍是循环携带依赖，但 20 M × 4 B = 80 MB 的顺序读在 18 ms 内完成（≈ 4.4 GB/s），
与 C 完全一致。**这里没有余量可挖，也没有代价要付** —— 与 `array` 的「延迟受限、非带宽受限」
形成干净的对照。

### 3. JS 侧必须用 `Int32Array`，且它追不上 C

`Vector.<int>` 是「4 字节裸整型、无装箱」的容器，JS 里**布局等价**的只有 `Int32Array`
（V8 → `INT32ELEMENTS`，背面 `ByteArray`，逐元素 4 B，已用 `--allow-natives-syntax --DebugPrint` 确认）。
普通 `Array` 是 8 字节 tagged 槽，与它并非同一表示，故本基准**不**用普通 `Array`。

`Int32Array` 的优化码（`--print-opt-code`）每次迭代保留：

```
ldr  x8, pc+328          ; 载入 INT32ELEMENTS map 常量
cmp  x7, x8 / b.ne       ; 逐次 map 检查
cmp  x11, x7 / b.hs      ; 逐次 bounds check（未提升）
ldr  w7, [x7, x11, lsl#2]
adds w8, w8, w7 / b.vs   ; Smi 溢出检查
adds w7, w10, #1 / b.vs
```

约 10 条/迭代；C 只有 `ldr w + adds + cmp + subs + b` 约 5 条。**这与 `array` 的 5.4× 不是一回事**
（那是动态语义的票价），量级也完全不同。

### 4. 一个反直觉读数：V8 的普通 `Array` 比它自己的 `Int32Array` 还快

扩容实验中同一段 20 M 次累加，单独计时（5 轮取中位）：

| JS 侧写法 | ms |
|---|---:|
| 普通 `Array` + `push` 小整数（`PACKED_SMI`） | 22 |
| `Int32Array`（`INT32ELEMENTS`） | 24 |
| 普通 `Array` + `new Array(N)` 后赋值（`HOLEY_SMI`） | 25 |

V8 的 Smi 立即数表示（8 字节槽、零装箱零分配）比 typed array 路径更省。这也解释了一件记账上的事：
**`array.js` 的 JS 侧本来就没付装箱代价**，`array` 的 5.57× 是 AS3 动态语义
（`int` 累加器与动态值相加必须走 double 域再 ToInt32 回绕）的票价，不是 JS 侧表示法占了便宜。

### 5. `Vector` 对原生 AIR 同样是净收益

AIR 在 `Vector.<int>` 上是 **54 ms**，相对它自己的动态 `Array`（130 ms）快 **2.4×**。
绝对值仍是 C 的 2.45×，但**方向与 AOT 一致**：静态元素类型对任何 AS3 运行时都是可兑现的红利。
这也再次印证 `array` 报告 §3 的判断 —— `array` 上 AOT（117 ms）与 AIR（130 ms）几乎同档，
**不是我们实现得差，而是那条语义链本来就贵**。

### 6. 使用建议
数值密集代码一律用 `Vector.<T>`，并把累加器类型与之对齐（`Vector.<int>` 配 `int` 累加器）：
此时 AOT 输出可到 **0.82× C / 0.73× C**（int / Number），并稳定快于 JS 的 `Int32Array` / `Float64Array`。
反之若写成 `Array` + `int` 累加器，同一算法立刻变成 5.57× C（见 `array`）。

## 计时口径
- 四路均内部计时纯计算（C: `clock_gettime` / JS: `hrtime` / as3compiler: `Date.getTime` / 原生 AS3: `getTimer`）。
- 填充阶段（2000 万次 `a[i] = ...`）不计入计时，仅累加遍历计入。
- 累加采用 `if (sum >= 1e9) sum -= 1e9` 有界校验和，保证不溢出 32 位整型且四路结果精确一致。
- 四路容器均声明固定长度（`Vector.<int>(N, true)`），不测增长路径。
- 扩容前的对齐实验与产物留 `temp/vecbench/`（`vecbench.as` / `vecbench.c` / `vecbench_int32.js` /
  `vecbench_array.js` / `vecbench_air.as` + `vecbench_air-app.xml`），测量后不随基准提交。
