# as3compiler — 分步实现路线图

> 目标：参照 TypePHP（把 PHP 编译成原生二进制的 AOT 编译器）的思路，实现一个 AS3 编译器：
> `ActionScript 源码 → 词法/语法分析 → 生成可读 C → 交给 clang/cc 编译成原生可执行文件`。
> 编译器前端只负责"翻译"，优化与机器码生成交给成熟的 C 编译器，不重复造轮子。

---

## 当前状态（v0.4.25）

> 下面这段是**早期子集**（阶段一~十三）的能力摘要，现仍准确但已远非全集；完整能力面见
> [`README-CN.md`](README-CN.md) 的「支持子集」与路线图里 阶段三十三 之后的各阶段条目
> （事件/显示列表/文本/几何/GC/正则/Skia/Stage3D/Starling 端到端 等）。

已实现 AS3 可用子集（面向对象基础 + 数据与迭代 + 标准库 + 接口与类型系统 + 函数进阶 + 包/模块语法兼容 + 异常处理 + 完善与打磨已全部完成）：

- 类型：`int / uint / Number / Boolean / String / void / Array / Function / 类名 / 接口名`
- 字面量：整型、浮点、十六进制（`0xFF`）、字符串（单/双引号）、`true`/`false`、`null`、`Infinity`/`NaN`、数组字面量 `[...]`、对象字面量 `{ ... }`
- 表达式：算术、比较、逻辑、一元、位运算 `& | ^ ~ << >> >>>`、自增自减、三元 `?:`、`is` / `as`、数组索引 `a[i]`、属性访问 `o.x`、复合赋值 `+= -= *= /= %= <<= >>= >>>= &= |= ^=`
- 语句：变量声明、表达式语句、`if/else`、`while`、`do-while`、`for`、`for-in`、`for-each-in`、`switch`、`break`、`continue`、标签语句 `label: ...`、`return`、`throw`、`try/catch/finally`、块
- 函数：带类型参数与返回类型的自由函数；可选参数与默认参数、rest 参数（`...args:Array`）、`Function` 类型与函数值（匿名函数表达式、函数作参数/返回值）
- 类：字段 + 方法 + 有参构造函数 + `new` + `this` + 继承 `extends` + `override` 重写（虚表派发）+ `super` 调用 + 访问修饰符 `public/private/protected/internal` + `static` 字段/方法 + `const` 常量 + `get/set` 访问器 + `final` 类/方法
- 接口：`interface` 声明 + `implements` 实现（接口 vtable 派发）+ `is`/`as` 接口类型检查
- 包/模块：`package`/`import` 语法兼容层（`package` 扁平化、忽略命名空间；`import` 解析后忽略）
- 根类：`Object` 内置根类（所有类的隐式基类，`toString()` 返回运行时类名）；`Error` 内置错误类型（`new Error(message)`、`.message`）
- 数组：字面量、索引读写、`.length`、动态扩容、`push/pop/shift/unshift/splice/slice/indexOf/join/concat`、多维数组、异构元素（`as_value` 动态装箱）
- 对象：对象字面量 `{}`（字符串键关联数组简化版）、属性读写、嵌套对象
- 标准库：`String` 完整方法、`Math` 常量与方法、全局函数、类型转换函数、对象可读 `trace`
- 内建：`trace`、`String.length`
- 语义：`/` 恒为 Number、字符串 `+` 自动装箱拼接、`is`/`as` 运行时类型检查（基于 vtable super 链）、`Number` 未初始化默认 `NaN`、异常经 `setjmp`/`longjmp` 跳转到最近活跃 `catch`、位运算转换到 32 位整数（`>>>` 无符号右移）

核心源码：`as3compiler/src/`（`ast.ts` / `lexer.ts` / `parser.ts` / `symbols.ts` / `runtime.ts` / `codegen.ts` / `emit.ts` / `build.ts` / `index.ts`），零第三方依赖，Node ≥ 22.6 直接运行 `.ts`。

编译说明（命令行参数、构建清单 JSON、多目标后端、WASI 工具链）见 [`docs/zh-cn/compile.md`](docs/zh-cn/compile.md)。

---

## 路线图（按依赖顺序推进，patch 版本递增）

### 阶段一：面向对象基础（目标 v0.3.0）✅ 已完成

让类成为真正可用的 OOP 载体，是后续所有特性的地基。

- [x] **有参构造函数**：与类同名的 `function` 作构造器；`new Foo(a, b)` 传参；字段初始化
- [x] **继承 `extends`**：单继承，子类继承父类字段与方法；C 侧用"父类字段平铺在前 + 首成员 vtable 指针"模拟布局兼容
- [x] **`override` 方法重写**：虚表（vtable）动态派发
- [x] **`super` 调用**：构造器 `super(...)` 与 `super.method(...)`
- [x] **访问修饰符**：`public / private / protected / internal` + 编译期可见性检查
- [x] **`is` / `as` 类型判断与转换**：vtable `super` 链做运行时类型标签（RTTI）

**验收**：能编译运行含父类/子类、构造传参、方法重写、`super` 调用、`is` 判断的示例。✅

---

### 阶段二：数据与迭代（目标 v0.3.1）✅ 已完成

AS3 最核心的数据结构是数组，补齐数组即解锁大量真实程序。

- [x] **`Array` 类型**：字面量 `[]`、索引读写 `a[i]`、`.length`、动态扩容
- [x] **数组常用方法**：`push / pop / shift / unshift / splice / slice / indexOf / join / concat`
- [x] **`for-in` / `for-each-in` 循环**：遍历数组
- [x] **多维数组**：`[[1,2],[3,4]]` 嵌套（通过 `as_value` 嵌套对象指针自然支持）
- [x] **对象字面量 `{}`**：`var o = { x: 1, y: "a" };`（关联数组简化版，字符串键 + `as_value` 值）
- [x] **`Vector.<T>` 类型**（已在阶段十实现）：`Array` 已满足阶段需求，`Vector` 在阶段十落地

**验收**：能编译运行一个用数组存数据、`for-in` 遍历、`push/pop/splice` 操作的示例。✅（`examples/array.as` + `examples/object.as`）

---

### 阶段三：标准库（目标 v0.3.2）✅ 已完成

补齐常用 API，让编译器能跑真实业务逻辑。

- [x] **`String` 完整方法**：`charAt / charCodeAt / indexOf / lastIndexOf / substring / substr / slice / split / toUpperCase / toLowerCase`
- [x] **`Math` 库**：常量 `PI / E`；方法 `abs / floor / ceil / round / sqrt / pow / min / max / random`
- [x] **全局函数**：`parseInt / parseFloat / isNaN / isFinite`
- [x] **类型转换函数**：`String(x) / Number(x) / Boolean(x) / int(x) / uint(x)`
- [x] **`trace` 增强**：对象打印可读类名（vtable 加 `name` 字段，`as_obj_to_str` 读类名）

**验收**：能编译运行一个用 `Math` 计算、`String.split/join`、`parseInt` 的示例。✅（`examples/stdlib.as`）

---

### 阶段四：接口与类型系统完善（目标 v0.3.3）✅ 已完成

补齐 AS3 面向对象体系的核心缺口，并修复语义 bug。

- [x] **`interface` / `implements`**：接口声明与实现；C 侧用接口 vtable 模拟；`is`/`as` 支持接口类型
- [x] **`Object` 根类**：所有类的隐式基类；`toString()` 默认实现（对象字面量 `{}` 保持 record 简化版，暂不落到 `Object`，README 注明）
- [x] **`static` 成员**：`static` 字段与方法（类级别，不依赖实例）
- [x] **`getter / setter` 访问器**：`get x():T` / `set x(v:T)`
- [x] **`const` 常量声明**：编译期常量，支持顶层与类级
- [x] **`final` 关键字**：`final` 方法（禁止 override）、`final` 类（禁止继承）
- [x] **修复 `Number` 默认值 NaN**：`defaultInit` 中 `number` 由 `0.0` 改为 `NAN`（见上"待修复"表）

**验收**：能编译运行一个含接口实现、`static` 成员、`get/set`、`const` 的示例；`var n:Number; trace(n)` 输出 `nan`。✅（`examples/stage4.as`）

---

### 阶段五：函数进阶（目标 v0.3.4）✅ 已完成

- [x] **可选参数与默认参数**：`function f(a:int, b:int = 1)`
- [x] **rest 参数**：`function f(...args:Array)`
- [x] **`Function` 类型与函数值**：`var f:Function = function() {...}`；函数作为参数/返回值
- [x] **闭包**（已在阶段十一实现）：捕获外部词法变量（环境堆分配逃逸）

**验收**：能编译运行一个含默认参数、rest 参数、函数变量的示例。✅（`examples/stage5.as`）

---

### 阶段六：包与模块（目标 v0.3.5）✅ 已完成

- [x] **`package` 语法兼容层**：解析 `package a.b.c { ... }`，先忽略命名空间（纯语法兼容），不破坏单文件模型
- [x] **`import` 语法识别**：解析 `import` 语句（先做识别 + 忽略，为多文件预留）
- [x] **多文件编译**（已在阶段十二实现）：多 `.as` 合并、命名空间隔离、包内可见性

**验收**：带 `package` 声明的单文件能被编译（命名空间暂不隔离）。✅（`examples/stage6.as`）

---

### 阶段七：异常处理（目标 v0.3.6）✅ 已完成

- [x] **`throw / try / catch / finally`**：异常抛出与捕获（基于 `setjmp`/`longjmp`）
- [x] **内建 `Error` 类型**：`Error(message)`、`.message` 属性（`TypeError` 等子类延后）

**验收**：能编译运行一个 `try/catch` 捕获并处理异常的示例。✅（`examples/stage7.as`）

---

### 阶段八：完善与打磨（目标 v0.3.7）✅ 已完成

- [x] **位运算**：`<< >> >>> & | ^ ~` 及复合赋值 `<<= >>= >>>= &= |= ^=`
- [x] **标签语句**：`label: while (...) { break label; }`（含 `continue label`）
- [x] **`Date` 类**（已在阶段九实现）：`new Date()` 与日历访问器
- [x] **错误信息完善**：词法/语法错误带行列号、友好提示、未定义符号提示（`undefined variable/function/field/method/label`）
- [x] **测试套件**：`test.ts` 编译并运行全部示例，逐项 pass/fail 报告（`npm test`）
- [x] **内存管理**：README 已注明 `malloc`/`realloc` 运行期不回收（教学编译器可接受）
- [x] **生成 C 代码可读性优化**（已在阶段十三实现）：类/方法定义前加源注释，保持结构化布局、源标识符命名、缩进对齐

**验收**：能编译运行一个含位运算、标签语句的示例。✅（`examples/stage8.as`）

---

### 阶段九：标准库与错误类型扩展（目标 v0.3.8）✅ 已完成

补齐延后项：`Error` 子类与 `Date` 类。

- [x] **`Error` 子类**：`TypeError`、`RangeError`、`ArgumentError`（复用 `Error` 的消息机制，作为 `Error` 子类；`catch (e:TypeError)` 可精确匹配，普通 `catch (e:Error)` 兜底）
- [x] **`Date` 类**：`new Date()` 取当前时间；`getTime / getFullYear / getMonth / getDate / getDay / getHours / getMinutes / getSeconds`（基于 C `time()` / `localtime()`）

**验收**：能编译运行一个含 `throw new TypeError(...)` + `catch (e:TypeError)` 精确捕获、以及 `new Date().getFullYear()` 的示例。✅（`examples/stage9.as`）

---

### 阶段十：泛型 `Vector.<T>`（目标 v0.3.9）✅ 已完成

AS3 的类型安全数组 `Vector`，比 `Array` 更强（元素类型固定、越界检查）。

- [x] **`Vector.<T>` 语法**：词法/语法支持 `Vector.<int>`、`Vector.<String>` 等泛型类型标注（含 `new Vector.<T>()` 构造；另支持省略括号的 `new Vector.<T>` 无参构造，AS3 允许省去空 `()`）
- [x] **类型安全数组**：`v.push / v.pop / v.length / v[i]` 读写；C 侧按元素类型 `T` 平铺存储（非装箱），比 `Array` 更高效
- [x] **越界检查**：索引越界 `throw new RangeError(...)`

**验收**：能编译运行一个含 `Vector.<int>` 的 `push/pop`/索引读写、并触发越界异常的示例。✅（`examples/stage10.as`）

---

### 阶段十一：闭包（目标 v0.3.10）✅ 已完成

匿名函数捕获外部词法变量，让函数值真正可用。

- [x] **捕获外部变量**：匿名函数引用外层局部变量（当前只支持自身参数与全局/类成员）
- [x] **捕获变量逃逸**：闭包作为返回值/存进数组后，捕获变量生命周期延长（需堆分配捕获环境，而非栈上消亡）
- [x] **可变捕获**：闭包内修改捕获变量（当前为快照语义：闭包内修改环境副本，不影响外层局部变量；完整引用语义/变量提升延后，README 已注明）

**验收**：能编译运行一个返回闭包的计数器示例：`function makeCounter():Function { var n = 0; return function() { return ++n; }; }`，两次调用各自独立计数。✅（`examples/stage11.as`）

---

### 阶段十二：多文件编译（目标 v0.3.11）✅ 已完成

较大架构改动，把单文件模型扩展为多文件。

- [x] **多 `.as` 合并**：CLI 接受多个源文件，合并成一个编译单元
- [x] **命名空间隔离**：`package a.b.c` 真正生效，类名映射到命名空间（C 标识符前缀 `foo_bar_Baz`）
- [x] **包内可见性**：`internal` 跨文件（同包内）可见，跨包不可见（需跨文件符号表）

**验收**：能编译运行两个 `.as` 文件（一个定义 `package foo` 下的类，另一个 `import` 后实例化调用）。✅（`examples/stage12/`）

---

### 阶段十三：代码质量与语义收尾（目标 v0.3.12）✅ 已完成

收尾延后项与边缘 case。

- [x] **生成 C 代码可读性优化**：类/方法 C 定义前加 `// class X` / `// X.m` 源注释，保持结构化布局与源标识符命名
- [x] **内存管理**：字符串分配（拼接/转换/split/substring 等）改走 4 MiB arena 分配器，消除字符串拼接泄漏
- [x] **`null` 装箱语义完善**：对象 `toString` 走 `as_obj_to_str`（null → `"null"`）；字符串 `==`/`!=` 非字符串侧先转字符串，避免 `strcmp(NULL, ...)` 崩溃
- [x] **全量回归 + 文档收尾**：所有示例回归（26/26）、README 限制项同步、版本号递增

**验收**：以上三项修复/完善后，全量回归无破坏，README 限制项同步更新。✅（`examples/stage13.as`）

---

### 阶段十四：数值输出与时间精度修复（目标 v0.3.13）

修复 as3-gaps.md §2 的 P0 语义错误（编译通过但结果错）。

- [x] **`trace`/`String(Number)` 精度修复**：`%.*g` 最短往返表示（1~17 位有效数字，保证 round-trip）+ 实现 AS3 `Number.toString()` 格式化规则（`emit.ts:1690`、`runtime.ts` `as_str_from_double`）；实测 `trace(1/3)` 由 `0.333333` 变为 `0.3333333333333333`
- [x] **`Date.getTime()` 毫秒精度**：改用 `gettimeofday`（`sys/time.h`），`o->time` 为真实毫秒时间戳（`emit.ts:669`）；顺带修复 `formatDouble` 对科学计数法整数（如 `1e21`）误加 `.0` 导致 C 报错的问题

**验收**：`trace(1/3)` 输出 17 位；`new Date().getTime()` 在 1 秒内连续调用两次得到不同毫秒值。✅（`examples/stage14.as`）

---

### 阶段十五：模块级作用域与无类型变量（目标 v0.3.14）

修复 as3-gaps.md §2.3 / §2.4 的 P0 语义错误。

- [x] **模块级 `const`/`var` 对自由函数可见**：模块级变量提升为 `g_` 前缀文件级全局变量（`emitModuleVars`），自由函数与 `main` 共享该层；`const` 发射为文件级常量、`var` 发射为全局变量并在 `main` 按源码顺序执行初始化（`emit.ts`）
- [x] **`var x;`（无类型）赋值不再静默截断**：`convert` 中引用类型（`String`/对象/数组等）隐式赋给 `int`/`uint`/`Number`/`Boolean` 标量时抛 `CodegenError`（不再把 `char*` 静默截断为 `int`）

**验收**：`const N:int = 1000; function f():int { return N; }` 可编译运行；`var x; x = "hello";` 不产出垃圾值（抛错或按 `*` 正确装箱）。✅（`examples/stage15.as`）

---

### 阶段十六：字符串与数值格式化方法补齐（目标 v0.3.15）

补齐 as3-gaps.md §3.1 / §3.2 的 P1 功能缺失。

- [x] **`String.replace(searchValue, replaceValue)`**（字符串版，替换首个匹配）：新增 `as_str_replace` 运行时助手；`match` / `search` → `RegExp` 正则仍延后（README 已注明）
- [x] **`Number.toFixed` / `toPrecision` / `toExponential`**：新增 `as_num_toFixed`/`as_num_toPrecision`/`as_num_toExponential` 运行时助手，指数去前导零对齐 AS3（`1.23e+3` 而非 C 的 `1.23e+03`）

**验收**：`"a-b-c".replace("-", "_")` 输出正确；`(1/3).toFixed(2)` → `"0.33"`、`(1234.5678).toExponential(2)` → `"1.23e+3"`。✅（`examples/stage16.as`）

---

### 阶段十七：`Vector.<T>` 功能面扩展（目标 v0.3.16）

补齐 as3-gaps.md §3.3 的 P1 功能缺失。

- [x] **`join` / `indexOf`**、`.length` 赋值（收缩/增长填充默认值）：新增 `as_vector_<T>_join`/`_indexOf`/`_setLength` 单态化助手
- [x] **`new Vector.<T>(length, fixed)`** 带参构造：新增 `_new_sized`
- [x] **字面量 `new <T>[...]`** 与 **`splice` / `slice` / `concat` / `forEach` / `sort` / `filter` / `map` / `reverse`**：阶段六十六（v0.3.69）补齐（`examples/stage66.as`）

**验收**：`v.join(",")`、`v.indexOf(x)`、`v.length = n` 收缩正确，`new Vector.<int>(3, true)` 构造可用。✅（`examples/stage17.as`）

---

### 阶段十八：基本类型 `is` / `as`（目标 v0.3.17）

补齐 as3-gaps.md §3.4 的 P1 功能缺失。

- [x] **`is` / `as` 基本类型**：`int` / `uint` / `Number` / `Boolean` / `String` 与 `*` / `Object` 的运行时装箱判定——静态标量编译期求值（`scalarIsCompatible`）、`any` 按 `as_value` tag 运行时判定（新增 `as_v_is_*`/`as_v_as_*` 助手）

**验收**：`x is int` / `x is Number` / `x is String` 等运行时类型测试正确。✅（`examples/stage18.as`）

---

### 阶段十九：性能优化与有意简化收尾（目标 v0.3.18）

收尾 as3-gaps.md §4（P2 性能）与 §5（有意简化）。

- [x] **字符串操作优化**：`as_array_join` 与 `Vector.join` 用 `memcpy` 指针推进替代 `strcat`（O(n²)→O(n)）；`split→join` 链的中间装箱仍保留（属 P2 长期优化）
- [x] **有意简化点归拢与文档化**：闭包快照、数组越界 `null`、`finally` 控制流、对象字面量落到 `Object`、`is`/`as` 接口静态分派、`parseInt`/`parseFloat` 近似——均已在 README「当前限制」与 as3-gaps.md §5 归拢文档化

**验收**：`strings` 基准相对 C 的开销下降；有意简化项在 README / as3-gaps.md 状态清晰可追溯。✅（`examples/stage19.as`）

---

### 阶段二十：`Math` 三角/对数函数与常量补齐（目标 v0.3.19）

补齐 builtin-types.md 中 `Math` 缺失的 9 个方法 + 6 个常量（P1）。

- [x] **三角函数**：`sin / cos / tan`（参数为弧度）
- [x] **反三角函数**：`asin / acos / atan / atan2`
- [x] **指数/对数**：`exp / log`
- [x] **Math 常量**：`LN10 / LN2 / LOG10E / LOG2E / SQRT1_2 / SQRT2`

> C 侧 `math.h` 已提供 `sin/cos/tan/asin/acos/atan/atan2/exp/log`，直接映射；常量用 `M_LN10/M_LN2/M_LOG10E/M_LOG2E/M_SQRT1_2/M_SQRT2`（POSIX）或字面量。
> 注意 `-lm` 链接：三角/对数函数在部分平台需显式 `-lm`，`index.ts` 编译命令需补充链接参数。

**验收**：`Math.sin(Math.PI/2)` ≈ 1、`Math.log(Math.E)` ≈ 1、`Math.sqrt`/`Math.pow` 与现有方法共存；`Math.LN2` 等常量可读。✅（`examples/stage20.as`）

---

### 阶段二十一：数值 `toString(radix)` / `valueOf` / 静态常量（目标 v0.3.20）

补齐 builtin-types.md 中 `Number`/`int`/`uint` 的进制转换、`valueOf` 与静态常量（P1）。

- [x] **`toString(radix)`**：`Number`/`int`/`uint` 支持 2~36 进制（新增 `as_int_radix`/`as_uint_radix` 运行时助手，十进制复用 `as_str_from_int`/`as_str_from_uint`/`as_str_from_double`）
- [x] **`valueOf()`**：返回原值（`Number`→double、`int`→int、`uint`→unsigned，恒等返回）
- [x] **静态常量**：`int.MAX_VALUE`/`int.MIN_VALUE`、`uint.MAX_VALUE`/`uint.MIN_VALUE`、`Number.MAX_VALUE`/`Number.MIN_VALUE`/`Number.NaN`/`Number.POSITIVE_INFINITY`/`Number.NEGATIVE_INFINITY`

> `int`/`uint` 的 `MAX_VALUE`/`MIN_VALUE` 直接映射 C 的 `INT_MAX/INT_MIN/UINT_MAX/0`；`Number` 极值用 `DBL_MAX/DBL_MIN/NAN/INFINITY/-INFINITY`（`float.h`/`math.h`）。
> `toString(radix)` 需注意负数的补码表示与 AS3 语义（`int` 按 32 位补码，`uint` 按无符号）。

**验收**：`(255).toString(16)` → `"ff"`、`(10).toString(2)` → `"1010"`、`int.MAX_VALUE` 可读。✅（`examples/stage21.as`）

---

### 阶段二十二：`String` 方法补齐（目标 v0.3.21）

补齐 builtin-types.md 中 `String` 缺失的 8 个方法（P1）。

- [x] **`concat(...args)`**：拼接多个字符串（新增 `as_str_concat_n`，自动字符串化非字符串参数）
- [x] **`fromCharCode(...codes)`（静态）**：码点转字符串（新增 `as_str_fromCharCodes`，UTF-8 编码）
- [x] **`localeCompare(other)`**：AS3 实现等价于 `strcmp`（返回 0/正/负，新增 `as_str_localeCompare`）
- [x] **`valueOf()`**：恒等返回
- [x] **`toLocaleLowerCase` / `toLocaleUpperCase`**：AS3 实现等价于 `toLowerCase`/`toUpperCase`
- [x] **`startsWith(other)` / `endsWith(other)`**：前缀/后缀判断（新增 `as_str_startsWith`/`as_str_endsWith`）

**验收**：`"a".concat("b","c")` → `"abc"`、`String.fromCharCode(65,66)` → `"AB"`、`"hello".startsWith("he")` → `true`。✅（`examples/stage22.as`）

---

### 阶段二十三：`Boolean.valueOf` / `undefined` / URI 编解码（目标 v0.3.22）

补齐 builtin-types.md 中 `Boolean.valueOf`、`undefined` 常量与 URI 全局函数（P2）。

- [x] **`Boolean.valueOf()`**：恒等返回 `bool`（同时补齐 `Boolean.toString()`）
- [x] **`undefined` 全局常量**：`as_value` 新增 `tag == 5` 表示，`as_v_str_val` 输出 `"undefined"`，`undefined == null` 为 true（宽松相等）
- [x] **URI 编解码**：`encodeURI / decodeURI / encodeURIComponent / decodeURIComponent`（`%XX` 十六进制转义，新增 `as_uri_encode`/`as_uri_decode`；`encodeURI` 保留保留字符集，`encodeURIComponent` 不保留）
- [x] **`escape` / `unescape`**：URL 编码（`%XX` 字节转义，非 ASCII `%uXXXX` 简化未实现）

> `isXMLName` 依赖 XML/E4X 支持，与 `XML`/`XMLList` 一起延后（README 注明）。

**验收**：`encodeURIComponent("a b&c")` → `"a%20b%26c"`、`decodeURIComponent("a%20b")` → `"a b"`、`escape("ä")` → `"%E4"`。✅（`examples/stage23.as`）

---

### 阶段二十四：正则字面量词法/语法与 `RegExp` 类型建模（目标 v0.3.23）

攻关 `RegExp`（正则引擎）的第一阶段：让正则字面量与 `new RegExp()` 能被解析、类型系统识别 `RegExp`。

- [x] **正则字面量识别**：lexer 识别 `/pattern/flags` 字面量。与除法 `/`、块注释 `/*`、行注释 `//`、复合赋值 `/=` 消歧——当 lexer 处于「表达式开始」位置（前一 token 为运算符/`(`/`[`/`{`/`,`/`;`/`return`/`=` 等，`canStartRegex(prevToken)` 启发式）且 `/` 后非 `/`、`*`、`=` 时判定为正则字面量（`lexer.ts`）
- [x] **`RegExp` 类型建模**：`CType` 新增 `regexp` kind；`resolveType` 识别 `RegExp`（`symbols.ts`）
- [x] **`new RegExp(pattern, flags)` 构造**：复用 `new` 分发，codegen 生成 `RegExp_new(pattern, flags)`（`symbols.ts` / `emit.ts`）
- [x] **属性建模**：`source/global/ignoreCase/multiline/dotall/extended/lastIndex` 及 `compiled` 内部字段；`exec`/`test` 方法签名注入符号表（`symbols.ts`）；`SyntaxError : Error` 子类（`symbols.ts` / `emit.ts`）

**验收**：`var re:RegExp = /ab+c/i;` 与 `new RegExp("ab+c", "i")` 均能通过编译。✅（`examples/regexp.as`）

---

### 阶段二十五：内嵌自研 ES3 回溯正则引擎 + `exec`/`test`（目标 v0.3.24）

引入**自研回溯正则 VM**（纯 C、零外部依赖），直接内嵌于 `RUNTIME_PREAMBLE`（不引入 QuickJS libregexp——其 ES2020+ 正则语义与 AS3 的 ES3 语义存在漂移，自研回溯 VM 才能精确匹配 ES3 的 `\d\w\s` ASCII 语义与回溯行为）。

- [x] **字节码引擎**：pattern 编译为扁平指令数组（`CHAR/ANY/CLASS/BOL/EOL/BOUND/NBOUND/SPLIT/JMP/SAVE/BACKREF/LOOKAHEAD_POS/NEG/FAIL/MATCH/ENDSUB`），递归回溯执行；量化通过 `as_re_emit_atom` + 反填 `SPLIT/JMP` 展开（`runtime.ts`）
- [x] **`as_regex` 结构**：`{ ins*; nins; cap_ins; classes*; nclasses; cap_classes; ngroups; flags; err; errmsg }`；`as_regex_compile(pattern, flags)` 编译，编译错误抛 `SyntaxError`
- [x] **`exec(str):Array` / `test(str):Boolean`**：`RegExp_exec` 返回捕获组数组（元素 0 = 完整匹配，1..n = 捕获组，未参与者 undefined）+ `index`/`input`；`RegExp_test` 返回布尔；`g` 标志时按 `lastIndex` 起始并推进 `lastIndex`，无匹配复位为 0 并返回 `null`/`false`
- [x] **flag 映射**：`i/m/s` 直接驱动 VM；`g` 由 `exec`/`test` 适配层状态机处理；`x` 延后（阶段二十七）

**验收**：`/(\d+)-(\d+)/.exec("abc-123-45")` 返回 `["123-45","123","45"]`；`/bob/i.test("Bob bob")` → `true`；全局 `/\d/g` 连续 `test` 推进 `lastIndex`。✅（`examples/regexp.as`）

---

### 阶段二十六：`String.match` / `search` / `replace` 正则版（目标 v0.3.25）

打通 `String` 三个方法对 `RegExp` 的完整支持（builtin-types.md 中最后的 P1 缺口）。

- [x] **`String.search(re):int`**：返回首次匹配位置（`lastIndex` 忽略，恒从 0 起），无匹配 `-1`（`as_str_search_regex`）
- [x] **`String.match(re):Array`**：非全局返回单次 exec 结果数组（含捕获组）；全局 `g` 收集所有完整匹配（不含捕获组）成数组，无匹配 `null`（`as_str_match_regex`）
- [x] **`String.replace(re, repl):String`**：支持字符串替换（`$1`~`$9` 捕获组、`$&` 完整匹配、`$$` 字面量 `$`）；全局 `g` 替换全部，非全局替换首个；函数替换 `repl:Function` 已落地（`as_str_replace_regex_fn` 回调，参数 `match`/捕获组/`offset`/`input`）
- [x] **`String.replace` 字符串版共存**：字符串 searchValue 仍走现有 `as_str_replace`，`RegExp` searchValue 走新正则路径（`emitStringMethod` 按参数类型分发）

**验收**：`"John Smith".replace(/(\w+) (\w+)/, "$2, $1")` → `"Smith, John"`；`"a1b2c3".match(/\d/g)` → `["1","2","3"]`；`"abc".search(/b/)` → `1`。✅（`examples/regexp.as`）

---

### 阶段二十七：`x`（extended）flag 预处理与文档收尾（目标 v0.3.26）

补齐 AS3 独有的 `x` flag 并完成正则引擎攻关的收尾。

- [x] **`x` flag 预处理**：`as_regex_compile` 若带 `x`，先用 `as_re_x_strip` 剥离 pattern 中未转义、且不在字符类 `[...]` 内的空白字符与 `#` 行注释；`extended` 属性据此返回
- [x] **正则语法错误诊断**：编译失败时 `as_throw(SyntaxError_new(errmsg))`，`catch (e:SyntaxError)` 可捕获（不静默产出错误 bytecode）
- [x] **全量回归 + 文档收尾**：全部示例回归（37 例全过）；README 同步 `RegExp` 支持子集/限制；版本号递增

**验收**：`/a b c/x.test("abc")` 等价于 `/abc/.test("abc")`；`new RegExp("(")` 抛 `SyntaxError` 且可 `catch`。✅（`examples/regexp.as`）

---

### 阶段二十八：`Array()` / `Object()` / `Vector()` 构造器形式（目标 v0.3.28）

补齐 builtin-types.md §七 中缺失的内建类型构造器形式：既支持 `new Array()` / `new Object()` 构造，也支持
无 `new` 的函数式调用 `Array()` / `Object()` / `Vector.<T>()`。

> ⚠️ **`Object()` 与 `Array()`/`Vector()` 语义不同，不能一律「去糖为 `new`」**（依据 AIR SDK [`Object`](https://airsdk.dev/reference/actionscript/3.0/Object.html) 参考：
> *Every value in ActionScript 3.0 is an object, which means that calling Object() on a value returns that value*）。
> - `Object()`（**无参**）→ 新空对象，等价 `new Object()`。
> - `Object(x)`（**有参**）→ **恒等返回 `x` 本身**，不是 new：object/array/vector/record/interface 原样返回；primitive（int/uint/Number/Boolean/String）装箱为 `as_value`（`as_v_num`/`as_v_str`/`as_v_bool`）并返回 `any`。
> - 本项目 primitive 与 object 在 `CType` 层分离、未建模 `Number`/`String`/`Boolean` wrapper 类，故 primitive 装箱后返回 `any`（`as_value`），不能伪装成 `Object` 指针——这是须在文档如实暴露的子集边界。

- [x] **`new Array(...)` 构造**：`new Array()`（空数组）、`new Array(n)`（n 个 `undefined` 元素）、`new Array(e1, e2, ...)`（元素列表）——复用现有 `as_array_new` / `as_array_make`，`emitNew` 对 `resolveType('Array')`（`array` kind）分发，而非落入普通类分支
- [x] **`new Object()` 构造**：空对象（`as_object_new`），`emitNew` 对根类 `Object` 特判，避免落入普通类分支生成不存在的 `Object_new()`
- [x] **无 `new` 的 `Array(...)` / `Vector.<T>(...)` 函数式调用**：语义等价于 `new`——在全局函数分发处识别 `Array`/`Vector` 内建名，去糖为对应构造（`Array` → `as_array_*`、`Vector.<T>` → `as_vector_<key>_new`/`_new_sized`）
- [x] **无 `new` 的 `Object(...)` 函数式调用（恒等语义）**：在全局函数分发处识别 `Object`；无参 → `as_object_new()`（返回 `record`）；有参 → 对象类型原样返回 `x`，primitive 装箱为 `as_value` 返回 `any`（复用 `boxExpr`）

> `Vector.<T>(...)` 的无 `new` 形式应与已实现的 `new Vector.<T>()` 共用同一单态化构造路径（`as_vector_<key>_new` / `_new_sized`，见阶段十/十七）。
> `Object()` 无参的 `as_object_new` 与对象字面量 `{}`（`record` kind）语义上同为关联数组，注意统一后续 `o.x` 读写路径。

**验收**：`new Array(3).length` → `3`、`new Array(1, 2, 3).join(",")` → `"1,2,3"`、`Array("a", "b").length` → `2`、`Object()` 可构造空对象并可赋值读写、`Vector.<int>(2)` 等价 `new Vector.<int>(2)`。✅（`examples/stage28.as`）

---

### 阶段二十九：构建清单 + 多目标后端（目标 v0.3.29）

架构演进：把「单文件 `.c`」从**架构铁律**降级为**默认形态**，新增构建编排层，使编译器能链接
第三方库（skia/cairo/SDL 等）并产出多目标（native 可执行 + WASI `.wasm`）。对标 TypePHP 的
`project.yml` / `--wasm` 能力。

- [x] **构建清单（JSON）**：`src/build.ts` 定义 `BuildConfig` 与 `loadManifest`/`applyManifest`，
  对标 TypePHP `project.yml` 的 `sources`/`include-paths`/`link-libs`/`link-paths`/`defines`/`objects`；
  路径相对清单目录解析，CLI 覆盖清单（TypePHP「CLI beats YAML」）
- [x] **多目标后端**：`--target native`（默认，`cc/clang -O2 -lm` 产出 Mach-O/ELF/PE）与
  `--target wasm`（`clang --target=wasm32-wasip1` 产出 `.wasm`）；`--dry` 只打印编译命令不执行
- [x] **链接能力**：`-I/-L/-l/-D` 与 `--manifest`，允许把 skia/cairo 等库链接进产物（不是内嵌）
- [x] **平台耦合隔离**：`as_now_ms()` 抽象 `gettimeofday`（native 毫秒精度，WASI 退化 `time(NULL)` 秒级），
  `#ifdef __wasi__` 条件编译收进 `RUNTIME_PREAMBLE`；`Date_init` 改走 `as_now_ms()`
- [x] **GUI 方向（规划）**：`flash.display` 的 Bitmap/Shape/Graphics 后续阶段通过链接 skia（或 cairo）实现，
  不自研光栅化——这正是「前端不重复造轮子」铁律的体现（见 AGENTS.md §2.9）

**验收**：`as-aot examples/hello.as --run`（native）与
`as-aot examples/hello.as --target wasm --dry` 均产出正确的编译命令；
manifest 路径相对解析、`-I/-L/-l/-D` 拼接正确；全量回归 38 例不破坏。✅

> WASI SDK（wasi-sdk-34.0）+ wasmtime 48.0.2 已装于本机（`~/.wasi-sdk/`），跑 wasm 前需
> `export WASI_SDK_HOME=...` 并把 wasmtime 目录加进 PATH；`--target wasm` 即可直接产出并运行 `.wasm`。

---

### 阶段三十：`Array` 高阶方法 + `Array.NUMERIC` 常量（目标 v0.3.30）

补齐 `Array` 缺失的高阶遍历/排序方法（对照 `examples/air-native/src/demo/ArrayDemos.as`），解锁函数式数组操作。

- [x] **`map(callback)`**：对每个元素调用 `callback(element, index, array)`，返回新数组（回调经 `as_value` 封装的函数值调用，复用阶段五/十一的 `Function` 类型与闭包运行时表示）
- [x] **`filter(callback)`**：对每个元素调用 `callback(element, index, array)`，返回 `Boolean` 为真值的元素组成新数组
- [x] **`sort(compare)`**：就地排序；`compare(a, b)` 返回 `Number`（负=升序、正=降序、0=相等）；`Array.NUMERIC` 常量（值 16）指示数值升序排序
- [x] **`reverse()`**：就地反转元素顺序（无参）
- [x] **`Array.NUMERIC` 静态常量**：`Array` 排序模式常量（供 `sort` 使用）

> AS3 语义要点：`map`/`filter` 回调签名为 `function(element:*, index:int, array:Array):*`（`filter` 返回 `Boolean`）；
> `sort` 默认按字符串排序，`Array.NUMERIC` 改为数值排序；`reverse` 无参且就地反转。
> 运行时助手：`as_array_map`/`as_array_filter`/`as_array_sort`/`as_array_reverse`，回调调用需经 `as_value` 函数指针分发。

**验收**：`[1,2,3].map(function(x,i,a){return x*2;})` → `[2,4,6]`；
`[1,2,3,4,5,6].filter(function(x){return x%2==0;})` → `[2,4,6]`；
`[30,1,200,7].sort(Array.NUMERIC)` → `[1,7,30,200]`、随后 `reverse()` → `[200,30,7,1]`（`examples/air-native/src/demo/ArrayDemos.as` 逻辑主体可编译）。

---

### 阶段三十一：顶层 `JSON` 类（目标 v0.3.31）

补齐顶层 `JSON` 类（对照 `examples/air-native/src/demo/JsonDemos.as`），让对象/数组与 JSON 文本互相转换。

- [x] **`JSON.stringify(value):String`**：递归序列化 `as_value`（`number`/`string`/`bool`/`array`/`object`/`null`）为 JSON 文本；字符串转义（`"`/`\`/控制字符）、数值最短往返、`null`/`undefined` → `null`
- [x] **`JSON.parse(text):Object`**：递归下降解析 JSON 文本，构造 `as_value`（对象 → `as_object_new` + 字段填充，数组 → `as_array_new` + 元素填充，基础类型按 token 装箱）；非法 JSON 抛 `SyntaxError`
- [x] **符号表注入**：`resolveType` 识别 `JSON`，注入 `JSON.stringify`/`JSON.parse` 静态方法签名

> AS3 语义要点：`JSON.stringify` 返回 `String`，对象键序按插入序；`JSON.parse` 返回 `Object`/`Array`（`*`），
> 数字解析为 `Number`（`double`）、`true`/`false` 为 `Boolean`、字符串为 `String`、`null` 为 `null`。
> 运行时助手：`as_json_stringify(as_value)` / `as_json_parse(const char*)`，复用 `as_value` tag 分发与 `as_object`/`as_array` 表示。

**验收**：`JSON.stringify({name:"Alice",age:30,tags:["as3","air"],active:true})` 产出合法 JSON 文本；
`JSON.parse(s).name` → `"Alice"`、`JSON.parse("[1,2,3]") as Array` 长度 3、嵌套对象往返可读（`examples/air-native/src/demo/JsonDemos.as` 可编译）。

---

### 阶段三十二：`Date` 构造器重载与格式化方法（目标 v0.3.32）

补齐 `Date` 缺失的构造器重载与格式化方法（对照 `examples/air-native/src/demo/DateDemos.as`）。

- [x] **多参构造 `new Date(year, month, day, hour, minute, second, ms)`**：月份 0 基、缺省参数补 0，按本地时区计算 epoch 毫秒
- [x] **epoch 毫秒构造 `new Date(ms)`**：单 `Number` 参数直接作为 epoch 毫秒时间戳
- [x] **`Date.parse(str)`（静态）**：解析 `"YYYY/MM/DD"` 等日期字符串为 epoch 毫秒 `Number`（先覆盖 `YYYY/MM/DD` 与 ISO `YYYY-MM-DD`，失败返回 `NaN`）
- [x] **`toDateString()`**：人类可读本地日期字符串（如 `"Mon Jan 15 2024"`）
- [x] **`toUTCString()`**：UTC 日期字符串（如 `"Mon, 15 Jan 2024 10:30:00 GMT"`）

> AS3 语义要点：`new Date(year, month, ...)` 的 `month` 是 **0 基**（1 月 = 0）；`new Date(ms)` 单参数为 epoch 毫秒；
> `Date.parse` 失败返回 `NaN`。运行时用 `struct tm` + `mktime`/`timegm` 做日历 ↔ epoch 转换，格式化对齐 AS3 输出（`strftime` 或手写）。
> 当前构造器仅 `params: []`（只支持无参 `new Date()`），需在 `symbols.ts` 的 `Date` 构造器签名与 `emit.ts` 的 `Date_new` 分发处扩展重载。

**验收**：`new Date(2024,0,15,10,30,0,0).getFullYear()` → `2024`、`.getDate()` → `15`；
`new Date(d.getTime()).getDate()` 往返正确；`Date.parse("2024/01/15") > 0`；`toDateString()`/`toUTCString()` 输出可读日期（`examples/air-native/src/demo/DateDemos.as` 可编译）。

---

### 阶段三十三：`flash.events` 事件核心引擎（目标 v0.3.33）

攻关 GUI/事件系统的第一步：`Event` / `EventDispatcher` / 事件分发三阶段。**不依赖显示列表**，可独立实现。
语义权威参照 Ruffle `avm2_events.rs`（capture→target→bubble 三阶段）/ `event.rs` / `event_dispatcher.rs`，映射草案见 [`as3-docs/mapping.md`](docs/zh-cn/as3-docs/mapping.md) §1~§3。

- [x] **`Event` 类**：`type` / `bubbles` / `cancelable` / `target` / `currentTarget` / `eventPhase` 只读属性；`preventDefault()` / `stopPropagation()` / `stopImmediatePropagation()`；`toString()` / `clone()`；`Event.ACTIVATE` 等静态常量（首期先覆盖常用事件名常量）
- [x] **`EventDispatcher` 类**：`addEventListener(type, listener, useCapture=false, priority=0, useWeakReference=false)` / `removeEventListener` / `hasEventListener` / `willTrigger` / `dispatchEvent(event):Boolean`
- [x] **事件分发三阶段引擎**：capture（祖先逆序）→ target → bubble（祖先正序，仅 `bubbles=true`）；监听器表用 `as_object` 存 `(事件名, phase) → as_fn[]`，回调复用现有 `as_fn` 函数值分发
- [x] **运行时助手**：`as_event` 结构（`type`/`bubbles`/`cancelable`/`cancelled`/`prop_stopped`/`imm_stopped`/`phase`/`target`/`current_target`）、`as_dispatch_event` / `as_dispatch_to_target` / `as_disp_add_listener` / `as_disp_remove_listener`、`as_evt_prevent_default` / `as_evt_stop_propagation` / `as_evt_stop_immediate_propagation`（mapping.md §2~§3）

> AS3 语义要点：`eventPhase` 三值 `CAPTURING=1 / AT_TARGET=2 / BUBBLING=3`（对应 Ruffle `EventPhase`）；
> `target` 全程不变、`currentTarget` 随分发推进变化；`stopImmediatePropagation` 同时阻止同目标后续监听器；
> `dispatchEvent` 返回「事件是否被处理」（Ruffle 以 `target` 被设置为判据）。
> 监听器回调签名 `function(event:Event):void`，经 `as_fn` 闭包分发（复用阶段五/十一的函数值运行时表示）。

**验收**：`var d:EventDispatcher = new EventDispatcher(); d.addEventListener("foo", function(e:Event):void { trace(e.type); }); d.dispatchEvent(new Event("foo"));` 输出 `foo`；
`bubbles=true` 的嵌套 dispatcher 事件按 capture→target→bubble 顺序触发监听器（`examples/stage33.as`）。

---

### 阶段三十四：`flash.display` 显示列表基础（目标 v0.3.34）

GUI 的骨架：`DisplayObject` / `DisplayObjectContainer` / `Stage`，为下一阶段的交互事件流提供 `parent`/`children`/`depth` 挂钩。
渲染暂用占位（真实像素在后续渲染阶段链接 skia，见 [`skia.md`](docs/zh-cn/skia.md) 与阶段三十六~三十八），本阶段只建模**层级关系与坐标**。

- [x] **`DisplayObject` 基类**：`name` / `x` / `y` / `width` / `height` / `visible` / `alpha` / `rotation` / `scaleX` / `scaleY` / `parent` / `root` / `stage`（只读）；`localToGlobal` / `globalToLocal` / `hitTestPoint`（坐标变换与命中，对齐 Ruffle `display_object/*`）
- [x] **`DisplayObjectContainer`**：`addChild` / `addChildAt` / `removeChild` / `removeChildAt` / `numChildren` / `getChildAt` / `getChildByName` / `contains` / `setChildIndex`（渲染列表 = 深度序，对应 Ruffle `iter_render_list`）
- [x] **`Stage` / `root`**：最外层容器，作为祖先链终点（对应 Ruffle `Stage`，事件分发与命中测试的 `stage` 兜底）
- [x] **C 结构**：`as_display_object`（`parent` 指针 + `depth` + `visible`/`mouse_enabled`/`mouse_children` 标志位）、`as_display_container`（子对象数组）；`as_disp_parent` / `as_disp_child_at` / `as_disp_num_children` 等挂钩（供 §4/§5 事件流调用）

> AS3 语义要点：`DisplayObjectContainer` 的渲染列表顺序 = 深度序（低 depth 先绘制）；
> 鼠标事件命中遍历**逆序**（高 depth 先命中）、键盘事件**正序**（对应 Ruffle `interactive.rs` `propagate_to_children`）；
> `root`/`stage` 只读，`parent` 随 `addChild`/`removeChild` 维护。
> 本阶段渲染用「可见性/坐标」建模即可，真实光栅化延后到后续渲染阶段链接 skia（见 [`skia.md`](docs/zh-cn/skia.md) §10 与阶段三十六~三十八）。

**验收**：`var s:Sprite = new Sprite(); var c:Sprite = new Sprite(); s.addChild(c);` 后 `c.parent == s`、`s.numChildren == 1`、`c.stage != null`；`getChildAt(0) == c`（`examples/stage34.as`）。

---

### 阶段三十五：交互事件与命中测试（目标 v0.3.35）

把阶段三十三的事件引擎与阶段三十四的显示列表接上，落地 `InteractiveObject` 的事件流与命中测试。
语义权威参照 Ruffle `interactive.rs`（inside-out 分发 + 命中三态机）/ `events.rs`（事件分类与键码）/ `event_object.rs`（事件对象构造），映射草案见 `mapping.md` §4~§7。

- [x] **`InteractiveObject`**：`mouseEnabled` / `mouseChildren` / `doubleClickEnabled` / `tabEnabled` / `tabIndex` / `focusRect`；`hasFocus` 只读；`InteractiveObject` 作为 `DisplayObject` 子类，`SimpleButton`/`TextField` 等后续可复用
- [x] **鼠标/键盘/焦点事件类**：`MouseEvent`（`mouseDown`/`mouseUp`/`click`/`mouseMove`/`mouseOver`/`mouseOut`/`rollOver`/`rollOut`/`doubleClick`/`mouseWheel` + `localX`/`localY`/`relatedObject`/`ctrlKey`/`altKey`/`shiftKey`/`buttonDown`/`delta`）、`KeyboardEvent`（`keyDown`/`keyUp`/`keyCode`/`charCode`）、`FocusEvent`（`focusIn`/`focusOut`/`keyCode`/`relatedObject`）
- [x] **inside-out 事件流**：`as_handle_clip_event`（filter → propagate_to_children → event_dispatch，最深子对象先响应，对应 `interactive.rs:552`）；鼠标事件逆序/键盘正序传播 + `Handled` 短路（`interactive.rs:233`）
- [x] **命中测试三态机**：`Avm2MousePick`（`Hit`/`PropagateToParent`/`Miss`）+ `combine_with_parent`（`mouseEnabled`/`mouseChildren` 组合命中判定，对应 `interactive.rs:796`）——Flash 文档讲不清的「父吸收/穿透」边界靠此对齐
- [x] **焦点管理**：`as_interactive_flags`（`has_focus`/`tab_enabled`/`tab_index`/`focus_rect`）；键盘事件只在对象有焦点时触发（`interactive.rs:754` `should_fire_event_handlers`）
- [x] **键码表**：`KeyCode` / `ButtonKeyCode` 常量照抄 `events.rs:526` 起（`Keyboard.keyCode` 与 `Key.isDown` 键码不一致处注明）

> AS3 语义要点（均对应 `mapping.md` 的「AS3↔C 差异点」注释）：
> `RollOver` 同时覆盖 `mouseOver`（bubbles）与 `rollOver`（不 bubbles），二者靠 `lowest_common_ancestor` 区分；
> `mouseChildren=false && mouseEnabled=true` 时父「吸收」子事件（`target` 改为父）；两者皆 `false` 时事件**穿透**继续向上找 `mouseEnabled=true` 祖先；
> `MouseEvent` 构造器参数序固定（`event_type, bubbles, cancelable, localX, localY, relatedObject, ctrlKey, altKey, shiftKey, buttonDown, delta`，对应 `event_object.rs:113`）。

**验收**：鼠标事件在嵌套 `Sprite` 中按最深子对象→父逐层触发；`mouseChildren=false` 的父吸收子 `click` 且 `target` 变为父；键盘事件仅在聚焦对象触发；`rollOver`/`rollOut` 在离开父及其所有子对象时才触发（`examples/stage35.as`）。

---

### 阶段三十六：Skia 胶水层 + 构建集成（目标 v0.3.36）

把渲染后端真正接进来。依据 [`skia.md`](docs/zh-cn/skia.md)：Skia 是 C++20 库、**无 C API**，必须用 C++ 胶水层（`extern "C"`）桥接生成的 `.c`；本阶段只做**最小可行闭环**，验证「生成的 C → 胶水层 → Skia → 正确像素」。

- [x] **`vendor/skia` 引入**（外部依赖，本机缺 `gn`/`ninja`，改走预编译）：采用 [Aseprite 官方预编译 Skia](https://github.com/aseprite/skia/releases) **m124**（`Skia-macOS-Release-arm64.zip`，含头文件 + 全套静态库），解压后 `include/` + `lib/` 就位（含 `libskia.a` 及 PNG/JPEG/WebP/freetype/harfbuzz/icu/zlib 等传递依赖）。因 m124 已把 `SkSurface::MakeRaster` → `SkSurfaces::Raster`、`SkImage::MakeFromEncoded` → `SkImages::DeferredFromEncodedData`，`skia_glue.cc` 已相应适配
- [x] **`skia_glue.cc` 最小 `extern "C"` 面**：`surface` 创建（`SkSurface::MakeRaster`）、`canvas`（取/清屏）、`paint`（颜色/填充/描边/线宽/抗锯齿）、`path`（`moveTo/lineTo/cubicTo/close` + `drawPath`）、`color`/`matrix`（translate/rotate/scale）、`save/restore`、`drawRect/drawCircle`、`makeImageSnapshot` → PNG 编码输出；对象用不透明指针 + 引用计数（`skia.md` §3）
- [x] **`build.ts` 支持 C++ 源**：`sources` 里 `.cc/.cpp` 用 `c++/clang++` 驱动、自动补 `-lstdc++`；`.cc` 与生成的 `.c` 一起编链（`skia.md` §6.2）
- [x] **`as_skia_*` 运行时助手**：在 `RUNTIME_PREAMBLE` 里暴露 `as_skia_surface_new`/`as_skia_canvas_draw_rect` 等薄封装，供 `DisplayObject.render()` 调用（`skia.md` §4）

> 首期后端：离屏 CPU raster（`SkSurface::MakeRaster` → PNG），不碰窗口系统，可直接断言像素（`skia.md` §6.3）。
> `build.ts` 的 `.cc` 编译驱动是本阶段唯一涉及构建层的改动，需与现有 `--manifest`/`-I/-L/-l` 能力协同。

**验收**：`as-aot` 生成含 `Shape` 的 `.as`，通过 `--manifest skia-link.build.example.json` 编链，产出 PNG，像素与预期一致（`examples/stage36.as`）。

---

### 阶段三十七：`flash.display` 渲染落地（目标 v0.3.37）

把阶段三十四的显示列表接上 Skia，落地矢量与位图的实际光栅化（映射表见 `skia.md` §4）。

- [x] **`Shape`/`Graphics` → `SkPath`+`SkPaint`**：`moveTo/lineTo/curveTo` → `SkPath`；`beginFill/endFill` → fill；`lineStyle` → stroke；`beginGradientFill` → `SkGradientShader`（两色线性）
- [x] **`Bitmap`/`BitmapData` → `SkImage`**：`setPixel/getPixel`（原始 RGBA 缓冲）+ `loadFile` → `SkImage::MakeFromEncoded`；`BitmapData.draw(source)` 合成、PNG/JPEG 解码（`SkCodec`）为后续子阶段
- [x] **`DisplayObject` 变换**：`x/y/rotation/scaleX/scaleY` → `canvas` translate/rotate/scale（`save`/`restore` 内）；`alpha` → `saveLayerAlpha`；`visible=false` 跳过子树；`blendMode` → `SkBlendMode` 为后续子阶段
- [x] **递归渲染 + 深度序**：`as_render_object(canvas)` 先自身后子（低 depth 先画），对应 `skia.md` §4 的坐标变换范式

> 深度序渲染用**正序**（低→高），与阶段三十五鼠标命中**逆序**（高→低）是同一份 children 数组的两个视角。

**验收**：一个含 `Shape`（矩形+渐变）、`Bitmap`、嵌套 `Sprite` 的场景能渲染成正确 PNG；`alpha`/`blendMode`/`rotation` 生效（`examples/stage37.as`）。

---

### 阶段三十八：`TextField` 文本渲染（目标 v0.3.38 → v0.3.72）

补齐 GUI 的文本：`TextField` 用 Skia 的文本能力，不自研排版（`skia.md` §8）。

**单行渲染（v0.3.38）**

- [x] **`SkFont` 基础字形**：`TextField.text` 单行文本 → `SkFont`（`setEmbolden`/`setSkewX` 近似 bold/italic）+ `drawString`
- [x] **`TextFormat` 样式**：`font`/`size`/`color`/`bold`/`italic` → `SkFont`/`SkPaint`（`SkTypeface` 字体家族选择为后续子阶段）

**多行排版（v0.3.45，对齐 adl）**

adl 里 Log 用 `multiline + wordWrap + scrollV = maxScrollV` 做滚动日志，单行 `drawString` 直绘只能看到第一行。
首版排版方案不用 SkParagraph（其 UAX#14 换行与 AIR `wordWrap` 仅按空格断行语义漂移），改用 `SkFont` 测量 + 自研
贪心换行（与阶段二十四~二十七自研正则引擎同理，字形测量/绘制仍全部交给 Skia）；后于 v0.3.72 升级 SkParagraph
（见下文），以下条目保留为历史记录。

- [x] `runtime.ts` 新增文本排版层：`AsLine{start,len}` / `AsLines` + `as_text_wrap` / `as_text_wrap_segment`
      （硬换行 + 按空格贪心软换行，宽度用 `as_skia_text_measure_n` 实测，与实际绘制同一字体）
- [x] **排版只记偏移不复制字符串**：AS3 字符串来自 `as_alloc` bump allocator，逐行 `as_str_slice` 复制再 `free()`
      会命中「free 非 malloc 指针」崩溃（实测 `malloc: pointer being freed was not allocated`），
      偏移方案同时避免每次重绘重复分配
- [x] `skia_glue.cc` 加 `sk_canvas_draw_text_n`（`drawSimpleText` 带字节长度，切片无需重新 `\0` 结尾）
      与 `sk_canvas_clip_rect`（把行裁进字段框）
- [x] `emit.ts`：`as_tf_layout` / `as_tf_line_height` / `as_tf_visible_lines` / `as_tf_line_count`，
      `numLines` 新 getter，`textWidth` 改为逐行取最大宽度，`textHeight = numLines × lineHeight`，
      `maxScrollV = numLines - visibleLines + 1`（clamp ≥ 1），渲染按 `scrollV` 定位顶行并裁剪
- [x] **AS3 语义要点**（已写入注释）：`maxScrollV` 是「仍能填满视口的最大顶行号」而非 `numLines`，
      所以 `scrollV = maxScrollV` 让最新一行贴在框**底部**（滚动日志惯用法），而不是被滚到顶部；
      `multiline=false` 时换行符不分行；`wordWrap` 只在空格处断行，超长单词整词溢出

**顺带修复的性能阻塞（多行渲染暴露）**

- [x] `skia_glue.cc` 的 `sk_font()` 原先**每次调用**都 `SkFontMgr_New_CoreText` + 枚举排序全部系统字体
      （`CTFontManagerCopyAvailableFontFamilyNames`）。单行时每帧 1 次无感，多行后每帧几十次 →
      首帧卡死数十秒（lldb 栈证实卡在字体枚举）。改为 `static sk_sp<SkTypeface>` 缓存，只初始化一次；
      空闲 CPU 由 19.5% 降到 0.1%

**SkParagraph 完整排版（v0.3.72）**

自研贪心换行按空格断行、逐 word `SkFont` 测量、每帧重算无缓存；改用 Skia 官方 `modules/skparagraph`
（`libskparagraph.a` 已随链接清单引入），由 HarfBuzz shaping + UAX#14 断行 + 段落级对齐/字间距，一次
`layout` 复用缓存。

- [x] `skia_glue.cc` 加 `sk_textlayout_new`（FontCollection 单例 + `TextStyle`/`ParagraphStyle` + `layout`）/
      `_height` / `_max_width` / `_line_count` / `_paint` / `_delete` 桥接，字体家族/字号/颜色/粗斜传入
- [x] `emit.ts`：`as_tf_paragraph` 替换 `as_tf_layout`，TextField struct 缓存 `_para` 句柄 + 失效 key（text
      指针/width/size/bold/italic/color/collapse），重绘与属性读取复用一次布局；行高改 `getHeight()/lineNumber()`
      真实 ascent+descent（不再 `size × 1.2`）；`textWidth = getLongestLine()`、`textHeight = getHeight()`
- [x] `multiline=false` 单行模式把 `\n` 折叠为空格（AIR 单行不分行，SkParagraph 否则总把 `\n` 当硬换行）
- [x] 纯 C 回退：`numLines` 硬换行计数、`textHeight = numLines × size × 1.2`，无 Skia 构建的断言语义不变
- [x] `examples/textflow.as` 断言改基于运行时行高（`textHeight/numLines`）的关系式，纯 C / Skia 双构建通过

**验收**：`examples/stage38.as` 单行渲染正确字形 + `TextFormat` 样式生效；`examples/textflow.as` 断言
`numLines` / `maxScrollV` / `scrollV` / `appendText` / `textHeight`，在纯 C、Skia 离屏、Skia+Window+HiDPI
三种构建下均通过；`examples/air-native` 窗口内 Log 显示 Array/ByteArray/JSON 全部行、顶部 Date 段已滚出、
底部 `=== All demos complete ===` 完整贴底。

**遗留（待实现）**：

- [x] **富文本排版**（多 `TextFormat` 区间样式、`htmlText`）——`setTextFormat` 与 `htmlText`（`<font>`/`<b>`/`<i>`/`<u>`/`<p>`/`<br>` 子集）已落地，走 `ParagraphBuilder` 多 run 样式；对齐/字间距/多段落仍待后续
- [x] TextField 已支持 `autoSize` / `hscroll` / `selectable` / HTML 文本
- [x] `leading` 字段已建模（`TextFormat.leading` 经 `StrutStyle` 接线）
- [ ] `_para` 缓存随 TextField 被 GC 回收时 C++ 侧 paragraph 不释放（UI 对象长生命周期，影响有限）

---

### 阶段三十九：SDL2 窗口化后端（目标 v0.3.40）

把离屏渲染升级为真实原生窗口：`Stage.showWindow(width, height, title)` 上屏 + 事件循环。窗口与输入交给
SDL2（arm64 静态库），符合「前端只翻译、窗口/像素交给成熟库链接」铁律（AGENTS.md §2.9，[`compile.md`](docs/zh-cn/compile.md) §6）。

- [x] **arm64 SDL2 静态库**：源码编译 `libSDL2.a`（arm64）到 `vendor/sdl2/arm64/`（系统原有 SDL2 为 x86_64，无法与 arm64 Skia 混链）；链接清单追加 `SDL2`/`objc` 及 `CoreVideo`/`Cocoa`/`Carbon`/`IOKit`/`Metal`/`QuartzCore` 框架
- [x] **窗口胶水层 `vendor/window_glue.cc`**：SDL2 窗口创建 + 事件循环（处理 `SDL_QUIT`/重绘），用 `SDL_CreateRGBSurfaceFrom` 零拷贝包裹 Skia raster surface 像素缓冲，`SDL_Texture` + `SDL_RenderCopy` 上屏
- [x] **Skia 桥接扩展**：`skia_glue.cc` 暴露 `sk_surface_peek_pixels`（取 CPU raster surface 像素缓冲），供 `window_glue.cc` 上屏
- [x] **`Stage.showWindow` 原语**：`symbols.ts` 注册方法、`emit.ts` 发射 `Stage_showWindow`、`runtime.ts` 加 `as_skia_surface_show_window`（`ASC_USE_WINDOW` 条件编译，未定义时 no-op，纯 C 构建仍可编译）
- [x] **R/B 通道字节序修正**：Skia kN32（0xAARRGGBB）→ SDL 通道掩码 `R=0x000000FF`/`G=0x0000FF00`/`B=0x00FF0000`/`A=0xFF000000`，修掉小端序下颜色颠倒

> 关键细节：`window_glue.cc` 顶部 `#define SDL_MAIN_HANDLED`，避免 SDL 把生成的 `int main(void)` 重定义为
> `SDL_main`；未定义 `ASC_USE_WINDOW` 时 `Stage.showWindow` 退化为 no-op。
> 产物仍是 Mach-O 可执行文件（命令行运行即弹窗）；「双击可运行」的 macOS `.app` bundle（`MyApp.app/Contents/...` +
> `Info.plist`）是后续打包脚本层，非编译器参数。

**验收**：`as-aot examples/window.as --manifest examples/window.build.example.json` 编链出 arm64 可执行，
运行弹出原生 macOS 窗口（标题栏 + `AS3 Native Window`），蓝色矩形 + `Hello from AS3 -> C -> SDL2 window`
文字正确显示，关闭窗口即退出；回归 49 例全过（新增 `examples/window.as`）。

---

### 阶段四十：窗口鼠标事件桥接（目标 v0.3.41）

把 SDL2 的鼠标输入桥接回 AS3 事件系统，打通「阶段三十三~三十五事件引擎」与「阶段三十九窗口后端」两套独立
子系统：窗口内真实点击 → `Stage_dispatchMouse` 命中测试 → 冒泡分派 → 事件后重渲染上屏。

- [x] **`window_glue.cc` 事件循环转发鼠标输入**：左键 `mouseDown`/`mouseUp`/`click` 经 C 函数指针回调 `on_mouse` 转发（窗口相对坐标 + AS3 事件类型字符串）；每个处理后的事件调用 `on_redraw` 回调重绘，并用 `SDL_CreateTextureFromSurface` 重建纹理上屏（`present_frame` 辅助函数统一初始帧与重绘）
- [x] **回调桥接（`runtime.ts` + `emit.ts`）**：`sk_window_show` 新增 `on_mouse`/`on_redraw` 两个函数指针参数；`emit.ts` 发射静态回调 `ASC_window_on_mouse`（路由到 `Stage_dispatchMouse`）与 `ASC_window_on_redraw`（清空 canvas + 重新光栅化 display tree），`Stage_showWindow` 保存 `ASC_win_canvas`/`ASC_win_stage` 并传入回调
- [x] **修复 `as_pick_hit` 越界读**：原实现对纯 `DisplayObject`（`Shape`/`Bitmap`，非 `InteractiveObject` 子类）强转 `InteractiveObject*` 读 `mouseChildren`/`mouseEnabled` 越界；改用 `as_is` 类型判定——仅 `DisplayObjectContainer` 子类递归子节点、仅 `InteractiveObject` 子类读 `mouseEnabled`/`mouseChildren`，纯 `DisplayObject` 对命中透明
- [x] **示例 `examples/window_click.as` + `examples/window_click.build.example.json`**：点击蓝色矩形 → 变红 + trace 输出 `mouseDown`/`mouseUp`/`click` 的 `localX`/`localY` + `stage bubbled click, target is box: true`（冒泡验证）

> 关键细节：`window_glue.cc` 是 C++ 编译的独立胶水层、不知道生成的 C 函数名，故用**函数指针回调**（而非直接
> 调用 `Stage_dispatchMouse`）解耦；坐标直接使用 SDL 的窗口相对坐标（与 stage 坐标系一致，stage 在 `(0,0)`），
> `Stage_dispatchMouse` 用 `x - target.x` 换算 `MouseEvent.localX/localY`。

**验收**：`as-aot examples/window_click.as --manifest examples/window_click.build.example.json` 编链运行，
窗口内点击蓝色矩形触发 `mouseDown`/`mouseUp`/`click`（控制台打印 `localX/localY` 坐标）并冒泡到 stage
（`target is box: true`），矩形即时变红（事件后重渲染上屏）；回归 50 例全过（新增 `examples/window_click.as`）。

---

### 阶段四十一：`Stage` 舞台属性与常量类补齐（目标 v0.3.42）

依据 AIR SDK [`Stage`](https://airsdk.dev/reference/actionscript/3.0/flash/display/Stage.html) 官方参考，补齐 `Stage` 的舞台级属性与
配套常量类。当前 `Stage` 只注册了 `dispatchMouse`/`render`/`showWindow` 三个方法、无字段、无 getter/setter；
本阶段把「桌面 AIR profile 可用、且能落到现有 SDL2 窗口 + Skia 渲染后端」的属性落地，移动端专属与依赖未建模类型的属性明确延后。

**常量类（纯静态 `String` 常量，零运行时依赖，先落地）**：

- [x] **`StageAlign`**：`TOP`/`BOTTOM`/`LEFT`/`RIGHT`/`TOP_LEFT`/`TOP_RIGHT`/`BOTTOM_LEFT`/`BOTTOM_RIGHT`（8 个 `String` 常量）
- [x] **`StageScaleMode`**：`EXACT_FIT`/`SHOW_ALL`/`NO_BORDER`/`NO_SCALE`（4 个）
- [x] **`StageQuality`**：`LOW`/`MEDIUM`/`HIGH`/`BEST`（4 个）
- [x] **`StageDisplayState`**：`NORMAL`/`FULL_SCREEN`/`FULL_SCREEN_INTERACTIVE`（3 个）

**舞台尺寸 / 全屏 / 渲染质量（用户点名的核心，落地为字段 + 桥接）**：

- [x] **`stageWidth`/`stageHeight`**（`int`，读；写仅 `NO_SCALE` 生效）——`Stage` 新增 `stage_w`/`stage_h` 字段，`Stage_showWindow` 写入；`boot.as`/`boot-gui.as` 的 `stage.stageWidth` 可正确返回
- [x] **`fullScreenWidth`/`fullScreenHeight`**（`uint`，只读）——`window_glue.cc` 用 `SDL_GetCurrentDisplayMode` 返回显示器当前分辨率
- [x] **`displayState`**（`String`，读/写）——`window_glue.cc` 用 `SDL_SetWindowFullscreen` 在 `NORMAL`↔`FULL_SCREEN` 间切换；`FULL_SCREEN_INTERACTIVE` 桌面等同 `FULL_SCREEN`
- [x] **`quality`**（`String`，读/写）——映射 Skia 抗锯齿（`LOW` 关 `SkPaint::setAntiAlias`，其余开）
- [x] **`color`**（`uint`，读/写）——映射窗口背景色，替换 `as_skia_canvas_clear` 里硬编码的 `0xFFFFFF`
- [x] **`align`**（`String`，读/写）——存字段，控制窗口 resize 时内容的对齐基准（桌面非 `NO_SCALE` 下实际由 scaleMode 主导）
- [x] **`scaleMode`**（`String`，读/写）——存字段；`NO_SCALE` 时窗口 resize 触发 `Event.RESIZE` + 重排，其余模式缩放内容
- [x] **`frameRate`**（`Number`，读/写）——存字段；影响 SDL2 事件循环的 frame pacing（当前事件循环为阻塞式、无帧率概念，先存字段留作后续）

**布尔开关（读/写，存字段即可）**：

- [x] **`stageFocusRect`** / **`showDefaultContextMenu`** / **`tabChildren`**：存字段；桌面后端暂无焦点矩形/右键菜单/tab 循环，先存字段留作后续
- [x] **`allowsFullScreen`** / **`allowsFullScreenInteractive`**（`Boolean`，只读）：桌面 AIR profile 恒 `true`
- [x] **`contentsScaleFactor`**（`Number`，只读）：HiDPI 缩放因子，当前 SDL2 窗口后端返回 `1.0`

**桥接层改动**：

- [x] **`window_glue.cc`**：暴露 `sk_window_set_fullscreen`/`sk_window_get_display_size`/`sk_window_resize`，并在事件循环补 `SDL_WINDOWEVENT_RESIZED`/`SIZE_CHANGED` 转发（供 `resize` 事件与 `stageWidth`/`stageHeight` 更新）
- [x] **`skia_glue.cc`**：暴露背景色清屏（参数化 `as_skia_canvas_clear` 的 RGB，替换硬编码白）
- [x] **`runtime.ts`**：`RUNTIME_PREAMBLE` 新增 `as_skia_surface_*` 薄封装（全屏/分辨率/背景色）

> AS3 语义要点：`stageWidth`/`stageHeight` 在 `NO_SCALE` 下随窗口 resize 变化，其余 scaleMode 下恒为初始值；
> `quality` 桌面 profile 只接受 `BEST`/`HIGH`（默认 `HIGH`），设置其他值无效；`displayState` 设 `FULL_SCREEN` 会派发 `FullScreenEvent.FULL_SCREEN`，
> 且在 `FullScreenEvent` 处理器内再次修改 `displayState` 会抛 `SecurityError`（本子集可先不派发该事件，README 注明）。

**明确延后（移动端专属 / 依赖未建模类型）**：

- [ ] 移动端专属：`autoOrients`/`deviceOrientation`/`orientation`/`supportedOrientations`/`supportsOrientationChange`（static）/`setAspectRatio`/`setOrientation`——桌面 AIR profile 不支持，no-op 或返回默认值
- [ ] 依赖未建模类型：`nativeWindow`（`NativeWindow` 未建模）/`stage3Ds`（`Stage3D`）/`stageVideos`（`StageVideo`）/`softKeyboardRect`（软键盘）/`textSnapshot`（`TextSnapshot`）/`focus`（焦点，阶段三十五有 `InteractiveObject` 焦点标志但 `Stage.focus` 未暴露）

**验收**：`examples/air-native/src/demo/Main.as` 可读 `stage.stageWidth`/`stage.stageHeight`/`stage.fullScreenWidth`/`stage.fullScreenHeight`；
`stage.quality = StageQuality.HIGH`、`stage.color = 0x112233`、`stage.align = StageAlign.TOP_LEFT`、`stage.scaleMode = StageScaleMode.NO_SCALE` 可读回；
`stage.displayState = StageDisplayState.FULL_SCREEN` 触发窗口全屏（SDL2 上屏验证）；回归不破坏既有 50 例（新增 `examples/stage41.as`）。

> **实现说明**：`quality`/`align`/`scaleMode`/`frameRate` 当前为**字段存储 + 读回**（实际渲染效果——抗锯齿、内容对齐/缩放、帧率 pacing——留待后续子阶段）；`window_glue.cc` 的 `SDL_WINDOWEVENT_RESIZED` 转发与 `resize` 事件同样留待后续（本阶段落地的是全屏切换 `SDL_SetWindowFullscreen` + 显示器分辨率查询 `SDL_GetCurrentDisplayMode` + 背景色参数化 `sk_canvas_clear`）。`fullScreenWidth`/`fullScreenHeight` 在 macOS 上返回 SDL 的逻辑分辨率（点），非 Retina 物理像素。

---

### 阶段四十二：AIR `app.xml` 解析与构建引导指令（目标 v0.3.43）

让 `as-aot` 能解析 AIR 应用描述符（`air-native-app.xml`），自动生成引导启动代码 + 构建清单，把纯 AS 的 AIR 项目
一键迁移到 as-aot 编译（无需手写 `boot.as` 与 manifest）。这是「AIR 项目 → as-aot」的便利迁移适配层，
不是核心编译管线的一部分。

**输入（`examples/air-native/air-native-app.xml`）**：

```xml
<application xmlns="http://ns.adobe.com/air/application/51.0">
  <id>demo.as3.native</id>
  <versionNumber>1.0</versionNumber>
  <filename>air-native</filename>
  <initialWindow>
    <content>main.swf</content>
    <title>Native AS3 Demo</title>
    <visible>true</visible>
    <width>720</width>
    <height>480</height>
  </initialWindow>
</application>
```

**可提取的元数据**：`<id>`（应用标识）→ `filename`/产物名、`<initialWindow>` 的 `<title>`/`<width>`/`<height>`/`<visible>` → 引导代码与窗口参数。

**信息缺口（关键）**：AIR 的 `app.xml` **不含主类名**（document class）——主类由 mxmlc 编译参数或 `[SWF]` 元数据指定，
不在应用描述符里。因此「解析 app.xml 生成启动代码」必须补一个主类来源，二者选一：

- [x] **方案 A（显式）**：新增 `--main-class demo.Main` 参数显式指定主类（最清晰、可确定）
- [x] **方案 B（约定）**：约定扫描 `src/**/Main.as` 或取 `<content>main.swf</content>` 去 `.swf` 转 PascalCase 得类名（启发式，README 注明局限）

**CLI 与生成物**：

- [x] **`--air-app <app.xml>` 参数**：解析应用描述符，与 `--main-class`（方案 A）配合，生成引导代码 + 构建清单
- [x] **引导启动代码**（等价 `boot-gui.as`）：`new Stage()` → `new {Main}()` → `stage.addChild` → `stage.showWindow(width, height, title)`；`<visible>false` 时改用离屏 `render` 出 PNG
- [x] **构建清单 JSON**：`sources`（递归扫描 `src/**/*.as` + 引导代码）、`link-libs`（`skia`/`SDL2`）、`defines`（`ASC_USE_SKIA=1`/`ASC_USE_WINDOW=1`）、`include-paths`/`link-paths`（指向 `vendor/skia`/`vendor/sdl2`）
- [x] **产物名**：取自 `<filename>`（`air-native`），`-o` 默认填充

**实现约束**：

- [x] 零第三方依赖（AGENTS.md §3.1），`app.xml` 用**手写极小 XML 解析器**（只提取 `<id>`/`<filename>`/`<versionNumber>`/`<initialWindow>` 的 `<content>`/`<title>`/`<visible>`/`<width>`/`<height>`，不引入 `fast-xml-parser` 等依赖）；非法/缺失字段报 `CodegenError` 带行列号
- [x] 引导代码生成复用现有 codegen 路径（生成 AS3 源码字符串再走 lexer/parser），而非直接拼 C（保持「前端只翻译」铁律）
- [x] 逻辑归入 `src/build.ts`（构建编排层）或新增 `src/air-app.ts`，`index.ts` 只做 CLI 参数解析与错误兜底

**验收**：`as-aot --air-app examples/air-native/air-native-app.xml --main-class demo.Main` 一条命令完成解析 → 生成引导代码 → 生成 manifest → 编链出 `air-native` 可执行，运行弹出标题 `Native AS3 Demo` 的 1000×680 窗口；不指定 `--main-class` 时按约定扫描并给出清晰报错；回归不破坏既有示例。

---

### 阶段四十三：AIR 描述符行为对齐（目标 v0.3.44）

对比 adl 启动的应用与 `--air-app` 编译产物，消除两处行为差异：

**差异 1：`<resizable>false</resizable>` 未生效**

- [x] `air-app.ts` 解析 `<resizable>`（缺省 `true`）→ `AirAppInfo.resizable`
- [x] `airManifest` 在 `visible && !resizable` 时加 `defines: ["ASC_WINDOW_FIXED=1"]`
- [x] `window_glue.cc` 的 `SDL_CreateWindow` 窗口 flag 由硬编码 `SDL_WINDOW_RESIZABLE` 改为
      `SDL_WINDOW_SHOWN`，仅在 `#ifndef ASC_WINDOW_FIXED` 时才加 `SDL_WINDOW_RESIZABLE`
- [x] 验证：osascript 尝试 set size 无效，窗口 frame 保持 1000×712（内容区 680 + 标题栏），与 adl 一致

**差异 2：`trace(stage.stageWidth, stage.stageHeight)` 返回 `0 0`**

根因是时序：引导代码 `new Stage()` → `new Main()`（构造时 `start()` 就 trace）→ `showWindow()`（才写尺寸），
而 adl 里 document class 构造时 NativeWindow 已建好、尺寸已就绪。

- [x] `generateBootstrap` 在 `new Stage()` 后、`new Main()` 前预设 `stage.stageWidth/Height`
- [x] 验证：运行输出 `1000 680`（与 adl 一致），不再是 `0 0`

**遗留（不影响本次对齐）**：

- [x] `<requestedDisplayResolution>high</requestedDisplayResolution>` 未处理（Retina 高清渲染，属 DPI 感知细节，
      SDL2 默认已按物理像素渲染，视觉差异极小）—— **已处理，见阶段四十四**（实测差异并不「极小」：
      未开 HIGHDPI 时文字被合成器拉伸 2x，肉眼可见模糊，故提升为独立阶段）
- [ ] `stageWidth/stageHeight` 的 setter 仍可写（AIR 里只读）；靠 bootstrap 预设而非内部窗口初始化，
      属 stage 四十一 field-backed accessor 的简化，未严格保真只读语义

---

### 阶段四十四：Retina 高清渲染（目标 v0.3.45）

对齐 adl 的可见差异：窗口文字模糊（`requestedDisplayResolution` 未处理）。**已完成（v0.3.45）**。
（TextField 多行排版内容已并入阶段三十八，见上文。）

根因：SDL2 默认不给窗口原生分辨率的 drawable（drawable 尺寸 == 逻辑尺寸），Skia 按逻辑点出的帧被
macOS 合成器拉伸 2x 上屏 → 文字发虚。AIR 的 `high` 正是「按设备原生分辨率渲染」，`standard` 才允许拉伸。

- [x] `air-app.ts` 解析 `<requestedDisplayResolution>`（缺省 `standard`，仅 `high` 生效）→ `AirAppInfo.displayResolution`
- [x] `airManifest` 在 `visible && high` 时加 `defines: ["ASC_DISPLAY_HIGH=1"]`
- [x] `window_glue.cc` 新增 `sk_window_probe_scale(w, h, highdpi, &pw, &ph)`：开一个 hidden + `SDL_WINDOW_ALLOW_HIGHDPI`
      窗口，用 `SDL_GL_GetDrawableSize` 读出物理像素尺寸与倍率（surface 必须在窗口存在**之前**按物理像素创建）
- [x] `sk_window_show` 签名加 `pw/ph`（surface 像素尺寸），窗口 flag 在 `ASC_DISPLAY_HIGH` 下加 `SDL_WINDOW_ALLOW_HIGHDPI`，
      纹理按 `pw×ph` 创建 → 与 drawable 1:1，不再重采样
- [x] `runtime.ts` 的 `as_window_device_scale()` 封装宏判断（无窗口后端 / 无 HIGH 宏时恒返回 1.0），
      `Stage_render` 与 `Stage_showWindow` 都按 scale 建 surface 并在逻辑坐标下绘制
- [x] `Stage.contentsScaleFactor` 由固定 `1.0` 改为读取 `stage_scale` 字段（render/showWindow 时写入），与 AIR 语义一致
- [x] 验证：`screencapture -l<windowid>` 抓得 **2000×1424**（窗口 1000×712 逻辑 × 2），文字边缘锐利；
      离屏 `render` 出 **2000×1360** PNG

**验收**：`--air-app` 产物截图为 2x 物理像素且文字清晰；回归 53 passed / 0 failed。

**遗留**：

- [ ] `contentsScaleFactor` 只在 `render`/`showWindow` 时写入，document class 构造期读到的是初始 `1.0`
      （adl 在 stage 创建时就已知倍率）；与 `stageWidth` 同类时序问题，需把 probe 提前到 bootstrap
- [ ] 全屏时 `ASC_DISPLAY_HIGH` 的 drawable 倍率取自主屏 probe（跨屏拖动后的倍率已在 resize 回调重算解决，见「跨显示器帧率/缩放修复 v2」）

---

### 阶段四十五：窗口缩放控制与鼠标滚轮（目标 v0.3.46）

**背景**：用户把 `app.xml` 改为 `<resizable>true</resizable>` 后拖动窗口，内容被拉伸变形；且鼠标滚轮
无法滚动 TextField。实测定位到两个独立缺陷：

1. **变形**：`window_glue.cc` 的 `present_frame` 用 `SDL_RenderCopy(..., NULL, NULL)`（dst=NULL），
   把纹理**拉伸铺满**整个渲染目标。窗口 resize 后渲染目标变成新的 drawable 尺寸，而 Skia surface
   仍是旧的固定尺寸 → 非等比拉伸即变形。且事件循环**完全没处理 `SDL_WINDOWEVENT_SIZE_CHANGED`**。
   而 AIR 的 `NO_SCALE` 语义恰恰是「内容固定不缩放」（adl 实测：拖动窗口内容尺寸不变）。
2. **滚轮**：`window_glue.cc` 已有 `SDL_MOUSEWHEEL` → `on_wheel` 回调，但 `emit.ts` 的
   `Stage_showWindow` **漏传 `on_wheel` 参数**（9 实参 vs 10 形参，编译报错），AS3 侧也没有
   `Stage_dispatchWheel`，事件链断在最后一公里。

**实现**：

- [x] `window_glue.cc`：`present_frame` 改显式 `SDL_Rect dst={0,0,w,h}`（1:1，永不拉伸）；事件循环处理
      `SDL_WINDOWEVENT_SIZE_CHANGED`，重查逻辑/物理尺寸后调新增的 `on_resize(logicalW,logicalH,physW,physH)`
      回调，由 AS3 侧重建 surface 并返回新指针（胶水层不持有 surface 所有权）
- [x] `emit.ts`：新增 `ASC_window_render()`，canvas 变换为「设备倍率 → align 偏移 → 内容缩放」三层；
      内容缩放按 `scaleMode` 计算（`noScale`=1、`showAll`=min 等比、`noBorder`=max 等比、`exactFit`=非等比），
      align 偏移按 `StageAlign` 八值分配剩余空间；`ASC_window_on_resize` 重建 surface + 更新 stage 尺寸 +
      派发 `Event.RESIZE`；**鼠标/滚轮坐标反变换**（`(x-ox)/cx`）修正缩放/偏移后的命中测试
- [x] `stageWidth/stageHeight` 语义对齐 AIR：`noScale` 跟随真实窗口尺寸（resize 时更新，供 app 重排），
      其余缩放模式保持设计尺寸
- [x] 新增 `Stage_dispatchWheel(x,y,delta)`（注册为 Stage 方法，供 SDL 事件循环与测试调用）：命中
      TextField 时自动滚动（adl 实测：1 delta = 1 行、`scrollV -= delta`、钳制 `[1,maxScrollV]`），
      再派发冒泡的 `MouseEvent.MOUSE_WHEEL`
- [x] 修复 `emit.ts` 漏传 `on_wheel` 的编译错误；`runtime.ts` 签名同步加 `on_resize`

**验证**（Computer Use 真实窗口）：窗口 1000×712 → 拖拽到 1201×589 / 1151×489（宽高比改变），深色
TextField 在两次截图中**逐像素不变**（field 内部 0/932196 像素差异，差异仅限标题栏）——NO_SCALE 生效；
滚轮上滚 6/8 格，field 顶部恰好上移 6/8 行（1 notch = 1 行，方向与 adl 一致）。`examples/wheel.as`
断言自动滚动/事件派发/钳制/未命中不分发，纯 C 通过。

**注意**：本子集的 lambda **按值捕获**自由变量（`_fn_env_make` 复制当前值），闭包内改写全局不会回传；
`wheel.as` 因此用顶层命名函数作监听器。`window_click.as` 此前「能用」仅因变色发生在 env 内部。

**验收**：回归 54 passed / 0 failed（新增 `wheel.as`）；adl 探针移出 `examples/`（改存 `tools/adl-probe/`，
避免被 test.ts 收集导致多 Main 冲突）。

---

### 阶段四十六：ENTER_FRAME 帧循环 + `getTimer` + FPS 计数器（目标 v0.3.47）

**背景**：用户在 `src/demo` 增加 `Fps.as`（Mr.doob 的 Stats 完整库），编译逐项报错。定位发现该库
依赖大量本子集未实现的高级 API（E4X XML 字面量、`StyleSheet`、`htmlText`、`Rectangle`、
`System.totalMemory`、`setTimeout`、`startDrag`、`BitmapData.scroll/fillRect/dispose` 等），
用户选择**重写简化版 Fps**（保留核心：帧计数 + TextField 显示）。重写后发现两个缺失前提：

1. **ENTER_FRAME 事件无派发机制**：事件循环只处理 `SDL_QUIT`/重绘/鼠标，`ENTER_FRAME` 仅注册了常量，
   没有任何派发点 —— 帧驱动逻辑（FPS 计数）无法运行。
2. **`getTimer` 未实现**：Fps 计时需要时间源；直接 `(int)as_now_ms()` 会把 Unix 毫秒时间戳（约 1.7e12）
   截断为 `INT_MAX`（2147483647），导致 `now - last` 恒为 0，FPS 永不更新（实测截图无文字）。

**实现**：

- [x] `Fps.as` 重写为简化版：保留 `frames` 计数 + `getTimer()` 计时 + 每秒写入 `text.text = "FPS: " + frames`，
      去掉 XML/StyleSheet/htmlText/Rectangle/System/BitmapData 滚动图等（`import flash.utils.getTimer` 保留，
      adl 与 as-aot 双兼容）
- [x] `getTimer` 内建：`runtime.ts` 新增 `as_getTimer()`（`as_now_ms() - as_start_ms`，返回**自进程启动以来**
      的毫秒数而非 Unix 时间戳，符合 AIR `flash.utils.getTimer(): int` 语义，不溢出）；`emit.ts` 的
      `emitGlobalCall` 加 `case 'getTimer'`
- [x] `window_glue.cc`：事件循环新增 `on_frame` 回调（`typedef void (*sk_frame_cb)(void)`），每次迭代（约 60Hz）
      调用一次，标记 dirty 触发重绘
- [x] `emit.ts`：新增 `Stage_dispatchFrame()`（注册为 Stage 方法）+ `as_frame_broadcast()` 深度优先广播
      `Event.ENTER_FRAME`（非冒泡，每个注册监听器的对象各得一次派发；事件对象跨对象复用零分配）；
      `ASC_window_on_frame` 回调桥接，`Stage_showWindow` 传入
- [x] `symbols.ts`：Stage 注册 `dispatchFrame()` 方法；`runtime.ts` 签名同步（ASC_USE_WINDOW 分支 + no-op 分支）

**关键坑**：
- `getTimer` 溢出：`as_now_ms()` 是 Unix 毫秒（double），直接转 `int` 溢出为 `INT_MAX`，`now-last` 恒 0。
  必须减去启动时间（相对时间）。
- `#else` 分支的 no-op stub 签名漏改（`as_skia_surface_show_window` 无 `on_frame`），导致纯 C 构建报
  「expected 11, have 12」。
- TS 模板字符串里 `\n` 会被解析成真实换行破坏 C 代码（诊断 fprintf 时踩坑），需写 `\\n`。

**验证**（Computer Use 真实窗口）：窗口左上角显示深蓝块内黄色文字 **`FPS: 43`**（60Hz 事件循环 + 每帧重绘，
实测约 43fps）；`trace` 确认每秒重置一次 `frames`（`frames=43 now=4054 last=3043` → 更新 text）。
`examples/frame.as` 断言 stage/子对象/孙对象深度优先广播，纯 C 通过。

**验收**：回归 55 passed / 0 failed（新增 `frame.as`）。

---

### 阶段四十七：`Stage.frameRate` 帧率控制 + `removeEventListener` 修复（目标 v0.3.48）

**背景**：用户在 `Main.as` 设 `stage.frameRate = 1000`，adl 下 FPS 能跑到 900+，而 native 实测仅约 45。
同时询问 `removeEventListener` 是否能真正销毁已注册的点击/滚动/ENTER_FRAME 监听器。两个问题逐一追根。

**问题 1：frameRate 不生效（硬编码 60Hz）**

- 根因：`window_glue.cc` 事件循环末尾硬编码 `SDL_Delay(16)`（约 60Hz），而 `Stage.frame_rate` 字段从未传给窗口层。
  无论 `frameRate` 设多少，都被 16ms tick 卡死（实测 43~45fps）。
- 修复：新增 `on_frame_delay` 回调（`typedef double (*sk_frame_delay_cb)(void)`），返回每帧睡眠毫秒
  （`1000/frameRate`）；`frameRate <= 0`（未设）回退历史 ~60Hz 默认。`emit.ts` 发射 `ASC_window_on_frame_delay`
  读 `ASC_win_stage->frame_rate`，`Stage_showWindow` 传入；`runtime.ts` 三处签名同步（extern + ASC_USE_WINDOW 分支 + no-op 分支）。
- 额外优化：`present_frame` 原先每帧 `SDL_CreateTextureFromSurface` + `SDL_DestroyTexture`（创建/销毁纹理是高频帧率下的
  主导开销），改为**流式纹理复用**（`SDL_TEXTUREACCESS_STREAMING` + `SDL_UpdateTexture` 原地更新，resize 时才重建）；
  renderer 从 `SDL_RENDERER_SOFTWARE` 改为优先 `SDL_RENDERER_ACCELERATED`（Metal），失败回退 software。
- 结果：FPS 从 45 → **280**（约 6 倍，真实窗口截屏确认）。离 adl 的 900+ 仍有差距，根因是架构差异：
  native 每帧全量 CPU 光栅化 2000×1360 像素 + SDL blit，而 AIR 是 GPU 合成 + **脏矩形**（FPS 场景只重绘
  90×20 的 TextField 小块）。「GPU Skia backend + 脏矩形 invalidate 管线」记为后续阶段，非 frameRate 本身缺陷。

**问题 2：removeEventListener 无法移除方法引用监听器**

- 根因：`this.method`（bare name 方法引用）每次求值都 `as_fn_make(...)` → `malloc` 一个新的 `as_closure` 指针。
  `addEventListener` 存入 P1，`removeEventListener` 再次求值生成 P2，旧实现比较 `P1 == P2` 永远不成立 → 移除失效。
- 修复：`emit.ts` 的 `EventDispatcher_removeEventListener` 改为比较**函数身份**（`a->fn == listener->fn && a->env == listener->env`），
  即「相同实现 + 相同绑定接收者」，符合 AS3 语义（顶层函数 env=NULL、方法 thunk env=this、闭包 env=捕获环境）。
- 验证：`examples/remove_listener.as` 断言顶层函数与 `this.bump` 绑定方法在 remove 后均不再触发，
  `hasEventListener` 同步变 false，纯 C 通过。

**验收**：回归 56 passed / 0 failed（新增 `remove_listener.as`）。

---

### 阶段四十八~四十九：动态类型核心（目标 v0.3.49 → v0.3.50）

**背景**：在 `examples/air-native/src/demo/TweenDemo.as` 导入 GreenSock `TweenLite` 做动画测试 demo，实测发现
TweenLite 全库重度依赖 AS3 动态类型核心（`Dictionary`、`typeof`、`delete`、`in`、`*` 无类型、多变量逗号声明、
动态类实例化、静态方法作为函数值、`Function.apply`、`arguments`、动态方法反射、cast 语法 `Type(expr)` 等），
此前编译器子集均未实现。经两阶段（v0.3.49 → v0.3.50）系统补齐，TweenLite 原样编译通过并跑通。

**落地特性**（`parser.ts` / `ast.ts` / `symbols.ts` / `emit.ts` / `runtime.ts` 全链路）：

| 特性 | 关键实现 |
|------|---------|
| `*` 无类型 → `any` | `parseType()` |
| 多变量逗号声明 `var a:T, b:T, c:*;` | `VarDecls` 平铺节点（AS3 `var` 是函数级作用域，不包 Block） |
| `Dictionary` | `as_dict` 对象引用键关联表 + `as_dict_*`；CType `dict`；`new Dictionary()`、`in`/`delete`/`for-in` |
| `typeof` / `delete` / `in` 运算符 | AST `Typeof`/`Delete`/`In` + `as_v_typeof`/`as_object_del`/`as_object_has` |
| 动态类实例化 `new (X as Class)()` | AST `NewDynamic` + `as_class`（vtable + factory）+ `as_v_as_class` |
| 静态方法作为函数值 | `staticMethodRefs` + `Class_method__call` thunk + `as_fn_make` |
| `Function.apply` / `arguments` | `as_fn_apply(_v)` + `emitArgumentsDecl`（`usesArguments*` 按需预扫描） |
| 动态方法调用（方法反射） | `as_method` 表 + `as_dyn_call`（沿 super 链查表）+ `Class_method__dyn` boxed thunk |
| 运行时字段反射 | `as_vtable_header` 加 `props`/`methods`；`as_prop` 表 + `as_dyn_get/set`（offsetof 偏移）；`Object`/`any` 动态索引读写 |
| cast 语法 `Type(expr)` | `emitCall` 识别单参 class/interface 类型名 → `convert` |
| `Array.sortOn` / `Array.concat`(any) | 按对象字段排序（NUMERIC/DESCENDING）+ concat 接受动态元素 |
| `is`/`as` 短名 FQN 解析 + any 真值判定 | `resolveType` + `as_v_is_inst` + `as_v_truthy` |

**验证**：`TweenDemo + TweenLite + TweenCore + SimpleTimeline + PropTween + TweenPlugin` 经 `--run` 编译成功、exit 0；
回归 56 passed / 0 failed；README 支持子集/类型映射/当前限制已同步；`test.ts` 将 `TweenDemo.as` 纳入 `SKIP_FILES`、
`com/org/net` 第三方库目录纳入 `SKIP_DIRS`（其依赖被排除的 com/greensock，需单独编译）。

### 阶段五十：ENTER_FRAME 广播语义修正 + TweenDemo 上屏（目标 v0.3.50 → v0.3.51）

**背景**：把 `TweenDemo` 集成进 `Main.as`（`stage.addChild(new TweenDemo())`）实测 Skia 窗口动画时发现动画不动。
根因：GreenSock 用私有静态 `Shape _shape` 监听 `Event.ENTER_FRAME` 驱动 `updateAll`，但 `_shape` 不在显示列表上，
而当时 `Stage_dispatchFrame` 是递归遍历显示列表广播，收不到它。

**修正**（AS3 语义保真）：AS3 的 `ENTER_FRAME` 是广播事件（broadcast），应派发给所有注册了监听器的对象（不限显示列表）：
- `emit.ts` 新增 `as_ef_objs` 全局注册表（按对象指针去重）+ `as_ef_register`/`as_ef_unregister`；
- `addEventListener`/`removeEventListener` 对 `"enterFrame"` 类型登记/注销（注销前检查该对象是否还有 enterFrame 监听器）；
- `Stage_dispatchFrame` 改为遍历全局注册表派发，删除原 `as_frame_broadcast`（递归显示列表）。

**验证**：`boot-gui`（窗口）+ `Main` + `TweenDemo` + GreenSock 核心经 `--run` 编译运行，输出
`TweenDemo: tween complete, box.x=650, box.y=300`——box 从 x=0 平滑位移到 650，证明补间真正驱动、
运行时字段反射写成功、`onComplete` 回调触发。回归 56 passed / 0 failed（`test.ts` 将 `TweenDemo.as` 移出
`SKIP_FILES`，air-native 单元经 `GREENSOCK_CORE` 显式纳入 GreenSock 核心 5 文件）。README 帧循环说明、
air-native 示例说明、版本号同步 v0.3.51。

### 阶段五十一：`setTimeout`/`clearTimeout` + `this.method` 函数值（目标 v0.3.51 → v0.3.52）

**背景**：用户把 `TweenDemo` 改成**递归循环动画**——构造器里 `setTimeout(onDone, 100)` 延迟启动，`onDone` 里
`TweenLite.to(box, 2, { ..., onComplete:this.onDone })` 让 tween 完成后再次回调自身。这暴露两个此前未覆盖的点：
`flash.utils.setTimeout`/`clearTimeout` 均未实现；`this.onDone`（显式 `this.method` 作为 Function 值）在 `emitMember`
里没有分支，而旧 demo 用的是裸标识符 `onDone`（走 `emitVar` 的 bound-method 分支）。

**修正**：
- `runtime.ts` 新增 `as_timer` 定时器池（`as_set_timeout`/`as_clear_timeout`/`as_timer_tick`）：`setTimeout` 以
  `as_now_ms()`（墙钟毫秒）为 deadline，返回 `uint` id；`clearTimeout` 标记 dead；`as_timer_tick` 按帧触发到期回调。
  回调前先拷贝 `fn`/`env` 并把槽位标记 dead，回调内重调度（`realloc` 迁移数组）或清除其它定时器都不会留下悬空指针。
- `emit.ts` `emitGlobalCall` 新增 `setTimeout`（closure 解箱为 `as_fn`，delay 转 double）与 `clearTimeout` 两分支；
  `Stage_dispatchFrame` 顶部先 `as_timer_tick()` 再广播 ENTER_FRAME（与 AIR 的帧时钟一致）。
- `emit.ts` 补齐 `this.method` 作为 Function 值：`walkExpr` 的 `Member` 分支对 `this.method` 登记 bound-method thunk；
  `emitMember` 在字段/getter 查找失败后回退到方法，发射 `as_fn_make(Class_method__bound, (void*)obj)`。

**验证**：`--air-app ... --target native` 编译通过（19 个 warning 均为 GreenSock 源码既有 `-Wparentheses-equality`
与 ease 公式 `-Wunsequenced`）。`--run` 输出多轮 `TweenDemo: tween complete`，box 坐标每轮随机变化
（`0,0` → `0.0078,89.44` → `755.6,311.88` → …），证明 `setTimeout` 延迟启动 + `this.onDone` 回调 + 递归循环动画全链路打通。
回归 56 passed / 0 failed。README 内建表、版本号同步 v0.3.52。

### 阶段五十二：`flash.system.System` 内存统计（目标 v0.3.52 → v0.3.53）✅ 已完成

**背景**：用户要在 `examples/air-native/src/demo/Fps.as` 里显示 `flash.system.System` 的内存统计，与 AIR/adl 行为对照。
依据 AIR SDK [`System`](https://airsdk.dev/reference/actionscript/3.0/flash/system/System.html) 官方参考，内存统计相关的是 4 个
**纯静态只读属性**（`System` 类 `final`、不可实例化、只含静态成员）。当前编译器**完全未建模** `System`（`symbols.ts` 无此符号、
运行时无内存统计），Fps.as 一用 `System.totalMemory` 就会在 `emitMember` 撞 `undefined variable 'System'`。

**AS3 语义 → C 运行时映射（关键，AGENTS.md §2.4 红线：差异必须显式处理并注释）**：

| AS3 属性 | 类型 | AIR 语义 | 本项目映射（无 AVM2 GC 堆，用运行时自管堆 + OS 进程内存对照） |
|---------|------|---------|----------------------------------------------------------------|
| `totalMemory` | `uint` | Flash Player/AIR **直接分配**的内存量（字节），超过 `uint.MAX_VALUE` 返回 0 | 运行时自管堆已用字节（arena 已用 + 散落 malloc 计数），clamp 到 `uint`（超 `UINT_MAX` 返回 0） |
| `totalMemoryNumber` | `Number` | 同上，但 `Number` 表达，允许更大值 | 同 `totalMemory` 但返回 `double`（不 clamp，允许 > 4 GiB） |
| `freeMemory` | `Number` | 分配给 Player/AIR **但未使用**的内存（GC 已向 OS 申请的空闲堆） | arena 段总容量 − 已用（bump 分配器的「已申请未用」缝隙） |
| `privateMemory` | `Number` | 应用**整个进程**的 resident private memory | OS 进程常驻内存：macOS `mach_task_basic_info.resident_size`（字节）；Linux `getrusage(RUSAGE_SELF).ru_maxrss`（**单位是 KB，须 ×1024**）；Windows `GetProcessMemoryInfo`→`WorkingSetSize`（字节）；WASI 退化为 `totalMemory` |

**实现要点**：

- [x] **运行时 arena 统计**（`runtime.ts`）：新增 `as_arena_used_bytes()` / `as_arena_cap_bytes()` 两个静态函数，
      遍历 `as_arena_head` 链表累加各段 `used` 与段容量（`AS_ARENA_SEG_CAP`，含超大 `malloc` 分配）；
      新增 `as_heap_bytes` 全局计数器（`size_t`，初始 0），在散落的持久分配点（`as_object_new`/`as_dict_new`/正则 `as_regex`/
      闭包 `as_closure` 等）`malloc`/`realloc` 处增减，覆盖「arena 之外的直接分配」
- [x] **内存统计运行时函数**（`runtime.ts`）：`as_system_total_memory()`（`uint`，`as_arena_used + as_heap_bytes`，超 `UINT_MAX` 返 0）、
      `as_system_total_memory_number()`（`double`）、`as_system_free_memory()`（`double`，`as_arena_cap − as_arena_used`）、
      `as_system_private_memory()`（`double`，条件编译四分支：`#ifdef __APPLE__` → `mach_task_basic_info.resident_size`（`<mach/mach.h>`）；
      `#elif defined(_WIN32)` → `GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)).WorkingSetSize`（`<windows.h>`+`<psapi.h>`，链接 `-lpsapi`，
      或 `K32GetProcessMemoryInfo` 免额外链接；备选 `PROCESS_MEMORY_COUNTERS_EX.WorkingSetPrivateSize` 更贴近「私有常驻」）；
      `#elif defined(__wasi__)` → 退化为 `as_system_total_memory_number()`；
      `#else`（Linux/其余 POSIX）→ `getrusage(RUSAGE_SELF).ru_maxrss`，**Linux 下单位是 KB 须 ×1024**（`<sys/resource.h>`））
      > 注：Windows 分支可照此写，但开发机是 macOS、且 runtime 另有 `gettimeofday` 等 POSIX 耦合尚未 Windows 验证，
      > 故本阶段「写出 + 不破坏 macOS/Linux」为目标，Windows 真实可编译属另一个层面，不阻塞本阶段验收。
- [x] **编译器建模**（`emit.ts` + `symbols.ts`）：参照 `Math.PI`/`Array.NUMERIC`/`Number.MAX_VALUE` 的「纯静态只读」范式，
      在 `emitMember` 加 `System` 特判分支（`expr.object.kind === 'Var' && expr.object.name === 'System'`），4 个属性映射到上述运行时调用；
      `System` 不注册为可实例化 ClassInfo（避免 `new System()` 误用），可选在 `typeAlias` 登记 `System → System` 使类型标注不报 unknown
- [x] **Fps.as 显示内存**：`update` 每秒刷新时追加 `System.totalMemory`/`System.privateMemory`（及 freeMemory）到 `text.text`，
      与现有 `FPS: N` 并排或多行展示；保留 `import flash.system.System` 使 adl 与 as-aot 双兼容
- [x] **回归 + 文档**：新增 `examples/stage52.as` 断言 4 个属性可读、`totalMemory >= 0`、`freeMemory >= 0`、
      `privateMemory > 0`（native 下）、`totalMemoryNumber >= totalMemory`（clamp 边界）；README 内建表/类型映射/限制同步；
      版本号 v0.3.52 → v0.3.53

> **语义边界（README 需如实注明）**：本项目无 AVM2 GC 堆，`totalMemory`/`freeMemory` 是「运行时自管堆」的对照近似，
> 数值量级与 AIR 不可直接相等，只保证「随分配增长、随释放波动」的**趋势**一致；`privateMemory` 是真实进程 RSS，
> 可与 Activity Monitor 对照。`poisonStrings`/`ime`/`containsDebugInfo`/`useCodePage` 等非内存统计属性不在本阶段范围。

**验收**：`--air-app` 窗口运行 Fps 面板显示 FPS + 内存值，内存随动画逐帧波动；
`examples/stage52.as` 纯 C 断言 4 属性可读且范围合理；回归 57 passed / 0 failed。

### 帧率 pacing 修正：固定 sleep → deadline 语义（不升版本号）

**背景**：用户在 `Main.as` 设 `stage.frameRate = 120`，adl 能跑满帧率动画更流畅，而 native 实测 Fps 面板最多只能到 ~80。

**根因**：`window_glue.cc` 事件循环用 `SDL_Delay(delay)` **每帧固定睡完整 delay**（阶段四十七的旧写法），
而渲染耗时（Skia 全量 CPU 光栅化 + `SDL_UpdateTexture` + `SDL_RenderPresent`）被**叠加**在 delay 之上，
实际帧率 = `1000/(render + delay)` 而非 `1000/delay`。120Hz 目标（delay = 8.33ms）叠加约 4ms 渲染 → 12.3ms/帧 ≈ 81fps。

**修复**（`vendor/window_glue.cc`）：把「每帧睡固定时长」改为「**睡到滚动 deadline**」——
`next_tick += interval` 累积目标时刻，每帧只睡到 `next_tick` 的差值，渲染时间被吸收进 interval；
新增 catch-up guard（渲染慢于目标速率时快进 deadline，避免累积赤字）；`interval <= 0` 时全速 busy-loop（等价 adl 高帧率）。

**验证**：临时在 `Fps.as` 加 `trace("FPS:" + frames)` 抓取窗口输出，帧率从 ~80 提升到 **120（满帧）**，
稳定多轮（首秒 102 为窗口初始化抖动，其后 120/120/120/114/120）；验证后已移除临时 trace。
该修复不改 AS3 语义、不改生成 C，故不升版本号，只记录于此。

### 跨显示器帧率锁定 + 缩放值不一致修复：关闭 vsync + resize 重算设备倍率（不升版本号）

**背景**：用户把窗口从 Mac 主屏（120Hz）拖到外接扩展显示器（50Hz）后：① FPS 从 120 掉到 50（被显示器刷新率锁定）；
② Skia 舞台缩放值不响应、画面变大（不同显示器缩放值不一致时，倍率没有跟过去）。而 adl 调试应用帧率不随显示器变化、
分辨率也始终正确。

**根因 1（帧率锁定）**：`window_glue.cc` 用 `SDL_RENDERER_ACCELERATED`（Metal）渲染器，`SDL_RenderPresent` 默认开启
vsync，会阻塞到显示器下一个刷新周期——50Hz 屏每帧至少 20ms，把 deadline pacing 的 120Hz 目标（8.33ms）拖死到 50fps。
主屏 120Hz 恰好与目标一致所以看不出，外接 50Hz 立即暴露。

**修复 1**（`vendor/window_glue.cc`）：创建渲染器后调 `SDL_RenderSetVSync(ren, 0)` 关闭垂直同步，让 `SDL_RenderPresent`
立即返回，帧率完全交给事件循环的 deadline pacing（阶段 pacing 修正已落地）——与 adl 一致，不随显示器刷新率锁定。
代价是可能撕裂，但这是对齐 adl 行为，且 `SDL_RenderSetVSync` 自 SDL 2.0.18 存在（本项目 pin 2.32）。

**根因 2（缩放值不一致）**：`ASC_win_scale`（device pixel ratio）只在 `Stage_showWindow` 里 probe 一次主屏倍率并固定；
窗口拖到不同 DPI 显示器时，`do_resize` 检测到 drawable 尺寸变化会重建 surface 的物理像素尺寸，但 `ASC_win_scale` 仍保留旧值，
`ASC_window_render` 里的 `as_skia_canvas_scale(canvas, ASC_win_scale, ASC_win_scale)` 继续按旧倍率缩放 → 内容被画大/裁切。

**修复 2**（`src/emit.ts`）：`ASC_window_on_resize` 里新增 `double rs = (lw > 0) ? (double)pw / (double)lw : 1.0;`，
用「物理/逻辑」重算设备倍率并写回 `ASC_win_scale` 与 `stage->stage_scale`；同时 `live_resize_watch` 过滤器补 `MOVED`/`DISPLAY_CHANGED`
两个窗口事件（macOS 拖动跨屏时主循环可能被 Cocoa tracking loop 阻塞，靠过滤器在拖拽期间也能重建）。

**验证**：clang++ 重编译零错误；`--air-app` 重新编链成功；全量回归 72 passed / 0 failed。跨屏拖动的帧率/缩放是否正确需用户实测。
该修复改生成 C（emit.ts 的 resize 回调）但仅为后端 bug 修正、不改 AS3 语义，故不升版本号，只记录于此。

### 跨显示器帧率/缩放修复 v2：恢复 VSync + 跟随显示器刷新率 + 权威物理像素 API（不升版本号）

**背景**：上一轮「关闭 vsync」修复后，用户实测扩展屏（50Hz）帧率仍无法保持 120fps、浮动很大、动画卡顿；但**开启 VSync 锁 50fps 反而流畅**。这直接推翻了「关 VSync 追 120fps」的方向，也暴露了上一轮两处隐患。

**关键判断**：50Hz 屏物理上限就是 50fps 呈现，不存在「120fps 呈现」。adl 的「fps 不随显示器降」是**逻辑帧率**（ENTER_FRAME 派发计数），靠 delta time 让动画速度不变。真正的卡顿根因是**拍频（beat）**：关 VSync + 120Hz deadline 时 `SDL_RenderPresent` 立即返回，CPU 按 8.33ms 跑但显示器 50Hz 只收 50 次/秒 → 120 vs 50 拍频，帧间隔在 8ms↔20ms 剧烈抖动 → delta time 忽大忽小 → 卡顿。开 VSync 则 `SDL_RenderPresent` 阻塞到 50Hz 刷新，帧间隔均匀 20ms → 流畅。

**修复 1（恢复 VSync）**：`vendor/window_glue.cc` `SDL_RenderSetVSync(ren, 0)` → `SDL_RenderSetVSync(ren, 1)`，让帧率跟随显示器刷新率（50Hz→50fps、120Hz→120fps、跨屏自动适配）。

**修复 2（刷新率跟随窗口所在显示器）**：新增全局 `g_win` 指针，`sk_window_get_display_refresh()` 改用 `SDL_GetWindowDisplayIndex` 实时读**窗口当前所在显示器**的刷新率（原写死 `SDL_GetCurrentDisplayMode(0,...)` 永远是主屏）。

**修复 3（帧率 deadline 封顶到刷新率）**：`src/emit.ts` `ASC_window_on_frame_delay` 中显式 `frameRate` 高于显示器刷新率时封顶到刷新率，避免 120Hz 目标在 50Hz 屏产生拍频。

**修复 4（权威物理像素 + 0 值防护）**：`SDL_GL_GetDrawableSize` 在 Metal 渲染器下不可靠，统一换成 `SDL_GetWindowSizeInPixels`（SDL 2.26+，pin 2.32），初始 probe 与 resize 两处一致；`sk_resize_cb` 签名新增 `double scale` 参数，由 glue 层算倍率（正是 `contentsScaleFactor` 语义）下传，AS3 侧不再用可能过期的 `pw/lw` 重新推导；`do_resize` 与 `ASC_window_on_resize` 任一尺寸 ≤0 时跳过本次 resize，杜绝跨屏过渡态把 `stageWidth` 归零。

**验证**：`--air-app` 重新编链成功（`window_glue.cc` + `air-native.c` 均通过）；全量回归 72 passed / 0 failed。用户双屏实测确认流畅（主屏 120fps、扩展屏 50fps 帧间隔均匀）。该修复仅为后端 bug 修正、不改 AS3 语义，故不升版本号，只记录于此。

### 窗口拖动 resize 变形 + 动画暂停修复：macOS live-resize 阻塞事件循环（不升版本号）

**背景**：用户拖动窗口边缘调整大小时，Skia 视图变形（内容被拉伸），且**按住拖动期间动画也暂停**，松开鼠标才恢复正常。

**根因（真正的根因）**：`SDL_PollEvent` 在 macOS **live-resize 期间会阻塞到松手**——Cocoa 进入自己的 tracking loop，
主循环停摆：既不重建 surface（→ 旧位图被拉伸变形），也不推进帧（→ 动画暂停）。官方 wiki
[AppFreezeDuringDrag](https://wiki.libsdl.org/AppFreezeDuringDrag) 明确此行为。此前误判为「事件被合并/延迟」，
改用每帧轮询 `do_resize` 无效——因为主循环根本没在跑（用户反馈「并没有修复，按住后动画也暂停」）。

**修复**（`vendor/window_glue.cc`）：改用 SDL 官方指出的 **event filter（`SDL_AddEventWatch`）**——这是阻塞期间
SDL 仍会调用的唯一钩子（Kivy #6186 同款方案）。把窗口渲染状态集中到 `WinCtx`，新增 `live_resize_watch` 过滤器：
检测到 `SIZE_CHANGED`/`RESIZED`/`EXPOSED` 时重建 surface + 推一帧（`on_frame` + `on_redraw` + `present_frame`），
`in_watch` 标志防重入；主循环每帧 `do_resize` 降级为兜底。

**验证**：clang++ -std=c++17 编译零警告；窗口运行 smoke test 动画递归循环正常（`Cubic.easeInOut` 生效、
多轮 `TweenDemo: tween complete`、坐标随机变化）、无崩溃。变形与动画是否真正消除需用户手动拖动实测。
该修复不改 AS3 语义、不改生成 C，故不升版本号，只记录于此。

### 加入 GreenSock easing（Quad/Cubic）到 air-app 收集（不升版本号）

**背景**：用户给 `TweenDemo.as` 引入 `Cubic.easeInOut`（`import com.greensock.easing.Cubic` / `Quad`），编译报
`undefined variable 'Cubic'`。

**修复**（`src/air-app.ts`）：`GREEN_SOCK_CORE` 追加 `com/greensock/easing/Quad.as` 与 `com/greensock/easing/Cubic.as`
（均为纯静态方法类、无 BOM）。easing 公式（`t/=d`/`--t` 等）翻译到 C 同样触发 `-Wunsequenced`，与遗留的 ease UB 同源。不升版本号。

### 阶段五十三：ease 公式赋值表达式序列点修复（目标 v0.3.53 → v0.3.54）✅ 已完成

**背景**：遗留的 ease UB——GreenSock 缓动公式（`Cubic`/`Quad` 及 TweenLite 默认 ease）里
`c*(t/=d)*t*t`、`1-(t=1-t/d)*t`、`--t` 等把自修改赋值嵌在更大的算术表达式里。AS3 规定操作数**严格从左到右且完全定序**（先 `t/=d` 再读新 `t`）；C 却让 `*`/`+` 的操作数求值顺序**未定序**，于是「写 `t`」与「读 `t`」在兄弟操作数里竞争，触发 clang `-Wunsequenced`（真 UB）。此前 clang -O2 下求值碰巧正确（box.x 落到 650），但跨平台/跨优化级别结果不保证。

**修复**（`src/emit.ts`，编译期语义层，纯生成 C、不动运行时）：

- 新增 `sequenceValueExpr(expr, valueCtx, guaranteed)`：在 AS3 求值序上递归遍历表达式，把「对简单局部/形参变量的自修改赋值」
  （`x op= y`、`x = y`、`++x`/`x++`/`--x`/`x--`）提升成**独立前导语句**，值捕获进临时变量 `_seqN`，再把原节点替换为临时变量。
  例：`c*(t/=d)*t*t + b` → `double _seq0 = (t = (t/d)); return c*_seq0*t*t + b;`——写 `t` 与后续所有读 `t` 之间插入序列点。
- 新增字段 `hoistedAssigns: Map<Expr, {tmp, type}>`；`emitAssign` / `emitExpr` 的 `Update` 分支顶部查表替换为临时变量。
- 在 `emitStmt` 的 `Return`/`If`/`ExprStmt`/`VarDecl`/`VarDecls`/`ConstDecl`/`Switch` 处先调 `sequenceValueExpr` 再发射。
- **语义边界（正确性红线，AGENTS.md §2.4）**：不提升「可能不执行」位置的自修改赋值——短路 `&&`/`||` 右操作数、`?:` 分支、
  嵌套 `FunctionExpr`、以及 `while`/`for` 循环条件（会被重复求值）一律**保持原样**，避免无条件前导改变语义。
  嵌套赋值链（如 `_hasUpdate = this.initted = this.active = _notifyPluginsOfEnabled = false`）只提升最内层「简单变量」目标，
  其余 `Member` 目标链留在独立的（自身无 UB 的）赋值语句里，顺序与 AS3 一致。

**验证**：`TweenDemo + TweenLite + TweenCore + SimpleTimeline + PropTween + TweenPlugin + Quad + Cubic` 经 `--dry` 与
完整编译链接通过，`-Wunsequenced` **归零**（剩余 12 个 warning 均为 GreenSock 源码既有 `-Wparentheses-equality` 双括号）。
生成的 `Quad_ease*`/`Cubic_ease*`/默认 `easeOut` 全部改为 `_seqN` 前导形式，逐条核对与 AS3 左到右语义等价。
回归 `test.ts` 57 passed / 0 failed（`test.ts` 的 `GREENSOCK_CORE` 补上 `easing/Quad.as`/`Cubic.as`，与 `air-app.ts` 对齐）。
版本号 v0.3.53 → v0.3.54。

### 阶段五十四：`typeof` 区分 Function 值（目标 v0.3.54 → v0.3.55）✅ 已完成

**背景**：用户反馈「aot 的 ease:Cubic.easeInOut 并没有缓动效果」。排查发现缓动公式数值本身正确（阶段五十三已验证），
问题出在 TweenLite.init() 的 ease 选择被 `typeof` 判断拦截：

```as3
if (typeof(this.vars.ease) == "function") { _ease = this.vars.ease; }
```

Function 值此前 box 成 `as_v_obj`（tag 4，object），`as_v_typeof` 对 tag 4 恒返回 `"object"`，无任何 tag 返回 `"function"`，
导致该判断恒 false，`_ease` 一直停留在构造器设的 `defaultEase`（`TweenLite.easeOut`，仅 easeOut 无 easeIn），
用户传入的 `Cubic.easeInOut` 被静默忽略——表现就是「没有缓动效果」。

**修复**：为 Function 值引入独立运行时 tag 7，与 object（tag 4）区分：

- `runtime.ts`：新增 `as_v_fn`（tag 7）；`as_v_typeof` 加 `case 7: return "function"`；`as_v_str_val` 加 `case 7: return "[Function]"`；
  `as_v_eq` 的引用比较分支纳入 tag 7；`as_fn_apply_v`/`as_fn_call_dyn` 的 box tag 检查由 4 改为 7（它们只接收 emit 侧 boxExpr 产出的 function box）。
- `emit.ts`：`boxExpr` 的 `function` 分支由 `as_v_obj` 改为 `as_v_fn`。

**验证**：新增 `examples/stage54.as` 断言式回归（7 条全 `true`）：`typeof(fn) == "function"`、`typeof(obj) == "object"`、
Function 值间接调用数值正确（`Cubic.easeInOut` 中点 325 / 终点 650）、Function 值存入 Object 再取出后 typeof 仍为 function 且可调用。
端到端：TweenDemo 临时加 `onUpdate` 抓取 box.x 中间值，呈现标准 Cubic.easeInOut S 型曲线（起始段 0.0002→0.004 慢启动、
中段 228→608 加速、末段 990→999.99 慢收尾），验证后恢复 TweenDemo 原样。
回归 `test.ts` 59 passed / 0 failed。版本号 v0.3.54 → v0.3.55。

### 阶段五十五：修复 `as_v_truthy` 遗漏 tag 7（目标 v0.3.55 → v0.3.56）✅ 已完成

**背景**：用户反馈「仅看到输出一次 `TweenDemo: tween complete, box.x=0, box.y=0` 没有循环调用」。
排查发现递归循环断裂，链路上定位到 `TweenCore.render()` 的 onComplete 触发判断：

```as3
if (this.vars.onComplete && this.cachedTotalTime == this.cachedTotalDuration && !this.cachedReversed) {
    this.vars.onComplete.apply(null, this.vars.onCompleteParams);
}
```

阶段五十四把 Function 值从 tag 4 改为独立 tag 7，但 **`as_v_truthy` 的 switch 漏了 tag 7 分支**，
落到 `default: return false`。于是 `this.vars.onComplete`（tag 7 的 Function 值）在真值判断里被判为 false，
整个 `&&` 条件短路，`onComplete.apply(...)` 永不执行——递归动画只跑首轮就停。

**修复**：`runtime.ts` 的 `as_v_truthy` 增加 `case 7: return v.ptr != NULL;`（非空 Function 为真值，与 object/array 一致）。

**验证**：端到端 `--run` 输出多轮 `TweenDemo: tween complete`（box 坐标每轮随机跳变，递归循环恢复）：

```
TweenDemo: tween complete, box.x=0, box.y=0
TweenDemo: tween complete, box.x=0.0078..., box.y=89.44...
TweenDemo: tween complete, box.x=755.6..., box.y=311.88...
TweenDemo: tween complete, box.x=532.7..., box.y=148.89...
```

回归 `test.ts` 59 passed / 0 failed。版本号 v0.3.55 → v0.3.56。

### 阶段五十六：事件分发每帧内存泄露修复（目标 v0.3.56 → v0.3.57）✅ 已完成

**背景**：用户长时间（10 小时）运行 air-native 动画 demo，`System.totalMemory` 从 0 涨到 700+ MB，而 adl 同时跑无泄露。实测泄露速率 **~39 KB/s**（约 1.4 GB/10h）。

**定位**（return-address 采样 `dladdr` + arena/heap 分解）：99% 泄露在 arena（`as_alloc`），非 heap；采样显示 100% 命中 `EventDispatcher_dispatchEvent`，两个根因：

1. `as_disp_key(type, capture)` 每次调用都 `as_alloc(strlen(type)+5)` 构造临时查找 key（`"enterFrame#cap"`），用于 `as_object_get` 的 strcmp 查找——**纯查找、用完即弃，却进永不回收的 arena**；每帧 ENTER_FRAME 分发时对每个祖先/目标多次调用。
2. `dispatchEvent` 每帧 `as_array_new()` + `as_array_push()` 建 ancestors 祖先链临时数组，同样 arena 分配、永不回收。

**修复**（`src/emit.ts`）：
- 新增 `as_listeners_get(listeners, type, capture)`：在调用者提供的 64 字节栈缓冲里构造 key 再 `as_object_get`；所有**查找**路径（`as_disp_phase`/`as_disp_target`/`as_ef_unregister`/`removeEventListener`/`hasEventListener`）改用栈缓冲；`as_disp_key`（arena 持久 key）只保留给 `addEventListener`（它把 key 存进 listeners 表，需持久）。
- `dispatchEvent` 的祖先链改用固定栈数组 `void* ancestors[64]` + `anc_count`（显示树深度远小于 64），消除 `as_array_new`/`as_array_push`。

**结果**：泄露从 **39 KB/s → 0.85 KB/s**（降低约 96%，10h 从 1.4 GB 降到约 30 MB）。回归 59 passed / 0 failed。

**剩余 0.85 KB/s 的性质**（诚实边界）：不是编译器每帧临时分配，而是「无 GC」的语言语义——动画每轮 `new TweenLite` + vars 字面量 + PropTween（`malloc`，~300 B/s）+ 用户代码字符串拼接（`Fps` 每秒 `text.text`、`TweenDemo` 每轮 `trace`，arena，~550 B/s）。AS3 靠 GC 回收这些，AOT 无 GC，故仍缓慢增长。彻底清零需实现 GC 或对象池，见遗留。

版本号 v0.3.56 → v0.3.57。

### 下一阶段路线图：flash.* / air.* 标准库映射类（按紧急程度立项，待开发）

> 背景：当前编译器只为 GreenSock demo 映射了 `flash.events`/`flash.display`/`flash.text`/`flash.utils`/
> `flash.system` 的最小交集（`symbols.ts` 约 25 个类）。完整 AS3/Flash/AIR API 是**几百个类**，需按依赖广度、
> 语义差异、demo 演进路径分级推进。立项依据 [airsdk.dev 官方参考](https://airsdk.dev/reference/actionscript/3.0/)
> 的类间依赖（`See also`/`Methods ... use Point objects` 等）与 AGENTS.md §2.4 语义红线。
> 每类落地必须过 DoD：AST/parser/codegen 三处齐全 + 差异显式注释 + `examples/*.as` 断言回归 + README 同步 + 版本递增。

**紧急度总览（P0 最高 → P3 最低）**：

| 优先级 | 阶段 | 命名空间/类 | 理由（依赖广度 / 语义） |
|---|---|---|---|
| **P0（GC-1/2/3/4 全部完成）** | 五十七 | **自研精确 GC（Mark-Sweep + Shadow Stack）** | WASI 纳入后 Boehm 保守式栈扫描失效；项目已具备精确 GC 枚举基础（tag/prop 反射表/method 表）；GC-1 清零对象/数组/闭包/类实例、GC-2 清零字符串（0.85KB/s 大头）、GC-4 增量标记消除停顿、GC-3 native+wasm 双目标零泄漏零悬空验证通过（⚠️ 起初只能用**异常机制被 `-O2` 消去**的示例复现；带 `try/catch` 的程序 WASI 链接失败，**已于阶段八十九·三十五修复并解除该限定**） |
| **P0** | 五十八 ✅ | `flash.geom` 2D（Point/Rectangle/Matrix/ColorTransform/Transform） | 纯值类型、被 DisplayObject/Graphics/BitmapData/Matrix 几乎所有显示与几何类使用；语义简单（数值运算）风险低 |
| **P0** | 五十九 ✅ | `flash.events` 事件类补齐（TimerEvent/ProgressEvent/IOErrorEvent/ErrorEvent/DataEvent） | 纯常量类 + 少量字段；TimerEvent 被 Timer 依赖、ProgressEvent 被 Loader/URLLoader 依赖，是后续前置 |
| **P1** | 六十 ✅ | `flash.utils.Timer` | 重复定时器是真实应用基础设施；`setTimeout` 的自然升级；依赖阶段五十九的 TimerEvent |
| **P2** | 六十一 ✅ | `flash.filters`（BitmapFilter/BlurFilter/DropShadowFilter/GlowFilter） | 渲染级重活，依赖 Skia 滤镜 + `DisplayObject.filters` + `BitmapData.applyFilter`；语义差异大（cacheAsBitmap/缩放规则） |
| **P2** | 六十二 ✅ | `flash.display` 补齐（Loader/LoaderInfo/MovieClip/SimpleButton） | Loader 依赖 net.URLLoader、MovieClip 依赖帧动画，均重活 |
| **P3** | 六十三 ✅ | `flash.net`/`flash.media`/`flash.ui`（URLLoader/URLRequest/Socket/Sound/Video/Keyboard/Mouse） | 异步 + 外部资源/设备，重活且独立 |
| **P3** | 六十四 ✅ | `air.*`（Window/File/FileStream/NativeWindow/SQLConnection） | 最大命名空间，完全独立于 Flash 运行时 |
| **P1** | 六十五 ✅ | `flash.system.Capabilities`（version/os/cpuArchitecture/… 环境能力查询） | 纯静态只读类，与 `System` 同范式；`version` 编译期注入 package.json 版本，os/cpu 走条件编译，屏幕/locale 走轻量平台探测 |
| **P1** | 六十六 ✅ | `Vector.<T>` 高阶/序列方法（slice/concat/splice/forEach/map/filter/sort/reverse）+ 字面量 `new <T>[...]` + 闭包 env/`as_vector` 迁 GC | 补齐 Vector 与 Array 方法对等、GC 遗留 malloc 收尾；回调复用 as_value 装箱/解箱路径 |
| **P1** | 六十七 ✅ | 三子系统 deferred 收尾（动态类建模/异步事件调度/`DisplayObject.transform` 接线） | 动态类机制落地 `URLVariables`；无网络后端用 `setTimeout(0)` 模拟异步 IO；`transform` 接线到 Skia canvas |
| **P1** | 六十八 ✅ | 增量重绘自动 `cacheAsBitmap`（渲染层指纹 dirty 检测 + 静止子树自动烘焙） | 对齐 adl 性能（native 单线程全量重绘 CPU 占用为 adl 3 倍）；`DisplayObject` 变换字段直接写无法拦截，改渲染入口每帧递归指纹，静止子树自动烘焙跳过 Skia 命令生成 |

---

#### 阶段五十七：自研精确 GC（Mark-Sweep + Shadow Stack，目标 v0.3.57 → v0.3.58）【P0 — GC-1/2/3/4 全部完成】

**依据**：WASI 纳入目标后，Boehm bdwgc 等保守式 GC **直接出局**——其核心机制是扫描 C 调用栈找「像指针」的根，
但 WebAssembly 的调用栈在虚拟机管理的独立内存、不在线性内存里，C 代码扫不到。而**精确 GC 的根集合是显式登记的**
（不依赖栈扫描），在 native 与 WASI 上行为完全一致，是唯一可行路径。完整技术论证、数据结构设计、风险与四阶段拆解
见 [`docs/zh-cn/gc.md`](docs/zh-cn/gc.md)。该文档已从「选型论证」补全至「消除停顿的完整技术路线」：
GC-4 增量标记的完整落地设计（三色状态机 + 显式灰栈 + Dijkstra 写屏障 + 编译器注入清单）集中在 gc.md §6，实现时直接对照落地。

**项目已具备的精确 GC 枚举基础**（大幅降低自研门槛）：
- `as_value` 干净 `tag + num + ptr`（tag 3/4/6/7 精确指示 ptr 是否指针）→ 精确标记，不是猜
- `as_prop` 反射表 `{name, type, offset}`（type 1~7 精确枚举字段类型）→ 精确遍历对象图
- vtable super 链 + props/methods 表 → 沿继承链 mark 父类字段
- 内建结构布局已知（as_array/as_object/as_dict/as_closure 的指针字段写死在代码里）

**缺三样（自研完整工作量）**：
1. GC 堆 + Mark-Sweep 核心（统一 header、分配、mark 遍历、sweep、触发时机）；`gc_header` 从 GC-1 起就用 **`color` 三色位域**（0 白 / 1 灰 / 2 黑，非 1-bit `marked`）并预留显式灰栈 `gc_inc`，避免 GC-4 增量标记回改底层结构
2. 根集合 = Shadow Stack（编译器给每个生成函数登记「可能持指针的局部变量/形参/临时值」）—— **最大工作量 + 最大风险**
3. 迁移分配点（arena 的 array/closure/string + malloc 的 object/dict/类实例统一挂 GC 分配器）

**核心风险（比泄漏更危险）**：Shadow Stack **漏登记一个根 → 对象被过早回收 → 悬空指针 → 随机崩溃**。
泄漏只是慢慢涨，悬空指针是随机崩溃。必须穷尽所有「可能持指针」的局部变量/形参/临时值。

**四阶段拆解**：

| 子阶段 | 目标 | 纳入回收的对象 |
|---|---|---|
| **GC-1** | GC 堆 + Mark-Sweep，**native 先跑通** ✅ 已完成 | array / object(record) / dict / closure / 用户类实例 |
| **GC-2** | 字符串纳入 GC ✅ 已完成 | 彻底解决 `trace`/`text.text` 的 arena 字符串泄漏（阶段五十六残留 0.85KB/s 大头） |
| **GC-3** | WASI 目标验证 + 长时间运行回归 ✅ 已完成 | 证明双目标下零泄漏、零悬空（native + wasm32-wasip1）。阶段八十九·三十一起验收只能用**异常机制被 `-O2` 消去**的示例复现（带 `try/catch` 的程序因 sysroot 缺 `__wasm_setjmp`/`__c_longjmp` 而链接失败）；**该限定已于阶段八十九·三十五解除**——EH 链接修复后，本轮把四例（含 `try/catch` 可达的 `stage57.as`）全部复跑：`gc_strings`/`gc_barrier` 输出与 native **逐字节相同**，`gc_incremental` 仅原始堆计数不同（`bounded= true reclaimed= true` 断言一致），见 `temp/wasi-eh/check.sh` |
| **GC-4** | **增量标记（三色 + Dijkstra 写屏障）** ✅ 已完成 | 把 mark 分摊到多帧，停顿从 O(堆) 降到 O(budget)，消除 GC 卡顿 |

**GC-1~GC-4 已完成的落地形态（v0.3.58）**：

- **触发点 = 帧边界安全点**，而非 shadow stack：`Stage_dispatchFrame` 开头（所有帧回调已返回）
  调用 `gc_step()`（GC-4 起增量推进），与 `System.gc()` 手动触发调用 `gc_collect()`（停机回收）。安全点触发时
  活跃 C 栈只剩 `main`→事件循环，帧回调的局部变量都已出栈，因此**根集合 = 永久根**（静态字段、模块变量、
  `ASC_win_stage`、ENTER_FRAME 事件注册表、定时器）+ 内建根（`as_exception`），MVP 无需 shadow stack（gc.md 同样承认此点）。
- **GC 堆 = 外置 header + 分段堆（1 MiB/段）+ free-list**（first-fit + 切分 + 合扇）；每个对象前带 `gc_header`
  （free-list 链 + `gc_all` 活对象链 + 大小 + 类型标记 `GCT_*` + `color` 三色位域 + 灰栈 `gc_inc`）。
- **标记分派（GC-4 起非递归 `gc_scan`）**：按 `GCT` 类型分派（STRING→叶、ARRAY→data/input、OBJECT→keys/vals、
  DICT→keys/vals、CLOSURE→env、CLASS→vtable→props 反射表沿 super 链，tag 3/6/7 → `gc_mark_ptr`/`gc_mark_value`）；
  非堆指针（字符串字面量、静态 vtable）由 `gc_in_heap()` 段表地址范围检查安全跳过。
- **迁移分配点**：`as_array_*`/`as_fn_make`/`as_object_*`/`as_dict_*`/`as_str_*` 的 `as_alloc`/`malloc` → `gc_alloc`；
  emit 里所有 `(Type*)malloc(sizeof(Type))` 类实例 factory → `gc_alloc(GCT_CLASS, ...)`；字符串 GC-2 起走
  `as_str_alloc()`（`gc_alloc(GCT_STRING, n)`）。仅剩字节缓冲（`ByteArray` grow/compress/uncompress、`BitmapData.pixels`）
  （闭包 env 与 `as_vector` 已于 v0.3.69 迁入 GC，见阶段六十六）。
- **GC-4 增量标记**：`gc_inc` 三色状态机（IDLE/MARK/SWEEP）+ 显式灰栈（`grey`/`grey_top`/`grey_cap`，非递归）+ 每帧预算
  `gc_inc.budget=500`；`gc_step()` 每帧推进固定预算的 mark/sweep 切片，单帧停顿 O(budget)。Dijkstra 写屏障
  `gc_write_barrier`/`gc_write_barrier_value`（仅 MARK 期生效，灰化白引用）注入点：setter（`as_array_set`/`as_array_push`/
  `as_array_unshift`/`as_object_set`/`as_dict_set`/`as_dyn_set`）、运行时构造器（Error/RegExp/Event/TextFormat/Bitmap/Mouse/Focus）
  与用户直接字段写（`o.field = v`，emitAssign 底部分支用逗号表达式附加屏障）。MARK/SWEEP 期新对象分配走 `gc_new` 侧链表
  （初始 BLACK，防误收；sweep 稳定游标），周期末 `gc_finish_cycle` 归位 + 复位 WHITE；`gc_collect()` 停机回收前先把 `gc_new`
  并回 `gc_all` 并整体复位 WHITE，从根重标，确保从任意增量状态调 `System.gc()` 都得到一致结果。
- **永久根生成**：emit 新增 `gc_mark_user_roots()`（`emitGCRoots`），按 CType.kind 区分 `gc_mark_ptr`/`gc_mark_value`；
  接口为引用结构体，mark 其 `.obj` 字段而非结构体本身。
- **验收结果**：`examples/stage57.as`（GC-1）50000 个临时 record+array 分配 25.6 MiB 后 `System.gc()` 回收归零；
  `examples/gc_strings.as`（GC-2）100000 次字符串拼接回收归零；`examples/gc_incremental.as`（GC-4）800 帧每帧分配临时
  对象内存有界不线性增长；`examples/gc_barrier.as`（GC-4）10200 个类实例直接字段写后 `System.gc()` 对象图完整无悬空；
  air-native 窗口 demo（含 GreenSock 直接字段写）回归无破坏；回归 63 passed / 0 failed。GC-3 双目标回归：`stage57.as`/`gc_strings.as`/
  `gc_incremental.as`/`gc_barrier.as` 四例在 native 与 wasm32-wasip1（WASI SDK 34.0 + wasmtime 48.0.2）下结果一致，
  `reclaimed most`/`bounded`/`intact` 断言全过。（该结论最初受阶段八十九·三十一实测限定：只能在**异常机制被 `-O2` 消去**的示例上复现。
  **阶段八十九·三十五已解除该限定**：wasm 目标的异常链接修复后，本组四例全部复跑，断言与 native 一致；跨目标验收脚本见 `temp/wasi-eh/check.sh`。）

**GC 边界修复（v0.3.65 → v0.3.67，修复两个落地缺口）**：

1. **`gc_alloc` 超大分配死循环**：分段堆按固定 `GC_SEG_SIZE = 1 MiB` 切段，单次请求超过
   `GC_SEG_SIZE - sizeof(gc_header)`（约 1 MiB − 24 字节头）时，切出的新段永远满足不了请求，
   `return gc_alloc(type, size)` 无限递归、不停 `malloc(1 MiB)` 直至耗尽 VSZ（`benchmarks/array` 实测 VSZ 膨胀到 ~415 GB）。
   修复：在切段逻辑前加超大分配分支（镜像 `as_alloc` 的 oversized 分支）——当 `size > GC_SEG_SIZE - sizeof(gc_header)`
   时分配一个 `sizeof(gc_header) + size` 的专用段，递归重试下一次迭代即命中 free-list。
2. **GC 覆盖缺口（headless 程序）**：帧边界安全点只在 `Stage_dispatchFrame` 帧循环内，控制台/headless 程序的
   `main()` 从不进入帧循环，8 个 benchmark 无一真正触发 GC（静默泄漏，靠块小内存足才「碰巧」跑完）。修复：
   给 `benchmarks/strings`/`binarytrees` 的分配密集循环周期性插入 `System.gc()`（顶层 `var` 已编译为全局模块变量，
   经 `gc_mark_user_roots()` 标记，故不会误回收活对象）。A/B 对照峰值 RSS：strings 447 MB → 75.7 MB（5.9×）、
   binarytrees 149.5 MB → 30.0 MB（5.0×），校验值全程不变，证明根标记正确、无悬空回收。

**MVP 边界（GC-1）**：舞台/显示列表/事件系统这些「常驻对象」本就是 GC 根（AS3 里从 stage 可达），
**只回收动画临时对象**（TweenLite/vars/PropTween/闭包），正好命中阶段五十六残留泄露的主体。

**验收**：
- GC-1：`examples/stage57.as` 断言长循环 `new` 大量对象后 `System.totalMemory` 不随轮次线性增长（回收生效）；
      窗口 demo 长时间运行 MEM 稳定；回归旧示例无破坏 ✅
- GC-2：字符串分配走 GC（`as_str_alloc`），`trace`/`text.text` 高频拼接后内存稳定 ✅（`examples/gc_strings.as`）
- GC-3：`--target wasm` 下同样回收；native+wasm 双目标长时间运行零悬空 ✅（`stage57.as`/`gc_strings.as`/`gc_incremental.as`/
      `gc_barrier.as` 四例双端一致，WASI SDK 34.0 + wasmtime 48.0.2；全量回归 63 passed / 0 failed）
      ⚠️ 该限定**已于阶段八十九·三十五解除**：异常链接修复后，带 `try/catch` 的示例同样可复现（阶段八十九·三十一原实测：WASI 链接失败）
- GC-4：增量标记落地后，`gc_step()` 每帧分摊固定预算（确定性调度），停顿不随堆大小线性增长（帧率稳定、无可见卡顿） ✅
      （`examples/gc_incremental.as` 内存有界 + `examples/gc_barrier.as` 直接字段写无悬空）

---

#### 阶段五十八：`flash.geom` 基础 2D 几何类型（目标 v0.3.58 → v0.3.59）【P0】✅ 已完成

**依据**：官方文档明确「Methods and properties of BitmapData / DisplayObject / DisplayObjectContainer /
DisplacementMapFilter / NativeWindow / Matrix / Rectangle 都使用 Point 对象」。当前 `DisplayObject` 已有 `x`/`y` 字段，
但 `transform` 属性、`Graphics.drawRect/drawCircle` 的几何参数、`BitmapData` 操作都缺 geom 类型，是后续一切布局/动画/绘图的前置。

- [x] **Point**：`x`/`y`（Number，默认 0）；只读 `length` getter；静态 `distance(pt1,pt2)`/`interpolate(pt1,pt2,f)`/`polar(len,angle)`；
      实例 `add`/`subtract`（**返回新对象，不改自身**）、`offset`/`normalize`/`setTo`/`copyFrom`（改自身返回 void）、`clone`/`equals`/`toString`（`"(x=.., y=..)"`）
- [x] **Rectangle**：`x`/`y`/`width`/`height`；只读 `top`/`bottom`/`left`/`right` getter；`intersection`/`union`/`contains`/`containsPoint`/`containsRect`/`intersects`/`equals`/`inflate`/`offset`/`clone`/`setEmpty`/`isEmpty`/`toString`
- [x] **Matrix**：`a`/`b`/`c`/`d`/`tx`/`ty` 六 Number 字段 + `identity`/`translate`/`scale`/`rotate`/`concat`/`invert`/`transformPoint`/`deltaTransformPoint`/`createBox`/`createGradientBox`
- [x] **ColorTransform**：`redMultiplier`/`greenMultiplier`/`blueMultiplier`/`alphaMultiplier`（默认 1）/`redOffset`/`greenOffset`/`blueOffset`/`alphaOffset`（默认 0）+ `concat`
- [x] **Transform**：访问 `colorTransform`/`matrix`（持恒等 Matrix/ColorTransform）；`DisplayObject.transform` 接线（Matrix 作用于 Skia canvas 变换）于**阶段六十七**落地（`sk_canvas_concat`）

**语义红线（AS3 vs C）**：这些是**引用类型**（`new Point()` 返回对象引用），C 侧用 struct + 指针；
`add`/`subtract` 返回新对象不修改 this（与 `offset`/`normalize` 的原地修改区分）；`interpolate` 的 `f` 越接近 1 越靠近 `pt1`
（与直觉相反，须按官方文档实现）；Matrix 的 `concat` 语义是 `this = this * m`（非交换）。

**验收**：`examples/stage58.as` 断言 Point.distance(Point(0,0), Point(6,8))==10、interpolate 中点、Rectangle 相交/包含、
Matrix 平移/旋转/变换点、ColorTransform 默认值；回归旧示例无破坏。✅（64 passed / 0 failed；无 `new` 的 `Point(x,y)` 构造同样支持）

#### 阶段五十九：`flash.events` 事件类补齐（目标 v0.3.59 → v0.3.60）【P0】✅ 已完成

**依据**：TimerEvent 被 `flash.utils.Timer` 依赖（阶段六十）；ProgressEvent/DataEvent 被 Loader/URLLoader 依赖（阶段六十二/六十三）。
均为纯常量类 + 少量字段，语义简单，复用已实现的 `Event`/`EventDispatcher`。

- [x] **TimerEvent**：`TIMER="timer"`/`TIMER_COMPLETE="timerComplete"` 常量（继承 Event）
- [x] **ProgressEvent**：`PROGRESS="progress"` + `bytesLoaded`/`bytesTotal` 字段
- [x] **IOErrorEvent**：`IO_ERROR="ioError"` + `text` 字段；**ErrorEvent**：`ERROR="error"` + `text`；**DataEvent**：`DATA="data"` + `data` 字段
- [x] **Event 完整常量**：补 `CANCEL`/`CLEAR`/`CLOSE`/`CONNECT`/`COPY`/`CUT`/`DEACTIVATE`/`EXIT_FRAME`/`FRAME_CONSTRUCTED`/`FULLSCREEN`/`ID3`/`INIT`/`MOUSE_LEAVE`/`OPEN`/`PASTE`/`RENDER`/`SCROLL`/`SELECT`/`SOUND_COMPLETE`/`TAB_CHILDREN_CHANGE`/`TAB_ENABLED_CHANGE`/`TAB_INDEX_CHANGE`/`UNLOAD` 常量

**语义红线**：这些事件的 `bubbles`/`cancelable` 默认值各异（TimerEvent 均为 false），emit 时按类名区分，
不能统一复用 Event 的默认构造；`Event.clone()`/`toString()` 需 override 保留子类字段。

**验收**：`examples/stage59.as` 断言常量值正确、`new TimerEvent(TimerEvent.TIMER)` 的 type/字段可读、`is Event` 成立。✅（65 passed / 0 failed）

#### 阶段六十：`flash.utils.Timer` 重复定时器（目标 v0.3.60 → v0.3.61）【P1】✅ 已完成

**依据**：`setTimeout` 只覆盖一次性延迟，`Timer` 是「可重复、可停止、可重置、带 currentCount/repeatCount/running 状态」的
定时器，是几乎所有真实应用（轮询、心跳、动画节流）的基础设施。继承 `EventDispatcher`，依赖阶段五十九 TimerEvent。

- [x] 构造 `Timer(delay, repeatCount=0)`；属性 `delay`（读写，负/非有限抛 Error）、`repeatCount`（读写）、`currentCount`（只读）、`running`（只读）
- [x] 方法 `start`/`stop`/`reset`（reset 停表 + currentCount 归零）；`start` 后 `stop` 再 `start` 继续剩余次数
- [x] 事件：每个 interval 派发 `TimerEvent.TIMER`；`repeatCount>0` 且次数耗尽派发 `TimerEvent.TIMER_COMPLETE`；`repeatCount=0` 无限重复
- [x] 运行时：新增独立 `as_rep_timer` 池（runtime.ts）持 obj + fire 回调，由 `as_timer_tick` 驱动；`Timer_start` 注册、`Timer__on_tick` 派发/重新入队；GC 根注册入 `gc_mark_internal_roots`

**语义红线**：`delay<20ms` 官方不推荐（频率受 60fps 限制）；事件派发时机与帧循环对齐而非墙钟精确；
`currentCount` 从 0 起、每次触发 +1；`timerComplete` 在最后一次 TIMER 之后派发。

**验收**：`examples/stage60.as` 断言重复触发次数、repeatCount 耗尽后派发 TIMER_COMPLETE、stop/reset 语义；
窗口 demo 用 Timer 替代 setTimeout 驱动一段动画。✅（66 passed / 0 failed；新增全局 `tickTimers()` 离屏泵钩子）

#### 阶段六十一：`flash.filters` 滤镜（目标 v0.3.61 → v0.3.62）【P2】✅ 已完成

**依据**：BlurFilter 官方文档明确滤镜是**渲染级**效果，依赖 Skia 后端（`SkBlurImageFilter`/`SkDropShadowImageFilter`），
且依赖 `DisplayObject.filters` 属性与 `BitmapData.applyFilter()`。demo 不依赖，优先级中。

- [x] **BitmapFilter** 抽象基类（`clone()` 纯虚）；**BlurFilter**（`blurX`/`blurY` 默认 4.0、`quality` 默认 1 + `clone`）；
      **DropShadowFilter**/**GlowFilter**（距离/角度/颜色/强度/内外发光）；**BitmapFilterQuality** 常量类（LOW=1/MEDIUM=2/HIGH=3）
- [x] `DisplayObject.filters` 属性（读写，赋值空数组清除滤镜）；`BitmapData.applyFilter()`（源位图 + 滤镜 → 结果位图）

**语义红线（重）**：应用滤镜自动置 `cacheAsBitmap=true`（清除则恢复原值）；滤镜结果超 8191px/16777215px 时不应用；
`quality` 值越接近 2 的幂越快；`quality` 由 Skia 的多次卷积近似，非精确高斯。

**验收**：`examples/stage61.as`（离屏）断言滤镜类默认值/自定义构造/`clone`/`is` 判定、`BitmapFilterQuality` 常量、
`DisplayObject.filters` 读写回环、`BitmapData.applyFilter` 盒式模糊与 DropShadow/Glow 延后抛错。✅（67 passed / 0 failed；
DropShadow/GlowFilter 光栅化与 `DisplayObject.filters` 的 Skia 合成仍延后，README 已注明）

#### 阶段六十二：`flash.display` 补齐（目标 v0.3.62 → v0.3.63）【P2】✅ 已完成

**依据**：Loader/LoaderInfo 依赖 `flash.net.URLLoader`（阶段六十三），MovieClip 依赖帧动画，均为重活，排在 geom/events 之后。

- [x] **LoaderInfo**（`bytesLoaded`/`bytesTotal`/`url` + COMPLETE/IO_ERROR/INIT 事件）；**Loader**（`load()`/`content`/`contentLoaderInfo`）
- [x] **MovieClip**（`currentFrame`/`totalFrames`/`gotoAndPlay`/`gotoAndStop`/`stop`/`play`，帧循环驱动）；**SimpleButton**（upState/overState/downState/hitTestState）

**语义红线**：Loader 是异步加载，事件派发时机与主循环异步；MovieClip 的帧推进与 `ENTER_FRAME` 对齐；
SimpleButton 的命中测试走阶段三十五的 `as_pick_hit` 扩展。

**验收**：`examples/stage62.as`（离屏）断言 `MovieClip` 帧时间轴（`play`/`stop`/`gotoAndPlay`/`gotoAndStop` 与 `currentFrame` 回绕）、
`SimpleButton` 四状态引用、`LoaderInfo` 常量、`Loader.load` 同步记录 URL + 派发 INIT/COMPLETE。✅（68 passed / 0 failed；
`MovieClip.totalFrames` 建模为可写（无符号时间轴）、`SimpleButton` 视觉状态切换延后、`Loader.load` 为同步模拟（真实异步 `URLLoader` 属阶段六十三），README 已注明）

#### 阶段六十三：`flash.net`/`flash.media`/`flash.ui`（目标 v0.3.63 → v0.3.64）【P3】✅ 已完成

**依据**：异步网络/音视频/键盘鼠标状态查询，独立于几何/事件基础，重活。

- [x] `flash.net`：**URLLoader**（`load()`/`data`/`close`，异步本地文件读取（COMPLETE/IO_ERROR 下一帧 tick），`data` 为 GC 跟踪字符串）、**URLVariables**（`dynamic class`，未声明字符串键属性 + `toString()` 序列化）、**URLRequest**（`url`/`method`/`data`/`contentType`）
- [ ] `flash.media`：**Sound**（`load`/`play`，依赖后端解码）、**SoundChannel**、**Video**（延后：音频/视频解码后端）
- [x] `flash.ui`：**Keyboard**（键码常量子集 + `isAccessible`）、**Mouse**（静态 `hide`/`show` + 只读 `cursor`/`supportsCursor`/`supportsNativeCursor`）

**验收**：`examples/stage63.as`（离屏）断言 `URLRequest` 值束与默认 `method`、`URLLoader` 异步读文件成功/失败两路事件（`tickTimers()` 泵）、`URLVariables` 动态属性 + `toString()`、`Keyboard` 键码常量与 `isAccessible`、`Mouse` 静态方法。✅（73 passed / 0 failed；
`Socket`、`Sound`/`SoundChannel`/`Video`、`ContextMenu` 延后（依赖网络套接字/音视频解码/原生菜单后端），
`URLLoader` 为异步本地文件读（`as_set_timeout(0)` 模拟异步，非真实 HTTP），README 已注明）

#### 阶段六十四：`air.*` 桌面运行时（目标 v0.3.64 → v0.3.65）【P3】✅ 已完成

**依据**：AIR 是 Flash 之外最大的独立命名空间，完全独立于显示/事件体系，重活且工作量大，排最后。

- [ ] **Window**/**NativeWindow**（对应 `window_glue.cc` 的多窗口/原生窗口管理，延后：原生多窗口与 Stage/SDL2 单窗口模型重叠）
- [x] **File**/**FileStream**（`open`/`openAsync`（异步 PROGRESS+COMPLETE）/`read`/`write`，POSIX 文件 IO；静态目录 `applicationDirectory`/`desktopDirectory`/`documentsDirectory`/`userDirectory`）/ **FileMode**（常量）
- [ ] **SQLConnection**/**SQLStatement**（依赖 SQLite 链接，延后）

**验收**：`examples/stage64.as`（离屏）断言 `File` 路径束与 `exists`/`isDirectory`/`resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory` + 静态目录、
`FileStream` `open`/`openAsync`/`close`/`readUTFBytes`/`writeUTFBytes` 读写回环与只读 `position`/`bytesAvailable`、`FileMode` 常量。✅（73 passed / 0 failed；
`NativeWindow`/`Window` 与 `SQLConnection`/`SQLStatement` 延后（原生多窗口管理/SQLite 链接），README 已注明）

#### 阶段六十五：`flash.system.Capabilities` 环境能力查询（目标 v0.3.67 → v0.3.68）【P1】✅ 已完成

**依据**：[`Capabilities`](https://airsdk.dev/reference/actionscript/3.0/flash/system/Capabilities.html) 是 `final` 静态只读类
（不可实例化、全部为 static getter），与已实现的 `System`（阶段五十二）同范式，可复用 `emitMember` 的「纯静态只读」分支。
用户诉求：`Capabilities.version` 返回 **AS-AOT 版本**，且版本号单一来源（package.json），避免手动同步。

**核心决策：`version` 能否动态读取 package.json？**
- **编译期动态读取（采纳）**：codegen 生成 C 时由 `index.ts` 读 package.json 的 `version` 字段（`"0.3.67"`），
  经 `generateC(program, { asAotVersion })` 传入，`emitMember` 把 `Capabilities.version` 映射为 C 字符串字面量。
  版本号单一来源，`npm version` 升级后自动同步，无需改 codegen。
- **运行时动态读取（不采纳）**：编译产物是独立原生二进制，部署环境无 package.json，读不了也无意义。
- **格式有意偏差**：官方 `version` 为 `"MAC 9,0,0,0"` 四段平台版本号；AS-AOT 无 Flash/AIR 版本体系，
  故返回 `"0.3.67"`（或前缀 `"AS-AOT 0.3.67"`），README 需如实注明。

**可支持参数分档（依据官方属性清单 + 平台依赖度）**：

| 档 | 属性 | 映射方案 |
|---|---|---|
| **P0 编译期/条件编译常量（零平台依赖，首批落地）** | `version` | package.json `version` 注入字符串字面量 |
| | `os` | `#ifdef __APPLE__`→`"Mac OS"` / `_WIN32`→`"Windows"` / `__wasi__`→`"WASI"` / `__linux__`→`"Linux"` |
| | `cpuArchitecture` | `__aarch64__`→`"ARM"` / `__x86_64__`·`__i386__`→`"x86"` |
| | `cpuAddressSize` | `sizeof(void*)==8 ? 64 : 32` |
| | `supports64BitProcesses` / `supports32BitProcesses` | 由 `cpuAddressSize` 推得 |
| | `playerType` | 常量 `"Desktop"`（AOT 原生可执行，对齐 AIR） |
| | `manufacturer` | 常量 `"AS-AOT"`（有意偏差，非 Adobe） |
| | `isDebugger` | 常量 `false`（无调试运行时） |
| | `touchscreenType` | 常量 `"none"`（桌面无触摸，`TouchscreenType.NONE`） |
| **P1 轻量平台探测（复用现有机制，第二批）** | `language` | `getenv("LANG")` 解析 ISO 639-1 前缀（macOS 可用 `CFLocale`，POSIX 用 locale） |
| | `screenResolutionX`/`screenResolutionY` | SDL2 `SDL_GetDesktopDisplayMode`（窗口后端已有）；headless 退化 0 |
| | `screenDPI` | SDL2 `SDL_GetDisplayDPI`；headless 退化 72 |
| | `screenColor` / `pixelAspectRatio` | 常量 `"color"` / `1.0` |
| | `hasAudio` | 常量 `true`（对齐官方「always true」）；其余 `has*` 布尔按后端有无固定 |
| **P2 依赖后端/动态数组（延后，注明理由）** | `languages` | 需构造 `Array` + OS locale 列表（`CFLocaleCopyPreferredLanguages` / `setlocale`） |
| | `serverString` | URL-encoded 汇总，依赖全部属性落地后拼接 |
| | `hasMP3`/`hasAudioEncoder`/`hasVideoEncoder`/`hasEmbeddedVideo`/`hasStreamingAudio`/`hasStreamingVideo`/`hasTLS` | 依赖音视频/网络后端（阶段六十三已延后 Sound/Video/Socket） |
| | `maxLevelIDC` | 依赖 H.264 解码后端 |
| | `hasAccessibility`/`hasIME`/`avHardwareDisable`/`localFileReadDisable`/`isEmbeddedInAcrobat` | 沙箱/PDF/IME 概念，AOT 无对应物，可常量 `false`（优先级低） |

**方法**：`hasMultiChannelAudio(type)` 恒 `false`（AIR 仅 TV 设备支持，桌面恒 false），可顺带落地。

**语义红线**：`Capabilities` 是 `final` 静态只读类，不可 `new Capabilities()`；建模与 `System` 一致——
**不注册为可实例化 ClassInfo**，仅在 `emitMember` 加 `Capabilities` 特判分支（`expr.object.name === 'Capabilities'`），
各属性映射到运行时/编译期常量，避免 `new Capabilities()` 误用。

**验收**：`examples/stage65.as` 断言 `version` 非空且含 `.`（编译期从 package.json 注入，实测输出 `0.3.68`）、
`os`/`cpuArchitecture` 非空且与编译目标平台一致、`cpuAddressSize` 为 32/64、`supports64/32BitProcesses` 与地址宽度一致、
`playerType == "Desktop"`、`manufacturer == "AS-AOT"`、`isDebugger == false`、`touchscreenType == "none"`、
`language` 非空、`screenColor == "color"`、`pixelAspectRatio == 1.0`、`hasAudio == true`、`screenResolutionX/Y >= 0`、
`screenDPI > 0`；README 内建表/类型映射/当前限制同步；版本号 v0.3.67 → v0.3.68。

**落地形态（v0.3.68）**：P0 + P1 全部落地——`version` 经 `generateC(program, { asAotVersion })` 注入 C 字符串字面量
（`index.ts` 读 package.json、`codegen.ts` 透传、`emit.ts` 的 `emitCapabilitiesConst` 特判 `Capabilities`）；`os`/`cpuArchitecture`
走 `runtime.ts` 的 `as_cap_os`/`as_cap_cpu_arch` 条件编译助手；`cpuAddressSize`/`supports*` 用 `sizeof(void*)` 内联表达式；
`language` 用 `as_cap_language`（`getenv("LANG")` 剥 ISO 639-1）；`screenResolutionX/Y` 用 `as_window_get_display_size`
（headless 退化 0）；`screenDPI` 固定 72.0（无逐屏 DPI 查询，README 已注明）；其余为编译期常量。P2（`languages`/`serverString`/
`hasMP3`/`hasTLS`/`hasVideoEncoder`/`maxLevelIDC`/`hasAccessibility`/`hasIME` 等）与 `hasMultiChannelAudio(type)` 方法延后（依赖后端/动态数组）。
全量回归 **72 passed / 0 failed**，`--target wasm --dry` 编译命令正确。

> **后续调整（Starling 前置 Tier 5）**：`Capabilities.version` 格式从 `"AS-AOT <ver>"` 改为
> **`"<平台前缀> AS-AOT <ver>"`**（macOS → `"MAC AS-AOT 0.3.96"`、Windows → `"WIN AS-AOT 0.3.96"`、
> Linux → `"LNX ..."`、WASI → `"WAS ..."`，预留 iOS → `"IOS ..."`、Android → `"AND ..."`、tvOS → `"TVO ..."`），
> 使 Starling 的 `SystemUtil.platform` 用 `Capabilities.version.substr(0,3)`
> 能识别 `MAC`/`WIN`（原格式返回 `"AS-"`，平台判断全错）。落地：`emit.ts` 的 `emitCapabilitiesConst` 把 `version`
> 改为调用 `runtime.ts` 新增 `as_cap_version(const char* ver)`（`#ifdef` 选平台前缀 + `snprintf` 拼串，返回 `char*` 以匹配
> AS3 String 的 `char*` 映射、避免 const 丢弃告警）；Apple 平台用 `TargetConditionals.h` 的 `TARGET_OS_TV`/`TARGET_OS_IPHONE`
> 在 `__APPLE__` 内细分 MAC/IOS/TVO（`__APPLE__` 对 macOS 与 iOS/tvOS 都成立），Android 用 `__ANDROID__`；同步更新 `examples/stage65.as` 断言（`indexOf("AS-AOT ") == 4`）
> 与 README-CN.md。

#### 阶段六十六：`Vector.<T>` 高阶/序列方法补齐 + GC 遗留 malloc 收尾（目标 v0.3.68 → v0.3.69）【P1】✅ 已完成

- [x] **`Vector.<T>` 方法补齐**：`slice`/`concat`/`splice`/`forEach`/`map`/`filter`/`sort`/`reverse`（此前仅 `push`/`pop`/`join`/`indexOf`/`.length`），对齐 Array 已有高阶方法；回调复用 `as_value` 装箱/解箱路径，`(element, index, vector)` 三参布局与 Array 一致；`sort` 默认数值排序（int/uint/Number/Boolean）或字符串排序（String），object/interface 回退 `as_obj_to_str` 字符串比较，亦可传自定义比较函数
- [x] **`Vector.<T>` 字面量 `new <T>[...]`**：新增 AST `VectorLit` 节点 + `parseNew` 的 `<` 分支 + `emitVectorLit`，去糖为 `as_vector_<key>_make(n, items)` 单态化助手（`new <T>[]` 空字面量 → `_new()`）
- [x] **`as_vector` 迁 GC**：单态化 struct 加 `void (*mark)(void*)` 回调首字段，`gc_alloc(GCT_CUSTOM, ...)` 分配；引用元素（string/object/interface）data 用 `GCT_PTR_ARRAY`（GC 扫描子指针 + 写屏障），标量元素 data 仍 `realloc`（无指针）；新增 `GCT_CUSTOM` tag，`gc_scan` 经回调分派标记
- [x] **闭包 env 迁 GC**：`env_make` 从 `malloc` 改 `gc_alloc(GCT_CUSTOM, ...)`，按捕获字段 CType 生成 mark 回调（raw 指针 → `gc_mark_ptr`、boxed `as_value` → `gc_mark_value`、标量跳过），修复闭包逃逸后捕获对象/字符串被 GC 误收的悬空隐患
- **验收**：`examples/stage66.as` 断言式回归；全量回归 **73 passed / 0 failed**

---

#### 阶段六十七：三子系统 deferred 项收尾（动态类建模 + 异步 IO + transform 接线）（目标 v0.3.69 → v0.3.70）【P1】✅ 已完成

**依据**：阶段五十八/六十三/六十四各遗留一项依赖“更基础设施”的延后项，现补足：
动态类建模（URLVariables 需要）、无网络后端的异步事件调度（URLLoader/Loader/FileStream 需要）、
显示对象 transform 接线（DisplayObject.transform 需要）。

- [x] **通用动态类机制（`dynamic class`）**：`ClassInfo.isDynamic` 标志 + 动态类 struct 尾部 `as_object* _dyn` 槽表；`as_vtable_header` 新增第 6 字段 `int dyn_offset`（非动态为 -1，动态类经 `offsetof` 记录 `_dyn` 字节偏移）；`as_dyn_get`/`as_dyn_set` 在 super 链 props 未命中后回退 `_dyn` 槽表；`gc_scan` 的 GCT_CLASS 分支额外标记 `_dyn` 指针；emit.ts 成员读写对动态类未声明属性路由到 `as_dyn_set`/`as_dyn_get`
- [x] **`URLVariables`**：注册为 `extends Object` 的 `dynamic class`，ctor 参数 `source` 可空（解析 `k=v&...` 到 `_dyn`）；`toString()` 把 `_dyn` 序列化为 query string（`as_url_encode`/`as_url_decode` 运行时助手）
- [x] **异步事件调度（无网络后端）**：`URLLoader.load`/`Loader.load`/`FileStream.openAsync` 改用 `as_set_timeout(as_fn_make(thunk, obj), 0.0)` 把 COMPLETE/IO_ERROR/INIT/PROGRESS 延迟到下一帧 tick——`load()` 返回后注册的监听器仍能收到事件；`data`/`readUTFBytes` 由 `malloc` 改 `as_str_alloc`（GC 跟踪）
- [x] **`File` 静态目录**：emitMember 特殊分支（仿 Capabilities 模式）+ `getenv("HOME")` 运行时 helper，落地 `applicationDirectory`（CWD `"."`）/`userDirectory`/`desktopDirectory`/`documentsDirectory`
- [x] **`DisplayObject.transform` 接线**：`DisplayObject` 加 `transform` 字段（`Transform*`，ctor 初始化 + 写屏障），`as_render_object` 在 translate/rotate/scale 后调用新增 `sk_canvas_concat`（`SkMatrix::setAll(a,c,tx,b,d,ty,0,0,1)` + `concat`），Matrix 真正作用于 Skia canvas 变换

**验收**：`examples/stage58.as`/`stage62.as`/`stage63.as`/`stage64.as` 更新断言（transform 矩阵读回与渲染、Loader/URLLoader 异步 `tickTimers()` 泵、URLVariables 动态属性 + 序列化、File 静态目录 + FileStream `openAsync`）；全量回归 **73 passed / 0 failed**

---

#### 阶段六十八：`--package xcode-project` 工程生成器（macOS）（目标 v0.3.70 → v0.3.71）✅ 已完成

**依据**：`compile.md` §6 的「编译后端 vs 分发形态」正交拆分设计——`--target` 只承载机器码 ABI，
`--package` 承载编译后的组织形态；只服务 IDE 开发者，故 `--package` 只做工程生成器（`raw` + `xcode-project`
+ `android-project`），不做 `app`/`dmg` 脚本路线。本阶段落地第一个工程生成器：`xcode-project`（macOS）。

- [x] **`Package` 类型与配置**：`build.ts` 新增 `type Package = 'raw' | 'xcode-project' | 'android-project'`；
  `BuildConfig.package`（默认 `raw`）+ manifest `package` 字段 + CLI `--package` 参数，均走「CLI beats manifest」合并
- [x] **`src/xcode-project.ts` 生成器**：把生成的**可读 C** + manifest 的 `sources`/`include-paths`/`link-libs`/
  `link-paths`/`defines`/`objects`/`frameworks` 组织成 `.xcodeproj`（`project.pbxproj` + 共享 scheme）；目标类型
  `com.apple.product-type.tool`（macOS 命令行工具），与 raw `cc -O2` 产物同构
- [x] **编译配置镜像 raw 链接**：`OTHER_LDFLAGS` 恒含 `-lm -lz` 再拼 `link-libs`/`objects`/`frameworks`；
  `HEADER_SEARCH_PATHS`/`LIBRARY_SEARCH_PATHS`/`GCC_PREPROCESSOR_DEFINITIONS` 分别镜像三类路径/宏；
  `GCC_OPTIMIZATION_LEVEL` 从 `--opt` 的 `-O{0,1,2,3,s}` 映射；路径按绝对路径写入，任意工作目录可解析
- [x] **关闭 `-fmodules`（关键语义修复）**：生成 C 的裸类型名（`Point`/`Rectangle`…）会与 macOS SDK 的
  `MacTypes.h` 里的 `Point` 冲突；Xcode 默认启用 `-fmodules` 会让 SDK `Point` 遮蔽生成 struct（
  `no member named 'x' in 'struct Point'`），故工程显式 `CLANG_ENABLE_MODULES = NO`，与命令行构建语义一致
- [x] **C/C++ 分层**：生成 `.c` 保持 C99（`GCC_C_LANGUAGE_STANDARD = c99`），C++ 胶水层（`skia_glue.cc` 等）
  C++17（`CLANG_CXX_LANGUAGE_STANDARD = "c++17"` + `CLANG_CXX_LIBRARY = "libc++"`），按扩展名自动分派

**验收**：`as-aot examples/hello.as --target native --package xcode-project` 生成工程后，
`xcodebuild -project ... -scheme Hello build` 成功，产物运行输出与 raw 一致；GUI 工程
（`examples/window.as` + Skia/SDL2 manifest，含 13 个 framework + C++ 胶水层）同样 `xcodebuild` 构建成功；
全量回归 **73 passed / 0 failed**。

---

#### 阶段六十九：`--package xcode-project` 升级为 macOS application（目标 v0.3.71 → v0.3.72）✅ 已完成

**依据**：上一阶段（六十八）的 xcode-project 是 `com.apple.product-type.tool`（命令行工具），产物与 raw
的裸 Mach-O 运行时等价，无法兑现「IDE 开发者上架路线」的 App 身份（无 bundle、无 Info.plist、不能签名
上架、Dock 无正式图标）。本阶段把目标类型升级为 `com.apple.product-type.application`，产物变成 `.app`
bundle，让 xcode-project 真正与 raw 分道扬镳。

- [x] **application 目标类型**：`productType` 由 `tool` 改 `application`（`wrapper.application`），
  `buildPhases` 增补 **Resources** 段；产物 `Contents/MacOS/<bin>` + `Contents/Info.plist` +
  `Contents/Resources/` + `PkgInfo`；共享 scheme 的 `BuildableName` 改为 `<NAME>.app`
- [x] **`Info.plist` 生成**：`generateXcodeProject` 额外写 `<outDir>/<product>/Info.plist`；
  `CFBundleIdentifier`/`CFBundleExecutable`/`LSMinimumSystemVersion` 用 `$(PRODUCT_BUNDLE_IDENTIFIER)`/
  `$(EXECUTABLE_NAME)`/`$(MACOSX_DEPLOYMENT_TARGET)` 注入与构建设置同步；`CFBundleName` 填 `display-name`
- [x] **manifest 应用元数据**：`build.ts` 新增 `bundleId`/`displayName`/`icon`/`deploymentTarget` 四字段 +
  manifest 键 `bundle-id`/`display-name`/`icon`/`deployment-target`，走「CLI beats manifest」合并；
  分别落入 `PRODUCT_BUNDLE_IDENTIFIER`/`CFBundleName`/Resources phase + `CFBundleIconFile`/
  `MACOSX_DEPLOYMENT_TARGET`；`icon`（绝对路径 file ref）拷入 `Contents/Resources/`
- [x] **ad-hoc 签名**：`CODE_SIGN_STYLE = Manual` + `CODE_SIGN_IDENTITY = "-"`，`xcodebuild` 无需
  provisioning profile / Apple ID 即产出可运行的 `.app`（ad-hoc）；正式上架待 manifest `signing-identity`
- [x] **运行语义不变**：生成的 AS3 C 仍是 `int main(void)`，SDL2 事件循环（`ASC_USE_WINDOW=1`）从 `main`
  跑，bundle + Info.plist 只加 App 身份，不改变运行行为

**验收**：`as-aot examples/hello.as --target native --package xcode-project -o .../hello` 生成工程后
`xcodebuild` 构建出 `hello.app`（`codesign -dv` 显示 ad-hoc 签名、`Identifier=com.example.hello`），运行
二进制输出与 raw 一致；GUI 工程（`examples/window.as` + Skia/SDL2 manifest）同样构建出 `window.app`
（arm64 Mach-O）；manifest `bundle-id`/`display-name`/`icon`/`deployment-target` 四字段经实测注入
`Info.plist` 与 build settings（`CFBundleName`/`PRODUCT_BUNDLE_IDENTIFIER`/`MACOSX_DEPLOYMENT_TARGET`/
`CFBundleIconFile` + `Contents/Resources/AppIcon.icns`）；全量回归 **73 passed / 0 failed**。

---

#### 阶段七十：`xcode-project` 智能合并（保护 Xcode 手改）（目标 v0.3.72 → v0.3.73）✅ 已完成

**依据**：IDE 开发者会在 Xcode 里手改 build settings、scheme、添加文件/资源；而每次改代码重新
`node src/index.ts ... --package xcode-project` 若整个重建 `.xcodeproj`，这些手改会被抹掉。本阶段把
工程生成器改为**对象级智能合并**：工程已存在时只增删我们管理的源文件，其余对象原样保留。

- [x] **`src/pbxproj.ts`**：最小 OpenStep plist 解析器 + 序列化器（注释/引号串/数组/字典/裸原子），
  round-trip 幂等、`plutil -lint` 通过；提供 `asDict`/`asArray`/`scalarText`/`dictEntry` 查询助手。
- [x] **sidecar 清单**：工程内写 `.as3aot-managed.json` 记录受管源文件集合（生成的 `.c` + manifest
  `sources` 绝对路径），作为下次 diff 的基准；Xcode 忽略该文件。
- [x] **智能合并**：工程存在时解析现有 `project.pbxproj`，对比 sidecar 旧集合与本次新集合，
  **只增删 `sourceTree = "<absolute>"` 的 file ref + 对应 build file**，用户手改的 build settings、
  scheme、自加的相对路径文件全部保留；源文件列表未变则不写文件（`unchanged`）。
- [x] **ID 冲突规避**：合并路径用 `freshOid(used)` 避开已存在的 object ID（共享计数器按进程重置）。
- [x] **结果分派**：`index.ts` 区分 `create`（首次生成）/`merge`（就地合并，changed/unchanged）打印。

**验收**：对 `examples/air-native`（`--air-app` + Skia/SDL2 manifest）验证——手改
`INFOPLIST_KEY_CFBundleDisplayName` 后重跑，`unchanged` 时手改完整保留；改 `visible=false`（移除
`window_glue.cc`）→ `source list updated` 且 window_glue 引用归零、手改仍在；改回后 window_glue 恢复；
`xcodebuild` 构建 merge 后的工程 **BUILD SUCCEEDED**；round-trip 幂等 + `plutil -lint` OK；全量回归
**73 passed / 0 failed**。

---

#### 阶段七十一：`--target wasm --package web` 浏览器渲染目标（目标 v0.3.75 → v0.3.76）✅ 已完成

**依据**：`--target` 定机器码 ABI、`--package` 定分发形态，二者正交。浏览器页面（`.wasm` + `.js` +
`index.html`）是「如何组织产物」，与 `xcode-project` 同层级，故新增 `--package web`（要求 `target=wasm`）。
用 Emscripten 把 wasm 版 Skia + C++ 胶水层编成浏览器产物，在 `<canvas>` 里跑 CPU 光栅 + 帧循环。

- [x] **wasm 版 Skia 静态库**：用 Emscripten 3.1.44 + GN/ninja 重编 Skia m124（`is_trivial_abi=true`、
  `skia_enable_fontmgr_custom_empty/embedded=true`），16 个 `.a` 放入 `vendor/skia/lib/wasm/`（头文件共享、库按平台分目录）。
- [x] **字体后端切换**：`skia_glue.cc` 加 `#ifdef __EMSCRIPTEN__` 分支——`SkFontMgr_New_Custom_Data()` +
  `EMSCRIPTEN_KEEPALIVE` 导出的 `sk_fontmgr_register_data()`；`#else` 保持 CoreText。
- [x] **窗口层切换**：新 `vendor/web_glue.cc`——canvas blit（`putImageData` premultiplied alpha）+
  `emscripten_set_main_loop` 帧驱动 + 鼠标/wheel 输入 + `devicePixelRatio` probe；保持与 `window_glue.cc` 相同
  的 `extern "C"` 签名，生成的 `.c` 零改动。
- [x] **构建接入**：`build.ts` 加 `Package='web'`、`font-urls` 字段、`buildWebCompileSteps()`；web 链接参数
  `-s ALLOW_MEMORY_GROWTH=1 -s USE_ZLIB=1 -s INVOKE_RUN=0 -s EXPORTED_FUNCTIONS=["_main","_malloc","_free","_sk_fontmgr_register_data"]`。
- [x] **ABI 匹配**：wasm 版 libskia.a 以 `is_trivial_abi=true` 编译，C++ glue 编译时自动加
  `-D SK_TRIVIAL_ABI=[[clang::trivial_abi]]`（否则运行期 `unreachable` 崩溃）。
- [x] **字体注入**：`index.ts` 的 `writeWebIndex()` 生成 HTML——`onRuntimeInitialized` 里 `fetch`
  `font-urls` → `_malloc`/`HEAPU8.set` → `_sk_fontmgr_register_data` → `_free` → `_main()`。
- [x] **TextField 默认尺寸修复（emit.ts）**：`TextField_ctor` 加 `width=100; height=100`（AIR 语义），
  此前继承 DisplayObject 的 0×0 导致 `clip_rect(0,0,w,0)` 裁掉所有文字（native/web 都受益）。

**验收**：`examples/web/hello-web.as` 端到端构建 → 真实浏览器（CDP）canvas 720×480、蓝色矩形 300×160
精确匹配、`TextField` 文字逐字渲染、字体运行时注入成功、无运行期崩溃；native 回归（`stage38.as`/
`window.as`）编译运行无破坏。详见 [`docs/zh-cn/html5-web.md`](docs/zh-cn/html5-web.md)。

---

#### 阶段七十二：TextField 富文本与排版扩展（目标 v0.3.76 → v0.3.78）✅ 已完成

**依据**：阶段三十八（`TextField` 排版）遗留的「富文本（`htmlText`、多 `TextFormat` 区间样式）、`autoSize`/
`hscroll`/`selectable`/`leading`」等 AIR 交互/富文本能力，对照 AIR SDK
[`TextField`](https://airsdk.dev/reference/actionscript/3.0/flash/text/TextField.html) 官方参考补齐。

- [x] **`autoSize`**：`TextFieldAutoSize.NONE/LEFT/RIGHT/CENTER` 常量类；按 `textWidth`/`textHeight` 回填尺寸
- [x] **水平滚动**：`hscroll`/`scrollH`/`maxScrollH`（水平滚动 + 渲染偏移）
- [x] **`selectable` 与选区**：`setSelection`/`selectionBeginIndex`/`selectionEndIndex`/`caretIndex` + 鼠标拖选 + 选中高亮渲染
- [x] **`leading`**：`TextFormat.leading` 行间距经 SkParagraph `StrutStyle` 接线
- [x] **HTML 文本/多 `TextFormat` 区间富文本**：`htmlText` 解析 `<font>`/`<b>`/`<i>`/`<u>`/`<p>`/`<br>` 子集 + `setTextFormat` 区间样式

**语义红线**：选区索引按 **UTF-8 字节偏移**建模（与运行时 `strlen` 字符串模型一致，ASCII 精确，非 ASCII 为已知限制）；
布局断言写成对真实字体（`textWidth`/`maxScrollH` 用范围/关系断言）与纯 C stub（`size×1.2` 近似）双构建均成立。

**验收**：`examples/textrich.as`（autoSize/hscroll/selectable/选区/leading/htmlText/setTextFormat）与
`examples/textflow.as`（布局基线：硬换行/单行模式/`scrollV`/`maxScrollV` 视口数学）双构建断言全过。

---

#### 阶段七十三：`DisplayObject.cacheAsBitmap` 子树位图缓存（目标 v0.3.78 → v0.3.79）✅ 已完成

**依据**：对齐 adl 性能——把显示对象子树烘焙到离屏 surface、snapshot 成 `SkImage` 后每帧仅 `drawImage` 一次
（不再逐对象递归发绘制命令）。

- [x] **`cacheAsBitmap` 标志**：`DisplayObject` 基类字段 + getter/setter，默认 false，跨所有子类（`Shape`/`TextField`/`Stage`/`Sprite`/`Bitmap`）继承
- [x] **烘焙路径**：toggle 为 true 时把子树（内容 + 自身滤镜）烘焙进 `_cache_image`；false 时失效；烘焙结果与直接递归渲染**逐像素一致**
- [x] **渲染接线**：`as_render_object` 对已烘焙对象单发 `drawImage` 替代子树递归命令生成

**语义红线**：烘焙后子树内部变化不追踪（直到 toggle 或指纹失效重烘焙）；toggle 失效安全（无 stale 图像）。

**验收**：`examples/stage67.as`（get/set 语义 + 跨子类继承）与 `examples/cacheasbitmap.as`（烘焙容器子树
rect+circle+text，开关前后 PNG 语义一致、无错误）离屏断言全过。

---

#### 阶段七十四：增量重绘自动 `cacheAsBitmap`（渲染层指纹 dirty 检测，目标 v0.3.79 → v0.3.80）✅ 已完成

**依据**：native 单线程全量重绘 CPU 占用为 adl 3 倍，需对齐性能。`DisplayObject` 的 `x`/`y`/`rotation`/`scaleX`/
`scaleY`/`alpha`/`visible` 是字段直接写、无 setter，**不采用 push dirty 标记**，改为渲染入口每帧递归计算子树
**内容指纹**。

- [x] **内容指纹**：`as_render_fingerprint` 递归计算子树指纹 = 自身变换 + 类型内容（`SkPath` generation id / `Bitmap`
  image / `TextField` text+format）+ 滤镜字段 + 子节点指纹递归；纯整数/指针异或（FNV-1a），开销远低于 Skia 命令生成
- [x] **自动烘焙**：连续 `ASC_AUTO_BAKE_FRAMES`（=3）帧指纹不变即视为静止、自动烘焙进 `_cache_image`（复用
  cacheAsBitmap 路径）；指纹一变化立即失效重烘焙
- [x] **空容器重试节流**：无边界空容器每 `ASC_AUTO_BAKE_FRAMES` 帧重试一次 bounds 探测，避免每帧重算

**语义红线**：是「渲染层 dirty 检测」而非 setter 拦截，语义与 cacheAsBitmap 一致（烘焙后子树内部变化不追踪直到指纹变化）。

**验收**：`examples/autobake.as` 断言自动烘焙输出与首帧（直接递归）逐像素一致、子树变异后失效重烘焙反映变化。

---

#### 阶段七十五：native Metal 渲染后端（`renderMode=direct/gpu`，目标 v0.3.80 → v0.3.83）✅ 已完成

**依据**：web 目标（阶段七十一）已有 `renderMode=direct/gpu` → `ASC_RENDER_GPU=1` 的 Ganesh GPU 光栅化路径，
native 目标此前始终走 CPU raster + SDL streaming texture blit。本阶段补齐 native 的 GPU 后端：Skia Ganesh
**Metal** 后端，整帧在 GPU 上合成。

- [x] **Skia m124 源码重编（含 Metal 符号）**：`build-tools/skia-src` 是完整 Skia m124 源码仓库（`bin/gn` + ninja），
  gn gen 出 native arm64 + `skia_use_metal=true` 配置，ninja 编译产出含 705 个 Metal 符号（`GrDirectContexts::MakeMetal` 等）
  的 `libskia.a` 及全部传递依赖库，替换 `vendor/skia/lib/macos-arm64/`
- [x] **`metal_glue.mm`（Objective-C++ 胶水层）**：`SDL_Metal_CreateView`/`SDL_Metal_GetLayer` 取 CAMetalLayer →
  `GrDirectContext(Metal)` → 每帧 `[layer nextDrawable]` 取一次性 drawable → 包成 `GrBackendRenderTarget` →
  `flushAndSubmit` → `presentDrawable` + `commit`
- [x] **构建接入**：`build.ts` 识别 `.mm` 源（clang++ 编译，链接 Metal/QuartzCore framework）；`air-app.ts` native
  分支把 `renderMode=direct/gpu` 映射为 `ASC_RENDER_METAL=1` 并加 `metal_glue.mm` 源
- [x] **渲染循环分支**：`emit.ts` 加 `ASC_RENDER_METAL` 条件编译分支——Metal 无持久 surface，窗口后端在
  `sk_window_show_metal` 里建 CAMetalLayer + GrDirectContext，每帧 `sk_mtl_begin_frame` 重新获取 drawable

**语义红线（关键坑）**：
- **`flush()` 只记录命令，必须 `flushAndSubmit()` 才真正提交**——否则 drawable 保持未初始化的品红色（金属层默认色）；
- **`is_trivial_abi` 必须与 official build 一致（=false）**——否则 `sk_sp` 用 `[[clang::trivial_abi]]` 编译，与
  native glue 层（无 `SK_TRIVIAL_ABI` 宏）ABI 不匹配 → 运行期 Bus error；
- **Metal drawable 为一次性**，无法支撑持久离屏 surface——离屏 PNG 导出与 `cacheAsBitmap` 仍走 CPU raster；
- 效率优先，不对齐 AIR 的「direct = CPU 合成 + GPU blit」。

**验收**：`air-native-app.xml`（`<renderMode>direct</renderMode>`）编译链接成功（`.c` 含 `ASC_RENDER_METAL=1` +
`metal_glue.mm`）；窗口版运行全部 demo 断言通过、无崩溃、无 Bus error、Metal 整帧 GPU 合成（无品红/白屏）；
离屏 `air-native-offscreen` 与全量 `test.ts` 回归 **78 passed / 0 failed**。

---

#### 阶段七十六：C 标识符命名冲突处理（完整保留字表 + sanitize 全覆盖）（v0.3.87）✅ 已完成

**依据**：[Porffor](https://github.com/CanadaHonk/porffor)（架构与 as3compiler 几乎同构的「JS → 可读 C → 原生」AOT）
在 `compiler/render.js` 用一张远超 C 关键字的 `cReservedNames` 集合（libc/libm/POSIX/unistd/stdio/string.h/dirent/sys*/time.h/setjmp）
加「逐级加前缀」的 `sanitize()`（`exit → _exit → __exit`，并用 `sanitizeUsed` 防两两重名）解决同一问题。
as3compiler 当前只在 `src/emit.ts` 的 `C_KEYWORDS`（仅 C 语言关键字）里防 `cIdent` 命中，且只覆盖**方法/字段名**——
类名（`symbols.ts` `qualifiedName`）、局部变量/形参（`emit.ts` `declareVar`）均不做保留字检查。
链接 Skia/SDL2/libc/libm 后，AS3 高频名 `index`/`time`/`data`/`log`/`read`/`write`/`close`/`exit`/`free` 会撞库符号
（`index` 是 `strchr` 的 legacy 别名，最隐蔽；阶段六十八已实际遇到 Xcode `-fmodules` 下 SDK `Point` 遮蔽生成 struct，当时用
`CLANG_ENABLE_MODULES = NO` 规避、未从命名层根治）。完整方案与分档见 [`docs/zh-cn/c-naming.md`](docs/zh-cn/c-naming.md)。

- [x] **P0：`C_KEYWORDS` 扩展为完整保留字表**——覆盖 `c-naming.md` §4 中 ★ 标出的 libc/libm/POSIX 高频符号
      （`index`/`time`/`exit`/`free`/`read`/`write`/`close`/`open`/`log`/`sin`/`cos` 等）；`cIdent` 由「单次追加 `_`」改为
      「逐级加前缀」循环，防 `exit → _exit` 仍冲突
- [x] **P1：sanitize 覆盖到类名 / 局部变量 / 形参 / 模块变量**——`symbols.ts` `qualifiedName`/`sanitizePkg` 与
      `emit.ts` `declareVar` 统一走同一套 `sanitize`（现状类名 `Point`、局部变量 `var index` 均未受保护）
- [x] **P2：`sanitizeUsed` 已用名集合 + C23 `bool`/`true`/`false` 处理**——保证编译产物内 C 标识符两两不重名

**语义红线（关键坑）**：
- **保留 AS3 侧拼写不变**：sanitize 只作用于 C 标识符发射层；源码、符号表、props 反射表（`as_prop.name` 字符串）仍用原始
  AS3 名，否则 `o.union` / `for-in` 遍历 key / `toString` 输出的字段名会漂移
- **`index` 是最优先级坑**：历史代码里已有的 `index` 字段在引入完整表后会**改变生成的 C**，需回归 `examples/` 全量 + `benchmarks/`
  确认无破坏

**验收**：新增 `examples/stage76.as`（定义 `class` 含 `union`/`index`/`time`/`log`/`data` 等方法/字段名 + `var index` 局部变量 + 名为
`index` 的类/包名，断言 AS3 侧拼写不变、编译链接无符号冲突、运行输出正确）；回归 `examples/` 全量 + `benchmarks/` 无破坏；
README-CN.md 同步「当前限制」；版本号 v0.3.86 → v0.3.87。

---

#### 阶段七十七：try/finally 提前退出的异常栈卫生（return/break/continue 回退 `as_jmp_depth` + 运行 pending finally）（v0.3.88）✅ 已完成

**依据**：实证发现 setjmp/longjmp 异常处理的一个真实 P0 语义 bug——`try { return; } catch (e:Error) {}` 里
`emit.ts` 的 Return 发射只有 `return ...`，没有先回退 `as_jmp_depth`，导致 `as_jmp_depth++` 无配对的 `--`（深度永久 +1），
而 `_env` 是栈上 `jmp_buf`，函数返回后失效却仍残留在 `as_jmp_stack[0]`；此后任何一次 `as_throw` 都会
`longjmp(*as_jmp_stack[as_jmp_depth-1])` 到已销毁栈帧（未定义行为/崩溃）。同源缺口：`try { return } finally {...}` 里
finally 被 return 直接跳走；`break`/`continue` 跳出 try 也会漏 `as_jmp_depth--`。对标 Porffor 的 `render.js` K.Return case
（`if (activeTryDepth !== 0) emit('porf_try_depth -= N')`）。

- [x] **P0：return 跳出 try 前回退异常栈 + 运行 finally**——`emit.ts` 新增 `tryFrames` 栈（`active` 标记当前是否在
      try body 内、`finallyBody` 记录尚未运行的 finally 块）；Return/Break/Continue 发射前调 `emitUnwind(targetDepth)`
      逐帧 `as_jmp_depth--`（仅 active）+ 内嵌重发 pending finally（嵌套 C 块隔离局部变量，防 return/break/continue
      在 finally 内重复回退）
- [x] **P1：break/continue 跨 try 边界同样回退**——循环/switch 入口记录 `tryFrames.length`（`breakTargets`/
      `continueTargets`/label `tryDepth`），非抑制 break/continue 先 `emitUnwind(目标深度)` 再跳转
- [x] **P2：返回值语义**——AS3 先求值返回表达式、再运行 finally、再 return：有 try 作用域时把值捕获进临时变量
      （`T _ret = ...;`）→ `emitUnwind(0)` → `return _ret`，保证 finally 对局部变量的副作用不会被提前返回跳过

**语义红线（关键坑）**：
- **return 值求值顺序**：`return f()` 中 `f()` 的副作用必须在 finally 之前发生，故值先捕获到临时变量再 unwind
- **finally 重发的局部变量隔离**：重发 finally 与内联发射同一 C 作用域，须用嵌套 `{}` + `pushScope`/`popScope` 隔离
  （`cIdent` 缓存会令同名 `var` 映射到同一 C 名，否则重声明冲突）
- **catch 内 return 不重发 finally**：catch 分支运行时帧已 pop（`else` 分支 `as_jmp_depth--`），但 finally 仍未运行，
  故 `frame.active=false` + `finallyBody` 待发——两状态解耦才能同时处理 try body 内 return（active+finally）与
  catch 内 return（仅 finally）

**验收**：新增 `examples/stage77.as`（覆盖 return/break/continue 跳出 try + finally 运行、嵌套 finally 顺序、
return-in-catch、return-in-finally 覆盖返回值，并紧随提前 return 后 throw 验证异常栈平衡）；回归 `examples/` 全量无破坏；
版本号 v0.3.87 → v0.3.88。

---

#### 阶段七十八：体积优化 static 化（内建类方法体/thunk/prototype 加 `static`，`-O2` 自动 tree-shake）（v0.3.89）✅ 已完成

**依据**：实测发现产物二进制的体积大头不是 `RUNTIME_PREAMBLE`（其函数早就是 `static`，`-O2` 已消未引用的），
而是 **内建类方法体 + thunk 被发射成全局符号**（`nm` 里 443 个 `T`）。全局符号 clang 必须假设「其他编译单元可能
引用」，`-O2` 无法做 DCE；而 vtable/props/methods 反射表本就是 `static`、被全局方法体引用，于是「方法体→反射表」
整条链全部存活。`hello.as` 二进制 165 KB 里几乎全是没碰过的 `ByteArray_compress`/`Date_ctor`/`MovieClip_play` 等死代码。

**方案**：放弃早期「按需发射 + AST 引用扫描 + fixpoint + 内建类横向依赖边表」的重方案（`p0-tree-shaking.md`，已删），
改为 **把非导出的文件作用域函数统一标 `static`**，让 `-O2` 从 `main` 出发做完整调用图分析、自动剪枝：
`main` 不碰 `Date` → `Date_new` 不可达 → `Date_vt` 不可达 → `Date_methods`/`Date_props`/`Date_getTime`/thunk 全消。
横向引用（`Transform_ctor→Matrix_new`、`Shape_ctor→Graphics_new`、`Stage_dispatchFrame→MovieClip/Timer` 等非继承调用）
由 `-O2` 的调用图分析自动覆盖，无需任何依赖边表。

- [x] **P0：`emit.ts` 新增 `staticizeTopLevelFunctions()`**——`run()` 发射完 `main` 后，逐行识别「顶格 `返回类型 函数名(`」
      的函数定义/声明加 `static`（跳过 `static`/`typedef`/`extern`/`struct`/预处理/注释/缩进行），`main` 与
      `[WasmExport]` 导出符号（`symbol` + 别名 wrapper）保持全局（wasm 导出表 / 跨编译单元可见所需）
- [x] **P1：多目标与 glue 层不受影响**——`air-native` 的 Skia/SDL2/Metal glue 经**函数指针回调**生成的 `.c`，不要求
      `.c` 内部符号全局；全量链接验证通过

**验收**：`hello.as` 二进制 165 KB → 34 KB（-80%），全局 text 符号 443 → 2，输出逐字一致；`node test.ts` 全量回归
80 passed / 0 failed（含 `air-native` 全量 Skia/SDL2 链接、`wasm-native` 导出、GUI 窗口示例）；文档同步
[`docs/zh-cn/size-optimization.md`](docs/zh-cn/size-optimization.md)，删除 `p0`/`p1`/`p2` 三个草案；版本号 v0.3.88 → v0.3.89。

---

#### 阶段七十九：Stage3D 前置几何类（`Matrix3D` + `Vector3D`）（v0.3.90）✅ 已完成

**依据**：[`docs/zh-cn/display3d.md`](docs/zh-cn/display3d.md) §6 阶段 A。`Matrix3D`/`Vector3D` 是纯逻辑类，
与已实现的 `Matrix`/`Point` 同套路（`symbols.ts` 内建建模 + `runtime.ts` 助手），**不碰 GPU**，风险低、可独立验收。
它们是 `Context3D` 隐式依赖（`setProgramConstantsFromMatrix` 传 `Matrix3D`、`Vector.<Number>` 传顶点常量）。

- [x] **P0：`Vector3D`**——x/y/z/w 四分量，`add`/`subtract`/`scaleBy`/`negate`/`normalize`/`dotProduct`/`crossProduct`/
      `distance`/`angleBetween`/`length`/`lengthSquared`/`clone`/`equals`/`toString` + 静态常量 `X_AXIS`/`Y_AXIS`/`Z_AXIS`
- [x] **P1：`Matrix3D`**——4×4 列主序（column-major，与 `Matrix` 的行主序**不同**），`identity`/`append`/`prepend`/`invert`/
      `transpose`/`transformVector`/`transformVectors`/`deltaTransformVector`/`pointAt`/`interpolate`/`recompose`/`decompose`/
      静态 `interpolate`/`clone`/`copyFrom`/`identity`，平移/缩放/旋转（xyz 轴 + 任意轴）构造
- [x] **P2：`Vector.<Number|uint|float>` 类型系统补全**——现有 `Vector.<T>` 已建模，确认三数值实例化的 GC 标量扫描正确（新增 `noteBuiltinVectorSpecs` 注册内建类方法签名引用的 `Vector.<Number>`/`Vector.<Vector3D>`，并把 vector typedef 提前到 vtable 之前发射）

**语义红线（关键坑）**：
- **列主序 vs 行主序**：`Matrix3D.rawData` 是列主序 16 元素 `Vector.<Number>`（`rawData[1]` 是第 1 列第 2 行），与
  `Matrix` 的行主序相反；`transformVector` 用列向量 `M · v`，与 OpenGL/MSL 的 `float4x4` 内存布局需显式对齐
- **`Matrix3D.invert()` 语义**：原位修改 `this`（与 `Matrix.invert()` 一致），但额外返回 `Boolean` 表示是否可逆（行列式非零）；不可逆时保持原矩阵不变并返回 `false`

**验收**：新增 `examples/stage79.as`（断言矩阵乘法/求逆/变换向量与 mxmlc 对照、`decompose`/`recompose` 往返一致）；
回归 `examples/` 全量无破坏；版本号 v0.3.89 → v0.3.90。

---

#### 阶段八十：AGAL 字节码内核（解析器 + 校验器 + MSL/GLSL 翻译器，AGAL1/2/3）（v0.3.91）✅ 已完成

**依据**：[`docs/zh-cn/display3d.md`](docs/zh-cn/display3d.md) §3/§6 阶段 B。**这是整块里最硬、唯一真正难的一步**
（约占 40% 工作量），但它是**纯 C/C++ 胶水层里自包含的确定性翻译器**，不碰前端「AS3→C」主管线，符合 AGENTS.md §2.9
「重活走链接/胶水」铁律。权威参照：Ruffle 的 AGAL→wgpu/WebGPU 实现 + 社区多个 AGAL→GLSL 开源实现。

- [x] **P0：AGAL 字节码解析器（AGAL1/2/3）**——识别 magic `0xa0` + version（1/2/3）+ program type（vertex/fragment）+ shader type，
      逐条解码 32-bit token（`opcode | dest | src1 | src2 | swizzle/mask`），≤200 指令/程序；寄存器模型按 version 分档
      （`va`/`vc`/`vt`/`op`/`oc`/`v`/`fs` 等，具体上限见下方「AGAL version 分档」红线）
- [x] **P1：AGAL 校验器**——把 `Program3D.upload` 的 40+ 条校验错误完整实现（寄存器越界、swizzle/mask 非法、
      操作数类型不匹配、指令计数超限等），抛对应 `Error`
- [x] **P2：AGAL → MSL（native）+ GLSL ES（web）翻译器**——28 条基础指令（`mov`/`add`/`sub`/`mul`/`div`/`rcp`/`min`/`max`/
      `frc`/`sqt`/`rsq`/`pow`/`log`/`exp`/`nrm`/`sin`/`cos`/`dp3`/`dp4`/`crs`/`m33`/`m34`/`m44`/`abs`/`neg`/`sat`/`kil`/`tex`）
      带 swizzle 与 write-mask；AGAL2 控制流（`ife`/`ine`/`ifg`/`ifl`/`els`/`eif` → MSL/GLSL `if/else`）+ 导数
      （`ddx`/`ddy` → `dfdx`/`dfdy`）+ MRT（`oc0-3` → `[[color(i)]]`）；AGAL3 `iid` → `[[instance_id]]`、`vs` → 顶点纹理采样；
      寄存器映射 `float4`、`tex` 映射 `texture2d.sample()`（MSL）/`texture()`（GLSL）

**语义红线（关键坑）**：
- **AGAL version 分档（1/2/3）**：解析器读 magic 后的 `version` 字段并按代分档寄存器上限——`va`：v1/v2=7、v3=15；
  `vc`：v1=127、v2/v3=249；`vt`：v1=7、v2/v3=25；`v`（varying）：v1=7、v2/v3=9；`fc`：v1=27、v2=63、v3=199；
  `ft`：v1=7、v2/v3=25；`fo`：v1=0（仅 `oc`）、v2/v3=3（MRT `oc0-3`）；`fd`（`od` 深度输出）：v1 无、v2/v3 有；
  `iid`（实例化）与 `vs`（顶点纹理采样）：仅 v3
- **swizzle 与 write-mask 是两套正交机制**：src 的 swizzle（`.xyzw` 重排）与 dest 的 write-mask（`.xyzw` 选择写入通道）
  要分别映射，MSL 无 swizzle 语法，需展开为显式分量访问
- **寄存器约束**：`vc` 用 `setProgramConstantsFrom*` 上传、`fs` 用 `setTextureAt` 绑定，翻译器须生成正确的
  uniform/texture 声明序；vertex 输出 `op`（position）与 fragment 输入 `v`（varying）语义成对

**验收**：新增 `examples/stage80.as`（内嵌一段按官方 `AGALMiniAssembler.as` 编码的 vertex+fragment 字节码，断言翻译出的
MSL/GLSL 含预期指令与 swizzle/mask 展开，校验器对非法指令抛错）；回归 `examples/` 全量（82 passed）；版本号 v0.3.90 → v0.3.91。

**落地说明**：P1 校验器本阶段落地的是**基础校验子集**（magic/version/program-marker/opcode 合法性/截断/指令数上限/空程序），
翻译器失败统一返回 NULL 并设 `as_agal_errmsg`（`AGALTranslator.translate` 桥接抛 `Error`）；`Program3D.upload` 的 40+ 条完整
校验（寄存器越界、swizzle/mask 非法、操作数类型不匹配、AGAL2 控制流平衡等）在阶段八十一 `Program3D` 落地时复用本翻译器一并补齐。
翻译器暴露为内建类 `AGALTranslator`（纯静态桥，非 AS3 运行时 API），`translate(bytes:ByteArray, target:String):String`，`target`
为 `"msl"`（默认）或 `"glsl"`。

**关键坑（对官方规范的纠偏）**：AGAL 寄存器 type 是 **shader 相对编码**，不是全局唯一——`va=0`、`vc=1`、`vt=2`、`op/vo=3`、
`varying(vi/i/v)=4`、`fs=5`、`od/fd=6`、`iid=7`，且 fragment 复用同一套码（`fc=1`、`ft=2`、`oc/fo=3`、`vs=5`），翻译器须结合
`isFragment` 分派而非按 type 硬编码寄存器名。dest token 是 `[num:16][mask:8][type:8]`（type 占 8 位、位 24-31，非 4 位），
source token 是 `[num:16][offset:8][swizzle:8][type:8][reltype:8][relsel+indirect:16]`（type 占 8 位，在 s1hi 低 8 位）；
sampler token（`tex`/`tld` 的 src2）是 `[num:16][lod:8][0:8][samplerbits:32]`（samplerbits 低 8 位=5，各字段 shift：type=8/
dim=12/special=16/repeat=20/mipmap=24/filter=28）。opcode 表补齐 `sgn=0x2b`、`tld=0x2e`（`ted=0x26` 在 AGAL2 不可用）。
权威源已内嵌为 `examples/shmup-stage3d/src/com/adobe/utils/AGALMiniAssembler.as`。

---

#### 阶段八十一：`Stage3D` + `Context3D` 骨架（状态机 + 资源类 + `drawTriangles`）（v0.3.92）

**依据**：[`docs/zh-cn/display3d.md`](docs/zh-cn/display3d.md) §4/§6 阶段 C。`Context3D` 是纯状态机（C 结构即可），
不涉及像素，可与阶段八十翻译器解耦。前端零改动——`Stage3D`/`Context3D` 全是普通内建类，走 `symbols.ts` 建模。

- [x] **P0：`Stage3D` + `Context3D` 状态机**——`Stage.stage3Ds` 返回实例、`requestContext3D`/`context3D`/`x`/`y`/`visible`
      发 `context3DCreate` 事件；`Context3D` 约 30 个方法：`configureBackBuffer`/`clear`/`present`/`drawTriangles`/
      `setVertexBufferAt`/`setProgram`/`setTextureAt`/`setBlendFactors`/`setDepthTest`/`setCulling`/`setStencilActions`/
      `setRenderToTexture`/`setScissorRectangle`/`setProgramConstantsFrom*`/`setColorMask`/`drawToBitmapData` 等；
      `enableErrorChecking=false` 走异步路径（首期只做异步）
- [x] **P1：资源类**——`VertexBuffer3D`/`IndexBuffer3D`/`Program3D`（`upload(AGAL字节码)`）/`Texture`（BGRA/RGBA）/
      `TextureBase`，用 `ByteArray` 小端读
- [x] **P2：15 个常量类**——`BlendFactor`/`BufferUsage`/`ClearMask`/`CompareMode`/`FillMode`/`MipFilter`/`Profile`/
      `ProgramType`/`RenderMode`/`StencilAction`/`TextureFilter`/`TextureFormat`/`TriangleFace`/`VertexBufferFormat`/`WrapMode`

**语义红线（关键坑）**：
- **`Profile` 首期收敛 `BASELINE`**（AGAL1 + 非压缩 2D/cube 纹理 + 无实例化/MRT），`BASELINE_EXTENDED`/`STANDARD` 返回
  支持但功能按 baseline 落地，覆盖 Stage3D 最大真实消费者 Starling
- **`VideoTexture`/压缩纹理明确排除**（返回 null / 只支持无压缩回退），`driverInfo`/`totalGPUMemory` 语义近似即可
- **`drawTriangles` 首期只铺 3 顶点非索引路径**，索引/实例化后续

**验收**：新增 `examples/stage81.as`（走 `requestContext3D`→`configureBackBuffer`→`setProgram`→上传缓冲→`drawTriangles`
状态机全链路，断言各状态字段与常量类枚举值正确）；回归全量；版本号 v0.3.91 → v0.3.92。

**落地说明**：P0/P1/P2 全落地。`Context3D` 是纯 CPU 状态机（blend/depth/cull + 绑定资源 + 顶点/纹理流 + vertex/fragment
常量，`setProgramConstantsFromMatrix` 按 AS3 语义落地：transposed=false 时列主序转置为行主序上传、true 时原样拷贝），
`clear`/`present`/`drawTriangles` 首期仅记录状态（真正 GPU 上屏在阶段八十二）；`Stage3D` 懒创建 `Context3D` 并同步派发
`context3DCreate`。15 个常量类用 `constClass` 落地（string 值对照 AIR）。资源类 `VertexBuffer3D`/`IndexBuffer3D`/`Program3D`/
`Texture`/`TextureBase` 仅持 CPU 拷贝（`uploadFromVector`/`upload` 记录源缓冲，GPU buffer 对象在阶段八十二）；`Program3D.upload`
首期仅记录字节码、未做 AGAL 校验（阶段八十遗留的 40+ 条完整校验在阶段八十二 `drawTriangles` 复用翻译器时补齐）。

---

#### 阶段八十二：Metal 端到端三角形（裸 MTLBuffer/渲染通道/MSL 上屏）（v0.3.93）✅ 已完成

**依据**：[`docs/zh-cn/display3d.md`](docs/zh-cn/display3d.md) §5/§6 阶段 D。复用阶段七十五已落地的 `metal_glue.mm`
（同一 `MTLDevice`/`MTLCommandQueue`），新增**裸** Metal 命令缓冲路径（不经 Skia Ganesh）：`MTLBuffer` 顶点/索引、
`MTLTexture`、`MTLLibrary`（`newLibraryWithSource` 编译阶段八十的 MSL）、`MTLRenderPipelineDescriptor`、`MTLDepthStencilState`、
`MTLRenderPassDescriptor`（render-to-texture）。

- [x] **P0：`stage3d_glue.mm` 裸管线**——独立于 `metal_glue.mm`（Skia Ganesh）的自包含离屏桥（`vendor/stage3d_glue.mm`）：
      `MTLBuffer`（顶点/索引/常量）/`MTLTexture`（2D，BGRA8Unorm）/`MTLLibrary`（MSL 编译）/`MTLRenderPipelineDescriptor`/
      `MTLRenderPassDescriptor`（离屏 render-to-texture），`extern "C"` 平坦接口 `s3d_create/resize/destroy/upload_vertex/`
      `upload_index/upload_constants/upload_texture/compile/clear/set_blend/draw/readback/width/height`
- [x] **P1：`drawTriangles` 走 `drawIndexedPrimitives`**——`drawTriangles` 作为唯一 GPU 同步点，延迟上传所有绑定资源
      （vertex streams 8..15 绑 `MTLBuffer`、索引、vc/fc 常量、纹理），按 `Program3D` 指针缓存编译 MSL pipeline（不每帧重编），
      经 `drawIndexedPrimitives`（索引）或 `drawPrimitives`（非索引）提交；`clear` 写清屏色、`setBlendFactors` 控制混合
- [x] **P2（延后）：与 2D 表面合成**——离屏优先、可测试为核心；把离屏目标与 Skia 2D 表面合成到同一 CAMetalLayer drawable 留后续

**语义红线（关键坑）**：
- **Ganesh 与裸 Metal 在同一 `MTLDevice` 上共存**：Skia 2D 用 Ganesh 抽象，Stage3D 三角形直接 `MTLBuffer` + 描述符，
  二者经同一 `MTLCommandQueue` 提交、共享同一 drawable 上屏，**不可**各自建独立 device/queue
- **顶点布局**：`setVertexBufferAt(i, buffer, offset, format)` 的 format（FLOAT_1/2/3/4）映射 MSL 的
  `[[attribute(i)]]` + `MTLVertexDescriptor`；**buffer index 0 保留给顶点常量 vc**，vertex streams 绑 8..15（`S3D_STREAM_BASE=8`）防冲突
- **ARGB↔BGRA**：`BitmapData.pixels` 是 ARGB（0xAARRGGBB），Metal 目标纹理 BGRA8Unorm，上传/读回都要转换
- **MSL varying 必须走 `[[stage_in]]` 结构体**：fragment 的 varying 输入不能写成裸 `[[user(locn)]]` 参数（Metal 静默当 0，
  导致读回全黑），必须 `struct FSIn { float4 v0 [[user(locn0)]]; }` + `FSIn in [[stage_in]]`

**验收**：新增 `examples/stage82.as`（彩色三角形，`requestContext3D` + `drawTriangles` + `present`，纯 C 断言状态机 + MSL 翻译、
Metal 模式断言中心像素红色）+ `examples/stage82.build.json`（链接 `stage3d_glue.mm` + `ASC_RENDER_STAGE3D` + Metal/Foundation）；
回归全量（84 passed）；版本号 v0.3.92 → v0.3.93。

---

#### 阶段八十三：Stage3D 对齐加固（`drawToBitmapData`/render-to-texture/AGAL2/3）（v0.3.94）✅ 已完成

**依据**：[`docs/zh-cn/display3d.md`](docs/zh-cn/display3d.md) §6 阶段 E。baseline 跑通后补齐高频进阶能力。

- [x] **P0：`drawToBitmapData` + `setRenderToTexture`**——离屏渲染目标（`MTLRenderPassDescriptor` 绑 MTLTexture）读回像素；`drawToBitmapData` 改为读当前渲染目标（render override 优先，否则回退 back buffer）
- [x] **P1：CubeTexture/RectangleTexture**——六面体/矩形纹理类型补全（CPU 描述符：CubeTexture 六面 BitmapData + RectangleTexture 单 BitmapData；`Context3DCubeMapFace` 为 int 常量类）
- [x] **P2：AGAL3 实例化**——`drawTrianglesInstanced` 走共享 `Context3D_submit`（唯一 GPU 同步点），`s3d_set_instance_count` → `drawPrimitives(instanceCount:)`；`setProgramConstantsFromVector` 上传 `Vector.<Number>` 到 vc/fc

**语义红线（关键坑）**：
- `setRenderToTexture` 的纹理不得同时作为采样输入（`MTLTextureUsage` 需 RenderTarget|ShaderRead）——`s3d_create_render_texture` 已声明双 usage
- 渲染目标纹理句柄在 MRC（非 ARC）下用 `[tex retain]`/`[tex release]` 管理（`s3d_create_render_texture`/`s3d_destroy_texture`）
- AGAL3 `iid` → `[[instance_id]]` 与 MRT 多输出仍留待后续（demo 未用实例化/多输出）

**验收**：新增 `examples/stage83.as`（CubeTexture/RectangleTexture 字段断言 + render-to-texture 读回像素断言 + `drawTrianglesInstanced` 2 实例 + `setProgramConstantsFromVector`）；纯 C（state machine）与 Metal 双模式通过；回归全量 85 passed；版本号 v0.3.93 → v0.3.94。

---

#### 阶段八十四：`shmup-stage3d` 集成验收（真实 Stage3D demo 跑通）（v0.3.95）✅ 已完成

**依据**：把阶段七十九~八十三的 Stage3D 能力用真实端到端 demo `examples/shmup-stage3d/`（Starling 风格
`LiteSpriteBatch` + 官方 `AGALMiniAssembler`）整体编译/链接/运行验收，逐项排除编译与运行期 blocker。

- [x] **函数作用域 `var` 提升（hoist）**——方法体内 typed 局部变量统一提升到函数顶部声明（`functionScope` +
      `hoistedLocals` + `hoistFunctionLocals`/`collectHoistedVars`），修复“跨块使用后定义”的 `undefined variable 'k'`；
      无类型 `var x = expr` 保持块级（避免需纯表达式类型推导）
- [x] **`static const` 运行时初始化器**——`static const d = new Dictionary()` / RegExp 字面量等非常量初值改为
      可写静态 + `staticFieldInits` 在 `main()` 入口按类序执行（`isConstExpr` 仅 `Num/Str/Bool/Null` 为真），
      `emitGCRoots`/`emitModuleVars`/`emitTopLevel` 同步只跳过字面量 const
- [x] **`Rectangle` getter/setter 作 lvalue**——`destRect.left = 0` 等 setter 赋值生成 `gesetter`/`rs` 定义，
      `left/top/right/bottom` 四个 setter C body 补齐
- [x] **`TextField` 子类结构体布局**——`_para`/`_para_text` 等 C 运行时缓存字段改为按字段循环触发
      （`isSubclassOf(name,'TextField')`），否则 `class GameGUI extends TextField` 的 struct 缺字段导致偏移错位、
      运行时读指针崩溃（`sk_textlayout_delete` 读到标题字符串指针）
- [x] **RegExp 控制字符转义**——`as_re_bits_add_esc`/`as_re_comp_escape` 补 `\n \r \t \f \v \0` 映射为控制字节
      （原实现落到 `default` 当字面字母），修复 `AGALMiniAssembler` 里 `replace(/[\f\n\r\v]+/g,"\n")`/`split`
      把 shader 里的 `v`（如 `va0`/`vc0`）误替换、逐行 `match(/^\w{3}/)` 全判 `bad line` 导致 AGAL 装配失败
- [x] **Matrix3D append/prepend 语义**——对照 mxmlc 实测 + AIR reference 定案：`append(lhs)=lhs*this`（前置相乘）、
      `prepend(rhs)=this*rhs`（后置相乘）；`stage79.as` 原断言按 post-multiply 写反，已改为 Scale→Rotation→Translation
      构造 `T*R*S` 再 decompose，并新增不可交换（旋转+平移）的 append/prepend 顺序断言锁死方向
- [x] **`setProgramConstantsFromMatrix` 转置语义**——交换为 `transposedMatrix=true` 转置（vc0=数学行 row0）、`false`
      原样拷贝（vc0=列 col0），经 vc dump（row0/row1）+ demo 全屏精灵渲染实证正确（修正阶段八十一反着的描述）
- [x] **AGAL→MSL `dp3`/`dp4` 部分 write-mask**——`dp3/dp4` 遇 `.xy` 等部分 write-mask 时按通道逐个展开而非整体赋值，
      否则 `vt0.xy` 的 z/w 被误写；AGALMiniAssembler 每条指令固定 24 字节（192 bit）槽位，stage80/82 手写字节码补零填充
- [x] **Metal blend 状态属 pipeline**——blend factors 须在 `s3d_compile` 前传入；MSL fragment 的 varying 输入不能写裸
      `[[user(locn)]]` 参数（Metal 静默当 0 读回全黑），必须 `struct FSIn{float4 v0[[user(locn0)]]}+FSIn in[[stage_in]]`
- [x] **Dictionary for-in 类型化循环变量 unbox**——`for (tgt:Object in dict)` 原生成 `tgt = dict->keys[i]`（as_value 赋
      Object* 编译错），已按声明类型 `unboxAny`；air-native 示例重新编译通过
- [x] **复合成赋值丢旧值**——`obj.prop += v`（getter/setter）与 `Class.field += v`（静态字段）原只发 setter/直接赋值丢旧值，
      已改为读 getter/旧值再合并（`set(obj, get(obj) OP v)`），配 `examples/compound.as` 回归

**验收**：`as-aot --air-app examples/shmup-stage3d/shmup-stage3d-app.xml` 一条命令编链出 `shmup-stage3d` 可执行并运行
（Stage3D 上下文创建 → sprite 引擎 → 加载器 → 帧循环），**精灵正确上屏**（截图确认灰金属飞船/橙残骸/金箭头/蓝绿物件全屏散布 +
HUD `457 created 1720 reused FPS 80`，且 `sprite.rotation += 0.1` 复合成赋值修复后实体旋转生效）；隔离正则回归逐行正确；
回归全量 86 passed；版本号 v0.3.94 → v0.3.95。

---

#### 阶段八十五：Stage3D/Skia 帧循环内存泄漏修复（MRR 裸 Metal + 离屏合成纹理复用）（v0.3.96）✅ 已完成

**依据**：`shmup-stage3d` 实测 7.62 GB 严重泄漏（RSS 线性爬到 7.62 GB）+ `air-native` 缓慢泄漏。逐项定位后归纳为两类根因：

1. **MRC 裸 Metal 路径从不 release 覆盖旧指针**——`stage3d_glue.mm` 以 `clang++ -std=c++17` 无 `-fobjc-arc` 编译，
   `newBufferWithBytes`/`newTextureWithDescriptor` 等 `new*` 方法返回 +1 owned，但每帧 `s3d_upload_vertex`/`index`/`constants`
   覆盖旧指针从不 release；纹理因 `Texture->gpu` 恒为 NULL 每帧重上传（~256KB×80fps）；`s3d_resize`/`s3d_compile` 临时对象不 release。
   修复：覆盖前 release 旧对象，`s3d_compile` 成功后 release `pd/vfn/ffn/vlib/flib`，`s3d_destroy` 释放 context 拥有对象
   （device/queue/target/pso/buffers，**不**释放借用的 textures/renderOverride 以免 double-free）。
2. **autoreleased Metal 对象在无池主循环累积**——`commandBuffer`/`renderPassDescriptor`/`renderCommandEncoder`/`nextDrawable`
   为 autoreleased(+0)，C++ SDL 主循环无 autorelease pool。修复：`s3d_draw`/`s3d_readback`/`s3d_readback_render`/`sk_mtl_begin_frame`
   包裹 `@autoreleasepool`；`sk_mtl_flush` 整函数包裹（含 `flushAndSubmit`，其 Ganesh Metal 后端同样造 autoreleased 对象）。
3. **`Texture->gpu` 所有权模型**：`s3d_upload_texture` 返回值从 `int` 改为 `void*` 句柄，emit.ts `Context3D_submit` 缓存
   `o->tex{i}->gpu = as_s3d_upload_texture(...)`，后续帧绑定而非重上传；`Texture_uploadFromBitmapData`（miplevel 0）先销毁旧 GPU
   句柄再更新 bitmapData。`c->textures[unit]`/`c->renderOverride` 为借用引用。
4. **残留泄漏根因 = `sk_canvas_draw_bgra` 每帧 `RasterFromPixmapCopy` + `drawImageRect`**：离屏 render target 读回后合成上屏，
   每帧复制 2000×1200×4 并铸造新 GPU 纹理 + blit command buffer + blit context，驱动内部对象（`AGXG14XFamilyCommandBuffer`/
   `BlitContext` 各 1/frame）不受应用层 `@autoreleasepool` 控制，线性 ~165KB/s。**正确修复 = GPU→GPU 直接合成**：新增
   `s3d_get_render_target` 暴露离屏 MTLTexture，`metal_glue.mm` 新增 `sk_mtl_draw_texture`（`SkImages::BorrowTextureFrom`
   包装现成 GPU 纹理 + `drawImageRect`），`Context3D_present` 在 Metal 路径直接暴露纹理句柄（不再 CPU 读回），合成阶段直接
   blit 该纹理——**彻底取消 CPU 读回 + CPU→GPU 重上传往返**，故无每帧纹理铸造、无 blit 驱动对象。
   ⚠️ 曾尝试「缓存单一 `SkBitmap` + `notifyPixelsChanged()`」但**该法有致命缺陷**：`SkImages::RasterFromBitmap` 对可变 bitmap
   走 `kIfMutable_SkCopyPixelsMode` **复制**像素，缓存 image 冻结首帧像素、`notifyPixelsChanged()` 只作用于原 bitmap 不传播到
   副本，导致 demo 实体全部消失（黑屏只剩 HUD）——这是「内存平缓」的假象（因不再每帧上传）。已回退 `sk_canvas_draw_bgra`
   为 `RasterFromPixmapCopy`（仅 CPU raster 合成路径用，无 GPU 上传无泄漏），Metal 路径改走 GPU→GPU。

**语义红线（关键坑）**：
- Metal `new*` 方法返回 +1（owned），`commandBuffer`/`renderPassDescriptor`/`renderCommandEncoder`/`nextDrawable` 为 autoreleased(+0)——MRC 下必须显式平衡；`@autoreleasepool` 必须覆盖整帧（含 Skia `flushAndSubmit`）。
- **驱动内部对象（`AGXG14XFamilyCommandBuffer`/`Agx BlitContext`）不受应用层 `@autoreleasepool` 控制**，只能从源头避免每帧铸造新 GPU 资源。
- **`SkImages::RasterFromBitmap` 对可变 bitmap 会复制像素**（`kIfMutable_SkCopyPixelsMode`）：缓存它 + `notifyPixelsChanged()` 无法重上传副本，会冻结首帧内容；要每帧更新 GPU 纹理须用 `BorrowTextureFrom` 包装现成 MTLTexture 直供合成。
- 直测 RSS 须用真实二进制进程（`pgrep -f '^\./xxx$'`），`$!` 会误捕 bash wrapper PID。

**验收**：`shmup-stage3d` RSS 从 7.62 GB 降回基线 ~112-117MB 且稳定（不再线性爬升）；`air-native` RSS 稳定 ~113MB；
回归全量 86 passed；版本号 v0.3.95 → v0.3.96。

---

#### 阶段八十六：`flash.utils` 反射 API（`getQualifiedClassName` + `getDefinitionByName`，`describeType` 延后）（v0.3.97）✅ 已完成

**依据**：对 [AIR `flash.utils` 包级函数](https://airsdk.dev/reference/actionscript/3.0/flash/utils/package.html) 官方参考逐项核对，
再结合 `examples/air-starling-demo`（Starling 框架，142 文件）逐文件用法核对。三函数是 Starling 核心（`Event.type` 派发、
`DisplayObject.isOfType` 继承链判断、`Effect` 的 program 缓存 key、对象池 `Pool`、`Game.showScene` 场景动态实例化），
此前 `emitGlobalCall` 未建模 → 一编译就 `unknown function` 报错，是 Starling 的编译期硬阻塞。

**三函数官方语义逐一对比**：

| 函数 | 官方签名 | 官方语义 | Starling 用法 | 落地 |
|---|---|---|---|---|
| `getQualifiedClassName` | `(value:*):String` | 返回对象完全限定类名（`包::类`，如 `flash.display::Sprite`）；原始类型返回 `"int"/"uint"/"Number"/"Boolean"/"String"/"void"/"null"` | 13 处：`== "starling.xxx::Yyy"` 精确比较、`.split("::").pop()` 取短名、program 缓存 key | vtable header 加 `fqn` 字段 + 运行时 tag 分派 |
| `getDefinitionByName` | `(name:String):Object` | 返回类引用（Class）；找不到抛 `ReferenceError`；`::`/`.` 两种分隔符均接受；`Vector.<T>` 用 `"__AS3__.vec::Vector.<T>"` | 3 处：`Game.showScene` 与 `getQualifiedClassName` 往返闭环、`SystemUtil`/`TouchProcessor` 探测 `flash.desktop::NativeApplication` | 编译期全局注册表 `as_class_registry[]` + 运行时线性查找 |
| `describeType` | `(value:*):XML` | 返回描述类的 XML（`<type name base isDynamic isFinal isStatic>` + `<extendsClass/>`/`<implementsInterface/>`/`<variable/>`/`<accessor/>`/`<constant/>`/`<method/>`/`<parameter/>`/`<factory/>`） | 2 处：`AssetManager` 遍历 `constant.(@type=="Class")`/`variable.(@type=="Class")` 找 Embed 元数据 | **延后**：硬阻塞在 XML/E4X（项目已明确延后 `isXMLName`） |

- [x] **P0：`getQualifiedClassName(value)`**——vtable header 新增 `const char* fqn` 字段存 AS3 限定名
      （`packageName ? packageName + "::" + name : name`，由 `ClassInfo.fqn` 编译期拼出，避免从 sanitize 后 C 名逆向）；
      运行时 `as_get_qualified_class_name(as_value)` 按 tag 分派：`0→"null"`、`1→"Number"`、`2→"Boolean"`、`3→"String"`、
      `5→"void"`、`6→"Array"`、`7→"Function"`、`4→` 读 vtable `fqn`（object 实例 / `as_class*` 均第一字段为 vtable，天然统一）；
      `emitGlobalCall` 加 case（`boxExpr` 统一装箱后传 as_value）。
- [x] **P0：`getDefinitionByName(name)`**——编译期发射全局注册表 `as_class_registry[]`（`{ fqn, as_class{vtable, factory} }`，
      只收集用户类即 `ClassInfo.fqn` 非空的类；无参构造填 `Foo_new`，有参构造填 `NULL`），运行时 `as_get_definition_by_name`
      线性查找，命中返回 `as_v_obj(&reg.cls)`（box 成 tag 4，`as Class` 转回 `as_class*` 再 `new`），未命中 `as_throw(ReferenceError_new(...))`。
      查找同时接受 `::` 与 `.` 两种分隔符（`getQualifiedClassName` 输出 `::` 形、官方示例传 `.` 形，二者需互通）。
- [x] **P0：`ReferenceError` 内建子类**——`emitBuiltins` 的 Error 子类数组补 `ReferenceError`（`catch (e:ReferenceError)` 可精确匹配），
      `getDefinitionByName` 找不到时抛它；Starling `SystemUtil.initialize` 的 `catch (e:Error)` 据此识别 AIR 缺失（`flash.desktop::NativeApplication`
      非本项目内建类，天然不在注册表 → 抛错 → `sAIR=false`，语义正确）。
- [ ] **P1（延后，阶段八十七）：`describeType`**——依赖 XML/E4X 内建（项目已延后），本阶段 `emitGlobalCall` 加 case 编译通过、
      运行时 `as_describe_type_not_impl()` 抛 `Error("describeType requires XML/E4X support")`（**明确抛错而非静默降级**，符合 AGENTS.md §2.5）。

**语义红线（关键坑）**：
- AS3 限定名分隔符是 `::`（不是 `.`），`getQualifiedClassName` 输出 `::` 形、`getDefinitionByName` 同时吃 `::`/`.` 两种；
  往返闭环（`MainMenu` 存 `getQualifiedClassName(sceneClass)` → `Game` 用 `getDefinitionByName(name)` 取回）依赖这一致性。
- `as_class` 与 `as_object_header` 第一字段都是 `vtable`，故 `as_class*` box 成 tag 4 后 `getQualifiedClassName` 读 `((as_object_header*)ptr)->vtable`
  即得类 vtable、返回类名——Class 值与实例值走同一路径，无需额外分支。
- **int/uint 精度限制**：`boxExpr` 把 int/uint 均 box 成 number（tag 1），故 `getQualifiedClassName(5)` 返回 `"Number"` 而非 `"int"`
  （AS3 中 5 是 int 字面量应返回 `"int"`）。Starling 全部调用只传对象/Class 值，不传原始类型，故无影响；README「当前限制」已记录。
- 注册表只收用户类（内建类 `packageName` 为空、`fqn` 未填），故 `getDefinitionByName("flash.display.Sprite")` 会抛 ReferenceError
  ——与「内建 flash 类不进注册表」一致；本项目无 AIR 运行时，`NativeApplication` 等 AIR 专属类天然缺失即正确语义。

**验收**：新增 `examples/stage86.as`（多包多类：`getQualifiedClassName` 原始类型 + 对象/Class + 继承链 + 内建类 tag 分派；
`getDefinitionByName` 往返闭环 `new (getDefinitionByName(getQualifiedClassName(x)) as Class)()` + `.`/`::` 两种分隔符 + 找不到抛
`ReferenceError` 被 catch 捕获）；回归全量 87 passed / 0 failed；版本号 v0.3.96 → v0.3.97。

---

#### 阶段八十七：`Context3D` 骨架补方法（Starling 前置 Tier 3，缺 5 个）（v0.3.98）✅ 已完成

**依据**：对 [AIR `flash.display3D.Context3D`](https://airsdk.dev/reference/actionscript/3.0/flash/display3D/Context3D.html)
官方参考逐项核对，再结合 `examples/air-starling-demo`（Starling 框架，142 文件）逐文件用法核对。Stage3D 核心管线
（阶段七十九~八十五）已做完、`shmup-stage3d` 端到端 demo 已验证，但那是手写裸 `Context3D`、只用到核心子集；Starling 的
`Painter`/`BatchProcessor` 走完整面，缺 5 个方法/属性（一编译就 `unknown method` 报错，是 Starling 渲染器的编译期阻塞）。

**逐项官方语义对比**：

| 方法/属性 | 官方签名 | 落地 |
|---|---|---|
| `setStencilActions` | `(triangleFace, compareMode, actionOnBothPass="keep", actionOnDepthFail="keep", actionOnDepthPassStencilFail="keep")` | CPU 状态机记录 5 个 `char*`（stencilFace/compare/三个 action），GPU `MTLDepthStencilState` 延后到深度/模板附件落地 |
| `setStencilReferenceValue` | `(referenceValue:uint, readMask:uint=255, writeMask:uint=255)` | 记录 8-bit reference（`referenceValue & 0xFF`）；readMask/writeMask 接受但暂不落地 |
| `setScissorRectangle` | `(rectangle:Rectangle)`（null 禁用） | 记录 `scissorOn/x/y/w/h`；`setScissorRect` GPU 延后 |
| `maxBackBufferWidth`/`Height` getter | `:int`（平台上限，AIR 桌面 16384） | 返回 16384（`configureBackBuffer` 钳制到该上限） |
| `VertexBuffer3D.uploadFromByteArray` | `(data:ByteArray, byteArrayOffset:uint, startVertex:int, numVertices:int)` | 读 `ByteArray` 小端 float32（按 `endian` 标志），宽化进 `as_vector_number` 复用 submit 路径 |
| `IndexBuffer3D.uploadFromByteArray` | `(data:ByteArray, byteArrayOffset:uint, startIndex:int, numIndices:int)` | 读小端 uint16（INDEX_SIZE=2），宽化成 uint32 复用 `MTLIndexTypeUInt32` submit 路径 |

- [x] **P0：`setStencilActions`/`setScissorRectangle`/`setStencilReferenceValue`**——`symbols.ts` 补 3 方法（含 AIR 默认值），
      `emit.ts` 补 `Context3D_setStencilActions`/`Context3D_setScissorRectangle`/`Context3D_setStencilReferenceValue` 三函数，
      写入 `Context3D` 新增的 stencil/scissor 状态字段。纯 CPU 状态机记录，GPU stencil/scissor 附件延后到深度/模板附件落地。
- [x] **P0：`maxBackBufferWidth`/`maxBackBufferHeight` getter**——`symbols.ts` 补 2 getter + `Context3D` 字段（ctor 初始化 16384），
      `emit.ts` 补 `Context3D_get_maxBackBufferWidth/Height`。
- [x] **P0：`VertexBuffer3D.uploadFromByteArray` / `IndexBuffer3D.uploadFromByteArray`**——`symbols.ts` 补 2 方法签名，`emit.ts` 补
      两 C 函数：从 `ByteArray.data + byteArrayOffset` 按 `as_ba_little()` 端序读 float32（顶点）或 uint16（索引），宽化进
      `as_vector_number`/`as_vector_uint`，与 `uploadFromVector` 共用 submit 路径；`position` 不动、按 `data->length` 截断越界。
- [x] **P1（顺带补齐）：`createVertexBuffer`/`createIndexBuffer` 的 `bufferUsage` 可选参**——Starling 的 `VertexData.createVertexBuffer`
      /`IndexData.createIndexBuffer` 传第 3/2 参 `bufferUsage`（`STATIC_DRAW`/`DYNAMIC_DRAW`），此前建模漏了该参 → 一编译就
      `too many arguments`；补默认参 `"staticDraw"`（`symbols.ts` + `emit.ts` 的 C 签名 `(void)bufferUsage`），使 TODO 中「`create*`
      均已建模」的声明真正成立。

**语义红线（关键坑）**：
- `uploadFromByteArray` 的数据源是 `ByteArray` 的**原始字节**，不是 `Vector`；Starling 的 `VertexData`/`IndexData` 用小端 float32
  /uint16 存储（`writeFloat`/`writeShort` + `endian=Endian.LITTLE_ENDIAN`），故 C 函数按 `as_ba_little()` 分支读 4 字节/2 字节，
  宽化成 double/uint32 与 `uploadFromVector` 对齐——**不能**直接 `memcpy` 到 `as_vector`（元素宽度不同）。
- `byteArrayOffset`/`numVertices` 越界要按 `data->length` 截断（AS3 静默截断或按可读字节数裁剪），不能读越界；`position` 不推进
  （Starling 传 `byteArrayOffset=0`、自行维护 offset，`position` 与 `uploadFromByteArray` 无关）。
- 5 个方法全部落在「已有 Metal 管线加状态」的 CPU 侧；真正的 GPU stencil/scissor（`MTLDepthStencilState` + `setScissorRect`）与
  `setStencilReferenceValue` 的 read/write mask 延后到深度/模板附件落地，与阶段八十一~八十三的「状态机 → GPU 延后上传」模式一致。
  深度/模板附件分配本身已落地：`air-app.ts` 解析 `<depthAndStencil>true</depthAndStencil>`（默认 false）→ `AirAppInfo.depthAndStencil`
  → `airManifest` 在 `usesStage3D` 时补 `ASC_RENDER_DEPTH_STENCIL=1` define → `stage3d_glue.mm` 据此 `s3d_make_depth_stencil`
  （create/resize/destroy 全链路）创建 depth32+stencil8 私有附件，`s3d_compile` 设 `depthAttachmentPixelFormat`/
  `stencilAttachmentPixelFormat`，`s3d_draw` 挂载 depth/stencil 附件并每帧 clear 到 depth=1/stencil=0。但把 CPU 侧的
  stencil/depth/scissor 状态机真正编码成 `MTLDepthStencilState` + `setScissorRect` 仍是后续步骤。

**验收**：新增 `examples/stage87.as`（`maxBackBufferWidth/Height`==16384 getter 断言 + `setStencilActions` 2/3/5 参 + `setStencilReferenceValue`
1/3 参 + `setScissorRectangle` 矩形/null + `VertexBuffer3D.uploadFromByteArray` 小端 float32 读回 12 个浮点断言 + `IndexBuffer3D.uploadFromByteArray`
小端 uint16 读回 6 个索引断言 + `createVertexBuffer`/`createIndexBuffer` 带 `bufferUsage` 参 + `drawTriangles` 全链路）；回归全量 88 passed / 0 failed；
版本号 v0.3.97 → v0.3.98。

---

#### 阶段八十八：AS3 语言特性缺口补齐（Starling 编译硬阻塞，9 项）（v0.3.99）✅ 已完成

**依据**：对 `examples/air-starling-demo/starling/*`（141 文件，排除 com 第三方）逐个编译实测，parser/lexer/codegen 层的语言特性
缺失在语义分析前就 `Parse/Lex error`。本阶段补齐除 E4X/XML（已延后）外的全部 9 项缺口，使 Starling 框架主体可过 parse/codegen。

**逐项落地**：

| 特性 | 落地 |
|---|---|
| `namespace` 声明 / `use namespace` / `ns::member` / 成员修饰 | parser 补 `parseNamespaceDecl`/`parseUseNamespace`/`isNamespaceModifier`；透明化（AOT 编译期已定序、无可见性需求，声明与限定均丢弃，`ns::method()` → 普通方法调用、`Class.ns::static()` → 静态调用） |
| `super.property` 读·写 | `parseSuperExpr` 区分「`super(` → SuperMethod」/「否则 → SuperProperty」；emit 补 `emitSuperProperty`（字段读 `this->field`、getter 读 `Class_get_field(this)`、静态字段读；写走 `emitAssign` 的字段写 / setter 分支） |
| `for each (x in arr)` 无 `var` | AST `ForEachIn.declares` 区分；无 `var` 时迭代进既有变量（`emitVar` 取类型 + 按类型 unbox；module 变量用 `emitVar` 返回的 `g_x` 而非 `cIdent` 的 `x`） |
| 逻辑赋值 `\|\|=`/`&&=` | lexer `MULTI_SYMBOLS` 把 `\|\|=`/`&&=` 排在 `\|\|`/`&&` **之前**（否则被抢先拆成 `\|\|`+`=`）；parser `ASSIGN_OPS` 加入；emit `emitLogicalAssign` 短路写 + `discard:true` 消除 `-Wunused-value` |
| 任意类型参数 `:*=` 紧贴 | lexer 在 `:` 后类型位置识别 `*`；`message:*=""` 无空格正常解析 |
| `new <T>[]` 泛型字面量 | parser `parseNew` 已支持 `new <T>[...]`（`VectorLit`） |
| 对象字面量字符串键 `{ "bytes4": 4 }` | parser 对象字面量键允许字符串字面量 |
| 全限定名 `is`/`as`/`new`/类型注解 | parser `parseType`/`parseQualifiedName`/`parseNew` 支持点分全限定名；symbols `resolveType` 把点分名归一化为 sanitize FQN（`flash.display3D.textures.Texture` → `flash_display3D_textures_Texture`，与 classMap key 对齐） |
| UTF-8 BOM | lexer 入口剥离（此前已存在，本阶段确认） |
| `Error` 子类 `super(message, id)` 二参 | symbols `Error`/`TypeError`/`RangeError`/`ArgumentError`/`SyntaxError`/`ReferenceError` 补第二可选参 `id`；emit 所有 `*_new`/`*_ctor` 调用点补 `id` 实参（13 处硬编码 `_new` 调用 + 3 处 `throw`） |

**语义红线（关键坑）**：
- `\|\|=`/`&&=` 必须排在 `\|\|`/`&&` 之前：`MULTI_SYMBOLS` 顺序匹配，`\|\|` 在前会把 `\|\|=` 抢先拆成 `\|\|` + `=` → `unexpected token '='`。
- 全限定名需归一化：classMap key 是 `sanitizePkg` 后的下划线 FQN（`flash_display3D_textures_Texture`），点分名是 `flash.display3D.textures.Texture`，`resolveType` 不做归一化则 `hasClass` 恒失败 → `unknown class`。
- `for each` 无 `var` 迭代进 module 变量时，C 名必须是 `g_x`（`emitVar` 返回）而非 `x`（`cIdent`），否则 `undeclared identifier`。
- namespace 透明化后 `ns::method()` → 普通方法调用、`Class.ns::static()` → 静态调用，无运行时可见性语义（AOT 编译期已定序，符合 AS3 编译期解析命名空间的本质）。

**验收**：新增 `examples/stage88.as`（9 特性全覆盖：字符串键 / `\|\|=`·`&&=` / for each 无 var / `:*=` / `new <T>[]` / Error 二参 /
super.property / 全限定名 / namespace 三形态）；回归全量 89 passed / 0 failed；版本号 v0.3.98 → v0.3.99。

---

#### 阶段八十九：AS3 语言特性缺口第二批（Starling 编译阻塞续，8 项）（v0.3.100）✅ 已完成

**依据**：阶段八十八补齐 9 项后，继续对 `examples/air-starling-demo/starling/*` 逐个编译实测，发现还有一批非 E4X 的语言特性缺口在 parse/codegen 前报错。本阶段补齐除 E4X/XML（仍延后）外的 8 项。

**逐项落地**：

| 特性 | 落地 |
|---|---|
| 严格相等 `===`/`!==` | lexer `MULTI_SYMBOLS` 补 `===`/`!==`（排在 `==`/`!=` 之前）；parser 加优先级；emit 标量/字符串严格相等走 `as_v_seq`（boxed `any` 严格比较），标量走原生比较 |
| 泛型默认参数 `Vector.<T>=null` | lexer 在 `>` 后遇 `=` 不得误合并成 `>=`（泛型角括号深度跟踪，`Vector.<T>=v` 与 `Vector.<T>>default` 均正确分词） |
| `for` 多变量声明 `var i:int=0, len:int=...` | parser `for` init 允许多声明器（`VarDecls`）；emit 提升到循环前声明 |
| `const` 多声明 `const a:X=.., b:X=..` | AST `ConstDecls` 节点 + parser + emit 多声明处理（含 hoisting/参数检测/module 变量路径） |
| package 块自由函数 `public function f()` | parser `FuncDecl` 支持 `public`/`internal` 修饰；emit 顶层函数发射 |
| `as`/`is` 泛型目标 `x as Vector.<T>` | parser `is`/`as` 目标用 `parseType()`；emit `emitAs`/`emitIs` 补 `Vector.<T>` 分支（静态元素类型匹配则恒真/原样，否则 NULL/false——Vector 单态、boxed `any` 无法运行时恢复元素类型） |
| `get`/`set` 作方法名 `function get(style:Class)` | parser `get`/`set` 后跟 `(` 视为方法名（非访问器关键字） |
| 接口 getter `function get targetBounds():T;` | AST `InterfaceMethod` 加 `isGetter`/`isSetter` 字段；symbols 接口方法保留标记，接口实现验证时 getter 查 `info.getters`、setter 查 `info.setters`；emit `emitInterfaceVtables` 对 getter 生成 `Class_get_name`、setter 生成 `Class_set_name` 槽位 |

**语义红线（关键坑）**：
- `===`/`!==` 必须排在 `==`/`!=` 之前，否则 `===` 被抢先拆成 `==`+`=` → `unexpected token '='`（与 `\|\|=` 先于 `\|\|` 同款教训）。
- 接口 getter 存于类的 `getters` map（非 `methods` map），接口实现验证与 vtable 槽位都必须按 `isGetter`/`isSetter` 分派查对应 map，否则 `class 'X' does not implement method 'y'` 误报。
- `Vector.<T>` 是单态值类型，`as`/`is` 只能靠静态元素类型判断（无法从 boxed `any` 恢复元素类型），boxed 值一律判 false/NULL。

**验收**：新增 `examples/stage89.as`（8 特性全覆盖：`===`/`!==` / 泛型默认参数 / for 多声明 / const 多声明 / package 自由函数 / `as Vector.<T>` / 方法名 `get` / 接口 getter）；回归全量 90 passed / 0 failed；版本号 v0.3.99 → v0.3.100。

#### 阶段八十九·五：Starling demo 原生编译链接（集成收尾）（v0.3.101）✅ 已完成

**依据**：阶段八十八~八十九补齐语言特性后，`--dry` codegen 已过，但 `--air-app examples/air-starling-demo/Demo-app.xml --main-class Demo` 的原生 C 编译/链接阶段暴露出成批**语义保真**问题（非语言特性缺失，而是 AS3 与 C 的翻译差异在 Starling 完整代码面上的首次命中）。本阶段逐个修复直至 `clang++` 链接成功产出 `Starling-Demo` 原生二进制，回归 94 passed / 0 failed。

**逐项落地（均为语义保真修复，非降级）**：

| 问题 | 根因 | 落地 |
|---|---|---|
| 静态 getter/setter 与实例同名冲突（`get context` 重定义） | AS3 允许静态/实例访问器同名，但 emit 共用 `_get_${name}` C 名 | symbols 拆分 `staticGetters`/`staticSetters` map + 继承合并；emit 静态访问器用 `_static` 后缀、实例保留原名；`NativeApplication.nativeApplication`/`Multitouch.inputMode` 迁入静态访问器 |
| 接口值 `== null` / 真值判断 | 接口值是 `{ obj, vt }` 结构体，直接 `compositor == NULL`/`if (iface)` 非法 C | `emitEquality`/`condExpr` 补接口分支（`== null` → `.obj == NULL`，接口间相等 → `obj==obj && vt==vt`） |
| 接口 `as` 类 / 类 `as` 接口 / Object `as Vector` 返回裸 `NULL`/`{ NULL, NULL }` | `emitAs` 缺接口→类、object→Vector 的运行时恢复 | `emitAs` 补接口→类（`as_is(o.obj, &C_vt)`）、object→Vector（`(as_vector_*)o`）；接口空值用带类型复合字面量 `(I){ NULL, NULL }` |
| 链式 setter/Vector 元素赋值 `a.x = a.y = 0` / `v[0] = v[2] = 0` | setter/`as_vector_set` 返回 void，赋值表达式值语义丢失 | `sequenceValueExpr` 对 Var 裸 setter、Member setter、Index(Vector) 赋值分别 hoist RHS 到 temp；`emitExpr` Assign 分支读 hoisted temp |
| getter 自增 `stencilReferenceValue++` | 生成 `get_prop(this)++`（对 rvalue 自增） | `sequenceValueExpr` Update 分支展开为 getter 读 + setter 写；ExprStmt 跳过 getter/setter update 的原始发射 |
| `const Node* list` 修改 `list->next` 报错 | AS3 `const` 是引用不可变，非 pointee 不可变；`const X*` 错在冻结 pointee | `constTypeName` 对指针类型改 `X* const`（`char* const` 同），接口保留 `const struct` |
| `undefined` 标识符 | `toStringExpr` 缺 `class` 分支，落到 switch 末尾返回 `undefined` | 补 `case 'class': return '"[class]"'` |
| `data is/as XML` 对 `any` 折叠 `false`/非法 cast | `emitIs`/`emitAs` XML 分支只认静态 xml 类型 | 补 `any` 分支：`as_is(as_v_obj_val(v), &as_xml_vt)` / `(as_xml_node*)as_v_obj_val(v)` |
| `getter.method` 作函数值漏 bound thunk（`painter.context.drawToBitmapData`/`base.dispatchEvent`） | walkExpr 只识别 `localVar.method`，不识别 `getter.method`/`member.method` | 新增 `walkInferType`；Member 分支改用 `walkInferType(e.object)` 并处理 `e.object.kind==='Member'` |
| 链接缺失 `EOFError_new`/`LoaderContext_new` | symbols 注册但 emit 未生成定义 | emit 补 `EOFError`（Error 子类列表）与 `LoaderContext` ctor/new |
| `Mouse.cursor` 只读被赋值报错 | symbols 把可写静态 `String` 误建模为 `isConst` | 改 `isConst: false`，README 同步 |
| `clang -c` 卡死（一条表达式膨胀到 290 万字符） | `mergeNestedGroup` 把兄弟嵌套函数的捕获**全量合并**，互相引用的兄弟函数各自内联对方的函数值（`as_fn_make(_env_make(...))`），产生指数级展开（`AssetManager.loadQueue` 7 个兄弟） | 合并捕获时排除 `function` 类型（函数值只保留每个函数实际引用的兄弟，自由变量分析本就记录），只共享变量/对象/`this`；最长单行从 290 万字符降到 ~1.16 万 |

**语义红线（关键坑）**：静态/实例访问器同名是 AS3 合法形态，C 名必须分后缀；`const` 引用语义与 C 的 `const X*`（pointee 冻结）相反，须用 `X* const`（指针冻结）。

---

#### 阶段八十九·六：Starling demo 运行时崩溃修复（链接成功 → 窗口打开并稳定渲染）（v0.3.102）✅ 已完成

**依据**：阶段八十九·五产出 `Starling-Demo` 二进制，但启动即 SIGSEGV（无窗口）。逐个 `.ips` 崩溃报告 + `lldb` 定位，链式修复五处运行时根因，直至窗口打开、`metal_glue` 持续渲染不崩，回归 94 passed / 0 failed。

| 崩溃 | 根因 | 落地 |
|---|---|---|
| `main` 读 `FilterEffect_VERTEX_FORMAT` 空指针（静态初始化顺序错误） | 急切静态初始化按源码顺序、无法看到方法体内的静态依赖（`VertexDataFormat.fromString` 读自己的 `sFormats` Dictionary） | 改 AS3 `cinit` 懒初始化：`emitStaticInits` 为每类生成 `C_cinit()`+`_cinit_done`；`sfRead`/`sfWrite` 在每次静态字段读/写处前插 `(C_cinit(), ...)`，覆盖 `emitVar`/`emitExpr` Member·FQN/`emitSuperProperty`/动态 `emitIndex`/`lookupClassVar` 全部静态读点 |
| 静态字段 `f++`/`f = v` 报 "expression is not assignable" | 逗号表达式不是 lvalue，`(C_cinit(), f)++` 非法 | 新增 `resolveStaticFieldTarget`，静态字段 `Update`（`emitExpr`）与裸赋值（`emitAssign`）用 `sfWrite` 把 cinit 折叠到整个操作外层而非 lvalue 上 |
| `Starling.as:270` "Stage must not be null" | 引导顺序：`new Demo()`（ctor 读 `this.stage`）先于 `stage.addChild(app)`，`DisplayObject_get_stage` 沿父链走到顶仍是非 Stage → NULL | 新增 `ASC_root_stage`（`Stage_ctor` 赋值），`DisplayObject_get_stage` 在顶层祖先非 Stage 时回退到它 |
| `RenderState_reset` 里 `strcmp(NULL, "normal")`（`blendMode` setter 比较未初始化的 String 字段） | `emitEquality` 字符串分支只对静态 `null` 类型加空守卫，`String`-typed 操作数运行时可为 NULL 却直接 `strcmp` | runtime 新增 `as_str_eq`（`a==b` 真、任一 NULL 假、否则 `strcmp`），`emitEquality` 字符串/宽松 `==` 分支改用它（`!=` 取反） |
| `_fn6__call`（`(_background.content as Bitmap).smoothing = true`）空指针 | `Loader.loadBytes` 从不设置 `content`（只填 `bytesLoaded/bytesTotal`），COMPLETE 回调读 `content` 得 NULL | `loadBytes` 补同步解码：skia_glue 新增 `sk_image_decode_bytes_rgba`（`SkData::MakeWithCopy` + `DeferredFromEncodedData`），runtime 加 `as_skia_image_decode_bytes_rgba`（含 `#else` no-op 桩），`Loader_loadBytes` 把 `ByteArray.data/length` 解成 `BitmapData` 并 `Bitmap_new` 赋 `content` |

**语义红线（关键坑）**：AS3 `String` 字段默认 `null` 而非空串，字符串 `==`/`!=` 必须 null-safe（`strcmp(NULL,…)` 是 UB）；`Loader.loadBytes` 与 `load` 一样须解码出 `Bitmap` content（AIR 语义），否则 `loader.content as Bitmap` 是 NULL。

#### 阶段八十九·七：`Capabilities.version` 对齐 AIR 格式（Starling 版本门禁通过）（v0.3.103）✅ 已完成

**依据**：Starling 启动时 `Starling.as:321` 用 `parseInt(SystemUtil.version.split(",").shift()) < 19` 判运行时版本；`SystemUtil.version` 来自 `Capabilities.version.substr(4)`。此前 `as_cap_version` 返回 `"MAC AS-AOT 0.3.102"`，`substr(4)` 得 `"AS-AOT 0.3.102"`、无逗号 → `split(",").shift()` 得整串 → C 的 `atoi` 遇非数字开头返回 0 → 误报 "outdated"。

| 改动 | 旧 | 新 |
|---|---|---|
| `as_cap_version`（runtime.ts） | `"<平台前缀> AS-AOT <ver>"`，`ver` 为编译期注入的 package.json 版本号 | 无参，返回固定 AIR 兼容 `"<平台前缀> 50,0,0,0"`（Adobe AIR 终版 major 50；`substr(4)` 得逗号四段，`parseInt(split(",").shift())` = 50 ≥ 19） |
| AS-AOT 标记 | 挤在 `version` 里（破坏固定偏移解析） | 移到 `Capabilities.manufacturer` = `"AS-AOT"`（本已映射，语义即「运行时实现者」，不破坏 version 解析） |
| `asAotVersion` 注入链路 | `codegen.ts CodegenOptions` + `Emitter` 构造参数 + `index.ts readAsAotVersion()` | 整体移除（version 不再需编译器版本号，唯一消费点消失，无残留死代码） |

**同步**：`examples/stage65.as` 断言从「`AS-AOT ` 前缀 + `.` semver」改为「3 字符平台前缀 + 空格 + 逗号四段 + `major >= 19`」；README-CN/README 的 Capabilities 描述同步。回归 94 passed / 0 failed。

#### 阶段八十九·八：版本门禁通过后暴露的级联 bug 修复（v0.3.104）✅ 已完成

**依据**：阶段八十九·七让 Starling 版本门禁通过后，此前被「outdated version」致命错误掩盖的成批深层 bug 才暴露出来（版本门禁一过，启动链路继续走到 `RenderUtil.requestContext3D` 及之后）。逐个 `lldb` 定位 + 链式修复四类运行时/语义保真根因，直至 `Starling-Demo` 从 `examples/air-starling-demo/` 目录启动后窗口打开并持续渲染，回归 94 passed / 0 failed。

| 崩溃/根因 | 说明 | 落地 |
|---|---|---|
| `profile:Object="auto"` 装箱错（`(Object*)("auto")` 把裸 `char*` 强转成对象指针） | `Starling` 构造器参数 `profile:Object="auto"` 的默认值经 `convert(Str, Object)` 时生成 `(Object*)("auto")`，后续按对象反射解引用即崩 | runtime 新增 `as_string`/`as_string_new`/`as_is_string_obj`/`as_string_obj_val`/`as_obj_to_value`（`GCT_STRING_OBJ=12` + 写屏障）；`String` 标记为 `Object` 子类（独立 vtable）；`convert`/`boxExpr`（仅 `className==='Object'`）/`emitAs` 识别并装箱字符串 |
| rest 参数 thunk 解包错（`execute(func, ...args)` 用 `as_v_obj_val(args[1])` 把字符串解成指针） | `emitThunk` 对 `p.isRest` 用 `as_v_obj_val` 解箱，rest 参数实为字符串时把 `char*` 当对象指针解引用即崩 | `emitThunk` 的 rest 分支改走 `as_array_make(argc>i ? argc-i : 0, argc>i ? &args[i] : NULL)`（rest 恒为末尾，`break`） |
| `Vector[Vector.length]=x` 追加惯用法 RangeError | `BenchmarkScene.putObjectToPool` 用 `pool[pool.length]=obj` 追加；`as_vector_*_set` 拒绝 `i==v->length` | `emitVectorHelpers` 的 `set` 助手判界从 `i>=length` 改 `i>length`，`i==length` 时路由 `as_vector_*_push`（扩容+写屏障）；替换路径 `isPtr` 补 `gc_write_barrier` |
| **互相递归的兄弟闭包**：`RenderUtil.requestContext3D` 里 `onCreated`/`onError`/`onFinished` 形成互递归环，`onFinished` 的 env 存了 NULL 兄弟引用 → `removeEventListener(..., NULL)` 解引用 `listener->fn` SIGSEGV | 旧的 `buildingClosures` 遇环直接 yield `NULL`（“pragmatic AOT-subset approximation”）导致环内引用为 NULL | `mergeNestedGroup` 用 AS3 名集合区分「兄弟函数引用」与「函数型参数/局部变量捕获」（后者如 `onComplete:Function` 仍按值捕获）；有兄弟引用时生成**共享 cell**（每成员一个 `as_fn` 槽 + 合并变量捕获，`GCT_CUSTOM` mark 逐槽 trace），成员 `__impl` 以 cell 为 env，兄弟/自身引用读 `env->member`（身份稳定，满足 `removeEventListener` 的 `===` 匹配）；`emitVar` 返回 `env->member`（闭包内）或 `(cell!=NULL?cell:_cell_init(&cell,...))->member`（外层方法懒初始化，在 `profiles=[...]` 等赋值之后才捕获） |

**语义红线（关键坑）**：AS3 闭包对兄弟函数的引用是**同一函数值**（`removeEventListener`/`addEventListener` 依赖身份相等），不能每次求值都重建 `as_fn_make`；函数型捕获要区分「兄弟函数名」与「`Function` 类型的参数/局部变量」两类，后者必须按值进 env、前者必须走共享 cell，否则会误丢 `onComplete` 之类的参数捕获导致 `undefined variable`。

#### 阶段八十九·九：Starling demo 白屏修复（ROOT_CREATED 时序 + 四处语义保真）（v0.3.105）✅ 已完成

**依据**：阶段八十九·八让窗口打开并持续渲染，但 demo 仍是白屏——AOT 输出只有 `Context ready. Display Driver: Software (state machine)` 与 `metal_glue: begin_frame`，没有 ADL 参考日志里的 `ROOT_CREATED = start load` / `onLoadProgress` / `onLoadComplete`。根因是 `Stage3D_requestContext3D` **同步**派发 `context3DCreate`，使 `new Starling(...)` 还在调用栈上时就跑完 `onContextCreated → initialize → initializeRoot → ROOT_CREATED`，而 `Demo.as` 是在 `new Starling(...)` **之后**才注册 ROOT_CREATED 监听器，于是错过了事件、`loadAssets` 永不执行（白屏）。链式修复五处，回归 94 passed / 0 failed。

| 白屏/崩溃 | 根因 | 落地 |
|---|---|---|
| ROOT_CREATED 永不触发（白屏） | `Stage3D_requestContext3D` 同步派发 `context3DCreate`，AIR 语义是异步（下一帧再派发） | `Stage3D_requestContext3D` 仍**急切**创建 `context3D`（保证 `stage3D.context3D` 立即可读），但用 `as_set_timeout(Stage3D__contextReady, 0.0)` 把 `context3DCreate` 事件推迟到下一帧 tick；`stage81.as` 的「dispatched synchronously」断言同步改为异步 |
| 日志误报 `Display Driver: Software (state machine)` | `Context3D_get_driverInfo` 用 `o->gpu != NULL` 判断，而 `gpu` 在 `configureBackBuffer` 才懒创建，trace 时必然为 NULL → 误报 Software，还会让 Starling 的 profile-retry 循环逐个把 profile 当软件降级拒绝 | `Context3D_get_driverInfo` 改由编译期后端决定（`#ifdef ASC_RENDER_METAL` → `"Metal (Stage3D)"`，否则 Software），不再读运行时 `gpu` 指针 |
| `pool.pop().reset(...)` 二次求值 SIGSEGV（`Vector index out of bounds`） | 方法调用的接收者 `obj.code` 在 C 里被发射两次（vtable 查找一次 + `this` 实参一次），`pop()` 被调用两次、第二次空池抛 RangeError | `sequenceValueExpr` 的 `Call` 分支对「接收者非纯（含副作用）」的方法调用把接收者 hoist 到临时变量（`hoistedAssigns`），`emitExpr` 顶层统一读 temp；新增 `isPureExpr` |
| 构造器字段默认值清空错（`o->_bounds = NULL`） | 字段默认初始化在 `super()` 之后发射，但 AS3 允许 `super()` 前有赋值语句（`Quad` 构造器先 `_bounds = new Rectangle(...)` 再 `super(...)`），默认值把先前赋值清空 | `gc_alloc` 已 memset 清零，非 `Number` 字段默认值（NULL/0/false）无需重写；仅 `Number`（NaN，非零位模式）在构造器最前（super 前）补 `= NAN`，字段**内联初始化器**仍在 super 后发射 |
| `_parent \|\| _maskee` 被译成 C 布尔（SIGSEGV） | `emitBinary` 把 AS3 的 `&&`/`\|\|` 直接译成 C 布尔运算符，返回 `bool`；但 AS3（如 JS）的 `&&`/`\|\|` 返回**操作数值**（对象引用 `_parent \|\| _maskee` 返回第一个非 null 的 DisplayObject），C 布尔会把它折叠成 `bool` 再强转指针 | `emitBinary` 的 `&&`/`\|\|` 改发值语义三目：`a\|\|b → (cond(a)?a:b)`、`a&&b → (cond(a)?b:a)`，结果类型 `unifyType`；混合守卫惯用法（`bool && object`）两分支装箱为 `any`；`sequenceValueExpr` 对左操作数非纯时 hoist（避免三目里二次求值） |

**语义红线（关键坑）**：AS3 `&&`/`\|\|` 返回操作数值而非布尔（对象引用的「null 合并」惯用法 `_parent \|\| _maskee` 不能译成 C 布尔）；方法调用接收者必须是单一求值（vtable 查找与 `this` 实参复用同一表达式会二次求值）；字段默认值在 `gc_alloc` memset 后已就位，只有 `Number` 的 NaN 需要显式补；`context3DCreate` 在 AIR 里是异步派发（下一帧），同步派发会打乱 `new Starling(...)` 后注册监听器的时序。

**遗留（下一阶段，E4X/XML 阻塞）**：demo 现已从白屏推进到 `ROOT_CREATED → loadAssets → onLoadProgress=1 → onLoadComplete`，随后在 `MainMenu` 构造 `new Button(Game.assets.getTexture("button"))` 抛 `Texture 'upState' cannot be null`——`button` 是 `atlas.png`+`atlas.xml` 的子纹理，其注册依赖 `TextureAtlas` 解析 `atlas.xml`（`new XML(bytes)` / `.localName()` / `xml.@imagePath` / 子节点遍历），而 E4X/XML 已立项为阶段九十~九十三（见 `docs/zh-cn/e4x.md`），尚未落地。这是下一步的既定工作，非本次白屏修复范畴。

#### 阶段八十九·十一：闭包引用语义 + URLLoader BINARY + 动态 `*` 成员访问 + 闭包默认参 thunk（v0.3.107）✅ 已完成

**依据**：阶段八十九·九/十把 demo 推进到 `onLoadComplete` 后 `MainMenu` 构造 `new Button(getTexture("button"))` 抛 `Texture 'upState' cannot be null`——`button` 依赖 `atlas.xml` 的 E4X 解析（阶段九十~九十三）。继续沿加载链顺藤摸瓜，本阶段落地四项语义保真/功能修复（均非 E4X，属加载链前置）：

1. **闭包引用语义**（用户选定 `实现闭包引用语义`）：此前同函数内嵌套函数共享被捕获 `var` 局部，但每个嵌套函数各自快照值，`removeEventListener(..., handler)` 读回的不是同一 cell 槽位、`executeFunc` 这类函数型局部在被捕获时仍快照 NULL。改为**共享 sibling cell**：`emitVar` 对被捕获局部直接返回 `cell->field`（身份稳定），`emitVarDecl` 提升赋值走 `emitVar(name).code = ...`（box 捕获经 `cell->field`），`buildEnclosingCaptured` 只 box 已 hoist 的 `var` 局部（`hoistedLocals` 成员测试，取代「跳过 function 类型」的错误启发式），`emitClosureCellLocals` 急切 `gc_alloc(GCT_CUSTOM)` + 非 box 捕获（`this`/params）按值 seed，惰性 `_cellN_init` 换成急切 `_cellN_alloc`。回归 94/94。
2. **URLLoader BINARY dataFormat**：`URLLoader.data` 是 AS3 `*`（`{kind:'any'}`，prop tag 7 → `gc_mark_value`），`URLLoader_load` 按 `dataFormat=="binary"` 分支 `fopen/fseek/ftell/fread` 原始字节进 `ByteArray`（`as_alloc`）+ `gc_write_barrier_value`；text 路径不变。demo 由此真正 load 前 3 个资源、`onLoadProgress` 前进（0.1357→0.2714→0.407）。
3. **动态 `*` 成员访问 → `as_any_get`**：`BitmapTextureFactory.onLoaderComplete` 里 `event.target.content.bitmapData`（`loaderInfo` 是类实例持于 `*`）此前被译成 `as_object_get(...)` 把类实例 `vtable` 指针误当 record `keys[]` 数组（bus error `strcmp(0x800000002,"content")`）。改为 `as_any_get(obj, key)`（按 box tag 分派：object→`as_dyn_get` 走 vtable 字段+getter+record 回退；array→索引）。
4. **闭包 thunk 默认参**：`AssetManager.onAssetLoadError` 里 `onAssetLoaded()`（`name/asset/type` 全 `=null`）经 `execute` 以 `args=NULL, argc=0` 调用 thunk，thunk 无条件读 `args[0..2]` → null 解引用 SIGSEGV。`emitThunk` 对带 `defaultValue` 的参数发射 `(argc > i ? unbox(args[i]) : 默认值)`，缺省参数回退默认值。

**验收**：`node test.ts` 94 passed / 0 failed；demo 从白屏推进到 `onLoadProgress` 达 5/7（真实二进制 PNG/字体加载），随后停在纹理创建链的既有崩溃点。

**遗留（下一阶段）**：demo 现进展到 `onLoadProgress≈0.6786`（5/7）时：(a) 某资源 `BitmapTextureFactory.createFromBitmapData` 收到 null bitmapData → `Texture.fromData(null)` 抛 `Unsupported 'data' type: null`（`Loader.loadBytes`→`content.bitmapData` 链路上某 PNG 解码/内容设置失败）；(b) 另在 `ConcreteTexture_set_onRestore` 里 `Starling.current`（`sCurrent`）读取为 null/垃圾导致 SIGSEGV（`address=0x30`，`makeCurrent` 时序或 GC 根注册问题）。这两个连同 `atlas.xml` 的 E4X/XML 解析同属下一阶段（阶段九十~九十三）既定工作。

#### 阶段八十九·十二：实例 getter/setter 虚分派（修复 `set_onRestore` SIGSEGV）（v0.3.108）✅ 已完成

**依据**：阶段八十九·十一遗留的 (b) 崩溃——`ConcreteTexture_set_onRestore` 里 `address=0x30` 的 SIGSEGV（`x19=NULL`，即 `this` 为空）。用 `lldb` 实测定位：崩溃不是 `Starling.current`（sCurrent）时序问题，而是**实例 getter 非虚分派**——`Demo.as` 里 `texture.root.onRestore = ...` 中 `texture` 静态类型为 `Texture` 但运行时是 `ConcreteTexture`，`texture.root` 被编译成静态直调 `Texture_get_root(texture)`（返回 `null`），而 `ConcreteTexture.get root()` 才是 `return this`；于是 `null` 被当作 receiver 传给 `ConcreteTexture_set_onRestore(NULL, ...)`，写 `this->_onRestore`（偏移 0x30）时崩溃。方法早已虚分派（`obj->vtable->method(obj, ...)`），但 getter/setter 仍是 `Owner_get_prop(obj)` 静态直调，存在同一架构 bug（Starling 大量 `override set width/height/x/texture/...`）。

**修复**：为类 vtable 引入**统一有序槽列表** `ClassInfo.vtableSlots`（`{kind:'method'|'getter'|'setter', name, info}`），在 `expandInheritance` 里 super-first 扁平化——覆盖同名同 kind 槽**原位替换**、新增槽**追加**，保证子类 vtable 结构体与父类**前缀布局兼容**（否则子类新增方法/ getter 会平移后续槽、破坏 `as_vtable_header` 前 8 字段与父类指针 cast）。emit 侧：`emitStructs` 按 `vtableSlots` 发射 `get_名`/`set_名` 函数指针字段（getter 仅 receiver、setter 带 value 参）；`emitVtables` 按同序填 `Owner_get_名`/`Owner_set_名`；getter 读点（`emitVar`/`emitExpr` Member）与 setter 写点（`emitAssign` 成员/裸 setter + `sequenceValueExpr` 四处 hoist + 复合赋值）全部改走 `obj->vtable->get_名(obj)`/`obj->vtable->set_名(obj, v)`（`setterCallCode` 助手统一静态/实例分支）。静态访问器（`_static` 后缀）与 `super.property` 读写保持静态直调（`super` 须跳过当前类 override）。接口 getter 派发已走接口 vtable，不受影响。setter 字段参数类型须用 `s.owner` 的 importAlias（`setterPtrField` 默认值），此前误传当前类 alias 导致 `MovieClip` 继承 `Image.set_scale9Grid` 时参数 `Rectangle` 误解析成匿名命名空间 `Polygon_Rectangle`（`-Wincompatible-function-pointer-types` 编译错误）。

**验收**：`node test.ts` 94 passed / 0 failed；`Starling-Demo` 重建后 SIGSEGV 消失，`onLoadProgress` 走完全部 7/7（0.1357→…→0.9499）、窗口持续渲染不崩。

**遗留（下一阶段）**：demo 仍报三次 `Error creating null: Unsupported 'data' type: null`（阶段八十九·十一遗留 (a)）：3 个资源（PNG/字体/ATF 其中三者）`Loader.loadBytes`→`content.bitmapData` 解码为 null → `BitmapTextureFactory` 拿 null bitmapData → `Texture.fromData(null)`。连同 `atlas.xml` 的 E4X/XML 解析属阶段九十~九十三既定工作。

#### 阶段八十九·十三：闭包 arity 对齐 `Function.length`（修复 `addAsset` 收到 `'null'` 名字）（v0.3.109）✅ 已完成

**依据**：阶段八十九·十二把 demo 推到 `onLoadComplete` 后，发现 `AssetManager.addAsset` 收到 `null`/`'null'` 名字——enqueue 期 debug 证明 `AssetReference.name` 在 `enqueueSingle` 与 `onLoadComplete` 入口都是正确的（`desyrel`/`background`/`compressed_texture`/`atlas`），但紧接 `reference.data = data` 之后的「可选参数赋值块」执行后 `reference.name` 变 `'null'`，进而 `Adding object 'null'`/`Adding texture 'null'` 且反复「name was already in use」重复名告警。

**根因**：闭包 `as_fn_make(..., arity)` 的 arity 被错误地设为 `params.length`（**声明参数总数**），而 AS3 `Function.length` 语义是**必填参数个数**（首个带默认值/rest 的参数之前）。Starling 的 `execute()`（`starling.utils.execute`）读 `func.length`（编译后即 `func->arity`）决定把参数列表裁剪/补 `null` 到多少个再分派。对 `onLoadComplete(data, mimeType:String=null, name:String=null, extension:String=null)`：arity 被设成 4，`execute` 把 2 实参补成 4 个（`args[2]`/`args[3]` 填 `as_v_null()`）并以 `argc=4` 调 thunk；thunk 里 `(argc > i ? as_v_str_val(args[i]) : 默认值)` 误判 `argc>2` 为「实参已传」，把 `as_v_str_val(as_v_null())`（tag 0 → 字面量 `"null"`）当 name 传入，`if (name) reference.name = name` 于是用 `"null"` 覆盖了正确名字。（写屏障/GC 均与此无关——`gc_threshold` 临时调大到 1GB 禁用增量 GC 后症状照旧，排除 GC 回收。）

**修复**：`emit.ts` 新增 `requiredArity(params)`（统计 `defaultValue===null && !isRest` 的前缀个数），并替换全部 `as_fn_make(..., arity)` 与 `Function.length` 发射点的 `X.params.length`（共 12 处：嵌套函数 cell、`currentFuncArity`、`FunctionExpr`、方法/接口/静态方法 bound thunk、`Function.length` 读点等），使 arity = 必填参数个数。同时上一阶段引入的实例 getter/setter 写屏障（`resolvesToHeapField`）作为防御性硬化保留。

**验收**：`node test.ts` 94 passed / 0 failed；`Starling-Demo` 重建后 `addAsset` 全部收到正确名字（`Adding object 'desyrel'`/`Adding texture 'desyrel'`/`Adding texture 'background'`/`Adding object 'atlas'`/`Adding texture 'atlas'`），再无 `'null'` 名字、无「name was already in use」重复告警，`Error creating null` 报错消失。

**遗留（下一阶段）**：6 个资源全部按正确名字注册后，`onLoadComplete` 尚未触发（最后 `atlas.png` 的纹理/`TextureAtlas` 建立时卡在渲染帧循环）；`atlas.xml` 的 E4X/XML 解析、`MainMenu` 构造 `getTexture("button")` 等仍属阶段九十~九十三既定工作。

#### 阶段九十：`XML`/`XMLList` 类型建模 + 极小 XML 解析器✅ 已完成

**依据**：Starling 资源管线（`AssetManager`/`XmlFactory`/`TextureAtlas`/`BitmapFont`）以 atlas XML 与 BMFont `.fnt`（本质 XML）为核心输入，`new XML(bytes)` 是渲染硬前置；`describeType` 也依赖 XML。实测 Starling 用的 E4X 是**窄子集**——无裸 XML 字面量，全部运行时构造（详见 [`docs/zh-cn/e4x.md`](docs/zh-cn/e4x.md)）。

**实现**：`symbols.ts` 建模 `XML`/`XMLList` 内建类型（`kind:'xml'/'xmllist'`）；`runtime.ts` 内嵌手写极小 DOM 解析器（`as_xml_parse` → `as_xml_node{name, attrs, children, text}`，新增 `GCT_XML`/`GCT_XML_LIST` box tag 并同步补 `gc_mark_value`/`as_v_typeof`/`as_v_truthy` 等）；`emit.ts` 支持 `new XML(String/ByteArray)` / `XML(str)` 构造（`as_xml_parse` 返回 NULL 时抛 `Error("XML parse error")` 而非静默吞错）；`System.disposeXML` 为 no-op（GC 自动回收）。

**验收**：`examples/stage90.as`（`localName()`/`XML(str)`/嵌套/`toString()` 往返）。

#### 阶段九十一：E4X `@attr` 属性访问 + `.child` 子节点导航✅ 已完成

**实现**：lexer 识别 `@`（后置运算符）；parser 支持 `expr.@attr` / `expr.child` / 多级导航 / `.child.length()`；emit 展开为 `as_xml_attr`（返回 String）/ `as_xml_children`（返回 `XMLList`，`.child.grandchild` 展平）；`for each (x in xml.child)` 支持迭代 `XMLList`。

**验收**：`examples/stage91.as`（`@attr`/`@attr.toString()`/`atlas.SubTexture` 多级导航/`for each` 迭代/`font.pages.page.@file`）。

#### 阶段九十二：E4X 过滤谓词 `.(@attr == value)`✅ 已完成

**实现**：parser 支持 `expr.(predicate)` 过滤谓词；emit 编译期把谓词降级为「属性名 + 期望值 + neq」三元组 → `as_xml_filter(list, attr, value, neq)`（谓词形态实测仅 `@attr == "str"` 一种，无需运行时谓词求值）。

**验收**：`examples/stage92.as`（`constant.(@type=="Class")`/`variable.(@type=="Class")`/多级导航 + 过滤）。

#### 阶段九十三：`describeType` 的 XML 输出✅ 已完成

**实现**：移除 `as_describe_type_not_impl` 占位，改为真实现 `as_describe_type(cls)` → `<type name="包::类"/>` XML 树（`@name`/`.localName()`/`.child`/`.(pred)` 可遍历）；非 Class 值退回 `<type name="Object"/>`。打通 Starling `AssetManager` 的 `constant.(@type=="Class")`/`metadata.(@name=="Embed")`/`arg.(@key=="source")` 元数据提取链路。

**验收**：`examples/stage93.as`（`describeType(Class)` 的 `@name`/`localName()`/`.(pred)` 兼容/非 Class 回退）。

> 注：阶段九十~九十三 代码已落地并回归通过（94 passed / 0 failed），但版本号未递增（`package.json` 保持 0.3.108，待 Starling demo 整体跑通后统一升）。

#### 阶段八十九·十四：`onLoadComplete` 触发（ATF 纹理 READY 派发 + `&&`/`||` 短路 hoist 修复）（v0.3.110）✅ 已完成

**依据**：阶段八十九·十三把 demo 推到「6 资源全部正确注册」后，`onLoadComplete` 仍未触发——`compressed_texture.atf`（ATF 工厂）与 `atlas.png`（`BitmapTextureFactory`）两个纹理工厂的 `onReady` 回调永不执行，`numComplete` 卡在 5/6，`finish()`/`onLoadComplete` 永不触发。逐个 lldb 定位出两处根因。

**根因一（ATF 空 stub）**：`Texture_uploadCompressedTextureFromByteArray` 在 `emit.ts` 里是空 stub（`(void)_this; (void)data; ...`），从不派发 `TEXTURE_READY`，故 `ConcretePotTexture.uploadAtfData` 的 `onTextureReady` 监听器永不触发，ATF 工厂 `onComplete` 不执行。修复：新增 `Texture__textureReady` 静态 thunk（调 `EventDispatcher_dispatchEvent(Event_new("textureReady", ...))`），stub 改为 `if (async) as_set_timeout(as_fn_make(Texture__textureReady, _this, 0), 0.0);`（异步派发，让 `Texture.fromData` 先返回、工厂的局部 `texture` 先赋值再读）。

**根因二（`&&`/`||` 短路 hoist 突破）**：`SubTexture_setTo` 里 `if (Capabilities.isDebugger && _frame && (_frame.x > 0 || _frame.y > 0 || ...))`，`isPureExpr` 此前只把 `Var/Num/Str/Bool/Null/Member/Index` 判纯，其余（含 `&&`/`||` 及所有算术/比较/位运算）一律判「非纯」。于是 `sequenceValueExpr` 把纯的比较子表达式（如 `_frame.x > 0`）提升（hoist）为**无条件执行的独立语句**（`_sc302 = (_frame->x) > 0`），突破外层 `&&` 的短路保护——`Capabilities.isDebugger` 恒 false、整条 guard 本该死，却仍无条件解引用 `_frame`（为 null 时）→ SIGSEGV（`address=0x8`）。修复：`isPureExpr` 新增 `Unary`/`Typeof` 分支（递归 operand），且 `Binary` 统一递归 `isPureExpr(left) && isPureExpr(right)`——算术/比较/位运算与逻辑 `&&`/`||` 都在操作数纯时判纯（`&&`/`||` 仅择一操作数返回、无副作用，可安全重求值；若不判纯，纯的 `a || b` 嵌套进外层 `&&`/`||` 会被错误 hoist 成无条件语句、破坏短路）。

**验收**：`node test.ts` 94 passed / 0 failed；`Starling-Demo` 重建后 7 资源全部按正确名字注册（`desyrel`/`background`/`compressed_texture`/`atlas`/`textureAtlas 'atlas'`/`bitmapFont 'desyrel'`），`onLoadProgress=1` 后 `onLoadComplete` 触发，`startGame`→`game.start`→`MainMenu_init` 推进（`getTexture("button")` 不再 null，`Image_setupScale9Grid` 已执行）。

**遗留（下一阶段）**：`onLoadComplete` 后主菜单仍在构建/渲染管线中——窗口白屏仅见 `ProgressBar`（`initElements` 的 native overlay），`MainMenu` 的 Starling 内容尚未绘制出来（`Image_setupScale9Grid` 顶点填充 / Starling 渲染管线 / `removeElements` 定时器移除 native overlay 等仍属后续阶段）。

---

#### 阶段八十九·十五：`RectangleTexture` 类型混淆 SIGSEGV 修复（NPOT 纹理 GPU 上传）（v0.3.111）✅ 已完成

**依据**：阶段八十九·十四让 `onLoadComplete` 触发、`MainMenu` 开始构建后，首次 `s3d_draw` 提交背景 quad 后即 SIGSEGV（`.ips` 崩溃栈：`objc_msgSend` → `-[AGXG14XFamilyRenderContext setFragmentTexture:atIndex:]` ← `s3d_draw` ← `Context3D_submit`，selector 为 `retain`、`far=24`，即把垃圾指针当 `id<MTLTexture>` 传给 Metal）。

**根因**：Starling 的 atlas（788×788）与 background.jpg（320×480）都是**非 2 次幂（NPOT）**，`Texture.empty` 据此创建 `RectangleTexture`（非 `Texture`）。但 `FilterEffect.beforeDraw` 恒调 `context.setTextureAt(0, _texture.base)`（AIR 官方签名 `setTextureAt(sampler:int, texture:TextureBase)`，`base` 返回 `TextureBase`），而本子集把 `setTextureAt` 参数与 `Context3D.tex{i}` 槽都建模成 `Texture*`（无 `TextureBase` 统一型）。`RectangleTexture` C 结构体只有 `{vtable;width;height;format;bitmapData}`，缺 `Texture` 才有的尾部 `gpu` 字段；`Context3D_submit` 的纹理绑定循环无条件读 `o->tex{i}->gpu`，在 `RectangleTexture*` 上越界读到垃圾指针 → `as_s3d_bind_texture` 把垃圾存入 `c->textures[i]` → `s3d_draw` 的 `setFragmentTexture:垃圾` 崩溃。

**修复**：给 `RectangleTexture` 补 `gpu` 字段（`{kind:'null'}` 不透明 `void*`，与 `Texture.gpu` 同型同偏移），使其结构体与 `Texture` **布局完全一致**（vtable/width/height/format/bitmapData/gpu），于是 `Context3D_submit` 读 `->gpu`/`->bitmapData`/`->width`/`->height` 对二者皆安全；`gpu` 初始 NULL → 命中 `bitmapData->pixels != NULL` 的上传分支，把 NPOT 位图经 `as_s3d_upload_texture`（Metal `texture2DDescriptor mipmapped:NO` 天然支持 NPOT）上传绑定。同时 `RectangleTexture_uploadFromBitmapData`/`RectangleTexture_dispose` 按 `Texture` 同款补 `as_s3d_destroy_texture` 失效/释放，`RectangleTexture_ctor` 补 `o->gpu = NULL`。

**验收**：`node test.ts` 94 passed / 0 failed；`Starling-Demo` 重建后 `onLoadComplete` → `shader pipeline compiled OK` → `first draw numTriangles=2 numStreams=2` 提交成功，**不再 SIGSEGV**，窗口持续渲染稳定（`metal_glue` 帧循环无中断）。

**遗留（下一阶段）**：窗口内容仍白屏（Starling 内容尚未上屏）——`MainMenu` 的 `logo`/`button`/`text` 等 Starling 顶点填充、`Image_setupScale9Grid` 顶点写入、以及 `removeElements` 定时器移除 native overlay 等渲染管线仍属后续阶段（同阶段八十九·十四遗留）。

---

#### 阶段八十九·十六：像素字节序边界修正（`BitmapData.draw(TextField)` 红蓝互换 + 边界显式化）（v0.3.112）✅ 已完成

**依据**：阶段八十九·十五修掉 NPOT 纹理 SIGSEGV 后复查「像素格式/字节序」假设——`BitmapData_draw` 的 TextField 分支把 TextField 光栅化到 `MakeN32Premul` surface 后**逐像素读回**，代码写作 `B=q[0], G=q[1], R=q[2], A=q[3]`（把 Skia 原生格式当成 BGRA）。但 Skia 的 `kN32_SkColorType` 是**平台相关别名**：Windows 下 `SK_R32_SHIFT=16` → `kBGRA_8888`，macOS/Linux 下 `SK_R32_SHIFT=0` → `SK_PMCOLOR_BYTE_ORDER(R,G,B,A)` → `kRGBA_8888`（见 `include/core/SkTypes.h` / `SkColorType.h`）。故在 macOS 上该读回**把红蓝互换**：红背景 `TextField` 被读成蓝色。

**根因（架构结论）**：运行时的内部规范格式**不是**「字节序选择」——`bd->pixels` 是 `uint32` 数组，存的是**数值** `0xAARRGGBB`（straight alpha），这是 AS3 的语义契约（`getPixel32`/`setPixel32`/`getVector`/`threshold`/`colorTransform`/`copyChannel`/`merge`/`paletteMap`/`floodFill`/`getColorBoundsRect` 及 `(c>>16)&0xFF` 惯例全部依赖它）。在小端主机上这个数值的内存字节恰是 B,G,R,A，与 Metal 的 `BGRA8Unorm` **天然一致**——所以「内部 ARGB」已经是转换最少的形态。反之若把内部规范改成 RGBA，会：倒置 AS3 数值契约（大面积改动）、把转换从「解码一次」挤到「每像素读」，并在 Metal 上被迫使用非原生的 `RGBA8Unorm`。因而不改内部格式，只把**三处真实字节边界**显式化：

1. **Skia 读回**（`BitmapData.draw(TextField)`）：新增 `sk_surface_read_argb(surface, dst, w, h)`，显式请求 `kBGRA_8888` + `kUnpremul`，取代生成 C 里的 peek + 逐像素反预乘/swizzle 循环（`kUnpremul` 直接给出 straight alpha，省掉手工反预乘）。
2. **图像解码**：`sk_image_decode_rgba`/`..._bytes_rgba` → `sk_image_decode_argb`/`..._bytes_argb`，`readPixels` 直接写进 ARGB 缓冲（删掉临时 malloc + 逐像素循环）。
3. **Stage3D 纹理上传**（`s3d_upload_texture`）：小端下运行时缓冲字节序与 `MTLPixelFormatBGRA8Unorm` 一致，改为直接 `replaceRegion`（旧 swizzle 在小端上逐字节空转），大端走 `__BYTE_ORDER__` 分支。
4. **`BitmapData.setPixels`**：原按 R,G,B,A 读字节，而 AIR 契约是「32-bit ARGB 像素值」+ `ByteArray` **默认大端**（实测 `writeUnsignedInt(0xFF112233)` → 字节 `ff,11,22,33`），故应为 A,R,G,B。

转换全部收敛到 `vendor/skia_glue.cc` 一处（生成的 C 不再假设任何 Skia 字节序），带 `__BYTE_ORDER__` 宏的端序分支也只出现在 glue 内。文档见 [`docs/zh-cn/skia.md`](docs/zh-cn/skia.md) §2.1。

**验收**：

- 新增 `examples/bitmapdraw-channel.as`（+ `.build.json`，Skia 模式）：红背景 `TextField` `draw()` 后取像素 → 修复前 `p=0xff`（红读成蓝，FAIL），修复后 `p=0xff0000 r=255 g=0 b=0` → `ok`；纯 C 构建无 raster 后端时跳过断言。
- `setPixels` 字节序探针：修复前 `getPixel=0xff1122`，修复后 `0x112233`（= `writeUnsignedInt` 的 ARGB 值）✅。
- GPU 侧：`drawToBitmapData` 读回（`stage82.build.json` 的 Metal 构建）实测 `center=0xff0000`、`(1,1)`/`(14,14)` 同为纯红 → `BGRA8Unorm`→ARGB 边界正确。
- `node test.ts` **95 passed / 0 failed**（原 94 + 新增 `bitmapdraw-channel.as`）。
- 顺带清掉注入生成 C 的临时调试打印（`[bddraw]`/`[tfdraw]`/`[tfpx]`/`[bdpx]`，其中 `[tfpx]` 的通道标签本身即错的）。

**遗留（已在阶段八十九·十七修掉）**：`Context3D_get_driverInfo` 的 Metal 判定用的是 `#ifdef ASC_RENDER_METAL`（**窗口 Metal 合成**后端），而 Stage3D 示例的构建清单定义的是 `ASC_RENDER_STAGE3D`（Stage3D glue）——于是 Stage3D 的 Metal 构建实测 `driverInfo="Software (state machine)"`，`examples/stage82.as` 按 `driverInfo.indexOf("Metal")` 分派时误走「纯 C 期望黑屏」分支而 FAIL（GPU 读回其实完全正确，见上）。该宏名不匹配是**既有缺陷**（与字节序修复无关），按代码注释还会影响 Starling 的 profile 重试判定，已在下一阶段单独处理。

---

#### 阶段八十九·十七：`Context3D.driverInfo` 后端判定修正 + Stage3D 示例 AGAL 槽位补齐 + 生成 C 调试打印清理（v0.3.113）✅ 已完成

**依据**：承接阶段八十九·十六的遗留项，遂项核实「Stage3D 的 Metal 构建到底在什么条件下算 Metal」，连带查出另外两处独立缺陷。

**根因与修复（三项）**：

1. **`driverInfo` 判错后端（真缺陷）**：`Context3D_get_driverInfo`（emit.ts）用 `#ifdef ASC_RENDER_METAL` 判 Metal，但两个宏是**独立后端**：`ASC_RENDER_METAL` 只表示**窗口合成**走 Metal（`metal_glue.mm` 的 `CAMetalLayer` + Ganesh）；`Context3D` 本身是否真在 GPU 上，取决于 `stage3d_glue.mm` 是否被链接，而那正是 `ASC_RENDER_STAGE3D`（该宏才是把 `as_s3d_*` 包装器从 no-op 变成真实 Metal 调用的开关）。改为 `#if defined(ASC_RENDER_STAGE3D)`。
   - 不改用 `defined(ASC_RENDER_METAL) || defined(ASC_RENDER_STAGE3D)`：`examples/air-native/air-native.build.json` 只给前者（2D GPU 窗口、不用 Stage3D），其 `Context3D` 实测是纯 C 状态机，用 `||` 会把软件后端错报成 Metal。
2. **`examples/stage83.as` 的 AGAL 字节码格式不对（真缺陷，既有）**：其 `makeVertex`/`makeFragment` 按「紧凑」形式拼接（每条指令 16/12 字节），而 `as_agal_translate` 按 AGALMiniAssembler 的**固定 192-bit（24 字节）槽位**解析（operand 个数不编码在 opcode token 里，靠 24 字节槽位对齐下一条指令）。后果：vertex 程序被静默误解析（下一条指令被并进当前槽的 src2 零填区），fragment 程序只有 23 字节 → `len < 31` → 抛 `AGAL: empty program`。故 stage83 的 Metal 模式根本无法进入 GPU 路径（纯 C 模式不链接 glue，所以回归套件从未暴露此问题）。按 `examples/stage82.as` 的规范形式补上 `u32le(ba, 0); u32le(ba, 0);` 零填充（+ 格式注释）。
3. **生成 C 里的调试打印**：`Context3D_submit`（emit.ts）无条件注入 `static int __tex_log` + `[tex0]..[tex7]` 的 `fprintf(stderr, ...)`（既给纯 C 构建引入 stderr 噪声，又破坏「生成 C 可读」）——已删。加上阶段八十九·十六清掉的 `[bddraw]`/`[tfdraw]`/`[tfpx]`/`[bdpx]`，生成 C 已无任何注入式调试输出（`grep -c` 校验为 0）。

**验收**：

- `node src/index.ts examples/stage82.as --manifest examples/stage82.build.json --run` → `stage82: triangle (Metal) passed`（修复前必 FAIL）。
- `node src/index.ts examples/stage83.as --manifest examples/stage83.build.json --run` → `stage83: (Metal) passed`（修复前抛 `AGAL: empty program`）——render-to-texture 中心像素 `0xFF0000` ✅。
- `node test.ts` **95 passed / 0 failed**（同阶段八十九·十六，未新增示例：修的是既有示例与既有缺陷）。
- 生成 C 抽查：`Context3D_get_driverInfo` 已为 `#if defined(ASC_RENDER_STAGE3D)`；无 `__tex_log`/`[tex*]` 残留。

**遗留（基本关闭，仅剩 shmup 的 web 产物）**：三个不在回归套件内、需手动构建的 demo 产物（`examples/air-native/air-native.c`、`examples/shmup-stage3d/shmup-stage3d.c`、`examples/air-starling-demo/Starling-Demo.c` 及对应 `.o`/web 产物）当时仍是旧文本（含旧 `driverInfo` 条件与 `__tex_log`）。现已随手动构建重建：三份 `.c` 的 `grep __tex_log`/`__present_log` 均为 0，`air-native`（2026-09-26 02:02）与 `Starling-Demo`（2026-09-26 04:16）的 `.o`/`.html`/`.js`/`.wasm` 已同步；**仅 `shmup-stage3d` 的 web 产物（`.html`/`.js`/`.wasm`）仍是 2026-09-21 旧构建**（其 `.c`/`.o` 已是 09-25 18:05 新版）——下次构建该 demo 时自动刷新，不影响编译器源码与回归范围内的产物。

---

#### 阶段八十九·十八：`uploadFromBitmapData` 同步上传 + `TextFormat.align` 水平对齐（Starling 按钮文字乱码/裁切）（v0.3.114）✅ 已完成

**依据**：承接阶段八十九·十六/十七的「文字渲染」线索。按用户要求先跑 AIR `adl` 参考（`examples/air-starling-demo/build-and-run.sh`）截图，再跑 AOT 产物截图对比：参考侧 12 个按钮标签是**清晰纯黑**文字，AOT 侧却是**红/黄/青彩色乱码条**，且部分标签只剩尾巴（`Textures` → `res`）甚至全空。两处根因各自独立。

**根因与修复（两项）**：

1. **`uploadFromBitmapData` 被推迟到下一次 `drawTriangles`，而源 `BitmapData` 已被 `dispose()`（像素级乱码）**：`BitmapData_draw` 的 TextField 分支本身完全正确——先用 `ASC_DUMP_TF_BAKE` 把烘焙 surface 存成 PNG 核验，得到 1144 个非透明像素、全为 `(0,0,0,A)` 的纯黑清晰字形；再用 `ASC_DUMP_BD_DRAW` 把真正交给 Metal 的 `BitmapData.pixels` 存成 PNG，同样是清晰纯黑文字（只被平移裁掉左侧）。问题在下游：`Texture_uploadFromBitmapData` 只**记录** `bitmapData` 指针，真正的 `s3d_upload_texture` 被推迟到 `Context3D_submit`；而 Starling 的 `TrueTypeCompositor` 是 `draw → Texture.fromBitmapData → bitmapData.dispose()` 紧连着走（`renderText` 里显式 `bitmapData.dispose()`），到 submit 时 `pixels` 已被 `BitmapData_dispose` free 掉、`Context3D_submit` 的 `pixels != NULL` 判据不成立**静默跳过上传**，采样槽保留上一次绘制留下的图集内容 → 文字位置采样到按钮图集的橙红渐变，正是看到的红/黄彩色乱码。实验验证：临时在 `BitmapData_dispose` 里关掉 `free()`，乱码立刻变回清晰黑字。
   - **修法**：AIR 的 `uploadFromBitmapData` 本就是**同步**上传，调用方事后 `dispose()` 合法——故 AOT 也在该调用里立刻建好 `MTLTexture`：`Texture`/`RectangleTexture` 增开 `ctx` 字段（`Context3D` 的 glue 句柄，由 `Context3D_createTexture`/`createRectangleTexture` 写入，置于 `gpu` 之后以保持两者**布局一致**、`Context3D_submit` 经 `Texture*` 读 `->gpu` 不越界），`vendor/stage3d_glue.mm` 新增 `s3d_texture_from_pixels()`（建纹理**不占采样槽**，避免污染 unit 绑定；`s3d_upload_texture` 改为它的「建 + 绑定」薄封装），`Context3D_submit` 保持「`gpu != NULL` 则绑槽、否则回落旧延迟上传」——回落分支只在设备尚未就绪（`ctx == NULL`）时才走，不是吞错。
2. **`TextFormat.align` 被忽略（标签裁切/空白）**：`as_tf_paragraph` 把 `align` 硬编码为 0（左对齐），`wordWrap=false` 的字段排版宽度为 0（glue 替换为 1e9，对其做居中会把文字推飞）——于是原生 `TextField` 永远左对齐。而 Starling `TrueTypeCompositor` 正是靠原生字段居中摆字：它按 `textWidth` 定尺建 `BitmapData`，再按 `offsetX = (scaledWidth - textWidth)/2 - paddingX` 平移取窗口；字段不居中，取窗口就把左侧文字切掉（`Multitouch` → `touch`）。
   - **修法**：`align` 分流——新增 `as_tf_align_index`（`TextFormat.align` → SkParagraph `TextAlign`：`left`=0/`right`=1/`center`=2/`justify`=3，Starling 的 `horizontalAlign` 经 `TextFormat.toNativeFormat` 写的就是原生 `align`）在有排版宽度时透传给 `sk_textlayout_*`；无排版宽度时保持 `kLeft`，改由新增的 `as_tf_align_dx` 在绘制原点做整块平移（`center` → `(width - 4 - textWidth)/2`、`right` → `width - 4 - textWidth`，按 AIR 的 2px 文字内边距；选中高亮矩形同步偏移）。对齐值纳入 `_para_align` 排版缓存键。

**验收**：

- `adl` vs AOT 截图逐项对比：12 个按钮标签 + `Metal (Stage3D)` 信息文字全部为清晰、完整、居中的黑色无衬线字，与 AIR 参考排版一致（`temp/cmp_final.png` 左右并排；`temp/aot_align.png` 为修复后 AOT 窗口）。
- `node src/index.ts examples/textfield-align.as --manifest examples/bitmapdraw-channel.build.json --run` → `textfield-align: left inkX=4 center inkX=67 right inkX=131` / `ok`；**同一示例在还原 pre-fix 行为（`as_tf_align_index` 恒定返回 0）时必 FAIL**（`centered text must move right accordingly (left=4 center=4)`），确认断言真的覆盖该缺陷。
- `node test.ts` **96 passed / 0 failed**（原 95 + 新增 `examples/textfield-align.as`）。
- 已清除本轮及上一轮遗留的全部注入式诊断：emit.ts 的 `ASC_DUMP_TF_BAKE`/`ASC_DUMP_BD_DRAW` 两个 dump 分支、`Context3D_present` 里更早遗留的 `__present_log` GPU 读回块（每次 present `malloc(w*h*4)`，1280×2224 下约 11 MB）以及 Starling 源码里 9 处 `System.output("[tf]/[ttc-]/[bmf-]/[btn]/[reg]/[ctlc]...")` 调试打印，均已删除（`grep` 校验为 0）。

#### 阶段八十九·十九：Starling demo 高分屏（HiDPI）+ 12 个场景全量跑通（v0.3.115）✅ 已完成

**依据**：用户两项要求——(1) AIR `adl` 参考图像是高清的，AOT 产物明显模糊，要求解决高分屏；(2) demo 内 12 个场景逐个点击运行时会崩溃，要求逐个测试并修复。定位到一类 **AOT 前端语义缺陷**（共 9 处）加图形后端的两处真实漏洞。

**一、HiDPI（图像模糊）**

- **根因**：`Context3D_configureBackBuffer` 忽略了 `wantsBestResolution`。AIR 在 `requestedDisplayResolution=high` 下会按 `contentsScaleFactor`（本机 2×）分配后台缓冲，Starling 也按 2× 计算 `textureScale`/`backBufferScaleFactor`/投影矩阵；AOT 仍按 1× 光栅化，最后被合成器上采样 → 模糊。
- **修法**：`configureBackBuffer` 里按窗口缩放系数放大后台缓冲（`bbw = width * ASC_win_scale`），新增 `ASC_stage3d_lw/lh` 记录逻辑（stage 单位）尺寸，`ASC_window_render` 合成时「源=物理尺寸、目标矩形=逻辑尺寸」，完成物理像素 1:1 上屏。
- **核验**：AOT 日志 `bb=1280x2160`；清晰度度量（文字带 x120–290 / y400–440 的相邻像素平均梯度）adl **9.62** / 修复前 AOT **7.66** / 修复后 AOT **9.60**（与参考一致）。另确认「stage 只占窗口左上象限」在 adl 中同样如此，不是缺陷。

**二、12 个场景逐个跑通（崩溃/死循环）**

逐项崩溃都定位到具体根因，无一处靠 fallback 掩盖：

1. **`super.m` 作函数值被虚派发 → 无限自递归**（`Masks` 卡死）：`ImmutablePolygon.addVertices` 里 `super.addVertices.apply(...)` 经接收者虚表派发回自己（尾调用优化后栈不增长，表现为 `as_array_make` 调用百万次）。修法：新增 `superBoundMethods` 表，为每个「以值形式出现的 `super.m`」发射 `${owner}_${mname}__superbound` thunk，`env` 静态造型为超类指针，彻底不经接收者虚表。
2. **增量 GC 分配屏障缺口**（`Benchmark` 第三次运行即崩）：见 [`docs/zh-cn/gc.md`](docs/zh-cn/gc.md) §6.5.1——「新生 GC 块生而 black，复制进去的指针必须显式重新置灰」，修复 Array/XML 缓冲/对象属性表/Dictionary 桶/Vector（4 条分支）共 8 处扩容站点。
3. **`ByteArray.length` 是访问器而非字段**（`Vector.<T>` 顶点写入 SIGSEGV）：`ba.length = n` 原本只改字段不重分配。修法：保留 `fields` 里的槽（C 结构体需要）并**同时**注册 `getters`/`setters`，手写 `ByteArray_get_length`/`set_length`（越界 RangeError、倍增扩容零填充、钳位 `position`）。
4. **`new XML(expr)` 重复求值**（`Benchmark` 报 XML 解析错）：实参 `readUTF()` 被发射两次，第一次就读空了缓冲。修法：新增 `as_xml_parse_str_checked(const char*)` / `as_xml_parse_bytes_checked(ByteArray*)` 单次求值助手（不靠临时变量提升，以免改变短路/三元/循环条件里的求值时机）。
5. **`for-in` / `for each-in` 每轮重新求值集合表达式**（`MovieClip` 死循环）：AS3 只求值一次。修法：新增 `hoistCollection()`，先发射一次临时（即使是裸变量），181 处生效。
6. **`x is T` 对 `Object` 型操作数被折叠成常量 `false`**：`Object` 只是静态类型。修法：`Object` 根上的 `is`/`as` 改为运行时检查（`as_is_number_obj`/`as_is_string_obj`/`as_is_bool_obj`/`as_is_fn_obj` 及其 `as_*_obj_val`）；`typéof` 一侧同理新增 `as_ptr_typeof()`（本轮补：`typeof` 对 `Object` 槽内自动装箱的 Number/Boolean/String/Function 也要报出原始类型名，且补上 `dict` 分支与 `default: throw`）。
7. **函数值放入 `Object` 槽**（Starling 事件回调）：新增 `as_function` 包装类（`GCT_FUNCTION_OBJ` + `gc_scan` 分支 + `as_obj_to_value` 拆包为 `as_v_fn`）。
8. **`hasOwnProperty` 语义**（对照 adl 实测确认）：AS3 下它对**本类与所有超类声明的任意 trait**（字段、访问器（getter 或 setter）、方法）都为 `true`。修法：`Object_hasOwnProperty` 改为委托 `as_dyn_has`，`as_dyn_has` 增走 `setters` 表。
9. **访问器属性无法被动态写入**（Starling `Tween` 的 `_target[property] = v` 静默失效）：vtable 头部在 `getters` 后新增 `setters` 反射表，`as_dyn_set` 增「setter 走查」；`emitSetterThunks`/`emitSetterTables` 为每个自有 setter 发射 thunk。
10. **动态写入时 `any` → `Object*` 未自动装箱**（Sprite 3D 抛 `Invalid property: rotationX`）：原实现把带原始 tag 的 `as_value` 当指针解读 → 得到 `NaN`。修法：新增 `as_value_to_obj()`（tag 1/2/3/7 打包成对象、4/6 直通）与完整的 boxed `Boolean` 类（`GCT_BOOLEAN`），`convert`/`unboxAny` 同步补齐。

**三、Metal 后端真实漏洞（不只是崩溃，是「所有带纹理绘制都无效」）**

用 `MTL_DEBUG_LAYER=1` 跑 demo 拿到精确断言：`missing Sampler binding at index 0 for smp[0]`。根因：AGAL→MSL 翻译器**恒定**在每个片元着色器里声明 `sampler smp [[sampler(0)]]`（阶段八十九·三十九 起改为逐被采样寄存器声明 `smpN`），而 `s3d_draw` 从未绑定采样器 → 校验层判绘制无效（未校验时回落到未定义采样状态，故 2D 恰好看不出问题）。修法：`S3DContext` 增 `samplerLinear`/`samplerNearest`，`s3d_create` 建两个采样器，`s3d_draw` 在绑定 `fs0..fs7` 后 `setFragmentSamplerState:atIndex:0`，`s3d_destroy` 释放。核验：`grep -c "missing Sampler"` = 0，2D 渲染不变。

**验收**：

- 干净构建产物 + `temp/hidpi/sweep_aot.py`（带「等窗口内容真的变了再截图」的签名轮询，避免抢拍到菜单帧）全量复跑 12 个场景：**12/12 存活、0 个 `Uncaught exception`**；`Benchmark` 跑到 `Result: 21731 objects with 120 fps`。
- 新增 `examples/reg-as3-semantics.as`：9 组断言固定本轮语义修复（for-each 单次求值、`is`/`typeof` 对 `Object`、`Object` 槽内函数值、`super.m` 作值、`hasOwnProperty`/`in` 对继承 trait、动态写入访问器、`ByteArray.length` 重分配、`new XML(...)` 单次求值、interface Vector 扩容后过 GC）；还原 pre-fix 行为时必 FAIL。
- `node test.ts` **98 passed / 0 failed**（原 97 + 新增 `reg-as3-semantics.as`）。
- 本轮所有注入式诊断（`[P3D]`/`[TW]`/`[AN]`/`[TN]`/`[showScene]`/`[XMLIN]`/`MVP3D PROBE_`/`MAT3D`/`VDRAW`/`TARGET_DUMP`/`ASC_VS_ZOOM`/`ASC_FS_MAGENTA` 等）已全部撤除（`grep` 校验为 0），demo 源码仅保留「恢复成原样」的改动。

**遗留（未在本阶段处理，见下表）**：非矩形遮罩（GPU stencil）、滤镜/渲染纹理的纹理缩放路径、背面剔除（`Context3DTriangleFace.BACK`）、`Sprite3D` 场景在原始 `gamua-logo` 子纹理下立方体不可见（用 `flight_00` 框架式子纹理可见）。已在 adl 参考下截图留证，属于**既有图形能力缺口**（非 HiDPI 回退）。

> **后续**：其中「背面剔除 + 深度测试」「逐绘制采样状态」「GPU 模板遮罩」「`Sprite3D` 子纹理可见性」四项（A/B/C/D）已在**阶段八十九·二十**实装；但 **C 的 `MaskScene` 路径仍存疑**——阶段八十九·二十二/二十三 实测被遮对象未裁剪，与本阶段「已真正生效」的结论冲突，按未生效记入 `### 遗留待开发` 表。**该存疑已于阶段八十九·四十四 定案**：stencil 实现本身正确，真凶是**类字段遮蔽被继承扁平化合并成一个 C 槽**（`MaskScene._mask` 与 `DisplayObject._mask` 撞槽，场景自己被当成被遮对象），修后 Back 按钮可见可点。

---

#### 阶段八十九·二十：Stage3D 遮挡与状态真正贯通（背面剔除 / 深度-模板 / 逐绘制采样）（v0.3.116）✅ 已完成

**依据**：阶段八十九·十九 遗留的四项图形能力缺口，由用户确认「全部本轮实现」——(A) GPU 背面剔除 + 深度测试、(B) 逐绘制纹理采样状态、(C) GPU 模板遮罩（Masks/滤镜）、(D) `Sprite3D` 子纹理可见性偏差。

**一、A 背面剔除 + 深度测试**

- `Context3D_setDepthTest`/`setCulling` 此前只记录到 C 结构体字段，从未下到 GPU。本轮新增 `as_s3d_set_depth`/`as_s3d_set_cull` 转发 → `s3d_draw` 里 `setCullMode` + `MTLDepthStencilState`。
- **绕序是关键**：Stage3D 的裁剪空间 Y 向下、Metal Y 向上，几何到达光栅化时绕序整体相反，于是 Starling 认定「正面」的三角形在 Metal 里是顺时针。必须在每个绘制上 `setFrontFacingWinding:MTLWindingClockwise`，否则 `cullMode=Back` 会把**该保留的面全剔掉**——`Sprite3D` 立方体曾因此彻底消失（全白）。
- `Context3DTriangleFace.FRONT_AND_BACK` 是 Stage3D 的「不剔除」默认值（Starling 2D 全程用它），映射到 `MTLCullModeNone`，不是 GL 的「两面都剔」。

**二、B 逐绘制采样状态**

- `Context3D_setSamplerStateAt` 原本是空实现（no-op），`s3d_draw` 恒绑定一个固定线性采样器 → `REPEAT`/`NEAREST` 全被忽略。本轮按 (wrap, filter, mip) 三元组缓存 `MTLSamplerState`（`s3d_sampler_for`），在 `s3d_draw` 里按**最低已绑定纹理单元**的已记录状态绑定到 `smp[0]`。
- **受限点（已注释在代码里）**：AGAL→MSL 翻译器恒只声明 `sampler smp [[sampler(0)]]` 一个采样器，因此多纹理单元无法各自带不同过滤状态，多纹理滤镜（Displacement/Composite）用基纹理单元的采样状态。这是**陈述事实的限制**，不是静默降级。→ **阶段八十九·三十九 已修**：翻译器改为逐被采样寄存器声明 `sampler smpN [[sampler(N)]]`，后端逐单元绑定状态（见该阶段条目）。

**三、C GPU 模板遮罩（含一个隐蔽的语义 bug）**

- Starling 非矩形遮罩协议（`Painter.drawMask`）：遮罩几何按 `EQUAL`(当前 reference) + `INCREMENT_SATURATE` 画一遍 → `stencilReferenceValue++` → 被遮对象按 `EQUAL`(新值) 画。`eraseMask` 对称递减。
- 需要的关键状态：模板**附件**（阶段八十七已分配）、每绘制的 `MTLDepthStencilState`（`s3d_rebuild_dss`，face-aware、按状态变化重建）、`setStencilReferenceValue:atIndex`、读/写掩码。深度/模板附件的 `storeAction` 必须是 `Store`（每次绘制是独立 render pass，绘制 N 写的遮罩必须能被 N+1 读到）。
- **隐蔽 bug**：`Context3D_clear(..., depth, stencil, mask)` 的 `stencil` 参数是**模板清屏值**，不是装饰。Starling 调 `RenderUtil.clear(rgb, alpha, 1.0, Painter.DEFAULT_STENCIL_VALUE)` → 模板被清成 **127**（不是 0）。AOT 原来把 `stencil` 参数整丢掉、硬编码清 0，于是第一次 `EQUAL`(127) 就对不上 → 增量永不发生 → 被遮对象 `EQUAL`(128) 也永不匹配 → **Masks 场景整场空白**。修法：`as_s3d_clear` 转发 depth/stencil 清屏**值**，`s3d_draw` 用 `c->clearDepthValue`/`c->clearStencilValue`。`Context3DClearMask` 同时由字符串改成 adl 实测的 uint 位掩码（COLOR=1/DEPTH=2/STENCIL=4/ALL=7）。
- **性能陷阱（实现中实测到并修掉）**：深度+模板附件是 1280×2160 的 D32S8（约 22 MB），每次绘制都 Load+Store 就是 44 MB/绘制，而 Starling 每秒发出数万次绘制 → 渲染一帧要 10 秒以上，`CAMetalLayer` 的 3 个 drawable 被耗尽、窗口**冻在上一帧**（进程还活着、CPU 5%、`sample` 停在 `nextDrawable` 信号量上）。修法：只在「这次绘制真的需要深度/模板」时才挂附件（`depthCompare != always` 或 `stencilCompare != always` 或模板动作 `!= keep`），不挂附件的 pass 既不读也不写模板纹理，因此先前写入的遮罩状态原样保留，语义仍正确。

**四、D `Sprite3D` 子纹理可见性**

- `Sprite3DScene` 恢复用原 demo 的 `gamua-logo`（无 frame 的裸 `SubTexture`）后立方体可见，三面着色（蓝/品红/绿）+ 贴图字样与 adl 参考一致。此前「不可见」是**多因素叠加的历史现象**：绕序剔除把面剔光 + 采样器未绑定 + 深度/模板附件路径未贯通，逐项修完后自然可见；无需改 demo（demo 保持原样）。

**验收**：

- `temp/hidpi/sweep_aot.py` 全量 12 场景：**12/12 存活、12 张截图互不相同（md5 唯一）**，`Filters` 场景 HUD 显示 **112 fps**。
  - 遮罩前/后对比（stage 区平均亮度，adl 参考 176.1）：`Masks` 空白 242 → **182.0**；`Filters` 抢拍到陈旧帧 196.1 → **171.0**（adl 174.4）。
- 逐项视觉核验（与 adl 参考截图对照）：`Masks` 出现被遮罩裁剪的飞鸟、`Sprite3D` 立方体三面可见（贴图字样镜像方向与 adl 一致）、`Filters` 气泡背景 + 滤镜文字 + HUD 正常。
- `examples/stage81.as` 断言更新为 adl 实测的 `Context3DClearMask` 位掩码值（COLOR=1/DEPTH=2/STENCIL=4/ALL=7，原先错断言为字符串 `"all"`），并补上本轮新增的转发路径调用（`setStencilActions`/`setStencilReferenceValue`/`setSamplerStateAt`/`setScissorRectangle` 与 7 参 `clear(..., depth, stencil, mask)`）。
- `node test.ts` **98 passed / 0 failed**。

**排障经验（值得留档）**：本轮一度误判「Masks 之后场景冻结、深度/模板附件是元凶」，做了「不挂附件」对照实验仍复现，最终用 `sample` + CGWindow 列表定位到真因是**驱动脚本的点击没落到窗口上**（demo 窗口在 z-order 里排到第 29 位，Quartz 点击被别的窗口截走）——不是应用缺陷。`sweep_aot.py` 因此新增 `activate()`：每次点击前用 `osascript` 把 demo 置为 frontmost。**结论：截图一致/窗口无响应这类观测，先验证「点击是否真的送达目标窗口」，再怀疑应用。**

---

#### 阶段八十九·二十一：用户报四问题收尾（ATF 解码 / 闭包引用语义 / 滤镜渲染链 / HUD 与 Sprite3D 复核）（v0.3.117）✅ 已完成

**依据**：用户在 Starling demo（AOT 与 adl 截图对照）报四个渲染问题——(1) 压缩纹理（ATF）显示为粉块、(2) 左上角 FPS 统计框的底色未绘制、(3) `Filters` 场景渲染错乱且点击上方按钮崩溃、(4) `Sprite 3D` 场景空白。逐项用「adl 参考 + 注入式诊断 + 崩溃报告」定位到 **6 处真缺陷**（3 处在编译器/运行时、3 处在 Stage3D glue）。

**一、ATF 压缩纹理（问题 1，粉块）**

- **格式落地**：按 openfl `ATFReader`（权威，Ruffle 的 header 分支有误）验证容器逐字节布局：`"ATF" | 00 00 | FF | version | u32BE length | tdata | wLog2 | hLog2 | mipCount`，每 mip 层按 GPU 格式（version<3 为 DXT/ETC1/PVRTC）各一条长度前缀记录。demo 的 `1x/compressed_texture.atf`（41072 B）与 `2x`（163964 B）均为 **format 5 = RAW_COMPRESSED_ALPHA（DXT5）**，128×128 / 256×256，**mip 1+ 为空**。
- **运行时解码**：`runtime.ts` 新增 `as_atf_decode_dxt`（含 DXT5 8 档 alpha 调色板 / DXT1 1-bit alpha 与 3 色模式、`as_dxt_unpack565`）→ `Texture_uploadCompressedTextureFromByteArray` 解码进 `BitmapData` 并**急切上传** GPU（复用既有普通纹理路径，`s3d_texture_from_pixels` → `MTLPixelFormatBGRA8Unorm`）。**不做预乘**：文件是直通 alpha，adl 也是把裸 DXT5 交给 GPU。不可解码（cubemap/非 3/5 格式）**响亮抛错** `Error #3680`，不静默出空图。
- **真正的拦路虎不是解码**：解码实测成功（临时 `[ATFDBG]` 探针确认 256×256 已解码上传），但 `AssetManager.addAsset` 从未收到 `compressed_texture`。根因是**编译器闭包引用语义缺失**——`AtfTextureFactory.createTexture` 里 `onReady` 闭包先安装、`var texture:Texture` 后赋值，而旧实现把捕获变量**按值快照**进 env，闭包永远读到 `null`，`AssetManager.onAssetLoaded` 的 `if (name && asset)` 便静默跳过注册（队列照样完成 → 进度 1、无 `Adding texture 'compressed_texture'`）。`temp/capt/cap.as` 独立复现（`plain-case sees t=null`）。

**二、闭包引用语义（编译器，问题 1 的根因）**

- 把原先只覆盖「同函数内互递归 sibling 组」的共享 cell 机制**推广为逐函数激活单元（activation cell）**：函数体里被**直接嵌套闭包**捕获的**已 hoist 类型化 `var` 局部**在函数入口分配一个堆 cell（`_cellN_alloc()`），函数体内对这些局部的访问走 `cellN->x`，每个需要它的闭包把 **cell 指针**作为普通捕获透传（env 结构 / mark 回调 / `_env_make` 参数 / 名字解析全部复用既有机制，含跨多层闭包传递）。
- key 用**函数体的 AST 语句数组**（walk 与 emit 两趟是同一对象，无命名歧义）；`buildVarCells` 三趟：按 body 建 cell → 逐闭包后序求 `resolve`/`ptrs` → 注入合成指针捕获（同步 `captures`/`nestedFuncs`/`anonCaptures`）。组机制保留但**排除集按函数体计算**（`fnBodyKids(body)` ∩ 组成员）——早先按名字全局排除曾误杀 ATF 的 `texture` cell（另有无关组也捕获同名 `texture`）。
- **同时修掉一个同族漏洞（模块全局被按值捕获）**：写新回归示例时发现闭包的「自由变量捕获」把**顶层脚本 `var`**（模块全局）也快照进了 env——闭包里 `x = ...` 只改 env 副本、模块全局永不变化（最小复现：顶层 `var x:String = "unset"; var f:Function = function():void { x = "set"; }; f(); trace(x)` 输出 `unset`）。修法：`collectScriptVars()` 先扫出与 `emitModuleVars` **完全一致**的模块全局名集，捕获查找（新增 `lookupCaptureVar`，`lookupEnclosingVar` 同步）对这批名字直接返回「不是捕获」→ 读/写落到 C 全局本身。集合必须双向一致：一边当全局、一边当捕获会静默读到过期快照（已在两处注释互相提示）。不在此集的顶层名（如顶层 `for (var i…)`，`moduleScope` 不含）保持原按值捕获，避免把「原先能编译」的代码变成编译错误。
- 验收：新增 `examples/reg-closure-ref.as`（8 组断言：创建后赋值可见、闭包写回、两闭包共享槽、深度 2 孙闭包、嵌套函数声明后置调用、参数仍按值、闭包体内的激活单元、函数体 `var` 提升共享）并纳入 `node test.ts`；`temp/capt/cap2.as` 八组断言同过；`node test.ts` **99 passed / 0 failed**。

**三、`Filters` 场景崩溃（问题 3a，AGAL→MSL）**

- 用户日志里的 MSL 编译失败 `ft5 = (in.v0 >= in.v0) ? float4(1.0) : float4(0.0);` 是**全掩码比较指令**被译成三元表达式（Metal 不接受 `bool4` 条件）。改为 `select(v4(0.0), v4(1.0), s1 >= s2)`（MSL）/ `mix(v4(0.0), v4(1.0), v4(greaterThanEqual(...)))`（GLSL），覆盖 `sge/slt/seq/sne`；部分掩码补齐 `0x0e normalize`、`0x11 cross`；**未译指令不再静默 `continue`**，改为 `agal_unsupported()` 置 `as_agal_errmsg` + 翻译返回 NULL → 调用点 `as_throw`（`sgn`/`tld` 明确保留为响亮错误）。

**四、`Filters` 场景渲染错乱（问题 3b，Stage3D glue 三连）**

用 `[PRT]` 探针 + 崩溃报告定位：`setRenderToTexture` 的渲染目标是 `flash.display3D.textures.RectangleTexture`，`gpu == NULL` → 离屏通道实际画到后台缓冲、末道四边形采样空纹理 → 拼贴状错乱。三处真缺陷：

1. **`Context3D_createRectangleTexture` 忽略 `optimizeForRenderToTexture`**：`hll` 里被 `(void)` 丢弃，从不分配 render-target `MTLTexture`。改为与 `createTexture` 同契约（true → `as_s3d_create_render_texture`）。Starling 的 `Texture.empty(...)` 对非压缩/mip 纹理**一律走 RectangleTexture**——凡滤镜离屏通道都命中此路径。
2. **离屏通道缺配套深度/模板附件**：`s3d_draw` 一律挂**窗口尺寸**的 D32S8，与渲染目标尺寸不符时 Metal 直接丢弃整个 render pass（目标里残留旧内容）。`s3d_set_render_target` 增 `enableDepthAndStencil` 参数，按目标尺寸**惰性+尺寸缓存**建 `rtDepthStencil`，`s3d_draw` 按是否离屏择一。
3. **已释放纹理仍被绑定 → `EXC_BAD_ACCESS`**（点击第二次起崩溃；崩溃报告显示 `s3d_draw → setFragmentTexture:atIndex: → objc_retain`）：AS 侧 `dispose()`/重新 `uploadFromBitmapData` 释放了 `MTLTexture`，而某 Context3D 的采样槽/渲染覆盖仍**借用**该指针。glue 新增活上下文注册表，`s3d_destroy_texture` 先 `s3d_unbind_texture_everywhere()` 清空所有绑定再 `release`。

**五、滤镜全黑 + HUD 底色（问题 2/3b 的共同根因）**

- **`setProgramConstantsFromVector` 的 `numRegisters = -1` 语义**：AIR 签名 `(..., numRegisters:int = -1)`，`-1` 表示「按 `data` 长度取寄存器数」，Starling 的 `BlurFilter`/`ColorMatrixFilter` 正是只传 vector。旧实现 `numRegisters * 4` 把 `-1` 乘成负长度、被 `if (n < 0) n = 0` 夹成 0 → **一个常量都没上传**：`mul ft, ft, fc0.xxxx` 全乘 0 → 滤镜输出纯黑（离屏目标 dump 为 PPM 证实全黑）。改为 `numRegisters < 0` 时取 `data->length & ~3`，并补 `data == NULL` 保护。
- **`Context3D.totalGPUMemory`**：`StatsDisplay.supportsGpuMem` 用 `"totalGPUMemory" in context` 探测，缺该属性时整行「gpu memory」消失、HUD 与 adl 行数不一致。新增只读 getter（近似：后台缓冲 BGRA8 字节数 + 有深度模板时再加 D32S8 字节数），`docs/zh-cn/display3d.md` 已注明「近似」。

**六、问题 2 / 4 复核**

- 问题 2（HUD 底色）：SPACE 键（CGEvent 投递，`osascript keystroke` 到不了 SDL 窗口）打开统计后，AOT 现渲染 **绿色底 + 白字**，与 adl 一致；行数也因 `totalGPUMemory` 补齐而一致。
- 问题 4（Sprite 3D）：立方体三面 + GAMUA 贴图正常渲染（与 adl 仅**相位不同**——该场景对 X/Y/Z 分别 6/7/8 秒 tween 旋转，截图时刻差即面朝向不同；六面颜色源码为 red/green/blue/yellow/magenta/cyan）。

**验收**：`node test.ts` **98 passed / 0 failed**；`temp/hidpi/demo_all2.py` 全量 12 场景 **12/12 存活、无崩溃**；`Filters` 场景 Identity→Blur→Drop Shadow→Glow→Displacement Map 连点五次全部正确渲染且不崩（`flt8_s*` / `cmp_flt8_view.png`）；ATF 纹理渲染与 adl 一致；`Sprite3D` 立方体可见（`cmp_s3d_view.png`）；注入式诊断（`[PRT]`/`[DRAW]`/`[DUMP]`/`[S3DDbg]`/`[ATFDBG]`）已全部撤除，glue 仅保留「无 render-target usage 的误用」响亮告警。版本号 v0.3.116 → v0.3.117。

---

#### 阶段八十九·二十二：用户报两问题（Sprite 3D 返回崩溃 / 混合模式无效）（v0.3.118）✅ 已完成

**依据**：用户报「进入 Sprite 3D 点 Back 就崩溃（第一次可能不崩，再次进入必崩）」+「Blend Modes 点 Switch Mode 没有效果」，附 macOS `EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS 0x0` 崩溃日志。两个问题各自独立、都已定位到真根因。

**问题 1：中帧 `System.gc()` 扫掉了只被 C 局部持有的对象（崩溃）**
- 症状：崩溃栈 `Starling_render` → `Starling_onEnterFrame__bound` → … → `dispatchEventWith +80`（返回地址恰好是 `bl Event_fromPool_static` 的下一条），`pc = 0`。
- 根因（实测锁定，而非推测）：`Game.showMainMenu()` 在**活着的 AS3 帧内**调 `System.pauseForGCIfCollectionImminent(0)` + `System.gc()`。全停顿 `gc_collect()` 没有栈根（无 shadow stack），于是 `EventDispatcher_dispatchEventWith` 里**正在派发、只被 C 局部持着**的 `Event*`（刚从 `Event.sEventPool` 弹出）被扫掉；返回后 `Event_toPool_static(event)` 把这个已释放对象 `push` 回对象池，下一次 `Event_fromPool_static` 弹出的对象 `vtable` 已被复用（同为 ~64B 的 `PTR_ARRAY` 占位），尾调 `_event->vtable->reset(...)` 跳地址 0 → SIGSEGV。
- 证据链：注入式 `[POOLDBG]/[GCDBG]/[NEWEV]` 打印显示「`[GCDBG]` 之后立刻 `[POOLDBG] pop <ptr> vt=<堆地址>`」，坏地址恒为程序里**第一个**创建的 Event（vt 从静态 `0x103b72bc8` 变成堆 `0xbc7446af8`）；把 `as_system_gc()` 临时改为空函数后连点 10 次按钮干净退出（`exit=0`）——证明是「中帧采集」而非对象池漏根/漏屏障（对象池本身的 mark 链复核无问题）。
- 修法（`src/runtime.ts` + `src/emit.ts`，不引入 shadow stack）：
  1. `gc_mark_roots()` 末尾追加**中帧保守栈扫描** `gc_mark_stack()`：`setjmp` 落盘 callee-saved 寄存器后，逐对齐字扫 `[SP, gc_stack_top)`，用 `gc_is_object()`（段内地址 + tag 合法 + color 合法 + size 合理）筛出「像对象」的字，再 `gc_mark_ptr`。
  2. 窗口上界由 `GC_NOTE_STACK_BASE()` 锚定——`emitMain()` 在生成 `main()` **首行**发出该宏（宏体内取局部变量地址，故锚点落在 `main` 帧上，覆盖整条活着的调用链）。
  3. 为让垃圾位模式不可能被误认成对象头（`gc_scan` 的 `GCT_CUSTOM` 分支会把头里的字当函数指针调）：`GCT_*` 常量统一偏移 `GCT_TAG_BASE 0x47430000`（`"GC"`），且**空闲块与切分剩余块 `type` 显式写 0**（`gc_alloc` 的 free-list split、新段 carve、`gc_sweep_step` 释放三处）。头部仍为 24 字节，不增字段。
  4. 语义取舍说明：`System.gc()` 保持**立即回收**（`stage57`/`gc_strings`/`gc_incremental`/`gc_barrier` 的「返回后 `totalMemory` 归零」断言与 AGENTS.md 语义都不变）；安全点采集（`Stage_dispatchFrame`）也跑同一套 `gc_mark_roots()`，此时窗口里只剩 run-loop 链（`main` 持 `g_stage`/`g_app`，本就是永久根），代价与误保留均为零。
- 新回归示例 `examples/gc_midframe.as`：监听器在 `dispatchEvent` 派发中调 `System.gc()`，随后堆扰动（复用刚释放的块）再回读事件，外层帧再断言自己的局部（payload/event）完好；200 轮全过才算通过。**反向对照**：临时注释掉 `gc_mark_stack()` 后同一示例 **round 0 即 FAIL**（`FAIL: dispatched event survived mid-frame gc`，`exit=1`），证明该示例真正守住这条语义。

**问题 2：`setBlendFactors` 在同一 `Program3D` 上中途改变被静默丢弃（Blend Modes 无效）**
- 症状：`Blend Modes` 场景点 `Switch Mode`，左下标签在 `normal/multiply/screen/add/erase/none` 之间正常轮换（AS3 侧 `onButtonTriggered` 与 `Image.blendMode` 都对），但**图像像素一个都不变**（逐点击比对 `rock_diff = 0`）。
- 根因：Metal 把 blend state **烘进** `MTLRenderPipelineState`（不像 GL 有逐绘制设置），而生成 C 只在 `program != gpuProgram` 时编译一次管线（`emit.ts` 的 `Context3D_submit`）；`as_s3d_set_blend` 只记录因子，之后任何改动都不再影响已绑定的管线 → 只有「编译前设定的那一组因子」生效。
- 修法（`vendor/stage3d_glue.mm`）：上下文**保留已编译的 vertex/fragment 函数**，并**按 blend 因子对缓存管线**（`S3DBlendVariant bvars[12]`，LRU）；`s3d_draw` 编码前调 `s3d_select_pso()` 按当前 `blendSource/blendDest` 选择变体（缺失则懒建），`s3d_compile` 清空变体缓存并预置当前因子那一组，`s3d_create/destroy` 完整初始化/释放（含函数与全部变体，避免 MRC 泄漏/双重释放）。管线创建抽成唯一入口 `s3d_make_pso()`。
- 验收：同一连点序列现在 `rocket_diff` 达 4.2 万~7.8 万像素（`multiply` 呈「白底透出」、`erase` 呈擦除白），第 6 次回到 `normal` 与初始逐像素一致（diff 0）；其余 11 个场景与修前截图逐像素比对差值 ≤ 8.9（噪声底 ~4.5），**无渲染回归**。

**验收**：`node test.ts` **100 passed / 0 failed**（含新示例 `gc_midframe.as`，native 目标）；`temp/hidpi/demo_all2.py` 全量 12 场景 **12/12 存活**；`temp/hidpi/cycle.py`（进场景→点 Back 循环）Sprite 3D **25 轮无崩溃**（修前第 2 轮必崩）；修后生成的 `Starling-Demo.c` 已确认零注入式诊断残留。版本号 v0.3.117 → v0.3.118。

**已知遗留（本轮未处理，另行立项）**：
- `Masks` 场景只见背景（Back 按钮在该场景既不被粉色检测到、点击也不响应）——**修前修后一致**（`sweep3/s2_10.png` 与 `sweep4/s2_10.png` 对比），属先前遗留，非本轮回归。
- demo 逐场景进出会持续增 RSS（约 +4 MB/s，Sprite 3D 循环 25 轮 155MB→600MB）——**与 GC 无关**（把 `as_system_gc()` 改为空函数后增速完全相同），且**禁用 GC 的旧二进制早期增速也一致**，指向「字节缓冲走 arena/malloc 不回收」这条已知遗留（见下方遗留表）。
- 本机已无 WASI SDK（`WASI_SDK_HOME` 未设且系统内找不到 `wasi-sysroot`），故 `--target wasm` 的 GC 示例本轮**未能复跑**；保守栈扫描只用 `setjmp`/逐字 `memcpy`/段内地址判定，wasm32 下栈在线性内存内、指针 4 字节对齐，路径与原安全点路径共用，风险低但**待有工具链时补验**。

---

#### 阶段八十九·二十三：用户报「Custom hit-test 点 Hold me! 崩溃」（v0.3.119）✅ 已完成

**依据**：用户报「点击 Custom hit-test 的 `Hold me!` 按钮会崩溃」，附 macOS `EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS **0x8**` 崩溃日志（`11:05`/`11:22`/`11:23`/`11:24` 四次，运行的都是阶段八十九·二十二修好的 v0.3.118 二进制，但崩溃栈型与上一阶段完全不同）。

**根因：类型化 `const` 局部被登记为激活单元字段，但声明处从不写该字段 → 闭包读到 NULL**
- 崩溃栈：`Starling_advanceTime` → … → `TouchProcessor_processTouches` → `ButtonBehavior_onTouch__bound` → `dispatchEventWith` → `dispatchEvent` → `bubbleEvent` → `invokeEvent +552` → **`_fn9__call +48`**，`far = 0x8`（读 `NULL + 8`）。x10 已是 `utils_TextButton_vt`（`textButton` 解引用成功），说明崩在**数组**一侧。
- 反查生成 C：`CustomHitTestScene` 的 TRIGGERED 监听是 `function():void { textButton.text = texts[++hitCount % texts.length]; }`，`const texts:Array` 被闭包捕获。`_fn9__impl` 读 `env->cell87->texts`，但 `scenes_CustomHitTestScene_ctor` **只**写 `cell87->textButton` 与 `cell87->hitCount = 0`，**从不**写 `cell87->texts`；`gc_alloc` 把 cell 清零 → `texts == NULL` → `as_array->length`（偏移 8）→ `far = 0x8`。
- 机理（`src/emit.ts` 的两处集合不一致）：`walkStmt` 的 `ConstDecl`/`ConstDecls` 对**类型化** `const` 调了 `noteFnBodyVar()`（进 `fnBodyVars`），`buildVarCells` Pass A 便为一个被闭包捕获的 `const` 建出 `cell->texts` 字段；但 `collectHoistedVarsStmt` **不**提升 `const`（AS3 里 `const` 是块级作用域、`var` 才是函数级），于是 `hoistedLocals` 里没有它 → `buildEnclosingCaptured` 的 `hoistedLocals` 过滤把它挡在 `enclosingCaptured` 之外 → 声明处走 `ConstDecl` 的「发一个普通 C 局部」分支，**没有任何一处写 cell**；而 cell 字段的写点本就依赖「声明体经 `cell->field` 赋值」这条 `var` 专用路径。闭包侧 `env->cell87->texts` 与声明侧普通 C 局部 `texts` 就此分叉。
- 另注：该缺陷**非本轮 GC 修复引入**——阶段八十九·二十二的修前生成 C（`/tmp/sd_orig.c`）里 `cell87` 同样只有 `textButton`/`hitCount` 两处写；本轮只是把用户引到了这个场景，此前该栈型只是被 Sprite 3D 崩溃掩盖。
- 修法（`src/emit.ts`，2 处 `noteFnBodyVar` 调用删除）：**类型化 `const` 不再登记为激活单元候选**。`const` 是不可变绑定，「按值捕获」与「按引用捕获」语义等价，而它**必须**按值捕获——块级作用域 + 从不提升决定了声明体没有可写的 cell 字段。删掉登记后：闭包经 `env->texts` 读（`_fn9_env_make` 本就按值传了 `texts`，env 的 mark 函数 `gc_mark_ptr(e->texts)` 负责其存活），声明体保留块级 C 局部，两侧一致。
- 语义边界（保持响亮失败，不静默错误）：`const` 声明在其**使用点之后**时仍按「先用后声明」拒绝（块级作用域语法的必然结果），报 `CodegenError` 而非生成垃圾 C。
- 新回归示例 `examples/closure_const.as`（5 组断言）：① 闭包读 `const` 数组索引（复刻崩溃形态，`bcab`）；② 块内 `const` 捕获；③ 循环内 `const` 按迭代独立捕获（`L0L1L2`，与循环内 `var` 共享一个 cell 形成对照）；④ 捕获的 `const` 跨 `System.gc()` 存活（验证 env 的 mark 函数真的标了它）；⑤ `const`（按值）与 `var`（按引用，写回可见）在同一闭包内共存（`<!`，其中 `var` 在闭包创建后再赋值）。**反向对照**：把两处 `noteFnBodyVar` 临时恢复后同一示例 **SIGSEGV（exit=139）**，证明该示例真正守住这条语义。
- demo 验证：`Starling-Demo`（重新生成 C + 原生重编）下 `btn:4`（Custom hit-test）→ `at:160:382`（`Hold me!` 按钮）连点：标签正确轮换 `Hold me! → Thrill me. → Kiss me! → Kill me! → Hold me!`（`texts[++hitCount % 4]`，截图逐张核对一致）；**进场景→点 2~6 次→Back 共 4 轮、19 次点击全程存活**（`temp/hidpi/hc_*`），无新崩溃报告（`DiagnosticReports` 停在 11:24 修前）。

- demo 验证：`Starling-Demo`（重新生成 C + 原生重编）下 `btn:4`（Custom hit-test）→ `at:160:382`（`Hold me!` 按钮）连点：标签正确轮换 `Hold me! → Thrill me. → Kiss me! → Kill me! → Hold me!`（`texts[++hitCount % 4]`，截图逐张核对一致）；**进场景→点 2~6 次→Back 共 4 轮、19 次点击全程存活**（`temp/hidpi/hc_*`），无新崩溃报告（`DiagnosticReports` 停在 11:24 修前）。
- 无回归：`temp/hidpi/demo_all2.py` 全量 12 场景**进入均成功且零崩溃**（`sweep5/`；其中 Masks 与 Sprite 3D 报 `STUCK-AFTER-SCENE` 系该脚本用**计算几何**定位 Back 的偏差——`cycle.py` 用**粉色检测**定位在 Sprite 3D 连做 6 轮「进场景→点 Back」全部返回主菜单且零崩溃，且 Masks 的 Back 不响应是阶段八十九·二十二已记录的**先前遗留**）；`node test.ts` **101 passed / 0 failed**（含新示例 `closure_const.as`，native 目标）。版本号 v0.3.118 → v0.3.119。

---

#### 阶段八十九·二十四：用户报「Benchmark 测试时内存泄露」（v0.3.120）✅ 已完成

**依据**：用户报「Benchmark 测试时内存泄露」，附截图：Benchmark 跑到 **13279 objects** 时 Activity Monitor 显示 **14.17 GB** 常驻内存（StatsDisplay `std memory 57.1` / `gpu memory 31.0`）。

**复现（`temp/hidpi/mem.py "btn:9,at:160:60"`，Benchmark 场景 Start 按钮位于 `at:160:60`，粉钮扫描检测不到）**：RSS **255 MB → 14298 MB / 23 s**（峰值约 630 MB/s，与用户截图 14.17 GB 吻合），随后在 14297.8 MB 平顶；空载主菜单 0 增长、Animations 场景（静止）0 增长 → 泄漏绑定「顶点几何持续变化」。

**分配源定位**：`MallocStackLogging=1` + `leaks` + `vmmap -summary`（全部落在 DefaultMallocZone，`heap` 显示 4 MB[2974]、2 MB[1824]、1 MB[1623] 等 2 的幂次块）：
- `ROOT LEAK: <realloc in as_vector_number_setLength>` ← `VertexBuffer3D_uploadFromByteArray` ← `Effect.uploadVertexData` ← `MeshBatch.syncVertexBuffer`：**241 例 / 194 MB** + **230 例 / 181 MB**
- `ROOT LEAK: <realloc in as_vector_uint_setLength>` ← `IndexBuffer3D_uploadFromByteArray`：**222 例 / 30.4 MB**
- 合计约 2478 例 / 407 MB（约 20 s 内），即每帧 2~3 例。

**根因：`Vector` 的标量元素负载在 GC 堆之外，永远不回收**
- `as_vector_*` 结构体本身走 `gc_alloc(GCT_CUSTOM)`（带 `mark` 回调，可回收），但 `vectorElemIsPtr() == false` 的元素类型（number/int/uint/bool/**any**/interface/record/dict/class/regexp）其负载一直是裸 `realloc`/`malloc` → **在 GC 堆之外、永不归还**；每次扩容都丢掉旧缓冲，故「任何 Vector 一经创建，其负载永久泄漏」（这也解释了此前记录的「进场景 +4 MB/s」）。引用元素类已走 `gc_alloc(GCT_PTR_ARRAY)`。
- 放大器：`VertexBuffer3D_uploadFromByteArray` **每次调用都新建两个全尺寸 `as_vector_number`**（另加一个 `as_vector_uint` 索引），覆盖 `o->data`/`o->rawBits`；而 `Effect.uploadVertexData → uploadToVertexBuffer → uploadFromByteArray` 在**顶点变化的每一帧**都会跑（Benchmark 的容器一直在旋转），每次按整个批次大小（~2 MB）重新分配。

**修法（两部分 + 1 处一致性修正）**
1. **负载上 GC 堆（根因修）**：`src/runtime.ts` 新增叶子类型 `GCT_RAW`（`gc_scan` 不扫、由该 Vector 的 `GCT_CUSTOM` 回调显式追踪其中的 `*` 装箱槽与接口 `obj`）→ 孤立的旧负载从此可被回收；因多 MB 负载会走 `gc_alloc` 的**超大专用段**分支，`gc_is_object` 的 size 上界由 `GC_SEG_SIZE` 放宽到 `1u << 30`。`src/emit.ts` 把原先四处分头 `realloc` 的扩容路径（push/unshift/setLength/ensure）收敛为**单一助手** `as_vector_*_grow(v, cap)`：`gc_alloc(isPtr ? GCT_PTR_ARRAY : GCT_RAW, cap*sizeof(ec))` + `memcpy` 旧内容 + `v->data = nd` + `gc_write_barrier((void*)nd)`（§6.5.1「写入新鲜 GC 块的指针必须显式重新置灰」；引用元素再逐元素补屏障）。
2. **缓冲复用（消除每帧多 MB 抖动）**：`VertexBuffer3D`/`IndexBuffer3D` 的 `uploadFromByteArray` 改为**按绝对顶点/索引下标就地写**（`o->data`/`o->rawBits` 不够长才 `setLength`），生成 C 的读取路径与 `Context3D_submit` 一致按 `startVertex`/`startIndex` 定位；`IndexBuffer3D_uploadFromVector` 同时改为**拷贝**（AS3 语义是拷贝，别名会让后续就地上传改掉调用者的 Vector）。`uploadFromVector` 仍以 `rawBits == NULL` 作为「负载是别名」的标记。
3. `Context3D_submit` 的索引上传长度 `numIndices - startIndex` → `numIndices`（与绝对下标一致，`startIndex == 0` 时等价）。
4. **附带修一个既存崩溃（非本泄漏引入）**：`gc_in_heap` 原来只判 `p >= base`，而三个调用方都要读 `p - sizeof(gc_header)` 处的头字段；落在**段首**的栈字（保守栈扫描会持段基址）会让该读取落到段前未映射页 → **`SIGBUS`**。改为要求头自身落在段内（首个对象体正在 `base + sizeof(gc_header)`，不会误拒合法对象）。

**验收**
- 泄漏本身：`mem.py "btn:9,at:160:60"` → 271 MB → **1219 MB / 4 s 后逐秒完全持平**（修前 14298 MB，即 14.3 GB → 1.22 GB）；连做 **6 轮**「Start benchmark」→ 1651.3 MB 后 **0.00 MB/s**（无逐轮递增，仅 GC 堆高水位）；`leaks` 由 **2478 例 / 407 MB** 降至 **399 例 / 68 KB**（余下与 Vector 无关）。
- 渲染正确性：中途截图（7456 objects）确认蛋形/贴图/深度排序正常；结算页（`Result: 6959 objects with 120 fps`）与开场页均正常。
- 崩溃修：`examples/stage57.as` 修前 `-O2` 必现 `SIGBUS`（`EXC_BAD_ACCESS (code=2)` 于 `gc_is_object` 读 `h->type`，`-O0` 恰好不现），修后 exit=0。
- 无回归：`node test.ts` **101 passed / 0 failed**；`demo_all2.py` 12 场景进入均成功且零崩溃。版本号 v0.3.119 → v0.3.120。

**遗留（本轮新发现，未修）**：`Context3D_submit` 每帧每流仍用 `malloc`/`free` 造一份 `nv*comp*8` 的临时缓冲（批次大时每帧约 8 MB 瞬时分配），虽立即释放不构成泄漏，但会被分配器留作高水位——与「1.3 GB 常驻工作集」的成因相关，待后续与字节缓冲一起迁移/复用。

---

#### 阶段八十九·二十五：AOT 对 ADL 基准复核（「AOT 比 ADL 慢」的根因：GC 调度 + 分配器尺寸类）（v0.3.121）✅ 已完成

**依据**：用户在上阶段（v0.3.120，`Vector` 负载迁 GC）之后反馈三点：① 内存仍 ~1.4 GB（ADL ~400 MB）；② 性能反而退步，Benchmark 只到 4~6k objects（ADL 8600）；③ 质问「为什么 AOT 比 ADL 还慢」。

**免手对比 harness（本阶段新建，解决「合成点击传不到 ADL」的阻塞）**：给 demo 打了 `bench-auto` 标志文件 +
`BENCH` stderr 探针（`examples/air-starling-demo/src/Game.as` 检测 `File.applicationDirectory/bench-auto` 存在即
直接进 `scenes.BenchmarkScene`；`BenchmarkScene.as` 在 `_debug` 下每 30 帧打印
`BENCH obj/fps/mem/free/rss/phase/fail`）。**同一份 `Demo.swf` 在 ADL 与 AOT 下都能免手自跑**，互相对照。

**根因（三条，全部实测，非推测）**
1. **GC 增量预算按对象数固定 500/帧 → 大堆上「永远走不完一轮」**。Starling Benchmark 8000 对象时 GC 活集约 15 万节点，
   固定切片需要数百帧才走完 MARK+SWEEP，而期间每帧产生 2~4 MB 垃圾。实测堆膨胀到
   `total=917MB ｜ raw=881.8MB/889`（889 个未回收的 `GCT_RAW` 负载）→ 收集器不得不做的那一段工作把帧率
   120 → 75，基准爬坡提前中止（**这一条同时解释了用户的内存与性能两个反馈**）。旁证：`gc_big`（≥4 MB 单次分配）
   0 行 → 不是单次大分配、而是「每帧多次中等分配」的风暴。
2. **`setLength`/`ensure` 在 `capacity == 0` 时走倍增阶梯**：`4,8,…,2MB` 每级都分配+拷贝后立即作废，一次调用浪费
   ~2× 全尺寸。探针命名了调用点：`as_vector_number_setLength ← VertexBuffer3D_uploadFromByteArray ←
   starling_rendering_VertexData_createVertexBuffer`（`oldcap=0 len=0`，即每帧新建的 Vector）。
3. **分配器单链首适 + 无尺寸类 → 多 MB 负载被小对象蚕食切碎**：`resv=1127MB segs=1031 freeblk=40693
   freeb=1060MB`（1 GB 空闲却不可用），下一个多 MB 请求找不到够大的块就开新段 → 每帧新段 = RSS 高水位。

**修法**
1. `gc_step` 的切片与阈值随堆自适应：`budget = min(count/16 + 500, 8000)`、`threshold = max(1 MiB, inuse/8)`；
   两个旋钮可被 `ASC_GC_BUDGET`/`ASC_GC_THRESHOLD` 绝对覆盖。切片必须**封顶**——不封顶时切片随堆线性增长，
   实测帧率从 120 一路滑到 47 fps（停顿失控）。
2. `as_vector_*_setLength`/`_ensure`：`capacity == 0` 时直接按需分配一次，不再走倍增阶梯。
3. 空闲链按尺寸类拆为 `gc_free`（<256 KiB）/ `gc_free_big`（≥256 KiB）；小请求新段用 `GC_SMALL_SEG_SIZE`（64 KiB）；
   新段先切到请求尺寸再重试（否则小请求永远跳过新段 → 无限递归）；`as_vector_*_grow` 对 ≥256 KiB 的容量上取整到 2 的幂，
   让帧间尺寸漂移的重复请求落回同一尺寸类从而复用。
4. 诊断能力（env 门控，便于后续复测）：`ASC_GC_STATS` 打印每类型在用字节/对象数 + `total/resv/segs/freeblk/freeb`
   + 大分配与返回地址（`dladdr` 命名调用者）；`ASC_S3D_STATS` 打印逐绘制 CPU/GPU/等待与帧率。

**验收（同一 SWF、同一 harness，ADL 与 AOT 各自免手自跑）**
- **峰值 objects @120fps：AOT 30144（phase 0→1 切换点 30138）vs ADL 8624（8616）→ 3.5×**。
- 内存按对象归一：AOT `mem` 200 MB / 30144 obj = 6.7 KB/obj，ADL 108 MB / 8624 obj = 12.8 KB/obj（约 2× 更省）。
  RSS：AOT 13k 对象 ≈ 450 MB、30k 对象 ≈ 668 MB；对照修前「8.5k 对象即 1.4 GB」。
- 可重复性：40 s 窗口三轮 13024/12944/13024（RSS 449~454 MB）；长窗口 29888/30144；其它档位 14816/16000。
- 无回归：`node test.ts` **101 passed / 0 failed**（含 `gc_barrier`/`gc_strings`/`stage57` 三个 GC 示例；
  其中 `gc_barrier` 曾被「单链跳过异类块」的写法拖成 O(n²) 超时，改两条分类链后恢复）；`demo_all2.py`
  12 场景进入均成功、零崩溃（Textures 首击被吞是 harness 首击伪影，重试后正常渲染）。版本号 v0.3.120 → v0.3.121。

**遗留（本轮新发现，未修）**
- **预留段永不归还 OS** → 已在阶段八十九·二十六修掉（空段释放 + 分配器让步）。
- **`VertexBuffer3D` 双份 double 负载** → 已在阶段八十九·二十六修掉（合并为单份 `Vector.<uint>` 32 位字）。
- 上阶段遗留：`Context3D_submit` 每帧每流的临时 `malloc`/`free`。

---

#### 阶段八十九·二十六：用户报「预留段不归还 OS / VertexBuffer3D 双份负载 / 基准动画一卡一卡」（v0.3.121 → v0.3.122）✅ 已完成

**依据**：用户本轮三项——三项均出自阶段八十九·二十五的遗留清单：(1) 预留段永不归还 OS（活集 205 MB vs RSS 668 MB）；
(2) `VertexBuffer3D` 的 `rawBits` + `data` 双份 double 负载；(3) 基准虽能跑到 2~3 万对象，但动画「一卡一卡」。
另附「整体 CPU 占用高于 adl」的复核要求。

**诊断（先量后修，两个根因都不是错觉）**
1. `sample` 抓主线程：`gc_scan` 占 **32.7%**，其唯一热点是 `gc_in_heap()`——**对 ~1144 个段做线性扫描**，
   而它被内联进 `gc_scan`（每个子指针/栈字/写屏障都要调一次）。这就是「帧率 30~60、单帧 20 ms」的真根因，
   与 GC 预算/切片完全无关。
2. 负载分布：`raw=391 MB / 169` 个缓冲 = 活集字节数的 **96%**，都是同一个 double 负载的两种表示（浮点值 + 它的位模式）。

**修法**
- **`gc_in_heap` O(log n)**：新增按段基址排序的 `gc_seg_range`（+1 项缓存），二分查找 + 段表地址范围检查；
  增/删段时同步维护（`realloc` 会移动数组，故 `gc_seg_range_add` 无条件失效缓存）。
- **空段归还（`gc_release_empty_segs`）**：`gc_seg` 加 `free_bytes`（在用字节计数）+ `reap` 标记；
  限速 `GC_RELEASE_MS = 500`，在两条空闲链上单遍摘除「全空」段的**所有**空闲块（含合并块），
  再从 `gc_segs`/`gc_seg_range` 摘除并 `free`。调用点 = `gc_finish_cycle` **与** `gc_step` 的 `GC_IDLE` 分支
  （后者保证「停止分配后」不再有新轮时 RSS 也会跟着活集回落；只放轮末则不分配就永不释放）。
- **分配器让步（`gc_trim_os`）**：`free()` 只把页还给 `malloc`，macOS 的 zone 会把它们留着不还 OS
  （`heap` 实测：真正在用 167 MB 落在 388 MB 预留 zone 里，其中 263 MB 是 “empty” 且常驻）。
  故显式调 `malloc_zone_pressure_relief(NULL, 0)`（`#ifdef __APPLE__`）。
- **`VertexBuffer3D` 单份 32 位负载**：字段从 `data`+`rawBits`（两份 `double`）合并为一份 `Vector.<uint> raw`
  （保留 `numVertices`/`data32PerVertex`/`startVertex`）；`uploadFromVector` 窄化 double→float32 字；
  `uploadFromByteArray` 在 `as_ba_little() == as_host_little()` 时**整块 `memcpy`**（否则逐字换序）；
  `submit` 直接读字（bytes4 = 字本身，floatN 由 float32 宽化）。
- **`ByteArray` 逐元素端序开销**：`as_ba_little` 改指针键 2 槽缓存（字符串不可变 ⇒ 指针判定恒正确）；
  `as_ba_put/get_u32` 加宿主序快路径（一次 32 位存取替代 4 次移位字节存取）。
  `strcmp` 曾占主线程 **26.6%**（`VertexData.copyTo` 逐元素调 `readFloat`/`writeFloat`），现已降到 20.9%。
- **诊断旋钮 `ASC_FRAME_STATS=1`**：每 512 帧打印帧时 `p50/p95/p99/max`、GC 占比、
  `rss`/`heaptotal`/`inuse`/段数/空闲字节，用于分辨「卡顿是 GC 还是场景本身」
  （尾部分位的 `max` 长帧里 `worstgc` 为 0，即那些 1.5×vsync 的长帧与 GC 无关，而是场景自身 CPU 随对象数增长）。

**验收（同一 SWF、同一 harness；ADL 与 AOT 各自免手自跑）**
- **到达 8000 对象的代价（同一 `ps -o rss` 口径）**：AOT **7.2 s / CPU 1.63 s（占空比 23%）/ RSS 286 MB**；
  ADL **13.7 s / CPU 5.86 s（43%）/ RSS 380 MB** → 1.9× 更快、**3.6× 更少 CPU**、1.3× 更少 RSS。
  （「AOT CPU 高于 ADL」至此反转；ADL 在 8.6k 对象时已 380 MB，AOT 到 33k 对象仍是 ~520 MB。）
- **峰值 objects：AOT 33600~38416（本轮 4 次运行）vs ADL 8496 → 4.0~4.5×**；`mem`：AOT 79~89 MB @33~38k vs ADL 107 MB @8.2k。
- **卡顿**：`p50 = 8.32 ms`（锁住 120 fps，修前 30~60 fps）；`p95 ≤ 10.6 ms`、`p99 12~19 ms`；
  `gcshare` 0.7~2.1%（修前 30%）、`gcmax ≤ 8.5 ms`（修前 20 ms+）、`over17ms` 0~17/512 帧；
  段释放生效后 `heaptotal` 414→61 MB、段数 1109→489、空闲字节 359→9 MB。
- 无回归：`node test.ts` **102 passed / 0 failed**（新增 `reg-bytearray-endian.as`：
  两种端序的字节序列 / 回读 / 中途换序 / 手写字节反读）；`demo_all2.py` 12 场景进入均成功、零崩溃；
  `cycle.py 11 12`（Sprite 3D 进出 12 轮）全程存活。版本号 v0.3.121 → v0.3.122。

**遗留（本轮新发现，未修）**
- **Masks 场景被 `mask` 的对象未被裁剪 → 无法返回**（阶段八十九·二十二已记录「Masks 只见背景、Back 既检测不到也点不响应」，
  本轮补上**对照与根因假说**）：我们的渲染里 `_contents`（`flight_00` 贴图）**整片绘制**，盖住并吞掉
  `Scene` 基类放在它下方的 Back 按钮（`demo_all2.py` 记 `STUCK`、`cycle.py` 记「no Back button」）；
  adl 参考里同一场景 Back 按钮与 `_maskDisplay`（alpha 0.1 圆）都在，且 `_contents` 只画在掩码圆内
  ——故推测是 stencil `pushMask/popMask` 未裁剪被遮对象（进而遮住并吞掉按钮的点击）。
  **与本次改动无关**（与阶段八十九·二十一 的 `temp/hidpi/mask1_s0_btn10.png` **逐像素一致**，diff = 0.0，
  只是当时的验收只比对了舞台平均亮度与裁剪后的飞鸟）。下一步：查 Starling `Canvas`
  （`beginFill`/`drawCircle`）与 stencil Painter 在此场景的边界条件（同时排除“掩码圆未绘制”与“未裁剪”两种可能）。
- **场景进出每轮 +3.7 MB**（Sprite 3D 连做 12 轮：164 → 206 MB，线性不收敛）：与阶段八十九·二十二 实测的
  「+4 MB/s / 25 轮 155→600 MB」一致，属 arena 侧未迁 GC 的既有遗留（见下表「字节缓冲 arena 泄漏」），
  本轮只做了旁证、未扩大范围。
- **RSS 组成的诚实边界**（33k 对象：`Physical footprint` ~505 MB）：我们的 GC 段 ~60 MB + arena ~40 MB
  （`mem` 83 MB 之内）+ 未托管（skia/Metal/Starling C++ 静态）~70 MB + malloc zone 碎片/empty ~130 MB
  + 共享框架常驻页。即「活集 44 MB」之外的多数并非本运行时的堆，单纯再压 GC 侧收益有限。
- **wasm 目标本轮未复跑**（本机无 WASI SDK，同阶段八十九·二十三）：本轮新增代码要么与平台无关
  （`gc_seg.free_bytes`/`gc_release_empty_segs`/`gc_seg_range` 二分），要么在 `#ifdef __APPLE__` 内
  （`gc_trim_os`/`malloc/malloc.h`），故不影响 wasm 编译，但**待有工具链时补验**。

---

#### 阶段八十九·二十七：用户报「第二次运行 benchmark 会崩溃」（v0.3.122 → v0.3.123）✅ 已完成

**依据**：用户报 Starling demo「第二次跑 benchmark 就崩」——归档含一次崩溃报告
（`BatchProcessor_addMesh + 360`，`EXC_BAD_ACCESS`，坏地址 `0x3fef9782a0000150`，运行约 97 s）。

**诊断（先复现，再顺坏值找根因）**
1. 免手复现 harness `temp/hidpi/bench2.py`（`bench-auto` 标志文件 + 反复点 Start）：
   每轮 ramp 约 45~55 s，第 3~5 轮 `rc=-11`。复现崩溃报告
   （`Starling-Demo-2025-09-25-211057.ips`）：`scenes_BenchmarkScene_onEnterFrame + 1572`，
   反汇编为 `ldr x12, [x10, #0x10]`，`x10` 取自全局 `0x1013b15c0` = **`gc_all`**（`nm` 确认），
   即**对象链表头被写成了一个 double**。
2. 两次崩溃的坏值同基址：`0x3fef9782a0000000` = double `0.9872449040412903` —— 在二进制里**无此字面量**，
   是 benchmark 里 `_container.scale`（`scale *= 0.99` / `/= 0.9993720513` 累乘）算出来的值：
   因此不是「随机垃圾」，而是**某个 double 落进了指针位**。
3. 新增 `ASC_GC_AUDIT` 对账（每次段归还前用活对象链重算各段实际占用）
   → 抓到决定性证据：`RELEASING segment … with 328 LIVE bytes (free_bytes=65536 size=65536)`
   （段内还有活对象，却因 `free_bytes == size` 被判定「空」而 `free` 还给 OS）。

**根因（`docs/zh-cn/gc.md` §6.12）**：分配器从空闲链取块时，余量 < `GC_MIN_BLOCK` 则不切分、
块**保持原尺寸**，但计费按**请求尺寸**扣除 → 该段 `free_bytes` 永久偏大（每次 ≤31 B 累积）。
偏差碰到「恰好等于段内活对象占用」时，`free_bytes == size` 成立 → **段（含活对象）被释放** →
malloc 立刻复用（实测给 arena/`ByteArray.data`）→ 段内所有指针变垃圾：`gc_all` 写成 double、
MeshStyle 的 vtable 字写成 double，于是 `addMesh`/BENCH 探针在任意位置 SIGSEGV。「第二次才崩」
也解释得通：第一次被释放的块内容尚未被覆写。

**修法**
- **计费搬到切分之后、按块的实际尺寸**（`gc_alloc`）：`free_bytes -= sizeof(gc_header) + h->size`，
  使 `free_bytes` 严格等于「空闲链上各块 (header + size) 之和」，`free_bytes == size` 重新等价于「段真空」。
- **`ASC_GC_AUDIT` 诊断（保留）**：`DRIFT`（计数器不精确）/ `GHOST`（`gc_all` 挂着已释放块）/
  `RELEASING … with N LIVE bytes` / `gc_audit_gate`（`gc_all`、空闲链节点、清扫游标必须是段内真块，
  附 4 层调用链）；报告预算按类别分开（否则 DRIFT 会挤掉决定性的 RELEASING，首次诊断即因此跑偏）。
  删除**地址区间历史类**判据（「指针落在曾释放的段区间」）：malloc 会立即复用刚释放的段地址，
  arena/`ByteArray.data` 正在其中，实测 32 条全部是假阳性。
- **`ASC_GC_AUDIT_STRICT=1`**：首个违例直接 `abort()`，使普通 `examples/*.as` 可断言堆不变式
  （`test.ts` 用它跑回归示例）。
- `gc_seg_range_del` 无条件清查找缓存（`memmove` 令缓存指针指向**别的**段）；保留 `ASC_GC_RELEASE` 旋钮。

**验收**
- 回归 `examples/gc_seg_reap.as`（分配 payload p 的字符串 → 丢弃 → `System.gc()` → 以 p-4 取回，
  余量 4 B < 32 B → 未切分；另有 8 个活字符串 canary）：**修前必现**
  `free_bytes DRIFT … free_bytes=65552 size=65536 delta=16` + `abort()`（rc=134）；修后 `gc-reap-ok`。
- `bench2.py 480`（benchmark 连跑 **10 轮**）无崩溃、`gc-audit` **0 行输出**
  （修前同一 harness 第 3~5 轮 `rc=-11`、8 行 DRIFT、多行 RELEASING）；
  连跑期间 `obj` 峰值 39536 / `fps` ~120 / `rss` 逐渐回落。
- 健康程序审计静默：`gc_midframe`/`stage89`/`stage92` 在 `ASC_GC_AUDIT=1` 下零输出。
- 无回归：`node test.ts` **103 passed / 0 failed**。版本号 v0.3.122 → v0.3.123。

**遗留**：本阶段只保证「段只在真正空时释放」；`free_bytes` 仍是「增量计数 + 审计对账」，
而非每次归还都全量重算（全量版是 `O(活对象)`，仅审计模式开启）。其它遗留见下表。

---

#### 阶段八十九·二十八：用户报「进 TextFields 后其他场景按钮字体变大」+ HTML 富文本对 ADL 复核（v0.3.123 → v0.3.124）✅ 已完成

**依据**：用户报「进入 `textfields` 场景后，其他所有测试例子的按钮字体都变大」，并追问「textfields 与 ADL 是否有差异、是否影响了文本」。按惯例先跑 AIR `adl` 参考截图，再跑 AOT 产物截图逐像素对比，最终定位到**两处独立的 AS3 语义缺陷**（均为既有遗留，非本轮引入）。

**根因 1：`.text` 赋值不清除 `htmlText`/`setTextFormat` 的 run（→ 按钮字体变大）**

- **复现**（`temp/hidpi/fontleak2.py`，序列：场景 A → Back → TextFields → Back → 场景 A）：Textures 场景「返回后 vs 进入前」**逐像素 mean 0.234**，且只有**一个**差异簇 `x 282..363, y 974..1002` —— 正是 Back 按钮标签。
- **量化**（`temp/hidpi/measure_back.py`，按按钮高度归一，与分辨率无关）：AIR `adl` 参考 glyph **54×16**（glyph_h/button_h = 0.291）；AOT 进 TextFields **前** 55×17（0.293，与 AIR 一致）；**后** 82×27（0.466，≈1.5×）。
- **定位过程**：`starling.text.TrueTypeCompositor.renderText` 复用**静态共享**的 `sNativeTextField`（`flash.text.TextField`）+ `sNativeFormat` + `sHelperQuad` 量字。逐级诊断（`[RT]` `toNativeFormat` 之后、`[RT2]` `set_scale` 之后、`[P]` `as_tf_paragraph` 缓存命中/重建）证明：**所有输入完全相同**（`fmt_size=12 snf_size=24 dtf_size=24 para_size=24 bdscale=scale=2.0`），只有排版输出不同（`para_h 29→38`、`para_mw 57.6→84.5`），且 `_para` **每帧重建**（缓存键的数值字段全等）。重建日志给出决定性证据：`hasRuns=0 runs_n=-1`（进 TextFields 前）→ `hasRuns=1 runs_n=27`（之后，27 = 9 个 run × 3 槽）。
- **根因**：`flash.text.TextField.text` 被建模为**裸字段**（`src/symbols.ts`），`sNativeTextField.text = text` 发射为结构体直接写入，**不清 `_runs`**；而 `as_tf_html_set` 每次赋值都会先清 `_runs`。于是 TextScene 的 HTML 字段（4 个 `<font color=…>` run + 默认 run）把 run **永久留在共享字段上**，其后**任何**纯文本排版都走 `sk_textlayout_new_runs` 重放这些 run（含缩放后 `size=24` 的字号语义），于是字体变大；run 的**颜色**一并覆盖，TextScene 自身第一个纯文本字段也被污染成「黑字 + 彩色碎片」。
- **修法**：`text` 保留在 `fields`（读仍是 `tf->text`，`props`/反射偏移表不变）**并同时注册 setter** —— 新增 `TextField_set_text`（`as_skia_textlayout_delete(_para)` + 清 `_runs`/`_para_text` + 写字段 + `gc_write_barrier`）。赋值一律**替换整段内容**（含「把同一字符串对象再赋一次」——AIR 语义即如此，故不做指针相等短路）。`TextField_set_htmlText`/`get_htmlText` 保持原样。

**根因 2：HTML 属性值单引号解析错位（→ TextFields 场景颜色与 AIR 不符）**

- **对比 AIR**：TextScene 第三个字段 `"... or centered. … and <font color='#208080'>support</font> <font color='#993333'>basic</font> <font color='#333399'>HTML</font> <font color='#208020'>formatting</font>."`（**单引号**）在 AIR 下 `support` 青、`basic` 红、`HTML` 蓝、`formatting` 绿；AOT 下 `basic` 显绿、`HTML` 显青、`formatting` 显蓝。
- **定位**（打印实际 run 列表 `[R]`）：`run1 [63,70) color=#002080`（应为 `#208080`）、`run3 color=#009933`（应 `#993333`）、`run5 color=#003333`（应 `#333399`）——十六进制**只读到 4 位**。根因：属性解析只跳过 `"`（`if (*s == '"') s++`），单引号值 `'#208080'` 于是**从引号本身**开始 `as_tf_html_parse_hex`（`'`/`#` 记 0，再读 4 位即满 6 字符）→ `0x002080`。同因：`face='X'` 会把**引号带进字体名**（Skia 回落默认字体）；`size='30'` 经 `atof` 得 0 后落到 `1.0` 下限。
- **修法**：新增 `as_tf_html_attr_value(s, out, cap)`，按**开引号种类**定界（单引号 / 双引号 / 无引号三种皆可），`color=`/`size=`/`face=` 三处改用它；「跳过未识别属性」的前进逻辑同步跳过两种引号（原实现只跳 `"`，单引号会原地死循环的隐患一并闭合）。

**TextFields 与 ADL 的差异清单（第三问的回答）**

1. **run 颜色 ✅ 已对齐**：复测 `basic`=#993333（红）、`HTML`=#333399（蓝）、`formatting`=#208020（绿）、`support`=#208080（青），与 AIR 逐词一致。
2. **断点仍差一个词（已知限制，入遗留表）**：第三字段第一行 AOT 收在 `are`、AIR 收在 `fonts`。但**逐词墨迹宽度与词间距完全相同**（AOT/AIR 均为 25/32/154/178/81 px、词间 15/12/17/14 px）——差异只在**断行阈值口径**：AIR 判候选行宽含**行尾空格**（591+13=604 > 其可用宽度）故换行，SkParagraph 不计尾部空格（591 ≤ 600）故不换。
3. **其余一致**：三个边框字段、`… e.g.`（左上）/`… or bottom right …`（右下）、位图字体 `Desyrel` 段落与 AIR 一致；整屏 mean diff 17.2 主要来自字形抗锯齿（Skia vs Flash 光栅器）与标题栏文案（`Starling-Demo` vs `Starling Demo`）。

**验收**

- `temp/hidpi/fontleak2.py --a 0`：Textures 场景「进 TextFields 前 / 后」**mean diff 0.000、差异簇 0 个**（修前 0.234 / 1 簇）。
- `temp/hidpi/fontleak.py`：12 个菜单按钮标签宽高 **before/after 逐项相等**（修前同类标签 54×16 → 82×27）。
- `temp/hidpi/measure_back.py`：三个场景（Textures 前/后 + TextFields 自身）Back 标签全部 **55×17 / 0.293**，对齐 AIR `adl_textures_ref.png` 的 54×16 / 0.291。
- `temp/hidpi/cmp_scenes.py fl7/scene_2.png adl_textfields_ref.png` + 逐词取色：见上「差异清单」。
- 新增断言（`examples/textrich.as`）：`.text` 丢弃 `htmlText`/`setTextFormat` 的 run（含同一字符串再赋值）+ 单/双引号属性等义；**还原 pre-fix 必 FAIL**（在 **Skia 构建**下实测，分别报 `` `.text` must drop htmlText runs: leaked run laid out as 66.69x30, plain reference is 26.68x12 `` 与 `single-quoted <font> attributes must lay out like double-quoted ones, got 6.5x12 vs 21x30`）。**覆盖面说明**：这两条断言只有在链接 Skia（`--manifest examples/skia-link.build.example.json`）时才可能失败——纯 C 下 `textWidth`/`textHeight` 走 `size × 1.2` 桩、run 与颜色都不参与排版（故 `test.ts` 的纯 C 回归抓不到它们，`temp/hidpi/fontleak2.py` 是 Skia 层的守门人）。
- `examples/textrich.as` 在**纯 C 与 Skia 两种构建**下均 PASS；`node test.ts` **103 passed / 0 failed**。
- 生成 C 里的临时诊断（`[RT]`/`[RT2]`/`[P]`/`[R]`/`[CMP]`）已随重生成清除（`grep` 校验为 0）；demo 源码未改动。版本号 v0.3.123 → v0.3.124。

---

#### 阶段八十九·二十九：web 目标帧节拍缺陷（120 Hz 屏上只跑 66 fps）+ WebGPU 可行性判定（v0.3.124 → v0.3.125）✅ 已完成

**依据**：用户要求「开始兼容编译到 web html」，按 `compile.md` 复现 `air-native` 的 web 构建，并提出历史遗留疑问：「当时存在问题，fps 无法达到 120。看看走 webgpu 会解决这个问题吗」。

**结论先说**：**WebGPU 解决不了，也不需要**。FPS<120 有两个真实原因，均与光栅化后端无关——(a) 窗口所在**显示器刷新率**；(b) web 帧驱动里一个**真实的帧节拍（frame pacer）量化缺陷**，在 120 Hz 屏上把 120 砍到 66。(b) 已修复。当前 wasm 版 Skia **根本没编 Graphite/WebGPU**（`build-tools/skia-src/out/wasm/args.gn`：`skia_use_webgpu=false`、`skia_enable_graphite=false`、`skia_use_dawn=false`，只有 `skia_use_webgl=true`），走 WebGPU 需为 wasm32 拉 Dawn + 重编 Graphite，换不来可测收益。

**复现构建**（文档原样，13 s 出包）：`EMSDK_HOME=<repo>/build-tools/emsdk node src/index.ts --air-app examples/air-native/air-native-app.xml --target wasm --package web` → `.html`+`.js`+`.wasm`（6.8 MB）。

**关键前置事实（本轮测量平台）**：本机两块屏刷新率不同——内置 Liquid Retina XDR（主显示器，**120 Hz**）与外接 MateView（**50 Hz**）。**Chrome 的 rAF 跟随窗口所在面板的刷新率**，新窗口默认落在 MateView（实测 `window.screenY=-1655`）→ rAF 只有 50 Hz，此时任何后端都到不了 120。故测量前先用 CDP `Browser.setWindowBounds` 把窗口钉到主显示器（`temp/web-fps/cdp_move_window.mjs`）。这与阶段六十一/六十二在 **native** 侧得出的同一结论（「跨屏自动适配」「frameRate 封顶到刷新率」）一致，只是 web 帧驱动不同（rAF 驱动 vs SDL 自走时），需**不同的实现**——rAF 回调里不能 sleep。

**测量方法**：页面上读不到 fps（数字画在 canvas 里）。新增**编译期**诊断旋钮 `-D ASC_FRAME_STATS=1`（native 同名旋钮是运行时 `getenv`，浏览器无 env，故 web 侧用 define；默认不编译进产物），每秒把 `frames`/`loopcalls`/`skips`/`renderMs`/`rafPeriodMs`/`skip` 发到 `window.__ascFrameStats`。`loopcalls` 与 `frames` 之差把三种可能一眼分开：`loopcalls≈frames` → rAF 本身慢（刷新率上限）；`skips 大、frames≪loopcalls` → 节拍缺陷；`renderMs/frames` 逼近 `rafPeriodMs` → 真·渲染瓶颈。配套脚本 `temp/web-fps/fps_probe.mjs`（钉窗口 + 采样 + 输出各列）、纯 JS 的 rAF 上限探针 `temp/web-fps/rafprobe.html`。

**测量结果**（完整表与命令见 `temp/web-fps/EVIDENCE.md`）：

| 配置 | rAF 回调/秒 | 呈现 fps | 丢弃/秒 | ms/帧 | 占帧预算 |
|---|---|---|---|---|---|
| **修前** pacer · GPU · frameRate 120 · 120 Hz 屏 | 120 | **66** | **54.5** | 0.191 | 2.3% |
| 修后 · GPU · frameRate 120 · 120 Hz 屏 | 120 | **120** | 0 | 0.113 | **1.35%** |
| 修后 · GPU · frameRate 60 · 120 Hz 屏 | 120 | **60** | 60 | 0.210 | 2.5% |
| 修后 · **CPU** 光栅 · frameRate 120 · 120 Hz 屏 | 120 | 120 | 0 | **6.658** | **80.2%** |
| 修后 · GPU · frameRate 120 · **50 Hz** 屏 | 50 | **50** | 0 | — | — |

- 修前那行就是用户报的 bug：rAF 明明给了 120 次/秒，pacer 只呈现 66 帧、每秒丢弃 54.5 次回调，而单帧渲染只有 0.19 ms——**不是渲染慢，是节拍错**。
- 修后 120 fps、0 丢弃、单帧 0.113 ms = 帧预算 **1.35%**（余量 ~74×），demo 自己的角落读数显示 **`FPS:120`**（`temp/web-fps/shipped_web_demo.png`）。
- CPU 光栅那行才是「GPU 话题」的真实数据：`putImageData`（逐像素回 JS）6.66 ms/帧 = **80% 预算**，刚好守住 120 但无余量；GPU（Ganesh/WebGL2）只有 0.11 ms/帧。**所以「GPU 光栅」是必要的——但那是已有的 WebGL2/Ganesh 后端，与 WebGPU 无关。**
- 50 Hz 屏那行说明软件层无法越过面板刷新率（rAF 只给 50）。

**根因**：`vendor/web_glue.cc` 的 `main_loop` 原用**时间戳截止期**节拍（`if (interval > 0.0 && now < next_tick) return;` + `next_tick = now + interval;`）。rAF 时间戳在真实 vsync 附近抖动——本机 120 Hz 面板实测 p50 8.30 ms / p95 9.30 ms（周期 8.333 ms）。只要某次回调早到几百微秒，判定失败 → **丢掉这一 tick**，而下一次回调在一个完整 vsync 之后（早已过点）→ 呈现；于是丢/取交替、**速率减半**（120→66）。与 native 阶段四十七/六十一那类「固定 delay 把渲染时间叠加上去」同属节拍缺陷族，但触发机制不同（这次是 rAF 时间戳抖动导致整 tick 丢帧）。

**修法**（`vendor/web_glue.cc`）：**按整 tick 节拍**。一次 rAF 回调 = 一个 vsync，合成器只认 tick。

1. **实测刷新周期**：`raf_period_ms()` = 连续 rAF 回调间隔的**中位数**（16 槽环）。取中位数而非均值/EMA，是为了让一次长回调（GC 停顿、首帧字体光栅、切标签页、拖窗口）无法带偏估计——均值会被拽走一秒以上，整段时间选错除数。样本按 1~100 ms 合理性过滤（挡住切标签页的秒级停顿）。`sk_window_get_display_refresh()` 在 web 仍返回 0：浏览器没有 `SDL_GetDisplayMode` 对应物，且 AS3 侧那套「时间戳截止期」节拍根本无法表达「每 N 个 vsync」——那是合成器唯一认的节拍，所以测量收敛在 glue 层内部。
2. **整 tick 节拍**：`skip = (int)(interval / rp + 0.5); if (skip < 1) skip = 1;`（`interval = 1000/frameRate`）。帧间隔恒为面板刷新周期的整数倍；面板给不出的速率（如 60 Hz 屏上要 24 fps，需 2.5 个 vsync）取最近的可行除数，请求永不远于半个 vsync。目标高于刷新率时 `skip=1`（每个 vsync 都画）——与 native 后端行为一致（`emit.ts` 的 `ASC_window_on_frame_delay` 对 `fr > rr` 也是封顶到刷新率）。
3. **诊断旋钮**：`ASC_FRAME_STATS` 编译期 define（见上），默认编译为空。

**验收**

- **A/B 对照（还原 pre-fix 必 FAIL）**：把 pacer 临时换回时间戳版（保留 `ASC_FRAME_STATS`）重建，`fps_probe.mjs` 报 **`fps_delivered: 66` / `pacer_skips_per_s: 54.5` / `raf_callbacks_per_s: 120`**（rAF 给 120 却只呈现 66）；恢复整 tick 版重建后报 **`fps_delivered: 120` / `pacer_skips_per_s: 0`**。
- **`skip>1` 路径**：`Main.as` 临时改 `frameRate = 60` → `tick_divisor: 2`、`fps_delivered: 60`、`pacer_skips_per_s: 60`（验证后 demo 源码已还原，`git status` 无 `Main.as`）。
- **背靠背现象学复核**：50 Hz 屏上 `raf_callbacks_per_s: 50` / `fps_delivered: 50` / `skips: 0`（确认上限来自面板而非代码）。
- **产物干净**：出厂构建（不带 `-D ASC_FRAME_STATS`）的 `air-native.js` 中 `__ascFrameStats` 出现 **0 次**；页面加载后 `typeof window.__ascFrameStatsAll === 'undefined'`，而 canvas 正常渲染 2000×1360（`dpr=2`）、`document.title = "Native AS3 Demo"`。
- 无回归：`node test.ts` **103 passed / 0 failed**。demo 源码、`air-native-app.xml`、`air-native.build.json` 均为原状（`git status` 只有预期内的 `air-native.js` 重建）。版本号 v0.3.124 → v0.3.125。
- **口径定案（不升版本号）**：「跟随 vsync、帧率量化到刷新率整数分之一」与 native 阶段六十一/六十二 一脉相承，是**设计决策**而非待开发项——它与 AIR `adl` 的「`frameRate` 是逻辑帧率、FPS 读数不随显示器刷新率降低」口径**天然不同**，差异与理由已并入 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §3 决策分歧点（**维持现状**），不再在 `### 遗留待开发` 表中占位。

---

#### 阶段八十九·三十：web 目标 Stage3D（WebGL2）后端 —— `air-starling-demo` 在浏览器里真正渲染（v0.3.125 → v0.3.126）✅ 已完成

**依据**：用户「我看到修复了，现在兼容 examples/air-starling-demo 编译到 web 版」——即那个 demo 必须**在浏览器里真的画出来**。
阶段八十九·二十九只解决了 web 的帧节拍（`air-native` 这类走 `Shape`/`Graphics`/`TextField` 的程序），而 Starling 的**全部**渲染都经
`Context3D`：`ASC_RENDER_STAGE3D` 未定义时 `as_s3d_*` 全是 no-op（`runtime.ts`），`Context3D_present` 贴出一张空图——页面正常打开、
控制台干净、`AssetManager` 加载到 100%，但**舞台一片空白、无任何报错**。故本阶段必须实现 web 版 Stage3D 后端。

**做法：新文件 `vendor/stage3d_webgl.cc`（约 700 行，WebGL2/GLES3），与 `stage3d_glue.mm` 暴露同一套平坦 `s3d_*` C API**

- 离屏 FBO（RGBA8 颜色 + 可选 `DEPTH24_STENCIL8` renderbuffer，对应 Metal 侧「只在需要时挂 D32S8」），延迟 clear 在下次绘制时施加；
  逐绘制混合（`glBlendFuncSeparate`）、深度/模板（`frontAndBack` 走 `glStencilFuncSeparate`/`glStencilOpSeparate`）、剔除、裁剪（y 镜像
  `glScissor(x, th-(y+h), w, h)`）、VBO/EBO 上传、渲染目标 FBO 注册表、活上下文注册表（`s3d_destroy_texture` 先解绑再删）。
- **属性槽位**：链接前逐个 `glBindAttribLocation(prog, i, "va<i>")`，使 `setVertexBufferAt(stream i)` == GL 的 attribute i，无需查询。
- **常量**：沿用既有 GLSL 发射形态，`vcN`/`fcN` 各为一个 `uniform vec4`，逐寄存器 `glUniform4fv` 上传。
- **采样器状态按纹理对象缓存**（GL 把过滤/环绕存在纹理上，Starling 每绘制都设一次，不缓存是纯开销）。
- **与 Ganesh 共享单一 WebGL2 上下文**：每个触碰 GL 的 `s3d_*` 入口调 `sk_gr_reset_context()`（`resetContext()` 只是脏位标记，很便宜），
  否则 Ganesh 会复用被我们改过的 GL 状态。
- **WebGL2 缺 `glGetTexLevelParameteriv`/`GL_TEXTURE_WIDTH`**：渲染目标纹理尺寸改由 `S3DRtTex{id,width,height}` 注册表自己记账。

**web 与 AS3/Metal 的语义差异（逐项显式处理，AGENTS.md §2.4 的要求）**

1. **Y 轴方向**：GL 渲染目标行 0 在**下**，AS3/Metal/`BitmapData` 行 0 在**上**。修法是 GLSL 顶点阶段末尾统一
   `gl_Position.y = -gl_Position.y;`——纹理采样仍保持 `v=0` = 顶部，`glReadPixels` 行序也直接与 Skia canvas 对齐；绕序随之翻转，故 GL 保留
   默认 `GL_CCW` 为正面（对应 AS3 的 `Clockwise`）。
2. **像素字节序**：AS3 的 `uint32` 像素字是 `0xAARRGGBB`（直通 alpha），GL 的 `RGBA8` 上传/读回需 BGRA↔RGBA 交换。
3. **模板/D32S8 附件尺寸**：离屏目标与窗口不同尺寸时不能共用附件（Metal 侧吃过「整个 render pass 被丢弃」的亏），按目标尺寸惰性建。

**同时修掉三个只在 GLSL 路径上暴露的既有缺陷**

1. **AGAL→GLSL 翻译器的 mark-use 漏标**：`m44/m34/m33`（0x18/0x19/0x17）只标了 src2 基址寄存器 → `vc1..vc3` 从不声明，链接着色器时报
   `ERROR: 0:8: 'vc1' : undeclared identifier`（Starling 的矩阵程序全线失败）。现按 `mrows` 逐行标 `src2+r`。
2. **GLSL ES 发射**：补 `precision highp float;`；仅当用到 `od` 时才 `#extension GL_EXT_frag_depth : enable`；顶点阶段把 `vN` 声明为文件作用域
   `varying vec4`（顶点/片元两阶段的 `varying` 声明必须一致，否则 GL 拒绝链接）。
3. **驱动标签**：`Context3D_get_driverInfo` 在 web 下补 `WebGL2 (Stage3D)`（原先只有 `Metal (Stage3D)` / `Software (state machine)`）。

**构建接入**

- `src/air-app.ts`：`usesStage3D = detectStage3D(files)` 对 **native 与 web 两个目标**都生效；web 清单额外推 `vendor/stage3d_webgl.cc` +
  `ASC_RENDER_STAGE3D=1` / `ASC_S3D_GLSL=1`，应用描述符含 `<depthAndStencil>` 时再加 `ASC_RENDER_DEPTH_STENCIL=1`。
- `src/index.ts` 的 `writeWebIndex`：把 `Module._main()` 包成 `try { ... } catch (e) { if (e !== 'unwind') throw e; }`。
  `main()` 末尾的 `emscripten_set_main_loop(..., simulateInfiniteLoop=1)` 靠**抛字符串 `'unwind'`** 展开 wasm 栈，Emscripten 自己的
  `run()` 会吞掉它，而我们的页面在 `async onRuntimeInitialized` 里直接调 `_main()`，于是每个 web 构建的控制台都会多一条假错误
  `Uncaught (in promise) unwind`（排查过程中一度被误判为「空消息 promise 拒绝」；`_emscripten_throw_longjmp` 抛的是 `Infinity`，不是同一回事）。

**上屏路径**：当前是**CPU 读回**——`Context3D_present` 在非 Metal 分支 `as_s3d_readback_render` 读回 `ASC_stage3d_pixels`（BGRA）再由
`as_skia_canvas_draw_bgra` 作为图像画进 Skia canvas（与 native 离线路径同形）。「先能跑、再快」的第一步；GPU 直连列为后续优化（见遗留表）。

**验收**

- **12 个场景逐个进入并截图**（`temp/web-demo/walk.sh` → `scenes/_sheet.png`）：Textures（3 个飞行贴图 + ATF 压缩纹理）/ Multitouch /
  TextFields / Animations / Custom hit-test / Movie Clip / Filters / Blend Modes / Render Texture / Benchmark / Masks / Sprite 3D —— 内容与各自
  AS3 源一致、互不相同（`07_filters` 与 `08_blendmodes` 的像素统计几乎相同，但**确实是两个场景**：「Switch Filter / Identity」vs「Switch Mode / normal」）。
- **与 AIR `adl` 参考一致**：主菜单按钮 device x 62..304（左列）/ 340..582（右列），内容占据 device (0,0)-(639,959)，与 `adl_flt_menu.png` 相同；
  **demo 的白色区域是它自己的舞台底色**（不是缺陷）。
- **交互**：stage 坐标 == canvas CSS 坐标 1:1（`noScale` + ox/oy=0），合成点击用 stage 坐标即可命中（Back 中心 (160,467)、菜单列 x=90/229、
  行 y=176+46k）——12 场景走查与权益按钮/Back 连点全部落到预期对象。
- **控制台**：`Display Driver: WebGL2 (Stage3D)`，零 `Uncaught`/`EXCEPTION`。
- **性能**（`-D ASC_FRAME_STATS=1` 重建 web 胶水，120 Hz 面板）：**120 fps / 0 丢弃 / 单帧 `renderMs` 2.88 ms（帧预算 34%）**；
  把读回与合成整段临时摘掉后同一场景只剩 **0.047 ms/帧**（5.7 ms / 120 帧）⇒ **CPU 读回+上传约占 98% 的帧 CPU 成本**（渲染目标 640×960 ⇒ 2.4 MB/帧）。
- **Benchmark 场景在 web 上对象数停在 0**（查明为 demo 自身逻辑，非渲染缺陷）：`src/Demo.as:40` 显式 `stage.frameRate = 120`，于是
  `_targetFps = 120`、`divisor = 30`（临时 printf 实测 `[TGT] targetFps=120 divisor=30`，**不存在 `% 0`**）；该场景只在「实测 fps ≥ 0.985×目标」
  时才加对象，web 上实测帧率抖动使其反复判失败 → 直接进 phase 1 并停在 0 对象。原生 AOT 侧同一 demo 用 `bench-auto` 能爬到 3 万对象，
  仍是同一份判据。
- **无回归**：`node test.ts` **103 passed / 0 failed**（含新增断言，见下条）；`air-native`（非 Stage3D）web 构建仍成功、页面正常
  （`document.title = "Native AS3 Demo"`、canvas 2000×1360、零异常、`typeof window.__ascFrameStats === 'undefined'` 证明探针确实编译为空）；**原生目标重编 + 实跑**：
  `Metal (Stage3D)`、零异常、菜单/贴图/按钮渲染正常（`temp/web-demo/native_menu2.png`）。
- **回归断言落在 `examples/stage80.as`（AGAL 翻译器，纯逻辑离屏，自动被 `test.ts` 收走）**：新增 GLSL 目标专属断言——
  `precision highp float;` 两阶段都在；顶点阶段有 `gl_Position.y = -gl_Position.y;`（web 后端整体依赖的 Y 翻转）；顶点阶段声明它写过的 `varying vec4 v0`、
  片元阶段声明它读的（两阶段声明必须一致，否则 GL 拒绝链接）；新增 `m44 op,va0,vc1` + `m34 op,va1,vc6` 断言 `vc1/vc3/vc4/vc8` 均被声明、
  且未触碰的 `vc5` 不被声明；新增 `mov od,ft0`（寄存器类型 6）断言映射到 `gl_FragDepth` 且**按需**出现 `#extension GL_EXT_frag_depth : enable`、
  不用 `od` 的程序不带该扩展。**反向对照**：临时还原 mark-use 修复后 `examples/stage80.as` 必 FAIL
  （`FAIL: m44 marks all 4 rows it reads (missing 'uniform vec4 vc3;')`），恢复后通过——断言确实守住该缺陷。
- **产物干净**：生成 C 里的临时诊断（`[DBG] hit` printf、`[TGT]`/`[FR]` printf、`PERF-PROBE`）与 `bench-auto` 标志文件均已撤除/重生成
  （`grep` 校验为 0，preload 列表只剩 assets / Demo.swf / Demo-app.xml / build-and-run.sh）。版本号 v0.3.125 → v0.3.126。

**遗留（本轮新发现）**：见下表新增两行（Stage3D web 的 CPU 读回上屏、整数 `%` 零除数的 UB）。

#### 阶段八十九·三十一：两条遗留收尾 —— Stage3D web 上屏 GPU 直连 + 整数 `%` 零除数守卫（v0.3.126 → v0.3.127）✅ 已完成

**依据**：阶段八十九·三十遗留表的两项——(a) web 上屏的 CPU 读回占单帧 CPU 成本 ~98%（面积线性增长，`Canvas3D`
级别将掉帧）；(b) `int % int` 在生成 C 里是裸 `%`，零除数是 UB（`-O2` 下静默出错、wasm 下按规范 trap）。

**(a) Stage3D web 上屏：CPU 读回 → GPU 直连**

- `vendor/skia_glue.cc` 新增 `sk_gl_draw_texture(canvas, textureId, w, h, dx, dy, dw, dh)`：`GrBackendTextures::MakeGL`
  （`GL_TEXTURE_2D` / `kRGBA_8888`）把渲染目标的 GL 纹理包成 `GrBackendTexture`，`SkImages::BorrowTextureFrom`
  （`kTopLeft_GrSurfaceOrigin` / `kPremul`）后 `drawImageRect` 直接画进 Skia canvas——对应 Metal 侧的
  `as_skia_mtl_draw_texture`。
- 新增 `sk_gr_set_texture_dirty_hook`：Ganesh 采样外部纹理时会**重设该纹理对象上的采样器状态**，故刷新前回调
  `s3d_sampler_cache_invalidate()` 清空 `stage3d_webgl.cc` 里按纹理对象缓存的 `texStateN`/`samplerStateSet`，
  否则下一次绘制会漏设过滤/环绕状态。
- `src/emit.ts`：`Context3D_present` 的纹理路径由 `#ifdef ASC_RENDER_METAL` 改为
  `#if defined(ASC_RENDER_METAL) || defined(ASC_RENDER_GPU)`（`ASC_stage3d_tex = as_s3d_get_render_target`），
  合成按 Metal / GL / 读回三分支；`src/runtime.ts` 的 `as_skia_gl_draw_texture` 在无 Skia 分支退化为 no-op。
- **验收（像素）**：把生成 C 临时改回读回路径重编（**同一会话、同一窗口位置**），GL 直连与读回在 `showStats`
  覆盖层 `(0,0,180,82)` **之外逐像素 0 差异**（框内 mean 3.14 即叠加的统计文字）。
- **验收（性能）**：同会话 `-D ASC_FRAME_STATS=1` 对照——`renderMs` 由 **3.21 ms/帧**（385/120 帧）降到
  **0.12~0.15 ms/帧**（14~17.5/120），**约 23 倍**；120 fps / 0 丢弃。
- **与 `adl` 对照**：主菜单 vs `temp/hidpi/adl_flt_menu.png`（dx=0, dy=64 device px）readback mean 9.28 /
  GL-direct mean 11.39（高出的部分即 `showStats` 叠加层）。
- **走查**：12 个场景全部截图且内容正确；`12_sprite3d`（3D + 深度）另以「reload 后直接点击」单独复核（`11_masks`
  的「无法返回」是既有遗留，会打断连续走查）。

**(b) 整数 `%` 的零除数守卫（先与 `adl` 对照，再改）**

先用 mxmlc + adl（AIR SDK 51.4.1，除数取**数组元素**使其对编译器不透明，结果写文件避开 adl 的 stdout 不可靠）取 AS3 精确取值：

| 表达式 | adl（AS3）实取 | C 的行为 |
|---|---|---|
| `7 % 3` | `1`，且 `(7 % 3) is int` == true（ASC 定成 int） | `1` ✅ |
| `-7 % 3` / `7 % -3` | `-1` / `1` | 同 ✅ |
| `5 % 0`（int/uint 两侧） | **NaN（是 Number）** | UB；`-O2` 折成 `5` |
| `var r:int = 5 % 0` | `0`（int 接收时 NaN 被强制为 0） | 同上 |
| `INT_MIN % -1` | `0` | 有符号溢出 UB |
| `5 / 0`、`0 / 0`、`INT_MIN / -1` | `Infinity` / `NaN` / `2147483648` | `/` 早已提升 double ✅（无需改） |

- `src/emit.ts` 的 `%`：`int % int` → `as_int_rem(a,b)`，`uint % uint` → `as_uint_rem(a,b)`（混合/Number 仍走 `fmod`，
  `fmod(x,0)` 本身就是 NaN，与 AS3 一致）。
- `src/runtime.ts` 新增两个静态助手：`b == 0` → `0`，`INT_MIN % -1` → `0`（`as_int_rem`/`as_uint_rem`，与 `as_to_int32`
  同属「AS3 有定义、C 是 UB」的转换点）。
- **诚实边界（唯一分歧）**：ASC 把 `int % int` 定成 int，故守卫后的 int/uint 结果在**所有 int/uint 使用点**都与 AS3
  一致（含零除数——AS3 自己在 int 接收时也把 NaN 化成 0）；只有「零除数 + **动态**类型使用点」（`var x:* = a % 0`）
  AS3 给 NaN、我们给 int 0。除非把每个 `i % n` 都变成 double（那 `7 % 3 is int` 反而会变 false，更不忠实），否则
  无法把 NaN 放进表达式的静态 C 类型。已在 `src/runtime.ts` 注释与 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §2/§3 写明。
- **反向对照（native）**：把生成 C 的 `as_int_rem` 还原成 `return a % b;` 后 `cc -O2` 重编，`examples/int-rem-zero.as`
  必 FAIL（`FAIL: 5 % 0 is 0 (got 5)`）——证明 `-O2` 确实把运行期为零的除数折成了被除数本身（既非 trap 也非 AS3 值）。
- **反向对照（wasm）**：同一还原用 `clang --target=wasm32-wasip1 -O2` 编出 `.wasm`，wasmtime 跑必然
  **`wasm trap: integer divide by zero`（exit 134）**——证明该守卫确实消掉的是规范级 trap，而非仅理论 UB。
- 回归示例 `examples/int-rem-zero.as`（断言式，被 `test.ts` 自动收走）：零除数 int/uint、`INT_MIN % -1`、`INT_MIN / -1`、
  `5/0 = Infinity`、`0/0 = NaN`、`Number % 0 = NaN`、非零除数的 `-7%3=-1`/`7%-3=1`、`words[i % words.length]`、
  `for` 循环 `%` 求和、动态除数（数组元素）等；除数是**数组元素**（不透明）以免被 `-O2` 折叠掉。

**(c) 顺带修复：`--target wasm` 此前根本编译不过（与 (a)(b) 无关的既有缺陷）**

- `examples/hello.as` 同样失败，两处都只服务 `ASC_GC_STATS`/`ASC_GC_AUDIT_STRICT` **诊断**（不参与程序可见行为）：
  `#include <dlfcn.h>` + `Dl_info`/`dladdr` 是 POSIX/Apple 专有（wasi-libc 有头文件但无该 API → 6 个 error）；
  `__builtin_return_address` 在非 Emscripten wasm 上是**硬错误**（LLVM：`Non-Emscripten WebAssembly hasn't implemented
  __builtin_return_address`）。修法：按 `__wasi__` 条件编译——符号探测退化为裸地址/`"?"`，返回地址宏
  `ASC_RETURN_ADDRESS(n)` 退化为 `NULL`（`__EMSCRIPTEN__` 与 native 路径逐字不变）。修复后 `int-rem-zero.as`
  与 `hello.as` 的 WASI 产物均编译并以 wasmtime 跑通。

**验收**：`node test.ts` **104 passed / 0 failed**（含新增 `int-rem-zero.as`）；WASI 双目标跑通（wasmtime）；native
Starling demo 重编并实跑（`Metal (Stage3D)`、资源加载到 `onLoadComplete`、10 s 零异常）；web 重编后菜单与 3 个静态场景与
守卫前**逐像素一致**（同窗口位置下 0 差异，同会话两次走查的噪声底也是 0）。版本号 v0.3.126 → v0.3.127。

**harness 备注**：canvas 的 CSS 位置若落在**半像素**（如 x=272.5）上，合成器会把 canvas 重采样进截图，使同一份代码的
两次走查出现 ~9~13 mean 的「伪差异」；`temp/web-demo/walk.sh` 已改为从页面读 canvas 矩形，走查时保持窗口位置为整数即可
（本轮据此排除了「`%` 守卫影响渲染」的假象）。

#### 阶段八十九·三十二：AGAL 全掩码比较指令（`sge`/`slt`/`seq`/`sne`）翻译错位修复 —— Starling「Switch Filter」崩溃（v0.3.127 → v0.3.128）✅ 已完成

**症状**：web（GLSL 目标）下 `air-starling-demo` 的 Filters 场景点「Switch Filter」，切到 **Drop Shadow / Glow**
（二者都继承 `CompositeFilter`）时页面控制台刷出片元编译失败、画面停在上一个滤镜：

```
stage3d_webgl: GLSL(fragment) compile failed: ERROR: 0:13: ')' : syntax error
  ... ft5 = mix(vec4(0.0), vec4(1.0), v0(greaterThanEqual(v0, vec4)));
```

**根因**（`src/runtime.ts` 的 AGAL→着色器翻译器，全掩码比较分支）：四个 opcode 用**一个** `sprintf` 配**三元格式串**写成
（`target == 0` 为 MSL、否则 GLSL）：

```c
sprintf(rhs, target == 0 ? "select(%s(0.0), %s(1.0), %s >= %s)"
                         : "mix(%s(0.0), %s(1.0), %s(greaterThanEqual(%s, %s)))",
        v4, v4, s1, s2, v4, v4, v4, s1, s2);   /* 9 个实参，喂给两支不同的格式串 */
```

两支的 `%s` 个数**不同**（MSL 4 个、GLSL 5 个），而 varargs 是**同一份固定列表**：GLSL 分支按
`v4, v4, s1, s2, v4` 取值——第 3 个操作数位被喂进 `s1`、第 5 位（`v4`）被当成 `s2`，于是生成
`s1(greaterThanEqual(s2, vec4))`（`vec4` 是唯一的**裸标识符**，正是 `')' : syntax error` 的报错点）。
MSL 分支恰好只用前 4 个实参，所以一直是对的——这就是为什么 native（Metal）从未出错、只有 web 崩。
**clang 其实一直在报** `warning: data argument not used by format string [-Wformat-extra-args]`（每次构建 4 条），
只是被 372 条 warning 淹没（修复后归零）。

**修复**：四个 opcode 各拆成 `if (target == 0) sprintf(MSL…) else sprintf(GLSL…)` 两个独立调用，实参列表分别写全
（MSL `v4, v4, s1, s2`；GLSL `v4, v4, v4, s1, s2`），并在原处注释写明「为什么不能写成三元格式串」。
GLSL 侧的规范依据（也在注释里）：`mix(vec4, vec4, vec4)` 是 GLSL ES 1.00 §8.3 的合法重载，`vec4(bvec4)`
（逐分量 bool→float）由 ES 1.00 §5.4.2 明文允许（"If the basic type of a parameter to a constructor does not
match … the scalar construction rules are used to convert"，例子即 `vec4(ivec4)`）；而 `mix()` 的 `bvecN` 重载**只有
ES 3.00 才有**——我们的 GLSL 不带 `#version`（按 ES 1.00 编译，本轮浏览器实测确认：缺省模式 + `attribute`/`varying`
+ `texture2D` 能链上、`vec4(bvec4)` 通过、`mix(vec4,vec4,bvec4)` 失败）。

**回归**：`examples/stage80.as` 新增 `makeCompareFragment(opcode, s2type, s2num, dmask)`（含 `sge ft5, v0, v0`
这一 `CompositeFilter` 原句），断言**两个目标**的完整表达式：GLSL 侧
`ft5 = mix(vec4(0.0), vec4(1.0), vec4(greaterThanEqual(v0, v0)));`、MSL 侧
`ft5 = select(float4(0.0), float4(1.0), in.v0 >= in.v0);`（`slt`/`seq`/`sne` 用 `v0`,`v1` 区分操作数顺序，
另加部分掩码 `sge ft5.x` 的分量三元路径）。**反向对照**：把四个 `sprintf` 临时还原成三元形态后
`node src/index.ts examples/stage80.as --run` 必 FAIL（报缺 `ft5 = mix(vec4(0.0), vec4(1.0), vec4(greaterThanEqual(v0, v0)));`）
——证明该回归真能抓住这个 bug，而非「碰巧通过」。

**验收**：

- `node test.ts` **104 passed / 0 failed**；web 产物重编后与验证时**逐字节一致**（md5 两文件同）。
- **web 实跑**（浏览器 CDP 驱动 `temp/web-demo/cdp.mjs`）：菜单 → Filters → 连点 4 次「Switch Filter」= Blur →
  **Drop Shadow** → Glow → Displacement Map 全部渲染，控制台**零** `GLSL compile failed`、零异常（修复前第 2 次点击即报错）。
- **像素对照**：Drop Shadow 状态下 **web vs native** 逐像素 mean **1.59**（差 >16 的像素 0.92%，全在边缘/文字/AA）；
  两者各自与 **adl**（`temp/hidpi/adl_{id,blur,drop,glow}.png`，内容原点 (0,64) device px、舞台 640×960 device px）对照
  分别为 **5.82 / 5.52**——即「本站两后端互差 ≪ 它们与 adl 的共有 AA/文字差」，说明 GLSL 的
  `mix(…, vec4(greaterThanEqual(…)))` 与 MSL 的 `select(…)` 输出一致，且与 AS3 参考一致（四个滤镜状态各自都比过）。
- **native 回归**：重编（Metal/MSL）并驱动到 Filters 连点 3 次（Blur / Drop Shadow / Glow），进程存活、
  日志无 MSL/metal 报错，Drop Shadow 与 web 侧视觉一致。

**影响面（不止这一个滤镜）**：另两个用到比较指令的 program 在 web 侧此前**同样编不过**——
`MultiTextureStyle.as`（`slt ft4, v2.xxxx, fc0`）与 `Effect.as`（顶点 `sge v0, va0, va0`）；前者在本 demo 里没有
实例化、后者的程序未被该场景走到，所以只有 `CompositeFilter` 暴露出来。四个 opcode 现已全部可用。

**harness 备注**：`temp/web-demo/rebuild_web.sh` 复用 `vendor/*.o`，而 `src/build.ts` 的 `objOf` 按源文件名派生
（`vendor/skia_glue.cc → vendor/skia_glue.o`）**不区分 target**：跑过一次 native 构建后这些 .o 就是 native 对象，
再跑该脚本会 `wasm-ld: error: unknown file type`（本轮实测）。本轮改走 `--air-app … --target wasm --package web`
的完整构建（重编全部对象）绕过；**已在阶段八十九·三十三根治**（`objOf` 按 target 加后缀 = web 侧 `.wasm.o`，两套对象共存）。

#### 阶段八十九·三十三：小项收尾包（`%=` / target 化中间产物 / `any` 点写入崩溃）（v0.3.128 → v0.3.129）✅ 已完成

三项互相独立，都取自遗留表里被判定「可立即落地」的小项；第三项是本轮审计时**新发现**的崩溃（严重度最高）。

**（1）`%=` 复合赋值**——词法/语法/发射各一行：`lexer.ts` 的 `MULTI_SYMBOLS` 加 `%=`、`parser.ts` 的
`ASSIGN_OPS` 加 `%=`、`emit.ts` 的 `COMPOUND_BASE` 加 `'%=': '%'`。此后 `a %= b` 自动复用既有 `%` 路径
（int/uint 走守卫后的 `as_int_rem`/`as_uint_rem`，Number 走 `fmod`），**零除数与 `% 0` 同值**（`int % 0 = 0`）。
`examples/compound.as` 新增 10 组断言：int/uint/Number、getter-setter、静态字段、数组元素、动态 record 槽，
以及 `%= 0`（实测与 `5 % 0` 同为 `0`，不触发 UB；负数取余与 `%` 一致截断向零）。修复前 `a %= b` 是
`Parse error at 1:20: unexpected token '='`（响亮失败）。

**（2）native 与 web 中间产物同名**——`objOf` 改为按 `cfg.target` 派生后缀：native 仍 `<name>.o`，
web/wasm 为 `<name>.wasm.o`（`buildWebCompileSteps` 用 `cfg.target === 'wasm' ? '.wasm.o' : '.o'`）。
两个 `--dry` 实测：native 侧对象全 `.o`、web 侧全 `.wasm.o`（含生成的 `Starling-Demo.wasm.o`）。
**验收次序**：native 完整构建（写 `.o`）→ web 完整构建（写 `.wasm.o`，`vendor/*.o` 未被覆盖、两套对象时间戳并存）
→ 紧接着跑 `temp/hidpi/rebuild.sh`（复用 native `.o` 做增量链接）**成功**（修复前此序必失败）。
**反向对照**：把 `skia_glue.wasm.o` 冒充 `skia_glue.o` 再跑同一脚本 → `ld: unknown file type in '…/vendor/skia_glue.o'`
+ `clang++: error: linker command failed with exit code 1`，正是该 wart 的真实症状。`temp/web-demo/rebuild_web.sh`
同步改用 `.wasm.o` 并按 mtime 增量重编 glue 对象（不再依赖「上一轮 target 留下的对象」）；构建清单侧所有
`objects` 均为 `[]`，无需改。顺手清掉两枚按新命名已过时的 web 对象（`vendor/web_glue.o`、`vendor/stage3d_webgl.o`）。

**（3）`any` 接收者的点写入崩溃**——`d.prop = v`（`d` 为 `*`）此前发射
`as_object_set(((as_object*)as_v_obj_val(d)), …)`，即**把接收者强行当成匿名 record**。实测两条崩坏路径：
① 密封类实例 `var d:* = new Sealed(); d.unknown = 5;` → **SIGSEGV（exit 139）**；
② `var d:* = [1,2,3]; d.bar = 8;` → 静默写坏元素缓冲（其后 `d.length` 读出 `880804016` 垃圾值）。
读取路径 `as_any_get` 与下标写入 `d["k"] = v`（`as_any_set`）本来就按运行时 box tag 分派，唯独点写入遗漏，
故改为 `as_any_set`（tag 4 → `as_dyn_set`：先沿 vtable 反射表查字段、再查 setter，最后退到 record 槽；
tag 6 → 数组下标写；其余 tag → no-op）。新增断言示例 `examples/any-dot-write.as`（6 组：经 `*` 写已知字段
须落到真实字段且静态类型可见、复合写入 `d.x += 8`、密封类未知属性写后实例不崩不坏、record 槽新增与复合、
数组 `length` 与其它元素不被写坏）。
**反向对照**：用旧 cast 的 `emit.ts` 副本构建同一示例 → SIGSEGV（exit 139）；修复版 → 全部断言通过。

**剩余语义缺口（保留在遗留表，本轮不修）**：密封类未知属性写入现为**静默 no-op**，未抛 AS3 的
`Error #1056`（本轮只消掉崩溃与内存写坏）；另 `*` 承接数组时**非数字键被 `strtol` 当作索引 0**——
AS3 的 `Array` 是动态对象，`d.bar` 应存成命名属性，故 `da.bar = 8` 会写 `arr[0]` 而不是新增属性。

**回归**：`node test.ts` **105 passed / 0 failed**（含新增 `examples/any-dot-write.as`，上一版为 104）；native 与 web 两端完整构建均成功，
web 产物在浏览器中实跑（`Context ready`、`onLoadProgress = 1`、Filters 场景正常渲染）。

#### 阶段八十九·三十四：语义保真两连 —— 动态 `+`（`as_add_v`）与顶层整树 `var` 提升（v0.3.129 → v0.3.130）✅ 已完成

两项都取自遗留表，都是「AS3 语义 vs 本子集实现」的直接对齐，各自带断言回归。

**（1）动态 `+` 走运行时判定（`as_add_v`）**——修复 `var a:Array=["x","y"]; a[0]+a[1]` 得 `0`（应为 `"xy"`）。
根因：`emitBinary` 的 `+` 只分两支——静态任一侧是 `String` 走 `as_str_concat`，否则「任一侧是 `any`」直接
`as_v_to_number(a) + as_v_to_number(b)`，于是**运行时**是字符串的动态值被当数字。现新增运行时助手
`as_add_v(as_value, as_value)`（ES3 ToPrimitive：任一侧运行时是 String —— 或对象，其默认 hint 经 toString 也得 String
—— 即拼接；否则数值相加），`emitBinary` 在有 `any` 参与时改为调用它并把结果类型定为 `any`（两个操作数都装箱）。
同一处顺带修掉 `null + 1`：此前发射 `(NULL + 1)` → **C 编译失败**，现按 AS3 得 `1`（null 走数值分支为 0；静态 String
侧仍走既有 `as_str_concat` + `"null"`）。逐项实测（修复前 → 修复后）：

| 表达式 | 修复前 | 修复后 | AS3 |
|---|---|---|---|
| `var a:Array=["x","y"]; a[0]+a[1]` | `0` | `xy` | `xy` |
| `var n:Array=[1,2]; n[0]+n[1]` | `3` | `3` | `3` |
| `var d:*="x"; d + 1` | `1` | `x1` | `x1` |
| `var e:*=5; e + 1` | `6` | `6` | `6` |
| `null + 1` | 编译失败 `(NULL + 1)` | `1` | `1` |
| `"v=" + null` | `v=null` | `v=null` | `v=null` |

新增断言示例 `examples/any-add.as`（10 组：两侧 any 的字符串/数字、any+静态数字两种运行时形态、静态 String 在左的
既有路径、`null` 参与、`+=` 复合复用同一路径）。`examples/closure_const.as` 第 4 组把当年为绕开本缺口而写的
「两侧各带一个字面量串」改回自然写法 `words[0] + words[1]`（断言随之为 `"keepme"`）。
**已知简化（保留）**：对象/数组箱在字符串侧经 `as_v_str_val` 渲染（`"object"`/`"[Array]"`），即**判定**与 AS3
ToPrimitive 一致、**文本**仍是本子集的显示形式（`[Array] + 1` 得 `[Array]1`，AS3 得 `1,21`）。

**（2）顶层整树的 `var` 提升**——修复顶层 `for (var i…` 后在块外引用 `i` 得
`undefined variable 'i' at top level`。根因：模块作用域只扫**顶层声明位**的 `var`/`const`，块内 / `for` init 里的
声明只在块内可见（闭包侧则以值快照存在）。现按 AS3「脚本只有唯一作用域」把整个顶层语句树提升：
新增 `collectScriptDecls()`（深度优先、源码序、同名一次；**不下钻**嵌套函数/类），它同时成为 `emitModuleVars`
（声明 C 全局）与闭包遍历 `scriptVarNames`（自由变量若是模块全局则直接读写、不按值捕获）的**唯一来源**——
此前两处各写一份扫描，注释明确要求「必须保持一致」，现在结构上不可能漂移。发射侧在 `emitVarDecl` 与
`ConstDecl`/`ConstDecls` 增加「顶层（`functionScope === null`）且是模块全局 → 只赋值、不再声明 C 局部」分支，
故 `for (var i:int=0; …)` 的 C 初始化直接写成 `for (g_i = 0; …)`，循环后 `trace(i)` 读的就是同一个 `g_i`。实测：

| 形态 | 修复前 | 修复后 |
|---|---|---|
| 顶层 `for (var i:int…) {}` 后 `trace(i)` | `undefined variable 'i' at top level` | `3`（循环后仍可写：`i = 10` → `10`） |
| 顶层 `if (true) { var b:int = 7; }` 后 `trace(b)` | 同上报错 | `7` |
| 三个闭包捕获同一顶层循环变量后调用 | 值快照（0/1/2 各不同） | `3 3 3`（共享同一槽，AS3 语义） |
| 顶层 `for (var k:String in obj) {}` 后 `trace(k)` | 报错 | **仍报错**（for-in/for-each 循环变量的类型取决于可迭代对象、发射期才定，故与函数作用域同一约定：留块内局部，见遗留表） |

`examples/stage15.as`（模块级作用域示例）新增 6 组断言覆盖上述形态。

**回归**：`node test.ts` **106 passed / 0 failed**（新增 `examples/any-add.as`；`examples/Flappy-Starling` 为
本轮期间用户新克隆进 `examples/` 的第三方 Starling 游戏，首道拦路是「命名函数表达式」语法缺失 —— 与本轮改动无关，
已按第三方只读参考 demo 的既有约定加入 `test.ts` 的 `SKIP_DIRS` 并在遗留表立项，见该行）。

#### 阶段八十九·三十五：WASI 异常机制修复（setjmp/longjmp 链接打通）（v0.3.130 → v0.3.131）✅ 已完成

把遗留表最后一条「工具链级」缺口收掉：**wasm 目标下带 `try/catch` 的程序从「链接必失败」变成「编译+running 与 native 语义一致」**。
这也是 GC-3 WASI 验收上那条 ⚠️ 限定（「只能在异常机制被 `-O2` 消去的示例上复现」）解除的前提。

**根因（三段，全部实测确认）**：

1. 生成 C 的 `throw/try/catch` 走 `setjmp`/`longjmp`；`-mllvm -wasm-enable-sjlj` 让 LLVM 把它们降到
   `__wasm_setjmp`/`__wasm_longjmp`/`__wasm_setjmp_test` 内建（`longjmp` = 抛一个 tag，`setjmp` 所在帧 `catch` 回来、
   恢复保存的帧）。但 wasi-libc 把这三个符号放在**单独的** `libsetjmp.a`（sysroot 里确实存在），`libc.a` 不含——
   我们只加了 `-mllvm -wasm-enable-sjlj` 却从未链它，于是 `wasm-ld: undefined symbol __wasm_setjmp`。
2. 光补 `-lsetjmp` 仍跑不起来：该 SJLJ 降级**默认发射旧版 EH 指令（`try`）**，wasmtime 默认特性下直接拒编
   （`legacy_exceptions feature required for try instruction`），而旧版 EH 浏览器**从未实现**（现行标准是 `try_table`）。
3. `__c_longjmp` 由 libc.a 提供，不是缺口；补上前两者即整链闭合。

**修法（`src/build.ts`）**：wasm 目标的编译命令追加两个 `-mllvm` 开关并在**目标文件之后**追加 `-lsetjmp`：

- `-mllvm -wasm-use-legacy-eh=false` —— 改用标准 EH 提案（`try_table`）：wasmtime ≥ 24 默认即支持，浏览器 Chrome 119+/Edge 119+/Firefox/Safari 18.4+ 支持。
- `-lsetjmp` —— 提供 `__wasm_setjmp`/`__wasm_longjmp`/`__wasm_setjmp_test`。位置放在 `linkLibs` 之后是有意的：静态库必须排在引用它的目标文件之后，否则 `wasm-ld` 解析不到。
- 两者由新增的 `wasiSetjmpLib()` 探测（`$WASI_SDK_HOME/share/wasi-sysroot/lib/wasm32-wasip1/libsetjmp.a` 是否存在）门控；缺库（旧 sysroot / 非 SDK clang）时不追加，保持历史行为，真需要异常时仍**响亮失败**而不是静默降级。

**验收（可复现）**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts temp/trywasi.as --target wasm --run` | 修复前 `wasm-ld: error: undefined symbol: __wasm_setjmp/__wasm_longjmp/__c_longjmp/__wasm_setjmp_test` → 修复后 `caught x` / `try-wasi OK`（wasmtime 48） |
| 中间对照：只加 `-lsetjmp`、不加新 EH 开关 | 能链接，但 wasmtime 报 `legacy_exceptions feature required for try instruction`（证明两个开关缺一不可） |
| `temp/wasi-eh/check.sh`（跨目标验收脚本，本轮新增） | 9 个含 `try/catch` 的示例（`regexp`/`stage7`/`stage9`/`stage10`/`stage60`/`stage61`/`stage77`/`stage80`/`stage86`）+ GC 三例（`gc_strings`/`gc_incremental`/`gc_barrier`）：**全部 wasm 构建成功，输出与 native 逐字节相同**；仅 `gc_incremental` 的原始堆计数目标相关（断言 `bounded= true reclaimed= true` 一致） |
| 无异常程序零回归 | `examples/hello.as` 加 `-lsetjmp` 前后 `.wasm` **代码段逐字节相同**（差异只在 `name` 自定义段里的产物文件名），大小同为 216423 B |
| native 全量回归 | `node test.ts` 106 passed / 0 failed |
| web 目标（Emscripten） | 无需改构建：单独用 emcc 编 `temp/trywasi.c` 成单文件页面，在 Chrome 里实测输出 `caught x`/`try-wasi OK`（Emscripten 走 JS 侧 unwinding，不经 wasm EH） |

**说明**：`--target wasm` 的产物现在声明并使用标准异常处理提案，运行时需支持它（wasmtime ≥ 24 / 上述浏览器版本）；
不支持旧版 EH 的运行时（如 wasm3）依然跑不了带异常的程序，这一点在 `docs/zh-cn/compile.md` §2 已写明。

#### 阶段八十九·三十六：密封/动态属性语义对齐 AIR —— `Error #1056`/`#1069` + 数组命名属性 + `dynamic class` 建模（v0.3.131 → v0.3.132）✅ 已完成

把遗留表里的「密封类未知属性写入的 `Error #1056`（连带 `*` 承接数组的命名属性）」「命名函数表达式」「全可选参数构造器的 NULL factory」三条一并收掉（后两条见本节末）。核心是把**属性创建**这一族语义按 AIR 真实行为对齐，而不再静默吞掉。

**参考事实（AIR 51.4.1，`mxmlc` + `adl` 实测，`temp/refcheck/`）**：

| 接收者 | 写未知属性 | 读缺失属性 |
|---|---|---|
| 密封类实例（`Sealed` / `Sprite` / `Shape` / `TextField` / `EventDispatcher` / `Matrix` / `ByteArray` / `URLLoader` / `Rectangle`） | `ReferenceError: Error #1056: Cannot create property <key> on <fqn>.` | `ReferenceError: Error #1069: Property <key> not found on <fqn> and there is no default value.` |
| 动态接收者（`Object` / `Array` / `Dictionary` / `MovieClip` / `URLVariables` / `XML`） | 成功，`obj.<key>` 读回该值 | `undefined`（不抛） |

- FQN 用**点号**：用户类 `mypkg.Sealed`，内建类 `flash.geom.Rectangle`。
- 数组：`a.bar = 8` 后 `a.bar == 8`、`a.length == 3`、`a[0]` 不变；`a["1"]` 是元素，`a["01"]`/`a["-1"]`/`a["abc"]` **不是**。
- **`Sprite` 是密封的，`MovieClip` 是动态的**（显示类里唯一一个；`DisplayObjectContainer` 在 AIR 里不可实例化）。

**根因（三处，全部实测确认）**：

1. `as_dyn_get`/`as_dyn_set` 走到「查不到字段/getter/setter」时**直接返回**——密封类上写未知属性是静默 no-op、读缺失属性是静默 `null`（阶段八十九·三十三 只消掉了此前的 SIGSEGV 与数组元素缓冲写坏，语义缺口本身保留）。
2. 本子集的 `as_array` **没有属性表**：`*` 承接数组时非数字键落到 `as_any_get`/`as_any_set` 的 `strtol(key)` → `strtol("bar") == 0`，于是 `da.bar = 8` 写的是 `arr[0]`；同类问题也在**静态类型** `Array` 上（此前是「cannot access property on non-object type」的**响亮**编译错误）。
3. 解析器把 `dynamic` 类修饰符**消费后丢弃**（源码注释「dynamic is a runtime trait we do not model」），而 `symbols.ts` 里只有 `URLVariables` 一处 `isDynamic: true`——即 README 里「动态类（`dynamic class`）」的承诺**名不副实**，用户写 `dynamic class D` 后 `d.foo = 1` 是编译错误；且 `isDynamic` 不沿继承链传递（`class Sub extends Dyn` 仍被当密封类）。

**修法**：

| 文件 | 改动 |
|---|---|
| `src/runtime.ts` | 新增 `as_throw_sealed_set`/`as_throw_sealed_get`（由 emit 侧生成，preamble 里先给原型），`as_dyn_set`/`as_dyn_get` 的非动态类兜底改为调用它们（带 `hv->fqn`）；`as_array` 增 `struct as_object_s* props` 命名属性表（惰性分配）+ `as_array_index_key`（**规范**十进制索引判定：无前导零、全数字、不超 `INT_MAX`）+ `as_array_prop_get`/`as_array_prop_set`；`as_any_get`/`as_any_set` 的 tag 6 分支改用它们；GC 的 `GCT_ARRAY` 标记 `props`，写点补 `gc_write_barrier` |
| `src/emit.ts` | 新增 `emitSealedPropErrors()`（发射 `as_fqn_dotted`（`::`→`.`，静态缓冲）+ 两个抛错函数，`ReferenceError_new(msg, 1056/1069)`）；静态类型 `Array` 的**读/写**未知属性改走 `as_array_prop_get`/`as_array_prop_set`（`length` 除外，其 resize 语义未建模、仍响亮报错）；`as_dyn_new` 补**原型**（此前定义在 `emitClassRegistry`，晚于 `emitFunctionValues` 里的闭包体，Starling 规模下 `-Wimplicit-function-declaration` 直接编不过）；`MovieClip_ctor` 增 `_dyn` 分配 |
| `src/symbols.ts` | `MovieClip` 标 `isDynamic: true`（AIR 实测）；pass 1 记录 `stmt.isDynamic`，新增 pass 1.6 **沿 super 链向不动点传播**动态性（AS3 的 `dynamic` 是继承的，这条也覆盖「用户类继承 `MovieClip`」） |
| `src/ast.ts` / `src/parser.ts` | `ClassDecl` 增 `isDynamic`；两处类修饰符循环记录 `dynamic`（原为消费后丢弃） |
| `src/emit.ts` | 用户类构造函数体首部按 `info.isDynamic` 发射 `o->_dyn = as_object_new()`（放在 body 最前，因 AS3 允许在 `super()` 之前给 `this` 设属性） |

**验收（可复现）**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/dyn-prop.as --run` | `dyn-prop: all assertions passed`（33 条断言：`#1056`/`#1069` 的 message 内容含错误号+属性名+类名；数组命名属性不动 `length`/元素；`"01"`/`"-1"` 非索引；`Sprite` 密封 / `MovieClip` 动态；用户 `dynamic class` 及其子类、`MovieClip` 的子类均为动态类） |
| **反向对照 1**（把 `as_dyn_set` 的兜底改回 no-op） | 必 FAIL：`Uncaught exception: FAIL: sealed write must throw` |
| **反向对照 2**（把 `as_array_prop_set` 改回 `as_array_set(strtol(key))`） | 必 FAIL：`Uncaught exception: FAIL: named property value, got null` |
| `node test.ts` | 109 passed / 0 failed（`examples/any-dot-write.as` 的两条断言按新语义改写：旧断言写的是 `arr[0] == 8`「非数字键映射到索引 0（documented divergence）」，现改为 `arr[0] == 1` + `da.bar == 8`） |
| **Starling 端到端**（最大真实代码面） | `node src/index.ts --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo -o temp/starling-native` → 119 个 `.as` 编译+链接成功（23 MB）；`temp/hidpi/demo_drive.py` 逐场景点入 12 个菜单按钮：**11 个场景成功进入、进程全程存活、日志 0 条异常**（`grep -icE "uncaught\|exception\|error #" == 0`）；截图确认 Metal (Stage3D) 菜单正常渲染 |
| Flappy-Starling 编译链推进 | `--air-app examples/Flappy-Starling/flappy-app.xml --main-class FlappyStarlingMobile`：缺口①（命名函数表达式）与③（NULL factory）已消，当时只停在缺口②`undefined variable 'SharedObject' in class Game` → **阶段八十九·四十 已补 `SharedObject`，该 demo 现可端到端构建并运行** |

**同批收尾的两条遗留（原表内条目，结论并入本节）**：

- **命名函数表达式**（`var f:Function = function onComplete():void {…}`）：`ast.ts` 的 `FunctionExpr` 增 `name`，`parser.ts` 接受可选标识符；`emit.ts` 把名字绑定为**函数体内的自引用**（闭包槽 `as_fn_make(currentFuncCName__call, env, arity)`，支持递归），且**不外泄**（`walkSelfName` 让名字只在自身帧可见；外层引用它仍报 `undefined variable`）。见 `examples/named-fn-expr.as`（6 组断言，含递归与不外泄）。
- **全可选参数构造器的 NULL factory**：`emitClassRegistry` 原用 `params.length === 0` 判「可无参构造」，于是**参数全带默认值**的类（Starling `TextFormat`/`TextOptions`/`MeshStyle`）注册了 `NULL` factory，`new (Object(x).constructor as Class)()` 直接 `PC=0x0` SIGSEGV。改为按**必需参数个数**（`defaultValue === null && !isRest`）判定，并为这类类发射 `Foo_new_default()` 包装（`new Class()` 与 `new Foo()` 语义一致）；必需参数非 0 的类仍注册 `NULL`，动态 `new` 经新增的 `as_dyn_new` 抛 `ArgumentError #1063` 而非空指针。见 `examples/class-reflect-new.as`。

**剩余差异（记入遗留表/README 限制）**：错误消息里的类名对**内建类**用短名（`Rectangle`）而非 AIR 的完整 FQN（`flash.geom.Rectangle`，本子集的 `fqn` 字段对内建就是短名）；`for-in` 未枚举数组的命名键；`a.length = n` 未建模（仍响亮报错）；缺失属性的默认值统一为 `null`（AIR 对动态对象给 `undefined`）——为本子集既有口径，本次未改。

#### 阶段八十九·三十七：顶层 `for-in`/`for-each` 循环变量的脚本作用域（v0.3.132 → v0.3.133）✅ 已完成

收掉遗留表里「顶层 `for-in`/`for-each` 循环变量的模块作用域」——它是阶段八十九·三十四**主动保留**的未完成子项（当时把顶层语句树里的 `var`/`const` 一律提升到脚本作用域，唯独放过循环变量）。

**根因**：AS3 的 `var` 是**函数/脚本级**作用域，`for (var k:String in obj) {}` 之后 `k` 仍可见；本子集把顶层循环变量当块内局部，循环后引用报 `Error: undefined variable 'k' at top level`。当时之所以不一起提升，是因为**循环变量的 C 类型不在源码里**：`for-in` 迭代 `Array` 得 `int` 下标、迭代动态对象得 `char*` 键、迭代 `Dictionary` 得装箱键；`for-each` 得元素/值类型（源码标注优先）。类型要到发射期由可迭代对象推出，而模块级 C 全局必须在 `main` 之前声明——「声明在前、定型在后」是这条被留下的真实原因。

**AIR 参考事实（`temp/refcheck/LoopScope.as` + `adl` 实测）**：`k=b`（`for-in` 的变量存活；注意 AIR 的遍历顺序**不是**插入序，本例给 `b` 而非 `c`）、`idx=2`（`Array` 的 `for-in` 下标）、`s=q`（`Vector.<String>` 的 `for-each` 元素）——**三者在循环后全部可读**，证明语义要求变量存活；也正因为顺序不同，验收只断言「是其中一个键」而不断言具体键。

**修法（`src/emit.ts`，两处 + 一个共享规则）**：

| 位置 | 改动 |
|---|---|
| `collectScriptDecls` | `ForIn`/`ForEachIn` 在**声明了 `var`** 时也 `push` 一条 decl；`ScriptDecl` 增可选 `loop: { kind:'in'\|'each'; iterable: Expr; declared: ASType\|null }`（类型此时未知，故带上迭代表达式让下游推） |
| `emitModuleVars` | 对带 `loop` 的 decl，用 `loopVarType(kind, emitExpr(iterable).type, declared)` 定型后声明 C 全局（`static <ctype> g_k = <default>;`）——它本来就会为无类型 `var` 调 `emitExpr` 推初值类型，故此时 `moduleScope` 里前置声明已就绪，同一机制可直接复用 |
| `loopVarType`（新，唯一规则） | `for-in`：`Array`→`int`、`Dictionary`→装箱、其余（record / 动态 `Object`）→`char*`；`for-each`：源码标注优先，否则 `Vector.<T>`→元素类型、`XMLList`→`xml`、其余→装箱。**发射点与模块声明的定型必须同源**，否则全局与循环内会写出两种 C 类型（这与 `scriptVarNames` 必须与 `emitModuleVars` 一致是同一条纪律） |
| `ForIn`/`ForEachIn` 发射 | 新增 `isModuleLoopVar(name)`（`functionScope === null && moduleScope.has(name)`）判定：命中时**不**再 `declareVar`，循环体内改写 hoisted 全局 `g_x = <值>;`（循环后随即读到同一槽）；函数体内仍走原路径（本子集函数级提升惯例不变） |

**验收（可复现）**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/stage15.as --run`（新增第 7 组共 8 条断言） | `stage15: module scope OK`：`for-in` 变量循环后存活且可写（同一槽）、`Array` 下标变量为 `int` 且存活、`Vector` 元素变量保持元素类型并存活、动态对象 `for-each` 变量为装箱值、**函数体内循环变量仍在循环内可用**（块内局部约定未变） |
| **反向对照**（把 `collectScriptDecls` 的 `ForIn`/`ForEachIn` 分支改回「只走 body、不 push」） | 必 FAIL：`Error: undefined variable 'fk' at top level`（与修复前症状逐字相同） |
| `node test.ts` | 109 passed / 0 failed |
| **Starling 端到端**（最大真实代码面） | 119 个 `.as` 编译+链接成功（23 MB）；`temp/hidpi/demo_drive.py` 逐场景点入：**11/12 场景进入、进程存活、日志 0 条异常**（`grep -icE "uncaught\|exception\|error #" == 0`）——本改动触及所有 `for-in`/`for-each` 发射点，故用 Starling 规模回归兜底 |

**注**：`for each (var v:* in <any 值>)` 仍是**既有**缺口（报 `for-each-in requires an Array, Vector, Dictionary, Object or XMLList`），与本次改动无关、未纳入范围（静态类型 `Array`/`Object`/`Vector`/`Dictionary` 均已支持）。

#### 阶段八十九·三十八：表达式「只求值一次」+ 真值语义（引用 / NaN）（v0.3.133 → v0.3.134）✅ 已完成

收掉遗留表里的「重复求值审计（阶段八十九·十九记录，约 15 处 `${...code}` 重复插值未逐处排查）」。

**审计方法**：先扫描 `emit.ts` 里同一句生成的 C 中重复插值 `${…code}` 的站点（Python 脚本按 `this.line(...)` 与多行模板两种粒度各扫一遍），再为每一族写「静态计数器 + 调用次数」探针（`temp/once.as`），与 AIR 的「每个操作数从左到右各求值一次」逐条对账。共 18 处候选，其中 4 处是 **TS 三元假阳性**（如 `e.discard ? "(void)(x)" : "x"`，两条分支只会有一条落到 C 里），其余 14 处为真。

**修前实测（同一段代码里该调用的实际执行次数；AIR 语义均为 1）**：

| 形态 | 生成 C 里被内联多次的原因 | 修前 → 修后 |
|---|---|---|
| `box.get().m()` | 方法调用要读接收者两次（vtable + `this`） | 2 → 1 |
| `box.get().f = "Z"` | 成员写要读接收者三次（存值 / GC 写屏障 / 表达式的值） | 3 → 1 |
| `box.get().w`（属性 getter） | getter 读发射成 `x->vtable->get_w(x)` | 2 → 1 |
| `box.asI() == i1`（接口 `==`） | `a.obj == b.obj && a.vt == b.vt` | 2 → 1 |
| `box.get() as Box` | `as` 先 `as_v_is_inst(x,…)` 判定再 `as_v_obj_val(x)` 取值 | 2 → 1 |
| `h.getFn()()` | `Function` 值调用读被调值两次（`f->fn(f->env, …)`） | 2 → 1 |
| `s.replace(h.mkRe(), "b")` | 正则参数读两次（`re->compiled` + `re->global`） | 2 → 1 |
| `Boolean(getS())` | 字符串参数读两次（`s != NULL && strlen(s) > 0`） | 2 → 1 |
| **模块级** `var x = box.get().m();` | `emitTopLevel` 的模块 var 初始化路径**绕过** `sequenceValueExpr` | 2 → 1 |
| `for (var i = box.get().m(); …)` | `emitFor` 的 init 直接内联进 for-header，从不经 `sequenceValueExpr` | 2 → 1 |
| `throw new Error("e" + box.get().m())` | `emitThrow` 未过 `sequenceValueExpr`（改后更稳） | 1 → 1 |

**修法**（`src/emit.ts`，逻辑集中在一个新助手上）：

| 位置 | 改动 |
|---|---|
| 新增 `hoistImpure(e, guaranteed)` | 唯一的判定点：操作数**带副作用**（`isPureExpr` 判否）**且保证会执行**（不在 `&&`/`\|\|`/`?:` 的短路分支里）时，先求值进临时变量并登记 `hoistedAssigns`，此后 `emitExpr` 各处引用都拿到该临时量。纯操作数（变量/字面量/字段链）不产生任何额外 C——绝大多数语句的生成结果**逐字不变** |
| `sequenceValueExpr` 的 `Member`/`AttrAccess` | 补 `hoistImpure(e.object)`（getter 读的接收者两次） |
| `sequenceValueExpr` 的 `Assign`/`Update`（`Member`/`AttrAccess` 目标） | 补 `hoistImpure(e.target.object)`（成员写/自增的接收者三次） |
| `sequenceValueExpr` 的 `Binary` | `==`/`!=`/`===`/`!==` 的两个操作数各补一次 `hoistImpure`（接口形态会读两遍） |
| `sequenceValueExpr` 的 `Is`/`As` | 补 `hoistImpure(e.obj)` |
| `sequenceValueExpr` 的 `Call` | 被调值不是 `Var`/`Member`（`getFn()()`、`arr[i]()`）时补 `hoistImpure(e.callee)`；参数由 `sequenceValueExpr(args)` 改为逐个 `hoistImpure`（正则参数、`Boolean(str)` 等内联参数两次的内建） |
| `emitTopLevel` 的模块 `VarDecl`/`ConstDecl`/`ConstDecls` | 补 `sequenceValueExpr(init, true, true)`（与 `emitStmt` 的同名分支对齐） |
| `emitFor` 的 init（`VarDecl`/`VarDecls`/`ExprStmt`） | 补 `sequenceValueExpr`（init 只求值一次，安全）；`cond`/`update` **刻意不动**（见残留） |
| `emitThrow` | 补 `sequenceValueExpr(stmt.value, true, true)` |

**同批修正的真值语义**（审计 `Boolean(x)` 参数时发现，同为「静默错值」类，一并修掉；AIR 51.4.1 经 `adl` 实测对照 `temp/refcheck/Conv.as`）：

| 表达式 | AIR | 本子集修前 | 修后 |
|---|---|---|---|
| `Boolean({})` / `Boolean([])` / `Boolean(new Sprite())` / `Boolean(接口值)` / `Boolean(函数值)` | `true` | `false` | `true`（非空引用恒真，不再走 `ToNumber(x) != 0`） |
| `Boolean(NaN)` / `if (NaN)` / `while (NaN)` / `NaN ? a : b` | 假 | **真**（C 的 `if (d)` 认为 `NaN != 0`） | 假（新增 `as_num_truthy(x) = x != 0 && !isnan(x)`，静态 `Number` 条件经 `condExpr`、装箱 `*` 经 `as_v_truthy` 同走此判定） |
| `Boolean(0)` / `Boolean("")` / `Boolean("x")` / `Boolean(1)` | `false`/`false`/`true`/`true` | 同 | 同（未变） |
| `int({})` / `Number({})` | `0` / `NaN` | 同 | 同（未变） |

**验收（可复现）**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/expr-once.as --run` | `expr-once: all assertions passed`（约 45 条断言：14 个「求值一次」用例 + 6 个「各求值一次」用例（链式 2 次、`new` 两参数 2 次、数组字面量 2 个元素 2 次）+ 引用/NaN 真值 12 条） |
| **反向对照 1**（`hoistImpure` 直接 `return`） | 必 FAIL：`Uncaught exception: FAIL: a getter read evaluates its receiver once (got 2)` |
| **反向对照 2**（去掉 `emitTopLevel` 的 `sequenceValueExpr`） | 必 FAIL：模块级首例（`var wv = probe.get().w`）`got 2` |
| **反向对照 3**（`Boolean` 的引用分支改回假值路径） | 必 FAIL：`FAIL: and a non-null object converts to true (got false)` |
| **反向对照 4**（`condExpr`/`as_v_truthy` 的 NaN 判定改回 `!= 0.0`） | 必 FAIL：`FAIL: Boolean(NaN) is false through the boxed path too` |
| `node test.ts` | **110 passed / 0 failed**（新增 `expr-once.as`） |
| **Starling 端到端**（最大真实代码面） | 119 个 `.as` 编译+链接成功；生成 C 仅多 **732** 个 `_once` 临时量 / 34 处 `as_num_truthy`（5.1 MB C 内），纯操作数处零改动；`temp/hidpi/demo_drive.py` 逐场景点入：**11/12 场景进入、进程存活、日志 0 条异常** |

**残留（新表行）**：`while`/`do-while`/`for` 的**条件**与 `for` 的 **update** 表达式仍按迭代内联，若其中含带副作用的接收者（如 `while (box.get().m() > 0)`）会重复求值。这些位置**不能**用前置临时量修：那会把值冻结在循环外，与既有红线「`&&`/`||`、`?:`、循环条件不提升」冲突。正确修法是把循环重写为「条件求值体前置 + `if (!c) break`」（`continue` 语义需同步核对），风险与收益不成比例，故记为残留。

#### 阶段八十九·三十九：MSL 多采样器（逐单元 sampler 声明 + 逐单元状态绑定）（v0.3.134 → v0.3.135）✅ 已完成

收掉遗留表的「MSL 单采样器限制」。根因（阶段八十九·二十实装时确认、本阶段修掉）：AGAL→MSL 翻译器**恒定**只声明 `sampler smp [[sampler(0)]]`，一个 `smp` 被整个片元程序的所有 `tex` 指令共用；而 Metal 的过滤/环绕/mip 状态挂在 `MTLSamplerState` 上（不像 GL 那样属于纹理对象），所以共用一个 sampler 等于**把所有纹理单元钉在同一份状态**上，`s3d_draw` 只能退化为「取最低已绑定纹理单元的记录状态」。

**改动（两侧必须同时改，缺一不可）**：

| 侧 | 位置 | 改动 |
|---|---|---|
| 翻译器 | `src/runtime.ts` `as_agal_translate` 的 MSL 分支 | 片元前导按 `agal_is_used(AGAL_FS, i)` 逐个声明 `sampler smpN [[sampler(N)]]`（此前固定一行 `sampler smp [[sampler(0)]]`） |
| 翻译器 | `agal_emit_body` 的 tex（op 0x28）两处发射点 | `tex` 的采样改用**被采样寄存器编号**对应的 `smpN`（`%s.sample(smp%d, …)`，N 取 `n2 = s2lo & 0xFFFF`）。两处（整掩码 / 部分写掩码）都改为 **MSL 与 GLSL 两条独立 sprintf**——两目标 vararg 个数不同（MSL 多一个 `n2`），沿用三元格式串会静默错位（本阶段反向对照时真的触发了 `-Wformat` + 崩溃） |
| 后端 | `vendor/stage3d_glue.mm` `s3d_draw` | 采样器绑定由「只绑 index 0、状态取最低已绑定单元」改为**逐单元绑定 0..7**：每个 index 用该单元自己的 `setSamplerStateAt` 记录（未设置则回落 linear+clamp）。必须绑满 8 个，因为程序可能只采样 `fs3` 而完全不碰 `fs0` |

GLSL 目标（web）**不改**：GLSL ES 1.00 没有 sampler 对象，采样状态属于纹理对象，`vendor/stage3d_webgl.cc` 本就在 draw 时逐单元 `s3d_apply_sampler(c, c->textures[i], i)`。

**验收（含 GPU 级反向对照）**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/stage80.as --run`（翻译器字符串断言） | 新增多采样器小节：`fs0`/`fs3` 各自声明 `smp0 [[sampler(0)]]`/`smp3 [[sampler(3)]]`、未采样的 `smp1` 不声明、`fs0.sample(smp0,`/`fs3.sample(smp3,` 命中、不存在共享名 `smp`；另加**部分写掩码**程序（`tex ft2.xy, v1, fs3`）锁定逐分量发射路径与 GLSL 操作数顺序 → `stage80: all AGAL translate/validate assertions passed` |
| **反向对照 A**（翻译器退回单共用 `smp`） | 必 FAIL：`FAIL: fs0 declares its own sampler at index 0 (missing 'sampler smp0 [[sampler(0)]]')` |
| **反向对照 B**（保留逐寄存器声明，但 tex 一律用 `smp0`） | 必 FAIL：`FAIL: tex on fs3 samples through smp3 (missing 'fs3.sample(smp3,')` |
| `node src/index.ts examples/stage83.as --manifest examples/stage83.build.json --run`（**真实 GPU**，Metal + render-to-texture + `drawToBitmapData` 读回） | 新增第 4 节：双纹理片元程序（`tex ft0,v0,fs0; tex ft1,v0,fs1; add oc,ft0,ft1`）+ 4x4 底色条纹理（列 0 红/1 绿/2 蓝/3 白），`uv.u=0.4`（纹素坐标 1.6：NEAREST 明确取纹素 1 绿，LINEAR 为 0.9 绿 + 0.1 蓝）→ 两次绘制断言：都 NEAREST 得到纯绿 `0x00FF00`；单元 1 改 LINEAR 后像素必须不同且蓝通道 ≈10%（实测落在 8..64）→ `stage83: (Metal) passed` |
| **反向对照 C**（后端退回「只绑 index 0」） | 必 FAIL：`FAIL: unit 1 LINEAR blends in a little blue, so its own sampler state is in effect (got 0xff00)` —— 与修前行为逐值一致（单元 1 只能用单元 0 的状态） |
| 纯 C 目标（`node test.ts` 里的 stage83 无 manifest 分支） | 无 GPU 时读回为黑，断言仍成立 → `stage83: (state machine) passed` |
| `node test.ts` | **110 passed / 0 failed** |
| **Starling 端到端** | 119 个 `.as` 编译+链接成功；`temp/hidpi/demo_drive.py` 逐场景点入：**12/12 场景 ok**、`grep -ci "uncaught\|exception\|error #"` = 0、`grep -c "missing Sampler"` = 0（多单元绑定没有引入新的 Metal 校验错误） |

**残留**：无（多纹理单元在 native Metal 与 web GL 两侧都按单元生效）。Starling demo 自身没有使用两个 `fs` 寄存器的程序，故 demo 只作为**回归**证据；真正的多采样器语义由 stage83 的 GPU 断言 + 三组反向对照锁定。

#### 阶段八十九·四十：`flash.net.SharedObject` 本地存储（v0.3.135 → v0.3.136）✅ 已完成

收掉遗留表的「`flash.net.SharedObject` 未实现」，也是 **Flappy-Starling 端到端**的最后一个硬阻塞（此前只停在 `undefined variable 'SharedObject' in class Game`）。

**一、AIR 真实语义（adl 51.4.1 实测，`temp/refcheck/SoCheck{1,2,3,4}.as`）**

| 观测 | AIR 结果 | 对本实现的影响 |
|---|---|---|
| 类身份 | `getQualifiedClassName` = `flash.net::SharedObject`，`so is EventDispatcher` = true | `superClass: 'EventDispatcher'`，`fqn: 'flash.net::SharedObject'` |
| `getLocal` 同一名字两次 | **返回同一实例**（`so == so2` 为 true，一侧改 `data` 另一侧可见） | 必须做进程内实例缓存（否则两个句柄会互相覆盖，属静默数据丢失） |
| `data` 赋值 | `so.data = {…}` 是**编译错误**（属性只读） | `data` 只发 getter，不发 setter（与 AIR 一致地拒绝） |
| `data[key]` 缺失键 | `undefined`（本子集统一为 `null`，既有口径） | `int(null) == 0`，与 `int(undefined) == 0` 等价 |
| `flush()` | 返回 `"flushed"`；`SharedObjectFlushStatus.FLUSHED/PENDING` = `"flushed"`/`"pending"` | 直接返回同一常量串 |
| `size` | `{a:1}` → 43、`{value:12345}` → 48，**且文件尚未存在时也报 48** → 度量的是「将要持久化的表示的字节数」，不是 `stat` 文件 | 取 `strlen(JSON(data))`（我们的容器是 JSON，故数值更小，规则一致） |
| `clear()` | 清空 `data` **并删除磁盘文件**；对象仍可用，再 `flush()` 会重新建文件 | 一并实现 |
| `close()` | 本地对象**无副作用**（数据/文件/可用性都不变）；文档也写明只作用于远端 | 空实现 + 注释 |
| **应用退出时** | 即使**从未调用 `flush()`**，应用退出后 `.sol` 文件仍然出现（本地共享对象在关闭时写入） | 必须实现退出落盘（否则 Flappy 这种从不 `flush()` 的用法会静默丢分） |
| 未声明属性赋值 | `so["favoriteColor"]="blue"` → `ReferenceError #1056: Cannot create property favoriteColor on flash.net.SharedObject.` | **非 dynamic 类**：走既有的密封类路径（`fqn` 让消息与 AIR 同形） |
| 常量 | `ObjectEncoding.AMF0=0/AMF3=3/DEFAULT=3`、`defaultObjectEncoding=3`、`preventBackup=false`、`client == so` | 全部按实测值建模 |
| 远端 API | `getRemote/connect/send` 需 Flash Media Server | **响亮失败**（`as_throw(Error_new(...))` + 说明性消息），不静默假装 |

**二、实现**

- `src/symbols.ts`：注册 `SharedObject`（extends `EventDispatcher`，非 dynamic，`fqn: 'flash.net::SharedObject'`）+ `SharedObjectFlushStatus`（`constClass`）+ `ObjectEncoding`（`intConstClass`）。方法 `flush/clear/close/connect/send/setDirty/setProperty` + 静态 `getLocal/getRemote`；访问器 `data`（无 setter）/`size`/`client`/`objectEncoding`，写侧 `client/objectEncoding/fps`（`fps` 只节流上传，本地无服务器，仅存值）；静态访问器 `defaultObjectEncoding/preventBackup`。另有一个 **AS3 不可见的静态字段 `_cache`**（`staticFields`），作为「同名字返回同一实例」的实例表——声明为静态字段即等价于**永久 GC 根**，被缓存的实例不会被回收。
- `src/emit.ts`：`SharedObject` 的 C 运行时槽（`name/path/_data/_client/_objectEncoding/_fps`）在 `emitStructs` 按 `isSubclassOf(name,'SharedObject')` 发射（与 `Matrix3D._m[16]`、`TextField._para*` 同一机制）；`_data`/`_client` 这两个 GC 指针在 `emitPropTables` 显式写成反射表条目（type 6，与 `TextField._runs` 同理），因此 `hasOwnProps` 对 `SharedObject` 特判为 true。存储层是 `as_so_path/mkparent/load_text/flush/flush_all` + `getLocal/getRemote/flush/clear/close/setDirty/setProperty/size` 等 C 体；**退出落盘**由首次 `getLocal` 注册的 `atexit(as_so_flush_all)` 承担（空表跳过，故 `clear()` 的「删文件」效果不会被退出钩子撤销）。
- **有意的格式偏差（已在 README 写明）**：AIR 用 AMF3 `.sol` 容器，本子集的持久化后端是 `<applicationStorageDirectory>/[<localPath>/]<name>.json`，经既有 `as_json_stringify`/`as_json_parse`（无 AMF3 编码器，也不自研）。语义（身份、flush/clear/size 规则、退出落盘）对齐 AIR，**字节格式与确切 size 数值不对齐**。写失败抛 `Error`（AIR 会返回 `"pending"` 并稍后重试；本地同步写要么成功要么失败，静默回 `"pending"` 是假报）。

**三、验收**

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/sharedobject.as --run` | `sharedobject: all assertions passed`（9 节：data/flush/size、磁盘文件内容、实例身份、**从磁盘加载已有存档**、`localPath` 选不同库、clear 删文件、访问器与常量默认值、`setProperty`/`close`、远端 `getRemote` 必须抛） |
| **反向对照 1**（`getLocal` 不查缓存） | 必 FAIL：`FAIL: getLocal returns the same instance for the same name` |
| **反向对照 2**（不把解析结果装进 `_data`） | 必 FAIL：`FAIL: getLocal loads an existing store from disk` |
| **反向对照 3**（`flush` 不写文件） | 必 FAIL：`FAIL: the persisted file contains the flushed value` |
| **反向对照 4**（`clear()` 不删文件） | 必 FAIL：`FAIL: clear() deletes the backing file` |
| **反向对照 5**（不注册 `atexit` 退出钩子） | 必 FAIL（`temp/soexit.as` 探针：不 `flush()` 直接退出，进程结束后文件**必须不存在**；修前该文件存在且内容为 `{"topScore":777,"tag":"exit-flush"}`） |
| 跨进程持久化（`temp/soexit.as` → `temp/soread.as`） | 进程 A 不 `flush()` 退出后落盘；进程 B `getLocal` 读回 `topScore=777 tag=exit-flush` |
| `node test.ts` | **111 passed / 0 failed**（新增 `sharedobject.as` 单元） |
| **Flappy-Starling 端到端构建** | `node src/index.ts --air-app examples/Flappy-Starling/flappy-app.xml --main-class FlappyStarlingMobile -o temp/flappy-native` → **127 个 `.as` 全部编译+链接成功**（原生 Mach-O，Metal/Stage3D/Skia 全套），`EXIT=0`；窗口按描述符建成 375x667（Metal layer `contentsScale=2`），日志无异常 |
| **Flappy-Starling 运行期真链路**（`temp/flappy-probe/`，只给 `Game.as` 加 3 行 `trace`，其余照抄） | `FLAPPY-PROBE: Game() ctor ran; shared object loaded, topScore=-1`（读存档）→ 资源全部加载 → 点入游戏、小鸟坠落 → `bird crashed; score=0 topScore=-1` + `after compare, in-memory topScore=0`（写回）→ Cmd+Q 关窗（`window closed`）→ **`flappy-data.json` 由 `{"topScore":-1}` 变为 `{"topScore":0}`**（退出落盘） |
| Starling demo 回归 | `node src/index.ts --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo -o temp/starling-native` → 119 个 `.as` 编译+链接成功；驱动 12 场景无异常 |

**文档同步**：`README-CN.md`「支持子集」列入 `SharedObject` 及其 JSON 后端偏差；`examples/Flappy-Starling/AOT-NOTES.md` §3 三个缺口全部标记已修、§5 更正跳过理由；`test.ts` 中 `Flappy-Starling` 的跳过注释从「解析失败」更正为「整套 Metal 构建耗时过大（已可端到端跑通）」。

**残留**：Flappy 的**渲染**残差仍在（`csf == 2` 的 Stage3D 层缩放、`fullScreenWidth/Height` 无 `-screensize` 等价物），二者与 SharedObject 无关，继续留在遗留表。

#### 阶段八十九·四十一：非 GUI 目标的 GC 分配阈值自动触发（v0.3.136 → v0.3.137）✅ 已完成

收掉遗留表的「非 GUI 目标不自动回收（`gc_alloc` 无分配阈值）」。

**根因**：GC 的推进点只有一处——发射出的 `Stage_dispatchFrame` 帧边界调用 `gc_step()`（增量分片），外加 `System.gc()` 手动停机回收。没有帧的程序（纯脚本、服务端循环、WASI 运行）永远走不到那一处，`gc_bytes_allocated` 一直涨、`gc_inc.state` 一直是 `GC_IDLE`，于是「分配了多少就永久留在堆上」（实测：100 轮共 ~5 MB 垃圾 → 峰值 ~17 MB 且随分配总量线性上涨）。

**修法（两个方向都必要，缺一不可）**：

| 机制 | 位置 | 作用 |
|---|---|---|
| 帧驱动标志 | `src/runtime.ts` `gc_step()` 开头 `gc_frame_driven = true` | `gc_step()` 的**唯一调用者**就是帧边界（`emit.ts` 的 `Stage_dispatchFrame`），故「进过 `gc_step`」⇔「本程序有帧安全点」→ 有帧的程序继续走 GC-4 增量分片，保住每帧有界停顿（不因本阶段退化） |
| 分配阈值触发 | `src/runtime.ts` `gc_alloc()` 入口 | `if (!gc_frame_driven && state == GC_IDLE && gc_bytes_allocated >= gc_trigger()) gc_collect();` —— 从未派发过帧之前，分配自己按 `max(1 MiB, 在用堆/8)` 阈值做停机回收。**放在分配的最前面**（新对象还不存在），清扫不会把正在分配的对象当垃圾 |

停机回收（而非切片）是有意的：这条路径没有帧截止时间要保护、总工作量相同，切片只会给一条「必须从任意调用点都正确」的路径引入状态机；它与已被支持的 `System.gc()`（可在活着的 AS3 帧内触发）同类——`gc_mark_roots` 照常跑保守栈扫描（setjmp 落 callee-saved 寄存器 + 逐字扫），调用链各层的活局部都还是根；`main` 首行 `GC_NOTE_STACK_BASE()` 保证栈底一定已记录（早于任何 AS3 语句）。

**验收**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/gc_alloc_threshold.as --run` | `gc_alloc_threshold: all assertions passed`（全程不调 `System.gc()`、不派发帧：100 轮 ~5 MB 垃圾 → `base=0 peak=1056440 afterChurn=210576 peak2=1048752`，峰值 = 1 MiB 阈值下限；两轮爆发都断言峰值有界；活对象校验含模块级链表 100 节点逐项核对 + **函数局部**数组在被触发的收集点下层存活 + 收集后新建字符串内容完好 + 二次爆发仍有界） |
| **反向对照 1**（触发条件改 `if (0)`） | 必 FAIL：`Uncaught exception: FAIL: peak stays bounded without any System.gc() (peak=17772328 base=0)` |
| **反向对照 2**（`gc_mark_stack` 的保守栈扫描关掉） | 必 FAIL：`Uncaught exception: FAIL: the local burst returned its own length` —— 证明「栈扫描」是这条路径的承重条件（活局部被提前回收） |
| `node test.ts` | **112 passed / 0 failed**（含 `stage57`/`gc_strings`/`gc_incremental`/`gc_barrier`/`gc_midframe` 全部 GC 断言，且 `gc_incremental` 仍走增量路径——它先 `dispatchFrame`，标志随之为真） |

**已知权衡（有意保留并写进文档）**：一旦派发过帧，分配阈值触发即**让位**给帧边界的增量回收；此后若帧完全停摆，行为与本阶段之前一致（靠 `System.gc()` 兜底）。见 [`docs/zh-cn/gc.md`](docs/zh-cn/gc.md) §6.13。

**文档同步**：`docs/zh-cn/gc.md` 新增 §6.13（并在 §6.3 调度点、§8 风险表「GC 触发点非安全点」补指向）；`README-CN.md` GC 限制条目补触发点。

#### 阶段八十九·四十二：字节缓冲纳入 GC 堆（v0.3.137 → v0.3.138）✅ 已完成

收掉遗留表的「字节缓冲 arena 泄漏」；**同时用地道实测更正了该行对 Starling RSS 症状的归因**。

**根因**：`ByteArray.data`（grow / compress / uncompress）与 `BitmapData.pixels` 一直走 arena / `malloc`。它们挂在 GC 可见的字段上（`ByteArray_props` / `BitmapData_props` 的条目 type 6），可达性判断从来是对的，但内存不在 GC 堆里——`gc_mark_ptr` 遇到非堆指针只做「安全跳过」，**永不回收**。且 `malloc`/arena 的块不在 `System.totalMemoryNumber` 的账目内（那三项 = arena + 少量 runtime 自己的 `malloc` + GC 堆），所以这个泄漏长期隐形：同一段 40 轮 × 1 MB 的 churn，迁移前**账目 0 MB**（看起来毫无问题）、RSS **+40 MB 且不回落**。

**修法**：`src/runtime.ts` 新增叶子类型 `GCT_BYTES`（`GCT_TAG_BASE + 16`：`gc_scan` 直接 `break`、`gc_is_object` 上界、`gc_type_name`；与 `GCT_RAW`（Vector 元素负载）分开是为了 `ASC_GC_STATS` 的账目能区分两者），`src/emit.ts` 9 处缓冲改为 `gc_alloc(GCT_BYTES, n)`：

| 位置 | 原实现 | 现实现 |
|---|---|---|
| `ByteArray_set_length` / `as_ba_grow` / `as_ba_grow_pos` / `URLLoader` 二进制读 | `as_alloc(cap)` + `memcpy`，旧块丢给 arena（不回收） | `gc_alloc(GCT_BYTES, …)`，旧块成为 GC 垃圾 |
| `ByteArray.compress` / `uncompress` | `as_alloc(dst)` | `gc_alloc(GCT_BYTES, dst)`（uncompress 每次重试的失败块同样是 GC 垃圾） |
| `BitmapData` 构造 | `malloc(w*h*4)` | `gc_alloc(GCT_BYTES, w*h*4)`（自带清零） |
| 图片解码落 `pixels`（`Loader.loadBytes` / `BitmapData.loadFile`） | 直接 adopt glue `malloc` 的 ARGB 缓冲 | `memcpy` 进 GC 缓冲 + `free` glue 缓冲（glue 是 C++、调不到 GC；这样 `pixels` 的**所有权单一**） |
| `BitmapData.dispose()` | `free(bd->pixels)` | `bd->pixels = NULL`（丢引用——`free` 一个 GC 缓冲会砸坏 GC 空闲链） |

写入这些字段的 6 处全部补 `gc_write_barrier`（增量标记期对象可能 BLACK 而新缓冲 WHITE）。**顺带**：`Context3D_submit` 每帧每流的顶点反交织临时缓冲从 `malloc`/`free` 改为**缓存复用**（`s3d_submit_scratch_get`；`as_s3d_upload_vertex` 是同步拷贝、指针不出调用），每帧零 `malloc`/`free`。

**验收**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/gc_bytes.as --run`（新示例） | `all assertions passed`：① 两轮 40 × 1 MB churn → `totalMemoryNumber` 0/360 B、`privateMemory` 1.43 → 3.60 MB 且第二轮持平；② zlib 缓冲可回收；③ 40 张 512×512 位图（不 `dispose`）可回收；④ `dispose()` 后可回收；⑤ 活 `ByteArray`/`BitmapData` 跨 20 轮**同尺寸**分配 + 收集后首/中/末字与像素逐项核对 |
| **反向对照 1**（9 处 `gc_alloc(GCT_BYTES, …)` 还原 `malloc`） | 必 FAIL：`FAIL: RSS did not grow by the churn size (privateMemory 1409024 → 42254336)` |
| **反向对照 2**（`data`/`pixels` 的反射表条目改成 type 4「标量、不跟」） | 必 FAIL：`FAIL: a live ByteArray keeps its first word across collections (got 0)`（缓冲被回收 + 空闲链复用清零） |
| `node src/index.ts examples/stage83.as --manifest examples/stage83.build.json --run`（Metal 真 GPU） | `stage83: (Metal) passed`（覆盖 `Context3D_submit` 缓存化后的提交路径） |
| Starling 全量构建 + 12 场景驱动 | `--air-app examples/air-starling-demo/Demo-app.xml` 构建成功（本阶段源码零回归）；`temp/hidpi/cycle.py 11 12` 12 轮存活 |
| `node test.ts` | **113 passed / 0 failed**（含新示例 `gc_bytes.as`） |

**遗留（本阶段实测更正了归因，已改写遗留表该行）**：Starling demo 逐轮 RSS 上涨**不是**这条字节缓冲泄漏——同机同 harness 对比，迁移前 175→206 MB（12 轮）/ 迁移后 175→202 MB，**斜率不变**；同期 `ASC_GC_STATS` 的 `as_big`（arena ≥1 MB 请求）**0 条**、`leaks` **288 B**（18 × 16 B）、活动 `malloc` 16.7 → 17.1 MB、GC 堆平（16 MB / 276 段）、`vmmap` 里 `MALLOC_MEDIUM/LARGE (empty)` 空区在 10~60 MB 反复涨落（约每 8~10 轮返回一次）。即 RSS 增长来自**分配器高水位**，不是可回收的活对象、也不是我们的字节缓冲。另注：当前 harness 的菜单点击落不到按钮（窗口 640×1112 vs 渲染面 1800×1169，即已知的 `csf==2` Stage3D 缩放缺陷），故该曲线其实**不含**场景进出。

**文档同步**：`docs/zh-cn/gc.md` 新增 §6.14（含所有权/屏障约束与 §8 新增风险行「同一字段混用 GC 缓冲与 malloc 缓冲」）；`README-CN.md` GC 限制条目改写「仅剩字节缓冲」段（列出剩余不在 GC 堆的缓冲）与示例列表；版本号 v0.3.137 → v0.3.138。

#### 阶段八十九·四十三：循环条件与 `for` 更新的单次求值（连带 null 归一化）（v0.3.138 → v0.3.139）✅ 已完成

收掉遗留表的「循环条件 / `for` update 里的重复求值（阶段八十九·三十八残留）」。

**根因**：条件/`for` 更新表达式直接被内联进 C 的循环头（`while (cond)`、`for (init; cond; upd)`），而**单个**条件求值在生成 C 里就可能把同一接收者展开两次/四次：getter 读是 `p->vtable->get_n(p->vtable->get(p))`（接收者两次）、setter 写是 `p->vtable->get(p)->vtable->set_n(p->vtable->get(p), v)`（两次）、setter 自增是 `get(p)->set_n(get(p), get(p)->get_n(get(p)) + 1)`（**四次**）。于是 `while (box.get().m() > 0)` 每轮把 `get()` 跑两次，`for (…; …; box.get().i++)` 同理。

**修法**（`src/emit.ts`）：`emitWhile`/`emitDoWhile`/`emitFor` 只在**确有需要提升**时把循环改写成「前置求值 + 显式测条件」形态——循环体**内部**放前置语句（放循环外会把副作用冻结）：

```
while (cond) body      ->  for (;;) { <cond prelude> if (!(cond)) break; body }
do body while (cond)   ->  for (;;) { body; <cond prelude> if (!(cond)) break; }
for (init; cond; upd)  ->  for (init; ;) { <cond prelude> if (!(cond)) break;
                                           body; <upd prelude> <upd>; }
```

条件/更新离开了 C 的循环头，未标签的 `continue` 便不再能靠「掉出循环体」到达它们——`continueTargets` 记录一个放在它们**前面**的标签，`continue` 发射为 `goto` 该标签（`do-while` 的 `continue` 必须重新测条件，故检查移到无条件循环体的末尾；带标签的 `continue lab` 同样落到标签处）。没什么可提升的循环保持可读的 `while (cond)` / `for (a; b; c)` 形态（`captureSequence` 以「实际吐出的行数」判断，不会与 `sequenceValueExpr` 的真正判断漂移）。

**连带修掉三个同族缺陷**（都是本阶段在写用例时被暴露出来的）：

| 缺陷 | 现象 | 修法 |
|---|---|---|
| `Update` 分支提前 `return` 跳过接收者提升 | `obj.get().n++` 的 `get()` 被求值 **4 次** | 把 `hoistImpure(e.target.object)` 提到 `resolveUpdateSetter` **之前**（resolver 会把接收者的 C 文本烘进 `objCode`，之后再提升就无效） |
| `Assign` 分支同样提前 `return` | 循环条件 `obj.get().n = v` 的接收者每轮求值 **2 次**，且 RHS 在接收者之前求值（违背从左到右） | 同上，提升无条件地放在 `resolveInstanceSetter` 之前 |
| 值上下文的 setter 自增引用未定义变量 | `var x = obj.prop++` 让**编译器**抛 `ReferenceError: expr is not defined`（`emitExpr` 的代码被复制进 `sequenceValueExpr` 时未改引变量名；阶段八十九·三十八 之前就在） | 改用 `e.prefix` |

**连带修掉 null 归一化（同一批用例暴露的最严重缺陷）**：指针型 box 助手 `as_v_obj`/`as_v_arr`/`as_v_fn` 拿到 NULL 指针时产出 tag 4/6/7 + NULL 的值，而 null 字面量是 tag 0 → `as_v_eq` 判**不相等**。后果是 AS3 经典写法 `while ((v = src.next()) != null)` **永不终止**（tag 4/NULL ≠ tag 0/NULL）——这正是本轮在 `temp/loop.once` 探针上遇到的「二进制卡死」。三元表达式联结「对象分支 + null」（`n <= 3 ? new Src(n) : null`）正是产出 `as_v_obj(NULL)` 的路径。修法：三个 box 助手遇到 NULL 一律回落到 `as_v_null()`，让 `as_value` 只有**一种** null 表示。AIR 51.4.1 实测（`temp/refcheck/NullEq.as`）逐条对照：

| 表达式 | AIR | 修前 | 修后 |
|---|---|---|---|
| `(*=ternary null) == null` / `!= null` / `=== null` / `!== null` | true / false / true / false | 两项反了 | ✅ |
| `typeof (*=null)` | `object` | `object` | ✅ |
| `(*=null) is Object` / `null is Object` | false / false | **true** | ✅ |
| `(Function=null) == null`；`typeof` 该值 | true；`object` | true；**`function`** | ✅（`typeof` 的静态折叠改为运行时判空） |
| `(Array=null) == null`；`(Object=null) == null` | true；true | true；true | ✅ |
| `undefined == null` / `undefined === null` | true / false | 同 | ✅（回归保护） |
| `while ((v = next()) != null)` | 正常终止 | **死循环** | ✅ |

**验收**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/loop-once.as --run`（新示例，8 组断言） | `loop-once: all assertions passed`：条件/更新每轮恰一次（`while` 2×、`do-while` 2×、`for` 条件 2×、`for` 更新 1×）、带副作用的条件**每轮重算**（不是冻结）、`continue`/`continue label` 仍到达 `for` 更新、改写形态下 `break` 只退内层、多声明符 `for` init 只跑一次、接收者单次求值（setter 写/复合/后置/前置/值上下文）、赋值当条件的值语义与「接收者先于 RHS」的求值顺序、`while ((v = fetch()) != null)` 读到 null 终止 |
| `node src/index.ts examples/null-eq.as --run`（新示例，5 组断言，逐条对齐上表 AIR 实测） | `null-eq: all assertions passed` |
| **反向对照 1**（把 `captureSequence` 的 `sequenceValueExpr` 调用去掉 → 循环不再改写） | 必 FAIL：探针 `temp/looponce_rc.as` 报 `FAIL: while condition evaluates its subject once per test (got 4)`；示例本体更早**编译期**就报错（`statement requires expression of scalar type ('void' invalid)` ×3——空返回 setter 当条件只有改写形态才合法） |
| **反向对照 2**（删掉 `Update` 分支的 `hoistImpure`） | 必 FAIL：`FAIL: a setter post-increment evaluates its receiver once (got 4)` |
| **反向对照 3**（删掉 `Assign` 分支的 `hoistImpure`） | 必 FAIL：`FAIL: a setter assignment as a loop condition tests its receiver once per round (got 6)` |
| **反向对照 4**（`as_v_obj` 还原为不判 NULL） | 必 FAIL：探针 `temp/nulleql.as` 报 `HANG-GUARD hit, got=11`（`while (F.f() != null)` 不终止） |
| **反向对照 5**（`e.prefix` 还原为 `expr.prefix`） | 必 FAIL（loud）：`ReferenceError: expr is not defined`，编译退出码 1 |
| **反向对照 6**（`typeof` 的 `function` 分支还原为常量折叠） | 必 FAIL：`FAIL: typeof a null Function is 'object', not 'function' (AIR agrees)` |
| `node test.ts` | **115 passed / 0 failed**（新增 `loop-once.as`、`null-eq.as`） |

**文档同步**：`README-CN.md` 新增「null 只有一种表示」条目与两个示例；版本号 v0.3.138 → v0.3.139。

#### 阶段八十九·四十四：类字段遮蔽的槽位合并（Starling demo `Masks` 场景真凶）+ 容器元素自增 + 标签后声明（v0.3.139 → v0.3.140）✅ 已完成

收掉遗留表的「Masks 场景被 `mask` 的对象未裁剪（无法返回）」，并连带修掉同一批排查中暴露的两个「生成 C 不是合法 C / 语义偏差」缺陷。

**一、根因：AS3 字段遮蔽被继承扁平化合并成一个 C 槽（遗留表此项的「stencil 状态未恢复」推测是错的）**

`starling.display.DisplayObject` 有 `_mask`（真遮罩槽，父类方法经父类指针访问），`scenes.MaskScene` 自己也声明 `private var _mask:Canvas`（它要跟随指针的那个圆）。字段表此前以「名字」为键把继承字段摊平进 `info.fields`，**子类同名声明会 `Map.set` 覆盖父类那条** → 两者共用同一个 C 成员。于是 `MaskScene` 构造里的 `this->_mask = createCircle()` 写的是 **DisplayObject 的遮罩槽**：父容器 `DisplayObjectContainer.render` 便把这个**场景自己**当成被遮对象（`painter.drawMask(圆, 场景)`）+ `stencilReferenceValue++`，于是整个场景被裁进「初始停在 stage 原点」的那个圆里——`_contents`、`Scene` 基类的 Back 按钮、`_maskDisplay` 三者一起消失且点击无响应（残留的模板 reference 也让后续绘制对不上）。

**修法**（`src/symbols.ts`）：`expandInheritance` 摊平时只处理**本类自己的声明**（`v.owner !== name` 跳过），遇到跨类同名就给遮蔽方一个独立 C 槽名 `<名>__<声明类>`，被遮蔽方保留原名与偏移（父类方法经父类指针访问仍命中，派生结构体保持**前缀兼容**）；`ClassInfo.fields` 改为按 **C 槽名**为键（一次声明一条），另加 `ClassInfo.fieldKeys`（AS3 名 → C 槽名）索引，访问按「声明它的类」经新增的 `fieldSlot()` 解析。这样既有的 `cIdent(key)` 调用点（属性反射表、`offsetof`、GC 的 `gc_scan` 遍历、构造器初始化）全部无需改动。

**二、容器元素自增 `x[i]++` 生成的不是合法 C**：`Array`/`Vector`/`Dictionary`/dynamic 对象的元素经运行时访问器读写，没有 C 左值，旧代码直拼 `as_array_get(a, i)++` → `error: cannot increment value of type 'as_value'`（`d["a"]++`、`arr[0]++`、`o["n"]++` 这类日常写法全都编译不过；属性自增落在 `?:` 分支里则是 `expression is not assignable`）。修法：按 ES3 §11.3.1/§11.4.1 展开成读-改-写（`n = Number(x[i]); x[i] = n ± 1; 值 = n` / `n ± 1`），并**应用运算符自带的 ToNumber**（元素是字符串 `"5"` 时 `x[i]++` 得 5、存 6，不是 `"5"+1` 的 `"51"`）。取值上下文若不能预先求值（`?:`/`&&` 分支），读改写折叠成**一个逗号表达式**，副作用留在分支内（未走的分支不留痕）。

**三、`case`/`default` 标签后紧跟声明**：提升进 `case` 体的临时变量（不纯接收者的 `_onceN` 等）会直接跟在标签后面，而 C11 不允许「标签后直接是声明」（C23 才允许）——本机 `clang -O2` 只报 `-Wc23-extensions` 警告，**`emcc` 直接 `expected expression`**，web 构建因此失败。修法：每个标签后补一个空语句 `;`（与既有 `_lbl__continue: ;` 风格一致）。

**四、连带的同族缺陷：属性复合赋值当值时发射 void**（写本阶段示例时暴露）：`var t:int = cnt.n += 3;` 里 setter 返回 void，旧代码把它直接当值用 → `error: operand of type 'void' where arithmetic or pointer type is required`。修法：值上下文的 setter 赋值（`=` 与复合赋值）统一先算值再写——`=` 取 RHS（与既有行为一致），复合赋值取 `get() OP rhs`（**类型取表达式自身的类型**，如 String 属性的 `+=` 得拼接后的 String），写回时再按 setter 形参类型转换。

**验收**：

| 证据 | 结果 |
|---|---|
| `node src/index.ts examples/field-shadow.as --run`（新示例，四节 23 组断言：父子同名字段各自独立/写一槽不动另一槽/引用类型字段同形/未初始化 Number 仍 NaN、容器元素后置-前置-复合-自减与字符串元素 ToNumber、`?:` 分支内副作用不外泄（Array 与 accessor 两种形态）、`case`/`default` 体里的提升接收者与元素自增） | `field-shadow: all assertions passed` |
| **反向对照 1**（`expandInheritance` 还原「同名覆盖」） | 必 FAIL：`FAIL: mid inherits base's _v = 1 (got 100)` |
| **反向对照 2**（`indexUpdateStore` 还原为 `x[i]++` 直拼） | 必 FAIL（loud，编译期）：`cannot increment value of type 'as_value'` ×4 + `expression is not assignable`（`temp/idxupd.as`） |
| **反向对照 3**（`Number(x[i])` 还原为裸读） | 必 FAIL：`FAIL: ++ applies ToNumber to a String element (got 0/51)` |
| **反向对照 4**（分支内自增改为无条件前置语句） | 必 FAIL：`FAIL: the untaken branch leaves no trace (got 99/8)` |
| **反向对照 5**（撤掉标签后的 `;`） | 必 FAIL（loud，编译期）：`emcc` 报 `expected expression`（最小复现 `temp/swlbl2.as`） |
| web 构建 + 截图（**干净树**：诊断代码已全部移除，重生成 `.c` 后重编） | `temp/web-demo/masks_clean.png`：Masks 场景背景被裁成**圆形**（直径≈stage 的 46%）且 **Back 按钮可见**；点 Back 回菜单、Textures 场景正常（`textures_clean.png`），控制台除既有一例 404 无异常 |
| `node test.ts` | **116 passed / 0 failed**（新增 `field-shadow.as`） |

**文档同步**：`README-CN.md` 新增字段遮蔽 / 容器元素自增 / 标签后声明三条；版本号 v0.3.139 → v0.3.140。

> **已知低优先残差**：`for (_seq1270; ...)` 形态（已求值过的提升变量被重述为循环初值）在 web 构建里会产生 `expression result unused` 警告（修复前后各 48 处，非本轮引入），不影响正确性。



---

#### 阶段八十九·四十五：异步 IO 真化（job 表 + native 后台线程读/解码）+ 三处事件契约缺口（v0.3.140 → v0.3.141）✅ 已完成

收掉遗留表的「异步 IO 是『假异步』（同步阻塞 + 事件派发推迟）」。**用户决策**：只做「契约缺口修复 + native 后台线程」——web/WASI 目标保持同步内联策略；并要求像 adl 一样**支持多个请求同时在飞**（「adl 的加载就是异步的不用实测，可以同时发起很多请求」）。

**一、实测先推翻遗留行的病因假设**（原表写「仅影响加载期 UI 流畅度」，暗示读是主因）：

| 实测 | 结果 |
|---|---|
| `fread` 1.3 MB PNG ×10 | **1 ms**（0.1 ms/次） |
| 同图解码（`sk_image_decode_bytes_argb`，1568² `atlas.png`） | **19.7 ms** |
| 字体图解码 | 2.7 ms |

→ 停顿的 **99% 来自同步解码**，不是读。故后台线程必须把**解码**也搬走（只搬读等于没搬）。

**二、探针实测的三个契约缺口**（原实现「正确性已满足」的判断是错的）：

- `URLLoader.data` 在 `load()` 返回后**已非 null** —— 同步读 + `setTimeout(0)` 只推迟了事件，数据早于 COMPLETE 可见（AIR：`LoaderInfo.complete` = 「dispatched when data has loaded **successfully**」，数据应随事件到达）。
- `URLLoader` **从不派发 `ProgressEvent.PROGRESS`** —— Starling `AssetManager.as:1030/1061` 监听它算进度，是死代码。
- `Loader.load(url)` **从不真正解码** —— 旧路径读完直接派 COMPLETE，`content` 是一个 **0×0 Bitmap**（静默错误结果，违反 AGENTS.md §2.5「禁止静默吞错/fallback 到错误语义」）。

**三、实现（`src/runtime.ts` 异步 job 系统 + `src/emit.ts` 四个调用点/thunk）**

- **job 表**：`as_job`（独立 malloc，指针永不移动）+ 可增长指针数组表；`AS_JOB_READ_TEXT/READ_BYTES/IMAGE/FS_OPEN/DECODE`；状态 `QUEUED → RUNNING → DONE → FINISHING`；结果先落 malloc 暂存，**只在帧边界 finish thunk 搬进 AS3 可见状态**。
- **两种执行策略**：`#if !defined(__wasi__) && !defined(__EMSCRIPTEN__) && !defined(_WIN32)` → `ASC_ASYNC_THREADS`（`AS_ASYNC_WORKERS 4` 的 pthread 池，worker 内 read + decode）；其余目标 `as_async_submit` 内联就地跑完（保持原行为）。**与 skia 无关**，故 `--run` 的每个示例都在跑线程路径。
- **帧边界**：`Stage_dispatchFrame` 先 `as_async_tick()` 再 `as_timer_tick()`/`as_mc_tick()`；headless 的 `tickTimers()` → `(as_async_tick_wait(), as_timer_tick())`（等待 worker 排空 + 一次排空全部 DONE，保持示例确定性）。
- **三条不变式**：(A) worker 绝不碰 GC 堆（path/mode/byte payload 提交时从 GC 堆拷到 malloc）；(B) 在飞 job 的 AS3 目标必须被 `as_async_mark_roots` 标为 GC 根，且**从入表到 finish thunk 跑完都不移出表**；(C) job 表归 AS3 线程，唯一跨线程交接是 `j->state` + 暂存结果，全在 `as_job_lock` 下。
- **supersede**：同帧对同一目标再次 `load()`/`openAsync()` 时，旧 job 标 `dead`（AIR 重启加载）→ 它的 thunk 不跑、不派事件；被取代的 `FS_OPEN` 仍由 retire 路径 `fclose`。
- **thunk 在放锁状态跑**（thunk 派发事件 → 监听器可能链式 load → publish 需重新拿锁，持锁派发会死锁）；`as_async_tick` 加**重入守卫**（thunk 里监听器再调 `tickTimers()` 直接返回 0）。
- 调用点：`URLLoader__finish` + `URLLoader_load`；`Loader__imageFinish`（`load`/`loadBytes` 共用）+ `Loader_load` + `Loader_loadBytes`；`FileStream__openFinish` + `FileStream_openAsync`。**`URLLoader__finish` 在结果之后补派 PROGRESS 再 COMPLETE**；`startup` 只在 finish 里发布——符合「数据随事件到达」。

**四、两个竞态（实测定位，均非常见猜测）**

1. **publish 前入表**：旧代码先把 job 以 `QUEUED` 入表、之后才 `strdup` path → worker 认领半成品 → `fopen(NULL)` → 可读文件偶发误报 `AS_JOB_ERR_IO`（实测 2/25）。改为 `as_job_alloc` / `as_job_publish` 分离，supersede/grow/append 全在锁内（顺手修掉表 `realloc` 未持锁、`as_async_tick` 读 `state` 未持锁）。
2. **GC 根窗口**：`as_async_tick` 曾把已选中的 job **先移出表**再跑 thunk → thunk 内 `gc_alloc`（`BitmapData_new`/`Bitmap_new`，headless 无帧时走 `!gc_frame_driven && gc_allocated >= gc_trigger()` 的 stop-the-world 收集）→ 未标记的 `Loader` 被 sweep 清零 → `li = o->contentLoaderInfo == NULL` → `Loader__imageFinish+0x34` 写 `0x18` 崩（`EXC_BAD_ACCESS at 0x18`，崩溃报告 `~/Library/Logs/DiagnosticReports/async-conc-*.ips`，`otool -tvV` 反汇编确认）。修法：标 `AS_JOB_FINISHING` 但**留在表里**，thunk 跑完的 phase 3 才 retire/release。

**五、验收**

| 证据 | 结果 |
|---|---|
| `node test.ts`（新增 `examples/async-io.as`） | **117 passed / 0 failed**（原 116） |
| `node src/index.ts examples/async-io.as --run`（文本/二进制 data 在 COMPLETE 前恒 null、PROGRESS 先于 COMPLETE、5 请求同帧并发各自拿到自己的文件、重复 load 只后者完成、失败清空旧 payload、`loadBytes` 不可解码 → IO_ERROR 且 content 为 null） | `async-io: all asynchronous IO assertions passed` |
| `examples/stage62.as`（断言改写为 AIR 语义：不可读 URL → 无 COMPLETE + IO_ERROR；非图 payload → IO_ERROR + content 恒 null） | 通过 |
| **native+skia 时序探针**（`temp/async-conc.as` + `temp/async-conc.build.json`，1568² `atlas.png`） | `load()` 立即返回：**submit 恒 0 ms**；drain n=1/2/4/8/16 → **23/22/22/42/80 ms** ≈ `⌈n/4⌉×20 ms`（4 worker 真并发；串行实现应为 `n×20 ms`） |
| 稳定性 | `temp/async-conc` 0/40 崩溃；`./examples/stage62` 0/200 失败；`--run` 流水线 30 次 0 失败 |
| **native Starling demo 端到端**（`temp/hidpi/cycle.py` harness，4 轮场景进出 + 恢复后复验） | `cycle N ok: rss_before≈rss_after, dead=False`、`onLoadProgress → 1`、`onLoadComplete`、`finished N cycles, alive`（`AssetManager._numConnections = 3` → 3 个 `loadBytes` 并发压 4-worker 池） |
| **反向对照 1**（删掉帧边界的 `as_async_tick()`） | 必 FAIL：harness `cycle 0: menu has 0 buttons, no btn 0`，demo 日志停在「6 个资源已入队」后再无进展（资源永不完成） |
| **反向对照 2**（去掉 PROGRESS 派发） | 必 FAIL：`Uncaught exception: FAIL: PROGRESS precedes COMPLETE` |
| **反向对照 3**（解码失败回落 0×0 Bitmap） | 必 FAIL：`Uncaught exception: FAIL: an undecodable payload reports IO_ERROR` |
| **反向对照 4**（publish 前入表：`as_job_publish` 提到填 path 之前） | 必 FAIL（loud）：200 次可读加载 **`ok=141 ioError=59`**（修后 `ok=200 ioError=0`，`temp/asyncstress.as`） |
| **反向对照 5**（选中 job 提前出表，即撤掉 FINISHING 留表） | 必崩：3/3 `exit=139`（SIGSEGV），崩溃报告 `EXC_BAD_ACCESS` in `Loader__imageFinish`（修后 3/3 `exit=0`，`temp/rc/rc5*`） |

**已知缺口（诚实边界）**：①`LoaderInfo.PROGRESS` 仍不派发（Starling 监听的是 `URLLoader`）；②`LoaderInfo.bytesTotal` 在 COMPLETE 时才非 0（符合 AIR「首个 progress 前为 0」）；③纯 C 构建无图像解码器（`as_skia_image_decode_bytes_argb` 是返回 NULL 的桩）→ 非 skia 构建下图像加载报 `IO_ERROR`（#2124「Loaded file is an unknown type」），故解码成功路径不在 headless 套件内，由 skia 后端（native demo）覆盖；④`URLLoader` 未提供 `bytesLoaded/bytesTotal` 访问器（示例改从 `ProgressEvent` 取）。

**文档同步**：`README-CN.md`、[`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §3 决策-偏差表新增「异步 IO 的执行位置与排空时机」；版本号 v0.3.140 → v0.3.141。

---

#### 阶段八十九·四十六：`flash.net` HTTP 加载面调研立项（`docs/zh-cn/flash-net.md`）（v0.3.141 → v0.4.0）✅ 已完成（调研交付）

**背景**：用户提出「`URLLoader` 是否都实现了？能 POST 和 GET 了吗？」。核查结论：**两个都没有**。故本轮任务＝**逐项调研 AIR SDK 官方文档、落地为专项调研文档**（本轮只交付调研；实现另立阶段，见下方遗留表）。**版本号从本阶段起改从 `v0.4.0` 递增**（原 `v0.3.x` 序列终止，AGENTS.md §2.7 已同步）。

**一、实测坐实「`method` 是死字段」（非读码推断）**——探针设 `req.method="POST"`、`req.data="a=1&b=2"`、`req.contentType="application/x-www-form-urlencoded"` 后 `load(req)`：

```
1) method stored as    = POST          ← 字段可写、确实存进去了
2) data stored as      = a=1&b=2
3) load() returned; event=(none)  data==null? true   ← 异步契约正确
4) after tick: event=COMPLETE
5) l.data is String? true  len=4012
6) head of data: // stage63.as — flash.net / flash.ui (   ← 读出的是本地文件！
```

即 **method/data/contentType 三字段被彻底忽略，`load()` 把 URL 当地路径 `fopen` 读取**——这就是「没有 POST/GET」的直接反证。

**二、官方文档全貌（逐项摘自 `airsdk.dev/reference/actionscript/3.0/`，权威来源见 AGENTS.md §2.4）**——共调研 8 个类 + 4 个事件类 + 包级函数：`URLLoader`（`bytesLoaded`/`bytesTotal`/`data`/`dataFormat` + `load`/`close` + 7 个事件）、`URLLoaderDataFormat`（`TEXT`/`BINARY`/`VARIABLES`）、`URLRequest`（12 属性 + `useRedirectedURL`）、`URLRequestMethod`（**6 常量**：GET/POST/PUT/DELETE/HEAD/OPTIONS，非仅 GET/POST）、`URLRequestHeader`（受限头列表）、`URLRequestDefaults`（AIR 静态默认值）、`URLVariables`（`decode`/`toString`）、`URLStream`（低层流式 + 13 个 `read*`）、`HTTPStatusEvent`/`SecurityErrorEvent`/`ProgressEvent`/`IOErrorEvent`、包级函数 `navigateToURL`/`sendToURL`/`registerClassAlias`/`getClassByAlias`。

> 关键官方措辞（作为契约依据）：`URLLoader.complete` = 「所有数据解码完毕并放入 `data` 之后派发」（⇒ `data` 到 COMPLETE 才可见，与阶段八十九·四十五 对齐）；`bytesTotal`「加载进行中恒为 0，缺 `Content-Length` 则不可确定」；`HTTPStatusEvent` **总是先于 error/completion 派发**。

**三、现状盘点（逐项 grep 核实，非文档转述）**：

| 类别 | 项目现状 |
|---|---|
| ✅ 已实现但带偏差 | `URLLoader.data`/`dataFormat`、`load()`（**只读本地文件**）、`complete`/`progress`/`ioError`、`URLRequest.url`、`URLVariables`（dynamic+ctor+toString）、`URLLoaderDataFormat` 三常量、`HTTPStatusEvent`（类在、**从不派发**）、`SecurityErrorEvent`（类在、**从不派发**） |
| ❌ 完全缺失 | `URLRequestMethod`（**类不存在**）、`URLRequestHeader`、`URLRequestDefaults`、`URLStream`、`URLRequest` 的 8 个 AIR 属性、`useRedirectedURL()`、`URLVariables.decode()`、`bytesLoaded`/`bytesTotal`、`URLLoader(request)` 构造参数、`close()` 真中止（现为空函数）、`open` 事件、4 个包级函数、`Socket`/`SecureSocket`/`ServerSocket`/`DatagramSocket`/`XMLSocket`、`FileReference`/`FileReferenceList`、`LocalConnection`/`NetConnection`/`NetStream`/`NetGroup*` |
| ⚠️ 死字段 | `URLRequest.method`/`.data`/`.contentType`（可写、零读取） |

→ **一句话**：当前 `URLLoader` 是「本地文件读取器套了一个 HTTP API 外壳」——**不是「部分实现的 HTTP 客户端」，而是另一套语义**（本地资源加载），恰好复用了 AIR 的类型名与事件名。

**四、交付与路线（`docs/zh-cn/flash-net.md`）**：文档含完整 API 面、现状偏差表、4 项关键技术难点（**HTTPS/TLS 是真正门槛、非 HTTP 本身**；三目标分叉 native socket / web fetch / WASI **无 socket → 诚实 `ioError`**；与既有异步 job 体系的**流式升级**；AIR 安全模型简化）、**8 阶段路线**（A 语义层补全 / B 契约补全 → **无网络依赖、低风险，建议先做**；C HTTP+TLS 内核 / D native 对接 / E web 后端 / F `URLStream` / G WASI / H `navigateToURL` / I 验收）、验收与反向对照方案、明确不做/延后边界。

**五、验收（本轮为调研交付）**

| 证据 | 结果 |
|---|---|
| `docs/zh-cn/flash-net.md` 新增 | ✅（含官方 8 类 + 4 事件类全量签名、现状 grep 对照、8 阶段路线） |
| 探针实测 `method`/`data`/`contentType` 被忽略（读出本地文件 4012 字节） | ✅ 坐实「无 POST/GET」 |
| 现状盘点逐项 `grep` 核实（上表） | ✅ |
| 全量回归 `node test.ts` | 117 passed / 0 failed（本轮为纯文档+版本号变更，未改行为） |

**文档同步**：新增 [`docs/zh-cn/flash-net.md`](docs/zh-cn/flash-net.md)；遗留表新增「`flash.net` HTTP 加载未实现」一行（4 → 5 项）；`AGENTS.md` §2.7 版本序列改为 `v0.4.0` 起；版本号 v0.3.141 → **v0.4.0**。

---

#### 阶段八十九·四十六·补：TypePHP 网络面先例 + 「有无通用库覆盖全终端」论证（v0.4.0 → v0.4.1）

**背景**：用户追问「也看下 typephp 的 curl？」，并在 `docs/zh-cn/flash-net.md` §4.1「链接通用 TLS 库」一行批注 **「通用库看看有适配所有终端的吗？」**。故补一个前置论证小节，用证据回答该疑问。

**一、结论**：**不存在可覆盖 native + web + WASI 三端的单一通用库**，边界在**传输层**而非 TLS 原语——`mbedTLS`/`wolfSSL`/`BearSSL`/`OpenSSL` 都能编译到 wasm，但在 web/WASI 上**无 socket 可挂载**，TLS 无处落地。「一套库覆盖三端」在原理上不成立。

**二、证据（非推测）**
- Emscripten [Networking 官方文档](https://emscripten.org/docs/porting/networking.html)：*"direct access to TCP sockets is not possible from web browsers"*，HTTP 只能走 XHR/Fetch；并经 GitHub API 核实 `emscripten-core/emscripten/tools/ports/` **无 curl port**（只有 zlib/libpng/SDL 等）。
- **TypePHP 先例**（同型 AOT 编译器，已解同一问题，取舍可直接照抄）：native 构建清单 `link-libs: - curl`、扩展模式 `ext-deps: - curl`（*"Zend 扩展依赖，不是原生链接库"*）；**Nano（无 VM）直接无网络**（*"不提供 socket、DNS、网络、远程 stream"*）；**WASI** *"OpenSSL 采用 crypto-only 构建，不包含 TLS stream transport；HTTP/HTTPS 仍由 WASI HTTP Component 提供"*，并整体关闭 PHPX Facade *"避免把 curl、socket、Swoole 等不可用 API 暴露为'可编译但链接失败'的接口"*。
- 本项目目标为 **WASI preview1**（`src/build.ts` `--target=wasm32-wasip1`）→ 无 socket 原语 → 诚实 `ioError`；要走 `wasi:http` 须先升级到 preview2 + Component Model（独立大工程）。

**三、文档修订（`docs/zh-cn/flash-net.md`）**
- 修正 §4.1 表格中**不准确**表述「链接通用 TLS 库 … 一套代码三平台」→ 改为按 **native/web/WASI(preview1/2)** 分列的可移植性矩阵（✅/⚠️/❌），并新增 **§4.1.1**「有没有『一套通用库适配所有终端』？——没有」。
- §4.1 选型表补 **libcurl「一库到底」** 行（native 一份实现，与 TypePHP 同路）；§5-C 行与 §9 参考链接同步。

**四、验收**

| 证据 | 结果 |
|---|---|
| `flash-net.md` §4.1.1（可移植性矩阵 + TypePHP/Emscripten 证据 + §9 参考链接） | ✅ |
| 版本号 v0.4.0 → **v0.4.1**（`package.json` / `README-CN.md` / `TODO.md`） | ✅ |
| 全量回归 `node test.ts` | 117 passed / 0 failed（纯文档 + 版本号变更，未改行为） |

---

#### 阶段八十九·四十六·补二：libcurl 的获取与引入方式（系统库 vs `build-tools/`→`vendor/`）（v0.4.1 → v0.4.2）

**背景**：用户追问 **「libcurl 是否需要先下载到 `build-tools/` 中？再编译到 `as3compiler/vendor/`？」**——`flash-net.md` §4.1 此前只说了「首选直接链接 libcurl」，未交代它从哪来。

**一、结论**：**不是必须**，分两条路。

- **路线一（首期推荐）：用 macOS 系统库 —— 零下载 / 零编译 / 零 vendor**。构建清单只需 `link-libs: ["curl"]`，**连 `-I/-L` 都不用加**。
- **路线二（静态自包含 + 跨平台一份实现）：才走 Skia/SDL2 同款范式**——源码进 `build-tools/`，静态库产物落 `vendor/curl/<platform>-<arch>/{include,lib}`。

**二、实测证据**（`temp/curlprobe.c`，**无任何 `-I/-L`**）

| 检查项 | 结果 |
|---|---|
| 编译链接 `cc -O2 probe.c -lcurl` | ✅ 成功（零下载、零外部依赖） |
| `otool -L` | `/usr/lib/libcurl.4.dylib`（**动态**链接系统库，二进制不自包含） |
| 版本 / TLS 后端 | `curl 8.7.1` · `SecureTransport (LibreSSL/3.3.6)` |
| `https` 支持 / 真实请求 | ✅ `https://example.com/` HEAD → `HTTP 200`，`CURLE_OK` |
| SDK 是否有**静态** `libcurl.a` | ❌ **仅 `.tbd` 动态 stub**（`find Xcode -name "libcurl*.a"` 为空）→ 要静态就只能自编 |

**三、仓库既有分工**（非 libcurl 专属规则）：`build-tools/` = **构建输入区**（需自己重编的源码 + 工具链，**不参与运行时链接**：`skia-src`、`emsdk`）；`as3compiler/vendor/` = **消费区**（预编译产物，`include-paths`/`link-paths`/`link-libs` 指向此处：`skia`、`sdl2/arm64` 静态 `.a`）。Skia 之所以自编，是因官方预编译包**不含 Metal**；libcurl 系统库**已含 HTTPS**，故首期无需自编。

**四、路线二的真实代价不在 curl，而在传递依赖**：TLS 后端（mbedTLS/wolfSSL/OpenSSL/SecureTransport）+ `zlib` + `brotli` + `zstd` + `nghttp2` + `libidn2`/PSL，且需**逐平台交叉编译**；建议最小档 `curl + mbedTLS（或 wolfSSL）+ zlib`，并关掉 `brotli/zstd/nghttp2/libpsl/ldap/ssh2`。

**五、文档修订（`docs/zh-cn/flash-net.md`）**：新增 **§4.1.2**「获取与引入方式」；§4.1 结论与 §5-C 行补指向 §4.1.2 的交叉引用；`README-CN.md` 的 `flash.net` 段补一句。

**六、验收**

| 证据 | 结果 |
|---|---|
| 探针实测（零下载链接成功 + HTTPS 200） | ✅ |
| `flash-net.md` §4.1.2 + 交叉引用 | ✅ |
| 版本号 v0.4.1 → **v0.4.2**（`package.json` / `README-CN.md` / `TODO.md`） | ✅ |
| 全量回归 `node test.ts` | 115 passed / 2 failed / 117 total（失败为 `gc_alloc_threshold.as`、`gc_bytes.as` **两项 GC 内存测量断言**，属**并行会话在飞的 GC 工作**——`src/runtime.ts` mtime 02:01 晚于本次改动，与本次纯文档 + 版本号变更无关） |

---

#### 阶段八十九·四十七：非 GUI 自动回收阈值下限拆分 + 触发阈值缓存（v0.4.2 → v0.4.3）

**背景**：上一轮基准重跑（v0.4.0）发现阶段八十九·四十一 落地的「非 GUI 分配阈值自动回收」让两个分配型控制台明显变慢（`binarytrees` 80 → 293 ms、`strings` 187 → 272 ms），已登记进遗留表待评估。用户要求**先做计时分解、再定方案**。

**一、分解方法（临时探针，测完即删）**：在 `gc_collect()` 内按相位计时——`prep`（`gc_new` 归位 + `gc_all` 全链置白）、`internal`/`user`/`stack`（三类根）、`drain`（`gc_mark_drain`）、`sweep`、`finish`；`ASC_GC_STATS` 门控 + `atexit` 汇总；用 `ASC_GC_THRESHOLD` 扫不同回收间隔。

**二、结论：开销由「重新标记存活集」主导，与累积了多少垃圾无关**

| `binarytrees` 相位/单次 | 1 MiB | 4 MiB | 16 MiB | 64 MiB |
|---|---|---|---|---|
| 回收次数 | 154 | 45 | 24 | 20 |
| `drain`（标记）单次 | **1.08 ms** | 1.04 | 1.02 | 1.03 |
| `sweep` 单次 | 0.34 | 0.51 | 0.75 | 0.85 |
| `prep` 单次 | 0.20 | 0.25 | 0.34 | 0.37 |
| `stack`（保守栈扫描）**总计** | **0.3 ms / 154 次** | 0.1 | 0.1 | 0.0 |
| GC 总计 | 247–258 ms | 81 | 50 | 45 |

—— `drain` 单次**恒定**（存活集 ~1 MB 不变），`sweep`/`prep` 仅随间隔缓涨（空闲块被复用，`gc_all` 长度≈存活集），**保守栈扫描完全不是瓶颈**（154 次共 0.3 ms，此前怀疑的 `gc_mark_stack` 被排除）。故总 GC 时间 ≈ **次数 × 常数**，唯一杠杆是「少收」。`strings` 是另一副形状（存活集≈0 ⇒ `drain`=0，开销全在 `sweep` ∝ 垃圾量），但同样「少收更省」，只是收益较缓。

**三、修法一：下限按路径二分**（`GC_NONGUI_FLOOR` = 8 MiB；帧路径保持 1 MiB）

| 离屏下限 | `binarytrees` | `strings` | bt 峰值 RSS | 测试影响 |
|---|---:|---:|---:|---|
| 1 MiB（改前） | 287 ms | 258 ms | 9 MB | — |
| 4 MiB | 120 ms | 232 ms | 12 MB | `gc_alloc_threshold` 峰值界需放宽 |
| **8 MiB（选定）** | **97 ms** | 229 ms | **15 MB** | 同上；`gc_bytes.as` 原界即通过 |
| 12 MiB / 16 MiB | 88 ms | 236 / 218 ms | 19 / 23 MB | 12 MiB 后**性能饱和** |
| 32 MiB | ~82 ms | — | 30 MB | `gc_alloc_threshold` 总 churn 仅 17.8 MB → **永不触发，测试失效** |

两条路径的目标本就相反（帧路径要每帧停顿有界、小堆要及时开始；离屏无帧时限、要摊薄单次常数开销），因而下限不同，`floor = gc_frame_driven ? gc_threshold : GC_NONGUI_FLOOR`。选 8 MiB：拿到 96% 的可得收益而内存开销只有 16 MiB 方案的一半，且内存断言最严的 `gc_bytes.as` 无需改动。

**四、修法二：触发阈值缓存**（`gc_trigger_next`，`gc_finish_cycle` 里失效）—— `gc_trigger()` 需汇总 24 个 `gc_dbg_type_*` 计数，而 `gc_alloc` **每次分配**都判定一次；`ASC_GC_THRESHOLD`（短路该求和）87/88 ms vs 默认 98 ms 的稳定差就是它。**即上一轮报告里被当作「批次波动」的 293 vs 277 ms 其实是这个开销**（已就地更正）。

**五、测试同步**：`examples/gc_alloc_threshold.as` 的峰值界由 `base + 1500000` 改为 `FLOOR_BOUND`（8 MiB 下限 + 一块余量），并把注释里过期的「1 MiB 下限 / 每轮 50 KB / 共 5 MB」更正为实测（总 churn **17.8 MB**）；该测试仍能测到自动回收（`afterChurn` 界未动、仍通过）。这也划定了本旋钮的硬上限：floor ≥ 该测试总 churn 就再也测不到触发。`gc_bytes.as` 不改。

**六、验收**

| 证据 | 结果 |
|---|---|
| `node test.ts` | **117 passed / 0 failed / 117 total**（改前为 115/2/117，两项失败正是本阶段的语义变更） |
| `python3 benchmarks/run.py` × 3 批 | 8/8 OK（四路结果一致）；`binarytrees` 293 → **97 ms**、`strings` 272 → **229 ms**，其余 6 项在噪声内（`fib` 291 / `nbody` 194 / `mandelbrot` 95 / `spectralnorm` 48 / `oop` 55 / `array` 119） |
| GUI/帧路径零影响 | 论证：唯一改动是下限选择，`gc_frame_driven` 为真时仍取 `gc_threshold`（1 MiB，与改前同）；`gc_trigger_next` 只被非 GUI 分支读取。`test.ts` 全部 GUI/离屏示例通过 |
| 探针回退 | `gc_ph*` / `[TEMP-PROBE]` 已清零，`runtime.ts` 只剩两处正式改动 |
| 版本号 v0.4.2 → **v0.4.3**（`package.json` / `README-CN.md` / `TODO.md`） | ✅ |

---

### Flappy-Starling（第三方 Starling 游戏）AOT 可行性实测（2026-09-26，未占版本号）

**背景**：用户要求把 <https://github.com/Gamua/Flappy-Starling> 克隆进 `examples/`，先按 AIR `adl` 跑通参考，再实测本项目能否 AOT 编译。结论：**adl 已跑通；AOT 编译/链接可通（需补 3 个缺口），运行期渲染在非 1× 内容缩放下仍有缺陷**。

**一、adl 参考跑通（已完成）**——新增 `examples/Flappy-Starling/build-and-run.sh`（沿用其他 demo 的 `AIRSDK_HOME` 自动探测；`mxmlc -source-path=src -library-path+=lib/starling.swc` → `out/flappy.swf`）与根级 `flappy-app.xml`（`<content>out/flappy.swf</content>`、`supportedProfiles` 含 `mobileDevice`、375x667 竖屏、direct + depthAndStencil）。

- **必须 `-profile mobileDevice -screensize iPhone6`**：demo 用 `new ScreenSetup(stage.fullScreenWidth, stage.fullScreenHeight, …)` 定布局；desktop profile 下 `fullScreenWidth/Height` 是真实屏幕（本机 1800x1169），窗口只露出舞台左上角，且 `-screensize` 在 desktop profile 下被拒（`Argument 'screensize' not supported in current profile`）。
- 两个描述符坑：`<content>` 相对**根目录参数**解析，故须写 `out/flappy.swf`（否则 `initial content not found`）；XML 注释里出现 `--`（如写「--air-app」）会让描述符**静默**解析失败（报 `Application does not support current profile`）。
- 截图核对：标题画面（位图字 `Flappy Starling` + 鸟 + TAP + `Current Record: 10`，SharedObject 持久化）与游戏画面（分数、水面/地面）均正确。

**二、AOT 实测：编译与链接可通，运行期有两类问题**

- **面盘点**（`temp/flappy/survey.ts`）：128 个 `.as`（demo 8 个 + Starling 2.7 源码 119 个 + `AGALMiniAssembler`）→ **126 个解析通过、2 个失败**。
- **缺口①（语法）**：命名函数表达式置于实参位（`FlappyStarlingMobile.as:54/58`、`FlappyStarlingWeb.as:26/30`）→ 与下表「命名函数表达式未支持」同一条。
- **缺口②（内建）**：`flash.net.SharedObject`（`Game.as` 存最高分）未实现 → `undefined variable 'SharedObject'`。→ **阶段八十九·四十 已实现**（本地 JSON 后端 + 退出落盘；Flappy 现可端到端构建并运行，见该阶段条目）。
- **缺口③（编译器缺陷，本轮新发现）**：`src/emit.ts` 的 `emitClassRegistry()` 以 `info.constructor.params.length === 0` 判「可无参构造」，于是**全可选参数**的构造器（Starling `TextFormat` 5 个参数、`TextOptions`、`MeshStyle`）注册了 **NULL factory**；Starling 的 `clone()` 走 `Object(this).constructor as Class` + `new actualClass()`（共 5 处）→ 调用 NULL → `PC=0x0` SIGSEGV。定位证据：`-fsanitize=address -g -O0` 重建后拿到完整符号栈 `starling_text_TextField_ctor → Game_start → FlappyStarlingMobile_startGame`，再按步探针收敛到 `TextFormat.clone()`（lldb 无法展开 PC=0 故障，寄存器读不出）。临时绕法（**仅评估用，未改编译器源码**）：三处 `clone()` 改为直接构造具体类型。
- 在 scratch 副本 `temp/flappy-aot/`（`examples/` 与编译器源码均未改动）堵上②③后：**127 个文件全部 codegen 通过并链接为原生 Mach-O（23 MB）**，`Game.start()` 全链路走完（P1–P6/T1–T8 探针全部打印），窗口 375x667 Metal Stage3D 正常创建。
- **运行期问题 A（demo 侧尺寸假设）**：AOT 运行时把 `stage.fullScreenWidth/Height` 报成真实屏幕、`Capabilities.screenDPI=72`（探针 `SB: full=1800x1169 dpi=72`）→ `ScreenSetup` 选 scale 1 → 舞台 1800x1169 而对 375x667 窗口 → 画面整体落在窗外（与 adl desktop profile 同一类问题，AOT 侧没有 `-screensize` 等价物）。给 demo 钉死窗口尺寸后舞台/视口与 adl 等价（探针 `SA: csf=2 vp=750x1334 st=375x667`）。
- **运行期问题 B（渲染缩放，未解决）**：`contentScaleFactor == 1` 时**整屏正确渲染**（标题、鸟、TAP、云、地面、`Current Record` 全对，与 adl 版式一致）；但 `csf == 2`（Starling 常规 HiDPI 视口）时**只见舞台左上 1/4 且放大 2×**（标题只露 `Fla`/`Stan`、鸟偏到下方）。探针实测 `configureBackBuffer req=375x667 best=0 bbScale=1 -> bb=375x667`（Starling 的 `_clippedViewPort` 被原生舞台 375x667 裁掉），且同一轮 `ASC_window_render` 的 Stage3D 合成 blit（`emit.ts:7323`；目标矩形取 `ASC_stage3d_lw/lh`，赋值在 `emit.ts:6137`）**未触发**——即 Metal Stage3D 层是直画 drawable、不受 2D 画布 CTM 管辖，故阶段八十九·十九 定下的口径「`ASC_stage3d_lw/lh` = 逻辑（stage 单位）尺寸 × canvas 设备缩放」在「AS3 侧把**像素**尺寸当逻辑尺寸传给 `configureBackBuffer`」（Starling 的常规做法）时会把设备缩放叠加两次。需单独小阶段查证后修。

**三、用法与产物**：参考侧 `bash examples/Flappy-Starling/build-and-run.sh`（自动起 adl）；AOT 侧 `node src/index.ts --air-app examples/Flappy-Starling/flappy-app.xml --main-class FlappyStarlingMobile -o temp/flappy-native` **缺口① ② ③ 均已补齐（阶段八十九·三十三/三十六/四十）**，127 个 `.as` 可编译+链接并运行；该目录仍按第三方只读参考 demo 的既有约定列入 `test.ts` 的 `SKIP_DIRS`，但理由已从「解析失败」改为「整套 Metal 构建耗时过大」。为让 AOT 能吃到 Starling，`examples/Flappy-Starling/src/` 内已放 Starling 2.7 源码（`starling/`，119 个 `.as`）与 `com/adobe/utils/AGALMiniAssembler.as`——`lib/starling.swc` 只有 mxmlc 能消费，AOT 需要 `.as` 源码。

---

#### 阶段八十九·四十八：`flash.net` 语义面 + `URLLoader` 契约补全（v0.4.3 → v0.4.4）

**缘起**：阶段八十九·四十六 的调研文档 [`docs/zh-cn/flash-net.md`](docs/zh-cn/flash-net.md) 把 `flash.net` 加载面与 AIR 官方 API 逐项对齐后，结论是**分两条**：一条是「**A 语义层补全** + **B `URLLoader` 契约补全**」——零网络依赖、低风险、且能立刻消除「设了 `POST` 却毫无反应」「`close()` 是空函数」这类**误导性**偏差；另一条是「C 起的真 HTTP/TLS 客户端」——独立重工程，取决于是否有真联网用例。本阶段落地**前者**（A/B），**未**触碰任何网络后端（C 之后仍未开始，见遗留表）。

**一、落地内容**

- **`symbols.ts`**：新增三类 + 扩一类——
  - `URLRequestMethod`（`GET`/`POST`/`PUT`/`DELETE`/`HEAD`/`OPTIONS` 六常量）；⚠️ 这里**不能用 `constClass` 辅助函数**——它是 `collect()` 内 `line 1575` 的 `const` 箭头函数，而 `flash.net` 注册段在 `line 1186`，会撞 **TDZ**（`ReferenceError`），故改为内联 `classMap.set`。
  - `URLRequestHeader`（`name`/`value`，构造器默认 `""`/`""`）。
  - `URLRequestDefaults`（7 个 `staticGetters`/`staticSetters`：`authenticate`/`cacheResponse`/`followRedirects`/`idleTimeout`/`manageCookies`/`useCache`/`userAgent`）。
  - `URLRequest` 扩到 **AIR 全属性面**：原 `url`/`method`/`data`/`contentType` **+ 新增** `requestHeaders`/`authenticate`/`cacheResponse`/`followRedirects`/`manageCookies`/`useCache`/`idleTimeout`/`userAgent`/`digest`，并新增实例方法 `useRedirectedURL(sourceRequest, wholeURL=false, pattern=null, replace=null)`；`URLVariables` 的 methods 表补 **`decode(source)`**。
- **`emit.ts`**：`URLRequest_ctor` 从 `URLRequestDefaults_get_*_static(NULL)` 读 6 个默认值（官方口径「initialized from the `URLRequestDefaults.X` property」）；URL 切分助手 `as_url_domain_end`/`as_url_dir_end`；`URLRequest_useRedirectedURL`；`URLRequestDefaults` 静态访问器 + **手写 C 全局量**；`URLLoader_ctor(o, request)`；`URLLoader__finish`；`URLLoader_load`；`URLLoader_close`；`URLVariables_decode`（`URLVariables_ctor` 改为委托它，消除重复解析）。
- **`runtime.ts`**：`as_async_cancel(void* obj)`（紧跟 `as_async_mark_roots`）、`as_user_agent_default()`（紧跟 `as_cap_cpu_arch`，按 `__APPLE__`/`_WIN32`/else 出 Flash/AIR 形状 UA + `AdobeAIR/50.0`）；`emitGCRoots` 增加 `gc_mark_ptr((void*)as_urld_user_agent);`（`userAgent` 是新增字段里**唯一可能持有 GC 字符串**的成员）。

**二、语义要点（都是「防静默错语义」的正面处理）**

- **`contentType` 默认值**：本阶段当时按官方文档把它从 `NULL` 改成 `"application/x-www-form-urlencoded"`。⚠️ **该判断已被阶段八十九·六十九 推翻**：adl 实测属性恒为 `null`，文档那句描述的是**发包默认**；属性已回退为 `NULL`，发包口径另由 `as_http_effective_ctype` 处理。当时「唯一被触碰的旧示例」的说法也不成立——`examples/air-native` 的 `NetUiDemos.as` 并未同步，导致该 demo `--run` 启动即死。
- **`requestHeaders` 默认空 `Array`（有意偏差）**：Adobe 官方示例就是 `request.requestHeaders.push(header)`，为 `NULL` 会让该用法崩，故必须给空数组。
- **`URLRequestDefaults` 用「静态 getter/setter + 手写 C 全局量」而非静态字段**（仿 `SharedObject.defaultObjectEncoding`）：若建模成静态字段，读取要过惰性 `_cinit()` 守卫，而 `URLRequest_ctor` 必须在**任意时机**可靠读到默认值。`userAgent` 全局量又因 `as_user_agent_default()` 是非常量表达式而**不能在文件作用域初始化**，改为 getter 首次读时懒填充。
- **`useRedirectedURL` 按官方文档语义实现**：先按 `wholeURL` 做**域名/整段替换**，再对结果做 `pattern`→`replace`；String `pattern` 走 `as_str_replace`，RegExp 走 `as_v_is_inst(pattern, &RegExp_vt)` + `as_str_replace_regex(..., re->global)`。AIR 实现里「源域名若是目标域名前缀则早退」这类**未被文档化**的细节**不予复制**（已在该文档 §3.1 与源码注释里明说）。
- **`open` 事件放到 `URLLoader__finish` 开头派发**（不是 `load()` 里同步派）：保持异步契约，`load()` 之后注册的监听器仍能收到，且顺序恒为 `open`→`progress`→`complete`。
- **字节计数发布时机**：`bytesLoaded`/`bytesTotal` 在 `progress` **之后**、`complete` **之前**赋值——对齐 AIR「加载中恒 0、完成时才有值」（`progress` 监听器读 loader 仍得 0，应用读 `ProgressEvent.bytesLoaded/bytesTotal`）。
- **`close()` 语义**：真中止在飞 job；**无流时抛 `Error #2029`**（AIR `URLStream` 口径）。`as_async_cancel` 判定「仍活着」的 job 才算可取消——**已 dead 的跳过**：首轮实现把已 dead 的 job 也算「在飞」，导致「前一次 `close()`/后续 `load()` 已终止 → 调用方再 `close()` 抛不出 #2029」这条断言实测失败，改为跳过已 dead 后通过（`AS_JOB_FINISHING` 仍算 found 但不标记：thunk 正在本线程跑，来自自身监听器的重入 `close()`）。
- **`dataFormat=VARIABLES`** 的 `data` 发布为 `URLVariables`（此前该值从不产出 `URLVariables`，是死值）。

**三、验收（全 headless）**

- **新增两条示例**（`test.ts` 自动收录）：
  - `examples/http-request-api.as`（阶段 A）：6 常量 / `URLRequestHeader` / `URLRequest` 默认值 / `requestHeaders.push` / `URLRequestDefaults` 读写 + 构造时读取 + `System.gc()` 后 `userAgent` 仍读回（**GC 永久根**）/ `URLVariables.decode()` 的「值解码、键不解码」不对称 / `useRedirectedURL` 四形态（域名替换、`wholeURL`、String `pattern`、RegExp `pattern`，并断言 **RegExp 在替换之后才作用**）/ null source no-op / source 不被改动。
  - `examples/urlloader-contract.as`（阶段 B）：初始状态 / `URLLoader(request)` 传参即加载且同步不派事件 / `open;progress;complete;` 顺序 / `progress` 中字节计数仍为 0 / `close()` 抑制全部终止事件 / 无流 `close()` 抛 #2029 / `close()` 后可复用 / `VARIABLES` 产出 `URLVariables`（用 `FileStream` 写临时 fixture 后 `deleteFile()`，无残留）。
- **实测证据**：

  | 检查项 | 输出 |
  |---|---|
  | 全量回归 `node test.ts` | **119 passed / 0 failed / 119 total**（A/B 前 117） |
  | 受影响旧示例 | `stage63.as`（断言同步）、`async-io.as`、`air-native/`（含 `NetUiDemos.as`）全部 PASS |
  | WASI | 两条新示例 `--target wasm` 编译通过；`wasmtime --dir=. <wasm>` 运行通过（裸 `wasmtime` 不 preopen CWD 会走 `ioError`，属环境问题——`async-io.as` 同样现象，**非本阶段引入**） |
  | 生成 C | `gc_mark_user_roots` 含 `as_urld_user_agent`、vtable 含 `useRedirectedURL`、`URLLoader_ctor(URLLoader*, URLRequest*)`、`URLVariables_decode` 均在位 |

- **未做**：`securityError` 派发（**有意不做**——本运行时语义下「本机即 AIR 应用沙箱」，不存在会拒绝的源，强行派发会造出 AIR 不会有的假信号；应与 C/D 的跨源/证书失败路径一起落地）；`HTTPStatusEvent` 派发（同理，要有状态行）；反向对照（无网络行为可还原，「反向」等于把字段改回死字段、`close()` 改回空函数，纯倒退无诊断价值；C/D 阶段仍必需）。
- **文档**：[`docs/zh-cn/flash-net.md`](docs/zh-cn/flash-net.md) 的 §3 由「动工前盘点」改写为「实现后状态」（表格逐项标注 A/B 消除的偏差与**剩余** ⚠️，行号按核实真值给出），§5 路线表标 A/B ✅ 并加「状态」列，§6.1 补齐 headless 结果表，头部加「实现状态」注记。

#### 阶段八十九·四十九：`flash.net` G（无网目标诚实 `ioError`）+ C 的 native 竖直探针（v0.4.4 → v0.4.5）

**缘起**：阶段八十九·四十八 落地 A/B 后，遗留表只剩「真正的联网」一项且标注「取决于是否有真联网用例」。本阶段按「**先锁 G、再做 C 探针**」的次序推进：G 无需网络却能消除一处**残余的误导性**（远程 URL 与缺失文件共用同一句错误），C 探针则用**真实代码**而非估计回答「接上 HTTP 客户端是什么形态、代价多大」，把「要不要继续 D→I」这个决策从猜测变成数据。

**一、G：把「无后端」的失败变得可诊断**

- `URLLoader_load` 现在**显式识别** `http://`/`https://`（此前一律当文件路径交给 `fopen`，故「远程 URL」与「文件不存在」报同一句 `URLLoader load failed`）。
- `runtime.ts` 新增 `AS_JOB_HTTP` job 种类与 `AS_JOB_ERR_UNSUPPORTED` 错误码；无后端时由网络 seam 的 `#else` 分支置该错误，`URLLoader__finish` 据此派 `ioError`，文案**点名网络**（`URLLoader: network URLs are not supported in this build (no HTTP backend linked; …)`）。
- 事件仍走既有异步 job 表，故 `open` → `ioError` 的**异步契约不变**（不静默降级、不挂死、`data` 保持 `null`）。

**二、C 探针：native 真 HTTP（opt-in libcurl）**

- 形态是**网络 seam + 条件编译**，不是把库嵌进 `.c`：`#if defined(ASC_HAVE_CURL) && !defined(__wasi__) && !defined(__EMSCRIPTEN__)` 才 `#include <curl/curl.h>` 并走真传输，否则走「诚实失败」分支。
- **后端是 opt-in 的**：只有构建清单声明 `link-libs: ["curl"]` + `defines: ["ASC_HAVE_CURL"]` 才链接，**默认构建保持零依赖、自包含、无网络**（`build.ts` **零改动**，复用既有清单字段）。
- `as_http_run`（worker 线程，阻塞 easy API 正好适配既有 job 池）：`FOLLOWLOCATION`、`CONNECTTIMEOUT 10s`、`TIMEOUT 30s`、`userAgent`、POST body + `Content-Type`；响应体流式收进 malloc 缓冲（**worker 绝不碰 GC 堆**），`CURLINFO_RESPONSE_CODE` 取状态码。
- `URLLoader_load`：GET 把 `data` 折叠进 query（`?`/`&` 自适应），POST 把 `data` 作 body（String / `URLVariables.toString()`，`ByteArray` 体未做）；`URLLoader__finish`：有状态行则先派 `httpStatus`，4xx/5xx 转 `ioError` 且**不派** `complete`（**八十九·五十二 按 `adl` 实测校正**：4xx/5xx 属**成功加载**，派 `complete` 且 `data` 为错误正文；`httpStatus` **只带 `status`**，url/头/`redirected` 归 `httpResponseStatus`；每次加载都以一个 `httpStatus` 收尾，非 HTTP 为 `0`）。
- `curl_global_init` 在 `as_job_publish`（AS3 线程、spawn worker 之前）惰性调用——非线程安全，必须在任何 worker 之前跑。

**三、验收（探针脚本在 `temp/` 不进 `examples/`：需活服务器与 opt-in 后端）**

| 检查项 | 实测输出 |
|---|---|
| GET | `open;httpStatus(200);progress;complete;`，`data` = `hello-from-net` |
| GET + `data` | 服务端收到 `?x=1&y=2`（折叠生效） |
| POST | `httpStatus(200);complete;`，回显 `name=alice&city=paris` |
| 404 | ~~`httpStatus(404);ioError;`，不派 `complete`~~ → **八十九·五十二 校正为 `open;httpResponseStatus(404,…);progress;httpStatus(404);complete;`，`data`=`not found`**（4xx/5xx 是成功加载） |
| binary | `data` 是 `ByteArray`，长度 14 |
| 连接被拒（:9） | `ioError`，不挂死 |
| 真 HTTPS | `open;httpStatus(200);complete;`，559 B `<!doctype html>`（TLS 由系统 libcurl/SecureTransport 代管） |
| G（native + WASI） | `examples/urlloader-network-unsupported.as` 两端 PASS：远程 URL 派可区分 `ioError`、与缺失文件文案**不同**、`data` 为 `null`、本地文件仍能读 |
| 全量回归 | `node test.ts` → **120 passed / 0 failed / 120 total**（A/B 后 119 + 本例 1） |

**四、探针给出的三条硬约束（写入 `flash-net.md` §4.1.2）**

1. **自包含被打破**：`otool -L` → `/usr/lib/libcurl.4.dylib`（动态链接系统库）。要自包含须走「路线二」（`build-tools/` 自编 → `vendor/`）。
2. **同一份清单无法跨目标**：`link-libs` **不按目标条件**，把探针清单喂给 wasm 直接 `wasm-ld: unable to find library -lcurl`。→ 任何联网落地都先要在构建层解决「按目标分层链接」。
3. **好在生成的 C 是同一份**：分叉只在 `-D ASC_HAVE_CURL`——同一份 `temp/netprobe.c` 不加宏编译即退回诚实 `ioError`（已实测），故「有无网络」不产生两套生成器。

**五、未做（诚实边界）**：web `fetch`（E）、`URLStream` 流式 job（F）、`navigateToURL`/`sendToURL`（H）、chunked 进度与响应头解析（`responseHeaders`/`responseURL` 仍空、`redirected` 未建模）、代理/cookie/HTTP2、静态自包含打包、与 `mxmlc + adl` 的基线对照。`securityError` 仍不派（没有会拒绝的源）。

**文档同步**：[`docs/zh-cn/flash-net.md`](docs/zh-cn/flash-net.md) §4.1.2 加探针实测表、§5 路线表 C/D 标 ⚗️ 且 G 标 ✅、§6.2 改写为「已执行」含数据表与复现命令、§6.3 记为 native+WASI 已验、§8 用实测替代粗估；`README-CN.md` `flash.net` 段与版本同步。版本号 v0.4.4 → **v0.4.5**。

#### 阶段八十九·五十：构建清单「按目标分层链接」（`targets`）（v0.4.5 → v0.4.6）

**缘起**：阶段八十九·四十九 的 C 探针实测出一条硬约束——**`link-libs` 不按目标条件**，同一份清单喂 wasm 直接 `wasm-ld: unable to find library -lcurl`。这使得「要联网的工程」要么为每个目标维护一份清单（现状：`starling-native.build.json` 与 `timer-web.build.json` 就是这样两份），要么先给构建层加「按目标分层链接」的能力。本阶段落地后者，解除 D→I 的构建层前置。

**一、清单 schema：`targets` 覆盖块（replace 语义）**

- 顶层字段 = **公共默认**；新增 `targets.<native|wasm>` 块，**只对匹配的目标生效**，并把块内声明的字段**整体替换**（replace，而非追加）同名顶层值。
- **为何是 replace 而非 append**：只有 replace 能**双向**调整——既能给某目标**加**库，也能**减**库（append 只能加，无法把顶层共享的 `-lcurl` 从 wasm 剔除）。
- 可选择目标仅 `native`/`wasm`，**未知目标名报错**；块内**不允许** `target`/`package`（目标由选择它的块决定，不可重定义）或嵌套 `targets`；块内**未知字段报错**（AGENTS.md §2.5）。块内路径类字段与顶层一样**相对清单目录解析**。

**二、接入点与顺序**

- `build.ts` 新增 `applyManifestOverlay(cfg, m, manifestPath, target)`；`Manifest` 拆出 `ManifestFields` + `TargetLayer`（`Omit<ManifestFields,'target'|'package'>`）+ `TARGET_LAYER_FIELDS` 白名单。
- `index.ts` 把已加载清单保留到基础合并之后，**在 CLI 覆盖之前**按**最终目标**（`--target` 可改变它）应用覆盖块——故「CLI beats 清单」不变（实测：`-l extra -D CLI_ONLY` 与分层结果**叠加**而非被吃掉）。
- 合并顺序：默认配置 → 清单顶层 → 清单 `targets.<最终目标>` → CLI 覆盖。

**三、验收**

| 检查项 | 结果 |
|---|---|
| `test.ts` 分层断言 | **新增 16 条独立计数的 `[manifest]` 检查全过**（不并入示例计数）：一份清单 native 链接 curl / wasm 不链接；replace 增删；CLI 叠加；路径解析与跨目标不泄漏；未知目标名 / 嵌套 `targets` / 块内 `target` / 未知字段四项均**报错** |
| 同一份清单 native 真链接 | `examples/flash-net-layered.build.example.json` → `otool -L` 含 `/usr/lib/libcurl.4.dylib`，`examples/hello.as` 运行正确 |
| 同一份清单 wasm 真链接 | 同清单 `--target wasm -o temp/layer-wasm` 链接命令**无 `-lcurl`/`-D ASC_HAVE_CURL`**，`wasmtime --dir=.` 运行与 native **逐行一致**；`strings <wasm>` 命 `curl` = **0** |
| `--dry` 分叉 | native `cc … -D ASC_HAVE_CURL -l curl`；wasm `clang --target=wasm32-wasip1 …`（两者皆无 curl） |
| 全量回归 | `node test.ts` → **121 passed / 0 failed / 121 total** + **16/16 分层检查** |

**四、计数更正**：本阶段**未新增 `examples/*.as`**（构建层改动，断言写在 `test.ts`）。实测 121 与阶段八十九·四十九 记录的 120 差 1，差额来自 `examples/url-test/`（未被该条目计入）——本阶段以 **121** 为准。

**五、未做（诚实边界）**：覆盖块目前只按 `target` 键（未按 `package` 维度）；`link-libs` 的库名仍须显式拼写（不做库存在性探测）；`--air-app` 生成清单仍是单目标、未自动写 `targets` 块（其分叉仍在生成器内按 `web` 标志完成）。

**文档同步**：[`compile.md`](docs/zh-cn/compile.md) §4 清单表加 `targets` 行 + 新增 **§4.1 按目标分层**（示例 + 规则 + 合并顺序），§5 加跨目标提示；[`flash-net.md`](docs/zh-cn/flash-net.md) 头部注记、§4.1.2、§5 路线表（新增「C 前置：按目标分层链接 ✅」行）、§6.3、§8 同步为「构建层前置已完成」；`README-CN.md` 清单段与版本；`package.json` v0.4.5 → **v0.4.6**。

---

#### 阶段八十九·五十一：`flash.net` 后端全铺（C 内核补全 + D/E/F/H）（v0.4.6 → v0.4.7）

**缘起**：阶段八十九·四十九/五十 已证明「opt-in libcurl 真传输」可行、并解除了跨目标链接约束。本阶段把路线图 **C（内核补全）+ D（URLLoader 全契约）+ E（web `fetch`）+ F（`URLStream` 流式）+ H（`navigateToURL`/`sendToURL`）** 一次性落地。

**一、C：libcurl 内核补全**（`runtime.ts`）

- `as_job` 新增 `request_headers`/`follow_redirects`/`idle_timeout`/`headers`+`headers_len`/`eff_url`/`redirected`/`expected_total`/`marks`+`mark_count`+`mark_cap`。
- 新增 `ASC_HTTP_BACKEND` 块：`as_http_run`/`as_http_stream_run`、`as_http_on_header`（头区累积）、`as_http_on_data`（字节 + 水位）、`as_http_sink`/`as_http_ctx`。覆盖**全部动词**（`HEAD`→`NOBODY`）、`followRedirects`（`CURLOPT_FOLLOWLOCATION` 或 3xx 手动停止）、`idleTimeout`→低速限制对（`LOW_SPEED_LIMIT/TIME`）、`Content-Length`→`expected_total`、`CURLINFO_EFFECTIVE_URL`→`eff_url`、重定向计数。
- `as_async_submit_http` 扩到 12 参；新增访问器 `as_job_headers`/`as_job_eff_url`/`as_job_redirected`/`as_job_expected_total`/`as_job_mark_count`/`as_job_mark`。

**二、D：`URLLoader` 全契约**（`symbols.ts`/`emit.ts`）——`http(s)://` 走网络、`file://`/相对路径仍走 `fopen`；GET 折叠 `data` 进 query、POST/PUT 进体；`method`/`contentType`/`userAgent`/`requestHeaders` 全消费。详见 `flash-net.md` §6.4。

**三、E：web `fetch` 后端**（`runtime.ts` EM_JS + 生成 `index.html`）——拉取/泵模型：`as_web_fetch_go` 启动 `fetch()`、把分块与终态压入 `globalThis.__ascHttpQ`，`as_web_fetch_pump()` 在 `as_async_tick` 顶部抽干；job 身份用 `(指针, serial)` 防 ABA；`err_text` 把浏览器失败文案（点名 CORS）送达 `ioError`。`ASC_HAVE_FETCH` opt-in。

**四、F：`URLStream` 流式**（新增 job kind `AS_JOB_HTTP_STREAM`）——增量 `bytesAvailable` + 13 个非阻塞 `read*`（缺 `readObject`）+ `EOFError #2030`、`close()` 真中止；完成时把未读尾巴拷进 GC `ByteArray`（`_buf`）再派终态事件。新增 `tickFrame()` 非阻塞泵供测试。

**五、H：`navigateToURL`/`sendToURL`**（`runtime.ts as_open_external` + `emit.ts URLRequest__navigate`）——native `fork`+`exec`（**单 argv、不经 shell**，URL 是应用输入，进 shell 即命令注入洞；`ASC_OPEN_LAUNCHER` 作测试 seam）、web `window.open`、WASI 诚实报 `#2032`。

**六、验收**（探针在 `temp/`，见 `flash-net.md` §6.2–§6.6）

| 检查项 | 结果 |
|---|---|
| C/D native | `temp/netprobe2.as` → `phase C/D assertions passed`（全部动词/响应头/重定向/chunked 进度/本地文件/传输失败） |
| F native | `temp/netprobe3.as` → `phase F assertions passed`（`/drip` 768 B 分 6 批、时间跳度 744 ms） |
| H native | `temp/netprobe4.as` → `phase H assertions passed`；`ASC_OPEN_LAUNCHER` 逐字收到 5 条 argv，含 `'http://…/a; b$(id) && echo pwned'` **原样**（无注入） |
| H WASI | `temp/wasi-nav.as` → 无启动器环境如实报 `#2032` |
| E web | `temp/webprobe.as` → `webprobe: DONE`（三通道一致：`/result` 文件 + `window.__ascStdout` + `window.open` 记录器）；反向对照（去 `ASC_HAVE_FETCH`）诚实 `ioError` |

**七、踩坑（已固化进文档）**：`RUNTIME_PREAMBLE` 是 TS 模板串（反引号/`\r\n` 需双转义）；**EM_JS 体按 C 预处理器 token 解析**（空 JS 串 `''` 是非法 pp-token，用 `""`）；**EM_ASM 不得调 Emscripten JS 库函数**（`stringToUTF8` 等只在被编译 C 调用时才链入，从 EM_ASM 摸是 `ReferenceError`，改用 `TextEncoder`+`HEAPU8.set`）；**web 上 `showWindow` 之后的语句永不执行**（`emscripten_set_main_loop(…, simulateInfiniteLoop)` 抛 `unwind` 哨兵穿透 `main`）；单线程 `HTTPServer` + HTTP/1.1 keep-alive 会与浏览器的并行连接死锁（改 `ThreadingHTTPServer`）。

**文档同步**：`flash-net.md` §3.1/§3.2/§3.3/§5/§6.3–§6.6/§6.8；`html5-web.md` §3.4（fetch + 帧边界泵）、§3.5（`window.__ascStdout`/`__ascStderr`/`__ascErrors`）、§5.4、§6 第 10/11 项；`compile.md` §3.4.1（opt-in 宏 + `targets` 覆盖示例 + 动态 libcurl 注意）；`README-CN.md` `flash.net` 段。`package.json` v0.4.6 → **v0.4.7**。

#### 阶段八十九·五十二：AIR 语义保真校正 + 端到端验收（I）（v0.4.7 → v0.4.8）

**缘起**：D/E/F/H 落地后，探针写下的「期望值」来自**文档转述**，而 `flash-net.md` 的立文原则是「以参考实现为准」。本阶段用 `mxmlc`（参考编译器）+ `adl`（参考运行时）写 9 个 AIR 探针（`temp/air-probe/`），把每个可观测语义钉到实测，并修正我方走偏处。

**一、`adl` 实测得出的权威语义**（与我方原实现不一致的三处）

1. **4xx/5xx 是成功加载**。原设计（源自文档误读）把 404 转 `ioError`。实测：`404 → open;httpResponseStatus(404,url,hdrs);progress(9/9);httpStatus(404);complete; data="not found"`。`ioError` 只用于**传输失败**（拒连/DNS/TLS/CORS）。
2. **`httpStatus` 只带 `status`**。实测其 `responseURL=null`、`responseHeaders` 为空数组、`redirected=false`；url/头/`redirected` 全在 `httpResponseStatus` 上。**每次加载都以一个 `httpStatus` 收尾**（非 HTTP/本地文件为 `0`）。
3. **失败后 `data` 为空值而非 `null`**（`text`→空 `String`，`binary`→空 `ByteArray`）。

另实测：`URLStream` 未打开时 `bytesAvailable`/`close()`/`read*` 一律抛 **`#2029`**（“This URLStream object does not have a stream opened.”）；完成/失败后 `connected` 仍为 `true`、需 `close()` 才为 `false`（失败后 `read*` 为 `EOFError #2030`——「开了但空」）；参数校验为两个不同的 **`TypeError #2007`**（`Parameter request/url must be non-null.`）；`URLLoader.close()` 无流时文案与 `URLStream` 同字。

**二、代码修正**（`emit.ts`，`runtime.ts` 侧）。`URLLoader__finish` 重构为 AIR 序（`open`（仅 `started`）→ [`httpResponseStatus` 仅 `status>0`] → 重放 `progress` → 末次 `progress` → `data` → `httpStatus` → `complete`；失败：`httpStatus(0)` → 空 `data` → `ioError`）；拆出 `URLLoader__httpStatusEvent`（仅 status）/`__httpResponseEvent`（全载荷）；`as_job` 新增 `started`（仅在请求真的到达传输时置位）；`URLStream__load/close/getters` 与 `URLLoader_load` 全部按上述语义重写。

**三、端到端验收（I）**：真实 `examples/url-test`（标签编码登录 POST + 统计 GET）在 `mxmlc + adl` 与本项目 `--air-app --run` 下各跑一次。两侧**登录 POST + 统计 GET 逐项一致**，统计响应 `{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}` **逐字节相同**（实测记录见 `flash-net.md` §6.7.1）。反向对照（默认构建无后端）：第一处登录即落诚实 `ioError`，不假数据、不挂起。

| 检查项 | 结果 |
|---|---|
| 全量回归 | `node test.ts` → **122 passed / 0 failed / 122 total** + **16/16** `[manifest]` |
| native 探针重跑 | `netprobe2`（C/D）/`netprobe3`（F）/`netprobe4`（H）全绿；`netprobe.as`/`netprobe_https.as` 旧断言已按新语义改正 |
| web/WASI | `webprobe` → `checks=15 failures=0` + 反向对照；`wasi-nav` → `#2032` |
| 受影响示例 | `urlstream-api.as`/`urlloader-contract.as`/`urlloader-network-unsupported.as`/`async-io.as`/`stage63.as` 均按 AIR 形状（失败后 `data` 空值非 `null`）改正后全绿 |

**四、`adl` 环境踩坑**：`adl` 吞 `trace()`、`File.applicationStorageDirectory` 在此环境不可写（探针一律 `FileStream.open()` **绝对路径**）；macOS 26 上 AIRSDK **51.4.1 的 `adl` 能跑但不起窗口**（Quartz 窗口列表为空），改用 **51.3.4** 后正常；对本项目产物为读 stdout `trace`，需用 **pty**（`script -q /dev/null …`）使 stdout 行缓冲，否则 `SIGKILL` 会丢掉尾部输出。

**文档同步**：`flash-net.md` 头部注记、§3.1、§5 路线表（D/E 语义校正、I 标 ✅、新增「八十九·五十二」序号）、§6.2–§6.5 旧语义勘正、**§6.7 改写为实测对照表 + §6.7.1 填满**（两侧日志并列）；`README-CN.md` `flash.net` 段与示例说明。`package.json` v0.4.7 → **v0.4.8**。

---

#### 阶段八十九·五十三：静态自包含 + 代理/cookie/HTTP-2 + `flash.net` 套接字层（v0.4.8 → v0.4.9）

**依据**：遗留表 `flash.net` 剩余重工程行里的前 3 项——**静态自包含**、**代理 / cookie jar / HTTP-2**、
**socket/TLS 之上的其它协议**。第 4 项（preview2 `wasi:http`）本轮只做可行性侦察，结论见下表新行。
**收尾三件套**：新增 `examples/socket.as` + 全量回归（`node test.ts` → **124 passed, 0 failed**，
自 123 增至 124）+ 版本号 v0.4.8 → **v0.4.9**。

**一、静态自包含（`vendor/curl`）**

- 源码与脚本：`build-tools/curl-src/build-static.sh`（curl **8.11.1** + nghttp2 **1.64.0** + zlib **1.3.1**；
  nghttp2 必须 `-DENABLE_TESTS=OFF -DBUILD_TESTING=OFF`，否则因测试目标缺组件而失败）。
- 产物：`vendor/curl/{include/curl/*.h, lib/macos-arm64/{libcurl.a,libnghttp2.a,libz.a}, LICENSE.*, README.md}`
  （`vendor/` 只放预编译产物，**可编译源码在 `build-tools/`**——与 Skia 同一约定）。
- 构建层新增 **`--framework <name>`** CLI 标志（刻意不叫 `-F`：clang 的 `-F` 是**搜索路径**，语义不同）
  与清单 `frameworks` 字段，补齐静态 curl 需要的 `CoreFoundation`/`CoreServices`/`Security`/`SystemConfiguration`。
- 验收：`examples/url-test` 输出与动态链接版**逐字节一致**；`otool -L` 里**不再**出现
  `libcurl.4.dylib`/`libz.dylib`（静态命中靠库搜索路径顺序，`libz.a` 与系统 `libz` 同名）。
  残留 `ld: warning: ignoring duplicate libraries: '-lz'` 是 clang 提示，无副作用，未处理。
- **实测更正了阶段八十九·四十九的结论**：那里「自包含性 ❌ 被打破（`/usr/lib/libcurl.4.dylib`）」
  是**动态链接**形态的结论，静态形态下已不成立（[`flash-net.md`](docs/zh-cn/flash-net.md) §4.1 已按此改写）。

**二、代理 / cookie jar / HTTP-2**

- **cookie jar**：进程级 `CURLSH`（`CURL_LOCK_DATA_COOKIE` + `pthread_once` 创建，配
  `CURLSHOPT_LOCKFUNC`/`UNLOCKFUNC`），每次传输 `CURLOPT_SHARE` + `CURLOPT_COOKIEFILE ""`，
  由 `URLRequest.manageCookies`（AIR 默认 `true`）开关；`as_async_submit_http*` 两条入口都透传。
- **代理两路**：① 环境变量（`http_proxy`/`https_proxy`/`all_proxy`，libcurl 原生消费）——seam 在检测到
  任一变量时**主动跳过**系统代理查询，避免两套设定互相覆盖；② **系统代理**（macOS
  `SCDynamicStoreCopyProxies`，受 `ASC_SYSTEM_PROXY` 门控）。
- **系统代理必须独立编译单元**（本轮最重要的构建层发现）：`<SystemConfiguration/SystemConfiguration.h>`
  会牵入 `MacTypes.h`，其中有 `struct Point` —— 与生成 C 里 `flash.geom.Point` 的 `struct Point`
  **硬重定义冲突**（无条件编译错误，不是警告）。故系统调用落在 `vendor/sysproxy_glue.c`，暴露纯 C
  `int as_sysproxy_get(const char* url, char* proxy, int proxy_cap, char* noproxy, int noproxy_cap)`，
  生成 C 只保留 `extern` 声明；为此新增 **`--source <f>`** CLI 标志（可重复，编译并链接附加 C 源）。
- **HTTP/2**：`ASC_HTTP2` → `CURL_HTTP_VERSION_2TLS`；**默认钉 `CURL_HTTP_VERSION_1_1`**。这是**保真选择**
  而非保守：h2 会规范化响应头名并省略连接级头，对 AS3 侧可见（AIR 的传输本就是 HTTP/1.1）。
- 验收（本机实测）：glue 输出与 `scutil --proxy` 逐项一致；端到端 `http://example.invalid/` 在
  `ASC_SYSTEM_PROXY` **开**时 `httpStatus(502); complete;`（代理应答），**关**时 `httpStatus(0); ioError;`；
  `http_proxy=http://127.0.0.1:8792` 时探针得 `PROXIED`；AS3 侧读到默认 `negotiated=http/1.1`、加 `-D ASC_HTTP2` 后 `http/2`。
- 连带修掉两处**生成 C 的模板字面量**缺陷（都是本项后端代码暴露出来的）：注释里的反引号会**提前终止**
  `RUNTIME_PREAMBLE` 的 TS 模板字面量；`'\0'` 必须双写，否则 C 里成了真正的 NUL 而**截断字符串**。

**三、`flash.net` 套接字层（`Socket` / `ServerSocket` / `XMLSocket` / `SecureSocket`）**

- **语义来源**：`mxmlc + adl` 实测（探针 `temp/air-probe/Probe11.as` → `air-probe11-result.txt`），
  逐条对齐后才编码（AGENTS.md §2.4）。完整实测表见 [`flash-net.md`](docs/zh-cn/flash-net.md) §7.2。
- **运行时底座**（`src/runtime.ts`）：`as_sock` 注册表 + 非阻塞泵，**在帧边界轮询一次**
  （`as_async_tick_with(wait_ms)` → `as_sock_pump()` + `as_sock_dispatch()`），与 AIR「一切都在帧间派发」
  同构：无每连接线程、无锁、无跨线程交接，且**直接映射 WASI preview2 的 pollable 模型**。
  `as_sock` 是 `malloc` 的（非 GC 对象），其 AS3 对象经 `as_sock_mark_roots()` 注册为**永久 GC 根**。
- **事件顺序**：`CONNECT → ACCEPT → DATA → OUTPUT → ERROR → CLOSE`（DATA 在 CLOSE 前，保证最后一块仍可读）；
  派发前置位「先清标志再派发」，故重入的 tick 不会重放。
- **语义要点**（每条都有实测依据）：`#2002`（无效 socket）与 `#2030`（数据不足）**严格区分**；
  `connect()` 参数错误抛 `TypeError #1009`/`SecurityError #2003`，连接失败**不抛**而是派 `ioError`
  （`errorID=2031`，文案只带 host）；`XMLSocket.send` **自加 NUL 终止符并立即 flush**（`Socket` 则缓冲到 `flush()`）；
  `bind()`/`listen()`/`close()` 后的状态与再 `listen()` 的 `#2002`、同对象可重连均按实测实现。
- **本子集唯一的增补**：`ServerSocket.accept()`（AIR 无此方法）——两条路**每个对端只交付一次**
  （`accept()` 取走时清掉该连接的事件位）。
- **`SecureSocket` 不假装**（AGENTS.md §2.5）：TLS 状态机未实现，故 `isSupported` 恒 `false`、
  `connect()` 派实测文案的 `#2031`，**绝不静默明文连接**。缺口记入下表。
- 新增/扩展的 AS3 面：`IOError`（`flash.errors`）、`ServerSocketConnectEvent`、`OutputProgressEvent`、
  `ProgressEvent.SOCKET_DATA`、`Socket` 的完整 `IDataInput`/`IDataOutput` 与 13 个属性。
- 验收：`examples/socket.as`（**自包含环回**，`ServerSocket.bind(0)`，不依赖外部服务器；断言清单见
  `flash-net.md` §7.4），并入 `test.ts`（124 项）。
- 排查中另确认一条**本子集的固有边界**（写进示例注释与文档）：String 是 NUL 结尾的 C 字符串，
  故 `XMLSocket` 自动追加的终止 NUL **不能经 `readUTFBytes` 观测**（`readUTFBytes(6)` 里第 6 个字节是 NUL，
  得到的 C 串长度仍是 5）——示例改为「payload 与终止字节**分两次读**」再断言。

**四、preview2 `wasi:http`（本轮只做侦察，未实现）**——结论见下表新行。

---

#### 阶段八十九·五十四：`Loader.load` 的 `http(s)` 图片加载 + 两处真错修复（v0.4.9 → v0.4.10）

**依据**：真实 AIR 应用 `examples/url-test` 要加载两张互联网 PNG（`meeting.talkmed.com/img/*.png`）
并上屏——探路时发现 `Loader.load` 的 `http(s)` 路径**从未接过后端**：`Loader_load` 只发
`AS_JOB_IMAGE`，URL 被当**本地路径**去 `fopen`（阶段八十九·五十三 把传输 seam 接到了 `URLLoader`，
图片侧漏了）。这是**功能缺失**，不是语义错——但它必须被正面补齐而不是绕过（AGENTS.md §0）。
**收尾三件套**：新增 `examples/loader-url.as` + 全量回归（`node test.ts` → **125 passed, 0 failed**，
自 124 增至 125）与新增的 **10 条 `[lexer]` 诊断** + 版本号 v0.4.9 → **v0.4.10**。

**一、`Loader.load` 的 `http(s)` 图片（复用同一条传输 seam，零新后端）**

- 运行时（`src/runtime.ts`）：新增 job kind **`AS_JOB_IMAGE_URL`**（`9`）与提交分流
  `as_async_submit_image(obj, finish, url)`——按 `as_job_is_remote_url()`（`http://` / `https://` 前缀）
  选 kind，并置 `follow_redirects`/`manage_cookies`（与 `URLLoader` 同口径）。URL 分支在 **worker**
  上调用**同一个** `as_http_perform`（native `ASC_HAVE_CURL` / web `ASC_HAVE_FETCH`）；无后端则
  `AS_JOB_ERR_UNSUPPORTED`，由 `as_job_error_text` 给出**点名缺传输**的文案（与「文件不存在」可区分）。
  本地路径**一字未改**（仍是 `AS_JOB_IMAGE` = 读文件 + 解码）。`as_job_run` 把三种 kind 合并到同一段
  解码逻辑，只多一个 `keep_encoded` 开关。
- **编码字节必须活到 finish thunk**（`keep_encoded = 1`）：展示用的 SkImage 是 **deferred**（惰性）包装，
  而 job 缓冲在 `as_job_retire()` 就释放——延迟解码会踩到已 free 的内存。故 `vendor/skia_glue.cc` 新增
  `sk_image_from_bytes()`，用 `SkData::MakeWithCopy` 拷一份再 `SkImages::DeferredFromEncodedData`。
  这份拷贝**不是冗余**，是把所有权从 job 移到 SkImage。
- emit 侧（`src/emit.ts`）：`Loader_load` → `as_async_submit_image`；`Loader__imageFinish` 优先用
  `as_job_bytes/as_job_len` 建图，无 payload 才回落到 `as_skia_image_from_file(li->url)`（payload 是
  更具体的答案）。事件契约**完全不变**：`INIT` 同步、`COMPLETE`/`IO_ERROR` 在下一帧边界。
- 构建层**零改动**：沿用阶段八十九·五十三 的静态 curl（`-l curl -l nghttp2` +
  `-I/-L vendor/curl/...` + `--framework Security --framework SystemConfiguration`）。

**二、真错 1：`Loader` 的内容从不入 children（日志全对、一个像素都不画）**

只把 `Bitmap` 填进 `loader.content` 时，**尺寸/`bytesTotal`/`COMPLETE`/stdout 全部正确**，而屏幕上
什么都没有——渲染器沿**容器的 children** 走，`content` 只是个字段。AIR 的口径是
`loader.numChildren == 1` 且 `content.parent == loader`（`Loader` 是 `DisplayObjectContainer`）。
修法：`DisplayObjectContainer_addChildAt((void*)o, (DisplayObject*)bmp, 0)`（`Loader_unload` 对应移除），
顺带让内容真正拿到 `addedToStage`。**这是本轮最贵的一个错**：它同时解释了「AOT 侧是个空窗口、
两侧日志却逐字相同」。

**三、真错 2：块注释会嵌套（注释里的 `/*` 吞掉余下源码）**

`examples/url-test/src/Main.as` 的文档注释里写了 `img/*.png`，`lexer.ts` 把它当成**嵌套块注释**的
开始，把**文件剩下的全部源码**吞进注释——报错因此落在别处（`Parse error at 223:2`），完全指不到真因。
AS3（同 ES3/ES4）的块注释**不嵌套**：`mxmlc` 实测接受注释里的 `/*`，且注释在第一个 `*/` 结束。
修法：不嵌套 + **未闭合块注释报 `LexError`**（此前会静默吞到文件尾，是「编译过但结果错」的同族）。
回归：`test.ts` 新增 `checkLexerDiagnostics()`（10 条 `[lexer]` 断言：不嵌套、只在首个 `*/` 结束、
`//` / 字符串 / 正则里的 `/*` 都不是注释、以及未闭合**确实报错**的反向对照）——「必须报错」是**编译**
行为，而示例套件只跑「必须成功」的程序，故放在 harness 层（与 `[manifest]` 同范式）。

**四、验收（`mxmlc + adl` 对照 + 反向对照）**

- 同一份 `Main.as` 两侧各跑一次：`bytesTotal` **487042 / 511484**、解码 **753×751 / 815×814**、
  缩到 340 宽（**340×339 / 340×340**）、定位 **(10,60) / (370,60)** —— **逐项相同**；截图
  `temp/out/adl-urltest-merged.png`（adl）与 `temp/out/aot-urltest.png`（AOT）。实测记录见
  [`flash-net.md`](docs/zh-cn/flash-net.md) §6.7.2。
- 反向对照（默认构建，无 `ASC_HAVE_CURL`）：远程 URL 报**可区分**的诚实 `ioError`，从不与
  「文件不存在」共用文案——钉在新增的 `examples/loader-url.as`（远程两 scheme / 本地不可解码 /
  本地不存在 四种诊断各归其位，失败加载不发布 `content` 也不留子对象）。

**文档同步**：[`flash-net.md`](docs/zh-cn/flash-net.md)（§3.1 新增 `Loader.load` 行、§3.3 总结、
§5 表外后续、§6.7 对照两行 + 新 §6.7.2 实测）、`README-CN.md`（`Loader` 条目、`flash.display`
限制条目、示例清单）。`package.json` v0.4.9 → **v0.4.10**。

---

#### 阶段八十九·五十五：`--air-app` 自动挂载网络传输（v0.4.10 → v0.4.11）

**依据**：按「用户能直接敲的命令」交付阶段八十九·五十四 的产物时暴露的**构建层**缺口——
`node src/index.ts --air-app ./url-test-app.xml --main-class Main --target native --run` 跑起来
**网络访问全部 `ioError`**。运行时没错（远程 URL 走的是同一条 seam），错在**清单**：
`ASC_HAVE_CURL` 是 opt-in 宏（阶段八十九·四十九 的既定设计），此前只能由**手写 CLI 参数**
（`-I/-L vendor/curl/… -l curl -l nghttp2 -D ASC_HAVE_CURL --framework Security
--framework SystemConfiguration`）提供。而 `--air-app` **每次运行都重写 `<filename>.build.json`**
（`air-app.ts` 的 `writeFileSync`），所以「手工把参数写进清单」这条路**活不过下一次构建**
（实测：改完再跑 `--dry`，清单 md5 回到未含 curl 的版本）——链接集必须由**生成器本人**给出。
这是「功能缺失」而非语义错，按 AGENTS.md §0 正面补齐。

**一、探测：`detectNetworking(asFiles)`（与 `detectStage3D` 同形态）**

构建层**扫 app 自己的源码**决定挂哪个后端，零配置：命中 **`URLRequest`** 即认为该 app 会联网。
判据之所以是它而不是 `import flash.net.*`：AS3 里**每条**走 HTTP seam 的路径都必然先构造一个
`URLRequest`（`URLLoader.load` / `URLStream.load` / 远程 `Loader.load` / `navigateToURL`），
而 `flash.net` 包还装着 `SharedObject`/`FileReference`/`LocalConnection`——按包名匹配会冤枉
「只想用本地存储」的 app：白白多链 1.4 MB 静态 curl，并在本机没建 `vendor/curl` 时把它硬报错卡住。
同样**不是**判据的：`Socket`/`XMLSocket`（走 `ASC_SOCK_POSIX`，与 HTTP 后端无关）、
`NetConnection`/`NetStream`（RTMP 在此无后端）。未命中的 AIR 项目保持**零依赖默认形态**
（不因这次改动平白多链一个 1.4 MB 的静态 curl）。

**二、两条支路（native 静态自包含 / web `fetch`）**

- **native**：清单追加 `vendor/curl/include` + `vendor/curl/lib/macos-arm64` + `-l curl -l nghttp2`
  + `Security`/`SystemConfiguration`，并定义 `ASC_HAVE_CURL=1`。刻意指向阶段八十九·五十三 的
  **静态** `vendor/curl`（而不是系统 libcurl）：否则产物会重新依赖 `libcurl.4.dylib`，
  破坏「单文件自包含」这条既有验收口径。
- **web**（`--target wasm --package web`）：定义 `ASC_HAVE_FETCH=1`（浏览器里唯一可用的 HTTP
  客户端就是页面自己的 `fetch()`，`src/runtime.ts` 的 `ASC_HTTP_WEB` 后端）。**两边都不改生成的 C**——
  `http(s)://` 的识别与 job 表提交是同一份代码，分叉只在宏上，这正是阶段八十九·四十九 把传输
  做成 seam 的收益。

**三、`vendor/curl` 缺失时不静默退化**

联网 app + native 目标 + `vendor/curl/include/curl/curl.h` 不存在 → 立即 `AirAppError`，
**点名**期望路径与修法（`build-tools/curl-src/build-static.sh`）。这比让 clang 报一句
`'curl/curl.h' file not found`（指向用户从未写过的路径）可定位得多，是 §2.5 在**构建层**的重申。

**四、验收（用户的原始命令，一个额外参数都不加）**

```bash
node ../../src/index.ts --air-app ./url-test-app.xml --main-class Main --target native --run
```

- 生成的清单自动带上 `ASC_HAVE_CURL=1` + `-l curl -l nghttp2` + `Security`/`SystemConfiguration`
  （与阶段八十九·五十四 里手敲的 CLI 参数**逐项等价**）；
- 实测**登录 POST + 统计 GET + 两张 PNG 全部成功**：`bytesTotal` **487042 / 511484**、解码
  **753×751 / 815×814** → 缩到 340 宽（**340×339 / 340×340**）、定位 **(10,60) / (370,60)**，
  与 `mxmlc + adl` 侧逐项相同；截图 `temp/out/aot-autocurl.png`（帧首 `FPS:120 … RUNTIME:AS-AOT`，
  两张图并排在上、下面是对应的 `TextField` 日志）。实测记录见
  [`flash-net.md`](docs/zh-cn/flash-net.md) §6.7.3。
- **回归**：`test.ts` 新增 `checkAirAppTransport()`（**10 条 `[air-app]` 断言**，fixture 写在
  `temp/air-app-transport/`——描述符 + `src/` 是**适配器的输入**而非 AS3 程序，放进 `examples/`
  会被示例套件当单元编译并运行）：联网 app 的 native 清单必须含 curl/nghttp2/交叉路径/两个 framework；
  同 app 的 web 清单必须**换成** `ASC_HAVE_FETCH=1` 且**不含** curl（`wasm-ld` 找不到 `-lcurl`）；
  **反向对照**：不碰网络的 app 不得被塞进 curl——该 fixture **特地** `import flash.net.SharedObject`，
  把「按包名匹配」这个错解钉死。

**文档同步**：[`compile.md`](docs/zh-cn/compile.md)（§3.4.1 补「`--air-app` 例外：自动挂载」、
§3.5 流程补网络自动挂载一段）、[`flash-net.md`](docs/zh-cn/flash-net.md)（§6.7.1/§6.7.2 命令简化 + 新 §6.7.3）、
`README-CN.md`（`--air-app` 条目）。`package.json` v0.4.10 → **v0.4.11**。

---

#### 阶段八十九·五十六：web 后端的两处真缺口 + 浏览器同源边界（v0.4.11 → v0.4.12）

**依据**：阶段八十九·五十四/五十五 的验收全在 native 与 `adl` 上做；用户在**浏览器**里跑同一份
`examples/url-test`（`--air-app … --target wasm --package web`）看到的却是：登录被服务端驳回、
两张图**一个字节都没下**就报错。两处都是真的缺口，且都失败得**像应用自己的 bug**。

**一、web 后端丢掉了 `URLRequest.contentType`**

native 的 `as_http_perform` 把它变成 `Content-Type:` 头发出去；web 的 `as_web_fetch_go` **从未读过
`j->content_type`**——而 `fetch` 只为 `string`/`Blob` 体自动补这个头，对本后端传的 `Uint8Array`
**一律不补**。真实端点（浏览器内实测，同一个 JSON 登录体）：

| 请求 | 服务端响应 |
|---|---|
| `POST` + `Uint8Array` 体，**无** Content-Type | `{"code":200002,"message":"platform 字段是必须的"}` |
| 同一请求 + `Content-Type: application/json` | `{"code":0,"data":{"accessToken":"1b394084-…"}}` |

即「服务器抱怨请求体缺字段」，看起来完全像 `.as` 侧少传了字段。**修法**：`as_web_fetch_go` 新增
`ctype` 形参，C 侧 `as_web_ctype()` 按与 native **同一条**规则算出（`content_type != NULL &&
(POST || 有体)`），在显式 `requestHeaders` 块**之前**写入（故 `URLRequest.requestHeaders` 里的同名头
仍优先）；`as_http_run` / `as_http_stream_run` 两个入口都传，URLLoader 与 URLStream 一致。

**二、远程图片在 web 上没有传输**

`as_job_run` 的 `AS_JOB_IMAGE_URL` 分支只有 `#if defined(ASC_HTTP_BACKEND)`（= curl）一个实现，
web 落到 `#else` 的 `AS_JOB_ERR_UNSUPPORTED`——报的是「本构建没接 HTTP 后端」（八十九·四十九 阶段 G
的诚实文案），而**这个构建其实有**。故 web 上每个远程 `Loader.load` 都在**一次请求都没发**的情况下
失败。**修法**：该分支加 `#elif defined(ASC_HTTP_WEB)`——`as_http_run(j)` 只**启动** fetch 并让 job
停在 RUNNING（`pending_async`，故 `as_job_publish` 不标 DONE、thunk 不跑），体到达后由
`as_web_fetch_pump` 在终态条目上解码，产出与 curl 分支**逐项相同**的两件东西：BitmapData 要的像素、
显示用 SkImage 要的编码字节。解码落在帧边界（浏览器无 worker 线程可藏；单帧几毫秒、每 job 一张图）。

**三、硬边界（不是编译器能修的）：这两个 URL 在 web 上本就**不应**被读到**

`meeting.talkmed.com` 的图片响应**没有** `Access-Control-Allow-Origin`（只有 `timing-allow-origin: *`）。
跨源图片在浏览器里可以**显示**，但**读不到像素**（canvas 会被 taint、`getImageData` 抛错），而 Skia
上屏正需要像素。真实 Chrome 实测：同页 `fetch()` → `Failed to fetch`；`curl` 同一 URL → 200 +
完整 487042 字节。**这是 native/`adl` 正常而 web 不行的唯一原因**；要它显示必须由 CDN 加
`Access-Control-Allow-Origin`，或让页面从**同源代理**取图。

**四、验收（真实浏览器）**

- fixture `temp/webimg-air/` + `temp/run_webimg.sh`：三台服务器**唯一**的差别是有没有 CORS 头。
  同源 → `decoded 753x751 bytesTotal=487042`；跨源+`ACAO:*` → `decoded 815x814 bytesTotal=511484`；
  跨源无 CORS → 指名 CORS 的 `ioError`。canvas 像素按三段各数非白点：
  `720x900 band1=47027 band2=45429 band3=0`（前两段真画上去了，第三段一个点都没有）。
- 用户原 app：`temp/run_urltest_web.sh`（服务端把 `.wasm` 标为 `application/wasm`，故日志里没有
  流式编译回退那两行）——登录拿到 accessToken、统计 GET 返回真实数据（**修前这条根本不会发出**）、
  两张图各自得到指名 CORS 的 `ioError`；`window.__ascErrors` 为空。截图 `temp/out/urltest-web.png`。
- **回归**：`test.ts` 新增 `checkWebTransport()`（**4 条 `[web]` 断言**）。套件里既没有浏览器也没有
  emcc（写死 emsdk 路径会硬编码个人机器），故钉在运行时前导的**契约**上，并已逐条做过反向对照：
  抽掉 web 图片分支 / 抽掉 Content-Type / 抽掉 pump 解码，对应断言各自立即转 false。

**文档同步**：[`flash-net.md`](docs/zh-cn/flash-net.md)（`Loader.load` 行 + 新 §6.7.4）、
[`html5-web.md`](docs/zh-cn/html5-web.md)（§2 `.wasm` MIME 说明、§3.4 两条契约、§6.10 图片 CORS）、
`README-CN.md`（`Loader`/`flash.net` 两条 + 限制项）。`package.json` v0.4.11 → **v0.4.12**。

---

#### 阶段八十九·五十七：web 预览里文字静默全灭（web 无字体）+ `--air-app` 字体告警（v0.4.12 → v0.4.13）

**依据**：用户在**内置预览面板**里跑 `examples/url-test` 的 web 构建，看到的是「舞台一片空、
没有 FPS 也没有日志」，而同一面板里的 `examples/air-starling-demo` 一切正常。两者差在**字体**：
Starling 自带 `assets/fonts/Ubuntu-R.ttf` 并被页面注入，`url-test` **一个字体都没有**。

**一、根因：wasm 沙箱无系统字体，`font-urls` 为空时一个字形都画不出**

`--air-app` 会把 app 目录下的 `.ttf/.otf/.ttc` 自动扫进 `font-urls`（`air-app.ts::findAppFonts`），
`url-test` 目录里一个都没有 → 生成的页面写的是 `FONT_URLS = []` → 链路第 3 步（
`_sk_fontmgr_register_data`）不发生 → `sk_platform_fontmgr()` 停在 `SkFontMgr_New_Custom_Empty()`，
`sk_default_typeface()` 拿不到 typeface，`drawString` 什么都不画。

**关键落差**：失败形态是「**TextField 的背景照画、字形全无**」——`Fps` 的深蓝条（`0x000033`）
与日志框的黑底（`0x1E1E1E`）都在，看着像「布局在、字没了」。而编译成功、页面能跑、
`trace` 全部正常，所以是一条**静默错误**；native/`adl` 侧文字正常（CoreText 枚举已装字体），
故这是 **web 独有**的坑。

**二、判定字体覆盖要用实测，不能猜**：`url-test` 会把登录响应的 JSON **原样**打进 TextField，
里面有中文（`住友制药`/`视频通话`/`我的会议`…）。按 `fontTools` 读 cmap 实测（探针字形
`住友制药 视频 议程` 8 字）：`examples/web/fonts/Arial.ttf` **0/8**、`Ubuntu-R.ttf` **0/8**、
`MiSans-Regular.ttf` **8/8**。故示例带的是 7.9 MB 的 MiSans——字形缺失是**逐个字符且不报错**的。

**三、修法（两条，均已落地）**

1. **示例带字体**：`examples/url-test/assets/fonts/MiSans-Regular.ttf`（沿用 `air-starling-demo`
   的 `assets/fonts/` 约定）。**无需改描述符**——`findAppFonts` 自动扫到，生成的页面变成
   `FONT_URLS = ["assets/fonts/MiSans-Regular.ttf"]`。
2. **`--air-app` 加告警**（静默失败不符合 §2.5）：新增 `detectText()`（与 `detectStage3D`/
   `detectNetworking` 同形，判据取 `flash.text`——与 `flash.net` 不同，这个包里没有不画字的类），
   web 构建下若「用了 `flash.text` 且解析不到任何字体」则往 stderr 打一条**黄字**警告，
   点明症状与两种修法（自己放一个字体，或写 `<embedFonts>`）。**不抛错**：其余部分（布局、位图）
   预览正常，且拦下构建并不会让字体出现。`prepareAirApp` 相应新增 `warnings: string[]` 返回字段。

**四、验收（真实浏览器）**

- **反向对照先行**：把 Starling 的字体临时指进 `url-test.html` 的 `FONT_URLS` 并重载——
  FPS 行 `FPS:… MEM:0MB PRIV:0MB VERSION:LNX 50,0,0,0 RUNTIME:AS-AOT` 与整份登录/统计日志
  **立即全部显示**（中文呈 ▯，与上面 cmap 实测一致）；撤掉即回到空白。
- **修后**：`EMSDK_HOME=<emsdk> node src/index.ts --air-app ./url-test-app.xml --main-class Main
  --target wasm --package web`（用户原命令）→ 预览里 FPS 与日志全部正常，**中文完整**
  （`视频通话`/`我的会议`/`历史会议`/`创建会议` 等）。
- **native 零回归**：同 app 编 native 跑起来仍 `FPS:59 … RUNTIME:AS-AOT`、两张图正常
  （`bytesTotal=487042`/`511484`、`2/2 images on stage`）；native 清单的编译参数与字体改动前
  **逐项相同**（`font-urls`/`preload-paths` 都只用于 web，`findAppFonts` 仅在 web 分支调用）。

**五、新增告警的回归**：`test.ts` 新增 `checkAirAppFonts()`（**7 条 `[air-app-font]` 断言**），
钉在适配器自己的报告上（`prepareAirApp().warnings` + 它写出的清单），fixture 落在 `temp/`。
已做两组反向对照：① 把 `detectText` 与告警体一起短路 → 两条告警断言立即转 false；
② 去掉告警条件里的 `web &&` → 「同一 app 编 native 不告警」立即转 false（证明 web-only 定界是真的）。

**六、本轮实测发现的遗留（未修，是本改动放大的既有行为）**：`--air-app` 的 `preload-paths` 会把
app 目录**整体**打包进 wasm FS，于是 `assets/fonts/*.ttf` 既进 `.data`、又被页面 `fetch` 一次。
而字体的实际来源只是「页面 fetch + `_sk_fontmgr_register_data` 注入」，**FS 里那份从不被读**
（已实测：一个 `.data` 里没有字体的页面，字体仅走 HTTP，文字照样渲染）。`url-test.data` 因此
由 4.5 KB 涨到 **7.9 MB**（纯冗余，页面总下载量约翻倍；Starling 的 352 KB 同型但小）。
彻底修法要把目录 preload 展开成逐文件规格（emcc 无 exclude 开关），影响所有 web AIR 构建，
故列入遗留表待定。

**文档同步**：[`html5-web.md`](docs/zh-cn/html5-web.md)（§4 新增「失败形态」引用块、§6 第 1 条实测）、
[`compile.md`](docs/zh-cn/compile.md)（§3.5 字体自动检测 + 告警，并修正过期的
「缺省回退 `fonts/Arial.ttf`」表述）、`README-CN.md`（`--air-app` 条 + web 限制项）。
`package.json` v0.4.12 → **v0.4.13**。

---

#### 阶段八十九·五十八：web 字体不再重复打包（preload 排除集）（v0.4.13 → v0.4.14）

**背景**：阶段八十九·五十七 带出的遗留——`--air-app` 的 `preload-paths` 把 app 目录整体打进
wasm FS，于是 `font-urls` 里的字体**既进 `.data` 又被页面 `fetch` 一次**，页面下载量翻倍
（`url-test` 7.9 MB MiSans → `.data` 4.5 KB 涨到 7.9 MB）。用户直接指出该遗留并要修。

**一、先实测推翻了遗留行里的前提（这是本轮最关键的转向）**：遗留行断言「emcc **无** exclude 开关」
故只能把目录 preload 展开成逐文件规格。实测本机 emsdk **3.1.44**：`emcc --exclude-file <pattern>`
**存在**（`emcc.py:3496` → `file_packager --exclude` → `should_ignore` 的 `fnmatch`），于是逐文件
展开（命令行变长、且 `@` 名要转义、空目录丢失）**完全不必**。四条实测（`temp/preload-exclude-probe/`，
`probe.c` 挂载后 `opendir` 打印全 FS）：

- **精确命中**：`--exclude-file <abs>/assets/fonts/keepout.ttf` → 该文件从 FS 消失、
  `.data` 307224 → 102424（**恰好减 204800**），同目录 `keepme.fnt` 与 `assets/img/*` 全在，
  **`assets/fonts` 目录本身仍在**（所以 `opendir` 不受影响）；含 `@` 的 `icon@2x.png` 也整好无损。
- **glob 可用**：`*keepout.ttf` 同效（故字段值就是 fnmatch 模式）。
- **无命中是静默的**：模式指向不存在的文件时构建退出码 0、无告警、零排除——这才让生成器可以无条件发。
- **元字符必须转义**：路径里含 `[`/`]`/`*`/`?` 时它是**模式**而非字面量——
  `--exclude-file .../weird[1].png` 会把**无关的** `weird1.png` 排掉、反而放过它自己命名的那个
  （实测）。转义法 `[` → `[[]`、`]` → `[]]`、`*` → `[*]`、`?` → `[?]`（先用 Python `fnmatch`
  逐个验证 6 个路径自身匹配为真、6 个诱饵全为假，再用真 emcc 复验 `we*` → `we[*]` 精确命中）。

**二、实现**：`BuildConfig.preloadExcludes` + 清单字段 `preload-excludes`（顶层与 `targets.<t>` 均可，
相对清单目录解析——与 `preload-paths` 对称）→ wasm 链接期逐个发 `--exclude-file`；
`--air-app` 把**它自己写进 `font-urls` 的那几份字体**（`<embedFonts>` 或自动扫到的 TTF）
逐个按 fnmatch 字面量转义后写进该字段。**只排字体、不排别的**：位图字体（`.fnt` + 图集）不是
`font-urls`，它要由 app 通过 `File` 读，必须留在 FS 里——这一条就是 Starling 那只
「把 `assets/fonts` 整目录排掉」的错解会踩的坑。native 完全不受影响（preload 只用于 web）。

**三、实测验收**（两侧都在真实浏览器里看过）：

| | `url-test` | `air-starling-demo` |
|---|---|---|
| `.data` | 7928972 → **4572 B**（回到带字体前的基线） | 3273446 → **2913778**（**恰好** −359668 = `Ubuntu-R.ttf`） |
| 字体出 FS / 走 HTTP | ✓ 访问日志 `GET /web/assets/fonts/MiSans-Regular.ttf 200` | ✓ 同型 |
| 文字 | FPS 行 + 整份中文日志照常（`fpsGlyphs=1687`/`logGlyphs=75670`） | TextFields 场景：**TrueType 文字**（正文）+ **位图字体文字**（`It is very easy to use Bitmap fonts`）同框正常 |
| 资源仍在 FS | — | `probe.c` 以**同一份 preload 规格**列出真实资源树：`desyrel.fnt`/`desyrel.png`（1x/2x）、`atlas.png/xml`、`compressed_texture.atf`、`background.jpg`、`wing_flap.mp3` 全部在，只有 `Ubuntu-R.ttf` 不在 |
| 运行时证据 | 登录 POST 成功、统计 GET 真数据、`__ascErrors` 为空 | `onLoadProgress = 1`、`[AssetManager] Adding bitmapFont 'desyrel'` / `Adding textureAtlas 'atlas'` 等全出、`__ascErrors` 为空 |

**四、回归**：`test.ts` 新增 `checkPreloadExcludes()`（**5 条 `[preload]`**：清单相对解析、
wasm 链接带 `--exclude-file`、位置在 `--preload-file` 之后、native argv 永不带 preload/exclude、
无排除项时不发该 flag）+ `checkAirAppFonts()` 扩为 **11 条**（字体同时出现在 `font-urls` 与
`preload-excludes`、目录仍在 preload、native 无该字段、**元字符转义**）。已做**四组反向对照**
（一次跑完）：篡改为「不发字段」「不转义」「native 也发」「不转发 flag」→ 对应断言各自
立即转红（3 + 2 条），而 125 个示例**全绿不变**。

**五、残留**：字段值是 emcc 的 fnmatch 模式（文档已写明转义规则），**不是**任意路径语法；
排除只作用于 `.data`（`.wasm`/`.js` 不受影响）。`temp/web-demo/rebuild_web.sh` 那份手写链接行
**未**带 `--exclude-file`（它绕过构建层、本来就是易腐的短路脚本），若用它重建会把字体重新打回
`.data`——用真实构建命令即可。

**文档同步**：[`html5-web.md`](docs/zh-cn/html5-web.md) §6 第 1 条「重复下载」改写为已修、
[`compile.md`](docs/zh-cn/compile.md) 清单字段表新增 `preload-excludes`、`README-CN.md`。
`package.json` v0.4.13 → **v0.4.14**。

---

#### 阶段八十九·五十九：`ioError` 带上 AIR 的**错误号**（v0.4.14 → v0.4.15）

**背景**：用户问「TODO 里有没有 SVG 解码显示、我们按道理能支持 SVG 吧」。调研结论是 **TODO 零 SVG 覆盖**，
且真正的问题在**参照实现自己**：按 [AS3 语言参考](https://airsdk.dev/reference/actionscript/3.0/) 的
`Loader` 类文档三处（类描述 / `load()` / `loadBytes()`），**AIR 的 `Loader` 只支持 SWF/JPG/PNG/GIF**，
SVG 从来不在范围内（Flash Pro 的 SVG 导入是创作期转换）。用真 `adl` 51.4.1 实测确认 AIR 对 SVG 也报
ioError（`Error #2124 … unknown type`），故「我们报错」是对的。用户随即选定：**仅修该调研带出的那个 bug**
（不实现 SVG；native 侧 `libsvg.a` 虽已链接但 SVG 需一条经由 `SkSVGDOM::Builder` 的**新解码通道**，
web 侧连库都没编，都留待另行立项）。

**一、bug 是什么（同一根缺陷横跨三个 API）**：对比发现运行时**自己生成**的每一个 `ioError` 都带
`e.errorID == 0`，且 `text` 只有一句手写话（无 AIR 的 `Error #N: ` 前缀、无 `URL: ` 后缀）。根因不是三个
thunk 各自写错，而是 `IOErrorEvent_ctor` 把 `errorID` 固定为 0（对 `new IOErrorEvent(...)` 是对的——
AIR 该构造器不接受错误号；对运行时生成的**内部**事件就是漏填），三个派发点都直接用构造函数而没有赋值。
`Socket` 路径早有 `Socket__ioerror_event` 填 `#2031`，是**遗漏而非设计**。

**二、先把「AIR 到底报什么」测成矩阵（不靠记忆）**：写最小 AIR 探针、用真 `adl`（`temp/svg-air/`、
`temp/svg-air2/`，结果写绝对路径——`adl` 吞 `trace()`）逐格实测，得到 AIR 从未在文档里列出的号码：

| API | 失败场景 | AIR `errorID` | AIR `text`（逐字） |
|---|---|---|---|
| `Loader` | 本地文件不存在 | `2035` | `Error #2035: URL Not Found. URL: <url>` |
| `Loader` | 载荷不是图片（HTTP 2xx） | `2124` | `Error #2124: Loaded file is an unknown type. URL: <url>` |
| `Loader` | 传输失败（DNS/拒连）**或 HTTP ≥ 400** | `2036` | `Error #2036: Load Never Completed. URL: <url>` |
| `URLLoader` | 任意失败 | `2032` | `Error #2032: Stream Error. URL: <url>` |
| `URLStream` | 任意失败 | `2032` | 同上 |
| `Socket` | 任意失败 | `2031` | `Error #2031: Socket Error. URL: <url>`（已有，未动） |

关键一格：**远端 404 报 `2036` 而不是 `2124`**。我们原先的实现里 404 的响应体（HTML 错误页）会喂给
解码器并在此失败 → `AS_JOB_ERR_DECODE`，若照 `DECODE → 2124` 直译会把它错报成「不是图片」。真凶是
「错误种类」不足以判定，**必须再看暂存的 HTTP 状态**：同一个解码失败，`status >= 400` 是 `2036`、
否则才是 `2124`。

**三、实现**：`runtime.ts` 新增 `as_ioerror_text(url, id, detail)`（按号取 AIR 的句子，输出
`Error #N: <sentence>. URL: <url>`；后端另有细节时**括注在后**而不是替换句子——web 的 CORS 文案是 AIR 没有的
扩展信息，丢掉会让「被 CORS 拦下」看起来像「服务器死了」）、`as_job_loader_ioerror_id(job)`（Loader 的分类：
`UNSUPPORTED → 0`、`DECODE → status>=400 ? 2036 : 2124`、其余 `remote ? 2036 : 2035`）、`as_job_err_detail`、
`as_job_path`。三个 thunk 改为先算 `eid`、用 `as_ioerror_text` 造文案、再 `ev->errorID = eid;`
（**构造器仍留 0**，那是 `new IOErrorEvent(...)` 的正确值）。无后端场景（本构建没有传输）**故意不给号**：
AIR 不存在该状态，编一个号比留 0 更坏——调用方是按号 switch 的。

**四、验收（两侧逐字对照）**：探针 `temp/ioerr-matrix.as` / `temp/ioerr-matrix2.as`（`temp/ioerr-matrix.build.json`）
在六种 Loader 失败 + 五种 URLLoader/URLStream 失败上与上面的 adl 矩阵逐格对比：修复前全是 `errorID=0`，
修复后**六格 Loader 与 AIR 逐字一致**（`2124` / `2036` / `2036` / `2035` / `2035` / `2124`），
URLLoader 与 URLStream 均 `2032`。唯一未对齐的是 AIR 会把相对路径规范化成 `app:/…` 再放进文案
（URL 解析行为，与本缺陷无关，见遗留表）。

**五、回归**：`node test.ts` → **125 passed / 0 failed**；新增 **10 条 `[ioerror]`** 结构性断言
（四句 AIR 原文逐字、`Error #%d: %s. URL: %s` 形状、分类器的 `status>=400` 分叉与本地/远端分叉、
「无后端不给号」、**三个派发点都写了号**）。两处可离线复现的失败改为**端到端断言**：
`examples/loader-url.as`（本地非图片 → `#2124` 且文案逐字相等；本地缺失 → `#2035` 且文案逐字相等；
无后端 → 号仍为 0）与 `examples/urlloader-contract.as`（本地缺失 → `#2032` 且文案逐字相等）。
三组反向对照各自立即转红：Loader thunk 把号写回 0 → 「#2124: 0」；runtime 里 2035 句子改一个词 →
文案断言转红；URLLoader 把号写回 0 → 「#2032: 0」；分类器去掉 `status>=400` 分叉 → 结构性断言转红。

**六、顺带发现一条独立缺陷（未修，已记入遗留表）**：核查 URLLoader 的 404 时发现 AIR 对 non-2xx 的处理是
**条件行为**——取决于调用方是否注册了 `HTTP_RESPONSE_STATUS` 监听器。既存文档（`flash-net.md` §6.2 校正注）
把「404 → complete」写成**无条件**的 AIR 事实，实际只在**有**该监听器时成立（归档的
`temp/air-probe/air-probe6-result.txt` 与其 `Probe6.as` 的 `watch()` 正是注册了它，故当时测到 `complete`）；
**没有**该监听器时 AIR 派 `httpStatus(404)` 后 `ioError #2032`（本轮两个不同主机的 404 实测）。
当前实现**无条件** `complete`，即只覆盖了一半。该缺陷与本节同族（失败被当成成功）但机制不同（需按目标
查询监听器存在性），本轮按用户「仅修该 bug」的范围**不动它**，只记录+在文档加一条指向说明。

**文档同步**：[`flash-net.md`](docs/zh-cn/flash-net.md) 新增 **§6.7.5**（上面的 adl 矩阵 + 三处 ASCII
对照）、§3.1 表三行（`Loader`/`URLLoader`/`URLStream` 的 ioError 行）补错误号、§6.2 校正注加条件性指向说明；
[`README-CN.md`](README-CN.md) 同步。`package.json` v0.4.14 → **v0.4.15**。

---

#### 阶段八十九·六十：文档——保真与增强原则 + 增强待做清单（v0.4.15 → v0.4.16）

**依据**：用户要求——已对齐 `adl` 的功能已很多，请**先在文档中确立原则**：「完全对齐已有 AIR 功能」
与「利用『直接转 C + 生态』可以做 AIR 之外的增强」如何界定；并把**可增强的点**落到**差异的下方**，
新增一个「增强待做」。触发点是「SVG 直接支持？」这一问（其调研结论见阶段八十九·五十九：AIR 的
`Loader` 从不支持 SVG，故 SVG 属**增强**而非补平差距）。

**原则（写入文档）**：① **保真是底线**——AIR 已定义语义逐字对齐（以 `adl` 实测为准），增强不得改写；
② **增强是增益**——只在 AIR 未定义/不支持/无对应物处做，且必须 **opt-in**；③ **五条判定标准**
（落在 AIR 语义之外 / 绝不静默 / 跨端差异显式列出 / opt-in 不膨胀默认产物 / 过 DoD，逐条含反例）；
④ **硬判据**——同一输入 `adl` 能跑对而我们跑不出 ⇒ **遗留缺陷**；`adl` 本来就报错、或该 API 在 AIR 里
压根不存在 ⇒ 才叫**增强**。

**内容（可增强清单，15 项）**：SVG 运行时解码、Lottie（Skottie）、WebP/BMP/ICO（`SkCodec` 已编入、
**待实测**）、相机 RAW/DNG、矢量图形上屏、原生着色器直通、GPU 通用计算、无窗口/服务端出图、64 位整数、
`Vector.<Number>` SIMD、FFI 直调宿主 C、真并发 `Worker`、LTO/PGO、帧录制/确定性重放、可读 C 作为一等
交付物。每项标注 AIR 现状 / 我们现状 / 目标端 / 成本，并区分 **native 现成 vs web 需重编 Skia**
（§1.2c 的典型：SVG 在 native 有 `libsvg.a`+`libsksg.a` 已构建且已在链接表，web 因 `skia_use_expat=false`
而无 `libsvg.a`）。

**文档同步**：**新增** [`docs/zh-cn/enhancements.md`](docs/zh-cn/enhancements.md)（原则 + 15 项清单 + 重点项
说明，含 SVG 的 AIR 实测矩阵与两端能力表）；[`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) 新增
**§4 保真与增强原则**、**§5 增强待做**（置于 §3 差异表**下方**），原 §4 使用方式顺延为 §6；
[`README-CN.md`](README-CN.md) 的「当前限制」后新增「在 AIR 之外（增强）」小节；`TODO.md` 新增
`### 增强待做`；`AGENTS.md` §1 增补第 5 条原则。**本阶段无代码改动、纯文档**，`node test.ts` 回归
125 passed / 0 failed 不变。`package.json` v0.4.15 → **v0.4.16**。

---

#### 阶段八十九·六十一：遗留表清理——完成项归档 + AMF 独立成行（v0.4.16 → v0.4.17）

**依据**：用户要求复核 [`### 遗留待开发`](#遗留待开发)——把其中**已完成**的内容并入对应阶段并从本表移出，
并给出待实现项的推荐清单供立项选择。本阶段为**纯文档整理**（无代码改动）。

**一、逐项核实（对照代码/实测，不凭表内自述）**：11 项中 3 项判定已收尾——

| 原遗留行 | 判定依据（本轮代码/实测核对） | 并入 |
|---|---|---|
| `flash.net` HTTP 客户端（A~I）汇总行 | A/B（八十九·四十八）、G+C 探针（四十九）、`targets` 分层（五十）、C 内核 + D/E/F/H（五十一）、I（五十二）全部落地；代码里 `URLStream_load`/`navigateToURL`/`sendToURL` 均在（`emit.ts:4777`/`:4360`），静态 curl 三个 `.a` 在（`vendor/curl/lib/macos-arm64/{libcurl,libnghttp2,libz}.a`） | 阶段八十九·五十二 |
| `flash.net` 剩余重工程（3/6）汇总行 | 静态自包含（三个 `.a` 在）、代理/cookie jar/HTTP-2（`vendor/sysproxy_glue.c` 含 `SCDynamicStoreCopyProxies`）、socket 层（`ServerSocket_*`/`as_sock_pump`）均在 | 阶段八十九·五十三 |
| web 构建里字体被重复打包 | **已修复**：清单字段 `preload-excludes` 在（`src/build.ts:77/132/211/276`），生成器已写该字段 | 阶段八十九·五十八 |

**二、唯一需要「抢救」的子项**：上述两个汇总行共用一处未收尾子项 **AMF 编解码**
（`URLStream.readObject`/`writeObject`、`registerClassAlias`/`getClassByAlias`）——它**没有**自己的行，
若随汇总行一起删除即会静默丢失。核实其确未实现（`src/emit.ts:4681`/`src/symbols.ts:1312` 只有注释说明
「本子集无 AMF 编解码器，故 `ObjectEncoding.AMF3` 只是文档默认值」），故**提升为独立行**保留。

**三、结果**：`### 遗留待开发` 由 **11 行 → 9 行**（3 项归档移出、1 项 AMF 新行），状态摘要同步重算。
推荐立项清单见本轮交付说明（不在文档内排期，等用户选择）。

**文档同步**：仅 `TODO.md`（本阶段 + 遗留表 + 状态摘要）。`node test.ts` 回归 125 passed / 0 failed 不变。
`package.json` v0.4.16 → **v0.4.17**。

#### 阶段八十九·六十二：non-2xx 的条件终态 + 空体不派 progress（v0.4.17 → v0.4.18）

**范围**：用户从「遗留待开发」推荐清单里立项的**第一梯队第一项**（补保真、验收明确）：
`URLLoader`/`URLStream` 对 non-2xx 的终态必须随调用方是否注册 `HTTP_RESPONSE_STATUS` 监听器而分叉。

**先纠正了立项所依据的实测**：遗留表的结论取自两组探针的对比，但那两组之间**除监听器还改了主机/协议/
`Content-Length`**，不足以把差异归因给监听器。重做**受控**实验（同一服务器、同一 URL、同一字节，
唯一变量是该监听器；`HTTP_STATUS` 每格都注册以证明判据是**那个事件类型**），得到 12 格全矩阵，
**adl 与 AOT 逐字一致**。从矩阵读出三条容易做错的规则：

1. **阈值是 `status >= 300`，不是 4xx**——未跟随的 302 同样分叉（按 4xx 实现会把 AIR 报 `ioError`
   的重定向当成成功）；
2. **错误正文两半都照常发布**（`data` / `bytesLoaded` / `bytesTotal` 在 `ioError` 那一支已填好），
   分叉点**只在最后那一个事件**（`complete` ⇄ `ioError`）；
3. **空体不派 `progress`**（受控实验**新发现**：此前实现会多出 `progress(0/0)`）。

**实现**：`src/emit.ts` 的两个终端（`URLLoader__finish` / `URLStream__finish`）在 `httpStatus` 之后分叉——
`st >= 300 && !EventDispatcher_hasEventListener((void*)o, (char*)"httpResponseStatus")`（判据与 AIR 同为
「任一阶段有监听器」，复用已有原语）；错误支用 `as_ioerror_text(as_job_path(job), 2032, NULL)` 取 AIR **原文**
（`Error #2032: Stream Error. URL: <url>`），与八十九·五十九 共用格式器；终端 `PROGRESS` 加 `total > 0` 守卫。
同时校正 `flash-net.md` §6.2 校正注（把「404 → `complete`」由**无条件** AIR 事实改为**条件**）与 §6.7.5 的
「独立缺陷（未修）」注记，新增 **§6.7.6** 受控实测记录（12 格矩阵 + 三条规则 + 实现 + 反向对照）。

**验收**：`temp/httpstatus-probe/run_all.sh`（干净服务器 → 健康检查 → 同一实例依次跑 adl 与 AOT）：
12 格**两侧逐字一致**（含 A–H 的 `URLLoader` 矩阵、I/J 空体、K/L 的 `URLStream` 两半）；
AOT 侧由 `temp/httpstatus-aot/httpstatus-aot.as` 编译运行。

**回归**：`node test.ts` → **125 passed / 0 failed**；新增 **6 条 `[httpstatus]`** 结构性断言（两个终端都查监听器、
阈值 `>= 300`、方向为**缺监听器**、AIR 原 `#2032` 文案与错误号），并做 **4 组反向对照**（阈值改 400 / 去掉 `!` /
只改 `URLStream` 一格 / 某格号改 2030），每组**只**让对应断言转红；空体守卫另配**离线端到端**对照
（`examples/urlloader-contract.as` 读新增的 `examples/empty.bin`，去掉 `total > 0` 即报 `open;progress;complete;`）。

**文档同步**：`TODO.md`（本阶段 + 遗留表 9 行 → **8 行** + 状态摘要）、`docs/zh-cn/flash-net.md`（§6.2 / §6.7.5 / 新 §6.7.6）、
`README-CN.md`。`package.json` v0.4.17 → **v0.4.18**。

> **方法学教训（已记入 §6.7.6）**：探针的 `server.py` 最初是**单线程 + HTTP/1.1 keep-alive**，一条连接即卡死，
> 后续请求全部连不上——表现得和「传输坏掉」一模一样（10 格全 `httpStatus(0);ioError`）。
> 改成 `ThreadingHTTPServer` + HTTP/1.0 并在每次测量前**健康检查**后才拿到全矩阵。
> **仪器不可信时结论一定不可信**（与 §6.7.4 修 `netprobe2_server.py` 同一条教训）。

#### 阶段八十九·六十三：多格式图片解码实测 —— E3（v0.4.18 → v0.4.19，零代码）

**范围**：用户立项的 `### 增强待做` 第二梯队第一项。立项时记为「成本最低的一项，先实测」，
实测结论就是**不需要写任何代码**。

**方法**：一份源码 `temp/codec-probe/codec-probe.as`，分别用 native 清单与 web 清单构建，
载入同一组 6 张图（37×23、四象限纯色，故尺寸与像素都能验伪），每格核对**尺寸 + 左上/右下像素**：

| 格式 | AIR（`mxmlc` + `adl 51.4.1`） | native | web |
|---|---|---|---|
| PNG / JPG / GIF（对照） | ok 37×23 | ok 37×23 | ok 37×23 |
| BMP | **`ioError #2124` unknown type** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| WebP | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |
| ICO | **`ioError #2124`** | **ok 37×23 `ff0000`** | **ok 37×23 `ff0000`** |

**结论与判据**：AIR 侧的 `#2124` 是权威判据（§1.5）——这三种**确实是 AIR 之外**，故本条是**增强**而非欠账；
两端解码器（`skia_use_libwebp_decode=true` + `wuffs=true`）本就在 Skia 里，走的是与 PNG/JPG 同一条
`DeferredFromEncodedData`，所以「零代码可用」是**结构上的必然**，不是巧合。web 侧由无头 Chrome 跑同一页面取得
（`ascErrors` 为空），与 native **逐格一致**。

**顺带纠正两点**：
- **QOI 不在支持面**：`SkQoiCodec` 未编入（`args.gn` 无 `skia_use_qoi`），要支持须开开关并**重编两端 Skia**。
  立项时把 QOI 与 WebP/BMP/ICO 并列，实测后已从文档里划出（与 SVG/Lottie 的 web 侧同型）。
- **`SkRawCodec` 在 native 侧已编入**（13 个符号）——是 E4（相机 RAW/DNG）的现成通道，留给 E4。

**一个留给你定的开放项（未擅自选择）**：按 §1.5 增强应当 **opt-in**（默认产物与 AIR 同构），但当前这三种格式
是**被动**放行的——默认构建就接受 AIR 会拒绝的输入。两条路：**(a)** 保持现状（只增不减的超集行为，对 AIR 上
能跑的程序无影响），把「默认构建对图片格式是 AIR 的超集」写进文档；**(b)** 默认拒绝、加显式开关才放行
（严格同构，但要主动写代码去**降低**能力）。见 `docs/zh-cn/enhancements.md` §4.3。

---

#### 阶段八十九·六十四：LTO / PGO 构建开关 —— E13（v0.4.18 → v0.4.19）

**范围**：`### 增强待做` 里成本最低、也最「纯」的一项增强——不是语言特性，而是把**成熟编译器能力**
（`-flto`、剖析数据）接到使用者手上。仍守铁律：前端一行优化都不手写（§1.1）。

**接口**：构建清单 `lto` / `pgo`（`generate` | `use`）/ `pgo-dir`，与 CLI `--lto` / `--pgo` / `--pgo-dir`
等价（CLI 覆盖清单）。**默认全关**——不设时命令与产物与以前逐字节相同，故不违反「默认产物与 AIR 同构」。

**唯一有内容的设计点**：`-flto` 必须**同时**在编译步与链接步上；只加一侧**不报错、只是静默不生效**，
正是 §1.5「绝不静默」针对的失效类型。故标志收敛到单一 `perfFlags()`，四个命令构造器（native 单文件 /
native 多文件 / wasi / emcc）全从它取，回归对 native 与 web 的**每一步**都断言，并做反向对照——
**4 个变异（漏链接步 / 漏 web 编译步 / 复现 `-fprofile-correction` / 默认开 LTO）全部被捕获**。

**实测**（`temp/perf/`，900k 次调用密集循环，五次取中位）：

| 构建 | 校验和 | 墙钟 | 产物 |
|---|---|---|---|
| `-O2`（默认） | −1664902176 | ~30.6 ms | 33464 B |
| `-O2 -flto` | −1664902176 | ~25.6 ms | 33456 B |
| `-O2 -flto -fprofile-use` | −1664902176 | ~25.5 ms | 33464 B |

三者校验和**完全一致**（只提速、不改语义），`-flto` 约快 16%；再叠 PGO 无可测增益（在噪声内）——
**不宣称 PGO 是普适提速**，本负载分支简单，PGO 的收益面是分支多/间接调用多的程序。

**两点如实记录**：`-fprofile-correction` 是 GCC 标志，clang 只警告 `not supported` 后忽略，故**特意不发**
（首次实现发了，实测出警告后删掉）；`--target wasm`（裸 WASI）路径同样把标志送进命令并有断言，
但**本机未安装 WASI SDK（`WASI_SDK_HOME` 未设、系统内也找不到 SDK），该路径未实测**。
#### 阶段八十九·六十五：SVG 运行时解码 —— E1 native 半（v0.4.19 → v0.4.20）

**范围**：用户立项的 `### 增强待做` 旗舰项。AIR 的 `Loader` 规范三处一致（类描述 / `load()` / `loadBytes()`），
**SVG 从来不在支持范围内**；本机 `adl 51.4.1` 实测对 SVG 报 `#2124 unknown type`，故这是**增强**，不是欠账。
库现成（native 的 `libsvg.a`/`libsksg.a`/`libexpat.a` 已构建且已在链接表），缺的只是**新解码通道**——
SVG 不是 `SkCodec` 格式，走不了现有那条 `DeferredFromEncodedData`。

**按 §1.5 做成 opt-in**（默认构建必须与 AIR 逐字同构）：

| 构建 | `Loader.load("x.svg")` |
|---|---|
| 默认（无增强开关） | `ioError #2124 Error #2124: Loaded file is an unknown type.` —与 `adl` 逐字相同 |
| `--features svg`（= `-D ASC_USE_SVG=1`） | 解码成功 |

**实现**（`vendor/skia_glue.cc`，四个解码入口统一加「codec 失败之后」的回退；嗅探只跳过 BOM/空白后首字节，
故不解析的载荷不为此付费）：

```
SkSVGDOM::Builder().setFontManager(sk_platform_fontmgr()).make(stream)
→ setContainerSize(文档自身 width/height；缺省用规范默认 300×150)
→ SkSurfaces::Raster(N32/premul) + clear(TRANSPARENT) + render
→ 得到 SkImage，或 readPixels 成 straight-ARGB
```

`setFontManager` 是**必要项**而非装饰：不设时 `SkSVGDOM` 对 `<text>` **一个字都不画**（实测文字区暗像素
**97 → 0**，已反向对照）。

**实测**（`temp/codec-probe/svg-probe.as`，同一份源码编两遍）：文件 / `loadBytes` / `BitmapData.loadFile`
三条入口、只有相对单位的文档（→ 300×150）、含 `<text>` 的文档（120×30 + 97 个字形像素）全部通过；
`t.png` 反向对照仍走 codec、不被 SVG 路径截胡。

**顺带修掉一个被它暴露的既存缺陷**：`BitmapData.loadFile` 成功解码时 `free(bd->pixels)`，而 `pixels` 自
阶段八十九·四十二起就在 GC 堆上——`free` GC 缓冲会砸坏空闲链（`BitmapData_dispose` 早已注明该规则）。
**默认构建里对一张普通 PNG 调 `loadFile` 就会 `abort()`**，与 SVG 无关；之所以一直没暴露，是因为没有任何
回归跑过**成功**的 `loadFile`（探针喂的都是解不出来的文件，走不到该分支），而 `Loader__imageFinish` 的同款
`free(bd->pixels)` 是 `free(NULL)`（BitmapData 建成 0×0）而被掩盖。两处均改为「丢引用、不 free」。

**web 端不做**：`vendor/skia/lib/wasm` 里**没有** `libsvg.a`/`libsksg.a`/`libexpat.a`（`args.gn` 的
`skia_use_expat=false` 把 svg 目标整体门掉），定义 `ASC_USE_SVG` 会在**链接期**失败——显式报错，不静默降级。

**覆盖安排**：它需要 Skia 链接 **且**需要 `ASC_USE_SVG`，而回归套件的每个 examples 条目都是**裸清单**运行的，
故覆盖 = `temp/codec-probe/svg-probe.as`（证据）+ `test.ts` 的 `[svg]` **8 项结构钉子**；反向对照做了 4 个变异
（漏一个入口的回退 / 去掉 `setFontManager` / 改错规范默认尺寸 / 复原 `free(bd->pixels)`），**全部被捕获**。
#### 阶段八十九·六十六：TextField wordWrap 可用宽度对齐 AIR 的 2px 内边距（v0.4.20 → v0.4.21）

**这是 `### 遗留待开发` 的 ① 项**，也是本轮唯一未开始的一项（本轮开始并完成）。
原记录把它归因于「**行尾空格**口径」——实测下来**归因是错的**，真正的原因只有一个：**少减了 4px 内边距**。

**受控实测**（`temp/tfwrap/Main.as` 走 `adl 51.4.1`，`temp/tfwrap/tfwrap.as` 走我们，同一组 TextField 参数、
同一组文本，只扫字段宽度，读 `numLines`：**第一个 `numLines == 1` 的宽度就是阈值**）：

| 文本 | 我们的 ink (`textWidth`) | AIR 阈值 | 修前 | 修后 |
|---|---|---|---|---|
| `"Multitouch"` | 124.945 | **129** | 125 | **129** |
| `"Multitouch "`（1 个尾空格） | — | **129** | 125 | **129** |
| `"Multi touch"`（词间空格） | 133.383 | **138** | 134 | **138** |
| `"Multitouch  "`（2 个尾空格） | — | **129** | 125 | **129** |
| `"Multitouch Multitouch"` | 258.328 | **263** | 259 | **263** |
| `"Multitouch  Multitouch"` | 266.766 | **271** | 267 | **271** |

两条结论：
1. **阈值 = `ceil(ink + 4)`**：`124.945+4=128.95→129`、`133.383+4=137.38→138`、`258.328+4=262.33→263`、
   `266.766+4=270.77→271`——**六项全部逐值命中**。修前我们算的是 `ceil(ink)`（无内边距）。
2. **行尾空格与阈值无关**：`"Multitouch"` / `"Multitouch "` / `"Multitouch  "` 三档（0/1/2 个尾空格）AIR 阈值
   都是 **129**、我们修后也是 **129**。尾空格本就不能成为新行的起点，所以它进不进候选宽度**不影响断行**——
   原记录的归因不成立。

**修复**（`src/emit.ts` 的 `as_tf_paragraph`）：排版宽度由 `tf->width` 改为 `tf->width - 4.0`；字段比自身内边距
还窄时**钳到 ≥ 1**——glue 把 `width <= 0` 读作「不换行」（替换成 1e9），不钳会让极窄字段**静默变成不换行**。
这个 4px 并非新引入的约定：`autoSize`（`tf->width = tw + 4.0`）与 `maxScrollH`（`over = tw + 4.0 - tf->width`）
**早就按同一内边距写**——**只有断行阈值一处漏了**，这才是它一直没被发现的原因。

**回归**：`test.ts` 新增 `[textwrap]` 3 项结构钉子（内边距、旧写法不得复现、窄字段钳位）；反向对照把 `- 4.0`
改回 `- 0.0` → **被捕获**。`node test.ts` **125 passed / 0 failed**。

**顺带发现（另立遗留项，本轮不改）**：`TextField.textWidth` 对带尾空格的文本，AIR 是 **含**尾空格的
（`"Multitouch "` = 133、`"Multitouch  "` = 141.5），我们恒为 **124.945**（SkParagraph 不计尾部空白）。
这**不影响断行**（见结论 2），但它是 **AIR 可观测的属性差异**，故按 §1.5 记入 `### 遗留待开发`；
改动会同时牵动 Starling 的 `TrueTypeCompositor`（它用 `textWidth` 定尺建 BitmapData）与 `textfield-align`
的居中期望值，须整轮重跑后才能收。

---

#### 阶段八十九·六十七：具名增强开关（`--features` / 清单 `features`）+ `--air-app` 增强选择持久化（v0.4.21 → v0.4.22）

**起缘于一个用户报告**：用 `node src/index.ts --air-app ./url-test-app.xml --main-class Main --target native --run`
编译时，`defines` 里没有 `ASC_USE_SVG`，希望能**默认加上**。查下来的结论是：**默认不能加**，但报告属实且真因不是
「缺能力」。

**先钉三个事实**（均实测）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | `-D ASC_USE_SVG=1` **本来就能用**，`--air-app` 路径下 CLI 覆盖优先于生成的清单 | 真实构建成功（`clang -c ... -D ASC_USE_SVG=1`），2.4s |
| 2 | air-app 的 native 清单**早已链接** `-lsvg -lsksg -lexpat`（还有 `-lskottie -lskresources -ldng_sdk -lpiex`） | 链接行实测；即 E1/E2/E4 **各差一个宏** |
| 3 | `src/air-app.ts` 无条件 `writeFileSync(manifestPath, ...)`，生成的 `<filename>.build.json` **每次整份重写** | 手改 `"defines"` 不持久——**这才是「只能靠默认」的真因** |

**为什么不默认加**：AGENTS.md §1.5 要求增强 **opt-in 且默认产物保持与 AIR 同构**；默认加上会让默认构建对 SVG
不再报 `#2124`，正是八十九·六十五则刚钉死并写进文档的不变式。故改为**具名开关**：

```bash
as-aot app.as --air-app app.xml --features svg     # 等于 -D ASC_USE_SVG=1
as-aot app.as --air-app app.xml --features none    # 清空（并把清空也持久化）
```

| 改动 | 位置 |
|---|---|
| `BuildConfig.features` / 清单 `features`（含 `TARGET_LAYER_FIELDS`，层内 **replace** 语义） | `src/build.ts` |
| `FEATURES` 注册表（名字 → 宏 + **可用目标** + 不可用原因）、`featureDefines`/`effectiveDefines`/`validateFeatures`/`knownFeatures`/`featureMacros` | `src/build.ts` |
| 全部 **3 个 `-D` 发射点**改走 `effectiveDefines(cfg)`（与 `perfFlags` 同一形态：单一来源，防「某个构造器漏掉」） | `src/build.ts` |
| `--features` CLI（逗号分隔、可重复、`none` 清空）、`resolveFeatures`、构建横幅点名、`validateFeatures` 前置校验 | `src/index.ts` |
| `prepareAirApp(..., features)`：回读旧清单**继承** `features`，写回新清单并打印 carry-over 警告 | `src/air-app.ts` |

**三条「不静默」的硬约束**（都进了回归）：

- **未知名字报错**：`--features lottie` → `unknown feature 'lottie' (known: svg)`，且在**生成任何代码之前**退出
  （先写在 `validateFeatures` 里；否则错误会晚到 codegen 之后，留下半成品 `.c`）。**只有端到端实现过的通道才登记名字**
  ——登记一个没实现的开关，等于给用户一个「看着开了、实际没编进去」的东西。
- **目标不支持就报错**：`--target wasm --features svg` 直报 `feature 'svg' is not available with --target wasm`
  （附原因：wasm Skia `skia_use_expat=false`），而不是把 `undefined symbol: sk_svg_*` 留给链接器。
- **开了要点名**：`== enhancements: svg (-D ASC_USE_SVG=1) ==` + 「这是 AIR 超集」；carry-over 走 warning。

**`--features` 与 `-D` 的区别**：`-D` **追加**一条宏，`--features` **替换**整个增强集合——「本来开着 svg、我只想要
别的」只有替换语义能表达；`none` 是那个关闭开关（也持久化，否则关不掉一个已经记住的选择）。

**回归**：`test.ts` 新增 `[features]` **24 项**（默认无宏 ×4 个构造器、开关到达每个构造器、`-D` 形制、去重、
未知名字、目标拒绝、清单读入 + 层内 replace、以及 8 项 `--air-app` 持久化）。**4 个反向对照变异全部被捕获**：

| 变异 | 被捕获的钉子 |
|---|---|
| `effectiveDefines` 忽略 features | 5 项（开关没到命令行） |
| 默认改开 svg | 5 项（含 4 项「默认必须无宏」） |
| 适配器不再继承持久化集合 | 2 项（不带参数的后续运行丢了设置） |
| 未知名字静默变 no-op | 2 项（未报错 + 进程退出码为 0） |

**行为证据**（不是只钉字符串）：把 `temp/codec-probe/codec-features.build.json` 的宏换成清单 `"features": ["svg"]`，
重新构建后 `t.svg -> ok 37x23 tl=ff0000 br=ffff00`——即「名字 → 宏 → 真实解码通道」整条链打通。
`node test.ts` **125 passed / 0 failed**（另 24/24 `[features]`）。

**文档**：[`compile.md`](docs/zh-cn/compile.md) §3.4.2/§3.4.2.1（中文）、§3.4.1/§3.4.1.1（英文）、清单字段表新增
`features` 行；[`enhancements.md`](docs/zh-cn/enhancements.md) 新增 **§1.4「增强怎么开：具名开关」**（对比
`-D` 的可发现性/错字/跨端/点名/集合语义五栏）；README-CN 新增条目；`skia.md` 标注开启方式。

#### 阶段八十九·六十八：Flappy-Starling 双目标实测（native + web）+ web 预打包吞掉输出目录（v0.4.22 → v0.4.23）

**起缘于一个用户要求**：把 `examples/Flappy-Starling`（第三方 Starling 游戏，128 个 `.as` 含 Starling 2.7 源码）
编译到 **native 与 web 两端**，看看跑得怎么样。**结论：两端都能构建、能跑、能玩**——但实测同时暴露出
**一处构建缺陷（已修）** 与 **两处 AIR 保真缺口（记入 `### 遗留待开发`）**。

**一、两端实测（同一份描述符 `flappy-app.xml`，窗口 1600×1000、`[SWF(backgroundColor="#d1f4f7")]`）**

| 目标 | 命令 | 产物 | 画面 |
|---|---|---|---|
| native | `--air-app flappy-app.xml --main-class FlappyStarlingMobile -o temp/flappy-native` | 24.5 MB Mach-O arm64，~9 s | ✅ 标题画面（位图字体 "Flappy Starling" + "Current Record: 0" + TAP 指示）、天空/地面/鸟/云 |
| web | 同上 + `--target wasm --package web`（需 emsdk 在 PATH） | `.data` 2.5 MB + `.wasm` 7.8 MB | ✅ WebGL2（`WebGL 2.0 (OpenGL ES 3.0 Chromium)`）标题画面，素材全载，`ascErrors: []` |

**二、交互与行为：三端一致（有实测证据，不是「看起来能跑」）**

- **原生**：先用 `temp/activate.py` 激活窗口（未前置时画面冻结，属已知的 macOS 后台挂起，非缺陷）后开始动画。
  临时给 `vendor/window_glue.cc` 加 `fprintf` 探针（**用 `script -q /dev/null` 走 pty，否则 stdout 缓冲会把
  探针全藏掉**）证明 SDL 鼠标事件确实到达；再用 `temp/flappy-touch/`（游戏源码副本 + 在 `Starling.onTouch`
  与 `Game.onTouch` 插桩）证明**点击真的开局**：`_world.phase` 由 `phaseIdle` → `phasePlaying`。
  早先「点了没反应」的截图是**误判**——捕到的是崩溃后 1.5 s 的自动重开（标题回来）。
- **web**：同一套插桩编 web 后，合成 canvas 点击的轨迹与原生**逐行同形**（`phaseIdle → phasePlaying`，
  之后每次触摸 `getTouch -> starling_events_Touch` = 拍翅膀），即事件链在 web 后端同样打通。
- **adl 基准**：点击后同样「开局 → 坠机 → 1.5 s 自动回标题」，**与我们两端行为一致**（截图对照）。
  开局后左上角的「0」是三端共有的**分数标签**（`_scoreLabel` 未被定位，停在 `(0,0)`，是上游行为）。

**三、构建缺陷（已修）：web 预打包把「本次构建的输出目录」也吞进 FS 镜像**

`findPreloadPaths()`（`src/air-app.ts`）用描述符 `<filename>` 前缀在**应用根**上做排除，看不到子目录；而
`-o temp/flappy-web` 这种常见形态会把输出放在应用根下的 `temp/`。实测：预打包根集从 **1.9 MB 的素材**
涨到 **36 MB**，多出来的全是**这次构建自己正在写的** `.c`/`.o`/可执行文件（native 产物 24 MB 也在里面）。

- 修法：`findPreloadPaths` 增加 `outputDir` 形参，按**输出目录**（而非名字黑名单）排除；`prepareAirApp`
  增加 `outputPath` 形参；`src/index.ts` 把 `opts.output` 传下去。**没有 `-o` 时不做任何猜测**——排除是
  「本次构建的事实」，不是「`temp` 这个名字」。
- 回归：`test.ts` 新增 `[preload-dir]` **7 项**（含「无 `-o` 不丢」「输出在应用外不丢」「输出直接在应用根
  仍保留数据」三条反向对照，以及**调用点结构钉子**——前 4 项都靠手工传参，测不到 CLI 根本没把 `-o` 递下来）。
- **3 个反向对照变异全部被捕获**：忽略输出目录 → 2 项红；`index.ts` 改传 `null` → 结构钉子红（**这条正是
  补钉子的原因**）；按名字猜 `temp` → 「输出在应用外不丢」红。实测 `--preload-file` 列表里 `temp@temp` 消失。

**四、保真缺口（新入 `### 遗留待开发`，本轮只实测记录，不动语义）**

| # | 缺口 | 实测证据 |
|---|---|---|
| A | **`[SWF(width,height,backgroundColor)]` 元数据被解析后丢弃** | `src/parser.ts:215` 的注释写着「no runtime effect」——**不成立**。受控实验（同一探针、只切元数据，`adl` 桌面档）：无元数据 `stage=500x375`（mxmlc 默认 SWF 尺寸），加 `[SWF(width="320",height="480")]` → `stage=320x480`。即 AIR 的 `stage.stageWidth/Height` = **SWF 声明尺寸**，我们 = **窗口尺寸**（探针 1600×1000）。同一根因还解释**底色**：adl 画面是 `#d1f4f7`、我们是白 |
| B | **`Stage.fullScreenWidth/Height` 取「完整显示模式」而非「可用区」** | 同机同刻三端对照：adl **1800x1137** vs 我们 **1800x1169**（同一显示器时 Δ = 32 = 菜单栏）；换到外接显示器后 adl 报 **2560x1408**（= 2560x1440 − 32），规则跨两种模式复现。即 AIR = 窗口所在显示器的**可用边界**，我们 = `SDL_GetCurrentDisplayMode`（display 0 的完整模式）。多显示器下两者甚至不在同一块屏（native 报内建 1800x1169、adl 报外接 2560x1408），须一并纳入修复考量 |

**五、一个**假阳性**警告（无损，已定性）**：web 构建会报「no font resolved」，但这游戏用的是 Starling **位图字体**
（`bradybunch.fnt/png`，走 `File` 读），文字渲染正确——警告对位图字体应用是误报，**不改**（改检测面会把
「真的没字体」的告警也一起削弱）。`screenDPI` 三端一致（72）。

**回归**：`node test.ts` **125 passed / 0 failed**（另 `[preload-dir]` 7/7）。**本轮无语言/运行时语义改动**——
A/B 两条只做实测记录与立项，未动一行 emit（任一条都会改所有 GUI 示例的布局，须连 12 场景 Starling 一起回归，另立项）。
`vendor/window_glue.cc` 的临时探针已从备份还原并确认无 `DBGEVT` 残留。

**文档**：本阶段条目（此处）；`examples/Flappy-Starling/AOT-NOTES.md` §1/§3 更正「只有 native、必须 mobileDevice」
的旧表述并补双目标实测与三端对照；`### 遗留待开发` 新增 A/B 两行。

---

#### 阶段八十九·六十九：`examples/air-native` 无法启动 —— `URLRequest.contentType` 属性值 vs 发包默认（v0.4.23 → v0.4.24）

**报告的现象**：`examples/air-native` 跑
`node ../../src/index.ts --air-app ./air-native-app.xml --target native --run`，构建成功（`Build successful`）
但**应用没起来**。

**一、先分清「构建失败」与「启动即死」**：二进制是好的，进程 **0.053 s 后以退出码 1 结束**
（`real 0m0.053s`），stdout 停在
`--- Net / UI (stage 63) --- / Uncaught exception: FAIL: URLRequest contentType defaults to null`。
即 `NetUiDemos.run()` 的 `Assert.check` 抛出未捕获异常，把 demo 掐断在 stage 63，
**帧循环从未进入、窗口从未绘制**（`osascript` 进程表里也确无 GUI 进程）——所以现象是「没启动」。

**二、两套口径必须都实测（真相是「属性 vs 发包」两件事）**：

| 探针（`mxmlc` + `adl` 51.3.4 + 本地捕获服务器 `temp/probe-req/srv.py`） | AS3 读回 | adl 实际发出的 `Content-Type` |
|---|---|---|
| `new URLRequest(url)` | **`null`** | — |
| `req.contentType = ""` | **`""`**（不归一为 `null`） | — |
| 先设 `"application/json"` 再设 `null` | `null` | — |
| POST 有体，contentType 未设 / 为 `""` | — | `application/x-www-form-urlencoded` |
| POST 有体，contentType 显式 | — | 原样（`application/json`） |
| POST **无体**（CL 0）/ GET（`data` 折叠进 query） | — | **一个都不发** |

结论：**属性值该是 `null`（阶段八十九·四十八 依官方文档改成 MIME 串是错的——文档那句描述的是
adl 的发包默认，不是 getter）**；触发条件是「**体非空**」而非「是 POST」。

**三、修法（拆两层 + 一处 libcurl 默认头）**：

- `URLRequest_ctor`（`emit.ts`）回到 `o->contentType = NULL`；`symbols.ts` 的注释同步改成实测口径。
- 发包口径集中到共享助手 `as_http_effective_ctype(j)`（`runtime.ts`，curl / web 两后端共用）：
  体为空 → `NULL`；体非空且未声明或声明为 `""` → `application/x-www-form-urlencoded`；否则原样。
- **libcurl 会给每个 POST 自补 `Content-Type`**（adl 不补）⇒ 无体 POST 追加空值条目
  `curl_slist_append(hdrs, "Content-Type:")` 关掉内建默认头。web 侧 `fetch` 对 `Uint8Array`
  本就不自补，无须处理。
- **同步受影响示例断言**：`examples/stage63.as`、`examples/http-request-api.as` 由 MIME 串改回
  `null`（`examples/air-native/.../NetUiDemos.as` 本来就是 `null`，不用动）。

**四、反向对照（同一探针走 AOT，逐条比对捕获头）**：修前 **5/6**（无体 POST 多发了 urlencoded），
修后 **6/6** 与 adl 一致（含 `Content-Type: ""`、显式 `application/json`、GET 无头两例）。

**五、回归**：`node test.ts` **125 passed / 0 failed**；新增 `[req-ctype]` 组 **6/6**。
**重建 `examples/air-native` 并实跑**：输出走到 `=== All demos complete ===`、stage 63 打印
`NetUiDemos: all flash.net / flash.ui assertions passed`，窗口 `Native AS3 Demo`（1000x712）正常出现并保持。

**六、为什么旧回归没抓到（已补钉子）**：`examples/air-native` 是**目录型示例**，`test.ts` 只编译、
**不运行**；三个断言默认值的示例里只有它把断言放在会被执行的路径上，于是「改默认值却漏改示例」
逃过了 125 项回归。故新增 `[req-ctype]` 6 项：钉住属性默认、共享发包规则、libcurl 默认头的抑止，
并**扫描 `examples/` 下所有声称断言「默认值」的 `contentType ==` 行、要求与构造器的发射一致**。

**文档**：本条目；`docs/zh-cn/flash-net.md` §6.7.7（完整捕获矩阵与踩坑）+ §2 表两处 + §6.1 里那条**不成立**的
「`air-native` 也 PASS」已更正；`README-CN.md` 三处；版本 → **v0.4.24**。

---

#### 阶段八十九·七十：`examples/air-native` 的 web 版运行即崩 —— 一个 `FILE*` 被关两次（v0.4.24 → v0.4.25）

**报告的现象**：`node ../../src/index.ts --air-app ./air-native-app.xml --target wasm --package web --run`，
页面能加载、能跑、素材全在，但主循环刚进就 `Uncaught RuntimeError: null function`。

**一、先分清「加载失败」与「运行时 trap」**：日志里所有 demo 都跑到了 `=== All demos complete ===`，
canvas `1000x680`、`gl: WebGL 2.0`、`stderr` 空，**前两条报错都不是死因**——
`wasm streaming compile failed: Incorrect response MIME type` 是静态服务器没给 `.wasm` 类型、
emscripten 自动退回 ArrayBuffer 实例化；`WEBGL_debug_renderer_info not enabled` 是 Skia 取 renderer 字串的警告。
真正的 trap 出现在最后两条业务日志之后：`URLLoader async: IO_ERROR …`、`FileStream openAsync: … COMPLETE (async)`，
即**第一次进入帧循环**时。同一份代码 native 不报错。

**二、定位（先把栈符号化再下结论）**：无 `-g` 时 emscripten 只给 `null function` + 裸偏移
（`01a3921a:0x4ff0aa`），无法定位。故用 `--opt "-O2 -g"` 重编（`--opt` 只接单个参数，
故用 `EMSDK_HOME` 指向一个把 `-g` 追加到 `emcc` 的包装器），并在**任何页面脚本之前**
（`Page.addScriptToEvaluateOnNewDocument`）装 `error` 钩子接住 `ev.error.stack`，拿到：

```
RuntimeError: table index is out of bounds
    at fclose (wasm-function[16369]:0x551a3d)
    at as_job_retire (wasm-function[257]:0x1268f)
    at Stage_dispatchFrame (wasm-function[252]:0x11cbd)
    at ASC_window_on_frame (wasm-function[266]:0x1384f)
    at main_loop() (wasm-function[1173]:0x4c8a0)
```

`table index is out of bounds` 与 `null function` 是同一件事的两种报法：`call_indirect` 的索引越界。
emscripten 的 `fclose` 结尾要经 **该 stream 自己的函数指针**间接调用，而被 `free` 掉的 `FILE` 记录里
那个槽位已不是合法表索引 —— 即 `as_job_retire` 的 `fclose` 作用在一个**已经不是 `FILE*` 的地址**上。

**三、根因：一个 `FILE*` 有两个主人**：

- `FileStream__openFinish`（`emit.ts`）当时是 `o->_handle = as_job_handle(job)` —— **递出去的是副本**，
  job 里的 `handle` 仍指着同一个 `FILE*`。
- `as_job_retire`（`runtime.ts`）对所有 kind 统一释放，`AS_JOB_FS_OPEN` 的那支就是 `fclose(j->handle)`。
- 于是「COMPLETE 里自己 `close()`」（`FileDemos.onAsyncComplete` 正是这么写的）关第一次，
  同一帧 phase 3 的 retire 再关第二次 ⇒ double close / use-after-free。

**native 为什么看不出来**：同一个 bug 在 native 上照样发生，只是 libmalloc 不检测 double free、静默损坏堆
（`MallocScribble=1` 下也照跑不误），而 emscripten 的 `fclose` 立刻踩空。
⇒ **这不是 web 独有的缺陷，只是 web 先报出来**；按 §1.5，native 的「没崩」不算通过。

**四、修法：把所有权写成显式的 take**

- 新增 `as_job_take_handle(job)`：取出并**置空** job 的 `handle`，注释写明这个 `FILE*` 从此归 AS3 的 `FileStream`。
- `FileStream__openFinish` 改用它；`as_job_handle` 这个「会复制」的 getter **删除**，免得日后顺手又用回去。
- `as_job_retire` 的 `fclose` **保留**：它仍是「thunk 从未运行过的被顶替 job」唯一能关掉句柄的地方
  （删了会按次泄漏文件描述符）。

**五、把「相反的那条规则」一起钉住**：字节/像素走的是**反方向**——thunk 把它们**拷进 GC 堆**，
job 继续持有自己那份 malloc 缓冲、由 retire 释放。两条规则一起钉，避免「修一处、把另一处改成同形」。

**六、验收**：

| 检查项 | 结果 |
|---|---|
| web 重编后无头实跑 | `ascErrors: []`、`stderr: []`，且**一直活着**——`TweenDemo: tween complete` 每帧继续打印（修前第一帧即死） |
| native 重建 | `=== All demos complete ===`、窗口 `Native AS3 Demo`（1000×712）正常渲染并保持，无 double-free 报错 |
| 全量回归 | `node test.ts` **125 passed / 0 failed**；新增 `[job-owner]` **9/9** |
| 反向对照 | **3 个变异全部被捕获**：①emit 退回复制 getter → 2 项 FAIL；②take 不置空 → 1 项 FAIL；③删掉示例自己的 `close()` → 1 项 FAIL（并确认 `process.exit(1)` 真的触发） |

**七、钉子钉在哪里**：钉在**生成的 C** 上（`generateC(parse(...))`），不是钉 emitter 的源码文本 ——
复制 getter 与 take 一眼看去几乎一样。另扫描 `examples/air-native/src/demo/FileDemos.as`，
确保**复现用例本身仍在**：若把 `close()` 删了，钉子就会在一个「不可能失败」的构建上通过。

**八、顺带修掉一个测试基建缺陷**：`[req-ctype]`（八十九·六十九 新增）的失败**没进 `process.exit(1)` 的判定**——
该组失败只打印、不判负（本轮用反向对照顺手验出来）。已补进判定，并把本阶段新增的 `[job-owner]` 一并接入。

**文档**：本条目；`README-CN.md` 限制一节版本号；版本 → **v0.4.25**。

---

---

### 遗留待开发

> **状态（2026-10-01 复核，v0.4.23 收尾后更新）**：下表 **10 项**（与表内行数一致）——`部分完成` 1 项（Starling demo 的分配器高水位）、`未开始` 7 项（TextField 断行阈值、Flappy csf=2 缩放、`SecureSocket` 的 TLS 状态机、`DatagramSocket`、AMF 编解码、**`[SWF]` 元数据丢弃**、**`fullScreenWidth` 取完整模式**）、`调研完成 · 实现暂缓` 2 项（SWC 资源提取、preview2 `wasi:http`）；每项都附可复现证据（实测输出 / 代码位置）。**本轮（2026-10-01，八十九·六十八）新增 2 项**（Flappy-Starling 双目标实测的副产物，均为「`adl` 能跑对、我们不忠实」的**遗留**而非增强）。**本轮（2026-10-01，八十九·六十二）再移出 1 项已完成内容**：`URLLoader`/`URLStream` 对 non-2xx 的**条件终态**（已按受控实测实现，见 §6.7.6）→ **阶段八十九·六十二**。**本轮（2026-10-01）清理**：3 项已收尾内容移出并入对应阶段（见下条注记），并把原先挂在 2 个「汇总行」里的唯一未收尾子项 **AMF** 提升为独立行（否则会随汇总行一起丢失）。`flash.net` 的 **A~I 主体（八十九·五十二）+ 套接字层与静态自包含（八十九·五十三）已全部落地**。
>
> **已完成项已从本表移出**，结论并入对应阶段（不再在本表重复）：`%=` 复合赋值、native/web 中间产物同名（`vendor/*.o`）→ **阶段八十九·三十三**；动态 `+` 的 `any+any` 语义、顶层「非声明位」`var` 的模块作用域 → **阶段八十九·三十四**；WASI `try/catch` 链接失败 → **阶段八十九·三十五**。密封类未知属性 `Error #1056`/`#1069`、`*` 承接数组的命名属性、`dynamic class` 建模、命名函数表达式、全可选参数构造器的 NULL factory → **阶段八十九·三十六**；顶层 `for-in`/`for-each` 循环变量的脚本作用域（阶段八十九·三十四 收尾时**主动保留**的子项）→ **阶段八十九·三十七**；重复求值审计（连带 `Boolean()` 引用语义与 NaN 真值）→ **阶段八十九·三十八**；循环条件 / `for` update 的重复求值（含连带发现的 null 归一化与 `typeof` 的 `function` 折叠）→ **阶段八十九·四十三**；MSL 单采样器限制 → **阶段八十九·三十九**；`flash.net.SharedObject` 未实现 → **阶段八十九·四十**（Flappy-Starling 的最后一个硬阻塞随之解除，其两项**渲染**残差仍留在表内）；Masks 场景被 `mask` 的对象未裁剪（遗留表原推测「stencil 状态未恢复」）内含的**字段遮蔽槽位合并** → **阶段八十九·四十四**；非 GUI 目标不自动回收（`gc_alloc` 无分配阈值）→ **阶段八十九·四十一**；该项的后续「阈值下限偏低（1 MiB）」→ **阶段八十九·四十七**（下限按路径二分：帧 1 MiB / 离屏 8 MiB，并缓存触发判定）；`ByteArray`/`BitmapData.pixels` 的字节缓冲 arena 泄漏 → **阶段八十九·四十二**（连同 `Context3D_submit` 临时缓冲缓存化；该行原附的「Sprite 3D 进出 12 轮 +3.7 MB/轮」归因经实测**更正**为分配器高水位，已改写为新行）；**异步 IO 是「假异步」（同步阻塞 + 事件派发推迟）** → **阶段八十九·四十五**（实测更正：停顿 99% 来自**同步解码**而非读；三个事件契约缺口一并修掉，native 改后台线程池、web/WASI 保持内联）；**`web` 帧率量化为刷新率整数分之一**（原表述「与 adl 的逻辑帧率口径不同」）经复核**不是待开发项而是已定的设计决策**——跟随 vsync 是本项目 native/web 两端的既定选择，与 adl 的差异属**口径不同**而非缺陷，结论并入 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §3 决策分歧点（**维持现状**；行为与理由另见 `docs/zh-cn/html5-web.md` §3.2/§6.4 与阶段八十九·二十九）。**`flash.net` 的「语义面 + `URLLoader` 契约」**（原遗留行的主体）→ **阶段八十九·四十八**（A/B 落地）；该项的 **G（无网目标诚实 `ioError`）+ C 的 native 竖直探针** → **阶段八十九·四十九**（`http(s)://` 显式识别 + opt-in libcurl 真传输）；**该探针揭示的构建层约束「`link-libs` 不按目标条件」** → **阶段八十九·五十**（清单 `targets` 按目标分层链接）。`URLStream`、web `fetch`、`navigateToURL` → **阶段八十九·五十一**（C 内核补全 + D/E/F/H）；AIR 语义保真校正 + 端到端验收 → **阶段八十九·五十二**。**本轮（2026-10-01）再移出 3 项已完成内容**：`flash.net` 的 **「HTTP 客户端 A~I 全部落地」汇总行**（已无残项）→ **阶段八十九·五十二**；**「`flash.net` 剩余重工程」汇总行里已落地的 3 项**（静态自包含、代理/cookie jar/HTTP-2、socket 层）→ **阶段八十九·五十三**（该行唯一的未收尾子项 **AMF** 已提升为下表独立行，故汇总行一并移出）；**web 构建里字体被重复打包**（已修复）→ **阶段八十九·五十八**。本表只留尚未收尾项。

| 遗留项 | 状态 | 说明 | 建议 |
|--------|------|------|------|
| `TextField.textWidth` 不含行尾空格（AIR 含） | 未开始（本轮实测发现，**与断行无关，是独立口径**） | 同字体同字号下 `textWidth` 对 `"Multitouch "`：AIR **133**（含 1 个空格 8.5px）、对 `"Multitouch  "` **141.5**；我们恒为 **124.945**（SkParagraph 不计尾部空白） | AIR 是权威（§1.5），该差异是**遗留**不是增强。**风险点**：Starling 的 `TrueTypeCompositor` 正是按 `textWidth` 定尺建 BitmapData，改动会**同时影响**它与 `textfield-align` 的居中期望值，须重跑 Starling 12 场景 + 相关 examples 才能收 |
| Starling demo 逐轮 RSS 上涨（**分配器高水位，非泄漏**） | 部分完成（字节缓冲已迁 GC、`Context3D_submit` 临时缓冲已缓存复用；RSS 上涨本身尚未定位到具体分配点） | 阶段八十九·四十二 实测更正：把 `ByteArray`/`BitmapData.pixels` 迁入 GC 后，同机同 harness 的曲线**斜率不变**（迁移前 175→206 MB / 12 轮，迁移后 175→202 MB），且 `as_big`（arena ≥1 MB）**0 条**、`leaks` **288 B**、活动 `malloc` 16.7→17.1 MB、GC 堆平（16 MB / 276 段）、`vmmap` 的 `MALLOC_MEDIUM/LARGE (empty)` 空区在 10~60 MB 涨落（每 8~10 轮返回一次）——即增长是**分配器高水位**（瞬时峰值捏住的内存不还 OS），既非活对象泄漏也非字节缓冲。注：当前 harness 菜单点击落不到按钮（窗口 640×1112 vs 渲染面 1800×1169，已知 `csf==2` Stage3D 缩放缺陷），该曲线**不含**场景进出 | 冻结语义下的可选优化：①逐帧临时缓冲尽量复用（已做 `Context3D_submit`，`ASC_stage3d_pixels` 仍 `malloc`/`free`）；②`free()` 后显式 `malloc_zone_pressure_relief()`（GC 段归还路径已做）；③若要根治需按分配点做采样（`vmmap -summary` + `MallocStackLogging`）。见 [`docs/zh-cn/gc.md`](docs/zh-cn/gc.md) §6.14 |
| SWC 资源提取 | 调研完成 · 实现暂缓（待用户决定） | 已调研（[`docs/zh-cn/swc.md`](docs/zh-cn/swc.md)，基于 `temp/skin.swc` 解包实测）：SWC 资源嵌于 `library.swf`（CWS）的 SWF tag（`DefineBitsLossless2`/`DefineBitsJPEG2` + `SymbolClass` → `BitmapData` 子类），提取链路 = ZIP 解包 → CWS 解压 → tag 扫描 → 像素/JPEG 字节。**2026-09-26 复核（v0.3.138）已就地校正该文档**：像素为**预乘** ARGB（字节序 A,R,G,B），AIR 读回时反预乘（`floor(stored*255/A + t)`，t∈[0.329,0.413)）→ 提取必须做反预乘；`BitmapData.pixels` 是 **straight ARGB**（非文档旧称的 RGBA）；16 个命名资源原始 1.48 MB → C 文本 ≈8.90 MB（须落独立资源 `.c`）；`small_gift`/`checkbom` 实为 `DefineSprite` 不属那 16 个。**同日追补复核（SWC 内的代码）**：`library.swf` 还有 **255 个 `DoABC` = 254 类 / 54,162 B AVM2 字节码**（含 `TweenLite`、`com.adobe.crypto.MD5`、JSON 解析器、Flex `mx.core`、自家组件库；按父类 192 `MovieClip` / 12 `BitmapAsset` / 4 `BitmapData`），本方案**只把 SWC 当资源容器**，代码属**范围外（不是「延后」）**——ABC 容器读取已解通（自写解析器对 **255/255** 模块 round-trip 精确吻合，自证正确），但字节码→可编译产物需反编译器或 AVM2 解释器，属另行立项；文档已补 §3.3 范围声明与 §3.3.3「用 `catalog.xml` 的 `<dep>` 做编译期早期诊断」 | **暂缓，后续用户决定再实现**（草案四步 = `src/swc.ts` 提取器（含反预乘，**只读资源、不解析 ABC**）→ 资源类注册 + 像素嵌入（含 `getDefinitionByName` 注册表）→ CLI/清单接入 → 读 `catalog.xml` 的 `<dep>`，对「引用了只以字节码存在于 SWC 的类」给出编译期报错（§3.3.3，不反编译））。**注意：早期草案占用的「阶段六十六~六十八」编号无效**，该三号已被其他已完成功能使用，实现启动时需另申请编号 |
| AMF 编解码（`URLStream.readObject`/`writeObject`、`registerClassAlias`/`getClassByAlias`） | 未开始（当前是**诚实失败而非错误实现**：本子集无 AMF 编解码器，`ObjectEncoding.AMF3` 只是文档默认值，`ByteArray` 同样缺 `readObject`/`writeObject` 这一对——见 `src/emit.ts:4681`/`src/symbols.ts:1312`） | AMF 是二进制**对象图**序列化（AMF0/AMF3 双版本 + 引用表 + trait 编码 + 别名注册表），与现有「对象当纯数据」的 `Dictionary`/record 反射表**不重合**，需独立编解码器。**语义面本身也没采集全**：`adl` 探针只测到空 `URLStream` 的 `readObject()` 抛 `#2029`（`temp/air-probe/air-probe-result.txt`）。原为 `flash.net` 两个汇总行的共有未收尾子项，本轮汇总行移出时**提升为独立行**以免丢失 | 独立立项：先用 `mxmlc + adl` 采全语义（别名注册表、AMF0/AMF3 切换、引用表、`ByteArray` 读写对、`writeObject` 的 `trait` 形状），再实现编解码器；验收用本地服务器**回放固定 AMF 字节**并与 `adl` 逐字节对照。**成本中**（编解码器本体 + 反射表对接） |
| `SecureSocket` 的 TLS 状态机 | 未开始（当前是**诚实失败**而非错误实现：`isSupported=false`、`connect()` 派 `#2031`） | 缺的是「非阻塞传输之上的 TLS 状态机 + AIR 的 `serverCertificateValidate` 握手回调」。可链接的现成 TLS 库与静态 curl 的取舍同源（`vendor/curl` 已把 nghttp2/zlib 静态化，TLS 后端仍是系统 SecureTransport）。**不实现比假装实现正确**——静默明文连接是最坏的失败模式 | 立项时改 `as_sock` 的连接状态机（CONNECTING 之后插入 TLS 握手态），并补齐证书事件面；验收用本地 TLS 服务器 + `adl` 对照 |
| `DatagramSocket`（UDP） | 未开始 | UDP 与 TCP 底座不同：无连接、无 `flush` 语义、`send()` 自带目标地址、`DatagramSocketDataEvent` 载荷是完整的 `ByteArray`。AS3 面（`bind`/`send`/`close`/`receive`）与实测语义均未采集 | 独立立项：先按 AGENTS.md §2.4 用 `adl` 采全部语义，再复用 `as_sock` 的注册表与帧边界泵（`SOCK_DGRAM` 分支） |
| preview2 `wasi:http`（WASI 原生联网） | 调研完成 · 实现暂缓（**本轮只侦察，未写一行代码**） | 侦察结论（均为本机实测）：① wasmtime **48.0.2** 支持 `-S http[=y]`、`-S inherit-network`、`-S tcp/udp`、`max-http-fields-size`（明示 wasi-http **0.2**），故**宿主侧已就绪**；② wasi-sdk-34 的 `share/wasi-sysroot/include/wasm32-wasip2/wasi/` **没有 wasi:http 头**（只有 `sockets`/`filesystem`/`clocks`/`random`/`io` 的 p2 生成头），故 bindings 需**手写 canonical ABI** 或用 **wit-bindgen** 生成；③ 无 `wit-bindgen`/`wasm-tools`/`cargo`/`rustc`（`command -v` 全部 MISSING），且 wasi-sdk 下**没有** `wasi_snapshot_preview1` adapter（`find -name "*adapter*"` 为空）——但二者**可经本机代理下载**（`github.com`/`api.github.com` 均 200，`codeload.github.com` 亦通）；④ 要跑 wasi:http 必须交付**组件**（`wasm-tools component new` + p2 adapter），而本项目现有 wasm 目标是 **wasip1 核心模块**，故还需在 `build.ts` 增一个 p2 目标与后处理步骤 | 立项时的完整链路（已明确）：① 下载 wasm-tools（aarch64-macos 预编译）+ `wasi_snapshot_preview1.command.wasm` adapter；② 取 `wasi:http@0.2.x` 的 WIT（`github.com/WebAssembly/wasi-http`）并用 wit-bindgen 生成，或手写 ~14 个 canonical ABI 导入（`types.new-*`/`set-method`/`append-header`/`outgoing-handler.handle`/`incoming-response.{status,headers,consume}`/`incoming-body`/`streams.read`/`drop`）；③ `build.ts` 增 `wasm-p2` 目标（`clang --target=wasm32-wasip2` + `component new --adapt`）与 `ASC_HAVE_WASI_HTTP` 宏；④ 在 `as_http_perform` 的第三后端里映射到 `handle`；⑤ 验收用本地 HTTP 服务器 + `wasmtime run -S http -S inherit-network`。**风险**：手写 canonical ABI 的 `result<incoming-response, error-code>` 落地下标与 `option<resource>` 的哨兵值必须精确，错一处即 trap；故优先走 wit-bindgen 生成而非手写 |
| Starling 在 `contentScaleFactor ≠ 1` 时 Stage3D 层被重复放大（只露左上 1/4） | 未开始（本轮实测记录：`examples/Flappy-Starling` 的 AOT 产物在 `csf=2` 下只见舞台左上 1/4 且放大 2×；改 `ScreenSetup` dpi 使 `csf=1` 则整屏正确） | 阶段八十九·十九 定的合成口径是「源=物理尺寸、目标矩形=`ASC_stage3d_lw/lh`（逻辑 stage 单位）、由 canvas 设备缩放还原到物理像素」。该口径在「AS3 侧把**像素**尺寸传给 `configureBackBuffer`」时会把设备缩放叠加两次：Starling 的 `_clippedViewPort` 就是像素单位（`Starling.as:505` → `Painter.as:247`），且它按 `_supportHighResolutions`（Flappy 未开）传 `wantsBestResolution=false`。探针实测 `configureBackBuffer req=375x667 best=0 bbScale=1 -> bb=375x667`，同轮 `ASC_window_render` 的 blit（`emit.ts:7323`）未触发——Metal Stage3D 层直画 drawable，缩放不受 2D 画布 CTM 管辖，需按 Stage3D 自己的视口/投影口径核对 | 先查 Metal 后端（`vendor/stage3d_glue.mm` + `ASC_window_render`）在 `csf≠1` 时的实际绘制矩形与投影：AIR 的语义是「后台缓冲像素尺寸 = 视口像素尺寸」（本机 750x1334），而舞台 375x667 只是逻辑坐标——即 `bbw/ASC_win_scale` 才等于逻辑尺寸。修法与验收：用 `examples/air-starling-demo`（`csf=1`，当前正常）做零回归对照 + Flappy 的 `csf=2` 场景做「整屏可见」断言 |
| `[SWF(width,height,backgroundColor)]` 元数据被解析后**丢弃**（`stage.stageWidth/Height` 与舞台底色两处不忠实） | 未开始（**本轮实测发现**，八十九·六十八；`src/parser.ts:215` 的注释「no runtime effect」经实测推翻） | 受控实验（同一探针、只切元数据、`adl` 桌面档）：无元数据 `stage=500x375`（mxmlc 默认 SWF 尺寸）；加 `[SWF(width="320",height="480")]` → `stage=320x480`。即 AIR 的 **`stage.stageWidth/Height` = SWF 声明尺寸**，我们 = **窗口尺寸**（探针 1600x1000；`examples/Flappy-Starling` 的 `[SWF(width="320",height="480",frameRate="60",backgroundColor="#d1f4f7")]` 因此无效）。**同一根因的第二处可见差异**：adl 画面底色 `#d1f4f7`、我们白 | 独立立项（**动它会改所有 GUI 示例的布局**，须连 Starling 12 场景一起回归）：①`ast.ts` 增加 SWF 元数据载体（现在 parser 解析后直接丢）；②`air-app.ts` 把元数据透传到 `BuildConfig`；③运行时以「元数据优先、缺省回退窗口尺寸」定 `stage.stageWidth/Height`，底色同上。`frameRate` 是否一并生效需另行实测（当前口径见 §3 决策分歧点）。**判据（§1.5）**：`adl` 能跑对而我们跑不出 ⇒ **遗留**，非增强 |
| `Stage.fullScreenWidth/Height` 取「完整显示模式」而非 AIR 的「可用区」 | 未开始（**本轮实测发现**，八十九·六十八） | 同机同刻三端对照：`adl` **1800x1137** vs 我们 **1800x1169**（同一显示器时 Δ = 32 = 菜单栏高度）；换到外接显示器后 `adl` 报 **2560x1408**（= 2560x1440 − 32），规则**跨两种显示模式复现**。即 AIR 取**窗口所在显示器的可用边界**，我们取 `SDL_GetCurrentDisplayMode`（display 0 的完整模式）。**多显示器下两者甚至不在同一块屏**（native 报内建 1800x1169、adl 报外接 2560x1408），修复须一并考量「窗口在哪块屏」——这与当前实现的「总是 display 0」是两件事。web 侧同源：我们读 `window.screen`（无头 Chrome 实测 800x600，真实浏览器则是整屏尺寸），而舞台其实只有 canvas 那么大 | 独立立项：native 侧把 `SDL_GetCurrentDisplayMode` 换成「窗口所在显示器的可用边界」（`SDL_GetDisplayUsableBounds` + `SDL_GetWindowDisplayIndex`），web 侧把 `window.screen` 换成 `screen.availWidth/availHeight`。**注意**：`Starling` 的 `ScreenSetup` 正是按这两个值定世界尺寸（`examples/Flappy-Starling` 的布局即由此而来），改动会连带影响所有 GUI 示例与 Starling 场景 ⇒ 与上一行**同批回归** |

---

### 增强待做

> **与「遗留待开发」的区别**：上表是**欠账**（AIR 有、我们没有，或我们有但不忠实——`adl` 一跑就知道差在哪）；
> 本表是**增益**（AIR **本来就报错、或压根不存在**，我们做出来才算增强）。判据与五条入库标准见
> [`docs/zh-cn/enhancements.md`](docs/zh-cn/enhancements.md) §1/§2；原则亦见
> [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §4。
>
> **状态（2026-10-01，v0.4.23）**：下表 **15 项**，已完成 **3 项**、未排期 12 项。增强的**开启方式已统一为具名开关**
> （`--features`，见八十九·六十七与 [`enhancements.md`](docs/zh-cn/enhancements.md) §1.4）；当前只登记已端到端实现的
> `svg`（E1），E2/E4 实现后再登记（登记未实现的开关就是「看着开了、实际没编进去」）。
> **已完成**：**WebP/BMP/ICO 解码**（阶段八十九·六十三，实测**零代码**可用——两端 `SkCodec` 本就编入
> `libwebp_decode`/`wuffs`，走的是与 PNG/JPG 同一条通道；`QOI` 不在内）、**LTO/PGO 构建开关**
> （阶段八十九·六十四，清单 + CLI 两条路，默认全关）与 **SVG 运行时解码 native 半**
> （阶段八十九·六十五，opt-in 具名开关 `--features svg`；web 无 svg/sksg/expat 库故不支持）。其中 SVG / Lottie / RAW-DNG 的 **native 侧库已构建
> 且已在链接表**（只是无人引用，被 `-O2` 的调用图分析剥掉）。实现任何一项都须 **opt-in**
> （默认产物保持与 AIR 同构）并过 AGENTS.md §4 的 DoD。

| 增强项 | AIR 现状 | 目标端 | 成本 | 状态 |
|--------|---------|--------|------|------|
| **SVG 运行时解码**（`Loader.load("*.svg")` → `Bitmap`） | ✗ 从不支持（`adl 51.4.1` 实测 `#2124`） | ✅ **native 已实现、opt-in**（具名开关 `--features svg`；四条解码入口全支持，含 `<text>`/相对尺寸）；web 无 svg/sksg/expat 库，不支持 | — | **已完成（八十九·六十五）** |
| **Lottie 矢量动画**（Skottie 播放 `.json`） | ✗ 无对应物 | native：`libskottie.a`+`libskresources.a` 已构建+已链接，缺播放器 API；web：需重编 | 中 | 未排期 |
| **WebP / BMP / ICO 解码** | 部分：仅 JPG/PNG/GIF（`adl` 对三者报 `#2124`） | ✅ **已具备、零代码**（两端实测全部解码正确；`QOI` 未编入 `SkQoiCodec`，不含在内） | — | **已完成（八十九·六十三，实测确认）** |
| **相机 RAW / DNG 解码** | ✗ | native：`libpiex.a`+`libdng_sdk.a` 已构建；web：需重编 | 低-中 | 未排期 |
| **矢量图形直接上屏**（`Shape` 走 `SkPath`） | ✗（`BitmapData` 只有位图） | 两端 | 中 | 未排期 |
| **原生着色器直通**（MSL / GLSL ES） | ✗（只有 AGAL） | 两端 | 中 | 未排期 |
| **GPU 通用计算**（Metal compute / transform feedback） | ✗ | 两端 | 高 | 未排期 |
| **无窗口 / 服务端出图** | 半（可离屏，但绑死 AIR 运行时） | 两端 | 已有（headless + `stage.render()` 出 PNG） | 已有 |
| **64 位整数**（`int64`/`uint64`） | ✗（`int`/`uint` 均 32 位） | 两端 | 中 | 未排期 |
| **`Vector.<Number>` 批量 SIMD**（NEON/SSE） | ✗ | 两端 | 中-高 | 未排期 |
| **FFI：声明并直调宿主 C 函数** | ✗ | native（「直接转 C」的独有红利） | 中 | 未排期 |
| **真并发 `Worker`（OS 线程）** | 部分（AIR Worker 受限） | native（已有 4 worker 池，目前只服务异步 IO） | 中 | 未排期 |
| **LTO / PGO 构建开关** | — | 两端 | 低 | **已完成（八十九·六十四）**：清单 `lto`/`pgo`/`pgo-dir` + CLI `--lto`/`--pgo`/`--pgo-dir`，默认全关；`-flto` 逐步骤断言 + 反向对照（4 变异全捕获） |
| **帧录制 / 确定性重放** | ✗ | 两端 | 中 | 未排期 |
| **可读 C 作为一等交付物**（嵌入宿主工程 / 人工审改） | ✗ | 两端 | 已有（README 已承诺） | 已有 |

---

## 备注

- 每个阶段完成后：**回归运行 `examples/` 下所有旧示例**，确保不破坏已有功能；更新 README；版本号按 patch 小版本递增（`v0.4.0 → v0.4.1 → v0.4.2 → …`，自 v0.4.0 起；此前为 v0.3.x），避免 minor 版本过早逼近 1.0.0。
- 每个新特性必须配一个 `examples/*.as` 示例 + 断言式回归，否则视为未完成（AGENTS.md DoD）。
- 实现任何新特性前，先查 [AS3 语言参考](https://airsdk.dev/reference/actionscript/3.0/) 的真实语义，尤其注意 AS3 与 C 的语义差异（`/` 恒 Number、字符串装箱、`Number` 默认 NaN 等），把差异写进注释再编码。
