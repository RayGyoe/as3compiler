# 文件系统（`flash.filesystem`）实测口径 —— 废纸篓、卷容量与软链谓词

> 本文记录 **`File.moveToTrash()` / `File.moveToTrashAsync()` / `File.spaceAvailable` /
> `File.isSymbolicLink`** 四条成员
> 的**实测语义**与实现选择（阶段二百四十三，v0.4.207；`isSymbolicLink` 为阶段二百六十二）。它们是 macOS 清理工具 demo 的前置能力
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
> （`getSpaceAvailable` 根本不存在），而 `isSymbolicLink` 是 `File` 谓词里唯一 `lstat` 的那个
> （不跟随链接）**；废纸篓目标目录按卷选择，同名冲突的名字由 macOS 自己生成。

---

## 1. 覆盖范围

| 成员 | 状态 | 说明 |
|---|---|---|
| `File.moveToTrash()` | ✅ 实现（macOS + freedesktop POSIX + Windows 回收站） | 三端后端见 §4；WASI/Emscripten 无废纸篓概念，**响亮报明**（§7） |
| `File.moveToTrashAsync()` | ✅ 实现 | 事件投递口径见 §3 |
| `File.spaceAvailable`（属性） | ✅ 已有（阶段六十四）；本轮**校正**语义 | 只对普通文件/目录作答（§5） |
| `File.isSymbolicLink`（属性） | ✅ 实现（阶段二百六十二） | `lstat`/`FILE_ATTRIBUTE_REPARSE_POINT`，**唯一不跟随链接**的谓词（§6） |
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

**投递时机**：AIR 在自己的 IO 线程上完成并异步派发（实测「调用后立刻检查 `exists` 仍为 `true`」）；本构建的 `moveToTrashAsync` / `deleteFileAsync` / `deleteDirectoryAsync` 仍是 **inline 完成 + 同一次调用内派发**（登记在 `遗留待开发`），而 **`getDirectoryListingAsync` 已经是真异步**（枚举在作业池的 worker 线程上跑、帧边界派发，见 §7）。调用方唯一能依赖的顺序——「先
`addEventListener` 再发起」——在两端都成立，但「调用返回时事件还没到」这条**只有 `getDirectoryListingAsync` 成立**。

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

## 6. `isSymbolicLink` —— `File` 谓词里唯一不跟随链接的那个

**它不是从参考文档抄的，是被一个真实产品逼出来的。** 工作区根的 `prune`（净扫，
macOS 缓存清理器）用 `getDirectoryListing()` + `isDirectory` 递归计量 `~/Library/Caches`，
面板上算出 **124 GB**，而同一目录 `du` 是 **7.6 GB**（差 16 倍）：该目录下有一份微信的
Sparkle 安装包，里面塞着 `WeChatAppEx.app` 与一串 `.framework/Versions/Current`、
`.framework/Resources` —— **全是指向兄弟目录的软链**，递归进去同一批字节被逐层重复计入。
`du` 默认不跟随软链，我们跟随了，而当时 `File` 根本没有能问出「这是不是软链」的成员。

根因是 `File` 的谓词分两类，混用就会得到错的量级：

| 谓词 | 跟随链接？ | 回答的是 |
|---|---|---|
| `exists` / `isDirectory` / `size` / `spaceAvailable` | 是（`stat()`） | **目标** |
| `isSymbolicLink` | **否（`lstat()`）** | **链接本身** |

所以「指向目录的软链」`isDirectory` 与 `isSymbolicLink` **同时为真**；「悬空软链」
`exists == false` 而 `isSymbolicLink == true`；删它删的是链接而不是目标（AIR 明确如此）。

### 6.1 `adl 51.4.1` 实测（探针 `temp/symprobe/`）

一侧 `mxmlc` + `adl`，一侧本项目 AOT，同一份输入（`fx/` 里造真目录 / 真文件 /
软链→目录 / 软链→文件 / 悬空软链 / 成环软链）：

| 输入 | `exists` | `isDirectory` | `isSymbolicLink` |
|---|---|---|---|
| 真目录 | true | true | false |
| 真文件 | true | false | false |
| 软链 → 目录 | true | **true** | **true** |
| 软链 → 文件 | true | false | **true** |
| 悬空软链 | **false** | false | **true** |
| 不存在的路径 | false | false | false |
| `/`（卷根） | true | true | false |
| `new File()`（空） | **抛 `#2037`** | 同左 | 同左 |

**10/10 两端口径一致**（除空 `File` 那条，见 §6.2）。实现：POSIX 走 `lstat()` + `S_ISLNK`；
Windows 走 `GetFileAttributesA()` 的 `FILE_ATTRIBUTE_REPARSE_POINT`（AIR 对 NTFS junction 也报
`true`，这个位正好覆盖，而 MSVC 的 `_stat` 认不出重解析点）。

### 6.2 顺带量到的，是**既有**缺口而不是新缺口

