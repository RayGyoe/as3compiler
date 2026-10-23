# 文件系统（`flash.filesystem`）实测口径 —— 废纸篓与卷容量

> 本文记录 **`File.moveToTrash()` / `File.moveToTrashAsync()` / `File.spaceAvailable`** 三条成员
> 的**实测语义**与实现选择（阶段二百四十三，v0.4.207）。它们是 macOS 清理工具 demo 的前置能力
> （方案见工作区根 [`prune/mac-cleaner-demo-plan.md`](../../../prune/mac-cleaner-demo-plan.md) 的 G1 / G2）。
>
> **该方案已于 2026-10-23 移出本仓库**（原 `docs/projects/` 目录已撤），现位于工作区根 `prune/`
> （与 `asaotui/` 同级）。因此上方相对链 `../../../prune/...` **仅在本地工作区可解析**；
> 单独 clone `as3compiler` 时该链会断开（属预期，非失效）。
>
> **真值来源**：`adl 51.4.1`（macOS 26）双端探针 `temp/trashprobe/`（同一份 `Main.as` 由 `mxmlc` +
> `adl` 跑，日志写文件——`adl` 的 stdout 不出现）。所有「AIR 怎样」的断言都能在该目录里找到对应
> 探针；**没有一条是从文档转述的**，而且其中两条与官方参考不一致（见 §2.1、§5.1）。
>
> 一句话结论：**`moveToTrash` 是 `void` 而不是 `Boolean`，`spaceAvailable` 才是 AIR 的属性名
> （`getSpaceAvailable` 根本不存在）**；废纸篓目标目录按卷选择，同名冲突的名字由 macOS 自己生成。

---

## 1. 覆盖范围

| 成员 | 状态 | 说明 |
|---|---|---|
| `File.moveToTrash()` | ✅ 实现（macOS + freedesktop POSIX + Windows 回收站） | 三端后端见 §4；WASI/Emscripten 无废纸篓概念，**响亮报明**（§6） |
| `File.moveToTrashAsync()` | ✅ 实现 | 事件投递口径见 §3 |
| `File.spaceAvailable`（属性） | ✅ 已有（阶段六十四）；本轮**校正**语义 | 只对普通文件/目录作答（§5） |
| `File.getSpaceAvailable` | ❌ **AIR 没有这个成员** | 我方也不提供（`in` 为 `false`，与 `adl` 一致） |
| 卷总量 / 已用量 | ❌ 未做 | 方案里的 G3（增强，AIR 无对应物），尚未排期 |

---

## 2. `moveToTrash()` —— 实测语义

| 场景 | `adl 51.4.1` 实测 | 我方 |
|---|---|---|
| 正常文件 | 移入废纸篓；**返回 `undefined`** | 同 |
| 目录（带子件） | 整棵子树一起移入 | 同（`rename` 原子搬移） |
| 路径不存在 | 抛 `Error #3003: File or directory does not exist.` | 同（同号同文案） |
| 父目录不可写（EPERM） | 抛 `Error #2038: File I/O Error.` | 同 |
| `new File()`（无 `nativePath`） | 抛 `Error #2037: Functions called in incorrect sequence, …` | 同 |
| 成功之后 | `nativePath` **不变**、`exists` 变 `false`（**不**改写成废纸篓路径） | 同 |
| 已在废纸篓目录里的项 | 成功的 **no-op**（项原地不动） | 同 |
| 同名冲突（废纸篓里已有同名） | 名字变成 `原名 <HH-MM-SS-mmm><扩展名>`，例：`x.txt` → `x.txt 18-34-09-271.txt`、目录 `dupsub` → `dupsub 18-37-21-029` | 同（同一形状，见 §2.2） |

### 2.1 与官方参考不一致的第一处：返回类型

AIR 语言参考把 `moveToTrash()` 写作 `Boolean`，但 51.4.1 的**编译器与运行时都按 `void`**：

```as3
var s:String = x.moveToTrash().toString();
// mxmlc: 错误: 通过静态类型为 void 的引用来调用的方法 toString 可能未定义。
trace(x.moveToTrash());              // adl: undefined（不是 false）
```

⇒ 我们的 `File_moveToTrash` 签名是 `void`。**不要**为了「更友好」返回 `true`：那会让
`if (f.moveToTrash())` 在 `adl` 恒假、在我们这里恒真，属静默语义分叉。

