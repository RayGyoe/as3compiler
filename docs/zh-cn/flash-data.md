# 本地 SQL 数据库（`flash.data` / SQLite）支持路线评估

> 本文回答一个问题：**要支持 AS3 的 `flash.data` 本地 SQL 数据库（SQLite），应当链接一个开源
> SQLite 框架，还是自研引擎？**
>
> **结论先行：**
>
> 1. **引擎不可自研 —— 链接官方 SQLite 源码（amalgamation）。** 这不是偏好，是被实测**锁死**的：
>    AIR 的**明文**库就是**标准 SQLite 文件**（宿主机 `sqlite3` CLI 直接 `PRAGMA integrity_check`
>    返回 `ok` 并能 `SELECT` 出行）。AIR 的真实语义**就是 SQLite 本身**，自研等于在一个有权威
>    参照物的领域里主动发散。
> 2. **加密是唯一真正的分叉，且是「纯自研」的死路。** AIR 的加密库 = **AES-CCM + 16 字节裸密钥 +
>    每页 32 字节保留区**的私有布局；**SQLCipher** 是 AES-256-CBC + HMAC + PBKDF2 + 明文 salt。
>    两者在**密钥派生 / 密码算法 / 文件布局**三轴**全不兼容** —— 换 SQLCipher 既拿不到 AIR 兼容，
>    也读不了 AIR 写的库。故加密**不换库**，而是「不做 / 独立立项」。
> 3. **AS3 API 层（`SQLConnection` / `SQLStatement` / …）无论如何都要手写**，与引擎选择正交。
>    这是工作量的主体，但**比看上去小得多**：目标应用真正用到的入口只有 **4 个**（§4.2）。
> 4. **落地前有两个与 SQLite 无关的前置项**（§4.3）。其中一项是**我们自己的语义缺陷**：`Class`
>    值的**静态 getter**分派在 `adl` 里正常返回、在我们这里抛**裸 `Error id=0`** —— 它让
>    `Application.NativeApplication` 变成 `null`，从而目标应用的 SQLite 分支**根本不会被进入**。
>    不修这个，写多少 SQLite 代码都用不上。
> 5. **按 `AGENTS.md` §1.5，加密库必须「响亮失败」而非静默降级**：调用方传了密钥就报明
>    「本构建不支持加密数据库」，**绝不**假装加密、**绝不**静默退化成明文落盘。
>
> 本文的 AIR 运行时真值**全部来自 `adl 51.4.1` 实测探针**（本仓 `temp/adlprobe/`，含 SQLite
> 生命周期与文件头的逐字节取证）；API 清单逐项摘自 AIR SDK 官方语言参考；项目现状逐项 grep 核实，
> 不是文档转述或推测。

---

## 1. 这个需求是什么、为什么会被提起

`flash.data` 是 AS3/AIR 的**本地 SQL 数据库包** —— AIR 运行时内建了一个 SQLite 引擎，
应用可以创建/打开 `.db` 文件、执行 SQL、读结果集。它是 AIR 桌面应用最常用的**持久化**手段。

提起它是因为迁移真实 AIR 应用 `talkmed-meeting-desktop-app` 时撞到了它：

- 应用**不直接**使用 `flash.data`，而是走一层**自家包装**
  `com.vsdevelop.air.data.{SQLConnect, SQLStartment}`（`/Users/ray.lei/Documents/TalkMED/ActionScript-Lib/`）。
- 包装层用 **`getDefinitionByName` 动态解析** `flash.data` / `flash.events` 的类
  （`SQLConnect.as:73-76`、`SQLStartment.as:59-61`），**源码里 `import flash.data` 一处也没有**。
- 于是「不支持 `flash.data`」在我们的产物上表现为**静默降级**：`getDefinitionByName` 抛
  `ReferenceError #1065`，被包装层的 `try/catch` 吃掉，数据库功能**悄悄消失**，
  而进程不崩 —— 这正是 `AGENTS.md` 最忌讳的那类失败。

> 判据归属（`AGENTS.md` §1.5）：`adl` 能跑对而我们跑不出 ⇒ **遗留缺陷**（入 `TODO.md`
> `### 遗留待开发`），不是「增强」。`flash.data` 属此类，已按此登记（§6 末尾）。

---

## 2. 官方 API 全貌