空 `File`（`new File()`）的 `#2037` 在 `isSymbolicLink` 上同样成立 ⇒ 它并入 `遗留待开发` 里
已有的那行「**空 `File`（`new File()`）的成员访问全线不抛 `#2037`**」，**不新开一行**：
族级修法是先把 `nativePath` 从字段改成访问器，与本条无关。

### 6.3 遍历里该怎么用

`isSymbolicLink` 是**遍历的边界条件**，不是装饰：不判它，同一棵子树会被逐层重复计入，
节点预算全烧在一个目标上，而报表给出的是**错的量级**（本机上 `~/Library/Caches` 从 7.6 GB
虚报成 124 GB，并且后面的目标一个都没扫到）。产品侧的正确写法是**先判它，再决定要不要下潜**。

一个诚实的细节：**深度不会被无限拉长**——macOS 内核自己的 ELOOP 上限（32 层链接）会把
含环的路径斩断，所以「跟随软链的遍历会挂死」这个说法是错的。**重复计数才是真的**：
`examples/file-symlink.as` 的夹具是一棵只有 **4 个真节点 / 8 字节**的树（含 4 个链接，
其中一个指回祖先），跟随软链走一遍实测会访问 **264 个节点**（且不是被我们设的节点上限截断的，
是内核截断的）——这正是「挂死」之外更阴险的那一半：它跑得很快，只是数目是错的。

---

## 7. 目录列举 —— 同步/异步两套口径（阶段二百六十四）

`getDirectoryListing()` 与 `getDirectoryListingAsync()` **不是同一个语义的两种写法**：同一个输入，
一个抛异常、一个正常完成。全部口径逐条对 `adl 51.4.1` 实测（探针 `temp/listingprobe/`、
`temp/dirasync/`），本构建照抄；示例 [`examples/file-listing-async.as`](../examples/file-listing-async.as)
把它们逐条钉成断言。

### 7.1 异步：真异步（本阶段之前是同步假实现）

`adl` 上这个成员在**自己的 IO 线程**上枚举、在**稍后**派发 `FileListEvent.DIRECTORY_LISTING`。
实测口径：

| 观测 | `adl 51.4.1` | 本构建 |
|---|---|---|
| 2 万条目目录的**调用耗时** | **0 ms**（事件约 **10.6 s** 后才到） | 同（枚举在 `AS_JOB_DIR` 作业里） |
| 调用之后才注册的监听器 | **收得到** | 同 |
| 事件形状 | `type=directoryListing`、`files=File[]`、`bubbles=false`、`cancelable=false`、`target` 是该 `File` | 同 |
| 路径不存在 | 派 `IOErrorEvent`：`errorID=3003` + `"Error #3003: File or directory does not exist."`（**不抛**） | 同 |
| 路径**存在但不是目录** | **正常完成，`files` 为空表，无错误** | 同 |
| 目录**不可读**（EACCES） | **正常完成，空表，无错误** | 同 |
| `cancel()` | **真的取消**：不再派任何事件 | 同 |
| 上一次还在飞时再调 | **抛 `#2037`**，且第一次仍会完成 | 同 |
| 空 `File`（`new File()`） | **同步抛 `#2037`** | 同 |
| 抵达顺序 | 与同步成员**同序**（都是目录原始序，**两端都不排序**） | 同 |

> 之前本构建是「`getDirectoryListing()` + 同一次调用内派发」的**同步假实现**：调用线程要付完
> 整个遍历的代价，且 `File.cancel()` 恒为 no-op。这属 §1.5「`adl` 跑得对而我们跑不出」⇒
> **遗留缺陷**，阶段二百六十四 修净（`AS_JOB_DIR` 作业 + 完成 thunk + 真 `cancel`）。

### 7.2 同步：三种异常输入全抛，且与异步**故意不共用一个实现**

| 输入 | `getDirectoryListing()`（同步） | `getDirectoryListingAsync()`（异步） |
|---|---|---|
| 空 `File` | 抛 `#2037` | 抛 `#2037`（同号同文案） |
| 路径不存在 | 抛 `#3003` | 派 `ioError #3003`，**不抛** |
| 存在但不是目录 | 抛 **`#3007: Not a directory.`** | **空表完成，无错误** |
| 目录不可读（EACCES） | **空表，不抛** | **空表完成，无错误** |

最后一行是唯一「两边都不抛」的怪形状，也是清理类程序**最常**遇到的形状：权限拒绝**不是**失败，
它就是一个空目录——把它当失败会让「跳过的目录数」虚高，把它当成功则与 `adl` 一致。

### 7.3 `FileListEvent` 的成员面（顺带实测）

`describeType(INSTANCE)` 实测：`extends=flash.events::Event`，实例 **var 只有 `files`**；
**没有 `directory`、没有 `index`**。本构建的壳多声明了一个第四形参（`directory`），
是已登记的口径差（见 `遗留待开发` 的 arity 行），故完成 thunk 仍把接收者传在第四位、`files` 保持
`adl` 的位置。

---

## 8. 没做的部分（如实登记）

