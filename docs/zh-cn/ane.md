# ANE（AIR 原生扩展）加载与迁移

> 本文回答一个问题：**一个现成的 AIR 原生扩展（`.ane`）要怎么在 AOT 产物里跑起来，跑不起来的
> 地方我们如实报了哪些缺陷**。核心结论先行：
>
> * 我们的运行时**扮演 AIR 宿主**：`asaot.dll` 导出全部 **51 个 FRE 入口点**，每个都转发进
>   生成程序自己的表（同一个堆、同一份类注册表）。FRE 的对象模型、扩展加载协议、
>   `ExtensionContext` 的 AS3 表面都已落地并端到端跑通（下文 A/B/C 三面）。
> * **原版 `.ane` 不能直接用**：它按 AIR 的 ABI 静态导入 `Adobe AIR.dll`，而这个 DLL 在我们
>   这儿不存在（也不该存在）。所以走**双产物**：原版 `.ane` 留给 `adl`，另编一份**对着
>   `asaot.lib` 重编过**的产物给 AOT（默认是**一棵暂存目录树，不是 `.ane`**——因为那么一份
>   重编产物 AIR 无论如何都载不进，打包没有消费者，见 §4.6）。两者的差别只有导入库与导入名，
>   **ANE 自身源码树一字不改**。
> * **本文第 4 节是重点**：从「拿到一个 `.ane`」到「AOT 产物里能 `ctx.call` 通」的完整流程、
>   每一个可验证的检查点，以及**症状 → 病因**对照表。
> * **D 面（渲染管线 / 原生窗口句柄 / Context3D）本期不实现**，11 个入口点一律返回
>   `FRE_ILLEGAL_STATE` **并在 stderr 自报**，不静默成功、不编造描述符。
>
> **状态（v0.4.161 复核）**：A/B/C 三面已落地，宿主平台目前只有 **Windows x86 / x86-64**
> 两个位宽；`macOS`/`iOS` 的宿主库**没有**（`--ane` 在那个平台上会响亮报错并给出缺失路径，
> 见 §5）。端到端证据：`examples/ane/`（**43 条断言全过**）与 `examples/ane-app/`（**8 条**，描述符那条路）、`test/unit/emit.ts` 的
> `unit: ane/ExtensionContextSurface`、`test/unit/build.ts` 的 `unit: ane/ExtensionXmlComments`
> / `unit: ane/PackageLayout` / `unit: ane/PlatformForBuild` / `build/AneHostLayout` /
> `build/WindowsArch`。

---

## 1. 判据：什么叫「一个 ANE 可用」

AIR 里一个原生扩展由三件东西组成，理解这三件东西的分工，后面的所有设计都是它的推论：

| 组成 | 是什么 | 在 AIR 里谁负责 |
|---|---|---|
| `library.swf` | **AS3 半边**：包装类，把 `ctx.call("foo")` 包成友好的 API | AIR 运行期加载并执行里面的 ABC 字节码 |
| `<platform>` 原生库 | **C 半边**：`.dll`/`.dylib`，实现 `foo`，通过 FRE 读写 AS3 值 | AIR 运行期 `LoadLibrary` 并调用其 Initializer |
| `extension.xml` | **契约**：extensionID、每个平台的原生库名、Initializer / Finalizer 导出名 | AIR 运行期解析（`extensions/` 目录下） |

三者里，**AOT 唯一必须静态化的是 `library.swf`**——它得是一堆 `.as` 源码，才能参与编译
（AGENTS.md §1.1：前端只做翻译；我们不实现 AVM2 解释器，所以 `DoABC` 字节码不在范围内）。
原生库与描述符都是**运行期**的东西，我们照 AIR 的协议在运行期处理即可。

于是判据可以一句话说完：

> **同一个 extensionID、同一份原生源码，`adl` 能跑对的，AOT 产物也得跑对；跑不对的，必须
> 是「响亮报明 + 登记为遗留缺陷」，不能是「静默返回一个看起来合理的值」。**（AGENTS.md §1.5）

---

## 2. 四个面：A / B / C / D

可行性评估把这条链路切成四个面，实现也是按这个切分做的：

| 面 | 内容 | 本期 |
|---|---|---|
| **A 面** | AS3 侧 `flash.external.ExtensionContext`（`createExtensionContext` / `call` / `dispose` / `getExtensionDirectory` / `actionScriptData` + `StatusEvent`） | ✅ 已实现 |
| **B 面** | FRE 对象模型：`FREObject ↔ as_value`、按调用作用域的 arena、**51 个入口点** | ✅ 已实现 |
| **C 面** | 扩展加载：编译期描述符表、平台加载器、`Initializer`/`ContextInitializer`/`Finalizer` 协议、函数表分派、`StatusEvent` 投递 | ✅ 已实现 |
| **D 面** | 渲染管线与原生句柄：`FREGetRenderMode` / `FRESetRenderSource` / `FREMediaBufferLock\|Unlock` / `FREAcquire\|ReleaseBitmapData[2]` / `FREInvalidateBitmapDataRect` / `FREAcquire\|ReleaseNativeWindowHandle` / `FREGetNativeContext3DHandle`（**共 11 个**） | ⛔ **本期不实现**，全部 `FRE_ILLEGAL_STATE` + 自报 |

D 面为什么单列：它不是「漏了」，是**决定延后**——它要求运行时真的有一条能收外来帧缓冲、
能与 D3D/OpenGL 互操作、能拿到窗口 HWND 的呈现管线。这一层不在本阶段的目标里，而**假装
成功是更坏的选择**：对视频类 ANE 来说，`FRE_OK` 会让扩展以为「画面已经呈现」，最终现象是
「黑屏但没人报错」。所以这 11 个入口点走的是同一条**限流**的自报通道
`[as3-aot] not implemented by this build: ...`（每程序最多 5 条，见 `src/runtime.ts:2664`；
上限的目的是让缺口**可见**而不是把日志写成流水账）。

---

## 3. 已实现的功能

### 3.1 A 面：AS3 表面按 AIR 建模，一个不多一个不少

`ExtensionContext` 是**真内建类**（`src/symbols.ts` 注册 + `src/emit.ts` 发射），不是「往工程里
放一份同名 `.as`」。这一点有硬性理由：`package` 过的用户类**顶不上** `flash.*` 内建，
实测过（想用用户侧同名 `.as` 会得到 `undefined variable 'ExtensionContext'`）。

| 成员 | 行为 | 备注 |
|---|---|---|
| `createExtensionContext(id, ctxType)` | 按 extensionID 查表 → `LoadLibrary` → 跑 `Initializer` + `ContextInitializer` → 返回上下文 | AIR 的两种 null 情形之外**不会**再有第三种；每种失败都自报 |
| `call(fn, ...args)` | 走扩展发布的函数表；扩展没发布这个名字 → 自报 + 返回 `null` | 同步调用，与 AIR 一致 |
| `dispose()` | 跑 `ContextFinalizer`，标记失效，返回 `true` | 原生库**不卸载**（其他上下文可能共用） |
| `getExtensionDirectory()` | 返回一个**活着的但无路径**的 `File`，并**自报**为什么无路径 | 见 §5 缺陷 4 |
| `actionScriptData` | 真属性，读写走与普通 AS3 属性相同的动态访问器 | FRE 侧 `FREGet/SetContextActionScriptData` 与它同一份存储 |
| `StatusEvent` 派发 | 原生侧 `FREDispatchStatusEventAsync` → 队列 → 在**调用返回前** pump 出去 | `addEventListener(StatusEvent.STATUS, …)` 必须在下一条语句前已经触发过 |
| **`extensionID` 属性** | **故意不存在** | AIR 没有它（`mxmlc` 拒绝、`adl` 报 `Error #1069`），凭空加一个反而让本编译器放行 `mxmlc` 拒绝的程序 |

「故意不存在」这一条值得单独说：它看起来「应该有」——类本来就是从一个 id 造出来的。但
**对齐 AIR 优先于直觉**：语言参考里只有 `actionScriptData` / `functions` / `knownExtensions`，
多出来的属性会把「AIR 拒绝的输入」变成「我们能过」，那是往错误方向的分歧。

### 3.2 B 面：FRE 对象模型（51 个入口点）

* **`FREObject` 就是不透明的箱子指针**：我们的 `FREObject` 指向一个**装箱的 `as_value`**。
  这样两半天然一致——扩展存/返回句柄，我们读/返回装箱值，**边界上不需要任何转换**。
* **生命周期按「调用」**：`as_ext_call` 开一个作用域，所有入口点从这里分配句柄，调用返回时
  整块释放——正是 AIR 的契约（参数在调用期间有效，运行时释放 `FRENewObjectFrom*` 造的东西）。
  所以「扩展正确地不缓存句柄」时它**不可能**看到悬空指针。
* **每次调用一次 `malloc`，不是每帧**：每调用的 scratch 区刻意**不用** arena 分配器——
  arena 是程序生命周期的（AGENTS.md §2.4），而按调用作用域的东西恰恰不是。
* **装箱 tag 四处同步**：新增 tag 必须同步补 `as_v_typeof` / `as_v_truthy` / `as_v_eq` /
  `as_v_str_val`（AGENTS.md §2.4 红线），GC 侧还要补 `gc_mark_value`。
