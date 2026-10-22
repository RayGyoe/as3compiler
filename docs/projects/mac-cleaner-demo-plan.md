# MacBroom —— macOS 菜单栏清理工具 / as3compiler 推广 demo

> **方案类型**：产品 + 技术方案（**能力缺口已进入实施**：G1 / G2 已落地并清偿，其余仍待排期）
> **形态裁定（2026-10-22）**：菜单栏小工具（`NSStatusItem` 常驻 + 点开浮层）
> **底座**：`as3compiler` v0.4.207，最大已用阶段号 `阶段二百四十三`
> **所有"现状"断言均在 2026-10-22 于 HEAD 上用 `grep`/读码核实**，出处逐条标注；未核实的一律标注"未实测"。
>
> **实施状态（2026-10-22 更新）**：方案本身仍不占阶段号（demo 本体未开工），但**能力缺口已开口**——
> **G1 + G2 由「阶段二百四十三」（v0.4.206 → v0.4.207）清偿**，详见 §2.2 表的「状态」列与 §2.4。
> 尚未开工：G3、G4、G5、G7、G8 与 demo 本体。

---

## 0. 定位与推广叙事

**一句话**：一个真能用的 macOS 清理工具 —— 源码是 ActionScript 3，产物是原生 C 编译出的 Mach-O `.app`。没有 Electron、没有 Node 运行时、没有 Python 解释器。

### 为什么选这个题材做推广 demo

| 理由 | 说明 |
|---|---|
| 有现成的"对照组" | 同赛道最火的两个都是解释型/脚本：`tw93/Mole`（Shell，72.3k★）、`guhcostan/mac-cleaner-cli`（TS）。我们天然站在"原生 vs 运行时"的对立面 |
| 吃满编译器能力 | 清理工具同时压 **文件系统 IO（递归遍历 + stat）**、**海量文本列表渲染**、**多窗口/系统集成** —— 正好是 AOT 编译器的压力测试，且全部是真实负载而非玩具 |
| "可审计"是刚需 | 清理工具要申请最深的权限再删文件，这个赛道二十年的核心矛盾就是信任。而"生成可读 C"是本项目写在 README 里的承诺 —— **可审计性直接变成产品卖点**，不是技术自嗨 |
| 能出交付物 | `--package xcode-project` 已经能生成 macOS application 工程，`xcodebuild` 后就是可双击的 `.app` |

### 量化卖点（推广文案可用，实施后需实测填充）

- 安装体积：`hello.as` 经 `cc -O2 -lm -lz` 当前约 **52 KB**（`AGENTS.md` §2.6 实测数）⇒ 全功能版预期仍在 **数 MB 级**，对比 Electron 方案的 100 MB+ 量级
- 冷启动：原生 Mach-O，无运行时初始化
- 可审计：`--dry` 保留 `.c`，整个删除决策逻辑是 C 源码，可人工逐行读

---

## 1. 产品方案

### 1.1 形态与交互

菜单栏图标常驻，图标旁显示实时磁盘占用（例：`38%`）。左键点开一个**无边框、总是置顶**的浮层面板；点面板外自动收起。

面板尺寸 **340 × 440**（逻辑像素），三段式：

```
┌──────────────────────────────────────┐
│  磁盘  62.4 GB 可用 / 494 GB          │  ← 顶部：容量条
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░     │
│  可清理 3.2 GB                        │
├──────────────────────────────────────┤
│  ☑ 用户缓存            1.4 GB   ● 安全 │  ← 中部：分类列表
│  ☑ 日志                 218 MB  ● 安全 │     行高 36
│  ☑ 临时文件             512 MB  ● 安全 │
│  ☐ 废纸篓               1.1 GB  ● 确认 │
│  ☐ 大文件 & 旧文件      8.7 GB  ● 谨慎 │     永不默认勾选
├──────────────────────────────────────┤
│           [ 重新扫描 ]  [ 清理 ]       │  ← 底部
└──────────────────────────────────────┘
```

**风险色点语义**（必须与文案一致，不允许含糊）：

| 色 | 含义 | 默认勾选 |
|---|---|---|
| ● 安全（绿） | 系统/应用会自动重建的缓存、日志、临时文件 | 是 |
| ● 确认（黄） | 用户数据但可恢复（废纸篓、下载目录里的旧安装包） | 否 |
| ● 谨慎（红） | 大文件 / 旧文件 —— 可能是用户唯一副本 | **否，且永不允许"全选"批量勾上** |

### 1.2 功能范围

