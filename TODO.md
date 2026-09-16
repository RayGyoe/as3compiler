# as3compiler — 分步实现路线图

> 目标：参照 TypePHP（把 PHP 编译成原生二进制的 AOT 编译器）的思路，实现一个 AS3 编译器：
> `ActionScript 源码 → 词法/语法分析 → 生成可读 C → 交给 clang/cc 编译成原生可执行文件`。
> 编译器前端只负责"翻译"，优化与机器码生成交给成熟的 C 编译器，不重复造轮子。

---

## 当前状态（v0.3.65）

已实现 AS3 可用子集（面向对象基础 + 数据与迭代 + 标准库 + 接口与类型系统 + 函数进阶 + 包/模块语法兼容 + 异常处理 + 完善与打磨已全部完成）：

> 原路线图阶段一~八已全部完成。各阶段遗留的「延后 / 难点 / 未处理」项已重新整理为
> **阶段九~十三**（见下方路线图），继续按 patch 版本推进，现已全部完成（v0.3.8 → v0.3.12）。
> 依据 [`docs/zh-cn/as3-gaps.md`](docs/zh-cn/as3-gaps.md) 的实测缺陷与 AS3 语义对齐差距报告，新增
> **阶段十四~十九**，按 P0 语义正确性 → P1 功能补齐 → P2 性能/有意简化收尾的顺序推进（v0.3.13 → v0.3.18）。
> 依据 [`docs/zh-cn/builtin-types.md`](docs/zh-cn/builtin-types.md)（对照 AIR SDK 基础类型 API 的逐类核对表），新增
> **阶段二十~二十三**，补齐 `Math` 三角/对数函数与常量、数值 `toString(radix)`/`valueOf`/静态常量、`String` 剩余方法、
> `Boolean.valueOf`/`undefined`/URI 编解码等剩余基础类型成员（v0.3.19 → …）。其中阶段二十（Math 三角/对数 + 6 常量，v0.3.19）与
> 阶段二十一（数值 `toString(radix)`/`valueOf`/静态常量，v0.3.20）、
> 阶段二十二（`String` 剩余方法，v0.3.21）、阶段二十三（`Boolean.valueOf`/`undefined`/URI 编解码，v0.3.22）已完成。
> 依据 AIR SDK [`RegExp`](https://airsdk.dev/reference/actionscript/3.0/RegExp.html) 官方参考，`RegExp`/`String.match`/`String.search` 及 `String.replace` 的正则版
> 此前仍有意延后（需正则引擎）。现新增 **阶段二十四~二十七**，攻关正则引擎（v0.3.23 → v0.3.27）。
> 实现方案：内嵌**自研 ES3 回溯正则 VM**（`RUNTIME_PREAMBLE` 内，纯 C 零依赖、字节码回溯，而非先前提议的 QuickJS libregexp——后者的 ES2020+ 正则语义与 AS3 的 ES3 语义存在漂移，直接移植会引入不匹配的命名捕获/Unicode 属性等行为）。
> AS3 正则本质是 ECMAScript 正则（ES3 语法），自研引擎语义匹配度最高，支持 `i/m/s/g/x` 五 flag、捕获组/非捕获组、反向引用、前瞻、惰性/贪婪量词。详见下方路线图与备注。
> 另依据 [`docs/zh-cn/builtin-types.md`](docs/zh-cn/builtin-types.md) §七 剩余缺口，新增**阶段二十八**：
> `Array()` / `Object()` / `Vector()` 构造器形式（含 `new Array()` / `new Object()` 构造与无 `new` 的函数式调用），现已完成（v0.3.28）。
> 依据架构演进（「单文件 `.c`」是默认形态而非铁律，第三方库走链接而非内嵌），新增**阶段二十九**：
> 构建清单 + 多目标后端（`--target native/wasm`、`-I/-L/-l/-D`、JSON 构建清单对标 TypePHP `project.yml`），现已完成（v0.3.29）。
> 依据 [`examples/air-native/`](examples/air-native/)（一个用 mxmlc/adl 编译的 AIR 原生 demo 项目，用于对照验证 as3compiler 与
> AS3 标准内置类 API 的差距），在**排除 Flash 运行时**（`flash.display.*` 显示列表 / `flash.events.*` 事件 / `flash.utils.ByteArray` 二进制运行时）后，
> 整理出可补齐的**纯逻辑内置类缺口**，新增**阶段三十~三十二**（v0.3.30 → v0.3.32，**已完成**）：
> `Array` 高阶方法（`map`/`filter`/`sort`/`reverse` + `Array.NUMERIC`）、顶层 `JSON` 类（`stringify`/`parse`）、
> `Date` 构造器重载与格式化方法（多参/epoch 构造、`Date.parse`、`toDateString`/`toUTCString`）。
>
> 依据对 [Ruffle](https://github.com/ruffle-rs/ruffle)（Adobe Flash 开源重实现，其 AS3/AVM2 事件与显示列表实现为社区公认最忠实）的评估，排除 Flash 运行时后的下一块大缺口是 **GUI 与事件系统**（`flash.events.*` 事件流 / `flash.display.*` 显示列表 / 交互命中测试）。Ruffle **不可移植、不可链接**（Rust + `gc_arena` 分代 GC + `Gc<'gc>` 生命周期，C 无对应物），但作为**语义权威参照**价值极高——故新增**阶段三十三~三十五**（v0.3.33 → v0.3.35，**已完成**），把 Ruffle 的事件流算法翻译为 C 运行时助手（`RUNTIME_PREAMBLE` 内、`as_` 前缀），渲染仍按阶段二十九走 skia/cairo 链接。语义对照与映射草案见 [`docs/zh-cn/as3-docs/mapping.md`](docs/zh-cn/as3-docs/mapping.md)，上游源码快照见同目录 `events.rs` / `interactive.rs` / `avm2_events.rs` / `event_object.rs`。
>
> 渲染后端（`flash.display.*` 的真实光栅化）另做专项调研，见 [`docs/zh-cn/skia.md`](docs/zh-cn/skia.md)：Skia 定位为**纯光栅化后端**（管「画」），与事件/视图系统（管「谁在上面、谁先响应」）**正交**，二者经 `DisplayObject.render()` 汇聚；Skia 是 C++20 库、**无 C API**，需 C++ 胶水层（`skia_glue.cc`，`extern "C"`）桥接生成的 `.c`。据此新增**阶段三十六~三十八**（v0.3.36 → v0.3.38，**代码层已完成**）：Skia 胶水层 + 构建集成 → `Shape`/`Bitmap` 渲染落地 → `TextField` 文本排版。
>
> 在离屏 PNG 渲染闭环（阶段三十六~三十八）跑通后，新增**阶段三十九**（v0.3.40）：**SDL2 窗口化后端**——
> `Stage.showWindow(width, height, title)` 把离屏 Skia surface 的像素经 `vendor/window_glue.cc` 上屏到 arm64 SDL2 窗口
> 并进入事件循环，让带 UI 的 AS3 真正编译为可弹出的原生窗口程序（而非命令行产 PNG 即退出）。窗口/输入交给 SDL2、
> 像素交给 Skia，符合「前端只翻译、窗口/像素交给成熟库链接」铁律（AGENTS.md §2.9）。详见 [`docs/zh-cn/compile.md`](docs/zh-cn/compile.md) §6。
>
> 在窗口后端（阶段三十九）落地后，新增**阶段四十**（v0.3.41）：**窗口鼠标事件桥接**——把 SDL2 的鼠标输入经 C 函数指针
> 回调转发回 AS3 事件系统（`Stage_dispatchMouse` 命中测试 + 冒泡），并支持事件后重渲染（监听器改色即时上屏），打通
> 「阶段三十三~三十五事件引擎」与「阶段三十九窗口后端」两套独立子系统。同步修复 `as_pick_hit` 对纯 `DisplayObject`
> （`Shape`/`Bitmap`）的越界读。示例 [`examples/window_click.as`](examples/window_click.as)。
>
> 在窗口后端 + 鼠标事件桥接跑通后，依据 AIR SDK [`Stage`](https://airsdk.dev/reference/actionscript/3.0/flash/display/Stage.html) 官方参考，
> 新增**阶段四十一**（目标 v0.3.42）：**`Stage` 舞台属性与常量类补齐**——落地桌面 AIR profile 可用的舞台尺寸
> （`stageWidth`/`stageHeight`/`fullScreenWidth`/`fullScreenHeight`）、渲染质量（`quality`）、背景色（`color`）、舞台对齐（`align`）、
> 缩放模式（`scaleMode`）、帧率（`frameRate`）与全屏切换（`displayState`），并新建 `StageAlign`/`StageScaleMode`/`StageQuality`/
> `StageDisplayState` 四个常量类；移动端专属与依赖未建模类型的属性明确延后。
>
> 依据 [`examples/air-native/air-native-app.xml`](examples/air-native/air-native-app.xml) 的 AIR 应用描述符，新增**阶段四十二**
> （目标 v0.3.43）：**AIR `app.xml` 解析与构建引导指令**——让 `as-aot` 解析 AIR 应用描述符的 `initialWindow` 元数据
> （`title`/`width`/`height`/`visible`），自动生成引导启动代码（`new Stage()` → `new Main()` → `addChild` → `showWindow(...)`）
> 与构建清单 JSON（`sources`/`link-libs`/`defines`），把纯 AS 的 AIR 项目一键迁移到 as-aot 编译。
>
> 为对齐 adl 与编译程序的行为差异，新增**阶段四十三**（目标 v0.3.44）：**AIR 描述符对齐**——补齐
> `--air-app` 迁移中对 `<resizable>` 与 `stageWidth/stageHeight` 时序的处理：`<resizable>false</resizable>` 通过构建清单
> `ASC_WINDOW_FIXED=1` 定义创建固定尺寸窗口（与 adl 一致，去除硬编码的 `SDL_WINDOW_RESIZABLE`）；引导代码在 `new Main()`
> 前预设 `stageWidth/stageHeight`，使 document class 构造时 `trace(stage.stageWidth, stage.stageHeight)` 返回窗口尺寸而非 `0 0`。
>
> 继续对齐 adl，新增**阶段四十四**（目标 v0.3.45）：**Retina 高清渲染与 TextField 多行滚动**——解析
> `<requestedDisplayResolution>`，`high` 时经 `ASC_DISPLAY_HIGH=1` 开 SDL `ALLOW_HIGHDPI` 并按设备倍率创建
> 物理像素 surface（消除文字被合成器拉伸的模糊）；TextField 补齐硬换行 + `wordWrap` 软换行 + `clip` 裁剪，
> `numLines`/`maxScrollV`/`scrollV` 按 AIR 视口语义落地（`scrollV = maxScrollV` 贴底），使 `Log` 的滚动日志
> 与 adl 一致。顺带修复 `sk_font()` 每次绘制重建 CoreText FontMgr 导致的多行首帧卡死。

- 类型：`int / uint / Number / Boolean / String / void / Array / Function / 类名 / 接口名`
- 字面量：整型、浮点、十六进制（`0xFF`）、字符串（单/双引号）、`true`/`false`、`null`、`Infinity`/`NaN`、数组字面量 `[...]`、对象字面量 `{ ... }`
- 表达式：算术、比较、逻辑、一元、位运算 `& | ^ ~ << >> >>>`、自增自减、三元 `?:`、`is` / `as`、数组索引 `a[i]`、属性访问 `o.x`、复合赋值 `+= -= *= /= <<= >>= >>>= &= |= ^=`
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

## ⚠️ 已发现待修复的语义问题（纳入对应阶段）

| 问题 | 位置 | 影响 | 归属阶段 |
|------|------|------|----------|
| `Number` 未初始化默认值应为 **`NaN`**（AS3 规范），当前为 `0.0` | `src/emit.ts` `defaultInit` | ~~语义红线~~ **已修复（阶段四）**：`number` 默认值改为 `NAN` | 阶段四 ✅
| 字符串拼接 `malloc` 不回收（内存泄漏） | `src/runtime.ts` `as_str_concat` | ~~教学编译器可接受~~ **已修复（阶段十三）**：字符串分配改走 4 MiB arena | 阶段十三 ✅
| `null` 赋给对象类型后，字符串比较/装箱语义未完全覆盖 | `src/emit.ts` `emitEquality` | ~~边缘 case~~ **已修复（阶段十三）**：对象 `toString` 走 `as_obj_to_str`（null → "null"），字符串 `==` 先转字符串 | 阶段十三 ✅
| `trace(Number)` / `String(Number)` 精度仅 6 位有效数字 | `src/emit.ts` `case 'number'` + `src/runtime.ts` `as_str_from_double` | ~~AS3 应为 17 位 double~~ **已修复（阶段十四）**：`%.*g` 最短往返 + `trace` 走 `as_str_from_double`，实测 `trace(1/3)` → `0.3333333333333333` | 阶段十四 ✅
| `Date.getTime()` 秒级精度（非真实毫秒时间戳） | `src/emit.ts` `Date_init`（`time(NULL)*1000`） | ~~短时延测量恒为 0~~ **已修复（阶段十四）**：改用 `gettimeofday` 真实毫秒时钟 | 阶段十四 ✅
| 模块级 `const`/`var` 对自由函数不可见 | `src/emit.ts` `emitMain` / 自由函数独立作用域 | ~~「模块常量 + 自由函数」组织方式无法编译~~ **已修复（阶段十五）**：模块级变量提升为 `g_` 前缀文件级全局变量，自由函数与 `main` 共享 | 阶段十五 ✅
| `var x;`（无类型）赋值被 C 强转截断 | `src/emit.ts` `emitVarDecl`（默认 `int`） | ~~静默产出垃圾值（比报错更危险）~~ **已修复（阶段十五）**：引用类型赋给标量抛 `CodegenError`，不再静默截断 | 阶段十五 ✅

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

- [x] **`Vector.<T>` 语法**：词法/语法支持 `Vector.<int>`、`Vector.<String>` 等泛型类型标注（含 `new Vector.<T>()` 构造）
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
- [x] **`new Vector.<T>(length, fixed)`** 带参构造：新增 `_new_sized`；字面量 `new <T>[...]` 仍延后（README 未列入）
- [ ] （后续）`splice / slice / concat / forEach / sort / filter / map`

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

### 阶段三十八：`TextField` 文本渲染（目标 v0.3.38）

补齐 GUI 的文本：`TextField` 用 Skia 的文本能力，不自研排版（`skia.md` §8）。

- [x] **`SkFont` 基础字形**：`TextField.text` 单行文本 → `SkFont`（`setEmbolden`/`setSkewX` 近似 bold/italic）+ `drawString`
- [x] **`TextFormat` 样式**：`font`/`size`/`color`/`bold`/`italic` → `SkFont`/`SkPaint`（`SkTypeface` 字体家族选择为后续子阶段）
- [ ] **`SkParagraph` 完整排版**（后续子阶段）：`wordWrap`/`multiline`/`autoSize`/`textWidth`/`textHeight`/对齐/多段落（链接 `libskparagraph.a`）

> 为控制体量，可先上 `SkFont` 单行方案，把完整排版（SkParagraph）列为后续子阶段（`skia.md` §8）。

**验收**：`TextField` 渲染文本为正确字形，`TextFormat` 样式生效；多行换行/对齐（SkParagraph）输出正确（`examples/stage38.as`）。

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

### 阶段四十四：Retina 高清渲染与 TextField 多行滚动（目标 v0.3.45）

对齐 adl 的两处可见差异：窗口文字模糊（`requestedDisplayResolution` 未处理）、Log 文本不换行不滚动
（TextField 仍是单行渲染）。**已完成（v0.3.45）**。

**差异 1：Retina 模糊 —— `<requestedDisplayResolution>high</requestedDisplayResolution>`**

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

**差异 2：TextField 不换行、不滚动**

adl 里 Log 用 `multiline + wordWrap + scrollV = maxScrollV` 做滚动日志，我们此前 `drawString` 单行直绘、
`maxScrollV` 恒返回 1，只能看到第一行。

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
- [x] 验证：`examples/air-native` 窗口内 Log 显示 Array/ByteArray/JSON 全部行、顶部 Date 段已滚出、
      底部 `=== All demos complete ===` 完整贴底

**顺带修复的性能阻塞（多行渲染暴露）**

- [x] `skia_glue.cc` 的 `sk_font()` 原先**每次调用**都 `SkFontMgr_New_CoreText` + 枚举排序全部系统字体
      （`CTFontManagerCopyAvailableFontFamilyNames`）。单行时每帧 1 次无感，多行后每帧几十次 →
      首帧卡死数十秒（lldb 栈证实卡在字体枚举）。改为 `static sk_sp<SkTypeface>` 缓存，只初始化一次；
      空闲 CPU 由 19.5% 降到 0.1%

**验收**：`examples/textflow.as` 断言 `numLines` / `maxScrollV` / `scrollV` / `appendText` / `textHeight`，
在纯 C、Skia 离屏、Skia+Window+HiDPI 三种构建下均通过；`--air-app` 产物截图为 2x 物理像素且文字清晰；
回归 53 passed / 0 failed。

**遗留**：

- [ ] `contentsScaleFactor` 只在 `render`/`showWindow` 时写入，document class 构造期读到的是初始 `1.0`
      （adl 在 stage 创建时就已知倍率）；与 `stageWidth` 同类时序问题，需把 probe 提前到 bootstrap
- [ ] 行高用 `size × 1.2` 近似（Skia 未取字体 metrics 表），`leading` 字段未建模
- [ ] 全屏时 `ASC_DISPLAY_HIGH` 的 drawable 倍率取自主屏 probe，多显示器不同倍率场景未处理
- [ ] TextField 仍不支持 `autoSize` / `hscroll` / `selectable` / HTML 文本；排版无缓存（每帧重算，demo 规模无碍）

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
| **P0（GC-1/2/3/4 全部完成）** | 五十七 | **自研精确 GC（Mark-Sweep + Shadow Stack）** | WASI 纳入后 Boehm 保守式栈扫描失效；项目已具备精确 GC 枚举基础（tag/prop 反射表/method 表）；GC-1 清零对象/数组/闭包/类实例、GC-2 清零字符串（0.85KB/s 大头）、GC-4 增量标记消除停顿、GC-3 native+wasm 双目标零泄漏零悬空验证通过 |
| **P0** | 五十八 ✅ | `flash.geom` 2D（Point/Rectangle/Matrix/ColorTransform/Transform） | 纯值类型、被 DisplayObject/Graphics/BitmapData/Matrix 几乎所有显示与几何类使用；语义简单（数值运算）风险低 |
| **P0** | 五十九 ✅ | `flash.events` 事件类补齐（TimerEvent/ProgressEvent/IOErrorEvent/ErrorEvent/DataEvent） | 纯常量类 + 少量字段；TimerEvent 被 Timer 依赖、ProgressEvent 被 Loader/URLLoader 依赖，是后续前置 |
| **P1** | 六十 ✅ | `flash.utils.Timer` | 重复定时器是真实应用基础设施；`setTimeout` 的自然升级；依赖阶段五十九的 TimerEvent |
| **P2** | 六十一 ✅ | `flash.filters`（BitmapFilter/BlurFilter/DropShadowFilter/GlowFilter） | 渲染级重活，依赖 Skia 滤镜 + `DisplayObject.filters` + `BitmapData.applyFilter`；语义差异大（cacheAsBitmap/缩放规则） |
| **P2** | 六十二 ✅ | `flash.display` 补齐（Loader/LoaderInfo/MovieClip/SimpleButton） | Loader 依赖 net.URLLoader、MovieClip 依赖帧动画，均重活 |
| **P3** | 六十三 ✅ | `flash.net`/`flash.media`/`flash.ui`（URLLoader/URLRequest/Socket/Sound/Video/Keyboard/Mouse） | 异步 + 外部资源/设备，重活且独立 |
| **P3** | 六十四 ✅ | `air.*`（Window/File/FileStream/NativeWindow/SQLConnection） | 最大命名空间，完全独立于 Flash 运行时 |

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
| **GC-3** | WASI 目标验证 + 长时间运行回归 ✅ 已完成 | 证明双目标下零泄漏、零悬空（native + wasm32-wasip1） |
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
  与 `as_vector`/闭包 env 等少量散落 malloc 暂未迁移。
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
  `reclaimed most`/`bounded`/`intact` 断言全过。

**MVP 边界（GC-1）**：舞台/显示列表/事件系统这些「常驻对象」本就是 GC 根（AS3 里从 stage 可达），
**只回收动画临时对象**（TweenLite/vars/PropTween/闭包），正好命中阶段五十六残留泄露的主体。

**验收**：
- GC-1：`examples/stage57.as` 断言长循环 `new` 大量对象后 `System.totalMemory` 不随轮次线性增长（回收生效）；
      窗口 demo 长时间运行 MEM 稳定；回归旧示例无破坏 ✅
- GC-2：字符串分配走 GC（`as_str_alloc`），`trace`/`text.text` 高频拼接后内存稳定 ✅（`examples/gc_strings.as`）
- GC-3：`--target wasm` 下同样回收；native+wasm 双目标长时间运行零悬空 ✅（`stage57.as`/`gc_strings.as`/`gc_incremental.as`/
      `gc_barrier.as` 四例双端一致，WASI SDK 34.0 + wasmtime 48.0.2；全量回归 63 passed / 0 failed）
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
- [x] **Transform**：访问 `colorTransform`/`matrix`（持恒等 Matrix/ColorTransform）；`DisplayObject.transform` 接线（Matrix 作用于 Skia canvas 变换）留待后续阶段

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

- [x] `flash.net`：**URLLoader**（`load()`/`data`/`close`，同步本地文件读取，成功派发 COMPLETE、失败派发 IOErrorEvent.IO_ERROR）、**URLRequest**（`url`/`method`/`data`/`contentType`）
- [ ] `flash.media`：**Sound**（`load`/`play`，依赖后端解码）、**SoundChannel**、**Video**（延后：音频/视频解码后端）
- [x] `flash.ui`：**Keyboard**（键码常量子集 + `isAccessible`）、**Mouse**（静态 `hide`/`show` + 只读 `cursor`/`supportsCursor`/`supportsNativeCursor`）

**验收**：`examples/stage63.as`（离屏）断言 `URLRequest` 值束与默认 `method`、`URLLoader` 同步读文件成功/失败两路事件、`Keyboard` 键码常量与 `isAccessible`、`Mouse` 静态方法。✅（69 passed / 0 failed；
`URLVariables`/`Socket`、`Sound`/`SoundChannel`/`Video`、`ContextMenu` 延后（依赖动态属性建模/网络套接字/音视频解码/原生菜单后端），
`URLLoader` 为同步本地文件读（非异步 HTTP），`data` 为 `malloc` 非 GC 跟踪，README 已注明）

#### 阶段六十四：`air.*` 桌面运行时（目标 v0.3.64 → v0.3.65）【P3】✅ 已完成

**依据**：AIR 是 Flash 之外最大的独立命名空间，完全独立于显示/事件体系，重活且工作量大，排最后。

- [ ] **Window**/**NativeWindow**（对应 `window_glue.cc` 的多窗口/原生窗口管理，延后：原生多窗口与 Stage/SDL2 单窗口模型重叠）
- [x] **File**/**FileStream**（`open`/`read`/`write`，POSIX 文件 IO；异步版本派发 ProgressEvent 未实现）/ **FileMode**（常量）
- [ ] **SQLConnection**/**SQLStatement**（依赖 SQLite 链接，延后）

**验收**：`examples/stage64.as`（离屏）断言 `File` 路径束与 `exists`/`isDirectory`/`resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory`、
`FileStream` `open`/`close`/`readUTFBytes`/`writeUTFBytes` 读写回环与只读 `position`/`bytesAvailable`、`FileMode` 常量。✅（70 passed / 0 failed；
`NativeWindow`/`Window` 与 `SQLConnection`/`SQLStatement` 延后（原生多窗口管理/SQLite 链接），`FileStream` 为同步 POSIX IO（无异步 ProgressEvent），
`File` 静态目录（`applicationDirectory` 等）未建模，README 已注明）

### 遗留待开发

| 遗留项 | 说明 | 建议 |
|--------|------|------|
| 字符串 arena 泄漏 | ✅ 已解决（GC-2）：字符串拼接/转换/`split`/`substring` 已迁入 `gc_alloc(GCT_STRING, ...)`，`gc_strings.as` 验证回收归零 | 仅剩字节缓冲（`ByteArray` grow/compress/uncompress、`BitmapData.pixels`）与 `as_vector`/闭包 env 等散落 malloc 待迁（见 [`docs/zh-cn/gc.md`](docs/zh-cn/gc.md)） |
| WASI 运行时验证（GC-3） | ✅ 已完成：native + wasm32-wasip1 双目标回归通过（WASI SDK 34.0 + wasmtime 48.0.2），`reclaimed most`/`bounded`/`intact` 断言全过 | GC 核心纯 C 可移植，平台耦合已用 `#ifdef __wasi__` 隔离（见 [`compile.md`](docs/zh-cn/compile.md) §3.3） |

---

## 备注

- 每个阶段完成后：**回归运行 `examples/` 下所有旧示例**，确保不破坏已有功能；更新 README；版本号按 patch 小版本递增（`v0.3.0 → v0.3.1 → v0.3.2 → …`），避免 minor 版本过早逼近 1.0.0。
- **阶段二、三、四为最高优先级**（决定编译器能否跑真实 AS3 程序）；阶段五到八按需推进。
- 每个新特性必须配一个 `examples/*.as` 示例 + 断言式回归，否则视为未完成（AGENTS.md DoD）。
- 实现任何新特性前，先查 [AS3 语言参考](https://airsdk.dev/reference/actionscript/3.0/) 的真实语义，尤其注意 AS3 与 C 的语义差异（`/` 恒 Number、字符串装箱、`Number` 默认 NaN 等），把差异写进注释再编码。
- 阶段十四~十九依据 [`docs/zh-cn/as3-gaps.md`](docs/zh-cn/as3-gaps.md)（缺陷与 AS3 语义对齐差距报告）规划：P0 语义错误优先（阶段十四/十五）→ P1 功能补齐（阶段十六~十八）→ P2 性能/有意简化收尾（阶段十九）；修复每项后同步更新该报告状态与 README「当前限制」章节，并升 patch 版本号（AGENTS.md §2.7）。
- 阶段二十~二十三依据 [`docs/zh-cn/builtin-types.md`](docs/zh-cn/builtin-types.md)（对照 AIR SDK 基础类型 API 的逐类核对表）规划：补齐 `Math` 三角/对数函数与常量、数值 `toString(radix)`/`valueOf`/静态常量、`String` 剩余方法、`Boolean.valueOf`/`undefined`/URI 编解码，现已全部完成（v0.3.19 → v0.3.22）。
- 阶段二十四~二十七依据 AIR SDK [`RegExp`](https://airsdk.dev/reference/actionscript/3.0/RegExp.html) 官方参考规划：攻关正则引擎。最终方案为**内嵌自研 ES3 回溯正则 VM**（`RUNTIME_PREAMBLE` 内纯 C 零依赖）——AS3 正则本质是 ECMAScript 正则（ES3 语法），回溯 VM 语义匹配度最高，支持 `i/m/s/g/x` 五 flag、捕获/非捕获组、反向引用、前瞻、惰性/贪婪量词、字符类与转义；`\w \d \s` 内嵌 ASCII 表（正好是 ES3 语义），`g` 由 `exec`/`test` 适配层状态机处理，`x`（extended）flag 由 `as_re_x_strip` 前端预处理剥离空白与 `#` 注释。正则引擎直接内嵌于生成的 `.c` 前导（不引入 QuickJS libregexp——其 ES2020+ 语义与 ES3 正则存在漂移，自研回溯 VM 才能精确匹配 ES3 语义）。`isXMLName` 仍有意延后（需 XML/E4X 支持，非正则范畴）。
- 阶段三十三~三十五依据对 [Ruffle](https://github.com/ruffle-rs/ruffle) 事件/显示列表源码的评估规划：攻关 GUI 与事件系统。Ruffle **不可移植、不可链接**（Rust + `gc_arena` GC + `Gc<'gc>`，C 无对应物），但作为**语义权威参照**价值极高。语义对照与「事件流 → C 运行时助手」映射草案见 [`docs/zh-cn/as3-docs/mapping.md`](docs/zh-cn/as3-docs/mapping.md)，上游源码快照（`events.rs` / `interactive.rs` / `avm2_events.rs` / `event_object.rs` / `event.rs` / `event_dispatcher.rs`）存于同目录 `as3-docs/`。渲染仍按阶段二十九走 skia/cairo 链接（「前端不重复造轮子」铁律），Ruffle 补齐的是「事件流/命中测试/焦点」的**语义**那一半，不贡献像素。
- 阶段三十六~三十八依据 [`docs/zh-cn/skia.md`](docs/zh-cn/skia.md) 的渲染后端专项调研规划：攻关 `flash.display.*` 的真实光栅化。Skia 定位为**纯光栅化后端**（管「画」），与事件/视图系统（管「谁在上面、谁先响应」）**正交**，二者经 `DisplayObject.render()` 汇聚。关键结论：Skia 是 C++20 库、**无 C API**，需 C++ 胶水层（`skia_glue.cc`）桥接生成的 `.c`；首期用离屏 CPU raster（输出 PNG）跑通最小闭环，再逐步落地 `Shape`/`Bitmap`/`TextField`（SkParagraph）。
- 阶段三十九依据 [`docs/zh-cn/compile.md`](docs/zh-cn/compile.md) §6（窗口化 SDL2 后端）与 [`docs/zh-cn/skia.md`](docs/zh-cn/skia.md) §6.3 落地：把离屏 CPU raster 升级为真实原生窗口。窗口/输入交给 SDL2（arm64 静态库，`vendor/sdl2/arm64/libSDL2.a`），Skia 负责像素，`vendor/window_glue.cc` 负责窗口 + 事件循环 + 上屏；`Stage.showWindow` 经 `ASC_USE_WINDOW` 条件编译，未定义时 no-op（纯 C 构建不受影响）。
- 阶段四十把 SDL2 鼠标输入桥接回 AS3 事件系统：`window_glue.cc` 用函数指针回调（`on_mouse`/`on_redraw`）解耦（胶水层不知道生成的 C 函数名），`emit.ts` 发射 `ASC_window_on_mouse`（→ `Stage_dispatchMouse` 命中测试 + 冒泡）与 `ASC_window_on_redraw`（重新光栅化 + 上屏）。同步修复 `as_pick_hit` 对纯 `DisplayObject`（`Shape`/`Bitmap`）的越界读（改用 `as_is` 类型判定）。
- 阶段四十三~四十四是「对齐 adl」的连续小阶段，依据 adl 实测行为与 [AIR Stage 参考](https://airsdk.dev/reference/actionscript/3.0/flash/display/Stage.html) / [TextField 参考](https://airsdk.dev/reference/actionscript/3.0/flash/text/TextField.html)：四十三补 `<resizable>` 与 stage 尺寸时序；四十四补 `<requestedDisplayResolution>` 的 Retina 渲染（`SDL_WINDOW_ALLOW_HIGHDPI` + `SDL_GL_GetDrawableSize` probe，surface 按物理像素创建）与 TextField 多行排版（`numLines`/`maxScrollV` 视口数学、`wordWrap` 按空格贪心断行、`clip` 裁剪）。排版层刻意只记录 `(start,len)` 偏移而不复制字符串——AS3 字符串由 `as_alloc` bump allocator 分配，逐行复制后 `free()` 会命中非 malloc 指针。
- 阶段四十五修复窗口缩放控制与滚轮：变形根因是 `SDL_RenderCopy` 的 dst=NULL 拉伸 + 未处理 `SDL_WINDOWEVENT_SIZE_CHANGED`；滚轮根因是 `emit.ts` 漏传 `on_wheel`。落地 `scaleMode`/`align` 的真实画布变换与 `Stage_dispatchWheel`（adl 实测 1 delta = 1 行）。adl 探针改存 `tools/adl-probe/`（用 `System.output()` 直写 stdout 取回语义，见阶段四十四探针）。
