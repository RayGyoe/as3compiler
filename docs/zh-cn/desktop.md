# 桌面集成（`flash.desktop` 图标族 + `flash.display.NativeMenu`）实测口径

> 本文记录 **`Icon` / `InteractiveIcon` / `DockIcon` / `SystemTrayIcon`**、
> **`NativeApplication.icon` / `menu` / `autoExit` / 五个能力位**，以及 **`flash.display.NativeMenu` /
> `NativeMenuItem`** 的**实测语义**与实现选择（阶段二百五十五，v0.4.218 → v0.4.219）。
>
> 它们是 macOS 清理工具 demo 的 **G4a**（方案见工作区根
> [`prune/mac-cleaner-demo-plan.md`](../../../prune/mac-cleaner-demo-plan.md)）。该方案已于 2026-10-23
> 移出本仓库，故上方相对链**仅在本地工作区可解析**；单独 clone `as3compiler` 时该链会断开（属预期）。
>
> **真值来源**：`adl 51.4.1`（macOS 26）探针 `temp/deskprobe2/`（`Probe*.as` 由 `mxmlc` 编、`adl` 跑，
> 日志写文件——`adl` 的 stdout 不出现）。其中 `probe7.txt` / `probe8.txt` 是本轮专门为「子菜单归属」
> 与「主菜单形态」写的。**本文每一条「AIR 怎样」都有对应探针输出**，没有一条是从文档转述的。
>
> **2026-10-23 追加（阶段二百五十六，v0.4.219 → v0.4.220）**：`DockIcon.bitmaps` 现在真的**上屏**了。
> 本轮先把「AIR 用哪张」实测出来（`temp/dockprobe/`：纯色位图 → 截屏取色），再把像素交给
> `-[NSApplication setApplicationIconImage:]`；因此 §3 多出一张**选图规则**表，§7.2 只剩修饰键一项，
> 另加 §7.6 记录一处**刻意不跟**的渲染差异（AIR 的半透明像素被乘了两次 alpha）。
>
> 一句话结论：**AIR 在 `flash.desktop` 里有完整的一等公民图标 API（不是「无对应物」）；
> macOS 上 `supportsDockIcon` 为 `true`、`supportsSystemTrayIcon` 为 `false`；
> `NativeApplication.menu` 不是 `null` 且可整条替换**。

---

## 1. 覆盖范围

| 成员 | 状态 | 说明 |
|---|---|---|
| `Icon` | ✅ 实现 | **可实例化**（`new Icon()` 合法），`bitmaps` 默认 `null`（读它抛 `#1009`） |
| `InteractiveIcon` | ✅ 实现（模型层） | `new InteractiveIcon()` 抛 `#2012`；`width`/`height` 是派生只读 |
| `DockIcon` | ✅ 实现（含 Dock 右键菜单 + 位图上屏） | `new DockIcon()` 抛 `#2012`；选图规则与透明度见 §3.1、§7.6 |
| `SystemTrayIcon` | ✅ 实现（模型层；**`--features tray` 时接真 `NSStatusItem`**） | macOS 上 AIR 自己不提供（`#2012`），**默认**我们同样不提供；打开增强开关后同一段 AS3 拿到真状态项（见 [`enhancements.md`](enhancements.md) §4.11） |
| `NativeApplication.icon` | ✅ | **只读**（`mxmlc` 报「属性 icon 为只读」）；进程内单例 |
| `NativeApplication.menu` | ✅ | 可读可写；`= null` 在 `adl` 上**崩溃**，我们**报明并保持原状**（§7.1） |
| `NativeApplication.autoExit` | ✅ | 行为是真的：`false` + 无可见窗口时进程仍驻留 |
| `supportsDockIcon` / `supportsMenu` | ✅ | 只在 `ASC_USE_WINDOW && __APPLE__` 报 `true`（§2） |
| `supportsSystemTrayIcon` / `supportsStartAtLogin` / `supportsDefaultApplication` | ✅ 恒 `false`（`supportsSystemTrayIcon` 在 `--features tray` 下为 `true`） | 默认与本后端实际能力一致（§2）；托盘开关见 [`compile.md`](compile.md) §3.4.5 |
| `NativeMenu` / `NativeMenuItem` | ✅ 全成员 | 列表语义、错误号、拷贝语义逐项对 `adl`（§4、§5） |
| `NativeMenu.display()` / `ContextMenu.display()` | ✅ 实现（macOS / Windows 真模态；web 异步） | Cocoa 走嵌套 tracking loop、Win32 走 `TrackPopupMenu`，都阻塞到选中/取消；三端差异与 Windows 实测见 §7.7、§7.8 |
| `ContextMenu` / `ContextMenuItem` | ✅ 实现（右键弹窗） | 对象模型逐条对 `adl`，含三条**与基类相反**的独有规则（§8） |
| `keyEquivalentModifiers` | ✅ 已映射 | `15..20` 逐值实测后译成 `NSEventModifierFlags`（§7.2） |

---

## 2. 能力位（`NativeApplication` 五个静态属性）

| 属性 | `adl 51.4.1` / macOS | 我方 | 说明 |
|---|---|---|---|
| `supportsDockIcon` | **`true`** | `ASC_HAS_DOCK` | 仅在 `ASC_USE_WINDOW && __APPLE__` 为 `1` |
| `supportsMenu` | **`true`** | `ASC_HAS_APP_MENU` | 同上 |
| `supportsSystemTrayIcon` | **`false`** | `0` | macOS 无托盘；AIR 自己也不报 |
| `supportsStartAtLogin` | **`true`** | **`0`** | **刻意分歧**：本后端没有登录项服务 |
| `supportsDefaultApplication` | **`true`** | **`0`** | **刻意分歧**：本后端没有默认应用注册 |