**P0 —— MVP（没有它就不算跑通）**

1. 菜单栏图标常驻 + 磁盘占用百分比
2. 点开浮层面板，展示容量条
3. 一键扫描 4 类安全目标：用户缓存、日志、临时文件、废纸篓
4. 扫描结果列表：分类名 + 体积 + 勾选框 + 风险色点
5. 清理 = **移入废纸篓**（不是永久删除），完成后显示回收量
6. 退出

**P1 —— 有余力再加**

7. 开发者缓存细分：Xcode DerivedData / Archives、Homebrew cache、npm·pnpm·yarn store、Docker
8. 大文件 & 旧文件（>100 MB 或 >1 年，永不默认勾选）
9. 卸载残留（bundle id + team id 匹配，参考 PureMac 的分档灵敏度）
10. 排除项/白名单持久化（`SharedObject`）

**明确不做（防范围蔓延，逐条给理由）**

| 不做 | 理由 |
|---|---|
| 特权操作：清系统级目录、删 Time Machine 本地快照 | 需要 `SMJobBless` 特权 helper（ObjC + Security 框架），工作量远超 demo 本身收益 |
| **完全磁盘访问（FDA）引导** | **刻意不做**：P0 的 4 类目标全在用户可读范围内（`~/Library/Caches`、`~/Library/Logs`、`$TMPDIR`、`~/.Trash`），**不需要 FDA**。一旦引入 FDA，就要处理授权轮询、失败重试、签名身份稳定性，复杂度爆炸而 demo 价值不增 |
| 实时 CPU/内存图表 | 需要 `mach host_statistics` 新胶水，且与"清理"主线无关 |
| 重复文件 / 相似图片 | 那是 `qarmin/czkawka`（34.4k★）的活，不自研 |
| 自动/定时清理 | 无人值守的破坏性操作不适合当 demo；也是 PureMac 明确标注的高风险项 |
| 菜单栏实时监控曲线 | 同上，非主线 |

### 1.3 安全契约（写进 demo README，直接对标 PureMac 的"诚实"卖点）

1. **只移废纸篓，永不永久删除**
2. **零遥测、零网络请求**（清理工具不该联网）
3. **不制造假紧迫感** —— 不报"检测到 47 GB 垃圾！"、不用红色告警计数
4. **不过度承诺** —— 不宣称能回收 APFS purgeable space（第三方做不到）、不宣称"加速你的 Mac"
5. **删除前把文件清单摊开** —— 每一类点开都能看到具体路径
6. **系统关键路径硬保护**

---

## 2. 技术方案

### 2.1 应用架构

```
demo/maccleaner/app.as            ← AS3 入口，装配以下模块
├─ StatusItem        菜单栏图标 + 磁盘读数        ← 需新增能力 G4
├─ CleanPanel        浮层面板（NativeWindow）      ← 已具备 G6
├─ Scanner           递归遍历 + 体积累加           ← 已具备（File API）
├─ Cleaner           移入废纸篓                    ← ✅ 已具备 G1（阶段二百四十三）
└─ DiskInfo          卷容量/可用量                 ← ✅ 可用量已具备 G2；卷总量仍缺 G3
```

### 2.2 底座现状核实（逐条带出处）

**已经具备，直接用**

| 能力 | 出处 | 说明 |
|---|---|---|
| `File.exists` / `isDirectory` / `size` / `name` / `parent` | `src/emit.ts:15139-15251` | 体积累加与遍历的原子操作齐了 |
| `File.getDirectoryListing()` | `src/emit.ts:15592` | 递归遍历的入口 |
| `File.deleteFile()` | `src/emit.ts` | 有，但**永久删除**，不能拿来当清理动作 ⇒ 清理一律走下行 |
| `File.moveToTrash()` / `moveToTrashAsync()` | `src/emit.ts`（阶段二百四十三） | ✅ 已具备（G1）；macOS + freedesktop 双后端，Windows/wasm 响亮报明 |
| `File.spaceAvailable` | `src/emit.ts`（阶段六十四，阶段二百四十三 校正作用域） | ✅ 已具备（G2）；只给已有文件/目录的卷可用量 |
| 无边框窗口：`systemChrome` / `resizable` / `maximizable` / `minimizable` / `decorated` | `src/emit.ts:5866-5902` | 浮层窗可以做 |
| `alwaysInFront` | `src/emit.ts:6087-6101` | 浮层置顶可以做 |
| `transparent` | `src/emit.ts:6104` | 圆角/透明背景可做 |
| 异步 IO job 池（不阻塞主线程） | `src/runtime.ts:9878-9898`，`AS_JOB_READ_TEXT/READ_BYTES/IMAGE/FS_OPEN/DECODE/HTTP/...` | 扫描可异步化，但**没有目录遍历/stat 类 job**（见 G7） |
| 绘制底座：`Sprite` / `Shape` / `Graphics` / `TextField` / `SimpleButton` | `src/symbols.ts` 内建类表 | 列表要手搓，但零件齐 |
| macOS 打包：`--package xcode-project` | `src/index.ts:291, 1034-1057`，`src/xcode-project.ts` | 生成 `.xcodeproj` + 共享 scheme，`xcodebuild` 后可出 `.app` |