* **`asaot.dll` 是纯转发器**：它**不持有任何 AS3 状态**，`asaot_bind(&host)` 把生成程序里的
  51 个实现装进它的表。所以扩展做的一切都落在可执行文件自己的堆与类注册表上——这就是
  「扩展里 `new` 出来的对象能被 AS3 侧 `is` 判断、能被 GC 正确回收」的原因。
* **ABI 逐字节可换**：`lib/asaot.h` 与 AIR SDK 的 `FlashRuntimeExtensions.h` 在结构体布局、
  枚举值、typedef 目标、51 个签名上一致（不抄 SDK 头文件正文）。这是「重编换名」路线能
  成立的前提。
* **扩展抛出的 AS3 异常跨边界传播**：用 `setjmp`/`as_jmp_stack` 接住，转成 AS3 异常抛给
  调用者（AIR 的 `thrownException` 语义）。实测：原生侧对一个 sealed 对象 `FRESetObjectProperty`
  → AS3 侧拿到 `prim=3 sealed=4` 的分类结果。

### 3.3 C 面：扩展加载

| 环节 | AIR 怎么做 | 我们怎么做 | 为什么 |
|---|---|---|---|
| 找扩展 | 运行期解析 `extensions/` 下每个 `extension.xml` | **编译期**解析 `--ane` 给的 `.ane` 包**或解包后的目录**，发射成 C 数据 `as_ane_descs[]` | 运行时不带 XML 引擎，也不想带（§1.1） |
| 设备 ID → 描述符 | 字符串查找 | `as_ane_index()` 线性查表（上限 `ASC_ANE_COUNT_MAX = 32`） | 表是静态的，查 32 行毫无开销 |
| 加载原生库 | `<app>/extensions/<id>/<nativeLibrary>` | `<exe 目录>/extensions/<extID>/<平台>/<nativeLibrary>` | 相对可执行文件解析（`as_ext_dir()` 用 `GetModuleFileNameA`），产物**可整体搬走**。**一扩展一目录**不是装饰：多个扩展的同名库若落在同一目录里会变成同一个文件（§5.1），而 AIR 就是把每个扩展的库放在**那个扩展自己的路径**上 |
| 初始化 | `Initializer(&data, &ctxInit, &ctxFinal)` 然后 `ctxInit(...)` | 同样 | 协议一致 |
| 调用函数 | 扩展发布的 `FRENamedFunction[]` 按名字查 | 同样，`functionData` 也按扩展给的传 | 不发明上下文槽 |
| 失败 | `createExtensionContext` 返回 null | 返回 null **且** stderr 自报，说明是「没有这个 ID」还是「库加载不了」还是「没有 Initializer」 | 静默的 null 让应用无法区分，而这是应用唯一要区分的 |

**编译期化的两个后果必须说清**：

1. **可用的扩展集在构建期固定**。AIR 能加载应用没声明的扩展；这里不在描述符表里的
   extensionID 会被自报并答 `null`——这正是 AIR 对「找不到的 ID」的答案，不是静默成功。
2. 反过来，**描述符表里有的、库丢了，也是报错不是降级**（后链接阶段检查
   `extensions/<extID>/<平台>/<nativeLibrary>` 是否真的写出，并逐行打印）。

### 3.4 平台键与目录名（两套词汇，不要混）

AIR 的平台键是**闭集**，且**不是每个键都有对应宿主库**：

| AIR 平台键 | `lib/bin/<目录>` | 宿主库 | 说明 |
|---|---|---|---|
| `Windows-x86` | `windows-x86` | ✅ `asaot.dll` + `asaot.lib` | 32 位 |
| `Windows-x86-64` | `windows-x64` | ✅ `asaot.dll` + `asaot.lib` | 64 位 |
| `MacOS-x86-64` | `macos-x86-64` | ❌ | 键是对的，宿主库**未构建**（§5 缺陷 2） |
| `iPhone-ARM` | `ios-arm64` | ❌ | 同上 |
| `MacOS-x86` | — | — | AIR 真有的键，但我们没有宿主库 ⇒ `aneHostDirName()` **直接抛**，不猜目录 |

两个容易踩的点，都是**实测**出来的：

* **macOS 的键不编码架构**。AIR SDK 51.4.1 的 `Adobe AIR.framework/.../Adobe AIR` 是**通用
  二进制**（x86_64 + arm64 两个 slice），它的 ANE 加载器字符串表里两个 slice **都**写着
  `MacOS-x86-64`。所以 Apple Silicon 上找的也是 `MacOS-x86-64`——架构在 `.dylib` 里，不在键里。
  （曾经我们为 darwin/arm64 返回过一个 `MacOS-AOT`，那个键在 SDK 的 2079 个文件里 0 命中，
  已修。）
* **Windows 的键就是位宽**，且 AIR **没有 Windows ARM64 运行时**（51.4.1 的 Windows 运行时
  只有两个，各自带一个键）。所以 Windows ARM64 上 `--ane` 会**拒绝猜**，要求显式
  `--ane-platform Windows-x86-64` **外加一个 64 位构建**（AIR 自己也是这么跑的：x64 模拟）。

**为什么是 `macos-x86-64` 而不是 `macos-arm64`**：这个目录名**不是**产物切片名，它是 AIR 的
macOS 键（该键架构中立，无法区分 macOS 的两种架构）。而 `windows-x64` 是产物切片名，因为
AIR 的 Windows 键自带位宽。两套词汇的差别在这里是**有信息量的**，不是笔误。

### 3.5 构建期与后链接期各做什么

带 `--ane` 的构建会额外做这几件事（都集中在一处，`src/index.ts:440-472`；**没有 `--ane` 的
构建与这些改动之前逐字节相同**：不加 `-DASC_HAVE_FRE`、不链 `asaot.lib`、不加 include 路径）：

```
编译期：-D ASC_HAVE_FRE=1
        include 路径 += <repo>/lib            （放 asaot.h / shim 用的那一个契约头）
        link 路径   += <repo>/lib/bin/windows-x64
        link 库     += asaot
后链接：拷贝 asaot.dll 到 <exe 目录>
        写出 <exe 目录>/extensions/<extID>/<平台>/<nativeLibrary>（每个 --ane 一个）
```

清单字段（`src/build.ts`，kebab-case）：`ane-paths`（数组）、`ane-platform`（字符串）。
CLI 优先于清单（TypePHP 的「CLI beats YAML」）。`--ane` 可重复。

### 3.6 应用声明了扩展：描述符驱动（`--air-app`）

一个真实 AIR 应用的扩展不是写在命令行上的，而是写在**它自己的描述符**里：

```xml
<extensions>
  <!--<extensionID></extensionID>-->          <!-- SDK 模板留下的空占位，注释掉的 -->
  <extensionID>com.example.wincore</extensionID>
  <extensionID>com.example.rtc</extensionID>
</extensions>
```

`--air-app <app.xml>` 现在会读这块，并把它变成清单里的 `ane-paths`——**不用在命令行上拼 `--ane`**：

```
--air-app <appDir>/application.xml            # 扩展包从 <appDir>/ext-aot、<appDir>/lib、<appDir>/ext-folder 找
--air-app <appDir>/application.xml --extdir <dir>   # --extdir 可重复；写了就顶掉上面三个默认目录
```

三条规则，每条都是先实测再定的：

1. **按声明解析，不按目录内容解析**。`<extensionID>` 是唯一依据；目录里有什么、有几个，不在
   考虑范围内。实测（真项目）：`lib/` 里躺着 **14** 个 `.ane`，而描述符只声明 **5** 个——另外 9 个
   里既有 Android 专用包，也有工具包与共享依赖包。若改成「扫目录」，构建会在这个应用**从未
   要求过**的包上失败（而 AIR 不会：`adt`/`adl` 都只认 app.xml 里的 ID）。
2. **根目录按顺序，先命中先赢**。默认 `ext-aot` → `lib` → `ext-folder`；同一个扩展在两处都有
   是常态（`lib/` 是 `adt -package -extdir` 吃的打包形态，`ext-folder/` 是 `adl -extdir` 吃的
   解包树，项目自己跑过解包就有两份），取到就不再往后看。目录内条目按**名字排序**枚举——
   `readdir` 的顺序依文件系统而定，「这两个包谁赢」不该由它决定。

   `ext-aot` 排在**最前**，因为一个扩展的 AIR 原版与 AOT 重编版**声明同一个 `<extensionID>`**
   （应用不该为了换构建方式改一行源码），于是「用哪个」完全由根顺序决定。这必须是个**点名的
   目录**，而不是同一个目录里的名字排序巧合——实测同一个根里放暂存树 `WinCore-aot` 与打包
   原件 `WinCore.ane`，前者赢（`-` 的码位 0x2D 小于 `.` 的 0x2E）；但排序看的是目录名**首字母**——一旦它排在 `WinCore` 之后（实测改叫 `ZZWinCore-aot`），赢的就变成 AIR
   原件。原版包留在 `lib/`、`ext-folder/` 原地不动，`adl` 与 `adt` 照旧。配方见 §3.7。
