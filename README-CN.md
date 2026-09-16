# A native AOT compiler for ActionScript 3

把 ActionScript 3 源码**提前编译（AOT）成原生机器码**，生成原生可执行文件——同时保留你熟悉的 AS3 语法。

设计思路：编译器前端只负责
`词法 → 语法 → 生成可读的 C`，优化与机器码生成全部交给成熟的 C 编译器，不重复造轮子。

---

## 🎬 Video

<div align="center">
https://github.com/user-attachments/assets/cb2bed00-aba9-4005-b769-26c162110fdb
</div>

---

## 编译管线

```
ActionScript 源码 (.as)
        │  lexer.ts      词法分析（token）
        ▼
        │  parser.ts     递归下降解析（AST）
        ▼
        │  codegen.ts    语义 + C 代码生成
        ▼
       C 源码 (.c)
        │  构建编排 src/build.ts
        │  （构建清单 JSON + -I/-L/-l/-D + --target）
        ▼
  ┌──────┴───────┐
  │ native        │  cc/clang -O2 -lm            → 原生可执行（Mach-O / ELF / PE）
  │ wasm          │  clang --target=wasm32-wasip1  → WASI .wasm
  └──────────────┘
```

「生成单个可读 `.c`」是**默认形态**（构建简单、便于阅读），不是禁止链接第三方库的铁律：
实现图形（skia/cairo/SDL）等重活时，正确做法是把成熟库**链接**进来（`-lskia`），而不是自研光栅化。
参见「构建与链接」与 AGENTS.md §2.9。

## 运行

安装（得到 `as-aot` 命令）：`npm install -g as3compiler`（或本地开发 `npm link`）。
未安装时可用 `node src/index.ts ...` 或 `npm run compile -- ...` 等价调用。

依赖：Node ≥ 22.6（原生支持直接运行 `.ts`，无需编译步骤）、系统装有 `cc`/`clang`；
`--target wasm` 需 WASI SDK（`WASI_SDK_HOME` 指向 SDK 根，或自带 wasm32 后端的 LLVM clang），
且运行产物需支持异常处理提案的运行时（wasmtime/wasmer，见 `docs/zh-cn/compile.md` §2）。

```bash
# 编译（默认输出到输入同名的无扩展名文件，并保留生成的 .c 便于阅读）
as-aot examples/hello.as

# 编译并运行
as-aot examples/fib.as --run

# 指定输出名 / 指定 C 编译器
as-aot examples/class.as -o build/class --cc clang --run
```

## 构建与链接

> 完整编译说明（命令行参数、构建清单 JSON、多目标后端、WASI 工具链）见
> [`compile.md`](docs/zh-cn/compile.md)。

支持多目标与链接第三方库：

```bash
# WASI 目标（需装 WASI SDK 或自带 wasm32 后端的 clang）
as-aot examples/hello.as --target wasm

# 链接第三方库（skia/cairo/SDL 等）：include 路径 / 库路径 / 库 / 宏定义
as-aot app.as -I vendor/include -L vendor/lib -l skia -D USE_SKIA=1

# 构建清单（JSON，路径相对清单目录解析）
as-aot app.as --manifest examples/skia-link.build.example.json

# 导出顶层函数给 JS 直调（默认 WASI 命令模块只导出 _start）
as-aot examples/wasm-native/fib.as --target wasm --export fib

# 声明式导出：用 [WasmExport] 元数据标记函数/静态方法，自动导出并生成 .exports.json
as-aot examples/wasm-native/export-meta.as --target wasm

# 只生成 C 并打印编译命令，不真正编译（无工具链时验证命令）
as-aot examples/hello.as --target wasm --dry
```

构建清单（JSON）字段：`target`（`native`/`wasm`）、`c-compiler`、`opt`、`sources`（额外 C/C++ 源）、
`include-paths`、`link-libs`、`link-paths`、`defines`、`objects`（预编译 `.o`）、`exports`（导出到 .wasm 导出表的 C 符号）。CLI 参数覆盖清单同名字段。
路径类字段相对清单文件所在目录解析。示例见
[`examples/skia-link.build.example.json`](examples/skia-link.build.example.json)。

## 支持的语言子集