**为什么后两项要「比 AIR 报得少」**：这两条不是「AIR 支持的语法」，而是「本后端真的具备的能力」。
照 `adl` 报 `true` 会让 `if (NativeApplication.supportsStartAtLogin) { … }` 走进一段**什么都不做**的
分支——那正是 AGENTS §1.5 禁止的静默降级。报 `false` 时同一段守卫会**真的跳过**，调用方由此得知
「这条路本构建走不通」。`startAtLogin` 的 **getter** 仍按 `adl` 抛 `#2014`
（`IllegalOperationError`），不因能力位为 `false` 而改口径。

> 无窗口后端（纯 C / wasm）时 `ASC_HAS_DOCK`/`ASC_HAS_APP_MENU` 同为 `0`，而 `NativeApplication.icon`
> 仍返回一个完整的 `DockIcon` 模型对象——**模型可用、上屏与否由能力位回答**，两件事不混。

---

## 3. 图标族

| 场景 | `adl 51.4.1` 实测 | 我方 |
|---|---|---|
| `new Icon()` | 合法 | 同 |
| `new InteractiveIcon()` / `new DockIcon()` / `new SystemTrayIcon()` | 抛 `Error #2012: X$ class cannot be instantiated.` | 同号同文案 |
| `new Icon().bitmaps` | 抛 `#1009`（默认 `null`） | 同 |
| `icon === NativeApplication.nativeApplication.icon` | 同一实例 | 同（进程内单例） |
| `dockIcon.bitmaps = [bd1, bd2]` | `width`/`height` 取**逐轴最大值** | 同 |
| `bitmaps = []` | 宽高**保持上一次的值** | 同 |
| `bitmaps = [1]` | 抛 `#2005: Parameter 0 is of the incorrect type. Should be type BitmapData.` | 同 |
| `bitmaps = null` | 抛 `#2007: Parameter bitmaps must be non-null.` | 同 |
| `bitmaps` getter | **每次返回新 `Array`**（改它不影响图标） | 同 |
| `bounce(null)` | 抛 `#2007: Parameter value must be non-null.` | 同 |
| `bounce("bogus")` | **不抛**（未知优先级按信息级处理） | 同（`NSCriticalRequest` / `NSInformationalRequest`） |
| `dockIcon.menu = "string"` | 读回 `null`（类型不符即视为无菜单） | 同 |
| `SystemTrayIcon.MAX_TIP_LENGTH` | `63` | 同 |

### 3.1 `bitmaps` 里哪一张真的上屏（实测选图规则）

AIR 不做「交给 AppKit 自己挑」：它**先按一个固定目标尺寸选出一张**，再把那一张交给系统。
证据是「给两张、看 Dock 变成哪个颜色」的对照实验（`temp/dockprobe/`，纯色位图 + `screencapture` 取色），
每轮只换尺寸组合：

| 喂进 `bitmaps` 的尺寸（颜色） | Dock 上真的出现的 |
|---|---|
| `{32(红), 96(绿), 256(蓝)}` | **96（绿）** |
| `{64(红), 160(绿)}` | **160（绿）** |
| `{16(红), 512(绿)}` | **16（红）** ← 16 赢了 512 |
| `{100(红), 150(绿)}` | **150（绿）** |
| `{127(红), 129(绿)}` | **127（红）** |
| `{129(红), 127(绿)}` | **129（红）** ← 顺序反了就换人赢 |
| `{128(红), 130(绿)}` | **128（红）** |
| `{128×400(红), 200×200(绿)}` | **200×200（绿）** ← 宽 128 的输了 |

这八轮把规则钉死成一句话：**取 `|max(width, height) − 128|` 最小的那张，并列时取数组里更早的那张**。
- 「16 赢 512」否定了「越大越好」；「160 赢 64」否定了「不超过 128 的最大者」；
- 两张只差 2 像素、顺序一反过来赢家就换（127/129）⇒ **并列取更早**，目标值正好是 **128**；
- 宽 128×高 400 输给 200×200 ⇒ 度量是**逐轴最大值**，不是宽。

其余与上屏有关的实测口径：

| 场景 | `adl 51.4.1` 实测 | 我方 |
|---|---|---|
| 重新赋值 `bitmaps` | **立刻重绘**（不用等重启/换焦点） | 同（setter 内同步画） |
| `bitmaps = []` | 恢复**默认应用图标**（不是留着上一张） | 同（`setApplicationIconImage:nil`） |
| 半透明位图 | alpha 生效（透明处透出 Dock 背景） | 同（预乘后交给 AppKit，§7.6） |
| 非正方形位图 | 按原比例放在方形图槽里（不拉伸） | 同 |

---

## 4. `NativeMenuItem`

默认值（`new NativeMenuItem("Hello")`，逐项 `adl` 实测）：

```
label="Hello"  name=null  enabled=true  checked=false  isSeparator=false
keyEquivalent=null  keyEquivalentModifiers=[15]  mnemonicIndex=-1  data=null
```

- **`toString()` 的形状被逐字复刻**：
  `[NativeMenuItem label="Hello" keyEquivalent=null keyEquivalentChar=0 keyEquivalentModifiers={ 15 }]`
- **`keyEquivalentModifiers` 的 setter 只留 `15..20`**，升序去重（`[18,16,16,3,99]` → `[16,18]`），
  getter **每次返回新 `Array`**；非 `Array` 抛 `#1034`。
