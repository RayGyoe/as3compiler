# 真应用缺口收口 · 实施立项（WBS）

> 本文是把一个**真实视频会议室应用** AOT 化时暴露的编译器缺口，按子系统切分成可施工阶段的**施工图**。
> 缺口三来源：[`stubs.md`](stubs.md)（空替代清单）、真应用 `--air-app` 主构建的生成 C、应用源码逐处核对。
> 与 [`stubs.md`](stubs.md) 的分工：stubs 回答「**现在**给得出什么、给不出什么」，本文回答「**按什么顺序补、改哪个文件的哪一段、怎么验收**」。
>
> **判定口径（AGENTS.md §1.5）**：本文所列缺口**全部是 AIR 已定义的标准 API**——`adl` 跑得对、我们跑不出/跑错 ⇒
> 一律属**遗留缺陷**（进 `TODO.md`「遗留待开发」），**不是增强**（不进 [`enhancements.md`](enhancements.md)）。
>
> **命名约定**：依私有项目约定，本文以「**真应用**」指代该商业应用，**不出现其项目名与可识别源码路径**；
> 应用侧用法只按**功能**描述（会议快照、麦克风音量监听、设备 UUID 等）。编译器侧证据给精确 `file:line`。
>
> 状态：**执行中**（2026-11-15 立项）。基线版本 `v0.4.395`（阶段四百一十九）。
> **进度**：**C1 已落地**（阶段四百二十，`v0.4.396`，口径见 `flash-net.md` §6.10.5）；**A1 已落地**（阶段四百二十一，`v0.4.397`，PNG 真编码，口径见 `stubs.md` §4 与 `examples/png-encode.as`）；**E1+E2 已落地**（阶段四百二十二，`v0.4.398`，openWith + systemIdleMode，口径见 `stubs.md` §4 与 `examples/desktop-integration.as`）；**A2 已落地**（阶段四百二十三，`v0.4.399`，JPEG 真编码、**无需重编 Skia**，口径见 `stubs.md` §4 与 `examples/jpeg-encode.as`）；**B1a 已落地**（阶段四百二十四，`v0.4.400`，Microphone 设备面真枚举，口径见 `stubs.md` §4 与 `examples/microphone-devices.as`）；**B1b 已落地**（阶段四百二十五，`v0.4.401`，Microphone 采集 + SampleDataEvent，口径见 `stubs.md` §4 与 `examples/microphone-capture.as`）；**B2 已落地**（阶段四百二十六，`v0.4.402`，Camera 设备面真枚举，口径见 `stubs.md` §4 与 `examples/camera-devices.as`）；**D1 已落地**（阶段四百二十七，`v0.4.403`，Bitmap/TextField 像素遮罩，口径见 `stubs.md` §4 与 `examples/pixel-mask.as`）；**D2 已落地**（阶段四百二十八，`v0.4.404`，cacheAsBitmapMatrix 按矩阵缓存+逆变换 blit，口径见 `stubs.md` §4 与 `examples/cache-matrix.as`）；其余里程碑待开工。

---

## 0. 平台与优先级口径

- **真应用是 Windows-x86**（描述符 `architecture=32`），故本规划**Windows 优先**；macOS parity 在可行处一并落，
  纯 POSIX 已有实现（如 `getifaddrs`）不重做。开发机当前为 Windows，多数阶段可本机真验。
- **子系统聚合**：图像编码 / 媒体采集 / 网络与设备信息 / 渲染与遮罩 / 桌面系统集成 / 诊断，各成一批（§4），
  批内按「影响 × 成本」排优先级；跨批推荐执行序见 §5。
- **阶段号与版本**：每阶段一个小版本号（`v0.4.x → v0.4.x+1`）。本文用里程碑号 `A1…F1` 指代阶段，
  **实际阶段号在落地时分配**（并行轨可能占号），不在此写死。

---

## 1. 现状基线（已核实，2026-11-15）

开工前逐项核对代码，避免把「已经有了的」重做一遍。**下列「不是缺口」项尤其重要**——它们在生成 C 里
以死代码 fallback 形式出现，容易被误判成缺口。

