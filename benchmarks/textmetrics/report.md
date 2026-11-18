# textmetrics — TextField 派生度量往返（`numLines` / `textWidth` / `textHeight` / `maxScrollH`）

## 说明
8 个 **200 行**、`wordWrap=false`、宽 200 的 `TextField`（Arial 12），每轮把每个字段的四个
派生度量各读一遍，共 20000 轮 —— 即 **16 万次全量度量往返**（口径变更见「规模与结果」）。

选这条形态的理由：它是「大文本字段」在应用里的标准读法（布局算高、算横向溢出、算滚动上限），
而且这几个入口**绘制路径自己每帧也在调**：`as_render_object` 的 TextField 分支无条件调用
`TextField_get_maxScrollH`（`src/emit.ts`），`autoSize` 字段每帧还会再调一次
`as_tf_apply_autosize`，居中/右对齐字段再调一次 `as_tf_align_dx` —— 三者都落到同一个
「最长行宽」计算上。单行标签（~0.15 µs）无所谓，几百行的日志/文档字段就是另一回事。

## 两路（此项刻意不是四路）
`C` 与 `JS` 没有排版引擎，`textWidth` / `textHeight` / `maxScrollH` 在那两侧无从实现；
硬凑一个「同构实现」只会拿两套无关数字做比较。故本项只跑 **as3compiler** 与 **原生 AIR**
两路，`run.py` 在表里显式打 `-` 并注明 `(no route: c, js)`，不静默少算。

## 规模与结果
- 夹具：8 字段 × 200 行，**20000 轮**，计时前先预热一遍（首次读会触发懒排版，那是「建字段」
  的成本，不是「读度量」的成本；AIR 侧同样预热）。
  旧的 30 轮口径没有预热，3 ms 里九成是首排，会把读路径本身掩盖掉。
- `result=97600000`（两路一致）
- 校验口径：只累加 **`numLines` + `int(textWidth)` + `maxScrollH`**。`textHeight` 照旧参与
  **计时**，但单独作为诊断打印、不进 checksum —— 原因见 §3。

## 性能（本机 macOS arm64；每路内部 3 次取中位数；越低越好）

现行口径（20000 轮 + 预热，**阶段四百三十八修完之后**）：

| 实现 | 耗时 (ms) | 单次全量往返（8 字段） |
|------|----------:|----------------------:|
| **as3compiler** | **11 ~ 14** | **≈0.6 µs** |
| **原生 AS3 (AIR 51.4.1)** | **732 ~ 744** | **≈37 µs** |

同一份源码、同一口径、**只换编译器**的 A/B（`temp/bench/textmetrics_{pre,post}`，各跑 3 次）：
**126 836 ms → 11~14 ms（≈10000×）**，`result` 均为 `97600000`。
AIR 的 37 µs/往返基本全在 `maxScrollH`（4.4 µs × 8）——它每次读都要重新算横向溢出量；我们把
这几个数在排版时就定好，于是**这一项从「比 AIR 慢 173×」变成「比 AIR 快 ~60×」**。

逐项单次耗时（`temp/tfperf/tfperf2.as`，200 行字段；AIR 同源探针 `adl/adl_tfperf.as`）：

| 操作 | 改前 | 改后 | AIR |
|---|---:|---:|---:|
| `numLines` | 0.05 µs | 0.05 µs | 0.05 µs |
| `textWidth` | **31.6 µs** | **0.05 µs** | **0.1 µs** |
| `textHeight` | **727 µs** | **< 1 µs** | ≈0 µs |
| `maxScrollH` | **31.6 µs** | **< 1 µs** | 4.4 µs |

行表本身（`temp/tfperf/linetable.as`，用 `getLineMetrics` 逐行压表；改前/改后同源码同机器）：

| 行数 | 改前 | 改后 | 倍数 |
|---|---:|---:|---:|
| 20 | 14.75 µs/次 | **8.75 µs/次** | 1.7× |
| 200 | 756.25 µs/次 | **69.5 µs/次** | **10.9×** |

20→200 行的增长率：改前 **51×**（≈ 二次）、改后 **7.9×**（≈ 线性）。