- `keyEquivalent = ""` 读回 **`null`**（空串被归一成 `null`）。
- `clone()` **不复制 `data`**（`adl` 实测：克隆件的 `data` 是 `null`）；`_submenu` 深拷贝。
- 分隔符**没有** `NativeMenuItemSeparator` 类——`adl` 里那东西根本不存在（`mxmlc` 报「找不到定义」，
  它是 Flex 的 `mx` 类）；正确写法是 ctor 第二参：`new NativeMenuItem("", true)`。

---

## 5. `NativeMenu`

**`isSupported` 是静态成员**（`NativeMenu.isSupported` → `true`）；**实例读取抛 `#1069`**。

| 场景 | `adl 51.4.1` 实测 | 我方 |
|---|---|---|
| `addItem(已存在)` | **静默 no-op** | 同 |
| `addItemAt(已存在)` | 抛 `#2004` | 同 |
| `addItem(null)` / `getItemByName(null)` | `#2007`（`Parameter item` / `Parameter name`） | 同 |
| `removeItem(外面来的 item)` | `#2006: The supplied index is out of bounds.` | 同 |
| `addItemAt(99)` / `addItemAt(-1)` / `getItemAt(-1)` / `getItemAt(99)` | `#2006` | 同 |
| `addItemAt(numItems)` | 追加（不越界） | 同 |
| `getItemByName` | 只认 **`name`**，不认 `label` | 同 |
| `items` getter | **每次新 `Array`** | 同 |
| `items = null` | 抛 `#1009`；`items = [1]` 抛 `#1034` | 同 |
| `setItemIndex(外部 item)` | 静默 no-op | 同 |
| `addSubmenu(sub, label)` | `sub.parent` 变成该菜单 | 同 |
| `addItem(item)` 且 `item.submenu` 已有值 | **`submenu.parent` 变成该菜单**（`probe7.txt`） | 同（本轮补） |
| `removeItem(item)` | `item.menu` 与 `item.submenu.parent` 都变 `null`（`probe7.txt`） | 同（本轮补） |
| 同一个 item 加进第二个菜单 | 抛 `#2004` | 同 |
| `clone()` | 深拷贝 item，`data` 不复制，克隆件的 `submenu.parent` 为 `null` | 同 |

**点击回派（`probe4-log.txt`）**：原生点击让 **`NativeMenuItem` 与它所处的 `NativeMenu` 各收一次
`Event.SELECT`**，`bubbles=false`、`cancelable=false`，`data` 原样保留。

---

## 6. 原生接线（macOS / Cocoa）

菜单穿过胶水边界时**只以扁平描述出现**（`sk_menu` / `sk_menu_item`），胶水永远不认生成的 C 类型：

```
生成的 C（模型）             胶水（window_glue.cc）
NativeMenu/NativeMenuItem  →  sk_menu[] + sk_menu_item[]（dfs 展平，子菜单是下标）
点击 tag（1 基）            ←  SKMenuTarget.skFired: → as_menu_click_cb
```

四条硬性约束，全部由实测换来：

1. **不能从生成代码里调 `+[NSApplication sharedApplication]`** —— 在 SDL 视频初始化之前调它会让进程
   活着但**一个窗口都不建**。生成侧只读 `extern id NSApp`，拿不到就把安装**排队**，由
   `sk_run_loop` 的第一次 `sk_menu_flush()` 落地。
2. **AppKit/SDL 会在 launch 后装自己的主菜单**（在第一次事件泵里，晚于 `sk_menu_flush`），故事件循环
   每帧 `sk_menu_ensure()`：主菜单指针不等于我们装的那份就重新 `setMainMenu:`，Dock 菜单的
   `applicationDockMenu:` 被换过就重新 swizzle 上去。**都是指针比较，不重建**。
3. **`autoExit` 是共享循环条件的一部分**：`while (sk_any_open() || !g_auto_exit)`，没有可见窗口时
   按 ~60 Hz 空转（`SDL_Delay(16)`）。这既是 AIR 的 `autoExit=false` 语义，也是「只有
   Dock 图标 / 菜单栏」形态能活下来的前提。
4. **菜单树里一个菜单的直属项在扁平数组里必须连续**（`first..first+count`）。第一版在父循环里递归，
   子菜单的项被插进父的区间中间，**第二个顶级菜单直接从菜单栏消失**——这是本轮唯一一次靠肉眼
   （AX 查菜单栏）发现、再看代码确认的结构性 bug。

---

## 7. 平台边界与残余（如实报明）

### 7.1 `NativeApplication.menu = null` 在 `adl` 上**崩溃**，我们不做同样的事

`adl 51.4.1` 实测：赋 `null` 会让 adl 进程直接死掉。我方按 §1.5「不静默改写 AIR 已定义行为」处理为
**报明 + 保持原状**（`as_shell_unsupported("flash.desktop.NativeApplication.menu = null …")`）。

### 7.2 `keyEquivalentModifiers` → `NSEventModifierFlags` 的实测映射

六个合法值（`15..20`）的含义**是量出来的，不是查出来的**——这个 SDK 里根本没有
`flash.ui.KeyboardModifier` 类（`airglobal.swc` 与 `mxmlc` 都证实），所以只能靠行为反推：
`temp/keyeqprobe/`（`adl 51.4.1`）装一条真菜单栏，六个 item 各占一个值，再用 System Events 合成按键
看哪个 item 被 `select`，并用 `screencapture` 取打开的下拉菜单看**字形列**。

