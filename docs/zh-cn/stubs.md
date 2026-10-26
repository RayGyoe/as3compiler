# 空替代（shell）清单

> 阶段二百九十三盘点。回答一个问题：**为了让 `talkmedmeeting` 应用编译通过，我们注册了
> 多少「只有 API 形状、没有后端」的类？** 每个类现在到底给得出什么、给不出什么，一次写清。
>
> 全部内容是**可复核的**：机制在 `src/emit.ts` 的 `emitShellClasses()`，登记点在
> `src/symbols.ts`，行为由本机 AOT 构建实测（探针 `temp/clip/t4.as`）。

---

## 1. 「空替代」在代码里是什么

`src/symbols.ts` 里的 `shell(name, fqn, super, ctorParams, staticConsts, fields, methods, …)`
把一个类登记成 `shell: true`，`emitShellClasses()` 于是生成：

| 生成物 | 内容 |
|---|---|
| `// ---- shell class X (pkg.X): API shape only, no backend ----` | 注释招牌，grep 这一行就能列出全部 |
| `X_ctor` / `X_new` | **真的构造**：字段按构造函数同名参数赋值，`Array`/`Vector` 字段默认**空集合**而非 `NULL`，父类构造按 AIR 参数名匹配着传下去 |
| 每个方法 / getter / setter | **空体**：`as_shell_unsupported("pkg.X.member")` 后返回该类型的零值 |

`as_shell_unsupported()` 只往 stderr 打一行
`[as3-aot] not implemented by this build: <成员>`，**全局最多 5 行**，其余静默（不是吞错：
它明确说「本构建不实现」，返回值也是文档化的零值）。

因此三种「空」要分清：

1. **字段/常量是真的**（事件类、选项类、`ClipboardFormats`）——对象能携带调用方给的数据，
   反射读得到；只是**没有任何代码路径会产生**这些事件。
2. **方法是空壳**——调了不做事，返回 `null`/`0`/`false`/`undefined`，并在 stderr 报一次。
3. **能力位是 `false`**——`isSupported` / `isSupported` 类的静态属性一律 `false`，让
   `if (X.isSupported) …` 这种守卫**真的跳过**（见 `desktop.md` §2 的同一口径），
   这比照 AIR 报 `true` 然后什么都不做诚实。

---

## 2. 清单（20 个类）

「应用引用」= `talkmedmeeting` 源码里出现该类名的文件数（`E:/Works/eDoctor/talkmed-meeting-windows/src`，
989 个 `.as`，阶段二百九十三统计）。

### 2.1 数据载体：字段与常量是真的（12 个）

| 类 | 包 | 应用引用 | 真的给得出 | 给不出 |
|---|---|---|---|---|
| `ClipboardFormats` | `flash.desktop` | 3 | 7 个格式名常量（`text`/`html`/`richText`/`url`/`bitmap`/`fileList`/`filePromiseList`） | 无（纯常量类，**不是缺陷**） |
| `FileFilter` | `flash.net` | 10 | `description` / `extension` / `macType` / `winType` 四字段真赋值 | `clone()` 报明后返回 `null`（实测：接着访问 `.description` 抛 `#1009`） |
| `FileListEvent` | `flash.events` | 2 | `DIRECTORY_LISTING` 常量、`directory`/`files` 字段 | 事件本身不会派发（目录列举走 `File.getDirectoryListingAsync` 的同步回填） |
| `JPEGEncoderOptions` | `flash.display` | 2 | `quality`（默认 50） | `BitmapData.encode` 对 JPEG 报明（vendored Skia 关了 JPEG 编码） |
| `PNGEncoderOptions` | `flash.display` | 2 | `fastCompression`（默认 `false`） | 同上（WebP 亦然） |
| `InvokeEvent` | `flash.events` | 1 | `INVOKE` 常量、`arguments`/`currentDirectory`/`reason` | 没有「用文档启动」的入口，事件不会来 |
| `LocationChangeEvent` | `flash.events` | 1 | `LOCATION_CHANGE` 常量、`location` 字段 | 依赖 `StageWebView`，见 2.2 |
| `NativeDragEvent` | `flash.events` | 1 | 8 个常量（含项目真正监听的 `NATIVE_DRAG_ENTER`/`NATIVE_DRAG_DROP`）、7 个字段 | 没有 OS 拖放源，事件不会来 |
| `NativeProcessExitEvent` | `flash.events` | 8 | `EXIT` 常量、`exitCode`/`process` | 没有子进程，事件不会来 |
| `NativeWindowBoundsEvent` | `flash.events` | 4 | `MOVE`/`MOVING`/`RESIZE`/`RESIZING`、`beforeBounds`/`afterBounds` | **窗口真会派发这两个事件**（`NativeWindow` 是真的），只是本类实例由窗口层构造，字段来自真实几何 |
| `NativeWindowDisplayStateEvent` | `flash.events` | 0 | `DISPLAY_STATE_CHANGING`/`DISPLAY_STATE_CHANGE`、两字段 | 同上（当前无调用方） |
| `SampleDataEvent` | `flash.events` | 4 | `SAMPLE_DATA`、`data`/`position` | 麦克风回调不存在，事件不会来 |

