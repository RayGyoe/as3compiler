# A native AOT compiler for ActionScript 3

把 ActionScript 3 源码**提前编译（AOT）成原生机器码**，生成原生可执行文件——同时保留你熟悉的 AS3 语法。

设计思路：编译器前端只负责
`词法 → 语法 → 生成可读的 C`，优化与机器码生成全部交给成熟的 C 编译器，不重复造轮子。

---

## 🎬 Video

<div align="center">
<video src="https://github.com/user-attachments/assets/2e41e471-b2f3-4274-9d41-748c4d529a62" controls width="100%"></video>
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
且运行产物需支持异常处理提案的运行时（wasmtime/wasmer，见 `docs/zh-cn/compile.md` §2）；
`--target wasm --package web` 需 Emscripten SDK（`EMSDK_HOME` 指向 emsdk 根目录，见
`docs/zh-cn/html5-web.md`）。

```bash
# 编译（默认输出到输入同名的无扩展名文件，并保留生成的 .c 便于阅读）
as-aot examples/hello.as

# 编译并运行
as-aot examples/fib.as --run

# 指定输出名 / 指定 C 编译器
as-aot examples/class.as -o build/class --cc clang --run

# 生成 macOS App 工程（--package xcode-project，交给 Xcode 打开/构建/调试，产物是 .app）
as-aot src/Main.as --target native --package xcode-project -o build/Main

# 生成浏览器 HTML5 渲染页面（--target wasm --package web，需 Emscripten SDK）
as-aot examples/web/hello-web.as --manifest examples/web/hello-web.build.json
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

# 嵌入 SWC 里的位图资源类（阶段九十五）：命名资源变成 BitmapData 子类，
# 源码可直接 `new logo(0, 0)`，也可 getDefinitionByName("logo") 反射后 new
as-aot app.as --swc assets/skin.swc

# 构建清单（JSON，路径相对清单目录解析）
as-aot app.as --manifest examples/skia-link.build.example.json

# 导出顶层函数给 JS 直调（默认 WASI 命令模块只导出 _start）
as-aot examples/wasm-native/fib.as --target wasm --export fib

# 声明式导出：用 [WasmExport] 元数据标记函数/静态方法，自动导出并生成 .exports.json
as-aot examples/wasm-native/export-meta.as --target wasm

# 生成浏览器 HTML5 渲染页面（--target wasm --package web，需 Emscripten SDK）
as-aot examples/web/hello-web.as --manifest examples/web/hello-web.build.json

# 只生成 C 并打印编译命令，不真正编译（无工具链时验证命令）
as-aot examples/hello.as --target wasm --dry

# 保留调试信息：三种后端均加 -g，且 wasm 默认的 DWARF 剥离被关掉（可用 DevTools 源码级调试）
as-aot examples/wasm-native/fib.as --target wasm --debug-info
```

构建清单（JSON）字段：`target`（`native`/`wasm`）、`package`（`raw`/`xcode-project`/`android-project`/`web`，
默认 `raw`，见 `compile.md` §6）、`c-compiler`、`opt`、`debug-info`（保留调试信息，默认 `false`，见下）、
`sources`（额外 C/C++ 源）、
`include-paths`、`link-libs`、`link-paths`、`defines`、`objects`（预编译 `.o`）、`exports`（导出到 .wasm 导出表的 C 符号）、
`swc-paths`（`.swc` 库清单；其中的**命名位图资源**在编译期提取、反预乘后重编码为 PNG 内嵌进产物，
运行时由 Skia 解码；**矢量 shape 与显示树**（`DefineShape*`/`DefineSprite`/`PlaceObject*`）与**九宫格**
（`DefineScalingGrid`）、**按钮四态**（`DefineButton2`）同样在编译期烘焙为运行时绘制调用——
见 `docs/zh-cn/swc.md` §5/§6/§9）、
`font-urls`（`--package web` 的字体字节流 URL 列表，运行时注入 Skia），
以及 `xcode-project` 的应用元数据 `bundle-id`/`display-name`/`icon`/`deployment-target`（见 `compile.md` §6.4）。CLI 参数覆盖清单同名字段。
路径类字段相对清单文件所在目录解析。示例见
[`examples/skia-link.build.example.json`](examples/skia-link.build.example.json)。

**按目标分层链接（`targets`）**：顶层字段为公共默认；`targets.<native|wasm>` 块只对**匹配的目标**生效，
并把它声明的字段**整体替换**（replace，非追加）同名顶层值——使**一份清单**即可服务链接集互斥的多目标
（典型：native 链接 curl，而 WASI 无 socket、`-lcurl` 会让 `wasm-ld` 失败，需为 wasm 去掉它）。合并顺序：
默认配置 → 清单顶层 → 清单 `targets.<最终目标>` → CLI 覆盖。示例
[`examples/flash-net-layered.build.example.json`](examples/flash-net-layered.build.example.json)，详见 `compile.md` §4.1。

**调试信息（`--debug-info` / 清单 `debug-info`，默认关）**：默认产物在**三个后端都不带 DWARF**——native 在 `-O2`
下本来就没有；`emcc -O2` 自己就剥离；唯独 **wasi 后端**的 `libc.a` 自带 DWARF 且 `wasm-ld` 默认保留（即使一个空
`int main` 也拖进 ~19 KB），故 wasm 链接默认加 **`-Wl,--strip-debug`**（`fib.wasm` 421 KB → **133 KB**；只删
`.debug_*`，`name` 函数名段保留 ⇒ trap 仍打印符号化栈）。开 `--debug-info` 则三端均加 `-g` 且 wasm 不再剥离
（`fib.wasm` ~640 KB，含我们生成的 C 的行号 ⇒ 可在 DevTools 里源码级调试）。

### Windows 原生后端（阶段一百二十六）

`--air-app` 在 Windows 上走 **Win32 + SDL2 + Skia D3D12 直连 GPU**。位宽由 AIR 描述符的
`<application><architecture>`（`"32"`/`"64"`，**缺省 32**）决定，对应 `vendor/*/windows-x86|windows-x64`：

```xml
<!-- 32 位（AIR 默认，也是 <architecture> 缺省行为） -->
<application><architecture>32</architecture></application>
<!-- 64 位 -->
<application><architecture>64</architecture></application>
```

- `<renderMode>direct</renderMode>`（或 `gpu`）→ `ASC_RENDER_WINGPU=1` + `ASC_RENDER_D3D=1`，额外链接
  `vendor/d3d_glue.cc` 与 `d3d12`/`dxgi`/`d3dcompiler`（进程级 `ID3D12Device`/命令队列/`GrDirectContext`，
  窗口级 `CreateSwapChainForHwnd` 双 back buffer + fence 帧同步 + `ResizeBuffers`）；`cpu`/`auto` 保持
  CPU 光栅 + SDL streaming texture blit。
- GPU seam 是**后端中立**的：生成 C 与 runtime 只说 `sk_gpu_*`/`sk_window_show_gpu`/`as_skia_gpu_*`/
  `w->is_gpu`，`ASC_RENDER_WINGPU` 表示「本窗口的合成跑在 GPU 上」，具体后端由 `ASC_RENDER_METAL`(macOS)
  / `ASC_RENDER_D3D`(Windows) 指名，**唯一**的分支点在 `vendor/window_glue.cc`（`sk_attach_gpu`）。
- 与 macOS 的差别全在**构建期**选出来，不是运行期分支：Windows 上不链 `metal_glue.mm`/`objc`/Cocoa
  framework、不加 `-lm`/`-lz`（`m.lib`/`z.lib` 在 Windows 不存在）、`AS_HAVE_ICONV=0`（非 UTF 字符集
  **响亮**抛错）。归档名按 gn 的 Windows 规则（`<target>.lib`、**无** `lib` 前缀）⇒ 字面叫 `libpng` 一类的
  目标链成 `-llibpng`；此结论来自在 macOS 上 `gn gen target_os="win"` 读出的**真实** `build.ninja`。
- **Stage3D 在 Windows 上不可用且不静默降级**：描述符/源码用到 `Context3D` 时构建期报 `AirAppError`
  （AGAL→HLSL 翻译器尚未立项，见 `TODO.md` 阶段一百二十六）。
- 依赖库由 `vendor/build-windows-deps.ps1` 从源码编（Skia m124 `skia_use_direct3d=true`、SDL2、curl、
  zlib、nghttp2；x86/x64 双位宽，LLVM `clang-cl`，`dumpbin` 校验位宽，错位即硬失败）。完整说明、
  **未实机验证的假设清单**与 Windows 首跑核对清单见 [`win32.md`](docs/zh-cn/win32.md)。

## 支持的语言子集