| 值 | 含义 | 触发它要按 | 下拉菜单显示 |
|---|---|---|---|
| 15 | Command | ⌘S | `⌘S` |
| 16 | Shift | ⇧S | `⇧S` |
| 17 | Control | ⌃S | `⌃S` |
| 18 | Alternate | ⌥S | `⌥S` |
| 19 | 无修饰 | `s` | `S` |
| 20 | **惰性** | **没有任何组合能触发** | `S` |

三条补充实测：**空数组 `[]` 等价于 `[19]`**（光按 `s` 就触发）；**`[15,20]` 等价于 `[15]`**
（⌘S 触发，20 不参与）；**`[19,20]` 回读成 `[20]`** 且与 `[20]` 一样不触发。

实现：生成侧折成 `AS_KEM_CMD/SHIFT/CTRL/OPT/DEAD` 五个便携位，胶水层的 `sk_menu_apply_mods`
（`vendor/window_glue.cc` 与 `vendor/statusitem_glue.cc` 各一份）译成 `setKeyEquivalentModifierMask:`。
`20` 单独出现时给 **`NSEventModifierFlagFunction`**：AppKit 不为它画字形、四个标准修饰键也凑不出它，
于是「显示 `S` 但永不触发」两个可观测结果同时成立（AIR 内部怎么做的**不可观测**，量到的只是这两条）。
（上一轮同在这里的「`DockIcon.bitmaps` 不上屏」已于阶段二百五十六清偿，见 §3.1。）

### 7.3 `NativeMenu.display()` 的模态语义

`display(stage, x, y)` 在 AIR 里弹一个**模态**原生菜单：**阻塞到选中/取消**，选中事件在返回前派发。
Cocoa 侧用 `-[NSMenu popUpMenuPositioningItem:atLocation:inView:]` 实现——它自己跑嵌套 tracking loop，
天然满足「阻塞」语义，所以本后端**不需要**给主循环加可重入的模态泵。`sk_menu_popup` 因此有两个返回值
维度：`tag`（选中了哪一项）与**同步/异步**（Cocoa/Win32 同步，web 异步 ⇒ 由 `sk_menu_popup_take` 逐帧取样）。

弹窗**消失那一刻**的指针位置由 `sk_menu_popup` 的 `outx/outy` 出参报告（Cocoa `SDL_GetGlobalMouseState`、
Win32 `GetCursorPos`）：AIR 在此时**补发**被弹窗吞掉的 `rightMouseUp`/`rightClick`，坐标取消失点（选中项/
窗外点）而不是按下点。这段回放由**发射器**做（只有它知道选中事件的顺序），且发生在选中事件**之前**。

### 7.4 主菜单第一个顶级项会被 macOS 改名（**平台行为，非缺陷**）

`adl` 的菜单栏是 `Apple, Alpha, Beta`（**没有**应用菜单槽），而 AOT 应用是
`Apple, <应用名>, Prune` —— 因为 AppKit 把 `mainMenu` 的 **item 0** 当作应用菜单，**用应用名覆盖它的
标题**。这不是我们的模型错了（`na.menu.items` 里 label 仍是 `First`），是 Cocoa 的规矩；
`adl` 不受影响只是因为它自己早就占着那个槽。

**约定**：AOT 应用**第一个顶级菜单就是应用菜单**（和任何原生 Mac 应用一样），宏观上更自然；
要保住第一项自己的标题，就把它当应用菜单来写（放 `Quit` 之类），从第二项起才是业务菜单。

### 7.5 Windows / wasm

能力位在非 `ASC_USE_WINDOW || !__APPLE__` 时全为 `0`，`sk_menu_*` 退化为 `static inline` 空桩。
Windows 侧将来接 `HWND` 菜单栏是**独立阶段**的事；wasm 没有原生菜单概念，能力位为 `0` 即为正确的
诚实回答。

---

### 7.6 半透明像素：AIR 会**多乘一次 alpha**，我们只乘一次（刻意不跟）

同一位图（128×128，左上 `0xFF0000FF` 不透明蓝、右上 `0xFFFF8000` 不透明橙、左下 `0x800000FF`
50% 蓝、右下 `0x80FF8000` 50% 橙）分别交给 `adl` 与 AOT 构建，同一个 Dock 图标槽位取色：

| 象限 | `adl 51.4.1` | 我方 |
|---|---|---|
| 不透明蓝 / 不透明橙 | `(0.2, 0.2, 244.7)` / `(238.8, 134.9, 50.7)` | **完全一致** |
| 50% 蓝 | `(36.9, 61.0, 122.3)` | `(36.9, 61.0, 183.6)` |
| 50% 橙 | `(92.2, 81.8, 57.7)` | `(152.0, 115.7, 72.8)` |

拆开看：**背景项完全一致**（`(1-a)·bg` 两边相同，说明 alpha 本身没错），**只有源色项被多乘了一次 `a`**
（`adl` 是 `a²·src + (1-a)·bg`，正确合成是 `a·src + (1-a)·bg`）。也就是 AIR 把**已经预乘过**的字节
当成「直通 alpha」的图交给 AppKit，AppKit 又乘一遍 ⇒ 半透明像素整体**偏暗**（经典的双重预乘瑕疵）。

**我方选择：只乘一次（正确合成）**，理由：这不是 AIR *定义*的行为，而是一次转换瑕疵；照抄它等于
故意实现一个变暗 bug（图标圆角的抗锯齿边会出现暗边）。不透明像素两边**逐字节相同**，所以普通图标
看不出差别；差异只出现在带 alpha 的像素上。**如实登记在 `TODO.md` 遗留表**，不静默。

### 7.7 右键菜单：`contextMenu` 的绑定与无法对齐的地方