**关键缺口（本方案的实施主体）**

> **状态列口径（2026-10-22）**：以 `阶段二百四十三`（v0.4.207，commit `1135490`）为界。
> ✅ = 已落地且有 `adl 51.4.1` 双端探针 + 回归钉子；⬜ = 尚未开工。
> "现状（核实方式）" 一列保留**当初立项时的核实快照**，已落地的行另注现值，便于对照计划与实际的偏差。

| # | 能力 | 现状（核实方式） | 归属判定（AGENTS §1.5） | 工作量 | 状态 |
|---|---|---|---|---|---|
| **G1** | `File.moveToTrash()` **+ `moveToTrashAsync()`** | 立项时**零实现**（`grep -c moveToTrash src/emit.ts` = 0）⇒ **现已落地**（`grep -c` = 6；`File_moveToTrash` / `File_moveToTrashAsync` 在 `src/emit.ts`） | **遗留欠账**（AIR 有、我们跑不出）⇒ 正常阶段 + 版本号 | 小 —— 实测比预估更小：**不需要 Obj-C 胶水**，`rename(2)` 就够（见下方「立项判断与实测的偏差」） | ✅ **已实现（阶段二百四十三）**：签名按实测是 **`void`**；macOS（`~/.Trash` + `<卷>/.Trashes/<uid>`）与 freedesktop（`Trash/{files,info}` + `.trashinfo`）双后端；Windows/wasm 无回收站 ⇒ 响亮报明 + `#2038`（已入 `遗留待开发`） |
| **G2** | ~~`File.getSpaceAvailable`~~ ⇒ 真名是 **`File.spaceAvailable`（属性）** | 立项时记**零实现**（`grep -c getSpaceAvailable src/emit.ts` = 0）——**这条核实本身错了**：AIR 里没有 `getSpaceAvailable` 这个成员，而 `spaceAvailable` 属性**自阶段六十四 起就已存在** | 原判 **遗留欠账** ⇒ **实为误记**（不是欠账） | 已用：**极小**（只校正作用域） | ✅ **无需新增（阶段二百四十三 查明）**：`'getSpaceAvailable' in f` = `false`、取它抛 `#1069`；`spaceAvailable` 只补「仅对普通文件/目录作答」（`/dev/null` 在 `adl` 回 `0`） |
| **G3** | 卷总量 / 已用量 | 无对应 API；`--package` 的构建清单里也没有 | **增强**（AIR 的 `File` 只给 `spaceAvailable`，总量要另取） | 小（同 G2 的 `statfs`：`f_blocks` / `f_bfree`） | ⬜ **未开工**（原计划并在阶段二百四十三，本轮只做 G1+G2，顺延） |
| **G4** | **菜单栏状态项**（`NSStatusItem`） | **零命中**：`grep -riE "NSStatusItem\|status item\|Shell_NotifyIcon\|tray" src/*.ts vendor/*` 只在无关注释里命中 | **增强**（AIR **没有**对应物）⇒ 必须 opt-in 具名开关，默认关 | **中**（新 `vendor/statusitem_glue.mm` + 接进 SDL2 事件循环，见 §2.4 风险） | ⬜ **未开工**（最大风险项，建议先探针） |
| **G5** | accessory app（`LSUIElement=1`，无 Dock 图标、不抢焦点） | `src/xcode-project.ts:353` 的 `infoPlist()` 生成器**无此键** | **增强**（AIR 描述符里没有这个开关）⇒ 构建清单新字段 | 小（plist 加一个键 + 清单字段） | ⬜ **未开工** |
| **G6** | 浮层窗（无边框 + 置顶） | ✅ 已具备（见上表） | — | **0** | ✅ **已具备（历史能力）** |
| **G7** | 目录遍历的异步化 | job 池**无** `DIR`/`STAT` 类 job（`src/runtime.ts:9878-9898` 全清单已列） | 可用同步遍历顶 MVP（见 §2.5 对策） | 中 | ⬜ **未开工**（MVP 可先用同步遍历） |
| **G8** | **一条命令出已签名 `.app` / `.dmg`** | `--package` 合法值只有 `raw \| xcode-project \| android-project \| web`（`src/index.ts:291, 798`）；**无 `app` / `dmg`**；`grep -n "codesign\|hdiutil" src/build.ts` = **0 命中**；`--package xcode-project` **只生成工程不构建**（`src/index.ts:1034-1057` 自述"是「生成工程」步骤，不做 cc"） | **增强**（工程化便利，非 AIR 语义） | 中（`xcodebuild` + `codesign --deep` + `hdiutil create` 编排） | ⬜ **未开工** |