### 2.2 与官方参考不一致的第二处：冲突命名

参考文档只说「移到废纸篓」，没有任何命名规则。实测发现 macOS 的规则是
**保留整个原名（含扩展名）+ 一个空格 + 本地时间 `HH-MM-SS-mmm` + 扩展名再来一次**：

- 文件 `as3probe-…-same.txt` → `as3probe-…-same.txt 18-34-09-271.txt`
- 目录 `dupsub` → `dupsub 18-37-21-029`（目录没有扩展名，所以不重复）

我们的实现照抄这个形状（`as_trash_target`）。第二次冲突（同一毫秒）追加 `-<n>` 兜底，这一层
**没有实测参照**——同一毫秒内两次撞名的概率可以忽略，此处选择「不失败」而非「精确复刻」。

---

## 3. `moveToTrashAsync()` —— 事件而非异常

| 场景 | `adl 51.4.1` 实测 | 我方 |
|---|---|---|
| 正常文件 | 立即返回，稍后派发 `Event.COMPLETE`（`target` 是那个 `File`） | 派发 `COMPLETE`（投递时机见下） |
| 路径不存在 | **不抛异常**，派发 `IOErrorEvent`：`errorID=3003`、`text="Error #3003: …"`、`bubbles=false`、`cancelable=false` | 同（`errorID` 一并写入） |
| `new File()` | **同步抛** `#2037`（和同步版一致） | 同 |

**投递时机**：AIR 在自己的 IO 线程上完成并异步派发（实测「调用后立刻检查 `exists` 仍为 `true`」）；
本构建 **inline 完成 + 同一次调用内派发**，与 `File` 其余 async 成员（`getDirectoryListingAsync` /
`deleteFileAsync` / `deleteDirectoryAsync`）**同一口径**。调用方唯一能依赖的顺序——「先
`addEventListener` 再发起」——在两端都成立。

---

## 4. 废纸篓目录怎么选

| 平台 | 目录 | 依据 |
|---|---|---|
| macOS | 与 `$HOME` **同卷**：`~/.Trash`；**其他卷**：`<卷挂载点>/.Trashes/<uid>` | 实测：`~/.Trash` 里出现了被搬走的项（Finder 可见、可还原）；`<卷>/.Trashes/<uid>` 是 Finder / `NSFileManager` 的布局 |
| Linux 等 POSIX | `$XDG_DATA_HOME/Trash`（缺省 `~/.local/share/Trash`）下的 `files/` + `info/`，每个载荷在 `info/` 里配一个 `.trashinfo`（`Path=` 百分号转义 + `DeletionDate=`） | freedesktop.org 的 Trash 规范（**未在真机验证**，本机是 macOS） |
| Windows | **回收站**：`SHFileOperationW` + `FOF_ALLOWUNDO`（即资源管理器「删除」走的同一条路：进 `C:\$Recycle.Bin\<SID>\`，可在「回收站」里还原） | 实测 `adl 51.4.1` **Windows 真机**（`temp/trashwin/` 双端探针）：普通文件、**目录连同子项**、异步式三条路径全部落进回收站；`$I` 副档里存着**原路径**（UTF-16LE）、`$R` 载荷内容读回一致；失败号与 macOS 同为 `#3003`/`#2037`。**Windows 没有「废纸篓目录」可搬**（回收站是 shell 拥有的存储），故 `as_trash_dir` 的 `_WIN32` 分支保持 `NULL` 桩，而由 `as_trash_move` 在它之前先转到 `as_trash_move_shell`（路径按 `CP_ACP` 转宽字符、列表**双 NUL** 结尾，与 runtime 其余 ANSI 调用同口径）；链接层因此给 Windows 构建补上 `shell32` |
| WASI / Emscripten | 无废纸篓概念 | 报明（`as_shell_unsupported`）+ 抛 `#2038` |

「同卷判定」用 `st_dev` 比较实现（`as_trash_dir`）；**其他卷的挂载点**用「逐级上升直到 `st_dev`
变化」求得（`as_volume_root`）——POSIX 没有可移植的「我在哪个挂载点」调用，而这条路在 APFS
firmlink（`/Users` 与 `/` 同 `st_dev`）与真正的独立卷（`/Volumes/Ext` 与 `/Volumes` 不同）两种
情形下都给出了正确结果。