| 事实 | 位置 | 对实施的意义 |
|---|---|---|
| **`BitmapData.encode` 对 JPEG 与 PNG 都是空壳** | `src/emit.ts:24176` `BitmapData_encode`：识别 compressor 后 `as_shell_unsupported`，**不写任何字节** | 两种格式都要补；注释自认 PNG 编码器已链 |
| **`SkPngEncoder` 已链进 glue** | `vendor/skia_glue.cc:133` `#include SkPngEncoder.h`、`:1829` `SkPngEncoder::Encode` | **PNG 是低垂果实**：接线即可，无需重编 Skia |
| **Skia 关了 JPEG/WebP 编码** | `skia_use_libjpeg_turbo_encode=false` / `_libwebp_encode=false`（`emit.ts:24172` 注释） | JPEG 需开 Skia 编码或独立链 libjpeg-turbo（§4 批一 A2） |
| **`Microphone` 是 shell 类** | `src/symbols.ts` `shell('Microphone')`；`getMicrophone()` 返 `null`、`names` 空、`isSupported=false` | 需音频采集后端 + `SampleDataEvent` 帧边界派发 |
| **`Camera.getCamera`/`names` 报明** | `src/emit.ts:16461` `Camera_getCamera_static` 返 `NULL` | 设备枚举需后端；真应用视频采集走 ANE，枚举是独立需求 |
| **`NetworkInfo.findInterfaces` 仅 `__APPLE__` 有真实现** | `src/runtime.ts:15103` `as_net_scan` 用 `getifaddrs`（`#if defined(__APPLE__)`），`#else`（`:15188`）报明返空 | **Windows 落空**：需 `GetAdaptersAddresses`（§4 批三 C1） |
| **`DisplayObject.mask` 仅包围盒精度** | 生成 C 报明「a Bitmap/TextField used as a mask (stencilled by its box, not its pixels)」 | Bitmap/TextField 当遮罩需像素模板；矢量 clipDepth 遮罩是另一条已实现路径 |
| **`cacheAsBitmapMatrix` 存而不用** | `src/emit.ts:13294-13298`：getter 回读所设矩阵，但渲染器按对象自身分辨率缓存 | 需渲染器尊重该矩阵 |
| **`File.openWithDefaultApplication` 空壳** | `src/emit.ts:21013` 报明 | 接 `ShellExecute`/`NSWorkspace.open` |
| **`systemIdleMode` 仅字符串往返** | `src/emit.ts:13053-13063`：get/set 回读，但**无 OS 效果** | 接 `SetThreadExecutionState`/`IOPMAssertion` |
| **`Error.getStackTrace` 返空串** | `src/emit.ts:12038-12042` 报明返 `""` | 需 AS3 栈帧模型（throw 时捕获） |
| **`BitmapData.applyFilter` 的 DropShadow/Glow 抛错** | `src/emit.ts:24189`：`not implemented`；BlurFilter 已实现 | 补两种滤镜光栅化 |
| **`NativeProcess` 已实装（不是缺口）** | `src/native-process.ts:272` `CreateProcessW`、`:486` `as_np_start`；`emit.ts:4576` 接线 | 生成 C 里「no process backend」是**无后端构建的死代码**；真应用 13 处引用均可用 |
| **`NativeDragManager` 原生会话已接、Windows 未验证** | `stubs.md` §2.2；`desktop-file-interaction.md` | 属「验证/补全」而非「从零做」 |

---

## 2. 缺口总表（应用功能证据 × 分类 × 批次）

应用侧只按功能描述（命名约定见文首）。**分类列全部为「遗留」**（§1.5）。