- **WASI / Emscripten 的废纸篓**：无对应 API，调用响亮报明并抛 `#2038`。浏览器没有「回收站」这个概念，**响亮报明即为终态**（不做假后端）。Windows 回收站后端已于阶段二百四十四 落地（§4）。
- **Finder「放回原处」元数据**：见 §4 取舍。
- **跨卷搬运**：目标目录与源同卷（`as_trash_dir` 按卷选目录），因此 `rename` 不会跨卷；
  真跨卷时抛 `#2038` 而不是「复制 + 删除」——后者在演示规模下会看起来卡住，且失败点更多。
- **卷总量 / 已用量**（方案 G3）：未做。
- **`spaceAvailable` 对空 `File` 的 `#2037`**：见 §5.2 注（族级缺口，已入 `遗留待开发`）。
- **`File` 其余三个 async 成员的投递时机**：见 §3（仍是 inline，已入 `遗留待开发`）。

---

## 9. 复现

```sh
# 目录列举的 adl 口径（探针在 temp/listingprobe/ 与 temp/dirasync/，日志写 .txt）
cd temp/dirasync && "$AIRSDK_HOME/bin/mxmlc" -load-config="$AIRSDK_HOME/frameworks/air-config.xml" \
  -output Probe4.swf Probe4.as && "$AIRSDK_HOME/bin/adl" app4.xml

# AOT 侧（夹具由 test/examples.ts 现造；noread/ 是 chmod 000 的不可读目录）
node --test --test-name-pattern='file-listing-async' test/examples.ts
```

## 10. 早期实现的 adl 复现（废纸篓）

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

钉子：`unit: emit/FileMoveToTrash`（17 项，源级）；`unit: emit/FileIsSymbolicLink`（7 项，源级）；
`unit: emit/DirListingAsync`（17 项，源级）；`examples/move-to-trash.as`、`examples/file-symlink.as`、
`examples/file-listing-async.as`（运行时，由 `test/examples.ts` 的 `EXAMPLE_ENV` 把 `HOME` 分别指到
`temp/trash-home`、`temp/sym-home`、`temp/listing-home`，避免污染开发机的废纸篓；软链与目录列举
两套夹具都由该文件用 `node:fs` 现造，其中 `noread/` 的 `chmod 000` 在套件收尾时改回）。
---

## 11. `File.url` 是 URL，不是路径（阶段二百八十四）

> 真值来源：`adl 51.4.1`（Windows 10 26200）双端探针 `temp/urlprobe/`。同一份
> `UrlProbeTop.as` 由 `mxmlc`+`adl` 与我们的 AOT 各跑一遍，日志写文件（`adl` 的 stdout
> 不可用）；AIR 侧结果落在 `%APPDATA%/probe.url/Local Store/urlprobe-result.txt`，AOT 侧落在
> 包内同名文件。**下表每一行都是实测值**，不是从参考文档转述的。

### 11.1 实测形状

| 表达式 | `adl 51.4.1` | 我方（修复后） |
|---|---|---|
| `File.applicationStorageDirectory.url` | `app-storage:/` | 同 |
| `File.applicationDirectory.url` | `app:/` | 同 |
| `<storage>/urlprobe/plain.png` 的 `.url` | `app-storage:/urlprobe/plain.png` | 同 |
| `<storage>/a b/中文 name.png` 的 `.url` | `app-storage:/a%20b/%E4%B8%AD%E6%96%87%20name.png` | 同 |
| `File.documentsDirectory.url` | `file:///C:/Users/<u>/Documents` | 同 |
| `new File(<上面那个 url>).nativePath` | 原生路径（反斜杠） | 同 |
| `Loader.load(<那个 url>)` | `COMPLETE`，`content` 是 `Bitmap` | 同 |
| `new File("relative.txt")` | 抛 `Error #2004` | **保留字符串**（见 §11.5 偏差） |

**编码规则**（逐字符实测）：路径部分用 `encodeURIComponent` 的安全集，另加两个字符——
`/`（分隔符，保留）与 `:`（盘符，保留）。实测被编码：空格 `%20`、`#` `?` `&` `%` `+`
`[` `]` `@` `$` `,` `;` `=` `^` `{` `}` `|` `<` `>` `"`，以及每个非 ASCII 字节的
UTF-8 三元组；实测**不**编码：字母、数字、`- _ . ! ~ * ' ( )`。

**nativePath 的拼写**：AIR 用宿主 OS 自己的形态——Windows 全反斜杠。我们的 `as_path_join`
过去无条件用 `/`，于是绝对路径成了混排（`C:\Users\u\AppData\Roaming/as3aot/Local Store`），
也让「url → `new File(url).nativePath`」与原始路径不相等。现在 `as_path_join` 统一过
`as_path_norm()`（Windows 把 `/` 换 `\`，其余平台原样返回），一处收口，顺带把
`FindFirstFile` 之前需要就地换分隔符的补丁变成多余。

### 11.2 修复前的形状，就是那个 bug

`File_get_url` 曾返回 `"file://" + nativePath`，即
`file://C:\Users\rayle\AppData\Roaming/cn.edoctor.windows.meeting.talkmed/Local Store/assets/cache//<hash>/x.png`
（反斜杠、未编码、还带 `//`）。这个字符串随后被**当作字面路径** `fopen`：

