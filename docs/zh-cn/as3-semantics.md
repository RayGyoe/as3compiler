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
| 访问器属性可被**动态写入**（`o["alpha"] = v`，`o:Object`） | AS3 参考 | vtable 头部带 `setters` 反射表，`as_dyn_set` 查完 props 后走 setters 再回落动态槽 | ✅ 已实现（阶段八十九·十九） |
| `Object`/接口槽内的原始值（`var o:Object = 1`）需**自动装箱**，取出时再拆箱 | ES4 draft | `as_value_to_obj`/`as_obj_to_value` 成对；每个装箱类型有自己的 `GCT_*` 标记与 `gc_scan` 分支 | ✅ 已实现（阶段八十九·十九，含 boxed `Boolean`/`Function`） |
| 内建属性若 AS3 定义为**访问器**（如 `ByteArray.length`），赋值需触发副作用（重分配） | AS3 参考 | 同时在 `fields`（C 结构体需要）与 `getters`/`setters` 注册，手写 getter/setter | ✅ 已实现（阶段八十九·十九） |
| 构造函数实参（含副作用）**只求值一次**（`new XML(ba.readUTF())`） | ES4 draft | 单次求值 C 助手（`as_xml_parse_str_checked`），不用临时变量提升（会改变短路/三元/循环条件内的求值时机） | ✅ 已实现（阶段八十九·十九） |
| GC：写入**新生 GC 块**（尤其扩容 `memcpy`）的指针必须重新置灰 | 本项目 GC 不变式 | `gc_write_barrier`/`gc_write_barrier_value`；详见 [`gc.md`](gc.md) §6.5.1 | ✅ 已实现（阶段五十七 GC-4 增量标记的 Dijkstra 写屏障；`src/runtime.ts` 的 `gc_write_barrier`/`gc_write_barrier_value`，设计见 [`gc.md`](gc.md) §6） |
| `Context3DClearMask` 是 **uint 位掩码**（COLOR=1/DEPTH=2/STENCIL=4/ALL=7），不是字符串 | AS3 参考（adl 实测，`temp/refcheck/Mask.as`） | `intConstClass('Context3DClearMask', {...})`；`clear(..., mask)` 按位与 | ✅ 已实现（阶段八十九·二十；`src/symbols.ts` 的 `intConstClass('Context3DClearMask', {COLOR:1, DEPTH:2, STENCIL:4, ALL:7})`，`examples/stage81.as` 断言 adl 实测值） |
| `Context3D.clear(..., depth, stencil, mask)` 的 `stencil` 是**模板清屏值**（Starling 用 `DEFAULT_STENCIL_VALUE=127`，非 0） | AS3 参考 + Starling `Painter`/`RenderUtil` | 清屏值必须逐层转发到渲染后端（`as_s3d_clear` → `clearStencilValue`）；硬编码 0 会让整场遮罩失效 | ✅ 已实现（阶段八十九·二十；native `vendor/stage3d_glue.mm` 与 web `vendor/stage3d_webgl.cc` 都逐层转发清屏值——`v0.3.116` 前硬编码 0，曾致 Starling `Masks` 整场空白） |
| Stage3D 裁剪空间 **Y 向下**，与 Metal（Y 向上）相反 ⇒ 几何绕序整体相反，`cullMode=Back` 会剔掉该保留的面 | 后端适配（非 AS3 语义差异，但同属「不可静默透传」） | 每个绘制 `setFrontFacingWinding:MTLWindingClockwise`；`FRONT_AND_BACK` ≈ Metal `None`（不剔除） | ✅ 已实现（阶段八十九·二十；native 每个绘制 `setFrontFacingWinding:MTLWindingClockwise`，web 在 GLSL 顶点级反转裁剪空间 Y + `glFrontFace(GL_CCW)`） |
| 逐绘制状态设置器（`setDepthTest`/`setStencilActions`/`setSamplerStateAt`）被每批次调用 ⇒ **先比较再标脏** | 性能不变式（非语义） | 每次调用无脑重建 `MTLDepthStencilState`/采样器 = 每绘制一次驱动对象分配，渲染会掉到不可用 | ✅ 已实现（阶段八十九·十九，8 处扩容站点） |
| `DisplayObject.transform.matrix` 与 `x/y/rotation/scaleX/scaleY` 是**同一个 transform 的两种视图**：getter **返回拷贝**（改它不动对象）、setter 把矩阵**分解回字段** | AS3 参考 + `adl 51.4.1` 实测（`temp/xformcmp/Probe.as` 25 例，`adl` 写 `/tmp/xform_adl.txt`） | 读 = 由字段 + skew 残余**合成一份新 `Matrix`**（`Matrix_new`）；写 = `rotation=atan2(b,a)`、`scaleX=hypot(a,b)`、`scaleY=hypot(c,d)`（`det<0` 取负）分解回字段，分解不了的 skew 留在残余槽；`X.transform.matrix = m` 作**值**用时产出 `m`（含链式） | ✅ 已实现（阶段八十九·七十六）。实测要点：给 `(90,18)` 的对象赋 `get()->rotate(30deg)`，adl 落在 `(68.94228634059948, 60.58845726811989)`；`[2,0.5,0.4,3,11,13]` → `rot=14.036…`、`sx=2.061…`、`sy=3.026…`；零矩阵 → `rot=0/sx=0/sy=0` 且往返；零行列式与赋值当值均已对齐。**已知分歧**（只影响**字段分解选择**，矩阵往返与渲染均精确）：纯 flipX 与「零首列非零首行」——见 `TODO.md` 遗留表（含 adl 自相矛盾的证据） |