> **立项判断与实测的偏差（阶段二百四十三，探针 `temp/trashprobe/`，`adl` 与 AOT 双端对照）**：
> 1. **`moveToTrash()` 的返回类型不是 `Boolean`** —— AIR 参考文档写 `Boolean`，但 `adl 51.4.1` 上 `f.moveToTrash().toString()` 是 `mxmlc` **编译期错误**，`adl` 求值 `undefined`。真口径是 `void`。照文档实现成 `Boolean` 会让 `if (f.moveToTrash())` 在两端结论相反。
> 2. **不需要 `NSFileManager` / `NSWorkspace` 胶水**：本项目按 AIR 口径做的是 `rename(2)` + POSIX 目录布局，跨端同源、零 Obj-C；代价是 macOS 侧的「放回原处」(Put Back) 记录缺失（Finder 把它存在卷元数据里），这属于**系统集成便利**，不影响清理语义（文件确实进了废纸篓、可手工恢复）。
> 3. 由此，**G2 不是缺口**：登记它时误以为属性名是 `getSpaceAvailable`，该成员在 AIR 里不存在。核对类成员前应先查类列表再 `grep`，否则会给"补一个 AIR 没有的 API"这种事开口子。

> **⚠️ 两处需要纠正的前序判断**（我在上一轮口头提到过，此处以码为准）：
> 1. `--package app` / `dmg` **并不存在**，`docs/zh-cn/compile.md:894` 描述的是规划形态，同文件 `:949` 的表格自己也标了「规划」。实际只有 `xcode-project`，且它**到生成工程为止**，需要用户自己跑 `xcodebuild`。
> 2. 因此"一键出 `.app`"是**待建能力 G8**，不是现成能力。

### 2.3 控件现实：L3 缺口是已知评估，不在本方案内解决

「UI 工具链待定项（未排期）」（`as3compiler/TODO.md:14540`）已裁定：**L1 渲染与 L2 显示树/事件/命中/文本已有且对 `adl` 校准过；缺的是 L3 控件与作者模型 + L2 自动布局**，并且点名"219 个示例里连一个 Button 都没有"。

本 demo 的选择是：**在 demo 内部手搓面板所需的列表行与勾选框，不推进 `asaotui` 控件层**。

- 依据：那个 U1~U5 层是**通用**工具链，前置测量（Yoga 体积/wasm 可编性/与 `-Wl,-dead_strip` 相容性）都还没做（`TODO.md:14552`）。把它绑进一个推广 demo 会让 demo 永远发不出来。
- 代价：demo 里的列表是"专用的、丑的、但能跑"的实现。这是**有意的取舍**，需在 README 里如实说明，不能假装是通用控件。
- 复用边界：demo 的手搓代码只放在 demo 目录；若将来 `asaotui` 落地，再迁移。

### 2.4 分阶段落地（243 ✅ 已实施；其余预留编号）

> 依据 `AGENTS.md` §2.7 / `TODO.md` 备注：每阶段一个 patch 版本号；阶段号取已用最大值 +1 ⇒ 从 **阶段二百四十三**（v0.4.206 → v0.4.207）起。
> **本方案不占阶段号** —— 与 `TODO.md:14544` 的 UI 工具链评估同一口径（"只有真进入实施才占"）；
> **但能力缺口当场占**：G1/G2 已以 `阶段二百四十三` 落地，后续 G4/G5/G8 仍按此表顺序排。

**阶段二百四十三（✅ 已完成，v0.4.206 → v0.4.207，commit `1135490`）· 文件系统补齐（G1 + G2）**