- `Loader.load(那个 url)` → `IOError #2035 URL Not Found`（文件确实存在）；
- 同一个文件按 `nativePath` 加载却能走到解码器（纯 C 构建报 `#2124`，Skia 构建出图）。

于是「下载进 `applicationStorageDirectory`，再按 `File.url` 显示」这一族用法全线空白。
真机上就是 **TalkMED 的礼物列表**：JSON 里的 `small_img` 由 `DownLoader` 下到存储目录，
`cn.edoctor.controls.Image` 里 `loader.load(download.targetFile['url'])` —— 每个礼物图标都只剩
标题文字。

修法不是「在 Loader 里再 strip 一次 scheme」，而是**把映射收成唯一一处**：

| 位置 | 之前 | 现在 |
|---|---|---|
| `File_get_url` | `"file://" + nativePath` | 两个 app 根各自成 scheme（`app-storage:`/`app:`），其余 `file:///` + 百分号编码 |
| `File_ctor` | 原样存储 | 认 URL：`file://`/`app-storage:`/`app:` 先解码回原生路径 |
| `URLLoader_load`（`Loader.load` 共用） | `if (strncmp(path,"file://",7)==0) path += 7;` | `as_local_path_from_url(url)` |
| `Sound_load` | 同上 | 同上 |
| 图像 job（`as_async_submit_image`） | 原样当路径 `fopen` | 远端（http/https）走传输，其余先 `as_local_path_from_url` |

`as_local_path_from_url()` 是唯一的 scheme→路径转换点：`app-storage:/x`、`app:/x` 各拼回
对应根，`file:///C:/x` 的第 3 个斜杠属于 URL 不属于路径，其余字符串（绝对或相对原生路径）
原样透传。它定义在 `File` 一侧（需要两个根），`runtime.ts` 里的图像 job 通过前置声明使用它。

### 11.3 为什么不缓存根路径

`as_app_storage_dir()` 每次读都重新问，不缓存进 `static`：它返回的是 **GC 字符串**，而普通 C
静态变量不是 GC 根 —— 缓存下来的前缀可能被回收器释放，下一次比较就是悬空读。

### 11.4 复现

```sh
# adl 侧（结果写 %APPDATA%/probe.url/Local Store/urlprobe-result.txt）
node temp/urlprobe/run-air.cjs

# AOT 侧（Skia 清单，才能真正解码出 Bitmap；纯 C 构建只会到 #2124）
PATH="$PWD/temp/ccbin:$PATH" node src/index.ts temp/urlprobe/UrlProbeTop.as \
  -o temp/urlprobe/UrlProbeSkia.exe --manifest temp/urlprobe/win.build.json
temp/urlprobe/UrlProbeSkia.exe
```

两侧三行 `load(...)` 都必须是 `COMPLETE content=[object Bitmap] w=8`。

**回归钉**：`examples/file-url.as`（形状、编码、往返、把 URL 当句柄真读一个文件、以及 §11.5
的偏差）；`unit: file-url/mapping` + `unit: file-url/preamble`（16 条源级结构钉，其中
「不再有 `path += 7`」是防漂移的那一条）。

### 11.5 唯一保留的偏差：相对路径

AIR 在构造器里就拒绝相对路径（`#2004`）。我们保留字符串（`stage64.as` 自阶段六十四起就钉着
`new File("temp/x.txt").nativePath == "temp/x.txt"`），因此这种 File 的 `url` 是
`file://` + 路径。AIR 造不出这个对象，所以这不是「我们对 AIR 已有行为的改写」，而是**AIR
没有对应物**的那一类；它同时是 `examples/file-url.as` 的一条显式断言，不是为了好看。

### 11.6 Windows 宿主上的实测差异（阶段三百）

阶段二百九十八 / 二百九十九 的行为都是在 macOS 的 `adl` 上量的，而 `File` 家族几乎每个成员
都碰宿主路径规则。补测（`adl 51.4.1` / Windows 10 19045，探针 `temp/winfile/adl/`，读数
`adl-win{,2,3}.txt`）分出六处**宿主分叉**，均已按实测落地：