---

## 3. 决策分歧点（需项目内明确）

| 分歧 | AS3 语义 | 本项目现行 | 建议 |
|------|---------|-----------|------|
| `var x;`（无类型无初值）默认类型 | `*`（any）/ `undefined` | 无类型仍按 `int`（`symbols.ts` 约定）；显式 `*` 已建模为 `any`（`as_value` 装箱） | **维持现状**——无类型默认 `int` 是极简约定；但阶段十五起引用类型赋给推断 `int` 抛 `CodegenError`，不再静默截断 |
| `Number` 默认值 | `NaN` | ✅ 已修复（`defaultInit` 输出 `NAN`） | 无需处理 |
| `%` 零除数且结果落在**动态**类型使用点（`var x:* = a % 0`） | `NaN`（`Number`） | 守卫后的 int/uint `0`（未防护前是 UB：`-O2` 折成被除数 `5`，wasm 则 trap） | **维持现状**——要给出 NaN 就得把 `int % int` 整体变成 `double`，但那样 `7 % 3 is int` 会变 false（adl 实测为 **true**），静态类型反而更不忠实；零除数本身即 app 缺陷，而 AS3 在 int/uint 接收点（含 `var r:int = 5 % 0`）自己也给 0 |
| **帧率口径**（呈现节拍 vs 逻辑帧率） | `Stage.frameRate` 是**逻辑帧率**：`ENTER_FRAME` 按该频率派发计数，**不跟显示器刷新率**——阶段六十一/六十二 的 adl 对照实测：窗口移到 50 Hz 外接屏后 adl 的 FPS 读数仍约 **120**（靠 delta time 保持动画速度），而我们的实现读数降为 **50** | **跟随 vsync**：native 开 `SDL_RenderSetVSync(1)` 让 `SDL_RenderPresent` 阻塞到刷新周期；web 按**整 tick** 节拍（`skip = round(1000/frameRate / rAF周期)`，每 `skip` 个 vsync 呈现一帧，阶段八十九·二十九）。故帧间隔恒为刷新周期整数倍，`frameRate` 高于刷新率时封顶到刷新率（阶段四十七/六十一/六十二） | **维持现状**——这是 50 Hz 屏上唯一无拍频的物理正确做法（关 vsync 追 120 fps 会产生 120 vs 50 拍频、帧间隔在 8/20 ms 间剧烈抖动 → 卡顿）；native 与 web 两端已一致，且**这是呈现语义而非 AS3 语义**（`frameRate` 的读回值、`ENTER_FRAME` 回调行为、delta time 驱动的动画速度三者都仍正确）。**封顶现在受 `Stage.vsyncEnabled` 控制**（阶段一百二十九落地；AIR 本有此可写开关、实测默认 `true`）：`true` 时按上表封顶，`false` 时**去掉封顶**、按请求的 `frameRate` 节拍（AIR：「the player does not wait for the display's vertical refresh」）——即本行原先只能「维持现状」的拍频取舍，现在交回给 AIR 自带的退出阀。**可见口径差**只有两处：(a) 面板给不出的速率被量化到最近整数分之一（60 Hz 屏上 `frameRate=24` → 20 fps；另见 [`html5-web.md`](html5-web.md) §6.4）；(b) FPS 读数口径是「呈现帧数」而非 adl 的「`ENTER_FRAME` 派发数」。若要完全对齐 adl，需把**派发计数**与**呈现计数**解耦（按墙钟 deadline 派发 `ENTER_FRAME`/计时器，呈现仍每 vsync 一次），代价是引入「一帧内多次派发」或「派发与呈现不同步」的新语义面（`Stage_dispatchFrame` 开头的 `gc_step()` 安全点、`as_timer_tick`、脏矩形/增量重绘都要重新核对）——收益不值，故明确不做 |
| **多窗口下的帧派发**（`Stage.frameRate` 的作用域） | `Stage.frameRate` 是**整个应用一个值**（AS3 参考：任一 `Stage` 改动影响所有 `Stage`；`adl 51.4.1` 实测：主窗口设为 `4` 后**新开的 `NativeWindow.stage.frameRate` 也读 4**），`ENTER_FRAME`/计时器/`MovieClip` 每**应用帧**各推进一次——**不随窗口数叠加** | ✅ 已对齐（阶段八十九·七十三）：生成 C 里只有一个 `static double ASC_app_frame_rate`，每个 `Stage` 的 `frameRate` 访问器都代理它；`vendor/window_glue.cc` 的 `sk_run_loop` 每 tick 只跑**一个应用帧**（一个滚动 deadline + 一次 `on_frame` + 把每个可见窗口标脏），随后各窗口只做自己的光栅化与呈现 | **无需处理**——修复前是两处独立偏离：`NativeWindow_ctor` 硬写 `stage.frame_rate = 24`（把「应用当时的值」误当成每窗默认值），且 `Stage_dispatchFrame` 忽略传入的 Stage、向进程级 `as_ef_objs` 广播而 glue 又**每窗口调用一次** `on_frame`（N 窗 = N 次广播，实测主 120 + 2×24 = **168**，与用户截图一致）。现由 `[native-window]` 的 5 条钉子钉住（31 → 36 项） |
| **`flash.net` 网络加载面** | AIR 的 `URLLoader`/`URLRequest` 支持 `http`/`https`/`file`/`app-storage`/`app` scheme，GET/POST（应用沙箱内可用任意 method、任意请求头），7 个事件（`complete`/`open`/`progress`/`ioError`/`httpStatus`/`httpResponseStatus`/`securityError`）、`bytesLoaded`/`bytesTotal`、`close()` 真中止；`URLRequestMethod` 6 常量（GET/POST/PUT/DELETE/HEAD/OPTIONS） | 本项目是**本地文件读取器套了一个 HTTP API 外壳**：URL 一律当文件系统路径 `fopen`（`URLLoader.load`）；`URLRequest.method`/`.data`/`.contentType` 可写但**从不被读**（**死字段**）；`URLRequestMethod`/`URLRequestHeader`/`URLRequestDefaults`/`URLStream` **四个类不存在**；`open`/`httpStatus`/`httpResponseStatus`/`securityError` **永不派发**；`close()` 是**空函数**；`bytesLoaded`/`bytesTotal` 缺失；**GET/POST 完全没有**（实测：设 `method="POST"` + `data` 后 `load()` 照样把 URL 当地路径读出本地文件） | **明确记录的差距（待实现，非「维持现状」）**——**其主体已于阶段八十九·四十八~五十三 闭合**（A/B 语义面与契约 → 四十八；G + native 探针 → 四十九；构建层 `targets` → 五十；C 内核 + D/E/F/H → 五十一；AIR 保真校正 + 验收 I → 五十二；**`Socket`/`ServerSocket`/`XMLSocket` + 静态自包含 + 代理/cookie/HTTP-2 → 五十三**；仍余 preview2 `wasi:http`、AMF、`SecureSocket` TLS、`DatagramSocket`，见 `TODO.md` 遗留表）。完整官方 API 面、现状偏差表、8 阶段路线与验收方案见 [`flash-net.md`](flash-net.md)（其中 **§4.1.2** 给出 libcurl 的**引入方式**：首期零 vendor 直接用系统库，要静态自包含才走 `build-tools/`→`vendor/`）。**A（语义层补全：常量类/字段/`decode()`）+ B（契约补全：`bytesLoaded`/`open`/`close` 真中止）无网络依赖、低风险，建议先做**（消除「设了 `POST` 却无反应」「`close()` 是空函数」等**误导性**偏差）；**C（HTTP/1.1 + TLS 客户端）之后是独立重工程**，难点是 HTTPS/TLS 与三目标分叉（native socket / web `fetch` / WASI 无 socket → 诚实 `ioError`） |
| **异步 IO 的执行位置与排空时机** | AIR 单线程 + 帧驱动事件：IO 在后台**确实并发**进行，事件按到达尽快派发；`URLLoader`/`FileStream` 在终态事件前先派 `PROGRESS`（可多次、带水位）；`Loader.load()` 对不可读 URL 与非图 payload 都派 `IOErrorEvent`（#2124「Loaded file is an unknown type」），**不**派 `COMPLETE`，数据/内容只随终态事件可见（`LoaderInfo.complete` = 「dispatched when data has loaded successfully」）；同一目标重复 `load()` 重启加载，旧请求不再派事件 | **执行位置**：native（macOS/Linux pthread）用 4 worker 池真后台 read+decode（`ASC_ASYNC_THREADS`），worker 绝不碰 GC 堆，输入提交时拷到 malloc；web/WASI/Windows 目标**同步内联**（`as_async_submit` 就地跑完，只推迟事件）。**排空时机**：结果落 malloc 暂存，只在**下一个帧边界**由 finish thunk 搬进 AS3 可见状态（`Stage_dispatchFrame` 先 `as_async_tick()` 再 `as_timer_tick()`）；headless `tickTimers()` = 等 worker 排空 + 一次排空全部 DONE（保持例程确定性）。`PROGRESS` 目前**只派一次**（`loaded == total`，读不分块无中间水位）；`LoaderInfo.PROGRESS` 仍不派发（Starling 监听的是 `URLLoader`）；`LoaderInfo.bytesTotal` 在终态才非 0 | **维持现状**——(a) 帧边界派发是 AIR 帧驱动模型的最接近实现，且「入表→thunk 跑完前不移出 job 表」是 GC 根不变式（提前移出会被 sweep 清零，已实测 SIGSEGV）；(b) native 与 web 的差别只在「读/解码是否占主线程」，web 无 worker 是既定取舍（wasm 单线程模型下 pthread 需 COOP/COEP，见 [`html5-web.md`](html5-web.md)）；(c) PROGRESS 单次是「读不分块」的直接后果，要报水位就得改分段读（N 次 read + 逐块重试语义），收益不值；(d) 纯 C 构建无解码器（`as_skia_image_decode_bytes_argb` 为返回 NULL 的桩）→ 图像加载报 IO_ERROR，解码成功路径由 skia 后端覆盖（native demo 验收）。详见阶段八十九·四十五与 `examples/async-io.as` |
| `adl` 把 `DisplayObject.x/y` 量化到 **1/20 px（twips）** | AS3 规范**无此约定**（avmplus 内部存储口径）：`Matrix.rotate` 算出 `tx=68.94228634059948`，一经 `transform.matrix =` 回来就成 `68.9`；`ty` 同理（`60.58845726811989` → `60.55`） | 保留全精度（`x/y` 就是 `double`） | **维持现状**——twip 量化不是规范语义而是实现细节，复刻它等于**降低**精度且会让所有布局数值被无意义地截断；验证时改用容差（`x/y ±0.05`、`rotation/scale ±2e-4`）而非比对字面量。另：`adl` 的分解中间量走单精度（`scaleX 1.6` → `1.5999908447265625`），同属内部口径 |
| **命中测试的贴边松紧**（twip 量化的连带后果） | AS3 规范把命中定义为「点落在对象的**边界框**内」，但未定义边界框的浮点口径 | 本实现按**严格几何**（包围盒 `l <= x <= r && t <= y <= b`，全 `double`） | **维持现状，但记为已知差异**——`adl 51.4.1` 真鼠标实测（`temp/c1probe/click/`）：屏幕点 `(310,110)` 打在旋转方块上，`adl` 报 `localX/localY = (14.13, -0.021)` 且**判定命中**，而按严格几何该点在盒外 **5e-5**（`adl` 的 `x/y` 经 twips 量化 + 单精度中间量，见上一行）。可见口径差**只在贴边 ~0.05px 内**：`adl` 更松。复刻它需要给判定加一个 adl 量级的容差，而容差必须先用点击探针在两端标定（否则会把「贴边未中」变成「贴边中」的假阳性）；示例/回归一律用**内部点**断言（如 `(328,142)` → local `(49.49,9.88)`）。见 `TODO.md` 遗留表 |
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