3. **声明了却找不到 ⇒ 硬错误**，照 `adl` 的口径：

   ```
   Requested extension com.example.wincore could not be found.
     looked in:
       <appDir>/lib
       <appDir>/ext-folder
     those directories offer: com.example.rtc <- <appDir>/lib/RTCExt.ane
   ```

   带上「找了哪些目录」（不存在的目录标 `(absent)`）与「这些目录里有什么」，才分得清是
   `--extdir` 打错字、目录没填充、还是描述符里的 ID 写错。**没有** `--no-extensions` 之类的
   逃生口：`adl` 遇到同样情况是直接拒绝启动的（实测 exit 5），静默少一个扩展会让每个
   `createExtensionContext` 变成 null 而 stderr 一句话都不说（§1.5 缺陷）。

写进清单的是**解析后的路径快照**（相对清单目录，顺序同描述符）：

```json
"ane-paths": ["lib/WinCore.ane", "lib/RTCExt.ane"]
```

路径快照而不是 ID 列表，是为了让清单本身可复现：下一次构建即使不传 `--air-app`，
`ane-paths` 也指向确定的东西。`--ane` 仍然可用（并且是唯一不依赖描述符的入口）；
`--extdir` 单独给（没有 `--air-app`）会被拒绝——它说的是「描述符声明的包在哪」，
没有描述符就没有可解的东西。**平台键仍由 `--ane-platform` / 描述符的 `<architecture>`
决定**，与第 4 节的选择无关。

### 3.7 AOT 重编过的扩展放哪里（`ext-aot/`）

§4 重编出来的产物是一棵**暂存目录树**（`extension.xml` + `<平台>/<库>`）。把它放进
`<appDir>/ext-aot/<扩展 id>/` 就算摆好了，`--air-app` 会自动选中它——**命令行上不用加任何东西**：

```
<appDir>\ext-aot\com.example.wincore\
  extension.xml                        ← 与 AIR 原版包里那个逐字节相同
  Windows-x86\Wincore.dll              ← 重编版（导入 asaot.dll）
  Windows-x86-64\Wincore.dll
```

**目录名约定用扩展 id**（`--air-app` 不要求，但这是个好约定）：它与运行期落盘布局
`extensions/<扩展 id>/<平台>/` 同形，于是「一个 id 一棵树」是可见的，而且以后要同时摆多个
扩展时不用另想一套命名。`<任意名>` 也认，但那时「这个目录装的是谁」就只能看描述符了。

```json
"ane-paths": ["ext-aot/WinCore", "lib/RTCExt.ane", "lib/CefExt.ane", "…"]
```

重编过的走 `ext-aot/`，没重编的照旧从 `lib/` 来——**一个扩展一个扩展地推**，`ext-aot` 里没有的
ID 会落到下一个根，不会因为目录还没建就报错。四条要留意：

1. **不要**把扩展自己的 AS3 包装源一起拷过去。应用 `src/` 里本来就有一份，而且那才是它该编的
   那份（实测：一个真扩展的 6 个包装类在应用 `src/` 与重编产物 `src/` 里**逐字节相同**）。
2. **不要**放进 `lib/` 或 `ext-folder/`。覆盖 `ext-folder/<扩展>.ane/` 会让 `adl` 去加载 AOT 版库
   （`RunDesktop.bat` 读的就是那个目录）；而把暂存树放在原版**旁边**更坏——两种形态都算包，于是
   「谁赢」落到目录名排序上（实测见 §3.6 第 2 条），换个名字就换个库，构建期还一句话不说。
3. **缺包不是错误**：`ext-aot` 整个不存在时，扫描把它标成 `(absent)` 继续往后找，不报错。
4. 重编产物是暂存树、是解包树、还是 `.ane` 包，扫描**都认**（与 `--ane` 认的形态一致）；
   `ane-paths` 里也可以直接写重编产物的绝对路径（如 `E:/…/aot-ane`），代价是清单不再自包含。

---

## 4. ANE → AOT 迁移流程（本文重点）

### 4.0 全景

```
        ┌──────────────────────── 原版 .ane（一个字都不改）────────────────────────┐
        │  library.swf (AS3)            <platform>/native.dll            extension.xml │
        └───────────────────────────────────────────────────────────────────────┘
                 │                                    │
        ① 取 AS3 源码                         ② 取原生源码
        （必须！见 §4.7）                     （重编的前提，见 §4.1）
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  shim 头            │  FlashRuntimeExtensions.h
                 │                          │  （转发到 asaot.h）  │  ← 只加不删
                 │                          └─────────┬──────────┘
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  重编 + 换导入库     │  asaot.lib, 不是
                 │                          │  → new.dll          │  FlashRuntimeExtensions.lib
                 │                          └─────────┬──────────┘
                 │                                    │
                 │                          ┌─────────▼──────────┐
                 │                          │  出暂存目录树        │  同一个 extensionID
                 │                          │  （不必再打包，§4.6）│  编译器直接读目录
                 │                          └─────────┬──────────┘
                 ▼                                    ▼
        ┌───────────────── as-aot --ane <目录>（也接受 .ane 包）─────────────────┐
        │  生成的 C 带 FRE 宿主 + 描述符表 → exe                                        │
        │  产物目录：exe + asaot.dll + extensions\<extID>\<平台>\new.dll               │
        └───────────────────────────────────────────────────────────────────────────┘
```

**两条产物、一套源码**：原版 `.ane` 继续给 `adl` 用（回归对照的基准就是它），重编的那份给
AOT 用。这样任何时候都能拿同一个驱动、同一个 `.as` 在两套宿主上跑 A/B。

### 4.1 为什么不能直接用原版 `.ane`（两个硬约束）

| 约束 | 具体现象 | 出处 |
|---|---|---|
| **导入的是 `Adobe AIR.dll`** | 原版原生库里写死了 `Adobe AIR.dll` 这个导入模块名。AIR 运行时装了它；我们**不产出**这个文件（产出它等于在产物目录里伪造一个 AIR 运行时，会和真的 AIR 安装撞名、并让行为依赖 DLL 搜索顺序） | `src/fre.ts:921-` `as_fre_install()`；`lib/asaot_host.c` |
| **ABI 必须逐字节等价** | 否则结构体布局/枚举值/签名一错，症状是内存错乱而不是报错 | `lib/asaot.h` |

一条**未采用**的替代路线，记在这里以免后人重新发明（**未实现、未实测**）：编一个**同名
`Adobe AIR.dll`** 的转发器，让原版 ANE 不必重编就能跑。不采用的理由是「伪造 AIR 运行时的
文件名」这件事本身：它和真的 AIR 安装同名，且把正确性押在 DLL 搜索顺序上。所以选了
「源码可得则重编换名」。

### 4.2 步骤 1：先备好宿主库（一次就够）

```bat
cd as3compiler\lib
build-asaot.bat            :: 不给参数 = 两个位宽都编（windows-x86 + windows-x64）
```

产物：`lib\bin\windows-x64\asaot.dll` + `asaot.lib`（`windows-x86` 同理）。
**这是「一套源码两条产物」里我们这一侧的产物**，编一次就能服务所有扩展。

检查点：`asaot.lib` 里记录的模块名必须是 `asaot.dll`（`build-asaot.bat` 自己用 `findstr`
断言的）。**这个检查不是装饰**：一个没记模块名的导入库在构建期**完全静默**，只在很久之后
表现为「连重编过的 ANE 都还在要 `Adobe AIR.dll`」。

### 4.3 步骤 2：加一个 shim 头（3 行）

ANE 的原生源码写的是 `#include "FlashRuntimeExtensions.h"`——SDK 发的就是这个名字，扩展从
来不知道还有别的。**规则是不要改 ANE 的源码树**。所以在 include 路径的**最前面**放一个同名
文件，让它转发到我们的契约头：

```c
/* <你的工程>\shim\FlashRuntimeExtensions.h */
#ifndef ASC_FRE_SHIM_INCLUDED
#define ASC_FRE_SHIM_INCLUDED
#include "asaot.h"
#endif
```

代价 3 行，收益是「扩展源码零改动」+「同一个 include 名字，两个 ABI」。
见 `lib/asaot.h` 顶部注释与本仓 `examples/ane/shim/FlashRuntimeExtensions.h`。

### 4.4 步骤 3：重编 + 换导入库

> **先读 §4.10**：重编的基线是**提交态**的源码与依赖，不是工作区。真实项目的工作区常常正处在
> 一次半途而废的依赖升级中间，照它编会把「工作区漂移」误报成「这个扩展需要打补丁」。

**命令行（clang-cl / 小工程）**——本仓示例就是这条路：

```bat
clang-cl /nologo /LD /O2 /MD /EHsc /W3 -Wno-invalid-source-encoding ^
  /I "<你的工程>\shim" /I "<repo>\as3compiler\lib" ^
  "<你的工程>\MyExt.c" ^
  /Fo:<工程>\build\ /Fe:<工程>\build\MyExt.dll ^
  /link /INCREMENTAL:NO /MACHINE:X64 ^
  /LIBPATH:"<repo>\as3compiler\lib\bin\windows-x64" asaot.lib
```

**VS 工程（`.vcxproj`，真实项目基本是这条）**——只改三处，其余（工具集、`/MD`、宏定义）
**一个字都不改**：

| 工程属性 | 从 | 改成 |
|---|---|---|
| 附加包含目录 | （SDK 的 include） | **`shim` 目录放在最前**，其后是 `<repo>\as3compiler\lib` |
| 附加依赖项 | `FlashRuntimeExtensions.lib` | `asaot.lib` |
| 附加库目录 | （SDK 的 lib 目录） | `<repo>\as3compiler\lib\bin\windows-x64` |