| 面 | Windows 实测 | 修前 |
|---|---|---|
| `File.cacheDirectory` | **操作系统临时目录**（`%TEMP%\`，与 `File.createTempFile` 同根） | `%LOCALAPPDATA%\Caches`（把 macOS 的 `~/Library/Caches` 布局外推） |
| 盘符相对路径 `C:foo` | 原样保留盘符后的文本并**补一个分隔符** ⇒ `C:foo\`；`C:.` ⇒ `C:.\`、`C:..` ⇒ `C:..\` | 按「盘符 + 组件」解析 ⇒ `C:\foo`（**另一个文件**），且 `..` 会把整串弹空 |
| `parent` | `C:\a` ⇒ `C:\`（**根保留自己的分隔符**）、`\a` ⇒ `\`、`C:\` ⇒ `null` | `C:\a` ⇒ `C:`（盘符相对形式，语义不同）、`\a` ⇒ `/`（换成 POSIX 分隔符） |
| `getRelativePath` | 答案用**正斜杠**；两端根不同（跨盘）⇒ `null`；大小写敏感 | 只认 `/`，且不比较根 ⇒ 跨盘给出无意义的相对串 |
| `copyTo` / `moveTo` 的「同一文件」判定 | 大小写**不**敏感（`a.txt` 与 `A.TXT` 是同一文件） | `strcmp` ⇒ 判成「不同目标」，覆盖分支先 `DELETE` 掉目标（**就是源**）再复制 ⇒ `#3003` 且文件已毁 |
| `FileStream` 偏移 | 走 **64 位**（`_ftelli64`/`_fseeki64`）；`APPEND` 打开即 EOF（`position == size`） | 32 位 `ftell`/`fseek`（>2 GB 时 `position` 转负，再交给 `_chsize_s`）；`APPEND` 打开在 0（MSVC 的 `"ab"` 只在首次**写**时 seek） |

两条**只有 Windows 才会撞到**的补充：

- **删掉一个仍被 `FileStream` 打开的文件会失败**（`#2038`）。POSIX 允许 `unlink` 打开中的文件，
  Windows 不允许 —— `adl` 在 Windows 上同样报这个错，所以这不是偏差，而是我们自己的示例写错了
  （`examples/file-audit.as` 的 READ 流从未 `close()`，收尾删目录必然失败）。示例已改为显式
  `close()`。
- `getRootDirectories()` 在 Windows 交出的是 **8 个 `File`**（不是 `StorageVolume`；`as StorageVolume`
  得 `null`）。`StorageVolume` 只能从 `StorageVolumeChangeEvent` 里拿到，而 Windows 上插拔卷并不
  派发该事件（`adl` 实测未触发），故这条路径在本后端是**数据类**而不是能力。


---

## 12. 删除 / 移动 / `size` / 路径归一化 —— A 批实测（阶段二百九十八）

阶段二百九十（`ContextMenu` 的 Windows 实测）之后，对 `File` 家族做了一次**逐成员**的缺口审计
（`temp/fileaudit/matrix.sh`：每个成员一条编译探针，量「有没有」；`temp/fileaudit/adl/Fp.as` +
`out.txt`、`Av.as`/`Av2.as`/`Av3.as` + `av*.txt`：量「对不对」）。审计按成本分 A/B/C 三批，
本文这一节是 **A 批**（低成本、真实世界最容易踩到的语义差）的口径与落地。B 批（`FileStream` 的
`IDataInput`/`IDataOutput` 全表）与 C 批（新能力：`copyTo`/`canonicalize`/`getRelativePath`/
`FileReference`/`StorageVolume`）当时**未做**，其后由阶段二百九十九 落地，见本文 §13。

### 12.1 错误表（同步成员，`adl 51.4.1` / macOS 26 实测）

| 调用 | 实测结果 |
|---|---|
| `deleteFile()` 路径不存在 | `Error #3003: File or directory does not exist.` |
| `deleteFile()` 目标是**真实目录** | `Error #3006: Not a file.`（目录**保留**） |
| `deleteFile()` 目标是被拒的父目录下的项 | `Error #3001: File or directory access denied.` |
| `deleteDirectory()` 路径不存在 | `#3003` |
| `deleteDirectory()` 目标是文件 | `Error #3007: Not a directory.` |
| `deleteDirectory(false)` 目录非空 | `Error #3010: Directory is not empty.`（目录**保留**） |
| `deleteDirectory(true)` 目标是**文件** | **成功**——`recursive` 的含义是「递归」，不是「必须是目录」 |
| `deleteDirectory(true)` 被拒 | `Error #2038: File I/O Error.` |
| `moveTo(dest)` 源不存在 | `#3003` |
| `moveTo(dest, false)` 且 `dest` 已存在 | `Error #3012: Cannot delete file or directory.`（目标**不动**） |
| `moveTo(null)` | `TypeError #2007`，消息是 **`Error #2007: Parameter destination must be non-null.`** |
| `moveTo` 的父目录不存在 | **自动创建**（`mkdir -p` 语义） |
| `moveTo` 成功后接收者 | **`nativePath` 不变**（仍指旧位置，`exists` 转 `false`）——两次独立实测 |
| `moveTo` 写目标时是目录 | `overwrite=true` 时**整个目录被文件替换** |
| 空 `File`（`new File(null)`）调以上任一 | `#2037` |
| `size` 路径不存在 | `#3003`（**旧实现返回 0 是错的**，`symbols.ts` 里那条注释已删） |
| `size` 是目录 | **`0`**（不是 `st_size`） |
| `size` 是悬空软链 | `#3003` |