| 类别 | 支持 |
|------|------|
| 类型 | `int`、`uint`、`Number`、`Boolean`、`String`、`void`、`Array`、`Vector.<T>`、`Function`、`RegExp`、`Class`（类引用）、`Dictionary`（对象引用键关联表）、`*`（无类型 → 动态 `any` 装箱）、类名（对象类型）、接口名 |
| 字面量 | 整型、浮点、十六进制（`0xFF`）、字符串（单/双引号）、`true`/`false`、`null`、`Infinity`/`NaN`、数组字面量 `[...]`、对象字面量 `{ ... }`、正则字面量 `/pattern/flags` |
| 表达式 | 算术 `+ - * / %`、比较 `== != < <= > >=`、逻辑 `&& \|\| !`、一元 `- + ! ~`、位运算 `& \| ^ << >> >>>`、自增 `++ --`（前后缀）、三元 `?:`、类型判断 `is` / 转换 `as`、强制转换语法 `Type(expr)`、`typeof`、`delete`、成员存在 `in`、数组索引 `a[i]`、属性访问 `o.x`、复合赋值 `+= -= *= /= <<= >>= >>>= &= \|= ^=` |
| 语句 | 变量声明（含多变量 `var a:T, b:T, c:*;`）、表达式语句、`if/else`、`while`、`do-while`、`for`、`for-in`（数组索引 / 动态对象键 / `Dictionary` 对象引用键）、`for-each-in`、`switch/case/default`、`break`、`continue`、标签语句 `label: while(...){ break label; }`、`return`、`throw`、`try/catch/finally`、块；函数内 `arguments`（按需生成的形式参数数组） |
| 函数 | 带类型参数与返回类型的自由函数；可选参数与默认参数 `function f(a:int, b:int = 1)`；rest 参数 `function f(...args:Array)`；`Function` 类型与函数值（匿名函数表达式、函数作参数/返回值）；闭包（匿名函数捕获外层局部变量，捕获变量堆分配逃逸） |
| 类 | 字段 + 方法 + 有参构造 + `new` + `this` + 继承 `extends` + `override` 重写（虚表派发） + `super` 调用（含无显式 `super` 时的隐式无参 `super()`）+ 访问修饰符 `public/private/protected/internal` + `static` 字段/方法 + `const` 常量 + `get/set` 访问器 + `final` 类/方法 + 静态方法作为 `Function` 值（`ClassName.method` 或裸标识符）+ 动态类实例化 `new (expr as Class)()`（经类引用的无参工厂） |
| 接口 | `interface` 声明 + `implements` 实现（接口 vtable 派发）+ `is`/`as` 接口类型检查 |
| 包/模块 | 多文件编译（多个 `.as` 合并为一个编译单元）；`package` 命名空间隔离（C 标识符前缀）；`import` 跨文件/跨包短名解析；`internal` 同包可见（跨包拒绝） |
| 根类 | `Object` 内置根类：所有类的隐式基类，`toString()` 返回运行时类名；`Error` 内置错误类型：`new Error(message)`、`.message` 属性；内置错误子类 `TypeError`/`RangeError`/`ArgumentError`/`SyntaxError`；内置 `Date` 类（毫秒时间戳 + 日历访问器）；`flash.events` 事件系统 `Event`/`EventDispatcher`/`MouseEvent`/`KeyboardEvent`/`FocusEvent`/`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent`（`addEventListener`/`dispatchEvent` 捕获→目标→冒泡三阶段、`preventDefault`/`stopPropagation`/`stopImmediatePropagation`；`Event` 补全 `CANCEL`/`CLEAR`/`CLOSE`/`CONNECT`/`COPY`/`CUT`/`DEACTIVATE`/`EXIT_FRAME`/`FRAME_CONSTRUCTED`/`FULLSCREEN`/`ID3`/`INIT`/`MOUSE_LEAVE`/`OPEN`/`PASTE`/`RENDER`/`SCROLL`/`SELECT`/`SOUND_COMPLETE`/`TAB_*`/`UNLOAD` 常量，事件子类（阶段五十九）`TimerEvent`（`TIMER`/`TIMER_COMPLETE`）、`ProgressEvent`（`PROGRESS` + `bytesLoaded`/`bytesTotal`）、`ErrorEvent`（`ERROR` + `text`）、`IOErrorEvent`（`IO_ERROR`，继承 `text`）、`DataEvent`（`DATA` + `data`））；`flash.display` 显示列表 `DisplayObject`/`InteractiveObject`/`DisplayObjectContainer`/`Stage`/`Sprite`/`Shape`/`Graphics`/`Bitmap`/`BitmapData`（层级/坐标/`addChild`（触发 `addedToStage`）/`removeChild`/命中测试/递归渲染，`as_render_object` 按 `is` 子类型链分派，用户 `Sprite` 子类可作容器；`Stage` 舞台属性 `stageWidth`/`stageHeight`/`fullScreenWidth`/`fullScreenHeight`/`displayState`/`quality`/`color`/`align`/`scaleMode`/`frameRate` 与布尔开关，常量类 `StageAlign`/`StageScaleMode`/`StageQuality`/`StageDisplayState`）；`flash.text` 文本 `TextField`/`TextFormat`（单行 SkFont 渲染 + `background`/`backgroundColor` 背景填充）；`flash.utils.Dictionary`（`new Dictionary(weakKeys)`：按**对象引用**作键的关联表，支持 `in`/`delete`/`for-in`，弱引用参数接受但不建模，键强持有程序生命周期）；`flash.utils.Timer`（阶段六十）：重复定时器，继承 `EventDispatcher`，构造 `Timer(delay, repeatCount=0)`，`delay` setter 校验负值/非有限抛 `RangeError`；`repeatCount` setter 不校验（`int` 截断，负值保留、`NaN`→0）、`currentCount`/`running` 只读，`start`/`stop`/`reset`；每 interval 派发 `TimerEvent.TIMER`、`repeatCount>0` 耗尽派发 `TimerEvent.TIMER_COMPLETE`、`repeatCount=0` 无限重复；由帧循环 `as_timer_tick` 驱动（离屏用 `tickTimers()` 手动泵，WASI 秒级退化）；`flash.geom` 2D 几何（阶段五十八）`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform`（`Point` 静态 `distance`/`interpolate`/`polar` 与实例 `add`/`subtract`/`offset`/`normalize`/`setTo`/`copyFrom`/`clone`/`equals`/`toString`；`Rectangle` 只读 `top`/`bottom`/`left`/`right` 与 `intersection`/`union`/`contains`/`containsPoint`/`containsRect`/`intersects`/`equals`/`inflate`/`offset`/`clone`/`setEmpty`/`isEmpty`/`toString`；`Matrix` `identity`/`translate`/`scale`/`rotate`/`concat`/`invert`/`transformPoint`/`deltaTransformPoint`/`createBox`/`createGradientBox`；`ColorTransform` 8 通道 + `concat`；`Transform` 持恒等 `matrix`/`colorTransform`）；`flash.filters` 滤镜（阶段六十一）`BitmapFilter`（抽象基类，`clone()`）/`BlurFilter`（`blurX`/`blurY`/`quality` + `clone`）/`DropShadowFilter`（`distance`/`angle`/`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout`/`hideObject` + `clone`）/`GlowFilter`（`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout` + `clone`）+ 常量类 `BitmapFilterQuality`（`LOW`/`MEDIUM`/`HIGH`）；`DisplayObject.filters` 读写（`Array` 存取）；`BitmapData.applyFilter`（`BlurFilter` 经可分离盒式模糊落地，`DropShadowFilter`/`GlowFilter` 光栅化延后抛错）；`flash.display` 补齐（阶段六十二）`MovieClip`（`currentFrame`/`totalFrames` + `play`/`stop`/`gotoAndPlay`/`gotoAndStop`，帧循环驱动，`currentFrame` 越界回绕到 1，`totalFrames` 可写以模拟多帧时间轴）/`SimpleButton`（`upState`/`overState`/`downState`/`hitTestState` 四状态引用）/`Loader`（`content`/`contentLoaderInfo` + `load(url)` 同步模拟派发 INIT/COMPLETE）/`LoaderInfo`（`bytesLoaded`/`bytesTotal`/`url` + `COMPLETE`/`INIT`/`OPEN`/`UNLOAD`/`PROGRESS`/`IO_ERROR` 常量）；`flash.net`/`flash.ui`（阶段六十三）`URLRequest`（`url`/`method`/`data`/`contentType`，`method` 默认 `"GET"`）/`URLLoader`（`data`/`dataFormat` + `load(request)`/`close`，继承 `EventDispatcher`，同步读取本地文件，成功派发 `COMPLETE`、失败派发 `IO_ERROR`）/`Keyboard`（静态键码常量表 `A`~`Z`/`NUMBER_0`~`NUMBER_9`/`SPACE`/`ENTER`/`TAB`/`ESCAPE`/`BACKSPACE`/`DELETE`/`SHIFT`/`CONTROL`/`LEFT`/`RIGHT`/`UP`/`DOWN` + 只读 `isAccessible`）/`Mouse`（静态 `hide`/`show` + 只读 `cursor`/`supportsCursor`/`supportsNativeCursor`）；`flash.filesystem`（阶段六十四）`File`（`nativePath` + 只读属性 `url`（`file://` 形式）/`exists`/`isDirectory`（getter，经 `stat()`）+ `resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory` + 静态只读 `applicationStorageDirectory`，POSIX `stat`/`mkdir`/`remove`）/`FileStream`（`open`/`close`/`readUTFBytes`/`writeUTFBytes` + 只读 `position`/`bytesAvailable`，`FILE*` 句柄为不透明 `void*` 非 GC 跟踪）/`FileMode`（`READ`/`WRITE`/`APPEND`/`UPDATE` 常量） |
| 内建 | `trace(...)`；`Array` 方法 `push/pop/shift/unshift/splice/slice/indexOf/join/concat`、`.length`；`String` 方法 `charAt/charCodeAt/indexOf/lastIndexOf/substring/substr/slice/split/match/search/replace/toUpperCase/toLowerCase/concat/localeCompare/valueOf/toLocaleLowerCase/toLocaleUpperCase/startsWith/endsWith`、静态 `String.fromCharCode`、`.length`；`Number`/`int`/`uint` 方法 `toFixed/toExponential/toPrecision/toString(radix)/valueOf`、`Number` 静态常量 `MAX_VALUE/MIN_VALUE/NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY`、`int`/`uint` 静态常量 `MAX_VALUE/MIN_VALUE`；`Math` 常量 `PI/E/LN10/LN2/LOG10E/LOG2E/SQRT1_2/SQRT2` 与方法 `abs/floor/ceil/round/sqrt/pow/min/max/random/sin/cos/tan/asin/acos/atan/atan2/exp/log`；全局函数 `parseInt/parseFloat/isNaN/isFinite`；`flash.utils.getTimer()`（自进程启动以来的毫秒数，非 Unix 时间戳，60Hz 帧循环计时用）；`flash.utils.setTimeout(closure, delay)` / `flash.utils.clearTimeout(id)`（调度/取消一次性函数回调，`delay` 毫秒后由帧循环触发，返回 `uint` 定时器 id；回调经函数值闭包绑定）；`flash.system.System` 内存统计（`totalMemory`(`uint`)/`totalMemoryNumber`(`Number`)/`freeMemory`(`Number`)/`privateMemory`(`Number`) 四个纯静态只读属性：`totalMemory` 为运行时自管堆已用字节（超 4 GiB 返回 0），`totalMemoryNumber` 同值不 clamp，`freeMemory` 为 arena 已申请未用缝隙，`privateMemory` 为真实进程常驻内存（macOS `mach_task_basic_info`/Linux `getrusage`×1024/Windows `GetProcessMemoryInfo`/WASI 退化为 `totalMemory`）；`flash.system.Capabilities`（阶段六十五）：`final` 静态只读类（与 `System` 同范式、无实例化类）—— `version`（AS-AOT 版本，编译期从 package.json 注入，版本号单一来源）、`os`（`Mac OS`/`Windows`/`WASI`/`Linux` 条件编译）、`cpuArchitecture`（`ARM`/`x86`）、`cpuAddressSize`（`32`/`64`）、`supports64BitProcesses`/`supports32BitProcesses`（由地址宽度推得）、`playerType`（`"Desktop"`）、`manufacturer`（`"AS-AOT"`）、`isDebugger`（`false`）、`touchscreenType`（`"none"`）、`language`（locale 派生 ISO 639-1）、`screenResolutionX`/`screenResolutionY`（SDL2 主屏尺寸，headless 为 0）、`screenDPI`（`72.0` 回退，无逐屏 DPI 查询）、`screenColor`（`"color"`）、`pixelAspectRatio`（`1.0`）、`hasAudio`（`true`）；类型转换 `String(x)/Number(x)/Boolean(x)/int(x)/uint(x)`；内建构造器调用 `Array(...)/Object(...)/Vector.<T>(...)`（无 `new` 亦可，等价 `new`；`Object(x)` 有参恒等返回、primitive 装箱为 `any`）；URI 编解码 `encodeURI/decodeURI/encodeURIComponent/decodeURIComponent/escape/unescape`；`Boolean` 方法 `toString/valueOf`；`undefined` 全局常量；对象字面量 `{}`（字符串键关联数组）；顶层 `JSON` 类 `stringify`/`parse`（递归序列化/解析对象、数组与基础类型）；异常 `throw`/`try`/`catch`/`finally`（基于 `setjmp`/`longjmp`）；`Date` 类（构造器重载 `new Date()`/`new Date(ms)`/`new Date(year,month,day,...)`/`new Date(str)`，静态 `Date.parse(str)`，访问器 `getTime/getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds`，格式化 `toDateString()`/`toUTCString()`）；`RegExp` 类（正则字面量 `/pattern/flags` 与 `new RegExp(pattern, flags)`：`test`/`exec`/`source`/`global`/`ignoreCase`/`multiline`/`dotall`/`extended`/`lastIndex`，支持 `i/m/s/g/x` 五 flag；内嵌自研 ES3 回溯正则 VM：捕获/非捕获组、反向引用、前瞻、惰性/贪婪量词、字符类与 `\d\w\s` 转义；`String.match/search/replace` 正则版：`match` 返回捕获数组或 `null`、`search` 返回首匹配位置、`replace` 支持 `$1`~`$9`/`$&`/`$$` 替换及函数替换 `repl:Function`）；`Vector.<T>` 类型安全数组 `push/pop/join/indexOf`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`、索引读写与越界检查；`Array.sortOn(field, options)`（按对象字段排序，支持 `Array.NUMERIC`(16)/`Array.DESCENDING`(2) 及 `NUMERIC | DESCENDING` 组合）、`Array.concat` 接受动态元素；`Function.apply(thisArg, argsArray)`（从数组取参调用函数值）；动态方法调用（`Object` 类型或 `any` 接收者未命中静态签名时，经方法反射表 `as_dyn_call` 按名派发到类方法） |
| 语义 | `/` 恒为 `Number`（AS3 语义）；`+` 遇字符串自动拼接并装箱；`trace`/`String(Number)` 输出 IEEE-754 double 的**最短 17 位表示**（`trace(1/3)` → `0.3333333333333333`）；`Date.getTime()` 返回真实毫秒时间戳（`gettimeofday`）；`is`/`as` 基于 vtable 的 `super` 链做运行时类型检查；数组元素为动态类型（`as_value` 装箱），异构元素自动处理；异常经 `setjmp`/`longjmp` 跳转到最近的活跃 `catch` 处理，`finally` 始终执行；位运算按 AS3 语义转换到 32 位整数（`>>>` 为无符号右移）；`Object`/`any` 类型的动态索引/属性访问经反射表（字段偏移 + 方法表）落到真实类实例，未命中时回退记录槽（`obj[key]`/`obj.prop`/`obj[key] = v`/`obj.prop = v`）；条件上下文（`if`/`while`/`?:`/`&&`/`||`/`!`）对 `any` 值按 AS3 truthiness 判定（`null`/`undefined`/空串为假，非零数与非空对象为真） |

## 类型 → C 映射

| AS3 | C |
|-----|---|
| `int` | `int` |
| `uint` | `unsigned int` |
| `Number` | `double` |
| `Boolean` | `bool` |
| `String` | `char*`（拼接/装箱走 `as_str_*` 运行时助手） |
| `Array` | `as_array*`（动态扩容、异构元素装箱为 `as_value`；元素类型为动态 `*`） |
| `Vector.<T>` | `as_vector_<T>*`（按元素类型 `T` 单态化：连续元素数组 `T* data` + `length`/`capacity`；索引越界 `throw RangeError`；编译期强制元素类型；`push/pop/join/indexOf`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`） |
| `Function` | `as_fn`（指向闭包记录 `{ thunk, env }` 的指针；每个被用作值的函数生成一个 thunk，把装箱参数列表解箱、调用带类型的实现、再把结果装箱回 `as_value`；捕获外层局部变量的闭包额外生成环境 struct + 堆分配构造器，env 指向该环境） |
| 对象字面量 `{}` | `as_object*`（字符串键关联数组，属性值装箱为 `as_value`） |
| `RegExp` | `RegExp*`（`{ vtable; as_regex* compiled; source; flags; lastIndex; global/ignoreCase/multiline/dotall/extended }`；`compiled` 为内嵌回溯 VM 的编译产物，构造时编译，编译错误抛 `SyntaxError`） |
| 类 `Foo` | `struct Foo` + `Foo*`；首成员为 `Foo_vtable*`（虚表：`super` 链 + 方法函数指针），字段平铺（父类字段在前）；方法编译为 `Ret Foo_method(void* this, ...)`，调用走 `obj->vtable->method(obj, ...)`；命名空间内的类用包前缀命名（`foo.bar.Baz` → `foo_bar_Baz`） |
| 接口 `I` | `struct I`（引用对：`void* obj` + `I_vtable* vt`）；方法派发走 `ref.vt->method(ref.obj, ...)`；每个实现类生成接口 vtable 实例 `Class_I_vt` |
| `Error` / 异常 | `struct Error`（`vtable` + `message`）；`throw` 归一化为 `as_throw(Error*)`，异常状态存于全局 `as_exception`，跳转栈用 `setjmp`/`longjmp`；`TypeError`/`RangeError`/`ArgumentError` 为 `Error` 子类（同布局、独立 vtable），`catch (e:Type)` 用 `as_is` 沿 `super` 链精确匹配 |
| `static` 成员 | 类级字段/方法：文件作用域全局 `Class_field` / `Class_method(...)`（无 `this` 接收者） |
| `trace` | 按类型生成 `printf` 格式串；对象打印为类名（`as_obj_to_str` 读 vtable 的 `name`） |

