# 空替代（shell）清单

> 文件交互更新：`File.browseFor*`、`FileReference.browse/load/save`、`FileReferenceList.browse` 在 macOS 原生窗口构建已有后端，见 [当前实现](desktop-file-interaction.md)。macOS 拖放和 Windows Shell/OLE 后端代码已接入，但 Windows 因 ACP/UTF-8 路径边界尚未迁移而默认关闭，且未编译/未真机验证；macOS 外部投递验收仍未完成；HTTP 上传下载仍有桩。

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

### 2.1 数据载体：字段与常量是真的（11 个）

| 类 | 包 | 应用引用 | 真的给得出 | 给不出 |
|---|---|---|---|---|
| `ClipboardFormats` | `flash.desktop` | 3 | 7 个格式名常量（`text`/`html`/`richText`/`url`/`bitmap`/`fileList`/`filePromiseList`） | 无（纯常量类，**不是缺陷**） |
| `FileListEvent` | `flash.events` | 2 | `DIRECTORY_LISTING`/`SELECT_MULTIPLE` 常量、`files` 字段、4 参数构造器、`clone()` | 无（阶段二百九十九修正：`directory` 是自造成员，已删；事件由 `File.getDirectoryListingAsync` 真派发） |
| `JPEGEncoderOptions` | `flash.display` | 2 | `quality`（**uint**，默认 **80**） | 无（JPEG 编码阶段四百二十三已实装，走 libjpeg-turbo C API；encode 时 quality>100 抛 `#2006`） |
| `PNGEncoderOptions` | `flash.display` | 2 | `fastCompression`（默认 `false`） | 无（PNG 编码阶段四百二十一、JPEG 阶段四百二十三已实装；WebP 仍报明） |
| `InvokeEvent` | `flash.events` | 1 | `INVOKE` 常量、`arguments`/`currentDirectory`/`reason` | 没有「用文档启动」的入口，事件不会来 |
| `LocationChangeEvent` | `flash.events` | 1 | `LOCATION_CHANGE` 常量、`location` 字段 | 依赖 `StageWebView`，见 2.2 |
| `NativeDragEvent` | `flash.events` | 1 | 8 个常量（含项目真正监听的 `NATIVE_DRAG_ENTER`/`NATIVE_DRAG_DROP`）、7 个字段 | 已接原生拖放会话，平台验收状态见 desktop-file-interaction.md |
| `NativeProcessExitEvent` | `flash.events` | 8 | `EXIT` 常量、`exitCode`（**`number`**，实测 `typeof` 如此） | **真事件**：子进程退出时由 `NativeProcess` 派发；早期自造的 `process` 字段已删（`mxmlc`/`describeType` 均无此成员），见 `native-process.md` §1 |
| `NativeWindowBoundsEvent` | `flash.events` | 4 | `MOVE`/`MOVING`/`RESIZE`/`RESIZING`、`beforeBounds`/`afterBounds` | **窗口真会派发这两个事件**（`NativeWindow` 是真的），只是本类实例由窗口层构造，字段来自真实几何 |
| `NativeWindowDisplayStateEvent` | `flash.events` | 0 | `DISPLAY_STATE_CHANGING`/`DISPLAY_STATE_CHANGE`、两字段 | 同上（当前无调用方） |
| `SampleDataEvent` | `flash.events` | 4 | `SAMPLE_DATA`、`data`/`position` | Windows 采集真派发（B1b，阶段四百二十五）；非 Windows 无采集后端，事件不来 |

> `NativeWindowBoundsEvent` / `NativeWindowDisplayStateEvent` 属「模型类真被窗口后端使用」，
> 登记在 shell 列表里只是因为它们的成员集合由 shell 生成；这两个类是**能用的**。

### 2.2 真能力缺口（4 个）

> 阶段三百六十三之前这里还有 `NetworkInfo` / `NetworkInterface` 两行。它们已经不是缺口了：
> `findInterfaces()` 现在真的走 `getifaddrs` 枚举网卡，`NetworkInterface` / `InterfaceAddress`
> 随之变成真实数据类（字段集合也按 adl 实测改对了）。**Windows 于阶段四百二十补上
> `GetAdaptersAddresses` 分支**（GUID name / FriendlyName / 大写 `-` MAC / OperStatus active，
> 逐行对齐 adl），WASI 仍报明。契约与验收见 `flash-net.md` §6.10 / §6.10.5。
>
> 阶段三百九十一之前这里还有 `NativeProcess` / `NativeProcessStartupInfo` 两行：现在
> `start()` 真的创建子进程（Windows `CreateProcessW`、POSIX `fork`+`execv`），三条管道是活管道，
> `exit` 事件在帧边界真派发，`executable`/`workingDirectory` 的 setter 校验抛 `#3214`/`#3215`。
> 契约、事件顺序与三处如实报明的差异见 [`native-process.md`](native-process.md)。

