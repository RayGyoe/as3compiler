# 文件对话框与原生拖放开发计划

编制日期：2026-11-05。代码审计基线：本地 `package.json` 为 0.4.339；工作树存在其他进行中的改动。本计划是实施设计，不表示功能已实现，也不占用发布阶段号。

实施进度：M0 接口校准、M1 接缝和 macOS M2/M3 基础读写已落地；拖放和 Windows 尚未实施，事件/过滤等剩余边界见 [第一批实现与限制](desktop-file-interaction.md)。

## 1. 建议与目标

按“API 契约校准 → 文件对话框 → 文件读取/保存闭环 → 外部拖入 → Windows 对齐 → 拖出”的顺序实施。

第一批交付面向 **macOS 与 Windows 原生桌面**：用户可以通过标准 AIR API 选择单个/多个文件、选择目录、选择保存位置，也可以把 Finder/资源管理器中的文件拖到应用内指定组件。AS3 源码应能在 AIR 与 AOT 两端直接运行，不要求业务方接入自定义 ANE。

第二批补 `doDrag()`：把应用内的文件、文字和 URL 拖到系统或其他应用。浏览器、Linux、虚拟文件承诺和 HTTP 上传下载分别立项，避免把不同宿主的限制混进桌面基线。

优先级依据：文件对话框能直接解锁打开、导入、导出；外部拖入解锁上传面板等已有调用场景；拖出需要新增数据提供者与动作协商，放在接收端稳定之后。

## 2. 已有基础与真实缺口

| 能力 | 代码现状 | 本次需要补的部分 |
|---|---|---|
| `File`、`FileReference`、`FileReferenceList`、`FileFilter` | 已有真实类、继承链、字段和大部分文件操作；`FileReference` 未选择状态已有 AIR 实测 | 原生选择器、选择结果落盘到对象状态、异步事件与取消 |
| `File.browseFor*` | `src/symbols.ts` 有声明；`src/emit.ts` 仍调用 `as_shell_unsupported` | 打开、保存、目录、多选四种模式 |
| `FileReference.browse/load/save`、列表 `browse` | 交互成员仍为报明桩 | 浏览后的元数据、读取到 ByteArray、用户确认后保存 |
| `Clipboard` | 已有真实实现与 OS 数据通道、格式和传输模式测试 | 拖放专用 Clipboard、文件列表、按会话管理有效期 |
| `NativeDragEvent` | 当前 shell 直接继承 Event，字段和构造参数并非完整 AIR 契约 | 改为 MouseEvent 子类，校准事件属性、常量、构造器和 clone |
| `NativeDragManager` | 仍为 shell；allowedActions 用 Object；`doDrag` 多出 transferMode 参数；dropAction 只读 | 校准 API，建立会话、接受目标、动作协商和平台后端 |
| 应用内部拖动 | `Sprite.startDrag/stopDrag` 已有实现 | 与跨窗口、跨应用的 OS 拖放分别管理，保持已有行为 |
| 窗口与命中 | SDL2 窗口泵、窗口 ID、原生句柄、坐标换算、显示树命中均已有 | 为所有实际窗口注册原生拖放，并把系统反馈接回显示树 |

代码依据：`src/symbols.ts` 的文件类、NativeDragEvent/NativeDragManager/Clipboard 声明；`src/emit.ts` 的对应运行时；`vendor/window_glue.cc` 的 SDL 事件泵与原生窗口句柄；现有 `docs/zh-cn/filesystem.md`、`stubs.md` 和 `test/unit/clipboard.ts`。

特别注意两个已确认的契约差异：