- 目标：`File.moveToTrash()` / `moveToTrashAsync()` / `File.spaceAvailable`，语义逐字对齐 `adl 51.4.1`
- 已做的实测：`temp/trashprobe/`（`app.xml` + `Main.as` + `mxmlc`/`adl` 双跑）量清了返回类型、错误号（`#3003` / `#2038` / `#2037`）、成功后 `nativePath` 不变而 `exists` 转 `false`、已在废纸篓里是**成功 no-op**、同名冲突的 Finder 命名（`x.txt → "x.txt 18-34-09-271.txt"`）、`spaceAvailable` 的路径作用域
- 产出（均已落地）：`examples/move-to-trash.as`（运行时断言）+ `test/unit/emit.ts` 的 `unit: emit/FileMoveToTrash`（17 项源级钉）+ `docs/{zh-cn,en}/filesystem.md`（新建）+ 两份 README
- **未做（顺延）**：**G3 卷总量/已用量**。原计划"G1 + G2 + G3 同阶段"，实际只做了前两项——G3 是**增强**（AIR 无对应物），必须 opt-in 具名开关，与本阶段的"清偿遗留欠账"性质不同，强行合并会把两者口径搞混
- 顺带登记的遗留：Windows/wasm 回收站后端、空 `File` 成员全线不抛 `#2037`（族级修复要先把 `nativePath` 改成访问器）

**阶段二百四十四（预留）· G3 + G4 + G5 + G8 —— 卷规模、菜单栏与打包**

- G3 卷总量/已用量：`statfs` 的 `f_blocks` / `f_bfree`，走具名开关或清单字段（**增强**，默认产物不变）
- G4 `NSStatusItem`：新建 `vendor/statusitem_glue.mm`，接进 `vendor/window_glue.cc` 的事件泵
- G5 `LSUIElement`：构建清单新字段（如 `agent-app`），`src/xcode-project.ts` 的 `infoPlist()` 消费它
- G8 `.app` / `.dmg` 一键产出：`xcodebuild` + `codesign` + `hdiutil`
- 属**增强** ⇒ 全部走 `--features` 具名开关 / 清单字段，**默认产物必须与现状同构**
- 产出：`examples/status-item.as` + `[native-window]` 类钉子 + `docs/zh-cn/` 新文档

**阶段二百四十五（预留）· demo 本体**

- 扫描 / 列表 / 清理 / 浮层面板 / README 截图
- 属 demo（非编译器能力），**不占阶段号**；只作为 `examples/` 之外的独立目录

### 2.5 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **G4 是最大不确定性**：SDL2 没有托盘 API，`NSStatusItem` 要自己起一个 Cocoa 侧事件源并和 SDL 的 run loop 并存 | 菜单栏做不出来 ⇒ 形态塌方 | 先做**最小可行性探针**（只出一个图标 + 点击回回调打日志），通过了再写面板。**退路**：退回普通单窗口 app（推广效果打折但不致命） |
| 同步遍历大目录会卡 UI | 扫描时面板冻结 | MVP 先同步，但**分帧回填**（每帧处理 N 个目录）；若不够再补 `AS_JOB_DIR` 类 job（G7） |
| 目录遍历在 `~/Library` 下会遇到权限拒绝 | 扫描出错中断 | 逐目录 `try/catch` 跳过并统计；**如实报告跳过数量**，不静默 |
| **`~/Documents` 下的产物会触发 macOS 文稿 TCC 弹窗**（本项目工作区就在 `~/Documents`） | 本地调试体验被打断 | 调试运行把二进制放 `$TMPDIR`；或构建输出重定向到工作区外的开发目录。命令式做法见项目既有对策 |
| ad-hoc 签名 + 首次打开被 Gatekeeper 拦 | 分发体验 | demo 阶段接受，README 写明"右键 → 打开"；正式分发才谈 Developer ID 公证 |
| 扫描误伤用户数据 | 最坏情况，信任崩塌 | 三重防线：① 默认只勾"安全"类；② 全部走废纸篓；③ 关键路径硬保护 + 逐类可展开看路径 |

### 2.6 验收标准（每阶段按 `AGENTS.md` DoD）

- **G1/G2**：`adl` 与 AOT 双端对照探针 0 差异；`examples/*.as` 可跑通且断言通过；`test/unit/` 有源级钉
  ⇒ ✅ **阶段二百四十三 已满足**（`examples/move-to-trash.as` + `unit: emit/FileMoveToTrash` 17 项）；
  偏差只剩 macOS 侧缺失「放回原处」记录（见 §2.2 注 2）