| # | 缺口 | 真应用功能（泛称） | 影响 | 批次·阶段 |
|---|---|---|---|---|
| 1 | `BitmapData.encode` PNG | 图像导出/PNG 快照 | 高（编码全空壳） | 批一 A1 |
| 2 | `BitmapData.encode` JPEG | **会议快照**（JPEG 高质量） | 高 | 批一 A2 |
| 3 | `BitmapData.applyFilter` DropShadow/Glow | 位图滤镜处理 | 低（1 处调用） | 批一 A3 |
| 4 | `Microphone.getMicrophone` + `SampleDataEvent` | **管理员/主讲人麦克风音量监听** | 高（try/catch 静默失效） | 批二 B1 |
| 5 | `Camera.getCamera` / `Camera.names` | 摄像头设备枚举/选择 | 中（视频采集走 ANE） | 批二 B2 |
| 6 | `NetworkInfo.findInterfaces`（Windows） | **取网卡 MAC 做设备 UUID** | 高（Windows 返空） | 批三 C1 |
| 7 | `DisplayObject.mask` 像素精度 | UI 遮罩（17 处 `.mask=`） | 中 | 批四 D1 |
| 8 | `DisplayObject.cacheAsBitmapMatrix` | 缓存渲染优化（7 处） | 中低 | 批四 D2 |
| 9 | `File.openWithDefaultApplication` | 用默认程序打开文件（2 处） | 中 | 批五 E1 |
| 10 | `NativeApplication.systemIdleMode` | 长加载/会议保活（KEEP_AWAKE） | 低 | 批五 E2 |
| 11 | `NativeDragManager`（Windows） | 拖放（1 处） | 低 | 批五 E3 |
| 12 | `Error.getStackTrace` | 错误诊断（2 处） | 低 | 批六 F1 |

---

## 3. 范围

### 3.1 做（本文 12 项）

§2 总表全部。每项落地后：`stubs.md` 对应行转「毕业」、`TODO.md` 遗留表按「移出/改写」记账、配示例 + 单元钉。

### 3.2 不做（看似缺口、实际不构成真应用问题）

| 项 | 原因 |
|---|---|
| `StageWebView` | 真应用用自有 `NativeWindow` 包装 + WebView **ANE**，不走编译器内建 `StageWebView` |
| `air.net.WebSocket` | 真应用保留 WebSocket **ANE**；编译器侧 `air.net.WebSocket` 已实装（阶段四百一十三） |
| RTC 音视频采集/渲染 | 走 RTC **ANE**；本规划只补「设备枚举/音量监听」这类 ANE 之外的内建需求 |
| `NativeProcess` | **已实装**（`native-process.ts`），不是缺口 |
| `LocalConnection` | AIR 本身**无此传输**（Flash Player 特性），空壳是正确答案；真应用当「是否本地」探针 |
| `SecureSocket` TLS | 缺口，但真应用正**删除该回退路**（其 WebSocket 迁移计划），不补 |
| `air.security.Digest` | 缺口，**零消费者**，不补 |
| `FileReference.download` | 真应用 **0 引用**，不补 |
| `ByteArray` Base64 三件套 | **阶段四百一十六已补**（`toBase64`/`writeBase64`/`createFromBase64`） |

---

## 4. 子系统批次与里程碑

> 每阶段通用验收（DoD，AGENTS.md §4）：示例 `examples/*.as` 跑通且输出正确 + `test/unit/` 结构钉 +
> 全量 `node test.ts` 无破坏 + 中英文档同步 + 版本号递增 + `TODO.md` 记账。下文「验收」只列**该阶段特有**的可执行判据。
> 工作量为**估算**，含真机验证；媒体/渲染类含硬件依赖风险（§7）。