**软链**：`deleteFile`/`deleteDirectory`/`moveTo` 都只动**链接本身**，目标原样保留；**悬空链接
可以删**；`deleteDirectory(link→dir, true)` 删链接**不递归进目标**。所以删除路径的存在性判定
必须是 **`lstat`**（`as_path_exists_l`），不能用 `stat`——否则「软链指向目录」会走进递归分支，
把目标树删掉。Windows 走 `GetFileAttributesA`（不跟随 reparse point）。

**归位**：这三条同步成员共用 `as_file_delete_err(o, isDir, recursive)`，异步成员共用同一份结果
再经 `File__deleteDispatch` 派发（`errorID` 与同步**完全一致**：`deleteFileAsync(目录)`=3006、
`deleteDirectoryAsync(false)` 非空=3010、缺失=3003；成功派 `COMPLETE`；`#2037` 仍**同步抛出**）。
这正是 A 批要修的原始 bug——`deleteDirectoryAsync(true)` 原先**什么都没删就派了 `COMPLETE`**。

**仍未做**：跨卷 `moveTo` 走 `rename` 会失败，此时**响亮报明**「a cross-volume move is not
implemented」（不静默 no-op，也不做「复制+删除」的静默替代）。

### 12.2 路径归一化是**词法**的，两个平台都做

实测（`av.txt` 的 `E*`/`F*`/`G*` 组）：

| 输入 | `nativePath` |
|---|---|
| `/tmp//a/../b` | `/tmp/b` |
| `/tmp/a/./b/` | `/tmp/a/b`（末尾分隔符丢弃） |
| `/tmp/a/../../..` | `/`（**在根处夹紧**，不产生 `/..`） |
| `//tmp` | `/tmp` |
| `/tmp/a\b`（POSIX） | `/tmp/a\b` —— **反斜杠是合法文件名字节**，不是分隔符 |

`resolvePath` 走同一套规则，另加两条：**绝对路径参数替换 base**（`"/tmp/z.txt"` 的
`resolvePath("/abs/./q")` = `/abs/q`），`""`/`"."` 返回 base 本身，`"~/x"` **不展开**（基名
`~` 照抄）。Windows 侧的 `as_path_norm` 另有盘符/UNC/设备路径（`\\?\`、`\\.\`）分支，**设备
路径原样透传**（前缀有语义，不能折叠）。

`url` 的 setter 不存在（AIR 也没有），`nativePath` 的 **setter** 则是本阶段新补的，且按实测：
相对路径/空串/URL 形式 ⇒ `#2004`，`null` ⇒ `#2007`（消息与 `moveTo` 同样带**双空格**：
`Error #2007: Parameter  must be non-null.` —— 参数名是空串）。**构造器仍接受相对路径**（见
§11.5 的既有偏差），故这条只在 setter 上生效。

### 12.3 复现

```sh
# adl 侧（探针在 temp/fileaudit/adl/，日志写绝对路径的 av*.txt —— adl 的 stdout 不出现）
#   mxmlc + adl 各跑一遍 Av.as / Av2.as / Av3.as / Aw.as

# AOT 侧（同一批用例的脚本形态，日志直接走 stdout）
node src/index.ts temp/fileaudit/aot/probe.as  -o temp/fileaudit/aot/probe  --run
node src/index.ts temp/fileaudit/aot/probe2.as -o temp/fileaudit/aot/probe2 --run
```

两侧逐行相同（`probe.as` 覆盖 E/F/G/A/B/C/D 七组，`probe2.as` 覆盖软链 K/N 组与权限 L 组；
夹具由 shell 现造，`L` 组要 `chmod 0555`）。**回归钉**：`examples/file-ops.as`（把上面的表逐条
钉成断言，`test/examples.ts` 给它一个 `HOME` 夹具目录 + `fx/` 子树，含 `linkdir`/`dangle` 两种
链接）；`unit: file-ops/contract`（30 条源级结构钉：`moveTo` 的两个参数、同步/异步共用
`as_file_delete_err`、`COMPLETE` 只在 `err == 0` 时派发、`#3010` 由 `ENOTEMPTY` 映射、
`lstat` 而非 `stat`、`moveTo` 不改 `nativePath`）。

---

## 13. `FileStream` 的 `IDataInput`/`IDataOutput` 与 `File` 剩余成员 —— B/C 批实测（阶段二百九十九）

A 批（§12）之后接着做 B 批与 C 批。**每一条都先在 `adl 51.4.1`（macOS 26）上量出结果，再写 C**：
探针 `temp/fileaudit2/AF.as` → `af.txt`（`FileStream` 全表 + `File` 剩余成员）、`AG.as` → `ag.txt`
（`canonicalize`）、`AH.as` → `ah.txt`（`FileReferenceList`）。行为回归是 `examples/file-audit.as`
（一百余条断言，期望值逐条抄自上述输出），结构不变量钉在 `test/unit/file-stream.ts`。

### 13.1 `FileStream`：真 `implements IDataInput, IDataOutput`

之前 `FileStream` 只有 `open`/`openAsync`/`close`/`readUTFBytes`/`writeUTFBytes`，`position`/`bytesAvailable`
只读且 `position` 是 `uint`；`IDataInput`/`IDataOutput` 的其余 23 个方法全缺。现在 23 个全有，
`position` 是 **`Number` 且可写**（写即 `fseek`），并补 `endian`/`objectEncoding`/`readAhead` 三个访问器。

