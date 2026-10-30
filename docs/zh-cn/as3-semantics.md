# AS3 语义查证基准

> 本文档是本编译器实现新特性前的**权威语义查证清单**，补齐 AGENTS.md §2.4「语义红线」所依赖的
> 规范来源，杜绝「凭记忆或 C 行为反推 AS3 语义」。
>
> **凡实现新特性，先查下表对应的权威源，把 AS3 与 C 的语义差异写进注释，再编码。**
>
> 结构：§1 权威源、§2 红线速查、§3 决策分歧点（**怎么和 AIR 对齐**）是主体；§4 保真与增强原则、
> §5 增强待做补上另一半（**对齐之外什么算增强**）。

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

以下为 AS3 语义中「必须忠实实现」的高危点，直接对应 AGENTS.md §2.4 红线表（状态截至 v0.4.2）。

| AS3 语义 | 规范出处 | 我们的红线 | 状态 |
|---------|---------|-----------|------|
| `/` 恒为 `Number`（`int/int` 也是浮点） | ES4 draft + ECMA-262 §9 | 一律提升 `double` 再除 | ✅ 已实现 |
| `%` 的**零除数**有定义（AVM2 `OP_remainder` 不 trap）：`5 % 0` 得 **NaN**（是 `Number`），而 `var r:int = 5 % 0` 得 **0**（int 接收时 NaN 强制为 0）；`INT_MIN % -1` 得 **0**；非零除数时 `int % int` **是 int**（`(7 % 3) is int` == true）、`-7%3=-1`、`7%-3=1` | ES4 draft + AVM2；adl（AIR 51.4.1）实测（除数取数组元素使其不透明） | `int % int` → `as_int_rem`、`uint % uint` → `as_uint_rem`（`b==0` → 0、`INT_MIN % -1` → 0）；混合/Number 走 `fmod`（`fmod(x,0)` 本身就是 NaN，与 AS3 一致） | ✅ 已实现（阶段八十九·三十一） |
| `+` 遇字符串自动装箱拼接 | ES4 draft（ToPrimitive：任一侧为 String 即拼接；对象默认 hint → toString） | 静态任一侧是 `String` 走 `as_str_concat`/`as_str_from_*`；任一侧是 `any`/`null`（含 `*`、数组元素、动态属性）走**运行时**助手 `as_add_v`（按运行时 tag 判拼接 vs 相加，结果 box 成 `any`）。**禁止**把动态值直接当数字相加——`var a:Array=["x","y"]; a[0]+a[1]` 曾得 `0`，现得 `"xy"` | ✅ 已实现（阶段八十九·三十四；**对象**的文本自阶段一百一十二 起派发虚 `toString()`，见下一行；`Array`/`Function` 箱仍是 `as_v_str_val` 的简化名，故 `[Array] + 1` = `[Array]1` ≠ AS3 的 `1,21`，属已知简化） |
| **对象 → 字符串**一律走虚 `toString()`；未被覆写者得 AIR 的 `[object <本地类名>]`（不是 C 标识符） | AS3 参考 `Object.toString` + adl 12 例逐字对照（`temp/strprobe/`） | `as_obj_to_str` 经 **vtable 的 `toString` 槽**派发（`as_vtable_header` 与既有 vtable 尾部逐字对齐，故同一读取器同时服务生成类与预置箱 vtable）；默认 `Object.toString` = `as_obj_default_str`（按 `fqn` 取 `::` 之后）；`as_v_str_val` 的 object 分支同样派发；`String(x)`/`x+"b"`/`x.toString()`/数组元素/Dictionary 值全部命中同一条路 | ✅ 已实现（阶段一百一十二；`examples/strcoerce.as`，12 例与 adl 逐字相同） |
| 字符串 `==/!=` 是值比较 | ES4 draft | `strcmp` | ✅ 已实现 |
| `Number` 未初始化默认值 = **`NaN`** | ES4 draft + AVM2 | `defaultInit` 的 `number` 分支输出 `NAN` | ✅ 已实现（emit.ts `defaultInit`） |
| `int`/`uint` 默认值 = `0`，`Boolean` = `false` | ES4 draft | 类型一经推断不可变 | ✅ 已实现 |
| `String` 默认值 = `null`，引用类型 = `null` | ES4 draft | 已按 `null` 处理 | ✅ 已实现 |
| **可编辑文本的键入是「事件先于编辑」**（`keyDown` → `textInput` → 插入 → `change`），且两个事件都**可取消**：取消 `keyDown` ⇒ 整次文本都不派发；取消 `textInput` ⇒ 不插入不 `change`；改写 `e.text` **不**改变实际插入的文本 | AS3 参考（`TextEvent.TEXT_INPUT` 在插入前派发、`Event.CHANGE` 在文本真的改变后）+ `adl 51.4.1` 实测 | `Stage_dispatchKey`（keyDown 抑制位 `as_key_text_suppressed`）→ `as_tf_insert_text`（派 `textInput`、查 `cancelled`、按 `maxChars` 截断插入、`change`）；`EventDispatcher_dispatchEvent` 返回 `!cancelled` | ✅ 已实现（emit.ts；证据 `temp/editprobe/`） |
| 键盘与文本是**两条通道**：`KeyboardEvent.keyCode/charCode` 是按键，组合字符（非 US 布局/Option/IME）走 `TextEvent.TEXT_INPUT` | AS3 参考（`KeyboardEvent` vs `TextEvent`） | glue 把 `SDL_KEYDOWN` 发到 `on_key`、`SDL_TEXTINPUT` 发到保留类型 `textInput`（+ `sk_window_text_take` 取字节），由 `Stage_dispatchText` 进同一条插入路径 | ✅ 已实现（native）；**残留**：keyDown 的 `charCode` 仍按 US 基键近似（见 `TODO.md`） |
| `is`/`as` 是**运行时类型测试**（基于真实类身份） | ES4 draft + AVM2 | vtable `super` 链做 RTTI + 基本类型 `any` tag 运行时 | ✅ 已实现（对象 + 基本类型 + `any`） |
| `switch` 仅 `int`/`uint` 原生 fall-through，其余降级 `if/else` | ES4 draft + AS3 参考 | 非整型判别式降级严格相等链 | ✅ 已实现 |
| `a && b` / `a \|\| b` **返回操作数的值**（不是 C bool），且**短路透传的那个操作数不得被强制转换到另一侧的静态类型**（`var r:* = (ow > 1 && c && s && s.length > 1)` 在 `ow=0` 时结果就是 Boolean `false` 本身） | ES4 draft（§11.11/§11.12 逻辑运算符语义，同 ECMA-262）+ `adl 51.4.1` **4 轮 26 例**双端实测（`temp/logicrepro/`，`adl-truth.txt`） | `emit.ts` 的 `&&`/`\|\|` 分支只在**同类**（`bool && bool` / `int && int` / `Object \|\| Object`）与 **numeric** 时统一到具体 C 类型；**任一侧是 `any` 就两侧装箱成 `as_value`**（透传原样、不解箱）；`bool && bool` 仍走 C `&&` 快路径（避免左嵌套链指数展开）。**禁止**把 `any` 与具体类型统一——`unifyType(any, T)` 取的是**较窄**的 `T`，会把透传值解箱 + 运行时类型检查，`bool && Array` 于是抛 `#1034 cannot convert false to Array`（`TweenLite.as:399` 的守卫链，air-native TweenDemo 崩溃真根因） | ✅ 已实现（阶段一百二十五；`examples/logical-value.as` + 单元组 `logical/OperandPassThrough`） |
| **空字符串是假值**（`Boolean("")` 为 false，且 `("" && "hi")` 得 `""`），条件上下文全族一致 | ES4 draft（ToBoolean）+ `adl 51.4.1` 实测（`temp/logicrepro/adl-truth2.txt`、`adl-truth3.txt`） | 静态 `String` 条件经 **`as_str_truthy(const char* s)`**（`s != NULL && s[0] != 0`），与 boxed 路径 `as_v_truthy` 的 tag-3 分支同口径；覆盖 `if`/`while`/`do-while`/`for` 条件、`!`、`?:`、`&&`/`\|\|`。**helper 取参而非内联**（内联会两次提及操作数 ⇒ `if (f())` 调两次）。**禁止**直接用 C 的 `char*` 非空测试（`""` 是非空指针 ⇒ 判真；修前 `("" && "hi")` 得 `"hi"`） | ✅ 已实现（阶段一百二十五；`examples/string-truthy.as` + 单元组 `logical/StringTruthy`） |
| 方法闭包**正确绑定 `this`**（提取 `obj.method` 得到永久绑定 `obj` 的闭包） | ES4 draft | `as_fn_make(..., __bound, (void*)obj)` 绑定接收者 | ✅ 已实现（emit.ts 方法值/闭包） |
| 类默认**密封**（sealed），`dynamic class` 才允许 expando | ES4 draft + AVM2 | 类固定 shape（字段平铺 + vtable） | ✅ 已实现（未支持 `dynamic`） |
| 数值强制转换：`int↔uint↔Number` 回绕、`Number→int` 截断；`NaN`/`±Infinity` → 0 | ES4 draft + ECMA-262 §9 | `as_to_int32`/`as_to_uint32` 对应 AS3 `ToInt32`/`ToUint32`（NaN/Inf → 0，避开 C `(int)` 强转 NaN 的 UB） | ✅ 已实现（emit.ts 位运算/强制转换 + runtime.ts 助手） |
| `for-in`/`for-each` 的集合表达式**只求值一次** | ES4 draft | 先发射一次临时（`hoistCollection`），否则 getter 反复执行甚至死循环 | ✅ 已实现（阶段八十九·十九） |
| `typeof` 是**运行时**算子，看值的动态类型（`var o:Object = 1` → `"number"`；函数值 → `"function"`） | ES4 draft | `Object`/接口槽走 `as_ptr_typeof`（按 vtable 判号），`any` 走 `as_v_typeof`；**不按静态类型折叠** | ✅ 已实现（阶段八十九·十九） |
| `super.m` 作**值**使用时绑定超类实现（`var f:Function = super.m` 不等于 `this.m`） | ES4 draft + AVM2 | 发射 `${owner}_${mname}__superbound` thunk，`env` 造型为超类指针，不经接收者虚表 | ✅ 已实现（阶段八十九·十九） |
| **脚本只有一个作用域**：顶层任意位置（块 / `if` / `for` init / `switch` case / `try`）的 `var`/`const` 与顶层声明同为脚本作用域属性，同一名字只有一个槽；闭包读的是**属性**（共享），不是创建时刻的快照 | ES4 draft（script scope ≈ 全局对象属性）+ AVM2 | `collectScriptDecls()` 扫**整个顶层语句树**提升为 C 文件作用域全局，同时作为 `emitModuleVars` 与闭包 `scriptVarNames` 的唯一来源；发射期「顶层且是模块全局 → 只赋值」 | ✅ 已实现（阶段八十九·三十四）。例外：顶层 `for-in`/`for-each` 的**循环变量**留块内局部（元素类型发射期才定） |
| `hasOwnProperty`/`in` 对**本类与所有超类**声明的任意 trait（字段、访问器（getter 或 setter）、方法）为 `true` | AS3 参考（对照 `mxmlc`+`adl` 实测） | `Object_hasOwnProperty` 委托 `as_dyn_has`（同步走 props/getters/methods/**setters**），保证两算子永不矛盾 | ✅ 已实现（阶段八十九·十九） |
| **实例成员引用按 super 链上「最近的声明」解析**——本类自己的**访问器**（getter 或方法）盖住祖先的**同名字段**；而更近的 **setter** 只支配**写**、不遮蔽**读** | ES4 draft（沿 trait 链解析）+ AVM2 trait 解析 | `src/symbols.ts` 的 `shadowedForRead(cls, fieldOwner, name)` 沿 super 链**逐层**判定（走到声明该字段的那个类为止；**中间层**声明的 getter/方法同样生效 ⇒ `Entity`/`Mesh` 这类静态类型也对），`src/emit.ts` 五处解析点（3 处读取：成员访问 `obj.p` / 类内裸标识符 `p` / `Class` 型槽；另 2 处在 `walkInferType` 的类型推断侧，使推断与发射同答案）命中即跳过 `fields` 里的**扁平化**条目。**读侧刻意排除 setter**：内置类把 AIR 的**访问器对**保留为**存储字段**（`DisplayObject.x/y`），近处只有 setter 时**没有**祖先 getter 可回落（away3d `View3D` 的 `override set x` 之后在体内**读** `x` 正因此）。**触发实例**：`Intermediate_MD5Animation` 的 `#1009`——`ObjectContainer3D.get parent()` 被内置 `EventDispatcher` 的**同名字段 `parent`**（显示列表祖先链接；AIR 的 `EventDispatcher` 无此成员）盖住，而该槽 away3d 从不赋值 | ✅ 已实现（阶段一百二十三；示例 `examples/member-shadow.as` + 单元组 `reflection/MemberShadow`） |
| **动态读的解析顺序 = 逐层链上「最近的声明」**，与 trait 种类无关：某一层声明了该名字（字段 / 访问器 / 方法）就停在该层；**基类的字段不能压过派生类的 getter** | `adl 51.4.1` 实测（`f["parent"] === f.parent`，`File.parent` 是 getter 而 `EventDispatcher.parent` 是内部链接字段） | `as_dyn_get` 每个 vtable 层依次查 `props` → `getters` → `methods`，命中即返回，**只有一个链回边**；Proxy / `Object` / Array 子类 backing / `_dyn` 槽表兜底留在链后。`unit: reflection/DynGetTraitPriority` 钉住「链只走一遍」，防止退回成「整条链字段 → 整条链 getter」 | ✅ 已实现（阶段三百二十四） |
| 访问器属性可被**动态写入**（`o["alpha"] = v`，`o:Object`） | AS3 参考 | vtable 头部带 `setters` 反射表，`as_dyn_set` 查完 props 后走 setters 再回落动态槽 | ✅ 已实现（阶段八十九·十九） |
| **动态写一个「存在但不可写」的名字有专门的错误号**（`adl 51.4.1` 实测）：只读访问器（本类或继承来的）→ `ReferenceError #1074 "Illegal write to read-only property <key> on <接收者类>."`；方法名 → `ReferenceError #1037 "Cannot assign to a method <key> on <接收者类>."`；两者都不是（真正的未知名字、密封类）→ 原来的 `#1056 "Cannot create property …"`。三条都写**接收者**的类（`type` 写在 `ScreenMouseEvent` 上就报 `ScreenMouseEvent`，尽管 `Event` 才是声明者） | AS3 参考 + `adl 51.4.1` 实测（`temp/smeprobe/adl4.txt` 十例） | `as_dyn_set` 在「字段/访问器逐层走查」之后、`_dyn`/Array/proxy 兜底**之前**依次查 `getters` 与 `methods` 反射表，命中即抛 `as_throw_readonly_set`/`as_throw_method_assign`（都按 `hv->fqn` 报）；静态类型写入则由 codegen 直接报错 `cannot assign to read-only property 'X' of 'Y'`（`mxmlc` 的「属性 X 为只读」） | ✅ 已实现（阶段二百五十八；`unit: emit/ScreenMouseEvent` 三钉 + `examples/screen-mouse-event.as`）。**残留**：`Event.type`/`bubbles`/`target` 等 AIR 只读访问器在我方是**可写字段**（登记在 `TODO.md` 遗留表） |
| `Object`/接口槽内的原始值（`var o:Object = 1`）需**自动装箱**，取出时再拆箱 | ES4 draft + `adl 51.4.1` 的 26 格真值 A/B（`asaotui/probes/g9-adl/`） | `as_value_to_obj`/`as_obj_to_value` 成对；每个装箱类型有自己的 `GCT_*` 标记与 `gc_scan` 分支 | ✅ 已实现（阶段八十九·十九，含 boxed `Boolean`/`Function`）· ⚠️ **条件上下文与 `Boolean(o)` 一律先解箱**（阶段二百四十八补齐 `Boolean()` 这一个入口）：装箱后的 `false`/`0`/`NaN`/`""` 都是**非 NULL 对象**，指针测试会把它们判真；修后两臂 26 格 **0 差异**，钉子 `examples/object-truthy.as` + `unit: emit/ObjectTruthy` |
| **单参数类调用 `Type(expr)` 不是 C 强转**：native Error 家族（`Error`/`TypeError`/`RangeError`/`ArgumentError`/`SyntaxError`/`ReferenceError`/`DefinitionError`/`VerifyError`/`EvalError`/`URIError`/`UninitializedError`/`SecurityError`）、`RegExp`、`Namespace` 是**构造**（等价 `new`：`TypeError(5).name == "TypeError"`、`RegExp("a").source == "a"`、`Namespace("u") is Namespace`），而 `flash.errors.*` 子类（`IOError`/`EOFError`/…）与**用户 Error 子类**及其它一切类是**运行时强制转换**（`null`/`undefined` → `null`、同类或子类实例 → 该实例、否则 `#1034`） | AS3 参考（`Object`/`Error` 系列构造器）+ `adl 51.4.1` 实测（`temp/errcall`·`errcall4`·`errsub`·`errnew`；构造集合用**显式名字表**，**不是** superclass 链 —— 子类实测都 coerce） | `emit.ts` 的 `constructsOnCall()` 分流：构造走 `emitNew(...)`；其余走 **`((T*)as_v_req_inst(box(arg), &T_vt, "fqn"))`**（与「动态值落进具体类型槽」**同一条**运行时规则，不再另立一套）。**禁止**发裸指针 cast —— `(Error*)("msg")` 把字符串体当对象装箱，`catch (e:Error)` 读 vtable 即 **SIGSEGV**（talkmed-meeting「关窗即崩」的真根因；全仓 **473 处**非 `new` 的 `Error(`；无 `new` 的 `Date(…)` 因 `Date.toString` 是既有缺口，按 §2.5 **编译期响亮拒绝**） | ✅ 已实现（阶段一百五十二；`examples/error-call.as` 38 例、adl 侧 38/38 PASS + 单元组 `unit: emit/ClassCall` 16 钉） |
| **`new RegExp(不可编译的模式)` 不抛异常，得到「永不匹配」的对象**（ES3 说 SyntaxError，AIR 不抛）：对象照常存在、`source` 原样保留、`test`→`false`、`exec`→`null`、`String.replace/match/search` 视作无匹配 | AS3 参考 + avmplus 源码：`core/RegExpObject.cpp::completeInitialization` 调 `RegExp::compile()`（`core/RegExp.cpp` 把 PCRE2 报错写进 `*errorptr`）后**从不回读**该错误，`m_compiledData` 为空 ⇒ `exec()` 走 PCRE1 分支拿 `PCRE_ERROR_NULL` ⇒ `< 0` ⇒ 无匹配 | 构造侧**不抛**：`RegExp_ctor` 只记 `as_regex.err`；消费侧必须**先查 err**（`as_regex_search` 开头 `if (re == NULL \|\| re->err) return -1;`、`RegExp_exec`/`RegExp_test` 同理），否则零指令程序会「在 0 处匹配」；另：**顶层孤立的 `)` 必须记成编译错误**（PCRE2 `unmatched closing parenthesis`），否则序列编译器悄悄停在 `)` 会退化成「处处匹配空串」，`replace` 会把替换串插进每个字符之间 | ✅ 已实现（`examples/regexp.as` 14 例 + 单元组 `unit: runtime/RegExpInertConstruction` 8 钉）。真应用证据：talkmed-meeting 实时翻译的 `AISubTitleSetupWindow.sqliteEscape` 每句都构造 `new RegExp("[")`，此前因抛 `SyntaxError` 打断识别消息，字幕永远不显示 |
| 内建属性若 AS3 定义为**访问器**（如 `ByteArray.length`），赋值需触发副作用（重分配） | AS3 参考 | 同时在 `fields`（C 结构体需要）与 `getters`/`setters` 注册，手写 getter/setter | ✅ 已实现（阶段八十九·十九） |
| 构造函数实参（含副作用）**只求值一次**（`new XML(ba.readUTF())`） | ES4 draft | 单次求值 C 助手（`as_xml_parse_str_checked`），不用临时变量提升（会改变短路/三元/循环条件内的求值时机） | ✅ 已实现（阶段八十九·十九） |
| GC：写入**新生 GC 块**（尤其扩容 `memcpy`）的指针必须重新置灰 | 本项目 GC 不变式 | `gc_write_barrier`/`gc_write_barrier_value`；详见 [`gc.md`](gc.md) §6.5.1 | ✅ 已实现（阶段五十七 GC-4 增量标记的 Dijkstra 写屏障；`src/runtime.ts` 的 `gc_write_barrier`/`gc_write_barrier_value`，设计见 [`gc.md`](gc.md) §6） |
| `Context3DClearMask` 是 **uint 位掩码**（COLOR=1/DEPTH=2/STENCIL=4/ALL=7），不是字符串 | AS3 参考（adl 实测，`temp/refcheck/Mask.as`） | `intConstClass('Context3DClearMask', {...})`；`clear(..., mask)` 按位与 | ✅ 已实现（阶段八十九·二十；`src/symbols.ts` 的 `intConstClass('Context3DClearMask', {COLOR:1, DEPTH:2, STENCIL:4, ALL:7})`，`examples/stage81.as` 断言 adl 实测值） |
| `Context3D.clear(..., depth, stencil, mask)` 的 `stencil` 是**模板清屏值**（Starling 用 `DEFAULT_STENCIL_VALUE=127`，非 0） | AS3 参考 + Starling `Painter`/`RenderUtil` | 清屏值必须逐层转发到渲染后端（`as_s3d_clear` → `clearStencilValue`）；硬编码 0 会让整场遮罩失效 | ✅ 已实现（阶段八十九·二十；native `vendor/stage3d_glue.mm` 与 web `vendor/stage3d_webgl.cc` 都逐层转发清屏值——`v0.3.116` 前硬编码 0，曾致 Starling `Masks` 整场空白） |
| Stage3D 裁剪空间 **Y 向下**，与 Metal（Y 向上）相反 ⇒ 几何绕序整体相反，`cullMode=Back` 会剔掉该保留的面 | 后端适配（非 AS3 语义差异，但同属「不可静默透传」） | 每个绘制 `setFrontFacingWinding:MTLWindingClockwise`；`FRONT_AND_BACK` ≈ Metal `None`（不剔除） | ✅ 已实现（阶段八十九·二十；native 每个绘制 `setFrontFacingWinding:MTLWindingClockwise`，web 在 GLSL 顶点级反转裁剪空间 Y + `glFrontFace(GL_CCW)`） |
| 逐绘制状态设置器（`setDepthTest`/`setStencilActions`/`setSamplerStateAt`）被每批次调用 ⇒ **先比较再标脏** | 性能不变式（非语义） | 每次调用无脑重建 `MTLDepthStencilState`/采样器 = 每绘制一次驱动对象分配，渲染会掉到不可用 | ✅ 已实现（阶段八十九·十九，8 处扩容站点） |
| `DisplayObject.transform.matrix` 与 `x/y/rotation/scaleX/scaleY` 是**同一个 transform 的两种视图**：getter **返回拷贝**（改它不动对象）、setter 把矩阵**分解回字段** | AS3 参考 + `adl 51.4.1` 实测（`temp/xformcmp/Probe.as` 25 例，`adl` 写 `/tmp/xform_adl.txt`） | 读 = 由字段 + skew 残余**合成一份新 `Matrix`**（`Matrix_new`）；写 = `rotation=atan2(b,a)`、`scaleX=hypot(a,b)`、`scaleY=hypot(c,d)`（`det<0` 取负）分解回字段，分解不了的 skew 留在残余槽；`X.transform.matrix = m` 作**值**用时产出 `m`（含链式） | ✅ 已实现（阶段八十九·七十六）。实测要点：给 `(90,18)` 的对象赋 `get()->rotate(30deg)`，adl 落在 `(68.94228634059948, 60.58845726811989)`；`[2,0.5,0.4,3,11,13]` → `rot=14.036…`、`sx=2.061…`、`sy=3.026…`；零矩阵 → `rot=0/sx=0/sy=0` 且往返；零行列式与赋值当值均已对齐。**已知分歧**（只影响**字段分解选择**，矩阵往返与渲染均精确）：纯 flipX 与「零首列非零首行」——见 `TODO.md` 遗留表（含 adl 自相矛盾的证据） |
| **显示列表增删事件与 AIR 逐字对齐**：`addChild`/`addChildAt` 派发 `added`（`bubbles=true`）→ `ADDED_TO_STAGE`（`bubbles=false`，**整棵子树**先父后子各一次）；`removeChild`/`removeChildAt` 派发 `removed`（冒泡，且**子件此刻仍挂在父数组上** —— 处理器读到的 `parent`/`numChildren`/`getChildIndex` 都还是旧值）→ `REMOVED_FROM_STAGE`（子树）；容器**不在台上**时只派发非舞台事件；`childAdded`/`childRemoved` 播放器**从不派发**；`addChild` 一个**已有父**的对象会**先经旧父**派发 `removed`（+子树 `removedFromStage`）再 `added` | AS3 参考（`Event.ADDED`/`Event.REMOVED`）+ `adl 51.4.1` 10 例逐字实测（`temp/dlprobe/`） | `DisplayObjectContainer_addChild`/`addChildAt`/`removeChild`/`removeChildAt` + `as_disp_stage_walk`（子树预序，`as_is` 判容器）+ `as_on_stage`（**不回退 `ASC_root_stage`**：孤儿 Sprite 在 AIR 里不在台上，故对它 `addChild` 不派发 `addedToStage`）；`removeChildAt` 委托 `removeChild`，两条入口的事件与再入防护不漂移；`removed` 期间**不摘除**、派发后再按身份重新定位（处理器可能就地 re-parent，如 `ViewControl.removeAt()` 会在 `removed` 里销毁自己），仅在仍是本容器的子件时清父指针。**禁止**用 `DisplayObject_get_stage != NULL` 判在台（它对孤儿回退到根 Stage ⇒ 把离台容器当在台） | ✅ 已实现（阶段一百五十五；`examples/displaylist-events.as` 10 例与 adl 逐字一致 + 单元组 `unit: display/ListEvents` 6 钉） |

| **监听器注册的身份与目标相位**：① `addEventListener` **幂等**——「同一监听器」= 同函数 + 同接收者 + 同 `useCapture`（同一闭包加两次只跑一次；`this.m` 加两次得到的两个不同闭包同样只跑一次 ⇒ 判据是 **fn + env**），加两次 + `removeEventListener` 一次 ⇒ **零次**；`removeEventListener` 同样按 `useCapture` 分桶（用 `false` 摘不掉父节点上用 `true` 注册的那个）。② **`AT_TARGET` 只跑非捕获表**——AIR 的捕获阶段从根走到目标的**父节点**，注册在目标自身的 `useCapture` 监听器**永不触发**（裸 dispatcher 上捕获-only 得 0 次；`p→c` 链上从 `c` 派发得 `p.cap@1, c.bub@2, p.bub@3`） | AS3 参考（`EventDispatcher.addEventListener` 的「相同监听器不重复添加」+ 三阶段定义）+ `adl 51.4.1` **9 例双端实测**（`temp/dupprobe/`，`result.txt`） | `emit.ts` 的 `EventDispatcher_addEventListener` 在 push 前扫既有条目（`a->fn == listener->fn && a->env == listener->env` 即 `return`）；`as_disp_target` 只查 `as_listeners_get(..., false)`，捕获表只由祖先走查（`as_disp_phase(event, ancestors[i], true)`）消费。**禁止**盲追加——重复条目会让处理器跑两次，且 `removeEventListener` 只摘一个 ⇒ 残留监听器会在本次事件结束后**继续**执行（真应用：`ViewControl` 的子类化 `ADDED_TO_STAGE` 重复装 `MOUSE_DOWN` ⇒ 两对 stage `mouseMove`/`mouseUp`，一次 `mouseUp` 只摘一对，残留那对持续把滚动容器 `mouseEnabled=false` ⇒ 拖拽不回弹） | ✅ 已实现（阶段一百六十一；`examples/listener_identity.as` 9 例 + 单元组 `unit: emit/ListenerIdentity`；修前该示例 6 项变红） |

---

## 3. 决策分歧点（需项目内明确）

| 分歧 | AS3 语义 | 本项目现行 | 建议 |
|------|---------|-----------|------|
| `var x;`（无类型无初值）默认类型 | `*`（any）/ `undefined` | 无类型仍按 `int`（`symbols.ts` 约定）；显式 `*` 已建模为 `any`（`as_value` 装箱） | **维持现状**——无类型默认 `int` 是极简约定；但阶段十五起引用类型赋给推断 `int` 抛 `CodegenError`，不再静默截断 |
| **`Error` 实例的 `.message`** | AIR **不做任何转换**：实参原样存进**未类型化**的槽（`Error(5).message === 5`、`Error(null).message === null`、`Error(undefined).message === undefined`、`typeof` 随原值；只在**使用**时字符串化） | 构造期转成 `char*` String 槽（`NULL` → 字面 `"null"`）⇒ `Error(5).message` 是 `"5"`（String）、`Error(undefined).message` 是 `"null"` | **维持现状（已登记 `TODO.md` 遗留表）** —— 改成 `as_value` 原值槽会波及全仓上百处 `e.message` 读点（动态装箱 + 新的 `#1009` 面）；而保 String 槽正让 `e.message` **永不为 `NULL`**，避免把 AIR 的 `#1009` 降级成 `strlen(NULL)` |
| `Object(null)`/`Object(undefined)` 与 `typeof <XML>` | AIR：前者给**新空 Object**（不是 `null`）、后者给 **`"xml"`**（E4X 的独立 typeof 档） | ✅ 已对齐（阶段一百六十四，v0.4.135）：`Object(null|undefined)` 走新增的 `as_obj_conv`（null/undefined → 新空 Object，其余**值本身**，含 `new (Object Class)(5) === 5`）；`typeof` 的静态折叠与 `as_v_typeof`/`as_ptr_typeof` 两条运行时分派都加了 XML/XMLList 档 | **无需处理** —— 真值 = `adl 51.4.1` 数值 oracle（`temp/d31probe/`，八份双端同源输出逐行一致）；钉 `examples/typeof-xml.as` + `examples/object-box.as` 第 7 节 + `unit: e4x/TypeofXml`（6 钉） |
| `Number` 默认值 | `NaN` | ✅ 已修复（`defaultInit` 输出 `NAN`） | 无需处理 |
| `%` 零除数且结果落在**动态**类型使用点（`var x:* = a % 0`） | `NaN`（`Number`） | 守卫后的 int/uint `0`（未防护前是 UB：`-O2` 折成被除数 `5`，wasm 则 trap） | **维持现状**——要给出 NaN 就得把 `int % int` 整体变成 `double`，但那样 `7 % 3 is int` 会变 false（adl 实测为 **true**），静态类型反而更不忠实；零除数本身即 app 缺陷，而 AS3 在 int/uint 接收点（含 `var r:int = 5 % 0`）自己也给 0 |
| **帧率口径**（呈现节拍 vs 逻辑帧率） | `Stage.frameRate` 是**逻辑帧率**：`ENTER_FRAME` 按该频率派发计数，**不跟显示器刷新率**——阶段六十一/六十二 的 adl 对照实测：窗口移到 50 Hz 外接屏后 adl 的 FPS 读数仍约 **120**（靠 delta time 保持动画速度），而我们的实现读数降为 **50** | **跟随 vsync**：native 开 `SDL_RenderSetVSync(1)` 让 `SDL_RenderPresent` 阻塞到刷新周期；web 按**整 tick** 节拍（`skip = round(1000/frameRate / rAF周期)`，每 `skip` 个 vsync 呈现一帧，阶段八十九·二十九）。故帧间隔恒为刷新周期整数倍，`frameRate` 高于刷新率时封顶到刷新率（阶段四十七/六十一/六十二） | **维持现状**——这是 50 Hz 屏上唯一无拍频的物理正确做法（关 vsync 追 120 fps 会产生 120 vs 50 拍频、帧间隔在 8/20 ms 间剧烈抖动 → 卡顿）；native 与 web 两端已一致，且**这是呈现语义而非 AS3 语义**（`frameRate` 的读回值、`ENTER_FRAME` 回调行为、delta time 驱动的动画速度三者都仍正确）。**封顶现在受 `Stage.vsyncEnabled` 控制**（阶段一百二十九落地；AIR 本有此可写开关、实测默认 `true`）：`true` 时按上表封顶，`false` 时**去掉封顶**、按请求的 `frameRate` 节拍（AIR：「the player does not wait for the display's vertical refresh」）——即本行原先只能「维持现状」的拍频取舍，现在交回给 AIR 自带的退出阀。**可见口径差**只有两处：(a) 面板给不出的速率被量化到最近整数分之一（60 Hz 屏上 `frameRate=24` → 20 fps；另见 [`html5-web.md`](html5-web.md) §6.4）；(b) FPS 读数口径是「呈现帧数」而非 adl 的「`ENTER_FRAME` 派发数」。若要完全对齐 adl，需把**派发计数**与**呈现计数**解耦（按墙钟 deadline 派发 `ENTER_FRAME`/计时器，呈现仍每 vsync 一次），代价是引入「一帧内多次派发」或「派发与呈现不同步」的新语义面（`Stage_dispatchFrame` 开头的 `gc_step()` 安全点、`as_timer_tick`、脏矩形/增量重绘都要重新核对）——收益不值，故明确不做 |
| **多窗口下的帧派发**（`Stage.frameRate` 的作用域） | `Stage.frameRate` 是**整个应用一个值**（AS3 参考：任一 `Stage` 改动影响所有 `Stage`；`adl 51.4.1` 实测：主窗口设为 `4` 后**新开的 `NativeWindow.stage.frameRate` 也读 4**），`ENTER_FRAME`/计时器/`MovieClip` 每**应用帧**各推进一次——**不随窗口数叠加** | ✅ 已对齐（阶段八十九·七十三）：生成 C 里只有一个 `static double ASC_app_frame_rate`，每个 `Stage` 的 `frameRate` 访问器都代理它；`vendor/window_glue.cc` 的 `sk_run_loop` 每 tick 只跑**一个应用帧**（一个滚动 deadline + 一次 `on_frame` + 把每个可见窗口标脏），随后各窗口只做自己的光栅化与呈现 | **无需处理**——修复前是两处独立偏离：`NativeWindow_ctor` 硬写 `stage.frame_rate = 24`（把「应用当时的值」误当成每窗默认值），且 `Stage_dispatchFrame` 忽略传入的 Stage、向进程级 `as_ef_objs` 广播而 glue 又**每窗口调用一次** `on_frame`（N 窗 = N 次广播，实测主 120 + 2×24 = **168**，与用户截图一致）。现由 `[native-window]` 的 5 条钉子钉住（31 → 36 项） |
| **`Stage.frameRate` 的默认值与 `[SWF]` 元数据** | 未赋值时是 **24**（`adl 51.4.1` 实测：文档类构造器里 `stage.frameRate` 读 24）；`[SWF(frameRate = N)]` 元数据（放文档类上，talkmed-meeting `src/Main.as:105` 就是 `frameRate = 60`）是**应用启动时的初值**，之后 `stage.frameRate = x` 才能改；写入被**钳到 0.01..1000**（实测：`-5`/`0` → 0.01，`2000`/`1e9` → 1000，而 `0.005`/`0.01`/`12.5`/`1000` 原样通过，`NaN` 原样保留） | ✅ 已对齐（阶段一百四十八）：解析器把 `[SWF(frameRate=…)]` 记进 `Program.swfFrameRate`（三种写法 `60` / `"60"` / `12.5` 都认），codegen 用它初始化 `ASC_app_frame_rate`、缺省 24 并按同一张表钳位；`Stage_set_frameRate` 钳位、`NaN` 直通，而窗格节拍器用 `if (!(fr > 0.0))` 兜底（`NaN` 既不过 `<=` 也不过 `>`，取反比较才不会把 deadline 污染成 NaN） | **无需处理** |
| **`flash.net` 网络加载面** | AIR 的 `URLLoader`/`URLRequest` 支持 `http`/`https`/`file`/`app-storage`/`app` scheme，GET/POST（应用沙箱内可用任意 method、任意请求头），7 个事件（`complete`/`open`/`progress`/`ioError`/`httpStatus`/`httpResponseStatus`/`securityError`）、`bytesLoaded`/`bytesTotal`、`close()` 真中止；`URLRequestMethod` 6 常量（GET/POST/PUT/DELETE/HEAD/OPTIONS） | 本项目是**本地文件读取器套了一个 HTTP API 外壳**：URL 一律当文件系统路径 `fopen`（`URLLoader.load`）；`URLRequest.method`/`.data`/`.contentType` 可写但**从不被读**（**死字段**）；`URLRequestMethod`/`URLRequestHeader`/`URLRequestDefaults`/`URLStream` **四个类不存在**；`open`/`httpStatus`/`httpResponseStatus`/`securityError` **永不派发**；`close()` 是**空函数**；`bytesLoaded`/`bytesTotal` 缺失；**GET/POST 完全没有**（实测：设 `method="POST"` + `data` 后 `load()` 照样把 URL 当地路径读出本地文件） | **明确记录的差距（待实现，非「维持现状」）**——**其主体已于阶段八十九·四十八~五十三 闭合**（A/B 语义面与契约 → 四十八；G + native 探针 → 四十九；构建层 `targets` → 五十；C 内核 + D/E/F/H → 五十一；AIR 保真校正 + 验收 I → 五十二；**`Socket`/`ServerSocket`/`XMLSocket` + 静态自包含 + 代理/cookie/HTTP-2 → 五十三**；仍余 preview2 `wasi:http`、AMF、`SecureSocket` TLS、`DatagramSocket`，见 `TODO.md` 遗留表）。完整官方 API 面、现状偏差表、8 阶段路线与验收方案见 [`flash-net.md`](flash-net.md)（其中 **§4.1.2** 给出 libcurl 的**引入方式**：首期零 vendor 直接用系统库，要静态自包含才走 `build-tools/`→`vendor/`）。**A（语义层补全：常量类/字段/`decode()`）+ B（契约补全：`bytesLoaded`/`open`/`close` 真中止）无网络依赖、低风险，建议先做**（消除「设了 `POST` 却无反应」「`close()` 是空函数」等**误导性**偏差）；**C（HTTP/1.1 + TLS 客户端）之后是独立重工程**，难点是 HTTPS/TLS 与三目标分叉（native socket / web `fetch` / WASI 无 socket → 诚实 `ioError`） |
| **异步 IO 的执行位置与排空时机** | AIR 单线程 + 帧驱动事件：IO 在后台**确实并发**进行，事件按到达尽快派发；`URLLoader`/`FileStream` 在终态事件前先派 `PROGRESS`（可多次、带水位）；`Loader.load()` 对不可读 URL 与非图 payload 都派 `IOErrorEvent`（#2124「Loaded file is an unknown type」），**不**派 `COMPLETE`，数据/内容只随终态事件可见（`LoaderInfo.complete` = 「dispatched when data has loaded successfully」）；同一目标重复 `load()` 重启加载，旧请求不再派事件 | **执行位置**：native（macOS/Linux pthread）用 4 worker 池真后台 read+decode（`ASC_ASYNC_THREADS`），worker 绝不碰 GC 堆，输入提交时拷到 malloc；web/WASI/Windows 目标**同步内联**（`as_async_submit` 就地跑完，只推迟事件）。**排空时机**：结果落 malloc 暂存，只在**下一个帧边界**由 finish thunk 搬进 AS3 可见状态（`Stage_dispatchFrame` 先 `as_async_tick()` 再 `as_timer_tick()`）；headless `tickTimers()` = 等 worker 排空 + 一次排空全部 DONE（保持例程确定性）。`PROGRESS` 目前**只派一次**（`loaded == total`，读不分块无中间水位）；`LoaderInfo.PROGRESS` 仍不派发（Starling 监听的是 `URLLoader`）；`LoaderInfo.bytesTotal` 在终态才非 0 | **维持现状**——(a) 帧边界派发是 AIR 帧驱动模型的最接近实现，且「入表→thunk 跑完前不移出 job 表」是 GC 根不变式（提前移出会被 sweep 清零，已实测 SIGSEGV）；(b) native 与 web 的差别只在「读/解码是否占主线程」，web 无 worker 是既定取舍（wasm 单线程模型下 pthread 需 COOP/COEP，见 [`html5-web.md`](html5-web.md)）；(c) PROGRESS 单次是「读不分块」的直接后果，要报水位就得改分段读（N 次 read + 逐块重试语义），收益不值；(d) 纯 C 构建无解码器（`as_skia_image_decode_bytes_argb` 为返回 NULL 的桩）→ 图像加载报 IO_ERROR，解码成功路径由 skia 后端覆盖（native demo 验收）。详见阶段八十九·四十五与 `examples/async-io.as` |
| `adl` 把 `DisplayObject.x/y` 量化到 **1/20 px（twips）** | AS3 规范**无此约定**（avmplus 内部存储口径）：`Matrix.rotate` 算出 `tx=68.94228634059948`，一经 `transform.matrix =` 回来就成 `68.9`；`ty` 同理（`60.58845726811989` → `60.55`） | 保留全精度（`x/y` 就是 `double`） | **维持现状**——twip 量化不是规范语义而是实现细节，复刻它等于**降低**精度且会让所有布局数值被无意义地截断；验证时改用容差（`x/y ±0.05`、`rotation/scale ±2e-4`）而非比对字面量。另：`adl` 的分解中间量走单精度（`scaleX 1.6` → `1.5999908447265625`），同属内部口径 |
| **命中测试的贴边松紧**（不是「半像素容差」，而是位置相关的光栅化相位） | AS3 规范把命中定义为「点落在对象的**边界框/形状**内」，但未定义边界的浮点口径 | 本实现按**严格几何**（包围盒 `l <= x <= r && t <= y <= b`，形状判据同口径，全 `double`） | **维持现状，差异已量成上界**（阶段二百四十一，见 §3.4）：`adl` 的边界相对几何边有**位置相关**的锯齿——box 侧恒**更松**（−0.41…0.00 px）、region 侧两侧都有（−0.11…+0.31 px）、周期约 0.5 px。它是**纯函数**（重复 / 正反扫描 / 换序 / 插问邻居全一致）却**不是可抄的规则**：把 20x20 填充的左边缘按 1 twip 滑 6 步（`getBounds` 逐次证实边缘真的动了），`adl` 报出的左边界**六次完全相同**（钉在绝对网格上）。复刻只会给命中测试引入半像素模糊，而可见口径差 ≤ 半像素、且只在「边界 ±0.5px」这条测度为零的带上 ⇒ 示例/回归一律用**内部点**断言（如 `(328,142)` → local `(49.49,9.88)`）。旧口径「只在贴边 ~0.05px 内」已被本阶段推翻（那是 `temp/c1probe/` 单个旋转方块抽样的巧合，见 §3.4） |
| **AMF trait 成员序** | AMF3 的 `traits` 里成员顺序在规范里**无要求**（成员名与值同序出现，读取方按名配对；`describeType` 也未约定 `variable` 顺序） | 本实现按**声明序**（生成的 `Class_amf_members[]`，确定性、跨构建可复现） | **维持现状（已实测定案：无可对齐目标）**——`adl 51.4.1` 侧的序**不是**声明序，且**不可对齐**：① 把同一组四成员**反序声明**，`adl` 给出的序与正序**逐字相同**（⇒ 只由成员名字集合决定）；② 同一个 SWF 连跑三次一致（⇒ 由构建产物决定，非运行期随机）；③ 源码**只加一个未被引用的类**时序不变，但加 **3 个无关的（被 `registerClassAlias` 引用的）类**后、**未被触碰**的类 `Mix` 的序从 `n1 u1 s1 o1 s2 i2 i1 b1` 漂到 `o1 n1 s1 u1 i2 b1 i1 s2`，还原源码重建即复原（⇒ AVM2 内部 trait/多重名表布局的副产品）。连 `adl` 自己都不能在源码演进中保持稳定 ⇒ **不存在可对齐的语义目标**；互通不受影响（trait 自带成员名）。证据：`temp/a6probe/`、`examples/stage94e.as`、`test.ts` `[amforder]`。⚠️ 由此阶段九十四·四 的「AMF3 与 `adl` 逐字节一致」应读作「**trait 成员名/值的编码形态**逐字节一致」 |

---

### 3.1 可编辑文本与键盘（阶段九十四·七 · C2 实测）

以下几条是**AIR 内部的实现细节**，AS3 规范未约定，但两端口径必须一致才能做到双端零差异；本实现选择**逐字复刻 `adl`**（而非「更合理」的做法）。读法与下面 §3 的决策分歧点一致：**维持现状**或**如实记账**。

| 分歧点 | 规范/直觉做法 | `adl 51.4.1` 实测 | 本实现 |
|--------|--------------|------------------|--------|
| `setSelection(0, 0)` | 「把光标收缩到 0」（与 `(n,n)` 同构） | **空操作**：不改变原有选区（四种前态 4/4 复现） | 逐字复刻（`begin==0 && end==0` 直接 `return`）；`(3,3)`/`(0,1)` 等照常生效 |
| `Shift+Home` / `Shift+End` | 对称：两端都「拖选区 + 光标移到端点」 | **不对称**：`Shift+Home` 只把选区起点拖到 0、**光标留在原处**；`Shift+End` 把选区长到文本尾且**光标落到尾** | 逐字复刻（`as_tf_edit_key` 两者分开特判） |
| `Shift+Delete` | 等同 Apple 的「剪切」（删选区并写剪贴板） | **完全不动**：keyDown **不派发**、文本与选区不变（配对的 keyUp 照常派发） | 逐字复刻：输入字段获得焦点时吞掉该 keyDown |
| 菜单加速键下的 `keyUp` | `Cmd+←/→/Z` 是普通按键，down/up 应成对 | 字母/方向键的 keyDown 会到（`ctrlKey=true`，且光标真的动），但其 **keyUp 不到**；Cmd 自己的 keyUp 会到 | 逐字复刻：`mod & ASC_MOD_CMD` 下非修饰键的 keyUp 一律吞掉 |
| `new TextField().text` | 未设置时返回 `null` | **空字符串** `""`（`.length == 0`） | 构造时给空字符串（给 C `NULL` 会让 `text == ""` 为假、`.text.length` 解引用空指针） |
| `new TextField().tabEnabled` | 与可编辑性无关，默认 `false` | `type` **真的变化**时才跟到 `(type == "input")`；同值重赋**不动**手改过的值 | 默认 `false`（原写 `true` 是误读——探针里的 `true` 来自它自己设了 `type=INPUT`）；且 `type` 的 **setter** 复刻了联动（值真的变化时才写 `tabEnabled`，同值重赋不覆盖手工值） |

**已记账的近似/缺口**（逐条证据与修法见 `TODO.md` 遗留表）：编辑索引按 **UTF-8 字节**（AIR 是 UTF-16 码元）、`Tab`/`Shift+Tab` **不做焦点遍历**（Ed2 全回合唯一未对齐点）、`PageUp`/`PageDown` 只派发不改光标、`wordWrap` 下 `Up`/`Down` 的可视行列、输入法合成中态（marked text）、`restrict`/`displayAsPassword` 只存不生效、`MouseEvent.DOUBLE_CLICK` 从不派发（双击选词走引擎内部保留通道，不产生 `MouseEvent`）。⚠️ 本节曾有一处**误判**：C2 当时把「鼠标拖选只在 `type='input'` 生效」写进了实测口径，但那是**只做了一次合成拖拽**就下的结论；阶段九十四·八 用逐事件探针（`Ed5`）**推翻**了它——见下 §3.2。

---

### 3.2 文本边框与鼠标选区（阶段九十四·八 实测）

同样属于「规范未约定、但两端口径必须一致」的实现细节。**重点是一处口径的修正**：AIR 判定「按在选择区内」用的不是「点在字符间隙的闭区间」，而是**按像素高亮矩形**——高亮覆盖 `[x(begin), x(end))` 这段像素，左边界在内、右边界在外。换成索引口径就是**半开区间** `[begin, end)`。

| 分歧点 | 规范/直觉做法 | `adl 51.4.1` 实测 | 本实现 |
|--------|--------------|------------------|--------|
| 拖选门控 | 「只有可输入的字段才谈得上选区」（C2 曾据此只放行 `type='input'`） | `dynamic + selectable=true` 字段**同样**支持拖选，`mouseUp` 后 `Cmd+C` 能把选中文本复制走 | 门控只剩 `selectable`；**键入**仍限 `input`（`as_tf_is_input`） |
| 拖拽锚点 | 锚点 = 起拖字符，选区随拖拽扩展 | `mouseDown` 把光标**塌缩**到命中索引并设为锚；拖拽期 `begin=min(anchor,idx)`/`end=max(anchor,idx)`/`caret=end`（正/反向给**同一个**选区） | 逐字复刻 |
| 「按在既有选区内」 | 按字符间隙判定，两端都为闭 | 按**像素高亮矩形**：`idx >= begin && idx < end`（**左边界保留、右边界塌缩**，Ed5 step 8/11a/13b/13c 逐例锁定） | 逐字复刻（半开区间） |
| 双击选词与「按在选区内」的先后 | 双击落在既有选区内时，先塌缩再选词也无妨 | 双击的第二次 `mouseDown` 会先走「按在选区内」分支，若不禁用待塌缩态，随后的 `mouseUp` 会把**刚选中的词**塌缩掉 | 保留通道 `wordSelect` 桥接时清空待塌缩态（`drag_tf`/`drag_anchor` 提升为文件作用域 static） |
| `border` 默认值 / 几何 | 「1px 边框画在盒内」（常见 UI 直觉） | 默认 `false`；四条 1px 完全不透明**无抗锯齿**实线落在字段盒的**外沿像素**上（`x∈{0,width}`、`y∈{0,height}`），故 `BitmapData.draw` 源面是 `width+1 × height+1` | 逐字复刻：四个**像素对齐的填充矩形**（不用 `stroke`，它会把外沿像素半覆盖），`as_render_bounds`/`draw` 同步 +1；不影响 `textWidth`/`textHeight` |
| 颜色属性的位宽 | 「`uint` 就是 32 位，alpha 应该保留」（C2 前本实现不做掩码） | 三个颜色属性（`backgroundColor`/`textColor`/`borderColor`）都是 **24 位 RGB**：写入**丢弃 alpha 字节**，读回也看不到（`0x8000FF00` → `0xff00`、`0xFFFFFFFF` → `0xffffff`） | 写入掩码 `& 0xFFFFFFu`（渲染本就用独立 alpha 参数，故只影响读回） |

**已记账的近似/缺口**：`scale != 1` 时边框线宽**随对象缩放**（`adl` 恒 1 物理 px；`scale=1` 两侧完全一致）；光标落点的度量差（`adl` 21/26 vs 我们 18/23）与 §3.1 的字体度量行同源。逐条证据与修法见 `TODO.md` 遗留表。

---

### 3.3 内建签名的实参对齐（阶段一百九十五 · 全表实测）

AIR 的内建方法形参表**不能凭文档抄**：AS3 参考页会漏掉真实默认值（`DisplayObject.getBounds`、`IndexBuffer3D.uploadFromVector` 都显示「无默认」，而 `mxmlc` 实际接受少参调用），也会写错（`Context3D.configureBackBuffer` 的 `antiAlias` 看起来可选，实测**必填**）。故本阶段的口径是：**可选性（能否省略）以 `mxmlc 51.4.1` 接受与否为唯一权威**（它读的是 `airglobal.swc` 里的真实 trait），**默认值取文档给出的那个值**。做法：对每个内建类的每个实例方法/静态方法/构造器的**每一个实参个数** `j = 0..n+1` 各造一格，用 `mxmlc` 判接受、用本编译器判接受，逐格比对（共 4964 格；脚本、原始判定与逐类签名留档在 `temp/optarg/` 与 `temp/asdoc/`）。

| 类别 | 现象 | 数量 | 例子 | 处理 |
|------|------|------|------|------|
| A | AIR 接受，而**我们要求补齐实参** | 300 → 0 | `ctx.drawTriangles(ib)`、`ctx.configureBackBuffer(1, 1, 0)`、`new NativeMenuItem()`、`hasOwnProperty()` | ✅ 已修：按文档值补默认（`greq`/`gopt` 两组形参助手） |
| B | **我们发明了 AIR 没有的默认** | 48 → 0 | `g.moveTo(1)`、`m.rotate()`、`r.inflate(1)`、`p.normalize()`、`new ShaderData()` | ✅ 已修：改回必填（收紧——不再接受 `mxmlc` 拒绝的程序） |
| C | 我们声明了**多余的形参**（AIR 不许传这么多） | 9 | `File.moveTo` 多一个 `force`、`BitmapData.encode` 多一个 `byteArrayOffset`、`FileListEvent` 多一个 `directory` | 登记遗留（需改 C 侧签名与实现） |
| D | AIR 接受**更多实参**（`...rest` 或更长的形参表） | 27+ | `NetConnection.connect(…rest)`；`MouseEvent` 构造器缺 `commandKey`/`controlKey`/`clickCount`；`TextFormat` 构造器缺 7 个尾参 | 登记遗留（需 C 侧接受并忽略多出的实参） |
| E | 成员**根本没实现**（与实参无关） | 3 | `BitmapData.floodFill`/`merge`、`SharedObject.name` | 登记遗留 |

**实测定案**（A/B 两类逐格清零，C/D/E 逐条记账）：

1. `Context3D.drawTrianglesInstanced` 的形参序是 `(indexBuffer, numInstances, firstIndex = 0, numTriangles = -1)`——`numInstances` 在**第二位**，与 `drawTriangles` 的 `firstIndex` 在前**不同**。我们此前序也错，于是 AIR 合法的两参调用 `drawTrianglesInstanced(ib, 3)` 会被读成 `firstIndex = 3`（静默几何错）；本阶段把**形参序与 C 侧签名**一起改齐，并用「两参调用发出 `numInstances`」的钉子锁住。
2. `Object.hasOwnProperty()`/`propertyIsEnumerable()` 允许**空参**调用（`mxmlc` 不报错），故形参是「可省、默认 null」；二者在 `Object` 上声明一次、被全部类继承，早期审计把 145 份继承副本误读成 145 处独立缺陷（按声明处改一次即可）。
3. `Stage3D.requestContext3D` 的形参名是 `context3DRenderMode`、默认 `"auto"`；AIR 还有第二形参 `profile = "baseline"`，本后端不消费（登记遗留）。
4. **文档不是可选性 oracle**：默认值抄文档，可选性必须实测。同理，内建形参表**斜**（我们比 AIR 短或长）时，靠「按我们的形参个数造格」的扫描**发现不了**——D 类因此是「文档形参数 vs 我们的形参数」的交叉比对补出来的。
5. **类值当函数用时，形参个数就是「构造 / 转型」的判据**（阶段三百一十四）。`flash.geom` 的 `Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform` 在 AIR 里**不带 `new` 也能构造**（本编译器的宽容扩展），但**一元形式不是构造、是转型**：`mxmlc` 对 `Point(1, 2)` 报「参数的数量不正确。要求不超过 1 个」——一个类值当可调用对象用时**最多只收 1 个实参**，那一格就是 `Number(o)`/`String(o)` 式的转型。`adl 51.3.2` 实测 `Point(o).x` 读出的是**那个对象本身**的 `x`（探针 `temp/perf-b3/src/GeomProbe.as`，40 行与 AOT 逐字相同）；而旧写法把一元也喂给 `emitGeomConstructor`，生成 `Point_new(as_v_to_number(o), 0.0)` ⇒ `.x` 恒 `NaN`、`.y` 恒 `0`，**不报错、不警告**。钉子 `unit: emit/ValueClassCoercion`（12 条，其中 4 条直接断言生成的 C 里是 `as_v_req_inst(..., &Point_vt, "flash.geom::Point")` 而不是 `Point_new(...)`；`Point(o, 3)` 仍走构造，那条扩展不收回）。

---

### 3.4 命中测试边界的光栅化模糊带（阶段二百四十一 · 三组探针实测）

遗留表里两行（「box 边界在描边外缘外 0.25px 仍命中」、「贴边 ~0.05px 不一致」）此前只有
「42 行逐行对照里 2 行不同」这一条窄证据。本阶段用 `temp/hitprobe3/` 把它量透，**结论是两行都不必复刻**，但**旧口径的幅度说错了**（不是 0.05px / 0.25px 的容差，而是位置相关的锯齿）。

**探针 1：边界不是容差，而是绝对网格相位。** 一个 `(100,100)` 20x20 填充的边界，用 1 twip
（0.01px）阶梯扫描；随后把**左边缘本身**按 1 twip 从 `100.00` 滑到 `100.25`（`getBounds` 逐次
证实边缘真的动了），`adl` 报出的左边界**六次完全相同**（box `100.05`、region `100.20`）。
即：边界不跟着对象走，它钉在某个**绝对位置**上。

**探针 2：纯函数。** 同一查询点重复问 6 次、递增扫 vs 递减扫、两趟、两个对象交错换序、
中间插问第三个对象——结果全部一致。这排除了「上一次查询影响下一次」的缓存/状态 bug 假设
（否则它就是一个可修的缺陷，而不是平台口径）。

**探针 3：四边误差矩阵（量上界）。** 16 个 40x40 填充（左边缘 `200.13 + k*0.13`），每边扫
±1.2px、步长 0.01，记 `边界 − 几何边`（负 = `adl` 更松）：

| 边 / 判据 | 偏差范围 |
|---|---|
| box 左边 | −0.41 … 0.00 |
| region 左边 | −0.11 … +0.31 |
| box 上边 | −0.40 … 0.00 |
| region 上边 | −0.40 … +0.25 |

box 侧 `adl` 恒**更松或相等**（形状像 `floor` 到 0.5px 格子），region 侧两侧都有（抗锯齿覆盖率
判定偏移几十个百分之一像素）；周期约 **0.5px**，另叠一条更长的漂移。同一份几何在
`-default-size 500 375`（stage 缩放进 800x600 窗口，scale 1.6）与 `-default-size 800 600`（1:1）
量到**同一量级**的锯齿 ⇒ 与舞台缩放 / 设备像素无关。

**探针 4：交互拾取已经问的是内容区域**（遗留表第三行的决定性证据）。真鼠标点击六点：无图形的
`Sprite` 在**自己盒内、子件之外**的任何位置（横向缝 `(250,220)`、纵向缝 `(210,260)`）都不是目标
（`e.target` 落到 stage）；画了底板的容器在同样的缝里**是**目标；`Shape`（`Shape extends
DisplayObject`，不是 `InteractiveObject`）自己不可能是目标，事件落到最近的**可交互祖先**。
与本实现阶段二百三十三 的改法**逐点一致**，钉子= `examples/hit-pick-layer.as`（A/B/C/D 四节）。

**裁决**：维持严格几何，两行遗留按「平台侧不可抄的光栅化模糊带」结案，只把**上界**留在
本表；复刻它需要一张绝对网格表，且会把「贴边未中」变成「贴边中」的假阳性。我们的边界规则
（闭区间、含描边）由 `examples/hit-boundary.as` 钉住，防止后人在不知情的情况下改成模糊判定。

---

### 3.5 三条运行时契约：`setChildIndex` 判据顺序 / roll-over 对 / `drawPath` 解释器（阶段二百七十五 · adl 51.4.1 实测）

三条都是「API 在 AIR 里存在、我们的实现却在**语义**上不同」的缺陷（登记为 `asaotui/compiler-gaps.md` 的
G24 / G25 / G26）。它们的共同点是：**只有拿真 AIR 逐条量过，才知道正确的判据长什么样**——靠读文档
或凭直觉都会写错，其中 G24 的顺序甚至是**反直觉**的。

**① `DisplayObjectContainer.setChildIndex(child, index)` 的判据与顺序。**
实测（`temp/g242526/air-sem.txt`，探针 `AirSem.as`）三条错误**依次**是：

| 情形 | 抛出的错误 |
|---|---|
| `child == null` | `TypeError #2007`「Error #2007: Parameter child must be non-null.」 |
| `index < 0`、`index >= numChildren`（**空容器任意索引都算**） | `RangeError #2006`「Error #2006: The supplied index is out of bounds.」 |
| `child` 不是调用者的孩子 | `ArgumentError #2025`「Error #2025: The supplied DisplayObject must be a child of the caller.」 |

**顺序是 null → 索引 → 是否我的孩子**。决定性证据有两条：`setChildIndex(nonchild, 99)` 报的是
`#2006` 而**不是** `#2025` ⇒ 索引判定在孩子判定之前；`setChildIndex(null, 0)` 报 `#2007` ⇒ null 判定
在最前。另外 `getChildIndex(nonchild)` ⇒ `#2025`、`getChildAt(-1)` / `removeChildAt(-1)` ⇒ `#2006`，
与上表同源。三条判据都必须在**任何写入之前**：被拒绝的调用绝不改变子件顺序。

**为什么这条重要**：夹紧越界索引的实现「恰好」把最后一个孩子放到正确位置，画面**逐像素相同**，
所以任何截图门、任何 AOT 探针都看不见差别；只有真 AIR 会抛。见 `asaotui/reviews/air-sweep-2026-10-24.md`。

**② roll-over 事件对（`rollOver`/`rollOut`）与 mouse 对（`mouseOver`/`mouseOut`）的差别。**
用**真光标**驱动 `adl`（posted `WM_MOUSEMOVE` 会被物理光标重推，测不准）得到的契约：

- 进入：先 `rollOver`（`bubbles = false`、`eventPhase = 2`，从命中目标**逐个向祖先**发），再 `mouseOver`
  （`bubbles = true`，**从目标向外冒泡**，`currentTarget` 逐层换成祖先）；
- 离开：先 `mouseOut`（冒泡），再 `rollOut`（不冒泡，自内向外）；
- **目标不变则一个事件都不发**；
- **不发多余的 leave/enter**：只对「指针已不在其子树内」的节点发 `rollOut`，只对「指针原先不在其子树内」
  的节点发 `rollOver`。这条在「子件被摘出显示树」时尤其关键——AIR 是拿**移除之前的那条链**做抑制判定，
  所以我们把「刚被移出的容器」作为 `anchor` 参与判定，而不是把旧目标置空（置空会让祖先误以为指针是新进来的）；
- 链**止于 Stage**：Stage 只收到冒泡的那一对，不参与 roll 对；
- handle 从显示树摘掉的**下一拍**仍要对那个（已脱离的）节点投递 leave ⇒ 需要一个帧边界补发点，且该目标必须是
  **永久 GC 根**（应用可能已丢掉最后一个引用）；
- 窗口退出时离开对的坐标是 **`-1,-1`**（不是最后那个窗内坐标）。

**已知分歧**：对「已脱离节点的补发离开对」，AIR 报 `stageX/stageY = 3,3`——既不等于最后的窗内坐标，
也不等于移除位置，AIR 自身无法解释；我们报**真实指针位置**（如 `60,60`）。取可解释的那个，不模仿。
逐行对照：`temp/g242526/mouse2-air.txt` vs `mouse_aot.txt`（108 行，事件类型/顺序/target/currentTarget/
bubbles/phase 全同，仅上述坐标差 4 行）。

**③ `Graphics.drawPath(commands, data, winding)` 的解释器口径。**

| 情形 | AIR 行为 |
|---|---|
| 常量表 | `NO_OP=0 MOVE_TO=1 LINE_TO=2 CURVE_TO=3 WIDE_MOVE_TO=4 WIDE_LINE_TO=5 CUBIC_CURVE_TO=6` |
| `winding` 非法 | `ArgumentError #2008`「Error #2008: Parameter winding must be one of the accepted values.」 |
| `data.length` 为奇数 | `ArgumentError #2004`「Error #2004: One of the parameters is invalid.」（**在画之前**） |
| 短数据 / 空数据 / `null` 向量 / 未知命令值 / `NO_OP` | 不抛 |
| 命令表**只有** `MOVE_TO` + 一段曲线 | **不产生填充面**（0 ink），但**描边照画**（236 ink）。**这是 `drawPath` 独有的怪癖**：同一份几何走平 API（`moveTo` + `cubicCurveTo`）**会填** |

`cubicCurveTo.length == 6`、`drawPath.length == 3`（第三参默认 `evenOdd`），自身永不抛（NaN、作为首命令
都不抛）。`GraphicsPathWinding` 是**常量袋**（构造器不 public）：`EVEN_ODD="evenOdd"` / `NON_ZERO="nonZero"`，
winding 是**组级状态**（记在 `Graphics` 上，`endFill` 时重放）。

**「单段曲线不填」不是「未闭合不填」**（Pix8 七格实测）：`[MOVE_TO, LINE_TO, LINE_TO]` 的**未闭合**三角形填充 **248226**（平 API 同样 248226）；`[MOVE_TO, CUBIC_CURVE_TO, CUBIC_CURVE_TO]` 填充 **232198**；只有「正好一整条命令表 = `MOVE_TO` + 一段曲线」是 0。所以规则是**段数 ≥ 2 才填**，且**只在 `drawPath` 上成立**。我们这一格**不复刻**（会多填一块），理由与量值见 `compiler-gaps.md` G26。

**紧包围盒**（推翻本项目旧注释「控制点入包围盒，同 `SkPath::getBounds()`」）：AIR 的 `width/height` 是
**曲线的紧包围盒**。`moveTo(10,50) + cubicCurveTo(10,0, 90,0, 90,50)` ⇒ **80x37.5**（凸包会给 80x50）；
`curveTo(10,0, 90,50)` ⇒ **80x25**（凸包 50）。实现取**导数零点**（二次解一次方程、三次解 `A t²+B t+C`，
只有 `t∈(0,1)` 才取），于是纯 C 构建与 Skia 构建量到同一个盒子（`as_gpath_quad` / `as_gpath_cubic`）。

**已知残差**：`drawPath` 画出的三次曲线**描边** coverage 我们比 AIR 低约 7%（笔宽/AA 采样口径不同，未定位），
其余各格在 1% 内（AA 阈值，非几何差）；两条都不产生可见结构差异，登记在 `compiler-gaps.md` G26。

---

### 3.6 未捕获错误的报告：折叠重复，但绝不丢计数（阶段二百七十八）

**语义前提（不是我们的发明）：** 帧回调（`ENTER_FRAME` 等）里抛出的未捕获错误在**帧边界
恢复**，进程继续跑 —— AIR 也不会因此终止播放器。于是"帧里有个 null 接收者"这种 bug
不是崩一次，而是**每次调用抛一次**。实测（`temp/crashmon/session-A-20261025-2232.log`，
Windows AOT 真应用）：一轮会话 **623 条完全相同的 `#1009`**，40 秒内刷满 stderr，把后面
真正的死因（`Present failed 0x887A0005` → 386 ms 后 AV）挤出了日志窗口。

**报告策略（`as_report_uncaught`）：**

1. 一条消息的**第一次出现照原样完整打印**；
2. 之后**同一条消息**的重复只在**同一秒内**折叠，且**最多折叠 20 条**——到 20 条就打出
   `(20 more of the same)`，计数清零重新累计。所以风暴的**密度**始终可见；
3. 攒下的计数在 `exit` 时由 `atexit` 钩子补打一行。**程序结束前的那一批不会消失**：
   一个 1 秒内跑完的风暴，修复早期版本会报"1 条"，正是被这条钉住的（示例 50 次抛错 →
   1 + 21 + 21 + 7 行，合计恰好 50）；
4. 计时与计数是 `ASC_TLS` 的：帧线程和 IO 回调线程可能同时抛错，共用一份"上一条消息"
   缓冲会互相截断文本。代价是**其他线程**在退出时残留的计数会丢 —— 已经是诊断信息，
   不值得为它引一条 per-thread 退出钩子，这条限制写在源码注释里。

**这不改变控制流。** 折叠的是报告，不是抛出：`examples/uncaught-storm.as` 里 50 帧全部
跑完（`frames == 50`），每一帧都真的抛了，只是日志只留 4 行。

**归属：** 这不是一个 `adl` 对齐项 —— AIR 的错误/trace 输出格式本来就和我们的
`Uncaught exception: ...` 不同，这一节是我们的**诊断约定**。它不改变任何 `flash.*` 的
API 面、错误码或事件顺序，只决定同样的信息写进 stderr 时写几遍。

定位到**具体哪一行代码**用 `ASC_NULL_TRACE=1`（见 `docs/zh-cn/win32.md` §3.14），
那会把 `#1009` 的消息追加生成 C 的 `[文件:行]`。

### 3.7 对象 `alpha` 的合成口径：AIR 逐图元相乘，我们曾经逐对象隔离层（阶段三百一十五 · adl 51.3.2 实测）

**`adl` 的实测行为**：`DisplayObject.alpha < 1` **不是**一个「先把子树合成到一张图、再用这个 alpha
贴回去」的图层。AIR 把 alpha **乘进每一次绘制**，因此：

- 子树只画 **1 个**图元时，两种做法逐像素相同（我们的折叠就是按这个前提做的）；
- 子树画 **≥2 个重叠**图元时，两者不同。实测（`temp/alphafold/`，同一份 `.as` 分别 `adl` 与 AOT，
  `BitmapData.draw` 后逐点取样）：一个 `alpha=0.5` 的 Sprite 里两个**重叠的不透明矩形**，
  重叠点 `adl` 给 **`ff7f7f3f`**、我们（隔离层）给 **`ff7f7f00`**。分子式也对得上：
  AIR = 蓝 0.5 → 黄叠上去留下 63 的蓝；我们 = 重叠区先合成成纯黄，再整体乘 0.5 ⇒ 蓝 0。

**8 位覆盖度是截断，不是四舍五入**。同样由 oracle 抓出：`255 * 0.5 = 127.5`，`adl` 用 **127**，
而 `SkPaint::setAlphaf(0.5)` 四舍五入成 **128**（半透明填充 `ff800000` vs `ff7f0000`，
`0.5×0.5` 嵌套 `0x40` vs `0x3f`）。折叠 alpha 的胶水因此先量化为 `(int)(mul*255)/255` 再乘。

**当前实现与残余**：只有「子树恰好画 1 个图元」的对象折叠 alpha（其余仍走隔离层，这是阶段二百一十四
以来一直的行为，本阶段没有改动它）。所以**已知分歧只剩一条**：容器里 ≥2 个重叠图元 + `alpha<1`。
要整体对齐需要把全部绘制入口（`drawCircle`、九宫格、文本、Stage3D）都接进折叠通道，已登记在
`TODO.md` 的遗留表里；判据与取舍见 [`skia.md`](skia.md) §6.14。


## 4. 保真与增强原则

§2 的红线与 §3 的分歧点都在回答「**怎么和 AIR 对齐**」。本节补上另一半：**对齐之外，什么算「增强」**。

1. **保真是底线（不可让的）。** AIR 已定义的语义必须**逐字**对齐——错误号、错误文案、事件顺序与次数、
   边界值、API 形状，一律以 `adl` 实测为准。增强**不得**改写任何 AIR 已定义行为：同一份 `.as` 在 `adl` 下
   是什么样，我们的产物里就必须是什么样。
2. **增强是增益（白名单，须论证）。** 只有当 AIR **未定义 / 明确不支持 / 没有对应物**时才允许增强，
   且**必须 opt-in**；不声明任何开关的默认产物保持与 AIR 同构。

**判据（很有用，且很硬）**：同一份输入，`adl` 能跑出正确结果而我们跑不出 → 那是**遗留缺陷**（入
`TODO.md` 的 `### 遗留待开发`）；`adl` 对同一输入**本来就报错**、或该 API 在 AIR 里压根不存在 → 我们做出来
才叫**增强**（入 `### 增强待做`）。

例：`Loader.load("*.svg")` 在 `adl 51.4.1` 下实测就是 `Error #2124: Loaded file is an unknown type.`——
AIR 的 `Loader` 规范三处一致地只支持 SWF / JPG / PNG / GIF，**SVG 从不在范围内**。故「支持 SVG」是**增强**，
不是补平差距。

**增强的五条判定标准**（落在 AIR 语义之外、绝不静默、跨端差异显式列出、opt-in 不膨胀默认产物、过 DoD
——逐条含反例）见 [`enhancements.md`](enhancements.md) §1.2。**为什么这里值得增强**（链接成熟生态、
吃编译器红利、与宿主 C 互调、跨出浏览器/桌面）见同文 §1.3。

**一处容易误判的「像增强但其实不是」**：`--air-app` 的**编译面**（阶段一百二十四）。此前它编译
`src/` 下全部 `.as`，如今按**主类的传递闭包**收面（`src/reach.ts`）——这**不是**增强，而是**停止过度近似
AIR**：`mxmlc`/`adl` 本来就只链从文档类可达的传递闭包（`-link-report` 实测 away3d 六个 demo 各
158–246 个 def，而 485 个文件里 198 个不被任何 demo 触及）。判据仍是上面那条，只是方向相反：`adl`
从不打包那些资源、从不因不可达类里的坏 `[Embed]` 报错，而**我们此前会** ⇒ 收面是**修掉过度近似**。
要让产物范围**超出** AIR（例如强制把整棵树都编进去）才需要 `--all-sources` 这种具名开关。

**另一类容易误判的「像新语义其实不是」**：`&&`/`||` 的**操作数透传**与**空串为假**（阶段一百二十五）。
两者都是 AIR/ES3 **已定义**的行为，只是我们此前译错了（`bool && Array` 把透传值解箱抛 `#1034`；静态
`String` 条件用 `char*` 非空测试把 `""` 判真）—— 按本节判据，这是**遗留缺陷被修对**，既不是增强、
也不新增缺口。口诀：**凡 `adl` 能跑出结果而我们跑不出的，一律先当遗留处理**，只有在 `adl` 本身就报错、
或该 API 在 AIR 里压根不存在时，才进 §5 的增强清单。

## 5. 增强待做（超出 AIR 的增强清单）

以下各项均满足「AIR 未定义 / 不支持」这一前提，属**增益**而非欠账；清单本身不含任何 AIR 语义改写。
完整动机、依赖、成本、目标端与逐项说明见 [`enhancements.md`](enhancements.md) §3/§4。

| 增强项 | AIR 现状 | 目标端 | 成本 |
|--------|---------|--------|------|
| SVG 运行时解码（`Loader.load("*.svg")`） | ✗ 从不支持（实测 `#2124`） | native：库已构建+已链接，缺胶水；web：需重编 Skia 开 expat | 中 |
| Lottie 矢量动画（Skottie） | ✗ 无对应物 | native：库已构建+已链接，缺播放器 API；web：需重编 | 中 |
| WebP / BMP / ICO 等格式解码 | 部分（仅 JPG/PNG/GIF） | 两端（`SkCodec` 已编入，**待实测**） | 低 |
| 相机 RAW / DNG 解码 | ✗ | native：`libpiex`/`libdng_sdk` 已构建；web：需重编 | 低-中 |
| 原生着色器直通（MSL / GLSL ES） | ✗（只有 AGAL） | 两端 | 中 |
| FFI：直调宿主 C 函数 | ✗ | native（「直接转 C」的独有红利） | 中 |
| LTO / PGO 构建开关 | — | 两端 | 低 |

（上表是摘录；`enhancements.md` §3 的完整清单为 **15 项**，另含矢量图形上屏、GPU 通用计算、
无窗口/服务端出图、64 位整数、`Vector.<Number>` SIMD、真并发 `Worker`、帧录制/确定性重放、
可读 C 作为一等交付物等。）

---

## 6. 使用方式

1. 实现新特性前，查 §1 对应权威源，确认真实 AS3 语义；
2. 对照 §2 红线表，把「AS3 与 C 的差异」写进代码注释；
3. 遇到 §3 分歧点，先在本项目内确认决策；
4. 拟做 AIR 之外的增强前，先过 §4 的两条原则 + [`enhancements.md`](enhancements.md) §1.2 的五条标准
   （尤其「落在 AIR 语义之外」与「opt-in 不膨胀默认产物」）；
5. 若 `AIRSDK_HOME` 可用，用 `$AIRSDK_HOME/bin/mxmlc` 对同一 `.as` 输入做**对照验证**（AGENTS.md §2.4 已约定）。