## 语义权威来源

实现新特性前，先查权威规范确认真实 AS3 语义，杜绝凭记忆或 C 行为反推。完整的分级清单、
红线对照与决策分歧见 [`docs/zh-cn/as3-semantics.md`](docs/zh-cn/as3-semantics.md)。核心来源：

- **ES4 draft 规范**（语法/类型系统/强制转换正典）：`http://archives.ecma-international.org/2006/misc/es4lang-Jan06.pdf`
- **AVM2 Overview**（对象模型 trait/slot/分派语义，只借语义不生成 ABC）：`http://hackipedia.org/raw/File%20formats/Containers/F4V,%20Flash%20Video/ActionScript%20Virtual%20Machine%202%20(AVM2)%20Overview%20by%20Adobe%20(2007-05).pdf`
- **avmplus 源码**（规范含糊时的裁决）：`https://github.com/adobe/avmplus`
- **AS3 语言参考**（标准库 surface）：`https://airsdk.dev/reference/actionscript/3.0/`
- **ECMA-262 第 3 版**（数值转换 `ToInt32`/`NaN`/`Infinity` 出处）

## 当前限制（v0.3.68，刻意保持极简）

- 正则引擎为自研 ES3 回溯 VM，**字节/ASCII 语义**（`\w`/`\d`/`\s` 仅覆盖 ASCII，非 UTF-8 Unicode 感知）；`exec`/`match` 非全局捕获组未参与者返回 `undefined`。
- WASI 目标下 `Date` 分辨率退化为秒级（`gettimeofday` 是 POSIX 专属，WASI 以 `time(NULL)` 退化，见 `as_now_ms()`）。
- 静态字段的非常量初始化器（对象字面量 `{}`、`new X()`、函数值 `ClassName.method` 等）因 C 禁止非常量静态初始化，改为在 `main()` 入口按类声明顺序执行（各在声明类的静态上下文中求值）；实例字段初始化器在构造器内 `super()` 之后执行。
- `throw` 归一化为 `Error`（字符串/基本类型会被包装为 `Error`）；`catch (e:Type)` 按 `super` 链精确匹配（`TypeError`/`RangeError`/`ArgumentError` 已实现，可被基类 `catch (e:Error)` 兜底捕获）。
- `finally` 在正常完成或抛异常时均执行；但 `return`/`break`/`continue` 从 `try` 块直接跳出时不会执行 `finally`（`setjmp`/`longjmp` 只拦截异常，不拦截普通控制流转移）。
- 未捕获异常打印到 `stderr` 并以非零码退出。
- 位运算将操作数转换到 32 位整数（`int`/`uint`），移位计数按 AS3 语义对 32 取模；`>>` 对有符号整数做算术右移。
- 内存管理（阶段五十七，精确 GC）：运行时实现**自研 Mark-Sweep 垃圾回收**——`gc_alloc` 用分段堆（每段 1 MiB）+ free-list（first-fit + 切分 + 合扇）+ 每个对象前带 `gc_header` 三色位域；触发点为 **`Stage_dispatchFrame` 帧边界安全点**（所有帧回调已返回，根集合只剩永久根，故无需 shadow stack）调用 `gc_step()` 增量推进，另有 `System.gc()` 手动触发 `gc_collect()` 停机回收。根集合 = 永久根（静态字段、模块变量、`ASC_win_stage`、ENTER_FRAME 事件注册表、定时器）+ 内建根（`as_exception`）。标记沿对象类型（数组/对象/Dictionary/闭包/类实例/字符串）分派 `gc_scan`，类实例经 vtable→props 反射表沿 super 链标记（tag 3/6/7 分派 `gc_mark_ptr`/`gc_mark_value`）；未达对象扫回 free-list 复用。**GC-2** 已将字符串（拼接、转换、`split`/`substring` 等）迁入 GC 堆（`as_str_alloc`），彻底清零字符串 arena 泄漏；仅剩字节缓冲（`ByteArray` grow/compress/uncompress、`BitmapData.pixels`）与少量散落 malloc（闭包 env、`as_vector`）仍走 arena/`malloc`。**GC-4** 引入**增量标记**：三色状态机 + 显式灰栈 + Dijkstra 写屏障（`gc_write_barrier`/`gc_write_barrier_value`），`gc_step()` 每帧分摊固定预算（`gc_inc.budget`，默认 500）的 mark/sweep 切片，单帧停顿从 O(堆) 降到 O(budget)，消除「堆增大→长冻结」的线性退化；mark 期新对象直接 BLACK（`gc_new` 侧链表，sweep 后归位），写屏障注入 setter（`as_array_set`/`as_object_set`/`as_dict_set`/`as_dyn_set`）、运行时构造器与用户直接字段写（`o.field = v`）。**GC-3** 已完成 WASI 双目标验证：`--target wasm`（`wasm32-wasip1`）下 GC-1/2/4 的四个断言示例（`stage57`/`gc_strings`/`gc_incremental`/`gc_barrier`）与 native 行为一致——回收归零、对象图零悬空、增量标记内存有界。`System.totalMemory`/`freeMemory` 计入 GC 堆已用/总量，`System.gc()` 返回后 `totalMemory` 回落到基准（示例 `examples/gc_strings.as`：100000 次字符串拼接后回收归零；`examples/gc_incremental.as`：800 帧增量回收内存有界；`examples/gc_barrier.as`：10200 个类实例直接字段写后 `System.gc()` 后对象链完整无悬空）；`privateMemory` 是真实进程 RSS，可与 Activity Monitor 对照。
- `flash.system.Capabilities` 为静态只读子集：`version` 返回 AS-AOT 编译器版本（非 Adobe 的 `"MAC 9,0,0,0"` 平台串），`manufacturer` 为 `"AS-AOT"`（非 Adobe），`isDebugger` 恒 `false`，`screenResolutionX`/`screenResolutionY`/`screenDPI` 在 headless 构建（无 SDL2 窗口后端）下报 `0`/`72`。延后（依赖平台/后端）：`languages`、`serverString`、`hasMP3`/`hasTLS`/`hasVideoEncoder`/`hasEmbeddedVideo`/`hasStreamingAudio`/`hasStreamingVideo`、`maxLevelIDC`、`hasAccessibility`/`hasIME`/`avHardwareDisable`/`localFileReadDisable`/`isEmbeddedInAcrobat` 与 `hasMultiChannelAudio(type)`。
- 命名空间以 C 标识符前缀实现（`foo.bar.Baz` → `foo_bar_Baz`），`package` 内类与 `import` 可跨文件解析；短名 → 全限定名采用全局唯一映射，不同包下同名类暂不支持（后定义覆盖前定义）；`dynamic`/`abstract` 等类修饰符解析后忽略。
- 闭包采用快照捕获：匿名函数捕获外层局部变量的当前值到堆分配的环境（闭包逃逸后仍存活），但闭包内对捕获变量的修改不影响外层局部变量（完整引用语义/变量提升延后）。多层嵌套闭包捕获暂未支持。
- 函数值（`Function`）调用采用统一 `as_fn` 约定；当被用作值的函数带默认参数或 rest 参数时，需在调用点传满完整参数列表（默认值/rest 仅在直接带类型调用时于调用点填充）。
- `Array` 元素为动态类型（`as_value` 装箱）；多维数组通过嵌套 `as_v_obj` 指针自然支持，但越界读取返回 `null`（AS3 应为 `undefined`，本子集以 `null` 近似）。
- 对象字面量 `{}` 为字符串键关联数组的简化版（未落到 `Object` 根类的动态属性，仍映射 `as_object*`）；`o.x` 读不存在的键返回 `null`。
- `new Object()` / `Object()` 与对象字面量 `{}` 同样映射 `as_object*`（`record` 动态关联数组），非 vtable 类实例。`Object(x)` 有参时对象类型恒等返回原值，primitive（`int`/`uint`/`Number`/`Boolean`/`String`）装箱为 `as_value` 返回 `any`——本项目未建模 `Number`/`String`/`Boolean` wrapper 类，故不能伪装成 `Object` 指针。
- `is`/`as` 对接口类型采用编译期静态类型判断（基于实现类的 `implements` 列表），不跨运行时的动态派发边界。
- `is`/`as` 基本类型（`int`/`uint`/`Number`/`Boolean`/`String`）已支持：静态标量编译期求值；`*`（`any` 装箱）按 `as_value` tag 运行时判定（但 `int`/`uint`/`Number` 在装箱时不区分，均映射 number tag，README 已注明）。
- `switch` 判别式若为 `int`/`uint` 则生成原生 C `switch`（支持 fall-through 与 `break`）；其余类型（如 `String`）降级为 `if/else` 严格相等链（无 fall-through）。`case` 值需为常量。
- `var x;`（无类型无初值）默认按 `int` 处理；变量类型一经推断不再变化。引用类型（`String`/对象/数组等）隐式赋给 `int`/`uint`/`Number`/`Boolean` 标量时会抛 `CodegenError`（不再静默截断为垃圾值）；显式 `int(x)`/`Number(x)` 等转换函数仍需显式调用。
- 渲染后端（`Shape`/`Graphics`/`Bitmap`/`TextField` 的真实光栅化）经 C++ 胶水层 `vendor/skia_glue.cc`（`extern "C"` 桥接生成的 C）链接 Skia 实现。Skia 为 C++17 库、**无 C API**；本项目用 Aseprite 预编译静态库（m124）就位于 `vendor/skia/`（`include/` + `lib/`，含全部传递依赖），以构建清单 `defines: ["ASC_USE_SKIA=1"]` 启用（详见 `docs/zh-cn/skia.md` §6.1）；未链接 Skia 时 `Stage.render()` 退化为 no-op、`TextField.textWidth` 返回 0（纯 C stub），`BitmapData.getPixel/setPixel` 等纯 C 路径照常可用。首期后端为离屏 CPU raster（→ PNG）；`beginGradientFill` 暂只支持两色线性渐变，多 stop/矩阵/多 `beginFill` 组为后续子阶段（见 `docs/zh-cn/skia.md`）。`TextField` 已支持**多行排版**（阶段四十四）：硬换行 + `wordWrap` 按空格贪心软换行（宽度用 Skia 实测）+ `clip` 裁剪 + `numLines`/`maxScrollV`/`scrollV` 视口滚动（`scrollV = maxScrollV` 贴底），行高按 `size × 1.2` 近似；`autoSize`/`hscroll`/HTML 文本与 `SkParagraph` 富文本排版仍未做（示例 `examples/textflow.as`）。窗口化后端：`Stage.showWindow(w, h, title)` 将离屏 surface 像素经 `vendor/window_glue.cc` 上屏到 SDL2 窗口并进入事件循环（`defines: ["ASC_USE_WINDOW=1"]`，链接 arm64 `libSDL2.a`，见 `docs/zh-cn/compile.md` §6）；鼠标输入经函数指针回调桥接回 AS3 事件系统（`Stage_dispatchMouse` 命中测试 + 冒泡 + 事件后重渲染，示例 `examples/window_click.as`）；未定义 `ASC_USE_WINDOW` 时 `showWindow` 退化为 no-op。Retina 高清：`defines: ["ASC_DISPLAY_HIGH=1"]` 开 SDL `ALLOW_HIGHDPI` 并按设备倍率创建物理像素 surface（`Stage.contentsScaleFactor` 返回实测倍率），否则 surface 被合成器拉伸 2x 导致文字模糊；窗口拖到不同倍率显示器时，glue 层用 `SDL_GetWindowSizeInPixels` 读权威物理像素、按「物理/逻辑」算倍率并下传 resize 回调重建 surface，且任一尺寸 ≤0 时跳过本次 resize（否则画面放大/裁切或 stage 尺寸归零）。**帧率跟随显示器刷新率（VSync）**：`SDL_RenderSetVSync` 开启垂直同步，`SDL_RenderPresent` 阻塞到显示器刷新周期使帧间隔均匀——50Hz 外接屏呈现 50fps、120Hz 主屏呈现 120fps，动画靠 delta time 保持速度正确；这是 50Hz 屏上唯一「看起来不卡」的物理正确做法（关 VSync 追 120fps 会产生 120 vs 50 拍频抖动导致卡顿）。**窗口缩放控制与滚轮（阶段四十五）**：`scaleMode`/`align` 落地为真实画布变换（`noScale` 内容固定不缩放、`showAll`/`noBorder` 等比、`exactFit` 非等比；align 八值分配剩余空间），窗口 `resize` 经 `SDL_WINDOWEVENT_SIZE_CHANGED` 重建物理像素 surface 并重渲染（不再拉伸变形），`noScale` 下 `stageWidth/Height` 跟随真实窗口尺寸并派发 `Event.RESIZE`；鼠标滚轮经 `SDL_MOUSEWHEEL` → `Stage_dispatchWheel` 自动滚动 TextField（adl 实测 1 delta = 1 行、`scrollV -= delta`、钳制 `[1,maxScrollV]`）并派发冒泡 `MouseEvent.MOUSE_WHEEL`（示例 `examples/wheel.as`）。**帧循环与 ENTER_FRAME（阶段四十六）**：事件循环每帧经 `on_frame` 回调 → `Stage_dispatchFrame` 广播 `Event.ENTER_FRAME`（非冒泡，按全局注册表派发给每个注册了监听器的对象——含不在显示列表上的对象，如 GreenSock 驱动补间的私有静态 `Shape`；事件对象跨对象复用零分配），驱动 FPS 计数器等帧驱动逻辑（示例 `examples/frame.as`）。
- `Stage` 舞台属性（阶段四十一）落地为字段存储 + getter/setter：`stageWidth`/`stageHeight`/`fullScreenWidth`/`fullScreenHeight`/`displayState`/`quality`/`color`/`align`/`scaleMode`/`frameRate` 及布尔开关可读/写/读回；`color` 实际映射窗口背景色（`sk_canvas_clear`），`displayState = FULL_SCREEN` 在 `showWindow` 时经 `SDL_SetWindowFullscreen` 全屏，`fullScreenWidth/Height` 经 `SDL_GetCurrentDisplayMode` 返回显示器分辨率（macOS 为逻辑点）。`frameRate` 已落地为事件循环帧率 pacing（阶段四十七）：设置后按 `1000/frameRate` ms 每帧驱动 `ENTER_FRAME`，若显式帧率高于窗口所在显示器刷新率则封顶到刷新率（避免 120 vs 50 拍频抖动）；未设置（`<=0`）时读显示器刷新率（vsync 节奏），读不到则回退 120Hz；`quality` 的实际抗锯齿效果留待后续；`align`/`scaleMode` 与窗口 `resize` 已落地（阶段四十五，见下）。
- `--air-app <app.xml>` 指令（阶段四十二~四十四）解析 AIR 应用描述符（`src/air-app.ts` 手写极小 XML 解析器），自动生成引导代码 + 构建清单（递归扫描 `src/**/*.as` + 链接 Skia/SDL2），配合 `--main-class`（缺省扫描 `src/**/Main.as` 推断）一条命令编链出窗口化可执行；对齐 adl 行为：`<resizable>false</resizable>` → `ASC_WINDOW_FIXED=1` 固定尺寸窗口，`<requestedDisplayResolution>high</requestedDisplayResolution>` → `ASC_DISPLAY_HIGH=1` Retina 原生分辨率渲染，引导代码在 `new Main()` 前预设 `stageWidth/stageHeight`（构造时 `trace` 返回窗口尺寸而非 `0 0`）。
- `flash.geom`（阶段五十八）中 `Point`/`Rectangle`/`Matrix`/`ColorTransform` 为纯 `double` 字段束（无 GC 指针）；`Transform` 持 `Matrix`/`ColorTransform` 引用并参与 GC 标记。`Transform` 目前只是值/引用访问器，**尚未接线到 `DisplayObject.transform`**（Matrix 作用于 Skia canvas 变换留待后续阶段）；`Rectangle.union` 这类与 C 关键字同名的 AS3 方法在 C 标识符中被追加 `_`（`union` → `union_`），AS3 侧拼写不变。
- `flash.filters`（阶段六十一）滤镜类为纯字段束（`BitmapFilter` 抽象基类 + `BlurFilter`/`DropShadowFilter`/`GlowFilter` + `BitmapFilterQuality` 常量类），`clone()` 返回新实例拷贝全部字段；`alpha` 字段按真实 AIR 量化为 8-bit 定点数 `floor(alpha*255)/255`（`0.75→191/255≈0.74902`）；`DisplayObject.filters` 为普通 `Array` 读写，`render()` 后端现已通过 Skia image filter 把 `BlurFilter`/`DropShadowFilter`/外发光 `GlowFilter` 应用到显示对象子树（模糊/投影/光晕真正改变上屏像素，`sigma ≈ blurX/3` 近似盒式模糊直径；`inner`/`knockout`/`hideObject` 等高级参数暂未区分）；`BitmapData.applyFilter` 仅 `BlurFilter` 经可分离盒式模糊落地（`quality` 控制盒式模糊轮数），`DropShadowFilter`/`GlowFilter` 的 `applyFilter` 光栅化仍延后（调用抛 `Error`）。
- `flash.display` 补齐（阶段六十二）为无时间轴符号/无异步加载的最小模型：`MovieClip` 的 `totalFrames` 在 AIR 中为只读（由符号时间轴决定），本子集无符号系统故建模为**可写**字段（默认 1，setter 校验 ≥1）以模拟多帧时间轴；`currentFrame` 默认 0（真实 AIR 无帧 MovieClip 语义），帧推进由 `as_mc_*` 帧池驱动（离屏用 `tickMovieClips()` 手动泵、窗口构建由帧循环驱动），到 `totalFrames` 后回绕到 1（循环时间轴）。`SimpleButton` 仅建模四状态引用（`upState`/`overState`/`downState`/`hitTestState`），鼠标悬停/按压的**视觉状态切换与命中测试重定向**仍延后（自身作为叶子按边界命中）。`Loader.load(url)` 为**同步模拟**：记录 URL 到 `contentLoaderInfo` 并派发 INIT/COMPLETE，真实异步加载（`URLRequest`/`URLLoader`）属阶段六十三；`Loader.content` 始终为 `null`（未真实加载内容）。
- `flash.net`/`flash.ui`（阶段六十三）为无网络/音视频后端的最小模型：`URLLoader.load(request)` 把 URL 当作**本地文件系统路径**做同步整文件读取（POSIX `fopen`/`fread`，WASI 同样可用），成功派发 `Event.COMPLETE`、失败派发 `IOErrorEvent.IO_ERROR`；`data` 持有文件文本（`malloc` 分配，**非 GC 跟踪**，与 `ByteArray.pixels` 同类，程序生命周期不回收）；真实异步 HTTP/Socket 加载未实现。`URLVariables`/`Socket`、`Sound`/`SoundChannel`/`Video`、`ContextMenu` 全部**延后**（分别依赖动态属性建模、网络套接字、音频/视频解码与原生菜单后端）。`Keyboard` 仅映射键码常量子集（字母/数字/常用控制键/方向键）；`Mouse.cursor` 为只读（`"auto"`，真实 AIR 默认），SDL 光标 API 未接线，`hide`/`show` 仅切换内部可见性标志。
- `flash.filesystem`（阶段六十四）为 POSIX 文件 IO 最小模型：`File` 把路径当普通字符串束（`nativePath` + 只读 `url` = `file://` 前缀），`exists`/`isDirectory` 为**只读属性**（getter，`f.exists` 而非 `f.exists()`）经 `stat()`、`createDirectory` 经 `mkdir`（支持逐级创建）、`deleteFile`/`deleteDirectory` 经 `remove()`（空目录）；静态只读 `applicationStorageDirectory` 返回应用可写存储目录（本子集映射到 CWD）。`FileStream` 持 `FILE*` 句柄（不透明 `void*` 字段，非 GC 跟踪），`open` 把 AIR `FileMode`（`read`/`write`/`append`/`update`）映射到 C `fopen` 模式；`readUTFBytes` 返回 `malloc` 缓冲（非 GC 跟踪，同 `URLLoader.data`）。`position`/`bytesAvailable` 为只读（`ftell`/`fseek`）。`NativeWindow`/`Window`（原生多窗口）与 `SQLConnection`/`SQLStatement`（SQLite 链接）全部**延后**。