| 口径 | 实测（`adl 51.4.1`） | 落地 |
|---|---|---|
| 默认值 | `endian == "bigEndian"`、`objectEncoding == 3`、`readAhead == Infinity` | 构造器同值（`readAhead` 可写） |
| 未打开 / 用错方向 | `bytesAvailable`/`position`/`read*`/`write*`/`truncate` 一律 `Error #2029: This URLStream object does not have a stream opened.`；`close()` 是 no-op | 同一个 `as_fs_readable`/`as_fs_writable` 门；`#2029` 文案**逐字**照抄（AIR 在 `FileStream` 上也说 "URLStream"） |
| 写句柄上读 `bytesAvailable` | `#2029` | 同 |
| 读越界 | `EOFError #2030`（不是短读、不是 0） | `read*` 全部走 `as_throw_eof()` |
| `position = -1` | `Error #2006` | 同 |
| `position` 在 `APPEND` 上 | `Error #2037`（`APPEND` 恒在 EOF，不许回退） | 同 |
| `position` 越过 EOF | **合法**（先写则文件被撑大） | 同（`fseek` 允许越界） |
| `truncate()` | 从 `position` 截断；`READ` 上是 `#2029` | 同（`ftruncate`） |
| 打开目录 | `Error #3006: Not a file.` | 同（先 `stat` 判目录） |
| 模式为空串 / `null` | `""` ⇒ `#2004`；`null` **当 `READ`** | 同 |
| 路径不存在 | `READ`/`UPDATE` ⇒ `#3003`；`WRITE`/`APPEND` **创建文件** | 同 |
| 字节序 | 只影响多字节成员（`writeInt` 大端写 `01 02 03 04`、切 `littleEndian` 后 `04 03 02 01`） | `as_fs_w16/w32` 自己选字节序，`float`/`double` 走「宿主序 ↔ 流序」的 `as_fs_write_host_bits`（**只翻一次** —— 首版翻两次，症状是 `readInt` 回来是反的） |
| `objectEncoding` | `writeObject`/`readObject` 跟它走 | AMF3 读写都通；**AMF0 写仍是本子集既有缺口**（编码器报明而非错写 AMF3 字节），见 `### 遗留待开发` |
| `openAsync` 的事件 | `WRITE`/`APPEND` **不派任何事件**；`READ` 先 `progress` 再 `complete`；`UPDATE` 只 `complete` | 同（`AS_JOB_FS_OPEN`） |
| `writeUTFBytes` 的可见性 | 写一半就 `close`，另一句柄**立即可读到** | `setvbuf(_IONBF)`：AIR 是不缓冲的，普通 stdio 会攒 4 KB |

### 13.2 `File` 的剩余成员