| 类 | 包 | 应用引用 | 现在调用会发生什么（实测） | 真实现需要 |
|---|---|---|---|---|
| `StageWebView` | `flash.media` | 3 | `isSupported=false`；实例可建，`location`/`title`/`viewPort` 全 `null`，`loadURL()` 报明 | 内嵌浏览器（WebView2 / WKWebView） |
| `NativeDragManager` | `flash.desktop` | 1 | 原生窗口后端接入 `doDrag`/`acceptDragDrop`/动作与会话状态；无后端 isSupported=false | Windows 未验证；macOS 外部投递矩阵待验收 |
| `Microphone` | `flash.media` | 4 | **设备面 + 采集真实现（阶段四百二十四/四百二十五，Windows WASAPI）**：`names`/`isSupported`/`getMicrophone`/`getEnhancedMicrophone` 真枚举查找（AIR 默认值 rate 8/gain 50/codec nellymoser 等，越界 null）；`setLoopBack(true)` 启动采集线程（设备 mix format 下混单声道 + 线性重采样到 `rate` kHz），`SampleDataEvent.SAMPLE_DATA` 每事件 2048 个大端 float32 样本（`data.length` 8192、`position` 累加 2048）、实时 `activityLevel` 0..100（采集前/后 -1）；`setSilenceLevel`/`setUseEchoSuppression` 真 setter；非 Windows 报明 | 其余 AIR 成员（requestPermission/permissionStatus/soundTransform/enhancedOptions 等） |
| `LocalConnection` | `flash.net` | 4 | `isSupported=false`；`send`/`connect`/`close` 空转 | AIR 本身**没有**这个传输（Flash Player 特性），库只拿它当「我是不是在本地」的探针 ⇒ 保持空壳是**正确**答案 |

---

## 3. 成员级的「报明」清单

这些不是整类空替代，而是**真实现里明确不做的成员**（`as_shell_unsupported`，阶段二百九十三全量）：

| 成员 | 原因 |
|---|---|
| `BitmapData.encode("webp")` | vendored Skia 编译时关了 WebP 编码（**PNG 阶段四百二十一、JPEG 阶段四百二十三已实装**，见 §4） |
| `CubeTexture.uploadFromByteArray` | 立方体面不从 ByteArray 上传 |
| `Texture.uploadFromByteArray`（mip>0 / 非 8 位格式） | 该路径未实现 |
| `ExtensionContext.createExtensionContext` / `.call` | 无原生扩展宿主（`--air-app` 的 ANE 路径是另一套） |
| `FileReference.download` / `requestPermission` | 下载与权限询问没有后端（`upload` / `uploadUnencoded` 已在阶段三百八十八接上原生 curl 后端，见 [`flash-net.md`](flash-net.md) §6.11）。它们**报明后返回**，不假装「用户点了取消」—— 没有对话框/传输，`data`/`name` 这些「结果」字段永远为空 |
| `File.icon` 的位图内容 | 无图标提取（macOS 走 `NSWorkspace.iconForFile`）。给空 `Icon` 并报明；`bitmapDatas` 回空数组（AIR 51.4 里读它本身就抛 `#1069`） |
| `File.getVolumeByDrive` / `getVolumeByPath` | 无卷枚举（`getmntinfo`/`statfs`）。`StorageVolume` 的构造器与六个 getter 已按实测实现，缺的是「谁来造它」 |
| `DockIcon.bitmaps`（上屏） | 该后端不画 Dock 图标位图 |
| `Clipboard.setData(richText, 非 ByteArray)` | `Clipboard.html` 的类型表要求 `ByteArray`，存别的会让 `getData` 交回不符承诺的类型 |

---

## 4. 已经「毕业」的类