## 示例

- `examples/hello.as` — 表达式、字符串拼接、`trace`、`if/else`
- `examples/fib.as` — 函数、`while`、`for`、递归边界
- `examples/class.as` — 类、字段、方法、`new`、`this`
- `examples/features.as` — 除法/取模、比较、逻辑、自增、字符串相等
- `examples/syntax.as` — `uint`、十六进制、`do-while`、`switch`、三元、`break`/`continue`、`Infinity`/`NaN`
- `examples/ctor.as` — 有参构造函数、`new` 传参
- `examples/inherit.as` — 继承 `extends`、字段/方法继承
- `examples/override.as` — `override` 方法重写、多态动态派发
- `examples/super.as` — 构造函数 `super(...)`、方法 `super.method(...)`
- `examples/visibility.as` — 访问修饰符 `public/private/protected`
- `examples/isas.as` — `is` / `as` 类型判断与转换
- `examples/array.as` — 数组字面量/索引/`push`/`pop`/`splice`/`for-in`/多维数组/异构元素
- `examples/object.as` — 对象字面量 `{}`（关联数组）、属性读写、嵌套对象
- `examples/stdlib.as` — `String` 方法、`Math`、全局函数、类型转换、对象可读 `trace`
- `examples/oop2.as` — `const`/`static` 字段与方法/`get`/`set` 访问器
- `examples/interface.as` — `interface`/`implements`/接口 `is`/`as`/接口方法派发
- `examples/stage4.as` — 阶段四综合：接口 + 静态成员 + 访问器 + `final` + `Object.toString` + `Number` 默认 `NaN`
- `examples/stage5.as` — 阶段五综合：默认参数、rest 参数、`Function` 值与匿名函数
- `examples/stage6.as` — 阶段六综合：`package`/`import` 语法兼容层（命名空间扁平化）
- `examples/stage7.as` — 阶段七综合：`throw`/`try`/`catch`/`finally`、内建 `Error`、异常重抛与嵌套
- `examples/stage8.as` — 阶段八综合：位运算 `& | ^ ~ << >> >>>` 及复合赋值、标签语句 `break label`/`continue label`
- `examples/stage9.as` — 阶段九综合：`Error` 子类 `TypeError`/`RangeError`/`ArgumentError` 精确 `catch` 与冒泡、`Date` 类日历访问器
- `examples/stage12/` — 阶段十二综合（多文件）：`package foo` 跨文件定义类、`import` 后实例化调用、同包 `internal` 可见
- `examples/stage10.as` — 阶段十综合：`Vector.<T>` 类型安全数组（`push`/`pop`/索引读写/`.length`）与越界 `RangeError`
- `examples/stage11.as` — 阶段十一综合：闭包（捕获外层局部变量、逃逸、计数器独立计数、带参闭包）
- `examples/stage13.as` — 阶段十三综合：`null` 装箱语义（对象 null 的字符串拼接/比较）、字符串 arena 分配压力测试
- `examples/stage14.as` — 阶段十四综合：`trace`/`String(Number)` 17 位 double 最短表示、`Date.getTime()` 毫秒时钟
- `examples/stage15.as` — 阶段十五综合：模块级 `const`/`var` 对自由函数可见（文件级作用域）、无类型变量截断防护、模块级变量顺序初始化
- `examples/stage16.as` — 阶段十六综合：`String.replace`（字符串版，替换首个）、`Number.toFixed`/`toExponential`/`toPrecision`（含指数去前导零）
- `examples/stage17.as` — 阶段十七综合：`Vector.<T>` 的 `join`/`indexOf`/`.length` 赋值（收缩）/带参构造 `new Vector.<int>(3, true)`
- `examples/stage18.as` — 阶段十八综合：基本类型 `is`/`as`（静态标量编译期求值 + `any` 运行时 tag 判定）
- `examples/stage19.as` — 阶段十九综合：`Array`/`Vector` join 优化（memcpy 指针推进）、有意简化项验证（闭包快照、数组越界 null）
- `examples/stage21.as` — 阶段二十一综合：`Number`/`int`/`uint` 的 `toString(radix)`（2~36 进制）、`valueOf`、`MAX_VALUE`/`MIN_VALUE`/`NaN`/无穷静态常量
- `examples/stage22.as` — 阶段二十二综合：`String` 的 `concat`/`fromCharCode`/`localeCompare`/`valueOf`/`toLocaleLowerCase`/`toLocaleUpperCase`/`startsWith`/`endsWith`
- `examples/stage23.as` — 阶段二十三综合：`Boolean.toString`/`valueOf`、`undefined` 常量、URI 编解码 `encodeURI`/`decodeURI`/`encodeURIComponent`/`decodeURIComponent`/`escape`/`unescape`
- `examples/regexp.as` — 阶段二十四~二十七综合：正则字面量/`new RegExp`、`test`/`exec`/捕获组/`lastIndex` 全局状态机、`String.match/search/replace` 正则版（`$1`/`$&`/`repl:Function`）、字符类/量词/反向引用/前瞻、`i/m/s/x` flag、无效正则抛 `SyntaxError`
- `examples/stage28.as` — 阶段二十八综合：`Array()`/`Object()`/`Vector()` 构造器形式（`new Array()`/`new Object()` 构造 + 无 `new` 函数式调用、`Object(x)` 有参恒等/装箱语义）
- `examples/stage33.as` — 阶段三十三综合：`Event`/`EventDispatcher` 事件三阶段分发（capture→target→bubble、`stopPropagation`/`stopImmediatePropagation`/`clone`）
- `examples/stage34.as` — 阶段三十四综合：显示列表 `DisplayObject`/`DisplayObjectContainer`/`Stage`/`Sprite`（`addChild`/`removeChild`/`getChildAt`/`getChildByName`/`contains`/`setChildIndex`/`root`/`stage`）
- `examples/stage35.as` — 阶段三十五综合：交互事件与命中测试（inside-out 分发、`mouseChildren=false` 父吸收、`visible=false` 跳过、`MouseEvent`/`KeyboardEvent`/`FocusEvent`）
- `examples/stage36.as` — 阶段三十六综合：Skia 最小闭环（一个 `Shape` → `Stage.render` 离屏 PNG，无 Skia 时 no-op）
- `examples/stage37.as` — 阶段三十七综合：`Shape`/`Graphics`（`beginFill`/`beginGradientFill`/`drawRect`/`drawCircle`）、`Bitmap`/`BitmapData`（`getPixel`/`setPixel`）、嵌套 `Sprite` + `rotation`/`alpha` 递归渲染
- `examples/stage38.as` — 阶段三十八综合：`TextField`/`TextFormat`（单行 SkFont 文本渲染、`textWidth`/`textHeight`）
- `examples/air-native/` — 多文件综合（`boot.as` + `src/demo/*.as`）：Air 式文档类 `Main`（`Sprite` 子类）+ 隐式 `super()`/`addedToStage` 事件驱动 + `Date`/`Array`/`ByteArray`/`JSON` 四块演示 + 阶段五十八~六十四测试用例（`Geometry`/`Events`/`Timer`/`FilterDisplay`/`NetUi`/`File` 六个 `*Demos.run()` 断言 + `FilterDisplayDemos.visualize()` 舞台滤镜可视化）+ `TweenDemo`（GreenSock `TweenLite` 补间动画，窗口模式下经 ENTER_FRAME 驱动 `Shape` 位移），链 Skia 渲染输出 `air-native.png`
- `examples/window.as` — 阶段三十九综合：`Stage.showWindow` 窗口化（`Shape` 蓝色矩形 + `TextField` 文字 → 离屏 Skia → SDL2 上屏 + 事件循环），用 `examples/window.build.example.json` 链接 Skia + arm64 SDL2
- `examples/window_click.as` — 阶段四十：窗口内真实鼠标点击 → AS3 事件分派（`mouseDown`/`mouseUp`/`click` + 冒泡 + 点击变色重渲染），用 `examples/window_click.build.example.json`
- `examples/textflow.as` — 阶段四十四：TextField 多行排版断言（`numLines`/`maxScrollV`/`scrollV` 视口数学、`wordWrap` 软换行、`appendText`/`textHeight`），纯 C / Skia / Skia+窗口三种构建下均成立
- `examples/wheel.as` — 阶段四十五：鼠标滚轮语义（1 delta = 1 行、`scrollV -= delta`、钳制 `[1,maxScrollV]`、未命中不派发），纯 C 回归
- `examples/frame.as` — 阶段四十六：ENTER_FRAME 广播语义（stage/子对象/孙对象深度优先派发），纯 C 回归
- `examples/stage41.as` — 阶段四十一综合：`Stage` 舞台属性读回（`stageWidth`/`stageHeight`/`color`/`quality`/`align`/`scaleMode`/`displayState`/`frameRate`/布尔开关）+ 四个常量类，离屏（纳入回归）
- `examples/stage65.as` — 阶段六十五：`flash.system.Capabilities` 环境能力查询（`version`（编译期从 package.json 注入的 AS-AOT 版本）、`os`/`cpuArchitecture` 条件编译常量、`cpuAddressSize` + `supports64BitProcesses`/`supports32BitProcesses`、固定桌面值 `playerType`/`manufacturer`/`isDebugger`/`touchscreenType`/`screenColor`/`pixelAspectRatio`/`hasAudio`、locale 派生 `language`、`screenResolutionX`/`screenResolutionY`/`screenDPI`），离屏（纳入回归）
- `examples/stage64.as` — 阶段六十四：`flash.filesystem`（`File` 路径束 + `exists`/`isDirectory`/`resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory`、`FileStream` `open`/`close`/`readUTFBytes`/`writeUTFBytes` 读写回环 + 只读 `position`/`bytesAvailable`、`FileMode` 常量），离屏（纳入回归）
- `examples/stage63.as` — 阶段六十三：`flash.net`/`flash.ui`（`URLRequest` 值束 + 默认 `method`、`URLLoader` 同步本地文件读取成功/失败派发 `COMPLETE`/`IO_ERROR`、`Keyboard` 键码常量子集 + `isAccessible`、`Mouse` 静态 `hide`/`show` + 只读 `cursor`），离屏（纳入回归）
- `examples/stage62.as` — 阶段六十二：`flash.display` 补齐（`MovieClip` 帧时间轴 `play`/`stop`/`gotoAndPlay`/`gotoAndStop` + 回绕、`SimpleButton` 四状态、`Loader`/`LoaderInfo` 同步 `load` + 常量），离屏（纳入回归）
- `examples/stage61.as` — 阶段六十一：`flash.filters` 滤镜（`BitmapFilter`/`BlurFilter`/`DropShadowFilter`/`GlowFilter` 默认值/自定义构造/`clone`/`is` 判定、`BitmapFilterQuality` 常量、`DisplayObject.filters` 读写回环、`BitmapData.applyFilter` 盒式模糊与延后光栅化抛错），离屏（纳入回归）
- `examples/stage60.as` — 阶段六十：`flash.utils.Timer`（重复触发/`TIMER_COMPLETE`/`stop`/`reset`/`delay` setter 校验 + `repeatCount` int 截断），离屏（纳入回归）
- `examples/stage59.as` — 阶段五十九：`flash.events` 事件子类（`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent` + `Event` 全量常量断言），离屏（纳入回归）
- `examples/stage58.as` — 阶段五十八：`flash.geom` 2D 几何（`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform` 断言），离屏（纳入回归）
- `examples/stage57.as` — 阶段五十七综合：精确 GC 泄漏断言（50000 个临时 `record`+`array` 对象后 `System.gc()` 回收归零，`totalMemory` 不线性增长），离屏（纳入回归）
- `examples/gc_strings.as` — 阶段五十七 GC-2：字符串纳入 GC 堆泄漏断言（100000 次字符串拼接后 `System.gc()` 回收归零），离屏（纳入回归）
- `examples/gc_incremental.as` — 阶段五十七 GC-4：增量标记内存有界断言（800 帧每帧分配临时对象，`gc_step()` 每帧分片回收，堆不随帧数线性增长），离屏（纳入回归）
- `examples/gc_barrier.as` — 阶段五十七 GC-4：写屏障压力断言（200 条类实例链、10200 个节点经直接字段写后 `System.gc()` 后对象图完整无悬空），离屏（纳入回归）

