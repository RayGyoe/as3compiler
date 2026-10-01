# HTTP 加载（`flash.net`）对齐调研与集成方案

> 本文回答一个问题：**本项目的 `flash.net` 加载面（`URLLoader` / `URLRequest` / …）与 AIR SDK 的
> 官方 API 差多少，HTTP GET/POST 能不能做、怎么落地**。
>
> 核心结论先行：
>
> 1. **现有实现只是「本地文件读取」的一个 API 形状外壳**——`URLLoader` 把 URL 当文件系统路径
>    `fopen`，`URLRequest.method` / `.data` / `.contentType` 三个字段**能写、从不被读**。
>    GET/POST **完全没有**，`URLRequestMethod` / `URLRequestHeader` / `URLStream` / `URLRequestDefaults`
>    四个类**根本不存在**。
> 2. **真正的工作量不在「调一个 HTTP 库」，而在 HTTPS/TLS 与三目标分叉**：native 可自建 TCP+TLS
>    或经平台网络 API，web 只能走浏览器 `fetch`（受 CORS 约束、禁改受限头），WASI preview1
>    **根本无 socket**——同一份 AS3 在三端必须给出**诚实且一致**的语义（有网就跑、无网就 `IOError`）。
>    **且不存在可覆盖三端的单一通用库**（边界在**传输层**而非 TLS 原语——详见 §4.1.1，含 TypePHP 先例）。
> 3. **优先级排序**：把 API 面补齐（常量类 + 字段 + 事件契约，**不需要网络**）是低风险高价值的第一步；
>    HTTP 客户端本身是**独立一条重工程**，建议单独立项、分阶段推进，不阻塞任何现有阶段。
>
> **实现状态（阶段八十九·四十八~五十二，2026-09-27）**：路线图 §5 的 **A~I 全部落地**：A/B（八十九·四十八）、
> G + C 探针（八十九·四十九）、构建清单 `targets` 分层（八十九·五十）、D/E/F/H 四个后端与 API 面
> （八十九·五十一：native curl 内核带响应头/重定向/空闲超时/全部动词、web `fetch` 后端、`URLStream` 流式 job、
> `navigateToURL`/`sendToURL`）、**AIR 语义保真校正 + 端到端验收 I**（八十九·五十二）。
> **当前三目标状态**：native+`ASC_HAVE_CURL` 与 **web+`ASC_HAVE_FETCH`** 真联网；无后端目标
> （默认 native / WASI preview1）派**可区分**的诚实 `ioError`；`securityError` 仍不派（没有会拒绝的源）。
> native 侧真 GET/POST/404/HTTPS 均跑通（libcurl，**opt-in**，见 §4.1.2；**阶段八十九·五十三** 起
> 示例清单走的是 `vendor/curl` **静态**库，故产物自包含——`otool -L` 里没有 `libcurl.4.dylib`）。
> 因此文中「字段能写不被读」「`close()` 是空函数」「四个类不存在」等描述应读作**动工前的盘点**；
> 各项的当前状态以 **§3.1 表**为准（含文件位置），C 的接入形态/代价见 **§4.1.2**，
> 全部验收与反向对照（含 `mxmlc + adl` 基线）见 **§6**。
> D 之后的界（chunked 进度、`responseHeaders`、代理/cookie、`URLStream`、web `fetch`、`navigateToURL`）
> **已于八十九·五十一/五十二 落地**；**代理 / cookie jar / HTTP-2、静态自包含 `vendor/` 静态 curl、
> socket/TLS 之上的其它协议（`Socket`/`ServerSocket`/`XMLSocket`）也已于八十九·五十三 落地**（见 §4.1、§7）；
> 仍未做的是需第三方栈的重工程（preview2 的 `wasi:http`、AMF `readObject`、`SecureSocket` 的 TLS 状态机、
> `DatagramSocket` 的 UDP）。
>
> 本文所有 API 细节均**逐项摘自 AIR SDK 官方语言参考**（`airsdk.dev/reference/actionscript/3.0/`），
> 项目现状均**逐项 grep 核实**，不是文档转述或推测。

---

## 1. 这个需求是什么、为什么会被提起

`flash.net` 是 AS3 的**网络加载包**：从 URL 下载文本 / 二进制 / URL 编码变量（`URLLoader`），
发 HTTP 请求（`URLRequest`），低层流式下载（`URLStream`），以及 socket/点对点/文件上传等更重的部分。

本项目当前对 `flash.net` 的落地范围是**「无网络后端的最小模型」**（README-CN.md 明说「真实异步
HTTP/Socket 加载未实现」）：`URLLoader.load(request)` 把 `request.url` 当作**本地文件系统路径**读取。
这在「资源随应用打包、`file://` / 相对路径加载」的场景里足够跑通（Starling 的 `AssetManager` 主路径
就是本地资源），但一旦应用真的去请求 `http(s)://…`，行为就与 AIR 完全不符。

需求来自一个直接的问题：**「`URLLoader` 是不是都实现了？能 POST 和 GET 了吗？」** 本文就是这道题的
完整答卷——先给官方标准，再给现状差距，再给落地方案。

---

## 2. 官方 API 全貌（权威来源：[AS3 语言参考 `flash.net`](https://airsdk.dev/reference/actionscript/3.0/flash/net/package-detail.html)）

### 2.1 `URLLoader`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoader.html)）

继承 `EventDispatcher → Object`。**在数据全部下载完之前，不对代码可见**；通过 `bytesLoaded`/`bytesTotal`
与事件报告进度。

| 成员 | 签名 | 语义要点（官方原文摘录） |
|---|---|---|
| `bytesLoaded` | `uint = 0` | 「已加载的字节数」 |
| `bytesTotal` | `uint = 0` | 「**加载进行中恒为 0**，操作完成时才有值；**缺 `Content-Length` 头则不可确定**」 |
| `data` | `*` | 「**只在加载完成后**才填充」；格式由 `dataFormat` 决定 |
| `dataFormat` | `String = "text"` | `TEXT`/`BINARY`/`VARIABLES`，默认 `TEXT` |
| `URLLoader(request:URLRequest = null)` | 构造器 | **若传入 request，立即开始加载**（等价于构造后即 `load`） |
| `load(request:URLRequest):void` | 方法 | 「发送并从指定 URL 加载数据」；**要发数据就设 `URLRequest.data`** |
| `close():void` | 方法 | 「**立即终止**进行中的加载；若无正在流式加载的 URL，抛 invalid stream error」 |

**`load()` 的抛出**：`ArgumentError`（`requestHeaders` 含受限头）、`Error`（GET 时 UTF8→MBCS 失败 /
POST 数据内存分配失败）、`SecurityError`（本地不可信文件联网 / 连受限端口）、
`TypeError`（`request` 或 `URLRequest.url` 为 `null`）。

**事件**（这是契约的核心）：

| 事件 | 常量 | 触发时机 |
|---|---|---|
| `complete` | `Event.COMPLETE` | 「**所有数据解码完毕并放入 `data` 之后**派发；此事件后才可访问数据」 |
| `open` | `Event.OPEN` | 「`load()` 调用后下载**开始**时派发」 |
| `progress` | `ProgressEvent.PROGRESS` | 「下载进行中收到数据时」；**URLLoader 无法在完成前取到数据，故 progress 只是进度通知** |
| `ioError` | `IOErrorEvent.IO_ERROR` | 「导致下载**终止的致命错误**」（本项目的错误号见 §6.7.5） |
| `httpStatus` | `HTTPStatusEvent.HTTP_STATUS` | HTTP 访问且环境能拿到状态码时；**在 complete/error 之前（且额外）派发** |
| `httpResponseStatus` | `HTTPStatusEvent.HTTP_RESPONSE_STATUS` | **AIR**：**先于任何响应数据**派发，含 `responseHeaders`/`responseURL` |
| `securityError` | `SecurityErrorEvent.SECURITY_ERROR` | 跨沙箱 / SWZ 证书无效 |
| `certificateError` | `SecurityErrorEvent.CERTIFICATE_ERROR` | **AIR 51**：服务器证书无效（自签/不受信/过期）；`cancelable=true`，`preventDefault()` 放行 |

> 事件顺序铁律（官方 `HTTPStatusEvent` 页）：**HTTPStatusEvent 总是先于 error/completion 事件派发**。

### 2.2 `URLLoaderDataFormat`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoaderDataFormat.html)）

`final` 常量类：`TEXT = "text"`、`BINARY = "binary"`、`VARIABLES = "variables"`。
- `TEXT` → `data` 是 `String`（文件文本）
- `BINARY` → `data` 是 `ByteArray`（原始二进制）
- `VARIABLES` → `data` 是 `URLVariables`（URL 编码变量）

### 2.3 `URLRequest`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequest.html)）

`final`。**「把一次 HTTP 请求的全部信息装进一个对象」**——传给 `Loader.load()` / `URLStream` / `URLLoader.load()`。

| 属性 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | `String` | — | 请求的 URL |
| `method` | `String` | `URLRequestMethod.GET` | 「控制 HTTP 表单提交方法」；**Flash Player（浏览器）限 GET/POST**；**AIR 应用沙箱内可任意字符串**；**非 GET/POST 时抛 `ArgumentError`**（非应用沙箱） |
| `data` | `Object` | — | 随请求发送的数据；**GET 时按 query string 追加到 `url`；POST（或任何非 GET）时进请求体**；可为 `ByteArray`/`URLVariables`/`String`（否则转字符串） |
| `contentType` | `String` | **`null`** | `data` 的 MIME 类型；**须与 `data` 实际类型对应**。⚠️ 官方文档印的默认值 `application/x-www-form-urlencoded` 是 **adl 发包时的 wire 默认**，**不是属性值**——adl 实测属性恒为 `null`（踩坑与捕获矩阵见 §6.7.7） |
| `requestHeaders` | `Array` | — | `URLRequestHeader` 数组；**浏览器限制：自定义头只对 POST 生效，GET 不支持** |
| `authenticate` | `Boolean` | `true` | **AIR**：是否处理认证挑战 |
| `cacheResponse` | `Boolean` | `true` | **AIR**：是否缓存成功响应 |
| `followRedirects` | `Boolean` | `true` | **AIR**：是否跟随重定向 |
| `idleTimeout` | `Number` | 0（用 OS 默认） | **AIR 2**：连接建立后等待响应的空闲超时（ms） |
| `manageCookies` | `Boolean` | `true` | **AIR**：是否由 HTTP 栈管理 cookie |
| `useCache` | `Boolean` | `true` | **AIR**：是否先查本地缓存 |

方法：`useRedirectedURL(sourceRequest, wholeURL=false, pattern=null, replace=null)`（**AIR 3.8**，
用已重定向请求的 URL 替换新请求的域名/整段 URL）。

> `URLRequest` 是 `final`，构造器 `URLRequest(url:String = null)`。

### 2.4 `URLRequestMethod`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestMethod.html)）

`final` 常量类（**6 个**，比多数人以为的 GET/POST 多）：`GET`、`POST`、`PUT`、`DELETE`、`HEAD`、`OPTIONS`
（均为对应同名字符串）。

### 2.5 `URLRequestHeader`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestHeader.html)）

`final`。封装**单个** HTTP 请求头（name/value 对）。

| 成员 | 签名 |
|---|---|
| `name` | `String` |
| `value` | `String` |
| 构造器 | `URLRequestHeader(name:String = "", value:String = "")` |

**受限头**（非应用沙箱下使用会抛运行时错误，**大小写不敏感**）：`Accept-Charset`、`Accept-Encoding`、
`Authorization`、`Connection`、`Content-Length`、`Cookie`、`Host`、`Referer`、`User-Agent`、
`x-flash-version` 等一长串（完整列表见官方页）。AIR 应用沙箱内可用任意请求头。
AIR 默认设 `ACCEPT` 头为一串 MIME 列表（除非你在 `requestHeaders` 里显式设 `ACCEPT`）。

### 2.6 `URLRequestDefaults`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestDefaults.html)）

**AIR 1.0**。静态属性定义 `URLRequest` 各属性的**默认值**（任何在 `URLRequest` 实例上设的值覆盖它）。

| 静态成员 | 默认 |
|---|---|
| `authenticate` / `cacheResponse` / `followRedirects` / `manageCookies` / `useCache` | 均 `true` |
| `idleTimeout` | 0 |
| `userAgent` | 随 OS/语言/版本而定的 UA 串 |
| `setLoginCredentialsForHost(hostname, user, password)` | 静态方法，设某主机的默认认证凭据（**全应用域生效**） |

> 仅 AIR 应用沙箱内容可使用，否则访问成员抛 `SecurityError`。

### 2.7 `URLVariables`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLVariables.html)）

**`dynamic class`**（未声明属性可动态添加）。用于在应用与服务器间传递变量，配合 `URLRequest.data`。

| 成员 | 签名 | 说明 |
|---|---|---|
| 构造器 | `URLVariables(source:String = null)` | **若传字符串，自动调用 `decode()`** |
| `decode` | `decode(source:String):void` | 「把变量串转成属性」；**非 URL 编码的 name/value 串会抛 `Error`** |
| `toString` | `toString():String` | 返回 **`application/x-www-form-urlencoded`** 编码的全部可枚举变量 |

### 2.8 `URLStream`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLStream.html)）

继承 `EventDispatcher`，**实现 `IDataInput`**。**低层**下载：**数据一到就可读**（不像 `URLLoader`
要等整个文件），且**可在下载完成前 `close()`**。内容按**原始二进制**提供。

- **读操作非阻塞**：必须先查 `bytesAvailable` 再读，数据不足则抛 `EOFError`。
- 字节序默认**大端**。安全规则与 `URLLoader` 相同。

| 成员 | 说明 |
|---|---|
| `bytesAvailable`（只读）| 输入缓冲中可读字节数 |
| `connected`（只读）| 是否连接中 |
| `endian` | 字节序（`Endian.BIG_ENDIAN`/`LITTLE_ENDIAN`，默认大端） |
| `objectEncoding` | AMF 版本 |
| `load(request)` / `close()` | 开始/立即关闭下载 |
| `read*` | `readBoolean`/`readByte`/`readBytes`/`readDouble`/`readFloat`/`readInt`/`readMultiByte`/`readObject`/`readShort`/`readUnsignedByte`/`readUnsignedInt`/`readUnsignedShort`/`readUTF`/`readUTFBytes` |

事件与 `URLLoader` 同族（`complete`/`open`/`progress`/`ioError`/`httpStatus`/`httpResponseStatus`/
`securityError`/`certificateError`）。**关键差异**：`progress` 时**数据已可读**；
「若有 `httpResponseStatus` 监听器，则错误响应也当内容派发 `progress`/`complete`，而不是 `ioError`」。

### 2.9 事件类