四个实测到的坑，都是「看起来对、结果错」的那一类：

1. **`-I shim` 必须排在前面**。否则 `#include "FlashRuntimeExtensions.h"` 命中 SDK 的头，编出来的
   东西照样导入 `Adobe AIR.dll`——**能编过、能链接、最后加载失败**。
2. **保留扩展原有的工具集与 CRT**（实测的一条真项目用的是 VS2015 v140 + `/MD`）。换工具集
   换的是 ABI 与 CRT 版本，跟本次迁移目标无关，属于自找麻烦。
3. **非 ASCII 源码要显式降噪**：老工程的源码常是 GBK，`cl` 会报 C4819，`-Wno-invalid-source-encoding`
   / `/wd4819` 即可（**不是**去转码源码，那等于改 ANE 源码树）。
4. **`/Fo:` `/Fe:` 之后的路径不要加引号**，尤其当它以 `\` 结尾：结尾引号前的反斜杠会被命令行
   解析当成转义，**把后面所有行吞成一个参数**，症状是 `unable to open output file`。

### 4.5 步骤 4：验证重编产物（不验就会晚一步才发现）

```bat
llvm-objdump -p build\MyExt.dll | findstr /I /C:"DLL Name" /C:"ExtInitializer" /C:"ExtFinalizer"
:: VS 环境等价物：dumpbin /dependents /exports build\MyExt.dll
```

必须同时满足：

* **导入表里有 `asaot.dll`**（`examples/ane` 实测输出：`asaot.dll` + `KERNEL32.dll` + VCRUNTIME…）；
* **导入表里没有 `Adobe AIR.dll`**；
* **导出表里有 `<Name>ExtInitializer` 与 `<Name>ExtFinalizer`**，名字与 `extension.xml` 里写的
  一字不差（AIR 与我们都按**名字** `GetProcAddress`）。

附带一句：重编不会改变扩展自身对**系统依赖**的要求（例如某真项目仍导入 `MFPlat.dll` /
`MFReadWrite.dll` / VC 运行时）。那些是扩展原本就有的要求，`adl` 跑它时也一样。

**还要再验一次「真正会被加载的那份拷贝」。** 上面验的是构建输出；而一个包里（或一棵目录树里）
**两个平台切片同名**，所以「位宽编错」「把原版切片拷进来」这类错误会产出一份**编译期完美解析、
运行期才炸**的产物，而那时的报错会误导成「扩展没重编」。所以真正要紧的是把**暂存副本**再验一遍，
而且要比位宽多验一条：**导入表里必须有 `asaot.dll`、且必须没有 `Adobe AIR.dll`**——
那是唯一能把「AOT 版」与「原版」分开的属性（迁移示例里就是 `aot-ane\check-ane.cjs` 干这个）。

### 4.6 步骤 5：写 `extension.xml` + 出暂存目录树（**不必再打成 `.ane`**）

```xml
<?xml version="1.0" encoding="utf-8"?>
<extension xmlns="http://ns.adobe.com/air/extension/51.0">
  <id>com.example.myext</id>                    <!-- 与 AS3 侧 createExtensionContext 用的 id 一致 -->
  <versionNumber>1.0</versionNumber>
  <platforms>
    <!-- 只写你要构建的那个平台；写别的平台的条目没坏处，但不会被使用 -->
    <platform name="Windows-x86-64">
      <applicationDeployment>
        <nativeLibrary>MyExt.dll</nativeLibrary>          <!-- 重编出来的那份 -->
        <initializer>MyExtExtInitializer</initializer>
        <finalizer>MyExtExtFinalizer</finalizer>
      </applicationDeployment>
    </platform>
  </platforms>
</extension>
```

目录结构：`extension.xml` 在根，原生库放在**以 AIR 平台键命名的目录**里（想打 `.ane` 也可以，
`extension.xml` 放 ZIP 根或 `META-INF/ANE/` 都行，**两条都认**；`library.swf` **不需要**——
AS3 半边走源码，不走字节码）：

```
<你的输出目录>\
  extension.xml
  Windows-x86-64\MyExt.dll
  Windows-x86\MyExt.dll
```

**为什么不再打包。** 一份重编给 AOT 用的包，消费者只有一个——as3compiler。它的库调进 `asaot.dll`，
而 `asaot.dll` 转发进**生成程序自己的表**，AIR 根本没有那张表 ⇒ **AIR 结构上就载不进这个库，
签不签名都一样**（所以这不是「暂时用不上」）。再加上 `.ane` 强制要求的 `library.swf` 在这里是死重量
（装的是 `DoABC`，不在本项目范围内，所以扩展的 AS3 类无论如何都得从 `.as` 源码编，见 §4.7），
以及 `adt -package` 还要一把签名证书——**直接把那棵目录树交给 `--ane` 是净收益**。
实测的迁移示例（§6）就是这么做的，两个位宽端到端跑通。

原生库的路径**三种布局都认**，按顺序匹配：

| 顺序 | 路径 | 谁产出的 |
|---|---|---|
| 1 | `<nativeLibrary>` | 手打的扁平包（**示例里已经不再是这条**：§4.6 起重编产物出暂存树，但历史上打包过这个形态，且外部工具仍会产出，所以候选表保留） |
| 2 | `META-INF/ANE/<平台键>/<nativeLibrary>` | **`adt -package` 的官方布局**——真实项目基本是这条 |
| 3 | `<平台键>/<nativeLibrary>` | `adt` 的**暂存目录**布局；这条路正是「第 4 步的产物树」与「目录形式的 `--ane`」 |

这一条曾经是真缺陷：`readAne` 只在根找原生库，于是**官方包一律被拒**（报「包里没有这个原生库」，
而 `adl` 加载同一个包完全正常——报错指向唯一正确的那一行）。现在三种布局都认，且找不到时
**同时列出三个候选路径与包里实际有哪些条目**（最多 12 条），不再让人对着空指向猜。
钉在 `unit: ane/PackageLayout`（16 条，变异测试 8/8 捕获）。

> **目录输入是增强，不是对齐。** 按 §1.5 说清：AIR 从不加载暂存目录，所以**没有任何 AIR 已定义
> 行为被改写**；而 ZIP 路径一个字节都没变。两者共用**同一张候选表**（目录里的名字被规范化成
> `/` 分隔，所以跨平台读数一致），因此顺带能直接吃「手工解压开的官方包」（走第 2 条候选）。

> **描述符里的注释可以正常写**。这一条曾经是个真缺陷：注释里出现的 `<platform name="...">` 会和
> **真实那一条**的 `</platform>` 配对，凭空造出一个平台条目、**并吞掉真实条目**，于是构建反过来
> 报「这个 ANE 没有 `Windows-x86-64` 条目」，指向唯一正确的那一行。现在解析前先剥注释；未闭合的
> 注释会被**拒绝并指名是哪个包**（不留着它去污染扫描）。钉在 `unit: ane/ExtensionXmlComments`。

如果你确实还想要一个 `.ane`（比如为了存档），任何打包工具都行，**不必非得 `adt`**。
本仓为此留过两份脚手架（一个零依赖 STORE 打包的 `mkzip.cjs`、以及一个打包好的 9,223 字节
fixture），但它们随示例改成暂存树（§4.6）**一起退场了**：交付形态不再包含 `.ane`。包形态本身仍被
`unit: ane/PackageLayout` 与 `unit: air-app/Extensions` 钉住——那两组自己现场合成真 ZIP，
而不是去借一份已经没有人维护的二进制 fixture。

### 4.7 步骤 6：AS3 侧怎么编（**这一步决定成败**）

**关键约束：扩展的 AS3 包装类必须有 `.as` 源码。** AIR 是**运行期**加载 `library.swf` 并执行
其中 ABC 字节码的；AOT **静态链接**类，所以必须拿到定义。`library.swf` 里的 `DoABC` 不在本
项目范围内（那需要反编译器或 AVM2 解释器）——这是 ANE 迁移**最大的实际障碍**，见 §5 缺陷 5。

两种输入方式：

```bat
:: (a) 命令行：把驱动 + 扩展的 AS3 源码一起作为输入
node src\index.ts driver.as ^
  path\to\ext\MyExt.as path\to\ext\Helper.as ^
  --manifest my.build.json -o build\driver.exe