改前的形状（说明为什么必须先修）：`textWidth` 20 行 3.1 µs、200 行 31.6 µs ⇒ 约 0.16 µs/行
（线性，但每行都要问一次 `getRectsForRange`）；`textHeight` 20 行 11.3 µs、200 行 727 µs ⇒ 超线性
（§2 的 O(L²)）。修后两者都与行数无关（读的是缓存）。

## 分析

### 1. 「每次现算」是主因：`getLineMetrics` 每次调用物化一份全部行（已于阶段四百三十八修复）

`textWidth` 与 `maxScrollH` 都走 `sk_textlayout_max_width_incl_spaces`
（`vendor/skia_text_glue.cc`），它每次调用都
`p->getLineMetrics(std::vector<LineMetrics>&)` —— 200 行就是每次构造并拷贝 200 个
`LineMetrics`（数十 KB 堆 churn）。这个值只依赖段落本身，段落又在 `TextField._para` 里缓存着，
所以**它本该是 O(1) 的读**，现在却是每次 O(行数) + 一次堆分配。

AIR 的口径正相反：`textWidth`/`textHeight`/`numLines` 在排版结束时就定好了，读是纯 O(1)
（实测 0.05~0.1 µs，与行数无关）。

### 2. `textHeight` 里还有一条 O(L²)

`TextField_get_textHeight` 调 `as_tf_line_table`，后者对**每一行**调 `as_tf_byte_index`
（`src/emit.ts`），而它**从串首重新走一遍** UTF-8 —— 第 i 行的转换成本 ∝ 前 i 行的字节数，
Σ 即 O(L²)；每行还附带一次 `strlen`。这是 20 行 11 µs → 200 行 727 µs 这个形状的直接原因
（`AS_TF_MAX_LINES=256` 在更大规模上截断，掩盖了 1000 行那一档）。

修法很直接（单趟单调转换 + `strlen` 提到循环外），但**更需要的是 §1 的缓存**：缓存之后
`textHeight` 连表都不用建。

### 3. `textHeight` 有一处已登记的口径差，故不进 checksum

同一夹具两端实测：**我们 2600 / AIR 2700**（逐行 13.0 vs 13.5）。这是 `skia.md` 与 `TODO.md`
遗留表里已登记的「Skia 行盒 vs AIR 行盒取整」差（阶段四百三十五 收尾时记为待 adl 校准项），
与性能无关。若把它并进 `checksum`，一条**已知口径差**会把「性能回退」和「口径不符」混成同一个
`MISMATCH`，基准就失去了判别力，故：`textHeight` 参与计时、单独打印 `thsum=` 供人工对照。

### 4. 这 6.6 ms 里谁占大头（改前分解）

按 §1/§2 的单次成本换算：`textHeight` 727 µs × 8 = 5.8 ms，`textWidth` + `maxScrollH`
各 31.6 µs × 8 ≈ 0.5 ms，合计 ≈ 6.3 ms，与实测 6.6 ms 吻合 —— **说明没有第三个未知热点**，
把这两处缓存/单趟化之后本项应落到亚毫秒量级。

## 后续（不在本基准内）

1. 派生度量（`textWidth`/`textHeight`/`lineHeight`/`lineCount`/`maxScrollH`）随 `_para`
   一起缓存，重排时算一次 —— 同时消掉绘制路径每帧的那几次调用；
2. `as_tf_line_table` 改单趟转换，消掉 O(L²)；
3. glue 增一个「一次遍历返回全部度量」的入口，避免重复物化 `LineMetrics`。

本基准是这三条改动的护栏：现行值 **195~200 ms**，改后应当与 AIR 同量级（亚毫秒）。

## 计时口径
- as3compiler：`Date.getTime`；AIR：`getTimer`（1 ms 粒度，故 AIR 列的 `1` 是分辨率下限）。
- AOT 侧必须链接 Skia（`textmetrics.build.json`，`run.py` 的 `MANIFESTS` 表会带上），
  否则 `textWidth` 走纯 C 桩恒 0，本项失去意义。
- 计时区域只含四个 getter 的读取，不含建字段与排版（那只发生一次）。