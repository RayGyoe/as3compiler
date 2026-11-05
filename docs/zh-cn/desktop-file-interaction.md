# 原生文件交互：实现与验收状态

按 [开发计划](desktop-file-interaction-plan.md) 推进。macOS 文件选择与读写闭环已实测；原生拖入/拖出及 Windows 后端代码已接入，验收状态分别记录：

| 能力 | macOS | Windows |
|---|---|---|
| File / FileReference / FileReferenceList 选择器 | Cocoa 真机选取、取消与读写闭环已验证 | Shell IFileDialog 已实现，未编译、未真机验证 |
| 文件列表、文字、URL 拖入 | AS3 状态机与 Cocoa 粘贴板/回调桥探针通过；Finder 实际投递待验收 | OLE IDropTarget 已实现，未编译、未真机验证 |
| doDrag、动作、源端事件 | 原生会话启动及取消终态已观察；Finder/编辑器实际接收待验收 | IDataObject/IDropSource 已实现，未编译、未真机验证 |
| 拖动图像 | Cocoa RGBA 图像与 offset 已实现，视觉位置待验收 | 目前使用系统光标；传入 dragImage 会明确报明未实现 |

用户当前没有 Windows 测试环境。Windows 的“已实现”仅指后端代码，默认窗口构建暂不接入、isSupported 仍为 false。现有 Windows 文件运行时使用 ANSI/CP_ACP，而新桥的 ABI 是 UTF-8；先统一路径编码、完成编译和真机验证，才能默认启用。显式定义内部 ASC_USE_FILE_DIALOG/ASC_USE_NATIVE_DRAG 宏仅供后续开发接线，不作为当前 Windows 支持承诺。macOS 窗口配置自动链接后端；无后端构建返回 false。没有窗口后端的程序不会伪造用户取消。

## 使用

```sh
node src/index.ts --air-app examples/desktop-files/app.xml --main-class Main \
  --package app -o temp/DesktopFiles
open temp/DesktopFiles.app
```

同一份 `examples/desktop-files/src/Main.as` 也可以由 AIR SDK 编译，入口展示打开、多选、目录、保存路径、FileReference 读取、保存文本与 FileReferenceList。

支持的调用：

| API | 本批行为 |
|---|---|
| `File.browseForOpen` | 更新接收 File 的路径，异步 SELECT |
| `File.browseForOpenMultiple` | 异步 SELECT_MULTIPLE，事件携带 File 数组；原 File 路径不变 |
| `File.browseForDirectory` | 目录选择与 SELECT |
| `File.browseForSave` | 选择保存路径与 SELECT，不写文件 |
| `FileReference.browse` | 返回是否已提交选择器；选择后更新名称、大小、日期等元数据 |
| `FileReferenceList.browse` | SELECT 后返回 FileReference 数组；未选择前 fileList 为 null |
| `FileReference.load` | 在既有异步 IO 队列读取，COMPLETE 前公布 ByteArray，读取失败发 IO_ERROR |
| `FileReference.save(data:*, name)` | 调用时快照数据；选择路径后异步写入，完成后刷新元数据；支持 ByteArray、UTF-8 字符串和通用字符串转换，XML/XMLList 使用 XML 序列化 |

打开过滤器支持 `*.txt;*.md`、多个过滤组、通配所有文件；macOS 的过滤组选择放在面板附件区。多选结果按 Cocoa 返回顺序保留，不重新排序。初始目录取 File 当前路径；FileReference 使用系统最近浏览目录。

## 已实测的 AIR 契约

本机 AIR SDK 51.4.1 的 describeType 和运行探针确认：

- NativeDragEvent 继承 MouseEvent，构造器 13 个参数，cancelable 默认 true，未给坐标为 NaN；clone 保留子类型及相关对象。
- NativeDragManager.doDrag 是五参数，dropAction 可读写，另有 dragInitiator/isDragging；NativeDragOptions 三个 allow 标志默认 true。运行时已接入原生拖放会话，尚需补齐系统交互验收。
- FileReference.save 的 data 参数是 `*`，不是 Object；生成器已同步，避免字符串/数值被错误当作对象地址。
- 未选择就 FileReference.load 抛 #2037；File.load 可以直接读取已有 nativePath。
- 无效过滤数组成员抛 ArgumentError #2097。
- FileReference.cancel 和 File.cancel 都不会关闭正在浏览的面板，也不发 CANCEL；面板仍存在时再次浏览抛 #2041。用户关闭/取消面板才发 CANCEL。
- File.load 的 OPEN/PROGRESS 监听器里 data 为 null，COMPLETE 中可读；本后端在进度派发后公布数据。AIR 的 OPEN/PROGRESS 次数可能多于本后端，本后端当前按完成时聚合进度派发，尚未对齐分块进度的数量与时序。

交互事件仍由 AS3 线程派发。原生面板完成回调只暂存 UTF-8 路径；请求、文件对象与保存快照在 GC 根遍历中保活。原生面板在调用业务监听器前释放，因此监听器可继续打开下一个面板。异常清理会解除当前请求，不会使后续浏览永久处于 busy。

cancel 对已提交的异步 IO 取消回调投递，不能撤销已经完成的磁盘写入；它不承诺回滚。用户取消保存面板不会提交写入。

## 拖放运行时与所有权