### 批一 · 图像编码（`BitmapData`）

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **A1 PNG encode** ✅ **已落地（阶段四百二十一，v0.4.397）** | 把 `BitmapData_encode` 的 PNG 分支接到已链的 `SkPngEncoder`（新增内存版 `sk_image_encode_png_mem`），写回 `ByteArray`。**实测签名是三参 `(rect, compressor, byteArray=null)`，无 `byteArrayOffset`**（原四参建模已改回）；在当前 `position` 写入并推进/扩 `length` | `emit.ts` `BitmapData_encode`；`skia_glue.cc` 内存编码 seam | 不透明像素回环**精确**；`position`/`length` 按 AIR；PNG 魔数 `89 50 4E 47`；null rect/compressor `#2007`、null byteArray 静默；半透明经 premultiply 舍入（AIR 亦然，登记偏差） | 0.5 d | 全平台 |
| **A2 JPEG encode** ✅ **已落地（阶段四百二十三，v0.4.399）** | **无需重编 Skia**：vendored `libjpeg.lib` 本就带压缩符号，直接驱动 libjpeg-turbo C API（`sk_image_encode_jpeg_mem`，自带内存 destination），接 `JPEGEncoderOptions.quality`（uint 默认 80，>100 抛 #2006） | `vendor/skia_glue.cc` + `emit.ts` encode JPEG 分支 | 不同 `quality` 出不同可解码字节；premul-over-black 去 alpha 与 AIR 逐字一致；**整批图像示例回归绿**（694/690） | 1–2 d | 全平台 |
| **A3 applyFilter 阴影/发光** ✅ **已落地（阶段四百二十九，v0.4.405）** | `DropShadowFilter`/`GlowFilter` 光栅化（BlurFilter 保留 CPU 盒模糊）：复用 `DisplayObject.filters` 路径同一套 Skia image-filter seam，源区域画进带 padding 表面、saveLayer paint 施滤镜、读回像素按 `destPoint` 锚定 blit | `emit.ts` `BitmapData_applyFilter`（去抛错） | 与 AIR 同参滤镜像素差 ≤ 容差（阴影偏移/模糊、发光环绕、hideObject 仅阴影逐字一致；发光 fringe alpha 差 8 在模糊容差内）；未知滤镜 no-op、无 Skia 降级报明 | 1–2 d | 全平台 |

批内序：**A1 → A2 → A3**（A1 零重编先落；A2 已落——实测**无需重编 Skia**，vendored libjpeg.lib 带压缩符号；**A3 已落地**，阶段四百二十九）。**批一全部完成**。WebP encode 列**待定**（真应用未用）。

### 批二 · 媒体采集（`flash.media`）

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **B1a Microphone 设备面** ✅ **已落地（阶段四百二十四，v0.4.400）** | `names`/`isSupported`/`getMicrophone`/`getEnhancedMicrophone` 真实现（Windows WASAPI `as_mic_scan`：`eCapture`/`DEVICE_STATE_ACTIVE`，friendly name 与 AIR 逐字一致）；AIR 默认值（rate 8/gain 50/codec nellymoser 等）、index<0→0、越界 null；删掉自造 `fps`/`setCodec`/`setRate`（describeType 证实 AIR 无） | `runtime.ts` `as_mic_scan` seam + `emit.ts` 静态成员 override + `symbols.ts` 去自造成员；`ole32` 随目标链接 | 设备面与 AIR 逐字一致（`temp/micprobe` A/B）；平台感知示例无设备 CI 也过；**694+ 回归绿** | 0.5 d | Win 优先 |
| **B1b Microphone 采集** ✅ **已落地（阶段四百二十五，v0.4.401）** | 采集线程 → 锁下队列 → **帧边界派发 `SampleDataEvent`**（同 WebSocket/Socket 形态，AS3/GC 不上工作线程）；`setSilenceLevel`/`setUseEchoSuppression` 真 setter、实时 `activityLevel` 0..100 | Win WASAPI 共享模式采集 glue（mix format 下混+线性重采样到 rate kHz）；GC 根 `as_mic_mark_roots` + `as_mic_dispatch`（emit.ts 发射） | 契约对照 adl 51.4.1：每事件 2048 大端 float32（data.length 8192）、position 累加 2048、activityLevel 随声压；平台感知示例无设备 CI 也过；**696+ 回归绿** | 2–4 d | Win 优先 |
| **B2 Camera 枚举** ✅ **已落地（阶段四百二十六，v0.4.402）** | `Camera.names`/`getCamera(name)` 设备枚举（**采集仍走 ANE**，本阶段不做视频流） | Windows DirectShow `as_cam_scan`（`CLSID_VideoInputDeviceCategory`；ICreateDevEnum 手声明、ocidl.h、GUID 手写免 strmiids、PropVariant 免 oleaut32）；mac AVFoundation 待后续 | `names` 列出真实设备（与 AIR 逐字一致）、`getCamera` 按名/索引串取到（null→首、越界/坏名 null）、`isSupported` 真值、只读 name/index；平台感知示例无设备 CI 也过；**698+ 回归绿** | 1–2 d | Win 优先 |