- AIR `NativeDragEvent` 继承 MouseEvent；`allowedActions` 是 NativeDragOptions，构造参数包含 Clipboard、allowedActions、dropAction 和修饰键等。当前声明必须先校准。[AIR NativeDragEvent 参考](https://airsdk.dev/reference/actionscript/3.0/flash/events/NativeDragEvent.html)
- AIR `doDrag` 是五参数，`dropAction` 可读写，另有 `dragInitiator/isDragging` 状态。参考页部分说明文字存在旧称或笔误，签名最终通过本机 SDK `describeType` 与运行探针确认。[AIR NativeDragManager 参考](https://airsdk.dev/reference/actionscript/3.0/flash/desktop/NativeDragManager.html)

## 3. 第一批范围与接口

### 3.1 文件对话框

实现：

- `File.browseForOpen(title, typeFilter)`。
- `File.browseForOpenMultiple(title, typeFilter)`。
- `File.browseForDirectory(title)`。
- `File.browseForSave(title)`。
- `FileReference.browse(typeFilter)`、`FileReferenceList.browse(typeFilter)`。
- `FileReference.load()` 与 `save(data, defaultFileName)`；保存输入类型以 SDK 契约和 AIR 探针为准。
- 与上述操作有关的 `cancel()`、选择/取消/完成/错误事件、元数据刷新和重复调用约束。

关键区别：`File.browseForSave` 只选择路径，不负责写文件；`FileReference.save` 才完成选择与写入。多选使用 FileListEvent.SELECT_MULTIPLE，不能用普通 SELECT 代替；接收对象不会被改成列表中的某一个文件。[AIR File 参考](https://airsdk.dev/reference/actionscript/3.0/flash/filesystem/File.html)

首批提供 UTF-8 AS3 字符串与原生 Unicode 路径的往返；支持中文、空格、长文件名、多个过滤组、默认目录/文件名。过滤规则转换、无扩展名、扩展名自动补全和覆盖确认均用探针确定，不自行制定一套规则。

### 3.2 从系统拖入

首批格式为文件列表，其次是文字和 URL；不把文件内容提前整体载入内存。

目标端包括 enter、over、exit、drop，业务必须显式 `acceptDragDrop(target)` 才可投递；系统光标反馈与业务实际接受状态一致。目标使用现有显示树命中和坐标转换，覆盖嵌套、缩放、滚动裁剪、mouseEnabled/mouseChildren 与多个 NativeWindow。

外部拖入没有应用内 initiator，不能凭空补造源端 start/complete。拖放 Clipboard 的可访问时机和会话结束后的行为需按 AIR 对照实现；不要把它当成永久有效的 generalClipboard。[AIR 拖入流程](https://airsdk.dev/docs/development/user-interaction/drag-and-drop-in-air/supporting-the-drag-in-gesture)

首批承诺可正确协商 COPY；MOVE/LINK 若尚未实现对应平台协商，必须拒绝或明确列为不支持，不能回报成功。`isSupported` 的设置时机、部分能力是否允许报 true，须在 M0 固定口径，禁止只改这个布尔值就宣称完成。

## 4. 架构与实现边界

### 4.1 保持现有编译器分层

```text
AS3 File / FileReference / NativeDragManager
                    ↓
symbols.ts：真实 AIR API 契约
                    ↓
emit.ts：状态机、GC 根、事件、Clipboard、显示树命中
                    ↓
平台无关 C ABI：窗口 ID / 请求 ID / UTF-8 数据 / 明确所有权
                    ↓
macOS Cocoa / Windows Shell + OLE
```

- `src/symbols.ts` 只承载类型与签名，不混入平台选择。
- `src/emit.ts` 生成平台无关运行时；以现有窗口泵、安全点和事件分发为基础。
- `vendor/window_glue.cc` 只负责窗口接入和事件桥；复杂后端建议独立文件，例如 `vendor/file_dialog_macos.mm`、`file_dialog_win.cc`、`native_drag_macos.mm`、`native_drag_win.cc`，最终命名在实施时确定。
- 声明、no-window/WASI/Web 桩与构建输入同步维护。宿主缺少交互能力时明确报不支持；不能把“后端不存在”伪装为用户 CANCEL。
- `src/build.ts`、`air-app.ts` 负责自动检测并链接所需宿主文件和系统库；沿用现有单一检查表，把依赖缺失加入 doctor。

### 4.2 文件选择请求与资源所有权

内部请求至少包含请求 ID、窗口 ID、操作类型、发起对象、初始路径、过滤组和状态。区分“提交成功”“用户取消”“宿主错误”。结果用带长度的路径数组传输，不用分号/换行拼接文件名。

发起对象及异步数据必须有明确 GC 根；完成、取消、异常和窗口销毁都从同一条清理路径释放。请求 ID 加代次，丢弃迟到回调。路径结果由桥接层复制后再释放平台内存；原生工作线程不得创建/操作 AS3 GC 对象。

优先异步发起对话框并从运行时安全点派发终态事件。Windows Shell 对话框可能运行嵌套消息循环，必须测量是否会引发 AS3 重入；第一批不为规避这一问题引入未经验证的任意工作线程。单对象与跨对象并发限制以 AIR 实测确定。

### 4.3 原生拖放需要双向桥接

OS 的 enter/over 回调需要立即得到是否接受及允许动作。此路径不能简单地排队到“下一帧”再响应。由运行时建立受控的拖放事件入口，同步完成命中、AS3 监听器执行及动作反馈；必须保护 GC、异常边界和重入。若运行时暂不允许这一入口，M1 必须先解决，不能直接跳到平台注册。

拖放会话持有 initiator/acceptedTarget/Clipboard/allowedActions 等引用，以会话代次防止跨窗口和已结束会话串线。目标被移除、窗口关闭、异常或取消时立即撤销接受状态。MOVE 是协商结果，运行时不会自行删除用户文件。

## 5. 平台路线

| 平台 | 文件对话框 | 拖放 | 验收口径 |
|---|---|---|---|
| macOS | NSOpenPanel / NSSavePanel，正确绑定 NSWindow，优先 sheet 异步完成 | NSDraggingDestination / NSDraggingSource 与 NSPasteboard | Apple Silicon 真机；CPU/Metal 窗口与多窗口 |
| Windows | IFileOpenDialog / IFileSaveDialog；目录模式、Unicode 和 owner HWND | OLE IDropTarget；后续 IDataObject / IDropSource | Windows 真机；CPU、D3D 与 GL 窗口分别抽查 |
| Web | 后续独立做浏览器选择器/拖入和文件内容桥 | DOM DragEvent/DataTransfer | 浏览器不能承诺桌面绝对路径与等价 File.nativePath |
| Linux | 后续评估 portal，再决定桌面集成范围 | 随 X11/Wayland 目标另行设计 | 本次不以未验证代码标记支持 |

macOS 后端接入前检查 SDL 已有 NSView/窗口代理的职责，避免覆盖窗口关闭、输入法和 resize 处理。Windows 先验证 OLE/COM 初始化及 SDL 已有拖放注册，避免重复 RegisterDragDrop 或破坏原有窗口过程。

SDL2 的 DropEvent 提供 begin/file/text/complete、路径与窗口 ID，未提供 AIR 所需的完整 hover、目标接受及动作协商信息。可以用它作路径运输探针，不能把 drop 后补发 enter 当作 AIR 拖放支持。[SDL2 DropEvent 结构](https://wiki.libsdl.org/SDL2/SDL_DropEvent)

## 6. 里程碑与工作量

估算为一位熟悉本项目的开发者的人日，包含探针、实现与本阶段测试；假设能获得 macOS 和 Windows 真机环境。等待硬件、系统权限、CI 修复和大规模应用适配不计入。M0 后按实测重新估算。

| 阶段 | 交付 | 验收门 | 估算 |
|---|---|---|---|
| M0：契约审计 | SDK 反射快照、AIR 交互探针、完整 API/事件差异表；明确并发与取消语义 | 对象变化、返回值、事件次序和错误分类有可复现记录 | 1–2 日 |
| M1：公共接缝 | 请求/会话状态机、GC 根与清理、原生双向回调、无窗口降级、构建检测 | 注入结果验证成功/取消/错误、迟到回调、异常和窗口销毁 | 2–3 日 |
| M2：macOS 对话框 | File 四种模式及 FileReference/List 浏览 | 系统对话框选取、取消、多选、过滤、中文路径、正确窗口归属 | 2–3 日 |
| M3：读写闭环 | FileReference.load/save、字节/文本输入、取消、元数据和完成事件 | 已选文件真实读取；保存字节逐字节相同；取消不写文件 | 2–3 日 |
| M4：macOS 拖入 | 文件列表、文字/URL、目标切换、COPY 与光标反馈 | Finder→应用、拒收区域、离开/重入、Esc、多文件与多窗口 | 3–5 日 |
| M5：Windows 对齐 | 对话框、读写闭环、OLE 拖入 | 资源管理器真实投递；Unicode、owner、取消与 COM 清理；同样 AS3 探针 | 5–7 日 |
| M6：首批收口 | 双端应用验收、回归、文档与支持矩阵 | 同一业务通过选择器及拖入导入，错误路径不假成功 | 2–3 日 |
| M7：原生拖出 | doDrag、NativeDragOptions/Actions、文件/文字/URL、动作与结束事件 | 应用→Finder/资源管理器/文字编辑器；取消和源/目标消失 | 5–8 日 |

建议两个交付点：

- **macOS 文件选择与读写闭环：约 7–11 人日**，M0–M3；优先让业务从手填路径切换到原生交互。
- **首批双桌面版本：约 17–26 人日**，M0–M6；包含系统拖入，约 4–6 周的单人工作量。
- 原生拖出追加约 5–8 人日。Web、Linux、HTTP 与 file promise 不并入上述估算。

## 7. 验证计划

### 自动化：验证运行结果与状态

拟新增 `test/unit/file-dialog.ts`、`native-drag.ts`；扩展已有文件和 Clipboard 测试。原生边界提供可注入的结果源，测试不依赖每次都弹 UI。

必须覆盖：

1. 未选择状态、单选、多选、目录、保存路径的对象内容；Boolean/void 返回类型与 AIR 一致。
2. SELECT/CANCEL/SELECT_MULTIPLE/COMPLETE/IO_ERROR 的真实接收对象、顺序与派发次数。
3. 同一对象复用、重复发起、取消后重试、原生错误与迟到回调；取消不留下半初始化对象或部分文件。
4. 发起者离开作用域后触发 GC，完成前仍存活；会话清理后可回收。工作线程不触碰 GC 对象。
5. 拖放使用实际命中路径；未接受不 drop；跨组件时 exit/enter 及坐标正确；target 失效会撤销接受。
6. Clipboard 文件列表返回 File 对象数组；数据访问生命周期与 transferMode 按 AIR；不污染系统 generalClipboard。
7. AS3 监听器抛异常或修改显示树，不能让异常穿过 Cocoa/COM ABI，也不能把已失效目标报为可接收。
8. 文件名包含中文、空格、`#`、`%` 与非 BMP 字符；URI 与 nativePath 不混用；大量路径不会被分隔符拆错。
9. 无后端的构建有明确降级；真实错误不被当 CANCEL；原生动态库与 AS3/C ABI 构建检查通过。

### 真机：覆盖 OS 行为

自动化通过后，必须使用真实系统对话框与真实外部拖放源。在 macOS/Windows 各保留一份事件日志和验收记录，运行证据先落本仓库 `temp/`，需要被文档长期引用的再归档。

| 场景 | 必须观察的结果 |
|---|---|
| 单选、多选、选目录、选保存位置 | 正确对象/路径、正确事件、窗口归属、Esc/关闭/覆盖确认 |
| 对话框打开期间移动/关闭主窗口 | 按确定的 owner 和取消规则工作，无悬挂回调 |
| Finder/资源管理器拖入多个真实文件 | 文件列表数量及路径一致，只有业务接受的组件收到 drop |
| 从接收区移到拒收区再松手 | 高亮撤销、系统光标与最终结果一致 |
| 双屏不同 DPI、缩放容器、scrollRect、多窗口 | local/stage 坐标与显示位置吻合，不投到错误窗口 |
| 应用拖出（M7） | start/update/complete 和实际协商动作一致；取消为失败终态 |

首批增加一个桌面文件交互示例：四种对话框入口、文件信息列表、拖入高亮、文本/二进制读取与另存为、事件日志；M7 再加拖出。最后选择真实业务的导入/上传入口验收，不能只在特制探针上通过。

## 8. 完成定义与风险处理

每个里程碑完成前，执行相关单元与示例；契约/运行时/事件变动进入完整单元回归，发版前执行项目规定的完整回归及构建检查。Windows 分支未真机测试就保留未验证标记。

最大的风险是原生回调与 AS3/GC 的重入、SDL 宿主集成、跨窗口对象生命周期，以及两端对话框行为差异。因此 M0/M1 是必经阶段，不先把 UI 做出来再补事件和取消。

交付时同步更新 `filesystem.md`、`desktop.md`、`stubs.md`、支持矩阵和 TODO；实现过程中不要让既有“报明桩”测试继续把真实支持判成回归，也不要单纯删掉测试。版本/阶段号在实际实施与发布时分配。

首批保留的限制必须列明：HTTP 上传/下载、虚拟文件承诺、系统字体/权限引起的特殊面板差异、浏览器虚拟文件路径、Linux 和移动端。对话框成功不等于上传成功，拖入收到路径也不等于业务已经完成导入。

## 当前实施状态（2026-11-06）

M0–M3 的 macOS 文件选择与读写闭环已实现并完成首轮真实面板验证；M4/M7 的运行时、Cocoa 后端和 M5 的 Windows Shell/OLE 后端已接入。M5 的 Windows 部分在 2026-11-06 完成路径编码层迁移后**默认启用并首轮真机验收**（原生面板弹出/取消/选中、OLE 拖入 ENTER/OVER/DROP、CJK 路径与文件名）；M4 Finder 投递、M7 外部接收、owner/模态/多窗口/DPI 矩阵仍未验收，M4/M6/M7 不标完成。详见 [实现与验收状态](desktop-file-interaction.md)。