`DisplayObject.contextMenu` 的右键通路已实现：`rightMouseDown` → 在祖先链上找最近一个持有该菜单的对象 →
`ContextMenuEvent.MENU_SELECT`（派发在**菜单**上，`mouseTarget` 是命中的显示对象，`preventDefault()` **无效**）→
弹窗 → 回放被吞的 release → 选中事件（`Event.SELECT` 在条目 → `Event.SELECT` 在菜单且 `target` 仍是条目 →
`ContextMenuEvent.MENU_ITEM_SELECT` 在条目）。`contextMenu = null` 时**不派发** `MENU_SELECT`，但右键事件照发。

**两处必须报明的差异**：

1. **web**：弹窗是 DOM 覆盖层，`sk_menu_popup` 立即返回「未决」，结果由 `sk_menu_popup_take` 在后续帧取回
   ⇒ `MENU_SELECT` 与选中事件**跨帧**，且**没有** release 回放（那是模态的产物）。浏览器原生右键菜单用
   DOM `contextmenu` 监听器 `preventDefault()` 抑制（emsdk 3.1.44 **没有** `emscripten_set_contextmenu_callback`）。
   web 上**只弹根菜单**，嵌套子菜单未实现。
2. **Windows**：`vendor/window_glue.cc` 的 Win32 分支与 Cocoa 同构（`TrackPopupMenu` 同步阻塞 + `GetCursorPos`），
   **已真机实测**（Windows 11 / 150% 面板，`temp/ctxwin/`，真鼠标 + 真键盘驱动）：菜单开在指针处
   （点 `(1480,1020)` ⇒ 窗口矩形 `[1481,1020,1678,1175]`）、一次右键**只**出一对 `rightMouseUp`/`rightClick`、
   连按两次第二次照弹、选中项（含**分隔线之后**的项与**子菜单**里的项）的事件顺序与 mac 逐项一致。
   实测查出并修掉三处 Windows 专有缺陷 + 一处静默降级，见 §7.8。
   仍缺两项：`keyEquivalent` 既不上屏也不生效（Win32 要在 `TrackPopupMenu` 的模态循环里挂消息过滤器才能吃加速键）；
   `NativeMenu` 的**应用菜单栏**仍未 `SetMenu`（独立阶段，不是右键通路）。

### 7.8 Windows 弹窗：三处实测缺陷 + 一处静默降级

全部在 Windows 11（150% 面板）上用真输入复现并验证修复，探针 `temp/ctxwin/CtxWin.as` + 驱动 `drive6.ps1`：

| 缺陷 | 现象（修前） | 根因 | 修法 |
|---|---|---|---|
| 菜单开错地方 | 点 `(1480,1020)`，菜单出现在 `(101,101)` | 弹窗前对 `GetCursorPos` 的结果做了 `ScreenToClient`，把窗口原点 `(1380,920)` 减掉了；`TrackPopupMenu` 要的是**屏幕**坐标 | 删掉 `ScreenToClient` |
| 一次右键两对事件 | `rightMouseUp`/`rightClick` 各出现两次，第二对在选中事件**之后** | AppKit 的 tracking loop 会**吃掉** release（mac 才需要 `sk_resync_right_button` 自己造一个）；Win32 的模态泵把真 `WM_RBUTTONUP` **投进 SDL 队列**，菜单关闭后才被处理，而发射器已在消失点回放过一次 | `g_popup_up_swallow`：真跑过 `TrackPopupMenu` 就置位，`SDL_MOUSEBUTTONUP` 的右键分支先于 `g_synth_right_up` 吞掉；新的右键按下清位（键盘取消时 release 可能在菜单关闭后才到） |
| 分隔线之后的项点了没反应 | 选 "Three"（`separatorBefore` 之后）菜单关掉但**什么都不派发** | `as_ctxmenu_fill` 用**扁平下标**当 tag（`c->items[k].tag = c->nitems`），而 `ASC_popup_tags` 只 push 真条目 ⇒ tag 越过表尾，取回 NULL | tag 改为 `ASC_popup_tags->length`（1 基）；`as_menu_fill` 本来就自洽（`tag_base + k + 1` 且每个槽都 push），不动 |
| 子菜单整棵丢失（**静默降级**） | 带 `submenu` 的项没有箭头，右方向键无反应，子条目根本不存在 | Win32 分支根本没建子菜单；且 `AppendMenuW` 的 `MF_POPUP` 我最初传的是 **id** 而不是**子菜单句柄**（Windows 静默当成普通命令项） | `sk_win_menu_build()` 递归建 `HMENU`，`AppendMenuW(menu, MF_POPUP \| MF_STRING, (UINT_PTR)sub, label)` —— 与 Cocoa 侧 `sk_menu_build` 一一对应 |

修后实测（同一驱动脚本）：`menus=[1481,1020,1678,1175]` 落在点击点下方；`Right` 展开出第二个
`#32768` 窗口 `[1668,1133,1890,1208]`（截图 `temp/ctxwin/sub2.png`：`More ▸ Sub One / Sub Two`），
`Down`+`Enter` 选中 `Sub Two`；日志里只有**一对** `rightMouseUp`/`rightClick`，且都在选中事件之前。

### 7.9 Windows 两处回归（150% 面板下才暴露）：DPI 倍率与「分隔符条目」