:: (b) --air-app：扩展的 AS3 源码必须位于 src\ 下（--air-app 目前只走 application.xml
::     旁边那一个 src\，没有额外的源码根参数）
node src\index.ts --air-app app.xml -o build\myapp.exe
```

清单里补上 `ane-paths`：

`ane-paths` 每一项可以是 `.ane` 包、**解包后的目录**，或者重编产物的**暂存树**——三者等价：

```json
{ "target": "native", "ane-paths": [ "path/to/aot-ane" ] }
```

以应用为单位重编时更省事的是 §3.7 那条路：把产物拷进 `<appDir>/ext-aot/<名>/`，
让 `--air-app` 按描述符声明的 ID 自己找，清单里便只有相对路径。

**位宽怎么选（这条曾经是缺陷）**：Windows 原生构建下，平台键**跟着清单的 `architecture` 走**，
而不是跟着编译器所在的机器走——`"architecture": "64"` → `Windows-x86-64`，`"32"` → `Windows-x86`，
留空才按宿主平台取值。理由来自 AIR 自己的口径：AIR 给 32 位 captive app 的就是 x86 运行时，
所以一个 `"architecture": "32"` 的构建该拿的是 **x86 切片**。按宿主取键的后果是：32 位构建链了
x64 的 `asaot.lib`、暂存了 x64 切片，编译链接全部通过，**运行期才炸**（见 §4.8 的 193 号诊断）。
钉在 `unit: ane/PlatformForBuild`（11 条，含「位宽在两个模块里读数一致」的跨模块钉；变异 4/4）。

`--ane-platform` 仍是显式覆盖的口子（也用于跨构建，如 Windows 上构 macOS 目标），它同时决定
用 `lib/bin/` 下哪个位宽的宿主库。`"architecture": "arm64"` 在 Windows 上**除非显式覆盖，会被
拒绝**：AIR 没有 Windows ARM64 运行时，且 arm64 进程也载不进 x64 的 `asaot.dll`，所以错误信息
指名的是**目标**没有键（不是宿主），并要求改成 64 位构建。用 `--air-app` 时这一条尤其要留意：
AIR 描述符的 `<architecture>` **默认就是 `32`**，所以 Windows 上不带 `<architecture>64</architecture>`
的 `--air-app` 构建现在会正当地取 x86 切片。

用 `--air-app` 时，应用描述符还需要 `<supportedProfiles>extendedDesktop</supportedProfiles>`
——这是 AIR 自己的要求（`adl` 也一样）。

### 4.8 步骤 7：运行、以及「症状 → 病因」对照表

产物目录长这样（**可以整体搬走**，路径相对可执行文件解析）：

```
build\
  myapp.exe
  asaot.dll                                   ← FRE 宿主转发器
  extensions\
    com.example.myext\Windows-x86-64\MyExt.dll  ← 重编过的原生库（一扩展一目录）