> **已知取舍**：Finder 的「放回原处」（Put Back）靠卷上的元数据，我们只做 `rename`，所以
> **项能出现在废纸篓、能还原到任意位置，但没有 Finder 的一键「放回原处」记录**。这是纯 C 实现的
> 边界，写在前面而不是等用户发现。

---

## 5. `spaceAvailable` —— 属性名与作用域

### 5.1 AIR 的属性名是 `spaceAvailable`，不是 `getSpaceAvailable`

方案文档把 G2 记作「`getSpaceAvailable` 零实现」，**这条记录本身是错的**：AIR 的 `File` 上

```as3
("getSpaceAvailable" in f)   // adl: false
f["getSpaceAvailable"]       // adl: ReferenceError #1069
```

而 `f.spaceAvailable` 从阶段六十四起就已在 `src/{symbols,emit}.ts` 里落地（真实 `statvfs` /
`GetDiskFreeSpaceExA` 查询）。本轮因此**没有新增成员**，只校正了它的作用域语义。

### 5.2 实测值

| 路径 | `adl 51.4.1` | 我方 |
|---|---|---|
| `File.userDirectory` / 某个目录 | 卷的可用字节数（实测 `14487470080`，与 `df -k` 同一量级、随系统活动每秒变化） | 同（`statvfs.f_bavail × f_frsize`） |
| 普通文件 | **同一数字**（跟随文件所在卷） | 同（本轮新增：文件也作答） |
| 不存在的路径 | `0` | 同（`statvfs` 失败） |
| 字符设备（`/dev/null`） | `0` | 同（先 `stat`，只对**普通文件/目录**作答） |
| `/Volumes/Nope`（不存在） | `0` | 同 |
| `new File()`（无路径） | 抛 `#2037` | 同（空指针路径直接回 `0`… 见下注） |

> 注：`new File().spaceAvailable` 在 `adl` 抛 `#2037`；我们的 `File_get_spaceAvailable` 对
> `nativePath == NULL` 返回 `0`（阶段六十四 起如此）。**这不是 `spaceAvailable` 独有**：51.4.1 上
> 空 `File` 的**每一个**成员都抛 `#2037`（连 `nativePath` getter 本身都抛，而我们那里是普通字段）。
> 这条族级缺口比单个成员大——要修得先把 `nativePath` 变成访问器——因此登记在 `TODO.md`
> 的 `遗留待开发`，本轮不半修。本轮新增的两个成员**是**抛 `#2037` 的（实测，见 §2）。

---

## 6. 没做的部分（如实登记）

- **WASI / Emscripten 的废纸篓**：无对应 API，调用响亮报明并抛 `#2038`。浏览器没有「回收站」这个概念，**响亮报明即为终态**（不做假后端）。Windows 回收站后端已于阶段二百四十四 落地（§4）。
- **Finder「放回原处」元数据**：见 §4 取舍。
- **跨卷搬运**：目标目录与源同卷（`as_trash_dir` 按卷选目录），因此 `rename` 不会跨卷；
  真跨卷时抛 `#2038` 而不是「复制 + 删除」——后者在演示规模下会看起来卡住，且失败点更多。
- **卷总量 / 已用量**（方案 G3）：未做。
- **`spaceAvailable` 对空 `File` 的 `#2037`**：见 §5.2 注（族级缺口，已入 `遗留待开发`）。

---

## 7. 复现

```sh
# adl 侧（探针在 temp/trashprobe/，日志写 adl_log*.txt；adl 的 stdout 不可用）
cd temp/trashprobe && "$AIRSDK_HOME/bin/mxmlc" -debug=true -output Main.swf Main.as
"$AIRSDK_HOME/bin/adl" app.xml

# AOT 侧（HOME 指到一次性目录，别把开发机的废纸篓当试验场）
mkdir -p temp/trash-home && HOME=$PWD/temp/trash-home \
  node src/index.ts examples/move-to-trash.as -o temp/regress-out/mvtrash --run

# 纯 C 助手的行为（含 freedesktop 分支，用 -U__APPLE__ 强制走 #else）
cd temp/trashprobe && cc -O1 -Wall -Wextra -o trash_impl trash_impl.c && HOME=/tmp/x ./trash_impl
```

钉子：`unit: emit/FileMoveToTrash`（17 项，源级）；`examples/move-to-trash.as`（运行时，
由 `test/examples.ts` 的 `EXAMPLE_ENV` 把 `HOME` 指到 `temp/trash-home`，避免污染开发机的废纸篓）。