§7.8 的探针是**DPI 未感知**的 PowerShell 驱动的：`SetCursorPos` 与 `GetWindowRect` 都在虚拟坐标里，
整条坐标链统一乘/除同一个倍率，于是「弹出点少乘 1.5」被自己抵消掉，测出一个假的「菜单就在指针处」。
换成真应用（`TalkMED Meeting.exe`，窗口 2200×1319、client 2167×1263）+ `SetProcessDPIAware()` 的驱动
（`temp/ctxpos/`）后，两个缺陷都当场现形：

| 缺陷 | 现象（修前） | 根因 | 修法 |
|---|---|---|---|
| 菜单还是开错地方 | 物理点 `(3516,1245)`，206×111 的菜单出现在 `(2344,830)` —— 恰好是**点 ÷ 1.5** | 上游全是 DIP（stage、`NativeWindow.bounds`、SDL 的鼠标坐标），而 per-monitor-DPI-aware 进程里的 `TrackPopupMenu` 吃的是**物理像素**；`sk_menu_popup` 的老注释还明确写着「不需要乘倍率」 | 弹窗前 `bk = sk_window_backing_scale(c->win)`，`pt.x/pt.y` 各乘 `bk`（四舍五入） |
| 关掉菜单时回放点错位 | 在 `(2562,947)` 点空白处关菜单，回放的舞台事件落在 `(150,600)`（stage 只有 720×480） | `GetCursorPos` 回填的 `outx/outy` 是物理像素，却被当成 DIP 喂回舞台 | `*outx = g.x / bk`、`*outy = g.y / bk` |
| 分隔符画成一个空菜单项 | 菜单里「修改昵称 / 空行 / 截图上传」，空行**可点**，AIR 那里是一条**不可点的线** | 应用建分隔线用的是 `new NativeMenuItem("", true)`（`isSeparator`），**不是** `ContextMenuItem.separatorBefore`；`as_ctxmenu_sep()` 只认后者，于是每个 `isSeparator` 条目都掉进正常分支，变成 enabled 的空行 | 新增 `as_ctxmenu_is_sep()` 读 `_sep`，在 `as_ctxmenu_count`/`as_ctxmenu_fill` 的两趟里**先**判它：占一个扁平槽（`kind=1`、空 label、`enabled=0`、`tag=0`）、不 push `ASC_popup_tags` |

修后实测（同一驱动，`temp/ctxpos/`）：真应用右键 → `#32768` 矩形 `[3101,1146,3307,1233]` 与光标逐像素相同
（`menuB2.bmp`：修改昵称 / —— 线 —— / 截图上传）；左键点那条线的位置，菜单**不关**也不派发任何事件；
点线下面的「截图上传」菜单正常关闭。探针 `temp/ctxpos/Probe292.as`（`Alpha / 分隔线 / Bravo`）把三件事一次钉死：
右键 `(2862,647)` ⇒ 菜单 `[2862,647,3060,736]`（198×89）；点 `Bravo` 得到 `SELECT target=item(Bravo)`（条目级）→
`SELECT target=item(Bravo)`（菜单级，target 仍是条目）→ `MENU_ITEM_SELECT`，即**分隔线之后的 tag 没有错位**；
点窗外 `(2562,947)` 关掉菜单，回放的 `stageClick` 落在 `100,400`（= 物理点按 client 原点 `(2412,347)`、倍率 1.5 反算），
不再落到 stage 之外。

**为什么 §7.8 没抓到**：旧驱动既没 `SetProcessDPIAware()`，也没核对「点 → 弹出矩形」这条等式，
只看「菜单在点附近」。教训写在这里：Windows 上的坐标类缺陷，驱动**必须**是 DPI 感知的，
且断言要写成等式（弹出矩形左上角 == 点击点），不能写成「看起来在旁边」。

**一处内部依赖**：`sk_resync_right_button()` 调 `SDL_SendMouseButton()` 清掉 SDL 以为「右键还按着」的掩码——
不这么做**第二次右键不派发任何事件**（弹窗吃掉了真 release，SDL 的掩码永远停在按下）。该符号是 SDL 的**内部**
API（公开头文件没有），升级 SDL 时需复核；它造出来的 `SDL_MOUSEBUTTONUP` 由 `g_synth_right_up` 吞掉，AS3 侧
只看到发射器补发的那一对。


### 7.10 剪贴板：四种格式真翻译，三种格式不做

阶段二百九十三。`flash.desktop.Clipboard` 之前是**空替代**（`shell()`：构造得出、成员全空），
`System.setClipboard` 直接报「本构建不实现」。现在两者都是真实现：`Clipboard` 对象持有一张
`(格式 → 数据)` 条目表，`generalClipboard` 那张表**直通操作系统剪贴板**。

#### 模型

AIR 的模型（`Clipboard.html`）是一个对象持有一组条目，`generalClipboard` 就是同一组条目、由
系统剪贴板承载。我们的实现照抄这个形状：类里三个平行 `Array` —— `_fmts`（格式名）、`_vals`
（载荷）、`_hdl`（`setDataHandler` 装的延迟处理器）。用 `Array` 而不是 C 链表，是为了让 GC
通过普通的**类字段反射表**标记它们，不必给 GC 加新类型。`_hdl` 某格非空 ⇒ 该格式**读时渲染**
（`getData` 调它取返回值），`setData` 写同一格式会把该格的处理器清掉。

#### 格式与类型