| 类 | 关键成员 |
|---|---|
| `HTTPStatusEvent`（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/events/HTTPStatusEvent.html)） | `status:int`（只读；**环境取不到状态码时恒为 0**）、`responseURL:String`、`responseHeaders:Array`、`redirected:Boolean`；常量 `HTTP_STATUS`/`HTTP_RESPONSE_STATUS`。**总是先于 error/completion 派发** |
| `SecurityErrorEvent` | 常量 `SECURITY_ERROR`、`CERTIFICATE_ERROR`（AIR 51）；`text:String` |
| `ProgressEvent` | `bytesLoaded:uint`、`bytesTotal:uint`；常量 `PROGRESS` |
| `IOErrorEvent` | `text:String`、`errorID:int`（AIR）；常量 `IO_ERROR`。运行时**自己生成**的事件带 AIR 的错误号（`2032`/`2035`/`2036`/`2124`）与逐字文案 `Error #N: <sentence>. URL: <url>`（八十九·五十九，实测矩阵见 §6.7.5）；`new IOErrorEvent(...)` 的 `errorID` 仍为 `0`（AIR 该构造器不接受错误号） |

### 2.10 包级函数与其余 `flash.net` 类

**包级函数**（[官方页](https://airsdk.dev/reference/actionscript/3.0/flash/net/package.html)）：

| 函数 | 签名 | 说明 |
|---|---|---|
| `navigateToURL` | `(request:URLRequest, window:String = null):void` | **AIR 里用默认系统浏览器打开 URL**；AIR 下 POST 被当 GET 处理 |
| `sendToURL` | `(request:URLRequest):void` | 发请求但**忽略响应** |
| `registerClassAlias` | `(aliasName:String, classObject:Class):void` | AMF 序列化时保留类信息 |
| `getClassByAlias` | `(aliasName:String):Class` | 按别名查类；未注册抛 `ReferenceError` |

**`flash.net` 完整类表**（官方 package-detail，用于界定「本包全部范围」）：
`DatagramSocket`、`FileFilter`、`FileReference`、`FileReferenceList`、`GroupSpecifier`、
`InterfaceAddress`、`IPVersion`、`LocalConnection`、`NetConnection`、`NetGroup`、`NetGroupInfo`、
`NetGroupReceiveMode`、`NetGroupReplicationStrategy`、`NetGroupSendMode`、`NetGroupSendResult`、
`NetMonitor`、`NetStream`、`NetStreamAppendBytesAction`、`NetStreamInfo`、`NetStreamMulticastInfo`、
`NetStreamPlayOptions`、`NetStreamPlayTransitions`、`NetworkInfo`、`NetworkInterface`、`ObjectEncoding`、
`Responder`、`SecureSocket`、`ServerSocket`、`SharedObject`、`SharedObjectFlushStatus`、`Socket`、
`URLLoader`、`URLLoaderDataFormat`、`URLRequest`、`URLRequestDefaults`、`URLRequestHeader`、
`URLRequestMethod`、`URLStream`、`URLVariables`、`XMLSocket`。

---

## 3. 现状盘点（实现 / 缺失 / 偏差）

> 核实方式：`grep` `src/symbols.ts`（类/字段/方法/常量注册）与 `src/emit.ts`（代码生成），逐项对照 §2。
>
> **本节已按阶段八十九·五十一（D/E/F/H）的实现后状态更新**——八十九·四十八 落地了 §5 路线的
> **A（语义层补全）+ B（`URLLoader` 契约补全）**（零网络依赖）；八十九·四十九 落地了
> **G（无网目标诚实 `ioError`）** 与 **C 的 native 竖直探针**（opt-in libcurl）；八十九·五十一 把
> C/D/E/F/H 全部落地：curl 内核补齐响应头 / 重定向计数 / 空闲超时 / `HEAD`、`URLLoader` 的完整
> 事件序列、web `fetch` 后端、`URLStream` 流式 job 与 `navigateToURL`/`sendToURL`。
> 原始盘点（A/B 之前）保留在表格的「改前」描述里，便于核查偏差是不是真的被消除了。
> **仍未做的**只剩需要第三方栈的重工程：**preview2 的 `wasi:http`**（原生 WASI 联网）与 **AMF**
> （`readObject`/`registerClassAlias`）。**socket/TLS 之上的其它协议**与**静态自包含打包**已于
> **阶段八十九·五十三** 落地（`Socket`/`ServerSocket`/`XMLSocket` 见 §7，静态 curl 见 §4.1）。
> **图片侧**：`Loader.load` 的 `http(s)://` 路径已于 **阶段八十九·五十四** 接到同一条 seam（§6.7.2 实测）。

### 3.1 已实现（A/B 之后的现状）

| 项 | 位置 | 现状 |
|---|---|---|
| `URLLoader.data`（`any`） | `symbols.ts:1236` | ✅ 格式随 `dataFormat`（text / binary / **variables**） |
| `URLLoader.dataFormat` | `symbols.ts:1237` | ✅ 三值全部生效（A/B 之前 `VARIABLES` 从不产出 `URLVariables`） |
| `URLLoader.bytesLoaded` / `bytesTotal` | `symbols.ts:1238` | ✅ **新增**：加载中恒 `0`、完成时置为字节数（AIR 口径） |
| `URLLoader(request)` 构造参数 | `symbols.ts:1249` / `emit.ts:4168` | ✅ **新增**：传入即开始加载（AIR） |
| `URLLoader.load()` | `emit.ts:4266` | ✅ **http(s) 三目标分叉**：native+`ASC_HAVE_CURL` 走 libcurl、web+`ASC_HAVE_FETCH` 走浏览器 `fetch`、其余目标派**可区分**的诚实 `ioError`；非 http 的 `file://`/相对路径仍走本地 `fopen`（`file://` 前缀会剥掉）。见 §4.1.2 / §5 |
| `URLLoader` 事件 | `emit.ts:4228`（job finish） | ✅ 完整序列（八十九·五十二 按 `adl` 实测校正）：`open`（仅当请求真的到达传输）→ 〔`httpResponseStatus` 仅当状态 `> 0`，带 url/头/`redirected`〕→ **重放的 `progress`**（后端记录的字节水位）→ 末次 `progress` → `data` 填充 → `httpStatus`（**只带 `status`**，非 HTTP 加载为 `0`）→ `complete`。**4xx/5xx 是成功加载**（404 也 `complete`，`data` = 错误正文）——**仅当注册了 `httpResponseStatus` 监听器时**（见 §6.7.5 与 TODO 遗留表）；传输失败路径：〔`open` 若已 started〕→ `httpStatus(0)` → `data` = **空值**（非 `null`）→ 带 AIR 错误号 `#2032` 的 `ioError`（`Error #2032: Stream Error. URL: <url>`，阶段八十九·五十九；其余失败同号，实测见 §6.7.5）。⚠️ `securityError`/`certificateError` 仍未派（没有会拒绝的源），`REDIRECT` 事件未建模（`redirected` 标志已填） |
| `URLLoader.close()` | `emit.ts:4397` | ✅ **真中止**（A/B 之前是空函数）：取消在飞 job，不再派发任何终止事件；无流时抛 AIR 的 invalid stream error |
| `Loader.load()`（图片，`flash.display`） | `emit.ts:4013` | ✅ **http(s) 与本地同一条传输 seam**（八十九·五十四，web 侧于八十九·五十六接通）：URL 前缀在提交时分流——`AS_JOB_IMAGE_URL` 走传输后端（native `ASC_HAVE_CURL` 在 worker 上 `as_http_perform`；web `ASC_HAVE_FETCH` 启动 `fetch`、体在帧边界 pump 里解码），本地路径仍是 `AS_JOB_IMAGE`（读文件 + 解码）；失败派 `ioError` 且带 **AIR 的错误号**（八十九·五十九）：本地缺失 `#2035`、传输失败或 HTTP≥400 `#2036`、载荷非图片 `#2124`、无后端 `0`（AIR 无此状态），文案为 AIR 逐字的 `Error #N: <sentence>. URL: <url>`；成功内容作为 Loader **自身的子对象**入显（`numChildren == 1`）。实测见 §6.7.2 / §6.7.4 / §6.7.5 |
| `URLRequest.url` | `symbols.ts:1184` | ✅ |
| `URLRequest.method` | `symbols.ts:1185` | ✅ 真实状态，且**真的生效**（native/web 后端都消费它：`HEAD` 走 `NOBODY`、`POST/PUT/...` 发 body、`GET` 折叠 query） |
| `URLRequest.data` | `symbols.ts:1186` | ✅ 真实状态；GET 折叠进 query、其余方法作 body（`ByteArray` 与 `URLVariables` 都支持，服务端回显见 §6.4） |
| `URLRequest.contentType` | `symbols.ts:1187` | ✅ **属性默认 `NULL`**（与 adl 一致；A/B 阶段曾按文档改成 MIME 串，八十九·六十九 已按实测回退）；**发包口径另算**：体非空的请求且未声明（或声明为 `""`）时按 adl 的 wire 默认发 `application/x-www-form-urlencoded`，无体请求一个都不发，见 §6.7.7 |
| `URLRequest` 的 8 个 AIR 属性 + `digest` | `symbols.ts:1189`–`1199` | ✅ **新增**（`requestHeaders` 初始为空 `Array`，兼容 Adobe 文档里的 `.push()` 用法）；其中 `followRedirects`/`idleTimeout` **真的生效**（curl 侧映射为 `CURLOPT_FOLLOWLOCATION` / 低速限制对，web 侧映射为 `redirect: 'follow'/'manual'` 与 `AbortSignal.timeout`），`userAgent`/`contentType` 进请求头 |
| `URLRequest.useRedirectedURL()` | `symbols.ts:1203` / `emit.ts:4140` | ✅ **新增**，按官方文档语义：先做域名/整段替换，再做 `pattern`→`replace`；String 与 RegExp 两种 `pattern` 都支持 |
| `URLRequestDefaults`（7 个静态属性） | `symbols.ts:1326` / `emit.ts:4087` | ✅ **新增**，静态 getter/setter 背后是手写 C 全局量；`URLRequest` 构造时从它读默认值（官方口径）。`setLoginCredentialsForHost` 仍延后（需认证型 HTTP 栈） |
| `URLRequestMethod`（6 常量） | `symbols.ts:1266` | ✅ **新增** |
| `URLRequestHeader`（`name`/`value`） | `symbols.ts:1277` | ✅ **新增**（构造器默认 `""`/`""`） |
| `URLVariables`（`dynamic`、`ctor(source)`、`toString()`、**`decode()`**） | `symbols.ts:1363` / `emit.ts:4336` | ✅ 动态类 + 构造 + `toString` + **`decode()`（新增）** 均落地 |
| `URLLoaderDataFormat`（TEXT/BINARY/VARIABLES） | `symbols.ts:1342` | ✅ 三常量 |
| `HTTPStatusEvent`（`status`/`responseURL`/`responseHeaders`/`redirected`） | `symbols.ts:1954` / `emit.ts:3780` | ✅ **四个属性全填**（八十九·五十一）：`status` 取响应状态码；`responseHeaders` 由后端首块前的头区解析成 `URLRequestHeader` 数组（**web 侧键名被浏览器规范化为小写**，如实反映）；`responseURL` 是**有效 URL**（重定向后的最终地址，GC 拷贝而非指向 job）；`redirected` 由后端重定向计数给出。**两个事件分工**（八十九·五十二）：`httpStatus` **只带 `status`**（`responseURL=null`、`responseHeaders` 空数组、`redirected=false`），`httpResponseStatus` 才带 url/头/`redirected`；4xx/5xx 是成功加载且派 `complete` |
| `URLStream`（`load`/`close`/13 个 `read*`/`bytesAvailable`/`connected`/`endian`/`objectEncoding`） | `symbols.ts:1385` / `emit.ts:4450` | ✅ **新增**（八十九·五十一）：流式 job，`bytesAvailable` 随数据到达增长，`read*` 非阻塞且数据不足抛 `EOFError #2030`，「根本没打开」抛普通 `Error`；`close()` 抛 `#2029`；完成时把未消费余量**拷贝**成 GC `ByteArray` 后清 `_job`（拷贝在派终态事件之前，监听器读得到尾巴）。`readObject` 未实现（AMF 依赖 ObjectEncoding，见 §3.2） |
| `SecurityErrorEvent`（`SECURITY_ERROR`、`text`） | `symbols.ts:1978` | ⚠️ **仍从不被派发**（本机即 AIR 的应用沙箱语义，没有会拒绝的源）；缺 `CERTIFICATE_ERROR`。另见 §4.4 |

### 3.2 仍未实现（A/B 之外）

| 类 / 函数 | 缺口 |
|---|---|
| `URLStream.readObject` | ❌ 唯一缺的读方法是 AMF 反序列化（依赖 `objectEncoding` 与 `registerClassAlias`，与 §3.2 的 AMF 一族同批） |
| `registerClassAlias`/`getClassByAlias` | ❌（AMF 序列化专属，与 `readObject`/`writeObject` 同批） |
| `DatagramSocket`（UDP） | ❌ 未实现（与 TCP 底座不同，独立立项） |
| `Socket`/`SecureSocket`/`ServerSocket`/`XMLSocket` | ✅ **已落地（阶段八十九·五十三）**：TCP 底座 + 完整 `IDataInput`/`IDataOutput`；`SecureSocket` 仅 API 面 + 诚实失败（`isSupported=false`，TLS 状态机未做）。语义详见 §7 |
| `FileReference`/`FileReferenceList`/`FileFilter` | ❌ |
| `LocalConnection`/`NetConnection`/`NetStream`/`NetGroup*` | ❌（`NetStream` 仅有 dynamic `client` 槽，见 `symbols.ts:2451`） |
| `NetworkInfo`/`NetworkInterface`/`InterfaceAddress`/`IPVersion`/`Responder` | ❌ |
| 静态自包含打包（含 curl 的 `vendor/` 静态库） | ✅ **已落地（阶段八十九·五十三）**：`vendor/curl` 提供 `libcurl.a`/`libnghttp2.a`/`libz.a`，`otool -L` 不再出现 `libcurl.4.dylib`（见 §4.1） |
| 代理 / cookie jar / HTTP-2 | ✅ **已落地（阶段八十九·五十三）**：进程级 `CURLSH` 共享 cookie（`URLRequest.manageCookies`）、环境变量与**系统代理**两路、`ASC_HTTP2` opt-in（默认仍 1.1，见 §4.1） |
| WASI preview2 `wasi:http` | ⚠️ 未做（preview1 无 socket 原语，诚实 `ioError` 是当前终态，见 §5-G） |

### 3.3 一句话总结偏差

> **本项目当前的 `URLLoader` 是「本地文件读取器」套了一个 HTTP API 外壳**：URL 当路径、
> `close()`（改前）是空操作。阶段八十九·四十八 消除了其中**误导性**的那部分：
> `method`/`data`/`contentType` 不再是死字段，`URLRequestMethod`/`URLRequestHeader`/
> `URLRequestDefaults` 三类齐全，`open` 事件会派，`bytesLoaded`/`bytesTotal` 存在，
> `close()` 真的中止，`dataFormat=VARIABLES` 真的产出 `URLVariables`。
>
> 阶段八十九·四十九 又把它从「外壳」推进到**两个诚实的端点**：
> (a) **接上后端就真联网**（native + `ASC_HAVE_CURL`，GET/POST/状态码/HTTPS 全通，探针见 §6.2）；
> (b) **不接后端就诚实报错**（`http(s)://` 派可区分的 `ioError`，不再与「文件不存在」共用文案）。
> 默认构建仍是**零依赖、自包含、无网络**的形态——后端是 opt-in 的 `ASC_HAVE_CURL`。
>
> 阶段八十九·五十一 把它推到了**三目标都有明确答案**的终态：native（libcurl）与 web（`fetch`）
> **真联网且语义对齐**（同一族 AS3 探针在两端逐条断言通过，§6.4/§6.5/§6.6），无后端目标
> **诚实报错**且错误文案指明缺什么、去哪查。`URLStream` 的流式语义（增量可见 + 非阻塞读）
> 在两端一致；`navigateToURL` 在 native 走 `fork+exec`（**不经 shell**）、在 web 走 `window.open`、
> 在 WASI 明确报 `#2032`。
>
> 阶段八十九·五十三 补上了**另一条腿**：socket/TLS 之上的其它协议（§7）与静态自包含打包（§4.1）
> ——`Socket`/`ServerSocket`/`XMLSocket` 按 AIR 实测语义落地，native 构建不再有 `libcurl.4.dylib` 运行时依赖。
>
> 阶段八十九·五十四 把**图片**也接上了同一条 seam：`Loader.load(http(s)://…)` 不再被当成本地路径
> `fopen`（那时报的是「文件读不到」——对**错误原因**的诚实），而是真下载 + 解码上屏；连带修掉一处**真错**
> ——内容只挂 `loader.content` 而不入 Loader 的 children，渲染器沿容器 children 走，**一个像素都不画**。
>
> **仍不完整且不假装完整的**：`securityError` 仍不派（没有会拒绝的源）；`readObject`/AMF 一族；
> preview2 的 `wasi:http`；`SecureSocket` 的 **TLS 状态机**（`isSupported` 恒 `false`、`connect()`
> 派 `#2031`，绝不静默明文连接）；`DatagramSocket`（UDP）；`ServerSocket.accept()` 之外 AIR 无的
> 同步接受路径属**本子集增补**（AIR 只有事件派发，本实现两条路都可走、每个连接只交付一次）。

---

## 4. 关键技术难点

### 4.1 难点一：HTTPS/TLS 是真正的门槛，不是 HTTP 本身

明文 HTTP/1.1 客户端（TCP + 请求行/头/体 + 响应解析）是标准活，不难。但**现实中的 URL 几乎都是
`https://`**，而 AIR 的 `URLRequest` 明确支持 `http` **和** `https`。这就引入 TLS：证书链校验、
SNI、ALPN、系统根证书库。

按 AGENTS.md §2.9「重活链接成熟库、不重复造轮子」的原则，可选：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **平台网络 API** | macOS `NSURLSession` / Windows `Schannel` / Linux 平台栈 | 免维护 TLS，但**每平台一套胶水**，且行为细节（超时/重定向）受平台控制 |
| **一库到底：libcurl** | `link-libs: curl`，一份代码跨 macOS/Linux/Windows（TLS 后端按平台自动选 SecureTransport/Schannel/OpenSSL） | **native 三平台一份实现**；代价是根证书来源与体积。**这是 TypePHP 的实际选择**（见 §4.1.1） |
| **自建 socket + 链接 TLS 库** | `mbedTLS` / `OpenSSL` / `wolfSSL`（`link-libs`） | 控制力最强、体积可裁，但 HTTP/1.1 请求构造与响应解析要**自己写全** |
| **纯明文 HTTP** | 不支持 `https` | 语义不完整，只能作阶段一验证 |

> 结论：**TLS 选型是立项时的第一个决策点**。若求「native 一份实现」，首选**直接链接 libcurl**
> （HTTP/1.1 + TLS + 重定向 + 代理一体，与 TypePHP 同路）；明文 HTTP 仅作阶段一验证用，不作终态。
> **引入方式（系统库 vs `build-tools/`→`vendor/` 自编）见 §4.1.2。**

#### 4.1.1 前置疑问：有没有「一套通用库适配所有终端」？——**没有**，边界在传输层

选型前必须先钉死一件事：**「TLS 库可移植」不等于「网络可移植」**。`mbedTLS` / `wolfSSL` /
`BearSSL` / `OpenSSL` 都是可移植 C、都能编译到 wasm；但在 web 与 WASI 上它们**没有 socket 可挂载**
——缺的是**传输层**，不是 TLS 原语。因此「一套库覆盖 native + web + WASI」在原理上**不成立**。

可移植性矩阵（✅ 可用 / ⚠️ 能编译但无处落地 / ❌ 不可用）：

| 候选 | native（macOS/Linux/Windows） | web（Emscripten） | WASI **preview1**（本项目现目标） | WASI **preview2**（TypePHP 目标） |
|---|---|---|---|---|
| **libcurl** | ✅ 一份代码三平台（TLS 后端自动选） | ❌ **Emscripten 官方无 curl port**（`tools/ports/` 只有 zlib/libpng/SDL 等） | ❌ 无 socket 原语 | ❌ TypePHP 在 WASI 下**整体禁用 curl** |
| **mbedTLS / wolfSSL / BearSSL** | ✅ | ⚠️ 可编译，但**浏览器禁裸 TCP**，无传输可挂 | ❌ 同上 | ❌ 同上 |
| **OpenSSL** | ✅ | ⚠️ 同上（且体积大） | ❌ | ⚠️ TypePHP 仅 **crypto-only，无 TLS stream transport** |
| **浏览器 `fetch` / XHR** | ❌（非浏览器环境） | ✅ **唯一可行**；TLS/CORS/重定向由浏览器代管 | ❌ | ❌ |
| **宿主 `wasi:http`**（Component Model） | ❌ | ❌ | ❌ preview1 无此接口 | ✅ **唯一可行**（TypePHP 的实际选择） |

**证据（非推测）**：

- Emscripten 官方 Networking 文档原文：*"direct access to TCP sockets is not possible from web
  browsers"*、*"For HTTP transfers, one can use the browser built-in XmlHttpRequest (XHR) API and the
  newer Fetch API"*；且官方端口清单（`emscripten-core/emscripten/tools/ports/`）中**不存在 curl**。
- **TypePHP 的实际姿态**（它已把同一问题解完，取舍可直接照抄）：
  - **native**：构建清单 `link-libs: - curl`（真 socket + TLS）；扩展模式 `ext-deps: - curl`
    （官方 README 注明 *"Zend 扩展依赖，不是原生链接库"*）。
  - **Nano（无 VM 极简运行时）**：官方明说 *"不提供 socket、DNS、网络、远程 stream"*——**直接没有网络能力**。
  - **WASI**：*"OpenSSL 采用 crypto-only 构建，不包含 TLS stream transport；HTTP/HTTPS 仍由 WASI HTTP
    Component 提供"*；并整体关闭 PHPX Facade，*"避免把 curl、socket、Swoole 等不可用 API 暴露为
    '可编译但链接失败'的接口"*，*"静态可识别的调用会在编译期报致命错误"*。

**对本项目的直接含义**：`URLLoader` 的 HTTP 路径**只能**做成「**一个抽象 seam + 三份后端**」——
 native 走 libcurl（或自建 socket+TLS 库）、web 走 `fetch`、WASI preview1 **诚实报 `ioError`**
（要走 `wasi:http` 须先升级到 preview2 + Component Model，那是独立大工程，见 §5 阶段 G）。这正是
§4.2「三目标分叉」的结论；本小节只是把「有没有通用库」这个前置疑问**用证据钉死——答案是没有**。

#### 4.1.2 获取与引入方式：先分清 `build-tools/` 与 `vendor/`，libcurl **不一定要自己编**

> **问题（用户批注）**：libcurl 是否需要先下载到 `build-tools/`，再编译到 `as3compiler/vendor/`？
>
> **答**：**不是必须**。分两条路——先用系统库（零下载、零 vendor），要静态自包含才走
> `build-tools/` → `vendor/`。下面先把两个目录的角色钉死（这是仓库既有分工，**不是 libcurl 专属规则**）。

**仓库既有分工**（见 [`compile.md`](compile.md) §构建清单、[`skia.md`](skia.md) §6.1）：

| 目录 | 角色 | 现有内容 |
|---|---|---|
| `build-tools/` | **构建输入区**：需要自己重编的**源码 + 工具链**，**不参与运行时链接** | `skia-src/`（完整 Skia 源码，gn+ninja 可重编）、`emsdk/`（Emscripten 工具链） |
| `as3compiler/vendor/` | **消费区**：**预编译产物**，构建清单 `include-paths`/`link-paths`/`link-libs` 指向此处 | `skia/{include,lib/macos-arm64,lib/wasm}`、`sdl2/arm64/{include,lib}`（静态 `.a`）、各胶水 `.cc/.mm` + `.o` |

即既有范式是「**要重编的源码放 `build-tools/`，编好的静态库落 `vendor/<lib>/<platform>-<arch>/{include,lib}`**」
——Skia 之所以走这条路，是因为官方预编译包不含 Metal，**必须自己重编**。libcurl 未必如此。

**路线一（首期推荐）：用系统库——零下载、零编译、零 vendor**

macOS **自带 libcurl**：SDK 内含 `usr/lib/libcurl.tbd`（动态 stub）与 `usr/include/curl/*.h`。
构建清单只需 `link-libs: ["curl"]`，**连 `include-paths`/`link-paths` 都不用加**（SDK 路径本就在默认搜索路径）。

实测（`cc -O2 probe.c -lcurl`，**无任何 `-I/-L`**）：

| 检查项 | 结果 |
|---|---|
| 编译链接 | ✅ 成功（零下载、零外部依赖） |
| 运行时依赖 | `otool -L` → `/usr/lib/libcurl.4.dylib`（**动态**链接系统库） |
| 版本 / TLS 后端 | `curl 8.7.1` · `SecureTransport (LibreSSL/3.3.6)` |
| `https` 协议支持 | ✅ yes |
| 真实 HTTPS 请求 | `https://example.com/` HEAD → `HTTP 200`，`curl_easy_perform` 返回 `CURLE_OK` |

- **代价**：**动态链接**（运行时依赖系统 dylib，产出的二进制**不自包含**）；版本随 OS 漂移（本机 8.7.1）；
  **只覆盖 macOS**——Linux 需系统 `libcurl-dev`，**Windows 无系统 libcurl**。
- 适用：本地开发、native 首期验证、阶段 C/D。**此路完全不碰 `build-tools/` 与 `vendor/`**。

> **路线一已实测接入（阶段八十九·四十九）**：`URLLoader` 的 `http(s)://` 路径已按本小节接上
> 系统 libcurl，并跑通真 GET/POST/404/HTTPS（复现见 §6.2）。三条路线的取舍不再是估计：
>
> | 观察项 | 实测结果 |
> |---|---|
> | 自包含性 | ❌ **确实被打破**：`otool -L` → `/usr/lib/libcurl.4.dylib`（动态链接系统库） |
> | 二进制体积 | **+600 B**（111,320 vs 110,720）——库不进二进制，故代码本身几乎不变 |
> | 生成 C | **同一份**：分叉全在编译宏 `ASC_HAVE_CURL`（未定义时同一份 C 退回诚实 `ioError`） |
> | 跨目标 | ⚠️ **曾失败**（阶段八十九·四十九探针）：同一份构建清单喂给 wasm 直接 `wasm-ld: unable to find library -lcurl`——因为 `link-libs` 当时不按目标条件。**已于阶段八十九·五十 解除** |
>
> 该约束曾是本项最具约束力的构建层发现。**阶段八十九·五十 已落地构建清单 `targets` 覆盖块**
> （[`compile.md`](compile.md) §4.1）：顶层为公共默认，`targets.<目标>` 块按目标**整体替换**字段，
> 故一份清单即可 native 链接 curl、wasm 去掉它（实测见 §6.3）。这是「路线二（`vendor/` 里放静态
> 自包含库）」之外、任何联网落地都绕不开的构建层工作，现已就位。

> **路线二已落地（阶段八十九·五十三）**：`build-tools/curl-src/build-static.sh`（curl 8.11.1 +
> nghttp2 1.64.0 + zlib 1.3.1；nghttp2 需 `-DENABLE_TESTS=OFF -DBUILD_TESTING=OFF`）产出静态库入
> `vendor/curl/{include,lib/macos-arm64}`；构建清单 native 层改指 `vendor/curl`，并用新增的
> `--framework` CLI 标志补齐 macOS 系统框架。实测：`otool -L` 不再出现 `libcurl.4.dylib`/`libz.dylib`，
> `examples/url-test` 输出与动态链接版**逐字节一致**。
>
> **代理 / cookie jar / HTTP-2 同阶段落地**：cookie jar 走进程级 `CURLSH`（`CURL_LOCK_DATA_COOKIE`
> \+ `pthread_once`，配 `CURLSHOPT_LOCKFUNC`/`UNLOCKFUNC`）+ 每次传输 `CURLOPT_SHARE`，由
> `URLRequest.manageCookies`（AIR 默认 `true`）开关；代理两路——**环境变量**（`http_proxy` 等，
> libcurl 原生处理）与**系统代理**（读 `SCDynamicStoreCopyProxies`，受 `ASC_SYSTEM_PROXY` 门控）。
> 系统代理必须放在**独立编译单元**：`<SystemConfiguration/SystemConfiguration.h>` 会牵入
> `MacTypes.h` 的 `struct Point`，与生成 C 中 `flash.geom.Point` 的结构体**硬冲突**（构建层新发现；
> `vendor/sysproxy_glue.c` + 新增 `--source` 标志，生成 C 只留 `extern` 声明）。实测端到端：
> `http://example.invalid/` 在 `ASC_SYSTEM_PROXY` 开时 `httpStatus(502); complete;`（代理应答），
> 关时 `httpStatus(0); ioError;`。**HTTP/2 是 opt-in 的 `ASC_HTTP2`，默认仍钉 `HTTP/1.1`**——
> h2 会规范化响应头名并省略连接级头，对 AS3 可见即保真差异（AIR 的传输本就是 HTTP/1.1）。

**路线二（自包含 + 跨平台一份实现）：才走 `build-tools/` → `vendor/`**

当需要**静态单文件可执行**、或**一份实现跨 macOS/Linux/Windows** 时，才按 Skia/SDL2 同款范式：
源码放 `build-tools/`（如 `build-tools/curl-src/`）+ 交叉工具链，静态库产物落
`vendor/curl/<platform>-<arch>/{include,lib}`，构建清单 `include-paths`/`link-paths`/`link-libs` 指过去。

- **为何必须自编**：SDK 里**只有 `.tbd` 动态 stub，没有 `libcurl.a`**（`find Xcode -name "libcurl*.a"` 为空）
  —— 想要静态就只能从源码编。
- **真正的工作量不在 curl，而在它的传递依赖**：TLS 后端（mbedTLS/wolfSSL/OpenSSL/SecureTransport）
  \+ `zlib` + `brotli` + `zstd` + `nghttp2` + `libidn2`/PSL，且要**逐平台交叉编译**。
  建议走最小档：`curl + mbedTLS（或 wolfSSL）+ zlib`，并显式
  `--without-brotli --without-zstd --without-nghttp2 --without-libpsl --disable-ldap --disable-ssh2`。

> **与本项目阶段的关系**：本决策**属阶段 C**（见 §5）。**阶段 A/B 与网络无关，现在不需要下载或编译任何东西**
> —— §4.1 所说「TLS 选型是立项第一个决策点」，其完整形状就是本小节的两条路线。

### 4.2 难点二：三目标分叉（同一份 AS3，三种能力）

| 目标 | 能力 | 落地方式 |
|---|---|---|
| **native**（macOS/Linux） | 完整 TCP + TLS | 自建 socket + TLS 库（或平台 API） |
| **web**（Emscripten/wasm） | **不能开裸 socket**；只能 `fetch()`（XHR） | 走浏览器 `fetch`——TLS/CORS/重定向由浏览器处理；**受限头无法设置**、**跨域需服务器 CORS 头** |
| **WASI**（preview1） | **无 socket 原语** | **诚实报 `IOError`**（不假装成功，AGENTS.md §2.5） |

这意味着 `URLLoader` 的 HTTP 路径必须像现有的窗口/字体后端一样**按目标分派**，且
**「web 上因 CORS 失败」与「native 上因网络失败」都要落成同一个 `ioError` 语义**，而不是各造一套。

### 4.3 难点三：与既有「异步 job + 帧边界」体系的关系（正向）

本项目已有成熟的**异步 job 系统**（阶段八十九·四十五）：job 表 + native pthread 池 + 帧边界
`as_async_tick()` 发布结果（见 [`as3-semantics.md`](as3-semantics.md) §3、`examples/async-io.as`）。
HTTP 加载**天然契合**这套体系，但有一个**升级点**：

- 现有 job 是**一次性**的（读完 → 一个结果 → 一个 `complete`）。
- HTTP 需要**增量**：`open` → 多个 `progress`（`bytesLoaded` 递增）→ `complete`；
  且 `ProgressEvent.bytesTotal` 依赖 `Content-Length`（缺则「不可确定」，见 §2.1）。
- `URLStream` 更进一步：**读是非阻塞的、数据随时可取**（`bytesAvailable`）——这要求 job 缓冲
  **对 AS3 侧可见地增长**，而不是「攒完再一次性交回」。这与「worker 绝不碰 GC 堆」的不变式
  需要重新设计（缓冲留在 malloc，主线程按 `bytesAvailable` 逐段搬）。

> 结论：现有 job 系统能复用骨架（提交/认领/finish thunk/GC 根），但**要新增「流式 job」形态**
> （多个中间发布点），而不是只用一次性 job。这是本项调研对既有架构的**唯一实质性影响**。

### 4.4 难点四：安全模型（AIR 是真有沙箱的）

AIR 的 `URLRequest`/`URLLoader` 文档里大量篇幅在讲**安全沙箱**：跨域需 URL policy 文件、
受限请求头列表、保留端口、本地不可信文件不得联网、`certificateError` 可 `preventDefault()` 放行。
本项目作为**桌面 AOT 运行时（run 在应用沙箱，等价于 AIR 应用沙箱）**，合理简化是：

- **应用沙箱内可任意 method / 任意请求头**（对齐 AIR 应用沙箱行为）；
- **不做**跨域 policy 文件、保留端口限制（那是浏览器/Flash Player 的约束）；
- `certificateError` 可**先不实现**（无 UI 承载证书交互），失败落 `ioError` 并如实报错。

> 这样既保持语义自治，又不引入无法验收的沙箱交互。

---

## 5. 建议的分阶段路线（对应现有「阶段XX」约定）

| 阶段 | 目标 | 依赖网络？ | 风险 | 状态 |
|---|---|---|---|---|
| **A 语义层补全** | `URLRequestMethod`（6 常量）、`URLRequestHeader`、`URLRequestDefaults`、`URLVariables.decode()`、`URLRequest` 8 个 AIR 属性、`useRedirectedURL()` | 否 | 低 | ✅ **已完成（阶段八十九·四十八）** |
| **B URLLoader 契约补全** | `bytesLoaded`/`bytesTotal`、`URLLoader(request)` 构造参数、`open` 事件、`close()` 真中止、`dataFormat=VARIABLES` 产出 `URLVariables` | 否（走现有本地 job） | 低 | ✅ **已完成（阶段八十九·四十八）**；其中「补派 `securityError`」**未做**——见下注 |
| **C HTTP 客户端内核（native）** | **链接 libcurl**（HTTP/1.1 + TLS + 重定向 + 代理一体，见 §4.1.1）或自建 socket + TLS 库；含响应解析（状态行、头、`Content-Length`/chunked/连接关闭）。**引入方式见 §4.1.2**：首期可零 vendor 直接用 macOS 系统 libcurl，要静态自包含再走 `build-tools/`→`vendor/` | **是** | **高（TLS）** | ✅ **已完成（八十九·五十一）**：全部动词（`GET`/`POST`/`PUT`/`HEAD`→`NOBODY`/…）、响应头区、`Content-Length`→`bytesTotal`、有效 URL + 重定向计数、`followRedirects`、`idleTimeout`→低速限制对、按请求头（含 UA/`Content-Type`）；TLS 由 libcurl 代管（真 `https` 探针见 §6.2）。**代理、cookie jar、HTTP/2（opt-in）与静态自包含已于八十九·五十三 落地**（见 §4.1） |
| **C 前置：按目标分层链接（构建层）** | 构建清单 `targets` 覆盖块：顶层为公共默认，`targets.<目标>` 按目标整体替换字段，使**一份清单**服务链接集互斥的多目标 | 否 | 低 | ✅ **已完成（阶段八十九·五十）**，见 [`compile.md`](compile.md) §4.1 |
| **D native 对接 `URLLoader`** | `http(s)://` 走网络、`file://`/相对路径仍走文件；GET（`data` 拼 query）/POST（`data` 进体）；`httpResponseStatus`/`httpStatus` 派发；`method` 真的生效 | 是 | 中 | ✅ **已完成（八十九·五十一，语义于八十九·五十二 按 `adl` 实测校正）**：完整事件序列 `open`→[`httpResponseStatus` 仅当有响应头]→**重放的 `progress`**→末次 `progress`→`data`→`httpStatus`→`complete`。**两处关键校正**：① **4xx/5xx 是成功加载**——404 → `complete`，`data` 为错误页正文（`ioError` 只留给**传输失败**：拒连/DNS/TLS/CORS）；② `httpStatus` **只带 `status`**（`responseURL=null`、`responseHeaders` 空数组、`redirected=false`），`responseURL`/头/`redirected` 全在 `httpResponseStatus` 上；③ 每次加载都以一个 `httpStatus` 收尾（非 HTTP 加载为 `status 0`）。`HTTPStatusEvent` 四属性全填；`URLVariables`/`ByteArray` 体都跑通（§6.4、§6.7） |
| **E web 后端** | 改 `fetch`；CORS/受限头差异在胶水内处理；失败统一 `ioError` | 是 | 中 | ✅ **已完成（八十九·五十一，语义于八十九·五十二 校正）**：`fetch` 拉取模型 + 帧边界 pump；**与 native 同一族断言 15/15 通过**（§6.5），含 CORS 拒绝文案与跨源 404；`ASC_HAVE_FETCH` opt-in |
| **F `URLStream`** | 流式 job（增量 `bytesAvailable` + 非阻塞 `read*` + `EOFError`） | 是 | 中高 | ✅ **已完成（八十九·五十一）**：流式 job kind + 增量 drain（native 实测 6 批、web 实测 6 批）、13 个 `read*`（缺 `readObject`）、`close()` 真中止并抛 `#2029`、完成时拷贝尾巴 |
| **G WASI / 无网目标** | 显式识别远程 scheme；无后端时派**可区分**的 `ioError`（不再与「文件不存在」共用文案） | — | 低 | ✅ **已完成（阶段八十九·四十九）**；web 侧反向对照见 §6.5 |
| **H `navigateToURL`/`sendToURL`** | 打开系统浏览器（native `open`/`xdg-open`；web `window.open`）；`sendToURL` 忽略响应 | 是 | 低 | ✅ **已完成（八十九·五十一）**：native `fork`+`exec`（**单 argv、不经 shell**——URL 是应用输入，进 shell 就是命令注入洞）、web `window.open`、WASI 诚实报 `#2032`；空请求抛 `Error`（§6.6） |
| **I 端到端验收** | 本地 HTTP 服务器 GET/POST 往返 + `mxmlc + adl` 对照 + 反向对照 | 是 | 中 | ✅ **已完成（八十九·五十二）**：真实 `examples/url-test` 在 `mxmlc + adl` 与本项目 `--air-app --run` 下各跑一次，**登录 POST + 统计 GET 逐项一致**（§6.7.1）；反向对照（默认构建无后端）两处请求都落诚实 `ioError`。C/D/E/F/H 各自的验收见 §6.2–§6.6 |

> **段落序号约定**：本表沿用「阶段八十九·N」的全局小步编号（与 `TODO.md` 一致）。
> 八十九·四十八 = A/B；四十九 = G + C 探针；五十 = 构建清单 `targets` 分层；
> **五十一 = C 内核补全 + D/E/F/H**；**五十二 = AIR 语义保真校正 + 端到端验收（I）**（验收见 §6.2–§6.7）。
> **表外的后续（同一条 seam 的延伸）**：**五十三 = 静态自包含 + 代理/cookie/HTTP-2 + socket 层**（§4.1/§7）、
> **五十四 = `Loader.load` 的 `http(s)` 图片**（图片后端复用 `as_http_perform`，验收见 §6.7.2）。

> **A / B 两项与网络无关**，是「把 API 面补齐」——已按此优先级先做（阶段八十九·四十八），
> 消除了「设了 `POST` 却毫无反应」「`close()` 是空函数」「`CONTENT_TYPE` 默认 null」这类**误导性**偏差，
> 且未引入任何新后端。
> **G 与 C 的 native 探针随后落地（阶段八十九·四十九）**：G 让「无后端」的失败变得**可诊断**（远程 URL
> 不再与缺失文件共用一句错误），C 的探针则用真实代码回答了「接上 libcurl 是什么形态、代价多大」
> （§4.1.2 / §6.2）——**两件事都不改变默认构建**：后端是 opt-in 的 `ASC_HAVE_CURL`，不声明就仍是
> 零依赖、自包含、无网络的形态。
> D 之后的完整网络工程里，本轮（八十九·五十一）又落掉了 web `fetch`、`URLStream` 流式 job、
> `navigateToURL` 与 C 内核补全；**剩下的**是「需要第三方栈的重工程」：静态自包含（`vendor/` 静态 curl）、
> 代理/cookie jar/HTTP-2、socket/TLS 之上的其它协议、preview2 的 `wasi:http`、AMF（`readObject`）。
> **阶段八十九·五十 补齐了 D→I 的构建层前置**：构建清单 `targets` 覆盖块落地后，「一份清单跨 native/wasm」
> 不再需要为每个目标维护一份清单（[`compile.md`](compile.md) §4.1）。
>
> **关于 B 里的「补派 `securityError`」**：A/B 期间**有意不做**。驱动 `SecurityErrorEvent` 需要
> 一个「会拒绝的源」，而在本运行时的语义下（本机 = AIR 应用安全沙箱，§4.4）不存在这种源，
> 强行派发反而会造出一个 AIR 不会有的假信号。它应该跟 C/D 的跨源/证书失败路径一起落地。
> 同理 `HTTPStatusEvent` 已在**阶段八十九·五十一**四个属性全填（`status`/`responseHeaders`/`responseURL`/`redirected`），
> 并在 native 与 web 两端都有真值断言（§6.4/§6.5）；AIR 的 `REDIRECT` 事件仍未建模（`redirected` 标志已填）。

---

## 6. 验收与反向对照

按项目既有约定（AGENTS.md §2.7、`examples/*.as` + 反向对照）：

### 6.1 阶段 A/B 的验收（可 headless）——**已执行**

- `examples/http-request-api.as`：`URLRequestMethod` 6 常量、`URLRequestHeader` name/value、
  `URLRequestDefaults` 7 个静态默认值 + 改默认后新建的 `URLRequest` 能读到、`URLRequest` 的 8 个
  AIR 属性与 `digest`、`requestHeaders` 是可 `push` 的空 `Array`、`URLVariables.decode()`
  （值 decode / 键不 decode / 可重入）、`useRedirectedURL()` 的四种形态（默认域名替换、
  `wholeURL`、String `pattern`、RegExp `pattern`，并断言 pattern 在替换**之后**才生效）。
  另有一条 GC 断言：`URLRequestDefaults.userAgent` 赋值成一个拼接串后 `System.gc()`，仍能读回
  ——验证它被登记为永久 GC 根（生成 C 里可见 `gc_mark_user_roots` 内的 `as_urld_user_agent`）。
- `examples/urlloader-contract.as`：`URLLoader(request)` 传参即开始加载且**同步不派发任何事件**；
  `open` **先于** `progress`/`complete`；加载中 `bytesLoaded`/`bytesTotal` 读 `0`、完成后置为字节数；
  `close()` 后不再派终态事件、且 `data` 保持 `null`；`close()` 无在飞流时抛 invalid stream error；
  `close()` 之后同一个 loader 仍可再次 `load()`；`dataFormat=VARIABLES` 的 `data` 是 `URLVariables`
  且值已百分号解码。
- **实测口径**（两条示例均以 `--run` 跑通）：

  | 检查项 | 证据 |
  |---|---|
  | 全量回归 | `node test.ts` → **119 passed / 0 failed / 119 total**（A/B 之前为 117；新增两条示例） |
  | 受影响旧示例 | `examples/stage63.as`（`contentType` 默认断言由 `null` 改为 MIME 串）、`examples/async-io.as` 通过。⚠️ **本行原先声称 `examples/air-native/`（含 `NetUiDemos.as`）也 PASS，该结论不成立**：那个 demo 的 `NetUiDemos.as:44` 断言的是 `null`，从未同步，因此 `--run` 时在 stage 63 抛未捕获异常、**53 ms 内退出、窗口根本没画出来**。该缺陷直到阶段八十九·六十九（本文件 §6.7.7）才被运行时暴露并修正 |
  | native | 两条新示例 `--run` 通过 |
  | wasm32-wasip1 | 两条新示例 `--target wasm` 编译通过；`wasmtime --dir=.` 运行通过（裸 `wasmtime` 不 preopen CWD，会因读不到文件走 `ioError`——这是环境而非代码问题，`examples/async-io.as` 同样如此） |
  | 生成 C 可读性 | `URLLoader_ctor/_finish/_load/_close`、`URLRequest_useRedirectedURL`、`URLVariables_decode` 均为手写风格可读 C（AGENTS.md §2.6） |

> **未做反向对照**（AGENTS.md §2.4 的做法）：本阶段无网络行为可还原，「反向」等价于把字段改回死字段、
> 把 `close()` 改回空函数——那是纯粹的倒退，无诊断价值。C/D 阶段的反向对照仍是必需的（§6.2）。

### 6.2 阶段 C 探针 + D(native) 的验收 —— **已执行（阶段八十九·四十九；语义于八十九·五十二 校正）**

> ⚠️ **八十九·五十二 校正**：本节原先把 404 记成 `httpStatus(404);ioError;`（“不派 complete”），并声称
> `httpStatus` 在 `progress` **之前**——两点都与 `adl` 实测相反。现已按实测校正：
> **404 是正常响应，加载 `complete` 且 `data` 为错误页正文**；`ioError` 只留给传输失败；
> 实际序列为 `open;progress;httpStatus(200);complete;`（`httpStatus` 在 `progress` **之后**、`complete` 之前）。
> 权威契约见 §6.4，AIR 实测见 §6.7。
>
> ⚠️ **八十九·五十九 限定，已于八十九·六十二 落地**：上面「404 → `complete`」**不是无条件的**——它只在
> 调用方注册了 `HTTP_RESPONSE_STATUS` 监听器时成立（当时据以校正的探针恰好注册了）。**没有**该监听器时，
> AIR 在 `httpStatus(404)` 之后派 `ioError #2032`。两半现均按其实现（判据是 `EventDispatcher_hasEventListener`，
> 阈值 `status >= 300`）；受控实测（同一服务器、同一 URL，唯一变量是该监听器）见 §6.7.6。

探针脚本在 `temp/`（**不进 `examples/`**：它们需要活的服务器与 opt-in 后端，不适合无网 / 默认构建的回归套件）：

| 文件 | 作用 |
|---|---|
| `temp/netprobe.as` | 本地服务器往返：GET 体/状态码、GET 折叠 query、POST 回显、404、binary、连接被拒 |
| `temp/netprobe_https.as` | 真 `https://example.com/` 传输 + 其 404 |
| `temp/netprobe_server.py` | 极小的本地服务器（`/hello` `/query` `/echo` `/missing`） |
| `temp/netprobe.build.json` | `link-libs: ["curl"]` + `defines: ["ASC_HAVE_CURL"]` |

复现（native）：

```sh
python3 temp/netprobe_server.py 8731 &
node src/index.ts temp/netprobe.as        --manifest temp/netprobe.build.json --run
node src/index.ts temp/netprobe_https.as  --manifest temp/netprobe.build.json --run
```

实测结果（全部通过）：

| 检查项 | 结果 |
|---|---|
| GET | `open;progress;httpStatus(200);complete;`，`data` = `hello-from-net` |
| 事件顺序 | `open`→`progress`→`httpStatus`→`complete`（`httpStatus` 在 `progress` **之后**、`complete` 之前；§6.4/§6.7） |
| GET + `data` | 折叠进 query：服务端收到的即 `?x=1&y=2` |
| POST | `httpStatus(200);complete;`，服务端回显 body `name=alice&city=paris` |
| 404 | `httpStatus(404);complete;`，`data` = `not found`（**HTTP 错误状态是正常响应，不转 `ioError`**） |
| `dataFormat=binary` | `data` 是 `ByteArray`，长度 14 |
| 连接被拒（端口 9） | `ioError`，**不挂死**（`CONNECTTIMEOUT` 10s / `TIMEOUT` 30s） |
| 真 HTTPS | `open;httpStatus(200);complete;`，559 B `<!doctype html>`（TLS 由系统 libcurl 代管） |
| 真 HTTPS 404 | `httpStatus(404);complete;` |

**同一份生成 C 的反向对照**（证明分叉只在构建层、不在生成的 C 里）：

```sh
cc -O2 temp/netprobe.c -lm -lz -o temp/netprobe_nobackend   # 不加 -D ASC_HAVE_CURL、不加 -lcurl
./temp/netprobe_nobackend
# → GET log=httpStatus(0);ioError(URLLoader: network URLs are not supported in this build ...); data=empty
```

**已补齐（八十九·五十一）**：`mxmlc + adl` 基线对照 → §6.7；响应头/有效 URL/重定向计数 → §6.4；
分块进度（重放的 `progress`） → §6.4。**仍未做**：代理、cookie jar、HTTP/2。

### 6.3 阶段 F（`URLStream` 流式）的验收 —— **已执行（阶段八十九·五十一）**

探针 `temp/netprobe3.as`（native，同一服务器 `/drip` 路由：分块 `6 × 128 B`、慢发、共 768 B）：

```sh
python3 temp/netprobe2_server.py 8732 &
node src/index.ts temp/netprobe3.as --manifest temp/netprobe2.build.json --run
```

| 检查项 | 结果 |
|---|---|
| 增量可见 | `bytesAvailable` 在多个帧上 `> 0`（**6 个读批次**，时间跨度 762–777 ms），而非一次到齐 |
| 非阻塞读 | 数据不足时读 `readUTFBytes(bytesAvailable)` 不卡；跨批拼接后总长 = 768 |
| `readShort` 符号扩展 | 对同一批尾部的 `0xC3 0xA9` 得 `-15145`（`195*256+169-65536`） |
| `readUTF` 长度前缀 | `readUTFBytes(2)` 吃掉 `u16` 长度后再读 5 B 得 `café`，`bytesAvailable == 0` |
| `connected` / `close()` | 完成后 `connected == true`（AIR：**完流仍连着**，可继续读完剩余字节，直到 `close()`）；`close()` 后才 `false`；从未打开的流上 `bytesAvailable`/`close()`/任何 `read*` 都抛 `#2029` |
| 数据不足 | `EOFError`（断言 `#2030`）而非静默返回 0 |
| 失败后的流 | `load` 失败后 `connected == true`、`bytesAvailable == 0`、`read*` → `EOFError #2030`（“开了但空”），`close()` 正常——与 AIR 实测一致（`temp/air-probe` #3） |
| **反向对照** | 同一份 `temp/dbg2.as` **不声明 `ASC_HAVE_CURL`** → `ioError`（文案指名「this transport is not supported in this build」），**不冒充空数据** |
| web 端 | 同一族流式断言在 `fetch` 后端下 6 个批次、768 B 全通（§6.5 表内两行） |

### 6.4 阶段 C/D 的完整契约验收 —— **已执行（八十九·五十一）**

探针 `temp/netprobe2.as`（native，`temp/netprobe2.build.json` = `link-libs: ["curl"]` +
`defines: ["ASC_HAVE_CURL"]`，`targets.wasm` 覆盖为空）：

```sh
python3 temp/netprobe2_server.py 8732 &
node src/index.ts temp/netprobe2.as --manifest temp/netprobe2.build.json -o temp/out/native-netprobe2 --run
# → netprobe2: phase C/D assertions passed
```

| 检查项 | 结果 |
|---|---|
| 全部动词 | `GET`/`POST`/`PUT`/`HEAD`（`HEAD` → 无体、`bytesLoaded == 0`）均以状态码 200 完成 |
| 响应头 | `responseHeaders` 是 `URLRequestHeader` 数组，含 `content-type`/`content-length`/自定义 `x-custom` |
| `bytesTotal` | 有 `Content-Length` 时 `bytesTotal == bytesLoaded == 14`；无（chunked）时为已收字节数 |
| 重定向 | `followRedirects=true` → 落在目标体；`redirected == true`、`responseURL` 是**最终**地址 |
| 头区归一 | 混合大小写头名能按大小写不敏感查到（解析器小写归一） |
| 4xx | `404` → `httpResponseStatus(404,…)`+`progress(9/9)`+`httpStatus(404)`+`complete`，`data` = `not found`；**HTTP 错误状态是成功加载**，`ioError` 只给传输失败（§6.7 实测） |
| 两个状态事件的分工 | `httpStatus` **只带 `status`**（`responseURL=null`、`responseHeaders` 为空数组、`redirected=false`）；`httpResponseStatus` 才带 `responseURL`/`responseHeaders`/`redirected` |
| 非 HTTP 加载 | 本地文件也以一个 `httpStatus(0)` 收尾（AIR：`open;progress(n/n);httpStatus(0);complete;`） |
| 失败后 `data` | 非 `null`，而是**空值**（`dataFormat=text` → 空 `String`；`binary` → 空 `ByteArray`） |
| 参数校验 | `load(null)` / `load(new URLRequest(null))` → 两个不同的 `TypeError #2007`（`Parameter request/url must be non-null.`） |
| 进度重放 | 后台线程记录的字节水位在 `complete` 前被**重放**为多条 `progress`（终态事件仍在帧边界） |
| 无后端 | 同一份生成 C 不加 `-D ASC_HAVE_CURL` → 第一个用例即在诚实 `ioError` 上失败（反向对照） |

### 6.5 阶段 E（web `fetch`）的验收 —— **已执行（八十九·五十一）**

web 目标无法 headless 式「运行后读 stdout」——那就用一个页面把断言从三个**独立通道**送出来：
POST 回端口（`/result` → 文件）、页面上的 `TextField`（截图人读）、以及 `window.__ascStdout`
（生成的 `index.html` 里 `Module.print` 挂钩缓冲，CDP 读取给自动化）。

| 文件 | 作用 |
|---|---|
| `temp/webprobe.as` | 同一族断言的 web 版（GET/404/POST+请求头/重定向/`URLStream /drip`/跨源 CORS/`navigateToURL`） |
| `temp/webprobe.build.json` | `defines: ["ASC_USE_SKIA=1", "ASC_USE_WINDOW=1", "ASC_HAVE_FETCH"]` |
| `temp/run_webprobe.sh` | **单次调用**拉起全部：服务器 + headless Chrome（`--no-proxy-server`）+ CDP 读回；参数化 `DIR`/`RESULT`/`PAGE` 以便跑反向对照 |
| `temp/cdp_eval.mjs` | CDP 读写（含 `--pre` 在页面脚本前装探针、`--nav` 导航） |

```sh
export EMSDK_HOME=<repo>/build-tools/emsdk
node src/index.ts temp/webprobe.as --manifest temp/webprobe.build.json -o temp/out/webprobe/webprobe
bash temp/run_webprobe.sh          # → webprobe: DONE checks=15 failures=0
```

| 检查项 | 结果 |
|---|---|
| GET 三件 | 状态码 200 + 体 + `bytesLoaded == 14` |
| 404 | `httpResponseStatus(404)` + `httpStatus(404)` + `complete`，`data` = `not found`（**HTTP 错误状态是成功加载**，不转 `ioError`） |
| POST | 服务端回显 `POST:phase-e\|X-Test=web`——**body 与自定义请求头都真的发上去了** |
| 重定向 | 跟随成功且落在目标体 |
| `URLStream /drip` | 768 B **分 6 批**到达（真流式，不是一次到齐）；完成后 `connected == true`，`close()` 置 `false` |
| 跨源（无 CORS） | `ioError`，文案同时指名浏览器失败与 `Access-Control-Allow-Origin`（**不假装成功**） |
| `navigateToURL` | 页面侧调用返回不抛；harness 在页面脚本前装的 `window.open` 记录器读到 `["http://127.0.0.1:8732/hello", "mailto:someone@example.com"]` |
| JS 层错误 | `window.__ascErrors` 为空（无未捕获异常 / 未处理 rejection） |
| **反向对照** | 同一页面**去掉 `ASC_HAVE_FETCH`** 重建 → 第一个用例即诚实 `ioError`（`checks=2 failures=2`），证明就是该宏打开了后端 |

**落地要点（踩过的坑，避免重现）**：

- **`showWindow` 会「拔栈」**：web 上它调 `emscripten_set_main_loop(..., simulateInfiniteLoop)`，
  后者抛 `unwind` 哨兵穿透 `main`——**写在 `showWindow` 之后的语句永不执行**。启动链必须先跑，
  `showWindow` 放最后。
- **EM_ASM 里不要用 Emscripten JS 库函数**（`stringToUTF8`/`lengthBytesUTF8`）：库函数只在
  **编译后的 C** 调用它们时才被链进构建，从 EM_ASM 里摸是 `ReferenceError`（实测）。UTF-8
  编解码改用内置 `TextEncoder` + `HEAPU8.set`，不依赖 Emscripten 库。
- **单线程 `HTTPServer` + `HTTP/1.1` keep-alive 会死锁**：服务器停在一个连接的处理循环里，
  浏览器开第二条连接（并行写 POST/GET）时请求永远到不了；用 `ThreadingHTTPServer`。
- **带 GUI 的 `main` 之后才发请求**，且请求回调都靠帧边界 drain（`as_web_fetch_pump` 在
  `as_async_tick` 顶部）——所以**不能用阻塞自旋等结果**（会饿死浏览器 promise），必须事件驱动。

### 6.6 阶段 H（`navigateToURL`/`sendToURL`）的验收 —— **已执行（八十九·五十一）**

| 端 | 证据 |
|---|---|
| native | `temp/netprobe4.as` → `netprobe4: phase H assertions passed`；把 `ASC_OPEN_LAUNCHER` 指到一个记录脚本，**逐字收到 5 条 argv**，含 `'http://127.0.0.1:8732/a; b$(id) && echo pwned'` **原样传参**（`fork`+`exec` 单 argv、不经 shell，无注入） |
| WASI | `temp/wasi-nav.as`（`--target wasm --run`）→ 无启动器环境下如实报 `Error #2032`，不静默 |
| web | 见 §6.5 末两行（`window.open` 记录到两条 URL，含 `mailto:`） |

### 6.7 与 `mxmlc + adl` 的基线对照 —— **已执行（八十九·五十二）**

同一份 `examples/url-test/src/Main.as`（登录 POST + 统计 GET + 结果上屏）在 **AIR 参考实现**
（`$AIRSDK_HOME/bin/mxmlc` 编译 + `adl` 运行）与**本项目**（`as-aot --air-app … --run`）下各跑一次。
AIR 侧的观测方式是**截 `adl` 窗口的屏幕**（`adl` 吞掉 `trace()`，结果只在舞台上的 `TextField` 里），
本项目侧则直接读 stdout（native `trace` 直出），两侧都面对真实 `devapimeeting.talkmed.com`：

| 对照项 | AIR（mxmlc + adl） | 本项目（`--air-app --run`） | 一致？ |
|---|---|---|---|
| 登录 POST 的体与 `Content-Type` | `application/json`，体为 `JSON.stringify({type,account,password,platform,language,appversion,timezone})` | 同（同一份 `Main.as`，同一 `net__prepare_request` 路径） | ✅ |
| 登录响应解析 | `code=0`，`data.accessToken` 非空 | `code=0`，`data.accessToken` 非空 | ✅ |
| 统计 GET 的 URL 拼接 | `…live_statistics?access_token=<token>&platform=…&language=…&appversion=…&timezone=8:00` | 逐字相同 | ✅ |
| 统计 `data` 解析 | `{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}` | **逐字节相同** | ✅ |
| 事件序列（`open`→`httpResponseStatus`→`httpStatus`→…） | `200` → `open` → … → `complete`（同 §6.7.1） | 同 | ✅（文案不同，事件集相同） |
| 两张互联网 PNG（`Loader.load`，阶段八十九·五十四） | 两张均上屏：`753×751` / `815×814` 缩到 340 宽（`340×339` / `340×340`），位于 `(10,60)` / `(370,60)`，`bytesTotal` `487042` / `511484` | 逐项相同（含 `bytesTotal` 与缩放后的取整尺寸） | ✅ |
| 图片加载的终态事件（同左） | `INIT` → `COMPLETE`，`content` 为 `Bitmap`，`numChildren == 1` | 同（同一份 `Main.as`、同一个 `Loader__imageFinish`） | ✅ |
| 失败路径（无后端） | —（AIR 总能联网） | 两处请求都落诚实 `ioError`（反向对照） | ✅ |

> 反向对照：同一份 `.as` 用**默认构建**（无 `ASC_HAVE_CURL`）跑 → 第一处登录就落在
> 诚实 `ioError`（`URLLoader: network URLs are not supported in this build …`）上，
> 界面显示失败而非假数据，且**不挂起**。`Loader` 侧同形：`Loader: network URLs are not
> supported in this build (no HTTP backend linked; see docs/zh-cn/flash-net.md)`——**与
> 「文件不存在」的文案可区分**（这正是 `examples/loader-url.as` 钉的断言）。

#### 6.7.1 实测记录

**运行命令（两侧）**

```bash
# ① AIR 参考实现（mxmlc + adl）
SDK=/Users/ray.lei/Documents/Software/AIRSDK/AIRSDK_51.3.4   # 注：51.4.1 的 adl 在 macOS 26 上不起窗口，改用 51.3.4
"$SDK/bin/mxmlc" -source-path+=examples/url-test/src -output examples/url-test/main.swf examples/url-test/src/Main.as
"$SDK/bin/adl" examples/url-test/url-test-app.xml -- examples/url-test   # 窗口打开后截屏读 TextField

# ② 本项目（AIR 描述符直编译 + 运行）
#    curl 参数不再手敲：--air-app 扫 src 发现 URLRequest/flash.net 后自动写进生成的清单
node --experimental-strip-types src/index.ts --air-app examples/url-test/url-test-app.xml \
     -o temp/out/url-test/main
script -q /dev/null ./temp/out/url-test/main > temp/url-test-aot.log   # pty 使 trace 行缓冲，SIGKILL 不丢尾
```

**本项目侧 stdout（`temp/url-test-aot.log`，截断长 JSON）**

```
=== url-test: TalkMed login + live_statistics ===

[login] POST https://devapimeeting.talkmed.com/v1/login
[login] response:
{"code":0,"data":{"accessToken":"afdd0e0f-…","refreshToken":"…","accessTTL":172800,…},"message":"success"}

[login] accessToken = afdd0e0f-4e8a-7ff5-2d7d-036980588e43

[stats] GET https://devapimeeting.talkmed.com/v1/user/live_statistics?access_token=afdd0e0f-…&platform=wechat_small&language=zh_CN&appversion=1.9.10&timezone=8:00
[stats] response:
{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}

=== done ===
```

**AIR 侧 `adl` 窗口（截屏 `temp/air-urltest-window.png`，TextField 文本）**

```
…login response:
{"code":0,"data":{"accessToken":"a4fe9f8b-2fe6-507e-460a-8844c706e758",…,"needResetPassword":1,…},"message":"success"}

[login] accessToken = a4fe9f8b-2fe6-507e-460a-8844c706e758

[stats] GET https://devapimeeting.talkmed.com/v1/user/live_statistics?access_token=a4fe9f8b-…&platform=wechat_small&language=zh_CN&appversion=1.9.10&timezone=8:00
[stats] response:
{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}

=== done ===
```

**结论**：两侧 `accessToken` 值不同（服务端每次新发，预期）；**`accessToken` 之外的流程与 `data` 载荷逐项相同**——
统计响应 `{"code":0,"data":{…"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68…},"message":"success"}`
在两侧**逐字节一致**。

**反向对照输出（无 `ASC_HAVE_CURL`）**

```
=== url-test: TalkMed login + live_statistics ===

[login] POST https://devapimeeting.talkmed.com/v1/login
[login] failed: ioError  [Event type="ioError" bubbles=false cancelable=false]
```

> **踩坑记录**：`adl` 的 `trace()` 不进 stdout（只能靠截窗口），且 `File.applicationStorageDirectory`
> 在此 adl 环境下不可写——AIR 探针一律用 `FileStream.open()` 写**绝对路径**。另：macOS 26 上
> AIRSDK 51.4.1 的 `adl` 能运行却不创建窗口（Quartz 窗口列表为空），改用 51.3.4 后正常。

#### 6.7.2 两张互联网 PNG 的对照（阶段八十九·五十四）

同一份 `examples/url-test/src/Main.as` 追加两步 `Loader.load(URLRequest)`（两张 `https://meeting.talkmed.com/img/*.png`），
两侧同样各跑一次：

```bash
# 本项目侧：一条命令即可（curl 由 --air-app 自动挂载，见 §6.7.3）
node src/index.ts --air-app examples/url-test/url-test-app.xml -o temp/out/url-test/url-test
```

手敲参数的**等价形式**（阶段八十九·五十四 当时的形态，现仍可用，只是不再必需）：

```bash
node src/index.ts --air-app examples/url-test/url-test-app.xml \
     -I vendor/curl/include -L vendor/curl/lib/macos-arm64 -l curl -l nghttp2 \
     -D ASC_HAVE_CURL --framework Security --framework SystemConfiguration \
     -o temp/out/url-test/url-test
```

**两侧日志（`[img]` 行）逐字一致**（只有完成先后偶有不同，两张图在两条 worker 上并行）：

```
[img] loading 2 PNGs from meeting.talkmed.com ...
[img] GET https://meeting.talkmed.com/img/meeting_3.0bca6577.png
[img] GET https://meeting.talkmed.com/img/meeting_2.6e101b24.png
[img] meeting_3.0bca6577.png 753x751 decoded, scale=0.452 -> 340x339 at (10,60)  bytesTotal=487042
[img] meeting_2.6e101b24.png 815x814 decoded, scale=0.417 -> 340x340 at (370,60)  bytesTotal=511484
[img] 2/2 images on stage
```

**截图**：AIR `adl` → `temp/out/adl-urltest-merged.png`，本项目 AOT → `temp/out/aot-urltest.png`
（两者都可见两张图并排在 `y=60`，下面是对应日志的 `TextField`；本项目侧页首是 `Fps` 覆层，
`RUNTIME:AS-AOT` 与 adl 的 `RUNTIME:Adobe M…` 是同一个 `Capabilities.manufacturer` 字段）。

**结论**：`bytesTotal`（`487042` / `511484`）、解码尺寸（`753×751` / `815×814`）、缩放系数与
取整后的成品尺寸（`340×339` / `340×340`）、定位全部与 AIR **逐项相同**。渲染上屏这件事本身
暴露了阶段八十九·五十四 修的**真错**：只填 `loader.content` 时两侧日志一模一样、两张图在 AOT 侧
却**一个像素都不画**（adl 画得出来，因为 AIR 的 `Loader` 本来就把内容加为自己的子对象）。

#### 6.7.3 传输层由 `--air-app` 自动挂载（阶段八十九·五十五）

按「用户能直接敲的命令」复核时暴露的**构建层**缺口：

```bash
node ../../src/index.ts --air-app ./url-test-app.xml --main-class Main --target native --run
```

跑起来**网络访问全是 `ioError`**——运行时没错（§6.7.2 已证明远程 URL 走的是同一条 seam），
错在**生成的清单里没有 curl**：`ASC_HAVE_CURL` 是 opt-in 宏（§3.4.1），此前只能靠手敲 CLI 参数
提供；而「把参数写进 `url-test.build.json`」这条路**活不过下一次构建**——`--air-app` 每次运行都
重写该文件（实测：改完再跑一次，md5 回到未含 curl 的版本）。

**修法**：`src/air-app.ts` 新增 `detectNetworking(asFiles)`（与 `detectStage3D` 同形），扫 app 自身
源码里的 `URLRequest`——命中即自动写 `-I/-L vendor/curl/…` + `-l curl -l nghttp2` +
`Security`/`SystemConfiguration` + `ASC_HAVE_CURL=1`；web 目标写 `ASC_HAVE_FETCH=1`；
native 下 `vendor/curl` 缺失则**立即报错**并给出 `build-tools/curl-src/build-static.sh`。
判据用 `URLRequest` 而**不是** `import flash.net.*`：AS3 里**每条**走 HTTP seam 的路径都必然先构造
一个 `URLRequest`（`URLLoader.load` / `URLStream.load` / 远程 `Loader.load` / `navigateToURL`），
而 `flash.net` 包还装着 `SharedObject`/`FileReference`/`LocalConnection` 这些从不碰网络的类——
按包名匹配会白白多链 1.4 MB 静态 curl，并让只想要本地存储的 app 在没建 `vendor/curl` 的机器上
被硬报错卡住。`Socket`/`XMLSocket`（需 `ASC_SOCK_POSIX`）与 `NetConnection`/`NetStream`（RTMP）
也都**不是**判据。

**实测（用户原命令，一个额外参数都没加）**：登录 POST + 统计 GET + 两张 PNG **全部成功**，
`[img]` 两行与 §6.7.2 逐字一致（`bytesTotal` **487042** / **511484**，`753x751` / `815x814` →
`340x339` / `340x340` @ `(10,60)` / `(370,60)`，`2/2 images on stage`）；截图
`temp/out/aot-autocurl.png`（帧首 `FPS:120 MEM:4MB … RUNTIME:AS-AOT`，两张图并排在顶部，
下方 `TextField` 是同一份日志）。生成的清单与手敲 CLI 参数**逐项等价**（多出的
`vendor/curl` 两侧都指静态库，故 `otool -L` 仍无 `libcurl.4.dylib`）。

**反向对照**（`test.ts` 的 `checkAirAppTransport()`，10 条 `[air-app]` 断言）：不碰网络的 app
**不得**被塞进 curl（防「一律挂载」的过度修复；该 fixture **特地** `import flash.net.SharedObject`，
把「按包名匹配」这个错解钉死）；同一个联网 app 的 web 清单必须**换成**
`ASC_HAVE_FETCH=1` 且不含任何 curl 字段（`wasm-ld` 找不到 `-lcurl`）。

#### 6.7.4 web 目标的两处缺口 + 一条浏览器硬边界（阶段八十九·五十六）

阶段八十九·五十四/五十五 的验收全在 native 与 `adl` 上做，用户在**浏览器**里跑同一份
`examples/url-test` 时看到的是：登录被服务端驳回，两张图一个字节都没下就报了错。两处都是
**真的缺口**，且都失败得**像应用自己的 bug**（这也是它们能活这么久的原因）。

```bash
node ../../src/index.ts --air-app ./url-test-app.xml --main-class Main --target wasm --package web
```

**缺口 1：web 后端丢掉了 `URLRequest.contentType`。** native 的 `as_http_perform` 把它变成
`Content-Type:` 头发出，web 的 `as_web_fetch_go` **从来没用过 `j->content_type`**——而 `fetch`
只为 `string`/`Blob` 体自动补这个头，对本后端传的 `Uint8Array` 一律不补。于是在真实端点上
得到（浏览器内实测，同源 JSON 体）：

| 请求 | 服务端响应 |
|---|---|
| `POST` + `Uint8Array` 体，**无** Content-Type | `{"code":200002,"message":"platform 字段是必须的"}` |
| 同一请求 + `Content-Type: application/json` | `{"code":0,"data":{"accessToken":"1b394084-…"}}` |

**修法**：`as_web_fetch_go` 新增 `ctype` 形参，C 侧由 `as_web_ctype()` 按与 native **同一条**
规则算出（`content_type != NULL && (POST || 有体)`），在显式 `requestHeaders` 块**之前**写入，
故 URLRequest.requestHeaders 里的同名头仍然优先。两个入口（`as_http_run` / `as_http_stream_run`）
都传，URLLoader 与 URLStream 一致。

**缺口 2：远程图片在 web 上没有传输。** `as_job_run` 的 `AS_JOB_IMAGE_URL` 分支只有
`#if defined(ASC_HTTP_BACKEND)`（= curl）一个实现，web 落到 `#else` 的
`AS_JOB_ERR_UNSUPPORTED`——报的是「本构建没接 HTTP 后端」（八十九·四十九 阶段 G 的诚实文案），
而**这个构建其实有**。故 web 上每个远程 `Loader.load` 都在**一次请求都没发**的情况下失败。
修法是在该分支加 `#elif defined(ASC_HTTP_WEB)`：`as_http_run(j)` 只**启动** fetch 并让 job 停在
RUNNING（`pending_async`，故 `as_job_publish` 不标 DONE、thunk 不跑），体到达后由
`as_web_fetch_pump` 在终态条目上解码——产出与 curl 分支**逐项相同**的两件东西：
BitmapData 要的像素、显示用 SkImage 要的编码字节。解码放在帧边界（浏览器无 worker 线程可藏，
单帧几毫秒、每 job 一张图）。

**硬边界：这两个 URL 在 web 上**不该**被读到。** `meeting.talkmed.com` 的图片响应**没有**
`Access-Control-Allow-Origin`（只有 `timing-allow-origin: *`）。跨源图片在浏览器里可以
**显示**，但**读不到像素**（canvas 会被 taint），而 Skia 上屏需要像素——故这不是编译器能绕的
边界。真实 Chrome 实测：同页面 `fetch()` 该 URL → `Failed to fetch`；`curl` 同 URL → 200
+ 完整 487042 字节（`curl` 不受同源策略约束）。**这正是 native/adl 正常而 web 不行的唯一原因。**

**实测（真实浏览器，三个阶段各一条 URL）**——`temp/webimg-air`（fixture）+
`temp/run_webimg.sh`，服务器的唯一区别是有没有 CORS 头：

| 用例 | 结果 |
|---|---|
| 同源（页面自己的 8732） | `[ok] same-origin decoded 753x751 bytesTotal=487042` |
| 跨源，服务器回 `ACAO:*` | `[ok] cross-origin+CORS decoded 815x814 bytesTotal=511484` |
| 跨源，**无** CORS 头 | `[ioError] cross-origin-NO-CORS #0 fetch failed (Failed to fetch); for a cross-origin URL this is usually a missing Access-Control-Allow-Origin header` |
| canvas 像素（三段各数非白点） | `720x900 band1=47027 band2=45429 band3=0`——前两段真画上去了，第三段一个点都没有 |

**实测（用户的 app，`examples/url-test`，`temp/run_urltest_web.sh`**——服务端把 `.wasm` 标为
`application/wasm`，故运行日志里没有流式编译回退那两行）：登录 POST 拿到 accessToken
（`[login] accessToken = 531d9f5c-…`），统计 GET 返回 `{"code":0,"data":{"creator_live_total":56,…}}`
（**修前这条根本不会发出**），两张图各自得到上面那条指名 CORS 的 `ioError`；
`window.__ascErrors` 为空。与 native 侧的差异**只剩**图片那一条，且原因是 CDN 的同源策略。

**反向对照**：`test.ts` 的 `checkWebTransport()` 4 条 `[web]` 断言（套件里没有浏览器与 emcc，
故钉在运行时前导的**契约**上，并已逐条做过反向对照：抽掉 web 图片分支 / 抽掉 Content-Type /
抽掉 pump 解码，各自对应断言立即转 false）。

#### 6.7.6 non-2xx 的终态：受控实测（阶段八十九·六十二）

**背景**：遗留表里「`URLLoader`/`URLStream` 对 4xx 无条件 `complete`」一条，结论取自两组探针的对比；
但两组之间**除了监听器还改了主机/协议/`Content-Length`**，不足以把差异归因给监听器。于是重做一次
**受控**实验：同一台本地服务器、同一 URL、同一字节，**唯一变量是调用方是否注册
`HTTP_RESPONSE_STATUS`**。`HTTP_STATUS` 在每一格都注册，以证明判据是**那个事件类型**而非「任意状态监听器」。

工具：`temp/httpstatus-probe/`（`server.py` + adl 探针）、`temp/httpstatus-probe2/`（空体 + `URLStream` 两半）、
`temp/httpstatus-aot/httpstatus-aot.as`（同一矩阵的 AOT 版）、`temp/httpstatus-probe/run_all.sh`（一次性
拉起干净服务器 → 健康检查 → **同一实例**依次跑 adl 与 AOT）。12 格**两侧逐字一致**：

| # | 请求 | 监听器 | 终态 | 序列（adl 与 AOT 完全相同） |
|---|---|---|---|---|
| A | 404 + 正文 | 有 | `complete` | `open;httpResponseStatus(404,redir=false);progress(10/10);httpStatus(404);complete` |
| B | 404 + 正文 | **无** | **`ioError #2032`** | `open;progress(10/10);httpStatus(404);ioError(2032)` |
| C | 500 + 正文 | 有 | `complete` | `open;httpResponseStatus(500,redir=false);progress(13/13);httpStatus(500);complete` |
| D | 500 + 正文 | **无** | **`ioError #2032`** | `open;progress(13/13);httpStatus(500);ioError(2032)` |
| E | 200 + 正文 | 无 | `complete` | `open;progress(15/15);httpStatus(200);complete` |
| F | 302 不跟随 | 有 | `complete` | `open;httpResponseStatus(302,redir=false);httpStatus(302);complete` |
| G | 302 不跟随 | **无** | **`ioError #2032`** | `open;httpStatus(302);ioError(2032)` |
| H | 302 跟随 | 无 | `complete` | `open;progress(15/15);httpStatus(200);complete` |
| I | 200 空体 | 无 | `complete` | `open;httpStatus(200);complete` |
| J | 404 空体 | 无 | `ioError #2032` | `open;httpStatus(404);ioError(2032)` |
| K | `URLStream` 404 | 有 | `complete` | `open;httpResponseStatus(404,redir=false);progress(10/10);httpStatus(404);complete` |
| L | `URLStream` 404 | **无** | **`ioError #2032`** | `open;progress(10/10);httpStatus(404);ioError(2032)` |

**三条从矩阵读出的、容易做错的规则**：

1. **阈值是 `status >= 300`，不是 4xx**。未跟随的 302 同样分叉（F/G）。按「4xx」实现会把一个 AIR 报
   `ioError` 的重定向当成成功。
2. **错误正文两半都照常发布**，`data` 与 `bytesLoaded/bytesTotal` 在 `ioError` 那一支也**已经填好**
   （B/D 都是 `data=String(not found\n)`、`bytes=10/10`）。分叉点**只在最后那一个事件**：
   `progress` → 发布 → `httpStatus` 之后，`complete` ⇄ `ioError`。若把失败支做成「不发布、`bytes` 归零」
   （本项目失败支原本如此），就会多改一个字节。
3. **空体不派 `progress`**（I/J）。终端那个补发的 `PROGRESS` 需要 `total > 0` 守卫——本条是受控实验
   **新发现**的差异（此前实现无条件补发，空体时多出 `progress(0/0)`）。

**实现**：`URLLoader__finish` / `URLStream__finish` 两个终端各在 `httpStatus` 之后分叉——
`status >= 300 && !EventDispatcher_hasEventListener(o, "httpResponseStatus")`（判据与 AIR 同为「任一阶段有
监听器」），错误支用 `as_ioerror_text(path, 2032, NULL)` 取 **AIR 原文**（`Error #2032: Stream Error. URL: <url>`），
与八十九·五十九 那一套共用格式器。**反向对照**：`test.ts` 的 6 条 `[httpstatus]` 断言做过四组变异
（阈值改 400 / 去掉 `!` / 只改 `URLStream` 一格 / 把某一格的号改成 2030），每组都**只**让对应断言转红；
空体守卫另有**离线端到端**对照（`examples/urlloader-contract.as` 读 `examples/empty.bin`，去掉
`total > 0` 即报 `open;progress;complete;`）。

> **另一处方法学教训**：本轮探针的 `server.py` 最初是**单线程 + HTTP/1.1 keep-alive**，一条连接就把它
> 卡死，后续请求全部连接失败——表现出来和「传输坏掉」一模一样（10 格全 `httpStatus(0);ioError`）。
> 改成 `ThreadingHTTPServer` + HTTP/1.0 并在每次测量前**健康检查**后才拿到上表。
> **仪器不可信时，结论一定不可信**——这与 §6.7.4 修 `netprobe2_server.py` 是同一条教训。

#### 6.7.5 `ioError` 的错误号与文案（阶段八十九·五十九）

**背景**：用户问「TODO 里有没有 SVG」，调研发现 **TODO 零 SVG 覆盖**，且按
[`Loader` 类文档](https://airsdk.dev/reference/actionscript/3.0/flash/display/Loader.html)
三处（类描述 / `load()` / `loadBytes()`），**AIR 的 `Loader` 只支持 SWF/JPG/PNG/GIF**——SVG 从来不在范围内
（Flash Pro 的 SVG 导入是创作期转换，不是运行时解码）。用真 `adl` 实测确认 AIR 对 SVG 也报 ioError，
故「我们报错」是对的；用户选定**仅修该调研带出的那个 bug**（SVG 支持另议）。

**bug**：运行时**自己生成**的每一个 `ioError` 都带 `e.errorID == 0`，`text` 只有一句手写话。
根因是 `IOErrorEvent_ctor` 把 `errorID` 固定为 0（对 `new IOErrorEvent(...)` 是对的，AIR 该构造器
不接受错误号；对运行时生成的内部事件就是漏填），三个派发点（`Loader`/`URLLoader`/`URLStream`）都
直接用构造函数而没赋值。`Socket` 路径早有 `Socket__ioerror_event` 填 `#2031`，可见是遗漏。

**AIR 实测矩阵**（`adl` 51.4.1；探针 `temp/svg-air/` 与 `temp/svg-air2/`，结果写**绝对路径**——
`adl` 吞 `trace()`）。这些号码 AIR 文档从未列出，只能实测：

| API | 失败场景 | `errorID` | `text`（逐字） |
|---|---|---|---|
| `Loader` | 本地文件不存在 | `2035` | `Error #2035: URL Not Found. URL: <url>` |
| `Loader` | 载荷不是图片（HTTP 2xx） | `2124` | `Error #2124: Loaded file is an unknown type. URL: <url>` |
| `Loader` | 传输失败（DNS / 拒连） | `2036` | `Error #2036: Load Never Completed. URL: <url>` |
| `Loader` | **HTTP ≥ 400**（如 404 的错误页） | `2036` | 同上 |
| `URLLoader` | 任意失败 | `2032` | `Error #2032: Stream Error. URL: <url>` |
| `URLStream` | 任意失败 | `2032` | 同上 |
| `Socket` | 任意失败 | `2031` | `Error #2031: Socket Error. URL: <url>` |

**最容易错的一格**：远端 404 报 **`2036`**，不是 `2124`。404 的响应体（HTML 错误页）会真的到达
解码器并在那里失败，若照「解码失败 → 2124」直译就会把「服务器说没有这个文件」报成「这不是张图片」。
判定必须结合暂存的 HTTP 状态：同一个解码失败，`status >= 400` → `2036`，否则才 `2124`。

**两侧逐字对照**（探针 `temp/ioerr-matrix.as` / `temp/ioerr-matrix2.as`，清单 `temp/ioerr-matrix.build.json`）：

| 输入 | AIR (`adl`) | 本项目（修前） | 本项目（修后） |
|---|---|---|---|
| `https://airsdk.dev/images/crossplatform.svg`（200、非图片） | `2124` | `0` | **`2124`** ✅ |
| `https://airsdk.dev/no-such-file-xyz.png`（404） | `2036` | `0` | **`2036`** ✅ |
| `https://no-such-host-xyz.invalid/a.png`（DNS） | `2036` | `0` | **`2036`** ✅ |
| `file:///no/such/dir/absent.png` | `2035` | `0` | **`2035`** ✅ |
| `/no/such/dir/absent-plain.png` | `2035` | `0` | **`2035`** ✅ |
| `temp/svg-air/notimage.txt`（本地非图片） | `2124` | `0` | **`2124`** ✅ |
| `URLLoader` / `URLStream` 本地缺失、DNS、404 | `2032` | `0` | **`2032`** ✅ |

**文案形状**：`Error #N: <sentence>. URL: <url>`——号码自己的句子 + 出事的 URL，与上表每一格实测一致。
后端另有细节时（web 的 `fetch` 会给出点名 CORS 与响应类别的说明）**括注在句子之后**而不是替换它：
AIR 没有这一信息（它总能联网），但丢掉它会让「被 CORS 拦下」看起来像「服务器死了」。

**不给号的那一种**：「本构建没接 HTTP 后端」（阶段 G）是**编译产物**的性质，AIR 不存在这个状态，
故 `errorID` 保持 `0`、文案保持构建级句子。编一个号比留 0 更坏——调用方是按号 `switch` 的。

**未对齐的一处（非本缺陷）**：AIR 会把相对路径规范化成 `app:/no/such/dir/absent.txt` 再放进文案；
本项目原样使用传入的 URL。属 URL 解析行为，与本缺陷无关，已记入 TODO 遗留表。

**可离线复现的端到端断言**：`examples/loader-url.as`（本地非图片 → `#2124` 且文案**逐字相等**；
本地缺失 → `#2035` 且逐字相等；无后端 → 号仍为 `0`）与 `examples/urlloader-contract.as`
（本地缺失 → `#2032` 且逐字相等）。需要真网络的两格（传输失败、4xx 响应）钉在 `test.ts` 的
`checkIoErrorFidelity()` 结构性断言上。

> **该独立缺陷已修（阶段八十九·六十二）**：AIR 对 non-2xx 的终态确实取决于调用方是否注册了
> `HTTP_RESPONSE_STATUS` 监听器，现按此实现——**有**该监听器 → 错误页正文按内容派 `progress`/`complete`；
> **没有** → 派 `httpStatus(status)` 后 `ioError #2032`（错误页正文**两半都照样发布**，`bytesLoaded/bytesTotal`
> 也两半都一样）。
>
> 本节早先记的「对两个不同主机的 404 实测」有一个**方法学缺陷**：两组探针除了监听器之外还同时改变了
> 主机、协议与 `Content-Length`，因此不能把差异归因给监听器。八十九·六十二 重做了一次**受控**实验
> （同一服务器、同一 URL、同一字节，唯一变量是该监听器），并把阈值从「4xx」纠正为「`status >= 300`」——
> 一个**未跟随的 302** 同样分叉。12 格全矩阵见 §6.7.6。

#### 6.7.7 `URLRequest.contentType` 是**两个**东西：属性值 vs 发包默认（阶段八十九·六十九）

**症状不是「属性值不对」，是「demo 根本没启动」。** `examples/air-native` 用
`--air-app ./air-native-app.xml --target native --run` 构建成功、`Build successful`、但进程
**0.053 s 后以退出码 1 结束，窗口从未出现**。根因是 `NetUiDemos.run()` 里
`Assert.check(req.contentType == null, ...)` 抛未捕获异常，把整个 demo 掐断在 stage 63。

**两条互相矛盾的口径，必须都测。** 阶段八十九·四十八 依官方文档把构造器写成
`o->contentType = "application/x-www-form-urlencoded"`，并同步了 `examples/stage63.as`；
但 AS3 侧的属性值 adl 实测是 `null`。真相是文档那句话描述的是**发包默认**，不是 getter：

| 探针（mxmlc + adl 51.3.4 + 本地捕获服务器） | AS3 读回 | adl 实际发出的 `Content-Type` |
|---|---|---|
| `new URLRequest(url)` | **`null`** | — |
| `req.contentType = ""` | **`""`**（不归一为 `null`） | — |
| 先设 `"application/json"` 再设 `null` | `null` | — |
| POST 有体，contentType 未设 | — | `application/x-www-form-urlencoded` |
| POST 有体，contentType = `""` | — | `application/x-www-form-urlencoded` |
| POST 有体，contentType = `"application/json"` | — | `application/json`（原样） |
| POST **无体**（`Content-Length: 0`） | — | **一个都不发** |
| GET（`data` 折叠进 query string） | — | **一个都不发** |

**结论**：触发条件是「**体非空**」，不是「是 POST」。修法是**拆成两层**——
属性（`URLRequest_ctor`）回到 `NULL`；发包口径集中在共享助手
`as_http_effective_ctype(j)`（curl 与 web 两个后端共用，防止两边漂移）。

**反向对照（AOT 侧同一探针，逐条比对捕获头，6/6 一致）**：

| 用例 | adl | 修前 AOT | 修后 AOT |
|---|---|---|---|
| POST 有体，未设 contentType | `application/x-www-form-urlencoded` | ✅ 同 | ✅ 同 |
| POST 有体，contentType = `""` | `application/x-www-form-urlencoded` | ✅ 同 | ✅ 同 |
| POST 有体，显式 `application/json` | `application/json` | ✅ 同 | ✅ 同 |
| POST 无体 | **无头** | ❌ 发了 urlencoded | ✅ 无头 |
| GET（无体） | 无头 | ✅ 无头 | ✅ 无头 |

最后一行那处偏差来自 **libcurl 自己**：它给每个 POST 都补
`Content-Type: application/x-www-form-urlencoded`，而 adl 不补。故无体 POST 时追加一条
**空值**条目（`curl_slist_append(hdrs, "Content-Type:")`）——这是 libcurl 关闭内建默认头的
写法。web 侧 `fetch` 对 `Uint8Array` 体本就不自补，无须处理。

**为什么旧回归没抓到**：`examples/air-native` 是**目录型示例**，`test.ts` 只编译它、
**不运行它**；而能断言默认值的三个示例里，只有它把断言放在会被执行的路径上。
故本阶段在 `test.ts` 加了 `[req-ctype]` 组（6 项）：钉住属性默认、钉住共享发包规则、
钉住 libcurl 默认头的抑止，并**扫描 `examples/` 下所有声称断言「默认值」的
`contentType ==` 行、要求它们与构造器的发射一致**——正是「改了默认值却漏改示例」
这类缺陷的通用钉子。

### 6.8 三目标一致性验收

- ✅ **同一份清单跨目标真编译（阶段八十九·五十）**：`examples/flash-net-layered.build.example.json`
  一份清单 → native 真链接 `/usr/lib/libcurl.4.dylib` 且运行正确；同清单 `--target wasm` 链接**零 curl**、
  运行与 native 逐行一致（`strings <wasm> | grep -ic curl` = 0）。这解除了阶段八十九·四十九 探针
  记录的「同一份清单喂 wasm 直接失败」约束（[`compile.md`](compile.md) §4.1）。
- ✅ **native 与 WASI 一致（阶段八十九·四十九）**：同一份 `examples/urlloader-network-unsupported.as`
  在 native 与 wasm32-wasip1 下行为一致（无后端时都派**可区分**的诚实 `ioError`）。
- ✅ **web 后端语义对齐（八十九·五十一）**：native 与 web 两端跑**同一族断言**，逐条对齐
  （§6.4 vs §6.5）；两端差异**只在真实差异处**（web 的 CORS 拒绝、响应头键名小写、重定向不可观测），
  都在文档里写明，不用 make-believe 抹平。
- 仍待：三端**同时**有后端时的**逐字节一致性**回归自动化（目前靠两套探针的同族断言 + 人工对照）。

---

## 7. `Socket` / `SecureSocket` / `ServerSocket` / `XMLSocket`（阶段八十九·五十三）

> 本节每条语义都来自 `mxmlc + adl` **实测**（探针 `temp/air-probe/Probe11.as` →
> `air-probe11-result.txt`），不是从文档推测；**未实测到的分支在下文显式标注**。

### 7.1 落地面（已实现）

| 类 / 成员 | 现状 |
|---|---|
| `Socket`（`EventDispatcher` 子类） | ✅ `connect(host,port)`/`close()`/`flush()` + 完整 `IDataInput`/`IDataOutput`（`readBoolean/Byte/UnsignedByte/Short/UnsignedShort/Int/UnsignedInt/Float/Double/UTFBytes/UTF/MultiByte/Bytes` 与对应 `write*`）+ 属性 `endian`/`objectEncoding`/`timeout`/`tcpNoDelay` + 只读 `bytesAvailable`/`bytesPending`/`connected`/`localAddress`/`localPort`/`remoteAddress`/`remotePort` |
| `ServerSocket` | ✅ `bind(localPort=0, localAddress="0.0.0.0")`/`listen(backlog=0)`/`close()` + 只读 `bound`/`listening`/`localAddress`/`localPort` + 静态 `isSupported`；派 `ServerSocketConnectEvent.CONNECT`（带 `socket`）。**另增补同步 `accept()`**（AIR 无此方法，见 7.2 末条） |
| `XMLSocket` | ✅ `connect(host,port)`/`close()`/`send(obj)` + 只读 `connected`/`timeout`；入站按 NUL 分帧派 `DataEvent.DATA`，`data` 为 **String**（实测） |
| `SecureSocket` | ⚠️ **仅 API 面 + 诚实失败**：`isSupported` 恒 `false`、`connect()` 派 `ioError #2031`。TLS 状态机未实现（见 7.3） |
| `IOError`（`flash.errors`） | ✅ 新增（`#2002` 的载体，与既有 `EOFError #2030` 并列） |
| `ServerSocketConnectEvent` / `OutputProgressEvent` | ✅ 新增（`CONNECT`/`OUTPUT_PROGRESS` + `socket` / `bytesPending`/`bytesTotal`） |
| `ProgressEvent.SOCKET_DATA` | ✅ 新增（`"socketData"`） |
| `DatagramSocket`（UDP） | ❌ 未实现（与 TCP 底座不同，独立立项） |

### 7.2 AIR 实测语义（对齐依据）

| 场景 | 实测（`adl`） |
|---|---|
| 新建对象 | `connected=false`；`bytesAvailable`/`bytesPending`/`close`/`flush`/`read*`/`write*` **一律抛 `IOError #2002 "Error #2002: Operation attempted on invalid socket."`**；`endian="bigEndian"`、`objectEncoding=3`、`timeout=20000`、`tcpNoDelay=false`、`localAddress=null`、`localPort=0`、`remoteAddress=null`、`remotePort=0`。`ServerSocket.bound=false`/`listening=false`；`XMLSocket.connected=false`/`timeout=20000` |
| 参数错误 | `connect(null,80)` → `TypeError #1009`；`connect("127.0.0.1",70000)` → `SecurityError #2003 "Invalid socket port number specified."` |
| 连接被拒 / DNS 失败 | `connect()` **正常返回**（不抛），随后派 `ioError`：`errorID=2031`、`text="Error #2031: Socket Error. URL: <host>"`（**只有 host，无端口**） |
| 环回 echo | `bind(0)` → `bound=true`、`listening=false`、`localPort=<临时端口>`、`localAddress="0.0.0.0"`；`listen()` → `listening=true`；`connect()` 返回时 `connected=false`（下一帧才为 `true`）；服务端派 `ServerSocketConnectEvent.CONNECT`（**不需 `accept()`**），被接受的 socket `connected=true` 且 `remoteAddress`/`remotePort` 已填；`writeUTFBytes("hello")` → `bytesPending=5`，`flush()` → `bytesPending=0`；`socketData` 的 `bytesLoaded`=本块字节数、`bytesTotal=0` |
| 关闭与重连 | 空转的连接读 `bytesAvailable` = `0`（不抛）；**数据不足读 → `EOFError #2030 "End of file was encountered."`**；`client.close()` → `connected=false`，此后读写抛 `#2002`；**服务端收到 `Event.CLOSE`**；`srv.close()` → `bound=false`/`listening=false`/`localPort=0`，再 `listen()` 抛 `#2002`；**同一 `Socket` 对象可再次 `connect()`**（`CONNECT` 再次派发，echo 正常） |
| `XMLSocket` 分帧 | `send("hello")` 实际发出 **6 字节**（5 字节 payload **+ 自动的 NUL**）且**立即 flush**（不像 `Socket` 等 `flush()`）；入站 NUL 结尾的报文派 `DataEvent.DATA`，`data` 是 **String**（NUL 已剥离）；`send(XML)`/`send(String)`/`send(int→"42")`/`send(Object→"[object Object]")` 皆可，**`send(null)` → `TypeError #1009`** |
| 参考面（airsdk.dev `ServerSocket`） | 构造器**无参**；无 `accept()`、无 `timeout`；`bind` 越界 `RangeError`、地址非法 `ArgumentError`、已绑定/端口占用 `Error`；`listen` 负 backlog `RangeError`、未绑定 `Error` |

> **末条是本子集唯一的「增补」**：AIR 的 `ServerSocket` 只能靠 `ServerSocketConnectEvent` 交付连接，
> 本实现**同时**提供 `accept():Socket`（同步取待处理连接）。两条路**每个对端只交付一次**（`accept()`
> 取走时会清掉该连接的事件位），因此不会因增补而重复。

### 7.3 实现口径（为什么这样做）

- **非阻塞 + 帧边界轮询**（对应 §4.2 的「三目标分叉」）：所有 socket 共用一个 `as_sock` 注册表，
  在帧边界 `as_async_tick_with(wait_ms)` 里跑一次 `as_sock_pump()`（一次 `poll(2)`）+ `as_sock_dispatch()`。
  这与 AIR「一切都在帧间派发」的模型同构，无需每连接一个线程、无锁、无跨线程交接，且**直接映射到
  WASI preview2 的 pollable 模型**。等待仅在「有在飞连接或待刷写字节」时发生（`as_sock_in_flight()`），
  故 headless 下不会挂住。
- **GC 根**：`as_sock` 是 `malloc` 的（不是 GC 对象），其 `obj`（AS3 对象）经 `as_sock_mark_roots()`
  注册为**永久根**（与异步 IO job 目标并列，挂在 `gc_mark_internal_roots`）。
- **`#2002` 与 `#2030` 严格区分**：读数前先判「socket 是否还有效」，无效走 `#2002`、有效但数据不足走
  `#2030`——这是实测里最容易搞错的一处（早期实现把两者混为一谈，测试立刻抓到）。
- **写入缓冲 + `flush()`**：`write*` 只入缓冲（`bytesPending` = 余量），`flush()` 与帧边界把字节推出去；
  `outputProgress` 在字节**真的出队**时派（对应 `OutputProgressEvent`）。
- **`SecureSocket` 不假装**（AGENTS.md §2.5）：TLS 未实现时**绝不静默明文连接**，而是 `isSupported=false`
  \+ 带实测文案的 `#2031`。真正缺的是「非阻塞传输之上的 TLS 状态机 + AIR 的
  `serverCertificateValidate` 握手」，已记入 `TODO.md` 遗留表。
- **DNS 同步**（`inet_pton` 快路径 → `getaddrinfo`）：是**性能注记**而非语义错误——AIR 也是
  `connect()` 返回后由事件交付结果，故本实现 `connect()` 同样不抛。
- **未做的**：AMF `readObject`/`writeObject`（本子集 `ByteArray` 无 AMF，与 §3.2 同批）、
  `readMultiByte` 忽略 `charSet`（与本子集 `ByteArray.readMultiByte` 口径一致，已在
  `symbols.ts` 注释标注）、`DatagramSocket`。
- **无 POSIX socket 的目标**（WASI/Web/Windows）：`ASC_SOCK_POSIX` 之外退化为
  `unsupported=1` 的诚实 `ioError`，与 §4.2 的「无网目标诚实报错」同一条口径。

### 7.4 验收

```sh
node src/index.ts examples/socket.as --run     # 环回 echo + 关闭/重连 + XMLSocket + SecureSocket
node test.ts                                   # 全量回归（本示例计入 124 项）
```

`examples/socket.as` 是**自包含**的（`ServerSocket.bind(0)` + 本地环回，不依赖外部服务器），
断言覆盖：未打开态的 `#2002`、`connect` 参数错误、环回 echo 的字节水位与 `socketData`、
`close` 后的 `#2002` 与重连、`XMLSocket` 的 NUL 分帧（payload 与终止 NUL **分别**断言——本子集
String 是 NUL 结尾的，嵌入的 NUL 无法用 `readUTFBytes` 观测，故分两次读）、`SecureSocket`
的 `isSupported=false` + `#2031`。

---

## 8. 明确不做 / 延后的边界

| 项 | 判断 |
|---|---|
| 跨域 URL policy 文件、保留端口限制 | ❌ 不做——那是 Flash Player/浏览器沙箱约束，桌面应用沙箱（AIR 应用沙箱）本就无此限制 |
| `certificateError` 可 `preventDefault()` 放行 | ⏸ 延后（无 UI 承载证书交互），失败落 `ioError` |
| `URLRequestDefaults.setLoginCredentialsForHost` | ⏸ 延后（认证场景） |
| `Socket`/`SecureSocket`/`ServerSocket`/`XMLSocket` | ✅ **已做，见 §7**（`SecureSocket` 只到 API 面 + 诚实失败：TLS 状态机未实现，`isSupported=false`） |
| `DatagramSocket`（UDP） | ⏸ 延后（与 TCP 底座不同：无连接、无 `flush` 语义、`send()` 自带目标地址） |
| `LocalConnection`/`NetConnection`/`NetStream`/`NetGroup*`/RTMP | ❌ 不做（依赖 FMS / 音视频，超出范围） |
| `FileReference`/`FileReferenceList`（文件上传/下载对话框） | ⏸ 延后（依赖原生文件对话框） |
| `registerClassAlias`/`getClassByAlias`（AMF） | ⏸ 延后（`SharedObject` 已按 AIR 语义建模，AMF 序列化按需） |
| HTTP/2、cookie jar、代理 | ✅ **已做（阶段八十九·五十三）**：HTTP/2 = `ASC_HTTP2`（默认仍 1.1）、cookie jar = 进程级 `CURLSH`、代理 = 环境变量 + 系统代理 |
| gzip、HTTP 缓存、HTTP 认证 | ⏸ 按需（gzip 依赖构建 `libz` 之外的 `zstd`/`brotli` 取舍；`setLoginCredentialsForHost` 仍延后） |

---

## 9. 工作量与结论

- **工作量**：**A/B（API 面补全）是「小版本量级」**（纯语义层，复用现有本地 job）——**实测兑现**：
  阶段八十九·四十八 一个 patch 版本内落地（`symbols.ts` +`emit.ts` +`runtime.ts` 共 3 处新增助手），
  未改动任何既有后端或构建流程。
  **G + C 的 native 探针同样是 patch 版本量级**（阶段八十九·四十九）：`runtime.ts` 新增
  `AS_JOB_HTTP` job 种类 + 网络 seam（约 145 行），`emit.ts` 改 `URLLoader_load`/`__finish` 并生成
  `HTTPStatusEvent`（约 55 行），**零改动 `build.ts`**（复用既有 `link-libs`/`defines`）。
  作为对照，**完整的 C→I 仍是「独立重工程」**：探针刻意只做了「一次读全」的竖直切片，尚未碰
  chunked 进度、响应头解析、代理/cookie、HTTP/2、`URLStream` 流式 job、web `fetch` 与静态自包含打包
  （这些各占大头）。
- **可行性**：✅ 技术上完全可行。HTTP/1.1 是标准协议，TLS 有成熟库可链接（§2.9 已允许），
  web 侧 `fetch` 是浏览器原生能力；唯一的「不完整」是 WASI 无网——但那本就是诚实降级。
- **对既有架构的影响**：**唯一实质影响**是 §4.3 的「流式 job」形态（增量进度 / 非阻塞读）。
  一次性 job 骨架可复用，不推翻阶段八十九·四十五的成果。
- **唯一要决策的**：是否值得投入 C 之后的完整部分。**A/B 已做（八十九·四十八）**，
  **G + native 探针已做（八十九·四十九）**——探针用真实代码给出三条硬约束：(1) 用系统 libcurl
  会**破坏自包含**（动态链接 `libcurl.4.dylib`）；(2) **同一份清单无法跨目标**（`link-libs` 不按目标
  条件，喂 wasm 直接链接失败）；(3) 好在**生成的 C 是同一份**（分叉只在 `-D`）。
  其中 (2) 的构建层前置**已于阶段八十九·五十 完成**——构建清单 `targets` 覆盖块落地后，
  「按目标分层链接」不再阻塞 D→I（[`compile.md`](compile.md) §4.1，实测见 §6.3）。
  于是**剩下的唯一决策就是「要不要 C→I」**，仍取决于是否有「真的要联网加载」的用例——
  若目标始终是「资源随应用打包」，`ASC_HAVE_CURL` 保持不声明即可。

---

## 10. 参考链接

- [AS3 语言参考 — `flash.net` 包](https://airsdk.dev/reference/actionscript/3.0/flash/net/package-detail.html)
- [`URLLoader`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoader.html) ·
  [`URLLoaderDataFormat`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoaderDataFormat.html) ·
  [`URLRequest`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequest.html) ·
  [`URLRequestMethod`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestMethod.html) ·
  [`URLRequestHeader`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestHeader.html) ·
  [`URLRequestDefaults`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestDefaults.html) ·
  [`URLVariables`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLVariables.html) ·
  [`URLStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLStream.html)
- [`HTTPStatusEvent`](https://airsdk.dev/reference/actionscript/3.0/flash/events/HTTPStatusEvent.html)
- **可移植性 / 同型先例**（§4.1.1 的依据）：
  - Emscripten [Networking](https://emscripten.org/docs/porting/networking.html)（*"direct access to TCP
    sockets is not possible from web browsers"*；[官方端口清单](https://github.com/emscripten-core/emscripten/tree/main/tools/ports) 中无 curl）
  - TypePHP（同型 AOT 编译器，已解同一问题）：
    [README-CN.md](https://github.com/swoole/typephp/blob/master/README-CN.md)（`link-libs: curl` /
    `ext-deps: curl` / Nano 无网络）、[WASI_BUILD.md](https://github.com/swoole/typephp/blob/master/docs/zh-cn/WASI_BUILD.md)
    （OpenSSL crypto-only、`wasi:http` Component、Facade 整体关闭）
- 项目内相关：[`as3-semantics.md`](as3-semantics.md) §3（异步 IO 执行位置与排空时机）、
  `examples/async-io.as`（现有异步 job 契约回归）、`examples/stage62.as` / `examples/stage63.as`