`src/native-drag.ts` 将原生同步回调接到实际显示树命中。业务在 enter/over 中调用 `acceptDragDrop`，且所选 dropAction 在源端允许集合中，才向系统回报接受。离开接受目标的子树、目标移除/隐藏、over/drop 被取消或监听器异常时撤销接受；MOVE 只协商结果，不替业务删除文件。

NativeDragEvent 经过捕获/冒泡时按 currentTarget 换算 localX/Y，stageX/Y 保留舞台坐标；外部拖入不产生源端 start/complete。Clipboard 元数据可在拖放事件内查看，外部数据只能在 drop 内读取；本地源数据可在同域拖放事件内读取。原生会话期间只读，会话结束后该拖放 Clipboard 过期，业务需要在事件内保存读出的数据。自定义序列化、file promise、跨安全域/HTMLLoader 不包含在实现范围。已有 generalClipboard 的能力不受拖放格式支持范围扩展。

会话中的源、目标、Clipboard、选项和快照均是 GC 根；Cocoa/COM 只持有复制的原生数据，不保存 GC 指针。业务异常在原生入口截获，拒绝当前投递并清理会话。`doDrag` 必须来自同一窗口的 mouseDown 或按下状态的 mouseMove；原生完成回调清理按下状态，防止系统吞掉 mouseUp 后按钮持续按下。

macOS 只为 SDL 视图实例增加拖放 selector 和保留原始鼠标手势的转发方法，不替换窗口代理；detach 恢复原来的视图类。Windows 用 OLE 目标替换 SDL 默认目标，窗口销毁前 RevokeDragDrop。Windows 对话框在专属 STA 中持有 IFileDialog，begin 返回前复制输入，完成后只发布原生结果，AS3 安全点再派发事件；owner 销毁、系统模态与 COM 退出仍待真机验证。

## 构建与验证

`withNativeDesktopBackends` 为 macOS native 的 `window_glue.cc` 配置自动附加 file_dialog/native_drag 源文件及系统库；Windows 默认保留原行为，内部开发显式接线时才附加对应源文件，普通命令行构建和 Xcode 导出共用。`effectiveDefines` 在所有构建/对象目录计算入口统一提供 ASC_USE_FILE_DIALOG / ASC_USE_NATIVE_DRAG，防止 ICU 汇编与编译步骤使用不同对象目录。doctor 的 `vendor.file-dialog` 检查后端与头文件是否存在。原生头文件 `vendor/file_dialog.h` 与 `vendor/native_drag.h` 规定结果、字符串所有权和回调阶段。

```sh
node --test test/unit/file-dialog.ts test/unit/native-drag.ts test/unit/file-stream.ts test/unit/doctor.ts
npm run test:unit
```

自动验证包括：SDK 对齐的拖放事件默认值与 clone、选择/取消/错误、单选/多选类型和路径、面板互斥、#2041/#2097、GC、保存快照、读写事件与内容、监听器重入及异常清理、无后端降级，以及 ICU/编译对象目录一致性。状态机测试使用受控原生边界，不依赖弹窗；同时已用真实 Cocoa 面板完成中文路径选择、27 字节文本读取和中文文本保存，保存文件内容已核对。

## 待验收与限制

- M4：Finder 多文件真实拖入、拒收区/离开/重入/Esc、不同 DPI、scrollRect、多个窗口及 CPU/Metal 窗口，仍待完整真机矩阵。Cocoa 探针使用真实窗口和粘贴板、合成 NSDraggingInfo，不能替代 Finder 端到端验收。
- M5：Windows 默认接入暂停，先迁移既有 ACP 文件运行时与新 UTF-8 ABI 的路径边界；全部列为未验证：本机无 Windows SDK/运行环境，尚未完成本地 Windows 编译；需要首轮编译后验证 Unicode、过滤器、默认目录、owner、取消、覆盖确认、COM/OLE 初始化/退出、SDL 注册替换、CPU/D3D/GL 与多窗口。独立 STA 的模态/owner 销毁行为是重点。
- M6：双端真实业务导入及完整交互矩阵尚未收口。
- M7：macOS 已观察到启动及取消为 none；应用→Finder/文字编辑器的文件/文字/URL 接收，以及 COPY/MOVE/LINK 和拖动图像位置仍待系统级验收。Windows 拖动图像暂未实现；其余拖出代码未验证。
- 延迟 Clipboard handler 当前在发起 OS 拖出前渲染为快照，尚非目标首次读取时才调用；自定义格式仅随本地 Clipboard 保留，不能跨应用运输。
- IO 当前按完成聚合进度；过滤表达式、扩展名自动补全、错误分类与所有 AIR 文案仍有对齐项。ByteArray 沿用有符号 int 长度上限。
- Linux、Web、HTTP 上传下载、移动文件权限和文件承诺继续不在本批范围。

本轮验证：完整单元 **329/329**、完整示例 **306/306**；文件选择器/拖放/Clipboard 定向 **6/6**（Clipboard 内部 68 检查）；Cocoa 桥接探针通过，覆盖中文多文件、text/URL、同步动作返回、重复 attach 及 detach 恢复。另已补测 MOVE/LINK 协商、无效源载荷，以及 start/complete 监听器异常清理。原生 .app 编译、ad-hoc 签名通过。Cocoa 探针的可复现源码和运行命令见 `test/native/README.md`。上一批真实面板已完成中文路径选择、27 字节文本读取与中文文本保存；该结果只代表当时场景。