| 格式常量 | 字符串 | AIR 的载荷类型 | 我们 | 平台表示（Windows） |
|---|---|---|---|---|
| `TEXT_FORMAT` | `text` | `String` | ✅ 翻译 | `CF_UNICODETEXT` |
| `HTML_FORMAT` | `html` | `String` | ✅ 翻译 | `RegisterClipboardFormatW("HTML Format")`，读时剥掉 `CF_HTML` 头 |
| `RICH_TEXT_FORMAT` | `richText` | `ByteArray` | ✅ 翻译 | `"Rich Text Format"`（RTF 字节原样搬运） |
| `URL_FORMAT` | `url` | `String` | ✅ 翻译 | `"UniformResourceLocatorW"` |
| `BITMAP_FORMAT` | `bitmap` | `BitmapData` | ❌ 报明 | — |
| `FILE_LIST_FORMAT` | `fileList` | `Array`（`File`） | ❌ 报明 | — |
| `FILE_PROMISE_LIST_FORMAT` | `filePromiseList` | `Array`（`IFilePromise`） | ❌ 报明 | — |

未翻译的三种：`hasFormat` 返回 `false`（不谎报），`setData` 调 `as_shell_unsupported(...)`
并把值**留在对象里**后返回 `false`（自读自回仍然成立，跨应用不行）。这是**遗留缺陷**、不是
增强 —— AIR 在这三种格式上是能用的，已登记 `TODO.md` 的「遗留待开发」。

#### 三条顺序规则（都是实测逼出来的）

| 规则 | 为什么 |
|---|---|
| `hasFormat` / `getData` **先问 OS，再问自身条目** | `generalClipboard` 直通平台。反过来先查自身影子副本，会让「别的应用刚复制的内容」被我们上次写下的旧值遮蔽 |
| `setData` 写 OS **成功后删掉自身影子副本** | 同上；否则 `getData` 会读出比自己刚写进系统的更旧的值 |
| 写 OS 前先 `EmptyClipboard()`，再把**其余三种格式搬回来**（`sk_clip_rebuild`） | Win32 只有剪贴板所有者能 `SetClipboardData`，取所有权必然清空。不搬回来就是「复制一段文字顺手抹掉用户复制的图片」 |
| `sk_clip_open()` 最多试 10 次 × `Sleep(2)` | `OpenClipboard` 被别的进程短暂占用是常态（PowerShell 的 `Clipboard.GetDataObject`、各种剪贴板管理器）。直接失败会让「复制」随机失灵 —— 这正是首次外部验证全部报「未翻译」的原因 |

`sk_clipboard_set_text()` 也走 `set_fmt("text")`，不用 SDL 的 `SDL_SetClipboardText`：
后者会清空其他格式，`System.setClipboard()` 就等于顺手毁掉 `html`/`url`。

#### 与 AIR 的差异（逐条登记）

| 差异 | 归属 | 说明 |
|---|---|---|
| `bitmap` / `fileList` / `filePromiseList` 不翻译 | **遗留缺陷** | 见上表；`hasFormat` 不谎报 |
| `serializable` 参数被接受但**不产生序列化副本** | 遗留缺陷 | AIR 在该参数为 `true` 且数据不可跨进程时做序列化；我们跨进程只走原生格式，故没有副本可分 |
| `getData` 的 `transferMode` 非法时报 `Clipboard.getData: invalid transferMode [xxx]` | 措辞自拟 | 无 Windows `adl` 可测 AIR 原文；宁可用方括号标注而不是编一句 AIR 文案 |
| `setData` 的 `data` 参数在 `describeType` 里是 `*` 而非 `Object` | 偏差 | 载荷必须**仍然装箱**地到达 C 层：`String` 是 `char*`、`ByteArray` 是 vtable 指针，统一成 `Object` 会让两者不可区分 |
| `supportsFilePromise` 恒 `false` | 如实 | Windows 上 AIR 也是 `false`；没有 `filePromiseList` 实现，报 `true` 才是谎报 |
| Web / 无窗口构建 `sk_clipboard_available()==0` | 如实 | AS3 侧据此报「本构建没有剪贴板后端」，值留在对象内，`hasFormat` 自读自回仍成立 |

`setData`/`setDataHandler` 的 `#2007` 文案逐字对齐 AIR：
`Error #2007: Parameter format must be non-null.` / `... data must be non-null.` /
`... handler must be non-null.`；`richText` 收到非 `ByteArray` 时报明并返回 `false`
（AIR 的类型表要求 `ByteArray`，存别的会让 `getData` 交回不符承诺的类型）。`clearData` 的形参名是
`mimeType`（`getData`/`setData`/`setDataHandler`/`hasFormat` 都叫 `format`）—— 不是偏差，AIR 的
playerglobal 就是这么声明的，`unit: builtin/Arity` 用 mxmlc 对照钉着。

#### 证据

- **同进程四种格式**（`temp/clip/t2.as`，Skia 清单）：写入后读回
  `text=中文 clipboard 实测 abc` / `html=<b>bold-frag</b>` / `url=https://example.com/a?b=c` /
  `rt={\rtf1 rtf-frag}`，`formats=text,html,richText,url`；`clearData(HTML)` 后 `text`/`url` 仍在。
- **外部进程视角**（`temp/clip/ps-read.ps1`，PowerShell 读系统剪贴板）：
  `text=中文 clipboard 实测 abc`；`HTML Format` 是合法 `CF_HTML`
  （`Version:0.9` + `StartHTML:0000000105 / EndHTML:0000000186 / StartFragment:0000000137 /
  EndFragment:0000000154` + `<html><body><!--StartFragment--><b>final-frag</b><!--EndFragment--></body></html>`）；
  `Rich Text Format={\rtf1 rtf-frag}`；`UniformResourceLocatorW` 是 `MEMSTREAM:58` 的 UTF-16。