每个示例编译后会在旁边留下同名 `.c` 文件，可直接阅读编译器生成的 C 代码。

## 测试

运行 `node test.ts`（或 `npm test`）会编译并运行 `examples/` 下全部示例，逐项报告 pass/fail，任一失败以非零码退出。

## 鸣谢

本项目站在以下项目与第三方库的肩膀上，谨此致谢：

- **[TypePHP](https://github.com/swoole/typephp)**（[官网](https://swoole.com/aot/)）——把 PHP 编译成原生二进制的 AOT 编译器。「编译器前端只负责翻译、优化与机器码生成交给成熟 C 编译器、不重复造轮子」的整体思路，以及构建清单（`project.yml`）与多目标后端设计，均借鉴自它。
- **[Ruffle](https://github.com/ruffle-rs/ruffle)**（[官网](https://ruffle.rs/)）——Adobe Flash 的开源 Rust 重实现。其 AS3/AVM2 的 `flash.events.*` 事件流、`flash.display.*` 显示列表与交互命中测试实现，是本项目 GUI/事件系统语义的权威参照。
- **[Skia](https://github.com/google/skia)**（[官网](https://skia.org/)）——2D 图形库，渲染后端。本项目经 C++ 胶水层链接 Skia 实现光栅化（采用 [Aseprite 预编译静态库](https://github.com/aseprite/skia/releases) m124）。
- **[SDL](https://github.com/libsdl-org/SDL)**（[官网](https://www.libsdl.org/)）——跨平台窗口/输入库，窗口化后端（`Stage.showWindow`）经 SDL2 上屏与事件循环。