| 成员 | 实测 | 落地 |
|---|---|---|
| `creationDate`/`modificationDate` | 真 `Date`（`st_birthtime`/`st_mtim`）；无路径 `#2037`、路径不存在 `#3003` | 同 |
| `clone()` | 新对象、同路径 | 同 |
| `canonicalize()`（void，就地改） | **只有整条路径存在才解析链接**：`/tmp` ⇒ `/private/tmp`、`/tmp/real.txt` ⇒ `/private/tmp/real.txt`；`/tmp/real.txt/inner/x`（不存在）**原样不动，连 `/tmp` 都不解析**；`/tmp/real.txt/../other.txt` ⇒ `/tmp/other.txt`（`..` 被折掉、`/tmp` 仍未解析） | 词法归一化恒做，`realpath` 只在 `lstat` 命中时做。首版按「解析最深的已存在祖先」实现，被 `ag.txt` 推翻 |
| `getRelativePath(other, useDotDot=false)` | 从**接收者指向参数**；子 ⇒ `"kid.txt"`；自己 ⇒ `""`；父 ⇒ 需 `useDotDot=true` 才给 `".."`，否则 `null`；无公共前缀 ⇒ `null`（**不抛**） | 同 |
| `copyTo`/`copyToAsync`/`moveToAsync` | `#2007` 目标 null（**文字是 "Parameter destination must be non-null."**）、`#2037` 无路径、`#3003` 源不存在、`#3012` 目标已存在且未给 `overwrite`、`#3014` 目标在源内部；**自动建父目录**；目录递归复制（链接按链接复制） | 三者与 `moveTo` 共用 `as_file_transfer_err` + `as_file_copy_any`；`moveTo` 的跨卷（`EXDEV`）走「复制 + 删除」 |
| `isPackage` | 目录 + bundle 后缀（`.app` true、`.framework` **false**）；**文件** `.app` false | 同（后缀白名单） |
| `url` 的 setter | `file:///tmp/a%20b.txt` ⇒ `/tmp/a b.txt`；`null`/`""`/`http://…` ⇒ `#2004`；`app:/q.txt` ⇒ `applicationDirectory/q.txt` | 同 |
| `createTempFile()`/`createTempDirectory()` | `/var/folders/…/FlashTmp.XXXXXX`，已存在 | `mkstemp`/`mkdtemp`，同前缀 |
| `getRootDirectories()` | POSIX `["/"]`；Windows 盘符 | 同 |
| `permissionStatus` | **静态** `"granted"`；**实例读取是编译错误** | 只有静态（实例读在我们这里也编不过） |
| `preventBackup` | 可写，但**立刻读回 `false`**（macOS 上没有这个 OS 位） | setter **不存**任何状态 —— 不发明 AIR 没有的状态 |
| `downloaded` | 新文件 `false`；置 `true` 打 quarantine；**置 `false` 不会清掉**（读回仍 `true`） | 同（`com.apple.quarantine` xattr） |
| `creator`/`data` | `null` | 同 |
| `icon` | `[object Icon]`；但 `bitmapDatas` 在 51.4 里 **`#1069`**（不可读） | 给空 `Icon` 并**报明**「本构建没有图标提取」；`bitmapDatas` 回空数组（AIR 那边根本读不到） |
| `cacheDirectory`/`workingDirectory`/`systemCharset`/`applicationRemovableStorageDirectory` | `~/Library/Caches`；进程 CWD；**`x-mac-chinesesimp`**（宿主语言设置）；`null` | `$XDG_CACHE_HOME`/`~/Library/Caches`/**Windows 的 `%TEMP%`（`GetTempPathA`，§11.6）**；`getcwd`（Windows `GetCurrentDirectoryA`）；**`"UTF-8"` 并在 TODO 登记这条偏差**；`null` |

### 13.3 四个新类（C 批）

| 类 | 实测要点 | 落地 |
|---|---|---|
| `flash.net.FileReference` | `File` 的父类。未选择过文件时**除 `data` 外全部 `#2037`**，`data == null`；`toString() == "[object FileReference]"`；`browse()` 回 **`Boolean`**（`File.browseFor*` 是 void） | 真类，`isFinal: false`（SDK 标 final 但 `mxmlc` 允许被继承 —— 不然我们自己的 `File extends FileReference` 编不过）；无对话框后端 ⇒ `browse`/`load`/`save`/`download`/`upload` **报明后返回 `false`** |
| `flash.net.FileReferenceList` | `fileList` 初值是 **`null`（不是空数组）**且**只读**；这个类上**没有** `selectMultiple`（那是 `FileListEvent` 的常量）；`browse()` 回 `Boolean` | 真类，`fileList` 只读、恒 `null`（没有对话框就没人填）；`browse()` 报明 + `false` |
| `flash.filesystem.StorageVolume` | 构造器参数序是 **`(rootDirectory, name, isWritable, isRemovable, fileSystemType, drive)`** —— **不是**字段序（`name` 第二、`drive` 最后，读回六个 getter 才认出来）；六个只读 getter | 同序真实现 |
| `flash.events.StorageVolumeChangeEvent` | 常量 `storageVolumeMount`/`storageVolumeUnmount`；5 参数构造器（第 4/5 个是 `rootDirectory`/`storageVolume`）；`clone()` | 同 |
| `flash.net.FileFilter` | 只有三个公开读写字段 `description`/`extension`/`macType`（**没有** `clone()`、没有 `winType`/`name`） | 把此前「空替代 + 自造成员」改成真类，删掉自造的 `clone`/`winType`/`name` |
| `flash.events.FileListEvent` | 构造器 **4 参数** `(type, bubbles, cancelable, files)`；**没有** `directory` 成员；两个常量 | 已按此修正（此前构造器多一个参数、多一个自造成员） |

### 13.4 顺带暴露的一个真 bug

`File` 改成继承 `FileReference` 之后，`cancel()` 的 vtable 槽位落到了**父类**的 no-op 上
（`FileReference_cancel`），于是 `file.cancel()` 什么也没取消 —— `examples/file-listing-async.as`
的「cancel() 丢掉待派发的列举」当场变红。修法是让 `File` **显式声明** `cancel` 覆盖父类，
指向已有的 `File_cancel`。这条不占遗留表：`adl` 上 `cancel()` 确实取消得了，属 §1.5 的**遗留缺陷**，
且同阶段修净。

### 13.5 没做到的（如实）

- `systemCharset` 在 `adl` 上是**宿主语言设置**（本机 `x-mac-chinesesimp`），我们回 `"UTF-8"`。这是有意的
  偏差：本构建里所有字符串本来就是 UTF-8，报一个我们并不使用的传统代码页才是撒谎。
- 原生文件对话框（`browseFor*`/`FileReference.browse`）与卷枚举（`getVolumeByDrive`/`getVolumeByPath`）
  未做，全部走 `as_shell_unsupported` 报明，见 `### 遗留待开发`。
- `File.createTempFile()` 的文件留在 `TMPDIR`，由系统清理（与 AIR 一致）。
- Windows 分支（`GetDiskFreeSpaceExA` 之外的 `as_file_cache_dir` 等）本机无环境，只做了编译面推导。