批内序：**B1 → B2**（B1 高影响）。B1 拆 B1a 设备面（**已落地**，阶段四百二十四）、B1b 采集+事件（**已落地**，阶段四百二十五，硬依赖 B1a 设备面），分两阶段降风险。**B2 已落地**（阶段四百二十六，Camera 设备面；采集仍走 ANE）。
**红线**：采集回调不得在 worker 线程碰 AS3/GC；新增 box tag/根须同步 GC 四处（AGENTS.md 内存红线）。

### 批三 · 网络与设备信息（`flash.net`）

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **C1 findInterfaces Windows** ✅ **已落地（阶段四百二十，v0.4.396）** | `as_net_scan` 增 `ASC_NET_WIN32` 分支：`GetAdaptersAddresses` 枚举网卡。**实测 Windows 语义与 POSIX 不同**（GUID name / FriendlyName / 大写 `-` MAC / `OperStatus` active / unicast 自然序，非「内 IPv4 先」），按 adl 51.4.1 逐行对齐 | `runtime.ts` `as_net_scan`；链 `iphlpapi` | Windows 真机 7 网卡全字段对 adl diff 为空；`net-interfaces.as` 平台感知双端过；macOS 不回退 | 0.5–1 d | Win（mac 已有） |

批内仅 C1。**低垂果实 + 高影响**（设备 UUID），推荐跨批先做（§5）。

### 批四 · 渲染与遮罩（`flash.display`）

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **D1 mask 像素精度** ✅ | Bitmap/TextField 当遮罩时按**像素 alpha** 裁剪（content 设 cacheAsBitmap 生效：双缓存软 alpha、仅 content 缓存二值模板）；矢量 clipDepth 路径不动。**已落地**（阶段四百二十七）：content saveLayer + 遮罩光栅化 + `kDstIn` 合成（`sk_surface_threshold_alpha` 二值化），adl 像素 A/B 二值精确、软 alpha 容差内 | 渲染器 mask 路径（`skia_glue.cc` dstin/threshold + `emit.ts` `as_mask_pixel_composite`） | 与 AIR 同遮罩像素差 ≤ 容差（圆形/文字遮罩锯齿边）；17 处用法抽样回归 | 2–3 d | 全平台 |
| **D2 cacheAsBitmapMatrix** ✅ | 渲染器尊重所设矩阵：按矩阵缓存 + 逆变换 blit，**画面恒等**、仅缓存分辨率随矩阵缩放。**已落地**（阶段四百二十八）：`as_render_cached` 门控非单位矩阵，bounds 取变换后 AABB、surface concat M、blit concat M⁻¹；getter 保留回读。adl 桌面 CPU 模式自身 no-op（getter null），scale/translate/identity 逐像素 A/B 一致 | `emit.ts` `as_render_cached`/setter | 设矩阵后缓存分辨率/变换与 AIR 一致；getter 回读不变 | 1–2 d | 全平台 |

批内序：**D1 → D2**（D1 影响面大）。两项都动渲染器，**须整批渲染/文本示例双端复验**（参照阶段四百一十八设备字体教训）。**D1 已落地**（阶段四百二十七）；**D2 已落地**（阶段四百二十八），批四全部完成。