- **反方向**：PowerShell `Set-Clipboard -Value "external-app-wrote-this"` ⇒ `temp/clip/t3.as` 读回
  `hasText=true text=external-app-wrote-this fmts=text localHas=false`（即 OS 优先、影子副本没有遮蔽）。
- **连续三次运行输出完全一致**（无 `OpenClipboard` 偶发失败）。
- `examples/clipboard.as` 八段（容器语义 / 多格式共存 / `richText` 必须是 `ByteArray` 且
  `position=0` 后读 / `cloneOnly` / handler 读时渲染且被 `setData` 取代 / `clear` /
  `generalClipboard` + `System.setClipboard` / `System.gc()` 后存活）在纯 C 与 Skia 两种构建上都通过；
  `test/unit/clipboard.ts` 68 条源级钉。

---

## 8. 验收与证据

| 项 | 证据 |
|---|---|
| **`ContextMenu` 对象模型 26 行**（与 `adl` 逐字节相同） | `examples/context-menu.as`（AOT `--run`）× `temp/ctxprobe/api/ApiEx.as`（同一段程序的 `adl` 版）：26/26 行一致；配套 `test/unit/context-menu.ts` 的 `unit: context-menu/Model`（25 钉）钉住一份列表、三条独有规则、`#2007` 文案与弹窗顺序 |
| **右键弹窗 7 步真机**（macOS） | `temp/ctxmenu/drv.py` 的 `open`/`pick0`/`pick1`/`twice`/`esc`/`outside`/`nul`：LR 与 `adl` 逐字段相同（`rightMouseDown → MENU_SELECT → rightMouseUp → rightClick → 三个选中事件`），回放坐标 = 消失点（项上 148,111 / 按下点 116,98 / 窗外点 348,259）；截图 `temp/ctxmenu/{m5-inv,crop-inv}.png` 证明 `visible=false` 不渲染、`enabled=false` 灰色、`separatorBefore` 画线 |
| **右键弹窗 Windows 真机** | `temp/ctxwin/`：`CtxWin.as` + `drive6.ps1`（真 `SetCursorPos`/`mouse_event`/`keybd_event`）。菜单矩形 `[1481,1020,1678,1175]` 挂在点击点 `(1480,1020)`；`sub2.png` 证明 `More ▸ Sub One/Sub Two` 展开；日志 `SELECT item(Sub Two)` + 菜单级 `SELECT`；一次右键只有一对 `rightMouseUp`/`rightClick`；`test/unit/context-menu.ts` 31 钉含 4 条 Win32 钉（无 `ScreenToClient`、吞队列 release、`MF_POPUP` 传句柄、tag 取 `ASC_popup_tags` 下标） |
| **右键弹窗 Windows 真应用（150%，DPI 感知驱动）** | `temp/ctxpos/`：真应用右键 → `#32768` `[3101,1146,3307,1233]` **等于光标**（修前是光标 ÷ 1.5）；`menuB2.bmp` 里两条目之间是**线**、点它菜单不关；`Probe292.exe` 的 `probe.log`：`rightMouseDown stage=300,200`（物理 `(2862,647)`、client 原点 `(2412,347)`）→ `SELECT target=item(Bravo)` 三层顺序 → 点窗外关掉时 `stageClick=100,400`；`test/unit/context-menu.ts` 38 钉含 7 条（`as_ctxmenu_is_sep`、分隔符占一个槽、两趟都让位、tag 不 push、倍率乘、回放除） |
| 模型层 69 条断言（纯 C 构建，无窗口后端） | `examples/native-menu.as` → `native-menu: 69 checks passed` |
| 生成 C 的 39 条源级钉 + 上屏 16 条 | `test/unit/emit.ts` 的 `unit: emit/NativeMenu` 与 `unit: emit/DockIconImage` |
| **选图规则 8 轮** | `temp/dockprobe/`：`{32,96,256}→96`、`{16,512}→16`、`{129,127}→129`、`{128×400, 200×200}→200×200` …（§3.1 表） |
| **上屏 / 透明度 / 清除 / 重绘** | `temp/dockquad.as`（AOT 构建）× `temp/dockprobe/Main.as`（`adl`）：不透明像素取色**完全一致**、50% 蓝 `183.6` vs `adl` `122.3`（§7.6）、`bitmaps=[]` 后回默认图标、`t8` 重赋值立刻变色 |
| 真菜单栏 + 真点击 | `temp/G4App.app`（`NSPrincipalClass=NSApplication`）：AX 读到 `Apple, G4App, Prune`，点 `Prune → PruneTwo` 后 AS3 的 `SELECT` 监听器真的跑了（写 `/tmp/g4click.txt` = `two`） |
| Dock 右键菜单 | `sk_menu_install_dock` 把 `applicationDockMenu:` swizzle 到 SDL 的 delegate 上（真右键点击未自动化） |
| `autoExit=false` 驻留 | 同一 bundle：关窗后进程仍在，直到 `NativeApplication.exit()` |
| 主菜单形态对照 | `probe8.txt`（`adl`：`Apple, Alpha, Beta`）vs 同一模型的 AOT 应用（§7.4） |

---

## 9. 未做（不属于本阶段）

- ~~**G4b：macOS 菜单栏 `NSStatusItem`**~~ —— **已实施（阶段二百六十）**：属**增强**（AIR 在 macOS 上没有
  对应物：`supportsSystemTrayIcon` = `false`），故做成 opt-in 具名开关 `--features tray`；默认产物仍与 AIR
  逐字同形（`false` + `#2012`）。行为、坐标口径、真机证据与已知边界见
  [`enhancements.md`](enhancements.md) §4.11 与 [`compile.md`](compile.md) §3.4.5。