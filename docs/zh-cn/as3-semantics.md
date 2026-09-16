# AS3 语义查证基准

> 本文档是本编译器实现新特性前的**权威语义查证清单**，补齐 AGENTS.md §2.4「语义红线」所依赖的
> 规范来源，杜绝「凭记忆或 C 行为反推 AS3 语义」。
>
> **凡实现新特性，先查下表对应的权威源，把 AS3 与 C 的语义差异写进注释，再编码。**

---

## 1. 权威规范来源（分级）

### 第一级：语言正典（语法 + 类型系统 + 语义）

| 来源 | 覆盖内容 | 用途 |
|------|---------|------|
| [ES4 draft 规范（2006-01）](http://archives.ecma-international.org/2006/misc/es4lang-Jan06.pdf) | 语法、类型系统、名字解析、强制转换语义 | **主参考**——AS3 的语法与类型系统正典 |
| [ECMA-262 第 3 版（ES3, 1999）](https://ecma-international.org/wp-content/uploads/ECMA-262_3rd_edition_december_1999.pdf) | ES 基线（AS3 搭建其上） | 数值转换规则 `ToInt32`/`ToNumber`/`NaN`/`Infinity` 等的出处 |

### 第二级：对象模型与运行时语义

| 来源 | 覆盖内容 | 用途 |
|------|---------|------|
| [AVM2 Overview（Adobe, 2007）](http://hackipedia.org/raw/File%20formats/Containers/F4V,%20Flash%20Video/ActionScript%20Virtual%20Machine%202%20(AVM2)%20Overview%20by%20Adobe%20(2007-05).pdf) | 对象模型：trait/slot、多名字（multiname）、分派、verifier 时代语义 | 我们只借鉴**语义**，不生成 ABC 字节码 |
| [avmplus 源码](https://github.com/adobe/avmplus)（或 [adobe-flash 镜像](https://github.com/adobe-flash/avmplus)） | 参考实现「实际怎么做的」 | **tie-breaker**：规范含糊时的最终裁决 |
| [Ruffle 源码](https://github.com/ruffle-rs/ruffle)（`core/src/events.rs` / `display_object/interactive.rs` / `avm2/events.rs` 等，本地快照见 [`as3-docs/`](as3-docs/README.md)） | `flash.events.*` / `flash.display.*` 的**事件流、命中测试、焦点**参考实现 | **GUI/事件语义的 tie-breaker**：ES4/AVM2 Overview 不覆盖显示列表事件流，此领域以 Ruffle 与 avmplus 同级裁决 |

### 第三级：标准库与实用语义

| 来源 | 覆盖内容 | 用途 |
|------|---------|------|
| [AS3 语言参考（AIR SDK）](https://airsdk.dev/reference/actionscript/3.0/) | 标准库 surface 与内建类行为 | 已由 AGENTS.md §2.4 引用，本编译器现有约定 |
| [AS3 开发者指南 PDF](https://help.adobe.com/en_US/as3/dev/as3_devguide.pdf) | 内建类行为、语言用法 | 辅助 |
| [Apache Royale AS3 文档](https://apache.github.io/royale-docs/features/as3) | 现代、去 Flash 的 AS3 用法 | 参考「无 Flash 依赖」的实用语义 |

### 来源冲突时的优先级

```
AGENTS.md §2.4 语义红线（已定的硬性决策）
  > ES4 draft  >  AVM2 Overview  >  avmplus 行为  >  AS3 参考文档
```

> 对于 `flash.display.*` / `flash.events.*` 的**显示列表事件流、命中测试、焦点**语义，ES4 draft 与
> AVM2 Overview 均无详细覆盖，此领域以 **Ruffle 源码与 avmplus 同级**作为 tie-breaker（Ruffle 是社区
> 公认最忠实的开源实现，其 `interactive.rs` 的 `Avm2MousePick` 三态机、`handle_clip_event` inside-out
> 分发等算法是文档讲不清、只能看实现才能对齐的边界语义）。映射草案见 [`as3-docs/mapping.md`](as3-docs/mapping.md)。

本项目**不设「偏离 AS3」的决策层**——铁律是「AS3 语义优先于 C 语义」，不引入空安全、泛型具体化
等任何对 AS3 语义的偏离。

---

## 2. AS3 语义决策速查（与红线对照）

以下为 AS3 语义中「必须忠实实现」的高危点，直接对应 AGENTS.md §2.4 红线表（状态截至 v0.3.67）。

| AS3 语义 | 规范出处 | 我们的红线 | 状态 |
|---------|---------|-----------|------|
| `/` 恒为 `Number`（`int/int` 也是浮点） | ES4 draft + ECMA-262 §9 | 一律提升 `double` 再除 | ✅ 已实现 |
| `+` 遇字符串自动装箱拼接 | ES4 draft | 走 `as_str_concat`/`as_str_from_*` | ✅ 已实现 |
| 字符串 `==/!=` 是值比较 | ES4 draft | `strcmp` | ✅ 已实现 |
| `Number` 未初始化默认值 = **`NaN`** | ES4 draft + AVM2 | `defaultInit` 的 `number` 分支输出 `NAN` | ✅ 已实现（emit.ts `defaultInit`） |
| `int`/`uint` 默认值 = `0`，`Boolean` = `false` | ES4 draft | 类型一经推断不可变 | ✅ 已实现 |
| `String` 默认值 = `null`，引用类型 = `null` | ES4 draft | 已按 `null` 处理 | ✅ 已实现 |
| `is`/`as` 是**运行时类型测试**（基于真实类身份） | ES4 draft + AVM2 | vtable `super` 链做 RTTI + 基本类型 `any` tag 运行时 | ✅ 已实现（对象 + 基本类型 + `any`） |
| `switch` 仅 `int`/`uint` 原生 fall-through，其余降级 `if/else` | ES4 draft + AS3 参考 | 非整型判别式降级严格相等链 | ✅ 已实现 |
| 方法闭包**正确绑定 `this`**（提取 `obj.method` 得到永久绑定 `obj` 的闭包） | ES4 draft | `as_fn_make(..., __bound, (void*)obj)` 绑定接收者 | ✅ 已实现（emit.ts 方法值/闭包） |
| 类默认**密封**（sealed），`dynamic class` 才允许 expando | ES4 draft + AVM2 | 类固定 shape（字段平铺 + vtable） | ✅ 已实现（未支持 `dynamic`） |
| 数值强制转换：`int↔uint↔Number` 回绕、`Number→int` 截断 | ES4 draft + ECMA-262 §9 | `toInt32Expr`/`toUint32Expr` 对应 AS3 `ToInt32`/`ToUint32` | ✅ 已实现（emit.ts 位运算/强制转换） |

---

## 3. 决策分歧点（需项目内明确）

| 分歧 | AS3 语义 | 本项目现行 | 建议 |
|------|---------|-----------|------|
| `var x;`（无类型无初值）默认类型 | `*`（any）/ `undefined` | 无类型仍按 `int`（`symbols.ts` 约定）；显式 `*` 已建模为 `any`（`as_value` 装箱） | **维持现状**——无类型默认 `int` 是极简约定；但阶段十五起引用类型赋给推断 `int` 抛 `CodegenError`，不再静默截断 |
| `Number` 默认值 | `NaN` | ✅ 已修复（`defaultInit` 输出 `NAN`） | 无需处理 |

---

## 4. 使用方式

1. 实现新特性前，查 §1 对应权威源，确认真实 AS3 语义；
2. 对照 §2 红线表，把「AS3 与 C 的差异」写进代码注释；
3. 遇到 §3 分歧点，先在本项目内确认决策；
4. 若 `AIRSDK_HOME` 可用，用 `$AIRSDK_HOME/bin/mxmlc` 对同一 `.as` 输入做**对照验证**（AGENTS.md §2.4 已约定）。