### 批五 · 桌面系统集成

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **E1 openWithDefaultApplication** ✅ **已落地（阶段四百二十二，v0.4.398）** | 复用 `as_open_external` seam（Win `ShellExecuteW`/mac `open`/Linux `xdg-open`）。**实测**：空 File 抛 `#1009`（特例，非通用 `#2037`）、不存在 `#3003`、目录可开 | `emit.ts` `File_openWithDefaultApplication` | 真机打开默认程序（目录成功路径已验）；错误契约对齐 adl | 0.5 d | Win 优先 |
| **E2 systemIdleMode** ✅ **已落地（阶段四百二十二，v0.4.398）** | `KEEP_AWAKE` 接 `SetThreadExecutionState`（Win）/`IOPMAssertion`（mac），`NORMAL` 释放。**实测**：null 抛 `#2007`（idleMode）、非法值 `#2008` | `emit.ts` setter + runtime `as_set_idle_mode` | 设 `KEEP_AWAKE` 后系统空闲计时被抑制（真机/电源 API 观测）；get/set 往返不变 | 0.5 d | Win 优先 |
| **E3 NativeDragManager Windows** ✅ **已落地（阶段四百三十，v0.4.406）** | 验证/补全 OLE 拖放：按 adl 实测对齐 `doDrag`/`acceptDragDrop`/`dropAction` 的错误/no-op 契约（会话外 setter/acceptDragDrop 静默 no-op、doDrag 仅 null clipboard 抛 #2007）；drag-IN/drag-OUT 会话状态机不变 | `src/native-drag.ts`（共享 mac/Win） | 错误/no-op 契约与 adl 逐字一致（`unit: desktop/native drag` 两用例）；drag-IN 早实测、drag-OUT 外部接收与 dragImage 待真机（dragImage 私有协议已登记残留表） | 2 d | Win |

批内序：**E1 → E2 → E3**（E1/E2 各半天先落；**E3 已落地**，阶段四百三十，契约对齐 + 会话状态机验证）。**批五全部完成**（drag-OUT 外部接收/dragImage 需真机目视，已登记残留表）。

### 批六 · 诊断

| 阶段 | 内容 | 文件级落点 | 特有验收 | 估算 | 平台 |
|---|---|---|---|---|---|
| **F1 Error.getStackTrace** ✅ **已落地（阶段四百三十一，v0.4.407）** | 运行时 TLS 影子栈（`as_astack_enter/leave`）在函数入口 push/返回 leave/catch 与帧边界恢复深度；Error **构造时**快照栈（`_stacktrace` 私有字段），`getStackTrace` 按 AIR 文本返回。**阶段四百三十四（v0.4.410）起编译期 opt-in**：仅当编译面引用 `getStackTrace` 才发射影子栈（`ASC_STACKTRACE` 宏门控 enter/leave），否则置空由 -O2 内联消除——根治 fib 逐调用回退（4.54×→1.03×），用到该 API 的程序全保 F1 语义 | `runtime.ts` 影子栈 + `emit.ts` 各函数发射点 + `symbols.ts` Error 字段 | AS3 authored 帧与 adl 同 throw 点逐帧一致（`temp/stackprobe`）；无栈返 null；ADL 加载器帧不同源、以 `global()` 脚本帧替代 | 2–3 d | 全平台 |

批内仅 F1。依赖「AS3 栈帧模型」，是本文**唯一需要新运行时表示**的项（风险见 §7）——**已落地**（阶段四百三十一）。**批六完成；至此计划全部 12 个里程碑（C1/A1/A2/A3/B1a/B1b/B2/D1/D2/E1/E2/E3/F1）全部落地**。

---

## 5. 跨批推荐执行序

子系统聚合是**结构**；落地时按「影响 × 成本」穿插，先拿快赢与高影响：