| 类 | 阶段 | 现在是什么 |
|---|---|---|
| `Clipboard` | 二百九十三 | **真实现**：`(format → data)` 条目表 + `generalClipboard` 接操作系统（Windows 四格式互译，见 [`desktop.md`](desktop.md) §7.10） |
| `ClipboardTransferMode` | 二百九十三 | 补齐（此前**整个类缺失**，`import flash.desktop.ClipboardTransferMode` 编译不过） |
| `System.setClipboard` | 二百九十三 | 真实现（= `clear()` + `setData(TEXT_FORMAT, s)`） |
| `FileFilter` | 二百九十九 | **真类**，三个字段；删掉自造的 `winType`/`name`/`clone()` |
| `FileReference` | 二百九十九 | **真类**（`File` 的父类）：未选择过文件时除 `data`（null）外全部 `#2037`，`toString()` 与实测一致；`upload`/`uploadUnencoded` 是真传输（阶段三百八十八），`download`/`requestPermission` 报明 |
| `FileReferenceList` | 二百九十九 | **真类**：`fileList` 初值 `null` 且只读（与 `adl` 实测一致） |
| `StorageVolume` / `StorageVolumeChangeEvent` | 二百九十九 | **真类**：构造器按实测参数序、六个只读 getter、两个常量 + `clone()` |
| `FileStream` | 二百九十九 | **不是空替代了**：真 `implements IDataInput, IDataOutput`（23 个读写成员 + `endian`/`objectEncoding`/`readAhead` + 可写 `Number` 的 `position`），见 [`filesystem.md`](filesystem.md) §13.1 |
| `BitmapData.encode`（PNG） | 四百二十一 | **真编码**：`SkPngEncoder` 内存编码（`sk_image_encode_png_mem`），按 AIR 实测的**三参**签名 `(rect, compressor, byteArray=null)`（无 `byteArrayOffset`）、在当前 `position` 写入并推进/自动扩 `length`（writeBytes 语义）、null rect/compressor 抛 `#2007`、null byteArray 静默 no-op；不透明像素回环精确，半透明经 premultiply 舍入（AIR 亦然）。WebP 仍报明。见 `examples/png-encode.as` |
| `BitmapData.encode`（JPEG） | 四百二十三 | **真编码**：直接驱动 libjpeg-turbo C API（`sk_image_encode_jpeg_mem`，vendored `libjpeg.lib` 带压缩符号，**无需重编 Skia**；`jpeg_mem_dest` 不在库中故自带内存 destination）。`JPEGEncoderOptions.quality` 为 **uint 默认 80**（构造器不校验，`-5` 读回 4294967291），encode 时 >100 抛 `#2006`；去 alpha 取 **premul-over-black** RGB（实测 `0x80FF0000`→rgb `800000`、alpha 255，与 AIR 逐字一致）；写入语义/错误码同 PNG。低 quality 小图的压缩字节数与 AIR 略异（编码器版本差，非契约）。见 `examples/jpeg-encode.as` |
| `File.openWithDefaultApplication` | 四百二十二 | **真实现**：复用 `as_open_external` seam（Win `ShellExecuteW` / mac `open` / Linux `xdg-open`）；空 File（无路径）抛 `#1009`（openWith 特例，非通用的 `#2037`）、路径不存在抛 `#3003`、目录可打开（资源管理器）。成功路径真机验证。见 `examples/desktop-integration.as` |
| `NativeApplication.systemIdleMode` | 四百二十二 | **真后端**：setter 校验 null 抛 `#2007`（idleMode）、非法值抛 `#2008`；`KEEP_AWAKE` 走 `SetThreadExecutionState`（Win）/ `IOPMAssertion`（mac），`NORMAL` 释放；get/set 往返不变。见 `examples/desktop-integration.as` |
| `Microphone`（设备面） | 四百二十四 | **真设备枚举**（B1a，Windows WASAPI `as_mic_scan`：`eCapture`/`DEVICE_STATE_ACTIVE`，friendly name 与 AIR 逐字一致）：`names` 每次新 Array、`isSupported` 真值、`getMicrophone`/`getEnhancedMicrophone` 真查找（index<0→0、越界 null）并按 AIR 实测填默认值（rate 8/gain 50/silenceLevel 10/silenceTimeout 2000/activityLevel -1/muted false/codec nellymoser/enableVAD true）。删掉自造的 `fps` 字段与 `setCodec`/`setRate` 方法（describeType 证实 AIR 无此三者）。采集线程与 SampleDataEvent 属 B1b。见 `examples/microphone-devices.as` |
| `Microphone`（采集） | 四百二十五 | **真采集 + SampleDataEvent**（B1b，Windows WASAPI 共享模式）：`setLoopBack(true)` 起采集线程，抓设备 mix format（本机 48 kHz 立体声 float32——共享模式拒自定义速率 `AUDCLNT_E_UNSUPPORTED_FORMAT`）→下混单声道→线性重采样到 `rate` kHz→2048 样本缓冲入锁保护队列；帧边界 `as_mic_dispatch`（emit.ts 发射）建 `ByteArray`（2048 大端 float32，`data.length` 8192）+ `SampleDataEvent`（`position` 累加 2048）派发，实时 `activityLevel` 0..100。线程不碰 AS3/GC，`as_mic_mark_roots` 把活 Microphone 列为永久根。`setSilenceLevel`/`setUseEchoSuppression` 真 setter（后者为提示，共享模式回声消除是系统效果）。契约对照 adl 51.4.1（`temp/micprobe/MicCapture.as`）。见 `examples/microphone-capture.as` |
| `Camera`（设备面） | 四百二十六 | **真设备枚举**（B2，Windows DirectShow `as_cam_scan`：`CLSID_VideoInputDeviceCategory`，friendly name 与 AIR 逐字一致）：`names` 每次新 Array、`isSupported` 真值、`getCamera(name=null)` 真查找（null→首设备、按设备名**或索引串**匹配——`getCamera("0")` 选设备 0、越界/坏名 null），只读 `name`/`index` 反映清单。`ICreateDevEnum` 手声明（strmif.h 需 NOGDI 隐藏的 RGNDATA/BITMAPINFOHEADER），IMoniker/IPropertyBag 走 ocidl.h，GUID 手写免 strmiids，PropVariant 免 oleaut32。**采集仍走应用 ANE，本阶段无视频流**。契约对照 adl 51.4.1（`temp/camprobe/CameraProbe.as`）。见 `examples/camera-devices.as` |
| `DisplayObject.mask`（Bitmap/TextField 像素遮罩） | 四百二十七 | **像素 alpha 裁剪**（D1）：Bitmap/TextField 遮罩无矢量轮廓，按其**像素**裁剪——content 设 `cacheAsBitmap` 时生效：mask 也缓存为**软 alpha**、仅 content 缓存为**二值模板**（任何覆盖→不透明）。实现：content 隔离 saveLayer + 遮罩子树光栅化 + `kDstIn` 合成（二值时 alpha 阈值化 `sk_surface_threshold_alpha`）。矢量遮罩仍走 clipPath，`visible`/alpha 对矢量遮罩依旧忽略。契约对照 adl 51.4.1（`temp/maskprobe`，二值精确、软 alpha 容差内）。见 `examples/pixel-mask.as` |
| `DisplayObject.cacheAsBitmapMatrix` | 四百二十八 | **按矩阵缓存 + 逆变换 blit**（D2）：AIR 把对象按所设矩阵缓存、再以逆矩阵 blit，故**最终画面不变**（仅缓存分辨率随矩阵缩放，2x 矩阵烘 2x 位图）；移动/GPU 特性，adl 桌面 CPU 模式 no-op（getter 回 null）。实现：`as_render_cached` 门控非单位矩阵，bounds 取矩阵变换后 AABB、surface concat M、blit concat M⁻¹（画面恒等），矩阵态禁增量 patch/跳过 bake-verify。getter 保留回读。契约对照 adl 51.4.1（`temp/cabmprobe`，scale/translate/identity 逐像素一致）。见 `examples/cache-matrix.as` |
| `Error.getStackTrace` | 四百三十一 | **AS3 栈帧模型**（F1）：运行时维护 TLS 影子栈（`as_astack_enter/leave`，类/方法名），函数入口 push、返回 leave、catch/帧边界恢复深度；Error **构造时**快照栈（`_stacktrace` 私有字段），`getStackTrace` 按 AIR 文本返回 `name: message\n\tat Class/method()…`（内层在前、构造帧 `Class()`、自由函数 `global/fn()`），无栈返 null。契约对照 adl 51.4.1（`temp/stackprobe`，AS3 authored 帧逐帧一致；ADL 加载器帧不同源、以 `global()` 脚本帧替代）。见 `examples/error-stacktrace.as` |

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
`adl` 本来就报错、或该 API 在 AIR 里根本不存在 ⇒ 才是**增强**。本清单里的 4 个真能力缺口
全部属第一类，除非某平台**物理上不存在**该能力（`LocalConnection` 在 AIR 里就没有传输）。