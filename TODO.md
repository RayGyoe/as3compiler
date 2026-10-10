# as3compiler — 分步实现路线图

> 目标：参照 TypePHP（把 PHP 编译成原生二进制的 AOT 编译器）的思路，实现一个 AS3 编译器：
> `ActionScript 源码 → 词法/语法分析 → 生成可读 C → 交给 clang/cc 编译成原生可执行文件`。
> 编译器前端只负责"翻译"，优化与机器码生成交给成熟的 C 编译器，不重复造轮子。

---

## 当前状态（v0.4.52）

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
      > **补记（2026-10-10）**：本注已过期 —— 开发机现已换为 **Windows**，且 `_WIN32` 下的 runtime/glue 已实机**编过、链过、跑通**（阶段一百二十六 的「未验证」段已收口，见该节）；此处的 `System.privateMemory` Windows 分支随 `air-native` 一起进了 Windows 产物并链接成功。
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
  - **2026-10-06 音频调研完成并立项**（[`docs/zh-cn/audio.md`](docs/zh-cn/audio.md) / [`docs/en/audio.md`](docs/en/audio.md)，**阶段九十六**）：现状是阶段九十三留下的**空壳**（`play()` 恒返回空 `SoundChannel`、`loadCompressedDataFromByteArray`/`stop` 为 no-op），全仓无音频后端与解码器。**关键实测**：vendored SDL2 未编 CoreAudio（`libSDL2.a` 只含 `SDL_dummyaudio.o`，`nm` 零 AudioUnit 符号）⇒ `SDL_OpenAudioDevice` 会成功返回但**永不发声**，故后端点需另选。已裁决后端 = **miniaudio**（单头文件、一处覆盖 CoreAudio + Emscripten Web Audio、内置 MP3 解码）、范围 = **A~D 全量**（`[Embed]` 缺口独立延后）。属**补遗留**非增强。
- [x] `flash.ui`：**Keyboard**（键码常量子集 + `isAccessible`）、**Mouse**（静态 `hide`/`show` + 只读 `cursor`/`supportsCursor`/`supportsNativeCursor`）

**验收**：`examples/stage63.as`（离屏）断言 `URLRequest` 值束与默认 `method`、`URLLoader` 异步读文件成功/失败两路事件（`tickTimers()` 泵）、`URLVariables` 动态属性 + `toString()`、`Keyboard` 键码常量与 `isAccessible`、`Mouse` 静态方法。✅（73 passed / 0 failed；
`Socket`、`Sound`/`SoundChannel`/`Video`、`ContextMenu` 延后（依赖网络套接字/音视频解码/原生菜单后端），
`URLLoader` 为异步本地文件读（`as_set_timeout(0)` 模拟异步，非真实 HTTP），README 已注明）

#### 阶段六十四：`air.*` 桌面运行时（目标 v0.3.64 → v0.3.65）【P3】✅ 已完成

**依据**：AIR 是 Flash 之外最大的独立命名空间，完全独立于显示/事件体系，重活且工作量大，排最后。

- [ ] **Window**/**NativeWindow**（对应 `window_glue.cc` 的多窗口/原生窗口管理，**2026-10-02 已实现**——多窗口运行时注册表、每窗独立 `Stage` 与 `Event.CLOSE` 见 **阶段八十九·七十一**，其关闭窗口崩溃的布局缺陷见 **阶段八十九·七十二**；`Window`（`flash.desktop` 的包装）仍延后）
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
- `||=`/`&&=` 必须排在 `||`/`&&` 之前：`MULTI_SYMBOLS` 顺序匹配，`||` 在前会把 `||=` 抢先拆成 `||` + `=` → `unexpected token '='`。
- 全限定名需归一化：classMap key 是 `sanitizePkg` 后的下划线 FQN（`flash_display3D_textures_Texture`），点分名是 `flash.display3D.textures.Texture`，`resolveType` 不做归一化则 `hasClass` 恒失败 → `unknown class`。
- `for each` 无 `var` 迭代进 module 变量时，C 名必须是 `g_x`（`emitVar` 返回）而非 `x`（`cIdent`），否则 `undeclared identifier`。
- namespace 透明化后 `ns::method()` → 普通方法调用、`Class.ns::static()` → 静态调用，无运行时可见性语义（AOT 编译期已定序，符合 AS3 编译期解析命名空间的本质）。

**验收**：新增 `examples/stage88.as`（9 特性全覆盖：字符串键 / `||=`·`&&=` / for each 无 var / `:*=` / `new <T>[]` / Error 二参 /
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
- `===`/`!==` 必须排在 `==`/`!=` 之前，否则 `===` 被抢先拆成 `==`+`=` → `unexpected token '='`（与 `||=` 先于 `||` 同款教训）。
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

**语义红线（关键坑）**：AS3 `&&`/`||` 返回操作数值而非布尔（对象引用的「null 合并」惯用法 `_parent || _maskee` 不能译成 C 布尔）；方法调用接收者必须是单一求值（vtable 查找与 `this` 实参复用同一表达式会二次求值）；字段默认值在 `gc_alloc` memset 后已就位，只有 `Number` 的 NaN 需要显式补；`context3DCreate` 在 AIR 里是异步派发（下一帧），同步派发会打乱 `new Starling(...)` 后注册监听器的时序。

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
- **WebGPU 判定复核（2026-10-08，v0.4.89 复核，结论维持 · 无代码改动、不升版本号）**：用户复问「web 版用 WebGL 是否支持 WebGPU、性能会更好吗」，逐项重测后**维持**上述判定，且被阶段八十九·三十一 **加强**。① **仍不支持**——wasm 版 Skia 未编任何 WebGPU 路径（`build-tools/skia-src/out/wasm/args.gn`：`skia_use_webgpu=false` / `skia_enable_graphite=false` / `skia_use_dawn=false` / `skia_use_webgl=true` / `skia_enable_ganesh=true`），二进制侧复核一致：`nm -g vendor/skia/lib/wasm/libskia.a | grep -c dawn` = **0**、`GrDirectContext` = 306（只有 Ganesh）；web 侧 `vendor/stage3d_webgl.cc` 的 webgpu 提及 = **0**，构建固定 `-s MAX_WEBGL_VERSION=2`（`src/build.ts:873`）。② **不会更快**——瓶颈是 rAF/面板刷新率而非渲染器：修后 GPU 路径 120 Hz 屏 **120 fps / 0 丢弃 / 单帧 0.113 ms = 帧预算 1.35%（余量 ≈74×）**，且阶段八十九·三十一 把 Stage3D 上屏改 GPU 直连后 `renderMs` **3.21 → 0.12~0.15 ms（≈23×）**；50 Hz 屏那行证明软件层越不过面板。WebGPU 的真实增量在**每 draw call 的 CPU 开销**与 **compute**（外部 A/B ≈3× / ≈50×；「轻量 2D 场景四大 API 几乎无差距」），与本仓负载画像不匹配。③ **真要上的代价**——不是换后端而是换 Skia 引擎：Ganesh **无** WebGPU 后端（只有 GL/Vulkan/Metal/D3D）⇒ 须迁到 **Graphite + Dawn**，并为 wasm32 拉 Dawn 重编 + 升级 Emscripten（现 **3.1.44**，其 WebGPU 支持不成熟） + 新增第三个 Stage3D 后端（`stage3d_webgpu.cc`）；且 WebGPU 用 **WGSL**，与增强项 E6 在 web 侧的目标 **GLSL ES** 不同路。**重启评估的量化触发条件（用 `renderMs` 量，不靠感觉）**：`renderMs` 逼近帧预算、或 draw call 涨到几千/帧且 CPU 受限、或出现需要 compute / 多线程录制的 AS3 负载。观察点（**非 WebGPU 机会**，文档已归因 demo 逻辑）：Starling `Benchmark` 在 web 上「对象数停在 0」。

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

#### 阶段八十九·六十三：多格式图片解码实测 —— E3（v0.4.18 → v0.4.19，零代码）  → **注意：其默认行为已于阶段九十四·二十五改为「默认拒绝 + `--features formats`」**

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

#### 阶段八十九·七十一：AIR 多窗口 `NativeWindow` 家族 + `flash.display.Screen`（v0.4.25 → v0.4.26）

**立项根据**：`examples/air-native` 新增的 `NtWindow.as`/`windowTest.as` 把「AIR 多窗口」从**从未立项**变成**硬编译阻塞**——
`node ../../src/index.ts --air-app ./air-native-app.xml --target native` 直接报 `unknown superclass 'NativeWindow' of 'demo_windowTest'`，
而 `mxmlc + adl 51.4.1` 能真的开出第二个窗口（截图存档）。按 AGENTS.md §1.5 判据（`adl` 能跑对、我们跑不出）这两项是**遗留**而非增强，
原在 `### 遗留待开发`，本阶段**移出**并落地。

**一、先采权威语义再动手**（`temp/nw-probe/`，`mxmlc` 编译探针 + `adl` 实跑 + 截图）：

| 量 | `adl 51.4.1` 实测 | 说明 |
|---|---|---|
| `new NativeWindow(opts)` 返回时 | `visible=false`、`active=false`、`closed=false`、`title=""` | **构造器即开窗**，但要显式置 `visible` 才出现 |
| 默认几何 | 框 400×232、客户区 400×200，**居中于显示器**（1800×1169 → 700,469） | 32pt = macOS 标题栏，属框的一部分 |
| `NativeWindowInitOptions` | `standard`/`normal`/`auto`/`transparent=false`/`maximizable=minimizable=resizable=true`/`owner=null` | 八个默认值逐个对齐 |
| 每窗 `stage` | `!= null`，`scaleMode="showAll"`、`align=""`；`frameRate` 读回的是**应用级**当前值（默认 24；实测把主窗口设为 4 后新窗口也报 4） | 新窗口**没有**自己的帧率——阶段八十九·七十三 更正（原记录把它读成「每窗的 24fps 默认值」；初始窗口启动时读 0 是 vsync 口径，不是另一个值） |
| `x/y/width/height` | 是 `bounds` 的**代理**（设 `x=100` 只动 `bounds.x`） | 不是 Sprite 那种变换偏移 |
| `close()` | 调用后**立即读 `closed` 仍为 `false`**，约 500 ms 后才 `true` 且派发 `Event.CLOSE` | 异步收尾，**不得在调用点同步销毁** |
| 静态面 | `isSupported`/`supportsTransparency`=true、`supportsMenu`/`supportsNotification`=false | 并有 `NativeWindow.stage`（静态）等 mxmlc 报未定义的成员——按「不存在」建模 |
| 常量类 | 小写字符串（`STANDARD="standard"`、`NONE="none"`、`AUTO`/`DIRECT`、`MINIMIZED`…） | `NativeWindowResize.NONE` 是**空串**（其余是 `StageAlign` 那套 `T`/`BR` 码） |
| `Screen` | `mainScreen.bounds`=`0,0 1800x1169`、`visibleBounds`=`47,39 1753x1130`、`colorDepth=32` | `bounds`（完整模式）与 `visibleBounds`（可用区）是**两个不同的量** |
| `Screen` 引用语义 | `Screen.screens[0] == Screen.mainScreen` → **false** | 每次访问返回**新的包装对象**，不能缓存单例返回 |
| `getScreensForRectangle` | 单参静态方法（**没有** `getScreens()`），按 `bounds` 做**半开区间**相交 | 零面积/仅贴边 → 匹配不到 |
| `new Screen()` | `Error #2012: Screen$ class cannot be instantiated.` | 不可构造 |

**二、运行时从「单窗口」改造成「窗口注册表」**（`vendor/window_glue.cc` + 生成的 `ASCWin`）：

- glue 侧 `#define SK_MAX_WINDOWS 16` + `WinCtx g_wins[]`：每窗一个 `SDL_Window`、自己的渲染器/流纹理、自己的 `visible`/`dirty`/`destroy_pending`，
  以及**从 `NSWindow` 量出的边框**；`sk_run_loop` 逐窗派发 `on_frame`（各按自己的 `on_frame_delay` 配速）与 `on_redraw`/present；
  `sk_service_destroy` 在**每轮循环开头**收尾上一帧请求关闭的窗口。
- **槽位 0 保留给主窗口**（`sk_alloc_slot_ex(is_main)`）：`new Main()` 跑在 `showWindow` **之前**，文档类构造器里 `new NativeWindow()`
  本来会抢走槽 0，让主窗口变成「第二个窗口」。
- 生成的 C 侧 `#define ASC_MAX_WINDOWS 16` + `ASCWin ASC_wins[]`（**与 glue 的常量必须相等**，回归钉子盯着这一条）：
  每窗存 `Stage*`、表面/画布、设计尺寸/逻辑尺寸/像素尺寸、`scale`、渲染变换（`cx/cy/ox/oy`）、全部窗口属性与 `closed`。
- **`NativeWindow` 对象只持一个 `int _win`**，其余**一律反查表格**（不镜像任何 AS3 字段）。这不是审美问题：镜像字段在 OS
  改窗口之后就是陈旧数据——本轮实测正是 `alwaysInFront` 的 getter 读镜像字段、setter 只写 glue（两份状态立刻分叉）；
  早期还因为一个手写的 `used` 存活标志与 glue 不同步，把 `Event.CLOSE` 整个吞掉。**表格 + 单一 id 之后这类 bug 不再可能**。

**三、本阶段最贵的缺陷：副窗口**没有**回调，是个「黑色但各项属性都正确」的窗口**

- 现象：第二窗口开出来了（标题、位置、尺寸、`visible`/`active` 全对，与 `adl` 逐项一致），但**内容是纯黑**。
- 定位（临时插桩，非猜测）：在 glue 的 present 前后打印 `id`/`tex`/`pixels` 后，日志只有 `DBG redraw id=0`——
  **`id=1` 一次 redraw 都没有**，也**没有** `attach`。对照 glue 源码：`on_redraw`/`on_frame`/`on_mouse`/`on_close`/`on_resize`
  这一套回调**只在 `sk_window_show`/`sk_window_show_metal`（主窗口路径）里赋值**，`sk_window_create` 从来没装过 ⇒
  `c->on_redraw == NULL` ⇒ 永不光栅化、永不 present；`on_frame == NULL` ⇒ 副窗口的 `Stage` 永不 tick；`on_mouse == NULL` ⇒
  窗口内点击无响应；`on_resize == NULL` ⇒ `do_resize()` 会在**不重新取像素指针**的情况下重建纹理（越界读的隐患）。
- 修法（把「创建即带回调」写成签名的一部分，而不是「先创建后安装」）：`sk_window_create` 增加七个回调参数并与
  `sk_window_show*` 对称赋值；`runtime.ts` 的 `as_window_create` 透传它们；生成的 `NativeWindow_ctor` 传入
  `ASC_window_on_mouse/wheel/redraw/frame/frame_delay/resize/close`。**副作用是好的**：把回调从调用点拿掉不再是
  「能编译的黑窗」，而是**编译失败**（签名要求七个实参）；只剩「显式传 `NULL`」这一种劣化方式，而它被钉子钉住。
- **教训（写进回归注释）**：这个缺陷**只有「它被画出来了吗」这一条探针能发现**——`bounds`/`title`/`visible`/`active`/`closed`
  全部与 `adl` 一致。故 `[native-window]` 的第一组断言就是「七个回调都在创建点传入」+「glue 确实安装它们」。

**四、`Screen` 的四个「想当然就会错」的点**（每条一个钉子）：① getter 必须**新建**包装对象；② `bounds` 与 `visibleBounds`
是两个查询（`SDL_GetDisplayBounds` vs `SDL_GetDisplayUsableBounds`）；③ 匹配用 `bounds` 且**半开**；④ 不可构造
（`#2012` 原文）。另：缓存的 `Rectangle` 必须进 props 反射表，否则一次 GC 就能收掉活着的 `bounds`。

**五、验收**：

| 检查项 | 结果 |
|---|---|
| AOT 探针 vs `adl`（`temp/nwtest/`，同机同刻） | 逐行一致：默认值/几何/`stage` 三属性/`x,y` 代理/`close` 延迟/常量类/静态面（唯一差异是探针自己多打的几行，以及 `adl` 探针里 `*0.5 ^ 0` 的 int32 取整） |
| 端到端点击验收（`examples/air-native`） | 激活窗口后真鼠标点击红块 → `new windowTest()` → 开出「Test Open Widnow」第二窗口，`bounds=600,379 600x410`、`stage=600x378`、**内容为白**（截图 `temp/nwtest/final-second.png`） |
| web 目标 | `--target wasm --package web` 下 `NativeWindow` 构造器抛 `#2012`（`sk_window_create` 返回 `-1`），页面不崩（`ascErrors: []`） |
| 全量回归 | `node test.ts` **125 passed / 0 failed**、退出码 0（本阶段前那一项 FAIL 即 `unknown superclass 'NativeWindow'`） |
| 新增钉子 | `[native-window]` **26/26**、`[screen]` 全部 PASS |
| 反向对照 | **3 个变异全部被捕获且 `process.exit(1)` 生效**：① 调用点传 `NULL` 替代 `ASC_window_on_close` → 对应钉子 FAIL；② glue 的 `SK_MAX_WINDOWS` 从 16 改 8 → 常量一致性钉子 FAIL；③ `NativeWindow_close` 顺手把 `w->closed = 1` → 「延迟收尾」钉子 FAIL |

**六、实施过程中实测暴露的 4 个新缺口（已记入 `### 遗留待开发`）**：`Sprite.graphics` 不存在
（`s.graphics.beginFill(...)` → 编译期 `undefined field 'graphics' on class 'Sprite'`，验收用例被迫改成「Sprite 当命中目标 +
Shape 子对象绘图」）；`Shape`/`Bitmap` 的 `width`/`height` 是纯字段（AIR 由内容边界推导且只读）——「只画不设尺寸」即
`0x0` 不可点（改写前的 `NtWindow.as` 正是这种写法）；`as_pick_hit` 递归时不做父→子坐标变换（只有 `x/y` 已是绝对坐标的对象可点，
本轮红块坐标因此直接放在命中对象上）；`NativeWindow` 家族**剩余**方法/事件/属性面（`startMove`/`startResize`/`owner` setter/通知/菜单/
`Stage.nativeWindow`/`NativeApplication.openedWindows`/`ACTIVATE`·`DEACTIVATE` 与 MOVING…CLOSING 事件族）。

**七、顺手修掉一个测试基建缺陷（治本）**：`test.ts` 的目录型示例（`examples/air-native`）会把产物写进**示例源码树**
（发现时留着 `examples/air-native/src/demo/ArrayDemos` 与 `.c` 两个孤儿）。现改为统一输出到 `temp/regress-out/<label>-<seq>`
（`SCRATCH` + `scratchOut(label)`），并新增 `[no-src-litter]` 钉子：每个目录型示例运行前后快照 `readdirSync`，**多出任何文件即 FAIL**。
既有的两个孤儿已删除。

**八、一个次要发现（非缺陷，记录备查）**：发射器给每个构造器参数固定命名 `o`（`Main_ctor(Main* o)`），故构造器里写
`var o:...` 会被参数静默遮蔽——**非法 AS3**（`mxmlc` 报错），我们的 codegen 接受并在生成 C 上报错。属「宽松」而非「错误翻译」。

**文档**：本条目；`README-CN.md`（支持表补 `NativeWindow` 家族 + `Screen`、`flash.filesystem` 一节的「NativeWindow 延后」表述更正、
「当前限制」新增多窗口条目）；`TODO.md` `### 遗留待开发`（移出 2 项、新增 4 项，状态改为 14 项）。版本 → **v0.4.26**。

---

#### 阶段八十九·七十二：关闭 `NativeWindow` 第二窗口即崩溃 —— 超类被错标为 `Object`（应为 `EventDispatcher`）（v0.4.26 → v0.4.27）

**立项根据**：阶段八十九·七十一 落地的验收用例（`examples/air-native` 的 `NtWindow` 点击 → 第二窗口「Test Open Widnow」）**开窗全对、关窗即崩**。
用户提交的崩溃报告（macOS 26.6.2 / arm64）：

```
Exception Type: EXC_BAD_ACCESS (SIGSEGV)   KERN_INVALID_ADDRESS at 0x0000000000000020
0  EventDispatcher_dispatchEvent + 96
1  ASC_window_on_close + 140
2  sk_service_destroy() + 200
3  sk_run_loop() + 168
4  sk_window_show_metal + 564
5  Stage_showWindow + 232
6  main + 552
```

**一、根因：`NativeWindow` 的 `superClass` 写成了 `Object`**

AIR 里 `flash.display.NativeWindow extends EventDispatcher`（窗口要能派发 `Event.CLOSE`/`ACTIVATE` 并接受 `addEventListener`），
而 `src/symbols.ts` 注册时写的是 `superClass: 'Object'`。超类决定**结构体布局**，于是：

```c
// 错：{vtable; int _win}                // 对：{vtable; as_object* listeners; Object* parent; int _win;}
```

而 `EventDispatcher_dispatchEvent()` 按 `EventDispatcher` 的布局读字段——`listeners` 在偏移 **8**、`parent` 在偏移 **16**：

| 读 | 想要 | 实际拿到（`Object` 超类时） |
|---|---|---|
| `((EventDispatcher*)obj)->listeners` | 监听器表 | **`_win`（一个 int，如 `1`）**——被当成 `as_object*` 用 |
| `((EventDispatcher*)obj)->parent` | 父对象 | **越过 16 字节分配之外**（`sizeof` 只有 `{vtable, _win}` = 16） |

`as_disp_parent()` 拿这个越界指针当父链往下走，很快解引用到 `0x20`（NULL + 偏移）⇒ `KERN_INVALID_ADDRESS at 0x20`。
崩溃点 `+96` 正是 `dispatchEvent` 开头那几行（取 `event->target` / 建祖先链）。

**二、为什么一路没被拦住：所有派发点都是 `void*`**

`ASC_window_on_close` 里是 `EventDispatcher_dispatchEvent(w->window, …)`，而 `ASCWin.window` 是 `void*`（表格字段）；
另一个同类派发点是 ENTER_FRAME 注册表 `EventDispatcher_dispatchEvent(as_ef_objs[i], evt)`——同样是 `void*`。
**C 编译器在两处都无法做类型检查**，所以这个错误只能由「布局断言」或「真点一次关闭按钮」发现。
顺带被这次错标一起削掉的还有：窗口的 `addEventListener`/`removeEventListener`/`hasEventListener`/`willTrigger`/`dispatchEvent`
在 vtable 里**根本不存在**（AIR 有），以及 GC 的 props 反射链不含 `EventDispatcher_props` ⇒ **窗口自己的监听器表从不被标记**
（一个挂着监听的窗口，其监听器对象随时可能被回收）。

**三、修法（两处，缺一不可）**

1. `src/symbols.ts`：`NativeWindow` 的 `superClass` 改为 `'EventDispatcher'`（字段布局、vtable 祖先链、GC props 链三件事同时归位）。
2. `src/emit.ts` 的 `NativeWindow_ctor`：**补上** `EventDispatcher_ctor((EventDispatcher*)o);`。
   自动生成的自定义类构造器会调父构造器，但内置类的手写构造器**不会**——只改超类而不补这一行，`listeners`/`parent`
   就是分配里的残留字节，等于换了种方式的同一个崩溃（故两处缺一不可）。

**三之补、顺带修好的两件事（同一根因）**：窗口从此刻起有了真正的监听器 API（`addEventListener`/`dispatchEvent` 等在 vtable 里出现），
且 GC 的 props 反射链经过 `EventDispatcher_props` ⇒ **窗口自己的监听器表会被标记**（之前挂着监听的窗口，其监听器对象可能被静默回收）。

**四、验收**：

| 检查项 | 结果 |
|---|---|
| 反向对照（把修复从**生成的 C** 里手工还原成缺陷形态再编） | **复现出与用户报告逐帧一致的崩溃**：同一条栈（`EventDispatcher_dispatchEvent` ← `ASC_window_on_close` ← `sk_service_destroy` ← `sk_run_loop` ← `sk_window_show_metal`）、同样的 `exception codes 0x1, 0x20` / `KERN_INVALID_ADDRESS at 0x20`；harness 判定 FAIL、`exit=1` |
| 修复后真鼠标验收（激活窗口 → 点红块开第二窗口 → 点它的关闭按钮） | 第二窗口内容探针 `(255,255,255)`（**已绘制、非纯黑**）、点关闭后进程**存活**、第二窗口消失、主窗口仍在 ⇒ `PASS`（harness `temp/nwfix/drive_close.py`，一次跑完盖两个缺陷的判据，退出码 0；用法与两条必踩坑见该目录 `README.md`） |
| 新钉子 | `[native-window]` **26 → 31** 项：布局（`listeners`+`parent` 在 `_win` **之前**）、vtable 超类、构造器先建基类部分、`Event.CLOSE` 走基类派发器、以及**全程序扫描**（凡 vtable 里带 `EventDispatcher_dispatchEvent` 的类，其结构体必须带 `listeners`+`parent`；测试程序里 **35** 个类） |
| 反向对照（**钉子本身**） | 把源码改回 `Object` 超类并删掉基类构造调用 → 3 条钉子 FAIL、`node test.ts` **exit=1**；还原 → `exit=0`、全文 0 条 `FAIL` |
| 全量回归 | `node test.ts` **125 passed / 0 failed / 125 total**、`exit=0`（含 `[screen]` 全绿） |
| 端到端（`examples/air-native`） | 重建并跑通全部 demo；单窗口路径零回归 |

**五、教训（已写进 `checkNativeWindow` 的注释）**：**「超类」在本项目里不是文档措辞而是布局契约**。
凡把 `void*` 目标交给 `EventDispatcher_dispatchEvent`（窗口表、ENTER_FRAME 注册表、定时器表）的地方，C 编译器一律沉默，
所以「AIR 里它继承谁」必须与 `struct` 前缀一起被钉子钉住——本阶段补的全程序扫描就是这个不变式的通用形式。
配套的 harness 也补上了：**开窗 + 关窗**要作为一对动作验收（阶段八十九·七十一 只验了「开出来且不是纯黑」）。
新 harness 落在 `temp/nwfix/`（`drive_close.py` + `README.md` + 两次反向对照的结果存档）。

**六、顺手修掉一处过时指针**：`TODO.md` 路线图里「`Window`/`NativeWindow` … 2026-10-02 正式立项 → 见 `### 遗留待开发` 的『AIR 多窗口』行」——
该项已被阶段八十九·七十一 实现并从遗留表移出，指针改指本阶段家族条目。

**文档**：本条目；`README-CN.md`（支持表的 `NativeWindow` 家族补「继承 `EventDispatcher`」与监听器可用性、当前限制版本号）；版本 → **v0.4.27**。

---

#### 阶段八十九·七十三：`Stage.frameRate` 是**应用级单值**，帧循环只跑**一个应用帧**（多窗口帧率叠加）（v0.4.27 → v0.4.28）

**立项根据**：用户截图（主窗口 `FPS:170`、两个副窗口各 `FPS:168`）并提问：「为什么每开一个窗口默认 fps 是 24，总帧率会叠加这个数？」——
现象是**开得越多、每个窗口上的读数越高**，这只有一种解释：帧派发是按窗口数重复的。

**一、诊断（全部实测，不靠推测）**

| 事实 | 证据 |
|---|---|
| AIR 的 `Stage.frameRate` **不是一个 Stage 的属性，而是整个应用一个值** | AS3 语言参考（`Stage.frameRate` 变更影响所有 `Stage`）；**adl 51.4.1 实测**：把主窗口 `stage.frameRate` 设为 `4` 后，新开的 `NativeWindow.stage.frameRate` 读回**也是 4**。所谓「新窗口默认 24」只是**当时的应用默认值**，不是每窗常量 |
| 我们第一处偏离：新窗口自带帧率 | `NativeWindow_ctor` 里硬写 `w->stage->frame_rate = 24.0;` |
| 我们第二处偏离：帧派发按窗口重复 | `Stage_dispatchFrame(void* _this)` 第一句是 `(void)_this;`——它**忽略传入的 Stage**，向**进程级**的 ENTER_FRAME 注册表 `as_ef_objs` 广播；而 glue 的 `sk_run_loop` 是**每窗口一次** `on_frame`。于是 N 个窗口 = 每帧 N 次广播（连带 N 次 `gc_step()` / `as_async_tick()` / `as_timer_tick()` / `as_mc_tick()`） |
| 数字对得上 | 主窗口 120 fps + 2×24 = **168**（用户截图里的两个副窗口读数）；截图里 170 是同一现象的另一种量测 |

**二、双端对照 harness**：`temp/fpsprobe/`（`adl-app.xml` + `aot-app.xml` 共用同一份 `Main.as`/`MyWin.as`，探针把每个窗口的
`stage.frameRate` 与自己的 `ENTER_FRAME` 帧数按行写文件——注意 `FileStream_writeUTFBytes` 是缓冲 `fwrite`，故探针每行 open/append/close）。
逐行对照 `result-adl-run4.txt` / `result-aot-run5.txt`：**修复后与 adl 逐行一致**（`FR=4` 继承、把 W1 设 12 → 主窗口也报 12、把主窗口设 24 → W1 也报 24、稳态 24/24 而非 36/36）。
唯一差异仍是既定的 vsync 口径：启动首帧我们读 `mainFR=0`、adl 读 24（见 `docs/zh-cn/as3-semantics.md` §3）。

**三、修复**

- **语义层**：`Stage` 去掉 `frame_rate` 字段（`symbols.ts`）；生成 C 里改成**一个** `static double ASC_app_frame_rate`，`Stage_get_frameRate`/`Stage_set_frameRate` 两个访问器**代理**它（任一 `Stage` 写入即全局生效）；`NativeWindow_ctor` 不再写 24（新窗口天然继承）。
- **帧循环**：`vendor/window_glue.cc` 的 `sk_run_loop` 改为**一个应用帧**——一个滚动 deadline（`g_app_next`）、**一次** `on_frame`（由任一可见活窗口持时钟，主窗口关掉后时钟自动转移）、随后把所有可见窗口标脏、只呈现脏窗口；删除 per-window 的 `next[]` 与逐窗 tick。

**四、验收**

| 项 | 结果 |
|---|---|
| 多窗口探针（`temp/fpsprobe/multi/`，1 主窗口 + 2 副窗口，主窗口 `frameRate=120`） | 稳态 **`main=119 w1=119 w2=119`**（修复前同场景是 120 + 24×2 的叠加），新窗口 `W1/W2 opened FR=0`（启动首帧的 vsync 口径） |
| 新钉子 | `[native-window]` **31 → 36** 项：帧率是**一个应用级值**（无 `Stage.frame_rate` 字段、有 `ASC_app_frame_rate` 定义、无 `->frame_rate`）、两个访问器都代理它、节拍读应用值、**事件循环只跑一个应用帧**（`sk_run_loop` 函数体内 `on_frame(` 恰好 1 次、`on_frame_delay(` 恰好 1 次、无 `double next[SK_MAX_WINDOWS]`）、该帧把每个可见窗口标脏 |
| 反向对照（钉子本身） | ① 在 glue 循环里恢复逐窗 `on_frame`；② 在 `NativeWindow_ctor` 里恢复 `ASC_app_frame_rate = 24.0;` ⇒ 恰好这 2 条钉子 FAIL、`node test.ts` **exit=1**；还原 → `exit=0` |
| 全量回归 | `node test.ts` **125 passed / 0 failed / 125 total**、`exit=0` |

**五、顺带更正的过时记录**：阶段八十九·七十一 的 adl 对照表把 `frameRate=24` 记成了「每窗的默认值」，本轮按实测更正为
「读回的是**应用级**当前值」；`README-CN.md`、`src/emit.ts` 的同源说法一并改掉（三处）。

**文档**：本条目；`README-CN.md`（`Stage.frameRate` 与 `NativeWindow` 家族两处）；`docs/zh-cn/as3-semantics.md` §3（应用级单值 + 每 tick 一个应用帧）；
`src/emit.ts` / `src/symbols.ts` / `vendor/window_glue.cc` 的注释。版本 → **v0.4.28**。

---

#### 阶段八十九·七十四：`-O2` 的 `examples/air-native` 启动约 1 秒即 SIGSEGV —— vendored Skia 头与预编译库的**对象布局不一致**（v0.4.28 → v0.4.29）

**立项根据**：阶段八十九·七十三 改完帧循环后回归，**`-O2` 的 demo 5/5~8/8 崩**（`-O0` 一切正常），崩点固定在日志
`FileStream openAsync: PROGRESS(bytesLoaded=11) + COMPLETE` 之后约 1 秒。

**一、定位链（每一步都有实测判据）**

| 步 | 手段 | 结论 |
|---|---|---|
| 1 | 先验「是不是本次改动引入」：把帧率改动与 glue 改动**分别**回退再编 | 回退 glue、保留帧率改动 ⇒ **5/5 存活**；两者都回退 ⇒ 存活；两者都保留 ⇒ 崩 ⇒ **是 glue 的循环形状**暴露了它（单窗口下这次改动语义上是 no-op，故不是它写错） |
| 2 | 崩溃栈与现场 | 早先：`SDL_UpdateTexture_REAL +24` ← `sk_run_loop()`；后来：`sk_run_loop+1352` 读 `c->used`，`x26 = x28*160 + g_wins` ⇒ **callee-saved 的循环寄存器 `x28` 被污染**（污染值是 7/11/12 之类的小整数或野地址，随构建漂移） |
| 3 | 排除 jmp 栈：给 `as_jmp_stack[as_jmp_depth++]` 加 `JMPOVERFLOW`/`JMPDEPTH` 探针 | 未触发（永不 ≥16）；在渲染入口检查 `as_jmp_depth != 0` ⇒ 恒 0 ⇒ **与 try/catch 的 `longjmp` 无关** |
| 4 | 确认 `x28` 到底该不该跨调用存活 | `clang -O2 -S` 汇编：`stp x28, x27, [sp, #48]` + `.cfi_offset w28, -96` ⇒ **Darwin arm64 上 x28 是 callee-saved**，被改就是**有 callee 违反 ABI** |
| 5 | 内联汇编探针（`mov %0, x28`；**只在检测到变化时打印**，把扰动降到最低）逐层下钻 | `on_redraw` → `as_skia_mtl_begin_frame` 变化；继续在 `sk_mtl_begin_frame` 内部逐点打 ⇒ **内部各点都「未变化」**，只有「返回后」变化 ⇒ 只能是它**保存 x28 的栈槽被写坏**（epilogue 从被污染的槽里恢复） |
| 6 | 反汇编该函数 | 全函数**只有一处** `ldp x28, x27, [sp, #0x140]`（正常出口），且 clang 的 canary 在 `sp+0x138`——**紧邻保存 x28 的槽** ⇒ 该函数帧内某处**越界写 16 字节**正好砸在上面两个槽 |
| 7 | 真因 | `vendor/skia/include/gpu/GrBackendSurface.h` 是**旧一版 m124**：`kMaxSubclassSize` 为 64/160/160；编出 `libskia.a` 的那棵树（`build-tools/skia-src`）是 **80/176/176** ⇒ 栈上 `GrBackendRenderTarget` 我们按 **160** 留位、库按 **176** 写 ⇒ 库的构造器**越界写 16 字节**。另 `vendor/skia/include/gpu/vk/VulkanTypes.h` 也落后（缺 `fComponents` 等字段） |

**二、为什么只在 `-O2`、且「扰动一下就看不见」**：只有在 `-O2` 下循环才把索引/基址放进 `x28` 跨 `on_redraw` 存活（`-O0` 全在栈上）；
而任何加打印/加计数/改帧布局的构建都会改变栈上对象的位置与寄存器分配——早先的 `DIAG`/`SIGSEGV-handler`/`counter` 三个探针构建「全都存活」正是这个原因（**同一缺陷被扰动掩盖**，不是修好了）。

**三、修复**：把两份 vendored 头**逐字节对齐**到 `build-tools/skia-src`（`diff -rq vendor/skia/include build-tools/skia-src/include` 现在为空）。
这既是修崩溃，也是拆掉一颗**面向所有 `GrBackendRenderTarget`/`GrBackendTexture`/`GrBackendFormat` 栈用法的地雷**（阶段八十九·六十九 的 `VulkanTypes` 字段同理）。

**四、验收**

| 项 | 结果 |
|---|---|
| 修复后 `-O2` 连续运行 | **5/5 存活**（修复前 5/5~8/8 崩） |
| 反向对照（把两份头换回旧版再编） | **5/5 CRASHED** —— 因果关系成立 |
| 新钉子 | 新增 `[skia-abi]` **3** 项：vendored 头里的 `kMaxSubclassSize` 必须是库用的值（`= 80` 一次、`= 176` 两次）、`VulkanTypes.h` 必须带布局所隐含的字段、**并且与「编出库的那棵树」逐字节一致**（`build-tools/skia-src` 不在时打 `SKIP` 并 pin 字面值） |
| 反向对照（钉子本身） | 换回旧头 ⇒ 3 条钉子 FAIL、`node test.ts` **exit=1**；换回 ⇒ 3 条 PASS、`exit=0` |
| 全量回归 | `node test.ts` **125 passed / 0 failed / 125 total**、`exit=0`（含 `[native-window]` 36 项、`[skia-abi]` 3 项） |
| 端到端（真鼠标） | `python3 temp/nwfix/drive_close.py` ⇒ 第二窗口开出且**非纯黑**、点关闭后进程存活、主窗口仍在、`RESULT: PASS`（`exit=0`） |

**五、教训**：**预编译库的头文件不是文档，是 ABI 契约**——`vendor/skia` 的头与 `build-tools/skia-src` 的头**必须一起升**，
「同一个 milestone（m124）」不足以说明布局一致（同 milestone 内上游也改过 `kMaxSubclassSize`）。这类缺陷的症状是
**寄存器/栈被写坏**而不是「画错」，且**任何扰动都会掩盖它**，所以既要钉住版本，也要在「只在 `-O2` 崩」时先怀疑 ABI 而不是优化器。

**文档**：本条目；`docs/zh-cn/skia.md` 新增「vendored 头必须与预编译库同版本」一节（含具体数值与症状）。版本 → **v0.4.29**。

---

#### 阶段八十九·七十五：多窗口 GPU —— 运行期 `NativeWindow` 也走 Metal（v0.4.29 → v0.4.30）

**立项根据**：用户提问「air-native 是 gpu 加速的吗？我多开几个窗口 cpu 显示高。gpu 从监控上没看到有什么用量」。

**一、诊断（代码 + 实测，两者互相印证）**

- 主窗口**确实**是 Metal：`<renderMode>direct</renderMode>` → `air-app.ts` 加 `ASC_RENDER_METAL=1` → 生成 C 的
  `Stage_showWindow` 里 `w->is_metal = 1` → `sk_window_show_metal()`（`SDL_Metal_CreateView` +
  `GrDirectContext(Metal)`，每帧取一次性 drawable 直接用 Skia Ganesh 画）。
- 运行期 `new NativeWindow()` **全走 CPU 光栅 + 整帧 `SDL_UpdateTexture`**：`sk_window_create()` 只调
  `sk_attach_cpu()`，从不建 `SDL_MetalView`；`metal_glue.mm` 是**进程级单例**（`g_layer`/`g_context`/`g_drawable`/
  `g_surface` 都是 `static`），设计上只服务一个窗口； `NativeWindowInitOptions.renderMode` 只被存取
  （`ASCWin.render_mode`），**没有任何代码用它选后端**。
- **决定性证据**：日志 `metal_glue: layer bounds=…` 开 3 个窗口也只出现 **1 次**。
- **成本量级**：副窗 600×410 @2x = 1200×820 ⇒ 3.9 MB/帧/窗口，应用帧率 ~116 fps ⇒ 每窗 ~470 MB/s 的
  CPU 光栅 + 上传（GPU 那边只有「贴一张纹理」的 blit）。实测每多一窗 **+12~14% CPU**：0/1/2/3 窗 = 9.8 / 23.3 / 36.3 / 44.0%。

**二、修复（四层，全链路同一把钥匙 `id`）**

1. `vendor/metal_glue.mm`：全局单例 → `g_mtl[SK_MTL_MAX_WINDOWS(16)]` 分槽（`CAMetalLayer`/一次性 drawable/`SkSurface`
   每窗一份），`MTLDevice`/`MTLCommandQueue`/`GrDirectContext` 仍**共享**（Skia 要求它们比 context 活得久），
   第一个 GPU 窗口惰性创建、最后一个槽释放时拆掉。入口全带 id：`sk_mtl_init(int win_id, void* layer)`、
   `sk_mtl_destroy(win_id)`、`sk_mtl_begin_frame(win_id,w,h)`、`sk_mtl_flush(win_id)`。
2. `vendor/window_glue.cc`：新增 `sk_attach_metal(WinCtx*, int id)`（`SDL_Metal_CreateView` +
   `SDL_Metal_GetLayer` + `sk_mtl_init`，并把 view 记在 `c->metal_view`）；`sk_window_create()` 新增 `int gpu`
   形参，`if (!attached && !sk_attach_cpu(c))`；`#ifndef ASC_RENDER_METAL gpu = 0;`（**没有后端的构建不造自称 Metal 的窗口**）；
   `sk_service_destroy()` 先 `sk_mtl_destroy(i)` + `SDL_Metal_DestroyView(c->metal_view)` 再 `SDL_DestroyWindow`
   （layer 的生命周期挂在 view 上）。
3. 生成 C（`src/emit.ts`）：`NativeWindow_ctor` 从 `options->renderMode` 算 `gpu`（`strcmp(rm,"cpu") != 0`，
   仅 `ASC_RENDER_METAL` 下），交给 `as_window_create` 并记 `w->is_metal = gpu`；**Metal 窗口不建 CPU surface**
   （drawable 每帧取），但缩放仍从 `as_window_get_pixel_size` 读；`ASC_window_render` 的
   `as_skia_mtl_begin_frame(id, w->pw, w->ph)` / `as_skia_mtl_flush(id)` **带 id**（共享一份 layer 会让第二窗画进第一窗）；
   Stage3D 合成改成 `w->is_metal && …`；`ASC_window_on_resize` 对 Metal 窗口只更新尺寸、不分配 surface。
   `src/runtime.ts` 前导（extern + wrapper + 纯 C stub **三处**）与 `vendor/web_glue.cc` 的 stub 同步加 `gpu`。
4. 两个踩坑（都已钉死）：① `.mm` 里的参数**不能叫 `id`**——它遮蔽 Objective-C++ 的 `id` **类型关键字**，
   函数体内 `id<CAMetalDrawable>` 被解析成比较表达式（实测 11 处编译错误），参数名统一用 `win_id`；
   ② `as_window_create` 在前导里有**两份定义**（Skia 版 + 纯 C stub 版），只改一份时编译期是
   「too many arguments to function call, expected 13, have 14」——由全量回归的纯 C stub 构建路径捕获。

**三、验收**

| 项 | 结果 |
|---|---|
| 每窗 Metal 初始化 | 真点击开 2 / 3 窗 ⇒ 日志 `metal_glue: window 0/1/2 layer bounds=…` 共 3 / 4 行（**修复前恒 1 行**） |
| 「它被画出来了吗」 | 每窗截图**非纯黑**（non-black 0.999）+ 红块在场；主窗口 2000×1424、副窗 1200×820（均 2x）；副窗可见 `FPS:120` 叠层与 TweenDemo 动画 |
| CPU（同一二进制只改 `renderMode`，2 副窗） | auto→GPU **14.0%** 平均 / 26.5% 峰值；`renderMode="cpu"` **32.8%** / 37.6%（修复前 36.3% / 48.1%） |
| K 扫描（GPU） | 0/1/2/3 窗 = **6.9 / 11.2 / 14.0 / 16.1%** 平均（修复前 9.8 / 23.3 / 36.3 / 44.0）＝每窗 **+2.3~3.5%** 而非 +12~14% |
| 反向对照 ①（隔离后端变量） | 同构建 `renderMode="cpu"` ⇒ 只 1 行 metal 日志、CPU 回到 32.8%，且窗口照常渲染（**CPU 路径无回归**） |
| 反向对照 ②（钉子本身） | 把 emit.ts 的 gpu 选择改回恒 0 ⇒ `[native-window]` 2 条钉子 FAIL、`node test.ts` exit=1；改回 ⇒ PASS、exit=0 |
| 全量回归 | `node test.ts` **125 passed / 0 failed**（345 条钉子，含 `[native-window]` **54** 条，本阶段新增 15 条） |

**四、语义边界（不静默降级）**：Metal 构建下 `renderMode="cpu"` 的窗口**不合成 Stage3D/StageVideo**——
AIR 文档明确软件窗口不支持 StageVideo/Stage3D 合成，且该构建本就没有 CPU 回读缓冲（把渲染目标暴露为纹理
正是为了省掉每次回读）。所以 cpu 模式窗口少画 Stage3D 是**对齐 AIR**，不是缺口。

**五、教训**：① 「后端能力」不能是**进程级单例**——只要状态私有于窗口，多窗口就是自然结果，反之就会被迫
让第二个窗口降级，而且降级得很安静（API 全对、只有「画出来了吗」能发现）。② 同一份构建里要留**反向对照**
（`renderMode="cpu"`），否则「CPU 降了」无法归因到后端。③ Objective-C++ 里 `id` 是关键字，别拿它当参数名。

**文档**：本条目；`docs/zh-cn/skia.md` §6.6（per-window 状态表、共享/私有边界、两个踩坑）；
`docs/zh-cn/compile.md` 的 `<renderMode>` 一节与 GPU 宏对照表；`README-CN.md`「当前限制」多窗口条目；
探针 `temp/gpuprobe/`（README + `ab_run.py` 一键 A/B + `verify_metal.py` 逐窗非黑校验）。版本 → **v0.4.30**。

---

### 阶段八十九·七十六：`transform.matrix` 语义保真 + 可选文本选中刷新/光标（v0.4.30 → v0.4.31）✅ 已完成

**触发**：用户对 `examples/air-native` 的两张 adl / AOT 截图逐处比对，报 3 个不忠实点（D1 旋转/缩放/斜切行的四个方块位置不同；D2 选中高亮要滚动才出现；D3 可选文本上没有 I-beam 光标）。

**D1 根因（不是「旋转中心」而是 `transform.matrix` 的语义）**：AIR 每个 `DisplayObject` 只有**一个** transform，`x/y/rotation/scaleX/scaleY` 与 `transform.matrix` 是它**两种视图**；我们此前把 `transform.matrix` 当 `Transform` 自己的裸槽——读恒为写进去的那份矩阵、写不影响字段，于是 `get → rotate(30deg) → set` 只把图形转了、对象仍停在原处（adl 会把对象挪到 `(68.94228634059948, 60.58845726811989)`）。双端探针（`temp/xformcmp/Probe.as`，**25 例 T1–T25**，`AdlProbe.as` + `probe-app.xml` 走 `mxmlc`+`adl` 写 `/tmp/xform_adl.txt`）逐例实测出 adl 的完整口径：getter **返回拷贝**（改它不动对象）、setter 按 `rotation=atan2(b,a)` / `scaleX=hypot(a,b)` / `scaleY=hypot(c,d)`（行列式为负取负）分解，赋值当值/链式赋值都**产出被赋的矩阵**。修复 = `X.transform.matrix` 的读写改走**合成/分解访问器对**（`DisplayObject_get/set_transform_matrix`），旋转/缩放表达不了的 skew 留在残余槽（渲染合成顺序 `translate → rotate → scale → concat(残余)` 与 AIR 完全同序，故分解后重新渲染逐像素一致）；字段、渲染器、命中测试**一行未动**。

**D2 根因**：选中状态**有**记录（`[DBG]` 实测 down→drag 索引都对了），但自动烘焙（增量重绘的指纹机制）漏了 `_sel_begin/_sel_end/_scroll_h/_runs` 与 `textColor`/`autoSize`/`defaultTextFormat.align`，指纹不变 ⇒ 永不重烘焙（手工补指纹即立刻出现高亮）。修复 = 指纹补齐这 7 项。

**D3 根因**：`SDL_CreateSystemCursor`/`SDL_SetCursor` 全工程无引用，`Mouse.cursor` 只被存下来从未施加。修复 = 新增 glue seam `sk_window_set_cursor(id, kind)`（native 实现 + web 空实现），生成侧 `ASC_window_update_cursor` 在**鼠标事件分发之后**采样（监听器当帧写 `Mouse.cursor` 或改 `selectable` 能当帧生效）：`"auto"` 走 `as_pick_hit`（可选中 `TextField` → I-beam，其余 → 箭头），显式名映射 SDL 系统光标（`button` 因 SDL2 无对应物回落箭头），指针离开窗口恢复箭头。

**验证证据（可复现）**：① 探针逐字段比对 `temp/xformcmp/cmp_probe.py` — **180 个字段全部一致**（容差：adl 把 `x/y` 量化到 1/20 px（twips）、分解走单精度，故 x/y ±0.05、旋转/缩放 ±2e-4），仅 5 处**已知分歧**（见下遗留表）；② demo 行像素比对（`cap_row.py` 同窗口同裁切）— gray/pink/green/blue 四个色块 bbox **逐值相同**，绿色 6114 px 完全相等；③ 选中：`drive_selprobe.py` 拖拽后**当帧**出现高亮（bbox `(44,180,463,275)`，26440 px），不滚动、且不可选对照组无高亮；④ 光标：`cursor_test.py` 全屏连光标截图 — 可选文本上 I-beam、不可选上箭头（`temp/xformcmp/sel_out2/cursor-side-by-side.png`）；⑤ 回归：`node test.ts` **125 例全通 + 新增 `[xform]` 21 项钉子**；`examples/stage58.as` 补 9 条执行级断言（getter 拷贝、rotate 挪对象、skew 进 scaleY、零行列式往返、赋值当值/链式）。

**过程中修掉的三个真问题**（都不是表面现象）：① 非 Skia 构建**编译失败**——`AS_CURSOR_*` 与 `as_window_set_cursor` 只加在运行期前导的 Skia 分支，纯 C 分支缺符号（探针构建直接报 9 个错），已在前导的 `#else` 分支同步补齐；② **赋值表达式被当值用**——`a = b.transform.matrix = m` 生成 `(Matrix*)(void 表达式)` 非法 C（原实现只在语句位可用），新增 `transformMatrixTarget` 统一形状判定 + 值上下文的临时变量提升；③ 我自己第一版**奇异分支公式把行列布局搞反**（AS3 的 `(a,b,c,d)` 是行 1=`(a,c)`、行 2=`(b,d)`），T25 暴露渲染不精确后按 `L·残余 = M` 重新推导为三个子分支（`sy==0` / `sx==0 且 c==0` / 无分解形式整体寄存）。

**文档**：`README-CN.md`「当前限制」新条 + 「支持子集」的 `transform` / `Mouse.cursor` 两处就地更新；本条目；遗留两项见下表（访问链别名 + 两个无分解形式的矩阵）。版本 → **v0.4.31**。

> **决策口径（§1.5）**：adl 的 `x/y` **twips 量化（1/20 px）** 不复刻——`68.94228634059948` 在 adl 会以 `68.9` 回来，那是 avmplus 的内部存储口径而非 AS3 规范语义；我们保留全精度并**在验证中用容差**而非降级实现。

---

### 阶段八十九·七十七：键盘/焦点/复制保真 + 选中高亮口径（v0.4.31 → v0.4.32）✅ 已完成

**触发**：用户报 `examples/air-native` 的文本框「只能从前往后复制，不能从后面的文字往前选？选中的文字也无法复制？」——两个可观测缺陷：(1) 反向拖拽不出高亮；(2) 选中的文字按 `Cmd+C` 复制不出来。

**口径来源（先实测再动手，全部在 `adl 51.4.1` 上闭环）**：新建探针 `temp/xformcmp/seldir/SelKey3.as`（两个可选中 `TextField` + 一个 `Sprite` 命中目标 + 空舞台区域；`FileStream` 逐条写 `/tmp/selkey3.txt`）与驱动 `drive_selkey3.py`（**同一份源码两端跑**，动作间插分隔键 `z` 消歧，剪贴板由外部 `pbpaste` 读）。adl 侧第 12 轮实测（`adl_run3.txt`）：

| 测点 | adl 实测 |
|---|---|
| 点击字段 | `focusIn`（phase 2→3、`bubbles=true`、`relatedObject=null`），`focus=text`，点击处设插入点 |
| 拖拽选中 | `[4,14)`（字符索引随字体度量而定） |
| Cmd+A | `selb=0 sele=21 caret=21`，**零键事件**（被吞） |
| Cmd+C | **零键事件**（被吞）但剪贴板得到 `text[4,14)` = `'EFGHIJ abc'`；**选区保留** |
| Ctrl+C | **照常派发**（`kc=67 cc=99 ctrl=true`），剪贴板**不变** |
| Cmd+X / Cmd+V | 被吞、无动作 |
| 字段→字段 | `focusOut(text, rel=text2)` → `focusIn(text2, rel=text)`（旧选区保留） |
| 点 Sprite / 空白 | `focusOut(..., rel=null)` + `focus=null`；空白处无事件 |
| `stage.focus = t` | 派发 `focusIn(text, rel=null)`；此后 `Cmd+C` 能复制该字段**保留的**选区 |
| 无焦点时按键 | 事件目标是 **stage**（`KC=81` 的 keyDown 在 `focus=null` 时 `tgt=stage`） |

**选中高亮口径（推翻上一轮的猜想）**：第 10 轮（`SelFocus.as`，5 个不同底色字段轮流获焦）实测——高亮**只画在获焦的那一个字段**上；填充**恒为不透明 `0xB5D5FF`（181,213,255）**，在 `0x1E1E1E`/`0xFFFFFF`/`0x808080` 三种底色上取到**同一个值**（⇒ 不透明填充而非叠加混合；此前脚本里「`0x4D90FE` @35% 叠底」的判据是错的，已就地改正）；被选中的字形**恒为纯黑**。故第 9 轮「未获焦字段程序化 `setSelection` 也出高亮」的读数是**误读**（截图里的暗色轮廓是把标题栏算进偏移后的错位采样）。

**实现**：① 反向拖拽——`Stage_dispatchMouse` 的 mouseDown 记 `drag_anchor`，mouseMove 归一化成 `lo=min/hi=max` 并同步 `_sel_caret`（两向拖拽给出**同一个选区**）；② 高亮渲染——`selVis = (as_focus_obj == tf) && 选区非空`，填充 `0xB5D5FF` 不透明，选中字形走「同一个 `SkParagraph` 布局在**强制黑**的 `saveLayer` 里按选区矩形裁剪重画一遍」（新增 glue `sk_paint_black_keep_alpha`：`SkColorFilters::Matrix` 把 RGB 清零、保留 alpha）——不重排第二份布局，度量与抗锯齿边缘因而与原文字**逐像素同源**；③ 焦点模型——`as_focus_obj` 全局（GC 永久根）+ `as_focus_dispatch`/`as_set_focus`（`focusOut` 先、`focusIn` 后，`relatedObject` = 链的另一端）+ 点击字段获焦 / 点击其它清空 + `Stage.focus` 读写访问器；④ 键盘传输——`window_glue.cc` 新增 `on_key` 回调（`SK_MOD_*` 位掩码 + `sk_air_keycode`/`sk_us_char` 映射到 **AIR 的编号**：字母 keyCode 用大写、Delete=46/charCode=127、Cmd=15 且 `ctrlKey=true`…），生成侧 `ASC_window_on_key`→`Stage_dispatchKey`（无焦点时目标取 stage）；⑤ 复制/全选——`Stage_dispatchKey` 先判**加速键位**（macOS=Cmd、其它=Ctrl，单一比特，故生成 C 与平台无关）：命中 `A`/`C`/`X`/`V` 时**吞掉事件**（`A`→全选、`C`→复制），并要求有焦点且 `selectable`；剪贴板走 glue 的 `sk_clipboard_set_text/get_text`（SDL 剪贴板）。

**实测两处「不是我们想的那样」并当场纠正**：
1. **AIR 不过滤自动重复**。上一轮「按住 `a` 1.5 s 只收 1 次 keyDown ⇒ AIR 过滤重复」的结论是**测法导致的假象**：`reptap.py`（`CGEventTap` 监听系统事件流）证明 System Events 的 `key down` **根本不产生系统自动重复**（2 s 内系统层只发 1 次 keyDown）。改用 `repeat_probe.py` 主动合成「1 次正常 + 8 次带 `kCGKeyboardEventAutorepeat=1`」的 keyDown 后，`adl` **9 次全收** ⇒ 过滤是错的，`window_glue.cc` 里的 `e.key.repeat == 0` 判断已删除（注释写明测法与出处）。
2. **SDL 的修饰键状态来自「修饰键按下」而非事件 flag**。驱动最初只给字母事件挂 `CGEventSetFlags(CMD)`（adl 直接读 `NSEvent.flags`，因此 adl 侧照常带修饰键），而 SDL 的 `keysym.mod` 报 **0** ⇒ 我们这端 `Cmd+C` 不成立、事件被照常派发、也复制不出东西。加 `SK_KEY_TRACE` 定位后，驱动改为**真的按下/抬起修饰键本身**（Cmd=55/Ctrl=59/Shift=56/Opt=58，与真实硬件同序）。真实用户永远是这个序列，故行为一致；「只挂 flag 不带修饰键按键」是我们 harness 的假象，已写进驱动注释。

**补一轮（用户看的正是 demo 的 trace 面板，必须在那块字段上验收）**：探针 `t3` 复现 demo 的形态——长文本 + `wordWrap` + 滚到底（宽 400、高 400、40 行），第 13 轮两端实测：反向拖 `(350,200)→(30,200)` 与正向拖同一路径给出**同一个选区**（adl `(826,870)` / 我们 `(581,626)`，Cmd+C 分别 44 / 45 字符 ✓），跨行反向拖 adl `(732,1745)`/我们 `(487,1753)`（1013 / 1266 字符 ✓），Cmd+A + Cmd+C 两端都是全文 1950 ✓。**由此挖出一个真 bug 并修掉——选区高亮只取 16 个 rect**：一行一个 rect，于是「选区超过 16 行」时只画前 16 行；字段又滚到底部 ⇒ 那 16 行全在视口之上被裁掉 ⇒ **整屏看不到高亮**（用户 `Cmd+A` 的现场，实测修前只有 70053 高亮像素、且都在视口外；`adl` 同时是 426890 且覆盖整个可见区）。修法：glue 的 `sk_textlayout_rects_for_range` 增加 `skip` 分页参数，生成侧（填充与「黑字重画」两处）按 16 个一页循环取完整段的 rect；修后 274075 像素、覆盖 772 行像素高，与 adl 的 780 行一致（`temp/xformcmp/seldir/round13/cmp_t3_selectall.png` 上=adl 下=AOT 并排对照）。**demo 端到端**（`temp/xformcmp/demo_verify.py`）：在用户那份 `examples/air-native` 上反向拖 8802 高亮像素 == 正向拖 8802 ✓、Cmd+C 复制出该行 48 字符切片 ✓、Cmd+A 高亮 0 → 152353 ✓。**harness 教训已写进驱动**：投事件前必须确认目标进程真的在前台（曾有一次前台仍是 Sublime Text，不检查就会产出一堆「假的失败」；`NSWorkspace` 与 `osascript` 两个口径都要看）；`air-native` 跑完会再开一个 `NtWindow`，它会盖在主窗口上并抢焦点，令合成拖拽偶发丢事件（同脚本重跑即干净）。

**验证证据（可复现）**：① 同一驱动两端跑，逐项对照（`temp/xformcmp/seldir/{adl_run3.txt,aot_run4.txt}`）——焦点事件序列（含 phase/currentTarget/target/`relatedObject`/`bubbles`）、`Cmd+A`、`Cmd+C`（含**精确子串**）、`Ctrl+C` 派发但不复制、`Cmd+X/V` 吞掉、点 Sprite/空白、`stage.focus` 赋值后仍可复制、失焦不清选区：**全部一致**；② 高亮：`drive_sel_bidir.py`（判据同步改为不透明 `0xB5D5FF` 族）在 AOT 端给出**前向 == 反向**的同一 bbox `(44,180,463,275)` / 25768 px，不可选对照组恒无高亮，adl 端同样「前向 == 反向」（`temp/xformcmp/sel_bidir_{adl2,aot2}/`）；③ 回归 `node test.ts` **125 例全通**；④ 保真修复附带的 `FileStream` 立即落盘（`setvbuf(_IONBF)`）由探针本身证明（此前 AOT 侧读到的日志文件恒为 0 字节，adl 侧可读）。

**登记为遗留（下表新增 6 行）**：web 键盘/剪贴板未接线、`type='input'` 的键入/粘贴/剪切与方向键编辑、非 US 布局与 Option 组合字符、渲染管线色彩管理（sRGB→P3，**所有非灰颜色**偏移）、字体度量偏小（行距 12 vs 15、前进 5.3 vs 6.6）。**文档**：`README-CN.md` 的 `selectable` 段与 `Stage.focus` 就地更新 + 「当前限制」新增 3 条；版本 → **v0.4.32**。

> **判据（§1.5）**：`adl` 能跑对而我们跑不出 ⇒ **遗留**（上表 6 行全是这一类，无一是「AIR 本来不支持」的增强）。反向拖拽、复制、焦点、加速键均已对齐到 `adl`，只在「我们做得更少」的四个面上如实记账。

---

#### 阶段九十四·一：`Proxy` / `flash_proxy` 命名空间（v0.4.32 → v0.4.33）✅ 已完成

**触发**：`talkmed-meeting-aot-gap-report.md` §3-L1 / §5-P1.7（`talkmed-meeting-desktop-app` 的编译缺口分析）。工程里 **6 个文件 `extends Proxy`、5 个文件用 `flash_proxy` 命名空间限定**（`com/greensock/TweenProxy*.as`、`VarsCore.as`、`com/vsdevelop/rendering/DisplayContainer.as`）；GSAP（431 处 import）的 `TweenProxy` 分支是**编译期硬阻塞**。

**现状**：`symbols.ts` **无 `Proxy` 类**；lexer/parser 无 `flash_proxy` 命名空间限定语法。全工程 grep「Proxy」只命中 `runtime.ts:6223` 一处**无关**的 HTTP 代理注释，无任何实现。

**AIR 语义（须先实测，不得凭 C 行为反推——AGENTS.md §2.4）**：用 `mxmlc + adl 51.4.1` 采全语义面：

| 待测点 | 为什么要测 |
|---|---|
| 10 个 `flash_proxy` 方法的**接管边界**（`getProperty`/`setProperty`/`deleteProperty`/`hasProperty`/`getPropertyKeys`/`callProperty`/`isAttribute`/`nextName`/`nextValue`/`nextNameIndex`） | 决定「哪些操作走 Proxy、哪些仍走真槽」——这是实现的地基 |
| **只实现部分方法**时的行为（`extends Proxy` 但未覆盖某个操作） | AIR 是抛 `#1006`/`#1056` 一类，还是回落真槽？决定我们要不要生成守卫 |
| `isAttribute` 与 **E4X** 的交互（`@attr` 读写是否也走 Proxy） | 我们 E4X 已落地（阶段九十~九十三），交互面必须一起钉死 |
| `getPropertyKeys` 的顺序与 `for-in`/`Object.keys` 的关系 | Proxy 的枚举是**三元组**（`nextNameIndex`/`nextName`/`nextValue`），不是一次取键数组 |
| `callProperty` 的接管范围（`Function.apply`、`obj["m"]()` 动态调用） | GSAP 大量动态方法调用 |
| `Proxy` 作为**基类**：`is Proxy`/`as Proxy`/vtable super 链 | 与既有 vtable 派发打通 |

**实现要点**：① `symbols.ts` 注册 `Proxy` 内建类（`superClass: 'Object'`，标记 `dynamic` 语义——与阶段八十九·三十六 的 `dynamic class` 建模同一套）；② lexer 识别 `flash_proxy` 命名空间限定（`flash_proxy function getProperty(...)`），parser 侧走既有的通用元数据/限定符解析；③ codegen：当目标类的 super 链含 `Proxy` 且属性未命中静态槽时，`as_dyn_get/set/del/has` 与 `for-in` **先查 `flash_proxy` 方法、无方法再回落既有反射表**——即 Proxy 是**接管**（intercept）而不是替换 `as_dyn_*`（这条边界决定改动范围，实现时须写成注释）；④ `callProperty` 的 `args:Array` 复用既有的 `as_array arguments` 预扫描机制（§2.4 红线表最后一行）。

**验收**：① 新 `examples/stage94a.as`——`extends Proxy` + 全 10 方法最小实现，覆盖 `get`/`set`/`delete`/`in`/`for-in`/`obj["m"]()` 各一条断言；② **双端同源**探针（同一份 `.as` 跑 `adl` 与 AOT，逐条 diff，沿用 `temp/xformcmp/seldir/` 的两段式手法）；③ 真实用例：GSAP 的 `TweenProxy.as` 编译通过；④ `node test.ts` 全通 + 新增 `[proxy]` 钉子。**判据（§1.5）**：`adl` 能跑 ⇒ **遗留**（非增强）。

**实施结果（2026-10-03）**：

① **特性表按实测更正一处**：`Proxy` 的十个拦截器**不是** `getPropertyKeys`，而是 **`getDescendants`**——由 `airglobal.abc` 的 `describeType(Proxy)` 转储（`temp/proxyprobe/proxy-traits.txt`）钉死，文档里广传的 `getPropertyKeys` 是 AS2/旧文档串味。十个方法**全部声明在 `flash_proxy` 命名空间**（不是 public）。

② **实现**（3 个文件，无新依赖）：`symbols.ts` 注册内建 `Proxy`（`superClass: 'Object'`、`isProxy: true`、**非** dynamic，AIR 同此）+ `PROXY_NS_METHODS` 十名集合 + `MethodInfo.isProxyNs`；`parser.ts` 把类成员上的**命名空间限定符记进 `Method.ns`**（此前一律丢弃：`flash_proxy` 与 `starling_internal` 都只是被跳过的标识符）；`emit.ts` vtable 加 `int is_proxy`、方法反射表键在 `isProxyNs` 时改为 `flash_proxy::<name>`、`emitCall`/`emitMember` 拒绝把 `flash_proxy` 方法当普通成员解析、`for-in`/`for-each`/`delete`/`@attr`/动态调用各自接上接管路径；`runtime.ts` 新增 `as_is_proxy` / `as_proxy_invoke`（沿 super 链查 `flash_proxy::<name>`）/ `as_proxy_get_miss|set_miss|has_miss|del_miss|call` / `as_proxy_next_index|name|value` / `as_proxy_descendants` / `as_proxy_to_str` / `as_proxy_throw`，并把 `as_dyn_get/set/has/del/call`、`as_v_str_val`、`as_obj_to_str` 的 Proxy 分支接上。

③ **AIR 语义（全部实测，非推测）**：接管面 = 「动态」访问（点读写/`delete`/`in`/点号调用/`String()`/枚举/`@attr` → 十个拦截器），**真槽（字段/getter/方法）优先**；拦截器**只认 `flash_proxy` 命名空间**——`override flash_proxy function getProperty` 才是拦截器，**公有命名空间的同名方法不是**（实测：`p.foo` 仍抛基类 `#2088`，而 `p.getProperty("x")` 是普通调用返回 `PUB:x`）；未覆盖的操作由基类实现抛对应编号的 `Error`（`#2088` get / `#2089` set / `#2090` callProperty / `#2091` has / `#2092` delete / `#2093` getDescendants / `#2105` nextNameIndex / `#2106` nextName / `#2107` nextValue，**无一是 `TypeError`**），`#2090` 还覆盖 `new Proxy()` 与「以公有命名空间访问 `flash_proxy` 方法」；`p["m"](1,2)` 取到非函数值抛 `TypeError #1006`；`callProperty` 收到的是**扁平参数数组**（`rest.length` = 实参个数）；`isAttribute` 在 AIR 里**从不被派发**（`p.@attr` 走的是 `getProperty`）——故以 id 0 占位且不可达，**不发明编号**。

④ **验证证据（可复现）**：①`temp/proxyprobe/` 里 5 份 AOT 探针 + 同源 `adl` 工程（`src/AotMain.as` + `src/probe/{FullProxy,PartialProxy,BareProxy,RealProxy,L2}.as`）逐条**双端对照**：读/写/删/`in`/点号调用/`String()`/`p["m"]`/for-in/for-each/`@attr`、部分实现时的错误号序列（`#2092`/`#2091`/`#2105`）、裸子类的六个操作、真槽优先（字段/getter/方法/`is Proxy`/`hasOwnProperty`）、命名空间区分（`p.getProperty("x")`→`callProperty` 结果 vs `p["getProperty"]`→`getProperty`）、公有命名空间反向对照（`#2088` + `PUB:x` + `typeof(pp["getProperty"])==="function"`）——**AOT 输出与 `adl` 逐条相同**；②`examples/proxy.as` **41 条断言**（含 4 组反向对照：真槽不被接管、公有命名空间不是拦截器、裸/部分子类的错误号、非函数调用抛 `#1006`）编译运行 **exit 0**；③回归 `node test.ts` **126 例全通**（`PASS proxy.as`），方法表键改名、vtable 新增字段、`as_fn_call_dyn` 签名变更均无破坏。

⑤ **本阶段顺带修掉一处既有静默**：动态取到非函数值再调用此前**静默返回 `null`**（`as_fn_call_dyn` 的非函数分支），现按 AIR 抛 `TypeError #1006`——这是 `p["m"](1,2)` 的必经路径，也是任何 `Function` 槽为空时的正确行为。

**登记为遗留（下表新增 3 行）**：枚举/点号接管只对**静态类型**为 Proxy 子类的接收者发射（`*` 接收者回落记录槽）、拦截器收到的 `name` 是**原始 String**而非 `adl` 的装箱 String、`getDescendants` 因 `..` 语法不在子集而不可达。**文档**：`README-CN.md` 的「当前限制」新增 Proxy 条目 + 「支持子集」根类行补 `flash.utils.Proxy` + 示例清单新增 `examples/proxy.as`；版本 → **v0.4.33**。

> **判据（§1.5）**：三行遗留全是「`adl` 能跑对、我们跑不出/不忠实」⇒ **遗留**（非增强）；`new Proxy()` / `#2090` / 装箱键名之外的行为均已对齐 `adl`。

---

#### 阶段九十四·二：`with` 语句（v0.4.33 → v0.4.34）✅ 已完成

**触发**：`talkmed-meeting-aot-gap-report.md` §3-L1。工程 **3 处 `with`**：`MeetingWindow.as:180`、`OpenGLVideoRootView.as:44`、`OpenGLVideo.as:260`。

**现状**：`ast.ts` 无对应节点、parser 无 `with`（全工程 grep `WithStmt`/`parseWith` = 0 命中）。

**AIR 语义（须先实测）**：`with (obj) { … }` 在作用域链里插入一个**对象作用域**，以下每一条都必须用 `adl` 钉死而非凭语法直觉：

| 待测点 | 关键分歧 |
|---|---|
| 未限定标识符的解析顺序（对象属性 vs 外层词法作用域，谁先） | AIR 是**对象作用域插入在当前作用域之内层**；搞反会让同名变量取错值 |
| 属性**不存在**时 | 抛 `ReferenceError #1069`？还是静默回落外层作用域？（若抛，就必须生成 `as_dyn_has` 守卫 + 抛错路径，**不得静默回落**） |
| `with` 块内**声明**的 `var`/`function` 落哪一层 | AIR 里仍归函数体顶层 ⇒ 与既有「顶层整树 `var` 提升」（阶段八十九·三十四）口径核对 |
| `this` 在块内是否改变 | AIR 不变（`with` 只影响标识符解析） |
| 嵌套 `with` 的查找顺序 | 内层对象优先，逐层外推 |
| 与 `dynamic`/`Proxy` 对象的交互 | **与阶段九十四·一 联动**：Proxy 的 `hasProperty` 决定「属性存不存在」，两阶段需同批核对 |

**实现要点**：① `ast.ts` 新增 `With` 节点（`{ kind:'With', obj:Expr, body:Stmt }`）——按 §2.2「先改 AST」；② parser 加 `parseWith()`，复用现有原语（`expect`/`parseExpression`/`parseStatement`），不做任何语义判断；③ codegen 在语义层维护**对象作用域栈**（并入 §2.3 的栈式符号表，不新增全局可变表）：未限定标识符解析时先查栈顶对象（生成 `as_dyn_has` 判定 + 条件回落），命中即 `as_dyn_get`。**这一步不能简化为文本替换**——它是真正的名字解析。

**验收**：① 新 `examples/stage94b.as`（属性命中/未命中/嵌套 `with`/块内 `var` 声明位置/`this` 不变/与 `dynamic` 对象联动）；② adl 双端同源逐条 diff；③ 工程那 3 处 `with` 的实际形态编译通过；④ `node test.ts` 全通 + 新增 `[with]` 钉子。**判据（§1.5）**：`adl` 能跑 ⇒ **遗留**。

**完成（2026-10-03）**：`with` 已落地并**与 `adl 51.4.1` 逐条实测对齐**（探针 `temp/withprobe/`：`adl` 与 AOT 两份输出的 w1~w24/x2~x13/y1~y7/z1~z4 编号与取值全同）。落地形态：接收者**只求值一次**进 C 局部；**静态类型接收者**走编译期成员解析——把 `name` 脱糖成普通 `Member` 节点（`{kind:'Member', object:{kind:'Var',name:<tmp>}, property:name}`），因此字段/getter/setter/方法绑定/GC 写屏障**全部复用既有成员路径**，发射出**无分支 C**；**`*`/`Object`（记录槽）/动态类/`Proxy`** 接收者发射运行时 `(as_dyn_has(o,"k") ? as_dyn_get/set/call/del(o,"k") : <词法回落>)` 三元（`Proxy` 因此天然走拦截器协议）。名字解析顺序、缺失穿透（读与**写**都穿透）、体内 `var` 局部性、`this` 不变、嵌套内层优先、`delete` 解析到对象、`#1009`/`#1010`/`#1074`/`#1065` 四个错误路径均由 `adl` 实测钉死（错误编号与异常类一致）。实现里定位并修掉 3 个真缺陷：①`Object` 静态类型接收者必须走运行时记录槽路径；②只读属性判定用错（`fieldSlot(...) !== null`，应为 `!== undefined`）导致 `#1074` 永不触发；③词法回落 thunk 一度把整个语句的作用域都关掉，使**调用实参与赋值右值**看不到 with 作用域（实测 `w2/w3` 必须看到）——改为**一次性**的 `suppressWithName`/`suppressWithCallee` 标志，只豁免被重解析的那**一个**名字。另修一处**既有 UB**（同批发现）：记录槽 vtable（`as_object_vt`）此前是短的前缀结构，而生成类 vtable 在其后追加了 `toString`/`hasOwnProperty` 两槽 ⇒ `({k:1}).hasOwnProperty("k")` 与 `props.hasOwnProperty(name)`（`VarsCore` 风格写法）会**跳垃圾函数指针**（实测 bus error）；现统一为 `as_object_vtable` 全结构并补齐 `as_object_own_has_own_property`/各装箱 `toString`。**收尾**：`examples/with.as`（27 条断言）纳入回归、`node test.ts` **126 例全通**、`README-CN.md` 当前限制新增 `with` 条目 + 语句行补 `with` + 示例清单补 `examples/with.as`；**新增 5 行遗留**（见下表）。版本 → **v0.4.34**。

---

#### 阶段九十四·三：`flash.utils.getQualifiedSuperclassName` + `setInterval` / `clearInterval`（v0.4.34 → v0.4.35）✅ 已完成

**触发**：`talkmed-meeting-aot-gap-report.md` §3-L2-2（`flash.utils` 全局函数缺三项）。

**现状（grep 实测）**：

| API | 现状 | 位置 |
|---|---|---|
| `getQualifiedClassName` | **已落地**（阶段八十六） | `emit.ts:14638` 发射点 + `runtime.ts:2333` `as_qualified_class_name`（读 vtable `fqn` 槽） |
| `getQualifiedSuperclassName` | **未注册**（grep 0 命中） | — |
| `setTimeout` / `clearTimeout` | **已落地**（阶段五十一；`emit.ts:14663/14678` 分派 + `runtime.ts:1179` `as_timers` 表） | 含 `this.method` 函数值与 `as_set_timeout_args` |
| `setInterval` / `clearInterval` | **未注册**（grep 0 命中） | — |

**AIR 语义（须先实测）**：
- `getQualifiedSuperclassName(v)`：`Object` 的**超类**给什么（`null` 还是 `"Object"`）？对**接口类型**/`int`/`null`/原始值各给什么？`'::'` 分隔与 `flash.filesystem::File` 的往返口径须与 `getQualifiedClassName` 一致（后者实测见阶段八十六）。大概率是「沿 vtable super 链取上一层 `fqn`」的纯函数，但**四个边界值必须实测**。
- `setInterval(closure, delay, ...args)`：返回值（`uint`）与 `setTimeout` 是否**共用同一 id 空间**；**重复间隔的时序语义**（固定间隔 from-start 还是 from-completion）；`clearInterval` 在本轮回调内调用是否停掉后续全部；**`clearInterval` 能否取消 `setTimeout` 的 id、`clearTimeout` 能否取消 `setInterval` 的 id**（AIR 里两者常共用一张表——**这一条直接决定实现形态**）；与既有 `Timer`（阶段六十）两张表的执行顺序。

**实现要点**：① `emit.ts` 的全局函数分派（`getTimer`/`setTimeout` 同处）新增 3 个分支；② `getQualifiedSuperclassName` 复用 `as_qualified_class_name` 的 vtable 遍历，取上一层 `fqn`（`Object` 层按实测给值）；③ `setInterval`/`clearInterval` 复用阶段五十一 的 `as_timers` 表——若实测「共用 id 空间/可互换」成立，则只加一个「重复」位 + 到期重挂；若否，则新增第二条定时器泵并在帧边界按实测顺序执行。

**验收**：① 新 `examples/stage94c.as`——超类名 6 例（类/接口/原始值/`null`/`Object`/多层继承）；interval 的 id 互操作、`clearInterval` 自停、与 `setTimeout` 混用；② adl 双端同源逐条 diff，且**记录时序**（固定 tick 下回调次数序列，而非只看最终态）；③ `node test.ts` 全通 + 新增 `[qscn]`/`[interval]` 钉子。**判据（§1.5）**：三项 `adl` 均有 ⇒ **遗留**。

**完成（2026-10-03）**：三项均已落地，语义全部来自 `adl 51.4.1` 实测（探针 `temp/qscnprobe/`、`temp/intervalprobe/`、`temp/mixprobe/`）。

- **`getQualifiedSuperclassName(v)`**：`emitGlobalCall` 新增分派 → runtime `as_get_qualified_superclass_name`（按 box tag 分派后**沿 vtable 走恰好一层 `super`**）。实测边界全对齐：多层链 `Leaf→Mid→Base→Object→null`；**无超类给 AS3 `null`**（`Object` 本身 / 接口 / 普通对象 `{}` / `null` / `undefined`，`typeof` = `"object"`、`=== null` 为真）；装箱原始类型 / `Array` / `Function` → `"Object"`（装箱 vtable `super` 指向 `as_object_vt`，故自然落到该分支）；限定名与 `getQualifiedClassName` 同口径（`scenes::SceneBase` 保留包前缀，实测）。返回类型声明为 **String**（`NULL` == AS3 `null`，字符串助手全部 NULL 安全），故 `== "包::类"`、`.indexOf()`、`.length` 都是静态字符串操作（示例已钉）。
- **`setInterval`/`clearInterval`**：复用阶段五十一 的 `as_timers` 表 —— 实测「**共用一张表 + 一个 id 计数器**」成立（id 跨两者 `1,2,3…`），故只加了 `int repeat; double delay;` 两列 + `as_set_interval_args`（委托 `as_set_timeout_args` 后翻 `repeat` 位），`clearInterval` 直接复用 `as_clear_timeout` ⇒ **两者互为取消**（实测：`clearInterval(timeoutId)` 不触发、`clearTimeout(intervalId)` 不触发）、未知/0 id 静默空操作。时序按实测建模：**回调结束后**再排下一次（50ms 回调配 20ms 间隔 ⇒ 间隔 ≈69ms），且每个 tick 至多触发一次（延迟 0/1ms 的间隔实测也是每帧一次）；在自身回调里 `clearInterval` 停掉后续全部 tick（`alive == 2`「正在触发」标记 + 回调后按 id 重找槽位，回调里 realloc 表也安全）。失败面按实测补齐：**负/NaN 延迟 → `RangeError #2066`**（实测 `setInterval(-5)`/`setTimeout(-5)`/`NaN` 三者同号，且该次调用**不消耗 id** —— 已在 `as_set_timeout_args` 入口守卫），**`null` 闭包不报错、仍消耗 id、永不回调**（实测 `setTimeout(null,100)` 返回 `1`，与旧实现返回 `0` 不同，已改）。同泵顺序 = 注册（id）顺序（实测 `T`/`I` 两种注册顺序各自保序）。
- **收尾**：`examples/stage94c.as`（**36 条断言**）纳入回归；`test.ts` 新增 **`[qscn]` 13 项 + `[interval]` 16 项**钉子（钉运行时助手形态、emit 分派、String 类型化、以及示例里的实测边界）；`node test.ts` **128 例全通**；`README-CN.md` 的「内建」行补两个 API、「当前限制」新增条目、示例清单补 `examples/stage94c.as`。**登记 1 行遗留**（反射 API 的内建类短名/`int` 装箱成 `Number`/接口与内建类 Class 值不可表达 —— 与阶段八十六 条目同源，见下表）。版本 → **v0.4.35**。

---

#### 阶段九十四·四：`ByteArray` 多字节 / 布尔 / AMF 对象读写（v0.4.35 → v0.4.36）✅ 已完成

**触发**：`talkmed-meeting-aot-gap-report.md` §3-L2-3——`ByteArray` 是工程**第 2 高频** import（214 处），缺的 6 个方法会在**协议层/加密层/资源层同时爆雷**；报告把它列为 L2 里**性价比最高**的补齐项。

**现状（`src/symbols.ts` 的 `ByteArray` 方法表，grep 实测）**：

| 方法 | `ByteArray` | `Socket` / `URLStream` | 工程调用次数 |
|---|---|---|---|
| `readMultiByte` / `writeMultiByte` | **未注册** | 已有（`charSet` 被忽略） | 15 / 24 |
| `readBoolean` / `writeBoolean` | **未注册** | 已有（`Socket`） | 1 / 1 |
| `readObject` / `writeObject` | **未注册** | 未实现 | 3 / 5 |

**顺带要纠正一处既存注释**：`emit.ts:5438` 与 `emit.ts:5634` 都写着「charSet is ignored exactly like `ByteArray.readMultiByte` in this subset」——**但 `ByteArray` 根本没有 `readMultiByte`**（`symbols.ts` 方法表里不存在）。注释把 `Socket`/`URLStream` 的行为挂到了一个不存在的 `ByteArray` 方法名下，本子阶段落地时**就地改正**，避免以讹传讹。

**与遗留表的关系**：`readObject`/`writeObject` 已在**遗留表「AMF 编解码」独立行**登记（AMF0/AMF3 双版本 + 引用表 + trait + 别名注册表）。本子阶段与该行**同源**，应**合并为一个实现**（`ByteArray` 读写对 + `URLStream` 复用），而非两处各写一份；落地后该遗留行随之移出。

**AIR 语义（须先实测，`charSet` 是重点）**：
- `readMultiByte(length, charSet)` 的 `charSet` **不是摆设**：AIR 支持 `"utf-8"` / `"unicode"`（UTF-16）/ `"gbk"` / 系统代码页别名等；**未知 `charSet` 的失败模式**（抛错号？静默按 latin-1？）必须实测。
- 编码字节序（UTF-16 的 BOM 与 `endian` 属性是否相关）、**非法/截断的多字节序列**的行为。
- `writeMultiByte` 对代理对 `"\u{1F600}"`、`charSet="unicode"` 的字节输出，与 `adl` **逐字节**对照。
- `readBoolean`/`writeBoolean`：**非 0 是否即 true**（`0xFF`/`0x80`/`0x01` 三值）、写入是 1 字节还是 4 字节。
- `readObject`/`writeObject`：默认 `ObjectEncoding`、引用表、`trait` 形状、`registerClassAlias` 交互——现有探针只测到空 `URLStream.readObject()` 抛 `#2029`，**语义面远未采全**。

**实现要点**：① `symbols.ts` 的 `ByteArray` 方法表补 6 项 + `emit.ts` 补 `ByteArray_*` 发射点；② `readMultiByte`/`writeMultiByte` 走**真正的编码器**——按 §2.9「链接而非内嵌」，GBK 等字符集**优先链接系统 `iconv`/CoreFoundation 转换器**，不自研字符集表；`utf-8`/`unicode` 可先用既有的 `as_str` 与手写 UTF-16 路径；③ AMF 编解码器实现一次、`ByteArray` 与 `URLStream` 共用。

**验收**：① 新 `examples/stage94d.as`（`utf-8`/`unicode`/`gbk` 往返 + 代理对 + 非法序列 + 布尔三值 + AMF3 对象图 round-trip）；② adl 双端**逐字节**对照（`ByteArray` dump 比对，而非只比字符串）；③ `com.hurlant`（Crypto）/ `as3swf` 的最小用例编译并运行通过；④ `node test.ts` 全通 + 新增 `[bytearray]` 钉子；⑤ 遗留表「AMF 编解码」行移出并并入本子阶段。**判据（§1.5）**：6 个方法 `adl` 全有 ⇒ **遗留**。

**完成（2026-10-03）**：`ByteArray` 的 6 个方法全部落地，并**与 `adl 51.4.1` 逐字节对齐**（探针 `temp/amfprobe/`：`AmfMain`/`Amf2Main`/`HdrMain`/`DtoMain`/`mb` 五支 `adl` 程序 + AOT 对照 `aot.as`~`aot5.as`）。落地形态：

- **多字节（`readMultiByte`/`writeMultiByte`）**：`utf-8` 在本运行时内校验/拷贝（非法首字节与截断尾**丢弃**，与 `adl` 的有损行为一致）；`unicode`/`utf-16` **恒为 UTF-16LE、无 BOM、`endian` 属性无效**（实测 `Aé中` 在 BE/LE 下都是 `41 00 e9 00 2d 4e`，`utf-16be` 才强制大端）；其余代码页走**系统 `iconv`**（native 构建 `link-libs` 追加 `iconv`，仅 darwin；`__EMSCRIPTEN__`/`__wasi__` 下 `AS_HAVE_ICONV=0`，非 UTF-8/16 字符集**响亮抛错**）；`""`/未知字符集回落 **OS 传统编码**（Apple `MACINTOSH`、其余 `CP1252`，实测与 `adl` 的 `é`→`8e`/`中`→`3f` 一致）；目标字符集表达不了的字符**手写 `'?'`**（实测 macOS `//TRANSLIT` 会给出 `'e` 而非 `adl` 的 `3f`，故**不用** `//TRANSLIT`）。
- **布尔（`readBoolean`/`writeBoolean`）**：写 **1 字节**；读**非零即真**（`0xFF`/`0x80`/`0x01` 实测皆 true）；两者越界都抛 `EOFError #2030`（`as_throw_eof`），这是本子集**首次**引入「读越界即抛错」的 IDataInput 口径。
- **AMF3 编解码器（写 + 读）**：编解码器**放在 `runtime.ts` 前导**（而非 `emit.ts`），因为它需要多行 C；而生成期事实（每类的 trait 成员表、`Date`/`ByteArray` 构造器、`getDefinitionByName` 注册表）通过**钩子**（`as_amf_members_hook`/`as_amf_class_hook`/`as_amf_date_hook`/`as_amf_ba_out_hook`/`as_amf_vec_hook` 及两个 `_new_hook`）由新增的生成函数 `as_amf_wire()` 在 `main` 顶部装配——前导**早于**生成段发出，不能直接命名 `Error`/`ByteArray`/`Date`，故错误以**错误码**（`as_amf_err{code,detail}`）返回、由生成段的 `as_amf_throw_err` 映射成带类型的抛出。
- **AMF3 线格式（全部实测，含三处决定性发现）**：①**动态键、trait 类名与 trait 成员名用「裸 U29S」（无 `0x06` 标记）**，只有字符串**值**带 `0x06`，二者共用字符串表；②**trait 类名不进字符串表**（实测同一次写入里字段值 `"b"` 的引用下标是 2 而非 3）；③**纯稠密数组不写关联段终止符**（`[1,2,3]` = `09 07 01 04 01 04 02 04 03`），`01` 只在 `assoc > 0` 时补；④`Date` = `08` + 内联 U29O `01` + 8 字节大端毫秒；⑤判读侧 **U29O 位序 = bit0 内联对象 / bit1 内联 trait / bit2 externalizable / bit3 DYNAMIC / bit4+ 成员数**（用**手工构造的字节流**喂 `adl` 反推：`bit3` 的 0 成员对象读回 `{k:"v"}`，`bit2` 或 `bit2+3` 都被 AIR 自己以 `#2173` 拒绝——此前把动态位写成 bit2 是错的）；⑥`Vector.<int>[1,2]` = `0d 05 00 <大端 int> <大端 int>`。AMF0 语义也已采全（number/`00`+double、ECMA 数组 `08`、typed object `10`、Date `0b`），但**本子阶段只实现 AMF3**，`objectEncoding != AMF3` 时**响亮抛错**（不静默按 AMF3 写）。
- **反射对接与三处既有 UB 修复（本子阶段的必要前置）**：`getQualifiedClassName`/`getQualifiedSuperclassName` 曾在 `Vector`/`Dictionary`（无 vtable 前导的 GC 体）上**段错误**——新增 `as_heap_kind()`（`gc_in_heap` + `gc_hdr(p)->type`）按 GC 类型分派；`as_dyn_get/set/has/del` 在**经 `*` 接收者**触达 `Dictionary`/`Array` 时同样段错误——新增 `as_dyn_kind()` 路由到 `as_dict_*`/`as_array_prop_*`。**并且**：`Vector.<T>` 是 `{mark,data,length,capacity}` 的**单态化结构体**（`GCT_CUSTOM`），**不是** `as_array`，写入侧原先按 `as_array` 读 `props` 会越界 ⇒ 改为按 **mark 回调指针**识别每个特化（`as_amf_vec_impl`），未知元素类型**响亮报错**。
- **顺带修掉的三个子集缺口（都由真实第三方代码首次触达）**：①**`ByteArray` 的整数下标写** `ba[i] = v`——AVM2 给 `ByteArray` 一个**下标写**语义（不是动态属性表，故 AIR 在此**不抛** `#1056`，而本子集此前抛）：实测 `adl` 后按 `ToUint32` 取低字节（`300`→`44`、`-1`→`255`、`1.7`→`1`、`"x"`→`0`、`true`→`1`、`null`→`0`）、写到 `length` 处**自动扩展并零填充**、**不动 `position`**；新增 `ByteArray_set_index` 并接进 `emitAssign` 的索引分支。②**`new C` 省略参数列表**（`new ByteArray;`——`parser.ts` 的 `parseNew` 此前只对 `Vector.<T>` 放行，现按 AS3 语法对**所有** `new X` 放行）。③**`a[i] ||= v` / `a[i] &&= v`**（索引目标的短路赋值——`emitLogicalAssign` 此前只支持简单变量/字段目标；现按「接收者/索引/右值必须无副作用」的前提复用既有索引读写路径，副作用目标仍**响亮报 `CodegenError`**）。
- **真实第三方代码验收（本子阶段的最强证据）**：把工程里的 `com.hurlant.crypto.hash.MD5`（`Documents/TalkMED/ActionScript-Lib/`，逐行未改）与 `IHash` 一起编译并与驱动链接运行，`md5("abc")` 得到 `900150983cd24fb0d6963f7d28e17f72`（**与 RFC 1321 一致**）——它正好同时用到 `new ByteArray;`、`src[src.length] = 0`、`x[i] ||= 0`、`readUnsignedInt`/`writeUnsignedInt`，是本子阶段「`ByteArray` 深度」补齐后**第一段跑通的真实加密库代码**（探针留在 `temp/hurlant/`）。
- **收尾**：`examples/stage94d.as`（**67 条断言**，全部对应 `adl` 实测字节）纳入回归；`test.ts` 新增 **`[amf]` 19 条** + **`[bytearray]` 9 条**钉子（iconv 门控、UTF-16LE、`'?'` 手写、OS 回落、`#2030`、iconv 仅 darwin 链接、`objectEncoding` 默认、裸 U29S、trait 类名不入表、动态位 bit3、Vector 按 mark 探测、大端标量、AMF0 拒绝、别名沿超类链、下标写按 `ToUint32` 截断/扩展零填充/不动游标、`new C` 省略括号、`a[i] ||=` 与其副作用拒绝、示例 golden）；`node test.ts` **129 例全通**；`README-CN.md` 内建行 + 语句行（`new C`/`a[i] ||=`）+ 当前限制新增条目 + 示例清单；**遗留表新增 8 行、AMF 行由「未开始」改为「部分完成」**（见下）。版本 → **v0.4.36**。

---

#### 阶段九十四·五：A 批遗留攻坚（`ByteArray` 收口 / `as Object` / `Function` 成员 / `Vector` 反射名 / AMF 成员序）（v0.4.36 → v0.4.37）✅ 已完成

**触发**：阶段九十四·四 收尾时遗留表里 6 项「低成本机械补齐」候选——互不同源，但都属「`adl` 可逐字/逐字节对照、改动面小」的同一类账，一次性批量收口，避免零散返工。

**本批 6 项（全部 `adl 51.4.1` 实测驱动）**：

| # | 遗留项 | 结论 | 证据（探针 / 钉子） |
|---|---|---|---|
| A1 | 更早的 `ByteArray` 读方法**越界不抛** `#2030` | **已修**：`emit.ts` 里 **17 个**读点全部接上 `as_throw_eof()`（`EOFError`/`#2030`），与阶段九十四·四 新引入的 IDataInput 口径统一；`com.hurlant` 这类按字节读的代码已同步核对（`temp/hurlant/` 仍通过） | `examples/stage94d.as` + `test.ts` `[bytearray]` |
| A2 | `ByteArray` **负索引**下标写口径未实测 | **已实测并对齐**：`b[-1]` **读**抛 `#1069`（`as_throw_sealed_get`）、`b[-1] = 5` **写**抛 `#1056`（`as_throw_sealed_set`）；**写**越界（`b[b.length]` 及更远）自动**扩展并零填充**、**不动 `position`** | `temp/a2probe/`；`examples/stage94d.as` |
| A3 | `x as Object` **丢记录动态属性** | **已修**：`emitAs` 的 `Object` 分支原先对任何非对象操作数直接返回字面 `NULL`（`({k:"v"}) as Object` → `NULL.k`）；现改为复用 `convert(o, Object)`——静态显式 `as` 与隐式 `var o:Object = n` 两条路**共用同一实现**，口径不会漂 | `temp/a3probe/`（`n as Object` → `5` 且 `qc=int`；`null`/`undefined as Object` → `null`；记录/数组保留成员；`(5 as Object) == 5` → true）；`test.ts` `[cast]` 5 条 |
| A4 | `with` 对象上的 **`Function` 值成员**不能以 `fn()` 调用 | **已修，且发现原行前提有误**：`cb.fn()` **点号调用同样是硬错误**（`undefined method 'fn' on class 'Cb'`），并非「与既有 `cb.fn()` 发射相同」。现 `emitCall` 的 Member 分支与 `withCallFrom` 的 sealed 分支都在报错前先 `findField`：**Function 类型**字段走 `emitFunctionCall`，非 Function 字段**保持响亮报错** | `temp/a4probe/`；`test.ts` `[fncall]` 5 条 |
| A5 | `getQualifiedClassName(Vector.<T>)` 给 `"Array"` | **已修**：`Vector.<T>` 是 `GCT_CUSTOM` 单态结构体（无 vtable，首字是 per-spec `mark` 指针）；新增两个运行时**钩子** `as_vec_fqn_hook`/`as_vec_super_fqn_hook` + 生成函数 `as_vec_fqn_impl`/`as_vec_super_fqn_impl`/`as_vec_fqn_wire`，由 `as_get_qualified_class_name`/`…superclass_name` 在 `GCT_CUSTOM` 时查询（`Array`/`Object` 旧口径只在**非**自定义堆对象时保留） | `temp/a5probe/`（int/uint/Number/String/Boolean/Object/Array/嵌套/`pkg::Thing`/接口 逐类对照）；`test.ts` `[vecfqn]` 8 条 |
| A6 | AMF **trait 成员序**与 AIR 不一致 | **实测定案：不可对齐（非缺陷）**——见下 | `temp/a6probe/`；`test.ts` `[amforder]` 2 条；`docs/zh-cn/as3-semantics.md` §3 |

**A4 的 `this` 发现（顺带更正一条既有口径的前提）**：`adl 51.4.1` 三行对照实测（`temp/a4probe/`）——① `cb.fn()`；② `with (cb) { fn() }`；③ 裸 `fn()`。①② 都把 `this` 绑到**接收者**（连顶层普通函数也如此），③ 不绑（`this` 是全局对象）。本子集的闭包在**创建点**词法捕获 `this`（`env->this`），呼叫点无法重绑 ⇒ 本子阶段让 ①② **可编译可调用**（净收益），但 `this` 仍是闭包自己的；该差异已作为**新遗留行**登记（含 `call`/`apply` 的 `thisArg` 同源问题），**未静默吞掉**。

**A6：为什么这条不是缺陷（三次受控实验，`temp/a6probe/`）**：

1. **不是声明序**：把同一组四个成员**反序声明**（`Rev{d,c,b,a}`），`adl` 的 `describeType` 与 AMF trait 序与正序的 `Big{a,b,c,d}` **逐字相同**（都是 `a c b d`）⇒ 顺序只由「成员**名字集合**」决定。
2. **不是运行期随机**：同一个 SWF 连跑三次，顺序完全一致 ⇒ 由**构建产物**决定。
3. **是编译期布局产物**：源码**只加一个未被引用的类**，顺序不变；但加 **3 个无关的、被 `registerClassAlias` 引用的类**后，**未被触碰**的 `Mix` 的序从 `n1 u1 s1 o1 s2 i2 i1 b1` 漂到 `o1 n1 s1 u1 i2 b1 i1 s2`；把源码还原重建，序又复原。

⇒ 这是 AVM2 内部 trait/多重名表布局的副产品（连 `adl` 自己都无法在源码演进中保持稳定），**不是语义规则，没有可对齐的目标**；AMF 互通也不依赖它（trait 自带成员名）。故**移出遗留表**、写入 `docs/zh-cn/as3-semantics.md` §3 决策分歧点；本实现的**声明序**（`Quad_amf_members[] = { "a", "b", "c", "d", NULL }`）作为**本方口径**钉住。⚠️ 由此**收窄** 阶段九十四·四 的「与 `adl` 逐字节一致」：应读作「**trait 成员名/值的编码形态**逐字节一致」。

**本批净效果**：新 `examples/stage94e.as`（`[cast]`+`[fncall]`+`[vecfqn]`+`[amforder]` 四组断言，含 A6 的字节级 golden）纳入回归；`test.ts` 新增 **20 条**钉子（5+5+8+2）；`node test.ts` **130 例全通**（阶段九十四·四 的 129 + 本批）；遗留表**移出 6 行、新增 3 行**（`Vector.<*>` 不支持、Function 值的 `this` 重绑、`ByteArray` 正索引越界读给 `0`）；`README-CN.md` 当前限制 + 示例清单；`docs/zh-cn/as3-semantics.md` §3 新增决策分歧点。版本 → **v0.4.37**。

---

#### 阶段九十四·六：C 批遗留攻坚 · C1（`DisplayObject` 几何与命中测试）（v0.4.37 → v0.4.38）✅ 已完成

**触发**：C 批的条目都是「AIR 已定义、我们跑不出」的**可见缺陷**（§1.5 的硬判据），按依赖顺序先做 C1（显示层几何）——它是 C2（输入簇：可编辑文本的命中 / 插入点 / 选区）的地基：插入点、选区高亮、`getCharIndexAtPoint` 全都建立在「舞台坐标 → 对象局部坐标」的同一套变换上。

**四条 C1 行全部实测定案（`adl 51.4.1`，探针 `temp/c1probe/` 4 个 + `temp/c1probe/click/` 真鼠标点击 1 个）**：

| 项 | 原行主张 | 实测结论 |
|---|---|---|
| C1-1 | `Sprite`/`MovieClip` 没有 `graphics` | **已修**：`Sprite`/`MovieClip`/`Shape` 都有 `graphics`。实现为**惰性 getter**（私有 `_graphics`，`Sprite_get_graphics` 首次访问才 `Graphics_new()`）——`Shape_ctor` 那种「每实例无条件分配」会给 Starling 的每个容器都加一次分配 |
| C1-2 | `Shape`/`Bitmap` 的 `width`/`height` 是**存储槽**、赋值**无效**、只读 | **已修，且原行前提错了一半**：`width`/`height` 是**派生访问器**（内容包围盒经自身变换），但赋值**不是无效**——AIR 是**缩放**（`scaleX = scaleX * value / cur`；实测 50 宽 + `width=100` → `scaleX=2`、`width` 报 100、`getRect` 仍 50 宽）。两个方向都实现：读走内容派生、写走缩放；空内容（或 `NaN`）写 → `scaleX=0` |
| C1-3 | `as_pick_hit` 不做父→子坐标变换（只有绝对坐标对象可点） | **已修**：改为**变换感知**——`as_mat_*` 合成父链矩阵逐层折算，命中判定走内容的**局部包围盒**；`as_local_point` 同时供 `hitTestPoint`、`MouseEvent.localX/localY`、`as_tf_index_at` 复用 |
| C1-4 | setter 的语义（原行未覆盖，本轮实测补） | **与 C1-2 同一对访问器**：setter 是**缩放**（`scaleX = scaleX * value / cur`），空内容或 `NaN` → `scaleX = 0`；`TextField` 例外（写真实字段）。`test.ts` 的 `[geometry]` 有 2 条钉子钉住这一对 |

**关键实现选择（都是实测倒逼的，不是设计喜好）**：

- **`Graphics` 自持 CPU 侧路径包围盒**（`_bl/_bt/_br/_bb/_has_b`，每次 `moveTo/lineTo/curveTo/drawRect/drawRoundRect/drawCircle` 更新，含控制点，对齐 `SkPath::getBounds()`）：这样 `width`/`height`/命中测试在**纯 C（无 Skia）构建**下也测得对——Skia 桩返回 0，实测直接暴露（`FAIL: shape 50x30 width (got 0, want 50)`）；且每次读 `width` 不必调 Skia。
- **描边计入 `width/height`，但不计入命中**：实测「0→100 的线 + 10px 描边 → 110×10」（`getRect=(0,0,100,0)`）。门控条件是 `strokeWidth > 0.0` 而非 `g->stroke != NULL`——纯 C 构建里 Skia paint 是 NULL，用 paint 判会漏描边（`FAIL: stroke-only line width (got 100, want 110)`）。
- **`TextField` 把尺寸存进私有 `_fieldWidth`/`_fieldHeight`**：`DisplayObject` 的字段一旦改成 getter，字段解析优先级（`fieldSlot` 先于 getter）就要求 TextField 保留真存储——getter 报「字段 × `scaleX`」（实测 123@scaleX2 → 246），setter 写字段（实测 `width=200` 后 `scaleX` 仍 2、报 400）。
- **不可见子节点计入包围盒，但不渲染**：实测「隐藏子节点仍撑宽父容器」；`as_bounds_walk` 计入、`as_render_bounds` 跳过。两处口径不同，已分别注释。

**本批净效果**：新 `examples/stage94f.as`（覆盖宽度/高度派生与缩放、描边、旋转/矩阵 AABB、容器并集、`Sprite`/`MovieClip.graphics`、`Bitmap`/`TextField` 尺寸、变换感知命中）纳入回归；`test.ts` 新增 `[geometry]` 钉子 **18 条**；`node test.ts` **131 例全通**（含 `[geometry]`、`[textwrap]`、`[native-window]` 全部钉子，`exit=0`）；`temp/nwtest/drive_demo.py` 真鼠标点击验收（重建 `examples/air-native`）**RESULT: PASS**；遗留表**移出 3 行、新增 2 行**（见下）。

**顺带修掉一个自伤 bug（本轮踩到）**：`as_bounds_walk` 里多写的一处 `this.indent++` 让此后 **188 个文件作用域函数**在生成的 C 里带上缩进，而 `staticizeTopLevelFunctions` 只处理「行首无缩进」的行 ⇒ 这些函数**丢失 `static`**，`-O2` 的调用图裁剪整段失效（体积回涨）。是 `[native-window]` 的 **21 条钉子**在回归里抓出来的（它们匹配 `static void NativeWindow_ctor(...) {`）；已修，钉子全绿。

---

#### 阶段九十四·七：C 批遗留攻坚 · C2（可编辑 `TextField` 与键盘/文本输入）（v0.4.38 → v0.4.39）✅ 已完成

**目标**：把八十九·七十七 留下的四条输入面缺口（可编辑文本的键入/粘贴/剪切、编辑键对插入点与选区的操作、非 US 布局与 Option 组合字符、web 键盘/剪贴板接线）按 `adl 51.4.1` 的真实语义落地。native 侧全做；web 侧按 §1.5 **如实报明未支持**（见遗留表）。

**证据台**：`temp/editprobe/`（探针 `src/Ed1.as`…`Ed4.as` + `src/Def.as`/`Def2.as` 默认值与常量探针，驱动 `drive_ed2.py`/`drive_ed3.py`/`drive_ed4.py`/`drive_min.py`/`drive_shift.py`/`drive_sh3.py`/`drive_dbl.py`；`README.md` 里有归一化配方与逐条结论）。同一驱动**两端跑**（`adl` 与 AOT 产物），日志归一化后逐行 `diff`。

**实测口径（全部来自 `adl`，非推测）**：

| 面 | 实测结论 |
|---|---|
| 键入时序 | `keyDown`（cancelable=true）→ `textInput`（cancelable、bubbles、**插入之前**）→ 按 `maxChars` 截断后插入、光标落在插入串之后 → `change`。达 `maxChars` 时 `textInput` 仍带完整载荷、但不插入也不 `change` |
| `preventDefault` | `keyDown` 被取消 ⇒ 整次 `textInput` 都不派发；`textInput` 被取消 ⇒ 不插入不 `change`；改写 `e.text` 下游监听器看得见，但字段插入的仍是**原始**文本 |
| 编辑键 | `Backspace`(8) / `Delete`(46, cc=127) / `Home`(36) / `End`(35) / 方向键 37~40；`Home`/`End` 是**整段文本**首/尾（多行也是）；`Up`/`Down` 按**硬行**走并保留列；单行 `Up`/`Down` 不动；有选区时方向键**塌缩到近端**而不是继续跨过 |
| Shift+Home/End | **不对称**（AIR 自身怪癖）：`Shift+Home` 把选区起点拖到 0 而**光标不动**；`Shift+End` 把选区长到文本尾且**光标落到尾** |
| Shift+Delete | AIR **完全不动**：keyDown **不派发**（Apple 的「剪切」快捷语义不成立）、文本与选区不变；配对的 keyUp 照常派发 |
| Cmd 加速键 | `Cmd+A/C/X/V` 吞掉**字母**的 keyDown 与 keyUp（编辑仍发生），但 Cmd 自己的 keyDown 会派发（kc=15, ctrlKey=true）；`Cmd+Z` **不是**加速键（照常派发、无效）；按住 Cmd 期间，方向键/字母的 keyDown 会到、**keyUp 不到**，而 Cmd 自己的 keyUp 会到 |
| `stage.focus` | 键盘焦点切换派 `focusOut`+`focusIn`，且键盘 `focusIn` **全选**（这正是 Cmd+C 能整段复制的原因） |
| 鼠标 | 拖拽选区**只在 `type='input'` 生效**（dynamic+selectable 字段拖拽只让光标跟到落点）；**双击选词对两者都生效**，发生在**第二次 mouseDown**（早于 mouseUp/click），词 = 最大非空格串、光标在词尾 |
| 组合字符 | 走独立的文本通道：`Option+e` → keyDown kc=0/cc=180 后 `textInput "´"`；`Option+8` → `textInput "•"`（UTF-8 三字节而 AIR 的 `caretIndex` 只 +1） |
| 默认值 | `new TextField()`：`type="dynamic"`、`maxChars=0`、`displayAsPassword=false`、`restrict=null`、**`tabEnabled=false`**（不是 true）、`tabIndex=-1`、`selectable=true`、`autoSize="none"`、`text=""`（**不是 null**）、`width/height=100`；`TextFieldType.INPUT/DYNAMIC="input"/"dynamic"`、`TextEvent.TEXT_INPUT="textInput"`；`stage.tabChildren=true`、`stage.tabEnabled=false` |
| `tabEnabled` 联动 | `type` **真的变化**时 `tabEnabled` 跟到 `(type == "input")`（dynamic→false、→INPUT→true、→回 dynamic→false）；把同一个值再赋一次**不动**手改过的 `tabEnabled` |

> ⚠️ **本行前半句已被阶段九十四·八 推翻**（见下）：`dynamic + selectable` 字段**同样**支持拖选与 `Cmd+C`；C2 当时只做了一次合成拖拽就下了结论。双击选词发生在第二次 mouseDown、词 = 最大非空格串这两点仍然成立。

**实现**（`vendor/window_glue.cc` / `src/runtime.ts` / `src/symbols.ts` / `src/emit.ts`）：

- **文本通道**：不新增回调（那要改约 15 个签名），而是复用 `on_key` 的**保留类型 `"textInput"`** + 新 `sk_window_text_take(id, buf, cap)` 取字节；glue 收 `SDL_TEXTINPUT`（UTF-8，按 `e.text.windowID` 路由窗口）后置脏位，`ASC_window_on_key` 里排空 → `Stage_dispatchText`。`SDL_StartTextInput()` 在建窗后调用（否则 macOS 不给 `SDL_TEXTINPUT`）。
- **`"wordSelect"`**：鼠标通道用同一套保留类型技巧（`on_mouse(id,x,y,"wordSelect")`），由 AS3 桥接层拦下并把词选区直接写到字段上，**不会**变成 `MouseEvent`（文本编辑态，与 `MouseEvent.DOUBLE_CLICK` 是两条路；后者走独立的 `"dblclick"` 保留类型，见阶段九十四·十一）。
- **键盘**：`Stage_dispatchKey` 重写（keyDown 抑制位 `as_key_text_suppressed` 一次性消费、编辑键分派、Shift+Delete 吞掉、Cmd 按住时吞 keyUp）；`as_tf_edit_key` 实现 Home/End/箭头/上下行/Cmd/Option 词跳；`as_tf_word_select` 实现双击选词。
- **模型**：`TextFieldType` 常量类、`TextEvent`（`text` 槽 + `TEXT_INPUT` + `(type,bubbles,cancelable,text)` 构造）、`TextField` 新槽 `type`/`maxChars`/`displayAsPassword`/`restrict`（`restrict` 是 C 关键字 ⇒ 走 `cIdent` 的 `_restrict`）；`EventDispatcher_dispatchEvent` 返回 `!event->cancelled`。
- **默认值修正**：`tabEnabled` 由**误读**的 `true` 改回实测的 `false`（探针里 `true` 是它自己设了 `type=INPUT` 的后果）；`text` 由 `NULL` 改为空字符串（AIR 的 `text` 从不是 null；给 NULL 会让 `f.text == ""` 为假、`f.text.length` 解引用空指针）。

**双端对照结果**（归一化 + 全局去重 + 去时间戳后 `diff`）：`Ed2` 最小回合 **0 行差异**、`Ed4`（`textInput` 取消/改写/preventDefault、keyDown preventDefault）**0 行**、`Ed2` 的 `Shift+Home/End` 矩阵 **0 行**、`Ed2` 双击选词（含 dynamic 字段）**0 行**；`Ed2` 全回合剩 30 行（归一化后）**全部落在 Tab/Shift+Tab**（已登记为焦点遍历缺口，及其 `f2` 选区残留级联）——即**这是整轮唯一未对齐点**；`Ed3` 的 53 行差异逐条归入已登记项（多行字符度量、UTF-8 字节索引、Option 组合键 keyDown、PageUp/Down、以及量测台自身 artifact）。

**本批净效果**：新 `examples/stage94g.as`（常量/默认值/选区模型/`TextEvent`/`dispatchEvent` 返回值共 40 余条断言）纳入回归；`test.ts` 新增 `[textinput]` 钉子 **27 条**（发射出的 C + runtime/胶水源码）；遗留表**移出 2 行、改写 2 行、新增 8 行**（见下）。

**量测台不做的断言（如实记账）**：①双击落点在**空格上**的词边界口径未探（`as_tf_word_select` 的实现按「最大非空格串」且已写在注释里）；②驱动注入的修饰键 keyDown 会出现两次（`flagsChanged` + 显式 VK）而 `adl` 一次——是**合成输入的 artifact**（真键盘不会），不登记为语义差异；③双击由驱动以 `clickState=2` 的**一对** down/up 模拟（真实双击是两对，`SDL` 读到的 `clicks` 都是 2）。

---

#### 阶段九十四·八：`TextField` 边框 + 「动态可选文本」拖选修正（v0.4.39 → v0.4.40）✅ 已完成

**触发**：用户报告两条——①`TextField` 不支持 `border` 属性（编译期报错）；②左侧文本**无法选中/复制**了（「仅在 `type='input'` 才能选」）。②是**回归**：C2 依据 `Ed2` 探针的**一次合成拖拽**误判为「dynamic+selectable 不支持拖选」，并按此把 `mouseMove` 加了 `type == 'input'` 门控。

**证据台**：`temp/editprobe/` 新增探针 `src/Ed5.as`（选区逐事件上报：`mouseDown`/`mouseMove`/`mouseUp` 后读 `selectionBeginIndex`/`selectionEndIndex`/`caretIndex`，含 13a/13b/13c 三组**边界**用例）、`src/Ed6.as`（`BitmapData.draw` + 逐像素扫描边框）、`src/Ed7.as`（真窗口四色字段截图）、`tracesrc/Ed8.as`（颜色属性掩码复核）；新工具 `grabwin.py`（窗口截图 → BMP → 按颜色定位像素包围盒）、`cmp_ed5.py`（结构化比较器，按 `(事件名, 目标, local)` 对齐）；`drive_ed5.py` 扩了边界步骤。

**实测口径二（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| dynamic 拖选 | `dynamic + selectable=true` 字段**支持**拖选：mouseMove 期间选区随落点扩展，mouseUp 后 `Cmd+C` 能把选中文本复制走（**推翻 C2 的误判**） |
| 锚点 | mouseDown 把光标**塌缩**到命中索引并把它设为 anchor；拖拽期 `begin = min(anchor, idx)`、`end = max(anchor, idx)`、`caret = end`（正向/反向给**同一个**选区） |
| 「点在既有选区内」 | 判据是**半开区间** `idx >= sel_begin && idx < sel_end`（语义等价于按 AIR 的像素高亮矩形 `[x(begin), x(end))` 判定——**左边界在内、右边界在外**）；Ed5 step 8（按 idx==1 边界 → **保留**）、step 11a（按 idx==26 == end → **塌缩**）、step 13b/13c 一致 |
| `border` 默认 | `false`（`borderColor` 默认 `0x000000`） |
| 边框几何 | 四条 **1px 完全不透明、无抗锯齿**的实线，落在字段盒的**外沿像素**上：`x∈{0,width}`、`y∈{0,height}`（即覆盖 `0..width` / `0..height` 的边界像素，不是「内缩 1px」）；`BitmapData.draw` 的源面因此是 `width+1 × height+1`（本实现 `as_render_bounds` 同步 +1） |
| 边框图层 | 画在**背景之上**、文字之下；随 `width`/`height` 赋值跟随；随字段缩放（`scale=2` 时线到 `x=100`/`y=40`） |
| 边框与度量 | 边框**不影响** `textWidth`/`textHeight`（Ed6：w 100→100、h 30→30、tw 72→72、th 15→15） |
| 颜色属性 | `backgroundColor`/`textColor`/`borderColor` 都是 **24 位 RGB**：写入**丢弃 alpha 字节**，读回也看不到（`0x8000FF00` → `0xff00`、`0xFFFFFFFF` → `0xffffff`，Ed8 B/G/F 三行）；`backgroundColor` 默认 `0xFFFFFF`（读回 `16777215`） |
| 跨端封装 | 两侧 `selectionBeginIndex`/`EndIndex` 与 `caretIndex` 逐值相同（`cmp_ed5.py` 结构化比对 **0 处语义差异**；仅剩已登记的**光标落点度量差** 18/23 vs 21/26，及 adl 侧鼠标移动被合并的 harness 差异） |

**实现**（`src/symbols.ts` / `src/emit.ts`）：

- **拖选门控纠正**：删掉 `mouseMove` 的 `type == 'input'` 门控（保留 `selectable`），拖拽锚点/扩展对**所有可选字段**生效；键入仍限 `input`（`as_tf_is_input` 未动）。
- **半开区间**：`mouseDown` 分支判 `tf->_sel_end > tf->_sel_begin && idx >= tf->_sel_begin && idx < tf->_sel_end` → 记 `drag_anchor = -2` 表示「保留既有选区」，否则塌缩到 `idx`；`mouseUp` 遇 `-2` 才把选区塌缩到释放索引。
- **双击选词与塌缩的交互**：`drag_tf`/`drag_anchor` **提升为文件作用域 static**，`wordSelect` 桥接里清成 `NULL`/`-1`——否则双击落在既有选区内时 mouseDown 会先置 `-2`，mouseUp 又把刚选中的词塌缩掉。
- **`border`/`borderColor`**：`TextField` 新增两槽（含反射表项与指纹）；构造器默认 `false`/`0x000000`；渲染在 `background` 门控**之外**、以**四个像素对齐的填充矩形**画出（**不用 `stroke`**——`stroke` 会半覆盖外沿像素，实测与 adl 不符）；`as_render_bounds` 与 `BitmapData.draw` 的源面在 `border` 时 **+1**。
- **颜色属性掩码**：三个颜色属性加 write-only setter（`& 0xFFFFFFu`）——渲染本就用独立 alpha 参数（`as_skia_paint_fill(rgb, 1.0)`），所以 alpha 只影响**读回**；无掩码时读回 `0x8000FF00` 而 adl 是 `0x0000FF00`。③`backgroundColor` 构造默认 `0xFFFFFFFFu` → `0xFFFFFFu`（adl 读回 `16777215`）。

**双端验证**：`cmp_ed5.py`（Ed5 全步骤）→ **0 处语义差异**；`grabwin.py` 双端窗口截图（Ed7 四字段）——f1 绿（1px 边框于外沿）几何与 adl 一致（`101×31` vs AOT `202×62` @2x）、f2（`border=false`）两端均不可见、f3 边框盖背景、f4（`scale=2`）随缩放；Ed6 的逐像素扫描与 adl 逐值相同。**遗留**：`scale=2` 时线宽差异（adl 恒 1 物理 px 不随对象缩放，我们随 transform 缩放；`scale=1` 两侧完全一致）→ 新增遗留行。

**本批净效果**：新 `examples/stage94h.as`（默认值/读写往返/**掩码**/边框不改文本度量/正交四态）纳入回归；`test.ts` 新增 `[textsel]` 钉子 **14 条**，并把 C2 的 `[textinput]` 陈旧钉子（「非可输入字段的拖拽不选词」）**改写**为「拖选不再门控 `type`，键入仍限 `input`」；`node test.ts` **133 例全通**（阶段九十四·七 的 133 例）；`README-CN.md` 支持矩阵 + 当前限制（新增一条阶段九十四·八）；遗留表**新增 1 行**（缩放边框线宽）、**改口径 1 行**（字体度量行补 Ed5 光标落点证据）。版本 → **v0.4.40**。

---

#### 阶段九十四·九：DisplayObject 几何/坐标 API 族（`getBounds`/`getRect`/`localToGlobal`/`globalToLocal`/`hitTestObject` + `hitTestPoint` 上移）（v0.4.40 → v0.4.41）✅ 已完成

**触发**：`### 遗留待开发` 表中的「几何/坐标 API 族未实现」行（阶段九十四·六 实测登记）——地基（`as_bounds_walk` 内容包围盒、`as_mat_{mul,invert}`、`as_local_point` 父链折算）已铺好，缺的是把它们暴露成 API；且 AIR 把 `hitTestPoint` 放在 `DisplayObject` 上，本子集只挂在 `Sprite`（`Shape` 用不了）。

**证据台**：`temp/geoprobe/`（`GeoMain.as` + `geo-app.xml`，用 `mxmlc` 编、`adl 51.4.1` 跑）；逐值输出留在 `temp/geoprobe/adl_geo.txt`（A/B/C/D/E/F/G/H/I/J/K 共 11 组用例）。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| `getRect(target)` | 内容包围盒（不含描边）在 **target 坐标系**下的轴对齐矩形；`target == null` ⇒ 对象**自身局部空间**（== `getRect(self)`）；`target == self` ⇒ 精确局部盒（旋转对象也是 `0,0,100,20` 而非带 `cos(90°)` 噪声）；`target = 父` ⇒ 平移到自身 `x/y`；无关对象 ⇒ 经舞台折算；空内容 ⇒ `0,0,0,0` |
| `getBounds(target)` | 同 `getRect` 但**含描边**：每边外扩 `strokeWidth/2`（`lineStyle(10)` + `drawRect(0,0,30,40)` ⇒ `getRect=0,0,30,40`、`getBounds=-5,-5,40,50`） |
| `localToGlobal(p)` / `globalToLocal(p)` | 走**完整祖先矩阵链**；返回**新** `Point`、**不改实参**；两次 `getRect` 也返回不同引用 |
| `null` 点 | `localToGlobal(null)` 抛 **TypeError #2007** |
| `hitTestObject(obj)` | 两个**舞台空间**包围盒求交，且**含描边**（仅靠 20px 描边擦到的两图形也 true）；跨不同父可用；未上列表可用；**空对象永不相交**（对自己也 false） |
| `hitTestPoint(x,y)` | 点取**舞台坐标**，属于 **DisplayObject**（`Shape` 也有）；`NaN` ⇒ false |
| `hitTestPoint(...,true)` | 像素级：`drawCircle` 的 `(2,2)` 在包围盒内但像素外 ⇒ **false**，`(40,40)` 圆内 ⇒ true（⇒ 我们两种都查包围盒，登记为遗留） |

**实现**（`src/symbols.ts` / `src/emit.ts`）：

- **归位 `DisplayObject`**：`getBounds`/`getRect`/`localToGlobal`/`globalToLocal`/`hitTestObject`/`hitTestPoint` 六个方法全挂到 `DisplayObject`（vtable 自动派生）；`Sprite` 的 `hitTestPoint` 删除，C 函数 `Sprite_hitTestPoint` → `DisplayObject_hitTestPoint`（`Shape` 因此可用）。
- **新助手**：`as_to_stage_matrix(o,...)`（局部→舞台，从 `as_local_point` 拆出，正向方向复用）、`as_rect_xform`（矩形过矩阵后重取 AABB）、`as_rect_to_stage`/`as_rect_from_stage`。
- **顺修矩阵合成的别名 bug**：原 `as_mat_mul(..., a,b,c,d,tx,ty, &a,&b,&c,&d,&tx,&ty)` 把输入与输出**同名**，`as_mat_mul` 按序写出 ⇒ `*b` 读到已被覆写的 `a`；只在祖先有旋转/斜切时错（顶层对象的父是恒等 `Stage`，故此前不可见）。改为临时量 `na..nty` 再赋值，并用 K 段（祖先旋转）用例钉住。
- **短接与写屏障**：`target != NULL && target != o` 才做矩阵往返（保 `getRect(self)` 精确）；`hitTestObject` 的空对象早返回；null 点 `as_throw(TypeError_new(..., 2007))`。

**验收**：新 `examples/stage94i.as`（A~H 八组断言，逐条对齐 `adl_geo.txt`，含祖先旋转的 K 段）纳入回归；`test.ts` 的 `[geometry]` 新增 **7 条**钉子（API 归位/`Sprite_hitTestPoint` 消失/别名修复/`getRect` 短接/`hitTestObject` 含描边/两处 `#2007`）；`node test.ts` **134 例全通**；`README-CN.md` 支持矩阵与当前限制同步（新增一条阶段九十四·九）。遗留表**移出 1 行**（几何/坐标 API 族）、**新增 1 行**（`hitTestPoint(...,true)` 像素级）。版本 → **v0.4.41**。

---

#### 阶段九十四·十：可空字符串字段的装箱归一（`as_v_str(NULL)` → `null`）（v0.4.41 → v0.4.42）✅ 已完成

**触发**：`### 遗留待开发` 表的「字符串字段读到 C `NULL` 时装箱为 **tag-3 空指针**而非 AS3 的 `null`」行（阶段九十四·七 实测登记）——`as_v_obj`/`as_v_arr`/`as_v_fn` 三个指针类装箱助手都早已把 NULL 归一到 `as_v_null()`（阶段九十四·一 的注释写明理由：AS3 只有一个 null，否则 `while ((v = src.next()) != null)` 永不终止），唯独 `as_v_str` 漏了这一步。

**实测修正**：该行的原始表述「`new TextField().restrict == null` 在 `adl` 为 true、我们为 false」**不准确**——`restrict` 是静态 `String` 类型，直接比较发出的是 `((g_f->_restrict) == NULL)`（一直都是 true）。真正的差异在**动态**上下文：`var x:* = f.restrict; x == null` 修前为 **false**（tag-3/NULL 指针 vs tag-0），且 `x == ""` / `x.length` 直接**段错误**（`strcmp`/`strlen(NULL)`）；修后为 **true / false / 0**（与 `adl` 一致）。

**实现**（`src/runtime.ts` 一行）：`as_v_str` 增加 `if (s == NULL) return as_v_null();` —— 与三个同类助手的约定对齐，且是**唯一的字符串装箱入口**（`boxExpr` 的 `string` 分支、`as_v_str(...)` 调用点均经它），故一处修复覆盖**全部**可空字符串字段/返回值（`restrict`、未来的 `styleSheet`/`TextFormat.font` 等）。`text` 的「构造时给空字符串」保持不变（AIR 实测 `text` 恒为 `""`）。

**验收**：`examples/stage94g.as` 断言强化（`check(f.restrict == null)` + `check(!(f.restrict == ""))`）；`test.ts` 的 `[textinput]` 新增 **2 条**钉子（`as_v_str` 的 NULL 分支存在、动态装箱经 `as_v_str` 与 `as_v_eq(..., as_v_null())`）；`node test.ts` **134 例全通**；`README-CN.md` 当前限制同步。遗留表**移出 1 行**。版本 → **v0.4.42**。

---

#### 阶段九十四·十一：`MouseEvent.DOUBLE_CLICK` 的派发（v0.4.42 → v0.4.43）✅ 已完成

**触发**：`### 遗留待开发` 表的「`MouseEvent.DOUBLE_CLICK` **从不派发**」行（阶段九十四·七 登记）——`doubleClickEnabled` 早已建模（默认 `false`），C2 的双击选词只是走引擎内部的 `"wordSelect"` 保留类型借道，运行时**从不**产生 `doubleClick` 事件。

**证据台**：`temp/editprobe/src/Ed9.as` + `drive_ed9.py`（四区域 Sprite 矩阵：目标自身开/关、祖先开、默认关）；逐事件输出留在 `temp/editprobe/adl_ed9.txt`（`adl 51.4.1`）与 `aot_ed9.txt`（本编译器），逐行一致。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| 时序 | 一次双击 = `down,up,click, down,up,doubleClick` —— 第二次 `click` **被替换**为 `doubleClick`（**不是**追加）；三击 = `click,doubleClick,click`（`clickCount==3` 又变回普通 `click`） |
| 门控 | 落在**命中目标自身**的 `doubleClickEnabled` 上：目标 `s3`（`false`）在祖先 `s1`（`true`）内 ⇒ **无** `doubleClick`；目标 `false` 时第二次仍是普通 `click` |
| 事件形状 | `doubleClick` \| `bubbles=true cancelable=false`；`target` = 最深命中对象；`localX/localY` = 第二次按下的局部坐标；祖先监听者收到时 `eventPhase==3`（冒泡） |
| 常量 | `MouseEvent.DOUBLE_CLICK == "doubleClick"`（与 `CLICK` 不同 type） |

**实现**（`vendor/window_glue.cc` + `src/emit.ts`）：

- **glue**（`SDL_MOUSEBUTTONUP`）：第二次点击时用 `e.button.clicks == 2 ? "dblclick" : "click"` 把 `click` 换成保留类型 `"dblclick"`（SDL 的 `clicks` 携带平台点击计数；`clicks==3` 回到 `"click"`，与三击实测一致）。仍先发 `mouseUp`。
- **AS3 桥接层**（`emit.ts` 的 `ASC_window_on_mouse`）：像 `"wordSelect"` 一样在 `Stage_dispatchMouse` **之前**拦下 `"dblclick"`——`as_pick_hit` 命中后 `as_is(hit, &InteractiveObject_vt)` 守卫（`Shape`/`Bitmap` 是 `DisplayObject` 但**非** `InteractiveObject`，不能直读该字段）再读目标的 `doubleClickEnabled`，决议为 `"doubleClick"` 或 `"click"`。

**验收**：新 `examples/stage94j.as`（常量/默认与读写/`InteractiveObject` 归位/冒泡+相位+`target`/`currentTarget`/事件 flag/与 `CLICK` 互不串台）纳入回归；`test.ts` 新增 `[doubleclick]` **9 条**钉子（glue 的打标与「不再无条件发裸 click」、桥接拦截/`InteractiveObject` 守卫/门控决议、`doubleClickEnabled` 结构体字段与默认 `false`、`DOUBLE_CLICK` 常量）；`node test.ts` **135 例全通**（新增 stage94j）；`README-CN.md` 当前限制同步。遗留表**移出 1 行**（`DOUBLE_CLICK` 从不派发）、**新增 0 行**。版本 → **v0.4.43**。

---

#### 阶段九十四·十二：空接收者的成员访问 —— 段错误 → `TypeError #1009`（v0.4.43 → v0.4.44）✅ 已完成

**触发**：`### 遗留待开发` 表的「空对象（`null`）的属性/方法访问是**段错误**而非 AIR 的 `TypeError #1009`」行（阶段九十四·七 登记；`f.stage.tabChildren` 与 `x.length`（`x` 为 null 字符串）会 SIGSEGV）。

**证据台**：`temp/nullprobe/NullMain.as` + `null-app.xml`，用 `mxmlc` 编译后 `adl 51.4.1` 运行，逐行结果写在 `temp/nullprobe/adl_null.txt`。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| 读/写/方法调用 | 对 `null` 的**任何**成员访问都抛 `TypeError #1009: Cannot access a property or method of a null object reference.`，与静态类型无关（`Sprite`/`Object`/`Array`/`String`/`*`） |
| 容器下标 | `a[0]`/`a.length`/`a[0]=v` 在 `a` 为 null 时同样 `#1009`（不是 `undefined`） |
| `*` 未赋值 | `var y:* = null; y.bar()` → `#1009`（不是 `#1006`） |
| 函数值调用 | `var f:Function = null; f()` → `TypeError #1006: value is not a function.`（**#1006 而非 #1009**） |

**实现**（`src/runtime.ts` + `src/emit.ts`，纯生成侧，不动运行时内部 C 调用）：

- **两个运行时守卫**（`emit.ts` 前导，紧邻 `as_with_box`）：`as_req_obj(void*)` 空则抛 `#1009`；`as_req_box(as_value)` 对 tag 0/5 抛 `#1009`/`#1010`；另有 `as_req_fn(as_fn,name)` 空则抛 `#1006`（复用已有的 `as_throw_not_function`）。
- **成员/下标访问点全部加守卫**（`emitMember`/`emitIndex`/`emitAssign`/`emitCall`）：指针接收者（class/Array/Vector/String/record/XML/Dict/Function）经 `as_req_obj`；`*` 经 `as_req_box`（并让 `as_any_call` 入口先 `v = as_req_box(v)`）；函数值调用经 `as_req_fn`。
- **不做无谓检查**：`this`、`new` 结果、数组/对象/向量字面量、函数表达式、字符串字面量可证明非空，`definitelyNonNull` 跳过守卫（既不误报也不拖慢热路径）。

**验收**：新 `examples/stage94k.as`（A~G 七组：类实例读/写/方法、`Object`、`Array` 下标读/写/`length`、`String` 长度/方法、`Date`、null 函数值 `#1006`、以及非 null 接收者的无回归断言）纳入回归；`test.ts` 新增 `[nullref]` **15 条**钉子（两个守卫的指纹、七类接收者的守卫形状、`as_req_box`/`as_any_call`、以及 `this`/字面量不守卫）；`node test.ts` **136 例全通**；`README-CN.md` 当前限制同步。遗留表**移出 1 行**、**新增 0 行**。版本 → **v0.4.44**。

---

#### 阶段九十四·十三：`Tab`/`Shift+Tab` 焦点遍历（v0.4.44 → v0.4.45）✅ 已完成

**触发**：`### 遗留待开发` 表的「`Tab`/`Shift+Tab` 的**焦点遍历**未实现」行（阶段九十四·七 C2 登记；**这是 Ed2 全回合唯一未对齐点**）。

**证据台**：`temp/editprobe/src/Ed10.as`（a/b[`tabEnabled=false`]/c/d/e 五个输入框 + `box`/`gate`/`reorder` 三个 Sprite）+ `drive_ed10.py`，`adl 51.4.1` 与 AOT 双端各跑一遍，逐行输出在 `temp/editprobe/adl_ed10.txt` / `aot_ed10.txt`（归一化去时间戳后 **85 行对 85 行、0 差异**）。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| 环 | 显示列表**先序**遍历中 `tabEnabled==true` 的 `InteractiveObject`；`tabEnabled=false` 者被跳过 |
| 方向 | 两个方向都 wrap（Tab 越过末个 → 首个；Shift+Tab 在首个之前 → 末个） |
| 焦点为 null | Tab → 首个可聚焦对象，Shift+Tab → 末个 |
| 锚点 | 焦点为 null 且**此前鼠标按下过某个字段**时，从该字段的显示位置之后继续（`a` 已点过 ⇒ Tab 落到 `c`）；从未点过任何字段则从头/尾开始。**遍历本身不移动锚点** |
| 时序 | 移动发生在 keyDown **派发之后**；同一次按键的 keyUp 派发给**新**焦点 |
| `preventDefault()` | 完全抑制移动（keyUp 仍发旧焦点） |
| 焦点事件 | `focusOut(old, relatedObject=new)` → `focusIn(new, relatedObject=old)`，均 `bubbles=true cancelable=false`、`phase=3`、`currentTarget=stage` |

**实现**（`src/emit.ts` 纯生成侧）：

- `as_tab_scan(DisplayObject*, …)`：先序递归收集可聚焦对象及其显示序号（序号递增，故「下一个/上一个」就是一次扫描）；同时记录焦点与锚点的序号。上限 64 个对象（远超任何真实表单，超出即不再移动）。
- `as_focus_tab(DisplayObject* root, int dir)`：`focus_ord < 0` 时回落到锚点序号，再按方向取首个更靠后/靠前的可聚焦对象，越界即 wrap，最后交给已有的 `as_set_focus`（它本就派 `focusOut`/`focusIn`）；`root` 取**收到按键的那个 Stage**（多窗口下按窗口遍历，而不是全局根）。
- `as_tab_anchor`：新增文件作用域静态指针，**只**由 `as_focus_from_mouse_down`（鼠标按下聚焦字段）写入，遍历不改它；并作为**永久 GC 根**登记（与 `as_focus_obj` 同理）。
- 钩子：`Stage_dispatchKey` 里、keyDown 派发与 `as_key_text_suppressed = evt->cancelled` 之后加一行 `if (keyCode == 9 && !evt->cancelled) { as_focus_tab(...); return; }`——位于 `if (!down) return;` 之后，故 keyUp 永不触发遍历。
- **新增测试钩子** `Stage.dispatchKey(type, keyCode, charCode, mod)`（`src/symbols.ts`，与 `dispatchMouse`/`dispatchWheel` 同一约定）：`mod` 用运行时的 `ASC_MOD_*` 位掩码（1=ctrl, 2=alt, 4=shift, 8=cmd），headless 示例因此可以驱动键盘与焦点遍历。

**偏离记录**：① `tabIndex` 排序**未实现**——`reorder` 探针（把 `e.tabIndex` 设为 1）下 `adl` 的顺序无法稳定复现，且原遗留行只提「焦点遍历未实现」；② 「焦点为 null 但曾有字段聚焦历史」的锚点在 `adl` 上表现为内部状态相关的边缘差异（同一场景两次测量给出不同落点），按上表的主口径实现并记录。

**验收**：新 `examples/stage94l.as`（A~H 八组：`tabEnabled` 默认值、前进/跳过/wrap、Shift+Tab 反向 wrap、null 焦点从头/尾、锚点续接、`preventDefault` 抑制、keyUp 发往新焦点、非 tabbable 对象充当锚点）纳入回归；`test.ts` 新增 `[tabfocus]` **15 条**钉子（环的先序/filter/不收 `tabIndex`、选取与双向 wrap、锚点回落、按窗口 root、GC 根、钩子在 keyDown 且读 post-dispatch `cancelled`、`dispatchKey` 接线）；`node test.ts` **137 例全通**；`README-CN.md` 当前限制同步。遗留表**移出 1 行**、**新增 1 行**（窗口键盘通道的 Shift 自身键被派发两次）。版本 → **v0.4.45**。

---

#### 阶段九十四·十四：`TextField.restrict` 过滤 + 多行 `Return` 的换行提交（v0.4.45 → v0.4.46）✅ 已完成

**触发**：`### 遗留待开发` 表的「`restrict`/`displayAsPassword` 只存不生效」行（阶段九十四·七 C2 登记）。本阶段只做 `restrict` 的一半（`displayAsPassword` 的遮罩渲染另立一行）。

**证据台**：`temp/editprobe/src/Ed11.as`（4 个不同 `restrict` 的输入框）、`Ed12.as`（8 框模式电池：`A-Z`/`a-z`/`0-9\-`/`\^`/`abc`/`^a`/`""`/`null` + 程序化赋值 + 多字符载荷 + 选区）、`Ed13.as`（多行字段的 `Return`）、`Ed14.as`（选区 + 全拒字符），配 `drive_ed11.py`..`drive_ed14.py`；`adl 51.4.1` 与 AOT 双端各跑一遍，日志 `temp/editprobe/adl_ed1{1,2,3,4}*.txt` / `aot_ed1{1,2,3,4}.txt`。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| 模式语法 | **允许集**；`-` 是区间、`\` 转义下一个字符；**开头**的 `^` 把整集翻转成**排除集**。`null` = 不过滤、`""` = 什么都不允许（两者**不同**） |
| 逐字符判定 | 允许则原样插入；否则若**大小写互换**后的字符被允许，就插入**那一个**；两者都不允许才丢弃。`"A-Z"`+`a` → 插入 `A`；`"a-z"`+`Z` → 插入 `z`；`"^a"`+`a` → 插入 `A`（被排除的只是小写形式）；`"^5"`+`5` → 丢弃（数字无第二种大小写） |
| 时序 | 过滤在 `textInput` **派发之后**（事件载荷永远是**原始**文本，监听器可 `preventDefault` 取消整次输入），在 `splice` 之前 |
| 作用范围 | **只过滤用户输入**（键入与粘贴同管道）；程序化 `text = "..."` 赋值从不经过滤 |
| 换行 | CR/LF **绕过**过滤：多行字段 `restrict="0-9"` 时 `Return` 仍插入换行 |
| 全被丢弃时 | 插入 0 字符 ⇒ **不发 `change`、光标不动**；但**有选区时选区照样被吞掉并派发 `change`**（与 `maxChars` 溢出共用同一条 `splice` 语义） |
| 多字符载荷 | 粘贴的整串是**一个** `textInput`（载荷未过滤），逐字符过滤后才插入（`"ab5"` 进 `0-9\-` → 只插 `5`） |

**实现**（`src/emit.ts` 纯生成侧）：

- `as_tf_restrict_has(p, c)`：把一个候选字节在**未取反**的模式里做成员判定（左到右解码区间与转义）。匹配是**按字节**的——ASCII 模式会逐个丢弃多字节字符的每个字节，即整字符丢弃，与 adl 的「按字符」判定视觉结果一致。
- `as_tf_restrict_char(pat, c)`：`NULL` 直接放行；否则按「取反」语义判定，被拒时回退到**大小写互换**的字符，仍被拒则返回 0（丢弃）。
- `as_tf_insert_text`：`textInput` 派发且未被取消后，`_restrict != NULL` 时先逐字节过滤（CR/LF 直接放行）得到 `ins`，再用 `ins` 走原来的 `splice` + `change` 路径；`_restrict == NULL` 时 `ins` 就是原指针（零开销、行为不变）。
- **顺手修掉一个真缺口**：`Return` 在多行可编辑字段里原本**插不进换行**——`SDL2/Cocoa` 的文本输入类只实现 `insertText:replacementRange:`、**没有 `insertNewline:`**（`strings vendor/sdl2/arm64/lib/libSDL2.a` 可证），所以真实按键只产生 `SDL_KEYDOWN`、永远没有 `SDL_TEXTINPUT`。现在在 `Stage_dispatchKey` 的 keyDown 分支里对 `keyCode == 13 && tf->multiline` 合成一次 `as_tf_insert_text(tf, "\r")`，与键入走完全同一条管道（被 `preventDefault` 的 keyDown 仍会抑制它）。修后 Ed13 双端**文本逐字一致**（`m1="5\r\r7"`、`m2="x\ry"`）。
- **新增测试钩子** `Stage.dispatchText(text)`（`src/symbols.ts`）：与 `dispatchMouse`/`dispatchKey`/`dispatchWheel` 同一约定，把一次文本提交喂进 `Stage_dispatchText`，headless 示例因此能驱动「键入」的完整四段时序。

**偏离记录**：多行 `Return` 的 `textInput` **载荷**我们报 `"\r"`、`adl` 报 `"\n"`（结果文本两端一致）；已作为独立遗留行登记。

**验收**：新 `examples/stage94m.as`（A~J 十组：默认值/往返、允许集收放、大小写互换回退、`^` 排除集、区间与转义、`""` vs `null`、程序化赋值不过滤、多字符载荷逐字符过滤、`Return` 绕过过滤、全拒按键吞选区）纳入回归；`test.ts` 新增 `[restrict]` **17 条**钉子；`node test.ts` **138 例全通**；`README-CN.md` 当前限制同步。遗留表**移出 1 行**（`restrict` 那半）、**新增 2 行**（`displayAsPassword` 遮罩、`Return` 载荷口径）。版本 → **v0.4.46**。

---

#### 阶段九十四·十五：视觉行导航 —— `PageUp`/`PageDown` + 软换行的 `Up`/`Down`（v0.4.46 → v0.4.47）✅ 已完成

**触发**：`### 遗留待开发` 表的「`PageUp`/`PageDown` 只是**派发不改动**」与「多行**软换行**（`wordWrap=true`）时 `Up`/`Down` 的 X 列口径缺失」两行（阶段九十四·七 C2 登记）。两行共用一份「**可视行布局**」，本阶段一并落地。

**证据台**：`temp/editprobe/src/Ed15.as`（`h1` = 300×36 多行不换行、6 条硬行、LEN 42；`h2` = 单行；`w1`/`w2` = 两个 `wordWrap=true` 多行字段）+ `drive_ed15.py`（支持 round 1/2；round 2 用 **F1..F7** 裸功能键做程序化命令通道——`Ctrl+<digit>` 会被本机 CJK 输入法提交成字面文本污染被测量字段）。`adl 51.4.1` 与 AOT 双端同序列各跑一遍：`adl_ed15.txt` / `adl_ed15b.txt`（round 2）、`aot_ed15b.txt`；另有 debug 仪表产物 `/tmp/ed15dbg`（源码 `/tmp/ed15dbg.c`）用来排除「点击后光标/scrollV 异常」的假警报。

**实测口径（全部来自 `adl 51.4.1`）**：

| 面 | 实测结论 |
|---|---|
| 上下的单位 | **视觉行**（软换行也算一行），不是 CR 分隔的硬行。`w1` 实测 `10 → 22 → 33`、`w2` 实测 `10 → 31 → 52 → 73 → 94 → 115`，全部落在**软换行行首** |
| 列位（箭头） | **sticky goal 列**：短行上被钳到行尾，但**列位被记住**，再走到长行会恢复（`w1` 上 `10 → 22`（钳）`→ 33`（恢复 10））；首/末行箭头 **no-op**（不钳到文本两端） |
| 列位（翻页） | 用光标**当前列**（每次重算，不保留 goal）：`h1` 上 `caret 4` → PD → `18`（行 2 第 4 列）→ PD → `35`（行 4 第 4 列） |
| 翻页步长 | **可见行数**（`fieldHeight / lineHeight`，下限 1）；单行字段可见行数 = 1 |
| 翻页 clamp | 越过**末行** ⇒ 光标 = **文本尾**（`text.length`）；越过**首行** ⇒ 光标 = **0**（与箭头的 no-op 不同） |
| 单行字段 | 箭头 **no-op**；翻页键**会动**（`0` ↔ `text.length`），因为它的钳位对象是文本两端而非相邻行 |
| `scrollV`（方向敏感） | `PageDown` ⇒ `SV = clamp(caretLine + 1, 1, maxScrollV)`（光标行钉视口**顶部**）；`PageUp` ⇒ `SV = clamp(caretLine - visible + 2, 1, maxScrollV)`（钉**底部**）；**箭头**只在光标要越出视口时才滚动（`dir = 0` 的 clamp-only 语义） |
| Shift + 翻页 | = **扩选**（锚点留原处），与 `Shift+Up/Down` 同义；`h1` 上 `End(42)` 后 `Shift+PageUp` ⇒ `SEL=(30,42)`、`caret=30` |
| `change` | 翻页键/箭头**不改文本** ⇒ 从不派发 `change` |

**实现**：

- `vendor/skia_glue.cc` 新增 `int sk_textlayout_line_metrics(void* para, int* starts, int* ends, double* tops, double* bottoms, int cap)`：用 `Paragraph::getLineMetrics` 逐**可视行**填 `fStartIndex`/`fEndIndex` 与 `fBaseline ± fAscent/fDescent`（`tops`/`bottoms` 可为 `NULL`），返回写入数——一行表同时供上下移动、翻页、`scrollV` 三处使用。
- **顺手修掉一个真缺口（CR 不是换行）**：`TextField.text` 里每个 `Return` 都存成 **CR**，而 Skia 段落**只在 LF 断行** ⇒ 修前 `h1`（多行不换行）被 Skia 报成 **1 行**（`numLines=1`、`textHeight=12`），整个多行文本摊在一条视觉行上。新增 `static const char* sk_textlayout_normalize(const char* text, int collapseNewlines, std::string& buf)`（`skia_glue.cc`）：把 **CR(0x0D) → LF**（**保持字节长度 1↔1**，故 UTF-16 的 `fStartIndex` 对 `tf->text` 仍然有效）；`collapseNewlines`（单行字段）时 CR/LF 一律变空格。`sk_textlayout_new` / `_new_leading` / `_new_runs` **三处**统一改用它。修后 `h1` 的 `numLines=6` ✓、`textHeight=72` ✓（与 adl 逐值一致）。
- `src/runtime.ts`：`sk_textlayout_line_metrics` 的 `extern` 声明 + `as_skia_textlayout_line_metrics` 内联包装 + 无 Skia 时的 `(void)…; return 0;` 桩。
- `src/emit.ts`（纯生成侧）：`TextField` 新增 `int _goal_col;`（ctor 置 `-1`；`as_tf_set_caret`/`as_tf_extend_caret` 末尾一律清 `-1`，由垂直移动自行恢复）；新增 `as_tf_line_table`（有 Skia 段落取可视行，否则回落 **CR/LF 硬行扫描** + 均匀行高 `n*lh`）、`as_tf_line_of_index`、`as_tf_line_end`（剥掉行尾 CR/LF，保证光标永不落到换行符上）、`as_tf_scroll_caret`（上表的三个方向语义，clamp 在 `[1, MSV]`，`MSV = line_count - visible + 1`）、`as_tf_vmove(tf, dir, step, page, shift)`（单行 + 非翻页直接 return；列位取 goal 或当前列；越界时 `!page` return、翻页钳到文本两端；`shift` 走扩选，否则移动光标；非翻页更新 goal）；`as_tf_line_ud` 退化为 `as_tf_vmove(tf, dir, 1, 0, shift)`。`as_tf_is_edit_key` 纳入 **33/34**；`as_tf_edit_key` 新增 `if (keyCode == 33 || keyCode == 34) { as_tf_vmove(tf, keyCode == 33 ? -1 : 1, as_tf_visible_lines(tf), 1, shift); return; }`，并只对非 38/40 的移动清 `_goal_col`。
- **纯 C 回落的口径对齐**：`as_tf_line_count` 的桩原本只数 `LF` ⇒ 同一份文本在「有 Skia」与「无 Skia」两种构建下 `numLines` 不同。现同时数 `CR` 与 `LF`（`\n` || `\r`），与 Skia 路径归一化后的结果一致。

**验收**：新 `examples/stage94n.as`（A~H：硬行结构、翻页整段序列（`0→14→31→42` / `42→30→12→0`）、列位保留（`4→18→35`）、短行钳位 + goal 记忆（`9→13→23→30→40` 再逐级回退）、`scrollV` 三向语义、Shift 扩选、单行字段、软换行形状）纳入回归；`test.ts` 把 C2 的陈旧钉子（「`PageUp`/`PageDown` 故意不在编辑键集合里」）**改写**为 6 条新钉子（编辑键集合、可视行表、clamp 与 no-op 分界、goal 列、`scrollV` 三向、CR 归一化）。`node test.ts` **139 例全通**（新增 1 例）；`README-CN.md` 当前限制同步；遗留表**移出 2 行**、**新增 1 行**（列位用字符列而非像素 X goal）。版本 → **v0.4.47**。

**度量耦合（已登记遗留行「字体度量偏小」，本阶段必须显式说明）**：`scrollV`、可见行数、软换行落点**全部**由行高与字符前进驱动——我们 `_typewriter 12` 的 Skia 命中字体与 AIR 的不同（见该遗留行），故**窗口 AOT 下**同样序列的**数值**会与 adl 不同（例：36px 高字段我们 `visible=3`／adl `2`，`w2` 我们的可视行数 `8`／adl `6`），而**规则逐条一致**（round 2 双端逐项核对：列保留、文本两端 clamp、`SV` 三向、页键/箭头边界**全部对齐**）。纯 C 构建的桩行高恰为 `size × 1.2`，与 AIR 的 15/12 比值一致，故 `examples/stage94n.as` 的断言值**逐值等于 adl 实测值**。


---

#### 阶段九十四·十六：`displayAsPassword` 遮罩（v0.4.47 → v0.4.48）✅ 已完成

**触发**：遗留行的「`displayAsPassword` 只存不生效（渲染成圆点）」——阶段九十四·七 主动登记、阶段九十四·十四 收窄（`restrict` 那半已完成）。按 AGENTS.md §1.5，先写 `adl 51.4.1` 探针实测口径，再编码。

**证据台**：`temp/editprobe/src/Ed16.as`（11 个字段）+ `drive_ed16.py`（F1..F7 命令通道）+ `ed16-app.xml`（400×520）+ `ed16.build.json`；截图工具 `snapwin.py`（`CGWindowListCreateImage` → PNG）。双端日志 `adl_ed16.txt` / `aot_ed16.txt`，真窗口截图 `snap_ed16_adl_final.png` / `snap_ed16_aot_after-p2-click.png` / `snap_ed16_aot_final.png`。

**adl 实测口径**：

| 面 | 实测结论 |
|---|---|
| 遮罩字符 | **星号 `*`**（不是圆点） |
| 布局 | 遮罩**参与排版**：AIR 把「一个字符一个 `*`」的串交给排版器，`textWidth`/`textHeight`/`numLines`/点击落点/光标与选区几何**全部按星号串度量** |
| 判据（比例字体才看得出来） | `_sans` 12 的 `"WWWWWWWWWW"` 明文 `textWidth` **113**、遮罩后 **46.5**；同一字段换成 `"iiiiiiiiii"` 遮罩后**也是 46.5** —— 两者量的是**同一个** 10 星号串 |
| `type='dynamic'` | **同样遮罩**（截图实证） |
| 换行 | **CR/LF 保留**：多行字段仍是两条视觉行（每行 20 星），遮罩只换可见字符不换断行 |
| `.text` | 恒为**明文**（键入/程序化赋值都一样），`.text.length` 不变；实测键入后 `p1.text` 是插入后的明文 |
| 运行时切换 | 正常重排（`displayAsPassword` 可随时开关） |
| 字符计数口径 | AIR 按 **UTF-16 码元**（`中文ab` 密码 `textWidth` 28.5 ⇒ 4 颗星） |
| 剪贴板 | 遮罩字段 **`Cmd+C` / `Cmd+X` 均被拒**（剪贴板保持空、`Cmd+X` 连文本也不删）；对照的非遮罩字段同一手势复制出 `abcdefghij`；**`Cmd+A` 仍能选中**（SEL=0,3） |
| 程序化赋值 | `text = ...` 把**光标与选区钳到新长度**（实测：光标在 7 时赋 `"zz"`，读回 `caretIndex` **2**、`selectionBegin/End` **2,2**） |

**实现（`src/emit.ts`）**：

| 位置 | 改动 |
|---|---|
| `TextField` 结构体（`_para_align` 之后） | 新增 `char* _mask;` 与 `const char* _mask_src;`（ctor 置 NULL）——遮罩串是**独立的缓存**，`_mask_src` 记住它对应哪份 `.text` |
| 新增 `as_tf_layout_text(TextField*)`（在 `as_tf_paragraph` 之前） | 非密码直接返回 `tf->text`；已建且 `_mask_src == tf->text` 才复用；否则 `malloc(n+1)` **逐字节**写入（`\r`/`\n` 原样、其余一律 `'*'`），`free` 旧缓冲后替换并记住 `_mask_src` |
| `as_tf_paragraph` | 取 `const char* ltext = as_tf_layout_text(tf);`；`hasRuns = (tf->_runs != NULL && tf->_runs->length > 0 && !tf->displayAsPassword);`（**遮罩优先于 `htmlText` runs**）；缓存键改 `tf->_para_text == ltext`；`as_skia_textlayout_new_leading(ltext, ...)`；`tf->_para_text = ltext;` |
| `as_tf_copy_selection` / `as_tf_cut` | 各加 `if (tf->displayAsPassword) return;`（剪贴板拒绝；Cut 连文本也不删） |
| `TextField_set_text` | 追加**光标/选区钳位**（`_sel_caret`/`_sel_begin`/`_sel_end` 各与 `strlen(value)` 取小） |

**为什么是「一个字节一个 `*`」而不是「一个字符一个 `*`」**：本运行时的 `String` 是 **UTF-8 字节索引**模型（既有全局口径，见遗留行），若星号串按 UTF-16 码元生成，遮罩串的**字节区间**就与 `.text` 的索引体系对不上，光标/选区/`index_at` 全会错位。故选择与本运行时索引模型自洽：**每字节一颗星**。代价是 **CJK 密码会比 `adl` 多显星**（`中文ab`：adl 4 颗 / 我们 12 颗）——已作为同源偏差登记在「`String` 是 UTF-8 字节索引」行。

**顺带修复的两个真缺口（不新增遗留行）**：① **遮罩字段拒复制/剪切**（`adl` 实测是硬边界，不是我们的选择）；② **程序化 `text = ...` 把光标与选区钳到新长度**（`adl` 实测口径；修前我们的光标会停在越界位置，渲染器随后量出越界矩形）。

**验收**：新 `examples/stage94o.as`（A~F：默认值与往返、遮罩不改文本/长度、遮罩开关不改文本与行结构、赋值钳光标、与 `restrict` 正交、多行遮罩字段的行/光标一致性）纳入回归；`test.ts` `[textinput]` 新增 **6 条**钉子（`as_tf_layout_text` 形状、星号串逐字节 + CR/LF 保留、缓存键改 `ltext`、遮罩优先于 run 表、copy/cut 守卫、赋值钳位）；`node test.ts` **140 例全通**。

**度量耦合（同一遗留行，本阶段证据更刺眼）**：`_typewriter` 12 的**星号前进** adl **7.2 px**（等宽族）而我们 **4.67 px**（回落字体的星号更窄）⇒ 「点击 x=45 落在第几个字符」adl **6**、我们 **9**；`_sans` 12 的星号两侧却几乎一致（adl 46.5 / 我们 46.7 每十颗），说明差距**不是**遮罩算法而是**字体命中**。故窗口 AOT 下的遮罩**几何数值**会与 adl 不同，**语义**（一字符一星、参与排版、明文存储、剪贴板拒绝）逐条一致。

**双端核对（窗口 AOT，链接 Skia）**：`p1`（密码）`TW` 46.7、`p3`（明文对照）54.7、`p8`（密码 W×10）46.7、`p9`（明文 W×10）**113.26 ≈ adl 113**、`p10`（密码 i×10）46.7（与 `p8` 同值 ⇒ 星号串模型一致）；密码字段剪贴板为空、`p3` 复制出 `abcdefghij` ✓；`p6` `TW` 56.04 `LEN` 12（字节）vs adl 28.5 `LEN` 4（**按设计的字节偏差**）；`TH` 12 vs adl 15（既有字体度量缺口）。

**未实测项（已登记）**：带 **`htmlText` run 表**的字段再开遮罩没探过——当前实现让**遮罩优先**（run 表在遮罩生效时强制不参与排版），`adl` 侧未跑，故新登记为遗留行「`displayAsPassword` 与 `htmlText` 的组合未实测」。

---

#### 阶段九十四·十七：输入法合成中态（marked text）预览（v0.4.48 → v0.4.49）✅ 已完成

**触发**：遗留行的「输入法（**IME**）的合成中态（marked text）无建模」（阶段九十四·七 实测登记）。这是 ②「文本编辑补完包」的最后一个子项。

**证据台**：`temp/editprobe/src/Ed17.as`（f1 单行 / f2 多行）+ `drive_ed17.py`（**F1..F9** 命令通道，`VK` 表补 `f8/f9`）+ `ed17-app.xml`，`adl 51.4.1` 实测日志 `/tmp/ed17.txt` 与 `/tmp/d17b..e.txt`；窗口 AOT 侧 `temp/imeprobe/`（`src/Ime.as` + `ime-app.xml` + `ime.build.json` + `drive_ime.py` + `out/ime_aot`），截图 `snap_ime_{1..5}_*.png`，另有**确定性**离屏出图 `/tmp/ime_render_{0..5}.png`（探针每步调 `stage.render(400,140,path)`，不依赖窗口 expose 时序）。

**adl 实测口径（`IME` 静态面）**：

| 面 | 实测结论 |
|---|---|
| `IME.isSupported` / `enabled` / `conversionMode` | `true` / 初值 `true` 且可写（`false`→读回 `false`，写回 `true` 生效）/ `"UNKNOWN"` |
| `setCompositionString` / `doConversion` / `compositionSelectionChanged` | **一律抛 `Error #2063`**（`name="Error"`、`errorID=2063`、`message="Error #2063: Error attempting to execute IME command."`、`is TypeError == false`） |
| `compositionAbandoned()` | **不抛**（no-op） |
| `setConversionMode` | **不存在**：抛 `Error #1006`（`name="TypeError"`、`errorID=1006`、文案 `setConversionMode is not a function`） |
| `IMEConversionMode` | 只有 **8** 个常量（值 == 名字）：`ALPHANUMERIC_FULL`/`ALPHANUMERIC_HALF`/`CHINESE`/`JAPANESE_HIRAGANA`/`JAPANESE_KATAKANA_FULL`/`JAPANESE_KATAKANA_HALF`/`KOREAN`/`UNKNOWN`；已废弃的 `FULL_WIDTH`/`HALF_WIDTH`/`JAPANESE_KATAKANA`/`TO_FULL_WIDTH`/`TO_HALF_WIDTH`/`JAPANESE_KATAKANA_HIRAGANA` **读回 undefined** |
| mxmlc | **拒绝静态引用** `IME.setConversionMode` / `IMEConversionMode.TO_HALF_WIDTH` / `IME.addEventListener`（「可能未定义」）⇒ AS3 侧只能经**动态引用**触达 |

**本机硬边界（为什么合成期的 `.text` 口径只能「选择」而非「实测」）**：① `TISSelectInputSource(WeType)` 让 python 进程 **SIGTRAP（exit 133）**；② 输入源是**按应用（per-app）**的，TIS 只能改调用者自身，`adl` 拿不到；③ 菜单栏输入法菜单**未启用**（`Ctrl+Space` 旋转也无效）。故**无法把真实输入法接到 adl**，「合成期 AIR 的 `.text` 含不含合成串」**没有实测口径**，本阶段的选择与理由写在 `examples/stage94p.as` 头部并留了遗留行。

**实现口径（已言明为选择）**：合成串是**预览**不是文本 —— `.text`/`caretIndex`/选区/`numLines`/`textWidth` 一概不动、不派发 `change`；绘制层在**光标处**画合成串 + 1px 下划线；平台送**空** marked text = 合成结束（清除预览）；提交走既有 `textInput` 通路（先丢弃预览 → 正常插入，`restrict`/`change`/光标全部沿用已实测路径）；只有 `as_tf_is_input` 字段参与；候选窗矩形经 `SDL_SetTextInputRect` 跟随光标。

**实现（分四层）**：

| 层 | 改动 |
|---|---|
| `vendor/window_glue.cc` | `WinCtx` 增 `char edit_text[256]; int edit_start; int edit_len;`；`case SDL_TEXTEDITING:`（**在 `SDL_TEXTINPUT` 之前**）stash → `on_key(id, "textEditing", 0, 0, 0)` → `dirty=1`；新增 `int sk_window_text_edit_take(int id, char* buf, int cap, int* start, int* length)`（一次性 drain，空串有意义）；新增 `void sk_window_set_text_input_rect(int id, double x, double y, double w, double h)`（→ `SDL_SetTextInputRect`） |
| `vendor/skia_glue.cc` | 新增 `int sk_textlayout_caret_rect(void* para, int index, double* x, double* y, double* h)`（`getRectsForRange(i, i+1, kTight, kTight)`；空则回退 `(i-1, i)` 取 right 边）。**坑**：`RectWidthStyle` 只有 `kTight` |
| `src/runtime.ts` | extern + `static inline` wrapper + headless stub 三件套（`sk_window_text_edit_take` / `sk_window_set_text_input_rect` / `sk_textlayout_caret_rect`，wrapper 名 `as_skia_textlayout_caret_rect`） |
| `src/emit.ts` | `TextField` 增 `char* _comp; int _comp_start; int _comp_len;`；`as_tf_set_comp(tf, text, start, length)`（malloc 字节串，定义在 `Stage_dispatchText` 之前）；`Stage_dispatchTextEditing(void* _this, char* text, int start, int length)`（取 `as_focus_obj` + `as_tf_is_input` 守卫、存合成、复刻渲染坐标算 ROI 写 `ASC_ime_roi`）；`Stage_dispatchText` 在 `as_tf_insert_text` **之前**插 `as_tf_set_comp(tf, NULL, -1, 0);`；渲染分支画合成串 + 下划线；`ASC_window_on_key` 增 `"textEditing"` 分支（drain → dispatch → 有 ROI 则 `sk_window_set_text_input_rect`，用 `on_mouse` 变换的逆向） |
| `src/symbols.ts` | `Stage.methods` 增非标准测试钩子 `['dispatchTextEditing', { returnType: void, params: [text:String, start:int = -1, length:int = 0] }]` |

**实施中顺带修掉的两个真缺口（不新增遗留行，两者都是「渲染指纹漏项」/「索引域错位」族）**：

1. **合成串不在渲染缓存键里** ⇒ 预览**根本不出现**。`as_render_object` 走 `as_render_fingerprint(o)` 自动烘焙缓存：合成串既不进指纹，字段的 `text`/caret/选区又都没动，于是每次都**重放旧图**。实测症状极隐蔽（`temp/imeprobe`：`"ab"` 后合成 `"nihao"` 可见，但在 `"ab你好"` 之后合成 `"shu"` 完全不可见——因为第二次合成前光标/选区/文本恰好都没变）。修法：给指纹加 `h = as_fp_str(h, tf->_comp);`（**内容敏感**哈希：合成缓冲每次 `free`+`malloc`，同长度替换常拿到同一地址，指针哈希不够），并同批补上 **`_sel_caret`**（预览 x 位置）与 **`displayAsPassword`**（遮罩串）——两者同理：改了绘制结果却没进指纹。
2. **Skia 段落索引是 UTF-16 码元，本运行时的文本索引是 UTF-8 字节** ⇒ CJK 文本上的 Skia 区间查询全部落空。`as_skia_textlayout_caret_rect(para, 8, ...)`（caret 的**字节**位置）在 `"ab你好"`（段落长 **4**）上超界，返回 0 ⇒ 预览被整段跳过。修法：新增 `static int as_tf_utf16_index(TextField* tf, int byteIndex)`（按 UTF-8 前缀数码元：1 字节 1 码元、2/3 字节 1 码元、4 字节 2 码元；遮罩串一字节一星故恒等），并把渲染侧的**光标矩形**与**选区矩形**（高亮 + 黑字两处）都改为先换算再查。

**验收**：新 `examples/stage94p.as`（A~F：合成是预览——不动 `.text`/caret/选区/`numLines`/`textWidth` 且不派 `change`；长合成串不改行结构；提交恰好一次 change 且光标落 7（**字节索引**口径）；取消合成 no-op；无焦点/动态字段 no-op；`restrict` 只管提交且被拒提交**消费选区**；焦点搬家不把预览变成文本）纳入回归；`test.ts` `[textinput]` 新增 **22 条**钉子（glue 的 `SDL_TEXTEDITING` 顺序与缓冲、两个新 glue 入口与 SDL 转发、`sk_textlayout_caret_rect` 与回退、runtime 三件套、`TextField._comp` 三字段、`as_tf_set_comp` 的复制/清空语义、`Stage_dispatchTextEditing` 的守卫与「只存不 splice」、提交前清合成且顺序正确、`"textEditing"` 桥接分支与 ROI 变换、渲染预览块含下划线、指纹两项、UTF-16 换算）；`node test.ts` **141 例全通**。

**窗口 AOT 视觉核对（链接 Skia + Metal）**：`snap_ime_1_compose_nihao.png`（`abnihao` + 下划线）、`snap_ime_2_committed.png`（`ab你好` 无下划线）、`snap_ime_3_compose_shu.png`（`ab你好shu` + 下划线 —— 这一张正是上面两个真缺口的判据）、`snap_ime_4_cancelled.png`（无残留下划线）、`snap_ime_5_f2_compose_wo.png`（`cdwo` + 下划线）；`/tmp/ime.txt` 同时证明 AS3 可见态逐帧不变（`t1/t3/t4` 的 `text`/`caret`/`tw` 均不动）。

**未实现（已登记遗留行）**：`flash.system.IME` / `IMEConversionMode` 类（实测为「`setCompositionString` 恒抛 `#2063`、`setConversionMode` 不存在、8 个常量」⇒ 价值低，本阶段只把实测口径记进本文件）；`IMEEvent` 事件族（mxmlc 禁止 `IME.addEventListener` 静态引用，TextField 路径上唯一可观测的只有提交时的 `TEXT_INPUT`）；web 目标 `compositionstart/update` 未接。

---

#### 阶段九十四·十八：字符串字面量的转义序列解码（v0.4.49 → v0.4.50）✅ 已完成

**触发**：阶段九十四·十七 的 IME 探针顺带发现 `"\u4f60\u597d"` 被当成字面 `u4f60u597d` 塞进字符串（词法器只认识 `\n \t \r \\ \" \'`，其余一律「保留字符本身」）。属 ⑤「语言语义包」的第一个子项：**编译期语义错误**，比功能缺失更致命（AGENTS.md §0）。

**证据台**：`temp/escprobe/`（`Esc.as` + `esc-app.xml`，日志 `/tmp/esc_out.txt`；`Raw.as` 为裸换行用例）。

**adl 51.4.1 实测口径**：

| 面 | 实测结论 |
|---|---|
| `"\u4f60\u597d"` | `length` = **2**（UTF-16 码元）、`charCodeAt(0)` = **0x4F60**、`charCodeAt(1)` = **0x597D** ⇒ `\uXXXX` **必须解码**（非法 hex 是编译错误） |
| `"\x41\x7a"` | = `"Az"`（65 / 122）⇒ `\xXX` 恰好**两位**十六进制 |
| `"\b\f\v"` | 码元 **8 / 12 / 11** ⇒ 三个都是**单码元**转义 |
| `"\q\z\8"` | = `"qz8"` ⇒ 未知转义**丢掉反斜杠、保留字符本身** |
| `"a\<LF>b"` | `length` = **2** = `"ab"` ⇒ `\` + 换行是**续行**（不产生字符） |
| `"p\0q"` | `length` = **3**、码元 112 / **48** / 113 ⇒ `\0` 是**字符 `'0'`**，**不是** NUL（AS3 弃用了 ES3 的八进制/NUL 转义） |
| `"\ud83d\ude00"` | `length` = **2** ⇒ 代理对由两个 `\u` 拼出 |
| 裸换行 | mxmlc **拒绝**字符串里的裸换行（`Raw.as`：「语法错误: 此处应该有一个"分号"或一个"新行"」） |

**实现（`src/lexer.ts` 的字符串 `switch (esc)`）**：新增 `'b'`/`'f'`/`'v'`（8/12/11）；新增 `'u'`（读 **4** 个 hex，非法抛 `LexError('invalid \u escape sequence')`）、`'x'`（**2** 个 hex，非法抛 `LexError('invalid \x escape sequence')`）；新增续行 `case '\n'`（吞掉）与 `case '\r'`（后随 `\n` 则一并吞）；**删除 `case '0'`**（回落 `default` 保留 `'0'`）；字符串读取循环开头加 `if (source[i] === '\n' || source[i] === '\r') throw new LexError('unterminated string literal (line terminator in string)', startLine, startCol);`。解码**在词法器里做完**——生成 C 时字面量只含最终字节，C 编译器看不到任何 `\u`（这正是与 C 的区别所在：C 的 `"\u0000"` 会截断字符串、`"\0"` 是 NUL，二者都与 AS3 相反）。

**验收**：新 `examples/stage94q.as`（A~I：`\uXXXX` 与源里等价 UTF-8 字面量逐字节相等、代理对、`\xXX` 大小写、`\b\f\v` 码元、未知转义、`\0` 是 `'0'`、混排、`\t\n\r\\\"\'` 回归、续行 `\n`/`\r\n`，以及**内嵌 NUL 截断的既定偏差**）纳入回归；`test.ts` `[lexer]` 新增 **12 条**钉子（含 4 条抛错用例：`\u12` / `\u12g4` / `\x4` / 裸换行）；`node test.ts` **142 例全通**（全量回归同时确认裸换行拒绝不会打挂既有示例）。

**已知偏差（已登记遗留行）**：`"\u0000"` 解码出的是真正的 NUL 字节，但本运行时的字符串是 **C 串**（遇 NUL 即止），故 `"a\u0000b".length` 这里是 **1**、AIR 是 **3**。示例把可观测的那一面钉住并写明这是**既定偏差**。

---

#### 阶段九十四·十九：相机 RAW / DNG 解码（E4）—— 实测完成，零代码（v0.4.50 → v0.4.51）✅ 已完成

> **后续（阶段九十四·二十五）**：本轮实测的「默认即解出」已按 §1.5 改为**默认拒绝 + `--features raw`**——此处保留当时的原始记录。

**触发**：`### 增强待做` 的 E4「相机 RAW / DNG 解码」。立项时的判断是「native 侧 `libpiex.a`+`libdng_sdk.a`
已构建，缺的是新解码通道」；**实测推翻了「缺通道」这一前提**——通道早就通了。

**证据台**：`temp/codec-probe/`（沿用 E1/E3 的同一台）
- `RawAdl.as` + `raw-adl-app.xml` + `raw-adl.swf`：**AIR 基线**（`mxmlc` 编译、`adl 51.4.1` 跑，输出 `/tmp/raw_adl.txt`）。
  加载是异步的，故步骤用 `setTimeout` 串联（busy-wait 会卡住帧循环、完成事件永不派发）。
- `raw-probe.as` + `codec-raw.build.json`（= 默认清单 + `ASC_USE_RAW=1`，仅作对照）：**我们侧**，四条入口 + 反向对照。
- `img/sample_1mp.dng`（87 KB）、`img/dng_with_preview.dng`（138 KB）：取自本机 Skia 源码树的
  `build-tools/skia-src/resources/images/`（现成样本，不必自造 DNG）。

**AIR 实测（`adl 51.4.1`，权威判据 §1.5）**：

| 入口 | AIR |
|---|---|
| `Loader.load(new URLRequest("file://…/sample_1mp.dng"))` | `ioError #2124 Error #2124: Loaded file is an unknown type.` |
| `Loader.loadBytes(ByteArray)` | `ioError #2124` |
| `BitmapData.loadFile(...)` | **方法不存在**：`#1069 Property loadFile not found on flash.display.BitmapData and there is no default value.`（静态引用连 mxmlc 都过不了：「可能未定义」；探针用动态访问触达） |
| `t.png`（对照） | `ok 37×23 tl=ff0000` |

**我们侧实测（native，**默认清单**、不带任何 `--features`）**：

| 入口 | native 默认构建 | web |
|---|---|---|
| `Loader.load` | **`ok 600×338`** | 与 AIR 同报 `#2124` |
| `Loader.loadBytes` | **`ok 600×338`** | — |
| `BitmapData.loadFile`（我们自己的 String 通道） | **`ok 600×338`** | — |
| `dng_with_preview.dng`（`Loader.load` / `loadFile`） | **`ok 600×338`** | — |
| `BitmapData.draw` 到目标位图（第 4 条入口） | `ok 600×338` | — |
| `t.png`（反向对照：RAW 通道**不截胡**既有 codec） | `ok 37×23 tl=ff0000` | `ok` |
| `t.svg`（非 RAW，仍按既有规则） | `ioError #2124` | `ioError #2124` |

**为什么零代码（根因）**：RAW 在 Skia 里是 `SkRawDecoder`（`include/codec/SkRawDecoder.h`），由
`skia_use_dng_sdk`+`skia_use_piex` 打开；本机 native Skia 正是这么编的，且它在 Skia 的**默认编解码器表**里
（`SkRawDecoder::IsRaw` 恒真、头文件注明「always checked last」）⇒ 既有的
`SkImages::DeferredFromEncodedData` 通道**本来就会**把 DNG 交给它。符号证据：
`nm -gU vendor/skia/lib/macos-arm64/libskia.a | grep SkRawDecoder` → `Decode(sk_sp<SkData>…)` /
`Decode(unique_ptr<SkStream>…)` / `IsRaw` 三个符号在；`libpiex.a`/`libdng_sdk.a` 早已在链接表里。

**web 侧是天然的诚实缺口（不静默降级，§1.2c）**：`nm -g vendor/skia/lib/wasm/libskia.a | grep -c SkRawDecoder`
= **0**，且 `vendor/skia/lib/wasm/` 里没有 `libpiex.a`/`libdng_sdk.a`（wasm 的 `args.gn` 没开这两个开关）
⇒ web 构建对 DNG 与 AIR **逐字相同**地报 `#2124`。要支持须改 `args.gn` 并重编 wasm Skia，属独立工程。

**未实测（按 §1.5 记为「未验证」而非「已支持」）**：只验了 **DNG**。`.cr2`/`.nef`/`.arw` 等其它 RAW 家族
走同一条 piex 通道，但本机**没有样本**；`SkRawDecoder::IsRaw` 恒真意味着「非 RAW 的其它文件」在这个回退上
只会多花一次解析尝试（对 `t.png`/`t.svg` 的实测已确认不会误判成功）。

**验收**：无需改一行源码（故此阶段没有 `examples/` 单元——与 E1/E3 同理，它需要 Skia 链接）；证据落在
`temp/codec-probe/`（`RawAdl.as` AIR 基线 + `raw-probe.as` 我们侧 + `codec-raw.build.json`），
`docs/zh-cn/enhancements.md` §4.5 与 §3 的 E4 行同步登记为**已完成**。`node test.ts` **142 例全通**（无源码改动）。

**待你裁决（与 E3 同一条，未擅自选择）**：默认构建**就是 AIR 的超集**——对 AIR 会拒绝（`#2124`）的输入我们
直接解出来。两条路：(a) 保持现状（只增不减，对 AIR 上能跑的程序零影响）并写进文档；(b) 默认拒绝、加显式
开关才放行（严格同构，但要主动写代码**降低**能力）。已在 `docs/zh-cn/enhancements.md` §4.3 末尾与 §4.5 末尾
**如实记为待定**。

> **裁决结果（2026-10-04）**：用户选定 **(b) 默认拒绝 + 显式开关**。E3（WebP/BMP/ICO）与 E4（RAW/DNG）
> 须改为「默认与 AIR 逐字同形（报 `#2124`），`--features` 具名开关才放行」，实现见后续阶段节。

---

#### 阶段九十四·二十：字体度量对齐 AIR（④-A）（v0.4.51 → v0.4.52）✅ 已完成

**背景**：`TextField` 的 `textWidth`/`textHeight`/`numLines`/光标几何**全部**由 SkParagraph 的布局导出，
所以「命中哪个字面」与「行盒多高」两件事决定了**所有**排版数值。遗留表里那条「字体度量偏小（行距 12 vs 15、
字符前进 5.3 vs 6.6）」自阶段八十九·七十七 起一直挂着，期间被阶段九十四·七/八/十五/十六 反复追加同源证据
（点击落点、拖选字符数、`displayAsPassword` 星号宽度、`PageUp` 步长与 `scrollV`）——而它**每次都只被记录、
从未被修复**。本阶段把它结案。

**证据台 `temp/metricprobe/`**（同一份输入矩阵，两侧各跑一遍，输出可直接 diff）：

| 文件 | 端 | 覆盖 |
|---|---|---|
| `Metric.as` / `MetricAot.as` | `adl` / 我们（AOT + Skia） | 12 个字面族 × {10×`W`、10×`i`、10×`*`、10×`0`、10×空格、`abcde`} + 单行/两行 + password + leading 矩阵 |
| `Metrics2.as` | `adl` | `getLineMetrics(0)`：ascent/descent/leading 的**半像素取整**证据（12 px 与 20 px） |
| `Metrics3.as` | `adl` | 7 族 × 9 档字号（8…32）→ 通用别名行高的**非线性**证据 |
| `Metrics4.as` / `Metrics5.as` | `adl` | `TextFormat.leading` 的 **px 语义** + 尾行怪癖（1..4 行 × leading 0/2/4/10/−3） |
| `adl_metric.txt` / `aot_metric.txt` | — | 两侧原始输出 |

**根因（实测确认，不是推测）**：`_sans`/`_serif`/`_typewriter` **不是字体族名**，是 Flash 运行时要自己解析的
通用别名；CoreText 不认识 `_typewriter`，原样透传给 SkParagraph 会**静默回落到系统默认比例字体**。于是
`_typewriter` 12 px 量出 10×`W` = **113.26 px**（等宽体被渲染成比例体，字宽差 40%）、星号 **4.67 px**、行高
**12 px**，而 `adl` 分别是 **72 / 7.2 / 15**。这解释了全部既有症状（星号变窄、软换行点更早、`visible` 行数更多）。

**实现（四层，全在 Skia 侧，纯 C 构建不受影响）**：

| 层 | 内容 |
|---|---|
| 别名字面 | `sk_family_alias()`：`_typewriter`→`Monaco`、`_sans`→`Helvetica`、`_serif`→`Times New Roman`、空/`null`→`Times`（AIR 把空族读回 `"Times Roman"`，其行高 12 与 Times 逐值一致）；具名字体原样透传。**五条** `setFontFamilies` 通路（平铺段、带 leading 的段、多 run 段的 style 与 strut）全部走它，不留未翻译透传 |
| 字面查找 | `sk_match_typeface()` 按 `(family, bold, italic)` 缓存 `matchFamilyStyle`（CoreText 族表扫描很贵，不能每段重跑） |
| 行盒模型 | `sk_round_half()` + `SkAirLineMetrics`：`h = round_half(ascent) + round_half(descent) + leading`（**丢弃字体自带 line gap**；`leading` 以 **px** 计）；经 `sk_set_air_strut()` 装 height-override strut 强制之。**两个反直觉点**：①Skia 的因子分母含 line gap 而盒子里不含 ⇒ 高度须**预乘 `rawFull/rawSum`**（漏乘时 Monaco 12 px 精确地短 1.002 px，报 14）；②Skia 把 `StrutStyle::leading < 0` **钳成 0** ⇒ 负 leading 必须折进 height |
| 字段高 | `TextField_get_textHeight`：AIR 的多行字段**不计尾行 leading**（实测 leading=4、步长 19 时 1..4 行 = 19/34/53/72）⇒ `nl ≥ 2` 时减一次 `leading` |

**验收（逐值，全部对 `adl 51.4.1` 12 px）**：

- 别名字面：`_typewriter` 10×`W`/`i`/`*`/空格 = **72**（= adl 72）、行高 **15**（= adl 15）、密码星号前进 **7.2**（= adl 7.2）——**遗留行里的两个数字（12/15、5.3/6.6）同时消失**。
- 12 个字面族：字宽**全部逐值相同**（`113.26` vs `113`、`72.01` vs `72` 这类 <0.3 px 的浮点噪声）；行高 **8 族逐值相同**（`Courier` 12、`Menlo` 14、`Monaco` 15、`Helvetica` 12、`Times`/`Times New Roman` 12/13、`Geneva` 15、`_typewriter` 15），2 族残差 0.5 px（`Courier New` 14 vs 13.5、`Arial` 13 vs 13.5）。
- leading 矩阵：`_typewriter` 12 px × leading {0, 4, −3} × 1..4 行 = **12 个数值逐值相同**（15/30/45/60、19/34/53/72、12/27/39/51）。
- `test.ts` `[fontmetrics]` **8 条**结构钉子（含 4 条反向：无未翻译透传、旧 `setLeading(leading)` 的 em 尺度错误不得复活、三条 paragraph 通路都得装 strut、尾行修正必须在场），`node test.ts` **142 例全通**。
- 模型写入 `docs/zh-cn/skia.md` §8，证据台 `temp/metricprobe/README.md`。

**未对齐（登记遗留 2 行，本阶段不再深挖）**：`_sans`/`_serif` 的**行高**（AIR 用自有**非线性**设备字体表：9 档字号实测值已留存，`_typewriter` 在 14 px 起也与 Monaco 分道 ⇒ 无解析字面可复现；我们**不做**插值硬编码表）；`Courier New`/`Arial` 的 0.5 px 残差（Skia 内部半像素取整方向）；`TextField.getLineMetrics()` 未实现（AIR 有，本轮 adl 侧数值全靠它取）—— **此条已于阶段一百零三 / v0.4.76 落地**。

**为什么没有 `examples/` 单元**：度量面需要 Skia 链接，而 headless 示例套件是**纯 C 模式**（无 Skia），
同 E1/E3/E4 的处理；故以**证据台双向输出 + 结构钉子**替代（这两者都是可复跑、可回归的）。

---

#### 阶段九十四·二十一：TextField 边框是屏幕空间 1px 线（④-C）（v0.4.52 → v0.4.53）✅ 已完成

**背景**：遗留表里这条（阶段九十四·八 登记）已经挂了一轮，且当时就写明「**需要先实测 adl 在非等比
缩放下是「仍为各自轴上的 1 物理 px」还是「按其中一个轴」**」——本阶段把该矩阵补齐后一次修掉。

**实测（`temp/editprobe/src/Ed7.as`，五个边框字段 + `drive_ed7.py` 窗口像素扫描）**：

| 字段 | 缩放 | adl 包围盒 | adl 每边线宽 |
|---|---|---|---|
| 100x30，绿 | 1 | 101x31 | **1 px**（`xruns=[0-0,100-100]`、`yruns=[0-0,30-30]`） |
| 60x20，品红 | `scaleX=scaleY=2` | 121x41 | **1 px**（`[0-0,120-120]`） |
| 60x20，青 | `scaleX=2, scaleY=1` | 121x21 | **1 px**，**两个轴各自** 1 px |
| 60x20，橙 | `scale=0.5` | — | 1 px（颜色被抗锯齿轻微混合成 `FF8200`，故精确色查询需放宽） |

⇒ AIR 的边框是**屏幕空间的 1 px 线**：不随对象缩放，且**按轴**各自保持 1 px（不是按单一因子）。

**修法（三处，全部在渲染侧）**：

| 处 | 内容 |
|---|---|
| 胶水层 | 新增 `sk_canvas_total_scale(canvas, &sx, &sy)`：返回**当前变换**的每轴缩放（列范数 `sqrt(a²+b²)`、`sqrt(c²+d²)`，故带旋转时给的是旋转后每轴的尺度，而不是矩阵原始项） |
| 生成侧（线宽） | `厚度(局部) = ASC_render_scale / 画布总缩放`；`ASC_render_scale` 是本次渲染的物理像素比 ⇒ 结果是 **1 逻辑 px**（`scale=1`、`dpr=1` 时恰好等于旧的 `1.0` 局部单位，故 1× 显示器的观感与旧行为逐像素相同）；四条边各自用 `btx`/`bty`（按轴） |
| 生成侧（烘焙） | 自动烘焙/`cacheAsBitmap` 的内容是在**离屏面**里重画的，那个画布缩放是烘焙分辨率、回贴时又叠加对象自身缩放 ⇒ 烘焙通道把**目标**画布总缩放发布到 `ASC_bake_ctm_*`（save/restore 支持嵌套烘焙），边框据此度量 |

**验证（Retina 窗口 880x464 = 2× 物理）**：同一二进制三个状态，看 `scale=2` 字段每边线宽 ——
修前 **4 物理 px**；只改线宽公式仍 **4**（烘焙回贴放大）；线宽公式 + 烘焙发布目标缩放后 **2 物理 px**，
与 `scale=1` 字段**逐像素同宽** ✓。非等比（`scaleX=2, scaleY=1`）与 `scale=0.5` 也都是 2 物理 px ✓。
「1 逻辑 px」在 adl 的 1× 捕获里是 1 物理 px、在我们 Retina 里是 2 物理 px —— 这是 **DPI 差异**而非口径
差异（adl 的窗口被系统放大到 2× 显示时，屏幕上同样是 2 物理 px）。

**被这次实测牵出来的连带缺陷（本阶段只绕开、未修，已登记遗留行）**：烘焙面按 `dpr` 而非**目标画布
总缩放**分配 ⇒ `scale != 1` 的缓存对象回贴时被放大，内容按 `scale` 倍点采样（字边锯齿）。判据链很干净：
`scale=2` 的字段线宽 4 px，把自动烘焙关掉（`ASC_AUTO_BAKE_FRAMES` 调大）立刻变 2 px ⇒ 多出的 2 px
来自烘焙分辨率而不是线宽公式。没顺手修的原因：改烘焙分辨率会让烘焙面随缩放**平方**增长，属内存/清晰度
取舍（需先定上限），不该在「边框线宽」这一项里悄悄决定。

**验收**：`examples/stage94r.as`（纯 C 回归 —— 像素级不变式只能在窗口里观测，故本示例钉住本次改动
**不得破坏**的那半边：边框与缩放都不得污染 `width`/`height`（它们是**变换后**的包围盒）、非等比缩放的
`localToGlobal`/`globalToLocal`/`hitTestPoint` 逐轴正确、`borderColor` 写入仍丢 alpha）；`test.ts`
`[border1px]` **3 条**结构钉子（胶水接口在场、四条边的 `1.0` 固定厚度不得复活、烘焙必须发布目标缩放）；
`node test.ts` **143 例全通**；双端截图 `temp/editprobe/snap_ed7_{adl,aot_before,aot_after}.png`。

---

#### 阶段九十四·二十二：`hitTestPoint(x, y, shapeFlag)` 的内容区域判定（④-D）（v0.4.53 → v0.4.54）✅ 已完成

**背景**：遗留行「`hitTestPoint(x,y,true)` 的像素级精确命中未实现」的**前提需要一个更正**。原行按
阶段九十四·九 的圆探针写成「`shapeFlag=true` 是**像素级**命中」，但本轮把命中矩阵补全后发现：
`adl` 的 `shapeFlag=true` **不是**逐像素 alpha 测试 —— 全透明的 `BitmapData` 在它自己的矩形内
**照样命中**、矩形内的透明像素**也命中**；`TextField` 则完全**忽略** `shapeFlag`。它真正的语义是
**「画出来的内容区域」**（矢量填充 ∪ 描边带、位图/文本字段的矩形、子对象区域的并集）。

**实测（证据台 `temp/editprobe/app8..app10`：Ed18–Ed26 + `hit25_adl.txt`）**：

| 情形 | `shapeFlag=false`（box） | `shapeFlag=true`（region） |
|---|---|---|
| 矢量填充 10..30 + 8px 描边（描边 6..34） | **含**描边：x≥5.75 命中 | **含**描边：x≥6.0 命中（严格边界） |
| 只有描边的线（10px，默认圆头） | 描边外框 | 描边带：垂直 4.5px 命中 / 5.5px 不中；**端点外 2px 仍命中**（圆头） |
| 一次 fill + 同向嵌套子路径 | 外框 | **内层是洞**（even-odd） |
| 两个独立 fill 组嵌套 | 外框 | **都填充** |
| 全透明位图 | 位图矩形 | **位图矩形**（不采样 alpha） |
| `TextField`（有/无文本/有无边框） | 字段矩形 | **字段矩形**（忽略 `shapeFlag`） |
| `Sprite` + 两个位图子对象（中间有缝） | 整块外框（缝也命中） | 子对象各自命中、**缝不命中** |
| `visible=false` / `mouseEnabled=false` / `mouseChildren=false` | **仍命中** | **仍命中** |
| 空 `Sprite` | 不命中 | 不命中 |

**实现（三处）**：

| 处 | 内容 |
|---|---|
| 胶水层 | 新增 `sk_path_contains`（按路径**自己的**填充规则判点）、`sk_path_stroke_contains`（用 `SkStrokeRec::applyToPath` 生成描边轮廓再 `contains`，圆头圆角 = `lineStyle` 默认）、`sk_path_set_even_odd` |
| 生成侧（判定） | `as_obj_region_hit_local`：自己的 Graphics（填充 ∪ 描边带）→ 位图/`TextField` 的矩形 → 容器**递归**子对象（点逐级换到子对象的局部空间）；`DisplayObject_hitTestPoint` 按 `shapeFlag` 分派 |
| 生成侧（外框 + 渲染规则） | `as_obj_hit_local` 的 `as_bounds_walk(o, 1, …)` = **含描边**（顺带修掉「仅有描边的 `Shape` 点不到」）；`Graphics_ctor` 统一把路径设为 **even-odd**，使**画出来的区域**与**命中区域**是同一份几何 |

**判据链（为什么敢把填充规则改成 even-odd）**：命中区必须与画出来的区域一致，而 `adl` 侧两者
**同时**给出「同向嵌套子路径 = 洞」：命中探针 Ed21 §E 说内层不命中，窗口像素探针 Ed26 说内层中心
是 `FFFFFF`（背景色，即没画）⇒ 一个独立于命中测试的**像素级**证据，故渲染也按 even-odd。

**双端验收（`hit25_adl.txt` vs `hit25_aot.txt`）**：**42 行逐行对照，40 行逐字相同**。差异仅 2 行，
都在边界那 0.25px 的抗锯齿模糊带里（`x=5.75` 描边外缘外、`x=34` 正落在描边外缘），且 `adl` 自己的
右边界在三组位图探针里也不自洽（Ed21 §A1 与 Ed23 §A 对同一几何给出不同结果）⇒ 这是**光栅化**的产物
而不是可抄的规则，按严格几何实现并登记遗留行。

**为什么 `examples/` 单元只能钉住一部分**：headless 套件无 Skia，矢量几何不保留（`path` 为 NULL），
矢量 region 退化成含描边外框。因此 `examples/stage94s.as` 钉的是**不依赖 Skia 的那三类** ——
容器的缝（`false` 命中 / `true` 不命中）、位图矩形（全透明也命中、透明象限也命中）、`TextField`
忽略 flag，外加递归/镜像/空对象/`visible`·`mouseEnabled`·`mouseChildren` 不影响 —— 共 5 组 20 条断言；
**矢量逐行对照在证据台**（`hit25_{adl,aot}.txt`），并由 `test.ts` `[hitshape]` **6 条**结构钉子守住
「不采样 alpha、容器递归、含描边外框、按 flag 分派、even-odd」。

---

#### 阶段九十四·二十三：渲染颜色的四个环节逐一测量（④-B）（v0.4.54 → v0.4.55）✅ 已完成

**背景（含一处旧结论的更正）**：阶段八十九·七十七 把「非灰颜色偏移」记成「本管线把 sRGB
转换到显示器 P3」。本轮按 §1.5 把**四个可比环节**拆开各测一遍，结论反转：偏移在**捕获**段，
我们的渲染与提交都是逐位精确的。

| 环节 | 测法 | 结果 |
|---|---|---|
| ① 我们的光栅 | `BitmapData.draw(TextField)`（glue 新建**离屏**面 → 画 → `as_skia_surface_read_argb` 读回；无窗口/无合成器） | `00FF00`→`ff00`、`FF8000`→`ff8000`、`0000FF`→`ff`、`FF00FF`→`ff00ff` **逐位精确** |
| ② 提交前的 drawable | 新增 `ASC_MTL_READBACK=<x>,<y>[,<n>]`：`sk_mtl_flush` 里对本窗口 drawable `readPixels` | 物理 (40,40) 连续 3 px = `ff00ff00` **逐位精确** |
| ③ 我们的窗口捕获 | `screencapture -l` + `probe26b.py`，Metal 与 **CPU** 两个后端各一次 | `00FF00→03FF00`、`00FFFF→03FFFF`、`FF8000→FF8002`、蓝/品红精确；**两个后端逐值完全相同** |
| ④ `adl` 的窗口捕获 | 同一份 `.as` 经 `mxmlc` + `adl` | 绿/青/蓝/品红精确，**`FF8000→FF7700`（−9 LSB）** |

**结论**：偏移由 `screencapture` 这条通路（窗口服务器 → 显示色彩管理 → PNG）引入，两端共有、
程度不同；它不是我们的渲染缺陷（①②精确、③两后端一致）。**由此定下两条工具口径**：

- 逐位比较**颜色**必须走①②（离屏 / drawable 读回）；
- 逐位比较**几何**（边框、命中区、光标矩形）仍可用 `screencapture`，但要带容差
  （`grabwin.py` 的 `GRAB_TOL`，本管线的固有偏移 ≤ `adl` 的水平）。

**实现（两处，都不改渲染语义）**：`metal_glue.mm` 的 `sk_mtl_init` 给 `CAMetalLayer` 显式
声明 **sRGB**（`kCGColorSpaceSRGB`）——这是「我们绘制的值就是 sRGB 编码」的正确声明（不声明时
系统按显示原生空间解释，广色域屏上会过饱和）；并新增 `ASC_MTL_READBACK` 读回钩子（env 门控，
默认零成本），它是②的判据、也是以后任何「提交值是否正确」问题的现成工具。

**不可观测性（如实记明）**：sRGB 声明对**截图数值**没有影响（去掉前后逐位相同，`snap_ed26_notag.png`），
故它的依据是语义正确性而非实测差异；广色域屏上**肉眼**是否与 AIR 一致，截图测不出来，登记为遗留行
（需系统取色器/色度计）。

**验收**：`test.ts` `[colormanage]` 结构钉子（胶水声明 sRGB、读回钩子在 flush 里且 env 门控、
`no-Skia`/非 Metal 构建不受影响）；证据台 `temp/editprobe/app10/`（`Ed26.as` 同一份源码跑
adl/AOT、Metal/CPU 四组）+ `ed26_captures.txt`（四张表）、`offscreen_cpu.txt`、`mtl_readback.txt`、
`snap_ed26_{adl,aot,cpu,notag}.png`；`temp/xformcmp/README.md` §2 旧结论已更正。

**踩坑（写进证据台）**：探针**不要**在 `ENTER_FRAME` 回调里做重活 —— 本阶段第一版探针在那里调
`stage.render` 导致 `Stage_dispatchFrame` → `as_function_vt` 跳野指针而 **SIGBUS**（崩溃报告
`~/Library/Logs/DiagnosticReports/ed26_aot-*.ips` 的触发帧即它）；窗口 app 也别用 `trace` 汇报
（被 `pkill` 打断时 stdout 缓冲会丢），用 `FileStream` 落盘。

---

#### 阶段九十四·二十四：64 位整数 `int64` / `uint64`（E9，增强项）（v0.4.55 → v0.4.56）✅ 已完成

**为什么是增强不是遗留**：判据照 AGENTS.md §1.5——同一份输入 `adl` **能不能跑对**。`adl 51.4.1`
对 `var x:int64` 连编译都过不去（`mxmlc` 报未知类型），所以「用 64 位类型的源码」不可能是 AIR 合法程序 ⇒
接受这两个类型名**不可能**改写任何 AIR 已定义行为；opt-in 就是「你得写出来」——不写就与从前逐字节同构。

**做了什么（全部为 new 代码，不改任何既有语义）**：

| 层 | 改动 |
|---|---|
| 词法 | 数值字面量后缀：`123L` → int64、`123UL`/`123LU` → uint64（`Token.width`），**数字原文保留**在 `value` 里 |
| 语法/AST | `ASType` 增 `int64`/`uint64`；`Num` 节点增 `width?`/`raw?` |
| 语义/类型 | `CType` 增两 kind；`resolveType`、`ctypeToString`、`cTypeName`（`int64_t`/`uint64_t`）、`defaultInit`、`propTypeTag`（自用 tag 8/9） |
| 表达式 | `emitBinary64`（算术/位运算/移位/比较全族）、`common64`、`to64Expr`；`boxExpr`/`unboxAny`/`toStringExpr`/`toNumberExpr`/`toInt32Expr`/`toUint32Expr`/`condExpr`/`unifyType`/`emitTrace`/`emitTypeof`/`emitAs`/`scalarIsCompatible`/`runtimeScalarIs`/`convert` 全族补位；`int64()`/`uint64()` 两个转换函数；`~` 保 64 位 |
| 运行时 | `as_value` 的 **anonymous union**（`ptr` 槽复用为 `i64`/`u64`，**零尺寸开销**）；tag 8/9 与 `as_v_i64`/`as_v_u64`；四个值助手（`typeof`→`"number"`、truthy、eq/seq、str_val）全部补位；`as_num_to_i64/u64`（NaN/Inf 守卫）、`as_str_to_i64/u64`（strtoll/strtoull + errno）、`as_i64_to_str`/`as_u64_to_str`（**自带定点十进制**，不依赖 `%lld`）、`as_i64_rem`/`as_u64_rem`（零除数给 0）、`as_cmp_i64u64`（跨符号族数学比较）；反射表三个读者/一个写者补 tag 8/9 |
| GC | `gc_mark_value`/`gc_write_barrier_value` **保持显式 tag 表**（范围判断会把整数位当堆引用）；prop 扫描器注释言明为何 8/9 缺席 |

**三处 C 未定义边界（红线 §2.4 的落地）**：`%` 零除数（→ 0）、移位量 ≥ 位宽（掩 63）、
`double → int64` 的 NaN/Inf 强转（守卫 → 0）。**两处响亮拒绝**：`Vector.<int64>`（未单态化）、
64 位值进 `Object` 槽（会按 double 装箱舍入）——都报编译错误并给替代方案。

**验收**：`examples/stage94t.as`（A~G 七组 50+ 断言：精确性/回绕/掩码移位/跨族比较/转换族与 `is`/`as`/
容器与 GC/类字段与反射/条件与 switch；**纯 C 构建** ⇒ 天然覆盖 native 与 WASI 两端）；`test.ts`
`[int64]` **10 条**结构钉子；全量 `node test.ts` = **145 passed, 0 failed, 145 total**（144 → 145）。
文档：`docs/zh-cn/enhancements.md` §4.7（完整契约表）+ E9 行转「已完成」；`README-CN.md` bullet。

**踩坑（供后续）**：① `runtime.ts` 是**一个大 backtick 模版字面量** —— 插入的 C 注释里出现 backtick（哪怕
只在 `` ` `` 包一个单词）会立刻截断模版并报 `ERR_INVALID_TYPESCRIPT_SYNTAX`，本轮踩了两次；②
`as_v_str_val` 的 tag 8/9 **必须**返回 GC 拥有的字符串（`as_str_from_i64`），若返回 `as_i64_to_str` 的
**共享静态缓冲**，`trace(a, b)` 两个参数会都打印最后一个值（同一 printf 里两次调用的实参求值顺序未定序 →
两参数同指针）；③ 字面量**必须**按源码原文发射（`INT64_C(...)`），走 `Number()` 会在 2^53 以上先舍入；
④ `test.ts` 的钉子字符串里带撇号（`C's`）要用 `String.fromCharCode(39)` 拼接，且匹配示例文案时别误加前导引号。

---

#### 阶段九十四·二十五：E3/E4 由「零代码被动放行」改为「默认拒绝 + 具名开关」（v0.4.56 → v0.4.57）✅ 已完成

**触发**：E3（WebP/BMP/ICO）与 E4（相机 RAW/DNG）此前实测为「零代码可用」——我们的 Skia 本来就带
这些 codec，于是**默认产物比 AIR 宽**：`adl` 对它们一律报 `#2124`，我们却解出来了。这违反
AGENTS.md §1.5/§1.2d（增强必须 opt-in，默认产物与 AIR 同构）。用户裁决：**改为默认拒绝 + 显式开关**。

**改动（两个新具名开关 + 一处胶水闸门）**：

| 位置 | 改动 |
|---|---|
| `vendor/skia_glue.cc` | 新增 `sk_extra_format_refused(data, len)`：**魔数**拦 WebP（`RIFF....WEBP`）/BMP（`BM`）/ICO·CUR（`00 00 01 00` / `00 00 02 00`）/TIFF 系 RAW（`II*\0`、`MM\0*`）/RAF（`FUJIFILMCCD-RAW`）。**四条解码入口全部调用**（`sk_image_from_file`/`sk_image_from_bytes`/`sk_image_decode_argb`/`sk_image_decode_bytes_argb`），命中即返回 NULL ⇒ 自动走既有的 `#2124` 失败路径，**报错文案与 `adl` 无需另行维护就一致**。PNG/JPG/GIF 的魔数不可能撞车。 |
| `src/build.ts` `FEATURES` | `formats` → `ASC_ALLOW_EXTRA_FORMATS=1`（targets `native`+`wasm`，无额外库依赖）；`raw` → `ASC_ALLOW_RAW_FORMATS=1`（**仅 `native`**，`why` 点名 wasm Skia 缺 piex/dng_sdk 归档 ⇒ `--target wasm --features raw` 前置拒绝，不把 `undefined symbol` 抛给链接器）。同时改掉 FEATURES 顶部那句「登记 E4 会是空开关」的旧注释。 |

**故意不做的事**：`WBMP`（`SkWbmpCodec` 编入了）**不拦**——头部是裸多字节类型字段、无可靠魔数；与其猜一个
可能误伤真格式的判据，不如如实写明（§1.5：报明而非静默）。`QOI` 仍未编入，不在此列。

**实测（三条命令，`temp/codec-probe/`）**：
- 默认（`codec-probe.as` + `codec.build.json`）：PNG/JPG/GIF `ok`（尺寸+像素）；**BMP/WebP/ICO/SVG →
  `ioError #2124 Error #2124: Loaded file is an unknown type.`**（与 `adl` 逐字相同）。
- `--features formats`：BMP/WebP/ICO → `ok 37×23 tl=ff0000 br=ffff00`；SVG 仍 `#2124`（各开各的）。
- `--features svg`：SVG → `ok`（闸门不误伤 E1 通路——SVG 是 XML，不匹配任何魔数）。
- `--features raw`（`raw-probe.as` + `codec-raw.build.json`）：两份 DNG 的四条入口全部 `ok 600×338`；
  默认清单同一份源码全部 `ioError #2124`（`BitmapData.loadFile` 通道仍 1×1 未变）。
- `--target wasm --features raw` → `feature 'raw' is not available with --target wasm: the wasm Skia has no
  piex/dng_sdk archive ...`；`--features nope` → `unknown feature 'nope' (known: formats, raw, svg)`。

**文档**：`docs/zh-cn/enhancements.md` §1.4（开关表补三行 + 新增「默认拒绝」段）、§3 表 E3/E4 行、
§4.3/§4.5 正文（原「待你裁决 (a)/(b)」两处 → 定案 (b) 并附实测）；`docs/zh-cn/compile.md` §3.4.2 表格
+ 新增 §3.4.3.1（默认拒绝的完整口径、魔数表、三条命令）+ §3.4.3 句首更正（只有 PNG/JPEG/GIF 免宏）；
`README-CN.md` bullet。

**踩坑**：`temp/codec-probe/codec-raw.build.json` 里遗留了立项期的 `ASC_USE_RAW=1`（还带**尾逗号**导致
JSON 非法）——那个宏从未被任何代码读取过，正是「登记一个没人读的宏 = 空开关」的例子；本轮删掉并改用
真正的 `--features raw`。

---

#### 阶段九十四·二十六：`_Noreturn` 修掉 Starling 基准 2× 性能退化（v0.4.57 → v0.4.58）✅ 已完成

**现象**：Starling demo 的 Benchmark 场景（菜单 9 → **Start benchmark**）报告的是它能在 120 Hz 下**顶住的
峰值对象数**。阶段九十四·十二 … 九十四·二十五 之后只剩 **~22 000**；这些阶段之前是 **~38 000–42 000**。
等价于「这几轮的改动把渲染热路径的每对象成本翻了一倍」。

**定位（同一份生成 C 上做 A/B，完全不动 AS3 侧）**：`temp/perfreg/` 提供免手驱动（`bench-auto` 让场景自
启并打印 `BENCH obj=…`），把生成 C 的守卫逐个置空即可隔离变量：

| 变体 | 置空的东西 | 峰值 obj |
|---|---|---|
| `rebuild`（对照） | 无 | 21 888 |
| `v_obj` | `as_req_obj` → `return p;` | **42 144** |
| `v_box` | `as_req_box` → `return v;` | 22 096 |
| `v_both` | 两者 | 41 104 |
| `v_macro` | `as_req_obj` 改成恒内联宏 | 40 992 |
| `v_noret` | **`as_throw` 上加 `_Noreturn`（即本修复）** | **40 992** |
| 真实流水线重编 | — | **42 160** |

⇒ 成本**全部**来自阶段九十四·十二 引入的**指针接收者守卫 `as_req_obj`**（`as_req_box` 无关）。

**根因**：`as_req_obj` 被发成一个**函数**，函数体里调 `as_throw`。clang -O2 在**大型热函数里没有内联它**
（把抛出路径当成普通调用计入了内联代价），于是**每一处**受守卫的成员访问都变成一次**不透明的函数调用**
——不透明调用迫使优化器在它前后溢出/重载，这正是「每对象成本翻倍」的来源。证据：热函数
`starling_display_MeshBatch_addMeshAt` 的调用点（`bl`）数，基线 **29** 个 vs `_Noreturn` 版 **3** 个（宏版 11 个）；
`sample` 也直接采到了 `_as_req_obj` **内部**的 PC（说明是调用而非内联）。反过来，在守卫**确实被内联**的微基准
（`guard.as`）里它完全测不出开销——这就是它此前一直隐形的原因。

**修复**：`as_throw` 只有两条出口（`exit(1)` 或 `longjmp`），**确实永不返回**。用**标准 C11 的 `_Noreturn`**
把这个事实写出来（`src/runtime.ts`，一行改动），clang 便能内联守卫，把每处热访问压成 `cmp` + 未命中分支，
抛出路径留在冷区。**为什么不用宏**：宏会把实参求值两次，而 demo 里有 **300+** 个守卫点的实参本身就是函数调用
（`Starling_get_current_static(…)`、`Game_get_assets_static(…)`）——双重求值既是语义变化、又是新的不透明调用源。
`_Noreturn` 保持单次求值、不是 `__attribute__`（符合 §2.6），并顺带改善其余全部 `as_throw*` 错误路径。

**跨后端**：`_Noreturn` 在 native clang（默认 / `-std=c11` / `-std=c17` / `gnu99`）、wasi-sdk clang
（`--target=wasm32-wasip1`）、`emcc` 下均编译通过（逐条直接验证）。

**回归**：`node test.ts` **145 passed, 0 failed**（新增 `[noreturn]` 结构钉子 **5 条**，含「specifier 必须
仍然成立」「守卫仍走 `as_throw`」「理由必须留在 specifier 旁」「A/B 数字必须留在证据台」）；`examples/stage94*.as`
与 `hello`/`with`/`dict` 共 **20 例**编译并运行全通过；`[nullref]` 15 条 + `examples/stage94k.as`（`#1009` 守卫本体）
继续全绿 ⇒ 语义零变化。

**遗留表**：**不动**——这是**已修缺陷**，不是欠账，也不是增强。

**踩坑**：① `src/runtime.ts` 是模板字面量，插入的注释里**不能有 backtick**（本轮又踩了一次，
`ERR_INVALID_TYPESCRIPT_SYNTAX`）；② 用 `otool | grep callq` 数调用点是**错的**——ARM64 是 `bl`，而且未链接的
`.o` 里 `bl` 操作数不解析成符号名，两次都会得到「0 调用」的假阴性；可靠判据是**同函数 `bl` 计数对比**或 `sample`。

**顺带发现（已在本阶段修正，见下）**：当时记为「`--target wasm` 对 `hello.as` 亦报 `call to undeclared function 'close'`
系 wasi-sdk 34 的工具链漂移」。**该判断是错的**——根因在本仓库自己的 runtime（见 阶段九十四·二十七），
不是工具链，也不是「新 SDK 更严」：wasi-libc 的 `unistd.h` 一直声明 `close`，只是我们从未把它 include 进来。

---

#### 阶段九十四·二十七：修好 `--target wasm`（WASI 编译 + web 链接双断）与跨后端 seam 钉子（v0.4.58 → v0.4.59）✅ 已完成

**现象（两处独立断裂，都在 wasm 家族）**：

1. **`--target wasm`（WASI）对每一个示例都编不过**——`examples/wasm-native/` 的 `fib.as`/`demo.as`/`export-meta.as`
   以及 `examples/hello.as`、`socket.as` **无差别**地报：
   ```
   error: call to undeclared function 'close'; ISO C99 and later do not support implicit function declarations
     (×2: as_sock_drop_fd、as_sock_free)
   warning: declaration of 'struct sockaddr_storage' will not be visible outside of this function [-Wvisibility]
     (as_sock_fill_addr 的参数类型)
   ```
2. **`--target wasm --package web` 链接不过**（`wasm-ld`）：`undefined symbol: sk_window_text_take` /
   `sk_window_text_edit_take` / `sk_window_set_text_input_rect`（任一挂了窗口的 app，如 Flappy-Starling）。

**根因 1（socket fd 关闭缺平台守卫）**：socket 状态机的 `as_sock_drop_fd`/`as_sock_free` 在**每个**目标都跑
（它们只碰 `fd` 这个 int 与缓冲区），却直接调 POSIX 的 `close(fd)`；而提供 `close` 的 `<unistd.h>` 所在的
include 块被 `#if !defined(__wasi__) && !defined(__EMSCRIPTEN__) && !defined(_WIN32)` 排除。WASI/Windows 上
`s->fd` **恒为 -1**（`unsupported=1`，没有后端），这行调用逻辑上永不执行 —— 但 C99+ 里**未声明的函数是硬错误**，
编译器不看运行期可达性。`-Wvisibility` 同源：`as_sock_fill_addr` 的 `const struct sockaddr_storage*` 参数由
`<sys/socket.h>` 提供，非 POSIX 目标上是不完整类型。

**修复 1**：新增唯一的平台无关入口 `as_sock_close_fd(int)`——POSIX 下是真 `close()`，其余目标是不做事的 stub——
并把 `as_sock_drop_fd`/`as_sock_free` 两处调用改走它；`as_sock_fill_addr` 的**整个定义**移入 `ASC_SOCK_POSIX` 守卫
（其调用方 `as_sock_capture_addrs` 本就在守卫内，故非 POSIX 下既不定义也不调用）。

**根因 2（两个窗口胶水后端分叉）**：生成的 C 在 `ASC_USE_WINDOW` 下**无条件**声明并调用**整族** `sk_window_*`，
但这族符号由**两个**文件分别实现（native 的 `vendor/window_glue.cc`、web 的 `vendor/web_glue.cc`，两者签名刻意一致）。
阶段九十四·十七 为 IME 合成态新增了 `sk_window_text_take`/`sk_window_text_edit_take`/`sk_window_set_text_input_rect`，
只落进了 native 那一份 ⇒ web 的 seam 默默缺了三个符号，直到 `wasm-ld` 才暴露。物证：`examples/Flappy-Starling/
Flappy-Starling.html`（web）最后一次成功产出是 **10-01**，而 `window_glue.cc` 的改动时间是 **10-04 16:41**。

**修复 2**：在 `vendor/web_glue.cc` 既有 `sk_window_*` stub 家族里补齐这三个（web 端键盘通道整个尚未接线，
故「无可合成文本可排空 / 无 OS 候选窗可摆」是诚实答案，不是静默降级），并在注释里指向 `sk_window_show` 中
既有的「web 键盘未接」说明与 TODO.md 登记。

**验证**：

- **WASI**：`examples/wasm-native/{fib,demo,export-meta}.as` 与 `examples/{hello,socket}.as` 全部 `rc=0`、**零告警零错误**；
  `wasmtime` 运行 `fib` = `102334155`、`demo` 自检 21 行全出、`export-meta` 导出表/`.exports.json` 不变。
- **native 未破**：`examples/socket.as`（完整 loopback 断言，走真 `close()` 路径）`socket: all flash.net socket assertions passed`；
  21 个 headless 示例编译并运行全通过。
- **web 端到端**：Flappy-Starling `--target wasm --package web` `rc=0`，产出 `.wasm`/`.js`/`.html`/`.data` 四件套；
  浏览器打开后 `document.title` 变为 `Flappy-Starling`、canvas 后备 3200×2000、采样 **64/64** 像素非零（确实在渲染）。
- **回归**：`node test.ts` **145 passed, 0 failed** + 新增 `[backendparity]` 结构钉子 **7 条**。
- **反向对照**（把两处修复还原）：`[backendparity]` 中 **3 条**应声变红（「native-only 符号必须是已登记的 Metal-only」
  「三符号必须两端都实现」「不得再有裸 `close(s->fd)`」）⇒ 钉子真的守得住这条断链，不是摆设。

**遗留表**：**不动**——这是**已修缺陷**，不是欠账，也不是增强。

**跨后端**：修复只涉及条件编译边界，无行为变化 —— native/web/WASI 共享同一份 C，语义面零改动。

**踩坑**：`src/runtime.ts` 是模板字面量，新增注释里**不能有 backtick**（本阶段又踩一次，`ERR_INVALID_TYPESCRIPT_SYNTAX`）。

**顺带发现（已登记，不在本阶段范围）**：web 端键盘/剪贴板仍未接线（`web_glue.cc` 里 `(void)on_key` 与
`sk_clipboard_*` 空实现的既有说明），本轮只是让**不依赖键盘**的 web 构建重新可链接；键盘通道与 IME 的
`compositionstart/update` 仍属遗留表既有条目。

#### 阶段九十四·二十八：重生成 `examples/wasm-native/` 产物，并修掉其中暴露的 `--export` 与 `[WasmExport]` 两处缺陷（v0.4.59 → v0.4.60）✅ 已完成

**缘起**：阶段九十四·二十七 修好了 `--target wasm` 的**编译/链接**，用户随之要求把仓库里提交的
`examples/wasm-native/` 产物用修好的编译器**原地重生成**。重生成本身是一次「把化石接回当前运行时」的
动作，却在过程中暴露**两处只在「用导出功能」时才触发的真缺陷**——上一阶段让编译通了，但导出功能还断着。

**现象 1（`--export <sym>` 链接失败）**：`as-aot fib.as --target wasm --export fib -o fib-export` 在 `wasm-ld` 阶段报
`symbol exported via --export not found: fib`。

**根因 1**：阶段七十八 的 `staticizeTopLevelFunctions()` 把非导出的文件作用域函数统一标 `static`（体积手段），
只放行 `main` 与 `[WasmExport]` 符号——它**不知道 CLI 的 `--export`**，于是 `fib` 被标成 `static`，链接器再也找不到它。

**修复 1**：把 `cfg.exports` 作为 `keepGlobal` 一路穿到 `generateC(program, cfg.exports)` → `Emitter` → staticize 豁免
（`src/codegen.ts`、`src/emit.ts`、`src/index.ts`）。语义等价（顶多是少 `static` 化一个符号、少删一点代码），
纯粹是把「CLI 声明的导出」补进既有的豁免名单。

**现象 2（包级 `[WasmExport]` 元数据被吞）**：`export-meta.as` 的 `package mathlib { [WasmExport] function add… }`
编译成功，但 `export-meta.exports.json` **缺少 `add`/`multiply`**。

**根因 2**：`parser.ts` 的**包体**解析里，遇到 `[` 走的是 `else if (this.at('['))` 分支——它把元数据消费掉后**直接丢弃**，
没有把语句交回 `parseStatement()`；而**类体**里的元数据走的是另一条（正确的）分支，所以只有**包级顶层函数**中招。

**修复 2**：包体里消费元数据后**回退（rewind）**，当后继 token ∈ `METADATA_DECL` 时让 `parseStatement()` 主持解析（`src/parser.ts`）。

**验证**：

- **`node test.ts` = 145 passed, 0 failed**（新增 `[wasmexport]` 结构钉子 **6 条**）。
- **反向对照**：还原修复 1（三文件）或修复 2（`parser.ts`）后，`[wasmexport]` 对应钉子应声变红 ⇒ 钉子真的钉住了这两条断链。
- **产物**：7 个目标（`hello`/`fib`/`fib-export`/`export-meta`/`demo` × wasm，`export-meta`/`demo` × native）全部 `rc=0`；
  `wasmtime` 跑 `fib`=`102334155`、`demo` 自检 21 行全出、`export-meta` 导出表含 `add,multiply,twice`。
- **真浏览器端到端**（CDP + 静态服务）四页全过：`fib.html` 出 `102334155`（WASM 246 ms / 快 2.8×）、
  `index.html` 环境检测 3✓ 且 `_start` 退出码 0（STDOUT 335 B 自检全文）、`export-meta.html` **7/7 断言 PASS**、
  `fib-export.html` 直调 `fib(40)=102334155` + 可重入 + `fib(10)=55`。

**顺带发现 1（WASI import 集合 11 → 18，需要补 HTML 桩）**：重生成后的 `.wasm` 导入
`environ_get, environ_sizes_get, fd_fdstat_set_flags, fd_read, fd_readdir, path_filestat_get, path_open` 这 7 个
**旧 HTML 桩没有**的 import，导致 `fib.html`/`index.html` 的 `instantiate` 直接失败（浏览器实测报
`Import #0 "wasi_snapshot_preview1" "environ_get": function import requires a callable`）。根因在 `src/runtime.ts`：
GC/IO 路径里读**调试开关环境变量**（`getenv("ASC_GC_STATS")` 等 14 处）与文件 job（`fopen` 6 处）让 `-O2` **必然**
保留 `getenv`/`fopen`，从而拉进 environ + 文件系统 import 家族——**这不是缺陷**（native 上开关有用），
但意味着每个 wasm 模块都带文件系统 import。**处置**：给两个**显式枚举** import 的桩（`fib.html`、`index.html`）
补齐 7 个诚实桩（environ 空、fd/path 返回 `EBADF`/`ENOENT`）；`export-meta.html`、`fib-export.html` 用的是
**Proxy 通配桩**，本就免疫，未改。

**顺带发现 2（wasm 体积 3.2×，其中 ~68% 是 DWARF）**：`fib.wasm` 115822 → **421358** B，但 `clang … -Wl,--strip-debug`
后为 **133145** B ⇒ 真正的**代码**只涨 ~15%（运行时前导的历期增长），其余 **288 KB 是 wasi-sdk-34 的 `libc.a`
调试段**（`wasm-ld` 默认保留）。`src/build.ts` **当前无 strip 策略**，本阶段只记录、**不改默认行为**
（是否 strip 是项目级取舍，留给后续决策）。

**遗留表**：**不动**——这两处都是**已修缺陷**（不是欠账、也不是增强）。

**证据台**：`temp/regen/README.md`（before/after 哈希清单、import 差分脚本、根因反查脚本、strip 对照产物、副本备份）。

**踩坑**：`examples/wasm-native/*.html` 是**手写**的加载页（非编译器产物），其中 `fib.html`/`index.html` 是
**逐条枚举** WASI import 的桩——一旦运行时多引入一个 import 就会静默失效，直到浏览器里才暴露；
另两页用 Proxy 通配桩，免疫。后续若再改运行时 import 面，需同步检查这两页。

---

#### 阶段九十四·二十九：wasm 默认 `--strip-debug`（三端产物一致）+ `--debug-info` 正向开关（v0.4.60 → v0.4.61）✅ 已完成

**缘起**：阶段九十四·二十八 的「顺带发现 2」——`fib.wasm` 从 115822 涨到 **421358** B、其中 ~288 KB 是
DWARF，当时记为「**当前无 strip 策略**（待决）」。用户就此提问三件事：①是否给 `--target wasm` 默认加
`-Wl,--strip-debug`；②其它端是不是也带调试符；③能不能设计一个 `--release true/false` 参数。

**实测回答 ②（三端调试符现状）**——只有 WASI raw 一个例外：

| 目标 | 默认带调试符？ | 实测证据 |
|---|---|---|
| native（`cc -O2`） | **否** | `examples/wasm-native/demo` 无 `__DWARF` 段，仅有常规符号表（393 符号） |
| web（`emcc -O2`） | **否** | 现场编 trivial 程序：`emcc -O2` = **2010 B、0 个 custom section**；加 `-g` 才 = 28243 B（多出 `.debug_info/.debug_line/...`）。提交的 `hello-web.wasm` 亦为 0 个 custom section |
| wasm raw（`clang --target=wasm32-wasip1 -O2`） | **是** | `fib.wasm` 421 KB 中 **287 KB 是 `.debug_*`** |

根因不是我们的代码，而是 **wasi-sdk 34 的 `libc.a` 自带 DWARF、`wasm-ld` 默认保留**：现场编一个 trivial
`printf`（3.6 KB code）就拖进 **62 KB** 调试段。⇒ **给 wasm raw 默认 strip 恰好让三端一致**（emcc 在 `-O2`
下本来就 strip、native 在 `-O2` 下本来就无 DWARF）。另：`-Wl,--strip-debug` **只删 `.debug_*`，`name` 段保留**
（8 KB 函数名）⇒ trap 仍打印**带函数名的栈**，只丢源码行号/变量级调试。

**设计决定 ③（`--release` → `--debug-info`）**：「release」在本项目里语义重叠——优化等级已由既有 `opt`
（默认 `-O2`）承担，release 的另一半才是「调试信息」；且 `--release false` 会有「不优化 vs 留调试符」的歧义，
`true/false` 值解析也是新形态（现有 `--lto`/`--pgo` 都是裸旗标/枚举）。改用**正向调试信息开关**（对应 clang/emcc
的 `-g`），与 `opt`/`lto`/`pgo` 正交、不重复、无歧义。用户选定此案。

**实现**（`src/build.ts`、`src/index.ts`）：

- `BuildConfig.debugInfo: boolean`（默认 `false`）；清单字段 `debug-info`（含 `targets.<target>` 分层覆盖）。
- 两个方向各一个助手，四类命令构建器共用、不会漂移：
  - `debugInfoFlags(cfg)` → 开则 `-g`（**每个编译步**都加，故我们生成的 C 也有行号）；
  - `wasmStripFlags(cfg)` → **仅 wasm 链接**且关时 `-Wl,--strip-debug`。
- CLI `--debug-info`（裸旗标，与 `--lto` 同形态），usage 已列。
- 默认产物：wasm raw 带 `-Wl,--strip-debug`；native 无 `-g`（不变）；web 无 `-g`（不变）。

**验证**：

- **`node test.ts` = 145 passed, 0 failed**（新增 `[debuginfo]` 结构钉子 **13 条**：默认无调试符、wasm 默认 `--strip-debug`
  且**绝不是** `--strip-all`（保住 name 段）、native/web 默认无 `-g`、三种目标 `--debug-info` 均加 `-g`、native C++ 路径
  每步都带 `-g`、清单与 `targets` 分层均可达）。
- **反向对照**：把 `debugInfoFlags`/`wasmStripFlags` 都改为恒空（即特性未接线），`[debuginfo]` **5 条变红**。
- **实测体积/可运行**（wasi-sdk-34）：默认 `fib.wasm` = **133147 B**（custom 仅 `name/producers/target_features`）、
  `wasmtime` → `102334155`；`--debug-info` = **639899 B**（含 `.debug_*`，`llvm-dwarfdump --debug-line` 命名
  **`fib_dbg.c`** ⇒ 可对 AS3 降级出的 C 做源码级调试），同样 `102334155`。
- **产物重生成**：`examples/wasm-native/` 的 wasm 由 421~428 KB 全体降到 **133~138 KB**（`fib.wasm` 421358→133139、
  `demo.wasm` 427915→137981、`hello.wasm` 423776→133842 …），native 两个可执行**逐字节不变**（默认未加 `-g`），
  7 目标全 `rc=0`。
- **WASI import 面未变**（18 个，`--strip-debug` 不动 import/export/ABI）⇒ 两个显式枚举桩仍 18/18 满足。
- **真浏览器复验**（CDP + 静态服务）：`fib.html` → `102334155`（退出码 0）、`index.html` → 环境 3✓ + 退出码 0 + 335 B 自检全文。

**遗留表**：**不动**——这是**构建产物形态的策略决定 + 新开关**，不是欠账、也不是 AIR 增强（DWARF 与 AIR 无关）。

**证据台**：`temp/regen/README.md`（§3 副作用 2 由「待决」改写为「已决：默认 strip」；含三端对照实测表与命令）。

---

#### 阶段九十五·一~二：SWC 位图资源提取器 + 资源类嵌入（v0.4.61 → v0.4.62）✅ 已完成

**缘起**：用户就 [`docs/zh-cn/swc.md`](docs/zh-cn/swc.md) 选定首批范围为 **A（位图提取器）+ B（资源类嵌入）+ E（矢量/Graphics）**，
节奏为「**分步，先打通链路**」——先完成最基础项并跑通 `skin.swc` 验收，再决定下一步。本条目交付 **A + B**（含随范围的 C 收尾），E/F 未做。

**A — `src/swc.ts`（提取器，只读资源、不解析 ABC）**：ZIP 解包（EOCD/中央目录/本地头）→ FWS/CWS 解压
（`ZWS`/LZMA 无内置解压器，**响亮报错**，属 `swc.md` §10 延后）→ stage header 跳过 → tag 扫描 →
`DefineBitsLossless/2`(20/36) 解码（fmt 3/4/5；tag20 XRGB 与 tag36 ARGB 区分；行 32 位对齐）→
**编译期反预乘** `floor(stored*255/A + 1/3)`（§3.2 拟合 AIR 的取值）→ 零依赖 **PNG 重编码器**（IHDR/IDAT/IEND + 自实现 CRC32，
每行 filter 0）→ `SymbolClass`(76) 解析 → `DefineBitsJPEG2/3`(21/35) 原字节直搬（JPEG3 的 alpha 平面未合成，**发警告**）。
实测 `temp/skin.swc`：**59 个位图 / 16 个命名资源**；PNG 合计 **14,499 B**（文档估 14,569 B，差 ~0.5%）。

**B — 资源类注册 + 编译期嵌入**：`swcCompileInputs(lib)` 把命名资源合成 `dynamic class X extends flash.display.BitmapData`
（构造器 `(width:int=0, height:int=0)` 但**实参被忽略**，`super(0,0,true,0)`），追加进 `program.body` 参与符号收集/类型解析/虚表/反射注册表；
`Emitter` 新增第 4 参 `swcResources`，在 `emitDefinitions` 起始发 `static const unsigned char __res_<cname>[]`（PNG 字节，`\xNN` 转义 C 字面量；
避开 `\x` 贪婪吃十六进制位与 `??` 三字符组两个坑）与 `BitmapData_adoptEncoded()`（走**既有** `as_skia_image_decode_bytes_argb` →
GC 堆拷贝 + 写屏障 → `as_skia_image_from_bytes` 留 Skia 视图，**零新增解码器**），并在资源类构造器末尾注入调用。
接入面：CLI `--swc <f>`（可重复）、清单 `swc-paths`（含 `targets.<target>` 分层）、重复类名**响亮报错**、构建横幅点名资源数。

**验收（`adl 51.4.1` 对照）**：资源类两条引用路都通——`new logo(0,0)` 与 `getDefinitionByName("logo")` + `new cls()` 均得 **100×72**，
且 `new logo(999,999)` 结果不变（实参被忽略）。像素层分两段核验：

1. **我们写出的 PNG 逐点精确**：用纯解码器（zlib inflate + filter 0，不经 Skia）解开 `encodePng` 输出与 `adl` 真值比对，
   **322,300 像素 maxChannelDiff=0**。
2. **AOT 产物 vs `adl` `getPixel32`**：**388,648 像素中 206 个不符（0.053%），全部 maxChannelDiff=1**，且只落在 `logo` 的
   A∈{143,191} **半透明**像素上（另三张 alpha 只有 0/255，两次取整都是恒等 ⇒ 0 偏差）。根因是 **Skia**
   `readPixels(kBGRA_8888, kUnpremul)` 对 straight-alpha PNG 先 `SkMulDiv255Round` 预乘、再按 `(v*255+a/2)/a` 反预乘，**两次取整**漂 ±1——
   库边界行为，不是我们的实现缺陷。**alpha 逐位精确、不透明像素精确**，且在 `swc.md` §11③「允许 ±1 通道偏差」之内。
   该行§5 原写的「运行时解码逐点对齐」**已按实测改成带此结论的修正段**，§10 另记一条已知限制。

**顺带补齐的 AIR 缺口**：`BitmapData.getPixel32` / `setPixel32` 此前**完全缺失**（`pixels` 一直是 straight ARGB，
但读不到整个 32 位值；TODO 的 ARGB 契约笔记早已假设它们存在）。本批补上（`setPixel32` 仅对 `transparent` 位图保留 alpha，与 AIR 一致）。

**验证**：`node test.ts` = **146 passed, 0 failed, 146 total**。新增示例单元 `examples/swc-bitmap.as`
（配套 `examples/swc-bitmap.build.json`，`swc-paths` 指向仓库根 `temp/skin.swc`）：**结构层**（类存在/是 BitmapData/实参被忽略/反射一致）
在**纯 C 构建**下也断言，**像素层**（100×72、alpha 逐位、不透明像素全值、半透明 RGB ±1）仅在 Skia 构建下断言。
两处被本批合法失效的源码钉子已改成**自维持**形式：`[svg]`「像素采纳点必带 GC 写屏障」由硬编码 `=== 2` 改为**与
`bd->pixels = (void*)gcpx;` 采纳点个数相等**；`[wasmexport]` 的 `generateC(program, cfg.exports)` 期望更新为带 `swcResources`。

**遗留表**：`swc.md` §10 新增「运行时解码 ±1 漂移」一条（含根因与为何不做自带 PNG 解码器）；§9 的 E/F
（矢量 shape 烘焙 + `Graphics` 子路径/样式模型升级；九宫格 + 按钮四态）**仍未开始**。
另按实测修正 `swc.md` §5.1 一条过强断言：`-O2` **会丢弃未引用的资源字节，但不会丢弃合成的资源类**——
`hello.as` + `--swc` 实测二进制 130,552 → 195,880 B（+約 65 KB：`__text` +40.5 KB、`__data` +13.3 KB）。

**证据台**：`temp/swc-btest/`（t.as 逐点 dump + t.build.json）、`/tmp/swctruth/*_truth.txt`（`adl` 真值）、
`temp/swc_probe.mjs` / `temp/swc_accept.ts` / `temp/swc_compare.ts`（A 期脚本）、`temp/swc_dump_png.ts`（导出 PNG 供纯解码器比对）。

---

#### 阶段九十五·三~五：E（矢量 shape + 显示树 + `Graphics` 组模型）+ F（九宫格 + 按钮四态）（v0.4.62 → v0.4.63）✅ 已完成

**缘起**：接续 阶段九十五·一~二（A/B），完成立项时敲定的 **E（矢量/`Graphics`）** 与首期额外纳入的
**F（九宫格缩放 + 按钮四态）**，即「SWC 皮肤只有位图没有矢量」与「缩放糊/按钮不响应」两个可观测缺口的正面解决。

**E — `DefineShape` 烘焙 + 显示树**：`swc.ts` 解析 `DefineShape`1/2/3/4（样式表按图层分隔；**`NewStyles` 是替换而非追加**，
实测 98/378 多图层）、`DefineSprite` 时间轴与 `PlaceObject*`（矩阵/颜色变换/`clipDepth`），烘焙为
「子路径 + 样式索引」；`Graphics` 从「单路径双画笔」升级为**有序绘制组模型**（`as_gdraw` + `as_gflush` +
`_even_odd` / `_max_sw`，逐组命中判定与指纹），并补齐位图填充 shader、实色/线性渐变、描边 cap/join/miter、
`SkColorFilters::Matrix` 颜色变换与 `clipDepth` 遮罩（`as_swc_clip_path_new`）。另补 `BitmapData.draw(DisplayObject)`。

**验收（`adl 51.4.1` 对照，`temp/swc-render/`，200 个导出符号）**：矢量 round-trip **378/378**；渲染四档
（`exact`/`tol16`/`no-struct`/`colour-ok`）结果 **bitmap 3/1/1/1、display（无文本）2/37/37/27、
display（含文本）0/90/120/23**（含文本两列于 2026-10-06 先后随 阶段九十五·六 与 阶段九十五·七 刷新为 **0/90/120/22** → **0/90/120/23**），
`params: ours lines 200, adl lines 200, ERR ours/adl 0/0`。
逐项归因与开放项见 [`docs/zh-cn/swc.md`](docs/zh-cn/swc.md) §9.1 与 §9.2 F4（其中 `vbitemskin` 一处未定位差异已由 阶段九十五·六 结案）。

**F1 — 九宫格缩放（`DefineScalingGrid` 78，实测 22 个）**：烘焙期除 `TWIPS=20` 写入烘焙角色的 `scalingGrid`；
运行时新助手 `as_render_nine_slice`（自然尺寸烘焙一次 + 9 组 src/dst 条带重组，边框条带在本地单位里**除以缩放**，
极缩时中段夹到 ≥0）。条带取样走新增的 `sk_canvas_draw_image_src_rect`（`kStrict_SrcRectConstraint`）。
**关键实测（钉定 AIR 口径）：九宫格只对角色**自己的 `scaleX/scaleY`** 生效，对时间轴 `PlaceObject` 矩阵拉伸不生效**——
证据两条：① 1× A/B 让 placement 触发 grid 后与 `adl` 的差异面**反向扩大**（42 个 entry 变差）；
② entry 103（`元件97`）经容器 2× 拉伸的 RAW 逐像素对比，grid **ON** 差 51 px（0.06%）/ ON `nz` 18674 vs adl 18676，
grid OFF 差 200 px（0.22%）。⇒ `emitSwcPlacement` 永远把 SWF 矩阵写进 `transform.matrix`，不写进对象自身 `x/y/scaleX/scaleY`。

**F2 — 按钮四态（`DefineButton2` 34，实测 29 个全部烘焙）**：`ButtonRecord.states` 位掩码（up/over/down/hit）；
`as_sbtn_state` 在**绘制时**按实时指针状态选择（down→over→up→over→down→hit 回退），指针状态由
`Stage_dispatchMouse` 统一写入 ⇒ **SDL 窗口回调与 AS3 测试钩子 `stage.dispatchMouse(x,y,type)` 都能驱动四态**。
**踩到的坑（已修）**：hover 恒为 0——`as_sbtn_contains` 最初用 `as_pick_hit`，而它只报告 InteractiveObject，
按钮的 hit 态却是用**普通 `Shape`** 搭的，于是永不命中；改为把点映进 hit 态自身空间后走 `as_obj_region_hit_local`。
**结果（青三角为判据）**：ours 离屏 `up=4dfcfcfc / over=ffffffff / down=ff00948c / 回退=ffffffff`；
`adl` 窗口截图 down 态三角 **(0,147,139)=`0x00938b`** ⇒ 差在截图色彩管理漂移内，**四态与 AIR 一致**。

**验证**：`node test.ts` 当时为 **146 passed**（新增 `examples/swc-shape.as` 后为 147）；1× SWC harness 回归逐项复现已接受的基线
（bitmap 3/1/1/1、display 2/37/37/27、text 0/90/118/21、ours/adl 200 行、ERR 0/0）。

**证据台**：`temp/swc-render/`（E 主 harness，含 `SCALE=` 杠杆与 `rawpng.ts`）、`temp/btnstate/`（F2；
`off.as` = 离屏确定性四态验收，`gen.ts`/`drive.py` = 窗口版 ours 自驱 + adl 真光标）、`temp/btn_dump.ts`（按钮记录转储）。

**遗留表**：新增两条（AS3 `scale9Grid` 属性未实现；`BitmapData.draw` 对 source 自身变换的处理与 AIR 不同），见下表。
窗口侧 ours 的 press 那一帧报图未复现（`adl` 侧四态齐全）；同一套 `as_render_object` 在离屏探针中与 AIR 逐像素一致，
故判为**报图/harness 限制**而非实现缺口，已记在 `swc.md` §9.2。

---

#### 阶段九十五·六：`PlaceObject3` 可见性（`Visible = 0`）—— 结案 §9.1 唯一的未定位差异（v0.4.63 → v0.4.64）✅ 已完成

**缘起**：用户要求「看看 swc 分支还有哪些未实现」⇒ 对 `temp/skin.swc` 做一次全量 tag 普查
（`temp/swc_census.ts` / `temp/swc_po3*.ts`），并把「解析过但从未出现在产物里」的字段逐个点名。

**发现**：`readSwfPlacement` 把 `PlaceObject3` 的 `Visible` / `FILTERLIST` / `BlendMode` / `BitmapCached`
**读完就扔**（`SwcPlacement` 里没有这四个字段），而实测**本库的烘焙闭包内就有 63 条**：
`hasVisible` **38** 条、`FILTERLIST` **13** 条、`BlendMode` **8** 条（值 2=`layer` / 6=`darken`）、
`BitmapCached` **2** 条——全部落在 214 个导出符号的显示树里，属**违反「绝不静默」的静默丢弃**。

**关键实测（口径先行，`temp/vishidden/` 两侧同一段 body）**：`adl 51.4.1` 对 `Visible = 0` 的处理是
**建出子件并置 `visible = false`**，不是省略该 placement——
`vbitemskin`(#293) `adl` 侧 `numChildren = 6`（其中 `c3.visible == false`，藏在 depth 6 的 #286），
我们修前只有 5 个；`fileitemdoctorskin`(#63) 7（2 隐藏）vs 4；`fileitemskin`(#389) 5（2 隐藏）vs 2；
`homeskin`(#1121) 7 全可见 = 7 ✓。

**实现**：`SwcPlacement` 加 `hidden`（`hasVisible && Visible == 0`）→ `SwcBakePlacement.hidden` →
发射侧 `if (p.hidden) c->visible = false;`。渲染侧本就跳过不可见子件，故**像素与「整条跳过」完全一致**，
而对象树也对齐了 AIR（只跳过的写法能骗过像素对比，但 `numChildren`/`getChildAt(i).visible` 会露馅）。

**收益（1× 全量重测，42 个 entry 变化，全部变好）**：`maxdcS` 在带 `Visible = 0` 的符号上普遍塌下来——
`fileitemdoctorskin` **205 → 2**、`setupskin` 239 → 31、`mymtskin` 211 → 30、`subtitleskin` 181 → 22、
`surveyhdskin` 185 → 61、`systemUpdateSkin` 154 → 37、`onlineskin` 73 → 24、`vbitemskin` **76 → 30**；
结构档 `元件1_3`/`元件2_6` **struct 16 → 0**、`userskin` 4 → 1、`filepreviewskin` 2 → 1。
汇总 text 档 `no-struct 118 → 120`、`colour-ok 21 → 22`（bitmap/display 两档不动）。

**结案**：`swc.md` §9.1 末条「`vbitemskin` 一处未定位的灰/白差异」根因即此（隐藏对象压在不透明白矩形上：
覆盖形状相同、只有填色不同，正是 `maxda = 0` 而 `maxdcS = 76` 的 signature）。

**验证**：`node test.ts` = **147 passed, 0 failed**；`examples/swc-shape.as` 新增结构钉子 ⑤
（`vbitemskin` `numChildren == 6` 且恰有 1 个子件 `visible == false`）；1× harness 回归逐项复现新基线。

**证据台**：`temp/swc_census.ts`（tag 普查）、`temp/swc_po3.ts` / `temp/swc_po3_visible.ts`（逐条 `PlaceObject3`
属性 + 是否在烘焙闭包内）、`temp/vishidden/`（对象树对照：`numChildren` + 逐子件 `visible`，ours 与 adl 同 body）、
`temp/swc-render/rep_hidden_{off,on}.txt` 与 `rep_visible_flag.txt`（1× 逐 entry 前后对比）。

**遗留表**：新增三条（`FILTERLIST`/`BlendMode`/`BitmapCached` 静默丢弃；不支持字符类型让子件数偏少；
placement 矩阵不回填子件自身 `x/y`），见下表。`Visible` 本项**已不是**遗留，故不进表。

---

#### 阶段九十五·七：`PlaceObject3` 的滤镜 / 混合模式 / BitmapCache（v0.4.64 → v0.4.65）✅ 已完成

**缘起**：阶段九十五·六 的普查把 `PlaceObject3` 的四个属性一次点名（`Visible` 已修，其余三项进遗留表）。
本阶段把 **`FILTERLIST` / `BlendMode` / `BitmapCached`** 三项补齐：它们都是 AIR 已定义行为 ⇒ 遗留缺陷。

**属主（烘焙闭包内，`temp/swc_po3_detail.ts`）**：`FILTERLIST` **13** 条（**11 Glow + 2 DropShadow**）、
`BlendMode` **8** 条（**7**×值 2 = `layer`、**1**×值 6 = `darken`，`homeskin` depth 2）、`BitmapCached` **2** 条。
Glow 记录同形：`{color:0xff000000→AS3 color 0/alpha 1, blur 16, strength 0.19921875, quality 1, inner 0,
knockout 0, composite 1}`；DropShadow 两条：`{color:0x7f000000→color 0/alpha 0.5, blur 10, angle 0,
distance 0, strength 0.5390625}`。**注意 SWF 的 GLOW/DROPSHADOW 颜色是 RGBA，AS3 只吃 RGB** ⇒
`0xff000000` 是「黑 + 全不透明」，不是「透明」。`strength` 与 `alpha` 是两个独立量。

**两处 AIR 语义实测（本阶段实质）**：

1. **`strength` 必须在模糊之后乘**，模型 = `min(1, 剪影 × 颜色 alpha × strength)`
   （`temp/filterprobe/`，40×40 黑矩形 → 逐点 alpha）：Glow 0.2/0.5/1/2 → 4/10/21/42（线性）；
   `(alpha 0.5, strength 2)` 与 `strength 1` **渲染完全相同**；DropShadow 0.5/2 → 27/110。
   两次被实测证伪的做法：①忽略 `strength`（每个烘焙光晕满强度作画）；②**模糊之前**把
   `alpha*strength` 夹到 1（`strength 2` 塌成剪影；剪影不透明 ⇒ 前置 alpha ≥ 1 完全饱和，
   曾让 `strength 1` 与 `2` 的光晕一模一样）。实现 = glue 的 `sk_alpha_scale_after()`（alpha 行矩阵，包在模糊外）。
2. **模糊是「直径 `blurX` 的 box 重复 `quality` 次」，不是高斯**：`blur6 q1` 逐点
   191/148/106/63/21/0（`d ≥ 4` **为 0**，有限支撑）；`blur6 q3` = 3 个 box 叠加。直径 b 的 box 方差
   `b²/12` ⇒ 实现取 **`sigma = blur * sqrt(quality) / sqrt(12)`**（取代 `blurX/3`，后者对 `quality` 无感）。
   残留口径（已登记）：Skia 的模糊是 3-box 逼近高斯 ⇒ 中部更陡、尾部更薄
   （`blur6q1` ours 217/161/94/38/9 vs AIR 191/148/106/63/21）；求真 box 需每层 36~256 抽头的
   `MatrixConvolution`（非可分离），性能风险大于收益。

**顺带修掉一个真实 bug（Skia 陷阱，必须留痕）**：`strength` 缩放一度套在
`SkImageFilters::DropShadow` 的**输出**上，而该工厂是「阴影 **+ 源**」的合成结果 ⇒ 源被一起乘了 `strength`。
症状：1× harness 里两个 DropShadow 符号 `popcontrolskin`/`skin_fla.元件124_72` `struct 0→12/14`、
`maxda 6→118`；`RAW=29`（popcontrolskin 425×124）逐像素质证 **36.34% 像素不同**，逐格 alpha 图显示整条 bar
的 alpha 是 **137/255 = 0.537**（该记录 `strength` = **0.539**）。修法 = 按两个**都精确**的区间分流：
`alpha*strength ≤ 1` 时把整份印记烘进**阴影颜色**并用 `DropShadow`（Skia 自己合成源，调用方不重画源）；
否则用 `DropShadowOnly` + 模糊后缩放 + 调用方另行画源（复现 AIR 的饱和区间：`alpha 1, strength 2` → 0.431）。

**落地**：`SwcFilter` 三种（0 DropShadow / 1 Blur / 2 Glow），`CompositeSource = 0` → `hideObject`（DropShadow）
或 C 运行时私有位 `_shadow_only`（Glow 无 AS3 对应字段）；`passes` → `quality`；FilterID 3–7 只跳字节并
进 `swcBake.notes` **报明**。`BlendMode` → `DisplayObject.blendMode`（String 槽）+ `BlendMode` 常量类，
`layer` = 纯分组隔离（`saveLayer` + `kSrcOver`），Skia 表达不出的模式返回 0 且**报明**。
`BitmapCached` → `cacheAsBitmap`；顺带把 `cacheAsBitmap` 改成**私有后备槽 `_cache_flag`**
（AS3 静态类型的字段读直取 C 槽、绕过访问器 ⇒ 公开槽会让 `c.cacheAsBitmap` 读不到「OR 上 `filters`」语义；
改后 `temp/attrsprobe/` 的 cache 列与 AIR 逐项一致）。混合层是 `as_render_object` **最外层**包裹
（ct 与 clipDepth 在其内），还原序 clip → ct → blend。

**验收（1× harness，基线 `temp/swc-render/rep_final.txt`）**：bitmap 3/1/1/1、display（无文本）2/37/37/27
**两档不动**；含文本档 `tol16/no-struct` 不动、`colour-ok 22 → 23`，`ERR 0/0`。逐符号**一边倒变好、无一处变差**：
`staticskin` maxdc 93 → 35 / maxda 7 → 3、`popinfoskin` maxdc 185 → 79、`poproomIdsskin` maxdc 100 → 13、
`popnoticskin` maxdcS 34 → 5、`poppluginskin` maxdcS 10 → 7、`popmiccamskin` maxdcS 4 → 1、
`popgiftskin` maxdc 38 → 23，且上述两个 DropShadow 符号已回到基线。`temp/filterprobe/` 的 5 条不变量
（strength 线性 / alpha×strength 等价 / DropShadow 线性 / q1 有限支撑 / 更宽的 blur 影响更远）在 **ours 与 adl 上逐行相同**。

**验证**：`node test.ts` = **147 passed, 0 failed**（新增 in-process `checkFilterRaster()`：σ 公式存在且方差匹配、
无残留 `blurX / 3.0`、glow/DropShadow 都传 `->strength` 与 σ 助手、glue 在模糊**之后**接强度缩放、运行时暴露 `double st` 包装）。
`examples/swc-shape.as` 新增 **⑥**（纯结构、不依赖 Skia）：`staticskin` 恰 1 个子件的 Glow（blurX 16、color 0、
`strength == 0.19921875` 精确比较、quality 1）、`homeskin` 恰 1 个 `darken`、`userskin` 恰 2 个 `layer`、
`mymtskin` 恰 1 个 `cacheAsBitmap`、`editnickname` 子件 0 的 Glow blurX 17。

**证据台**：`temp/swc_po3_detail.ts`（滤镜/混合/缓存普查）、`temp/filterprobe/`（强度与模糊模型 + 5 条不变量，两侧同跑）、
`temp/attrsprobe/`（属性指纹逐项对 adl）、`temp/swc-render/pixq.ts`（逐格 alpha 图，定位「整条 bar 掉到 137/255」）。

**遗留表**：从表中移出「`FILTERLIST`/`BlendMode`/`BitmapCached` 静默丢弃」一条；新增四条
（`inner`/`knockout` 未在光栅路径实现、FilterID 3–7 报明、模糊剖面是高斯近似、
`BlendMode` 中 Skia 表达不出的模式报明），见下表。

#### 阶段九十五·八：未支持字符的**占位子件** + 子件变换/包围盒对齐（v0.4.65 → v0.4.66）✅ 已完成

**缘起**：阶段九十五·六 的属性普查（以及 `temp/childfx/` 子件树探针）暴露了一族**图像上看不见、
但 AS3 侧可观测**的缺口：`numChildren`/`getChildAt` 少子件、`child.x/y` 恒 0、`width/height` 与 `adl` 不符。
它们都是 AIR 已定义行为 ⇒ 遗留缺陷（非增强）。本阶段把三项一次做完（探针：15 个导出符号 / 99 个子件）。

**① 未支持的字符 = 空占位子件（绝不静默）**：`DefineEditText`(37)/`DefineText`(11) 实测 **341 个** ⇒ 烘成
**空 `TextField`**（`_fieldWidth/_fieldHeight` 取声明 `RECT`）；`DefineMorphShape`(46)/`2`(84) 实测闭包内 **6 个** ⇒
烘成**空 `Shape`**（AIR 是 `MorphShape`，属 `Shape` 子类）。`numChildren`/索引顺序从此与 AIR 一致
（`minfo` 6↔6、`fileitemskin` 5↔5、`staticskin` 19↔19、`loginskin` 9↔9）。字形/初始文本/morph 几何
仍是**已声明缺口**，由 `swcBake.notes` 响亮报明。顺带解析了 `DefineEditText` 第二 flags 字节的
`AutoSize`（实测本库 341 个**全为 0**，故占位框按 `RECT` 报即与 AIR 无差）。

**② `clipDepth` 遮罩对象是子件**：修前把遮罩字符标 `unsupported` —— 那会让该字符在**任何位置**都不再出现
（潜在 bug：同一字符被别处当普通子件用时也消失）。改为：遮罩摆放**保留为子件**（AIR：`visible=true`、有自己
包围盒、从不被绘制），另置 C 运行时私有位 `_mask_object`（`DisplayObject` 构造 `false`），`as_render_object`
与 `as_pick_hit_m` 见到就跳过；morph/sprite 遮罩无法表达为路径裁剪 ⇒ 一句 `notes` 报明。
实测 `fileitemskin.c2`：AIR `n=4`（含 `MorphShape` 遮罩）↔ 我们 `n=4`。

**③ placement 平移 → 子件自身 `x/y`（scale 仍留矩阵）**：`emitSwcPlacement` 只把 2×2 写进 `transform.matrix`，
平移写进子件 `x/y`（文本子件再加 `RECT` 原点：`x = tx + RECT.xmin`）。实测 AIR：非文本子件 `child.x == matrix.tx`
（`vbitemskin c4 xy=41,23.75`）、`staticskin` 文本子件 `xy=9.25,55.7` ✓ 逐位相同。缩放**必须**留矩阵：
F1 实测 AIR 的九宫格不认 placement 拉伸（42 个被拉伸的 gridded entry 只有那样才对），且 AIR 仍从矩阵读
decomposed 值。像素不变（合成 `T(x,y)·R·S·M`）。另修 `as_do_extents`：轴对齐时直接算 `(r-l)*a*scaleX`
（角点映射会把子件自身 `y` 加上又减回，实测文本子件读成 `19.950000000000003` vs AIR `19.95`）。

**④ Shape 包围盒 = 声明的 SWF `ShapeBounds`**：实测 `#212`(adl `396.45×22.75`)、`#214`(`361.6×17.6`)、
`#210`(`360×16`) 三者都**逐位等于声明矩形**，而我们的**运行时路径点累积盒**在若干角色上会偏
（`#212` 曾报 `374.7×1`；它是一组 74 条 hairline 斜线排线，累积盒不稳）。故 `as_bounds_walk` 增第三参 `decl`：
`decl && g->_clip` 时取 `as_swc_clip` 记下的声明矩形（**不再叠加描边半宽**——声明矩形已含描边），递归透传；
显示口径传 1（`as_do_extents`/`width`/`height`/`getBounds`/`hitTestObject`），命中测试与 `getRect` 传 0
（AIR 按绘制区域拾取）。`temp/shbox.ts` 普查：378 个 shape 里声明矩形与「路径并集+描边」有 **116 个**不同
⇒ 声明矩形才是权威并集。`decl` 只喂 AS3 包围盒读口，**不参与光栅**。

**验收**：

- `temp/childfx/`（`cmp.py`，TOL 1e-6）：**`x/y` 0 处、`numChildren` 0 处不符**（修前 `x/y` 全错）；
  `width/height` **39 → 35**（证据 `temp/childfx/cmp_item2_final.txt`）。残留：33 处**精度级**
  （`|Δ| ≤ 0.021px`，AIR 自己的包围盒量化/累积口径；例 `userskin c4` `260×30` vs `260.0006×30.0001`）、
  3 处 morph 几何缺失（`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`、`元件124_72 c2` `11.75×11.75` vs `0×0`、
  `元件27_310 c0` `1×18` vs `0×0`）。
- **1× harness 与修前逐 entry 0 差异**（`temp/swc-render/rep_final.txt` 已刷新）：bitmap 3/1/1/1、
  display（无文本）2/37/37/27、display（含文本）0/90/120/23、`params 200/200`、`ERR 0/0`。
  唯一变化是**分桶**：`元件27_310` 的 morph 遮罩现在是子件（morph 属「文本类」判据）⇒ 无文本 40→39、
  含文本 156→157，各桶计数不变。
- `examples/swc-shape.as` 新增 **⑦**（纯结构、不依赖 Skia）：`staticskin n=19` + 子件 1 `is TextField &&
  x==9.25 && y==55.7 && width==79.4 && height==19.95`、`fileitemskin n=5`、`c2 n=4` 且其子件 1 `is Shape`、
  `loginskin n=9` 且子件 1 `is Shape && visible`、`popchatitem c0 scaleX/scaleY == 1 && transform.matrix.a ==
  1.497314453125 && .d == 1.1999969482421875`。
- `node test.ts` = **147 passed, 0 failed**（exit 0）：新增 2 条几何检查（声明盒分支 + 递归透传），
  并同步 6 处 `as_bounds_walk` 签名断言。

**证据台**：`temp/childfx/`（`gen.ts` + `cmp.py` + 嵌套 `deep()` dump，15 符号 / 99 子件、逐子件对 `adl`）、
`temp/shbox.ts`（378 个 shape 的声明矩形 vs 路径并集）、`temp/swc-render/`（1× 全量像素）。

**遗留表**：移出「子件数偏少」与「placement 矩阵不回填子件自身 `x/y`」两条（按规则移出、结论并入本条），
换入 4 条更窄的（占位子件只有空壳、子件 scale 仍读 1、AIR 包围盒量化口径未定案、子件类名身份）。

#### 阶段九十五·九：多帧**时间轴烘焙** + `FrameLabel` + `MovieClip` 时间轴 API（v0.4.67 → v0.4.68）✅ 已完成

**缘起**：阶段九十五 E/F 只烘 `DefineSprite` 的**第 1 帧**，`FrameLabel`(43) 与 `RemoveObject2`(5/28) 根本没解析，
`MovieClip` 只能报「第 1 帧 + 自己数出来的 `totalFrames`」。本阶段把**逐帧关键帧差值**在编译期烘成静态表，
运行期时间轴 API 逐项对齐 `adl 51.4.1`（证据台 `temp/tlprobe/`：共享 body 两侧编译，68 行 API 输出 **0 差异**）。

**AIR 实测口径（全部为 `adl` 直读，`temp/tlprobe/adl.txt`）**：`totalFrames` = `ShowFrame` 条数；新建剪辑
`currentFrame == 1` 且 **`isPlaying == false`**，在显示列表上跨 12 帧也**不自走** ⇒ 皮肤符号的 `stop()` 在 `DoABC` 里
（我们读不到）⇒ **烘焙剪辑一律停在第 1 帧**（既不发明动画，也让像素 harness 逐位不变）；属性名是 **`isPlaying`**（无 `playing`）；
`currentLabel`/`currentFrameLabel` = 该帧 `FrameLabel` 名或 `null`；`currentLabels` = `FrameLabel` 数组；
`gotoAndStop` **前进**就地打增量（子件身份保持）、**后退/回 1** 则**重建**目标帧对象（adl 复现出新的自动实例名）；
`nextFrame`/`prevFrame` 步进 + **回绕**。

**落地**：① 解析新增 `FrameLabel`(43)（`readSwfCString` → `SwcSprite.labels`）、**`RemoveObject`(5)/`RemoveObject2`(28)**，
`SwcPlacement` 增加 `visibleFlag` 三态与 `ratio`；② 烘焙 `spriteFrames`（键 = Flash **深度**，非子件索引）：
帧 1 建 `depth → {charId, matrix}` 状态，逐帧推演「带字符 = 增/替（继承省略的变换）、`Move` 无字符 = 改、
无 `Move` 无字符 = **删**」，空 op 丢弃并计数报明（本库 270 条只带 morph `Ratio` 的记录）；③ 发射
`as_swc_tl_total/start/find/put/del/clear/apply` + `as_swc_tl_labelcount/labelat/frameat/label/labelframe`
（静态 `switch(charId)` + `strcmp`）、`MovieClip` 的 `play/stop/gotoAndPlay/gotoAndStop/nextFrame/prevFrame` 与
`isPlaying/currentLabel/currentFrameLabel/currentLabels`、新内建类 **`FrameLabel`**、时间轴子件深度 `_tl_depth`
（0 = 用户 `addChild`）；**无 bake 时全部发空桩**；④ 多帧 sprite 现在实例化为 `MovieClip`（与 AIR 的
`flash.display::MovieClip` 一致，原先报 `Sprite`）。

**三个「绝不静默」的实测发现**：① **`RemoveObject2` 原先被解析器静默丢弃**（17 条记录）——`toastbtn`(#634) 帧 2 是
「删深度 2 + 在深度 3 放新字符」，AIR 报 **3** 个子件、我们原先报 **4**；② 标签名误用了**内嵌字节**的 UTF-16 转义
（`cStringLiteral`）⇒ `FrameLabel.name` 全空而 `currentLabels.length` 正确，改用 `escapeCString`；③ 无 bake 时
`as_swc_bind` 没有定义 ⇒ **4 个示例链接失败**（正是阶段九十七 验收里记录的那 4 个），补 stub 后全绿。

**烘焙口径**（`temp/tlcheck.ts`）：79 个多帧 sprite、75 个帧 1 后有变化、448 个 op 帧、514 个 op
（102 增/替、404 改、8 删）；89 条 `FrameLabel`（31 个 sprite）；SWF 原始 17 条 `RemoveObject2` 里 9 条与
同帧同深度的「重放」折叠成「新建对象」。

**验收**：① 时间轴探针 68 行 API 对 `adl` **0 差异**（`checkbom` 帧 2 的文本子件 `x = 200/20 + RECT.xmin(-2) = 8`
—— **修改记录同样套文本原点规则**）；② `temp/childfx/` 仍 `x/y` 0 处、`numChildren` 0 处、`width/height` 35 处；
③ **1× 像素 harness 与 `rep_final.txt` 196 行逐 entry 0 差异**；④ `examples/swc-shape.as` 新增 **⑧** 结构断言
（`desktopshareitem` 21 帧 / `_up` / `!isPlaying` / 3 条 label、`gotoAndStop("_down")→15`、`nextFrame/prevFrame`
1↔2、`toastbtn` 帧 2 仍 3 子件、`checkbom` 帧 2 `x==8` 且回退 24、`元件172_339` 3 帧 1 子件）；⑤ `node test.ts`
全绿（exit 0），新增 `unit: render/SwcTimeline` **11 条 C 文本钉**。

**证据台**：`temp/tlprobe/`（`gen.ts` + `cmp.py` + `adl.txt`/`ours.txt`）、`temp/tlcheck.ts`（烘焙与 op 计数）、
`temp/tlcensus.ts`、`temp/tldel{,2}.ts`（删记录归因）、`temp/childfx/`、`temp/swc-render/`。

**遗留表**：新增 2 条（时间轴子件 `name` 恒 `null`、每帧 ActionScript/`DoABC` 不执行），并把 morph 时间轴
`Ratio` 记录被丢弃并入既有 morph 行；烘焙坐标的末位差（≤2 ULP）并入既有「包围盒量化」行。

**同批修掉的前序失败**：阶段九十七 验收里记录的 4 个 `_as_swc_bind` 未定义符号失败（`examples/air-native/`、
`dyn-prop.as`、`stage62.as`、`stage94f.as`）已由本条修掉（stub 改为 `this.swcBake === undefined` 时发射）。

---

#### 阶段九十六：音频播放（`flash.media`）—— 补齐阶段六十三 延后的 `Sound`（v0.4.68 → v0.4.69）【P2】✅ 已完成

**起因**：阶段六十三 把 `flash.media` 整体延后（依赖音频解码后端），阶段九十三 只留下 `Sound` 的**空壳**。2026-10-06 完成完整调研与裁决，结论见 [`docs/zh-cn/audio.md`](docs/zh-cn/audio.md)（英文 [`docs/en/audio.md`](docs/en/audio.md)）。

**现状是空壳而非「未实现」**：`Sound_play` 恒 `return SoundChannel_new()`、`loadCompressedDataFromByteArray`/`stop` 是 `(void)` no-op ⇒ **能拿到 `SoundChannel` 对象，但一个字节声音都发不出**；全仓无任何音频后端/解码器。

**关键实测（决定了后端不能复用现有 SDL2）**：`vendor/sdl2/arm64/lib/libSDL2.a` 只含 `SDL_dummyaudio.o`（`nm` 零 AudioUnit 符号 / `strings` 无 `coreaudio` / `SDL_AUDIO_DRIVER_COREAUDIO` undef）⇒ `SDL_OpenAudioDevice` 会**成功返回但永不发声**；web 侧 `-sUSE_SDL=2` 会联网拉 **SDL 2.24.2**（本机 emsdk 未装该 port，`cache/ports/` 仅 `zlib`），与 native vendored 的 **2.32** 版本错配，且仓库 web 分支刻意排除 SDL2（`src/air-app.ts:259`「no SDL2/objc/Cocoa」；实测 `Starling-Demo.wasm` 的 SDL 符号数 = **0**）。

**已裁决（2026-10-06）**：

- **后端 = miniaudio**（单头文件；一处实现覆盖 native CoreAudio + web AudioWorklet；内置 MP3/WAV/FLAC 解码。A（miniaudio）/ C（重编 SDL2）在 native 与 web 上的逐项对照见 `audio.md` §4.1）。
- **范围 = A~D 全量**：
  - **A** 后端 + 解码骨架：`new Sound()`、`loadCompressedDataFromByteArray`、`play→SoundChannel`、`stop`、`SoundTransform(volume,pan)`；
  - **B** 语义补齐：`startTime`/`loops`/`position`/`SOUND_COMPLETE`/`SoundMixer.stopAll()`/32 声道上限；
  - **C** 元数据面：`length`/`bytesTotal`/`bytesLoaded`/`id3` + `OPEN`/`COMPLETE`/`PROGRESS`/`IO_ERROR`/`ID3` + `SoundLoaderContext`；
  - **D** 高级：`SoundMixer.computeSpectrum`/`Sound.extract`/`sampleData`/`loadPCMFromByteArray`/流式 `Sound.load(URLRequest)`。
- **`[Embed]` 缺口**（`audio.md` §10）**独立延后**，不并入本阶段。
- **属「补遗留」非「增强」**（AIR 本来就出声）⇒ **不加 `--features`**；WASI 无后端须**如实报明**，不静默假装成功。

**第一颗钉子：✅ 已钉（2026-10-06 实测，证据台 `temp/audiomini/`）**——30 行探针（`ma_context_init` +
`ma_device_init` + `ma_device_start` + 播 440 Hz 正弦）在两端**零额外开关**编译并拿到**真实后端**：

| 端 | 编译（零额外开关） | runtime 后端 | 结果 |
|---|---|---|---|
| native | `clang -O2 -o probe-native probe.c -lpthread -framework CoreFoundation -framework CoreAudio -framework AudioToolbox` | **`Core Audio`**（4 个播放设备，默认 `MacBook Pro扬声器`） | 三个 init/start 全 `0 (No error)` + `PROBE_OK` |
| web | `emcc -O2 -o probe-wasm.html probe.c`（**零 `-s` 开关**，4.6 s） | **`Web Audio`**（1 个 `Default Playback Device`） | 同上 + `PROBE_OK` |

⇒ 与上条「SDL2 哑驱动陷阱」正好对照：两端都拿到**真实**后端（不是 null/dummy）⇒ **可直接开工 A 步**。
（探针产物：`temp/audiomini/probe.c` + `probe-native` + `probe-wasm.{html,js,wasm}` + `probe-{native,wasm}.txt` 存档；
miniaudio **v0.11.25**，4.1 MB / 95,864 行。）

**落地（2026-10-06，v0.4.69）**：

- **A~D 全量实现**：`Sound`（`play`/`load`/`close`/`loadCompressedDataFromByteArray`/`loadPCMFromByteArray`/`extract`/`length`/`bytesTotal`/`bytesLoaded`/`url`/`id3`/`isBuffering`/`isURLInaccessible`）、`SoundChannel`（`stop`/`position`/`leftPeak`/`rightPeak`/`soundTransform`）、`SoundTransform`（存储四个增益、`pan` 为**派生量**、setter 不夹取）、`SoundMixer`（`bufferTime`/`audioPlaybackMode`/`stopAll`/`areSoundsInaccessible`/`computeSpectrum`/`soundTransform`）、`SoundLoaderContext`、`ID3Info`。**语义逐项按 adl 51.4.1 实测**（口径表：`audio.md` §13）。
- **后端 = miniaudio v0.11.25**（`vendor/audio_glue.c`，独立 TU，`MINIAUDIO_IMPLEMENTATION` 不污染生成的 C；`as_audio_*` 接缝在 `src/runtime.ts`）。**有无后端生成的 C 逐字节相同**：清单加 `vendor/audio_glue.c` + `ASC_HAVE_AUDIO` 即启用（`src/air-app.ts` 的 `detectAudio` 自动加，web 端不接并**构建期警告**）。线程红线：混音回调只读固定声道槽 + malloc 的 PCM，**绝不碰 GC 堆**，`SOUND_COMPLETE` 只在 AS3 线程帧边界派发。
- **一个新发现（语义级）**：AS3 算术是 IEEE double、**每一步一次舍入**，而 `-ffp-contract` 默认会把 `1.0 - ltl*ltl` 融成 FMA —— `SoundTransform.pan` 的 1-ULP 漂移（adl `0.2604000000000001`）因此变成 `0.2604`。⇒ `src/build.ts` 新增 `fpFlags()`，四个构建器（native/wasm/web 的编译与链接）一律带 **`-ffp-contract=off`**：这是**语义开关**，不是优化开关。
- **收尾又补了第 10 轮探针（`gen10.ts`）**：`Sound.load` 的**失败面**——缺失文件与**不可解码的负载**在 adl 上都派 `ioError`、`errorID=2032`、**不派** COMPLETE、也没有 OPEN，但 `url` 读回**非 null**。这轮当场挖出**两个真 bug**：① 我们的 `Sound` `ioError` 事件**没写 `errorID`**（文案里有 2032、事件上是 0）⇒ 补上「事件也带号」，并把 `test/unit/transport.ts` 的「每个 ioError 都带号」计数从 3 收到 **5 个点位**（该断言就是为这类漏写设计的）；② 一个**不是音频的文件**我们会派 `COMPLETE`（空声音），adl 是 `ioError 2032`（AIR 先解码再报完成）⇒ `Sound__finish` 增加解码失败分支。两个 bug 都只被**这一轮**暴露（前 9 轮都喂的是真音频）。
- **验收证据**：`temp/audioprobe/diffall.sh` → **14 轮 PASS / 0 轮 DIFF / 5 轮 N/A**（两个网络若干字段级归一化见 `divergences.sed`；N/A 的每轮原因写在脚本的轮次表里——adl 自身卡死 VBR / 参考被看门狗截断 / 旧生成器场景被饿死）。另有三支后端级探针逐位对齐：`temp/audiomini/{dectest,id3test,specprobe}.c`（标称帧数、ID3 逐字段、波形峰值）。
- **示例**：`examples/audio.as` + `examples/audio.build.json`（`test/examples.ts` 的 `EXAMPLE_ARGS` 传入清单）——自带 44100 帧 PCM 音源，**不需要素材文件**，并按 `SoundMixer.areSoundsInaccessible()` 分叉：CI 无声卡时走「如实报明」支路（`play()` 返回 `null`、`computeSpectrum` 数组原样不动），本机有声卡时走真实播放支路，两条支路都已实测通过。
- **差异清单**：`audio.md` §14（8 条，含 adl 自身在本平台的坏路径：PCM 搬运恒 0、VBR 卡死、`play(length)` 卡死、FFT 整形不可反推）。其中「类实例隐式 `toString` / `Error.name` 缺失」「`SampleDataEvent` 动态音频」两条**与音频无关或属未实现范围**，入下方遗留表。
- **文档同步**：`audio.md`（zh/en）状态横幅 + §13 实测口径 + §14 差异清单；`README-CN.md` `flash.media` 段。
- **收尾补记（2026-10-06，demo 帧音效静音定位）**：用户放开 `examples/air-starling-demo` 的 `Sound` 后发现 `adl` 参考与 AOT 产物**都无声且无报错**。定位到**应用侧**一行缺陷：`starling/assets/AssetManager.as` 构造器的 `registerFactory(new SoundFactory())` 被注释掉，mp3 于是落到兜底工厂 `ByteArrayFactory`（优先级 -100、`canHandle` 对任何 `ByteArray` 恒真），被当**裸字节**注册 ⇒ `getSound("wing_flap")` 恒 `null`、`setFrameSound(2, null)` 静默无效。放开该行后两端实测 mixer 均有输出（adl 峰值 0.74→1.46、AOT 0→0.65，且 AOT 探针**未**直接 `playSound`，故的确来自帧音效）。探针 `temp/soundprobe/`（adl，子类化 `Demo` 免手点入 `MovieScene`）+ `temp/demosound/`（AOT 同构）；口径已写入 `audio.md` §13.4（zh/en）。顺手复验 `--air-app` 会因 demo 用到 `flash.media` **自动**写入 `vendor/audio_glue.c`/`ASC_HAVE_AUDIO=1`/`CoreAudio`+`AudioToolbox`，重建后的 `Starling-Demo.build.json` 与用户手改版**逐字节等价**。本行**不在本表**（应用侧修复，非编译器缺口）；过程中另发现两个**编译器**缺口，已登记下方遗留表（`is` 右操作数为 Class 变量；`*` 类型上的 `Vector.length`/下标）。

**验收（按 DoD）**：`examples/audio.as` 通过（`--run`，两条支路各跑一次）；回归 `examples/` 全量 + `test:unit`（收尾实测 `npm run test:unit` **48/48**（后追加 demo 音频复验组 ⇒ **49/49**）、`npm run test:examples` **148/148**，含新增的 `audio.as` 与示例总数 147→148）；
`README-CN.md` 类型表与限制同步；版本号 **v0.4.69**（v0.4.66 = 阶段九十五·八、v0.4.67 = 阶段九十七、v0.4.68 = 阶段九十五·九）。

---

#### 阶段九十七：测试基础设施 —— examples(E2E) + 单元层 + CI（v0.4.66 → v0.4.67）✅ 已完成

**起因（先更正一个前提）**：「现在只测 examples、该不该建单测」这个前提**不成立**——`test.ts` 3904 行里早有单元层：**536 条 `check()` 断言 / 44 个 `checkXxx(): string[]` 组**（对生成的 C 做源级结构钉）、**39 处 `generateC(parse(src))`** 纯编译器单测、9 处示例 golden 钉；examples 层才是 147 个单元。**真正缺的是三件**：① **无 CI**（`.github/` 只有个 `.DS_Store` + 视频，无 workflow——断杆能活下来就靠这个）；② **无模块边界**（1400+ 行单测挤在一个文件里）；③ **示例结构性测不到的负例缺口**（错误诊断）。

**已落地（2026-10-06）**：

- **框架 = 内置 `node:test`**（AGENTS.md §3.1 禁第三方依赖 ⇒ vitest/jest 不可选；Node v24 原生直跑 `.ts`）。`node test.ts` / `npm test` 仍是文档口径的全量入口，内部改为注册 node:test 用例；新增 `npm run test:unit` / `test:examples` 分层入口。
- **拆分（逐字搬迁，非重写）**：`test.ts` → **9 行**（仅两条 import）；44 个 `check*` 组 + 辅助 `glueBodyArrow` 搬到 `test/unit/` 的 **10 个模块**（`lexer` 1 / `build` 7 / `transport` 6 / `render` 8 / `display` 4 / `text-input` 5 / `numeric` 2 / `bytearray-amf` 3 / `reflection` 4 / `platform` 5）；examples E2E 搬到 `test/examples.ts`（**一个示例一个用例**，可 `--test-name-pattern` 单跑）；共享 prelude（`root`/`dir`/`EXAMPLE_TIMEOUT_MS`）归 `test/harness.ts`。切片用**顶层锚点**而非花括号计数（`check` 体里满是含花括号的 C 代码字符串/正则，计数必错）；45 块**零重叠零遗漏**。
- **补诊断缺口**（examples **结构性**测不到——示例套件只跑「必须成功」的程序）：新增 `test/unit/diagnostics.ts`，**22 条**断言钉住 `Lex error at L:C: …` / `Parse error at L:C: …` 的**精确文案 + 行列号**（含负例：`\u`/`\x` 位不足、字符串内裸换行、`expected '}' / ')' / ';' / identifier`），以及语义错误**必须抛错而非静默产出错 C**。每条均为**实测**而非推测（探针 `temp/testrefactor/probe-diag{,2}.ts`）。
- **CI 落地**：`.github/workflows/test.yml`（**arm64 macOS 运行器**——vendored SDL2/Skia 只有 macOS arm64 产物、窗口后端是 Cocoa/Metal、默认链接带 `-l iconv`，ubuntu 会挂；`setup-node` 取 v24）。注意：CI 首跑会因**未提交在制**的 SWC 改动而红（见验收）。

**验收**：单元层 **45/45 组 + 诊断 3/3 组全绿**；examples 层与改动前基线**逐项一致**（`143 passed, 4 failed, 147 total`）——4 个失败全是 `_as_swc_bind` 未定义符号（`examples/air-native/`、`dyn-prop.as`、`stage62.as`、`stage94f.as`），根因在 `src/emit.ts` 的 `as_swc_bind` 定义分支：stub 只在 `this.swcBake === undefined` 时发，而 `swcBake` 非空但**加载内容不含该符号**的路径漏定义。**该失败与本阶段无关**（`src/` 现有 **9109 行未提交改动**、`src/swc.ts` 整为新文件 ⇒ 阶段九十五 SWC 属在制品），故**不登记遗留表**，交由该阶段收尾。⇒ **已收尾**（阶段九十五·九，v0.4.68：`as_swc_bind` 的 stub 改为 `this.swcBake === undefined` 时发射，4 个示例全绿）。

**收口复测（2026-10-06）**：`node test.ts` ⇒ **195 passed / 0 failed / exit 0**（= 147 个示例单元 + 48 个单元用例；后者含本阶段 44 个搬迁组 + 3 个诊断组，及同期并发落地的 `render/SwcTimeline`）。**其后追加**（2026-10-06 demo 音频复验）：新增 `platform/AudioWiring` 组 ⇒ 单元用例 **49**、`node test.ts` 总计 **197**（= 148 个示例单元 + 49 个单元用例；实跑 `197 passed / 0 failed / exit 0`）。**逐行集合比对**（基线 722 条 `PASS` vs 收口 743 条）：仅 5 条 `[no-src-litter]` 措辞变化（守卫折入目录型用例，断言仍在跑），新增 22 条诊断钉 + 4 个此前失败的示例转绿 ⇒ **零断言丢失**。另把 `[no-src-litter]` 快照由**顶层改为递归**——该守卫的动机事件（`air-native` 的 `ArrayDemos.c` 落进 `src/demo/`）恰好发生在**已存在**的子目录里，顶层快照必然漏报（负向对照已验证：递归快照可见嵌套文件；5 个目录型用例在递归守卫下仍 5/5 绿）。
---

#### 阶段九十八：`Vector.<*>` 单态化补齐 + `*` 接收者的 Vector 动态访问（v0.4.69 → v0.4.70 → v0.4.71）✅ 已完成

**起因（遗留表两行）**：① `*`（动态）类型上访问 **`Vector` 的 `.length` 与下标**得 `0`/`null`（`Array` 正常），且 `pv.push(..)` **段错误**；② 同源的 `Vector.<*>`（`*` 元素）单态化面（`.length`/下标/`join`/`indexOf`/super 名）未补齐。

**根因（实测定位）**：单态化的 `Vector.<T>` 体是 **GCT_CUSTOM**，其**首字是它的 mark 回调、不是 vtable**。`as_any_get` 的 tag 4 分支只走 `as_dyn_get` ⇒ 落到默认返回（`length`=0、下标=null）；`as_dyn_call`/`as_any_call` 则把那个回调**当 vtable 头解引用** ⇒ `pv.push(..)` 段错误。

**adl 51.4.1 实测口径**（探针 `temp/vecstar/`：`vec-result.txt` C\*、`vec2-result.txt` E/F/G/H、`vecfill-result.txt` 填充值、`vecis-result.txt` `is`/`as`）：

- `pv.length` 可读**也可写**（增长填 `null`、截断）；`pv[i]` 读写皆可；**越界与负索引**的读/写一律 **#1125**（与静态路径同号）；
- `Vector.<Number>` 的新/增长槽填 **`0`**（`isNaN` false，`new Vector.<Number>(3).join()` = `0,0,0`）—— 与 `var n:Number` 的 `NaN` **不是一回事**；int/uint 填 0、引用/`*` 元素填 `null`；
- `*` 元素 `Vector.<*>` 的 super 是 **Object**；`<String>/<Object>/<Array>` 的 super 是 `Vector.<*>`；
- `Vector.<Number> is Vector.<*>` '''= false'''（`is` 按**精确元素名**匹配，不是「是某个 Vector」）；`[1] is Vector.<Number>` = false；
- `delete vec[0]` 是 **no-op**（`len` 不变、元素不变、`"0" in vec` 仍 true）；`"0" in vec` = true；
- `v.length = -1` 与 `pv as Vector`（**裸** `Vector`）会让 adl **挂起** ⇒ 不可测，不作口径。

**已落地（2026-10-06）**：

- **九十八·一（v0.4.70）`Vector.<*>` 单态化面**：`src/emit.ts` 6 处补 `any` 元素分支 —— `vectorCName` / `vectorElemReflectName`（`"*"`）/ `vectorElemToStr` / `vectorElemEq`（`as_v_eq`）/ `as_vec_super_fqn_impl`（`*` 与数值族同归 Object）/ `defaultCmp`（排序按 `as_v_str_val`）。
- **九十八·二（v0.4.71）动态访问（三个生成侧钩子）**：`runtime.ts` 声明 `as_vec_get_hook` / `as_vec_set_hook`（**返回 void**）/ `as_vec_call_hook`，判定复用现成的 `as_dyn_kind() == 3`（GCT_CUSTOM），**故判定不需要生成代码、元素类型只在钩子里用**；`as_dyn_get`/`as_dyn_set`/`as_dyn_call` 三个分派点接钩子，其中 `as_dyn_call` 的绕行必须在 super 链walk **之前**。`emit.ts` 新增 `emitVectorDynAccess()`：按各 spec 的 `mark` 匹配后，**转调同一个单态化助手**（`_get`/`_set`/`_setLength`/`_push`/…），故动态与静态两条路不可能漂移；`as_vec_wire()` 在 `main` 装载，无 Vector 的构建发**空桩**。**两个易漏点**（都已实测踩到）：`pv.length` 读走 `as_any_length`、`pv.join(..)` 走 `as_any_join`（codegen 直发，**绕过** `as_any_get`/`as_any_call`）⇒ 这两处也要 GCT_CUSTOM 分支，否则 `push` 对而 `length`/`join` 错；负索引需专门识别（`as_array_index_key` 把 `-1` 当非下标，会读回 `null` 而不是抛 #1125）。
- **#1125 错号**：静态路径 4 处 `RangeError_new("Vector index out of bounds", 0)` 的 `errorID` **0 → 1125**（adl 实测 #1125；旧值让 `catch` 里 `e.errorID` 恒为 0）。
- **`*` 元素槽的 GC 写屏障**：`Vector.<*>` 的槽是**可持 GC 指针的字段**，按 AGENTS.md §2.4 红线在 5 个写点（push/unshift/insertAt/set/splice）补 `gc_write_barrier_value`。**诚实说明**：`gc_alloc` 在标记期**新对象生而黑**（allocation barrier），故本修复关的是「**白**引用写进一个已扫描过的 Vector」这一窄窗口 —— 当前 harness **未能复现**该窗口的误回收（去掉屏障跑 `examples/vector-dynamic.as` + `ASC_GC_AUDIT_STRICT=1` 仍全绿），所以屏障是**依红线而加**，示例钉的是**行为**（4000 个元素穿过 200 帧的自增标记 + `System.gc()` 后完好）而非证明屏障。
- **填充值修正（实测发现）**：`Vector.<Number>` 的新/增长槽原用 `defaultInit`（`NAN`）⇒ 与 adl 的 `0` 不符；现按元素类型**零值**发射（仅这里改，`var n:Number` 的默认仍是 NaN）。

**验收**：

- 探针 `temp/vecstar/dyn.as` **逐行对上** adl 的 C1–C4/E1–E6/F1–F7/H1–H2（含 `pv.length` 读写、增长填 null、越界/负索引 #1125、`sort`/`reverse`、slice/concat/splice/map/filter/forEach、`Vector.<Object>` 的对象槽 + `System.gc()`）；`vecfill` 与 `vecis` 两轮对照后，**填充值三项全对齐**（`N fill 0,0,0` / `G grow 1,0,0`）。
- 新增 `examples/vector-dynamic.as`（40 条断言 + 200 帧 ENTER_FRAME 写屏障压力）；新增 `test/unit/vector.ts` **2 组 32 条**（`unit: vector/DynamicAccess` 22 条钉钩子接线/分派面/#1125/示例 golden；`unit: vector/AnyWriteBarrier` 10 条钉 5 个写点 + `*` 槽的 `gc_mark_value` + 填充值）。
- **性能代价（如实记录）**：`as_dyn_call` 现在多一次 `as_dyn_kind`（带段缓存的二分），微基准（800 万次动态方法调用）**0.047s → 0.052s（+5%）**；这是「动态调用与动态读同价」的代价，与 `as_dyn_get` 既有口径一致。体积：`hello.as` 的 `-O2` 二进制 **+320 B**（分派器在 `as_dyn_call` 不可达时被 `-O2` 自动剪掉）。
- **仍不忠实（已入遗留表）**：`p is Vector.<Number>` / `p as Vector.<Number>` 对**动态左值**仍失败（我们 false/null，adl true/向量）；裸 `Vector` 类型名报 `CodegenError`；`delete vec[i]`/`"0" in vec` 在静态 Vector 上仍是 codegen 报错。

**文档同步**：`TODO.md` 本节的遗留表行移除/新增；`README-CN.md` 版本号与 Vector 段。`package.json` v0.4.69 → **v0.4.71**（九十八·一 = v0.4.70、九十八·二 = v0.4.71）。

**遗留表**：本阶段移出 2 行（`*` 类型上的 Vector.length/下标；`Vector.<*>`（`any` 元素）**不支持**—— 已落地为 v0.4.70，结论并入上方「九十八·一」），新登记 2 行（`is`/`as` 的 `Vector.<T>` 右操作数、`delete`/`in` 在静态 Vector 上）。

---

#### 阶段九十九：`is` / `as` 的右操作数为**运行时 Class 值**（v0.4.71 → v0.4.72）✅ 已完成

**起因（遗留表一行）**：`is` 的右操作数是 `Class` 类型变量时 codegen 直接中断 —— `var c:Class = String; trace("x" is c);` ⇒ `CodegenError: unknown type 'c'`（`Emitter.emitIs` 只认**类型名**字面量）。这是**语言层**缺口（编译不过），与音频无关，是阶段九十六复验 demo 时撞出来的：`ShapeSkin.findByType(c, cls:Class)` 里的 `ch is cls` 编不过，只能改写成类型字面量。

**根因**：`is`/`as` 的右操作数**不是类型名，而是作用域里的一个表达式**（AS3 先在作用域里解析这个名字）。`Class` 变量/形参/字段持有的是**运行时类对象**，判定必须沿**真实** super 链走，而不是让 `resolveType` 去查类型表。

**adl 51.4.1 实测口径**（探针 `temp/cisprobe/`，`cis-result.txt` A–J 组 + `islit-result.txt` O 组）：

- 子类实例命中**父类**类对象（`new MovieClip() is c`，`c = Sprite` → true）；父类实例**不**命中子类（`new Sprite() is c`，`c = MovieClip` → **false**）；无关类恒 false；`null is c` = **false**；
- 接口 `Class` 值按 `implements` 判定；`Object` 类值对**任何非 null** 都 true；`Number`/`String`/`Boolean`/`Array` 类值按 box tag 判定；
- `as`：命中返回**原对象**、未命中 `null`（`null as c` = null、`5 as c` = null）；
- **右操作数不是类对象**（`Class` 槽为 `null`，或槽里塞了个非 Class 值）⇒ `is` 与 `as` **都** `THROW #1009`，且**先**校验操作数（左值是标量也照样抛）；RHS **只求值一次**；
- **顺带实测并修掉一处更早的错误折叠**（`islit-result.txt` O1–O27）：`x is Object` 对**除 `null`/`undefined` 外的一切**为真 —— `1 is Object`、`1.5`、`"x"`、`true`、`[1]`、对象字面量、**函数值**、类实例、以及 `*` 槽里的**装箱**值（tag 1/2/3/4/6/7）全 **true**，`null`/`undefined` 才 false；我们旧实现把静态标量/数组/记录/函数一律折成 **false**（`1 is Object` 竟得 false），`as_v_is_object` 也只认 tag 4/6。

**已落地（2026-10-06，v0.4.72）**：

- **运行时助手**（`src/emit.ts` `emitSealedPropErrors()`，`#1009` guard 家族内）：`as_req_class(as_class*)`（NULL ⇒ `TypeError #1009`）、`as_class_is_obj(void* obj, as_class*)`、`as_class_is_val(as_value, as_class*)`（tag 4/6 才取指针，与 `as_v_obj_val` 一致）、`as_class_as_val(as_value, as_class*)`。
- **`classValueOperand(name)`**：名字含 `.`/`::`/`<` 或**是标量类型名** ⇒ 不当 Class 值（仍走类型名路径）；否则查作用域（`lookupClassVar`：闭包/局部/字段/静态字段/模块变量，与 AS3 作用域优先一致）⇒ 命中则走**动态分支**。
- **`emitIs`/`emitAs` 的动态分支**（插在**标量折叠之前**，保证同名 `Class` 变量能遮蔽同名类）：`any` 左值走 `_val` 变体；`interface`/`object` 左值走 `as_v_obj((void*)(…))`；其他静态左值用**逗号表达式** `((void)(lhs), (as_req_class(c), false))` —— 左值仍求值、RHS 仍校验 #1009，然后折 `false`/`as_v_null()`。`as` 的结果类型是 **`any`**（AS3 里 `x as C` 是 `*`）。
- **`is Object` 修正**：`as_v_is_object` 改为 **`v.tag != 0 && v.tag != 5`**（tag 规则即「除 null/undefined 外皆 Object」），`emitIs` 的 `Object` 分支静态值只把 `null`/`void` 折 false，其余折 true。

**验收**：

- 探针 `temp/cprobe1.as`~`cprobe3.as` 逐项对上 `cis-result.txt`：A1–A6（子类/父类/无关/`null`）、B1–B3、G1/G3/G4（`*` 左值按运行时类）、E1/E2 **#1009**、I1/I2；
- 探针 `temp/cprobe4.as` 对上 `islit-result.txt` **O1–O20 全部一致**（唯一差异见遗留表新增行：`(1 as Object) == 1`）；
- 新增 `examples/is-class-operand.as`（10 组 60+ `check()` 断言：类变量 RHS 的 super 链、helper/字段/形参、`as` 结果、`*` 左值、异构列表过滤、`#1009`（`try/catch` 验 `errorID`）、标量左值、类型名字面量回归、`is Object` 全表），输出 `is-class-operand: all assertions passed`；
- 新增 `test/unit/reflection.ts` 的 `unit: reflection/ClassValueOperand`（16 条**源级**钉：`as_class_is_obj`/`as_class_is_val`/`as_class_as_val`/`as_req_class` 的接线与 `#1009` 文案、逗号表达式的求值与折值形态、helper 形参走 `_val`、类型名路径未被污染、`is Object` 静态折叠与 tag 规则、示例 golden）。

**文档同步**：`README-CN.md` 版本号 v0.4.72 + 「当前限制」新增本阶段条目（含**未实现**边界）；`package.json` v0.4.71 → **v0.4.72**。

**遗留表**：本阶段把「`is` 右操作数是 Class 类型变量」那行**改写为部分完成** —— **用户类/SWC 类已落地**（v0.4.72），剩余是**内建类/接口不能作 Class 值**（`var c:Class = Object` 报 `undefined variable`，`adl` 合法）；另**新登记 1 行**：`(标量 as Object) == 标量` 比较为假（本阶段 O 组探针实测发现）。


---

#### 阶段一百：语义层报错统一带行列号（`CodegenError`）（v0.4.72 → v0.4.73）✅ 已完成

**起因（遗留表一行）**：`class CodegenError extends Error {}` 既无位置**字段**，消息里也无位置（`unknown superclass 'Nope' of 'A'`），而 `LexError`/`ParseError` 两者都有（`Lex error at 1:16: …`）——与 AGENTS.md §2.5「**所有**错误必须带行列号」直接冲突。全仓 **156 处**抛出点（`src/emit.ts` 148 + `src/symbols.ts` 8）。

**方案（先更正原遗留行的前提）**：原行写着「emit 层多数节点已带 token」——**实测不成立**：`ast.ts` 的 `Stmt`/`ClassMember` **完全没有**位置字段，emit 层手里根本没有 token。所以正确顺序是**先让 parser 盖位置、再让语义层取用**：

- **`ast.ts`**：新增 `Pos { line?; col? }`，`Stmt = (…联合…) & Pos`、`ClassMember = (…联合…) & Pos`（可选字段，手工构造的合成节点无需位置）。
- **`parser.ts`**：`parseStatement()` 拆成「取起始 token → 调 `parseStatementInner()` → 未盖章则盖 `line/col`」的薄包装 —— 这是**唯一**的语句汇聚点（顶层/块/循环体都过它）；`parseClassDecl` 的成员循环用 `markMember()` 盖成员起始 token（含修饰符与 `[metadata]`，故 `[WasmExport] public function f()` 报 **1:11**）。
- **`symbols.ts`**：新增**当前位置**（`genLine`/`genCol` + `setGenPos()`），`CodegenError` 的构造器**默认读当前位置**并在消息前加 `Codegen error at L:C: `（与另两层同形）；显式传参优先；位置未知时保留裸消息（不臆造位置）。settle 在 pass -1/0/1/1.5/2/3/4 各循环与成员循环里发布，`collect()` 另存 `classPos`（FQN → 位置）供「只见类名」的 `expandInheritance` 使用。
- **`emit.ts`**：`emitStmt` / `emitTopLevel` / 类与函数定义循环 / 成员循环发布位置；`emitTopLevel` 必须单独补（顶层语句**不**走 `emitStmt`，否则 `var b:* = new Nope();` 报不出位置）。
- **两处「读消息」的站点必须改用裸消息**（实测踩到）：`withLexical` 的降级回退用 `/^(undefined variable|undefined function) '/` **锚定**消息开头，前缀一来锚点失配 ⇒ `examples/with.as` 直接编译失败（`undefined variable 'a' at top level` 不再被转成 AIR 的运行时 #1065）；构造器参数重抛把消息再包一层 ⇒ 会**双前缀**。故新增 `codegenBareMessage(e)` 剥掉前缀，两处改用它（重抛同时显式传 `e.line/e.col`）。

**验收**：

- 18 个代表性命中（`temp/pos1.mjs`/`pos2.mjs`）：未知父类 `1:1`、循环继承 `1:1`、final 父类 `2:1`、接口未实现 `2:1`、实参多余/缺失 `2:1`、未知类 `1:1`、未知成员 `3:1`、`with` 不支持接收者 `2:1`、`[WasmExport]` 用于实例方法 **`1:11`**、非法 cast/is 目标 `2:1`、`delete`/`in` 不支持 `2:1`、未定义变量 `1:1`；**行号取语句自身**（第 4 行的 `extends Nope` 报 `4:1` 而非 `1:1`）。
- `test/unit/diagnostics.ts` 的 `unit: diagnostics/Codegen` 从 **6 → 15** 条：原 6 条钉子**翻转**为断言带前缀的消息 + `e.line/e.col` 字段；新增「行号是语句自身而非 1:1」「类成员错误指向成员行」「顶层初始化器错误带顶层行」「重抛消息只有一个前缀」「`codegenBareMessage` 剥离」「`with` 回退仍认得未定义变量错误（不再编译失败）」「**CLI 端到端**：`node src/index.ts bad.as` 退出码 1 且 stderr 含 `Codegen error at 4:1: unknown superclass`」「本组全部错误都带数字行列」。
- 全量 `npm test` **200 passed / 0 failed**（含被前缀打断后修复的 `examples/with.as`）。

**文档同步**：`README-CN.md` 版本号 v0.4.73 + 「当前限制」本条；`package.json` v0.4.72 → **v0.4.73**。

**遗留表**：**移出 1 行**（`CodegenError` 缺 `line`/`col`）。本阶段**无新例**——按 §2.7「负例只钉在 `test/unit/`」，本特性是**报错行为**，断言全部落在 `test/unit/diagnostics.ts`（含 CLI e2e），不新增 `examples/*.as`。


---

### 阶段一百零一：`DisplayObject.scale9Grid` 属性（目标 v0.4.74）

> **起因**：九宫格此前只有 SWC 烘焙一条**内部**路径（`DefineScalingGrid` → `_s9_*` → `as_render_nine_slice`），AS3 侧读 `o.scale9Grid` 报「未知成员」。遗留表登记时判断「`as_render_nine_slice` 已能消费 `_s9_*`，只需把 setter 写进去」——**方向对，但边界行为（校验时机、截断、抛错后是否保留、getter 的拷贝语义）必须实测**。

- **adl 51.4.1 实测口径**（`temp/s9probe/s9-result.txt`，两轮探针）：
  - 默认 **null**；`= null` 是**清除**，读回 null；
  - **存储截断为整数**（向零）：`(1.5,2.5,3.25,4.75)` → `1,2,3,4`；`(-1.5,-1.5,5.5,5.5)` → `-1,-1,5,5`；
  - getter **每次返回新的 `Rectangle`**：与传入实例不同（`g1 == r` false）、**两次读也互不相同**（`g1 == g2` false）；setter 是**拷贝**语义（事后改传入的 rect 不影响对象）；
  - **校验用未截断的原值，且严格要求「严格内含」**：`x > bounds.left && y > bounds.top && x+w < bounds.right && y+h < bounds.bottom`（两侧都是严格不等式）且 `w>0 && h>0`。反例（30×30、内容 (0,0)-(30,30)）：等于 bounds、贴左/上（`x==left`）、贴右/下（`right==30`）、越界、负坐标、零宽/零高、**无内容对象**（bounds 为空）全部抛 `TypeError #2004`；正例：`(1,1,5,5)`、`(24,24,5,5)`、`(23,23,6,6)`、`(1,1,28,28)`。**最易抄错的一处**：`(0.5,0.5,5,5)` **合法**（原值 0.5 > 0，读回 `0,0,5,5`）而 `(0,5,5,5)` 抛错 —— 两者截断后都含 0，说明**校验发生在截断之前**；
  - **抛错仍然存储**：catch 里读 getter 会拿到那个（截断后的）非法矩形（`THROW 2004 get=40,40,5,5`），且后续一次非法赋值会覆盖前一次的存值；
  - 内容偏移时内含是相对**内容 bounds**：内容 (10,10)-(40,40) 下 `(15,15,5,5)` 合法、`(10,10,5,5)`（贴内容自身原点）抛错。

- **实现**（`src/symbols.ts` + `src/emit.ts`，复用既有渲染路径）：
  - `symbols.ts`：`DisplayObject` 加 getter/setter `scale9Grid`（`dog`/`dos`，类型 `Rectangle`）。**没有**加 AS3 字段 —— `_s9x/_s9y/_s9w/_s9h` 是 `emitStructs` 里**逐行发射**的私有 C 槽，再加 AS3 成员会发射出第二份 `double _s9x;`（本阶段第一次尝试就踩到，已回退）。
  - `emit.ts`：`DisplayObject_get_scale9Grid`（`_s9_on` 为假 → `NULL`，否则 `Rectangle_new(...)` 造**新**对象）+ `DisplayObject_set_scale9Grid`（先 `_s9_valid = 0` 失效烘焙并释放 `_s9_image`，`null` 清两位；否则**先用原值**调 `as_do_s9_valid`、再把 `trunc()` 后的值写槽、最后 `if (!ok) as_throw(ArgumentError_new("Error #2004: One of the parameters is invalid.", 2004))`）。`as_do_s9_valid` 前向声明在访问器旁、定义在 `as_bounds_walk` 声明之后（与 `as_do_extents` 同处），走 `as_bounds_walk(o, 1, 1, ...)`（含描边，与 `getBounds` 口径一致）。
  - **新增私有位 `_s9_apply`**：把「**有网格**」（`_s9_on`，getter 报的）与「**照九宫格渲染**」（`_s9_apply`，渲染门读的）分开 —— 非法网格按 adl **仍然存储**（getter 必须报出），但不应参与九宫格重组。渲染门 `if (o->_s9_apply && (scaleX != 1 || scaleY != 1))`；SWC 烘焙路径改为同时置两位（`_s9_on = 1; o->_s9_apply = 1;`，实测 22 个缩放网格符号的生成码逐个数到 22 处），ctor 复位两位 ⇒ **SWC 渲染行为不变**。
  - 访问器与 SWC 绑定共用**同一批槽 + 同一个渲染器**，故不存在第二条九宫格实现。

- **验收**：新增 `examples/scale9grid.as`（40+ 条 `check()` 断言：默认/清除/拷贝语义/两次读不同/两轮截断/9 条非法集/抛错后保留/无内容对象/偏移内容/渲染位与存在位分离），输出 `scale9grid: all assertions passed`。
- `test/unit/display.ts` 新增 `unit: display/Scale9Grid`（**16 条源级钉子**：声明形状、无重复 C 字段、getter 造新对象、**先校验原值再截断**（顺序钉）、`trunc` 存储、存在位/应用位分离、**抛错在存储之后**（顺序钉）、`null` 清两位、四条严格不等式、退化尺寸与空 bounds、渲染门读 `_s9_apply`、SWC 绑定同时置两位、ctor 复位、反射 setter 的 `as_v_obj_val` 解箱、**真实生成 C**（`generateC`）中的访问器/助手/抛错/渲染门、示例 golden）。
- 全量 `npm test` **202 passed / 0 failed**（277s；较阶段一百的 200 增 2：新示例 `examples/scale9grid.as` + 新单测组 `unit: display/Scale9Grid`；`examples/swc-shape.as` 走 `--swc` 重新生成后仍通过 ⇒ SWC 九宫格路径无回归）。

**文档同步**：`README-CN.md` 版本号 v0.4.74 + 删除「`scale9Grid` 未实现」限制条目（改为已实现说明）；`package.json` v0.4.73 → **v0.4.74**。

**遗留表**：**移出 1 行**（AS3 `scale9Grid` 属性未实现），**新登记 2 行**（动态槽给对象型参数赋错类型**不抛 #1034** 而是静默取垃圾指针 —— 本阶段探针实测；`set` 作标识符被我们的 parser 拒绝 —— 探针副产物）⇒ 69 项（9 部分完成 / 59 未开始 / 1 暂缓）。

---

### 阶段一百零二：`ByteArray` 下标形式的完整语义（目标 v0.4.75）

> **起因**：遗留表登记「`ByteArray` **正越界读**」——`ba[i]` 此前只有「落在 `[0,length)` 时给字节」这一半：静态越界读给 `0`（而 `adl` 给 **`undefined`**），字符串键 `ba["0"]` 直接撞 `cannot convert string to int`，`*` 接收者的下标读写根本没有入口（动态槽走属性表 ⇒ `#1056`/`#1069`，而 AVM2 的**下标形式**不吃属性表）。实为「下标形式」整体缺失，正越界只是其中一个侧面。

- **adl 51.4.1 实测口径**（`temp/baidxprobe/ba-result.txt`，21 行逐行比对；另有 `za-result.txt` 属性表 5 行、`wa-result.txt` 写入值 8 行）：
  - **区间内**：`b[0]` = 65、`typeof` 为 `"number"`、`is int` / `is Number` 皆 true、`b[0] + 1` = 66；
  - **正越界读 = `undefined`**（不是 0、不抛错）：`b[3]`（len=3）/`b[9]`/`b[1000000]` 一律 `undefined`，`== null` true、`=== undefined` true、拼字符串得 `"undefined|"`；
  - **负索引抛 `#1069`**（属性查找 miss）——下标形式**未**变成数组式访问；
  - **字符串键按键的规范下标文本判定**：`"0"`/`"2"` 是下标（65/200），`"00"`/`"1.5"`/`" 1"`/`"-1"`/`"zz"` **不是**（一律 `#1069`）；而**非下标键走真实属性表**：`b["length"]` = 3（访问器赢，不是 `#1069`）；
  - `*` / `Object` 接收者同语义（`d[3]` = undefined、`d[-1]` → `#1069`）；`o["zz"]`/`o.zz`/`d["zz"]` 都抛 `#1069`（sealed 类的动态 miss），但 `o[9]` 是 `undefined`（下标形式）；
  - **写**：`b[5] = 7`（静态）**扩展** buffer、间隙零填充（len 6、`b5=7`、`b3=0`）；动态写 `d2[3] = 5` **也扩展**；动态**非下标键** `d2.zz = 1` → `#1056`；
  - **写入值走 AS3 的 ToNumber，且装箱字符串会被解析**：`"5"`→5、`300`→44、`-1`→255、`true`→1、`null`→0、`1.7`→1、`"x"`→0（**静态与动态两条路都实测**）；
  - **`in` 按下标范围**：`"0" in b` true、`"9" in b` false（不是属性表）；`"length" in b` true；
  - **`delete b[0]` = `false` 且不抛**（静态与动态同）；`*` 接收者的 `.length` 仍是 buffer 长度。

- **实现**：
  - `src/emit.ts`：`ByteArray_get_index` 返回类型 `int` → **`as_value`**（负索引 `#1069`、越界/无 buffer → `as_v_undefined()`、否则 `as_v_num(低字节)`）；新增 `as_ba_str_index(char* k)`（规范下标文本：空 / 前导零 / 非数字 / 超 `INT_MAX` → -1）与 `ByteArray_get_index_key`（非规范键 → `as_throw_sealed_get`）。
  - **静态字符串键读改走 `as_dyn_get`**（而不是直接进下标助手）：必须先过真实属性表，否则 `b["length"]` 会被当成下标（实测就是 `#1069`）；`as_dyn_get` 的 ByteArray 钩子只在 props/getters/methods 遍历 miss 之后触发，正好给出「`"zz"` → `#1069`、`"0"` → 下标」。
  - `src/runtime.ts`：新增 5 个钩子（`as_ba_is_hook` / `as_ba_get_key_hook` / `as_ba_set_key_hook` / `as_ba_has_key_hook` / `as_ba_len_hook`）+ `as_dyn_get/set/has` 三处分派（都在 props 遍历**之后**、sealed 抛错**之前**），`as_any_length` 加 ByteArray 分支（`.length` 直发 `as_any_length`，绕过 `as_dyn_get`）。类体在 runtime 之后发射，故运行时只能经钩子间接调用（与 Vector 钩子同一模式）；`as_ba_wire()` 在 `main` 里无条件调用（`ByteArray_vt` 始终发射）。
  - **修掉两个顺带发现的缺陷**：①`delete <*>[key]` / `delete <*>.prop` 此前按**记录**（`as_object_del`）解引用 —— 装箱的是**类实例**时把实例当槽表读 → **段错误**；现改走 `as_dyn_del`（记录槽 → 删槽，sealed 类 → false，Proxy → `#2092`），`delete d[0]` = false 与 `adl` 一致；②`ByteArray` 下标**写**的装箱值此前用 `as_v_num_val`（取 box 的数字槽 ⇒ 字符串给 0），现静态路（`any` 操作数）与动态钩子都走 `as_v_to_number` ⇒ `ba[0] = "5"` 写 5（实测）。
  - **返回值类型 `any` 的消费点**：`emitIndex` 的 ByteArray 分支结果类型改 `{ kind: 'any' }`，故 `b[0] + 1` / `trace(b[3])` / `b[3] == undefined` 全走动态路径（与 `adl` 一致）。

- **验收**：新增 `examples/bytearray-index.as`（50+ 条 `check()`：区间内/is/typeof/越界 undefined 四连/负索引与非规范键 5 条 `#1069`/动态接收者/Object 接收者/静态与动态写扩展零填充/`#1056`/8×2 条写入值 ToNumber/`in` 范围/`delete` 恒 false/属性表不退化），输出 `bytearray-index: all assertions passed; len=3 b2=200`。
- `test/unit/bytearray-amf.ts` 新增 `unit: bytearray-amf/IndexForm`（**17 条源级钉子**，全部对**真实**生成码复核：`temp/bapins/pins.c`）：reader 返回 `as_value` 的三分支、`as_ba_str_index` 的规范判定逐行、非规范键 `#1069`、静态数值下标 → `ByteArray_get_index`、静态字符串键 → `as_dyn_get`（且**不再**出现 `ByteArray_get_index_key((void*)` 直调）、装箱写值 `as_v_to_number` vs 静态 `((double)(7))`、`delete b[0]` → `((void)(b), false)`、`delete d[0]` → `as_dyn_del(as_v_obj_val(d), as_str_from_int(0))`、`as_any_length`/`as_any_get` 的 `*` 路径、`as_ba_wire` 五钩子 + `main` 调用、示例 golden；并把 `ByteArraySurface` 里钉旧行为（越界 `return 0`）的那条**翻转**为 `return as_v_undefined()`。
- 全量 `npm test` **204 passed / 0 failed**（较阶段一百零一的 202 增 2：新示例 `examples/bytearray-index.as` + 新单测组 `unit: bytearray-amf/IndexForm`）。

**文档同步**：`README-CN.md` 版本号 v0.4.75 + 内建行；`package.json` v0.4.74 → **v0.4.75**。

**遗留表**：**移出 1 行**（`ByteArray` 正越界读），**新登记 3 行**（动态值 `as <原始类型>` 应给 **null**；装箱字符串参与**算术/比较**未走 ES3 ToNumber；静态 `String` 与 `Number` 混算发射非法 C）⇒ 71 项（9 部分完成 / 61 未开始 / 1 暂缓）。

---

### 阶段一百零三：`TextField.getLineMetrics` + `flash.text.TextLineMetrics`（目标 v0.4.76）

> **起因**：遗留表登记「`TextField.getLineMetrics(index)` 未实现」—— AIR 侧阶段九十四·二十 的**所有** ascent/descent/leading 数值都靠它取，我们只能拿 `textHeight`/`numLines` 间接核对。登记时判断「六个字段全部可由现有段落行表导出」（**方向对**），但行盒之外还有三处非平凡：越界语义（抛错还是 `null`）、`leading` 的分摊、`x` 的对齐口径 —— 全部实测后才敢写。

- **adl 51.4.1 实测口径**（`temp/metricprobe/`：`metric6-adl.txt` 22 例逐行、`lead7-adl.txt` leading 矩阵、`align6-adl.txt` 对齐矩阵）：
  - **越界索引抛 `RangeError #2006`**（`Error #2006: The supplied index is out of bounds.`）—— `index == numLines`、负数、远超范围一律抛，**不是返回 null**（**推翻**阶段九十四·二十 时「返回 null」的猜测）；
  - **空字段仍是 1 行**：`numLines` 1、`textHeight` 0、`textWidth` 0，`getLineMetrics(0)` 报默认格式的字体度量（`_typewriter` 12 → `12/3/0/h15/w0/x2`，宽 0），`getLineMetrics(1)` → `#2006`；
  - `ascent`/`descent` = 该行**字体设备度量**，**与 leading 无关**（leading 0/4/10/−3 全为 `12/3`），二者之和等于行高；
  - `leading` = `TextFormat.leading`，**每一行（含末行）都算**；`height = ascent + descent + leading`（−3 时 `h12 < asc+desc`）；**AIR 自己的 `textHeight` 与各行 `height` 之和不一致**（leading=4 的两行字段 `th=34`，而两行 `height` 都是 19 ⇒ 尾行 leading 不计）；
  - `x` = 行的左偏移 = **2px 文字内边距** + **逐行**对齐偏移（200px 字段居中 → 89/75、右对齐 → 176/147.5、justify → 2/2；`wordWrap=true` 宽 60 + 居中 → 5/5）；`width` = 该行前进宽（`abc` 21.5 / `defgh` 36），`textWidth` = 最大行宽；
  - `new TextLineMetrics(x, width, height, ascent, descent, leading)` 构造器可用、**六字段可写**、`toString()` = `[object TextLineMetrics]`。

- **实现**（`vendor/skia_glue.cc` + `src/runtime.ts` + `src/symbols.ts` + `src/emit.ts`）：
  - `vendor/skia_glue.cc`：`SkAirLineMetrics` 补 `asc`/`desc` 两字段（`round_half(-fAscent)` / `round_half(fDescent)`，`model` 改为二者相加）；新增 **`sk_textlayout_line_box(para, idx, leading, family, size, bold, italic, &asc, &desc, &left, &width)`** —— 有行盒时按**基线步长**反推拆分（`stride = (n>1) ? (lm[n-1].fBaseline - lm[0].fBaseline)/(n-1) : Paragraph::getHeight()`、`asc = fBaseline - idx*stride - leading`、`desc = stride - leading - asc`），**负 leading 改用 AIR 面度量**（Skia 把 `StrutStyle::leading < 0` 钳成 0 并折进盒高，实测拆分漂移到 12.6/2.4），**空段落回退到默认格式的 AIR 面度量**（空字段的幽灵行）。
  - `src/runtime.ts`：`sk_textlayout_line_box` 的 `extern` 声明 + **Skia / 无 Skia 两处内联桩同步**（无 Skia 时全 `(void)` 返回 0）。
  - `src/symbols.ts`：新增 `TextLineMetrics` 类（六个 `number` 字段 + 六参 ctor + `superClass: 'Object'`；typedef/struct/vtable/props 表与 TextField vtable 槽由通用机制自动发射），`TextField.methods` 加 `getLineMetrics(index:int) -> TextLineMetrics`。
  - `src/emit.ts`：`TextField_getLineMetrics`（`as_tf_line_table` 取行数 → 越界 `RangeError_new(#2006)`；`lead` 取自 `defaultTextFormat` 且**不钳位**；`x = 2.0 + left` 再按**逐行**加对齐偏移（`inner = _fieldWidth - 4.0`，`a==2` 居中 / `a==1` 右对齐；**换行字段交给 Skia 自己对齐**故加守卫）；`return TextLineMetrics_new(x, w, asc + desc + lead, asc, desc, lead)`）+ `TextLineMetrics_ctor`/`_new`（GC 堆分配）。**顺带修** `TextField.textHeight`/`textWidth` 的空字段口径：此前空文本分别返回 15 / **−FLT_MAX**（`as_skia_textlayout_height` 给 strut 盒、`getLineMetrics` 给 0 行），现在两条构建路径都返回 0，与 AIR 的 `th=0 tw=0` 一致。
  - **对齐用「逐行」而非画家的「整块」**：`getLineMetrics.x` 走 `as_tf_align_index` + **本行**宽度；painter 仍用 `as_tf_align_dx`（按最宽行整块平移）—— 后者是**渲染侧**的既有偏差（多行居中时短行偏 ~14px），单独登记（见下），不污染行度量。

- **验收**：新增 `examples/textline.as`（40+ 条 `check()`：ctor 六参顺序与可写、空字段 1 行 / `th=0` / `tw=0`、越界与负索引 `#2006`、两行 `height = asc + desc + lead`、leading 逐行计入、负 leading 折进高度、左侧 2px 内边距、重复调用一致；**字体度量侧用 `if (l0.ascent > 0)` 分支** ⇒ 默认**无 Skia** 回归与链 Skia 的构建**都通过**），输出 `textline: all assertions passed; lines=2 h=15 lead4h=19`（Skia）/ `lines=2 h=0 lead4h=4`（纯 C 桩）。
- `test/unit/display.ts` 新增 `unit: display/LineMetrics`（**27 条源级钉子**，全部对真实生成码 `temp/tlpins/tl.c` 复核）：符号面（六字段 / 六参 ctor / 返回类型）、越界 `#2006`、`lead` 取自 `defaultTextFormat` 且**函数体内无钳位**（按函数体切片核对，避免与 `textHeight` 纯 C 分支的钳位混淆）、line_box 实参、`x = 2.0 + left`、**逐行**对齐（且体内**不出现** `as_tf_align_dx`）、换行守卫、`TextLineMetrics_new` 实参顺序、ctor 赋值顺序、`gc_alloc(GCT_CLASS)`、vtable/props/动态 shim 三条、glue 的签名 / 空字段回退 / 步长拆分 / 负 leading 分支 / left-width 输出、runtime 的 extern 与**两处**桩、`textHeight`/`textWidth` 空字段守卫、示例的 `#2006` / 逐行 leading / 负 leading / 无 Skia 分支。
- **Skia 侧逐行对照**：`Lead7Aot` vs `lead7-adl.txt` **8/8 行完全一致**；`Align6Aot` vs `align6-adl.txt` 居中 89.2/74.8（Δ0.2）、右对齐 176.4/147.59（Δ0.4/0.09）、justify 2/2、wrap60 居中 4.796（Δ0.2）；`Metrics6Aot` vs `metric6-adl.txt` 的构造器 / `#2006` / 空字段（`12/3/0/h15/w0/x2`）全对，余差仅为字体前进 ≤0.01px（`21.6 vs 21.5`、`36.01 vs 36`）、`_sans` 行高、Monaco 20px 行高、富文本两处、wrap60 软换行断点 —— 均属已登记的「设备字体表 / 半像素取整」家族（见下）。
- 全量 `npm test` **206 passed / 0 failed**（较阶段一百零二的 204 增 2：新示例 `examples/textline.as` + 新单测组 `unit: display/LineMetrics`）。

**文档同步**：`README-CN.md` 版本号 v0.4.76 + 新 bullet（含已知未对齐项）+ 示例清单条目（并把「字体度量（阶段九十四·二十）无 `examples/` 单元」一条改为**已有**）；`package.json` v0.4.75 → **v0.4.76**。

**遗留表**：**移出 1 行**（`TextField.getLineMetrics` 未实现），**新登记 6 行**（富文本 run 空隙样式；混合字号行盒整段统一；painter 多行**整块**对齐；`TextFormat` 字段/ctor 子集；`null` 实参发射非法 C；文档指向的 Skia 示例清单已不能构建）⇒ **76 项**（9 部分完成 / 66 未开始 / 1 暂缓；71 − 1 + 6，按表内实际行数复核）。

---

### 阶段一百零四：Stage3D **按帧合批**——干掉逐 `drawTriangles` 的 GPU 往返（目标 v0.4.77）

> **起因（用户报障）**：`examples/air-starling-demo` 打开 Starling 自带的 fps 监控（`Starling.showStats`，绿色 stats box）后 **CPU 22% → 44.3%**，同一台机器上 Benchmark 场景的收敛峰值对象数从 ~42800 掉到 ~36700（**−14%**）。问题：是文本渲染费 CPU，还是别的？

- **adl 侧不可达**：`showStats` 是 Starling 的内部开关（`StatsDisplay` + `BitmapFont.MINI`），AIR `adl` 里同样可开，但**本阶段的判据是「我们自己的后端把 Starling 的一帧做了什么放大」**，故全程用 AOT 产物自比（开/关两条曲线），不涉 `adl` 语义。
- **实测（`temp/fpsstats/`）**：
  - **文本渲染被排除**：两份 `sample` 火焰里 `sk_textlayout`/`BitmapFont`/`TrueType`/`uploadFromBitmapData`/`drawText`/`Glyph` 采样**全为 0** —— box 每 0.5 s（`UPDATE_INTERVAL`）才重排一次文本，逐帧只多 2 个 `TextField` + 1 个 `Quad` 的 `addMesh`。
  - **「重复上传场景大顶点缓冲」假说也被否**：给 `s3d_draw` 加 `verts/draw` 探针后，等对象数（≈32.5k）下每帧顶点总流量两路**几乎相同**（OFF `4.16×51758 = 215k`、ON `5.80×37265 = 216k` verts/帧）。
  - **真差异是 draw 数 × 每条 draw 的 GPU 往返**（等对象数 ≈32.5k）：draw/帧 **4.16 → 5.80**、`wait/draw` **0.48 → 0.42 ms**、每帧阻塞 **2.00 → 2.44 ms**；`ASC_S3D_STATS` 的 `cpu=0.01ms` 两路相同，而 `gpu=0.04ms/draw` 远小于 `wait≈0.5ms/draw` ⇒ 那 0.5 ms 是**纯往返延迟**（CPU/GPU 被 `waitUntilCompleted` 串行化），不是 GPU 吞吐。
  - **每帧 CPU 成本曲线**（`run_cpu_per_frame.py`，用 `ps -o time=` 逐 0.2 s 采样、阻塞不计入）：OFF ≈ **2.1 ms 基础 + 0.17 µs/对象**（管线 CPU 受限）；ON 同对象数下高出 ~100 µs@2.5k → ~1000 µs@27.5k，即**箱子让每对象成本升 15~20%**。
  - **Starling 侧机制**：`StatsDisplay.render()` 每帧 `painter.excludeFromCache(this)` + `finishMeshBatch()`。`excludeFromCache` 沿祖先链把 `_tokenFrameID` 置 `0xffffffff`（`DisplayObject.as:678`），于是 `DisplayObjectContainer.render()` 里「上一帧 token 未变 → 整棵子树 `drawFromCache()` 一次 `addMesh` 回放」的快路径对箱子失效 ⇒ 箱子必须**每帧 live 重批**，`finishMeshBatch()` 又打断批次 ⇒ **+1.6 draw/帧**。
  - **本后端把每 draw 成本放大 ~5 倍**：`s3d_draw` 原来**每条 `drawTriangles` 都新建 `MTLCommandBuffer` → `commit` → `waitUntilCompleted`**，且每条 draw 新建一个 render pass ⇒ CPU/GPU 全串行；AIR 的 `drawTriangles` 是同帧合批提交，多几条 draw 的边际成本远小于此。
- **实现（按帧合批）**：
  - `vendor/stage3d_glue.mm`：`S3DContext` 新增 `batch`（一条**跨整帧**的 `MTLCommandBuffer`）。`s3d_draw` 首条 draw 时 `[[c->queue commandBuffer] retain]` 开批（+1 由 flush 释放），后续每条 draw 只**追加**一个 render pass/encoder（逐 draw 的清屏/加载语义、深度模板附加、管线/绑定逻辑**一字未改**），**不再 commit/wait**。新增 **`s3d_flush(ctx)`**：提交并 `waitUntilCompleted`（每帧**唯一**同步点，也是 `ASC_S3D_STATS` 里 `wait=/gpu=` 的记账点）＋ **`s3d_flush_all()`**（遍历 live-context 注册表）。
  - **为什么推迟等待是安全的**（已写进注释）：所有上传（`newBufferWithBytes`/`newTextureWithDescriptor`）都是**新建对象**而非就地改写，且 **command buffer 会 retain 它引用过的每个资源直到完成** ⇒ 帧内释放 context 自己的 +1 不会提前释放 GPU 还在读的内存；pass 之间的读写冒险由 Metal 在同一条 command buffer 内自动插入屏障（mask/stencil、render-to-texture 的「写后采样」因此仍然正确）。
  - `s3d_flush` 的**调用点**：`s3d_readback`/`s3d_readback_render`（CPU 要读像素）、`s3d_resize`/`s3d_destroy`（要换/销毁目标）；生成 C 侧在 `Context3D_present`（`as_s3d_flush`，保 AIR「present 返回即完成」契约）与 **`ASC_window_render` 开头**（`as_s3d_flush_all`，Skia 开始合成渲染目标**之前**）——后者是关键：无论 draw 是从 `ENTER_FRAME`、鼠标回调还是定时器发出的，合成器看到的都是**GPU 写已完成**的目标，和旧的逐 draw 等待等价。
  - `src/runtime.ts`：`as_s3d_flush`/`as_s3d_flush_all` 包装（纯 C 构建编译为空）；`src/emit.ts`：两处调用点。
  - `vendor/stage3d_webgl.cc`：补 **`s3d_flush`/`s3d_flush_all` = `glFlush()`**，保持两端 `s3d_*` ABI 一致（GL 本来就没有逐 draw 等待——`glDrawElements` 只入队，读回/上屏各自隐含同步）。
- **验收**：
  - **容量**：Benchmark 峰值对象数（`ASC_FRAME_STATS=1` + `bench-auto`，各跑两轮）ON/OFF 由 **36752 / 42832（−14.2%）** 变成 **55600 / 59408** 与 **55376 / 58352**（**−6.4% / −5.0%**，两轮极差 ≤1.8%）；即**修掉了约六成的差距**。
  - **等对象数逐点对照**（`BENCH obj=` 曲线插值）：两路每帧 fps 差落在 ramp 控制器噪声内（\|Δ\| ≤ 0.3 ms/帧，无系统性缺口）。
  - **探针**：`draws/batch` **7.0（OFF）/ 9.0（ON）**（合批生效）、`wait` **0.91~0.93 ms/帧**（原为 0.48 ms × 7 ≈ **3.5 ms/帧**）、`gpu` **0.34 ms/帧**（整帧 GPU），`cpu` 仍 0.01 ms/draw。
  - **回归**：`node test.ts` **206 passed / 0 failed**；12 个场景全量扫一遍（`temp/hidpi/sweep_aot.py`）全部存活且画面正确；重点路径按图核验：**Filters 的 Switch Filter**（`aot_filters.py`，Identity→Blur→Glow，render-to-texture 多 pass + 写后采样）正常、**Sprite3D**（3D 立方体六面纹理）正常、**Benchmark**（对象隧道 + `draw calls`/120 fps 读数）正常、**RenderTexture/Masks/TextFields** 正常。
  - **踩坑（顺带修）**：`temp/hidpi/rebuild.sh` 已过期（缺 `-liconv`），而 **`ld` 失败会删掉输出文件**——探针轮曾把 `examples/air-starling-demo/Starling-Demo` 弄没，已用原版 `.o` + `-liconv` 重链恢复；本轮改走官方路径 `node src/index.ts --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo` 全量重建。
- **已知残留（已登记遗留表）**：① 尾差 6.4% 主要来自 **jitter**（ON 侧 `p99` 20~22 ms vs OFF 11.6 ms，ramp 控制器因瞬时抖动提前停止加对象），而**整帧 GPU 只占 0.34 ms / 8.33 ms（4%）** ⇒ 把逐 draw 的 render pass 并成「每帧一个 pass」的收益上限仅 ~0.2 ms，故**不做**；② `wait 0.93 ms` 里约 **0.6 ms 是每帧一次的提交往返延迟**，它存在的唯一理由是 **Skia 的 `g_queue` 与 Stage3D 自己的 `newCommandQueue` 是两条队列**——若共用 `metal_glue.mm` 那条进程级 `g_queue`，Metal 的「同队列按提交序执行 + 跨 command buffer 冒险跟踪」即可免掉这次等待（≈7% 帧预算），属跨模块架构改动，另立一行。

**文档同步**：`README-CN.md` 版本号 v0.4.76 → v0.4.77 + 新 bullet；`package.json` v0.4.76 → **v0.4.77**。

**遗留表**：**新登记 1 行**（Stage3D 与 Skia 共用 command queue 可省掉每帧一次提交往返）⇒ **76 项**（9 部分完成 / 66 未开始 / 1 暂缓）。

---

### 阶段一百零五：parser 两处硬缺陷——包内数字元数据**死循环** + `at()` 只比 value **不比 kind**（目标 v0.4.78）✅ 已完成

> **起因**：评估 `talkmed-meeting-desktop-app`（AIR 桌面壳）能否用本编译器构建时，报出两处与语言子集无关的 **parser 硬缺陷** —— 其中一处让工程**入口 `src/Main.as` 解析时永不返回**（CPU 打满、>600 s），即**编译这个工程连第一步都过不去**。两处都是通用缺陷（影响面远超该工程），故单独立阶段修掉（报告：`talkmed-meeting-aot-gap-report-v2.md` §1）。

- **缺陷 1：包体内 `[SWF(...)]` 用不带引号的数字实参 ⇒ 死循环**。触发形态 `package { [SWF(frameRate = 60, backgroundColor = "0x000000")] class A {} }`（`Main.as:105` 即此形）。根因两段：① `parseMetadataIfPresent`（`parser.ts:343`）只收 `str`/`ident` 实参，遇到 `num` 抛 `ParseError` 并**回滚** `pos`；② `parsePackage`（`parser.ts:213`）的 `[` 分支在回滚后**没有任何分支消费这个 `[`**，`while` 原地空转。换 `[SWF(a = "1")]`（字符串值）则正常 —— 这正是此前没被发现的原因。
- **修法（根因 + 哨兵）**：① 元数据实参改收 `num`（Flash 元数据本来就允许 `[SWF(frameRate = 60)]`），数字值按原始文本记入 `args`；② `parsePackage` 的循环体加**推进哨兵** —— 每轮记 `pos`，分支跑完后若 `pos` 未变即抛带位置的 `ParseError`（`unexpected token '[' in package body`），把「静默挂死」变成「可定位的语法错误」（AGENTS.md §2.5：**永不挂死、永不吞错**；挂死比报错难诊断得多）。
- **缺陷 2：`at()` 只比 `value` 不比 `kind`**（`parser.ts:80`）。token 的 `value` 不是身份：字符串字面量 `"]"` 的 value 与 `]` 符号**同为 `"]"`** ⇒ `[ "]" ]` 被当成空数组提前闭合（`[ "[" ]` 只是**碰巧**对）。真机命中 `src/com/worlize/websocket/WebSocket.as:178` 的标点分隔符表 `[ "(", ")", …, "[", "]", "?", … ]`（报 `expected identifier but found '?'`）。
- **修法**：`at()` 按字面量推出**应匹配的 kind** —— 词形态（`function`/`package`/`var`…，本词法器无独立 keyword kind，一律 `ident`）比 `ident`，其余比 `symbol`；非符号字面量（`str`/`num`/`regex`/`eof`）不再可能冒充分隔符。审计过全部 `at(...)`/`expect(...)` 调用点：实参只有符号与标识符两类，无一处依赖旧的宽松比较。
- **实测（工程闭包 341 文件，逐文件 5 s 硬超时）**：
  - **修复前**：OK **312** / ERR **28** / **HANG 1**（`src/Main.as`）；其中 ERR 有 2 条是 `_lib_/ActionScript-Lib/...` 的路径漂移 ENOENT（**实质解析失败 26**）。
  - **修复后**：OK **314** / ERR **27** / **HANG 0**（实质解析失败 **25**；ENOENT 仍 2）。
  - **逐文件对照（pre-fix parser 副本 vs 修复后，`temp/tkmeet-survey/diff-parsers.ts`）**：仅 **2 处状态变化** —— `src/Main.as` HANG→OK、`com/worlize/websocket/WebSocket.as` ERR→OK；**零处 OK→ERR**（另 2 处为 ENOENT 消息截断差，状态不变）。
  - 顺带修正报告 v2 的一处**归因错误**：`BigInteger.as` 的失败**不是** E4X `..`（该文件没有 `..`），而是 `y.(y.t++, 0)` 撞上 E4X 过滤谓词分支 `expect('@')`（真缺口是「逗号运算符 + 把 `.(` 当 E4X 过滤」）；真 `..` 命中的是另 4 个文件（`WorkerBase`/`WorkerManager`/`BaseModel`/`JSONEncoder`）。该文件修复前后同状态同文案，故不计入变化。
- **验收**：`node test.ts` **209 passed / 0 failed**（原 206）。新增回归：`examples/swf-metadata.as`（端到端：`package {}` 体内数字 `[SWF]` 元数据 + 标点字符串表逐项断言，**修复前该示例会挂死**）、`test/unit/parser.ts`（`parser/MetadataBrackets` 5 条 + `parser/SymbolVsString` 8 条 AST 结构钉）、`test/unit/diagnostics.ts` 新增哨兵负例（`Parse error at 1:11: unexpected token '[' in package body`）。
- **文档同步**：`README-CN.md` 版本号 v0.4.77 → v0.4.78 + 新 bullet；`package.json` v0.4.77 → **v0.4.78**。
- **遗留表**：**无移出、无新登记**（两处缺陷此前未入表；既有行「`[SWF(width,height,backgroundColor)]` 元数据被解析后**丢弃**」是**另一条**欠账 —— 本阶段只让数字实参**可解析**，元数据仍按原样丢弃，`stage.stageWidth/Height` 的保真问题不动）。⇒ **76 项**（9 部分完成 / 66 未开始 / 1 暂缓）。

---

### 阶段一百零六：talkmed-meeting 语言层缺口 13 项落地 + AIR 值日志对照（目标 v0.4.79）✅ 已完成

**起因**：`talkmed-meeting-aot-gap-report-v2.md` §2 列出 **13 项 AIR 合法、我们拒绝**的语言层缺口（逐项都用 `mxmlc 51.4.1` 验证过合法性），外加评估途中命中的第 14 项（类体裸语句）。本阶段一次落地，并给这批特性建一座 **AIR 值日志裁判台**。

- **落地内容（14 项）**：`??`（优先级 0、短路、左侧仅在必要时提升为装箱临时量）；E4X 后代轴 `x..name`/`x..*`（新增 `Descendants` 节点 + `as_xml_descendants`/`as_xml_list_descendants`，前序、**不含自身**）；E4X XML 字面量 `<a b="1">…</a>`（lexer 递归扫描：name-stack 配平、注释/CDATA/PI/属性、`{expr}` 插值**响亮拒绝**）；`interface I extends A, B`（父接口方法**传递合并** + 环检测 + `unknown parent interface` 报错）与 `implements A, B`；多分支 `catch (e:A) … catch (e:B)`（按源码顺序 `as_is` 匹配、命中即清 `as_exception`、都不中则重抛，7 处 `case 'Try'` 遍历点全部改齐）；对象字面量**数字键** `{0:"a"}`；**省略参数类型**（按规范默认 `*`）；类体 `{...}` 静态初始化块 + **类体裸语句**（第 14 项，真机命中 `TweenMax.as:297`；只在**未读任何修饰符**时接受，`public 3;` 仍是精确报错）；类体内 `import`（容忍并忽略）与多余 `;`；**逗号运算符** `(a, b)`（最低优先级；实参/数组/形参等分隔符上下文改走 `parseAssignment`）；`get`/`set` 可作普通标识符。
- **AIR 裁判台（`temp/langair/`，README 写在本目录）**：同一份 `cases.as`（47 行**值日志**、无断言）在两端各跑一次逐行 `diff` —— AOT 侧 `node src/index.ts … --run`，AIR 侧 `mxmlc` + `adl`（`LangAir.as` 把日志写 `/tmp/langair_adl.txt`；`cases.as` 被拆成每个定义一个文件，因为 AS3 **不允许嵌套类**、且一个包文件只能有一个外部可见定义）。**唯一分歧**：`5.desc-any` 我们 **2** / AIR **4** —— `<items><item id="1">a</item><item id="2">b</item></items>` 的 `..*` 在 AIR 把**文本节点**也计入（2 元素 + 2 文本节点）；同一结构换成自闭合元素（无文本）两端**都是 2**，这条对照把差异**精确隔离到文本节点**上。该裁判台还**推翻**了「类体静态初始化按源码交错」的直觉（`10.order=abBU`：**先**跑静态字段初始化器（声明顺序），**再**按源码顺序跑类体语句块；`10b.block-before-field=cX` 佐证），并逐字确认 `??` 的短路与假值穿透（`0`/`""`/`false` 不回落）、接口 `is`/`as` 的双向判定、多 catch 顺序、数字键、逗号运算符、`for` 多声明量作用域、类体 `import` 等 46 行。
- **顺带修掉的正确性缺陷（实测发现，非增强）**：① vtable 结构体元数据成员 `name` 与**同名方法槽**重名（`class Both { function name():String … }` 发射 `…->vtable->name(...)` ⇒ `called object type 'const char *' is not a function or function pointer`），元数据统一改名 `cls_name`/`cls_super`/`cls_ifaces`/`cls_props`/`cls_methods`/… （布局不变，`as_vtable_header` 仍按偏移 0 读类名）；② 接口 `is`/`as` 的**静态折叠不健全**（`IA` 引用实指 `Both` 时 `x is IB` 被折成编译期 `false`）——改为运行时 `as_iface_lookup` + 新助手 `as_v_is_iface`，失败的 `as` 给 `{NULL, NULL}` 以保证 `!= null` 判定正确；③ `for (var c:int = 0, c2:int = 9; …)` 的**多声明量**既未进脚本变量表也未提升（`Codegen error: undefined variable 'c'`）——按 AS3「for-init 的 `var` 是函数作用域」（`mxmlc` 实测）决定提升；④ `??` 的操作数被**重复求值**（`(f() ?? 5) == 5` 调用 `f()` 两次）——`sequenceValueExpr` 顶部加 `hoistedAssigns` 幂等哨兵；⑤ `for` 的 init 表达式按**值上下文**（丢弃值）排序，去掉一个 `-Wunused-value`。
- **词法顺带修复**：**CR 行终止符**。AS3 的行终止符是 LF / CR / CRLF（`mxmlc` 实测能编 CR-only 文件），而我们的 `//` 注释此前只在 LF 结束 ⇒ 工程里 `src/com/vsdevelop/air/download/DownLoadManage.as`（**301 个 CR、0 个 LF**）的第一条 `//` 注释吞掉整个文件后报 `expected '}' but found '<eof>'`。现 `advance()` 认 CR 且把 CRLF 记为**一次**换行（否则 Windows 行尾的源文件行号会翻倍），注释循环认两种终止符；回归钉在 `test/unit/lexer.ts` 的 `lexer/LineTerminators`（9 条）——**刻意不做成 `examples/*.as`**：被测属性是**输入字节**的行尾形态，签入的示例文件可能被编辑器/VCS 规范化而让回归变成空转。
- **实测**：`node test.ts` **211 passed / 0 failed**（新增 `examples/lang-superset.as` 端到端断言示例 + 上述单测组）。工程闭包（`closure3.txt`，**709 文件**）逐文件解析 **705 OK / 4 ERR / 0 HANG**（本轮前 703/6；`TweenMax.as` 与 `DownLoadManage.as` 转 OK，**零回归**）；余 4 条 = 2 条一般 E4X 过滤谓词（`JSONEncoder.as:279`、`BigInteger.as:526`）+ 2 条源码路径漂移 ENOENT（`_lib_/ActionScript-Lib/...`）。整闭包 codegen 已推进到新墙 `unknown superclass 'mheader' of 'cn_edoctor_view_meeting_HeaderView'` —— `mheader` **不在工程任何 `.as` 里**，它是 `lib/skin.swc` 的 **SWF 库符号**（catalog `<script name="mheader">`，依赖 `flash.text:TextField`）⇒ 属**结构性**（SWC 库符号作基类）欠账，不是语言层。
- **残留（已登记进报告，均不属本阶段 13 项）**：`..*` 不计文本节点；一般 E4X 过滤谓词 `.(<expr>)`（只支持 `.(@attr ==/!= value)` 形态）；**省略返回类型仍按 `void`**（规范是 `*`，但改成 `*` 会把今天**响亮的 C 层错误**变成静默 UB，且 709 文件里对「省略返回类型 + 有值 `return`」的依赖实测 **0 处**）；非 `void` 函数的**落空路径**没有默认返回（既有 UB / `-Wreturn-type`，8 处近同发射点）。
- **文档同步**：`README-CN.md` 版本 v0.4.78 → **v0.4.79**（支持子集表补 `??`/逗号/后代轴/XML 字面量/多 catch/接口多继承/类体语句/省略参数类型/`get`·`set` 标识符/数字键，新增阶段 bullet）；`package.json` v0.4.78 → **v0.4.79**。
- **遗留表**：**移出 1 行**（`set`/`get` 作标识符被拒 —— 本阶段已落地）、**改写 1 行**（`Proxy.getDescendants` 不可达：`..` 语法已落地，剩下的是「`..` 作用于 Proxy 接收者」的分派，今日是**响亮** `CodegenError("'..' requires an XML or XMLList value")`）、**新登记 0 行**。⇒ **75 项**（9 部分完成 / 65 未开始 / 1 暂缓）。

---

### 阶段一百零七：`--air-app` 描述符读取器**剥 XML 注释**（目标 v0.4.80）✅ 已完成

**起因**：为 Stage3D / 增强 E6「原生着色器直通」建 AIR 参照基线时，给 `examples/away3d-core` 写了 adl 启动脚本，并把描述符**落盘**到 app 根 —— `as-aot --air-app` 读的是**磁盘路径**，且它把描述符所在目录当作 app root（扫 `<描述符目录>/src`、在同目录写 `<filename>.build.json`）。落盘描述符里写了说明注释，随即撞上：`parseAirApp`（`src/air-app.ts`）用**纯正则**提字段、**不剥 XML 注释**，注释里出现的 `<filename>`/`<content>` 字面被当成活标签读走，解析结果是垃圾（`filename` = 注释残文）。

- **可达性（非假想）**：AIR SDK 自带的 `templates/air/descriptor-template.xml` 正是**把整块标签注释掉**的风格 —— `<title>`/`<visible>`/`<width>`/`<height>`/`<renderMode>`/`<depthAndStencil>`/`<name>` 等 **7+ 个 `parseAirApp` 会读的标签**都写在注释里（`<!-- <width></width> -->`）。即：**照官方模板建的 AIR app，喂给 `as-aot --air-app` 会解析错**（本项目自有的 `Demo-app.xml`/`shmup-stage3d-app.xml` 不中招，因为它们的注释里没写标签名 —— 这正是该缺陷此前未被发现的原因）。
- **失败形态（两态实测）**：① **模板原样**（width/height 只在注释里）⇒ 注释里的空 `<width>` 命中正则 ⇒ `widthStr = ""` ⇒ `parseInt` 得 `NaN` ⇒ 抛 `AirAppError: air-app.xml <initialWindow> width/height must be positive integers` —— **响亮，但归因错误**（真正的问题是「读到了注释」）；② **注释的备选写在活值之前**（`<!-- <filename>Commented.swf</filename> --><filename>live-demo</filename>`）⇒ 取到注释里的值 ⇒ `filename`/`content` 变 `Commented.swf`、`visible` 变 `""`（→ `true`，而活值是 `false`）—— **静默取错值**。证据：`temp/away3d/evidence-prefix-comments.txt`（对钉住的输入跑**修复前**的提取逻辑）。
- **修法（根因，一处）**：`parseAirApp` 在读任何元素之前先剥注释（`xml.replace(/<!--[\s\S]*?-->/g, '')`），其后的 `childText`、`<initialWindow>` 提取与 `parseEmbedFonts` 一律改用剥离后的文档。XML 注释不携带描述符数据 ⇒ **无注释的描述符解析结果逐字不变**。
- **验收**：`node test.ts` **212 passed / 0 failed**；新增 `test/unit/build.ts` 的 `air-app/DescriptorComments`（**9 条**，照 SDK 模板形态：注释在前/活值在后 7 条 + 「无活 `<title>` 回落 `<filename>`」1 条 + 「width/height 全被注释 ⇒ 回落 800x600 默认值」1 条）。
- **文档同步**：`README-CN.md` 版本号 v0.4.79 → **v0.4.80** + 新 bullet；`package.json` v0.4.79 → **v0.4.80**。
- **遗留表**：**无移出、无新登记**（该缺陷此前未入表）⇒ **75 项**（9 部分完成 / 65 未开始 / 1 暂缓）。
- **附带产出（不入库）**：`examples/away3d-core/` 的 adl 参照 harness（`build-and-run.sh` + 落盘的 `Basic_SkyBox-app.xml`）—— 该目录整体在 `.gitignore`（与 `url-test`/`air-starling-demo` 同类：本地只读验收克隆），故脚本与描述符均不入库；同时已加入 `test/examples.ts` 的 `SKIP_DIRS`（否则套件会把 478 个 away3d 源文件当一个 dir unit 编译）。

---

### 阶段一百零八：away3d-core 语言层收口 —— 类体多声明符 `var` + E4X 计算名（目标 v0.4.81）✅ 已完成

**起因**：AOT 试编 `examples/away3d-core/Basic_SkyBox-app.xml`（**479 个 `.as`**，阶段一百零七 刚建好的 adl 参照基线）。首次编译就报 `Parse error at 982:44: expected identifier but found '['`，而报错**没有文件名**（多源编译），故先写 `temp/away3d-survey/parse_all.ts` 逐文件解析全树、按消息归组：**475 OK / 4 ERR / 0 HANG**，只有**2 类**语法缺口（均在 2 个类），且都是合法 AS3 被我们**硬拒绝**。

- **缺口①（类体多声明符字段）**：`private var _ambientR:Number = 0, _ambientG:Number = 0, _ambientB:Number = 0;` —— 命中 `materials/methods/BasicAmbientMethod.as:24`、`BasicDiffuseMethod.as:26`（**4 个声明符**）、`BasicSpecularMethod.as:27`，共 **3 处 / 10 个声明符**。同一个语法在**函数体**里全树有 **52 处**（`var w1:Number = qa.w, x1:Number = qa.x, …`）且早已支持 —— 只有**类体**分支没写逗号循环。修法：`parser.ts` 的类成员 `var` 分支改成 `parseVarDeclarator()` 循环，**一个声明符一个 `Field` 成员**（共享语句的可见性/`static`/`const`，各自带自己的类型与初始化器；`const` 同理）。
- **缺口②（E4X 计算名，两轴）**：`loaders/parsers/DAEParser.as:982` 的 `name? element.ns::[name] : element.children()` 与 `:1046` 的 `parseInt(element.@[name], 10)` —— DAE/COLLADA 解析的惯用法。`ns::[expr]` 与 `@[expr]` 此前都是 `expected identifier but found '['`。新增 AST 节点 **`E4xName{object, index, attr}`**（`attr=false` 孩子轴 / `attr=true` 属性轴）；`ns` 限定词按本子集「自定义命名空间编译期透明」的**既有约定折叠丢弃**（与 `ns::member` 一致：`expr.kind==='Member'` 时取 `expr.object`，裸限定词则 `Var('this')`）。生成期按接收者分派：xml/xmllist 的孩子轴 → `as_xml_children`/`as_xml_list_children`（结果 `XMLList`）、属性轴 → `as_xml_attr`/`as_xml_list_attr`（结果 `String`）；Proxy / 动态对象的属性轴 → `as_dyn_get`；其余接收者**响亮** `CodegenError`（不 `fallback` 到错语义，§2.5）。
- **语义以 `adl` 为准（`temp/nsbracket/`，20 行值日志两端对照）**：`ns::` **要求命名空间匹配**（无前缀的孩子 + 外来 ns 得 **0**，`ns::["nope"]` 得 0）；`x[name]`（无限定）**不等于** `x.ns::[name]`；`ns::["other"].length()=1`、深链 `deep.ns::[g].ns::["leaf"].length()=2`、`for-each` 得 `"12"`；`@[expr]` **等价于** `@字面量`（`@[at]=7`、`@["kind"]="t"`、`@["nope"]=""`、`@id==@["id"]`）。mxmlc 两形态都接受。
- **探针连带暴露的两个真缺口（本轮一并修）**：
  - **③ 词法：多行 XML 字面量根本过不了词法**。`scanXmlLiteral` 只跳过**开标签之后**的文本，兄弟元素之间的文本（`</a>` 后面的换行与缩进）没跳；于是缩进过的字面量扫描失败、回退成 `<` 符号，下一个闭标签的 `/` 被当作**正则起点** ⇒ `Lex error at L:C: unterminated regular expression`——报错指向一个**完全合法**的字面量。现开/闭标签两个分支后统一调 `skipContent()`。
  - **④ 运行时：XML 节点名带着前缀，孩子轴按全名比对**。节点存的是 `n:item`，而 `as_xml_children` 是 `strcmp(c->name, "item")` ⇒ `ns::[expr]` 在**真实带命名空间的 XML**（正是 DAEParser 的场景）上恒返回**空表**（修前实测 `.length()=0`，`adl` 为 **2**）。若只修 parser，这个「修好的」调用在真 DAE 文件上永远返回空——**空转的修复**。现所有比对点走 `as_xml_local()`（取最后一个 `:` 之后），**存储仍保留前缀**以便 `toString()` 逐字回写 `<n:item>`；`localName()` 随之报 `item`（与 AIR 一致）。
- **验收**：`node test.ts` **217 passed / 0 failed**（新增 5 个用例）。新增示例 `examples/field-declarators.as`（多声明符字段/常量的**独立槽位**、静态初始化顺序 `derived = base * 2`）与 `examples/e4x-name.as`（按 adl 值日志逐条断言两轴，含深链与 `@[nope]` 空串）；新增单测组 `test/unit/lexer.ts` 的 **`lexer/XmlLiteral`（10 条**：美化多行字面量逐字完整 / 兄弟间文本 / 跨行自闭合 / 前缀属性名 / `<` 与 `Vector.<int>` 不被吞 / `{expr}` 仍响亮拒绝），`test/unit/parser.ts` 的 **`parser/ClassFieldDeclarators`（8 条**：一语句 N 成员、各自类型与初始化器、共享修饰符、`const` 多常量、无类型声明者 `type===null`、单声明符形态不变、类体裸语句仍是 `StaticInit`）与 **`parser/E4xComputedName`（8 条**：两轴的 AST 形状、限定词折叠到 `element`、裸限定词→`this`、`.@name`/`.ns::name`/`x[e]` **三个旧形态逐字不变**），`test/unit/diagnostics.ts` 两条**负例文案**钉（`'@[...]' attribute access on non-XML type int` 与 `E4X computed child access on non-XML type string`，均带 `行:列`）。全树**逐文件重扫 479/479 OK / 0 ERR / 0 HANG**（修前 475/4）。
- **下一道墙（本轮只报明、未改）**：`Codegen error at 60:3: unsupported Vector element type: class` —— `library/AssetLibrary.as:60` 的 `enableParsers(parserClasses:Vector.<Class>)`（全树 **7 处**）。属**类型模型**面（`vectorCName` 只认具体元素类型含 `*`）而非语言层，已入遗留表。
- **文档同步**：`README-CN.md` 版本 v0.4.80 → **v0.4.81**（支持子集表补「类体一行多字段」与「E4X 计算名两轴」+ 新 bullet）；`package.json` v0.4.80 → **v0.4.81**。
- **遗留表**：**新登记 4 行**（`Vector.<Class>` 元素类型不支持 = codegen 首墙；E4X 命名空间未建模（孩子轴按本地名匹配 + `Namespace` 是占位）；XMLList 的 `@attr` 标量上下文给首值而 AIR 给拼接串；类体无类型字段按 `int` 而 AIR 是 `*`），**移出 0 行** ⇒ **79 项**（9 部分完成 / 69 未开始 / 1 暂缓）。
- **附带产出（不入库）**：`temp/away3d-survey/parse_all.ts`（全树逐文件解析分组）与 `temp/nsbracket/`（adl 值日志探针 + `run_adl.sh`）。另修正 `test/examples.ts` 里 `SKIP_DIRS` 的**过时注释**（它还写着「away3d 的首墙是 `Vector.<T>` 泛型」——泛型早已支持，现墙是 `Vector.<Class>`）。

---

### 阶段一百零九：`Vector.<T>` 类型模型收口 —— `Vector.<Class>`/`<Dictionary>` 元素类型 + **转换 vs 构造**（目标 v0.4.82）✅ 已完成

**起因**：清掉阶段一百零八 遗留表里登记的 **codegen 首墙** —— `library/AssetLibrary.as:60` 的 `enableParsers(parserClasses:Vector.<Class>)`（away3d 全树 **7 处**，另含 `AssetLibraryBundle`/`AssetLoader`/`Loader3D` 的同名方法、`misc/SingleFileLoader.as` 的 `_parsers` 静态字段、`parsers/Parsers.as` 的 `ALL_BUNDLED` 常量）。

- **墙① 元素类型 `class`**：`CodegenError: unsupported Vector element type: class`（`vectorCName` 的 `default`）。修法不是新增 C 类型——`Class` 在类型模型里**已经是** `as_class*`（`symbols.ts` 的 `case 'Class' → {kind:'class'}`），GC 也早已把 `class` 当 `ptr`（`captureMarkKind`/`gc_mark_value`/`boxExpr`/`unboxAny`/`push_all` 全有分支）。真正缺的是**两处判定**：`vectorCName('class') → 'class'`、`vectorElemIsPtr` 把 `class` 计入（元素槽是可持 GC 指针的字段 ⇒ `GCT_PTR_ARRAY` + 写屏障），并补 `vectorElemReflectName('class') → 'Class'`。
- **墙② 元素类型 `dict`**：越过 ① 后立刻是 `unsupported Vector element type: dict`（`Vector.<Dictionary>`，away3d **2 处**）。同理补 `vectorCName`/`vectorElemIsPtr` 两个分支（`flash.utils::Dictionary` 的反射名**早已**在 `vectorElemReflectName` 里）。
- **墙③ 默认参数值里的类静态常量（真缺陷，非本项）**：越过 ② 后是 `Codegen error at 788:3: undefined variable 'RADIUS' at top level` —— away3d `tools/commands/SphereMaker.as:42` 的 `radiusMode:int = RADIUS`。根因：**绑定方法 thunk** 由 `emitFunctionValues` 在**类体外**发射，`currentClass` 为 null，默认值表达式里的类静态常量无从解析。修法：`emitThunk` 新增 `ownerClass` 参数，在发射期间**重新进入所属类作用域**（free function 仍传 null），三个调用点（bound / superbound / static-method-ref）各传自己的 owner。
- **墙④ `Vector.<T>(arrayLike)` 的转换语义（真缺陷 + 本阶段核心）**：越过 ③ 后是 `Codegen error at 614:5: cannot convert array to int`（`Parsers.ALL_BUNDLED = Vector.<Class>([...])`）。根因是 parser 把**无 `new`** 的 `Vector.<T>(...)` **desugar 成了同一个 `New` 节点**（`parseVectorCall`），于是 `Vector.<T>([数组])` 被当成「构造器的长度参数」⇒ 数组转 int 报错。**这两种写法在 AIR 里是两个不同的操作**（见下）。新增 AST 节点 **`VectorCoerce{elem, args}`**，parser 不再 desugar；生成期：静态 `Array` 实参 → `as_vector_<k>_from_array`（元素逐个 unbox，重用既有 `push_all` 的逐 kind 映射，`class`/`dict` 分支已齐）；其余实参 → 运行时 `as_vector_<k>_coerce_any`。
- **语义以 `adl` 为准**（`temp/vecconv/`，adl 51.4.1，两个探针共 **24 行**值日志）：`Vector.<int>([1,2,3])` **= len 3 拷贝**；`Vector.<int>(someVector)` **= 逐元素转换**（`Number 1.5 → int 1`）；`Vector.<int>({a:1})` = **len 0**（按 array-like 读 `length`）；`Vector.<int>({length:2, 0:7, 1:8})` = len 2 `[7,8]`；`Vector.<int>(new Sprite())` = **ReferenceError #1069**（`Property length not found on flash.display.Sprite`）；`Vector.<int>(Sprite)`（Class 值）= **len 0**；`Vector.<int>(3)` / `(null)` / `("ab")` = **TypeError #1034**；`Vector.<int>()` = **ArgumentError #1112**；而 `new Vector.<int>(3)` = len 3 填 0、`new Vector.<int>([1,2,3])` = **ArgumentError #2005**。
- **`coerce_any` 的一个通用分支覆盖全部元素类型**：Array（`tag==6`）直接 `from_array`；否则**按 array-like 协议读 `length` + 数字下标**（`as_dyn_get`）——而 Vector 正好通过**已有的动态钩子**回答 `length`/`i`，所以**任意元素类型的 Vector 都不需要成对特化助手**（避免了 n² 个 pair helper）；非堆指针（Class 值）给空向量；密封类实例走 `as_dyn_get` 的 `#1069`（**与 AIR 同源**）；标量/`null`/`undefined` 给 `#1034`。错误文案逐字对齐（含 `#1112` 的**双空格**与字符串操作数的**引号**）：`Error #1034: Type Coercion failed: cannot convert "ab" to __AS3__.vec.Vector.<String>.`。
- **顺带收掉同族的分歧**：`new Vector.<T>(x)` 的非数值实参以前是**编译错误**（`convert(array→int)`），AIR 是**运行期** `ArgumentError #2005`（`Error #2005: Parameter 0 is of the incorrect type. Should be type uint.`，含 `1.5→len 1` 的合法档）。现非数值/`*` 实参走 `as_vector_<k>_new_arg_check`：数值盒通过并 `as_v_uint_val` 定长，否则抛 `#2005`。
- **顺带修正一个建立在错误假设上的示例**：`examples/stage28.as` 原有的 `Vector.<int>(2)`（注释写着「无 new 函数式调用（等价 new）」）在 AIR 上**抛 `#1034`**，断言 `length == 2` 是错的。已改为 `new Vector.<int>(2)` + 新的转换断言（并补 `Vector.<Number>([1,2,3])` 的拷贝与 `Vector.<int>(numVec)` 的逐元素转换）。
- **验收**：`node test.ts` **222 passed / 0 failed**（阶段一百零八 为 217）。新增示例 `examples/vector-coerce.as`（**40 条**断言：`Vector.<Class>` 的 `[ParserA, ParserB]` + `for each` + `indexOf`、`Vector.<Dictionary>`、Array/Vector/`*`/对象字面量的转换与逐元素转换、`length` 协议、以及 `#1034`/`#1112`/`#2005` 三个错误号**与文案**的逐字比对）；新增单测组 `test/unit/vector.ts` 的 **`vector/Coerce`（20 条**：AST 两形态互不混淆、零参形态可解析、`from_array` 快路径、标量走运行时 `coerce_any`、`#1112` 双空格、`length` 经 `as_dyn_get`、元素 kind 门禁、非堆指针给空向量、`new_arg_check` 与 `new_sized` 分流、`Vector.<Class>`/`Vector.<Dictionary>` 的单态化 + `GCT_PTR_ARRAY` + 反射名）与 `test/unit/reflection.ts` 的 **`reflection/ThunkOwnerScope`（3 条**：绑定方法 thunk 能解析类静态常量（修前**直接抛**）、解析到静态字段槽、free function 仍按顶层解析）。
- **顺带修掉一个 CI 盲区（真缺陷）**：`test/unit.ts` 的 barrel **漏了 `./unit/vector.ts`** —— 阶段九十八·二 写的三个 vector 组（含 `vector/AnyWriteBarrier` 那批「错了就是 SEGFAULT 而非错值」的写屏障钉子）在 `node test.ts` 里**从未跑过**（只有 `node --test test/unit/*.ts` 会跑到）。补进 barrel 后本轮计数从 219 → **222**（+3）。
- **下一道墙（本轮只报明、未改）**：`Codegen error at 54:4: setter 'sourceSound' used as a value on interface 'away3d_audio_drivers_ISound3DDriver'` —— 接口 **setter 赋值**（`sound3D.sourceSound = …`）的发射，属另一族（接口成员发射），已记入遗留表。**判据已验**：`node src/index.ts --air-app Basic_SkyBox-app.xml --main-class Basic_SkyBox -o /tmp/away3d-skybox.c` 在 `examples/away3d-core/` 下 **479 sources 解析全过、codegen 一路推到上述接口 setter**（0.7 s），即 `Vector.<Class>` 这道墙**确已越过**。
- **文档同步**：`README-CN.md` 版本 v0.4.81 → **v0.4.82**（支持子集表补「`Vector.<Class>`/`Vector.<Dictionary>` 元素类型」与「`Vector.<T>(arrayLike)` 转换 vs `new` 构造」+ 新 bullet）；`package.json` v0.4.81 → **v0.4.82**。
- **遗留表**：**移出 1 行**（`Vector.<Class>` 元素类型不支持 —— 本阶段已落地），**新登记 1 行**（接口 setter 作值赋给成员 —— away3d 下一道墙）⇒ **78 项**（9 部分完成 / 68 未开始 / 1 暂缓）。
- **附带产出（不入库）**：`temp/vecconv/`（adl 值日志探针 + `run_adl.sh`，四个探针共 24 行）、`temp/defval/d.as`（墙③ 的最小复现）、`temp/vecconv/check.as`（转换矩阵的 AOT 侧逐行对照，17 行全中）。

---

### 阶段一百一十：away3d-core 生成 C 的**编译闭合** —— 8 族 C 错误清零 + **Basic_SkyBox 链接成功**（目标 v0.4.83）✅ 已完成

**起因**：阶段一百零九 让 away3d 全树（479 sources）的 **codegen 全过**（`--dry` 完成），但 `--air-app Basic_SkyBox-app.xml` 的**真正构建**卡在 **20 个 C 编译错误**上。本阶段把 C 编译阶段清零：首次构建 `EXIT=1 / 20 error` → 现在 **`EXIT=0` / 0 error**，`Build successful: examples/away3d-core/Basic_SkyBox`（含 Metal/Skia/SDL2/curl 全链）。

**根因与修法（8 族，全部是共享发射路径的真缺陷，不是 away3d 特例）**：

- **① 接口方法返回类型解析过早**（`symbols.ts` pass 0）：`IPath_vtable` 声明 `getSegmentAt` 返回 `IPathSegment*`，而实现 `SegmentedPathBase_getSegmentAt` 按**值**返回接口结构体 ⇒ `incompatible function pointer types`。根因：pass 0 逐文件**边注册接口名边解析方法签名**，而 AS3 允许**免 import** 引用同包类型；`IPath.as` 排在 `IPathSegment.as` 之前 ⇒ `resolveType('IPathSegment')` 那一刻 `interfaceNames` 还没有它 ⇒ 退化成**未知名对象**（指针）。**方法形参**没事（发射期才解析，那时 `interfaceNames` 已满）—— 正是这种不对称暴露了它。修法：pass 0 拆成**两轮**（先登记全部接口名、再解析签名）。
- **② 嵌套 Vector 的 typedef 顺序**：`as_vector_vector_Vector3D` 引用了**后定义**的 `as_vector_Vector3D` ⇒ `unknown type name`。原按 `localeCompare` 排序 —— **collation 忽略大小写与 `_`**，`vector_vector_Vector3D` 因此排到了 `Vector3D` 前面。修法：按**嵌套深度**（内层先出）+ 逐字码比较。
- **③ 接口值 ↔ 类指针的转换（两处）**：㈠ 把**接口结构体值**当指针解引用（`(SubMesh*)(renderable)`、`(SkinnedSubGeometry*)(_once)`、`(SpriteSheetAnimationState*)(this->_activeState)`）⇒ 统一改走 `.obj`；㈡ **接口值的构造**用**静态类名**去指 `&<类>_<接口>_vt`，而 `ISubGeometry(this)` 出现在**不实现该接口**的基类 `SubGeometryBase` 里（实现在子类 `SubGeometry`）⇒ 引用了一个**永远不会发射**的 vtable。修法：**声明了该接口**的类走静态配对，其余一律**运行期 `as_iface_lookup`**（沿对象**真实** vtable 的 ifaces 表按接口名查，与 `as` 同路）。
- **④ 逻辑赋值（`||=`/`&&=`）的写入目标不是 lvalue（4 族）**：㈠ **静态字段**（`Stage3DManager._instances ||= new Dictionary()`）—— 读侧是 `(Cinit(), field)` 逗号式，不可赋值 ⇒ 守卫与写入都用**裸字段名**、cinit 提到整表达式之前；㈡ **访问器对**（`colorTransform ||= new ColorTransform()`）—— 读侧是 **getter 调用**，不可赋值 ⇒ 写入必须走 **setter**（新增 `Symbols.findSetter` 沿 super 链查，与 `findGetter` 对称 —— 原来只在**本类** `setters` 里找，继承来的 `colorTransform`（声明在基类）直接漏掉）；㈢ **裸标识符访问器**（隐式 `this`）走同一条 setter 路径（本地同名变量仍优先）；㈣ 接口接收者的访问器对走**接口 vtable 的 setter 槽**。
- **⑤ 赋值表达式的**值**：`as_dyn_set`/`as_any_set` 返回 `void`，却被用在值位置（`a.b = c.d = 5`、`?:` 分支）⇒ 新增 `as_dyn_set_v`/`as_any_set_v`（写入并返回该值），8 个发射点改走 `_v`（语句位置无额外代价）。
- **⑥ 装箱值的一元 `+/-`**：`-a[i]`（`a` 是 `Array`/`*`）发射成 `-as_array_get(...)`（对 `as_value` 结构体取负）⇒ `any` 操作数先 `as_v_num_val` 再取负。
- **⑦ `new <对象变量>()` 的类指针**：`data:Object` 持有 Class 值时（`SingleFileLoader.parseData` 的 `if (data is Class) data = new data()`）发射成 `(void*)(data)` —— 把**装箱结构体**转成指针 ⇒ `dynNewCode` 改收 `{code,type}`，`any` 源先 `as_v_obj_val` 解箱。
- **⑧ XMLList 下标读的返回类型**：`as_xml_list_get` 原返回 `as_value`（`undefined`），但发射端把 `list[i]` 标为 `xml`（`as_xml_node*`）⇒ 6 处 `passing 'as_value' to parameter of incompatible type 'as_xml_node *'`。修法：助手返回 **`as_xml_node*`**（越界给 null —— E4X 给 `undefined` 且不抛，本子集 XML 槽就是裸节点指针，两者同一表示，已注明）。

**运行期（下一阶段，非本阶段目标）**：headless 构建（`<visible>false</visible>`，渲染一次到 PNG）**链接成功**并跑到第一个不支持点：`Uncaught exception: Error #1009` —— 用 `dladdr` 打在 `as_req_obj` 守卫上定位到 **`away3d_textures_BitmapCubeTexture_testSize`**，根因是 **`[Embed]` 图片资源未实现**（`EnvPosX` 等 6 张 skybox 贴图的 Class 值为 **null** ⇒ `testSize(null)` 解引用）。已登记为新遗留行，**不是** codegen/编译缺陷。

**验收**：
- 构建：`cd examples/away3d-core && node ../../src/index.ts --air-app Basic_SkyBox-app.xml --main-class Basic_SkyBox` ⇒ **`EXIT=0`**、`Build successful`（首次 20 error → 0）。
- 回归：`node test.ts` **222 passed / 0 failed**（含 5 条**陈旧钉子**修正，见下）。
- **顺带修掉 5 条陈旧单测钉子**（均非本阶段引入，但挡住全绿）：① `display.ts` 光标枚举从 **2** 个分支变 **3** 个（新增「Skia 无窗口」分支）⇒ 计数 2→3；② `vector.ts` 的 `as_vec_index_key` 钉子要求 `{ neg = true; p++; }`，实现早已改成 `atof(key)`（负号照认）⇒ 钉子对齐实现；③ `as_vec_hdr` 钉子漏了后来加的 `bool fixed;`；④ `new_sized(3)` 钉子漏了后来的 `fixed` 形参 ⇒ 改 `new_sized(3, false)`；⑤ `platform.ts` 的 NativeWindow ctor 钉子要求 `EventDispatcher_ctor((EventDispatcher*)o);`，而**本会话**给 EventDispatcher 加了 `target` 形参 ⇒ 改 `, NULL`。
- **临时诊断钩子已全部还原**：清墙期在 4 条 `CodegenError` 文案里加的 `[in ${this.currentClass}]` / `(obj=…, in …)` 后缀全部去掉（`test/unit/diagnostics.ts` 钉着这些文案格式）。
- **文档同步**：`README-CN.md` 版本 v0.4.82 → **v0.4.83**；`package.json` v0.4.82 → **v0.4.83**。
- **遗留表**：**移出 1 行**（接口 setter 作值赋给成员 —— 本阶段已落地）、**新登记 2 行**（`[Embed]` 资源未实现 —— Basic_SkyBox 首个运行期失败；接口**访问器作方法调用**只在接口接收者上支持）⇒ **80 项**（逐行重数：9 部分完成 / 70 未开始 / 1 暂缓；上一轮头计数 78 与实际行数差 1，已校正）。
- **附带产出（不入库）**：`temp/accprobe/a.as`（访问器作方法调用的最小复现）、`examples/away3d-core/Basic_SkyBox.c/.o`（构建产物，与 `build-and-run.sh` 同形）。

---

### 阶段一百一十一：文档所指向的「Skia 离屏」清单**重新可用** + **回归守卫**（目标 v0.4.84）✅ 已完成

**起因**：清遗留表里 2026-10-06（阶段一百零三）登记的那条「文档指向的 `examples/skia-link.build.example.json` 已不能构建任何示例」。

**复核实测：该行已过期** —— `node src/index.ts examples/hello.as --manifest examples/skia-link.build.example.json` ⇒ **`EXIT=0`**（阶段一百一十 给 Skia **无窗口**分支补的 `AS_CURSOR_*` 桩已把它修好）；`stage36/37/38/41/58` 五个 Skia 示例全部编译+链接+运行成功，PNG 逐像素正确（stage36 红矩形 `0xFF0000` 恰 8000px = 100×80 于 (10,10)、白底 12000px = 200×100 其余全部；stage38 文字用 `0x003399` 出 547px 字形；stage41 满屏 `0x112233`、stage58 绿矩形）。**但真正的缺陷仍在**，本阶段收的就是它：

- **① 枚举被复制在 3 个后端分支里（脆弱性本体）**：`AS_CURSOR_ARROW/IBEAM/HAND/BUTTON` 原先分别定义在 `ASC_USE_WINDOW` 分支、Skia 无窗口分支、纯 C 分支。而生成的 C 的 `ASC_cursor_kind_of_name` 在**每一种**构建里都引用它们，所以任一条分支漏一份就整条清单挂掉——这正是 10 月 6 日静默失效的机制（10 个 `use of undeclared identifier 'AS_CURSOR_*'`）。改为**在所有后端分支之外、无条件定义一次**（`src/runtime.ts` 的 `as_gdraw` 之后、`#ifdef ASC_USE_SKIA` 之前），三个分支只保留各自的 `sk_window_set_cursor` 声明/桩。
- **② 这两条文档清单没有任何回归覆盖（真正的根因）**：`test/examples.ts` 把**每个**示例都用纯 C 构建（不带清单），所以「Skia 离屏」与「Skia 窗口」这两条文档宣传的 define 组合在 CI 里**从未被编译过一次**。新增单元组 **`build/DocumentedLinkSets`**（`test/unit/build.ts`）：用构建层自己的 `loadManifest`/`applyManifest`/`buildCompileSteps` 取出清单**真实**的 `defines` + `include-paths`，把 `examples/hello.as` 生成的 C **各编译一次**；同时钉住两份清单的形态（离屏那份必须**没有** `ASC_USE_WINDOW`/`window_glue.cc`/`SDL2`，窗口那份**必须**有，两者的 glue/库必须跟随 `ASC_USE_WINDOW`），并自证前提（生成的 C 确实引用了 `AS_CURSOR_IBEAM` + `ASC_cursor_kind_of_name`，否则守卫会空转通过）。生成的 C 只看到平坦 `extern` 声明、**不碰任何 Skia 头**，故**无需链接 Skia**（两例合计约 1.4s），不会把 97 MB 静态 Skia 拉进 CI。
- **③ 文档自身的清单副本已过期**：`docs/zh-cn/skia.md` / `docs/en/skia.md` 里的片段仍写 `skia_glue.c` 与 `include-paths: ["../vendor/skia/include"]`，还留了一段「`build.ts` 待补 `.cc` 驱动」的注释（阶段三十六 就已实装）。改为**只画形态 + 指向清单本体**（单一权威，不再抄一份等着过期），并补一句「这两条清单由 `build/DocumentedLinkSets` 兜底」。

**验收**：

- **离屏端到端（真链 Skia）**：`stage36/37/38` 以 `--manifest examples/skia-link.build.example.json` 重建重跑 ⇒ **3 个 PNG 与改动前逐字节 `cmp` 相同**；**窗口清单**同样可用：`examples/window_click.as` + `examples/window_click.build.example.json` ⇒ `EXIT=0`、`Build successful`。
- **回归**：`node test.ts` **223 passed / 0 failed**（阶段一百一十 为 222，+1 即新单元组）；`npm run test:unit` **65/65**（阶段一百一十 为 64）。
- **守卫有效性（变异验证，防「空转通过」）**：临时注释掉 `#define AS_CURSOR_IBEAM  1` ⇒ `build/DocumentedLinkSets` **两条编译检查同时红**，报的正是当年那句 `error: use of undeclared identifier 'AS_CURSOR_IBEAM'`（`temp/unit-linkset/offscreen.c:31626`）；随后还原并复绿。
- **钉子同步**：`test/unit/display.ts` 原钉「每个后端分支各定义一次 cursor 枚举（`count === 3`）」改为「**恰好定义一次**（`count === 1`）+ 位置在**所有后端分支之前**」——同一意图（每条后端组合都拿得到枚举）在新形态下由更强的两条不变量保证。
- **文档同步**：`docs/{zh-cn,en}/skia.md` 清单片段改写；`docs/{zh-cn,en}/compile.md` §7 表格后补「离屏那条只链 Skia（无 `window_glue.cc`/`SDL2`）」+ 守卫说明；`README-CN.md`/`package.json` 版本 v0.4.83 → **v0.4.84**。
- **遗留表**：**移出 1 行**（文档清单已不能构建 —— 本阶段已落地）、**新登记 0 行** ⇒ **79 项**（`部分完成` 9 / `未开始` 69 / `调研完成 · 实现暂缓` 1）。
- **附带产出（不入库）**：`temp/skiaoff2/`（离屏重建 + PNG + 运行日志）、`temp/unit-linkset/`（守卫生成的 C 与 `.o`，位于 `temp/` 内）。

---

### 阶段一百一十二：`[Embed]` 资源（图片/字节/声音）+ 让 headless `Basic_SkyBox` **真的渲染**（目标 v0.4.85）✅ 已完成

**起因**：清 2026-10-07（阶段一百一十）登记的遗留行「`[Embed]` 的图片/字节资源未实现 ⇒ 嵌入类 Class 值为 null，运行期 `#1009`」——headless `Basic_SkyBox` 的第一个运行期失败点（`away3d_textures_BitmapCubeTexture_testSize`）。

**① `[Embed]` 落地**（新文件 `src/embed.ts` 约 250 行；`ast.ts` 补 `Metadata.named`/`Field.metadata`；`symbols.ts` 补 `embedFieldInits`；`emit.ts` 补 `emitEmbedResources`）。语义全部以 `adl 51.4.1` 实测为准（`temp/embedprobe`…`embedprobe7`，结论落盘 `temp/embedprobe7/adl.txt`）：

- **种类三态**：图片（png/jpg/jpeg/gif/bmp）⇒ `flash.display.Bitmap` 子类（实例的 `bitmapData` 就是解码后的图）；`mimeType="application/octet-stream"` ⇒ `ByteArray` 子类（内容 = 文件字节原样）；`.mp3`/`audio/mpeg` ⇒ `Sound` 子类。**`mimeType` 覆盖扩展名**（adl 实测：png + octet-stream 得 ByteArray）。未知扩展/mimeType **响亮拒绝**并列出支持集（`.txt`/`.svg`/`.wav`/`application/xml` 与 AIR 一样拒绝）。
- **字节原样内嵌**（原始文件），运行期交 Skia 解码成**直通 ARGB**（复用 SWC 位图的 `BitmapData_adoptEncoded`，无新增解码代码）。opaque 像素与 AIR **逐像素一致**；半透明像素是**实测过的偏差**（AIR 存的是反预乘后的值）。
- **与 AIR 同形的细节**：0 参构造器（`new C(0,0)` ⇒ `#1063`）、生成类 `isFinal+isDynamic`、同 `(文件, 种类)` **去重为一个类对象**、`source` 相对声明文件而**前导 `/` 相对 source root**（`--air-app` 为 `<appRoot>/src`）。**唯一差异**：类名字符串（AIR 的 `<file>_<ext>$<hash>` 里的 hash 不可复现，我们的 `Embed_<宿主类>_<字段>` 只影响 `getQualifiedClassName()`）。
- **落地形态**：`[Embed]` 走与 `swc.ts` 相同的「资源展开前置遍」（只产出 AST + 字节，不产 C 文本、不碰构建，§2.8），新类参与正常符号收集/vtable/类注册表；字段初始化在**符号层**注入（不改 AST）。文档：新 `docs/zh-cn/embed.md`。
- **验收**：新增 `examples/embed.as` + `examples/embed.build.json`（链 Skia + miniaudio，覆盖三种资源、Class 值同一性、去重、`#1063`、解码像素）+ `test/unit/embed.ts`；`Basic_SkyBox` 构建日志 `embed 8 asset(s)`（6 张 JPEG + 2 个 `pbj`，后者用的正是前导 `/` 规则）。⚠️ **该数字已过期**（当时 `src/` 里只有 main 与引擎源码，兄弟 demo 的 `.as` 是后来才加进去的）：现在的同一命令是 **`embed 40 asset(s)`**——我们按「整包编译」把**全 `src/`** 的 `[Embed]` 都收了进来（含其它 demo 的资源，且会存活进产物），是**已知偏差**，见阶段一百二十二 与 [`docs/zh-cn/embed.md`](docs/zh-cn/embed.md) §7。

**② 三个 Class 值同一性真缺陷**（都被 `Cast.bitmapData(Class)` 这条路径逼出来，各自 adl 实测）：重复的 `as_class` 对象（改为 `as_class_reg` 唯一注册表）、`as_v_is_inst` 把 Class 值当实例、`o.constructor` 在 any 值上取类（`as_v_class_of`）。AIR 的判据：`x is Class` 为真而 `x is Bitmap` 为**假**（实例才是 Bitmap）。

**③ `EventDispatcher_dispatchEvent` 无限递归（真缺陷）**：规则由三组 adl 探针定出——派发给**无人接收**的事件**不动** `event.target`；无目标事件保留**主张者**；已被指向的事件在派发期间换目标、之后还原。

**④ `CubeTexture` GPU 支持 + AGAL `<cube>` 采样**：`s3d_upload_cube_texture`（一张 `MTLTextureTypeCube`，六面按 AGAL 顺序 +X,−X,+Y,−Y,+Z,−Z）、AGAL 采样器维度（`texturecube<float>`/`samplerCube` + `.xyz`）、以及对立方体贴图的**vtable 先于字段**识别（`CubeTexture.face0` 与 `Texture.gpu` **同字偏移**，先读 `->gpu` 会把 `BitmapData*` 当 MTLTexture）。

**⑤ 对象→字符串强转对齐 AIR（根因级，一处修复解开一串）**：`as_obj_to_str` 原先返回 **C 类名**且**不派发**虚 `toString()`；而 away3d 的 AGAL 源码正是靠 `ShaderRegisterElement.toString()`（返回 `"vt0"`）**拼接**出来的 ⇒ 汇编器收到 `away3d_materials_compilation_ShaderRegisterElement`，报 `wrong number of operands. found 6 but expected 3`，我们侧再报 `AGAL: bytecode too short for header`。修法：`as_vtable_header` 补 `toString`/`hasOwnProperty` 槽（与既有 vtable 尾部**逐字对齐**，一个读取器同时服务生成类与预置箱 vtable）、`as_obj_to_str` 派发该槽、无覆写者渲染 AIR 的 `[object <本地类名>]`、`as_v_str_val` 的 object 分支同样派发。adl **12 例逐字对照** ✓，新增 `examples/strcoerce.as`。

**⑥ 立方体贴图「上传时机 + mip」双缺陷（本轮最后一道墙 = 白屏的真根因）**：

- **现象**：窗口**纯白**。`ASC_S3D_STATS` 显示 `draws=240/s tri/draw=806`（真的在画）、`ASC_MTL_READBACK` 读出后缓冲 `00000000`、`mtl_draw_texture` 的源纹理全 0 ⇒ 3D 通道画了但**内容为空**；而「纯白」而非「透明」说明**合成/alpha 语义是对的**（`temp/clearprobe` 实测 AIR 尊重 clear 的 alpha ⇒ 我们的预乘合成正确）。
- **定位**：探针打在 `Context3D_submit` 的立方体分支上 ⇒ 六面 `width=512` 但 **`pixels=NULL`**（该分支要求六面像素齐备才上传 ⇒ 纹理从未绑定）。
- **根因 A（上传时机）**：away3d 的 `MipmapGenerator.generateMipMaps` 把**同一张临时位图**逐 mip 上传、随后 `dispose()`（`BitmapData_dispose` 置 `pixels=NULL`）。AIR 是**同步**上传所以无妨；我们把 GPU 上传**延迟**到 submit ⇒ 读到 NULL。修法：`CubeTexture_uploadFromBitmapData` 只收 **mip 0** 并把像素**快照**成面自己的 `BitmapData`（写屏障同步）。2D `Texture` 早有一条同样的 eager 上传（Starling 文本框贴图同一原因），立方体这条路当时漏了。
- **根因 B（选择器）**：立方体的面是 texture **slice**，必须用带 `bytesPerImage` 的 `replaceRegion:…` 变体；原先发的 2D 变体在立方体上**不存在** ⇒ `NSInvalidArgumentException`（`unrecognized selector`）**硬崩**（编译器只给 warning，属于会漏过的类型错误）。
- **验收**：窗口截图 = **雪山天空盒 + 环境反射铬环**，与 adl 参照同场景同构图（天空采样 (30,35,35) vs adl (33,37,36)）；新增单元组 **`stage3d/texture-upload`**（`test/unit/stage3d.ts`，9 条）把「同步上传 / 只收 mip 0 / 快照 + 写屏障 / 立方体 `bytesPerImage` / 面序」钉在源级（这些不变量进不了 `examples/`：示例套件是纯 C，无 GPU，错了也不会有任何示例变红）。

**验收汇总**：`node test.ts` **226 passed / 0 failed**（阶段一百一十一 为 223；+3 = 新示例 `embed.as`、新示例 `strcoerce.as`、新单元组 `stage3d/texture-upload`）；`Basic_SkyBox`（479 sources，`--air-app`）全链构建 + 窗口渲染 ✓；adl 逐字对照：字符串强转 12/12、dispatchEvent 三组、embed 资源 8 个。

**遗留表**：**移出 1 行**（`[Embed]` 的图片/字节资源未实现 —— 本阶段已落地）、**新登记 5 行**（内置类名不能作 Class 值 / 顶层 `new <any 变量>()` / 用户函数 `main` 与生成 `main` 冲突 / `Texture`/`CubeTexture` 的 mip 1+ 未上传 / 窗口居中用的是 SDL display 0）⇒ **83 项**。

**附带产出（不入库）**：`temp/skybox-aot/`（Basic_SkyBox 构建/运行/截图 harness `shot.py`、`aot-03.png` 渲染验证图、`run13`–`run18` 定位日志）、`temp/strprobe/`、`temp/dispprobe/`、`temp/clearprobe/`、`temp/embedprobe*`。

---

### 阶段一百一十三：AGAL **采样器标志位**（filter/wrap/mip）+ 立方体 **mip 链** —— 铬环反射走样修复（目标 v0.4.86）✅ 已完成

**起因**：`Basic_SkyBox`（v0.4.85 起真的渲染）的**铬环反射**整片呈「细密网纹」——背景雪山从环身透出的高频噪声，而天空盒正常。三条根因缺一不可：

1. **立方体纹理没有 mip 链**：AIR 的 `BitmapCubeTexture` 经 `MipmapGenerator.generateMipMaps` **逐级**上传；我们为绕开「延迟上传读到已 `dispose()` 的像素」只留 level 0（阶段一百一十二）⇒ **被放大的天空盒无恙、被缩小的环面反射走样**（逐像素欠采样）。
2. **运行时完全忽略 AGAL `tex` 标志位**：away3d 与 Starling **都从不调用** `setSamplerStateAt`（两棵树各 0 命中），只写 `<cube,linear,miplinear>`（`SkyBoxPass`/`BasicSpecularMethod` 等）一类标志位；旧实现的滤/环绕/mip 全凭自定默认值——**恰好**与 away3d 默认路径一致，只是**看着对**（away3d 的 `useSmoothTextures = false` 分支要 `nearest`，会被静默渲染成双线性）。
3. 前两条**叠加**才成 bug：即便补了 mip 链，采样器若仍停在 `nomip`，环面依旧走样。

**AIR 实测（51.4.1，探针 `temp/sampprobe/`，13 例 × 2 次回读，逐例独立清屏色 + 版本戳/`md5`）**：

| 结论 | 证据 |
|---|---|
| **AGAL 标志位被执行** | 同一程序 `<2d,linear,nomip>` vs `<2d,nearest,nomip>`：2×2 纹理放大后中心**灰**（双线性平均）vs **纯色**（单纹素） |
| **`setSamplerStateAt` 覆盖标志位** | setProgram **之后**调，结果随显式调用 |
| **两者是「后写者胜」** | **先**调 `setSamplerStateAt`、再 setProgram ⇒ 结果随 **AGAL 标志位** |
| **`miplinear` 真按 lod 选层** | uv 平铺 T=1/8/16/64 ⇒ lod = log2(每像素纹素数) = −2/1/2/4 ⇒ 采到 level 0/1/2/4 的**专色**（红/绿/蓝/品红），三线性 |
| `nomip`/显式 `MIPNONE` 不选层 | 同样平铺下仍为 level 0 |
| **mip 过滤 + 无 mip 链的纹理 ⇒ AIR 丢弃整个 draw** | 回读整片等于清屏色（AIR 视为无效组合） |

**实现**：

- **立方体 mip 链**（`vendor/stage3d_glue.mm`）：`s3d_upload_cube_texture` 改 `mipmapped:YES`（`MTLTextureUsageShaderRead`），六面照旧只写 level 0，随后新增 `s3d_generate_cube_mips`（blit `generateMipmapsForTexture:` + 同队列 commit/等完成 ⇒ 排在当帧绘制批次**之前**）。选 GPU 生成而非复刻 away3d 的软件 mip：产出同级（盒式滤波），且**不依赖**延迟上传的顺序。
- **AGAL 标志位 → 采样器状态**（`src/runtime.ts` + `src/symbols.ts` + `src/emit.ts`）：`as_agal_sampler_flags` 按 `AGALMiniAssembler` 的位域（`filter` 28 / `mipmap` 24 / `repeat` 20 / `dim` 12）在 **`Program3D.upload`** 时解出每个采样器寄存器的 `(filter, wrap, mip)`，打包进 `Program3D.samplerUsed/samplerFlags`；**`Context3D_setProgram`** 调 `as_s3d_apply_agal_sampler_state` 写进 GPU 的**同一份**每单元状态（新 `s3d_set_sampler_state_i`，字符串版 `setSamplerStateAt` 改为**委托**它）⇒ 与显式调用天然是「后写者胜」（AIR 语义）。在 setProgram 而非 draw 时应用，正是为了保住与 `setSamplerStateAt` 的**调用顺序**。注意 AGAL 的 filter 位 **1 = linear**，glue 的 **1 = nearest**，跨界取反。
- **诊断**：新增 `ASC_S3D_DUMP`（**缓存** `getenv`，同 `ASC_S3D_STATS`/`TRACE`），每次 draw 打印每单元采样器状态；兜底默认采样器对「会采样的程序」已不可达。

**验收**：`ASC_S3D_DUMP=1` 下两路 draw 均为 `sampler[0] filter=0 wrap=0 mip=2`（LINEAR/CLAMP/MIPLINEAR，**源自 away3d 的 AGAL**，不再是兜底默认）；环面截图**修复前逐像素网纹 → 修复后与 AIR 同级的连续锐利镜像**（`temp/ringdiag/ab-air-vs-ours.png`；相机用光标归中冻结以取稳定姿态，`temp/ringdiag/mf-*.png` × 8 张全绿）；新增单元组 **`stage3d/agal-sampler-flags`**（9 条：解码器签名/四个位域/线性位取反/应用点/单一存储），并把**立方体 mip 链**钉进 `stage3d/texture-upload`（9 → 11 条）⇒ `node --test --test-name-pattern='stage3d/'` **20/20** ✓（这些不变量进不了 `examples/`：示例套件是纯 C，无 GPU）。文档 `docs/zh-cn/display3d.md` §9.2/§9.5 重写（删掉「`miplinear` 退化为 level 0」的旧简化口径）。

**遗留表**：**新登记 2 行**（mip 过滤 + **无 mip 链**的纹理：AIR **丢整个 draw**、我方按 level 0 画；AGAL→MSL 翻译里临时寄存器 `vtN/ftN/op` **未初始化**即可能被读）、**改写 1 行**（`Texture`/`CubeTexture` 的 mip 1+ 未上传 → **部分完成**：立方体已给整链，2D 仍只收 level 0）⇒ **85 项**。

**附带产出（不入库）**：`temp/ringdiag/`（`shoot.py`/`shoot2.py`：窗口定位 + **光标归中冻结相机** + 区域截屏；`run_and_shoot.sh`；逐张对照图与拼版）、`temp/skybox-aot/relink.sh`（只重编 glue `.mm` 的秒级重链，省掉 ~2 分钟 20 MB 的 C 编译）、`temp/sampprobe/`（adl 采样器语义探针）、`temp/ringdiag/dump2.log`。

---

### 阶段一百一十四：Stage3D 与 Skia **共用一条 `MTLCommandQueue`** —— 环「转着转着烂掉」撕裂修复（目标 v0.4.87）✅ 已完成

**起因**：用户在 `Basic_SkyBox` 连拍里看到环**转着转着烂掉**——环身被**直线**切开、缺口处露出**背景**（雪山/天空），而背景本身**完好**；同一帧整体有时还会出现贯穿画面的**竖直接缝**（场景左右错位）。

**取证（视觉为准）**：`temp/ringdiag/burst.py <窗口标题> <前缀> N --park` 连拍（窗口挪到 (60,60) 并 `activate`，`Quartz` 把光标**归中**以冻结鼠标驱动的相机漂移，再按 Quartz 窗口边界区域截屏）。基线 25 帧里 **11 帧**环被直边切断（`b-051`..`b-075`）；`adl` 同姿态 60 帧连拍**零撕裂**。（数值化探测——列间差分/孤立跳变/移位对齐/降采样天空带——全部被窗口边框与山脊轮廓干扰，**结论：本 bug 只能靠看图判**。）

**根因：Stage3D 离屏目标被**跨队列**读写**。`ASC_window_render` 的顺序是 `as_s3d_flush_all()`（commit + `waitUntilCompleted`）→ `as_skia_mtl_begin_frame`（`nextDrawable`）→ `as_skia_mtl_draw_texture(canvas, ASC_stage3d_tex, …)`（采样**活的** Stage3D 目标）→ `as_skia_mtl_flush`（Ganesh `flushAndSubmit` + `presentDrawable` + commit）。而 `stage3d_glue.mm` 的 `s3d_create` 自建 `[device newCommandQueue]`，Ganesh 侧是 `metal_glue.mm` 的 `g_queue`——**Metal 的冒险跟踪只在单条队列内有效**。于是第 N 帧的合成「读」可以和第 N+1 帧的 Stage3D「写」重叠：**写胜出**，尚未被环形 pass 写到的 tile 停在该帧的天空盒（背景）⇒ 环被**垂直 tile 边界**切开、背景完好。与全部观测**逐条吻合**。

**钉死实验**：在 Ganesh 的提交处临时加环境开关，把 `flushAndSubmit(…, GrSyncCpu::kNo)` 切成 `kYes`（CPU 等 GPU，人工串行化读与下一写）⇒ 同样 25 帧 **11 → 0** 帧被切。竞态确认。（该开关是**实验**而非修复，落地后已删除。）

**实现（共用一条队列，不加 CPU 停顿）**：

- `vendor/metal_glue.mm`：新增进程级 `id<MTLCommandQueue> sk_mtl_shared_queue(void)`（首次用时经 `MTLCreateSystemDefaultDevice()` + `newCommandQueue`，**持有到进程退出、永不释放**）；`sk_mtl_init` 改为取它（不再 `[g_device newCommandQueue]`）；`sk_mtl_destroy` **只置 `g_queue = nil`、不再 release**（仍活着的 Stage3D 上下文还在用它）。
- `vendor/stage3d_glue.mm`：`__attribute__((weak_import))` 声明该访问器（**headless Stage3D 构建会链接 stage3d_glue 而不链 metal_glue**，此时符号不存在），`s3d_create` 改为 `c->queue = (shared != nil) ? [shared retain] : [device newCommandQueue]`（恒 +1，与 `s3d_destroy` 的 release 配平）。
- **弃案**：① `GrSyncCpu::kYes` —— 每帧 CPU/GPU 串行，正好吃掉阶段一百零四刚省下的那 0.6 ms；② `MTLSharedEvent` —— 需要一个「合成已读完」的可靠信号，Ganesh 给不出。
- 目标纹理本身无需改（`MTLStorageModeShared` + `usage = RenderTarget|ShaderRead` + 默认 `MTLHazardTrackingModeTracked`，正是同队列冒险跟踪生效的前提）。

**验收**：共用队列后连拍 **150 + 120 + 120 = 390 帧零切割**（修复前 25 帧里 11 帧被切；`temp/ringdiag/q-all.png` / `f-all.png` / `g-all.png` 每帧环体完整闭合）。新增单元组 **`stage3d/gpu-queue-sharing`**（8 条：访问器存在且只建一次、不随窗口释放、`sk_mtl_init` 改取它、`sk_mtl_destroy` 不 release、弱声明、`s3d_create` 采纳并保留 +1、仅在无共享队列时回落自建）⇒ `node --test --test-name-pattern='stage3d/'` **28/28** ✓；`npm test` 全绿。**回归风险低**：无 Stage3D 的构建不受影响（weak 符号 + 回落），有 Stage3D 的构建少一条队列。

**本轮顺带实测（不改语义，只补证据）**：阶段八十九·六十八 登记的「`[SWF(...)]` 元数据被解析后丢弃」一行还写着「`frameRate` 是否一并生效需另行实测」——现用 `temp/rprobe/`（`Fps.as` + `[SWF(frameRate="60")]`，照 `temp/sampprobe/` 的 `adl` 哨兵看门狗跑）实测 `adl 51.4.1`：**`stage.frameRate = 60`**、3 s 内 `ENTER_FRAME` **169 次（56.1 fps）**，即 AIR 确实按 `[SWF]` 元数据定帧率。我方该 demo 实测 **120 fps**（`ASC_S3D_STATS=1` 的 `draws/s=240` ÷ 每帧 2 个 draw），且 `ASC_app_frame_rate` 初值 `0.0` = 「未设 ⇒ 跟随刷新率」⇒ 本机 120 Hz **两倍于 AIR**。（该行已据此次实测改写，修复仍属「`[SWF]` 元数据透传」那一独立立项。）

**遗留表**：**改写 1 行**（Stage3D/Skia 各持一条 queue → **部分完成**：共用队列已落地且**撕裂随之消失**，剩「`s3d_flush` 只 commit 不 wait」的 ~0.6 ms/帧 性能半）、**改写 1 行**（`[SWF(...)]` 元数据：补上 `frameRate` 的 adl 实测口径与 120 fps 观测）⇒ **85 项**（未开始 73 / 部分完成 **11** / 暂缓 1；**无移出、无新登记**）。

**附带产出（不入库）**：`temp/rprobe/`（`Fps.as`/`app.xml`/`run_adl.sh`：帧率与 `[SWF]` 元数据的 adl 探针）、`temp/ringdiag/q-*.png`/`f-*.png`/`g-*.png` 连拍与拼版。

---

### 阶段一百一十五：AGAL **无目的槽指令的操作数错位**（`Basic_SkyBox` 「环缺失」真根因）+ 帧边界 **commit-only**（目标 v0.4.88）✅ 已完成

> **起因（用户报障）**：阶段一百一十四 修完跨队列撕裂后，用户仍报「旋转到一定角度环就缺失」。
> 实测确认这是**两条独立缺陷**：两条缝都恰好落在**竖直线**上（AGAL `kil` 的世界 `x=0` 半平面
> 与跨队列撕裂的 tile 边界），所以此前被当成同一个 bug 修。

- **根因（缺陷 A）**：`AGALMiniAssembler.as` 每条指令固定 **24 字节**（`[opcode:4][dest:4][src1:8][src2:8]`），
  且**没有目的寄存器时也照样写 4 字节 0 到 dest 槽**（`if ( j == 0 ) { agalcode.writeUnsignedInt( 0 ); }`）。
  `src/runtime.ts` 的两处槽游走（`as_agal_sampler_flags`、`as_agal_translate`）旧来只在
  `hasDst` 时跳过它 ⇒ **`kil`/`ife`/`ine`/`ifg`/`ifl` 的每个操作数都早读 4 字节**。away3d
  `EnvMapMethod.as:129` 的 `kil temp2.w`（语义：「立方体采样 alpha < 0.5（占位纹理）就杀片元」）
  被解成 `in.v0.xxxx`，判据变成**变换后法线 x < 0** —— 一个世界空间半平面，**投影正好是屏幕中心
  竖直线**，把环体左侧外表面成片丢掉、只剩内管面（看起来像「小了一圈的椭圆」），且**随旋转角度变化**
  （哪些法线朝 −x 随环转动）——与用户描述逐条吻合。修法：**无条件** `pos += 4;`（`I->dst` 仍只在
  `hasDst` 时读），两处都改；不动 `kil` 的 `.x` 比较 —— `agal_src_expr` 已按操作数自身的 swizzle
  取值，解码对了就是 away3d 的原意。
- **实现（缺陷 B，阶段一百零四 的「性能半」）**：`s3d_flush` 拆为 `s3d_flush_impl(ctx, wait)` 的
  两个风味 —— commit+wait（`s3d_readback`/`s3d_readback_render`/`s3d_resize`/`s3d_destroy`，CPU 真要读目标）
  与 **commit-only**（`s3d_flush_async`：`Context3D.present`、`ASC_window_render` 合成前）。删掉生成 C 侧
  已无调用点的 `as_s3d_flush` 包装（留下它就成了死代码）。**为什么不 wait**：CPU 等待只为让写对 **CPU**
  可见，而帧边界要采样这张纹理的是 **GPU 侧合成**，自阶段一百一十四 共用队列起，Metal 按提交序执行同队列
  command buffer 并为默认 `Tracked` 目标插依赖屏障（Ganesh 自己提交合成 buffer 时**就完全不 wait**）。
  `s3d_draw` 依旧**从不** flush。web 后端 `stage3d_webgl.cc` 同步补齐 `s3d_flush_async`/`s3d_flush_all_async`
  （= `glFlush()`）以保持两端 `s3d_*` ABI 一致；`ASC_S3D_STATS` 新增 `commit=` 记账并**银行上一批**
  以便无等待也能读出 `gpu=`。
- **验收**：
  - **逐帧钉死**（临时探针，已撤）：`ASC_DRAW_FLUSH=1`（逐 draw commit+wait+dump 目标）⇒ `d00_12`（仅天空盒）
    干净、`d01_1600`（+环）**环在目标里就已断裂** ⇒ 与合成/跨帧撕裂无关；`ASC_DUMP_GEO` ⇒ 网格是**完美环面**
    （R=150/r=60、861 顶点全用到、索引无越界）；修好后同帧 MSL 为 `ft4.w = ft3.w - fc[0].x;` +
    `if (ft4.wwww.x < 0.0) discard_fragment();`（真实立方图 alpha=1 ⇒ 永不 discard）。
  - **同帧数值对照**（`temp/ringdiag/cutscan.py`，ref = 同帧天空盒-only dump，背景不可能被漂移污染）：
    掩码边界贴在屏幕中心列的最长连续行数 **22 → 0**、占掩码行数比例 **0.21 → 0.00**（掩码面积 +39%）。
  - **连拍 320 帧**（`cap.py`：光标**启动前**预停窗口中心 ⇒ 单次运行背景静止）：**参考无关**竖缝检测器
    （`spike.py`：每列 `V(x)=|I(x+1)-I(x)|` 行均值，扣左右邻列与同列时间中位数）**max 15.96 / median 5.34 / p90 9.12**，
    灵敏度自检（贴一条 10px 宽另一姿态竖条）**24.88**；最差 10 帧逐张目视为完整闭合环
    （`temp/ringdiag/worst10-vs-buggy.png`，同图附修复前断裂帧对照）；拼版 `burst-sheet-a.png` 16 帧全完整。
  - **阶段一百零四 容量对照**（重编 demo，`ASC_FRAME_STATS=1` + `bench-auto`）：峰值对象数 OFF **61238** /
    ON **61603**，即 `showStats` 惩罚 **−6.4%/−5.0% → 归零**（p50 8.33/8.15ms，均 120 fps）。
  - **Starling 12 场景扫**（`temp/hidpi/sweep_aot.py`）：**12/12 `alive=True`**、日志 0 条 `FAILED|Error`、
    逐格画面正确（`temp/ringdiag/sweep12.png`：Filters 多 pass、BlendModes、RenderTexture、Masks、Sprite3D 立方体等）。
  - **探针实测**：`ASC_S3D_STATS=1` ⇒ `gpu=0.13ms wait=0.00ms commit=0.01ms per-batch draws/batch=2.0`，
    即阶段一百零四 账上的 **`wait≈0.93ms/帧` → `commit≈0.01ms/帧`**（8.33ms 预算的 ~11% 归零）。
  - **回归**：`node test.ts` **230 passed / 0 failed**（229 → 230：新增单元组 `stage3d/agal-operand-slots`
    与 `stage3d/flush-policy`）；`agal-operand-slots` 已手工回退验证过（回退后 2 条 FAIL）。
- **踩坑（留给下一轮）**：① 相机 yaw 是鼠标偏移的**累加和**（`camera.rotationY += 0.5*(mouseX − width/2)/800`）
  ⇒ 跨运行姿态**不可比**，参考图必须来自**同一次运行**，或改用参考无关的量；② **天空盒的云会动** ⇒
  「相机冻结 ⇒ 背景逐像素不变」不成立；③ 截屏域还叠着窗口服务器的**色彩管理抖动**（单次运行内静止天空角落
  逐像素 max−min 达 103）⇒ **逐像素掩码类检测在截屏域不可用**；目标纹理 dump 是干净的同帧参考，但
  **CPU 读回必须自己 flush+wait**，不能当「合成看到了什么」的证人。证据与工具索引见 `temp/ringdiag/notes.md`。

**文档同步**：`README-CN.md` 版本号 v0.4.87 → **v0.4.88** + 两条新 bullet（并回填阶段一百零四 bullet 的残留
描述「该往返已归零」）；`docs/zh-cn/display3d.md` §3 补 24 字节固定槽与「无目的寄存器也写 dest 槽」的口径
+ §9.9 两风味 flush；`package.json` v0.4.87 → **v0.4.88**。

**遗留表**：**移出 1 行**（Stage3D 与 Skia 各持一条 `MTLCommandQueue` —— 性能半已落地为 v0.4.88，
共用队列 + 帧边界 commit-only 使该往返归零，结论并入上方阶段节）、**新登记 0 行**（AGAL 无目的槽操作数
错位缺陷此前未入表，修法见上方阶段节）⇒ **84 项**（未开始 73 / 部分完成 **10** / 暂缓 1）。

---

### 阶段一百一十六：away3d / Starling 的 **web 构建闭合** —— LLVM clang 的括号深度上限 + WebGL 后端的立方体纹理与清屏语义（目标 v0.4.89）✅ 已完成

**范围**：用户报两件事——① `away3d-core` 的 `Basic_SkyBox` **web 版编不出来**；② `air-starling-demo` **web 版卡在加载处**。三处根因互相独立且都只在 web 侧暴露，本阶段全部收掉并做 web 渲染/交互验收。

**一、编译失败：LLVM clang 的 256 层括号深度上限**。`Basic_SkyBox` 的 C 在 `TripleFilteredShadowMapMethod_getPlanarFragmentCode` 处直接 `fatal error: bracket nesting level exceeded maximum of 256`（`Basic_SkyBox.c:240161:3594`）：Away3D 这个着色器构建器把 445 个字符串片段拼成**左嵌套**的 `as_str_concat(a, as_str_concat(b, …))`，嵌套深度 = 项数。**Apple clang 21 容忍、`emcc` 背后的 LLVM clang 17 卡在 256** ⇒ 这条一直是**靠编译器宽容通过**的，只有 web 构建会炸（同一份 C，native 编得过）。修法**不是抬阈值而是换形态**（§1.1 允许的「形态转换」）：`emitExpr` 返回值新增 `concatParts?: string[]`，`+` 的字符串分支在片段累积到 **`STR_CONCAT_FLAT_MIN = 32`** 项以上时改发 `as_str_concat_n(N, (const char*[]){…})`（`src/emit.ts:174`、`emit.ts:19716`）——括号深度**恒定**、一次分配、**保持 AS3 的左到右求值序**（数组按源码顺序摆放）；32 项以内仍发原来的嵌套形态（日常代码生成的 C 一字不变）。新增运行时助手 `as_str_concat_n`（`src/runtime.ts`），**NULL 片段按 AS3 语义当 `"null"`**（量长与拷贝两遍必须用同一替换，否则 `strlen(NULL)` 崩或截断）。验收：`examples/` 里的 80 项拼接 → `as_str_concat_n(80, …)`、括号深度 3；NULL 用例输出与 adl 语义一致。

**二、链接失败：WebGL 后端缺两个入口**。away3d 与 Starling 的 web 构建**共同的死因**是 `undefined symbol: s3d_set_sampler_state_i / s3d_upload_cube_texture`：阶段一百一十三 给 Metal 侧加了「AGAL 采样器标志位」（新 `s3d_set_sampler_state_i`）与「立方体整条 mip 链」（`s3d_generate_cube_mips` + cube 上传路径），`vendor/stage3d_webgl.cc` 没跟上。在 web 胶水里按 Metal 语义补齐：新增 `struct S3DTexTarget{GLuint id; int cube;}` + `texTarget[64]/texTargetN` **注册表**（GL 无法回答「这个纹理对象的 target 是什么」，只能自己记）、`s3d_record_target`/`s3d_tex_gltarget`、`s3d_upload_cube_texture`（6 面 `GL_TEXTURE_CUBE_MAP_POSITIVE_X + face` + `glGenerateMipmap`）、`s3d_set_sampler_state_i`，并把 `s3d_apply_sampler`/draw 循环改成**逐单元按登记的 target 绑定**、**空单元同时清 `GL_TEXTURE_2D` 与 `GL_TEXTURE_CUBE_MAP`**（否则上一次留下的 cube 绑定会被下一个 2D 采样器读到——这是实测到的失效形态，不是「没绑定」）。⇒ **away3d-core web 构建成功**。

**三、渲染 bug：环体变实心黑圆盘**。构建通了之后 `Basic_SkyBox` 的 web 画面是一个**纯黑实心盘**（逐 draw 像素探针：RGB 恒 `(0,0,0,255)`；第 1 帧环体有真实反射色，第 2 帧起天空盒在盘区不画、环体完全不画；黑盘 = **各帧环体轮廓的并集**）。根因是 **`glClear` 受 GL 写掩码管辖**（Metal 的 `loadAction=Clear` 不受）：某 pass 的 `depthWrite=false` 把 `GL_DEPTH_WRITEMASK` 留成 0，下一帧的**延迟深度清屏被静默跳过** ⇒ 上一帧的近深度挡住天空盒（z≈1.0）与之后所有绘制。修法（`vendor/stage3d_webgl.cc` 的 `s3d_draw` 延迟清屏处）：`glDepthMask(GL_TRUE); glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE); glStencilMask(0xFF); glClear(bits);`（各 draw 自带掩码，不泄漏给后续 pass）。修复后天空盒全点着色、环体出现亮反射。

**四、用户②「卡在加载处」的真根因：产物不自洽（非加载逻辑）**。`examples/air-starling-demo/` 里 `.html/.js/.wasm` 停留在 **Sep 28** 的一版，而 `.c/.data/.o/.wasm.o` 是 **Oct 8 01:36** 的（`.data` 与今日重建版 `cmp` 完全一致）：那次构建在 **emcc 链接步失败**（缺上面那两个 `s3d_*`）⇒ `.c/.data` 已写出、`.wasm` 留在旧版；旧 wasm 按**新 `.data` 的偏移**读资源 ⇒ 素材全部解不开 ⇒ `[AssetManager]` 停在加载屏（**白底 + 灰色进度条**，已**精确复现**用户症状）。判据（§1.5）：同输入 `adl` 能跑对 ⇒ **遗留缺陷**（非增强）。修法：**就地**重建（`cd examples/air-starling-demo && node ../../src/index.ts --air-app Demo-app.xml --main-class Demo --package web --target wasm -o Starling-Demo`）⇒ `EXIT=0`、七件产物同一时间戳。**排查坑（已记入文档）**：① 浏览器**静默复用**旧的 `.js`/`.wasm`（不重新校验），端口 8125 的失败是**缓存假象**——换新 origin（8126）后 34→36 行 stdout、素材全成功、0 error；② web 构建的相对资源 URL 以**页面所在目录**为基准，故必须就地构建（挪到 `temp/` 会因 `assets/fonts/Ubuntu-R.ttf` 404 而「按钮皮肤在、文字全无」）；③ 一度误判「就地重建仍失败」，实为 CDP 页缓存（服务端日志里连 `.js/.wasm` 请求都没有）。

**验收**：away3d-core web 版 **正立天空盒（太阳左上、雪山在下）+ 镜面反射圆环**（有孔洞、无黑盘）；Starling web 版（就地重建）菜单 **12 个按钮全部带文字**（Textures/Multitouch/…/Sprite 3D）+ 底部驱动信息 `WebGL2 (Stage3D)`（与 `adl` 参照一致）；CDP 注入点击 → 进入 **TextFields 场景**（desyrel 位图字体与系统文字都在），DevTools Network 确认新 origin 拉了 `html/js(172 kB)/data(2.9 MB)/wasm(8.2 MB)/Ubuntu-R.ttf(360 kB)`。音效（`wing_flap.mp3`）报 `#2068` 属**既有 web 限制**（无音频后端），不阻塞，另立遗留行。

**回归钉子**：新增单元组 **`stage3d/webgl-abi`**（6 条，`test/unit/stage3d.ts`）——核心是「**运行时调用的每个 `s3d_*` 都必须在 WebGL 胶水里定义**」这条**引用⊆定义**的结构不变量（本次缺陷类别正是「生成 C 调用、后端未定义」），外加两个具名入口 + target 注册表 + 空单元清双 target + 清屏前强制三掩码；**模拟缺口的胶水会当场列出那两个符号**（已用 pre-fix 文本验证）。新增 **`test/unit/emit.ts`**（`unit: emit/StringConcatFlat`，5 条）——阈值两侧形态（32 项仍旧嵌套、33 项走 `as_str_concat_n(33, (const char*[]){…})`）、**左到右保序**、**括号深度恒定**、helper 的两遍 NULL 替换；并在 `test/unit.ts` barrel 登记。

**文档同步**：`README-CN.md` 版本号 v0.4.88 → **v0.4.89** + 新增两条 bullet（web 构建闭合的三处根因；**web 产物是「成套」的**及其两条使用者口径，并回填「当前限制」标题版本号）+ 「单元组」计数刷新（62/65 → **72/75**，含新钉的展平形态与后端 seam 两条）；（`docs/zh-cn/html5-web.md` §1 补「产物是成套的（构建失败不回滚中间产物 / 浏览器静默复用旧 `.js`/`.wasm`）」与「相对资源 URL 以页面所在目录为基准」两段；`docs/zh-cn/display3d.md` §9 标题与新增 **§9.10「web 后端的三处对齐」**（target 注册表 / cube mip / 清屏写掩码）；`package.json` v0.4.88 → **v0.4.89**。

**遗留表**：**移出 0 行**、**新登记 2 行**（AGAL `nrm` 的归一化分量数（我方两后端都用 4 分量模长，AGAL/AIR 可能是 xyz）——**待 adl 实测**；web 无音频后端时 `Sound.loadCompressedDataFromByteArray` **抛 `#2068`** 与 `air-app.ts` 警告口径「`play()` 返 null」的差异）⇒ **86 项**（未开始 **75** / 部分完成 **10** / 暂缓 1）。

**回归**：`node test.ts` **232 passed / 0 failed**（含 examples 端到端与全部单元组）。

---

### 阶段一百一十七：Stage3D **程序缓存** —— `Basic_SkyBox` 的 **62 MB/min 内存泄漏**真根因：逐 draw 重编译（目标 v0.4.90）✅ 已完成

**范围**：用户报「运行 `Basic_SkyBox` 内存随时间增长，应该有泄露的地方」。目标平台是 **native macOS / Metal**。定位到的不是「不可达泄漏」，而是**一个随帧数线性增长的活结构**：驱动侧每帧都在新建**从不复用的**管线对象。

**一、实测复现与定性（三个工具合证）**。① **速率**：窗口激活后 `ps -o rss=` 采样 95 s，RSS 177.8 → 278.3 MB，**62.4 MB/min 线性**（`temp/skyboxmem/memtest.py`）。② **归属**：`footprint` 前后差分，增量 **100% 落在 `MALLOC_SMALL`**（+62.0 MB/60 s、+17 个 region，`temp/skyboxmem/memdiff.py`）——**不是** GC 堆（`gc` 曲线平）、**不是** GPU/IOSurface，而是**裸 `malloc`**。③ **是否真泄漏**：`leaks` 只报 304 KB（且全在系统 XPC 侧，与我们的调用栈无关）⇒ **对象仍有引用，不是不可达泄漏**。④ **是谁**：macOS `heap` 在 44 s 时报 **10,790 个 `MTLVertexDescriptor`**（≈ **2 个/帧**）与 **68,706 个 `CFString`**（约 26 MB）——2/帧这个数字指向「每帧建了**两条**管线」。

**二、根因：逐 draw 重编译两条程序 + 重建两条管线**。发射侧的程序守卫是**深度 1** 的（`if (o->program != NULL && o->program != o->gpuProgram)`，即「与**上一次**不同才重编」），而 away3d 的 SkyBox **逐 draw 交替**两套材质（铬环 1600 三角 + 天空盒 12 三角，`ASC_S3D_DUMP=1` 实测：`depth=(less,w=0)` 与 `depth=(lessEqual,w=1)` 相间）⇒ 守卫**每 draw 都命中**，`as_s3d_compile` 每 draw 跑满一次。给胶水加临时计数探针（`AS_S3D_TRACE=1`，每 60 draw 报一行）后一句话钉死：**`compile=7980, make_pso=7980`，而 draw 也是 7980**。每次编译 = 2 个 `MTLLibrary` + 1 个 `MTLRenderPipelineState`，而每条管线都带着**当次新建的 `MTLVertexDescriptor`** 交给 Metal，驱动**管线缓存会一直持有它** ⇒ 单调增长，永不回落。**WebGL 后端同形且更重**：每 draw 编译+链接一次，还附带 **512 次 `glGetUniformLocation` 字符串查找**与一次 `glDeleteProgram`。

**三、修法：程序缓存（「绑定」而非「重编译」），对齐 AIR 的 `Program3D` 语义**（`upload()` 编译一次、`setProgram()` 只绑定）。两后端共用同一形态：`s3d_compile(ctx, key, vs, fs, errbuf, n)` 新增 **Program3D 身份**参数（`emit.ts` 一行：把 `o->program` 当 key 传入，`runtime.ts` 的 wrapper 原样转发）；胶水内 `S3DProgramCache progs[S3D_MAX_PROGRAMS=16]`（LRU）+ `s3d_prog_stash`/`s3d_prog_load` 在切换时于「活程序」与槽位之间**搬移所有权**（**任一时刻只有一处持有**该 lib/fn/pso）；命中即 `return 1`，**一个字都不进驱动编译器**。槽位身份 = **Program3D 指针 + 源码哈希**（FNV-1a 64 位）：同一个 `Program3D` 可以被**重新 `upload`** 新字节码，只比指针会静默复用过期管线。`s3d_destroy` 释放整个缓存。

**四、顺带修掉两处真缺陷**。① `s3d_compile` 的**错误路径泄漏**：`newFunctionWithName:` 失败时 `vlib`/`vfn` 未释放（新加的错误路径 `release` 补齐）。② **wasm32 上 `unsigned long` 是 32 位** —— FNV 常量字面量溢出，**整个 web 构建编译失败**（`-Werror` 的过大字面量）；改 `unsigned long long` / `ULL`。这条只有 web 目标暴露，与阶段一百一十六 同类（同一份文本、两个 64 位假设不同的平台）。

**验收**。① **`make_pso` 7980 → 2**（8040 draw 只建了 2 条管线 = 两套材质），`compile` 降为纯 cache lookup；② **RSS 62.4 MB/min → 0.4 MB/min**，100 s 采样 175.8 → 176.5 MB；10 分钟长跑（600 s）**175.5 → 178.4 MB 后平台化**（`temp/skyboxmem/soak.txt`）；③ 画面逐项复核**无误**：正立天空盒（太阳左上、雪山在下）+ 镜面反射铬环、119 fps（`temp/skyboxmem/fixed-01.png`）；④ **web 版**同一源码重建后渲染同样正确（`temp/webmem/`，本地 8130 端口起 CDP 截图核对）。

**回归钉子**：新增单元组 **`stage3d/program-cache`**（**17 条**，`test/unit/stage3d.ts`）——emitter 传身份 / wrapper 转发（含无后端时的空实现）/ **两后端各自**「同源码 = 绑定而非重编」「槽位身份含源码」「teardown 释放全部槽位」「wasm32 下哈希仍是 64 位（`ULL`，不是 `UL`）」/ **命中判定必须早于第一次驱动编译**（**顺序**才构成修复：Metal 早于 `newLibraryWithSource`、WebGL 早于 `glCreateShader`）。**变异验证**（防空转）：删掉绑定那一行 ⇒ 3 条当场变红；把 `ULL` 改回 `UL` ⇒ web 侧那条变红。**诊断探针保留**：`AS_S3D_TRACE=1` 成为复查该类回归的**一行判据**（`make_pso` 必须跟随**程序数**，而非 **draw 数**）。

**文档同步**：`README-CN.md` 版本号 v0.4.89 → **v0.4.90** + 新增一条 bullet（泄漏的三工具定性 + 深度 1 守卫为何被交替材质打穿 + 程序缓存语义）；「单元组」计数 72/75 → **73/76**、`node test.ts` 用例数 232 → **233**；`package.json` v0.4.89 → **v0.4.90**；`docs/zh-cn/display3d.md` §9.11 新增「程序缓存」一节（含 `AS_S3D_TRACE` 探针口径）。

**遗留表**：**移出 0 行**、**新登记 1 行**（每 draw 重建 `MTLDepthStencilState` —— 与本次泄漏同属「逐 draw 驱动对象分配」，但**实测不泄漏**，仅抖动）⇒ **87 项**（未开始 **76** / 部分完成 **10** / 暂缓 1）。本次泄漏的**缺陷类别此前未入表**（它是「深度 1 守卫被交替程序打穿」，不属任何既有行）。

**回归**：`node test.ts` **233 passed / 0 failed**（阶段一百一十六 为 232）。

---

### 阶段一百一十八：talkmed-meeting 闭包重评估 —— 接口访问器一致性 + `extends` 内建类型文案（目标 v0.4.91）✅ 已完成

**范围**：在 v0.4.90 基线上对 `talkmed-meeting-desktop-app` 重跑评估（闭包 / 逐文件解析 / 整闭包 codegen 越墙采样），并把新暴露的语言层缺口收口。本阶段**不改**工程源码，只改编译器；所有语义对照以 `adl 51.4.1` 为裁判。

**一、闭包仪器两处缺陷（先修度量，再谈结论）**。① `lib/feathersui`（**310 个 .as**）是**必需的 source path**，却没写进 `asconfig.json` 的 `source-path`（只列了 `src`、`lib/starling/2.7`、`../ActionScript-Lib`）——**mxmlc 裁判**：不给该路径 ⇒ 报「找不到基类 `StyleNameFunctionTheme` 的定义」；给了 ⇒ 正常写出 87960 字节。旧闭包脚本照抄配置 ⇒ 全部 `feathers.*` 不可解析、闭包**少算**。新增 `closure4.ts` 补上该根 ⇒ 闭包 **709 → 710**（+`StyleNameFunctionTheme`），`feathers_themes_*` 一族墙随之消失。② 逐文件 survey 的「绝对路径列」没被使用，把 `/Users/.../ActionScript-Lib/...` 拼成了 `_lib_/ActionScript-Lib/...` ⇒ 2 条**假 ENOENT**；修正后解析 survey = **708 OK / 2 ERR / 0 HANG**（710 文件，余 2 条为一般 E4X 过滤谓词 `JSONEncoder.as` / `BigInteger.as`，均属既有登记）。

**二、新墙一：接口访问器可由「内建访问器型属性」满足（本阶段核心修复）**。整闭包 codegen 推进到新一类错误：`class 'FileItemRenderers' does not implement method 'y' of interface 'IItemRenderer'`。探针定位到 **pass 4** 的一致性检查只遍历 `methods`/`getters`/`setters`，而**内建属性是普通字段**，于是「继承 `Sprite` 拿 `x`/`y`/`width`/`height` 来满足 `IItemRenderer`」这一**AIR 完全合法**的写法被误判。**AIR 裁判（逐条实测）**：`extends Sprite implements {get/set x}` ⇒ **接受**；用户 `public var x` ⇒ **拒绝**；`extends Point`/`extends Rectangle` ⇒ **拒绝**（它们不是访问器型）；`extends Event` 的 `get type` ⇒ 接受，但 `bubbles`/`cancelable`/`target` ⇒ 拒绝。`DisplayObject` 的 `name`/`x`/`y`/`visible`/`alpha`/`rotation`/`scaleX`/`scaleY`/`filters`/`blendMode`/`transform`（`dof` 助手）与 `InteractiveObject` 的 `mouseEnabled`/`mouseChildren`/`buttonMode`/`doubleClickEnabled`/`tabEnabled`/`tabIndex`/`focusRect`（`iof` 助手）**逐项确认 ACCEPT**。**修法**：`FieldInfo` 新增 `isAccessor?: boolean`（`dof`/`iof` 置位）、pass 4 据此放行；`emitInterfaceVtables` 原用非空断言 `cinfo.getters.get(mname)!`（只放开 pass 4 会**当场崩在发射期**），改写为**按符号名去重**地发射访问器 thunk（`static double C_get_x(void* _this) { return (double)((C*)_this)->x; }`），两个接口共享同一访问器时**只定义一次**、两个 vtable 都指向它（实测 `Two_get_x` 计数 = 1 且两个 vtable 都引用它）。**运行期裁判**：同一份 4 行值日志 + 5 个布尔断言（写到继承来的属性、经接口读回、算术、反向写、`is`）在 AOT 与 `adl` 两端**逐行相同**（`temp/ifacc/`）。

**三、新墙二：`extends <内建类型>` 报「精确限制」而非空名**。`resolveType` 把 `Array`/`String`/`Number`/`Point` 这类**只作类型**的内建映射为**不带 `className`** 的 `CType`，而 superclass 注册处**盲取** `.className` ⇒ `class E extends Array {}` 报的超类名是一字面的 **`undefined`**（`unknown superclass 'undefined' of 'E'`）。现按 kind 分派：接口 ⇒ `cannot extend interface 'I'`；其余非类 ⇒ `unsupported superclass 'Array' of 'E': subclassing built-in types is not implemented`（带行列号）。**`extends Array` 本身仍是缺口**（AIR 合法，闭包内 2 个文件用它：`com.hurlant.util.der.Sequence`、`com.fiCharts.utils.graphic.StyleManager`）——本条只把**误导**改成**响亮**，已入遗留表。

**四、重测后的墙序列（施工后）**：`[0] extends Array`（语言层，已响亮）、`[1..12]` SWC/ANE 库符号（`mheader`/`fl_core_UIComponent`/`datePicker` 族/`ANEVideo`/`uploadskin`/`chatskin`/`onlineskin`/`popchatitem`/`fileitemdoctorskin`/`pluginitemskin` —— **结构性**）、`[13] unknown interface 'IDataInput'`（`TLSSocket extends Socket implements IDataInput, IDataOutput`；本子集把这两个接口的**行为**建模在 `Socket`/`ByteArray` 上，却**从未把它们注册为接口** ⇒ 显式 `implements IDataInput` 报未知接口；**新登记**）。阶段一百一十六 的两类墙（`feathers_themes_*`、接口访问器一致性）**均已消失**。

**五、重测的内建缺口面**（新脚本 `gap5.ts`：只在「**既不在源码类路径、也不在内建注册表**」时才算缺口 —— 初版 `gap4.ts` 只比内建表，把 `feathers.controls.*`/`starling.utils.*` 这些**源码可解析**的类误报成缺口，已作废）：闭包 710 文件 / 显式 import 783 / 不可解析 **282**（其中内建覆盖 124）⇒ **真缺口 158**，拆开 = **ANE 64**（产品边界）+ **`flash.*`/`fl.*` 51** + 其余 4（`adobe.utils.CustomActions`、`org.qrcode.QRCode`、`mx.utils.StringUtil`（`mx.swc` 属**代码型 SWC**）、`starling.core.RenderSupport`）。最后一条经复核**不是编译器缺口**：`starling.core.RenderSupport` 在 Starling **1.x** 才有，工程里的 Starling 2.7 只有 `starling.rendering.Painter` ⇒ 工程侧**版本漂移**（`src/com/vsdevelop/proxy/SViewControl.as` 一个文件）。`flash.*` 按命名空间：`events(9)` / `display(8)` / `desktop(7)` / `system(7)` / `net(6)` / `filters(6)` / `media(2)` / `utils(2)` / `fl.core(2)` / `errors(1)` / `accessibility(1)`。内建注册数 **174**（v0.4.79 为 153；含 `IEventDispatcher` 已注册为内建接口）。

**验收**：① `node test.ts` **235 passed / 0 failed**（阶段一百一十七 为 233；+`examples/iface-builtin-accessor.as` 端到端示例 +1 单元组）；② 新增 `examples/iface-builtin-accessor.as`（5 条断言，含**反向**验证：直接写内建属性后经接口读到同一值）；③ 新增单元组 **`emit/InterfaceAccessorThunk`**（5 条：两条 thunk 形态 + vtable 槽指向 + **去重** + 两接口共享同一 thunk）与 `diagnostics` 三条文案钉（放行形态 / 用户 `var` **仍被拒** / `extends Array` 与 `extends 接口` 的精确文案）；④ AIR 裁判两端**逐行相同**（`temp/ifacc/`）。

**文档同步**：`README-CN.md` 版本号 v0.4.90 → **v0.4.91** + 两条 bullet（接口访问器、`extends` 文案）+ 「接口」行补「内建访问器型属性可满足接口访问器」；`package.json` v0.4.90 → **v0.4.91**；评估报告 `talkmed-meeting-aot-gap-report-v2.md` 按 v0.4.91 重写（闭包 710 / 解析 708·2 / 新墙序列 / 缺口面重测）。

**遗留表**：**移出 0 行**、**新登记 2 行**（`extends <内建类型>`（含 `extends Array`）仍不支持；`IDataInput`/`IDataOutput` 未注册为内建接口）⇒ **89 项**（未开始 **78** / 部分完成 **10** / 暂缓 1）。

**回归**：`node test.ts` **235 passed / 0 failed**。

---

### 阶段一百一十九：装箱·转换·比较收口（包 A 六项）+ Array 的 ToPrimitive/ToString + Function 值 #1063（目标 v0.4.92）✅ 已完成

**范围**：从 `### 遗留待开发` 里按「补保真、验收明确、改动小」挑出的**包 A**（6 项）一次性收口，并在做探针时**顺带发现并落地一个独立包**——Array 的 ToPrimitive/ToString 与 Function 值的 `#1063` 参数个数检查。所有语义一律先以 `adl 51.4.1` 实测为准（双端探针 `temp/pkgA/`，harness `probe.py <label> <bodyfile>` 两端各跑一遍并逐行对照，末行打印 `--- N/M lines differ ---`）。

**一、包 A 六项（`### 遗留待开发` 移出 6 行）**

1. **经动态槽给对象型参数赋错类型不抛 `#1034`**（原先**静默把装箱指针当对象解引用** —— §2.4 红线里的「静默错误语义」）。`var d:Object = sprite; d.scale9Grid = 5;` 在 `adl` 上抛 `#1034`，我们原先把数字装箱对象的首址当 `Rectangle*` 读 ⇒ 槽里存进垃圾双精度。修法：**对象解箱的收敛点**带上标签/类型检查（`as_req_inst(ptr, &T_vt, "fqn")`），命中即放行、`null`/`undefined` 允许为 null、其余抛 `#1034`。**证据**：`temp/pkgA/dyn` 探针 **0/6 逐字一致**（含 `flash.geom.Rectangle` / `flash.display.Sprite` / `Array` 三种 fqn 文案）。
2. **`(标量 as Object) == 标量` 恒为 false**（`adl` 为 true）。`Object`/`interface` 静态类型的相等**不再退化成 C 指针比较**，先装箱再走 `as_v_loose_eq` / `as_v_strict_eq`。**顺带修掉该行的另一半**：`Object` 槽里的 **Array** 原先由 `as_obj_to_value` 按 tag 4 装箱，于是 `==`/`+`/`length` 都**看不见数组**（`var o:Object = [1,2]; o == "1,2"` 给 false）——现 `as_obj_to_value` 用 `as_dyn_kind(obj) == 2` 回 **tag 6**（与既有 `as_v_req_array` 的 tag-4 兜底**同源**），数组在 `Object` 槽里恢复成数组。**证据**：`temp/pkgA/verify` 探针 **0/8**（`(1 as Object) == 1`、`(5 as Object) === 5`、`(["s"] as Object)`、`Object` 槽装 `[1,2]` 的 `== "1,2"` 全对）。
3. **动态值 `x as <原始类型>` 在类型不符时应给 `null`**（我方给该类型默认值 0/NaN/false）。`as` 对原始类型的要求是「值**本身**就是该类型」，不是「转换后能用」。**证据**：`temp/pkgA/verify` 的 C/C2 行 —— `(u as int)`/`("x" as int)`/`(true as int)`/`("x" as Number)`/`(u as Boolean)`/`(null as int)` 六种**全为 `null`**，且 `var y:int = u as int` 仍是 `0`（赋值处 ToInt32）。
4. **装箱字符串参与算术/比较未走 ES3 ToNumber**。`var vv:* = "5"` 下我们原先按 `as_v_num_val` 取**数字槽** ⇒ 字符串得 0（`vv*2 = 0`、`vv-1 = -1`）。修法：`toNumberExpr` 与关系比较里 `any` 操作数改走 **`as_v_to_number`**（已含 `atof` 解析与 trim）。**证据**：`temp/pkgA/verify` 的 D/E/F 行 —— `"5"` ⇒ `10 / 4 / 2.5 / true`、`" 6 "*2 = 12` 且 `" 6 " < 6` = false（trim 生效）、`"x"` ⇒ `NaN` 且 `isNaN` = true。
5. **静态 `String` 与 `Number` 混算发射非法 C**（应像 `mxmlc` 一样**拒绝编译**）。原先落进 `default` 直拼 ⇒ `error: invalid operands to binary expression ('char *' and 'double')`（C 层报错，不是 `CodegenError`）。现抛带行列号的 `CodegenError`：`operator '*' cannot be applied to a String operand: AS3 has no implicit String-to-Number coercion`；`"5" < 6` 仍编译（关系比较在 AS3 里走 ToNumber，`mxmlc` 也接受）。
6. **`null` 字面量传给 `Number`/`bool` 形参**发射 `(double)(NULL)` / `(bool)(NULL)` ⇒ C 编译失败。现按目标类型归一：`Number` 形参给 ToNumber 结果（0）、`Boolean` 给 false。**证据**：`temp/pkgA/v78` 探针 **0/3**（`takeN(null)` ⇒ `N0`、`takeB(null)` ⇒ `Bfalse`、`var d:Number = null` ⇒ `0`）。
   - **回归修复（复盘时发现）**：上述归一把 **interface 槽**与 `object`/`function`/`class` **指针槽**并成一类，`null` 一律回 `NULL` —— 但接口是**按值传递的 `{void* obj; void* vt;}` 结构体**，裸 `NULL` 是 C 类型错误。`examples/air-starling-demo` 的 Starling `Juggler`（`_objects[i] = null`，`_objects:Vector.<IAnimatable>`）因此 `clang` 报 **`304 warnings and 2 errors generated`**（`passing 'void *' to parameter of incompatible type 'starling_animation_IAnimatable'`，`error:` 落在 Juggler.as 的两处 `_objects[i] = null`）。现 interface 单独回 `(<Iface>){ NULL, NULL }`，指针槽行为不变。**证据**：`examples/air-starling-demo` native **全量重建 `rc=0`**，C 层 **0 error**（304 warnings 与改前一致，均为既有告警）；新增钉子 `emit/NullLiteralCoercion`（7 条）。

**二、顺带落地：Array 的 ToPrimitive / ToString（新包）**。探针做 `Object`/`any` 走查时撞出一个**段错误**与一整片静默错值：`var a:* = [1,2]; a.toString()` 把 `as_array*` 当**对象指针**传给 `as_dyn_call`，后者去读元素缓冲区当 vtable 头 ⇒ `EXC_BAD_ACCESS`。ES3 里数组本就是「有 ToPrimitive 的对象」：**ToString = `join(",")`**、**ToNumber = 解析那个串**、`==` 标量时**字符串化**。
- `as_v_str_val` 的 tag 6 ⇒ `as_arr_to_str(v.ptr)`；`as_v_to_number/int/uint` 的 tag 6 ⇒ `as_str_to_number(as_arr_to_str(...))`；`as_v_loose_eq` 新增「数组 vs 标量」分支（字符串侧 `strcmp`、数值侧 ToNumber；`null`/`undefined` 排除在外 —— `[0] == false` 为 false）。
- `as_any_call` 新增 `if (v.tag == 6) return as_arr_call(...)`（**段错误修复**），并**补回被误删的最后一行** `return as_dyn_call(v.ptr, name, args, argc);`（丢它的后果是 `push` 返回不了新长度、`vector-dynamic.as` 报非 void 警告）。
- 新增运行时 `as_arr_call`（按名分派 `toString`/`valueOf`/`join`/`push`/`pop`/`shift`/`unshift`/`indexOf`/`insertAt`/`removeAt`/`slice`/`splice`/`reverse`/`concat`/`map`/`filter`/`sort`/`sortOn`）与 `as_join_sep`（**`join(null)` 的分隔符是字符串 `"null"`、`join(undefined)` 才取 `","`** —— ES3 15.4.4.5，实测确认）；`as_array_join` 的 NULL 元素也给出 `"null"`。
- **证据**：`temp/pkgA/{arrstr,arrnum,arr2,arr3,arr4,arr5,eq}` 七个探针 —— `arrstr` 0/4、`arr2` 0/6、`arr3` 0/6、`arr4` 0/9、`arr5` 0/4、`eq` 0/9；`arrnum` **1/4**，唯一残差是 `Number({})`（对象字面量的 ToPrimitive ⇒ NaN，**已新登记**）。另实测确认 `[[1,2],[3]]` ⇒ `"1,2,3"`（嵌套数组递归字符串化）、`[1,2] == "1,2"`、`[0] == false`。

**三、顺带落地：Function 值的 `#1063` 参数个数检查（新包）**。原先**宽松放行**，而 AIR 会抛 —— 更要命的是它把一个 **1 参闭包的 0 参调用**送进解箱路径（`args` 为 NULL）⇒ **段错误**（lldb：`EXC_BAD_ACCESS ... _fn0__call ... args[0]`）。**AIR 规则（探针 `temp/pkgA/arity{,2,3}` 逐条实测）**：`(a:int)` 用 0 或 2 个实参 ⇒ `#1063`；`(a:int,b:int=2)`（req=1/max=2）0 或 3 个 ⇒ `#1063`，1~2 个 OK；`(a:int=1)`（req=0/max=1）2 个 ⇒ `Expected 0, got 2`；**`()` 与 `(...rest)` 任意个数都放行**（AIR 把 0 参闭包建成变参）。`Expected` = **必需参数个数**（首个可选/rest 之前），与既有的构造器口径一致。
- 修法：新增 `as_fn_arity_error(qname, expected, argc)`（消息逐字 `Error #1063: Argument count mismatch on <qname>(). Expected <req>, got <argc>.`，`ArgumentError` 编号 1063），`emitThunk`/`emitThunkBody` 增加 `qname` 参数，**非构造器分支**在**任何解箱之前**插守卫（`req == 0 && max == 0` 与 rest 形态整条跳过）。
- **qname 口径（逐条实测）**：实例方法 `<fqn>/<m>`（`foo::Widget/m`）、静态方法 `<fqn>$/<m>`（`K2$/stat`）、具名函数表达式 `Function/<name>`（`Function/onError`）、顶层函数 `Function/<name>`。**三处不逐字、已登记**：接口/父类接收者 AIR 报**方法定义类**（`InteractiveObject` 上的 `dispatchEvent` 报 `flash.events::EventDispatcher/dispatchEvent`）、匿名闭包 AIR 报 `Function/<file>.as$N:anonymous`（AVM2 内部序号，不可复现）、顶层函数因 `mxmlc` 不接受「包级函数值 + 主类同文件」而**无法构造对照**。
- 顺带：**接口名不再泄漏 C 标识符** —— 新增 `InterfaceInfo.reflectFqn`（`foo::IFoo` / `flash.events::IEventDispatcher`），`fnQName` 优先取它（原先打印的是 `foo_IFoo/m` 这种 sanitized C 名）。**证据**：`arity2` **0/5**、`arity`/`arity3` 除 qname 外全绿（4 条差全在匿名闭包名）。

**四、验收**：① `node test.ts` **238 passed / 0 failed**（阶段一百一十八 为 235，+3 = 三个新单元组；unit **77 → 80** 组、examples **161** 例、耗时 417.2 s）；② 新增三个单元组 —— `emit/ArrayToPrimitive`（10 条：`as_v_str_val`/`to_number`/`to_int`/`to_uint` 的 tag-6 形态、loose-eq 的数组分支、`as_any_call` 的**两条**（tag 6 分派 **+ 保留的 `as_dyn_call` 兜底**，后一条专防「误删最后一行」复发）、`as_join_sep` 与常量 `null` 折叠）、`emit/FunctionArityQName`（12 条：消息七段与 1063、五种 qname、**守卫在解箱之内**、0 参/rest **不发**守卫、可选参仍封上界、接口**不泄漏 C 键**）与 `emit/NullLiteralCoercion`（7 条：**`Vector.<Iface>[i] = null` 必须发 `(<Iface>){ NULL, NULL }` 且接口元素 setter 按值收结构体**、不存在裸 `NULL` 的接口元素写入、`var x:Iface = null` 的初始化对、`Object`/`String` 槽仍裸 `NULL`、`Number`/`Boolean` 槽归一不变）；③ 双端探针 **17 组**（`vals tonum tonum2 tonum3 dyn eq arrstr arrnum arr2 arr3 arr4 arr5 arity arity2 arity3 verify v78`）；④ `examples/air-starling-demo` native 全量重建通过（本轮回归修复的端到端验收，见包 A 第 6 项）。

**文档同步**：`README-CN.md` 版本号 v0.4.91 → **v0.4.92** + 三条 bullet（装箱/转换/比较收口、Array ToPrimitive、Function #1063）；`package.json` v0.4.91 → **v0.4.92**。

**遗留表**：**移出 6 行**、**新登记 3 行**（AIR 数值解析/格式化极值；对象字面量/类实例的 ToPrimitive；Function 值 #1063 的 qname 面）⇒ **86 项**（未开始 **75** / 部分完成 **10** / 暂缓 1）；其后归因时又**新登记 1 行** ⇒ **87 项**（未开始 **76** / 部分完成 **10** / 暂缓 1，见表末行）。

**性能验收（benchmarks 重跑，2026-10-08）**：`AIRSDK_HOME=…/AIRSDK_51.4.1/bin python3 benchmarks/run.py` 三个独立批次（`temp/bench/batch{1,2,3}.txt`；跑前删干净 `~/Library/Application Support/bench.*/Local Store/*_air.log` 以免静默读到上一轮），8 项四路结果一致。**7/8 项与 v0.4.69 基线持平（±3%，噪声内），唯 `oop` +78%（55 → 98 ms）**；C/JS/AIR 三列的批间漂移 ≤4% 证明机器可比（`temp/bench/agg.py`）。归因：本轮 `unboxAny` 给**动态值 → 具名类槽**的赋值补上了 `#1034` 运行时校验（v0.4.69 发射的是未检查的裸 `as_v_obj_val`），而 `oop.as` 的热循环正是一次 `var s:Figure = shapes[j % 192]`。**AIR 确证该检查必需**（`temp/pkgA/arrcoerce` 双端探针 **0/6**：`Array` 里的 `Number`/`String`/对象 ⇒ `#1034`，子类 `MovieClip` ⇒ 通过 ⇒ **必须走祖先链、不能只比较 vtable**，`null` ⇒ 通过）。变体 A/B 归因（`temp/bench/oopattr/`；v0=97.5 / v1 去安全门=89.5 / v2 换回未检查=55 / v3 裸 `%`=97 / v5 平凡函数体=54 / v6 精确-vtable 快路径=98）⇒ **43 ms 全部是检查本身**、安全门仅 8 ms、余 ~35 ms 是**祖先链的两级依赖随机访存**（语义要求，省不掉；精确匹配快路径救不了，因为元素都是子类实例）。**按 §1.5 如实登记为语义代价**，不静默降级；`benchmarks/README.md` 新增「本次结果（编译器 v0.4.92）」一节（含对比表与归因表），`benchmarks/oop/report.md` 重写为「~48 ms 本体 + ~7 ms 全局槽位 + ~43 ms 类型检查 = 98 ms」的三段分解。

**回归**：`node test.ts` **238 passed / 0 failed**（417.2 s）。

**性能归因深挖（`array` / `strings`，2026-10-08）**：承上面 benchmarks 重跑，把两项的差距逐层拆到根因；**两份旧报告的核心机理被实测证伪并已重写**。

- **`array`（5.41× C，119 vs 22 ms）**：根因是 **`int` 累加器被迫走 `double` 域**（`sum:int += a[j]`，`a[j]:*` ⇒ 按 AS3 语义必须发动态加法 ⇒ 每轮 `int→double→int` 往返构成**循环携带依赖链**，约 12 周期），**不是每元素体积/内存带宽**。变体归因（`temp/bench/invest/attr.py` / `array_opt.py` / `array_chain.py`）：**保留全部 24 B 装箱读与 ≈480 MB 搬运、只去掉该往返 ⇒ 119 → 21 ms**（等效带宽 ≈4 → **22.8 GB/s**）；守卫 0 ms、边界检查 3 ms、`as_add_v`/`as_array_get`/`as_v_req_obj`/`as_v_to_number` **全部被 -O2 内联**（`clang -S` 无对应 `bl`）、tag 检查已成位掩码 + 单条 `umaddl`。**纯 C 同写法对照**（同访存、只差往返）：`s = s + a[j]` **30 ms** vs `d = (double)((int)d + a[j])` **116 ms**（3.9×）⇒ 是**纯 C 也一样**的代价。**AIR 自己 133 ms（6.05× C）**，同样付这笔语义代价。**修正**：旧报告把 5.41× 归为「带宽受限」（480 MB ÷ 116 ms ≈ 4.1 GB/s「与 C 同量级」）——该推理被 v1 直接证伪（同访存、去依赖链即 5.5× 提速），旧读数是被**延迟**压出来的。
- **`strings`（3.04× C，243 vs 80 ms）**：**96% 在 `split().join()` 的分配上**（去 split/join ⇒ 10 ms；零分配下限 ⇒ 0 ms；字符串扫描本身**免费**）。拆到分配器：`as_str_alloc` 改走 arena bump 即 **248 → 152 ms** ⇒ **每次分配 ≈21 ns、合计 ~93 ms、占 38%**；`gc_collect` 加计时实测 **60 次回收、累计 49.8 ms**（源码里写死的 6 次显式 `System.gc()` 只值 ~9 ms，自动触发才是大头）；`gc_alloc` 计数探针 **5,700,645 次**（其中字符串 ≈420 万）。**关掉回收反而慢 3×（733 ms）** ⇒ 单次分配成本的主因是 **free-list first-fit 遍历随表长线性退化**，而它属**运行时实现**（可改 size-class 分级空闲链）、**不是「前端做优化」**，故旧报告「装箱税固有、无头部空间」**过于悲观**。
- **附带发现并登记一个语义缺陷**（本表末行）：`emit.ts` 的 `unboxAny()` 在 `int`/`uint`/`bool` 三个分支用**原始解箱**（`as_v_int_val`/`as_v_uint_val`/`as_v_bool_val`，只读 `v.num`）而非 AS3 强转 ⇒ 动态值为**字符串**时给 0/false。双端探针 `temp/pkgA/unboxcoerce` **4/8 行不同**（`var b:Boolean=("x":*)` adl true/我们 false；`var i:int=arr[0]`（`"7"`）adl 7/我们 0；`uint`、`obj.k` 同理），复合赋值形态见 `temp/pkgA/intadd`（adl 5/我们 0）；**条件判断与显式 `int()`/`Boolean()` 强制转换均正确**，故面窄。

**回归**：`node test.ts` **238 passed / 0 failed**（417.2 s）。

---

### 阶段一百二十：动态槽强转家族收口（`unboxAny` 原始解箱）+ GC 尺寸分级空闲链（目标 v0.4.93）✅ 已完成

**范围**：两项互不相干的**既有缺陷**——① 从 `### 遗留待开发` 移出末行（`unboxAny` 的 `int`/`uint`/`bool` 分支用原始解箱而非 AS3 强转）；② `benchmarks/strings` 归因时实测出的**运行时分配器退化**（单条 first-fit 空闲链）。两项都以「同一份生成 C 的 A/B」或双端探针逐行对照为验收。

**一、动态槽强转家族（第 ① 项的**扩大范围**）**

遗留表登记的是 `unboxAny()` 的三个分支，实测发现**这是一个族的收敛点**：`unboxAny` 是所有「动态值 → 具体标量槽」的翻译终点，而**任何**动态值落到具体标量槽都要走 AS3 强转（`ToInt32`/`ToUint32`/`ToBoolean`/`ToNumber`/`ToString`），不是「读联合体的数字槽」。故按用户「都修复」的口径**把整族收敛点一次收口**（10 处 `emit.ts` 发射点 + 9 处 `runtime.ts` 助手）：

- `emit.ts`：`unboxAny` 的 `int`/`uint`/`bool` 三分支；`toInt32Expr`/`toUint32Expr` 的 `case 'any'`；`Vector` 的 spread-push 元素、`toVector`、动态 `fixed`/`length` 的写入、动态方法实参；`String` 动态方法的 **10 处** int 实参；`Graphics_beginGradientFill`。
- `runtime.ts`：`as_dyn_set` 的 `bool`/`int`/`uint`/`Number`/`String` 五类字段写入；`as_array_key_set` 的 `length`；`as_array_filter` 的索引参数；`as_cmp_num`/`as_cmp_cb`/`as_cmp_sorton` 的比较器返回值；Proxy 的 `hasProperty`/`deleteProperty`/`nextNameIndex` 返回值。
- **原始解箱助手保持不变**（`as_v_int_val`/`as_v_uint_val`/`as_v_bool_val`/`as_v_num_val`）：它们是热路径上「只读联合体数字槽」的正确形态（静态类型已知是数值时用），改它们会**静默改动约百处**调用点；改为在注释里写明适用范围，并用单元钉子（`emit/DynamicSlotCoercion`）把「raw 助手不带 String 分支」与「发射点绝不用 raw 助手」**同时**钉住。

**顺带修掉两个同族缺陷**（都是做探针时实测撞出来的）：

1. **`String` → `int`/`uint`/`Number` 走 ES3 ToNumber**（不是 C 的 `atoi`/`atof` 前缀解析）。实测（`temp/pkgA/intcoerce`，`adl 51.4.1` 双端）：**隐式赋值与显式 `int(s)`/`uint(s)`/`Number(s)` 都是整串 ToNumber** ⇒ `int("10x")` = **0**（我们原先 10）、`int("5abc")` = **0**（原先 5）、`int("0x10")` = **16**（原先 0）、`int(" 7 ")` = 7、`int("")` = 0。修法：`as_v_to_int`/`as_v_to_uint` 的字符串分支改 `as_to_int32/uint32(as_str_to_number(ptr))`，`emit.ts` 的 `int(String)`/`uint(String)`/`Number(String)` 同步。**`Boolean(String)`（非空即 true）与 `parseInt`/`parseFloat`（前缀解析器，另一族）不动**；`as_str_to_i64` 的**十进制前缀**解析也**刻意保留**（`int64` 要走 double 再回来会丢 >2^53 的精确性，属增强取舍），只把已经失真的注释改正。
2. **数组的字符串数字键**（`a["1"] = 42`）原先**根本不落到元素上** —— `as_dyn_set` 的 `dk == 2`（数字键）分支接了 `as_array_key_set`，字符串键分支没接（`as_any_set` 的 tag 6 同理）。现两处都按「先按 ES3 数组索引规则判定（`"1"` 是索引、`"01"` 不是）、是索引才走 `as_array_key_set`」路由。

**热路径性能护栏（否则 `array` 基准会回退 45%）**：`array.as` 的热循环每轮做一次「动态元素 → `int` 累加器」强转，共 2000 万次。直接把收敛点改成通用强转助手会让 clang **拒绝内联**（`clang -Rpass-missed=inline` 实测：`inline cost: 595`，阈值 **325**；原因是被调的 `as_str_to_number` 大），代价 **116 → 169 ms**；把慢路径拆成独立助手再让单调用者的包装内联也**不行**（clang 对单调用者会**折回合并**，实测无效）。可行形态：让通用助手保持**多调用者**、另加两个**极小包装** `as_v_int_cast`/`as_v_uint_cast`（tag 1/2 直取 `as_to_int32/uint32(v.num)`，其余 tag 转交通用助手），实测 **117–118 ms**（与原始解箱同速），且语义与通用助手**逐 tag 相同**（非数值 tag 一律转交 ⇒ 强转规则只有一份）。

**二、GC 尺寸分级空闲链**

`benchmarks/strings` 的 570 万次 `gc_alloc` 里字符串约占 420 万，而 `gc_alloc` 的空闲链是**单条 first-fit**（从头线性找第一个够大的块）⇒ 表越长越慢（阶段一百一十九 归因：把 `as_str_alloc` 换成 arena bump 即 248 → 152 ms；关掉回收反而慢 3×）。本轮按**尺寸分级**重构空闲链（`runtime.ts`）：

- `gc_free_small[GC_SMALL_CLASSES]`（`GC_SMALL_ALIGN 32`、`GC_SMALL_CLASSES 16`、`GC_SMALL_MAX 512`）+ `gc_free_mid` + `gc_free_big`；`gc_small_class(size) = size / 32`（≥ `GC_SMALL_MAX` 回 −1）、`gc_free_list_for(size)` 按同一规则分类（**释放侧与查找侧共用同一函数**，保证「块必然可被找到」）。
- `gc_find_block` 从**请求尺寸所属的类**开始**向上爬**（同类内仍做 `h->size >= size` 有界检查）—— 因为块尺寸**不取整**（精确尺寸，`free_bytes` 的段账目与 `gc_release_empty_segs` 的判定逐字不变），同类的块可能比请求小。
- 4 处手写遍历（审计/统计路径）统一收口到 `li < GC_SMALL_CLASSES + 2`。

**A/B（同一份生成的 C，只改分配器，`temp/sc/`）**：

| 变体 | strings (ms) | binarytrees (ms) |
|---|---|---|
| 老的两分链（`free_small` + `free_big`） | 248 / 251 / 273 | 97 / 98 |
| **尺寸分级（本轮）** | **211 / 211 / 212** | **103 / 104** |
| 反向实验：分级但**只搜精确类**（不爬类） | — | **442596（7m23s！）** |

三条结论：① 分级让 `strings` 的小分配从「链长线性退化」变成**类内 O(1) 命中**（−15%）；② `binarytrees` **+6%** 是同一容器内的代价（每块分类 + 多链头读取），属可接受的权衡（该基准的箱子尺寸集中，老的单链 LIFO 恰好最省）；③ **爬类是承重的**——反向实验（只搜请求尺寸的精确类、不向上爬）让 `binarytrees` 从 103 ms 变成 **442596 ms（4300×）**，因为它再也复用不到任何偏大的块、只能不断切新段 ⇒ 该设计**不是**随手可去的复杂度。

**三、验收**

- `node test.ts` **240 passed / 0 failed**（unit **80 → 82** 组；新增 `emit/DynamicSlotCoercion` **31** 条、`runtime/GcSizeClasses` **12** 条）。
- **双端探针 24 组**复核（`temp/pkgA/`）：`unboxcoerce` **4/8 → 0/8**、`coerce2`/`coerce3`/`coerce4`/`coerce5`/`arrkey`/`arr2`~`arr5`/`vals`/`dyn`/`eq`/`verify`/`tonum`/`vecstr`/`arrcoerce`/`cast2` 全 0；`intcoerce` 只剩 `parseInt` 一行、`tonum2` 只剩 `1e308` 打印一行（均已入遗留表）。
- **顺带修掉一条陈旧单元钉子**（教训重复两次）：`test/unit/display.ts` 的 `display/LineMetrics` 钉的是**旧坐标**（`as_v_int_val(args[0])`）—— `TextField.getLineMetrics` 的 int 形参走动态分派后**必须强转**，已改为 `as_v_int_cast(args[0])`。
- **benchmarks 8 项四路结果一致**（`temp/bench/v0493.txt`）：`strings` **243 → 210（−14%）**、`array` **119 → 118**（阶段一百一十九 归因里那个「直接调通用助手即 +45%」的回退已被本轮的 cast 包装**归位**） 、`binarytrees` **97 → 103（+6%，见上表）**、`fib` 285、`nbody` 200、`mandelbrot` 120、`spectralnorm` 39、`oop` 91。**跨轮归因只认 >10% 的变化**：本轮 C 列（与本编译器无关）同期漂了 **−0…−9%**（`oop`/`array` 最明显），故 `oop` 的 98 → 91 落在机器漂移内、**不作归因**；`strings` 与 `binarytrees` 两条都有**同 C 的受控 A/B**佐证，才是真实的。

**文档同步**：`README-CN.md` 版本号 v0.4.92 → **v0.4.93** + 两条 bullet（动态槽强转家族 / GC 分级空闲链）+ 单元组计数（80 → 82 组、238 → 240 用例）；`package.json` v0.4.92 → **v0.4.93**；`benchmarks/README.md` 新增「本次结果（编译器 v0.4.93）」一节，`benchmarks/{strings,binarytrees,oop}/report.md` 同步本轮数字与归因。

**遗留表**：**移出 1 行**（`unboxAny` 的 `int`/`uint`/`bool` 原始解箱，已落地）；**新登记 4 行**（本轮探针顺带实测出的同族/邻域缺口：`DisplayObject.name = null` 应抛 `#2007`、越界读 `undefined`、静态 `Array` 的 `in` 与越界键、`parseInt`/`parseFloat` 的 radix/NaN）⇒ **90 项**（未开始 **79** / 部分完成 **10** / 暂缓 1）。

---

### 阶段一百二十一：`System.totalMemory`/`freeMemory` 的 O(n) 堆遍历 —— 「一卡一卡」的真根因（需求方是 stats HUD）（目标 v0.4.94）✅ 已完成

**触发**：用户报「基准数值几次差不多，但动画一卡一卡」，问是不是 GC。

**先证伪 GC（三条独立证据）**：① 探针在**所有**长帧上 `worstgc=0.00`；② `ASC_GC_THRESHOLD=1<<60` 完全关掉回收后卡顿**逐字相同**（`over17ms=17`，峰值反而更高、RSS 涨到 1.8 GB）；③ 把预算/阈值放大到探针**确实**测到 GC（`gcmax=9.93 gcavg=0.53 gcshare=5.7%`）⇒ 探针对 GC 敏感，故阴性结论可信；`sample` 里 `gc_write_barrier` 仅 0.74%、`gc_scan`/`gc_mark`/`gc_sweep` **零采样**。

**定位**：给探针加**帧序号**日志（`SLOWF idx=… dt=… gc=…`，>12 ms 才打）后，长帧是**严格每 30 帧一次**（间隔=30 出现 137 次；`idx mod 30` 单一残差 158 次 vs 均匀期望 10.5）——**确定性周期**而非随机越预算（注意：该 30 帧周期项是 harness 的 `bench-auto` 打开的 `BENCH` 跟踪行造成的，验证方法正是把它关掉：间隔=30 从 140 → **1**；故下面用计时而非周期去定位）。给 `BENCH` 分支做**五段计时**，真凶当场现形：

| 段 | p50 (ms) |
|---|---|
| `numChildren` | 0.000 |
| `numToFixed` | 0.002 |
| **`totalMemory` + `freeMemory` + `privateMemory`** | **8.423** |
| 16× `as_str_concat` | 0.151 |
| `fputs`+`fflush` | 0.011 |

根因：`gc_heap_used_bytes()` 是**遍历 `gc_all` 整条对象链求和**的线性函数（O(存活对象数)），`as_system_total_memory()`/`as_system_free_memory()` 各调它一次。**需求方正是 stats HUD**：`src/starling/core/StatsDisplay.as:118` 的 `_memory = System.totalMemory * B_TO_MB`，`UPDATE_INTERVAL = 0.5` ⇒ 用户按 SPACE 开的白框 **每 0.5 秒**让一帧多花 ~6.4 ms、掉两帧。

**修法**：改为 **O(1) 镜像**——`gc_all_bytes`/`gc_new_bytes` 在两个入链点（`gc_alloc` 的 IDLE / `gc_new` 分支）、两个 `gc_new` 拼接点（`gc_finish_cycle`/`gc_collect`）、一个出链点（sweep 释放）各维护一次；线性遍历**仅保留在 `if (gc_audit_on())` 的交叉校验分支**（照镜子校验，不参与快路径）。镜像的语义定义与遍历**逐字相同**（头 + 载荷），周期内的 `gc_new` 块先计在 `gc_new_bytes`、拼接时并回，故**任何时刻**都等于遍历值（不只是周期间）。

**证据**：
- **数值逐字不变**：`ASC_GC_AUDIT=1` 下每次 `totalMemory` 调用都与原遍历比对，**278 次比对 0 处不一致**，且无其它 `[gc-audit]` 抱怨。
- **调用成本**（同一份生成 C 的 A/B）：`BENCH` 分支三段计时 **8.652 → 0.099 ms（p50，87×）**，其中内存三连 **8.423 → 0.013 ms（650×）**；读数不变（`mem=134.1MB` 同量级）。
- **用户路径 A/B**（`temp/hidpi/jank/hud_probe.py`：激活窗口 → 按 SPACE 开 HUD → 录 `HUDT`）：`StatsDisplay.update()` **p50 6.436 → 0.407 ms**、max 9.479 → 3.972 ms；同段帧分布 p99 **39.15 → 12.66 ms**、`over17ms` **27 → 0**（截图 `temp/hidpi/jank/hud_on.png`：绿框已开、`std memory 50.2` 即该 API 读数）。
- **回归**：全量 `npm test` **241 passed / 0 failed**（含 6 个既有内存/GC 示例 `gc_bytes`/`gc_alloc_threshold`/`gc_incremental`/`gc_strings`/`stage52`/`stage57`）；新增单元组 `unit: runtime/MemoryQueryO1`（7 项）钉住「快路径不许出现遍历 + 每个链变更点都必须改镜像」，防回归。
- **顺带（同轮，无帧分布收益）**：`ByteArray` 的逐元素端序助手 `as_ba_put_u32`/`as_ba_get_u32` 改为「探测一次 + 无条件 4 字节 `memcpy` + 可选可移植字节反转（clang 出 `rev`+`csel`）」，并把 `strcmp`/指针缓存填充拆成冷函数 ⇒ 两助手**被完全内联**（`nm` 已无符号）、单次存储从 3 分支 4 条字节写变成 **1 条 `str`**，语义由 `examples/reg-bytearray-endian.as` 钉住。它对帧分布**无影响**（`over17ms` 不变）——真正的收益在本阶段的 O(1) 镜像。

**未修（不在本阶段范围）**：修后 `StatsDisplay.update()` 仍有 **p90 3.1 ms** 的固有成本，来自它自己的 `_values.text` 文本纹理重建（与内存 API 无关，属阶段一百零四 的合批口径）。**不登记为遗留行**（是性能项、不是语义缺口，与 `### 遗留待开发` 的口径不同）；故遗留表项数不变（**92 项**）。

**文档同步**：`README-CN.md` 版本号 v0.4.93 → **v0.4.94** + 一条 bullet；`package.json` v0.4.93 → **v0.4.94**；单元组计数 82 → **83 组**、240 → **241 用例**。

---

### 阶段一百二十二：`new <动态 Class 值>` 的操作数收口 + `[Embed]` **打包范围**实测（目标 v0.4.94 → v0.4.95）✅ 已完成

**触发**：用户贴了 `away3d-core/Basic_Stereo` 的失败构建（485 sources、40 embedded assets，停在 `Codegen error at 446:6: dynamic instantiation requires a Class reference`）并问两件事：① `[Embed]` 到底是**按代码里真实内嵌的内容**打包，还是**把所有资源一起**打包？② 这个 demo 为什么编不过？

**Q② 根因（一行代码，三道门）**：`src/Intermediate_MD5Animation.as:446` 是 `AssetLibrary.loadData(new ANIM_CLASSES[i](), null, ANIM_NAMES[i], new MD5AnimParser())`，而 `private const ANIM_CLASSES:Array = [HellKnight_Idle2, …]` 装的是 **`[Embed]` 生成的资源类**。`emitIndex` 对 `Array` 下标的静态类型是 **`any`**，而 `emitNewDynamic` 只在 **`class`** 时放行 ⇒ 直接 `CodegenError`。这是**同一门语言里自相矛盾**：`lookupObjectVar` 与限定静态字段分支（`sf.type.kind` 可能是 `class`/`object`/`any`）早就接受后两种形态，`dynNewCode` 也已按 `any` 发过 `as_v_new_class`。

**修法**：`emitNewDynamic` 的守卫接受 `class` | `object` | `any`，诊断文案用 `describeType` 点名实际操作数类型；`dynNewCode` 按操作数静态形态取类指针——`any` ⇒ 装箱值经 `as_v_new_class` 解箱、`object` ⇒ 裸指针经 `as_new_class_ptr`、`class` ⇒ 指针本身。两个新助手在 `RUNTIME_PREAMBLE`（挨着 `as_v_as_class`）里**失败关闭**：`tag != 4` / `ptr == NULL` / `gc_in_heap(ptr)` 任一命中即 `NULL`，否则必须是**类注册表恒等**（`as_v_is_class`）才给出 `as_class*`。于是 `new x()` 与 `x is Class` 是**同一个谓词**，非 Class 一律 `NULL` 交给既有 `as_dyn_new` 抛 AIR 的 `TypeError #1007`——**绝不会**把普通对象的载荷当 `as_class` 解引用（那会变成野调用）。

**刻意更严的一处（已注释说明）**：静态判为**标量/数组/函数**的操作数（`int`/`String`/`Boolean`/类实例/`Array`/`Function`…）仍在**编译期响亮报错**——`mxmlc 51.4.1` 实测只给 warning 就收（`temp/dynnewop`：`new (n)()`、`new (s)()`、`new (a)()`、`new (f)()`、`new (null)()` 全部编过），故这是**本子集对无意义输入更严**，不是 AIR 定义的行为；`adl` 侧那批形态的 `#1007` 未能复测（空 trace 输出 / `Killed: 9`），故不写进文档当口径。

**Q① 答案（同轮实测，登记为新遗留行）**：**不是**按真实内嵌内容——`--air-app` 的 `walk(srcDir)` 收 `<appRoot>/src` 下**所有** `.as`（`Basic_SkyBox` 与 `Basic_Stereo` 各 485 个），**没有可达性分析** ⇒ **每一个** `[Embed]` 都成为资源：`embed 40 asset(s)` / **4,969,434 B（4.74 MB）**，日志里堂而皇之列着**别的 demo** 的资源（`Basic_SpriteSheetAnimation.testSheet1/testSheet2`）。而且它们**真的存活进产物**：`as_class_registry[]` 引用每个类对象，而 `away3d/utils/Cast.as` 的 `getDefinitionByName` 让 `as_get_definition_by_name` 可达 ⇒ 注册表是活的 ⇒ `-O2` 剪不掉嵌入工厂与字节数组。**判据是二进制字节**：在**不**使用它们的 `Basic_Stereo`（34,134,400 B）里，`road.jpg`/`rockbase_normals.png`/`idle2.md5anim`/`grimnight_posX.png` 各自的 48 字节中段**各出现 1 次**（`Basic_SkyBox` 里同项亦各 1 次，其中三个是它**没用**的）。对照 `mxmlc`/`adl` 的**传递编译**（`-source-path+=src` + `$MAIN_SRC`，只处理可达类的 `[Embed]`）：SWF 体积即证——`Basic_Stereo.swf` **94 KB**（它**自己不声明任何**嵌资源）、`Basic_SkyBox.swf` 746 KB ≈ 它自己的 6 张天空盒（645,180 B）、`Basic_UVAnimation.swf` 421 KB ≈ 它自己的 2 个资源（326,601 B）、`Intermediate_MD5Animation.swf` 2.71 MB；全 40 个会 ≥4.6 MB。**连带后果**：**不可达类里的坏/缺失 `[Embed]` 会让我们编译期失败**（`adl` 构建无恙）——属窄口径的保真缺口，已入遗留表。

**证据**：
- `Basic_Stereo` **现在编得过**（34,134,400 B，约 36 s），`Basic_SkyBox` 重建（34,150,992 B），两者都启动 10 s 无早退；天空盒**画面复核**：`temp/dynnew-verify/skybox-new2.png`（2048×1600）是雪山天空盒 + 环境反射铬环、`FPS:119`，近黑像素 **0.2%**（若 `[Embed]` 的 `new data()` 路径破了，`SingleFileLoader.parseData` 会 `#1007`、场景无贴图 ⇒ 整屏纯黑，而实测是 99.8% 非黑）——这正是被改动的那条路径（`if (data is Class) data = new data();`）的端到端反证。
- 新增示例 `examples/dynnew-operand.as`（`test/examples.ts` 自动发现，一示例一用例）：数组元素（字面量索引 + 变量索引）、`Vector.<Class>` 元素、成员链 `new h.list[0]()`、带实参（走 ctor thunk）、`expect1007` 覆盖 String/Number/Boolean/实例/Array/null/数组元素/Vector 元素/Object 静态类型非 Class，以及 `is Class` 与 `new` **判定一致**（`if (candidate is Class) return new (candidate)();`）⇒ `dynnew-operand: all assertions passed`。
- 新增单元组 `unit: reflection/DynNewOperand`（16 条）钉**源级形态**：`as_v_new_class(as_array_get(`、`as_new_class_ptr((void*)(g_o))`、`Vector.<Class>` 取值不被二次解箱、`is Class` 走注册表恒等、`#1007` 的调用链、以及标量操作数的诊断文案（含 `int`）。
- **回归**：全量 `npm test` **243 passed / 0 failed**（单元组 84/84）。

**文档同步**：`README-CN.md` 版本号 v0.4.93 →（上阶段）v0.4.94 → **v0.4.95** + 两条 bullet（`new` 的操作数收口；`[Embed]` 打包范围为已知偏差）；`docs/zh-cn/embed.md` 新增 **§7「编译范围：谁的内嵌会被打包」**；`package.json` v0.4.94 → **v0.4.95**；单元组计数 83 → **84 组**、241 → **243 用例**；遗留表 94 → **95 行**（新登记 1 行）。

**遗留表**：**新登记 1 行**（编译范围 = 整个 `src/`，无可达性分析 ⇒ 其它 demo 的 `[Embed]` 被打包并存活进产物 + 不可达类的坏 `[Embed]` 让我们编译期失败）；**移出 0 行**。

---

### 阶段一百二十三：成员解析的**最近声明**规则 —— 本类访问器遮蔽**继承字段**（`Intermediate_MD5Animation` 的 `#1009` 真根因）（目标 v0.4.95 → v0.4.96）✅ 已完成

**触发**：用户报 `away3d-core/Intermediate_MD5Animation` 运行即死——
`node ../../src/index.ts --air-app ./Intermediate_MD5Animation-app.xml --main-class Intermediate_MD5Animation --target native --run`
只打一行 `Uncaught exception: Error #1009: Cannot access a property or method of a null object reference.` 便退出（构建本身 `EXIT=0`）。

**一、根因：`fields` 继承扁平化 + 读取侧「先字段、后访问器」的次序，让**祖先的字段**盖住了**本类的 getter**

lldb 断在 `fprintf` 拿到调用链（`-O2` 下符号仍可读）：
`Intermediate_MD5Animation_init/initObjects` → `ObjectContainer3D_addChild` → `ObjectContainer3D_setParent` →
`ObjectContainer3D_updateMouseChildren` → `as_req_obj` → `as_throw`。失败源码行是 `src/Intermediate_MD5Animation.as:358`
的 `redLight.addChild(new Sprite3D(redLightMaterial, 200, 200));`，而生成 C 里 `updateMouseChildren` 发的是
**`this->parent`（裸结构体字段读）**，不是 `this->vtable->get_parent(this)`。

`updateMouseChildren` 的 AS3 正文（`src/away3d/containers/ObjectContainer3D.as:218`）读的是**访问器** `parent`：

```as3
if (_parent && !_parent._isRoot) {
    _ancestorsAllowMouseEnabled = parent._ancestorsAllowMouseEnabled && _parent.mouseChildren;
} else
    _ancestorsAllowMouseEnabled = mouseChildren;
```

`ObjectContainer3D.as:533` 声明 `get parent():ObjectContainer3D`；而我们**内置的 `EventDispatcher`**（`src/symbols.ts`）把
**显示列表的祖先链接**存成一个**同名字段 `parent`**（AIR 的 `EventDispatcher` 根本没有 `parent`，两者在 AIR 上永不照面）。
`ClassInfo.fields` 是**继承扁平化**的（含继承成员），`fieldSlot()` 于是返回了**祖先那一条**，而成员读取路径**先查字段、后查访问器**
⇒ 读出的是「away3d **从不赋值**」的那个槽（away3d 自己的场景图用 `_parent`）⇒ `as_req_obj(NULL)` 抛 `#1009`。

**为什么只有这个 demo 中招**：`Scene3D.as:35` 把 `_sceneGraphRoot._isRoot = true`，于是「挂在 root 下」的对象 `_parent._isRoot` 为真、
走 `else` 分支、**根本不读 `parent`**——`Basic_SkyBox`/`Basic_Stereo`/`Basic_UVAnimation` 全都只往 root 加子件；
`Intermediate_MD5Animation` 是唯一做「灯`.addChild(…)`」（父件**非 root**）的 demo，第一次走到就炸。

**二、修法（AS3 规则：最近声明者胜；**只对读取**，setter 不算）**

`src/symbols.ts` 新增 `shadowedForRead(cls, fieldOwner, name)`：从 `cls` 沿 super 链**逐层**走（走到声明该字段的 `fieldOwner` 为止），
若中间某一层**自己**声明了同名 getter **或方法**即返回真（命名空间代理桩 `isProxyNs` 排除）。**逐层**（而非「只看叶类」）是必须的：
away3d 大量以中间层静态类型读 `parent`（`Entity`/`Mesh`/`SegmentSet`…，getter 声明在 `ObjectContainer3D`）——
`Basic_SkyBox` 的 8 处 `Entity` 静态类型读取正属此类。

`src/emit.ts` **五处**解析点接入 —— **三处读取**（成员访问 `obj.prop`、类内裸标识符 `parent`、`Class` 型槽读取）命中即跳过字段、继续走既有 getter/vtable 路径；
外加 `walkInferType` 的**两处类型推断**（类内裸标识符分支、`ot.member` 分支）同规则。**推断侧也要接的理由**：类型推断与发射必须给出同一个答案，
否则前导 pass（`_once` 提升、装箱/对象强转的选择）可能按**祖先字段**的类型去强转一个**实际由 getter 读出**的值——这属于「同名解析点必须一致」的闭合，不是新增优化。

**setter 刻意排除**（第一版把它算进去，被回归当场抓住）：内置类把 AIR 的**访问器对**保留为**存储字段**（`DisplayObject.x/y`），故「本类声明了 setter」时
**没有**祖先 getter 可回落；away3d 的 `View3D` 正是 `override set x` 之后在**自己的 setter 体内读 `x`** ⇒
把 setter 计入遮蔽会立刻退化成 `Codegen error at 510:4: undefined variable 'x' in class away3d_containers_View3D`。
语义上这也对：更近的 setter 只支配**写**，而写路径本来就先解析 setter。

**三、证据**

| 证据 | 结果 |
|---|---|
| 端到端重建（删掉陈旧 `.o` 后整链重来） | `EXIT=0`（479 sources + Metal/Skia/SDL2/curl），生成 C 里 `updateMouseChildren` 已是 `this->vtable->get_parent(this)`，`bool _sc570`（不再是 `as_value` + `as_dyn_get`） |
| 运行 12 s 无 `#1009`（此前是启动即死） | 窗口 1024×800@2 = 2048×1600；两张相隔 2 s 的截图差 **37,035** 像素（MD5 骨骼动画在跑）；静态截图：岩石地面 + 夜空天空盒 + 地狱骑士网格，HUD `FR:7/0 A:171 RAM:121.6M POLY:2744 DRIV:Metal`（`temp/md5verify/md5-fix-0{1,2}.png`） |
| 新增示例 `examples/member-shadow.as`（`test/examples.ts` 自动发现） | 5 节断言：own getter 遮蔽继承字段 + 深子类继承 getter 仍遮蔽 + 未遮蔽继承字段照旧读写 + 显示列表槽仍被 `addChild` 写进 + setter-only override 不遮蔽 ⇒ `member-shadow: all assertions passed` |
| **反向对照**（临时探针：在 `shadowedForRead` 首行插 `ASC_NO_MEMBER_SHADOW=1` ⇒ 直接 `return false`，即还原旧行为。**探针已在收尾时移除**，复现需按此描述临时插回） | 新示例**必 FAIL**（loud）：`Uncaught exception: FAIL: own getter must shadow the inherited \`parent\` field`，`rc=1` |
| 新增单元组 `unit: reflection/MemberShadow`（11 条） | 钉源级形态：`o.parent` 与类内裸 `parent` **都**走 `->vtable->get_parent(`、深子类同样、`{ "parent", 12, offsetof(EventDispatcher, parent) },` **仍存**（**不得**靠删槽修）、未遮蔽字段仍直读直写（`->name`，无 `get_name(`）、setter-only 不炸且 setter 仍发射、规则**单点化**（`shadowedForRead` 定义 1 处 + `emit.ts` 5 处调用：3 读取 + 2 类型推断） |
| **兄弟 demo 零回归（生成 C 全文对照）** | 对 `Basic_SkyBox` 以同一探针做 `--dry` 双跑（`temp/skybox-aot/temp_skybox_{old,new}.c`）⇒ 全文 **12 处 hunk，全部是 `parent` 的读取**，无一处其它语义面被碰到。分类：① 纠正**恒 NULL 的槽读**（`updateMouseChildren`、`dispose`、`HoverController` ×2 处、`Mouse3DManager` 事件冒泡 ×2、`SceneIterator` 的 POST 上行、`Bounds.getParentBounds`、`Mesh.intersect` 的 `localIntersect`、`SegmentSet` 的父件判空）——每一处的新发射**正是 AS3 原文**（`get parent()`；`dispose` 的 `if (parent) parent.removeChild(this);` 旧码因读 NULL 而**静默跳过**）；② 顺带把「按祖先字段绕路动态分派」改成**静态**（`as_dyn_get(parent,"inverseSceneTransform")` → `parent->vtable->get_inverseSceneTransform(parent)`、`as_dyn_call(parent,"removeChild",…)` → `parent->vtable->removeChild(parent, this)`、`Object* parent` 静态类型收成 `ObjectContainer3D*`、比较从 `as_v_loose_eq(as_obj_to_value(…))` 收成 `==`）——动态查找命中的**正是同一个** getter/方法，语义等价、只是不再走反射 |
| 兄弟 demo 运行期 | `Basic_SkyBox` 重编（**34,134,480 B**）启动 14 s 无异常；截图仍是雪山天空盒 + 环境反射铬环、非黑 **100.0%**、`FPS:114 MEM:13MB PRIV:173MB RUNTIME:AS-AOT`（`temp/md5verify/skybox-fixed-01.png`）。**这几处改动在上述 demo 里不进分支**：`updateMouseChildren` 因 `_isRoot` 走 else；`dispose` 未被调用（`grep dispose` 无）；三个 demo 均**不 new 控制器**（`grep Controller` 无）；`Mouse3DManager`/`Mesh.intersect`/`Bounds` 只在有鼠标输入时进入；`SceneIterator` 只在 `ViewVolume.addStaticsForRegion`（GridView 静态分区）里使用，本批 demo 的 `Scene3D` 用 `NodeBase` |
| **类型推断侧同规则（零差异证明）** | 这 2 处新守卫的判据是「全文 `cmp`」：对 `Basic_SkyBox`（485 sources）以「有/无这 2 处守卫」双跑 ⇒ 生成的 C **逐字节相同**（262,615 行）；再对**当前树**做一次完整端到端重建（`rc=0`，`temp/guardverify/skybox` **34,134,472 B**）且其 C 与 `--dry` 跑法**逐字节相同**，启动 7 s 无异常、渲染正常（`temp/guardverify/sky_run.png`：雪山天空盒 + 环境反射铬环、HUD `FPS:117 MEM:13MB PRIV:174MB RUNTIME:AS-AOT`）⇒ 推断侧接入对 away3d 语料**零发射差异**，端到端链路（编译→链接→运行→渲染）仍通 |
| 全量 `node test.ts` | **245 passed / 0 failed**（单元组 85/85） |

> **口径说明（为何这里不用像素比对作回归判据）**：`Basic_SkyBox` 的相机 `rotationY += 0.5*(stage.mouseX-stageWidth/2)/800` **逐帧累加** ⇒
> 偏航角是**帧数**的函数，两次运行只要帧数不同就整屏不同（实测与阶段一百二十二 的参考图 `temp/dynnew-verify/skybox-new2.png` 粗采样差 **77.3%**、
> 差异框覆盖整幅，而两者都是正确渲染）。故对兄弟 demo 取「生成 C 的 hunk 枚举 + 执行可达性分析 + 启动/渲染实测」为判据，不取跨运行像素相等。

**文档同步**：`README-CN.md` 版本号 v0.4.95 → **v0.4.96** + 一条 bullet（成员解析的最近声明规则）；
`docs/zh-cn/as3-semantics.md` 差异表新增一行（继承扁平化 vs 最近声明）；`package.json` v0.4.95 → **v0.4.96**；
单元组 84 → **85 组**、243 → **245 用例**。

**遗留表**：**新登记 0 行**（本阶段是把**已定义**行为修对，不新增缺口）；**移出 0 行**。

---

### 阶段一百二十四：`--air-app` 编译面 = 主类的**传递闭包** —— 停止过度近似 AIR（目标 v0.4.96 → v0.4.97）✅ 已完成

**触发**：用户就 `TODO.md` 遗留表里的「编译范围 = 整个 `src/`（无可达性分析）」一行提问——**是否需要做触发类闭包？**
（阶段一百二十二 已把它实测登记，但结论停在「先定口径再动」）。本阶段把口径定死并落地。

**一、口径：收面是「停止过度近似 AIR」，不是增强**（AGENTS.md §1.5 的判据反着读）

AIR 的编译面**本来就是传递闭包**：`mxmlc -link-report` 实测（`temp/linkreport/`，6 个 demo 的 SWF + XML）
away3d 每个 demo 只链 **158–246** 个 def、六个 demo 合起来只触及 **287** 个不同类，而 `src/` 有 **485** 个 `.as`
——**其中 198 个不被任何一个 demo 触及**。我们此前一律编译整包（**约 2.8× 过度近似**），代价两处可见：

1. **别的 demo 的 `[Embed]` 被打包并存活进产物**：`Basic_SkyBox` 的构建日志 `embed 40 asset(s)` / **4,969,434 B**，
   而它自己只需要 6 张天空盒（**645,180 B**）——多出来的 **4,324,254 B（87%）属于别的 demo**。
2. **不可达类里的坏/缺失 `[Embed]` 让我们编译期失败**，而 `adl` 正常构建（窄口径保真缺口）。
   （已实测到实例：我们编译了 `away3d.core.pick::PBPickingCollider.RayTriangleKernelClass` 与
   `away3d.textures::SplatBlendBitmapTexture.NormalizeKernel` 两个 `.pbj` 嵌资源，`mxmlc` **从不处理它们**。）

**为什么修法必须在「发射面」而不是链接期（本阶段最关键的结构发现）**：`main()` 无条件调用 `as_amf_wire()`
（生成 C 第 262598 行）⇒ 它把 `as_class_registry[]` 的每一项都变成活引用（`.c:138189` → `.c:135427` 的注册表遍历），
于是**每个类对象、vtable、反射表、嵌入工厂**都被钉住。二进制 `nm` 实测：`as_get_definition_by_name`=0、
`as_v_is_class`=0、`as_v_class_of`=0，但 **`as_amf_class_impl`=1**、**`as_class_registry`=1**，以及
`Basic_SpriteSheetAnimation__onEnterFrame` 等 **100 个别的 demo 的方法符号**仍是 `T`。⇒ 类侧 DCE 在链接期**不可能**；
正确修法是**决定编译哪些 `.as`**（喂给注册表的类更少），**而不是**把注册表变懒——后者会同时打断 `is Class`、
`new x()`、`getDefinitionByName` 与 GC 根（阶段一百二十二 的「②」正告过这一点，本阶段按它执行）。

**二、实现**

新模块 `src/reach.ts`（662 行，编排在 `src/index.ts` 的 `--air-app` 分支，两趟）：

- **Pass 1 `prepareReachFiles(asFiles, srcDir)`**：读 + 解析 + **重写**每一个源文件（把这段从 `index.ts` 提出来，
  使闭包与单元测试共用**同一条准备路径**）。重写两条都是 AS3 包规则：**文件作用域匿名命名空间**（顶层 `class X {}`
  不在任何 `package { }` 里 ⇒ `packageName` 置为**相对 `src/` 的路径 id**，避免与内建类撞键，如 `Polygon.as` 的
  `class Rectangle` vs `flash.geom.Rectangle`；注意**裸 `package { }` 的 `packageName` 是 `''`**——falsy 但**不是 null**，
  故不重写，away3d 的 demo 主类正属此类）与**同文件可见性注入**（每个类的 `imports` 追加同文件 FQN）。
- **Pass 2 `computeReachable(files, mainClassFqn)`**：从文档类出发做类引用闭包，返回 `{kept, dropped, roots, edges}`。
  **边 = 源码里出现的类名引用**：`new X`（含限定名 `new pkg.X()`）、类型标注（含 `Vector.<T>` 的元素类型，
  递归拆嵌套）、`extends`/`implements`、`is`/`as` 目标、`catch (e:T)`、参数/返回类型、接口方法签名，以及
  **裸标识符**（覆盖 `Foo.staticM()` 的短名形式）。**总是保留**：主类、`[WasmExport]` 类/静态方法（无 AS3 引用的
  JS 入口）、以及带**非类顶层语句**（模块语句/自由函数）的文件——那类代码是整程序发射的，无法按类剪
  （away3d 树里恰好钉住一个文件：`away3d/debug/Debug.as` 的 `function dotrace(...)`）。**文件粒度**：一个文件里
  任一顶层类可达即整个文件保留（同文件的兄弟类随之保留，属**超集**方向，安全）。
- **解析刻意过度近似**：限定名走精确匹配；未解析的短名走**全局同名候选（返回全部）**——因为 `symbols.ts` 的
  `typeAlias` 是**全局 last-wins** 表，任何一个同名候选都可能是 codegen 的答案。这正是「闭包 ⊇ AIR 闭包」的机制。
- **walker 用穷尽 switch + `never` 兜底**（3 处），新增 AST 节点会**在这里编译失败**直到 walker 学会它（§2.2 数据优先规则应用到本 walker）。
- **接线**：闭包结果只用于 ① 决定把哪些文件的 `body`/`imports` 推进 `program`；② 决定对哪些文件跑 `collectEmbeds`
  （`src/index.ts` 的 `for (const f of keptFiles)` 循环内）。构建日志首行报收面结果：
  `[1/4] read ... (main Basic_SkyBox, 165/485 sources reachable from Basic_SkyBox)`。
- **`--all-sources`**：`--air-app` 专属开关，跳过闭包、编译 `src/` 下全部 `.as`（= 本阶段之前的口径），
  供「源码里引用得不可见」的工程兜底。
- **一处刻意更严的边界（已实测，不会造成静默漏类）**：**全限定静态成员访问** `a.b.S.staticM()` 在**本编译器里
  本来就编译不过**——`Member` 链解析成 `Var('a')`，codegen 报 `Codegen error at 4:7: undefined variable 'a'`
  （实测）；walker 对它只收集到 `a`（解析不到类）⇒ **没有类被静默丢掉**，是**响亮**的 `CodegenError`（§2.5）。
  这与 codegen 的能力面**一致**，不是新缺口。

**三、验收**

| 证据 | 结果 |
|---|---|
| **① 闭包 ⊇ AIR 的闭包**（6 个 away3d demo 逐个对照 `mxmlc -link-report`；脚本 `temp/reachprobe/closure.mjs`） | 保留 165/173/162/169/157/219 个文件 vs AIR 的 158/175/162/171/158/246 个 def；**唯一「AIR 有而我们没有」的是 `away3d.arcane`——那是 `<def/>` 形态的**命名空间**伪定义（`type="ne"`），不是类**（本编译器里命名空间是透明的，正确排除）。「我们比 AIR 多」的全是**同文件内的嵌套/单例辅助类**（`SingletonEnforcer`/`SegRef`/`SubSet`/`OpCode`…），内部 ABC 类 mxmlc 不单列 |
| **② 同源 A/B 的体积与时间**（`Basic_SkyBox`，同一份源码；`--all-sources` vs 默认） | 源文件 **485 → 165**；嵌资源 **40 → 6**；`.c` **31,324,486 → 9,105,166 B（−71%）**；`.o` 13,829,456 → 3,856,800 B；二进制 **34,134,472 → 25,456,904 B（−25.4%）**；整链构建 **37.03 → 15.94 s（−57%）**。（`-o` 与就地构建的 `.c` **逐字节相同**；二进制差 8 B 纯属产物路径长度，非语义） |
| **③ 二进制字节判据**（旧口径参考物 = 阶段一百二十三 留下的整包 `Basic_Stereo`，34,134,400 B，**仍在盘上**） | `road.jpg`/`rockbase_normals.png`/`idle2.md5anim`/`grimnight_posX.png` 的 48 字节中段：整包 **各 1 次**（`testSheet1.jpg` 15 次）→ 闭包 **各 0 次**；同时**自己的** 3 张天空盒贴图整包 1 次 → 闭包 **仍 1 次**（该留的留、该走的走） |
| **④ 逐 demo 的嵌资源数与 AIR 逐个相等** | 6/2/0/2/1/27 对 6/2/0/2/1/27（`Basic_Stereo` 两边都是 **0**——它自己不声明任何嵌资源） |
| **⑤ 源码级 A/B：闭包产物 vs `--all-sources` 产物**（把「不会漏类」从体积变成**定义性证据**；脚本 `temp/closureverify/cmpfuncs.py`，按函数名对齐后把 codegen 的全局编号临时名归一化） | `Basic_SkyBox`：**「只在闭包产物里出现的函数 = 0 个」**；8111 个共有函数里 **只有 8 个**文本不同，**8 个全部是「本构建里存在哪些类型」的清单表**（`as_amf_members_impl`、`as_vec_{fqn,super_fqn,get,set,call}_impl`、`as_amf_vec_impl`、`gc_mark_user_roots`），且这 8 个**逐行都是整包版本的子集**（`lines-in-closure-not-in-all = 0`）⇒ 收面只删「本构建不存在的类/向量元素类型/静态根」的条目，**没有改任何一行可达代码**。`Intermediate_MD5Animation` 复跑同一结果（10101 个共有函数，同样 8 个清单表、同样 0 处越界） |
| **⑥ 渲染/行为回归（12 个 `--air-app` 工程全建全跑）** | away3d×6 全链 `rc=0`；`Basic_SkyBox` 雪山天空盒 + 环境反射铬环（非黑 100.0%，`FPS:110 MEM:13MB PRIV:175MB RUNTIME:AS-AOT`）；`Intermediate_MD5Animation` 岩石地面 + 地狱骑士骨骼动画（`POLY:2746 DRIV:Metal`，且**无** `#1009`）；`air-starling-demo` 菜单（12 个场景按钮 + `Metal (Stage3D)`，非黑 97.5%）；`Flappy-Starling` 标题页（99.9%）；`shmup-stage3d` Stage3D 精灵海（`FPS: 80`）；`url-test` 登录 POST + `live_statistics` + 2/2 图入舞台；**`air-native` 的 79 行断言输出与整包构建逐字节相同**（`diff` 空；含两处**先于本阶段即存在**的 `#1034`/`IO_ERROR`，非本阶段引入——整包构建同样打印） |
| **⑦ 全量回归** | `node test.ts` **253 passed / 0 failed**；`npm run test:unit` **90/90** |
| **⑧ 新增单元组**（`test/unit/reach.ts`，417 行，5 组 **42 条**） | `unit: reach/{closure,edge,prepare,emit,wiring}`：合成 fixture 把 kept/dropped 集合**全量列清**；**逐机制归因**（删掉主类里某一处引用 ⇒ 断言**恰好**那一个类离开闭包，10 条：`import`+`new`/限定 `new`/通配 import/`Vector.<T>` 元素/`is`/`catch`/静态调用/`implements`/参数与返回类型/同名歧义对）；`import` 单独**不算**边、匿名命名空间不可跨文件达、`[WasmExport]` 是根、自由函数保文件；闭包产物 `generateC` 通过且函数集**是整包的子集**；CLI 接线 6 条（含 `--all-sources` 默认关）。**为什么钉在这里**：examples 套件只跑「必须成功」的程序，且 `away3d-core` 是 gitignore 的 485 文件引擎、被 `test/examples.ts` 跳过——闭包只在 `--air-app` 路径上存在，没有任何既有回归会覆盖它 |

**顺带修掉的一个测试基建缺口**：`test/unit/embed.ts` 写好了却**没被登记**进 `test/unit.ts` 的 barrel
（该文件与整个 `test/` 目录同属上一阶段未提交的新布局）⇒ `node test.ts`（文档化的全量回归）**一直在静默跳过**它的 3 个 `[Embed]` 组。
本阶段把它补进 barrel——它与我这次动到的 `collectEmbeds` 收集面**直接相关**，不能留空。

**文档同步**：`README-CN.md` 版本号 v0.4.96 → **v0.4.97**；原「`[Embed]` 打包范围 = 整个 `src/`（已知偏差）」一条**改写**为
「`--air-app` 的编译面 = 主类的传递闭包」；`--air-app` 那条 bullet 末尾补 `--all-sources` 指引；
`docs/zh-cn/compile.md` 新增 **§3.5.1**（闭包语义 + 边 + 过度近似 + `--all-sources` + 实测数字）、CLI 清单加 `--all-sources`；
`docs/en/compile.md` 同步（§3.5.1 + 清单）；`docs/zh-cn/as3-semantics.md` §4 末尾加一条「**像增强但其实不是**：编译面收面是停止过度近似」；
`AGENTS.md` §2.8 模块表新增 `src/reach.ts` 行；`package.json` v0.4.96 → **v0.4.97**；单元组 85 → **90 组**（+5 reach、+3 补登记的 embed）、245 → **253 用例**。

**遗留表**：**移出 1 行**（「编译范围 = 整个 `src/`（无可达性分析）」—— 已由主类传递闭包收面落地）；**新登记 0 行**。

---

### 阶段一百二十五：`&&`/`||` 短路链的**操作数透传** + 静态 `String` 的**空串真值** —— air-native 的 TweenDemo 崩溃真根因（目标 v0.4.97 → v0.4.98）✅ 已完成

**触发**：用户报 `examples/air-native` 运行后崩溃，输出为
`TweenDemo: tween complete, box.x=0, box.y=0` 之后接
`Uncaught exception: Error #1034: Type Coercion failed: cannot convert false to Array.`，
并问「是不是最近改了数组、里面的 AS 代码没更新」。**不是**（demo 源码未动），是**发射侧**缺陷；
`box.x=0, box.y=0` 正是崩溃卡死后的表象——修复后同一 demo 的 35 个 tween 全部以真实坐标完成并 `window closed` 干净退出。

**一、真根因（`emit.ts` 的 `&&`/`||` 分支）**：`compatible` 判定原先把「**有一侧是 `any`**」也算作可统一：

```ts
const compatible =
  l.type.kind === 'any' || r.type.kind === 'any' ||   // ← 病根
  l.type.kind === r.type.kind ||
  (numeric(l.type) && numeric(r.type));
```

于是 `unifyType(any, Array)` 走 `emit.ts` 那条注释自己写着「`any` 在运行时解箱成具体分支的类型」的分支，
取了**较窄**的 `Array`；随后 `convert(any → Array)` 把**短路透传的那个操作数**做了解箱 + 运行时类型检查。
`TweenLite.as:399` 的
`_overwrite > 1 && this.cachedPT1 && siblings && siblings.length > 1`
在 `onDone` 一路 `_overwrite` 为假时发出

```c
as_value _sc1 = (_sc0 ? as_obj_to_value((void*)(g_cachedPT1)) : as_v_bool(_sc0));
as_array* _sc2 = (as_v_truthy(_sc1) ? g_siblings : as_v_req_array(_sc1, "Array"));  // ← 在这句抛 #1034
```

注意 `A && B` 那一层（`_sc1`）是对的（统一类型是 `any`，透传原样）——**只有统一到具体指针类型的那些层出错**。
这解释了为什么崩在 TweenDemo 而不是别处：整条链里只有 `any` 与 `Array` 相邻的那两节命中。

**二、adl 真值表（先取证再改）**：`temp/logicrepro/` 做了 4 轮双端对照（`AirTruth*.as` 跑 `adl` 51.4.1、
`Probe*.as` 跑本编译器），共 **26 例**，全部逐字一致。工具链三个坑（一并记录，供后来者）——
① `adl` 的 `<content>` 根类**必须** `extends flash.display.Sprite`，否则 `Error #2023`；
② `adl` 不支持 `System.exit()`（`#2018`，用户当时贴的就是这条），AIR 原生的退出方式是
`NativeApplication.nativeApplication.exit()`；
③ **unpackaged `adl` 的 `trace()` 在 macOS 上到不了 stdout/stderr**，故对照探针改为「写文件 + 抛未捕获 `Error`」双通道
（异常文本会上 stderr，这正是 `#2018` 当初能被我看到的原因）。
核心结论（`adl-truth.txt`）：`r1=false(boolean)` —— **假操作数原样透传、绝不被强制转换**；
`r3len=0(object)`/`r4same=true(object)`/`r5same=true(object)` —— 数组、对象**按同一性**透传。

**三、修复一（透传解箱）**：`compatible` 去掉 `any` 那一款（`any && any` 由「同类」那款覆盖），
即「只要有一侧是 `any`，静态类型就不能给另一侧做保证，两侧一律 box 成 `as_value`」。
这与本文件早先（阶段八十九·十四 引入值语义时）自述的设计意图一致——「mixed guard idiom（`bool && object`）
两分支装盒为 `any`」，是后来加的 `any` 那款违背了它。**同类快路径与 numeric 快路径刻意保留**：
`bool && bool` → C `&&`、`int && int` → 裸 int 三目、`Object || Object` → 引用三目（不装箱），
修复后逐条钉住（`test/unit/logical.ts`），因为它们正是这套统一机制存在的理由。

**四、修复二（顺带实测出的邻域缺陷，同族）**：对照探针当场捞到第二个**独立** bug——
`var s:String=""; s && "hi"` 我们给 `"hi"`，`adl` 给 `""`。AS3 里**空字符串是假值**，
而 `condExpr` 对静态 `string` **直接落到 `return e.code`**，用 C 的 `char*` 非空判定 —— `""` 是非空指针 ⇒ 判真。
注意 **boxed 路径本来就是对的**（`as_v_truthy` 的 tag-3 分支为 `v.ptr != NULL && ((char*)v.ptr)[0] != 0`），
坏的只有静态路径。修法：新增与 `as_num_truthy` 对称的 `as_str_truthy(const char*)`
（`s != NULL && s[0] != 0`），`condExpr` 的 string 分支改走它。**helper 取参而非内联**是刻意的：
内联 `s != NULL && s[0] != 0` 会**两次提及操作数**，`if (nextName())` 就会调用两次。
覆盖全部 `condExpr` 调用点：`if`/`while`/`do-while`/`for` 条件、`!`、`?:`、`&&`/`||`（`adl-truth3.txt` 的 `whilen=0`、
`calls=1` 与 `adl-truth2.txt` 的 `r11len=0` 逐条对照过）。

**五、验收**

- **① 对照真值表**：4 轮 **26/26** 例与 `adl 51.4.1` **逐字一致**（含 `typeof`、对象同一性、`is int`、单次求值计数）。
- **② 端到端（既有产物、既有 harness 的 before/after）**：`examples/air-native` 同一命令重建 ——
  修复前日志 **79 行**、止于第 1 个 tween + `#1034`（app 中断，无 `window closed`）；
  修复后 **114 行**、35 个 tween 全跑完且 `window closed`；前 77 行**逐字节相同**。
- **③ 既有回归**：`examples/logical-value.as`（10 组断言）与 `examples/string-truthy.as`（8 组断言）新增；
  `test/unit/logical.ts` 两个单元组共 **18 条**源级钉子（断言生成的 C 里 `as_v_req_*` **不出现**、
  逻辑链临时量是 `as_value`、快路径未被破坏、`as_str_truthy` 在全部 `condExpr` 调用点上、helper 单次求值）。
- **④ 全量回归**：`node test.ts` **257/257**（253 → +2 示例 +2 单元组）、`npm run test:unit` 全绿。

**六、口径**：两条都是 **AIR 已定义行为被修对**，按 AGENTS.md §1.5 的反读**不是增强、也不新增缺口**。
Numeric 统一（`int && Number` → `double`）这一处：`adl` 实测 `r6=0(number,isint=true)`，我们同为 `isint=true`，
故 `bool && int` 的 `is int` 也与 AIR 一致（曾担心 numeric 提升会抹掉 int 身份，实测无此问题）。

**文档**：`README-CN.md` 当前限制章新增本条；`docs/zh-cn/as3-semantics.md` §4 加「短路返回值语义 + 空串为假」两条口径；
`package.json` v0.4.97 → **v0.4.98**；单元组 **90 → 92 组**、用例 **253 → 257**。

**遗留表**：**移出 0 行**、**新登记 1 行**（`new XMLList()` 未注册为可构造内建类 —— 同批探针实测：
`air-native` 无关，但 `adl 51.4.1` 能 `new XMLList()` 而我们报 `unknown class 'XMLList'`（**响亮**失败，非静默）；
`XML` 可构造、`XMLList` 只能作类型标注，属不对称）。

---

### 阶段一百二十六：Windows 原生后端（Win32 接线 + SDL2 glue + Skia D3D12 直连 GPU）—— `<architecture>` 与双位宽（目标 v0.4.98 → v0.4.99）✅ 已完成（代码就绪；Windows 侧 2026-10-10 已实机编译+链接+运行，见下「验证补记」）

**范围**：用户立项「Windows 支持」。此前 `--air-app` 在 win32 上产出的清单**根本链接不起来**（`-lm`/`-lz`/`-lobjc`/`-framework`、`lib`-前缀归档名、缺 `<iconv.h>`、以及一个 TDZ 缺陷），且 AIR 描述符里决定位宽的 `<application><architecture>`（`"32"`/`"64"`，**默认 32**）**从未被解析**。本阶段交付：编译器侧完整接线 + `window_glue.cc` 的 D3D 挂载 + `vendor/d3d_glue.cc`（D3D12 直连 GPU 合成）。

**一、`<architecture>` 成为一等参数**（`src/air-app.ts`）：新增 `AirAppInfo.architecture`；`parseAirApp` 校验 `"32"`/`"64"`（缺省 **32**，其余**响亮** `AirAppError`——`"16"` 实测被拒）；`airManifest(...)` 据此选 `vendor/*/windows-x86|windows-x64` 与 triple `i686-pc-windows-msvc`/`x86_64-pc-windows-msvc`。

**二、`-l` 归档名**不是「两端同名」**（实测推翻上一版结论）**：在 macOS 上跑 `gn gen`（`target_os="win" target_cpu="x64"`，假 `C:/fake/...` 目录置于 out 下即可——gn 不重定位绝对路径）拿到**真实** Windows `build.ninja`（`Done. Made 91 targets`，同时证明新增的 `skia_use_direct3d=true` gn 参数集被接受）⇒ Windows 归档是 `<target>.lib` **无 `lib` 前缀**（gn 的 Windows `tool("alink")` 无 `output_prefix`，POSIX 有），故字面名为 `lib*` 的四个目标需 `-llibpng`/`-llibjpeg`/`-llibwebp`/`-llibwebp_sse41`（`winLib()` helper）；`third_party/d3d12allocator` → `d3d12allocator.lib`（Ganesh 的 D3D 后端在 `fMemoryAllocator` 为空时**自建** `GrD3DAMDMemoryAllocator`，见 `GrD3DGpu::Make`）⇒ 已加入 Windows 链接表。

**三、平台条件分支的「本机不可见缺陷」被仿真逼出**：macOS 上永不执行的 `<renderMode>gpu` 分支把 `linkLibs.push` 写在了 `const linkLibs` **声明之前**（TDZ）——用 `Object.defineProperty(process,'platform',{value:'win32'})` 预加载跑**真实管线**才暴露（`ReferenceError: Cannot access 'linkLibs' before initialization`）。**教训**：平台分支必须仿真**另一平台**跑一遍，不能靠「本机跑通」推定。

**四、后端中立的 GPU seam**（把 Metal 专属符号改成中性名）：`ASC_RENDER_WINGPU` ＝「本窗口的 Skia 合成走 GPU」，具体后端由 `ASC_RENDER_METAL`(macOS)/`ASC_RENDER_D3D`(Windows) 指名（`ASC_RENDER_GPU` 已被 web Ganesh 占用）。生成 C 与 runtime 只用 `sk_gpu_init`/`sk_gpu_destroy`/`sk_gpu_begin_frame`/`sk_gpu_flush`/`sk_gpu_draw_texture`、`sk_window_show_gpu`、`as_skia_gpu_*`、`w->is_gpu`；**唯一**的后端分支在 `window_glue.cc`（`sk_attach_gpu`/`sk_window_show_gpu`）。`src/` 内 `is_metal`/`sk_mtl_`/`as_skia_mtl_` 已归零。Stage3D 叠加层**刻意仍守 `ASC_RENDER_METAL`**（只改名 `is_gpu`）——Windows 的 Stage3D 在清单期就报错，且 `ASC_stage3d_tex` 是 `MTLTexture`。

**五、`window_glue.cc` 的 Windows 侧**：`sk_attach_d3d(c, id)` 经 `SDL_GetWindowWMInfo` 取 `info.info.win.window`（非 `SDL_SYSWM_WINDOWS` **响亮**拒绝）交 `sk_gpu_init`；`sk_attach_gpu` 按宏分派、无匹配宏**响亮**报错；`sk_window_show_gpu` 在 D3D 下自持 SDL 循环。`is_metal` → `is_gpu`（8 处）。

**六、`vendor/d3d_glue.cc`（新，~380 行）**：按 Skia m124 **自带参考**（`tools/window/win/D3D12WindowContext_win.cpp` + `D3DTestUtils.cpp::CreateD3DBackendContext`）逐步骤实现——进程级 `IDXGIAdapter1`/`ID3D12Device`/`ID3D12CommandQueue`/`GrDirectContext::MakeDirect3D`（`fMemoryAllocator` **留空**，与 Skia 参考一致，由 `GrD3DGpu::Make` 自建），窗口级 `CreateSwapChainForHwnd`（`FLIP_DISCARD` + `R8G8B8A8_UNORM`，与参考同）＋两条 back buffer 包成 `GrBackendRenderTarget`/`SkSurface` ＋ fence 帧同步 ＋ `ResizeBuffers` 处理；`Present` 前必须**先 `flush(kPresent)` 再 `submit`**（两半都不能省，否则上屏的是**旧** back buffer）；每处 HRESULT 失败都带 `d3d_glue:` 前缀打 stderr。`sk_gpu_draw_texture`（Stage3D 合成用）明确**未实现且出声**（唯一调用者是 Stage3D，Windows 上不可达）。

**七、`<renderMode>direct` 在 Windows 的产物**：`ASC_RENDER_WINGPU=1` + `ASC_RENDER_D3D=1` + `d3d_glue.cc` + `d3d12`/`dxgi`/`d3dcompiler`；macOS 专属的 `metal_glue.mm`/`objc`/Cocoa framework 在 Windows 全部去掉；`src/build.ts` 的 `-lm`/`-lz` 在 win32 归零（`m.lib`/`z.lib` 不存在）；`AS_HAVE_ICONV 0`（与 wasm 一致：非 UTF 字符集**响亮**抛错）。

**八、Windows 依赖构建脚本**（`vendor/build-windows-deps.ps1`）：Skia m124（`skia_use_direct3d=true`，注释写明三个后果）/SDL2 2.32.10/curl 8.11.1/zlib/nghttp2 的 x64 与 **x86** 双位宽产出；x86 墙由 `Repair-SkiaX86Toolchain`（自动探测 `SetEnv.cmd` ＋**最小** gn 补丁把 x86 `env_setup` 包进 `if (clang_win == "")` ＋幂等标记 `ASC-X86-CLANG-PATCH` ＋ CRLF 归一）解决；`Assert-LibBitness` 用 `dumpbin`/`readobj` 认 x64/x86/ARM64/ARM，**错位＝硬失败**（不做「碰巧能跑」）。

**验证（macOS 上能做的全做了）**：① **去机器化验证脚本**——便携 pwsh 解析 `Parser::ParseFile` OK（4238 token / 22 函数）、真实语法错已修（L501 的 `\"` 转义）、4 个 `Invoke-CmakeBuild` 调用点均传 `-Arch`、AST 抽出的 `$old`/`$new` 对**真实** `skia-src/gn/toolchain/BUILD.gn` 命中且**幂等**、`gn format --dry-run` 退出 0；② **COFF 机器字段实验**证明 x86 必须用 `--target=i686-pc-windows-msvc`（`-m32` 在 arm64 主机上产出 **ARMNT**、默认产出 **ARM64**）；③ **win32 仿真跑真实管线**：32/64 两套清单一字段一字段核对（无 `z`/无 `objc`/`frameworks: []`/三处 vendor 路径随位宽切换/`sources` 含 `d3d_glue.cc`）；④ **最终全量回归 `npm test`：258/258 全绿、0 红**（单元 **92 组**、示例 **166 个用例**，含新增的 air-app 链接关口）。

**关于「测试门禁不稳定」的诚实记录**：本阶段开头的几次套件运行（**同一命令、同一代码**）报出过 **3 个不同的红**，而它们在后来的重跑中全部变绿：`example: stage86.as`、`unit: emit/StringConcatFlat`、`unit: reflection/ClassValueOperand`。已排除的假说：① **陈旧产物**——在用例将使用的产物路径上埋一个假二进制，实测被**无条件重建并覆盖**（脚本变回 Mach-O、用例仍绿）；② **`-o` 序号**——同一示例用 `001-` 与全量跑的 `113-` 两条路径手工跑，两条都绿；③ **断言陈旧**——`examples/stage86.as` 的 `NativeApplication` 断言已改为 `com.example::NoSuchClass`（注释引 `adl 51.4.1` 实测）后仍曾红。根因**未定**，已登记入 `### 遗留待开发`（门禁自身不可靠是隐患：它会让真缺陷与假红混在一起）。**结论**：这 3 个红与本次 diff **无关**（首次观测在任何代码改动之前），但本轮也**未改它们任何一行实现或断言**，故不宣称「已修」。**补记（2026-10-10，阶段一百三十）**：本机换成 **Windows** 后做全量回归，**没有复现**这 3 个红；同时把**本机必然红项**逐条实测并分类完毕（与本题**不同源**）：① **5 条 CRLF 假失败**（`platform.ts` 的 `backendparity`、`numeric.ts` 的 `noreturn`、`stage3d.ts` 的 3 条 —— 它们用 `\n` 字面量正则去匹配 CRLF 检出的 `runtime.ts`/`stage3d_glue.mm`/`stage3d_webgl.cc`，文本归一成 LF 后**当场变绿**，而 CI 是 LF 检出）；② 2 条 macOS 硬编码断言（`transport.ts` 的 `link-paths`/framework）；③ 2 条 linkset 缺 `zlib.h`；④ **examples 层整体无法链接**（套件默认 `cc` + `build.ts` 在 win32 刻意不加 `-lz`，而每份生成 C 都引用 `compress`/`uncompress`）。⇒ 本机 Windows 下 `node test.ts` **无法全绿**是**已知的环境红**，不属「门禁自身不可靠」；上面那 3 个 macOS 侧偶发**仍未定案**，故本行保留为未开始，但不再把它与本机环境红混为一谈。

**未验证（当初的诚实标注；2026-10-10 已收口，见紧随其后的「验证补记」）**：本机是 macOS，**无法**用 MSVC ABI 编静态库、也**无法**编/跑 D3D12 程序 ⇒ `d3d_glue.cc` 的每一次 D3D12 调用、`window_glue.cc` 的 Windows 分支、ps1 的**实际**编译产物**均未实机验证**（沿用仓库既有先例「Windows 分支已写出但开发机为 macOS 无法本地验证」，`AGENTS.md` §2.9）。首个 Windows 机器上的核对清单（含**逐条列出的假设**）见 [`docs/zh-cn/win32.md`](docs/zh-cn/win32.md) §5。

**验证补记（2026-10-10，阶段一百三十）**：上面那段「未验证」**已收口**。开发机已换为 **Windows**（不再是 macOS），故下列断言逐条在真机上重测：在 clang 23.1.3 + `--target=i686-pc-windows-msvc` 上把生成的 `air-native.c` 与三个 C++ glue（`skia_glue.cc`/`window_glue.cc`/`d3d_glue.cc`）**编过、链过、跑通** —— 修掉四类 MSVC **编译**障碍（skia 字体后端改 GDI、`window_glue.cc` 的 ObjC/SDL `_m_prefetch` 归 `__APPLE__`、`d3d_glue.cc` 的 `gr_cp` 构造与 `GrD3DTextureResourceInfo` 参数、缺 `SkColorSpace.h`）与三处 Windows **运行期**缺陷（缺 `icudtl.dat` 的 SIGILL、async `FileStream.openAsync(READ)` 的 mode 映射、`File.deleteDirectory` 误用 `remove()`）；最终 `air-native` demo 断言全过并开出两个 D3D12 swapchain 窗口。逐条修法见 [`docs/zh-cn/win32.md`](docs/zh-cn/win32.md) §2.6/§2.7，遗留表对应行已改判 ✅。**仍未做的**只剩 §5 首跑清单的**肉眼级**复验（撕裂/帧率/退出，第 5–8 行），以及阶段一百三十 新增的一行（拖动缩放 + 高清模式肉眼复核）。

**九、自查发现的真缺陷（已修 + 已加关口）**：改完后用手工命令
`node src/index.ts --air-app examples/air-native/air-native-app.xml --main-class Main --target native`
真编一次，**链接失败**：`_sk_gpu_begin_frame` / `_sk_gpu_flush`（referenced from `_ASC_window_render`）
未定义。根因：中性 seam 只在 D3D12 侧落地，`metal_glue.mm` 仍只有 `sk_mtl_*` ⇒ **每个 macOS GPU 构建
都链不起来**。而 `npm run test:examples` 却是 164/165 全绿——因为它对这条路径**盲**：
`examples/air-native` 的目录单元编译的是 `.as` 文件列表（**不带 `--air-app`**），故 `ASC_RENDER_WINGPU`
从未定义、GPU 窗口分支从未被编译；`test/unit/build.ts` 里的 `--air-app` 先例全带 `--dry`（只出清单）。
**修复**：`metal_glue.mm` 补上中性五名的 Metal 实现（转发到 `sk_mtl_*`，与 `d3d_glue.cc` 对称），
并改正 `src/runtime.ts` 里「window_glue.cc 定义这五个」的错误注释。**两道新关口**：① 单元组
`unit: backendparity` 新增 4 条钉子（从 `runtime.ts` 的 WINGPU 块**导出**中性名集合，要求
`metal_glue.mm` 与 `d3d_glue.cc` **双方**都实现且不得多出）——已做反向对照（临时移除一个转发即变红）；
② `test/examples.ts` 新增一个真关口用例 `example: air-native (--air-app + renderMode=direct: 
compile+link only)`，用**用户的命令形态**编译+链接（带 `--run` 会开真窗口不返回，故只验链接），
并在 vendor 库缺失时显式 SKIP。此用例已做双向对照（破坏 macOS 实现 → 链接失败变红；还原 → 绿）。

**文档**：新增 `docs/zh-cn/win32.md`；`README-CN.md` 的「构建与链接」新增 Windows 小节；`package.json` v0.4.98 → **v0.4.99**。

**验证计数**：最终 `npm test` **258/258 全绿**（单元 **92 组**、示例 **166 个用例**，含 `unit: backendparity` +4 条中性 seam 钉子与 `examples` +1 个 air-app 链接关口）。

**遗留表**：**移出 0 行**、**新登记 3 行**（Windows 侧未实机验证；Stage3D 无 Windows 后端；**测试门禁不稳定**——同一套件不同次运行报出 3 个不同的红、重跑全绿，根因未定）。

---

### 阶段一百二十七：内建类注册表 & Class 值 + `in`/`delete`/下标（批次 1 + 批次 3）（目标 v0.4.99 → v0.4.100）✅ 已完成

**范围**：用户从本文件 `### 遗留待开发` 表中圈定的**两批共享同一缝隙**的项，一次收口（**批次 1** = 内建类注册表 & Class 值：内建类进注册表、内建类作 Class 值、`is`/`as` 的右操作数为内建类/接口 Class 值、`getDefinitionByName` 的 `#1065` 与消息、未知类型标注报 `CodegenError`、`IDataInput`/`IDataOutput` 注册；**批次 3** = `in`/`delete`/下标：Array 的 `in`、Vector 的 `delete`/`in`、`is`/`as Vector.<T>` 对动态左值）。**验收口径一律 `adl 51.4.1` 双端探针逐行对照**（`temp/pkg1/oracle/`、`temp/pkg1d/oracle/`），凡 AIR 已定义行为**逐字**对齐（§1.5）；跨切面、需独立立项的子项（`int`/`uint` 的独立 box tag、`Dictionary` 虚拟 vtable、原始包装类作 Class 值、内建**接口**作 Class 值、`Vector.<T>` 作 Class 值）**明确划出**并在遗留表内收窄改写，不混入本阶段。

**一、批次 1a —— 内建类进类注册表 + 忠实 `#1065`**：`emitClassRegistry`（`src/emit.ts`）原先只给「有 `fqn` 的用户类/SWC 类」发 `_cls`，故 `getDefinitionByName("flash.display.BitmapData")` 抛 `Error #0: No definition found`（`adl` 返回类对象）；未命中时错误号是硬编码的 `0`。现在：① 对**每个有 `reflectFqn` 的类**（含全部内建类）发一份 `static as_class <name>_cls = { &<name>_vt, NULL, NULL, "<reflectFqn>", 0, NULL };`（**工厂/构造指针留 `NULL`** —— 内建类的 C 构造器是各自的特化符号，凭空指向它就会发明 AIR 没有的构造语义；故内建类被 `new (classValue)()` 时仍是**响亮**的 `#1063`）；② 同时放宽 `hasClassRefs` 与 `_cls` 前向声明的判据（`fqn || reflectFqn`）与 `emitVarLexical` 的 Class 值解析；③ 未命中改抛新的 `as_throw_def_not_found(const char* rawName)` ⇒ **`Error #1065: Variable <末段> is not defined.`**（`errorID` 亦是 **1065**；名按最后一个 `.` 或 `::` 取末段）。**顺带更正一处我方旧记载**：原遗留行说 AIR 的 message 是 `"Error #1065"`，双端复测实为完整句 `Variable NoSuchClass is not defined.`（`temp/pkg1d/oracle/adl-idi.txt` 同族现象一致）。

**二、批次 1b —— 内建类作 Class 值**：`var c:Class = Object;`、`trace(BitmapData)`、`BitmapData is Class` 原先一律 `Codegen error: undefined variable 'BitmapData' at top level`，而 `adl` 给 `[class BitmapData]` / `true`。新增 `as_class_is_val(as_value, as_class*)`（实现 AIR 的自动装箱：`null`/`undefined` → false；**原始值**仅在目标 FQN 为 `Object` 时为 true（`as_is_object_cls` 按 `c->fqn` 比对，不用 `&Object_vt`——内建 `Object` 类的 vtable 未必是那一个））、`as_class_is_obj`（委托前者）、`as_class_str(c)`（⇒ `[class <短名>]`）；`as_class_as_val` 处理 `as`。替换两处恒返回字面量 `"[class]"` 的站点（`vectorElemToStr` 与 `toStringExpr` 的 `case 'class'`）与 `as_v_str_val` 的 tag 4 分支；`emitIs`/`emitAs` 的原始类型分支改走 `as_class_is_val(this.boxExpr(o), clsVal)` / `as_class_as_val(...)`。**`adl` 对照 11 例逐字一致**（`temp/pkg1/oracle/adl-pkg1.txt` C1/C4/C7/E2/E3/E8/E9 + `adl-na.txt` 的 `NA=[class NativeApplication]`）。

**三、批次 1c —— 未知类型标注报 `CodegenError`**：`var x:NoSuchType = null;` 以前**不发语义错**、一路泄漏到 clang（`error: unknown type name 'NoSuchType'`，**无 `行:列`**，违背 §2.5）。在符号表侧新增 `checkTypeAnnotation(t, importAlias, known)`（`src/symbols.ts`，紧随 `resolveType`），递归校验 `Vector.<T>` 的元素，报 `` `unknown type '${t}'` `` / `` `unknown interface '${t}'` ``；在 `symbols.ts` 的 5 处声明块（接口方法、类字段、构造器参数、方法返回+参数、自由函数返回+参数）直接接入（其中**接口方法那处延后到 pass 2.1**，原因见第八节），**emit 侧** 新增 `Emitter.ann(t)`（先 `checkTypeAnnotation` 再 `resolveType`）并替换 26 个标注站点（`hoistVar`、`collectWalkFuncVarsStmt`、`walkStmt` 的 Var/Const、参数遍历、匿名函数参数/返回、`fn` 返回/参数、构造器参数、方法返回/参数、自由函数声明参数、模块变量、`loopVarType`、局部变量发射）+ `paramDecls`（自由函数原型是唯一能拦下其参数的站点）。**关键取舍：校验绝不能放进 `rt()`** —— 它同时是 `Type(expr)` **强转语法**的名字探测点，在那里校验会把合法自由函数调用拒掉（实测 `Codegen error at 19:5: unknown type 'fib'`）；故 `rt()` 保持纯解析，校验只在 `ann()` 与符号表。**双层兜底**（符号表 + emit 站点）保证只出现在一条路径上的构造同样被拦。实测：`temp/pkg1d/Bad.as` ⇒ `Codegen error at 1:1: unknown type 'NoSuchType'`（真 `CodegenError` 栈）；catch 子句的类名**早已**有独立校验，未动。

**四、批次 1d —— `IDataInput`/`IDataOutput` 注册 + `ByteArray.writeDouble`**：`class TLSish extends Socket implements IDataInput, IDataOutput`（`com.hurlant.crypto.tls` 的形态）原先报 `unknown interface 'IDataInput'`。两个接口现已在 `symbols.ts` 里**按 AIR 的完整成员表**注册（`IDataInput` 14 个读方法含 `readObject`、`IDataOutput` 12 个写方法含 `writeObject`；`endian`/`objectEncoding` 是**访问器对**）——**按 AIR 的完整表、而不是「够用就行」的窄表**：漏登记成员会让我们**比 AIR 宽松**（用户类少实现一个方法也能通过 pass 4），属 §1.5 禁止的静默错误。**归属以装好的 SDK 为准**：两者是 `flash.utils` 而**不是** `flash.net`（`AIRSDK_51.4.1/frameworks/libs/air/airglobal.swc` 的 `catalog.xml` 实测；`reflectFqn` = `flash.utils::IDataInput`/`flash.utils::IDataOutput`）。给 `ByteArray`/`Socket` 补 `implements`、给 `URLStream` 补 `implements: ['IDataInput']`，并把 `endian`/`objectEncoding` 标为 `isAccessor: true`（pass 4 只比**名字 + 种类**，访问器成员必须由访问器满足，用户 `public var` 不能顶）。**顺带补上完全缺失的 `ByteArray.writeDouble`**，并发现一个**真字节序缺陷**：AIR 的双精度是**按 ByteArray 端序的原样 IEEE-754 八字节**，不是「高 32 位先写」——初版实现（两次 `as_ba_put_u32`）在**大端**下错，而早期比对只看 bytes 0/1（两种字序下都是 0）故漏网；由本阶段示例抓出。修法：新增 `as_ba_swap64`（由 `as_ba_swap32` 合成），`writeDouble`/`readDouble` 改为整块 8 字节 `memcpy` + 条件交换；`adl` 实测口径 `temp/pkg1d/oracle/adl-dbl.txt`（小端 `1.0` = `00 00 00 00 00 00 F0 3F`、大端 = `3F F0 00 00 00 00 00 00`）。`Socket.writeObject` 精确；`Socket.readObject` **响亮**报「socket 读侧不可回退」（新登记 1 行）。`emitInterfaceVtables` 的访问器 setter thunk 顺带发出**类型条件**的 GC 写屏障（`as_value` → `gc_write_barrier_value`、指针 → `gc_write_barrier`、标量 → 无）。

**五、批次 3 —— `in` / `delete` / 下标**：① **Array 的 `in`**（静态 `Array` 原先**编译期被拒**、动态数组两问恒 false）：新增 `as_array_has(a, key)` —— `length`、区间内**非空洞**下标（`tag != 5`）、命名属性三者之一为真；`as_dyn_has` 的 `dk==2` 接上它。② **Vector 的 `in`/`delete`**（静态 Vector 原先直接 codegen 报错）：新增 `as_vec_has_len(key, len)` 并按「键可归约为下标且 `0 <= i < len`」判定，静态路径的长度取自 `as_vec_get_hook`（`*` 路径走新钩子 `as_vec_has_hook` / `as_vec_has_impl`，在 `as_vec_wire` 里装配），两条路都汇入同一助手、**不可能漂移**；`delete vec[key]` = **求值键、返回 `true`、不做删除**（`as_dyn_del` 的 `dk==3` 直接返回 `true`）——**并更正一处我方误归因**：旧记载说 `delete vec[i]` 该抛 `#2005`，实测 `adl` 返回 **true 且是 no-op**，而 `#2005` 实属 `new Vector.<int>(非数字长度)`（`temp/vecconv/adl.txt`）；据此**删掉**了误加的 `as_vec_del_2005`（发射点 + runtime 声明）。③ **`is`/`as Vector.<T>` 对动态（`*`）左值**：新增 `as_vec_is_name(v, name)` / `as_v_as_vec_named(v, name)`，右操作数为 `Vector.<T>` 时按**精确元素名**匹配（`Vector.<*>` 不命中、`[] is Vector.<Number>` 为 false），静态左值仍走原有字面比对（**不让静态路径退化成查表**）。④ **裸 `Vector` 作类型名不是缺口**（口径更正）：`mxmlc` 接受 `var vv:Vector;` 但**拒绝** `var vv:Vector = new Vector.<int>();`（「从类型 `Vector.<int>` 的值到不相关类型 `Vector` 之间的隐式强制转换」）⇒ 有意义的那一半 AIR 自己就拒，故我们的 `CodegenError` **吻合 AIR**，原遗留行的括注随之移出。

**六、顺带修掉一个生成 C 的告警**：`emitIs` 的接口分支发出 `as_iface_lookup(...) != NULL` 时**未加括号**，使 `!(x is IDataInput)` 变成 `(!as_iface_lookup(..) != NULL)`（`-Wpointer-integer-compare`；语义正确但噪音）。两处发射点补括号后，本阶段示例构建 **0 warning**（该字符串无测试钉子，`grep as_iface_lookup test/` 为空）。

**七、回归与文档**：新增示例 `examples/builtin-class.as`（62 条断言，期望值逐项取自 `adl` 探针：内建类作 Class 值 / `getDefinitionByName` 命中 + `#1065` / Array `in` / Vector `in`·`delete` 边界 / `*` 接收者的 `is`·`as Vector.<T>` / 动态对象与数组的 `in`·`delete` / `IDataInput`·`IDataOutput` 判定与接口槽读数 / `writeDouble` 双端序字节与往返 / `extends Socket implements` 的 pass 4 通过），离屏、纯 C、纳入回归；`examples/reg-bytearray-endian.as` 增补双精度双端序的**逐字节**钉子（其 `bytes()` 按**无符号**读，`LEstr`/`BEstr` 的 `240`/`192` 与 AIR 逐值相同），`examples/stage86.as` 的「找不到定义」探针改用 `com.example::NoSuchClass`（`flash.desktop::NativeApplication` 在 AIR 里**存在**，原探针本身失真）。单元组 `test/unit/diagnostics.ts` 的 `unit: diagnostics/Codegen` **+11 条**（未知标注 ×9 指名文案与 `行:列`、内建接口一致性 ×2：`class C implements IDataInput {}` ⇒ `class 'C' does not implement method 'readBoolean' of interface 'IDataInput'`），`test/unit/reflection.ts` 随发射形态更新。

**八、本阶段的次序缺陷（由 `examples/air-starling-demo` 端到端构建抓出）**：批次 1c 的接口方法标注校验最初写在 **pass 0（接口注册）**里，而**用户类的类壳要到 pass 1 才注册**——于是 `hasClass` 此刻只看得见内建类，任何**接口方法名引用用户类**的合法程序都被误判。实测炸点：`examples/air-starling-demo` 构建报 `Codegen error at 24:5: unknown type 'Texture'`（`src/starling/filters/IFilterHelper.as:37` 的 `function getTexture(resolution:Number=1.0):Texture;`）。修法：接口仍然在 pass 0 **注册**（那正是 pass 0 的职责），校验改为**延后到 pass 2.1**（pass 2 注册完成员之后）统一跑，位置仍取接口声明的 `行:列`，`importAlias` 复用已存入 `InterfaceInfo` 的那份。**该缺陷能逃过整套自动回归，是因为 `examples/air-starling-demo` 不在 `test/examples.ts` 的套件内**——故同时补了三条正面钉子（跨包 `import`、同包免 import、通配 `import`），钉在 `unit: diagnostics/Codegen` 里。

**验证计数**：`node test.ts` **259/259 全绿**（258 → +1 示例）；`unit: diagnostics/Codegen` 单跑 **39 条 / 3 组全绿**；示例 `examples/builtin-class.as` 单跑 `Build successful` + 零编译器告警；**端到端重建一个不在套件内的大 demo** —— `node src/index.ts --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo --target native` ⇒ `rc=0` / `Build successful`（139/141 源可达，302 warnings、**0 errors**），产物实跑正常（Starling 上下文就绪、9 个资源 `onLoadComplete`）。

**文档**：`README-CN.md` 「当前限制」章新增本条（含 `getDefinitionByName`/内建类表/Class 值/`in`·`delete` 四处旧口径的更正）与示例清单条目；`package.json` v0.4.99 → **v0.4.100**。

**遗留表**：**移出 6 行**（① `IDataInput`/`IDataOutput` 未注册；② `delete vec[i]`/`"0" in vec` 静态 Vector 报错；③ 数组上的 `in`；④ `getDefinitionByName` 错误号与消息；⑤ 未知类作类型标注；⑥ `is`/`as Vector.<T>` 动态左值）；**新登记 2 行**（`Vector.<T>` 作 Class 值/值表达式 —— 值位置先是 parse error；`Socket.readObject` 未实现 —— **响亮**）；**收窄改写 3 行**（`is`/`as` 右操作数为内建类/接口 Class 值 → 内建类已落地、只剩接口与 `Vector.<T>`；内置类名作 Class 值 → 引用类型已落地、只剩原始包装类；反射 API 的内建类名口径 → ①④ 实测**更正为已对齐/部分对齐**，只剩 `int`/`uint` 独立 box tag 与 `Dictionary` 虚拟 vtable）。表内项数 **99 → 95**（部分完成 10 → 13、未开始 88 → 81）。

---

### 阶段一百二十八：多端渲染性能与分辨率收口 —— Stage3D 状态缓存 / 2D mip 链 / 烘焙分辨率与 `BitmapData.draw` 口径（目标 v0.4.100 → v0.4.101）✅ 已完成

**范围**：用户从本文件 `### 遗留待开发` 表中圈定的**四批同属「渲染性能 / 分辨率」缝隙**的项，一次收口；因项目已是**多端**（native Metal / web WebGL2），每一项都按「一份生成 C、两个 seam」的纪律**在两端同步落地**，并以 **`adl 51.4.1` 为唯一 oracle** 做**三端验收**（`temp/mipprobe/` 18 行、`temp/bakeprobe/` 20 行 + 真 GPU 截图）。四批 = **A** Stage3D 状态对象缓存（逐 draw 重建 DSS）、**B** 逐帧分配与 RSS（row 7893）、**C** 2D mip 链（rows 7954/7955）、**D** 烘焙分辨率与几何口径（rows 7927/7928，并顺带定案同族的 `BitmapData.draw(source, matrix)` 源变换行）。**口径**：凡 AIR 已定义行为一律**逐行对齐 `adl`**（§1.5），跨端**逐位相同**；差异不得静默，一律入遗留表。

**一、批次 A —— Stage3D 状态对象缓存（`vendor/stage3d_glue.mm`）**：away3d 的铬环与天空盒**逐 draw 交替** depth 状态（`ASC_S3D_DUMP=1` 实测 `depth=(less,w=0)` 与 `depth=(lessEqual,w=1)` 相间），而 `s3d_rebuild_dss` 每次状态变化都**新建 + 释放**一个 `MTLDepthStencilState` ⇒ `dss=8039 / draw=8040`，即每 draw 一次驱动对象分配（**不泄漏，只是抖动**）。改为**按键值缓存**：新增 `S3D_MAX_DSS 16` 个槽 + `S3DDssVariant`（键 = 状态字段的快照，`s3d_key_str` 把调用者的字符串**拷进槽内**，`depthCompare` 一并入键），`s3d_select_dss` 命中即复用、未命中才新建并 `asc_tr_dss++`（**计数器只统计编译/创建**，故 `dss` 数直接可读为「真实对象数」），满 16 槽按 LRU 淘汰。生命周期按「槽持有 +1、`c->dss` 借用」整理（init 建槽、destroy 逐个释放），避免复用后双重释放。**实测（`Basic_SkyBox`，1680 draws）**：`TRACE draw=1680 compile=1680 make_pso=2 pso_miss=0 dss=2 smp_miss=1 bindtex=1679 cube=1 mipbuild=0 mipdrop=0` —— DSS 对象数 8039 → **2**，管线缓存未受影响（`make_pso=2`/`pso_miss=0`），mip 路径零扰动；截图 `temp/skybox-aot/aot-c-final.png` 204748/204800 像素非黑（120 fps 铬环 + 天空盒反射，肉眼与修前一致）。**全量 src 改动落定后**又做了一次**全量重建**复验（`temp/skybox-aot/build-128.log`）：`TRACE draw=4620 compile=4620 make_pso=2 pso_miss=0 dss=2 smp_miss=1 bindtex=4619 cube=1 smpseti=4620 uptex=0 mipbuild=0 mipdrop=0`（4620 draws 下 DSS 仍是 **2**、程序缓存 0 miss；天空盒应用不传 2D 高级 mip，故 `uptex/mipbuild/mipdrop` 全 0 = 丢弃规则不误伤），截图 `temp/skybox-aot/aot-128-final.png` **204749/204800 非黑（100.0%）**、116 fps。

**二、批次 C —— 2D mip 链（`src/symbols.ts`/`src/emit.ts`/`src/runtime.ts`/两端 glue）**：先补足 **adl 侧口径**（`temp/mipprobe/`，AGALMiniAssembler + 8×8 BGRA 贴图 + 256 px 视口，`T` = uv 平铺数 ⇒ `lod = log2(T/32)`），得到三条决定性结论：① **丢弃的触发条件是「从未上传过任何 level > 0」**，不是 `createTexture(..., mipmapped=true)`（`texY`：标志为真但只传 level 0，配 `miplinear` **照样丢弃**）；② 上传一级时的口径是**区域规则** —— 取**源位图左上 `lw×lh`**（`lw = max(1, width>>level)`，并**按源的行距**读，不是按 `lw`），实测 `texC`（把整幅 8×8 条带按 level 传三次）逐行读出 `16/48/80/112`；③ 正确尺度的各级（`texD`）读回**恰好等于上传值**，且 `lod` 只选一层。实现：`Texture`/`RectangleTexture` 增私有 `mips` 计数；`Texture_uploadFromBitmapData` 的 `miplevel != 0` 分支计算 `nlv = max(width,height)` 的层数、拒绝 `miplevel >= nlv`、取 `lw/lh = max(1, w>>miplevel)` 且**钳到源位图尺寸**、置 `o->mips = 1`，走新 seam `as_s3d_texture_upload_level(ctx, gpu, level, lw, lh, pixels, srcW)`；绑定侧把 `hasChain` 传下去（2D 传 `o->tex{i}->mips`、立方体传 `1`）。两端实现**同一条件**的丢弃：`c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0 && 纹理非空` ⇒ 整 draw 丢弃（Metal 侧走一个 `loadAction=Clear` 的空 pass **消费掉挂起的清屏色**，故「被丢弃」在回读里表现为清屏色，与 adl 逐位一致；WebGL 侧**必须放在 `glUseProgram` 之前**——GL 对不完整纹理的采样是**黑**，放在之后会把「丢弃」画成黑而不是清屏色）。**验收**：`temp/mipprobe/` 18 行 `adl == native == web` **逐位相同**（唯一差异是尾行 `END-OF-SCENE (sync)` vs `(frames)`——headless 构建没有帧循环，同步跑完即结束）。

**三、批次 B —— 逐帧分配 / RSS（row 7893）：不改码，用测量结案**：row 当年建议的三处修法**都已在位**——① `ASC_stage3d_pixels` 只在 `w/h` 变化时重分配、`s3d_submit_scratch` 是 grow-only 缓存（两者只服务 CPU-raster 的 `#else` 路径与逐帧顶点解交织），② `gc_trim_os()` → `malloc_zone_pressure_relief(NULL, 0)` 已接到 500 ms 的 release pass（`ASC_GC_RELEASE`），③ `as_alloc()` 只被文件枚举助手使用、**不在逐帧路径**。新写自包含 harness（`temp/rssharness/rsscycle.py`，自带「启动 → 轮询窗口 → AppleScript 移到屏上/激活 → `screencapture -l` → 点按钮换场景」全链路）实测：**Skybox（Metal, 120 fps, 连续）** 172.4 → 174.5 MB（前 20 s +2 MB，后 40 s +0.1 MB）⇒ 平；**菜单↔场景 4 轮** +0.7 MB/轮且递减；**Sprite 3D（场景 11）12 轮** 205.7 → **195.0 MB**（第 8 轮掉 11 MB = release pass 生效，**无增长**）；**Sprite 3D `--stay` 60 s** +0.1 MB ⇒ 平；**Benchmark（场景 9）+ Start** 223 → 590 MB/10 s（+34 MB/s）后衰减到 451 MB —— 但 `ASC_GC_STATS=1` 同期显示 GC 堆 `18MB → 110MB`（`instance 28.7→32.4MB/402176→454020`、`bytes 32.1→38.8MB`）、`as_big = 0`（无 arena ≥1 MB），`vmmap` 峰值 `Physical footprint 560.3M`、`MALLOC ZONE 33% FRAG`，而**衰减后** footprint 270.9M、`MALLOC_SMALL (empty)` 112.7M → 2.75M、**FRAG 0%** ⇒ 结论：那条曲线是 **Starling 设计内的活集增长（benchmark 自己抬高对象数）+ 分配器高水位**，且高水位**已被 release pass 归还**，无逐帧临时分配泄漏。row 7893 据此关闭。

**四、批次 D —— 烘焙分辨率与 `BitmapData.draw` 几何口径**：adl 侧新写探针 `temp/bakeprobe/`（离屏 `BitmapData.draw` + `getPixel32` 扫描：包围盒、`alpha>8`/`alpha>128` 的左边界线宽、逐像素 `pixdiff/maxdiff`；**判据取「缓存开 vs 关逐像素相同」**——这正是 AIR 的行为）。三处落地：

1. **烘焙分辨率（row 7927）**：`as_render_cached` 原先 `sc = ASC_render_scale`（**只含 dpr**），而回贴目标画布带的是 `dpr × 祖先缩放 × 自身缩放` ⇒ 缓存内容被回贴**放大点采样**（`scale=2` 的边框 4 物理 px、字边锯齿）。新增 `as_bake_scale(canvas, lw, lh)`：取**目标画布总缩放**，上限 `4 × ASC_render_scale`（比例护栏）与 `AS_BAKE_MAX_PIXELS = 4e6`（像素预算，≈16 MB）；超限即退回「放大回贴」的旧行为（质量降级但内存有界）。**九宫格 `as_render_nine_slice` 同源同修**（同一助手——它的条带也是按**逻辑单位**回贴到带自身缩放的画布上）。adl oracle：`cacheAsBitmap` 开/关在 `k=1/2/3` 与「祖先缩放」两态**全部 `pixdiff=0 maxdiff=0`**（真实 GPU 的 1:1 回贴是同一结论）。
2. **`BitmapData.draw` 的源矩形与边框 +1（row 7928）**：adl 实测 `bd.draw(field, mat_k)` 的包围盒 = **`width·k + 1`**（41/81/121），且边框在任何 `k` 下都是**1 个位图像素**（`line>8=1`、`line>128=1`）。⇒ 源矩形里的 `+1` 是**位图像素**（`width/s + 1` 局部单位），不是 1 局部单位；`as_render_bounds` 的那个 +1 只服务烘焙/滤镜面尺寸（略大一点无害），渲染侧早已是屏幕空间 1 px（阶段九十四·二十一）。**同批修掉一个由本探针抓出的新偏差**：`BitmapData.draw(src, matrix)` 原先在 **1× 栅格**里画对象、再被逆矩阵采样器**放大**（`k=2` 时边框变 2 px、`k=3` 变 3 px，与 adl 的恒 1 px 不符）。现在按矩阵缩放 `rs` 栅格化（TextField 与 DisplayObject **两个分支**都改：画布 `scale(rs,rs)`、源矩形按 `rs` 计尺寸），采样坐标统一乘 `rs`（栅格 1:1 读回），并在栅格化期间把 `ASC_render_scale` **钉为 1**（离屏位图里「设备像素」就是位图像素 ⇒ 与窗口 dpr 解耦，hdpi 窗口下口径也一致）。`BitmapData_draw` 在 `ASC_render_scale` 声明之前发射，故补了该全局的**前向声明**（与 `ASC_win_scale` 同形）。
3. **顺带定案 `BitmapData.draw` 的 source 自身变换**：该行原写「未定案，需先用 `adl` 做 2×2 矩阵（带/不带容器、带/不带 `matrix`）」。补测后定案：**AIR 完全忽略 source 自身的变换，只吃 `matrix` 参量，两者不相乘** —— `cont.scaleX=scaleY=2` 独立 `draw` 得 **41×21**（= 1× 尺寸），再加 `mat=scale(3)` 得 **121×61**（= 只按矩阵 3×，不是 2×3×）。按该行的选项 ①实施：栅格化期间把源的 `x/y/rotation/scaleX/scaleY` 与 `transform.matrix` **归零**、事后原样还原（**保留** `alpha`/`visible`/滤镜/子件——那些是外观不是变换）。用户侧可观测的语义变化：此前「给对象设了 `x/y/scale` 再 `bd.draw(o)` 指望它生效」的代码，现在与 AIR 一致地不生效。

**五、跨端同步清单（seam 纪律）**：Stage3D 的 `s3d_*` seam 一份签名两处实现 —— native `vendor/stage3d_glue.mm`（Metal）、web `vendor/stage3d_webgl.cc`（WebGL2）；ABI 钉子（`test/unit/stage3d.ts` 的 `stage3d/webgl-abi`）要求 **`src/runtime.ts` 里引用的每个 `s3d_*` 都在 webgl glue 里定义**，本阶段新增的 `s3d_texture_upload_level`/`as_s3d_texture_upload_level` 两端同时定义并同时接入钉子；`s3d_bind_texture` 加第 4 参 `hasChain`（名字型 ABI 钉子只查名字，签名可改）；丢弃规则用**逐字节相同**的条件串钉在两端。`s3d_flush(ctx);` 的出现次数是钉子（新同步点不得借用 `s3d_flush`），本阶段未新增。2D 显示侧（`as_render_cached`/`as_render_nine_slice`/`BitmapData.draw`）走**同一份生成 C**，两端只是光栅后端不同（Skia CPU raster / Ganesh）⇒ 生成侧一处改动天然覆盖两端，三端逐位相同即是证据。

**六、顺带修掉一处 headless Metal 链接缺陷**：`vendor/stage3d_glue.mm` 的 `sk_mtl_shared_queue` 原以 `__attribute__((weak_import))` 声明，而**现代 macOS 链接器仍把它当未定义符号**（`Undefined symbols: _sk_mtl_shared_queue`），故 `examples/stage83.build.json` 那种 headless Stage3D 构建（不链 `metal_glue`）链接失败（**既有缺陷**，非本阶段引入）。改为 `#include <dlfcn.h>` + `dlsym(RTLD_DEFAULT, "sk_mtl_shared_queue")` 惰性查找（`SkMtlSharedQueueFn` 函数指针缓存），`s3d_create` 取到共享队列则采纳、取不到用自有队列 ⇒ 普通清单即可链接（不再需要 `-Wl,-U`）。钉子在 `unit: stage3d/gpu-queue-sharing`。

**七、回归与验证**：单元组 —— 新增 `unit: render/BakeResolution`（7 条：烘焙缩放来源 + 双护栏 + `draw` 栅格缩放 + 源矩形 +1 是位图像素 + `ASC_render_scale` 钉位 + 源变换归零与还原 + **三端探针逐行一致**），改写 `unit: stage3d/mip-semantics`（区域上传调用、`o->mips` 置位/清零、层数拒绝、两个结构体的 `mips` 字段、2D/立方体绑定传参、两端丢弃规则的条件串与**位置**、`texHasMips` 清零）与新增 `unit: stage3d/dss-cache`（16 槽、键值选择、LRU 淘汰、`asc_tr_dss` 只计未命中、键拷贝与 `depthCompare` 入键），`stage3d/gpu-queue-sharing` 改写为 dlsym 形态；`node --test --test-name-pattern='stage3d/' test/unit/*.ts` **26/26 全绿**。示例端到端 `node test.ts` **263/263 全绿**（新增示例 `examples/bakecrisp.as` —— 离屏 `BitmapData.draw` 探针的**可回归化**：`cacheAsBitmap` 开/关在祖先缩放 1/2/3 下逐像素相同、`draw(field,scale(k))` 墨迹 `41x21/81x41/121x61` 且边框恒 1 位图像素、`draw(container)` 忽略源自身变换、几何 shape 在 `scale=2` 下 `62x40` 且 `pixdiff=0`，该示例在 `test/examples.ts` 的 `EXAMPLE_ARGS` 里登记了 `--manifest examples/bakecrisp.build.json`（**必须链 Skia**：它断言的是 `getPixel32` 像素，纯 C 构建的 `draw` 是空桩、墨迹 0x0，与只 `trace` 的 `autobake.as` 不同）；逐条对应 adl 实测行；**这正是修前的反例**——修前 `k=2` 的 `pixdiff` 是 528、边框 2 px）。另修 `test/unit/text-input.ts` 的 `TextSelection` 钉子（该钉子把旧口径 `sw = ceil(_fieldWidth) + 1` 钉死了，已按 adl 实测改为 `sw = ceil(_fieldWidth * rs) + 1`）。真实 GPU 无回归：`Basic_SkyBox` 重新全量构建（**记一个坑**：`temp/skybox-aot/relink-a3d.sh` 的「只重编 glue、对旧 `.o` 链接」仅在生成 C 未变时有效——`emit.ts` 一改，旧 `.o` 里的调用约定就与新的 `.c` 不匹配，实测表现为 `EXC_BAD_ACCESS` 在 `s3d_compile` 的 `snprintf` 里，真因是参数错位；必须全量重建）。

**文档**：`README-CN.md` 三处口径更新（烘焙分辨率不再是 dpr、`BitmapData.draw` 源变换与 +1 口径、2D mip 链已落地），`docs/zh-cn/display3d.md` §9.2（2D 不再只收 level 0）/§9.5（无链丢弃已落地）/新增 §9.12（状态缓存 + 2D mip 链 + 两端同步），`package.json` v0.4.100 → **v0.4.101**。

**遗留表**：**移出 7 行**（同上「本轮变动」① ~ ⑦）、**新登记 4 行**（web 构造器期 Stage3D + wasm 异常不可捕、`catch (e:*)`、内建可选参数、`textWidth` 字距口径）；表内项数 **95 → 92**（`部分完成` 12 → 10、`未开始` 82 → 81、`调研完成 · 实现暂缓` 1 不变）。

---

### 阶段一百二十九：显示器刷新率查询（`VsyncStateChangeAvailabilityEvent.refreshRate`）+ `Stage.vsyncEnabled`，并修掉 `--air-app` 闭包 `this` 捕获缺陷（目标 v0.4.101 → v0.4.102）✅ 已完成

**需求来源**：可移植地让 `stage.frameRate` 跟上**真实面板刷新率**（120 Hz 屏上跑 120、拖到 60 Hz 外接屏自动降到 60）。难点在于 **AIR 根本不提供刷新率查询**：`flash.display.Screen` 只有 `bounds`/`visibleBounds`/`colorDepth`，与刷新率沾边的只有 `flash.events.VsyncStateChangeAvailabilityEvent`，而它**只带一个只读 `available:Boolean`**。

**一、adl 51.4.1 实测口径（唯一 oracle）**：

| 项 | 实测结果 |
|---|---|
| 构造器 | 恰为 `(type:String, bubbles=false, cancelable=false, available=false)`；**加第 5 个实参 `mxmlc` 直接拒绝**（「不超过 4 个」） |
| `available` | **只读**（赋值即编译错） |
| 常量 | `VSYNC_STATE_CHANGE_AVAILABILITY` = `"vSyncStateChangeAvailability"` |
| 派发时机 | **一次**，在 `ADDED_TO_STAGE` 之后；`available` 实测恒 **`false`** |
| `Stage.frameRate` 默认 | `24` |
| `Stage.vsyncEnabled` | **可写**，默认 `true` |

⇒ 判据（AGENTS.md §1.5）：「刷新率查询」在 AIR 里**没有对应物** ⇒ 属**增强**（`docs/zh-cn/enhancements.md` E16）；而 `Stage.vsyncEnabled` 是 **AIR 已定义**的开关 ⇒ 属**对齐**。

**二、实现**：

- **`src/symbols.ts`**：注册 `flash.events.VsyncStateChangeAvailabilityEvent`（superClass `Event`；字段 `available:bool` + `refreshRate:number`；静态常量；构造器 = AIR 的 4 参 **+ 第 5 个可选 `refreshRate`**），并加 BUILTIN_FQN `flash.events::VsyncStateChangeAvailabilityEvent`；新增 `Stage.vsyncEnabled` getter/setter。
- **`src/emit.ts`**：① 一个**应用级** `static bool ASC_app_vsync_enabled = true;`（AIR 的默认值）——与 `ASC_app_frame_rate` 同理，`Stage` 在 AIR 里是应用级单值；② `Stage_get/set_vsyncEnabled` 只是它的代理；③ `VsyncStateChangeAvailabilityEvent_ctor/_new`；④ `ASC_dispatch_vsync_event(id, stage)`：**启动后首个已知帧** + **窗口落到不同速率的显示器**时各派发一次（用 `ASC_vsync_last_refresh` 去重），`available` 恒 `false`（同 adl）、`refreshRate` = 当场读到的刷新率；**`rr <= 0` 即不派发**（web/离屏无对应物 ⇒ 绝不伪造 `0`）；⑤ 挂到 `ASC_window_on_frame` 里、`Stage_dispatchFrame` **之前**（AFTER `ADDED_TO_STAGE` 且 ctor 里加监听器已生效）；⑥ **pacing 门**：`ASC_window_on_frame_delay` 里 `vsyncEnabled == false` 时**去掉**「显式 frameRate 高于面板就封顶」的规则。
- **演示接线**：`examples/air-starling-demo/src/Demo.as` 监听该事件并在回调里 `stage.frameRate = e.refreshRate`。

**三、`--air-app` 闭包捕获缺陷（验证中撞出，pre-existing，已修）**：`--air-app` 的引导代码（`src/air-app.ts:271`）会生成**顶层** `var stage:flash.display.Stage = new flash.display.Stage();`，于是**任何**在**闭包**里读裸 `stage` 的方法都让 `--air-app` 构建**编译失败**：`error: use of undeclared identifier 'this'`（**只在 `--air-app` 下暴露**——直接编译同一份源码无恙；demo 只是碰巧没在闭包里读裸 `stage`）。

**根因是两处解析不同口径**：闭包捕获 walk（`emit.ts` 的 `Var` 分支）用 `lookupFuncVar`（**含模块帧 `funcVars[0]`**）判断「这个裸标识符是不是局部变量」，而发射期 `emitVarLexical` **刻意**让类成员优先——模块变量只在 `currentClass === null` 时可见（其注释原文：*a top-level `stage` never shadows the DisplayObject.stage getter*）。于是 walk 认为它是局部 ⇒ **跳过 getter 检查** ⇒ 不给闭包捕获 `this`，而发射期仍按 getter 发 `this->vtable->get_stage(this)` ⇒ 没有接收者的 `this`。**排除实验**（逐个名字对照 walk 输出）：`width`/`root`/`numChildren`/`mouseX`/`alpha`/`scaleX` **全部正常**，**只有被引导代码烤进去的 `stage`** 命中（`funcVar=y`）。

**修法**：新增 `lookupFuncVarLocal`（只搜**真正的函数局部帧**、排除模块帧），walk 在 `currentWalkClass !== null` 时一律用它 —— 与发射期同口径。**回归钉子** `unit: emit/ClosureThisCapture`（6 条）+ **反例验证**：把修复回退后头两条钉子当场变红。**探针踩坑（已写进钉子注释）**：第一个版本的探针闭包里同时读 `stage` 与 `width`，而 `width` 会**独立置位 `needsThis`**、把缺陷掩盖掉（回退后仍全绿）；关了 `stage` 单读才拉得开。

**四、验收**：

- **单元/示例**：`examples/vsyncevent.as`（离屏）+ `test/unit/vsync.ts` 结构钉子；`unit: emit/ClosureThisCapture` 6 条。
- **真机窗口探针** `temp/vsyncwin/`（自建 `-app.xml` + `drive.py` 驱动窗口跨屏）：`VSYNC available=false refreshRate=120` → 移到 60 Hz 外接屏派发 `refreshRate=60` → 移回 120 Hz 再派发 `120`，且 `TICK fr=120 vsync=true` 说明 `stage.frameRate` 同步跟随。
- **Starling demo 无回归**：按官方路径重建（`node src/index.ts --air-app examples/air-starling-demo/Demo-app.xml --main-class Demo`，18.4 s / 302 warnings / **0 errors**）后跑 `temp/benchvar/knobs.py front` ⇒ **peak 59280 / result 59267 / fps 126.6**（基线带 61.4k–66.2k），即接线 `frameRate` 跟随刷新率后性能无退化。
- **全量回归**：`node test.ts` **265/265 全绿**（新增 2 组：`vsync/VsyncStateChangeAvailabilityEvent`、`emit/ClosureThisCapture`）。

**五、顺带修掉一条**骨灰级**的脆弱钉子**：`unit: numeric/Noreturn` 原先读 **`temp/perfreg/README.md`** 断言 A/B 数字，而 `temp/` 是**可丢弃的**（本轮它已被清掉）⇒ 钉子红。改为读 **`TODO.md`**（阶段九十四·二十六 的 A/B 表里 `21 888`/`42 144`/`_Noreturn`/`bl` 全在）——证据的**持久**副本才是该钉的地方，`temp/` 是草稿纸。

**文档**：`README-CN.md`（当前限制两条 + `Stage` 属性表加 `vsyncEnabled` + `flash.events` 列表加该事件 + 增强清单 15 → 16 项 + 新示例条目）、`docs/zh-cn/enhancements.md` 新增 **§4.8 E16**、`docs/zh-cn/as3-semantics.md` §2「帧率口径」行（封顶现受 `Stage.vsyncEnabled` 控制）；`package.json` v0.4.101 → **v0.4.102**。

**遗留表**：**移出 0 行 / 新登记 0 行**（本阶段是**新增能力**（E16）与**修对一个既有缺陷**（闭包捕获），两者都不属缺口；`Stage.vsyncEnabled` 反而**收窄**了 §2 里那条长期「维持现状」的口径差）。表内项数仍 **92 项**。

---

### 阶段一百三十：Windows 窗口后端三处运行期缺陷 —— 高清模式未生效 / 拖动缩放冻结 / 多窗口帧率互扰（目标 v0.4.102 → v0.4.103）✅ 已完成

**需求来源**：`examples/air-native`（`<renderMode>direct</renderMode>` + `<requestedDisplayResolution>high</requestedDisplayResolution>`）在 Windows 首跑（本机 3840x2560 物理屏 / 150% 缩放 / `GetDpiForSystem`=144）暴露三处**只在 `vendor/window_glue.cc` 一层**的问题：① 高清模式没生效（窗口发糊）；② 拖动/缩放窗口时画面刷新停住；③ 开多窗时拖/缩其中一窗会连带影响其它窗的帧率。三处都与 AS3 语义无关。

**一、根因（探针实测，非推测）**：

| # | 根因 | 证据 |
|---|---|---|
| 1 | `SDL_WINDOW_ALLOW_HIGHDPI` 在 Windows 上是**空操作**；真正让高清生效的是**进程级** hint `SDL_HINT_WINDOWS_DPI_SCALING=1`（同时隐含 per-monitor-v2 感知，进程不再被合成器位图拉伸） | `temp/dpiprobe/probe.c`：不设 hint → 逻辑 1000x680 / scale 1.000；设 `DPI_SCALING=1` → 逻辑 1000x680、物理 1500x1020、scale **1.500** |
| 2 | 拖动/缩放跑在 OS 自己的**模态消息循环**里，而该循环是从 `SDL_PumpEvents` 内部进入的 ⇒ 整个拖动期间主循环被阻塞，此时**唯一**能出帧的是 SDL 的 live-resize 事件监听器。而**主窗口从来没被挂上**该监听器（只有 `sk_window_show` 的 CPU 路径与 `sk_window_create` 挂了）⇒ 主窗拖动**完全冻结** | `temp/dpiprobe/probe8.c`（用 `WM_NCLBUTTONDOWN`+`HTCAPTION` 从辅助线程进**真**模态移动循环）：2.53 s 拖动期间 `loopIters +1`，即主循环确实被阻塞 |
| 3 | 旧监听器**直接调 `on_frame` 并只重画被拖的那扇窗** ⇒ ① 应用帧被拉到 OS 消息速率（`stage.frameRate` 形同虚设）；② 其它窗口**一帧都不画** | 同一次拖动的 A/B（两种模式都收到**同样 359 个事件**：`EXPOSED=260` + `MOVED=99`）：旧 → `appFrames +359`（≈142 fps）、另一窗 `renders +0`；新 → `appFrames +157`（≈62 fps，受 16 ms 节拍约束）、另一窗 `renders +157`。旧模式其余几次实拖为 1235 / 3262 帧（≈494 / 1300 fps），即**帧数完全跟随 OS 事件率** |

**二、修法（三处，全在 `vendor/window_glue.cc`）**：

1. **`sk_video_init()`**：作为**唯一**启动视频子系统的地方，在 `#ifdef _WIN32` + `#ifdef ASC_DISPLAY_HIGH` 内 latch `SDL_SetHint(SDL_HINT_WINDOWS_DPI_SCALING,"1")`；文件里其余**所有** `SDL_Init(SDL_INIT_VIDEO)` 调用点（show 三处、create、`sk_window_get_display_size`）一律改走它 —— hint 必须在**首次 init 之前**设置。
   **为何门在 `ASC_DISPLAY_HIGH`**：AIR 定义 `standard` = 「按 1x 渲染、交给 OS 放大」，而 DPI-unaware 进程本来就正是这个行为；若在 `standard` 下也点亮感知，就等于把 1x 画面塞进物理尺寸渲染目标的角落。故 `standard` 与 macOS/wasm **逐字节维持原行为**。
2. **`sk_pump_frame()`**：把原循环的第 3–5 步抽成一个共享函数（服务 resize + 选帧钟 + **按 `g_app_next` 节拍**派发**一次**应用帧 + 把**所有**可见窗口标脏 + 只重画脏窗），带 `in_pump` 重入守卫（帧回调跑真 AS3，可能开关窗口并推事件，而监听器正是从 `SDL_PushEvent` 里被调到的）。`sk_run_loop` 改为 `double earliest = sk_pump_frame();`，语义与原来逐字等价。
3. **监听器只跑 `sk_pump_frame()`**（不再自行 tick / 重画），且**四条会开窗的路径都挂上它**：`sk_window_show`(CPU) / `sk_window_show_metal`(macOS GPU) / `sk_window_show_gpu` 的 D3D 分支 / `sk_window_create`。

**Windows 上到底谁在喂监听器**（两类事件都能在模态循环里到达）：SDL 在 `WM_ENTERSIZEMOVE` 里 `SetTimer(USER_TIMER_MINIMUM)` → `WM_TIMER` → `SDL_OnWindowLiveResizeUpdate` → `EXPOSED`（实测 260 次）；以及每一步 `WM_WINDOWPOSCHANGED` → `MOVED`+`RESIZED`（实测 99 次；该分支在 SDL 里**无条件**发，不做变化检测）。macOS 侧同一条 `EXPOSED` 由 live-resize 期间的 60 Hz `NSTimer` 发出（`SDL_cocoawindow.m`）—— **两端同一个钩子**，故修法对 macOS 是同向的（CPU 路径早有监听器，本次只是把 GPU 路径补成同构）。

**三、验收**：

- **端到端**：`node src/index.ts --air-app examples/air-native/air-native-app.xml --main-class demo.Main --target native` 的产物运行后 stderr 打 `d3d_glue: window 0 bound to 1500x1020 R8G8B8A8 swapchain`（修前 `1000x680`），而同一次运行 `trace(stageWidth, stageHeight)` 仍打 `1000 680` —— **逻辑尺寸不变**，符合 AIR 语义。
- **A/B 探针**：`temp/dpiprobe/probe8.c`（真模态移动循环 + 双窗口 + 两种监听器行为）见上表；`temp/dpiprobe/ab.mjs` 负责重跑到「两次拖动都真的移动了窗口」再取样（合成鼠标注入有失败率，失败时模态循环立刻退出，探针以 `moved=0` 报明）。
- **跨端不破**：`window_glue.cc` 四种宏组合各自 `-c` 通过（win+D3D+high / win+D3D+无 high / win CPU 无 high / macOS Metal+high）；预处理实测 `"SDL_WINDOWS_DPI_SCALING"` **仅在** `_WIN32 && ASC_DISPLAY_HIGH` 下出现（把它换成 `-U_WIN32` 即消失 ⇒ macOS/wasm 一行都不进）。
- **单元**：新增 `unit: platform/WindowFrame`（16 条源级钉子：hint 的门与唯一性、所有 init 走 `sk_video_init`、四条开窗路径都挂监听器、监听器只跑共享 pump、全应用只有**一处** `on_frame`、pump 的节拍/标脏/重入守卫）。**反例验证**：把三处改动回退成「修前形状」后当场 **7 条变红**（`ℹ fail 1`），复原后 16 条全绿（复原以 sha256 逐字节核对）。

**文档**：`README-CN.md` Windows 节新增一条（高清模式在 Windows 上靠进程级 hint、`standard` 与 macOS/wasm 不受影响）；`docs/zh-cn/win32.md` 新增 §2.8、§5 首跑清单加一行肉眼复验、§6 收口；`package.json` v0.4.102 → **v0.4.103**。

**遗留表**：**移出 0 行 / 新登记 0 行**（三处都是「把已定义行为修对」，不新增缺口；Windows 侧由此**多出**一项已实机验证的能力，而 §5「未验证假设」里与帧率/撕裂相关的几条改为待肉眼复验）。表内项数仍 **92 项**。

---

### 阶段一百三十一：AGAL → HLSL 翻译器（Windows Stage3D 后端的**前置**）（v0.4.103 → v0.4.104）✅ 已落地

**需求来源**（原文保留）：用户立项 ——「AGAL→HLSL（里面已经存在两个翻译版本，可以照抄移植）翻译器开始立项」。它正是 `### 遗留待开发` 里「**Stage3D 无 Windows 后端**」那一行的**前置**：Windows 上 `Context3D` 目前被构建期**响亮拒绝**（`src/air-app.ts` 的 `if (onWin)` → `AirAppError`），文本点名的缺口就是「Windows 侧既无 `stage3d_glue.mm` 的等价物，也没有 AGAL→HLSL 翻译器」。本阶段**只做翻译器**（外加三档目标选择的接线），`vendor/stage3d_d3d.cc`（D3D12 的 buffer/texture/pipeline/离屏 RT/混合状态缓存）是**另一个阶段** —— 二者必须成对，只做一半**不得**宣称「Windows 支持 Stage3D」。

**落地（代码事实）**：翻译器仍是**单一实现**、靠 `target` 分档；本阶段把它从两档扩成**三档**（`0` MSL / `1` GLSL ES 1.00 / **`2` HLSL**），没有拆成第二份代码：

- **三档目标宏**（`src/runtime.ts`）：`#ifdef ASC_S3D_HLSL` ⇒ **2**、`#elif defined(ASC_S3D_GLSL)` ⇒ **1**、否则 **0**。HLSL 支**必须**排在 GLSL 之前（Windows 的 Stage3D 构建同时定义 `ASC_S3D_HLSL` 与 `ASC_RENDER_STAGE3D`）。消费点是 `Program3D.upload`（`emit.ts` 的 `as_agal_translate(..., ASC_AGAL_TARGET)`）。
- **逐处三档化**（立项条目点名的陷阱全部落实）：`agal_reg_name` 的 `OP`/`OD`（`input.aN`/`input.vN`，与 MSL 的 `[[attribute(N)]]`/`[[user(...)]]`、GLSL 的 `attribute`/`varying` 并列）、片元 `ocN`、以及 `kil`/`tex`/比较指令里原本**写死 GLSL 名**的 `else` 分支（`gl_FragColor`/`gl_Position`/`gl_FragDepth`/`discard_fragment()`/`mix`/`greaterThanEqual`）——HLSL 侧一律走 `SV_Target%d`/`SV_Position`/`SV_Depth`/`discard`/`float4(a >= b)`。**任何一处漏改都会让 HLSL 静默产出一份混着 GLSL 名字的着色器**，故单元组把「方言隔离」钉成不变量（见下）。
- **HLSL 前导（结构与绑定）**：`struct VSIn { float4 a0 : TEXCOORD0; … }` / `struct VSOut { float4 varying0 : TEXCOORD0; … float4 position : SV_Position; }`（**varyings 在前**，阶段一百三十二 在 D3D12 上实测确认这是 fxc 的**寄存器号**规则、不是排版偏好：`SV_Position` 放首位会让 VS 的 `TEXCOORD0` 落在 reg 1、PS 侧落在 reg 0 ⇒ `CreateGraphicsPipelineState` 报「Signatures between stages are incompatible」）/ `cbuffer VCBuf : register(b0) { float4 vc[N]; }` / `Texture2D<float4> fs0 : register(t0)`（cube 为 `TextureCube<float4>`）/ `SamplerState smp0 : register(s0)`。采样器按被采样寄存器**逐个声明**（沿用阶段八十九·三十九 给 MSL 定下的口径，不回 GLSL 那种「过滤/环绕状态挂在纹理对象上」的模型）；矩阵抬成行向量：`op = mul(float4x4(vc[0], vc[1], vc[2], vc[3]), input.a0);`（`m33`/`m34` 同样按 `mul(float3x4(...), sN)` 发，三目标逐字一致）。
- **朝向**：**不发射** GLSL 分支那句 `gl_Position.y = -gl_Position.y`（D3D 与 Metal 同为「行 0 在顶」，只有 GL 在底）。
- **指令名**：`frc`→`frac`、`rsq`→`rsqrt`、`sat`→`saturate`、`ddx/ddy`→`ddx/ddy`、`crs`→`cross`、`kil`→`if (<src>.x < 0.0) discard;`、`tex`→`fsN.Sample(smpN, …)`、全掩码比较→`float4(input.v0 >= input.v1)`、`iid`→入口 `uint iid : SV_InstanceID` + `float4(iid, iid, iid, iid)`、`od`→`float od;` + 输出槽 `depth : SV_Depth`。`tld`/`sgn` 三档一致**响亮未支持**（错误文案现为「is not translated to MSL/GLSL/HLSL yet」，例句见 `examples/stage80.as`）。
- **接线（`ASC_S3D_HLSL` 三处）**：① `runtime.ts` 的目标宏（上）；② `emit.ts` 的 `AGALTranslator.translate` 桥——`"hlsl"` 必须**显式**映到 `2`（原先只认 `"glsl"`、其余一律当 MSL；不补这一档，Windows 调用方会**静默**拿到 Metal 源码）；③ `emit.ts` 的 `Context3D.driverInfo` 加 `#elif defined(ASC_S3D_HLSL)` ⇒ `"Direct3D12 (Stage3D)"`，且该支**排在 `ASC_RENDER_STAGE3D` 之前**（Windows Stage3D 构建两个宏都有，只有这一支为真）。`air-app.ts` 的 Windows **拒绝保留**——`vendor/stage3d_d3d.cc` 仍不存在，去推一个不存在的源文件比这条消息是**更差**的诊断；文案改为明说「翻译器已完成、缺的是 D3D12 胶水」。

**两条实测发现（真 `D3DCompile` 实测，非文档推定）**：

- **空结构体非法**：未读任何属性（varying）时发出的 `struct VSIn {}`/`struct FSIn {}` 被 fxc **拒绝**（MSL/GLSL 容忍，我方 MSL 至今照发——见新登记的遗留行）。HLSL 侧改为先扫 `agal_is_used` 再决定发不发结构体，入口签名跟着变（无属性时 `vs_main(uint iid : SV_InstanceID)`、无 varying 时 `fs_main()`）。
- **标量 splat 构造器非法**：fxc 在 `vs_4_0`/`ps_4_0` 上对**一切**标量 splat 数值构造器报 `X3014: incorrect number of arguments to numeric-type constructor` —— `float4(dot(a,b))`、`float4(scalarVar)`、连 `float4(1.0)` 都拒（开/关 `D3DCOMPILE_ENABLE_STRICTNESS` 一样；DXC/`ps_6_0` 接受，故**不能**拿 DXC 的口径当 ps_4_0 的）。于是 `dp3`/`dp4` 在 HLSL 侧发**标量 swizzle** `dot(input.v0.xyz, input.v1.xyz).xxxx` / `dot(input.v0, input.v1).xxxx`，MSL/GLSL 保持 `float4(dot(...))`。立项条目预判的「HLSL 三元 `?:` 不吃 `bool4`」也在同一批实测里确认（故比较指令直接发 `float4(bool4)`，不用三元）。

**验收（已做，证据在 `temp/hlslcheck/`）**：① 三档目标选择有单元钉子（`ASC_S3D_HLSL` ⇒ 2 / 无宏 ⇒ 0 / `ASC_S3D_GLSL` ⇒ 1）；② HLSL 文本结构钉子 —— 寄存器命名、`register(b0)`/`register(tN)`/`register(sN)`、`SV_Position`/`SV_TargetN`/`SV_Depth`/`SV_InstanceID`、**无 `gl_*` 残留**、**无 `gl_Position.y` 取反**、比较指令形态、以及**方言隔离**（GLSL 内建名只允许出现在 `target == 1` 的发射行里、MSL 区无 D3D/GL 拼写、HLSL 区无 GL/Metal 拼写），共 18 条，见 `test/unit/stage3d.ts` 的 `stage3d/agal-hlsl` 组；③ **MSL/GLSL 输出逐字不变** —— 同一批程序对三目标各出一份（共 54 份）：**35 份与改动前逐字节相同**、19 份不同，后者 = 18 份 target 2（新写的 HLSL 档；其中 `vertex_badop.vs.2` 的内容就是那句未变的 `invalid opcode` 错误，故真正变更 17 份）+ `vertex_tld.vs.{0,1}`（唯一变化是未支持文案**加了 `/HLSL`**）⇒ **两个旧目标在所有程序上的产物逐字未变**（`examples/stage80.as` 全量回归 + `stage3d/agal-sampler-flags` 等旧组同绿）；④ **每一条生成的 HLSL 都过真 `D3DCompile`**（本机 `d3dcompiler_47.dll`，`vs_4_0`/`ps_4_0`，开 strictness）：**16 份编译通过 / 2 份被翻译器响亮拒绝 / 0 失败**（剩下的 warning 都可解释：`X3578` 未初始化输出＝测试程序确实读未写的临时寄存器，与 AGAL/MSL/GLSL 的语义一致；`X3571 pow` 负底数）；⑤ **负例对照**：把 `input.aN` 那处或 `dot(...).xxxx` 改回旧形态，`stage3d/agal-hlsl` 当场红 2 条、`examples/stage80.as` 红 1 条（`FAIL: HLSL m44 -> mul(float4x4, vec)`），改回即绿；把 `src/runtime.ts` 整体换回改动前版本跑 `test/unit`，单元红 **10 → 9**，**唯一差异就是本组由红转绿**（⇒ 无新增红）。

**未验收（不静默）**：**D3D12 上屏**仍未做——依赖 `vendor/stage3d_d3d.cc`，属下一个阶段；`driverInfo` 在 D3D 后端上的**确切字符串**也**未实测**（需 adl 对着一个可用后端跑），当前 `"Direct3D12 (Stage3D)"` 是**诚实占位**（仅显示用，Starling 的 stats 框），已登记。开发机是 Windows，**Metal/WebGL 两条路径本轮未实机编译**（③ 只是文本对照），故本阶段**只宣称「HLSL 翻译器可用且过 fxc」**，不宣称「Windows 支持 Stage3D」。**（后续：阶段一百三十二 已补上 `vendor/stage3d_d3d.cc` 且 demo 实机跑通；本行「未验收」中的 D3D12 上屏已收口，`driverInfo` 那条仍待与 `adl` 对照。）**

**版本**：v0.4.103 → **v0.4.104**（`package.json`）。

**遗留表**：**移出 0 行 / 新登记 2 行 / 扩写 1 行** —— 本阶段是「Stage3D 无 Windows 后端」那一行的**前置工作**，该行保持**未开始**（还差 `stage3d_d3d.cc`），故不移出任何行。新登记的两行是**三档化过程中撞出来的既有缺陷**（① AGAL 翻译器在 **MSL/GLSL** 两档上的错——片元 `od` 未声明且未接线、`iid` 译成未声明的 `r0`、空 stage 结构：**第三个目标一出现，才第一次有对照能看出前两个是错的**；② **CRLF 检出**下「多行 XML 字面量 + 非 ASCII」触发假 Lex error，正是 `examples/e4x-name.as` 在本机必红而 CI 绿的原因）；扩写的一行是「顶层自由 `function` 名撞 libc/libm 符号」——补上 Windows 侧的**宿主宏撞名**证据。

---

### 阶段一百三十二：Windows Stage3D 后端 —— `vendor/stage3d_d3d.cc`（D3D12 上屏）（v0.4.104 → v0.4.105）✅ 已落地

**需求来源**（原文保留）：用户立项 ——「D3D12 上屏未做（依赖 `vendor/stage3d_d3d.cc`，属下一阶段）；**开始实现。并跑通 demo：`examples/shmup-stage3d`**」。它正是「Stage3D 无 Windows 后端」那一行的**第二个（也是最后一个）前置**：阶段一百三十一 交付了 AGAL → HLSL 翻译器，本阶段交付**消费它的 D3D12 胶水**，并把该 demo 在 Windows 上跑通（开窗 + 3D 帧合成在 2D 显示列表之后）。

**落地（代码事实）**：

- **`vendor/stage3d_d3d.cc`**（新建，~2,290 行）：与 `stage3d_glue.mm`（Metal）/`stage3d_webgl.cc`（WebGL2）**同一套 `s3d_*` ABI、同一套语义**（§9.1–§9.13 逐条移植），只是把 Metal 对象换成 D3D12 对象。结构：进程级 `ID3D12Device`+命令队列+根签名+描述符堆；每纹理资源 + 多级 SRV；三缓冲帧槽（命令分配器/命令列表/上传堆/fence 值）；每批一条命令列表；延迟释放队列；按整个绘制状态键控的 PSO 缓存（`S3D_KEY_CAP 256` × 每程序 `S3D_MAX_PSOVAR 16`，LRU）；按采样器状态向量缓存不可变采样器块（`S3D_MAX_SMPLCFG 256`）；按 (Program3D key, 两源 FNV-1a 哈希) 键控的程序缓存。设计要点已在 `docs/zh-cn/display3d.md` **§10**（提交模型/PSO 键/字段顺序规则/合成），此处不重复。
- **`vendor/d3d_glue.cc` 的 `sk_gpu_draw_texture` 从「未实现且出声」变成真合成**：`ID3D12Resource` → `GrBackendTexture` → `SkImages::BorrowTextureFrom` → `SkCanvas::drawImageRect`（dst-only + `SkSamplingOptions(kLinear,kNone)`）；并新增 `__declspec(dllexport)` 的 `sk_d3d_shared_device()`/`sk_d3d_shared_queue()`。
- **构建期接线**（`src/air-app.ts`）：`usesStage3D && onWin` ⇒ 推入 `stage3d_d3d.cc`、定义 `ASC_S3D_HLSL=1`、链接 `d3d12`/`dxgi`/`d3dcompiler`；**不**推 `stage3d_glue.mm`、**不**加 Metal/Foundation。原先一条「Windows 上拒绝」（`throw new AirAppError`）**已删**。
- **`src/emit.ts` 的两处 `#if` 拓宽**：`present()`/`ASC_stage3d_tex` 处 ⇒ `ASC_RENDER_METAL || ASC_RENDER_D3D || ASC_RENDER_GPU`；合成处 ⇒ `ASC_RENDER_METAL || ASC_RENDER_D3D`（**故意不含** `ASC_RENDER_GPU`——那是 CPU 像素路径，走同处的 `#elif`）。
- **`src/runtime.ts` 的 HLSL `VSOut` 字段顺序**：`varyingN : TEXCOORDN` 提到 `position : SV_Position` **之前**（原因见下）。

**三个只能实测才能发现的障碍（都已修）**：

1. **PSO 的 `E_INVALIDARG`（三次）**：① `RenderTargetWriteMask = 0` —— Stage3D 的默认写掩码是全通道，`c->colorMask*` 必须在 `s3d_create` 建上下文时钳到 1；② 输入布局的 `SemanticName` 必须是**裸名**（`"TEXCOORD"`），索引放 `SemanticIndex`；③ **HLSL 的字段声明顺序就是 stage 寄存器号** —— `SV_Position` 放首位让 VS 的 `TEXCOORD0` 落在 reg 1、PS 侧落在 reg 0 ⇒ 「Signatures between stages are incompatible」。诊断手段：把 D3D12 **调试层的 `ID3D12InfoQueue`** 开到独立探针（`temp/psoprobe.cc`）上逐变体 print，才能把银色的 `0x80070057` 变成一句人话。
2. **采样器描述符堆的 2048 上限**：原先按帧槽给一个大 arena（`12288` 个描述符）直接 `E_INVALIDARG`；改为**按采样器状态向量缓存不可变块**（实际占用个位数）。
3. **合成目标的生命周期（本项目目前最深的第三方 API 陷阱）**：Skia 的 D3D 后端**没有** Borrow/Adopt 概念，`GrD3DTextureResourceInfo::fResource` 是 `gr_cp`，而**裸指针形构造器是「接管」（不 AddRef）而析构会 Release** ⇒ 把自己唯一的引用递进去 = 送出所有权。实测症状：**第 1 帧合成正常**（`desc(dim=3 TEXTURE2D fmt=87 1000x600)`），**第 2 帧同一指针的 `GetDesc()` 变成一个 144 字节的顶点缓冲区**（地址被回收），于是 `sk_gpu_draw_texture` 以 `unsupported render target (dxgi format 0, 1 samples); nothing was drawn` 拒掉它。修法：两处包装点均改 `info.fResource.retain(res)`（Skia 自己的 `D3D12WindowContext_win.cpp` 同样口径），顺带修掉 `d3d_setup_surfaces` 里**每次调用偷一个 swapchain 引用**的潜在双重释放。契约全文与教训见 `docs/zh-cn/win32.md` **§2.9**。

**验收（已做）**：

- **demo 端到端**：`examples/shmup-stage3d`（1000x600 / `renderMode=direct` / `depthAndStencil=true` / `requestedDisplayResolution=high`，输出到 `temp/shmupwin/` 的副本，避免验证期反复改写仓库里的配方）编译 + 链接 + 运行全过：开窗、`stage3d_d3d: context 1000x600 ready (Direct3D 12)`、纹理上传、逐帧 draw/present；安静机器上约 **240 ms 到第 1 帧**。仓库里两份示例配方（`shmup-stage3d.build.json` / `air-native.build.json`）在收尾提交时按本机 `--air-app` 的生成结果入库 —— 该命令本就**就地重写**它们，且 macOS 侧运行时会重新生成回 macOS 配方，故档案中追踪的是 Windows 配方。
- **稳定性**：一跑 **281 帧 / 5 s**（~56 fps，fence 单调递增），每帧 `get_render_target` 都拿到 `desc(dim=3 fmt=87 1000x600)`、每次 `draw_texture` 都被接受，**零** `unsupported render target`/`TARGET DEAD`；改造前后共 9 次重复运行（含固定间隔脚本 `temp/s3drep.mjs`）全健康。
- **客观像素证据**：`ASC_GPU_DUMP=<路径> ASC_GPU_DUMP_AT=40` 导出的 **presented back buffer**（1500x900 BMP，4,050,054 B）里能看到 demo 的 **Stage3D 精灵**（spritesheet 分块）。**注意该环境变量的值是文件路径**（不是开关）；且**判定上屏只能靠这个 dump**——flip-model swapchain 的内容取不到 GDI/BitBlt，屏幕截图会骗人。
- **单元钉子 29 条**：新组 `stage3d/d3d-glue`（9 条：`s3d_*` ABI 覆盖、共享 device/queue 导出与按名查找、**`gr_cp` 所有权契约**（禁用裸指针构造器 + 两处 `retain`）、合成 `#if` 的臂、present 侧的臂、`sk_gpu_draw_texture` 签名）；`stage3d/agal-hlsl` 从 18 条加到 20 条（Windows 接线取代旧的「响亮拒绝」钉子 + **varyings 在 SV_Position 之前**）；另把 `air-app` 的旧拒绝断言改成「不再有该 `throw`」。
- **全量回归（`node test.ts`，PATH 前置 `temp/toolshim` + `temp/llvmbin`）**：**267 用例 / 243 绿 / 22 红 / 2 skip**（耗时 371 s）。与已知 Windows 基线 **266 / 241 / 23 / 2** 逐项对比：**+1 用例 / +2 绿 / −1 红**（+1 用例 = 新组 `stage3d/d3d-glue`；+1 绿 = 它通过；另 −1 红 = `build/DocumentedLinkSets` 转绿，原因是工具链 shim 的资源目录下现在有 `temp/lib/clang/23/include/zlib.h`，与本次 diff **无关**）。**22 红逐条分类完毕，均为已知的宿主/平台类**：14 示例（6 条 `near` 撞 `winnt.h` 的 `#define near`；`bakecrisp` 缺 `skia.lib` 一族；`audio`/`embed` 缺 `vendor/audio_glue.c`；`urlstream-api` 缺 `ShellExecuteA`；`e4x-name` 是 CRLF 检出的 lex 假失败；`stage94d` UTF-16LE 响亮未支持；`socket`/`urlloader-contract` 运行期断言）+ 8 单元（4 组 CRLF 假失败 `platform/BackendParity`、`platform/AudioWiring`、`numeric/Noreturn`、`stage3d/agal-operand-slots`、`stage3d/flush-policy`；`transport/AirAppTransport` 的 macOS 硬编码 link-paths；`render/BakeResolution`+`render/ColorPath`）。日志里 **零**次出现 `stage3d_d3d`/`ASC_RENDER_D3D`/`gr_cp`——即本阶段改动未导致任何新红。

**未验收（不静默）**：`examples/air-starling-demo` **尚未在 Windows 目标上跑过**（外部依赖面最广的 Stage3D 工程，127 源文件 + 完整 Starling）；**背面剔除/绕序**仍是纸面决定（`FrontCounterClockwise=FALSE` + 正高度 viewport、不 Y 翻转），无剔除 A/B 实测；**DXGI 调试层**本轮未开（仅在一次性探针上开）；mip-drop/透明混合/立方体贴图这些语义已移植且有文本钉子、但**未在 D3D12 上单独复测**。故本阶段宣称的是「**Windows 上 Stage3D 可从 2D 窗口里看见**（以 `shmup-stage3d` 为证）」，**不**宣称「已在 D3D12 上对齐全部 Stage3D 用态」。

**版本**：v0.4.104 → **v0.4.105**（`package.json`）。

**遗留表**：**改写 1 行**（「Stage3D 无 Windows 后端」⇒ **部分完成**：后端已落地且在 demo 上实机跑通，剩下 `air-starling-demo` 的 Windows 运行与剔除/绕序实测）；**新登记 0 行**（本阶段撞出的三个障碍都是**新代码自己的缺陷**：PSO 字段/掩码、采样器堆上限、`gr_cp` 所有权契约——不是 AIR 语义欠账，故不入遗留表；`gr_cp` 契约本身写进 `win32.md` §2.9 与单元钉子）。表内项数 94 → **94 项**（`部分完成` 11 → 12、`未开始` 82 → 81）。

---

### 阶段一百三十三：拖动窗口 resize 时整幅画面抖动 / 重影 —— 呈现路径被合成器重采样（macOS 实机修，Windows 同源修）（v0.4.105 → v0.4.106）✅ 已完成

**需求来源**（原文保留）：用户实测 ——「以这个 demo（`examples/air-native`）测试，`--run` 起来后拖动窗口做 resize，里面的画面**剧烈抖动**可以修复吗？Windows 上更是出现**部分重影**，放开后还抖。怀疑跟宽高不是整数或 2 的倍数有关」。

**症状与排除**：不是撕裂、不是内容重排、也不是「尺寸不整」（实测 macOS 上倍率恒为 `2.000000`）。是**整幅画面在帧与帧之间被整体放大/缩小一点点**（用户动作越快越明显）；Windows 上因 2 帧 flip 队列多留一拍，表现为重影且**放开鼠标后仍抖**。

**根因（实机实测，非推测）**：两个平台的**呈现路径都被留在了「拉伸铺满」的默认值上**，而 live resize 期间**我们提交的那一帧与窗口此刻的几何必然短暂不一致**（窗口在画完之后还在继续变大 ⇒ 无论绘制时刻取哪个尺寸都不可能同时满足）：

| 平台 | 默认值（从未被赋值） | 后果 |
|---|---|---|
| macOS | `CAMetalLayer.contentsGravity` **= `kCAGravityResize`**（`metal_glue.mm` 从未设置，注释里却写着「top-left gravity」） | 合成器把 drawable **拉伸到铺满 layer 的 bounds** ⇒ 整幅图被重采样 |
| Windows | `DXGI_SWAP_CHAIN_DESC1.Scaling` 零初始化 **= `DXGI_SCALING_STRETCH`** | DXGI 把 back buffer **拉伸到客户区** ⇒ 同一类重采样 |

**为何此前没被发现**：① 该缺陷**只在用户速度的快拖下可见** —— 慢速脚本拖拽（每步 ~2 px）的缩放比只有 ~0.3%，早先用 `screencapture` 慢拖取样「看起来一切正常」；② 它是**某个赋值的不存在**，在 diff 里没有痕迹；③ 两个宿主文件（`.mm` / `.cc`）**互不可编译**，改哪边都只能用源级钉子护另一边。

**修法（两处，各一行）**：

1. **`metal_glue.mm`**：`l.contentsGravity = kCAGravityTopLeft;` —— 正是 AIR `scaleMode=NO_SCALE` 的语义（内容尺寸固定、左上锚定）：尺寸还没跟上的那一帧**原尺寸**显示、新露出区留背景，等下一帧补上，**永不重采样**。
2. **`d3d_glue.cc`**：`sd.Scaling = DXGI_SCALING_NONE;` —— 既是 **flip 模型要求的取值**（`STRETCH` 是给 bitblt 交换链的），也正是 `kCAGravityTopLeft` 的对偶语义。

稳态（`drawableSize == bounds*contentsScale` / `back buffer == 客户区`）下两种取值**逐像素等价**，故是纯收益。

**验收（macOS 实机 A/B）**：

- **量尺要选对（本阶段踩过一次坑，值得记）**：最初拿 demo 里固定的红色「open window」方块（100x50 逻辑 ⇒ 2x 下应恰好 200x100 px）当尺子 —— **不行**。另有一个 100x100 的红方块会**动画漂移**到它旁边，二者在 4 连通下**合并成一个分量**，读出「尺寸变了」的假象（修后仍偶现 1~2 帧“异常”，一度被当成残留缺陷）；把该帧存档后**肉眼看**才确认是两个方块贴在一起。改用**完全孤立**的 `identity` 中灰方块（44x44 逻辑 ⇒ **88x88 px** @(1120,1020)）后度量才可信 —— **教训：跨帧像素度量的尺子必须是孤立的，否则会把“邻件合并”读成“画面缩放”**。
- **harness**：`temp/resizeprobe/fast.py`（`CGWindowListCreateImage` **进程内**取帧 ~68 次/s，与 Quartz 合成的**用户速度**快拖并发；不用 `screencapture`，因为它 ~7 次/s 会漏掉瞬时帧）。
- **结果**（每次拖 500 px / 0.3 s，次数已累计）：

| `contentsGravity` | 被重采样（尺寸不对）的帧 | 实测样本 |
|---|---|---|
| `kCAGravityResize`（修前默认） | **15 / 93**（4 次：2/24、5/23、4/23、4/23） | 83x84@(1063,981)、86x86@(1111,1014)、85x85@(1084,994)… |
| `kCAGravityTopLeft`（修后） | **0 / 151**（6 次，且无任何异常帧） | —— |

- **样本自证是「整幅重采样」而非局部扰动**：83x84@(1063,981) 的 83/88 = 0.943、1063/1120 = 0.949、981/1020 = 0.962 —— **两维与原点偏移同比缩小 ~0.94**，即关于原点的均匀缩放；比例逐帧在 0.94~0.98 之间变化（正是拖动中窗口尺寸在变）。
- **反向对照**：把 `metal_glue.mm` 那一行改回 `kCAGravityResize` 重编，同一脚本重现 15/93；改回后 sha256 逐字节核对复原、复跑 6 次全 0。
- **不破「未绘制残留」**：修后拖拽中的瞬时帧在右下角（新露出区）**只有 2 种颜色**、与稳态帧同区域一致（无接缝、无垃圾像素）—— 即露出的是舞台背景，不是未初始化内容。
- **全量回归（`node test.ts`，本机 macOS）**：**269 用例 / 269 绿 / 0 红 / 0 skip**（含本阶段新增组）。
- **单元钉子 9 条**：新组 `unit: platform/PresentScale`（`test/unit/platform.ts`）—— 两平台各钉「不是被赋成 scale-to-fit 的值」「恰好赋一次」「赋在正确的对象/描述符上」「赋在使用它的调用之前」，外加 D3D 侧「`<dxgi1_4.h>` 已包含」「仍以客户区尺寸创建」。**反例验证**：把两处改动同时回退成修前形状后**当场 5 条变红**，复原后 9 条全绿（复原以 sha256 逐字节核对）。
- **本阶段还清掉了一处临时仪器**：早先为定位问题在 `window_glue.cc` / `metal_glue.mm` 里加的 `ASC_RESIZE_TRACE` 已全部移除；`sk_mtl_init` 的启动日志保留并**增列 `gravity=`**（让这条不变量可被启动一行日志直接观测：修后为 `gravity=topleft`）。

**未验收（不静默）**：**Windows 侧未实机复测** —— 本机无 Windows 环境（`d3d_glue.cc` 是宿主专属源文件，在 macOS 上连编译都不可），故只做了①单字段赋值（枚举由已包含的 `<dxgi1_4.h>` 提供）＋②按同一缺陷类的 Metal 实机 A/B 与 flip 模型文档要求修正＋③源级钉子。**真拖窗口看有无重影**已入 `docs/zh-cn/win32.md` §5 清单**第 16 行**，本阶段**不宣称 Windows 侧已验收**。残留的 1 px 未覆盖条（若 SDL 的像素尺寸与客户区差一个像素）**未观测**，同样待补。

**文档**：`docs/zh-cn/skia.md` 新增 **§6.7**（macOS 侧根因 + **量尺必须孤立**的口径 + 15/93 vs 0/151 表 + 「慢拖看不出」的教训）；`docs/zh-cn/win32.md` 新增 **§2.10**（D3D 侧同源缺陷与修法，并明标未实机复测）＋ §5 清单**第 16 行**。

**版本**：v0.4.105 → **v0.4.106**（`package.json`）。

**本阶段运行过的副作用（如实报明）**：本机是 macOS，而 `--air-app` 每次构建都会**就地重写**示例配方（`examples/air-native/air-native.build.json`）并留下生成的 `air-native.c`。仓库档案里这两份投的是 **Windows 配方**（同目录的 `air-native-offscreen.*` 未受影响，仍为 Sep 20），而本阶段的 macOS 构建把它们重生成为 **macOS 配方**（`metal_glue.mm` / `macos-arm64` / frameworks）。**未做复原** —— 无法在 macOS 上重生 Windows 配方，也不应手写一份“看着像”的（architecture / defines 存在推断成分，写错会在档案里冒充权威）。若需保留 Windows 配方，请在 Windows 机器上重跑一次 `--air-app`（或从版本控制恢复）。

**遗留表**：**移出 0 行 / 新登记 0 行**（两处都是「把已定义行为修对」，不新增缺口；表内项数仍 **94 项**），但 §5 首跑清单**新增 1 行**（第 16 行：Windows 侧肉眼复验）。

---

### 阶段一百三十四：语言快修包（9 项）+ 语言核心保真包（3 项）（v0.4.106 → v0.4.107）✅ 已完成

**需求来源**（原文保留）：用户要求从 `### 遗留待开发`（94 项）里挑一批「成本低/中」的**语言层**缺口集中收口，落地后维护台账、同步文档与版本、跑全量回归。

**本阶段判据**：每条都以 `adl 51.4.1` **实测**为底线（AGENTS.md §1.5/§2.5）——凡实测「我们错、AIR 对」的按**遗留缺陷**修；凡 AIR 行为与既有记载不符的，**改写记载**（本阶段撞出一条**语义反转**，见 ④）。**不夹带**两族高风险项（数值极值、Class 值族），理由见节末。

| # | 项 | `adl 51.4.1` 实测（证据） | 修法 | 回归门槛 |
|---|---|---|---|---|
| ① | `catch (e:*)` / 无类型 catch 被拒 | `mxmlc` 接受 `catch (e:*)`；**且子句按声明类型过滤**：`catch(e:Error)` **不**捕获 `throw "oops"`，`catch(e:*)`/`catch(e:String)` 才捕获（`temp/qfix/gcadl/ctcMain.as` → `result8.txt`） | catch 绑定改**双槽**（对象槽 + boxed 槽）：`as_exception_v`/`as_exception_boxed`、`as_throw_val`；`emitTry` 按声明类型分派生 `catchIsTest`/`catchVarType`。非匹配子句**不下沉** | `catchsem` **0/8**、`catchany` **0/4** diff；新增 `examples/catch-value.as`；并把 `examples/stage7.as` 的 `catch(e:Error)` + `throw "oops"` 旧写法**改正**（它此前靠我们的错语义通过） |
| ② | `new XMLList()` 不可构造（`unknown class 'XMLList'`） | `adl`：`new XMLList()` 得空列表（`len=0`、`Boolean(empty)=true`）；取值/`length()`/真值判定与 `adl` 逐字（`temp/qfix/xmllist.body.as`） | `emitNew` 增 `XMLList` 分支 + runtime `as_xml_list_ctor(as_value)`（`n0=0/n1=1/n2=2/n3=1 "hi"/n4=1 "5"/n5=0` 逐条对 `adl`） | 新增 `examples/xmllist-ctor.as` |
| ③ | XMLList `@attr` 在**标量上下文**只给首个非空值（AIR 给拼接串） | `xml.item.@at`（两条 `item`）= **"12"**（`temp/qfix/xmlattr.body.as`） | `as_xml_list_attr` 改为**拼接全部条目值**（与 `as_xml_attr` 的「空值当 `""`」口径一并复核） | 探针 **0/9** diff；`examples/stage91.as` 增补多元素列表断言；`test/unit/emit.ts` 增 `unit: e4x/ListAttrScalar` |
| ④ | 接口**访问器作方法调用**（`iface.prop()`）——**原记载的语义是错的** | AIR 读到 getter 值后**当函数调用**：非函数一律 `TypeError #1006`（`temp/qfix/gcadl/getcallMain.as`，AOT 侧 `getcallAot.as`，双端 **0 diff**）。故阶段一百一十 给接口接收者发的「属性读」**与 AIR 不符**（类接收者报 codegen 错同样不符） | 新增 `emitAccessorInvoke(readCode, readType, args)`：**先读属性、再调用该值**（`as_req_fn` 语义 ⇒ 非函数 `#1006`）。`examples/stage89.as:48` 的「interface getter implemented」**由正例改为负例** | 双端 0 diff；新增 `examples/getter-call.as` |
| ⑤ | 顶层 `new <any/object 变量>()` 报 `unknown class` | 类内/函数内早可（阶段一百一十一），顶层漏了同一条动态分派 | `lookupObjectVar` 补 **module-scope 回退** | 新增 `examples/top-dynnew.as`；`test/unit/diagnostics.ts` 增负例 `g9b` |
| ⑥ | 用户 `function main()` 与发射的 `int main(void)` 冲突 | AIR 里 `main` 是普通函数名 | 新增 `freeCName(name)`（`main` → `asc_user_main`），5~6 处统一应用 | 新增 `examples/user-main.as` |
| ⑦ | 类体**无类型字段**按 `int`（AIR 是 `*`） | AGENTS.md §2.4 的「`var x;` 按 `int`」只适用于**函数作用域**；AIR 的**类字段**无类型即 `*` | 类字段收集改 `m.type === null ? {kind:'any'}`（**不影响**函数作用域约定） | `examples/field-declarators.as` 增补动态可赋值断言 |
| ⑧ | NativeWindow 居中取 **SDL display 0**（双屏上可能不是主屏，窗口被挪到屏外） | adl 忠实复刻的是「居中 **frame**」（实测 700,469），只是显示器序号取错 | `vendor/window_glue.cc`：`sk_display_bounds(0,…)` → `SDL_GetWindowDisplayIndex(c->win)`（`<0` 回退 0） | **已编译校验** `clang++ -fsyntax-only … window_glue.cc` rc=0；单显示器数值**逐字不变**。**运行时双屏验收本机不做**（见「未验收」） |
| ⑨ | 类实例**隐式字符串转换**不走自己的 `toString()` | **实测已被更晚阶段修好**（非本轮改动）：`"x"+new Plain()`=`PLAIN-TOSTR`、`new Bare()`=`[object Bare]`、`new Error("boom")`=`Error: boom`、`e.name`=`Error`、`String(e)`=`Error: boom` 全与 `adl` 一致 ⇒ 本行属**陈旧记载** | 无（仅从表内移出，归入本节的「已核对」） | 双端逐字一致 |
| ⑩ | 对象/类实例 **ToPrimitive**（number-hint 的 `valueOf`-first）未实现（`Number({})` 给 0，应 NaN） | `Number({})`/`Number(undefined)`/`Number(fn)`/`Number(new Plain())` 全 **NaN**；`Number(WithNum)`=42；**`Number(WithValueOf)`=7（`valueOf` 优先于 `toString` 的 99）**；`int({})`=0、`uint({})`=0；`({})=="[object Object]"`=true、`({})==0`=false、`new WithNum()==42`=true（`temp/qfix/gcadl/numMain.as` → `result5.txt`） | `as_obj_to_number(void*)`：先查 class **method table** 的 `valueOf`（命中且回原始值 ⇒ `as_v_to_number`），否则走 vtable 尾部 `toString` 槽 / `as_obj_default_str`；`as_v_to_number` 的 tag4 → 它、tag5/7 → NaN；`as_v_to_int`/`as_v_to_uint` 的 tag4 → `ToInt32(ToNumber)`；`as_v_loose_eq` 增 object-vs-String（string-hint）/object-vs-Number·Bool（number-hint）。**不加 vtable 槽**：`valueOf` 走 method table（未覆写时自然落到 `toString`） | 新增 `examples/toprimitive.as`；`test/unit/emit.ts` 增 `unit: emit/ObjectToPrimitive`（11 检查） |
| ⑪ | 越界 / 已删键的 `Array`、对象缺失属性读回 `null`（AIR 回 `undefined`） | `e[3]`（length=2）/`m["7"]`/静态 `Array d[5]`/`delete de[1]`/空表 `pop()`·`shift()`/对象缺失属性 `o.bar` **全部 `undefined`**（`=== undefined` true、`== null` true）、`"x"+e[3]`=`"xundefined"`、`indexOf` 缺失 = −1（`arrMain.as`/`omMain.as` → `result6.txt`/`result7.txt`）。**注意**：对象缺失属性**实测也与 adl 不同**，原行「两端一致」**不准** | `as_array_get`(OOB)/`as_array_pop`/`as_array_shift`(空表)/`as_object_get`(缺失)/`as_array_prop_get`(NULL) 全部改 `as_v_undefined()` | 新增 `examples/undefined-missing.as`；`test/unit/emit.ts` 增 `unit: runtime/MissingIsUndefined`（5 检查） |
| ⑫ | `parseInt`/`parseFloat` **未按 ES3**（radix 被忽略、`NaN` 不可表示、缺 `0x` 识别） | **82 行双端矩阵 0 diff**（`pMain/p2/p3/p4Main.as` → `result9-12.txt`）：radix 生效（`"ff",16`→255、`"11",2`→3、`"17",8`→15、`"z",36`→35）；radix 0 自动识别 `0x`、**显式 radix 16 也剥离前缀**（`"0xB",16`→11）而其它 radix 不剥离（`"0x10",10`→0）；**前导零是十进制**（`"08"`→8、`"010"`→10，无八进制）；尾部垃圾忽略（`"12abc"`→12）；坏 radix（<2/>36）或无数位 → **NaN**；`parseInt` 返回 **Number**（`typeof`="number"）。`parseFloat`：最长十进制前缀、尾垃圾忽略（`"5e3junk"`→5000）；`"Infinity"` 大小写敏感；`"."`→NaN、`"1."`→1；**AVM2 特有**：指数标记无位数时**回退丢弃**（`"5e"`/`"5e+"`→5），唯 `"5e-"`→**NaN** | runtime 新增 `as_parse_int(const char*, double radixd)` 与 `as_parse_float(const char*)`（**不复用** `as_str_to_number` —— `Number()` 拒尾垃圾（`"12abc"`→NaN）而 `parseFloat` 忽略，两者语义不同）；`emitGlobalCall` 的两处改调它们，返回类型 **number** | 新增 `examples/parse-int.as`；`test/unit/numeric.ts` 增 `unit: numeric/ParseIntFloat`（12 检查） |
| ⑬ | `DisplayObject.name = null` 应抛 `TypeError #2007`（我方静默写入） | **10 行双端逐字一致**（`nameMain.as` → `result16.txt`）：静态槽、`this.name`、**无类型形**（子类方法内裸 `name`）、`super.name`、动态 `*` 与 `Object` 接收者**六种形态全抛** `#2007`「Error #2007: Parameter name must be non-null.」且**字段保留原值**；**`Error.name = null` 不抛**（普通 String 槽）；`s.name = 5` 被 `mxmlc` 以「隐式强制转换」**编译期拒绝** | 新增 `as_req_name(char*)` 守卫（在 `emitSealedPropErrors` 定义、在 runtime 前向声明）；静态写入点在三处（`obj.name=`、无类型字段、`super.name=`）包一层；**动态接收者**经 props 表新 tag **13**（键在**声明类**而非字段名，故 `Error.name` 仍是 tag 3 不抛）；`as_dyn_get` 把 13 当 string 读 | 新增 `examples/name-null.as`（`adl` 10 行逐字）；`test/unit/emit.ts` 增 `unit: emit/DisplayObjectNameNull`（8 检查，含「`Error.name` **不**被守卫」的反向钉） |

**未落地（不静默，如实报明）**：本阶段**主动不夹带**两族高风险项：

1. **AIR 的数值解析/格式化极值**（表内该行已改写为 48 行矩阵 / 10 行不同）：原建议「`%.15g`、必要时回退 `%.17g`」**与实测矛盾** —— `1.7976931348623157e308` 在 `adl` 上是 **`1.79769313486231e+308`**（15 位**截断**、不回环），且 `Number("1e100")` 存在**同值异文**（内联字面量走 mxmlc **编译期**转换、经变量/数组走 AVM2 **运行期** `stringToDouble`）。黑盒无法再收敛，须按 avmplus 的 `MathUtils::convertDoubleToString` + `stringToDouble` 逐字节移植并配全量矩阵钉子 —— 影响面是**所有 `trace(number)` 文本**，**独立立项**。
2. **接口 / `Vector.<T>` 的 Class 值 + `int`/`uint` 独立 box tag**：三者耦合（接口需 `_cls` + 名字进值位置的分流；`int`/`uint` 需新 box tag，而新 tag 必须同步补 `as_v_typeof`/`as_v_truthy`/`as_v_eq`/`as_v_str_val`/`gc_mark_value`/写屏障六处），且需**新一版 AIR oracle**（`getQualifiedClassName(IDataInput)`、`[class Vector.<int>]`），**独立立项**。

**本阶段顺带更正两条「陈旧钉子」（如实报明）**：① `test/unit/reflection.ts` 的「an unshadowed inherited field is still read/written directly」断言 `->name) = "k", gc_write_barrier` 字面 —— 被 ⑬ 的守卫包成 `as_req_name("k")`，**断言更新为新形状（意图不变：仍是直接字段写、不经 getter）**；② `test/unit/emit.ts` 的「parseInt/parseFloat keep their own PREFIX parsers」断言生成 C 里出现 `atoi`/`atof` —— 那是 ⑫ 之前的老形状（且 `atoi` 忽略 radix 正是错因），**改为断言 `as_parse_int(g_s, 0.0)`/`as_parse_float(g_s)`（意图不变：仍是前缀解析而非整串）**。两条都属**断言陈旧**，不是行为回归。

**验收**：`npm run test:unit` **106/106 绿**（含本阶段新增 4 组）；`node test.ts` 全量（examples + unit）；本阶段新增示例 **9 个**（`catch-value`/`xmllist-ctor`/`getter-call`/`top-dynnew`/`user-main`/`toprimitive`/`undefined-missing`/`parse-int`/`name-null`）。

**未验收（不静默）**：⑧ NativeWindow 居中只做了**编译校验 + 单显示器数值不变**的推理；**双屏实机的窗口落点未复跑**（该改动只在双屏可观测）。

**文档**：`README-CN.md` 的「支持子集 / 类型映射」按 ⑩⑪⑫⑬ 同步；本表按上表逐项落账。

**版本**：v0.4.106 → **v0.4.107**（`package.json`）。

**遗留表**：**移出 13 行 / 改写 1 行 / 新登记 0 行**（表内项数 **94 → 81 项** = `部分完成` 11 + `已完成` 1 + `未开始` 68 + `暂缓` 1）。

---

### 遗留待开发

> **状态（2026-10-10 复核，v0.4.107）**：下表 **81 项** —— `部分完成` **11 项**、`已完成` **1 项**、`未开始` **68 项**、`调研完成 · 实现暂缓` **1 项**（仅剩 preview2 `wasi:http`）；每项都附可复现证据（实测输出 / 代码位置）；项数**以表内实际行数**为准（脚本按本表内 `^|` 行重数，表头/分隔行除外）。**最新一轮（2026-10-10，阶段一百三十四：语言快修包（9 项）+ 语言核心保真包（3 项）落地）**：**移出 13 行 / 改写 1 行 / 新登记 0 行 / 表内项数 94 → 81 项** ——（a）**移出 13 行**（全部原为 `未开始`）：① 「`catch (e:*)` 被拒」（顺带把 catch 的值保真与**子句按类型过滤**一并收口 —— AIR 实测 `catch(e:Error)` **不**捕获 `throw "oops"`，`catch(e:*)`/`catch(e:String)` 才捕获，故 `examples/stage7.as` 的旧写法**本身是错的**，已改写）；② 「`new XMLList()` 不可构造」；③ 「XMLList `@attr` 标量上下文」（多元素列表拼接）；④ 「接口访问器作方法调用」——**语义反转为 `#1006`**：AIR 读到 getter 值后**当函数调用**，非函数一律 `TypeError #1006`，故旧阶段一百一十 给接口接收者发的「属性读」是**错的**（`examples/stage89.as:48` 已改为负例）；⑤ 「顶层 `new <any 变量>()`」；⑥ 「用户 `function main()` 撞入口」；⑦ 「类体无类型字段按 `int`」（类字段改投 `*`，函数作用域约定不变）；⑧ 「NativeWindow 居中用 SDL display 0」；⑨ 「类实例隐式字符串转换」——**实测已被更晚阶段修好**（`"x"+new Plain()`=`PLAIN-TOSTR`、`new Bare()`=`[object Bare]`、`new Error("boom")`=`Error: boom`、`e.name`=`Error` 均与 adl 逐字一致，本行属**陈旧记载**）；⑩ 「对象 ToPrimitive」（number-hint `valueOf`-first，`Number(WithValueOf)`=7 胜过 toString）；⑪ 「越界/已删键读回 `null`」（改回 `undefined`；顺带复核对象缺失属性，**实测原行「两端一致」不准**，现一并统一）；⑫ 「`parseInt`/`parseFloat` 未按 ES3」（radix/`0x`/前导零十进制/尾垃圾/NaN 全按 82 行双端矩阵，**0 diff**）；⑬ 「`DisplayObject.name = null` 应抛 `#2007`」（静态槽、`this.`/`super.`/无类型形、`*`/`Object` 接收者五种形态，**10/10 对 adl 逐字**）。（b）**改写 1 行**：「AIR 的数值解析/格式化极值」把「32 行里只剩 1 行不同」的**窄口径**扩证为 **48 行矩阵 / 10 行不同**（denormal 打印、`1.79769313486231e+308` 的 15 位**截断**、`Number("9.999999999999999")`→10、`Number("1.7976931348623157e308")`→Infinity、`Number("1e100")` 的**同值异文**），并明确**本轮不动**（须按 avmplus 逐字节移植，独立立项）。（c）**新登记 0 行** —— 本轮撞出的全是「把已定义行为修对」（含一处**语义反转**），不是 AIR 语义欠账。**未落地（如实报明）**：本行与「接口/`Vector.<T>` Class 值 + `int`/`uint` 独立 box tag」两族**本轮不动**（前者高风险，后者耦合 `as_class` 结构 + 注册表 + box tag 空间，需新一版 AIR oracle），理由见阶段一百三十四 节内。**上一轮（2026-10-10，阶段一百三十二：Windows Stage3D 后端（D3D12）落地 + demo 实机跑通）**：**改写 1 行 / 新登记 0 行 / 表内项数仍 94 项** ——（a）「**Stage3D 无 Windows 后端**」那行由 `未开始` 改为 **`部分完成`**：`vendor/stage3d_d3d.cc`（~2,290 行）已落地，`examples/shmup-stage3d` 在 Windows 上**开窗并跑到 281 帧 / 5 s**、零 PSO/合成错误，且 `ASC_GPU_DUMP` 导出的 presented back buffer 里有 demo 的 Stage3D 精灵；**剩下的**是 `examples/air-starling-demo` 在 Windows 目标上的完整运行（外部依赖面最广的那个工程）与背面剔除/绕序的 A/B 实测；（b）**新登记 0 行** —— 本阶段撞出的三个障碍（PSO 的写掩码/语义名/字段顺序、采样器堆 2048 上限、Skia D3D 的 `gr_cp` 所有权契约）都是**新代码自己的缺陷**，不是 AIR 语义欠账（其中 `gr_cp` 契约本身已写进 `win32.md` §2.9 并有单元钉子）。**上一轮（2026-10-10，阶段一百三十一：AGAL → HLSL 翻译器落地 + Windows 全量回归口径分类）**：**移出 0 行 / 新登记 2 行 / 扩写 1 行 / 表内项数 92 → 94 项** ——（a）本阶段是「Stage3D 无 Windows 后端」的**前置**（翻译器），该行保持**未开始**（还差 `vendor/stage3d_d3d.cc`），故不移出任何行；（b）**新登记 2 行**：① AGAL 翻译器在 **MSL/GLSL** 两档上的既有缺陷（片元 `od` 未声明且**从未接线**、`iid` 译成未声明的 `r0`、空 stage 结构）—— 三档化时**只有新写的 HLSL 档是对的**，两个旧档的错**早就在**，只是此前没有第三个目标可对照；② **CRLF 检出下**「多行 XML 字面量（≥2 个子元素）+ 非 ASCII 字符」触发**假 Lex error**（最小复现 6 行；同内容 LF 或压成一行即正常），它解释了 `examples/e4x-name.as` 在本机必红而 CI（LF 检出）绿；（c）**扩写 1 行**：「顶层自由 `function` 名撞 libc/libm 符号」→ 补上**Windows 侧的宿主宏撞名**证据（`function near(...)` ⇒ 生成 C 的 `near` 撞 `winnt.h` 的 `#define near`，**6 个示例**在本机编不过）；（d）Windows 全量回归的**必然红项**已用**同工具链的基线 A/B**证明与本次改动无关：把 `src/runtime.ts` 换回改动前版本跑同一套件，单元红 **10 → 9**，**唯一差异是新组 `stage3d/agal-hlsl` 由红转绿**（既证明无新增红，也证明该组能变红）。**上一轮（2026-10-10，文档轮：AGAL → HLSL 立项 + Windows 实测口径收口）**：**移出 0 行 / 新登记 0 行 / 表内项数仍 92 项** —— 本轮的 TODO 维护只做三件事：（a）把「Stage3D 无 Windows 后端」的**前置**立项为 **阶段一百三十一（AGAL → HLSL 翻译器）**（纯立项、未写一行实现，故**不改任何行的状态**）；（b）把阶段一百二十六 那段「**未验证**」收口为「2026-10-10 已实机编译+链接+运行」（开发机已换为 Windows，只剩肉眼级复验）；（c）给「测试门禁不稳定」行补注——本机 Windows 上 `node test.ts` 的**必然红项**已逐条分类为**环境红**（5 条 CRLF 假失败 + 2 条 macOS 硬编码断言 + 2 条 linkset 缺 `zlib.h` + examples 层整体缺 `-lz`/`cc`），与那 3 个 macOS 侧偶发**不同源**、不得混为一谈。**上一轮变动（阶段一百二十九，显示器刷新率查询 + `Stage.vsyncEnabled`，并修掉 `--air-app` 闭包 `this` 捕获缺陷）**：**移出 0 行 / 新登记 0 行** —— 本阶段是**新增能力**（`docs/zh-cn/enhancements.md` E16：`VsyncStateChangeAvailabilityEvent.refreshRate`，AIR 无任何刷新率 API）与**修对一个既有缺陷**（`--air-app` 引导代码的顶层 `var stage` 让闭包捕获 walk 跳过 getter 检查、不捕获 `this` ⇒ `error: use of undeclared identifier 'this'`；已修 + `unit: emit/ClosureThisCapture` 6 条钉子，且回退修复后能变红），两者都不属缺口；`Stage.vsyncEnabled` 反而**收窄**了 `as3-semantics.md` §2「帧率口径」行那条长期「维持现状」的口径差（拍频取舍现在交回 AIR 自带的退出阀）。表内项数仍 **92 项**。**上一轮（阶段一百二十八，多端渲染性能与分辨率收口：Stage3D 状态缓存 / 2D mip 链 / 烘焙分辨率与 `BitmapData.draw` 口径）**：**移出 7 行** —— ① `Starling demo 逐轮 RSS 上涨`（三组新 harness 实测：skybox 60 s 平坦、Sprite 3D 12 轮无增长、benchmark 的 +34 MB/s 是 Starling 设计内的活集增长且 500 ms release pass 已归还 `vmmap` 的 FRAG 33% → 0%，`as_big`=0 ⇒ 无逐帧临时分配泄漏）；② `cacheAsBitmap`/自动烘焙按 **dpr**（而非目标画布总缩放）烘焙（已落地 `as_bake_scale`，带 4×dpr 与 4M 像素上限；九宫格同源同修；`adl` oracle：缓存开/关在 k=1/2/3 与祖先缩放两态**逐像素相同**）；③ `BitmapData.draw`/`as_render_bounds` 的**边框 +1**（adl 实测 = `width*k + 1` 且边框**恒 1 位图像素** ⇒ 源矩形的 +1 是**位图像素**、不是局部单位）；④ `BitmapData.draw(source, matrix)` 对 **source 自身变换**的处理（adl 2×2 矩阵定案：`cont.scaleX=2` 独立 draw 得 41×21 = 忽略源变换，`scale=2` + `mat=3` 得 121×61 = **只吃矩阵、两者不相乘** ⇒ 按该行选项 ① 对齐 AIR）；⑤ `Texture`/`CubeTexture` 的 **mip 1+ 未上传**（2D 已按 adl 实测的「源位图左上 `lw×lh`、按源行距读」区域规则上传各级）；⑥ **无 mip 链 + `miplinear` ⇒ 丢弃整个 draw**（两端同条件落地，web 侧丢弃点必须在 `glUseProgram` 之前，否则 GL 采到不完整纹理读作黑）；⑦ 每 draw 重建 **`MTLDepthStencilState`**（Metal 侧改按键值 LRU 缓存 `s3d_select_dss`，实测 `dss=2` over 1680 draws，`make_pso=2`/`pso_miss=0`）。**新登记 4 行** —— web 端从**文档类构造器**请求 Stage3D 不可用 + wasm 上胶水层 JS 异常 AS3 捕不到；`catch (e:*)` 被拒（`mxmlc` 接受）；内建方法的**可选参数**不生效（`drawTriangles(ib)` 报缺参）；`TextField.textWidth` 的字形累进口径残差（adl 14.5 vs 我们 14.40234375）。**上一轮（阶段一百二十七，内建类注册表 & Class 值 + `in`/`delete`/下标）**：**移出 6 行** —— ① `IDataInput`/`IDataOutput` 未注册为内建接口（已按 AIR **完整成员表**注册进 `flash.utils`，`TLSSocket extends Socket implements IDataInput, IDataOutput` 通过）；② `delete vec[i]` 与 `"0" in vec` 在**静态 Vector** 上报 codegen 错（已落地：`in` 按下标范围、`delete` 恒 true 且 no-op——原行猜的「`#2005`」经复测是**误归因**，`#2005` 实为 `new Vector.<int>(非数字长度)`）；③ `in` 在数组上（静态被拒 / 动态恒 false；已落地：`length` + 区间内非空洞下标 + 命名属性）；④ `getDefinitionByName` 的错误号与消息不忠实（两处硬编码改为 AIR 的 **`#1065`** + `Variable <末段> is not defined.`，原行的「message 是 `"Error #1065"`」经双端复测更正为完整句）；⑤ 未知类作**类型标注**不报语义错、泄漏 clang 诊断（已落地：符号表感知的 `checkTypeAnnotation`，带 `行:列`）；⑥ `is`/`as` 右操作为 `Vector.<T>` 时动态左值失效（已落地；其括注的「裸 `Vector` 作类型名报错」经 `mxmlc` 复测**吻合 AIR**——`var vv:Vector = new Vector.<int>()` 被 `mxmlc` 以「隐式强制转换」拒绝——故该括注**不属缺口**，已在下方节内写明）。**新登记 2 行** —— `Vector.<T>` 作 Class 值/值表达式（值位置先是 parse error）；`Socket.readObject` **响亮**未支持。**收窄改写 3 行** —— `is`/`as` 右操作数为内建类/接口 Class 值（内建类已落地，只剩接口与 `Vector.<T>`）；内置类名作 Class 值（引用类型已落地，只剩**原始包装类**）；反射 API 的内建类名口径（①④ 实测**更正为已对齐 / 部分对齐**，只剩 `int`/`uint` 独立 box tag 与 `Dictionary` 虚拟 vtable）。**上一轮（阶段一百二十六，Windows 原生后端）**：**移出 0 行 / 新登记 3 行**（Windows 侧未实机验证；Stage3D 无 Windows 后端；**测试门禁不稳定**——同一套件不同次运行报出 3 个不同的红、重跑全绿，根因未定，见本节末行）。**上一轮（阶段一百二十五）**：**移出 0 行 / 新登记 1 行**（`new XMLList()` 未注册为可构造内建类 —— `adl 51.4.1` 可构造、我们报 `unknown class 'XMLList'`（**响亮**失败）；`XML` 可构造而 `XMLList` 只能作类型标注，属不对称；见上节）。**上一轮（阶段一百二十四）**：**移出 1 行**（「编译范围 = 整个 `src/`（无可达性分析）」—— 已落地为**主类传递闭包**收面，同源 A/B：`Basic_SkyBox` 源文件 485→165、嵌资源 40→6、二进制 34,134,472→25,456,904 B、构建 37.03→15.94 s，且闭包产物是整包产物的**函数级子集**）；**新登记 0 行**。**上一轮（阶段一百二十三）**：**新登记 0 行 / 移出 0 行**（成员解析的最近声明规则属**把已定义行为修对**，不新增缺口；见上节）。**上一轮（ANEWebSocket 真源码实证，纯评估不升版本）**：**新登记 1 行**（**`flash.*` 包里的用户类对 `package`d 消费者不可见** —— 自写的 `flash.external.ExtensionContext` 顶不上内建，⇒ `ExtensionContext` 必须做成真内建；用真实厂商源码的隔离矩阵实测）。**更正 2 处口径**（① ANE 的 AS3 面 **74/61/678/115/368 → 70/59/605/106/363** —— 旧脚本用短名在整棵 `src/` 匹配，被工程自带的 `com.worlize.websocket.*` 污染；② 「ANE 的 AS3 类只能从 `DoABC` 拿」**不成立于全部** —— 工程 `src/` 已自带 **12** 个 ANE 相关类源码、其中 **2** 个就是被 import 的 ANE FQN）。**实证 1 条**（路线 ②′：ANEWebSocket 的 `.vcxproj` 链接仓库自带的 `libs/air/FlashRuntimeExtensions.lib`（内部记录 `Adobe AIR.dll` ×69）、无 `.def` ⇒ 换名 = **只换这一份导入库后重编**，零源码改动；且未经修改的 `WebSocketEvent.as` 在本编译器下**编译并运行正确**）。**上一轮（阶段一百二十二）**：**新登记 1 行**（**编译范围 = 整个 `src/`，无可达性分析** —— 实测 `embed 40 asset(s)` / 4,969,434 B 里含**别的 demo** 的资源，且它们**存活进产物**（`Basic_Stereo` 二进制里 `road.jpg`/`rockbase_normals.png`/`idle2.md5anim`/`grimnight_posX.png` 各自的 48 字节中段各 1 次）；不可达类里的坏 `[Embed]` 让我们编译期失败而 `adl` 无恙）。**上一轮（Windows 口径 ExtensionContext / ANE 宿主评估 v2，纯评估不升版本）**：**新登记 2 行**（**Windows ANE 宿主未实现**——实测 13/13 个 ANE DLL 的 FRE 符号**全部来自 `Adobe AIR.dll`**、全集 **34 个 = 25 在线参考已列 + 9 未列（但 SDK 头文件 52 个全有原型 ⇒ 无需逆向）**、加载协议为每 DLL 仅导出 `<Name>ExtInitializer`/`Finalizer`；**ANE 的 AS3 API 类无法纳入 AOT 闭包**——**74 个 FQN / 61 文件 / 3 个作基类**，定义在 `library.swf` 的 `DoABC`）。**更正 2 处口径**（① 上一版「真 ANE 桥接**不可行也无意义**」**作废**——它回答的是 macOS，而交付物是 **Windows**，届时 AIR **真的加载 `.dll`**、ANE 功能完整；② `talkmed-meeting-aot-gap-report-v2.md` §4.1 同步更正）。**复测确认 1 条**（v0.4.94 下**任何内建类**走 `getDefinitionByName` 仍抛 `#0 [No definition found]`，含 `String`/`Object`/`Sprite`/`StatusEvent`/`ExtensionContext`）。**上一轮（ExtensionContext / ANE 可行性评估 v1，macOS 口径）**：**新登记 2 行**（`getDefinitionByName` 的**错误号/消息不忠实**——未知名我们抛 `#0` + `"No definition found"`、AIR 抛 `#1065`；**未知类作类型标注**不报语义错、直接泄漏 `unknown type name` 到 clang 的**诊断缺陷**），**更正 1 行**（「内置类名不能作 Class 值」行原括注称「已支持 `getDefinitionByName("flash.display.BitmapData")`」，实测为**假**，已改正）。**上一轮（阶段一百二十）**：**移出 1 行**（`unboxAny` 的 `int`/`uint`/`bool` 分支用原始解箱而非 AS3 强转，动态值为字符串时给 0/false —— 已落地为「整族动态槽强转收口」，`unboxcoerce` 探针 **4/8 → 0/8**，并顺带修掉「`String`→数值」的 ES3 ToNumber 与数组字符串键的路由）；**新登记 4 行**（同批探针实测出的邻域缺口：`DisplayObject.name = null` 应抛 `#2007`、数组越界读应回 `undefined`、数组上的 `in`（静态被拒 / 动态恒 false）、`parseInt`/`parseFloat` 的 radix 与 `NaN`）。**上一轮（阶段一百一十九）**：**新登记 1 行**（同上）。**移出 6 行** —— ① 经动态槽给对象型参数赋错类型不抛 `#1034`（已落地：`unboxAny` 的对象解箱走 `as_req_inst`，`dyn` 探针 0/6 逐字一致）；② `(标量 as Object) == 标量` 恒 false（已落地：`Object` 静态类型的相等走 `as_v_loose_eq`；顺带修掉另一半 —— `Object` 槽里的 **Array** 原先按 tag 4 装箱，`==`/`+`/`length` 都看不见数组，现 `as_obj_to_value` 按 `as_dyn_kind` 回 tag 6，`verify` 探针 0/8）；③ 动态值 `x as <原始类型>` 给默认值而非 null（已落地：`as_v_as_*` 未命中回 null 箱，探针 C/C2 一致）；④ 装箱字符串参与算术/比较未走 ES3 ToNumber（已落地：`toNumberExpr` 的 `any` 分支改走 `as_v_to_number`，探针 D/E/F 一致）；⑤ 静态 `String` 与 `Number` 混算发射非法 C（已落地：现在是 `CodegenError`「operator '*' cannot be applied to a String operand」，`"5" < 6` 仍编译）；⑥ `null` 字面量传给 `Number`/`bool` 形参发射 `(double)(NULL)`（已落地：`v78` 探针 0/3）。**新登记 3 行**：AIR 数值解析/格式化的极值（`tonum2` 只剩 1/32 行差）；对象字面量/类实例的 **ToPrimitive**（`Number({})` 应为 NaN）；Function 值的 **#1063 qname**（接口接收者应报「方法定义类」，匿名闭包的 `<file>.as$N` 索引与顶层函数名不可复现）。**同轮顺带落地（不在本表、属新增包）**：Array 的 ToPrimitive/ToString（`[1,2]`→`"1,2"`、`Number([5])`→5、`==` 字符串化、`join(null)`→`"null"`）+ Function 值的 **#1063 参数个数检查**（原先一个 1 参闭包用 0 参调用会**段错误**）。上一轮（阶段一百一十八）：**新登记 2 行**（`extends <内建类型>` 文案已精确、特性仍缺；`IDataInput`/`IDataOutput` 未注册为内建接口）、**移出 0 行**。
> **本表只留尚未收尾项**：已完成项一经落地即从本表移出，结论并入对应阶段节（每节末尾的「遗留表」行）；各项的逐轮增删沿革亦在同处，本表不再重复。

| 遗留项 | 状态 | 说明 | 建议 |
|--------|------|------|------|
| **Windows ANE 宿主未实现** —— FRE 宿主运行时，**34 个符号**（SDK 头文件 52 个全有声明）+ 扩展加载协议（**不产出 `Adobe AIR.dll`**：源码可得则重编换导入名，否则自建加载器） | 未开始（2026-10-09 可行性评估 v2（**Windows 口径**）实测登记；**新问题域**） | 交付物是 **Windows 应用**（`application.xml`：`extendedDesktop` + `<architecture>32</architecture>`），Windows 上 AIR **真的加载 `.dll`**、ANE 功能完整 ⇒ 「兼容 `ExtensionContext`」= 我们的运行时须**扮演 AIR 宿主**。实测（**PE 导入表逐字节解析**，`temp/extctx-win/`）：**13/13 个 Windows ANE DLL 的 FRE 符号全部来自 `Adobe AIR.dll`**——但该名字出自 **AIR SDK 自家导入库**（`lib/win/FlashRuntimeExtensions.lib` 文件名里没有 `Adobe AIR`，内部记录的模块名却是 `Adobe AIR.dll` ×109），是**链接期产物** ⇒ 我们**不必**产出这个名字：**有源码的 ANE 重编换导入名（§3.4 路线 ②′，首选）**，第三方 ANE 走**自建加载器**（route ①）。项目需要的全集 = **34 个 FRE 符号**，其中 **6/10 个 ANE 只用在线参考已列的符号**（AliyunRTC/NDI/NELivePlayer/WebSocket/WinWebView/ZoomSDK）；在线参考未列的 9 个里 **7 个只集中在 `ANEWinCore`(8) 与 `ANECefWebView`(2)**，且这 9 个在 `FlashRuntimeExtensions.h` 里**全部有原型**。加载协议亦已确认：每个 DLL **只导出 2 个符号**（`<Name>ExtInitializer`/`ExtFinalizer`），与各自 `extension.xml` 的 `<initializer>` **逐字相符**（`ANEWinCoreExtInitializer`/`ANEWebSocketExtInitializer`/`ANEMDKExtInitializer`/`ANEWinRTCExtInitializer`…）。**前置**：Windows 运行时后端（Win32 + D3D/Skia）**尚不存在**（现只有 macOS/Cocoa/Metal + wasm） | 分四步、每步可独立验收：① **Windows 运行时后端**（非 ANE 专属，但阻塞一切）；② `ExtensionContext` 内建类 + `StatusEvent` + 扩展加载协议骨架；③ **宿主 FRE 运行时**（按 SDK 头文件补齐签名），用 **6 个「只用在线参考已列 FRE」的 ANE** 验收；④ 原生窗口句柄（CEF）→ 再评估 `ANEWinCore` 的**渲染管线**（`FRESetRenderSource`/`FREMediaBufferLock`/`FREMediaBufferUnlock`/`FREGetRenderMode` = AIR 的 A/V 合成器）。**红线**：未实装的 ANE **不得**按「返回 `null`」处理——官方 `null` 的条件是「无该 id」或「initializer 找不到/失败」，Windows 上两条**都不成立** ⇒ 必须**响亮报明**（AGENTS.md §1.5）。证据：`temp/extctx-win/{peimp,peexp,split,impname,frehdr}.py` + `{imports,exports,split,impname,frehdr}.txt` |
| **ANE 的 AS3 API 类无法纳入 AOT 闭包**（定义在 `library.swf` 的 `DoABC`） | 未开始（2026-10-09 同轮评估登记；**与平台无关**，是 AOT 路线的固有前提） | AIR 是**运行期**加载 ANE 的 `library.swf` 并执行其 ABC；AOT 要**静态链接**这些类，必须先拿到定义。实测面：静态 `import com.vsdevelop.air.extension.*` 去重 **70 个 FQN**、**59 个源文件**、**605 处**成员访问、**106 个**成员名（`getInstance` 独占 **363** 处）；**3 个类作基类**（`TestVideoView`/`VideoPlayer extends ANEVideo`、`VideoRootView extends ANEVideoRootView`）。**（口径已修正）** 旧记 **74/61/678/115/368** 是脚本 bug：`ane_surface.py` 用短名在**整棵 `src/`** 匹配，而工程自带纯 AS3 的 `com.worlize.websocket.{WebSocket,WebSocketEvent}`（10 文件 / 1506 行）短名与 ANE 的 `com.vsdevelop.air.extension.websocket.*` **相撞**（`WebSocketEvent` 一项 67→21）；新脚本 `temp/extctx-win/ane_surface2.py` 改为**按文件绑定**显式 import 的 FQN。**且「只能从 `DoABC` 拿」不成立于全部**：工程 `src/` 已自带 **12** 个 ANE 相关类源码（`com/vsdevelop/air/extension/{zip,lame,crypto,qcloud}/…` + `ManageExtension.as`），其中 **2** 个正是被 import 的 ANE FQN（`zip.ANEZipEvent`、`lame.data.lameInfo`）⇒ 这批**本就是普通工程源码**、早已在闭包里。**真正只能靠 `DoABC` 的是 70 个 FQN**。**已用真厂商源码（ANEWebSocket 仓库）实证**：`WebSocketEvent.as` **未经修改即编译并运行正确**（`open / hi`、`open`、`hi`），整个包装包唯一挡路的是内建 `ExtensionContext`（`25:5`）+ `StatusEvent` ⇒ 「拿到源码就解」不靠推测ANE 自带的 `catalog.xml` **只给类名 + 依赖名，不含成员签名**（连 `ANEWinCore.getInstance().macAddress()` 的返回类型都拿不到）。`DoABC` 属 [`docs/zh-cn/swc.md`](docs/zh-cn/swc.md) §3.3 明列范围外 | 四条路：① 写 AVM2 字节码前端（范围外、成本高）；② **离线反编译**——第三方 SWF 反编译器把 `library.swf` → **真 `.as`** 再纳入闭包（**推荐**：产出是源码而非桩，把 ABC 前端移出关键路径）；③ 手抄 74 类 API（不现实，≥115 成员起）；④ opt-in + **响亮** stub（stub 也要成员**存在且类型正确**，成本近 ②；静默返 `null` 会污染 `Log.as:34` 这类无判空调用点 ⇒ 触 §2.4 红线）。验收：每个 ANE「真源码能被我们编译并链接」 |
| **`flash.*` 包里的用户类对 `package`d 消费者不可见** —— 自写的 `flash.external.ExtensionContext` 顶不上内建 ⇒ **`ExtensionContext` 必须做成真内建**，不能靠往工程里放一份同名 `.as` | 未开始（2026-10-09 ANEWebSocket 真源码实证时发现） | 用真实厂商源码隔离实测：`ANEWebSocket.as`（`package com.vsdevelop…`）import `flash.external.ExtensionContext`，**即使随构建提供同 FQN 的用户类**仍报 `25:5 undefined variable 'ExtensionContext'`。矩阵：**顶层**文件 import 自写 `flash.external.ExtensionContext` ⇒ **可行**；**`package`d** 类 import 同一 FQN ⇒ **失败**；同一 `package`d 类改非 `flash.*` FQN（`mypkg.ExtensionContext`）⇒ **可行**（墙移到下一符号）；`package`d 类 import 自写 `flash.fake.Thing` / `flash.display.MySprite` ⇒ **均失败**（`undefined variable` / `unknown class`）。⇒ 一条**包名相关**的可见性规则（非「类未注册」） | 先定口径：是「`flash.*`/`fl.*` 视为保留命名空间，用户定义一律不参与 `package`d 解析」（**则缺陷在于静默**：应响亮报「不能在 `flash.*` 定义类」/「`ExtensionContext` 是内建保留名」），还是可见性 bug（则应修解析）。**先补实测** `fl.*`、嵌套包、顶层与打包两形态的差异再动。证据：`temp/ane-src-probe/`（M1/M2/M3 + N1 + Q1/Q2 三组矩阵） |
| `extends <内建类型>`（含 **`extends Array`**）不支持 —— 闭包内 **2 个文件**用它（`src/com/hurlant/util/der/Sequence.as`、`src/com/fiCharts/utils/graphic/StyleManager.as`），AIR 合法 | 未开始（2026-10-08 阶段一百一十八 重评估闭包时实测；**本轮只把文案改精确**，特性本身未做） | `resolveType('Array')` 给 `{kind:'array'}`、**无 `className`** ⇒ 旧码盲取 `.className` 报一字面的 `unknown superclass 'undefined' of 'Sequence'`（离原因很远）。现按 kind 分派：接口 ⇒ `cannot extend interface 'I'`；其余非类 ⇒ `unsupported superclass 'Array' of 'E': subclassing built-in types is not implemented`（带行列号）。**AIR 接受 `extends Array`**（mxmlc 51.4.1 实测），故这是**遗留缺陷**而非增强：子类数组需真实运行期支持（元素存储 / `length` / 全部 Array 方法在子类上的行为、`Vector` 与 `Array` 的元数据、`is Array` 沿链判定） | 立项前先量清面上：用 `adl` 实测「子类数组」的全部可观测差异（`a.length`、索引、`push` 等方法返回的是子类还是 `Array`、`getQualifiedClassName`、`is Array`/`is E`），再决定是「真做子类存储」还是「仅报精确错误 + 建议改写」。**先实测再动**（不得凭直觉定语义） |
| AGAL `nrm` 的**归一化分量数**未实测（我方两个后端都用 **4 分量**模长，AGAL/AIR 的口径可能是 **xyz**） | 未开始（2026-10-08 阶段一百一十六 **代码观察后登记为待实测**；**未实测项**，不是实测结论） | `src/runtime.ts` 的 AGAL→着色器翻译对 `nrm`（opcode 0x0e）只有两种形态，**且两后端共用同一份格式串**（无 `target == 0` 分支）：全掩码分支发 `normalize(<src>)`（`runtime.ts:9855`）、部分掩码分支逐分量发 `normalize(<src>).<c>`（`runtime.ts:9814`）——两种都用 **vec4** 求模。故 `nrm ft0.xyz, v0`（away3d 环体镜面反射的常态写法）我方按 `(x,y,z,w)` 的模长归一化后再取 `x/y/z`，**`w` 分量参与模长**。若 AGAL 的 `nrm` 只以 `xyz` 求模（AIR 口径），源向量 `w != 0` 时我方与 AIR 会有**尺度差**（`w=0` 的常见情形无差别，`Basic_SkyBox` 的环体镜面反射看不出差别）。**跨后端一致性无问题**（两后端文本相同） | 立项实测：写一个 `nrm` 的 AGAL 小程序，让**源寄存器 `w` 非 0 且 `xyz` 模长 ≠ 1**，同帧对照 `adl` 与两后端的渲染像素（逐 draw 探针法同阶段一百一十五）；据实测把两后端的 `nrm` 改成 `normalize(<src>.xyz)` 形态或维持现状，并补一条单元钉子。**成本低**（单点格式串 + 一次双端渲染对照），但**先实测再改**（当前无 adl 口径，不得凭直觉改语义） |
| web 目标无音频后端时，`Sound.loadCompressedDataFromByteArray` **直接抛 `#2068`**（AIR 是载入成功、到 `play()` 才体现「无声」） | 未开始（2026-10-08 阶段一百一十六 web 验收中实测；属既有已文档化限制的**口径差异**） | Starling web 版实测 `Error creating wing_flap: Could not load sound data: Error #2068: Invalid sound.`；native（同一份 AS3、miniaudio 后端）正常载入/播放。根因是**无后端时 `as_audio_decode` 是恒返 −1 的桩**（`src/runtime.ts:1745`），而 `Sound_loadCompressedDataFromByteArray` 把解码失败如实翻成 `#2068`（`src/emit.ts:8023`，抛错点 `:8049`）。`src/air-app.ts:686` 的构建期黄字警告说的是「web 构建尚无音频后端，`play()` 返 null、`areSoundsInaccessible()` 为 true」——**那条口径只在「声音已载入」的路径上成立**（零长 `Sound`/PCM 路径），走压缩数据装载的程序在 web 上是**载入即失败** | web 音频后端（`vendor/audio_glue.c` 的 wasm 版：miniaudio 的 web 后端或 `AudioWorklet`）落地后自然消失；在那之前二选一：维持「响亮失败」（当前，信息量大）或把桩改成「返回空缓冲」以贴合 `air-app.ts` 的警告口径。**先定口径再动**（`docs/zh-cn/audio.md` 与 `src/air-app.ts:686` 的措辞必须一致），**成本低** |
| `is`/`as` 的右操作数是**内建类 / 接口 / `Vector.<T>` 的 Class 值**时仍不支持（**用户类已落地 v0.4.72、内建类已落地阶段一百二十七**） | **部分完成**（2026-10-06 阶段九十九 用户类/SWC 类；**2026-10-09 阶段一百二十七 内建类**） | **已落地**：`var c:Class = SomeUserClass` 下的 `x is c` / `x as c` 走运行时类对象（`as_class_is_obj`/`as_class_is_val`/`as_class_as_val`/`as_req_class`），子类命中父类、`null is c`=false、`*` 左值按运行时类、**右操作数非类对象一律 `#1009`**；顺带修掉 `x is Object` 的静态折叠（除 `null`/`undefined` 外皆 true，`as_v_is_object` 按 tag）。**阶段一百二十七 追加落地（内建类）**：`emitClassRegistry` 现在给**每个有 `reflectFqn` 的类**（含全部内建类）发 `_cls` 常量（工厂指针 `NULL`），`emitVarLexical` 的 Class 值解析随之放行 ⇒ `var c:Class = Object; 5 is c` = **true**（AIR 对**内建 `Object` 类**自动装箱任何原始值，`as_class_is_val` 实现）、`BitmapData is Class` = true、`String(c1)` = `[class BitmapData]`（`as_class_str`）；`adl 51.4.1` 对照见 `temp/pkg1/oracle/adl-pkg1.txt`（C1/C4/C7/E2/E3/E8/E9）与 `examples/builtin-class.as`。**剩余**：① **内建接口**作 Class 值仍不可表达 —— `getQualifiedClassName(IDataInput)` 报 `Codegen error at 3:1: undefined variable 'IDataInput' at top level`（`adl` 给 `flash.utils::IDataInput`）；② **`Vector.<T>`** 作 Class 值不可表达（`adl` 给 `[class Vector.<int>]`；`Vector.<int>` 出现在**值位置**时我们先是 parse error —— 见新增行）；③ 右操作数为 **`any`/`Object` 静态类型**时不走动态路径（无法廉价区分「真是 Class 值」与「普通对象」，误判会把普通对象的首字当 `as_class` 读 vtable ⇒ 静默错误） | 给**接口**补 `_cls` 常量（接口判定的运行时路径——`as_iface_lookup`——已存在，缺的只是「接口名进值位置」）；`Vector.<T>` 的 Class 值见新增行。**成本中**。证据：`temp/cisprobe/cis-result.txt`（A–J 组）+ `temp/pkg1/oracle/adl-pkg1.txt` + `temp/pkg1d/Cl2.as` |
| **动态音频**（`SampleDataEvent`/`sampleData`）未实现 | 未开始（2026-10-06 阶段九十六 登记；属 D 步的一部分，本轮**主动不做**） | adl 51.4.1 实测：给 `Sound` 加 `SampleDataEvent.SAMPLE_DATA` 监听器后 `play()` 返回**真实 channel**（`temp/audioprobe/adlref/adl9.txt` 的 `F dyn play=true len=0`），AIR 随后按 `bufferTime` 派 `sampleData` 让应用自己喂 PCM。本子集当前**没有** `SampleDataEvent` 类 ⇒ 依赖它的程序（自制合成器/流式 PCM）无法移植。其余 `flash.media` 面（A/B/C + `extract`/`loadPCMFromByteArray`/`computeSpectrum`）已在 v0.4.69 落地 | 后续子阶段：加 `SampleDataEvent` 类（`data:ByteArray`、`position:Number`）+ 在混音回调里挂「应用喂数」通道（**线程红线**：喂数在 AS3 线程、混音在音频线程，需无锁环；口径见 `audio.md` §13.2）。除非有真实 demo 需要，优先级低于 `[Embed]` |
| **AGAL 翻译器在 MSL/GLSL 两档上的既有缺陷**（片元 `od` 未声明且**根本没接线**、`iid` 译成未声明的 `r0`、空 stage 结构） | 未开始（2026-10-10 阶段一百三十一 三档化时**撞出来**；**文本级已确证、实机未验**） | 同一段 AGAL 字节码对三目标各出一份着色器、逐份读文本才发现：① **`od`（片元深度输出）**——MSL 档发 `od.x = ft0.x;`，而 `od` 在 MSL 里**从未声明**、MSL 侧也**没有深度输出槽**（没有 `[[depth]]` 这种东西）⇒ Metal 的片元深度**整条未接线**且编不过；同批的 GLSL 档发 `gl_FragDepth.x = …`（内建、带 `GL_EXT_frag_depth`，**正确**）、HLSL 档发 `float od;` + 输出槽 `depth : SV_Depth`（**正确**）——三个目标里只有 MSL 是坏的。② **`iid`（实例 id）**——MSL **与** GLSL 档都发 `vt0 = r0;`，`r0` 是**未声明标识符**⇒ 实例化绘制在 Metal/WebGL 上编不过；只有 HLSL 档正确（`uint iid : SV_InstanceID` + `float4(iid, iid, iid, iid)`）。③ **空 stage 结构**——未读任何属性时 MSL 发 `struct VSIn {};`（仍带 `[[stage_in]]` 形参），MSL/GLSL 迄今容忍，fxc **拒绝**，故 HLSL 档特意按 `agal_is_used` 抑制、入口签名跟着变。**判据（§1.5）**：AIR 侧跑得对 ⇒ 遗留缺陷，不是增强。**本机是 Windows**，Metal/WebGL 两份文本**未实机编译过**（③ 只被 fxc 判过），故状态为「文本级确证、实机未验」 | 修在同一处（`agal_reg_name`/`agal_emit_body`）：`od` 按 MSL 既有约定补声明 + 输出槽（形态与 HLSL 的 `struct` 成员**不同**，先读 MSL 侧约定再动）、`iid` 的 `r0` 换成宿主提供的实例 id（Metal `[[instance_id]]`、GLSL `gl_InstanceID`）、MSL 的空结构同批收口。**成本低**（都是单点格式串），但**必须在能编译 Metal/GLSL 的机器上验收**，否则等于照文档猜。证据：`temp/hlslcheck/`（18 份 AGAL 程序 × 3 目标的逐份文本） |
| **CRLF 检出下「多行 XML 字面量 + 非 ASCII」触发假 Lex error**（词法层） | 未开始（2026-10-10 阶段一百三十一 Windows 全量回归时实测；**与行尾绑定**，故 CI 看不见） | 本机（全仓 CRLF）`examples/e4x-name.as` 必红：`Lex error at 30:14: unexpected character '的'`——位置指向**注释里的 CJK 字符**，可同一份文件**换 LF 行尾就能编过**（`node src/index.ts` 走到 codegen，只差 `cc`）。已收敛到**最小复现**（6 行、CRLF）：`var x:XML =` + **多行**字面量（**≥2 个子元素**，带不带 `xmlns`/属性无关）+ 一行含 CJK 的注释 ⇒ 报错；**把字面量压成一行、只留 1 个子元素、或改 LF 行尾**都**不报错**（矩阵 E1–E8 / M1–M7，`temp/lxprobe/`）。⇒ 字面量扫描之后的索引/记账**漂移**，让紧随其后的 `//` 注释没被识别（`/` 被当除号 ⇒ 注释里的 `的` 撞上「非法字符」）。CI 在 LF 检出上跑，故一直绿，只有 CRLF 检出会看到 | 定位 `lexer.ts` 里 XML 字面量的扫描循环：用**逐字符 `advance()`** 推进（而不是整段 `i += n`）以保证 `line`/`col` 记账与实际索引同步；补一条 **CRLF + 多行字面量 + CJK 注释** 的单元钉子（现有钉子都在 LF 检出下构建，看不见这类漂移）。**成本低、先复现再改**。证据：`temp/lxprobe/`（E/M 两族矩阵）+ `e4x-name.as` 的 LF 副本可编过 |
| 顶层自由 `function` 名撞 **宿主侧保留名**（POSIX 的 libc/libm 符号 `log`/`pow`/`exp`/`index`…，Windows 的头文件宏 `near`/`far`…）⇒ **编译失败** | 未开始（2026-10-06 阶段九十六 探针实测发现；**2026-10-10 阶段一百三十一 Windows 全量回归补上宿主宏一族的证据**；**命名层**，非音频/非 Stage3D） | 阶段七十六 的保留字表只覆盖**方法名/字段名/类名/局部变量/形参/模块变量**，**顶层自由函数**漏网。① POSIX：`function log(s:String):void` 被发射成 C 的 `log`，与 `-lm` 的 `log(double)` 冲突 ⇒ `error: passing 'char *' to parameter of incompatible type 'double'`（对照 `examples/stage76.as` 里**写在类内**的同名方法通过）。② **Windows**：`function near(a,b,msg)` 被发射成 C 的 `near`，而 `windows.h`→`winnt.h` 在 x64 上有 `#define near`（`far`/`small` 同类）⇒ 宏展开成空，`static void near(double,double,char*);` 变成 `static void (double,double,char*);` ⇒ clang 报 `error: expected identifier or '('`（本机**6 个示例**因此编不过：`compound.as`/`stage20`/`stage58`/`stage61`/`stage79`/`stage94f`，都是自带的 `near()` 断言助手）。而 mxmlc/AIR 允许这些名字 | 把顶层函数名（声明 + 调用点，`main`/`[WasmExport]` 除外）并入 `symbols.ts`/`emit.ts` 既有的 `sanitize` 集合，并按平台补**宿主宏名**（`near`/`far`/`IN`/`OUT`/`interface`/`small`…）；会**改变所有示例生成的 C 文本**（阶段七十六 已记载同类风险），须 examples 全量回归。证据：`temp/audioprobe/gen10.ts`（POSIX 侧）+ 本机 Windows `node test.ts` 的 6 个 `expected identifier or '('` 红（Windows 侧） |
| IME **合成期**的 `.text` 口径未实测（合成串到底进不进 `.text`） | 未开始（2026-10-04 阶段九十四·十七 主动登记；**未实测项**） | 本阶段把合成串实现为**预览**（`.text`/caret/选区/`numLines`/`textWidth` 不动、不派 `change`），理由是：本机**无法把真实输入法接到 `adl`**——① `TISSelectInputSource(WeType)` 让 python 进程 `SIGTRAP`（exit 133）；② 输入源是**按应用（per-app）**的，`TIS` 只能改调用者自身，`adl` 拿不到；③ 菜单栏输入法菜单未启用（`Ctrl+Space` 旋转也无效）。因此「合成期 AIR 的 `.text` 含不含合成串」这一条**没有实测口径**，是**选择**而非复刻 | 立项：在一台输入法可用的机器上写 `adl` 探针——合成中每帧 dump `text`/`text.length`/`caretIndex`/`numLines`/`textWidth` 与 `change` 次数；若 AIR 确实把合成串算进 `.text`（则我们当前的「预览」模型需要改），再按实测重写；同时实测 `IMEEvent` 的事件序与 `data` 载荷 |
| `flash.system.IME` 类与 `IMEConversionMode` **未实现**（只登记了实测口径） | 未开始（2026-10-04 阶段九十四·十七 实测登记后**主动不实现**） | `adl 51.4.1` 实测：`IME.isSupported=true`、`enabled` 初值 `true` 可写、`conversionMode="UNKNOWN"`；`setCompositionString`/`doConversion`/`compositionSelectionChanged` **恒抛 `Error #2063`**、`compositionAbandoned()` 是 no-op、`setConversionMode` **根本不存在**（`Error #1006` `setConversionMode is not a function`）；`IMEConversionMode` 只有 **8** 个常量，已废弃的 6 个**读回 `undefined`**；且 mxmlc **拒绝静态引用**这些成员（只能动态引用）。⇒ 这个类在 macOS 上没有可用路径，实现价值低 | 若将来做 web/Windows 端且确有需要，再按上表口径补类骨架（8 个常量 + `isSupported`/`enabled`/`conversionMode` + 方法抛 `#2063`），**不要**凭空给方法编语义 |
| `IMEEvent` 事件族（`imeCompositionStart`/`Update`/`End`）**不可达** | 未开始（2026-10-04 阶段九十四·十七 实测登记） | mxmlc **拒绝** `IME.addEventListener(...)` 的静态调用（「可能未定义」）；AIR 文档口径是「未设 `imeClient` 时运行时用 out-of-line 合成，最终结果作为 `TextEvent.TEXT_INPUT` 送出」⇒ TextField 路径上唯一可观测的口径就是**提交时的 `TEXT_INPUT`**（本阶段已接）。事件族本身在 AS3 侧既发不出去也监听不到 | 与上一行同批：只有先能实测事件序（需真实输入法环境）才谈实现 |
| web 目标**合成事件未接**（`compositionstart`/`compositionupdate`/`compositionend`） | 未开始（2026-10-04 阶段九十四·十七 主动登记） | native 侧已接 `SDL_TEXTEDITING` → `"textEditing"` 通道；web 侧 `vendor/web_glue.cc` 既没有键盘通道（既有遗留行）也没有合成事件通道，故浏览器下 IME 的 marked text **完全不可见**（提交路径 `input` 事件同样未接）。属**明确的未支持**，不静默降级 | 与「web 目标键盘与剪贴板未接线」同批立项：DOM 的 `compositionstart/update/end` → 帧边界队列 → 与 native 同一条 `"textEditing"` 语义（marked text + caret）；`beforeinput`/`input` → `sk_window_text_take` 等价物 |
| 字符串内嵌 **NUL**（`"a\u0000b"`）在本运行时截断 | 未开始（2026-10-04 阶段九十四·十八 实测登记；属**字符串表示**的既定边界） | 阶段九十四·十八 已让 `\uXXXX`/`\xXX` 正确解码，但解码出的 `\u0000` 是真正的 NUL 字节，而本运行时的字符串是 **C 串**（`char*`）：`strlen` 在 NUL 处停止 ⇒ `"a\u0000b".length` 我们 **1**、`adl` **3**（AIR 的字符串是 UTF-16 码元序列，NUL 是普通码元）。影响面 = 用 NUL 做分隔/填充的协议代码（真实工程里 `ByteArray` 那侧另有 API，字符串这侧少见） | 要忠实须把字符串改成**带长度的表示**（`{char* , int len}` 或 UTF-16），触及运行时字符串层与全部示例 ⇒ 与「`String` 是 UTF-8 字节索引」行**同源同批**；当前只在示例里钉住可观测的那一面并写明偏差 |
| 可视行表（`sk_textlayout_line_metrics` 的 `fStartIndex/fEndIndex`）仍是 **UTF-16 码元**，而 `as_tf_line_of_index`/`as_tf_line_end` 拿 **字节** caret 去比 | 未开始（2026-10-04 阶段九十四·十七 实测发现并登记） | 阶段九十四·十七 已把**渲染侧**（光标矩形、选区矩形）的字节→码元换算补上（`as_tf_utf16_index`），但阶段九十四·十五 的**可视行表**还在直接比较两种索引域：`as_tf_line_table` 存的是 Skia 给的 UTF-16 索引，`as_tf_line_of_index(caret)` 与 `as_tf_line_end(line)` 用的却是**字节**偏移。ASCII 下两者恒等（探针全 ASCII，故此前没暴露），**CJK 文本上**（如 `"ab你好"`，caret 字节 8 / 段落码元 4）会误判「caret 在末行之外」⇒ `Up`/`Down`/`PageUp`/`PageDown` 的落脚行/列会偏。**判据（§1.5）**：`adl` 能跑对 ⇒ **遗留** | 立项：把这四处比较统一走 `as_tf_utf16_index(tf, byte)`（换算一次即可，成本极低），并补一个 **CJK 多行 + `wordWrap`** 的双端探针（`temp/editprobe`）验证 Up/Down/PageUp/PageDown 的落点；与「上下移动的列位口径是字符列而非像素 X goal」行**同批**做一次文本导航的完整回归 |
| 窗口键盘通道把 **Shift 自身**的 keyDown/keyUp **各派发两次** | 未开始（2026-10-04 阶段九十四·十三 实测中发现并登记；**AOT 独有**） | 同一个驱动（`Quartz.CGEventCreateKeyboardEvent`，Shift vk=56 只 post 一次）下，`adl 51.4.1` 每个 Shift 按键只记 1 条 `KEY keyDown kc=16` + 1 条 `KEYUP kc=16`，而 AOT 产物记 **2 条**（同一毫秒、内容逐字相同，`temp/editprobe/aot_run2d.txt` 与 `aot_ed10.txt` 都可复现；早于本阶段的旧证据里就有，非本次改动引入）。`mod` 位掩码、与 Tab 的配对、`shiftKey` 取值都正确，所以只影响「监听 Shift/修饰键自身按键」的代码（例如把 Shift keyDown 当手势起点的 UI）。`vendor/window_glue.cc` 的 `sk_key_cb`→`ASC_window_on_key`→`Stage_dispatchKey` 全程只有一个调用点，SDL 事件层是否重复投递待查。**判据（§1.5）**：`adl` 只发一次 ⇒ **遗留**（保真缺口） | 排查起点：在 `window_glue.cc` 的 `SDL_KEYDOWN/KEYUP` 分支加临时计数，确认是 SDL 收到两次还是我们派发两次；若是 `SDL_TEXTINPUT`/`KEYMAPCHANGED` 伴随路径重复进入同一分支，按事件类型去重 |
| `displayAsPassword` 与 `htmlText` 的**组合**未实测 | 未开始（2026-10-04 阶段九十四·十六 主动登记；**未实测项**） | 遮罩已按实测落地（排版串 = 每字节一个 `*`、CR/LF 保留、`.text` 恒为明文、遮罩字段拒复制/剪切），但**带 run 表（`htmlText`/`setTextFormat`）的字段再开遮罩**没探过：当前实现让**遮罩优先**（`hasRuns` 在遮罩生效时强制为假，星号串走单一 `defaultTextFormat` 排版），理由是 run 的字节区间与屏幕上的星号串对不齐。`adl` 侧未跑（密码字段用富文本是罕见组合） | 立项：写一个 `htmlText` + `displayAsPassword=true` 的 `adl` 探针，实测 AIR 是「保留各 run 的大小/颜色但字换成 `*`」还是「整段退化成默认格式」；再决定是否让 run 表参与遮罩 |
| 多行 `Return` 的 `textInput` **载荷**是 `"\r"`（`adl` 是 `"\n"`） | 未开始（2026-10-04 阶段九十四·十四 实测登记） | 阶段九十四·十四 给多行字段补上了 `Return` 的文本提交（SDL2/Cocoa 从不为 Return 产生 `SDL_TEXTINPUT`，我们在 keyDown 上合成），结果文本两端**逐字一致**（`5\r\r7`），但事件载荷不同：`adl 51.4.1` 实测 `TextEvent.text == "\n"`，我们传 `"\r"`。只在「监听 `textInput` 读载荷做判断」的代码上可观测 | 立项：合成时把载荷改成 `"\n"`、插入前把 LF 归一为 CR（要先实测粘贴含 `\n` 的剪贴板在 adl 上插入什么，别顺手改粘贴路径） |
| `TextField.textWidth` 不含行尾空格（AIR 含） | 未开始（本轮实测发现，**与断行无关，是独立口径**） | 同字体同字号下 `textWidth` 对 `"Multitouch "`：AIR **133**（含 1 个空格 8.5px）、对 `"Multitouch  "` **141.5**；我们恒为 **124.945**（SkParagraph 不计尾部空白） | AIR 是权威（§1.5），该差异是**遗留**不是增强。**风险点**：Starling 的 `TrueTypeCompositor` 正是按 `textWidth` 定尺建 BitmapData，改动会**同时影响**它与 `textfield-align` 的居中期望值，须重跑 Starling 12 场景 + 相关 examples 才能收 |
| AMF 编解码（`URLStream.readObject`/`writeObject`、`registerClassAlias`/`getClassByAlias`） | **部分完成**（2026-10-03 阶段九十四·四：**AMF3 读写双向已实现并与 `adl 51.4.1` 逐字节一致**——`ByteArray`/`URLStream` 的 `readObject`/`writeObject`、`registerClassAlias`/`getClassByAlias`、引用表/trait 表/别名表齐备（`examples/stage94d.as` 67 条断言 + `test.ts` `[amf]`/`[bytearray]` 钉子）。**未完成**：①**AMF0 完全未实现**（`objectEncoding != AMF3` 时**响亮抛错**；AMF0 语义已采全：number `00`+double、布尔 `01`、null `05`、undefined `06`、string `02`、**Array 走 ECMA 数组 `08`**、object `03`、typed object `10`、Date `0b`）；②`IExternalizable`/外部化对象（`bit2`）**响亮报不支持**（AIR 自己也会以 `#2173` 拒这类手工流）；③Function/XML 值 AMF3 下**响亮报不支持**；④`ByteArray` 引用（`#3`）不支持 | AMF 是二进制**对象图**序列化（AMF0/AMF3 双版本 + 引用表 + trait 编码 + 别名注册表），与现有「对象当纯数据」的 `Dictionary`/record 反射表**不重合**，需独立编解码器。**语义面本身也没采集全**：`adl` 探针只测到空 `URLStream` 的 `readObject()` 抛 `#2029`（`temp/air-probe/air-probe-result.txt`）。原为 `flash.net` 两个汇总行的共有未收尾子项，本轮汇总行移出时**提升为独立行**以免丢失 | 独立立项：先用 `mxmlc + adl` 采全语义（别名注册表、AMF0/AMF3 切换、引用表、`ByteArray` 读写对、`writeObject` 的 `trait` 形状），再实现编解码器；验收用本地服务器**回放固定 AMF 字节**并与 `adl` 逐字节对照。**成本中**（编解码器本体 + 反射表对接）。**2026-10-03 已立项为阶段九十四·四**（与该子阶段的 `ByteArray.readObject`/`writeObject` 合并推进，避免两处各写一份编解码器） |
| `SecureSocket` 的 TLS 状态机 | 未开始（当前是**诚实失败**而非错误实现：`isSupported=false`、`connect()` 派 `#2031`） | 缺的是「非阻塞传输之上的 TLS 状态机 + AIR 的 `serverCertificateValidate` 握手回调」。可链接的现成 TLS 库与静态 curl 的取舍同源（`vendor/curl` 已把 nghttp2/zlib 静态化，TLS 后端仍是系统 SecureTransport）。**不实现比假装实现正确**——静默明文连接是最坏的失败模式 | 立项时改 `as_sock` 的连接状态机（CONNECTING 之后插入 TLS 握手态），并补齐证书事件面；验收用本地 TLS 服务器 + `adl` 对照 |
| `DatagramSocket`（UDP） | 未开始 | UDP 与 TCP 底座不同：无连接、无 `flush` 语义、`send()` 自带目标地址、`DatagramSocketDataEvent` 载荷是完整的 `ByteArray`。AS3 面（`bind`/`send`/`close`/`receive`）与实测语义均未采集 | 独立立项：先按 AGENTS.md §2.4 用 `adl` 采全部语义，再复用 `as_sock` 的注册表与帧边界泵（`SOCK_DGRAM` 分支） |
| preview2 `wasi:http`（WASI 原生联网） | 调研完成 · 实现暂缓（**本轮只侦察，未写一行代码**） | 侦察结论（均为本机实测）：① wasmtime **48.0.2** 支持 `-S http[=y]`、`-S inherit-network`、`-S tcp/udp`、`max-http-fields-size`（明示 wasi-http **0.2**），故**宿主侧已就绪**；② wasi-sdk-34 的 `share/wasi-sysroot/include/wasm32-wasip2/wasi/` **没有 wasi:http 头**（只有 `sockets`/`filesystem`/`clocks`/`random`/`io` 的 p2 生成头），故 bindings 需**手写 canonical ABI** 或用 **wit-bindgen** 生成；③ 无 `wit-bindgen`/`wasm-tools`/`cargo`/`rustc`（`command -v` 全部 MISSING），且 wasi-sdk 下**没有** `wasi_snapshot_preview1` adapter（`find -name "*adapter*"` 为空）——但二者**可经本机代理下载**（`github.com`/`api.github.com` 均 200，`codeload.github.com` 亦通）；④ 要跑 wasi:http 必须交付**组件**（`wasm-tools component new` + p2 adapter），而本项目现有 wasm 目标是 **wasip1 核心模块**，故还需在 `build.ts` 增一个 p2 目标与后处理步骤 | 立项时的完整链路（已明确）：① 下载 wasm-tools（aarch64-macos 预编译）+ `wasi_snapshot_preview1.command.wasm` adapter；② 取 `wasi:http@0.2.x` 的 WIT（`github.com/WebAssembly/wasi-http`）并用 wit-bindgen 生成，或手写 ~14 个 canonical ABI 导入（`types.new-*`/`set-method`/`append-header`/`outgoing-handler.handle`/`incoming-response.{status,headers,consume}`/`incoming-body`/`streams.read`/`drop`）；③ `build.ts` 增 `wasm-p2` 目标（`clang --target=wasm32-wasip2` + `component new --adapt`）与 `ASC_HAVE_WASI_HTTP` 宏；④ 在 `as_http_perform` 的第三后端里映射到 `handle`；⑤ 验收用本地 HTTP 服务器 + `wasmtime run -S http -S inherit-network`。**风险**：手写 canonical ABI 的 `result<incoming-response, error-code>` 落地下标与 `option<resource>` 的哨兵值必须精确，错一处即 trap；故优先走 wit-bindgen 生成而非手写 |
| Starling 在 `contentScaleFactor ≠ 1` 时 Stage3D 层被重复放大（只露左上 1/4） | 未开始（本轮实测记录：`examples/Flappy-Starling` 的 AOT 产物在 `csf=2` 下只见舞台左上 1/4 且放大 2×；改 `ScreenSetup` dpi 使 `csf=1` 则整屏正确） | 阶段八十九·十九 定的合成口径是「源=物理尺寸、目标矩形=`ASC_stage3d_lw/lh`（逻辑 stage 单位）、由 canvas 设备缩放还原到物理像素」。该口径在「AS3 侧把**像素**尺寸传给 `configureBackBuffer`」时会把设备缩放叠加两次：Starling 的 `_clippedViewPort` 就是像素单位（`Starling.as:505` → `Painter.as:247`），且它按 `_supportHighResolutions`（Flappy 未开）传 `wantsBestResolution=false`。探针实测 `configureBackBuffer req=375x667 best=0 bbScale=1 -> bb=375x667`，同轮 `ASC_window_render` 的 blit（`emit.ts:7323`）未触发——Metal Stage3D 层直画 drawable，缩放不受 2D 画布 CTM 管辖，需按 Stage3D 自己的视口/投影口径核对 | 先查 Metal 后端（`vendor/stage3d_glue.mm` + `ASC_window_render`）在 `csf≠1` 时的实际绘制矩形与投影：AIR 的语义是「后台缓冲像素尺寸 = 视口像素尺寸」（本机 750x1334），而舞台 375x667 只是逻辑坐标——即 `bbw/ASC_win_scale` 才等于逻辑尺寸。修法与验收：用 `examples/air-starling-demo`（`csf=1`，当前正常）做零回归对照 + Flappy 的 `csf=2` 场景做「整屏可见」断言 |
| `[SWF(width,height,backgroundColor)]` 元数据被解析后**丢弃**（`stage.stageWidth/Height` 与舞台底色两处不忠实；**`frameRate` 已实测确认同样丢弃**） | 未开始（**本轮实测发现**，八十九·六十八；`src/parser.ts:215` 的注释「no runtime effect」经实测推翻） | 受控实验（同一探针、只切元数据、`adl` 桌面档）：无元数据 `stage=500x375`（mxmlc 默认 SWF 尺寸）；加 `[SWF(width="320",height="480")]` → `stage=320x480`。即 AIR 的 **`stage.stageWidth/Height` = SWF 声明尺寸**，我们 = **窗口尺寸**（探针 1600x1000；`examples/Flappy-Starling` 的 `[SWF(width="320",height="480",frameRate="60",backgroundColor="#d1f4f7")]` 因此无效）。**同一根因的第二处可见差异**：adl 画面底色 `#d1f4f7`、我们白。**`frameRate` 半已于2026-10-07（阶段一百一十四）实测落定**：`temp/rprobe/`（`[SWF(frameRate="60")]`，adl 哨兵看门狗）⇒ `adl 51.4.1` 报 `stage.frameRate = 60`、3 s 内 `ENTER_FRAME` **169 次（56.1 fps）**；我方同一 demo 实测 **120 fps**（`ASC_S3D_STATS` 的 draws/s=240 ÷ 每帧 2 draw）、`stage.frameRate` 读回 **0**（`ASC_app_frame_rate` 初值 `0.0` = 未设⇒跟随刷新率）⇒ **动速度两倍于 AIR**。**旁证（旧探针 `temp/fpsprobe/`，2026-10-02）**：无 `[SWF(frameRate)]` 元数据时 `adl` 起始 `mainFR = 24`（= mxmlc 默认 SWF 帧率）、我方 `0` ⇒ 两边合证 AIR 的初值就是 **SWF 头帧率**（默认 24，元数据可抬到 60） | 独立立项（**动它会改所有 GUI 示例的布局与节拍**，须连 Starling 12 场景一起回归）：①`ast.ts` 增加 SWF 元数据载体（现在 parser 解析后直接丢）；②`air-app.ts` 把元数据透传到 `BuildConfig`；③运行时以「元数据优先、缺省回退窗口尺寸」定 `stage.stageWidth/Height`，底色同上，**`frameRate` 写入 `ASC_app_frame_rate` 初值**（`0` 仍表示未设）。`frameRate` 的 adl 口径已实测（见左）；`width/height/backgroundColor` 口径已实测。**判据（§1.5）**：`adl` 能跑对而我们跑不出 ⇒ **遗留**，非增强。**注意**：本项落地会让现有 GUI 示例（含 `Basic_SkyBox`）从 120 Hz 降到声明的 60 Hz——这正是 AIR 行为，但属**可观测节拍变更**，须单独立项验收 |
| `Stage.fullScreenWidth/Height` 取「完整显示模式」而非 AIR 的「可用区」 | 未开始（**本轮实测发现**，八十九·六十八） | 同机同刻三端对照：`adl` **1800x1137** vs 我们 **1800x1169**（同一显示器时 Δ = 32 = 菜单栏高度）；换到外接显示器后 `adl` 报 **2560x1408**（= 2560x1440 − 32），规则**跨两种显示模式复现**。即 AIR 取**窗口所在显示器的可用边界**，我们取 `SDL_GetCurrentDisplayMode`（display 0 的完整模式）。**多显示器下两者甚至不在同一块屏**（native 报内建 1800x1169、adl 报外接 2560x1408），修复须一并考量「窗口在哪块屏」——这与当前实现的「总是 display 0」是两件事。web 侧同源：我们读 `window.screen`（无头 Chrome 实测 800x600，真实浏览器则是整屏尺寸），而舞台其实只有 canvas 那么大 | 独立立项：native 侧把 `SDL_GetCurrentDisplayMode` 换成「窗口所在显示器的可用边界」（`SDL_GetDisplayUsableBounds` + `SDL_GetWindowDisplayIndex`），web 侧把 `window.screen` 换成 `screen.availWidth/availHeight`。**注意**：`Starling` 的 `ScreenSetup` 正是按这两个值定世界尺寸（`examples/Flappy-Starling` 的布局即由此而来），改动会连带影响所有 GUI 示例与 Starling 场景 ⇒ 与上一行**同批回归**。**2026-10-02 实测澄清（防误修）**：`Capabilities.screenResolutionX/Y` 是**另一个量**——同机同刻 `adl` 报 **1800x1169**、我们也是 **1800x1169**（**已对齐**，`as_cap_screen_resolution_x/y` 走的就是 `SDL_GetCurrentDisplayMode`）；只有 `Stage.fullScreenWidth/Height` 才有 1800x1137 vs 1800x1169 的差。故本行修法**只能落在 `Stage` 侧**，不得顺手把 `Capabilities` 的口径一并换成「可用区」（详见下表新增的 `Screen` 行） |
| 命中测试的**边界约定**：`adl` 的 box 在描边外缘外 **0.25px** 仍算命中、右/下边界**排他**；我们一律**严格几何 + 闭区间** | 未开始（2026-10-04 阶段九十四·二十二 实测登记，`temp/editprobe/hit25_{adl,aot}.txt`） | 42 行逐行对照里**只有 2 行不同**，且都在边界那 0.25px 的抗锯齿模糊带里：`outer edge x=5.75`（描边外缘 6.0 之外）adl `box=true` / 我们 `false`；`right x=34`（正落在描边外缘）adl `box=false shape=false` / 我们 `true true`。`adl` 自己的边界在三组 bitmap 探针里也不完全自洽（Ed21 §A1 与 Ed23 §A 对同一几何给出不同的右边界），故这是**抗锯齿光栅化**的产物而不是一条可抄的规则 | 立项：若要逐像素对齐，须先搞清 AIR 用的是「4x4 超采样覆盖率 ≥ 某阈值」还是「整数像素网格」，并用更多几何（斜线、圆）定阈值；风险是给命中测试引入半像素模糊。当前取严格几何（可解释、可测），差异登记在此 |
| 多个 `beginFill/endFill` **组**的嵌套：`adl` 两组都填充，我们只有**一条路径** ⇒ even-odd 把它当洞 | 未开始（2026-10-04 阶段九十四·二十二 实测登记，`temp/editprobe/probe26.py` + `snap_ed26_{adl,aot}.png`） | 同一个 200x200 外框 + 60..140 内框：**一次 fill 两个同向子路径** ⇒ 内层中心 adl `FFFFFF`（洞）、我们 `FFFFFF`（洞）✓ 一致；**两个独立 fill 组** ⇒ 内层中心 adl `FF0000`（填充）、我们 `FFFFFF`（洞）✗。根因是本实现「一个 Graphics = 一条 SkPath + 一对 paint」（注释里已写为单路径子集），fill 组边界在记录几何时丢失 | 立项：把 `Graphics` 的绘制记录成**组**（每组一条路径 + 一对 paint），渲染与命中都按组并集；代价是数据结构与指纹（`as_fp_*`）都要跟着改，属独立阶段。顺带定 **`Graphics` 填充规则的第二个判据**（自相交路径：nonzero 填满星形中心、even-odd 挖空；现在只有「同向嵌套子路径成洞」这一条实测支撑 even-odd） |
| 鼠标**拾取**（`as_pick_hit`）仍按含描边外框，未按内容区域 | 未开始（2026-10-04 阶段九十四·二十二 主动登记，**未实测 adl 的交互拾取口径**） | 本阶段把 `hitTestPoint` 改成区域判定，拾取只跟着改成「含描边外框」（原来连描边都不算 ⇒ 仅有描边的 `Shape` 本来点不到，这是同批修掉的真缺口）。但 `hitTestPoint(x,y,true)` 的实测说「容器子对象之间的缝不命中」——若 AIR 的交互拾取也用区域，则在缝里点父容器应当**不**命中，我们现在会命中。`adl` 侧未做「缝里点击是否收到事件」的探针 | 立项：写一个 adl 点击探针（在 Ed24 §4 的缝里合成点击，看 `MouseEvent.target`），再决定 `as_pick_hit_m` 是否改用 `as_obj_region_hit_local`（改动很小，但会影响既有鼠标相关示例/Starling 触摸通路，需全量回归） |
| 命中测试在**边界 ~0.05px 内**与 `adl` 不一致（`adl` 更松） | 未开始（2026-10-03 阶段九十四·六 实测登记；**只在贴边点击时可观测**） | `temp/c1probe/click/` 真鼠标实测：屏幕点 `(310,110)` 打在旋转方块上，`adl` 报 `localX/localY = (14.13, -0.021)` **且判定命中**——按严格几何它在盒外 5e-5（`adl` 把 x/y 量化到 1/20px、中间量走单精度，见 `temp/xformcmp/README.md`）。本子集按严格几何判 ⇒ 该点判**不中**。示例为避免依赖这一口径，命中断言一律用**内部点**（如 `(328,142)` → local `(49.49,9.88)`） | 让判定带一个 adl 量级的小容差（经验值 ~1e-3 px，或取量化步长 0.05 的一半），但**任何容差都要先用点击探针在两端口径上标定**，否则会把「贴边未中」变成「贴边中」的假阳性 |
| `NativeWindow` 家族**剩余**方法/事件/属性面（多窗口运行时已落地） | 部分完成（2026-10-02 阶段八十九·七十一 落地；本行只登记其中**尚未实现**的部分） | **已落地**（native 与 `adl 51.4.1` 逐项对齐，含端到端点击验收）：`new NativeWindow(opts)`（默认 400x232 框、返回时 `visible=false`）、`NativeWindowInitOptions` 八个默认值、`bounds/x/y/width/height/title/visible/closed/active/displayState/alwaysInFront/resizable/maximizable/minimizable/systemChrome/type/renderMode/transparent/owner(get)/stage/toString`、`close/activate/minimize/maximize/restore/orderToFront/orderToBack`、4 个静态常量、5 个 token 常量类、**每窗独立 `Stage`**（`showAll`/`align=""`，帧率继承应用级 `Stage.frameRate`，见阶段八十九·七十三）、`Event.CLOSE`（帧边界延迟一帧收尾）、`resize` 事件。**尚未实现（AIR 有 ⇒ 遗留）**：`startMove()`/`startResize()`（系统拖拽/缩放）、`owner` **setter**、`notifyUser()`（通知）、窗口菜单（`menu`/`NativeMenu`）、`Stage.nativeWindow`、`NativeApplication.openedWindows`/`activeWindow`/`exit()`、`systemMinSize/systemMaxSize/minSize/maxSize` 四个尺寸限制属性，以及 `Event.ACTIVATE/DEACTIVATE`、`NativeWindowDisplayStateEvent`、`NativeWindowBoundsEvent`（MOVING/MOVED/RESIZING/RESIZED/CLOSING 系列）。web 目标无多窗口概念 ⇒ 已按 §1.5 **诚实抛 `#2012`**，不属本行 | 分批、每批一个可验收行为：① `Stage.nativeWindow` + `NativeApplication.openedWindows`（纯反查，成本最低，让「谁是主窗口」在 AS3 里可判定）；② `startMove`/`startResize`（macOS 走 `-[NSWindow performWindowDragWithEvent:]`，需从 SDL 事件取 `NSEvent` 指针）；③ 事件面（glue 暴露 `SDL_WINDOWEVENT_MOVED/RESIZED` 与焦点事件；注意 `live_resize_watch` 已在管拖动中的尺寸，别重复派发）；④ 菜单/通知/尺寸限制（依赖面最大，最低优先）。验收沿用 `temp/nwtest/` 的双端对照 harness（`adl` 结果文件 + AOT 结果文件逐行 diff） |
| `X.transform.matrix` 的**访问链别名**（`var t = X.transform; t.matrix`）仍是残余槽的裸读写 | 未开始（2026-10-02 阶段八十九·七十六 主动登记的实现边界） | `X.transform.matrix` 本身读写已精确（合成/分解访问器对），但 `Transform` 结构体**没有指回属主的反指针**（加它要给每个 `DisplayObject` 挂一个反向引用字段并补 `gc_write_barrier`，风险面覆盖 GC 与全部显示对象）。故先取 `t` 再经 `t.matrix` 读写时，读到/写到的仍是 **skew 残余槽**（不含 `x/y/rotation/scaleX/scaleY`），与 adl 的「同源单一矩阵」不一致。探针 T5 实测 adl 的 getter 返回拷贝，故这个别名写法**在 AIR 里本来就是无效操作**（改了不动对象），我方目前是「改残余槽」——不报错但语义不同 | 立项时与「矩阵作唯一真源」的重构合并做：`Transform` 加 `owner` 反指针（或用 owner 侧懒查表），读写字面量 `t.matrix` 也走访问器对；**须整批回归** GC 审计（`ASC_GC_AUDIT`）+ Starling 12 场景 + 全部 GUI examples |
| 两个矩阵的**分解字段**与 adl 不同（矩阵往返与渲染仍精确） | 未开始（2026-10-02 阶段八十九·七十六 探针实测） | ① 纯 flipX `[-1,0,0,1,5,6]`（T10）：adl 给 `rotation 0 / scaleX -1 / scaleY 1`，我方给 `rotation 180 / scaleX 1 / scaleY -1`；**证据**：adl 对结构相同的 `diag(-2,3)`（T19）却给 `rotation 180 / scaleX 2 / scaleY -3`，即 adl 的选择**不是所赋矩阵的函数**（纯 flipX 与 `diag(-1,1)` 是同一矩阵，adl 两者答案不同）。② `[0,0,1,1,5,6]`（T25，零首列且非零首行）：我方渲染链 `translate·rotate·scale·残余` 在 `scaleX=0` 时表示不出「首行非零」，故把线性部分整体寄存到残余（字段报 `scaleX/scaleY = 1`），adl 报 `scaleX 0 / scaleY 1.414`。两例的**矩阵读回与像素都精确**（T10/T25 反向对照：读回逐值等于所赋矩阵） | 收益极低（要改渲染合成顺序或引入 AIR 内部的双存储），暂不排期；若将来做 ①，先扩充 `temp/xformcmp/cmp_probe.py` 的 `KNOWN` 集合口径，并把两例的行为差异写进 `docs/zh-cn/as3-semantics.md` 决策分歧点 |
| 光标形状是**进程级一个**（多窗口时跟随最后一个写入者） | 未开始（平台硬边界，2026-10-02 阶段八十九·七十六 落地时实测） | `SDL_SetCursor` 在 SDL2 里**没有 per-window 版本**（窗口参数被忽略），故第二个窗口写 `Mouse.cursor` 会改掉第一个窗口的指针形状；窗口数≥2 且各自需要不同光标时才可观测。指针离开窗口恢复箭头（`SDL_WINDOWEVENT_LEAVE`）已做，故不会把 I-beam 带到菜单栏 | 若要根治需绕开 SDL：macOS 走 `-[NSCursor set]` + `NSTrackingArea`（或在 `mouseMoved` 里按窗口决定）、Windows 走 `WM_SETCURSOR`；属平台耦合，按 §2.9 应隔离在 glue 内。优先级低（AIR 自身也多窗口共享系统光标） |
| web 目标**键盘与剪贴板未接线**（native 已对齐 `adl`，含阶段九十四·七 的文本输入） | 未开始（2026-10-02 阶段八十九·七十七 主动登记，2026-10-03 阶段九十四·七 复查**依旧未接线**，属**明确的未支持**而非静默降级） | native 侧 SDL 键盘 → `KeyboardEvent` + `stage.focus` + `SDL_TEXTINPUT` → `TextEvent.TEXT_INPUT` + 加速键复制/剪切/粘贴已与 `adl` 逐项对齐（同一驱动两端实测一致）；`web` 侧 `vendor/web_glue.cc` **键盘整块被丢弃**（`(void)on_key;`，第 347 行）、剪贴板两个函数是空实现（`void sk_clipboard_set_text(const char*){(void)text;}` / `int sk_clipboard_get_text(char*,int){(void)buf;(void)cap;return 0;}`，第 422~423 行）——本轮新增的 `sk_window_text_take` 在 web 侧**同样没有对应物**：DOM 的 `keyCode`/`charCode` 与 AIR 的编号**不同族**（AIR 字母 keyCode 是大写 ASCII、Delete=46/charCode=127…），需一张 DOM→AIR 映射表并重建 DOM 焦点模型（`tabIndex`/`contentEditable` 那套与 AS3 显示列表焦点不是一回事）；文本输入还要把 DOM 的 `input`/`beforeinput` 事件泵到帧边界；剪贴板 API（`navigator.clipboard`）是**异步 + 用户手势门控**，而 AIR 的 `Clipboard` 是**同步**的——这是**平台硬边界**（§1.5），只能在帧边界做 pending 态并如实上报，不能假装同步成功 | 立项顺序：①键盘映射表 + DOM 焦点模型（可先支持「点击 canvas 即把焦点交给舞台」的最小模型）；②`input`/`beforeinput` → `sk_window_text_take` 的等价物（帧边界队列）；③剪贴板 pending 态（`Cmd+C` 时若无手势授权，按浏览器语义可能静默失败——须如实上报，不假装成功）。**注意**：emsdk 的 SDL2 port 未缓存，web 构建当前**离线不可复现** |
| 非 US 布局与 Option 组合字符的 `keyCode`/`charCode` 只按**基键**近似 | **部分完成**（2026-10-03 阶段九十四·七：**文本通道已按 `SDL_TEXTINPUT` 真实接线**——组合结果（`Option+e` → `"´"`、`Option+8` → `"•"`）会作为 `TextEvent.TEXT_INPUT` 的载荷送进字段，与 `adl` 双端对照一致；**剩下的缺口只在 keyDown 的 `charCode`**） | `SDL2` 不提供键盘布局查询、也不在 `SDL_KEYDOWN` 里给组合后的字符（组合字符走独立的 `SDL_TEXTINPUT`，已接线），故 `sk_us_char()` 按 US 布局的基键给 `charCode`：德语 `z`/`y` 互换、法语 AZERTY 的数字行、`Option+e` 变音符等的 **keyDown** 仍给出**基字母**而非实际字符（`adl 51.4.1` 实测 `Option+e` 的 keyDown 是 kc=0/cc=**180**，我们给基字母 `e`=101；`sk_air_keycode()` 在 `Option+字母` 时给 keyCode **0** 这一条已对齐）。**判据（§1.5）**：`adl` 给的是真实布局字符 ⇒ **遗留** | 立项：给 keyDown 补布局/组合字符——需在 `SDL_TEXTINPUT` 到达时回填**紧邻的那一次** keyDown 的 `charCode`（组合结果在 keyDown 之后到达，需要一个小的时间戳/待回填队列），布局相关 keyCode 需另查（SDL 只有 `SDL_GetKeyFromScancode` 的 US 假设）；验收用 `temp/editprobe/` 的同一驱动在**德语/法语布局**下与 `adl` 对照 |
| 广色域显示器上的**用户可见**颜色一致性未经仪器验证（`screencapture` 无法区分） | 未开始（2026-10-04 阶段九十四·二十三 收窄登记；原「整条渲染管线色彩管理 sRGB→P3」行的根因已定位） | 阶段八十九·七十七 记的偏移（`0x3366FF→(64,101,246)` 等）本轮**追到了捕获段**：我们的离屏 CPU 光栅与提交前的 Metal drawable 都是**逐位精确**的 sRGB（`ASC_MTL_READBACK` 读回 `ff00ff00`），金属/CPU 两个后端截图**逐值相同**，而 `adl` **自己**的窗口截图同样偏移（`FF8000→FF7700`，−9 LSB；我们 `FF8002`）⇒ 是窗口服务器/显示色彩管理在**截图**上引入的，两端共有、程度不同。剩下来的真问题只有一个：在广色域屏上**肉眼观感**是否与 AIR 一致，这需要色度计或与系统取色器对比，截图测不出来 | 立项：用系统取色器（Digital Color Meter）在两端窗口上读同一块纯色，比较**显示值**；若不同则说明 `CAMetalLayer` 的 sRGB 声明（已加，见 `metal_glue.mm` `sk_mtl_init`）与 AIR 的实际声明仍有差别。成本低（人工比对），但需真实广色域屏与人眼/仪器 |
| 上下移动的列位口径是**字符列**而非**像素 X goal** | 未开始（2026-10-04 阶段九十四·十五 主动登记；**精化项，非已知差异**） | 阶段九十四·十五 的 `Up`/`Down`/`PageUp`/`PageDown` 全部按**字符列**（`caret - lineStart`）保留列位，实测的英文等宽探针（`_typewriter`，行内全为单宽字符）下与 AIR 的「像素 X 换算回字符索引」**逐值一致**。但比例字体 + 混排（宽窄字符、制表符、内联图片 `getImageReference`）下，AIR 的 goal 是**像素 X**（同一 X 落在不同字符宽度的行上会换算出不同的字符列），字符列模型会偏移（Air 侧未做比例字体探针，故记为**口径待精化**而非「已知差异」）。**判据（§1.5）**：等宽下两者等价 ⇒ 不是「adl 能跑对我们跑不出」，而是「未实测比例字体口径」 | 立项：先写一个比例字体（`_sans`）+ 宽窄混排的 `adl` 探针（`AAAA...` 对 `iiii...` 交替行），实测 goal 是像素 X 还是字符列；若确为像素 X，则把 `_goal_col` 改存像素 X、由 `sk_textlayout_glyph_position_at`（或逐行 `getGlyphPositionAtCoordinate`）换算回字符索引 |
| 字体度量：**别名字面已对齐、行盒模型已对齐**，余 `_sans`/`_serif` 通用别名行高与 ≤0.5px 残差 | **部分完成**（2026-10-04 阶段九十四·二十 主体修复；原「行距 12 vs 15、前进 5.3 vs 6.6」**两个数字都已消除**） | 同为 `_typewriter` 12px、同一段 `ABCDEFGHIJ abcdefghij`：`adl` 的行高（选中带高）**15 px**、字符前进 **6.6 px**，我们 **12 px** / **5.3 px**（比值 ≈ 1.25）。故「同一拖拽距离覆盖的字符数与行数」两端不同（实测 adl 拖拽 `x 40→110` 得 `[4,14)`、我们得 `[3,14)`；另一探针里 adl 的多行选中带更高）。**阶段九十四·七 追加的同源证据**：`temp/editprobe/` 的鼠标落点探针里，`adl` 单行字段 `x=50` 落在**第 7 个字符**（我们第 6 个），多行 `Ed3` 第 2 行 `x=110` 落在 **22**（行尾钳位，我们 **18**）——同一段「点击/拖拽落点到字符索引」的换算是**度量驱动的**，与本节的行距/前进比同源，修字体后应一并复核（换算代码本身在 `as_tf_index_at`，走 `Skia` 的真实字形位置）。**阶段九十四·八 再次追加同源证据**：`temp/editprobe/` 的 Ed5 选区探针（`cmp_ed5.py` 结构化比对已忽略该度量差）里，同一文本、同一拖拽距离下 adl 的落点为 `21`/`26`、我们为 `18`/`23`（差值与「行距 12/15、前进 5.3/6.6」同源）。**阶段九十四·十五 追加的新证据（本轮把该耦合「证据化」）**：同批探针 `temp/editprobe/` 的 Ed15 里，`_typewriter 12` 的 **Skia 命中字体**与 adl 明显不同——同一多行字段的行宽落点（每个 20 字符词）我们约 **8.1 px/字符**、adl **6.6 px/字符**（我们更宽，故软换行点更早）；行高我们 `height/lineCount` 给 **12 px**、adl **15 px**（我们更矮，故 36px 高字段我们 `visible=3`、adl `2`，`w2` 可视行我们 `8`、adl `6`）。两项比值方向相反（宽 ×1.23、高 ×0.8）⇒ **不是整体缩放，而是真的命中了不同 Typeface**，与下述「根因疑似字体家族回落」一致。**阶段九十四·十六 追加的第三组同源证据（最刺眼的一次）**：`displayAsPassword` 的星号串把差距放大到肉眼可见——同为 `_typewriter` 12，一个 `*` 在 adl 是 **7.2 px**（等宽族每个字形同宽）而我们是 **4.67 px**（回落字体的星号明显更窄），于是「点击 x=45 落在第几个字符」adl 是 **6**、我们是 **9**；`_sans` 12 的 `*` 两侧倒是几乎一致（adl 46.5 / 我们 46.7 每十颗），说明差距**不是**我们的遮罩算法而是**字体命中**。**影响面**：`PageUp`/`PageDown` 步长、`scrollV` 数值、软换行落点、`textWidth`/`numLines` 的可观测值全部随之变化（阶段九十四·十五 的**规则**已对齐，只有**数值**受此影响）。**根因疑似字体家族回落**（我们拿到的不是 AIR 的 `_typewriter` 同一份 Typeface，Skia 按名字回落到别的字体），**不是**排版代码缺陷——`getHeight()/lineNumber()` 的接线在阶段三十八已按 Skia 真实行高落地。**判据（§1.5）**：`adl` 能跑对 ⇒ **遗留** | 立项：先实测两端 `_typewriter` 实际命中的 `SkTypeface`（`familyName()`/`getBounds()`）与 AIR 的字体文件，确认是「回落」还是「度量口径」；若是回落则按家族名精确选字体（`SkFontMgr::matchFamilyStyle` 指定 family 而非默认），随后**整批回归**文本布局示例（`textflow`/`textrich`/`textfield-align`/Starling 12 场景的按钮标签尺寸）。**阶段九十四·二十 结案（主体已修）**：根因确认为**家族回落**——`_typewriter`/`_sans`/`_serif` 是 Flash 运行时要自己解析的通用别名，原样透传 CoreText 会被静默当成未知家族而回落到系统默认**比例**字体，于是 `_typewriter` 量出 113.26 px/10×`W`（应为 72）、星号 4.67 px（应为 7.2）、行高 12（应为 15）。现按 adl 实测字宽选定字面（`_typewriter`→Monaco、`_sans`→Helvetica、`_serif`→Times New Roman、空→Times）并在 glue 内统一翻译（`sk_family_alias()`），**修后 `_typewriter` 12px 的 10×`W`/10×`i`/10×`*` 全为 72（= adl 72）、行高 15（= adl 15）、星号前进 7.2（= adl 7.2）**；行盒另按 AIR 模型强制（`round_half(ascent)+round_half(descent)`、丢弃字体自带 line gap、`TextFormat.leading` 按 px 计、多行字段尾行 leading 不计），12 个字面族里 8 个行高逐值相同、2 个残差 0.5 px（`Courier New`/`Arial`）。**阶段一百零三 追加的**行级**证据**（`getLineMetrics` 落地后逐行对照，`temp/metricprobe/metric6-diff.txt`）：残差家族与整段一致 —— 字符前进 `21.6 vs 21.5` / `36.01 vs 36`（≤0.01px）、`_sans` 12 的行高 `12 vs 15.5`、Monaco 20px 的行高 `25 vs 22`、对齐 ≤0.4px（居中 `89.2 vs 89`、右对齐 `176.4 vs 176`）；另测得 `wordWrap=true` 宽 60 时**软换行断点**不同（两边都是 3 行、断的位置不同）。**结论**：行级证据与整段证据指向同一个「设备字体表 + 半像素取整」根因，故不另立行。****仍未对齐的部分**：`_sans`/`_serif` 行高（AIR 用自有**非线性**设备字体度量表，见下一行）与上述 ≤0.5px 残差。证据台 `temp/metricprobe/`（12 族矩阵 + leading 矩阵 + adl 侧 `getLineMetrics`），模型见 `docs/zh-cn/skia.md` §8，`test.ts` 有 `[fontmetrics]` **8 条**结构钉子。 |
| `_sans` / `_serif` 通用别名的**行高**仍与 AIR 不同（我们 12 / 13，`adl` 15.5 / 15） | 未开始（2026-10-04 阶段九十四·二十 实测登记，**已定界**） | AIR 对三个通用别名用**自己的设备字体度量表**，且该表**非线性**：实测 9 档字号（8/10/11/12/14/16/20/24/32），`_sans` 行高 = 11/11/14/15.5/16/19/24/27/36、`_serif` = 10/11/14.5/15/16/19/22.5/26.5/35.5、`_typewriter` = 8/10/14/15/16/18.5/22/26/35（比值 1.0→1.29→1.09 之间来回，`_typewriter` 在 12 px 恰好等于 Monaco 的 12+3，14 px 起与 Monaco 分道）⇒ **没有一个可解析的字面能复现它**。本轮**不做**按测量点插值的硬编码表（那会把未测尺寸的数值也说成「实测」）。 | 若要完全对齐，唯一诚实的路是**逐尺寸复刻 AIR 的设备字体度量表**（须先扩大实测覆盖到全部常用整数尺寸，再决定插值口径）；否则接受这 2–3.5 px 偏差并保持文档明示 |
| Proxy 枚举/点号调用接管只对**静态类型**为 Proxy 子类的接收者发射 | 未开始（2026-10-03 阶段九十四·一 主动登记的实现边界） | `for-in`/`for-each` 的 `nextNameIndex`/`nextName`/`nextValue` 协议与「未声明成员的点号调用」只在**编译期已知**接收者是 Proxy 子类时发射（`symbols.ts` 的 `isProxy` 判定）；接收者声明为 `*`/`Object` 时走既有的记录槽/动态反射路径，**不查 `flash_proxy` 方法**。`adl` 是**运行时**判定（`vp is Proxy`），故 `var o:* = new MyProxy(); for (var k:String in o)` 在 AIR 里走拦截器、在我们这里得空/走记录槽。真实用例（GSAP `TweenProxy`/`VarsCore`）都是**具型**接收者（`this` 或具型变量），因此不在主流路径上 | 立项时把接管判定从「静态类型」改成「运行时 `is_proxy` 位」（vtable 已有该字段）：枚举协议改为生成一个运行时分支（`as_is_proxy(o) ? 代理协议 : 记录槽协议`），点号调用同理（`as_dyn_call` 已带 `is_proxy` 分支，缺的是枚举与外层判定）。**注意**：`*` 接收者的枚举循环变量 C 类型须一并按运行时分派（当前按静态判定选 `char*`/装箱值） |
| Proxy 拦截器收到的 `name` 恒为**原始 String**（`adl` 传的是装箱 String） | 未开始（2026-10-03 阶段九十四·一 实测登记，不动语义） | `adl 51.4.1` 实测（探针 `KeyProxy`）：点号/方括号**字符串键**与 `delete`/写 传入的 `name` 是**装箱** String（`typeof==="object"`、`v is String===false`、但 `v == "foo"` 为 **true**）；**数字键**（`p[3]`/`p[0.5]`）与 **`in` 运算符**传的是**原始** String（`typeof==="string"`）。我们一律传原始 String ⇒ 差异只落在「用户代码对 `name` 做 `typeof`/严格相等/`===` 比较」时。**这条不是理论差异**：GSAP `VarsCore.deleteProperty` 的 `_props.indexOf(prop)`（`_props` 是原始 String 数组、`indexOf` 走严格相等）在 AIR 里对点号传入的装箱 `name` **恒返回 -1**，因此 `delete vars.foo` 在 AIR 里返回 **false** 且不删（实测 `d1..d5`：`delete` 得 false、`_props`/`_values` 原封不动），而我们返回 true 并真的删掉——我们「更正确」，但**与 AIR 不一致** | 要复刻须引入**装箱 String 对象**：①运行时造一个 boxing 助手（GCF 跟踪、`as_string_vt` 已有对象形态，须补 `as_v_eq`/`as_v_str_val`/`typeof`/`is String`/字典键强转五处）；②在**调用点**按访问形态选原始或装箱（点号/字符串键/`delete` → 装箱；数字键/`in` → 原始）——即 emit 侧要按形态分派。**风险评估**：收益仅限 `typeof`/严格相等这类少见用法，而改动横跨运行时装箱、比较与字典键三处**全局**路径，回归面覆盖全部示例 ⇒ 暂不动，如实记账 |
| `Proxy.getDescendants` 在 **`..` 作用于 Proxy 接收者**时仍不可达 | 未开始（2026-10-03 阶段九十四·一 登记；**本轮（阶段一百零六）改写**：`..` 语法与 XML/XMLList 分派已落地） | 十个拦截器里 `getDescendants` 由 `p..foo`（E4X 后代访问）触发。**阶段一百零六 已补上 `..` 语法**（`Descendants` 节点 + `as_xml_descendants`/`as_xml_list_descendants`，`examples/lang-superset.as` 与 `temp/langair/cases.as` 都覆盖），但生成侧只在接收者静态类型是 `XML`/`XMLList` 时发射 XML 遍历，其余类型抛**响亮**的 `CodegenError("'..' requires an XML or XMLList value, got <kind>")` ⇒ `as_proxy_descendants`（运行时已实现且与 `adl` 编号对照通过）**仍无调用点**。`adl` 侧 `p..foo` 能跑 ⇒ 按 §1.5 是**遗留**，但今日是**响亮失败**而非静默 | 在 `emitExpr` 的 `Descendants` 分支按接收者类型分派：类实例/`Proxy`/动态对象走 `as_proxy_descendants`（`as_proxy_descendants` 已就位），数组/字符串等 AIR 也按动态属性解析的接收者另议。成本低-中，需先用 `adl` 采 `p..foo` 在「有/无 `getDescendants` 拦截器」两态下的返回 |
| `with` 接收者的**静态类型**只支持类实例 / `Object` / `*`（其余响亮报错） | 未开始（2026-10-03 阶段九十四·二 主动登记的实现边界） | `with` 的接收者在编译期分两类：**类实例**（含前向/继承链）走编译期成员解析并发射无分支 C，**`*`/`Object`/动态类/`Proxy`** 走运行时 `as_dyn_has` 判定。静态类型为 `Array`/`Vector.<T>`/`String`/`Function`/`Dictionary`/接口时 `emitWith` 直接抛 `CodegenError`（如 `with: a array-typed receiver is not supported (needs a class instance, Object or *)`）——**响亮失败，不静默降级**。`adl` 对数组/字符串接收者按元素的动态属性解析（探针 `x12 len=2`/`x13 len=1`）。**判据（§1.5）**：`adl` 能跑 ⇒ 遗留。 | 在 `emitWith` 的接收者分类里为 `Array`/`Vector`/`String` 增设运行时记录槽分支（`Array` 已自带 `_dyn` 槽表，主要是放开拦截并核对 `hasProperty` 语义）；接口接收者需先确定 `adl` 的成员查找口径 |
| `with` 作用域**不进入闭包体**（`adl` 会把 with 作用域捕获进闭包链） | 未开始（2026-10-03 阶段九十四·二 主动登记的实现边界） | 实现上用 `this.withScopes` 栈表示作用域链，而 `emit` 的匿名函数体发射会**临时清空该栈**（`anonFuncs` 循环里 save → `[]` → restore），故 `with (o) { var f = function():* { return x; } }` 里的 `x` **不会**解析到 `o`；`adl` 里闭包按创建时的作用域链捕获，`x` 解析到 `o.x`。当前是**明确的未支持**：闭包体里若含未定义名会照常报编译期错误（不静默取错值）。 | 若要落地需给「闭包创建点」保存一份 with 作用域快照并在闭包体内发射时还原；与 `x4/x5`（`this` 绑定）同一段代码路径，宜同批做 |
| `with` 体内给「对象与词法作用域都没有」的名字赋值仍是**编译期错误**（`adl` 会创建隐式全局） | 未开始（2026-10-03 阶段九十四·二 登记；**与本子集裸 `x = 1` 的既有口径一致**，非 with 特有） | `adl` 实测：`with (h) { brandNew = 1 }`（`brandNew` 既不在 `h` 上也不在词法作用域）在**非严格模式**下创建隐式全局并成功；本子集对「裸标识符赋值给未声明名」一律在编译期报 `undefined variable`（`with` 路径经 `withLexical` 归一为 `as_throw_var_not_defined` 的**读**路径，写路径仍编译期报错）。**这是子集既有缺口**，with 只是又暴露一次。 | 与「隐式全局」统一立项（顶层/函数内/with 内三处同一规则）：可在写路径回落 `as_global_set(name, v)`（模块级名字表），并核对 `adl` 对已存在全局的写与 `delete` 语义 |
| VM 抛错文案与未捕获打印格式与 `adl` **不逐字一致**（编号/异常类/时机一致） | 未开始（2026-10-03 阶段九十四·二 实测登记；**既有全局差异**，with 只是又新增 4 个发射点） | `adl 51.4.1` 实测（探针 `temp/errprobe/`）：`e.message` 对 VM 抛错是**短式**——`with (null)` → `Error #1009`、`with (undefined)` → `Error #1010`、`f()`（`f:Function = null`）→ `Error #1006`、`throw new Error("custom")` → `custom`（自定义 `Error` 保留用户文案）、`throw new TypeError("tmsg",1234)` → `tmsg`；`Error.getErrorMessage(1009)` 同样是 `Error #1009`；`String(e)`/`e.toString()` = `TypeError: Error #1009`；**未捕获**打印恰好是 `<异常类名>: <message>`（无前缀）。本子集自阶段「异常」起用带描述的长文案（`Error #1009: Cannot access a property or method of a null object reference.` 等，约 36 处发射点），未捕获走 `Uncaught exception: <message>`；`e.name` 在本子集是**编译期错误**（未声明）。**结论**：编号、异常类与抛出时机全部一致，仅**文案与打印前缀**不同，故登记为遗留而非误实现。 | 若要逐字对齐：把 VM 抛错文案统一改为短式 `Error #<id>`（`Error.getErrorMessage` 走同一表；用户文案的自定义 `Error` 保持原样），未捕获打印改为 `<类名>: <message>`，并给 `Error` 补 `name`/`getErrorMessage`。属跨切面改动（约 36 个发射点 + runtime 助手），宜单独立项、一次性对齐 + 全量 `test.ts` 回归 |
| 反射 API 的**内建类名口径**不忠实（`getQualifiedClassName`/`getQualifiedSuperclassName`） | **部分完成**（2026-10-03 阶段九十四·三 登记；**2026-10-09 阶段一百二十七 实测：①④ 已对齐/部分对齐，②③ 仍缺**） | **更正（2026-10-09 阶段一百二十七 实测，探针 `temp/pkg1d/Qn.as`）**：① **已对齐** —— `getQualifiedClassName(new Sprite())` = `flash.display::Sprite`、`getQualifiedSuperclassName(new Sprite())` = `flash.display::DisplayObjectContainer`、`qc(new BitmapData(1,1))` = `flash.display::BitmapData`、`qs(new Sprite())` = `Object`（与 `adl` 的 A1/B1/A2 逐字相同：内建类的 vtable `fqn` 槽早已是包限定名，本行 ① 属**陈旧记载**）；**同一根因下 `getDefinitionByName("flash.display.BitmapData")` 也已可用**（注册表已收录内建类，阶段一百二十七）。④ **部分对齐** —— 内建**类**作 Class 值已可（`var c:Class = Object`、`BitmapData is Class`），**接口**仍不可（`getQualifiedClassName(IDataInput)` 报 `undefined variable`）。**仍缺**：② `int`/`uint` 装箱成 number ⇒ `getQualifiedClassName(5)` 给 `"Number"` 而非 `"int"`（实测 Q3；`boxExpr` 的 tag 1，数字与整型不区分）；③ `Dictionary` 是特殊 C 类型（`kind:'dict'`）而非建模类 ⇒ `getQualifiedClassName(new Dictionary())` 给 `"Object"`、`getQualifiedSuperclassName` 给 `"Object"`（实测 Q4），而 `adl` 给 `"flash.utils::Dictionary"`/`"Object"`。`Vector.<T>` 的元素名口径见下段阶段九十四·五 证据（未变）。 | 修法：给 `int`/`uint` 单独一个 box tag（tag 引入需同步补 `as_v_typeof`/`as_v_truthy`/`as_v_eq`/`as_v_str_val`/`gc_mark_value`/写屏障，见 AGENTS.md §2.4 红线）；`dict` 需要一条「虚拟 vtable」才能参与反射。属跨切面改动，宜单独立项。 **阶段九十四·五 新增证据（`Vector` 类名已部分修复，本行剩余口径仍适用）**：`adl 51.4.1` 实测（探针 `temp/a5probe/`）——`getQualifiedClassName(Vector.<T>)` 的**元素名**对**内建类/接口**元素（`String`/`Boolean`/`Object`/`Array`/`Date`/`XML`/`XMLList`/`IEventDispatcher`）均给**包限定名**（如 `__AS3__.vec::Vector.<String>`），只有**数值**元素（`int`/`uint`/`Number`）与用户自定义类给短名/C 名；本子集已按「静态已知元素类型 + 类 fqn 查表」给出 `__AS3__.vec::Vector.<…>`（含数值元素保持 `int`/`uint` 与 `adl` 一致），但**内建类/接口元素仍是短名/C 名**（同属本行的「内建类无 fqn」根因，故不另立行）|
| 本子集的 `String` 是 **UTF-8 字节索引**（非 UTF-16 码元索引）。**阶段九十四·十六 追加**：`displayAsPassword` 的星号数也随此口径——我们「一字节一个 `*`」，`adl` 是「一个 UTF-16 码元一个 `*`」，故 CJK 密码我们显示 3 倍星号（实测 `_typewriter` 12 的 `中文ab`：adl 4 颗 / 我们 12 颗） | 未开始（既有全局口径；2026-10-03 阶段九十四·四 实测复核） | `"中".length` 我们给 **3**、`adl` 给 **1**；`charAt`/`charCodeAt`/`substr`/索引赋值全部按 **UTF-8 字节**推进（星形平面 `"😀"` 我们 `length` 为 4、`charCodeAt(0)` 为 240）。这是「C 里就是 `char*`」这一表示的**直接后果**，不是 AMF/多字节代码引入的：`writeMultiByte`/AMF 的字符串长度恰好也按 UTF-8 字节计，故这两处**反而与 `adl` 一致**。**阶段九十四·七 追加证据（可编辑文本侧）**：编辑索引（`caretIndex`/`selectionBeginIndex`/`selectionEndIndex`）同源——`adl 51.4.1` 实测 `Option+8` 提交 `"•"`（U+2022，UTF-8 三字节）后光标只 `+1`，我们 `+3`（`temp/editprobe/` 的 Ed3 差异表：`op(1,1,1) len=1` vs `(3,3,3) len=3`）。影响面 = 「对含非 ASCII 的字符串做长度/索引运算」的 AS3 代码（真实工程里主要是截断、切片与定长协议字段） | 要忠实须把 `as_str_*` 全面改成 UTF-16 码元索引：字符串本体可继续存 UTF-8（或改存 UTF-16），但**全部**索引/长度/切片/`charCodeAt`/正则/`TextField.text` 长度都要经过码元换算表 ⇒ 触及运行时字符串层与全部示例的回归面 |
| `URLStream.readObject` 要求 `Loader` **已完成**（AMF 值须已完整缓冲） | 未开始（2026-10-03 阶段九十四·四 主动登记的实现边界） | `URLStream` 的读取在本运行时是**缓冲式**：`readObject` 直接从已下载的字节缓冲解（此前也如此），若加载**在飞**（`_job != NULL`）则**响亮抛错**并说明「本子集需要 URLStream 已完成加载」。`adl` 支持流式（边下边解） | 若要流式须让 AMF 读侧与异步 IO 的增量到达打通（读侧要能「不够就等下一块」——与既有 `as_async` 的 pump 模型耦合），成本中；真实工程（`as3swf` 读远程 SWF）通常先整体下载再解析 |
| `wasm`/`web` 目标**不链接 `iconv`** ⇒ 除 `utf-8`/`unicode` 外的字符集**响亮抛错** | 未开始（2026-10-03 阶段九十四·四 主动登记的实现边界） | `build.ts` 的 `platformLinkLibs()` 只在 **darwin** 追加 `iconv`；`AS_HAVE_ICONV=0`（`__EMSCRIPTEN__`/`__wasi__`）时 `writeMultiByte`/`readMultiByte` 遇到非 UTF-8/UTF-16 字符集走 `as_throw_charset_unsupported`（**不静默降级**成 UTF-8——静默会给错字节）。工程的真实用法里 `gbk`/`gb2312`/`shift-jis`/`IBM437`/`iso-8859-*` 都有使用 ⇒ web 目标上这些路径当前**不可用** | emscripten 侧需带 `iconv` 或内置精简代码页表（GBK/Big5/Shift-JIS 三张表即可覆盖工程里的字符集），或改链 ICU/`libiconv` 到 wasm。成本中，且**只影响非 UTF-8 字符集**的 web 构建 |
| Function 值的 **`this` 绑定**（成员调用 / `with` 调用 / `Function.call(thisArg)` / `apply(thisArg)`）不在本子集 | 未开始（2026-10-03 阶段九十四·五 主动登记；该子阶段已让前两种形态**可编译**） | `adl 51.4.1` 实测（探针 `temp/a4probe/`，三行对照）：`cb.fn()` 与 `with (cb) { fn() }`（`fn` 是对象上的 Function 值）都把 `this` 绑到**接收者**（连顶层普通函数也如此：`this.tag` 读到 cb 的字段），而裸调用 `fn()` **不绑**（`this` 是全局对象）。本子集的闭包在**创建点**词法捕获 `this`（`env->this`），呼叫点无法重绑 ⇒ 两种形态「能调用，但 `this` 仍是闭包自己的」；`call`/`apply` 的 `thisArg` 同样被忽略（既有口径）。差异只在「被调函数体读写 `this`」时可观测 | 要忠实须让 `this` 改为**呼叫点决定**：给 `as_closure` 加 `env_size` 并约定「`this` 是 env 首字段」，再用「按 obj 重绑 = 拷贝 env 并替换首字段」的运行时助手重造闭包（成员调用/`with`/`call`/`apply` 四处统一走它）。属运行时表示层改动，收益窄（多数回调不读 `this`）|
| 滤镜的 **`inner`（内发光/内阴影）与 `knockout`** 未在光栅路径实现 | 未开始（2026-10-06 阶段九十五·七 实测登记） | 两者都从 SWC 记录解析出来并写进 AS3 滤镜对象（`GlowFilter.inner/knockout`、`DropShadowFilter.inner/knockout`），但 `as_render_filtered` 一律按**外**发光/外阴影画。实测 `temp/skin.swc` 烘焙闭包内 13 条记录 `inner = 0`、`knockout = 0` ⇒ **当前无像素影响**（`temp/swc_po3_detail.ts`）。AS3 侧同理（`new GlowFilter(..., true, ...)` 的内发光会被画成外发光）| Skia 侧表达「内」需另构造：把剪影取反（`SkColorFilters` 反 alpha）后模糊，再用 `Blend(kSrcIn, ...)` 与本体求交；`knockout` 还要额外的 `kDstOut` 一步。先补 `temp/filterprobe/` 的 inner/knockout 用例（adl 侧量出内发光剖面）再动手 |
| `FILTERLIST` 的 **Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix**（FilterID 3–7）未实现 | 未开始（2026-10-06 阶段九十五·七 登记） | 解析器按文档长度**跳过字节**并把 FilterID 记进 `swcBake.notes`（`src/index.ts` 打印为**响亮警告**，不静默）。实测 `temp/skin.swc` 烘焙闭包内 **0 条**。属「遇到再实现」，非当前缺陷 | 逐族补 `readSwfFilter` 的字段解析 + AS3 类（`BevelFilter`/`GradientGlowFilter`/`ConvolutionFilter`/`GradientBevelFilter`/`ColorMatrixFilter`）+ glue 映射（Convolution 可直接映 `SkImageFilters::MatrixConvolution`）|
| 滤镜模糊剖面：我们的是**高斯近似**，AIR 是**真 box** | 部分完成（2026-10-06 阶段九十五·七，已按方差匹配） | 已把「直径 `blurX` 的 box 重复 `quality` 次」折算成 `sigma = blur*sqrt(quality)/sqrt(12)`（实测钉定，取代 `blurX/3`）。但 Skia 的模糊是 3 个 box 逼近高斯：`blur6 q1` 逐点 ours **217/161/94/38/9** vs AIR **191/148/106/63/21**（AIR 在 `d ≥ 4` 为 0，我们拖尾） | 求真 box：`SkImageFilters::MatrixConvolution` 每层 36~256 抽头且**非可分离** ⇒ 大 blur 下开销显著。收益是「边缘剖面逐点一致」，当前判定**不值得**（`swc.md` §9.2 F4 已记口径）|
| `BlendMode` 中 **Skia 无法表达的模式**（subtract / invert / alpha / erase）| 未开始（2026-10-06 阶段九十五·七 登记） | `sk_paint_set_blend` 对它们**返回 0**（按 `kSrcOver` 处理）并由 `swcBake.notes` **报明**，不做近似 —— 实测本库 8 条全在可表达集合内（7×`layer`、1×`darken`）| Skia 侧可用 `SkBlendMode::kDifference`+通道运算拼 `subtract`/`invert`（`SkRuntimeEffect` 或 `SkColorFilters::Matrix`），`erase` 用 `kDstOut`。先做出可复现样本再定 |
| 未支持字符的**占位子件只有空壳**（文本无字形/初始文本、morph 无几何） | 部分完成（2026-10-06 阶段九十五·八 落地占位子件） | 子件的**存在性与个数**已与 AIR 一致（`DefineEditText`/`DefineText` 341 个 ⇒ 空 `TextField`、morph 6 个 ⇒ 空 `Shape`；`minfo` 6↔6、`fileitemskin` 5↔5）。**残留两类**：① 文本占位子件没有字形与初始文本，其 `width/height` 只按声明的 `RECT` 报（本库 341 个 `AutoSize` 全为 0 ⇒ 与 AIR 无差，但真遇到 `AutoSize = 1` 的文本就会偏）；② morph 占位子件没有几何 ⇒ 3 处 `width/height` 差（`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`、`元件124_72 c2` `11.75×11.75` vs `0×0`、`元件27_310 c0` `1×18` vs `0×0`）。证据 `temp/childfx/cmp_item2_final.txt` | ① 真做 `DefineEditText`/`DefineText` 解码（字形 + 布局 + `AutoSize` 盒，另一独立域）；② 真做 morph 两套几何 + 插值（另一独立域）。两者都不影响像素（空壳不画） |
| 子件自身 `scaleX/scaleY/rotation` 仍读 1/0（缩放只在 `transform.matrix` 里） | 部分完成（2026-10-06 阶段九十五·八：`x/y` 已修） | 平移已写进子件自身 `x/y`（实测 `vbitemskin c4` `41,23.75`、文本子件 `x = tx + RECT.xmin`，逐位相同）。但 2×2（scale/rotation/skew）**刻意**只留在 `transform.matrix`：F1 实测 AIR 的九宫格**不认** placement 拉伸（42 个被拉伸的 gridded entry 只有那样才对得上）⇒ 我们报 `scaleX = 1`，而 AIR 有时报 decomposed 值（`popchatitem c0` `1.4973`）。像素与 `transform.matrix` 读回一致，只有直接读 `child.scaleX` 的代码可观测 | 若要做到两面一致：把 2×2 也分解写进对象自身字段，并另打一个「本例不做九宫格」的位（AIR 的情形正是「矩阵在对象自身字段里但九宫格仍不触发」）。须先实测 AIR 在「timeline 放的实例 + 代码 `gotoAndStop` 后」的字段值，再动 `emitSwcPlacement` + `as_render_object` 的九宫格判据 |
| AIR 的包围盒**量化/累积口径**与我们不同（**未定案**） | 未开始（2026-10-06 阶段九十五·八 实测登记） | `temp/childfx/` 99 个子件里 33 处 `width/height` 差 `\|Δ\| ≤ 0.021px`（多数 ≤0.005，且两个方向都有）：`userskin c4` AIR `260×30` vs 我们 `260.0006×30.0001`（同一个 280×46 的矩形 × 同一个 16.16 矩阵 scale，AIR 的值看着像它自己的内部取整）、`homeskin c6` `354×580` vs `353.999×580.021`、`playskin c0` `634.3×31` vs `634.3×30.975` | 两个模型的差在 0.4 twip 以内。要定案得先量出 AIR 是「先取整再累加」还是「盒存 1/20 网格」：造一个 `adl` 探针，用已知的 2×2 / 3×2 子件组合与分数缩放逐步推。当前归为精度级，不影响像素与命中判定 |
| 子件的**类名身份**与 AIR 不同 | 未开始（2026-10-06 阶段九十五·八 登记） | AIR 对 `SymbolClass` 链接过的字符报**链接类名**（如 `popbgskin`）、对 morph 报 `MorphShape`；我们统一按基类报 `Sprite`/`Shape`（`getQualifiedClassName` 可观测）。像素与树形（个数/索引）不受影响 | 需把 `SymbolClass` 的 `{id → className}` 映射到「被内联烘焙的子件」上（现在只有导出符号注册了类）；morph 则需真建一个 `MorphShape extends Shape` 空类。成本中等，收益仅限反射面 |
| 时间轴子件的 **`name` 恒 `null`**（AIR 自动命名 `instanceN`） | 未开始（2026-10-06 阶段九十五·九 实测登记） | 多帧 sprite 的摆放记录里**没有 `Name` 字段**（SWF 只能给名字），AIR 在运行期按每个 SWF 的实例计数器自动命名（同一帧来回跳还会换号：`checkbom` 帧 2 的 Shape 由 `instance24` 变 `instance26`）；我们报 `null`。树形（个数/索引/类名/`x/y`）与像素不受影响，只有 `child.name` 可观测。证据 `temp/tlprobe/`（68 行 API 对照里该字段被显式归一化） | 要逐位一致须复刻 AIR 的命名计数器（含「同一帧重建也递增」的时机），收益仅限反射面；若做，宜与「子件类名身份」一并处理 |
| **每帧 ActionScript（`DoABC`）不执行** ⇒ 烘焙剪辑恒停在第 1 帧 | 未开始（2026-10-06 阶段九十五·九 实测登记） | 皮肤符号在 DoABC 里第 1 帧 `stop()`（实测：`adl` 新建剪辑 `isPlaying == false`，上屏跨 12 帧也不自走）。我们**读不到字节码**（§3.3 范围外）⇒ 只能让烘焙剪辑起始停在帧 1：这**正好等于 `adl` 的观测行为**，但一旦 SWF 的时间轴真有 `play()`/动画帧脚本，我们不会自走（`play()`/`gotoAndPlay()` 只能由用户代码或`_playing` 驱动）。**绝不静默**：`swcBake.notes` 已报明 79 个多帧 sprite / 514 个 op 的烘焙口径与「起始停帧」 | 属 `DoABC` 解读（反编译器或 AVM2 解释器）这一独立立项；在那之前维持「资源取自 SWC、代码来自 `.as`」的现实形态 |
| 富文本 run 之间的**空隙**用 `runs[0]` 的样式排版（AIR 用 `defaultTextFormat`） | 未开始（2026-10-06 阶段一百零三 实测登记） | `vendor/skia_glue.cc` 的 `sk_textlayout_new_runs` 建段落时用 `ps.setTextStyle(mkStyle(runs[0]))` 填「run 之间的空隙」（以及 run 未覆盖的位置），而 AIR 用**字段的 `defaultTextFormat`**。实测（`temp/metricprobe/metric6-adl.txt` vs `metric6-aot.txt` 的 `tw12-24rich` 例：默认 `_typewriter` 12，rich 只给第 2 行 24px）：AIR 第 0 行 `12/3/h15`、第 1 行 `20/6/h26`（`textHeight` 41），**我方第 0 行也是 24px**（`24/6/h30`、`textHeight` 60）—— 即空隙吃到了 run 的样式而不是默认格式 | 把段落级 `TextStyle` 改由 `defaultTextFormat` 构造（family/size/bold/italic/color/leading/align），run 只在有覆盖处生效。**先量**：AIR 的富文本空隙是否也受 `TextFormat` 的其它字段（`leading`/`align`）影响。证据同上 |
| 混合字号时**行盒整段统一**（AIR 逐行取该行字体度量） | 未开始（2026-10-06 阶段一百零三 实测登记；与上一行同为富文本面） | `sk_set_air_strut(ps, runs[leadIdx]...)` 用**单个** strut 覆盖整段（`setForceStrutHeight(true)`）⇒ 所有行共享一个行盒高度；AIR **逐行**。实测 `tw12-24rich`：AIR 两行 `h15`/`h26`，我方两行都是 `h30`（`textHeight` 60 vs AIR 41） | Skia 的 `StrutStyle` 是**段落级**的，故逐行行盒需要别的手段（逐行单独构造 `Paragraph`，或改用 `TextStyle` 的 `height`/`halfLeading` 逐 run 控制）—— 成本中，且要与既有的「按行取度量」模型（`as_tf_line_table`/`sk_textlayout_line_box`）对齐。**先量**：AIR 在混合字号且 `leading != 0` 时的逐行 height 矩阵 |
| `TextField` 多行**渲染**的居中/右对齐按**最宽行整块平移**（AIR 逐行） | 未开始（2026-10-06 阶段一百零三 实测登记；**渲染侧**，与行度量无关） | 画家走 `as_tf_align_dx`（用 `as_skia_textlayout_max_width` 算一次平移量）⇒ 多行居中时**短行**会偏（200px 字段、行宽 21.5/50 居中：AIR **逐行** x=89/75，我方两行同一个量）。本阶段的 `getLineMetrics.x` 已按 AIR **逐行**实现，**渲染未动** | 让 `as_tf_align_dx` 的消费点按行取偏移（与 `sk_textlayout_line_box` 的 `left` 同源），或在 `ParagraphStyle` 层交给 Skia 逐行对齐。**先量**：`align6-adl.txt` 只有数值，需一次出图对照像素。成本低-中 |
| `TextFormat` 的字段是**子集**：缺 `leftMargin`/`rightMargin`/`indent`/`blockIndent`/`bullet`/`display`/`tabStops`/`url`/`target` 等，且构造器只收 **6 参**（`mxmlc` 收 11 参） | 未开始（2026-10-06 阶段一百零三 探针副产物；**响亮报错**，非静默） | 现有字段只有 `font/size/color/bold/italic/underline/leading/align/kerning/letterSpacing`（`src/symbols.ts` 的 `TextFormat` classMap），ctor 六参 `(font,size,color,bold,italic,leading)`。报错样例：`undefined field 'leftMargin' on class 'TextFormat'`、`too many arguments (expected 6, got 9) for font,size,color,bold,italic,leading (constructor of TextFormat, ...)`。旁证：`mxmlc` **拒绝** `TextField.leftMargin`（说明 `leftMargin` 属 `TextFormat`），我方在读它的那一刻 `CodegenError` ⇒ 用 `leftMargin`/`blockIndent` 排版的真实工程无法移植 | 补齐字段（多数只需 C 槽 + 送进 Skia 的 `ParagraphStyle`/`TextStyle`：`indent`/`blockIndent` → `ParagraphStyle::setTextIndent`）并把 ctor 扩到 11 参（可选参数给默认值、保持既有 6 参调用兼容）。**先实测** adl 对每个字段的可观测效果再动手。成本低-中 |
| **Windows 原生后端：链接/运行已实机验证**（`vendor/d3d_glue.cc` + `window_glue.cc` + `skia_glue.cc` 的 Windows 分支 + `build-windows-deps.ps1` 的产物；编译/链接/运行三期全过） | ✅ 已完成（2026-10-10 实机 x86 编译+链接+运行全过） | **2026-10-10 在真实 Windows（clang 23.1.3 + `--target=i686-pc-windows-msvc`）上把生成的 `air-native.c` 与三个 C++ glue（`skia_glue.cc`/`window_glue.cc`/`d3d_glue.cc`）编过、链过、跑通**——修掉四类 MSVC 编译障碍（见 `docs/zh-cn/win32.md` §2.6：① skia 字体后端改 GDI（`SkTypeface_win.h` 的 `SkFontMgr_New_GDI()`）替代 CoreText-only 的 `SkFontMgr_mac_ct.h`；② window_glue 的 `#include <objc/message.h>`/`<objc/runtime.h>` 与 NSWindow border shim 全包进 `__APPLE__`、SDL2 `_m_prefetch` 冲突预定义 `__PRFCHWINTRIN_H`；③ d3d_glue 的 `g_adapter.reset(...)`（`gr_cp` 无 `operator=(T*)`）+ `GrD3DTextureResourceInfo` 改 8 参构造（补 `sampleQualityLevel=0`，原 7 参把 `GrProtected::kNo` 误当第 7 参）+ 补 `#include SkColorSpace.h`），再修三处**运行期** Windows 专属缺陷（§2.7：① 缺 `icudtl.dat` → `SkParagraph::Cluster` 越界 `ud2` SIGILL，构建期 `deploySkiaIcuData` 自动部署；② async `FileStream.openAsync(READ)` 的 mode 映射漏「`read`→`rb`」→ MSVC `_invalid_parameter` 的 `__fastfail`；③ `File.deleteDirectory` 误用 `remove()`（MSVC 只删文件不删目录）→ 改 `as_rmdir_one`/`RemoveDirectoryA`）。**最终 `air-native` 全部 demo 断言通过、开两个 D3D12 swapchain 窗口**（§5 清单 4/9/10/11 已确认，5–8 的撕裂/帧率/退出待肉眼复验） | —（已验收；剩余仅为 §5 第 5–8 行的肉眼级复验） |
| **Stage3D 的 Windows 后端**（两个前置已全部落地；剩 `air-starling-demo` 的实机运行与剔除/绕序实测） | **部分完成**（2026-10-09 阶段一百二十六 登记；2026-10-10 前置① **AGAL → HLSL 翻译器**随阶段一百三十一 落地（v0.4.104）、前置② **`vendor/stage3d_d3d.cc`** 随阶段一百三十二 落地（v0.4.105）并在 `examples/shmup-stage3d` 上实机跑通） | **已完成的两半**：① AGAL→HLSL（`AGALTranslator.translate(bytes, "hlsl")` ⇒ `target 2`，由 `ASC_S3D_HLSL` 选中，生成物过真 `D3DCompile`）；② D3D12 胶水（`vendor/stage3d_d3d.cc` 与 `stage3d_glue.mm` 同一套 `s3d_*` ABI/语义；与 2D **共用 `ID3D12Device`/命令队列**；`air-app.ts` 的 Windows 拒绝已删，改为推 `stage3d_d3d.cc` + `ASC_S3D_HLSL=1` + `d3d12`/`dxgi`/`d3dcompiler`）。**实测**：demo 开窗、281 帧 / 5 s、零 PSO/合成错误，且 `ASC_GPU_DUMP` 的 presented back buffer 里能看到 Stage3D 精灵。**仍缺（故不宣称「全用态已对齐」）**：`examples/air-starling-demo` **尚未在 Windows 目标上跑过**（127 源文件 + 完整 Starling，是后端的**通用性对照**）；**背面剔除/绕序**仍是纸面决定（`FrontCounterClockwise=FALSE` + 正高度 viewport）无 A/B 实测；mip-drop/透明混合/立方体贴图已移植并有文本钉子但**未在 D3D12 上单独复测**。详见阶段一百三十二 与 `docs/zh-cn/display3d.md` §10 | 两件事（均**验证**而非**实现**）：① 在 Windows 目标上编 + 链 + 跑 `examples/air-starling-demo`（它比 shmup 覆盖的面大得多：`setProgram` 切换、深度/模具、`drawTriangles` 多流、CubeTexture），红什么修什么；② 给背面剔除做一次一次性 A/B（同场景 `setCulling("back")` 开/关的像素对照）。**成本中**（主要是跑起来与定位差异） |
| **测试门禁不稳定**：同一套件、同一代码，不同次运行报出 **3 个不同的红**（`example: stage86.as`、`unit: emit/StringConcatFlat`、`unit: reflection/ClassValueOperand`），重跑全绿 | 未开始（2026-10-09 阶段一百二十六 **实测发现**，根因未定） | 现象：本阶段开头 `npm run test:unit` 连跑两次均 **90/92**（那两个单元组红）、`npm run test:examples` **164/165**（stage86 红）；最终 `npm test` **258/258 全绿**，其后 `npm run test:unit` 单跑/连跑 3 次、`node --test --test-name-pattern=… test/unit.ts` 单进程形态、以及各用例单独跑**全绿**。**已排除的假说**：① 陈旧产物 —— 在用例将使用的产物路径上埋一个假二进制，实测被**无条件重建并覆盖**（脚本变回 Mach-O、用例仍绿）；② `-o` 序号 —— 同一示例用 `001-` 与全量跑的 `113-` 两条路径手工跑，两条都绿；③ 断言陈旧 —— `examples/stage86.as` 的 `NativeApplication` 断言已改为 `com.example::NoSuchClass`（注释引 `adl 51.4.1` 实测）后仍曾红。**未排除**：进程/文件级并行与共享 `temp/` 下的交互。**补记（2026-10-10，阶段一百三十 全量回归实测）**：本机换成 Windows 后**没有复现**这 3 个红（它们首次观测于 macOS，也未再出现）；同一轮把**本机必然红项**逐条定位并分类完毕，且**与本行不同源**：① **5 条 CRLF 假失败**（`test/unit/platform.ts` 的 `backendparity`、`numeric.ts` 的 `noreturn`、`stage3d.ts` 的 3 条 —— 它们用 `\n` 字面量正则直接 `readFileSync` CRLF 检出的 `runtime.ts`/`stage3d_glue.mm`/`stage3d_webgl.cc`，文本归一成 LF 后**当场变绿**，而 CI 是 LF 检出）；② 2 条 **macOS 硬编码断言**（`test/unit/transport.ts` 要求 `link-paths` 结尾 `vendor/curl/lib/macos-arm64` 与 `Security`/`SystemConfiguration` frameworks）；③ 2 条 linkset 缺 `zlib.h` 的 include；④ **examples 层整体无法链接**（套件默认编译器是 `cc`，且 `src/build.ts:676` 在 win32 刻意不加 `-lz`，而每份生成 C 的 RUNTIME_PREAMBLE 都 `#include <zlib.h>` 并引用 `compress`/`uncompress`）。⇒ 结论分两半：（a）本机 Windows 上 `node test.ts` **无法全绿**，那是**已知的环境红**（可复现、可解释），**不是**门禁自身不可靠；（b）本行那 3 个 macOS 侧偶发**仍未定案**（本轮**不得**把它与 (a) 混为一谈）。| **必须先定案再修**：把这三例各自连跑 N 次（含 `npm test` 单进程与 `node --test test/unit/*.ts` 多进程两种形态）做统计，定位是否与并发/共享临时路径/产物 mtime 有关；定案前**不得**把这 3 个红当作「已修」或「无关紧要」——门禁不可靠会让真缺陷与假红混在一起（本轮**真的**发生过一次真缺陷在**全绿**下溜过：见本节「九、自查发现的真缺陷」）。三个红与本次 diff **无关**（首次观测发生在任何代码改动之前），但也不能据此静默放过。**本机口径**：跑 Windows 全量回归前须先把 LLVM 放上 PATH（`export PATH="/c/Program Files/LLVM/bin:$PATH"`，否则 `spawnSync clang ENOENT`）并把上述 9 条环境红当作已知基线 |
| `x.ns::[expr]` / `x.@[expr]` 的孩子轴按**本地名**匹配（命名空间未建模） | 未开始（2026-10-07 阶段一百零八 实测登记；**已文档化的近似**） | 本子集把自定义命名空间**编译期透明化**（限定词丢弃、前缀不进匹配），故：`<n:item>`（ns=`urn:x`）测 `x.ns::["item"]` 得 **2 = AIR**（阶段一百零八 已让前缀不阻碍本地名匹配），但 `x.item`（无限定）**也给 2**（AIR 为 **0** —— 无前缀的属性名只匹配无命名空间的节点），即「同局部名、不同 uri」无法区分。另：`Namespace` 值本身是**透明占位**（`new Namespace(prefix, uri)` 1/2 参构造器未实现，只认 0 参；`.uri`/`.prefix` 未建模），写示例只能走 `xml.namespace()` | 若要精确：给节点存 `(prefix, uri)` 与一张**作用域内命名空间表**，孩子轴比较「uri + 局部名」，`Namespace` 成为真对象（`uri`/`prefix`/2 参构造器）。**成本高**（XML 与 Namespace 两个模型都要改）；当前 away3d DAEParser 的用法（`xml.namespace()` + `ns::[expr]`）结果已与 AIR 一致，故列为「已知近似」而非阻塞项 |
| 内置类名**部分**可作 **Class 值**（`trace(BitmapData)` / `var c:Class = BitmapData` / `BitmapData is Class` 已落地；**原始包装类仍不可**） | **部分完成**（2026-10-07 阶段一百一十二 登记；**2026-10-09 阶段一百二十七 落地内建引用类型的 Class 值**） | `adl 51.4.1`：`trace(BitmapData)` ⇒ `[class BitmapData]`、`BitmapData is Class` ⇒ true、`var c:Class = Object; 5 is c` ⇒ true（`temp/pkg1/oracle/adl-pkg1.txt` C1/C4/C7/E2/E3/E8/E9 + `adl-na.txt` 的 `NA=[class NativeApplication]`）。**已落地（阶段一百二十七）**：每个内建类都进注册表并发出 `_cls` 常量、内建类名可在**值位置**解析、`is`/`as` 与字符串转换逐项对 `adl`。**仍不可**：**原始包装类**（`String`/`Number`/`int`/`uint`/`Boolean`/`Array`/`Function`/`Class`）作 Class 值 —— `var c:Class = String;` 仍是**响亮**的 `Codegen error: undefined variable 'String' at top level`（`adl` 里 `[class String]` 合法，见 `adl-pkg1.txt` C6）；它们的 `_cls` 需要先有「原始包装类的静态度量」（`int`/`uint` 还要独立 box tag，见反射口径那行）⇒ 与「`getQualifiedClassName(5)` 应给 `int`」同源，宜同批 | 先做 `int`/`uint` 的独立 box tag（反射行已列），再让 `String`/`Number`/`int`/`uint`/`Boolean`/`Array`/`Function`/`Class` 各自进注册表（`reflectFqn` 已能用 `adl` 实测：`String`/`Array`/`Boolean`/`Date`/`RegExp` 无包、`int`/`uint` 短名）。**成本中**。 |
| AGAL → MSL 翻译：临时寄存器 `vtN/ftN/op` **未初始化**即可能被读 | 未开始（2026-10-07 阶段一百一十三 读 `temp/ringdiag/dump2.log` 的 MSL 反射发现；**潜在 UB，当前未被触发**） | 生成的 MSL 是 `float4 vt0;` 一类**无初始化**声明（`float4 vtN/ftN/op`），若某程序在写之前读（AGAL 规范里临时寄存器在**程序开始**是有定义的——avmplus/驱动通常给 0），读到的是**栈垃圾** ⇒ 结果非确定。当前所有实测程序（away3d/Starling）都在用前写，故未观测到差异；**AIR 侧的初值也没有实测口径**（需要一个「读未初始化临时寄存器」的 adl 探针才能定「AIR 是 0 还是未定义」） | 先补 adl 探针（读 `vt0.xyz` 后直接输出 ⇒ 看 AIR 给什么），再决定是**零初始化**（最可能对齐，且严格更安全）还是在**首次读之前无写**时**响亮报错**（§2.5 不静默）。**成本低**（翻译器一处声明），但会改动所有 MSL 文本 ⇒ 需重跑真 GPU 验收 |
| AIR 的**数值解析/格式化极值**仍与 `adl` 有残差（语言层，窄口径） | 未开始（2026-10-08 阶段一百一十九 `tonum2` 双端探针实测；**2026-10-10 阶段一百三十四 扩证**） | **扩证（2026-10-10，阶段一百三十四）**：原记载「32 行里只剩 1 行不同」是**窄口径**——本轮把矩阵扩到 **48 行**（`temp/qfix/nfAot.as` 双端对照，adl 侧 `temp/qfix/gcadl/result13.txt`），**10 行不同**：① **打印侧**：denormal 不做最短表示（`5e-324` adl 给 `4.9406564584124654e-324`、`1e-323` 给 `9.881312916824931e-324`）；`1.7976931348623157e308` adl 给 **`1.79769313486231e+308`**（**15 位有效数字且截断**，非四舍五入、也不保证回环）；`1234567890123456789` adl 给 **`1234567890123456800`**（十进制最短 + 补零）而我们给精确 double `1234567890123456768`；② **解析侧**：`Number("1.7976931348623157e308")` adl 给 **Infinity**（17 位有效数字即溢出）；`Number("9.999999999999999")` adl 给 **10**（17 位口径的舍入）；`Number("1e100")` 差 1 ulp；③ **同值异文**（`temp/qfix/gcadl/nf3Main.as`）：内联 `String(Number("1e100"))` 给 `1e+100`，而经**变量/数组**取同一字符串再 `Number(...)` 给 `1.00000000000000e+100` —— AVM2 的**运行期** `stringToDouble` 与 mxmlc 的**编译期**常量折叠不是同一个转换器（`0.1+0.2` 亦被 mxmlc 折成 `0.3`），黑盒无法再收敛，必须按 avmplus 的 `doubleToString`/`stringToDouble` **逐字节移植**。其余 38 行（零/负零/常规指数/前导空白/`Infinity` 字面）逐字一致 | **暂缓（2026-10-10 阶段一百三十四 决定不随本轮落地，如实报明）**：原建议「优先 `%.15g`、必要时回退 `%.17g`」**与实测不符**（`1.79769313486231e+308` 是 15 位**截断**且不回环；同值异文说明两条转换链不同源）。真正要做的是移植 avmplus 的 `MathUtils::convertDoubleToString` 与 `stringToDouble` 两段算法 + 全量极值矩阵钉子，属**独立立项**（影响面是所有 `trace(number)` 文本，且要动 `as_str_from_double`/`as_str_to_number`/`as_parse_*` 三方），本轮的工作量大头在配合 `catch`/`undefined`/`parseInt` 三处**已对 `adl` 收口**的改动做全量回归，故不夹带此高风险项。证据已随本行扩写留档 |
| Function 值 **#1063 的 qname** 对接口接收者/匿名闭包/顶层函数不逐字（**错误文案**层） | 未开始（2026-10-08 阶段一百一十九实现 #1063 时实测；语义（何时抛、编号、Expected/got 数字）**已逐字一致**） | 已对齐：实例方法 `<fqn>/<m>`（`foo::Widget/m`）、静态方法 `<fqn>$/<m>`、具名函数表达式 `Function/<name>`、可选参/rest/0 参的放行规则（`arity`/`arity2`/`arity3` 探针除 qname 外全绿）。**未对齐三处**：① AIR 的类名半取自方法的**定义类** —— `var io:InteractiveObject = new Sprite(); io.dispatchEvent` 的 `adl` qname 是 `flash.events::EventDispatcher/dispatchEvent`（trait 所在类），我们是静态类型 `flash.display::InteractiveObject/dispatchEvent`（接口接收者同理：我们报 `foo::IFoo/m`、`adl` 报 `foo::Widget/m`）；② 匿名闭包 `adl` 报 `Function/<file>.as$N:anonymous`，索引是 **AVM2 内部序号**（与 embed 类名 hash 同类不可复现），我们报 `Function/anonymous`；③ **顶层/包级函数**：`adl` 报 `<EnclosingClass>/<name>`，但 `mxmlc` 不接受「包级函数值 + 主类同文件」，探针无法构造对照，故 `Function/<name>` 未经验证 | 立项：接口/父类接收者的 bound thunk 在**运行期**问对象所属类，并在该类的反射表里找方法的**定义类**（需要「方法 → 定义类」的元数据，当前 vtable 只有方法指针）；找不到时回退到静态类型名。②③ 属可复现性/可测性边界，若要收口需先在 AIR 侧找到能构造「包级函数值」的写法。**成本中**（要扩反射表），收益仅是错误文案 ⇒ 优先级低，但记录在案以免误以为已完全对齐 |
| **`Vector.<T>` 作 Class 值 / 值表达式**（`Vector.<int>`）—— `adl` 给 `[class Vector.<int>]`、`is Class` 为 true；我们**先是 parse error** | 未开始（2026-10-09 阶段一百二十七 实测发现；与上两行同族，独立立项以免与「内建类 Class 值」混淆） | `adl 51.4.1`（`temp/pkg1/AirV2.as` → `oracle/adl-v2.txt` 的 `bare=[class Vector.<int>]`，`AirV3.as` 的 `var cc:Class = Vector.<int>; cc is Class` 亦为 true）。注意**裸 `Vector` 作类型名我们报 codegen 错是吻合 AIR 的**：`mxmlc` 接受 `var vv:Vector;` 但拒绝 `var vv:Vector = new Vector.<int>();`（「从类型 `Vector.<int>` 的值到不相关类型 `Vector` 之间的隐式强制转换」）⇒ 有意义的那一半 AIR 自己就拒，故**不属缺口**（原 `is`/`as Vector.<T>` 那行的括注已随之移出）。我们：`trace("V=" + Vector.<int>)` ⇒ `Parse error at 1:26: expected '(' but found ')'`（`parser.ts` 的 `parseVectorCall` 把 `Vector.<T>` 一律当**调用**解析）；静态 `is`/`as Vector.<T>`（含动态 `*` 左值，阶段九十八·二）**不受影响** | 在 `parsePrimary` 里按「后面是否跟 `(`」分流：跟则仍是 `Vector.<T>(arrayLike)` 转换（`VectorCoerce`），不跟则是**类值**（新 AST 节点或复用 `Class` 值解析），codegen 侧按元素名映射到该 spec 的 `_cls`（`as_vec_fqn_hook` 已能给出精确元素名，可复用做 `is Class` 与字符串形式）。**成本中**，与接口 Class 值同属「名字进值位置」的分流工作，宜同批 |
| `Socket.readObject` **未实现**（**响亮**报错）—— 而 `ByteArray.readObject`/`writeObject` 与新增的 `Socket.writeObject` 均精确 | 未开始（2026-10-09 阶段一百二十七 落地 `IDataInput`/`IDataOutput` 时主动登记；**明确的未支持**，非静默降级，符合 §1.5） | socket 的读侧**不可回退**：AMF3 的一个值可能跨多个数据包，解到一半发现字节不够时无法「把已消费的字节放回去」（AIR 有内部缓冲层故能流式解），故 `Socket_readObject` 直接抛 `"Socket.readObject is not supported by this subset: the socket read side is not seekable, so an AMF3 value spanning packets cannot be parsed without consuming the bytes after it. Use Socket.readBytes() with ByteArray.readObject()."`；写侧无此问题（序列化完再交给 `Socket__write`） | 与「`URLStream.readObject` 要求 Loader 已完成」同源（缓冲式读侧）：给 AMF 读侧做**增量缓冲**（不够就等下一块 —— 与 `as_async` 的 pump 模型耦合），或按 AIR 语义在 `Socket` 内维持一个可回退的接收缓冲。成本中 |
| **web 端从文档类构造器请求 Stage3D 上下文不可用**，且 wasm 上胶水层抛的 JS 异常 AS3 `try/catch` **捕不到** | 未开始（2026-10-09 阶段一百二十八 实测发现，`temp/mipprobe/`） | web 侧的 WebGL2 上下文由 `Stage.showWindow` 创建，而文档类构造器里 `stage.stage3Ds[0].requestContext3D()` ⇒ `s3d_alloc_target` 的 `glGenFramebuffers(1, &c->fbo)` 读到未初始化的 GL 对象，抛 `TypeError: Cannot read properties of undefined (reading 'createFramebuffer')`。两层缺口：① **时机** —— AIR 允许「构造器里 requestContext3D、第一帧等 `CONTEXT3D_CREATE`」（native/adl 都能跑），web 上该形态必然失败（`Stage.showWindow` 后请求则正常）；② **可观测性** —— 该异常是 emscripten 帧里的 JS 抛错，**不经过 AS3 异常通道**，`try { requestContext3D(); } catch (e:Error) {}` 捕不到，用户只看到一个 unhandled rejection。探针因此改成「先 `showWindow`、再在第一帧请求」（三端一致）。 | 若要收口需两处：① web 侧把 Stage3D 目标的创建推迟到 canvas 就绪（`Stage.showWindow` 之后），并对「此前请求过」的 Context3D 补建（与 native 的「构造器即可请求」形态对齐）；② 给 glue 里所有会抛 JS 异常的入口加守卫，失败走 `as_throw` 而不是 JS throw（把不可捕获变成**响亮**的 AS3 错误）。**成本中**，且要保证 native 语义不变。 |
| 内建方法的**可选参数**不生效（省略即报缺参） | 未开始（2026-10-09 阶段一百二十八 探针副产物） | `_ctx.drawTriangles(_ib)`（只传索引缓冲，`Stage3D` 里最常见的单参形态）报 `Codegen error at 196:7: missing argument for parameter 'firstIndex'`；`symbols.ts` 的内建方法表里 `firstIndex`/`numTriangles` 写着 `defaultValue: null`，但发射侧不把 `null` 当「用 AIR 的默认值」⇒ `drawTriangles(ib)`/`drawTriangles(ib, 0)` 两种 AIR 合法写法里前者编译失败。同类站点需一次清点（凡 `defaultValue` 非空的内建参数）。 | 发射侧对「实参少于形参且形参有默认值」按 AIR 的默认值补齐（`drawTriangles` 的 `firstIndex=0`/`numTriangles=-1`，其余逐类按 AIR 文档）；补一条单参 `drawTriangles` 的示例/负例。**成本低-中**（要逐个核对内建默认值）。 |
| `TextField.textWidth` 的字形累进口径与 AIR 有残差 | 未开始（2026-10-09 阶段一百二十八 三端探针实测，`temp/bakeprobe/`） | 同字体同字号（`_typewriter` 12）同一串：`adl 51.4.1` 给 `14.5`，我们给 `14.40234375`（= 14 + 103/256，看着像 26.6 定点累加；`adl` 的 14.5 更接近其内部 twip/半像素口径）。与本表「`TextField.textWidth` 不含行尾空格（AIR 含）」是**同一族**（字形累进与度量舍入），但根因不同：那条是**取哪些字形**，这条是**每个字形的进位数**。像素影响仅限用 `textWidth` 做布局/换行的代码（本阶段探针的包围盒因字段宽度显式给出而不受影响）。 | 先扩大实测样本（多字号 × 多串 × 单字形）定 AIR 的进位舍入口径（是否 `ceil`/half-px/twip 取整），再决定是否复刻；与「设备字体度量表」那条同批评估更省。**成本低（测量）~中（复刻）**。 |

---

### 增强待做

> **与「遗留待开发」的区别**：上表是**欠账**（AIR 有、我们没有，或我们有但不忠实——`adl` 一跑就知道差在哪）；本表是**增益**（AIR **本来就报错、或压根不存在**，我们做出来才算增强）。判据与五条入库标准见 [`docs/zh-cn/enhancements.md`](docs/zh-cn/enhancements.md) §1/§2；原则亦见 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md) §4。
> **状态（2026-10-05 复核，v0.4.61）**：下表 **15 项**，已完成 **5 项**（WebP/BMP/ICO 解码、LTO/PGO、SVG native 半、相机 RAW/DNG、64 位整数 int64/uint64——均已端到端落地，其中前四者为**具名开关 + 默认拒绝**）、**已有** 2 项、未排期 **8 项**。增强的开启方式统一为**具名开关** `--features`（见阶段八十九·六十七与 [`enhancements.md`](docs/zh-cn/enhancements.md) §1.4）；只登记已端到端实现的开关（`svg`/`formats`/`raw`），登记未实现的开关等于「看着开了、实际没编进去」。

| 增强项 | AIR 现状 | 目标端 | 成本 | 状态 |
|--------|---------|--------|------|------|
| **SVG 运行时解码**（`Loader.load("*.svg")` → `Bitmap`） | ✗ 从不支持（`adl 51.4.1` 实测 `#2124`） | ✅ **native 已实现、opt-in**（具名开关 `--features svg`；四条解码入口全支持，含 `<text>`/相对尺寸）；web 无 svg/sksg/expat 库，不支持 | — | **已完成（八十九·六十五）** |
| **Lottie 矢量动画**（Skottie 播放 `.json`） | ✗ 无对应物 | native：`libskottie.a`+`libskresources.a` 已构建+已链接，缺播放器 API；web：需重编 | 中 | 未排期 |
| **WebP / BMP / ICO 解码** | 部分：仅 JPG/PNG/GIF（`adl` 对三者报 `#2124`） | ✅ **已实现、opt-in**（默认与 AIR **同报 `#2124`**，`--features formats` 打开后两端实测全部解码正确；`QOI` 未编入 `SkQoiCodec`，不含在内） | 两端 | **已完成（九十四·二十五，默认拒绝 + 开关）** |
| **相机 RAW / DNG 解码** | ✗（`adl` 对 `.dng` 报 `#2124`；`BitmapData.loadFile` 不存在 → `#1069`） | ✅ **已实现、opt-in**（默认与 AIR 同报 `#2124`，`--features raw` 打开后 native 四条解码入口全部解出 600×338）；web 无 piex/dng_sdk 归档 ⇒ 该开关在 wasm 上被前置拒绝 | native / web 与 AIR 同形 | **已完成（九十四·二十五，默认拒绝 + 开关）** |
| **矢量图形直接上屏**（`Shape` 走 `SkPath`） | ✗（`BitmapData` 只有位图） | 两端 | 中 | 未排期 |
| **原生着色器直通**（MSL / GLSL ES） | ✗（只有 AGAL） | 两端 | 中 | 未排期 |
| **GPU 通用计算**（Metal compute / transform feedback） | ✗ | 两端 | 高 | 未排期 |
| **无窗口 / 服务端出图** | 半（可离屏，但绑死 AIR 运行时） | 两端 | 已有（headless + `stage.render()` 出 PNG） | 已有 |
| **64 位整数**（`int64`/`uint64`） | ✗（`int`/`uint` 均 32 位） | ✅ **已实现、opt-in**：类型 + `L`/`UL` 字面量 + `int64()`/`uint64()` 转换 + 64 位算术/位运算/比较 + 独立装箱 tag；纯 C ⇒ **native/web/WASI 同一份代码同一行为**（无胶水依赖） | — | **已完成（阶段九十四·二十四）** |
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