1. ~~**C1**（网卡 Windows，0.5–1 d，高影响快赢）~~ ✅ **已落地**（阶段四百二十，v0.4.396）
2. ~~**A1**（PNG encode，0.5 d，零重编快赢）~~ ✅ **已落地**（阶段四百二十一，v0.4.397）
3. ~~**E1 + E2**（openWith + systemIdleMode，各 0.5 d，桌面快赢，可同批回归）~~ ✅ **已落地**（阶段四百二十二，v0.4.398）
4. ~~**A2**（JPEG 快照，1–2 d，高影响，需重编 Skia）~~ ✅ **已落地**（阶段四百二十三，v0.4.399，实测无需重编 Skia）
5. **B1**（麦克风音量监听，高影响大项）——**B1a 设备面 ✅ 已落地**（阶段四百二十四，v0.4.400）；**B1b 采集+事件 ✅ 已落地**（阶段四百二十五，v0.4.401）
6. **B2**（相机枚举，1–2 d）——**✅ 已落地**（阶段四百二十六，v0.4.402，Camera 设备面真枚举；采集仍走 ANE）
7. **D1 → D2**（渲染遮罩/缓存矩阵，整批渲染回归）
8. **A3**（applyFilter 阴影/发光）
9. **E3**（拖放 Windows 验证）
10. **F1**（getStackTrace，需新栈帧模型，殿后）

> 该序是**建议**，非硬依赖；唯一硬依赖是 A2 依赖 Skia 重编链就绪、B1b 依赖 B1a 的设备面。

---

## 6. 验收与记账规范（每阶段收尾）

- **三件事**（AGENTS.md §2.7）：全量 `node test.ts` 回归无破坏 + 更新 README 中英 + 升小版本号。
- **钉子分层**：行为判据进 `examples/*.as`（自动注册）；负例/结构不变量进 `test/unit/`。
  媒体类无硬件时以「无设备 → `isSupported=false` 响亮报明」作可跑判据，真机采集另记实测。
- **stubs.md 联动**：每补一项，把 §2/§3 对应行移入「毕业」表，注明阶段号。
- **TODO.md 记账**：每阶段 note 写「新登记/改写/移出 N 行」并按表内实际行数重数；本文缺口落地即从遗留表移出。
- **平台口径**：Windows 优先项须在 Windows 真机验；macOS parity 项注明是否同阶段落或另立。

---

## 7. 风险与待定项

| 项 | 风险 | 缓解 |
|---|---|---|
| **A2 Skia 重编** | 开 `libjpeg_turbo_encode` 需重编 Skia，Windows vendored 库须守 **MSVC ABI**；重编影响所有图像路径 | 先 A1 验证 glue 接线；A2 重编后**整批图像示例回归**；或独立链 libjpeg-turbo 避开 Skia 重编 |
| **B1 采集线程** | 音频回调在 worker 线程，碰 AS3/GC 会崩 | 严格沿用 WebSocket/Socket 形态：锁下队列 + 帧边界 `as_mic_dispatch`；新增根/box tag 同步 GC 四处 |
| **B1/B2 硬件依赖** | 无麦克风/摄像头的机器无法真验采集 | 验收分两档：无设备报明（可自动跑）+ 真机/虚拟设备实测（手记） |
| **D1/D2 渲染面** | 动渲染器易波及文本/图像示例（阶段四百一十八设备字体一次 22 红教训） | 整批渲染/文本示例**双端复验**后再收口 |
| **F1 栈帧模型** | 需新运行时表示，影响 throw 路径与 GC | 独立立项殿后；先实测 AIR 栈文本格式定契约 |
| **32 位 Windows** | 真应用 `architecture=32`，部分 Win API 在 i686 的可用性 | 各 Win 阶段在 32 位产物上复验（TODO 遗留表已有「i686 目标不可构建」相关项，需先确认构建面） |
| **WebP encode** | 真应用未用 | 列待定，不进本轮 |

---

## 8. 证据索引

- 空替代清单：[`stubs.md`](stubs.md) §2（shell 类）、§3（成员级报明）、§4（毕业）。
- 生成 C 报明：真应用 `--air-app` 主构建（D3D12）`grep -a as_shell_unsupported` 与 `shell class` 招牌。
- 编译器侧锚点：见 §1 表（`emit.ts`/`runtime.ts`/`symbols.ts`/`skia_glue.cc`/`native-process.ts`）。
- 应用侧用法：按功能泛称（命名约定见文首）；详细 `file:line` 映射存于工作区 `temp/`（非产品面），不随本文落库。
- 判定原则：[`enhancements.md`](enhancements.md) §2（遗留 vs 增强）、AGENTS.md §1.5。