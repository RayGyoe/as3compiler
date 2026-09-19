# 生成 C / 二进制的体积优化（static 化 + `-O2` 自动 tree-shake）

> 本文记录 as3compiler 产物体积的根因、以及「把所有内建类方法体标 `static`，让
> `clang -O2` 从 `main` 出发做调用图分析、自动消除不可达符号」的最终落地。
> 方案已实现于 `src/emit.ts` 的 `staticizeTopLevelFunctions()`（阶段七十八）。

---

## 1. 实测基线（`examples/hello.as`，约 500 B，纯 `trace`）

| 指标 | static 化之前 | static 化之后 |
|---|---|---|
| 生成 `examples/hello.c` | 378 KB / 8924 行 | 378 KB / 8924 行（仅函数签名加 `static` 前缀） |
| 编译后二进制（`clang -O2 -lm -lz`） | **165 KB** | **34 KB（-80%）** |
| 全局 text 符号（`nm` 的 `T`） | 443 个 | 2 个（`main` + Mach-O 头） |

`hello.c` 的 `main` 只调用 `printf` + `as_str_concat`，完全不碰 Stage / 图形 / 文件 /
字节流。那 443 个全局符号全是「内建类方法体 + thunk」的死代码。

---

## 2. 根因：方法体被发射成全局符号，`-O2` 无法消除

`nm` 检查未使用的内建类一个都没被消除：

```
00000001000088a0 T _ByteArray_compress      ← 全局 text（T）
000000010000fadc T _ByteArray_new
000000010001d578 d _MovieClip_methods       ← static data（d），被方法体引用
```

根因就一条：

- **内建类方法体（`Date_ctor` / `ByteArray_compress` / thunk `Xxx_m__dyn`）被发射成
  全局符号（`T`，非 `static`）。** clang 必须假设「其他编译单元可能引用它们」，因此
  `-O2` 的死代码消除（DCE）对全局符号**不生效**。
- vtable / props / methods 反射表**本来就是 `static`**，但它们被「全局方法体」引用
  （vtable 里的函数指针 `&Date_getTime`，反射表 thunk 里的 `Date_getTime` 调用），
  只要方法体作为全局符号保留，这些 static 数据就随之「可达」、一并保留。

**结论**：二进制体积的大头不是 runtime（`RUNTIME_PREAMBLE` 的函数早已是 `static`，
`-O2` 已消除未引用的），而是**内建类方法体这个「全局符号」**。解法就是把它们标
`static`，让 `-O2` 自己剪枝——**这是「语义翻译层面」的可见性标记，不是手写优化 pass**。

---

## 3. 落地：`staticizeTopLevelFunctions()`

`src/emit.ts` 的 `run()` 在发射完 `main` 之后，调用一次 `staticizeTopLevelFunctions()`，
把「非导出的文件作用域函数」统一加 `static`：

- **恒保持全局**：`main`（程序入口）、`[WasmExport]` 的导出符号（`symbol` + 别名
  wrapper，wasm 导出表 / 跨编译单元可见所需）。
- **加 `static`**：内建类与用户类的方法体、ctor/new、thunk、free function、prototype 声明。
- 逐行识别「`返回类型 函数名(`」且位于顶格（无缩进）的函数定义/声明；跳过
  `static`/`typedef`/`extern`/`struct`/预处理/注释行。

`-O2` 随后从 `main` 出发建立完整调用图：

```
main ── 不碰 Date ──> Date_new 不可达 ──> Date_vt 不可达
                                            ├── Date_methods / Date_props 不可达
                                            └── Date_getTime + thunk 不可达 → 全消
```

**横向引用自动处理**（这是「按类裁剪」方案最头疼的点）：`Transform_ctor → Matrix_new/
ColorTransform_new`、`Shape_ctor → Graphics_new`、`TextField_ctor → TextFormat_new`、
`Stage_dispatchFrame → MovieClip/Timer` 这类**非继承关系**的横向调用，全都在同一编译
单元内走 static 调用，`-O2` 的调用图分析天然覆盖——**无需维护任何依赖边表或按类裁剪**。

---

## 4. 为什么不用「内建类按需发射」（原 P0）

早期方案（`docs/zh-cn/p0-tree-shaking.md`，已删除）打算在 Pass 1 做 AST 引用扫描 +
fixpoint 闭包，按类裁剪骨架与方法体。实测后放弃，理由：

1. **收益反而不如 static 化**：P0 预期二进制降到 40–60 KB；static 化直接到 34 KB。
2. **实现重得多**：需要 AST 扫描器（`noteTypeRef`/`scanExpr`/`scanStmt`）+ fixpoint +
   3350 行方法体按类归组 + 手工维护内建类横向依赖边表。
3. **漏裁风险真实存在**：`super/implements` 闭包覆盖不了方法体内部的横向调用
   （§3 所列），漏裁即未定义符号、链接失败。

static 化把「该发射哪些类」这个判断**完全交给 `-O2` 的调用图分析**，正确性与完整性由
编译器的成熟算法保证，前端零语义负担。

---

## 5. 约束与边界

- **跨编译单元 / glue 层**：`air-native` 的 Skia/SDL2/Metal glue（`.cc`/`.mm`）通过
  **函数指针回调**生成的 `.c`（`on_frame`/`on_mouse`/`on_frame_delay`），不要求 `.c`
  内部符号全局；生成 `.c` 调 glue 走 `extern "C"` 声明。static 化不影响多目标链接
  （`air-native` 全量链接已验证通过）。
- **动态实例化 `new (expr as Class)`**：`as_class` 只带 `vtable` + `factory` 两个指针，
  引用「被明确当作 `Class` 值使用的类」；那些类会被 `main` 可达链自然保留，不依赖
  全量注册表。
- **`[WasmExport]`**：导出符号（含别名 wrapper）恒保持全局，非导出函数全部 static。

---

## 6. 验收

- `hello.as` 二进制 165 KB → 34 KB，输出逐字一致。
- `node test.ts` 全量回归 80 passed / 0 failed（含 `air-native` 全量 Skia/SDL2 链接、
  `wasm-native` 导出、GUI 窗口示例）。
