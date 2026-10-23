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