- **G4/G5/G8**：默认构建与现状**逐字节同构**（开关关闭时）；开关打开后原生实测截图；`[native-window]` 类钉子扩项
- **demo 本体**：端到端跑一遍"扫描 → 清理"，**断言目标文件确实出现在 `~/.Trash` 里**（不是断言"被删了"）
  ⇒ 这条形式的断言已在 `examples/move-to-trash.as` 里先跑通，但**回归必须把 `HOME` 指向 `temp/trash-home`**：
  macOS 的 TCC 禁止终端进程枚举/清理真实 `~/.Trash`（`Operation not permitted`，必须请 Finder 代劳），
  且测试不该往开发机的废纸篓里塞东西（`test/examples.ts` 的 `EXAMPLE_ENV` 已这么做）。
  demo 的手工验收则必须看**真** `~/.Trash`——这是本条验收不能被自动化测试代替的原因
- 全量回归：收尾必须 `node test.ts` 全绿

### 2.7 推广资产清单

- `demo/maccleaner/` 源码（AS3，可读）
- `--dry` 保留的生成 `.c`（可读 C —— 这是核心卖点，必须在 README 里给链接）
- 一张浮层面板截图 + 一张"移动 3.2 GB 到废纸篓"的完成态截图
- 构建命令一行：`node index.ts demo/maccleaner/app.as --package xcode-project` → `xcodebuild ...` → `open MacBroom.app`
- 与 Mole / kudu / mac-cleanup-py 的体积与启动对比表（实测后填）

---

## 3. 待你拍板的三件事

1. **名字**：`MacBroom` 是占位，需要定一个正式名（影响 bundle id、目录名）
2. **扫描目录白名单**：P0 是否就锁定为 `~/Library/Caches`、`~/Library/Logs`、`$TMPDIR`、`~/.Trash` 四项（我建议是，且**不碰 Downloads/Desktop/Documents**，避开 TCC）
3. **是否先做 G4 探针**：这是最大技术风险，我建议**先花一个小阶段验证菜单栏可行性**再决定要不要开整个 demo；如果探针失败，就改单窗口形态

---

## 附：GitHub 竞品速查表（2026-10-22 GitHub API 实测）

| 仓库 | ⭐ | 语言 | 许可 | 借鉴点 |
|---|---|---|---|---|
| tw93/Mole | 72,298 | Shell | GPL-3.0 | CLI 交互与安全默认值；`--dry-run`、白名单、操作日志 |
| qarmin/czkawka | 34,435 | Rust | — | 去重/相似图片引擎（**不借鉴 UI**） |
| alienator88/Pearcleaner | 14,931 | Swift | Apache-2.0 + Commons Clause | 孤儿文件匹配；Sentinel 后台哨兵（2 MB 常驻）；**维护已放缓** |
| sveinbjornt/Sloth | 8,973 | Obj-C | BSD-3 | lsof 的 GUI —— 排查"删不掉的文件" |
| momenbasel/PureMac | 7,300 | Swift | MIT | **10 级匹配引擎 + 3 档灵敏度**；FDA 授权体验；诚实契约文案 |
| bleachbit/bleachbit | 7,203 | Python | GPL-3.0 | 分类字典（Win/Linux 为主） |
| harry0703/MangoDisk | 4,522 | Rust | — | safety-first 磁盘分析 |
| AdventDevInc/kudu | 4,002 | TS | — | 跨平台清理+扫描（**解释型对照组**） |
| mac-cleanup/mac-cleanup-sh | 2,814 | Shell | MIT | 分类清单（**已废弃**，仅抄清单） |
| guhcostan/mac-cleaner-cli | 2,003 | TS | — | caches/logs/Homebrew/Xcode（**解释型对照组**） |
| iliyami/MacSai | 1,936 | Swift | — | 清理+优化+恶意软件扫描三合一 |
| vashpan/xcode-dev-cleaner | 1,618 | Swift | GPL-3.0 | 垂直单品：只清 Xcode，回收几十 GB |
| Lcharvol/MacSift | 275 | Swift | MIT | "按 app 分组 + 只移废纸篓 + 永不永久删除"的最小可信模型 |

**闭源但对标有用**：OnyX（免费，维护/重建索引）、AppCleaner（免费，Pearcleaner 的灵感来源）、DaisyDisk（付费，环形图）、GrandPerspective（GPL，treemap）。

**结论**：这个赛道不缺工具，缺的是**可信度**与**轻量**。我们的投放点就是"原生编译 + 生成可读 C"这两条别人结构上做不到的事。