| 类别 | 支持 |
|------|------|
| 类型 | `int`、`uint`、`Number`、`Boolean`、`String`、`void`、`Array`、`Vector.<T>`、`Function`、`RegExp`、`Class`（类引用）、`Dictionary`（对象引用键关联表）、`*`（无类型 → 动态 `any` 装箱）、类名（对象类型）、接口名 |
| 字面量 | 整型、浮点、十六进制（`0xFF`）、字符串（单/双引号）、`true`/`false`、`null`、`Infinity`/`NaN`、数组字面量 `[...]`、对象字面量 `{ ... }`（**键可为数字**：`{0: "a"}`，阶段一百零六）、**E4X XML 字面量** `<a b="1">…</a>`（嵌套/自闭合/属性/注释/CDATA，阶段一百零六；`{expr}` 插值**响亮拒绝**）、正则字面量 `/pattern/flags`、Vector 字面量 `new <T>[...]` |
| 表达式 | 算术 `+ - * / %`、比较 `== != < <= > >=`、逻辑 `&& \|\| !`、一元 `- + ! ~`、位运算 `& \| ^ << >> >>>`、自增 `++ --`（前后缀）、三元 `?:`、**null 合并 `??`**（最低优先级、短路，左侧仅在必要时提升为装箱临时量，阶段一百零六）、**逗号运算符** `(a, b)`（最低优先级、结果取右操作数，阶段一百零六）、**E4X 后代轴** `x..name` / `x..*`（前序、不含自身，阶段一百零六）、**E4X 计算名** `x.ns::[expr]`（孩子轴 ⇒ `XMLList`）与 `x.@[expr]`（属性轴 ⇒ `String`）（阶段一百零八；`ns` 限定词按「命名空间透明」折叠）、类型判断 `is` / 转换 `as`（支持点分全限定名）、强制转换语法 `Type(expr)`、`typeof`、`delete`、成员存在 `in`、数组索引 `a[i]`、属性访问 `o.x`、复合赋值 `+= -= *= /= %= <<= >>= >>>= &= \|= ^=`、逻辑赋值 `\|\|= &&=` |
| 语句 | 变量声明（含多变量 `var a:T, b:T, c:*;`）、表达式语句、`if/else`、`while`、`do-while`、`for`、**`with (obj) stmt`**（对象成员作为最内层作用域）、`for-in`（数组索引 / 动态对象键 / `Dictionary` 对象引用键）、`for-each-in`（含省略 `var` 的裸标识符迭代形式）、`switch/case/default`、`break`、`continue`、标签语句 `label: while(...){ break label; }`、`return`、`throw`、`try/catch/finally`（**多分支 catch** `catch (e:A) … catch (e:B) …` 按源码顺序匹配、命中即清 `as_exception`、都不中重抛，阶段一百零六）、块；`new C`（**省略参数列表**，等价 `new C()`）与 `a[i] \|\|= v` / `a[i] &&= v`（索引目标的短路赋值，接收者/索引须无副作用）；函数内 `arguments`（按需生成的形式参数数组） |
| 函数 | 带类型参数与返回类型的自由函数；**省略参数类型**（按规范默认 `*`，阶段一百零六）；可选参数与默认参数 `function f(a:int, b:int = 1)`；任意类型参数 `function f(message:* = "")`；rest 参数 `function f(...args:Array)`；`Function` 类型与函数值（匿名函数表达式、函数作参数/返回值）；闭包（匿名函数捕获外层局部变量，捕获变量堆分配逃逸） |
| 类 | 字段 + 方法 + 有参构造 + `new` + `this` + 继承 `extends` + `override` 重写（虚表派发） + `super` 调用（含无显式 `super` 时的隐式无参 `super()`）+ `super.property` 属性读·写（字段/getter/setter）+ 访问修饰符 `public/private/protected/internal` + `static` 字段/方法 + `const` 常量 + **一行声明多个字段** `private var a:T = 1, b:T = 2;`（每个声明符一个独立槽位，共享语句的修饰符，阶段一百零八）+ `get/set` 访问器 + `final` 类/方法 + 动态类（`dynamic class`，未声明属性路由到运行时槽表）+ 静态方法作为 `Function` 值（`ClassName.method` 或裸标识符）+ 动态类实例化 `new (expr as Class)()`（经类引用的无参工厂）+ 类体 **`{ ... }` 静态初始化块**与**类体裸语句**（阶段一百零六；顺序按 `adl` 实测：**先**静态字段初始化器按声明顺序、**再**按源码顺序跑类体块）+ 类体内 `import`（容忍并忽略）与多余 `;` + `get`/`set` 可作普通标识符（`var set:int`) |
| 接口 | `interface` 声明（含 **`extends A, B`** 多父接口，方法按父链**传递合并** + 环检测，阶段一百零六）+ `implements` 实现（含 **`implements A, B`**，接口 vtable 派发）+ `is`/`as` 接口类型检查（运行时 `as_iface_lookup`，静态可知为真时才折叠）+ **接口访问器**（`iface.getter`/`iface.setter = v`/`iface.getter()` 零实参的「作方法调用」形态均走接口 vtable 的 getter/setter 槽；带实参的访问器一律响亮报错；阶段一百一十 补齐赋值与作方法调用）+ **接口访问器可由「内建访问器型属性」满足**（阶段一百一十八：继承 `Sprite`/`InteractiveObject` 的 `x`/`y`/`visible`/`alpha`/`mouseEnabled`… 的类即便不写 getter 也满足 `get x():Number; set x(v:Number):void;`，与 AIR 一致——AIR 把这些声明为访问器对；用户的 `public var x` **仍被拒绝**，同样与 AIR 一致） |
| 包/模块 | 多文件编译（多个 `.as` 合并为一个编译单元）；`package` 命名空间隔离（C 标识符前缀）；`import` 跨文件/跨包短名解析；`internal` 同包可见（跨包拒绝）；自定义命名空间 `public namespace`/`use namespace`/`ns::member`（AOT 编译期透明化，无运行时可见性语义） |
| 根类 | `Object` 内置根类：所有类的隐式基类，`toString()` 返回运行时类名；`Error` 内置错误类型：`new Error(message, id)`、`.message` 属性；内置错误子类 `TypeError`/`RangeError`/`ArgumentError`/`SyntaxError`/`ReferenceError`；内置 `Date` 类（毫秒时间戳 + 日历访问器）；`flash.events` 事件系统 `Event`/`EventDispatcher`/`MouseEvent`/`KeyboardEvent`/`FocusEvent`/`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent`（`addEventListener`/`dispatchEvent` 捕获→目标→冒泡三阶段、`preventDefault`/`stopPropagation`/`stopImmediatePropagation`；`Event` 补全 `CANCEL`/`CLEAR`/`CLOSE`/`CONNECT`/`COPY`/`CUT`/`DEACTIVATE`/`EXIT_FRAME`/`FRAME_CONSTRUCTED`/`FULLSCREEN`/`ID3`/`INIT`/`MOUSE_LEAVE`/`OPEN`/`PASTE`/`RENDER`/`SCROLL`/`SELECT`/`SOUND_COMPLETE`/`TAB_*`/`UNLOAD` 常量，事件子类（阶段五十九）`TimerEvent`（`TIMER`/`TIMER_COMPLETE`）、`ProgressEvent`（`PROGRESS` + `bytesLoaded`/`bytesTotal`）、`ErrorEvent`（`ERROR` + `text`）、`IOErrorEvent`（`IO_ERROR`，继承 `text`）、`DataEvent`（`DATA` + `data`）、**`VsyncStateChangeAvailabilityEvent`**（`VSYNC_STATE_CHANGE_AVAILABILITY` + 只读 `available`（AIR 面，实测恒 `false`）与**只读 `refreshRate`（增强面**：AIR 无任何刷新率 API，见「在 AIR 之外」与 [`enhancements.md`](docs/zh-cn/enhancements.md) §4.8 E16）））；`flash.display` 显示列表 `DisplayObject`/`InteractiveObject`/`DisplayObjectContainer`/`Stage`/`Sprite`/`Shape`/`Graphics`/`Bitmap`/`BitmapData`（层级/坐标/`addChild`（触发 `addedToStage`）/`removeChild`/命中测试/递归渲染；**几何与命中（阶段九十四·六）**：`Shape`/`Sprite`/`MovieClip` **都有 `graphics`**（`Sprite`/`MovieClip` 为惰性 getter），`width`/`height` 是**派生访问器**（内容包围盒经自身变换；描边外扩计入，`TextField` 例外——它存真尺寸、getter 报「尺寸 × `scaleX`」），**给 `width`/`height` 赋值是缩放**（`scaleX = scaleX * value / cur`，空内容写 0）；命中测试**变换感知**（父链矩阵逐层折算到局部包围盒，`hitTestPoint` 收**舞台坐标**）；**几何/坐标 API 族（阶段九十四·九）**：`getRect`/`getBounds`（内容包围盒，前者不含、后者含描边；`targetCoordinateSpace == null` ⇒ 自身局部空间、`== self` ⇒ 短接得精确局部盒）、`localToGlobal`/`globalToLocal`（走完整祖先矩阵链、返回新 `Point`、`null` 点抛 `TypeError #2007`）、`hitTestObject`（两个**舞台空间**包围盒求交且含描边、空对象永不相交）与 `hitTestPoint` 均在 **`DisplayObject`** 上（`Shape` 因此也可用）；`MouseEvent.localX/localY` 与文本插入点索引走同一套折算，`as_render_object` 按 `is` 子类型链分派，用户 `Sprite` 子类可作容器、`cacheAsBitmap` 子树位图缓存（toggle 失效重烘焙，烘焙结果与直接递归渲染逐像素一致；增量重绘自动 cacheAsBitmap：静止子树指纹驱动自动烘焙）；`Stage` 舞台属性 `stageWidth`/`stageHeight`/`fullScreenWidth`/`fullScreenHeight`/`displayState`/`quality`/`color`/`align`/`scaleMode`/`frameRate`/`vsyncEnabled` 与布尔开关，以及**读写 `focus`**（`InteractiveObject`；赋值即按 `adl` 语义派发 `focusOut`→`focusIn`，是复制的使能条件）（`frameRate` 按 AIR 是**整个应用一个值**：任一窗口/任一 `Stage` 写入即全局生效，帧循环每 tick 只派发**一个应用帧**，不随窗口数叠加——阶段八十九·七十三；`vsyncEnabled` 同为应用级单值、实测默认 `true`，为 `false` 时**去掉「显式 frameRate 高于面板刷新率就封顶」**——阶段一百二十九），常量类 `StageAlign`/`StageScaleMode`/`StageQuality`/`StageDisplayState`）；`flash.display.Screen`（阶段八十九·七十一）：`Screen.mainScreen`/`Screen.screens`/`Screen.getScreensForRectangle(rect)` + 实例 `bounds`/`visibleBounds`/`colorDepth`（静态属性 + 单参静态方法，无 `getScreens()`；`bounds` 是**完整显示模式**、`visibleBounds` 是**可用区**，两者是不同的量）；**每次访问都返回新的包装对象**（`Screen.screens[0] !== Screen.mainScreen`，实测 `adl`），缓存的 `Rectangle` 才是活对象；`new Screen()` 抛 `Error #2012`；`flash.display.NativeWindow` 家族（阶段八十九·七十一，**多窗口**）：`NativeWindow`/`NativeWindowInitOptions` + 常量类 `NativeWindowSystemChrome`/`NativeWindowType`/`NativeWindowRenderMode`/`NativeWindowDisplayState`/`NativeWindowResize`，`new NativeWindow(opts)` 立即开出自己的 OS 窗口（返回时 `visible=false`，默认框 400×232、客户区 400×200，边框大小取自 `NSWindow`）、**每个窗口有独立 `Stage`**（`scaleMode="showAll"`/`align=""`；`frameRate` 是**应用级**单值，新窗口继承当前值而非自带 24fps——阶段八十九·七十三）、`bounds`/`x`/`y`/`width`/`height` 为窗口几何代理、`close()` 走**帧边界延迟收尾**（调用当帧 `closed` 仍为 `false`）并派发 `Event.CLOSE`，另有 `activate`/`minimize`/`maximize`/`restore`/`orderToFront`/`orderToBack` 与 4 个静态 `isSupported`/`supportsTransparency`/`supportsMenu`/`supportsNotification`；**按 AIR 继承 `EventDispatcher`**（阶段八十九·七十二）——故窗口可 `addEventListener`，`Event.CLOSE`/`ENTER_FRAME` 均能送达（这既是 API 形状也是**结构体布局契约**：`listeners`/`parent` 必须在 `_win` 之前，否则 `dispatchEvent` 会读到越界指针而崩溃）；`flash.text` 文本 `TextField`/`TextFormat`（SkParagraph 完整排版：HarfBuzz shaping + UAX#14 换行 + 真实行高，`multiline`/`wordWrap`/`scrollV`/`maxScrollV`/`numLines`/`textWidth`/`textHeight` + `background`/`backgroundColor` 背景填充 + `border`/`borderColor` 边框（默认 `false`/`0x000000`，四条约 1px 实线落在字段盒外沿像素 `x∈{0,width}`/`y∈{0,height}`，画在背景之上、随字段缩放、不计入 `textWidth`/`textHeight`；三个颜色属性都是 24 位 RGB、写入丢弃 alpha 字节——阶段九十四·八）；`TextFormat.align` 水平对齐 `left`/`center`/`right`/`justify` 已落地——有排版宽度时交给 SkParagraph 逐行对齐，`wordWrap=false`（无排版宽度）时按 AIR 的 2px 文字内边距在绘制原点做整块平移，与 AIR 一致地**不开换行也能居中/右对齐**；这正是 Starling `TrueTypeCompositor` 居中原生文字所依赖的行为）；`flash.utils.Dictionary`（`new Dictionary(weakKeys)`：按**对象引用**作键的关联表，支持 `in`/`delete`/`for-in`，弱引用参数接受但不建模，键强持有程序生命周期）；**`ByteArray` 的多字节 / 布尔 / AMF 面（阶段九十四·四）**：`readMultiByte(length, charSet)`/`writeMultiByte(value, charSet)`/`readBoolean`/`writeBoolean`/`readObject()`/`writeObject(object)` + `objectEncoding`（默认 `ObjectEncoding.AMF3`）+ **整数下标读写** `ba[i]`（读空隙为 0；写走 `ToUint32` 低字节、越界自动扩展并零填充、不影响 `position`）；`charSet` 走**系统 `iconv`**（native 构建链接 `-liconv`），`'unicode'`/`'utf-16'` **恒为 UTF-16LE 无 BOM 且 `endian` 属性无效**、`''`/未知字符集回落到 **OS 传统编码**（Apple 为 MacRoman、其余为 CP1252）、目标字符集表达不了的字符**手写 `'?'`**（不依赖 `//TRANSLIT`）、截断的多字节序列**有损解码为空串**、越界读抛 `EOFError #2030`；`writeBoolean` 写 **1 字节**、`readBoolean` **非零即真**；AMF3 对象图编解码器（写 + 读，逐字节对齐 `adl 51.4.1`）覆盖 null/undefined/bool/int（紧凑 U29 形态）/double/String（U29S 长度按 **UTF-8 字节**）/Date/ByteArray/Array（稠密段 + 关联段）/`Vector.<T>`（`0x0d`~`0x10`）/`Dictionary`/typed object（trait 表 + 引用表 + **自身字段先于超类字段**）；`flash.net.registerClassAlias`/`getClassByAlias` 已接线，别名**沿超类链生效**（实测：以基类名注册的别名会写进子类实例）；`readObject`/`writeObject` 在 `ByteArray` 与 `URLStream` 共用同一编解码器，**AMF0 尚未实现**（`objectEncoding = AMF0` 时**响亮抛错**，不静默按 AMF3 写）；`flash.utils.Proxy`（阶段九十四·一）：`dynamic class X extends Proxy` 经 `flash_proxy` 命名空间的十个拦截器接管动态属性访问（`getProperty`/`setProperty`/`deleteProperty`/`hasProperty`/`callProperty`/`getDescendants`/`nextNameIndex`/`nextName`/`nextValue`/`isAttribute`），真槽优先、未覆盖的操作按 `adl` 实测抛 `#2088`…`#2107`；`flash.utils.Timer`（阶段六十）：重复定时器，继承 `EventDispatcher`，构造 `Timer(delay, repeatCount=0)`，`delay` setter 校验负值/非有限抛 `RangeError`；`repeatCount` setter 不校验（`int` 截断，负值保留、`NaN`→0）、`currentCount`/`running` 只读，`start`/`stop`/`reset`；每 interval 派发 `TimerEvent.TIMER`、`repeatCount>0` 耗尽派发 `TimerEvent.TIMER_COMPLETE`、`repeatCount=0` 无限重复；由帧循环 `as_timer_tick` 驱动（离屏用 `tickTimers()` 手动泵，WASI 秒级退化）；`flash.geom` 2D 几何（阶段五十八）`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform`（`Point` 静态 `distance`/`interpolate`/`polar` 与实例 `add`/`subtract`/`offset`/`normalize`/`setTo`/`copyFrom`/`clone`/`equals`/`toString`；`Rectangle` 只读 `top`/`bottom`/`left`/`right` 与 `intersection`/`union`/`contains`/`containsPoint`/`containsRect`/`intersects`/`equals`/`inflate`/`offset`/`clone`/`setEmpty`/`isEmpty`/`toString`；`Matrix` `identity`/`translate`/`scale`/`rotate`/`concat`/`invert`/`transformPoint`/`deltaTransformPoint`/`createBox`/`createGradientBox`；`ColorTransform` 8 通道 + `concat`；`Transform` 持恒等 `matrix`/`colorTransform`，已接线到 `DisplayObject.transform`（`Matrix` 作用于 Skia canvas 变换））；`Vector3D`/`Matrix3D`（阶段七十九，`flash.geom` 3D 几何，纯逻辑不碰 GPU）：`Vector3D` x/y/z/w 四分量（几何运算 `normalize`/`dotProduct`/`crossProduct`/`distance`/`angleBetween`/`length`/`lengthSquared` 仅用 xyz，w 为齐次坐标；`add`/`subtract`/`scaleBy`/`negate` 四分量；`equals(allFour)`、`toString` + 静态常量 `X_AXIS`/`Y_AXIS`/`Z_AXIS`）；`Matrix3D` 4×4 列主序（`rawData` 为 `Vector.<Number>` 列主序 16 元素，`identity`/`append`/`prepend`/`invert`（原位修改返回 `Boolean` 可逆性）/`transpose`/`transformVector`/`transformVectors`/`deltaTransformVector`/`pointAt`/`interpolate`/`recompose`/`decompose`/`copyFrom`/`clone` + 平移/缩放/旋转构造 + 静态 `identity`/`interpolate`，`decompose`/`recompose` 往返一致）；`AGALTranslator`（阶段八十，AGAL 字节码内核，`flash.display3D` 纯静态桥、非 AS3 运行时 API）：`translate(bytes:ByteArray, target:String):String` 把 AGAL1/2/3 字节码翻译成可读 MSL（`"msl"`）或 GLSL ES（`"glsl"`）源码——解析 7 字节头 + 变长指令 token（dest `[num:16][mask:8][type:8]`、source `[num:16][offset:8][swizzle:8][type:8][reltype:8][relsel:16]`、sampler `[num:16][lod:8][0:8][samplerbits:32]`），28 条基础指令带 swizzle/write-mask 展开 + AGAL2 控制流（`ife`/`ine`/`ifg`/`ifl`/`els`/`eif`）+ 导数（`ddx`/`ddy`）+ `tex` 采样；寄存器 type 为 shader 相对编码（`vc=fc=1`、`vt=ft=2`、`op=oc=3`、`fs=vs=5`）按 vertex/fragment 分派；基础校验（magic/version/opcode/截断/指令数）失败抛 `Error`）；`Stage3D`/`Context3D`（阶段八十一~八十三，`flash.display3D` CPU 状态机 + 可选 Metal GPU 后端）：`Stage.stage3Ds` 返回 `Vector.<Stage3D>`（单槽位），`Stage3D.requestContext3D(mode)` 懒创建 `Context3D` 并同步派发 `Event.CONTEXT3D_CREATE`、`context3D`/`x`/`y`/`visible` 读写；`Context3D` 状态机 `configureBackBuffer`/`setBlendFactors`/`setDepthTest`/`setCulling`/`setStencilActions`/`setScissorRectangle`/`setStencilReferenceValue`/`setProgram`/`setVertexBufferAt`/`setTextureAt`/`setProgramConstantsFromMatrix`（transposed=false 时列主序转置为行主序上传、true 时原样拷贝）/`setProgramConstantsFromVector`（AGAL3，`Vector.<Number>` 上传 vc/fc；`numRegisters` 缺省 `-1` 表示按 vector 长度取寄存器数——Starling 的 `BlurFilter`/`ColorMatrixFilter` 正是只传 vector，见阶段八十九·二十一）/`createVertexBuffer`/`createIndexBuffer`/`createProgram`/`createTexture`/`createCubeTexture`/`createRectangleTexture`/`setCubeTextureAt`/`setRectangleTextureAt`/`drawTriangles`/`drawTrianglesInstanced`（AGAL3 实例化）/`clear`/`present`/`drawToBitmapData`/`setRenderToTexture`/`setRenderToBackBuffer` + 只读 `driverInfo`/`profile`/`maxBackBufferWidth`/`maxBackBufferHeight`；资源类 `VertexBuffer3D`/`IndexBuffer3D`（`uploadFromVector`/`uploadFromByteArray` 记录 CPU 拷贝，后者读小端 float32/uint16 宽化进 vector）/`Program3D`（`upload` 记录字节码）/`Texture`/`TextureBase`（`uploadFromBitmapData` 记录源 `BitmapData` 并**同步上传** GPU 纹理，见下；`miplevel != 0` 时按 adl 实测的**区域规则**上传该级——取**源位图左上** `lw×lh`（`lw = max(1, width>>level)`，按**源的行距**读）、自 `max(width,height)` 算层数并拒绝超界级，同时置位该纹理的「有链」标记；阶段一百二十八）/`CubeTexture`（六面 `BitmapData` 描述符）/`RectangleTexture`（NPOT 单面描述符；`createRectangleTexture(..., optimizeForRenderToTexture=true)` 会真正分配可作渲染目标的 GPU 纹理——Starling `Texture.empty(...)` 的非压缩/非 mip 纹理全走此路径，滤镜离屏通道依赖它，见阶段八十九·二十一）；`Texture.uploadCompressedTextureFromByteArray`（阶段八十九·二十一）：ATF 容器里 `format 3/5`（裸 DXT1/DXT5）在 CPU 解码为**直通 alpha** 的 ARGB 后走普通纹理上传路径（不预乘，与 adl 把裸 DXT5 交给 GPU 一致），其余 format/立方图**响亮抛 `Error #3680`**（不静默出空图）；16 个常量类 `Context3DBlendFactor`/`Context3DBufferUsage`/`Context3DClearMask`/`Context3DCompareMode`/`Context3DCubeMapFace`（int）/`Context3DFillMode`/`Context3DMipFilter`/`Context3DProfile`/`Context3DProgramType`/`Context3DRenderMode`/`Context3DStencilAction`/`Context3DTextureFilter`/`Context3DTextureFormat`/`Context3DTriangleFace`/`Context3DVertexBufferFormat`/`Context3DWrapMode`；**GPU 后端（阶段八十二~八十三）**：构建清单定义 `ASC_RENDER_STAGE3D=1` + 链接 `vendor/stage3d_glue.mm`（裸 Metal：`MTLBuffer` 顶点/索引/常量、`MTLTexture` 2D、MSL 编译、离屏 render-to-texture）时，`drawTriangles`/`drawTrianglesInstanced` 作为唯一同步点延迟上传所有绑定资源并 `drawIndexedPrimitives` 上屏（实例化走 `instanceCount`）；**一帧的 draw 合批成一条 `MTLCommandBuffer`、帧边界只提交+等待一次**（阶段一百零四：原先每条 `drawTriangles` 都 `commit` + `waitUntilCompleted`，实测 `cpu=0.01ms/gpu=0.04ms` 而 `wait≈0.5ms` ⇒ 那 0.5ms 是纯往返延迟，Starling 开 fps 监控时每帧多 1.6 条 draw 就直接吃掉 0.8~1.0ms/帧；合批后 `draws/batch` 7~9、`wait` 0.93ms **每帧**，Benchmark 峰值对象数 **+39%**、开关 stats 的差距由 −14% 收窄到 −6%）；**混合状态（阶段八十九·二十二）**：Metal 把 blend state 烘进 `MTLRenderPipelineState`（无逐绘制设置接口），故 glue 保留已编译的 vertex/fragment 函数并**按 blend 因子对缓存管线**，每次编码绘制时按当前 `setBlendFactors` 选择（缺失则懒建，LRU 上限 12）；**深度/模板状态同样按键值 LRU 缓存**（`S3D_MAX_DSS` 槽 + `s3d_select_dss`，away3d 逐 draw 交替 depth 状态时不再每 draw 新建一个 `MTLDepthStencilState`——实测 `dss=2` over 1680 draws，阶段一百二十八）——同一 `Program3D` 上中途改混合模式由此真正生效（Starling `Blend Modes` 场景此前标签在变、图像不变）、`drawToBitmapData` 读回当前渲染目标像素（render override 优先，ARGB↔BGRA 转换），否则纯 C 模式仅为状态机（`as_s3d_*` no-op 包装保持 link-clean）；**web 目标（阶段八十九·三十）**：同一份生成 C 在浏览器里改链接 `vendor/stage3d_webgl.cc`（WebGL2/GLES3）+ 构建期 `ASC_S3D_GLSL=1`，着色器由同一个 AGAL 翻译器出 GLSL ES（`ASC_AGAL_TARGET` 构建期选 MSL/GLSL）——`s3d_*` 签名两端完全一致，故 `Context3D` 状态机与 `as_s3d_*` 包装器零改动；GL 侧的 Y 轴翻转（顶点阶段 `gl_Position.y = -gl_Position.y`，使纹理 `v=0` 与读回行序都与 AS3 一致）、BGRA↔RGBA 交换、逐寄存器 `uniform vec4 vcN/fcN`、`DEPTH24_STENCIL8` 离屏 FBO 与前后模板分离 API、按纹理对象缓存采样器状态、与 Ganesh 共享单一 WebGL2 上下文（每个触碰 GL 的 `s3d_*` 入口调 `sk_gr_reset_context()`）均在 `vendor/stage3d_webgl.cc` 内处理，`examples/air-starling-demo` 的 12 个场景在浏览器里逐场景渲染且与 AIR `adl` 参考一致（120 fps / 0 丢弃；见 `docs/zh-cn/html5-web.md` §3.3）；上屏当前走 CPU 读回（`as_s3d_readback_render` + `as_skia_canvas_draw_bgra`，实测占单帧 CPU 成本 ~98%），GPU 直连列为后续优化；**纹理上传时序（阶段八十九·十八）**：`uploadFromBitmapData` 在 AIR 里是**同步**上传，调用方随即 `BitmapData.dispose()` 是合法写法——故 AOT 也在 `uploadFromBitmapData` 里**立刻**建好 `MTLTexture`（`Texture` 记下 `Context3D` 的 glue 句柄，经 `s3d_texture_from_pixels` 创建但不绑定采样槽，`Context3D_submit` 再按槽位 `s3d_bind_texture`），而不是把上传推迟到下一次 `drawTriangles`（推迟会让 `dispose()` 后的 `pixels` 已被 free 而读空/读到超期数据：Starling 逐字光栅化即「draw → fromBitmapData → dispose」，曾因此让文字纹理根本没上传、采样槽残留上一次的图集内容而渲染成彩色乱码）；`flash.filters` 滤镜（阶段六十一）`BitmapFilter`（抽象基类，`clone()`）/`BlurFilter`（`blurX`/`blurY`/`quality` + `clone`）/`DropShadowFilter`（`distance`/`angle`/`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout`/`hideObject` + `clone`）/`GlowFilter`（`color`/`alpha`/`blurX`/`blurY`/`strength`/`quality`/`inner`/`knockout` + `clone`）+ 常量类 `BitmapFilterQuality`（`LOW`/`MEDIUM`/`HIGH`）；`DisplayObject.filters` 读写（`Array` 存取）；`BitmapData.applyFilter`（`BlurFilter` 经可分离盒式模糊落地，`DropShadowFilter`/`GlowFilter` 光栅化延后抛错）；`flash.display` 补齐（阶段六十二）`MovieClip`（`currentFrame`/`totalFrames` + `play`/`stop`/`gotoAndPlay`/`gotoAndStop`，帧循环驱动，`currentFrame` 越界回绕到 1，`totalFrames` 可写以模拟多帧时间轴）/`SimpleButton`（`upState`/`overState`/`downState`/`hitTestState` 四状态引用）/`Loader`（`content`/`contentLoaderInfo` + `load(url)` 异步派发 INIT（同步）/COMPLETE（下一帧 tick）；`http(s)://` 的 URL **显式识别**并走与 `URLLoader` 同一条传输 seam——native + `ASC_HAVE_CURL` 在 worker 上 `as_http_perform` / web + `ASC_HAVE_FETCH` 启动 `fetch` 并在帧边界 pump 里解码（阶段八十九·五十六 接通 web 侧，此前 web 上这个分支只有 curl 实现，每个远程 `Loader.load` 都在**一次请求都没发**的情况下报「本构建没接 HTTP 后端」），无后端派**可区分**的诚实 `ioError`；跨源图片在浏览器里受**同源策略**约束：图片能*显示*但读不到像素，而 Skia 上屏需要像素，故 CDN 必须回 `Access-Control-Allow-Origin`，否则如实报 CORS `ioError`）/`LoaderInfo`（`bytesLoaded`/`bytesTotal`/`url` + `COMPLETE`/`INIT`/`OPEN`/`UNLOAD`/`PROGRESS`/`IO_ERROR` 常量）；`flash.net`/`flash.ui`（阶段六十三，API 面于阶段八十九·四十八 补齐；`http(s)://` 联网于八十九·四十九 **opt-in** 接入）`URLRequest`（**AIR 全属性面**：`url`（默认 `null`）/`method`（默认 `"GET"`）/`data`（`any`，默认 `null`）/`contentType`（**默认 `null`**，adl 实测；文档印的 `application/x-www-form-urlencoded` 是**发包默认**而非属性值——体非空的请求未声明时才发那个 MIME 串，无体请求一个都不发，阶段八十九·六十九）/`requestHeaders`（默认**空 `Array`**，可直接 `push`）/`authenticate`/`cacheResponse`/`followRedirects`/`manageCookies`/`useCache`（均默认 `true`）/`idleTimeout`（默认 `0`）/`userAgent`（按 OS 派生的 Flash/AIR 形态 UA 串）/`digest`；后 6 项按官方「initialized from the `URLRequestDefaults.X` property」在构造时从 `URLRequestDefaults` 读入 + 实例方法 `useRedirectedURL(sourceRequest, wholeURL=false, pattern=null, replace=null)`（先按 `wholeURL` 做域名/整段替换，再对结果做 `pattern`→`replace`，String 与 RegExp 两种 `pattern` 都支持））/`URLRequestMethod`（`GET`/`POST`/`PUT`/`DELETE`/`HEAD`/`OPTIONS` 六常量）/`URLRequestHeader`（`name`/`value`，构造器默认 `""`/`""`）/`URLRequestDefaults`（7 个静态属性 `authenticate`/`cacheResponse`/`followRedirects`/`idleTimeout`/`manageCookies`/`useCache`/`userAgent`，读写与 AIR 默认值一致；`setLoginCredentialsForHost` 延后——需认证型 HTTP 栈）/`URLLoader`（`data`/`dataFormat`/`bytesLoaded`/`bytesTotal` + `load(request)`/`close()`，继承 `EventDispatcher`，构造器 `URLLoader(request=null)` 传参即开始加载；异步（下一帧 tick）；`file://`/相对路径读本地文件，`http(s)://` 在 native + `ASC_HAVE_CURL`（构建清单 `link-libs: ["curl"]`）时**真联网**（GET/POST/状态码/HTTPS），无后端时派**可区分**的诚实 `ioError`；事件顺序 `open`（仅当请求到达传输）→ `progress` → `httpStatus`（**只带 `status`**；本地/无后端加载为 `0`）→ `complete`（失败：`httpStatus(0)` → `data` 空值 → `ioError`）；`data` 按 `dataFormat` 发布为 GC 跟踪字符串（text）/`ByteArray`（binary）/`URLVariables`（variables）；`bytesLoaded`/`bytesTotal` 在加载中恒 `0`、完成时置为字节数（AIR 口径）；`close()` **真中止**在飞加载（此后不再派任何终态事件），无流时抛 invalid stream error）/`URLVariables`（`dynamic class`，未声明字符串键属性写入运行时槽表，`toString()` 序列化为 query string，`decode(source)` 把 query string 解码进实例（值百分号解码、键不解码——与 AIR 一致））/`Keyboard`（静态键码常量表 `A`~`Z`/`NUMBER_0`~`NUMBER_9`/`SPACE`/`ENTER`/`TAB`/`ESCAPE`/`BACKSPACE`/`DELETE`/`SHIFT`/`CONTROL`/`LEFT`/`RIGHT`/`UP`/`DOWN` + 只读 `isAccessible`）/`Mouse`（静态 `hide`/`show` + 可写 `cursor`/只读 `supportsCursor`/`supportsNativeCursor`）；`flash.filesystem`（阶段六十四）`File`（`nativePath` + 只读属性 `url`（`file://` 形式）/`exists`/`isDirectory`（getter，经 `stat()`）+ `resolvePath`/`createDirectory`/`deleteFile`/`deleteDirectory` + 静态只读 `applicationStorageDirectory`/`applicationDirectory`/`desktopDirectory`/`documentsDirectory`/`userDirectory`（后者经 `getenv("HOME")` 运行时解析），POSIX `stat`/`mkdir`/`remove`）/`FileStream`（`open`/`openAsync`（异步派发 `ProgressEvent.PROGRESS` + `COMPLETE`）/`close`/`readUTFBytes`/`writeUTFBytes` + 只读 `position`/`bytesAvailable`，`FILE*` 句柄为不透明 `void*` 非 GC 跟踪）/`FileMode`（`READ`/`WRITE`/`APPEND`/`UPDATE` 常量）；`flash.net.SharedObject`（阶段八十九·四十）：`SharedObject.getLocal(name, localPath?)` 返回**本地共享对象**（继承 `EventDispatcher`，`fqn` = `flash.net::SharedObject`，**非 dynamic**，与 AIR 一致地对未声明属性赋值抛 `ReferenceError #1056`），`data` 为只读 getter 的 `Object`（键值表，可 `data[k]` 读写/`delete`/`for-in`），`size` 返回将被持久化的表示的字节数、`flush()` 返回 `SharedObjectFlushStatus.FLUSHED`(`"flushed"`)/失败响亮抛错、`clear()` 清空数据**并删除磁盘文件**、`close()` 对本地对象无副作用（空实现）、`setDirty()` 空实现、`setProperty` 写 `data`；**同名 `getLocal` 返回同一实例**（进程内实例表，静态字段作永久 GC 根）；`defaultObjectEncoding`/`preventBackup`/`client`/`objectEncoding`/`fps` 访问器与 `ObjectEncoding`(`AMF0=0`/`AMF3=3`/`DEFAULT=3`)、`SharedObjectFlushStatus`(`FLUSHED`/`PENDING`) 常量类均按 AIR 实测值建模；**持久化**到`applicationStorageDirectory` 下 `[<localPath>/]<name>.json`，并在**应用退出时自动落盘**（`atexit` 钩子，对齐 AIR「关闭应用时写入本地共享对象」的行为——即使从未调用 `flush()`）；`getRemote`/`connect`/`send` 需要在Flash Media Server 上运行，本运行时**响亮抛错**（不静默假装成功） |
| 内建 | `trace(...)`；`Array` 方法 `push/pop/shift/unshift/splice/slice/indexOf/join/concat`、`.length`；`String` 方法 `charAt/charCodeAt/indexOf/lastIndexOf/substring/substr/slice/split/match/search/replace/toUpperCase/toLowerCase/concat/localeCompare/valueOf/toLocaleLowerCase/toLocaleUpperCase/startsWith/endsWith`、静态 `String.fromCharCode`、`.length`；`Number`/`int`/`uint` 方法 `toFixed/toExponential/toPrecision/toString(radix)/valueOf`、`Number` 静态常量 `MAX_VALUE/MIN_VALUE/NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY`、`int`/`uint` 静态常量 `MAX_VALUE/MIN_VALUE`；`Math` 常量 `PI/E/LN10/LN2/LOG10E/LOG2E/SQRT1_2/SQRT2` 与方法 `abs/floor/ceil/round/sqrt/pow/min/max/random/sin/cos/tan/asin/acos/atan/atan2/exp/log`；全局函数 `parseInt/parseFloat/isNaN/isFinite`；`flash.utils.getTimer()`（自进程启动以来的毫秒数，非 Unix 时间戳，60Hz 帧循环计时用）；`flash.utils.setTimeout(closure, delay)` / `flash.utils.clearTimeout(id)`（调度/取消一次性函数回调，`delay` 毫秒后由帧循环触发，返回 `uint` 定时器 id；回调经函数值闭包绑定）；`flash.utils.setInterval(closure, delay, ...args):uint` / `flash.utils.clearInterval(id)`（阶段九十四·三）：与 `setTimeout`/`clearTimeout` **共用同一张表与同一个 id 计数器**（实测连续调用 id 为 `1,2,3…`），故两者**互为取消**（`clearInterval` 能取消 timeout 的 id、`clearTimeout` 能取消 interval 的 id），未知/0 的 id 是静默空操作；重复定时器**在回调结束后**再排下一次、每帧至多触发一次，在自身回调里 `clearInterval` 即停；负/NaN 延迟抛 `RangeError #2066`；`null` 闭包仍消耗 id 且永不回调；`flash.utils.getQualifiedClassName(value:*):String`（阶段八十六，反射：返回对象完全限定类名 `包::类`，原始类型返回 `"null"/"Number"/"Boolean"/"String"/"void"/"Array"/"Function"`）与 `flash.utils.getQualifiedSuperclassName(value:*):String`（阶段九十四·三：取值的类的**超类**限定名，多层链逐层上推，无超类时返回 **`null`**）与 `flash.utils.getDefinitionByName(name:String):Object`（按名返回类引用，与前者构成往返闭环，支持 `::`/`.` 两种分隔符；阶段一百二十七起**内建类也在注册表**（`getDefinitionByName("flash.display.BitmapData")` 可用），找不到抛 AIR 的 `Error #1065: Variable <末段> is not defined.`（`errorID` = 1065）；`describeType(value):XML` 返回 `<type name="包::类"/>` 描述树，阶段九十三已落地）；`flash.system.System` 内存统计（`totalMemory`(`uint`)/`totalMemoryNumber`(`Number`)/`freeMemory`(`Number`)/`privateMemory`(`Number`) 四个纯静态只读属性：`totalMemory` 为运行时自管堆已用字节（超 4 GiB 返回 0），`totalMemoryNumber` 同值不 clamp，`freeMemory` 为 arena 已申请未用缝隙，`privateMemory` 为真实进程常驻内存（macOS `mach_task_basic_info`/Linux `getrusage`×1024/Windows `GetProcessMemoryInfo`/WASI 退化为 `totalMemory`）；`flash.system.Capabilities`（阶段六十五）：`final` 静态只读类（与 `System` 同范式、无实例化类）—— `version`（固定 AIR 兼容 `"<平台前缀> 50,0,0,0"`，对齐 Adobe AIR 终版 major，AS-AOT 标记由 `manufacturer` 承担）、`os`（`Mac OS`/`Windows`/`WASI`/`Linux` 条件编译）、`cpuArchitecture`（`ARM`/`x86`）、`cpuAddressSize`（`32`/`64`）、`supports64BitProcesses`/`supports32BitProcesses`（由地址宽度推得）、`playerType`（`"Desktop"`）、`manufacturer`（`"AS-AOT"`）、`isDebugger`（`false`）、`touchscreenType`（`"none"`）、`language`（locale 派生 ISO 639-1）、`screenResolutionX`/`screenResolutionY`（SDL2 主屏尺寸，headless 为 0）、`screenDPI`（`72.0` 回退，无逐屏 DPI 查询）、`screenColor`（`"color"`）、`pixelAspectRatio`（`1.0`）、`hasAudio`（`true`）；类型转换 `String(x)/Number(x)/Boolean(x)/int(x)/uint(x)`；内建构造器调用 `Array(...)/Object(...)/Vector.<T>(...)`（无 `new` 亦可，但 **`Vector.<T>(arrayLike)` 是「转换」而非「构造」**——与 `new Vector.<T>(length)` 语义不同，见下方类型映射表）；`Object(x)` 有参恒等返回、primitive 装箱为 `any`；URI 编解码 `encodeURI/decodeURI/encodeURIComponent/decodeURIComponent/escape/unescape`；`Boolean` 方法 `toString/valueOf`；`undefined` 全局常量；对象字面量 `{}`（字符串键关联数组）；顶层 `JSON` 类 `stringify`/`parse`（递归序列化/解析对象、数组与基础类型）；异常 `throw`/`try`/`catch`/`finally`（基于 `setjmp`/`longjmp`）；`Date` 类（构造器重载 `new Date()`/`new Date(ms)`/`new Date(year,month,day,...)`/`new Date(str)`，静态 `Date.parse(str)`，访问器 `getTime/getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds`，格式化 `toDateString()`/`toUTCString()`）；`RegExp` 类（正则字面量 `/pattern/flags` 与 `new RegExp(pattern, flags)`：`test`/`exec`/`source`/`global`/`ignoreCase`/`multiline`/`dotall`/`extended`/`lastIndex`，支持 `i/m/s/g/x` 五 flag；内嵌自研 ES3 回溯正则 VM：捕获/非捕获组、反向引用、前瞻、惰性/贪婪量词、字符类与 `\d\w\s` 转义；`String.match/search/replace` 正则版：`match` 返回捕获数组或 `null`、`search` 返回首匹配位置、`replace` 支持 `$1`~`$9`/`$&`/`$$` 替换及函数替换 `repl:Function`）；`Vector.<T>` 类型安全数组 `push/pop/join/indexOf/slice/concat/splice/forEach/map/filter/sort/reverse`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`、字面量 `new <T>[...]`、索引读写与越界检查；`Array.sortOn(field, options)`（按对象字段排序，支持 `Array.NUMERIC`(16)/`Array.DESCENDING`(2) 及 `NUMERIC \| DESCENDING` 组合）、`Array.concat` 接受动态元素；`Function.apply(thisArg, argsArray)`（从数组取参调用函数值）；动态方法调用（`Object` 类型或 `any` 接收者未命中静态签名时，经方法反射表 `as_dyn_call` 按名派发到类方法） |
| 语义 | **每个子表达式只求值一次**（阶段八十九·三十八）：AS3 的求值规则是「一个操作里的每个操作数按从左到右各求值一次」，而生成 C 的若干形态会把同一操作数内联到多处（成员写含写屏障、属性 getter 读要经 vtable、`as` 先判定后取值、接口 `==` 比两个字段、`Function` 值调用读闭包与其 env、正则参数读 `compiled`/`global`、`Boolean(str)` 读两遍串）——凡操作数可能带副作用（`isPureExpr` 判否）即先落临时变量（`hoistImpure`），故 `box.get().label = "Z"` 的 getter 只跑一次（修前 3 次）、`h.getFn()()` 与 `s.replace(h.mkRe(), …)` 只跑一次（修前各 2 次）；模块级 `var` 初始化（`emitTopLevel` 的另一条路径）与 `for` 的 init、`throw` 的值也补上了同一遍 `sequenceValueExpr`。**真值语义**（阶段八十九·三十八，AIR 51.4.1 实测对照）：`Boolean(x)`/`if (x)` 对**非空引用**（对象/数组/Vector/Dictionary/类实例/接口值/函数）恒为真（此前按 `ToNumber(x) != 0` 判，对任何对象都得假），对 **NaN** 恒为假（C 的 `if (d)` 会把 NaN 当真，故新增 `as_num_truthy(x) = x != 0 && !isnan(x)`，静态 `Number` 条件与 `any` 装箱路径同走此判定）；`/` 恒为 `Number`（AS3 语义）；`%` 的**零除数**按 AS3 语义有定义（`5 % 0` 得 `NaN`、`var r:int = 5 % 0` 得 `0`、`INT_MIN % -1` 得 `0`），按值走 `as_int_rem`/`as_uint_rem` 守卫（C 的整数 `%` 在零除数/`INT_MIN % -1` 上是 UB，wasm 下按规范 trap）；`+` 遇字符串自动拼接并装箱，且**动态（`*`）参与时由运行时值判定**（阶段八十九·三十四）：`emitBinary` 在有 `any` 参与时改为调用运行时助手 `as_add_v`，按 ES3 ToPrimitive —— 任一侧运行时是 String（或会 stringify 的对象）即拼接、否则数值相加，结果装箱为 `any`。实测 `var a:Array=["x","y"]; a[0]+a[1]` 得 `"xy"`（此前为 `0`）、`var d:*="x"; d + 1` 得 `"x1"`（此前为 `1`）、`null + 1` 得 `1`（此前 `(NULL + 1)` 直接 C 编译失败）。已知简化：对象/数组箱在拼接侧仍按 `as_v_str_val` 渲染，故 `[Array] + 1` 得 `[Array]1` 而非 AS3 的 `1,21`；`trace`/`String(Number)` 输出 IEEE-754 double 的**最短 17 位表示**（`trace(1/3)` → `0.3333333333333333`）；`Date.getTime()` 返回真实毫秒时间戳（`gettimeofday`）；`is`/`as` 基于 vtable 的 `super` 链做运行时类型检查；数组元素为动态类型（`as_value` 装箱），异构元素自动处理；异常经 `setjmp`/`longjmp` 跳转到最近的活跃 `catch` 处理，`finally` 始终执行（**wasm 目标同样可用**：阶段八十九·三十五打通了 EH 链接——`-lsetjmp` + 标准异常处理提案 `try_table`，9 个含 `try/catch` 的示例跨 native/wasm 输出逐字节一致）；位运算按 AS3 语义转换到 32 位整数（`>>>` 为无符号右移）；`Object`/`any` 类型的动态索引/属性访问经反射表（字段偏移 + 方法表）落到真实类实例，未命中时回退记录槽（`obj[key]`/`obj.prop`/`obj[key] = v`/`obj.prop = v`）；条件上下文（`if`/`while`/`?:`/`&&`/`\|\|`/`!`）对 `any` 值按 AS3 truthiness 判定（`null`/`undefined`/空串为假，非零数与非空对象为真）；**静态 `String` 同一口径**（空串为假，经 `as_str_truthy` 单次求值，阶段一百二十五）；**顶层脚本作用域是整个顶层语句树**（阶段八十九·三十四）：块 / `if` / `for` init / `switch` case / `try` 内写的 `var`/`const` 与顶层声明**共用同一个** C 文件作用域全局（`for (var i…` 的初始化直接发射成 `for (g_i = 0; …)`，循环后 `trace(i)` 读同一槽），闭包也直接读写该全局而非拿创建时刻的副本（同一循环变量的三个闭包调用都得终值）；顶层 `for-in`/`for-each` 的**循环变量**同样提升为脚本作用域全局（阶段八十九·三十七）：其 C 类型不在源码里（取决于可迭代对象——`Array` 得 `int` 下标、动态对象得 `char*` 键、`Dictionary`/动态对象值得装箱值、`Vector.<T>` 得元素类型、源码标注优先），由 `collectScriptDecls` 与 `emitModuleVars` 用**同一个** `loopVarType` 规则推出，故循环后 `trace(k)` 读到末轮的键（与 AIR 一致；AIR 实测变量确实存活）。函数体内的循环变量仍按本子集函数级提升惯例留块内局部 |

## 类型 → C 映射

| AS3 | C |
|-----|---|
| `int` | `int` |
| `uint` | `unsigned int` |
| `Number` | `double` |
| `int64` | `int64_t`（**opt-in 增强**：类型名在 AIR 里不存在，写出来才生效；字面量 `123L`、转换 `int64(x)`） |
| `uint64` | `uint64_t`（同上；字面量 `123UL`/`123LU`、转换 `uint64(x)`） |
| `Boolean` | `bool` |
| `String` | `char*`（拼接/装箱走 `as_str_*` 运行时助手） |
| `Array` | `as_array*`（动态扩容、异构元素装箱为 `as_value`；元素类型为动态 `*`） |
| `Vector.<T>` | `as_vector_<T>*`（按元素类型 `T` 单态化：连续元素数组 `T* data` + `length`/`capacity`；索引越界抛 `RangeError #1125`；编译期强制元素类型；`push/pop/join/indexOf/slice/concat/splice/forEach/map/filter/sort/reverse`、`.length` 读写、带参构造 `new Vector.<T>(length, fixed)`、字面量 `new <T>[...]`）。`T` 可为 **`*`**（阶段九十八·一：元素是 `as_value` 装箱）与 **`Class`/`Dictionary`**（阶段一百零九：`Class` 早已是 `as_class*`，`Dictionary` 早已有反射名，补上单态化判定即可 ⇒ **away3d 的 `Vector.<Class>` 7 处调用的墙已清**，元素槽按 `GCT_PTR_ARRAY` + 写屏障）；**`*`/`Object` 接收者的动态访问**（`.length` 读写、整数下标读写、16 个方法）自**阶段九十八·二** 起可用（越界/负下标 `#1125`），并与静态路径转调同一批单态化助手。**两种调用形态语义不同**（阶段一百零九，逐项对 `adl 51.4.1`）：`Vector.<T>(arrayLike)` 是**转换**（逐元素转换拷贝，`length` 按 array-like 协议动态读，标量/`null` 抛 `TypeError #1034`、零参抛 `ArgumentError #1112`、密封实例按 `ReferenceError #1069`）；`new Vector.<T>(length)` 是**构造**（参数须 `uint`，否则 `ArgumentError #2005`；`fixed` 形参接受但本子集未强制） |
| `Function` | `as_fn`（指向闭包记录 `{ thunk, env }` 的指针；每个被用作值的函数生成一个 thunk，把装箱参数列表解箱、调用带类型的实现、再把结果装箱回 `as_value`；捕获外层局部变量的闭包额外生成环境 struct + 堆分配构造器，env 指向该环境） |
| 对象字面量 `{}` | `as_object*`（字符串键关联数组，属性值装箱为 `as_value`） |
| `RegExp` | `RegExp*`（`{ vtable; as_regex* compiled; source; flags; lastIndex; global/ignoreCase/multiline/dotall/extended }`；`compiled` 为内嵌回溯 VM 的编译产物，构造时编译，编译错误抛 `SyntaxError`） |
| 类 `Foo` | `struct Foo` + `Foo*`；首成员为 `Foo_vtable*`（虚表：`super` 链 + 方法/getter/setter 函数指针，统一扁平槽列表保证子类 vtable 与父类前缀布局兼容）；字段平铺（父类字段在前）；方法编译为 `Ret Foo_method(void* this, ...)`，调用走 `obj->vtable->method(obj, ...)`；实例 getter/setter 同为虚派发（`obj->vtable->get_prop(obj)` / `obj->vtable->set_prop(obj, v)`），静态访问器与 `super.property` 仍静态直调；命名空间内的类用包前缀命名（`foo.bar.Baz` → `foo_bar_Baz`） |
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

## 在 AIR 之外（增强，非对齐）

我们的产物是一份可读 C 再交给 `clang -O2`，能链 Skia/libcurl/SQLite、吃 LTO/PGO、与宿主 C 互调、
编到 native/WASI/web，故可在 AIR **未定义 / 不支持 / 没有对应物**的地方做增强（增强必须 opt-in、
绝不静默）。判据：同一输入 `adl` 能跑对我们跑不出 ⇒ 遗留缺陷；`adl` 本来就报错或 API 不存在 ⇒ 才是增强。

**已实现（6 / 16）**：

- **显示器刷新率查询** — `VsyncStateChangeAvailabilityEvent` 增加只读 `refreshRate:Number`（AIR 无任何刷新率 API，只读 `available` 实测恒 `false`）
- **多格式图片解码** — WebP / BMP / ICO（`--features formats`；默认与 AIR 同报 `#2124`）
- **相机 RAW / DNG** — `Loader.load("*.dng")` 直接出图（`--features raw`，native）
- **SVG 运行时解码** — `Loader.load("*.svg")` → `Bitmap`（`--features svg`，native）
- **64 位整数** — `int64` / `uint64`（AIR 无此类型名）
- **LTO / PGO 构建开关** — 清单 `lto`/`pgo`、CLI `--lto`/`--pgo`

完整 16 项清单（余 Lottie、原生着色器、FFI、服务端出图…）与五条判定标准见
[`docs/zh-cn/enhancements.md`](docs/zh-cn/enhancements.md)。

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
- `examples/any-add.as` — 动态 `+`（任一侧为 `*`）：运行时判定拼接/相加、`null` 参与、`+=`
- `examples/any-dot-write.as` — `*` 接收者的点写入（已知字段、密封类未知属性、record 槽、数组元素缓冲）
- `examples/stdlib.as` — `String` 方法、`Math`、全局函数、类型转换、对象可读 `trace`
- `examples/oop2.as` — `const`/`static` 字段与方法、`get`/`set` 访问器
- `examples/interface.as` — `interface`/`implements`、接口 `is`/`as`、接口方法派发
- `examples/stage4.as` — 接口 + 静态成员 + 访问器 + `final` + `Object.toString` + `Number` 默认 `NaN`
- `examples/stage5.as` — 默认参数、rest 参数、`Function` 值与匿名函数
- `examples/stage6.as` — `package`/`import` 语法兼容层（命名空间扁平化）
- `examples/stage7.as` — `throw`/`try`/`catch`/`finally`、内建 `Error`、异常重抛与嵌套
- `examples/stage8.as` — 位运算 `& | ^ ~ << >> >>>` 及复合赋值、标签语句
- `examples/stage9.as` — `Error` 子类精确 `catch` 与冒泡、`Date` 日历访问器
- `examples/stage12/` — `package foo` 跨文件定义类、`import` 后实例化、同包 `internal` 可见
- `examples/stage10.as` — `Vector.<T>` 类型安全数组与越界 `RangeError`
- `examples/stage11.as` — 闭包（捕获外层局部变量、逃逸、独立计数、带参）
- `examples/stage13.as` — `null` 装箱语义、字符串 arena 分配压力测试
- `examples/stage14.as` — `trace`/`String(Number)` 17 位最短表示、`Date.getTime()`
- `examples/stage15.as` — 模块级 `const`/`var` 对自由函数可见、无类型变量截断防护、顺序初始化
- `examples/stage16.as` — `String.replace`（字符串版）、`Number.toFixed`/`toExponential`/`toPrecision`
- `examples/stage17.as` — `Vector.<T>` 的 `join`/`indexOf`/`.length` 赋值/带参构造
- `examples/stage18.as` — 基本类型 `is`/`as`（编译期求值 + `any` 运行时 tag 判定）
- `examples/stage19.as` — `Array`/`Vector` join 优化、有意简化项验证
- `examples/stage21.as` — `Number`/`int`/`uint` 的 `toString(radix)`（2~36）、`valueOf`、静态常量
- `examples/stage22.as` — `String` 的 `concat`/`fromCharCode`/`localeCompare`/大小写/`startsWith`/`endsWith`
- `examples/stage23.as` — `Boolean.toString`/`valueOf`、`undefined`、URI 编解码
- `examples/regexp.as` — 正则字面量/`new RegExp`、`test`/`exec`/捕获组/`lastIndex`、`String.match/search/replace` 正则版、字符类/量词/反向引用/前瞻、`i/m/s/x` flag
- `examples/stage28.as` — `Array()`/`Object()` 构造器形式（含无 `new`）、`Vector.<T>` 的 `new`＝构造 vs 无 `new`＝转换
- `examples/stage33.as` — `Event`/`EventDispatcher` 事件三阶段分发
- `examples/stage34.as` — 显示列表 `DisplayObject`/`DisplayObjectContainer`/`Stage`/`Sprite`
- `examples/stage35.as` — 交互事件与命中测试（inside-out 分发、`mouseChildren`/`visible`、鼠标/键盘/焦点）
- `examples/stage36.as` — Skia 最小闭环（`Shape` → `Stage.render` 离屏 PNG）
- `examples/stage37.as` — `Shape`/`Graphics` 绘制、`Bitmap`/`BitmapData` 像素读写、嵌套 `Sprite` 渲染
- `examples/stage38.as` — `TextField`/`TextFormat` 文本渲染、`textWidth`/`textHeight`
- `examples/air-native/` — 多文件 Air 式文档类 demo（`addedToStage` 驱动 + 各内建类演示），链 Skia 输出 `air-native.png`
- `examples/air-starling-demo/` — Starling 2.x 端到端 demo（`flash.display3D` 渲染管线、着色器、事件、补间），窗口化运行
- `examples/window.as` — `Stage.showWindow` 窗口化（离屏 Skia → SDL2 上屏 + 事件循环）
- `examples/window_click.as` — 窗口内真实鼠标点击 → AS3 事件分派（`mouseDown`/`mouseUp`/`click` + 冒泡 + 重渲染）
- `examples/textflow.as` — `TextField` 排版断言（`numLines`/`maxScrollV`/`scrollV`、`wordWrap`、`appendText`/`textHeight`）
- `examples/wheel.as` — 鼠标滚轮语义（1 delta = 1 行、`scrollV` 钳制、未命中不派发）
- `examples/frame.as` — `ENTER_FRAME` 广播语义（深度优先派发）
- `examples/stage41.as` — `Stage` 属性读回（`stageWidth`/`stageHeight`/`color`/`quality`/`frameRate` 等）+ 常量类
- `examples/stage67.as` — `DisplayObject.cacheAsBitmap`（默认 false、读写、继承、toggle 失效安全）
- `examples/cacheasbitmap.as` — `cacheAsBitmap` 渲染验证（开关两态逐像素一致）
- `examples/autobake.as` — 增量重绘自动 `cacheAsBitmap`（静止触发烘焙、移动失效重烘焙）
- `examples/bakecrisp.as` — 烘焙分辨率与 `BitmapData.draw` 几何口径（对齐 `adl`）
- `examples/stage83.as` — Stage3D 对齐加固（CubeTexture/RectangleTexture、render-to-texture 像素断言、实例化绘制）
- `examples/stage86.as` — `flash.utils` 反射（`getQualifiedClassName`/`getDefinitionByName`/动态实例化）
- `examples/stage87.as` — `Context3D` 骨架补方法（stencil/scissor/缓冲上传读回/`drawTriangles`）
- `examples/stage88.as` — AS3 语言特性缺口补齐（对象字面量字符串键、逻辑赋值、`for each`、命名空间等）
- `examples/stage89.as` — AS3 语言特性缺口第二批（严格相等、泛型默认参数、`for` 多变量声明等）
- `examples/stage82.as` — Metal 端到端彩色三角形（AGAL→MSL 翻译 + `Context3D` 全链路 + 像素读回）
- `examples/stage81.as` — `Stage3D` + `Context3D` 骨架（`stage3Ds`/`requestContext3D`/状态机 + 常量断言）
- `examples/stage80.as` — AGAL 字节码内核（MSL/GLSL 翻译、寄存器映射、swizzle/write-mask、比较指令）
- `examples/stage79.as` — Stage3D 前置几何类（`Vector3D` + `Matrix3D` 运算与 `decompose`/`recompose`）
- `examples/stage66.as` — `Vector.<T>` 高阶/序列方法（`slice`/`concat`/`splice`/`forEach`/`map`/`filter`/`sort`/`reverse`）
- `examples/stage65.as` — `flash.system.Capabilities` 环境能力查询
- `examples/stage64.as` — `flash.filesystem`（`File` 路径/目录操作、`FileStream` 异步读写、`FileMode`）
- `examples/stage63.as` — `flash.net`/`flash.ui`（`URLRequest`/`URLLoader` 异步读本地文件/`URLVariables`/`Keyboard`/`Mouse`）
- `examples/http-request-api.as` — `flash.net` 语义面（`URLRequest` 属性默认值、`URLRequestDefaults`、`URLVariables.decode`、`useRedirectedURL`）
- `examples/loader-url.as` — `Loader.load` 的来源分流与错误号（`#2124`/`#2035`，远程走传输 seam）
- `examples/urlloader-contract.as` — `URLLoader` 契约（事件顺序、`close()`、`dataFormat`、失败错误号 `#2032`）
- `examples/urlloader-network-unsupported.as` — 远程 URL 在无后端构建下的诚实失败
- `examples/stage62.as` — `flash.display` 补齐（`MovieClip` 时间轴、`SimpleButton` 四态、`Loader`/`LoaderInfo`）
- `examples/stage61.as` — `flash.filters` 滤镜（默认值/构造/`clone`/`DisplayObject.filters`/`applyFilter`）
- `examples/stage60.as` — `flash.utils.Timer`（重复触发/`TIMER_COMPLETE`/`stop`/`reset`/`delay` 校验）
- `examples/stage59.as` — `flash.events` 事件子类（`TimerEvent`/`ProgressEvent`/`ErrorEvent`/`IOErrorEvent`/`DataEvent`）
- `examples/stage58.as` — `flash.geom` 2D 几何（`Point`/`Rectangle`/`Matrix`/`ColorTransform`/`Transform`）
- `examples/stage57.as` — 精确 GC 泄漏断言（临时 record/array 对象 `System.gc()` 回收归零）
- `examples/gc_strings.as` — 字符串纳入 GC 堆的泄漏断言
- `examples/gc_incremental.as` — 增量标记内存有界断言
- `examples/gc_barrier.as` — 写屏障压力断言
- `examples/gc_midframe.as` — 中帧 `System.gc()` 断言（守护保守栈扫描根来源）
- `examples/closure_const.as` — 类型化 `const` 被闭包捕获的断言
- `examples/sharedobject.as` — `flash.net.SharedObject` 本地存储（读写/`flush`/磁盘回读/`size`/`clear`）
- `examples/gc_alloc_threshold.as` — 非 GUI 目标的分配阈值自动回收
- `examples/gc_bytes.as` — `ByteArray`/`BitmapData` 字节缓冲纳入 GC
- `examples/loop-once.as` — 循环条件与 `for` update 每轮只求值一次
- `examples/field-shadow.as` — 同名字段遮蔽各占一个 C 槽 + 容器元素自增 + 分支内副作用不外泄
- `examples/null-eq.as` — null 只有一种表示（`==`/`!=`/`===`/`!==`/`typeof`/真值/`is Object`）
- `examples/async-io.as` — 异步 IO 契约（终态事件前 `data` 为 `null`、`PROGRESS` 先于 `COMPLETE`、并发请求）
- `examples/socket.as` — `flash.net` 套接字层（`Socket`/`ServerSocket`/`XMLSocket` 环回断言）
- `examples/proxy.as` — `flash.utils.Proxy` / `flash_proxy` 拦截
- `examples/with.as` — `with` 语句
- `examples/stage94c.as` — `getQualifiedSuperclassName` + `setInterval`/`clearInterval`
- `examples/stage94d.as` — `ByteArray` 多字节/布尔/下标读写/AMF3 对象读写
- `examples/stage94e.as` — A 批遗留攻坚（`as Object`、Function 值成员调用、反射、AMF3 trait）
- `examples/stage94f.as` — `DisplayObject` 几何与变换感知命中测试
- `examples/stage94g.as` — 可编辑 `TextField` 的模型与默认值
- `examples/stage94h.as` — `TextField.border`/`borderColor` 与颜色属性的 24 位口径
- `examples/stage94i.as` — `DisplayObject` 几何/坐标 API 族（`getRect`/`getBounds`/`localToGlobal`/`hitTestObject`）
- `examples/stage94j.as` — `MouseEvent.DOUBLE_CLICK` 的派发语义
- `examples/stage94k.as` — 空接收者成员访问的 `#1009`/`#1006` 语义
- `examples/stage94l.as` — `Tab`/`Shift+Tab` 焦点遍历
- `examples/stage94m.as` — `TextField.restrict` 与多行 `Return`
- `examples/stage94n.as` — 视觉行导航（`PageUp`/`PageDown` + 软换行 `Up`/`Down`）
- `examples/stage94o.as` — `displayAsPassword` 遮罩
- `examples/stage94p.as` — IME 合成中态（marked text）预览
- `examples/stage94q.as` — 字符串字面量的转义解码
- `examples/stage94r.as` — `TextField` 边框是屏幕空间 1px 线（不污染局部度量）
- `examples/stage94s.as` — `hitTestPoint` 的 `true` 分支是内容区域（非包围盒）
- `examples/stage94t.as` — `int64`/`uint64` 64 位整数（增强，见 `docs/zh-cn/enhancements.md` §4.7）
- `examples/textline.as` — `TextField.getLineMetrics` / `TextLineMetrics`
- `examples/bytearray-index.as` — `ByteArray` 下标形式的完整语义
- `examples/vector-coerce.as` — `Vector.<T>(arrayLike)` 是转换、`new Vector.<T>(length)` 是构造
- `examples/vector-dynamic.as` — `Vector.<*>` 与 `*` 接收者的动态访问
- `examples/embed.as` — `[Embed]` 资源（图片/字节/音频 → `Bitmap`/`ByteArray`/`Sound` 子类）
- `examples/strcoerce.as` — 对象 → 字符串的隐式强转
- `examples/flash-net-layered.build.example.json` — 构建清单按目标分层的最小示例（非 `.as`，供构建层断言）
- `examples/builtin-class.as` — 内建类注册表 & Class 值 + `in`/`delete`/下标
- `examples/wasm-native/` — `--target wasm`（WASI）产物，含 `--export` 与 `[WasmExport]` 导出面
- `examples/vsyncevent.as` — `VsyncStateChangeAvailabilityEvent`（AIR 面 + `refreshRate` 增强面）与 `Stage.vsyncEnabled`
每个示例编译后会在旁边留下同名 `.c` 文件，可直接阅读编译器生成的 C 代码。

## 鸣谢

本项目站在以下项目与第三方库的肩膀上，谨此致谢：

- **[TypePHP](https://github.com/swoole/typephp)**（[官网](https://swoole.com/aot/)）——把 PHP 编译成原生二进制的 AOT 编译器。「编译器前端只负责翻译、优化与机器码生成交给成熟 C 编译器、不重复造轮子」的整体思路，以及构建清单（`project.yml`）与多目标后端设计，均借鉴自它。
- **[Ruffle](https://github.com/ruffle-rs/ruffle)**（[官网](https://ruffle.rs/)）——Adobe Flash 的开源 Rust 重实现。其 AS3/AVM2 的 `flash.events.*` 事件流、`flash.display.*` 显示列表与交互命中测试实现，是本项目 GUI/事件系统语义的权威参照。
- **[Skia](https://github.com/google/skia)**（[官网](https://skia.org/)）——2D 图形库，渲染后端。本项目经 C++ 胶水层链接 Skia 实现光栅化（采用 [Aseprite 预编译静态库](https://github.com/aseprite/skia/releases) m124）。
- **[SDL](https://github.com/libsdl-org/SDL)**（[官网](https://www.libsdl.org/)）——跨平台窗口/输入库，窗口化后端（`Stage.showWindow`）经 SDL2 上屏与事件循环。
- **[miniaudio](https://github.com/mackron/miniaudio)**（v0.11.25）——单头文件音频库，`flash.media` 的音频后端（`vendor/audio_glue.c` 独立编译单元，`Sound`/`SoundChannel`/`SoundMixer`/`SoundTransform` 等由它驱动 Core Audio；web 端落到 Web Audio，WASI 无后端则如实报明）。
- **[libcurl](https://github.com/curl/curl)**（[官网](https://curl.haxx.se/)）——`flash.net` 的 HTTP/HTTPS 客户端。native 构建以**静态**归档链接 `vendor/curl/`（curl 8.11.1 + [nghttp2](https://github.com/nghttp2/nghttp2) 1.64.0 提供 HTTP/2 + [zlib](https://zlib.net/) 1.3.1 解码 gzip/deflate，TLS 走系统 SecureTransport），产物不残留 `libcurl.4.dylib` 动态依赖。
- **[Emscripten](https://emscripten.org/)**（[官网](https://emscripten.org/)，3.1.44）——`--target wasm --package web` 浏览器产物的工具链（`build-tools/emsdk`），经 `emcc` 编译链接 wasm 版 Skia；web 音频后端也用其随附的 `emscripten/webaudio.h`（AudioWorklet）。
- **[HarfBuzz](https://github.com/harfbuzz/harfbuzz)**——文本 shaping 引擎，随 Skia 的预编译静态库一同引入，`flash.text` 的 `TextField`/`TextFormat` 排版（SkParagraph + HarfBuzz shaping + UAX#14 换行）由它完成。