> `NativeWindowBoundsEvent` / `NativeWindowDisplayStateEvent` 属「模型类真被窗口后端使用」，
> 登记在 shell 列表里只是因为它们的成员集合由 shell 生成；这两个类是**能用的**。

### 2.2 真能力缺口（8 个）

| 类 | 包 | 应用引用 | 现在调用会发生什么（实测） | 真实现需要 |
|---|---|---|---|---|
| `NativeProcess` | `flash.desktop` | 10 | `isSupported=false`；`new` 得到实例，`running=false`、`processID=0`，三个管道是**空 ByteArray**（`bytesAvailable` 0）；`start()` 空转并报明 | 进程创建 + 三条管道 + `exit` 事件回灌 |
| `NativeProcessStartupInfo` | `flash.desktop` | 13 | 7 个字段真赋值；`arguments` 空 Vector、`executable=null` | 无（数据类，配合上一行） |
| `StageWebView` | `flash.media` | 3 | `isSupported=false`；实例可建，`location`/`title`/`viewPort` 全 `null`，`loadURL()` 报明 | 内嵌浏览器（WebView2 / WKWebView） |
| `NativeDragManager` | `flash.desktop` | 1 | `isSupported=false`、`dropAction=null`（报明）；`doDrag`/`acceptDragDrop` 空转 | OS 拖放源 + 拖放目标注册 |
| `NetworkInterface` | `flash.net` | 3 | 10 个字段真赋值（若有实例） | 网卡枚举 |
| `NetworkInfo` | `flash.net` | 3 | `findInterfaces()` 报明并返回**空 Vector** | 同上 |
| `Microphone` | `flash.media` | 4 | `isSupported=false`、`names` 空数组（报明）、`getMicrophone()` 返回 `null`（报明） | 音频采集 |
| `LocalConnection` | `flash.net` | 4 | `isSupported=false`；`send`/`connect`/`close` 空转 | AIR 本身**没有**这个传输（Flash Player 特性），库只拿它当「我是不是在本地」的探针 ⇒ 保持空壳是**正确**答案 |

---

## 3. 成员级的「报明」清单

这些不是整类空替代，而是**真实现里明确不做的成员**（`as_shell_unsupported`，阶段二百九十三全量）：

| 成员 | 原因 |
|---|---|
| `BitmapData.encode("jpeg"/"webp")` | vendored Skia 编译时关了 JPEG/WebP 编码 |
| `Camera.getCamera` / `.name` / `.names` | 无摄像头采集 |
| `CubeTexture.uploadFromByteArray` | 立方体面不从 ByteArray 上传 |
| `Texture.uploadFromByteArray`（mip>0 / 非 8 位格式） | 该路径未实现 |
| `DisplayObject.cacheAsBitmapMatrix` | 渲染器按对象自身分辨率缓存 |
| `DisplayObject.mask` | 渲染器不施加 mask（`clipDepth` 遮罩是另一条已实现的路径） |
| `Error.getStackTrace` | 无 AS3 栈帧模型 |
| `ExtensionContext.createExtensionContext` / `.call` | 无原生扩展宿主（`--air-app` 的 ANE 路径是另一套） |
| `File.moveTo`（跨卷 / 目标已存在且未 overwrite / 源不存在） | 该组合 AIR 抛 `IOError`，我方报明 |
| `File.browseForOpen` / `browseForDirectory` / `openWithDefaultApplication` / `upload` | 未接系统文件对话框 / ShellExecute / HTTP 上传 |
| `DockIcon.bitmaps`（上屏） | 该后端不画 Dock 图标位图 |
| `NativeApplication.systemIdleMode` | 本构建不抑制系统空闲计时 |
| `Clipboard.setData(richText, 非 ByteArray)` | `Clipboard.html` 的类型表要求 `ByteArray`，存别的会让 `getData` 交回不符承诺的类型 |

---

## 4. 已经「毕业」的类

| 类 | 阶段 | 现在是什么 |
|---|---|---|
| `Clipboard` | 二百九十三 | **真实现**：`(format → data)` 条目表 + `generalClipboard` 接操作系统（Windows 四格式互译，见 [`desktop.md`](desktop.md) §7.10） |
| `ClipboardTransferMode` | 二百九十三 | 补齐（此前**整个类缺失**，`import flash.desktop.ClipboardTransferMode` 编译不过） |
| `System.setClipboard` | 二百九十三 | 真实现（= `clear()` + `setData(TEXT_FORMAT, s)`） |

---

## 5. 复核方式

```bash
# 列出全部 shell 类登记点
grep -n "shell('" src/symbols.ts

# 生成侧招牌（每个 shell 类一行）
grep -n "shell class" <生成的 .c>

# 本机看某个类到底给什么（探针写法见 temp/clip/t4.as）
node src/index.ts <probe>.as -o out --run
```

判据：`adl` 能跑对而我们跑不出 ⇒ **遗留缺陷**（应进 `TODO.md` 的「遗留待开发」）；
`adl` 本来就报错、或该 API 在 AIR 里根本不存在 ⇒ 才是**增强**。本清单里的 8 个真能力缺口
全部属第一类，除非某平台**物理上不存在**该能力（`LocalConnection` 在 AIR 里就没有传输）。