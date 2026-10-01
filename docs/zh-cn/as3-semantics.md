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
| `+` 遇字符串自动装箱拼接 | ES4 draft（ToPrimitive：任一侧为 String 即拼接；对象默认 hint → toString） | 静态任一侧是 `String` 走 `as_str_concat`/`as_str_from_*`；任一侧是 `any`/`null`（含 `*`、数组元素、动态属性）走**运行时**助手 `as_add_v`（按运行时 tag 判拼接 vs 相加，结果 box 成 `any`）。**禁止**把动态值直接当数字相加——`var a:Array=["x","y"]; a[0]+a[1]` 曾得 `0`，现得 `"xy"` | ✅ 已实现（阶段八十九·三十四；对象/数组箱的**文本**仍按 `as_v_str_val` 渲染，故 `[Array] + 1` = `[Array]1` ≠ AS3 的 `1,21`，属已知简化） |
| 字符串 `==/!=` 是值比较 | ES4 draft | `strcmp` | ✅ 已实现 |
| `Number` 未初始化默认值 = **`NaN`** | ES4 draft + AVM2 | `defaultInit` 的 `number` 分支输出 `NAN` | ✅ 已实现（emit.ts `defaultInit`） |
| `int`/`uint` 默认值 = `0`，`Boolean` = `false` | ES4 draft | 类型一经推断不可变 | ✅ 已实现 |
| `String` 默认值 = `null`，引用类型 = `null` | ES4 draft | 已按 `null` 处理 | ✅ 已实现 |
| `is`/`as` 是**运行时类型测试**（基于真实类身份） | ES4 draft + AVM2 | vtable `super` 链做 RTTI + 基本类型 `any` tag 运行时 | ✅ 已实现（对象 + 基本类型 + `any`） |
| `switch` 仅 `int`/`uint` 原生 fall-through，其余降级 `if/else` | ES4 draft + AS3 参考 | 非整型判别式降级严格相等链 | ✅ 已实现 |
| 方法闭包**正确绑定 `this`**（提取 `obj.method` 得到永久绑定 `obj` 的闭包） | ES4 draft | `as_fn_make(..., __bound, (void*)obj)` 绑定接收者 | ✅ 已实现（emit.ts 方法值/闭包） |
| 类默认**密封**（sealed），`dynamic class` 才允许 expando | ES4 draft + AVM2 | 类固定 shape（字段平铺 + vtable） | ✅ 已实现（未支持 `dynamic`） |
| 数值强制转换：`int↔uint↔Number` 回绕、`Number→int` 截断；`NaN`/`±Infinity` → 0 | ES4 draft + ECMA-262 §9 | `as_to_int32`/`as_to_uint32` 对应 AS3 `ToInt32`/`ToUint32`（NaN/Inf → 0，避开 C `(int)` 强转 NaN 的 UB） | ✅ 已实现（emit.ts 位运算/强制转换 + runtime.ts 助手） |
| `for-in`/`for-each` 的集合表达式**只求值一次** | ES4 draft | 先发射一次临时（`hoistCollection`），否则 getter 反复执行甚至死循环 | ✅ 已实现（阶段八十九·十九） |
| `typeof` 是**运行时**算子，看值的动态类型（`var o:Object = 1` → `"number"`；函数值 → `"function"`） | ES4 draft | `Object`/接口槽走 `as_ptr_typeof`（按 vtable 判号），`any` 走 `as_v_typeof`；**不按静态类型折叠** | ✅ 已实现（阶段八十九·十九） |
| `super.m` 作**值**使用时绑定超类实现（`var f:Function = super.m` 不等于 `this.m`） | ES4 draft + AVM2 | 发射 `${owner}_${mname}__superbound` thunk，`env` 造型为超类指针，不经接收者虚表 | ✅ 已实现（阶段八十九·十九） |
| **脚本只有一个作用域**：顶层任意位置（块 / `if` / `for` init / `switch` case / `try`）的 `var`/`const` 与顶层声明同为脚本作用域属性，同一名字只有一个槽；闭包读的是**属性**（共享），不是创建时刻的快照 | ES4 draft（script scope ≈ 全局对象属性）+ AVM2 | `collectScriptDecls()` 扫**整个顶层语句树**提升为 C 文件作用域全局，同时作为 `emitModuleVars` 与闭包 `scriptVarNames` 的唯一来源；发射期「顶层且是模块全局 → 只赋值」 | ✅ 已实现（阶段八十九·三十四）。例外：顶层 `for-in`/`for-each` 的**循环变量**留块内局部（元素类型发射期才定） |
| `hasOwnProperty`/`in` 对**本类与所有超类**声明的任意 trait（字段、访问器（getter 或 setter）、方法）为 `true` | AS3 参考（对照 `mxmlc`+`adl` 实测） | `Object_hasOwnProperty` 委托 `as_dyn_has`（同步走 props/getters/methods/**setters**），保证两算子永不矛盾 | ✅ 已实现（阶段八十九·十九） |
| 访问器属性可被**动态写入**（`o["alpha"] = v`，`o:Object`） | AS3 参考 | vtable 头部带 `setters` 反射表，`as_dyn_set` 查完 props 后走 setters 再回落动态槽 | ✅ 已实现（阶段八十九·十九） |
| `Object`/接口槽内的原始值（`var o:Object = 1`）需**自动装箱**，取出时再拆箱 | ES4 draft | `as_value_to_obj`/`as_obj_to_value` 成对；每个装箱类型有自己的 `GCT_*` 标记与 `gc_scan` 分支 | ✅ 已实现（阶段八十九·十九，含 boxed `Boolean`/`Function`） |
| 内建属性若 AS3 定义为**访问器**（如 `ByteArray.length`），赋值需触发副作用（重分配） | AS3 参考 | 同时在 `fields`（C 结构体需要）与 `getters`/`setters` 注册，手写 getter/setter | ✅ 已实现（阶段八十九·十九） |
| 构造函数实参（含副作用）**只求值一次**（`new XML(ba.readUTF())`） | ES4 draft | 单次求值 C 助手（`as_xml_parse_str_checked`），不用临时变量提升（会改变短路/三元/循环条件内的求值时机） | ✅ 已实现（阶段八十九·十九） |
| GC：写入**新生 GC 块**（尤其扩容 `memcpy`）的指针必须重新置灰 | 本项目 GC 不变式 | `gc_write_barrier`/`gc_write_barrier_value`；详见 [`gc.md`](gc.md) §6.5.1 |
| `Context3DClearMask` 是 **uint 位掩码**（COLOR=1/DEPTH=2/STENCIL=4/ALL=7），不是字符串 | AS3 参考（adl 实测，`temp/refcheck/Mask.as`） | `intConstClass('Context3DClearMask', {...})`；`clear(..., mask)` 按位与 |
| `Context3D.clear(..., depth, stencil, mask)` 的 `stencil` 是**模板清屏值**（Starling 用 `DEFAULT_STENCIL_VALUE=127`，非 0） | AS3 参考 + Starling `Painter`/`RenderUtil` | 清屏值必须逐层转发到渲染后端（`as_s3d_clear` → `clearStencilValue`）；硬编码 0 会让整场遮罩失效 |
| Stage3D 裁剪空间 **Y 向下**，与 Metal（Y 向上）相反 ⇒ 几何绕序整体相反，`cullMode=Back` 会剔掉该保留的面 | 后端适配（非 AS3 语义差异，但同属「不可静默透传」） | 每个绘制 `setFrontFacingWinding:MTLWindingClockwise`；`FRONT_AND_BACK` ≈ Metal `None`（不剔除） |
| 逐绘制状态设置器（`setDepthTest`/`setStencilActions`/`setSamplerStateAt`）被每批次调用 ⇒ **先比较再标脏** | 性能不变式（非语义） | 每次调用无脑重建 `MTLDepthStencilState`/采样器 = 每绘制一次驱动对象分配，渲染会掉到不可用 | ✅ 已实现（阶段八十九·十九，8 处扩容站点） |

---

## 3. 决策分歧点（需项目内明确）

| 分歧 | AS3 语义 | 本项目现行 | 建议 |
|------|---------|-----------|------|
| `var x;`（无类型无初值）默认类型 | `*`（any）/ `undefined` | 无类型仍按 `int`（`symbols.ts` 约定）；显式 `*` 已建模为 `any`（`as_value` 装箱） | **维持现状**——无类型默认 `int` 是极简约定；但阶段十五起引用类型赋给推断 `int` 抛 `CodegenError`，不再静默截断 |
| `Number` 默认值 | `NaN` | ✅ 已修复（`defaultInit` 输出 `NAN`） | 无需处理 |
| `%` 零除数且结果落在**动态**类型使用点（`var x:* = a % 0`） | `NaN`（`Number`） | 守卫后的 int/uint `0`（未防护前是 UB：`-O2` 折成被除数 `5`，wasm 则 trap） | **维持现状**——要给出 NaN 就得把 `int % int` 整体变成 `double`，但那样 `7 % 3 is int` 会变 false（adl 实测为 **true**），静态类型反而更不忠实；零除数本身即 app 缺陷，而 AS3 在 int/uint 接收点（含 `var r:int = 5 % 0`）自己也给 0 |
| **帧率口径**（呈现节拍 vs 逻辑帧率） | `Stage.frameRate` 是**逻辑帧率**：`ENTER_FRAME` 按该频率派发计数，**不跟显示器刷新率**——阶段六十一/六十二 的 adl 对照实测：窗口移到 50 Hz 外接屏后 adl 的 FPS 读数仍约 **120**（靠 delta time 保持动画速度），而我们的实现读数降为 **50** | **跟随 vsync**：native 开 `SDL_RenderSetVSync(1)` 让 `SDL_RenderPresent` 阻塞到刷新周期；web 按**整 tick** 节拍（`skip = round(1000/frameRate / rAF周期)`，每 `skip` 个 vsync 呈现一帧，阶段八十九·二十九）。故帧间隔恒为刷新周期整数倍，`frameRate` 高于刷新率时封顶到刷新率（阶段四十七/六十一/六十二） | **维持现状**——这是 50 Hz 屏上唯一无拍频的物理正确做法（关 vsync 追 120 fps 会产生 120 vs 50 拍频、帧间隔在 8/20 ms 间剧烈抖动 → 卡顿）；native 与 web 两端已一致，且**这是呈现语义而非 AS3 语义**（`frameRate` 的读回值、`ENTER_FRAME` 回调行为、delta time 驱动的动画速度三者都仍正确）。**可见口径差**只有两处：(a) 面板给不出的速率被量化到最近整数分之一（60 Hz 屏上 `frameRate=24` → 20 fps；另见 [`html5-web.md`](html5-web.md) §6.4）；(b) FPS 读数口径是「呈现帧数」而非 adl 的「`ENTER_FRAME` 派发数」。若要完全对齐 adl，需把**派发计数**与**呈现计数**解耦（按墙钟 deadline 派发 `ENTER_FRAME`/计时器，呈现仍每 vsync 一次），代价是引入「一帧内多次派发」或「派发与呈现不同步」的新语义面（`Stage_dispatchFrame` 开头的 `gc_step()` 安全点、`as_timer_tick`、脏矩形/增量重绘都要重新核对）——收益不值，故明确不做 |

| **`flash.net` 网络加载面** | AIR 的 `URLLoader`/`URLRequest` 支持 `http`/`https`/`file`/`app-storage`/`app` scheme，GET/POST（应用沙箱内可用任意 method、任意请求头），7 个事件（`complete`/`open`/`progress`/`ioError`/`httpStatus`/`httpResponseStatus`/`securityError`）、`bytesLoaded`/`bytesTotal`、`close()` 真中止；`URLRequestMethod` 6 常量（GET/POST/PUT/DELETE/HEAD/OPTIONS） | 本项目是**本地文件读取器套了一个 HTTP API 外壳**：URL 一律当文件系统路径 `fopen`（`URLLoader.load`）；`URLRequest.method`/`.data`/`.contentType` 可写但**从不被读**（**死字段**）；`URLRequestMethod`/`URLRequestHeader`/`URLRequestDefaults`/`URLStream` **四个类不存在**；`open`/`httpStatus`/`httpResponseStatus`/`securityError` **永不派发**；`close()` 是**空函数**；`bytesLoaded`/`bytesTotal` 缺失；**GET/POST 完全没有**（实测：设 `method="POST"` + `data` 后 `load()` 照样把 URL 当地路径读出本地文件） | **明确记录的差距（待实现，非「维持现状」）**——**其主体已于阶段八十九·四十八~五十三 闭合**（A/B 语义面与契约 → 四十八；G + native 探针 → 四十九；构建层 `targets` → 五十；C 内核 + D/E/F/H → 五十一；AIR 保真校正 + 验收 I → 五十二；**`Socket`/`ServerSocket`/`XMLSocket` + 静态自包含 + 代理/cookie/HTTP-2 → 五十三**；仍余 preview2 `wasi:http`、AMF、`SecureSocket` TLS、`DatagramSocket`，见 `TODO.md` 遗留表）。完整官方 API 面、现状偏差表、8 阶段路线与验收方案见 [`flash-net.md`](flash-net.md)（其中 **§4.1.2** 给出 libcurl 的**引入方式**：首期零 vendor 直接用系统库，要静态自包含才走 `build-tools/`→`vendor/`）。**A（语义层补全：常量类/字段/`decode()`）+ B（契约补全：`bytesLoaded`/`open`/`close` 真中止）无网络依赖、低风险，建议先做**（消除「设了 `POST` 却无反应」「`close()` 是空函数」等**误导性**偏差）；**C（HTTP/1.1 + TLS 客户端）之后是独立重工程**，难点是 HTTPS/TLS 与三目标分叉（native socket / web `fetch` / WASI 无 socket → 诚实 `ioError`） |

| **异步 IO 的执行位置与排空时机** | AIR 单线程 + 帧驱动事件：IO 在后台**确实并发**进行，事件按到达尽快派发；`URLLoader`/`FileStream` 在终态事件前先派 `PROGRESS`（可多次、带水位）；`Loader.load()` 对不可读 URL 与非图 payload 都派 `IOErrorEvent`（#2124「Loaded file is an unknown type」），**不**派 `COMPLETE`，数据/内容只随终态事件可见（`LoaderInfo.complete` = 「dispatched when data has loaded successfully」）；同一目标重复 `load()` 重启加载，旧请求不再派事件 | **执行位置**：native（macOS/Linux pthread）用 4 worker 池真后台 read+decode（`ASC_ASYNC_THREADS`），worker 绝不碰 GC 堆，输入提交时拷到 malloc；web/WASI/Windows 目标**同步内联**（`as_async_submit` 就地跑完，只推迟事件）。**排空时机**：结果落 malloc 暂存，只在**下一个帧边界**由 finish thunk 搬进 AS3 可见状态（`Stage_dispatchFrame` 先 `as_async_tick()` 再 `as_timer_tick()`）；headless `tickTimers()` = 等 worker 排空 + 一次排空全部 DONE（保持例程确定性）。`PROGRESS` 目前**只派一次**（`loaded == total`，读不分块无中间水位）；`LoaderInfo.PROGRESS` 仍不派发（Starling 监听的是 `URLLoader`）；`LoaderInfo.bytesTotal` 在终态才非 0 | **维持现状**——(a) 帧边界派发是 AIR 帧驱动模型的最接近实现，且「入表→thunk 跑完前不移出 job 表」是 GC 根不变式（提前移出会被 sweep 清零，已实测 SIGSEGV）；(b) native 与 web 的差别只在「读/解码是否占主线程」，web 无 worker 是既定取舍（wasm 单线程模型下 pthread 需 COOP/COEP，见 [`html5-web.md`](html5-web.md)）；(c) PROGRESS 单次是「读不分块」的直接后果，要报水位就得改分段读（N 次 read + 逐块重试语义），收益不值；(d) 纯 C 构建无解码器（`as_skia_image_decode_bytes_argb` 为返回 NULL 的桩）→ 图像加载报 IO_ERROR，解码成功路径由 skia 后端覆盖（native demo 验收）。详见阶段八十九·四十五与 `examples/async-io.as` |

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