权威来源：[AS3 语言参考 `flash.data` 包](https://airsdk.dev/reference/actionscript/3.0/flash/data/package-detail.html)。
该包共 **16 个类**：

| 类 | 作用 |
|---|---|
| `SQLConnection` | 打开/管理对本地库文件的连接（事务、压缩、模式操作） |
| `SQLStatement` | 在已打开的连接上执行一条 SQL 语句 |
| `SQLResult` | 一次语句执行的结果（`data` / `rowsAffected` / `complete`） |
| `SQLMode` | `openMode` 常量（`CREATE` / `READ` / `UPDATE`） |
| `SQLColumnNameStyle` | `columnNameStyle` 常量（结果行 key 的命名风格） |
| `SQLCollationType` | 排序规则常量 |
| `SQLTransactionLockType` | `begin()` 的锁类型常量 |
| `SQLSchema` | 模式信息基类 |
| `SQLTableSchema` / `SQLViewSchema` / `SQLIndexSchema` / `SQLTriggerSchema` | 各类模式对象 |
| `SQLColumnSchema` | 列模式 |
| `SQLSchemaResult` | `loadSchema()` 的结果 |
| `EncryptedLocalStore` | 加密本地小缓存（ELS）——**独立机制**，见 §3.3/§4.2 |

外加两个**事件类**与一个**错误类**（不同包）：

| 类 | 包 |
|---|---|
| `SQLEvent` | `flash.events`（`OPEN` / `CLOSE` / `RESULT` / `BEGIN` / `COMMIT` / `ROLLBACK` / `ANALYZE` / `COMPACT` / `DEANALYZE` / `REENCRYPT`） |
| `SQLErrorEvent` | `flash.events`（`ERROR`，`.error` 持 `SQLError`） |
| `SQLError` | `flash.errors`（**我们已是内建**，见 §4.1） |

本仓 `TODO.md` 早已把 `SQLConnection` / `SQLStatement` 记为「依赖 SQLite 链接，延后」——
本文就是来给这个「延后」定选型与范围的。

---

## 3. AIR 运行时实测真值（oracle）

探针：`temp/adlprobe/`（`Main.as` + `Holder.as` + `app.xml` + `run_adl.sh`，输出归档 `adl.txt`）。
两类取证：**(a) 反射/生命周期**（跑在 `adl 51.4.1` 里）、**(b) 文件头逐字节**（宿主机 `xxd` + `sqlite3`）。

> 探针工程注意：`adl` 在本机 shell 上下文里**不产出 stdout**，唯一可靠信号是**结果文件**
> （`FileMode.APPEND` + `END-OF-SCENE` 哨兵 + `<visible>false</visible>` + 后台跑 + 有界轮询
> + 看门狗强杀）。另外被 `getDefinitionByName` **按字符串**引用的类不会被 `mxmlc` 链进 SWF，
> 必须写一行 `private var keep:Class = Holder;` **强制链接**，否则 `adl` 抛 `#1065`
> （第一次探针就是这么失败的）。

### 3.1 类存在性（`getDefinitionByName`，全部命中）

```
flash.data.SQLConnection        -> flash.data::SQLConnection
flash.data.SQLStatement         -> flash.data::SQLStatement
flash.data.SQLMode              -> flash.data::SQLMode
flash.data.SQLResult            -> flash.data::SQLResult
flash.data.SQLColumnNameStyle   -> flash.data::SQLColumnNameStyle
flash.data.SQLColumnSchema      -> flash.data::SQLColumnSchema
flash.data.SQLSchemaResult      -> flash.data::SQLSchemaResult
flash.data.EncryptedLocalStore  -> flash.data::EncryptedLocalStore
flash.events.SQLEvent           -> flash.events::SQLEvent
flash.events.SQLErrorEvent      -> flash.events::SQLErrorEvent
flash.errors.SQLError           -> flash.errors::SQLError
```

### 3.2 API 面（`describeType`）

`SQLConnection` 的 accessor 恰好 **10 个**（注意：**没有 `encrypted` 属性** —— 与文档一致，
我们早期探针里那个 `#1069` 是**对的**，不是缺陷）：

```
isSupported[r/o]  autoCompact[r/o]  cacheSize  pageSize[r/o]  columnNameStyle
inTransaction[r/o]  totalChanges[r/o]  lastInsertRowID[r/o]  connected[r/o]  prototype[r/o]
```

方法包括 `open` / `openAsync` / `close` / `begin` / `commit` / `rollback` / `compact` /
`analyze` / `deanalyze` / `loadSchema` / `getSchemaResult` / `setSavepoint` /
`releaseSavepoint` / `rollbackToSavepoint` / `attach` / `detach` / `reencrypt` / `cancel`。

`SQLStatement` 的 accessor **5 个**：`parameters:Object`、`sqlConnection:SQLConnection`、
`itemClass:Class`、`text:String`、`executing:Boolean[r/o]`（另有 `execute` / `next` / `cancel` …）。

### 3.3 加密口径（**分叉点**）

- 官方文档（[SQLConnection](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLConnection.html)）：
  加密用 **AES + CCM**，密钥必须是 **16 字节 `ByteArray`**。
- 实测：以 `writeUTFBytes("<redacted-16ch>")`（16 字符）作密钥，`encryptionKey.length` **恰好 16**。
- **`open(..., SQLMode.READ, ..., pageSize)` 抛 `ArgumentError #3139`**
  （`Error #3139: The page size specified was not valid for this operation.`）—— 与文档
  「`pageSize` 仅对 CREATE 合法」吻合；**带密钥时重复 open 也抛 `#3139`**，即重开同一库必须
  先 `close`。
- `SQLConnection` **不暴露任何「库是否加密」的只读属性**（见 §3.2）——加密与否只能由调用方自己知道。

### 3.4 明文库 = 标准 SQLite；加密库 = 私有格式（**决定性证据**）

同一次运行、同一段代码、只差一个密钥：

| | 明文（无密钥） | 加密（有密钥） |
|---|---|---|
| 文件大小 | `12288` B | `12288` B |
| 首 16 字节 | `53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00` = **`SQLite format 3\0`** | `8d 07 7d 29 18 4d 2e 21 9f 02 8c af ac 06 56 18` = **密文** |
| 宿主机 `sqlite3` | `PRAGMA integrity_check` → **`ok`**；`SELECT * FROM t` → **`1\|MARKER_plain_123`** | `Error: in prepare, file is not a database (26)`（exit 26） |

⇒ **明文库就是标准 SQLite 文件**（第三方工具可直接读写），**加密库是私有格式**（第三方工具无法识别）。

**额外的结构线索**（字节 16–23，即「SQLite 头魔数之后的部分」）：

```
明文 : 10 00 01 01 00 40 20 20
加密 : 10 00 01 01 20 40 20 20
                    ^^ 仅此一字节不同
```

两者在 **byte 16–23 上几乎逐字节相同**，唯一差别是 **byte 20**：明文 `0x00` → 加密 `0x20`。
按 SQLite 文件格式，**byte 20 是「每页保留字节数」(reserved space per page)** ——
即 **AIR 加密库为每页保留 32 字节**（用于每页的 nonce/MAC），且**只加密头的前 16 字节
与从 byte 24 起的数据**，头尾的结构字节保持明文。

这解释了它的**架构**（与 SQLCipher 同构：SQLite + 每页保留区 + 整页加密），
但也精确地标出它与 SQLCipher 的**三点不兼容**：

| 轴 | AIR（实测 + 文档） | SQLCipher（默认） | 兼容？ |
|---|---|---|---|
| 密钥派生 | **原始 16 字节**直接作密钥（`writeUTFBytes(password)`） | PBKDF2-HMAC-SHA512 × 256000 迭代 + 随机 salt | ✗ |
| 密码算法 | **AES-CCM**（带认证的 AEAD） | AES-256-**CBC** + 独立 HMAC-SHA512 | ✗ |
| 文件布局 | 首 16 字节 = **加密的魔数**；每页保留 32 B | 首 16 字节 = **明文随机 salt**；每页保留 48 B | ✗ |

⇒ 「用 SQLCipher 顶上」在三个轴上**同时**不成立，**不是**一个「配置一下就能兼容」的替换。

---

## 4. 现状盘点

### 4.1 我们（编译器）

| 项 | 状态 | 证据 |
|---|---|---|
| `flash.errors.SQLError` | **已内建** | `src/emit.ts:6765`、`src/symbols.ts:820-830` |
| `flash.data.SQLConnection` / `SQLStatement` | **未注册**（刻意延后） | `TODO.md` 的「依赖 SQLite 链接，延后」条目 |
| `getDefinitionByName("flash.data.SQLConnection")` | 抛 **`ReferenceError #1065`**，**且可被 `catch (e:Error)` 捕获** | `temp/sqlprobe.as` |
| 全空「数据库可用性」探测 | 应用侧**完全无感** | 同上（静默降级，见 §1） |

**结论**：我们的缺口是**双层**的 ——
**(i) 运行时注册表缺 5 个类**（`SQLConnection` / `SQLStatement` / `SQLEvent` /
`SQLErrorEvent`，外加 `SQLResult` 等结果类），**(ii) 缺底下真正干活的 SQLite 引擎**。
但因为包装层是**动态解析**，只要我们注册了这些名字、`getDefinitionByName` 不再抛，
应用的 `try/catch` 就会走进「有数据库」的分支 —— 所以 **(i) 不补齐、或补成空壳，就会从
「静默降级」变成「静默错数据」**，比现状更糟。这正是必须**一并**把引擎做实的原因。

### 4.2 目标应用的实际用法（API 面收敛到 **4 个入口**）

实测：全 `src/` 里 `flash.data` 相关符号出现 **79** 处，分布在 **8 个文件**，但
**没有一处 `import flash.data`** —— 全部经包装层。

包装层对 `flash.data` 的**动态依赖只有 5 个名字**（`getDefinitionByName`）：

```
flash.data.SQLConnection      flash.data.SQLStatement
flash.events.SQLEvent         flash.events.SQLErrorEvent
（+ flash.utils.getDefinitionByName 本身）
```

应用**真正调用**的包装入口只有 **4 个**：

| 入口 | 语义 | 调用点 |
|---|---|---|
| `SQLStartment.SQLStartmentSQLiteFile(path, password)` | 打开/建库 | `ServerData.as:110` |
| `SQLStartment.cReate(sql)` | 执行 DDL/DML | `ServerData.as:130,149` |
| `SQLStartment.Query(sql)` → `Array` | SELECT → 对象数组 | `TKMTrackerQueueLogs.as:46,122`、`ServerData.as:172,195` |
| `SQLStartment.addObjectDate(table, obj)` | INSERT 一个对象 | `TKMTrackerQueueLogs.as:160`、`AISubTitleSetupWindow.as:1298` |

SQL 形态：**纯字符串拼接**、**无参数绑定**、只两张表（`LOGS` / `AISUBTITLE`）。
⇒ **最小可用面 = open + 执行 + SELECT 转对象数组 + INSERT**，其余（事务/模式/压缩/异步/加密）
都是「可选完备性」。

其他事实（决定了兼容性的价值）：

- 密钥：`Config.DEBUG=false` ⇒ 口令 `"<redacted-16ch>"`（恰好 16 字符 ⇒ 16 字节密钥）；
  且只在 `destoplocal=false` 时用 `writeUTFBytes(password)`，**生产路径不走 ELS**。
- 库路径：`<appDir>/assets/database/talkmed-meeting.db`；**应用不随包发库**，首次运行自建。
- `createSqLite` 的 `catch` 会**删除**出错的库文件（自愈）⇒ **跨格式兼容的价值几乎为零**。
- `com.adobe.air.crypto.EncryptionKeyGenerator` **不是缺口** ——
  它在应用自己的 `src/com/adobe/air/crypto/` 里，生产路径只用到**纯字符串的
  `validateStrongPassword()`**（`getEncryptionKey()` 走 ELS，`destoplocal=true` 才用，app 不调）。
  （初次核对时我按独立探针判它「无法解析」，属**探针没带该文件**的误判，已排除。）

### 4.3 阻断项（**与 SQLite 无关**，但会先挡路）

实测两个先于 SQLite 生效的问题：

**(a) `Class` 值的静态 getter 分派缺失 —— 我们自己的语义缺陷。**

```
                              AIR (adl 51.4.1)      我们 (v0.4.109)
direct getter:                THING                 THING
via class value, getter:      THING   ✅            ✗ 裸 Error id=0   ❌
via class value, var:         PLAIN   ✅            PLAIN   ✅
via class value, const:       KONST   ✅            KONST   ✅
via class value, method:      HI      ✅            HI      ✅
```

证据：AIR `temp/adlprobe/adl.txt` §1；我们 `temp/sqlprobe3.as`（输出 `via class getter threw: Error id=0`）。
即 **只有经 `Class` 值的静态 getter 这一条路是坏的**，var/const/method 都对。

**为什么它是硬阻断**：`Application.NativeApplication` 正是一个**静态 getter**，
其实现是 `myClass.nativeApplication`（`Application.as:127`）—— 恰好踩中该缺陷：

```
Application.NativeApplication == NULL
=> if (Application.NativeApplication) branch is SKIPPED
unguarded deref: TypeError #1009 Error #1009: Cannot access a property or method of a null object reference.
```

（我们侧证据 `temp/narepro.as`。）后果有两层：`SQLConnect.as` 的
`if (Application.NativeApplication) { … getDefinitionByName("flash.data.SQLConnection") … }`
**整个分支被跳过** ⇒ SQLite 代码路径压根不执行；且随后存在一处**可达的未判空解引用** →
`#1009` 硬崩。

**(b) 一个构建期障碍（非 SQLite）**：目标应用的 `--dry` 预检在本机**提前失败**于
`[Embed] mimeType 'application/x-font' on 'com.bit101.components::Component.Ronda' is not supported`
（另有 8 个源文件因 parse/E4X 词法错误被排除）。这是字体 embed 支持面的问题，
与本文无关，但会挡住「整包编译」这一验收动作。

---

## 5. 选型结论

### 5.1 引擎：**链接官方 SQLite 源码（amalgamation）**，不自研

| 维度 | 自研 SQL 引擎 | **链接 SQLite amalgamation（推荐）** |
|---|---|---|
| 语义保真 | 必须重造 SQL 解析/执行/类型亲和/排序规则/B-Tree… | **天然逐字一致**：AIR 的明文库就是标准 SQLite 文件（§3.4） |
| 可验证性 | 无权威 oracle，只能自证 | 宿主机 `sqlite3` CLI 即 oracle，可做**双向**读写对拍 |
| 工作量 | 数量级更大且永不收敛 | 引擎**零**工作量，工作全在 AS3 API 层 |
| 构建 | — | `sqlite3.c` 单文件，直接进构建清单 `sources`（§2.9），无需包管理器 |
| 许可证 | — | SQLite 属 **public domain**，无授权风险 |

**落地形态**：把 SQLite **amalgamation**（`sqlite3.c` + `sqlite3.h`）作为**源码依赖**放进
构建清单的 `sources`（对齐 `AGENTS.md` §2.9「第三方库链接、不内嵌」；amalgamation 恰好
同时满足「可读 C」与「RUNTIME 前导不膨胀」）。运行时经**薄胶水层**暴露给 AS3 API 层
（打开/执行/步进/取列/绑定），与既有 `runtime.ts` 的 `as_*` extern 风格一致。

### 5.2 加密：**不自研页加密、不做 SQLCipher 兼容、按 §1.5 响亮报明**

三条理由：

1. **换 SQLCipher 拿不到任何东西**：三轴不兼容（§3.4），既不能读 AIR 的加密库，
   也不能产出 AIR 能读的库。它的唯一用处是「我们自成一派的加密」，而我们的产物本就不与 AIR 互操作。
2. **自研 AES-CCM 页编解码**技术上可行（架构已摸清：每页保留 32 B、头前 16 B 加密），
   但需逐页 nonce/MAC 布局的**逆向实证**才能对齐，属**独立重工程**，且收益仅限「读旧加密库」。
3. **收益极低**：目标应用的库在**应用目录**、**不随包分发**、出错会**自删重建**（§4.2）
   ⇒ 没有存量加密库需要迁移。

**因此**：密钥参数接受但**不实现加密**，且必须是**响亮的、可区分的失败** ——
构建期/运行期明确报明「本构建不支持加密数据库」，而不是静默写明文（那会静默降低用户数据
的安全等级，是比崩溃更坏的失败）。加密若要做，**单独立项**（§6 阶段 E）。

### 5.3 被否方案

| 方案 | 否因 |
|---|---|
| **自研 SQL 引擎** | 在有权威 oracle 的领域主动发散；工作量数量级更大（§5.1） |
| **链接 SQLCipher 冒充 AIR 加密** | 三轴不兼容（§3.4）；且会让「看起来支持了加密」变成一种静默误导 |
| **只注册 API 名字、引擎留空壳** | 把「静默降级（功能消失）」升级为「静默错数据」，**更危险**（§4.1） |
| **把 `flash.data` 当作「AIR 不支持的增强」跳过** | 判据错：`adl` 能跑对、我们跑不出 ⇒ 是**遗留缺陷**（`AGENTS.md` §1.5），必须入账 |

---

## 6. 建议的分阶段路线（对齐现有「阶段XX」约定）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A** | 链接 amalgamation + 注册 `flash.data`/`flash.events` 的类骨架 + 最小闭环：`open` / `execute` / `SELECT→SQLResult` / `close` | 新示例 `examples/sqlite-basic.as`（建表/插入/查询/回读），并用宿主机 `sqlite3` 对拍产物文件 |
| **B** | 结果集完备：`SQLResult.data` / `rowsAffected` / `complete`；`SQLStatement.itemClass` 映射；`columnNameStyle` | 双端（`adl` vs 我们）逐字对照矩阵 |
| **C** | 事件与错误契约：`SQLEvent`（OPEN/RESULT/…）、`SQLErrorEvent.error`、`SQLError` 错误号矩阵；同步/异步两条路径 | `adl` 实测错误号矩阵（同 `flash-net.md` §6.7.5 的做法） |
| **D** | 事务与模式：`begin`/`commit`/`rollback`、`loadSchema`/`*Schema`、`compact`/`analyze` | 模式对象逐字段对 `adl` |
| **E**（可选，独立立项） | 加密：AES-CCM 每页编解码 + 密钥派生，逐页 nonce/MAC 布局逆向实证 | 用 `adl` 写的加密库作 oracle，双向读写对拍 |

**前置（必须先做，顺序在 A 之前）**：修 §4.3(a) 的 `Class` 值静态 getter 分派缺陷
（并对 `Application.NativeApplication` 补一条 end-to-end 钉子）。否则阶段 A 的验收
在**目标应用**里跑不起来（虽然 `examples/` 层可以）。

---

## 7. 明确不做 / 报明的边界

- **不做** SQLCipher 兼容（无意义，§5.2）。
- **不做**「静默忽略密钥」：传了密钥必须**响亮报明**不支持（`AGENTS.md` §1.5）。
- **不注册空壳**：API 名字一旦注册，就必须有真实现或**响亮失败**两条路，不允许「名字在、返回空」。
- **web / WASI 目标**：**2026-10-12 已评估并落地**（见 §10.5）——`wasm32-wasip1`
  **不需要**自写 VFS 或 `-DSQLITE_OS_OTHER`：wasi-libc 的 POSIX 文件面足够 SQLite 的
  默认 unix VFS 使用，只需 `-DSQLITE_THREADSAFE=0`（wasi-ld 无 pthread）。
- **ANE 相关**：`ANELame` / `ANECrypto` 里也触及 `EncryptedLocalStore` 等符号，属
  「ANE 宿主（`asaot` FRE 运行时）」这条既有缺口（见 `TODO.md` 阶段一百七十八），不在本文范围。

---

## 8. 工作量与结论

**一句话**：**链接官方 SQLite amalgamation，自研的只是它上面那层「薄 AS3 API」；
加密不做（响亮报明），并先修 `Class` 静态 getter 法那么。**

工作量分布（相对量级）：

| 部分 | 量级 | 说明 |
|---|---|---|
| SQLite 引擎 | **≈0** | amalgamation 入 `sources`，无包管理、无许可证问题 |
| 胶水层（C） | 中 | open/exec/step/column/bind/finalize + 错误号映射 |
| AS3 API 层 | **中**（主体） | 类骨架 + 最小闭环 → 结果集 → 事件/错误 → 事务/模式；**入口实测只有 4 个**（§4.2） |
| **`Class` 静态 getter 前置** | **小** | 但**阻塞**目标应用的验收 |
| 加密 | **大**（可延后） | 若做，需逆向实证；收益低 |

**各结论的取证清单**：`temp/adlprobe/`（AIR 真值：类存在性 / API 面 / `#3139` / 库文件头
逐字节 / 宿主机 `sqlite3` 双证）、`temp/sqlprobe.as`（我们的 `#1065` 可捕获）、
`temp/sqlprobe3.as`（`Class` 静态 getter 缺陷）、`temp/narepro.as`（`Application.NativeApplication`
为 `NULL` + 可达 `#1009`）、`temp/ekg2.as`（排除 `EncryptionKeyGenerator` 缺口）。

---

## 9. 参考链接

- [`flash.data` 包](https://airsdk.dev/reference/actionscript/3.0/flash/data/package-detail.html)
- [`SQLConnection`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLConnection.html)（加密 = AES-CCM、16 字节密钥）
- [`SQLStatement`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLStatement.html)
- [`SQLResult`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLResult.html)
- [本地数据库的 SQL 支持](https://airsdk.dev/reference/actionscript/3.0/localDatabaseSQLSupport.html)
- SQLite amalgamation：<https://sqlite.org/amalgamation.html>

---

## 10. 落地实况（2026-10-12，阶段一百三十九，v0.4.109 → v0.4.110）

§6 的 A–D 四阶段**已全部落地并逐项对 `adl 51.4.1` 验收**（E 加密仍**不做**，按 §5.2
响亮报明）。本节只记**实现完成后才知道的事**：与官方文档不符的实测口径、我们刻意保留的
偏差、以及各阶段证据文件。**所有断言式示例都同时跑三端**：native、WASI（`wasm32-wasip1`）、
以及把同一份示例改写成 `adl` harness 的 **AIR oracle**（`temp/sql3/gen_oracle.py`）。

### 10.1 交付物

| 文件 | 作用 |
|---|---|
| `vendor/sqlite/{sqlite3.c,sqlite3.h,sqlite3ext.h}` | 官方 amalgamation 3.54.0，**只有构建清单里的 `sources` 引用它**（`shell.c` —— amalgamation 自带的 CLI、带自己的 `main()` —— 构建从不编译，**刻意不入库**） |
| `vendor/sqlite_glue.c` | 唯一 `#include <sqlite3.h>` 的翻译单元；对生成的 C 暴露一个窄的 `as_sql_*` ABI |
| `src/runtime.ts` | `as_sql_*` 的声明 + **未链接时的响亮桩**（`#ifdef ASC_HAVE_SQLITE` 两分支） |
| `src/symbols.ts` | `flash.data` / `flash.errors.SQLError` / `flash.events.SQL*` 的类骨架与成员表 |
| `src/emit.ts` | `flash.data` 的 AS3→C 实现（约 1,600 行手写 C 块）+ `SQLStatement`/`SQLError` 集成 |
| `src/index.ts` | `usesFlashData` 探测 → 入 `sources`、`include-paths`、`ASC_HAVE_SQLITE`、`SQLITE_ENABLE_COLUMN_METADATA`（wasm 另加 `SQLITE_THREADSAFE=0`） |
| `examples/sqlite-basic.as` | 阶段 A：open/execute/SELECT→`SQLResult`/close + 与宿主机 `sqlite3` 对拍 |
| `examples/sqlite-phase-b.as` | 阶段 B：事务/保存点/`attach`/`columnNameStyle`/`compact`/`analyze`/错误契约 |
| `examples/sqlite-phase-c.as` | 阶段 C：`prefetch`/`next`/`cancel`/`executing`/`itemClass`/逐行 `SQLUpdateEvent` |
| `examples/sqlite-phase-d.as` | 阶段 D：`loadSchema`/`getSchemaResult`/四个 `*Schema`/`SQLColumnSchema` |
| `test/unit/flash-data.ts` | 7 组源级/构建级钉子（错误族、离线桩、prefetch 模型、模式对象、构建接线、oracle 形状） |

### 10.2 官方文档与 `adl` 实测**不符**之处（我们按实测实现）

1. **`prefetch` 不是「每次取多少行」**。默认 `-1` = 取完（`complete=true`）；`>0` = 至多这么多
   （`complete=false`，`executing=true`）；**`0` 或除 `-1` 外的任何负数 = 一行都不给，直接
   `data=null, complete=true`**；`next()` 在 `complete` 后抛 `#3107`。空块一律 `data == null`
   （**不是空数组**），DDL/DML 同样 `data == null`。
2. **`SQLStatement.text` 初值是空串**（不是 `null`）；**给 `text` 赋 `null` 抛 `TypeError #1009`**
   （AIR 的 setter 解引用），且属性**保持原值**。
3. **`SQLStatement.itemClass` 初值是 `Object` 类**（不是 `null`）；赋 `null` **被接受**且读回
   `Object`（AIR 归一化）。两条与 `text` 的不对称都是实测。
4. **`getResult()` / `getSchemaResult()` 是 FIFO 队列**：每次 `execute()`/`loadSchema()` 恰好压
   一个，取过即 `null`。示例里因此必须写「执行后立刻取」的 helper——这是**应用侧最容易踩的坑**。
5. **`loadSchema` 命中不到 = 报错**，不是空结果：`#3115` + `detailID` **1007**（给了名字）/
   **1009**（只给类型）/ **1010**（都没给），且 `detailArguments` 分别是 `(name,type,db)` /
   `(type,db)` / `(db)`，`details` 文案逐字复刻。
6. **只列用户创建的对象**：UNIQUE/PRIMARY KEY 自动索引的 `sql` 为 NULL ⇒ 不算；
   `AUTOINCREMENT` 自动建的 `sqlite_sequence`、`ANALYZE` 建的 `sqlite_stat1` **也不算**
   （按 `sqlite_` 前缀过滤）。
7. **`columns` 在 `includeColumnSchema=false` 时是空数组**（不是 `null`）。
8. **`SQLViewSchema extends SQLTableSchema`**（`view is SQLTableSchema` 成立），结构体同布局。
9. **AIR 的默认 `pageSize` 是 1024**（不是 SQLite 的 4096）：glue 在参数为 0 时传 1024。
10. **`inTransaction` = `autocommit==0 && sqlite3_txn_state!=0`**；这同时就是 `compact`/`cacheSize`/
    `deanalyze` 的 `#3103` 判据（**不是**裸 autocommit：DEFERRED begin 未写时它们放行，
    由引擎自己报 `#3115`）；`analyze` **无事务守卫**。
11. **`_sawTxn`**（AIR 自己的「开过事务」标志）：`begin()`/`setSavepoint()` 置位、
    `commit()`/`rollback()` 清除——它把「没有事务」的裸 `#3105` 与引擎的 `#3115` 分开
    （裸 `setSavepoint` + `releaseSavepoint` 之后 `commit` 得 `#3115`）。
12. **无名保存点就是空名字符串** `""`（不是某个内部名）。
13. **`SQLUpdateEvent` 由 `SQLConnection` 派发**（挂 `SQLStatement` 的监听器**收不到**），
    每个受影响行一条，且在语句的 `result` 事件**之前**。
14. **`cancel()` 不派发任何事件**；`execute()` 在游标未走完时**合法**（先 finalize 再重跑）。
15. **"a failed `loadSchema` 不压队列、也不派发 `schema` 事件"**（事件数只随成功调用增长）。

### 10.3 刻意保留的偏差（**响亮**报明，非静默降级）

- **加密 = 直接报错**：任何非空 `encryptionKey` / `reencrypt()` / 带密钥的 `attach` 一律
  `SQLError #3138`，**绝不静默写明文库**（`AGENTS.md` §1.5）。
- **`details` / `detailID` 文案**：我们用 SQLite 自己的 `sqlite3_errmsg` 与
  `sqlite3_extended_errcode`，而 AIR 会**改写文案**（AIR：`no such table: 'sqlite_stat1'`、
  `no such savepoint: ''`、`unable to open database: '<path>'`，我们分别给
  `no such table: sqlite_stat1` 等，少了引号），且 AIR 偶有 `details="" detailID=-1`。
  **错误号与 `details` 的「三种模式」文案我们逐字复刻**（1007/1009/1010、参数不匹配 1004、
  `#3102`/`#3105`/`#3112`/`#2007`）。
- **`attach(name, null)`**：AIR **静默接受**；我们**响亮报错**（没有 `File` 就没有路径）。
- **`openAsync()` 内部仍是同步**：在调用**之后**注册的监听器收不到事件（ADR 已知缺口）。
- **`columnNameStyle = "default"` 仍是短名**：AIR 对**表限定列**会切成长名（`t_id`），我们
  维持短名（`long` 值本身已实现为 `[table]_[column]`）；未知值一律归一化成 `"default"`。
- **`SQLColumnSchema.defaultCollationType` 恒为 `"binary"`**；`collate nocase` 未接。
- **`FileStream`/`ByteArray.reference` 不支持**（只有真 `File` 能 `open`/`attach`）。
- **`#2008`（`loadSchema` 的 `type` 不是四个模式类之一）** 是我们按 AIR 的错误号家族补的，
  未逐字实测其文案。

### 10.4 验收（三端）

| 端 | 结果 |
|---|---|
| native（`-O2`） | 四个示例全绿：`sqlite-basic: ok` / `sqlite-phase-b: ok` / `sqlite-phase-c: ok` / `sqlite-phase-d: ok` |
| **AIR oracle**（`adl 51.4.1`） | **同一份断言在 AIR 上全绿**（`temp/sql3/`：`gen_oracle.py` 改写示例 → `run_adl.sh`）——本节所有「实测」的重现路径 |
| WASI（`wasm32-wasip1`） | 四个示例全绿（Node 24 的 `node:wasi` 跑，`temp/wasirun.mjs`）；产物库文件与 native/AIR 同尺寸（3072 B / page_size 1024） |
| 字节对拍 | `temp/sqlite-basic.db` = 3072 B、首 16 字节 `SQLite format 3\0`、`pragma integrity_check` = `ok`、`page_size` = 1024 |

### 10.5 WASI 目标的两个额外结论

- **不需要自写 VFS**：wasi-libc 提供的 POSIX 文件面足够 SQLite 的 unix VFS 直接跑，
  无需 `-DSQLITE_OS_OTHER`；只需 `-DSQLITE_THREADSAFE=0`（`wasm-ld` 无 pthread）。
- **顺带修掉一个**与 SQLite 无关、但**挡住所有 wasm 构建**的缺陷：`as_rmdir_one` 在
  非 Windows 分支直接调 `rmdir()`，而 `rmdir` 声明在 `<unistd.h>` —— 该头**在 WASI 下被
  刻意跳过**（那里没有 `fork/exec`），于是**每个** wasm 构建都死于
  `call to undeclared function 'rmdir'`（ISO C99 不再接受隐式声明）。改为 POSIX 的
  `remove()`（`<stdio.h>` 恒在，wasi-libc 对目录同样按 rmdir 处理；Windows 分支仍是
  `RemoveDirectoryA`，语义不变）。
- **`_sawTxn` 那类「AIR 自己的簿记」要多留一心**：它们不在文档里，只能靠「同一条 API
  在不同前置状态下报不同错误号」的对照矩阵逼出来（`temp/sql2/` 第 7/9/10/11 轮）。

### 10.6 阶段号说明（如实报明）

`TODO.md` 里 2026-10-12 的那条立项记录把本文标为「阶段一百三十七」，但**代码里
`阶段一百三十七` 已被 SWC 命名子件占用**（`src/runtime.ts`），`阶段一百三十八` 是本次的
前置修复（`Class` 值静态 getter，`examples/class-static-member.as` + `test/unit/reflection.ts`）。
故**实现轮取「已用最大 + 1」= 阶段一百三十九**。