```

两个扩展各带一个同名的 `MyExt.dll` 也是安全的：它们落在各自的 `<extID>\` 下（§5.1 那条
修掉的缺陷），而这个布局与 AIR 给每个扩展的独立目录同构。

所有 AOT 侧的问题都走**同一条限流自报通道**上 stderr，前缀 `[as3-aot] not implemented by
this build: ...`。按症状查：

| 症状（stderr / 现象） | 病因 | 怎么办 |
|---|---|---|
| `asaot.dll could not be loaded from beside the executable (Win32 error 193; 193 = wrong bitness, 126 = not found)` | **位宽不符**：exe 是 32 位而旁边放着 x64 的 `asaot.dll`（或反过来） | 让清单的 `architecture` 与产物位宽一致（§4.7）；这一条本该在编译期就定下来 |
| 同上，但码是 `126` | 文件真的不在 | 重跑构建（后链接阶段会自动拷贝）；或手拷 |
| `asaot.dll does not export asaot_bind (stale or foreign build)` | 拿到的是别的版本的 `asaot.dll` | 重跑 `lib\build-asaot.bat` |
| `asaot.dll was built against a different ABI version` | `asaot.h` 变了但 DLL 没重编 | 同上 |
| `asaot.dll is missing from <路径>...Build it first: run lib/build-asaot.bat` | **构建期**缺宿主库 | 跑 `lib\build-asaot.bat` |
| `no native extension with this ID is part of the build: <id>` | 该 id 不在 `--ane` 列表里（**编译期固定的扩展集**） | 把它的 `.ane` 加进 `--ane` / `ane-paths` |
| `extension native library not loadable: <lib> (Win32 error 193; ...; an ANE that still imports Adobe AIR.dll must be recompiled against asaot.lib)` | **两类，现在能分开了**：`193` = 暂存的切片位宽与产物不符（走 §4.7）；`126` = 库或它的依赖没找到。用了原版 `.ane`、或重编时 `-I` 顺序错了，也会落到这里 | 先看码：193 看 §4.7；否则回到 §4.4，用 §4.5 检查导入表 |
| `extension exports no Initializer named <Name>` | 导出名和 `extension.xml` 不一致 | 对上 `dumpbin /exports` |
| `extension Initializer set no ContextInitializer: <Name>` | 扩展的 Initializer 没设置 `ctxInit` | 扩展实现问题（AIR 同样会 null） |
| `the extension publishes no function named <fn>` | 名字拼错，或该函数不在发布的函数表里 | 对上扩展的 `FRENamedFunction[]` |
| `the extension published no function table` | `ContextInitializer` 返回时 `numFunctions=0` | 扩展实现问题 |
| `FREGetRenderMode (the render pipeline is out of scope for this build)` 等 11 条 | 命中了 **D 面** | 见 §5 缺陷 1；视频/呈现类功能本期没有 |
| `ExtensionContext.getExtensionDirectory (this build stages only the native library, under extensions/<extensionID>/<platform>; the rest of the package is not unpacked)` | 扩展在找自己携带的资源文件 | 见 §5 缺陷 4 |
| 整个程序不报错但 `createExtensionContext` 返回 null | **不应该出现**——如果出现就是缺陷，请连同 stderr 一起报 | —— |

### 4.9 最小可跑示例：`examples/ane/`（两条路子，同一个夹具）

本仓有一个完整、可重复生成的最小闭环（43 条断言全过）。**重编产物是暂存目录树，不是 `.ane`**
（§4.6 已不再打包），所以示例目录的形状就是运行期 `extensions/` 的形状——`<扩展 id>/<平台>/<库>`：

| 文件 | 作用 |
|---|---|
| `examples/ane/ProbeANE.c` | 扩展的**原生半边**，2.1 万字节，覆盖整数/浮点/UTF8/布尔/数组/字节数组/对象属性/方法调用/原生数据/状态事件/线程与互斥/抛异常/**FRE 字符串长度契约**（`stringInfo`） |
| `examples/ane/shim/FlashRuntimeExtensions.h` | §4.3 的 shim，且**故意让 `ProbeANE.c` 用 AIR 的 include 名**，这样 shim 真的被走到了 |
| `examples/ane/build-ane.bat` | §4.4 的重编配方（clang-cl），编完自动跑 §4.5 的导入表检查，并把结果装进**两棵**暂存树 |
| `examples/ane/ext-aot/com.example.probe/extension.xml` | §4.6 的描述符（目录名 = 扩展 id） |
| `examples/ane/ext-aot/com.example.probe/Windows-x86-64/ProbeANE.dll` | 重编产物（19,456 字节，导入 `asaot.dll`） |
| `examples/ane/driver.as` | AS3 驱动，**每一行都是断言**，最后打印 `RESULT passed=N failed=0` |
| `examples/ane/ane.build.json` | 构建清单（`ane-paths` 指向那棵暂存树） |
| `examples/ane-app/` | §4.9.1：同一个夹具，走 `--air-app` + 描述符 `<extensions>` 那条路 |

跑法：

```bat
node test.ts                              :: 全量回归里包含这两个示例（各一个用例）
:: 或者单独跑：
node --test --test-name-pattern='example: ane' test/examples.ts
```

**示例是「必须成功」的程序**，所以它同时是回归网：改坏 FRE 语义 → 它的断言立刻红。
在没有宿主库的机器上（例如 CI 的 macOS 运行器）它会**响亮 skip**，而不是假装通过。

### 4.9.1 第二条路子：`examples/ane-app/`（描述符声明 → 自动解析）

`examples/ane/` 走的是「命令行/清单直接指名包」，**没有描述符**。真项目走的是另一条：
`application.xml` 的 `<extensions><extensionID>` 声明了要什么，`--air-app` 负责去
`ext-aot` → `lib` → `ext-folder` 找（§3.7、§4.6）。两条路子的代码不一样，所以各要一个示例：

| 文件 | 作用 |
|---|---|
| `examples/ane-app/ane-app.xml` | 描述符：`<extensions>` 声明 **一个** id；`<visible>false</visible>`（离屏，编完就能 `--run` 然后退出） |
| `examples/ane-app/src/Main.as` | AS3 入口（`extends Sprite`），8 条断言：未声明的 id 解析为 null、声明的能建 context、`ping`/`addInt`/原生数据/`truthy('')`/`StatusEvent`/`dispose` |
| `examples/ane-app/ext-aot/com.example.probe/` | 与 `examples/ane/` 的暂存树**逐字节相同**（同一个 `build-ane.bat` 写两处，并有钉子钉住这份同一性） |
| `examples/ane-app/ane-app.build.json` | `--air-app` 每次跑**自动重写**的副产物（`ane-paths` = `["ext-aot/com.example.probe"]`），所以**不入库** |

跑法（`--air-app` 会把 `ane-paths` 写进清单、加载器再把库落到 `<exeDir>/extensions/<扩展 id>/<平台>/`）：

```bat
node src/index.ts --air-app examples/ane-app/ane-app.xml --main-class aneapp.Main --target native -o out/ane-app.exe --run
```

第 8 条断言（未知 id）会打印构建期的自报原文 `not implemented by this build: no native extension
with this ID … com.example.nope`——**这是 §1.5 要求的行为**：能力不存在就点名报明，不静默返回 null。

### 4.10 步骤 0（补）：重编的基线是**提交态**，不是工作区

§4.4 隐含一个前提：扩展的源码「拿过来就能编」。真实项目里经常不成立，但**先分清是谁的问题**再动手——
一次实测（CEF 类扩展）里，工作区的源码编不过，而同一个文件在 `git HEAD` 上**一个补丁都不用**就编过了。
若先动手打补丁，就会把「一处未提交的破损编辑」写成「上游有缺陷」的结论。

**先跑这三条判据，再谈「源码有缺陷」：**

1. **`git -C <扩展仓> status --porcelain -- <源码目录>` 有 `M` 就先看 diff。** 工作区是移动靶。
   实测那次的编辑留下了**编不过任何版本**的源码：一个整段 access-specifier 块宏被加了返回类型前缀、
   一个 API 被改道到一个**从未有过它的**宿主对象、GBK 注释被重新编码成 U+FFFD、一个头文件被整份改写成 LF。
2. **依赖版本以「应用真正随包分发的那个库」为准**，不看工程 `Dependencies/` 里躺着什么。作法：在
   那个 `.dll` 里找版本串（CEF 是 `x.y.z.g<sha>` 加 `chromium-<ver>`）。实测：应用分发的是
   `3.2987.1601` / Chromium 57，而工程里是一个升级到一半的 109。**CEF 在运行期校验 API 哈希，
   包装库必须与那个版本同源编译**，拿新头配旧运行库是等着在运行期炸。
3. **工作区把依赖目录删了**（版本升级途中很常见），**不要改写别人的树**：从提交里把子树取出来
   （`git ls-tree -r --name-only <rev> -- <dir>` 列清单 + `git cat-file --batch` 一次读完所有 blob），
   落进自己的暂存目录。这样「这个产物能从哪个提交重建」是可回答的。实测：237 个 include 头 +
   两个 `.lib` 一次性取出，工件随后完全从提交态产出。

**三条老原生源码上的坑——它们的共同点是「报错指向的行不是根因行」：**

| 现象 | 机制 | 处理 |
|---|---|---|
| `error C2059: 语法错误:"{"`，行号指向某个函数体的第一行 | 它**上一行**是非 ASCII 注释，行尾字节恰好是 DBCS **首字节**，而换行是**裸 LF**：cl 按当前代码页把那个 LF 当成了该字符的尾字节吃掉，注释于是吞掉下一行 | 把该文件 EOL 归一到 CRLF（`0xBD 0x0D` 成对时 LF 仍能结束行）。**不要**把它理解成「文件应当是 CRLF」：同一文件内逐行 EOL 可以不同，只需归一危险的那些行。归一是空白改动，且必须**按字节**做（镜像按 latin1 读写，绝不按 UTF-8 解码） |
| 报错落在宏展开体内部，去报错行找根因找不到 | 类似 `IMPLEMENT_LOCKING(name)` 的宏展开成**一整段 access-specifier 块**（`public: class AutoLock{…}; void Lock(); void Unlock(); private: base::Lock lock_;`），给它加返回类型前缀会在几十行后炸 | 回查使用点「这个宏是不是块宏」，而不是修报错行 |
| 编得过，但注释全变乱码 / 行为可疑 | 用带 UTF-8 解码的编辑器批量改过含 GBK 注释的源码：字节被替换成 U+FFFD 后**仍然编得过**，属静默语义损伤 | 别批量重编码；真要改就按字节改 |

**验证必须「逐个真的去加载」**：`as_ane_load` 是**惰性**的（首次 `createExtensionContext` 才
`LoadLibrary`），所以「把应用跑起来」只证明它**用到**的那几个扩展。要证 N 个全好，就让探针**对描述符
声明的每个 id 各建一次 context**，每个 id 打一行结论，末行给计数（实测 `E2E DONE 7/7`）。
只做静态检查（导入表、位宽、导出名）只能证「装对了」，证不了「加载得起来」。

---

## 5. 缺陷与缺口（如实报明）

按 AGENTS.md §1.5：**`adl` 跑得对而我们跑不出 ⇒ 遗留缺陷**；AIR 本来就不支持的东西才是增强。
下表全部是前者，且**每一条都是「响亮报明 + 已登记」**，没有一条是静默降级。

| # | 缺口 | 现象 | 是否自报 | 落地路径 |
|---|---|---|---|---|
| 1 | **D 面渲染管线**（11 个入口点） | 视频/呈现类扩展拿不到渲染模式、拿不到媒体缓冲、拿不到窗口句柄 | ✅ `FRE_ILLEGAL_STATE` + 自报 | 需要真正的呈现后端（Skia/D3D 互操作 + 窗口 HWND 暴露），独立工程 |
| 2 | **macOS / iOS 没有宿主库** | `lib/bin/macos-x86-64/`、`ios-arm64/` 不存在，macOS 上 `--ane` 一定失败 | ✅ 构建期报错并给出该路径 | `lib/asaot_host.c` 是与位宽无关的薄转发器；macOS 侧需要 `dlopen`/`dlsym` 分支 + 一个 `build-asaot.sh`。**平台键已经修对了**（§3.4），缺的就是这个库 |
| 3 | **Windows ARM64 未验证** | 有守卫（拒绝猜键、要求显式 64 位），但 arm64 依赖链从未构建过（本机没有 MSVC arm64 工具集） | ✅ 拒绝并给建议 | 需要一台 arm64 Windows + 工具集 |
| 4 | **扩展只被部分解包** | 每个扩展现在有自己的目录 `<exe 目录>/extensions/<extID>/<平台>/`（本次新加，§3.3），但里面**只有那个原生库**：扩展随包带的其它文件（数据文件、附属 DLL）不在。所以 `getExtensionDirectory()` 仍只**自报**、不返回该目录 | ✅ 自报 | 把**整包**倒进 `extensions/<extID>/`（布局这一半已经做了，剩下的是解包全部条目），之后 `getExtensionDirectory()` 才能返回真目录 |
| 5 | **没有 `.as` 源码的 ANE 类无法 AOT** | 扩展的 AS3 包装类只存在于 `library.swf` 的 `DoABC` 里时，这个扩展用不了 | ✅ 编译期缺类就报未定义 | 需要反编译器或 AVM2 解释器，本项目范围外（§3.3 结论） |
| 6 | **`ExtensionContext` 的 AIR 50 成员未建模** | `functions` / `knownExtensions` / `getExtensionInfo` / `loadExtension` 不存在 | ✅ 未定义即报错 | 前三者是只读反射面；`loadExtension` **不是小修**：它是**延迟加载**（首次 `call` 时才 `LoadLibrary` + Initializer），要把 C 面加载时机从「构造时」挪到「首次调用时」并缓存 |
| 7 | **`File.applicationDirectory` 缺失** | 真实 AIR 应用用它定位随包资源（也是 `extensions/` 布局的基准） | ✅ 未定义即报错 | 按 `adl` 实测的 `url`/`nativePath` 落地 |
| 8 | **描述符表上限 32** | 第 33 个扩展在**编译期**被拒绝。**这道闸门是本次补的**：此前 33 个扩展会编译、链接、暂存**全绿、exit 0、一句提示都没有**，直到运行期第 33 次 `createExtensionContext` 越界写 `as_anes[32]`（实测） | ✅ 编译期报错并给出去处 | 提高 `src/fre.ts` 的 `ANE_COUNT_MAX` 即可（`FRE_HEAD` 的 `ASC_ANE_COUNT_MAX` 由它插值，只有一个真源），只是当前值是个有意留的界 |
| 9 | **C 面是 Windows 专用** | `LoadLibraryA` / `CRITICAL_SECTION` / `GetModuleFileNameA` / `Sleep` 全是 Win32 | —— | 与缺陷 2 是同一件事的两半：宿主库 + C 面的 POSIX 分支要一起做 |

### 5.1 已修的缺陷（留作教训）

六条都是**「`adl` 跑得对、我们跑不出」**那一类，都是在拿真实三方 ANE 做迁移时量出来的；
现在都修了并配了行为钉。列在这儿的价值在于它们的共同形态：**都是「看起来对、结果错」**。

| 缺陷 | 症状 | 修法 | 钉（条数） |
|---|---|---|---|
| **描述符里的 `<extensions>` 被整个忽略** | 应用在 `application.xml` 里声明了扩展，我们读了不认：构建全绿、扩展表为 0、每个 `createExtensionContext` 返回 null 而 stderr **一句话不说**；`adl` 对同样情形是**直接拒绝启动**（实测 exit 5，`Requested extension … could not be found.`）。手动拼 `--ane` 能绕过去，但应用自己的声明才是真源 | `--air-app` 读 `<extensions>`（先剥注释；空的 `<extensionID>` 不算，SDK 模板里就有这么一个占位），按声明的 ID 从 `lib`/`ext-folder`（或 `--extdir`）解析成 `ane-paths` 写进清单；声明了却找不到 ⇒ 硬错误，照 `adl` 的口径列出找过的目录与目录里的东西。**按声明解析而不是扫目录**：真项目的 `lib/` 有 14 个 `.ane`，描述符只要 5 个 | `unit: air-app/Extensions`（25；变异 14/14 全被抓） |
| `extension.xml` 解析不认注释 | 注释里写了一句含 `<platform name="...">` 的话，就凭空造出一个平台、**并吞掉真实那条**，构建反过来报「这个 ANE 没有 `Windows-x86-64` 条目」 | 解析前先剥 `<!-- -->`；未闭合的注释**拒绝并指名是哪个包** | `unit: ane/ExtensionXmlComments`（9） |
| `readAne` 只认扁平布局 | 官方 `adt` 包（`META-INF/ANE/<平台>/<lib>`）一律被拒，而 `adl` 加载同一个包正常 | 三种布局全认（并额外接受**解包后的目录**——这是增强，不是对齐，见 §4.6）；找不到时报错列出全部候选路径与实际条目 | `unit: ane/PackageLayout`（27） |
| 所有扩展的原生库挤进**一个目录**、按**文件名**做键 | 两个 ANE 各带一个同名 `Shared.dll` 时，后一个**静默覆盖**前一个：摘要写「2 extension(s)」旁边却是「1 native library(ies)」，exit 0；于是一个扩展加载到了另一个的库，报出来的是「导出里没有 XXXInitializer」这种**指错方向**的话。AIR 不这样（`adl` 实测：第二个包用**另一个 extensionID** 放一个同名的哨兵库，第一个扩展照样 13/13 全过） | 改为 `<extID>/<平台>/<库>`（一扩展一目录，与 AIR 同构）；**描述符携带的路径与落盘键由同一行生成**，不允许各自拼一遍 | `unit: ane/PackageLayout`（同上；变异 5/5 全被抓） |
| ANE 平台键按**宿主**取而不按**构建目标**取 | 32 位构建链 x64 宿主库、暂存 x64 切片，编译链接全绿、**运行期**才炸 | win32 原生构建下键 = `architecture` 的位宽；arm64 目标无键（拒绝并指名目标） | `unit: ane/PlatformForBuild`（11） |

| **FRE 字符串长度多算了一个终止符** | 我方 `FREGetObjectAsUTF8` 返回 `strlen+1`（照着 SDK 头文件那句「Includes the null terminator」写的），而 `adl` 实测返回的是**不含**终止符的字节数。扩展若**携带长度**——`ANEUtils::getString` 正是 `std::string(val, val + length)`——它读到的每个字符串都会多出一个 NUL 字节；字符串被原样嵌进协议帧时（WebSocket URL 进 HTTP 请求行）就变成 `GET /node1?...\0 HTTP/1.1`，服务端不回响应直接关闭。宿主应用 AOT 后**所有 wss 连接**都以 `status_code 0` + `websocketpp.transport:7`（EOF）失败，而**同一台机器**上 `adl` 加载同一份原生库、同一个 URL、同一个 token 却 `101` 成功并收到业务帧。只把指针交给 `printf`/`strcmp` 的扩展察觉不到这个字节，凡自己带长度的（`std::string`、协议帧、哈希）都会中招 | 按 `adl` 实测改成 `strlen(s)`，并把「**头文件那句话与实测不符**」连同证据写进注释，免得后人照字面「修」回 `+1`；反方向的 `FRENewObjectFromUTF8` 仍按文档接受调用方传入的终止符（写 `strlen+1` 的调用方遍地在写） | `unit: fre/Utf8LengthContract`（8；变异 7/7 全被抓）+ `examples/ane/` 的原生回显断言 `stringInfo`（3：ASCII 6 字节、4 个 CJK 字符 12 字节、空串 0 字节，`extra` 必须为 0——把 `src/fre.ts` 改回 `+1` 这条必红） |

配套的一条诊断改进：加载失败的两处自报现在**带上 Win32 错误码**（`193` = 位宽不符、
`126` = 找不到）。此前它们无条件归咎于「库没重编」——当一个纯位宽问题被套上「你重编错了」的
帽子时，人会在错误的方向上修很久。

**两条「不属我方缺陷、但如实记录」的观察**：

* 原始 `.ane` 的原生实现可能返回 `NULL FREObject` 而其 AS3 包装声明 `:String`——这是**厂商
  侧**的行为（`adl` 下同样如此），我们只保证不因此崩溃。**未与 AIR 逐字对照**，所以按 §1.5
  如实记录，不当作缺陷也不当作增强。
* `ExtensionContext.call` 一个扩展**没发布**的函数名时的 AIR 原文错误信息**尚未实测**
  （从未在真实 ANE 上量到）。我们选择自报 + 返回 null，而不是编一个错误码——编造错误码比
  报明缺口更坏。

---

## 6. 验证与证据

| 证据 | 内容 | 怎么复现 |
|---|---|---|
| `examples/ane/` | 端到端示例，**46 条断言全过**，末行 `RESULT passed=46 failed=0` | `node --test --test-name-pattern='example: ane' test/examples.ts` |
| `examples/ane-app/` | 端到端示例·**描述符那一半**：`--air-app` 把描述符里的 `<extensions>` 解析成 `ane-paths`、把库落到 `extensions/<扩展 id>/<平台>/`，再运行；**8 条断言全过**，末行 `RESULT passed=8 failed=0`（另有一行是未声明 id 的自报原文） | 同上 |
| `test/unit/emit.ts` → `unit: ane/ExtensionContextSurface` | 9 条：钉**发射出来的 C** 里 `getExtensionDirectory` 必须自报、必须仍返回活着的 `File`、自报必须**点名本构建的布局**并说清那个目录里**没有**整包、`actionScriptData` 是真成员而 `extensionID` **不是**、`call` 的「扩展从未加载」自报必须具名 | `node --test --test-name-pattern='ane/ExtensionContextSurface' test/unit/emit.ts` |
| `test/unit/fre.ts` → `unit: fre/Utf8LengthContract`（8 条） | FRE 字符串边界的两向契约：`FREGetObjectAsUTF8` 的 `length` 必须是 `strlen`（**不得**加上终止符，也不得变成别的计数）、`value` 必须是字符串本身、非 String 仍须 `FRE_TYPE_MISMATCH`；反方向 `FRENewObjectFromUTF8` 必须容忍调用方传入的终止符，且不得把它算进字符串。变异 7/7（`+1u`、`+1`、换掉 `value` 指针、放开 tag 判定、去掉容忍、把终止符拷进字符串、不写结尾 0） | `node --test --test-name-pattern='fre/' test/unit.ts` |
| `test/unit/build.ts` → `unit: ane/ExtensionXmlComments` | 9 条：注释不得凭空造出平台条目、不得吞掉真实条目、未闭合注释必须拒绝并指名包 | 同上换成 `test/unit/build.ts` |
| `test/unit/build.ts` → `unit: ane/PackageLayout`（27 条） | 官方 `adt` 布局、扁平布局、`adt` 暂存布局都认；**解包后的目录**也认（含递归与 `/` 分隔名字两条，所以手工解压的 `META-INF/ANE` 树可读）；目录形式同样按平台取切片、不借另一平台的切片；找不到时不得只说「没有」，要列出候选路径；**落盘路径必须是 `<extID>/<平台>/<库>`**（描述符与暂存键两处都要，且不得再出现裸文件名）；**两个扩展可以各带一个同名库且各留各的字节**；声明在子目录里的库**保留那个子目录**；**扩展数上限是硬闸门**（正好 32 过、33 拒绝并给出计数与常量名） | 同上换成 `test/unit/build.ts` |
| `test/unit/build.ts` → `unit: ane/PlatformForBuild`（11 条） | 平台键跟随 `architecture`；留空保留宿主答案；wasm/darwin 下 `architecture` 无效（AIR 描述符默认就是 `32`，不能因此变成 `Windows-x86`）；arm64 目标不发明键；**位宽在 ANE 键与目标三元组两处读数一致** | 同上 |
| `test/unit/build.ts` → `unit: air-app/Extensions`（30 条） | **描述符驱动那一半**：`<extensions>` 按描述符顺序读、**注释里的 ID 不算**（SDK 模板里就留着那个占位）、**未注释的空 `<extensionID>` 也不算**；打包 `.ane`、解包树、**暂存树**三种形态都认，而不是包的目录照旧跳过（不是错误）；多个根**先命中先赢**，后面的根仍能补前一个没有的 ID；`ext-aot` **排在默认根最前**，所以同一个 ID 的重编包压过 `lib/` 里的 AIR 原件，而 `ext-aot` 没有的 ID 仍从 `lib/` 来；**目录里的包不算数——只有描述符要的才返回**；声明了却找不到就拒绝（`adl` 原文、看过的目录、`(absent)` 标记、目录里有什么、**三条出路**）；`--extdir` 顶掉默认，且不给 `--air-app` 时被拒；清单写出来是**相对清单目录的 `/` 分隔路径**、无声明时**一个键都不写**。变异 5/5（去掉暂存树形态 / 认错路径 / 把所有目录都当包 / 把 `lib` 排到 `ext-aot` 前 / 干脆去掉 `ext-aot`） | 同上 |
| `test/unit/build.ts` → `unit: ane/ExampleFixtureTrees`（7 条） | 两个示例共享**同一个夹具**这件事本身要钉：两棵暂存树都在；`extension.xml` 与 `Windows-x86-64/ProbeANE.dll` **逐字节相同**（`readFileSync(a).equals(b)`）；两处都只声明一个 id / 一个平台 / 一个库；用真描述符在那个应用目录上走 `resolveExtensionPackages` 能解析到那棵树；清单的 `ane-paths` 指向它；应用描述符声明的是同一个 id。有了这组，「两个示例其实各跑着不同的东西」这件事不会静默发生 | 同上 |
| `test/unit/build.ts` → `unit: air-app/OffscreenLinkSet`（10 条） | Windows **离屏**构建的链接集（`<visible>false</visible>` 没有窗口，但不是「更小的构建」：`skia_glue.cc` 每个 native 产物都编，它的 GDI 字体管理器在任何像素画出来之前就被 `SkFontMgr::Factory()` 走到）；把 `process.platform` 伪造成 win32 之后断言 `gdi32/user32/ole32/advapi32/usp10` 与 `z` 在、而 `SDL2/winmm/imm32/oleaut32/version/uuid/setupapi/shell32/dinput8/d3d12*` 与 `curl` **不在**；defines 里有 `ASC_USE_SKIA=1` 而没有 `ASC_USE_WINDOW=1`；sources 只有 `skia_glue.cc`；macOS 分支仍走 CoreText。变异 2/2（把四个库挪回 `visible` 分支 ⇒ 2 条红） | 同上 |
| `test/unit/build.ts` → `build/AneHostLayout`（21 条）/ `build/WindowsArch`（24 条） | `--help` 提供的键集合 ≡ 真的有 `lib/bin/` 目录的键集合；每个键映射到唯一的目录；未知键抛错；`MacOS-AOT` 这个 AIR 从不发射的键不再指向任何目录 | 同上 |
| 变异测试（`temp/`，脚手架，非交付物） | 对上述每组**逐条**注入破坏（把自报删掉、把 `extensionID` 加回去、把注释剥离去掉、把正则改成贪婪……），确认**每一条都会变红**；对照组保持绿；改完**逐字节还原**并校验哈希 | —— |
| 真实三方 ANE 端到端（`temp/` 脚手架） | 一个真项目（7 个 `.cpp` + VS2015 v140 工具集）从原版已签名 `.ane` 出发：重编（x64 **与** x86 两个位宽）→ **出暂存目录树，不打包**（§4.6）→ 跑通。**两个位宽的结果表各 22 行、逐行相同**；与 `adl` 比 **21/22 相同**，唯一差异是刻意延后的 D 面 `renderMode`（AOT `-1` / `adl` `1`），两个位宽都在 stderr 上自报了 `FREGetRenderMode`。实际加载的切片与目录里对应文件 **sha256 逐字节一致**，宿主库各为自己的位宽（116224 B / 83456 B）。同轮还实测了 `check-ane.cjs` 的两条判据（位宽 + 导入表里必须有 `asaot.dll`、没有 `Adobe AIR.dll`），并确认扩展自带的 AS3 包装源整份参与编译（6 个文件端到端 `exit 0`） | —— |
| 真实三方 ANE 端到端·**嵌套布局那一轮**（`temp/ane-wincore/nest-*.cjs`） | 同上两个位宽重跑一遍，**验收的是加载路径换成 `<extID>/<平台>/` 之后**的产物：两轮 `exit 0`、结果表各 **22 行且逐行相同**、与 `adl` **21/22**（同样只有 `renderMode`，两位宽都自报）；落盘文件与源切片 **sha256 一致**（x64 `877dffc8…` / x86 `09e1f8e9…`）；同时断言**旧的扁平 `extensions/WinCore.dll` 不存在**。这一条是必要的：Windows 接受 `/` 作为分隔符，但那是「应该能」，不是「试过能」 | —— |
| 真实项目描述符·**多扩展那一轮**（`temp/air-extdir/real-stage/`） | 拿一个真应用的 `application.xml`（`<architecture>32</architecture>`）走完整链条：描述符声明 **5** 个 ID → 从默认的 `lib/` **5/5 全命中**（同一个目录里还躺着 **9** 个没声明的 `.ane`，一个都没进来）→ 5 个描述符的 `initializer` 各指其名 → 落盘 `extensions/<extID>/Windows-x86/<lib>`：**5 个目录、5 个库、无平铺残留**。这一条同时是「为什么不能扫目录」的实测依据 | —— |
| 真项目安装一轮（`temp/aot-place/verify-installed.cjs`） | 把重编产物按 §3.7 拷进一个真应用的 `ext-aot/<名>/`（三样：`extension.xml` + 两个平台目录），然后（a）用**真描述符 + 真的 `lib/`** 走 `prepareAirApp`（即 `--air-app` 的代码路径，**不给 `--ane`、不给 `--extdir`**）：声明 **7** 个 ID → `ane-paths` 恰为 `["ext-aot/WinCore", "lib/RTCExt.ane", …]`，即**重编的那个来自 `ext-aot`、其余 6 个来自 `lib/`**，且没有被声明的 Android 专用包没被扫进来；（b）**从这个安装位置**（而不是从 `aot-ane/` 原地）编出驱动并运行：`exit 0`、48 行输出里除驱动自己的内存读数外与「原地读」**逐行相同**，落盘库与安装的库 **sha256 一致**、导入 `asaot.dll` 且不含 `Adobe AIR.dll`。内存读数那一行单独实测了噪声底：同一个二进制跑 5 次在 `13.9961M`–`14.0195M` 之间跳，两个二进制的取值完全重叠。**该轮用的是暂存目录的短名 `WinCore`，下一轮已全部改成扩展 id 命名** | —— |
| 真项目·**六扩展全量重编 + 逐扩展运行期加载**（`temp/ext-aot/`） | 一个真应用的扩展清单里有 **7** 个扩展，其中 6 个按 §4 重编为 AOT（第 7 个是前一抡已完成的两个位宽那一份）：每个库都**导入 `asaot.dll`、都不含 `Adobe AIR.dll`**、导出名与各自描述符一致，且**位宽与原包实际发布的切片逐项相同**（其中一个是描述符声明了 `Windows-x86-64` 而原包也只发 x86——按原包来，不凭空多出一个位宽）。按 §3.7 装进 `ext-aot/<扩展 id>/<平台>/` 后，用**真描述符**驱动 `--air-app` 走一遍：声明 7 个 id → `ane-paths` 恰为 **7 条 `ext-aot/<id>`、顺序与描述符一致**；再编一个**对每个 id 各建一次 context** 的探针（§4.10 末段）并运行：`exit 0`、7 行 `E2E OK`、末行 `E2E DONE 7/7`，其中一个扩展的 Initializer 还打出了它自己的版本横幅——证明原生码真的**执行**了，而不是「文件在、没报错」。CEF 那一份从 `git HEAD` 的**提交态源码 + 提交态 3.2987.1601 依赖**编出，**零补丁**（过程与三条坑见 §4.10） | —— |


**CI 口径要说清**：`.github/workflows/test.yml` 跑在 **macOS arm64** 运行器上，那里没有 Windows
宿主库，所以 `examples/ane/` 与 `examples/ane-app/` 会**响亮 skip**（不是 pass、不是 fail）；CI 上
真正跑的是 `test/unit/` 里那几组结构钉。也就是说：「示例通过」这件事目前只在 Windows 上被实测过。

---

## 7. 文件索引

| 文件 | 职责 |
|---|---|
| `lib/asaot.h` | FRE ABI 契约头（与 SDK 的 `FlashRuntimeExtensions.h` 逐字节可换） |
| `lib/asaot_host.c` | `asaot.dll` 的源码：51 个入口点的**薄转发器**，全部转发进 `asaot_bind` 装进来的表 |
| `lib/build-asaot.bat` | 编宿主库（默认两个位宽）；自带「导入库记录 `asaot.dll`」断言 |
| `lib/bin/windows-{x86,x64}/` | 宿主库产物（`asaot.dll` + `asaot.lib`） |
| `src/ane.ts` | `.ane` 的编译期解析：`extension.xml`（先剥注释）、平台键、目录名、描述符解析、原生库落盘（**一扩展一目录** `<extID>/<平台>/`，并守住 `ANE_COUNT_MAX`）。**既吃 ZIP 也吃解包目录**（§4.6） |
| `src/fre.ts` | FRE 宿主：`FRE_HEAD` / 描述符块 / `FRE_BODY`（51 入口 + 加载器 + 分派）/ `FRE_STUBS`（无 FRE 构建的空实现）。`ANE_COUNT_MAX`（描述符表上限的唯一真源）也在这里 |
| `src/emit.ts` | 描述符表与 hook 体的发射、`ExtensionContext` 的 AS3 半边、`as_fre_pump` |
| `src/symbols.ts` | `ExtensionContext` / `StatusEvent` 的 AIR 成员表 |
| `src/air-app.ts` | AIR 描述符适配：读 `<extensions>`（先剥注释）→ 按声明的 ID 从 `lib`/`ext-folder`（或 `--extdir`）解析出包路径 → 写进清单的 `ane-paths` |
| `src/index.ts` | `--ane` / `--ane-platform` / `--extdir`，以及那三处 `-D`/include/link 的注入与后链接落盘 |
| `src/build.ts` | 清单字段 `ane-paths` / `ane-platform`（`ane-paths` 按绝对路径去重后追加） |
| `examples/ane/` | 端到端最小闭环（§4.9） |
| `examples/ane-app/` | 同一夹具的**描述符那条路**（§4.9.1） |
| `docs/zh-cn/compile.md` | CLI 参数与清单字段的完整清单 |
| `README-CN.md` | 「ANE 加载」一节（概览） |
